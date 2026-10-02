import { supportsOllamaImage, supportsOllamaThinkingControl } from '../common/capabilities.ts'

/**
 * Static facts about the Ollama provider API.
 *
 * Ollama publishes three surfaces, and this line speaks two of them:
 *
 * - the **native API** (`https://ollama.com/api`) — Ollama's own wire format,
 *   with `/api/chat` and `/api/tags`;
 * - the **OpenAI-compatible API** (`https://ollama.com/v1`) — a documented
 *   subset of the OpenAI API, which is what a coding agent wants by default
 *   because its tool-calling and streaming shapes are the familiar ones.
 *
 * A third surface, the Anthropic-compatible `/v1/messages`, exists and is not
 * used here: the Claude line already transcribes the Anthropic wire format
 * against a snapshot it can verify, and routing Ollama's subset of it through
 * the same mapper would claim capabilities Ollama does not document.
 *
 * DOCUMENTED CLOUD LIMITS (docs/api/openai-compatibility, docs/cloud):
 *
 * - No stateful Responses. Only the stateless form works.
 * - No built-in web search through `/v1/responses`.
 * - No custom/freeform tool-call replay.
 *
 * Those are server-side capability limits, not choices made here, so this line
 * sends ordinary `tools` arrays and streams ordinary `tool_calls` back, and
 * makes no promise about replaying a custom tool call across turns. Saying so
 * in the settings card is the honest rendering of a documented boundary.
 *
 * Authentication is a static API key in `Authorization: Bearer`, not an OAuth
 * flow: keys do not expire and are revoked from the account settings page.
 */

export const PROVIDER_ID = 'ollama'
export const PROVIDER_NAME = 'Ollama'

/** Direct cloud access, per docs/api/introduction. */
export const CLOUD_BASE_URL = 'https://ollama.com'

/** Native surface. */
export const NATIVE_CHAT_PATH = '/api/chat'
export const NATIVE_TAGS_PATH = '/api/tags'

/** OpenAI-compatible surface. */
export const OPENAI_BASE_URL = 'https://ollama.com/v1'
export const OPENAI_CHAT_PATH = '/chat/completions'
export const OPENAI_MODELS_PATH = '/models'

/**
 * Default context window for a model whose catalog entry states none.
 *
 * Ollama's `/api/tags` returns names and families, not context windows, so a
 * fixed conservative value is the honest number here. It is deliberately small
 * enough to be true of every cloud model rather than flattering to one.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000

/**
 * Output cap used when neither the caller nor the catalog states one.
 *
 * Ollama does not document a per-model maximum output length, and unlike the
 * Claude line there is no snapshot to read one from, so this is a request-level
 * ceiling rather than a claim about what the model can do.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192

/** How long a catalog sync may take before the cached list is used instead. */
export const CATALOG_TIMEOUT_MS = 15_000

/**
 * Cooldown one account takes when Ollama refuses it without stating a delay.
 *
 * A 429 here is a real quota or rate limit, not a blip, so the account is parked
 * for long enough that the next request goes to a different one.
 */
export const POOL_COOLDOWN_MS = 15 * 60_000

/**
 * The two wire shapes this line can speak, per request.
 *
 * A user picks the line once; which surface serves a given turn is decided here,
 * not exposed as a setting, because the two are not interchangeable from the
 * caller's side: both accept the same tool definitions and return the same
 * assistant message.
 */
export type OllamaWire = 'openai' | 'native'

/** One model as Ollama's `/api/tags` reports it. */
export interface OllamaCatalogModel {
  id: string
  name?: string
  contextWindow?: number
  /** Unix milliseconds this entry was read from the service. */
  fetchedAt?: number
}

