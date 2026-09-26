/**
 * Claude subscription OAuth sign-in.
 *
 * WHO THIS FILE IS FOR, AND WHAT IT ASSUMES ABOUT UPSTREAM.
 *
 * This module drives the browser sign-in that turns a Claude Pro/Max account
 * into a credential this provider can call /v1/messages with. The wire facts it
 * relies on — authorization endpoint, token endpoint, client id, scope set, the
 * manual-paste redirect URI, the default callback port, the login timeout — all
 * live in the frozen sibling 'types.ts' and are imported from there rather than
 * restated here: one fact, one home.
 *
 * Everything this module could NOT verify is called out inline and collected
 * again in the ASSUMPTIONS block at the bottom of this comment. Treat each one
 * as a claim a later reviewer may need to re-check against the live
 * authorization host: a locally installed reference implementation is an
 * artifact, not a specification.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A COPY OF THE REFERENCE
 * ---------------------------------------------------------------------------
 *
 * The locally installed reference ('@earendil-works/pi-ai',
 * dist/auth/oauth/anthropic.js line 209) sets 'state: verifier' — it reuses the
 * PKCE code verifier AS the OAuth state. That puts the verifier in a URL (the
 * authorize URL, the address bar, browser history, and in the manual flow the
 * clipboard) while the verifier is the one value that is supposed to stay
 * inside this process: PKCE's whole security argument is that an attacker who
 * can READ the authorization request still cannot redeem the code without the
 * verifier. A leaked verifier plus a leaked code is a complete exchange, so
 * this module draws the two values independently and never encodes the
 * verifier anywhere a URL can carry it. 'test/claude-oauth.test.ts' asserts
 * that property directly on the produced URL.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TWO MODES ARE TWO FLOWS
 * ---------------------------------------------------------------------------
 *
 * An authorization code is bound to the redirect_uri of the request that issued
 * it: the token endpoint compares the redirect_uri sent with the exchange
 * against the one recorded with the code and rejects the request when they
 * differ. "Which redirect URI is in the UI right now" is therefore not a value
 * the exchange may read — it has to be the value recorded on the flow that
 * produced the code. So each sign-in is a LoginFlow carrying its own
 * { flowId, mode, redirectUri, verifier, state }, the mode is immutable for
 * that flow's lifetime, and switching mode abandons the flow and starts a new
 * one with fresh secrets. The exchange reads flow.redirectUri and nothing else,
 * which is also what lets a test prove the two modes never share one request.
 *
 * ---------------------------------------------------------------------------
 * ASSUMPTIONS (each one unverifiable from here)
 * ---------------------------------------------------------------------------
 *
 * - A1. "The client registration permits arbitrary ports." The loopback flow
 *   hands the authorization host a redirect URI built from whatever port the
 *   probe resolves, on the theory that a public client registered for a
 *   loopback redirect accepts any port (RFC 8252 section 7.3 says it should,
 *   which is why the port of a loopback redirect is normally ignored). THIS IS
 *   AN ASSUMPTION, NOT A VERIFIED FACT: the registration belongs to Anthropic
 *   and nothing in this repository can read it. If it is false, the browser
 *   callback fails for every port except an exactly registered one — and the
 *   failure is recoverable, because the manual flow exists, the probe already
 *   degrades to it, and the card tells the user why.
 * - A2. The token endpoint accepts the two JSON bodies written below, including
 *   'state' in the authorization_code exchange. Both shapes are transcribed
 *   from the reference implementation; neither was exercised against a live
 *   account from here.
 * - A3. A token response that omits 'refresh_token' means "keep the one you
 *   have" rather than "there is no refresh token". The reference stores the
 *   field unconditionally, which would overwrite a working refresh token with
 *   undefined; this module prefers the stored value. The two readings differ
 *   only in the case where one of them destroys the credential, and losing a
 *   rotating credential is unrecoverable without a fresh sign-in.
 * - A4. 'expires_in' is seconds and the server keeps it inside
 *   [300, 31536000]. That clamp is the reference's own guard, transcribed; a
 *   response outside it is treated as malformed rather than trusted. The
 *   observable consequence of a grant narrower than reported is exactly what
 *   this module already handles: a 401 that forces a refresh, or a final
 *   verdict that forces a new sign-in.
 * - A5. The account endpoint shape for 'account' ({uuid, email_address}) is the
 *   reference's; the fields are parsed defensively and are purely cosmetic.
 * - A6. A browser that resolves 'localhost' to ::1 first will still reach a
 *   listener bound only to 127.0.0.1, because every mainstream browser falls
 *   back across address families (Happy Eyeballs, RFC 8305) when the first
 *   attempt is refused. The redirect URI comes from types.ts's
 *   loopbackRedirectUri(), which spells the authority 'localhost', while the
 *   listener is bound to the 127.0.0.1 literal — binding the wildcard address
 *   instead would expose a one-time authorization code to every interface on
 *   the machine, which is the worse failure.
 *
 *   Corroborated rather than merely assumed: the reference implementation ships
 *   exactly this pairing — `CALLBACK_HOST = "127.0.0.1"` (anthropic.js:16) with
 *   `REDIRECT_URI = \`http://localhost:\${CALLBACK_PORT}\${CALLBACK_PATH}\`` (line 19).
 *   So 'localhost' in the advertised URI with a v4-literal bind is the combination
 *   a working client actually uses, and that is why this module keeps it instead
 *   of "fixing" the spelling to 127.0.0.1: the authority is also what the client
 *   is registered for, so changing it is the riskier edit, not the safer one.
 *   If a browser without the cross-family fallback ever matters, the fix belongs
 *   in types.ts and must be weighed against that registration.
 *
 * ---------------------------------------------------------------------------
 * SECRET HYGIENE
 * ---------------------------------------------------------------------------
 *
 * The authorization code, both tokens and the PKCE verifier never enter a
 * status object, an error message, or a log line. Every error raised here names
 * the CLASS of failure (and at most the HTTP status); none interpolates a
 * credential. Tests assert this by searching the serialized status payload and
 * the thrown messages for the secret material.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import {
  CALLBACK_PATH,
  CALLBACK_PORT_ATTEMPTS,
  DEFAULT_CALLBACK_PORT,
  LOGIN_TIMEOUT_MS,
  OAUTH_CLIENT_ID,
  OAUTH_MANUAL_REDIRECT_URI,
  OAUTH_SCOPES,
  OAUTH_TOKEN_URL,
  loopbackRedirectUri,
  oauthAuthorizeUrl,
} from './types.ts'

// ---------------------------------------------------------------------------
// Credential shape
// ---------------------------------------------------------------------------

/**
 * The stored credential is OWNED by the sibling token-store module.
 *
 * Imported as a type and never re-declared here. That direction of dependency is
 * the point: a second structural copy of this shape would drift, and the drift
 * would be silent in the worst direction — the store refuses (or, worse,
 * narrows) a credential this module wrote, so the sign-in succeeds and the very
 * next call reports "not signed in". The concrete trap this avoids:
 * 'token-store.ts' records the granted scopes as a 'scopes' ARRAY and requires
 * 'user:inference' in it, so a credential written with a space-delimited
 * 'scope' string would parse to zero scopes and be refused as "not a
 * subscription credential".
 */
