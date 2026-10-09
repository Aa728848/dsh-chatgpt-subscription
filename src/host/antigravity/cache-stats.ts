/**
 * Per-session cache accounting for the Antigravity line.
 *
 * Antigravity's prompt cache is implicit and server-side: the client sets no
 * cache-control field, and the only evidence that a prefix was reused is the
 * pair `usageMetadata.cachedContentTokenCount` / `promptTokenCount` on each
 * response. A ratio on its own cannot explain itself, so every request also
 * fingerprints the three parts of its body that decide the prefix the service is
 * able to reuse — `request.contents`, `request.systemInstruction` and
 * `request.tools` — and diffs them against the previous request of the same
 * session.
 *
 * Everything here is process-local, scoped by session, and never written to
 * disk: the numbers describe the conversations this host served, and one
 * session's misses must never be blended into another's ratio.
 *
 * KNOWN LIMITATION — the two halves read the request at different scopes.
 *
 * This is a measured fact about this module, not a theory: the prefix snapshots
 * that produce a drift cause are keyed by SESSION alone ({@link
 * sessionScopeKey}), while the token totals are keyed by SESSION AND ACCOUNT
 * ({@link statsScopeKey}). The account is deliberately absent from the snapshot
 * because the account that will answer a request is not known when the body is
 * assembled — the adapter resolves it at the pool, after the fingerprint is
 * taken.
 *
 * What follows from that: when one conversation is served by more than one
 * pooled account (a 429 falls through to the next account mid-session), the
 * three prefix segments and the raw session id are all byte-for-byte unchanged,
 * so the drift comparator reports 'none'. A reader must NOT read that as "the
 * client sent nothing different, so the chill came from the service" — the
 * account did change. The request that reached the service was not the same
 * request, even though every field this module fingerprints is identical.
 *
 * Whether the serving account actually partitions the server-side cache is
 * INFERRED, not measured — the same unverified assumption the account-scoped
 * totals rest on, and the reason no 'account' drift cause exists yet: promoting
 * it to the contract before the assumption is checked would state it as fact.
 * The honest reading of a 'none' beside a rising fresh-token count is "the client
 * prefix held; look at which account served the turn".
 */

/**
 * The part of a request that changed since that session's previous request.
 *
 * `'none'` means the prefix held, so a cold turn is not explained by anything the
 * client sent IN THE SEGMENTS THIS MODULE FINGERPRINTS — it points at the service
 * or at something the fingerprints cannot see (see the file header's known
 * limitation: the serving account is one such thing). Every other value names the
 * input that broke the prefix, which is the half of the diagnostic a bare hit
 * ratio cannot supply.
 */
export type AntigravityPrefixDriftCause =
  /** The prefix is unchanged. */
  | 'none'
  /** The conversation itself changed. */
  | 'contents'
  /** The system instruction changed. */
  | 'systemInstruction'
  /** The tool list changed. */
  | 'tools'
  /**
   * The session identifier the request carries changed inside one session scope.
   *
   * It names the CLIENT-SIDE string, and deliberately promises nothing about the
   * service's cache: whether that identifier partitions anything server-side is
   * inferred, not measured. In practice this branch is close to unreachable — the
   * scope key trims, so it takes two spellings of one session (a trailing space)
   * to trigger it within a single conversation.
   */
  | 'session-id'
  /** Nothing to compare against: this scope's first request. */
  | 'new-session'

/** One request's token counts, as the service reported them. */
export interface AntigravityUsageSample {
  /** Prompt tokens served from the service's cache (`cachedContentTokenCount`). */
  cachedTokens: number
  /** Prompt tokens it had to process (`promptTokenCount` minus the cached part). */
  freshTokens: number
}

/** Rolling cache totals for one scope. */
export interface AntigravityCacheStats {
  /** Requests that reported usage. */
  requests: number
  /** Prompt tokens served from cache across those requests. */
  cachedTokens: number
  /** Prompt tokens processed afresh across those requests. */
  freshTokens: number
  /** cachedTokens / (cachedTokens + freshTokens); null until a request reports usage. */
  hitRatio: number | null
}

/** The shape the settings route publishes, and the browser card renders. */
export interface AntigravityCacheStatsDto extends AntigravityCacheStats {
  /**
   * The most recent request that came back with nothing cached.
   *
   * Only misses are published. A prefix change on its own says nothing: a new
   * user turn always changes `contents`, and that turn still hits the cache for
   * everything before it. Publishing every change made the card read "contents
   * changed" on every single turn — it named the one input that is SUPPOSED to
   * change and hid the one that actually costs: an idle gap that outlived the
   * service's cache.
   */
  lastMiss?: AntigravityCacheMiss
}

