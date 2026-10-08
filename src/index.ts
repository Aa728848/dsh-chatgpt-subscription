import type { Context } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { CodexChatGptAdapter, PROVIDER_ID } from './host/adapter.ts'
import { loadCodexCatalog } from './host/codex-catalog.ts'
import { CodexAccountPool, codexAccountQuota } from './host/codex-account-pool.ts'
import { createCodexFetchProvider } from './host/codex-fetch.ts'
import { resolveFetchConfiguration, DEFAULT_FETCH_MAX_BODY_CHARS, DEFAULT_FETCH_MAX_RESPONSE_BYTES } from './host/fetch-configuration.ts'
import { createCodexImageTool } from './host/codex-images.ts'
import { createCodexSearchProvider } from './host/codex-search.ts'
import { OAuthService } from './host/oauth-service.ts'
import { ProxyManager } from './host/proxy-manager.ts'
import { CONTROLLED_PROVIDERS, createControlledModelFetch, readModelRequestLimits, type ControlledProvider } from './host/common/model-request-control.ts'
import { claimProviderRoute } from './host/common/provider-route.ts'
import { catalogTotal } from './host/common/catalog-snapshot.ts'
import { createDiagnosticFetch } from './host/common/request-diagnostics.ts'
import { registerPreferenceStore } from './host/preferences.ts'
import { ResponsesClient } from './host/responses-client.ts'
import { registerHubOverviewRoutes, type HubSummarySource } from './host/hub-overview.ts'
import { registerRoutes } from './host/routes.ts'
import { CODEX_MODEL_CATALOG } from './shared/model-catalog.ts'
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
import { PROVIDER_ID as ANTIGRAVITY_PROVIDER_ID, PROVIDER_NAME as ANTIGRAVITY_PROVIDER_NAME } from './host/antigravity/types.ts'
import { CommandCodeAdapter } from './host/command-code/adapter.ts'
import { CommandCodeAccountPool } from './host/command-code/account-pool.ts'
import { registerCommandCodeRoutes } from './host/command-code/routes.ts'
import {
  FileCredentialStore as CommandCodeCredentialStore,
  FileModelSettingsStore as CommandCodeModelSettingsStore,
  registerCommandCodePreferenceStore,
} from './host/command-code/token-store.ts'
import { PROVIDER_ID as COMMAND_CODE_PROVIDER_ID, PROVIDER_NAME as COMMAND_CODE_PROVIDER_NAME } from './host/command-code/types.ts'
import { OllamaAdapter } from './host/ollama/adapter.ts'
import { registerOllamaRoutes } from './host/ollama/routes.ts'
import { OllamaAccountPool } from './host/ollama/account-pool.ts'
import { PROVIDER_ID as OLLAMA_PROVIDER_ID, PROVIDER_NAME as OLLAMA_PROVIDER_NAME } from './host/ollama/types.ts'
import { FileCredentialStore as OllamaCredentialStore, FileModelSettingsStore as OllamaModelSettingsStore } from './host/ollama/token-store.ts'
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
import { MinimaxCodeAdapter } from './host/minimax-code/adapter.ts'
import { MinimaxCodeAccountPool } from './host/minimax-code/account-pool.ts'
import { registerMinimaxCodeRoutes } from './host/minimax-code/routes.ts'
// The two lines that do not persist their model catalog in model settings keep
// it in memory; the overview reads the size from there (see `catalogTotal`).
import { catalogSize as minimaxCodeCatalogSize } from './host/minimax-code/client.ts'
import {
  MinimaxCodeCredentialStore,
  MinimaxCodeModelSettingsStore,
  registerMinimaxCodePreferenceStore,
} from './host/minimax-code/token-store.ts'
import { PROVIDER_ID as MINIMAX_CODE_PROVIDER_ID, PROVIDER_NAME as MINIMAX_CODE_PROVIDER_NAME } from './host/minimax-code/types.ts'
import { WorkBuddyAdapter } from './host/workbuddy/adapter.ts'
import { WorkBuddyAccountPool } from './host/workbuddy/account-pool.ts'
import { registerWorkBuddyRoutes } from './host/workbuddy/routes.ts'
import { getCachedCatalog as getCachedWorkBuddyCatalog } from './host/workbuddy/client.ts'
import {
  FileCredentialStore as WorkBuddyCredentialStore,
  FileModelSettingsStore as WorkBuddyModelSettingsStore,
  registerWorkBuddyPreferenceStore,
} from './host/workbuddy/token-store.ts'
import { PROVIDER_ID as WORKBUDDY_PROVIDER_ID, PROVIDER_NAME as WORKBUDDY_PROVIDER_NAME } from './host/workbuddy/types.ts'
import { ClaudeAdapter } from './host/claude/adapter.ts'
import { ClaudeAccountPool } from './host/claude/account-pool.ts'
import { registerClaudeRoutes } from './host/claude/routes.ts'
import { getCachedCatalog as getCachedClaudeCatalog } from './host/claude/client.ts'
import {
  FileCredentialStore as ClaudeCredentialStore,
  FileModelSettingsStore as ClaudeModelSettingsStore,
  registerClaudePreferenceStore,
} from './host/claude/token-store.ts'
import { PROVIDER_ID as CLAUDE_PROVIDER_ID, PROVIDER_NAME as CLAUDE_PROVIDER_NAME } from './host/claude/types.ts'
import { CHECKIN_TICK_MS, WorkBuddyCheckinService } from './host/workbuddy/checkin.ts'
import {
  CHECKIN_TICK_MS as MINIMAX_CODE_CHECKIN_TICK_MS,
  MinimaxCodeCheckinService,
} from './host/minimax-code/checkin.ts'
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
import {
  installReasoningCollapseGuard,
  type GuardOptions,
  type ReasoningCollapseContext,
} from './host/reasoning-collapse-guard/index.ts'

