import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

import { CommandCodeAdapter } from '../src/host/command-code/adapter.ts'
import type { AttachmentImageReader } from '../src/host/command-code/mapper.ts'
import { FileCredentialStore, FileModelSettingsStore } from '../src/host/command-code/token-store.ts'
import { clearCachedCatalog } from '../src/host/command-code/client.ts'
import { PROVIDER_URL } from './support/command-code-fixtures.ts'

/**
 * End-to-end cover for the tool-result image path: the bytes that actually
 * leave the process are read back off the stubbed transport, so attachment
 * resolution, the mapper, and JSON serialization are all proven together
 * rather than one layer at a time.
 *
 * Before the fix this body carried only "[image: screenshot.png]": the
 * screenshot never left the machine.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_BASE64 = Buffer.from(PNG).toString('base64')
const ATTACHMENT = {
  attachmentId: 'sha256:wire-tool-result',
  mediaType: 'image/png',
  bytes: PNG.length,
  width: 1,
  height: 1,
  name: 'screenshot.png',
} as unknown as ImageAttachmentRef

const CATALOG = [
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 1_000_000 },
  { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000 },
]

function sseResponse(frames: unknown[]): Response {
  const bytes = new TextEncoder().encode(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''))
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  }))
}

/** The message history a screenshot tool leaves behind. */
const MESSAGES = [
  {
    role: 'assistant',
    source: { kind: 'model', provider: 'command-code', model: 'm' },
    content: [{ type: 'tool-call', id: 'call_1', name: 'get_window_state', arguments: '{}' }],
  },
  {
    role: 'user',
    source: { kind: 'tool', callId: 'call_1' },
    content: [{
      type: 'tool-result',
      toolCallId: 'call_1',
      content: [{ type: 'text', text: 'screenshot taken' }, { type: 'image', attachment: ATTACHMENT }],
    }],
  },
]

function buildAdapter(attachments: AttachmentImageReader) {
  const store = new FileCredentialStore('/tmp/cc-wire-tool-result-cred.json')
  const modelSettings = new FileModelSettingsStore('/tmp/cc-wire-tool-result-models.json')
  vi.spyOn(store, 'read').mockResolvedValue({ apiKey: 'cmd_key', apiEnv: 'prod' })
  vi.spyOn(modelSettings, 'read').mockResolvedValue({
    enabledModelIds: CATALOG.map((model) => model.id),
    catalogModels: [],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
  })
  return new CommandCodeAdapter(store, modelSettings, undefined, {
    attachments,
    loadCatalog: async () => CATALOG,
  })
}

/** Run one stream against a stub transport and return the body it posted. */
async function captureBody(
  adapter: CommandCodeAdapter,
  model: string,
  frames: unknown[],
): Promise<Record<string, unknown>> {
  const captured: Array<{ url: string; init: RequestInit }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} })
    return sseResponse(frames)
  }) as typeof fetch
  try {
    for await (const _chunk of adapter.stream({
      provider: 'command-code',
      model,
      maxTokens: 2048,
      messages: MESSAGES,
    } as unknown as GenerateOptions)) { /* drain */ }
  } finally {
    globalThis.fetch = originalFetch
  }
  expect(captured).toHaveLength(1)
  return JSON.parse(String(captured[0]!.init.body)) as Record<string, unknown>
}

afterEach(() => {
  clearCachedCatalog()
  vi.restoreAllMocks()
})

describe('Command Code tool-result image wire format', () => {
  it('puts the screenshot on the Anthropic wire as a native tool_result image block', async () => {
    const readImage = vi.fn(async () => ({ ref: ATTACHMENT as never, data: PNG }))
    const adapter = buildAdapter({ readImage } as unknown as AttachmentImageReader)

    const body = await captureBody(adapter, 'claude-sonnet-4-6', [
      { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I can see it' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
      { type: 'message_stop' },
    ])

    const toolResult = (body.messages as Array<Record<string, unknown>>)
      .flatMap((message) => Array.isArray(message.content) ? message.content as Array<Record<string, unknown>> : [])
      .find((block) => block.type === 'tool_result')!

    expect(toolResult.tool_use_id).toBe('call_1')
    expect(toolResult.content).toEqual([
      { type: 'text', text: 'screenshot taken' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 } },
    ])
    expect(readImage).toHaveBeenCalledTimes(1)
  })

  it('adds a user message carrying the screenshot to the OpenAI wire', async () => {
    const readImage = vi.fn(async () => ({ ref: ATTACHMENT as never, data: PNG }))
    const adapter = buildAdapter({ readImage } as unknown as AttachmentImageReader)

    const body = await captureBody(adapter, 'deepseek/deepseek-v4.1-flash', [
      { choices: [{ delta: { content: 'seen' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
      '[DONE]',
    ])

    expect(body.messages).toEqual([
      { role: 'assistant', content: '', tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'get_window_state', arguments: '{}' } },
      ] },
      { role: 'tool', tool_call_id: 'call_1', content: 'screenshot taken[image: screenshot.png]' },
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
      ] },
    ])
    expect(readImage).toHaveBeenCalledTimes(1)
  })

  it('reads no attachment and adds no user message when the tool result has no image', async () => {
    const readImage = vi.fn(async () => ({ ref: ATTACHMENT as never, data: PNG }))
    const adapter = buildAdapter({ readImage } as unknown as AttachmentImageReader)

    const captured: Array<RequestInit> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      captured.push(init ?? {})
      return sseResponse([
        { choices: [{ delta: { content: 'ok' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        '[DONE]',
      ])
    }) as typeof fetch

    try {
      for await (const _chunk of adapter.stream({
        provider: 'command-code',
        model: 'deepseek/deepseek-v4.1-flash',
        maxTokens: 2048,
        messages: [{
          role: 'user',
          source: { kind: 'tool', callId: 'call_1' },
          content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'exit code 0' }] }],
        }],
      } as unknown as GenerateOptions)) { /* drain */ }
    } finally {
      globalThis.fetch = originalFetch
    }

    const body = JSON.parse(String(captured[0]!.body)) as Record<string, unknown>
    expect(body.messages).toEqual([{ role: 'tool', tool_call_id: 'call_1', content: 'exit code 0' }])
    expect(readImage).not.toHaveBeenCalled()
  })

  it('posts to the provider endpoint, not a loopback stand-in', async () => {
    const adapter = buildAdapter({ readImage: async () => ({ ref: ATTACHMENT as never, data: PNG }) } as unknown as AttachmentImageReader)
    const urls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown) => {
      urls.push(String(url))
      return sseResponse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]'])
    }) as typeof fetch
    try {
      for await (const _chunk of adapter.stream({
        provider: 'command-code',
        model: 'deepseek/deepseek-v4.1-flash',
        messages: MESSAGES,
      } as unknown as GenerateOptions)) { /* drain */ }
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(urls[0]).toBe(`${PROVIDER_URL}/chat/completions`)
  })
})
