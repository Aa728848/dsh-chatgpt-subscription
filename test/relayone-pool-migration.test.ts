import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { RelayOneAccountPool } from '../src/host/relayone/account-pool.ts'
import type { CredentialStore } from '../src/host/token-store.ts'
import type { PoolData } from '../src/host/common/account-pool.ts'
import type { RelayOnePoolAccount } from '../src/host/relayone/account-pool.ts'
import type { RelayOneCredentialStore, RelayOneCredentials } from '../src/host/relayone/token-store.ts'

function memoryBackend(): CredentialStore<PoolData<RelayOnePoolAccount>> {
  let stored: PoolData<RelayOnePoolAccount> | null = null
  return {
    load: async () => (stored === null ? null : structuredClone(stored)),
    save: async (value) => { stored = structuredClone(value) },
    clear: async () => { stored = null },
  }
}

/** The pre-pool single-key file, as an install that never saw the pool has it. */
function legacyStore(key: string | null) {
  let stored: RelayOneCredentials | null = key === null ? null : { apiKey: key, authenticatedAt: 1 }
  const store = {
    read: async () => stored,
    write: async (next: RelayOneCredentials) => { stored = next },
    delete: async () => { stored = null },
    path: () => 'memory',
  } as unknown as RelayOneCredentialStore
  return { store, current: () => stored }
}

let home = ''
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'relayone-pool-'))
  vi.stubEnv('DSH_HOME', home)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  const storages = path.join(home, 'storages')
  const names = await fs.readdir(storages).catch(() => [] as string[])
  for (const name of names) await fs.unlink(path.join(storages, name)).catch(() => undefined)
  await fs.rmdir(storages).catch(() => undefined)
  await fs.rmdir(home).catch(() => undefined)
})

describe('RelayOne legacy single-key migration', () => {
  it('serves the pre-pool key as the primary account without rewriting it', async () => {
    const legacy = legacyStore('sk-legacy')
    const pool = new RelayOneAccountPool({ store: legacy.store, backend: memoryBackend() })
    const accounts = await pool.listAccounts()
    // An install that pasted one key before the pool existed sees that key as
    // the primary account, so nothing it configured has to be re-entered.
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({ alias: 'RelayOne 账号 1', isPrimary: true })
    // Reading must not persist the projection: the legacy file stays the
    // authority until the user actually changes something.
    expect(legacy.current()?.apiKey).toBe('sk-legacy')
    expect(await pool.anyCredential()).toEqual({ apiKey: 'sk-legacy', authenticatedAt: 1 })
  })

  it('keeps the migrated key when a second one is added', async () => {
    const legacy = legacyStore('sk-legacy')
    const pool = new RelayOneAccountPool({ store: legacy.store, backend: memoryBackend() })
    await pool.addAccount({ apiKey: 'sk-pool', authenticatedAt: 2 }, '池内 Key')
    const listed = await pool.listAccounts()
    // Adding a key to a migrated install must not drop the key that was already
    // there: the legacy entry becomes account 1 and the new one joins it.
    expect(listed.map((account) => account.alias)).toEqual(['RelayOne 账号 1', '池内 Key'])
    // The migrated key stays selected until the user switches: adding a key is
    // not a rotation, and nothing moves the active account on its own.
    expect((await pool.getEffectiveCredential()).credentials.apiKey).toBe('sk-legacy')
    const added = listed.find((account) => account.alias === '池内 Key')!
    await pool.switchTo(added.id)
    expect((await pool.getEffectiveCredential()).credentials.apiKey).toBe('sk-pool')
  })

  it('reports no key at all when neither source has one', async () => {
    const legacy = legacyStore(null)
    const pool = new RelayOneAccountPool({ store: legacy.store, backend: memoryBackend() })
    expect(await pool.listAccounts()).toEqual([])
    expect(await pool.anyCredential()).toBeNull()
    await expect(pool.getEffectiveCredential(new Set())).rejects.toThrow()
  })

  it('mirrors the primary key back into the legacy file', async () => {
    const legacy = legacyStore('sk-legacy')
    const pool = new RelayOneAccountPool({ store: legacy.store, backend: memoryBackend() })
    const added = await pool.addAccount({ apiKey: 'sk-second', authenticatedAt: 3 })
    await pool.setPrimary(added.id)
    // The mirror keeps the single-key file meaningful for anything that still
    // reads it, without ever becoming the rotation's source of truth.
    expect(legacy.current()?.apiKey).toBe('sk-second')
  })
})
