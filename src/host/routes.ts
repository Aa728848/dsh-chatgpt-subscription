import type { IncomingMessage, ServerResponse } from 'node:http'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { ROUTE_PREFIX } from '../compat.ts'
import type {
  ApiEnvelope,
  LoginEventDto,
  PublicErrorDto,
  SubagentRouteAuditDto,
  SubscriptionPreferencesUpdateDto,
} from '../shared/contracts.ts'
import { contextWindowLimitForModel, isCodexModelId } from '../shared/model-catalog.ts'
import { isCodexReasoningSummary } from '../shared/preferences.ts'
import type { CodexAccountPool } from './codex-account-pool.ts'
import { isSameOriginMutation } from './common/same-origin.ts'
import { OAuthService, publicError } from './oauth-service.ts'
import { PreferenceError, type SubscriptionPreferenceStore } from './preferences.ts'
import type { ProxyManager } from './proxy-manager.ts'
import type { SearchProviderSwitcher } from './search-provider-switcher.ts'
import { UsageService, UsageServiceError } from './usage-service.ts'

const MAX_BODY_BYTES = 64 * 1024

/** Read-only audit provider the optional route serves. */
export type RouteAuditReader = (sessionId: string) => Promise<SubagentRouteAuditDto>

export function registerRoutes(
  ctx: Context,
  oauth: OAuthService,
  usage: UsageService,
  preferences: SubscriptionPreferenceStore,
  proxyManager?: ProxyManager,
  searchSwitcher?: SearchProviderSwitcher,
  routeAudit?: RouteAuditReader,
  accountPool?: CodexAccountPool,
): () => void {
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://dsh.local')
    if (request.method === 'GET' && url.pathname === `${ROUTE_PREFIX}/status`) {
      const oauthStatus = await oauth.status()
      // The card answers from an existing snapshot and refreshes behind it, so
      // opening a tab never waits on the upstream quota request;
      // `quotaRefreshing` is what tells the client to ask again when that
      // refresh lands.
      const quota = await usage.status(oauthStatus.authenticated, false, { backgroundRefresh: true })
      json(response, { ok: true, value: {
        ...oauthStatus,
        quota,
        quotaRefreshing: usage.refreshing,
        preferences: preferences.status(),
        detectedProxy: proxyManager?.getSystemProxy() ?? null,
        activeProxy: proxyManager?.resolveActiveProxyUrl() ?? null,
        switcher: searchSwitcher?.status() ?? null,
      } })
      return
    }
    if (request.method === 'GET' && url.pathname === `${ROUTE_PREFIX}/subagent-route-audit`) {
      const sessionId = url.searchParams.get('sessionId')
      if (sessionId === null || sessionId.length === 0) {
        jsonError(response, 400, { code: 'bad-request', message: 'A sessionId query parameter is required.' })
        return
      }
      if (routeAudit === undefined) {
        jsonError(response, 404, { code: 'route-audit-failed', message: 'Subagent route audit is not installed.' })
        return
      }
      try {
        json(response, { ok: true, value: await routeAudit(sessionId) })
      } catch (error) {
        jsonError(response, 500, publicError(
          error instanceof Error ? error : new Error('The route audit failed.'),
          'route-audit-failed',
        ))
      }
      return
    }
    if (request.method === 'GET' && url.pathname === `${ROUTE_PREFIX}/mermaid.min.js`) {
      try {
        const requireFn = createRequire(import.meta.url)
        const mermaidPath = requireFn.resolve('mermaid/dist/mermaid.min.js')
        response.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
        })
        fs.createReadStream(mermaidPath).pipe(response)
      } catch {
        response.writeHead(404, { 'Content-Type': 'text/plain' })
        response.end('Not found')
      }
      return
    }
    if (request.method !== 'POST') {
      jsonError(response, 405, { code: 'bad-request', message: 'Method not allowed.' })
      return
    }
    if (!isSameOriginMutation(request)) {
      jsonError(response, 403, { code: 'csrf-rejected', message: 'Cross-origin request rejected.' })
      return
    }
    const contentType = request.headers['content-type']
    if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
      jsonError(response, 415, { code: 'bad-request', message: 'A JSON request body is required.' })
      return
    }
    const body = await readJson(request)
    if (body === null) {
      jsonError(response, 400, { code: 'bad-request', message: 'Malformed JSON request.' })
      return
    }
    try {
      switch (url.pathname) {
        case `${ROUTE_PREFIX}/login/start`:
          json(response, { ok: true, value: await oauth.startLogin() })
          return
        case `${ROUTE_PREFIX}/login/cancel`: {
          const loginId = field(body, 'loginId')
          if (loginId === null) throw new Error('missing loginId')
          oauth.cancelLogin(loginId)
          json(response, { ok: true, value: { cancelled: true } })
          return
        }
        case `${ROUTE_PREFIX}/accounts`: {
          if (accountPool === undefined) throw new Error('The ChatGPT account pool is not installed.')
          const action = field(body, 'action')
          const accountId = field(body, 'accountId')
          const alias = field(body, 'alias')
          if (action === 'set-primary' && accountId !== null) {
            await accountPool.setPrimary(accountId)
          } else if (action === 'set-alias' && accountId !== null && alias !== null) {
            await accountPool.setAlias(accountId, alias)
          } else if (action === 'delete' && accountId !== null) {
            await accountPool.deleteAccount(accountId)
          } else if (action === 'clear-cooldown' && accountId !== null) {
            await accountPool.clearCooldown(accountId)
          } else if (action === 'strategy'
            && (body.strategy === 'sequential' || body.strategy === 'round-robin' || body.strategy === 'sticky')) {
            await accountPool.setStrategy(body.strategy)
          } else if (action === 'relogin' && accountId !== null) {
            // Nothing is deleted: the account keeps its alias and position, and
            // signing into it again clears the failure marker.
            await accountPool.clearAuthFailed(accountId)
          }
          const afterAction = await oauth.status()
          json(response, { ok: true, value: {
            ...afterAction,
            quota: await usage.status(afterAction.authenticated),
            preferences: preferences.status(),
          } })
          return
        }
        case `${ROUTE_PREFIX}/logout`:
          // An explicit accountId removes that pooled account; without one the
          // account that would serve the next request goes, and the pool
          // promotes another, which is what the single button means to a user.
          await oauth.logout(field(body, 'accountId') ?? undefined)
          usage.clear()
          json(response, { ok: true, value: { authenticated: false } })
          return
        case `${ROUTE_PREFIX}/token/refresh`: {
          const oauthStatus = await oauth.refresh()
          json(response, { ok: true, value: {
            ...oauthStatus,
            quota: await usage.status(oauthStatus.authenticated),
            preferences: preferences.status(),
          } })
          return
        }
        case `${ROUTE_PREFIX}/quota/refresh`: {
          const oauthStatus = await oauth.status()
          if (!oauthStatus.authenticated) throw new Error('not authenticated')
          json(response, { ok: true, value: await usage.status(true, true) })
          return
        }
        case `${ROUTE_PREFIX}/quota/reset-credit/use`: {
          const oauthStatus = await oauth.status()
          if (!oauthStatus.authenticated) throw new Error('not authenticated')
          json(response, { ok: true, value: await usage.consumeResetCredit() })
          return
        }
        case `${ROUTE_PREFIX}/connection/test`:
          json(response, { ok: true, value: await usage.testConnection() })
          return
        case `${ROUTE_PREFIX}/preferences/update`: {
          const patch = readPreferencesUpdate(body, preferences.status())
          const value = await preferences.update(patch)
          // A context window is part of the resolved model info the harness
          // caches, so changing one has to invalidate the adapter directory too.
          if (patch.visibleModelIds !== undefined || patch.enabled !== undefined || patch.contextWindowOverrides !== undefined) {
            ctx.emit?.('llm/adapters-updated')
          }
          json(response, { ok: true, value })
          return
        }
        default:
          jsonError(response, 404, { code: 'bad-request', message: 'Route not found.' })
      }
    } catch (error) {
      const mapped = error instanceof UsageServiceError
        ? error.publicError
        : error instanceof PreferenceError
          ? { code: 'bad-request' as const, message: error.message }
        : publicError(error, error instanceof Error && error.message === 'missing loginId'
          ? 'bad-request'
          : error instanceof Error && error.message === 'not authenticated'
            ? 'not-authenticated'
            : 'internal')
      jsonError(response, statusFor(mapped), mapped)
    }
  }

  const events = (request: IncomingMessage, response: ServerResponse): void => {
    if (request.method !== 'GET') {
      response.writeHead(405)
      response.end()
      return
    }
    const url = new URL(request.url ?? '/', 'http://dsh.local')
    const loginId = url.searchParams.get('loginId')
    if (loginId === null || loginId === '') {
      jsonError(response, 400, { code: 'bad-request', message: 'loginId is required.' })
      return
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
    })
    response.write('retry: 1000\n\n')
    let terminal = false
    let heartbeat: NodeJS.Timeout | undefined
    let unsubscribe: (() => void) | null = null
    const cleanup = (): void => {
      if (heartbeat !== undefined) clearInterval(heartbeat)
      unsubscribe?.()
      unsubscribe = null
    }
    const send = (event: LoginEventDto): void => {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      if (event.type !== 'pending') {
        terminal = true
        queueMicrotask(() => {
          cleanup()
          response.end()
        })
      }
    }
    unsubscribe = oauth.subscribe(loginId, send)
    if (unsubscribe === null) {
      response.end('event: failed\ndata: {"type":"failed","error":{"code":"bad-request","message":"Unknown loginId."}}\n\n')
      return
    }
    if (terminal) {
      unsubscribe()
      response.end()
      return
    }
    heartbeat = setInterval(() => response.write(': ping\n\n'), 15_000)
    request.once('close', cleanup)
  }

  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/login/events`, handler: events }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += buffer.length
    if (total > MAX_BODY_BYTES) return null
    chunks.push(buffer)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function field(value: Record<string, unknown>, name: string): string | null {
  const candidate = value[name]
  return typeof candidate === 'string' && candidate !== '' ? candidate : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readPreferencesUpdate(value: Record<string, unknown>, current: ReturnType<SubscriptionPreferenceStore['status']>): SubscriptionPreferencesUpdateDto {
  const patch: SubscriptionPreferencesUpdateDto = {}
  if ('enabled' in value) {
    if (typeof value.enabled !== 'boolean') throw new PreferenceError('enabled must be a boolean.')
    patch.enabled = value.enabled
  }
  if ('visibleModelIds' in value) {
    if (!Array.isArray(value.visibleModelIds) || !value.visibleModelIds.every(isCodexModelId)) throw new PreferenceError('visibleModelIds must be an array of supported Codex models.')
    patch.visibleModelIds = [...new Set(value.visibleModelIds)]
  }
  if ('quickQuotaVisible' in value) {
    if (typeof value.quickQuotaVisible !== 'boolean') throw new PreferenceError('quickQuotaVisible must be a boolean.')
    patch.quickQuotaVisible = value.quickQuotaVisible
  }
  if ('fastMode' in value) {
    if (typeof value.fastMode !== 'boolean') throw new PreferenceError('fastMode must be a boolean.')
    patch.fastMode = value.fastMode
  }
  if ('outputVerbosity' in value) {
    if (value.outputVerbosity !== null && value.outputVerbosity !== 'low' && value.outputVerbosity !== 'medium' && value.outputVerbosity !== 'high') throw new PreferenceError('outputVerbosity must be null, low, medium, or high.')
    patch.outputVerbosity = value.outputVerbosity
  }
  if ('reasoningSummary' in value) {
    if (value.reasoningSummary !== null && !isCodexReasoningSummary(value.reasoningSummary)) throw new PreferenceError('reasoningSummary must be null, auto, concise, detailed, or none.')
    patch.reasoningSummary = value.reasoningSummary
  }
  if ('searchProvider' in value) {
    if (value.searchProvider !== 'dsh' && value.searchProvider !== 'codex') throw new PreferenceError('searchProvider must be dsh or codex.')
    patch.searchProvider = value.searchProvider
  }
  if ('contextWindowOverrides' in value) {
    if (!isRecord(value.contextWindowOverrides)) throw new PreferenceError('contextWindowOverrides must be an object.')
    const overrides: NonNullable<SubscriptionPreferencesUpdateDto['contextWindowOverrides']> = {}
    for (const [model, contextWindow] of Object.entries(value.contextWindowOverrides)) {
      if (!isCodexModelId(model)) throw new PreferenceError('Unknown Codex model for a context window override.')
      if (contextWindow === null) {
        overrides[model] = null
        continue
      }
      if (!Number.isSafeInteger(contextWindow) || (contextWindow as number) < 1 || (contextWindow as number) > contextWindowLimitForModel(model)) {
        throw new PreferenceError(`contextWindowOverrides.${model} must be a positive integer no greater than the provider limit, or null to restore the default.`)
      }
      overrides[model] = contextWindow as number
    }
    patch.contextWindowOverrides = overrides
  }
  if ('proxyMode' in value) {
    if (value.proxyMode !== 'auto' && value.proxyMode !== 'custom' && value.proxyMode !== 'direct') {
      throw new PreferenceError('proxyMode must be auto, custom, or direct.')
    }
    patch.proxyMode = value.proxyMode
  }
  if ('customProxyUrl' in value) {
    if (value.customProxyUrl !== null && typeof value.customProxyUrl !== 'string') {
      throw new PreferenceError('customProxyUrl must be a string or null.')
    }
    patch.customProxyUrl = value.customProxyUrl
  }
  return patch
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

function statusFor(error: PublicErrorDto): number {
  if (error.code === 'csrf-rejected') return 403
  if (error.code === 'not-authenticated') return 401
  if (error.code === 'rate-limited') return 429
  if (error.code === 'login-active') return 409
  if (error.code === 'bad-request') return 400
  return 502
}
