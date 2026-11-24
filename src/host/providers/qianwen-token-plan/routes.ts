import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isSameOriginMutation } from '../../common/same-origin.ts'
import { t } from '../../common/i18n/index.ts'
import type { ContextWindowOverridePatch } from '../../common/context-window-overrides.ts'
import {
  QIANWEN_TOKEN_PLAN_PROVIDER_ID,
  QIANWEN_TOKEN_PLAN_ROUTE_PREFIX,
  isQianwenCacheTtl,
  isQianwenImageDetail,
  isQianwenReasoningEffort,
  type QianwenSettingsUpdateDto,
  type QianwenStatusDto,
} from '../../../shared/qianwen-token-plan-contracts.ts'
import { catalogModelOptions, QIANWEN_MODEL_CATALOG } from './model-catalog.ts'
import { QianwenCredentialStore, QianwenSettingsStore, type QianwenSettingsPatch } from './token-store.ts'
import { QIANWEN_MAX_PIXELS, QIANWEN_MIN_PIXELS } from './types.ts'
import { readQianwenCacheStats, resetQianwenCacheStats } from './cache-stats.ts'
import { readQianwenCacheHint } from './adapter.ts'
import { testQianwenConnection } from './client.ts'

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

export interface QianwenRouteOptions {
  fetchFn?: typeof fetch
  serving?: boolean | (() => boolean)
  conflict?: string | null | (() => string | null)
}
export async function getQianwenTokenPlanWebStatus(
  store: QianwenCredentialStore,
  settingsStore: QianwenSettingsStore,
  options: QianwenRouteOptions = {},
): Promise<QianwenStatusDto> {
  const [credentials, settings] = await Promise.all([store.read(), settingsStore.read()])
  const cacheStats = readQianwenCacheStats()
  const cacheHint = readQianwenCacheHint(undefined, settings)
  return {
    providerId: QIANWEN_TOKEN_PLAN_PROVIDER_ID,
    enabled: settings.enabled,
    authenticated: credentials !== null,
    hasCredentials: credentials !== null,
    storagePath: store.path(),
    models: catalogModelOptions(settings),
    contextWindowOverrides: settings.contextWindowOverrides,
    defaultReasoningEffort: settings.defaultReasoningEffort,
    cacheEnabled: settings.cacheEnabled,
    cacheTtl: settings.cacheTtl,
    thinkingSummary: settings.thinkingSummary,
    imageDetail: settings.imageDetail,
    maxPixels: settings.maxPixels,
    ...(cacheStats === undefined ? {} : { cacheStats }),
    ...(cacheHint === null ? {} : { cacheHint }),
    serving: readOption(options.serving, true),
    conflict: readOption(options.conflict, null),
  }
}

function parseSettingsPatch(body: Record<string, unknown>): QianwenSettingsPatch {
  const patch: QianwenSettingsPatch = {}
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new Error('enabled must be boolean')
    patch.enabled = body.enabled
  }
  if (body.enabledModelIds !== undefined) {
    if (!Array.isArray(body.enabledModelIds) || body.enabledModelIds.some(id => typeof id !== 'string')) throw new Error('enabledModelIds must be a string array')
    const known = new Set(QIANWEN_MODEL_CATALOG.map(model => model.id))
    const ids = body.enabledModelIds as string[]
    if (ids.some(id => !known.has(id))) throw new Error('enabledModelIds contains an unknown model')
    patch.enabledModelIds = [...new Set(ids)]
  }
  if (body.contextWindowOverrides !== undefined) {
    if (typeof body.contextWindowOverrides !== 'object' || body.contextWindowOverrides === null || Array.isArray(body.contextWindowOverrides)) throw new Error('contextWindowOverrides must be an object')
    const known = new Set(QIANWEN_MODEL_CATALOG.map(model => model.id))
    const overrides: ContextWindowOverridePatch = {}
    for (const [id, value] of Object.entries(body.contextWindowOverrides)) {
      if (!known.has(id)) throw new Error('contextWindowOverrides contains an unknown model')
      if (value === null) overrides[id] = null
      else if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 10_000_000) overrides[id] = value
      else throw new Error('context window override must be null or a positive safe integer')
    }
    patch.contextWindowOverrides = overrides
  }
  if (body.defaultReasoningEffort !== undefined) {
    if (body.defaultReasoningEffort !== null && !isQianwenReasoningEffort(body.defaultReasoningEffort)) throw new Error('invalid reasoning effort')
    patch.defaultReasoningEffort = body.defaultReasoningEffort
  }
  if (body.cacheEnabled !== undefined) {
    if (typeof body.cacheEnabled !== 'boolean') throw new Error('cacheEnabled must be boolean')
    patch.cacheEnabled = body.cacheEnabled
  }
  if (body.cacheTtl !== undefined) {
    if (!isQianwenCacheTtl(body.cacheTtl)) throw new Error('cacheTtl must be 5m or 1h')
    patch.cacheTtl = body.cacheTtl
  }
  if (body.thinkingSummary !== undefined) {
    if (typeof body.thinkingSummary !== 'boolean') throw new Error('thinkingSummary must be boolean')
    patch.thinkingSummary = body.thinkingSummary
  }
  if (body.imageDetail !== undefined) {
    if (!isQianwenImageDetail(body.imageDetail)) throw new Error('invalid image detail')
    patch.imageDetail = body.imageDetail
  }
  if (body.maxPixels !== undefined) {
    if (body.maxPixels !== null && (typeof body.maxPixels !== 'number' || !Number.isSafeInteger(body.maxPixels) || body.maxPixels < QIANWEN_MIN_PIXELS || body.maxPixels > QIANWEN_MAX_PIXELS)) throw new Error('maxPixels is outside the documented range')
    patch.maxPixels = body.maxPixels
  }
  return patch
}

