/**
 * Upstream HTTP surface of the Claude subscription line.
 *
 * WHAT THIS MODULE IS. Everything between "we hold a subscription OAuth
 * credential" and "a response came back": the request headers, the model
 * listing, the two independent sources of quota numbers, a one-shot
 * connectivity probe, and the classification of a failure. It owns no
 * credential lifecycle — refreshing is `oauth.ts`'s job, storage is
 * `token-store.ts`'s — so every entry point here takes an ALREADY-CURRENT
 * access token and never writes one back.
 *
 * Each behavioural claim below names the evidence behind it. Where the evidence
 * is a reading of the locally installed reference implementation it says so;
 * where it is this module's own judgement it says that instead, because a later
 * reviewer has to be able to tell the two apart. Nothing here asserts what an
 * endpoint returns without a fixture or a live read behind it.
 *
 * ---------------------------------------------------------------------------
 * 1. THE HEADERS, AND WHY `x-api-key` MUST NOT BE THERE
 * ---------------------------------------------------------------------------
 *
 * The subscription is not the Console API. The Console authenticates with
 * `x-api-key`; the subscription authenticates with an OAuth access token in
 * `Authorization: Bearer`. Sending BOTH is a documented 401 cause — the gateway
 * sees an API-key-shaped credential on a route that does not serve API keys and
 * refuses the request. So the builder below emits `authorization` and actively
 * removes any `x-api-key` that a caller's `extra` map tried to smuggle in:
 * a caller copying another provider's header map is exactly how that bug would
 * re-enter this codebase, and a silent 401 is a bad way to find out.
 *
 * The `user-agent` is load-bearing rather than cosmetic. Upstream enforces a
 * MINIMUM REPORTED CLIENT VERSION on this path: when the model being asked for
 * is newer than the version we claim to be, the request is refused with HTTP 400
 * and the body code `claude_code_version_too_old`
 * ({@link ERROR_CODE_CLIENT_VERSION_TOO_OLD}). The version therefore comes from
 * {@link claudeCliVersion} at CALL TIME rather than from a module constant, so a
 * `setClaudeCliVersion` pin or a `DSH_CLAUDE_CLI_VERSION` in the environment
 * takes effect on the very next request without a restart.
 *
 * `anthropic-beta` is cumulative: one request carries every marker that
 * applies. Three sources contribute, and only one of them is conditional on the
 * model — the reference's own rule is that a HAIKU model does NOT receive
 * `claude-code-20250219` while every other model does. The only offline signal
 * for that is the family token in the id itself.
 *
 * ---------------------------------------------------------------------------
 * 2. THE MODEL LISTING OVERRIDES THE CONTEXT WINDOW AND NOTHING ELSE
 * ---------------------------------------------------------------------------
 *
 * This is the invariant most worth protecting in this file. `GET /v1/models`
 * states which ids the ACCOUNT can call and how much context each one takes; it
 * says nothing about image support, about which thinking form a model needs, or
 * about the reasoning ladder it exposes. Those are per-model facts that
 * `model-catalog.ts` carries and that the family name does not decide — a
 * listing-driven merge that wrote capability fields would silently replace them
 * with `undefined` and produce requests the model rejects.
 *
 * So {@link loadCatalog} produces each entry as `{ ...catalogEntry,
 * contextWindow }`: ONE written field, everything else copied verbatim from the
 * frozen table (or from its conservative stub, for an id the table does not
 * know). A test asserts that a listing cannot change any other field.
 *
 * The failure path matters as much as the success path. DSH 0.1.7 makes "the
 * model must appear in the provider's catalog" a HARD GATE, so returning an
 * empty list when the listing call fails would not degrade the picker — it would
 * block model switching entirely, and it would do so while the account is
 * perfectly usable. Every failure therefore yields {@link FALLBACK_MODELS}.
 * An empty-but-successful listing is treated the same way, for the same reason.
 *
 * ---------------------------------------------------------------------------
 * 3. TWO QUOTA SOURCES IN TWO DIFFERENT UNITS — THE BUG THIS FILE EXISTS TO STOP
 * ---------------------------------------------------------------------------
 *
 * (a) PRIMARY, `GET /api/oauth/usage`. Each window is
 *     `{ utilization, resets_at }` and `utilization` is a PERCENT USED in
 *     0-100. `utilization: 0` means nothing has been used — the ordinary state
 *     of a healthy account — and is NOT an error and NOT "no quota left".
 *
 * (b) SECONDARY, the `anthropic-ratelimit-unified-*` response headers on ANY
 *     `/v1/messages` response including 200s.
 *     `...-5h-utilization` is a FRACTION in 0-1. Same word, different unit:
 *     `0.25` here and `25` there both mean "a quarter of the window is gone".
 *     `...-5h-reset` is epoch SECONDS — not milliseconds, and not ISO — while
 *     `resets_at` in (a) IS ISO 8601. A parser that treats the two as one
 *     number under-reports by 100x or over-reports by 100x depending on which
 *     direction it guessed, and the card shows a confident wrong number either
 *     way.
 *
 * The conversion happens at exactly TWO boundaries and nowhere else: the
 * header parser multiplies by 100 once, on the way in, and the body parser
 * divides by 100 once, on the way in. After that both are the same
 * {@link ClaudeUsageWindow}, and a test asserts that `0.25` in a header and
 * `25` in a body produce byte-identical windows.
 *
 * Header data is allowed to satisfy the composer badge — the badge only needs
 * the tightest window — but it must NOT permanently replace a full read. The
 * cache therefore tracks two instants: when any source last wrote
 * (`observedAt`, gated by {@link QUOTA_CACHE_TTL_MS}) and when a FULL read last
 * succeeded (`fetchedAt`, gated by {@link QUOTA_FULL_REFRESH_MS}). Header
 * updates advance only the first, so a stream of model calls cannot keep the
 * card warm forever behind stale numbers.
 *
 * Unknown keys in the usage payload are IGNORED. The response's key set varies
 * by account type and carries churning feature-flag codenames; a key this
 * module does not know is not a window, and a missing known key is not zero.
 *
 * ---------------------------------------------------------------------------
 * 4. FAILURE CLASSIFICATION
 * ---------------------------------------------------------------------------
 *
 * Anthropic reports the real condition in the body's `error.type` while the
 * HTTP status stays coarse, so the body is authoritative and the status is the
 * fallback. The one distinction the rest of the line depends on is inside
 * `rate_limit_error`: a 429 that names a SPENT WINDOW OF THIS ACCOUNT is fixed
 * by switching accounts, and a 429 that does not is not — switching accounts on
 * a global limit would burn every account in the pool against a wall none of
 * them can pass. That distinction is exported as a first-class value rather
 * than left for the caller to re-derive from headers.
 */

