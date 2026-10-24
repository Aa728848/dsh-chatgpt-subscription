/**
 * Static facts about the Cline Pass subscription and its gateway.
 *
 * The upstream is an OpenAI-compatible `chat/completions` endpoint
 * (`https://api.cline.bot/api/v1`) that fronts several model providers. Routing
 * is decided by that gateway, and the two pipelines it can use spell an upstream
 * pin differently — see `protocol.ts`. Authentication is a static API key in
 * `Authorization: Bearer`: there is no OAuth flow and no token expiry.
 *
 * The model table below is transcribed from the Cline Pass subscription list and
 * the public `models.dev` catalog. It is a fallback, not a ceiling: a model the
 * live catalog scan discovers is described by what that scan published, and a
 * model this release has never heard of is adopted with conservative metadata
 * rather than hidden.
 */

import type { ClinePassPinMode } from '../../shared/cline-pass-contracts.ts'

export const PROVIDER_ID = 'cline-pass'
export const PROVIDER_NAME = 'Cline Pass'

/** Default gateway. Overridable per deployment and per account. */
export const DEFAULT_BASE_URL = 'https://api.cline.bot/api/v1'

/** Public endpoint that lists subscription models without auth. */
export const RECOMMENDED_MODELS_URL = 'https://api.cline.bot/api/v1/ai/cline/recommended-models'
/** The upstream gateway's own catalog: the only source naming reasoning levels. */
export const VERCEL_MODELS_URL = 'https://ai-gateway.vercel.sh/v1/models'
/** The community model registry, a metadata backstop. */
export const MODELS_DEV_URL = 'https://models.dev/api.json'
/** OpenRouter's public API, used only for direct-pipeline endpoint detail. */
export const OPENROUTER_API = 'https://openrouter.ai/api/v1'

/** Authenticated sub-paths on the gateway. */
export const USAGE_LIMITS_PATH = '/users/me/plan/usage-limits'
export const PROFILE_PATH = '/users/me'
export const USAGE_PAGE_SIZE = 200
export const USAGE_MAX_PAGES = 12

/** Conservative context capacity for a model no catalog describes. */
export const DEFAULT_CONTEXT_WINDOW = 128_000

/**
 * Per-request output budget when the caller states none.
 *
 * A budget, not a ceiling: the harness reserves it as completion room before it
 * compacts, so this decides how much of the window stays available. 64k keeps
 * the reserve far below the compaction ratio while leaving room for a
 * tool-calling agent's longest turn.
 */
export const DEFAULT_MAX_TOKENS = 64_000

/** Streams one account may keep open at once; `0` lifts the cap. */
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 16

/** Idle budget for one Cline Pass stream. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Request-history rows retained in memory. */
export const DEFAULT_HISTORY_LIMIT = 100

/**
 * How long one account-level refusal keeps an account out of the pool.
 *
 * Only the two refusals that are about the ACCOUNT are listed: a transient 429
 * is answered by the channel retry, and standing an account down for it would
 * cost capacity the request never proved was gone.
 */
export const POOL_COOLDOWN_MS = 15 * 60_000
export const AUTH_COOLDOWN_MS = 30 * 60_000

/** How many channels one model's list may hold. */
export const MAX_UPSTREAMS = 64

/** How many channels one validation run tests concurrently. */
export const VALIDATE_CONCURRENCY = 5

/** Reasoning levels the gateway accepts for every reasoning-capable model. */
export const REASONING_EFFORTS = [
  { id: 'none', name: 'None', description: 'No extra thinking; fastest and cheapest.' },
  { id: 'minimal', name: 'Minimal', description: 'A bare minimum of reasoning.' },
  { id: 'low', name: 'Low', description: 'Prefer for routine or latency-sensitive work.' },
  { id: 'medium', name: 'Medium', description: 'A balanced amount of reasoning.' },
  { id: 'high', name: 'High', description: 'More thorough reasoning for multi-step work.' },
  { id: 'xhigh', name: 'Extra high', description: 'For difficult work that rewards more thinking.' },
  { id: 'max', name: 'Max', description: 'Reserve for the hardest quality-first tasks.' },
] as const

export type ClinePassReasoningEffort = typeof REASONING_EFFORTS[number]['id']

/** One published model entry. */
export interface ClinePassModelMeta {
  name: string
  contextWindow: number
  maxTokens: number
  reasoning: boolean
  /** Levels this model offers; absent keeps the whole vocabulary. */
  efforts?: readonly string[]
  input: readonly string[]
  /** Vercel gateway capability filter needed to make its pin/harvest path answer. */
  gatewayHas?: readonly string[]
}

/**
 * Published metadata for the shipped Cline Pass models.
 *
 * `name` mirrors the provider's own label where one is published and falls back
 * to the model id. `maxTokens` is the published output ceiling, used to clamp the
 * configured request budget rather than taken as the budget itself.
 */
