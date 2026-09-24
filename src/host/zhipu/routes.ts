import type { Context } from '@deepseek-ai/cordis'
import { isSameOriginMutation } from '../common/same-origin.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  CHAT_PATH,
  DEFAULT_CONTEXT_WINDOW,
  PROVIDER_ID,
  PROVIDER_NAME,
  QUOTA_CACHE_TTL_MS,
  apiBaseForRegion,
  normalizeRegion,
} from './types.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  zhipuAccountKey,
  zhipuKeyHint,
  type ZhipuCredentials,
  type ZhipuModelSettings,
  type ZhipuPreferenceStore,
} from './token-store.ts'
import {
  DEFAULT_VISIBLE_MODEL_IDS,
  FALLBACK_MODELS,
  defaultContextWindowFor,
  maxOutputTokensFor,
  modelsForRegion,
  resolveZhipuModel,
  zhipuModelSupportsImage,
  zhipuReasoningEfforts,
  type ZhipuModelEntry,
} from './model-catalog.ts'
import {
  accountFromCredentials,
  clearCachedCatalog,
  clearCachedQuota,
  fetchAccountQuota,
  getCachedQuota,
  loadCatalog,
  parseCatalogModels,
  verifyApiKey,
  zhipuHeaders,
} from './client.ts'
import type {
  ZhipuAccountSummaryDto,
  ZhipuConnectionDto,
  ZhipuModelOption,
  ZhipuWebStatus,
} from '../../shared/zhipu-contracts.ts'
import { ZHIPU_REASONING_EFFORTS } from '../../shared/zhipu-contracts.ts'
import type { ZhipuAccountPool } from './account-pool.ts'
import type { ContextWindowOverridePatch } from '../common/context-window-overrides.ts'

/** Membership test for one posted reasoning level; the set is catalog-wide. */
function isZhipuReasoningEffort(value: unknown): value is (typeof ZHIPU_REASONING_EFFORTS)[number] {
  return typeof value === 'string' && (ZHIPU_REASONING_EFFORTS as readonly string[]).includes(value)
}

const MAX_BODY_BYTES = 64 * 1024
const MAX_API_KEY_BYTES = 4 * 1024
const ROUTE_PREFIX = '/zhipu/api'

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
  catalog: readonly ZhipuModelEntry[],
  available: readonly string[],
  enabledModelIds: readonly string[],
  overrides: Record<string, number>,
): ZhipuModelOption[] {
  const enabled = new Set(enabledModelIds)
  return available.map((id) => {
    const entry = resolveZhipuModel(id, catalog)
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
      reasoningEfforts: [...zhipuReasoningEfforts(id, catalog)],
      supportsImage: zhipuModelSupportsImage(id, catalog),
      regions: [...entry.regions],
      ...(entry.description === undefined ? {} : { description: entry.description }),
    }
  })
}

export interface ZhipuStatusOptions {
  fetchFn?: typeof fetch
  /** Whether this plugin currently owns the provider route; re-read on every status. */
  serving?: boolean | (() => boolean)
  /** Diagnostic when another plugin owns the provider route; re-read on every status. */
  conflict?: string | null | (() => string | null)
  /** Multi-account pool this line schedules through; absent keeps the single-account card. */
  accountPool?: ZhipuAccountPool
}

function readOption<T>(value: T | (() => T) | undefined, fallback: T): T {
  return typeof value === 'function' ? (value as () => T)() : value ?? fallback
}

