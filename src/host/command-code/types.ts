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

import type { CommandCodeApiEnv, CommandCodeWire } from '../../shared/command-code-contracts.ts'
import { commandCodeModelDef, COMMAND_CODE_MODELS } from './model-catalog.ts'

export const PROVIDER_ID = 'command-code'
export const PROVIDER_NAME = 'Command Code'

/** Browser sign-in page the CLI opens; it redirects back to our loopback server. */
export const STUDIO_PATH = '/studio/auth/cli'
/** Query parameter that carries the loopback callback URL to the studio page. */
export const STUDIO_CALLBACK_PARAM = 'callback'
/** Studio client marker; mirrors the value the official CLI sends. */
export const STUDIO_CLIENT = 'cli'

export const API_ENDPOINTS: Record<CommandCodeApiEnv, string> = {
  prod: 'https://api.commandcode.ai',
  staging: 'https://staging-api.commandcode.ai',
  local: 'http://localhost:9090',
}

export const STUDIO_ENDPOINTS: Record<CommandCodeApiEnv, string> = {
  prod: 'https://commandcode.ai',
  staging: 'https://staging.commandcode.ai',
  local: 'http://localhost:9090',
}

/** Provider API prefix; add `/chat/completions`, `/messages`, or `/models`. */
export const PROVIDER_API_PREFIX = '/provider/v1'

/** Account identity the CLI reads before doing anything authenticated. */
export const WHOAMI_PATH = '/alpha/whoami'
/** Credit balance for the signed-in account. */
export const BILLING_CREDITS_PATH = '/alpha/billing/credits'
/** Plan / subscription facts for the signed-in account. */
export const BILLING_SUBSCRIPTIONS_PATH = '/alpha/billing/subscriptions'
/** Rolling usage accounting for the signed-in account. */
export const USAGE_SUMMARY_PATH = '/alpha/usage/summary'

/** First loopback port tried for the browser callback; matches the official CLI. */
export const DEFAULT_CALLBACK_PORT = 5959
/** Consecutive ports probed when the default is taken; matches the official CLI. */
export const CALLBACK_PORT_ATTEMPTS = 10
export const CALLBACK_PATH = '/callback'
/** Page the studio's browser tab lands on after a successful POST; CLI-compatible. */
export const CALLBACK_COMPLETE_PATH = '/callback/complete'
/** How long a landed credential waits for the browser tab before login resolves. */
export const CALLBACK_LANDING_GRACE_MS = 10_000
/** Body cap the official callback server enforces. */
export const CALLBACK_MAX_BYTES = 10_000
/** Origins the studio signs in from; echoed back for the browser's CORS check. */
export const CALLBACK_ALLOWED_ORIGINS = [
  'https://commandcode.ai',
  'https://staging.commandcode.ai',
  'http://localhost:3000',
] as const
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
export const DISCOVERY_TIMEOUT_MS = 15_000
export const QUOTA_CACHE_TTL_MS = 2 * 60 * 1000
export const CATALOG_CACHE_TTL_MS = 30 * 60 * 1000

export const DEFAULT_MAX_TOKENS = 32_768
export const DEFAULT_CONTEXT_WINDOW = 128_000

export const STREAM_IDLE_TIMEOUT_MS = 300_000
export const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

/**
 * Product identity for the provider API's `User-Agent`.
 *
 * The alpha routes are identified as the CLI (they are the CLI's own API); the
 * provider routes are ordinary model calls, so they carry this plugin's
 * attribution instead of impersonating a client it is not.
 */
export const PLUGIN_USER_AGENT = 'dsh-chatgpt-subscription (+https://github.com/Aa728848/dsh-chatgpt-subscription)'

/** User-Agent the official CLI sends; the alpha API is friendlier to a known client. */
export const CLI_USER_AGENT = 'command-code-cli'

/** Headers the alpha API accepts, mirroring the official CLI's vocabulary. */
export const HEADER_API_KEY = 'authorization'
export const HEADER_CLI_VERSION = 'x-command-code-cli-version'
export const HEADER_CLI_ENVIRONMENT = 'x-command-code-cli-environment'
export const HEADER_PROJECT_SLUG = 'x-command-code-project-slug'
export const HEADER_TASTE_LEARNING = 'x-command-code-taste-learning'
export const HEADER_SESSION_ID = 'x-command-code-session-id'
export const HEADER_OSS_PRIMARY_PROVIDER = 'x-command-code-oss-primary-provider'

export function resolveApiEnv(raw = process.env.DSH_COMMAND_CODE_ENV): CommandCodeApiEnv {
  const value = (raw || '').trim().toLowerCase()
  return value === 'staging' || value === 'local' ? value : 'prod'
}

export function apiBaseUrl(env: CommandCodeApiEnv = resolveApiEnv()): string {
  return process.env.DSH_COMMAND_CODE_ENDPOINT?.trim().replace(/\/+$/, '') || API_ENDPOINTS[env]
}

