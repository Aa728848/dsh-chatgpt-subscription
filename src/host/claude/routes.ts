/**
 * The '/claude/api' surface: the settings card for the Claude subscription line.
 *
 * The route set, the '{ok,value}' / '{ok,error}' envelope, the 64 KiB body cap,
 * the 405/404/500 conventions and the same-origin requirement on every mutation
 * are all mirrors of the sibling lines' route modules ('src/host/kimi-code/routes.ts',
 * 'src/host/command-code/routes.ts', 'src/host/workbuddy/routes.ts') — deliberately,
 * because the card that renders this line is the same card whose shape those lines
 * established, and a further dialect would be another bug surface for no gain.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS
 * ---------------------------------------------------------------------------
 *
 * It is the whole settings surface for the line and nothing more: the sign-in
 * flow (loopback and the manual paste), adoption of a local Claude Code sign-in,
 * the quota reads, the model catalog and selection, the account pool, and the
 * status payload the card renders. No route is gated on an acknowledgement, a
 * feature flag or any other prior state of the card: each one works from the
 * credentials and the preferences it is handed, and refuses only what it cannot
 * do (not signed in, unsupported action, oversized body, cross-origin caller).
 *
 * Two properties here are structural rather than conventional, and both are load
 * bearing:
 *
 * - 'GET ""' and 'GET "status"' are the card's single source of truth. They
 *   report the account, the catalog, the quota, and whether this plugin owns the
 *   provider route ({@link ClaudeStatusOptions.serving} /
 *   {@link ClaudeStatusOptions.conflict}), so an id already held by another
 *   adapter family shows up as a banner on the card instead of as a model list
 *   that is mysteriously empty.
 * - 'adopt' is the ONLY route that reads the local Claude Code credential file.
 *   The status route asks {@link ClaudeStatusOptions.adoptPaths} whether such a
 *   file EXISTS and never opens it, which is what keeps a status poll from
 *   turning into a scan of the user's disk (see 'adopt.ts' Rule 2).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES NOT DECIDE
 * ---------------------------------------------------------------------------
 *
 * Whether the adapter is REGISTERED is the plugin entry's call, not this
 * module's: the entry claims the provider route and reports the outcome back
 * through {@link ClaudeStatusOptions.serving} and
 * {@link ClaudeStatusOptions.conflict}, which is what the card's route banner
 * renders. The route surface itself is registered unconditionally, because the
 * card needs it in every state — including the state where another adapter
 * family owns the provider id and the only thing to show is that fact.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isSameOriginMutation } from '../common/same-origin.ts'
import { QuotaRefresh } from '../common/quota-refresh.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  type ClaudeCredentials,
  type ClaudeModelSettings,
  type ClaudePreferenceStore,
  type ClaudeSettingsPatch,
} from './token-store.ts'
import {
  DEFAULT_VISIBLE_MODEL_IDS,
  FALLBACK_MODELS,
  claudeModelCanDisableThinking,
  claudeModelSupportsImage,
  claudeModelSupportsTemperature,
  claudeReasoningEfforts,
  claudeThinkingMode,
  defaultContextWindowFor,
  maxOutputTokensFor,
  resolveClaudeModel,
  type ClaudeModelEntry,
} from './model-catalog.ts'
import {
  clearCachedCatalog,
  clearCachedQuota,
  fetchAccountQuota,
  getCachedQuota,
  loadCatalog,
  probeConnection,
} from './client.ts'
import {
  beginLogin,
  cancelLogin,
  getLoginStatus,
  resolveLoginInput,
  submitLoginInput,
  type BeginLoginOptions,
  type ClaudeTokenStore,
  type LoginFlowStatus,
} from './oauth.ts'
import {
  CLAUDE_CODE_CREDENTIAL_SOURCE,
  claudeCodeCredentialPaths,
  claudeCodeCredentialPresence,
  readClaudeCodeCredentials,
} from './adopt.ts'
import {
  DEFAULT_CONTEXT_WINDOW,
  PROVIDER_ID,
  PROVIDER_NAME,
  QUOTA_CACHE_TTL_MS,
} from './types.ts'
import type {
  ClaudeAccountPool,
  ClaudeAccountSummaryDto as PoolClaudeAccountSummaryDto,
  ClaudePoolCredentials,
} from './account-pool.ts'
import type { ContextWindowOverridePatch } from '../common/context-window-overrides.ts'
import {
  CLAUDE_REASONING_EFFORTS,
  isClaudeReasoningEffort,
  type ClaudeAccount,
  type ClaudeAccountQuota,
  type ClaudeConnectionDto,
  type ClaudeLoginFlowDto,
  type ClaudeMeter,
  type ClaudeModelOption,
  type ClaudeQuotaWindow,
  type ClaudeThinkingMode,
  type ClaudeWebStatus,
  /** The shared declaration, imported under its own name so it can be re-exported below. */
  type ClaudeAccountSummaryDto,
} from '../../shared/claude-contracts.ts'