/** Optional deployment configuration for this plugin. */
export interface Config {
  /** Independent web fetch selection; auto preserves proxy/search-driven selection.
   * Plugin mode uses the plugin destination policy, not DSH DNS pinning, even without a proxy. */
  fetchProvider?: 'auto' | 'plugin' | 'dsh'
  /** Plugin fetch decoded character limit (positive safe integer); the DSH tool may truncate again. */
  fetchMaxBodyChars?: number
  /** Plugin fetch response byte limit (positive safe integer). */
  fetchMaxResponseBytes?: number
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
  /**
   * Reasoning-collapse guard tuning. Omit the key (or set it to `false`) to
   * leave the built-in behaviour alone; the shipped defaults apply otherwise.
   */
  reasoningCollapseGuard?: GuardOptions | false
}

export const Config: z<Config> = z.object({
  fetchProvider: z.union([z.const('auto'), z.const('plugin'), z.const('dsh')]).default('auto'),
  fetchMaxBodyChars: z.number().min(1).max(Number.MAX_SAFE_INTEGER).step(1).default(DEFAULT_FETCH_MAX_BODY_CHARS),
  fetchMaxResponseBytes: z.number().min(1).max(Number.MAX_SAFE_INTEGER).step(1).default(DEFAULT_FETCH_MAX_RESPONSE_BYTES),
  syncAgentPresets: z.boolean().default(true),
  subagentModelAuthorization: z.boolean().default(true),
  subagentModelTools: z.array(z.string()).default([]),
  subagentModelInheritTools: z.array(z.string()).default(DEFAULT_SUBAGENT_INHERIT_TOOLS as unknown as string[]),
  subagentModelScope: z.union([z.const('session'), z.const('preference')]).default('session'),
  // A free-form object is validated by the guard's own fail-loud resolver rather
  // than by a nested schema here, so one rule describes the numbers for both
  // the shipped defaults and a deployment's overrides. `false` opts out.
  reasoningCollapseGuard: z.union([z.object({}), z.const(false)]).default({}),
})

export const inject = ['webServer', 'llm', 'attachments', 'tools', 'settings', 'loader']

