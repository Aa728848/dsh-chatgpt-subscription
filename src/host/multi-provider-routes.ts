import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { ROUTE_PREFIX } from '../compat.ts'
import type { ApiEnvelope, CredentialStorageDto, PublicErrorDto } from '../shared/contracts.ts'
import { MultiProviderRuntime, SUBSCRIPTION_PROVIDER_IDS } from './multi-provider-runtime.ts'

const PREFIX = `${ROUTE_PREFIX}/providers`
const MAX_BODY_BYTES = 64 * 1024

export function registerMultiProviderRoutes(
  ctx: Context,
  runtime: MultiProviderRuntime,
  storage: Omit<CredentialStorageDto, 'available'>,
): () => void {
  const csrfToken = randomBytes(32).toString('base64url')
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://dsh.local')
    try {
      if (request.method === 'GET' && url.pathname === PREFIX) {
        response.setHeader('cache-control', 'no-store')
        json(response, { ok: true, value: { ...await publicSnapshot(runtime, storage), csrfToken } })
        return
      }
      if (request.method !== 'POST') {
        jsonError(response, 405, { code: 'bad-request', message: 'Method not allowed.' })
        return
      }
      if (!isSameOriginMutation(request) || !validCsrfToken(request, csrfToken)) {
        jsonError(response, 403, { code: 'csrf-rejected', message: 'Cross-origin request rejected.' })
        return
      }
      const body = await readJson(request)
      if (body === null) {
        jsonError(response, 400, { code: 'bad-request', message: 'A valid JSON object is required.' })
        return
      }
      const provider = optionalField(body, 'providerId')
      if (provider !== null && !SUBSCRIPTION_PROVIDER_IDS.includes(provider as never)) {
        throw new ProviderRouteError('bad-request', `Unknown provider: ${provider}`)
      }
      let value: unknown
      switch (url.pathname) {
        case `${PREFIX}/scan`:
          value = await runtime.scan(provider)
          break
        case `${PREFIX}/active-session`:
          value = await runtime.activeSession(requiredProvider(provider))
          break
        case `${PREFIX}/candidate/import`:
          value = await runtime.importCandidate(requiredProvider(provider), requiredField(body, 'candidateId'))
          break
        case `${PREFIX}/login/start`:
          value = publicAuthorization(await runtime.startAuthorization(requiredProvider(provider)))
          break
        case `${PREFIX}/login/poll`:
          value = publicAuthorization(await runtime.pollAuthorization(requiredProvider(provider), requiredField(body, 'sessionId')))
          break
        case `${PREFIX}/login/code`:
          value = publicAuthorization(await runtime.submitAuthorizationCode(
            requiredProvider(provider),
            requiredField(body, 'sessionId'),
            requiredField(body, 'code'),
          ))
          break
        case `${PREFIX}/login/cancel`:
          value = publicAuthorization(await runtime.cancelAuthorization(requiredProvider(provider), requiredField(body, 'sessionId')))
          break
        case `${PREFIX}/refresh`:
          value = await runtime.refresh(provider)
          break
        case `${PREFIX}/account/remove`:
          value = await runtime.removeAccount(requiredProvider(provider), requiredField(body, 'accountId'))
          break
        default:
          throw new ProviderRouteError('bad-request', 'Route not found.')
      }
      json(response, { ok: true, value: { result: sanitize(value), snapshot: await publicSnapshot(runtime, storage) } })
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        request.destroy()
        jsonError(response, 413, { code: 'bad-request', message: 'Request body is too large.' })
        return
      }
      const mapped = routeError(error)
      jsonError(response, mapped.code === 'bad-request' ? 400 : 502, mapped)
    }
  }
  return ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler })
}

async function publicSnapshot(
  runtime: MultiProviderRuntime,
  storage: Omit<CredentialStorageDto, 'available'>,
): Promise<Record<string, unknown>> {
  await runtime.init()
  const snapshot = runtime.snapshot()
  return {
    generatedAt: snapshot.generatedAt,
    providers: snapshot.providers.map((provider: {
      providerId: string
      manifest: { capabilities?: string[] }
      policy: string
      defaultAccountId?: string | null
      accounts: Array<Record<string, unknown>>
    }) => ({
      providerId: provider.providerId,
      displayName: runtime.providerName(provider.providerId),
      capabilities: provider.manifest.capabilities ?? [],
      policy: provider.policy,
      defaultAccountId: provider.defaultAccountId ?? null,
      accounts: provider.accounts.map(publicAccount),
      candidates: runtime.discoveredCandidates(provider.providerId).map((candidate) => ({
        candidateId: candidate.candidateId,
        accountId: candidate.accountId,
        displayName: candidate.displayName ?? null,
        email: maskEmail(typeof candidate.email === 'string' ? candidate.email : null),
        source: candidate.source ?? null,
        imported: candidate.imported === true,
      })),
    })),
    storage: { ...storage, available: true },
  }
}

