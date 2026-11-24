/**
 * DeepSeek V4.1 Flash 专属静态思考、工程与输出可读性纪律段。
 *
 * 依据 arXiv:2609.19969、DeepSeek-V4.1-Flash-1017 行为特征，以及 OpenAI Codex /
 * Anthropic Claude Code 的输出可读性工程实践设计：
 * - Decode（含 `<think>`）激活 16B 参数且输出单价为缓存命中的 200x：鼓励“以查代想”，
 *   避免把可 1 秒实证的事实拖成冗长的脑内推演；
 * - CSA2 分层稀疏索引的粗排候选池上限固定（2,048 块 = 16,384 位置）：鼓励用
 *   PTC / Code Mode / 并行只读批量收束噪声，保持 1M 上下文的高信噪比；
 * - 1017 自反馈 RL 在约束模糊时容易反复推翻自己：明确退出条件与连败切换纪律，
 *   不阉割有效深度思考，只遏制原地空转；
 * - 1017 的输出长度压缩与 DeepSeek 默认排版倾向容易造成“电报体压缩串、连环括号、
 *   满屏加粗列表、深层嵌套、宽表格拥挤与工具流水账”：用正向、克制、本身即示范
 *   清爽散文排版的规则引导最终面向人类的输出（避免系统提示词自身带加粗列表腔而
 *   被模型镜像），同时明确不降低内部思考深度。
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
 * 注入分节的恒定排序值：高于宿主最大内置分节 `DEPLOYMENT_PERSONA_SUFFIX` (10200)，
 * 保证经 `comparePromptSections` 排序后仍落于系统提示词末尾，且跨步数恒定不触发增量更新。
 */
export const DEEPSEEK_V41_FLASH_DISCIPLINE_ORDER = 20_000

/**
 * 逐字节恒定的 V4.1 Flash 执行、思考与输出可读性纪律文本（~310 tokens）。
 *
 * 刻意避免在规则正文里使用密集的 `- **加粗**:` 列表，防止模型通过格式镜像把高噪声
 * 加粗列表复制到面向用户的回复中；不随时间、步数或工具列表变化。
 */
export const DEEPSEEK_V41_FLASH_DISCIPLINE_TEXT = [
  '## DeepSeek V4.1 Flash Execution & Output Guidance',
  '',
  '### Execution and reasoning',
  'Verify locally checkable facts—file contents, line numbers, types, schemas, error traces, and test outcomes—through tools instead of speculating across long internal deliberation. Reserve deep reasoning for architecture trade-offs, root-cause synthesis, and edge-case checks.',
  '',
  'When inspecting multiple files, searching symbols, or reading large logs, prefer one programmatic batch (`code_run` / `run_code`) or parallel read-only calls that return concise structured evidence rather than raw log dumps.',
  '',
  'Act as soon as you have a clear plan or verified evidence instead of re-deriving settled facts. If two consecutive attempts in the same direction add no new evidence or hit the same error, switch to minimal reproduction or inspect the underlying definition. Follow `[V4.1-Flash State Anchor]` notices to stay on the primary goal, and deliver once acceptance criteria are verified.',
  '',
  '### Readable final responses',
  'Write final answers for comfortable human reading in the same language the user used, without reducing internal reasoning depth.',
  '',
  'Lead with the direct conclusion or outcome in one or two complete sentences, then organize supporting details by importance. Scale the structure to the task: keep brief answers as short plain paragraphs without unnecessary headings or bullet walls, and use short `##` / `###` headings only when a longer explanation genuinely spans distinct topics.',
  '',
  'Use clear, complete sentences with natural transitions instead of telegraphic chains packed with arrows, slashes, or stacked parentheticals. Limit each sentence to at most one brief parenthetical note, keep paragraphs to roughly 3–4 lines, and leave a blank line around headings, lists, and fenced code blocks.',
  '',
  'Use formatting sparingly. Reserve bold for occasional genuine emphasis—never bold every bullet lead-in, full sentences, or inline code spans. Keep lists flat (at most two levels deep, 3–6 concise items per group). Use Markdown tables only for compact multi-column comparisons (2–4 short columns), never for multi-sentence prose. Summarize tool work by outcome and verified evidence rather than narrating every read or command, and cite paths or symbols instead of pasting long unmodified code blocks.',
].join('\n')

interface AssembledSectionLike {
  readonly name?: unknown
  readonly order?: unknown
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
      order: DEEPSEEK_V41_FLASH_DISCIPLINE_ORDER,
      text: DEEPSEEK_V41_FLASH_DISCIPLINE_TEXT,
      interpolate: false,
    }
    // 始终追加在系统提示词末尾：
    // 1. 不移动前方人设、工具说明与 `tools:sdk`，最大化前缀缓存共享；
    // 2. 紧接对话历史之前，显著提升可读性与执行纪律的遵循度。
    return { ...result, sections: [...sections, entry] }
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