import type { ClaudeAccountInfo, ClaudeCredentials } from './token-store.ts'

export type { ClaudeCredentials }

/**
 * The only store interface this module needs.
 *
 * Deliberately two methods and no class: 'read' returning null means "not
 * signed in", which is a state rather than an error. This module never learns
 * how the bytes reach the disk, so the real store's document layout, its
 * account records and its preference settings are all outside its concern —
 * the caller passes a two-method adapter over whichever of those it holds.
 */
export interface ClaudeTokenStore {
  read(): Promise<ClaudeCredentials | null>
  write(credentials: ClaudeCredentials): Promise<void>
}

// ---------------------------------------------------------------------------
// Local tuning constants
// ---------------------------------------------------------------------------

/** The one interface the loopback listener is ever bound to. */
export const LOOPBACK_HOST = '127.0.0.1'

/** Ceiling for one token-endpoint call. */
const OAUTH_TIMEOUT_MS = 30_000
/** Refresh when the access token has this little left; not in types.ts. */
const REFRESH_MARGIN_MS = 300_000
/** Attempts one refresh gets, including the first. */
const REFRESH_MAX_ATTEMPTS = 3
/** First backoff step; doubled per attempt. */
const REFRESH_BACKOFF_BASE_MS = 1_000
/** Statuses that mean "the endpoint is busy", not "the credential is dead". */
const RETRYABLE_TOKEN_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 529])
/** Body error codes that are a verdict on the grant rather than a hiccup. */
const FINAL_GRANT_CODES = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_scope'])

/**
 * A loopback port the client registration is KNOWN to permit, if one exists.
 *
 * This line has not verified such a port, and the honest representation of "not
 * verified" is null rather than a copied guess: the reference's own
 * constant is a fictional reserved port, so honouring it would send the browser
 * to a port nothing can bind. With null, the flow probes for a free port and
 * depends on assumption A1. Kept as a constant so that a verified registration
 * port is a one-line change and the probe becomes a fallback for the case where
 * it is occupied.
 */
const REGISTERED_CALLBACK_PORT: number | null = null

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Raised when the credential is dead and only a new sign-in can fix it. */
export class ClaudeUnauthorizedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClaudeUnauthorizedError'
  }
}

/** Raised when a transient failure outlived its retry budget. */
export class ClaudeRetryableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'ClaudeRetryableError'
  }
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** base64url without padding: the only encoding OAuth and PKCE want. */
function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url')
}

/**
 * Replace any of this flow's secret strings with a placeholder.
 *
 * The description fields below come from the SERVER, and a server that echoes
 * part of the request back is not unheard of — so anything derived from a
 * response body is scrubbed before it becomes an Error message that ends up in
 * a status object, a log, or a bug report. Secrets under four characters are
 * skipped: they cannot be a credential, and replacing a one-character string
 * would corrupt the message into noise.
 */
function redactSecrets(message: string, secrets: readonly (string | undefined)[]): string {
  let redacted = message
  for (const secret of secrets) {
    if (secret === undefined || secret.length < 4) continue
    redacted = redacted.replaceAll(secret, '[redacted]')
  }
  return redacted
}

/** A JSON object, or undefined for anything else. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** A non-empty string, or undefined. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Read the error fields one OAuth failure body may carry.
 *
 * The endpoint answers in more than one shape, so both the nested
 * ({error:{type,message}}) and the flat ({error,error_description}) forms are
 * unwrapped. Only two string fields are returned: a body is not allowed to
 * smuggle anything else into an error message.
 */
function oauthErrorFields(payload: unknown): { code: string; description: string } {
  const root = asRecord(payload) ?? {}
  const nested = asRecord(root.error)
  if (nested !== undefined) {
    return {
      code: nonEmptyString(nested.type) ?? nonEmptyString(nested.code) ?? '',
      description: nonEmptyString(nested.message) ?? nonEmptyString(nested.error_description) ?? '',
    }
  }
  return {
    code: nonEmptyString(root.error) ?? '',
    description: nonEmptyString(root.error_description) ?? nonEmptyString(root.error_message) ?? '',
  }
}

/**
 * Combine a caller signal with a hard local timeout.
 *
 * Whichever fires first wins, so an abandoned sign-in stops promptly while a
 * hung endpoint still cannot hold the request open forever.
 */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Whether an inbound socket address is one of this machine's loopback literals.
 *
 * Node reports a v4 connection accepted by a v6 socket as '::ffff:127.0.0.1',
 * so that spelling is accepted too — but only for the 127/8 block, never for a
 * v4-mapped public address.
 */