export const MODEL_CATALOG: Readonly<Record<string, ClinePassModelMeta>> = Object.freeze({
  // The dated snapshot is a first-class entry, not just a scan adoption: the
  // gateway's pin handling is decided per model id and has differed between
  // the stable alias and the snapshot, so the user must be able to pick the
  // exact id a probe just proved pinnable.
  'cline-pass/deepseek-v4.1-flash-1017': { name: 'DeepSeek V4.1 Flash 1017', contextWindow: 1_048_576, maxTokens: 384_000, reasoning: true, efforts: ['none', 'low', 'high', 'max'], input: ['text', 'image'], gatewayHas: ['vision', 'implicit-caching'] },
  'cline-pass/deepseek-v4.1-flash': { name: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000, maxTokens: 384_000, reasoning: true, efforts: ['none', 'low', 'high', 'max'], input: ['text', 'image'] },
  'cline-pass/deepseek-v4-flash': { name: 'DeepSeek V4 Flash', contextWindow: 1_000_000, maxTokens: 384_000, reasoning: true, efforts: ['none', 'low', 'medium', 'high'], input: ['text'] },
  'cline-pass/deepseek-v4-pro': { name: 'DeepSeek V4 Pro', contextWindow: 1_000_000, maxTokens: 384_000, reasoning: true, efforts: ['none', 'low', 'high', 'max'], input: ['text'] },
  'cline-pass/glm-5.3': { name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 131_072, reasoning: true, efforts: ['low', 'high', 'max'], input: ['text'] },
  'cline-pass/glm-5.3-flash': { name: 'GLM-5.3 Flash', contextWindow: 1_000_000, maxTokens: 131_072, reasoning: true, efforts: ['low', 'high', 'max'], input: ['text', 'image'] },
  'cline-pass/glm-5.2': { name: 'GLM-5.2', contextWindow: 1_000_000, maxTokens: 131_072, reasoning: true, efforts: ['none', 'high', 'max'], input: ['text'] },
  'cline-pass/kimi-k3': { name: 'Kimi K3', contextWindow: 1_048_576, maxTokens: 131_072, reasoning: true, efforts: ['low', 'high', 'max'], input: ['text', 'image'] },
  'cline-pass/kimi-k2.7-code': { name: 'Kimi K2.7 Code', contextWindow: 262_144, maxTokens: 262_144, reasoning: true, efforts: ['none', 'low', 'medium', 'high'], input: ['text', 'image'] },
  'cline-pass/kimi-k2.6': { name: 'Kimi K2.6', contextWindow: 262_144, maxTokens: 262_144, reasoning: true, input: ['text', 'image'] },
  'cline-pass/minimax-m3': { name: 'MiniMax-M3', contextWindow: 1_048_576, maxTokens: 512_000, reasoning: true, input: ['text', 'image'] },
  'cline-pass/qwen3.8-max': { name: 'Qwen3.8 Max', contextWindow: 1_000_000, maxTokens: 131_072, reasoning: true, efforts: ['none', 'low', 'medium', 'xhigh'], input: ['text', 'image'] },
  'cline-pass/qwen3.7-max': { name: 'Qwen3.7 Max', contextWindow: 1_000_000, maxTokens: 65_536, reasoning: true, input: ['text'] },
  'cline-pass/qwen3.7-plus': { name: 'Qwen3.7 Plus', contextWindow: 1_000_000, maxTokens: 64_000, reasoning: true, input: ['text', 'image'] },
  'cline-pass/mimo-v2.5-pro': { name: 'MiMo-V2.5-Pro', contextWindow: 1_048_576, maxTokens: 131_072, reasoning: true, input: ['text'] },
  'cline-pass/mimo-v2.5': { name: 'MiMo-V2.5', contextWindow: 1_048_576, maxTokens: 131_072, reasoning: true, input: ['text', 'image'] },
})

/** Subscriptions models current at release time; refreshed on demand. */
export const DEFAULT_MODELS: readonly string[] = Object.freeze(Object.keys(MODEL_CATALOG))

/** Published entry for one model id, if the shipped table knows it. */
export function catalogEntry(model: string): ClinePassModelMeta | undefined {
  return MODEL_CATALOG[model]
}

/** One stored pin, as the settings file keeps it. */
export interface ClinePassPinSettings {
  upstreams: string[]
  exclude: string[]
  pinMode: ClinePassPinMode
  sort: string
  /** `providerOptions.gateway.has`: required model capabilities for this pin. */
  has: string[]
}

/** The capability filter a model needs by default; empty for all others. */
export function defaultGatewayHas(model: string): string[] {
  return [...(catalogEntry(model)?.gatewayHas ?? [])]
}

/** The default pin: automatic routing, no exclusions, model-default capabilities. */
export function defaultPin(model = ''): ClinePassPinSettings {
  return { upstreams: [], exclude: [], pinMode: 'strict', sort: '', has: defaultGatewayHas(model) }
}

/**
 * One model as the live catalog describes it, after merging the shipped table,
 * the last official scan and any per-model override.
 */
export interface ClinePassModelInfo {
  id: string
  displayName: string
  contextWindow: number
  maxTokens: number
  reasoning: boolean
  efforts: readonly string[]
  input: readonly string[]
}

/** Connection facts one request is built from. */
export interface ClinePassConnection {
  baseURL: string
  displayName: string
  models: ClinePassModelInfo[]
  defaultContextWindow: number
  maxTokens: number
  streamIdleTimeoutMs: number
  maxConcurrentRequests: number
  pinSpelling: string
}

/** One model's metadata as the last official scan published it. */
export interface ClinePassDiscoveredModel {
  name?: string
  contextWindow?: number
  maxTokens?: number
  /** The seam vocabulary spelling (`models.dev`). */
  input?: string[]
  /** The upstream gateway's spelling. */
  inputModalities?: string[]
  reasoning?: boolean
  efforts?: string[]
}

/** The whole official scan: ids, per-model metadata, and the sources that answered. */
export interface ClinePassCatalogScan {
  models: string[]
  catalog: Record<string, ClinePassDiscoveredModel>
  sources: string[]
}