/**
 * NO fallback model names.
 *
 * An earlier revision hard-coded `gpt-oss:120b-cloud` and `gpt-oss:20b-cloud`
 * here, and they reached the model picker. That was wrong twice over: this line
 * has no model table of its own, so every name in it would be a guess about what
 * some account is entitled to, and a guess that lands in the picker is a model a
 * user can select and then fail on. The other lines can fall back to hard-coded
 * names because theirs are transcribed from a real table - Claude's is its own
 * frozen catalog. Ollama's truth is `/api/tags`, and there is nothing honest to
 * stand in for it before the first sync.
 *
 * So the catalog starts empty and the card says the list has not been synced yet,
 * with the sync button right beside it. A user who has a key is one click from a
 * list that is actually theirs.
 */
export const FALLBACK_MODELS: readonly OllamaCatalogModel[] = Object.freeze([])

/**
 * Resolve the wire shape for a model.
 *
 * `openai` first, always: the OpenAI-compatible surface is the one whose tool
 * and streaming semantics this plugin's mapper already implements faithfully,
 * and it is what an agent wants. `native` is the fallback for the documented
 * cases where the OpenAI surface refuses a request, so a model the service
 * accepts natively still works instead of failing outright.
 */
export function wireForModel(_model: string): OllamaWire {
  return 'openai'
}

/** Context window for a model, falling back to the conservative constant. */
export function contextWindowFor(model: OllamaCatalogModel | undefined): number {
  const stated = model?.contextWindow
  return typeof stated === 'number' && Number.isFinite(stated) && stated > 0
    ? Math.floor(stated)
    : DEFAULT_CONTEXT_WINDOW
}

/** Bearer headers for a stored key. */
export function ollamaHeaders(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
  }
}

/**
 * Tightly-scoped check for known vision-capable models in Ollama.
 * Conservative allowlist of known vision families; unknown models default to false.
 */
export function ollamaModelSupportsImage(modelId: string): boolean {
  return supportsOllamaImage(modelId, 'openai', 'api-key')
}

export type OllamaThinkingMode = 'levels' | 'boolean' | 'none'

/**
 * Resolve model-specific thinking support in Ollama.
 * Source: official https://github.com/ollama/ollama/blob/main/docs/capabilities/thinking.mdx
 * - 'levels': gpt-oss family (values low, medium, high; cannot disable thinking)
 * - 'boolean': deepseek-r1, qwq, qwen3 families (values true, false)
 * - 'none': all other / unknown models (omit thinking control entirely)
 */
export function thinkingModeForModel(modelId: string): OllamaThinkingMode {
  if (!supportsOllamaThinkingControl(modelId, 'native', 'api-key')) return 'none'
  const base = modelId.toLowerCase().split(':')[0] ?? ''
  if (base === 'gpt-oss') {
    return 'levels'
  }
  if (base === 'deepseek-r1' || base === 'qwq' || base === 'qwen3') {
    return 'boolean'
  }
  return 'none'
}

/**
 * Map reasoning effort to wire think parameter for the target model.
 * Per Ollama docs:
 * - gpt-oss: only 'low' | 'medium' | 'high' are valid. gpt-oss cannot disable thinking, so 'none'
 *   as well as 'xhigh'/'max'/garbage MUST be omitted (undefined).
 * - boolean models: 'none' -> false; 'low'|'medium'|'high'|'auto'|'true' -> true; garbage -> undefined.
 * - all other models: omit (undefined).
 */
export function thinkForModel(modelId: string, reasoningEffort: unknown): boolean | string | undefined {
  if (reasoningEffort === undefined || reasoningEffort === null) return undefined
  const mode = thinkingModeForModel(modelId)
  if (mode === 'none') return undefined
  const effort = String(reasoningEffort).toLowerCase()
  if (mode === 'boolean') {
    if (effort === 'none') return false
    if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'auto' || effort === 'true') {
      return true
    }
    return undefined
  }
  // mode === 'levels' (gpt-oss)
  if (effort === 'low' || effort === 'medium' || effort === 'high') {
    return effort
  }
  if (effort === 'auto' || effort === 'true') {
    return 'medium'
  }
  return undefined
}