function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  if (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1') return true
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
  if (mapped !== null && mapped[1] !== undefined) return mapped[1].startsWith('127.')
  return false
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

/** The secrets one authorize request is built from. */
export interface PkceMaterial {
  /** SECRET. Never placed in a URL, a log, or an error. */
  verifier: string
  /** The only half of the pair that belongs in the authorize URL. */
  challenge: string
  /** Independent anti-forgery value; NOT derived from the verifier. */
  state: string
}

/**
 * Generate one flow's PKCE material and state.
 *
 * The verifier is 32 random bytes — the RFC 7636 ceiling for entropy — encoded
 * as base64url, and the challenge is its SHA-256 in the same encoding. The
 * state is a SEPARATE 24-byte draw. Deriving it from the verifier, or reusing
 * the verifier as the reference does, would make the two values one secret and
 * put the verifier in the URL. 24 bytes is comfortably above the 16-byte floor
 * this line requires, and the two are the same length so nothing about their
 * shapes can be used to tell them apart.
 */
export function generatePkceMaterial(): PkceMaterial {
  const verifier = base64Url(randomBytes(32))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  const state = base64Url(randomBytes(24))
  return { verifier, challenge, state }
}

// ---------------------------------------------------------------------------
// Token endpoint calls
// ---------------------------------------------------------------------------

/** Account facts a token response may name, in the sibling store's own spelling. */
export type TokenAccount = ClaudeAccountInfo

/** One parsed token response, in the shape the credential store consumes. */
export interface OAuthTokenResult {
  accessToken: string
  /** Empty string when the endpoint did not report one; see A3. */
  refreshToken: string
  expiresAt: number
  expiresIn: number
  /** Empty when the endpoint reported no scope at all. */
  scopes: string[]
  account: TokenAccount
}

/**
 * Split a scope value into the list the store records.
 *
 * Both shapes are accepted for the same reason the sibling store accepts them:
 * RFC 6749 states 'scope' as ONE space-delimited string while an SDK wrapper
 * may hand back an array. The two spellings are normalized here, at the wire
 * boundary, so the credential this module writes is always the list form — a
 * string left in place would parse to zero scopes downstream and refuse a
 * perfectly good credential as "not a subscription credential".
 */
function parseScopes(value: unknown): string[] {
  const entries = typeof value === 'string' ? value.split(/\s+/) : Array.isArray(value) ? value : []
  const scopes: string[] = []
  for (const entry of entries) {
    if (typeof entry !== 'string') continue
    const scope = entry.trim()
    if (scope !== '') scopes.push(scope)
  }
  return scopes
}

/**
 * Read the account block, in the store's own field spelling.
 *
 * The keys are the wire's ('uuid', 'email_address') and are copied verbatim
 * rather than renamed: the sibling store reads exactly these two, and a rename
 * here would produce an account the card cannot identify.
 */
function parseAccount(record: Record<string, unknown>): TokenAccount {
  const account = asRecord(record.account)
  if (account === undefined) return {}
  const uuid = nonEmptyString(account.uuid)
  const email = nonEmptyString(account.email_address)
  return {
    ...(uuid === undefined ? {} : { uuid }),
    ...(email === undefined ? {} : { email_address: email }),
  }
}

/**
 * Parse a token response defensively.
 *
 * Every field is validated rather than assumed. A missing access token is
 * always an error, and so is a missing refresh token on the EXCHANGE — a
 * subscription credential without one can never be renewed, so storing it would
 * produce an account that looks signed in and dies at the first expiry with no
 * way back except another sign-in. On a REFRESH the field is optional by
 * design (A3) and the caller keeps the stored value.
 *
 * The lifetime is clamped the way the reference clamps it (A4): a value outside
 * the clamp is malformed rather than merely short.
 */
function parseTokenResponse(record: Record<string, unknown>, options: { requireRefreshToken: boolean }): OAuthTokenResult {
  const accessToken = nonEmptyString(record.access_token)
  if (accessToken === undefined) throw new Error('The Claude token endpoint did not return an access token.')
  const refreshToken = nonEmptyString(record.refresh_token) ?? ''
  if (options.requireRefreshToken && refreshToken === '') {
    throw new Error('The Claude token endpoint did not return a refresh token.')
  }

  const rawExpiresIn = Number(record.expires_in)
  if (!Number.isFinite(rawExpiresIn) || rawExpiresIn <= 0) {
    throw new Error('The Claude token endpoint returned an invalid token lifetime.')
  }
  const expiresIn = Math.min(Math.max(Math.round(rawExpiresIn), 300), 31_536_000)

  return {
    accessToken,
    refreshToken,
    // The 5-minute margin lives in this arithmetic, exactly as the reference
    // expresses it: the credential is treated as expiring early, so a request
    // that starts just before the boundary never carries a dead token.
    expiresAt: Date.now() + expiresIn * 1000 - REFRESH_MARGIN_MS,
    expiresIn,
    // Always the LIST form: see parseScopes. An omitted scope field yields an
    // EMPTY list rather than the set this route asked for — claiming granted
    // scopes the server did not report would be a fabricated entitlement, and
    // the sibling store is the right place to refuse the result (it requires
    // user:inference). Failing there is visible and fail-closed; inventing the
    // scope here would be neither.
    scopes: parseScopes(record.scope),
    account: parseAccount(record),
  }
}

interface TokenRequestOptions {
  fetchFn?: typeof fetch
  signal?: AbortSignal
}

/**
 * POST one grant to the token endpoint and classify the answer.
 *
 * Classification is the point. A 401/403, or a body naming a final grant code,
 * is FINAL — the credential is dead, retrying can never succeed, and the caller
 * must sign in again. A 408/425/429 or 5xx is TRANSIENT and is raised as
 * retryable for the caller's bounded backoff. A body that cannot be read is
 * classified by status alone, which errs the safe way: an unreadable 401 stays
 * final, an unreadable 500 stays retryable.
 */
async function postTokenGrant(
  body: Record<string, string>,
  options: TokenRequestOptions,
  requireRefreshToken: boolean,
  /** Every secret this request carried, scrubbed out of any message derived from the response. */
  secrets: readonly (string | undefined)[],
): Promise<OAuthTokenResult> {
  const fetchFn = options.fetchFn ?? fetch
  let response: Response
  try {
    response = await fetchFn(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: withTimeout(options.signal, OAUTH_TIMEOUT_MS),
    })
  } catch (error) {
    // A transport failure says nothing about the credential, so it is retryable.
    throw new ClaudeRetryableError('Could not reach the Claude token endpoint.', error)
  }

  const payload: unknown = await response.json().catch(() => undefined)
  const record = asRecord(payload) ?? {}
  const { code, description } = oauthErrorFields(payload)
  const detail = description === '' ? '' : ': ' + redactSecrets(description, secrets)

  if (response.ok) {
    const result = parseTokenResponse(record, { requireRefreshToken })
    return { ...result, account: result.account }
  }
  if (response.status === 401 || response.status === 403 || FINAL_GRANT_CODES.has(code)) {
    throw new ClaudeUnauthorizedError(
      detail === ''
        ? 'Claude rejected the sign-in (HTTP ' + response.status + '). Sign in again.'
        : 'Claude rejected the sign-in' + detail + '. Sign in again.',
    )
  }
  if (!RETRYABLE_TOKEN_STATUSES.has(response.status) && response.status < 500) {
    throw new ClaudeUnauthorizedError(
      'The Claude token endpoint refused the request (HTTP ' + response.status + ')' + detail + '.',
    )
  }
  throw new ClaudeRetryableError('The Claude token endpoint failed (HTTP ' + response.status + ')' + detail + '.')
}

