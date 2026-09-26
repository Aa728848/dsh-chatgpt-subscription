/**
 * Static facts about Anthropic's Claude subscription surface.
 *
 * The subscription (Claude Pro/Max, the credential Claude Code uses) is a
 * distinct product from the pay-as-you-go Console API. It is served by the same
 * host — https://api.anthropic.com — but a subscription credential is a Bearer
 * **OAuth access token**, not an `x-api-key`, and the subscription routes are
 * gated behind betas the API-key line never sends.
 *
 * Every constant below was read out of a locally installed reference
 * implementation, not recalled: the Anthropic wire layer and OAuth module of
 * `@earendil-works/pi-ai` (dist/api/anthropic-messages.js,
 * dist/auth/oauth/anthropic.js) and its `data/anthropic.json` model snapshot.
 * Each constant names the source that establishes it, so a later reviewer can
 * re-check the claim instead of trusting this file.
 *
 * The one fact this module cannot assert is which models the *server* will
 * serve, or at what entitlement: that answer is the server's own
 * GET /v1/models plus the account's plan, and the sibling model table says so
 * at length.
 */

/** Provider id registered with DSH. */
export const PROVIDER_ID = 'claude-subscription'
/** Display name for the settings surface and the model picker. */
export const PROVIDER_NAME = 'Claude（订阅）'

/** Host serving both the Messages API and the subscription's own OAuth routes. */
export const API_BASE = 'https://api.anthropic.com'

/**
 * Path the Messages API is posted to.
 *
 * The `?beta=true` query is part of the subscription contract rather than a
 * cache buster: it is the beta route, not an alias of the plain one, so dropping
 * it changes which endpoint answers rather than how the same endpoint is cached.
 */
export const MESSAGES_PATH = '/v1/messages?beta=true'
/** Model listing. The authority on what this account can actually call. */
export const MODELS_PATH = '/v1/models'
/** Subscription usage meters (the 5-hour and 7-day windows). */
export const USAGE_PATH = '/api/oauth/usage'

/**
 * Browser authorization endpoint of the subscription flow.
 *
 * This is the claude.ai property, which is what makes the resulting token a
 * subscription credential. The Console's own authorization host mints
 * API-key-scoped grants instead and is deliberately not used here.
 *
 * Overridable: see {@link oauthAuthorizeUrl}.
 */
export const OAUTH_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
/** Token endpoint for both the authorization-code grant and refresh. */
export const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'

/**
 * Redirect URI for the manual paste flow.
 *
 * The loopback flow ({@link loopbackRedirectUri}) is the primary one, but the
 * authorization host only accepts a redirect URI the client is registered for.
 * When no browser on this machine can complete the callback — a headless box, a
 * remote shell, a browser in another profile — the user opens the authorize URL,
 * lets the page fail to load, and pastes the resulting code back. Recognising
 * this URI is what lets the flow tell the two apart.
 */
export const OAUTH_MANUAL_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback'

/**
 * Public OAuth client id of the subscription flow.
 *
 * A public client id is not a secret — it identifies the client, and PKCE is
 * what actually protects the exchange. It is still a fixed upstream fact: the
 * authorization host rejects an unknown client id before any user is asked to
 * authorize anything.
 */
export const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

/**
 * Scopes the subscription flow requests, space-separated as the endpoint wants.
 *
 * `user:inference` is the one that makes the token usable against
 * /v1/messages; `user:profile` is what the usage endpoint answers against.
 * A narrower set yields a token that authenticates but is refused on the routes
 * this provider exists to serve, so the full set is requested.
 */
export const OAUTH_SCOPES = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'

/**
 * Required on any request authenticated with a subscription OAuth token.
 *
 * The `anthropic-beta` header is cumulative: one request carries every marker
 * that applies, and the values below are the wire tokens, not capability names.
 */
