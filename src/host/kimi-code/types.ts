/**
 * Static facts about the Kimi Code provider API.
 *
 * Kimi Code is the subscription product (https://www.kimi.com/code); it is a
 * different system from the pay-as-you-go Moonshot Open Platform, and its keys
 * and base URLs are not interchangeable. The facts below are transcribed from
 * the official CLI sources and documentation:
 *
 * - the OAuth device flow lives on auth.kimi.com and is implemented by
 *   MoonshotAI/kimi-cli in src/kimi_cli/auth/oauth.py;
 * - the managed provider is configured as type "kimi", an OpenAI-compatible
 *   client, against https://api.kimi.com/coding/v1;
 * - the same service documents https://api.kimi.com/coding/ as an Anthropic
 *   Messages base URL for third-party tools;
 * - account quota comes from GET /coding/v1/usages.
 *
 * See https://www.kimi.com/code/docs/en/kimi-code/models.html and
 * https://www.kimi.com/code/docs/en/kimi-code/error-reference.html
 */

import type {
  KimiCodeReasoningEffort,
  KimiCodeRegion,
  KimiCodeThinkingType,
  KimiCodeWire,
} from '../../shared/kimi-code-contracts.ts'
import {
  KIMI_CODE_MODELS,
  LONG_CONTEXT_MESSAGE_BODY_BYTES,
  kimiCodeModelDef,
  type KimiCodeCatalogModel,
} from './model-catalog.ts'
import { MAX_MESSAGE_BODY_BYTES, MAX_REQUEST_IMAGE_BYTES } from '../common/request-images.ts'

export const PROVIDER_ID = 'kimi-code'
export const PROVIDER_NAME = 'Kimi Code'

/**
 * OAuth client id the official Kimi CLI registers.
 *
 * The device flow has no client secret: the client id alone identifies the
 * public client, exactly as RFC 8628 intends for a device that cannot keep one.
 */
export const KIMI_CODE_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098'

/** OAuth host serving /api/oauth/device_authorization and /api/oauth/token. */
export const DEFAULT_OAUTH_HOST = 'https://auth.kimi.com'

/** Device authorization endpoint (RFC 8628 section 3.1). */
export const DEVICE_AUTHORIZATION_PATH = '/api/oauth/device_authorization'
/** Token endpoint for both the device-code grant and refresh (RFC 8628 section 3.4). */
export const OAUTH_TOKEN_PATH = '/api/oauth/token'
/** Grant type the device-code polling request declares. */
export const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

/** Host set per region; a global account is served by the .ai properties. */
export const REGION_HOSTS: Record<KimiCodeRegion, { oauth: string; coding: string }> = {
  'mainland-cn': {
    oauth: 'https://auth.kimi.com',
    coding: 'https://api.kimi.com/coding',
  },
  global: {
    oauth: 'https://auth.kimi.ai',
    coding: 'https://api.kimi.ai/coding',
  },
}

/** OpenAI-compatible prefix; append /chat/completions or /models. */
export const OPENAI_API_PREFIX = '/v1'

export const USER_AGENT = 'dsh-chatgpt-subscription (+https://github.com/Aa728848/dsh-chatgpt-subscription)'

/**
 * Product markers the managed service recognizes.
 *
 * The official client identifies itself as kimi_cli and reports a stable
 * per-installation device id; sending the same vocabulary keeps the subscription
 * endpoints answering the way they do for the official CLI.
 */
export const MSH_PLATFORM = 'kimi_code_cli'
export const HEADER_MSH_PLATFORM = 'x-msh-platform'
export const HEADER_MSH_VERSION = 'x-msh-version'
export const HEADER_MSH_DEVICE_NAME = 'x-msh-device-name'
export const HEADER_MSH_DEVICE_MODEL = 'x-msh-device-model'
export const HEADER_MSH_OS_VERSION = 'x-msh-os-version'
export const HEADER_MSH_DEVICE_ID = 'x-msh-device-id'

/** Version the plugin reports to the managed service's telemetry headers. */
export const MSH_VERSION = '1.0.0'

/**
 * Refresh timing, copied from the official client.
 *
 * A token is refreshed once it is within max(300s, expires_in * 0.5) of expiry,
 * so a short-lived token is replaced early enough to never be used while stale.
 */
