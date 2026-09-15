import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  credentialPath,
  modelSettingsPath,
  parseCommandCodeCredentials,
} from '../src/host/command-code/token-store.ts'
import { formatCapacity, parsePositiveCapacity } from '../src/client/command-code/CommandCodeSection.tsx'
import { selectBadgeFacts } from '../src/client/command-code/CommandCodeComposerQuota.tsx'
import type { CommandCodeWebStatus } from '../src/shared/command-code-contracts.ts'

function tmp(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

describe('Command Code credential payload', () => {
  it('requires an API key and rejects anything else', () => {
    expect(() => parseCommandCodeCredentials(null)).toThrow(/invalid/)
    expect(() => parseCommandCodeCredentials({})).toThrow(/missing its API key/)
    expect(() => parseCommandCodeCredentials({ apiKey: '   ' })).toThrow(/missing its API key/)
    expect(() => parseCommandCodeCredentials({ apiKey: 'k', authenticatedAt: 'soon' })).toThrow(/timestamp/)
    expect(() => parseCommandCodeCredentials({ apiKey: 'k', apiEnv: 'qa' })).toThrow(/environment/)
  })

  it('keeps every account fact the sign-in returned', () => {
    expect(parseCommandCodeCredentials({
      apiKey: 'k',
      userId: 'u1',
      userName: 'Eddy',
      email: 'e@example.com',
      keyName: 'laptop',
      organizationName: 'Acme',
      planLabel: 'Max',
      planId: 'max',
      authenticatedAt: 1234,
      apiEnv: 'staging',
    })).toEqual({
      apiKey: 'k', userId: 'u1', userName: 'Eddy', email: 'e@example.com',
      keyName: 'laptop', organizationName: 'Acme', planLabel: 'Max', planId: 'max',
      authenticatedAt: 1234, apiEnv: 'staging',
    })
  })

  it('names the platform-specific storage path', () => {
    expect(credentialPath()).toContain('command-code-credentials.json')
    expect(modelSettingsPath()).toContain('command-code-models.json')
    const store = new FileCredentialStore(tmp('cc-path'))
    expect(store.path()).toMatch(/dpapi$|^Keychain: |^Secret Service: /)
  })
})

describe('Command Code model settings file', () => {
  it('round-trips a model settings document', async () => {
    const file = tmp('cc-settings')
    const store = new FileModelSettingsStore(file)
    // A missing file answers with the shipped defaults rather than throwing.
    const initial = await store.read()
    expect(initial.enabledModelIds.length).toBeGreaterThan(0)
    expect(initial.defaultReasoningEffort).toBeNull()

    await store.write({
      enabledModelIds: ['claude-sonnet-4-6'],
      catalogModels: [{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 1_000_000 }],
      contextWindowOverrides: { 'claude-sonnet-4-6': 400_000 },
      defaultReasoningEffort: 'max',
    })
    const restored = await store.read()
    expect(restored).toMatchObject({
      enabledModelIds: ['claude-sonnet-4-6'],
      contextWindowOverrides: { 'claude-sonnet-4-6': 400_000 },
      defaultReasoningEffort: 'max',
    })

    const merged = await store.updateSettings({ contextWindowOverrides: { 'x': 5_000 }, defaultReasoningEffort: 'low' })
    expect(merged.contextWindowOverrides).toEqual({ 'claude-sonnet-4-6': 400_000, x: 5_000 })
    expect(merged.defaultReasoningEffort).toBe('low')

    const cataloged = await store.setCatalogModels([{ id: 'a' }], { enabledModelIds: ['a'] })
    expect(cataloged.enabledModelIds).toEqual(['a'])
    expect(cataloged.catalogModels).toEqual([{ id: 'a' }])

    await fs.rm(file, { force: true })
  })

  it('falls back to the shipped defaults for a corrupt file', async () => {
    const file = tmp('cc-corrupt')
    await fs.writeFile(file, '{ not json', 'utf8')
    const store = new FileModelSettingsStore(file)
    const settings = await store.read()
    expect(settings.enabledModelIds.length).toBeGreaterThan(0)
    expect(settings.contextWindowOverrides).toEqual({})
    await fs.rm(file, { force: true })
  })
})

describe('Command Code settings card helpers', () => {
  it('parses and formats capacities', () => {
    expect(parsePositiveCapacity('1M')).toBe(1_000_000)
    expect(parsePositiveCapacity('512K')).toBe(512_000)
    expect(parsePositiveCapacity('1,050,000')).toBe(1_050_000)
    expect(parsePositiveCapacity('0')).toBeNull()
    expect(parsePositiveCapacity('-5')).toBeNull()
    expect(parsePositiveCapacity('wide')).toBeNull()
    expect(formatCapacity(1_000_000)).toBe('1M')
    expect(formatCapacity(200_000)).toBe('200K')
    expect(formatCapacity(1234)).toBe('1234')
  })
})

describe('Command Code composer badge', () => {
  const ACCOUNT = {
    userId: null, userName: null, email: null, organizationName: null,
    keyName: null, planLabel: null, planId: null, authenticatedAt: null,
  }

  function status(overrides: Partial<CommandCodeWebStatus>): CommandCodeWebStatus {
    return {
      authenticated: true,
      hasCredentials: true,
      storagePath: 'x',
      apiEnv: 'prod',
      account: null,
      quota: null,
      lastFetchedAt: null,
      models: [],
      contextWindowOverrides: {},
      defaultReasoningEffort: null,
      serving: true,
      conflict: null,
      ...overrides,
    }
  }

  it('reports an unavailable quota instead of a fabricated zero', () => {
    expect(selectBadgeFacts(status({}))).toMatchObject({ text: '—', level: 'normal' })
  })

  it('prefers the shortest usage window and grades the level', () => {
    const facts = selectBadgeFacts(status({ quota: {
      account: ACCOUNT,
      creditBalance: '10',
      unlimited: false,
      planId: null,
      planName: null,
      planMonthlyCredits: null,
      subscriptionStatus: null,
      periodEndsAt: null,
      meters: [],
      windows: [
        { id: 'weekly', label: 'Weekly', usedPercent: 60, windowDurationMins: 10_080, resetsAt: null },
        { id: 'five-hour', label: '5 hours', usedPercent: 96, windowDurationMins: 300, resetsAt: null },
      ],
      fetchedAt: Date.now(),
      sources: [],
    } }))
    expect(facts).toMatchObject({ text: '4%', level: 'danger' })
  })

  it('falls back to a bounded meter, then to the balance, then to unlimited', () => {
    const base = {
      account: ACCOUNT, creditBalance: null, unlimited: false,
      planId: null, planName: null, planMonthlyCredits: null, subscriptionStatus: null, periodEndsAt: null,
      windows: [], meters: [], fetchedAt: Date.now(), sources: [],
    }
    expect(selectBadgeFacts(status({ quota: { ...base, meters: [
      { id: 'm', label: 'Plan', usedFraction: 0.3, remainingFraction: 0.7, used: null, limit: null, resetsAt: null, description: null },
    ] } }))).toMatchObject({ text: '70%', level: 'normal' })
    expect(selectBadgeFacts(status({ quota: { ...base, creditBalance: '12.50' } }))).toMatchObject({ text: '12.50' })
    expect(selectBadgeFacts(status({ quota: { ...base, unlimited: true } }))).toMatchObject({ text: '∞' })
  })
})
