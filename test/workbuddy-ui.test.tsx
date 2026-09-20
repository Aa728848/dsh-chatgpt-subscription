// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { selectBadgeFacts } from '../src/client/workbuddy/WorkBuddyComposerQuota.tsx'
import {
  displayFile,
  formatCapacity,
  maskUin,
  parsePositiveCapacity,
  reasoningEffortChoices,
  unsupportedReasoningEffort,
} from '../src/client/workbuddy/WorkBuddySection.tsx'
import type { WorkBuddyModelOption } from '../src/shared/workbuddy-contracts.ts'
import type { WorkBuddyWebStatus } from '../src/shared/workbuddy-contracts.ts'

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

  it('shows only the file name of a credential path', () => {
    expect(displayFile('C:\\Users\\me\\AppData\\Local\\CodeBuddyExtension\\auth\\workbuddy-desktop.info'))
      .toBe('workbuddy-desktop.info')
    expect(displayFile('/home/me/.local/share/auth/x.info')).toBe('x.info')
    expect(displayFile(null)).toBe('—')
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
    // A text-only account must not be shown six levels that do nothing.
    expect(reasoningEffortChoices([
      model({ id: 'a', name: 'Alpha', reasoningEfforts: [] }),
      model({ id: 'b', name: 'Beta' }),
    ])).toEqual([])
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
  })

  it('escalates the badge level as the allowance runs down', () => {
    const meter = (remaining: number) => statusWith({
      account, packageName: null, totalCredits: null, remainingCredits: null,
      cycleUsedCredits: null, cycleCredits: null, cycleStartsAt: null, cycleEndsAt: null,
      meters: [{ id: 'cycle', label: 'Cycle', usedFraction: 1 - remaining, remainingFraction: remaining, used: null, limit: null, resetsAt: null, description: null }],
      fetchedAt: Date.now(), sources: [],
    })
    expect(selectBadgeFacts(meter(0.15))?.level).toBe('warning')
    expect(selectBadgeFacts(meter(0.02))?.level).toBe('danger')
  })

  it('falls back to the remaining credit balance when no percentage is reported', () => {
    const facts = selectBadgeFacts(statusWith({
      account, packageName: 'Free', totalCredits: null, remainingCredits: 483,
      cycleUsedCredits: null, cycleCredits: null, cycleStartsAt: null, cycleEndsAt: null,
      meters: [], fetchedAt: Date.now(), sources: [],
    }))
    expect(facts?.text).toBe('483')
  })

  it('reports an unavailable badge rather than a fabricated zero', () => {
    expect(selectBadgeFacts(null)?.text).toBe('—')
    expect(selectBadgeFacts(statusWith(null))?.text).toBe('—')
  })
})
