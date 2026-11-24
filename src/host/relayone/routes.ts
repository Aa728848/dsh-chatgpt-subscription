import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isSameOriginMutation } from '../common/same-origin.ts'
import type { ContextWindowOverridePatch } from '../common/context-window-overrides.ts'
import {
  RELAYONE_PROVIDER_ID,
  RELAYONE_ROUTE_PREFIX,
  isRelayOneReasoningEffort,
  type RelayOneAccountAction,
  type RelayOneSettingsUpdateDto,
  type RelayOneStatusDto,
} from '../../shared/relayone-contracts.ts'
import { RelayOneAccountPool } from './account-pool.ts'
import { RelayOneCatalogManager } from './catalog-manager.ts'
import { relayOneModelOptions } from './model-catalog.ts'
import {
  RelayOneCredentialStore,
  RelayOneSettingsStore,
  type RelayOneSettingsPatch,
} from './token-store.ts'
import { testRelayOneConnection } from './client.ts'
import { idleRelayOneQuota, type RelayOneQuotaReader } from './quota.ts'
import { RELAYONE_MODELS_URL, relayOneHeaders, relayOneSafeDetail } from './types.ts'

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

/**
 * Ask the upstream whether one key works, without storing it.
 *
 * The model listing is the cheapest authenticated call RelayOne exposes and
 * costs no tokens, which is why both `add` and `test` use it rather than a
 * paid generation.
 */
async function verifyRelayOneKey(apiKey: string): Promise<void> {
  const response = await fetch(RELAYONE_MODELS_URL, { headers: relayOneHeaders(apiKey, false) })
  if (response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return
  }
  const detail = relayOneSafeDetail(await response.text().catch(() => ''), apiKey, 300)
  throw new Error('RelayOne 拒绝了这个 API Key（' + response.status + '）' + (detail ? '：' + detail : '。'))
}

export interface RelayOneRouteOptions {
  quota?: RelayOneQuotaReader
  serving?: boolean | (() => boolean)
  conflict?: string | null | (() => string | null)
  /**
   * The multi-key pool.
   *
   * Absent keeps the pre-pool routes working against the single key file, which
   * is what a host built before the pool answers.
   */
  accountPool?: RelayOneAccountPool | null
}

/** Whether the line has any key, through the pool when it has one. */
async function relayOneConfigured(
  store: RelayOneCredentialStore,
  pool: RelayOneAccountPool | null,
): Promise<boolean> {
  if (pool !== null) return (await pool.anyCredential().catch(() => null)) !== null
  return (await store.read().catch(() => null)) !== null
}

