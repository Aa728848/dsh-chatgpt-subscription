import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { URL, URLSearchParams } from 'node:url'
import {
  AUTH_URL,
  DEFAULT_CLIENT_ID,
  DEFAULT_CLIENT_SECRET,
  OAUTH_CALLBACK_TIMEOUT_MS,
  REDIRECT_PATH,
  SCOPES,
  TOKEN_URL,
} from './types.ts'
import { FileCredentialStore, type AntigravityCredentials } from './token-store.ts'
import { loadCodeAssist } from './client.ts'

export interface WebLoginFlowState {
  status: 'idle' | 'pending' | 'complete' | 'error'
  authUrl?: string
  startedAt?: number
  completedAt?: number
  email?: string
  error?: string
}

let webLoginFlow: WebLoginFlowState = { status: 'idle' }

function antigravityEnv(namePart: string): string | undefined {
  const full = `DSH_ANTIGRAVITY_${namePart}`
  return process.env[full]
}

export function callbackPort(): number {
  const configured = Number(antigravityEnv('CALLBACK_PORT'))
  if (Number.isInteger(configured) && configured > 0 && configured <= 65535) {
    return configured
  }
  return 51121
}

export function resolveCallbackHost(raw = antigravityEnv('CALLBACK_HOST')): string {
  const host = (raw || 'localhost').trim().toLowerCase()
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return host
  return 'localhost'
}

export function redirectUri(): string {
  const host = resolveCallbackHost()
  const port = callbackPort()
  const path = REDIRECT_PATH.startsWith('/') ? REDIRECT_PATH : `/${REDIRECT_PATH}`
  return `http://${host}:${port}${path}`
}

export function clientId(): string {
  return antigravityEnv('CLIENT_ID')?.trim() || DEFAULT_CLIENT_ID
}

export function clientSecret(): string {
  return antigravityEnv('CLIENT_SECRET')?.trim() || DEFAULT_CLIENT_SECRET
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url')
}

export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function sanitizeOAuthProviderError(text: string): string {
  return escapeHtml(text.slice(0, 300).replace(/[\r\n\t]+/g, ' '))
}

export function openBrowser(url: string): void {
  try {
    if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true })
    } else if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true })
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true })
    }
  } catch {
    // 尽力拉起浏览器即可
  }
}

export async function getUserEmail(token: string): Promise<string | undefined> {
  try {
    const response = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok) return undefined
    const data = await response.json() as Record<string, unknown>
    return typeof data.email === 'string' ? data.email : undefined
  } catch {
    return undefined
  }
}

export function startCallbackServer(expectedState: string): Promise<{
  server: Server
  waitForCode: () => Promise<{ code: string; state: string }>
}> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timeout: NodeJS.Timeout | undefined
    let resolveCode: (val: { code: string; state: string }) => void
    let rejectCode: (err: Error) => void

    const codePromise = new Promise<{ code: string; state: string }>((res, rej) => {
      resolveCode = res
      rejectCode = rej
    })

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      fn()
    }

    const callbackUrl = redirectUri()
    const server = createServer((request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('Method Not Allowed')
        return
      }
      const url = new URL(request.url || '', callbackUrl)
      if (url.pathname !== REDIRECT_PATH) {
        response.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end('Antigravity OAuth callback route not found.')
        return
      }

      const providerError = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')

      if (providerError) {
        const safe = escapeHtml(providerError.slice(0, 200))
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(`Antigravity authentication failed: ${safe}`)
        finish(() => rejectCode(new Error(`OAuth error: ${providerError.slice(0, 200)}`)))
        return
      }

      if (!code || !state) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end('Antigravity authentication failed: missing code or state.')
        finish(() => rejectCode(new Error('Missing code or state in OAuth callback')))
        return
      }

      if (state !== expectedState) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end('Antigravity authentication failed: invalid state.')
        finish(() => rejectCode(new Error('OAuth state mismatch')))
        return
      }

      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end('Antigravity authentication complete. You can close this window and return to DSH.')
      finish(() => resolveCode({ code, state }))
    })

    server.on('error', reject)
    server.listen(callbackPort(), resolveCallbackHost(), () => {
      timeout = setTimeout(() => {
        finish(() => rejectCode(new Error('OAuth callback timed out waiting for browser login')))
        server.close()
      }, OAUTH_CALLBACK_TIMEOUT_MS)
      resolve({ server, waitForCode: () => codePromise })
    })
  })
}

