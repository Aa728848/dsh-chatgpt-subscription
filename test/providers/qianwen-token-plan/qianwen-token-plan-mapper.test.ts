import { beforeEach, describe, expect, it } from 'vitest'
import type { GenerateOptions, Message, StreamChunk } from '../../../src/host/common/llm-compat.ts'
import {
  buildQianwenChatRequest,
  closeQianwenStream,
  createQianwenStreamState,
  feedQianwenChatChunk,
  parseQianwenUsage,
  processQianwenStreamLine,
} from '../../../src/host/providers/qianwen-token-plan/mapper.ts'
import { defaultQianwenSettings } from '../../../src/host/providers/qianwen-token-plan/token-store.ts'
import { QIANWEN_MODEL_CATALOG } from '../../../src/host/providers/qianwen-token-plan/model-catalog.ts'
import { PROVIDER_ID } from '../../../src/host/providers/qianwen-token-plan/types.ts'
import { QIANWEN_REASONING_EFFORTS } from '../../../src/shared/qianwen-token-plan-contracts.ts'
import { readQianwenCacheStats, recordQianwenCacheUsage, resetQianwenCacheStats } from '../../../src/host/providers/qianwen-token-plan/cache-stats.ts'

const effort = (value: string) => value as NonNullable<GenerateOptions['reasoningEffort']>
function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: PROVIDER_ID, model: 'qwen4-max',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] } as Message],
    ...overrides,
  } as GenerateOptions
}
const frame = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  choices: [{ index: 0, delta, finish_reason: null }], ...extra,
})
const finishOf = (chunks: StreamChunk[]) => chunks.find(chunk => chunk.type === 'finish')
const markerCount = (value: unknown): number => {
  if (Array.isArray(value)) return value.reduce((sum, entry) => sum + markerCount(entry), 0)
  if (typeof value !== 'object' || value === null) return 0
  const record = value as Record<string, unknown>
  return (record.prompt_cache_breakpoint === undefined ? 0 : 1) + Object.values(record).reduce<number>((sum, entry) => sum + markerCount(entry), 0)
}

beforeEach(() => resetQianwenCacheStats())

describe('Qwen Token Plan full model catalog', () => {
  it('contains every personal/team text and vision model without generation-only media models', () => {
    expect(QIANWEN_MODEL_CATALOG).toHaveLength(23)
    const ids = QIANWEN_MODEL_CATALOG.map(model => model.id)
    for (const id of ['auto', 'qwen3.8-max', 'qwen3.6-plus', 'deepseek-v4.1-flash', 'glm-5.1', 'kimi-k2.7-code', 'MiniMax-M2.5']) expect(ids).toContain(id)
    expect(ids.some(id => /image|audio|wan|happyhorse/.test(id))).toBe(false)
    expect(ids).not.toContain('decision-model-preview')
    expect(QIANWEN_MODEL_CATALOG.find(model => model.id === 'kimi-k2.7-code')?.availability).toBe('team-only')
  })
  it('keeps auto free of tool_choice and third-party requests free of Qwen4-only fields', () => {
    const tools = [{ name: 'lookup', description: 'lookup', parameters: { type: 'object' } }] as NonNullable<GenerateOptions['tools']>
    const auto = buildQianwenChatRequest(options({ model: 'auto', tools, reasoningEffort: effort('max') }))
    expect(auto.body.tools).toBeDefined()
    expect(auto.body).not.toHaveProperty('tool_choice')
    expect(auto.body).not.toHaveProperty('reasoning_effort')
    expect(auto.body).not.toHaveProperty('prompt_cache_options')
    const third = buildQianwenChatRequest(options({ model: 'deepseek-v4-pro' }))
    expect(third.body).not.toHaveProperty('thinking_display')
    expect(third.body).not.toHaveProperty('preserve_thinking')
    expect(third.body).not.toHaveProperty('prompt_cache_options')
  })
})

