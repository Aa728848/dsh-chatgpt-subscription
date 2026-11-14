/**
 * Host routes for the Antigravity (ACP) line: `/antigravity-acp/api/*`.
 *
 * The card needs exactly four things and no more: what executable is running,
 * whether the account is signed in, which models exist, and what the user chose.
 * Everything else - quota percentages, account lists, token expiry - is
 * deliberately absent, because the official ACP server publishes none of it and
 * a card that invents a number is worse than a card with one fewer row.
 *
 * Every state-changing path is a same-origin JSON POST. Reads are GET. No
 * response ever carries a credential: the plugin does not hold one to leak.
 *
 * @module dsh-chatgpt-subscription/host/antigravity-acp/routes
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isSameOriginMutation } from '../common/same-origin.ts'
import { ANTIGRAVITY_ACP_ROUTE_PREFIX } from '../../shared/antigravity-acp-contracts.ts'
import type {
  AntigravityAcpModelDto,
  AntigravityAcpPermissionPolicy,
  AntigravityAcpSettingsUpdateDto,
  AntigravityAcpStatusDto,
} from '../../shared/antigravity-acp-contracts.ts'
import type { AcpCatalog } from './catalog.ts'
import type { AntigravityAcpSettings, AntigravityAcpSettingsStore } from './settings.ts'
import type { ResolvedAcpBinary } from './binary.ts'
import type { AntigravityAcpUsageDto } from '../../shared/antigravity-acp-contracts.ts'
import { missingBinaryMessage } from './types.ts'

/** Largest settings body the card may submit. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * How old a persisted catalogue may be before the card calls it stale.
 *
 * A restart rehydrates the snapshot before any live read; that file is the last
 * successful listing and is as good as its age. A day is short enough that a
 * model retired upstream does not linger indefinitely, and long enough that a
 * host restarted twice in an afternoon still shows a current list.
 */
const CATALOG_FRESHNESS_MS = 24 * 60 * 60 * 1_000

/** What the routes read from the rest of the line. */
export interface AntigravityAcpRouteOptions {
  settings: AntigravityAcpSettingsStore
  catalog: AcpCatalog
  /** Resolve the executable on demand, so the card always shows the current one. */
  resolveBinary(): Promise<{ binary?: ResolvedAcpBinary; error?: string }>
  /** Start the official sign-in. */
  login(): Promise<{ started: boolean; error?: string }>
  /** Read the auth state; `force` bypasses any cache the line keeps around it. */
  auth(options?: { force?: boolean }): Promise<AntigravityAcpStatusDto['auth']>
  /** Last completed turn's token counts. */
  usage(): AntigravityAcpUsageDto | undefined
  /** Context occupancy of the live turn, when the server reported one. */
  occupancy?(): { used: number; size: number; at: number } | undefined
  /** Current route conflict, when another adapter owns the id. */
  conflict(): string | null
  /** Run the line's self-check; absent in builds that do not wire it. */
  runDoctor?(): Promise<{ ok: boolean; steps: { id: string; ok: boolean; detail: string }[] }>
}

/** Build the status payload the card renders. */
export async function readStatus(options: AntigravityAcpRouteOptions): Promise<AntigravityAcpStatusDto> {
  const settings = await options.settings.read()
  // A line the user switched off answers from the settings document alone. The
  // hub overview polls this route for every card on the settings page, and the
  // composer badge polls it every minute; resolving the executable and probing the
  // sign-in costs a whole `agy` process each time, which meant "switched off"
  // still launched the official CLI behind the user's back.
  if (!settings.enabled) return disabledStatus(settings)
  const resolved: { binary?: ResolvedAcpBinary; error?: string } = await options.resolveBinary()
    .catch((): { binary?: ResolvedAcpBinary; error?: string } => ({ error: 'The executable could not be resolved.' }))
  const catalog = await options.catalog.rehydrate()
  const auth = resolved.binary === undefined
    ? { authenticated: false }
    : await options.auth().catch(() => ({ authenticated: false }))
  const models = catalog?.models ?? []
  const conflict = options.conflict()
  return {
    enabled: settings.enabled,
    binary: resolved.binary === undefined
      ? { kind: 'missing', ...(resolved.error === undefined ? {} : { error: missingBinaryMessage(resolved.error) }) }
      : {
          kind: resolved.binary.kind,
          path: resolved.binary.path,
          ...(resolved.binary.version === undefined ? {} : { version: resolved.binary.version }),
        },
    auth,
    // The FULL catalogue, not the user's selection. The card needs every row to
    // render its checklist: filtering here made "nothing selected" look exactly
    // like "nothing synced", and hid the very control that could undo it.
    models,
    enabledModelIds: settings.enabledModelIds,
    defaultReasoningEffort: settings.defaultReasoningEffort,
    permissionPolicy: settings.permissionPolicy,
    nativeToolPolicy: settings.nativeToolPolicy,
    // A snapshot written moments ago is current data, not a stale placeholder:
    // "synced" describes whether the numbers may be trusted, and a fresh file is
    // exactly as trustworthy as the live read that wrote it.
    catalogSynced: catalog !== undefined && (catalog.fromSnapshot === false || Date.now() - catalog.fetchedAt < CATALOG_FRESHNESS_MS),
    ...(options.usage() === undefined ? {} : { usage: options.usage() }),
    ...(options.occupancy?.() === undefined ? {} : { occupancy: options.occupancy() }),
    ...(conflict === null ? {} : { routeConflict: conflict }),
  }
}

