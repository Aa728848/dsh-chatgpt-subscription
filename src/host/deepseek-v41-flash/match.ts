/**
 * DeepSeek V4.1 Flash 模型精准识别与跨代路由提取。
 *
 * 本模块是所有 DeepSeek V4.1 Flash 专属优化的唯一准入门：
 * 只有真正在跑 DeepSeek V4.1 Flash（含 1017 快照、eco / fast 变体，以及
 * 官方线路的 `deepseek-flash` 别名）的请求/会话才会返回 `true`；其余任何线路、
 * 任何其他模型（包括 `deepseek-v4-pro`、`deepseek-v4-flash`、Qoder 下的老
 * `DeepSeek-Flash`、Claude、GPT、Kimi、MiniMax、GLM、Qwen 等）一律返回 `false`。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/host/deepseek-v41-flash/match
 */

/** DeepSeek 官方第一方线路 ID（其目录中 `deepseek-flash` 明确指向 DeepSeek-V4.1-Flash）。 */
export const DEEPSEEK_OFFICIAL_PROVIDERS: ReadonlySet<string> = new Set([
  'deepseek-official',
  'deepseek-account',
  'deepseek',
])

/**
 * 匹配任意命名空间下显式标明 V4.1 Flash 的裸模型名：
 * - `deepseek-v4.1-flash` / `deepseek-v4.1-flash-1017` / `deepseek-v4.1-flash-eco` / `deepseek-v4.1-flash-fast`
 * - `deepseek-v4p1-flash-1017`（部分网关 VMC/私有路由写法）
 * - `deepseek_v4_1_flash` / `public_model_deepseek_v4_1_flash`
 *
 * 刻意不匹配：`deepseek-v4-flash`（旧一代 V4 Flash）、`deepseek-v4-pro`、`deepseek-chat`、`deepseek-reasoner`。
 */
const EXPLICIT_V41_FLASH_PATTERN = /^(?:public[-_.]model[-_.])?deepseek[-_.]?v4(?:[._p]|[-_])1[-_.]?flash(?:[-_.]|$)/i

/** 官方第一方线路上代表 DeepSeek-V4.1-Flash 的标准别名。 */
const OFFICIAL_FLASH_ALIAS_PATTERN = /^deepseek[-_.]?flash(?:[-_.]1017)?$/i

/** 从可能带命名空间前缀的模型 ID 中取出最后一段裸名。 */
function bareModelId(model: string): string {
  const trimmed = model.trim()
  const slash = trimmed.lastIndexOf('/')
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed
}

/**
 * 判断一次请求或会话是否运行在 DeepSeek V4.1 Flash 上。
 *
 * - 任意 provider 下，显式 V4.1 Flash 模型 ID 均命中；
 * - 裸别名 `deepseek-flash` 仅在 DeepSeek 官方第一方线路上命中，避免误伤
 *   第三方线路里仍指向旧代 `DeepSeek-V4-Flash` 的同名别名（例如 Qoder）。
 *
 * @param model - 模型 ID。
 * @param provider - 可选的 provider ID。
 * @returns 确认为 DeepSeek V4.1 Flash 时返回 `true`。
 */
export function isDeepSeekV41Flash(model: unknown, provider?: unknown): boolean {
  if (typeof model !== 'string') return false
  const bare = bareModelId(model)
  if (bare.length === 0) return false
  if (EXPLICIT_V41_FLASH_PATTERN.test(bare)) return true
  if (typeof provider === 'string' && DEEPSEEK_OFFICIAL_PROVIDERS.has(provider.trim().toLowerCase())) {
    return OFFICIAL_FLASH_ALIAS_PATTERN.test(bare)
  }
  return false
}

/** 一次会话/作用域可探测到的完整路由信息。 */
export interface DetectedRoute {
  readonly provider?: string
  readonly model?: string
  readonly sessionId?: string
  readonly reasoningEffort?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readEffort(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

/**
 * 从会话对象（`Session`）读取路由元数据。
 *
 * 按可靠性顺序读取：`requestHeader().config` → 扁平字段。
 * 每步独立容错，不依赖任何单一 harness 代次类型。
 */
export function readSessionRoute(session: unknown): DetectedRoute {
  if (!isRecord(session)) return {}
  let provider: string | undefined
  let model: string | undefined
  let reasoningEffort: string | undefined
  const requestHeader = session['requestHeader']
  if (typeof requestHeader === 'function') {
    try {
      const header = requestHeader.call(session)
      if (isRecord(header)) {
        const config = header['config']
        if (isRecord(config)) {
          provider = nonEmptyString(config['provider'])
          model = nonEmptyString(config['model'])
          reasoningEffort = readEffort(config['reasoningEffort'])
        }
      }
    } catch {
      // 老代宿主没有 requestHeader 或会话已关闭：静默回退。
    }
  }
  provider ??= nonEmptyString(session['provider'])
  model ??= nonEmptyString(session['model'])
  reasoningEffort ??= readEffort(session['reasoningEffort'])
  const header = isRecord(session['header']) ? session['header'] : undefined
  const sessionId = nonEmptyString(header?.['id']) ?? nonEmptyString(session['id'])
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

/**
 * 从 `agent` / `scope` / `AssembleContext` 跨代读取完整路由。
 *
 * 优先级（与 `ptc-sdk-cache-guard` / `compaction-policy-guard` 对齐）：
 * 1. 显式传入的 `modelSelection`（当步已锁定的选择，覆盖首步与刚切模型瞬间）；
 * 2. `scope.model.current()`（agent 自己的模型选择读面，反映 pending ?? lastUsed）；
 * 3. `scope.session.requestHeader().config`（已落盘的请求头快照）；
 * 4. `scope.options` 与裸字段兜底。
 */
export function readScopeRoute(scope: unknown, modelSelection?: unknown): DetectedRoute {
  let provider: string | undefined
  let model: string | undefined
  let sessionId: string | undefined
  let reasoningEffort: string | undefined

  const absorb = (candidate: unknown): void => {
    if (!isRecord(candidate)) return
    provider ??= nonEmptyString(candidate['provider'])
    model ??= nonEmptyString(candidate['model'])
    reasoningEffort ??= readEffort(candidate['reasoningEffort'])
  }

  absorb(modelSelection)

  if (isRecord(scope)) {
    const modelService = scope['model']
    if (isRecord(modelService) && typeof modelService['current'] === 'function') {
      try {
        absorb((modelService['current'] as () => unknown).call(modelService))
      } catch {
        // 忽略读取失败。
      }
    }

    const sessionRoute = readSessionRoute(scope['session'])
    provider ??= sessionRoute.provider
    model ??= sessionRoute.model
    sessionId ??= sessionRoute.sessionId
    reasoningEffort ??= sessionRoute.reasoningEffort

    absorb(scope['options'])
    absorb(scope['config'])
    absorb(scope)
    sessionId ??= nonEmptyString(scope['id'])
  }

  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

/** 快捷判断：给定 scope/agent（及可选当步 `modelSelection`）是否为 DeepSeek V4.1 Flash。 */
export function isDeepSeekV41FlashScope(scope: unknown, modelSelection?: unknown): boolean {
  const route = readScopeRoute(scope, modelSelection)
  return isDeepSeekV41Flash(route.model, route.provider)
}

/** 快捷判断：给定 session 对象是否为 DeepSeek V4.1 Flash。 */
export function isDeepSeekV41FlashSession(session: unknown): boolean {
  const route = readSessionRoute(session)
  return isDeepSeekV41Flash(route.model, route.provider)
}
