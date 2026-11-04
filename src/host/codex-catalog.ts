import { catalogSnapshotName, readCatalogSnapshot, writeCatalogSnapshot } from './common/catalog-snapshot.ts'
import { CODEX_MODELS_URL } from '../compat.ts'
import { CODEX_MODEL_CATALOG } from '../shared/model-catalog.ts'
import { codexAccountIdentity } from './codex-identity.ts'
import type { StoredOAuthCredentials } from './token-store.ts'
import { codexHeaders } from './wire-auth.ts'

type FetchLike = typeof fetch

/** How long a live listing is reused before the server is asked again. */
const CATALOG_TTL_MS = 15 * 60_000
/** Network budget for one listing call; a slow endpoint must not block a picker. */
const DISCOVERY_TIMEOUT_MS = 15_000
/**
 * Snapshot scope.
 *
 * The Codex listing is account-scoped (each plan sees its own models), so the
 * persisted snapshot is filed under the account it was fetched for. Without the
 * scope a rehydrated listing from one account would answer another's picker.
 */
const SNAPSHOT_SCOPE = 'chatgpt-codex'

/** One model as the live listing describes it. */
export interface CodexCatalogEntry {
  id: string
  name: string
  /** Window the listing stated, or null when it stated none. */
  contextWindow: number | null
  inputModalities: readonly ('text' | 'image')[]
  /** Reasoning levels the listing says the model accepts; absent when it stated none. */
  reasoningEfforts?: readonly string[]
  defaultReasoningEffort?: string | null
  /**
   * Whether the listing says the model speaks the Responses Lite protocol.
   *
   * `undefined` when the listing stated nothing: the live listing is the
   * authority on what this plan serves, but it is not the authority on what a
   * model this line has never heard of speaks, so an absent flag falls back to
   * the shipped table instead of being read as "not Lite".
   */
  useResponsesLite?: boolean
}

interface CatalogCache {
  at: number
  models: readonly CodexCatalogEntry[]
  key: string
  /** False when these entries are the shipped table standing in for a failed call. */
  live: boolean
}

/**
 * How many accounts' listings are held at once.
 *
 * One slot was enough while a workspace id was mistaken for an account, because
 * every member of a workspace then shared one. It is not enough now: a pool
 * rotates between accounts, and a single slot would have each rotation evict the
 * other account's listing and re-fetch it, which turns the 15-minute TTL into
 * "no cache at all" for exactly the multi-account setup this line supports. The
 * bound is the pool's own order of magnitude, so a real composition always fits
 * and a pathological one only loses the coldest entry.
 */
const CATALOG_CACHE_ACCOUNTS = 8

/** Listings held per login identity; see {@link CATALOG_CACHE_ACCOUNTS}. */
const catalogCache = new Map<string, CatalogCache>()
/** The entry {@link getCachedCatalog} answers with: the one a load last wrote. */
let latestKey: string | null = null
const catalogInFlight = new Map<string, Promise<readonly CodexCatalogEntry[]>>()
/** Snapshots already read back from disk, per identity. */
const snapshotRehydrated = new Map<string, Promise<void>>()

/** Drop the cached listing, forcing the next load to hit the network. */
export function clearCachedCatalog(): void {
  catalogCache.clear()
  catalogInFlight.clear()
  latestKey = null
}

/**
 * The listing currently held, or undefined before the first load.
 *
 * "Currently held" is the entry a load wrote last: a picker asks what the
 * account serving it can call, and that is the account whose listing was fetched
 * most recently. Callers that need a catalog with no credential read the shipped
 * table directly; returning it here under a different entry type would force
 * every one of them to convert it.
 */
export function getCachedCatalog(): readonly CodexCatalogEntry[] | undefined {
  return latestKey === null ? undefined : catalogCache.get(latestKey)?.models
}

/** Whether the held listing is the shipped table standing in for a failed call. */
export function isCatalogFallback(): boolean {
  const latest = latestKey === null ? undefined : catalogCache.get(latestKey)
  return latest !== undefined && !latest.live
}

export interface CodexCatalogLoadOptions {
  fetchFn?: FetchLike
  signal?: AbortSignal
  /** Bypass the cached listing and read the server again. */
  force?: boolean
}

