/**
 * Static facts about the Cline Pass subscription and its gateway.
 *
 * The upstream is an OpenAI-compatible `chat/completions` endpoint
 * (`https://api.cline.bot/api/v1`). Routing is always decided by that gateway;
 * this plugin does not send client-side provider selection fields.
 *
 * The model table below is transcribed from the Cline Pass subscription list and
 * the public `models.dev` catalog. It is a fallback, not a ceiling: a model the
 * live catalog scan discovers is described by what that scan published, and a
 * model this release has never heard of is adopted with conservative metadata
 * rather than hidden.
 */

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

/** Authenticated sub-paths on the gateway. */
export const USAGE_LIMITS_PATH = '/users/me/plan/usage-limits'
export const PROFILE_PATH = '/users/me'
export const USAGE_PAGE_SIZE = 200
export const USAGE_MAX_PAGES = 12

/** Conservative context capacity for a model no catalog describes. */
export const DEFAULT_CONTEXT_WINDOW = 128_000

/** Per-request output budget when the caller states none. */
export const DEFAULT_MAX_TOKENS = 64_000

/** Streams one account may keep open at once; `0` lifts the cap. */
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 16

/** Idle budget for one Cline Pass stream, overridable per account. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000

/** Request-history rows retained in memory. */
export const DEFAULT_HISTORY_LIMIT = 100

/** How long one account-level refusal keeps an account out of the pool. */
export const POOL_COOLDOWN_MS = 15 * 60_000
export const AUTH_COOLDOWN_MS = 30 * 60_000

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
}

/** Published metadata for the shipped Cline Pass models. */
export const MODEL_CATALOG: Readonly<Record<string, ClinePassModelMeta>> = Object.freeze({
  'cline-pass/deepseek-v4.1-flash-1017': { name: 'DeepSeek V4.1 Flash 1017', contextWindow: 1_048_576, maxTokens: 384_000, reasoning: true, efforts: ['none', 'low', 'high', 'max'], input: ['text', 'image'] },
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

/** One model as the live catalog describes it, after merging all known metadata. */
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
