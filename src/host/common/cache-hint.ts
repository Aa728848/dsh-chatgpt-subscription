/** Pure cache-expiry notice policy; no provider state or I/O. */
export interface CacheHintInput {
  readonly now: number
  readonly lastActiveAt?: number
  readonly totalTokens?: number
  readonly ttlMs?: number
  readonly minTokensToHint?: number
}

export type CacheHintDecision =
  | { readonly kind: 'skip' }
  | { readonly kind: 'hint'; readonly idleMs: number; readonly totalTokens: number }

/** Missing data always skips; a provider must supply its own measured TTL. */
export function evaluateCacheHint(input: CacheHintInput): CacheHintDecision {
  const { now, lastActiveAt, totalTokens } = input
  if (lastActiveAt === undefined || totalTokens === undefined) return { kind: 'skip' }
  if (!Number.isFinite(lastActiveAt) || !Number.isFinite(totalTokens)) return { kind: 'skip' }
  const ttlMs = input.ttlMs
  const minTokens = input.minTokensToHint ?? 100_000
  if (ttlMs === undefined || !Number.isFinite(ttlMs) || ttlMs <= 0) return { kind: 'skip' }
  if (!Number.isFinite(minTokens) || minTokens < 0 || totalTokens < minTokens) return { kind: 'skip' }
  const idleMs = now - lastActiveAt
  if (idleMs <= ttlMs) return { kind: 'skip' }
  return { kind: 'hint', idleMs, totalTokens }
}