/**
 * Read the models this subscription can call.
 *
 * The shipped table in `shared/model-catalog.ts` stays the floor: it is what
 * answers a picker before the first sign-in, and what a failed listing falls
 * back to. The subscription listing is the authority once one is available,
 * because only the backend knows which models a plan currently serves and at
 * what context window — the reason subscription-only models exist at all.
 *
 * Single-flighted per account, because the harness resolves every model of every
 * provider when it builds the picker; without that, one picker build is one
 * round trip per model.
 */
export function loadCodexCatalog(
  credentials: StoredOAuthCredentials,
  options: CodexCatalogLoadOptions = {},
): Promise<readonly CodexCatalogEntry[]> {
  const key = accountKeyFor(credentials)
  if (options.force !== true) {
    const cached = catalogCache.get(key)
    if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) {
      latestKey = key
      return Promise.resolve(cached.models)
    }
  }
  const pending = catalogInFlight.get(key)
  if (pending !== undefined) return pending

  const run = performCatalogLoad(credentials, options).then(
    (models) => {
      catalogInFlight.delete(key)
      return models
    },
    (error: unknown) => {
      catalogInFlight.delete(key)
      throw error
    },
  )
  catalogInFlight.set(key, run)
  return run
}

async function performCatalogLoad(
  credentials: StoredOAuthCredentials,
  options: CodexCatalogLoadOptions,
): Promise<readonly CodexCatalogEntry[]> {
  const key = accountKeyFor(credentials)
  const fetchFn = options.fetchFn ?? fetch

  // Rehydrate the persisted listing once per identity so the first picker after a
  // restart answers from disk instead of waiting on the network. Per identity, not
  // per process: each login has its own snapshot file, and rehydrating only
  // whichever account happened to ask first left every other account cold.
  let rehydrated = snapshotRehydrated.get(key)
  if (rehydrated === undefined) {
    rehydrated = rehydrateSnapshot(key)
    snapshotRehydrated.set(key, rehydrated)
  }
  await rehydrated

  const cached = catalogCache.get(key)
  if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) {
    latestKey = key
    return cached.models
  }

  let models: readonly CodexCatalogEntry[]
  let live = false
  try {
    const response = await fetchFn(CODEX_MODELS_URL, {
      method: 'GET',
      headers: { ...codexHeaders(credentials), accept: 'application/json' },
      signal: options.signal,
    })
    if (!response.ok) throw new Error(`Codex model listing failed (${response.status}).`)
    const payload: unknown = await response.json().catch(() => undefined)
    const listing = parseListing(payload)
    if (listing.length === 0) throw new Error('Codex model listing named no models this line understands.')
    models = listing
    live = true
    // Persist only a live listing: a failed call must not overwrite a good
    // snapshot with the shipped table.
    void writeCatalogSnapshot(catalogSnapshotName(SNAPSHOT_SCOPE, key), [...models], Date.now())
  } catch {
    // A failed call answers with what is already held FOR THIS IDENTITY, which may
    // be nothing — and the callers read that as "use the shipped table". It must
    // not be some other account's listing: filing the fallback under whatever the
    // cache held last would serve one member of a workspace the models another
    // member's plan fetched, which is the mix-up the identity split exists to end.
    models = catalogCache.get(key)?.models ?? []
    live = false
  }
  remember(key, { at: Date.now(), models, key, live })
  return models
}

/**
 * File one listing under its identity, keeping the map bounded.
 *
 * Eviction is oldest-fetch-first, which is the entry a rotation is least likely to
 * ask for next; the bound exists so a composition that signs in far more accounts
 * than the pool holds cannot grow this map without end.
 */
function remember(key: string, entry: CatalogCache): void {
  catalogCache.set(key, entry)
  latestKey = key
  while (catalogCache.size > CATALOG_CACHE_ACCOUNTS) {
    const oldest = [...catalogCache.entries()]
      .filter(([candidate]) => candidate !== key)
      .sort((left, right) => left[1].at - right[1].at)[0]
    if (oldest === undefined) break
    catalogCache.delete(oldest[0])
  }
}

/**
 * Seed the in-memory cache from the last persisted listing.
 *
 * Best effort by construction: a missing or malformed snapshot leaves the cache
 * cold, and the caller then simply makes the network call.
 */
