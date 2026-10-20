/**
 * Merge the shipped catalog, the live scan and the user's per-model override into
 * the descriptor the harness validates.
 *
 * Context window and output cap are provider facts, not preferences: the harness
 * sizes its prompt budget against `context.contextWindow`, so an understated
 * window silently truncates history.
 *
 * @module dsh-chatgpt-subscription/cline-pass-catalog
 */
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  REASONING_EFFORTS,
  catalogEntry,
  type ClinePassDiscoveredModel,
  type ClinePassModelInfo,
} from './types.ts'
import type { ClinePassCatalogModel } from './token-store.ts'

/** The seam's whole modality vocabulary; a catalog may list more than it accepts. */
const SEAM_MODALITIES = new Set(['text', 'image'])

/** First defined value, treating empty collections and zero as "not set". */
function pick<T>(configured: T | undefined, published: T | undefined, fallback: T): T {
  if (Array.isArray(configured)) return (configured.length > 0 ? configured : published ?? fallback) as T
  if (configured !== undefined && configured !== null && (configured as unknown) !== '' && (configured as unknown) !== 0) return configured
  if (published !== undefined && published !== null) return published
  return fallback
}

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
 * `defaultMaxTokens` is what a request asks for, not what the model can emit, and
 * the harness spends it twice: it fills a request's `max_tokens` from it and
 * reserves the same number as completion room before deciding to compact. So the
 * published output ceiling clamps the configured budget rather than becoming it,
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

/** Every effort the shipped vocabulary names, in escalating order. */
function allEfforts(): readonly string[] {
  return REASONING_EFFORTS.map((effort) => effort.id)
}

/**
 * Resolve the metadata one model is advertised with.
 *
 * Precedence per field: the user's override, then the shipped table, then what
 * the last official scan published, then the entry the last gateway catalog sync
 * stored, then the route-wide fallback.
 *
 * The live scan sits below the shipped table because the shipped entry is
 * curated: a community catalog reports extra modalities and underscore-free
 * spellings the seam or the provider's label does not want. It exists to cover
 * what the table cannot know — a model published after this release.
 */
export function resolveModelInfo(
  model: string,
  options: {
    /** Display name for the bare id. */
    displayName: string
    /** Entries persisted by the last catalog sync. */
    synced: readonly ClinePassCatalogModel[]
    /** What the last official scan published for this id. */
    discovered?: ClinePassDiscoveredModel
    /** Stored context-window override. */
    contextWindowOverride?: number
    /** Route-wide fallback window. */
    defaultContextWindow?: number
    /** Route-wide output budget. */
    defaultMaxTokens?: number
  },
): ClinePassModelInfo {
  const synced = options.synced.find((entry) => entry.id === model)
  const published = {
    ...definedOnly(synced as unknown as Record<string, unknown>),
    ...definedOnly(options.discovered as unknown as Record<string, unknown>),
    ...definedOnly(catalogEntry(model) as unknown as Record<string, unknown>),
  } as ClinePassDiscoveredModel & { maxTokens?: number }

  const fallbackWindow = options.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW
  const contextWindow = pick<number>(
    options.contextWindowOverride,
    pick<number>(published.contextWindow, undefined, fallbackWindow),
    fallbackWindow,
  )
  const maxTokens = resolveOutputBudget(
    options.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
    published.maxTokens,
    contextWindow,
  )
  const reasoning = published.reasoning ?? true
  const declaredInput = Array.isArray(published.inputModalities)
    ? published.inputModalities
    : Array.isArray(published.input) ? published.input : undefined
  const input = pick<readonly string[]>(declaredInput, undefined, ['text'])
    .filter((entry) => SEAM_MODALITIES.has(entry))
  const efforts = Array.isArray(published.efforts) && published.efforts.length > 0
    ? published.efforts
    : allEfforts()

  return {
    id: model,
    displayName: String(published.name ?? '').trim() || model.replace(/^cline-pass\//, '') || model,
    contextWindow,
    maxTokens: maxTokens ?? (options.defaultMaxTokens ?? DEFAULT_MAX_TOKENS),
    reasoning,
    efforts,
    input: input.length > 0 ? input : ['text'],
  }
}