/**
 * Exchange an authorization code for a token pair (RFC 6749 section 4.1.3).
 *
 * 'redirectUri' is passed in rather than resolved here: it must be the value
 * recorded on the flow that issued the code, never a "current UI" value, or the
 * endpoint rejects the exchange.
 */
export async function exchangeAuthorizationCode(
  params: { code: string; state: string; verifier: string; redirectUri: string },
  options: TokenRequestOptions = {},
): Promise<OAuthTokenResult> {
  return postTokenGrant({
    grant_type: 'authorization_code',
    client_id: OAUTH_CLIENT_ID,
    code: params.code,
    state: params.state,
    redirect_uri: params.redirectUri,
    code_verifier: params.verifier,
  }, options, true, [params.code, params.verifier, params.state])
}

/**
 * Refresh an access token, with a bounded retry over transient failures.
 *
 * Only a transient status or a transport failure is retried. A final verdict —
 * ClaudeUnauthorizedError — stops immediately and propagates, because every
 * further attempt would be a guaranteed rejection and, on a rotation endpoint,
 * one more chance to spend the refresh token.
 *
 * The returned 'refreshToken' is empty when the endpoint named none; the caller
 * merges that case by keeping the stored value (A3).
 */
export async function refreshAccessToken(
  refreshToken: string,
  options: TokenRequestOptions = {},
): Promise<OAuthTokenResult> {
  const body = {
    grant_type: 'refresh_token',
    client_id: OAUTH_CLIENT_ID,
    refresh_token: refreshToken,
    scope: OAUTH_SCOPES,
  }
  let lastError: unknown
  for (let attempt = 0; attempt < REFRESH_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await postTokenGrant(body, options, false, [refreshToken])
    } catch (error) {
      if (error instanceof ClaudeUnauthorizedError) throw error
      lastError = error
    }
    if (attempt < REFRESH_MAX_ATTEMPTS - 1) {
      await sleep(REFRESH_BACKOFF_BASE_MS * 2 ** attempt, options.signal)
    }
  }
  throw lastError instanceof ClaudeRetryableError
    ? lastError
    : new ClaudeRetryableError('Claude token refresh failed after retries.', lastError)
}

// ---------------------------------------------------------------------------
// Token lifecycle
// ---------------------------------------------------------------------------

/** One in-flight refresh, so concurrent callers share a single rotation. */
let inFlightRefresh: Promise<ClaudeCredentials> | null = null

export interface EnsureTokenOptions {
  fetchFn?: typeof fetch
  signal?: AbortSignal
  /** Refresh even when the stored token still looks valid. */
  force?: boolean
}

/**
 * Merge the account facts a refresh reported over the stored ones.
 *
 * A refresh may answer without the account block, and the stored identity is
 * then still the best answer, so it survives rather than being erased — an
 * account whose name disappears on renewal is one the settings card can no
 * longer identify or let the user select.
 *
 * The fields are flattened at the field level (rather than preferring the newer
 * whole object) because the store treats the two as one identity: its
 * 'identityKeysFor' emits a uuid alias and an address alias independently, so
 * half an update is still strictly better than none.
 */
function mergeAccount(next: TokenAccount, current: TokenAccount | undefined): TokenAccount {
  const uuid = next.uuid ?? current?.uuid
  const emailAddress = next.email_address ?? current?.email_address
  const emailAddressCamel = next.emailAddress ?? current?.emailAddress
  return {
    ...(uuid === undefined ? {} : { uuid }),
    ...(emailAddress === undefined ? {} : { email_address: emailAddress }),
    ...(emailAddressCamel === undefined ? {} : { emailAddress: emailAddressCamel }),
  }
}

/**
 * Return a usable credential, refreshing and persisting it first when needed.
 *
 * SINGLE-FLIGHT, and that is a correctness property rather than an
 * optimisation. The refresh token rotates: the first refresh spends the token
 * that was sent, so a burst of callers arriving at expiry must NOT each send
 * it. Under the naive implementation the second request carries a token the
 * first already spent, the endpoint answers with a final verdict, and the user
 * is signed out by their own concurrency. One shared promise means exactly one
 * rotation per expiry, and it is cleared in a 'finally' so a FAILED refresh
 * does not wedge the account: the next call retries instead of forever joining
 * a rejected promise.
 */
