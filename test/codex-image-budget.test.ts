/**
 * The Codex line's request-image budget and the transport failure it explains.
 *
 * Issue #50 reported two separate defects in one symptom — a long image-heavy
 * session failing intermittently with nothing but "Codex could not be reached.":
 *
 * 1. The request path reported a transport failure without its cause, so a body
 *    the transport refused looked identical to a dead network.
 * 2. The line had NO request-level image bound at all, so the body grew with the
 *    number of images ever read and eventually exceeded what the transport
 *    accepts.
 *
 * These tests pin both, and the budget ones are load-bearing: reverting the
 * offload makes them fail with the over-budget request still intact.
 */
import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions as MapperGenerateOptions } from '../src/host/common/llm-compat.ts'
import { OAuthService } from '../src/host/oauth-service.ts'
import { MemoryTokenStore } from '../src/host/token-store.ts'
import {
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  buildResponsesPayload,
  maxRequestImageBytes,
  offloadOldestInputImages,
} from '../src/host/responses-mapper.ts'
import { ResponsesClient } from '../src/host/responses-client.ts'

/** One inlined image item of exactly `bytes` characters, as the wire carries it. */
function imageItem(bytes: number): Record<string, unknown> {
  return { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,' + 'A'.repeat(bytes) }] }
}

/** Total base64 image payload across a built input. */
function imageBytes(input: Array<Record<string, unknown>>): number {
  let total = 0
  for (const item of input) {
    if (!Array.isArray(item.content)) continue
    for (const block of item.content) {
      const record = block as Record<string, unknown>
      if (record.type === 'input_image' && typeof record.image_url === 'string') total += record.image_url.length
    }
  }
  return total
}

/** How many of a built input's images were replaced by the placeholder. */
function omittedImages(input: Array<Record<string, unknown>>): number {
  let omitted = 0
  for (const item of input) {
    if (!Array.isArray(item.content)) continue
    for (const block of item.content) {
      const record = block as Record<string, unknown>
      if (record.type === 'input_text' && String(record.text).startsWith('[image omitted')) omitted += 1
    }
  }
  return omitted
}

describe('offloadOldestInputImages', () => {
  it('leaves a request that fits untouched', () => {
    const input = [imageItem(100), imageItem(100)]
    expect(offloadOldestInputImages(input, 1000)).toBe(0)
    expect(omittedImages(input)).toBe(0)
  })

  it('replaces oldest-first until the request fits its budget', () => {
    // Three 400-byte images against a 1000-byte budget: dropping the oldest one
    // alone leaves 800, which fits — so exactly one goes.
    const input = [imageItem(400), imageItem(400), imageItem(400)]
    expect(offloadOldestInputImages(input, 1000)).toBe(1)

    const kept = input.flatMap((item) => item.content as Array<Record<string, unknown>>)
      .filter((block) => block.type === 'input_image')
    expect(kept).toHaveLength(2)
    // The two NEWEST survive: the placeholder lands on the first occurrence.
    const first = (input[0]!.content as Array<Record<string, unknown>>)[0]!
    expect(first.type).toBe('input_text')
    expect(String(first.text)).toContain('[image omitted')
  })

  it('keeps dropping while the total is still over budget', () => {
    const input = [imageItem(600), imageItem(600), imageItem(600)]
    expect(offloadOldestInputImages(input, 700)).toBe(2)
    expect(imageBytes(input)).toBeLessThanOrEqual(700)
    expect(omittedImages(input)).toBe(2)
  })

  it('bounds every image form, including ones the message-level pass cannot see', () => {
    // The reporter's tool-read images become top-level input_image items while
    // the payload is built, so the message-level shared offload never sees them.
    // This asserts the budget applies to the BUILT input for that reason.
    const input = [
      { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,' + 'B'.repeat(300) }] },
      { role: 'user', content: [{ type: 'input_text', text: '![图片](/describe-image/raw/sha256:abc)' }] },
      { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,' + 'C'.repeat(300) }] },
    ]
    expect(offloadOldestInputImages(input, 500)).toBe(1)
    expect(imageBytes(input)).toBeLessThanOrEqual(500)
  })
})

describe('maxRequestImageBytes', () => {
  it('defaults to this route own budget, not another line\'s', () => {
    expect(maxRequestImageBytes({} as NodeJS.ProcessEnv)).toBe(DEFAULT_MAX_REQUEST_IMAGE_BYTES)
    // Kimi's 1.5 MB and MiniMax's 16 MB are sized for their own gateways.
    expect(DEFAULT_MAX_REQUEST_IMAGE_BYTES).not.toBe(1_500_000)
    expect(DEFAULT_MAX_REQUEST_IMAGE_BYTES).not.toBe(16 * 1024 * 1024)
  })

  it('honours the deployment override and ignores a value that would disable the guard', () => {
    expect(maxRequestImageBytes({ DSH_CODEX_MAX_IMAGE_BYTES: '2000000' } as NodeJS.ProcessEnv)).toBe(2_000_000)
    for (const raw of ['', 'abc', '0', '-1', 'NaN']) {
      expect(maxRequestImageBytes({ DSH_CODEX_MAX_IMAGE_BYTES: raw } as NodeJS.ProcessEnv))
        .toBe(DEFAULT_MAX_REQUEST_IMAGE_BYTES)
    }
  })
})

describe('Codex request image budget is enforced on the built payload', () => {
  it('bounds an image-heavy conversation instead of sending it unbounded', async () => {
    // 40 pasted images, each about 200 KB of base64: ~8 MB of images against a
    // 2 MB budget. Before the fix the whole 8 MB went out and the transport
    // refused it.
    const perImage = 200_000
    const messages = Array.from({ length: 40 }, (_, index) => ({
      id: 'm' + index,
      role: 'user' as const,
      source: { kind: 'user' },
      content: [{
        type: 'image' as const,
        attachment: { attachmentId: 'img' + index, mediaType: 'image/png', bytes: perImage, width: 1, height: 1 },
      }],
    }))
    const options = { provider: 'codex-chatgpt', model: 'gpt-6-sol', messages } as unknown as MapperGenerateOptions
    const attachments = {
      readImage: async (ref: { attachmentId: string }) => ({
        ref,
        data: new Uint8Array(perImage),
      }),
    }

    const payload = await buildResponsesPayload(options, attachments as never)
    expect(imageBytes(payload.input)).toBeLessThanOrEqual(DEFAULT_MAX_REQUEST_IMAGE_BYTES)
    // Bounded by dropping the oldest, not by emptying the request.
    expect(omittedImages(payload.input)).toBeGreaterThan(0)
    expect(payload.input.some((item) => Array.isArray(item.content)
      && item.content.some((block) => (block as { type?: string }).type === 'input_image'))).toBe(true)
  })

  it('leaves a small image request byte-for-byte as before', async () => {
    const options = {
      provider: 'codex-chatgpt', model: 'gpt-6-sol', messages: [{
        id: 'm1', role: 'user', source: { kind: 'user' },
        content: [{ type: 'image', attachment: { attachmentId: 'img1', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } }],
      }],
    } as unknown as MapperGenerateOptions
    const payload = await buildResponsesPayload(options, {
      readImage: async (ref: { attachmentId: string }) => ({ ref, data: new Uint8Array([1, 2, 3]) }),
    } as never)

    expect(payload.input).toContainEqual({
      role: 'user',
      content: [{ type: 'input_image', image_url: 'data:image/png;base64,AQID' }],
    })
  })
})

describe('Codex request-path transport failures keep their cause', () => {
  async function failingClient(cause: unknown): Promise<ResponsesClient> {
    const store = new MemoryTokenStore()
    await store.save({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: Date.now() + 3_600_000,
    })
    const fetchFn = vi.fn(async () => { throw cause })
    return new ResponsesClient(
      new OAuthService(store),
      { readImage: async () => { throw new Error('unused') } },
      { fetchFn: fetchFn as unknown as typeof fetch },
    )
  }

  it('names the transport error instead of only saying the service was unreachable', async () => {
    // The exact shape from the issue: an HTTP/2 stream error whose message is
    // the only thing that distinguishes it from a dead network. DSH persists
    // only {message, code}, so the message is where the cause has to live.
    const cause = Object.assign(
      new Error('NGHTTP2_ENHANCE_YOUR_CALM'),
      { code: 'ERR_HTTP2_STREAM_ERROR' },
    )
    const client = await failingClient(cause)

    const failure = await collectFailure(async () => {
      for await (const _chunk of client.stream({
        provider: 'codex-chatgpt', model: 'gpt-6-sol', messages: [{ role: 'user', content: 'hi' }],
      } as unknown as GenerateOptions)) { /* drain */ }
    })

    expect(failure.code).toBe('NETWORK')
    expect(failure.message).toContain('NGHTTP2_ENHANCE_YOUR_CALM')
    expect(failure.message).not.toBe('Codex could not be reached.')
  })

  it('still reports a cancellation as an abort rather than a transport fault', async () => {
    const controller = new AbortController()
    controller.abort()
    const client = await failingClient(new Error('ECONNRESET'))

    const failure = await collectRawFailure(async () => {
      for await (const _chunk of client.stream({
        provider: 'codex-chatgpt', model: 'gpt-6-sol', messages: [{ role: 'user', content: 'hi' }],
        signal: controller.signal,
      } as unknown as GenerateOptions)) { /* drain */ }
    })

    // A caller abort is a cancellation, not a transport fault: the signal's own
    // reason is rethrown untouched rather than being wrapped as NETWORK.
    expect((failure as { name?: string }).name).toBe('AbortError')
  })
})

async function collectRawFailure(run: () => Promise<void>): Promise<unknown> {
  try {
    await run()
  } catch (error) {
    return error
  }
  throw new Error('the request was expected to fail')
}

async function collectFailure(run: () => Promise<void>): Promise<{ code: string; message: string }> {
  try {
    await run()
  } catch (error) {
    return error as { code: string; message: string }
  }
  throw new Error('the request was expected to fail')
}
