import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isSameOriginMutation } from '../common/same-origin.ts'
import type { ContextWindowOverridePatch } from '../common/context-window-overrides.ts'
import {
  RELAYONE_PROVIDER_ID,
  RELAYONE_ROUTE_PREFIX,
  isRelayOneReasoningEffort,
  type RelayOneSettingsUpdateDto,
  type RelayOneStatusDto,
} from '../../shared/relayone-contracts.ts'
import { RelayOneCatalogManager } from './catalog-manager.ts'
import { relayOneModelOptions } from './model-catalog.ts'
import {
  RelayOneCredentialStore,
  RelayOneSettingsStore,
  type RelayOneSettingsPatch,
} from './token-store.ts'
import { testRelayOneConnection } from './client.ts'
import { idleRelayOneQuota, type RelayOneQuotaReader } from './quota.ts'

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

export interface RelayOneRouteOptions {
  quota?: RelayOneQuotaReader
  serving?: boolean | (() => boolean)
  conflict?: string | null | (() => string | null)
}

/** Local-first status; the network refresh begins behind the answer. */
export async function getRelayOneWebStatus(
  store: RelayOneCredentialStore,
  settingsStore: RelayOneSettingsStore,
  catalog: RelayOneCatalogManager,
  options: RelayOneRouteOptions = {},
): Promise<RelayOneStatusDto> {
  const [credentials, settings] = await Promise.all([store.read().catch(() => null), settingsStore.read(), catalog.warm()])
  const optionsModels = relayOneModelOptions(catalog.snapshot().entries, settings)
  if (credentials !== null) {
    catalog.startRefresh(false)
    options.quota?.startRefresh(false)
  }
  return {
    providerId: RELAYONE_PROVIDER_ID,
    enabled: settings.enabled,
    authenticated: credentials !== null,
    storagePath: store.path(),
    models: optionsModels.filter(model => model.kind === 'chat'),
    mediaModels: optionsModels.filter(model => model.kind !== 'chat'),
    contextWindowOverrides: settings.contextWindowOverrides,
    defaultReasoningEffort: settings.defaultReasoningEffort,
    imageModel: settings.imageModel,
    videoModel: settings.videoModel,
    catalog: credentials === null ? { state: 'idle', fetchedAt: null, error: null, groups: [] } : catalog.dto(),
    quota: credentials === null ? idleRelayOneQuota() : options.quota?.snapshot() ?? idleRelayOneQuota(),
    serving: readOption(options.serving, true),
    conflict: readOption(options.conflict, null),
  }
}

function parseSettingsPatch(body: Record<string, unknown>, catalog: RelayOneCatalogManager): RelayOneSettingsPatch {
  const entries = catalog.snapshot().entries
  const chatIds = new Set(entries.filter(entry => entry.kind === 'chat').map(entry => entry.id))
  const imageIds = new Set(entries.filter(entry => entry.kind === 'image').map(entry => entry.id))
  const videoIds = new Set(entries.filter(entry => entry.kind === 'video').map(entry => entry.id))
  const patch: RelayOneSettingsPatch = {}
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new Error('enabled must be boolean')
    patch.enabled = body.enabled
  }
  if (body.enabledModelIds !== undefined) {
    if (!Array.isArray(body.enabledModelIds) || body.enabledModelIds.some(id => typeof id !== 'string')) throw new Error('enabledModelIds must be a string array')
    const ids = [...new Set(body.enabledModelIds as string[])]
    if (ids.some(id => !chatIds.has(id))) throw new Error('enabledModelIds contains a model outside the current key catalog')
    patch.enabledModelIds = ids
  }
  if (body.contextWindowOverrides !== undefined) {
    if (typeof body.contextWindowOverrides !== 'object' || body.contextWindowOverrides === null || Array.isArray(body.contextWindowOverrides)) throw new Error('contextWindowOverrides must be an object')
    const overrides: ContextWindowOverridePatch = {}
    for (const [id, value] of Object.entries(body.contextWindowOverrides)) {
      if (!chatIds.has(id)) throw new Error('contextWindowOverrides contains an unknown chat model')
      if (value === null) overrides[id] = null
      else if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 10_000_000) overrides[id] = value
      else throw new Error('context window override must be null or a positive safe integer')
    }
    patch.contextWindowOverrides = overrides
  }
  if (body.defaultReasoningEffort !== undefined) {
    if (body.defaultReasoningEffort !== null && !isRelayOneReasoningEffort(body.defaultReasoningEffort)) throw new Error('invalid reasoning effort')
    patch.defaultReasoningEffort = body.defaultReasoningEffort
  }
  if (body.imageModel !== undefined) {
    if (body.imageModel !== null && (typeof body.imageModel !== 'string' || !imageIds.has(body.imageModel))) throw new Error('invalid image model')
    patch.imageModel = body.imageModel
  }
  if (body.videoModel !== undefined) {
    if (body.videoModel !== null && (typeof body.videoModel !== 'string' || !videoIds.has(body.videoModel))) throw new Error('invalid video model')
    patch.videoModel = body.videoModel
  }
  return patch
}

