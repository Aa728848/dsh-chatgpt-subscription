/**
 * DeepSeek V4.1 Flash 专属入库前“自描述观测头”与官方线路失控提醒。
 *
 * ## 论文机制对应（arXiv:2609.19969）
 *
 * 1. **对抗 CED 单向静态编码 & CSA2 FP4 8-token 块检索漏召回**：
 *    20 层 Causal Encoder 编码历史工具结果时并不知道几十轮后会被如何检索，
 *    且全局 KV 经 FP4 (E2M1) 量化并受限于 2,048 块粗排候选池。在根级大块
 *    工具结果（≥ 1,200 字符）**首次写入历史之前**（`tools/post-execute`），
 *    于首行前置一行 ~15–20 tokens 的高对比度结构化元数据头：
 *    `[OBS | tool=<name> | target=<summary> | status=ok|error]`
 *    不裁剪、不改写正文，也不事后回改历史（0% 破前缀缓存），为稀疏索引器提供
 *    清晰可命中的倒排语义锚。
 * 2. **绝不触碰 PTC / Code Mode 内部结构化 `value`**：
 *    当 `exec.parent !== undefined`（嵌套子调用）或 `decision.value !== undefined`
 *    （结构化值返回）时彻底放行，保证程序化执行返回值类型 100% 不受影响。
 * 3. **官方 DeepSeek 线路的失控提醒补齐**：
 *    `CONTROLLED_PROVIDERS` 已由共享 `installKimiRepeatBreaker` 覆盖；官方内置的
 *    `deepseek-official` / `deepseek-account` 线路不在其中。本模块复用共享
 *    `createToolRunawayGuard` 仅为官方线路上的 V4.1 Flash 提供温和分级提醒
 *    （绝不强停、绝不重复提醒已受控线路）。
 *
 * ## 绝对隔离
 *
 * 非 DeepSeek V4.1 Flash 会话立即原样返回 `decision` 引用，零改动、零分配。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/host/deepseek-v41-flash/observation-tagger
 */
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  createToolRunawayGuard,
  observationFromToolExecution,
  type ToolRunawayGuard,
  type ToolRunawayReminder,
} from '../../common/tool-runaway.ts'
import { DEEPSEEK_OFFICIAL_PROVIDERS, isDeepSeekV41Flash, readScopeRoute } from './match.ts'

/** 观测头前缀（用于幂等防重复）。 */
export const OBSERVATION_HEADER_PREFIX = '[OBS | '

/** 触发前置自描述观测头的最小文本字符数（小结果直接可见，无需加头占空间）。 */
export const OBSERVATION_TAG_MIN_CHARS = 1200

/** 允许加自描述观测头的根级高噪声/长文工具集合。 */
export const OBSERVATION_TAG_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'grep',
  'glob',
  'bash',
  'win_bash',
  'pwsh',
  'run_code',
  'code_run',
  'web_fetch',
  'web_search',
  'job_output',
  'cache_warmup_result',
])

/** 官方 DeepSeek V4.1 Flash 失控提醒的来源 kind。 */
export const DEEPSEEK_V41_FLASH_RUNAWAY_SOURCE_KIND = 'deepseek-v41-flash-runaway'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 仅针对官方 DeepSeek 线路 V4.1 Flash 的工具失控温和提醒。 */
    'deepseek-v41-flash-runaway': { kind: 'deepseek-v41-flash-runaway' } & { form?: 'notice'; summary?: string }
  }
}

interface EventHostLike {
  on?(name: string, listener: (...args: never[]) => unknown, options?: unknown): unknown
  off?(name: string, listener: (...args: never[]) => unknown): unknown
}

