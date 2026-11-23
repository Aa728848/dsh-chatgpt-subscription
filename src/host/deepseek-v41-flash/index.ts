/**
 * DeepSeek V4.1 Flash（含 1017 快照）专属运行时优化总成。
 *
 * 在“不降低有效思考深度、尽量完整保留 1M 上下文”的前提下，将四项顺应
 * arXiv:2609.19969 物理架构的保护机制统一挂载到宿主平面：
 *
 * 1. **静态思考与工程纪律段**（`discipline.ts`）：仅向 V4.1 Flash 会话注入逐字节恒定
 *    的精简指引（以查代想、PTC/批处理减噪、防自反馈空转、遵循状态锚），0% 破缓存。
 * 2. **Append-Only 128-token SWA 状态锚 + Effort 缓存诊断**（`state-anchor.ts`）：
 *    在长步周期（每 10 步）、上下文水位跨越（180K/350K/550K/750K）或连续工具失败时，
 *    于尾部追加 ≤ 110 tokens 的高对比度状态锚，落入 FP8 SWA 窗口对抗长任务漂移；
 *    并在长上下文中途切换 `reasoningEffort` 时发出 50x 破缓存诊断告警。
 * 3. **入库前自描述观测头 + 官方线路失控提醒**（`observation-tagger.ts`）：
 *    在根级大块文本观测首次写入历史前前置单行 `[OBS | ...]` 索引头，增强 CED 静态
 *    编码与 CSA2 FP4 块索引的远距召回；仅为官方线路 V4.1 Flash 补齐温和失控提醒。
 * 4. **仅限 V4.1 Flash 的无损双信号推理坍塌守卫**（复用 `reasoning-collapse-guard`）：
 *    不设硬性思考字数上限，仅在 N-gram 唯一性与跨句语义回环双信号连续确认时精准
 *    止损 1017 自反馈复读死循环，并无损续接。
 *
 * ## 绝对隔离保证
 *
 * 全部四个子能力均通过 {@link isDeepSeekV41Flash} 严格门控：任何其它线路与任何其它
 * 模型（包括 `deepseek-v4-pro`、`deepseek-v4-flash`、Qoder `DeepSeek-Flash`、
 * Claude、GPT、Kimi、MiniMax、GLM、Qwen 等）均 100% 旁路，零字节改动、零行为变化。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/host/deepseek-v41-flash
 */
import {
  installReasoningCollapseGuard,
  type GuardOptions,
  type GuardStreamOptions,
  type ReasoningCollapseContext,
} from '../reasoning-collapse-guard/index.ts'
import {
  DEEPSEEK_V41_FLASH_DISCIPLINE_SECTION,
  DEEPSEEK_V41_FLASH_DISCIPLINE_TEXT,
  installDeepSeekV41FlashDiscipline,
} from './discipline.ts'
import {
  DEEPSEEK_OFFICIAL_PROVIDERS,
  isDeepSeekV41Flash,
  isDeepSeekV41FlashScope,
  isDeepSeekV41FlashSession,
  readScopeRoute,
  readSessionRoute,
  type DetectedRoute,
} from './match.ts'
import {
  DEEPSEEK_V41_FLASH_RUNAWAY_SOURCE_KIND,
  OBSERVATION_HEADER_PREFIX,
  OBSERVATION_TAG_MIN_CHARS,
  OBSERVATION_TAG_TOOLS,
  buildObservationHeader,
  installDeepSeekV41FlashObservationTagger,
  summarizeToolTarget,
} from './observation-tagger.ts'
import {
  ANCHOR_CONSECUTIVE_ERROR_THRESHOLD,
  ANCHOR_CONTEXT_WATERMARKS,
  ANCHOR_STEP_INTERVAL,
  DEEPSEEK_V41_FLASH_ANCHOR_PREFIX,
  DEEPSEEK_V41_FLASH_ANCHOR_SOURCE_KIND,
  EFFORT_DRIFT_WARN_MIN_TOKENS,
  compactGoalSummary,
  defaultEstimateContextTokens,
  installDeepSeekV41FlashStateAnchor,
  renderStateAnchorText,
  type StateAnchorOptions,
} from './state-anchor.ts'

export {
  ANCHOR_CONSECUTIVE_ERROR_THRESHOLD,
  ANCHOR_CONTEXT_WATERMARKS,
  ANCHOR_STEP_INTERVAL,
  DEEPSEEK_OFFICIAL_PROVIDERS,
  DEEPSEEK_V41_FLASH_ANCHOR_PREFIX,
  DEEPSEEK_V41_FLASH_ANCHOR_SOURCE_KIND,
  DEEPSEEK_V41_FLASH_DISCIPLINE_SECTION,
  DEEPSEEK_V41_FLASH_DISCIPLINE_TEXT,
  DEEPSEEK_V41_FLASH_RUNAWAY_SOURCE_KIND,
  EFFORT_DRIFT_WARN_MIN_TOKENS,
  OBSERVATION_HEADER_PREFIX,
  OBSERVATION_TAG_MIN_CHARS,
  OBSERVATION_TAG_TOOLS,
  buildObservationHeader,
  compactGoalSummary,
  defaultEstimateContextTokens,
  installDeepSeekV41FlashDiscipline,
  installDeepSeekV41FlashObservationTagger,
  installDeepSeekV41FlashStateAnchor,
  isDeepSeekV41Flash,
  isDeepSeekV41FlashScope,
  isDeepSeekV41FlashSession,
  readScopeRoute,
  readSessionRoute,
  renderStateAnchorText,
  summarizeToolTarget,
}
export type { DetectedRoute, StateAnchorOptions }

