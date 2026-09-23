/**
 * Static facts about the Zhipu / Z.ai GLM Coding Plan.
 *
 * The GLM Coding Plan is a subscription (智谱 GLM Coding Plan / Z.ai GLM Coding
 * Plan) whose coding models are served by a **separate** OpenAI-compatible
 * surface from the pay-as-you-go open platform. The plan's chat base URL is
 * `/api/coding/paas/v4`, and a general-API key or the general base URL
 * (`/api/paas/v4`) fails here — the two are distinct products that bill
 * different balances.
 *
 * Two deployments exist and are independent: the international one (`api.z.ai`)
 * and the China one (`open.bigmodel.cn`). A key minted in one console is
 * rejected by the other, so the region belongs to the credential.
 *
 * Everything asserted here was checked against Z.ai's published documentation
 * and against the live hosts (see the notes on each constant).
 *
 * @see https://docs.z.ai/devpack/overview
 * @see https://docs.z.ai/guides/llm/glm-5.3
 * @see https://docs.z.ai/api-reference/llm/chat-completion
 */

import type { ZhipuRegion } from '../../shared/zhipu-contracts.ts'

// Use an id distinct from the common `zai` / `zhipu` names a user's own
// OpenAI-compatible route is likely to use. Installing this plugin must not
// hide or overwrite a custom API the user already configured.
export const PROVIDER_ID = 'zhipu-coding-plan'
export const PROVIDER_NAME = 'GLM（智谱 Coding Plan）'

/** International deployment: Z.ai. */
export const INTL_BASE_URL = 'https://api.z.ai'
/** China deployment: 智谱开放平台 (BigModel). */
export const CN_BASE_URL = 'https://open.bigmodel.cn'

/**
 * Hosts that identify the deployment a key belongs to.
 *
 * A pasted key states no region, so it is detected from the console the user
 * names, and an unknown value falls back to the international deployment.
 */
export const REGION_BASE_URLS: Record<ZhipuRegion, string> = {
  intl: INTL_BASE_URL,
  cn: CN_BASE_URL,
}

/** Chat surface of the Coding Plan, appended to a region base URL. */
export const CHAT_PATH = '/api/coding/paas/v4/chat/completions'
/** Model listing on the same Coding Plan surface. */
export const MODELS_PATH = '/api/coding/paas/v4/models'

/**
 * Undocumented monitor endpoints the plan's own usage page reads.
 *
 * They are the only source of the plan's credit windows, and both deployments
 * expose them on the same path. Measured live on both hosts: a request with no
 * credential answers the platform's envelope (`code 1001`, "Authentication
 * parameter not received in Header") and one with a wrong credential answers
 * `code 401`, so the routes exist and are authenticated.
 *
 * The `Authorization` header carries the raw key with **no `Bearer` prefix** on
 * these two — that is the scheme the plan's own page uses, and the documented
 * `Bearer` form belongs to the model API instead.
 */
export const QUOTA_PATH = '/api/monitor/usage/quota/limit'
export const SUBSCRIPTION_PATH = '/api/biz/subscription/list'

/** Timeouts and cache lifetimes. */
export const DISCOVERY_TIMEOUT_MS = 20_000
export const CHAT_TIMEOUT_MS = 300_000
export const QUOTA_CACHE_TTL_MS = 2 * 60 * 1000
export const CATALOG_CACHE_TTL_MS = 30 * 60 * 1000
export const STREAM_IDLE_TIMEOUT_MS = 300_000
export const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

export const DEFAULT_MAX_TOKENS = 32_768
export const DEFAULT_CONTEXT_WINDOW = 128_000

/**
 * Product identity for the `User-Agent`.
 *
 * The base URL and the header vocabulary are the provider's own public
 * contract, so this route identifies itself honestly as this plugin rather than
 * impersonating a client it is not.
 */
export const PLUGIN_USER_AGENT = 'dsh-chatgpt-subscription (+https://github.com/Aa728848/dsh-chatgpt-subscription)'

/**
 * Browser sign-in (ZCode's own "Coding Plan" authorization) endpoints.
 *
 * The Coding Plan is bought on a web console, and the console's own client
 * signs in with the browser rather than asking the user to mint a key by hand:
 * an authorization-code grant against `chat.z.ai`, a JSON token exchange on
 * the ZCode host, and then a business-API sequence that mints a durable
 * `id.secret` key. Only the two `api.z.ai`/console hosts below take part —
 * the resulting key is an ordinary Coding Plan key, so every existing path
 * (verification, the pool, quota) keeps working unchanged.
 *
 * These are first-party endpoints, not a published third-party contract: the
 * client id belongs to ZCode's own web client, so any of them may move without
 * notice. They live here, next to the other provider-host facts, so a change is
 * one reviewed edit — and every one of them can be overridden by an environment
 * variable for a rollback or a private deployment.
 *
 * @see https://zcode.z.ai/cn/docs/configuration
 */
