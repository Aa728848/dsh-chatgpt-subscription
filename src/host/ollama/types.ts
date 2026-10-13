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
/** Per-model metadata: the one surface where a model states its own thinking levels. */
export const NATIVE_SHOW_PATH = '/api/show'

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

/**
 * Smallest output cap this line will send for a model whose thinking cannot be
 * turned off.
 *
 * Such a model spends its cap on reasoning before it emits any text, so a caller
 * that wants only a few words can be capped below the reasoning floor and get an
 * empty answer with a length finish - which Harness reports as a truncated
 * stream. DSH's own session-title call is the caller that hits it: it asks for
 * one short line with `maxTokens: 64`, and on a forced-thinking model every
 * title comes back empty.
 *
 * The value is carried over from the MiniMax Code line, where 512 is MEASURED:
 * 64 returns a thinking block and no text, 512 returns the title after ~53
 * output tokens. It is NOT measured on this line - see docs/ for the observation
 * that motivated it - so it is deliberately a round, conservative number rather
 * than a tight one: the cost of a too-high floor is a few unused tokens on an
 * auxiliary call, and the cost of a too-low one is the title failing at all.
 */
export const FORCED_THINKING_FLOOR_TOKENS = 512

/**
 * Raise a cap that is too small for this model's forced thinking.
 *
 * Left alone: a model whose thinking CAN be disabled - its caller may have asked
 * for thinking off on purpose, and raising the cap would not enable it while the
 * number read back would be misleading - and an absent cap, which
 * `DEFAULT_MAX_OUTPUT_TOKENS` already owns at a size nothing is short of.
 *
 * @param modelId - the routed model id.
 * @param requested - the caller's cap, undefined when it stated none.
 * @param declared - the model's own thinking metadata, when it was read.
 * @returns the cap to request, raised only when that is the difference between an
 * empty truncated answer and a usable one.
 */
export function floorForcedThinkingTokens(
  modelId: string,
  requested: number | undefined,
  declared?: OllamaThinkingCapability,
): number | undefined {
  if (requested === undefined) return undefined
  if (thinkingModeForModel(modelId, declared) !== 'levels') return requested
  return Math.max(requested, FORCED_THINKING_FLOOR_TOKENS)
}

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
 * What one model says about its own thinking, as `POST /api/show` reports it.
 *
 * `values` is the complete set the wire accepts: a boolean, meaning on/off, or
 * a level name that model defines itself (gpt-oss declares low/medium/high and
 * cannot be switched off). `[false]` means the model has no thinking to control,
 * and an absent `thinking` means the service states nothing about it. `default`
 * is the value the service uses when a request sends no `think` at all.
 *
 * Source: https://github.com/ollama/ollama/blob/main/docs/capabilities/thinking.mdx
 */
export interface OllamaThinkingCapability {
  values: readonly (boolean | string)[]
  default?: boolean | string
}

/** One selectable effort, as the picker renders it. */
export interface OllamaReasoningEffort {
  /** Sent as the caller's `reasoningEffort` and mapped onto the wire from it. */
  id: string
  name: string
}

/**
 * The ladder a levels model takes when no metadata could be read for it.
 *
 * The list is the fallback, not the answer: it can only ever name families this
 * file already knows, and a model the service describes with any other level
 * names has to be sent those names verbatim.
 */
const DEFAULT_LEVEL_EFFORTS: readonly OllamaReasoningEffort[] = Object.freeze([
  { id: 'low', name: 'low' },
  { id: 'medium', name: 'medium' },
  { id: 'high', name: 'high' },
])

/**
 * One position of a thinking ladder: what the picker offers, and the single value
 * the wire accepts for it.
 *
 * `value` is the reason this table exists. A model states what `think` takes,
 * and DSH rejects an effort that is not on the ladder before a request is built -
 * so a position that cannot name a value the model declared is not a position at
 * all. Keeping both halves in one row is what makes that impossible to get wrong:
 * the ladder is rendered from these rows, and a request is built by reversing one
 * row back to its `value`.
 */