export function apply(ctx: Context, pluginConfig: Config = {}): void {
  const fetchConfiguration = resolveFetchConfiguration(pluginConfig)
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

  // MiniMax Code owns its own credential file and keeps it fresh, so this line
  // reads and renews that file rather than keeping a second one of its own.
  const minimaxCodeStore = new MinimaxCodeCredentialStore()
  // The model selection is registered when the harness still has that seam and
  // mirrored into the JSON file beside it otherwise. The card's routes and the
  // adapter are handed the same store, so a toggle in the card is what the next
  // model pick and the next request both see.
  const minimaxCodeModelSettings = new MinimaxCodeModelSettingsStore()
  const minimaxCodePreferences = registerMinimaxCodePreferenceStore(ctx.settings, minimaxCodeModelSettings)
  // The account pool. This is the second line that pools a credential it does not
  // own (WorkBuddy was the first): MiniMax Code's own `auth.json` is adopted and
  // renewed in place but never deleted, which is what lets a user who is already
  // signed in to the desktop app rotate between accounts without signing in twice.
  const minimaxCodeAccountPool = new MinimaxCodeAccountPool({ store: minimaxCodeStore })

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

  const claudeStore = new ClaudeCredentialStore()
  const claudeModelSettings = new ClaudeModelSettingsStore()
  const claudePreferences = registerClaudePreferenceStore(ctx.settings, claudeModelSettings)
  // The pool is the routing table and the credential document is its mirrored
  // primary, so a pre-pool sign-in needs no migration. The card's pinned account
  // is read on each pick, because it can change while the adapter serves.
  const claudeAccountPool = new ClaudeAccountPool({
    store: claudeStore,
    preferAccountId: () => claudePreferences.status().selectedAccountId,
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

  // Stop a reasoning stream that degenerates into repetition before it burns
  // the output budget, then let the turn resume on a fresh step. The guard
  // subscribes to the `llm/stream` waterfall, whose signature is identical on
  // every harness generation this plugin supports, and is inert when the host
  // exposes no event bus. Configured to `false` it is never installed at all.
  if (pluginConfig.reasoningCollapseGuard !== false) {
    const guardOptions: GuardOptions = pluginConfig.reasoningCollapseGuard ?? {}
    ctx.effect(() => {
      const dispose = installReasoningCollapseGuard(ctx as unknown as ReasoningCollapseContext, guardOptions)
      if (dispose === undefined) {
        ctx.logger.warn('[dsh-chatgpt-subscription] reasoning-collapse guard skipped: this harness exposes no event bus')
        return () => undefined
      }
      return dispose
    }, 'dsh-chatgpt-subscription: reasoning collapse guard')
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
    const providerLimits = readModelRequestLimits()
    const modelFetch = Object.fromEntries(CONTROLLED_PROVIDERS.map(provider => [
      provider, createControlledModelFetch(createDiagnosticFetch(proxyFetch, {
        provider,
        onRecord: record => ctx.logger.info('[provider-diagnostics] ' + JSON.stringify(record)),
      }), { provider, limits: providerLimits }),
    ])) as Record<ControlledProvider, typeof fetch>
    const antigravityAdapter = new AntigravityAdapter(
      antigravityStore,
      antigravityModelSettings,
      antigravityPreferences,
      // The route declares image input, so DSH hands it durable image blocks
      // that only the attachment service can turn into wire bytes.
      { fetchFn: modelFetch.antigravity, attachments: ctx.attachments },
      antigravityAccountPool,
    )
    const antigravityClaim = claimProviderRoute(ctx, {
      providerId: ANTIGRAVITY_PROVIDER_ID,
      label: ANTIGRAVITY_PROVIDER_NAME,
      adapter: antigravityAdapter,
    })
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
        serving: () => commandCodeClaim.serving(),
        conflict: () => commandCodeClaim.conflict(),
      },
      commandCodeAccountPool,
    )
    const commandCodeAdapter = new CommandCodeAdapter(
      commandCodeStore,
      commandCodeModelSettings,
      commandCodePreferences,
      { fetchFn: modelFetch['command-code'], attachments: ctx.attachments },
      commandCodeAccountPool,
    )

    // Ollama: API-key accounts rotated through the shared pool kernel.
    const ollamaStore = new OllamaCredentialStore()
    const ollamaModelSettings = new OllamaModelSettingsStore()
    const ollamaAccountPool = new OllamaAccountPool({ store: ollamaStore })
    const ollamaAdapter = new OllamaAdapter(
      ollamaStore,
      ollamaModelSettings,
      { fetchFn: modelFetch.ollama, attachments: ctx.attachments },
      ollamaAccountPool,
    )
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
      { fetchFn: modelFetch['kimi-code'], attachments: ctx.attachments, videos: kimiVideos },
      kimiCodeAccountPool,
    )
    const kimiCodeClaim = claimProviderRoute(ctx, {
      providerId: KIMI_CODE_PROVIDER_ID,
      label: KIMI_CODE_PROVIDER_NAME,
      adapter: kimiCodeAdapter,
    })

    const ollamaClaim = claimProviderRoute(ctx, {
      providerId: OLLAMA_PROVIDER_ID,
      label: OLLAMA_PROVIDER_NAME,
      adapter: ollamaAdapter,
      // This line has never watched `llm/adapters-updated`; it claims once at
      // setup and keeps that behaviour here.
      watch: false,
    })
    // The settings API is registered unconditionally: the card is how a user adds
    // their first key, so gating it on the adapter winning the route would leave a
    // contested id with no way to configure it at all.
    const disposeOllamaRoutes = registerOllamaRoutes(ctx, {
      accountPool: ollamaAccountPool,
      modelSettings: ollamaModelSettings,
      fetchFn: proxyFetch,
    })

    const commandCodeClaim = claimProviderRoute(ctx, {
      providerId: COMMAND_CODE_PROVIDER_ID,
      label: COMMAND_CODE_PROVIDER_NAME,
      adapter: commandCodeAdapter,
    })

    const disposeKimiCodeRoutes = registerKimiCodeRoutes(
      ctx,
      kimiCodeStore,
      kimiCodeModelSettings,
      kimiCodePreferences,
      {
        fetchFn: proxyFetch,
        serving: () => kimiCodeClaim.serving(),
        conflict: () => kimiCodeClaim.conflict(),
      },
      kimiCodeAccountPool,
    )

    const minimaxCodeAdapter = new MinimaxCodeAdapter(
      minimaxCodeStore,
      { fetchFn: modelFetch['minimax-code'], attachments: ctx.attachments, accountPool: minimaxCodeAccountPool },
      minimaxCodeModelSettings,
      minimaxCodePreferences,
    )
    const minimaxCodeClaim = claimProviderRoute(ctx, {
      providerId: MINIMAX_CODE_PROVIDER_ID,
      label: MINIMAX_CODE_PROVIDER_NAME,
      adapter: minimaxCodeAdapter,
    })

    // The daily check-in scheduler (official-client recipe; both regions).
    // Same host-owned cadence as the workbuddy line: the startup pass is the
    // daily run, the interval covers a process that survives midnight.
    let minimaxCodeAppVersion: string | undefined
    try {
      const requireFn = createRequire(import.meta.url)
      const manifest = requireFn('../package.json') as { version?: unknown }
      if (typeof manifest.version === 'string') minimaxCodeAppVersion = manifest.version
    } catch {
      minimaxCodeAppVersion = undefined
    }
    const minimaxCodeCheckin = new MinimaxCodeCheckinService(minimaxCodeAccountPool, {
      fetchFn: proxyFetch,
      settings: () => minimaxCodePreferences.status().checkin ?? { enabled: true },
      // The preference store may still be warming up on a harness without the
      // register seam; without this the startup pass reads shipped defaults and
      // signs in even though the user had switched check-in off.
      ready: () => minimaxCodePreferences.ready(),
      ...(minimaxCodeAppVersion === undefined ? {} : { appVersion: minimaxCodeAppVersion }),
      logger: ctx.logger,
    })
    const minimaxCodeCheckinTick = (): void => {
      void minimaxCodeCheckin.tick().catch((error) => {
        ctx.logger.warn(`[dsh-chatgpt-subscription] MiniMax Code check-in tick failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    const minimaxCodeCheckinTimer = setInterval(minimaxCodeCheckinTick, MINIMAX_CODE_CHECKIN_TICK_MS)
    minimaxCodeCheckinTick()

    const disposeMinimaxCodeRoutes = registerMinimaxCodeRoutes(ctx, minimaxCodeStore, {
      fetchFn: proxyFetch,
      serving: () => minimaxCodeClaim.serving(),
      conflict: () => minimaxCodeClaim.conflict(),
      accountPool: minimaxCodeAccountPool,
      checkin: minimaxCodeCheckin,
    }, minimaxCodeModelSettings, minimaxCodePreferences)

    // WorkBuddy is the CodeBuddy subscription: this plugin reads the desktop
    // client's own credential files, so its route is claimed like the rest.
    const workBuddyAdapter = new WorkBuddyAdapter(
      workBuddyStore,
      workBuddyModelSettings,
      workBuddyPreferences,
      { fetchFn: modelFetch.workbuddy, attachments: ctx.attachments, accountPool: workBuddyAccountPool },
    )
    const workBuddyClaim = claimProviderRoute(ctx, {
      providerId: WORKBUDDY_PROVIDER_ID,
      label: WORKBUDDY_PROVIDER_NAME,
      adapter: workBuddyAdapter,
    })

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
        serving: () => workBuddyClaim.serving(),
        conflict: () => workBuddyClaim.conflict(),
        accountPool: workBuddyAccountPool,
        checkin: workBuddyCheckin,
      },
    )

    const claudeAdapter = new ClaudeAdapter(
      claudeStore,
      claudeModelSettings,
      claudePreferences,
      { fetchFn: modelFetch.claude, attachments: ctx.attachments, accountPool: claudeAccountPool },
    )
    // Registered unconditionally: there is no acknowledgement, flag or other
    // prior state that can hold this line back. The only thing that can keep the
    // route unclaimed is another adapter family already owning the id, and that
    // is reported rather than hidden by {@link claimProviderRoute}'s catch.
    const claudeClaim = claimProviderRoute(ctx, {
      providerId: CLAUDE_PROVIDER_ID,
      label: CLAUDE_PROVIDER_NAME,
      adapter: claudeAdapter,
    })

    const disposeClaudeRoutes = registerClaudeRoutes(
      ctx,
      claudeStore,
      claudeModelSettings,
      claudePreferences,
      {
        fetchFn: proxyFetch,
        serving: () => claudeClaim.serving(),
        conflict: () => claudeClaim.conflict(),
        accountPool: claudeAccountPool,
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
    codexAccountPool.setQuotaBlockedUntil((account, now) => usage.blockedUntilFor(account.id, account.credentials, now))
    // The same per-account snapshots answer the settings card: each account row
    // draws its own window progress, instead of one figure that belongs to
    // whichever account was active when it was read. The row id keys it, so a
    // token refresh cannot strand a row's meters on the credential it rotated
    // away from.
    codexAccountPool.setQuotaSnapshot((account) => {
      const snapshot = usage.snapshotFor(account.id, account.credentials)
      return snapshot === undefined ? undefined : codexAccountQuota(snapshot)
    })
    const responses = new ResponsesClient(oauth, ctx.attachments, {
      fetchFn: modelFetch['codex-chatgpt'],
      accountPool: codexAccountPool,
      localRawImages: { baseUrl: localWebServerBaseUrl(ctx.webServer.host, ctx.webServer.port) },
      onGenerationFinished: () => usage.invalidate(),
      outputVerbosity: () => preferences.status().outputVerbosity,
      fastMode: () => preferences.status().fastMode,
      reasoningSummary: () => preferences.status().reasoningSummary,
    })
    // The live listing is the authority on what this plan serves; without a
    // credential the loader reports none and the shipped table stands in.
    const adapter = new CodexChatGptAdapter(responses, preferences, (options) => (
      oauth.credentials(undefined, { purpose: 'tool' })
        .then((credentials) => loadCodexCatalog(credentials, { fetchFn: proxyFetch, signal: options?.signal }))
        .catch(() => [])
    ))

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
    let lastFetchDiagnostic: string | undefined
    const applyWebProviders = (current: SubscriptionPreferencesDto = preferences.status()): void => {
      const pluginFetch = proxyManager.resolveActiveProxyUrl() !== null
      void searchSwitcher.select(current.searchProvider, { pluginFetch, fetchProvider: fetchConfiguration.fetchProvider }).then(() => {
        const status = searchSwitcher.status()
        if (status.state === 'missing' || status.state === 'failed') return
        const reason = fetchConfiguration.fetchProvider !== 'auto' ? 'explicit configuration'
          : current.searchProvider === 'codex' ? 'Codex search selected'
          : pluginFetch ? 'active proxy detected' : 'no proxy or Codex search'
        const diagnostic = `${status.configuredFetchProvider ?? 'DSH default'} (mode=${fetchConfiguration.fetchProvider}; ${reason}; plugin limits=${fetchConfiguration.fetchMaxBodyChars} chars/${fetchConfiguration.fetchMaxResponseBytes} bytes)`
        if (diagnostic !== lastFetchDiagnostic) {
          lastFetchDiagnostic = diagnostic
          ctx.logger.info(`[dsh-chatgpt-subscription] Web fetch provider configured: ${diagnostic}`)
        }
      }).catch(error => {
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

    // The route table owns the local-login scanner; it needs nothing beyond what
    // registerRoutes already receives, so no new collaborator is threaded through
    // this wiring just to produce a row of stats.
    const disposeRoutes = registerRoutes(
      ctx, oauth, usage, preferences, proxyManager, searchSwitcher, readRouteAudit, codexAccountPool, fetchConfiguration)

    // The hub overview's one-request summary of every subscription line. Each
    // line's read closure stays beside the stores it reads; the aggregation
    // module itself learns nothing about how a line stores accounts. All reads
    // are local snapshots — no upstream call is ever triggered by the settings
    // page's opening screen.
    const routable = (accounts: readonly { authStatus?: string }[]): boolean =>
      accounts.some((account) => account.authStatus === undefined || account.authStatus === 'ok')
    // What the overview card's "N/M models" counts. Every line already holds its
    // catalog: Antigravity, Command Code, Kimi Code and Ollama persist the last
    // successful sync in their model settings, while Claude, WorkBuddy and
    // MiniMax Code keep it in memory. All of these are reads of what the line
    // already has — opening the settings page must not trigger a catalog fetch —
    // and a line that has never synced one reports null rather than a zero that
    // would read as "this line has no models".
    const hubSources: HubSummarySource[] = [
      {
        id: 'chatgpt',
        providerId: PROVIDER_ID,
        canToggle: true,
        read: async () => {
          const current = preferences.status()
          const accounts = await codexAccountPool.listAccounts().catch(() => [])
          return {
            enabled: current.enabled !== false,
            accountCount: accounts.length,
            authenticated: routable(accounts),
            enabledModelCount: current.visibleModelIds.length,
            totalModelCount: CODEX_MODEL_CATALOG.length,
          }
        },
      },
      {
        id: 'antigravity',
        providerId: ANTIGRAVITY_PROVIDER_ID,
        canToggle: true,
        read: async () => {
          const current = antigravityPreferences.status()
          const accounts = await antigravityAccountPool.listAccounts().catch(() => [])
          const total = catalogTotal((await antigravityModelSettings.read()).catalogModels.length)
          return {
            enabled: current.enabled !== false,
            accountCount: accounts.length,
            authenticated: routable(accounts),
            enabledModelCount: total === null ? null : Math.min(current.enabledModelIds?.length ?? 0, total),
            totalModelCount: total,
          }
        },
      },
      {
        id: 'command-code',
        providerId: COMMAND_CODE_PROVIDER_ID,
        canToggle: true,
        read: async () => {
          const current = commandCodePreferences.status()
          const accounts = await commandCodeAccountPool.listAccounts().catch(() => [])
          const total = catalogTotal((await commandCodeModelSettings.read()).catalogModels.length)
          return {
            enabled: current.enabled !== false,
            accountCount: accounts.length,
            authenticated: routable(accounts),
            enabledModelCount: total === null ? null : Math.min(current.enabledModelIds?.length ?? 0, total),
            totalModelCount: total,
          }
        },
      },
      {
        id: 'kimi-code',
        providerId: KIMI_CODE_PROVIDER_ID,
        canToggle: true,
        read: async () => {
          const current = kimiCodePreferences.status()
          const accounts = await kimiCodeAccountPool.listAccounts().catch(() => [])
          const total = catalogTotal((await kimiCodeModelSettings.read()).catalogModels.length)
          return {
            enabled: current.enabled !== false,
            accountCount: accounts.length,
            authenticated: routable(accounts),
            enabledModelCount: total === null ? null : Math.min(current.enabledModelIds?.length ?? 0, total),
            totalModelCount: total,
          }
        },
      },
      {
        id: 'workbuddy',
        providerId: WORKBUDDY_PROVIDER_ID,
        canToggle: true,
        read: async () => {
          const current = workBuddyPreferences.status()
          const accounts = await workBuddyAccountPool.listAccounts().catch(() => [])
          // This line does not persist its catalog in model settings, so the
          // in-memory cache is the one that knows how many models exist.
          const total = catalogTotal(getCachedWorkBuddyCatalog().length)
          return {
            enabled: current.enabled !== false,
            accountCount: accounts.length,
            authenticated: routable(accounts),
            enabledModelCount: total === null ? null : Math.min(current.enabledModelIds?.length ?? 0, total),
            totalModelCount: total,
          }
        },
      },
      {
        id: 'minimax-code',
        providerId: MINIMAX_CODE_PROVIDER_ID,
        canToggle: true,
        read: async () => {
          const current = minimaxCodePreferences.status()
          const accounts = await minimaxCodeAccountPool.listAccounts().catch(() => [])
          const total = catalogTotal(minimaxCodeCatalogSize())
          return {
            enabled: current.enabled !== false,
            accountCount: accounts.length,
            authenticated: routable(accounts),
            enabledModelCount: total === null ? null : Math.min(current.enabledModelIds?.length ?? 0, total),
            totalModelCount: total,
          }
        },
      },
      {
        id: 'claude',
        providerId: CLAUDE_PROVIDER_ID,
        canToggle: true,
        read: async () => {
          const current = claudePreferences.status()
          const accounts = await claudeAccountPool.listAccounts().catch(() => [])
          const total = catalogTotal(getCachedClaudeCatalog().length)
          return {
            enabled: current.enabled !== false,
            accountCount: accounts.length,
            authenticated: routable(accounts),
            enabledModelCount: total === null ? null : Math.min(current.enabledModelIds?.length ?? 0, total),
            totalModelCount: total,
          }
        },
      },
      {
        // Ollama has no enable switch — a key line is always servable — so its
        // card renders no toggle and always reports enabled.
        id: 'ollama',
        providerId: OLLAMA_PROVIDER_ID,
        canToggle: false,
        read: async () => {
          const accounts = await ollamaAccountPool.listAccounts().catch(() => [])
          const current = ollamaModelSettings.status()
          const total = catalogTotal(current.catalogModels.length)
          // An empty selection on this line means "every synced model", not
          // "none": reporting its length raw would show 0 of 12 enabled.
          const enabled = current.enabledModelIds.length === 0 ? total : current.enabledModelIds.length
          return {
            enabled: true,
            accountCount: accounts.length,
            authenticated: routable(accounts),
            enabledModelCount: total === null ? null : Math.min(enabled ?? 0, total),
            totalModelCount: total,
          }
        },
      },
    ]
    const disposeHubOverview = registerHubOverviewRoutes(ctx, hubSources)
    const disposeAdapter = ctx.llm.registerAdapter([PROVIDER_ID], adapter)
    const disposeImageTool = ctx.tools.register(createCodexImageTool(oauth, ctx.attachments, { fetchFn: proxyFetch }))
    // The video ingress for the Kimi route. Registered here because the tool
    // needs the plugin context to resolve the calling session's route before it
    // agrees to attach anything.
    const disposeVideoTool = ctx.tools.register(createKimiVideoTool(ctx, { fetchFn: proxyFetch }))

    // Rebind providers when web reloads without resetting the saved default provider selection.
    ctx.inject(['web'], ctx => {
      ctx.web.registerSearchProvider(createCodexSearchProvider(oauth, { fetchFn: proxyFetch }))
      ctx.web.registerFetchProvider(createCodexFetchProvider({
        fetchFn: proxyFetch,
        maxBodyChars: fetchConfiguration.fetchMaxBodyChars,
        maxResponseBytes: fetchConfiguration.fetchMaxResponseBytes,
      }))
      // Registering a provider is safe here; selecting one is not. A selection
      // rewrites the `web` entry's config, which restarts it and unloads every
      // entry that injects `web`. The profile composes as one loader update and
      // the host audits that composition the moment it settles, so a restart
      // started from this callback is read mid-unload and reported as
      // "N entries did not activate", naming `web` and its consumers at
      // `fiber state 5` (UNLOADING). Defer past that audit; readiness and every
      // later preference or proxy change still reconcile the selection.
      setTimeout(applyWebProviders, 0)
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
      disposeHubOverview()
      disposeAntigravityRoutes()
      antigravityClaim.dispose()
      disposeOllamaRoutes()
      ollamaClaim.dispose()
      disposeCommandCodeRoutes()
      commandCodeClaim.dispose()
      disposeKimiCodeRoutes()
      kimiCodeClaim.dispose()
      disposeMinimaxCodeRoutes()
      minimaxCodeClaim.dispose()
      clearInterval(minimaxCodeCheckinTimer)
      clearInterval(checkinTimer)
      disposeWorkBuddyRoutes()
      workBuddyClaim.dispose()
      disposeClaudeRoutes()
      claudeClaim.dispose()
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
export {
  DEFAULT_GUARD_OPTIONS,
  RESUME_HINT,
  RESUME_HINT_STRICT,
  collapseScore,
  installReasoningCollapseGuard,
  resolveGuardOptions,
} from './host/reasoning-collapse-guard/index.ts'
export type {
  GuardAgentLike,
  GuardChunk,
  GuardOptions,
  GuardStreamOptions,
  ReasoningCollapseContext,
  ResolvedGuardOptions,
} from './host/reasoning-collapse-guard/index.ts'
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
export { MinimaxCodeCheckinService } from './host/minimax-code/checkin.ts'
export {
  FALLBACK_MODELS as WORKBUDDY_MODELS,
  WORKBUDDY_MODEL_IDS,
  resolveWorkBuddyModel,
  modelsForRegion as workBuddyModelsForRegion,
} from './host/workbuddy/model-catalog.ts'
export {
  ClaudeAdapter,
  codeForFailure as claudeCodeForFailure,
  toLlmError as claudeToLlmError,
} from './host/claude/adapter.ts'
export {
  ClaudeAccountPool,
  claudePoolPath,
  parseClaudePoolData,
  adoptedPoolAccountKey,
  isAdoptedPoolCredential,
  type ClaudePoolAccount,
  type ClaudeAccountSummaryDto,
} from './host/claude/account-pool.ts'
export {
  FileCredentialStore as ClaudeCredentialStore,
  FileModelSettingsStore as ClaudeModelSettingsStore,
  credentialPath as claudeCredentialPath,
  modelSettingsPath as claudeModelSettingsPath,
  parseClaudeCredentials,
  parseClaudeCredentialDocument,
  registerClaudePreferenceStore,
  type ClaudeCredentials,
  type ClaudeModelSettings,
  type ClaudePreferenceStore,
} from './host/claude/token-store.ts'
export {
  beginLogin as beginClaudeLogin,
  cancelLogin as cancelClaudeLogin,
  ensureAccessToken as ensureClaudeAccessToken,
  getLoginStatus as getClaudeLoginStatus,
  refreshAccessToken as refreshClaudeToken,
  resolveLoginInput as resolveClaudeLoginInput,
  submitLoginInput as submitClaudeLoginInput,
} from './host/claude/oauth.ts'
export {
  claudeCodeCredentialPaths,
  claudeCodeCredentialPresence,
  isAdoptedClaudeCredential,
  isAdoptedCredentialExpired,
  readClaudeCodeCredentials,
  ADOPTED_CREDENTIAL_EXPIRED_HINT as CLAUDE_ADOPTED_CREDENTIAL_EXPIRED_HINT,
} from './host/claude/adopt.ts'
export {
  clearCachedCatalog as clearClaudeCatalog,
  clearCachedQuota as clearClaudeQuota,
  classifyFailure as classifyClaudeFailure,
  fetchAccountQuota as fetchClaudeQuota,
  getCachedQuota as getClaudeQuota,
  loadCatalog as loadClaudeCatalog,
  parseUsagePayload as parseClaudeUsagePayload,
  probeConnection as probeClaudeConnection,
} from './host/claude/client.ts'
export {
  getClaudeWebStatus,
  registerClaudeRoutes,
  ROUTE_PREFIX as CLAUDE_ROUTE_PREFIX,
  buildClaudeModelOptions as buildClaudeModelOptions,
  resolveEnabledModelIds as resolveClaudeEnabledModelIds,
} from './host/claude/routes.ts'
export {
  CLAUDE_MODELS,
  CLAUDE_MODEL_IDS,
  DEFAULT_VISIBLE_MODEL_IDS as CLAUDE_DEFAULT_VISIBLE_MODELS,
  FALLBACK_MODELS as CLAUDE_FALLBACK_MODELS,
  claudeModelCanDisableThinking,
  claudeModelSupportsImage,
  claudeModelSupportsTemperature,
  claudeReasoningEfforts,
  claudeThinkingMode,
  defaultContextWindowFor as claudeDefaultContextWindow,
  maxOutputTokensFor as claudeMaxOutputTokens,
  resolveClaudeModel,
  type ClaudeModelEntry,
} from './host/claude/model-catalog.ts'
export {
  API_BASE as CLAUDE_API_BASE,
  MESSAGES_PATH as CLAUDE_MESSAGES_PATH,
  PROVIDER_ID as CLAUDE_PROVIDER_ID,
  PROVIDER_NAME as CLAUDE_PROVIDER_NAME,
  QUOTA_CACHE_TTL_MS as CLAUDE_QUOTA_CACHE_TTL_MS,
  claudeCliVersion,
  setClaudeCliVersion,
} from './host/claude/types.ts'
export {
  CLAUDE_REASONING_EFFORTS,
  isClaudeReasoningEffort,
  type ClaudeAccountQuota,
  type ClaudeConnectionDto,
  type ClaudeLoginFlowDto,
  type ClaudeModelOption,
  type ClaudeQuotaWindow,
  type ClaudeReasoningEffort,
  type ClaudeSettingsUpdateDto,
  type ClaudeWebStatus,
} from './shared/claude-contracts.ts'
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

// --- MiniMax Code -----------------------------------------------------------------
export { MinimaxCodeAdapter, classifyMinimaxFailure, MINIMAX_CODE_RETRY_POLICY_CONFIG } from './host/minimax-code/adapter.ts'
export {
  MinimaxCodeAccountPool,
  minimaxCodePoolPath,
  minimaxCodePoolIdentity,
  minimaxCodePoolStatus,
  parseMinimaxCodePoolData,
  createMinimaxCodeAccountsHandler,
  type MinimaxCodePoolAccount,
  type MinimaxCodeAccountSummaryDto,
} from './host/minimax-code/account-pool.ts'
export {
  MinimaxCodeCredentialStore,
  MinimaxCodeModelSettingsStore,
  authJsonPath as minimaxCodeAuthJsonPath,
  authStateJsonPath as minimaxCodeAuthStateJsonPath,
  credentialIsFresh as minimaxCodeCredentialIsFresh,
  minimaxHomeDir as minimaxCodeHomeDir,
  modelSettingsPath as minimaxCodeModelSettingsPath,
  parseMinimaxCodeCredentials,
  pluginCredentialPath as minimaxCodePluginCredentialPath,
  registerMinimaxCodePreferenceStore,
  type MinimaxCodeCredentialSource,
  type MinimaxCodeCredentials,
  type MinimaxCodeModelSettings,
  type MinimaxCodePreferenceStore,
} from './host/minimax-code/token-store.ts'
export {
  accountFromCredentials as minimaxCodeAccountFromCredentials,
  beginWebLogin as beginMinimaxCodeLogin,
  cancelWebLogin as cancelMinimaxCodeLogin,
  ensureAccessToken as ensureMinimaxCodeAccessToken,
  getWebLogin as getMinimaxCodeLogin,
  isRefreshTokenRejected as isMinimaxCodeRefreshTokenRejected,
  pollWebLogin as pollMinimaxCodeLogin,
  refreshAccessToken as refreshMinimaxCodeToken,
  requestDeviceAuthorization as requestMinimaxCodeDeviceAuthorization,
  resetWebLogins as resetMinimaxCodeLogins,
  revokeToken as revokeMinimaxCodeToken,
  createPkcePair as createMinimaxCodePkcePair,
  type DeviceAuthorization as MinimaxCodeDeviceAuthorization,
  type MinimaxToken,
} from './host/minimax-code/oauth.ts'
export {
  PROBE_MODEL as MINIMAX_CODE_PROBE_MODEL,
  catalogSize as minimaxCodeCatalogSize,
  createMessage as createMinimaxCodeMessage,
  describeCredentials as describeMinimaxCodeCredentials,
  listModelIds as listMinimaxCodeModelIds,
  modelRequestHeaders as minimaxCodeModelRequestHeaders,
  parseAnthropicUsage as parseMinimaxCodeUsage,
  testConnection as testMinimaxCodeConnection,
  summarizeFailureBody as summarizeMinimaxCodeFailureBody,
  clearCachedQuota as clearMinimaxCodeQuota,
  fetchTokenPlanQuota as fetchMinimaxCodeQuota,
  getCachedQuota as getMinimaxCodeQuota,
  parseTokenPlanQuota as parseMinimaxCodeQuota,
  quotaRequestHeaders as minimaxCodeQuotaRequestHeaders,
  resolveQuotaCounts as resolveMinimaxCodeQuotaCounts,
  type MinimaxProbeResult,
  type MinimaxUsage,
} from './host/minimax-code/client.ts'
export {
  MINIMAX_CODE_MODELS,
  buildMinimaxCodeModelOptions,
  contextWindowForModel,
  effortForModel as minimaxCodeEffortForModel,
  isThinkingDisabledEffort,
  minimaxCodeModelDef,
  minimaxCodeModelIds,
  minimaxCodeModelName,
  resolveMinimaxCodeEnabledModelIds,
  type MinimaxCodeCatalogModel,
  type MinimaxCodeThinkingMode,
} from './host/minimax-code/model-catalog.ts'
export {
  assertRequestBodyFits as assertMinimaxCodeBodyFits,
  assertStreamComplete as assertMinimaxCodeStreamComplete,
  buildMinimaxRequest,
  clampOutputToContext as clampMinimaxCodeOutputToContext,
  closeMinimaxStream,
  createStreamState as createMinimaxCodeStreamState,
  DEFAULT_MAX_MESSAGE_BODY_BYTES as MINIMAX_CODE_MAX_MESSAGE_BODY_BYTES,
  maxMessageBodyBytes as minimaxCodeMaxMessageBodyBytes,
  maxOutputTokensFor as minimaxCodeMaxOutputTokens,
  processMinimaxStreamLine,
  outputConfigFor as minimaxCodeOutputConfig,
  type MinimaxStreamState,
} from './host/minimax-code/mapper.ts'
export {
  getMinimaxCodeWebStatus,
  registerMinimaxCodeRoutes,
  subPathOf as minimaxCodeSubPathOf,
} from './host/minimax-code/routes.ts'
export {
  AGENT_LLM_PREFIX as MINIMAX_CODE_AGENT_LLM_PREFIX,
  MESSAGES_PATH as MINIMAX_CODE_MESSAGES_PATH,
  REGION_HOSTS as MINIMAX_CODE_REGION_HOSTS,
  accountHost as minimaxCodeAccountHost,
  agentBaseUrl as minimaxCodeAgentBaseUrl,
  isMinimaxCodeReasoningEffort,
  quotaHostCandidates as minimaxCodeQuotaHostCandidates,
  tokenPlanRemainsUrl as minimaxCodeTokenPlanRemainsUrl,
  messagesUrl as minimaxCodeMessagesUrl,
  redactToken as redactMinimaxCodeToken,
} from './host/minimax-code/types.ts'
export {
  MINIMAX_CODE_PROVIDER_ID,
  MINIMAX_CODE_PROVIDER_NAME,
  MINIMAX_CODE_REASONING_EFFORTS,
  MINIMAX_CODE_ROUTE_PREFIX,
  type MinimaxCodeAccount,
  type MinimaxCodeCredentialStorage,
  type MinimaxCodeModelOption,
  type MinimaxCodeQuota,
  type MinimaxCodeReasoningEffort,
  type MinimaxCodeRegion,
  type MinimaxCodeThinkingModeDto,
  type MinimaxCodeWebLogin,
  type MinimaxCodeWebStatus,
} from './shared/minimax-code-contracts.ts'

function localWebServerBaseUrl(host: '127.0.0.1' | '0.0.0.0', port: number): string {
  return `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`
}