/** Route table mirrored by src/client/relayone/api.ts. */
export function registerRelayOneRoutes(
  ctx: Context,
  store: RelayOneCredentialStore,
  settingsStore: RelayOneSettingsStore,
  catalog: RelayOneCatalogManager,
  options: RelayOneRouteOptions = {},
): () => void {
  const status = () => getRelayOneWebStatus(store, settingsStore, catalog, options)
  return ctx.webServer.register({
    kind: 'prefix', path: RELAYONE_ROUTE_PREFIX,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      const pathname = new URL(request.url || '/', 'http://dsh.local').pathname
      const path = pathname === RELAYONE_ROUTE_PREFIX ? '' : pathname.slice(RELAYONE_ROUTE_PREFIX.length).replace(/^\//, '')
      const method = request.method ?? 'GET'
      try {
        if (path === '' || path === 'status') {
          if (method !== 'GET') return methodNotAllowed(response)
          return sendJson(response, 200, { ok: true, value: await status() })
        }
        if (path === 'credentials') {
          if (method === 'DELETE') {
            if (!isSameOriginMutation(request)) return crossOrigin(response)
            await store.delete()
            catalog.reset()
            options.quota?.reset()
            ctx.emit?.('llm/adapters-updated')
            return sendJson(response, 200, { ok: true, value: await status() })
          }
          if (method !== 'PUT' && method !== 'POST') return methodNotAllowed(response)
          if (!isSameOriginMutation(request)) return crossOrigin(response)
          const body = await readJson(request)
          const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
          if (apiKey === '' || apiKey.length > 4096) throw new Error('A valid RelayOne API key is required.')
          await store.write({ apiKey, authenticatedAt: Date.now() })
          catalog.reset()
          options.quota?.reset()
          ctx.emit?.('llm/adapters-updated')
          await Promise.all([catalog.refresh(true), options.quota?.refresh(true)])
          return sendJson(response, 200, { ok: true, value: await status() })
        }
        if (path === 'settings') {
          if (method === 'GET') return sendJson(response, 200, { ok: true, value: await status() })
          if (method !== 'POST' && method !== 'PATCH') return methodNotAllowed(response)
          if (!isSameOriginMutation(request)) return crossOrigin(response)
          const patch = parseSettingsPatch(await readJson(request), catalog)
          await settingsStore.updateSettings(patch)
          if (patch.enabled !== undefined || patch.enabledModelIds !== undefined || patch.defaultReasoningEffort !== undefined) ctx.emit?.('llm/adapters-updated')
          return sendJson(response, 200, { ok: true, value: await status() })
        }
        if (path === 'catalog/refresh') {
          if (method !== 'POST') return methodNotAllowed(response)
          if (!isSameOriginMutation(request)) return crossOrigin(response)
          await Promise.all([catalog.refresh(true), options.quota?.refresh(true)])
          return sendJson(response, 200, { ok: true, value: await status() })
        }
        if (path === 'connection' || path === 'connection/test') {
          if (method !== 'POST') return methodNotAllowed(response)
          if (!isSameOriginMutation(request)) return crossOrigin(response)
          return sendJson(response, 200, { ok: true, value: await testRelayOneConnection(catalog) })
        }
        return sendJson(response, 404, { ok: false, error: 'Not Found' })
      } catch (error) {
        return sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
}

/** Startup warm-up is deliberately fire-and-forget in the plugin entry. */
export async function warmRelayOneCatalogOnStartup(catalog: RelayOneCatalogManager): Promise<void> {
  await catalog.warm()
  catalog.startRefresh(false)
}
