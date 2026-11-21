import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isSameOriginMutation } from '../common/same-origin.ts'
import type { ContextWindowOverridePatch } from '../common/context-window-overrides.ts'
import {
  CLAUDE_API_DEFAULT_BASE_URL,
  CLAUDE_API_PROVIDER_ID,
  CLAUDE_API_ROUTE_PREFIX,
  isClaudeApiCacheTtl,
  isClaudeApiReasoningEffort,
  normalizeClaudeApiBaseUrl,
  type ClaudeApiConnectionDto,
  type ClaudeApiStatusDto,
} from '../../shared/claude-api-contracts.ts'
import type { ClaudeApiCatalogManager } from './catalog-manager.ts'
import { testClaudeApiConnection } from './client.ts'
import type { ClaudeApiClientVersionResolver } from './client-version.ts'
import { claudeApiModelOptions } from './model-catalog.ts'
import type {
  ClaudeApiCredentialStore,
  ClaudeApiSettingsPatch,
  ClaudeApiSettingsStore,
} from './token-store.ts'

const MAX_BODY_BYTES = 64 * 1024
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}
function methodNotAllowed(response: ServerResponse): void { sendJson(response, 405, { ok: false, error: 'Method Not Allowed' }) }
function crossOrigin(response: ServerResponse): void { sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' }) }
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    request.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) { reject(new Error('Request body too large')); request.destroy(); return }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      try { resolve(raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>) }
      catch { reject(new Error('Malformed JSON request')) }
    })
    request.on('error', reject)
  })
}
function readOption<T>(value: T | (() => T) | undefined, fallback: T): T {
  return typeof value === 'function' ? (value as () => T)() : value ?? fallback
}

export interface ClaudeApiRouteDeps {
  version: ClaudeApiClientVersionResolver
  serving?: boolean | (() => boolean)
  conflict?: string | null | (() => string | null)
  fetchFn?: typeof fetch
}

/** Local-first status; the network refresh begins behind the answer. */
export async function getClaudeApiWebStatus(
  store: ClaudeApiCredentialStore,
  settingsStore: ClaudeApiSettingsStore,
  catalog: ClaudeApiCatalogManager,
  deps: ClaudeApiRouteDeps,
): Promise<ClaudeApiStatusDto> {
  const [credentials, settings] = await Promise.all([
    store.read().catch(() => null),
    settingsStore.read(),
    catalog.warm(),
  ])
  const snapshot = catalog.snapshot()
  const models = claudeApiModelOptions(snapshot.entries, settings, snapshot.live)
  if (credentials !== null) catalog.startRefresh(false)
  return {
    providerId: CLAUDE_API_PROVIDER_ID,
    enabled: settings.enabled,
    authenticated: credentials !== null,
    storagePath: store.path(),
    baseUrl: settings.baseUrl,
    defaultBaseUrl: CLAUDE_API_DEFAULT_BASE_URL,
    models,
    contextWindowOverrides: settings.contextWindowOverrides,
    defaultReasoningEffort: settings.defaultReasoningEffort,
    cacheTtl: settings.cacheTtl,
    fastMode: settings.fastMode,
    serverCompaction: settings.serverCompaction,
    clientVersion: deps.version.current(),
    catalog: credentials === null ? { state: 'idle', fetchedAt: null, error: null } : catalog.dto(),
    serving: readOption(deps.serving, true),
    conflict: readOption(deps.conflict, null),
  }
}

function parseSettingsPatch(body: Record<string, unknown>, catalog: ClaudeApiCatalogManager): ClaudeApiSettingsPatch {
  const ids = new Set(catalog.snapshot().entries.map(entry => entry.id))
  const patch: ClaudeApiSettingsPatch = {}
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new Error('enabled must be boolean')
    patch.enabled = body.enabled
  }
  if (body.baseUrl !== undefined) {
    if (body.baseUrl === null) patch.baseUrl = null
    else {
      const normalized = normalizeClaudeApiBaseUrl(body.baseUrl)
      if (!normalized.ok) throw new Error('Invalid baseUrl (' + normalized.reason + ').')
      patch.baseUrl = normalized.value
    }
  }
  if (body.enabledModelIds !== undefined) {
    // null is the shipped default, not a patch value: an empty array is the explicit all-off.
    if (!Array.isArray(body.enabledModelIds) || body.enabledModelIds.some(id => typeof id !== 'string')) throw new Error('enabledModelIds must be a string array')
    const selected = [...new Set(body.enabledModelIds as string[])]
    if (selected.some(id => !ids.has(id))) throw new Error('enabledModelIds contains a model outside the current catalog')
    patch.enabledModelIds = selected
  }
  if (body.contextWindowOverrides !== undefined) {
    if (typeof body.contextWindowOverrides !== 'object' || body.contextWindowOverrides === null || Array.isArray(body.contextWindowOverrides)) throw new Error('contextWindowOverrides must be an object')
    const overrides: ContextWindowOverridePatch = {}
    for (const [id, value] of Object.entries(body.contextWindowOverrides)) {
      if (!ids.has(id)) throw new Error('contextWindowOverrides contains an unknown model')
      if (value === null) overrides[id] = null
      else if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 10_000_000) overrides[id] = value
      else throw new Error('context window override must be null or a positive safe integer')
    }
    patch.contextWindowOverrides = overrides
  }
  if (body.defaultReasoningEffort !== undefined) {
    if (body.defaultReasoningEffort !== null && !isClaudeApiReasoningEffort(body.defaultReasoningEffort)) throw new Error('invalid reasoning effort')
    patch.defaultReasoningEffort = body.defaultReasoningEffort
  }
  if (body.cacheTtl !== undefined) {
    if (!isClaudeApiCacheTtl(body.cacheTtl)) throw new Error('invalid cacheTtl')
    patch.cacheTtl = body.cacheTtl
  }
  if (body.fastMode !== undefined) {
    if (typeof body.fastMode !== 'boolean') throw new Error('fastMode must be boolean')
    patch.fastMode = body.fastMode
  }
  if (body.serverCompaction !== undefined) {
    if (typeof body.serverCompaction !== 'boolean') throw new Error('serverCompaction must be boolean')
    patch.serverCompaction = body.serverCompaction
  }
  return patch
}