interface OllamaDeclaredEffort {
  /** What `think` receives here: a boolean, or a level name. */
  value: boolean | string
  /** What the caller selects. */
  id: string
  /** What the picker shows. */
  name: string
}

/**
 * The on/off positions a boolean ladder is made of.
 *
 * The ids are the two values `thinkForModel` puts on the wire for such a model:
 * `none` becomes `false`, `low` becomes `true`. The names are the user's, because
 * on a model that thinks, a bare "none" reads as "this model cannot think"
 * rather than as the switch that turns its thinking off.
 */
const BOOLEAN_EFFORTS: readonly OllamaDeclaredEffort[] = Object.freeze([
  { value: false, id: 'none', name: '关闭思考' },
  { value: true, id: 'low', name: '开启思考' },
])

/** The same two positions as the picker renders them, without the wire value. */
function booleanEfforts(): OllamaReasoningEffort[] {
  return BOOLEAN_EFFORTS.map(({ id, name }) => ({ id, name }))
}

/**
 * The ladder this model declares, one row per value it accepts.
 *
 * Every row is derived from `declared.values` itself, so the ladder can neither
 * offer a position the wire would refuse nor hide one it will take: a model that
 * declares `[true]` - thinking on, with no way to switch it off - is offered
 * exactly that one position and never the off switch, which `false` there would
 * be refused for.
 *
 * Levels keep the model's own spelling and declaration order; the on/off pair
 * follows them in a fixed order (off, then on). So two models declaring the same
 * values in a different order offer the same ladder, and the last position a
 * picker shows is the one that turns thinking on rather than off.
 */
function declaredEfforts(declared: OllamaThinkingCapability): OllamaDeclaredEffort[] {
  const levels: OllamaDeclaredEffort[] = []
  const switches = new Map<boolean, OllamaDeclaredEffort>()
  const taken = new Set<string>()
  for (const value of declared.values) {
    if (typeof value === 'string') {
      if (taken.has(value)) continue
      taken.add(value)
      levels.push({ value, id: value, name: value })
      continue
    }
    const known = BOOLEAN_EFFORTS.find((entry) => entry.value === value)
    // A level name that collides with an on/off id keeps the position: it was
    // declared first, and the id is what both halves of the table key on.
    if (known === undefined || switches.has(value) || taken.has(known.id)) continue
    switches.set(value, known)
    taken.add(known.id)
  }
  const off = switches.get(false)
  const on = switches.get(true)
  return [...levels, ...(off === undefined ? [] : [off]), ...(on === undefined ? [] : [on])]
}

/**
 * Resolve model-specific thinking support in Ollama.
 *
 * The service's own metadata outranks the prefix list: `/api/show` is where a
 * model states the levels it accepts, and it is the only source there is for a
 * family this file has never heard of. The prefix list stays as the fallback for
 * a model whose metadata could not be read, and that fallback is unchanged.
 *
 * Source: official https://github.com/ollama/ollama/blob/main/docs/capabilities/thinking.mdx
 * - 'levels': named levels (gpt-oss: low, medium, high; cannot disable thinking)
 * - 'boolean': booleans (deepseek-r1, qwq, qwen3: true, false)
 * - 'none': declared [false], declared nothing, or unknown
 */
