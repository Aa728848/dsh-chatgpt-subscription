import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { GenerateOptions, Message, StreamChunk } from '../src/host/common/llm-compat.ts'
import { NO_RESOLVED_IMAGES } from '../src/host/common/request-images.ts'
import {
  catalogSnapshotPath,
  flushCatalogSnapshots,
  readCatalogSnapshot,
  writeCatalogSnapshot,
} from '../src/host/common/catalog-snapshot.ts'
import {
  fallbackRelayOneProtocol,
  isRelayOneProtocolUnsupported,
  mergeRelayOneCatalog,
  parsePersistedRelayOneModelEntries,
  persistedRelayOneModelRecord,
  relayOneModelOptions,
  selectRelayOneProtocol,
} from '../src/host/relayone/model-catalog.ts'
import { defaultRelayOneSettings } from '../src/host/relayone/token-store.ts'
import {
  buildRelayOneChatRequest,
  buildRelayOneResponsesRequest,
  closeRelayOneChatStream,
  createRelayOneChatStreamState,
  feedRelayOneChatPayload,
  processRelayOneChatLine,
} from '../src/host/relayone/mapper-openai.ts'
import {
  buildRelayOneAnthropicRequest,
  createRelayOneAnthropicStreamState,
  processRelayOneAnthropicLine,
} from '../src/host/relayone/mapper-anthropic.ts'
import { RELAYONE_PROVIDER_ID } from '../src/shared/relayone-contracts.ts'

const listing = {
  object: 'list',
  data: [
    { id: 'gpt-6-astra', owned_by: 'openai', supported_endpoint_types: ['openai'] },
    { id: 'claude-opus-5-5', owned_by: 'anthropic', supported_endpoint_types: ['openai', 'anthropic'] },
    { id: 'deepseek-v4.1-flash-1017', owned_by: 'openai', supported_endpoint_types: ['openai'] },
    { id: 'seedream-5.0', supported_endpoint_types: ['openai', 'image-generation'] },
    { id: 'seedance-2.0-mini', supported_endpoint_types: ['openai'] },
  ],
}
const pricing = {
  data: [
    { model_name: 'gpt-6-astra', vendor_id: -1012, enable_groups: ['【openai】Pro'], supported_endpoint_types: ['openai'] },
    { model_name: 'claude-opus-5-5', vendor_id: -1002, enable_groups: ['【claude】max'], supported_endpoint_types: ['openai', 'anthropic'] },
    { model_name: 'deepseek-v4.1-flash-1017', vendor_id: -1005, enable_groups: ['【国模】特价'], supported_endpoint_types: ['openai'] },
    { model_name: 'seedream-5.0', vendor_id: -1012, enable_groups: ['【图片】'], supported_endpoint_types: ['openai', 'image-generation'] },
    { model_name: 'seedance-2.0-mini', enable_groups: ['【视频分组】'], tags: 'model-type:video', supported_endpoint_types: ['openai'], billing_usage_schema: { seconds: { type: 'number' } } },
    { model_name: 'public-only', vendor_id: -1012, enable_groups: ['not-your-key'], supported_endpoint_types: ['openai'] },
  ],
  vendors: [{ id: -1012, name: 'OpenAI' }, { id: -1002, name: 'Anthropic' }, { id: -1005, name: 'DeepSeek' }],
}
const catalog = () => mergeRelayOneCatalog(listing, pricing)
const entry = (id: string) => {
  const found = catalog().find(model => model.id === id)
  if (found === undefined) throw new Error('missing test model ' + id)
  return found
}
function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: RELAYONE_PROVIDER_ID,
    model: 'gpt-6-astra',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] } as Message],
    ...overrides,
  } as GenerateOptions
}
const effort = (value: string) => value as NonNullable<GenerateOptions['reasoningEffort']>
const finishOf = (chunks: StreamChunk[]) => chunks.find(chunk => chunk.type === 'finish')
const GPT_PROGRESS_RULE = 'Progress and tool execution rule: when executing multi-step tasks or invoking tools, output 1-2 concise sentences of progress, intent, or intermediate findings before each tool call. Keep progress text brief, professional, and factual. Only present the comprehensive final answer and summary in the final turn after all tool operations are completed.'

afterEach(() => { vi.unstubAllEnvs() })

