import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isSameOriginMutation } from '../common/same-origin.ts'
import { QuotaRefresh } from '../common/quota-refresh.ts'
import {
  FALLBACK_MODELS,
  PROVIDER_ID,
  PROVIDER_NAME,
  QUOTA_CACHE_TTL_MS,
  codingBaseUrl,
  oauthHost,
} from './types.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  resolveRegion,
  type KimiCodeCatalogModel,
  type KimiCodeCredentials,
  type KimiCodeModelSettings,
  type KimiCodePreferenceStore,
} from './token-store.ts'
import { KimiCodeAccountPool } from './account-pool.ts'
import type { ContextWindowOverridePatch } from '../common/context-window-overrides.ts'
import {
  accountFromCredentials,
  buildModelOptions,
  clearCachedCatalog,
  clearCachedQuota,
  fetchAccountQuota,
  getCachedQuotaFor,
  loadProviderModels,
  testConnection,
} from './client.ts'
import { getCacheStats, getLastDriftCause, preserveThinkingEnabled } from './mapper.ts'
import { beginWebLogin, getWebLoginStatus, isRefreshTokenRejected, resetWebLogin } from './oauth.ts'
import {
  KIMI_CODE_REASONING_EFFORTS,
  type KimiCodeAccount,
  type KimiCodeCacheStatsDto,
  type KimiCodeReasoningEffort,
  type KimiCodeRegion,
  type KimiCodeWebStatus,
} from '../../shared/kimi-code-contracts.ts'

/** Membership test for one posted reasoning level; the set is registry-wide, not per model. */
function isKimiCodeEffort(value: unknown): value is KimiCodeReasoningEffort {
  return typeof value === 'string' && (KIMI_CODE_REASONING_EFFORTS as readonly string[]).includes(value)
}

function isRegion(value: unknown): value is KimiCodeRegion {
  return value === 'mainland-cn' || value === 'global'
}

const MAX_BODY_BYTES = 64 * 1024
const ROUTE_PREFIX = '/kimi-code/api'

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

function sendMethodNotAllowed(response: ServerResponse): void {
  sendJson(response, 405, { ok: false, error: 'Method Not Allowed' })
}

async function readRequestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    request.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>)
      } catch (error) {
        reject(error instanceof Error ? error : new Error('Malformed JSON request'))
      }
    })
    request.on('error', reject)
  })
}

function fallbackCatalog(): KimiCodeCatalogModel[] {
  return FALLBACK_MODELS.map((model) => ({
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
  }))
}

/**
 * The selection the card should show.
 *
 * A stored list that still equals the shipped default has never been edited, so
 * it cannot know about models the live catalog has since added; treating it as
 * "everything currently offered" keeps a first run from hiding the whole
 * catalog behind an unedited default. Any explicit edit is honoured exactly.
 */
export function resolveEnabledModelIds(
  stored: readonly string[],
  catalog: readonly KimiCodeCatalogModel[],
  enabled = true,
): string[] {
  if (!enabled) return []
  const catalogIds = catalog.map((model) => model.id)
  const shippedDefaults = new Set(FALLBACK_MODELS.map((model) => model.id))
  const isUntouchedDefault = stored.length > 0
    && stored.length === shippedDefaults.size
    && stored.every((id) => shippedDefaults.has(id))
  if (isUntouchedDefault) return catalogIds
  const known = new Set(catalogIds)
  return stored.filter((id) => known.has(id))
}

export interface KimiCodeStatusOptions {
  fetchFn?: typeof fetch
  /** Whether this plugin currently owns the provider route; re-read on every status. */
  serving?: boolean | (() => boolean)
  /** Diagnostic when another plugin owns the provider route; re-read on every status. */
  conflict?: string | null | (() => string | null)
  /**
   * Account pool to report on.
   *
   * Only the plugin entry installs one, because it owns the pool's storage; a
   * caller that passes none keeps the single-account behavior.
   */
  accountPool?: KimiCodeAccountPool
}

function readOption<T>(value: T | (() => T) | undefined, fallback: T): T {
  return typeof value === 'function' ? (value as () => T)() : value ?? fallback
}

