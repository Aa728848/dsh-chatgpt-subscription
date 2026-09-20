import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { FALLBACK_MODELS, PROVIDER_ID, PROVIDER_NAME, QUOTA_CACHE_TTL_MS, resolveApiEnv } from './types.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  type CommandCodeCatalogModel,
  type CommandCodeModelSettings,
  type CommandCodePreferenceStore,
} from './token-store.ts'
import { CommandCodeAccountPool } from './account-pool.ts'
import {
  buildModelOptions,
  clearCachedCatalog,
  clearCachedQuota,
  fetchAccountQuota,
  getCachedCatalog,
  getCachedQuotaFor,
  loadProviderModels,
  parseWhoami,
  verifyApiKey,
  whoami,
} from './client.ts'
import { beginWebLogin, getWebLoginStatus, saveApiKey } from './oauth.ts'
import { commandCodePlanLabel } from './plans.ts'
import type { CommandCodeApiEnv, CommandCodeWebStatus } from '../../shared/command-code-contracts.ts'
import { COMMAND_CODE_REASONING_EFFORTS } from '../../shared/command-code-contracts.ts'

/** Membership test for one posted reasoning level; the set is registry-wide, not per model. */
function isCommandCodeReasoningEffort(value: unknown): value is (typeof COMMAND_CODE_REASONING_EFFORTS)[number] {
  return typeof value === 'string' && (COMMAND_CODE_REASONING_EFFORTS as readonly string[]).includes(value)
}

const MAX_BODY_BYTES = 64 * 1024
const ROUTE_PREFIX = '/command-code/api'

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

