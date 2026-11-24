import fs from 'node:fs/promises'
import type { RelayOneCatalogDto } from '../../shared/relayone-contracts.ts'
import {
  catalogSnapshotName,
  catalogSnapshotPath,
  readCatalogSnapshot,
  writeCatalogSnapshot,
} from '../common/catalog-snapshot.ts'
import {
  mergeRelayOneCatalog,
  parsePersistedRelayOneModelEntries,
  persistedRelayOneModelRecord,
  relayOneCatalogFingerprint,
  relayOneCatalogGroups,
  type RelayOneModelEntry,
} from './model-catalog.ts'
import {
  relayOneCredentialFingerprint,
  type RelayOneCredentialStore,
  type RelayOneCredentials,
} from './token-store.ts'
import type { RelayOneAccountPool } from './account-pool.ts'
import {
  RELAYONE_CATALOG_TTL_MS,
  RELAYONE_MODELS_URL,
  RELAYONE_PRICING_URL,
  relayOneHeaders,
  relayOneSafeDetail,
} from './types.ts'

/**
 * The key the catalog is currently scoped to.
 *
 * A pool answers with the digest of whichever account would serve the next
 * request, which is what every snapshot name and every change-detection check
 * below already keys on: listing models is not metered, so the pool's
 * routing state is deliberately not consulted here.
 */
async function catalogCredentials(
  source: RelayOneCredentialStore | RelayOneAccountPool,
): Promise<{ credentials: RelayOneCredentials | null }> {
  if ('stableCredential' in source) return { credentials: await source.stableCredential().catch(() => null) }
  return { credentials: await source.read().catch(() => null) }
}

export interface RelayOneCatalogSnapshot {
  entries: readonly RelayOneModelEntry[]
  fetchedAt: number | null
  error: string | null
  state: RelayOneCatalogDto['state']
  credentialScope: string | null
}
export interface RelayOneCatalogManagerOptions {
  fetchFn?: typeof fetch
  now?: () => number
  ttlMs?: number
  onChanged?: (entries: readonly RelayOneModelEntry[]) => void
}

async function responseJson(response: Response, apiKey: string): Promise<unknown> {
  const raw = await response.text()
  if (!response.ok) throw new Error('RelayOne catalog request failed (' + response.status + ')' + (raw ? ': ' + relayOneSafeDetail(raw, apiKey, 500) : '.'))
  try { return JSON.parse(raw) as unknown }
  catch { throw new Error('RelayOne catalog returned malformed JSON.') }
}

/** Live, credential-scoped model catalog with local-first rehydration. */
export class RelayOneCatalogManager {
  private readonly fetchFn: typeof fetch
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly onChanged: (entries: readonly RelayOneModelEntry[]) => void
  private entries: readonly RelayOneModelEntry[] = []
  private fetchedAt: number | null = null
  private error: string | null = null
  private state: RelayOneCatalogDto['state'] = 'idle'
  private credentialScope: string | null = null
  private warmedScope: string | null = null
  private warming: Promise<string> | null = null
  private refreshing: Promise<boolean> | null = null
  private refreshScope: string | null = null
  private epoch = 0

  constructor(
    private readonly store: RelayOneCredentialStore | RelayOneAccountPool,
    options: RelayOneCatalogManagerOptions = {},
  ) {
    this.fetchFn = options.fetchFn ?? fetch
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? RELAYONE_CATALOG_TTL_MS
    this.onChanged = options.onChanged ?? (() => undefined)
  }

  snapshot(): RelayOneCatalogSnapshot {
    return {
      entries: this.entries,
      fetchedAt: this.fetchedAt,
      error: this.error,
      state: this.state,
      credentialScope: this.credentialScope,
    }
  }

  dto(): RelayOneCatalogDto {
    return {
      state: this.state,
      fetchedAt: this.fetchedAt,
      error: this.error,
      groups: relayOneCatalogGroups(this.entries),
    }
  }

  reset(): void {
    this.epoch += 1
    this.entries = []
    this.fetchedAt = null
    this.error = null
    this.state = 'idle'
    this.credentialScope = null
    this.warmedScope = null
    this.warming = null
    this.refreshing = null
    this.refreshScope = null
  }

