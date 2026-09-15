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
import {
  buildModelOptions,
  clearCachedCatalog,
  clearCachedQuota,
  fetchAccountQuota,
  getCachedCatalog,
  getCachedQuota,
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
): string[] {
  const catalogIds = catalog.map((model) => model.id)
  const shippedDefaults = new Set(FALLBACK_MODELS.map((model) => model.id))
  const isUntouchedDefault = stored.length > 0
    && stored.length === shippedDefaults.size
    && stored.every((id) => shippedDefaults.has(id))
  if (stored.length === 0 || isUntouchedDefault) return catalogIds
  const known = new Set(catalogIds)
  const kept = stored.filter((id) => known.has(id))
  // A stored list whose every entry left the catalog would empty the picker;
  // offering the catalog again is the recoverable answer.
  return kept.length === 0 ? catalogIds : kept
}

export interface CommandCodeStatusOptions {
  fetchFn?: typeof fetch
  /** Whether this plugin currently owns the provider route; re-read on every status. */
  serving?: boolean | (() => boolean)
  /** Diagnostic when another plugin owns the provider route; re-read on every status. */
  conflict?: string | null | (() => string | null)
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
): Promise<CommandCodeWebStatus> {
  const credentials = await store.read()
  const settings: CommandCodeModelSettings = preferences ? preferences.status() : await modelSettings.read()
  const apiEnv = credentials?.apiEnv ?? resolveApiEnv()

  const live = await loadProviderModels({ fetchFn: options.fetchFn, apiEnv })
  const catalog = live.length > 0 ? live : fallbackCatalog()
  const enabledModelIds = resolveEnabledModelIds(settings.enabledModelIds, catalog)
  const models = buildModelOptions(catalog, enabledModelIds, settings.contextWindowOverrides)
  const quota = getCachedQuota()

  return {
    authenticated: credentials !== null,
    hasCredentials: credentials !== null,
    storagePath: store.path(),
    apiEnv,
    account: quota?.account ?? (credentials === null
      ? null
      : {
          userId: credentials.userId ?? null,
          userName: credentials.userName ?? null,
          email: credentials.email ?? null,
          organizationName: credentials.organizationName ?? null,
          keyName: credentials.keyName ?? null,
          // The stored id is a machine id; show the name the service would.
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
): () => void {
  const fetchFn = options.fetchFn ?? fetch

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
          const cached = getCachedQuota()
          if (credentials !== null && (cached === undefined || Date.now() - (cached.fetchedAt || 0) > QUOTA_CACHE_TTL_MS)) {
            await fetchAccountQuota(store, fetchFn).catch(() => undefined)
          }
          const value = await getCommandCodeWebStatus(store, modelSettings, preferences, options)
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'login') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const value = await beginWebLogin(store, { fetchFn })
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
          const account = await saveApiKey(store, apiKey, { fetchFn })
          clearCachedQuota()
          const value = await getCommandCodeWebStatus(store, modelSettings, preferences, options)
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
          await fetchAccountQuota(store, fetchFn, true)
          const value = await getCommandCodeWebStatus(store, modelSettings, preferences, options)
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'models' || path === 'settings') {
          if (method === 'GET') {
            const value = await getCommandCodeWebStatus(store, modelSettings, preferences, options)
            return sendJson(response, 200, { ok: true, value })
          }
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const body = await readRequestJson(request)
          const patch: Parameters<CommandCodePreferenceStore['update']>[0] = {}
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
          const value = await getCommandCodeWebStatus(store, modelSettings, preferences, options)
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'catalog/refresh') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          clearCachedCatalog()
          await loadProviderModels({ fetchFn, force: true, apiEnv: resolveApiEnv() })
          const value = await getCommandCodeWebStatus(store, modelSettings, preferences, options)
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'logout') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          await store.delete()
          clearCachedQuota()
          clearCachedCatalog()
          const value = await getCommandCodeWebStatus(store, modelSettings, preferences, options)
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