export const ZAI_OAUTH = {
  /** Public client id of ZCode's own web sign-in. */
  clientId: process.env.DSH_ZAI_OAUTH_CLIENT_ID?.trim() || 'client_P8X5CMWmlaRO9gyO-KSqtg',
  /** Authorization page the browser is sent to. */
  authorizeUrl: process.env.DSH_ZAI_OAUTH_AUTHORIZE_URL?.trim() || 'https://chat.z.ai/api/oauth/authorize',
  /** JSON token endpoint that trades the authorization code for a short-lived token. */
  tokenUrl: process.env.DSH_ZAI_OAUTH_TOKEN_URL?.trim() || 'https://zcode.z.ai/api/v1/oauth/token',
  /** Business host the durable key is minted on. */
  bizBase: process.env.DSH_ZAI_BIZ_BASE?.trim() || 'https://api.z.ai',
  /** Business-login endpoint: exchanges the OAuth token for a biz session token. */
  businessLoginUrl: process.env.DSH_ZAI_BUSINESS_LOGIN_URL?.trim() || 'https://api.z.ai/api/auth/z/login',
  /**
   * Name of the key this plugin creates on the account.
   *
   * Distinct from ZCode's own key name so signing in here never rotates or
   * deletes the key the official client provisioned.
   */
  keyName: process.env.DSH_ZAI_OAUTH_KEY_NAME?.trim() || 'dsh-chatgpt-subscription',
} as const

/** Loopback port the browser callback is received on; overridable for a busy host. */
export const ZAI_OAUTH_CALLBACK_PORT = ((): number => {
  const configured = Number(process.env.DSH_ZAI_OAUTH_CALLBACK_PORT)
  return Number.isInteger(configured) && configured > 0 && configured <= 65535 ? configured : 54548
})()

/** Path the console redirects to on the loopback listener. */
export const ZAI_OAUTH_CALLBACK_PATH = '/callback'

/** How long a browser sign-in may stay pending before it is abandoned. */
export const ZAI_OAUTH_TIMEOUT_MS = 5 * 60 * 1000

/** Banner sizes and request timeout for the OAuth calls. */
export const ZAI_OAUTH_REQUEST_TIMEOUT_MS = 30_000

/** Reasoning levels the Coding Plan accepts for its GLM-5.x models. */
export const CODING_EFFORTS = ['low', 'high', 'max'] as const

/**
 * Platform-level business codes this route classifies.
 *
 * Documented in the provider's own error table; the HTTP status stays generic
 * while the body names the real condition, so the body is what the adapter
 * reads. Several entries share a status with an unrelated condition, which is
 * exactly why classification cannot stop at the status line.
 *
 * @see https://docs.z.ai/api-reference/api-code
 */
export const ERROR_CODE = {
  /** 401 — the credential is absent from the header. */
  AUTH_MISSING: 1001,
  /** 401 — token expired or wrong; signing in again is what fixes it. */
  AUTH_INVALID: 1000,
  AUTH_EXPIRED: 1003,
  /** 429 — no balance and no usable resource package. */
  NO_BALANCE: 1113,
  /** 400 — unknown model id. */
  UNKNOWN_MODEL: 1211,
  /** 400 — the model does not serve this call method. */
  WRONG_METHOD: 1212,
  /** 400 — a required parameter was missing. */
  MISSING_PARAM: 1213,
  /** 400 — a parameter value was rejected, e.g. an unsupported reasoning level. */
  INVALID_PARAM: 1214,
  /** 403 — the account's plan does not grant this API. */
  NO_PERMISSION: 1220,
  /** 400 — prompt exceeds the model's window. */
  PROMPT_TOO_LONG: 1261,
  /** 400 — the provider's own content filter refused the input. */
  CONTENT_FILTERED: 1301,
  /** 429 — request-rate limit. */
  RATE_LIMITED: 1302,
  /** 429 — transient service overload. */
  OVERLOADED: 1305,
  /** 429 — a named usage window is spent; the body carries the reset instant. */
  USAGE_LIMIT: 1308,
  /** 429 — the Coding Plan package has lapsed. */
  PLAN_EXPIRED: 1309,
  /** 429 — weekly/monthly allowance spent; the body carries the reset instant. */
  PLAN_LIMIT: 1310,
  /** 429 — the current plan does not include this model. */
  MODEL_NOT_IN_PLAN: 1311,
} as const

/** Whether a free-form region belongs to the China deployment. */
export function regionForBaseUrl(baseUrl: string | undefined): ZhipuRegion {
  const value = (baseUrl ?? '').trim().toLowerCase()
  return value.includes('bigmodel.cn') ? 'cn' : 'intl'
}

/** Chat base URL one region resolves to. */
export function apiBaseForRegion(region: ZhipuRegion): string {
  return REGION_BASE_URLS[region] ?? INTL_BASE_URL
}

/** Normalize a free-form region name onto a supported deployment. */
export function normalizeRegion(value: unknown): ZhipuRegion | undefined {
  if (value === 'cn' || value === 'intl') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'cn' || normalized === 'china' || normalized === 'bigmodel') return 'cn'
    if (normalized === 'intl' || normalized === 'global' || normalized === 'international') return 'intl'
  }
  return undefined
}
