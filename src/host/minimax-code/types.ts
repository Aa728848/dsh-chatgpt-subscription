/**
 * Static facts about the MiniMax Code (编程订阅) provider.
 *
 * Every constant in this file is a measured value, transcribed from the
 * reconnaissance brief at
 * `_archive/minimax-probe_20260928/IMPLEMENTATION-BRIEF.md` (section 2). They are
 * deliberately NOT re-derived from other clients or from convention:
 *
 * - the credential directory is `~/.minimax/auth/<buildEnv>/<region>/mcode-public/`
 *   and holds the same `auth.json` the MiniMax Code desktop app writes;
 * - the OAuth device flow is a public-client RFC 8628 flow with PKCE(S256)
 *   against `account.minimax.cn/oauth2/*`;
 * - the model surface is Anthropic Messages at
 *   `https://agent.minimax.cn/mavis/api/v1/llm/v1/messages`;
 * - that endpoint authenticates with `authorization: Bearer <accessToken>`, NOT
 *   with `x-api-key` (measured: x-api-key answers 401
 *   `{"code":401,"message":"token is required"}`).
 *
 * Two consequences are load-bearing and are asserted where they are used rather
 * than here: credentials are always sent as a bearer token, and the model
 * directory is hardcoded because `GET /v1/models` answers 503
 * `{"errorCode":50115,"errorReason":"direct_route_not_configured"}`.
 */

import { createHash } from 'node:crypto'
import type { MinimaxCodeReasoningEffort, MinimaxCodeRegion } from '../../shared/minimax-code-contracts.ts'
import { MINIMAX_CODE_PROVIDER_ID, MINIMAX_CODE_PROVIDER_NAME } from '../../shared/minimax-code-contracts.ts'

export const PROVIDER_ID = MINIMAX_CODE_PROVIDER_ID
export const PROVIDER_NAME = MINIMAX_CODE_PROVIDER_NAME

/**
 * OAuth client id MiniMax Code registers.
 *
 * A public client with no secret: the id alone identifies the app, which is what
 * RFC 8628 device flows assume.
 */
export const MINIMAX_CODE_CLIENT_ID = 'mcode-public'

/** Scope the subscription token is issued for. */
export const MINIMAX_CODE_SCOPE = 'agent.default'
/** Audience the subscription token is issued for. */
export const MINIMAX_CODE_AUDIENCE = 'agent-backend'

/**
 * Build environment segment of the credential path.
 *
 * `~/.minimax/auth/prod/cn/mcode-public/auth.json` on this machine. It is part of
 * the on-disk layout, so it is a path constant rather than a remote host.
 */
export const MINIMAX_CODE_BUILD_ENV = 'prod'

/** Host set per region. cn is the measured pair; global mirrors it on the .io domain. */
export const REGION_HOSTS: Record<MinimaxCodeRegion, { account: string; agent: string }> = {
  cn: {
    account: 'https://account.minimax.cn',
    agent: 'https://agent.minimax.cn',
  },
  global: {
    account: 'https://account.minimax.io',
    agent: 'https://agent.minimax.io',
  },
}

/**
 * Path of the Token Plan usage endpoint.
 *
 * Found in the official MiniMax CLI rather than in the API docs: `mmx quota show`
 * ("Display Token Plan usage and remaining quotas") reads
 * `GET {baseUrl}/v1/token_plan/remains` with an OAuth credential. MiniMax's own
 * documentation only ever points at the console usage bar, which is presumably
 * why this line concluded no endpoint existed.
 */
export const TOKEN_PLAN_REMAINS_PATH = '/v1/token_plan/remains'

/**
 * Candidate hosts for the usage endpoint, most likely first.
 *
 * The two sources disagree about the China TLD and neither has been measured
 * against THIS subscription: the credential is issued by the `.minimax.cn`
 * account host this line already uses, while the official CLI's REGIONS table
 * puts China on `https://api.minimaxi.com`. The global host is agreed
 * (`api.minimax.io` by both). So the candidates are tried in order and the first
 * that answers is remembered, which keeps the uncertainty in one place rather
 * than hardcoding a guess into every request.
 */
export const QUOTA_HOST_CANDIDATES: Record<MinimaxCodeRegion, readonly string[]> = {
  cn: ['https://api.minimax.cn', 'https://api.minimaxi.com'],
  global: ['https://api.minimax.io'],
}

/**
 * Hosts to try for one region, in order.
 *
 * `DSH_MINIMAX_CODE_QUOTA_HOST` pins a single host for a deployment that has
 * measured the right one (a proxy, or a region whose host is not listed here).
 */
export function quotaHostCandidates(region: MinimaxCodeRegion): string[] {
  const override = (process.env.DSH_MINIMAX_CODE_QUOTA_HOST || '').trim()
  if (override !== '') return [override.replace(/\/+$/, '')]
  return [...QUOTA_HOST_CANDIDATES[region]]
}

/** Fully qualified usage URL for one host. */
export function tokenPlanRemainsUrl(host: string): string {
  return host.replace(/\/+$/, '') + TOKEN_PLAN_REMAINS_PATH
}

/** Device authorization endpoint (RFC 8628 section 3.1). */
export const DEVICE_CODE_PATH = '/oauth2/device/code'
/** Token endpoint, shared by the device-code grant and the refresh grant. */
export const OAUTH_TOKEN_PATH = '/oauth2/token'
/** Revocation endpoint. */
export const OAUTH_REVOKE_PATH = '/oauth2/revoke'