export async function ensureAccessToken(
  store: ClaudeTokenStore,
  options: EnsureTokenOptions = {},
): Promise<ClaudeCredentials> {
  const credentials = await store.read()
  if (credentials === null) {
    throw new ClaudeUnauthorizedError('Not signed in to Claude. Sign in from Settings > Claude.')
  }

  // Refreshing a token that still has margin left would rotate the credential
  // for nothing and invalidate the one in flight elsewhere.
  if (options.force !== true && credentials.expiresAt - Date.now() > 0) return credentials

  if (inFlightRefresh !== null) return inFlightRefresh

  const pending = (async (): Promise<ClaudeCredentials> => {
    try {
      const token = await refreshAccessToken(credentials.refreshToken, {
        ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      const account = mergeAccount(token.account, credentials.account)
      const next: ClaudeCredentials = {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken === '' ? credentials.refreshToken : token.refreshToken,
        expiresAt: token.expiresAt,
        // The scopes the credential already carries are KEPT when the refresh
        // reports none, for the same reason the refresh token is: dropping
        // 'user:inference' would make the store refuse a credential that is
        // still perfectly good. See isSubscriptionCredential in the sibling.
        scopes: token.scopes.length > 0 ? token.scopes : (credentials.scopes ?? []),
        ...(credentials.subscriptionType === undefined ? {} : { subscriptionType: credentials.subscriptionType }),
        ...(Object.keys(account).length === 0 ? {} : { account }),
      }
      await store.write(next)
      return next
    } finally {
      inFlightRefresh = null
    }
  })()

  inFlightRefresh = pending
  return pending
}

// ---------------------------------------------------------------------------
// Browser launch
// ---------------------------------------------------------------------------

/**
 * Open a URL in the user's default browser, best effort.
 *
 * The caller ALWAYS renders the URL as well, so a machine with no browser, no
 * xdg-open, or a blocked spawn stays usable. The failure is swallowed rather
 * than surfaced because there is no action a user could take on it that they
 * cannot take by copying the URL themselves.
 */
export function openBrowser(url: string): void {
  try {
    if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref()
    } else if (process.platform === 'win32') {
      // 'start' is a cmd builtin whose first quoted argument is the window
      // title, hence the empty "" before the URL — without it the URL itself is
      // consumed as that title and nothing opens.
      spawn('cmd', ['/c', 'start', '""', '"' + url + '"'], {
        stdio: 'ignore',
        detached: true,
        windowsVerbatimArguments: true,
      }).on('error', () => undefined).unref()
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref()
    }
  } catch {
    // Best effort by construction: the URL is shown, so nothing is lost.
  }
}

// ---------------------------------------------------------------------------
// Login flow state
// ---------------------------------------------------------------------------

/** Which redirect URI an authorization request was issued for. */
export type LoginMode = 'manual' | 'loopback'

/** Where a flow currently stands. */
export type LoginStatus = 'idle' | 'pending' | 'exchanging' | 'complete' | 'error'

/**
 * One sign-in attempt.
 *
 * mode, redirectUri, verifier and state are fixed at creation and never
 * rewritten: an authorization request already in flight is bound to all four,
 * so mutating any of them would silently invalidate the code it returns.
 * 'exchanging' is the compare-and-set word that makes the exchange exactly-once
 * (see beginExchange).
 */
export interface LoginFlow {
  flowId: string
  /** Immutable for this flow's lifetime; switching mode starts a new flow. */
  readonly mode: LoginMode
  /** The URI the authorize request carried; the ONLY one the exchange may send. */
  readonly redirectUri: string
  /** SECRET. */
  readonly verifier: string
  /** A one-time forgery token, not a credential — but still never logged. */
  readonly state: string
  readonly createdAt: number
  /** Where the exchange is in its single-flight lifecycle. */
  exchanging: 'idle' | 'in-progress' | 'done'
}

/**
 * The pollable status of the sign-in surface.
 *
 * NO SECRET EVER APPEARS HERE, and tests enforce that rather than trusting the
 * convention: this object is serialized straight into an HTTP response, so the
 * verifier, the state, the authorization code and both tokens have no field to
 * live in. There is no SSE anywhere in this plugin — the client polls.
 */
export interface LoginFlowStatus {
  status: LoginStatus
  /** Correlates a status reading with the flow the user started. */
  flowId?: string
  /** Not a secret: it is the value that goes INTO the browser. */
  authUrl?: string
  mode?: LoginMode
  /** Which redirect URI is armed, for the card to display. */
  redirectUri?: string
  hint?: string
  error?: string
  /** Why a loopback attempt degraded to manual. */
  fallbackReason?: string
  createdAt?: number
  completedAt?: number
}

/** Everything a caller may override, so tests never touch the network or a browser. */
export interface BeginLoginOptions {
  /** Not a credential: it decides which redirect URI the flow is issued for. */
  mode?: LoginMode
  /** Injected so tests do not depend on machine state or on a real browser. */
  fetchFn?: typeof fetch
  openBrowser?: (url: string) => void
  /** Injected so a test can drive a callback against a listener it controls. */
  listen?: (port: number, host: string) => Promise<Server>
  /** Injected so a test can make a port look unavailable. */
  probe?: (port: number) => Promise<boolean>
  /** Ceiling for this attempt; defaults to LOGIN_TIMEOUT_MS from types.ts. */
  timeoutMs?: number
}

/** Internal state for the flow the process is currently on. */
interface ActiveFlowState {
  flow: LoginFlow
  status: LoginFlowStatus
  controller: AbortController
  server: Server | null
  timer: NodeJS.Timeout | null
  fetchFn: typeof fetch | undefined
  store: ClaudeTokenStore
}

let active: ActiveFlowState | null = null
/**
 * The last settled status, kept after the flow is released.
 *
 * Without it, releasing the flow would throw away the outcome the card is about
 * to poll — the user would be told the sign-in "went idle" right after it
 * succeeded or failed.
 */
let lastStatus: LoginFlowStatus = { status: 'idle' }

/**
 * Status of the current (or last) sign-in, for the client to poll.
 *
 * A copy, not the live object: a caller that mutated what it received would
 * otherwise desynchronize the surface from the flow.
 */
export function getLoginStatus(): LoginFlowStatus {
  return active === null ? { ...lastStatus } : { ...active.status }
}

// ---------------------------------------------------------------------------
// Loopback listener
// ---------------------------------------------------------------------------

/**
 * Bind a listener for the callback, on IPv4 loopback only.
 *
 * The address is ASSERTED rather than assumed: a listener that came up on '::'
 * or '0.0.0.0' would answer on interfaces this flow has no business exposing a
 * one-time authorization code to, and the port probe would have called the port
 * free while disagreeing about which stack holds it.
 */
function listenOn(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      const address = server.address()
      if (address === null || typeof address === 'string' || address.family !== 'IPv4') {
        server.close()
        reject(new Error('The Claude sign-in callback listener did not bind IPv4 loopback.'))
        return
      }
      resolve(server)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, LOOPBACK_HOST)
  })
}

