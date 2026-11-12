import { describe, expect, it } from 'vitest'
import {
  parsePromptCacheOverride,
  parsePromptCacheOverrides,
  promptCachePolicyOf,
  readPromptCacheConfigField,
  resolvePromptCachePolicies,
} from '../src/host/common/prompt-cache-policy.ts'

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
      expect(promptCachePolicyOf(provider).waitWarmup).toBe(false)
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
