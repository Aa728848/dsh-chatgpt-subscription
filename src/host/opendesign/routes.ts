/**
 * The OpenDesign settings API.
 *
 * The surface is the one every sibling line exposes — status, accounts, models —
 * plus the controls this line genuinely has: device-authorization sign-in, an
 * explicit catalog sync, and the plan/credit read an OAuth account's control
 * key can make (`/wallet/balance` and `/billing/summary`).
 *
 * Reads never trigger an upstream call; the catalog is synced by its own action
 * and behind a successful sign-in, and plan/credits are refreshed by the usage
 * action (the settings card fires it once when it opens).
 *
 * @module dsh-chatgpt-subscription/opendesign-routes
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isSameOriginMutation } from '../common/same-origin.ts'
import {
  fetchBillingSummary,
  fetchCodingPlanUsage,
  fetchControlPlaneCatalog,
  fetchGatewayCatalog,
  fetchWalletBalance,
  fetchWorkspaceId,
  testApiKey,
  type OpenDesignWorkspaceIdRead,
} from './client.ts'
import { isModelServed, resolveModelInfo } from './catalog.ts'
import type { OpenDesignAccountPool } from './account-pool.ts'
import {
  bearerFor,
  controlKeyFor,
  isOpenDesignOAuthCredentials,
  type OpenDesignModelSettings,
  type OpenDesignModelSettingsStore,
} from './token-store.ts'
import { DEFAULT_BASE_URL, PROVIDER_ID, type OpenDesignDiscoveredModel } from './types.ts'
import { openDesignKnownModelIds, openDesignVisibleModelIds } from './line.ts'
import type { OpenDesignLoginManager } from './oauth.ts'
import { openPlatformBrowser } from '../step-code/routes.ts'
import {
  OPENDESIGN_ROUTE_PREFIX,
  type OpenDesignAccountAction,
  type OpenDesignAuthResult,
  type OpenDesignCodingPlanDto,
  type OpenDesignLoginFlowDto,
  type OpenDesignModelDto,
  type OpenDesignPoolStatusDto,
  type OpenDesignUsageAccountDto,
  type OpenDesignUsageDto,
  type OpenDesignWebStatus,
} from '../../shared/opendesign-contracts.ts'

/**
 * Accounts one catalog sync asks at most.
 *
 * Each account costs up to two upstream reads, so this is what stands between a
 * twenty-key pool and forty requests behind one button. It bounds the SCAN, not
 * the pool: an account beyond the cap contributes nothing to the union, because
 * the cap is a hard bound on the measurement rather than a rotating window.
 */
const MAX_SYNC_ACCOUNTS = 8

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

/** Whether one account can serve a request right now. */
function isUsable(account: { cooldownUntil?: number; authStatus?: string }, now: number): boolean {
  if (account.authStatus !== undefined && account.authStatus !== 'ok') return false
  if (typeof account.cooldownUntil === 'number' && account.cooldownUntil > now) return false
  return true
}

/**
 * Capacity the way a model card reads it.
 *
 * Vendor windows are rarely round: 1,048,576 and 262,144 are binary multiples,
 * and printing them raw turns a hint line into a digit soup. One decimal is
 * enough to tell 1M from 1.05M without implying the figure is exact.
 */
function formatModelCapacity(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  const trim = (text: string): string => text.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1')
  if (tokens >= 1_000_000) return trim((tokens / 1_000_000).toFixed(2)) + 'M'
  if (tokens >= 1_000) return Math.round(tokens / 1_000) + 'k'
  return String(tokens)
}

function formatModelHint(contextWindow: number, input: readonly string[], reasoning: boolean, efforts: readonly string[], pricing?: { input: number; output: number }): string {
  const ladder = reasoning ? (efforts.length > 0 ? `reasoning(${efforts.length})` : 'reasoning') : ''
  const base = formatModelCapacity(contextWindow) + ' · ' + input.join('+') + (ladder === '' ? '' : ' · ' + ladder)
  // The public price list is the one per-model fact the vendor publishes; a
  // model it does not carry simply shows no figure rather than a guessed one.
  return pricing === undefined ? base : `${base} · $${pricing.input}/$${pricing.output}`
}