export function thinkingModeForModel(modelId: string, declared?: OllamaThinkingCapability): OllamaThinkingMode {
  if (declared !== undefined) {
    if (declared.values.some((value) => typeof value === 'string')) return 'levels'
    return declared.values.includes(true) ? 'boolean' : 'none'
  }
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
 * The efforts one model can actually be sent, in display order.
 *
 * This set is the whole contract with the harness: a level outside it is
 * rejected before a request is built (see `resolveCallWithInfo`), so it must be
 * exactly what the wire accepts and no more - which is why, when the model has
 * declared its own values, this returns that table row for row instead of
 * choosing from a fixed menu. A model that declares `[false]` is the one case
 * with a declared value and no ladder at all: `[false]` is the service saying
 * there is no thinking here to turn on or off.
 *
 * Without metadata the families this file knows answer instead, unchanged:
 * gpt-oss takes the three levels, and a boolean family takes the on/off pair.
 */
export function reasoningEffortsForModel(modelId: string, declared?: OllamaThinkingCapability): OllamaReasoningEffort[] {
  if (declared !== undefined) {
    if (thinkingModeForModel(modelId, declared) === 'none') return []
    return declaredEfforts(declared).map(({ id, name }) => ({ id, name }))
  }
  const mode = thinkingModeForModel(modelId)
  if (mode === 'none') return []
  if (mode === 'boolean') return booleanEfforts()
  return [...DEFAULT_LEVEL_EFFORTS]
}

/**
 * The effort this model's ladder should start on.
 *
 * A stored default is a per-route preference, not a per-model promise: the
 * settings card offers one ladder for the whole line, so a level chosen for one
 * model can be one this model cannot express - and DSH rejects a level that is
 * not on the ladder before a request is built. So the order is: the configured
 * level when this model has it, then the level the model itself defaults to,
 * then the ladder's own first entry.
 *
 * The last step skips a "thinking off" position. A user who picked a thinking
 * model and was handed that position would silently get a model that never
 * thinks, which is a worse wrong answer than the mildest level that does think.
 */
export function resolveOllamaDefaultEffort(
  modelId: string,
  declared: OllamaThinkingCapability | undefined,
  configured: string | null | undefined,
): string | undefined {
  const efforts = reasoningEffortsForModel(modelId, declared)
  if (efforts.length === 0) return undefined
  if (typeof configured === 'string' && efforts.some((effort) => effort.id === configured)) {
    return configured
  }
  if (declared?.default !== undefined) {
    // The declared default is a wire value; the ladder speaks effort ids. Read it
    // back through the same mapping a request uses, so the default a turn starts
    // on is the one that would be sent.
    const wanted = declared.default
    const match = efforts.find((effort) => thinkForModel(modelId, effort.id, declared) === wanted)
    if (match !== undefined) return match.id
  }
  return efforts.find((effort) => effort.id !== 'none')?.id ?? efforts[0]?.id
}

/**
 * Map reasoning effort to wire think parameter for the target model.
 * Per Ollama docs:
 * - a model that has declared its own values: the effort reverses to the one
 *   value that model declared for it, and nothing else is sent. A level the
 *   model never declared is omitted rather than coerced - a model that declares
 *   `[true]` is never asked for `false`, and one that declares ['low','high'] is
 *   never handed 'medium'. Omitting is the service's own default, which is a
 *   weaker turn and never a failed one.
 * - gpt-oss with no metadata: only 'low' | 'medium' | 'high' are valid. gpt-oss cannot disable
 *   thinking, so 'none' as well as 'xhigh'/'max'/garbage MUST be omitted (undefined).
 * - boolean models: 'none' -> false; 'low'|'medium'|'high'|'auto'|'true' -> true; garbage -> undefined.
 * - all other models: omit (undefined).
 */
export function thinkForModel(modelId: string, reasoningEffort: unknown, declared?: OllamaThinkingCapability): boolean | string | undefined {
  if (reasoningEffort === undefined || reasoningEffort === null) return undefined
  const effort = String(reasoningEffort).toLowerCase()
  // The reverse of the ladder the picker was rendered from, so a position cannot
  // mean one thing there and another on the wire.
  if (declared !== undefined) {
    for (const entry of declaredEfforts(declared)) {
      if (entry.id.toLowerCase() === effort) return entry.value
    }
    return undefined
  }
  const mode = thinkingModeForModel(modelId)
  if (mode === 'none') return undefined
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
