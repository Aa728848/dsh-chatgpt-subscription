import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { URL, URLSearchParams } from 'node:url'
import type { ZhipuLoginFlowStatus } from '../../shared/zhipu-contracts.ts'
import {
  ZAI_OAUTH,
  ZAI_OAUTH_CALLBACK_PATH,
  ZAI_OAUTH_CALLBACK_PORT,
  ZAI_OAUTH_REQUEST_TIMEOUT_MS,
  ZAI_OAUTH_TIMEOUT_MS,
  apiBaseForRegion,
} from './types.ts'
import { FileCredentialStore, type ZhipuCredentials } from './token-store.ts'
import { verifyApiKey } from './client.ts'

/**
 * Browser sign-in for the GLM Coding Plan.
 *
 * The plan is bought on a web console, and the console's own client signs in
 * with the browser: the user authorizes on `chat.z.ai`, the console lends a
 * short-lived OAuth token, and the business API mints a durable `id.secret`
 * key from it. That key is an ordinary Coding Plan key, so this module's whole
 * output is the same {@link ZhipuCredentials} the paste-a-key path produces —
 * nothing downstream (verification, the pool, quota, the adapter) changes.
 *
 * Two consequences shape the code below:
 *
 * - **The flow can fail in the browser, not just in the request.** A user whose
 *   browser cannot reach this machine's loopback port still has a valid
 *   authorization code in the address bar, so every attempt also accepts the
 *   code (or the whole redirect URL) pasted back through
 *   {@link submitLoginCode}. Without that, a firewall or a remote session would
 *   leave the card pending until it timed out with a code the user could see.
 * - **Nothing is persisted before it is proven.** The minted key is checked
 *   against the Coding Plan surface exactly like a pasted one, so an account
 *   without an active plan fails at sign-in with an actionable message instead
 *   of inside a conversation.
 *
 * @module dsh-chatgpt-subscription/zhipu/oauth
 */

/** The endpoints one attempt talks to; injectable so tests never hit the network. */
export interface ZaiOAuthEndpoints {
  clientId: string
  authorizeUrl: string
  tokenUrl: string
  bizBase: string
  businessLoginUrl: string
  keyName: string
}

/** The endpoints a production attempt uses, from {@link ZAI_OAUTH}. */
export function defaultOAuthEndpoints(): ZaiOAuthEndpoints {
  return {
    clientId: ZAI_OAUTH.clientId,
    authorizeUrl: ZAI_OAUTH.authorizeUrl,
    tokenUrl: ZAI_OAUTH.tokenUrl,
    bizBase: ZAI_OAUTH.bizBase,
    businessLoginUrl: ZAI_OAUTH.businessLoginUrl,
    keyName: ZAI_OAUTH.keyName,
  }
}

/** What the console hands back: a durable key plus the account facts it reported. */
export interface ZaiAuthorization {
  /** The durable `id.secret` Coding Plan key. Host-only; never sent to a browser. */
  apiKey: string
  /** Email the token response carried, when it carried one. */
  email?: string
  /** Account id the token response carried, when it carried one. */
  accountId?: string
}

/* -------------------------------------------------------------------------- */
/* Flow state                                                                  */
/* -------------------------------------------------------------------------- */

/** One in-flight attempt, and the two ways it can be completed or abandoned. */
interface PendingAttempt {
  /** Token the console must echo back; also the CSRF guard on the callback. */
  state: string
  /** Redirect URI this attempt advertised, needed to exchange the code. */
  redirectUri: string
  /** Resolve the attempt with an authorization code from either path. */
  submit(code: string): void
  /** Abandon the attempt; a later code has nothing to join. */
  cancel(error: Error): void
}

let webLoginFlow: ZhipuLoginFlowStatus = { status: 'idle' }
let pendingAttempt: PendingAttempt | null = null

/** Live state of the browser sign-in, as the settings card polls it. */
export function getWebLoginStatus(): ZhipuLoginFlowStatus {
  return { ...webLoginFlow }
}