export async function exchangeOAuthCode(
  code: string,
  verifier: string,
  callbackUrl: string,
): Promise<AntigravityCredentials> {
  const tokenResponse = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      code,
      grant_type: 'authorization_code',
      redirect_uri: callbackUrl,
      code_verifier: verifier,
    }).toString(),
  })

  if (!tokenResponse.ok) {
    throw new Error(`Token exchange failed: ${sanitizeOAuthProviderError(await tokenResponse.text())}`)
  }

  const tokenData = (await tokenResponse.json()) as Record<string, unknown>
  const refreshToken = typeof tokenData.refresh_token === 'string' ? tokenData.refresh_token : undefined
  const accessToken = typeof tokenData.access_token === 'string' ? tokenData.access_token : ''
  const expiresIn = typeof tokenData.expires_in === 'number' ? tokenData.expires_in : 3600

  if (!refreshToken) {
    throw new Error('No refresh token received. Re-run login and allow offline access.')
  }

  const [email, discoveredProject] = await Promise.all([
    getUserEmail(accessToken),
    loadCodeAssist(accessToken).catch(() => undefined),
  ])

  return {
    refresh: refreshToken,
    refresh_token: refreshToken,
    access: accessToken,
    access_token: accessToken,
    expires: Date.now() + expiresIn * 1000 - 5 * 60 * 1000,
    expires_at: Date.now() + expiresIn * 1000 - 5 * 60 * 1000,
    projectId: discoveredProject || undefined,
    email,
  }
}

export async function beginWebLogin(store: FileCredentialStore): Promise<WebLoginFlowState> {
  if (webLoginFlow.status === 'pending') {
    return { ...webLoginFlow }
  }

  const { verifier, challenge } = generatePKCE()
  const state = base64Url(randomBytes(32))
  const { server, waitForCode } = await startCallbackServer(state)
  const callbackUrl = redirectUri()
  const authParams = new URLSearchParams({
    client_id: clientId(),
    response_type: 'code',
    redirect_uri: callbackUrl,
    scope: SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'consent',
  })

  const authUrl = `${AUTH_URL}?${authParams.toString()}`
  webLoginFlow = {
    status: 'pending',
    authUrl,
    startedAt: Date.now(),
    error: undefined,
  }

  void (async () => {
    try {
      const { code, state: returnedState } = await waitForCode()
      if (returnedState !== state) throw new Error('OAuth state mismatch')
      const credentials = await exchangeOAuthCode(code, verifier, callbackUrl)
      await store.write(credentials)
      webLoginFlow.status = 'complete'
      webLoginFlow.email = credentials.email
      webLoginFlow.completedAt = Date.now()
    } catch (error) {
      webLoginFlow.status = 'error'
      webLoginFlow.error = error instanceof Error ? error.message : String(error)
      webLoginFlow.completedAt = Date.now()
    } finally {
      server.close()
    }
  })()

  return { ...webLoginFlow }
}

export function getWebLoginStatus(): WebLoginFlowState {
  return { ...webLoginFlow }
}

export async function refreshAntigravityToken(credentials: AntigravityCredentials): Promise<AntigravityCredentials> {
  const refreshToken = credentials.refresh || credentials.refresh_token
  if (!refreshToken) throw new Error('Missing Antigravity refresh token.')

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  })

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${sanitizeOAuthProviderError(await response.text())}`)
  }

  const data = (await response.json()) as Record<string, unknown>
  const accessToken = typeof data.access_token === 'string' ? data.access_token : ''
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600
  const nextRefreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : refreshToken

  return {
    ...credentials,
    refresh: nextRefreshToken,
    refresh_token: nextRefreshToken,
    access: accessToken,
    access_token: accessToken,
    expires: Date.now() + expiresIn * 1000 - 5 * 60 * 1000,
    expires_at: Date.now() + expiresIn * 1000 - 5 * 60 * 1000,
  }
}

export async function ensureApiKey(store: FileCredentialStore): Promise<{ token: string; projectId?: string }> {
  let credentials = await store.read()
  if (!credentials) {
    throw new Error('Not logged into Antigravity. Please log in from Settings > Antigravity.')
  }

  const expires = credentials.expires || credentials.expires_at || 0
  const token = credentials.access || credentials.access_token

  if (!token || expires <= Date.now() + 60_000) {
    credentials = await refreshAntigravityToken(credentials)
    await store.write(credentials)
  }

  return {
    token: (credentials.access || credentials.access_token)!,
    projectId: credentials.projectId,
  }
}

export async function loginAndSave(
  store: FileCredentialStore,
  signal?: AbortSignal,
  onUrl?: (url: string) => void,
): Promise<AntigravityCredentials> {
  const { verifier, challenge } = generatePKCE()
  const state = base64Url(randomBytes(32))
  const { server, waitForCode } = await startCallbackServer(state)
  const callbackUrl = redirectUri()
  const authParams = new URLSearchParams({
    client_id: clientId(),
    response_type: 'code',
    redirect_uri: callbackUrl,
    scope: SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'consent',
  })
  const authUrl = `${AUTH_URL}?${authParams.toString()}`

  try {
    if (onUrl) onUrl(authUrl)
    openBrowser(authUrl)

    if (signal?.aborted) throw new Error('OAuth login aborted')
    const { code, state: returnedState } = await waitForCode()
    if (returnedState !== state) throw new Error('OAuth state mismatch')

    const credentials = await exchangeOAuthCode(code, verifier, callbackUrl)
    await store.write(credentials)
    return credentials
  } finally {
    server.close()
  }
}
