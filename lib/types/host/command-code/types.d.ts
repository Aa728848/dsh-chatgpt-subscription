/**
 * Static facts about the Command Code provider API.
 *
 * Command Code publishes two surfaces this plugin uses:
 *
 * - the **provider API** (`https://api.commandcode.ai/provider/v1`) which is an
 *   OpenAI-compatible `/chat/completions` endpoint, an Anthropic-compatible
 *   `/messages` endpoint, and a public `/models` catalog; and
 * - the **alpha API** (`https://api.commandcode.ai/alpha/*`) the official CLI
 *   uses for account, billing, and usage facts.
 *
 * Model ids are served by exactly one of the two provider endpoints: Anthropic
 * models are rejected on `/chat/completions` and OpenAI-format models are
 * rejected on `/messages`, so the route is decided per model, not per request.
 * See https://commandcode.ai/blog/command-code-provider-api.
 */
import type { CommandCodeApiEnv, CommandCodeWire } from '../../shared/command-code-contracts.ts';
export declare const PROVIDER_ID = "command-code";
export declare const PROVIDER_NAME = "Command Code";
/** Browser sign-in page the CLI opens; it redirects back to our loopback server. */
export declare const STUDIO_PATH = "/studio/auth/cli";
/** Query parameter that carries the loopback callback URL to the studio page. */
export declare const STUDIO_CALLBACK_PARAM = "callback";
/** Studio client marker; mirrors the value the official CLI sends. */
export declare const STUDIO_CLIENT = "cli";
export declare const API_ENDPOINTS: Record<CommandCodeApiEnv, string>;
export declare const STUDIO_ENDPOINTS: Record<CommandCodeApiEnv, string>;
/** Provider API prefix; add `/chat/completions`, `/messages`, or `/models`. */
export declare const PROVIDER_API_PREFIX = "/provider/v1";
/** Account identity the CLI reads before doing anything authenticated. */
export declare const WHOAMI_PATH = "/alpha/whoami";
/** Credit balance for the signed-in account. */
export declare const BILLING_CREDITS_PATH = "/alpha/billing/credits";
/** Plan / subscription facts for the signed-in account. */
export declare const BILLING_SUBSCRIPTIONS_PATH = "/alpha/billing/subscriptions";
/** Rolling usage accounting for the signed-in account. */
export declare const USAGE_SUMMARY_PATH = "/alpha/usage/summary";
/** First loopback port tried for the browser callback; matches the official CLI. */
export declare const DEFAULT_CALLBACK_PORT = 5959;
/** Consecutive ports probed when the default is taken; matches the official CLI. */
export declare const CALLBACK_PORT_ATTEMPTS = 10;
export declare const CALLBACK_PATH = "/callback";
/** Page the studio's browser tab lands on after a successful POST; CLI-compatible. */
export declare const CALLBACK_COMPLETE_PATH = "/callback/complete";
/** How long a landed credential waits for the browser tab before login resolves. */
export declare const CALLBACK_LANDING_GRACE_MS = 10000;
/** Body cap the official callback server enforces. */
export declare const CALLBACK_MAX_BYTES = 10000;
/** Origins the studio signs in from; echoed back for the browser's CORS check. */
export declare const CALLBACK_ALLOWED_ORIGINS: readonly ["https://commandcode.ai", "https://staging.commandcode.ai", "http://localhost:3000"];
export declare const LOGIN_TIMEOUT_MS: number;
export declare const DISCOVERY_TIMEOUT_MS = 15000;
export declare const QUOTA_CACHE_TTL_MS: number;
export declare const CATALOG_CACHE_TTL_MS: number;
export declare const DEFAULT_MAX_TOKENS = 32768;
export declare const DEFAULT_CONTEXT_WINDOW = 128000;
export declare const STREAM_IDLE_TIMEOUT_MS = 300000;
export declare const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";
/**
 * Product identity for the provider API's `User-Agent`.
 *
 * The alpha routes are identified as the CLI (they are the CLI's own API); the
 * provider routes are ordinary model calls, so they carry this plugin's
 * attribution instead of impersonating a client it is not.
 */
