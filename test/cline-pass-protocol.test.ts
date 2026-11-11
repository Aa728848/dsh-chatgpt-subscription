import { describe, expect, it } from 'vitest'
import { isAuthenticationError, parseRouting } from '../src/host/cline-pass/protocol.ts'
import { normalizeRotationStrategy } from '../src/host/common/account-pool.ts'

describe('Cline Pass response routing observations', () => {
  it('reads the serving channel out of a direct response', () => {
    const routing = parseRouting({
      provider: 'Baseten',
      choices: [{ message: { content: 'ok' } }],
      model: 'zai/glm-5.3',
    })
    expect(routing.pipeline).toBe('direct')
    expect(routing.finalProvider).toBe('baseten')
    expect(routing.canonicalSlug).toBe('zai/glm-5.3')
  })

  it('reads the planner routing envelope without turning it into a preference', () => {
    const routing = parseRouting({
      choices: [{ message: { provider_metadata: { gateway: { routing: {
        finalProvider: 'baseten', canonicalSlug: 'zai/glm-5.3', fallbacksAvailable: ['deepseek'], planningReasoning: 'baseten won tier 0 over deepseek',
      } } } } }],
    })
    expect(routing.pipeline).toBe('planner')
    expect(routing.fallbacks).toEqual(['deepseek'])
    expect(routing.plan).toContain('baseten')
  })

  it('reads the routing block off a streaming delta frame', () => {
    const routing = parseRouting({
      choices: [{ index: 0, delta: { provider_metadata: { gateway: { routing: {
        finalProvider: 'deepseek', canonicalSlug: 'deepseek/deepseek-v4-pro', fallbacksAvailable: [],
      } } } }, finish_reason: null }],
    })
    expect(routing.pipeline).toBe('planner')
    expect(routing.finalProvider).toBe('deepseek')
    expect(routing.canonicalSlug).toBe('deepseek/deepseek-v4-pro')
  })

  it('hunts a routing block nested off the fast paths', () => {
    const routing = parseRouting({
      choices: [{ message: { content: 'ok', extra: { wrapper: { gateway: { routing: { finalProvider: 'fireworks' } } } } } }],
    })
    expect(routing.finalProvider).toBe('fireworks')
    expect(routing.pipeline).toBe('planner')
  })

  it('proves first-party DeepSeek only by the deepseek namespace fingerprint', () => {
    const firstParty = parseRouting({
      system_fingerprint: 'fp_gateway_minted',
      choices: [{ message: { provider_metadata: {
        deepseek: { systemFingerprint: 'fp_first_party' },
        gateway: { routing: { finalProvider: 'deepseek' } },
      } } }],
    })
    expect(firstParty.fingerprint).toBe('fp_first_party')
    expect(firstParty.anonymous).toBe(false)
    const anonymous = parseRouting({
      system_fingerprint: 'fp_gateway_minted',
      choices: [{ delta: { provider_metadata: { gateway: { routing: {
        finalProvider: 'openai-compatible-private', canonicalSlug: 'private/deepseek-v4p1-flash-1017-contributor',
      } } } } }],
    })
    expect(anonymous.fingerprint).toBeNull()
    expect(anonymous.anonymous).toBe(true)
    expect(anonymous.finalProvider).toBe('openai-compatible-private')
  })

  it('keeps ordinary account authentication classification unchanged', () => {
    expect(isAuthenticationError('Error 403: forbidden', 403)).toBe(true)
    expect(isAuthenticationError('invalid api key', 401)).toBe(true)
    expect(isAuthenticationError('rate limited', 429)).toBe(false)
  })
})

describe('rotation strategy compatibility', () => {
  it('keeps the pool strategies and rejects an unknown one', () => {
    expect(normalizeRotationStrategy('round-robin')).toBe('round-robin')
    expect(normalizeRotationStrategy('sticky')).toBe('sticky')
    expect(normalizeRotationStrategy('nonsense')).toBe('sequential')
  })
})
