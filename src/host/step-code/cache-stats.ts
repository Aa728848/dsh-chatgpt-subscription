/**
 * Cache-waste diagnosis for the Step Code route: how many prompt tokens should
 * have been cache reads and were billed fresh anyway.
 *
 * Ported from the official Step-Code client
 * (`_ref-stepcode/packages/coding-agent/src/core/cache-stats.ts`, 164 lines).
 * The arithmetic and the counting rules are kept as they are; only the data
 * sources change, because this repository has no `SessionEntry` type and this
 * route must not depend on one:
 *
 * - the official scan walks persisted session entries; here the caller hands in
 *   an already-ordered list of {@link StepCodeCacheEntry} values,
 * - the official message carries `usage.cost`; on this route every price is
 *   zero, so {@link StepCodeCacheMiss.missedCost} is 0 and the card is told not
 *   to render money at all.
 *
 * WHY the diagnosis is worth porting here rather than into the shared cache
 * layer: Step's cache is automatic and invisible. The client gets no marker when
 * a prefix stopped being reused, so the only evidence is the read number on the
 * next turn — and the question "did we throw the prefix away, or did the server?"
 * is answered by comparing against the previous request.
 *
 * Pure functions only: no state is retained here, so the caller owns the history
 * and the lifetime of it.
 *
 * @module dsh-chatgpt-subscription/step-code-cache-stats
 */

import { STEP_CODE_PRICE_PER_MILLION_TOKENS } from './mapper.ts'

/**
 * Prompt-cache time-to-live.
 *
 * An idle gap longer than this is the likeliest explanation for a miss, and it
 * is the only cheap hint this diagnosis can give: the upstream offers no
 * "your entry expired" signal, so the idle period is the whole evidence.
 * Five minutes is the TTL the official client uses for the same notice.
 */
export const CACHE_TTL_MS = 5 * 60 * 1000

/**
 * Misses at or below this are cache-breakpoint granularity, not waste.
 *
 * A prefix cache breaks at block boundaries, so a few hundred tokens of drift
 * between two turns is normal re-shuffling. Reporting it teaches the user to
 * ignore the notice, which costs the one notice that mattered.
 */
export const NOISE_FLOOR_TOKENS = 1024

/**
 * Whether this route can put money on a cache number.
 *
 * Always false: the official model table hardwires every price to 0
 * (`STEP_MODEL_DEFAULTS.cost`, `step-provider/index.ts:102`), and Step Plan is a
 * subscription rather than a metered SKU. A caller that renders
 * `missedCost` from a zero price shows a correct, useless "you saved $0"; the
 * alternative — inventing a rate — would show a plausible, false number. So the
 * card shows the token dimension alone.
 */
export function isCacheWasteCostPriced(): boolean {
  return STEP_CODE_PRICE_PER_MILLION_TOKENS > 0
}

/** Disjoint token counts for one assistant turn, as this route reports them. */
export interface StepCodeCacheUsage {
  /** Uncached prompt tokens. */
  inputTokens: number
  /** Output tokens, which reasoning is billed against. */
  outputTokens?: number
  /** Prompt tokens served from the automatic prefix cache. */
  cacheReadTokens?: number
  /**
   * Always 0 on this route — the cache is automatic, so there is no client-side
   * write to count. Kept in the shape because the arithmetic below reads it.
   */
  cacheWriteTokens?: number
}

/** One assistant turn: what it spent, when, and on which model. */
export interface StepCodeCacheTurn {
  readonly usage: StepCodeCacheUsage
  /** Epoch milliseconds the request completed. */
  readonly timestamp: number
  /**
   * Identity of the model route, `{provider}/{model}`.
   *
   * Compared as a string rather than as two fields so a caller can extend it
   * (region, profile, wire) without this file needing to know what a "route" is.
   */
  readonly modelKey: string
}

