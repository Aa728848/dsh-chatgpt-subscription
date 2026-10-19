import { describe, expect, it } from 'vitest'
import {
  buildMinimaxCodeModelOptions,
  contextWindowForModel,
  isMinimaxCodeModelId,
  minimaxCodeModelDef,
  minimaxCodeModelIds,
  minimaxCodeModelName,
  resolveMinimaxCodeEnabledModelIds,
  resolveMinimaxCodeModelId,
} from '../src/host/minimax-code/model-catalog.ts'

/**
 * The retired id and the id that replaced it.
 *
 * MiniMax published `MiniMax-M3.1-Flash` (2026-10-19) and dropped the
 * `-Preview` suffix. The catalog carries the new spelling only, but every
 * stored selection, saved conversation and hand-written route may still name
 * the old one - and a stored selection that names only a model this build no
 * longer lists is DROPPED, which would leave the picker showing nothing.
 */
const RETIRED = 'MiniMax-M3.1-Flash-Preview'
const CURRENT = 'MiniMax-M3.1-Flash'

describe('the MiniMax M3.1 Flash rename', () => {
  it('lists only the current id', () => {
    expect(minimaxCodeModelIds()).toContain(CURRENT)
    expect(minimaxCodeModelIds()).not.toContain(RETIRED)
  })

  it('resolves the retired id to the current one', () => {
    expect(resolveMinimaxCodeModelId(RETIRED)).toBe(CURRENT)
    expect(resolveMinimaxCodeModelId(CURRENT)).toBe(CURRENT)
    // An unknown id resolves to itself: the resolver renames, it does not
    // invent a model.
    expect(resolveMinimaxCodeModelId('MiniMax-M9')).toBe('MiniMax-M9')
  })

  it('gives the retired id the current entry, not a gap', () => {
    const retired = minimaxCodeModelDef(RETIRED)
    const current = minimaxCodeModelDef(CURRENT)
    expect(retired).toBe(current)
    expect(retired?.contextWindow).toBe(1_000_000)
    expect(retired?.thinking).toBe('forced-effort')
    expect(retired?.inputModalities).toContain('image')
    expect(minimaxCodeModelName(RETIRED)).toBe('MiniMax M3.1 Flash')
    expect(isMinimaxCodeModelId(RETIRED)).toBe(true)
  })

  it('keeps a stored selection that names the retired id', () => {
    // The failure this guards: the stored list is filtered against the
    // catalog, and a name the catalog dropped takes the whole selection with
    // it - so a user who had ticked exactly one model would find the picker
    // empty after the upgrade.
    expect(resolveMinimaxCodeEnabledModelIds([RETIRED])).toEqual([CURRENT])
    expect(resolveMinimaxCodeEnabledModelIds([RETIRED, 'MiniMax-M3'])).toEqual([CURRENT, 'MiniMax-M3'])
  })

  it('does not list one model twice when both spellings are stored', () => {
    expect(resolveMinimaxCodeEnabledModelIds([RETIRED, CURRENT])).toEqual([CURRENT])
  })

  it('still honours the untouched-default rule', () => {
    // A stored list equal to the shipped default has never been edited, so it
    // tracks the catalog as the catalog grows.
    const shipped = minimaxCodeModelIds()
    expect(resolveMinimaxCodeEnabledModelIds(shipped)).toEqual(shipped)
    // The same list written with the retired spelling is the same selection.
    const retiredDefault = shipped.map((id) => (id === CURRENT ? RETIRED : id))
    expect(resolveMinimaxCodeEnabledModelIds(retiredDefault)).toEqual(shipped)
  })

  it('drops a name the catalog never served', () => {
    expect(resolveMinimaxCodeEnabledModelIds(['MiniMax-M9'])).toEqual([])
  })

  it('keeps a window override that was stored under the retired id', () => {
    expect(contextWindowForModel(CURRENT, { [RETIRED]: 200_000 })).toBe(200_000)
    expect(contextWindowForModel(CURRENT, { [CURRENT]: 300_000 })).toBe(300_000)
    expect(contextWindowForModel(CURRENT, {})).toBe(1_000_000)
  })

  it('renders the settings card with the current id enabled', () => {
    const rows = buildMinimaxCodeModelOptions([RETIRED], {})
    const row = rows.find((entry) => entry.id === CURRENT)
    expect(row?.enabled).toBe(true)
    expect(rows.some((entry) => entry.id === RETIRED)).toBe(false)
  })
})
