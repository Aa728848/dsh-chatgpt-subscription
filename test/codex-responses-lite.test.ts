import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions as HarnessGenerateOptions } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '../src/host/common/llm-compat.ts'
import { OAuthService } from '../src/host/oauth-service.ts'
import { ResponsesClient, parseResponsesStream } from '../src/host/responses-client.ts'
import { buildResponsesPayload } from '../src/host/responses-mapper.ts'
import { MemoryTokenStore } from '../src/host/token-store.ts'

const attachments = { readImage: async () => { throw new Error('unused') } }
const readTool = {
  name: 'read',
  description: 'Read a file.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}
const deferredTool = {
  name: 'deferred',
  description: 'Load when needed.',
  deferLoading: true as const,
  parameters: { type: 'object', properties: {} },
}

describe('Codex Responses Lite wire contract', () => {
  it('matches the official Lite prefix, tool namespace, metadata and stable item ids', async () => {
    const options = {
      provider: 'codex-chatgpt',
      model: 'gpt-6-astra',
      system: 'Base instructions',
      reasoningEffort: 'high',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [readTool, deferredTool],
    } as unknown as GenerateOptions
    const build = (idNamespace: string) => buildResponsesPayload(
      options,
      attachments,
      {},
      null,
      false,
      null,
      'cache-key',
      { useResponsesLite: true, idNamespace },
    )

    const payload = await build('conversation-a')
    const repeated = await build('conversation-a')
    const otherConversation = await build('conversation-b')

    expect(Object.keys(payload)).toEqual([
      'model', 'stream', 'input', 'tool_choice', 'parallel_tool_calls', 'reasoning',
      'store', 'include', 'prompt_cache_key', 'text',
    ])
    expect(payload).not.toHaveProperty('instructions')
    expect(payload).not.toHaveProperty('tools')
    expect(payload.tool_choice).toBe('auto')
    expect(payload.parallel_tool_calls).toBe(false)
    expect(payload.reasoning).toEqual({ effort: 'high', context: 'all_turns' })

    const [toolItem, instructionItem, userItem] = payload.input
    expect(toolItem).toMatchObject({
      type: 'additional_tools',
      role: 'developer',
      tools: [{
        type: 'namespace',
        name: 'functions',
        description: '',
        tools: [
          { ...readTool, type: 'function', strict: false },
          { name: 'deferred', description: 'Load when needed.', parameters: { type: 'object', properties: {} }, type: 'function', strict: false, defer_loading: true },
        ],
      }],
    })
    expect(toolItem?.id).toBe(repeated.input[0]?.id)
    expect(toolItem?.id).not.toBe(otherConversation.input[0]?.id)
    expect(String(toolItem?.id)).toMatch(/^at_[0-9a-f-]{36}$/)
    expect(instructionItem).toMatchObject({
      type: 'message',
      id: expect.any(String),
      role: 'developer',
      content: [{ type: 'input_text', text: expect.stringContaining('Base instructions') }],
      internal_chat_message_metadata_passthrough: {
        content_item_kinds: ['model.base_instructions'],
        content_item_metadata: [{ provenance: { type: 'harness', hook: false } }],
      },
    })
    expect(instructionItem?.id).toBe(repeated.input[1]?.id)
    expect(instructionItem?.id).not.toBe(otherConversation.input[1]?.id)
    expect(userItem).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'hello' }] })
  })

  it('keeps the standard tool path while moving base instructions into input', async () => {
    const payload = await buildResponsesPayload({
      provider: 'codex-chatgpt',
      model: 'gpt-5.5',
      system: 'Standard instructions',
      reasoningEffort: 'high',
      messages: [],
      tools: [readTool],
    } as unknown as GenerateOptions, attachments, {}, null, false, null, undefined, {
      useResponsesLite: false,
      idNamespace: 'conversation-a',
    })

    expect(payload).not.toHaveProperty('instructions')
    expect(payload.tools).toEqual([{ ...readTool, type: 'function', strict: false }])
    expect(payload.tool_choice).toBe('auto')
    expect(payload.parallel_tool_calls).toBe(true)
    expect(payload.reasoning).toEqual({ effort: 'high' })
    expect(payload.input[0]).toMatchObject({
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: expect.stringContaining('Standard instructions') }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] },
    })
    expect(payload.input[0]?.internal_chat_message_metadata_passthrough).not.toHaveProperty('content_item_metadata')
  })

  it('states Lite controls without inventing empty tools or instruction items', async () => {
    const lite = await buildResponsesPayload({
      provider: 'codex-chatgpt', model: 'gpt-6-astra', messages: [],
    } as unknown as GenerateOptions, attachments)
    expect(lite.input).toEqual([])
    expect(lite.tool_choice).toBe('auto')
    expect(lite.parallel_tool_calls).toBe(false)
    expect(lite.reasoning).toEqual({ context: 'all_turns' })

    const unknown = await buildResponsesPayload({
      provider: 'codex-chatgpt', model: 'gpt-99-unheard-of', messages: [],
    } as unknown as GenerateOptions, attachments)
    expect(unknown.tool_choice).toBe('auto')
    expect(unknown.parallel_tool_calls).toBe(true)
    expect(unknown.reasoning).toBeUndefined()
  })

  it('pairs headers with the body and recomputes Lite after a 404 fallback', async () => {
    const store = new MemoryTokenStore()
    await store.save({ accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000 })
    const oauth = new OAuthService(store)
    const calls: Array<{ body: Record<string, unknown>; headers: Headers }> = []
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      calls.push({ body, headers: new Headers(init?.headers) })
      if (body.model === 'gpt-5.6-terra') return new Response('model not found', { status: 404 })
      return sse([{ type: 'response.completed', response: {} }])
    })
    const client = new ResponsesClient(oauth, attachments, { fetchFn: fetchFn as unknown as typeof fetch })

    try {
      await collect(client.stream({
        provider: 'codex-chatgpt',
        model: 'gpt-5.6-terra',
        reasoningEffort: 'high',
        sessionId: 'conversation-fallback',
        messages: [],
      } as unknown as HarnessGenerateOptions))
    } finally {
      oauth.dispose()
    }

    expect(calls).toHaveLength(2)
    expect(calls[0]!.body.model).toBe('gpt-5.6-terra')
    expect(calls[0]!.body.parallel_tool_calls).toBe(false)
    expect(calls[0]!.body.reasoning).toEqual({ effort: 'high', context: 'all_turns' })
    expect(calls[0]!.headers.get('x-openai-internal-codex-responses-lite')).toBe('true')
    expect(calls[0]!.headers.get('x-codex-routing-hint')).toBe('model=gpt-5.6-terra')
    expect(calls[0]!.headers.get('originator')).toBe('codex_cli_rs')
    expect(calls[0]!.headers.get('user-agent')?.startsWith('codex_cli_rs/0.166.0 ')).toBe(true)

    expect(calls[1]!.body.model).toBe('gpt-5.5')
    expect(calls[1]!.body.parallel_tool_calls).toBe(true)
    expect(calls[1]!.body.reasoning).toEqual({ effort: 'high' })
    expect(calls[1]!.headers.get('x-openai-internal-codex-responses-lite')).toBeNull()
    expect(calls[1]!.headers.get('x-codex-routing-hint')).toBe('model=gpt-5.5')
  })

  it('keeps a Lite function namespace beside the plain DSH tool name and replay state', async () => {
    const item = {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      namespace: 'functions',
      name: 'read',
      arguments: '{"path":"a.ts"}',
    }
    const chunks = await collect(parseResponsesStream(sse([
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: {} },
    ])))

    expect(chunks).toContainEqual({
      type: 'block-end', index: 0,
      block: { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a.ts"}' },
    })
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      replayState: { response: { outputItems: [item] } },
    })
  })
})

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function sse(events: unknown[]): Response {
  const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}