describe('Qwen reasoning and cache request controls', () => {
  it('passes every user effort through verbatim and never sends thinking_budget', () => {
    for (const value of QIANWEN_REASONING_EFFORTS) {
      const built = buildQianwenChatRequest(options({ reasoningEffort: effort(value) }))
      expect(built.body.reasoning_effort).toBe(value)
      expect(built.body).not.toHaveProperty('thinking_budget')
    }
  })
  it('uses the configured default only when the call has no effort, and a per-call effort wins', () => {
    const settings = { ...defaultQianwenSettings(), defaultReasoningEffort: 'max' as const }
    expect(buildQianwenChatRequest(options(), undefined, settings).body.reasoning_effort).toBe('max')
    expect(buildQianwenChatRequest(options({ reasoningEffort: effort('minimal') }), undefined, settings).body.reasoning_effort).toBe('minimal')
  })
  it('none disables summary mode without silently changing the selected level', () => {
    const built = buildQianwenChatRequest(options({ reasoningEffort: effort('none') }))
    expect(built.body.reasoning_effort).toBe('none')
    expect(built.summaryMode).toBe(false)
    expect(built.body).not.toHaveProperty('thinking_display')
  })
  it('offers 5m and 1h automatic explicit caching and no Anthropic markers', () => {
    for (const cacheTtl of ['5m', '1h'] as const) {
      const settings = { ...defaultQianwenSettings(), system: 'stable', cacheTtl }
      const built = buildQianwenChatRequest(options({ system: 'stable system' }), undefined, settings)
      expect(built.body.prompt_cache_options).toEqual({ mode: 'implicit', ttl: cacheTtl })
      expect(JSON.stringify(built.body)).not.toContain('cache_control')
    }
  })
  it('cache disable removes both automatic and manual cache fields', () => {
    const settings = { ...defaultQianwenSettings(), cacheEnabled: false }
    const built = buildQianwenChatRequest(options({ system: 'stable system' }), undefined, settings)
    expect(built.body).not.toHaveProperty('prompt_cache_options')
    expect(markerCount(built.body)).toBe(0)
    expect(built.cacheBreakpoints).toBe(0)
  })
  it('places exact intermediate breakpoints in one long message and caps the total at four', () => {
    const blocks = Array.from({ length: 65 }, (_, index) => ({ type: 'text', text: 'block-' + index }))
    const built = buildQianwenChatRequest(options({ system: 'stable', messages: [{ role: 'user', content: blocks } as Message] }))
    expect(markerCount(built.body)).toBe(3)
    expect(built.cacheBreakpoints).toBe(4)
    const user = (built.body.messages as Record<string, unknown>[]).find(message => message.role === 'user')
    const content = user?.content as Record<string, unknown>[]
    // The leading system block is global position 1, so positions 40/60 are user indices 38/58.
    expect(content[38]?.prompt_cache_breakpoint).toEqual({ mode: 'explicit' })
    expect(content[58]?.prompt_cache_breakpoint).toEqual({ mode: 'explicit' })
  })
  it('uses max_completion_tokens for the caller output cap', () => {
    const built = buildQianwenChatRequest(options({ maxTokens: 8192 }))
    expect(built.body.max_completion_tokens).toBe(8192)
    expect(built.body).not.toHaveProperty('max_tokens')
  })
  it('maps image detail and an explicit max_pixels budget', () => {
    const message = { role: 'user', content: [{ type: 'image', data: 'aGVsbG8=', mediaType: 'image/png' }] } as unknown as Message
    const settings = { ...defaultQianwenSettings(), imageDetail: 'high' as const, maxPixels: 1_048_576 }
    const built = buildQianwenChatRequest(options({ messages: [message] }), undefined, settings)
    const user = (built.body.messages as Record<string, unknown>[])[0]
    const image = (user.content as Record<string, unknown>[])[0]
    expect(image.max_pixels).toBe(1_048_576)
    expect(image.image_url).toMatchObject({ detail: 'high' })
  })
})