describe('RelayOne live catalog and protocol policy', () => {
  it('uses only key-visible ids and merges group/vendor/endpoint facts', () => {
    const models = catalog()
    expect(models.map(model => model.id)).not.toContain('public-only')
    expect(entry('gpt-6-astra')).toMatchObject({ protocol: 'openai-responses', vendor: 'OpenAI', groups: ['【openai】Pro'] })
    expect(entry('claude-opus-5-5').protocol).toBe('anthropic')
    expect(entry('deepseek-v4.1-flash-1017')).toMatchObject({ protocol: 'openai-chat', vendor: 'DeepSeek' })
  })
  it('classifies generation-only media away from the chat picker', () => {
    expect(entry('seedream-5.0')).toMatchObject({ kind: 'image', protocol: null })
    expect(entry('seedance-2.0-mini')).toMatchObject({ kind: 'video', protocol: null, parameterSchema: { seconds: { type: 'number' } } })
  })
  it('honours an explicit Responses endpoint and never invents one for other vendors', () => {
    expect(selectRelayOneProtocol('future', 'Other', ['openai-response'])).toBe('openai-responses')
    expect(selectRelayOneProtocol('gemini-4', 'Google', ['openai'])).toBe('openai-chat')
  })
  it('keeps null and explicit empty model selections distinct', () => {
    const all = relayOneModelOptions(catalog(), defaultRelayOneSettings())
    expect(all.filter(model => model.kind === 'chat').every(model => model.enabled)).toBe(true)
    const none = relayOneModelOptions(catalog(), { ...defaultRelayOneSettings(), enabledModelIds: [] })
    expect(none.filter(model => model.kind === 'chat').every(model => !model.enabled)).toBe(true)
  })
  it('falls back only on an explicit protocol refusal', () => {
    expect(isRelayOneProtocolUnsupported(400, 'unsupported endpoint: responses')).toBe(true)
    expect(isRelayOneProtocolUnsupported(400, 'model_not_found')).toBe(false)
    expect(isRelayOneProtocolUnsupported(400, 'invalid tool arguments')).toBe(false)
    expect(fallbackRelayOneProtocol(entry('gpt-6-astra'), 'openai-responses')).toBe('openai-chat')
  })
  it('round-trips the production snapshot writer and parser as a pair', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'relayone-catalog-'))
    vi.stubEnv('DSH_HOME', home)
    const name = 'relayone-test'
    await writeCatalogSnapshot(name, catalog().map(persistedRelayOneModelRecord), 1234)
    await flushCatalogSnapshots()
    const restored = await readCatalogSnapshot(name, parsePersistedRelayOneModelEntries)
    expect(restored?.fetchedAt).toBe(1234)
    expect(restored?.models).toEqual(catalog())
    await fs.unlink(catalogSnapshotPath(name))
    await fs.rmdir(path.join(home, 'storages'))
    await fs.rmdir(home)
  })
})

