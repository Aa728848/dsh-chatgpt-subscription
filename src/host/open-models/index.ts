/**
 * 开源模型运行时专项优化总成（Kimi K3/K3.1、GLM-5.x、DeepSeek-V4 Pro/Flash、
 * MiniMax M3/M3.1/M2.7、Qwen 3.5–4、Step 3.5–5、MiMo V2.6、Ling 3.1、Hunyuan Hy4、
 * LongCat 2.0 及 Ollama 本地推理模型）。
 *
 * 采用「共享物理架构积木 + 模型手术刀级专属补丁」两层设计：
 *
 * 1. **静态尾部纪律段**（`discipline.ts`）：按模型家族追加在系统提示词末尾，0% 破前缀缓存；
 * 2. **零改前缀尾部状态锚**（`state-anchor.ts`）：按架构阵营（混合线性/块稀疏/短窗 SWA）
 *    在步频、水位或连败节点于尾部追加 ≤ 105 tokens 状态锚；
 * 3. **入库前观测头 + Kimi 只读空转提醒 + ESC ANSI 清洗 + 非受控失控提醒**（`observation-guard.ts`）；
 * 4. **按模型精准门控的无损双信号推理坍塌守卫**（复用 `reasoning-collapse-guard`）。
 *
 * 严格排除 DeepSeek V4.1 Flash（由 `src/host/deepseek-v41-flash/` 独立负责）与全部闭源模型
 * （Claude / GPT-5 / GPT-6 / Gemini / Grok）。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/host/open-models
 */
import {
  installReasoningCollapseGuard,
  type GuardOptions,
  type GuardStreamOptions,
  type ReasoningCollapseContext,
} from '../reasoning-collapse-guard/index.ts'
import { readScopeRoute } from '../deepseek-v41-flash/match.ts'
import { installOpenModelDiscipline, type OpenModelDisciplineOptions } from './discipline.ts'
import {
  OPEN_MODEL_GUARD_NOTICE_SOURCE_KIND,
  READ_ONLY_SPIN_HIGH_CONTEXT_TOKENS,
  installOpenModelObservationGuard,
  stripEscAnsiSequences,
  type OpenModelObservationGuardOptions,
} from './observation-guard.ts'
import {
  OPEN_MODEL_PROFILES,
  bareOpenModelId,
  isDeepSeekV4NonV41Model,
  isGlm5OpenModel,
  isKimiK31OpenModel,
  isKimiOpenModel,
  isLongSparseOpenModel,
  isMimoOpenModel,
  isMinimaxOpenModel,
  isOpenModelCacheWarmupProtected,
  isOpenModelPrefixCacheProtected,
  isOpenModelSessionPrefixCacheProtected,
  isQwenOpenModel,
  isStepOpenModel,
  matchOpenModelProfile,
  matchOpenModelScope,
  matchOpenModelSession,
  type AttentionArchitectureCamp,
  type OpenModelFamily,
  type OpenModelProfile,
} from './profiles.ts'
import {
  OPEN_MODEL_ANCHOR_PREFIX,
  OPEN_MODEL_ANCHOR_SOURCE_KIND,
  OPEN_MODEL_CONSECUTIVE_ERROR_THRESHOLD,
  installOpenModelStateAnchor,
  renderOpenModelStateAnchorText,
  type OpenModelStateAnchorOptions,
} from './state-anchor.ts'

export {
  OPEN_MODEL_ANCHOR_PREFIX,
  OPEN_MODEL_ANCHOR_SOURCE_KIND,
  OPEN_MODEL_CONSECUTIVE_ERROR_THRESHOLD,
  OPEN_MODEL_GUARD_NOTICE_SOURCE_KIND,
  OPEN_MODEL_PROFILES,
  READ_ONLY_SPIN_HIGH_CONTEXT_TOKENS,
  bareOpenModelId,
  installOpenModelDiscipline,
  installOpenModelObservationGuard,
  installOpenModelStateAnchor,
  isDeepSeekV4NonV41Model,
  isGlm5OpenModel,
  isKimiK31OpenModel,
  isKimiOpenModel,
  isLongSparseOpenModel,
  isMimoOpenModel,
  isMinimaxOpenModel,
  isOpenModelCacheWarmupProtected,
  isOpenModelPrefixCacheProtected,
  isOpenModelSessionPrefixCacheProtected,
  isQwenOpenModel,
  isStepOpenModel,
  matchOpenModelProfile,
  matchOpenModelScope,
  matchOpenModelSession,
  renderOpenModelStateAnchorText,
  stripEscAnsiSequences,
}
export type {
  AttentionArchitectureCamp,
  OpenModelDisciplineOptions,
  OpenModelFamily,
  OpenModelObservationGuardOptions,
  OpenModelProfile,
  OpenModelStateAnchorOptions,
}