/**
 * Whether one port can be bound on the interface the listener will use.
 *
 * The probe binds the same 127.0.0.1 the real listener binds — never
 * 'localhost' and never a bare port. A port free on the IPv4 loopback can still
 * be taken on another stack, and a probe that disagrees with the bind
 * reintroduces exactly the EADDRINUSE this exists to avoid.
 */
function isPortUsable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = http.createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, LOOPBACK_HOST)
  })
}

/**
 * First usable loopback port, or null when the probe finds none.
 *
 * null rather than a throw is deliberate (see beginLogin): a failed probe is
 * NOT a hard error, it is the signal to fall back to the manual flow. Windows
 * (Hyper-V/WinNAT) reserves TCP port ranges that move on every reboot, and
 * CALLBACK_PORT_ATTEMPTS covers any single 100-port excluded block the default
 * port can start inside.
 */
export async function resolveCallbackPort(
  probe: (port: number) => Promise<boolean> = isPortUsable,
  attempts = CALLBACK_PORT_ATTEMPTS,
): Promise<number | null> {
  if (REGISTERED_CALLBACK_PORT !== null && await probe(REGISTERED_CALLBACK_PORT)) {
    return REGISTERED_CALLBACK_PORT
  }
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = DEFAULT_CALLBACK_PORT + offset
    if (port > 65535) return null
    if (await probe(port)) return port
  }
  return null
}

/** HTML page the browser lands on; escaped, no-store, connection closed. */
function writeHtml(response: ServerResponse, status: number, message: string): Promise<void> {
  const escaped = message.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    connection: 'close',
  })
  return new Promise((resolve) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    response.once('finish', done)
    response.once('close', done)
    response.end('<!doctype html><meta charset="utf-8"><title>Claude sign-in</title><h1>' + escaped + '</h1>')
  })
}

// ---------------------------------------------------------------------------
// Exactly-once exchange
// ---------------------------------------------------------------------------

/**
 * Claim the one exchange this flow is allowed to perform.
 *
 * Compare-and-set on 'exchanging'. A browser callback and a pasted code can
 * arrive in the same tick, and without this guard BOTH would POST the same
 * authorization code: the first would spend it and the second would collect a
 * final verdict on a code that was in fact valid, signing the user out over a
 * race they never caused. The loser is told the truth and performs no second
 * exchange.
 *
 * Once the claim is held or the flow has settled, the CAS can never be won
 * again — which is what gives later requests their HTTP 410 semantics: there is
 * nothing left to exchange.
 */
function beginExchange(flow: LoginFlow): { ok: true } | { ok: false; reason: 'in-progress' | 'settled' } {
  if (active === null || active.flow.flowId !== flow.flowId) return { ok: false, reason: 'settled' }
  if (flow.exchanging === 'done') return { ok: false, reason: 'settled' }
  if (flow.exchanging === 'in-progress') return { ok: false, reason: 'in-progress' }
  flow.exchanging = 'in-progress'
  return { ok: true }
}

function finishExchange(flow: LoginFlow): void {
  if (flow.exchanging === 'in-progress') flow.exchanging = 'done'
}

// ---------------------------------------------------------------------------
// Settling and releasing a flow
// ---------------------------------------------------------------------------

/**
 * Keep a settled flow readable for a bounded window, then release its port.
 *
 * A completed flow deliberately KEEPS its listener so a late duplicate callback
 * is answered with an explicit 410 instead of a connection error, and so a
 * second browser tab cannot mistake "port closed" for "server down". The window
 * is the sign-in timeout, and it collapses to zero the moment the user starts
 * another sign-in or cancels.
 */
function rearmReap(flow: LoginFlow): void {
  const state = active
  if (state === null || state.flow.flowId !== flow.flowId) return
  if (state.timer !== null) clearTimeout(state.timer)
  const timer = setTimeout(() => {
    const current = active
    if (current === null || current.flow.flowId !== flow.flowId) return
    releaseFlow()
  }, LOGIN_TIMEOUT_MS)
  timer.unref()
  state.timer = timer
}

/**
 * Stop the flow: keep its last status, release the listener and the port.
 *
 * Closing the listener is not enough on its own — a keep-alive socket keeps the
 * port occupied after close(), so the connections are closed too. The status is
 * retained in lastStatus because the client polls it after the fact.
 */
function releaseFlow(): void {
  const state = active
  if (state === null) return
  lastStatus = { ...state.status }
  if (state.timer !== null) {
    clearTimeout(state.timer)
    state.timer = null
  }
  const server = state.server
  state.server = null
  if (server !== null) {
    server.close()
    server.closeAllConnections()
  }
  state.controller.abort()
  active = null
}

/**
 * Run the exchange for a flow that has already claimed it, and settle it.
 *
 * The CAS winner owns its whole outcome, so the winner's HTTP status describes
 * what happened to the flow while the loser's describes only its own rejected
 * request. Settling happens here but the LISTENER is released by the caller
 * after it has written its response — releasing first would tear down the
 * socket the response is still travelling on.
 */
async function runExchange(
  flow: LoginFlow,
  code: string,
): Promise<{ ok: true } | { ok: false; error: Error }> {
  const state = active
  if (state === null || state.flow.flowId !== flow.flowId) {
    return { ok: false, error: new Error('Sign-in attempt is no longer active.') }
  }
  state.status = { ...state.status, status: 'exchanging' }
  try {
    const token = await exchangeAuthorizationCode({
      code,
      state: flow.state,
      verifier: flow.verifier,
      // The flow's own value. Never a resolved "current UI" URI.
      redirectUri: flow.redirectUri,
    }, {
      ...(state.fetchFn === undefined ? {} : { fetchFn: state.fetchFn }),
      signal: state.controller.signal,
    })
    const credentials: ClaudeCredentials = {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      scopes: token.scopes,
      ...(Object.keys(token.account).length === 0 ? {} : { account: token.account }),
    }
    await state.store.write(credentials)
    state.status = { ...state.status, status: 'complete', completedAt: Date.now() }
    rearmReap(flow)
    return { ok: true }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    state.status = { ...state.status, status: 'error', error: failure.message, completedAt: Date.now() }
    rearmReap(flow)
    return { ok: false, error: failure }
  } finally {
    finishExchange(flow)
  }
}

