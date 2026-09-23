import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { CodexChatGptAdapter, PROVIDER_ID } from './host/adapter.ts'
import { CodexAccountPool } from './host/codex-account-pool.ts'
import { createCodexFetchProvider } from './host/codex-fetch.ts'
import { createCodexImageTool } from './host/codex-images.ts'
import { createCodexSearchProvider } from './host/codex-search.ts'
import { OAuthService } from './host/oauth-service.ts'
import { ProxyManager } from './host/proxy-manager.ts'
import { registerPreferenceStore } from './host/preferences.ts'
import { ResponsesClient } from './host/responses-client.ts'
import { registerRoutes } from './host/routes.ts'
import { createPlatformTokenStore } from './host/platform-token-store.ts'
import { SearchProviderSwitcher } from './host/search-provider-switcher.ts'
import type { SubscriptionPreferencesDto } from './shared/contracts.ts'
import { UsageService } from './host/usage-service.ts'
import { AntigravityAdapter } from './host/antigravity/adapter.ts'
import { registerAntigravityRoutes } from './host/antigravity/routes.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  registerAntigravityPreferenceStore,
  credentialPath,
  modelSettingsPath,
} from './host/antigravity/token-store.ts'
import { AccountPoolStore } from './host/antigravity/account-pool.ts'
import { PROVIDER_ID as ANTIGRAVITY_PROVIDER_ID } from './host/antigravity/types.ts'
import { CommandCodeAdapter } from './host/command-code/adapter.ts'
import { CommandCodeAccountPool } from './host/command-code/account-pool.ts'
import { registerCommandCodeRoutes } from './host/command-code/routes.ts'
import {
  FileCredentialStore as CommandCodeCredentialStore,
  FileModelSettingsStore as CommandCodeModelSettingsStore,
  registerCommandCodePreferenceStore,
} from './host/command-code/token-store.ts'
import { PROVIDER_ID as COMMAND_CODE_PROVIDER_ID, PROVIDER_NAME as COMMAND_CODE_PROVIDER_NAME } from './host/command-code/types.ts'
import { KimiCodeAdapter } from './host/kimi-code/adapter.ts'
import { KimiCodeAccountPool } from './host/kimi-code/account-pool.ts'
import { registerKimiCodeRoutes } from './host/kimi-code/routes.ts'
import { createKimiVideoTool } from './host/kimi-code/video-tool.ts'
import { readVideoBytes } from './host/kimi-code/video-store.ts'
import type { VideoAttachmentRef } from './host/kimi-code/modalities.ts'
import {
  FileCredentialStore as KimiCodeCredentialStore,
  FileModelSettingsStore as KimiCodeModelSettingsStore,
  registerKimiCodePreferenceStore,
} from './host/kimi-code/token-store.ts'
import { PROVIDER_ID as KIMI_CODE_PROVIDER_ID, PROVIDER_NAME as KIMI_CODE_PROVIDER_NAME } from './host/kimi-code/types.ts'
import { WorkBuddyAdapter } from './host/workbuddy/adapter.ts'
import { WorkBuddyAccountPool } from './host/workbuddy/account-pool.ts'
import { registerWorkBuddyRoutes } from './host/workbuddy/routes.ts'
import {
  FileCredentialStore as WorkBuddyCredentialStore,
  FileModelSettingsStore as WorkBuddyModelSettingsStore,
  registerWorkBuddyPreferenceStore,
} from './host/workbuddy/token-store.ts'
import { PROVIDER_ID as WORKBUDDY_PROVIDER_ID, PROVIDER_NAME as WORKBUDDY_PROVIDER_NAME } from './host/workbuddy/types.ts'
import { ZhipuAdapter } from './host/zhipu/adapter.ts'
import { ZhipuAccountPool } from './host/zhipu/account-pool.ts'
import { registerZhipuRoutes } from './host/zhipu/routes.ts'
import {
  FileCredentialStore as ZhipuCredentialStore,
  FileModelSettingsStore as ZhipuModelSettingsStore,
  registerZhipuPreferenceStore,
} from './host/zhipu/token-store.ts'
import { PROVIDER_ID as ZHIPU_PROVIDER_ID, PROVIDER_NAME as ZHIPU_PROVIDER_NAME } from './host/zhipu/types.ts'
import { CHECKIN_TICK_MS, WorkBuddyCheckinService } from './host/workbuddy/checkin.ts'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_SUBAGENT_INHERIT_TOOLS,
  installSubagentModelAuthorization,
  normalizeDelegationToolNames,
  normalizeInheritToolNames,
  validateDelegationToolNames,
  type SessionsResolver,
} from './host/subagent-model-authorization.ts'
import { installBundledPresets } from './host/preset-sync.ts'
import { installDispatchPreset } from './host/agent-preset.ts'
import {
  auditChildRoutes,
  auditedRoutesOf,
  type AuditedSessions,
} from './host/subagent-route-audit.ts'
import type { SubagentRouteAuditDto } from './shared/contracts.ts'
import {
  createFileRelayProbeSink,
  installRelayProbe,
  relayProbeEnabled,
  relayProbeEnvFile,
  relayProbeLogPath,
  type RelayProbeContext,
} from './host/relay-probe.ts'

