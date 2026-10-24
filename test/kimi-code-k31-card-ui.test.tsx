// @vitest-environment jsdom
/**
 * The K3.1 Pro card: what the settings page offers when a model always thinks,
 * and what it says about cache writes.
 *
 * Two claims are pinned here because each one is a place where the card could
 * look fine and still be wrong:
 *
 * - "thinking off" must not be offered for a model the service answers with
 *   HTTP 400, and the reason has to be on the card rather than left to the
 *   missing option;
 * - a cache-write count of zero must print as 0, because a blank cell would read
 *   as "nothing was measured".
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KimiCodeModelOption, KimiCodeWebStatus } from '../src/shared/kimi-code-contracts.ts'
import { KimiCodeSection } from '../src/client/kimi-code/KimiCodeSection.tsx'
import { zh } from '../src/client/kimi-code/locales.ts'

function model(overrides: Partial<KimiCodeModelOption> = {}): KimiCodeModelOption {
  return {
    id: 'k3',
    name: 'K3',
    enabled: true,
    defaultContextWindow: 262_144,
    contextWindow: 262_144,
    promptBudget: 262_144,
    defaultMaxTokens: 32_768,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    wire: 'openai',
    description: 'Flagship model',
    supportsVideo: true,
    supportsDynamicTools: true,
    supportsToolUse: true,
    minimumPlan: 'Moderato',
    quotaMultiplier: 2,
    ...overrides,
  }
}

/** The K3.1 Pro pair as the host reports it: thinking always on, video declared. */
const K31_PRO = model({
  id: 'k3.1-pro',
  name: 'K3.1 Pro',
  thinkingType: 'only',
  defaultReasoningEffort: 'max',
  // Same chat-completions wire as every other model on this line.
  wire: 'openai',
  supportsVideo: true,
  quotaMultiplier: null,
})

const K31_HIGHSPEED = model({
  id: 'k3.1-pro-highspeed',
  name: 'K3.1 Pro Highspeed',
  thinkingType: 'only',
  defaultReasoningEffort: 'max',
  wire: 'openai',
  supportsVideo: true,
  defaultContextWindow: 1_048_576,
  contextWindow: 1_048_576,
  promptBudget: 1_048_576,
  quotaMultiplier: null,
})

function status(overrides: Partial<KimiCodeWebStatus> = {}): KimiCodeWebStatus {
  return {
    enabled: true,
    authenticated: true,
    hasCredentials: true,
    storagePath: '/tmp/kimi-code.json',
    region: 'mainland-cn',
    oauthHost: 'https://auth.kimi.com',
    codingBaseUrl: 'https://api.kimi.com/coding',
    account: null,
    quota: null,
    lastFetchedAt: null,
    quotaError: null,
    credentialsRejected: false,
    cache: null,
    preserveThinking: false,
    models: [K31_PRO, K31_HIGHSPEED],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
    accounts: [],
    activeAccountId: undefined,
    rotationStrategy: 'sequential',
    loginRegion: 'mainland-cn',
    serving: true,
    conflict: null,
    ...overrides,
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null
let realFetch: typeof fetch | undefined

async function mount(payload: KimiCodeWebStatus): Promise<HTMLDivElement> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  realFetch ??= globalThis.fetch
  globalThis.fetch = vi.fn(async () => Response.json({ ok: true, value: payload })) as unknown as typeof fetch
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(KimiCodeSection, {})))
  return container
}

beforeEach(() => {
  vi.stubGlobal('open', vi.fn())
})

