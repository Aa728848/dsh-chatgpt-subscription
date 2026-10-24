/**
 * The Cline Pass settings API.
 *
 * The surface is the same one every sibling line exposes — status, accounts,
 * models — plus the controls this line genuinely has: per-model upstream pins,
 * a channel probe/validate/test pair, the official quota reading and the
 * in-process request history.
 *
 * A status read never waits on Cline: it answers the cached quota snapshot and,
 * when that snapshot is missing or older than the line's TTL, schedules one
 * refresh behind the answer. The explicit refresh action still runs now, but
 * through the same single flight, so the two cannot fan out twice at once.
 *
 * @module dsh-chatgpt-subscription/cline-pass-routes
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isSameOriginMutation } from '../common/same-origin.ts'
import { QuotaRefresh } from '../common/quota-refresh.ts'
import { fetchUsageLimits } from './client.ts'
import { resolveModelInfo } from './catalog.ts'
import { pinWarnings, normalizePinMode } from './protocol.ts'
import type { ClinePassAccountPool } from './account-pool.ts'
import type { ClinePassEngine } from './engine.ts'
import type { ClinePassStore } from './store.ts'
import type { ClinePassLoginManager } from './oauth.ts'
import { bearerFor, listedClinePassCatalogModels, type ClinePassModelSettings, type ClinePassModelSettingsStore } from './token-store.ts'
import { DEFAULT_MODELS, PROVIDER_ID, defaultPin, type ClinePassPinSettings } from './types.ts'
import { openPlatformBrowser } from '../step-code/routes.ts'
import {
  CLINE_PASS_ROUTE_PREFIX,
  clinePassAccountQuota,
  clinePassWindowLabel,
  isClinePassPinMode,
  type ClinePassAccountAction,
  type ClinePassAuthResult,
  type ClinePassChannelVerdictDto,
  type ClinePassHistoryRowDto,
  type ClinePassLoginFlowDto,
  type ClinePassModelDto,
  type ClinePassPoolStatusDto,
  type ClinePassProbeResultDto,
  type ClinePassTestResultDto,
  type ClinePassUsageAccountDto,
  type ClinePassUsageDto,
  type ClinePassValidateResultDto,
  type ClinePassWebStatus,
} from '../../shared/cline-pass-contracts.ts'

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

function sendMethodNotAllowed(response: ServerResponse): void {
  sendJson(response, 405, { ok: false, error: 'Method not allowed.' })
}

async function readRequestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > 65_536) throw new Error('Request body is too large.')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Request body must be a JSON object.')
  }
  return parsed as Record<string, unknown>
}

function firstLine(value: unknown, max = 200): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

/**
 * How long a quota snapshot may answer a status read before it is re-read.
 *
 * The card polls status, so this is what keeps the meters moving without a
 * per-poll upstream call: a stale snapshot answers now and is replaced behind
 * the answer.
 */
export const CLINE_PASS_QUOTA_TTL_MS = 5 * 60 * 1000

/**
 * Whether the cached snapshot is too old to be trusted as the card's numbers.
 *
 * `fetchedAt` is 0 until the first read lands, which counts as stale on
 * purpose: a card with no numbers at all is the case that most needs the read.
 */
function usageStale(reading: ClinePassUsageDto, now: number, ttlMs: number): boolean {
  return reading.fetchedAt <= 0 || now - reading.fetchedAt > ttlMs
}

/** Whether one account can serve a request right now. */
function isUsable(account: { cooldownUntil?: number; authStatus?: string }, now: number): boolean {
  if (account.authStatus !== undefined && account.authStatus !== 'ok') return false
  if (typeof account.cooldownUntil === 'number' && account.cooldownUntil > now) return false
  return true
}

function formatModelCapacity(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return (tokens / 1_000_000) + 'M'
  if (tokens >= 1_000 && tokens % 1_000 === 0) return (tokens / 1_000) + 'k'
  return String(tokens)
}

function formatModelHint(contextWindow: number, input: readonly string[], reasoning: boolean): string {
  return formatModelCapacity(contextWindow) + ' · ' + input.join('+') + (reasoning ? ' · reasoning' : '')
}

function uniqueModels(settings: ClinePassModelSettings, _catalogIds: readonly string[] = []): string[] {
  const ids = new Set<string>(DEFAULT_MODELS)
  for (const model of listedClinePassCatalogModels(settings)) ids.add(model.id)
  return [...ids]
}