/** Route table mirrored by src/client/qianwen-token-plan/api.ts. */
export function registerQianwenTokenPlanRoutes(
  ctx: Context,
  store: QianwenCredentialStore,
  settingsStore: QianwenSettingsStore,
  options: QianwenRouteOptions = {},
): () => void {
  const status = () => getQianwenTokenPlanWebStatus(store, settingsStore, options)
  return ctx.webServer.register({
    kind: 'prefix', path: QIANWEN_TOKEN_PLAN_ROUTE_PREFIX,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      const pathname = new URL(request.url || '/', 'http://dsh.local').pathname
      const path = pathname === QIANWEN_TOKEN_PLAN_ROUTE_PREFIX ? '' : pathname.slice(QIANWEN_TOKEN_PLAN_ROUTE_PREFIX.length).replace(/^\//, '')
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
            resetQianwenCacheStats()
            ctx.emit?.('llm/adapters-updated')
            return sendJson(response, 200, { ok: true, value: await status() })
          }
          if (method !== 'PUT' && method !== 'POST') return methodNotAllowed(response)
          if (!isSameOriginMutation(request)) return crossOrigin(response)
          const body = await readJson(request)
          const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
          if (apiKey === '' || apiKey.length > 4096) throw new Error(t('qwen.invalidApiKey'))
          await store.write({ apiKey, authenticatedAt: Date.now() })
          resetQianwenCacheStats()
          ctx.emit?.('llm/adapters-updated')
          return sendJson(response, 200, { ok: true, value: await status() })
        }
        if (path === 'settings') {
          if (method === 'GET') return sendJson(response, 200, { ok: true, value: await status() })
          if (method !== 'POST' && method !== 'PATCH') return methodNotAllowed(response)
          if (!isSameOriginMutation(request)) return crossOrigin(response)
          const patch = parseSettingsPatch(await readJson(request))
          await settingsStore.updateSettings(patch)
          if (patch.enabled !== undefined || patch.enabledModelIds !== undefined || patch.defaultReasoningEffort !== undefined) ctx.emit?.('llm/adapters-updated')
          return sendJson(response, 200, { ok: true, value: await status() })
        }
        if (path === 'connection' || path === 'connection/test') {
          if (method !== 'POST') return methodNotAllowed(response)
          if (!isSameOriginMutation(request)) return crossOrigin(response)
          return sendJson(response, 200, { ok: true, value: await testQianwenConnection(store, options.fetchFn ?? fetch) })
        }
        if (path === 'cache/reset') {
          if (method !== 'POST') return methodNotAllowed(response)
          if (!isSameOriginMutation(request)) return crossOrigin(response)
          resetQianwenCacheStats()
          return sendJson(response, 200, { ok: true, value: await status() })
        }
        return sendJson(response, 404, { ok: false, error: 'Not Found' })
      } catch (error) {
        return sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
}