export declare const PLUGIN_USER_AGENT = "dsh-chatgpt-subscription (+https://github.com/Aa728848/dsh-chatgpt-subscription)";
/** User-Agent the official CLI sends; the alpha API is friendlier to a known client. */
export declare const CLI_USER_AGENT = "command-code-cli";
/** Headers the alpha API accepts, mirroring the official CLI's vocabulary. */
export declare const HEADER_API_KEY = "authorization";
export declare const HEADER_CLI_VERSION = "x-command-code-cli-version";
export declare const HEADER_CLI_ENVIRONMENT = "x-command-code-cli-environment";
export declare const HEADER_PROJECT_SLUG = "x-command-code-project-slug";
export declare const HEADER_TASTE_LEARNING = "x-command-code-taste-learning";
export declare const HEADER_SESSION_ID = "x-command-code-session-id";
export declare const HEADER_OSS_PRIMARY_PROVIDER = "x-command-code-oss-primary-provider";
export declare function resolveApiEnv(raw?: string | undefined): CommandCodeApiEnv;
export declare function apiBaseUrl(env?: CommandCodeApiEnv): string;
export declare function studioBaseUrl(env?: CommandCodeApiEnv): string;
export declare function providerUrl(env?: CommandCodeApiEnv): string;
/**
 * Which provider endpoint serves a model id.
 *
 * The split the API enforces is Anthropic-format vs OpenAI-format, and the
 * Anthropic-served catalog is exactly the `claude-*` family. Everything else —
 * the open-weight models and the GPT models — is OpenAI Chat Completions.
 *
 * @param modelId - exact model id from the live catalog or a caller.
 * @returns the wire dialect to build the request for.
 */
export declare function wireForModel(modelId: string): CommandCodeWire;
/**
 * Reasoning levels one model advertises.
 *
 * The registry is the authority: a model it describes but gives no
 * `reasoningEfforts` is a non-reasoning model, which is why that answers with an
 * empty list rather than a default level. A model the registry does not
 * describe declares nothing either — guessing from the family name is exactly
 * how `deepseek-v4-flash` got treated as a reasoner with image input when it is
 * text-only with a different effort set.
 */
export declare function reasoningEffortsFor(modelId: string): string[];
/**
 * Accepted request modalities for one model.
 *
 * An unknown model falls back to text-only: DSH turns a false "no images" into
 * a visible placeholder the user can correct by switching models, while a false
 * "images accepted" sends bytes to an endpoint that rejects the whole request.
 */
export declare function inputModalitiesFor(modelId: string): Array<'text' | 'image'>;
/**
 * Thinking-token budget one Anthropic-route reasoning level asks for.
 *
 * The registry's two extra levels are covered too: `xhigh` sits between `high`
 * and `max` (it is the level Claude Opus 5 / Fable 5 and Muse Spark 1.3 expose
 * above `high`), and `minimal` is the cheapest supported budget.
 */
export declare function anthropicThinkingBudget(effort: string): number | null;
/**
 * Output cap one request asks for when the caller omits one. A cap the registry
 * declares wins over the observed value, which in turn wins over the default.
 */
export declare function maxOutputTokensFor(modelId: string): number;
/**
 * Context windows used before the live catalog has ever been fetched.
 *
 * The public `/provider/v1/models` endpoint reports `context_length` for every
 * model and is the authority once reachable; these values only keep the model
 * picker usable on a machine that cannot reach the catalog yet. They are drawn
 * from the registry rather than hand-listed, so a model cannot drift between the
 * offline fallback and its real capability entry.
 */
export declare const FALLBACK_MODELS: ReadonlyArray<{
    id: string;
    name: string;
    contextWindow: number;
}>;
//# sourceMappingURL=types.d.ts.map