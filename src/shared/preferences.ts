import { DEFAULT_VISIBLE_CODEX_MODEL_IDS } from './model-catalog.ts'
import type {
  CodexOutputVerbosity,
  CodexReasoningSummary,
  ProxyMode,
  SearchProviderPreference,
  SubagentModelRouteDto,
  SubagentModelsByMainModelDto,
  SubscriptionPreferencesDto,
} from './contracts.ts'

export const PREFERENCES_NAMESPACE = 'dsh-chatgpt-subscription'

export const DEFAULT_PREFERENCES: Omit<SubscriptionPreferencesDto, 'writable'> = {
  enabled: true,
  quickQuotaVisible: false,
  fastMode: false,
  outputVerbosity: null,
  reasoningSummary: null,
  visibleModelIds: [...DEFAULT_VISIBLE_CODEX_MODEL_IDS],
  searchProvider: 'dsh',
  // Empty until the user overrides one: an absent key means "use the catalog
  // default", so a restored default stores nothing at all.
  contextWindowOverrides: {},
  proxyMode: 'auto',
  customProxyUrl: null,
  // Off by default: every deployment summarizes on the model that built the
  // conversation until an operator picks another route.
  compactionRoute: null,
  // No per-main-model routing until an operator configures one, so a stored
  // document stays exactly as small as the choices it actually carries.
  subagentDefaultModels: [],
  subagentModelsByMainModel: {},
}

export const SEARCH_PROVIDER_DSH: SearchProviderPreference = 'dsh'
export const SEARCH_PROVIDER_CODEX: SearchProviderPreference = 'codex'

export function isSearchProviderPreference(value: unknown): value is SearchProviderPreference {
  return value === SEARCH_PROVIDER_DSH || value === SEARCH_PROVIDER_CODEX
}

export function isCodexOutputVerbosity(value: unknown): value is CodexOutputVerbosity {
  return value === 'low' || value === 'medium' || value === 'high'
}

export function isCodexReasoningSummary(value: unknown): value is CodexReasoningSummary {
  return value === 'auto' || value === 'concise' || value === 'detailed' || value === 'none'
}

export function isProxyMode(value: unknown): value is ProxyMode {
  return value === 'auto' || value === 'custom' || value === 'direct'
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Read one non-empty trimmed string field.
 * @param value - Candidate field value from stored JSON.
 * @returns the trimmed string, or undefined when it is not a non-empty string.
 */
function trimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Whether one value is a complete `{ provider, model }` route.
 *
 * Both halves are trimmed and must be non-empty: a route with a blank provider
 * names no adapter, and a blank model names no model, so neither can ever be
 * authorized. Stored documents are untrusted JSON, which is why this narrows
 * rather than asserts.
 * @param value - Candidate route.
 * @returns whether the value is a usable route.
 */
export function isSubagentModelRoute(value: unknown): value is SubagentModelRouteDto {
  const record = asRecord(value)
  if (record === undefined) return false
  return trimmedString(record['provider']) !== undefined && trimmedString(record['model']) !== undefined
}

/**
 * Normalize one route list, deduplicating it without reordering.
 *
 * Order is preserved because it is the order the settings card shows and the
 * order `list_subagent_models` prints: a set would silently reshuffle the list
 * a user arranged.
 * @param value - Candidate route list from stored JSON.
 * @returns the trimmed, deduplicated routes, or null when the value is not an
 *   array of well-formed routes.
 */
export function normalizeSubagentModelRoutes(value: unknown): SubagentModelRouteDto[] | null {
  if (!Array.isArray(value)) return null
  const routes: SubagentModelRouteDto[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (!isSubagentModelRoute(entry)) return null
    const provider = (entry.provider as string).trim()
    const model = (entry.model as string).trim()
    const key = `${provider}/${model}`
    if (seen.has(key)) continue
    seen.add(key)
    routes.push({ provider, model })
  }
  return routes
}

/**
 * Whether one key names a main agent route as `provider/model`.
 *
 * The split is at the FIRST slash, so a model id that legally contains a slash
 * (`command-code` + `deepseek/deepseek-v4.1-flash`) still round-trips: the
 * provider half ends at the first separator and the model half keeps the rest.
 * @param key - Candidate map key.
 * @returns whether the key carries a non-empty provider and a non-empty model.
 */
export function isValidMainModelKey(key: string): boolean {
  if (typeof key !== 'string') return false
  const trimmed = key.trim()
  const separator = trimmed.indexOf('/')
  if (separator <= 0) return false
  return trimmed.slice(separator + 1).length > 0
}

/**
 * Merge one `subagentModelsByMainModel` patch into the stored map.
 *
 * A merge rather than a replace, so the card can clear or set one main model
 * without resending every other entry — and `null` (or `[]`) is how one entry
 * is cleared, since a stored map has no other way to say "no override".
 * @param current - Map already stored in the preferences document.
 * @param patch - Incoming patch from a settings card or a route body.
 * @returns the merged map, or null when any key or value is malformed.
 */
export function mergeSubagentModelsByMainModel(
  current: SubagentModelsByMainModelDto | undefined,
  patch: unknown,
): SubagentModelsByMainModelDto | null {
  const patchRecord = asRecord(patch)
  if (patchRecord === undefined) return null
  const merged: SubagentModelsByMainModelDto = { ...current }
  for (const [rawKey, rawRoutes] of Object.entries(patchRecord)) {
    const key = rawKey.trim()
    if (!isValidMainModelKey(key)) return null
    if (rawRoutes === null || (Array.isArray(rawRoutes) && rawRoutes.length === 0)) {
      delete merged[key]
      continue
    }
    const routes = normalizeSubagentModelRoutes(rawRoutes)
    if (routes === null) return null
    merged[key] = routes
  }
  return merged
}

/**
 * Read one main model's routes out of a stored map.
 * @param byMainModel - Stored map, when the document carries one.
 * @param provider - Main agent provider id.
 * @param model - Main agent model id.
 * @returns that main model's authorized routes, or undefined when it has none.
 */
export function subagentModelsForMainModel(
  byMainModel: SubagentModelsByMainModelDto | undefined,
  provider: string | undefined,
  model: string | undefined,
): SubagentModelRouteDto[] | undefined {
  if (byMainModel === undefined || provider === undefined || model === undefined) return undefined
  if (provider.length === 0 || model.length === 0) return undefined
  const routes = byMainModel[`${provider}/${model}`]
  return routes === undefined || routes.length === 0 ? undefined : routes
}

/** Re-exported so the host parsers share one definition with the DTO. */
export { isCompactionRouteTarget } from './compaction-route.ts'
