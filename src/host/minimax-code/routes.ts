/**
 * Web routes for the MiniMax Code line.
 *
 * The six routes below are the frozen contract the client half consumes (brief
 * section 3). Their paths, request bodies and verdicts are therefore not free:
 * this file implements them as specified rather than as this line might prefer.
 *
 * Response envelope: every route answers \`{ ok: true, value: <payload> }\`, which is
 * what the sibling lines in this package use. The three routes whose contract names
 * a top-level key as well (\`/login/start\` -> \`login\`, \`/login/poll\` -> \`status\` and
 * \`account\`, \`/test\` -> \`ok\`/\`model\`/\`error\`) carry that key at the top level too,
 * so a client written against either reading resolves. \`/test\` is the one route
 * where the envelope's \`ok\` cannot double as the payload's: its contract defines
 * \`ok\` as the probe verdict, so the envelope there is the verdict itself and the
 * duplicate lives under \`value\`.
 *
 * Mounting: the routes are registered under BOTH the contract prefix and the
 * sibling-line convention, because the two disagree in this repository and the
 * client half must not be able to miss them for that reason alone.
 *
 * \`/models\` and \`/settings\` are the model-settings half every sibling line has and
 * this one shipped without. They are two names for one route because the sibling
 * cards disagree about which to call: kimi-code and claude call it \`/models\`,
 * workbuddy and command-code call it \`/settings\`. Serving both costs one string
 * comparison and removes a client-side special case.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isSameOriginMutation } from '../common/same-origin.ts'
import {
  MINIMAX_CODE_PROVIDER_ID,
  MINIMAX_CODE_ROUTE_PREFIX,
  type MinimaxCodeQuota,
  type MinimaxCodeReasoningEffort,
  type MinimaxCodeRegion,
  type MinimaxCodeWebLogin,
  type MinimaxCodeWebStatus,
} from '../../shared/minimax-code-contracts.ts'
import { PROVIDER_ID, isMinimaxCodeReasoningEffort, isRegion } from './types.ts'
import { MIN_CONTEXT_WINDOW, buildMinimaxCodeModelOptions } from './model-catalog.ts'
import {
  createMinimaxCodeAccountsHandler,
  minimaxCodePoolStatus,
  type MinimaxCodeAccountPool,
} from './account-pool.ts'
import type { ContextWindowOverridePatch } from '../common/context-window-overrides.ts'
import {
  MinimaxCodeCredentialStore,
  MinimaxCodeModelSettingsStore,
  type MinimaxCodeCredentials,
  type MinimaxCodeModelSettings,
  type MinimaxCodePreferenceStore,
  type MinimaxCodeSettingsPatch,
} from './token-store.ts'
import {
  accountFromCredentials,
  beginWebLogin,
  cancelWebLogin,
  ensureAccessToken,
  getWebLogin,
  pollWebLogin,
  revokeToken,
  MinimaxCodeAccessDeniedError,
  MinimaxCodeUnauthorizedError,
} from './oauth.ts'
import {
  clearCachedQuota,
  fetchTokenPlanQuota,
  getCachedQuota,
  getQuotaUnavailable,
  testConnection,
} from './client.ts'
import type { MinimaxCodeCheckinService } from './checkin.ts'
import { QuotaRefresh } from '../common/quota-refresh.ts'

/** Path the sibling lines register (\`/kimi-code/api\`, \`/workbuddy/api\`). */
const MAX_BODY_BYTES = 64 * 1024

/** The last sign-in this process started, so /status can render it. */
let latestLogin: MinimaxCodeWebLogin | null = null

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

function sendMethodNotAllowed(response: ServerResponse): void {
  sendJson(response, 405, { ok: false, error: 'Method Not Allowed' })
}