export const MIN_REFRESH_THRESHOLD_SECONDS = 300
export const REFRESH_THRESHOLD_RATIO = 0.5
/** How long a rejected refresh token is remembered before a new attempt. */
export const UNAUTHORIZED_REFRESH_RETRY_COOLDOWN_MS = 300_000
/** Attempts one refresh gets before the stored credential is declared dead. */
export const REFRESH_MAX_RETRIES = 3
/** Exponential backoff base for a retryable refresh failure. */
export const REFRESH_BACKOFF_BASE_MS = 1_000

/** Device-flow polling defaults when the service omits them. */
export const DEFAULT_DEVICE_INTERVAL_SECONDS = 5
export const DEFAULT_DEVICE_EXPIRES_SECONDS = 600

/** Local timeouts and cache lifetimes. */
export const DISCOVERY_TIMEOUT_MS = 15_000
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000
export const QUOTA_CACHE_TTL_MS = 2 * 60 * 1000
export const CATALOG_CACHE_TTL_MS = 30 * 60 * 1000

/** Output cap used when neither the registry nor the live catalog states one. */
export const DEFAULT_MAX_TOKENS = 32_768
export const DEFAULT_CONTEXT_WINDOW = 262_144

export const STREAM_IDLE_TIMEOUT_MS = 300_000
export const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

/**
 * Resolve the managed OAuth host.
 *
 * The official client lets an environment variable pin the host for testing or
 * for a private deployment; the region then supplies the default.
 */
export function oauthHost(region: KimiCodeRegion = 'mainland-cn'): string {
  const override = (process.env.DSH_KIMI_CODE_OAUTH_HOST || process.env.KIMI_CODE_OAUTH_HOST || '').trim()
  if (override !== '') return override.replace(/\/+$/, '')
  return REGION_HOSTS[region].oauth
}

/**
 * Resolve the coding API base URL without a trailing slash or version.
 *
 * The official client reads KIMI_CODE_BASE_URL, which already includes /v1;
 * this plugin keeps the prefix separate so both dialects can be built from one
 * value. An override that carries /v1 has it stripped exactly once.
 */
export function codingBaseUrl(region: KimiCodeRegion = 'mainland-cn'): string {
  const override = (process.env.DSH_KIMI_CODE_BASE_URL || process.env.KIMI_CODE_BASE_URL || '').trim()
  if (override === '') return REGION_HOSTS[region].coding
  return override.replace(/\/+$/, '').replace(/\/v1$/, '')
}

/** OpenAI-compatible request URL for one endpoint suffix. */
export function openAIUrl(suffix: string, region: KimiCodeRegion = 'mainland-cn'): string {
  return codingBaseUrl(region) + OPENAI_API_PREFIX + suffix
}

/** Anthropic-compatible request URL for one endpoint suffix, such as /v1/messages. */
export function anthropicUrl(suffix: string, region: KimiCodeRegion = 'mainland-cn'): string {
  return codingBaseUrl(region) + suffix
}

/**
 * Path the Anthropic-compatible Messages endpoint is posted to.
 *
 * The managed service exposes its Anthropic surface behind the beta gateway,
 * exactly as the official client's `client.beta.messages.create` call does.
 */
export const ANTHROPIC_MESSAGES_PATH = '/v1/messages?beta=true'


// ---------------------------------------------------------------------------
// Byte ceilings
// ---------------------------------------------------------------------------

/**
 * Byte ceiling this route enforces on one text/image request body.
 *
 * Named with the DEFAULT_ prefix, like the MiniMax and Codex resolvers, because
 * the budget belongs to the gateway in front of the route rather than to the
 * shared image machinery: common/request-images.ts keeps Kimi's figures as the
 * default arguments of functions other routes call with their own number.
 *
 * DSH_KIMI_CODE_MAX_BODY_BYTES pins a different ceiling for a deployment that has
 * measured one — a proxy or gateway in front of this route. It is parsed as bytes
 * and ignored when it is not a positive finite number, so a typo cannot silently
 * disable the guard.
 *
 * It covers the text/image tier only. A request carrying video goes to
 * MAX_VIDEO_MESSAGE_BODY_BYTES, which has no override on any route: one variable
 * spanning both tiers could not express "relax the text ceiling, leave the video
 * one alone", and a value chosen for a 2 MB conversation would collapse the video
 * tier with it. MiniMax's video budget is likewise a bare constant.
 *
 * The text/image tier is now graded by model: this constant is what the 256K
 * models keep and what an unknown model falls back to, while the 1M models
 * declare their own, larger ceiling in the registry. {@link maxRequestBodyBytesFor}
 * is the resolver that applies that grade.
 */
