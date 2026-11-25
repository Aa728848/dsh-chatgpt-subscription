import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '../../../src/host/common/llm-compat.ts'
import { OpenCodeGoAdapter } from '../../../src/host/providers/opencode-go/adapter.ts'
import { OpenCodeGoAccountPool } from '../../../src/host/providers/opencode-go/account-pool.ts'
import type { OpenCodeGoCatalogManager } from '../../../src/host/providers/opencode-go/model-catalog.ts'
import { parseOpenCodeGoModelEntries, parsePersistedOpenCodeGoModelEntries, persistedOpenCodeGoModelEntries } from '../../../src/host/providers/opencode-go/model-catalog.ts'
import type { OpenCodeGoSettingsStore } from '../../../src/host/providers/opencode-go/token-store.ts'
import { buildOpenCodeGoResponsesRequest, streamOpenCodeGoResponses } from '../../../src/host/providers/opencode-go/mapper-responses.ts'
import { buildOpenCodeGoMessagesRequest, createOpenCodeGoMessagesDriver } from '../../../src/host/providers/opencode-go/mapper-messages.ts'
import { buildOpenCodeGoGeminiRequest, readOpenCodeGoGeminiResponse, streamOpenCodeGoGeminiResponse } from '../../../src/host/providers/opencode-go/mapper-gemini.ts'
import { isOpenCodeGoProtocolUnsupported } from '../../../src/host/providers/opencode-go/protocol.ts'
import { credential, memoryBackend, modelEntry, settings, sse } from './helpers.ts'

function options(model = 'gpt-6.1-sol'): GenerateOptions {
  return { provider: 'opencode-go', model, sessionId: 'session-1', system: 'Be precise', messages: [{ role: 'user', content: [{ type: 'text', text: 'call' }] }], tools: [{ name: 'probe', description: 'probe', parameters: { type: 'object', properties: {} } }], reasoningEffort: 'high', maxTokens: 123 } as never
}
function store(): OpenCodeGoSettingsStore { return { read: async () => settings() } as unknown as OpenCodeGoSettingsStore }
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> { const chunks: StreamChunk[] = []; for await (const chunk of stream) chunks.push(chunk); return chunks }
function event(value: unknown): string { return 'data: ' + JSON.stringify(value) + '\n\n' }

