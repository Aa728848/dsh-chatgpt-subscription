import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isSameOriginMutation } from '../../common/same-origin.ts'
import { normalizeRotationStrategy } from '../../common/account-pool.ts'
import type { ContextWindowOverridePatch } from '../../common/context-window-overrides.ts'
import { isOpenCodeGoReasoningEffort, OPENCODE_GO_PROVIDER_ID, OPENCODE_GO_ROUTE_PREFIX, type OpenCodeGoSettingsUpdateDto, type OpenCodeGoWebStatus } from '../../../shared/opencode-go-contracts.ts'
import type { OpenCodeGoAccountPool } from './account-pool.ts'
import type { OpenCodeGoCatalogManager } from './model-catalog.ts'
import { openCodeGoModelOptions } from './model-catalog.ts'
import type { OpenCodeGoSettingsStore } from './token-store.ts'
import { fetchOpenCodeGoModels, fetchOpenCodeGoUsage, testOpenCodeGoConnection } from './client.ts'

const MAX_BODY_BYTES = 64 * 1024
let lastQuotaError: string | null = null
let lastConnection: OpenCodeGoWebStatus['connection'] = null
function sendJson(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)) }
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
      try { resolve(raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>) } catch { reject(new Error('Malformed JSON request')) }
    })
    request.on('error', reject)
  })
}
function readOption<T>(value: T | (() => T) | undefined, fallback: T): T { return typeof value === 'function' ? (value as () => T)() : value ?? fallback }

export interface OpenCodeGoRouteOptions {
  fetchFn?: typeof fetch
  serving?: boolean | (() => boolean)
  conflict?: string | null | (() => string | null)
}

export async function getOpenCodeGoWebStatus(pool: OpenCodeGoAccountPool, settingsStore: OpenCodeGoSettingsStore, catalog: OpenCodeGoCatalogManager, options: OpenCodeGoRouteOptions = {}): Promise<OpenCodeGoWebStatus> {
  const [data, settings] = await Promise.all([pool.read(), settingsStore.read()])
  const activeAccountId = settings.selectedAccountId ?? data.activeAccountId ?? data.accounts.find(account => account.isPrimary)?.id ?? data.accounts[0]?.id
  if (activeAccountId !== undefined) await catalog.restore(activeAccountId)
  const snapshot = catalog.snapshot()
  return {
    enabled: settings.enabled, providerId: OPENCODE_GO_PROVIDER_ID,
    serving: readOption(options.serving, true), conflict: readOption(options.conflict, null),
    authenticated: data.accounts.length > 0,
    accounts: pool.summariesOf(data), activeAccountId, rotationStrategy: data.rotationStrategy,
    selectedAccountId: settings.selectedAccountId,
    models: openCodeGoModelOptions(snapshot.entries, settings),
    contextWindowOverrides: settings.contextWindowOverrides, defaultReasoningEffort: settings.defaultReasoningEffort,
    catalogSynced: snapshot.fetchedAt > 0, catalogCount: snapshot.entries.length,
    quotaError: lastQuotaError, connection: lastConnection,
  }
}

function parseSettingsPatch(body: Record<string, unknown>, knownIds: Set<string>): OpenCodeGoSettingsUpdateDto & { contextWindowOverrides?: ContextWindowOverridePatch } {
  const patch: OpenCodeGoSettingsUpdateDto & { contextWindowOverrides?: ContextWindowOverridePatch } = {}
  if (body.enabled !== undefined) { if (typeof body.enabled !== 'boolean') throw new Error('enabled must be boolean'); patch.enabled = body.enabled }
  if (body.enabledModelIds !== undefined) {
    if (!Array.isArray(body.enabledModelIds) || body.enabledModelIds.some(id => typeof id !== 'string')) throw new Error('enabledModelIds must be a string array')
    const ids = [...new Set(body.enabledModelIds as string[])]
    if (knownIds.size > 0 && ids.some(id => !knownIds.has(id))) throw new Error('enabledModelIds contains an unknown model')
    patch.enabledModelIds = ids
  }
  if (body.contextWindowOverrides !== undefined) {
    if (typeof body.contextWindowOverrides !== 'object' || body.contextWindowOverrides === null || Array.isArray(body.contextWindowOverrides)) throw new Error('contextWindowOverrides must be an object')
    const overrides: ContextWindowOverridePatch = {}
    for (const [id, value] of Object.entries(body.contextWindowOverrides)) {
      if (knownIds.size > 0 && !knownIds.has(id)) throw new Error('contextWindowOverrides contains an unknown model')
      if (value === null) overrides[id] = null
      else if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 10_000_000) overrides[id] = value
      else throw new Error('context window override must be null or a positive safe integer')
    }
    patch.contextWindowOverrides = overrides
  }
  if (body.defaultReasoningEffort !== undefined) {
    if (body.defaultReasoningEffort !== null && !isOpenCodeGoReasoningEffort(body.defaultReasoningEffort)) throw new Error('invalid reasoning effort')
    patch.defaultReasoningEffort = body.defaultReasoningEffort
  }
  if (body.selectedAccountId !== undefined) {
    if (body.selectedAccountId !== null && typeof body.selectedAccountId !== 'string') throw new Error('selectedAccountId must be a string or null')
    patch.selectedAccountId = body.selectedAccountId
  }
  return patch
}

