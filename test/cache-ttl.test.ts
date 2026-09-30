import { describe, expect, it } from 'vitest'
import { claudeBetas } from '../src/host/claude/client.ts'
import { buildClaudeRequestBody } from '../src/host/claude/mapper.ts'
import { EXTENDED_CACHE_TTL_BETA, cacheControlFor } from '../src/host/claude/types.ts'
import { buildRequest } from '../src/host/kimi-code/mapper.ts'
import { isKimiCacheTtl } from '../src/host/kimi-code/types.ts'
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

describe('kimi prompt-cache TTL', () => {
  it('sends nothing when no tier is stored', () => {
    // The default request must stay byte-identical to what this line sent
    // before the setting existed: Kimi's own default, no cache field at all.
    for (const wire of ['openai', 'anthropic'] as const) {
      const body = buildRequest(empty, wire, undefined, undefined, { cacheTtl: null })
      expect(body).not.toHaveProperty('prompt_cache_options')
      expect(body).not.toHaveProperty('cache_control')
    }
  })

  it('uses prompt_cache_options on the OpenAI wire', () => {
    const body = buildRequest(empty, 'openai', undefined, undefined, { cacheTtl: '1h' })

    expect(body.prompt_cache_options).toEqual({ mode: 'implicit', ttl: '1h' })
    expect(body).not.toHaveProperty('cache_control')
  })

  it('uses a TOP-LEVEL cache_control on the Anthropic wire', () => {
    // The service documents that a marker inside a message is ignored, so this
    // must be top level — not pushed onto the last system or message block.
    const body = buildRequest(empty, 'anthropic', undefined, undefined, { cacheTtl: '5m' })

    expect(body.cache_control).toEqual({ type: 'ephemeral', ttl: '5m' })
    expect(body).not.toHaveProperty('prompt_cache_options')
  })

  it('refuses a tier the service does not accept', () => {
    expect(isKimiCacheTtl('1h')).toBe(true)
    expect(isKimiCacheTtl('5m')).toBe(true)
    expect(isKimiCacheTtl('24h')).toBe(false)
    expect(isKimiCacheTtl(undefined)).toBe(false)
  })
})