describe('Qwen encrypted thinking stream and replay', () => {
  it('retains an independent ciphertext frame and replays ciphertext without summary text', () => {
    const state = createQianwenStreamState({ model: 'qwen4-max', summaryMode: true })
    const chunks = [
      ...feedQianwenChatChunk(state, frame({ reasoning_content: 'short summary' })),
      ...feedQianwenChatChunk(state, frame({ encrypted_content: 'opaque-ciphertext' })),
      ...feedQianwenChatChunk(state, frame({ content: 'answer' })),
      ...feedQianwenChatChunk(state, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }),
      ...closeQianwenStream(state),
    ]
    const finish = finishOf(chunks)
    expect(finish?.type).toBe('finish')
    const replayState = finish?.type === 'finish' ? finish.replayState : undefined
    expect(JSON.stringify(replayState)).toContain('opaque-ciphertext')
    const assistant = {
      role: 'assistant',
      content: [{ type: 'reasoning', text: 'short summary' }, { type: 'text', text: 'answer' }],
      source: { kind: 'test', provider: PROVIDER_ID, replayState },
    } as Message
    const next = buildQianwenChatRequest(options({ messages: [assistant] }))
    const replayed = (next.body.messages as Record<string, unknown>[])[0]
    expect(replayed.encrypted_content).toBe('opaque-ciphertext')
    expect(replayed).not.toHaveProperty('reasoning_content')
    expect(next.encryptedReplays).toBe(1)
  })
  it('strips ciphertext when a different model is selected', () => {
    const state = createQianwenStreamState({ model: 'qwen4-max', summaryMode: true })
    feedQianwenChatChunk(state, frame({ reasoning_content: 'summary' }))
    feedQianwenChatChunk(state, frame({ encrypted_content: 'secret' }))
    feedQianwenChatChunk(state, frame({ content: 'answer' }))
    const chunks = closeQianwenStream(state)
    const finish = finishOf(chunks)
    const replayState = finish?.type === 'finish' ? finish.replayState : undefined
    const assistant = { role: 'assistant', content: [{ type: 'reasoning', text: 'summary' }], source: { kind: 'test', replayState } } as Message
    const next = buildQianwenChatRequest(options({ model: 'qwen4-max-preview', messages: [assistant] }))
    expect(JSON.stringify(next.body)).not.toContain('secret')
  })
  it('full mode replays reasoning_content instead of ciphertext', () => {
    const state = createQianwenStreamState({ model: 'qwen4-max', summaryMode: false })
    feedQianwenChatChunk(state, frame({ reasoning_content: 'full reasoning' }))
    const finish = finishOf(closeQianwenStream(state))
    const replayState = finish?.type === 'finish' ? finish.replayState : undefined
    const assistant = { role: 'assistant', content: [{ type: 'reasoning', text: 'full reasoning' }], source: { kind: 'test', replayState } } as Message
    const next = buildQianwenChatRequest(options({ messages: [assistant] }))
    expect((next.body.messages as Record<string, unknown>[])[0].reasoning_content).toBe('full reasoning')
  })
  it('keeps parallel tool call deltas in separate blocks', () => {
    const state = createQianwenStreamState({ model: 'qwen4-max' })
    feedQianwenChatChunk(state, frame({ tool_calls: [
      { index: 0, id: 'a', function: { name: 'one', arguments: '{"x":' } },
      { index: 1, id: 'b', function: { name: 'two', arguments: '{"y":' } },
    ] }))
    feedQianwenChatChunk(state, frame({ tool_calls: [
      { index: 0, function: { arguments: '1}' } }, { index: 1, function: { arguments: '2}' } },
    ] }))
    const chunks = closeQianwenStream(state)
    const calls = chunks.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call' ? [chunk.block] : [])
    expect(calls.map(call => call.arguments)).toEqual(['{"x":1}', '{"y":2}'])
  })
})

describe('Qwen usage accounting', () => {
  it('splits fresh/read/write and records 5m/1h writes without double counting aliases', () => {
    const usage = parseQianwenUsage({
      prompt_tokens: 10_000, completion_tokens: 500,
      prompt_tokens_details: {
        cached_tokens: 6_000, cache_write_tokens: 3_000, cache_creation_input_tokens: 3_000,
        cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 2_000 },
      },
      completion_tokens_details: { reasoning_tokens: 200 },
    })
    expect(usage).toMatchObject({ inputTokens: 1_000, cacheReadTokens: 6_000, cacheWriteTokens: 3_000, cacheWrite5mTokens: 1_000, cacheWrite1hTokens: 2_000, reasoningTokens: 200 })
  })
  it('emits usage before finish and aggregates raw token dimensions only', () => {
    const state = createQianwenStreamState({ model: 'qwen4-max' })
    processQianwenStreamLine('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 2048, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 1024, cache_write_tokens: 1024 } } }), state)
    const chunks = processQianwenStreamLine('data: [DONE]', state)
    expect(chunks.map(chunk => chunk.type)).toEqual(['usage', 'finish'])
    recordQianwenCacheUsage({ inputTokens: 0, outputTokens: 20, cacheReadTokens: 1024, cacheWriteTokens: 1024, cacheWrite5mTokens: 1024, cacheWrite1hTokens: 0, reasoningTokens: 0, encryptedReplays: 0, missingEncryptedContent: 0 })
    expect(readQianwenCacheStats()).toMatchObject({ requests: 1, missedInputTokens: 0, cacheReadTokens: 1024, cacheWriteTokens: 1024 })
  })
})