/**
 * Abandon any attempt in flight.
 *
 * The card calls this through `login/cancel`; the timeout and every failure
 * path funnel here too, so a flow can never stay `pending` — a stale pending
 * state is what would otherwise block every later sign-in.
 */
export function resetWebLogin(): void {
  pendingAttempt?.cancel(new Error('GLM sign-in was cancelled.'))
  pendingAttempt = null
  webLoginFlow = { status: 'idle' }
}

/** Open one URL in the platform's browser; best effort, the card always shows it. */
export function openBrowser(url: string): void {
  try {
    if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref()
    } else if (process.platform === 'win32') {
      // `start` treats its first quoted argument as a window title, hence the
      // empty title before the URL.
      spawn('cmd', ['/c', 'start', '""', `"${url}"`], {
        stdio: 'ignore',
        detached: true,
        windowsVerbatimArguments: true,
      }).on('error', () => undefined).unref()
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref()
    }
  } catch {
    // The card renders the URL, so a failed launch is always recoverable.
  }
}

/* -------------------------------------------------------------------------- */
/* Endpoint plumbing                                                           */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Whether a platform envelope's `code` means success.
 *
 * The OAuth token endpoint answers `code: 0` while the business endpoints on
 * `api.z.ai` answer `code: 200`/`success: true`; both are the same platform
 * convention, so both are accepted. A body with no status wrapper at all is not
 * an envelope and passes through untouched.
 */
function isSuccessCode(code: unknown): boolean {
  if (code === undefined || code === null) return true
  if (typeof code === 'number') return code === 0 || code === 200
  if (typeof code === 'string') return code === '0' || code === '200'
  return false
}

/**
 * Read one platform envelope, or throw the provider's own message.
 *
 * Every endpoint this flow talks to answers HTTP 200 with a business code, so a
 * caller that only checked `response.ok` would read a refusal as success.
 */
function unwrapEnvelope(body: unknown, operation: string): unknown {
  const envelope = asRecord(body)
  if (envelope === undefined || (!('code' in envelope) && !('success' in envelope))) return body
  if (envelope.success === false || !isSuccessCode(envelope.code)) {
    const message = trimmedString(envelope.msg) ?? trimmedString(envelope.message) ?? `code ${String(envelope.code)}`
    throw new Error(`Z.ai ${operation} failed: ${message}`)
  }
  return 'data' in envelope ? envelope.data : envelope
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/** One JSON request against the console, decoded through the platform envelope. */
async function requestJson(
  url: string,
  init: { method: 'GET' | 'POST'; body?: Record<string, unknown>; headers?: Record<string, string> },
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const response = await fetchFn(url, {
    method: init.method,
    headers: {
      accept: 'application/json',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: requestSignal(signal, ZAI_OAUTH_REQUEST_TIMEOUT_MS),
  })
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    throw new Error(`Z.ai request failed (${response.status})${text ? `: ${text.slice(0, 300)}` : ''}`)
  }
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('Z.ai returned an unreadable response.')
  }
}

/* -------------------------------------------------------------------------- */
/* Loopback callback                                                           */
/* -------------------------------------------------------------------------- */

/** The authorization page one attempt sends the browser to. */
export function buildAuthorizeUrl(input: { redirectUri: string; state: string; endpoints?: ZaiOAuthEndpoints }): string {
  const endpoints = input.endpoints ?? defaultOAuthEndpoints()
  const params = new URLSearchParams({
    // No PKCE: this mirrors the console's own authorization request verbatim.
    redirect_uri: input.redirectUri,
    response_type: 'code',
    client_id: endpoints.clientId,
    state: input.state,
  })
  return `${endpoints.authorizeUrl}?${params.toString()}`
}

/**
 * Pull an authorization code out of whatever the user pasted.
 *
 * The card invites two things and both are natural: the bare code, and the
 * whole redirect URL from an address bar that could not reach the loopback
 * port. Detecting the URL form by parsing is what keeps the second from being
 * submitted as a literal (and silently invalid) code.
 */
export function extractAuthorizationCode(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  try {
    const url = new URL(trimmed)
    return url.searchParams.get('code')?.trim() ?? ''
  } catch {
    // A bare code is the common case and is not a URL.
    return trimmed
  }
}