/** Optional deployment configuration for this plugin. */
export interface Config {
  /**
   * Whether to sync this package's bundled agent presets into the
   * harness-home preset root (`<dshHome>/.agent-presets`) at startup, making
   * them selectable for new sessions on any machine that installs the plugin.
   * Default `true`. Only the preset ids this package ships are ever written
   * or retired; presets the user authored are never touched.
   */
  syncAgentPresets?: boolean
  /**
   * Whether the Subagent model allowlist also governs the route a delegation
   * that selects no model would inherit from its parent. Default `true`; set
   * `false` to leave inherited routes to the built-in delegation tool.
   */
  subagentModelAuthorization?: boolean
  /** Delegation tool names the authorization guard recognizes (default `subagent`). */
  subagentModelTools?: string[]
  /**
   * Delegation tools that always run their child on the calling agent's route
   * and therefore expose no `provider`/`model` (default `['subagent_fork']`).
   * An allowlist-carrying Session then still denies the call when the inherited
   * route is not authorized, instead of silently running an unauthorized child.
   * Set `[]` to leave these tools on the built-in behavior.
   */
  subagentModelInheritTools?: string[]
  /**
   * `session` (default) enforces the allowlist a Session recorded, matching the
   * delegation tool's snapshot; `preference` also enforces the current Settings
   * card allowlist for Sessions that recorded none.
   */
  subagentModelScope?: 'session' | 'preference'
}

export const Config: z<Config> = z.object({
  syncAgentPresets: z.boolean().default(true),
  subagentModelAuthorization: z.boolean().default(true),
  subagentModelTools: z.array(z.string()).default([]),
  subagentModelInheritTools: z.array(z.string()).default(DEFAULT_SUBAGENT_INHERIT_TOOLS as unknown as string[]),
  subagentModelScope: z.union([z.const('session'), z.const('preference')]).default('session'),
})

export const inject = ['webServer', 'llm', 'attachments', 'tools', 'settings', 'loader']