export interface ObservationTaggerOptions {
  /** 活引用读取器；返回 false 时彻底旁路。默认 true。 */
  readonly enabled?: () => boolean
  /** 工具失控提醒开关（复用主插件 `toolRunawayGuard` 活引用）。默认 true。 */
  readonly runawayEnabled?: () => boolean
  /** 最小打标字符阈值（测试可覆写，默认 1200）。 */
  readonly minChars?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isEnabled(read: (() => boolean) | undefined): boolean {
  if (read === undefined) return true
  try {
    return read() !== false
  } catch {
    return false
  }
}

function compactSingleLine(value: string, maxChars: number): string {
  const cleaned = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (cleaned.length <= maxChars) return cleaned
  return cleaned.slice(0, maxChars - 3).trimEnd() + '...'
}

/** 从工具入参提取紧凑目标标签，用于生成高对比度观测头。 */
export function summarizeToolTarget(toolName: string, args: unknown): string | undefined {
  if (!isRecord(args)) return undefined
  for (const key of ['path', 'file_path', 'filePath', 'url', 'query', 'pattern', 'description', 'command', 'refId']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      const normalized = key.toLowerCase().includes('path') ? value.replace(/\\/g, '/') : value
      const limit = key === 'command' || key === 'description' ? 60 : 80
      return compactSingleLine(normalized, limit)
    }
  }
  if (toolName === 'read' && typeof args['offset'] === 'number') {
    return `offset=${args['offset']}`
  }
  return undefined
}

/** 构造单行自描述观测头。 */
export function buildObservationHeader(toolName: string, args: unknown, isError: boolean): string {
  const target = summarizeToolTarget(toolName, args)
  const parts = [`tool=${toolName}`]
  if (target !== undefined) parts.push(`target=${target}`)
  parts.push(`status=${isError ? 'error' : 'ok'}`)
  return `${OBSERVATION_HEADER_PREFIX}${parts.join(' | ')}]`
}

function totalTextChars(blocks: readonly ContentBlock[]): number {
  let sum = 0
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') sum += block.text.length
  }
  return sum
}

function prependHeaderToBlocks(blocks: readonly ContentBlock[], header: string): ContentBlock[] | undefined {
  const firstTextIdx = blocks.findIndex(block => block.type === 'text' && typeof block.text === 'string' && block.text.length > 0)
  if (firstTextIdx < 0) return undefined
  const first = blocks[firstTextIdx] as { type: 'text'; text: string }
  if (first.text.startsWith(OBSERVATION_HEADER_PREFIX)) return undefined
  const next = [...blocks]
  next[firstTextIdx] = { ...first, text: `${header}\n${first.text}` }
  return next
}

function createRunawayReminderMessage(reminder: ToolRunawayReminder): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: reminder.text }],
    source: {
      kind: DEEPSEEK_V41_FLASH_RUNAWAY_SOURCE_KIND,
      form: 'notice',
      summary: 'DeepSeek V4.1 Flash runaway reminder',
    },
  })
}