/** 插件配置中控制 DeepSeek V4.1 Flash 专属优化的 volatile 字段形状。 */
export interface DeepSeekV41FlashConfigFields {
  readonly deepseekV41FlashOptimization?: boolean | { get(): boolean | undefined } | undefined
}

/** 从插件配置（兼容 volatile 活引用与普通布尔值）读取开关；默认开启。 */
export function resolveDeepSeekV41FlashOptimizationEnabled(
  config?: DeepSeekV41FlashConfigFields,
): boolean {
  const field = config?.deepseekV41FlashOptimization
  if (field !== null && typeof field === 'object') {
    try {
      return field.get() !== false
    } catch {
      return true
    }
  }
  return field !== false
}

/** DeepSeek V4.1 Flash 专属优化总成配置。 */
export interface DeepSeekV41FlashOptimizationOptions {
  /** 总开关（活引用读取器）；返回 false 时全部子能力立刻旁路。默认 true。 */
  readonly enabled?: () => boolean
  /** 工具失控提醒开关（默认跟随主插件 `toolRunawayGuard`）。 */
  readonly runawayEnabled?: () => boolean
  /** 若宿主已安装全局 `reasoningCollapseGuard`，置 true 以避免双层叠加。 */
  readonly skipCollapseGuard?: boolean
  /** 仅针对 V4.1 Flash 的推理坍塌守卫微调项（可选）。 */
  readonly collapseGuardOptions?: Omit<GuardOptions, 'matchRequest'>
  /** 状态锚微调项（可选，便于单测）。 */
  readonly stateAnchorOptions?: Omit<StateAnchorOptions, 'enabled'>
  /** 观测打标最小字符阈值（可选，便于单测）。 */
  readonly observationMinChars?: number
}

/** 已安装句柄。 */
export interface DeepSeekV41FlashOptimizationHandle {
  dispose(): void
}

function readAgentProviderFromContext(ctx: unknown, sessionId: string | undefined): string | undefined {
  if (sessionId === undefined || typeof ctx !== 'object' || ctx === null) return undefined
  const host = ctx as { get?(name: string): unknown; agents?: { get?(id: unknown): unknown } }
  try {
    const registry = typeof host.get === 'function' ? host.get('agents') : undefined
    if (registry !== null && typeof registry === 'object' && typeof (registry as { get?: unknown }).get === 'function') {
      const agent = (registry as { get(id: unknown): unknown }).get(sessionId)
      const provider = readScopeRoute(agent).provider
      if (provider !== undefined) return provider
    }
  } catch {
    // 忽略未注入或老代宿主缺失。
  }
  try {
    const agent = host.agents?.get?.(sessionId)
    return readScopeRoute(agent).provider
  } catch {
    return undefined
  }
}

/**
 * 安装 DeepSeek V4.1 Flash 专属运行时优化总成。
 *
 * @param ctx - 宿主上下文（跨代结构探测）。
 * @param options - 开关与可选覆盖。
 * @returns 可幂等释放的句柄。
 */
export function installDeepSeekV41FlashOptimizations(
  ctx: unknown,
  options: DeepSeekV41FlashOptimizationOptions = {},
): DeepSeekV41FlashOptimizationHandle {
  const enabled = (): boolean => {
    if (options.enabled === undefined) return true
    try {
      return options.enabled() !== false
    } catch {
      return false
    }
  }

  const disposers: Array<() => void> = []

  disposers.push(installDeepSeekV41FlashDiscipline(ctx, { enabled }))
  disposers.push(installDeepSeekV41FlashStateAnchor(ctx, {
    ...options.stateAnchorOptions,
    enabled,
  }))
  disposers.push(installDeepSeekV41FlashObservationTagger(ctx, {
    enabled,
    ...(options.runawayEnabled === undefined ? {} : { runawayEnabled: options.runawayEnabled }),
    ...(options.observationMinChars === undefined ? {} : { minChars: options.observationMinChars }),
  }))

  if (options.skipCollapseGuard !== true) {
    const disposeCollapse = installReasoningCollapseGuard(ctx as ReasoningCollapseContext, {
      ...options.collapseGuardOptions,
      matchRequest: (request: GuardStreamOptions): boolean => {
        if (!enabled()) return false
        const provider = request.provider ?? readAgentProviderFromContext(ctx, request.sessionId)
        return isDeepSeekV41Flash(request.model, provider)
      },
    })
    if (disposeCollapse !== undefined) disposers.push(disposeCollapse)
  }

  let disposed = false
  return {
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose()
        } catch {
          // 卸载期忽略单点失败。
        }
      }
    },
  }
}
