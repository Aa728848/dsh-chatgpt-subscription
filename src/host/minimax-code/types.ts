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
 * Path of the Token Plan usage endpoint for THIS kind of credential.
 *
 * TWO DIFFERENT ENDPOINTS EXIST, and the first one tried here was the wrong one:
 *
 * - `/v1/token_plan/remains` on the API hosts is the PLATFORM route. It takes a
 *   platform API key (or the platform OAuth the `mmx` CLI holds), and it answers
 *   an `mcode-public` sign-in with HTTP 200 + `base_resp.status_code: 1004`
 *   ("Please carry the API secret key") under every auth shape.
 * - `/v1/api/openplatform/coding_plan/remains` is what the OFFICIAL MiniMax Code
 *   client uses for exactly this credential
 *   (`packages/tui/src/account/matrix-account-client.ts`, which reads it as the
 *   Token Plan quota). It is served by the API hosts — see
 *   {@link QUOTA_HOST_CANDIDATES} for the measured origin — not by the agent hosts
 *   this line posts Messages to.
 *
 * So the path below is the second one. See the note on
 * {@link QUOTA_CLIENT_ATTRIBUTION} for the one caveat that comes with it.
 */
export const TOKEN_PLAN_REMAINS_PATH = '/v1/api/openplatform/coding_plan/remains'

/**
 * Candidate hosts for the usage endpoint, most likely first.
 *
 * MEASURED, not inferred. The path below (`/v1/api/openplatform/coding_plan/remains`)
 * lives on the API hosts, and this list previously carried the AGENT hosts because
 * the Messages endpoint they serve is the one this line already talks to. That was
 * the wrong surface for usage: an earlier revision measured only what a 404 "looked
 * like" and not where the path actually serves, so both `agent.*` origins answered
 * `404 page not found` for it — and, on the two of them that answer the request at
 * all, an HTML chat-shell page rather than JSON. Either way no usable document was
 * produced, every candidate was exhausted, and the card degraded to "the usage
 * endpoint did not answer".
 *
 * The correct hosts, probed directly with a live `mcode-public` cn credential:
 * `api.minimax.cn` answers HTTP 200 with `base_resp.status_code: 0` and the full
 * `model_remains` document. The global pairing mirrors the region split already
 * used above (cn vs io); `api.minimax.io` is NOT one of them — measured, it
 * answers this path with HTTP 401 even for a credential its cn sibling accepts, so
 * listing it would spend a probe to learn nothing. `api.minimaxi.com` is kept as
 * the measured fallback because it serves the same document.
 *
 * The winner is still remembered, which keeps any remaining uncertainty in one
 * place instead of spreading a guess through every request.
 */
export const QUOTA_HOST_CANDIDATES: Record<MinimaxCodeRegion, readonly string[]> = {
  cn: ['https://api.minimax.cn', 'https://api.minimaxi.com'],
  global: ['https://api.minimax.io'],
}

/**
 * Whether this line may send the official client's attribution headers.
 *
 * The official client sends `yy` / `x-timestamp` / `x-signature` on this request.
 * Its own comment calls them what they are: literals that "tag a request as coming
 * from a first-party MiniMax client". MiniMax's code also says they are "not
 * credentials or a security boundary" (authorization is the bearer token), but
 * tagging a request as first-party is precisely what this package's
 * `types.ts` product-token note refuses to do — and the same note records that
 * claiming to be the official app is grounds for suspension.
 *
 * So the default is NO: the read goes out honestly, and if the service insists on
 * the tag the result is a refusal the card reports rather than a forged identity.
 * `DSH_MINIMAX_CODE_QUOTA_ATTRIBUTION=1` opts in for a user who has read that
 * trade and wants the numbers anyway.
 */
export const QUOTA_CLIENT_ATTRIBUTION = false

/** Whether the caller opted in to sending the first-party attribution headers. */
export function quotaAttributionEnabled(): boolean {
  return (process.env.DSH_MINIMAX_CODE_QUOTA_ATTRIBUTION || '').trim() === '1'
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
 * Byte ceiling the guard enforces on one request body.
 *
 * WHY THIS IS NOT KIMI'S 2 MB FIGURE
 *
 * This line used to import `MAX_MESSAGE_BODY_BYTES` (2,097,152) from the Kimi
 * Code mapper and enforce it here on the stated grounds that "both lines face
 * the same family of endpoint". That reasoning does not hold, and the cost was
 * a hard local refusal on conversations the service would have accepted:
 *
 * - 2,097,152 with the message `total message size N exceeds limit 2097152` is
 *   KIMI CODE's own documented limit, quoted verbatim in its error reference.
 *   It is Kimi's gateway. No MiniMax document states it, and MiniMax's
 *   Anthropic-compatible page documents its request ceiling in tens of MB, not
 *   in 2 MB.
 * - MiniMax's catalog — the source this line transcribes its own numbers from —
 *   gives the flagship M3 a 512K context window (1M optional) and M3.1 Flash
 *   Preview 1M, and the model table bounds a single image at 10 MB. A 2 MB
 *   total-body ceiling cannot coexist with a 10 MB single-image bound: one
 *   legitimate image would trip the guard on its own.
 *
 * So the old number was not this route's limit. What is enforced here now is
 * a transport ceiling for a route that declares no documented byte limit, set
 * at MiniMax's own documented request-body figure for media-carrying requests
 * (64 MB). Two properties make that safe:
 *
 * - it is high enough that no legitimate conversation is refused locally, so
 *   the guard can no longer be the reason a turn fails; and
 * - it is still a real bound, so a runaway request (a loop appending a
 *   multi-megabyte tool result every iteration) is stopped before the
 *   connection is spent, and is reported with the same actionable remedy.
 *
 * `DSH_MINIMAX_CODE_MAX_BODY_BYTES` pins a different ceiling for a deployment
 * that has measured one (a proxy or gateway in front of the route). It is
 * parsed as bytes and ignored when it is not a positive finite integer, so a
 * typo cannot silently disable the guard.
 */
export const DEFAULT_MAX_MESSAGE_BODY_BYTES = 64 * 1024 * 1024

/** Ceiling this process enforces, honouring the deployment override. */
export function maxMessageBodyBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.DSH_MINIMAX_CODE_MAX_BODY_BYTES ?? '').trim()
  if (raw === '') return DEFAULT_MAX_MESSAGE_BODY_BYTES
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_MESSAGE_BODY_BYTES
  return Math.floor(parsed)
}

