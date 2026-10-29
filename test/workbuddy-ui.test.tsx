// @vitest-environment jsdom
/**
 * The WorkBuddy card's pure helpers, and the composer badge's number picker.
 *
 * These are the rules that are cheapest to break invisibly: a capacity draft
 * parsed differently, a UIN printed in full, a rate borrowed from the other
 * region, or a quota reading that cannot tell "nothing left" from "nothing
 * known". `selectBadgeFacts` is pinned on all four of its outcomes.
 */
import { describe, expect, it } from 'vitest'
import { selectBadgeFacts } from '../src/client/workbuddy/WorkBuddyComposerQuota.tsx'
import { formatCapacity, parsePositiveCapacity } from '../src/client/common/format.ts'
import { creditMultiplierHint, maskUin } from '../src/client/workbuddy/WorkBuddySection.tsx'
import { en, zh } from '../src/client/workbuddy/locales.ts'
import {
  reasoningEffortChoices,
  unsupportedReasoningEffort,
} from '../src/client/workbuddy/useWorkBuddySection.ts'
import type { WorkBuddyModelOption } from '../src/shared/workbuddy-contracts.ts'
import type { WorkBuddyWebStatus } from '../src/shared/workbuddy-contracts.ts'

import { convergeWorkBuddyEffort } from '../src/shared/workbuddy-contracts.ts'

function statusWith(quota: WorkBuddyWebStatus['quota']): WorkBuddyWebStatus {
  return {
    authenticated: true,
    hasCredentials: true,
    authDirectory: '/tmp/auth',
    storagePath: '/tmp/models.json',
    managedStoragePath: '/tmp/accounts.dpapi',
    account: null,
    quota,
    lastFetchedAt: null,
    models: [],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
    selectedAccountId: null,
    serving: true,
    conflict: null,
  }
}

const account = {
  id: 'cn:u1',
  uid: 'u1', nickname: 'tester', uin: '100000000001', accountType: 'personal',
  enterpriseId: null, region: 'cn' as const, backend: 'https://copilot.tencent.com',
  domain: 'copilot.tencent.com', expiresAt: null, sourceFile: '/tmp/a.info',
  source: 'desktop' as const, removable: false, hidden: false,
}

/** One catalog row with only the fields the effort helpers read. */
function model(overrides: Partial<WorkBuddyModelOption> & { id: string; name: string }): WorkBuddyModelOption {
  return {
    enabled: true,
    defaultContextWindow: 128_000,
    contextWindow: 128_000,
    defaultMaxTokens: 32_768,
    supportsImage: false,
    regions: ['cn'],
    ...overrides,
  } as WorkBuddyModelOption
}

/** A one-meter quota snapshot, so a case states only the number it is about. */
function meterStatus(remaining: number | null, extra: { remainingCredits?: number | null } = {}) {
  return statusWith({
    account,
    packageName: 'Free',
    totalCredits: null,
    remainingCredits: extra.remainingCredits ?? null,
    cycleUsedCredits: null,
    cycleCredits: null,
    cycleStartsAt: null,
    cycleEndsAt: null,
    meters: remaining === null
      ? []
      : [{
        id: 'cycle', label: 'Billing cycle', usedFraction: 1 - remaining,
        remainingFraction: remaining, used: null, limit: null, resetsAt: null, description: null,
      }],
    fetchedAt: Date.now(),
    sources: [],
  })
}

