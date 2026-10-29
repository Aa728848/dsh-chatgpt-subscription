import type { Context } from '@deepseek-ai/cordis'
import { attachProgressSettings } from './entry-progress-updates.ts'
import { resolveProgressUpdatesSettings } from './host/progress-updates/index.ts'
import type { ProgressUpdateLanguage } from './host/progress-updates/prompt.ts'
import { NUDGE_THRESHOLD as PROGRESS_NUDGE_THRESHOLD } from './host/progress-updates/store.ts'
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
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS } from './host/common/idle-watchdog.ts'
import { webServerOrigin } from './host/common/webserver-compat.ts'
import { createCodexImageTool } from './host/codex-images.ts'
import { createAntigravityImageTool } from './host/antigravity/image-tool.ts'
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
import { registerUpdateRoutes } from './host/update-check.ts'
import { registerRoutes } from './host/routes.ts'
import { CODEX_MODEL_CATALOG } from './shared/model-catalog.ts'
import { createPlatformTokenStore } from './host/platform-token-store.ts'
import { SearchProviderSwitcher } from './host/search-provider-switcher.ts'
import { startWebProviderReconciler } from './host/web-provider-reconciler.ts'
import { UsageService } from './host/usage-service.ts'
import { registerWidgetBoard, type WidgetBoardContext } from './host/widget-board/provider.ts'
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
import { configurePoolStorage } from './host/common/pool-storage.ts'
import { PoolStorageSettings } from './host/common/pool-storage-settings.ts'
import { asCredentialsSeam } from './host/common/credentials-compat.ts'
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
import { createMinimaxGenerateVideoTool, createMinimaxUnderstandVideoTool } from './host/minimax-code/video-tool.ts'
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
// The line that does not persist its model catalog in model settings keeps it
// in memory; the overview reads the size from there (see `catalogTotal`).
// The quota reader rides the same import because the board's per-account hook
// needs the line's OWN client (see the `accountQuotaClients` wiring below).
import {
  catalogSize as minimaxCodeCatalogSize,
  fetchTokenPlanQuota as fetchMinimaxTokenPlanQuota,
} from './host/minimax-code/client.ts'
import {
  MinimaxCodeCredentialStore,
  MinimaxCodeModelSettingsStore,
  registerMinimaxCodePreferenceStore,
} from './host/minimax-code/token-store.ts'
import { PROVIDER_ID as MINIMAX_CODE_PROVIDER_ID, PROVIDER_NAME as MINIMAX_CODE_PROVIDER_NAME } from './host/minimax-code/types.ts'
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
import { GlmCodingPlanAdapter } from './host/glm-coding-plan/adapter.ts'
import { GlmCodingPlanAccountPool } from './host/glm-coding-plan/account-pool.ts'
import { glmCodingPlanSettingsSource, registerGlmCodingPlanRoutes } from './host/glm-coding-plan/routes.ts'
import { catalogSize as glmCodingPlanCatalogSize } from './host/glm-coding-plan/model-catalog.ts'
import {
  GlmCodingPlanCredentialStore,
  GlmCodingPlanModelSettingsStore,
  registerGlmCodingPlanPreferenceStore,
} from './host/glm-coding-plan/token-store.ts'
import { PROVIDER_ID as GLM_CODING_PLAN_PROVIDER_ID, PROVIDER_NAME as GLM_CODING_PLAN_PROVIDER_NAME } from './host/glm-coding-plan/types.ts'
import { StepCodeAdapter, stepCodeCatalogSize } from './host/step-code/adapter.ts'
import { StepCodeAccountPool } from './host/step-code/account-pool.ts'
import { registerStepCodeRoutes, stepCodeSettingsSource } from './host/step-code/routes.ts'
import {
  StepCodeCredentialStore,
  StepCodeModelSettingsStore,
  registerStepCodePreferenceStore,
} from './host/step-code/token-store.ts'
import { PROVIDER_ID as STEP_CODE_PROVIDER_ID, PROVIDER_NAME as STEP_CODE_PROVIDER_NAME } from './host/step-code/types.ts'
import { createClinePassLine } from './host/cline-pass/line.ts'
import { QoderAdapter, cachedQoderModelCatalog, convergeQoderSelection } from './host/qoder/adapter.ts'
import { QoderAccountPool } from './host/qoder/account-pool.ts'
import { registerQoderRoutes, qoderSettingsSource, warmQoderCatalogOnStartup } from './host/qoder/routes.ts'
import {
  QoderCredentialStore,
  QoderModelSettingsStore,
  registerQoderPreferenceStore,
} from './host/qoder/token-store.ts'
import { loadQoderQuota, qoderCatalogIsLive } from './host/qoder/client.ts'
import { PROVIDER_ID as QODER_PROVIDER_ID, PROVIDER_NAME as QODER_PROVIDER_NAME } from './host/qoder/types.ts'
import { createOpenDesignLine } from './host/opendesign/line.ts'
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
import type { PoolStorageMode, SubagentRouteAuditDto } from './shared/contracts.ts'
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
import {
  installCompactionRoute,
  type CompactionChunk,
  type CompactionModelInfo,
  type CompactionRouteContext,
  type CompactionStreamOptions,
} from './host/compaction-route/index.ts'
import {
  installNoAnswerResume,
  type NoAnswerResumeContext,
  type NoAnswerResumeOptions,
} from './host/no-answer-resume/index.ts'
import {
  installCacheWarmup,
  type CacheWarmupContext,
} from './host/cache-warmup/install.ts'
import { sessionCacheState } from './host/kimi-code/session-cache-state.ts'
import {
  CACHE_WARMUP_SETTING_DESCRIPTION,
  CACHE_WARMUP_RETRIEVAL_SETTING_DESCRIPTION,
  resolveCacheWarmupSettings,
} from './host/cache-warmup/settings.ts'

interface Volatile<T> {
  get(): T
}

/**
 * 运行期配置形状：标了 `volatile()` 的字段在 loader 解析之后是**活引用**。
 *
 * 这一份是插件体在 `apply` 里真正拿到的形状，也是 {@link Config} schema 的输出
 * 类型；{@link ConfigInput} 才是 profile 里写的普通值。
 */