function subscribe(
  host: EventHostLike | undefined,
  event: string,
  listener: (...args: never[]) => unknown,
): (() => void) | undefined {
  if (typeof host?.on !== 'function') return undefined
  const attempts: readonly unknown[] = [{ global: true }, undefined]
  for (const options of attempts) {
    try {
      const handle = options === undefined
        ? host.on(event, listener)
        : host.on(event, listener, options)
      if (typeof handle === 'function') return handle as () => void
      if (handle !== null && typeof handle === 'object' && typeof (handle as { dispose?: unknown }).dispose === 'function') {
        return () => { (handle as { dispose(): void }).dispose() }
      }
      return () => {
        try {
          host.off?.(event, listener)
        } catch {
          // 忽略已移除监听。
        }
      }
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * 安装仅对 DeepSeek V4.1 Flash 生效的入库前自描述观测头与官方线路失控提醒器。
 */
export function installDeepSeekV41FlashObservationTagger(
  ctx: unknown,
  options: ObservationTaggerOptions = {},
): () => void {
  const host = typeof ctx === 'object' && ctx !== null ? (ctx as EventHostLike) : undefined
  const minChars = Math.max(1, options.minChars ?? OBSERVATION_TAG_MIN_CHARS)
  const runawayGuards = new Map<string, ToolRunawayGuard>()
  let disposed = false

  const guardFor = (sessionId: string): ToolRunawayGuard => {
    let guard = runawayGuards.get(sessionId)
    if (guard === undefined) {
      guard = createToolRunawayGuard()
      runawayGuards.set(sessionId, guard)
    }
    return guard
  }

  const onPostExecute = async (
    exec: ToolExecution,
    result: Readonly<ToolExecutionResult>,
    next: () => Promise<PostToolDecision>,
  ): Promise<PostToolDecision> => {
    const decision = await next()
    if (disposed || !isEnabled(options.enabled)) return decision
    if (decision.kind !== 'accept') return decision

    // 嵌套在 PTC / Code Mode 脚本内部的子调用绝不改写，保证脚本拿到原始结构化值。
    if ((exec as { parent?: unknown })?.parent !== undefined) return decision

    const route = readScopeRoute(exec.agent)
    if (!isDeepSeekV41Flash(route.model, route.provider)) return decision

    let nextDecision: PostToolDecision = decision

    // 1. 若面向模型的文本块达到阈值且 decision 未携带互斥的 `value`，前置单行自描述索引头。
    if (
      OBSERVATION_TAG_TOOLS.has(exec.name)
      && (decision as { value?: unknown }).value === undefined
    ) {
      const blocks = decision.content ?? result.content
      if (Array.isArray(blocks) && blocks.length > 0 && totalTextChars(blocks) >= minChars) {
        const header = buildObservationHeader(exec.name, exec.arguments, result.isError === true)
        const tagged = prependHeaderToBlocks(blocks, header)
        if (tagged !== undefined) {
          nextDecision = {
            kind: 'accept',
            content: tagged,
            ...(decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts }),
          }
        }
      }
    }

    // 2. 仅为官方 DeepSeek 第一方线路补齐失控提醒（其它受控线路已由共享守卫覆盖）。
    if (
      isEnabled(options.runawayEnabled)
      && route.provider !== undefined
      && DEEPSEEK_OFFICIAL_PROVIDERS.has(route.provider.trim().toLowerCase())
      && route.sessionId !== undefined
    ) {
      const guard = guardFor(route.sessionId)
      const observation = observationFromToolExecution(exec.name, exec.arguments, result)
      const reminder = guard.observe(observation)
      if (reminder !== undefined) {
        const notice = createRunawayReminderMessage(reminder)
        const additionalContexts = nextDecision.additionalContexts === undefined
          ? [notice]
          : [...nextDecision.additionalContexts, notice]
        nextDecision = {
          ...nextDecision,
          additionalContexts,
        } as PostToolDecision
      }
    }

    return nextDecision
  }

  const onPreStep = async (
    payload: { readonly agent?: unknown; readonly messages?: readonly unknown[]; readonly modelSelection?: unknown },
    next: () => Promise<unknown>,
  ): Promise<unknown> => {
    const decision = await next()
    if (disposed) return decision
    const route = readScopeRoute(payload?.agent, payload?.modelSelection)
    if (
      route.sessionId !== undefined
      && route.provider !== undefined
      && DEEPSEEK_OFFICIAL_PROVIDERS.has(route.provider.trim().toLowerCase())
      && isDeepSeekV41Flash(route.model, route.provider)
    ) {
      const messages = Array.isArray(payload?.messages) ? payload.messages : []
      const hasRealUser = messages.some(msg => isRecord(msg) && msg['role'] === 'user' && !(isRecord(msg['source']) && msg['source']['form'] === 'notice'))
      if (hasRealUser) {
        runawayGuards.get(route.sessionId)?.reset()
      }
    }
    return decision
  }

  const onDisposed = (payload: { readonly agent?: unknown } | undefined): void => {
    const route = readScopeRoute(payload?.agent)
    if (route.sessionId !== undefined) runawayGuards.delete(route.sessionId)
  }

  const offPost = subscribe(host, 'tools/post-execute', onPostExecute as never)
  const offPreStep = subscribe(host, 'agent/pre-step', onPreStep as never)
  const offDisposed = subscribe(host, 'agent/disposed', onDisposed as never)

  return () => {
    if (disposed) return
    disposed = true
    for (const off of [offPost, offPreStep, offDisposed]) {
      try {
        off?.()
      } catch {
        // 忽略卸载期单点异常。
      }
    }
    runawayGuards.clear()
  }
}
