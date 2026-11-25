/**
 * DeepSeek V4.1 Flash 进展治理：识别“没有新证据、修改或任务完成”的长程空转并分级纠偏。
 *
 * 与推理坍塌守卫互补：后者识别重复或回环的推理文本，这里不看文本是否重复，只看行动是否推进。
 * 不设全局思考上限：只有在已经提醒过且此后仍无进展时，单次超长推理才会被截断并续接。
 * 最后一级要求模型就具体阻塞点向用户提问，而不是继续空转或把未完成的工作当作完成交付。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/host/deepseek-v41-flash/progress-governor
 */
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { PLUGIN_MESSAGE_SOURCE_KIND } from '../../common/llm-compat.ts'
import {
  resolveRegisteredAgent,
  type GuardAgentLike,
  type ReasoningCollapseContext,
} from '../reasoning-collapse-guard/index.ts'
import { isDeepSeekV41Flash, readScopeRoute } from './match.ts'
import { isRealUserMessage } from './state-anchor.ts'

/** 进展检查通知的固定开头。 */
export const DEEPSEEK_V41_FLASH_PROGRESS_PREFIX = '[V4.1-Flash Progress Check'

/** 一、二、三级干预对应的无进展步数门槛。 */
export const PROGRESS_STEP_THRESHOLDS: readonly [number, number, number] = Object.freeze([6, 10, 14] as const)

/** 一、二、三级干预对应的无进展累计推理字符门槛。 */
export const PROGRESS_REASONING_CHAR_THRESHOLDS: readonly [number, number, number] = Object.freeze([24_000, 48_000, 80_000] as const)

/** 已停滞时，单次推理超过该字符数即截断续接。 */
export const PROGRESS_STREAM_CUT_CHARS = 32_000

/** 一次用户请求内最多截断的次数。 */
const DEFAULT_MAX_STREAM_CUTS = 2
/** 一次用户请求内最多发出的进展通知数。 */
const DEFAULT_MAX_NOTICES = 6
/** 记住的证据指纹上限。 */
const MAX_EVIDENCE = 256
/** 参数与结果参与指纹计算的最大字符数。 */
const MAX_FINGERPRINT_CHARS = 32_768

/** 成功即视为实质修改的工具。 */
const MUTATING_TOOL = /^(?:edit|write|multi_?edit|apply_patch|notebook_edit|str_replace\w*|create_file|delete_file|rename_file|move_file)$/
/** 返回用户输入的工具：得到回答即视为新信息。 */
const USER_INPUT_TOOLS: ReadonlySet<string> = new Set(['ask_user_question', 'ask_user', 'request_user_input', 'exit_plan_mode'])
/** 不代表任务推进、也不计入证据的协调类工具。 */
const IGNORED_TOOLS: ReadonlySet<string> = new Set(['progress_update', 'dispatch_ledger', 'code_tools_list', 'code_tools_search', 'code_tools_describe'])

type Level = 0 | 1 | 2 | 3

export interface ProgressGovernorOptions {
  /** 活引用开关；返回 false 时完全旁路。 */
  readonly enabled?: () => boolean
  /** 三级无进展步数门槛（严格递增）。 */
  readonly stepThresholds?: readonly [number, number, number]
  /** 三级无进展累计推理字符门槛（严格递增）。 */
  readonly reasoningCharThresholds?: readonly [number, number, number]
  /** 已停滞时单次推理的截断门槛。 */
  readonly streamCutChars?: number
  /** 一次用户请求内最多截断次数。 */
  readonly maxStreamCutsPerRequest?: number
  /** 一次用户请求内最多通知次数。 */
  readonly maxNoticesPerRequest?: number
}

interface GovernorState {
  stepsSinceProgress: number
  reasoningSinceProgress: number
  level: Level
  deliveredLevel: Level
  noticesThisRequest: number
  cutsThisRequest: number
  evidence: Map<string, true>
  todoStatuses: Map<string, string>
}

interface StreamRequestLike {
  readonly provider?: string | undefined
  readonly model?: string | undefined
  readonly sessionId?: string | undefined
  readonly purpose?: string | undefined
}

interface StreamChunkLike {
  readonly type?: string
  readonly text?: string | undefined
}

interface HostLike extends ReasoningCollapseContext {
  off?(name: string, listener: (...args: never[]) => unknown): unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function assertThresholds(name: string, value: readonly number[]): void {
  if (value.length !== 3 || value.some(item => !Number.isInteger(item) || item < 1) || !(value[0]! < value[1]! && value[1]! < value[2]!)) {
    throw new Error(`progress-governor: ${name} must be three strictly increasing positive integers`)
  }
}

function assertPositive(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`progress-governor: ${name} must be an integer >= 1`)
}

