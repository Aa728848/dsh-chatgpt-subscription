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

import type { KimiCodeReasoningEffort, KimiCodeRegion, KimiCodeWire } from '../../shared/kimi-code-contracts.ts'
import { KIMI_CODE_MODELS, kimiCodeModelDef } from './model-catalog.ts'

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
/** Anthropic protocol revision the managed service documents. */
export const ANTHROPIC_VERSION = '2023-06-01'

/**
 * Which wire dialect a model id is served over.
 *
 * The managed service speaks both protocols for every model, so the choice is a
 * client preference rather than a per-model constraint. The OpenAI dialect is
 * the default because that is what the official CLI configures for the managed
 * provider.
 */
export function wireForModel(_modelId: string): KimiCodeWire {
  return 'openai'
}

/** Thinking levels one model advertises, from the static registry. */
export function reasoningEffortsFor(modelId: string): string[] {
  return [...(kimiCodeModelDef(modelId)?.reasoningEfforts ?? [])]
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