/** Everything the settings card renders: account, quota, and the model catalog. */
export async function getKimiCodeWebStatus(
  store: FileCredentialStore,
  modelSettings: FileModelSettingsStore,
  preferences?: KimiCodePreferenceStore,
  options: KimiCodeStatusOptions = {},
  accountPool: KimiCodeAccountPool | undefined = options.accountPool,
): Promise<KimiCodeWebStatus> {
  const credentials = await store.read()
  const settings: KimiCodeModelSettings = preferences ? preferences.status() : await modelSettings.read()

  // A pool that cannot be read must not fail the whole card: the connection
  // section is still worth rendering, just with an empty account list.
  const poolData = accountPool === undefined ? null : await accountPool.read().catch(() => null)
  const accounts = accountPool === undefined ? [] : await accountPool.listAccounts().catch(() => [])
  const activeAccount = accounts.find((entry) => entry.id === poolData?.activeAccountId)
    ?? accounts.find((entry) => entry.isPrimary)
    ?? accounts[0]
  const activePoolAccount = poolData === null
    ? undefined
    : (poolData.accounts.find((entry) => entry.id === poolData.activeAccountId)
      ?? poolData.accounts.find((entry) => entry.isPrimary)
      ?? poolData.accounts[0])
  // A pool may hold accounts from more than one region, so everything host-level
  // follows the account that would actually serve the next request.
  const active = activePoolAccount?.credentials ?? credentials
  const region = active?.region ?? await resolveRegion()

  const live = await loadProviderModels({
    fetchFn: options.fetchFn,
    store,
    region,
    accessToken: active?.accessToken,
  }).catch(() => [])
  const catalog = live.length > 0 ? live : fallbackCatalog()
  const enabled = settings.enabled !== false
  const enabledModelIds = resolveEnabledModelIds(settings.enabledModelIds, catalog, enabled)
  const models = buildModelOptions(catalog, enabledModelIds, settings.contextWindowOverrides)
  // Only a snapshot that belongs to the displayed account may be rendered.
  const quota = getCachedQuotaFor(activeAccount?.id ?? null)

  // The quota snapshot is the richest source, but on a first load (or when the
  // usage call is failing) the account is still known from the credential's own
  // token claims — so the card shows who is signed in rather than a blank row.
  const account: KimiCodeAccount | null = quota?.account
    ?? (active === null || active === undefined ? null : accountFromCredentials(active))

  return {
    enabled,
    authenticated: accounts.length > 0 || credentials !== null,
    hasCredentials: accounts.length > 0 || credentials !== null,
    storagePath: store.path(),
    region,
    oauthHost: active?.oauthHost ?? oauthHost(region),
    codingBaseUrl: active?.baseUrl ?? codingBaseUrl(region),
    accounts,
    ...(poolData?.activeAccountId === undefined ? {} : { activeAccountId: poolData.activeAccountId }),
    rotationStrategy: poolData?.rotationStrategy ?? 'sequential',
    account,
    quota,
    lastFetchedAt: quota?.fetchedAt ?? null,
    credentialsRejected: active !== null && active !== undefined && isRefreshTokenRejected(active.refreshToken),
    cache: cacheStatsOrNull(),
    preserveThinking: preserveThinkingEnabled(),
    models,
    contextWindowOverrides: settings.contextWindowOverrides,
    defaultReasoningEffort: settings.defaultReasoningEffort,
    loginRegion: region,
    serving: readOption(options.serving, true),
    conflict: readOption(options.conflict, null),
  }
}

/** Rolling cache totals, or null while no request has reported usage yet. */
function cacheStatsOrNull(): KimiCodeCacheStatsDto | null {
  const stats = getCacheStats()
  if (stats.requests === 0) return null
  return { ...stats, lastDrift: getLastDriftCause() }
}