export const DEFAULT_MAX_MESSAGE_BODY_BYTES = MAX_MESSAGE_BODY_BYTES

/**
 * Ceiling this process enforces when the caller has no model to key on.
 *
 * Kept alongside {@link maxRequestBodyBytesFor} rather than folded into it: this
 * is the answer for "what does this deployment allow at all", which the video
 * budget and the settings reporting paths need without naming a model. A request
 * that DOES name one goes through the per-model resolver below, so a 1M-tier
 * session gets its own tier instead of this floor.
 */
export function maxMessageBodyBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.DSH_KIMI_CODE_MAX_BODY_BYTES ?? '').trim()
  if (raw === '') return DEFAULT_MAX_MESSAGE_BODY_BYTES
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_MESSAGE_BODY_BYTES
  return Math.floor(parsed)
}

/**
 * Request-body ceiling for one model, in precedence order.
 *
 * The middleware gateway that rejects a body is shared and the sessions are not:
 * a 1M-tier session produces several megabytes of conversation the 256K tier
 * cannot, so one number for both either starves the long tier or leaves the
 * short one unguarded. Hence three sources, highest priority first:
 *
 * 1. DSH_KIMI_CODE_MAX_BODY_BYTES — a measured figure for THIS deployment, so it
 *    wins over every per-model default. It still has to be a positive integer:
 *    a typo falls through to the model's own default rather than switching the
 *    guard off, which is the one failure this variable must never cause;
 * 2. the model's {@link KimiCodeCatalogModel.maxRequestBodyBytes};
 * 3. {@link DEFAULT_MAX_MESSAGE_BODY_BYTES}, for a model the registry does not
 *    know — an unknown id keeps the most conservative ceiling rather than
 *    inheriting a long-context allowance nothing has vouched for.
 *
 * @param model the registry row for the model being called, or undefined when
 * the id is not one this route ships.
 * @param env environment the override is read from, injectable for tests.
 */
export function maxRequestBodyBytesFor(
  model: KimiCodeCatalogModel | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = (env.DSH_KIMI_CODE_MAX_BODY_BYTES ?? '').trim()
  if (raw !== '') {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed)
  }
  return model?.maxRequestBodyBytes ?? DEFAULT_MAX_MESSAGE_BODY_BYTES
}

export { LONG_CONTEXT_MESSAGE_BODY_BYTES }

