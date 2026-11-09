import { beforeEach, describe, expect, it } from 'vitest'
import type { GenerateOptions, Message } from '../src/host/common/llm-compat.ts'
import {
  buildRequest,
  closeStream,
  createStreamState,
  getCacheStats,
  getLastDriftCause,
  processAnthropicStreamLine,
  processOpenAIStreamLine,
  resetCacheStats,
} from '../src/host/kimi-code/mapper.ts'

/** One completed turn, with the cache reads the service reported. */
function turn(sessionId: string | undefined, cachedTokens: number, inputTokens: number): void {
  const state = createStreamState('openai', sessionId)
  processOpenAIStreamLine(
    `data: ${JSON.stringify({
      choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: cachedTokens + inputTokens,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: cachedTokens },
      },
    })}`,
    state,
  )
  closeStream(state)
}

describe('per-session cache accounting', () => {
  beforeEach(() => {
    resetCacheStats()
  })

  it('files each session under its own totals', () => {
    turn('sess-a', 900, 100)
    turn('sess-b', 0, 1000)

    expect(getCacheStats('sess-a').requests).toBe(1)
    expect(getCacheStats('sess-b').requests).toBe(1)
    expect(getCacheStats('sess-a').cachedTokens).toBe(900)
    expect(getCacheStats('sess-b').cachedTokens).toBe(0)
  })

  it('does not let a cold session drag a warm one down', () => {
    turn('warm', 900, 100)
    turn('cold', 0, 1000)

    // 900 / 1000 for the warm session alone. Merged, it would read 0.47.
    expect(getCacheStats('warm').hitRatio).toBeCloseTo(0.9, 5)
    expect(getCacheStats('cold').hitRatio).toBe(0)
  })

  it('keeps accounts of one session apart, since each has its own cache', () => {
    const warm = createStreamState('openai', 'sess')
    const cold = createStreamState('openai', 'sess')
    for (const [state, cached] of [[warm, 800], [cold, 0]] as const) {
      processOpenAIStreamLine(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 1,
            prompt_tokens_details: { cached_tokens: cached },
          },
        })}`,
        state,
      )
    }
    // Recorded under two different accounts, same session.
    closeStream(warm, 'account-1')
    closeStream(cold, 'account-2')

    expect(getCacheStats('sess', 'account-1').hitRatio).toBeCloseTo(0.8, 5)
    expect(getCacheStats('sess', 'account-2').hitRatio).toBe(0)
    // Unnamed account reads the whole session.
    expect(getCacheStats('sess').requests).toBe(2)
  })

  it('keeps the actual account when an OpenAI terminal DONE closes the stream', () => {
    const state = createStreamState('openai', 'terminal-openai')
    state.accountId = 'account-terminal'
    processOpenAIStreamLine(`data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 1,
        prompt_tokens_details: { cached_tokens: 900 },
      },
    })}`, state)
    processOpenAIStreamLine('data: [DONE]', state)

    expect(getCacheStats('terminal-openai', 'account-terminal')).toMatchObject({ requests: 1, cachedTokens: 900 })
  })

  it('keeps the actual account when an Anthropic message_stop closes the stream', () => {
    const state = createStreamState('anthropic', 'terminal-anthropic')
    state.accountId = 'account-terminal'
    processAnthropicStreamLine(`data: ${JSON.stringify({
      type: 'message_start',
      message: { usage: { input_tokens: 100, cache_read_input_tokens: 80, output_tokens: 0 } },
    })}`, state)
    processAnthropicStreamLine(`data: ${JSON.stringify({ type: 'message_stop' })}`, state)

    expect(getCacheStats('terminal-anthropic', 'account-terminal')).toMatchObject({ requests: 1, cachedTokens: 80 })
  })

  it('sums every session when none is named', () => {
    turn('one', 500, 500)
    turn('two', 250, 250)
    turn('three', 100, 400)

    const all = getCacheStats()
    expect(all.requests).toBe(3)
    expect(all.cachedTokens).toBe(850)
    expect(all.freshTokens).toBe(1150)
    expect(all.hitRatio).toBeCloseTo(850 / 2000, 5)
  })

  it('keeps a request with no session out of every real session', () => {
    turn(undefined, 0, 500)
    turn('real', 900, 100)

    expect(getCacheStats().requests).toBe(2)
    expect(getCacheStats('real').requests).toBe(1)
    expect(getCacheStats('real').hitRatio).toBeCloseTo(0.9, 5)
  })

  it('reports nothing for a session that has not run', () => {
    const empty = getCacheStats('never-seen')
    expect(empty.requests).toBe(0)
    expect(empty.hitRatio).toBeNull()
  })

  it('forgets one session without disturbing the others', () => {
    turn('a', 900, 100)
    turn('b', 0, 1000)
    resetCacheStats('a')

    expect(getCacheStats('a').requests).toBe(0)
    expect(getCacheStats('b').requests).toBe(1)
  })

  it('clears drift attributions along with the session', () => {
    const options = (over: Record<string, unknown>): GenerateOptions => ({
      model: 'k3',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] } as Message],
      ...over,
    }) as GenerateOptions
    buildRequest(options({ sessionId: 'sess-x', system: 'head' }), 'openai')
    buildRequest(options({ sessionId: 'sess-x', system: 'head' }), 'openai')
    expect(getLastDriftCause('sess-x')).toBe('stable')

    resetCacheStats('sess-x')
    expect(getLastDriftCause('sess-x')).toBeUndefined()
  })
})