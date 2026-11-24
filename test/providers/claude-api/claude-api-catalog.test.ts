import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CLAUDE_API_DEFAULT_BASE_URL } from '../../../src/shared/claude-api-contracts.ts'
import { ClaudeApiCatalogManager } from '../../../src/host/providers/claude-api/catalog-manager.ts'
import { ClaudeApiClientVersionResolver } from '../../../src/host/providers/claude-api/client-version.ts'
import {
  CLAUDE_API_MODELS,
  claudeApiFallbackEntries,
  parseClaudeApiModelListing,
  parsePersistedClaudeApiModelEntries,
  persistedClaudeApiModelRecord,
} from '../../../src/host/providers/claude-api/model-catalog.ts'
import {
  ClaudeApiCredentialStore,
  ClaudeApiSettingsStore,
  claudeApiCredentialFingerprint,
  type ClaudeApiCredentials,
} from '../../../src/host/providers/claude-api/token-store.ts'
import {
  catalogSnapshotName,
  catalogSnapshotPath,
  flushCatalogSnapshots,
  readCatalogSnapshot,
  writeCatalogSnapshot,
} from '../../../src/host/common/catalog-snapshot.ts'

const LISTING = { data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }, { id: 'gateway-only', display_name: 'Gateway Only' }] }
const FALLBACK_IDS = CLAUDE_API_MODELS.map(entry => entry.id)

let home = ''
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-api-catalog-'))
  vi.stubEnv('DSH_HOME', home)
})
afterEach(async () => {
  await flushCatalogSnapshots()
  vi.unstubAllEnvs()
  await fs.rm(home, { recursive: true, force: true })
})

function fixture(key: string | null = 'sk-catalog') {
  let credentials: ClaudeApiCredentials | null = key === null ? null : { apiKey: key, authenticatedAt: 1 }
  const backend = {
    load: async () => credentials,
    save: async (value: ClaudeApiCredentials) => { credentials = value },
    clear: async () => { credentials = null },
  }
  const store = new ClaudeApiCredentialStore(path.join(home, 'storages', 'credentials.json'), backend)
  const settingsStore = new ClaudeApiSettingsStore(path.join(home, 'storages', 'settings.json'))
  const version = new ClaudeApiClientVersionResolver({
    fetchFn: vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch,
    filePath: path.join(home, 'storages', 'client-version.json'),
    env: {},
  })
  const fetchFn = vi.fn(async () => Response.json(LISTING)) as unknown as typeof fetch
  const onChanged = vi.fn()
  const catalog = new ClaudeApiCatalogManager(store, settingsStore, { version, fetchFn, onChanged })
  return {
    store, settingsStore, version, fetchFn, onChanged, catalog,
    setKey(value: string | null) { credentials = value === null ? null : { apiKey: value, authenticatedAt: 1 } },
    scope: (baseUrl: string) => catalogSnapshotName('claude-api', claudeApiCredentialFingerprint({ apiKey: key ?? '', authenticatedAt: 1 }, baseUrl)),
  }
}

describe('ClaudeApiCatalogManager cold start', () => {
  it('serves the shipped fallback table as not-live without touching the network', async () => {
    const f = fixture()
    const fingerprint = await f.catalog.warm()
    expect(f.fetchFn).not.toHaveBeenCalled()
    expect(f.catalog.snapshot().entries.map(entry => entry.id)).toEqual(FALLBACK_IDS)
    expect(f.catalog.snapshot().live).toBe(false)
    expect(f.catalog.snapshot().state).toBe('idle')
    expect(f.catalog.dto()).toEqual({ state: 'idle', fetchedAt: null, error: null })
    expect(fingerprint).toBe(JSON.stringify(claudeApiFallbackEntries()))
    expect(f.onChanged).not.toHaveBeenCalled()
  })
  it('serves the fallback table with no credential at all', async () => {
    const f = fixture(null)
    await f.catalog.warm()
    expect(f.catalog.snapshot().live).toBe(false)
    expect(f.catalog.snapshot().entries.map(entry => entry.id)).toEqual(FALLBACK_IDS)
    expect(await f.catalog.refresh(true)).toBe(false)
    expect(f.fetchFn).not.toHaveBeenCalled()
  })
  it('returns to the fallback table on reset', async () => {
    const f = fixture()
    await f.catalog.refresh(true)
    expect(f.catalog.snapshot().live).toBe(true)
    f.catalog.reset()
    expect(f.catalog.snapshot().live).toBe(false)
    expect(f.catalog.snapshot().entries.map(entry => entry.id)).toEqual(FALLBACK_IDS)
    expect(f.catalog.snapshot().state).toBe('idle')
  })
})

