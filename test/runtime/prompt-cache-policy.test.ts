import { describe, expect, it } from 'vitest'
import {
  promptCachePolicyKey,
  parsePromptCacheOverride,
  parsePromptCacheOverrides,
  promptCachePolicyOf,
  readPromptCacheConfigField,
  resolvePromptCachePolicies,
} from '../../src/host/common/prompt-cache-policy.ts'

describe('prompt cache policy defaults', () => {
  it('preserves Kimi measured lifecycle semantics', () => {
    const policy = promptCachePolicyOf('kimi-code')
    expect(policy).toMatchObject({
      mode: 'automatic', scope: 'account', ttlMs: 25 * 60_000,
      coldStart: 'warm', affinity: true, waitWarmup: true, hint: true,
    })
  })

  it('allows in-flight coordination without inventing a warm TTL', () => {
    for (const provider of ['codex-chatgpt', 'step-code', 'claude', 'minimax-code']) {
      expect(promptCachePolicyOf(provider).coldStart).toBe('in-flight')
      expect(promptCachePolicyOf(provider).affinity).toBe(false)
      expect(promptCachePolicyOf(provider).waitWarmup).toBe(provider === 'claude')
    }
  })

  it('uses Step official TTL for hints only', () => {
    expect(promptCachePolicyOf('step-code')).toMatchObject({ ttlMs: 300_000, hint: true, waitWarmup: false })
  })

  it('fails closed for an unknown provider and Ollama', () => {
    for (const provider of ['unknown-provider', 'ollama']) {
      expect(promptCachePolicyOf(provider)).toMatchObject({
        mode: 'none', coldStart: 'off', affinity: false, waitWarmup: false, hint: false,
      })
    }
  })
})

describe('prompt cache overrides', () => {
  it('allows a deployment to state evidence and enable a gated mechanism', () => {
    const policy = promptCachePolicyOf('qoder', { scope: 'account', affinity: true })
    expect(policy.scope).toBe('account')
    expect(policy.affinity).toBe(true)
  })

  it('rejects affinity while account partitioning is unknown', () => {
    expect(() => promptCachePolicyOf('qoder', { affinity: true })).toThrow(/scope:"account"/)
  })

  it('rejects warm, hints, and wait warmup without a TTL', () => {
    expect(() => promptCachePolicyOf('qoder', { coldStart: 'warm' })).toThrow(/ttlMs/)
    expect(() => promptCachePolicyOf('qoder', { hint: true })).toThrow(/ttlMs/)
    expect(() => promptCachePolicyOf('qoder', { waitWarmup: true })).toThrow(/ttlMs/)
  })

  it('mode none disables every mechanism even when an override asks for them', () => {
    expect(promptCachePolicyOf('kimi-code', {
      mode: 'none', affinity: true, waitWarmup: true, hint: true, coldStart: 'warm',
    })).toMatchObject({ mode: 'none', coldStart: 'off', affinity: false, waitWarmup: false, hint: false })
  })

  it('rejects unknown fields, invalid numbers, and invalid provider ids', () => {
    expect(() => parsePromptCacheOverride('qoder', { unexpected: true })).toThrow(/unknown field/)
    expect(() => parsePromptCacheOverride('qoder', { ttlMs: 0 })).toThrow(/ttlMs/)
    expect(() => parsePromptCacheOverride('qoder', { hint: 1 })).toThrow(/boolean/)
    expect(() => parsePromptCacheOverrides({ '../bad': {} })).toThrow(/provider id/)
    expect(() => parsePromptCacheOverrides([])).toThrow(/object/)
  })

  it('resolves the union of built-ins and explicitly configured providers', () => {
    const policies = resolvePromptCachePolicies({ 'new-provider': { mode: 'automatic', coldStart: 'in-flight' } })
    expect(policies['new-provider']?.coldStart).toBe('in-flight')
    expect(policies['kimi-code']?.coldStart).toBe('warm')
  })
})