describe('WorkBuddy settings card helpers', () => {
  it('parses a context capacity draft', () => {
    expect(parsePositiveCapacity('1M')).toBe(1_000_000)
    expect(parsePositiveCapacity('512K')).toBe(512_000)
    expect(parsePositiveCapacity('300,000')).toBe(300_000)
    expect(parsePositiveCapacity('')).toBeNull()
    expect(parsePositiveCapacity('abc')).toBeNull()
    expect(parsePositiveCapacity('0')).toBeNull()
  })

  it('formats a capacity back into a readable draft', () => {
    expect(formatCapacity(1_000_000)).toBe('1M')
    expect(formatCapacity(300_000)).toBe('300K')
    expect(formatCapacity(48_000)).toBe('48K')
    expect(formatCapacity(1234)).toBe('1234')
  })

  it('masks a UIN so the card shows identity without publishing the number', () => {
    expect(maskUin('100000000001')).toBe('1000****01')
    expect(maskUin('12345')).toBe('12345')
    expect(maskUin(null)).toBe('—')
    expect(maskUin('')).toBe('—')
  })

  it('offers only the reasoning levels the account models declare', () => {
    const choices = reasoningEffortChoices([
      model({ id: 'a', name: 'Alpha', reasoningEfforts: ['low', 'high'] }),
      model({ id: 'b', name: 'Beta', reasoningEfforts: ['high', 'max'] }),
    ])
    // Union, in escalating order, never the shipped enum verbatim.
    expect(choices.map((choice) => choice.value)).toEqual(['low', 'high', 'max'])
    expect(choices.map((choice) => choice.models)).toEqual([['Alpha'], ['Alpha', 'Beta'], ['Beta']])
  })

  it('offers nothing when no model declares a reasoning level', () => {
    // A text-only account must not be shown levels that do nothing.
    expect(reasoningEffortChoices([
      model({ id: 'a', name: 'Alpha', reasoningEfforts: [] }),
      model({ id: 'b', name: 'Beta' }),
    ])).toEqual([])
  })

  it('converges an off-ladder level onto the nearest rung the model exposes', () => {
    // The gateway names defaults from a wider vocabulary than the ladder it
    // publishes, so `medium` has to land on a level the request can carry.
    // Ties resolve upward, matching the sibling Kimi line's documented mapping.
    const ladder = ['low', 'high', 'max']
    expect(convergeWorkBuddyEffort('medium', ladder)).toBe('high')
    expect(convergeWorkBuddyEffort('minimal', ladder)).toBe('low')
    expect(convergeWorkBuddyEffort('xhigh', ladder)).toBe('max')
    expect(convergeWorkBuddyEffort('high', ladder)).toBe('high')
    // A narrow ladder has only itself to offer, and a text-only model has none.
    expect(convergeWorkBuddyEffort('medium', ['high'])).toBe('high')
    expect(convergeWorkBuddyEffort('medium', ['low'])).toBe('low')
    expect(convergeWorkBuddyEffort('medium', [])).toBeNull()
  })

  it('flags a saved default that no current model supports', () => {
    const models = [model({ id: 'a', name: 'Alpha', reasoningEfforts: ['low'] })]
    expect(unsupportedReasoningEffort('max', models)).toBe('max')
    expect(unsupportedReasoningEffort('low', models)).toBeNull()
    // Automatic selection is always valid: the adapter resolves it per model.
    expect(unsupportedReasoningEffort(null, models)).toBeNull()
    expect(unsupportedReasoningEffort(undefined, models)).toBeNull()
  })
})

