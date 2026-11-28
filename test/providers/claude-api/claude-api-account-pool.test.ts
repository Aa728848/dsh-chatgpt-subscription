import { describe, expect, it } from 'vitest'
import type { PoolData } from '../../../src/host/common/account-pool.ts'
import {
  ClaudeApiAccountPool,
  parseClaudeApiPoolData,
  type ClaudeApiPoolAccount,
} from '../../../src/host/providers/claude-api/account-pool.ts'
import {
  defaultClaudeApiSettings,
  mergeClaudeApiSettings,
  type ClaudeApiCredentials,
  type ClaudeApiCredentialStore,
  type ClaudeApiSettings,
  type ClaudeApiSettingsPatch,
  type ClaudeApiSettingsStore,
} from '../../../src/host/providers/claude-api/token-store.ts'

function fixture(legacyKey: string | null = 'sk-legacy') {
  let legacy: ClaudeApiCredentials | null = legacyKey === null ? null : { apiKey: legacyKey, authenticatedAt: 1 }
  const store = {
    read: async () => legacy,
    write: async (value: ClaudeApiCredentials) => { legacy = value },
    delete: async () => { legacy = null },
    path: () => 'legacy-memory',
  } as unknown as ClaudeApiCredentialStore
  let settings = { ...defaultClaudeApiSettings(), baseUrl: 'https://legacy.example' }
  const settingsStore = {
    read: async () => settings,
    update: async (patch: ClaudeApiSettingsPatch) => {
      settings = mergeClaudeApiSettings(settings, patch)
      return settings
    },
  } as unknown as ClaudeApiSettingsStore
  let data: PoolData<ClaudeApiPoolAccount> | null = null
  const pool = new ClaudeApiAccountPool({
    store, settingsStore,
    backend: {
      load: async () => data,
      save: async value => { data = structuredClone(value) },
      clear: async () => { data = null },
    },
  })
  return { pool, settingsStore, getLegacy: () => legacy, getSettings: () => settings, getData: () => data }
}

describe('ClaudeApiAccountPool', () => {
  it('projects the legacy key and endpoint as primary without leaking the secret', async () => {
    const f = fixture()
    const first = await f.pool.read()
    expect(first.accounts).toHaveLength(1)
    expect(first.accounts[0]).toMatchObject({ id: 'acc_primary', isPrimary: true })
    expect(first.accounts[0]!.credentials).toMatchObject({ apiKey: 'sk-legacy', baseUrl: 'https://legacy.example' })
    const summaries = await f.pool.listAccounts()
    expect(summaries[0]).toMatchObject({ baseUrl: 'https://legacy.example', isPrimary: true })
    expect(JSON.stringify(summaries)).not.toContain('sk-legacy')
    expect(JSON.stringify(summaries)).not.toContain('apiKey')
    // Reads are idempotent and do not persist a second migration row.
    expect((await f.pool.read()).accounts).toHaveLength(1)
  })

  it('persists independent endpoints and mirrors only the primary into legacy storage', async () => {
    const f = fixture()
    await f.pool.addAccount({ apiKey: 'sk-backup', authenticatedAt: 2, baseUrl: 'https://backup.example' })
    let data = await f.pool.read()
    expect(data.accounts).toHaveLength(2)
    expect(data.accounts[0]!.isPrimary).toBe(true)
    const backup = data.accounts[1]!
    await f.pool.setPrimary(backup.id)
    data = await f.pool.read()
    expect(data.accounts.find(account => account.isPrimary)?.credentials.baseUrl).toBe('https://backup.example')
    expect(f.getLegacy()?.apiKey).toBe('sk-backup')
    expect(f.getSettings().baseUrl).toBe('https://backup.example')
  })

  it('deduplicates address+key, permits the same key on another address and preserves a key while editing', async () => {
    const f = fixture(null)
    const main = await f.pool.saveAccount({ alias: 'Main', baseUrl: 'https://main.example/v1/', apiKey: 'sk-shared' })
    await f.pool.saveAccount({ baseUrl: 'https://main.example', apiKey: 'sk-shared' })
    await f.pool.saveAccount({ baseUrl: 'https://other.example', apiKey: 'sk-shared' })
    expect((await f.pool.read()).accounts).toHaveLength(2)
    await f.pool.saveAccount({ accountId: main.id, alias: 'Renamed', baseUrl: 'https://edited.example' })
    const edited = (await f.pool.read()).accounts.find(account => account.id === main.id)!
    expect(edited.alias).toBe('Renamed')
    expect(edited.credentials).toMatchObject({ apiKey: 'sk-shared', baseUrl: 'https://edited.example' })
  })

  it('round-trips pool state and keeps both new settings opt-out safe', async () => {
    const f = fixture(null)
    await f.pool.saveAccount({ baseUrl: 'https://main.example', apiKey: 'sk-main' })
    const parsed = parseClaudeApiPoolData(f.getData())
    expect(parsed.accounts[0]!.credentials.baseUrl).toBe('https://main.example')
    const settings = defaultClaudeApiSettings()
    expect(settings.autoCompactSubagents).toBe(true)
    expect(settings.subagentCacheTtl).toBe('5m')
    expect(mergeClaudeApiSettings(settings, { autoCompactSubagents: false, subagentCacheTtl: '1h' })).toMatchObject({
      autoCompactSubagents: false, subagentCacheTtl: '1h',
    })
  })
})