  /** Local disk only. Returns the post-rehydration fingerprint, never the pre-warm one. */
  warm(): Promise<string> {
    if (this.warming !== null) return this.warming
    const epoch = this.epoch
    this.warming = (async () => {
      const { credentials } = await catalogCredentials(this.store)
      if (credentials === null) {
        if (epoch === this.epoch) {
          this.entries = []
          this.fetchedAt = null
          this.credentialScope = null
          this.warmedScope = null
          this.state = 'idle'
        }
        return relayOneCatalogFingerprint([])
      }
      const scope = relayOneCredentialFingerprint(credentials)
      if (epoch !== this.epoch) return relayOneCatalogFingerprint(this.entries)
      if (this.warmedScope === scope && this.credentialScope === scope) return relayOneCatalogFingerprint(this.entries)
      if (this.credentialScope !== null && this.credentialScope !== scope) {
        this.entries = []
        this.fetchedAt = null
        this.error = null
      }
      this.credentialScope = scope
      const before = relayOneCatalogFingerprint(this.entries)
      const snapshot = await readCatalogSnapshot(
        catalogSnapshotName('relayone', scope),
        parsePersistedRelayOneModelEntries,
      )
      if (epoch !== this.epoch) return relayOneCatalogFingerprint(this.entries)
      if (snapshot !== undefined) {
        this.entries = snapshot.models
        this.fetchedAt = snapshot.fetchedAt
        this.state = 'ready'
        this.error = null
      } else {
        this.entries = []
        this.fetchedAt = null
        this.state = 'idle'
      }
      this.warmedScope = scope
      const after = relayOneCatalogFingerprint(this.entries)
      if (before !== after) this.onChanged(this.entries)
      return after
    })().finally(() => { if (epoch === this.epoch) this.warming = null })
    return this.warming
  }

  startRefresh(force = false): void {
    void this.refresh(force).catch(() => undefined)
  }

  /** Network refresh, deduplicated per credential. Never waits in warm(). */
  async refresh(force = false): Promise<boolean> {
    await this.warm()
    const { credentials } = await catalogCredentials(this.store)
    if (credentials === null) return false
    const scope = relayOneCredentialFingerprint(credentials)
    if (this.credentialScope !== null && this.credentialScope !== scope) {
      this.entries = []
      this.fetchedAt = null
      this.warmedScope = scope
    }
    this.credentialScope = scope
    if (!force && this.fetchedAt !== null && this.now() - this.fetchedAt < this.ttlMs) return false
    if (this.refreshing !== null && this.refreshScope === scope) return this.refreshing
    const epoch = this.epoch
    const before = relayOneCatalogFingerprint(this.entries)
    const promise = (async (): Promise<boolean> => {
      try {
        const [modelsResult, pricingResult] = await Promise.allSettled([
          this.fetchFn(RELAYONE_MODELS_URL, { headers: relayOneHeaders(credentials.apiKey, false) }),
          this.fetchFn(RELAYONE_PRICING_URL, { headers: { accept: 'application/json', 'user-agent': 'dsh-chatgpt-subscription' } }),
        ])
        if (modelsResult.status === 'rejected') throw modelsResult.reason
        const listing = await responseJson(modelsResult.value, credentials.apiKey)
        if (typeof listing !== 'object' || listing === null || !Array.isArray((listing as { data?: unknown }).data)) {
          throw new Error('RelayOne model listing is missing its data array.')
        }
        let pricing: unknown = undefined
        if (pricingResult.status === 'fulfilled' && pricingResult.value.ok) {
          pricing = await pricingResult.value.json().catch(() => undefined)
        } else {
          await (pricingResult.status === 'fulfilled' ? pricingResult.value.body?.cancel().catch(() => undefined) : undefined)
        }
        const entries = mergeRelayOneCatalog(listing, pricing)
        if (epoch !== this.epoch || this.credentialScope !== scope) return false
        this.entries = entries
        this.fetchedAt = this.now()
        this.error = null
        this.state = 'ready'
        this.warmedScope = scope
        const after = relayOneCatalogFingerprint(entries)
        const snapshotName = catalogSnapshotName('relayone', scope)
        if (entries.length > 0) {
          await writeCatalogSnapshot(
            snapshotName,
            entries.map(persistedRelayOneModelRecord),
            this.fetchedAt,
          )
        } else {
          // A valid empty listing is authoritative; do not resurrect this key's old models on restart.
          await fs.unlink(catalogSnapshotPath(snapshotName)).catch(() => undefined)
        }
        if (before !== after) {
          this.onChanged(entries)
          return true
        }
        return false
      } catch (error) {
        if (epoch === this.epoch && this.credentialScope === scope) {
          this.error = relayOneSafeDetail(error, credentials.apiKey)
          this.state = this.entries.length > 0 ? 'stale' : 'error'
        }
        return false
      }
    })().finally(() => {
      if (this.refreshing === promise) {
        this.refreshing = null
        this.refreshScope = null
      }
    })
    this.refreshing = promise
    this.refreshScope = scope
    return promise
  }
}
