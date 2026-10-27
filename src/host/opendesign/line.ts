/**
 * The OpenDesign line, assembled in one place.
 *
 * `src/index.ts` calls {@link createOpenDesignLine} beside the other lines and
 * appends the returned claim, route disposer, hub source and exports. Everything
 * this line owns — stores, pool, adapter, routes — is constructed here, so the
 * integration touches no sibling line's behaviour.
 *
 * @module dsh-chatgpt-subscription/opendesign-line
 */
import os from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { claimProviderRoute, type ProviderRouteClaim } from '../common/provider-route.ts'
import { catalogTotal } from '../common/catalog-snapshot.ts'
import { isModelServed } from './catalog.ts'
import type { AttachmentImageReader } from '../common/request-images.ts'
import { OpenDesignAccountPool } from './account-pool.ts'
import { OpenDesignAdapter } from './adapter.ts'
import { OpenDesignLoginManager } from './oauth.ts'
import { getOpenDesignWebStatus, registerOpenDesignRoutes, OPENDESIGN_ROUTES } from './routes.ts'
import { OpenDesignModelSettingsStore, type OpenDesignModelSettings } from './token-store.ts'
import { DEFAULT_MODELS, PROVIDER_ID, PROVIDER_NAME } from './types.ts'
import type { HubSummarySource } from '../hub-overview.ts'

export interface OpenDesignLineOptions {
  /** Proxy-aware fetch that routes and catalog syncs use. */
  fetchFn: typeof fetch
  /** Controlled/diagnostic fetch that live adapter chat streams use; defaults to fetchFn. */
  modelFetchFn?: typeof fetch
  /** Durable attachment service, for image input. */
  attachments?: Pick<AttachmentStore, 'readImage' | 'readImageRequest'>
}

export interface OpenDesignLine {
  adapter: OpenDesignAdapter
  modelSettings: OpenDesignModelSettingsStore
  accountPool: OpenDesignAccountPool
  login: OpenDesignLoginManager
  claim: ProviderRouteClaim
  disposeRoutes: () => void
  /** Owner overview card source, read from local snapshots only. */
  hubSource: HubSummarySource
  /** Release every registration this line made. */
  dispose(): void
}

/** Every id the line knows: the shipped table plus the synced live catalog. */
export function openDesignKnownModelIds(settings: OpenDesignModelSettings): string[] {
  const ids = new Set<string>(DEFAULT_MODELS)
  for (const model of settings.catalogModels) ids.add(model.id)
  return [...ids]
}

/**
 * Every id the line advertises right now — THE one visibility rule.
 *
 * The adapter (what the picker is offered), the status route (what each checklist
 * row reports as checked) and the hub card (how many models the line advertises)
 * all read this function and nothing else. Three private copies is how the hub
 * card ended up counting models the picker refused to show, which is exactly the
 * contradiction this rule exists to make impossible.
 *
 * Three layers, applied in this order:
 *
 * 1. the user's hidden list;
 * 2. the user's tick list — unset means every known model, an explicit `[]` means
 *    everything off (the tick list and the shipped table speak the same wire ids,
 *    so a cold-start intersection cannot empty the picker);
 * 3. the PLAN, once somebody measured it: an id the last successful scan did not
 *    list is not served, and only a forced reveal (`forceVisibleModels`) keeps it.
 *    Before that first scan `servedModelIds` is `null` and this layer hides
 *    nothing — an unmeasured plan is not a denial.
 */
export function openDesignVisibleModelIds(settings: OpenDesignModelSettings): string[] {
  const hidden = new Set(settings.hiddenModels)
  const enabled = settings.enabledModelIds === null ? null : new Set(settings.enabledModelIds)
  const forced = new Set(settings.forceVisibleModels)
  return openDesignKnownModelIds(settings).filter((id) => (
    !hidden.has(id)
    && (enabled === null || enabled.has(id))
    && (isModelServed(id, settings.servedModelIds) || forced.has(id))
  ))
}

/**
 * Build the line.
 * @param ctx - host plugin context (owns `llm` and `webServer`).
 * @param options - the proxy-aware fetch and the attachment reader.
 */
export function createOpenDesignLine(ctx: Context, options: OpenDesignLineOptions): OpenDesignLine {
  const modelSettings = new OpenDesignModelSettingsStore()
  const accountPool = new OpenDesignAccountPool()

  const adapter = new OpenDesignAdapter(modelSettings, {
    fetchFn: options.modelFetchFn ?? options.fetchFn,
    ...(options.attachments === undefined ? {} : { attachments: options.attachments as AttachmentImageReader }),
    accountPool,
  })

  const claim = claimProviderRoute(ctx, {
    providerId: PROVIDER_ID,
    label: PROVIDER_NAME,
    adapter,
  })

  // Device-authorization sign-in. The card drives polling through the route;
  // this object owns the pending authorization and completes the account add.
  const login = new OpenDesignLoginManager({
    fetchFn: options.fetchFn,
    host: () => {
      try {
        return os.hostname() || 'unknown-host'
      } catch {
        return 'unknown-host'
      }
    },
    onLogin: async (credentials) => {
      await accountPool.addAccount(
        credentials,
        credentials.user?.name ?? credentials.user?.email,
      )
    },
    logger: ctx.logger,
  })

  // Registered unconditionally: the card is how a user adds their first key, so
  // gating it on winning the route would leave a contested id unconfigurable.
  const disposeRoutes = registerOpenDesignRoutes(ctx, {
    settings: modelSettings,
    accountPool,
    fetchFn: options.fetchFn,
    login,
    serving: () => claim.serving(),
    conflict: () => claim.conflict(),
  })

  const hubSource: HubSummarySource = {
    id: 'opendesign',
    providerId: PROVIDER_ID,
    canToggle: true,
    read: async () => {
      const settings = await modelSettings.read().catch(() => modelSettings.status())
      const accounts = await accountPool.listAccounts().catch(() => [])
      const known = openDesignKnownModelIds(settings)
      const visible = openDesignVisibleModelIds(settings)
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
    modelSettings,
    accountPool,
    login,
    claim,
    disposeRoutes,
    hubSource,
    dispose: () => {
      login.dispose()
      disposeRoutes()
      claim.dispose()
    },
  }
}

export { OPENDESIGN_ROUTES }
