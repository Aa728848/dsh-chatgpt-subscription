import { ROUTING, type AntigravityModelDef } from './types.ts'
import type { AntigravityCatalogModel } from './token-store.ts'

/**
 * Smallest context window a catalog value is believed for. A smaller number is
 * far more likely a misread field than a real limit, and adopting it would
 * shrink every conversation on that model to nothing.
 */
const MIN_BELIEVABLE_CONTEXT = 8_192

/** Every runtime id one selectable model can send, in routing order. */
export function runtimeIdsFor(modelId: string): string[] {
  const routing = ROUTING[modelId]
  if (!routing) return [modelId]
  return [...new Set([routing.defaultRequestId, routing.off, ...Object.values(routing.routing)])]
}

export interface AntigravityModelLimits {
  contextWindow: number
  maxTokens: number
}

/**
 * The limits one selectable model advertises, preferring what
 * `fetchAvailableModels` reported over the built-in table.
 *
 * One selectable model fans out to several runtime ids (one per effort), and
 * the harness sizes a conversation once for all of them, so the smallest
 * reported value wins: a conversation sized for the largest would overflow the
 * moment the user drops to an effort whose runtime is smaller. A runtime the
 * catalog is silent about leaves the built-in value in force, which is also all
 * there is before the first catalog refresh.
 */
export function effectiveModelLimits(
  model: Pick<AntigravityModelDef, 'id' | 'contextWindow' | 'maxTokens'>,
  catalog: readonly AntigravityCatalogModel[] | undefined,
): AntigravityModelLimits {
  const reported = new Map((catalog ?? []).map((entry) => [entry.id, entry]))
  const contexts: number[] = []
  const outputs: number[] = []
  for (const runtimeId of runtimeIdsFor(model.id)) {
    const entry = reported.get(runtimeId)
    // The stored catalog is read back as written, so the values are checked again.
    if (isTokenCount(entry?.contextWindow) && entry.contextWindow >= MIN_BELIEVABLE_CONTEXT) contexts.push(entry.contextWindow)
    if (isTokenCount(entry?.maxOutputTokens)) outputs.push(entry.maxOutputTokens)
  }
  const contextWindow = contexts.length > 0 ? Math.min(...contexts) : model.contextWindow
  const maxTokens = outputs.length > 0 ? Math.min(...outputs) : model.maxTokens
  // An output ceiling at or above the window would leave no room for input.
  return { contextWindow, maxTokens: maxTokens >= contextWindow ? Math.floor(contextWindow / 2) : maxTokens }
}

/** The output ceiling the catalog reported for one runtime id, if it did. */
export function catalogMaxOutputFor(
  runtimeId: string,
  catalog: readonly AntigravityCatalogModel[] | undefined,
): number | undefined {
  const value = catalog?.find((entry) => entry.id === runtimeId)?.maxOutputTokens
  return isTokenCount(value) ? value : undefined
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