function sendMethodNotAllowed(response: ServerResponse): void {
  sendJson(response, 405, { ok: false, error: 'Method Not Allowed' })
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

function fallbackCatalog(): CommandCodeCatalogModel[] {
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
  catalog: readonly CommandCodeCatalogModel[],
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

export interface CommandCodeStatusOptions {
  fetchFn?: typeof fetch
  /** Whether this plugin currently owns the provider route; re-read on every status. */
  serving?: boolean | (() => boolean)
  /** Diagnostic when another plugin owns the provider route; re-read on every status. */
  conflict?: string | null | (() => string | null)
  /**
   * Account pool instance used for multi-account management.
   *
   * Only the plugin entry installs one, because it owns the pool's storage. A
   * caller that passes none keeps the single-key behavior, and no code path
   * invents pool state that would outlive the process.
   */
  accountPool?: CommandCodeAccountPool
}

function readOption<T>(value: T | (() => T) | undefined, fallback: T): T {
  return typeof value === 'function' ? (value as () => T)() : value ?? fallback
}

/** Everything the settings card renders: account, quota, and the model catalog. */
export async function getCommandCodeWebStatus(
  store: FileCredentialStore,
  modelSettings: FileModelSettingsStore,
  preferences?: CommandCodePreferenceStore,
  options: CommandCodeStatusOptions = {},
  accountPool: CommandCodeAccountPool | undefined = options.accountPool,
): Promise<CommandCodeWebStatus> {
  const credentials = await store.read()
  const settings: CommandCodeModelSettings = preferences ? preferences.status() : await modelSettings.read()

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

  // The catalog and the key belong to the active account, not to whichever
  // credential happens to sit in the pre-pool mirror file.
  const apiEnv = activePoolAccount?.credentials.apiEnv ?? credentials?.apiEnv ?? resolveApiEnv()
  const live = await loadProviderModels({ fetchFn: options.fetchFn, apiEnv })
  const catalog = live.length > 0 ? live : fallbackCatalog()
  const enabled = settings.enabled !== false
  const enabledModelIds = resolveEnabledModelIds(settings.enabledModelIds, catalog, enabled)
  const models = buildModelOptions(catalog, enabledModelIds, settings.contextWindowOverrides)
  // Only a snapshot that belongs to the displayed account may be rendered.
  const quota = getCachedQuotaFor(activeAccount?.id ?? null)

  const activeAccountView = activePoolAccount === undefined
    ? null
    : {
        userId: activePoolAccount.userId ?? activePoolAccount.credentials.userId ?? null,
        userName: activePoolAccount.userName ?? activePoolAccount.credentials.userName ?? null,
        email: activePoolAccount.email ?? activePoolAccount.credentials.email ?? null,
        organizationName: activePoolAccount.organizationName ?? activePoolAccount.credentials.organizationName ?? null,
        keyName: activePoolAccount.keyName ?? activePoolAccount.credentials.keyName ?? null,
        // The stored id is a machine id; show the name the service would.
        planLabel: commandCodePlanLabel(activePoolAccount.credentials.planId ?? activePoolAccount.planId)
          ?? activePoolAccount.credentials.planLabel
          ?? activePoolAccount.planLabel
          ?? null,
        planId: activePoolAccount.credentials.planId ?? activePoolAccount.planId ?? null,
        authenticatedAt: activePoolAccount.credentials.authenticatedAt ?? null,
      }

  return {
    enabled,
    authenticated: accounts.length > 0 || credentials !== null,
    hasCredentials: accounts.length > 0 || credentials !== null,
    storagePath: store.path(),
    apiEnv,
    accounts,
    ...(poolData?.activeAccountId === undefined ? {} : { activeAccountId: poolData.activeAccountId }),
    rotationStrategy: poolData?.rotationStrategy ?? 'sequential',
    account: quota?.account ?? activeAccountView ?? (credentials === null
      ? null
      : {
          userId: credentials.userId ?? null,
          userName: credentials.userName ?? null,
          email: credentials.email ?? null,
          organizationName: credentials.organizationName ?? null,
          keyName: credentials.keyName ?? null,
          planLabel: commandCodePlanLabel(credentials.planId) ?? credentials.planLabel ?? null,
          planId: credentials.planId ?? null,
          authenticatedAt: credentials.authenticatedAt ?? null,
        }),
    quota: quota ?? null,
    lastFetchedAt: quota?.fetchedAt ?? null,
    models,
    contextWindowOverrides: settings.contextWindowOverrides,
    defaultReasoningEffort: settings.defaultReasoningEffort,
    serving: readOption(options.serving, true),
    conflict: readOption(options.conflict, null),
  }
}

/** Register the Command Code settings routes under `/command-code/api`. */
export function registerCommandCodeRoutes(
  ctx: Context,
  store: FileCredentialStore,
  modelSettings: FileModelSettingsStore,
  preferences?: CommandCodePreferenceStore,
  options: CommandCodeStatusOptions = {},
  accountPool: CommandCodeAccountPool | undefined = options.accountPool,
): () => void {
  const fetchFn = options.fetchFn ?? fetch
  const readStatus = (): Promise<CommandCodeWebStatus> =>
    getCommandCodeWebStatus(store, modelSettings, preferences, options, accountPool)
  /**
   * Read the credential of the account that would serve the next request.
   *
   * Quota belongs to a key, not to the file the plugin cached a key in: with a
   * pool the active account is the one whose usage the card renders.
   */
  const quotaStore = {
    read: async () => {
      if (accountPool === undefined) return store.read()
      const data = await accountPool.read().catch(() => null)
      const target = data?.activeAccountId === undefined
        ? (data?.accounts.find((account) => account.isPrimary) ?? data?.accounts[0])
        : data.accounts.find((account) => account.id === data.activeAccountId)
      return target?.credentials ?? store.read()
    },
  }
  const activeAccountId = async (): Promise<string | undefined> => {
    const data = accountPool === undefined ? null : await accountPool.read().catch(() => null)
    return data?.activeAccountId
      ?? data?.accounts.find((account) => account.isPrimary)?.id
      ?? data?.accounts[0]?.id
  }

  return ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url || '/', 'http://dsh.local')
      const path = url.pathname.replace(/^\/command-code\/api\/?/, '')
      const method = request.method ?? 'GET'

      try {
        if (path === '' || path === 'status') {
          if (method !== 'GET') return sendMethodNotAllowed(response)
          const credentials = await store.read()
          const targetId = await activeAccountId()
          const cached = getCachedQuotaFor(targetId)
          if ((credentials !== null || targetId !== undefined)
            && (cached === undefined || Date.now() - (cached.fetchedAt || 0) > QUOTA_CACHE_TTL_MS)) {
            await fetchAccountQuota(quotaStore, fetchFn, false, targetId).catch(() => undefined)
          }
          const value = await readStatus()
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'login') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const value = await beginWebLogin(store, {
            fetchFn,
            ...(accountPool === undefined ? {} : { onSave: (credentials) => accountPool.addAccount(credentials) }),
          })
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'login/status') {
          if (method !== 'GET') return sendMethodNotAllowed(response)
          return sendJson(response, 200, { ok: true, value: getWebLoginStatus() })
        }

        if (path === 'login/apikey') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const body = await readRequestJson(request)
          const apiKey = typeof body.apiKey === 'string' ? body.apiKey : ''
          const account = await saveApiKey(store, apiKey, {
            fetchFn,
            ...(accountPool === undefined ? {} : { onSave: (credentials) => accountPool.addAccount(credentials) }),
          })
          clearCachedQuota()
          const value = await readStatus()
          return sendJson(response, 200, { ok: true, value: { ...value, account } })
        }

        if (path === 'connection/test') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const credentials = await store.read()
          if (credentials === null) return sendJson(response, 400, { ok: false, error: 'Not signed in.' })
          const startedAt = Date.now()
          const payload = await whoami(credentials.apiKey, { fetchFn, apiEnv: credentials.apiEnv ?? resolveApiEnv() })
          return sendJson(response, 200, {
            ok: true,
            value: {
              connected: true,
              latencyMs: Date.now() - startedAt,
              account: parseWhoami(payload, {
                userId: credentials.userId,
                userName: credentials.userName,
                email: credentials.email,
                keyName: credentials.keyName,
                planLabel: credentials.planLabel,
                planId: credentials.planId,
                authenticatedAt: credentials.authenticatedAt ?? null,
              }),
            },
          })
        }

        if (path === 'quota') {
          if (method !== 'GET' && method !== 'POST') return sendMethodNotAllowed(response)
          await fetchAccountQuota(quotaStore, fetchFn, true, await activeAccountId())
          const value = await readStatus()
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'models' || path === 'settings') {
          if (method === 'GET') {
            const value = await readStatus()
            return sendJson(response, 200, { ok: true, value })
          }
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const body = await readRequestJson(request)
          const patch: Parameters<CommandCodePreferenceStore['update']>[0] = {}
          if (typeof body.enabled === 'boolean') {
            patch.enabled = body.enabled
          }
          if (Array.isArray(body.enabledModelIds)) {
            patch.enabledModelIds = body.enabledModelIds.filter((id): id is string => typeof id === 'string')
          }
          if (typeof body.contextWindowOverrides === 'object' && body.contextWindowOverrides !== null) {
            const overrides: Record<string, number> = {}
            for (const [key, raw] of Object.entries(body.contextWindowOverrides as Record<string, unknown>)) {
              if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) overrides[key] = Math.floor(raw)
            }
            patch.contextWindowOverrides = overrides
          }
          if (body.defaultReasoningEffort !== undefined) {
            const effort = body.defaultReasoningEffort
            if (effort === null || isCommandCodeReasoningEffort(effort)) {
              patch.defaultReasoningEffort = effort
            }
          }
          if (preferences) await preferences.update(patch)
          else await modelSettings.updateSettings(patch)
          const value = await readStatus()
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'catalog/refresh') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          clearCachedCatalog()
          await loadProviderModels({ fetchFn, force: true, apiEnv: resolveApiEnv() })
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
            // Re-signing in is what restores a rejected key, so nothing is
            // deleted: the account keeps its alias and place in the rotation.
            await accountPool.clearAuthFailed(accountId)
          }
          // Quota and catalog belong to the account that just changed.
          clearCachedQuota()
          clearCachedCatalog()
          const value = await readStatus()
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'logout') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          if (accountPool === undefined) {
            await store.delete()
          } else {
            // Without an explicit account, the one that would serve the next
            // request goes and the pool promotes another; that is what the card's
            // single sign-out button means once a pool exists.
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

export { PROVIDER_ID, PROVIDER_NAME, type CommandCodeApiEnv, getCachedCatalog }