export const OAUTH_BETA = 'oauth-2025-04-20'
/** Identity beta pairing with the Claude Code system prompt and version headers. */
export const CLAUDE_CODE_BETA = 'claude-code-20250219'
/** Lets thinking blocks interleave with tool use across a multi-turn loop. */
export const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14'

/** Anthropic protocol revision sent as `anthropic-version`. */
export const ANTHROPIC_VERSION = '2023-06-01'

/**
 * Client version this route CLAIMS to be on the subscription gateway.
 *
 * Upstream enforces a *minimum reported client version* per model on the
 * subscription path: the version travels in the `user-agent` header (built by
 * `claudeUserAgent` in client.ts) and a claim below the floor is refused with
 * HTTP 400 and an error body whose code is `claude_code_version_too_old`. That
 * is a hard stop for the whole request rather than a per-request failure, and the
 * number in the refusal is OUR OWN claim echoed back — so the user is told their
 * client is too old without being told which model demanded more, which is
 * exactly how it misleads people into signing in again.
 *
 * THE INVARIANT THIS CONSTANT CARRIES. It must be at or above the highest
 * `minCliVersion` that any shipped model in `model-catalog.ts` declares. A
 * default below a shipped model's floor is a model this package advertises in
 * its own picker and then cannot call at all, which is the bug this comment now
 * records: `2.1.251` shipped while `claude-opus-5-5` — also shipped, and the
 * row the default picker leads with — requires `2.1.280`. The matching
 * regression lock lives in `test/claude-model-catalog.test.ts` and fails
 * loudly, naming both versions, when a future model's floor is added without
 * raising this value.
 *
 * The value is a REAL published `@anthropic-ai/claude-code` release, not a
 * number chosen merely to clear a floor: claiming a version that does not exist
 * trades a clear refusal for an unpredictable one. Note that npm's `stable`
 * dist-tag can itself sit below a model's floor, so `latest` is the tag to read.
 *
 * It is still not a literal that only moves when this package is republished: a
 * user whose installed baseline has aged past the server's floor has to be able
 * to raise it without waiting for a release. Read the effective value with
 * {@link claudeCliVersion}, pin one with {@link setClaudeCliVersion}.
 */
export const CLAUDE_CLI_VERSION = '2.1.283'

/**
 * Loopback callback port the subscription flow defaults to.
 *
 * The port is not free-form: it is part of the redirect URI, and the
 * authorization host only accepts a redirect URI registered for the client, so
 * this default is the one known to be accepted. It is still only a *default* —
 * see {@link CALLBACK_PORT_ATTEMPTS}.
 */
export const DEFAULT_CALLBACK_PORT = 53692

/**
 * How many consecutive ports one probe covers, starting at the default.
 *
 * Windows (Hyper-V/WinNAT) dynamically reserves TCP port ranges that change on
 * every reboot. A fixed callback port can land inside one and `listen` fails
 * with `EACCES`, so browser authorization never completes. Excluded ranges are
 * reserved in blocks of up to 100 ports, which is why a probe narrower than that
 * can stop inside a block and still fail; 128 covers any single block the
 * default port can start in. Mirrors the Antigravity line's own probe.
 */
export const CALLBACK_PORT_ATTEMPTS = 128

/** Path of the loopback callback the browser is redirected to. */
export const CALLBACK_PATH = '/callback'

/** Idle ceiling for one streaming response before it is declared stalled. */
export const STREAM_IDLE_TIMEOUT_MS = 300_000
/** Failure code the adapter reports for that stall. */
export const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'
/** Ceiling for a model-listing or usage fetch. */
export const DISCOVERY_TIMEOUT_MS = 20_000
/** Whole-request ceiling for one non-streaming chat call. */
export const CHAT_TIMEOUT_MS = 300_000
/** How long a usage reading is served from cache before it is refetched. */
export const QUOTA_CACHE_TTL_MS = 120_000
/** How long a usage reading keeps answering while refreshes fail behind it. */
export const QUOTA_FULL_REFRESH_MS = 300_000
/** How long a model listing is served from cache. */
export const CATALOG_CACHE_TTL_MS = 1_800_000
/** How long a sign-in may stay open before it is abandoned. */
export const LOGIN_TIMEOUT_MS = 600_000