describe('OpenCode Go native protocols', () => {
  it('reads and persists the catalog protocol and monthly allowance limits', () => {
    const entries = parseOpenCodeGoModelEntries([{ id: 'gpt-6.1-sol', type: 'chat', api: { responses: { base_url: 'https://opencode.ai/inference/go/openai/v1/' } }, go: { monthly_usage: { go: 10, 'go-plus': 40 } } }])!
    expect(entries[0]).toMatchObject({ protocol: 'responses', apiBaseUrl: 'https://opencode.ai/inference/go/openai/v1', monthlyUsage: { go: 10, 'go-plus': 40 } })
    expect(parsePersistedOpenCodeGoModelEntries(persistedOpenCodeGoModelEntries(entries))?.[0]).toEqual(entries[0])
    const hostile = parseOpenCodeGoModelEntries([{ id: 'gpt-6.1-sol', type: 'chat', api: { responses: { base_url: 'https://evil.example/v1' } } }])!
    expect(hostile[0]).toMatchObject({ protocol: 'chat-completions', apiBaseUrl: 'https://opencode.ai/inference/go/openai/v1' })
  })

  it('maps Responses tools, reasoning, stream completion and provider replay', async () => {
    const body = buildOpenCodeGoResponsesRequest(options(), new Map(), modelEntry({ protocol: 'responses' }), settings())
    expect(body).toMatchObject({ model: 'gpt-6.1-sol', stream: true, instructions: 'Be precise', max_output_tokens: 123, reasoning: { effort: 'high' } })
    expect(body.prompt_cache_key).toBeUndefined()
    expect(body.store).toBeUndefined()
    const response = new Response([
      event({ type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'probe', arguments: '' } }),
      event({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: JSON.stringify({ x: 1 }) }),
      event({ type: 'response.completed', response: { output: [{ id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'probe', arguments: JSON.stringify({ x: 1 }) }], usage: { input_tokens: 3, output_tokens: 1, opencode: { billing_source: 'go-plus', allowance: 0.75 } } } }),
    ].join(''), { status: 200 })
    const chunks = await collect(streamOpenCodeGoResponses(response, new AbortController().signal))
    expect(chunks.find(chunk => chunk.type === 'finish')).toMatchObject({ reason: { kind: 'tool-calls' }, replayState: { response: { provider: 'opencode-go', protocol: 'responses', allowance: 0.75 } } })
    expect(chunks.some(chunk => chunk.type === 'tool-call-delta' && chunk.argumentsDelta === JSON.stringify({ x: 1 }))).toBe(true)
    const replay = buildOpenCodeGoResponsesRequest({
      ...options(),
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'visible update' }], source: { kind: 'model', replayState: { outputItems: [{ type: 'function_call', call_id: 'call_1', name: 'probe', arguments: '{}' }] } } }],
    } as never, new Map(), modelEntry({ protocol: 'responses' }), settings())
    expect(replay.input).toMatchObject([{ role: 'assistant', content: [{ type: 'output_text', text: 'visible update' }] }, { type: 'function_call', call_id: 'call_1' }])
  })

  it('maps Messages required budgets, native tool replay and OpenCode allowance', () => {
    const body = buildOpenCodeGoMessagesRequest(options('claude-sonnet-5-5'), new Map(), modelEntry({ id: 'claude-sonnet-5-5', protocol: 'messages' }), settings())
    expect(body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 1024, system: 'Be precise', thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' } })
    const driver = createOpenCodeGoMessagesDriver()
    const chunks = [
      ...driver.process('data: ' + JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'probe', input: {} } })),
      ...driver.process('data: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ x: 1 }) } })),
      ...driver.process('data: ' + JSON.stringify({ type: 'content_block_stop', index: 0 })),
      ...driver.process('data: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2, opencode: { billing_source: 'go-plus', allowance: 0.25 } } })),
      ...driver.process('data: ' + JSON.stringify({ type: 'message_stop' })),
    ]
    expect(driver.allowance()).toBe(0.25)
    expect(driver.billingSource()).toBe('go-plus')
    const finish = chunks.find(chunk => chunk.type === 'finish')
    expect(finish).toMatchObject({ reason: { kind: 'tool-calls' }, replayState: { response: { provider: 'opencode-go', protocol: 'messages', allowance: 0.25 } } })
    const continued = buildOpenCodeGoMessagesRequest({
      ...options('claude-sonnet-5-5'),
      messages: [
        { role: 'assistant', content: [], source: { kind: 'model', replayState: finish?.replayState } },
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'done' }] }] },
      ],
    } as never, new Map(), modelEntry({ id: 'claude-sonnet-5-5', protocol: 'messages' }), settings())
    expect(continued.messages).toMatchObject([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'done' }] },
    ])
  })

  it('maps Gemini declarations, function calls, cached usage and billing metadata', async () => {
    const body = buildOpenCodeGoGeminiRequest(options('gemini-4-argon'), new Map(), modelEntry({ protocol: 'generate-content' }), settings())
    expect(body).toMatchObject({ systemInstruction: { parts: [{ text: 'Be precise' }] }, generationConfig: { maxOutputTokens: 123 } })
    expect(body.generationConfig).not.toHaveProperty('thinkingConfig')
    const response = Response.json({
      candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { id: 'call_1', name: 'probe', args: { x: 1 } } }] } }],
      usageMetadata: { promptTokenCount: 10, cachedContentTokenCount: 4, candidatesTokenCount: 1, thoughtsTokenCount: 2, opencode: { billing_source: 'go', allowance: 0.5 } },
    })
    const result = await readOpenCodeGoGeminiResponse(response)
    expect(result.metadata).toEqual({ billingSource: 'go', allowance: 0.5 })
    expect(result.chunks.find(chunk => chunk.type === 'usage')).toMatchObject({ usage: { inputTokens: 6, outputTokens: 3, cacheReadTokens: 4, reasoningTokens: 2 } })
    expect(result.chunks.find(chunk => chunk.type === 'finish')).toMatchObject({ reason: { kind: 'tool-calls' }, replayState: { response: { provider: 'opencode-go', protocol: 'generate-content', allowance: 0.5 } } })
  })

  it('streams Gemini with activity pulses and rejects an empty candidate set', async () => {
    const response = new Response([
      event({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }),
      event({ candidates: [{ finishReason: 'STOP', content: { parts: [] } }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, opencode: { billing_source: 'go', allowance: 0.1 } } }),
    ].join(''), { status: 200 })
    let pulses = 0
    let allowance: number | null = null
    const chunks = await collect(streamOpenCodeGoGeminiResponse(response, new AbortController().signal, { pulse: () => { pulses += 1 } }, metadata => { allowance = metadata?.allowance ?? null }))
    expect(pulses).toBeGreaterThan(0)
    expect(allowance).toBe(0.1)
    expect(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'OK')).toBe(true)
    expect(chunks.find(chunk => chunk.type === 'finish')).toMatchObject({ replayState: { response: { provider: 'opencode-go', protocol: 'generate-content', allowance: 0.1 } } })
    await expect(readOpenCodeGoGeminiResponse(Response.json({ candidates: [] }))).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
    expect(isOpenCodeGoProtocolUnsupported(404, 'model gpt-unknown not found')).toBe(false)
    expect(isOpenCodeGoProtocolUnsupported(404, 'endpoint not found')).toBe(true)
  })

  it('falls back from an unsupported native endpoint to Chat on the same account', async () => {
    const pool = new OpenCodeGoAccountPool({ backend: memoryBackend() })
    await pool.addAccount(credential(), '主账号')
    const entry = modelEntry({ protocol: 'responses', apiBaseUrl: 'https://opencode.ai/inference/go/openai/v1' })
    const catalog = { warm: async () => [entry], snapshot: () => ({ entries: [entry] }) } as unknown as OpenCodeGoCatalogManager
    const urls: string[] = []
    const fetchFn: typeof fetch = async (url) => {
      urls.push(String(url))
      if (urls.length === 1) return Response.json({ error: { message: 'not supported' } }, { status: 404 })
      return sse([JSON.stringify({ choices: [{ delta: { content: 'OK' } }] })])
    }
    const adapter = new OpenCodeGoAdapter(store(), catalog, { accountPool: pool, fetchFn })
    const call = await adapter.prepareCall('opencode-go', entry.id)
    const chunks = await collect(call.stream(options(entry.id) as never))
    expect(urls).toEqual([entry.apiBaseUrl + '/responses', 'https://opencode.ai/inference/go/openai/v1/chat/completions'])
    expect(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'OK')).toBe(true)
    expect((await pool.read()).accounts).toHaveLength(1)
  })
})