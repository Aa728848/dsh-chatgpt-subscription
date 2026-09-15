import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { URL, URLSearchParams } from 'node:url'
import {
  CALLBACK_ALLOWED_ORIGINS,
  CALLBACK_COMPLETE_PATH,
  CALLBACK_LANDING_GRACE_MS,
  CALLBACK_MAX_BYTES,
  CALLBACK_PATH,
  CALLBACK_PORT_ATTEMPTS,
  DEFAULT_CALLBACK_PORT,
  LOGIN_TIMEOUT_MS,
  STUDIO_CALLBACK_PARAM,
  STUDIO_PATH,
  studioBaseUrl,
} from './types.ts'
import { FileCredentialStore, type CommandCodeCredentials } from './token-store.ts'
import { verifyApiKey } from './client.ts'
import type { CommandCodeAccount } from '../../shared/command-code-contracts.ts'

export type CommandCodeLoginStatus = 'idle' | 'pending' | 'complete' | 'error'

export interface CommandCodeLoginFlowState {
  status: CommandCodeLoginStatus
  authUrl?: string
  startedAt?: number
  completedAt?: number
  progress?: string
  account?: CommandCodeAccount
  error?: string
}

/** Credential body the studio POSTs back to the loopback callback. */
export interface CommandCodeCallbackCredentials {
  apiKey: string
  state: string
  userId: string
  userName: string
  keyName: string
}

let webLoginFlow: CommandCodeLoginFlowState = { status: 'idle' }

export function getWebLoginStatus(): CommandCodeLoginFlowState {
  return { ...webLoginFlow }
}

/** Reset the flow so a cancelled attempt cannot keep a later one from starting. */
export function resetWebLogin(): void {
  webLoginFlow = { status: 'idle' }
}

export function openBrowser(url: string): void {
  try {
    if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref()
    } else if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', `"${url}"`], {
        stdio: 'ignore',
        detached: true,
        windowsVerbatimArguments: true,
      }).on('error', () => undefined).unref()
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref()
    }
  } catch {
    // Best effort: the caller always shows the URL so a failed launch is recoverable.
  }
}

/** Browser sign-in URL; identical shape to the official CLI's. */
export function buildAuthUrl(input: { port: number; state: string }): string {
  const callback = `http://127.0.0.1:${input.port}${CALLBACK_PATH}`
  const params = new URLSearchParams({
    [STUDIO_CALLBACK_PARAM]: callback,
    state: input.state,
    mode: 'redirect',
  })
  return `${studioBaseUrl()}${STUDIO_PATH}?${params.toString()}`
}

/** State token the studio must echo back; 32 random bytes, base64url. */
export function generateState(): string {
  return randomBytes(32).toString('base64url')
}

function checkPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, '127.0.0.1')
  })
}

/**
 * First free loopback port in the CLI's probe range.
 *
 * The studio receives the port in the callback URL, so any free port works;
 * starting at the CLI's own default keeps behavior identical on a machine where
 * a server-side allowlist is ever introduced.
 */