const SUCCESS_PAGE = 'Claude sign-in completed. You can close this window.'

/**
 * The loopback callback handler.
 *
 * Order matters and is the security story of this function:
 *   1. address first — a request from anywhere but this machine learns nothing,
 *      not even whether a sign-in is in progress;
 *   2. path second — only CALLBACK_PATH answers;
 *   3. a settled or absent flow is 410, so a stale tab is told the truth;
 *   4. the wrong state is 400 FOR THAT REQUEST ONLY, and the flow is left
 *      exactly as it was. Cancelling a valid in-flight sign-in because a stray
 *      or forged request carried the wrong state would be a denial of service
 *      against the user's own login, and a mismatching request proves nothing
 *      about the request that arrives next.
 */
function callbackHandler(request: IncomingMessage, response: ServerResponse): void {
  void (async (): Promise<void> => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      await writeHtml(response, 403, 'This callback only answers on this machine.')
      return
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== CALLBACK_PATH) {
      await writeHtml(response, 404, 'Not found.')
      return
    }
    const state = active
    if (state === null) {
      await writeHtml(response, 410, 'This sign-in attempt has ended. Start a new one from DSH.')
      return
    }
    if (state.flow.exchanging === 'done') {
      // Settled: no exchange, and the caller no longer has the flow to settle.
      await writeHtml(response, 410, 'This sign-in attempt has already finished.')
      return
    }
    const providerError = url.searchParams.get('error_description') ?? url.searchParams.get('error')
    if (providerError !== null) {
      await writeHtml(response, 400, 'Claude did not complete the sign-in.')
      return
    }
    const code = url.searchParams.get('code')
    if (code === null || code === '') {
      await writeHtml(response, 400, 'This callback carried no authorization code.')
      return
    }
    if (url.searchParams.get('state') !== state.flow.state) {
      await writeHtml(response, 400, 'This callback did not match the pending sign-in request.')
      return
    }
    const claimed = beginExchange(state.flow)
    if (!claimed.ok) {
      // The browser and a pasted code raced here. The loser does NO exchange.
      await writeHtml(response, 409, 'Another Claude sign-in is already in progress.')
      return
    }
    const outcome = await runExchange(state.flow, code)
    if (outcome.ok) {
      await writeHtml(response, 200, SUCCESS_PAGE)
      return
    }
    await writeHtml(response, 500, 'Claude sign-in could not be completed. Return to DSH for details.')
  })()
}

// ---------------------------------------------------------------------------
// Manual paste
// ---------------------------------------------------------------------------

/** A value a user pasted into the manual sign-in box, or why it was rejected. */
export type LoginInputResult =
  | { ok: true; code: string; state: string }
  | { ok: false; error: string }

function fromQuery(raw: string): LoginInputResult {
  const params = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw)
  const code = params.get('code')
  const state = params.get('state')
  if (code === null || code === '') return { ok: false, error: 'That input did not contain an authorization code.' }
  if (state === null || state === '') {
    return { ok: false, error: 'That input did not contain the state value. Copy the whole string Claude showed you.' }
  }
  return { ok: true, code, state }
}

/**
 * Parse the string a user pastes back from the browser.
 *
 * Three shapes are accepted, because the page the manual flow lands on offers
 * the user more than one thing to copy: a full redirect URL, the shortened
 * <code>#<state> pair the page displays, and a bare 'code=..&state=..' query
 * fragment.
 *
 * A BARE CODE IS REJECTED. It cannot be bound to this flow — there is no state
 * to compare against — and forcing the flow's own state into the exchange would
 * defeat the state parameter entirely, turning the manual box into a login-CSRF
 * oracle: anyone who talks a user into pasting a code they supplied would get
 * that user's session bound to the attacker's account. The error says exactly
 * what to copy instead.
 */
export function resolveLoginInput(text: string): LoginInputResult {
  const value = text.trim()
  if (value === '') return { ok: false, error: 'Paste the authorization code Claude showed you.' }

  if (value.startsWith('http://') || value.startsWith('https://')) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return { ok: false, error: 'That does not look like a valid sign-in URL.' }
    }
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (code === null || code === '') return { ok: false, error: 'That URL did not contain an authorization code.' }
    if (state === null || state === '') {
      return { ok: false, error: 'That URL did not contain a state value; copy the whole address.' }
    }
    return { ok: true, code, state }
  }

  if (value.includes('#')) {
    const parts = value.split('#')
    const code = parts[0] ?? ''
    const state = parts[1] ?? ''
    if (code === '' || state === '') {
      return { ok: false, error: 'That input was missing its code or its state half.' }
    }
    return { ok: true, code, state }
  }

  if (value.includes('code=')) return fromQuery(value)

  return {
    ok: false,
    error: 'That looks like a bare code. Copy the full string Claude showed you, including the part after the #.',
  }
}

/**
 * Exchange a manually pasted value.
 *
 * The state is checked against the armed flow BEFORE anything is claimed or
 * sent, so a mistyped paste costs a 400 and leaves the flow usable — the user
 * can simply paste again. Only a value carrying the flow's own state can
 * consume the exactly-once slot, and the CAS result is mapped onto the same
 * 409/410 semantics the callback uses.
 */
export async function submitLoginInput(
  text: string,
  options: { fetchFn?: typeof fetch } = {},
): Promise<{ ok: true } | { ok: false; error: string; httpStatus: number }> {
  const state = active
  if (state === null) return { ok: false, error: 'No Claude sign-in is in progress.', httpStatus: 410 }
  if (state.flow.exchanging === 'done') {
    return { ok: false, error: 'This Claude sign-in has already finished.', httpStatus: 410 }
  }

  const parsed = resolveLoginInput(text)
  if (!parsed.ok) return { ok: false, error: parsed.error, httpStatus: 400 }
  if (parsed.state !== state.flow.state) {
    return { ok: false, error: 'That code was issued for a different sign-in request.', httpStatus: 400 }
  }

  const claimed = beginExchange(state.flow)
  if (!claimed.ok) {
    return claimed.reason === 'in-progress'
      ? { ok: false, error: 'Another Claude sign-in is already in progress.', httpStatus: 409 }
      : { ok: false, error: 'This Claude sign-in has already finished.', httpStatus: 410 }
  }

  const outcome = await runExchange(state.flow, parsed.code)
  return outcome.ok
    ? { ok: true }
    : { ok: false, error: outcome.error.message, httpStatus: 400 }
}