function sendCrossOrigin(response: ServerResponse): void {
  sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
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

/** The sub-path one request addresses, whichever prefix it arrived under. */
export function subPathOf(requestUrl: string): string {
  const pathname = new URL(requestUrl || '/', 'http://dsh.local').pathname
  const prefix = MINIMAX_CODE_ROUTE_PREFIX
  if (pathname === prefix) return ''
  if (pathname.startsWith(prefix + '/')) return pathname.slice(prefix.length + 1)
  return pathname.replace(/^\/+/, '')
}

/**
 * The stored selection, however this deployment persists it.
 *
 * The routes accept either shape so a composition that still has the register
 * settings seam and one that only has the file both work: the caller passes
 * whichever it wired, and nothing in this file needs to know which it got. The
 * patch type is the store's own, deliberately, so a field added to the settings
 * document cannot become one this route accepts but the stores silently drop.
 */
export interface MinimaxCodeSettingsSource {
  /** Current selection: a value on the register seam, a read on the file store. */
  status(): Promise<MinimaxCodeModelSettings> | MinimaxCodeModelSettings
  update(patch: MinimaxCodeSettingsPatch): Promise<MinimaxCodeModelSettings>
}

/**
 * Default source: the JSON file beside the credentials.
 *
 * Wrapped rather than used directly because the file store reads
 * asynchronously while a registered scope reads from memory; this collapses the
 * two into the one promise-shaped call the routes make. */
function fileSettingsSource(store: MinimaxCodeModelSettingsStore): MinimaxCodeSettingsSource {
  return {
    status: () => store.read(),
    update: (patch) => store.updateSettings(patch),
  }
}

/** The registered store, if this deployment has one. */
function registeredSettingsSource(preferences: MinimaxCodePreferenceStore): MinimaxCodeSettingsSource {
  return {
    status: () => preferences.status(),
    update: (patch) => preferences.update(patch),
  }
}

export interface MinimaxCodeStatusOptions {
  fetchFn?: typeof fetch
  /** Whether this plugin currently owns the provider route; re-read on every status. */
  serving?: boolean | (() => boolean)
  /** Diagnostic when another plugin owns the provider route; re-read on every status. */
  conflict?: string | null | (() => string | null)
  /**
   * Where the model selection lives.
   *
   * Omitted, the routes read the default settings file, which is what a caller
   * that only wants the connection half of the card gets. The plugin entry
   * supplies the same store the adapter was built with, so the card and the
   * request path can never read two different selections.
   */
  settings?: MinimaxCodeSettingsSource
  /**
   * The account pool, when this process installed one.
   *
   * Omitting it is a supported posture: the line then behaves as the
   * single-credential route it was before the pool existed, and the status
   * reports `poolInstalled: false` so the card can say so rather than render an
   * empty account list that looks like a bug.
   */
  accountPool?: MinimaxCodeAccountPool
  /** Daily check-in scheduler; absent leaves the card's check-in row empty. */
  checkin?: Pick<MinimaxCodeCheckinService, 'tick' | 'summary'>
}

/** Read one status option, which the caller may supply as a live predicate. */
function readOption<T>(value: T | (() => T) | undefined, fallback: T): T {
  return typeof value === 'function' ? (value as () => T)() : value ?? fallback
}

/** Everything the settings card renders. */
export async function getMinimaxCodeWebStatus(
  store: MinimaxCodeCredentialStore,
  options: MinimaxCodeStatusOptions = {},
  settingsSource?: MinimaxCodeSettingsSource,
): Promise<MinimaxCodeWebStatus> {
  const settings = await (settingsSource ?? options.settings
    ?? fileSettingsSource(new MinimaxCodeModelSettingsStore())).status()
  // One pass over the credential files, not three: this route is polled by the
  // settings card, and the targeted accessors would each re-read and re-parse the
  // native document (one file read plus one JSON parse per probed region).
  const { credentials, source, path } = await store.readWithProvenance()
  const region: MinimaxCodeRegion = credentials?.region ?? 'cn'
  // The provider route is contended exactly like the sibling lines', so the same
  // two facts every other card renders are reported here too: whether this plugin
  // owns the id, and why not when another adapter family does.
  const serving = readOption(options.serving, true)
  const conflict = readOption(options.conflict, null)
  // The card renders the whole shipped catalog and greys out what is disabled,
  // so `models` carries every entry with its own `enabled` flag rather than the
  // enabled subset: a filtered list could not show a model to re-enable it.
  const enabled = settings.enabled !== false
  // The pool slice is read through its own helper so a missing or unreadable pool
  // degrades to an empty list instead of failing the whole card: the connection
  // section is still worth rendering.
  const pool = await minimaxCodePoolStatus(options.accountPool)
  // Read once: the value is used for both the presence test and the payload, and
  // calling it twice could straddle a background refresh and disagree with itself.
  const quota = getCachedQuota()
  // Only meaningful while no snapshot exists: once one does, the card renders it.
  const quotaUnavailable = quota === null ? getQuotaUnavailable() : null
  // The summary is local state only, but a broken state file must not take the
  // whole status payload down with it.
  const checkin = options.checkin === undefined
    ? null
    : await options.checkin.summary().catch(() => null)
  return {
    ...pool,
    serving,
    conflict,
    enabled,
    authenticated: credentials !== null,
    providerId: PROVIDER_ID,
    region,
    // The kind reports which file the credential in force came from, so a user can
    // see whether the plugin is riding the desktop app's session or its own.
    storage: { kind: source, path },
    ...(credentials === null ? {} : { account: accountFromCredentials(credentials) }),
    ...(latestLogin === null ? {} : { login: latestLogin }),
    // The hardcoded directory, rendered through the current selection. Nothing
    // here calls /v1/models, which is unavailable on this endpoint (503
    // direct_route_not_configured).
    models: buildMinimaxCodeModelOptions(
      settings.enabledModelIds,
      settings.contextWindowOverrides,
      enabled,
    ),
    contextWindowOverrides: settings.contextWindowOverrides,
    defaultReasoningEffort: settings.defaultReasoningEffort,
    // True only for a credential in force that this plugin itself wrote, and may
    // therefore revoke and delete. A native `~/.minimax/auth` sign-in is reused
    // and renewed in place, but the desktop app owns it: the card must offer no
    // sign-out that would destroy it, and with no credential at all there is no
    // ownership to report.
    ownedByPlugin: credentials !== null && source === 'file',
    // The last usage snapshot, read WITHOUT touching the network: this function is
    // polled by the card, and a usage read that failed would otherwise put a
    // timeout in the middle of every poll. The registered route refreshes the
    // snapshot in the background and `/quota` forces one on demand.
    ...(quota === null ? {} : { quota }),
    ...(quotaUnavailable === null ? {} : { quotaUnavailable }),
    checkin,
  }
}

export function registerMinimaxCodeRoutes(
  ctx: Context,
  store: MinimaxCodeCredentialStore = new MinimaxCodeCredentialStore(),
  options: MinimaxCodeStatusOptions = {},
  modelSettings: MinimaxCodeModelSettingsStore = new MinimaxCodeModelSettingsStore(),
  preferences?: MinimaxCodePreferenceStore,
): () => void {
  const fetchFn = options.fetchFn ?? fetch
  // The registered scope when the harness still has one, the JSON file beside the
  // credentials otherwise. Both are handed to getMinimaxCodeWebStatus explicitly
  // so the status the card renders and the store a POST writes are the same one.
  const settings: MinimaxCodeSettingsSource = options.settings
    ?? (preferences === undefined ? fileSettingsSource(modelSettings) : registeredSettingsSource(preferences))
  // The account half, as one handler the parent dispatches to. It shares this
  // file's status reader, so a POST answers with the same payload a GET would,
  // and the card re-renders in one round trip.
  const accountsHandler = createMinimaxCodeAccountsHandler(options.accountPool, {
    readStatus: () => getMinimaxCodeWebStatus(store, options, settings),
  })

  /**
   * Refresh the Token Plan usage snapshot, returning the fresh value.
   *
   * Only a real composition refreshes: `options.fetchFn` being supplied is the
   * marker, so a test that registers these routes without one never reaches the
   * network, and the status route reads the snapshot through the cache instead.
   */
  const refreshQuota = async (force: boolean): Promise<MinimaxCodeQuota | null> => {
    // `ensureAccessToken`, NOT a bare `store.read()`: the usage read used to carry
    // whatever token the file happened to hold, and with a 60-second refresh margin
    // on a one-hour token that meant the poll landing just after the boundary
    // presented a bearer the service had already stopped accepting.
    const credentials = await ensureAccessToken(store, { fetchFn }).catch(() => null)
    if (credentials === null) return null
    return await fetchTokenPlanQuota(credentials, {
      fetchFn,
      force,
      // The retry after a 401/403. Forced, because the whole point is that the
      // token on hand is the one that was just refused.
      renewCredential: () => ensureAccessToken(store, { fetchFn, force: true }),
    }).catch(() => null)
  }

  /**
   * The in-flight usage read, so the card can be told one is running.
   *
   * This line previously fired the background read with a bare `void`, which
   * discarded the only fact the card needed: nothing. On a cold start there is no
   * snapshot yet, so the answer carried `quota: undefined` and the refresh that
   * would fill it was already running but invisible. The card then showed "no
   * usage data" until its next 60 s poll — which, on a page opened right after a
   * restart, is most of a minute of a quota box the user just signed in to fill.
   * Every sibling line reports the flag and the client schedules a short
   * follow-up (see QuotaRefresh and client/common/quota-follow-up.ts); this one
   * had neither half.
   */
  const quotaRefresh = new QuotaRefresh()

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = subPathOf(request.url ?? '/')
    const method = request.method ?? 'GET'

    try {
      if (path === 'accounts') return accountsHandler(request, response)

      if (path === '' || path === 'status') {
        if (method !== 'GET') return sendMethodNotAllowed(response)
        // Refresh usage BEHIND the answer rather than inside it. Awaiting here would
        // put a network timeout in the middle of a poll whenever the usage host is
        // unreachable, and the card is polled; the snapshot it already had is
        // rendered now and the refreshed one arrives on the follow-up poll (or at
        // once from `/quota`).
        //
        // A card with NO snapshot has nothing to render meanwhile, so that first
        // read is awaited rather than backgrounded: the answer must not go out
        // reporting an empty quota box when the numbers were one request away. It
        // costs one upstream round trip exactly once per snapshot lifetime.
        if (options.fetchFn !== undefined) {
          if (getCachedQuota() === null) await quotaRefresh.run(() => refreshQuota(false))
          else quotaRefresh.start(() => refreshQuota(false))
        }
        const value = await getMinimaxCodeWebStatus(store, options, settings)
        return sendJson(response, 200, {
          ok: true,
          value: { ...value, quotaRefreshing: quotaRefresh.refreshing },
        })
      }

      if (path === 'quota') {
        if (method !== 'GET' && method !== 'POST') return sendMethodNotAllowed(response)
        if (method === 'POST' && !isSameOriginMutation(request)) return sendCrossOrigin(response)
        // A failed usage read is not a failed request: the contract makes `quota`
        // optional, so the card renders "no data" exactly as it does before the
        // first snapshot, and nothing about the connection half is affected.
        //
        // `run` rather than the bare call this used to make, so a read that THROWS
        // is recorded instead of surfacing as an unhandled rejection on a promise
        // nothing was awaiting.
        await quotaRefresh.run(() => refreshQuota(method === 'POST'))
        const value = await getMinimaxCodeWebStatus(store, options, settings)
        return sendJson(response, 200, {
          ok: true,
          value: { ...value, quotaRefreshing: quotaRefresh.refreshing },
        })
      }

      if (path === 'models' || path === 'settings') {
        if (method === 'GET') {
          const value = await getMinimaxCodeWebStatus(store, options, settings)
          return sendJson(response, 200, { ok: true, value })
        }
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        const body = await readRequestJson(request)
        const patch: MinimaxCodeSettingsPatch = {}
        if (typeof body.enabled === 'boolean') {
          patch.enabled = body.enabled
        }
        if (Array.isArray(body.enabledModelIds)) {
          patch.enabledModelIds = body.enabledModelIds.filter((id): id is string => typeof id === 'string')
        }
        if (typeof body.contextWindowOverrides === 'object' && body.contextWindowOverrides !== null) {
          const overrides: ContextWindowOverridePatch = {}
          for (const [key, raw] of Object.entries(body.contextWindowOverrides as Record<string, unknown>)) {
            // `null` is the card's "restore the catalog default" and has to
            // survive normalization so the store can delete exactly that key. A
            // bad number is dropped rather than corrected: the route cannot know
            // which window the user meant, and a value under MIN_CONTEXT_WINDOW
            // is refused by the merge anyway.
            if (raw === null) overrides[key] = null
            else if (typeof raw === 'number' && Number.isFinite(raw) && raw >= MIN_CONTEXT_WINDOW) {
              overrides[key] = Math.floor(raw)
            }
          }
          patch.contextWindowOverrides = overrides
        }
        if (body.defaultReasoningEffort !== undefined) {
          const effort = body.defaultReasoningEffort
          if (effort === null || isMinimaxCodeReasoningEffort(effort)) {
            patch.defaultReasoningEffort = effort
          }
        }
        if (typeof body.checkin === 'object' && body.checkin !== null) {
          const raw = body.checkin as Record<string, unknown>
          if (typeof raw.enabled === 'boolean') patch.checkin = { enabled: raw.enabled }
        }
        await settings.update(patch)
        // DSH rebuilds the model picker on this event. Only the two fields that
        // change which models exist are worth waking it for; a window override or
        // an effort change alters no picker entry, and emitting for them would
        // make every keystroke in the card's window field rebuild the list.
        if (patch.enabled !== undefined || patch.enabledModelIds !== undefined) {
          ctx.emit?.('llm/adapters-updated')
        }
        const value = await getMinimaxCodeWebStatus(store, options, settings)
        return sendJson(response, 200, { ok: true, value })
      }

      if (path === 'checkin/now') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        const service = options.checkin
        if (service === undefined) return sendJson(response, 400, { ok: false, error: 'Check-in is not installed.' })
        // The manual pass ignores the toggle and the retry cap, but still
        // respects an account already signed in today.
        await service.tick(true)
        const value = await getMinimaxCodeWebStatus(store, options, settings)
        return sendJson(response, 200, { ok: true, value })
      }

      if (path === 'login/start') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        const body = await readRequestJson(request)
        const requested = isRegion(body.region) ? body.region : undefined
        const login = await beginWebLogin({
          fetchFn,
          ...(requested === undefined ? {} : { region: requested }),
        })
        latestLogin = login
        return sendJson(response, 200, { ok: true, value: login, login })
      }

      if (path === 'login/poll') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        const body = await readRequestJson(request)
        const loginId = typeof body.loginId === 'string' ? body.loginId : ''
        if (loginId === '') {
          return sendJson(response, 400, { ok: false, error: 'loginId is required.' })
        }
        // A sign-in started from this card is a new account, so it joins the pool
        // as its own row. Without this the pool would keep serving the accounts it
        // already had and the new session would exist only as the mirror file —
        // which is exactly the "multi-account sign-in is not wired" gap.
        const accountPool = options.accountPool
        const outcome = await pollWebLogin(store, loginId, {
          fetchFn,
          ...(accountPool === undefined
            ? {}
            : { onSave: async (credentials: MinimaxCodeCredentials) => { await accountPool.addAccount(credentials) } }),
        })
        if (outcome.status !== 'pending') latestLogin = null
        // A completed sign-in is a new credential, and the usage snapshot is
        // cached against the OLD one: a remembered "this credential cannot read
        // usage" must not outlive the credential it was about.
        if (outcome.status === 'authenticated') clearCachedQuota()
        return sendJson(response, 200, {
          ok: true,
          status: outcome.status,
          ...(outcome.account === undefined ? {} : { account: outcome.account }),
          value: outcome,
        })
      }

      if (path === 'login/cancel') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        const body = await readRequestJson(request)
        const loginId = typeof body.loginId === 'string' ? body.loginId : ''
        if (loginId === '') {
          return sendJson(response, 400, { ok: false, error: 'loginId is required.' })
        }
        cancelWebLogin(loginId)
        if (latestLogin?.loginId === loginId) latestLogin = null
        return sendJson(response, 200, { ok: true, value: { ok: true } })
      }

      if (path === 'logout') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        // Sign-out is scoped to what this plugin owns. MiniMax Code's own
        // `auth.json` is the desktop app's session, not this plugin's: revoking
        // its refresh token would sign the user out of the application they are
        // running, and deleting the file would do the same. That is the
        // WorkBuddy precedent for a credential this plugin reads but does not
        // own (desktop accounts there are hidden, never deleted). So a sign-out
        // revokes and deletes only when the credential in force is the plugin's
        // own file; a native credential is reported as still in force instead of
        // being silently destroyed.
        const source = await store.activeSource().catch(() => 'file' as const)
        if (source === 'minimax-native') {
          latestLogin = null
          return sendJson(response, 200, {
            ok: true,
            value: {
              ok: false,
              native: true,
              error: 'This sign-in belongs to MiniMax Code itself; sign out in the MiniMax Code app to end it.',
            },
          })
        }
        // Revoke at the service first, so the session really ends there too; the
        // local delete is best effort and never blocks the sign-out.
        const credentials = await store.read().catch(() => null)
        if (credentials !== null) {
          await revokeToken(credentials.refreshToken, { fetchFn, region: credentials.region })
        }
        await store.delete()
        latestLogin = null
        return sendJson(response, 200, { ok: true, value: { ok: true, native: false } })
      }

      if (path === 'test') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        const probe = await testConnection(store, { fetchFn })
        // HTTP 200 either way: the verdict is the payload, not the status line, so a
        // failed probe is not mistaken for a broken route by the card.
        return sendJson(response, 200, {
          ok: probe.ok,
          ...(probe.model === undefined ? {} : { model: probe.model }),
          ...(probe.error === undefined ? {} : { error: probe.error }),
          latencyMs: probe.latencyMs,
          ...(probe.usage === undefined ? {} : { usage: probe.usage }),
          value: probe,
        })
      }

      return sendJson(response, 404, { ok: false, error: 'Route not found.' })
    } catch (error) {
      if (error instanceof MinimaxCodeUnauthorizedError) {
        return sendJson(response, 401, { ok: false, error: error.message })
      }
      if (error instanceof MinimaxCodeAccessDeniedError) {
        return sendJson(response, 403, { ok: false, error: error.message })
      }
      return sendJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const dispose = ctx.webServer.register({ kind: 'prefix', path: MINIMAX_CODE_ROUTE_PREFIX, handler })
  return () => {
    dispose()
  }
}

/** Test seam: forget which sign-in the status route reports. */
export function resetLatestLogin(): void {
  latestLogin = null
}

export { MINIMAX_CODE_PROVIDER_ID, getWebLogin, ensureAccessToken }