/**
 * The whole status payload for a line the user switched off.
 *
 * Deliberately answered without touching the agent: the executable is not
 * resolved, the sign-in is not probed and the catalogue snapshot is not read, so
 * a disabled line costs nothing but one file read. The model rows are kept as an
 * empty list rather than the cached catalogue on purpose - a card that still
 * lists models while the line is off reads as "available but hidden", which is
 * exactly the claim the switch is meant to make false.
 *
 * @param settings - The line's stored preferences.
 * @returns A status with nothing running and the switch reported as off.
 */
function disabledStatus(settings: AntigravityAcpSettings): AntigravityAcpStatusDto {
  return {
    enabled: false,
    binary: { kind: 'missing' },
    auth: { authenticated: false },
    models: [],
    enabledModelIds: settings.enabledModelIds,
    defaultReasoningEffort: settings.defaultReasoningEffort,
    permissionPolicy: settings.permissionPolicy,
    nativeToolPolicy: settings.nativeToolPolicy,
    catalogSynced: false,
  }
}

/**
 * Mount every route of this line.
 *
 * @param ctx - Plugin context owning the web server.
 * @param options - The line's live state and actions.
 * @returns Disposer for the routes.
 */
export function registerAntigravityAcpRoutes(ctx: Context, options: AntigravityAcpRouteOptions): () => void {
  return ctx.webServer.register({
    kind: 'prefix',
    path: ANTIGRAVITY_ACP_ROUTE_PREFIX,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url || '/', 'http://dsh.local')
      const path = url.pathname.replace(/^\/antigravity-acp\/api\/?/, '')
      const method = request.method ?? 'GET'
      try {
        if (path === '' || path === 'status') {
          if (method !== 'GET') return sendMethodNotAllowed(response)
          return sendJson(response, 200, { ok: true, value: await readStatus(options) })
        }

        if (path === 'settings' || path === 'models') {
          if (method === 'GET') {
            return sendJson(response, 200, { ok: true, value: await readStatus(options) })
          }
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) {
            return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          }
          const body = await readRequestJson(request).catch(() => ({} as Record<string, unknown>))
          const update = readSettingsUpdate(body)
          if (update === undefined) {
            return sendJson(response, 400, { ok: false, error: 'Unsupported settings value.' })
          }
          const before = await options.settings.read()
          const wrote = await options.settings.update(update)
          // Only a real change rebuilds the picker; a body that changed nothing
          // must not make the model list flicker under the user.
          if (!sameSettings(before, wrote)) ctx.emit?.('llm/adapters-updated')
          if (update.binaryPath !== undefined) {
            // A different executable means a different account and a different
            // catalogue; the cached one belongs to the old binary.
            options.catalog.invalidate()
            await options.catalog.read({ force: true }).catch(() => undefined)
          }
          return sendJson(response, 200, { ok: true, value: await readStatus(options) })
        }

        if (path === 'login/start') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) {
            return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          }
          const started = await options.login()
          if (!started.started) {
            return sendJson(response, 400, { ok: false, error: started.error ?? 'Sign-in could not be started.' })
          }
          return sendJson(response, 200, { ok: true, value: { started: true } })
        }

        if (path === 'login/status') {
          if (method !== 'GET') return sendMethodNotAllowed(response)
          return sendJson(response, 200, { ok: true, value: await options.auth() })
        }

        if (path === 'logout') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) {
            return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          }
          // Signing out is the official CLI's own operation; this host cannot
          // perform it and says so rather than pretending the state changed.
          return sendJson(response, 400, {
            ok: false,
            error: 'Sign-out belongs to the Antigravity CLI. Run `agy` and use /logout there; this card will then show the new state.',
          })
        }

        if (path === 'usage') {
          if (method !== 'GET' && method !== 'POST') return sendMethodNotAllowed(response)
          if (method === 'POST' && !isSameOriginMutation(request)) {
            return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          }
          return sendJson(response, 200, { ok: true, value: options.usage() ?? null })
        }

        if (path === 'doctor') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) {
            return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          }
          if (options.runDoctor === undefined) {
            return sendJson(response, 501, { ok: false, error: 'This build has no self-check wired.' })
          }
          const report = await options.runDoctor()
          return sendJson(response, 200, { ok: true, value: report })
        }

        if (path === 'refresh') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) {
            return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          }
          const refreshed = await options.catalog.read({ force: true }).catch(() => undefined)
          // The refresh click is the user saying "ask again", so the cached
          // sign-in answer is invalidated with it.
          await options.auth({ force: true }).catch(() => undefined)
          if (refreshed === undefined) {
            // A silent 200 over an empty catalogue is what made "sync models"
            // look like it did nothing: the click has to report the failure.
            return sendJson(response, 502, {
              ok: false,
              error: 'The Antigravity agent returned no model list. Run the self-check above, or check that the CLI is signed in.',
            })
          }
          return sendJson(response, 200, { ok: true, value: await readStatus(options) })
        }

        return sendJson(response, 404, { ok: false, error: 'Not found.' })
      } catch (error) {
        // A rejected handler would otherwise answer an empty body, which the card
        // can only report as a JSON parse error (the Ollama line's issue #36).
        return sendJson(response, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  })
}