function publicAccount(value: Record<string, unknown>): Record<string, unknown> {
  return {
    providerId: value.providerId,
    accountId: value.accountId,
    displayName: value.displayName ?? null,
    email: maskEmail(typeof value.email === 'string' ? value.email : null),
    subscription: sanitize(value.subscription),
    quota: sanitize(value.quota),
    refresh: sanitize(value.refresh),
    resources: sanitize(value.resources),
    health: sanitize(value.health),
  }
}

function publicAuthorization(value: Record<string, unknown>): Record<string, unknown> {
  return {
    status: value.status,
    ...(typeof value.providerId === 'string' ? { providerId: value.providerId } : {}),
    ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
    ...(typeof value.authorizationUrl === 'string' ? { authorizationUrl: value.authorizationUrl } : {}),
    ...(typeof value.instructions === 'string' ? { instructions: value.instructions } : {}),
    ...(value.browserOpened === true ? { browserOpened: true } : {}),
    ...(value.inputRequired === true ? { inputRequired: true } : {}),
    ...(value.authorizationCodeRequired === true ? { authorizationCodeRequired: true } : {}),
    ...(typeof value.diagnostic === 'string' ? { diagnostic: value.diagnostic } : {}),
    ...(Array.isArray(value.accounts) ? { accounts: value.accounts.map((account) => publicAccount(account as Record<string, unknown>)) } : {}),
  }
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize)
  if (typeof value !== 'object' || value === null) return value
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/token|secret|credential|api.?key/i.test(key) || /^(?:authorization|proxy-authorization)$/i.test(key)) continue
    result[key] = sanitize(entry)
  }
  return result
}

class RequestBodyTooLargeError extends Error {}

class ProviderRouteError extends Error {
  constructor(readonly code: PublicErrorDto['code'], message: string) {
    super(message)
  }
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/https?:\/\/[^\s]+/gi, '[redacted-url]')
    .replace(/((?:bearer|token|secret|authorization|code|verifier|client[_-]?secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/[A-Za-z]:\\[^\s]+|\/(?:[^\s\/]+\/){2,}[^\s]*/g, '[redacted-path]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}
function routeError(error: unknown): PublicErrorDto {
  if (error instanceof ProviderRouteError) return { code: error.code, message: redactDiagnostic(error.message) }
  const message = error instanceof Error ? redactDiagnostic(error.message) : 'Provider operation failed.'
  return { code: 'connection-failed', message }
}

function requiredProvider(provider: string | null): string {
  if (provider === null) throw new ProviderRouteError('bad-request', 'providerId is required.')
  return provider
}

function requiredField(body: Record<string, unknown>, name: string): string {
  const value = optionalField(body, name)
  if (value === null) throw new ProviderRouteError('bad-request', `${name} is required.`)
  return value
}

function optionalField(body: Record<string, unknown>, name: string): string | null {
  const value = body[name]
  return typeof value === 'string' && value !== '' ? value : null
}

function maskEmail(email: string | null): string | null {
  if (email === null) return null
  const at = email.indexOf('@')
  return at > 0 ? `${email.slice(0, 1)}***${email.slice(at)}` : '***'
}

function validCsrfToken(request: IncomingMessage, expected: string): boolean {
  const supplied = request.headers['x-dsh-csrf-token']
  if (typeof supplied !== 'string') return false
  const actual = Buffer.from(supplied)
  const wanted = Buffer.from(expected)
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}

function isSameOriginMutation(request: IncomingMessage): boolean {
  const host = request.headers.host
  const origin = request.headers.origin
  if (typeof host !== 'string' || typeof origin !== 'string') return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const contentType = request.headers['content-type']
  if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) return null
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += bytes.length
    if (total > MAX_BODY_BYTES) throw new RequestBodyTooLargeError()
    chunks.push(bytes)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

function json<T>(response: ServerResponse, envelope: ApiEnvelope<T>, status = 200): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(envelope))
}

function jsonError(response: ServerResponse, status: number, error: PublicErrorDto): void {
  json(response, { ok: false, error }, status)
}

function openSystemBrowserUnused(url: string): void {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
    if (process.platform === 'win32') {
      import('node:child_process').then(({ exec }) => {
        exec(`start "" "${url.replace(/"/g, '""')}"`, { shell: 'cmd.exe' })
      }).catch(() => undefined)
    } else if (process.platform === 'darwin') {
      import('node:child_process').then(({ exec }) => {
        exec(`open "${url.replace(/"/g, '\\"')}"`)
      }).catch(() => undefined)
    } else if (process.platform === 'linux') {
      import('node:child_process').then(({ exec }) => {
        exec(`xdg-open "${url.replace(/"/g, '\\"')}"`)
      }).catch(() => undefined)
    }
  } catch {
    // Ignore URL parse or exec errors
  }
}
