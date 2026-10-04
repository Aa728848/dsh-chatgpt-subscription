import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { MinimaxCodeAdapter } from '../src/host/minimax-code/adapter.ts'
import { MinimaxCodeCredentialStore, MinimaxCodeModelSettingsStore, parseMinimaxCodeCredentials } from '../src/host/minimax-code/token-store.ts'

afterEach(() => vi.restoreAllMocks())

describe('context overflow reaches the Harness compaction recovery seam', () => {
  it.each([undefined, 'compaction' as const])('recovers counted input/output overflow through the real MiniMax adapter (%s)', async purpose => {
    const store = new MinimaxCodeCredentialStore()
    vi.spyOn(store, 'read').mockResolvedValue(parseMinimaxCodeCredentials({
      accessToken: 'test', refreshToken: 'test', expiresAtMs: Date.now() + 86_400_000, region: 'cn',
    }, { region: 'cn' }))
    const settings = new MinimaxCodeModelSettingsStore()
    vi.spyOn(settings, 'read').mockResolvedValue({
      enabled: true, enabledModelIds: ['MiniMax-M2.7'], contextWindowOverrides: {}, defaultReasoningEffort: null,
    })
    const bodies: Record<string, unknown>[] = []
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(init!.body as string)
      bodies.push(body)
      if (bodies.length === 1) return new Response(JSON.stringify({ error: { message:
        "This model's maximum context length is 200000 tokens. However, you requested 245536 tokens (180000 in the messages, 65536 in the completion). Please reduce the length of the messages or completion.",
      } }), { status: 400 })
      const frames = [
        { type: 'message_start', message: { usage: { input_tokens: 180000, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Complete checkpoint' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ]
      return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join(''))
    })
    const ctx = new Context()
    const fiber = ctx.plugin(LlmRuntime)
    try {
      await fiber
      ctx.llm.registerAdapter(['minimax-code'], new MinimaxCodeAdapter(store, { fetchFn }, settings))
      const assembler = new BlockAssembler()
      for await (const chunk of ctx.llm.stream({
        provider: 'minimax-code', model: 'MiniMax-M2.7', maxTokens: 65536,
        ...(purpose === undefined ? {} : { purpose }),
        messages: [createUserMessage({ content: [{ type: 'text', text: 'Summarize full history.' }], source: { kind: 'user' } })],
      })) assembler.push(chunk)
      expect(assembler.finish).toEqual({ kind: 'stop' })
      expect(assembler.blocks()).toEqual([{ type: 'text', text: 'Complete checkpoint' }])
      expect(bodies).toHaveLength(2)
      expect(bodies[1]!.max_tokens).toBe(18976)
      expect({ ...bodies[1], max_tokens: 65536 }).toEqual(bodies[0])
    } finally { await fiber.dispose() }
  })

  it.each([
    { transport: 'http', purpose: undefined },
    { transport: 'sse', purpose: undefined },
    { transport: 'http', purpose: 'compaction' as const },
    { transport: 'sse', purpose: 'compaction' as const },
    { transport: 'success', purpose: 'compaction' as const },
    { transport: 'truncated', purpose: 'compaction' as const },
  ])('preserves the overflow code for $transport / $purpose', async ({ transport, purpose }) => {
    const store = new MinimaxCodeCredentialStore()
    vi.spyOn(store, 'read').mockResolvedValue(parseMinimaxCodeCredentials({
      accessToken: 'test', refreshToken: 'test', expiresAtMs: Date.now() + 86_400_000, region: 'cn',
    }, { region: 'cn' }))
    const settings = new MinimaxCodeModelSettingsStore()
    vi.spyOn(settings, 'read').mockResolvedValue({
      enabled: true, enabledModelIds: ['MiniMax-M2.7'], contextWindowOverrides: {}, defaultReasoningEffort: null,
    })
    const error = { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum' }
    const summaryFrames = [
      { type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '## Current Work\n- Fix compaction.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: transport === 'truncated' ? 'max_tokens' : 'end_turn' }, usage: { output_tokens: 12 } },
      { type: 'message_stop' },
    ]
    const fetchFn = vi.fn<typeof fetch>(async () => transport === 'success' || transport === 'truncated'
      ? new Response(summaryFrames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join(''))
      : transport === 'http'
      ? new Response(JSON.stringify({ error }), { status: 400 })
      : new Response('data: ' + JSON.stringify({ type: 'error', error }) + '\n\n'))
    const ctx = new Context()
    const fiber = ctx.plugin(LlmRuntime)
    try {
      await fiber
      ctx.llm.registerAdapter(['minimax-code'], new MinimaxCodeAdapter(store, { fetchFn }, settings))
      const assembler = new BlockAssembler()
      for await (const chunk of ctx.llm.stream({
        provider: 'minimax-code', model: 'MiniMax-M2.7',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'Summarize the preceding conversation.' }], source: { kind: 'user' } })],
        ...(purpose === undefined ? {} : { purpose, maxTokens: 65_536 }),
      })) assembler.push(chunk)
      if (transport === 'success' || transport === 'truncated') {
        expect(assembler.finish).toEqual({ kind: transport === 'success' ? 'stop' : 'max-tokens' })
        expect(assembler.blocks()).toEqual([{ type: 'text', text: '## Current Work\n- Fix compaction.' }])
      } else {
        expect(assembler.finish, JSON.stringify(assembler.finish)).toMatchObject({
          kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED' },
        })
        expect(assembler.blocks()).toEqual([])
      }
      expect(fetchFn).toHaveBeenCalledTimes(1)
    } finally {
      await fiber.dispose()
    }
  })
})
