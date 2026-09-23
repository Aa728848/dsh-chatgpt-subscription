/**
 * Merge semantics for the per-model context window overrides every provider
 * page stores.
 *
 * A patch value of `null` means "drop this override and fall back to the
 * catalog default", which is what the settings card's restore button sends.
 * Persisted settings stay `Record<string, number>`: the `null` never reaches a
 * store, it only travels over the wire.
 */
export type ContextWindowOverridePatch = Record<string, number | null>

export function mergeContextWindowOverrides(
  current: Record<string, number> | undefined,
  patch: ContextWindowOverridePatch,
): Record<string, number> {
  const merged: Record<string, number> = { ...(current ?? {}) }
  for (const [model, contextWindow] of Object.entries(patch)) {
    if (contextWindow === null) delete merged[model]
    else merged[model] = contextWindow
  }
  return merged
}
