import { catalogSnapshotName, readCatalogSnapshot, writeCatalogSnapshot } from './common/catalog-snapshot.ts'
import { CODEX_MODELS_URL } from '../compat.ts'
import { CODEX_MODEL_CATALOG } from '../shared/model-catalog.ts'
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
}

interface CatalogCache {
  at: number
  models: readonly CodexCatalogEntry[]
  key: string
  /** False when these entries are the shipped table standing in for a failed call. */
  live: boolean
}

let catalogCache: CatalogCache | null = null
const catalogInFlight = new Map<string, Promise<readonly CodexCatalogEntry[]>>()
let snapshotRehydrated: Promise<void> | null = null

/** Drop the cached listing, forcing the next load to hit the network. */
export function clearCachedCatalog(): void {
  catalogCache = null
  catalogInFlight.clear()
}

/**
 * The listing currently held, or undefined before the first load.
 *
 * Callers that need a catalog with no credential read the shipped table
 * directly; returning it here under a different entry type would force every
 * one of them to convert it.
 */
export function getCachedCatalog(): readonly CodexCatalogEntry[] | undefined {
  return catalogCache?.models
}

/** Whether the held listing is the shipped table standing in for a failed call. */
export function isCatalogFallback(): boolean {
  return catalogCache !== null && !catalogCache.live
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
    const cached = catalogCache
    if (cached !== null && cached.key === key && Date.now() - cached.at < CATALOG_TTL_MS) {
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

  // Rehydrate the persisted listing once per process so the first picker after a
  // restart answers from disk instead of waiting on the network.
  snapshotRehydrated ??= rehydrateSnapshot(key)
  await snapshotRehydrated

  const cached = catalogCache
  if (cached !== null && cached.key === key && Date.now() - cached.at < CATALOG_TTL_MS) {
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
    // A failed call answers with whatever is already held, which may be
    // nothing — and the callers read that as "use the shipped table".
    models = getCachedCatalog() ?? []
    live = false
  }
  catalogCache = { at: Date.now(), models, key, live }
  return models
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
  if (catalogCache !== null) return
  catalogCache = { at: snapshot.fetchedAt, models: snapshot.models, key, live: true }
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
 * The account id is the entitlement boundary: two accounts of the same user can
 * see different listings, and a pool rotates between them, so the key has to
 * follow the account rather than the person.
 */
function accountKeyFor(credentials: StoredOAuthCredentials): string {
  return credentials.accountId || 'default'
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
