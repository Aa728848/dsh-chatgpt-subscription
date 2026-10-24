import { describe, expect, it } from 'vitest'
import { claudeBetas } from '../src/host/claude/client.ts'
import { buildClaudeRequestBody } from '../src/host/claude/mapper.ts'
import { EXTENDED_CACHE_TTL_BETA, cacheControlFor } from '../src/host/claude/types.ts'
import { buildRequest } from '../src/host/kimi-code/mapper.ts'
import { isClaudeCacheTtl } from '../src/shared/claude-contracts.ts'
import type { GenerateOptions } from '../src/host/common/llm-compat.ts'

const empty: GenerateOptions = {
  provider: 'claude-subscription',
  model: 'claude-sonnet-5-5',
  messages: [{ role: 'user', content: 'hi' }],
} as unknown as GenerateOptions

describe('claude prompt-cache TTL', () => {
  it('writes the plain marker by default, so an unstated caller is unchanged', () => {
    const body = buildClaudeRequestBody(empty, undefined, { cacheControl: true })
    const system = body.system as Array<Record<string, unknown>>
    const marker = system[system.length - 1]!.cache_control as Record<string, unknown>

    expect(marker).toEqual({ type: 'ephemeral', ttl: '5m' })
  })

  it('writes the one-hour marker when that tier is asked for', () => {
    const body = buildClaudeRequestBody(empty, undefined, { cacheControl: true, cacheTtl: '1h' })
    const system = body.system as Array<Record<string, unknown>>

    expect(system[system.length - 1]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  it('licenses the one-hour tier with the beta that permits it', () => {
    // The hour is a LICENSED capability: a body asking for `ttl: '1h'` without
    // the marker is refused, exactly as `block_binding` is.
    expect(claudeBetas({ cacheTtl: '1h' })).toContain(EXTENDED_CACHE_TTL_BETA)
    expect(EXTENDED_CACHE_TTL_BETA).toBe('extended-cache-ttl-2025-04-11')
  })

  it('sends no extended-cache beta for the plain tier', () => {
    expect(claudeBetas({ cacheTtl: '5m' })).not.toContain(EXTENDED_CACHE_TTL_BETA)
    expect(claudeBetas({})).not.toContain(EXTENDED_CACHE_TTL_BETA)
  })

  it('refuses a tier the wire does not accept', () => {
    expect(isClaudeCacheTtl('1h')).toBe(true)
    expect(isClaudeCacheTtl('5m')).toBe(true)
    expect(isClaudeCacheTtl('24h')).toBe(false)
    expect(isClaudeCacheTtl(null)).toBe(false)
  })

  it('omits caching entirely when the caller opts out', () => {
    const body = buildClaudeRequestBody(empty, undefined, { cacheControl: false, cacheTtl: '1h' })
    const system = body.system as Array<Record<string, unknown>>

    expect(system.every((block) => block.cache_control === undefined)).toBe(true)
  })

  it('keeps the marker builder and the type in agreement', () => {
    expect(cacheControlFor('1h')).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(cacheControlFor('5m')).toEqual({ type: 'ephemeral', ttl: '5m' })
  })
})

describe('kimi prompt-cache fields', () => {
  it('sends no cache field on either wire', () => {
    // The tier setting is gone: the coding endpoint documents no cache TTL, the
    // official CLI cannot emit one, and the measured lifetime belongs to the
    // service's own default. These assertions are the guard that the field does
    // not creep back in.
    for (const wire of ['openai', 'anthropic'] as const) {
      const body = buildRequest(empty, wire, undefined, undefined, {})
      expect(body).not.toHaveProperty('prompt_cache_options')
      expect(body).not.toHaveProperty('cache_control')
    }
  })

  it('sends no cache field even when other media options are passed', () => {
    // Message-level tools are the only other member of this object; asking for
    // them must not drag a cache field along.
    for (const wire of ['openai', 'anthropic'] as const) {
      const body = buildRequest(empty, wire, undefined, undefined, { messageTools: true })
      expect(body).not.toHaveProperty('prompt_cache_options')
      expect(body).not.toHaveProperty('cache_control')
    }
  })
})