/**
 * Route table mirrored by src/client/claude-api/api.ts. The settings body is a
 * ClaudeApiSettingsUpdateDto; the key is removed with DELETE /key (the prefix
 * router dispatches on request.method, so no extra registration is needed).
 */
export function registerClaudeApiRoutes(
  ctx: Context,
  store: ClaudeApiCredentialStore,
  settingsStore: ClaudeApiSettingsStore,
  catalog: ClaudeApiCatalogManager,
  deps: ClaudeApiRouteDeps,
): () => void {
  const status = () => getClaudeApiWebStatus(store, settingsStore, catalog, deps)
  return ctx.webServer.register({
    kind: 'prefix', path: CLAUDE_API_ROUTE_PREFIX,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      const pathname = new URL(request.url || '/', 'http://dsh.local').pathname
      const path = pathname === CLAUDE_API_ROUTE_PREFIX ? '' : pathname.slice(CLAUDE_API_ROUTE_PREFIX.length).replace(/^\//, '')
      const method = request.method ?? 'GET'
      try {
        if (path === 'status') {
          if (method !== 'GET') return methodNotAllowed(response)
          return sendJson(response, 200, { ok: true, value: await status() })
        }
        if (path === 'settings') {
          if (method !== 'POST') return methodNotAllowed(response)
          if (!isSameOriginMutation(request)) return crossOrigin(response)
          const patch = parseSettingsPatch(await readJson(request), catalog)
          const before = await settingsStore.read()
          const next = await settingsStore.update(patch)
          if (next.baseUrl !== before.baseUrl) {
            catalog.reset()
            catalog.startRefresh(true)
          }
          if (patch.enabled !== undefined || patch.enabledModelIds !== undefined || patch.contextWindowOverrides !== undefined
            || patch.defaultReasoningEffort !== undefined || next.baseUrl !== before.baseUrl) ctx.emit?.('llm/adapters-updated')
          return sendJson(response, 200, { ok: true, value: await status() })
        }
        if (path === 'key') {
          if (method === 'DELETE') {
            if (!isSameOriginMutation(request)) return crossOrigin(response)
            await store.delete()
            catalog.reset()
            ctx.emit?.('llm/adapters-updated')
            return sendJson(response, 200, { ok: true, value: await status() })
          }
          if (method !== 'POST') return methodNotAllowed(response)
          if (!isSameOriginMutation(request)) return crossOrigin(response)
          const body = await readJson(request)
          const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
          if (apiKey === '' || apiKey.length > 4096) throw new Error('A valid Claude API key is required.')
          await store.write({ apiKey, authenticatedAt: Date.now() })
          catalog.reset()
          ctx.emit?.('llm/adapters-updated')
          // Background: the answer carries the fallback table, the refresh replaces it behind the poll.
          catalog.startRefresh(true)
          return sendJson(response, 200, { ok: true, value: await status() })
        }
        if (path === 'test') {
          if (method !== 'POST') return methodNotAllowed(response)
          if (!isSameOriginMutation(request)) return crossOrigin(response)
          const [credentials, settings] = await Promise.all([store.read().catch(() => null), settingsStore.read()])
          if (credentials === null) {
            const missing: ClaudeApiConnectionDto = {
              connected: false, latencyMs: 0, checkedAt: Date.now(), modelCount: 0,
              error: 'Claude API has no API key.',
            }
            return sendJson(response, 200, { ok: true, value: missing })
          }
          const result = await testClaudeApiConnection({
            baseUrl: settings.baseUrl,
            apiKey: credentials.apiKey,
            version: deps.version.current().value,
            fetchFn: deps.fetchFn ?? fetch,
          })
          return sendJson(response, 200, { ok: true, value: result })
        }
        if (path === 'catalog/refresh') {
          if (method !== 'POST') return methodNotAllowed(response)
          if (!isSameOriginMutation(request)) return crossOrigin(response)
          await catalog.refresh(true)
          return sendJson(response, 200, { ok: true, value: await status() })
        }
        return sendJson(response, 404, { ok: false, error: 'Not Found' })
      } catch (error) {
        return sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
}

/** Startup warm-up is deliberately fire-and-forget in the plugin entry. */
export async function warmClaudeApiCatalogOnStartup(catalog: ClaudeApiCatalogManager): Promise<void> {
  await catalog.warm()
  catalog.startRefresh(false)
}
