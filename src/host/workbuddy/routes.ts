import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  CHAT_PATH,
  CLIENT_USER_AGENT,
  DEFAULT_CONTEXT_WINDOW,
  PROVIDER_ID,
  PROVIDER_NAME,
  QUOTA_CACHE_TTL_MS,
} from './types.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  type WorkBuddyModelSettings,
  type WorkBuddyPreferenceStore,
} from './token-store.ts'
import {
  accountFromCredentials,
  clearCachedCatalog,
  clearCachedQuota,
  fetchAccountQuota,
  getCachedQuota,
  loadConfigCatalog,
  refreshCredentials,
  workBuddyHeaders,
} from './client.ts'
import {
  DEFAULT_VISIBLE_MODEL_IDS,
  FALLBACK_MODELS,
  defaultContextWindowFor,
  maxOutputTokensFor,
  modelsForRegion,
  resolveWorkBuddyModel,
  workBuddyModelSupportsImage,
  workBuddyReasoningEfforts,
  type WorkBuddyModelEntry,
} from './model-catalog.ts'
import type {
  WorkBuddyConnectionDto,
  WorkBuddyModelOption,
  WorkBuddyWebStatus,
} from '../../shared/workbuddy-contracts.ts'
import { WORKBUDDY_REASONING_EFFORTS } from '../../shared/workbuddy-contracts.ts'
import { beginWebLogin, getWebLoginStatus, resetWebLogin } from './oauth.ts'
import type { WorkBuddyAccountPool } from './account-pool.ts'

/** Membership test for one posted reasoning level; the set is catalog-wide. */
function isWorkBuddyReasoningEffort(value: unknown): value is (typeof WORKBUDDY_REASONING_EFFORTS)[number] {
  return typeof value === 'string' && (WORKBUDDY_REASONING_EFFORTS as readonly string[]).includes(value)
}

const MAX_BODY_BYTES = 64 * 1024
const ROUTE_PREFIX = '/workbuddy/api'

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

/**
 * The selection the card should show.
 *
 * A stored list that still equals the shipped default has never been edited, so
 * it cannot know about models the catalog has since added; treating it as
 * "everything this account can call" keeps a first run from hiding models
 * behind an unedited default. Any explicit edit is honoured exactly.
 */
export function resolveEnabledModelIds(
  stored: readonly string[],
  available: readonly string[],
  enabled = true,
): string[] {
  if (!enabled) return []
  const shippedDefaults = new Set(DEFAULT_VISIBLE_MODEL_IDS)
  const isUntouchedDefault = stored.length > 0
    && stored.length === shippedDefaults.size
    && stored.every((id) => shippedDefaults.has(id))
  if (isUntouchedDefault) return [...available]
  const known = new Set(available)
  return stored.filter((id) => known.has(id))
}

/** Build the model options the settings card renders, in catalog order. */
export function buildModelOptions(
  catalog: readonly WorkBuddyModelEntry[],
  available: readonly string[],
  enabledModelIds: readonly string[],
  overrides: Record<string, number>,
): WorkBuddyModelOption[] {
  const enabled = new Set(enabledModelIds)
  return available.map((id) => {
    const entry = resolveWorkBuddyModel(id, catalog)
    const defaultWindow = defaultContextWindowFor(id, catalog)
    const override = overrides[id]
    return {
      id,
      name: entry.name,
      enabled: enabled.has(id),
      defaultContextWindow: defaultWindow,
      contextWindow: typeof override === 'number' && Number.isFinite(override) && override > 0
        ? override
        : defaultWindow,
      defaultMaxTokens: maxOutputTokensFor(id, catalog),
      reasoningEfforts: [...workBuddyReasoningEfforts(id, catalog)],
      supportsImage: workBuddyModelSupportsImage(id, catalog),
      regions: [...entry.regions],
      description: entry.description,
    }
  })
}

export interface WorkBuddyStatusOptions {
  fetchFn?: typeof fetch
  /** Whether this plugin currently owns the provider route; re-read on every status. */
  serving?: boolean | (() => boolean)
  /** Diagnostic when another plugin owns the provider route; re-read on every status. */
  conflict?: string | null | (() => string | null)
  /** Multi-account pool this line schedules through; absent keeps the single-account card. */
  accountPool?: WorkBuddyAccountPool
}

