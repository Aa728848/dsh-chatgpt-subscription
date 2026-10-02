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

/** The conservative view used before any catalog sync has succeeded. */
export const FALLBACK_MODELS: readonly OllamaCatalogModel[] = Object.freeze([
  Object.freeze({ id: 'gpt-oss:120b-cloud' }),
  Object.freeze({ id: 'gpt-oss:20b-cloud' }),
])

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