/** Every model the card should render, whether or not it is advertised. */
function projectModels(settings: ClinePassModelSettings, store: ClinePassStore): ClinePassModelDto[] {
  const known = uniqueModels(settings, store.catalog().ids)
  const hidden = new Set(settings.hiddenModels)
  const enabledSet = settings.enabledModelIds === null ? null : new Set(settings.enabledModelIds)
  return known.map((id) => {
    const meta = store.metaOf(id)
    const pin = settings.pins[id] ?? defaultPin(id)
    const base = resolveModelInfo(id, {
      displayName: 'Cline Pass',
      synced: settings.catalogModels,
      defaultContextWindow: settings.defaultContextWindow,
      defaultMaxTokens: settings.defaultMaxTokens,
    })
    const info = settings.contextWindowOverrides[id] === undefined ? base : resolveModelInfo(id, {
      displayName: 'Cline Pass',
      synced: settings.catalogModels,
      defaultContextWindow: settings.defaultContextWindow,
      defaultMaxTokens: settings.defaultMaxTokens,
      contextWindowOverride: settings.contextWindowOverrides[id],
    })
    const verdicts = Object.entries(meta.upstreamStatus ?? {})
      .map(([upstream, verdict]): ClinePassChannelVerdictDto => ({
        upstream,
        status: verdict.status,
        ms: Number(verdict.ms ?? 0),
        note: firstLine(verdict.note, 160),
        checkedAt: Number(verdict.checkedAt ?? 0),
      }))
      .sort((left, right) => (meta.upstreams ?? []).indexOf(left.upstream) - (meta.upstreams ?? []).indexOf(right.upstream))
    return {
      id,
      name: info.displayName,
      hint: formatModelHint(info.contextWindow, info.input, info.reasoning),
      contextWindow: info.contextWindow,
      defaultContextWindow: base.contextWindow,
      maxTokens: info.maxTokens,
      reasoning: info.reasoning,
      input: [...info.input],
      enabled: (enabledSet === null || enabledSet.has(id)) && !hidden.has(id),
      pipeline: String(meta.pipeline ?? ''),
      pinnable: meta.pinnable === true,
      pinned: pin.upstreams,
      excluded: pin.exclude,
      pinMode: normalizePinMode(pin.pinMode),
      sort: pin.sort,
      has: [...pin.has],
      upstreams: (meta.upstreams ?? []).map(String),
      upstreamStatus: verdicts,
      lastProvider: String(meta.lastProvider ?? ''),
      lastMs: Number(meta.lastMs ?? 0),
      probedAt: Number(meta.probedAt ?? 0),
      validatedAt: Number(meta.validatedAt ?? 0),
      ...(settings.contextWindowOverrides[id] === undefined ? {} : { contextWindowOverride: settings.contextWindowOverrides[id] }),
    }
  })
}

export interface ClinePassRouteOptions {
  settings: ClinePassModelSettingsStore
  accountPool: ClinePassAccountPool
  store: ClinePassStore
  engine: ClinePassEngine
  /** Proxy-aware fetch for account verification and quota reads. */
  fetchFn: typeof fetch
  /** Device-code sign-in state, when the composition installed one. */
  login?: ClinePassLoginManager
  /**
   * Browser opener for `/login/start`; defaults to a no-op because the settings
   * card opens the verification URL itself via `window.open`.
   */
  openBrowser?: (url: string) => void
  serving(): boolean
  conflict(): string | null
  /**
   * How old a cached quota snapshot may get before a status read refreshes it
   * behind the answer; defaults to {@link CLINE_PASS_QUOTA_TTL_MS}.
   */
  quotaTtlMs?: number
}

/** Named browser opener for deployments that want the host to launch the verification URL. */
export const openClinePassBrowser = openPlatformBrowser

/**
 * Assemble the whole status payload the Cline Pass tab renders.
 *
 * `quotaRefresh` is the single flight the caller refreshes through, when it has
 * one: passing it is what lets the answer say a refresh is still running behind
 * it. A caller that only reads (the management tools are one) omits it and gets
 * the cache alone, which keeps a tool call from spending the line's quota reads.
 */