/**
 * What the previous request in this segment left behind.
 *
 * Everything in its prompt should be a cache read on the next turn; that is the
 * premise the whole diagnosis rests on.
 */
export interface StepCodePreviousRequest {
  /** Its aggregate prompt count. */
  promptTokens: number
  readonly modelKey: string
  readonly timestamp: number
  /**
   * Sticky: some earlier request in this segment reported cache activity.
   *
   * This is what separates two cases that look identical from the outside — a
   * total miss on a read-reporting endpoint versus an endpoint that reports no
   * caching at all. Without it, the second would be reported as a total miss on
   * every single turn.
   */
  readonly reportedCache: boolean
}

/** A counted cache miss on one assistant turn. */
export interface StepCodeCacheMiss {
  /** Tokens that were in the previous prompt and were NOT read from cache. */
  missedTokens: number
  /** Always 0 on this route; see {@link isCacheWasteCostPriced}. */
  missedCost: number
  /** Milliseconds since the previous request, which last refreshed the cache. */
  idleMs: number
  /** True when the model changed relative to the previous request. */
  modelChanged: boolean
}

/** Cumulative waste across a segment. */
export interface StepCodeCacheWasteTotals {
  missedTokens: number
  missedCost: number
  /** Counted misses — turns above {@link NOISE_FLOOR_TOKENS}. */
  missCount: number
}

/**
 * One entry of the ordered history this diagnosis scans.
 *
 * The two context-change kinds exist because compaction and branch summaries
 * legitimately REPLACE the prompt: the next turn's context is new content, not
 * re-billed content, so counting it as waste would be wrong.
 */
export type StepCodeCacheEntry =
  | { readonly kind: 'turn'; readonly turn: StepCodeCacheTurn }
  | { readonly kind: 'compaction' }
  | { readonly kind: 'branch-summary' }

