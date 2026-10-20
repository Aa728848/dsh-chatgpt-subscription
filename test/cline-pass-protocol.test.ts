import { describe, expect, it } from 'vitest'
import {
  buildAttempts,
  channelNameFor,
  classifyUpstreamError,
  extractAvailableProviders,
  injectPrefs,
  isAdherenceOk,
  normalizePinMode,
  normalizeSort,
  parseRouting,
  parseTier0,
  pinAdherence,
  pinWarnings,
} from '../src/host/cline-pass/protocol.ts'
import { normalizeRotationStrategy } from '../src/host/common/account-pool.ts'

describe('Cline Pass pin expansion', () => {
  it('turns a strict pin list into one attempt per channel', () => {
    expect(buildAttempts({ upstreams: ['baseten', 'deepseek'], pinMode: 'strict' })).toEqual([
      { upstream: 'baseten', orderRest: [], excludeList: [], strict: true, sort: null },
      { upstream: 'deepseek', orderRest: [], excludeList: [], strict: true, sort: null },
    ])
  })

  it('keeps the remaining candidates as the preferred-mode fallback order', () => {
    const attempts = buildAttempts({ upstreams: ['baseten', 'deepseek'], pinMode: 'preferred', sort: 'cost' })
    expect(attempts[0]).toMatchObject({ upstream: 'baseten', orderRest: ['deepseek'], strict: false, sort: 'cost' })
    expect(attempts[1]).toMatchObject({ upstream: 'deepseek', orderRest: ['baseten'], strict: false, sort: 'cost' })
  })

  it('drops an excluded channel from the pin list and keeps it as an exclusion', () => {
    expect(buildAttempts({ upstreams: ['baseten', 'deepseek'], exclude: ['deepseek'] })).toEqual([
      { upstream: 'baseten', orderRest: [], excludeList: ['deepseek'], strict: true, sort: null },
    ])
  })

  it('falls back to a single automatic attempt when nothing is pinned', () => {
    expect(buildAttempts({ exclude: ['deepseek'] })).toEqual([
      { upstream: null, orderRest: [], excludeList: ['deepseek'], strict: true, sort: null },
    ])
  })

  it('normalizes the two spellings of "no sort" and "strict " before comparing', () => {
    expect(normalizeSort('none')).toBeNull()
    expect(normalizeSort('  ')).toBeNull()
    expect(normalizeSort(' ttft ')).toBe('ttft')
    expect(normalizePinMode(' Preferred ')).toBe('preferred')
    expect(normalizePinMode('strict ')).toBe('strict')
  })
})

describe('Cline Pass pin injection', () => {
  it('writes the OpenRouter spelling for the direct pipeline', () => {
    const body = injectPrefs({ model: 'm' }, { pipeline: 'direct', upstreams: ['baseten'] }, {
      upstream: 'baseten', orderRest: [], excludeList: [], strict: true, sort: 'cost', spelling: 'detected',
    })
    expect(body.provider).toEqual({ only: ['baseten'], sort: 'price' })
    expect(body.providerOptions).toBeUndefined()
  })

  it('writes the gateway spelling for the planner pipeline', () => {
    const body = injectPrefs({ model: 'm' }, { pipeline: 'planner', upstreams: ['baseten'] }, {
      upstream: 'baseten', orderRest: [], excludeList: [], strict: true, sort: 'ttft', spelling: 'detected',
    })
    expect(body.providerOptions).toEqual({ gateway: { only: ['baseten'], sort: 'ttft' } })
  })

  it('writes BOTH spellings by default, because the pipeline can change between calls', () => {
    const body = injectPrefs({ model: 'm' }, { pipeline: 'direct', upstreams: ['baseten'] }, {
      upstream: 'baseten', orderRest: [], excludeList: [], strict: true, sort: null,
    })
    expect(body.provider).toEqual({ only: ['baseten'] })
    expect(body.providerOptions).toEqual({ gateway: { only: ['baseten'] } })
  })

  it('writes only the detected spelling when asked to', () => {
    const body = injectPrefs({ model: 'm' }, { pipeline: 'direct', upstreams: ['baseten'] }, {
      upstream: 'baseten', orderRest: [], excludeList: [], strict: true, sort: null, spelling: 'detected',
    })
    expect(body.provider).toEqual({ only: ['baseten'] })
    expect(body.providerOptions).toBeUndefined()
  })

  it('translates a channel name into each router vocabulary', () => {
    expect(channelNameFor('zai', 'direct')).toBe('z-ai')
    expect(channelNameFor('z-ai', 'planner')).toBe('zai')
    expect(channelNameFor('baseten', 'direct')).toBe('baseten')
  })

  it('compiles exclusions into an allow-list in each spelling, and OpenRouter ignore', () => {
    const meta = { pipeline: 'direct' as const, upstreams: ['baseten', 'deepseek', 'together'], channels: { direct: ['baseten', 'deepseek', 'together'], planner: ['baseten', 'deepseek', 'together'] } }
    const body = injectPrefs({ model: 'm' }, meta, {
      upstream: null, orderRest: [], excludeList: ['deepseek'], strict: true, sort: null,
    })
    expect(body.provider).toEqual({ only: ['baseten', 'together'], ignore: ['deepseek'] })
    expect(body.providerOptions).toEqual({ gateway: { only: ['baseten', 'together'] } })
  })

  it('does nothing when there is no pin, no sort and no exclusion', () => {
    expect(injectPrefs({ model: 'm' }, { upstreams: [] }, {
      upstream: null, orderRest: [], excludeList: [], strict: true, sort: null,
    })).toEqual({ model: 'm' })
  })
})

