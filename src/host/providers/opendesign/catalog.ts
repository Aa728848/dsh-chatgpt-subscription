/**
 * Merge the shipped table, the last gateway listing and the user's per-model
 * override into the descriptor the harness validates.
 *
 * Context window and output cap are provider facts, not preferences: the harness
 * sizes its prompt budget against `context.contextWindow`, so an understated
 * window silently truncates history. This line ships no per-model windows (the
 * gateway publishes none to an API key), so the window is the line default until
 * a live listing or a user override states one.
 *
 * @module dsh-chatgpt-subscription/opendesign-catalog
 */
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_EFFORTS,
  DEFAULT_MAX_TOKENS,
  catalogEntry,
  type OpenDesignDiscoveredModel,
  type OpenDesignModelInfo,
} from './types.ts'
import type { OpenDesignCatalogModel } from './token-store.ts'

/** The wire's whole modality vocabulary; a listing may claim more than it accepts. */
const SEAM_MODALITIES = new Set(['text', 'image'])

function definedOnly<T extends Record<string, unknown>>(value: T | undefined): Partial<T> {
  if (value === undefined) return {}
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined && entry !== null) result[key] = entry
  }
  return result as Partial<T>
}

/**
 * The output budget to advertise for one model.
 *
 * `defaultMaxTokens` is what a request asks for, not what the model can emit,
 * and the harness spends it twice: it fills a request's `max_tokens` from it
 * and reserves the same number as completion room before deciding to compact.
 * So a published ceiling clamps the configured budget rather than becoming it,
 * and a budget is never taken past half the window.
 */
export function resolveOutputBudget(budget: number | undefined, ceiling: number | undefined, contextWindow: number): number | undefined {
  const wanted = Number.isFinite(budget) && (budget ?? 0) > 0 ? budget : undefined
  const most = Number.isFinite(ceiling) && (ceiling ?? 0) > 0 ? ceiling : undefined
  const chosen = wanted === undefined ? most : most === undefined ? wanted : Math.min(wanted, most)
  if (chosen === undefined) return undefined
  const half = Number.isFinite(contextWindow) && contextWindow > 0 ? Math.floor(contextWindow / 2) : undefined
  return half === undefined ? chosen : Math.min(chosen, half)
}

/**
 * Whether the subscription is known to serve one model.
 *
 * `servedModelIds === null` is "nobody has ever measured this plan": the absence
 * of a fact is not a denial, so nothing is hidden on its strength and the shipped
 * table stands in exactly as it did before this fact existed. An array is a
 * measurement taken from a successful scan, and an id outside it is a model this
 * plan does not serve — it stays in the editor as a described model, it just stops
 * being advertised.
 *
 * The user's own override lives one layer up (`forceVisibleModels`): this function
 * answers what the plan said, never what the user decided.
 */
export function isModelServed(model: string, servedModelIds: readonly string[] | null): boolean {
  return servedModelIds === null || servedModelIds.includes(model)
}

/**
 * Resolve the metadata one model is advertised with.
 *
 * Precedence per field: the user's override, then the last gateway listing,
 * then the shipped table, then the route-wide fallback. The listing sits above
 * the shipped table for the fields the table cannot carry (window, modalities):
 * the table's windows do not exist to be beaten, and its names/prices are
 * curated, so a listing that states no name keeps the table's.
 */
export function resolveModelInfo(
  model: string,
  options: {
    /** Entries persisted by the last catalog sync. */
    synced: readonly OpenDesignCatalogModel[]
    /** Stored context-window override. */
    contextWindowOverride?: number
    /** Route-wide fallback window. */
    defaultContextWindow?: number
    /** Route-wide output budget. */
    defaultMaxTokens?: number
  },
): OpenDesignModelInfo {
  const synced = options.synced.find((entry) => entry.id === model)
  const shipped = catalogEntry(model)
  const published = {
    ...definedOnly(shipped as unknown as Record<string, unknown>),
    ...definedOnly(synced as unknown as Record<string, unknown>),
  } as OpenDesignDiscoveredModel

  const fallbackWindow = options.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW
  const contextWindow = options.contextWindowOverride ?? published.contextWindow ?? fallbackWindow
  const maxTokens = resolveOutputBudget(
    options.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
    published.maxTokens,
    contextWindow,
  )
  const reasoning = published.reasoning ?? shipped?.reasoning ?? true
  // Ladder precedence: the live listing, then the shipped table, then the line
  // default. An EMPTY published ladder is a statement (the model exposes none),
  // distinct from absence; only absence falls through to the default trio.
  const publishedEfforts = Array.isArray(published.efforts) && published.efforts.length > 0 ? published.efforts : undefined
  const efforts = publishedEfforts ?? (shipped?.efforts !== undefined && shipped.efforts.length > 0 ? [...shipped.efforts] : DEFAULT_EFFORTS)
  const defaultEffort = reasoning && shipped?.defaultEffort !== undefined && efforts.includes(shipped.defaultEffort)
    ? shipped.defaultEffort
    : undefined
  const declaredInput = Array.isArray(published.input) && published.input.length > 0
    ? published.input
    : shipped?.input ?? ['text']
  const input = declaredInput.filter((entry) => SEAM_MODALITIES.has(entry))

  return {
    id: model,
    displayName: String(published.name ?? '').trim() || model,
    contextWindow,
    maxTokens: maxTokens ?? (options.defaultMaxTokens ?? DEFAULT_MAX_TOKENS),
    reasoning,
    ...(reasoning ? { efforts } : { efforts: [] }),
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    input: input.length > 0 ? input : ['text'],
    ...(shipped?.pricing === undefined ? {} : { pricing: shipped.pricing }),
  }
}