import {
  ANTHROPIC_VERSION,
  API_BASE,
  CATALOG_CACHE_TTL_MS,
  CLAUDE_CODE_BETA,
  DISCOVERY_TIMEOUT_MS,
  ERROR_CODE_CLIENT_VERSION_TOO_OLD,
  ERROR_TYPE,
  INTERLEAVED_THINKING_BETA,
  MESSAGES_PATH,
  MODELS_PATH,
  OAUTH_BETA,
  QUOTA_CACHE_TTL_MS,
  QUOTA_FULL_REFRESH_MS,
  USAGE_PATH,
  claudeCliVersion,
  isClaudeErrorType,
  type ClaudeErrorType,
} from './types.ts'
import { FALLBACK_MODELS, resolveClaudeModel, type ClaudeModelEntry } from './model-catalog.ts'
import type { ClaudeCredentials } from './token-store.ts'

// ---------------------------------------------------------------------------
// Small shape helpers
//
// Every parse in this file is defensive by construction: the payloads come off
// the wire and this line supports several harness generations, so a shape that
// is not what was documented has to degrade to "not stated" rather than throw
// somewhere the caller cannot see it.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

/** A non-blank string, or undefined. Numeric values are NOT coerced here. */
function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * A finite number, or undefined.
 *
 * A numeric STRING is accepted because a JSON payload is not the only thing
 * that reaches these parsers — a header value is a string by definition, and
 * `Number('')` is 0, which is why the blank check comes first.
 */
function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function timeoutSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
  return signal === undefined ? AbortSignal.timeout(ms) : AbortSignal.any([signal, AbortSignal.timeout(ms)])
}

/** Cache key for one credential: the tail of the token, never the whole thing. */
function accountKeyFor(credentials: Pick<ClaudeCredentials, 'accessToken'>): string {
  return credentials.accessToken.slice(-8)
}

/** Epoch ms added to a monotonic-ish clock read; kept in one place for tests. */
function now(): number {
  return Date.now()
}

// ---------------------------------------------------------------------------
// Request headers
// ---------------------------------------------------------------------------

/** A flat, lower-cased header map, ready for `fetch`. */
export type ClaudeRequestHeaders = Record<string, string>

/**
 * Which product string a request reports as.
 *
 * `cli` is the Messages-API identity: `claude-cli/<v> (external, cli)`. The
 * subscription usage endpoint is a different surface and the reference reports
 * a different product there — `claude-code/<v>` — so the choice is a parameter
 * rather than a constant. Reporting the wrong one is not fatal on the usage
 * route, but it is also not free: the route is behind the same gateway that
 * enforces the reported-version floor.
 */
export type ClaudeUserAgentKind = 'cli' | 'code'

/** Options for {@link buildClaudeHeaders}. */
export interface ClaudeHeaderOptions {
  /**
   * Exact model id this request targets.
   *
   * The one header consequence is the `claude-code-20250219` beta: the
   * reference's rule is that a haiku model does not receive it. Omit it for a
   * request that names no model (the usage read), which keeps the beta.
   */
  model?: string
  /** Whether this request enables thinking; adds the interleaved-thinking beta. */
  thinking?: boolean
  /** HTTP method. `content-type` is emitted unless this is a GET. */
  method?: 'GET' | 'POST' | string
  /** Which product identity to report. Defaults to the Messages-API one. */
  userAgent?: ClaudeUserAgentKind
  /** Extra headers. `x-api-key` is stripped from the result regardless. */
  extra?: Record<string, string>
}

/**
 * Whether a model id belongs to the haiku family.
 *
 * A substring test on the id is the only offline signal available, and it is
 * what the reference keys on. The failure mode is asymmetric and small: an id
 * that renames its family token would merely receive the claude-code beta it
 * did not need, which is a superset of the betas it does need.
 */
function isHaikuModel(modelId: string): boolean {
  return modelId.toLowerCase().includes('haiku')
}

/**
 * The `anthropic-beta` set for one request, in a stable order.
 *
 * Order is not observable — the server parses the header as a set — so the order
 * below is chosen for readability in a log rather than to match a reference.
 */
export function claudeBetas(options: Pick<ClaudeHeaderOptions, 'model' | 'thinking'> = {}): string[] {
  const betas: string[] = []
  // The haiku exclusion is the reference's own rule, not this module's taste:
  // a haiku id is served without the claude-code identity beta.
  if (options.model === undefined || !isHaikuModel(options.model)) betas.push(CLAUDE_CODE_BETA)
  betas.push(OAUTH_BETA)
  if (options.thinking === true) betas.push(INTERLEAVED_THINKING_BETA)
  return betas
}

/** The `User-Agent` value this line reports for one surface. */
export function claudeUserAgent(kind: ClaudeUserAgentKind = 'cli'): string {
  const version = claudeCliVersion()
  return kind === 'code' ? 'claude-code/' + version : 'claude-cli/' + version + ' (external, cli)'
}

/**
 * Build the headers for one subscription request.
 *
 * The single builder for every surface this module touches — the Messages API,
 * the model listing, the usage read, and the probe. `extra` is how a caller
 * adds a header this module does not own (a streaming `accept`, an
 * `anthropic-beta` the adapter negotiated) without a second builder drifting
 * away from this one.
 *
 * @param accessToken - a CURRENT OAuth access token. This function does not
 *   check expiry; the caller owns refresh.
 */
export function buildClaudeHeaders(accessToken: string, options: ClaudeHeaderOptions = {}): ClaudeRequestHeaders {
  const method = (options.method ?? 'POST').toUpperCase()
  const headers: ClaudeRequestHeaders = {
    authorization: 'Bearer ' + accessToken,
    'user-agent': claudeUserAgent(options.userAgent ?? 'cli'),
    'x-app': 'cli',
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': claudeBetas(options).join(','),
  }
  // Emitted unless the caller explicitly says GET. The default is the
  // fail-safe direction: a stray content-type on a GET is ignored, while a
  // missing one on a POST is a 400 the caller has to debug.
  if (method !== 'GET') headers['content-type'] = 'application/json'
  return mergeHeaders(headers, options.extra)
}

