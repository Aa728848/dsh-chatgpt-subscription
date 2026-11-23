/**
 * DeepSeek V4.1 Flash 专属静态思考与工程纪律段。
 *
 * 依据 arXiv:2609.19969 与 DeepSeek-V4.1-Flash-1017 行为特征设计：
 * - Decode（含 `<think>`）激活 16B 参数且输出单价为缓存命中的 200x：鼓励“以查代想”，
 *   避免把可 1 秒实证的事实拖成冗长的脑内推演；
 * - CSA2 分层稀疏索引的粗排候选池上限固定（2,048 块 = 16,384 位置）：鼓励用
 *   PTC / Code Mode / 并行只读批量收束噪声，保持 1M 上下文的高信噪比；
 * - 1017 自反馈 RL 在约束模糊时容易反复推翻自己：明确退出条件与连败切换纪律，
 *   不阉割有效深度思考，只遏制原地空转。
 *
 * ## 绝对隔离与缓存不变量
 *
 * 1. 仅在 `isDeepSeekV41FlashScope(scope, context.modelSelection)` 为真时注入；
 *    其它任何线路与任何其它模型收到原对象引用，0 字节改动。
 * 2. 正文是编译期常量（`interpolate: false`），同一会话从第 1 步到末尾逐字节恒定，
 *    零前缀缓存抖动。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/host/deepseek-v41-flash/discipline
 */
import { isDeepSeekV41FlashScope } from './match.ts'

/** 注入到系统提示词中的分节名（全局唯一）。 */
export const DEEPSEEK_V41_FLASH_DISCIPLINE_SECTION = 'plugin:deepseek-v41-flash-discipline'

/**
 * 逐字节恒定的 V4.1 Flash 执行与思考纪律文本（~160 tokens）。
 *
 * 刻意保持精简与高对比度结构（适应 FP4 KV 量化与稀疏块索引），不随时间、步数
 * 或工具列表变化。
 */
export const DEEPSEEK_V41_FLASH_DISCIPLINE_TEXT = [
  '## Execution & Reasoning Discipline (DeepSeek V4.1 Flash)',
  '',
  '- **Verify over speculate**: For any fact checkable locally (file contents, exact line numbers, types, schemas, error traces, test results), inspect via tools instead of simulating across long internal deliberation. Reserve deep reasoning for architecture trade-offs, root-cause synthesis, and edge-case verification.',
  '- **Batch & filter noise**: When reading multiple files, searching symbols, or inspecting large logs, prefer one programmatic batch (`code_run` / `run_code`) or parallel read-only calls returning only concise structured evidence (paths, line ranges, concrete values, failures). Keep raw log spam out of the conversation context.',
  '- **Prevent self-feedback loops**: Once you have a clear plan or verified evidence, act immediately instead of re-deriving settled facts. If two consecutive attempts in the same direction add no new evidence or hit the same error, switch to minimal reproduction or inspect the underlying definition rather than repeating the call.',
  '- **Stay anchored & exit cleanly**: Follow `[V4.1-Flash State Anchor]` notices to keep the primary goal and invariants intact across long sessions. Deliver as soon as the task acceptance criteria are verified; avoid unrequested refactors.',
].join('\n')

interface AssembledSectionLike {
  readonly name?: unknown
  readonly text?: unknown
  readonly interpolate?: unknown
}

interface PresentationLike {
  readonly sections?: readonly AssembledSectionLike[]
  readonly [key: string]: unknown
}

interface AssembleContextLike {
  readonly scope?: unknown
  readonly agent?: unknown
  readonly modelSelection?: unknown
}

interface EventHostLike {
  on?(name: string, listener: (...args: never[]) => unknown, options?: unknown): unknown
  off?(name: string, listener: (...args: never[]) => unknown): unknown
}

export interface DisciplineGuardOptions {
  /** 活引用读取器；返回 false 时彻底旁路。默认 true。 */
  readonly enabled?: () => boolean
}

function isEnabled(read: (() => boolean) | undefined): boolean {
  if (read === undefined) return true
  try {
    return read() !== false
  } catch {
    return false
  }
}

function subscribeAssemble(
  host: EventHostLike | undefined,
  listener: (
    assembly: PresentationLike,
    context: AssembleContextLike,
    next: () => Promise<PresentationLike>,
  ) => Promise<PresentationLike>,
): (() => void) | undefined {
  if (typeof host?.on !== 'function') return undefined
  const attempts: readonly unknown[] = [{ global: true }, undefined]
  for (const options of attempts) {
    try {
      const handle = options === undefined
        ? host.on('system-prompt/assemble', listener as never)
        : host.on('system-prompt/assemble', listener as never, options)
      if (typeof handle === 'function') return handle as () => void
      if (handle !== null && typeof handle === 'object' && typeof (handle as { dispose?: unknown }).dispose === 'function') {
        return () => { (handle as { dispose(): void }).dispose() }
      }
      return () => {
        try {
          host.off?.('system-prompt/assemble', listener as never)
        } catch {
          // 忽略已移除的监听器。
        }
      }
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * 安装仅对 DeepSeek V4.1 Flash 生效的静态纪律段注入器。
 *
 * @param ctx - 宿主上下文（结构探测）。
 * @param options - 开关选项。
 * @returns 清理函数；宿主不支持事件总线时返回空操作。
 */
export function installDeepSeekV41FlashDiscipline(
  ctx: unknown,
  options: DisciplineGuardOptions = {},
): () => void {
  const host = typeof ctx === 'object' && ctx !== null ? (ctx as EventHostLike) : undefined
  let disposed = false

  const onAssemble = async (
    _assembly: PresentationLike,
    context: AssembleContextLike,
    next: () => Promise<PresentationLike>,
  ): Promise<PresentationLike> => {
    const result = await next()
    if (disposed || !isEnabled(options.enabled)) return result
    const scope = context?.scope ?? context?.agent
    if (!isDeepSeekV41FlashScope(scope, context?.modelSelection)) return result
    const sections = Array.isArray(result?.sections) ? result.sections : undefined
    if (sections === undefined) return result
    if (sections.some(section => section?.name === DEEPSEEK_V41_FLASH_DISCIPLINE_SECTION)) return result

    const entry: AssembledSectionLike = {
      name: DEEPSEEK_V41_FLASH_DISCIPLINE_SECTION,
      text: DEEPSEEK_V41_FLASH_DISCIPLINE_TEXT,
      interpolate: false,
    }
    const warmupIndex = sections.findIndex(section => section?.name === 'plugin:cache-warmup')
    const nextSections = warmupIndex >= 0
      ? [...sections.slice(0, warmupIndex + 1), entry, ...sections.slice(warmupIndex + 1)]
      : [...sections, entry]
    return { ...result, sections: nextSections }
  }

  const off = subscribeAssemble(host, onAssemble)
  return () => {
    if (disposed) return
    disposed = true
    try {
      off?.()
    } catch {
      // 卸载期忽略单点失败。
    }
  }
}