/** Ceiling on one request body. Identical to every sibling line's. */
const MAX_BODY_BYTES = 64 * 1024

/** Prefix this line's routes are registered under. */
export const ROUTE_PREFIX = '/claude/api'

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

function sendMethodNotAllowed(response: ServerResponse): void {
  sendJson(response, 405, { ok: false, error: 'Method Not Allowed' })
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

// ---------------------------------------------------------------------------
// Model options
// ---------------------------------------------------------------------------

/**
 * The selection the card should show.
 *
 * A stored list that still equals the shipped default has never been edited, so
 * it cannot know about models the live listing has since added; treating it as
 * "everything this account can call" keeps a first run from hiding models behind
 * an unedited default. Any explicit edit is honoured exactly. The rule is the
 * same one every sibling line states, and it is stated locally because the
 * helper is not shared.
 */
export function resolveEnabledModelIds(
  stored: readonly string[],
  available: readonly string[],
  enabled = true,
): string[] {
  if (!enabled) return []
  const shippedDefaults = new Set(DEFAULT_VISIBLE_MODEL_IDS)
  const isUntouchedDefault = stored.length > 0
    && stored.length === shippedDefaults.size
    && stored.every((id) => shippedDefaults.has(id))
  if (isUntouchedDefault) return [...available]
  const known = new Set(available)
  return stored.filter((id) => known.has(id))
}

/** Build the model options the settings card renders, in catalog order. */
export function buildClaudeModelOptions(
  catalog: readonly ClaudeModelEntry[],
  available: readonly string[],
  enabledModelIds: readonly string[],
  overrides: Record<string, number>,
): ClaudeModelOption[] {
  const enabled = new Set(enabledModelIds)
  return available.map((id) => {
    const entry = resolveClaudeModel(id, catalog)
    const defaultWindow = defaultContextWindowFor(id, catalog)
    const override = overrides[id]
    return {
      id,
      name: entry.name,
      enabled: enabled.has(id),
      defaultContextWindow: defaultWindow,
      contextWindow: typeof override === 'number' && Number.isFinite(override) && override > 0
        ? override
        : defaultWindow,
      defaultMaxTokens: maxOutputTokensFor(id, catalog),
      reasoningEfforts: [...claudeReasoningEfforts(id, catalog)],
      canDisableThinking: claudeModelCanDisableThinking(id, catalog),
      thinkingMode: claudeThinkingMode(id, catalog),
      supportsImage: claudeModelSupportsImage(id, catalog),
      supportsTemperature: claudeModelSupportsTemperature(id, catalog),
    }
  })
}

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

function quotaWindowDto(window: {
  id: string
  label: string
  windowMinutes: number | null
  usedFraction: number | null
  usedPercent: number | null
  remainingPercent: number | null
  resetsAt: string | null
  source: 'usage' | 'headers'
}): ClaudeQuotaWindow {
  return {
    id: window.id,
    label: window.label,
    windowMinutes: window.windowMinutes,
    usedFraction: window.usedFraction,
    usedPercent: window.usedPercent,
    remainingPercent: window.remainingPercent,
    resetsAt: window.resetsAt,
    source: window.source,
  }
}

/**
 * The overage pool, as one meter.
 *
 * The descriptor's own unit is the account's currency in its minor unit, and the
 * card renders it with the percentage beside it — so the two numbers travel
 * together rather than being merged into one, which would lose which of them the
 * payload actually stated.
 */
function extraUsageMeter(extra: ClaudeQuotaSnapshot['extraUsage']): ClaudeMeter | null {
  if (extra === null) return null
  return {
    id: 'extra_usage',
    label: 'Extra usage',
    usedPercent: extra.utilization,
    remainingPercent: extra.utilization === null ? null : 100 - extra.utilization,
    limit: extra.monthlyLimit,
    used: extra.usedCredits,
    enabled: extra.isEnabled,
  }
}

/**
 * The cached snapshot's own shape, taken from the function that produces it.
 *
 * Indexed off 'getCachedQuota' rather than imported by name on purpose:
 * 'client.ts' exports a `ClaudeAccountQuota` that is NOT the shared DTO of the
 * same name — it is the internal snapshot, whose `extraUsage` carries the
 * payload's own field spelling. Importing it under the shared name would shadow
 * the DTO and quietly type this module against the wrong one, which is exactly
 * the failure the two aliases below exist to prevent.
 */
type ClaudeQuotaSnapshot = NonNullable<ReturnType<typeof getCachedQuota>>

/**
 * One cached quota snapshot, as the card renders it.
 *
 * Extracted rather than inlined so the null case is handled in exactly one
 * place: 'client.ts' distinguishes "no snapshot" from "a snapshot with no
 * windows", and flattening the two here would render an account that has never
 * been read identically to one whose payload carried nothing.
 */
function quotaDto(quota: ClaudeQuotaSnapshot | null): ClaudeAccountQuota | null {
  if (quota === null) return null
  return {
    windows: quota.windows.map(quotaWindowDto),
    extraUsage: extraUsageMeter(quota.extraUsage),
    fetchedAt: quota.fetchedAt,
    observedAt: quota.observedAt,
    status: quota.status,
    representativeClaim: quota.representativeClaim,
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface ClaudeStatusOptions {
  fetchFn?: typeof fetch
  /** Whether this plugin currently owns the provider route; re-read on every status. */
  serving?: boolean | (() => boolean)
  /** Diagnostic when another plugin owns the provider route; re-read on every status. */
  conflict?: string | null | (() => string | null)
  /** Multi-account pool this line schedules through; absent keeps the single-account card. */
  accountPool?: ClaudeAccountPool
  /**
   * Test seam for the model listing.
   *
   * Defaults to 'client.ts''s loader against the resolved credential; injected so
   * a test drives the card without a network round trip.
   */
  loadCatalog?: (credentials: ClaudeCredentials) => Promise<readonly ClaudeModelEntry[]>
  /** Test seam for adoption: the paths the reader consults. */
  adoptPaths?: readonly string[]
  /**
   * Test seam for the sign-in flow.
   *
   * Mirrors 'oauth.ts''s own BeginLoginOptions so a test never opens a browser
   * and never binds a loopback port. The route always overrides fetchFn with the
   * one it was registered with, so the flow and the rest of the surface share a
   * single fetch.
   */
  login?: Omit<BeginLoginOptions, 'fetchFn'>
}

function readOption<T>(value: T | (() => T) | undefined, fallback: T): T {
  return typeof value === 'function' ? (value as () => T)() : value ?? fallback
}

/** The account the card would display: electron from the credential alone. */
function accountDto(credentials: ClaudeCredentials | undefined): ClaudeAccount | null {
  if (credentials === undefined) return null
  const account = credentials.account
  // The wire's own spelling wins, but a blank 'email_address' must fall through
  // to 'emailAddress' rather than swallow it — '??' alone would not.
  const raw = account?.email_address ?? account?.emailAddress
  const email = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null
  const subscriptionType = credentials.subscriptionType ?? null
  if (email === null && subscriptionType === null) return null
  return { email, subscriptionType }
}

/**
 * Everything the settings card renders: the account, the catalog, the quota.
 *
 * Exported so a caller (and a test) can render the same payload the route
 * returns without going through the HTTP surface.
 */
export async function getClaudeWebStatus(
  store: FileCredentialStore,
  modelSettings: FileModelSettingsStore,
  preferences: ClaudePreferenceStore | undefined,
  options: ClaudeStatusOptions = {},
  quotaError: string | null = null,
  /** Credential and id the route already resolved for this request. */
  active: { id: string | undefined; credentials: ClaudeCredentials | undefined } = { id: undefined, credentials: undefined },
): Promise<ClaudeWebStatus> {
  const settings: ClaudeModelSettings = preferences ? preferences.status() : await modelSettings.read()
  const enabled = settings.enabled !== false
  const credential = active.credentials
  const fetchFn = options.fetchFn ?? fetch

  // The live listing is the authority on each model's window; without a
  // credential (or when it is unreachable) the shipped table stands in, and the
  // card still renders a usable list before the first sign-in.
  const live = credential === undefined
    ? []
    : await (options.loadCatalog ?? ((current: ClaudeCredentials) => loadCatalog(current, { fetchFn })))(credential)
      .catch(() => [])
  const catalog = live.length > 0 ? live : FALLBACK_MODELS
  const available = catalog.map((model) => model.id)
  const enabledModelIds = resolveEnabledModelIds(settings.enabledModelIds, available, enabled)
  const models = buildClaudeModelOptions(catalog, available, enabledModelIds, settings.contextWindowOverrides)

  // Only a snapshot belonging to the displayed account may be rendered; the
  // cache is keyed on the token tail precisely so this question has an answer.
  const quota = credential === undefined ? getCachedQuota() : getCachedQuota(credential)

  const poolData = options.accountPool === undefined
    ? null
    : await options.accountPool.read().catch(() => null)
  const poolAccounts = options.accountPool === undefined
    ? []
    : await options.accountPool.listAccounts().catch(() => [])

  // A stat, never a read: this is offered before the user has opted in, so it
  // must not touch the credential file's contents. See 'adopt.ts' Rule 2.
  const presence = await claudeCodeCredentialPresence(options.adoptPaths ?? claudeCodeCredentialPaths())
    .catch(() => ({ present: false, path: null, searched: [] as string[] }))

  const document = credential === undefined ? (await store.read().catch(() => null)) : null
  const displayed = credential ?? document?.accounts[0]?.credentials
  const storagePath = options.accountPool === undefined ? store.path() : options.accountPool.path()

  return {
    enabled,
    authenticated: displayed !== undefined,
    hasCredentials: displayed !== undefined,
    storagePath,
    serving: readOption(options.serving, true),
    conflict: readOption(options.conflict, null),
    claudeCodeSignInAvailable: presence.present,
    claudeCodePaths: presence.searched,
    account: accountDto(displayed),
    quota: quotaDto(quota),
    lastFetchedAt: quota?.fetchedAt ?? null,
    quotaError,
    models,
    contextWindowOverrides: settings.contextWindowOverrides,
    defaultReasoningEffort: settings.defaultReasoningEffort as ClaudeWebStatus['defaultReasoningEffort'],
    selectedAccountId: settings.selectedAccountId,
    accounts: poolAccounts.map((summary): PoolClaudeAccountSummaryDto => summary),
    rotationStrategy: poolData?.rotationStrategy ?? 'sequential',
    ...(poolData?.activeAccountId === undefined ? {} : { activeAccountId: poolData.activeAccountId }),
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register the Claude subscription settings routes under '/claude/api'.
 *
 * Returns the disposer. Registration is UNCONDITIONAL: the card's status poll is
 * how the user learns whether this plugin owns the provider route, so the
 * surface has to answer even when another adapter family holds the id.
 */
export function registerClaudeRoutes(
  ctx: Context,
  store: FileCredentialStore,
  modelSettings: FileModelSettingsStore,
  preferences?: ClaudePreferenceStore,
  options: ClaudeStatusOptions = {},
): () => void {
  const fetchFn = options.fetchFn ?? fetch
  const pool = options.accountPool

  // One per registration: a background refresh belongs to the line this route
  // serves, and the flag it reports must not leak between instances.
  const quotaRefresh = new QuotaRefresh()

  /**
   * Signal every quota read on this registration shares.
   *
   * One controller per registration and never aborted mid-flight: it exists so
   * the reads are addressable as a group, and an AbortSignal is one-shot, so a
   * controller left in the aborted state would make every later refresh fail
   * instantly — a bug that would look exactly like "Anthropic is down".
   */
  const quotaAbort = new AbortController()

  const settings = async (): Promise<ClaudeModelSettings> =>
    preferences ? preferences.status() : await modelSettings.read()

  const patchSettings = async (patch: ClaudeSettingsPatch): Promise<ClaudeModelSettings> =>
    preferences ? preferences.update(patch) : await modelSettings.updateSettings(patch)

  /**
   * The account that would serve the next request.
   *
   * Quota, catalog and connection probes all belong to ONE credential, and with
   * a pool that is the active account rather than whatever the single-credential
   * file happens to hold first.
   */
  const activeAccount = async (): Promise<{ id: string | undefined; credentials: ClaudeCredentials | undefined }> => {
    const current = await settings()
    if (pool === undefined) {
      const document = await store.read().catch(() => null)
      if (document === null || document.accounts.length === 0) return { id: undefined, credentials: undefined }
      const pinned = current.selectedAccountId
      const chosen = (pinned === null ? undefined : document.accounts.find((a) => a.internalId === pinned))
        ?? document.accounts[0]
      return { id: chosen?.internalId, credentials: chosen?.credentials }
    }
    const data = await pool.read().catch(() => null)
    if (data === null || data.accounts.length === 0) return { id: undefined, credentials: undefined }
    const chosen = (data.activeAccountId === undefined
      ? undefined
      : data.accounts.find((account) => account.id === data.activeAccountId))
      ?? data.accounts.find((account) => account.isPrimary)
      ?? data.accounts[0]
    return { id: chosen?.id, credentials: chosen?.credentials }
  }

  /**
   * The store the sign-in flow writes through.
   *
   * With a pool the write goes through the pool, because the pool is the routing
   * table: a credential written only into the document would be visible to the
   * card and invisible to the request path. With a target account id the write
   * is addressed at THAT account, which is what makes a re-login repair the row
   * the user clicked instead of adding a second one.
   */
  const loginStore = (accountId?: string): ClaudeTokenStore => {
    const base: ClaudeTokenStore = pool !== undefined && accountId !== undefined
      ? pool.credentialStoreFor(accountId)
      : {
          read: async () => (await activeAccount()).credentials ?? null,
          write: async (credentials) => {
            if (pool !== undefined) await pool.addAccount(credentials)
            else await store.saveAccount(credentials)
          },
        }
    return {
      read: () => base.read(),
      write: async (credentials) => {
        await base.write(credentials)
        // A re-login is the remedy for a rejected credential, so the marker that
        // took the account out of rotation goes only AFTER the new credential
        // has landed. Clearing it first would put an account with a dead token
        // back into rotation for the length of a browser sign-in.
        if (pool !== undefined && accountId !== undefined) {
          await pool.clearAuthFailed(accountId).catch(() => undefined)
        }
        clearCachedQuota()
        clearCachedCatalog()
      },
    }
  }

  const readStatus = (quotaError: string | null = null): Promise<ClaudeWebStatus> =>
    activeAccount().then((active) => getClaudeWebStatus(store, modelSettings, preferences, options, quotaError, active))

  return ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url || '/', 'http://dsh.local')
      const path = url.pathname.replace(/^\/claude\/api\/?/, '')
      const method = request.method ?? 'GET'

      try {
        if (path === '' || path === 'status') {
          if (method !== 'GET') return sendMethodNotAllowed(response)
          const active = await activeAccount()
          const cached = active.credentials === undefined ? null : getCachedQuota(active.credentials)
          const stale = cached === null || Date.now() - (cached.fetchedAt || 0) > QUOTA_CACHE_TTL_MS
          // A failure is reported alongside the status rather than failing the
          // whole read, so the card can show why the meters are missing. A
          // snapshot of the same account that has merely aged answers now and
          // refreshes behind it; a missing one is fetched first, because the card
          // has nothing correct to render without it.
          if (active.credentials !== undefined && stale) {
            const credentials = active.credentials
            const refresh = (): Promise<unknown> =>
              fetchAccountQuota(credentials, { fetchFn, signal: quotaAbort.signal })
            if (cached === null) await quotaRefresh.run(refresh)
            else quotaRefresh.start(refresh)
          }
          const value = await readStatus(quotaRefresh.lastError())
          return sendJson(response, 200, {
            ok: true,
            value: { ...value, quotaRefreshing: quotaRefresh.refreshing },
          })
        }

        if (path === 'login') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const body = await readRequestJson(request).catch(() => ({} as Record<string, unknown>))
          const target = typeof body.accountId === 'string' && body.accountId !== '' ? body.accountId : undefined
          // beginLogin returns IMMEDIATELY: the card polls 'login/status' while
          // the user is in the browser, so this request must not stay open.
          const value: LoginFlowStatus = await beginLogin(loginStore(target), {
            ...(options.login ?? {}),
            fetchFn,
          })
          return sendJson(response, 200, { ok: true, value: value as ClaudeLoginFlowDto })
        }

        if (path === 'login/status') {
          if (method !== 'GET') return sendMethodNotAllowed(response)
          return sendJson(response, 200, { ok: true, value: getLoginStatus() as ClaudeLoginFlowDto })
        }

        if (path === 'login/cancel') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          cancelLogin()
          return sendJson(response, 200, { ok: true, value: getLoginStatus() as ClaudeLoginFlowDto })
        }

        if (path === 'login/input') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const body = await readRequestJson(request)
          const text = typeof body.input === 'string' ? body.input : typeof body.code === 'string' ? body.code : ''
          // 'resolveLoginInput' is consulted first so a value the parser rejects
          // is answered by the parser's own message rather than by a generic one;
          // 'submitLoginInput' re-runs it internally, which is deliberate — the
          // parse is pure and running it twice cannot disagree with itself.
          const parsed = resolveLoginInput(text)
          if (!parsed.ok) return sendJson(response, 400, { ok: false, error: parsed.error })
          const outcome = await submitLoginInput(text, { fetchFn })
          if (!outcome.ok) {
            return sendJson(response, outcome.httpStatus, { ok: false, error: outcome.error })
          }
          clearCachedQuota()
          clearCachedCatalog()
          const value = await readStatus()
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'connection/test') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const active = await activeAccount()
          if (active.credentials === undefined) return sendJson(response, 400, { ok: false, error: 'Not signed in.' })
          // The probe RETURNS its verdict rather than throwing, so a refusal is
          // rendered by the card instead of being flattened into a 500.
          const probe = await probeConnection(active.credentials, { fetchFn })
          const value: ClaudeConnectionDto = probe.ok
            ? {
                connected: true,
                model: probe.model,
                latencyMs: probe.latencyMs,
                status: probe.status,
                error: null,
                retryable: false,
                stopReason: probe.stopReason,
                checkedAt: Date.now(),
              }
            : {
                connected: false,
                model: probe.model,
                latencyMs: probe.latencyMs,
                status: probe.status,
                error: probe.failure.message,
                retryable: probe.failure.retryable,
                stopReason: null,
                checkedAt: Date.now(),
              }
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'quota') {
          if (method !== 'GET' && method !== 'POST') return sendMethodNotAllowed(response)
          if (method === 'POST' && !isSameOriginMutation(request)) {
            return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          }
          const active = await activeAccount()
          if (active.credentials === undefined) return sendJson(response, 400, { ok: false, error: 'Not signed in to Claude.' })
          const credentials = active.credentials
          let quotaError: string | null = null
          try {
            await fetchAccountQuota(credentials, {
              fetchFn,
              force: method === 'POST',
              signal: quotaAbort.signal,
            })
          } catch (error) {
            // Reported as a field rather than as a failed request: the card's
            // job here is to explain why the meters are missing, and a 500 would
            // throw away the account row it can still render.
            quotaError = error instanceof Error ? error.message : String(error)
          }
          const value = await readStatus(quotaError)
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'catalog/refresh') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          clearCachedCatalog()
          const active = await activeAccount()
          if (active.credentials !== undefined) {
            const credentials = active.credentials
            const load = options.loadCatalog ?? ((current: ClaudeCredentials) => loadCatalog(current, { fetchFn, force: true }))
            await load(credentials).catch(() => undefined)
          }
          const value = await readStatus()
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'models' || path === 'settings') {
          if (method === 'GET') {
            const value = await readStatus()
            return sendJson(response, 200, { ok: true, value })
          }
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          const body = await readRequestJson(request)
          const patch: ClaudeSettingsPatch = {}
          if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
          if (Array.isArray(body.enabledModelIds)) {
            patch.enabledModelIds = body.enabledModelIds.filter((id): id is string => typeof id === 'string')
          }
          if (typeof body.contextWindowOverrides === 'object' && body.contextWindowOverrides !== null) {
            const overrides: ContextWindowOverridePatch = {}
            for (const [key, raw] of Object.entries(body.contextWindowOverrides as Record<string, unknown>)) {
              // \`null\` is the card's "restore the catalog default". It has to
              // survive normalization, because it is the value the store reads as
              // "delete this key" — a guard that dropped it would turn a restore
              // into a no-op that looks like a save.
              if (raw === null) overrides[key] = null
              else if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) overrides[key] = Math.floor(raw)
            }
            patch.contextWindowOverrides = overrides
          }
          if (body.defaultReasoningEffort !== undefined) {
            const effort = body.defaultReasoningEffort
            // \`null\` clears the choice and lets the catalog default apply; a
            // named level must be one this route can actually send.
            if (effort === null || isClaudeReasoningEffort(effort)) patch.defaultReasoningEffort = effort
          }
          if (body.selectedAccountId !== undefined) {
            const selected = body.selectedAccountId
            if (selected !== null && typeof selected !== 'string') {
              return sendJson(response, 400, { ok: false, error: 'The selected account id is invalid.' })
            }
            patch.selectedAccountId = selected
            clearCachedQuota()
            clearCachedCatalog()
          }
          await patchSettings(patch)
          if (patch.enabledModelIds !== undefined || patch.enabled !== undefined || patch.selectedAccountId !== undefined) {
            ctx.emit?.('llm/adapters-updated')
          }
          const value = await readStatus()
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'accounts') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          if (pool === undefined) return sendJson(response, 400, { ok: false, error: 'Account pool is not installed.' })
          const body = await readRequestJson(request)
          const action = typeof body.action === 'string' ? body.action : ''
          const accountId = typeof body.accountId === 'string' ? body.accountId : ''

          if (action === 'relogin') {
            if (accountId === '') return sendJson(response, 400, { ok: false, error: 'An account id is required.' })
            const target = (await pool.listAccounts().catch(() => [])).find((account) => account.id === accountId)
            if (target === undefined) return sendJson(response, 404, { ok: false, error: 'The account was not found.' })
            // A new sign-in lands in THIS account: the flow writes through the
            // pool's own credential-store adapter for it, and the auth-failure
            // marker is cleared only once the credential has arrived.
            const value: LoginFlowStatus = await beginLogin(loginStore(accountId), {
              ...(options.login ?? {}),
              fetchFn,
            })
            return sendJson(response, 200, { ok: true, value: value as ClaudeLoginFlowDto })
          }

          if (accountId === '' && action !== 'strategy') {
            return sendJson(response, 400, { ok: false, error: 'An account id is required.' })
          }
          if (action === 'set-primary') {
            await pool.setPrimary(accountId)
            // The pool decides routing; the card's own pin has to name the same
            // account, or the catalog and quota routes would read a credential
            // the pool is not scheduling.
            await patchSettings({ selectedAccountId: accountId })
          } else if (action === 'set-alias') {
            const alias = typeof body.alias === 'string' ? body.alias.trim() : ''
            if (alias === '') return sendJson(response, 400, { ok: false, error: 'An alias is required.' })
            await pool.setAlias(accountId, alias)
          } else if (action === 'delete') {
            await pool.deleteAccount(accountId)
          } else if (action === 'clear-cooldown') {
            await pool.clearCooldown(accountId)
          } else if (action === 'clear-auth-failed') {
            await pool.clearAuthFailed(accountId)
          } else if (action === 'strategy') {
            const strategy = body.strategy
            if (strategy !== 'sequential' && strategy !== 'round-robin' && strategy !== 'sticky') {
              return sendJson(response, 400, { ok: false, error: 'Unsupported rotation strategy.' })
            }
            await pool.setStrategy(strategy)
          } else {
            return sendJson(response, 400, { ok: false, error: 'Unsupported account action.' })
          }
          clearCachedQuota()
          clearCachedCatalog()
          const value = await readStatus()
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'logout') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          cancelLogin()
          if (pool === undefined) {
            await store.delete()
          } else {
            // Without an explicit account, the one that would serve the next
            // request goes and the pool promotes another; that is what the card's
            // single sign-out button means once a pool exists.
            const body = await readRequestJson(request).catch(() => ({} as Record<string, unknown>))
            const data = await pool.read().catch(() => null)
            const target = typeof body.accountId === 'string' && body.accountId !== ''
              ? body.accountId
              : (data?.activeAccountId
                ?? data?.accounts.find((account) => account.isPrimary)?.id
                ?? data?.accounts[0]?.id)
            if (target === undefined) await store.delete()
            else await pool.deleteAccount(target)
          }
          clearCachedQuota()
          clearCachedCatalog()
          const value = await readStatus()
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'adopt') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          // This route is the ONLY one that opens the local Claude Code
          // credential file; the status route asks whether one exists and never
          // reads it. Keep it that way — see 'adopt.ts' Rule 2.
          if (pool === undefined) {
            // Refused rather than written into the credential document, and the
            // reason is a real limitation rather than caution: the document's
            // parser is strict and requires the 'user:inference' scope, which an
            // adopted snapshot may not state — and, more importantly, a record
            // written there has no adopted marker, so the line would treat a
            // borrowed credential as its own and REFRESH it. That refresh is the
            // cross-process race the whole adoption design exists to avoid.
            return sendJson(response, 400, {
              ok: false,
              error: 'Importing a local Claude Code sign-in needs the account pool, which is not installed.',
            })
          }
          const adopted = await readClaudeCodeCredentials(options.adoptPaths ?? claudeCodeCredentialPaths())
          if (adopted === undefined) {
            return sendJson(response, 400, {
              ok: false,
              error: 'No usable local Claude Code sign-in was found (unrecognised local sign-in format).',
            })
          }
          const pooled: ClaudePoolCredentials = {
            ...adopted.credentials,
            adopted: true,
            source: CLAUDE_CODE_CREDENTIAL_SOURCE,
            sourcePath: adopted.sourcePath,
          }
          await pool.addAccount(pooled)
          clearCachedQuota()
          clearCachedCatalog()
          const value = await readStatus()
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'adopt/disable') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          if (pool === undefined) return sendJson(response, 400, { ok: false, error: 'Account pool is not installed.' })
          const body = await readRequestJson(request).catch(() => ({} as Record<string, unknown>))
          const requested = typeof body.accountId === 'string' && body.accountId !== '' ? body.accountId : undefined
          const data = await pool.read().catch(() => null)
          const imported = (data?.accounts ?? []).filter((account) => account.adopted === true)
          if (requested !== undefined) {
            const target = imported.find((account) => account.id === requested)
            if (target === undefined) {
              return sendJson(response, 400, {
                ok: false,
                error: 'That account is not a sign-in imported from Claude Code.',
              })
            }
            await pool.removeImportedAccount(requested)
          } else {
            // No id means "remove the import", which is the card's single
            // remove-import button. Every imported row goes; nothing this plugin
            // signed in is touched, because only adopted rows are selected.
            for (const account of imported) await pool.removeImportedAccount(account.id)
          }
          // Claude Code's own file is NOT touched — not deleted, not rewritten,
          // not moved. This route only forgets the snapshot this plugin copied.
          clearCachedQuota()
          clearCachedCatalog()
          const value = await readStatus()
          return sendJson(response, 200, { ok: true, value })
        }

        return sendJson(response, 404, { ok: false, error: 'not-found' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return sendJson(response, 500, { ok: false, error: message })
      }
    },
  })
}