/**
 * Every model the card should render, whether or not it is advertised.
 *
 * `enabled` is the state of the card's checklist row, and it is read from the ONE
 * visibility rule (`openDesignVisibleModelIds` in ./line.ts) — the very function
 * the adapter offers the picker with. A row that reads "checked" while no picker
 * offers it is the contradiction this projection must not be able to produce, so
 * the two are not two calculations: a model the plan withholds reads as unchecked
 * until the user forces it, because that is what the picker does with it.
 */
function projectModels(settings: OpenDesignModelSettings): OpenDesignModelDto[] {
  const known = openDesignKnownModelIds(settings)
  const visible = new Set(openDesignVisibleModelIds(settings))
  const forcedVisible = new Set(settings.forceVisibleModels)
  return known.map((id) => {
    const base = resolveModelInfo(id, {
      synced: settings.catalogModels,
      defaultContextWindow: settings.defaultContextWindow,
      defaultMaxTokens: settings.defaultMaxTokens,
    })
    const info = settings.contextWindowOverrides[id] === undefined ? base : resolveModelInfo(id, {
      synced: settings.catalogModels,
      defaultContextWindow: settings.defaultContextWindow,
      defaultMaxTokens: settings.defaultMaxTokens,
      contextWindowOverride: settings.contextWindowOverrides[id],
    })
    const served = isModelServed(id, settings.servedModelIds)
    return {
      id,
      name: info.displayName,
      hint: formatModelHint(info.contextWindow, info.input, info.reasoning, info.efforts, info.pricing),
      contextWindow: info.contextWindow,
      defaultContextWindow: base.contextWindow,
      maxTokens: info.maxTokens,
      reasoning: info.reasoning,
      input: [...info.input],
      enabled: visible.has(id),
      served,
      forcedVisible: forcedVisible.has(id),
      ...(info.pricing === undefined ? {} : { pricing: info.pricing }),
      ...(settings.contextWindowOverrides[id] === undefined ? {} : { contextWindowOverride: settings.contextWindowOverrides[id] }),
    }
  })
}

export interface OpenDesignRouteOptions {
  settings: OpenDesignModelSettingsStore
  accountPool: OpenDesignAccountPool
  /** Proxy-aware fetch for account verification, quota reads and catalog syncs. */
  fetchFn: typeof fetch
  /** Device-authorization sign-in state, when the composition installed one. */
  login?: OpenDesignLoginManager
  /**
   * Browser opener for `/login/start`; defaults to a no-op because the settings
   * card opens the activation URL itself via `window.open`.
   */
  openBrowser?: (url: string) => void
  serving(): boolean
  conflict(): string | null
}

/** Named browser opener for deployments that want the host to launch the activation URL. */
export const openOpenDesignBrowser = openPlatformBrowser

/**
 * Latest wallet readings, in-process only.
 *
 * A reading is a snapshot, not a stream: a restart starts blank rather than
 * serving a stale figure as if fresh, and a failed refresh keeps the previous
 * one with its error attached (the card shows both).
 */
interface UsageStore {
  readings: Map<string, OpenDesignUsageAccountDto>
  fetchedAt: number
}

