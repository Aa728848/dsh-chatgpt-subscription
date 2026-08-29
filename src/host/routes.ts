import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { ROUTE_PREFIX } from '../compat.ts'
import type { ApiEnvelope, LoginEventDto, ProviderCatalogGroupDto, PublicErrorDto, SubscriptionPreferencesUpdateDto } from '../shared/contracts.ts'
import { GPT_56_MAX_CONTEXT_WINDOW, isCodexModelId, isConfigurableContextModelId } from '../shared/model-catalog.ts'
import { SUBAGENT_MAX_DEPTH_LIMIT } from '../shared/preferences.ts'
import { OAuthService, publicError } from './oauth-service.ts'
import { PreferenceError, type SubscriptionPreferenceStore } from './preferences.ts'
import { UsageService, UsageServiceError } from './usage-service.ts'

const MAX_BODY_BYTES = 64 * 1024

export function registerRoutes(ctx: Context, oauth: OAuthService, usage: UsageService, preferences: SubscriptionPreferenceStore): () => void {
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://dsh.local')
    if (request.method === 'GET' && url.pathname === `${ROUTE_PREFIX}/status`) {
      const oauthStatus = await oauth.status()
      const allProviders = await listAllProviderGroups(ctx)
      json(response, { ok: true, value: {
        ...oauthStatus,
        quota: await usage.status(oauthStatus.authenticated),
        preferences: preferences.status(),
        allProviders,
      } })
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
        case `${ROUTE_PREFIX}/logout`:
          await oauth.logout()
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
        case `${ROUTE_PREFIX}/preferences/update`:
          json(response, { ok: true, value: await preferences.update(readPreferencesUpdate(body, preferences.status())) })
          return
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

function isSameOriginMutation(request: IncomingMessage): boolean {
  const host = request.headers.host
  const origin = request.headers.origin
  if (typeof host !== 'string' || host === '' || typeof origin !== 'string' || origin === '') return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
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
  if ('visibleModelIds' in value) {
    if (!Array.isArray(value.visibleModelIds) || value.visibleModelIds.length === 0 || !value.visibleModelIds.every(isCodexModelId)) throw new PreferenceError('visibleModelIds must contain at least one supported Codex model.')
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
  if ('searchProvider' in value) {
    if (value.searchProvider !== 'dsh' && value.searchProvider !== 'codex') throw new PreferenceError('searchProvider must be dsh or codex.')
    patch.searchProvider = value.searchProvider
  }
  if ('contextWindowOverrides' in value) {
    if (!isRecord(value.contextWindowOverrides)) throw new PreferenceError('contextWindowOverrides must be an object.')
    const overrides: NonNullable<SubscriptionPreferencesUpdateDto['contextWindowOverrides']> = {}
    for (const [model, contextWindow] of Object.entries(value.contextWindowOverrides)) {
      if (!isConfigurableContextModelId(model)) throw new PreferenceError('Only GPT-5.6 context windows can be changed.')
      if (!Number.isSafeInteger(contextWindow) || (contextWindow as number) < 1 || (contextWindow as number) > GPT_56_MAX_CONTEXT_WINDOW) {
        throw new PreferenceError(`contextWindowOverrides.${model} must be a positive integer no greater than the provider limit.`)
      }
      overrides[model] = contextWindow as number
    }
    patch.contextWindowOverrides = overrides
  }
  if ('subagentReasoningEffort' in value) {
    if (value.subagentReasoningEffort !== null && (typeof value.subagentReasoningEffort !== 'string' || value.subagentReasoningEffort === '')) throw new PreferenceError('subagentReasoningEffort must be null or a non-empty string.')
    patch.subagentReasoningEffort = value.subagentReasoningEffort
  }
  if ('subagentContextWindow' in value) {
    if (value.subagentContextWindow !== null && (!Number.isSafeInteger(value.subagentContextWindow) || (value.subagentContextWindow as number) < 1)) throw new PreferenceError('subagentContextWindow must be null or a positive integer.')
    patch.subagentContextWindow = value.subagentContextWindow as number | null
  }
  if ('subagentMaxDepth' in value) {
    if (value.subagentMaxDepth !== null && (!Number.isSafeInteger(value.subagentMaxDepth) || (value.subagentMaxDepth as number) < 0 || (value.subagentMaxDepth as number) > SUBAGENT_MAX_DEPTH_LIMIT)) {
      throw new PreferenceError(`subagentMaxDepth must be null or an integer from 0 to ${SUBAGENT_MAX_DEPTH_LIMIT}.`)
    }
    patch.subagentMaxDepth = value.subagentMaxDepth as number | null
  }
  if ('subagentModelEfforts' in value) {
    if (!isRecord(value.subagentModelEfforts)) throw new PreferenceError('subagentModelEfforts must be an object.')
    const efforts: Record<string, string | null> = {}
    for (const [key, effort] of Object.entries(value.subagentModelEfforts)) {
      if (effort !== null && (typeof effort !== 'string' || effort === '')) throw new PreferenceError(`subagentModelEfforts.${key} must be a non-empty string or null.`)
      efforts[key] = effort
    }
    patch.subagentModelEfforts = efforts
  }
  return patch
}

async function listAllProviderGroups(ctx: Context): Promise<ProviderCatalogGroupDto[]> {
  try {
    const providers = ctx.llm?.listProviders?.() ?? []
    const groups: ProviderCatalogGroupDto[] = []
    for (const provider of providers) {
      try {
        const models = await ctx.llm?.listModels?.(provider.id) ?? []
        const modelEntries = []
        for (const model of models) {
          try {
            const resolved = await ctx.llm?.resolveModelInfo?.(provider.id, model.id)
            const efforts = resolved?.reasoning?.efforts?.map(e => String(e.id)) ?? []
            modelEntries.push({
              id: model.id,
              name: model.name ?? model.id,
              reasoningEfforts: efforts,
            })
          } catch {
            modelEntries.push({
              id: model.id,
              name: model.name ?? model.id,
              reasoningEfforts: [],
            })
          }
        }
        if (modelEntries.length > 0) {
          groups.push({
            id: provider.id,
            name: provider.name ?? provider.id,
            models: modelEntries,
          })
        }
      } catch {
        // Skip provider if failed
      }
    }
    return groups
  } catch {
    return []
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

function statusFor(error: PublicErrorDto): number {
  if (error.code === 'csrf-rejected') return 403
  if (error.code === 'not-authenticated') return 401
  if (error.code === 'rate-limited') return 429
  if (error.code === 'login-active') return 409
  if (error.code === 'bad-request') return 400
  return 502
}