// ---------------------------------------------------------------------------
// Compile-time equivalence with the frozen host modules
// ---------------------------------------------------------------------------
//
// 'src/shared/claude-contracts.ts' cannot import anything under 'src/host/' — it
// is compiled by the CLIENT project, which has no Node types and does not list
// 'src/host/**' in its include — so the two declarations it restates cannot be
// re-exported. These assertions are what closes that gap instead: each one is a
// line of TypeScript that stops compiling if the two sides diverge, which is the
// same protection a re-export would have given, minus the direction the build
// makes impossible.
//
// They live HERE because this module is the only place that reads both sides.

/** Mutual assignability, as a type-level boolean. Divergence is 'never'. */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

/** The pool module's own summary DTO, under an alias that keeps the import honest. */
type PoolSummaryDto = PoolClaudeAccountSummaryDto

// Both directions, so a field added to either side fails here. This is the exact
// check the task's "RE-EXPORT it from your contracts module rather than declaring
// a second copy" was protecting against — and it is enforced rather than
// asserted in prose.
const _summaryDtoMatchesPool =
  true satisfies MutuallyAssignable<ClaudeAccountSummaryDto, PoolSummaryDto>

// The catalog's own thinking vocabulary. Unlike the reasoning ladder below, this
// one survives the frozen table's 'as readonly ClaudeModelEntry[]' annotation,
// because 'thinkingMode' is an explicit literal union rather than 'string[]'.
const _thinkingModeMatchesCatalog =
  true satisfies MutuallyAssignable<ClaudeThinkingMode, ClaudeModelEntry['thinkingMode']>

