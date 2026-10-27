/**
 * The OpenDesign model resolution and selection rules: precedence across the
 * shipped table, the synced live catalog and the user's overrides, and the
 * cold-start guard that keeps the fallback table unfiltered.
 */
import { describe, expect, it } from 'vitest'
import { isModelServed, resolveModelInfo, resolveOutputBudget } from '../src/host/opendesign/catalog.ts'
import { openDesignKnownModelIds, openDesignVisibleModelIds } from '../src/host/opendesign/line.ts'
import { defaultOpenDesignModelSettings } from '../src/host/opendesign/token-store.ts'
import { DEFAULT_MODELS } from '../src/host/opendesign/types.ts'

describe('resolveModelInfo', () => {
  it('carries the shipped vendor facts: window, output cap, modalities, ladder, price', () => {
    const info = resolveModelInfo('gpt-6-luna', { synced: [] })
    expect(info.displayName).toBe('GPT-6 Luna')
    expect(info.contextWindow).toBe(1_050_000)
    // maxTokens is the ADVERTISED BUDGET (the line default, 64k), clamped by the
    // published ceiling — never the ceiling itself.
    expect(info.maxTokens).toBe(64_000)
    expect(info.pricing).toEqual({ input: 0.1, output: 0.5 })
    expect(info.input).toEqual(['text', 'image'])
    expect(info.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('falls back to the line default window when no source documents one', () => {
    // muse-wonder has no sibling table: the line's default applies rather than
    // an invented window, and the ladder defaults to the trio.
    const info = resolveModelInfo('muse-wonder', { synced: [] })
    expect(info.contextWindow).toBe(128_000)
    expect(info.efforts).toEqual(['low', 'medium', 'high'])
    expect(info.maxTokens).toBe(64_000)
  })

  it('lets the synced live catalog override the shipped facts', () => {
    const info = resolveModelInfo('gpt-6-luna', {
      synced: [{ id: 'gpt-6-luna', contextWindow: 272_000, efforts: ['low', 'high'], input: ['text', 'image'] }],
    })
    expect(info.contextWindow).toBe(272_000)
    expect(info.efforts).toEqual(['low', 'high'])
    expect(info.input).toEqual(['text', 'image'])
    // The shipped name is curated; a listing that says nothing keeps it.
    expect(info.displayName).toBe('GPT-6 Luna')
  })

  it('drops a shipped default when the live ladder no longer offers it', () => {
    const info = resolveModelInfo('deepseek-v4.1-flash', {
      synced: [{ id: 'deepseek-v4.1-flash', efforts: ['none', 'low', 'max'] }],
    })
    expect(info.defaultEffort).toBeUndefined()
  })

  it('adopts a model only the live catalog knows, rather than hiding it', () => {
    const info = resolveModelInfo('brand-new-model', {
      synced: [{ id: 'brand-new-model', name: 'Brand New', contextWindow: 200_000 }],
    })
    expect(info.displayName).toBe('Brand New')
    expect(info.contextWindow).toBe(200_000)
    expect(info.pricing).toBeUndefined()
  })

  it('a row with no ladder keeps the default trio rather than being called a non-reasoner', () => {
    // These three rows shipped as `reasoning: false` on the strength of an empty
    // ladder in the command-code registry. That is a statement about the SOURCE
    // (it publishes no ladder), not about the model: the cline-pass table writes
    // the same family as `reasoning: true` and wins on a conflict, and a missing
    // ladder falls through to the line's default trio.
    for (const id of ['mimo-v2.6-flash', 'mimo-v2.6-pro', 'qwen3.7-max']) {
      const info = resolveModelInfo(id, { synced: [] })
      expect(info.reasoning, id).toBe(true)
      expect(info.efforts, id).toEqual(['low', 'medium', 'high'])
    }
  })

  it('a live listing that declares no reasoning is still honoured', () => {
    // The correction above is about the shipped table's unsupported claim, never
    // about overriding what a listing actually publishes.
    const info = resolveModelInfo('mimo-v2.6-pro', { synced: [{ id: 'mimo-v2.6-pro', reasoning: false }] })
    expect(info.reasoning).toBe(false)
    expect(info.efforts).toEqual([])
  })

  it('every shipped model carries a window, a modality list and a ladder decision', () => {
    // The whole table, not the entries someone happened to try: an id missing
    // here silently reverts to a flat 128k and a generic trio (the trap the
    // command-code registry transcription documents).
    const undocumented = new Set(['minimax-m3.1-flash', 'muse-wonder'])
    for (const id of DEFAULT_MODELS) {
      const info = resolveModelInfo(id, { synced: [] })
      expect(info.input.length).toBeGreaterThan(0)
      if (undocumented.has(id)) {
        expect(info.contextWindow).toBe(128_000)
        continue
      }
      expect(info.contextWindow).toBeGreaterThan(128_000)
    }
  })

  it('the user override beats every published window', () => {
    const info = resolveModelInfo('gpt-6-luna', {
      synced: [{ id: 'gpt-6-luna', contextWindow: 272_000 }],
      contextWindowOverride: 100_000,
    })
    expect(info.contextWindow).toBe(100_000)
  })

  it('never takes the output budget past half the window', () => {
    expect(resolveOutputBudget(64_000, undefined, 128_000)).toBe(64_000)
    expect(resolveOutputBudget(100_000, undefined, 128_000)).toBe(64_000)
    expect(resolveOutputBudget(undefined, 32_000, 128_000)).toBe(32_000)
  })
})

describe('isModelServed', () => {
  it('nothing measured means nothing hidden', () => {
    // `null` is "no scan ever succeeded": the absence of a fact is not a denial,
    // so a fresh install advertises the shipped table instead of an empty picker.
    expect(isModelServed('gpt-6-luna', null)).toBe(true)
    expect(isModelServed('a-model-nobody-listed', null)).toBe(true)
  })

  it('a measurement hides the ids it did not list', () => {
    expect(isModelServed('gpt-6-luna', ['gpt-6-luna', 'kimi-k3'])).toBe(true)
    expect(isModelServed('gpt-6-luna', ['kimi-k3'])).toBe(false)
    // An empty measurement is a measurement: it must not decay into "never synced".
    expect(isModelServed('gpt-6-luna', [])).toBe(false)
  })
})

describe('the visible-model rule', () => {
  it('a cold start with an explicit whitelist still lists the fallback table', () => {
    // The selection is captured against the gateway's wire ids and the shipped
    // table speaks the same vocabulary, so filtering on a cold start cannot
    // empty the picker. A regression here turns every model off after a restart.
    const settings = {
      ...defaultOpenDesignModelSettings(),
      enabledModelIds: ['gpt-6-luna'],
    }
    expect(openDesignVisibleModelIds(settings)).toEqual(['gpt-6-luna'])
  })

  it('unset means every known model, including ones a sync adds later', () => {
    const settings = defaultOpenDesignModelSettings()
    expect(openDesignVisibleModelIds(settings)).toEqual(openDesignKnownModelIds(settings))
    expect(openDesignKnownModelIds(settings).length).toBe(DEFAULT_MODELS.length)
    const synced = { ...settings, catalogModels: [{ id: 'future-model' }] }
    expect(openDesignVisibleModelIds(synced)).toContain('future-model')
  })

  it('an explicit empty selection still wins: nothing is advertised', () => {
    const settings = { ...defaultOpenDesignModelSettings(), enabledModelIds: [] as string[] }
    expect(openDesignVisibleModelIds(settings)).toEqual([])
  })

  it('a model the plan withholds is not advertised, unless it is forced', () => {
    // Both the card's numbers and the picker's own list come from this one function,
    // so the plan layer lives here rather than in the adapter.
    const base = defaultOpenDesignModelSettings()
    expect(openDesignVisibleModelIds(base)).toEqual(openDesignKnownModelIds(base))
    const measured = { ...base, servedModelIds: ['gpt-6-luna'] }
    expect(openDesignVisibleModelIds(measured)).toEqual(['gpt-6-luna'])
    const forced = { ...measured, forceVisibleModels: ['kimi-k3'] }
    expect(openDesignVisibleModelIds(forced)).toEqual(['gpt-6-luna', 'kimi-k3'])
    // The force list cannot rescue an id the hidden list or the tick list vetoed.
    const vetoed = { ...forced, hiddenModels: ['kimi-k3'], enabledModelIds: ['gpt-6-luna'] }
    expect(openDesignVisibleModelIds(vetoed)).toEqual(['gpt-6-luna'])
  })

  it('a hidden model stays out even when selected', () => {
    const settings = { ...defaultOpenDesignModelSettings(), hiddenModels: ['gpt-6-luna'] }
    expect(openDesignVisibleModelIds(settings)).not.toContain('gpt-6-luna')
    expect(openDesignKnownModelIds(settings)).toContain('gpt-6-luna')
  })
})