async function rehydrateSnapshot(key: string): Promise<void> {
  const snapshot = await readCatalogSnapshot(
    catalogSnapshotName(SNAPSHOT_SCOPE, key),
    (value) => (Array.isArray(value) ? value.flatMap((item) => parseListingEntry(item)) : undefined),
  ).catch(() => undefined)
  if (snapshot === undefined || snapshot.models.length === 0) return
  // A listing already in memory wins: it is this process's newest answer for this
  // identity, and a restart is the only case where the file is newer than nothing.
  if (catalogCache.has(key)) return
  remember(key, { at: snapshot.fetchedAt, models: snapshot.models, key, live: true })
}

/**
 * Read the listing payload.
 *
 * The documented shape is `{ models: [...] }`, but a bare array is accepted too
 * so a backend that flattens the envelope does not read as an empty catalog.
 */
export function parseListing(payload: unknown): CodexCatalogEntry[] {
  const record = asRecord(payload)
  const models = Array.isArray(payload) ? payload : record?.models
  if (!Array.isArray(models)) return []
  return models.flatMap((item) => parseListingEntry(item))
}

/**
 * One listing entry.
 *
 * Only fields the backend actually documents are read. A model id this line has
 * never heard of still produces an entry, because the listing is the authority
 * on what the account may call — but every capability it does not state falls
 * back to a conservative answer rather than to a guess.
 */
function parseListingEntry(value: unknown): CodexCatalogEntry[] {
  const record = asRecord(value)
  if (record === undefined) return []
  const id = asString(record.slug) ?? asString(record.id)
  if (id === undefined) return []
  const contextWindow = asNumber(record.context_window) ?? asNumber(record.contextWindow)
  const modalities = parseModalities(record.input_modalities)
  const efforts = parseEfforts(record.supported_reasoning_levels)
  const useResponsesLite = typeof record.use_responses_lite === 'boolean'
    ? record.use_responses_lite
    : typeof record.useResponsesLite === 'boolean' ? record.useResponsesLite : undefined
  const fallback = CODEX_MODEL_CATALOG.find((entry) => entry.id === id)
  return [{
    id,
    name: asString(record.display_name) ?? asString(record.displayName) ?? fallback?.name ?? id,
    contextWindow: contextWindow !== undefined && contextWindow > 0 ? contextWindow : null,
    // Absent modalities: the shipped table's answer for a known model, else text
    // only, which is the narrower of the two and cannot overstate a capability.
    inputModalities: modalities ?? (fallback ? [...fallback.inputModalities] : ['text']),
    // `undefined`, not null: an absent list means "the listing stated none",
    // and the resolver must then fall back to the shipped profile.
    ...(efforts !== null ? { reasoningEfforts: efforts } : {}),
    defaultReasoningEffort: asString(record.default_reasoning_level) ?? fallback?.defaultReasoningEffort ?? null,
    // Only a stated boolean counts. A listing that omits the flag has not said
    // the model is not Lite - it has said nothing, and the shipped table is
    // then the only source that knows.
    ...(useResponsesLite !== undefined ? { useResponsesLite } : {}),
  }]
}

function parseModalities(value: unknown): ('text' | 'image')[] | null {
  if (!Array.isArray(value)) return null
  const out: ('text' | 'image')[] = []
  for (const item of value) {
    const name = asString(item)
    if (name === 'text' || name === 'image') out.push(name)
  }
  return out.length > 0 ? out : null
}

/**
 * Reasoning levels the listing states, in the order it stated them.
 *
 * The backend writes each level as `{ "effort": "high" }`; a bare string is
 * accepted too, since that is the other spelling seen in the wild.
 */
function parseEfforts(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const item of value) {
    const effort = asString(item) ?? asString(asRecord(item)?.effort)
    if (effort !== undefined && !out.includes(effort)) out.push(effort)
  }
  return out.length > 0 ? out : null
}

/**
 * Cache identity for one credential.
 *
 * The listing is served per PLAN, and a plan belongs to the local login — the
 * workspace id alone is not an identity here either: two members of one workspace
 * can hold different plans, so filing both listings under the workspace would let
 * one member's picker answer with models the other member's plan does not serve.
 * The key is therefore the same composite identity the pool dedupes on, and its
 * digest form is what keeps the persisted snapshot's file name both distinct after
 * `catalogSnapshotName` folds it and free of an email address.
 *
 * `'default'` answers a credential that states nothing about itself, which is the
 * single pre-sign-in case this loader ever sees.
 */
function accountKeyFor(credentials: StoredOAuthCredentials): string {
  return codexAccountIdentity(credentials) ?? 'default'
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