interface CallbackHandle {
  port: number
  waitForCode(): Promise<string>
  close(): void
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function sendPage(response: ServerResponse, status: number, title: string, message: string): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'close',
  })
  response.end(
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>`
    + '<body style="font-family:system-ui;padding:40px;text-align:center;">'
    + `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body>`,
  )
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError)
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : port)
    })
  })
}

/**
 * One-shot loopback listener the console redirects the browser to.
 *
 * Only the loopback interface is bound and only the exact callback path is
 * answered, because the URL carries the authorization code: anything else
 * reaching this port would be handed the code or able to forge one. The state
 * check is the same guard the sibling lines use — a code that arrives with a
 * state this attempt did not mint belongs to a different attempt (or to an
 * attacker's) and is refused rather than exchanged.
 */
async function startCallbackServer(preferredPort: number, expectedState: string): Promise<CallbackHandle> {
  let settleCode: (code: string) => void = () => undefined
  let failCode: (error: Error) => void = () => undefined
  const codePromise = new Promise<string>((resolve, reject) => {
    settleCode = resolve
    failCode = reject
  })
  // An abandoned attempt rejects this promise with nobody attached yet; the
  // rejection is still observed by the awaiting flow, so this only prevents a
  // spurious unhandled-rejection report in between.
  codePromise.catch(() => undefined)

  let settled = false
  let closed = false
  const shutdown = (): void => {
    if (closed) return
    closed = true
    server.closeIdleConnections?.()
    server.closeAllConnections?.()
    server.close()
  }
  const finish = (error?: Error, code?: string): void => {
    if (settled) return
    settled = true
    shutdown()
    if (error === undefined) settleCode(code ?? '')
    else failCode(error)
  }

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let url: URL
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1')
    } catch {
      sendPage(response, 400, 'Sign-in failed', 'The callback URL was malformed.')
      return
    }
    if (url.pathname !== ZAI_OAUTH_CALLBACK_PATH) {
      sendPage(response, 404, 'Not found', 'This listener only serves the GLM sign-in callback.')
      return
    }
    const providerError = url.searchParams.get('error_description') ?? url.searchParams.get('error')
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    // The console's own verdict ends the attempt: it will not send a code after
    // refusing one, so waiting longer would only burn the user's time.
    if (providerError !== null) {
      sendPage(response, 400, 'Authorization denied', 'Return to DSH for details.')
      finish(new Error(`Z.ai rejected the authorization: ${providerError.slice(0, 200)}`))
      return
    }
    // A missing code or a state this attempt never minted is *not* the console
    // answering — a wrong state is exactly what guessing the loopback port
    // looks like, and a prefetch or a port scan can produce a codeless hit.
    // Answering 400 and carrying on is what keeps a stranger on the port (or
    // the browser's own speculative request) from destroying a sign-in that is
    // still legitimately waiting; the attempt still ends on its own callback,
    // on a pasted code, on cancel, or on the timeout.
    if (code === null || code === '' || state !== expectedState) {
      sendPage(response, 400, 'Invalid callback', 'This request is not part of a sign-in attempt. Return to DSH.')
      return
    }
    sendPage(response, 200, 'Signed in', 'You can close this window and return to DSH.')
    finish(undefined, code)
  })

  let port: number
  try {
    port = await listen(server, preferredPort)
  } catch (error) {
    // The console takes the redirect URI from the authorization request rather
    // than matching a registered port, so an unusable preferred port is a retry
    // rather than a failure — and it genuinely happens: `EADDRINUSE` when the
    // port is taken, and `EACCES` on Windows when it falls inside a range
    // Hyper-V/WSL reserved (measured on a developer machine for this very port).
    // Only a failure to bind *anything* is fatal.
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EADDRINUSE' && code !== 'EACCES') {
      shutdown()
      throw error
    }
    port = await listen(server, 0).catch((retryError: unknown) => {
      shutdown()
      throw retryError
    })
  }

  return {
    port,
    waitForCode: () => codePromise,
    close: () => {
      // Closing before a code arrived is how a timeout or a cancel ends; the
      // waiter must settle or the flow would stay pending forever.
      finish(new Error('GLM sign-in was cancelled or timed out.'))
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Key provisioning                                                            */
/* -------------------------------------------------------------------------- */

/** Exchange the short-lived OAuth token for the business session token the key APIs take. */
async function businessLogin(
  oauthAccessToken: string,
  endpoints: ZaiOAuthEndpoints,
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<string> {
  const body = await requestJson(
    endpoints.businessLoginUrl,
    { method: 'POST', body: { token: oauthAccessToken } },
    fetchFn,
    signal,
  )
  const data = asRecord(unwrapEnvelope(body, 'business login'))
  const token = trimmedString(data?.access_token) ?? trimmedString(data?.accessToken)
  if (token === undefined) throw new Error('Z.ai business login returned no access token.')
  return token
}

/** Coerce an api-keys listing (bare array or a wrapped one) to an array. */
function asKeyArray(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter(isRecord)
  const record = asRecord(value)
  if (record === undefined) return []
  for (const field of ['list', 'keys', 'apiKeys', 'records', 'data']) {
    const candidate = record[field]
    if (Array.isArray(candidate)) return candidate.filter(isRecord)
  }
  return []
}

/**
 * Mint the durable Coding Plan key from a short-lived OAuth token.
 *
 * This is the console's own sequence: business login → resolve the default
 * organization/project → find or create the key this plugin names → read its
 * secret. The secret is always read through the copy endpoint because a listing
 * masks it (`*****abcd`) and the create response's inline secret is not
 * reliable across account states.
 *
 * An existing key of that name is reused rather than duplicated, which is what
 * makes signing in twice idempotent; it is never deleted, and the name is this
 * plugin's own so the official client's key is untouched.
 */
export async function mintApiKey(
  oauthAccessToken: string,
  options: { fetchFn?: typeof fetch; endpoints?: ZaiOAuthEndpoints; signal?: AbortSignal } = {},
): Promise<string> {
  const fetchFn = options.fetchFn ?? fetch
  const endpoints = options.endpoints ?? defaultOAuthEndpoints()
  const bizToken = await businessLogin(oauthAccessToken, endpoints, fetchFn, options.signal)
  const auth = { authorization: `Bearer ${bizToken}` }

  const customerBody = await requestJson(
    `${endpoints.bizBase}/api/biz/customer/getCustomerInfo`,
    { method: 'GET', headers: auth },
    fetchFn,
    options.signal,
  )
  const customer = asRecord(unwrapEnvelope(customerBody, 'customer lookup'))
  const organizations = Array.isArray(customer?.organizations) ? customer.organizations.filter(isRecord) : []
  const organization = organizations.find((entry) => entry.isDefault === true) ?? organizations[0]
  const projects = Array.isArray(organization?.projects) ? organization.projects.filter(isRecord) : []
  const project = projects.find((entry) => entry.isDefault === true) ?? projects[0]
  const organizationId = trimmedString(organization?.organizationId)
  const projectId = trimmedString(project?.projectId)
  if (organizationId === undefined || projectId === undefined) {
    throw new Error('This Z.ai account has no organization/project to mint a Coding Plan key on.')
  }

  const keysUrl = `${endpoints.bizBase}/api/biz/v1/organization/${organizationId}/projects/${projectId}/api_keys`
  const listedBody = await requestJson(keysUrl, { method: 'GET', headers: auth }, fetchFn, options.signal)
  const existing = asKeyArray(unwrapEnvelope(listedBody, 'api key list')).find((key) => key.name === endpoints.keyName)
  const created = existing ?? asRecord(unwrapEnvelope(
    await requestJson(keysUrl, { method: 'POST', headers: auth, body: { name: endpoints.keyName } }, fetchFn, options.signal),
    'api key create',
  ))
  const apiKeyId = trimmedString(created?.apiKey)
  if (apiKeyId === undefined) throw new Error('Z.ai key provisioning returned no key id.')

  const copiedBody = await requestJson(
    `${keysUrl}/copy/${encodeURIComponent(apiKeyId)}`,
    { method: 'GET', headers: auth },
    fetchFn,
    options.signal,
  )
  const copied = asRecord(unwrapEnvelope(copiedBody, 'api key copy'))
  const secretKey = trimmedString(copied?.secretKey)
  if (secretKey === undefined) throw new Error('Z.ai key provisioning returned no secret.')
  return `${apiKeyId}.${secretKey}`
}

/** Exchange an authorization code for the OAuth token, then mint the durable key. */
export async function exchangeAuthorizationCode(
  code: string,
  state: string,
  redirectUri: string,
  options: { fetchFn?: typeof fetch; endpoints?: ZaiOAuthEndpoints; signal?: AbortSignal } = {},
): Promise<ZaiAuthorization> {
  const fetchFn = options.fetchFn ?? fetch
  const endpoints = options.endpoints ?? defaultOAuthEndpoints()
  const body = await requestJson(
    endpoints.tokenUrl,
    // A non-standard body with no grant_type, matching the console's own call.
    { method: 'POST', body: { provider: 'zai', code, redirect_uri: redirectUri, state } },
    fetchFn,
    options.signal,
  )
  const data = asRecord(unwrapEnvelope(body, 'token exchange'))
  const zai = asRecord(data?.zai)
  const accessToken = trimmedString(zai?.access_token)
  if (accessToken === undefined) throw new Error('Z.ai token exchange returned no access token.')
  const user = asRecord(data?.user)
  const email = trimmedString(user?.email)
  const accountId = trimmedString(user?.id)
  const apiKey = await mintApiKey(accessToken, {
    fetchFn,
    endpoints,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  return {
    apiKey,
    ...(email === undefined ? {} : { email }),
    ...(accountId === undefined ? {} : { accountId }),
  }
}

/* -------------------------------------------------------------------------- */
/* The flow                                                                    */
/* -------------------------------------------------------------------------- */

/** Options one sign-in attempt accepts. */
export interface ZhipuBeginLoginOptions {
  fetchFn?: typeof fetch
  openBrowser?: (url: string) => void
  /** Test seam for the loopback port; production uses the console's usual one. */
  port?: number
  timeoutMs?: number
  endpoints?: ZaiOAuthEndpoints
  /** Called with the verified credential so a pool can keep every sign-in. */
  onSave?: (credentials: ZhipuCredentials) => Promise<unknown>
}

/**
 * Prove the minted key works before it is kept.
 *
 * Verification is the same read the paste-a-key route performs — the Coding
 * Plan's own model listing — so a key that authenticates nowhere is rejected
 * here with the console guidance the sibling path already gives, rather than
 * failing later inside a conversation. Doing this in the flow rather than in
 * the route is what lets the failure reach the polled flow status, where the
 * card can show it.
 */
async function persistVerifiedKey(
  store: FileCredentialStore,
  authorization: ZaiAuthorization,
  options: ZhipuBeginLoginOptions,
): Promise<void> {
  const fetchFn = options.fetchFn ?? fetch
  try {
    await verifyApiKey(authorization.apiKey, 'intl', { fetchFn })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `The signed-in Z.ai account cannot use the GLM Coding Plan: ${detail}`,
    )
  }
  const credentials: ZhipuCredentials = {
    apiKey: authorization.apiKey,
    region: 'intl',
    apiBase: apiBaseForRegion('intl'),
    authenticatedAt: Date.now(),
  }
  if (options.onSave === undefined) await store.write(credentials)
  else await options.onSave(credentials)
}

/**
 * Start the browser sign-in.
 *
 * Resolves immediately with the flow state the card polls; the browser round
 * trip, the key minting and the verification all happen in the background
 * exactly like the sibling lines, because the card cannot observe a browser it
 * does not control.
 */
export async function beginWebLogin(
  store: FileCredentialStore,
  options: ZhipuBeginLoginOptions = {},
): Promise<ZhipuLoginFlowStatus> {
  if (webLoginFlow.status === 'pending') return { ...webLoginFlow }

  const fetchFn = options.fetchFn ?? fetch
  const open = options.openBrowser ?? openBrowser
  const timeoutMs = options.timeoutMs ?? ZAI_OAUTH_TIMEOUT_MS
  const endpoints = options.endpoints ?? defaultOAuthEndpoints()
  const state = randomBytes(32).toString('base64url')

  let handle: CallbackHandle
  try {
    handle = await startCallbackServer(options.port ?? ZAI_OAUTH_CALLBACK_PORT, state)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    webLoginFlow = { status: 'error', completedAt: Date.now(), region: 'intl', error: message }
    return { ...webLoginFlow }
  }

  const redirectUri = `http://127.0.0.1:${handle.port}${ZAI_OAUTH_CALLBACK_PATH}`
  const authUrl = buildAuthorizeUrl({ redirectUri, state, endpoints })

  let settleCode: (code: string) => void = () => undefined
  const codePromise = new Promise<string>((resolve) => {
    settleCode = resolve
  })
  let settled = false
  const attempt: PendingAttempt = {
    state,
    redirectUri,
    submit: (code) => {
      if (settled) return
      settled = true
      settleCode(code)
    },
    cancel: (error) => {
      if (settled) return
      settled = true
      handle.close()
      pendingAttempt = null
      webLoginFlow = {
        ...webLoginFlow,
        status: 'error',
        completedAt: Date.now(),
        error: error.message,
      }
    },
  }
  pendingAttempt = attempt

  webLoginFlow = {
    status: 'pending',
    authUrl,
    startedAt: Date.now(),
    region: 'intl',
    progress: 'Waiting for browser authorization...',
  }

  // The loopback callback and a pasted code race each other; whichever arrives
  // first wins, and the loser's page/attempt is simply ignored.
  void handle.waitForCode().then(
    (code) => attempt.submit(code),
    (error: Error) => attempt.cancel(error),
  )

  void (async () => {
    const timer = setTimeout(() => attempt.cancel(new Error('GLM sign-in timed out.')), timeoutMs)
    timer.unref?.()
    try {
      const code = await codePromise
      if (code === '') throw new Error('The GLM sign-in did not return an authorization code.')
      webLoginFlow = { ...webLoginFlow, progress: 'Minting a Coding Plan key...' }
      const authorization = await exchangeAuthorizationCode(code, state, redirectUri, { fetchFn, endpoints })
      webLoginFlow = { ...webLoginFlow, progress: 'Verifying the key...' }
      await persistVerifiedKey(store, authorization, options)
      webLoginFlow = {
        ...webLoginFlow,
        status: 'complete',
        completedAt: Date.now(),
        progress: 'Signed in',
        ...(authorization.email === undefined ? {} : { email: authorization.email }),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A cancel already wrote the error state; do not overwrite its message.
      if (pendingAttempt === attempt) {
        webLoginFlow = {
          ...webLoginFlow,
          status: 'error',
          completedAt: Date.now(),
          error: message,
        }
      }
    } finally {
      clearTimeout(timer)
      handle.close()
      if (pendingAttempt === attempt) pendingAttempt = null
    }
  })()

  try {
    open(authUrl)
  } catch {
    // The card always renders the URL, so a failed launch is recoverable.
  }

  return { ...webLoginFlow }
}

/**
 * Finish a pending attempt with a code the user pasted.
 *
 * This is the recovery path for a browser that cannot reach this machine's
 * loopback port: the redirect fails, but the address bar still holds the code.
 */
export function submitLoginCode(raw: string): ZhipuLoginFlowStatus {
  const attempt = pendingAttempt
  if (attempt === null || webLoginFlow.status !== 'pending') {
    throw new Error('There is no GLM sign-in in progress to complete.')
  }
  const code = extractAuthorizationCode(raw)
  if (code === '') throw new Error('That does not look like an authorization code or redirect URL.')
  webLoginFlow = { ...webLoginFlow, progress: 'Completing sign-in...' }
  attempt.submit(code)
  return { ...webLoginFlow }
}