function createState(): GovernorState {
  return {
    stepsSinceProgress: 0,
    reasoningSinceProgress: 0,
    level: 0,
    deliveredLevel: 0,
    noticesThisRequest: 0,
    cutsThisRequest: 0,
    evidence: new Map(),
    todoStatuses: new Map(),
  }
}

function markProgress(state: GovernorState): void {
  state.stepsSinceProgress = 0
  state.reasoningSinceProgress = 0
  state.level = 0
  state.deliveredLevel = 0
}

/** 截断过长文本，保留首尾，让指纹对超大输出仍然稳定。 */
function boundText(text: string): string {
  if (text.length <= MAX_FINGERPRINT_CHARS) return text
  const half = MAX_FINGERPRINT_CHARS / 2
  return `${text.slice(0, half)}\u0000${text.length}\u0000${text.slice(-half)}`
}

function stableStringify(value: unknown, depth = 0): string {
  if (depth > 6) return '"…"'
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item, depth + 1)).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key], depth + 1)}`).join(',')}}`
  }
  if (typeof value === 'bigint') return value.toString()
  try {
    return JSON.stringify(value) ?? 'null'
  } catch {
    return 'null'
  }
}

function resultText(result: unknown): string {
  if (!isRecord(result)) return ''
  const parts: string[] = []
  if (Array.isArray(result['content'])) {
    for (const block of result['content']) {
      if (isRecord(block) && typeof block['text'] === 'string') parts.push(block['text'])
    }
  }
  if (result['value'] !== undefined) parts.push(stableStringify(result['value']))
  return parts.join('\n')
}

/** FNV-1a 32 位摘要：只用于判断“是否见过”，不承担安全用途。 */
function digest(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36) + ':' + text.length.toString(36)
}

function todoProgress(state: GovernorState, args: unknown): boolean {
  if (!isRecord(args) || !Array.isArray(args['todos'])) return false
  const next = new Map<string, string>()
  let progressed = false
  for (const todo of args['todos']) {
    if (!isRecord(todo) || typeof todo['content'] !== 'string' || typeof todo['status'] !== 'string') continue
    if (todo['status'] === 'completed' && state.todoStatuses.get(todo['content']) !== 'completed') progressed = true
    next.set(todo['content'], todo['status'])
  }
  state.todoStatuses = next
  return progressed
}

/** 一次成功工具调用是否推进了任务。 */
function classifyProgress(state: GovernorState, name: string, args: unknown, result: unknown): boolean {
  if (USER_INPUT_TOOLS.has(name)) return true
  if (name === 'todo_write') return todoProgress(state, args)
  if (MUTATING_TOOL.test(name)) return true
  const fingerprint = `${name}\u0000${digest(boundText(stableStringify(args)))}\u0000${digest(boundText(resultText(result)))}`
  if (state.evidence.has(fingerprint)) {
    state.evidence.delete(fingerprint)
    state.evidence.set(fingerprint, true)
    return false
  }
  state.evidence.set(fingerprint, true)
  if (state.evidence.size > MAX_EVIDENCE) {
    const oldest = state.evidence.keys().next().value
    if (oldest !== undefined) state.evidence.delete(oldest)
  }
  return true
}

function formatChars(chars: number): string {
  return chars >= 1000 ? `${Math.round(chars / 1000)}k` : String(chars)
}

/** 渲染进展检查通知。 */
export function renderProgressNotice(input: {
  readonly level: 1 | 2 | 3
  readonly steps: number
  readonly reasoningChars: number
  readonly interrupted: boolean
}): string {
  const header = `${DEEPSEEK_V41_FLASH_PROGRESS_PREFIX} | level=${input.level} | steps=${input.steps} | reasoning~${formatChars(input.reasoningChars)} chars${input.interrupted ? ' | interrupted' : ''}]`
  const lead = input.interrupted
    ? 'Your previous reasoning was stopped because the task has made no progress since the last check. '
    : 'No new evidence, edit, or completed task since the recent steps. '
  const body = input.level === 1
    ? 'Before reasoning further, make one minimal tool call that tests your current hypothesis, then act on its result.'
    : input.level === 2
      ? 'Stop extending the analysis. In a few lines state the confirmed facts, the suspected root cause, what is still unknown, and the single next action; then take that action.'
      : 'Do not continue analysing. Identify the specific information you are missing and ask the user for it: call ask_user_question once if that tool is available, otherwise end this turn with one concise question. Do not claim the task is complete.'
  return `${header}\n${lead}${body}`
}