/** Everything the settings card renders: account, quota, and the model catalog. */
export async function getZhipuWebStatus(
  store: FileCredentialStore,
  modelSettings: FileModelSettingsStore,
  preferences?: ZhipuPreferenceStore,
  options: ZhipuStatusOptions = {},
  quotaError: string | null = null,
): Promise<ZhipuWebStatus> {
  const settings: ZhipuModelSettings = preferences ? preferences.status() : await modelSettings.read()
  const credentials = await store.read()
  const enabled = settings.enabled !== false

  // The live listing is the authority on each model's window; without a
  // credential (or when it is unreachable) the shipped table stands in, and the
  // card still renders a usable list before the first sign-in.
  const fetchFn = options.fetchFn ?? fetch
  const live = credentials === null ? [] : await loadCatalog(credentials, { fetchFn }).catch(() => [])
  const catalog = live.length > 0 ? live : FALLBACK_MODELS

  // With no credential the international list stands in, since it serves the
  // same model set and is the superset a fresh install is most likely to want.
  const region = credentials?.region ?? 'intl'
  const available = modelsForRegion(region, catalog).map((model) => model.id)
  const enabledModelIds = resolveEnabledModelIds(settings.enabledModelIds, available, enabled)
  const models = buildModelOptions(catalog, available, enabledModelIds, settings.contextWindowOverrides)
  const quota = getCachedQuota()

  const poolData = options.accountPool === undefined
    ? null
    : await options.accountPool.read().catch(() => null)
  const poolAccounts = options.accountPool === undefined
    ? []
    : await options.accountPool.listAccounts().catch(() => [])

  const account = credentials === null ? null : accountFromCredentials(credentials)
  return {
    enabled,
    authenticated: credentials !== null,
    hasCredentials: credentials !== null,
    storagePath: store.path(),
    account,
    quota: quota ?? null,
    lastFetchedAt: quota?.fetchedAt ?? null,
    models,
    contextWindowOverrides: settings.contextWindowOverrides,
    defaultReasoningEffort: settings.defaultReasoningEffort,
    selectedAccountId: settings.selectedAccountId,
    serving: readOption(options.serving, true),
    conflict: readOption(options.conflict, null),
    quotaError,
    ...(options.accountPool === undefined
      ? {}
      : {
          accounts: poolAccounts.map((summary): ZhipuAccountSummaryDto => summary),
          ...(poolData?.activeAccountId === undefined ? {} : { activeAccountId: poolData.activeAccountId }),
          rotationStrategy: poolData?.rotationStrategy ?? 'sequential',
        }),
  }
}

