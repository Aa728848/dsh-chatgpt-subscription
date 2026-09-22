import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type z from '@deepseek-ai/schemastery'
import { describe, expect, it } from 'vitest'
import { registerPreferenceStore } from '../src/host/preferences.ts'
import { registerAntigravityPreferenceStore } from '../src/host/antigravity/token-store.ts'
import { registerCommandCodePreferenceStore } from '../src/host/command-code/token-store.ts'
import { registerKimiCodePreferenceStore } from '../src/host/kimi-code/token-store.ts'
import { registerWorkBuddyPreferenceStore } from '../src/host/workbuddy/token-store.ts'
import type { SubscriptionPreferencesDto } from '../src/shared/contracts.ts'

type PreferenceSettings = Omit<SubscriptionPreferencesDto, 'writable'>

function createPreferenceStore(initial: unknown = {}) {
  return registerPreferenceStore({
    register(_namespace: unknown, schema: z<PreferenceSettings>) {
      let value = schema(initial as never)
      return {
        get: () => value,
        update: async (patch: Partial<PreferenceSettings>) => { value = schema({ ...value, ...patch }) },
        watch: () => () => undefined,
      }
    },
  } as unknown as SettingsProvider)
}

describe('subscription preferences', () => {
  it('fills Astra defaults in older settings and preserves saved model choices and contexts', async () => {
    const store = createPreferenceStore({
      visibleModelIds: ['gpt-5.6-sol'],
      contextWindowOverrides: { 'gpt-5.6-sol': 512_000 },
    })
    expect(store.status()).toMatchObject({
      visibleModelIds: ['gpt-5.6-sol'],
      contextWindowOverrides: { 'gpt-6-astra': 272_000, 'gpt-5.6-sol': 512_000 },
    })
    expect(await store.update({
      visibleModelIds: ['gpt-6-astra', 'gpt-5.6-sol'],
      contextWindowOverrides: { 'gpt-6-astra': 872_000 },
    })).toMatchObject({
      visibleModelIds: ['gpt-6-astra', 'gpt-5.6-sol'],
      contextWindowOverrides: { 'gpt-6-astra': 872_000, 'gpt-5.6-sol': 512_000 },
    })
  })

  it('includes Astra for new settings and rejects an oversized persisted or updated context', async () => {
    const store = createPreferenceStore()
    expect(store.status().visibleModelIds).toContain('gpt-6-astra')
    expect(() => createPreferenceStore({ contextWindowOverrides: { 'gpt-6-astra': 872_001 } })).toThrow()
    await expect(store.update({ contextWindowOverrides: { 'gpt-6-astra': 1_000_000 } })).rejects.toThrow()
    expect(store.status().contextWindowOverrides['gpt-6-astra']).toBe(272_000)
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

  it('gracefully falls back to in-memory store when settings is undefined or lacks register', async () => {
    const storeUndef = registerPreferenceStore(undefined)
    expect(storeUndef.status().enabled).toBe(true)
    expect(storeUndef.status().visibleModelIds).toContain('gpt-6-astra')

    const storeNoRegister = registerPreferenceStore({} as SettingsProvider)
    expect(storeNoRegister.status().enabled).toBe(true)
    expect(storeNoRegister.status().fastMode).toBe(false)

    let watchedFastMode: boolean | undefined
    const unwatch = storeNoRegister.watch((next) => {
      watchedFastMode = next.fastMode
    })

    const updated = await storeNoRegister.update({ fastMode: true })
    expect(updated.fastMode).toBe(true)
    expect(storeNoRegister.status().fastMode).toBe(true)
    expect(watchedFastMode).toBe(true)

    unwatch()

    await expect(storeNoRegister.update({ contextWindowOverrides: { 'gpt-6-astra': 1_000_000 } })).rejects.toThrow()
  })

  it('gracefully falls back for all provider preference stores when settings lacks register', () => {
    const emptySettings = {} as SettingsProvider

    const antigravity = registerAntigravityPreferenceStore(emptySettings)
    expect(antigravity.status().enabled).toBe(true)

    const commandCode = registerCommandCodePreferenceStore(emptySettings)
    expect(commandCode.status().enabled).toBe(true)

    const kimiCode = registerKimiCodePreferenceStore(emptySettings)
    expect(kimiCode.status().enabled).toBe(true)

    const workBuddy = registerWorkBuddyPreferenceStore(emptySettings)
    expect(workBuddy.status().enabled).toBe(true)
  })
})