/**
 * Bytes one METERED token is assumed to occupy when a deployment asks this route
 * to fold its published window against the byte ceiling.
 *
 * The unit is not "bytes per real token" but "bytes per token as the host COUNTS
 * it": DSH prices text at a fixed four characters per token
 * (`@deepseek-ai/dsh-token-meter`'s estimate.ts, CHARS_PER_TOKEN = 4) whatever
 * those characters weigh on the wire. So the figure is four characters per token
 * times the bytes of one character, and each density lands somewhere different:
 *
 * | density                                    | bytes/metered token | 2 MB wall |
 * | ------------------------------------------ | ------------------- | --------- |
 * | ASCII: code, patches, JSON tool results    | 4                   | 524_288   |
 * | CJK prose mixed with English code and JSON | 8                   | 262_144   |
 * | dense CJK                                  | 12                  | 174_763   |
 *
 * These are the values DSH_KIMI_CODE_BYTES_PER_TOKEN accepts, and what each buys.
 * Folding is a choice about WHERE compaction fires, never about safety: with a
 * wall at N metered tokens the host's threshold is
 * `floor(min(0.8 x window, window - 65_536))` (this route declares no
 * `defaultMaxTokens`, so nothing is reserved), and the table says which densities
 * sit above it.
 *
 * - unset: no folding at all. The window the model declares — or the one the user
 *   explicitly overrode — is published exactly as it is. A long session reaches
 *   the 2 MB wall and recovers there, because the refusal carries
 *   CONTEXT_OVERFLOW_CODE; nothing is silently given up up front;
 * - 4: publish 524_288, threshold 419_430. Code-dominated sessions compact
 *   BEFORE the wall with 104_858 metered tokens of slack, which is the point of
 *   the setting; mixed and CJK traffic still meets the wall first;
 * - 5: publish 419_430, threshold 335_544. Same shape, a little less slack;
 * - 8: publish 262_144, threshold 196_608. ASCII and mixed text both compact in
 *   time; dense CJK does not;
 * - 12: publish 174_762, threshold 109_226. All three densities compact in time,
 *   at the cost of publishing a small window (a CJK-first deployment's choice).
 *
 * Anything smaller than 4 makes the published window larger than the byte ceiling
 * can ever fill (2 -> 1_048_576 against a 524_288-token ASCII wall), so the
 * threshold sits above even the ASCII wall and the setting buys nothing but a
 * window every session is refused before filling.
 *
 * Bytes per metered token in this process, or undefined when folding is off.
 *
 * DSH_KIMI_CODE_BYTES_PER_TOKEN is an OPTIONAL early-compaction switch, not a
 * safety guard, and the distinction decides what a bad value must do. A typo
 * cannot weaken anything here — the recovery code on an oversized refusal is the
 * safety net and it is always armed — so an empty, unparsable, zero or negative
 * value simply means "no folding", the same as leaving the variable out. (The
 * byte CEILING keeps the opposite rule, because THAT is a guard:
 * `maxMessageBodyBytes` falls back to the real limit rather than to no limit.)
 *
 * Undefined rather than a sentinel number on purpose: every caller has to decide
 * what "no ceiling" means for it, and a magic value like Infinity would silently
 * flow into arithmetic instead of forcing that decision.
 */
export function wireBytesPerToken(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = (env.DSH_KIMI_CODE_BYTES_PER_TOKEN ?? '').trim()
  if (raw === '') return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  // Never 0: a fractional value floors to zero, and dividing the ceiling by zero
  // would turn a preference into an unbounded (or meaningless) window.
  return Math.max(1, Math.floor(parsed))
}

/**
 * Token ceiling the body limit implies at the configured density, or undefined
 * when folding is off.
 *
 * The gateway in front of this route counts BYTES while DSH's compaction
 * thresholds count metered tokens taken from the window an adapter declares, and
 * the two never meet on their own. Expressing the byte ceiling in the unit the
 * host acts on is the same budget-first rule the official kimi-cli applies in
 * `soul/compaction.py::should_auto_compact` — it compacts at 85% of the window or
 * with 50K tokens left and never special-cases 2097152. This route applies that
 * rule only when a deployment asks for it, because "smaller window" is a
 * behaviour change to the model's advertised capacity, not a bug fix.
 */
export function byteDerivedTokenCap(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const bytesPerToken = wireBytesPerToken(env)
  if (bytesPerToken === undefined) return undefined
  // Never 0: an override small enough to floor to zero must still leave a usable
  // window rather than dividing the budget away.
  return Math.max(1, Math.floor(maxMessageBodyBytes(env) / bytesPerToken))
}

/**
 * Context window this route will actually honour for one model.
 *
 * Both what `resolveModel` reports to DSH — which is where the compaction
 * threshold is computed — and what the request builder budgets against, so the
 * promise and the budget cannot drift apart.
 *
 * With folding OFF, which is the default, this is the declared window itself,
 * including a window the user overrode by hand: the vendor's figure and the
 * user's explicit choice are both respected, and a session that outgrows them is
 * recovered at the byte wall rather than pre-emptively summarized.
 *
 * With folding ON it is the smaller of the declared window and
 * {@link byteDerivedTokenCap}: one number for both readers, so what the host
 * believes the model can hold is what the guard lets it send.
 *
 * A window that is missing, zero, negative or not finite is not trusted. It falls
 * back to {@link DEFAULT_CONTEXT_WINDOW} (or to the byte-derived cap when that is
 * smaller), and the result never drops below 1 so no caller ends up with an empty
 * window.
 */