describe('RelayOne OpenAI request mapping', () => {
  it('builds standard Responses without Codex private fields', () => {
    const tools = [{ name: 'lookup', description: 'lookup', parameters: { type: 'object' } }] as NonNullable<GenerateOptions['tools']>
    const body = buildRelayOneResponsesRequest(options({ system: 'system', tools, reasoningEffort: effort('high') }), NO_RESOLVED_IMAGES, entry('gpt-6-astra'), defaultRelayOneSettings())
    expect(body).toMatchObject({ model: 'gpt-6-astra', stream: true, instructions: 'system\n\n' + GPT_PROGRESS_RULE, store: false, reasoning: { effort: 'high' } })
    expect(JSON.stringify(body)).not.toMatch(/responses-lite|originator|x-codex|additional_tools|reasoning.encrypted_content/)
    expect(body.tools).toEqual([{ type: 'function', name: 'lookup', description: 'lookup', strict: false, parameters: { type: 'object' } }])
  })
  it('replays function calls and keeps orphan outputs as text', () => {
    const assistant = { role: 'assistant', content: [{ type: 'tool-call', id: 'call_a', name: 'lookup', arguments: '{"x":1}' }] } as Message
    const result = { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_a', content: [{ type: 'text', text: 'ok' }] }] } as Message
    const orphan = { role: 'user', content: [{ type: 'tool-result', toolCallId: 'missing', content: [{ type: 'text', text: 'orphan' }] }] } as Message
    const body = buildRelayOneResponsesRequest(options({ messages: [assistant, result, orphan] }), NO_RESOLVED_IMAGES, entry('gpt-6-astra'), defaultRelayOneSettings())
    const input = body.input as Record<string, unknown>[]
    expect(input).toContainEqual({ type: 'function_call', call_id: 'call_a', name: 'lookup', arguments: '{"x":1}' })
    expect(input).toContainEqual({ type: 'function_call_output', call_id: 'call_a', output: 'ok' })
    expect(JSON.stringify(input.at(-1))).toContain('unavailable call missing')
  })
  it('leaves the upstream default unset but forwards all seven explicit GPT efforts', () => {
    expect(buildRelayOneResponsesRequest(options(), NO_RESOLVED_IMAGES, entry('gpt-6-astra'), defaultRelayOneSettings())).not.toHaveProperty('reasoning')
    for (const value of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      const body = buildRelayOneResponsesRequest(options({ reasoningEffort: effort(value) }), NO_RESOLVED_IMAGES, entry('gpt-6-astra'), defaultRelayOneSettings())
      expect(body.reasoning).toEqual({ effort: value })
    }
    expect(entry('gpt-6-astra').contextWindow).toBe(272000)
  })
  it('adds ChatGPT-style progress text to GPT Chat requests only with tools', () => {
    const tools = [{ name: 'lookup', description: 'lookup', parameters: { type: 'object' } }] as NonNullable<GenerateOptions['tools']>
    const body = buildRelayOneChatRequest(
      options({ system: 'system', tools }),
      NO_RESOLVED_IMAGES,
      entry('gpt-6-astra'),
      defaultRelayOneSettings(),
    )
    const messages = body.messages as Record<string, unknown>[]
    expect(messages[0]).toEqual({ role: 'system', content: 'system\n\n' + GPT_PROGRESS_RULE })

    const withoutTools = buildRelayOneResponsesRequest(
      options({ system: 'system' }), NO_RESOLVED_IMAGES, entry('gpt-6-astra'), defaultRelayOneSettings(),
    )
    expect(withoutTools.instructions).toBe('system')

    const otherModel = buildRelayOneChatRequest(
      options({ model: 'deepseek-v4.1-flash-1017', system: 'system', tools }),
      NO_RESOLVED_IMAGES,
      entry('deepseek-v4.1-flash-1017'),
      defaultRelayOneSettings(),
    )
    expect((otherModel.messages as Record<string, unknown>[])[0]).toEqual({ role: 'system', content: 'system' })
  })
  it('uses Chat tool declarations and reasoning_effort for non-OpenAI vendors', () => {
    const tools = [{ name: 'lookup', description: 'lookup', parameters: { type: 'object' } }] as NonNullable<GenerateOptions['tools']>
    const body = buildRelayOneChatRequest(options({ model: 'deepseek-v4.1-flash-1017', tools, reasoningEffort: effort('low') }), NO_RESOLVED_IMAGES, entry('deepseek-v4.1-flash-1017'), defaultRelayOneSettings())
    expect(body).toMatchObject({ stream_options: { include_usage: true }, tool_choice: 'auto', parallel_tool_calls: true, reasoning_effort: 'low' })
    expect(JSON.stringify(body.tools)).toContain('"function"')
  })
})

describe('RelayOne Chat streaming tools', () => {
  it('keeps parallel calls separate and reports disjoint cache usage', () => {
    const state = createRelayOneChatStreamState()
    feedRelayOneChatPayload(state, { choices: [{ delta: { tool_calls: [
      { index: 0, id: 'a', function: { name: 'one', arguments: '{"x":' } },
      { index: 1, id: 'b', function: { name: 'two', arguments: '{"y":' } },
    ] }, finish_reason: null }] })
    feedRelayOneChatPayload(state, { choices: [{ delta: { tool_calls: [
      { index: 0, function: { arguments: '1}' } }, { index: 1, function: { arguments: '2}' } },
    ] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 8, cache_write_tokens: 2 } } })
    const chunks = processRelayOneChatLine('data: [DONE]', state)
    const calls = chunks.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call' ? [chunk.block] : [])
    expect(calls.map(call => call.arguments)).toEqual(['{"x":1}', '{"y":2}'])
    expect(chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 8, cacheWriteTokens: 2 } })
    expect(finishOf(chunks)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })
  it('refuses malformed tool JSON instead of executing a guessed call', () => {
    const state = createRelayOneChatStreamState()
    feedRelayOneChatPayload(state, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'bad', function: { name: 'bad', arguments: '{broken' } }] }, finish_reason: 'tool_calls' }] })
    expect(() => closeRelayOneChatStream(state)).toThrowError(/invalid JSON arguments/)
  })
})

describe('RelayOne Anthropic tools and replay', () => {
  it('builds native tools, max_tokens and thinking budget', () => {
    const tools = [{ name: 'lookup', description: 'lookup', parameters: { type: 'object' } }] as NonNullable<GenerateOptions['tools']>
    const body = buildRelayOneAnthropicRequest(options({ model: 'claude-opus-5-5', tools, reasoningEffort: effort('medium') }), NO_RESOLVED_IMAGES, entry('claude-opus-5-5'), defaultRelayOneSettings())
    expect(body).toMatchObject({ max_tokens: 16384, tool_choice: { type: 'auto' }, thinking: { type: 'enabled', budget_tokens: 8192 } })
    expect(JSON.stringify(body.tools)).toContain('"input_schema"')
  })
  it('streams tool_use and replays it with its tool_result', () => {
    const state = createRelayOneAnthropicStreamState()
    const lines = [
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_a', name: 'lookup', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"x":' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '1}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ]
    const chunks = lines.flatMap(event => processRelayOneAnthropicLine('data: ' + JSON.stringify(event), state))
    expect(chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } })
    const finish = finishOf(chunks)
    expect(finish).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
    const replayState = finish?.type === 'finish' ? finish.replayState : undefined
    const assistant = { role: 'assistant', content: [{ type: 'tool-call', id: 'call_a', name: 'lookup', arguments: '{"x":1}' }], source: { kind: 'model', replayState } } as Message
    const result = { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_a', content: [{ type: 'text', text: 'ok' }] }] } as Message
    const next = buildRelayOneAnthropicRequest(options({ model: 'claude-opus-5-5', messages: [assistant, result] }), NO_RESOLVED_IMAGES, entry('claude-opus-5-5'), defaultRelayOneSettings())
    expect(JSON.stringify(next.messages)).toContain('"tool_use"')
    expect(JSON.stringify(next.messages)).toContain('"tool_result"')
    expect(JSON.stringify(next.messages)).toContain('"tool_use_id":"call_a"')
  })
})
