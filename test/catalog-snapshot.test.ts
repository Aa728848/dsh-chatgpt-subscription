/**
 * Regression tests for the persisted catalog snapshot.
 *
 * The in-memory catalog caches start cold: the first model resolution after a
 * restart waited on the upstream listing before it could answer, and an
 * unreachable endpoint turned that wait into the full discovery timeout — the
 * settings page stalled and "the model server is unavailable" showed on a
 * fresh install. The last successful listing is now persisted under
 * `<DSH_HOME>/storages/` and rehydrated on the first cache miss of a process.
 *
 * These tests pin the behavior, not the storage format: a snapshot written by
 * one process is served by the next without a network call, an expired
 * snapshot still answers while the refresh runs behind it, and a corrupt or
 * missing file never fails the caller.
 *
 * The shared setup gives every file a private `$DSH_HOME`; within this file,
 * each test starts from an empty `storages` directory so a snapshot one test
 * wrote never stands in for the next one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const { catalogSnapshotName, catalogSnapshotPath, readCatalogSnapshot, writeCatalogSnapshot, rehydrateCatalogCache } = await import(
  '../src/host/common/catalog-snapshot.ts'
)
const commandCode = await import('../src/host/command-code/client.ts')
const kimi = await import('../src/host/kimi-code/client.ts')
const workbuddy = await import('../src/host/workbuddy/client.ts')
const { FileCredentialStore } = await import('../src/host/kimi-code/token-store.ts')

const home = () => process.env.DSH_HOME ?? path.join(os.tmpdir(), 'dsh-catalog-snapshot-fallback')
const storages = () => path.join(home(), 'storages')

function snapshotOf(name: string): string {
  return catalogSnapshotPath(name)
}

async function writeRaw(name: string, content: unknown): Promise<void> {
  const filePath = snapshotOf(name)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
}

/** Snapshot presence probe: the models count, or undefined when unusable. */
function countModels(value: unknown): number[] | undefined {
  return Array.isArray(value) && value.length > 0 ? (value as number[]) : undefined
}

beforeEach(async () => {
  await fs.mkdir(storages(), { recursive: true })
})

afterEach(async () => {
  commandCode.clearCachedCatalog()
  kimi.clearCachedCatalog()
  workbuddy.clearCachedCatalog()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  // The catalog write inside loadProviderModels is fire-and-forget; let any
  // pending one settle before clearing the directory, or it would recreate the
  // file after the cleanup and leak into the next test.
  await new Promise((resolve) => setTimeout(resolve, 20))
  await fs.rm(storages(), { recursive: true, force: true })
})

describe('catalog snapshot storage', () => {
  it('round-trips one snapshot', async () => {
    await writeCatalogSnapshot('test-a', [{ id: 'm1' }], 1_000)
    const read = await readCatalogSnapshot('test-a', (value) => value as Array<{ id: string }>)
    expect(read).toEqual({ fetchedAt: 1_000, models: [{ id: 'm1' }] })
  })

  it('returns undefined for a missing, corrupt, or malformed file', async () => {
    expect(await readCatalogSnapshot('test-b', () => [])).toBeUndefined()
    await writeRaw('test-b', 'not json')
    expect(await readCatalogSnapshot('test-b', () => [])).toBeUndefined()
    await writeRaw('test-b', { fetchedAt: 'nope', models: [] })
    expect(await readCatalogSnapshot('test-b', () => [])).toBeUndefined()
    await writeRaw('test-b', { fetchedAt: 1, models: [] })
    expect(await readCatalogSnapshot('test-b', () => [])).toBeUndefined()
  })
})