function readOption<T>(value: T | (() => T) | undefined, fallback: T): T {
  return typeof value === 'function' ? (value as () => T)() : value ?? fallback
}

/** Everything the settings card renders: account, quota, and the model catalog. */
export async function getWorkBuddyWebStatus(
  store: FileCredentialStore,
  modelSettings: FileModelSettingsStore,
  preferences?: WorkBuddyPreferenceStore,
  options: WorkBuddyStatusOptions = {},
): Promise<WorkBuddyWebStatus> {
  const settings: WorkBuddyModelSettings = preferences ? preferences.status() : await modelSettings.read()
  const credentials = await store.read({ accountId: settings.selectedAccountId, hiddenAccountIds: settings.hiddenAccountIds })
  const enabled = settings.enabled !== false

  // The gateway's own catalog is the authority on capabilities; without a
  // credential (or when it is unreachable) the shipped table stands in, and the
  // card still renders a usable list before the first sign-in.
  const fetchFn = options.fetchFn ?? fetch
  const live = credentials === null
    ? []
    : await loadConfigCatalog(credentials, { fetchFn }).catch(() => [])
  const catalog = live.length > 0 ? live : FALLBACK_MODELS

  // With no credential the international list stands in, since it is the
  // superset a fresh install is most likely to want.
  const region = credentials?.region ?? 'intl'
  const available = modelsForRegion(region, catalog).map((model) => model.id)
  const enabledModelIds = resolveEnabledModelIds(settings.enabledModelIds, available, enabled)
  const models = buildModelOptions(catalog, available, enabledModelIds, settings.contextWindowOverrides)
  const quota = getCachedQuota()

  // The pool slice the shared account card renders. Read through the pool when
  // this line has one, so cooldowns and per-account auth state are reported; a
  // caller running without it gets an empty list and the legacy card.
  const poolData = options.accountPool === undefined
    ? null
    : await options.accountPool.read().catch(() => null)
  const poolAccounts = options.accountPool === undefined
    ? []
    : await options.accountPool.listAccounts().catch(() => [])
  const hiddenIds = new Set(settings.hiddenAccountIds)

  return {
    enabled,
    authenticated: credentials !== null,
    hasCredentials: credentials !== null,
    authDirectory: store.directory(),
    storagePath: modelSettings.path(),
    account: quota?.account ?? (credentials === null ? null : accountFromCredentials(credentials)),
    quota: quota ?? null,
    lastFetchedAt: quota?.fetchedAt ?? null,
    models,
    contextWindowOverrides: settings.contextWindowOverrides,
    defaultReasoningEffort: settings.defaultReasoningEffort,
    selectedAccountId: settings.selectedAccountId,
    managedStoragePath: store.managedPath(),
    serving: readOption(options.serving, true),
    conflict: readOption(options.conflict, null),
    accounts: poolAccounts.map((account) => ({ ...account, hidden: hiddenIds.has(account.id) })),
    activeAccountId: poolData?.activeAccountId,
    rotationStrategy: poolData?.rotationStrategy ?? 'sequential',
  }
}