describe('Cline Pass pin adherence', () => {
  const attempt = { upstream: 'baseten', orderRest: ['deepseek'], excludeList: [], strict: false, sort: null }

  it('reads the serving channel out of a response', () => {
    const routing = parseRouting({
      provider: 'Baseten',
      choices: [{ message: { content: 'ok' } }],
      model: 'zai/glm-5.3',
    })
    expect(routing.pipeline).toBe('direct')
    expect(routing.finalProvider).toBe('baseten')
    expect(routing.canonicalSlug).toBe('zai/glm-5.3')
    expect(pinAdherence(attempt, routing)).toBe('adopted')
  })

  it('reads the planner routing envelope', () => {
    const routing = parseRouting({
      choices: [{ message: { provider_metadata: { gateway: { routing: {
        finalProvider: 'baseten', canonicalSlug: 'zai/glm-5.3', fallbacksAvailable: ['deepseek'], planningReasoning: 'baseten won tier 0 over deepseek',
      } } } } }],
    })
    expect(routing.pipeline).toBe('planner')
    expect(routing.fallbacks).toEqual(['deepseek'])
    expect(parseTier0(routing.plan)).toEqual(['baseten', 'deepseek'])
    expect(pinAdherence(attempt, routing)).toBe('adopted')
  })

  it('calls an excluded channel serving the request a violation', () => {
    expect(pinAdherence({ ...attempt, excludeList: ['deepseek'] }, { finalProvider: 'deepseek' })).toBe('violated')
  })

  it('distinguishes a fallback from a silent refusal', () => {
    expect(pinAdherence(attempt, { finalProvider: 'deepseek' })).toBe('fallback')
    expect(pinAdherence({ ...attempt, orderRest: [] }, { finalProvider: 'deepseek' })).toBe('not-adopted')
    expect(pinAdherence(attempt, { finalProvider: null })).toBe('unresolved')
    expect(isAdherenceOk('fallback')).toBe(true)
    expect(isAdherenceOk('violated')).toBe(false)
  })

  it('warns when an exclusion cannot be expressed', () => {
    expect(pinWarnings({ upstream: null, excludeList: ['deepseek'] }, { upstreams: [] })[0]).toContain('excludeUnresolved')
    expect(pinWarnings({ upstream: null, excludeList: ['a', 'b'] }, { upstreams: ['a', 'b'] })[0]).toContain('every known channel')
    expect(pinWarnings({ upstream: 'a', excludeList: [] }, { upstreams: [] })).toEqual([])
  })
})

describe('Cline Pass channel recovery', () => {
  it('parses OpenRouter\'s available-provider refusal', () => {
    const text = 'No allowed providers. {"error":{"metadata":{"available_providers":["baseten","deepseek"]}}}'
    expect(extractAvailableProviders(text, 'direct')).toEqual(['baseten', 'deepseek'])
  })

  it('parses the planner sentence', () => {
    expect(extractAvailableProviders('Available providers are: baseten, deepseek.', 'planner')).toEqual(['baseten', 'deepseek'])
  })

  it('classifies a refusal into one availability verdict', () => {
    expect(classifyUpstreamError('429 rate limited')).toBe('limited')
    expect(classifyUpstreamError('invalid_request: unknown model')).toBe('bad')
    expect(classifyUpstreamError('invalid api key')).toBe('auth')
    expect(classifyUpstreamError('something odd')).toBe('unknown')
    expect(classifyUpstreamError('empty response content')).toBe('ok')
  })
})

describe('rotation strategy compatibility', () => {
  it('keeps the pool strategies and rejects an unknown one', () => {
    expect(normalizeRotationStrategy('round-robin')).toBe('round-robin')
    expect(normalizeRotationStrategy('sticky')).toBe('sticky')
    expect(normalizeRotationStrategy('nonsense')).toBe('sequential')
  })
})