/** Totals held for one scope; the ratio is derived on read, never stored. */
interface ScopeTotals {
  requests: number
  cachedTokens: number
  freshTokens: number
}

/** The prefix-breaking inputs of one request, kept to attribute the next change. */
interface PrefixSnapshot {
  sessionId: string
  contents: string | null
  systemInstruction: string | null
  tools: string | null
}

/**
 * One total miss, and the two facts that explain it.
 *
 * A miss here means the response reported zero cached tokens — the whole prefix
 * was reprocessed. That is the event worth naming; a partial hit is the normal
 * state of a growing conversation.
 */
export interface AntigravityCacheMiss {
  /** The segment that changed since this session's previous request. */
  cause: AntigravityPrefixDriftCause
  /**
   * Milliseconds since this session's previous request, or undefined when this
   * was the session's first. The service's cache expires on idle time it does
   * not disclose, so this is the reading that separates "the conversation
   * restarted" from "the cache timed out while the user was away".
   */
  idleMs?: number
  /** When the miss was recorded. */
  at: number
}

/** The attribution a request computed, held until its response says it missed. */
interface PendingDrift {
  cause: AntigravityPrefixDriftCause
  idleMs?: number
}

const EMPTY_TOTALS: ScopeTotals = { requests: 0, cachedTokens: 0, freshTokens: 0 }

const totalsByScope = new Map<string, ScopeTotals>()
const prefixesBySession = new Map<string, PrefixSnapshot>()
const pendingBySession = new Map<string, PendingDrift>()
const missBySession = new Map<string, AntigravityCacheMiss>()
/** When each session last SENT a request, for the idle reading a miss reports. */
const requestAtBySession = new Map<string, number>()

/**
 * Sessions the process is willing to remember before evicting the oldest.
 *
 * DSH runs several sessions and subagents through one host, but not hundreds at
 * once: eviction only begins once a host has served that many, and it drops the
 * least recently written key, which is a stale session by then. A purely
 * advisory feature must not be a leak.
 */
const MAX_TRACKED_SCOPES = 256

/**
 * Bucket key for a request that names no session.
 *
 * A one-shot request — a probe, a test, a caller that never had a conversation —
 * is still counted, but kept apart from every real session so it can never
 * inflate, or be mistaken for, one of their ratios.
 */
const UNSCOPED_KEY = ''

/** The session a request belongs to, or the unscoped bucket when it names none. */
function sessionScopeKey(sessionId: unknown): string {
  return typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId.trim() : UNSCOPED_KEY
}

/**
 * Composite key separating one session's numbers from another's, and one
 * account's share of a session from another's.
 *
 * The account is part of the key because the pool can answer the same session
 * from different accounts, and each of those probably keeps its own cache
 * server-side. A shared entry would blend a cold account's misses into a warm
 * account's ratio, leaving a number that means nothing.
 *
 * That each account is its own cache namespace is INFERRED, not measured: no
 * account-scoped cache metric exists, and an account-scoped read is unobservable
 * from here. Splitting by account is the conservative reading of that assumption
 * — if it is wrong the two entries are merely reported apart, whereas merging
 * them would silently average a claim this line cannot check.
 */
function statsScopeKey(sessionId: unknown, accountId?: string): string {
  const session = sessionScopeKey(sessionId)
  if (session === UNSCOPED_KEY) return UNSCOPED_KEY
  return accountId === undefined || accountId === '' ? session : `${session} ${accountId}`
}

/** Write a key, evicting the oldest entry once the bound is reached. */
function rememberScoped<K, V>(store: Map<K, V>, key: K, value: V): void {
  // Re-insert so Map iteration order stays least-recently-written first.
  store.delete(key)
  store.set(key, value)
  if (store.size <= MAX_TRACKED_SCOPES) return
  const oldest = store.keys().next()
  if (oldest.done !== true) store.delete(oldest.value)
}

/**
 * A short, stable fingerprint of one prefix segment.
 *
 * Hashed rather than stored verbatim: these strings are the whole conversation
 * on a long turn, and a 32-bit FNV-1a keeps the diagnostic dependency-free.
 * Collisions only ever cost a missed attribution, never a wrong request.
 */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