export function apply(ctx: Context, pluginConfig: Config = {}): void {
  // Ship the bundled agent presets. Harness 0.1.7 registers presets from a
  // plugin row instead of reading the harness-home root, so the runtime
  // declaration is preferred and the home copy stays the mechanism for every
  // generation before it — or the fallback when the declaration is unavailable.
  if (pluginConfig.syncAgentPresets !== false) {
    ctx.effect(
      () => installBundledPresets(ctx, installDispatchPreset(ctx)),
      'dsh-chatgpt-subscription: agent preset sync',
    )
  }

  const store = createPlatformTokenStore()
  const preferences = registerPreferenceStore(ctx.settings)
  // The fallback document is read off the plugin-load path: the store reports
  // the shipped defaults until the file lands, and a read failure is harmless.
  void preferences.hydrate().catch(() => undefined)

  const antigravityStore = new FileCredentialStore()
  const antigravityAccountPool = new AccountPoolStore(undefined, undefined, antigravityStore)
  const antigravityModelSettings = new FileModelSettingsStore()
  const antigravityPreferences = registerAntigravityPreferenceStore(ctx.settings, antigravityModelSettings)

  const commandCodeStore = new CommandCodeCredentialStore()
  // One credential per Command Code key, with the pre-pool file projected as the
  // primary account so an existing install needs no migration.
  const commandCodeAccountPool = new CommandCodeAccountPool({ store: commandCodeStore })
  const commandCodeModelSettings = new CommandCodeModelSettingsStore()
  const commandCodePreferences = registerCommandCodePreferenceStore(ctx.settings, commandCodeModelSettings)

  const kimiCodeStore = new KimiCodeCredentialStore()
  // One credential per signed-in Kimi Code account, with the pre-pool file
  // projected as the primary account so an existing install needs no migration.
  const kimiCodeAccountPool = new KimiCodeAccountPool({ store: kimiCodeStore })
  const kimiCodeModelSettings = new KimiCodeModelSettingsStore()
  const kimiCodePreferences = registerKimiCodePreferenceStore(ctx.settings, kimiCodeModelSettings)

  const workBuddyStore = new WorkBuddyCredentialStore()
  const workBuddyModelSettings = new WorkBuddyModelSettingsStore()
  const workBuddyPreferences = registerWorkBuddyPreferenceStore(ctx.settings, workBuddyModelSettings)
  // WorkBuddy is the line that adopts accounts it does not own: the IDE's own
  // sign-ins join the pool beside the ones added here, so both take part in
  // rotation, 429 cooldowns and account-level auth failures like every other
  // line. The settings selection is read on each pick, because the card can
  // pin or hide an account while the adapter is serving requests.
  const workBuddyAccountPool = new WorkBuddyAccountPool({
    store: workBuddyStore,
    selection: () => {
      const current = workBuddyPreferences.status()
      return {
        selectedAccountId: current.selectedAccountId,
        hiddenAccountIds: current.hiddenAccountIds,
      }
    },
  })

  const zhipuStore = new ZhipuCredentialStore()
  const zhipuModelSettings = new ZhipuModelSettingsStore()
  const zhipuPreferences = registerZhipuPreferenceStore(ctx.settings, zhipuModelSettings)
  // The pool is the routing table and the single-credential store is its
  // mirrored primary, so a pre-pool key needs no migration. The card's pinned
  // account is read on each pick, because it can change while the adapter serves.
  const zhipuAccountPool = new ZhipuAccountPool({
    store: zhipuStore,
    preferAccountId: () => zhipuPreferences.status().selectedAccountId,
  })

  // The allowlist a Session recorded outranks the current settings document,
  // because the built-in delegation tool snapshot it when the Session started.
  const delegationToolNames = normalizeDelegationToolNames(pluginConfig.subagentModelTools)
  const delegationInheritNames = normalizeInheritToolNames(pluginConfig.subagentModelInheritTools)
  if (pluginConfig.subagentModelAuthorization !== false) {
    ctx.inject(['sessions'], scoped => {
      const sessions = scoped.get('sessions') as SessionsResolver | undefined
      if (sessions === undefined) return
      scoped.effect(() => {
        // A tools service without the guard extension keeps the built-in
        // delegation behavior instead of failing this plugin's load.
        if (typeof scoped.tools?.guard !== 'function') return () => undefined
        return installSubagentModelAuthorization(scoped, sessions, {
          toolNames: delegationToolNames,
          inheritToolNames: delegationInheritNames,
          scope: pluginConfig.subagentModelScope ?? 'session',
        })
      }, 'dsh-chatgpt-subscription: subagent model authorization')
    })
  }

  // One read-only diagnostic probe, inert unless the deployment enables it.
  // It answers "what did the parent side do with the child's completion
  // message" from durable session events plus the live Agent snapshot. See
  // src/host/relay-probe.ts; it writes metadata only, to one log file.
  const probeEnvFile = relayProbeEnvFile()
  if (relayProbeEnabled(process.env, { envFile: probeEnvFile })) {
    const probePath = relayProbeLogPath(process.env, { envFile: probeEnvFile })
    ctx.effect(() => {
      ctx.logger.info(`[dsh-chatgpt-subscription] relay probe writing to ${probePath}`)
      return installRelayProbe(ctx as unknown as RelayProbeContext, {
        sink: createFileRelayProbeSink({ path: probePath }),
        path: probePath,
      })
    }, 'dsh-chatgpt-subscription: relay probe')
  }

  ctx.effect(() => {
    const proxyManager = new ProxyManager({
      getPreferences: () => preferences.status(),
      logger: ctx.logger,
    })
    const proxyFetch = proxyManager.createFetch()
    const antigravityAdapter = new AntigravityAdapter(
      antigravityStore,
      antigravityModelSettings,
      antigravityPreferences,
      // The route declares image input, so DSH hands it durable image blocks
      // that only the attachment service can turn into wire bytes.
      { fetchFn: proxyFetch, attachments: ctx.attachments },
      antigravityAccountPool,
    )
    let antigravityRegistration: AdapterRegistrationHandle | undefined
    let antigravityConflict: string | null = null
    const claimAntigravityRoute = (): void => {
      if (antigravityRegistration !== undefined) return
      try {
        antigravityRegistration = ctx.llm.registerAdapter([ANTIGRAVITY_PROVIDER_ID], antigravityAdapter)
        if (antigravityConflict !== null) {
          ctx.logger.info(`[dsh-chatgpt-subscription] Antigravity route "${ANTIGRAVITY_PROVIDER_ID}" is now served by this plugin`)
        }
        antigravityConflict = null
      } catch (error) {
        antigravityConflict = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(
          `[dsh-chatgpt-subscription] provider route "${ANTIGRAVITY_PROVIDER_ID}" is already owned by another adapter; `
          + `Antigravity models keep being served by that one until its configuration is removed (${antigravityConflict})`,
        )
      }
    }
    claimAntigravityRoute()
    const antigravityRouteWatch = typeof ctx.on === 'function'
      ? ctx.on('llm/adapters-updated', () => {
          claimAntigravityRoute()
        })
      : undefined
    const disposeAntigravityRoutes = registerAntigravityRoutes(
      ctx,
      antigravityStore,
      antigravityModelSettings,
      antigravityPreferences,
      proxyFetch,
      antigravityAccountPool,
    )
    const disposeCommandCodeRoutes = registerCommandCodeRoutes(
      ctx,
      commandCodeStore,
      commandCodeModelSettings,
      commandCodePreferences,
      {
        fetchFn: proxyFetch,
        serving: () => commandCodeRegistration !== undefined,
        conflict: () => commandCodeConflict,
      },
      commandCodeAccountPool,
    )
    // The Command Code route is contended: another adapter family (the generic
    // pi-ai provider, configured with this same endpoint) may already own the id.
    // Registration is all-or-nothing and DSH rejects a duplicate route, so this
    // module takes the route when it is free, reports the conflict when it is
    // not, and claims it as soon as the owner releases it.
    const commandCodeAdapter = new CommandCodeAdapter(
      commandCodeStore,
      commandCodeModelSettings,
      commandCodePreferences,
      { fetchFn: proxyFetch, attachments: ctx.attachments },
      commandCodeAccountPool,
    )
    let commandCodeRegistration: AdapterRegistrationHandle | undefined
    let commandCodeConflict: string | null = null
    // The Kimi Code route is contended the same way: another adapter family
    // may already own the id, so it is claimed when free and reported when not.
    // The video reader this route needs: DSH's attachment service is image-only,
    // so videos are ingested by this plugin's own tool and stored locally. The
    // reader verifies each reference against the stored bytes before handing
    // them over, and both call sites share one object so behaviour cannot drift.
    const kimiVideos = {
      readVideo: async (ref: VideoAttachmentRef) => ({
        data: await readVideoBytes(ref),
        mediaType: ref.mediaType,
      }),
    }
    const kimiCodeAdapter = new KimiCodeAdapter(
      kimiCodeStore,
      kimiCodeModelSettings,
      kimiCodePreferences,
      { fetchFn: proxyFetch, attachments: ctx.attachments, videos: kimiVideos },
      kimiCodeAccountPool,
    )
    let kimiCodeRegistration: AdapterRegistrationHandle | undefined
    let kimiCodeConflict: string | null = null
    const claimKimiCodeRoute = (): void => {
      if (kimiCodeRegistration !== undefined) return
      try {
        kimiCodeRegistration = ctx.llm.registerAdapter([KIMI_CODE_PROVIDER_ID], kimiCodeAdapter)
        if (kimiCodeConflict !== null) {
          ctx.logger.info(`[dsh-chatgpt-subscription] ${KIMI_CODE_PROVIDER_NAME} route "${KIMI_CODE_PROVIDER_ID}" is now served by this plugin`)
        }
        kimiCodeConflict = null
      } catch (error) {
        kimiCodeConflict = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(
          `[dsh-chatgpt-subscription] provider route "${KIMI_CODE_PROVIDER_ID}" is already owned by another adapter; `
          + `${KIMI_CODE_PROVIDER_NAME} models keep being served by that one until its configuration is removed (${kimiCodeConflict})`,
        )
      }
    }
    claimKimiCodeRoute()
    const kimiCodeRouteWatch = typeof ctx.on === 'function'
      ? ctx.on('llm/adapters-updated', () => {
          claimKimiCodeRoute()
        })
      : undefined

    const claimCommandCodeRoute = (): void => {
      if (commandCodeRegistration !== undefined) return
      try {
        commandCodeRegistration = ctx.llm.registerAdapter([COMMAND_CODE_PROVIDER_ID], commandCodeAdapter)
        if (commandCodeConflict !== null) {
          ctx.logger.info(`[dsh-chatgpt-subscription] ${COMMAND_CODE_PROVIDER_NAME} route "${COMMAND_CODE_PROVIDER_ID}" is now served by this plugin`)
        }
        commandCodeConflict = null
      } catch (error) {
        commandCodeConflict = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(
          `[dsh-chatgpt-subscription] provider route "${COMMAND_CODE_PROVIDER_ID}" is already owned by another adapter; `
          + `${COMMAND_CODE_PROVIDER_NAME} models keep being served by that one until its configuration is removed (${commandCodeConflict})`,
        )
      }
    }
    claimCommandCodeRoute()
    // A composition without the event seam (or a reduced test context) still
    // serves the route; only the automatic claim on release is unavailable.
    const commandCodeRouteWatch = typeof ctx.on === 'function'
      ? ctx.on('llm/adapters-updated', () => {
          claimCommandCodeRoute()
        })
      : undefined

    const disposeKimiCodeRoutes = registerKimiCodeRoutes(
      ctx,
      kimiCodeStore,
      kimiCodeModelSettings,
      kimiCodePreferences,
      {
        fetchFn: proxyFetch,
        serving: () => kimiCodeRegistration !== undefined,
        conflict: () => kimiCodeConflict,
      },
      kimiCodeAccountPool,
    )

    // WorkBuddy is the CodeBuddy subscription: this plugin reads the desktop
    // client's own credential files, so the route is claimed like the others
    // (when free) and reported when another adapter family already owns the id.
    const workBuddyAdapter = new WorkBuddyAdapter(
      workBuddyStore,
      workBuddyModelSettings,
      workBuddyPreferences,
      { fetchFn: proxyFetch, attachments: ctx.attachments, accountPool: workBuddyAccountPool },
    )
    let workBuddyRegistration: AdapterRegistrationHandle | undefined
    let workBuddyConflict: string | null = null
    const claimWorkBuddyRoute = (): void => {
      if (workBuddyRegistration !== undefined) return
      try {
        workBuddyRegistration = ctx.llm.registerAdapter([WORKBUDDY_PROVIDER_ID], workBuddyAdapter)
        if (workBuddyConflict !== null) {
          ctx.logger.info(`[dsh-chatgpt-subscription] ${WORKBUDDY_PROVIDER_NAME} route "${WORKBUDDY_PROVIDER_ID}" is now served by this plugin`)
        }
        workBuddyConflict = null
      } catch (error) {
        workBuddyConflict = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(
          `[dsh-chatgpt-subscription] provider route "${WORKBUDDY_PROVIDER_ID}" is already owned by another adapter; `
          + `${WORKBUDDY_PROVIDER_NAME} models keep being served by that one until its configuration is removed (${workBuddyConflict})`,
        )
      }
    }
    claimWorkBuddyRoute()
    const workBuddyRouteWatch = typeof ctx.on === 'function'
      ? ctx.on('llm/adapters-updated', () => {
          claimWorkBuddyRoute()
        })
      : undefined

    // The daily check-in scheduler (CN billing activity). The host owns the
    // interval; a day the process never runs is a day nothing signs in.
    const workBuddyCheckin = new WorkBuddyCheckinService(workBuddyStore, {
      fetchFn: proxyFetch,
      settings: () => workBuddyPreferences.status().checkin,
      // The preference store may still be warming up on a harness without the
      // register seam; without this the startup pass reads shipped defaults and
      // signs in even though the user had switched check-in off.
      ready: () => workBuddyPreferences.ready(),
      logger: ctx.logger,
    })
    const checkinTick = (): void => {
      void workBuddyCheckin.tick().catch((error) => {
        ctx.logger.warn(`[dsh-chatgpt-subscription] WorkBuddy check-in tick failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    const checkinTimer = setInterval(checkinTick, CHECKIN_TICK_MS)
    // The startup pass is the daily run; the day state makes a same-day
    // restart free, and the interval covers a process that survives midnight.
    checkinTick()

    const disposeWorkBuddyRoutes = registerWorkBuddyRoutes(
      ctx,
      workBuddyStore,
      workBuddyModelSettings,
      workBuddyPreferences,
      {
        fetchFn: proxyFetch,
        serving: () => workBuddyRegistration !== undefined,
        conflict: () => workBuddyConflict,
        accountPool: workBuddyAccountPool,
        checkin: workBuddyCheckin,
      },
    )

    // The GLM Coding Plan route is contended the same way: another adapter
    // family (a user's own `zai`/`zhipu` OpenAI-compatible entry) may already
    // own the id, so it is claimed when free and reported when not.
    const zhipuAdapter = new ZhipuAdapter(
      zhipuStore,
      zhipuModelSettings,
      zhipuPreferences,
      { fetchFn: proxyFetch, attachments: ctx.attachments, accountPool: zhipuAccountPool },
    )
    let zhipuRegistration: AdapterRegistrationHandle | undefined
    let zhipuConflict: string | null = null
    const claimZhipuRoute = (): void => {
      if (zhipuRegistration !== undefined) return
      try {
        zhipuRegistration = ctx.llm.registerAdapter([ZHIPU_PROVIDER_ID], zhipuAdapter)
        if (zhipuConflict !== null) {
          ctx.logger.info(`[dsh-chatgpt-subscription] ${ZHIPU_PROVIDER_NAME} route "${ZHIPU_PROVIDER_ID}" is now served by this plugin`)
        }
        zhipuConflict = null
      } catch (error) {
        zhipuConflict = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(
          `[dsh-chatgpt-subscription] provider route "${ZHIPU_PROVIDER_ID}" is already owned by another adapter; `
          + `${ZHIPU_PROVIDER_NAME} models keep being served by that one until its configuration is removed (${zhipuConflict})`,
        )
      }
    }
    claimZhipuRoute()
    const zhipuRouteWatch = typeof ctx.on === 'function'
      ? ctx.on('llm/adapters-updated', () => {
          claimZhipuRoute()
        })
      : undefined

    const disposeZhipuRoutes = registerZhipuRoutes(
      ctx,
      zhipuStore,
      zhipuModelSettings,
      zhipuPreferences,
      {
        fetchFn: proxyFetch,
        serving: () => zhipuRegistration !== undefined,
        conflict: () => zhipuConflict,
        accountPool: zhipuAccountPool,
      },
    )

    // The IDE can sign in or out on its own; adopting whatever its directory
    // currently holds keeps the pool in step without a manual rescan.
    void workBuddyAccountPool.syncDesktopAccounts().catch(() => undefined)

    // The ChatGPT account pool. Its mirror store is the same platform store the
    // plugin used before the pool existed, so a pre-pool sign-in is projected as
    // the primary account and nothing has to be migrated up front.
    const codexAccountPool = new CodexAccountPool({ store })
    const oauth = new OAuthService(store, { fetchFn: proxyFetch, logger: ctx.logger, pool: codexAccountPool })
    const usage = new UsageService(oauth, { fetchFn: proxyFetch })
    // A pooled account whose last known Codex window is spent is skipped before
    // a request is spent on it, instead of rediscovering the same 429 each time.
    codexAccountPool.setQuotaBlockedUntil((account, now) => usage.blockedUntilFor(account.credentials, now))
    const responses = new ResponsesClient(oauth, ctx.attachments, {
      fetchFn: proxyFetch,
      accountPool: codexAccountPool,
      localRawImages: { baseUrl: localWebServerBaseUrl(ctx.webServer.host, ctx.webServer.port) },
      onGenerationFinished: () => usage.invalidate(),
      outputVerbosity: () => preferences.status().outputVerbosity,
      fastMode: () => preferences.status().fastMode,
      reasoningSummary: () => preferences.status().reasoningSummary,
    })
    const adapter = new CodexChatGptAdapter(responses, preferences)

    const searchSwitcher = new SearchProviderSwitcher(ctx.loader)
    // DSH's built-in fetch provider resolves and pins the addresses this machine's resolver
    // returns, and it proxies only when the process environment names a proxy — the OS proxy this
    // plugin reads is invisible to it. On a machine whose proxy tool answers DNS with its own
    // fake-ip range (Clash/Mihomo's 198.18.0.0/15, the usual companion of a system proxy) that
    // combination fails every `web_fetch` with WEB_BLOCKED_URL before the proxy is ever consulted.
    // While this plugin has a proxy to route through, its own provider serves the tool instead:
    // the proxy resolves the origin, exactly like a hop DSH routes through a proxy, and the
    // provider still refuses non-public addresses a URL states outright. With no proxy configured
    // the built-in provider keeps the tool, resolution pinning and all.
    const applyWebProviders = (current: SubscriptionPreferencesDto = preferences.status()): void => {
      const pluginFetch = proxyManager.resolveActiveProxyUrl() !== null
      void searchSwitcher.select(current.searchProvider, { pluginFetch }).catch(error => {
        ctx.logger.warn(`[dsh-chatgpt-subscription] Web provider selection could not be applied: ${error instanceof Error ? error.message : String(error)}`)
      })
    }

    // The guard above stops an unauthorized route before a child starts, but it
    // only sees a model-authored tool call. A fork inherits its route by design,
    // and ralph/workflow/any plugin can start a child with no delegation tool at
    // all, so those children are invisible to it. This reader reconstructs what
    // actually ran from durable session facts and reports it; it never blocks.
    const readRouteAudit = (sessionId: string): Promise<SubagentRouteAuditDto> => {
      const sessions = ctx.get('sessions') as unknown as AuditedSessions
      const target = sessions.get(sessionId)
      if (target === undefined) throw new Error(`Unknown session "${sessionId}".`)
      const allowed = auditedRoutesOf(target)
      return Promise.resolve({
        sessionId,
        allowedModels: (allowed ?? []).map(route => ({ provider: route.provider, model: route.model })),
        violations: auditChildRoutes(target, sessions, allowed).map(violation => ({
          childId: violation.finding.childId,
          parentId: violation.finding.parentId ?? null,
          provider: violation.finding.provider ?? null,
          label: violation.finding.label ?? null,
          routeProvider: violation.route.provider ?? null,
          routeModel: violation.route.model ?? null,
          sameAsParent: violation.sameAsParent,
        })),
      })
    }

    const disposeRoutes = registerRoutes(
      ctx, oauth, usage, preferences, proxyManager, searchSwitcher, readRouteAudit, codexAccountPool)
    const disposeAdapter = ctx.llm.registerAdapter([PROVIDER_ID], adapter)
    const disposeImageTool = ctx.tools.register(createCodexImageTool(oauth, ctx.attachments, { fetchFn: proxyFetch }))
    // The video ingress for the Kimi route. Registered here because the tool
    // needs the plugin context to resolve the calling session's route before it
    // agrees to attach anything.
    const disposeVideoTool = ctx.tools.register(createKimiVideoTool(ctx, { fetchFn: proxyFetch }))

    // Rebind providers when web reloads without resetting the saved default provider selection.
    ctx.inject(['web'], ctx => {
      ctx.web.registerSearchProvider(createCodexSearchProvider(oauth, { fetchFn: proxyFetch }))
      ctx.web.registerFetchProvider(createCodexFetchProvider({ fetchFn: proxyFetch }))
      applyWebProviders()
    })

    // Any preference can change the selection: the search picker chooses the search backend, and
    // the proxy settings decide whether this plugin's provider is the one that can reach the web.
    const disposePreferenceWatch = preferences.watch(next => applyWebProviders(next))

    // The launcher publishes readiness only after the full host tree has settled.
    // Reconcile then as well as on service injection; neither timers nor a user
    // preference toggle should be needed to repair a startup configuration race.
    const appReady = ctx.get('appReady') as { onReady(listener: () => void): () => void } | undefined
    const disposeReadyWatch = appReady?.onReady(() => applyWebProviders())

    // A proxy that only becomes known after startup — the tool that provides it wasn't running yet,
    // or the first detection failed — must re-select too, or the built-in provider keeps the tool
    // for the rest of the process and every fetch it cannot reach fails.
    const disposeProxyWatch = proxyManager.onSystemProxyDetected(() => {
      applyWebProviders()
    })

    return () => {
      searchSwitcher.dispose()
      disposeReadyWatch?.()
      disposeProxyWatch()
      disposePreferenceWatch()
      disposeImageTool()
      disposeVideoTool()
      disposeAdapter()
      disposeRoutes()
      disposeAntigravityRoutes()
      releaseHandle(antigravityRouteWatch)
      antigravityRegistration?.()
      antigravityRegistration = undefined
      disposeCommandCodeRoutes()
      releaseHandle(commandCodeRouteWatch)
      commandCodeRegistration?.()
      commandCodeRegistration = undefined
      disposeKimiCodeRoutes()
      releaseHandle(kimiCodeRouteWatch)
      kimiCodeRegistration?.()
      kimiCodeRegistration = undefined
      clearInterval(checkinTimer)
      disposeWorkBuddyRoutes()
      releaseHandle(workBuddyRouteWatch)
      workBuddyRegistration?.()
      workBuddyRegistration = undefined
      disposeZhipuRoutes()
      releaseHandle(zhipuRouteWatch)
      zhipuRegistration?.()
      zhipuRegistration = undefined
      oauth.dispose()
      proxyManager.dispose()
    }
  }, 'dsh-chatgpt-subscription: adapter, routes, and lifecycle')
}

export {
  RELAY_PROBE_ENV,
  RELAY_PROBE_FILE_ENV,
  RELAY_PROBE_FILE_NAME,
  RELAY_PROBE_MAX_BYTES,
  RELAY_SOURCE_KINDS,
  RelayProbe,
  createFileRelayProbeSink,
  installRelayProbe,
  relayProbeEnabled,
  relayProbeEnvFile,
  relayProbeEnvValue,
  relayProbeLogPath,
} from './host/relay-probe.ts'
export type {
  AgentsLookup,
  ProbeAgent,
  ProbeEvent,
  ProbeSession,
  RelayProbeContext,
  RelayProbeOptions,
  RelayProbeSink,
} from './host/relay-probe.ts'
export { ProxyManager, detectSystemProxy } from './host/proxy-manager.ts'
export {
  DEFAULT_SUBAGENT_INHERIT_TOOLS,
  SUBAGENT_MODEL_SELECTION_NAMESPACE,
  SUBAGENT_POLICY_EVENT,
  authorizedRoutesFor,
  createSubagentAuthorization,
  delegationDenialReason,
  delegationModeOf,
  inheritOverrideReason,
  inheritRouteDenialReason,
  inheritedRouteOf,
  installSubagentModelAuthorization,
  normalizeDelegationToolNames,
  normalizeInheritToolNames,
  parseAllowedRoutes,
  policyRoutesOf,
  subagentModelSelectionPreference,
  unauthorizedRouteReason,
  validateAuthorizationScope,
  validateDelegationToolNames,
  validateInheritToolNames,
} from './host/subagent-model-authorization.ts'
export {
  auditChildRoutes,
  auditedRoutesOf,
  childRoutesOf,
  effectiveRouteOf,
  readChildDescriptor,
  violationText,
} from './host/subagent-route-audit.ts'
export type {
  AuditedRoute,
  AuditedSession,
  AuditedSessions,
  ChildRouteFinding,
  RouteViolation,
} from './host/subagent-route-audit.ts'
export { OAuthService } from './host/oauth-service.ts'
export {
  CodexAccountPool,
  codexPoolPath,
  parseCodexPoolData,
  type CodexPoolAccount,
  type CodexTokenRefresher,
} from './host/codex-account-pool.ts'
export { AccountPoolCore, normalizeRotationStrategy } from './host/common/account-pool.ts'
export { dshHomeDir } from './host/common/home.ts'
export { CodexChatGptAdapter } from './host/adapter.ts'
export { createCodexImageTool } from './host/codex-images.ts'
export { createCodexSearchProvider } from './host/codex-search.ts'
export { createCodexFetchProvider } from './host/codex-fetch.ts'
export { SearchProviderSwitcher, type SearchProviderSwitcherStatus } from './host/search-provider-switcher.ts'
export { ResponsesClient, parseResponsesStream } from './host/responses-client.ts'
export { UsageService, mapCodexUsage, parseCodexUsage } from './host/usage-service.ts'
export { createPlatformTokenStore } from './host/platform-token-store.ts'
export { MacKeychainTokenStore } from './host/token-store-macos.ts'
export { LinuxFileTokenStore } from './host/token-store-linux.ts'
export { WindowsDpapiTokenStore } from './host/token-store-windows.ts'
export type { TokenStore, StoredOAuthCredentials } from './host/token-store.ts'

export { AntigravityAdapter } from './host/antigravity/adapter.ts'
export {
  CommandCodeAccountPool,
  commandCodePoolPath,
  commandCodeAccountKey,
  parseCommandCodePoolData,
  type CommandCodePoolAccount,
  type CommandCodeAccountSummaryDto,
} from './host/command-code/account-pool.ts'
export { CommandCodeAdapter } from './host/command-code/adapter.ts'
export {
  FileCredentialStore as CommandCodeCredentialStore,
  FileModelSettingsStore as CommandCodeModelSettingsStore,
  credentialPath as commandCodeCredentialPath,
  modelSettingsPath as commandCodeModelSettingsPath,
  registerCommandCodePreferenceStore,
} from './host/command-code/token-store.ts'
export {
  beginWebLogin as startCommandCodeLogin,
  getWebLoginStatus as getCommandCodeLoginStatus,
  saveApiKey as saveCommandCodeApiKey,
} from './host/command-code/oauth.ts'
export { getCommandCodeWebStatus, registerCommandCodeRoutes } from './host/command-code/routes.ts'
export {
  fetchAccountQuota as fetchCommandCodeQuota,
  clearCachedQuota as clearCommandCodeQuota,
  getCachedQuota as getCommandCodeQuota,
  loadProviderModels as loadCommandCodeModels,
} from './host/command-code/client.ts'
export { KimiCodeAdapter, classifyKimiFailure, KIMI_CODE_RETRY_POLICY_CONFIG } from './host/kimi-code/adapter.ts'
export {
  FileCredentialStore as KimiCodeCredentialStore,
  FileModelSettingsStore as KimiCodeModelSettingsStore,
  credentialPath as kimiCodeCredentialPath,
  modelSettingsPath as kimiCodeModelSettingsPath,
  registerKimiCodePreferenceStore,
  resolveRegion as resolveKimiCodeRegion,
} from './host/kimi-code/token-store.ts'
export {
  beginWebLogin as beginKimiCodeLogin,
  ensureAccessToken as ensureKimiCodeAccessToken,
  getWebLoginStatus as getKimiCodeLoginStatus,
  refreshAccessToken as refreshKimiCodeToken,
  requestDeviceAuthorization as requestKimiCodeDeviceAuthorization,
} from './host/kimi-code/oauth.ts'
export {
  fetchAccountQuota as fetchKimiCodeQuota,
  fetchUserInfo as fetchKimiCodeUserInfo,
  loadProviderModels as loadKimiCodeModels,
  clearCachedQuota as clearKimiCodeQuota,
  getCachedQuota as getKimiCodeQuota,
} from './host/kimi-code/client.ts'
export { getKimiCodeWebStatus, registerKimiCodeRoutes } from './host/kimi-code/routes.ts'
export { WorkBuddyAdapter, classifyFailure as classifyWorkBuddyFailure } from './host/workbuddy/adapter.ts'
export {
  FileCredentialStore as WorkBuddyCredentialStore,
  FileModelSettingsStore as WorkBuddyModelSettingsStore,
  codeBuddyAuthDir,
  modelSettingsPath as workBuddyModelSettingsPath,
  parseCredentialFile as parseWorkBuddyCredential,
  registerWorkBuddyPreferenceStore,
  scanCredentials as scanWorkBuddyCredentials,
} from './host/workbuddy/token-store.ts'
export {
  fetchAccountQuota as fetchWorkBuddyQuota,
  clearCachedQuota as clearWorkBuddyQuota,
  getCachedQuota as getWorkBuddyQuota,
  clearCachedCatalog as clearWorkBuddyCatalog,
  loadConfigCatalog as loadWorkBuddyModels,
  parseConfigModels as parseWorkBuddyConfigModels,
  refreshCredentials as refreshWorkBuddyCredentials,
  parseBilling as parseWorkBuddyBilling,
} from './host/workbuddy/client.ts'
export { getWorkBuddyWebStatus, registerWorkBuddyRoutes } from './host/workbuddy/routes.ts'
export { WorkBuddyCheckinService } from './host/workbuddy/checkin.ts'
export {
  FALLBACK_MODELS as WORKBUDDY_MODELS,
  WORKBUDDY_MODEL_IDS,
  resolveWorkBuddyModel,
  modelsForRegion as workBuddyModelsForRegion,
} from './host/workbuddy/model-catalog.ts'
export { ZhipuAdapter, classifyFailure as classifyZhipuFailure, resolveDefaultReasoningEffort as resolveZhipuDefaultEffort } from './host/zhipu/adapter.ts'
export {
  ZhipuAccountPool,
  zhipuPoolPath,
  parseZhipuPoolData,
  type ZhipuPoolAccount,
} from './host/zhipu/account-pool.ts'
export {
  FileCredentialStore as ZhipuCredentialStore,
  FileModelSettingsStore as ZhipuModelSettingsStore,
  credentialPath as zhipuCredentialPath,
  modelSettingsPath as zhipuModelSettingsPath,
  parseZhipuCredentials,
  registerZhipuPreferenceStore,
  zhipuAccountKey,
  zhipuKeyHint,
  type ZhipuCredentials,
  type ZhipuModelSettings,
  type ZhipuPreferenceStore,
} from './host/zhipu/token-store.ts'
export {
  accountFromCredentials as zhipuAccountFromCredentials,
  clearCachedCatalog as clearZhipuCatalog,
  clearCachedQuota as clearZhipuQuota,
  fetchAccountQuota as fetchZhipuQuota,
  getCachedQuota as getZhipuQuota,
  loadCatalog as loadZhipuCatalog,
  parseCatalogModels as parseZhipuCatalogModels,
  parsePlan as parseZhipuPlan,
  parseQuotaLimits as parseZhipuQuotaLimits,
  quotaMeters as zhipuQuotaMeters,
  quotaWindows as zhipuQuotaWindows,
  verifyApiKey as verifyZhipuApiKey,
  windowLabel as zhipuWindowLabel,
  windowMinutesOf as zhipuWindowMinutes,
} from './host/zhipu/client.ts'
export {
  getZhipuWebStatus,
  registerZhipuRoutes,
  resolveEnabledModelIds as resolveZhipuEnabledModelIds,
  buildModelOptions as buildZhipuModelOptions,
  getWebLoginStatus as getZhipuWebLoginStatus,
} from './host/zhipu/routes.ts'
export {
  beginWebLogin as beginZhipuWebLogin,
  buildAuthorizeUrl as buildZhipuAuthorizeUrl,
  defaultOAuthEndpoints as zhipuOAuthEndpoints,
  exchangeAuthorizationCode as exchangeZhipuAuthorizationCode,
  extractAuthorizationCode as extractZhipuAuthorizationCode,
  getWebLoginStatus as getZhipuLoginStatus,
  mintApiKey as mintZhipuApiKey,
  resetWebLogin as resetZhipuWebLogin,
  submitLoginCode as submitZhipuLoginCode,
  type ZaiAuthorization,
  type ZaiOAuthEndpoints,
} from './host/zhipu/oauth.ts'
export {
  FALLBACK_MODELS as ZHIPU_MODELS,
  ZHIPU_MODELS as ZHIPU_MODEL_TABLE,
  DEFAULT_VISIBLE_MODEL_IDS as ZHIPU_DEFAULT_VISIBLE_MODELS,
  defaultContextWindowFor as zhipuDefaultContextWindow,
  maxOutputTokensFor as zhipuMaxOutputTokens,
  modelsForRegion as zhipuModelsForRegion,
  resolveZhipuModel,
  zhipuModelSupportsImage,
  zhipuReasoningEfforts,
  type ZhipuModelEntry,
} from './host/zhipu/model-catalog.ts'
export {
  CHAT_PATH as ZHIPU_CHAT_PATH,
  MODELS_PATH as ZHIPU_MODELS_PATH,
  PROVIDER_ID as ZHIPU_PROVIDER_ID,
  PROVIDER_NAME as ZHIPU_PROVIDER_NAME,
  QUOTA_PATH as ZHIPU_QUOTA_PATH,
  REGION_BASE_URLS as ZHIPU_REGION_BASE_URLS,
  SUBSCRIPTION_PATH as ZHIPU_SUBSCRIPTION_PATH,
  ZAI_OAUTH as ZHIPU_ZAI_OAUTH,
  ZAI_OAUTH_CALLBACK_PATH as ZHIPU_ZAI_OAUTH_CALLBACK_PATH,
  ZAI_OAUTH_CALLBACK_PORT as ZHIPU_ZAI_OAUTH_CALLBACK_PORT,
  apiBaseForRegion as zhipuApiBaseForRegion,
  normalizeRegion as normalizeZhipuRegion,
  regionForBaseUrl as zhipuRegionForBaseUrl,
} from './host/zhipu/types.ts'
export {
  KimiCodeAccountPool,
  kimiCodePoolPath,
  parseKimiCodePoolData,
  type KimiCodePoolAccount,
} from './host/kimi-code/account-pool.ts'
export {
  KIMI_CODE_MODELS,
  kimiCodeModelDef,
} from './host/kimi-code/model-catalog.ts'
export {
  FileCredentialStore,
  FileModelSettingsStore,
  credentialPath,
  modelSettingsPath,
} from './host/antigravity/token-store.ts'
export { AccountPoolStore } from './host/antigravity/account-pool.ts'
export { loginAndSave, beginWebLogin, refreshAntigravityToken } from './host/antigravity/oauth.ts'
export { clearCachedQuota, fetchAccountQuota, getCachedQuota } from './host/antigravity/client.ts'

/** Cordis event handles are either a disposer function or a disposable object. */
function releaseHandle(handle: unknown): void {
  if (typeof handle === 'function') {
    (handle as () => void)()
    return
  }
  const disposable = handle as { dispose?: () => void } | null | undefined
  disposable?.dispose?.()
}

function localWebServerBaseUrl(host: '127.0.0.1' | '0.0.0.0', port: number): string {
  return `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`
}