/** Assemble the whole status payload the OpenDesign tab renders. */
export async function getOpenDesignWebStatus(
  options: OpenDesignRouteOptions,
  usageStore?: UsageStore,
): Promise<OpenDesignWebStatus> {
  const { settings: settingsStore, accountPool } = options
  const settings = await settingsStore.read().catch(() => settingsStore.status())
  const data = await accountPool.read().catch(() => null)
  const accounts = await accountPool.listAccounts().catch(() => [])
  // The tier lives on the billing summary, not on the sign-in snapshot (that
  // one answers "free" for a paid account, see docs/opendesign-line-plan.md).
  // A summary read for an account therefore speaks for it everywhere the pool
  // is projected — and only for that account, never for the line.
  const billedPlans = new Map<string, string>()
  if (usageStore !== undefined) {
    for (const reading of usageStore.readings.values()) {
      const plan = reading.billing?.plan
      if (plan !== undefined && plan !== '') billedPlans.set(reading.accountId, plan)
    }
  }
  const projectedAccounts = billedPlans.size === 0
    ? accounts
    : accounts.map((account) => {
        const plan = billedPlans.get(account.id)
        return plan === undefined ? account : { ...account, plan }
      })
  const now = Date.now()
  const pool: OpenDesignPoolStatusDto = {
    accounts: projectedAccounts,
    rotationStrategy: data?.rotationStrategy ?? 'sequential',
    ...(data?.activeAccountId === undefined ? {} : { activeAccountId: data.activeAccountId }),
  }
  const models = projectModels(settings)
  const usable = projectedAccounts.some((account) => isUsable(account, now))
  // The badge contract reads `authenticated`; a disabled line must not leave
  // one up, even though its accounts are still usable.
  const authenticated = usable && settings.enabled
  return {
    enabled: settings.enabled,
    providerId: PROVIDER_ID,
    baseURL: settings.baseURL,
    serving: options.serving(),
    conflict: options.conflict(),
    usable,
    authenticated,
    pool,
    models,
    catalogSynced: settings.catalogModels.length > 0,
    catalogCount: settings.catalogModels.length,
    usage: usageStore !== undefined && usageStore.readings.size > 0
      ? { accounts: [...usageStore.readings.values()], fetchedAt: usageStore.fetchedAt }
      : null,
    login: options.login?.current() ?? null,
    settings: {
      baseURL: settings.baseURL,
      defaultContextWindow: settings.defaultContextWindow,
      defaultMaxTokens: settings.defaultMaxTokens,
      maxConcurrentRequests: settings.maxConcurrentRequests,
      streamIdleTimeoutMs: settings.streamIdleTimeoutMs,
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
  'models/visibility': 'POST',
  'models/visibility-all': 'POST',
  'models/context-window': 'POST',
  'catalog/refresh': 'POST',
  usage: 'GET|POST',
} as const

/** The route table, exported so the client and this file can be checked against each other. */
export const OPENDESIGN_ROUTES = ROUTES

/**
 * Register the OpenDesign settings API under `/opendesign/api`.
 *
 * Registered unconditionally: the card is how a user adds their first key, so
 * gating it on winning the route would leave a contested id with no way to
 * configure it at all.
 */
export function registerOpenDesignRoutes(ctx: Context, options: OpenDesignRouteOptions): () => void {
  const { settings: settingsStore, accountPool, fetchFn } = options
  // Default to a no-op opener: the settings card calls window.open itself, so
  // launching from the host as well would open two identical activation tabs.
  const openBrowser = options.openBrowser ?? (() => undefined)
  const usageStore: UsageStore = { readings: new Map(), fetchedAt: 0 }

  const emitModelsUpdated = (): void => {
    ctx.emit?.('llm/adapters-updated')
  }

  const status = async (): Promise<OpenDesignWebStatus> => await getOpenDesignWebStatus(options, usageStore)

  /**
   * Sync the live catalog with every usable account's key.
   *
   * The gateway's listing is the authority on what a key's plan serves, and a plan
   * belongs to an ACCOUNT rather than to the line: two pooled keys can serve two
   * different model sets, so every account is asked and the union is what gets
   * remembered. That union is persisted as `servedModelIds` — the fact the picker
   * needs and the one this sync used to throw away — and it is written only when a
   * scan really succeeded, so a network failure cannot switch the filter off.
   *
   * A failed or refused read changes nothing (the shipped table still stands in),
   * and the sync's answer says which happened. Announces only a real change: the
   * picker rebuilds on `llm/adapters-updated`, so a no-change sync must stay
   * silent.
   */
  const syncCatalog = async (): Promise<{ added: string[]; synced: boolean; error: string }> => {
    const known = openDesignKnownModelIds(await settingsStore.read())
    const data = await accountPool.read().catch(() => null)
    const now = Date.now()
    const accounts = (data?.accounts ?? []).filter((account) => isUsable(account, now))
    if (accounts.length === 0) {
      return { added: [], synced: false, error: 'no usable account: add an API key or sign in first' }
    }

    // Two listings PER ACCOUNT, merged. The AMR control-plane catalog carries the
    // metadata (contextWindowTokens and friends) but only answers a CONTROL key —
    // i.e. an OAuth-signed-in account; the link gateway's own listing answers the
    // runtime key and supplies the ids this key's plan really serves. Either may
    // be refused for one account without touching another's answer: the union
    // below is built from whatever actually answered.
    const scans: Array<{ ids: string[]; catalog: Record<string, OpenDesignDiscoveredModel> }> = []
    let controlRefused = false
    const settings = await settingsStore.read()
    for (const account of accounts.slice(0, MAX_SYNC_ACCOUNTS)) {
      const controlKey = controlKeyFor(account.credentials)
      if (controlKey !== undefined) {
        const scan = await fetchControlPlaneCatalog({ fetchFn, controlKey, knownIds: known })
        if (scan === null) controlRefused = true
        else if (scan.ids.length > 0) scans.push(scan)
      }
      // Every account is asked, pasted key or sign-in: the gateway listing is the
      // only statement of what THIS key's plan serves, and with several pooled keys
      // the honest answer is the union of those statements.
      const gateway = await fetchGatewayCatalog({
        fetchFn,
        baseURL: settings.baseURL,
        apiKey: bearerFor(account.credentials),
      })
      if (gateway !== null && gateway.ids.length > 0) scans.push(gateway)
    }
    // Nothing answered — or every answer was an empty listing. Both are read as a
    // FAILED read that keeps the previous measurement, never as "this plan serves
    // zero models": collapsing the two would hide the entire picker behind one bad
    // response, while keeping the old union merely leaves a stale one in place.
    if (scans.length === 0) {
      return {
        added: [],
        synced: false,
        error: controlRefused
          ? 'the metadata catalog refused the control key and the gateway listing could not be read'
          : 'the gateway catalog could not be read',
      }
    }

    const current = await settingsStore.read()
    const existing = new Map(current.catalogModels.map((entry) => [entry.id, entry]))
    const added: string[] = []
    for (const scan of scans) {
      for (const id of scan.ids) {
        const published = scan.catalog[id] ?? {}
        if (!existing.has(id)) added.push(id)
        existing.set(id, {
          ...existing.get(id),
          id,
          ...(published.name === undefined ? {} : { name: published.name }),
          ...(published.contextWindow === undefined ? {} : { contextWindow: published.contextWindow }),
          ...(published.maxTokens === undefined ? {} : { maxTokens: published.maxTokens }),
          ...(published.reasoning === undefined ? {} : { reasoning: published.reasoning }),
          ...(published.efforts === undefined ? {} : { efforts: published.efforts }),
          ...(published.input === undefined ? {} : { input: published.input }),
        })
      }
    }
    // The catalog is also the truth about removals — but only for ids it added
    // itself. A shipped-table id the listing omits stays: the fallback is a
    // placeholder, not a claim the gateway must echo.
    const syncedIds = new Set(scans.flatMap((scan) => scan.ids))
    const merged = [...existing.values()].filter((entry) => {
      const wasSynced = current.catalogModels.some((old) => old.id === entry.id)
      return !wasSynced || syncedIds.has(entry.id)
    })
    // The union of what the accounts answered is the durable fact: an id in it is a
    // model this subscription serves, an id outside it one it demonstrably does
    // not. A scan that returned nothing contributes nothing, so one account serving
    // no models never shrinks a union another account established — and a sync in
    // which nothing at all answered returned above WITHOUT writing, leaving the
    // previous measurement standing instead of clearing the filter.
    const served = [...new Set(scans.flatMap((scan) => scan.ids))]
    const fingerprintBefore = current.catalogModels.map((entry) => entry.id).join('\n')
    const fingerprintAfter = merged.map((entry) => entry.id).join('\n')
    await settingsStore.storeCatalog(merged, served)
    if (fingerprintBefore !== fingerprintAfter) emitModelsUpdated()
    return { added, synced: true, error: '' }
  }

  return ctx.webServer.register({
    kind: 'prefix',
    path: OPENDESIGN_ROUTE_PREFIX,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url || '/', 'http://dsh.local')
      const path = url.pathname.replace(/^\/opendesign\/api\/?/, '')
      const method = request.method ?? 'GET'
      try {
        if (path === '' || path === 'status') {
          return sendJson(response, 200, { ok: true, value: await status() })
        }

        if (path === 'settings') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const body = await readRequestJson(request).catch((): Record<string, unknown> => ({}))
          const patch: Partial<OpenDesignModelSettings> = {}
          if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
          if (typeof body.baseURL === 'string') {
            const baseURL = body.baseURL.trim()
            if (baseURL !== '' && !/^https?:\/\//i.test(baseURL)) return sendJson(response, 400, { ok: false, error: 'baseURL must be an http(s) URL.' })
            patch.baseURL = baseURL === '' ? DEFAULT_BASE_URL : baseURL
          }
          for (const key of ['defaultContextWindow', 'defaultMaxTokens', 'streamIdleTimeoutMs'] as const) {
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
          let touched = false
          if (Object.keys(patch).length > 0) {
            await settingsStore.update(patch)
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
          const action = typeof body.action === 'string' ? body.action as OpenDesignAccountAction : ''
          const accountId = typeof body.accountId === 'string' ? body.accountId : undefined
          try {
            if (action === 'add') {
              const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
              if (apiKey === '') return sendJson(response, 400, { ok: false, error: 'API key is required.' })
              const alias = typeof body.alias === 'string' && body.alias.trim() !== '' ? body.alias.trim() : undefined
              const baseURL = typeof body.baseURL === 'string' && body.baseURL.trim() !== '' ? body.baseURL.trim() : undefined
              if (baseURL !== undefined && !/^https?:\/\//i.test(baseURL)) {
                return sendJson(response, 400, { ok: false, error: 'baseURL must be an http(s) URL.' })
              }
              await accountPool.addAccount({ kind: 'api-key', apiKey, addedAt: Date.now(), ...(alias === undefined ? {} : { alias }), ...(baseURL === undefined ? {} : { baseURL }) }, alias)
              // A fresh key is the one moment a sync costs nothing to schedule:
              // the picker learns the plan's real catalog behind this answer.
              void syncCatalog().catch(() => undefined)
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
              const settings = await settingsStore.read()
              const result = await testApiKey({ fetchFn, baseURL: baseURL ?? settings.baseURL, apiKey: key })
              const value: OpenDesignAuthResult = {
                ok: result.authorized,
                authorized: result.authorized,
                ms: result.ms,
                error: firstLine(result.error, 240),
                modelCount: result.modelCount,
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
          if (options.login === undefined) return sendJson(response, 503, { ok: false, error: 'OpenDesign sign-in is unavailable in this composition.' })
          try {
            const flow: OpenDesignLoginFlowDto = await options.login.begin()
            if (flow.verificationUri !== '') openBrowser(flow.verificationUri)
            return sendJson(response, 200, { ok: true, value: flow })
          } catch (error) {
            return sendJson(response, 502, { ok: false, error: firstLine(error instanceof Error ? error.message : error, 300) })
          }
        }

        if (path === 'login/status') {
          if (method !== 'GET') return sendMethodNotAllowed(response)
          if (options.login === undefined) return sendJson(response, 503, { ok: false, error: 'OpenDesign sign-in is unavailable in this composition.' })
          const id = url.searchParams.get('id') ?? ''
          if (id === '') return sendJson(response, 400, { ok: false, error: 'login id is required.' })
          try {
            const flow: OpenDesignLoginFlowDto = await options.login.status(id)
            // A completed sign-in is the one moment a sync costs nothing to
            // schedule: the picker learns the plan's real catalog behind this
            // answer, under the brand-new runtime key.
            if (flow.status === 'complete') void syncCatalog().catch(() => undefined)
            return sendJson(response, 200, { ok: true, value: flow })
          } catch (error) {
            return sendJson(response, 404, { ok: false, error: firstLine(error instanceof Error ? error.message : error, 300) })
          }
        }

        if (path === 'login/cancel') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          if (options.login === undefined) return sendJson(response, 503, { ok: false, error: 'OpenDesign sign-in is unavailable in this composition.' })
          const body = await readRequestJson(request).catch((): Record<string, unknown> => ({}))
          const id = typeof body.id === 'string' ? body.id : ''
          if (id === '') return sendJson(response, 400, { ok: false, error: 'login id is required.' })
          return sendJson(response, 200, { ok: true, value: { cancelled: options.login.cancel(id) } })
        }

        if (path === 'models') {
          if (method === 'GET') {
            const current = await settingsStore.read()
            return sendJson(response, 200, { ok: true, value: { models: projectModels(current), enabledModelIds: current.enabledModelIds } })
          }
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const body = await readRequestJson(request).catch((): Record<string, unknown> => ({}))
          let touched = false
          if (body.enabledModelIds === null || Array.isArray(body.enabledModelIds)) {
            // This is THE ONLY un-tick path the card has (it removes the id from the
            // selection and never posts `models/visibility {visible:false}`), so
            // `selectModels` also drops a forced reveal the new selection excludes —
            // otherwise the reveal would outlive the tick that asked for it.
            await settingsStore.selectModels(body.enabledModelIds === null
              ? null
              : body.enabledModelIds.filter((id): id is string => typeof id === 'string'))
            touched = true
          }
          if (typeof body.enabled === 'boolean') {
            await settingsStore.update({ enabled: body.enabled })
            touched = true
          }
          if (touched) emitModelsUpdated()
          return sendJson(response, 200, { ok: true, value: await status() })
        }

        if (path === 'models/visibility' || path === 'models/visibility-all') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const body = await readRequestJson(request).catch((): Record<string, unknown> => ({}))
          const current = await settingsStore.read()
          const known = openDesignKnownModelIds(current)
          const hidden = new Set(current.hiddenModels)
          // Ticking a model the plan's last scan did not list is a request to see it
          // ANYWAY, so it has to be recorded here: the tick list and the hidden list
          // both describe the user's wishes, while "served" is the plan's answer, and
          // only an explicit force keeps a served=false id in the picker.
          const forced = new Set(current.forceVisibleModels)
          if (path === 'models/visibility') {
            const model = typeof body.model === 'string' ? body.model.trim() : ''
            if (!known.includes(model)) return sendJson(response, 400, { ok: false, error: `${JSON.stringify(model)} is not one of this route's models` })
            const served = isModelServed(model, current.servedModelIds)
            if (body.visible === false) {
              // "Do not force this" is not "hide this for ever": the hidden list is
              // the user's own veto over a model the plan DOES serve, and writing a
              // plan-omitted id into it would silently hide that model the day the
              // plan starts serving it.
              if (served) hidden.add(model)
              forced.delete(model)
            } else {
              hidden.delete(model)
              if (served) forced.delete(model)
              else forced.add(model)
            }
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
          // Both resets drop the force list: "everything on" leaves nothing for it to
          // rescue, and "everything off" must not leave a forced row checked and still
          // offered — "show nothing" means nothing. `invert` is a per-row toggle
          // rather than a reset, so it keeps the forced entries it did not flip.
          const nextForced = path !== 'models/visibility-all'
            ? [...forced]
            : body.mode === 'invert' ? current.forceVisibleModels : []
          await settingsStore.update({ hiddenModels: nextHidden, forceVisibleModels: nextForced })
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

        if (path === 'catalog/refresh') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const result = await syncCatalog()
          if (!result.synced) {
            return sendJson(response, 502, { ok: false, error: `The OpenDesign model catalog could not be read (${result.error}). Check the network or proxy, then sync again.` })
          }
          return sendJson(response, 200, { ok: true, value: { added: result.added, status: await status() } })
        }

        if (path === 'usage') {
          if (method === 'GET') {
            return sendJson(response, 200, {
              ok: true,
              value: usageStore.readings.size === 0
                ? null
                : { accounts: [...usageStore.readings.values()], fetchedAt: usageStore.fetchedAt } satisfies OpenDesignUsageDto,
            })
          }
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const data = await accountPool.read().catch(() => null)
          const now = Date.now()
          const readable = (data?.accounts ?? []).filter((account) => (
            isUsable(account, now) && isOpenDesignOAuthCredentials(account.credentials)
          ))
          if (readable.length === 0) {
            return sendJson(response, 400, { ok: false, error: 'No OAuth-signed-in account can be read. Plan, credits and wallet balances come from the control key a browser sign-in issues; a pasted API key has none.' })
          }
          /**
           * The workspace id, resolved ONCE for this request and reused.
           *
           * Every account here asks the same control-plane question — "which
           * workspace is this key signed into" — and the coding-plan read needs
           * the answer only as an address. The first account to need it settles
           * the lookup; the rest await that same promise, so a request with four
           * readable accounts makes one `/workspaces/current` call rather than four.
           *
           * The settled answer is reused even when it FAILED: every account then
           * carries the same `error` in its own `codingPlan`, which is what a
           * user needs to see ("the workspace cannot be resolved") instead of
           * four identical timeouts. A failure never reaches the reading itself —
           * the wallet and billing halves are unaffected.
           */
          let workspaceLookup: Promise<OpenDesignWorkspaceIdRead> | null = null
          const readCodingPlan = async (controlKey: string, runtimeKey: string): Promise<OpenDesignCodingPlanDto> => {
            if (workspaceLookup === null) workspaceLookup = fetchWorkspaceId({ fetchFn, controlKey })
            const workspace = await workspaceLookup
            if (!workspace.ok || workspace.id === null) {
              return {
                tier: null,
                windows: [],
                error: workspace.error === '' ? 'no workspace id for the coding-plan read' : workspace.error,
              }
            }
            // Both keys go in, never out: the reader tries them as credential
            // SHAPES and reports which shapes it tried by NAME, so no key ever
            // reaches a reading, a card or an error text.
            return await fetchCodingPlanUsage({ fetchFn, controlKey, runtimeKey, workspaceId: workspace.id })
          }

          const readings: OpenDesignUsageAccountDto[] = await Promise.all(readable.map(async (account) => {
            const fetchedAt = Date.now()
            try {
              const credentials = await accountPool.getFreshCredential(account.id, fetchFn)
              const controlKey = controlKeyFor(credentials)
              if (controlKey === undefined) {
                return {
                  accountId: account.id,
                  alias: account.alias,
                  ok: false,
                  balanceUsd: null,
                  updatedAt: null,
                  error: 'no control key on this account',
                  fetchedAt,
                  codingPlan: { tier: null, windows: [], error: 'no control key on this account' },
                }
              }
              // Wallet, billing and the coding plan are three independent reads
              // of different surfaces; one refusal must not hide the others. The
              // summary is what names the plan and the credits, the wallet what
              // states the spendable figure, and the coding plan what states the
              // real 5-hour / 7-day windows. A failed wallet falls back to the
              // summary's own total so the card still says what is left, and a
              // failed coding plan stays a sentence on its own field.
              // The chat bearer is the runtime key (`sk-amr-…`); it is the second
              // credential shape the coding-plan read tries, because the console
              // signs that endpoint with a browser session and a control key was
              // refused live.
              const [wallet, billing, codingPlan] = await Promise.all([
                fetchWalletBalance({ fetchFn, controlKey }),
                fetchBillingSummary({ fetchFn, controlKey }),
                readCodingPlan(controlKey, bearerFor(credentials)),
              ])
              const balanceUsd = wallet.balanceUsd ?? billing.billing?.totalAvailableCreditsUsd ?? null
              return {
                accountId: account.id,
                alias: account.alias,
                // Readable when either surface answered: a billing summary that
                // states the tier and credits is a successful reading even if
                // the wallet endpoint refused.
                ok: wallet.ok || billing.ok,
                balanceUsd,
                updatedAt: wallet.updatedAt,
                error: wallet.error,
                fetchedAt,
                ...(billing.billing === null ? {} : { billing: billing.billing }),
                // Always present, failure included: the card has to be able to
                // say why no window bar is drawn, and an empty list alone would
                // read as "this plan has no windows".
                codingPlan,
              }
            } catch (error) {
              return {
                accountId: account.id,
                alias: account.alias,
                ok: false,
                balanceUsd: null,
                updatedAt: null,
                error: firstLine(error instanceof Error ? error.message : error, 240),
                fetchedAt,
                codingPlan: { tier: null, windows: [], error: 'the account could not be read, so its coding plan was not read either' },
              }
            }
          }))
          for (const reading of readings) usageStore.readings.set(reading.accountId, reading)
          usageStore.fetchedAt = Date.now()
          return sendJson(response, 200, { ok: true, value: { usage: { accounts: readings, fetchedAt: usageStore.fetchedAt }, status: await status() } })
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