/** Register the Kimi Code settings routes under `/kimi-code/api`. */
export function registerKimiCodeRoutes(
  ctx: Context,
  store: FileCredentialStore,
  modelSettings: FileModelSettingsStore,
  preferences?: KimiCodePreferenceStore,
  options: KimiCodeStatusOptions = {},
  accountPool: KimiCodeAccountPool | undefined = options.accountPool,
): () => void {
  const fetchFn = options.fetchFn ?? fetch
  const readStatus = (): Promise<KimiCodeWebStatus> =>
    getKimiCodeWebStatus(store, modelSettings, preferences, options, accountPool)
  /**
   * The account that would serve the next request, or undefined without a pool.
   *
   * Quota and connection probes belong to one account's token; with a pool that
   * is the active account, not whatever the single-credential file holds.
   */
  const activeAccount = async (): Promise<{ id: string | undefined; credentials: KimiCodeCredentials | undefined }> => {
    if (accountPool === undefined) {
      const credentials = await store.read()
      return { id: undefined, credentials: credentials ?? undefined }
    }
    const data = await accountPool.read().catch(() => null)
    const target = data?.activeAccountId === undefined
      ? (data?.accounts.find((account) => account.isPrimary) ?? data?.accounts[0])
      : data.accounts.find((account) => account.id === data.activeAccountId)
    return { id: target?.id, credentials: target?.credentials }
  }

  // One per registration: a background refresh belongs to the line this route
  // serves, and the flag it reports must not leak between instances.
  const quotaRefresh = new QuotaRefresh()

  return ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url || '/', 'http://dsh.local')
      const path = url.pathname.replace(/^\/kimi-code\/api\/?/, '')
      const method = request.method ?? 'GET'

      try {
        if (path === '' || path === 'status') {
          if (method !== 'GET') return sendMethodNotAllowed(response)
          const poolActive = await activeAccount()
          const cached = getCachedQuotaFor(poolActive.id ?? null)
          // A failed refresh must not fail the status call, but it must not
          // vanish either: the reason travels with the status so the card can
          // show why the quota is missing instead of an empty panel. A snapshot
          // that exists answers now and refreshes behind it; only a missing one
          // is worth waiting for, because the card has nothing to render without
          // it.
          if (poolActive.credentials !== undefined
            && (cached === null || Date.now() - (cached.fetchedAt || 0) > QUOTA_CACHE_TTL_MS)) {
            const refresh = (): Promise<unknown> => fetchAccountQuota(store, {
              fetchFn,
              ...(accountPool === undefined
                ? {}
                : { credentials: poolActive.credentials, accountId: poolActive.id }),
            })
            if (cached === null) await quotaRefresh.run(refresh)
            else quotaRefresh.start(refresh)
          }
          const value = await readStatus()
          return sendJson(response, 200, {
            ok: true,
            value: {
              ...value,
              quotaError: quotaRefresh.lastError(),
              quotaRefreshing: quotaRefresh.refreshing,
            },
          })
        }

        if (path === 'login') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const body = await readRequestJson(request)
          const requested = isRegion(body.region) ? body.region : undefined
          const value = await beginWebLogin(store, {
            fetchFn,
            region: requested,
            ...(accountPool === undefined ? {} : { onSave: (credentials) => accountPool.addAccount(credentials) }),
          })
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'login/status') {
          if (method !== 'GET') return sendMethodNotAllowed(response)
          return sendJson(response, 200, { ok: true, value: getWebLoginStatus() })
        }

        if (path === 'login/cancel') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          resetWebLogin()
          return sendJson(response, 200, { ok: true, value: getWebLoginStatus() })
        }

        if (path === 'connection/test') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const poolActive = await activeAccount()
          if (poolActive.credentials === undefined) return sendJson(response, 400, { ok: false, error: 'Not signed in.' })
          const { account, latencyMs } = await testConnection(store, {
            fetchFn,
            ...(accountPool === undefined
              ? {}
              : { credentials: poolActive.credentials, accountId: poolActive.id }),
          })
          // A reachable service with no usable account still means the request
          // did not authenticate, so the verdict is "not connected".
          return sendJson(response, 200, {
            ok: true,
            value: { connected: account !== null, latencyMs, account },
          })
        }

        if (path === 'quota') {
          if (method !== 'GET' && method !== 'POST') return sendMethodNotAllowed(response)
          if (method === 'POST' && !isSameOriginMutation(request)) {
            return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          }
          const quotaActive = await activeAccount()
          if (quotaActive.credentials === undefined) {
            return sendJson(response, 400, { ok: false, error: 'Not signed in to Kimi Code.' })
          }
          // An explicit refresh must report the real outcome: swallowing the
          // failure produced a 200 that looked like success while the panel
          // stayed empty, which is exactly the wrong thing to show a user who
          // just pressed the button.
          try {
            const quota = await fetchAccountQuota(store, {
              fetchFn,
              force: true,
              ...(accountPool === undefined
                ? {}
                : { credentials: quotaActive.credentials, accountId: quotaActive.id }),
            })
            if (quota === null) {
              return sendJson(response, 502, { ok: false, error: 'Kimi Code returned no usage data. The subscription may not include the coding quota.' })
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return sendJson(response, 502, { ok: false, error: message })
          }
          const value = await readStatus()
          return sendJson(response, 200, { ok: true, value: { ...value, quotaError: null } })
        }

        if (path === 'models' || path === 'settings') {
          if (method === 'GET') {
            const value = await readStatus()
            return sendJson(response, 200, { ok: true, value })
          }
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const body = await readRequestJson(request)
          const patch: Parameters<KimiCodePreferenceStore['update']>[0] = {}
          if (typeof body.enabled === 'boolean') {
            patch.enabled = body.enabled
          }
          if (Array.isArray(body.enabledModelIds)) {
            patch.enabledModelIds = body.enabledModelIds.filter((id): id is string => typeof id === 'string')
          }
          if (typeof body.contextWindowOverrides === 'object' && body.contextWindowOverrides !== null) {
            const overrides: ContextWindowOverridePatch = {}
            for (const [key, raw] of Object.entries(body.contextWindowOverrides as Record<string, unknown>)) {
              // `null` is the card's "restore the catalog default": it has to
              // survive normalization so the store can delete the key.
              if (raw === null) overrides[key] = null
              else if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) overrides[key] = Math.floor(raw)
            }
            patch.contextWindowOverrides = overrides
          }
          if (body.defaultReasoningEffort !== undefined) {
            const effort = body.defaultReasoningEffort
            if (effort === null || isKimiCodeEffort(effort)) {
              patch.defaultReasoningEffort = effort
            }
          }
          if (preferences) await preferences.update(patch)
          else await modelSettings.updateSettings(patch)
          if (patch.enabledModelIds !== undefined || patch.enabled !== undefined) ctx.emit?.('llm/adapters-updated')
          const value = await readStatus()
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'catalog/refresh') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          clearCachedCatalog()
          // The catalog is per account: refreshing it must ask the active
          // account's region and token, not the single-credential file's.
          const catalogActive = await activeAccount()
          if (catalogActive.credentials !== undefined) {
            await loadProviderModels({
              fetchFn,
              store,
              region: catalogActive.credentials.region,
              accessToken: catalogActive.credentials.accessToken,
              force: true,
            }).catch(() => undefined)
          }
          const value = await readStatus()
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'accounts') {
          if (method === 'GET') {
            const data = accountPool === undefined ? null : await accountPool.read().catch(() => null)
            const accounts = accountPool === undefined ? [] : await accountPool.listAccounts().catch(() => [])
            return sendJson(response, 200, { ok: true, value: {
              accounts,
              ...(data?.activeAccountId === undefined ? {} : { activeAccountId: data.activeAccountId }),
              rotationStrategy: data?.rotationStrategy ?? 'sequential',
            } })
          }
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          if (accountPool === undefined) return sendJson(response, 400, { ok: false, error: 'Account pool is not installed.' })
          const body = await readRequestJson(request)
          const action = typeof body.action === 'string' ? body.action : ''
          const accountId = typeof body.accountId === 'string' ? body.accountId : undefined
          if (action === 'set-primary' && accountId !== undefined) {
            await accountPool.setPrimary(accountId)
          } else if (action === 'set-alias' && accountId !== undefined && typeof body.alias === 'string') {
            await accountPool.setAlias(accountId, body.alias)
          } else if (action === 'delete' && accountId !== undefined) {
            await accountPool.deleteAccount(accountId)
          } else if (action === 'clear-cooldown' && accountId !== undefined) {
            await accountPool.clearCooldown(accountId)
          } else if (action === 'strategy'
            && (body.strategy === 'sequential' || body.strategy === 'round-robin' || body.strategy === 'sticky')) {
            await accountPool.setStrategy(body.strategy)
          } else if (action === 'relogin' && accountId !== undefined) {
            // Re-signing in is what restores an account whose refresh token was
            // rejected, so the marker is cleared and nothing is deleted.
            await accountPool.clearAuthFailed(accountId)
          }
          // The quota and catalog belong to the account that just changed.
          clearCachedQuota()
          clearCachedCatalog()
          const value = await readStatus()
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'logout') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          resetWebLogin()
          if (accountPool === undefined) {
            await store.delete()
          } else {
            // Without an explicit account, the one that would serve the next
            // request goes and the pool promotes another; that is what the
            // card's single sign-out button means once a pool exists.
            const body = await readRequestJson(request).catch(() => ({} as Record<string, unknown>))
            const data = await accountPool.read().catch(() => null)
            const target = typeof body.accountId === 'string'
              ? body.accountId
              : (data?.activeAccountId
                ?? data?.accounts.find((account) => account.isPrimary)?.id
                ?? data?.accounts[0]?.id)
            if (target === undefined) await store.delete()
            else await accountPool.deleteAccount(target)
          }
          clearCachedQuota()
          clearCachedCatalog()
          const value = await readStatus()
          return sendJson(response, 200, { ok: true, value })
        }

        return sendJson(response, 404, { ok: false, error: 'not-found' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return sendJson(response, 500, { ok: false, error: message })
      }
    },
  })
}

export { PROVIDER_ID, PROVIDER_NAME }