export async function getClinePassWebStatus(
  options: ClinePassRouteOptions,
  quotaRefresh?: QuotaRefresh,
): Promise<ClinePassWebStatus> {
  const { settings: settingsStore, accountPool, store } = options
  const settings = await settingsStore.read().catch(() => settingsStore.status())
  const data = await accountPool.read().catch(() => null)
  const rawAccounts = await accountPool.listAccounts().catch(() => [])
  const usageByAccount = new Map(store.usage().accounts.map((entry) => [entry.accountId, entry]))
  const accounts = rawAccounts.map((account) => {
    const quota = account.quota ?? clinePassAccountQuota(usageByAccount.get(account.id))
    return quota === undefined ? account : { ...account, quota }
  })
  const now = Date.now()
  const pool: ClinePassPoolStatusDto = {
    accounts,
    rotationStrategy: data?.rotationStrategy ?? 'sequential',
    ...(data?.activeAccountId === undefined ? {} : { activeAccountId: data.activeAccountId }),
  }
  const models = projectModels(settings, store)
  const usable = accounts.some((account) => isUsable(account, now))
  // The composer badge reads `authenticated`; a disabled line must not leave a
  // badge up, even though its accounts are still usable.
  const authenticated = usable && settings.enabled
  return {
    enabled: settings.enabled,
    providerId: PROVIDER_ID,
    baseURL: settings.baseURL,
    serving: options.serving(),
    conflict: options.conflict(),
    exposeTools: settings.exposeTools,
    usable,
    authenticated,
    pool,
    models,
    catalogSynced: settings.catalogModels.length > 0,
    catalogCount: listedClinePassCatalogModels(settings).length,
    usage: store.usage().accounts.length === 0 ? null : store.usage(),
    // The snapshot above answered; a read it scheduled is still in flight, so the
    // card has a reason to come back for the numbers it is replacing.
    quotaRefreshing: quotaRefresh?.refreshing === true,
    historySize: store.historySize(),
    login: options.login?.current() ?? null,
    settings: {
      baseURL: settings.baseURL,
      defaultContextWindow: settings.defaultContextWindow,
      defaultMaxTokens: settings.defaultMaxTokens,
      maxConcurrentRequests: settings.maxConcurrentRequests,
      streamIdleTimeoutMs: settings.streamIdleTimeoutMs,
      historyLimit: settings.historyLimit,
      exposeCatalog: settings.exposeCatalog,
      pinSpelling: settings.pinSpelling,
    },
  }
}

/** Registry entry, as the client's route table documents it. */
const ROUTES = {
  status: 'GET',
  settings: 'POST',
  accounts: 'GET|POST',
  'login/start': 'POST',
  'login/status': 'GET',
  'login/cancel': 'POST',
  models: 'GET|POST',
  'models/pin': 'POST',
  'models/reset': 'POST',
  'models/probe': 'POST',
  'models/validate': 'POST',
  'models/test': 'POST',
  'models/visibility': 'POST',
  'models/visibility-all': 'POST',
  'models/context-window': 'POST',
  'catalog/refresh': 'POST',
  'catalog/search': 'GET',
  'catalog/add': 'POST',
  usage: 'GET|POST',
  history: 'GET',
} as const

/** The route table, exported so the client and this file can be checked against each other. */
export const CLINE_PASS_ROUTES = ROUTES

/**
 * Register the Cline Pass settings API under `/cline-pass/api`.
 *
 * Registered unconditionally: the card is how a user adds their first key, so
 * gating it on winning the route would leave a contested id with no way to
 * configure it at all.
 */