function createNotice(text: string): unknown {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: PLUGIN_MESSAGE_SOURCE_KIND,
      form: 'notice',
      summary: boundContextSummary('DeepSeek V4.1 Flash progress check'),
    },
  })
}

function subscribe(host: HostLike, event: string, listener: (...args: never[]) => unknown, global: boolean): (() => void) | undefined {
  if (typeof host.on !== 'function') return undefined
  const on = host.on as (name: string, fn: (...args: never[]) => unknown, options?: unknown) => unknown
  const attempts: readonly unknown[] = global ? [{ global: true }, undefined] : [undefined]
  for (const options of attempts) {
    try {
      const handle = options === undefined ? on.call(host, event, listener) : on.call(host, event, listener, options)
      if (typeof handle === 'function') return handle as () => void
      if (isRecord(handle) && typeof handle['dispose'] === 'function') return () => { (handle as { dispose(): void }).dispose() }
      return () => {
        try { host.off?.(event, listener) } catch { /* 已移除 */ }
      }
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * 安装 DeepSeek V4.1 Flash 进展治理器。
 *
 * @param ctx - 宿主上下文（结构探测，兼容各代宿主）。
 * @param options - 阈值与开关覆盖；非法阈值立即抛错。
 * @returns 幂等释放函数。
 */
export function installDeepSeekV41FlashProgressGovernor(
  ctx: unknown,
  options: ProgressGovernorOptions = {},
): () => void {
  const stepThresholds = options.stepThresholds ?? PROGRESS_STEP_THRESHOLDS
  const charThresholds = options.reasoningCharThresholds ?? PROGRESS_REASONING_CHAR_THRESHOLDS
  const cutChars = options.streamCutChars ?? PROGRESS_STREAM_CUT_CHARS
  const maxCuts = options.maxStreamCutsPerRequest ?? DEFAULT_MAX_STREAM_CUTS
  const maxNotices = options.maxNoticesPerRequest ?? DEFAULT_MAX_NOTICES
  assertThresholds('stepThresholds', stepThresholds)
  assertThresholds('reasoningCharThresholds', charThresholds)
  assertPositive('streamCutChars', cutChars)
  assertPositive('maxStreamCutsPerRequest', maxCuts)
  assertPositive('maxNoticesPerRequest', maxNotices)

  if (!isRecord(ctx)) return () => {}
  const host = ctx as HostLike
  const states = new Map<string, GovernorState>()
  let disposed = false

  const enabled = (): boolean => {
    if (disposed) return false
    if (options.enabled === undefined) return true
    try { return options.enabled() !== false } catch { return false }
  }

  const stateFor = (sessionId: string): GovernorState => {
    let state = states.get(sessionId)
    if (state === undefined) {
      state = createState()
      states.set(sessionId, state)
    }
    return state
  }

  const levelFor = (state: GovernorState): Level => {
    let level: Level = 0
    for (let i = 0; i < 3; i += 1) {
      if (state.stepsSinceProgress >= stepThresholds[i]! || state.reasoningSinceProgress >= charThresholds[i]!) level = (i + 1) as Level
    }
    return level
  }

  const warn = (message: string): void => {
    try { host.logger?.warn(`[dsh-chatgpt-subscription] ${message}`) } catch { /* 日志失败不影响主流程 */ }
  }

  const onPreStep = async (
    payload: { readonly agent?: unknown; readonly messages?: readonly unknown[]; readonly modelSelection?: unknown; readonly signal?: { readonly aborted?: boolean } } | undefined,
    next: () => Promise<{ readonly kind?: string; readonly messages?: readonly unknown[] } | undefined>,
  ): Promise<unknown> => {
    const decision = await next()
    if (decision === undefined || decision.kind === 'reject' || payload?.signal?.aborted === true || !enabled()) return decision
    const route = readScopeRoute(payload?.agent, payload?.modelSelection)
    if (route.sessionId === undefined || !isDeepSeekV41Flash(route.model, route.provider)) return decision
    const state = stateFor(route.sessionId)
    const incoming = Array.isArray(decision.messages) ? decision.messages : Array.isArray(payload?.messages) ? payload.messages : []

    // 新的真实用户输入就是新信息：清零停滞计量，并重开本次请求的干预预算。
    if (incoming.some(isRealUserMessage)) {
      markProgress(state)
      state.noticesThisRequest = 0
      state.cutsThisRequest = 0
      return decision
    }

    state.stepsSinceProgress += 1
    const target = levelFor(state)
    if (target > state.level) state.level = target
    if (state.level === 0 || state.level <= state.deliveredLevel || state.noticesThisRequest >= maxNotices) return decision

    state.deliveredLevel = state.level
    state.noticesThisRequest += 1
    const text = renderProgressNotice({
      level: state.level as 1 | 2 | 3,
      steps: state.stepsSinceProgress,
      reasoningChars: state.reasoningSinceProgress,
      interrupted: false,
    })
    const existing = Array.isArray(decision.messages) ? decision.messages : []
    return { ...decision, messages: [...existing, createNotice(text)] }
  }

  const onPostExecute = async (
    exec: { readonly name?: unknown; readonly arguments?: unknown; readonly agent?: unknown } | undefined,
    result: unknown,
    next: () => Promise<unknown>,
  ): Promise<unknown> => {
    const decision = await next()
    if (!enabled()) return decision
    const route = readScopeRoute(exec?.agent)
    if (route.sessionId === undefined || !isDeepSeekV41Flash(route.model, route.provider)) return decision
    const name = typeof exec?.name === 'string' ? exec.name : ''
    const failed = (isRecord(result) && result['isError'] === true) || (isRecord(decision) && decision['kind'] === 'block')
    if (failed || name.length === 0 || IGNORED_TOOLS.has(name)) return decision
    const state = stateFor(route.sessionId)
    if (classifyProgress(state, name, exec?.arguments, result)) markProgress(state)
    return decision
  }

  /** 已停滞时截断超长推理，并以升一级的通知续接（保留待处理输入）。 */
  const cut = (state: GovernorState, agent: GuardAgentLike, sessionId: string): void => {
    state.cutsThisRequest += 1
    const level = Math.min(3, Math.max(state.level, state.deliveredLevel) + 1) as 1 | 2 | 3
    state.level = level
    state.deliveredLevel = level
    state.noticesThisRequest += 1
    const text = renderProgressNotice({ level, steps: state.stepsSinceProgress, reasoningChars: state.reasoningSinceProgress, interrupted: true })
    warn(`DeepSeek V4.1 Flash progress governor stopped no-progress reasoning at level ${level} (cut ${state.cutsThisRequest}/${maxCuts}, session ${sessionId})`)
    agent.cancel?.({ kind: 'hook', reason: 'deepseek-v41-flash-progress-governor' }, { keepInbox: true })
    queueMicrotask(() => {
      try {
        agent.steer?.(createNotice(text))
      } catch (error) {
        warn(`DeepSeek V4.1 Flash progress governor could not queue the resume: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  const onStream = (
    request: StreamRequestLike | undefined,
    next: () => AsyncIterable<StreamChunkLike>,
  ): AsyncIterable<StreamChunkLike> => {
    const sessionId = request?.sessionId
    if (!enabled() || request?.purpose !== undefined || typeof sessionId !== 'string') return next()
    const agent = resolveRegisteredAgent(host, sessionId)
    const route = agent === undefined ? undefined : readScopeRoute(agent)
    if (!isDeepSeekV41Flash(request?.model ?? route?.model, request?.provider ?? route?.provider)) return next()
    const state = stateFor(sessionId)
    const canCut = typeof agent?.cancel === 'function' && typeof agent.steer === 'function'

    return (async function* guarded(): AsyncIterable<StreamChunkLike> {
      let attempt = 0
      for await (const chunk of next()) {
        if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') {
          attempt += chunk.text.length
          state.reasoningSinceProgress += chunk.text.length
          if (
            canCut
            && enabled()
            && state.deliveredLevel >= 1
            && attempt >= cutChars
            && state.cutsThisRequest < maxCuts
          ) {
            cut(state, agent!, sessionId)
            return
          }
        }
        yield chunk
      }
    })()
  }

  const onDisposed = (payload: { readonly agent?: unknown } | undefined): void => {
    const sessionId = readScopeRoute(payload?.agent).sessionId
    if (sessionId !== undefined) states.delete(sessionId)
  }

  const releases = [
    subscribe(host, 'agent/pre-step', onPreStep as never, true),
    subscribe(host, 'tools/post-execute', onPostExecute as never, true),
    subscribe(host, 'llm/stream', onStream as never, true),
    subscribe(host, 'agent/disposed', onDisposed as never, true),
  ]

  return () => {
    if (disposed) return
    disposed = true
    for (const release of releases) {
      try { release?.() } catch { /* 忽略单点卸载异常 */ }
    }
    states.clear()
  }
}