export function studioBaseUrl(env: CommandCodeApiEnv = resolveApiEnv()): string {
  return STUDIO_ENDPOINTS[env]
}

export function providerUrl(env: CommandCodeApiEnv = resolveApiEnv()): string {
  return `${apiBaseUrl(env)}${PROVIDER_API_PREFIX}`
}

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
export function wireForModel(modelId: string): CommandCodeWire {
  return /^claude[-/]/i.test(modelId.trim()) ? 'anthropic' : 'openai'
}

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
export function reasoningEffortsFor(modelId: string): string[] {
  return [...(commandCodeModelDef(modelId)?.reasoningEfforts ?? [])]
}

/**
 * Accepted request modalities for one model.
 *
 * An unknown model falls back to text-only: DSH turns a false "no images" into
 * a visible placeholder the user can correct by switching models, while a false
 * "images accepted" sends bytes to an endpoint that rejects the whole request.
 */
export function inputModalitiesFor(modelId: string): Array<'text' | 'image'> {
  return [...(commandCodeModelDef(modelId)?.inputModalities ?? ['text'])]
}

/**
 * Thinking-token budget one Anthropic-route reasoning level asks for.
 *
 * The registry's two extra levels are covered too: `xhigh` sits between `high`
 * and `max` (it is the level Claude Opus 5 / Fable 5 and Muse Spark 1.3 expose
 * above `high`), and `minimal` is the cheapest supported budget.
 */
export function anthropicThinkingBudget(effort: string): number | null {
  switch (effort) {
    case 'minimal': return 1_024
    case 'low': return 2_048
    case 'medium': return 8_192
    case 'high': return 16_384
    case 'xhigh': return 24_576
    case 'max': return 32_768
    default: return null
  }
}

/**
 * Output caps for the models whose registry entry does not declare one.
 *
 * The registry only carries a cap for five entries, and omitting the field
 * would leave every request at {@link DEFAULT_MAX_TOKENS} — far below what the
 * Claude and GPT families actually allow. These values are the consistent
 * per-model `limit.output` across the independent providers that serve the same
 * weights; a cap the registry DOES declare always wins over them.
 */
const OBSERVED_MAX_OUTPUT_TOKENS: Record<string, number> = {
  'claude-opus-5': 128_000,
  'claude-opus-4-8': 128_000,
  'claude-opus-4-7': 128_000,
  'claude-sonnet-5': 128_000,
  'claude-sonnet-4-6': 64_000,
  'claude-fable-5-1': 128_000,
  'claude-fable-5': 128_000,
  'claude-haiku-4-5-20251001': 64_000,
  'gpt-6-astra': 128_000,
  'gpt-5.6-sol': 128_000,
  'gpt-5.6-terra': 128_000,
  'gpt-5.6-luna': 128_000,
  'gpt-5.5': 128_000,
  'gpt-5.4': 128_000,
  'gpt-5.3-codex': 128_000,
  'gpt-5.4-mini': 128_000,
  'deepseek/deepseek-v4-pro': 384_000,
  'deepseek/deepseek-v4-flash': 384_000,
  'deepseek/deepseek-v4-flash-vision-exp': 384_000,
  'deepseek/deepseek-v4.1-flash': 384_000,
  'moonshotai/Kimi-K3': 131_072,
  'moonshotai/Kimi-K2.6': 262_144,
  'z-ai/glm-5.3-flash': 131_072,
  'zai-org/GLM-5.3': 131_072,
  'zai-org/GLM-5.2': 131_072,
  'MiniMaxAI/MiniMax-M3': 512_000,
  'minimax/minimax-m3-free': 512_000,
  'Qwen/Qwen3.8-Max': 131_072,
  'Qwen/Qwen3.8-Max-0902': 131_072,
  'xai/grok-4.5': 500_000,
  'xai/grok-4.6': 500_000,
}

/**
 * Output cap one request asks for when the caller omits one. A cap the registry
 * declares wins over the observed value, which in turn wins over the default.
 */
export function maxOutputTokensFor(modelId: string): number {
  return commandCodeModelDef(modelId)?.maxTokens
    ?? OBSERVED_MAX_OUTPUT_TOKENS[modelId]
    ?? DEFAULT_MAX_TOKENS
}

/**
 * Context windows used before the live catalog has ever been fetched.
 *
 * The public `/provider/v1/models` endpoint reports `context_length` for every
 * model and is the authority once reachable; these values only keep the model
 * picker usable on a machine that cannot reach the catalog yet. They are drawn
 * from the registry rather than hand-listed, so a model cannot drift between the
 * offline fallback and its real capability entry.
 */
export const FALLBACK_MODELS: ReadonlyArray<{ id: string; name: string; contextWindow: number }> =
  COMMAND_CODE_MODELS
    .filter((model) => model.contextWindow !== null)
    .map((model) => ({ id: model.id, name: model.name, contextWindow: model.contextWindow as number }))
