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
import type { KimiCodeReasoningEffort, KimiCodeRegion, KimiCodeWire } from '../../shared/kimi-code-contracts.ts';
export declare const PROVIDER_ID = "kimi-code";
export declare const PROVIDER_NAME = "Kimi Code";
/**
 * OAuth client id the official Kimi CLI registers.
 *
 * The device flow has no client secret: the client id alone identifies the
 * public client, exactly as RFC 8628 intends for a device that cannot keep one.
 */
export declare const KIMI_CODE_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
/** OAuth host serving /api/oauth/device_authorization and /api/oauth/token. */
export declare const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
/** Device authorization endpoint (RFC 8628 section 3.1). */
export declare const DEVICE_AUTHORIZATION_PATH = "/api/oauth/device_authorization";
/** Token endpoint for both the device-code grant and refresh (RFC 8628 section 3.4). */
export declare const OAUTH_TOKEN_PATH = "/api/oauth/token";
/** Grant type the device-code polling request declares. */
export declare const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
/** Host set per region; a global account is served by the .ai properties. */
export declare const REGION_HOSTS: Record<KimiCodeRegion, {
    oauth: string;
    coding: string;
}>;
/** OpenAI-compatible prefix; append /chat/completions or /models. */
export declare const OPENAI_API_PREFIX = "/v1";
export declare const USER_AGENT = "dsh-chatgpt-subscription (+https://github.com/Aa728848/dsh-chatgpt-subscription)";
/**
 * Product markers the managed service recognizes.
 *
 * The official client identifies itself as kimi_cli and reports a stable
 * per-installation device id; sending the same vocabulary keeps the subscription
 * endpoints answering the way they do for the official CLI.
 */
export declare const MSH_PLATFORM = "kimi_code_cli";
export declare const HEADER_MSH_PLATFORM = "x-msh-platform";
export declare const HEADER_MSH_VERSION = "x-msh-version";
export declare const HEADER_MSH_DEVICE_NAME = "x-msh-device-name";
export declare const HEADER_MSH_DEVICE_MODEL = "x-msh-device-model";
export declare const HEADER_MSH_OS_VERSION = "x-msh-os-version";
export declare const HEADER_MSH_DEVICE_ID = "x-msh-device-id";
/** Version the plugin reports to the managed service's telemetry headers. */
export declare const MSH_VERSION = "1.0.0";
/**
 * Refresh timing, copied from the official client.
 *
 * A token is refreshed once it is within max(300s, expires_in * 0.5) of expiry,
 * so a short-lived token is replaced early enough to never be used while stale.
 */
export declare const MIN_REFRESH_THRESHOLD_SECONDS = 300;
export declare const REFRESH_THRESHOLD_RATIO = 0.5;
/** How long a rejected refresh token is remembered before a new attempt. */
export declare const UNAUTHORIZED_REFRESH_RETRY_COOLDOWN_MS = 300000;
/** Attempts one refresh gets before the stored credential is declared dead. */
export declare const REFRESH_MAX_RETRIES = 3;
/** Exponential backoff base for a retryable refresh failure. */
export declare const REFRESH_BACKOFF_BASE_MS = 1000;
/** Device-flow polling defaults when the service omits them. */
export declare const DEFAULT_DEVICE_INTERVAL_SECONDS = 5;
export declare const DEFAULT_DEVICE_EXPIRES_SECONDS = 600;
/** Local timeouts and cache lifetimes. */
export declare const DISCOVERY_TIMEOUT_MS = 15000;
export declare const LOGIN_TIMEOUT_MS: number;
export declare const QUOTA_CACHE_TTL_MS: number;
export declare const CATALOG_CACHE_TTL_MS: number;
/** Output cap used when neither the registry nor the live catalog states one. */
export declare const DEFAULT_MAX_TOKENS = 32768;
export declare const DEFAULT_CONTEXT_WINDOW = 262144;
export declare const STREAM_IDLE_TIMEOUT_MS = 300000;
export declare const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";
/**
 * Resolve the managed OAuth host.
 *
 * The official client lets an environment variable pin the host for testing or
 * for a private deployment; the region then supplies the default.
 */
