import { describe, expect, it } from 'vitest'
import { buildAttempts, injectPrefs } from '../src/host/cline-pass/protocol.ts'
import { parseClinePassModelSettings } from '../src/host/cline-pass/token-store.ts'
import { defaultPin } from '../src/host/cline-pass/types.ts'

const MODEL = 'cline-pass/deepseek-v4.1-flash-1017'
const HAS = ['vision', 'implicit-caching']

describe('Cline Pass gateway capability filters', () => {
  it('writes has only to the Vercel gateway spelling and preserves it through attempts', () => {
    const [attempt] = buildAttempts({ upstreams: ['deepseek'], pinMode: 'strict', has: HAS })
    expect(attempt?.has).toEqual(HAS)
    const body = injectPrefs({ model: MODEL }, { pipeline: 'planner' }, attempt)
    expect(body.providerOptions).toEqual({ gateway: { only: ['deepseek'], has: HAS } })
    expect(body.provider).toEqual({ only: ['deepseek'] })
    expect(body.provider).not.toHaveProperty('has')
  })

  it('can send a capability filter without pinning a provider', () => {
    const body = injectPrefs({ model: MODEL }, {}, {
      upstream: null, orderRest: [], excludeList: [], strict: true, sort: null, has: HAS,
    })
    expect(body.providerOptions).toEqual({ gateway: { has: HAS } })
    expect(body.provider).toBeUndefined()
  })

  it('does not add has to models that have no filter configured', () => {
    const body = injectPrefs({ model: 'cline-pass/glm-5.3' }, {}, {
      upstream: 'deepseek', orderRest: [], excludeList: [], strict: true, sort: null,
    })
    expect(body.providerOptions).toEqual({ gateway: { only: ['deepseek'] } })
  })

  it('inherits the measured 1017 filter for legacy pins but respects an explicit clear', () => {
    const legacy = parseClinePassModelSettings({ pins: { [MODEL]: { upstreams: ['deepseek'], exclude: [], pinMode: 'strict', sort: '' } } })
    expect(legacy.pins[MODEL]?.has).toEqual(HAS)
    const cleared = parseClinePassModelSettings({ pins: { [MODEL]: { upstreams: ['deepseek'], has: [] } } })
    expect(cleared.pins[MODEL]?.has).toEqual([])
    const other = parseClinePassModelSettings({ pins: { 'cline-pass/glm-5.3': { upstreams: ['deepseek'] } } })
    expect(other.pins['cline-pass/glm-5.3']?.has).toEqual([])
  })

  it('scopes the default filter to the measured model only', () => {
    expect(defaultPin(MODEL).has).toEqual(HAS)
    expect(defaultPin('cline-pass/glm-5.3').has).toEqual([])
    expect(defaultPin().has).toEqual([])
  })

  it('bounds a stored filter list so it cannot become request payload on every turn', () => {
    // `has` is copied into every chat request body. Channels were already capped
    // this way; an uncapped capability list made a large settings document a
    // large request forever.
    const many = Array.from({ length: 40 }, (_, index) => `capability-${index}`)
    const parsed = parseClinePassModelSettings({ pins: { [MODEL]: { upstreams: ['deepseek'], has: many } } })
    expect(parsed.pins[MODEL]?.has).toHaveLength(16)
    expect(parsed.pins[MODEL]?.has[0]).toBe('capability-0')
    const long = parseClinePassModelSettings({ pins: { [MODEL]: { upstreams: [], has: ['x'.repeat(200), 'vision'] } } })
    expect(long.pins[MODEL]?.has).toEqual(['vision'])
  })

  it('bounds the filter again on the wire, whatever the caller passes', () => {
    const many = Array.from({ length: 40 }, (_, index) => `capability-${index}`)
    const body = injectPrefs({ model: MODEL }, {}, {
      upstream: null, orderRest: [], excludeList: [], strict: true, sort: null, has: many,
    })
    expect((body.providerOptions as { gateway: { has: string[] } }).gateway.has).toHaveLength(16)
  })
})