describe('ClaudeApiCatalogManager snapshot scope', () => {
  it('rehydrates a snapshot written by the production writer', async () => {
    const f = fixture()
    const entries = parseClaudeApiModelListing(LISTING)
    await writeCatalogSnapshot(f.scope(CLAUDE_API_DEFAULT_BASE_URL), entries.map(persistedClaudeApiModelRecord), 1234)
    await flushCatalogSnapshots()
    const warm = new ClaudeApiCatalogManager(f.store, f.settingsStore, { version: f.version, fetchFn: f.fetchFn })
    await warm.warm()
    expect(f.fetchFn).not.toHaveBeenCalled()
    expect(warm.snapshot().entries).toEqual(entries)
    expect(warm.snapshot().live).toBe(true)
    expect(warm.snapshot().state).toBe('ready')
    expect(warm.snapshot().fetchedAt).toBe(1234)
    const persisted = await readCatalogSnapshot(f.scope(CLAUDE_API_DEFAULT_BASE_URL), parsePersistedClaudeApiModelEntries)
    expect(persisted?.models).toEqual(entries)
  })
  it('discards the snapshot when the endpoint changes', async () => {
    const f = fixture()
    const entries = parseClaudeApiModelListing(LISTING)
    await writeCatalogSnapshot(f.scope(CLAUDE_API_DEFAULT_BASE_URL), entries.map(persistedClaudeApiModelRecord), 1234)
    await flushCatalogSnapshots()
    await f.catalog.warm()
    expect(f.catalog.snapshot().live).toBe(true)
    await f.settingsStore.update({ baseUrl: 'https://gw.example' })
    await f.catalog.warm()
    expect(f.catalog.snapshot().live).toBe(false)
    expect(f.catalog.snapshot().entries.map(entry => entry.id)).toEqual(FALLBACK_IDS)
    expect(f.fetchFn).not.toHaveBeenCalled()
    // The old scope's file is untouched: switching back must find it again.
    await expect(fs.access(catalogSnapshotPath(f.scope(CLAUDE_API_DEFAULT_BASE_URL)))).resolves.toBeUndefined()
  })
  it('discards the snapshot when the key changes', async () => {
    const f = fixture('sk-a')
    await f.catalog.refresh(true)
    expect(f.catalog.snapshot().entries.some(entry => entry.id === 'gateway-only')).toBe(true)
    f.setKey('sk-b')
    await f.catalog.warm()
    expect(f.catalog.snapshot().live).toBe(false)
    expect(f.catalog.snapshot().entries.map(entry => entry.id)).toEqual(FALLBACK_IDS)
  })
  it('persists a live listing that a fresh manager rehydrates', async () => {
    const f = fixture()
    expect(await f.catalog.refresh(true)).toBe(true)
    await flushCatalogSnapshots()
    const next = new ClaudeApiCatalogManager(f.store, f.settingsStore, { version: f.version, fetchFn: f.fetchFn })
    await next.warm()
    expect(next.snapshot().entries.map(entry => entry.id)).toEqual(['claude-opus-5-5', 'gateway-only'])
    expect(next.snapshot().live).toBe(true)
  })
})

describe('ClaudeApiCatalogManager refresh', () => {
  it('announces only an actual content change', async () => {
    const f = fixture()
    expect(await f.catalog.refresh(true)).toBe(true)
    expect(await f.catalog.refresh(true)).toBe(false)
    expect(f.onChanged).toHaveBeenCalledTimes(1)
    expect(f.onChanged).toHaveBeenCalledWith(f.catalog.snapshot().entries)
  })
  it('honours the TTL and deduplicates concurrent refreshes', async () => {
    let clock = 1000
    const f = fixture()
    const catalog = new ClaudeApiCatalogManager(f.store, f.settingsStore, { version: f.version, fetchFn: f.fetchFn, now: () => clock })
    await catalog.refresh(false)
    await catalog.refresh(false)
    expect(f.fetchFn).toHaveBeenCalledTimes(1)
    clock += 10 * 60_000
    await catalog.refresh(false)
    expect(f.fetchFn).toHaveBeenCalledTimes(2)
    ;(f.fetchFn as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => Response.json({ data: [{ id: 'claude-sonnet-5-5' }] }))
    const [a, b] = await Promise.all([catalog.refresh(true), catalog.refresh(true)])
    expect([a, b]).toEqual([true, true])
    expect(f.fetchFn).toHaveBeenCalledTimes(3)
    expect(catalog.snapshot().entries.map(entry => entry.id)).toEqual(['claude-sonnet-5-5'])
  })
  it('reports error before any listing and stale afterwards', async () => {
    const f = fixture()
    ;(f.fetchFn as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(JSON.stringify({ error: { message: 'bad key sk-catalog' } }), { status: 401 }))
    expect(await f.catalog.refresh(true)).toBe(false)
    expect(f.catalog.snapshot().state).toBe('error')
    expect(f.catalog.snapshot().live).toBe(false)
    expect(f.catalog.snapshot().entries.map(entry => entry.id)).toEqual(FALLBACK_IDS)
    expect(f.catalog.snapshot().error).toContain('[REDACTED]')
    expect(f.catalog.snapshot().error).not.toContain('sk-catalog')
    ;(f.fetchFn as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => Response.json(LISTING))
    await f.catalog.refresh(true)
    ;(f.fetchFn as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => { throw new Error('socket closed') })
    await f.catalog.refresh(true)
    expect(f.catalog.snapshot().state).toBe('stale')
    expect(f.catalog.snapshot().live).toBe(true)
    expect(f.catalog.snapshot().entries.map(entry => entry.id)).toEqual(['claude-opus-5-5', 'gateway-only'])
  })
  it('treats a valid empty listing as authoritative and removes the snapshot', async () => {
    const f = fixture()
    await f.catalog.refresh(true)
    await flushCatalogSnapshots()
    await expect(fs.access(catalogSnapshotPath(f.scope(CLAUDE_API_DEFAULT_BASE_URL)))).resolves.toBeUndefined()
    ;(f.fetchFn as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => Response.json({ data: [] }))
    await f.catalog.refresh(true)
    expect(f.catalog.snapshot().entries).toEqual([])
    expect(f.catalog.snapshot().live).toBe(true)
    await expect(fs.access(catalogSnapshotPath(f.scope(CLAUDE_API_DEFAULT_BASE_URL)))).rejects.toThrow()
  })
})