export async function findAvailablePort(
  start = DEFAULT_CALLBACK_PORT,
  attempts = CALLBACK_PORT_ATTEMPTS,
): Promise<number> {
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = start + offset
    if (await checkPortAvailable(port)) return port
  }
  throw new Error(`No free local port for the Command Code sign-in callback (tried ${attempts} ports from ${start}).`)
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function page(title: string, message: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>`
    + '<body style="font-family:system-ui;padding:40px;text-align:center;">'
    + `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`
}

function corsOrigin(request: IncomingMessage): string {
  const origin = request.headers.origin
  return origin && (CALLBACK_ALLOWED_ORIGINS as readonly string[]).includes(origin)
    ? origin
    : CALLBACK_ALLOWED_ORIGINS[0]
}

function applyCors(request: IncomingMessage, response: ServerResponse): void {
  response.setHeader('Access-Control-Allow-Origin', corsOrigin(request))
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function sendHtml(response: ServerResponse, status: number, html: string, after?: () => void): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'close',
  })
  response.end(html, () => after?.())
}

function readBody(request: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    const declared = Number(request.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      resolve(null)
      request.destroy()
      return
    }
    request.on('data', (chunk: Buffer) => {
      if (over) return
      size += chunk.length
      if (size > limit) {
        over = true
        resolve(null)
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks).toString('utf8'))
    })
    request.on('error', () => {
      if (!over) resolve(null)
    })
  })
}

function fieldsFromPayload(raw: string, contentType: string): Record<string, string> {
  if (contentType === 'application/x-www-form-urlencoded') {
    return Object.fromEntries(new URLSearchParams(raw).entries())
  }
  const parsed = JSON.parse(raw) as unknown
  if (typeof parsed !== 'object' || parsed === null) throw new Error('invalid callback payload')
  const record = parsed as Record<string, unknown>
  const fields: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') fields[key] = value
  }
  return fields
}

export interface CommandCodeAuthServerHandle {
  server: Server
  port: number
  /** Resolves once the studio has posted a credential (or rejects on denial). */
  waitForCredentials: () => Promise<CommandCodeCallbackCredentials>
  close: () => void
}

/**
 * One-shot loopback server the Command Code studio page posts the freshly
 * minted API key to.
 *
 * The contract is the official CLI's, because the studio page is the same
 * client: the browser POSTs `{apiKey,state,userId,userName,keyName}` as JSON or
 * form data from `https://commandcode.ai`, so the endpoint must answer the
 * cross-origin preflight (including Chrome's private-network request header)
 * and then redirect the tab to a human-readable completion page.
 *
 * @param port - loopback port to bind; the caller resolved a free one.
 * @param expectedState - state token the studio must echo back.
 * @param options - landing grace and clock seams for tests.
 */
export function createAuthServer(
  port: number,
  expectedState: string,
  options: { landingGraceMs?: number } = {},
): Promise<CommandCodeAuthServerHandle> {
  const landingGraceMs = options.landingGraceMs ?? CALLBACK_LANDING_GRACE_MS

  return new Promise((resolve, reject) => {
    let settleCredentials: (value: CommandCodeCallbackCredentials) => void
    let failCredentials: (error: Error) => void
    const credentialPromise = new Promise<CommandCodeCallbackCredentials>((res, rej) => {
      settleCredentials = res
      failCredentials = rej
    })
    credentialPromise.catch(() => undefined)

    /** Credential that landed but is waiting for the browser tab to arrive. */
    let landed: CommandCodeCallbackCredentials | null = null
    let graceTimer: NodeJS.Timeout | null = null
    let closed = false
    let settled = false

    const server = createServer((request, response) => {
      void handle(request, response)
    })

    const shutdown = (): void => {
      if (graceTimer !== null) {
        clearTimeout(graceTimer)
        graceTimer = null
      }
      if (closed) return
      closed = true
      server.closeIdleConnections?.()
      server.closeAllConnections?.()
      server.close()
    }

    const publish = (): void => {
      if (landed === null) return
      const value = landed
      landed = null
      settled = true
      settleCredentials(value)
      shutdown()
    }

    const deny = (error: Error): void => {
      if (settled) return
      settled = true
      failCredentials(error)
      shutdown()
    }

    async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
      let url: URL
      try {
        url = new URL(request.url ?? '/', 'http://127.0.0.1')
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ success: false, error: 'Bad request' }))
        return
      }
      applyCors(request, response)
      response.setHeader('content-type', 'application/json')

      if (request.method === 'OPTIONS') {
        if (request.headers['access-control-request-private-network'] === 'true') {
          response.setHeader('Access-Control-Allow-Private-Network', 'true')
        }
        response.writeHead(204)
        response.end()
        return
      }

      if (request.method === 'GET' && url.pathname === CALLBACK_COMPLETE_PATH) {
        if (url.searchParams.get('state') !== expectedState) {
          sendHtml(response, 403, page('Invalid state token', 'The state token did not match this sign-in attempt. Return to DSH and restart sign-in.'))
          return
        }
        if (landed === null) {
          sendHtml(response, 404, page('Return to DSH', 'This page completes sign-in automatically. Restart sign-in from DSH if you reached it directly.'))
          return
        }
        sendHtml(response, 200, page('Sign in successful', 'You can close this window and return to DSH.'), publish)
        return
      }

      if (url.pathname !== CALLBACK_PATH) {
        response.writeHead(404)
        response.end(JSON.stringify({ success: false, error: 'Not found' }))
        return
      }

      if (request.method === 'GET') {
        response.writeHead(405, { Allow: 'POST, OPTIONS', 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end(page('Return to DSH', 'This page completes sign-in automatically. Restart sign-in from DSH if you reached it directly.'))
        return
      }

      if (request.method !== 'POST') {
        response.writeHead(405, { Allow: 'POST, OPTIONS' })
        response.end(JSON.stringify({ success: false, error: 'Method not allowed. Use POST.' }))
        return
      }

      const contentType = (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
      if (contentType !== 'application/json' && contentType !== 'application/x-www-form-urlencoded') {
        response.writeHead(415, { connection: 'close', 'content-type': 'application/json' })
        response.end(JSON.stringify({ success: false, error: 'Unsupported content type' }))
        return
      }

      const raw = await readBody(request, CALLBACK_MAX_BYTES)
      if (raw === null) {
        response.writeHead(413, { connection: 'close', 'content-type': 'application/json' })
        response.end(JSON.stringify({ success: false, error: 'Payload too large' }))
        return
      }

      let fields: Record<string, string>
      try {
        fields = fieldsFromPayload(raw, contentType)
      } catch {
        sendJson(response, 400, { success: false, error: 'Invalid JSON' })
        return
      }

      if (fields.error) {
        if (fields.state !== expectedState) {
          sendJson(response, 403, { success: false, error: 'Invalid state token' })
          return
        }
        const message = fields.error_description || fields.error
        sendHtml(
          response,
          200,
          page(fields.error === 'access_denied' ? 'Authorization denied' : 'Authentication failed', message),
          () => deny(new Error(message)),
        )
        return
      }

      const apiKey = fields.apiKey
      if (!apiKey) {
        sendJson(response, 400, { success: false, error: 'Missing required fields' })
        return
      }
      if (fields.state !== expectedState) {
        sendJson(response, 403, { success: false, error: 'Invalid state token' })
        return
      }

      landed = {
        apiKey,
        state: fields.state,
        userId: fields.userId ?? '',
        userName: fields.userName ?? '',
        keyName: fields.keyName ?? '',
      }
      // The tab is redirected to the completion page, so the credential waits a
      // moment instead of racing that navigation to a closed server.
      graceTimer = setTimeout(publish, landingGraceMs)
      graceTimer.unref?.()
      response.writeHead(303, {
        Location: `${CALLBACK_COMPLETE_PATH}?state=${encodeURIComponent(expectedState)}`,
        'cache-control': 'no-store',
        'content-length': '0',
        connection: 'close',
      })
      response.end()
    }

    server.on('error', (error) => reject(error))
    server.keepAliveTimeout = 1
    server.headersTimeout = 5_000
    server.listen(port, '127.0.0.1', () => {
      resolve({
        server,
        port,
        waitForCredentials: () => credentialPromise,
        close: () => {
          // Closing before a credential landed is how a timed-out or
          // abandoned attempt ends; the waiter must settle, or the flow would
          // stay "pending" and block every later sign-in.
          if (!settled) deny(new Error('Command Code sign-in was cancelled or timed out.'))
          shutdown()
        },
      })
    })
  })
}

/**
 * Start the browser sign-in.
 *
 * Resolves immediately with the flow state the settings card polls; the
 * credential is validated against `/alpha/whoami` and persisted in the
 * background, exactly like the manual key path, so a key that cannot
 * authenticate is never stored.
 */
export async function beginWebLogin(
  store: FileCredentialStore,
  options: { fetchFn?: typeof fetch; openBrowser?: (url: string) => void; timeoutMs?: number } = {},
): Promise<CommandCodeLoginFlowState> {
  if (webLoginFlow.status === 'pending') return { ...webLoginFlow }

  const fetchFn = options.fetchFn ?? fetch
  const open = options.openBrowser ?? openBrowser
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS
  const state = generateState()
  const port = await findAvailablePort()
  const handle = await createAuthServer(port, state)
  const authUrl = buildAuthUrl({ port, state })

  webLoginFlow = {
    status: 'pending',
    authUrl,
    startedAt: Date.now(),
    progress: 'Waiting for browser authorization...',
  }

  const timer = setTimeout(() => handle.close(), timeoutMs)
  timer.unref?.()

  void (async () => {
    try {
      const credential = await handle.waitForCredentials()
      if (credential.state !== state) throw new Error('Command Code sign-in state mismatch')
      webLoginFlow = { ...webLoginFlow, progress: 'Verifying the API key...' }
      const account = await verifyApiKey(credential.apiKey, { fetchFn })
      const stored: CommandCodeCredentials = {
        apiKey: credential.apiKey,
        userId: credential.userId || account.userId || undefined,
        userName: credential.userName || account.userName || undefined,
        keyName: credential.keyName || account.keyName || undefined,
        email: account.email ?? undefined,
        organizationName: account.organizationName ?? undefined,
        planLabel: account.planLabel ?? undefined,
        planId: account.planId ?? undefined,
        authenticatedAt: Date.now(),
      }
      await store.write(stored)
      webLoginFlow = {
        status: 'complete',
        authUrl,
        startedAt: webLoginFlow.startedAt,
        completedAt: Date.now(),
        progress: 'Signed in',
        account: { ...account, authenticatedAt: stored.authenticatedAt ?? null },
      }
    } catch (error) {
      webLoginFlow = {
        status: 'error',
        authUrl,
        startedAt: webLoginFlow.startedAt,
        completedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      clearTimeout(timer)
      handle.close()
    }
  })()

  try {
    open(authUrl)
  } catch {
    // The settings card always renders the URL, so a failed launch is recoverable.
  }

  return { ...webLoginFlow }
}

/**
 * Persist a manually entered API key after proving it authenticates.
 *
 * Manual entry is the recovery path when the browser flow is unavailable
 * (headless host, blocked popup, or a key minted in Command Code Studio).
 */
export async function saveApiKey(
  store: FileCredentialStore,
  apiKey: string,
  options: { fetchFn?: typeof fetch } = {},
): Promise<CommandCodeAccount> {
  const trimmed = apiKey.trim()
  if (trimmed === '') throw new Error('The API key is empty.')
  const account = await verifyApiKey(trimmed, { fetchFn: options.fetchFn })
  await store.write({
    apiKey: trimmed,
    userId: account.userId ?? undefined,
    userName: account.userName ?? undefined,
    keyName: account.keyName ?? undefined,
    email: account.email ?? undefined,
    organizationName: account.organizationName ?? undefined,
    planLabel: account.planLabel ?? undefined,
    planId: account.planId ?? undefined,
    authenticatedAt: Date.now(),
  })
  return account
}

/** Stable per-attempt id the settings card can correlate; kept for symmetry with other routes. */
export function newLoginAttemptId(): string {
  return randomUUID()
}