/** Aggregate prompt count of one turn: uncached input plus both cache buckets. */
export function promptTokensOf(usage: StepCodeCacheUsage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/**
 * The segment state one turn leaves behind, or undefined when it carries no
 * prompt and therefore cannot be a baseline.
 */
export function asPreviousRequest(
  turn: StepCodeCacheTurn,
  reportedCache: boolean,
): StepCodePreviousRequest | undefined {
  const promptTokens = promptTokensOf(turn.usage)
  if (promptTokens <= 0) return undefined
  return {
    promptTokens,
    modelKey: turn.modelKey,
    timestamp: turn.timestamp,
    // Sticky in both directions: a turn that reported cache activity arms the
    // flag for everything after it, and a turn that reported none keeps it.
    reportedCache: reportedCache || (turn.usage.cacheReadTokens ?? 0) > 0 || (turn.usage.cacheWriteTokens ?? 0) > 0,
  }
}

/**
 * Cache miss for one turn relative to the previous request, or undefined when
 * nothing is counted.
 *
 * Not counted: the first turn (no baseline), a turn with no prompt, a turn whose
 * segment reported no cache activity at all (see
 * {@link StepCodePreviousRequest.reportedCache}), and a miss at or below
 * {@link NOISE_FLOOR_TOKENS}.
 */
export function detectCacheMiss(
  prev: StepCodePreviousRequest | undefined,
  turn: StepCodeCacheTurn,
): StepCodeCacheMiss | undefined {
  const usage = turn.usage
  const promptTokens = promptTokensOf(usage)
  // A zero-cache turn only counts when cache activity was reported before: on a
  // read-only endpoint that is a total miss, while on an endpoint that never
  // reports caching it means nothing at all.
  if (prev === undefined || promptTokens <= 0) return undefined
  if ((usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) === 0 && !prev.reportedCache) return undefined

  // Only the overlap is missable: tokens the previous prompt did not have could
  // not have been cached, and tokens the current prompt dropped are gone rather
  // than re-billed.
  const missedTokens = Math.min(prev.promptTokens, promptTokens) - (usage.cacheReadTokens ?? 0)
  if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined

  return {
    missedTokens,
    // The official client multiplies the miss by (paid rate - read rate); both
    // rates are 0 here (see the module note), so the difference is 0 and the
    // honest answer is 0 rather than a rate invented for the card.
    missedCost: 0,
    idleMs: Math.max(0, turn.timestamp - prev.timestamp),
    // A model switch re-bills the whole prompt and is therefore a real loss,
    // unlike a compaction, which is why it is reported and not exempted.
    modelChanged: turn.modelKey !== prev.modelKey,
  }
}

/**
 * Whether an idle period is long enough to suspect the cache entry expired.
 *
 * Strictly greater: an entry alive exactly to its TTL has not expired, and
 * rounding must not turn that into a warning.
 */
export function cacheLikelyExpired(idleMs: number): boolean {
  return idleMs > CACHE_TTL_MS
}

interface CacheScan {
  prev: StepCodePreviousRequest | undefined
  totals: StepCodeCacheWasteTotals
  misses: Map<StepCodeCacheTurn, StepCodeCacheMiss>
}

function emptyTotals(): StepCodeCacheWasteTotals {
  return { missedTokens: 0, missedCost: 0, missCount: 0 }
}

function addMiss(totals: StepCodeCacheWasteTotals, miss: StepCodeCacheMiss): void {
  totals.missedTokens += miss.missedTokens
  totals.missedCost += miss.missedCost
  totals.missCount += 1
}

/**
 * Walk the ordered history once and produce every answer the card needs.
 *
 * One walk rather than three: the same pass yields the totals, the per-turn
 * misses and the trailing segment state, so they cannot disagree with each
 * other, and a caller rebuilding a transcript from scratch re-derives exactly
 * what the live turn derived.
 */
function scan(entries: readonly StepCodeCacheEntry[]): CacheScan {
  let prev: StepCodePreviousRequest | undefined
  const totals = emptyTotals()
  const misses = new Map<StepCodeCacheTurn, StepCodeCacheMiss>()

  for (const entry of entries) {
    if (entry.kind === 'compaction' || entry.kind === 'branch-summary') {
      // The context legitimately changed; the next turn's prompt is new content,
      // not re-billed content, so the baseline is dropped. Model switches are NOT
      // exempt: they re-bill the full prompt and must be counted.
      prev = undefined
      continue
    }
    const miss = detectCacheMiss(prev, entry.turn)
    if (miss !== undefined) {
      addMiss(totals, miss)
      misses.set(entry.turn, miss)
    }
    prev = asPreviousRequest(entry.turn, prev?.reportedCache ?? false) ?? prev
  }
  return { prev, totals, misses }
}

/**
 * Cumulative cache waste across a segment: prompt tokens that should have been
 * cache reads because they were in the previous turn's prompt, and were not.
 */
export function computeCacheWaste(entries: readonly StepCodeCacheEntry[]): StepCodeCacheWasteTotals {
  return scan(entries).totals
}

/**
 * Every counted miss, keyed by the turn that paid for it (by reference).
 *
 * The key is the turn object, so a caller re-deriving notices while rebuilding a
 * transcript can look a turn up without inventing a second identity for it.
 */
export function collectCacheMisses(
  entries: readonly StepCodeCacheEntry[],
): ReadonlyMap<StepCodeCacheTurn, StepCodeCacheMiss> {
  return scan(entries).misses
}

/**
 * The miss for a turn that has just completed.
 *
 * `entries` must NOT already contain `turn`: the caller passes the history as
 * of before the turn. A turn that is present twice would be compared against
 * itself, which always reads as a total miss.
 */
export function detectCacheMissForTurn(
  entries: readonly StepCodeCacheEntry[],
  turn: StepCodeCacheTurn,
): StepCodeCacheMiss | undefined {
  return detectCacheMiss(scan(entries).prev, turn)
}