/**
 * Merge `extra` over a base map, lower-casing keys and refusing `x-api-key`.
 *
 * The refusal is the point. This line authenticates with a bearer token; a
 * request carrying both `authorization` and `x-api-key` is a documented 401
 * cause, and the realistic route back to that state is a caller spreading a
 * header map it built for another provider. Dropping the key here turns a
 * confusing 401 into a request that simply works.
 */
function mergeHeaders(base: ClaudeRequestHeaders, extra: Record<string, string> | undefined): ClaudeRequestHeaders {
  const merged: ClaudeRequestHeaders = {}
  const put = (key: string, value: string): void => {
    const normalized = key.trim().toLowerCase()
    if (normalized === 'x-api-key') return
    merged[normalized] = value
  }
  for (const [key, value] of Object.entries(base)) put(key, value)
  for (const [key, value] of Object.entries(extra ?? {})) put(key, value)
  return merged
}

// ---------------------------------------------------------------------------
// Model listing
// ---------------------------------------------------------------------------

interface CatalogCache {
  at: number
  models: readonly ClaudeModelEntry[]
  key: string
  /**
   * Whether these entries came off the wire or are the shipped table standing
   * in for a failed call. Kept so the settings card can say which it is showing
   * rather than presenting the fallback as the account's entitlement.
   */
  live: boolean
}

let catalogCache: CatalogCache | null = null
const catalogInFlight = new Map<string, Promise<readonly ClaudeModelEntry[]>>()

/** Drop the cached listing, forcing the next load to hit the network. */
export function clearCachedCatalog(): void {
  catalogCache = null
}

/** The listing currently held, or an empty array before the first load. */
export function getCachedCatalog(): readonly ClaudeModelEntry[] {
  return catalogCache?.models ?? []
}

/** Whether the held listing is the shipped table standing in for a failed call. */
export function isCatalogFallback(): boolean {
  return catalogCache !== null && !catalogCache.live
}

/** One listing entry, reduced to the two fields this line reads from it. */
interface ListingEntry {
  id: string
  /** The window the listing stated, or null when it stated none. */
  contextWindow: number | null
}

/**
 * Read one entry of the live listing.
 *
 * The window is accepted under four spellings. The reference snapshot and the
 * documented listing do not agree on a field name, and a payload that switched
 * spelling would otherwise read as "no window stated" — which is survivable but
 * silently throws away the one thing the listing is authoritative for.
 */
function parseListingEntry(value: unknown): ListingEntry | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const id = asString(record.id)
  if (id === undefined) return undefined
  const window = asNumber(record.context_window)
    ?? asNumber(record.contextWindow)
    ?? asNumber(record.max_input_tokens)
    ?? asNumber(record.maxInputTokens)
  return { id, contextWindow: window !== undefined && window > 0 ? window : null }
}

/**
 * Fold the live listing onto the frozen capability table.
 *
 * `contextWindow` is the ONLY field the listing may write. Everything else is
 * copied from `resolveClaudeModel`, which returns the catalog entry for a known
 * id and its conservative stub for an unknown one — so an id this line has never
 * heard of keeps the stub's "no images, no thinking form, 200K window" answer
 * instead of inheriting invented capabilities from the listing.
 *
 * The catalog is NOT widened by the listing: the returned array contains exactly
 * the ids the server named, because the listing is the authority on what this
 * account may call. (The fallback path is what keeps a failed call from
 * narrowing it to nothing.)
 */
export function mergeListingIntoCatalog(listing: readonly ListingEntry[]): ClaudeModelEntry[] {
  const merged: ClaudeModelEntry[] = []
  const seen = new Set<string>()
  for (const entry of listing) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    const base = resolveClaudeModel(entry.id)
    // One written field. Every capability comes from `base` untouched.
    merged.push({ ...base, contextWindow: entry.contextWindow ?? base.contextWindow })
  }
  return merged
}

/** Options for {@link loadCatalog}. */
export interface CatalogLoadOptions {
  fetchFn?: typeof fetch
  signal?: AbortSignal
  /** Bypass the cached listing and read the server again. */
  force?: boolean
}

/**
 * Read the models the signed-in account can call.
 *
 * Cached for {@link CATALOG_CACHE_TTL_MS} and single-flighted per credential,
 * because the harness resolves EVERY model of EVERY provider when it builds the
 * picker — without both, one picker build is one network round trip per model.
 *
 * A failure is cached too, deliberately. The fallback table is the full shipped
 * snapshot, so serving it for the cache window costs the user nothing but a
 * slightly wider picker, while NOT caching the failure would put a dead
 * endpoint behind fourteen sequential 20-second timeouts on every picker build.
 * {@link clearCachedCatalog} is the escape hatch: the sign-in path calls it so a
 * user who just authenticated does not sit behind a failure recorded before
 * they did.
 *
 * @param credentials - a current subscription credential; it selects the cache
 *   entry, since a different account can see a different listing.
 */
export function loadCatalog(
  credentials: ClaudeCredentials,
  options: CatalogLoadOptions = {},
): Promise<readonly ClaudeModelEntry[]> {
  const key = accountKeyFor(credentials)
  if (options.force !== true) {
    const cached = catalogCache
    if (cached !== null && cached.key === key && now() - cached.at < CATALOG_CACHE_TTL_MS) {
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
      // `performCatalogLoad` absorbs every failure, so reaching this branch
      // means a bug rather than an outage. Still not cached, so the next call
      // retries instead of pinning the process to the fallback table.
      throw error
    },
  )
  catalogInFlight.set(key, run)
  return run
}