export function registerOpenCodeGoRoutes(ctx: Context, pool: OpenCodeGoAccountPool, settingsStore: OpenCodeGoSettingsStore, catalog: OpenCodeGoCatalogManager, options: OpenCodeGoRouteOptions = {}): () => void {
  const status = () => getOpenCodeGoWebStatus(pool, settingsStore, catalog, options)
  const targetFor = async () => {
    const settings = await settingsStore.read()
    return pool.getEffectiveCredential(undefined, options.fetchFn ?? fetch, { preferAccountIds: settings.selectedAccountId === null ? undefined : [settings.selectedAccountId] })
  }
  return ctx.webServer.register({
    kind: 'prefix', path: OPENCODE_GO_ROUTE_PREFIX,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      const pathname = new URL(request.url || '/', 'http://dsh.local').pathname
      const path = pathname === OPENCODE_GO_ROUTE_PREFIX ? '' : pathname.slice(OPENCODE_GO_ROUTE_PREFIX.length).replace(/^\//, '')
      const method = request.method ?? 'GET'
      try {
        if (path === '' || path === 'status' || (path === 'settings' && method === 'GET') || (path === 'models' && method === 'GET')) {
          if (method !== 'GET') return methodNotAllowed(response)
          return sendJson(response, 200, { ok: true, value: await status() })
        }
        if (path === 'accounts' && method === 'POST') {
          if (!isSameOriginMutation(request)) return crossOrigin(response)
          const body = await readJson(request)
          const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
          if (apiKey === '' || apiKey.length > 4096) throw new Error('A valid OpenCode Go API key is required')
          const credentials = { apiKey, authenticatedAt: Date.now() }
          await fetchOpenCodeGoModels(credentials, options.fetchFn ?? fetch)
          if (typeof body.accountId === 'string' && body.accountId !== '') await pool.replaceApiKey(body.accountId, apiKey)
          else await pool.addAccount(credentials, typeof body.alias === 'string' && body.alias.trim() !== '' ? body.alias.trim() : undefined)
          ctx.emit?.('llm/adapters-updated')
          return sendJson(response, 200, { ok: true, value: await status() })
        }
        if (path === 'accounts/action' && method === 'POST') {
          if (!isSameOriginMutation(request)) return crossOrigin(response)
          const body = await readJson(request)
          const action = body.action
          const accountId = typeof body.accountId === 'string' ? body.accountId : ''
          if (action === 'strategy') {
            await pool.setStrategy(normalizeRotationStrategy(body.strategy))
          } else {
            if (accountId === '') throw new Error('accountId is required')
            if (action === 'set-primary') await pool.setPrimary(accountId)
            else if (action === 'set-alias') {
              const alias = typeof body.alias === 'string' ? body.alias.trim() : ''
              if (alias === '' || alias.length > 120) throw new Error('A short account alias is required')
              await pool.setAlias(accountId, alias)
            } else if (action === 'delete') await pool.deleteAccount(accountId)
            else if (action === 'clear-cooldown') await pool.clearCooldown(accountId)
            else throw new Error('Unknown account action')
          }
          ctx.emit?.('llm/adapters-updated')
          return sendJson(response, 200, { ok: true, value: await status() })
        }
        if (path === 'settings' && (method === 'POST' || method === 'PATCH')) {
          if (!isSameOriginMutation(request)) return crossOrigin(response)
          const patch = parseSettingsPatch(await readJson(request), new Set(catalog.snapshot().entries.map(entry => entry.id)))
          if (patch.selectedAccountId !== undefined && patch.selectedAccountId !== null) {
            const data = await pool.read()
            if (!data.accounts.some(account => account.id === patch.selectedAccountId)) throw new Error('selectedAccountId does not exist in the account pool')
          }
          await settingsStore.update(patch)
          if (patch.enabled !== undefined || patch.enabledModelIds !== undefined || patch.defaultReasoningEffort !== undefined || patch.selectedAccountId !== undefined) ctx.emit?.('llm/adapters-updated')
          return sendJson(response, 200, { ok: true, value: await status() })
        }
        if (path === 'models/refresh' && method === 'POST') {
          if (!isSameOriginMutation(request)) return crossOrigin(response)
          const before = catalog.fingerprint()
          const target = await targetFor()
          await catalog.refresh(target, options.fetchFn ?? fetch)
          if (catalog.fingerprint() !== before) ctx.emit?.('llm/adapters-updated')
          return sendJson(response, 200, { ok: true, value: await status() })
        }
        if (path === 'quota/refresh' && method === 'POST') {
          if (!isSameOriginMutation(request)) return crossOrigin(response)
          try {
            const target = await targetFor()
            await fetchOpenCodeGoUsage(target.account.id, target.credentials, options.fetchFn ?? fetch)
            lastQuotaError = null
          } catch (error) { lastQuotaError = error instanceof Error ? error.message : String(error) }
          return sendJson(response, 200, { ok: true, value: await status() })
        }
        if ((path === 'connection' || path === 'connection/test') && method === 'POST') {
          if (!isSameOriginMutation(request)) return crossOrigin(response)
          const target = await targetFor()
          lastConnection = await testOpenCodeGoConnection(target.account.id, target.credentials, options.fetchFn ?? fetch)
          return sendJson(response, 200, { ok: true, value: lastConnection })
        }
        return sendJson(response, 404, { ok: false, error: 'Not Found' })
      } catch (error) {
        return sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
}
