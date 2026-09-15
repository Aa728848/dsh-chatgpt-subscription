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
import { PROVIDER_ID as ANTIGRAVITY_PROVIDER_ID } from './host/antigravity/types.ts'
import { CommandCodeAdapter } from './host/command-code/adapter.ts'
import { registerCommandCodeRoutes } from './host/command-code/routes.ts'
import {
  FileCredentialStore as CommandCodeCredentialStore,
  FileModelSettingsStore as CommandCodeModelSettingsStore,
  registerCommandCodePreferenceStore,
} from './host/command-code/token-store.ts'
import { PROVIDER_ID as COMMAND_CODE_PROVIDER_ID, PROVIDER_NAME as COMMAND_CODE_PROVIDER_NAME } from './host/command-code/types.ts'
import { KimiCodeAdapter } from './host/kimi-code/adapter.ts'
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
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import {
  installSubagentModelAuthorization,
  normalizeDelegationToolNames,
  validateDelegationToolNames,
  type SessionsResolver,
} from './host/subagent-model-authorization.ts'
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
   * Whether the Subagent model allowlist also governs the route a delegation
   * that selects no model would inherit from its parent. Default `true`; set
   * `false` to leave inherited routes to the built-in delegation tool.
   */
  subagentModelAuthorization?: boolean
  /** Delegation tool names the authorization guard recognizes (default `subagent`). */
  subagentModelTools?: string[]
  /**
   * `session` (default) enforces the allowlist a Session recorded, matching the
   * delegation tool's snapshot; `preference` also enforces the current Settings
   * card allowlist for Sessions that recorded none.
   */
  subagentModelScope?: 'session' | 'preference'
}

export const Config: z<Config> = z.object({
  subagentModelAuthorization: z.boolean().default(true),
  subagentModelTools: z.array(z.string()).default([]),
  subagentModelScope: z.union([z.const('session'), z.const('preference')]).default('session'),
})

export const inject = ['webServer', 'llm', 'attachments', 'tools', 'settings', 'loader']

export function apply(ctx: Context, pluginConfig: Config = {}): void {
  const store = createPlatformTokenStore()
  const preferences = registerPreferenceStore(ctx.settings)

  const antigravityStore = new FileCredentialStore()
  const antigravityModelSettings = new FileModelSettingsStore()
  const antigravityPreferences = registerAntigravityPreferenceStore(ctx.settings, antigravityModelSettings)

  const commandCodeStore = new CommandCodeCredentialStore()
  const commandCodeModelSettings = new CommandCodeModelSettingsStore()
  const commandCodePreferences = registerCommandCodePreferenceStore(ctx.settings, commandCodeModelSettings)

  const kimiCodeStore = new KimiCodeCredentialStore()
  const kimiCodeModelSettings = new KimiCodeModelSettingsStore()
  const kimiCodePreferences = registerKimiCodePreferenceStore(ctx.settings, kimiCodeModelSettings)

  // The allowlist a Session recorded outranks the current settings document,
  // because the built-in delegation tool snapshot it when the Session started.
  const delegationToolNames = normalizeDelegationToolNames(pluginConfig.subagentModelTools)
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
    )
    const disposeAntigravityAdapter = ctx.llm.registerAdapter([ANTIGRAVITY_PROVIDER_ID], antigravityAdapter)
    const disposeAntigravityRoutes = registerAntigravityRoutes(
      ctx,
      antigravityStore,
      antigravityModelSettings,
      antigravityPreferences,
      proxyFetch,
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
    )

    const oauth = new OAuthService(store, { fetchFn: proxyFetch, logger: ctx.logger })
    const usage = new UsageService(oauth, { fetchFn: proxyFetch })
    const responses = new ResponsesClient(oauth, ctx.attachments, {
      fetchFn: proxyFetch,
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

    const disposeRoutes = registerRoutes(ctx, oauth, usage, preferences, proxyManager, searchSwitcher)
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
      disposeAntigravityAdapter()
      disposeCommandCodeRoutes()
      releaseHandle(commandCodeRouteWatch)
      commandCodeRegistration?.()
      commandCodeRegistration = undefined
      disposeKimiCodeRoutes()
      releaseHandle(kimiCodeRouteWatch)
      kimiCodeRegistration?.()
      kimiCodeRegistration = undefined
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
  SUBAGENT_MODEL_SELECTION_NAMESPACE,
  SUBAGENT_POLICY_EVENT,
  authorizedRoutesFor,
  createSubagentAuthorization,
  delegationDenialReason,
  installSubagentModelAuthorization,
  normalizeDelegationToolNames,
  parseAllowedRoutes,
  policyRoutesOf,
  subagentModelSelectionPreference,
  unauthorizedRouteReason,
  validateAuthorizationScope,
  validateDelegationToolNames,
} from './host/subagent-model-authorization.ts'
export { OAuthService } from './host/oauth-service.ts'
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