/**
 * OpenDesign settings and pool documents: the parsers, the tri-state model
 * selection, and the write/read pair of the production store.
 *
 * The round-trip cases write with the production serializer and read with the
 * production parser — a hand-built fixture would prove the fixture, not the
 * store.
 */
import { describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import {
  OpenDesignModelSettingsStore,
  defaultOpenDesignModelSettings,
  parseOpenDesignCredentials,
  parseOpenDesignModelSettings,
  credentialsIdentity,
} from '../src/host/opendesign/token-store.ts'
import { parseOpenDesignPoolData } from '../src/host/opendesign/account-pool.ts'
import { DEFAULT_BASE_URL } from '../src/host/opendesign/types.ts'

describe('parseOpenDesignModelSettings', () => {
  it('defaults a fresh document', () => {
    const settings = defaultOpenDesignModelSettings()
    expect(settings.enabled).toBe(true)
    expect(settings.baseURL).toBe(DEFAULT_BASE_URL)
    expect(settings.enabledModelIds).toBeNull()
    expect(settings.catalogModels).toEqual([])
    expect(settings.hiddenModels).toEqual([])
    expect(settings.contextWindowOverrides).toEqual({})
  })

  it('keeps the selection tri-state apart: unset, empty, explicit', () => {
    // Unset means "no filter"; an empty array means "everything off". A parser
    // that normalizes one into the other erases a user decision.
    expect(parseOpenDesignModelSettings({}).enabledModelIds).toBeNull()
    expect(parseOpenDesignModelSettings({ enabledModelIds: null }).enabledModelIds).toBeNull()
    expect(parseOpenDesignModelSettings({ enabledModelIds: [] }).enabledModelIds).toEqual([])
    expect(parseOpenDesignModelSettings({ enabledModelIds: ['gpt-6-luna', 7, null] }).enabledModelIds).toEqual(['gpt-6-luna'])
  })

  it('drops malformed catalog entries but keeps the good ones', () => {
    const settings = parseOpenDesignModelSettings({
      catalogModels: [
        { id: 'gpt-6-luna', name: 'GPT-6 Luna', contextWindow: 272_000 },
        { id: '' },
        'junk',
        { id: 'kimi-k3', contextWindow: -5 },
      ],
    })
    expect(settings.catalogModels).toEqual([
      { id: 'gpt-6-luna', name: 'GPT-6 Luna', contextWindow: 272_000 },
      { id: 'kimi-k3' },
    ])
  })

  it('rejects non-positive overrides and non-integer limits', () => {
    const settings = parseOpenDesignModelSettings({
      contextWindowOverrides: { 'gpt-6-luna': 256_000, bad: 0 },
      defaultContextWindow: -1,
      maxConcurrentRequests: 0,
    })
    expect(settings.contextWindowOverrides).toEqual({ 'gpt-6-luna': 256_000 })
    expect(settings.defaultContextWindow).toBe(128_000)
    expect(settings.maxConcurrentRequests).toBe(0)
  })
})

describe('OpenDesignModelSettingsStore', () => {
  it('round-trips a document through the production writer and parser', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opendesign-settings-'))
    try {
      const file = path.join(dir, 'models.json')
      const writer = new OpenDesignModelSettingsStore(file)
      await writer.update({ enabled: false, enabledModelIds: [] })
      await writer.storeCatalog([{ id: 'gpt-6-luna', name: 'GPT-6 Luna', contextWindow: 272_000 }])
      await writer.setContextWindowOverride('gpt-6-luna', 256_000)

      // A fresh instance reads what the production writer actually emitted.
      const reader = new OpenDesignModelSettingsStore(file)
      const read = await reader.read()
      expect(read.enabled).toBe(false)
      expect(read.enabledModelIds).toEqual([])
      expect(read.catalogModels).toEqual([{ id: 'gpt-6-luna', name: 'GPT-6 Luna', contextWindow: 272_000 }])
      expect(read.contextWindowOverrides).toEqual({ 'gpt-6-luna': 256_000 })

      await reader.setContextWindowOverride('gpt-6-luna', null)
      const cleared = await new OpenDesignModelSettingsStore(file).read()
      expect(cleared.contextWindowOverrides).toEqual({})
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('starts from defaults when the file is missing or unreadable', async () => {
    const store = new OpenDesignModelSettingsStore(path.join(os.tmpdir(), 'opendesign-never-exists', 'models.json'))
    expect(await store.read()).toEqual(defaultOpenDesignModelSettings())
  })
})

describe('parseOpenDesignCredentials', () => {
  it('accepts a static key and trims it', () => {
    expect(parseOpenDesignCredentials({ apiKey: '  od_x  ', alias: '主号' }))
      .toEqual({ apiKey: 'od_x', alias: '主号' })
  })

  it('refuses a payload with no key', () => {
    expect(() => parseOpenDesignCredentials({})).toThrow(/missing its API key/)
    expect(() => parseOpenDesignCredentials('od_x')).toThrow(/invalid/)
  })
})

describe('parseOpenDesignPoolData', () => {
  it('parses accounts and never invents fields', () => {
    const data = parseOpenDesignPoolData({
      version: 1,
      activeAccountId: 'a1',
      rotationStrategy: 'round-robin',
      accounts: [
        { id: 'a1', alias: '主号', credentials: { apiKey: 'od_1' }, addedAt: 1, isPrimary: true },
        { id: 'a2', alias: '', credentials: { apiKey: 'od_2' }, addedAt: 2, cooldownUntil: 5, authStatus: 'invalid' },
      ],
    })
    expect(data.accounts).toHaveLength(2)
    expect(data.activeAccountId).toBe('a1')
    expect(data.rotationStrategy).toBe('round-robin')
    expect(data.accounts[1]!.alias).toBe('OpenDesign 账号')
    expect(data.accounts[1]!.cooldownUntil).toBe(5)
    expect(data.accounts[1]!.authStatus).toBe('invalid')
  })

  it('refuses a non-object payload', () => {
    expect(() => parseOpenDesignPoolData([])).toThrow(/invalid/)
    expect(() => parseOpenDesignPoolData(null)).toThrow(/invalid/)
  })
})

describe('credentialsIdentity', () => {
  it('is a digest, never the key itself', () => {
    const identity = credentialsIdentity({ apiKey: 'od_secret_value' })
    expect(identity.startsWith('key:')).toBe(true)
    expect(identity).not.toContain('od_secret_value')
    expect(credentialsIdentity({ apiKey: 'od_secret_value' })).toBe(identity)
    expect(credentialsIdentity({ apiKey: 'od_other' })).not.toBe(identity)
  })
})