/** Grant type the device-code polling request declares. */
export const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'
/** PKCE method the device authorization declares. */
export const PKCE_CHALLENGE_METHOD = 'S256'

/**
 * Managed agent API prefix.
 *
 * The Messages endpoint is `<agentBase><prefix>/messages`; the prefix already
 * carries its own `/v1`, which is why the documented base URL is quoted as
 * ".../llm/v1" and never has a further `/v1` appended.
 */
export const AGENT_LLM_PREFIX = '/mavis/api/v1/llm/v1'
/** Path suffix of the Anthropic Messages endpoint. */
export const MESSAGES_PATH = '/messages'
/** Anthropic protocol revision the endpoint documents. */
export const ANTHROPIC_VERSION = '2023-06-01'

/**
 * Product token this plugin reports.
 *
 * MiniMax Code's own telemetry headers are deliberately NOT forged: this is a
 * third-party client of the subscription, and claiming to be the official app is
 * both dishonest and, per the app's own terms, grounds for suspending the
 * subscription.
 */
export const USER_AGENT =
  'dsh-chatgpt-subscription (+https://github.com/Aa728848/dsh-chatgpt-subscription)'

/**
 * How long before expiry a token is replaced.
 *
 * The access token lives about 24 hours, and MiniMax Code refreshes the same file
 * this plugin reads, so the policy is "read-only first": a token that is still
 * comfortably valid is used exactly as stored. The margin exists only so a
 * request cannot start with a token that expires while it is in flight — it is
 * deliberately far below the token's own lifetime so the plugin does not race the
 * desktop app for a rotation it does not need.
 */
export const REFRESH_MARGIN_MS = 60_000

/** Attempts one refresh gets before the stored credential is called dead. */
export const REFRESH_MAX_RETRIES = 3
/** Exponential backoff base for a retryable refresh failure. */
export const REFRESH_BACKOFF_BASE_MS = 1_000
/**
 * HTTP statuses a refresh treats as transient.
 *
 * A 429 or any 5xx says nothing about the refresh token itself, so the same token
 * is worth retrying. A 400/401/403 is a verdict that the grant is dead.
 */
export const RETRYABLE_REFRESH_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504])

/** Device-flow polling defaults when the service omits them. */
export const DEFAULT_DEVICE_INTERVAL_SECONDS = 5
export const DEFAULT_DEVICE_EXPIRES_SECONDS = 600
/** Local timeout for every OAuth call. */
export const OAUTH_TIMEOUT_MS = 30_000
/** Lifetime of one in-process login session before the card must start over. */
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000

export const STREAM_IDLE_TIMEOUT_MS = 300_000
export const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

/** Headroom kept below a model's context window when sizing a request. */
export const CONTEXT_HEADROOM_TOKENS = 4_096
/** Output cap used when a model declares none. */
export const DEFAULT_MAX_TOKENS = 32_768
/** Context window used when a model declares none. */
export const DEFAULT_CONTEXT_WINDOW = 512_000

/** The account (OAuth) host for one region. */
export function accountHost(region: MinimaxCodeRegion): string {
  const override = (process.env.DSH_MINIMAX_CODE_ACCOUNT_HOST || '').trim()
  if (override !== '') return override.replace(/\/+$/, '')
  return REGION_HOSTS[region].account
}

/**
 * The agent API base URL for one region, without a trailing slash.
 *
 * An override that already carries the prefix is accepted as written, so a
 * deployment that proxies the endpoint can point at the proxy root instead.
 */
export function agentBaseUrl(region: MinimaxCodeRegion): string {
  const override = (process.env.DSH_MINIMAX_CODE_BASE_URL || '').trim()
  const base = override !== '' ? override : REGION_HOSTS[region].agent
  return base.replace(/\/+$/, '')
}

/** Fully qualified Anthropic Messages URL for one region. */
export function messagesUrl(region: MinimaxCodeRegion): string {
  return agentBaseUrl(region) + AGENT_LLM_PREFIX + MESSAGES_PATH
}

/** Fully qualified OAuth endpoint URL for one region. */
export function oauthUrl(region: MinimaxCodeRegion, path: string): string {
  return accountHost(region) + path
}

/** Whether one value is a region this route understands. */
export function isRegion(value: unknown): value is MinimaxCodeRegion {
  return value === 'cn' || value === 'global'
}

/** Reasoning levels the whole route understands, for route-level validation. */
export function isMinimaxCodeReasoningEffort(value: unknown): value is MinimaxCodeReasoningEffort {
  return value === 'default'
    || value === 'low'
    || value === 'medium'
    || value === 'high'
    || value === 'xhigh'
    || value === 'max'
}

/**
 * Render a token for a log line or an error message without disclosing it.
 *
 * A real credential must never reach a log, a settings response, or a rendered
 * error, so nothing derived from the token's *content* is emitted here. An earlier
 * revision printed the first six characters plus the length "to tell two tokens
 * apart"; that is still a disclosure of the credential — six characters of a
 * bearer token is material an attacker can use, and these strings are rendered in
 * the settings card and written to the host log. The fingerprint below is instead
 * a truncated SHA-256 over the token, which distinguishes two credentials and
 * pins which one was rejected (the diagnostic purpose) while being unusable as a
 * credential prefix.
 */
export function redactToken(token: string | undefined | null): string {
  if (token === undefined || token === null || token === '') return '<none>'
  const fingerprint = createHash('sha256').update(token).digest('hex').slice(0, 12)
  return 'sha256:' + fingerprint + '/len:' + token.length
}