describe('command-code persisted catalog', () => {
  const models = [
    { id: 'cc-1', name: 'CC 1', contextWindow: 128_000 },
    { id: 'cc-2', name: 'CC 2', contextWindow: 200_000 },
  ]

  it('persists a fetched listing and serves it to the next process', async () => {
    const fetchFn = vi.fn(async () => new Response(
      JSON.stringify({ data: models.map((m) => ({ id: m.id, context_length: m.contextWindow })) }),
      { status: 200 },
    ))

    // First process: cold cache, one network fetch, snapshot written.
    const first = await commandCode.loadProviderModels({ fetchFn })
    expect(first.map((m) => m.id)).toEqual(['cc-1', 'cc-2'])
    expect(fetchFn).toHaveBeenCalledTimes(1)
    // The snapshot write inside loadProviderModels is fire-and-forget.
    await vi.waitFor(async () => {
      expect((await readCatalogSnapshot(catalogSnapshotName('command-code', 'prod'), countModels))?.fetchedAt).toBeGreaterThan(0)
    })

    // Simulate the next process: the in-memory cache starts cold again.
    commandCode.clearCachedCatalog()
    const fetchFn2 = vi.fn(async () => new Response('{}', { status: 500 }))
    const second = await commandCode.loadProviderModels({ fetchFn: fetchFn2 })
    expect(second.map((m) => m.id)).toEqual(['cc-1', 'cc-2'])
    // The stale answer came from the snapshot; the refresh ran behind it.
    expect(fetchFn2).toHaveBeenCalledTimes(1)
  })

  it('falls back to an empty listing without any snapshot', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 500 }))
    const result = await commandCode.loadProviderModels({ fetchFn })
    expect(result).toEqual([])
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})

describe('kimi-code persisted catalog', () => {
  const listing = {
    data: [
      { id: 'k3', context_length: 262_144 },
      { id: 'kimi-for-coding', context_length: 1_048_576 },
    ],
  }

  it('persists a fetched listing and serves it to the next process', async () => {
    // A store whose reads succeed without a real credential file, mirroring a
    // signed-in process (the real store reads a DPAPI/keychain blob).
    const store = new FileCredentialStore(path.join(os.tmpdir(), `kc-snap-${Date.now()}.json`))
    vi.spyOn(store, 'read').mockResolvedValue({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      expiresIn: 86_400,
      region: 'global',
      oauthHost: 'https://auth.kimi.com',
      baseUrl: 'https://api.kimi.com/coding',
    })
    vi.spyOn(store, 'write').mockResolvedValue(undefined)
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(listing), { status: 200 }))

    const first = await kimi.loadProviderModels({ fetchFn, region: 'global', store })
    expect(first.map((m) => m.id)).toEqual(['k3', 'kimi-for-coding'])
    // The snapshot write inside loadProviderModels is fire-and-forget.
    await vi.waitFor(async () => {
      expect((await readCatalogSnapshot(catalogSnapshotName('kimi-code', 'global'), countModels))?.fetchedAt).toBeGreaterThan(0)
    })

    // Simulate the next process: no store to acquire a token from, yet the
    // persisted listing still answers — that is the fix, no network in the
    // cold path.
    kimi.clearCachedCatalog()
    const fetchFn2 = vi.fn(async () => new Response('{}', { status: 500 }))
    const second = await kimi.loadProviderModels({ fetchFn: fetchFn2, region: 'global' })
    expect(second.map((m) => m.id)).toEqual(['k3', 'kimi-for-coding'])
  })

  it('returns nothing when no snapshot exists and no store is available', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 500 }))
    expect(await kimi.loadProviderModels({ fetchFn, region: 'global' })).toEqual([])
  })

  it('never serves one region a snapshot fetched for another', async () => {
    // A snapshot that exists only under the mainland-cn scope. The global
    // caller must not be answered by it: the regions are different services,
    // so a cn model id and context window are not a global model. Serving it
    // also skipped the credential read that would have named the real account.
    await writeRaw(catalogSnapshotName('kimi-code', 'mainland-cn'), {
      fetchedAt: Date.now(),
      models: [{ id: 'cn-only', contextWindow: 262_144 }],
    })
    const fetchFn = vi.fn(async () => new Response('{}', { status: 500 }))
    expect(await kimi.loadProviderModels({ fetchFn, region: 'global' })).toEqual([])
    // ...while its own region still rehydrates it.
    kimi.clearCachedCatalog()
    const sameRegion = await kimi.loadProviderModels({ fetchFn, region: 'mainland-cn' })
    expect(sameRegion.map((m) => m.id)).toEqual(['cn-only'])
  })
})