/** Output cap requested when the caller states none. */
export const DEFAULT_MAX_TOKENS = 32_768
/**
 * Context window assumed for a model the catalog does not describe.
 *
 * 200K is the window every non-1M Claude model ships, so it is the value that is
 * wrong for the fewest ids. The dangerous direction is a window that is too
 * large — the request is rejected outright — while one that is too small only
 * compacts earlier than it had to.
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/**
 * Product identity for the `User-Agent`.
 *
 * The endpoint and the header vocabulary are Anthropic's own public contract, so
 * this route identifies itself honestly as this plugin rather than
 * impersonating a client it is not.
 */
export const PLUGIN_USER_AGENT = 'dsh-chatgpt-subscription (+https://github.com/Aa728848/dsh-chatgpt-subscription)'

/**
 * Anthropic error types this line classifies.
 *
 * Anthropic reports the real condition in the response body's `error.type`
 * while the HTTP status stays coarse — several unrelated conditions share a
 * status — so classification reads the body and only falls back to the status
 * line when the body is unreadable.
 *
 * The keys are what this route calls each condition; the values are the wire
 * strings, so an unknown string is never silently mapped onto a neighbour.
 */
export const ERROR_TYPE = {
  /** 401 — the credential is absent, malformed, or expired. Re-signing in fixes it. */
  AUTHENTICATION: 'authentication_error',
  /** 403 — the credential is valid but the account may not use this resource. */
  PERMISSION: 'permission_error',
  /** 400 — the request itself is malformed or carries an unsupported parameter. */
  INVALID_REQUEST: 'invalid_request_error',
  /** 429 — request-rate or usage-window limit. The body may name a reset instant. */
  RATE_LIMIT: 'rate_limit_error',
  /** 529 — transient capacity shortage; retrying is the whole remedy. */
  OVERLOADED: 'overloaded_error',
  /** 404 — unknown model id or unknown resource. */
  NOT_FOUND: 'not_found_error',
  /** 500 — an unexpected server-side failure. */
  API: 'api_error',
  /** 413 — the request body exceeds the maximum size, independent of token count. */
  REQUEST_TOO_LARGE: 'request_too_large',
} as const

/** One error type this line classifies. */
export type ClaudeErrorType = (typeof ERROR_TYPE)[keyof typeof ERROR_TYPE]

/**
 * Error code the server reports when the client version it was told is too old.
 *
 * Distinct from {@link ERROR_TYPE}: the failure arrives as an ordinary
 * `invalid_request_error` whose *details* carry this code, which is why it needs
 * its own constant rather than a slot in the table above.
 */
export const ERROR_CODE_CLIENT_VERSION_TOO_OLD = 'claude_code_version_too_old'

/** Every error type this line recognizes, for validation and tests. */
export const CLAUDE_ERROR_TYPES: readonly ClaudeErrorType[] = Object.values(ERROR_TYPE)

/** Whether a wire string is one of the error types this line classifies. */
export function isClaudeErrorType(value: unknown): value is ClaudeErrorType {
  return typeof value === 'string' && (CLAUDE_ERROR_TYPES as readonly string[]).includes(value)
}

/** In-process override set by {@link setClaudeCliVersion}. */
let cliVersionOverride: string | null = null

/**
 * Effective client version to report.
 *
 * Resolution order is deliberate: an explicit {@link setClaudeCliVersion} pin
 * wins, then the `DSH_CLAUDE_CLI_VERSION` environment variable, then the shipped
 * baseline. The pin lets a running host react to
 * `claude_code_version_too_old` without a restart; the environment variable lets a
 * user do it without any code path at all.
 */