afterEach(async () => {
  if (root !== null) await act(async () => root!.unmount())
  root = null
  container?.remove()
  container = null
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined
  if (realFetch !== undefined) globalThis.fetch = realFetch
  realFetch = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** The effort menu, found by its aria-label rather than by position. */
function effortSelect(node: HTMLElement): HTMLSelectElement {
  const select = node.querySelector<HTMLSelectElement>(`select[aria-label="${zh.defaultReasoningEffort}"]`)
  if (select === null) throw new Error('effort select missing')
  return select
}

function optionTexts(select: HTMLSelectElement): string[] {
  return [...select.options].map((option) => option.textContent ?? '')
}

describe('kimi-code K3.1 Pro card', () => {
  it('does not offer "thinking off" when every checked model thinks always', async () => {
    const node = await mount(status())
    const texts = optionTexts(effortSelect(node))
    expect(texts).not.toContain(zh.effortNone)
    // The remaining levels are the ones the models declare, not a fixed ladder.
    expect(texts).toEqual(expect.arrayContaining([zh.effortLow, zh.effortHigh, zh.effortMax, zh.defaultEffortAuto]))
  })

  it('explains on the card why thinking off is missing, naming the models', async () => {
    const node = await mount(status())
    const note = zh.effortThinkingOnlyNote
      .replace('{models}', 'K3.1 Pro · K3.1 Pro Highspeed')
    expect(node.textContent).toContain(note)
    // The reason is the service's own answer, and the card states it.
    expect(note).toContain('400')
  })

  it('keeps offering thinking off while a checked model accepts it', async () => {
    const node = await mount(status({ models: [model(), K31_PRO] }))
    expect(optionTexts(effortSelect(node))).toContain(zh.effortNone)
    // The note still names the thinking-only model that IS checked — the switch
    // is offered because another checked model accepts it, not because the
    // restriction went away.
    expect(node.textContent).toContain(zh.effortThinkingOnlyNote.replace('{models}', 'K3.1 Pro'))
  })

  it('keeps a saved level no checked model accepts visible and flagged', async () => {
    const node = await mount(status({ defaultReasoningEffort: 'none' }))
    const select = effortSelect(node)
    // The stored value still exists; an option that vanished would leave the
    // select rendering blank instead of showing what is stored.
    expect(select.value).toBe('none')
    expect(optionTexts(select)).toContain(`${zh.effortNone} · ${zh.effortNotOffered}`)
  })

  it('labels K3.1 Pro with the same wire as every other model, and marks it thinking-only', async () => {
    const node = await mount(status({ models: [model(), K31_PRO] }))
    const rows = [...node.querySelectorAll<HTMLElement>('.dsh-mcl-option')]
    const pro = rows.find((row) => row.querySelector('.dsh-mcl-name')?.textContent === 'K3.1 Pro')
    const k3 = rows.find((row) => row.querySelector('.dsh-mcl-name')?.textContent === 'K3')
    // One protocol for the whole line: the checklist says the same thing for both.
    expect(pro?.querySelector('.dsh-mcl-hint')?.textContent).toContain(zh.wireOpenai)
    expect(k3?.querySelector('.dsh-mcl-hint')?.textContent).toContain(zh.wireOpenai)
    expect(pro?.querySelector('.dsh-mcl-hint')?.textContent).toContain(zh.capThinkingOnly)
    // ...and the declared video input is reported, not withheld.
    expect(pro?.querySelector('.dsh-mcl-hint')?.textContent).toContain(zh.capVideo)
  })

  it('states the unpublished quota multiplier for both rows instead of a blank', async () => {
    const node = await mount(status())
    // The official table publishes no multiplier for these two ids, so none is
    // invented — but the cost line is the one fact compared down that column,
    // and a missing line read as an omission rather than as an absence.
    const costs = [...node.querySelectorAll<HTMLElement>('.dsha-cap-notes')]
      .map((cell) => cell.querySelector('.dsha-cap-off')?.textContent)
    expect(costs).toEqual([
      `${zh.quotaCost} ${zh.quotaUnknown}`,
      `${zh.quotaCost} ${zh.quotaUnknown}`,
    ])
  })

  it('draws the cache write row with its tier split, zero included', async () => {
    const node = await mount(status({
      cache: {
        requests: 4,
        cachedTokens: 1_000,
        freshTokens: 250,
        outputTokens: 90,
        hitRatio: 0.8,
        cacheWriteTokens: 1_200,
        cacheWrite5mTokens: 1_200,
        cacheWrite1hTokens: 0,
      },
    }))
    const rows = [...node.querySelectorAll<HTMLElement>('.dsha-row')]
    const writeRow = rows.find((row) => row.querySelector('.dsha-label')?.textContent === zh.cacheWrite)
    expect(writeRow).toBeDefined()
    // A reported zero is a reading, so it prints as 0 — never as a blank cell
    // and never as the "暂无" used for a number this build cannot read.
    expect(writeRow!.querySelector('.dsha-value')?.textContent)
      .toBe(`${(1_200).toLocaleString()} · ${zh.cacheWrite5m} ${(1_200).toLocaleString()} · ${zh.cacheWrite1h} 0`)
    expect(node.textContent).toContain(zh.cacheWriteHint)
  })

  it('still shows the write row when nothing was written', async () => {
    const node = await mount(status({
      cache: {
        requests: 2,
        cachedTokens: 10,
        freshTokens: 5,
        outputTokens: 5,
        hitRatio: 10 / 15,
        cacheWriteTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
      },
    }))
    const rows = [...node.querySelectorAll<HTMLElement>('.dsha-row')]
    const writeRow = rows.find((row) => row.querySelector('.dsha-label')?.textContent === zh.cacheWrite)
    expect(writeRow!.querySelector('.dsha-value')?.textContent)
      .toBe(`0 · ${zh.cacheWrite5m} 0 · ${zh.cacheWrite1h} 0`)
  })
})