/**
 * The reasoning ladder, CHECKED AT RUNTIME on import.
 *
 * It cannot be checked at the type level, and the reason is worth stating so a
 * later reader does not "fix" it wrongly: the frozen catalog widens
 * 'reasoningEfforts' to 'readonly string[]' through its own annotation, so the
 * literal levels are gone by the time anything can index them — and the shared
 * module cannot reach the catalog at all. So the check runs here, where the
 * catalog IS readable, and it throws rather than warns.
 *
 * Throwing is the deliberate choice. The alternative is a card that silently
 * offers a level the wire will reject, or omits one it would accept, and both
 * are worse than a Host that refuses to start: this constant is a build-time
 * constant, so a mismatch means the package was assembled wrongly.
 */
function assertReasoningEffortsMatchCatalog(catalog: readonly ClaudeModelEntry[]): void {
  const present = new Set<string>()
  for (const model of catalog) for (const effort of model.reasoningEfforts) present.add(effort)
  const declared = new Set<string>(CLAUDE_REASONING_EFFORTS)
  const missing = [...present].filter((effort) => !declared.has(effort)).sort()
  const extra = [...declared].filter((effort) => !present.has(effort)).sort()
  if (missing.length === 0 && extra.length === 0) return
  throw new Error(
    'CLAUDE_REASONING_EFFORTS in src/shared/claude-contracts.ts has drifted from the model catalog'
    + (missing.length === 0 ? '' : ': the catalog uses ' + missing.join(', '))
    + (extra.length === 0 ? '' : ': the constant claims ' + extra.join(', '))
    + '. Update the constant so the settings card offers exactly the levels the wire accepts.',
  )
}

/** The same check, exposed so the test suite can assert it without importing order games. */
export function claudeReasoningEffortDrift(): { missing: string[]; extra: string[] } {
  const present = new Set<string>()
  for (const model of FALLBACK_MODELS) for (const effort of model.reasoningEfforts) present.add(effort)
  const declared = new Set<string>(CLAUDE_REASONING_EFFORTS)
  return {
    missing: [...present].filter((effort) => !declared.has(effort)).sort(),
    extra: [...declared].filter((effort) => !present.has(effort)).sort(),
  }
}

assertReasoningEffortsMatchCatalog(FALLBACK_MODELS)

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export {
  DEFAULT_CONTEXT_WINDOW,
  PROVIDER_ID,
  PROVIDER_NAME,
  getCachedQuota,
  clearCachedQuota,
  clearCachedCatalog,
  claudeCodeCredentialPaths,
  claudeCodeCredentialPresence,
  type ClaudeAccountSummaryDto,
}
