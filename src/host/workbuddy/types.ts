/**
 * Static facts about the WorkBuddy / CodeBuddy subscription backend.
 *
 * WorkBuddy is Tencent's CodeBuddy IDE subscription. Its model backend is a
 * plain OpenAI-compatible `/chat/completions` endpoint that the official IDE
 * calls directly; this plugin speaks the same wire instead of going through a
 * converter process.
 *
 * Everything asserted here was measured against a live subscription (see the
 * comments on each constant); the surprising constraints are that the endpoint
 * is **stream-only** and that the international region requires the first
 * message to be a system prompt.
 */

import type { WorkBuddyRegion } from '../../shared/workbuddy-contracts.ts'

// Use an id distinct from the common `workbuddy` name used by user-defined
// OpenAI-compatible routes. Installing this plugin must not hide a custom API.
export const PROVIDER_ID = 'workbuddy-subscription'
export const PROVIDER_NAME = 'WorkBuddy（CodeBuddy 订阅）'

/** Domestic backend. */
export const CN_BACKEND = 'https://copilot.tencent.com'

/**
 * Domains whose accounts live on a region-specific backend.
 *
 * A credential's `auth.domain` decides both the backend host and the region:
 * `*.workbuddy.ai` / `*.codebuddy.ai` are international, anything else is the
 * domestic `copilot.tencent.com` deployment.
 */
export const INTL_DOMAIN_SUFFIXES = ['.workbuddy.ai', '.codebuddy.ai'] as const

/** Default auth domain when a credential does not record one. */
export const DEFAULT_DOMAIN = 'www.codebuddy.cn'

/** Chat surface, appended to a region backend. */
export const CHAT_PATH = '/v2/chat/completions'
/**
 * Gateway configuration/catalog surface.
 *
 * This is where the real model list lives: the chat host answers 404 to
 * `/v1/models`, but `/v3/config` returns every model with its context window,
 * output cap, image support, and accepted reasoning ladder. The official CLI
 * reads it at startup.
 */
export const CONFIG_PATH = '/v3/config'
/** Token refresh surface; the official IDE posts the refresh token here. */
export const REFRESH_PATH = '/v2/plugin/auth/token/refresh'
/** Billing/allowance surface; answers the per-package credit picture. */
export const BILLING_PATH = '/billing/meter/get-user-resource'
/** Browser authorization state and credential-poll surfaces used by the CLI. */
export const LOGIN_STATE_PATH = '/v2/plugin/auth/state'
export const LOGIN_TOKEN_PATH = '/v2/plugin/auth/token'
export const LOGIN_PLATFORM = 'cli'
export const LOGIN_PENDING_CODE = 11217
export const LOGIN_POLL_INTERVAL_MS = 1_500
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

/**
 * User-Agent every request carries.
 *
 * Measured: `CodeBuddyIDE` is accepted by the chat endpoint but rejected by
 * `/v3/config` with 400 `code 12403` ("check ua, get coding copilot version
 * error"), and the international chat endpoint answers 401 to it outright. The
 * CLI identity is accepted by all three surfaces on both regions, so it is the
 * single identity this route uses rather than switching per endpoint.
 */
export const CLIENT_USER_AGENT = 'CLI/2.63.2 CodeBuddy/2.63.2'

/** Client identity headers the gateway gates on. */
export const HEADER_USER_ID = 'x-user-id'
export const HEADER_ENTERPRISE_ID = 'x-enterprise-id'
export const HEADER_TENANT_ID = 'x-tenant-id'
export const HEADER_DOMAIN = 'x-domain'
export const HEADER_PRODUCT = 'x-product'
export const HEADER_IDE_NAME = 'x-ide-name'
export const HEADER_REQUESTED_WITH = 'x-requested-with'
export const CLIENT_PRODUCT = 'SaaS'

/** Refresh-token header the token endpoint reads. */
export const HEADER_REFRESH_TOKEN = 'x-refresh-token'
/** Refresh origin marker; `workbuddy` for the .ai domains, `plugin` otherwise. */
export const HEADER_REFRESH_SOURCE = 'x-auth-refresh-source'

/** Timeouts and cache lifetimes. */
export const DISCOVERY_TIMEOUT_MS = 20_000
export const CHAT_TIMEOUT_MS = 300_000
export const QUOTA_CACHE_TTL_MS = 2 * 60 * 1000
export const STREAM_IDLE_TIMEOUT_MS = 300_000
export const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

export const DEFAULT_MAX_TOKENS = 32_768
export const DEFAULT_CONTEXT_WINDOW = 128_000

/**
 * Output cap for the models the catalog does not pin individually.
 *
 * The subscription models are served by several upstream vendors whose own
 * published caps differ; this is the conservative ceiling the request builder
 * uses when nothing more specific is known.
 */
export const FALLBACK_MAX_TOKENS = 32_768

/** Subscription backend error codes, all measured. */
export const ERROR_CODE = {
  /** Request parameters rejected (bad image payload, unsupported field). */
  BAD_REQUEST: 11101,
  /** Model not served in this region — a wrong-region request. */
  MODEL_UNAVAILABLE: 11102,
  /** Message history violates the required shape (missing leading system prompt). */
  SECURITY_BLOCKED: 11128,
  /** Provider rejected the parameters, e.g. an unsupported image for that model. */
  PROVIDER_REJECTED: 11133,
  /** Upstream vendor error. */
  UPSTREAM_ERROR: 11134,
  /** Image could not be decoded or is not an accepted format. */
  INVALID_IMAGE: 11135,
  /** Unsupported reasoning effort value. */
  INVALID_REASONING: 11150,
  /** Usage exceeds the frequency limit; the message carries the reset instant. */
  RATE_LIMITED: 6004,
  /** Generic usage-limit signal seen alongside 429s. */
  USAGE_LIMIT: 14003,
} as const

/** Whether an auth domain belongs to the international deployment. */
export function isIntlDomain(domain: string): boolean {
  const value = domain.trim().toLowerCase()
  return value !== '' && INTL_DOMAIN_SUFFIXES.some((suffix) => value.endsWith(suffix))
}

/** Region one credential belongs to, decided by its auth domain. */
export function regionForDomain(domain: string): WorkBuddyRegion {
  return isIntlDomain(domain) ? 'intl' : 'cn'
}

/**
 * Backend base URL for an auth domain.
 *
 * International accounts are served from the same apex as their auth domain
 * (`www.workbuddy.ai`, `www.codebuddy.ai`); everything else uses the domestic
 * gateway.
 */
export function backendForDomain(domain: string): string {
  const value = domain.trim().toLowerCase()
  if (!isIntlDomain(value)) return CN_BACKEND
  const apex = value.split('.').slice(-2).join('.')
  return `https://www.${apex}`
}

/** Refresh-source marker the token endpoint expects for one domain. */
export function refreshSourceForDomain(domain: string): string {
  return domain.trim().toLowerCase().endsWith('.workbuddy.ai') ? 'workbuddy' : 'plugin'
}

/** `www.workbuddy.ai` / `www.codebuddy.ai` origin used for CORS headers. */
export function originForDomain(domain: string): string {
  return backendForDomain(domain)
}