export interface Config {
  /**
   * 「进展更新」总开关。打开后 agent 可以用 `progress_update` 工具在不结束回
   * 合的前提下主动汇报多步任务的进展，网页在对话流里显示成一行，右侧栏面板汇
   * 总。默认开启。
   *
   * 声明成 {@link Volatile} 是因为 schema 里标了 `volatile()`：loader 把这个字段
   * 解析成一个活引用交进 `apply`，设置一保存就就地写新值、不重挂插件行。
   *
   * **实现搬到了独立的 loader 行**（`src/entry-progress-updates.ts`），但字段留在
   * 这里：profile 的 patch 层按 id 替换整行 config，用户的 profile 早就在这一行写过
   * `progressUpdates`；字段若搬去新行，那条 patch 会把新行的配置整体抹掉。
   *
   * 与「缓存预热」不同，这一项**不挑线路**：工具、提示词与催促都挂在插件自己的
   * loader 行上，任何线路的 agent 都能用。
   */
  progressUpdates?: Volatile<boolean>
  /** 进展更新的催促阈值：连续这么多轮带工具调用却没有进展更新时提醒一次。默认 8。 */
  progressUpdatesNudgeThreshold?: Volatile<number>
  /** 进展更新的输出语言：`auto` 跟随对话（默认）、`zh` 中文、`en` 英文。 */
  progressUpdatesLanguage?: Volatile<ProgressUpdateLanguage>
  /**
   * 「结果预览」总开关：Kimi 线路上超大的 `run_code` 结果会被换成带 `ref://`
   * 引用的预览，原文由 `cache_warmup_result` 精确补读。默认开启。
   *
   * **只对 Kimi Code 线路生效**（见 `cache-warmup/install.ts` 的
   * `CACHE_WARMUP_PROVIDER`）：别的线路上这个开关开着关着都一样。
   *
   * 声明成 {@link Volatile} 是因为 schema 里标了 `volatile()`：设置一保存就地写
   * 新值、不重挂插件行。语义上它**只影响之后产生的新结果**——已经进入历史的
   * preview 与 refId 是历史的一部分，不随开关变化。
   */
  cacheWarmup?: Volatile<boolean>
  /**
   * 检索型结果投影独立开关：默认开启，只影响明确导航任务之后的新结果。
   *
   * 与总开关一样**只对 Kimi Code 线路生效**，其他线路不受影响。
   */
  cacheWarmupRetrieval?: Volatile<boolean>
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
   * Reasoning-collapse guard tuning. **Disabled by default**: the guard is
   * shipped and fully wired, but this line no longer installs it unless a
   * deployment explicitly opts in. Set the key to an object (`{}` accepts the
   * shipped defaults) to turn the break back on; `false` keeps it off.
   */
  reasoningCollapseGuard?: GuardOptions | false
  /**
   * Resume a turn that ended without an answer or a tool call. Omit the key
   * (or set it to `false`) to leave the turn failed; the shipped defaults
   * apply otherwise.
   */
  noAnswerResume?: NoAnswerResumeOptions | false
  /**
   * Idle budget for one Codex Responses stream, in milliseconds.
   *
   * Counted on transport activity rather than on visible chunks, so status
   * frames and truncated reasoning keep the connection alive. `0` is not a
   * disable switch: the floor is 1ms, and a real stall still times out.
   */
  codexStreamIdleTimeoutMs?: number
  /**
   * Where every provider line's account pool is stored.
   *
   * `keyring` (default) is the platform store — DPAPI on Windows, the Keychain on
   * macOS, the Secret Service on Linux — which is what every existing install has.
   * `credentials` puts the pool in DSH's own credential store through the
   * credentials seam, which is the value a server without a desktop keyring needs:
   * there the keyring is absent, and the account could not be saved at all.
   *
   * The settings card writes its own choice into the plugin's storage document,
   * which then takes precedence over this value; a profile that never mentions the
   * key keeps the default.
   */
  poolStorage?: PoolStorageMode
}

/**
 * profile 里写的配置形状：volatile 字段在这里仍是普通值。
 *
 * 两者必须分开声明——schemastery 的 `z<S, T>` 是「输入 / 输出」二元组，写成一个
 * 合并的接口会让 schema 与声明互相矛盾（`volatile()` 的字段输出是引用，输入是
 * 值）。分开放还有一个好处：测试与部署方写配置时用的是 {@link ConfigInput}，
 * 手写活引用不会被误认为合法部署配置。
 */
export interface ConfigInput {
  /** Independent web fetch selection; auto preserves proxy/search-driven selection.
   * Plugin mode uses the plugin destination policy, not DSH DNS pinning, even without a proxy. */
  fetchProvider?: 'auto' | 'plugin' | 'dsh'
  /** Plugin fetch decoded character limit (positive safe integer); the DSH tool may truncate again. */
  fetchMaxBodyChars?: number
  /** Plugin fetch response byte limit (positive safe integer). */
  fetchMaxResponseBytes?: number
  /** Whether to sync this package's bundled agent presets into the harness-home preset root. */
  syncAgentPresets?: boolean
  /** Whether the Subagent model allowlist also governs the route a delegation would inherit. */
  subagentModelAuthorization?: boolean
  /** Delegation tool names the authorization guard recognizes (default `subagent`). */
  subagentModelTools?: string[]
  /** Delegation tools that always run their child on the calling agent's route. */
  subagentModelInheritTools?: string[]
  /** `session` (default) enforces the recorded allowlist; `preference` also enforces the current card. */
  subagentModelScope?: 'session' | 'preference'
  /** Reasoning-collapse guard tuning; `false` keeps the guard off. */
  reasoningCollapseGuard?: GuardOptions | false
  /** Resume a turn that ended without an answer or a tool call; `false` leaves it failed. */
  noAnswerResume?: NoAnswerResumeOptions | false
  /** 「进展更新」总开关（默认开启）。 */
  progressUpdates?: boolean
  /** 进展更新的催促阈值（默认 8）。 */
  progressUpdatesNudgeThreshold?: number
  /** 进展更新的输出语言（默认 auto：跟随对话）。 */
  progressUpdatesLanguage?: ProgressUpdateLanguage
  /** 「结果预览」总开关（默认开启；只影响之后产生的新结果）。 */
  cacheWarmup?: boolean
  /** 检索型结果投影独立开关（默认开启；只影响之后产生的新结果）。 */
  cacheWarmupRetrieval?: boolean
  /** Idle budget for one Codex Responses stream, in milliseconds. */
  codexStreamIdleTimeoutMs?: number
  /**
   * 号池存储后端：`keyring`（默认，平台密钥环）或 `credentials`（DSH 凭据库，服务器推荐）。
   *
   * 没有 `auto`：按探测结果换存储会让一个号池在两份存储之间来回搬，而「号池搬家了」
   * 和「号池里的账号丢了」在界面上长得一模一样。不可用的选择照实报错，不替换。
   */
  poolStorage?: PoolStorageMode
}

export const Config: z<ConfigInput, Config> = z.object({
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
  // the shipped defaults and a deployment's overrides. The default is `false`:
  // the guard stays maintained and installable, but this line does not turn it
  // on by itself — a deployment must opt in with an object of its own.
  reasoningCollapseGuard: z.union([z.object({}), z.const(false)]).default(false),
  // Same shape as the guard above: the resume hook validates its own numbers
  // fail-loud, and `false` opts out.
  noAnswerResume: z.union([z.object({}), z.const(false)]).default({}),
  // 进展更新：实现挂在独立的 loader 行上，但**字段留在这里**（见运行期 Config 的
  // 同名注释）。三个都是 `volatile()`：设置面板保存时直接提交进正在运行的实例，
  // 不重挂任何行，开关因此在同一个会话里立刻生效。
  progressUpdates: z.boolean().default(true).volatile()
    .description('启用进展更新：允许 agent 用 progress_update 工具主动汇报多步任务的进展，并在侧栏展示。本插件的所有线路都可用。'),
  progressUpdatesNudgeThreshold: z.number().step(1).min(1).max(50).default(PROGRESS_NUDGE_THRESHOLD).volatile()
    .description('催促阈值：连续这么多轮带工具调用却没有进展更新时，提醒 agent 发一条进展。'),
  progressUpdatesLanguage: z.union([z.const('auto'), z.const('zh'), z.const('en')]).default('auto').volatile()
    .description('进展更新的输出语言：auto 跟随对话语言，zh 中文，en 英文。'),
  // 结果预览的开关同样声明在这里、实现挂在本插件的 apply 里（不像进展更新那样
  // 有独立 loader 行）。volatile 的选择与上面三个一致：设置卡保存时直接提交进
  // 正在运行的实例，不重挂任何行。
  cacheWarmup: z.boolean().default(true).volatile()
    .description(CACHE_WARMUP_SETTING_DESCRIPTION),
  cacheWarmupRetrieval: z.boolean().default(true).volatile()
    .description(CACHE_WARMUP_RETRIEVAL_SETTING_DESCRIPTION),
  // `min(1)` on purpose: this is a deadline, not a switch. There is no "off".
  codexStreamIdleTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).step(1).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  // 号池存储后端。默认 `keyring`：桌面照旧走平台存储（DPAPI / 钥匙串 / Secret
  // Service），现有安装零变化；没有桌面密钥环的服务器要显式选 `credentials`，
  // 把号池放进 DSH 自己的凭据库——原先这里在 Linux 上硬编码 Secret Service，
  // 那种主机上令牌换成功了却存不下来。设置卡把选择写进插件自己的存储文档，
  // 并优先于这里的值。
  poolStorage: z.union([z.const('keyring'), z.const('credentials')]).default('keyring')
    .description('号池存储后端：keyring（默认，桌面平台的系统密钥环）或 credentials（DSH 凭据库，服务器推荐）。'),
})

