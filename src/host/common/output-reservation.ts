/**
 * Keep fixed defaults only when they fit DSH compaction-basic's default policy.
 * This is host metadata, NEVER a wire cap. Callers must retain their original
 * wire fallback when the metadata is omitted. Explicit request caps still win.
 * Custom compaction policies and windows too small even at zero reservation
 * require deployment configuration; do not invent a larger context window.
 */
export function outputReservation(contextWindow: number, maxTokens: number): { defaultMaxTokens?: number } {
  const messageBudget = contextWindow - maxTokens
  const threshold = Math.floor(Math.min(contextWindow * 0.8, messageBudget - 65_536))
  const retain = Math.floor(messageBudget * 0.16)
  return Number.isSafeInteger(maxTokens) && maxTokens > 0 && threshold > 0 && retain < threshold
    ? { defaultMaxTokens: maxTokens }
    : {}
}