describe('volatile config reads', () => {
  it('reads plain values and live getters', () => {
    expect(readPromptCacheConfigField(true)).toBe(true)
    expect(readPromptCacheConfigField({ get: () => false })).toBe(false)
    expect(readPromptCacheConfigField(undefined)).toBeUndefined()
  })
})

describe('waitJobs opt-in', () => {
  it('is false for every line except kimi-code, claude and claude-api', () => {
    const policies = resolvePromptCachePolicies()
    const optedIn = new Set(['kimi-code', 'claude', 'claude-api'])
    for (const [provider, policy] of Object.entries(policies)) {
      expect(policy.waitJobs).toBe(optedIn.has(provider))
    }
    expect(promptCachePolicyOf('unknown-provider').waitJobs).toBe(false)
    expect(promptCachePolicyOf('kimi-code').waitJobs).toBe(true)
  })

  it('resolves the claude subscription route id to the same facts as its line id', () => {
    expect(promptCachePolicyOf('claude-subscription')).toEqual(promptCachePolicyOf('claude'))
    expect(promptCachePolicyOf('claude-subscription').waitWarmup).toBe(true)
    expect(promptCachePolicyOf('claude-subscription', { waitWarmup: false, waitJobs: false }).waitWarmup).toBe(false)
    expect(promptCachePolicyOf('claude-subscription', { ttlMs: 600_000 }).ttlMs).toBe(600_000)
    expect(promptCachePolicyOf('unknown-provider').mode).toBe('none')
  })

  it('names the claude-api 1h tier and changes no other claude-api fact', () => {
    expect(promptCachePolicyOf('claude-api')).toMatchObject({
      mode: 'explicit', scope: 'unknown', ttlMs: 3_600_000, staticPrefix: false,
      coldStart: 'in-flight', stickyImages: false, affinity: false,
      waitWarmup: true, waitJobs: true, hint: false,
    })
  })

  it('opts the claude subscription line into the 1h keepalive and changes no other fact', () => {
    expect(promptCachePolicyOf('claude')).toMatchObject({
      mode: 'explicit', scope: 'unknown', staticPrefix: true, coldStart: 'in-flight',
      stickyImages: true, affinity: false, hint: false,
      ttlMs: 3_600_000, waitWarmup: true, waitJobs: true,
    })
  })

  it('keeps every Kimi fact while opting its background jobs in', () => {
    expect(promptCachePolicyOf('kimi-code')).toMatchObject({
      mode: 'automatic', scope: 'account', ttlMs: 25 * 60_000, staticPrefix: true,
      coldStart: 'warm', stickyImages: true, affinity: true,
      waitWarmup: true, waitJobs: true, hint: true,
    })
  })

  it('accepts turning waitWarmup off on a line that opted its jobs in, and rejects a non-boolean waitJobs', () => {
    // A deployment that only writes waitWarmup: false must keep starting: waitJobs is inert without it.
    expect(promptCachePolicyOf('kimi-code', { waitWarmup: false }).waitWarmup).toBe(false)
    expect(promptCachePolicyOf('claude', { waitWarmup: false }).waitWarmup).toBe(false)
    expect(promptCachePolicyOf('step-code', { waitJobs: true }).waitWarmup).toBe(false)
    expect(promptCachePolicyKey('claude-subscription')).toBe('claude')
    expect(promptCachePolicyKey('kimi-code')).toBe('kimi-code')
    expect(promptCachePolicyKey('unknown-provider')).toBe('unknown-provider')
    expect(() => parsePromptCacheOverride('qoder', { waitJobs: 1 })).toThrow(/boolean/)
    expect(promptCachePolicyOf('step-code', { waitWarmup: true, ttlMs: 1_000, waitJobs: true }).waitJobs).toBe(true)
    expect(promptCachePolicyOf('kimi-code', { mode: 'none', waitJobs: true }).waitJobs).toBe(false)
  })
})