export function effectiveContextWindow(
  tokenWindow: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const declared = Number.isFinite(tokenWindow) && tokenWindow > 0
    ? Math.floor(tokenWindow)
    : DEFAULT_CONTEXT_WINDOW
  const cap = byteDerivedTokenCap(env)
  return Math.max(1, cap === undefined ? declared : Math.min(declared, cap))
}

/**
 * Base64 image payload one request on this route may carry.
 *
 * Sized to leave room for the conversation inside the body ceiling above, which
 * is why it is the smaller of the two. DSH_KIMI_CODE_MAX_IMAGE_BYTES overrides it
 * under the same rules: ignored, never applied as a disabled guard.
 */
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = MAX_REQUEST_IMAGE_BYTES

/** Image budget this process enforces, honouring the deployment override. */
export function maxRequestImageBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.DSH_KIMI_CODE_MAX_IMAGE_BYTES ?? '').trim()
  if (raw === '') return DEFAULT_MAX_REQUEST_IMAGE_BYTES
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_REQUEST_IMAGE_BYTES
  return Math.floor(parsed)
}

/** Anthropic protocol revision the managed service documents. */
export const ANTHROPIC_VERSION = '2023-06-01'

/**
 * Which wire dialect a model id is served over.
 *
 * Always the OpenAI-compatible chat completions dialect: this line uses that one
 * protocol for every model, K3.1 Pro included, which is what the official agent
 * configures for the managed provider (`type = "kimi"`). The Anthropic Messages
 * dialect remains reachable only when a live listing declares it for an id
 * (see `wireForCatalogEntry`), so the answer here is a constant rather than a
 * per-model table.
 */
export function wireForModel(_modelId: string): KimiCodeWire {
  return 'openai'
}

/**
 * Thinking levels one model advertises, from the static registry.
 *
 * A registry row that declares `thinkingType: 'only'` cannot be asked to stop
 * reasoning — the service answers HTTP 400 for a disabled-thinking request — so
 * `none` is filtered out of the list it publishes.
 */
export function reasoningEffortsFor(modelId: string): string[] {
  const declared = kimiCodeModelDef(modelId)?.reasoningEfforts ?? []
  if (kimiCodeModelDef(modelId)?.thinkingType === 'only') {
    return declared.filter((effort) => effort !== 'none')
  }
  return [...declared]
}

/**
 * Thinking level one model uses when the conversation does not pick one.
 *
 * A declared default that the resolved effort list no longer contains is
 * dropped rather than carried through: with `only` in force the list can lose
 * `none`, and a default naming a level the model can no longer be asked for
 * would fail on the first turn that relied on it.
 */
export function defaultReasoningEffortFor(modelId: string): KimiCodeReasoningEffort | undefined {
  const declared = kimiCodeModelDef(modelId)?.defaultReasoningEffort ?? undefined
  if (declared === null || declared === undefined) return undefined
  return reasoningEffortsFor(modelId).includes(declared) ? declared : undefined
}

/**
 * How a model handles thinking, from the static registry.
 *
 * Exposed so the request builder and the settings card read the same row rather
 * than each re-deriving the rule; `undefined` means the registry says nothing
 * about this id, which is not the same as "thinking can be switched off".
 */
export function thinkingTypeFor(modelId: string): KimiCodeThinkingType | undefined {
  return kimiCodeModelDef(modelId)?.thinkingType
}

/**
 * Raise a disabled-thinking request to a level the model can actually run.
 *
 * Asking a thinking-only model for `none` is refused by the service with
 * HTTP 400 ("K3.1 Pro does not support disabled thinking mode"), and the user's
 * real intent there is "don't spend my quota on thinking", not "fail the turn".
 * So the effort is lifted to the model's own default — `max` for the K3.1 pair —
 * and the lift is REPORTED through `coercedFrom` so a caller can tell the user
 * what happened instead of silently spending more than they asked for.
 *
 * A model that does not declare `only`, and any effort other than `none`, is
 * returned untouched. When a thinking-only row declares no default the effort
 * becomes `undefined`, which sends no level at all and leaves the service on its
 * own default — still never a disabled-thinking request.
 */
