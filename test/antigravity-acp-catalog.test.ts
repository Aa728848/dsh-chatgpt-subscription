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
      ['low', 'medium', 'high'],
    )
    expect(models).toEqual([
      { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', efforts: ['low', 'medium', 'high'] },
    ])
  })

  it('does not invent a ladder for a model whose id already carries its tier', () => {
    const models = collapseModels(
      [{ value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' }],
      [{ modelId: 'gpt-oss-120b-medium' }],
      ['low', 'medium', 'high'],
    )
    expect(models[0]?.efforts).toEqual([])
  })

  it('drops a level the server publishes as a tier but not as an accepted level', () => {
    const models = collapseModels(
      [{ value: 'gemini-4-carbon' }],
      [{ modelId: 'gemini-4-carbon-low' }, { modelId: 'gemini-4-carbon-xhigh' }],
      ['low', 'medium', 'high'],
    )
    expect(models[0]?.efforts).toEqual(['low'])
  })

  it('orders the ladder least to greatest regardless of the server order', () => {
    const models = collapseModels(
      [{ value: 'm' }],
      [{ modelId: 'm-high' }, { modelId: 'm-low' }, { modelId: 'm-medium' }],
      ['low', 'medium', 'high'],
    )
    expect(models[0]?.efforts).toEqual(['low', 'medium', 'high'])
  })
})

describe('toResolvedModelInfo', () => {
  it('declares no context and no reasoning for a model that published neither', () => {
    const info = toResolvedModelInfo('antigravity-acp', { id: 'bare', name: 'Bare', efforts: [] })
    expect(info.context).toBeUndefined()
    expect(info.reasoning).toBeUndefined()
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