/**
 * Base64 image payload one request on this route may carry.
 *
 * The SECOND borrowed number, and the same mistake as the body ceiling above.
 * This line called Kimi's `offloadOldestRequestImages`, whose budget is Kimi's
 * 1,500,000 — a figure sized to sit inside Kimi's own 2 MB text/image request
 * limit. Over here it silently deleted images MiniMax accepts:
 *
 * - MiniMax's model table bounds a single image at 10 MB of RAW bytes, about
 *   13.3 MB once base64-encoded. Against 1.5 MB that is roughly 9x over, so ONE
 *   ordinary screenshot was replaced by a text placeholder.
 * - Nothing said so. The offload is a silent substitution, so the model answered
 *   from a conversation where the picture simply was not, with no counter and no
 *   warning pointing at the cause. That is worse than a refusal: a refusal tells
 *   the user what went wrong.
 *
 * Derived from this route's own numbers instead of inherited: it holds the 10 MB
 * raw per-image ceiling with headroom for a second image, and stays well inside
 * the 64 MB request ceiling above, so legitimate images survive and only a
 * runaway multi-image request is trimmed.
 */
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 16 * 1024 * 1024

/** Image budget this process enforces, honouring the deployment override. */
export function maxRequestImageBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.DSH_MINIMAX_CODE_MAX_IMAGE_BYTES ?? '').trim()
  if (raw === '') return DEFAULT_MAX_REQUEST_IMAGE_BYTES
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_REQUEST_IMAGE_BYTES
  return Math.floor(parsed)
}

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
 * The measured MiniMax Code access token lives ONE HOUR, not the day an earlier
 * note assumed, and the desktop app refreshes the same file this plugin reads, so
 * the policy is "read-only first": a token that is still comfortably valid is used
 * exactly as stored. The margin exists only so a request cannot start with a token
 * that expires while it is in flight — it is deliberately far below the token's
 * own lifetime so the plugin does not race the desktop app for a rotation it does
 * not need.
 */
export const REFRESH_MARGIN_MS = 60_000

/**
 * How long before expiry this plugin renews the credential ON ITS OWN schedule.
 *
 * This is the constant that removes the every-hour sign-out. The access token
 * lives one hour, so a reader that only acts once the token is already inside
 * {@link REFRESH_MARGIN_MS} of expiry presents a bearer the service has already
 * stopped accepting: every hour the line dips through 401 → refresh → retry, and
 * a burst of tool calls at that boundary has two callers spend the same rotating
 * refresh token. Renewing a few minutes early moves the rotation off the boundary
 * and onto a schedule this plugin controls.
 *
 * It must stay far away from the token's lifetime for the opposite reason: a
 * margin near the lifetime would rotate on every single read and race the desktop
 * app for a rotation neither side needs. Five minutes of a sixty-minute token is
 * the balance — the rotation happens once, well before the token can be refused.
 */
export const PRE_EXPIRY_REFRESH_MS = 5 * 60_000

/** Failures cheap enough to retry under {@link PRE_EXPIRY_REFRESH_MS}. */
export const PRE_EXPIRY_REFRESH_MAX_ATTEMPTS = 2

/**
 * How long a rotation stays "recent" for other readers of the same credential.
 *
 * A refresh token rotates: the moment one holder spends it, every other holder is
 * left with a token the service has already invalidated. This window is the answer
 * — a caller that observes the credential rotating right now waits for the winner
 * to write its result back and adopts that result instead of spending a token that
 * is already gone. It is a local patience bound, not a lock: no file is created,
 * and the desktop app's own `auth.lock` is never touched.
 */
export const CREDENTIAL_ROTATION_WAIT_MS = 15_000

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

/**
 * Adapter-selected auth owner (nonsecret hash).
 *
 * Scoped to the specific account and credential token/key selected by the adapter.
 * Any account change or token/key replacement produces a different hash,
 * preventing thinking/signature replay across different authentication boundaries.
 */
export function computeMinimaxAuthOwner(
  credentials?: { accessToken?: string; apiKey?: string; region?: string } | null,
  accountId?: string | null,
): string {
  const token = (credentials?.apiKey || credentials?.accessToken || '').trim()
  if (!token) return ''
  const hash = createHash('sha256')
  if (accountId && accountId.trim() !== '') hash.update(`acc:${accountId}\0`)
  if (credentials?.region && credentials.region.trim() !== '') hash.update(`reg:${credentials.region}\0`)
  hash.update(`tok:${token}`)
  return hash.digest('hex').slice(0, 32)
}
