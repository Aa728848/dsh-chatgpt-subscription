import fs from 'node:fs/promises'
import type { ClaudeApiCatalogDto } from '../../../shared/claude-api-contracts.ts'
import {
  catalogSnapshotName,
  catalogSnapshotPath,
  readCatalogSnapshot,
  writeCatalogSnapshot,
} from '../../common/catalog-snapshot.ts'
import { listClaudeApiModels } from './client.ts'
import { ClaudeApiClientVersionResolver } from './client-version.ts'
import {
  claudeApiFallbackEntries,
  parsePersistedClaudeApiModelEntries,
  persistedClaudeApiModelRecord,
  type ClaudeApiModelEntry,
} from './model-catalog.ts'
import {
  claudeApiCredentialFingerprint,
  type ClaudeApiCredentialStore,
  type ClaudeApiSettingsStore,
} from './token-store.ts'
import { CLAUDE_API_CATALOG_TTL_MS, claudeApiSafeDetail } from './types.ts'

export interface ClaudeApiCatalogSnapshot {
  entries: readonly ClaudeApiModelEntry[]
  fetchedAt: number | null
  error: string | null
  state: ClaudeApiCatalogDto['state']
  credentialScope: string | null
  /** false while entries are the shipped fallback table rather than a listing this key produced. */
  live: boolean
}

export interface ClaudeApiCatalogManagerOptions {
  /** Supplies the client version the listing request reports. */
  version: ClaudeApiClientVersionResolver
  fetchFn?: typeof fetch
  now?: () => number
  ttlMs?: number
  onChanged?: (entries: readonly ClaudeApiModelEntry[]) => void
}

/** Content fingerprint: a cache hit returns the same array, so reference equality never sees a change. */
function fingerprint(entries: readonly ClaudeApiModelEntry[]): string {
  return JSON.stringify(entries)
}

/**
 * Live, credential-and-endpoint-scoped model catalog with local-first rehydration.
 *
 * Before any listing this key produced, the catalog is the shipped fallback table
 * and is reported as NOT live, so a user's whitelist never filters it away.
 */
export class ClaudeApiCatalogManager {
  private readonly version: ClaudeApiClientVersionResolver
  private readonly fetchFn: typeof fetch
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly onChanged: (entries: readonly ClaudeApiModelEntry[]) => void
  private entries: readonly ClaudeApiModelEntry[] = claudeApiFallbackEntries()
  private fetchedAt: number | null = null
  private error: string | null = null
  private state: ClaudeApiCatalogDto['state'] = 'idle'
  private live = false
  private credentialScope: string | null = null
  private warmedScope: string | null = null
  private warming: Promise<string> | null = null
  private refreshing: Promise<boolean> | null = null
  private refreshScope: string | null = null
  private epoch = 0

  constructor(
    private readonly store: ClaudeApiCredentialStore,
    private readonly settingsStore: ClaudeApiSettingsStore,
    options: ClaudeApiCatalogManagerOptions,
  ) {
    this.version = options.version
    this.fetchFn = options.fetchFn ?? fetch
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? CLAUDE_API_CATALOG_TTL_MS
    this.onChanged = options.onChanged ?? (() => undefined)
  }

  snapshot(): ClaudeApiCatalogSnapshot {
    return {
      entries: this.entries,
      fetchedAt: this.fetchedAt,
      error: this.error,
      state: this.state,
      credentialScope: this.credentialScope,
      live: this.live,
    }
  }

  dto(): ClaudeApiCatalogDto {
    return { state: this.state, fetchedAt: this.fetchedAt, error: this.error }
  }