describe('workbuddy persisted catalog', () => {
  const credentials = {
    accessToken: 'at',
    refreshToken: 'rt',
    region: 'intl' as const,
    domain: 'intl.example.com',
    backend: 'https://intl.example.com',
    expiresAt: 0,
    source: 'managed' as const,
    sourceFile: 'managed',
    sourceMtimeMs: 0,
  }

  it('persists a fetched listing and serves it to the next process', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      data: { models: [{ id: 'wb-1', name: 'WB 1', maxAllowedSize: 200_000 }] },
    }), { status: 200 }))

    const first = await workbuddy.loadConfigCatalog(credentials, { fetchFn })
    expect(first.map((m) => m.id)).toEqual(['wb-1'])
    // The snapshot write inside loadConfigCatalog is fire-and-forget.
    await vi.waitFor(async () => {
      expect((await readCatalogSnapshot(catalogSnapshotName('workbuddy', 'intl'), countModels))?.fetchedAt).toBeGreaterThan(0)
    })

    workbuddy.clearCachedCatalog()
    const fetchFn2 = vi.fn(async () => new Response('{}', { status: 500 }))
    const second = await workbuddy.loadConfigCatalog(credentials, { fetchFn: fetchFn2 })
    expect(second.map((m) => m.id)).toEqual(['wb-1'])
  })

  it('never serves one region a snapshot fetched for another', async () => {
    // A snapshot written under the *cn* scope, which the intl caller must not
    // even look at: it falls back rather than offering cn-only models.
    await writeRaw(catalogSnapshotName('workbuddy', 'cn'), {
      fetchedAt: Date.now(),
      models: [{ id: 'cn-only', name: 'CN', region: 'cn', contextWindow: 1 }],
    })
    const fetchFn = vi.fn(async () => new Response('{}', { status: 500 }))
    const result = await workbuddy.loadConfigCatalog(credentials, { fetchFn })
    expect(result).toEqual([])
  })
})

describe('catalogSnapshotName', () => {
  it('keeps each scope in its own file under storages', () => {
    expect(catalogSnapshotName('kimi-code', 'global')).not.toBe(catalogSnapshotName('kimi-code', 'mainland-cn'))
    expect(catalogSnapshotName('command-code', 'prod')).not.toBe(catalogSnapshotName('command-code', 'staging'))
    expect(catalogSnapshotName('workbuddy', 'intl')).not.toBe(catalogSnapshotName('workbuddy', 'cn'))
  })

  it('folds a scope that could not be a file name into one that is', () => {
    // A scope is never a path fragment: separators and traversal are folded,
    // so no scope can write outside `storages`.
    expect(catalogSnapshotName('kimi-code', '../evil')).toBe('kimi-code-evil')
    expect(catalogSnapshotName('kimi-code', 'a/b')).toBe('kimi-code-a_b')
    const path1 = catalogSnapshotPath(catalogSnapshotName('kimi-code', '../evil'))
    expect(path.basename(path1)).toBe('kimi-code-evil-catalog.json')
  })
})

describe('rehydrateCatalogCache', () => {
  it('accepts only a snapshot fresher than the current cache', async () => {
    await writeCatalogSnapshot('test-d', [{ id: 'm1' }], 2_000)
    let accepted: unknown = null
    const at = await rehydrateCatalogCache(
      'test-d',
      (value) => value as Array<{ id: string }>,
      (fetchedAt, models) => {
        accepted = { fetchedAt, models }
      },
      5_000,
    )
    expect(at).toBe(0)
    expect(accepted).toBeNull()

    const at2 = await rehydrateCatalogCache(
      'test-d',
      (value) => value as Array<{ id: string }>,
      (fetchedAt, models) => {
        accepted = { fetchedAt, models }
      },
      1_000,
    )
    expect(at2).toBe(2_000)
    expect(accepted).toEqual({ fetchedAt: 2_000, models: [{ id: 'm1' }] })
  })
})