export function registerClinePassRoutes(ctx: Context, options: ClinePassRouteOptions): () => void {
  const { settings: settingsStore, accountPool, store, engine, fetchFn } = options
  // Default to a no-op opener: the settings card calls window.open itself, so
  // launching from the host as well would open two identical verification tabs.
  const openBrowser = options.openBrowser ?? (() => undefined)

  const quotaTtlMs = options.quotaTtlMs ?? CLINE_PASS_QUOTA_TTL_MS
  // One per registration: the refresh belongs to the line this route serves, and
  // the flag it reports must not leak between instances.
  const quotaRefresh = new QuotaRefresh()

  const emitModelsUpdated = (): void => {
    ctx.emit?.('llm/adapters-updated')
  }

  /** The full gateway catalog, cached only as the search index for manual add. */
  const searchCatalogIds = async (): Promise<string[]> => {
    const cached = store.catalog().ids
    if (cached.length > 0) return cached
    const gateway = await engine.gatewayCatalog()
    store.setCatalog({ ids: gateway, sources: ['gateway'], models: store.catalog().models })
    return gateway
  }

  /**
   * Read every usable account's official quota and replace the snapshot.
   *
   * Shared by the explicit refresh action and the background one a status read
   * schedules, so both fan out over the same accounts and write the same shape.
   * Null means no account can serve right now, which only the explicit action
   * reports: a background refresh has nobody to tell.
   */
  const refreshUsage = async (): Promise<ClinePassUsageDto | null> => {
    const data = await accountPool.read().catch(() => null)
    const enabled = (data?.accounts ?? []).filter((account) => isUsable(account, Date.now()))
    if (enabled.length === 0) return null
    const settings = await settingsStore.read()
    const readings: ClinePassUsageAccountDto[] = await Promise.all(enabled.map(async (account) => {
      const fetchedAt = Date.now()
      try {
        const credentials = await accountPool.getFreshCredential(account.id, fetchFn)
        const baseURL = credentials.baseURL && credentials.baseURL.trim() !== '' ? credentials.baseURL.trim() : settings.baseURL
        const result = await fetchUsageLimits({ fetchFn, baseURL, apiKey: bearerFor(credentials) })
        return {
          accountId: account.id,
          alias: account.alias,
          ok: result.ok,
          windows: result.limits.map((limit) => ({
            type: limit.type,
            label: clinePassWindowLabel(limit.type),
            percentUsed: limit.percentUsed,
            resetsAt: limit.resetsAt,
          })),
          error: result.error,
          fetchedAt,
        }
      } catch (error) {
        return {
          accountId: account.id,
          alias: account.alias,
          ok: false,
          windows: [],
          error: firstLine(error instanceof Error ? error.message : error, 240),
          fetchedAt,
        }
      }
    }))
    return store.setUsage({ accounts: readings })
  }

  const status = async (): Promise<ClinePassWebStatus> => await getClinePassWebStatus(options, quotaRefresh)

  return ctx.webServer.register({
    kind: 'prefix',
    path: CLINE_PASS_ROUTE_PREFIX,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url || '/', 'http://dsh.local')
      const path = url.pathname.replace(/^\/cline-pass\/api\/?/, '')
      const method = request.method ?? 'GET'
      try {
        if (path === '' || path === 'status') {
          // The card polls this, so the cached snapshot answers immediately and a
          // missing or aged one schedules the upstream read behind the answer.
          // `start` is the single-flight gate: repeated polls join the refresh
          // that is already running instead of fanning out one per poll. Only a
          // GET schedules it; this branch still answers every method with the
          // cache, so a POST here refreshes nothing.
          if (method === 'GET' && usageStale(store.usage(), Date.now(), quotaTtlMs)) {
            quotaRefresh.start(refreshUsage)
          }
          return sendJson(response, 200, { ok: true, value: await status() })
        }

        if (path === 'settings') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const body = await readRequestJson(request).catch((): Record<string, unknown> => ({}))
          const patch: Partial<ClinePassModelSettings> = {}
          if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
          if (typeof body.baseURL === 'string') {
            const baseURL = body.baseURL.trim()
            if (baseURL !== '' && !/^https?:\/\//i.test(baseURL)) return sendJson(response, 400, { ok: false, error: 'baseURL must be an http(s) URL.' })
            patch.baseURL = baseURL === '' ? 'https://api.cline.bot/api/v1' : baseURL
          }
          for (const key of ['defaultContextWindow', 'defaultMaxTokens', 'streamIdleTimeoutMs', 'historyLimit'] as const) {
            const value = body[key]
            if (value === undefined) continue
            if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
              return sendJson(response, 400, { ok: false, error: `${key} must be a positive integer.` })
            }
            patch[key] = value
          }
          if (body.maxConcurrentRequests !== undefined) {
            const value = body.maxConcurrentRequests
            if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
              return sendJson(response, 400, { ok: false, error: 'maxConcurrentRequests must be a non-negative integer.' })
            }
            patch.maxConcurrentRequests = value
          }
          if (typeof body.exposeCatalog === 'boolean') patch.exposeCatalog = body.exposeCatalog
          if (typeof body.exposeTools === 'boolean') patch.exposeTools = body.exposeTools
          if (typeof body.pinSpelling === 'string') patch.pinSpelling = body.pinSpelling === 'detected' ? 'detected' : 'both'
          let touched = false
          if (Object.keys(patch).length > 0) {
            await settingsStore.update(patch)
            if (patch.historyLimit !== undefined) store.setHistoryLimit(patch.historyLimit)
            touched = true
          }
          if (touched) emitModelsUpdated()
          return sendJson(response, 200, { ok: true, value: await settingsStore.read() })
        }

        if (path === 'accounts') {
          if (method === 'GET') return sendJson(response, 200, { ok: true, value: await status() })
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const body = await readRequestJson(request).catch((): Record<string, unknown> => ({}))
          const action = typeof body.action === 'string' ? body.action as ClinePassAccountAction : ''
          const accountId = typeof body.accountId === 'string' ? body.accountId : undefined
          try {
            if (action === 'add') {
              const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
              if (apiKey === '') return sendJson(response, 400, { ok: false, error: 'API key is required.' })
              const alias = typeof body.alias === 'string' && body.alias.trim() !== '' ? body.alias.trim() : undefined
              const baseURL = typeof body.baseURL === 'string' && body.baseURL.trim() !== '' ? body.baseURL.trim() : undefined
              await accountPool.addAccount({ apiKey, addedAt: Date.now(), ...(alias === undefined ? {} : { alias }), ...(baseURL === undefined ? {} : { baseURL }) }, alias)
            } else if (action === 'test') {
              const typed = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
              let key = typed
              let baseURL = typeof body.baseURL === 'string' && body.baseURL.trim() !== '' ? body.baseURL.trim() : undefined
              if (key === '' && accountId !== undefined) {
                const credentials = await accountPool.getFreshCredential(accountId, fetchFn)
                key = bearerFor(credentials)
                baseURL = credentials.baseURL ?? baseURL
              }
              if (key === '') return sendJson(response, 400, { ok: false, error: 'Provide an API key or a stored account to test.' })
              const advertised = projectModels(await settingsStore.read(), store).find((model) => model.enabled)
              const result = await engine.testAccount({ key, ...(baseURL === undefined ? {} : { baseURL }), model: advertised?.id ?? DEFAULT_MODELS[0] ?? 'cline-pass/glm-5.3-flash' })
              const value: ClinePassAuthResult = {
                ok: result.authorized,
                authorized: result.authorized,
                ms: result.ms,
                error: firstLine(result.error, 240),
              }
              return sendJson(response, 200, { ok: true, value })
            } else if (accountId === undefined) {
              return sendJson(response, 400, { ok: false, error: 'accountId is required.' })
            } else if (action === 'set-primary') {
              await accountPool.setPrimary(accountId)
            } else if (action === 'set-alias' && typeof body.alias === 'string') {
              await accountPool.setAlias(accountId, body.alias)
            } else if (action === 'delete') {
              await accountPool.deleteAccount(accountId)
            } else if (action === 'clear-cooldown') {
              await accountPool.clearCooldown(accountId)
            } else if (action === 'strategy'
              && (body.strategy === 'sequential' || body.strategy === 'round-robin' || body.strategy === 'sticky')) {
              await accountPool.setStrategy(body.strategy)
            } else {
              return sendJson(response, 400, { ok: false, error: 'Unsupported account action.' })
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return sendJson(response, 400, { ok: false, error: message })
          }
          return sendJson(response, 200, { ok: true, value: await status() })
        }

        if (path === 'login/start') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          if (options.login === undefined) return sendJson(response, 503, { ok: false, error: 'Cline sign-in is unavailable in this composition.' })
          try {
            const flow: ClinePassLoginFlowDto = await options.login.begin()
            if (flow.verificationUri !== '') openBrowser(flow.verificationUri)
            return sendJson(response, 200, { ok: true, value: flow })
          } catch (error) {
            return sendJson(response, 502, { ok: false, error: firstLine(error instanceof Error ? error.message : error, 300) })
          }
        }

        if (path === 'login/status') {
          if (method !== 'GET') return sendMethodNotAllowed(response)
          if (options.login === undefined) return sendJson(response, 503, { ok: false, error: 'Cline sign-in is unavailable in this composition.' })
          const id = url.searchParams.get('id') ?? ''
          if (id === '') return sendJson(response, 400, { ok: false, error: 'login id is required.' })
          try {
            const flow: ClinePassLoginFlowDto = await options.login.status(id)
            return sendJson(response, 200, { ok: true, value: flow })
          } catch (error) {
            return sendJson(response, 404, { ok: false, error: firstLine(error instanceof Error ? error.message : error, 300) })
          }
        }

        if (path === 'login/cancel') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          if (options.login === undefined) return sendJson(response, 503, { ok: false, error: 'Cline sign-in is unavailable in this composition.' })
          const body = await readRequestJson(request).catch((): Record<string, unknown> => ({}))
          const id = typeof body.id === 'string' ? body.id : ''
          if (id === '') return sendJson(response, 400, { ok: false, error: 'login id is required.' })
          return sendJson(response, 200, { ok: true, value: { cancelled: options.login.cancel(id) } })
        }

        if (path === 'models') {
          if (method === 'GET') {
            const current = await settingsStore.read()
            return sendJson(response, 200, { ok: true, value: { models: projectModels(current, store), enabledModelIds: current.enabledModelIds } })
          }
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const body = await readRequestJson(request).catch((): Record<string, unknown> => ({}))
          let touched = false
          if (body.enabledModelIds === null || Array.isArray(body.enabledModelIds)) {
            const ids = body.enabledModelIds === null
              ? null
              : body.enabledModelIds.filter((id): id is string => typeof id === 'string')
            await settingsStore.update({ enabledModelIds: ids })
            touched = true
          }
          if (typeof body.enabled === 'boolean') {
            await settingsStore.update({ enabled: body.enabled })
            touched = true
          }
          if (touched) emitModelsUpdated()
          return sendJson(response, 200, { ok: true, value: await status() })
        }

        if (path === 'models/pin') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const body = await readRequestJson(request).catch((): Record<string, unknown> => ({}))
          const model = typeof body.model === 'string' ? body.model.trim() : ''
          if (model === '') return sendJson(response, 400, { ok: false, error: 'this action needs a model id' })
          const current = (await settingsStore.read()).pins[model] ?? defaultPin(model)
          const next: ClinePassPinSettings = {
            upstreams: Array.isArray(body.upstreams) ? body.upstreams.map(String) : current.upstreams,
            exclude: Array.isArray(body.exclude) ? body.exclude.map(String) : current.exclude,
            pinMode: isClinePassPinMode(body.pinMode) ? body.pinMode : current.pinMode,
            sort: body.sort === undefined ? current.sort : (body.sort === 'none' ? '' : String(body.sort)),
            has: Array.isArray(body.has) ? body.has.map(String).map((name) => name.trim()).filter((name) => name !== '') : current.has,
          }
          await settingsStore.setPin(model, next)
          const meta = store.metaOf(model)
          const known = Array.isArray(meta.upstreams) ? meta.upstreams : []
          const warnings = [...pinWarnings({ upstream: next.upstreams[0] ?? null, excludeList: next.exclude }, meta)]
          const named = [...next.upstreams, ...next.exclude]
          if (named.length > 0) {
            if (known.length === 0) {
              warnings.push(`unverifiedChannel: this model has no discovered channel list yet, so ${named.join(', ')} cannot be checked — probe it first`)
            } else {
              const unknown = named.filter((name) => !known.includes(name))
              if (unknown.length > 0) warnings.push(`unknownChannel: ${unknown.join(', ')} is not in this model's discovered channel list (${known.join(', ')}); confirm with a test, because the gateway ignores a channel it cannot use rather than failing`)
            }
          }
          return sendJson(response, 200, { ok: true, value: { pin: next, warnings, status: await status() } })
        }

        if (path === 'models/reset') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const body = await readRequestJson(request).catch((): Record<string, unknown> => ({}))
          const model = typeof body.model === 'string' ? body.model.trim() : ''
          if (model === '') return sendJson(response, 400, { ok: false, error: 'this action needs a model id' })
          await settingsStore.clearPin(model)
          return sendJson(response, 200, { ok: true, value: { status: await status() } })
        }

        if (path === 'models/probe') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const body = await readRequestJson(request).catch((): Record<string, unknown> => ({}))
          const model = typeof body.model === 'string' ? body.model.trim() : ''
          if (model === '') return sendJson(response, 400, { ok: false, error: 'this action needs a model id' })
          const result = await engine.probe(model)
          const value: ClinePassProbeResultDto = {
            ok: result.ok,
            model,
            error: firstLine(result.error, 300),
            ms: result.ms,
            pipeline: result.pipeline,
            pinnable: result.pinnable,
            canonicalSlug: result.canonicalSlug,
            lastProvider: result.lastProvider,
            upstreams: result.upstreams,
            availableProviders: result.availableProviders,
            tier0: result.tier0,
            fingerprint: result.fingerprint,
            anonymous: result.anonymous,
          }
          return sendJson(response, 200, { ok: true, value: { result: value, status: await status() } })
        }

        if (path === 'models/validate') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const body = await readRequestJson(request).catch((): Record<string, unknown> => ({}))
          const model = typeof body.model === 'string' ? body.model.trim() : ''
          if (model === '') return sendJson(response, 400, { ok: false, error: 'this action needs a model id' })
          const meta = store.metaOf(model)
          if (!Array.isArray(meta.upstreams) || meta.upstreams.length === 0) {
            return sendJson(response, 400, { ok: false, error: 'no known channels yet: probe this model first' })
          }
          const outcome = await engine.validate(model)
          const value: ClinePassValidateResultDto = {
            ok: true,
            model,
            error: '',
            summary: outcome.summary,
            upstreams: (store.metaOf(model).upstreams ?? []).map(String),
            results: outcome.results.map((result) => ({ upstream: result.upstream, status: result.status, ms: result.ms, note: result.note })),
          }
          return sendJson(response, 200, { ok: true, value: { result: value, status: await status() } })
        }

        if (path === 'models/test') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const body = await readRequestJson(request).catch((): Record<string, unknown> => ({}))
          const model = typeof body.model === 'string' ? body.model.trim() : ''
          if (model === '') return sendJson(response, 400, { ok: false, error: 'this action needs a model id' })
          const result = await engine.test(model, {
            upstreams: Array.isArray(body.upstreams) ? body.upstreams.map(String) : undefined,
            exclude: Array.isArray(body.exclude) ? body.exclude.map(String) : undefined,
            has: Array.isArray(body.has) ? body.has.map(String).map((name) => name.trim()).filter((name) => name !== '') : undefined,
          })
          const value: ClinePassTestResultDto = {
            ok: result.ok,
            model,
            error: firstLine(result.error, 400),
            ms: result.ms,
            targets: result.targets,
            excluded: result.excluded,
            actual: result.actual,
            actualName: result.actualName,
            pipeline: result.pipeline,
            pinnable: result.pinnable,
            canonicalSlug: result.canonicalSlug,
            account: result.account,
            content: result.content,
            adopted: result.adopted,
            adherence: result.adherence,
            plan: firstLine(result.plan, 300),
            fingerprint: result.fingerprint,
            anonymous: result.anonymous,
            has: result.has,
            warnings: result.warnings,
            trace: result.trace,
          }
          return sendJson(response, 200, { ok: true, value: { result: value, status: await status() } })
        }

        if (path === 'models/visibility' || path === 'models/visibility-all') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const body = await readRequestJson(request).catch((): Record<string, unknown> => ({}))
          const current = await settingsStore.read()
          const known = uniqueModels(current, store.catalog().ids)
          const hidden = new Set(current.hiddenModels)
          if (path === 'models/visibility') {
            const model = typeof body.model === 'string' ? body.model.trim() : ''
            if (!known.includes(model)) return sendJson(response, 400, { ok: false, error: `${JSON.stringify(model)} is not one of this route's models` })
            if (body.visible === false) hidden.add(model)
            else hidden.delete(model)
          } else {
            const mode = body.mode
            if (mode !== 'all' && mode !== 'none' && mode !== 'invert') {
              return sendJson(response, 400, { ok: false, error: 'mode must be one of "all", "none" or "invert"' })
            }
          }
          const nextHidden = path === 'models/visibility-all'
            ? known.filter((id) => {
                const mode = body.mode
                const wasHidden = current.hiddenModels.includes(id)
                return mode === 'all' ? false : mode === 'none' ? true : !wasHidden
              })
            : [...hidden]
          await settingsStore.update({ hiddenModels: nextHidden })
          emitModelsUpdated()
          return sendJson(response, 200, { ok: true, value: await status() })
        }

        if (path === 'models/context-window') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const body = await readRequestJson(request).catch((): Record<string, unknown> => ({}))
          const model = typeof body.model === 'string' ? body.model.trim() : ''
          if (model === '') return sendJson(response, 400, { ok: false, error: 'this action needs a model id' })
          const value = body.contextWindow
          if (value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)) {
            return sendJson(response, 400, { ok: false, error: 'contextWindow must be a positive integer, or null to restore the default.' })
          }
          await settingsStore.setContextWindowOverride(model, value)
          emitModelsUpdated()
          return sendJson(response, 200, { ok: true, value: await status() })
        }

        if (path === 'catalog/search') {
          if (method !== 'GET') return sendMethodNotAllowed(response)
          const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()
          if (query === '') return sendJson(response, 200, { ok: true, value: { results: [] } })
          let ids: string[]
          try {
            ids = await searchCatalogIds()
          } catch (error) {
            return sendJson(response, 502, { ok: false, error: firstLine(error instanceof Error ? error.message : error, 240) })
          }
          const current = await settingsStore.read()
          const listed = new Set([...DEFAULT_MODELS, ...listedClinePassCatalogModels(current).map((entry) => entry.id)])
          const results = ids
            .filter((id) => id.toLowerCase().includes(query))
            .slice(0, 30)
            .map((id) => ({ id, added: listed.has(id) }))
          return sendJson(response, 200, { ok: true, value: { results } })
        }

        if (path === 'catalog/add') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const body = await readRequestJson(request).catch((): Record<string, unknown> => ({}))
          const model = typeof body.model === 'string' ? body.model.trim() : ''
          if (model === '') return sendJson(response, 400, { ok: false, error: 'this action needs a model id' })
          let ids: string[]
          try {
            ids = await searchCatalogIds()
          } catch (error) {
            return sendJson(response, 502, { ok: false, error: firstLine(error instanceof Error ? error.message : error, 240) })
          }
          if (!ids.includes(model)) return sendJson(response, 404, { ok: false, error: `${model} is not in the gateway catalog; refresh or search again.` })
          const current = await settingsStore.read()
          const exists = current.catalogModels.some((entry) => entry.id === model)
          const catalogModels = exists
            ? current.catalogModels.map((entry) => entry.id === model ? { ...entry, origin: 'custom' as const } : entry)
            : [...current.catalogModels, { id: model, origin: 'custom' as const }]
          const enabledModelIds = current.enabledModelIds === null ? null : [...new Set([...current.enabledModelIds, model])]
          const hiddenModels = current.hiddenModels.filter((id) => id !== model)
          await settingsStore.update({ catalogModels, enabledModelIds, hiddenModels })
          emitModelsUpdated()
          return sendJson(response, 200, { ok: true, value: { added: !exists, status: await status() } })
        }

        if (path === 'catalog/refresh') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const scan = await engine.officialModels()
          if (scan.models.length === 0) {
            return sendJson(response, 502, { ok: false, error: 'The official Cline Pass model list could not be read. Check the network or proxy, then sync again.' })
          }
          const current = await settingsStore.read()
          const existing = new Map(current.catalogModels.map((entry) => [entry.id, entry]))
          const added: string[] = []
          for (const id of scan.models) {
            if (existing.has(id)) continue
            added.push(id)
            const published = scan.catalog[id] ?? {}
            existing.set(id, {
              id,
              origin: 'official',
              ...(published.name === undefined ? {} : { name: published.name }),
              ...(published.contextWindow === undefined ? {} : { contextWindow: published.contextWindow }),
              ...(published.maxTokens === undefined ? {} : { maxTokens: published.maxTokens }),
              ...(published.reasoning === undefined ? {} : { reasoning: published.reasoning }),
              ...(published.input === undefined && published.inputModalities === undefined
                ? {}
                : { input: published.input ?? published.inputModalities }),
              ...(published.efforts === undefined ? {} : { efforts: published.efforts }),
            })
          }
          // The full gateway list is only a search index, never a settings
          // catalog page. Fetch it even when the legacy exposeCatalog flag is
          // set, but do not merge its hundreds of ids into catalogModels.
          const gateway = await engine.gatewayCatalog().catch(() => [])
          await settingsStore.storeCatalog([...existing.values()])
          store.setCatalog({
            ids: [...new Set([...scan.models, ...gateway])],
            sources: [...scan.sources, ...(gateway.length > 0 ? ['gateway'] : [])],
            models: scan.catalog as Record<string, unknown>,
          })
          emitModelsUpdated()
          return sendJson(response, 200, { ok: true, value: { added, sources: scan.sources, status: await status() } })
        }

        if (path === 'usage') {
          if (method === 'GET') {
            return sendJson(response, 200, { ok: true, value: store.usage() })
          }
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          // The explicit action refreshes through the same bookkeeping a status
          // read uses, but the two do not exclude each other: `run` awaits its own
          // call and never consults `pending`, so a click that lands while a
          // background refresh is in flight still fans out a second round.
          // Deliberately left that way — both rounds write the same shape, the
          // later `setUsage` is the one that stays, and the cost is a single extra
          // upstream request. Real joining means giving `QuotaRefresh` a `wait`
          // that every line sharing it would have to adopt, so it is not a change
          // this route can make on its own.
          const outcome: { reading: ClinePassUsageDto | null; cause: unknown } = { reading: null, cause: null }
          await quotaRefresh.run(async () => {
            try {
              outcome.reading = await refreshUsage()
            } catch (error) {
              // `run` reports a failure through `lastError` rather than throwing,
              // but this route answers the caller in its own envelope: keep the
              // reason and re-throw so the response is the 500 it always was.
              outcome.cause = error
              throw error
            }
          })
          if (outcome.cause !== null) throw outcome.cause
          const reading = outcome.reading
          if (reading === null) {
            return sendJson(response, 400, { ok: false, error: 'Every Cline Pass account is disabled, cooling down, or unusable. Enable one first.' })
          }
          return sendJson(response, 200, { ok: true, value: { usage: reading, status: await status() } })
        }

        if (path === 'history') {
          if (method !== 'GET') return sendMethodNotAllowed(response)
          const limitParam = Number(url.searchParams.get('limit') ?? '')
          const limit = Number.isSafeInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 25
          const model = url.searchParams.get('model') ?? ''
          const entries: ClinePassHistoryRowDto[] = store.readHistory(limit, model).map((entry) => ({
            ts: entry.ts,
            model: entry.model,
            provider: entry.provider,
            canonical: entry.canonical,
            account: entry.account,
            ms: entry.ms,
            ttfb: entry.ttfb,
            ttft: entry.ttft,
            stream: entry.stream,
            effort: entry.effort,
            usageReported: entry.usage !== null && entry.usage !== undefined,
            usage: {
              inputTokens: Number(entry.usage?.inputTokens ?? 0),
              outputTokens: Number(entry.usage?.outputTokens ?? 0),
              cacheReadTokens: Number(entry.usage?.cacheReadTokens ?? 0),
              reasoningTokens: Number(entry.usage?.reasoningTokens ?? 0),
            },
            error: entry.error,
            attempts: entry.attempts,
            adherence: entry.adherence,
            fingerprint: entry.fingerprint,
            anonymous: entry.anonymous,
            warnings: entry.warnings,
          }))
          return sendJson(response, 200, { ok: true, value: { total: store.historySize(), entries } })
        }

        return sendJson(response, 404, { ok: false, error: 'not-found' })
      } catch (error) {
        // The last line of defence: anything that still throws is reported as the
        // reason it is, in the same envelope every branch uses.
        const message = error instanceof Error ? error.message : String(error)
        return sendJson(response, 500, { ok: false, error: message })
      }
    },
  })
}