  reset(): void {
    this.epoch += 1
    this.entries = claudeApiFallbackEntries()
    this.fetchedAt = null
    this.error = null
    this.state = 'idle'
    this.live = false
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
      const [credentials, settings] = await Promise.all([
        this.store.read().catch(() => null),
        this.settingsStore.read(),
      ])
      if (credentials === null) {
        if (epoch === this.epoch) {
          this.entries = claudeApiFallbackEntries()
          this.fetchedAt = null
          this.error = null
          this.credentialScope = null
          this.warmedScope = null
          this.state = 'idle'
          this.live = false
        }
        return fingerprint(this.entries)
      }
      // The endpoint is part of the scope: the same key against a gateway lists other models.
      const scope = claudeApiCredentialFingerprint(credentials, settings.baseUrl)
      if (epoch !== this.epoch) return fingerprint(this.entries)
      if (this.warmedScope === scope && this.credentialScope === scope) return fingerprint(this.entries)
      if (this.credentialScope !== null && this.credentialScope !== scope) {
        this.entries = claudeApiFallbackEntries()
        this.fetchedAt = null
        this.error = null
        this.live = false
      }
      this.credentialScope = scope
      const before = fingerprint(this.entries)
      const snapshot = await readCatalogSnapshot(
        catalogSnapshotName('claude-api', scope),
        parsePersistedClaudeApiModelEntries,
      )
      if (epoch !== this.epoch) return fingerprint(this.entries)
      if (snapshot !== undefined) {
        this.entries = snapshot.models
        this.fetchedAt = snapshot.fetchedAt
        this.state = 'ready'
        this.error = null
        this.live = true
      } else {
        this.entries = claudeApiFallbackEntries()
        this.fetchedAt = null
        this.state = 'idle'
        this.live = false
      }
      this.warmedScope = scope
      const after = fingerprint(this.entries)
      if (before !== after) this.onChanged(this.entries)
      return after
    })().finally(() => { if (epoch === this.epoch) this.warming = null })
    return this.warming
  }

  startRefresh(force = false): void {
    void this.refresh(force).catch(() => undefined)
  }

  /** Network refresh, deduplicated per credential scope. Never waits in warm(). */
  async refresh(force = false): Promise<boolean> {
    await this.warm()
    const [credentials, settings] = await Promise.all([
      this.store.read().catch(() => null),
      this.settingsStore.read(),
    ])
    if (credentials === null) return false
    const scope = claudeApiCredentialFingerprint(credentials, settings.baseUrl)
    if (this.credentialScope !== null && this.credentialScope !== scope) {
      this.entries = claudeApiFallbackEntries()
      this.fetchedAt = null
      this.live = false
      this.warmedScope = scope
    }
    this.credentialScope = scope
    if (!force && this.fetchedAt !== null && this.now() - this.fetchedAt < this.ttlMs) return false
    if (this.refreshing !== null && this.refreshScope === scope) return this.refreshing
    const epoch = this.epoch
    const before = fingerprint(this.entries)
    const promise = (async (): Promise<boolean> => {
      try {
        await this.version.warm()
        const entries = await listClaudeApiModels({
          baseUrl: settings.baseUrl,
          apiKey: credentials.apiKey,
          version: this.version.current().value,
          fetchFn: this.fetchFn,
        })
        if (epoch !== this.epoch || this.credentialScope !== scope) return false
        this.entries = entries
        this.fetchedAt = this.now()
        this.error = null
        this.state = 'ready'
        this.live = true
        this.warmedScope = scope
        const after = fingerprint(entries)
        const snapshotName = catalogSnapshotName('claude-api', scope)
        if (entries.length > 0) {
          await writeCatalogSnapshot(snapshotName, entries.map(persistedClaudeApiModelRecord), this.fetchedAt)
        } else {
          // A valid empty listing is authoritative; do not resurrect this scope's old models on restart.
          await fs.unlink(catalogSnapshotPath(snapshotName)).catch(() => undefined)
        }
        if (before !== after) {
          this.onChanged(entries)
          return true
        }
        return false
      } catch (error) {
        if (epoch === this.epoch && this.credentialScope === scope) {
          this.error = claudeApiSafeDetail(error, credentials.apiKey)
          // The fallback table is not a previous listing, so a first failure is an error, not staleness.
          this.state = this.live ? 'stale' : 'error'
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