/**
 * One value's canonical text, with object keys in a fixed order.
 *
 * Key order is an artifact of how a value was assembled, not of what it means:
 * hashing `JSON.stringify` output verbatim would report a drift whenever two
 * structurally equal requests happened to build their objects in a different
 * order, and a reader cannot tell that false positive from a real one.
 */
function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  const record = value as Record<string, unknown>
  const fields = Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
  return `{${fields.join(',')}}`
}

/** Hash one segment, or null when the request does not carry it at all. */
function segmentHash(value: unknown): string | null {
  return value === undefined ? null : fingerprint(stableSerialize(value))
}

/** The `request` object of a serialized Antigravity body, when it has one. */
function requestSegment(body: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const request = (parsed as Record<string, unknown>).request
    return typeof request === 'object' && request !== null ? (request as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** Which segment changed, or that there was nothing to compare against. */
function driftCause(previous: PrefixSnapshot | undefined, current: PrefixSnapshot): AntigravityPrefixDriftCause {
  if (previous === undefined) return 'new-session'
  // Checked first because the identifier is the coarsest thing that changed: a
  // request naming a different session should not have its cold turn blamed on the
  // contents that happen to differ alongside it. Whether that identifier splits
  // anything server-side is inferred, not measured — the route hands the service a
  // stable session id rather than a per-request random one, but whether the service
  // keys a cache on it is unverified. (This branch also stays near-unreachable on
  // purpose: the scope key trims, so it takes a second spelling of one session.)
  if (previous.sessionId !== current.sessionId) return 'session-id'
  if (previous.contents !== current.contents) return 'contents'
  if (previous.systemInstruction !== current.systemInstruction) return 'systemInstruction'
  if (previous.tools !== current.tools) return 'tools'
  return 'none'
}

/**
 * Fingerprint the prefix of a request about to be sent, and attribute whatever
 * changed since this session's previous request.
 *
 * Called once per turn, before the request goes out, so the answer describes the
 * prefix the service will actually see. The reason is remembered for the session
 * as well, so the route can publish the attribution beside the ratio it explains.
 *
 * @param body - The serialized request body, exactly as it will be sent.
 * @param sessionId - Conversation the request belongs to, when it has one.
 * @returns The change attributed to this request.
 */
export function recordCacheRequest(body: string, sessionId?: unknown): AntigravityPrefixDriftCause {
  const scope = sessionScopeKey(sessionId)
  const request = requestSegment(body)
  const snapshot: PrefixSnapshot = {
    // The id the body carries verbatim, which is what leaves this process: the
    // trimmed scope below only decides which totals group together. Comparing the
    // raw value is what lets a change inside one scope be attributed at all,
    // whether or not the service partitions its cache by it.
    sessionId: typeof sessionId === 'string' ? sessionId : '',
    contents: segmentHash(request?.contents),
    systemInstruction: segmentHash(request?.systemInstruction),
    tools: segmentHash(request?.tools),
  }
  const previous = prefixesBySession.get(scope)
  rememberScoped(prefixesBySession, scope, snapshot)

  const cause = driftCause(previous, snapshot)
  // Staged, not published. Whether this change COST anything is only knowable
  // once the response reports its usage, and recordCacheUsage publishes it then
  // and only if the turn came back with nothing cached.
  const previousRequestAt = requestAtBySession.get(scope)
  rememberScoped(requestAtBySession, scope, Date.now())
  const idleMs = previousRequestAt === undefined ? undefined : Math.max(0, Date.now() - previousRequestAt)
  rememberScoped(pendingBySession, scope, { cause, ...(idleMs === undefined ? {} : { idleMs }) })
  return cause
}

/** A token count worth recording, or undefined when it is not a count at all. */
function usableCount(value: number): number | undefined {
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Add one request's reported counts to its session's totals.
 *
 * The scope carries the account as well as the session, because a pooled line
 * can answer one conversation from several accounts and each of those keeps its
 * own cache server-side: one account's cold misses must not be averaged into
 * another's warm hits.
 *
 * @param sample - Token counts the response reported.
 * @param sessionId - Conversation the request belonged to.
 * @param accountId - Pooled account that served it, when the pool is in use.
 */
export function recordCacheUsage(sample: AntigravityUsageSample, sessionId?: unknown, accountId?: string): void {
  const cached = usableCount(sample.cachedTokens)
  const fresh = usableCount(sample.freshTokens)
  // A count the service never stated is not a zero: skipping keeps the ratio
  // describing measurements that exist.
  if (cached === undefined || fresh === undefined) return
  const scope = statsScopeKey(sessionId, accountId)
  const previous = totalsByScope.get(scope) ?? EMPTY_TOTALS
  rememberScoped(totalsByScope, scope, {
    requests: previous.requests + 1,
    cachedTokens: previous.cachedTokens + cached,
    freshTokens: previous.freshTokens + fresh,
  })

  // Only a total miss is worth naming. A partial hit is the ordinary state of a
  // conversation that keeps growing — every new turn adds tokens the service has
  // never seen, so `freshTokens > 0` is expected and says nothing went wrong.
  // Publishing on every change is what made the card read "contents changed" on
  // each turn and never once name the idle timeout that actually costs.
  const session = sessionScopeKey(sessionId)
  const pending = pendingBySession.get(session)
  if (cached !== 0 || pending === undefined) return
  rememberScoped(missBySession, session, {
    cause: pending.cause,
    ...(pending.idleMs === undefined ? {} : { idleMs: pending.idleMs }),
    at: Date.now(),
  })
}

/** Add one scope's totals into an accumulator. */
function accumulate(totals: ScopeTotals, stats: ScopeTotals): void {
  totals.requests += stats.requests
  totals.cachedTokens += stats.cachedTokens
  totals.freshTokens += stats.freshTokens
}

/**
 * Sum the scopes one question covers.
 *
 * The three cases are not a convenience: naming an account answers "is this
 * account's cache warm", naming only a session answers "how is this
 * conversation doing overall", and naming neither answers "how is this install
 * doing". Summing the stored scopes rather than keeping a second running total
 * means the aggregate can never drift out of step with the parts it summarises.
 */
function sumTotals(sessionId?: string, accountId?: string): ScopeTotals {
  const totals: ScopeTotals = { ...EMPTY_TOTALS }
  if (sessionId === undefined) {
    for (const stats of totalsByScope.values()) accumulate(totals, stats)
  } else if (accountId !== undefined) {
    accumulate(totals, totalsByScope.get(statsScopeKey(sessionId, accountId)) ?? EMPTY_TOTALS)
  } else {
    // The session across every account that served it. The account is part of
    // the key, so an exact lookup would miss the per-account entries.
    const scope = sessionScopeKey(sessionId)
    const prefix = scope + ' '
    for (const [key, stats] of totalsByScope) {
      if (key === scope || key.startsWith(prefix)) accumulate(totals, stats)
    }
  }
  return totals
}

/** The most recent miss for the requested scope, when one was recorded. */
function missFor(sessionId?: string): AntigravityCacheMiss | undefined {
  if (sessionId === undefined) {
    // A session was not named, so no single miss describes the answer; the most
    // recent one this process recorded still describes a real request, where
    // picking the first key would report whichever ran longest ago.
    let latest: AntigravityCacheMiss | undefined
    for (const record of missBySession.values()) {
      if (latest === undefined || record.at >= latest.at) latest = record
    }
    return latest
  }
  return missBySession.get(sessionScopeKey(sessionId))
}

/**
 * Cache totals for one account's share of a session, one whole session, or every
 * tracked session.
 *
 * A missing session is not an error: the settings card has no conversation in
 * hand, and the process aggregate is the honest answer there.
 */
export function getCacheStats(sessionId?: string, accountId?: string): AntigravityCacheStatsDto {
  const totals = sumTotals(sessionId, accountId)
  const prompt = totals.cachedTokens + totals.freshTokens
  const miss = missFor(sessionId)
  return {
    ...totals,
    hitRatio: prompt === 0 ? null : totals.cachedTokens / prompt,
    ...(miss === undefined ? {} : { lastMiss: miss }),
  }
}

/** Drop every key belonging to one session, whatever account served it. */
function dropSession(store: Map<string, unknown>, sessionId: string): void {
  const scope = sessionScopeKey(sessionId)
  for (const key of [...store.keys()]) {
    if (key === scope || key.startsWith(scope + ' ')) store.delete(key)
  }
}

/**
 * Forget one session's numbers, or all of them.
 *
 * Session teardown and test seam: a conversation that ended must not leave its
 * ratio behind to be read as another's.
 */
export function resetCacheStats(sessionId?: string): void {
  if (sessionId === undefined) {
    totalsByScope.clear()
    prefixesBySession.clear()
    pendingBySession.clear()
    missBySession.clear()
    requestAtBySession.clear()
    return
  }
  dropSession(totalsByScope, sessionId)
  dropSession(prefixesBySession, sessionId)
  dropSession(pendingBySession, sessionId)
  dropSession(missBySession, sessionId)
  dropSession(requestAtBySession, sessionId)
}