/** Register the GLM Coding Plan settings routes under `/zhipu/api`. */
export function registerZhipuRoutes(
  ctx: Context,
  store: FileCredentialStore,
  modelSettings: FileModelSettingsStore,
  preferences?: ZhipuPreferenceStore,
  options: ZhipuStatusOptions = {},
): () => void {
  const fetchFn = options.fetchFn ?? fetch

  const readStatus = (quotaError: string | null = null): Promise<ZhipuWebStatus> =>
    getZhipuWebStatus(store, modelSettings, preferences, options, quotaError)

  return ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url || '/', 'http://dsh.local')
      const path = url.pathname.replace(/^\/zhipu\/api\/?/, '')
      const method = request.method ?? 'GET'

      try {
        if (path === '' || path === 'status') {
          if (method !== 'GET') return sendMethodNotAllowed(response)
          const credentials = await store.read().catch(() => null)
          const cached = getCachedQuota()
          const accountId = credentials === null ? null : zhipuAccountKey(credentials)
          const stale = cached === undefined
            || cached.account.id !== accountId
            || Date.now() - (cached.fetchedAt || 0) > QUOTA_CACHE_TTL_MS
          let quotaError: string | null = null
          // The status route refreshes a stale quota cache; a failure is
          // reported alongside the status rather than failing the whole read, so
          // the card can show why the meters are missing.
          if (credentials !== null && stale) {
            if (cached !== undefined && cached.account.id !== accountId) clearCachedQuota()
            try {
              await fetchAccountQuota(credentials, { fetchFn })
            } catch (error) {
              quotaError = error instanceof Error ? error.message : String(error)
            }
          }
          const value = await readStatus(quotaError)
          return sendJson(response, 200, { ok: true, value })
        }

        /**
         * Save one pasted API key, after proving it works.
         *
         * Verification happens before anything is persisted: the key is used to
         * read the deployment's own model listing, so a key from the wrong
         * console (the general open platform, or the other region) is rejected
         * here with a message naming the console it belongs to, instead of
         * failing later inside a conversation. The listing that verified the key
         * is cached, so signing in costs one upstream read in total.
         */
        if (path === 'accounts/add') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const body = await readRequestJson(request)
          const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
          if (apiKey === '') return sendJson(response, 400, { ok: false, error: 'An API key is required.' })
          if (apiKey.length > MAX_API_KEY_BYTES) return sendJson(response, 400, { ok: false, error: 'The API key is too long.' })
          const region = normalizeRegion(body.region) ?? 'intl'

          let verified: ZhipuModelEntry[]
          try {
            verified = await verifyApiKey(apiKey, region, { fetchFn })
          } catch (error) {
            return sendJson(response, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }

          const credentials: ZhipuCredentials = {
            apiKey,
            region,
            apiBase: apiBaseForRegion(region),
            authenticatedAt: Date.now(),
          }
          const alias = typeof body.alias === 'string' && body.alias.trim() !== '' ? body.alias.trim() : undefined
          const pool = options.accountPool
          if (pool === undefined) {
            await store.write(credentials)
          } else {
            // The pool is the routing table; the store keeps the mirrored
            // primary so the picker and the single-credential path agree.
            await pool.addAccount(credentials, alias)
          }
          // The listing this sign-in verified is the freshest catalog available,
          // so it is recorded instead of being fetched a second time.
          if (verified.length > 0) clearCachedCatalog()
          clearCachedQuota()
          const value = await readStatus()
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'accounts/remove') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const body = await readRequestJson(request)
          const accountId = typeof body.accountId === 'string' ? body.accountId : ''
          const pool = options.accountPool
          if (pool === undefined) {
            await store.delete()
          } else {
            if (accountId === '') return sendJson(response, 400, { ok: false, error: 'An account id is required.' })
            await pool.deleteAccount(accountId)
          }
          clearCachedQuota()
          clearCachedCatalog()
          const value = await readStatus()
          return sendJson(response, 200, { ok: true, value })
        }

        /**
         * One account-pool action, answered with the refreshed status.
         *
         * The card never has to guess what the pool looks like afterwards, which
         * is the contract every sibling provider line already offers.
         */
        if (path === 'accounts/action') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const pool = options.accountPool
          if (pool === undefined) return sendJson(response, 400, { ok: false, error: 'Account pool is not installed.' })
          const body = await readRequestJson(request)
          const action = typeof body.action === 'string' ? body.action : ''
          const accountId = typeof body.accountId === 'string' ? body.accountId : ''
          if (accountId === '') return sendJson(response, 400, { ok: false, error: 'An account id is required.' })

          if (action === 'set-primary') {
            await pool.setPrimary(accountId)
            const pin = { selectedAccountId: accountId }
            if (preferences) await preferences.update(pin)
            else await modelSettings.updateSettings(pin)
            clearCachedQuota()
            clearCachedCatalog()
            return sendJson(response, 200, { ok: true, value: await readStatus() })
          }
          if (action === 'set-alias') {
            const alias = typeof body.alias === 'string' ? body.alias.trim() : ''
            if (alias === '') return sendJson(response, 400, { ok: false, error: 'An alias is required.' })
            await pool.setAlias(accountId, alias)
            return sendJson(response, 200, { ok: true, value: await readStatus() })
          }
          if (action === 'clear-cooldown') {
            await pool.clearCooldown(accountId)
            return sendJson(response, 200, { ok: true, value: await readStatus() })
          }
          if (action === 'clear-auth-failure') {
            await pool.clearAuthFailed(accountId)
            return sendJson(response, 200, { ok: true, value: await readStatus() })
          }
          if (action === 'strategy') {
            const strategy = body.strategy
            if (strategy !== 'sequential' && strategy !== 'round-robin' && strategy !== 'sticky') {
              return sendJson(response, 400, { ok: false, error: 'Unsupported rotation strategy.' })
            }
            await pool.setStrategy(strategy)
            return sendJson(response, 200, { ok: true, value: await readStatus() })
          }
          if (action === 'delete') {
            await pool.deleteAccount(accountId)
            clearCachedQuota()
            clearCachedCatalog()
            return sendJson(response, 200, { ok: true, value: await readStatus() })
          }
          return sendJson(response, 400, { ok: false, error: 'Unsupported account action.' })
        }

        if (path === 'quota') {
          if (method !== 'GET' && method !== 'POST') return sendMethodNotAllowed(response)
          if (method === 'POST' && !isSameOriginMutation(request)) {
            return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          }
          const credentials = await store.read()
          if (credentials === null) return sendJson(response, 400, { ok: false, error: 'Not signed in.' })
          let quotaError: string | null = null
          try {
            await fetchAccountQuota(credentials, { fetchFn, force: method === 'POST' })
          } catch (error) {
            quotaError = error instanceof Error ? error.message : String(error)
          }
          const value = await readStatus(quotaError)
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'connection/test') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const credentials = await store.read()
          if (credentials === null) return sendJson(response, 400, { ok: false, error: 'Not signed in.' })

          const catalog = await loadCatalog(credentials, { fetchFn }).catch(() => [])
          const model = modelsForRegion(credentials.region, catalog.length > 0 ? catalog : FALLBACK_MODELS)[0]?.id
          if (model === undefined) {
            return sendJson(response, 400, { ok: false, error: 'No model is available for this account region.' })
          }

          const startedAt = Date.now()
          // A one-token streaming probe: it proves the key works on the *chat*
          // surface, which is what a conversation actually needs. The `/models`
          // read that verified the key says nothing about the chat route.
          const probe = await fetchFn(`${credentials.apiBase}${CHAT_PATH}`, {
            method: 'POST',
            headers: zhipuHeaders(credentials, { accept: 'text/event-stream' }),
            body: JSON.stringify({
              model,
              messages: [{ role: 'user', content: 'ping' }],
              stream: true,
              max_tokens: 1,
            }),
            signal: AbortSignal.timeout(30_000),
          })
          const detail = await probe.text().catch(() => '')
          if (!probe.ok) {
            return sendJson(response, 200, {
              ok: false,
              error: `${PROVIDER_NAME} rejected the probe (${probe.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`,
            })
          }

          const value: ZhipuConnectionDto = {
            connected: true,
            account: accountFromCredentials(credentials),
            latencyMs: Date.now() - startedAt,
            model,
            checkedAt: Date.now(),
          }
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'catalog/refresh') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const credentials = await store.read()
          if (credentials !== null) {
            clearCachedCatalog()
            await loadCatalog(credentials, { fetchFn, force: true }).catch(() => undefined)
          }
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
          const patch: Parameters<ZhipuPreferenceStore['update']>[0] = {}
          if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
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
            if (effort === null || isZhipuReasoningEffort(effort)) patch.defaultReasoningEffort = effort
          }
          if (body.selectedAccountId !== undefined) {
            const selected = body.selectedAccountId
            if (selected !== null && typeof selected !== 'string') {
              return sendJson(response, 400, { ok: false, error: 'The selected account id is invalid.' })
            }
            patch.selectedAccountId = selected
            clearCachedQuota()
            clearCachedCatalog()
          }
          if (preferences) await preferences.update(patch)
          else await modelSettings.updateSettings(patch)
          if (patch.enabledModelIds !== undefined || patch.enabled !== undefined || patch.selectedAccountId !== undefined) {
            ctx.emit?.('llm/adapters-updated')
          }
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

export {
  PROVIDER_ID,
  PROVIDER_NAME,
  DEFAULT_CONTEXT_WINDOW,
  getCachedQuota,
  zhipuKeyHint,
  parseCatalogModels,
  type ZhipuCredentials,
  type ZhipuModelEntry,
  type ZhipuModelOption,
  type ZhipuWebStatus,
}