// ---------------------------------------------------------------------------
// beginLogin / cancelLogin
// ---------------------------------------------------------------------------

/** Build the authorize URL for one flow. The VERIFIER IS NOT IN IT. */
export function buildAuthorizeUrl(flow: Pick<LoginFlow, 'redirectUri' | 'state'>, challenge: string): string {
  const params = new URLSearchParams({
    code: 'true',
    client_id: OAUTH_CLIENT_ID,
    response_type: 'code',
    redirect_uri: flow.redirectUri,
    scope: OAUTH_SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: flow.state,
  })
  return oauthAuthorizeUrl() + '?' + params.toString()
}

/**
 * Start a sign-in and return IMMEDIATELY.
 *
 * The returned status is what the settings card polls; nothing here awaits the
 * exchange, the listener, or the browser, because the HTTP request behind the
 * button must not stay open for the whole authorization.
 *
 * A loopback probe that finds no usable port is NOT a hard error: the flow
 * degrades to manual and the caller is told why, since the manual flow needs no
 * port at all and a user whose Windows excluded range covers the default should
 * not be blocked from signing in.
 */
export async function beginLogin(
  store: ClaudeTokenStore,
  options: BeginLoginOptions = {},
): Promise<LoginFlowStatus> {
  // Switching mode — or simply starting over — ABANDONS the previous flow. Its
  // verifier, state and listener are discarded rather than reused: an
  // authorization request already in flight cannot be retargeted at a new
  // redirect URI, and reusing the secrets would let a stale code collide with
  // the fresh flow's exactly-once slot.
  if (active !== null) cancelLogin()

  const mode = options.mode ?? 'manual'
  let resolvedMode: LoginMode = mode
  let fallbackReason: string | null = null
  let server: Server | null = null
  let port: number | null = null

  if (mode === 'loopback') {
    const probe = options.probe ?? isPortUsable
    const listen = options.listen ?? listenOn
    port = await resolveCallbackPort(probe)
    if (port === null) {
      resolvedMode = 'manual'
      fallbackReason = 'No free loopback port in the ' + CALLBACK_PORT_ATTEMPTS
        + '-port range starting at ' + DEFAULT_CALLBACK_PORT + '.'
    } else {
      try {
        server = await listen(port, LOOPBACK_HOST)
      } catch (error) {
        resolvedMode = 'manual'
        fallbackReason = 'The loopback callback listener could not bind port ' + port + ': '
          + (error instanceof Error ? error.message : String(error))
        port = null
      }
    }
  }

  const material = generatePkceMaterial()
  const redirectUri = resolvedMode === 'loopback' && port !== null
    // The frozen types.ts helper, spelled 'localhost'. The LISTENER is still
    // bound to the 127.0.0.1 literal only (LOOPBACK_HOST) — never '::' or
    // '0.0.0.0', which would answer on every interface the machine has and hand
    // a one-time authorization code to whoever is on the network. The browser's
    // cross-family fallback bridges the two spellings; see assumption A6, which
    // records that this is assumed rather than measured.
    ? loopbackRedirectUri(port)
    : OAUTH_MANUAL_REDIRECT_URI

  const flow: LoginFlow = {
    flowId: randomUUID(),
    mode: resolvedMode,
    redirectUri,
    verifier: material.verifier,
    state: material.state,
    createdAt: Date.now(),
    exchanging: 'idle',
  }

  const controller = new AbortController()
  const state: ActiveFlowState = {
    flow,
    status: {
      status: 'pending',
      flowId: flow.flowId,
      mode: resolvedMode,
      redirectUri,
      authUrl: buildAuthorizeUrl(flow, material.challenge),
      hint: resolvedMode === 'manual'
        ? 'Open this URL, then paste the value Claude shows you back into DSH.'
        : 'Complete the sign-in in the browser window that just opened.',
      createdAt: flow.createdAt,
      ...(fallbackReason === null ? {} : { fallbackReason }),
    },
    controller,
    server,
    timer: null,
    fetchFn: options.fetchFn,
    store,
  }

  const timeout = setTimeout(() => {
    const current = active
    if (current === null || current.flow.flowId !== flow.flowId) return
    // A flow that already settled is only being reaped; its outcome stands.
    if (current.status.status === 'pending' || current.status.status === 'exchanging') {
      current.flow.exchanging = 'done'
      current.status = {
        ...current.status,
        status: 'error',
        error: 'The Claude sign-in timed out. Start a new one.',
        completedAt: Date.now(),
      }
    }
    releaseFlow()
  }, options.timeoutMs ?? LOGIN_TIMEOUT_MS)
  timeout.unref()
  state.timer = timeout

  if (server !== null) {
    server.on('request', callbackHandler)
    // A listener that dies under us leaves the flow pending with a browser that
    // can never reach it, so that failure is surfaced explicitly instead.
    server.on('error', (error: Error) => {
      const current = active
      if (current === null || current.flow.flowId !== flow.flowId) return
      current.flow.exchanging = 'done'
      current.status = { ...current.status, status: 'error', error: 'The callback listener failed: ' + error.message }
      releaseFlow()
    })
  }

  active = state

  const open = options.openBrowser ?? openBrowser
  try {
    open(state.status.authUrl ?? '')
  } catch {
    // The card renders the URL, so a failed launch is fully recoverable.
  }

  return { ...state.status }
}

/**
 * Abandon the current sign-in and return to idle.
 *
 * Aborts the flow's controller (so an in-flight exchange or timer stops),
 * closes the listener AND its connections (a closed listener with a live
 * keep-alive socket still holds the port), and clears the flow so the next
 * beginLogin starts from a clean slate instead of inheriting a spent
 * exactly-once slot.
 */
export function cancelLogin(): void {
  const state = active
  if (state === null) return
  state.flow.exchanging = 'done'
  state.status = { status: 'idle' }
  releaseFlow()
}
