import fsp from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FilePreferencesStore, preferencesPath } from '../src/host/common/file-preferences.ts'
import { registerPreferenceStore } from '../src/host/preferences.ts'
import {
  FileModelSettingsStore as AntigravityModelSettingsStore,
  registerAntigravityPreferenceStore,
} from '../src/host/antigravity/token-store.ts'
import {
  FileModelSettingsStore as CommandCodeModelSettingsStore,
  registerCommandCodePreferenceStore,
} from '../src/host/command-code/token-store.ts'
import {
  FileModelSettingsStore as KimiCodeModelSettingsStore,
  registerKimiCodePreferenceStore,
} from '../src/host/kimi-code/token-store.ts'
import {
  FileModelSettingsStore as WorkBuddyModelSettingsStore,
  registerWorkBuddyPreferenceStore,
} from '../src/host/workbuddy/token-store.ts'
import type { SubscriptionPreferencesDto } from '../src/shared/contracts.ts'

type PreferenceSettings = Omit<SubscriptionPreferencesDto, 'writable'>

// The fallback documents all live under `$DSH_HOME`, and the shared test setup
// already points that at a private temporary home. This file keeps one of its
// own and clears `storages` before each test, so a document written by one test
// can never be read by the next.
const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-preferences-'))

beforeEach(() => {
  process.env.DSH_HOME = home
  rmSync(path.join(home, 'storages'), { recursive: true, force: true })
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

function createPreferenceStore(initial: unknown = {}) {
  return registerPreferenceStore({
    register(_namespace: unknown, schema: z<PreferenceSettings>) {
      let value = schema(initial as never)
      return {
        get: () => value,
        update: async (patch: object) => { value = schema({ ...value, ...patch } as never) },
        watch: () => () => undefined,
      }
    },
  })
}

describe('subscription preferences', () => {
  it('keeps the saved model choices and context overrides without seeding new keys', async () => {
    const store = createPreferenceStore({
      visibleModelIds: ['gpt-5.6-sol'],
      contextWindowOverrides: { 'gpt-5.6-sol': 512_000 },
    })
    // An absent key is what "no override" looks like now, so an older document
    // keeps exactly the overrides it already had.
    expect(store.status()).toMatchObject({
      visibleModelIds: ['gpt-5.6-sol'],
      contextWindowOverrides: { 'gpt-5.6-sol': 512_000 },
    })
    expect(await store.update({
      visibleModelIds: ['gpt-6-astra', 'gpt-5.6-sol'],
      contextWindowOverrides: { 'gpt-6-astra': 872_000 },
    })).toMatchObject({
      visibleModelIds: ['gpt-6-astra', 'gpt-5.6-sol'],
      contextWindowOverrides: { 'gpt-6-astra': 872_000, 'gpt-5.6-sol': 512_000 },
    })
  })

  it('clears one override back to the absent state a restored default leaves behind', async () => {
    const store = createPreferenceStore({ contextWindowOverrides: { 'gpt-6-astra': 512_000 } })
    expect(store.status().contextWindowOverrides['gpt-6-astra']).toBe(512_000)
    const cleared = await store.update({ contextWindowOverrides: { 'gpt-6-astra': null } })
    expect(cleared.contextWindowOverrides).toEqual({})
    // Clearing one key leaves the others alone.
    const mixed = await store.update({ contextWindowOverrides: { 'gpt-5.6-sol': 300_000, 'gpt-6-sol': 400_000 } })
    expect(mixed.contextWindowOverrides).toEqual({ 'gpt-5.6-sol': 300_000, 'gpt-6-sol': 400_000 })
    const partial = await store.update({ contextWindowOverrides: { 'gpt-5.6-sol': null, 'gpt-6-luna': 500_000 } })
    expect(partial.contextWindowOverrides).toEqual({ 'gpt-6-sol': 400_000, 'gpt-6-luna': 500_000 })
  })

  it('accepts an override for every catalog model, not just the default-visible ones', async () => {
    const store = createPreferenceStore()
    expect(await store.update({ contextWindowOverrides: { 'gpt-5.4': 900_000, 'gpt-5.3-codex-spark': 200_000 } })).toMatchObject({
      contextWindowOverrides: { 'gpt-5.4': 900_000, 'gpt-5.3-codex-spark': 200_000 },
    })
  })

  it('includes the GPT-6 family for new settings and rejects an oversized persisted or updated context', async () => {
    const store = createPreferenceStore()
    expect(store.status().visibleModelIds).toContain('gpt-6-astra')
    expect(() => createPreferenceStore({ contextWindowOverrides: { 'gpt-6-astra': 872_001 } })).toThrow()
    await expect(store.update({ contextWindowOverrides: { 'gpt-6-astra': 1_000_000 } })).rejects.toThrow()
    // A rejected patch leaves nothing behind: no override, not the catalog value.
    expect(store.status().contextWindowOverrides['gpt-6-astra']).toBeUndefined()
  })

  it('allows disabling provider and setting visibleModelIds to empty array', async () => {
    const store = createPreferenceStore()
    expect(store.status().enabled).toBe(true)
    const updated = await store.update({ enabled: false, visibleModelIds: [] })
    expect(updated.enabled).toBe(false)
    expect(updated.visibleModelIds).toEqual([])
    expect(store.status().enabled).toBe(false)
    expect(store.status().visibleModelIds).toEqual([])
  })

  it('serves and persists preferences through the plugin-owned file when settings lacks register', async () => {
    const storeUndef = registerPreferenceStore(undefined)
    await storeUndef.hydrate()
    expect(storeUndef.status().enabled).toBe(true)
    expect(storeUndef.status().visibleModelIds).toContain('gpt-6-astra')

    const storeNoRegister = registerPreferenceStore({})
    await storeNoRegister.hydrate()
    expect(storeNoRegister.status().fastMode).toBe(false)

    let watchedFastMode: boolean | undefined
    let watchedPrevious: boolean | undefined
    const unwatch = storeNoRegister.watch((next, prev) => {
      watchedFastMode = next.fastMode
      watchedPrevious = prev.fastMode
    })

    const updated = await storeNoRegister.update({ fastMode: true, enabled: false })
    expect(updated.fastMode).toBe(true)
    expect(storeNoRegister.status().fastMode).toBe(true)
    expect(watchedFastMode).toBe(true)
    expect(watchedPrevious).toBe(false)

    unwatch()
    await storeNoRegister.update({ outputVerbosity: 'high' })

    // A restart is another store instance over the same harness home.
    const restarted = registerPreferenceStore({})
    await restarted.hydrate()
    expect(restarted.status()).toMatchObject({ enabled: false, fastMode: true, outputVerbosity: 'high' })
  })

  it('rejects an out-of-range context window through the file-backed store', async () => {
    const store = registerPreferenceStore(undefined)
    await store.hydrate()
    await expect(store.update({ contextWindowOverrides: { 'gpt-6-astra': 1_000_000 } })).rejects.toThrow()
    expect(store.status().contextWindowOverrides['gpt-6-astra']).toBeUndefined()
  })

  it('falls back to the shipped defaults for a corrupt or invalid fallback document', async () => {
    await fsp.mkdir(path.dirname(preferencesPath()), { recursive: true })
    await fsp.writeFile(preferencesPath(), '{ half written', 'utf8')
    const unparsable = registerPreferenceStore(undefined)
    await unparsable.hydrate()
    expect(unparsable.status()).toMatchObject({ enabled: true, fastMode: false, searchProvider: 'dsh' })

    await fsp.writeFile(preferencesPath(), JSON.stringify({ contextWindowOverrides: { 'gpt-6-astra': 872_001 } }), 'utf8')
    const rejected = registerPreferenceStore(undefined)
    await rejected.hydrate()
    expect(rejected.status().contextWindowOverrides).toEqual({})
    expect(rejected.status().visibleModelIds).toContain('gpt-6-astra')
  })

  it('hydrates every provider preference fallback from its settings file', async () => {
    const emptySettings = {}

    await new AntigravityModelSettingsStore().updateSettings({ enabled: false, enabledModelIds: ['gemini-3.7-flash'] })
    const antigravity = registerAntigravityPreferenceStore(emptySettings)
    await vi.waitFor(() => expect(antigravity.status()).toMatchObject({
      enabled: false,
      enabledModelIds: ['gemini-3.7-flash'],
    }))

    await new CommandCodeModelSettingsStore().updateSettings({ enabled: false, enabledModelIds: ['command-code-pick'] })
    const commandCode = registerCommandCodePreferenceStore(emptySettings)
    await vi.waitFor(() => expect(commandCode.status()).toMatchObject({
      enabled: false,
      enabledModelIds: ['command-code-pick'],
    }))

    await new KimiCodeModelSettingsStore().updateSettings({ enabled: false, enabledModelIds: ['kimi-code-pick'] })
    const kimiCode = registerKimiCodePreferenceStore(emptySettings)
    await vi.waitFor(() => expect(kimiCode.status()).toMatchObject({
      enabled: false,
      enabledModelIds: ['kimi-code-pick'],
    }))

    await new WorkBuddyModelSettingsStore().updateSettings({
      enabled: false,
      enabledModelIds: ['workbuddy-pick'],
      selectedAccountId: 'intl:account',
      hiddenAccountIds: ['intl:hidden'],
    })
    const workBuddy = registerWorkBuddyPreferenceStore(emptySettings)
    await vi.waitFor(() => expect(workBuddy.status()).toMatchObject({
      enabled: false,
      enabledModelIds: ['workbuddy-pick'],
      selectedAccountId: 'intl:account',
      hiddenAccountIds: ['intl:hidden'],
    }))

    // An update both writes through the file and refreshes the snapshot.
    const updated = await workBuddy.update({ selectedAccountId: null, hiddenAccountIds: [] })
    expect(updated.selectedAccountId).toBeNull()
    expect(workBuddy.status().hiddenAccountIds).toEqual([])
    expect((await new WorkBuddyModelSettingsStore().read()).selectedAccountId).toBeNull()
  })

  it('keeps the settings namespace path for a harness that still registers', async () => {
    const registered: unknown[] = []
    const store = registerPreferenceStore({
      register(namespace: unknown, schema: z<PreferenceSettings>) {
        registered.push(namespace)
        const value = schema({} as never)
        return { get: () => value, update: async () => undefined, watch: () => () => undefined }
      },
    })
    expect(registered).toEqual(['dsh-chatgpt-subscription'])
    // A settings-backed store has no fallback document to read.
    await expect(store.hydrate()).resolves.toBeUndefined()
    expect(store.status().enabled).toBe(true)
  })
})

describe('plugin-owned preference file', () => {
  const schema = z.object({
    fastMode: z.boolean().default(false),
    retries: z.number().min(0).max(3).default(1),
  })

  type Settings = { fastMode: boolean; retries: number }

  const fileStore = (file: string) => new FilePreferencesStore<Settings>(schema, file)

  it('round-trips a document across two store instances', async () => {
    const file = path.join(home, 'round-trip.json')
    const first = fileStore(file)
    await first.hydrate()
    expect(first.get()).toEqual({ fastMode: false, retries: 1 })

    await first.update({ fastMode: true })
    expect(JSON.parse(await fsp.readFile(file, 'utf8'))).toEqual({ fastMode: true, retries: 1 })

    const second = fileStore(file)
    await second.hydrate()
    expect(second.get()).toEqual({ fastMode: true, retries: 1 })
  })

  it('keeps the defaults for a missing, unparsable, or schema-rejected document', async () => {
    const missing = fileStore(path.join(home, 'missing.json'))
    await missing.hydrate()
    expect(missing.get()).toEqual({ fastMode: false, retries: 1 })

    const unparsableFile = path.join(home, 'unparsable.json')
    await fsp.writeFile(unparsableFile, '{ half written', 'utf8')
    const unparsable = fileStore(unparsableFile)
    await unparsable.hydrate()
    expect(unparsable.get()).toEqual({ fastMode: false, retries: 1 })

    const outOfRangeFile = path.join(home, 'out-of-range.json')
    await fsp.writeFile(outOfRangeFile, JSON.stringify({ retries: 9 }), 'utf8')
    const outOfRange = fileStore(outOfRangeFile)
    await outOfRange.hydrate()
    expect(outOfRange.get()).toEqual({ fastMode: false, retries: 1 })
  })

  it('answers with the defaults until the document is read, then notifies watchers', async () => {
    const file = path.join(home, 'watched.json')
    await fsp.writeFile(file, JSON.stringify({ retries: 3 }), 'utf8')
    const store = fileStore(file)
    // `get()` is synchronous: the file is not read until `hydrate()` runs.
    expect(store.get()).toEqual({ fastMode: false, retries: 1 })

    const seen: Array<{ next: Settings; prev: Settings }> = []
    store.watch((next, prev) => {
      seen.push({ next, prev })
    })

    await store.hydrate()
    expect(store.get()).toEqual({ fastMode: false, retries: 3 })
    await store.update({ fastMode: true })
    expect(seen).toEqual([
      { next: { fastMode: false, retries: 3 }, prev: { fastMode: false, retries: 1 } },
      { next: { fastMode: true, retries: 3 }, prev: { fastMode: false, retries: 3 } },
    ])
  })
})
