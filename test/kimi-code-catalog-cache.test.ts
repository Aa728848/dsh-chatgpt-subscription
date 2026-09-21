/**
 * Regression tests for the per-model credential read in the Kimi Code catalog.
 *
 * `loadProviderModels` used to acquire an access token before consulting its
 * 30-minute catalog cache. Acquiring a token reads the credential store, which
 * on Windows is a DPAPI unprotect through a spawned `powershell.exe` (~200 ms).
 * DSH resolves every model of every registered provider when it builds the
 * picker catalog, and each resolution calls in here, so a warm catalog still
 * cost one process launch per model — the picker took seconds to open and never
 * got faster on a second open.
 *
 * These tests pin the ordering, not the wall-clock: the credential store is
 * wrapped so any read is counted, and the cache is asserted to serve a repeated
 * call with zero reads.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import {
  clearCachedCatalog,
  loadProviderModels,
} from '../src/host/kimi-code/client.ts'
import { FileCredentialStore } from '../src/host/kimi-code/token-store.ts'
import type { KimiCodeCredentials } from '../src/host/kimi-code/token-store.ts'

function tmp(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

function credentials(overrides: Partial<KimiCodeCredentials> = {}): KimiCodeCredentials {
  return {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    expiresIn: 86_400,
    region: 'mainland-cn',
    oauthHost: 'https://auth.kimi.com',
    baseUrl: 'https://api.kimi.com/coding',
    ...overrides,
  }
}

/** A live listing in the shape the endpoint documents. */
function listingResponse(): Response {
  return new Response(JSON.stringify({
    data: [
      { id: 'k3', context_length: 262_144 },
      { id: 'kimi-for-coding', context_length: 1_048_576 },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

/**
 * Build a credential store whose `read` is counted.
 *
 * The count is the assertion surface: one read is one DPAPI process launch on
 * Windows, which is exactly the cost this fix removes.
 */
function countedStore() {
  const store = new FileCredentialStore(tmp('kc-cache-cred'))
  const read = vi.spyOn(store, 'read').mockResolvedValue(credentials())
  vi.spyOn(store, 'write').mockResolvedValue(undefined)
  return { store, reads: () => read.mock.calls.length }
}

afterEach(() => {
  clearCachedCatalog()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Kimi Code catalog caching', () => {
  it('serves a warm catalog without reading credentials again', async () => {
    const { store, reads } = countedStore()
    const fetchFn = vi.fn(async () => listingResponse())

    const first = await loadProviderModels({ store, fetchFn, region: 'mainland-cn' })
    expect(first.map((model) => model.id)).toEqual(['k3', 'kimi-for-coding'])
    expect(fetchFn).toHaveBeenCalledTimes(1)

    const readsAfterFirst = reads()
    expect(readsAfterFirst).toBeGreaterThan(0)

    // The repeat is what the harness does for every further model.
    const second = await loadProviderModels({ store, fetchFn, region: 'mainland-cn' })
    expect(second).toEqual(first)

    // The cache answered, so neither the store nor the network was touched.
    expect(reads()).toBe(readsAfterFirst)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('keeps many resolutions down to a single credential read', async () => {
    const { store, reads } = countedStore()
    const fetchFn = vi.fn(async () => listingResponse())

    const models = await loadProviderModels({ store, fetchFn, region: 'mainland-cn' })
    const readsAfterListing = reads()

    // Model the harness loop: one catalog lookup per model.
    for (const model of models) {
      await loadProviderModels({ store, fetchFn, region: 'mainland-cn' })
    }

    expect(reads()).toBe(readsAfterListing)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('still refetches when the caller forces a refresh', async () => {
    const { store } = countedStore()
    const fetchFn = vi.fn(async () => listingResponse())

    await loadProviderModels({ store, fetchFn, region: 'mainland-cn' })
    await loadProviderModels({ store, fetchFn, region: 'mainland-cn', force: true })

    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('does not serve one region a catalog fetched for another', async () => {
    const { store } = countedStore()
    const fetchFn = vi.fn(async () => listingResponse())

    await loadProviderModels({ store, fetchFn, region: 'mainland-cn' })
    await loadProviderModels({ store, fetchFn, region: 'global' })

    // A different region must not be answered from the other region's cache.
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('serves a cached listing to a token-bearing caller', async () => {
    const { store } = countedStore()
    const fetchFn = vi.fn(async () => listingResponse())

    await loadProviderModels({ store, fetchFn, region: 'mainland-cn' })
    const again = await loadProviderModels({ store, accessToken: 'at-1', fetchFn, region: 'mainland-cn' })

    expect(again.map((model) => model.id)).toEqual(['k3', 'kimi-for-coding'])
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('returns no models without a store to acquire a token from', async () => {
    const fetchFn = vi.fn(async () => listingResponse())

    expect(await loadProviderModels({ fetchFn, region: 'mainland-cn' })).toEqual([])
    expect(fetchFn).not.toHaveBeenCalled()
  })
})