/** 插件配置中控制开源模型专项优化总成的 volatile 字段形状。 */
export interface OpenModelsOptimizationConfigFields {
  readonly openModelsOptimization?: boolean | { get(): boolean | undefined } | undefined
}

/** 从插件配置（兼容 volatile 活引用与普通布尔值）读取开关；默认开启。 */
export function resolveOpenModelsOptimizationEnabled(
  config?: OpenModelsOptimizationConfigFields,
): boolean {
  const field = config?.openModelsOptimization
  if (field !== null && typeof field === 'object') {
    try {
      return field.get() !== false
    } catch {
      return true
    }
  }
  return field !== false
}

/** 开源模型运行时专项优化总成选项。 */
export interface OpenModelsOptimizationOptions {
  /** 总开关活引用；返回 false 时全部子能力立即旁路。默认 true。 */
  readonly enabled?: () => boolean
  /** 工具失控与只读空转提醒开关（默认跟随主插件 `toolRunawayGuard`）。 */
  readonly runawayEnabled?: () => boolean
  /** 若宿主已显式启用全局 `reasoningCollapseGuard`，置 true 避免双层叠加。 */
  readonly skipCollapseGuard?: boolean
  /** 可选推理坍塌守卫微调项。 */
  readonly collapseGuardOptions?: Omit<GuardOptions, 'matchRequest'>
  /** 可选状态锚微调项（测试用）。 */
  readonly stateAnchorOptions?: Omit<OpenModelStateAnchorOptions, 'enabled'>
  /** 可选观测头最小字符阈值（测试用）。 */
  readonly observationMinChars?: number
  /** 可选上下文 token 估算函数（测试用）。 */
  readonly estimateContextTokens?: (agent: unknown, observedChars: number) => number
}

/** 已安装句柄。 */
export interface OpenModelsOptimizationHandle {
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
    // 忽略。
  }
  try {
    const agent = host.agents?.get?.(sessionId)
    return readScopeRoute(agent).provider
  } catch {
    return undefined
  }
}

/**
 * 安装面向全部主力开源模型的运行时专项优化总成。
 */
export function installOpenModelsOptimizations(
  ctx: unknown,
  options: OpenModelsOptimizationOptions = {},
): OpenModelsOptimizationHandle {
  const enabled = (): boolean => {
    if (options.enabled === undefined) return true
    try {
      return options.enabled() !== false
    } catch {
      return false
    }
  }

  const disposers: Array<() => void> = []

  disposers.push(installOpenModelDiscipline(ctx, { enabled }))
  disposers.push(installOpenModelStateAnchor(ctx, {
    ...options.stateAnchorOptions,
    ...(options.estimateContextTokens === undefined ? {} : { estimateContextTokens: options.estimateContextTokens }),
    enabled,
  }))
  disposers.push(installOpenModelObservationGuard(ctx, {
    enabled,
    ...(options.runawayEnabled === undefined ? {} : { runawayEnabled: options.runawayEnabled }),
    ...(options.observationMinChars === undefined ? {} : { minChars: options.observationMinChars }),
    ...(options.estimateContextTokens === undefined ? {} : { estimateContextTokens: options.estimateContextTokens }),
  }))

  if (options.skipCollapseGuard !== true) {
    const disposeCollapse = installReasoningCollapseGuard(ctx as ReasoningCollapseContext, {
      ...options.collapseGuardOptions,
      matchRequest: (request: GuardStreamOptions): boolean => {
        if (!enabled()) return false
        const provider = request.provider ?? readAgentProviderFromContext(ctx, request.sessionId)
        return matchOpenModelProfile(request.model, provider)?.collapseGuard === true
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