export function claudeCliVersion(): string {
  const configured = (cliVersionOverride ?? process.env.DSH_CLAUDE_CLI_VERSION ?? '').trim()
  return configured === '' ? CLAUDE_CLI_VERSION : configured
}

/**
 * Pin the reported client version.
 *
 * Pass `null` (or a blank string) to clear the pin and fall back to the
 * environment and then the shipped baseline.
 */
export function setClaudeCliVersion(value: string | null): void {
  const normalized = (value ?? '').trim()
  cliVersionOverride = normalized === '' ? null : normalized
}

/**
 * Compare two dotted numeric versions, e.g. `'2.1.283'` against `'2.1.280'`.
 *
 * This exists so a version FLOOR can be checked before a request is sent. The
 * comparison is deliberately small and TOTAL rather than a SemVer parser: the
 * only strings it ever sees are this line's own reported version (a pin, the
 * `DSH_CLAUDE_CLI_VERSION` override, or the shipped default) and the floors
 * recorded in the model catalog, and it must not throw on any of them — a
 * comparison that can throw would turn a misconfigured version into a crash
 * instead of the precise pre-flight refusal it was added to produce.
 *
 * Total means: a missing segment compares as 0 (`'2.1'` equals `'2.1.0'`), and a
 * segment that is not a run of decimal digits compares as 0 rather than as NaN
 * (`'abc'` equals `'0.0.0'`, and so does `''`). Leading zeros are exact rather
 * than octal, and an optional leading `v` is tolerated because that is how a
 * release is often written down.
 *
 * @returns a negative number, 0, or a positive number — the sign is the whole
 *   contract, so callers compare against 0 rather than against ±1.
 */
export function compareDottedVersions(left: string, right: string): number {
  const a = versionSegments(left)
  const b = versionSegments(right)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Whether one reported version clears a floor.
 *
 * An absent floor (`undefined`) means "no known floor" rather than "no floor",
 * so it never blocks a request: refusing a model because nobody recorded a
 * number would be this line inventing a restriction upstream never stated.
 * A MALFORMED version on either side, on the other hand, is refused — that is
 * the conservative direction, since the check exists to stop an unknown claim
 * from reaching a server that has already refused one.
 */
export function meetsDottedVersionFloor(version: string, floor?: string): boolean {
  if (floor === undefined || floor.trim() === '') return true
  if (!isDottedVersion(version)) return false
  return compareDottedVersions(version, floor) >= 0
}

/** Whether a string is a run of dot-separated decimal segments (an optional leading `v`). */
function isDottedVersion(value: string): boolean {
  const trimmed = value.trim().replace(/^v/i, '')
  return /^\d+(\.\d+)*$/.test(trimmed)
}

/** Numeric segments of a dotted version; a non-numeric or absent segment is 0. */
function versionSegments(value: string): number[] {
  const trimmed = value.trim().replace(/^v/i, '')
  if (trimmed === '') return [0]
  return trimmed.split('.').map((segment) => {
    const digits = /^\d+$/.test(segment.trim()) ? segment.trim() : ''
    if (digits === '') return 0
    const parsed = Number.parseInt(digits, 10)
    return Number.isFinite(parsed) ? parsed : 0
  })
}

/**
 * Resolve the browser authorization endpoint.
 *
 * The subscription flow has answered on more than one host, while its Console
 * counterpart has always been a different product, so a user hitting an
 * authorization failure needs a way to point this route elsewhere without a
 * republish — the same escape hatch the sibling Kimi line gives its OAuth host.
 */
export function oauthAuthorizeUrl(): string {
  const override = (process.env.DSH_CLAUDE_OAUTH_AUTHORIZE_URL ?? '').trim()
  return override === '' ? OAUTH_AUTHORIZE_URL : override
}

/** Loopback redirect URI the authorization host is told to return to. */
export function loopbackRedirectUri(port: number = DEFAULT_CALLBACK_PORT): string {
  return 'http://localhost:' + port + CALLBACK_PATH
}