describe('WorkBuddy composer badge', () => {
  it('prefers the billing-cycle meter, which is the one that resets', () => {
    const facts = selectBadgeFacts(statusWith({
      account,
      packageName: 'Free',
      totalCredits: 490,
      remainingCredits: 483,
      cycleUsedCredits: 6,
      cycleCredits: 490,
      cycleStartsAt: null,
      cycleEndsAt: null,
      meters: [
        { id: 'cycle', label: 'Billing cycle', usedFraction: 0.012, remainingFraction: 0.988, used: '6', limit: '490', resetsAt: null, description: null },
        { id: 'package', label: 'Free', usedFraction: 0.014, remainingFraction: 0.986, used: '7', limit: '490', resetsAt: null, description: null },
      ],
      fetchedAt: Date.now(),
      sources: ['billing'],
    }))
    expect(facts?.text).toBe('99%')
    expect(facts?.level).toBe('normal')
    expect(facts?.tooltip).toContain('Billing cycle')
    // The share travels with the number: it is what the badge draws its bar
    // from, and it is the remaining share rather than the consumed one.
    expect(facts?.percent).toBe(99)
  })

  it('escalates the badge level as the allowance runs down', () => {
    expect(selectBadgeFacts(meterStatus(0.15))?.level).toBe('warning')
    expect(selectBadgeFacts(meterStatus(0.02))?.level).toBe('danger')
  })

  it('reports a reported zero as a measurement, not as an unknown', () => {
    // A share of exactly 0 is the one case where "0%" and "no data" look alike
    // in the badge's text slot; they are different statements and the tooltip
    // and the bar have to keep them apart.
    const facts = selectBadgeFacts(meterStatus(0))
    expect(facts?.text).toBe('0%')
    expect(facts?.level).toBe('danger')
    expect(facts?.percent).toBe(0)
    expect(facts?.tooltip).toContain('0% left')
    expect(facts?.tooltip).not.toContain('unavailable')
  })

  it('carries no bar for a reading that states no share', () => {
    const facts = selectBadgeFacts(meterStatus(null, { remainingCredits: 483 }))
    expect(facts?.text).toBe('483')
    // A bar filled from a guess is worse than no bar at all.
    expect(facts?.percent).toBeUndefined()
  })

  it('reports an unavailable badge rather than a fabricated zero', () => {
    for (const facts of [selectBadgeFacts(null), selectBadgeFacts(statusWith(null))]) {
      expect(facts?.text).toBe('—')
      expect(facts?.percent).toBeUndefined()
      expect(facts?.tooltip).toContain('unavailable')
    }
    // A snapshot whose every number is null is the same statement: nothing was
    // read, which is not "nothing is left".
    const empty = selectBadgeFacts(statusWith({
      account, packageName: null, totalCredits: null, remainingCredits: null,
      cycleUsedCredits: null, cycleCredits: null, cycleStartsAt: null, cycleEndsAt: null,
      meters: [], fetchedAt: Date.now(), sources: [],
    }))
    expect(empty?.text).toBe('—')
  })

  it('stops presenting a healthy number while the whole pool is paused', () => {
    // Per-account quota keeps its last snapshot through a pause, so the badge
    // would otherwise show "99%" beside a conversation that cannot be served.
    const paused = { ...meterStatus(0.99), pool: { paused: true, pauseReason: 'upstream restricted every account' } }
    const facts = selectBadgeFacts(paused)
    expect(facts?.text).toBe('—')
    expect(facts?.level).toBe('danger')
    expect(facts?.tooltip).toContain('paused')
    expect(facts?.tooltip).toContain('upstream restricted every account')
  })

  it('reports the pause even when no quota snapshot was ever read', () => {
    // The pause is a fact about the POOL, not about the last quota reading. A
    // pool that stopped before any snapshot existed answers `quota: null` (or
    // omits it), and an "unavailable" badge there would read as "we have not
    // looked yet" — the opposite of "nothing will be served".
    const withNullQuota = { ...statusWith(null), pool: { paused: true, pauseReason: 'manual pause' } }
    const nullFacts = selectBadgeFacts(withNullQuota)
    expect(nullFacts?.text).toBe('—')
    expect(nullFacts?.level).toBe('danger')
    expect(nullFacts?.tooltip).toContain('paused')
    expect(nullFacts?.tooltip).toContain('manual pause')
    // A host that predates the quota field omits it entirely; same statement.
    const omitted = { ...statusWith(null) } as Partial<WorkBuddyWebStatus>
    delete omitted.quota
    ;(omitted as { pool?: unknown }).pool = { paused: true }
    expect(selectBadgeFacts(omitted as WorkBuddyWebStatus)?.level).toBe('danger')
  })

  it('keeps the ordinary unknown neutral, so a pause is not mistaken for it', () => {
    // Both render "—"; only the level and the tooltip tell them apart, and a
    // card that merged them would either cry wolf on every cold start or go
    // quiet on a pool that serves nothing.
    const unknown = selectBadgeFacts(statusWith(null))
    expect(unknown?.level).toBe('normal')
    expect(unknown?.tooltip).toContain('unavailable')
    expect(unknown?.tooltip).not.toContain('paused')
    const paused = selectBadgeFacts({ ...statusWith(null), pool: { paused: true } })
    expect(paused?.level).not.toBe(unknown?.level)
    expect(paused?.tooltip).not.toBe(unknown?.tooltip)
  })
})

