import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadWorkspaceMedia, readWorkspaceMedia } from '../../../src/host/providers/minimax-code/media-files.ts'
import { createMinimaxMediaTools } from '../../../src/host/providers/minimax-code/media-tool.ts'

vi.mock('../../../src/host/infra/network/fetch-address-policy.ts', () => ({
  lookupHostAddresses: vi.fn(async () => ['93.184.216.34']),
  assertPublicFetchTarget: vi.fn(),
}))

const pool = {
  getFreshCredential: vi.fn(async () => ({ accessToken: 'test-token', region: 'cn' as const })),
}
const roots: string[] = []
let root = ''
let exec: { agent: unknown; signal: AbortSignal }

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-minimax-media-'))
  roots.push(root)
  exec = {
    agent: { options: { provider: 'minimax-code' }, session: { header: { cwd: root } } },
    signal: new AbortController().signal,
  }
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  for (const current of roots.splice(0)) {
    for (const name of ['ref.png', 'input.mp3', 'image.png', 'speech.mp3', 'music.mp3', 'report.md', 'search/0.jpg']) {
      await fs.unlink(path.join(current, name)).catch(() => undefined)
    }
    await fs.rmdir(path.join(current, 'search')).catch(() => undefined)
    await fs.rmdir(current).catch(() => undefined)
  }
})

function context() {
  return { get: () => undefined } as never
}
function toolsWith(fetchFn: typeof fetch) {
  return new Map(createMinimaxMediaTools(context(), { pool, fetchFn }).map(tool => [tool.name, tool]))
}
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}
function success(body: Record<string, unknown>): Response {
  return jsonResponse({ base_resp: { status_code: 0 }, ...body })
}
function uploadResponse(): Response {
  return success({ put_url: 'https://upload.example.com/object', cdn_url: 'https://cdn.example.com/object' })
}

