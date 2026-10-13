import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isSameOriginMutation } from '../common/same-origin.ts'
import type { OllamaAccountPool } from './account-pool.ts'
import { fetchCatalog, type OllamaCatalogResult } from './client.ts'
import type { FileModelSettingsStore, OllamaCredentials } from './token-store.ts'
import { CLOUD_BASE_URL } from './types.ts'
import {
  isOllamaReasoningEffort,
  type OllamaPoolStatusDto,
  type OllamaReasoningEffort,
  type OllamaWebStatus,
} from '../../shared/ollama-contracts.ts'

const ROUTE_PREFIX = '/ollama/api'

/** Where a user creates the keys this line stores. */
export const OLLAMA_KEYS_URL = 'https://ollama.com/settings/keys'

/**
 * The one sentence every refused thinking level answers with.
 *
 * Names the accepted values because the card sends its own dropdown values, so a
 * rejected body is a stale card talking to a newer line (or the reverse), and
 * the fix is on whichever side moved.
 */
const UNSUPPORTED_EFFORT_ERROR =
  'Unsupported reasoning effort. Expected null, or one of: none, low, medium, high.'

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

/**
 * The sentence the card shows for a catalog read that produced nothing.
 *
 * Every one of these used to collapse into "Could not read the model list from
 * Ollama", which told a user nothing they could act on — the complaint in issue
 * #36. The four causes have four different remedies, so they are named apart.
 */