export function coerceThinkingEffort(
  modelId: string,
  effort: KimiCodeReasoningEffort | undefined,
): { effort: KimiCodeReasoningEffort | undefined; coercedFrom: 'none' | null } {
  if (effort !== 'none') return { effort, coercedFrom: null }
  if (thinkingTypeFor(modelId) !== 'only') return { effort, coercedFrom: null }
  return { effort: defaultReasoningEffortFor(modelId), coercedFrom: 'none' }
}

/**
 * Accepted request modalities for one model.
 *
 * An unknown model falls back to text-only, matching the sibling routes: DSH
 * turns a false "no images" into a visible placeholder the user can correct,
 * while a false "images accepted" sends bytes to an endpoint that rejects the
 * whole request.
 */
export function inputModalitiesFor(modelId: string): Array<'text' | 'image' | 'video'> {
  // Video is a real modality on this route: this plugin widens DSH's
  // ModelModalityMap (see modalities.ts), so a video-capable model declares it
  // and DSH's own capability gates act on it rather than on a guess.
  return [...(kimiCodeModelDef(modelId)?.inputModalities ?? ['text'])]
}

/**
 * Room a request must leave below its context window.
 *
 * The service rejects a request whose prompt plus requested output exceeds the
 * model's window ("Your request exceeded model token limit: 262144"), so the
 * output cap is derived from the window rather than fixed. 4,096 tokens is the
 * headroom reserved for the prompt on a request that declares no size — the same
 * shape the official client's completion budgeting uses.
 */
export const CONTEXT_HEADROOM_TOKENS = 4_096

/**
 * Output cap one request asks for when the caller omits one.
 *
 * The K3 family reasons by default and `reasoning_content` is billed as output,
 * so a fixed 32K cap silently truncates a long `max`-effort turn mid-thought and
 * returns a `length` finish — the official client instead caps output at the
 * model's context window (clamped to window − prompt). The declared floor is
 * kept as a minimum so a small window cannot starve the answer.
 */
export function maxOutputTokensFor(modelId: string, contextWindow?: number): number {
  const declared = kimiCodeModelDef(modelId)?.maxTokens ?? DEFAULT_MAX_TOKENS
  const window = contextWindow ?? kimiCodeModelDef(modelId)?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  const capped = window - CONTEXT_HEADROOM_TOKENS
  return Math.max(declared, capped)
}

/**
 * Prompt-cache TTL Kimi accepts on either wire.
 *
 * Kimi's own documentation names exactly these two values, and the two wires
 * spell the request differently (see the mapper). The tier is LOCKED when a
 * prefix is first written: a later request cannot move an existing entry to the
 * other TTL, and the service re-extends an entry at the TTL it was written
 * with. Asking for `1h` therefore costs more per write than `5m`, and only pays
 * off when the same prefix is re-read inside the hour.
 */
export type KimiCacheTtl = '5m' | '1h'

/** Whether a stored preference names a tier this line can send. */
export function isKimiCacheTtl(value: unknown): value is KimiCacheTtl {
  return value === '5m' || value === '1h'
}

/**
 * Reduce the requested output cap so prompt + output fit the window.
 *
 * `estimatedInputTokens` is the caller's own size estimate; when it is absent
 * the cap is left alone rather than guessed at, because under-asking truncates
 * reasoning while over-asking is rejected outright — the service is the final
 * authority and only it knows the real prompt size.
 */
export function clampOutputToContext(
  requested: number,
  contextWindow: number,
  estimatedInputTokens?: number,
): number {
  if (estimatedInputTokens === undefined || !Number.isFinite(estimatedInputTokens)) return requested
  const available = contextWindow - Math.max(0, estimatedInputTokens) - CONTEXT_HEADROOM_TOKENS
  if (available <= 0) return Math.min(requested, CONTEXT_HEADROOM_TOKENS)
  return Math.min(requested, available)
}

/** Reasoning levels the whole route understands, for route-level validation. */
export function isKimiCodeReasoningEffort(value: unknown): value is KimiCodeReasoningEffort {
  return value === 'low' || value === 'high' || value === 'max' || value === 'none'
}

/** Context window used before the live catalog has answered. */
export const FALLBACK_MODELS: ReadonlyArray<{ id: string; name: string; contextWindow: number }> =
  KIMI_CODE_MODELS.map((model) => ({ id: model.id, name: model.name, contextWindow: model.contextWindow }))
