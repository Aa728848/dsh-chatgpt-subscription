import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isSameOriginMutation } from '../../common/same-origin.ts'
import type { ContextWindowOverridePatch } from '../../common/context-window-overrides.ts'
import {
  CLAUDE_API_DEFAULT_BASE_URL,
  CLAUDE_API_PROVIDER_ID,
  CLAUDE_API_ROUTE_PREFIX,
  isClaudeApiCacheTtl,
  isClaudeApiReasoningEffort,
  normalizeClaudeApiBaseUrl,
  type ClaudeApiConnectionDto,
  type ClaudeApiStatusDto,
} from '../../../shared/claude-api-contracts.ts'
import type { ClaudeApiCatalogManager } from './catalog-manager.ts'
import { testClaudeApiConnection } from './client.ts'
import type { ClaudeApiClientVersionResolver } from './client-version.ts'
import { claudeApiModelOptions } from './model-catalog.ts'
import { ClaudeApiAccountPool } from './account-pool.ts'
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

function poolFor(store: ClaudeApiCredentialStore | ClaudeApiAccountPool, settingsStore: ClaudeApiSettingsStore): ClaudeApiAccountPool {
  return store instanceof ClaudeApiAccountPool ? store : new ClaudeApiAccountPool({ store, settingsStore })
}