async function performCatalogLoad(
  credentials: ClaudeCredentials,
  options: CatalogLoadOptions,
): Promise<readonly ClaudeModelEntry[]> {
  const key = accountKeyFor(credentials)
  const fetchFn = options.fetchFn ?? fetch
  let models: readonly ClaudeModelEntry[]
  let live = false
  try {
    const response = await fetchFn(API_BASE + MODELS_PATH, {
      method: 'GET',
      headers: buildClaudeHeaders(credentials.accessToken, { method: 'GET' }),
      signal: timeoutSignal(options.signal, DISCOVERY_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error('Claude model listing failed (' + response.status + ').')
    const payload: unknown = await response.json().catch(() => undefined)
    // Both documented shapes: the paginated envelope and a bare array.
    const data = Array.isArray(payload) ? payload : asRecord(payload)?.data
    if (!Array.isArray(data)) throw new Error('Claude model listing was not in the documented shape.')
    const listing = data.map(parseListingEntry).filter((entry): entry is ListingEntry => entry !== undefined)
    const merged = mergeListingIntoCatalog(listing)
    if (merged.length === 0) {
      // A successful call that names nothing is the empty-catalog gate in
      // disguise; the shipped table is the only answer that keeps the line
      // usable, and it is strictly better than blocking model switching.
      throw new Error('Claude model listing named no models this line understands.')
    }
    models = merged
    live = true
  } catch {
    models = FALLBACK_MODELS
  }
  catalogCache = { at: now(), models, key, live }
  return models
}

// ---------------------------------------------------------------------------
// Quota — the usage read
// ---------------------------------------------------------------------------

/**
 * One account window, normalized.
 *
 * The three numeric fields are null TOGETHER, and null means "the source did
 * not say" — which is a different statement from 0, "nothing used". Collapsing
 * them would turn a payload that omitted a window into a confident zero.
 */
export interface ClaudeUsageWindow {
  /** Wire key: `five_hour`, `seven_day`, `seven_day_sonnet`. */
  id: string
  /** Display label. */
  label: string
  /** Nominal length of the window in minutes, or null when unknown. */
  windowMinutes: number | null
  /** Fraction of the window consumed, 0-1. Percent divided by 100 at this boundary. */
  usedFraction: number | null
  /** Percent of the window consumed, 0-100. */
  usedPercent: number | null
  /** Percent of the window still available, 0-100. */
  remainingPercent: number | null
  /** ISO 8601 instant the window resets, or null. */
  resetsAt: string | null
  /** Which source these numbers came from. */
  source: 'usage' | 'headers'
}

/** The account's pay-as-you-go overage pool, as the usage payload states it. */
export interface ClaudeExtraUsage {
  isEnabled: boolean
  monthlyLimit: number | null
  usedCredits: number | null
  /** Percent of the monthly limit consumed, 0-100 — same unit as the windows. */
  utilization: number | null
}

/** The whole quota snapshot the settings card and the composer badge read. */
export interface ClaudeAccountQuota {
  windows: ClaudeUsageWindow[]
  extraUsage: ClaudeExtraUsage | null
  /**
   * Epoch ms of the last successful FULL usage read.
   *
   * Null when only response headers have ever been seen. This is the field that
   * decides whether the next read may be satisfied from headers alone.
   */
  fetchedAt: number | null
  /** Epoch ms of the most recent update from any source. */
  observedAt: number
  /** Unified rate-limit status the headers last reported, when they did. */
  status: string | null
  /** Window the headers last named as representative, when they did. */
  representativeClaim: string | null
}

/** Window descriptors for the payload's own keys, in card order: shortest first. */
const PAYLOAD_WINDOWS: readonly { key: string; label: string; minutes: number | null }[] = [
  { key: 'five_hour', label: '5-hour', minutes: 300 },
  { key: 'seven_day', label: 'Weekly (7 days)', minutes: 10_080 },
  { key: 'seven_day_sonnet', label: 'Weekly (Sonnet)', minutes: 10_080 },
]

/**
 * Build a window from a PERCENT-USED input.
 *
 * Every payload-derived window goes through here, and the division by 100
 * happens exactly once. Nothing downstream should ever see the raw percent.
 */
function windowFromPercent(
  id: string,
  label: string,
  minutes: number | null,
  utilization: number | undefined,
  resetsAt: string | null,
  source: 'usage' | 'headers',
): ClaudeUsageWindow {
  if (utilization === undefined) {
    return { id, label, windowMinutes: minutes, usedFraction: null, usedPercent: null, remainingPercent: null, resetsAt, source }
  }
  const percent = clamp(utilization, 0, 100)
  return {
    id,
    label,
    windowMinutes: minutes,
    usedFraction: percent / 100,
    usedPercent: percent,
    remainingPercent: 100 - percent,
    resetsAt,
    source,
  }
}

/** The window with the least headroom, or null when no window states one. */
export function tightestQuotaWindow(windows: readonly ClaudeUsageWindow[]): ClaudeUsageWindow | null {
  let tightest: ClaudeUsageWindow | null = null
  for (const window of windows) {
    if (window.usedFraction === null) continue
    if (tightest === null || window.usedFraction > (tightest.usedFraction as number)) tightest = window
  }
  return tightest
}

/**
 * Read the usage payload's known keys, and only its known keys.
 *
 * The key set varies by account type and the payload also carries churning
 * feature-flag codenames; anything not named below is ignored, because reading
 * an unknown key as a window is how a wrong number gets on the card. A known
 * key that is `null` (the documented state of `seven_day_sonnet`) yields no
 * window at all rather than a zeroed one.
 */
export function parseUsagePayload(payload: unknown): {
  windows: ClaudeUsageWindow[]
  extraUsage: ClaudeExtraUsage | null
} {
  const root = asRecord(payload)
  if (root === undefined) return { windows: [], extraUsage: null }

  const windows: ClaudeUsageWindow[] = []
  for (const descriptor of PAYLOAD_WINDOWS) {
    const record = asRecord(root[descriptor.key])
    if (record === undefined) continue
    const utilization = asNumber(record.utilization)
    const resetsAt = asString(record.resets_at) ?? asString(record.resetsAt) ?? null
    windows.push(windowFromPercent(descriptor.key, descriptor.label, descriptor.minutes, utilization, resetsAt, 'usage'))
  }

  // `limits[]` is a secondary shape this module has NO fixture for. It is read
  // narrowly on purpose: an entry must carry a recognizable kind AND a field
  // literally named `percent` (a percent by its own name, like the sibling
  // windows in the same payload). Anything else — including a `utilization`
  // field, whose unit is NOT stated in this shape — is dropped rather than
  // guessed, because a dropped entry falls back to the three canonical windows
  // while a guessed one puts a wrong number on the card.
  const limits = Array.isArray(root.limits) ? root.limits : []
  const seen = new Set(windows.map((window) => window.id))
  for (const entry of limits) {
    const record = asRecord(entry)
    if (record === undefined) continue
    const kind = asString(record.kind) ?? asString(record.type) ?? asString(record.group)
    if (kind === undefined) continue
    const percent = asNumber(record.percent)
    if (percent === undefined) continue
    const id = kind.toLowerCase()
    if (seen.has(id)) continue
    seen.add(id)
    const resetsAt = asString(record.resets_at) ?? asString(record.resetsAt) ?? null
    const descriptor = PAYLOAD_WINDOWS.find((candidate) => candidate.key === id)
    windows.push(windowFromPercent(id, descriptor?.label ?? kind, descriptor?.minutes ?? null, percent, resetsAt, 'usage'))
  }

  const extra = asRecord(root.extra_usage)
  const extraUsage: ClaudeExtraUsage | null = extra === undefined ? null : {
    isEnabled: extra.is_enabled === true,
    monthlyLimit: asNumber(extra.monthly_limit) ?? null,
    usedCredits: asNumber(extra.used_credits) ?? null,
    utilization: asNumber(extra.utilization) ?? null,
  }
  return { windows, extraUsage }
}

// ---------------------------------------------------------------------------
// Quota — the unified response headers
// ---------------------------------------------------------------------------

/** Prefix every unified rate-limit header shares. */
export const QUOTA_HEADER_PREFIX = 'anthropic-ratelimit-unified-'

/**
 * Anything header-shaped.
 *
 * A `Headers` (what `fetch` returns) or a plain map (what a test or a
 * hand-built call site has). Both are read case-insensitively, because HTTP
 * header names are case-insensitive and a plain map from a caller often is not.
 */
export type ClaudeHeaderSource = Headers | Record<string, string | readonly string[] | undefined>

interface HeaderGetter {
  get(name: string): string | null
}

function hasHeaderGetter(value: unknown): value is HeaderGetter {
  return typeof value === 'object' && value !== null && typeof (value as HeaderGetter).get === 'function'
}

function readHeader(headers: ClaudeHeaderSource, name: string): string | null {
  if (hasHeaderGetter(headers)) {
    const value = headers.get(name)
    return value === null || value.trim() === '' ? null : value.trim()
  }
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue
    if (typeof value === 'string') return value.trim() === '' ? null : value.trim()
    if (Array.isArray(value)) {
      const joined = value.join(', ').trim()
      return joined === '' ? null : joined
    }
  }
  return null
}

/**
 * Sanity ceiling for an epoch-SECONDS reset instant: 2100-01-01T00:00:00Z.
 *
 * The header carries seconds, so a value that is really milliseconds would land
 * tens of thousands of years out. Rather than auto-detecting the unit — which
 * would silently accept a wrong one — an implausible instant is dropped and the
 * caller renders "reset time unknown".
 */
const MAX_RESET_EPOCH_SECONDS = 4_102_444_800

/** Convert the headers' epoch-SECONDS reset instant to the ISO form the card uses. */
export function epochSecondsToIso(value: number | undefined): string | null {
  if (value === undefined || value <= 0 || value > MAX_RESET_EPOCH_SECONDS) return null
  const date = new Date(value * 1000)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

/** One window as the unified response headers state it. */
export interface ClaudeHeaderQuotaWindow {
  id: string
  label: string
  windowMinutes: number | null
  /** The header's own unit: a FRACTION, 0-1. */
  usedFraction: number
  /** The same number as a percent, 0-100. Derived here and nowhere else. */
  usedPercent: number
  remainingPercent: number
  /** ISO 8601, converted from the header's epoch SECONDS. */
  resetsAt: string | null
  /** Always `headers`: what this window is made of, for the merged DTO. */
  source: 'headers'
}

/** Everything the unified rate-limit headers said about one response. */
export interface ClaudeQuotaHeaderReading {
  windows: ClaudeHeaderQuotaWindow[]
  /** `anthropic-ratelimit-unified-status` — e.g. a rejected/allowed verdict. */
  status: string | null
  /** `anthropic-ratelimit-unified-representative-claim` — the window that speaks for the response. */
  representativeClaim: string | null
  /** The overage headers, when the response carried any. */
  overage: { status: string | null; utilization: number | null } | null
}

/** Which named payload window each header suffix describes. */
const HEADER_WINDOW_SUFFIXES: readonly { suffix: string; id: string; label: string; minutes: number | null }[] = [
  { suffix: '5h', id: 'five_hour', label: '5-hour', minutes: 300 },
  { suffix: '7d', id: 'seven_day', label: 'Weekly (7 days)', minutes: 10_080 },
]

/**
 * Read the unified rate-limit headers off any response.
 *
 * THIS is the boundary where the header FRACTION becomes a fraction in the
 * normalized DTO — it is never divided or multiplied again downstream. The
 * sibling `resets_at` field in the usage payload is ISO while the header reset
 * is epoch seconds; both land on the DTO as ISO.
 */
export function parseQuotaHeaders(headers: ClaudeHeaderSource): ClaudeQuotaHeaderReading {
  const windows: ClaudeHeaderQuotaWindow[] = []
  for (const descriptor of HEADER_WINDOW_SUFFIXES) {
    const raw = asNumber(readHeader(headers, QUOTA_HEADER_PREFIX + descriptor.suffix + '-utilization'))
    if (raw === undefined) continue
    const fraction = clamp(raw, 0, 1)
    windows.push({
      id: descriptor.id,
      label: descriptor.label,
      windowMinutes: descriptor.minutes,
      usedFraction: fraction,
      usedPercent: fraction * 100,
      remainingPercent: 100 - fraction * 100,
      resetsAt: epochSecondsToIso(asNumber(readHeader(headers, QUOTA_HEADER_PREFIX + descriptor.suffix + '-reset'))),
      source: 'headers',
    })
  }
  const overageStatus = readHeader(headers, QUOTA_HEADER_PREFIX + 'overage-status')
  const overageUtilization = asNumber(readHeader(headers, QUOTA_HEADER_PREFIX + 'overage-utilization'))
  return {
    windows,
    status: readHeader(headers, QUOTA_HEADER_PREFIX + 'status'),
    representativeClaim: readHeader(headers, QUOTA_HEADER_PREFIX + 'representative-claim'),
    overage: overageStatus === null && overageUtilization === undefined
      ? null
      : { status: overageStatus, utilization: overageUtilization === undefined ? null : clamp(overageUtilization, 0, 1) },
  }
}

// ---------------------------------------------------------------------------
// Quota — cache
// ---------------------------------------------------------------------------

interface QuotaCacheEntry {
  quota: ClaudeAccountQuota
  key: string
  /** Epoch ms of the last successful FULL usage read; null if there has never been one. */
  fullReadAt: number | null
  /** Epoch ms of the last write from any source. */
  observedAt: number
}

let quotaCache: QuotaCacheEntry | null = null
const quotaInFlight = new Map<string, Promise<ClaudeAccountQuota>>()

/** Drop the cached snapshot. Called on sign-out and after a credential change. */
export function clearCachedQuota(): void {
  quotaCache = null
}

/**
 * The cached snapshot, optionally only when it belongs to this credential.
 *
 * With one stored account the argument is unnecessary; it exists so a later
 * pool chunk cannot render one account's usage under another account's name.
 */
export function getCachedQuota(credentials?: Pick<ClaudeCredentials, 'accessToken'>): ClaudeAccountQuota | null {
  if (quotaCache === null) return null
  if (credentials === undefined) return quotaCache.quota
  return quotaCache.key === accountKeyFor(credentials) ? quotaCache.quota : null
}

/** Options for {@link fetchAccountQuota}. */
export interface QuotaFetchOptions {
  fetchFn?: typeof fetch
  signal?: AbortSignal
  /** Bypass the cache and read the usage endpoint now. */
  force?: boolean
}

/**
 * Read the account's usage meters.
 *
 * Cached for {@link QUOTA_CACHE_TTL_MS} and single-flighted per credential. The
 * cache is served only while BOTH clocks are inside their windows: a snapshot
 * kept warm by response headers still triggers a full read once the last real
 * read is older than {@link QUOTA_FULL_REFRESH_MS}, which is what stops a busy
 * conversation from pinning the card to numbers that arrived as a side effect.
 *
 * A failure never blanks the card: an existing snapshot for the same credential
 * is returned instead, because a transient outage says nothing about the
 * account's real usage. The exception is a credential failure, which is always
 * surfaced — hiding a revoked credential behind stale numbers is how a user ends
 * up staring at a card that claims they are fine.
 */
export function fetchAccountQuota(
  credentials: ClaudeCredentials,
  options: QuotaFetchOptions = {},
): Promise<ClaudeAccountQuota> {
  const key = accountKeyFor(credentials)
  const at = now()
  if (options.force !== true && quotaCache !== null && quotaCache.key === key) {
    const warm = at - quotaCache.observedAt < QUOTA_CACHE_TTL_MS
    const freshFullRead = quotaCache.fullReadAt !== null && at - quotaCache.fullReadAt < QUOTA_FULL_REFRESH_MS
    if (warm && freshFullRead) return Promise.resolve(quotaCache.quota)
  }
  const pending = quotaInFlight.get(key)
  if (pending !== undefined) return pending

  const run = performQuotaFetch(credentials, options).then(
    (quota) => {
      quotaInFlight.delete(key)
      return quota
    },
    (error: unknown) => {
      quotaInFlight.delete(key)
      throw error
    },
  )
  quotaInFlight.set(key, run)
  return run
}

async function performQuotaFetch(
  credentials: ClaudeCredentials,
  options: QuotaFetchOptions,
): Promise<ClaudeAccountQuota> {
  const key = accountKeyFor(credentials)
  const fetchFn = options.fetchFn ?? fetch
  const previous = quotaCache !== null && quotaCache.key === key ? quotaCache.quota : null

  let response: Response
  try {
    response = await fetchFn(API_BASE + USAGE_PATH, {
      method: 'GET',
      // The usage route is the one surface the reference reports as
      // `claude-code/<v>` rather than the Messages-API identity.
      headers: buildClaudeHeaders(credentials.accessToken, { method: 'GET', userAgent: 'code' }),
      signal: timeoutSignal(options.signal, DISCOVERY_TIMEOUT_MS),
    })
  } catch (error) {
    if (previous !== null) return previous
    throw new ClaudeRequestError(networkFailure(error))
  }

  const bodyText = await response.text().catch(() => '')
  if (!response.ok) {
    const failure = classifyFailure(response.status, bodyText, response.headers)
    if (failure.kind === 'credential') throw new ClaudeRequestError(failure)
    if (previous !== null) return previous
    throw new ClaudeRequestError(failure)
  }

  let payload: unknown
  try {
    payload = JSON.parse(bodyText) as unknown
  } catch {
    payload = undefined
  }
  const parsed = parseUsagePayload(payload)
  const at = now()
  const quota: ClaudeAccountQuota = {
    windows: parsed.windows,
    extraUsage: parsed.extraUsage,
    fetchedAt: at,
    observedAt: at,
    // The usage payload's own response headers are NOT fed into the unified
    // reader: this surface reports the meters in the body, and reading the same
    // numbers from a second place would let the two disagree in the cache.
    status: null,
    representativeClaim: null,
  }
  quotaCache = { quota, key, fullReadAt: at, observedAt: at }
  return quota
}

/**
 * Fold the unified response headers of any response into the cached snapshot.
 *
 * Called on every `/v1/messages` response — including 200s, which is where the
 * numbers usually come from. It advances `observedAt` and NOT `fullReadAt`, so
 * header data can satisfy the composer badge while the card is still required to
 * perform a real read once the last one is older than
 * {@link QUOTA_FULL_REFRESH_MS}.
 *
 * @param headers - response headers of a model call.
 * @param accountKey - the account those headers belong to, as
 *   {@link accountKeyFor} derives it. Omitted, the reading is filed under
 *   whoever the cached snapshot already belongs to — the correct answer for the
 *   single-account case, and a reading whose account cannot be determined is
 *   filed under none rather than under the wrong one. When it is given and
 *   disagrees with the snapshot's account the reading is DISCARDED rather than
 *   merged: mixing two accounts' windows is the one outcome worse than a stale
 *   number.
 * @returns the updated snapshot, or null when the headers carried nothing usable.
 */
export function recordQuotaFromHeaders(
  headers: ClaudeHeaderSource,
  accountKey?: string,
): ClaudeAccountQuota | null {
  const reading = parseQuotaHeaders(headers)
  if (reading.windows.length === 0) return null
  if (quotaCache !== null && accountKey !== undefined && quotaCache.key !== '' && quotaCache.key !== accountKey) {
    return null
  }
  const previous = quotaCache
  const byId = new Map<string, ClaudeUsageWindow>()
  for (const window of previous?.quota.windows ?? []) byId.set(window.id, window)
  for (const window of reading.windows) {
    const existing = byId.get(window.id)
    byId.set(window.id, {
      ...(existing ?? {}),
      id: window.id,
      label: existing?.label ?? window.label,
      windowMinutes: window.windowMinutes,
      usedFraction: window.usedFraction,
      usedPercent: window.usedPercent,
      remainingPercent: window.remainingPercent,
      resetsAt: window.resetsAt ?? existing?.resetsAt ?? null,
      source: 'headers',
    })
  }
  const at = now()
  const priorWindows = previous?.quota.windows ?? []
  const updatedIds = new Set(reading.windows.map((update) => update.id))
  const quota: ClaudeAccountQuota = {
    // Order is preserved rather than rebuilt: the card renders windows in the
    // order the payload stated them, so a header update must not reshuffle the
    // list under the user. A window the headers INTRODUCED is appended.
    windows: [
      ...priorWindows.map((window) => (updatedIds.has(window.id) ? (byId.get(window.id) as ClaudeUsageWindow) : window)),
      ...reading.windows
        .filter((update) => !priorWindows.some((window) => window.id === update.id))
        .map((update) => byId.get(update.id) as ClaudeUsageWindow),
    ],
    extraUsage: previous?.quota.extraUsage ?? null,
    fetchedAt: previous?.fullReadAt ?? null,
    observedAt: at,
    status: reading.status,
    representativeClaim: reading.representativeClaim,
  }
  quotaCache = {
    quota,
    key: previous?.key === undefined || previous.key === '' ? (accountKey ?? '') : previous.key,
    fullReadAt: previous?.fullReadAt ?? null,
    observedAt: at,
  }
  return quota
}

// ---------------------------------------------------------------------------
// Connectivity probe
// ---------------------------------------------------------------------------

/** A probe that reached the Messages API and was answered. */
export interface ClaudeProbeSuccess {
  ok: true
  model: string
  status: number
  latencyMs: number
  /** `stop_reason` of the one-token answer, when the body carried one. */
  stopReason: string | null
}

/** A probe that did not succeed, with the reason rather than an exception. */
export interface ClaudeProbeFailure {
  ok: false
  model: string
  /** HTTP status, or 0 when no response arrived at all. */
  status: number
  latencyMs: number
  failure: ClaudeFailure
}

export type ClaudeProbeResult = ClaudeProbeSuccess | ClaudeProbeFailure

/** Options for {@link probeConnection}. */
export interface ProbeOptions {
  fetchFn?: typeof fetch
  signal?: AbortSignal
  /**
   * Model to probe with.
   *
   * Defaults to the cheapest id in the shipped table. A probe is a connectivity
   * and credential check, and the widest-entitlement model answers it on every
   * plan; a caller that wants to prove a SPECIFIC model's entitlement passes it
   * here. Note that the default is a haiku id, so the probe exercises the header
   * set that omits the claude-code beta — pass the user's selected model to
   * probe the exact header set that model's real calls will use.
   */
  model?: string
  /** Deadline for the probe. Defaults to the discovery ceiling. */
  timeoutMs?: number
}

/** The model a probe uses when the caller names none. */
export const PROBE_DEFAULT_MODEL = 'claude-haiku-4-5'

/**
 * Prove the credential works and measure how long the round trip took.
 *
 * One non-streaming POST with `max_tokens: 1` — the smallest request the
 * Messages API accepts, which keeps a probe from consuming anything meaningful
 * even when it is run from the settings card on every save.
 *
 * An upstream rejection is RETURNED, not thrown: the card's whole job here is to
 * render the reason, and a thrown error would have to be caught and unwrapped at
 * every call site to say the same thing.
 */
export async function probeConnection(
  credentials: ClaudeCredentials,
  options: ProbeOptions = {},
): Promise<ClaudeProbeResult> {
  const model = options.model ?? PROBE_DEFAULT_MODEL
  const fetchFn = options.fetchFn ?? fetch
  const startedAt = now()
  let response: Response
  try {
    response = await fetchFn(API_BASE + MESSAGES_PATH, {
      method: 'POST',
      headers: buildClaudeHeaders(credentials.accessToken, { method: 'POST', model }),
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: timeoutSignal(options.signal, options.timeoutMs ?? DISCOVERY_TIMEOUT_MS),
    })
  } catch (error) {
    return { ok: false, model, status: 0, latencyMs: now() - startedAt, failure: networkFailure(error) }
  }
  const latencyMs = now() - startedAt
  const bodyText = await response.text().catch(() => '')
  if (!response.ok) {
    return { ok: false, model, status: response.status, latencyMs, failure: classifyFailure(response.status, bodyText, response.headers) }
  }
  let stopReason: string | null = null
  try {
    stopReason = asString((JSON.parse(bodyText) as Record<string, unknown>).stop_reason) ?? null
  } catch {
    stopReason = null
  }
  return { ok: true, model, status: response.status, latencyMs, stopReason }
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/**
 * What a caller should DO about a failure — the taxonomy, not the message.
 *
 * - `credential` — the stored credential is finished (401/403). Final: retrying
 *   cannot help, and the user has to sign in again.
 * - `request` — this request was wrong (400/404/413/422). Not retryable, and
 *   for this line often a client-version or parameter problem.
 * - `rate_limit_account` — a usage WINDOW OF THIS ACCOUNT is spent. Switching
 *   accounts is what fixes it.
 * - `rate_limit_global` — a limit that is not attributable to this account's
 *   window. Switching accounts would burn the pool against a wall.
 * - `overloaded` — transient capacity shortage. Retryable, not account-specific.
 * - `server` — a 5xx that is not an overload. Retryable.
 * - `network` — no response arrived at all. Retryable.
 */
export type ClaudeFailureKind =
  | 'credential'
  | 'request'
  | 'rate_limit_account'
  | 'rate_limit_global'
  | 'overloaded'
  | 'server'
  | 'network'

/** A classified failure, in the shape the adapter and the settings card consume. */
export interface ClaudeFailure {
  kind: ClaudeFailureKind
  /** Wire `error.type`, when the body named one this line recognizes. */
  type: ClaudeErrorType | null
  /** HTTP status, or 0 for a transport failure. */
  status: number
  /** Human-readable reason, from the body when it gave one. */
  message: string
  /** Whether repeating the SAME request could succeed. */
  retryable: boolean
  /**
   * Whether the failure is attributable to this ACCOUNT's own usage window.
   *
   * This is the field a pool switches accounts on. It is true only for
   * `rate_limit_account`.
   */
  accountScoped: boolean
  /** Whether the body's code was the reported-client-version floor. */
  clientVersionTooOld: boolean
  /** ISO 8601 reset instant, when the body or the headers named one. */
  resetsAt: string | null
  /** `retry-after`, in milliseconds, when the response carried it. */
  retryAfterMs: number | null
}

/** Error carrying a classified failure, for the paths that must signal instead of return. */
export class ClaudeRequestError extends Error {
  readonly failure: ClaudeFailure

  constructor(failure: ClaudeFailure) {
    super(failure.message)
    this.name = 'ClaudeRequestError'
    this.failure = failure
  }
}

/** A transport failure: nothing came back, so there is no status and no body. */
export function networkFailure(error: unknown): ClaudeFailure {
  const reason = error instanceof Error ? error.message : String(error)
  return {
    kind: 'network',
    type: null,
    status: 0,
    message: 'Claude request failed before a response arrived: ' + reason,
    retryable: true,
    accountScoped: false,
    clientVersionTooOld: false,
    resetsAt: null,
    retryAfterMs: null,
  }
}

/** The `{ error: { type, message } }` envelope, read defensively. */
function readErrorEnvelope(bodyText: string): { type: ClaudeErrorType | null; message: string | null } {
  try {
    const root = asRecord(JSON.parse(bodyText) as unknown)
    const error = asRecord(root?.error)
    const raw = error?.type
    return {
      type: isClaudeErrorType(raw) ? raw : null,
      message: asString(error?.message) ?? null,
    }
  } catch {
    return { type: null, message: null }
  }
}

/**
 * An ISO 8601 instant named inside an error message.
 *
 * Anthropic's rate-limit message sometimes states when the window resets in
 * prose ("... will reset at 2025-01-01T00:00:00Z"). The regex demands a full
 * date AND time with a zone, which is what keeps it from matching an unrelated
 * number in the text; a message that phrases it loosely simply yields null.
 */
const ISO_INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/

function retryAfterMs(value: string | null): number | null {
  if (value === null) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now()) : null
}

/**
 * Whether a 429 is THIS ACCOUNT's spent window rather than a global limit.
 *
 * The evidence is the unified rate-limit headers, and the rule errs toward
 * "global" on purpose. A response that names a window at 100% — or that reports
 * the verdict `rejected` — is this account's own window, and a pool may rotate.
 * A 429 that carries NO unified header at all is not attributable to any window
 * of this account, and treating it as account-scoped would rotate through every
 * account in the pool against a wall none of them can pass.
 */
function rateLimitIsAccountScoped(reading: ClaudeQuotaHeaderReading): boolean {
  if (reading.status !== null && reading.status.toLowerCase() === 'rejected') return true
  return reading.windows.some((window) => window.usedFraction >= 1)
}

/**
 * Classify one failed response.
 *
 * The body is authoritative and the status is the fallback, because Anthropic's
 * statuses are coarse: several unrelated conditions share a status while
 * `error.type` names the real one. Both paths are exercised by tests with real
 * response fixtures.
 *
 * @param status - HTTP status.
 * @param bodyText - the response body as text. A body this function cannot
 *   parse costs a more precise `type`, never a wrong classification.
 * @param headers - response headers, read for the unified rate-limit verdict and
 *   for `retry-after`.
 */
export function classifyFailure(
  status: number,
  bodyText: string,
  headers: ClaudeHeaderSource = {},
): ClaudeFailure {
  const envelope = readErrorEnvelope(bodyText)
  const reading = parseQuotaHeaders(headers)
  // The code is looked for in the RAW text as well as in the parsed envelope:
  // it arrives inside `invalid_request_error`'s details, whose nesting is not
  // pinned, and a substring scan of the body cannot miss it.
  const clientVersionTooOld = bodyText.includes(ERROR_CODE_CLIENT_VERSION_TOO_OLD)
  const retryAfter = retryAfterMs(readHeader(headers, 'retry-after'))

  const base = {
    type: envelope.type,
    status,
    clientVersionTooOld,
    retryAfterMs: retryAfter,
  }

  switch (envelope.type) {
    case ERROR_TYPE.AUTHENTICATION:
    case ERROR_TYPE.PERMISSION:
      return {
        ...base,
        kind: 'credential',
        message: envelope.message ?? 'Claude rejected the stored credential. Sign in again.',
        retryable: false,
        accountScoped: false,
        resetsAt: null,
      }
    case ERROR_TYPE.RATE_LIMIT: {
      const accountScoped = rateLimitIsAccountScoped(reading)
      const named = envelope.message?.match(ISO_INSTANT)?.[0] ?? null
      return {
        ...base,
        kind: accountScoped ? 'rate_limit_account' : 'rate_limit_global',
        message: envelope.message ?? 'Claude rate limited this request.',
        retryable: true,
        accountScoped,
        resetsAt: named ?? reading.windows.find((window) => window.resetsAt !== null)?.resetsAt ?? null,
      }
    }
    case ERROR_TYPE.OVERLOADED:
      return {
        ...base,
        kind: 'overloaded',
        message: envelope.message ?? 'Claude is temporarily overloaded.',
        retryable: true,
        accountScoped: false,
        resetsAt: null,
      }
    case ERROR_TYPE.INVALID_REQUEST:
    case ERROR_TYPE.REQUEST_TOO_LARGE:
      return {
        ...base,
        kind: 'request',
        message: envelope.message ?? 'Claude rejected the request itself.',
        retryable: false,
        accountScoped: false,
        resetsAt: null,
      }
    case ERROR_TYPE.NOT_FOUND:
      return {
        ...base,
        kind: 'request',
        message: envelope.message ?? 'Claude does not recognize the requested resource.',
        retryable: false,
        accountScoped: false,
        resetsAt: null,
      }
    case ERROR_TYPE.API:
      return {
        ...base,
        kind: 'server',
        message: envelope.message ?? 'Claude reported a server-side failure.',
        retryable: true,
        accountScoped: false,
        resetsAt: null,
      }
    default:
      break
  }

  // No recognized `error.type`: fall back to the status line alone.
  const message = envelope.message ?? (bodyText.trim() === '' ? 'Claude request failed (' + status + ').' : bodyText.trim())
  if (status === 401 || status === 403) {
    return { ...base, kind: 'credential', message, retryable: false, accountScoped: false, resetsAt: null }
  }
  if (status === 429) {
    const accountScoped = rateLimitIsAccountScoped(reading)
    return {
      ...base,
      kind: accountScoped ? 'rate_limit_account' : 'rate_limit_global',
      message,
      retryable: true,
      accountScoped,
      resetsAt: message.match(ISO_INSTANT)?.[0] ?? null,
    }
  }
  if (status === 529) {
    // 529 is Anthropic's documented overload status; it is > 500, so without
    // this branch an overload with an unreadable body would be filed as a
    // generic server error and lose the "retry is the whole remedy" signal.
    return { ...base, kind: 'overloaded', message, retryable: true, accountScoped: false, resetsAt: null }
  }
  if (status >= 500) {
    return { ...base, kind: 'server', message, retryable: true, accountScoped: false, resetsAt: null }
  }
  if (status >= 400) {
    return { ...base, kind: 'request', message, retryable: false, accountScoped: false, resetsAt: null }
  }
  return { ...base, kind: 'server', message, retryable: true, accountScoped: false, resetsAt: null }
}