/** Models the user chose to expose; `null` means every model. */
export function visibleModels(models: readonly AntigravityAcpModelDto[], settings: AntigravityAcpSettings): AntigravityAcpModelDto[] {
  const enabled = settings.enabledModelIds
  if (enabled === null) return [...models]
  const allowed = new Set(enabled)
  return models.filter((model) => allowed.has(model.id))
}

/**
 * Read one settings body.
 *
 * A field of the wrong type refuses the whole body: half-applying a patch is how
 * a card ends up showing a state the user never chose.
 *
 * @param body - Parsed JSON object.
 * @returns The patch, or undefined when any field is unacceptable.
 */
export function readSettingsUpdate(body: Record<string, unknown>): AntigravityAcpSettingsUpdateDto | undefined {
  const update: AntigravityAcpSettingsUpdateDto = {}
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return undefined
    update.enabled = body.enabled
  }
  if (body.enabledModelIds !== undefined) {
    if (body.enabledModelIds === null) {
      update.enabledModelIds = null
    } else if (Array.isArray(body.enabledModelIds)) {
      const ids = body.enabledModelIds.filter((id): id is string => typeof id === 'string')
      if (ids.length !== body.enabledModelIds.length) return undefined
      update.enabledModelIds = ids
    } else {
      return undefined
    }
  }
  if (body.defaultReasoningEffort !== undefined) {
    if (body.defaultReasoningEffort === null) {
      update.defaultReasoningEffort = null
    } else if (typeof body.defaultReasoningEffort === 'string') {
      update.defaultReasoningEffort = body.defaultReasoningEffort
    } else {
      return undefined
    }
  }
  if (body.permissionPolicy !== undefined) {
    const policy = body.permissionPolicy
    if (policy !== 'reject' && policy !== 'allow') return undefined
    update.permissionPolicy = policy as AntigravityAcpPermissionPolicy
  }
  if (body.nativeToolPolicy !== undefined) {
    const policy = body.nativeToolPolicy
    if (policy !== 'allow' && policy !== 'cancel') return undefined
    update.nativeToolPolicy = policy
  }
  if (body.binaryPath !== undefined) {
    if (body.binaryPath === null) {
      update.binaryPath = null
    } else if (typeof body.binaryPath === 'string') {
      update.binaryPath = body.binaryPath
    } else {
      return undefined
    }
  }
  return update
}

function sameSettings(left: AntigravityAcpSettings, right: AntigravityAcpSettings): boolean {
  return left.enabled === right.enabled
    && left.defaultReasoningEffort === right.defaultReasoningEffort
    && left.permissionPolicy === right.permissionPolicy
    && left.nativeToolPolicy === right.nativeToolPolicy
    && left.binaryPath === right.binaryPath
    && JSON.stringify(left.enabledModelIds) === JSON.stringify(right.enabledModelIds)
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
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
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large.')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Request body must be a JSON object.')
  }
  return parsed as Record<string, unknown>
}
