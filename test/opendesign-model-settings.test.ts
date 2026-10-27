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
    expect(settings.servedModelIds).toBeNull()
    expect(settings.forceVisibleModels).toEqual([])
  })

  it('reads a document written before the plan fields existed', () => {
    // The upgrade case: an existing document names neither field, and it must keep
    // working with the behaviour it had before — no model hidden by a fact nobody
    // measured (`null`), and no model forced visible.
    const legacy = parseOpenDesignModelSettings({
      version: 1,
      enabled: true,
      baseURL: DEFAULT_BASE_URL,
      enabledModelIds: ['gpt-6-luna'],
      catalogModels: [{ id: 'gpt-6-luna' }],
      hiddenModels: ['kimi-k3'],
      contextWindowOverrides: {},
    })
    expect(legacy.servedModelIds).toBeNull()
    expect(legacy.forceVisibleModels).toEqual([])
    expect(legacy.enabledModelIds).toEqual(['gpt-6-luna'])
    expect(legacy.hiddenModels).toEqual(['kimi-k3'])
  })

  it('keeps "never measured" and "measured as empty" apart', () => {
    // Collapsing `[]` into `null` would silently re-show every model after a plan
    // answered with nothing, which is the same trap the selection's tri-state has.
    expect(parseOpenDesignModelSettings({}).servedModelIds).toBeNull()
    expect(parseOpenDesignModelSettings({ servedModelIds: 'junk' }).servedModelIds).toBeNull()
    expect(parseOpenDesignModelSettings({ servedModelIds: [] }).servedModelIds).toEqual([])
  })

  it('normalizes both id lists: non-empty strings only, deduplicated', () => {
    const settings = parseOpenDesignModelSettings({
      servedModelIds: ['gpt-6-luna', 'gpt-6-luna', '', 7, null, ' kimi-k3 '],
      forceVisibleModels: ['mimo-v2.6-pro', 'mimo-v2.6-pro', '', 3],
    })
    expect(settings.servedModelIds).toEqual(['gpt-6-luna', 'kimi-k3'])
    expect(settings.forceVisibleModels).toEqual(['mimo-v2.6-pro'])
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
      await writer.storeCatalog([{ id: 'gpt-6-luna', name: 'GPT-6 Luna', contextWindow: 272_000 }], ['gpt-6-luna', 'kimi-k3'])
      await writer.setContextWindowOverride('gpt-6-luna', 256_000)
      await writer.update({ forceVisibleModels: ['mimo-v2.6-pro'] })

      // A fresh instance reads what the production writer actually emitted.
      const reader = new OpenDesignModelSettingsStore(file)
      const read = await reader.read()
      expect(read.enabled).toBe(false)
      expect(read.enabledModelIds).toEqual([])
      expect(read.catalogModels).toEqual([{ id: 'gpt-6-luna', name: 'GPT-6 Luna', contextWindow: 272_000 }])
      expect(read.contextWindowOverrides).toEqual({ 'gpt-6-luna': 256_000 })
      expect(read.servedModelIds).toEqual(['gpt-6-luna', 'kimi-k3'])
      expect(read.forceVisibleModels).toEqual(['mimo-v2.6-pro'])

      await reader.setContextWindowOverride('gpt-6-luna', null)
      const cleared = await new OpenDesignModelSettingsStore(file).read()
      expect(cleared.contextWindowOverrides).toEqual({})
      // Neither a context-window edit nor a plain read disturbs the measurement.
      expect(cleared.servedModelIds).toEqual(['gpt-6-luna', 'kimi-k3'])
      expect(cleared.forceVisibleModels).toEqual(['mimo-v2.6-pro'])

      // A sync that measured nothing keeps the previous measurement instead of
      // clearing it: "omitted" and "measured as empty" are different statements.
      await reader.storeCatalog([{ id: 'gpt-6-luna' }])
      const kept = await new OpenDesignModelSettingsStore(file).read()
      expect(kept.servedModelIds).toEqual(['gpt-6-luna', 'kimi-k3'])
      await reader.storeCatalog([{ id: 'gpt-6-luna' }], [])
      const emptied = await new OpenDesignModelSettingsStore(file).read()
      expect(emptied.servedModelIds).toEqual([])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('starts from defaults when the file is missing or unreadable', async () => {
    const store = new OpenDesignModelSettingsStore(path.join(os.tmpdir(), 'opendesign-never-exists', 'models.json'))
    expect(await store.read()).toEqual(defaultOpenDesignModelSettings())
  })
})

/**
 * Interleaved writes.
 *
 * `syncCatalog` is fire-and-forget on this line, so a sync really can land between
 * a selection change's read and its write. Every mutator derives a WHOLE document
 * from the document it read, so two of them in flight at once each erase the
 * other's fields — the store therefore serializes them, and these three cases are
 * what holds it to that.
 */
describe('OpenDesignModelSettingsStore write queue', () => {
  it('does not let an overlapping catalog sync swallow a selection change', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opendesign-queue-'))
    try {
      const file = path.join(dir, 'models.json')
      const store = new OpenDesignModelSettingsStore(file)
      // A forced reveal gives the selection change something to prune, and the
      // catalog sync fields of its own to keep.
      await store.update({ forceVisibleModels: ['withheld-model', 'gpt-6-luna'], enabledModelIds: null })

      // Both mutations read the same starting document and are in flight together;
      // the second must observe the first's result instead of erasing it.
      await Promise.all([
        store.storeCatalog([{ id: 'fresh-model' }], ['fresh-model']),
        store.selectModels(['gpt-6-luna']),
      ])

      const read = await new OpenDesignModelSettingsStore(file).read()
      expect(read.catalogModels).toEqual([{ id: 'fresh-model' }])
      expect(read.servedModelIds).toEqual(['fresh-model'])
      expect(read.enabledModelIds).toEqual(['gpt-6-luna'])
      expect(read.forceVisibleModels).toEqual(['gpt-6-luna'])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps accepting writes after one of them fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opendesign-queue-fail-'))
    try {
      const file = path.join(dir, 'nested', 'models.json')
      const store = new OpenDesignModelSettingsStore(file)
      await store.update({ defaultMaxTokens: 1_000 })
      // That write created `nested/`; hand the path back to a regular file so the
      // NEXT write fails while creating the directory — a failure inside the queue,
      // which is the case that used to poison it.
      await fs.rm(path.join(dir, 'nested', 'models.json'))
      await fs.rmdir(path.join(dir, 'nested'))
      await fs.writeFile(path.join(dir, 'nested'), 'blocker')
      await expect(store.update({ defaultMaxTokens: 2_000 })).rejects.toThrow()
      // The failure is reported to its caller only: the cache still holds the last
      // document that really landed.
      expect(store.status().defaultMaxTokens).toBe(1_000)

      await fs.rm(path.join(dir, 'nested'))
      const after = await store.update({ defaultMaxTokens: 3_000 })
      expect(after.defaultMaxTokens).toBe(3_000)
      expect((await new OpenDesignModelSettingsStore(file).read()).defaultMaxTokens).toBe(3_000)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('lands writes made in one tick in the order they were made', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opendesign-queue-order-'))
    try {
      const file = path.join(dir, 'models.json')
      const store = new OpenDesignModelSettingsStore(file)
      await store.read()
      await Promise.all([1_000, 2_000, 3_000, 4_000].map((value) => store.update({ defaultMaxTokens: value })))
      expect((await new OpenDesignModelSettingsStore(file).read()).defaultMaxTokens).toBe(4_000)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
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