/** Local-first status; the network refresh begins behind the answer. */
export async function getRelayOneWebStatus(
  store: RelayOneCredentialStore,
  settingsStore: RelayOneSettingsStore,
  catalog: RelayOneCatalogManager,
  options: RelayOneRouteOptions = {},
): Promise<RelayOneStatusDto> {
  const pool = options.accountPool ?? null
  const [configured, settings, accounts] = await Promise.all([
    relayOneConfigured(store, pool),
    settingsStore.read(),
    pool === null ? Promise.resolve([]) : pool.listAccounts().catch(() => []),
    catalog.warm(),
  ])
  const optionsModels = relayOneModelOptions(catalog.snapshot().entries, settings)
  if (configured) {
    catalog.startRefresh(false)
    options.quota?.startRefresh(false)
  }
  const activeAccountId = pool === null ? undefined : await pool.activeAccountId().catch(() => undefined)
  return {
    providerId: RELAYONE_PROVIDER_ID,
    enabled: settings.enabled,
    authenticated: configured,
    storagePath: pool === null ? store.path() : pool.path(),
    accounts,
    ...(activeAccountId === undefined ? {} : { activeAccountId }),
    rotationStrategy: pool === null ? 'sequential' : await pool.strategy().catch(() => 'sequential' as const),
    models: optionsModels.filter(model => model.kind === 'chat'),
    mediaModels: optionsModels.filter(model => model.kind !== 'chat'),
    contextWindowOverrides: settings.contextWindowOverrides,
    defaultReasoningEffort: settings.defaultReasoningEffort,
    imageModel: settings.imageModel,
    videoModel: settings.videoModel,
    catalog: configured ? catalog.dto() : { state: 'idle', fetchedAt: null, error: null, groups: [] },
    quota: configured ? options.quota?.snapshot() ?? idleRelayOneQuota() : idleRelayOneQuota(),
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

/** The account actions the card may send, guarded so a typo is refused. */
const ACCOUNT_ACTIONS = new Set<RelayOneAccountAction>([
  'add', 'test', 'use', 'set-primary', 'set-alias', 'delete', 'clear-cooldown',
])

/** Route table mirrored by src/client/relayone/api.ts. */
export function registerRelayOneRoutes(
  ctx: Context,
  store: RelayOneCredentialStore,
  settingsStore: RelayOneSettingsStore,
  catalog: RelayOneCatalogManager,
  options: RelayOneRouteOptions = {},
): () => void {
  const pool = options.accountPool ?? null
  const status = () => getRelayOneWebStatus(store, settingsStore, catalog, options)

  /** Everything that must happen after the set of keys changes. */
  async function keysChanged(): Promise<void> {
    catalog.reset()
    options.quota?.reset()
    ctx.emit?.('llm/adapters-updated')
    await Promise.all([catalog.refresh(true), options.quota?.refresh(true)])
  }

  /**
   * One account action.
   *
   * `add` is the multi-key entry point: it stores nothing until the upstream
   * accepts the key, so a typo cannot silently join the rotation. Keeping the
   * verification here rather than in the card is what makes "add" and "test"
   * agree about what a usable key is.
   */
  async function accountAction(body: Record<string, unknown>): Promise<void> {
    if (pool === null) throw new Error('RelayOne 号池未启用。')
    const action = typeof body.action === 'string' ? body.action as RelayOneAccountAction : undefined
    if (action === undefined || !ACCOUNT_ACTIONS.has(action)) throw new Error('Unsupported account action.')
    const accountId = typeof body.accountId === 'string' && body.accountId.trim() !== '' ? body.accountId.trim() : undefined
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
    if (apiKey !== '' && apiKey.length > 4096) throw new Error('A valid RelayOne API key is required.')
    if (action === 'add') {
      if (apiKey === '') throw new Error('A valid RelayOne API key is required.')
      await verifyRelayOneKey(apiKey)
      const alias = typeof body.alias === 'string' && body.alias.trim() !== '' ? body.alias.trim() : undefined
      await pool.addAccount({ apiKey, authenticatedAt: Date.now() }, alias)
      catalog.reset()
      options.quota?.reset()
      ctx.emit?.('llm/adapters-updated')
      await Promise.all([catalog.refresh(true), options.quota?.refresh(true)])
      return
    }
    if (action === 'test') {
      if (apiKey === '') throw new Error('A valid RelayOne API key is required.')
      await verifyRelayOneKey(apiKey)
      return
    }
    if (action === 'use' && accountId !== undefined) {
      // The whole manual-switch feature: persist the choice, then let the next
      // request read it. The catalog and quota follow the selected key, so both
      // are re-scoped here rather than on the next timer tick.
      await pool.switchTo(accountId)
      catalog.reset()
      options.quota?.reset()
      ctx.emit?.('llm/adapters-updated')
      await Promise.all([catalog.refresh(true), options.quota?.refresh(true)])
      return
    }
    if (action === 'set-primary' && accountId !== undefined) {
      await pool.setPrimary(accountId)
      return
    }
    if (action === 'set-alias' && accountId !== undefined) {
      const alias = typeof body.alias === 'string' ? body.alias.trim() : ''
      if (alias === '') throw new Error('An alias is required.')
      await pool.setAlias(accountId, alias)
      return
    }
    if (action === 'delete' && accountId !== undefined) {
      await pool.deleteAccount(accountId)
      // Deleting the key that was serving requests must move the selection, or
      // the next request would resolve to an account that no longer exists.
      const activeId = await pool.activeAccountId().catch(() => undefined)
      const remaining = await pool.listAccounts().catch(() => [])
      if (remaining.length > 0 && !remaining.some(account => account.id === activeId)) {
        await pool.switchTo(remaining[0]!.id).catch(() => undefined)
      }
    } else if (action === 'clear-cooldown' && accountId !== undefined) await pool.clearCooldown(accountId)
    else if (accountId !== undefined) throw new Error('Unsupported account action.')
    await Promise.all([catalog.refresh(false), options.quota?.refresh(false)])
  }
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
        if (path === 'accounts') {
          if (method !== 'POST') return methodNotAllowed(response)
          if (!isSameOriginMutation(request)) return crossOrigin(response)
          await accountAction(await readJson(request))
          return sendJson(response, 200, { ok: true, value: await status() })
        }
        if (path === 'credentials') {
          if (method === 'DELETE') {
            if (!isSameOriginMutation(request)) return crossOrigin(response)
            // Deleting every key is the pool's job when it has one: clearing the
            // mirror alone would leave the rotation running on keys the user
            // just asked to remove.
            if (pool !== null) {
              for (const account of await pool.listAccounts().catch(() => [])) {
                await pool.deleteAccount(account.id).catch(() => undefined)
              }
            }
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
          // With a pool, this IS "add a key": the old route is what a card built
          // before the pool still calls, and it must not write a second copy of
          // the secret that the rotation then ignores.
          if (pool !== null) {
            await verifyRelayOneKey(apiKey)
            await pool.addAccount({ apiKey, authenticatedAt: Date.now() })
          } else {
            await store.write({ apiKey, authenticatedAt: Date.now() })
          }
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