/** Register the WorkBuddy settings routes under `/workbuddy/api`. */
export function registerWorkBuddyRoutes(
  ctx: Context,
  store: FileCredentialStore,
  modelSettings: FileModelSettingsStore,
  preferences?: WorkBuddyPreferenceStore,
  options: WorkBuddyStatusOptions = {},
): () => void {
  const fetchFn = options.fetchFn ?? fetch

  const disposeRoutes = ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url || '/', 'http://dsh.local')
      const path = url.pathname.replace(/^\/workbuddy\/api\/?/, '')
      const method = request.method ?? 'GET'

      try {
        if (path === '' || path === 'status') {
          if (method !== 'GET') return sendMethodNotAllowed(response)
          // A cached scan can hide a credential the user just created, so the
          // status read always re-reads the directory.
          const settings = preferences ? preferences.status() : await modelSettings.read()
          await store.read({ force: true, accountId: settings.selectedAccountId, hiddenAccountIds: settings.hiddenAccountIds }).catch(() => null)
          const credentials = await store.read({ accountId: settings.selectedAccountId, hiddenAccountIds: settings.hiddenAccountIds })
          const cached = getCachedQuota()
          const quotaMatches = cached?.account.id === (credentials === null ? undefined : accountFromCredentials(credentials).id)
          if (credentials !== null && (!quotaMatches || cached === undefined || Date.now() - (cached.fetchedAt || 0) > QUOTA_CACHE_TTL_MS)) {
            if (!quotaMatches) clearCachedQuota()
            await fetchAccountQuota(store, fetchFn, false, settings.selectedAccountId, settings.hiddenAccountIds).catch(() => undefined)
          }
          const value = await getWorkBuddyWebStatus(store, modelSettings, preferences, options)
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'accounts') {
          if (method !== 'GET') return sendMethodNotAllowed(response)
          const settings = preferences ? preferences.status() : await modelSettings.read()
          const hidden = new Set(settings.hiddenAccountIds)
          const accounts = await store.list()
          return sendJson(response, 200, {
            ok: true,
            value: {
              authDirectory: store.directory(),
              managedStoragePath: store.managedPath(),
              accounts: accounts.map((credentials) => {
                const account = accountFromCredentials(credentials)
                return { ...account, hidden: hidden.has(account.id) }
              }),
            },
          })
        }

        if (path === 'accounts/login') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const body = await readRequestJson(request)
          const region = body.region === 'intl' ? 'intl' : body.region === 'cn' ? 'cn' : undefined
          if (region === undefined) return sendJson(response, 400, { ok: false, error: 'A login region (cn or intl) is required.' })
          const pool = options.accountPool
          const value = await beginWebLogin(store, region, fetchFn, pool === undefined
            ? {}
            : { onSave: async (credentials) => { await store.addManaged(credentials); await pool.addAccount(credentials) } })
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'accounts/login/status') {
          if (method !== 'GET') return sendMethodNotAllowed(response)
          return sendJson(response, 200, { ok: true, value: getWebLoginStatus() })
        }

        if (path === 'accounts/action') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const body = await readRequestJson(request)
          const action = typeof body.action === 'string' ? body.action : ''
          const accountId = typeof body.accountId === 'string' ? body.accountId : ''
          if (accountId === '') return sendJson(response, 400, { ok: false, error: 'An account id is required.' })
          const settings = preferences ? preferences.status() : await modelSettings.read()
          const pool = options.accountPool

          // Pool-level actions first: they are addressed by pool account id and
          // act on scheduling state rather than on the credential itself.
          if (action === 'set-primary') {
            if (pool === undefined) return sendJson(response, 400, { ok: false, error: 'Account pool is not installed.' })
            await pool.setPrimary(accountId)
            // The pool decides routing, but the model catalog, quota and
            // connection routes read their credential through the store's
            // pinned selection, so the two must name the same account.
            const pin = { selectedAccountId: accountId }
            if (preferences) await preferences.update(pin)
            else await modelSettings.updateSettings(pin)
            store.invalidate()
            clearCachedQuota()
            clearCachedCatalog()
            const value = await getWorkBuddyWebStatus(store, modelSettings, preferences, options)
            return sendJson(response, 200, { ok: true, value })
          }
          if (action === 'set-alias') {
            if (pool === undefined) return sendJson(response, 400, { ok: false, error: 'Account pool is not installed.' })
            const alias = typeof body.alias === 'string' ? body.alias.trim() : ''
            if (alias === '') return sendJson(response, 400, { ok: false, error: 'An alias is required.' })
            await pool.setAlias(accountId, alias)
            const value = await getWorkBuddyWebStatus(store, modelSettings, preferences, options)
            return sendJson(response, 200, { ok: true, value })
          }
          if (action === 'clear-cooldown') {
            if (pool === undefined) return sendJson(response, 400, { ok: false, error: 'Account pool is not installed.' })
            await pool.clearCooldown(accountId)
            const value = await getWorkBuddyWebStatus(store, modelSettings, preferences, options)
            return sendJson(response, 200, { ok: true, value })
          }
          if (action === 'clear-auth-failure') {
            if (pool === undefined) return sendJson(response, 400, { ok: false, error: 'Account pool is not installed.' })
            await pool.clearAuthFailed(accountId)
            const value = await getWorkBuddyWebStatus(store, modelSettings, preferences, options)
            return sendJson(response, 200, { ok: true, value })
          }
          if (action === 'relogin') {
            if (pool === undefined) return sendJson(response, 400, { ok: false, error: 'Account pool is not installed.' })
            // A dead account is restored by signing in again, so the recorded
            // failure is cleared only once the new credential has landed: the
            // flow's own completion writes it through the pool.
            const target = (await pool.listAccounts()).find((account) => account.id === accountId)
            if (target === undefined) return sendJson(response, 404, { ok: false, error: 'The account was not found.' })
            const value = await beginWebLogin(store, target.region, fetchFn, {
              onSave: async (credentials) => {
                // The pool is the routing table; the store stays the read path
                // the status, quota and connection routes already use.
                await store.addManaged(credentials)
                await pool.addAccount(credentials)
                await pool.clearAuthFailed(accountId).catch(() => undefined)
              },
            })
            return sendJson(response, 200, { ok: true, value })
          }

          const accounts = await store.list()
          const target = accounts.find((candidate) => accountFromCredentials(candidate).id === accountId)
          if (target === undefined) return sendJson(response, 404, { ok: false, error: 'The account was not found.' })
          let hiddenAccountIds = settings.hiddenAccountIds
          if (action === 'delete') {
            if (target.source !== 'managed') {
              return sendJson(response, 400, { ok: false, error: 'Desktop accounts cannot be deleted by this plugin; hide the account instead.' })
            }
            await store.deleteManaged(accountId)
            // The pool is the routing table; a credential removed from the
            // store must leave it too, or the next request would pick a
            // row whose credential no longer exists.
            if (pool !== undefined) {
              await pool.read()
                .then((data) => data.accounts.some((account) => account.id === accountId))
                .then((present) => (present ? pool.deleteAccount(accountId) : undefined))
                .catch(() => undefined)
            }
          } else if (action === 'hide') {
            if (target.source !== 'desktop') return sendJson(response, 400, { ok: false, error: 'Managed accounts should be deleted, not hidden.' })
            hiddenAccountIds = [...new Set([...hiddenAccountIds, accountId])]
          } else if (action === 'restore') {
            hiddenAccountIds = hiddenAccountIds.filter((id) => id !== accountId)
          } else {
            return sendJson(response, 400, { ok: false, error: 'Unsupported account action.' })
          }
          const nextSelected = settings.selectedAccountId === accountId ? null : settings.selectedAccountId
          const patch = { hiddenAccountIds, selectedAccountId: nextSelected }
          if (preferences) await preferences.update(patch)
          else await modelSettings.updateSettings(patch)
          store.invalidate()
          clearCachedQuota()
          clearCachedCatalog()
          const value = await getWorkBuddyWebStatus(store, modelSettings, preferences, options)
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'quota') {
          if (method !== 'GET' && method !== 'POST') return sendMethodNotAllowed(response)
          // A POST forces an upstream allowance read and can rotate the stored
          // refresh token, so it carries the same same-origin requirement as
          // every other mutating route. A same-origin GET sends no Origin header
          // and therefore stays open, matching the other provider lines.
          if (method === 'POST' && !isSameOriginMutation(request)) {
            return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          }
          const settings = preferences ? preferences.status() : await modelSettings.read()
          await fetchAccountQuota(store, fetchFn, true, settings.selectedAccountId, settings.hiddenAccountIds)
          const value = await getWorkBuddyWebStatus(store, modelSettings, preferences, options)
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'connection/test') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const settings = preferences ? preferences.status() : await modelSettings.read()
          const stored = await store.read({ force: true, accountId: settings.selectedAccountId, hiddenAccountIds: settings.hiddenAccountIds })
          if (stored === null) return sendJson(response, 400, { ok: false, error: 'The selected CodeBuddy account was not found.' })
          // A stored token can be past its expiry; probing with it would report
          // a false 401 for an account whose refresh token is still good.
          const credentials = await store.ensureFresh(stored, (current) => refreshCredentials(current, { fetchFn }))

          const model = modelsForRegion(credentials.region)[0]?.id
          if (model === undefined) {
            return sendJson(response, 400, { ok: false, error: 'No model is available for this account region.' })
          }

          const startedAt = Date.now()
          const body = JSON.stringify({
            model,
            messages: [
              { role: 'system', content: 'You are a helpful assistant.' },
              { role: 'user', content: 'ping' },
            ],
            stream: true,
            max_tokens: 1,
            stream_options: { include_usage: true },
          })
          const probe = await fetchFn(`${credentials.backend}${CHAT_PATH}`, {
            method: 'POST',
            headers: workBuddyHeaders(credentials, { accept: 'text/event-stream', 'user-agent': CLIENT_USER_AGENT }),
            body,
            signal: AbortSignal.timeout(30_000),
          })
          const detail = await probe.text().catch(() => '')
          if (!probe.ok) {
            return sendJson(response, 200, {
              ok: false,
              error: `${PROVIDER_NAME} rejected the probe (${probe.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`,
            })
          }

          const value: WorkBuddyConnectionDto = {
            connected: true,
            account: accountFromCredentials(credentials),
            latencyMs: Date.now() - startedAt,
            model,
            checkedAt: Date.now(),
          }
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'models' || path === 'settings') {
          if (method === 'GET') {
            const value = await getWorkBuddyWebStatus(store, modelSettings, preferences, options)
            return sendJson(response, 200, { ok: true, value })
          }
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const body = await readRequestJson(request)
          const patch: Parameters<WorkBuddyPreferenceStore['update']>[0] = {}
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
            if (effort === null || isWorkBuddyReasoningEffort(effort)) {
              patch.defaultReasoningEffort = effort
            }
          }
          if (body.selectedAccountId !== undefined) {
            const selected = body.selectedAccountId
            if (selected === null || typeof selected === 'string') {
              if (selected !== null) {
                const settings = preferences ? preferences.status() : await modelSettings.read()
                const accounts = await store.list()
                if (settings.hiddenAccountIds.includes(selected)
                  || !accounts.some((candidate) => accountFromCredentials(candidate).id === selected)) {
                  return sendJson(response, 400, { ok: false, error: 'The selected CodeBuddy account was not found.' })
                }
              }
              patch.selectedAccountId = selected
              store.invalidate()
              clearCachedQuota()
              clearCachedCatalog()
            }
          }
          if (preferences) await preferences.update(patch)
          else await modelSettings.updateSettings(patch)
          const value = await getWorkBuddyWebStatus(store, modelSettings, preferences, options)
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'catalog/refresh') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const settings = preferences ? preferences.status() : await modelSettings.read()
          const stored = await store.read({ force: true, accountId: settings.selectedAccountId, hiddenAccountIds: settings.hiddenAccountIds })
          if (stored === null) return sendJson(response, 400, { ok: false, error: 'The selected CodeBuddy account was not found.' })
          const credentials = await store.ensureFresh(stored, (current) => refreshCredentials(current, { fetchFn }))
          clearCachedCatalog()
          await loadConfigCatalog(credentials, { fetchFn, force: true }).catch(() => undefined)
          const value = await getWorkBuddyWebStatus(store, modelSettings, preferences, options)
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'accounts/strategy') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const pool = options.accountPool
          if (pool === undefined) return sendJson(response, 400, { ok: false, error: 'Account pool is not installed.' })
          const body = await readRequestJson(request)
          const strategy = body.strategy
          if (strategy !== 'sequential' && strategy !== 'round-robin' && strategy !== 'sticky') {
            return sendJson(response, 400, { ok: false, error: 'Unsupported rotation strategy.' })
          }
          await pool.setStrategy(strategy)
          const value = await getWorkBuddyWebStatus(store, modelSettings, preferences, options)
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'rescan') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          store.invalidate()
          clearCachedQuota()
          clearCachedCatalog()
          const settings = preferences ? preferences.status() : await modelSettings.read()
          await store.read({ force: true, accountId: settings.selectedAccountId, hiddenAccountIds: settings.hiddenAccountIds }).catch(() => null)
          const value = await getWorkBuddyWebStatus(store, modelSettings, preferences, options)
          return sendJson(response, 200, { ok: true, value })
        }

        return sendJson(response, 404, { ok: false, error: 'not-found' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return sendJson(response, 500, { ok: false, error: message })
      }
    },
  })
  // A browser login polls the gateway for up to five minutes; it must not
  // outlive the routes and the card that reported it.
  return () => {
    resetWebLogin()
    disposeRoutes()
  }
}

export {
  PROVIDER_ID,
  PROVIDER_NAME,
  DEFAULT_CONTEXT_WINDOW,
  getCachedQuota,
  type WorkBuddyModelOption,
  type WorkBuddyWebStatus,
}