/** Local-first status; the network refresh begins behind the answer. */
export async function getClaudeApiWebStatus(
  store: ClaudeApiCredentialStore | ClaudeApiAccountPool,
  settingsStore: ClaudeApiSettingsStore,
  catalog: ClaudeApiCatalogManager,
  deps: ClaudeApiRouteDeps,
): Promise<ClaudeApiStatusDto> {
  const pool = poolFor(store, settingsStore)
  const [data, settings] = await Promise.all([
    pool.read().catch(() => null),
    settingsStore.read(),
    catalog.warm(),
  ])
  const accounts = data?.accounts ?? []
  const primary = accounts.find(account => account.isPrimary) ?? accounts[0]
  const snapshot = catalog.snapshot()
  const models = claudeApiModelOptions(snapshot.entries, settings, snapshot.live)
  if (primary !== undefined) catalog.startRefresh(false)
  return {
    providerId: CLAUDE_API_PROVIDER_ID,
    enabled: settings.enabled,
    authenticated: primary !== undefined,
    storagePath: pool.path(),
    baseUrl: primary?.credentials.baseUrl ?? settings.baseUrl,
    defaultBaseUrl: CLAUDE_API_DEFAULT_BASE_URL,
    accounts: data === null ? [] : pool.summariesOf(data),
    ...(data?.activeAccountId === undefined ? {} : { activeAccountId: data.activeAccountId }),
    rotationStrategy: data?.rotationStrategy ?? 'sequential',
    models,
    contextWindowOverrides: settings.contextWindowOverrides,
    defaultReasoningEffort: settings.defaultReasoningEffort,
    cacheTtl: settings.cacheTtl,
    subagentCacheTtl: settings.subagentCacheTtl,
    fastMode: settings.fastMode,
    serverCompaction: settings.serverCompaction,
    autoCompactSubagents: settings.autoCompactSubagents,
    clientVersion: deps.version.current(),
    catalog: primary === undefined ? { state: 'idle', fetchedAt: null, error: null } : catalog.dto(),
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
  if (body.subagentCacheTtl !== undefined) {
    if (!isClaudeApiCacheTtl(body.subagentCacheTtl)) throw new Error('invalid subagentCacheTtl')
    patch.subagentCacheTtl = body.subagentCacheTtl
  }
  if (body.fastMode !== undefined) {
    if (typeof body.fastMode !== 'boolean') throw new Error('fastMode must be boolean')
    patch.fastMode = body.fastMode
  }
  if (body.serverCompaction !== undefined) {
    if (typeof body.serverCompaction !== 'boolean') throw new Error('serverCompaction must be boolean')
    patch.serverCompaction = body.serverCompaction
  }
  if (body.autoCompactSubagents !== undefined) {
    if (typeof body.autoCompactSubagents !== 'boolean') throw new Error('autoCompactSubagents must be boolean')
    patch.autoCompactSubagents = body.autoCompactSubagents
  }
  return patch
}

export function registerClaudeApiRoutes(
  ctx: Context,
  store: ClaudeApiCredentialStore | ClaudeApiAccountPool,
  settingsStore: ClaudeApiSettingsStore,
  catalog: ClaudeApiCatalogManager,
  deps: ClaudeApiRouteDeps,
): () => void {
  const pool = poolFor(store, settingsStore)
  const status = () => getClaudeApiWebStatus(pool, settingsStore, catalog, deps)
  const changed = async (catalogChanged = true) => {
    if (catalogChanged) {
      catalog.reset()
      ctx.emit?.('llm/adapters-updated')
      catalog.startRefresh(true)
    }
    return status()
  }
  return ctx.webServer.register({
    kind: 'prefix', path: CLAUDE_API_ROUTE_PREFIX,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      const pathname = new URL(request.url || '/', 'http://dsh.local').pathname
      const path = pathname === CLAUDE_API_ROUTE_PREFIX ? '' : pathname.slice(CLAUDE_API_ROUTE_PREFIX.length).replace(/^[/]/, '')
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
          const primary = await pool.stableAccount()
          if (patch.baseUrl !== undefined && primary !== null) {
            await pool.saveAccount({
              accountId: primary.id,
              baseUrl: patch.baseUrl === null ? CLAUDE_API_DEFAULT_BASE_URL : patch.baseUrl,
            })
          }
          const settingsPatch = patch.baseUrl !== undefined && primary !== null ? { ...patch, baseUrl: undefined } : patch
          const next = await settingsStore.update(settingsPatch)
          if (next.baseUrl !== before.baseUrl) {
            catalog.reset()
            catalog.startRefresh(true)
          }
          if (patch.enabled !== undefined || patch.enabledModelIds !== undefined || patch.contextWindowOverrides !== undefined
            || patch.defaultReasoningEffort !== undefined || next.baseUrl !== before.baseUrl) ctx.emit?.('llm/adapters-updated')
          return sendJson(response, 200, { ok: true, value: await status() })
        }
        if (path === 'accounts') {
          if (method !== 'POST') return methodNotAllowed(response)
          if (!isSameOriginMutation(request)) return crossOrigin(response)
          const body = await readJson(request)
          const action = typeof body.action === 'string' ? body.action : 'save'
          const accountId = typeof body.accountId === 'string' ? body.accountId : undefined
          if (action === 'save') {
            const baseUrl = normalizeClaudeApiBaseUrl(body.baseUrl)
            if (!baseUrl.ok) throw new Error('Invalid baseUrl (' + baseUrl.reason + ').')
            await pool.saveAccount({
              ...(accountId === undefined ? {} : { accountId }),
              ...(typeof body.alias === 'string' ? { alias: body.alias } : {}),
              baseUrl: baseUrl.value,
              ...(typeof body.apiKey === 'string' ? { apiKey: body.apiKey } : {}),
            })
          } else if (action === 'strategy') {
            const strategy = body.strategy
            if (strategy !== 'sequential' && strategy !== 'round-robin' && strategy !== 'sticky') throw new Error('Unsupported rotation strategy.')
            await pool.setStrategy(strategy)
          } else {
            if (accountId === undefined || accountId === '') throw new Error('An account id is required.')
            if (action === 'set-primary') await pool.setPrimary(accountId)
            else if (action === 'delete') await pool.deleteAccount(accountId)
            else if (action === 'clear-cooldown') await pool.clearCooldown(accountId)
            else if (action === 'clear-auth') await pool.clearAuthFailed(accountId)
            else throw new Error('Unsupported account action.')
          }
          const catalogChanged = action === 'save' || action === 'set-primary' || action === 'delete'
          return sendJson(response, 200, { ok: true, value: await changed(catalogChanged) })
        }
        if (path === 'key') {
          if (method === 'DELETE') {
            if (!isSameOriginMutation(request)) return crossOrigin(response)
            const primary = await pool.stableAccount()
            if (primary !== null) await pool.deleteAccount(primary.id)
            return sendJson(response, 200, { ok: true, value: await changed() })
          }
          if (method !== 'POST') return methodNotAllowed(response)
          if (!isSameOriginMutation(request)) return crossOrigin(response)
          const body = await readJson(request)
          const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
          if (apiKey === '' || apiKey.length > 4096) throw new Error('A valid Claude API key is required.')
          const primary = await pool.stableAccount()
          await pool.saveAccount({
            ...(primary === null ? {} : { accountId: primary.id }),
            baseUrl: primary?.credentials.baseUrl ?? (await settingsStore.read()).baseUrl,
            apiKey,
          })
          return sendJson(response, 200, { ok: true, value: await changed() })
        }
        if (path === 'test') {
          if (method !== 'POST') return methodNotAllowed(response)
          if (!isSameOriginMutation(request)) return crossOrigin(response)
          const body = await readJson(request)
          const accountId = typeof body.accountId === 'string' && body.accountId !== '' ? body.accountId : undefined
          const account = await pool.accountForTest(accountId)
          if (account === null) {
            const missing: ClaudeApiConnectionDto = {
              connected: false, latencyMs: 0, checkedAt: Date.now(), modelCount: 0,
              error: 'Claude API has no configured account.',
            }
            return sendJson(response, 200, { ok: true, value: missing })
          }
          const result = await testClaudeApiConnection({
            baseUrl: account.credentials.baseUrl,
            apiKey: account.credentials.apiKey,
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