describe('MiniMax image and audio media tools', () => {
  it('registers the complete non-duplicated media surface', () => {
    const names = [...toolsWith(vi.fn() as unknown as typeof fetch).keys()]
    expect(names).toEqual([
      'minimax_generate_image', 'minimax_search_images', 'minimax_reverse_image_search', 'minimax_list_voices',
      'minimax_generate_speech', 'minimax_generate_music', 'minimax_understand_audio', 'minimax_transcribe_audio',
    ])
  })

  it('maps H3 Image requests, uploads references and saves the returned PNG', async () => {
    await fs.writeFile(path.join(root, 'ref.png'), new Uint8Array([1, 2, 3]))
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith('/get_upload_url')) return uploadResponse()
      if (init?.method === 'PUT') return new Response(null, { status: 200 })
      if (url.endsWith('/image_synthesize')) return success({ success_items: [{
        output_file: 'slot_0.png', output_url: 'https://cdn.example.com/generated.png', has_image_output: true,
      }] })
      if (url === 'https://cdn.example.com/generated.png') return new Response(new Uint8Array([9, 8, 7]), { status: 200 })
      throw new Error('unexpected URL ' + url)
    }) as typeof fetch
    const tool = toolsWith(fetchFn).get('minimax_generate_image')!
    const result = await tool.execute({ requests: [{
      prompt: 'A red bird', outputPath: 'image.png', referenceImagePaths: ['ref.png'], aspectRatio: '16:9', resolution: '2K',
    }] }, exec as never)
    expect(result).toMatchObject({ totalSucceeded: 1, totalFailed: 0 })
    expect(new Uint8Array(await fs.readFile(path.join(root, 'image.png')))).toEqual(new Uint8Array([9, 8, 7]))
    const generation = calls.find(call => call.url.endsWith('/image_synthesize'))!
    const body = JSON.parse(String(generation.init?.body))
    expect(body.requests[0]).toEqual({
      prompt: 'A red bird', output_file: 'slot_0.png', input_urls: ['https://cdn.example.com/object'], aspect_ratio: '16:9', resolution: '2K',
    })
    expect(calls.filter(call => call.url.endsWith('/image_synthesize'))).toHaveLength(1)
  })

  it('returns per-item speech failures without repeating the billed request', async () => {
    let generationCalls = 0
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/batch_synthesize_speech')) {
        generationCalls += 1
        return success({
          success_items: [{ output_file: 'slot_0.mp3', output_url: 'https://cdn.example.com/speech.mp3' }],
          failed_items: [{ output_file: 'slot_1.mp3', error_msg: 'bad voice' }],
        })
      }
      if (url === 'https://cdn.example.com/speech.mp3') return new Response(new Uint8Array([4, 5]), { status: 200 })
      throw new Error('unexpected URL ' + url)
    })
    const fetchFn = fetchMock as typeof fetch
    const tool = toolsWith(fetchFn).get('minimax_generate_speech')!
    const result = await tool.execute({ requests: [
      { text: 'hello', outputPath: 'speech.mp3', voiceId: 'voice-1', speed: 1.2 },
      { text: 'failed', outputPath: 'failed.mp3' },
    ] }, exec as never)
    expect(result).toMatchObject({ totalSucceeded: 1, totalFailed: 1, failures: [{ index: 1, error: 'bad voice' }] })
    expect(generationCalls).toBe(1)
    const generation = fetchMock.mock.calls.find(call => String(call[0]).endsWith('/batch_synthesize_speech'))!
    expect(JSON.parse(String(generation[1]?.body)).requests[0]).toMatchObject({
      text: 'hello', output_file: 'slot_0.mp3', voice_id: 'voice-1', speed: 1.2,
    })
    await fs.unlink(path.join(root, 'failed.mp3')).catch(() => undefined)
  })

  it('uploads audio for understanding and uses listen_audio for transcription', async () => {
    await fs.writeFile(path.join(root, 'input.mp3'), new Uint8Array([1, 2]))
    const urls: string[] = []
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      urls.push(url)
      if (url.endsWith('/get_upload_url')) return uploadResponse()
      if (url.endsWith('/audios_understand')) return success({ results: [{ success: true, description: 'spoken words' }] })
      if (url.endsWith('/listen_audio')) return success({ text: 'hello world' })
      if (url === 'https://upload.example.com/object') return new Response(null, { status: 200 })
      throw new Error('unexpected URL ' + url)
    }) as typeof fetch
    const tools = toolsWith(fetchFn)
    const understood = await tools.get('minimax_understand_audio')!.execute({ requests: [{ inputPath: 'input.mp3' }] }, exec as never)
    expect(understood).toMatchObject({ results: [{ success: true, analysis: 'spoken words' }] })
    const transcribed = await tools.get('minimax_transcribe_audio')!.execute({ inputPath: 'input.mp3' }, exec as never)
    expect(transcribed).toMatchObject({ transcript: 'hello world' })
    expect(urls.some(url => url.endsWith('/audios_understand'))).toBe(true)
    expect(urls.some(url => url.endsWith('/listen_audio'))).toBe(true)
    expect(urls.some(url => url.endsWith('/transcribe_audio'))).toBe(false)
  })

  it('maps music options and downloads the generated track', async () => {
    let wireBody: { requests: Record<string, unknown>[] } | undefined
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/batch_text_to_music')) {
        wireBody = JSON.parse(String(init?.body))
        return success({ success_items: [{ output_file: 'slot_0.mp3', output_url: 'https://cdn.example.com/music.mp3' }] })
      }
      if (url === 'https://cdn.example.com/music.mp3') return new Response(new Uint8Array([3, 4]), { status: 200 })
      throw new Error('unexpected URL ' + url)
    }) as typeof fetch
    const result = await toolsWith(fetchFn).get('minimax_generate_music')!.execute({ requests: [{
      prompt: 'A calm piano theme', outputPath: 'music.mp3', lyrics: 'soft lights tonight', sampleRate: 44100, bitrate: 128000,
    }] }, exec as never)
    expect(result).toMatchObject({ totalSucceeded: 1, totalFailed: 0 })
    expect(wireBody?.requests[0]).toEqual({
      prompt: 'A calm piano theme', output_file: 'slot_0.mp3', format: 'mp3', lyrics: 'soft lights tonight', sample_rate: 44100, bitrate: 128000,
    })
  })
  it('normalizes voice presets', async () => {
    const fetchFn = vi.fn(async () => success({ data: [{ voice_id: 'v1', voice_name: 'Clear voice' }] })) as typeof fetch
    const result = await toolsWith(fetchFn).get('minimax_list_voices')!.execute({}, exec as never)
    expect(result).toEqual({ voices: [{ voiceId: 'v1', voiceName: 'Clear voice' }] })
  })

  it('downloads image search results and writes reverse-search reports', async () => {
    await fs.writeFile(path.join(root, 'ref.png'), new Uint8Array([1]))
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/get_upload_url')) return uploadResponse()
      if (url === 'https://upload.example.com/object') return new Response(null, { status: 200 })
      if (url.endsWith('/images_search_and_download')) return success({ results: [{ images: [{ image_url: 'https://cdn.example.com/found.jpg' }] }] })
      if (url.endsWith('/image_reverse_search')) return success({ data: [{ title: 'Match', link: 'https://example.com/match' }] })
      if (url === 'https://cdn.example.com/found.jpg') return new Response(new Uint8Array([6]), { status: 200 })
      throw new Error('unexpected URL ' + url)
    }) as typeof fetch
    const tools = toolsWith(fetchFn)
    const searched = await tools.get('minimax_search_images')!.execute({ queries: [{ query: 'bird', outputDir: 'search' }] }, exec as never)
    expect(searched).toMatchObject({ queries: [{ files: [{ bytes: 1 }] }] })
    const reversed = await tools.get('minimax_reverse_image_search')!.execute({ inputPath: 'ref.png', outputPath: 'report.md' }, exec as never)
    expect(reversed).toMatchObject({ resultCount: 1 })
    expect(await fs.readFile(path.join(root, 'report.md'), 'utf8')).toContain('Match')
  })

  it('cancels an oversized download while it is being read', async () => {
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as typeof fetch
    await expect(downloadWorkspaceMedia(root, 'image.png', 'https://cdn.example.com/large.png', fetchFn, undefined, 2))
      .rejects.toMatchObject({ code: 'MINIMAX_MEDIA_OUTPUT_TOO_LARGE' })
    expect(await fs.stat(path.join(root, 'image.png')).catch(() => undefined)).toBeUndefined()
  })

  it('rejects workspace escapes before reading or sending a file', async () => {
    await expect(readWorkspaceMedia(root, '../outside.mp3', 'audio')).rejects.toMatchObject({ code: 'MINIMAX_MEDIA_PATH_ESCAPE' })
  })
})