describe('WorkBuddy credit multiplier hint', () => {
  // The hint is built from the caller's own dictionary, so these tests use the
  // shipped one rather than an inline stub: the region nouns and the brackets
  // are part of what the row shows.
  const labels = (dict: {
    creditMultiplier: string
    creditMultiplierRegion: string
    creditMultiplierPair: string
    regionCn: string
    regionIntl: string
  }) => ({
    multiplier: dict.creditMultiplier,
    region: (value: string, key: 'cn' | 'intl'): string => dict.creditMultiplierRegion
      .replace('{value}', value)
      .replace('{region}', key === 'cn' ? dict.regionCn : dict.regionIntl),
    pair: (first: string, second: string): string => dict.creditMultiplierPair
      .replace('{first}', first)
      .replace('{second}', second),
  })

  it('states only the known region rate', () => {
    expect(creditMultiplierHint({ cn: '0.11', intl: '0.00' }, 'cn', labels(zh))).toBe('倍率 0.11x')
    expect(creditMultiplierHint({ cn: '0.11', intl: '0.00' }, 'intl', labels(zh))).toBe('倍率 0.00x')
    expect(creditMultiplierHint({ cn: '0.79', intl: '0.79' }, 'cn', labels(zh))).toBe('倍率 0.79x')
  })

  it('states nothing when the known region published no rate', () => {
    // Measured 2026-10-09: the two backends do not always agree, and a model
    // asked of the wrong region is rejected upstream. Falling back to the
    // sibling region would print a price this account never pays.
    expect(creditMultiplierHint({ intl: '0.00' }, 'cn', labels(zh))).toBeNull()
    expect(creditMultiplierHint({ cn: '0.11' }, 'intl', labels(zh))).toBeNull()
  })

  it('states nothing for a model the catalog did not rate', () => {
    expect(creditMultiplierHint(undefined, 'cn', labels(zh))).toBeNull()
    expect(creditMultiplierHint({}, 'cn', labels(zh))).toBeNull()
    expect(creditMultiplierHint(undefined, null, labels(zh))).toBeNull()
    expect(creditMultiplierHint({}, null, labels(zh))).toBeNull()
    // The empty string is a publisher's "no rate declared" spelling; it must
    // not reach the row as a bare x.
    expect(creditMultiplierHint({ cn: '' }, null, labels(zh))).toBeNull()
  })

  it('states the single published rate when the region is unknown', () => {
    expect(creditMultiplierHint({ cn: '0.11' }, null, labels(zh))).toBe('倍率 0.11x')
    expect(creditMultiplierHint({ intl: '6.67' }, null, labels(zh))).toBe('倍率 6.67x')
  })

  it('collapses to one value when both regions agree', () => {
    expect(creditMultiplierHint({ cn: '0.79', intl: '0.79' }, null, labels(zh))).toBe('倍率 0.79x')
  })

  it('names both regions, cn first, when they disagree', () => {
    // The join is the dictionary's too, so it spaces both sides: the Chinese
    // form gained a space it used to absorb inside its full-width bracket. That
    // is the deliberate trade for one separator template both languages read.
    expect(creditMultiplierHint({ cn: '0.11', intl: '0.00' }, null, labels(zh)))
      .toBe('倍率 0.11x（国区） / 0.00x（国际区）')
    // Still cn first when the caller's object lists intl first.
    expect(creditMultiplierHint({ intl: '0.00', cn: '0.11' }, null, labels(zh)))
      .toBe('倍率 0.11x（国区） / 0.00x（国际区）')
  })

  it('keeps a declared zero, which is a rate and not a missing value', () => {
    // '0.00' means "this model consumes no allowance"; dropping it would be a
    // wrong answer about price rather than a missing one.
    expect(creditMultiplierHint({ cn: '0.00', intl: '0.00' }, null, labels(zh))).toBe('倍率 0.00x')
    expect(creditMultiplierHint({ cn: '0.00' }, null, labels(zh))).toBe('倍率 0.00x')
    expect(creditMultiplierHint({ cn: '0.11', intl: '0.00' }, null, labels(zh)))
      .toContain('0.00x（国际区）')
  })

  it('spells the same fact in the English dictionary', () => {
    expect(creditMultiplierHint({ cn: '6.67', intl: '6.67' }, 'cn', labels(en))).toBe('Multiplier 6.67x')
    expect(creditMultiplierHint({ cn: '0.11', intl: '0.00' }, null, labels(en)))
      .toBe('Multiplier 0.11x (China) / 0.00x (International)')
  })
})

describe('WorkBuddy dictionary parity', () => {
  it('covers the same keys in Chinese and English', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('keeps every placeholder in both languages', () => {
    const placeholders = (template: string): string[] =>
      [...template.matchAll(/\{[a-zA-Z0-9_]+\}/g)].map((match) => match[0]).sort()
    for (const [key, template] of Object.entries(zh)) {
      expect(placeholders(en[key as keyof typeof en]), key).toEqual(placeholders(template))
    }
  })
})
