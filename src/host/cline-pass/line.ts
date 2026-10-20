/**
 * The Cline Pass line, assembled in one place.
 *
 * `src/index.ts` calls {@link createClinePassLine} beside the other lines and
 * appends the returned claim, route disposer, hub source and exports. Everything
 * this line owns — stores, pool, engine, adapter, routes, optional tools — is
 * constructed here, so the integration touches no sibling line's behaviour.
 *
 * @module dsh-chatgpt-subscription/cline-pass-line
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { claimProviderRoute, type ProviderRouteClaim } from '../common/provider-route.ts'
import { catalogTotal } from '../common/catalog-snapshot.ts'
import type { AttachmentImageReader } from '../common/request-images.ts'
import { ClinePassAccountPool } from './account-pool.ts'
import { ClinePassAdapter } from './adapter.ts'
import { ClinePassEngine } from './engine.ts'
import { ClinePassLoginManager } from './oauth.ts'
import { getClinePassWebStatus, registerClinePassRoutes, CLINE_PASS_ROUTES } from './routes.ts'
import { createClinePassStore, type ClinePassStore } from './store.ts'
import { ClinePassModelSettingsStore, type ClinePassModelSettings } from './token-store.ts'
import { registerClinePassTools } from './tools.ts'
import { DEFAULT_MODELS, PROVIDER_ID, PROVIDER_NAME, defaultPin } from './types.ts'
import type { HubSummarySource } from '../hub-overview.ts'

export interface ClinePassLineOptions {
  /** Proxy-aware, diagnostic fetch the route and every upstream call use. */
  fetchFn: typeof fetch
  /** Durable attachment service, for image input. */
  attachments?: Pick<AttachmentStore, 'readImage' | 'readImageRequest'>
  /** Test seam: skip tools even when the stored settings ask for them. */
  disableTools?: boolean
}

export interface ClinePassLine {
  adapter: ClinePassAdapter
  engine: ClinePassEngine
  store: ClinePassStore
  modelSettings: ClinePassModelSettingsStore
  accountPool: ClinePassAccountPool
  claim: ProviderRouteClaim
  disposeRoutes: () => void
  /** Owner overview card source, read from local snapshots only. */
  hubSource: HubSummarySource
  /** Release every registration this line made. */
  dispose(): void
}

/** Every id the line knows, before the visibility selection is applied. */
export function clinePassKnownModelIds(settings: ClinePassModelSettings, catalogIds: readonly string[]): string[] {
  const ids = new Set<string>(DEFAULT_MODELS)
  for (const model of settings.catalogModels) ids.add(model.id)
  if (settings.exposeCatalog) for (const id of catalogIds) ids.add(id)
  return [...ids]
}

/** Every id the line advertises right now. */
export function clinePassVisibleModelIds(settings: ClinePassModelSettings, catalogIds: readonly string[]): string[] {
  const hidden = new Set(settings.hiddenModels)
  const enabled = settings.enabledModelIds === null ? null : new Set(settings.enabledModelIds)
  return clinePassKnownModelIds(settings, catalogIds).filter((id) => !hidden.has(id) && (enabled === null || enabled.has(id)))
}

/**
 * Build the line.
 * @param ctx - host plugin context (owns `llm`, `webServer` and `tools`).
 * @param options - the proxy-aware fetch and the attachment reader.
 */
export function createClinePassLine(ctx: Context, options: ClinePassLineOptions): ClinePassLine {
  const modelSettings = new ClinePassModelSettingsStore()
  const accountPool = new ClinePassAccountPool({
    baseURL: () => modelSettings.status().baseURL,
  })
  const store = createClinePassStore()

  const engine = new ClinePassEngine({
    fetchFn: options.fetchFn,
    accountPool,
    store,
    pinFor: (model) => ({
      ...(modelSettings.status().pins[model] ?? defaultPin()),
      spelling: modelSettings.status().pinSpelling,
    }),
    baseURL: () => modelSettings.status().baseURL,
    logger: ctx.logger,
  })

  const adapter = new ClinePassAdapter(
    engine,
    store,
    modelSettings,
    accountPool,
    {
      ...(options.attachments === undefined ? {} : { attachments: options.attachments as AttachmentImageReader }),
    },
  )

  // Device-code sign-in. The card drives polling through the route; this object
  // owns the pending WorkOS device code and completes the account add.
  const login = new ClinePassLoginManager({
    fetchFn: options.fetchFn,
    baseURL: () => modelSettings.status().baseURL,
    onLogin: async (credentials) => {
      await accountPool.addAccount(credentials, credentials.email ?? credentials.name)
    },
    logger: ctx.logger,
  })

  const claim = claimProviderRoute(ctx, {
    providerId: PROVIDER_ID,
    label: PROVIDER_NAME,
    adapter,
  })

  // Registered unconditionally: the card is how a user adds their first key, so
  // gating it on winning the route would leave a contested id unconfigurable.
  const disposeRoutes = registerClinePassRoutes(ctx, {
    settings: modelSettings,
    accountPool,
    store,
    engine,
    fetchFn: options.fetchFn,
    login,
    serving: () => claim.serving(),
    conflict: () => claim.conflict(),
  })

  // The line's own history budget and tool switch are read at activation, like
  // the original plugin: a registered tool cannot be pulled back out of a
  // conversation's tool list, so the switch takes effect on the next start.
  const startupSettings = modelSettings.readSync()
  store.setHistoryLimit(startupSettings.historyLimit)
  let disposeTools: Array<() => void> = []
  if (options.disableTools !== true && startupSettings.exposeTools) {
    try {
      disposeTools = registerClinePassTools(ctx, {
        settings: modelSettings,
        accountPool,
        store,
        engine,
        status: async () => await getClinePassWebStatus({
          settings: modelSettings,
          accountPool,
          store,
          engine,
          fetchFn: options.fetchFn,
          login,
          serving: () => claim.serving(),
          conflict: () => claim.conflict(),
        }),
        serving: () => claim.serving(),
      })
    } catch (error) {
      ctx.logger?.warn(`[cline-pass] management tools were not registered: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const hubSource: HubSummarySource = {
    id: 'cline-pass',
    providerId: PROVIDER_ID,
    canToggle: true,
    read: async () => {
      const settings = await modelSettings.read().catch(() => modelSettings.status())
      const accounts = await accountPool.listAccounts().catch(() => [])
      const known = clinePassKnownModelIds(settings, store.catalog().ids)
      const visible = clinePassVisibleModelIds(settings, store.catalog().ids)
      return {
        enabled: settings.enabled,
        accountCount: accounts.length,
        authenticated: accounts.some((account) => (
          (account.authStatus === undefined || account.authStatus === 'ok')
          && (account.cooldownUntil === undefined || account.cooldownUntil <= Date.now())
        )),
        enabledModelCount: visible.length,
        totalModelCount: catalogTotal(known.length),
      }
    },
  }

  return {
    adapter,
    engine,
    store,
    modelSettings,
    accountPool,
    claim,
    disposeRoutes,
    hubSource,
    dispose: () => {
      for (const dispose of disposeTools.splice(0)) dispose()
      login.dispose()
      disposeRoutes()
      claim.dispose()
    },
  }
}

export { CLINE_PASS_ROUTES }