function catalogFailureMessage(result: OllamaCatalogResult): string {
  switch (result.failure) {
    case 'auth':
      return `Ollama rejected the stored API key (HTTP ${result.status ?? 401}). Create or re-paste a key at ${OLLAMA_KEYS_URL}.`
    case 'upstream':
      return `Ollama answered HTTP ${result.status ?? '?'} for ${CLOUD_BASE_URL}/api/tags.`
    case 'unreachable':
      return 'Could not reach Ollama Cloud. Check the network or proxy, then sync again.'
    case 'malformed':
      return 'Ollama answered with something that is not a /api/tags document (a proxy or filter may be rewriting the reply).'
    default:
      return 'Could not read the model list from Ollama.'
  }
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
    enabled: true, enabledModelIds: null, catalogModels: [], defaultReasoningEffort: null,
  }))
  return {
    pool,
    models: settings.catalogModels.map(model => ({ id: model.id, ...(model.name === undefined ? {} : { name: model.name }) })),
    enabledModelIds: settings.enabledModelIds,
    usable: accounts.some(account => isUsable(account, now)),
    catalogSynced: settings.catalogModels.length > 0,
    // Coerced rather than passed through: this line's whole status used to be
    // blanked by one absent field, and a settings store built against an older
    // shape must not be able to do that here.
    defaultReasoningEffort: settings.defaultReasoningEffort ?? null,
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

      // Every branch below answers inside this try. A handler that rejects gets
      // no envelope at all: DSH's web server catches it and answers a bare
      // 400 with an empty body, which the card could only report as the browser's
      // "Failed to execute 'json' on 'Response': Unexpected end of JSON input"
      // (issue #36) — the real cause was logged on the host and nowhere else.
      // The siblings already wrap their handlers this way; this line was the
      // one that did not.
      try {
      if (path === '' || path === 'status') {
        return sendJson(response, 200, { ok: true, value: await getOllamaWebStatus(options) })
      }

      if (path === 'settings') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) {
          return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
        }
        const body = await readRequestJson(request).catch(() => ({}) as Record<string, unknown>)
        // Read before anything is written, so a body naming a level this line
        // does not have is refused whole instead of half-applied. null must
        // survive as a real answer: it is how the card undoes a stored level,
        // and a truthiness check here would make that undo impossible.
        let effort: OllamaReasoningEffort | null | undefined
        if (body.defaultReasoningEffort !== undefined) {
          const submitted = body.defaultReasoningEffort
          if (submitted !== null && !isOllamaReasoningEffort(submitted)) {
            return sendJson(response, 400, { ok: false, error: UNSUPPORTED_EFFORT_ERROR })
          }
          effort = submitted
        }
        let touched = false
        // The hub card's line switch; every sibling line commits the same flag
        // through its own '/settings', and the picker learns of the change
        // through the same event they emit.
        if (typeof body.enabled === 'boolean') {
          await modelSettings.update({ enabled: body.enabled })
          touched = true
        }
        if (effort !== undefined) {
          await modelSettings.update({ defaultReasoningEffort: effort })
          touched = true
        }
        // Emitted only for a real write, like '/models': a body that changed
        // nothing must not rebuild the model picker under the user.
        if (touched) ctx.emit?.('llm/adapters-updated')
        return sendJson(response, 200, { ok: true, value: await modelSettings.read() })
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
            // No early answer here: the card stores the reply of every account
            // action as the status it renders, so add must fall through to the
            // same full-status answer as its siblings — a bare '{id}' crashed
            // the tab's render and blanked the settings page.
            await accountPool.addAccount(credentials, alias)
          } else if (accountId === undefined) {
            return sendJson(response, 400, { ok: false, error: 'accountId is required.' })
          } else if (action === 'set-primary') {
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
        // Validated first, before either write, for the same reason the
        // '/settings' branch does it: a rejected body must leave the stored
        // settings exactly as they were rather than half-applied. The card's
        // model block and its line block both post here, so both are answered
        // by the one check.
        let effort: OllamaReasoningEffort | null | undefined
        if (body.defaultReasoningEffort !== undefined) {
          const submitted = body.defaultReasoningEffort
          if (submitted !== null && !isOllamaReasoningEffort(submitted)) {
            return sendJson(response, 400, { ok: false, error: UNSUPPORTED_EFFORT_ERROR })
          }
          effort = submitted
        }
        let touched = false
        if (typeof body.enabled === 'boolean') {
          await modelSettings.update({ enabled: body.enabled })
          touched = true
        }
        // Null is "no filter": every catalogued model, including ones a later
        // sync adds. An array is an explicit selection — and an empty one
        // switches every model off, which the old empty-means-all shape could
        // not say at all.
        if (Array.isArray(body.enabledModelIds) || body.enabledModelIds === null) {
          await modelSettings.update({
            enabledModelIds: Array.isArray(body.enabledModelIds)
              ? body.enabledModelIds.filter((id): id is string => typeof id === 'string')
              : null,
          })
          touched = true
        }
        if (effort !== undefined) {
          await modelSettings.update({ defaultReasoningEffort: effort })
          touched = true
        }
        // The model picker learns the offer changed only through this event;
        // without it an unchecked model stays selectable until another line
        // happens to emit.
        if (touched) ctx.emit?.('llm/adapters-updated')
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
        let poolBusy = false
        try {
          const effective = await accountPool.getEffectiveCredential(undefined, fetchFn)
          credentials = effective.credentials
        } catch {
          // Two different refusals share this catch and must not be reported as
          // one. 'No key at all' means the card must ask for a key; 'every key is
          // cooling down' means the pool is busy and waiting is the only move, and
          // telling that user to add a key would send them for a key that changes
          // nothing.
          poolBusy = await accountPool.read().then(data =>
            data.accounts.length > 0
            && data.accounts.every(account => isUsable(account, Date.now()) === false),
          ).catch(() => false)
          credentials = null
        }
        if (credentials === null) {
          return sendJson(response, 400, {
            ok: false,
            error: poolBusy
              ? 'Every stored Ollama key is cooling down right now. Wait for the cooldown, then sync again.'
              : 'Add an API key before syncing models.',
          })
        }
        const result = await fetchCatalog(fetchFn, credentials)
        if (result.models.length === 0) {
          return sendJson(response, 502, { ok: false, error: catalogFailureMessage(result) })
        }
        try {
          await modelSettings.storeCatalog(result.models)
        } catch (error) {
          // The list WAS read; only the local write failed. Saying so is the
          // difference between a user retrying a sync that will fail the same way
          // and a user looking at their settings directory.
          const detail = error instanceof Error ? error.message : String(error)
          return sendJson(response, 500, {
            ok: false,
            error: `Read ${result.models.length} models from Ollama but could not save them locally: ${detail}`,
          })
        }
        return sendJson(response, 200, { ok: true, value: { models: result.models } })
      }

      return sendJson(response, 404, { ok: false, error: 'not-found' })
      } catch (error) {
        // The last line of defence. Anything that still throws — a settings file
        // that cannot be read, a pool document that cannot be parsed — is
        // reported as the reason it is, in the same envelope every other branch
        // uses, rather than as an empty body the card cannot read.
        const message = error instanceof Error ? error.message : String(error)
        return sendJson(response, 500, { ok: false, error: message })
      }
    },
  })
}
