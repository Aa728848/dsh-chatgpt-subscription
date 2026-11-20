/**
 * Model-catalogue shaping: the server publishes the same models twice, in two
 * different id vocabularies, and this is the one place the two are reconciled.
 */
import { describe, expect, it } from 'vitest'
import { collapseModels, findModel, toResolvedModelInfo } from '../src/host/antigravity-acp/types.ts'

describe('collapseModels', () => {
  it('collapses tier ids into one model each and keeps the published ladder', () => {
    const models = collapseModels(
      [{ value: 'gemini-4-carbon', name: 'Gemini 4 Carbon' }],
      [
        { modelId: 'gemini-4-carbon-low' },
        { modelId: 'gemini-4-carbon-medium' },
        { modelId: 'gemini-4-carbon-high' },
      ],
    )
    expect(models).toEqual([
      { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', efforts: ['low', 'medium', 'high'] },
    ])
  })

  it('does not invent a ladder for a model whose id already carries its tier', () => {
    const models = collapseModels(
      [{ value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' }],
      [{ modelId: 'gpt-oss-120b-medium' }],
    )
    expect(models[0]?.efforts).toEqual([])
  })

  it('keeps a level the model publishes as a tier even when another model omits it', () => {
    // The thought_level option describes the selected model only; Hydrogen's
    // fourth level must survive next to Argon's three-level option list.
    const models = collapseModels(
      [{ value: 'gemini-4-hydrogen' }],
      [
        { modelId: 'gemini-4-hydrogen-low' },
        { modelId: 'gemini-4-hydrogen-medium' },
        { modelId: 'gemini-4-hydrogen-high' },
        { modelId: 'gemini-4-hydrogen-xhigh' },
      ],
    )
    expect(models[0]?.efforts).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('orders the ladder least to greatest regardless of the server order', () => {
    const models = collapseModels(
      [{ value: 'm' }],
      [{ modelId: 'm-high' }, { modelId: 'm-low' }, { modelId: 'm-medium' }],
    )
    expect(models[0]?.efforts).toEqual(['low', 'medium', 'high'])
  })

  it('carries a window the server published on a tier id up to the collapsed model', () => {
    const models = collapseModels(
      [{ value: 'gemini-4-carbon' }],
      [
        { modelId: 'gemini-4-carbon-low', contextWindow: 524_288 },
        { modelId: 'gemini-4-carbon-high', contextWindow: 524_288 },
      ],
    )
    expect(models[0]?.contextWindow).toBe(524_288)
  })
})

describe('toResolvedModelInfo', () => {
  it('declares the shipped window for a model the server did not price', () => {
    // DSH charges a route with no declared window as broken: model switches into
    // the line throw MODEL_SWITCH_COMPACTION_FAILED before the first token. Every
    // model therefore carries a window even when the ACP handshake published none.
    const info = toResolvedModelInfo('antigravity-acp', { id: 'gemini-4-argon', name: 'Gemini 4 Argon', efforts: [] })
    expect(info.context).toEqual({ contextWindow: 1_048_576 })
    expect(info.reasoning).toBeUndefined()
  })

  it('declares a conservative fallback for an id the shipped table does not know', () => {
    const info = toResolvedModelInfo('antigravity-acp', { id: 'acme-1', name: 'Acme 1', efforts: [] })
    expect(info.context).toEqual({ contextWindow: 131_072 })
  })

  it('uses the shipped table per family', () => {
    const windows = ['gemini-3.1-flash-image', 'gemini-4-hydrogen', 'gemini-3.8-flash', 'gpt-oss-120b-medium', 'claude-sonnet-4-6']
      .map((id) => toResolvedModelInfo('antigravity-acp', { id, name: id, efforts: [] }).context?.contextWindow)
    expect(windows).toEqual([65_536, 1_048_576, 1_048_576, 131_072, 250_000])
  })

  it('prefers a window the catalogue row carries', () => {
    const info = toResolvedModelInfo('antigravity-acp', { id: 'gemini-4-argon', name: 'Gemini 4 Argon', efforts: [], contextWindow: 524_288 })
    expect(info.context).toEqual({ contextWindow: 524_288 })
  })

  it('prefers the window a live turn observed over both other sources', () => {
    const info = toResolvedModelInfo(
      'antigravity-acp',
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon', efforts: [], contextWindow: 524_288 },
      262_144,
    )
    expect(info.context).toEqual({ contextWindow: 262_144 })
  })

  it('declares exactly the published ladder', () => {
    const info = toResolvedModelInfo('antigravity-acp', { id: 'm', name: 'M', efforts: ['low', 'high'] })
    expect(info.reasoning?.efforts.map((effort) => effort.id)).toEqual(['low', 'high'])
    expect(info.reasoning?.defaultEffort).toBe('low')
  })
})

describe('findModel', () => {
  it('resolves an unlisted id without guessing a ladder', () => {
    expect(findModel([{ id: 'a', name: 'A', efforts: ['low'] }], 'unlisted')).toEqual({
      id: 'unlisted',
      name: 'unlisted',
      efforts: [],
    })
  })
})