export declare function oauthHost(region?: KimiCodeRegion): string;
/**
 * Resolve the coding API base URL without a trailing slash or version.
 *
 * The official client reads KIMI_CODE_BASE_URL, which already includes /v1;
 * this plugin keeps the prefix separate so both dialects can be built from one
 * value. An override that carries /v1 has it stripped exactly once.
 */
export declare function codingBaseUrl(region?: KimiCodeRegion): string;
/** OpenAI-compatible request URL for one endpoint suffix. */
export declare function openAIUrl(suffix: string, region?: KimiCodeRegion): string;
/** Anthropic-compatible request URL for one endpoint suffix, such as /v1/messages. */
export declare function anthropicUrl(suffix: string, region?: KimiCodeRegion): string;
/**
 * Path the Anthropic-compatible Messages endpoint is posted to.
 *
 * The managed service exposes its Anthropic surface behind the beta gateway,
 * exactly as the official client's `client.beta.messages.create` call does.
 */
export declare const ANTHROPIC_MESSAGES_PATH = "/v1/messages?beta=true";
/** Anthropic protocol revision the managed service documents. */
export declare const ANTHROPIC_VERSION = "2023-06-01";
/**
 * Which wire dialect a model id is served over.
 *
 * The managed service speaks both protocols for every model, so the choice is a
 * client preference rather than a per-model constraint. The OpenAI dialect is
 * the default because that is what the official CLI configures for the managed
 * provider.
 */
export declare function wireForModel(_modelId: string): KimiCodeWire;
/** Thinking levels one model advertises, from the static registry. */
export declare function reasoningEffortsFor(modelId: string): string[];
/**
 * Accepted request modalities for one model.
 *
 * An unknown model falls back to text-only, matching the sibling routes: DSH
 * turns a false "no images" into a visible placeholder the user can correct,
 * while a false "images accepted" sends bytes to an endpoint that rejects the
 * whole request.
 */
export declare function inputModalitiesFor(modelId: string): Array<'text' | 'image' | 'video'>;
/**
 * Room a request must leave below its context window.
 *
 * The service rejects a request whose prompt plus requested output exceeds the
 * model's window ("Your request exceeded model token limit: 262144"), so the
 * output cap is derived from the window rather than fixed. 4,096 tokens is the
 * headroom reserved for the prompt on a request that declares no size — the same
 * shape the official client's completion budgeting uses.
 */
export declare const CONTEXT_HEADROOM_TOKENS = 4096;
/**
 * Output cap one request asks for when the caller omits one.
 *
 * The K3 family reasons by default and `reasoning_content` is billed as output,
 * so a fixed 32K cap silently truncates a long `max`-effort turn mid-thought and
 * returns a `length` finish — the official client instead caps output at the
 * model's context window (clamped to window − prompt). The declared floor is
 * kept as a minimum so a small window cannot starve the answer.
 */
export declare function maxOutputTokensFor(modelId: string, contextWindow?: number): number;
/**
 * Reduce the requested output cap so prompt + output fit the window.
 *
 * `estimatedInputTokens` is the caller's own size estimate; when it is absent
 * the cap is left alone rather than guessed at, because under-asking truncates
 * reasoning while over-asking is rejected outright — the service is the final
 * authority and only it knows the real prompt size.
 */
export declare function clampOutputToContext(requested: number, contextWindow: number, estimatedInputTokens?: number): number;
/** Reasoning levels the whole route understands, for route-level validation. */
export declare function isKimiCodeReasoningEffort(value: unknown): value is KimiCodeReasoningEffort;
/** Context window used before the live catalog has answered. */
export declare const FALLBACK_MODELS: ReadonlyArray<{
    id: string;
    name: string;
    contextWindow: number;
}>;
//# sourceMappingURL=types.d.ts.map