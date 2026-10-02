import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isSameOriginMutation } from '../common/same-origin.ts'
import type { OllamaAccountPool } from './account-pool.ts'
import { loadCatalog } from './client.ts'
import type { FileModelSettingsStore, OllamaCredentials } from './token-store.ts'
import { CLOUD_BASE_URL } from './types.ts'
import type { OllamaPoolStatusDto, OllamaWebStatus } from '../../shared/ollama-contracts.ts'

const ROUTE_PREFIX = '/ollama/api'

/** Where a user creates the keys this line stores. */
export const OLLAMA_KEYS_URL = 'https://ollama.com/settings/keys'

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(payload)
}

function sendMethodNotAllowed(response: ServerResponse): void {
  sendJson(response, 405, { ok: false, error: 'Method not allowed.' })
}

async function readRequestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    // A pasted key is short; anything far past that is not a credential and is
    // refused before it is buffered whole.
    if (size > 8_192) throw new Error('Request body is too large.')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Request body must be a JSON object.')
  }
  return parsed as Record<string, unknown>
}

export interface OllamaRouteOptions {
  accountPool: OllamaAccountPool
  modelSettings: FileModelSettingsStore
  fetchFn?: typeof fetch
}

/** Whether one account can serve a request right now. */
function isUsable(account: { cooldownUntil?: number; authStatus?: string }, now: number): boolean {
  if (account.authStatus !== undefined && account.authStatus !== 'ok') return false
  if (typeof account.cooldownUntil === 'number' && account.cooldownUntil > now) return false
  return true
}

/** Assemble the whole status payload the Ollama tab renders. */
export async function getOllamaWebStatus(options: OllamaRouteOptions): Promise<OllamaWebStatus> {
  const { accountPool, modelSettings } = options
  // A pool that cannot be read must not take the tab down: an empty list is a
  // truthful answer and the card renders its own 'add a key' state from it.
  const data = await accountPool.read().catch(() => null)
  const accounts = await accountPool.listAccounts().catch(() => [])
  const now = Date.now()
  const pool: OllamaPoolStatusDto = {
    accounts,
    rotationStrategy: data?.rotationStrategy ?? 'sequential',
    ...(data?.activeAccountId === undefined ? {} : { activeAccountId: data.activeAccountId }),
  }
  const settings = await modelSettings.read().catch(() => ({
    enabled: true, enabledModelIds: [], catalogModels: [], defaultReasoningEffort: null,
  }))
  return {
    pool,
    models: settings.catalogModels.map(model => ({ id: model.id, ...(model.name === undefined ? {} : { name: model.name }) })),
    usable: accounts.some(account => isUsable(account, now)),
    catalogSynced: settings.catalogModels.length > 0,
  }
}

/**
 * Register the Ollama settings API.
 *
 * The surface is deliberately the same one every other line exposes - status,
 * accounts, models - so the shared settings card and the client API helper
 * work against it without a per-provider special case.
 */
export function registerOllamaRoutes(ctx: Context, options: OllamaRouteOptions): () => void {
  const { accountPool, modelSettings } = options
  const fetchFn = options.fetchFn ?? fetch

  return ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url || '/', 'http://dsh.local')
      const path = url.pathname.replace(/^\/ollama\/api\/?/, '')
      const method = request.method ?? 'GET'

    if (path === '' || path === 'status') {
      return sendJson(response, 200, { ok: true, value: await getOllamaWebStatus(options) })
    }

    if (path === 'accounts') {
      if (method === 'GET') {
        return sendJson(response, 200, { ok: true, value: await getOllamaWebStatus(options) })
      }
      if (method !== 'POST') return sendMethodNotAllowed(response)
      if (!isSameOriginMutation(request)) {
        return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
      }
      let body: Record<string, unknown>
      try {
        body = await readRequestJson(request)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return sendJson(response, 400, { ok: false, error: message })
      }
      const action = typeof body.action === 'string' ? body.action : ''
      const accountId = typeof body.accountId === 'string' ? body.accountId : undefined
      try {
        if (action === 'add') {
          const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
          if (apiKey === '') {
            return sendJson(response, 400, { ok: false, error: 'API key is required.' })
          }
          // An alias is how several bare keys stay distinguishable, since the
          // service names nothing about the account behind one.
          const alias = typeof body.alias === 'string' && body.alias.trim() !== ''
            ? body.alias.trim()
            : undefined
          const credentials: OllamaCredentials = { apiKey, addedAt: Date.now() }
          if (alias !== undefined) credentials.alias = alias
          const account = await accountPool.addAccount(credentials, alias)
          return sendJson(response, 200, { ok: true, value: { id: account.id } })
        }
        if (accountId === undefined) {
          return sendJson(response, 400, { ok: false, error: 'accountId is required.' })
        }
        if (action === 'set-primary') {
          await accountPool.setPrimary(accountId)
        } else if (action === 'set-alias' && typeof body.alias === 'string') {
          await accountPool.setAlias(accountId, body.alias)
        } else if (action === 'delete') {
          await accountPool.deleteAccount(accountId)
        } else if (action === 'clear-cooldown') {
          await accountPool.clearCooldown(accountId)
        } else if (action === 'strategy'
          && (body.strategy === 'sequential' || body.strategy === 'round-robin' || body.strategy === 'sticky')) {
          await accountPool.setStrategy(body.strategy)
        } else {
          return sendJson(response, 400, { ok: false, error: 'Unsupported account action.' })
        }
      } catch (error) {
        // The pool's own message names the failure (a full pool, a missing
        // account), so it is what the card should show rather than a generic one.
        const message = error instanceof Error ? error.message : String(error)
        return sendJson(response, 400, { ok: false, error: message })
      }
      return sendJson(response, 200, { ok: true, value: await getOllamaWebStatus(options) })
    }

    if (path === 'models') {
      if (method === 'GET') {
        const settings = await modelSettings.read()
        return sendJson(response, 200, { ok: true, value: {
          models: settings.catalogModels,
          enabled: settings.enabled,
          enabledModelIds: settings.enabledModelIds,
        } })
      }
      if (method !== 'POST') return sendMethodNotAllowed(response)
      if (!isSameOriginMutation(request)) {
        return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
      }
      const body = await readRequestJson(request).catch(() => ({}) as Record<string, unknown>)
      if (typeof body.enabled === 'boolean') {
        await modelSettings.update({ enabled: body.enabled })
      }
      if (Array.isArray(body.enabledModelIds)) {
        await modelSettings.update({
          enabledModelIds: body.enabledModelIds.filter((id): id is string => typeof id === 'string'),
        })
      }
      return sendJson(response, 200, { ok: true, value: await modelSettings.read() })
    }

    if (path === 'catalog/refresh') {
      if (method !== 'POST') return sendMethodNotAllowed(response)
      if (!isSameOriginMutation(request)) {
        return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
      }
      // Sync needs a key; with none there is nothing to authenticate the call and
      // the card is told so rather than receiving a silent empty list.
      let credentials: OllamaCredentials | null = null
      try {
        const effective = await accountPool.getEffectiveCredential(undefined, fetchFn)
        credentials = effective.credentials
      } catch {
        credentials = null
      }
      if (credentials === null) {
        return sendJson(response, 400, { ok: false, error: 'Add an API key before syncing models.' })
      }
      const models = await loadCatalog(fetchFn, credentials).catch(() => [] as never)
      if (models.length === 0) {
        return sendJson(response, 502, { ok: false, error: 'Could not read the model list from Ollama.' })
      }
      await modelSettings.storeCatalog(models)
      return sendJson(response, 200, { ok: true, value: { models } })
    }
    },
  })
}
