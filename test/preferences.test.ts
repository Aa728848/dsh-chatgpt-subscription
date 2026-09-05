import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type z from '@deepseek-ai/schemastery'
import { describe, expect, it } from 'vitest'
import { registerPreferenceStore } from '../src/host/preferences.ts'
import type { SubscriptionPreferencesDto } from '../src/shared/contracts.ts'

type PreferenceSettings = Omit<SubscriptionPreferencesDto, 'writable'>

function createPreferenceStore(initial: unknown = {}) {
  return registerPreferenceStore({
    register(_namespace: unknown, schema: z<PreferenceSettings>) {
      let value = schema(initial)
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
})