export const inject = ['webServer', 'llm', 'attachments', 'tools', 'settings', 'loader']

export function apply(ctx: Context, pluginConfig: Config = {}): void {
  const fetchConfiguration = resolveFetchConfiguration(pluginConfig)
  // Where every line's account pool lives. Read here, once, because the choice is
  // one per deployment: the eleven pools are built below from that one value.
  //
  // Two sources, in this order: the settings card's own document (written by
  // `POST /storage`, remembered across restarts) and the profile's `poolStorage`.
  // The getter is a function rather than a captured value because the card may
  // change it while the host runs — `PoolStorageSettings.update` bumps the
  // revision every pool checks before using its cached backend.
  //
  // The credential store is OPTIONAL and read through `get`: harnesses before 0.2
  // have no such service, and declaring it in `inject` would make the whole plugin
  // fail to mount on those hosts — turning "your pools go somewhere else here"
  // into "this plugin does not load".
  const poolStorageSettings = new PoolStorageSettings()
  void poolStorageSettings.hydrate().catch(() => undefined)
  configurePoolStorage({
    mode: () => poolStorageSettings.effective(pluginConfig.poolStorage),
    ready: () => poolStorageSettings.hydrate().catch(() => undefined),
    // A getter, not a captured value: `credentials` is not in `inject`, so nothing
    // orders it before this `apply`, and a service captured here would stay
    // `undefined` for the life of the process on a host that mounts it a moment
    // later — `poolStorage: 'credentials'` would report `no-credentials-service`
    // forever, with no retry on the revision the settings card bumps.
    credentials: () => asCredentialsSeam(ctx.get('credentials')),
    logger: ctx.logger,
  })
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

  // 进展更新的实现跑在自己的 loader 行上，设置却声明在这里（见 Config）。
  // 两行的挂载顺序不归任何一方管，所以两边都留了座位：先挂的一方等另一方来交。
  attachProgressSettings(() => resolveProgressUpdatesSettings(pluginConfig))

  const store = createPlatformTokenStore()
  const preferences = registerPreferenceStore(ctx.settings)
  // The fallback document is read off the plugin-load path: the store reports
  // the shipped defaults until the file lands, and a read failure is harmless.
  void preferences.hydrate().catch(() => undefined)

  // A host summarizes a compaction on the conversation's own model unless its
  // preset names another route, and that preset is not this plugin's to edit.
  // Re-routing the call at `llm/stream` turns the choice into a setting and
  // covers every preset rather than only the one this plugin ships. Inert while
  // no target is configured.
  ctx.effect(() => {
    const llm = ctx.llm as unknown as {
      stream(options: CompactionStreamOptions): AsyncIterable<CompactionChunk>
      listModels(provider: string): Promise<readonly CompactionModelInfo[]>
    }
    const handle = installCompactionRoute(
      {
        on: (event, listener, options) => (ctx as unknown as CompactionRouteContext).on?.(event, listener, options),
        logger: ctx.logger,
      },
      {
        stream: (options) => llm.stream(options),
        listModels: (provider) => llm.listModels(provider),
        // Scoped to the line whose settings page offers the card: a session on
        // any other provider keeps its own model for compaction, so configuring
        // this never changes what another line produces or spends.
        scopeProvider: KIMI_CODE_PROVIDER_ID,
        readTarget: () => preferences.status().compactionRoute ?? null,
      },
    )
    if (handle === undefined) {
      ctx.logger.warn('[dsh-chatgpt-subscription] compaction route skipped: this harness exposes no event bus')
      return () => undefined
    }
    return () => handle.dispose()
  }, 'dsh-chatgpt-subscription: compaction route')

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
  // The account pool. This line pools a credential it does not own: MiniMax
  // Code's own `auth.json` is adopted and renewed in place but never deleted,
  // which is what lets a user who is already signed in to the desktop app
  // rotate between accounts without signing in twice.
  const minimaxCodeAccountPool = new MinimaxCodeAccountPool({ store: minimaxCodeStore })

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

  // GLM（ZCode 账号）：浏览器 OAuth 登录与 adopt 产出同一种凭据，一个池里可以同时
  // 有国区与国际区账号。凭据文件是号池主账号的镜像，只在号池为空时投影出一个账号。
  const glmCodingPlanStore = new GlmCodingPlanCredentialStore()
  const glmCodingPlanModelSettings = new GlmCodingPlanModelSettingsStore()
  const glmCodingPlanPreferences = registerGlmCodingPlanPreferenceStore(ctx.settings, glmCodingPlanModelSettings)
  const glmCodingPlanAccountPool = new GlmCodingPlanAccountPool({
    store: glmCodingPlanStore,
    // 卡片可以钉住一个账号，而它能在适配器服务请求期间改变，所以每次选号都读一次。
    preferAccountId: () => glmCodingPlanPreferences.status().selectedAccountId ?? null,
  })

  // Step Code（Step Plan 订阅）：国区与国际区可以同时在池里，区域由凭据的 profile
  // 唯一决定（一个区的 Key 打另一区的端点会被拒，所以去重键里带着区域）。
  // 这条线路的凭据永不过期也没有刷新链，号池的 refresh 钩子因此恒抛错——那是刻意的。
  const stepCodeStore = new StepCodeCredentialStore()
  const stepCodeModelSettings = new StepCodeModelSettingsStore()
  const stepCodePreferences = registerStepCodePreferenceStore(ctx.settings, stepCodeModelSettings)
  const stepCodeAccountPool = new StepCodeAccountPool({
    // 卡片可以钉住一个账号，而它能在适配器服务请求期间改变，所以每次选号都读一次。
    preferAccountId: () => stepCodePreferences.status().selectedAccountId,
  })

  // Qoder（订阅）：全球区与中国站可以同时在池里，区域由凭据唯一决定
  // （一个区的 token 打另一区的端点会被拒，所以去重键里带着区域）。
  // 与 step-code 不同，这条线路的凭据会过期、可刷新，号池的 refresh 钩子是活的。
  const qoderStore = new QoderCredentialStore()
  const qoderModelSettings = new QoderModelSettingsStore()
  const qoderPreferences = registerQoderPreferenceStore(ctx.settings, qoderModelSettings)
  const qoderAccountPool = new QoderAccountPool({
    // 卡片可以钉住一个账号，而它能在适配器服务请求期间改变，所以每次选号都读一次。
    preferAccountId: () => qoderPreferences.status().selectedAccountId,
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
  // exposes no event bus. Configured to `false` it is never installed at all,
  // and `false` is the default: this line is switched off, so every code path
  // below (install, resume queue, per-turn breaker bookkeeping) stays unwired
  // until a deployment opts back in.
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

  // A turn this line reports as answerless is honest but unfinished: the
  // harness has no representation for "the model stopped before it did
  // anything", so nothing continues it. The hook steers one continuation once
  // the Agent is idle. Configured to `false` it is never installed at all.
  if (pluginConfig.noAnswerResume !== false) {
    const resumeOptions: NoAnswerResumeOptions = pluginConfig.noAnswerResume ?? {}
    ctx.effect(() => {
      const dispose = installNoAnswerResume(ctx as unknown as NoAnswerResumeContext, resumeOptions)
      if (dispose === undefined) {
        ctx.logger.warn('[dsh-chatgpt-subscription] no-answer resume skipped: this harness exposes no event bus')
        return () => undefined
      }
      return dispose
    }, 'dsh-chatgpt-subscription: no-answer resume')
  }

  // 结果预览：把 Kimi 线路上可结构化提取的超大 `run_code` 结果换成带 `ref://`
  // 引用的预览，原文由 `cache_warmup_result` 精确补读。
  //
  // 与上面两个钩子不同，这里**没有** `if (config.cacheWarmup !== false)` 的门：
  // 开关是 volatile 活引用，apply 时读到的值不是最终值，真正的判定在每次投影时
  // 重读（见 `install.ts` 的 `projectDecision`）。所以"关掉"不是一个安装参数，
  // 而是每次投影前重新求值的一次判断。
  ctx.effect(() => installCacheWarmup(ctx as unknown as CacheWarmupContext, {
    // 函数而不是快照：设置卡保存后就地写新值，不重挂插件行。
    settings: () => resolveCacheWarmupSettings(pluginConfig),
    durableHint: (sessionId) => {
      const record = sessionCacheState.read(sessionId)
      if (record === undefined) return undefined
      const total = record.cachedTokens + record.freshTokens
      return {
        lastActiveAt: record.lastActiveAt,
        consecutiveHits: record.warmupConsecutiveHits ?? 0,
        hitRatio: total > 0 ? record.cachedTokens / total : 0,
      }
    },
  }), 'dsh-chatgpt-subscription: cache warmup')

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

    const glmCodingPlanAdapter = new GlmCodingPlanAdapter(
      glmCodingPlanStore,
      glmCodingPlanModelSettings,
      glmCodingPlanPreferences,
      {
        fetchFn: modelFetch[GLM_CODING_PLAN_PROVIDER_ID],
        attachments: ctx.attachments,
        accountPool: glmCodingPlanAccountPool,
      },
    )
    const glmCodingPlanClaim = claimProviderRoute(ctx, {
      providerId: GLM_CODING_PLAN_PROVIDER_ID,
      label: GLM_CODING_PLAN_PROVIDER_NAME,
      adapter: glmCodingPlanAdapter,
    })
    // Registered unconditionally: the card is how a user signs in for the first
    // time, so gating it on winning the route would leave a contested id with no
    // way to configure it at all.
    const disposeGlmCodingPlanRoutes = registerGlmCodingPlanRoutes(
      ctx,
      glmCodingPlanSettingsSource(glmCodingPlanPreferences, glmCodingPlanModelSettings),
      {
        fetchFn: proxyFetch,
        serving: () => glmCodingPlanClaim.serving(),
        conflict: () => glmCodingPlanClaim.conflict(),
        accountPool: glmCodingPlanAccountPool,
      },
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

    // The daily check-in scheduler (official-client recipe; both regions). The
    // host owns the cadence: the startup pass is the daily run, the interval
    // covers a process that survives midnight.
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

    const stepCodeAdapter = new StepCodeAdapter(
      stepCodeStore,
      stepCodeModelSettings,
      stepCodePreferences,
      {
        fetchFn: modelFetch[STEP_CODE_PROVIDER_ID],
        attachments: ctx.attachments,
        accountPool: stepCodeAccountPool,
      },
    )
    const stepCodeClaim = claimProviderRoute(ctx, {
      providerId: STEP_CODE_PROVIDER_ID,
      label: STEP_CODE_PROVIDER_NAME,
      adapter: stepCodeAdapter,
    })
    // Registered unconditionally: the card is how a user signs in for the first
    // time, so gating it on winning the route would leave a contested id with no
    // way to configure it at all.
    const disposeStepCodeRoutes = registerStepCodeRoutes(
      ctx,
      stepCodeSettingsSource(stepCodePreferences, stepCodeModelSettings),
      {
        fetchFn: proxyFetch,
        serving: () => stepCodeClaim.serving(),
        conflict: () => stepCodeClaim.conflict(),
        accountPool: stepCodeAccountPool,
      },
    )

    // Cline Pass: the API-key subscription line. Its stores, pool, engine,
    // adapter and settings routes are assembled inside the line module; this
    // wiring only registers the claim and keeps the disposers together.
    const clinePassLine = createClinePassLine(ctx, {
      fetchFn: proxyFetch,
      modelFetchFn: modelFetch['cline-pass'],
      attachments: ctx.attachments,
    })

    const qoderAdapter = new QoderAdapter(
      qoderStore,
      qoderModelSettings,
      qoderPreferences,
      {
        fetchFn: modelFetch[QODER_PROVIDER_ID],
        attachments: ctx.attachments,
        accountPool: qoderAccountPool,
      },
    )
    const qoderClaim = claimProviderRoute(ctx, {
      providerId: QODER_PROVIDER_ID,
      label: QODER_PROVIDER_NAME,
      adapter: qoderAdapter,
    })
    // Registered unconditionally: the card is how a user signs in for the first
    // time, so gating it on winning the route would leave a contested id with no
    // way to configure it at all.
    const disposeQoderRoutes = registerQoderRoutes(
      ctx,
      qoderSettingsSource(qoderPreferences, qoderModelSettings),
      {
        fetchFn: proxyFetch,
        serving: () => qoderClaim.serving(),
        conflict: () => qoderClaim.conflict(),
        accountPool: qoderAccountPool,
      },
    )
    // 启动时预热 Qoder 的模型目录，跑在插件装载**背后**。
    //
    // 为什么要在启动时预热：进程内的 cachedCatalog 在宿主重启后是空的，可磁盘快照
    // （~/.dsh/storages/qoder-global-catalog.json）里躺着上一次的真实目录。原先唯一
    // 回填它的入口是设置页的 GET /status / 登录 / adopt / POST /catalog/refresh，
    // 于是「重启之后、第一次打开设置页之前」，adapter.listModels 读到的是随包兜底表
    // （全球区 15 条缺省模型），模型选择器先把这一大片假模型摊出来，打开一次设置页
    // 才恢复正常。预热把这段空窗压到进程启动的第一拍（快照是本地读，几十毫秒）。
    //
    // 为什么不能 await：没有快照的机器上，预热就是一次真实的上游请求（COSY 版本 +
    // 签名 + 目录端点，上限 DISCOVERY_TIMEOUT_MS）。await 在装配里等于让整个插件的
    // 装载挂在一条可降级的网络请求上——离线、上游抽风都会变成「插件装不上」，而这条
    // 线路在没有目录时本来就有一张随包兜底表可用。所以：不等待，失败一律吞掉。
    void warmQoderCatalogOnStartup(ctx, {
      fetchFn: proxyFetch,
      accountPool: qoderAccountPool,
    }).catch(() => undefined)

    // OpenDesign: the API-key subscription line. Its stores, pool, adapter and
    // settings routes are assembled inside the line module; this wiring only
    // keeps the disposers together. The live catalog needs no warm-up call here:
    // synced entries persist in the line's own settings document, so a restart
    // rehydrates them from a local read with no network in the path.
    const openDesignLine = createOpenDesignLine(ctx, {
      fetchFn: proxyFetch,
      modelFetchFn: modelFetch['opendesign'],
      attachments: ctx.attachments,
    })

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
    // The widget board's half of this plugin: one widget-type directory, one
    // `line-card` data source and three line capabilities, all registered under
    // one handle that is dropped when this plugin unloads. The board is optional
    // and the service is absent on every host that does not have it, in which
    // case this is a no-op and the plugin behaves exactly as it did before the
    // call existed. The ChatGPT line contributes through `lines` like every other
    // line; there is no ChatGPT-only quota/account source any more, so nothing
    // here has to hand over `usage`, `oauth` or the pool object.
    registerWidgetBoard(ctx as unknown as WidgetBoardContext, {
      // The line registry's line → pool mapping. It lives HERE because this is
      // the one scope that holds every pool; the registry itself imports no
      // concrete pool class and learns a line only through this table. The
      // quota half reaches each line over loopback HTTP through its own route,
      // so the origin is resolved per read rather than captured now: the
      // listener may not have bound a port yet at this point in the load.
      lines: {
        origin: () => webServerOrigin(ctx.webServer),
        pools: {
          codex: codexAccountPool,
          claude: claudeAccountPool,
          'glm-coding-plan': glmCodingPlanAccountPool,
          'step-code': stepCodeAccountPool,
          qoder: qoderAccountPool,
          'cline-pass': clinePassLine.accountPool,
          opendesign: openDesignLine.accountPool,
          'kimi-code': kimiCodeAccountPool,
          'minimax-code': minimaxCodeAccountPool,
          antigravity: antigravityAccountPool,
          'command-code': commandCodeAccountPool,
        },
        // The two lines whose card shows a quota PER ACCOUNT. A pool row carries
        // a snapshot only for the account that was actually read, so on a
        // two-account line the second row had nothing to draw; these clients let
        // the registry ask each account for its own numbers instead.
        //
        // Injected HERE because this is the one scope that holds both clients —
        // the registry itself imports no line, which is what keeps it a
        // description of eleven lines rather than a twelfth implementation.
        // Every other line is absent on purpose and keeps the behaviour it had.
        //
        // Neither client is called with a "force": the registry caches one
        // reading per (line, account) for a minute, and both clients cache too,
        // so a board polling every 60 s costs at most one upstream read per
        // account per minute.
        accountQuotaClients: {
          qoder: async (credentials, { fetchFn, accountId }) => {
            const read = await loadQoderQuota(
              credentials as Parameters<typeof loadQoderQuota>[0],
              {
                fetchFn,
                // The snapshot is remembered against the POOL ACCOUNT, not the
                // line: quota follows the account, and keying it by the line is
                // how one row ends up drawing another row's numbers.
                cacheKey: accountId,
              },
            )
            return read.ok ? read.snapshot : null
          },
          'minimax-code': async (credentials, { fetchFn, accountId }) => await fetchMinimaxTokenPlanQuota(
            credentials as Parameters<typeof fetchMinimaxTokenPlanQuota>[0],
            { fetchFn, accountId },
          ),
        },
      },
    })
    const responses = new ResponsesClient(oauth, ctx.attachments, {
      fetchFn: modelFetch['codex-chatgpt'],
      accountPool: codexAccountPool,
      localRawImages: { baseUrl: webServerOrigin(ctx.webServer) },
      onGenerationFinished: () => usage.invalidate(),
      outputVerbosity: () => preferences.status().outputVerbosity,
      fastMode: () => preferences.status().fastMode,
      reasoningSummary: () => preferences.status().reasoningSummary,
      codexStreamIdleTimeoutMs: pluginConfig.codexStreamIdleTimeoutMs,
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
    // The selection must be computed from the STORED preferences, never from the
    // shipped defaults. Those defaults are exactly what the `web` entry already
    // holds (`deepseek-official` search, `http` fetch), so a pass that runs before
    // the preferences document has hydrated is not merely stale: it agrees with
    // the entry, returns `applied` without writing anything, and leaves DSH's own
    // fetch provider in place with no later event to repair it. That is the state
    // this machine was found in — the user had picked the Codex line and a proxy,
    // every `web_fetch` still failed on the built-in provider's resolve-and-pin
    // step, and the switcher kept reporting `applied` because nothing had ever
    // asked it to look again.
    const applyWebProviders = (): void => {
      void preferences.hydrate().then(() => {
        const current = preferences.status()
        const pluginFetch = proxyManager.resolveActiveProxyUrl() !== null
        return searchSwitcher.select(current.searchProvider, { pluginFetch, fetchProvider: fetchConfiguration.fetchProvider }).then(() => {
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
        })
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

    // Each provider's own "is there a local sign-in to reuse?" answer is its
    // own reader's business: the ChatGPT line stats the Codex CLI credential on
    // its own /status, and the Claude line answers the same question on its own
    // route. Nothing aggregates them here, so no collaborator is threaded through
    // this wiring just to produce a row of stats about someone else's file.
    const disposeRoutes = registerRoutes(
      ctx, oauth, usage, preferences, proxyManager, searchSwitcher, readRouteAudit, codexAccountPool, fetchConfiguration,
      // The one mutable deployment choice this table owns; the object is the
      // writer, so the route cannot store a mode without invalidating the pools.
      { storage: poolStorageSettings })

    // The hub overview's one-request summary of every subscription line. Each
    // line's read closure stays beside the stores it reads; the aggregation
    // module itself learns nothing about how a line stores accounts. All reads
    // are local snapshots — no upstream call is ever triggered by the settings
    // page's opening screen.
    const routable = (accounts: readonly { authStatus?: string }[]): boolean =>
      accounts.some((account) => account.authStatus === undefined || account.authStatus === 'ok')
    // What the overview card's "N/M models" counts. Every line already holds its
    // catalog: Antigravity, Command Code, Kimi Code and Ollama persist the last
    // successful sync in their model settings, while Claude and MiniMax Code
    // keep it in memory. All of these are reads of what the line
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
        id: 'glm-coding-plan',
        providerId: GLM_CODING_PLAN_PROVIDER_ID,
        canToggle: true,
        read: async () => {
          const current = glmCodingPlanPreferences.status()
          const accounts = await glmCodingPlanAccountPool.listAccounts().catch(() => [])
          // This line ships its catalog with the build (the live listing only
          // refreshes the per-account context windows), so the packaged size is
          // the total there is.
          const total = catalogTotal(glmCodingPlanCatalogSize())
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
        id: 'ollama',
        providerId: OLLAMA_PROVIDER_ID,
        canToggle: true,
        read: async () => {
          const accounts = await ollamaAccountPool.listAccounts().catch(() => [])
          const current = await ollamaModelSettings.read()
          const total = catalogTotal(current.catalogModels.length)
          // The selection is a tri-state: null is "no filter" (every synced
          // model), an array is explicit — and an empty one switches all off.
          const selected = current.enabledModelIds === null ? total : current.enabledModelIds.length
          return {
            enabled: current.enabled !== false,
            accountCount: accounts.length,
            authenticated: routable(accounts),
            enabledModelCount: total === null || selected === null ? null : Math.min(selected, total),
            totalModelCount: total,
          }
        },
      },
      {
        id: 'step-code',
        providerId: STEP_CODE_PROVIDER_ID,
        canToggle: true,
        read: async () => {
          const current = stepCodePreferences.status()
          const accounts = await stepCodeAccountPool.listAccounts().catch(() => [])
          // This line ships no model catalog at all (the official one is empty too),
          // so the packaged size is 0 and catalogTotal reports "nothing synced yet"
          // rather than a fabricated count; the real list is discovered at runtime.
          const total = catalogTotal(stepCodeCatalogSize())
          return {
            enabled: current.enabled !== false,
            accountCount: accounts.length,
            authenticated: routable(accounts),
            enabledModelCount: total === null ? null : Math.min(current.enabledModelIds?.length ?? 0, total),
            totalModelCount: total,
          }
        },
      },
      // Cline Pass: appended last, like every line added after the first one, so
      // no existing card position moves.
      clinePassLine.hubSource,
      // Qoder（订阅）：再往后追加一格，既有线路的卡片顺序保持不动。
      {
        id: 'qoder',
        providerId: QODER_PROVIDER_ID,
        canToggle: true,
        read: async () => {
          const current = qoderPreferences.status()
          const accounts = await qoderAccountPool.listAccounts().catch(() => [])
          // 目录与适配器同一个读口（运行时目录优先、随包兜底表垫底）。分子分母必须
          // 取自**同一份**目录：两区的随包表条目数不同（全球区 15、中国站 9），
          // 混用会让卡片显示一个根本不存在的总数。
          const region = accounts.find((account) => account.isPrimary)?.region
            ?? accounts[0]?.region
            ?? 'global'
          const catalog = cachedQoderModelCatalog(region)
          const total = catalogTotal(catalog.length)
          // 勾选是三态：null = 不过滤（可用模型数就是目录总数），数组 = 白名单。
          // 白名单里残留的 id 不算可用——它们在上游已经不存在了，把它们计进分子
          // 会让卡片显示「3/2 个模型可用」。
          //
          // 口径与适配器、状态面**同一处**（convergeQoderSelection）：兜底表阶段不按
          // 白名单筛。否则冷启动时这张卡会说「0 个可用」，而选择器里明明有模型。
          const selected = convergeQoderSelection(
            current.enabledModelIds,
            qoderCatalogIsLive(region),
            catalog,
          )
          return {
            enabled: current.enabled !== false,
            accountCount: accounts.length,
            authenticated: routable(accounts),
            enabledModelCount: total === null
              ? null
              : selected === null
                ? total
                : Math.min(selected.length, total),
            totalModelCount: total,
          }
        },
      },
      // OpenDesign（订阅，API Key）：再往后追加一格，既有线路的卡片顺序保持不动。
      openDesignLine.hubSource,
    ]
    const disposeHubOverview = registerHubOverviewRoutes(ctx, hubSources)
    // 概览页右端的「检测更新 / 更新插件」。注册在这里而不是 routes.ts：它不属于任何
    // 一条订阅线路，而是整页的一个事实。fetch 用宿主的代理 fetch——本部署走本地代理，
    // 裸 fetch 在这里连不上 npm 源；一键安装走宿主的 pluginManager（pnpm），
    // 服务不可用时路由自己降级为「只给命令」。
    const disposeUpdateRoutes = registerUpdateRoutes(ctx, { fetchFn: proxyFetch })
    const disposeAdapter = ctx.llm.registerAdapter([PROVIDER_ID], adapter)
    const disposeImageTool = ctx.tools.register(createCodexImageTool(oauth, ctx.attachments, { fetchFn: proxyFetch }))
    // gemini-3.1-flash-image is served as a tool, not a chat model: the harness
    // accepts text-only assistant output, so only a tool result can carry the image.
    const disposeAntigravityImageTool = ctx.tools.register(createAntigravityImageTool(
      antigravityAccountPool,
      antigravityStore,
      ctx.attachments,
      { fetchFn: proxyFetch, isEnabled: () => antigravityPreferences.status().enabled !== false },
    ))
    // The video ingress for the Kimi route. Registered here because the tool
    // needs the plugin context to resolve the calling session's route before it
    // agrees to attach anything.
    const disposeVideoTool = ctx.tools.register(createKimiVideoTool(ctx, { fetchFn: proxyFetch }))
    // The two media tools for the MiniMax Code route. They ride the Matrix
    // gateway beside the Messages route (host/minimax-code/matrix-client.ts)
    // and present this line's own subscription credential, which is why the
    // pool — not the bare credential store — is what they read: the native
    // ~/.minimax directory this route once shared is gone on a fresh install,
    // and only a pooled account still holds a live session.
    //
    // Both are registered ONLY while this line is enabled. A user who turned the
    // line off never calls either one, yet their schemas cost ≈2000 tokens of
    // context on every request (generate 1442 + understand 571) — 74% of what
    // this plugin's always-on tool list spends, paid by deployments that cannot
    // use it. Registration happens during load and reads the synchronous
    // `status()` snapshot: a registered tool cannot be pulled back out of a
    // conversation's tool list, so the switch takes effect on the next start —
    // the same trade cline-pass/line.ts makes for `exposeTools`. On a harness
    // with no settings seam `status()` answers the shipped default
    // (`enabled: true`) until its disk read lands, which keeps the pre-change
    // behaviour there rather than silently dropping the tools.
    const minimaxMediaToolsEnabled = minimaxCodePreferences.status().enabled
    const disposeMinimaxUnderstandVideoTool = minimaxMediaToolsEnabled
      ? ctx.tools.register(
        createMinimaxUnderstandVideoTool(ctx, { fetchFn: proxyFetch, pool: minimaxCodeAccountPool }),
      )
      : () => undefined
    const disposeMinimaxGenerateVideoTool = minimaxMediaToolsEnabled
      ? ctx.tools.register(
        createMinimaxGenerateVideoTool(ctx, { fetchFn: proxyFetch, pool: minimaxCodeAccountPool }),
      )
      : () => undefined

    // Rebind providers when web reloads    // Rebind providers when web reloads without resetting the saved default provider selection.
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
    // The selection re-reads the hydrated store, so the changed document is what
    // it acts on whether or not the callback's own snapshot is threaded through.
    const disposePreferenceWatch = preferences.watch(() => applyWebProviders())

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

    // Every trigger above is an event this plugin does not own the timing of, and
    // a selection only holds for as long as the loader keeps the config it was
    // written into. Re-check on a timer, which is the one trigger that needs no
    // event at all: it repairs a write a later composition discarded, and it
    // costs a loader scan when nothing drifted.
    const disposeWebProviderReconciler = startWebProviderReconciler({ reconcile: () => applyWebProviders() })

    return () => {
      searchSwitcher.dispose()
      disposeReadyWatch?.()
      disposeProxyWatch()
      disposePreferenceWatch()
      disposeWebProviderReconciler()
      disposeImageTool()
      disposeAntigravityImageTool()
      disposeVideoTool()
      disposeMinimaxUnderstandVideoTool()
      disposeMinimaxGenerateVideoTool()
      disposeAdapter()
      disposeRoutes()
      disposeHubOverview()
      disposeUpdateRoutes()
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
      disposeClaudeRoutes()
      claudeClaim.dispose()
      disposeGlmCodingPlanRoutes()
      glmCodingPlanClaim.dispose()
      oauth.dispose()
      proxyManager.dispose()
      disposeStepCodeRoutes()
      stepCodeClaim.dispose()
      clinePassLine.dispose()
      disposeQoderRoutes()
      qoderClaim.dispose()
      openDesignLine.dispose()
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
export { createAntigravityImageTool } from './host/antigravity/image-tool.ts'
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
export { MinimaxCodeCheckinService } from './host/minimax-code/checkin.ts'
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
// --- GLM（ZCode 账号）-------------------------------------------------------------
export {
  GlmCodingPlanAdapter,
  GLM_CODING_PLAN_RETRY_POLICY_CONFIG,
  GLM_POOL_COOLDOWN_MS,
  buildGlmRequestPlan,
  glmCooldownDecision,
  readGlmResetAt,
  type GlmRequestPlan,
} from './host/glm-coding-plan/adapter.ts'
export {
  GlmAdoptedCredentialRefreshError,
  GlmCodingPlanAccountPool,
  glmCodingPlanPoolIdentity,
  glmCodingPlanPoolPath,
  glmCodingPlanPoolQuota,
  glmCodingPlanPoolStatus,
  parseGlmCodingPlanPoolData,
  type GlmCodingPlanAccountSummary,
  type GlmCodingPlanPoolAccount,
  type GlmCodingPlanPoolStatus,
} from './host/glm-coding-plan/account-pool.ts'
export {
  GLM_CODING_PLAN_PREFERENCES_NAMESPACE,
  GlmCodingPlanCredentialStore,
  GlmCodingPlanModelSettingsStore,
  credentialPath as glmCodingPlanCredentialPath,
  credentialsFromAdopt,
  credentialsFromCliLogin,
  isAdoptedCredential as isAdoptedGlmCodingPlanCredential,
  mergeGlmCodingPlanSettings,
  modelSettingsPath as glmCodingPlanModelSettingsPath,
  parseGlmCodingPlanCredentials,
  registerGlmCodingPlanPreferenceStore,
  type GlmCodingPlanCredentialOrigin,
  type GlmCodingPlanCredentials,
  type GlmCodingPlanModelSettings,
  type GlmCodingPlanPreferenceStore,
  type GlmCodingPlanSettingsPatch,
} from './host/glm-coding-plan/token-store.ts'
export {
  getGlmCodingPlanStatus,
  glmCatalogSize,
  glmCodingPlanSettingsSource,
  glmSubPathOf,
  registerGlmCodingPlanRoutes,
  type GlmCodingPlanRouteOptions,
  type GlmCodingPlanSettingsSource,
} from './host/glm-coding-plan/routes.ts'
export {
  GLM_MODEL_CATALOG,
  GLM_MODEL_IDS,
  catalogModelOptions,
  catalogSize as glmCodingPlanCatalogCount,
  modelsForRegion as glmCodingPlanModelsForRegion,
  resolveGlmModel,
  type GlmModelEntry as GlmCodingPlanModelEntry,
} from './host/glm-coding-plan/model-catalog.ts'
export {
  PROVIDER_ID as GLM_CODING_PLAN_ROUTE_PROVIDER_ID,
  PROVIDER_NAME as GLM_CODING_PLAN_ROUTE_PROVIDER_NAME,
  QUOTA_WINDOW_MINUTES as GLM_CODING_PLAN_QUOTA_WINDOW_MINUTES,
  authorizeUrl as glmCodingPlanAuthorizeUrl,
  convergeGlmEffort,
  isGlmReasoningEffort,
  normalizeRegion as normalizeGlmCodingPlanRegion,
} from './host/glm-coding-plan/types.ts'
export {
  adoptZcodeSignIn as adoptGlmZcodeSignIn,
  isAdoptedZcodeCredential as isAdoptedGlmZcodeCredential,
  zcodeCredentialsPath,
} from './host/glm-coding-plan/adopt.ts'
export {
  fetchGlmQuota,
  getCachedQuota as getCachedGlmCodingPlanQuota,
  loadCatalog as loadGlmCodingPlanCatalog,
  verifyCodingPlanKey as verifyGlmCodingPlanKey,
} from './host/glm-coding-plan/client.ts'
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
  resolveMinimaxCodeModelId,
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

// --- Step Code（Step Plan 订阅）---------------------------------------------------
export {
  StepCodeAdapter,
  STEP_CODE_POOL_COOLDOWN_MS,
  STEP_CODE_RETRY_POLICY_CONFIG,
  cachedStepCodeModelCatalog,
  readStepCodeCacheStats,
  rememberStepCodeCacheUsage,
  stepCodeCatalogSize,
  stepCodeModelCatalogFrom,
  type StepCodeAdapterOptions,
  type StepCodePickedCredential,
} from './host/step-code/adapter.ts'
export {
  StepCodeAccountPool,
  StepCodeCredentialRefreshError,
  stepCodePoolIdentity,
  stepCodePoolPath,
  stepCodePoolQuota,
  stepCodePoolStatus,
  stepCodePoolStatusSlice,
  type StepCodePoolAccount,
  type StepCodePoolStatus,
} from './host/step-code/account-pool.ts'
export {
  getStepCodeStatus,
  registerStepCodeRoutes,
  stepCodeSettingsSource,
  stepCodeSubPathOf,
  type StepCodePoolSlice,
  type StepCodeRouteOptions,
  type StepCodeSettingsSource,
  type StepCodeStatusSources,
} from './host/step-code/routes.ts'
export {
  StepCodeCredentialStore,
  StepCodeModelSettingsStore,
  StepCodeQuotaCredentialStore,
  credentialPath as stepCodeCredentialPath,
  modelSettingsPath as stepCodeModelSettingsPath,
  quotaCredentialPath as stepCodeQuotaCredentialPath,
  registerStepCodePreferenceStore,
  type StepCodeCredentials,
  type StepCodeModelSettings,
  type StepCodePreferenceStore,
  type StepCodeQuotaCredential,
  type StepCodeSettingsPatch,
} from './host/step-code/token-store.ts'
export {
  STEP_CODE_PROVIDER_ID,
  STEP_CODE_PROVIDER_NAME,
  STEP_CODE_ROUTE_PREFIX,
  STEP_CODE_PROFILES,
  type StepCodeAccountSummaryDto,
  type StepCodeAdoptResultDto,
  type StepCodeCacheStatsDto,
  type StepCodeConnectionDto,
  type StepCodeLoginFlowStatus,
  type StepCodeModelOption,
  type StepCodeProfile,
  type StepCodeQuotaSnapshotDto,
  type StepCodeReasoningEffort,
  type StepCodeStatusDto,
} from './shared/step-code-contracts.ts'
// --- Cline Pass（API Key 订阅线路）------------------------------------------------
export {
  ClinePassAdapter,
  type ClinePassAdapterOptions,
} from './host/cline-pass/adapter.ts'
export {
  ClinePassEngine,
  type ClinePassAccount,
  type ClinePassAttemptOutcome,
  type ClinePassEngineOptions,
} from './host/cline-pass/engine.ts'
export {
  CLINE_PASS_API_KEY_ENV,
  ClinePassAccountPool,
  clinePassAccountKey,
  clinePassPoolPath,
  parseClinePassPoolData,
  type ClinePassPoolAccount,
} from './host/cline-pass/account-pool.ts'
export {
  CLINE_PASS_ROUTES,
  getClinePassWebStatus,
  registerClinePassRoutes,
  type ClinePassRouteOptions,
} from './host/cline-pass/routes.ts'
export {
  ClinePassModelSettingsStore,
  FileCredentialStore as ClinePassCredentialStore,
  credentialPath as clinePassCredentialPath,
  modelSettingsPath as clinePassModelSettingsPath,
  parseClinePassCredentials,
  parseClinePassModelSettings,
  type ClinePassCatalogModel,
  type ClinePassCredentials,
  type ClinePassModelSettings,
  type ClinePassPreferenceStore,
} from './host/cline-pass/token-store.ts'
export {
  createClinePassLine,
  clinePassKnownModelIds,
  clinePassVisibleModelIds,
  type ClinePassLine,
  type ClinePassLineOptions,
} from './host/cline-pass/line.ts'
export { createClinePassStore, type ClinePassStore } from './host/cline-pass/store.ts'
export {
  chatCompletion as clinePassChatCompletion,
  chatURL as clinePassChatURL,
  fetchGatewayCatalog as fetchClinePassGatewayCatalog,
  fetchOfficialModels as fetchClinePassOfficialModels,
  fetchUsageLimits as fetchClinePassUsageLimits,
  openChatStream as openClinePassChatStream,
  sendJSON as sendClinePassJSON,
  trimBase as trimClinePassBase,
  type ClinePassHttpResult,
  type ClinePassRawUsageLimit,
} from './host/cline-pass/client.ts'
export {
  buildClinePassBody,
  mapFinishReason,
  mapUsage,
  parseServerSentEvents,
  reasoningOf,
  serializeMessages,
  streamErrorCode,
  translate,
  type ClinePassWireBody,
  type ClinePassWireMessage,
} from './host/cline-pass/mapper.ts'
export {
  CHANNEL_ALIASES,
  buildAttempts,
  channelNameFor,
  classifyUpstreamError,
  extractAvailableProviders,
  injectPrefs,
  isAdherenceOk,
  mergeUpstreams,
  normalizePinMode,
  normalizeSort,
  parseRouting,
  parseTier0,
  pinAdherence,
  pinWarnings,
  type PinAttempt,
  type PinConfig,
  type RoutingFacts,
} from './host/cline-pass/protocol.ts'
export {
  DEFAULT_BASE_URL as CLINE_PASS_DEFAULT_BASE_URL,
  DEFAULT_MODELS as CLINE_PASS_DEFAULT_MODELS,
  MAX_UPSTREAMS as CLINE_PASS_MAX_UPSTREAMS,
  MODEL_CATALOG as CLINE_PASS_MODEL_CATALOG,
  POOL_COOLDOWN_MS as CLINE_PASS_POOL_COOLDOWN_MS,
  REASONING_EFFORTS as CLINE_PASS_REASONING_EFFORTS,
  catalogEntry as clinePassCatalogEntry,
  defaultPin as clinePassDefaultPin,
  type ClinePassConnection,
  type ClinePassModelInfo,
  type ClinePassModelMeta,
  type ClinePassPinSettings,
  type ClinePassReasoningEffort,
} from './host/cline-pass/types.ts'
export {
  CLINE_PASS_PROVIDER_ID as CLINE_PASS_ROUTE_PROVIDER_ID,
  CLINE_PASS_PROVIDER_NAME as CLINE_PASS_ROUTE_PROVIDER_NAME,
  CLINE_PASS_ROUTE_PREFIX,
  clinePassAccountQuota,
  clinePassWindowDurationMins,
  clinePassWindowLabel,
  isClinePassPinMode,
  type ClinePassAccountAction,
  type ClinePassAccountSummaryDto,
  type ClinePassAttemptTraceDto,
  type ClinePassAuthResult,
  type ClinePassChannelVerdictDto,
  type ClinePassHistoryRowDto,
  type ClinePassModelDto,
  type ClinePassPinMode,
  type ClinePassPoolStatusDto,
  type ClinePassProbeResultDto,
  type ClinePassSettingsDto,
  type ClinePassSettingsUpdateDto,
  type ClinePassTestResultDto,
  type ClinePassUsageAccountDto,
  type ClinePassUsageDto,
  type ClinePassUsageWindowDto,
  type ClinePassValidateResultDto,
  type ClinePassWebStatus,
} from './shared/cline-pass-contracts.ts'

export {
  QoderAdapter,
  QODER_POOL_COOLDOWN_MS,
  QODER_RETRY_POLICY_CONFIG,
  cachedQoderModelCatalog,
  qoderCatalogSize,
  readQoderCacheStats,
  rememberQoderCacheUsage,
  type QoderAdapterOptions,
  type QoderPickedCredential,
} from './host/qoder/adapter.ts'
export {
  QoderAccountPool,
  qoderPoolIdentity,
  qoderPoolPath,
  qoderPoolQuota,
  qoderPoolStatus,
  qoderPoolStatusSlice,
  qoderRefreshFailureStatus,
  type QoderPoolAccount,
  type QoderPoolStatus,
} from './host/qoder/account-pool.ts'
export {
  getQoderStatus,
  qoderSettingsSource,
  qoderSubPathOf,
  registerQoderRoutes,
  warmQoderCatalogOnStartup,
  type QoderPoolSlice,
  type QoderRouteOptions,
  type QoderSettingsSource,
  type QoderStatusSources,
} from './host/qoder/routes.ts'
export {
  QoderCredentialStore,
  QoderModelSettingsStore,
  credentialPath as qoderCredentialPath,
  modelSettingsPath as qoderModelSettingsPath,
  parseQoderCredentials,
  qoderCredentialsExpireAt,
  qoderCredentialsNeedRefresh,
  registerQoderPreferenceStore,
  type QoderCredentials,
  type QoderModelSettings,
  type QoderPreferenceStore,
  type QoderSettingsPatch,
} from './host/qoder/token-store.ts'
export {
  QODER_PROVIDER_ID,
  QODER_PROVIDER_NAME,
  QODER_ROUTE_PREFIX,
  QODER_REGIONS,
  type QoderAccountSummaryDto,
  type QoderAdoptResultDto,
  type QoderCacheStatsDto,
  type QoderConnectionDto,
  type QoderLoginFlowStatus,
  type QoderModelOption,
  type QoderQuotaSnapshotDto,
  type QoderReasoningEffort,
  type QoderRegion,
  type QoderStatusDto,
} from './shared/qoder-contracts.ts'
export {
  OpenDesignAdapter,
  REASONING_EFFORT_IDS as OPENDESIGN_REASONING_EFFORT_IDS,
  type OpenDesignAdapterOptions,
} from './host/opendesign/adapter.ts'
export {
  OpenDesignAccountPool,
  OPENDESIGN_API_KEY_ENV,
  opendesignAccountKey,
  opendesignPoolPath,
  parseOpenDesignPoolData,
  type OpenDesignAccountPoolOptions,
  type OpenDesignPoolAccount,
  type OpenDesignPoolStatusDto,
} from './host/opendesign/account-pool.ts'
export {
  resolveModelInfo as resolveOpenDesignModelInfo,
  resolveOutputBudget as resolveOpenDesignOutputBudget,
} from './host/opendesign/catalog.ts'
export {
  chatURL as openDesignChatURL,
  fetchGatewayCatalog as fetchOpenDesignGatewayCatalog,
  firstMessage as openDesignFirstMessage,
  modelsURL as openDesignModelsURL,
  openChatStream as openOpenDesignChatStream,
  sendJSON as sendOpenDesignJSON,
  testApiKey as testOpenDesignApiKey,
  trimBase as trimOpenDesignBase,
  withTimeout as withOpenDesignTimeout,
  type OpenDesignHttpResult,
} from './host/opendesign/client.ts'
export {
  buildOpenDesignBody,
  isAuthenticationError as isOpenDesignAuthenticationError,
  mapFinishReason as mapOpenDesignFinishReason,
  mapUsage as mapOpenDesignUsage,
  NO_ANSWER_PHRASE as OPENDESIGN_NO_ANSWER_PHRASE,
  parseServerSentEvents as parseOpenDesignServerSentEvents,
  reasoningOf as openDesignReasoningOf,
  serializeMessages as serializeOpenDesignMessages,
  streamErrorCode as openDesignStreamErrorCode,
  translate as translateOpenDesignStream,
  type OpenDesignWireBody,
  type OpenDesignWireMessage,
} from './host/opendesign/mapper.ts'
export {
  getOpenDesignWebStatus,
  OPENDESIGN_ROUTES,
  registerOpenDesignRoutes,
  type OpenDesignRouteOptions,
} from './host/opendesign/routes.ts'
export {
  bearerFor as openDesignBearerFor,
  credentialPath as openDesignCredentialPath,
  credentialsIdentity as openDesignCredentialsIdentity,
  defaultOpenDesignModelSettings,
  FileCredentialStore as OpenDesignCredentialStore,
  modelSettingsPath as openDesignModelSettingsPath,
  OpenDesignModelSettingsStore,
  parseOpenDesignCredentials,
  parseOpenDesignModelSettings,
  type OpenDesignApiKeyCredentials,
  type OpenDesignCatalogModel,
  type OpenDesignCredentials,
  type OpenDesignModelSettings,
  type OpenDesignPreferenceStore,
} from './host/opendesign/token-store.ts'
export {
  createOpenDesignLine,
  openDesignKnownModelIds,
  openDesignVisibleModelIds,
  type OpenDesignLine,
  type OpenDesignLineOptions,
} from './host/opendesign/line.ts'
export {
  catalogEntry as openDesignCatalogEntry,
  DEFAULT_BASE_URL as OPENDESIGN_DEFAULT_BASE_URL,
  DEFAULT_CONTEXT_WINDOW as OPENDESIGN_DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_CONCURRENT_REQUESTS as OPENDESIGN_DEFAULT_MAX_CONCURRENT_REQUESTS,
  DEFAULT_MAX_TOKENS as OPENDESIGN_DEFAULT_MAX_TOKENS,
  DEFAULT_MODELS as OPENDESIGN_DEFAULT_MODELS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS as OPENDESIGN_DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  MODEL_CATALOG as OPENDESIGN_MODEL_CATALOG,
  MODEL_PRICES_URL as OPENDESIGN_MODEL_PRICES_URL,
  POOL_COOLDOWN_MS as OPENDESIGN_POOL_COOLDOWN_MS,
  PROVIDER_ID as OPENDESIGN_HOST_PROVIDER_ID,
  PROVIDER_NAME as OPENDESIGN_HOST_PROVIDER_NAME,
  type OpenDesignDiscoveredModel,
  type OpenDesignModelInfo,
  type OpenDesignModelMeta,
} from './host/opendesign/types.ts'
export {
  OPENDESIGN_CONSOLE_URL,
  OPENDESIGN_PROVIDER_ID,
  OPENDESIGN_PROVIDER_NAME,
  OPENDESIGN_ROUTE_PREFIX,
  type OpenDesignAccountAction,
  type OpenDesignAccountSummaryDto,
  type OpenDesignAuthResult,
  type OpenDesignModelDto,
  type OpenDesignModelPricingDto,
  type OpenDesignPoolStatusDto as OpenDesignPoolStatusDtoContract,
  type OpenDesignSettingsDto,
  type OpenDesignSettingsUpdateDto,
  type OpenDesignWebStatus,
} from './shared/opendesign-contracts.ts'
