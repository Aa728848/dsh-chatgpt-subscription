/**
 * 开源模型共享 Append-Only 零改前缀尾部状态锚（State Anchor）。
 *
 * 顺应三大开源模型物理阵营的共同约束：
 * - **阵营 A（Kimi K3/K3.1 KDA+Gated DSA、Qwen GDN+QSA、GLM-5.3-Flash、Ling 7:1 KDA）**：
 *   固定递推状态随超长对话发生覆写/混叠，NoPE + 稀疏索引强依赖显式文件路径与符号名；
 * - **阵营 B（GLM-5.2/5.3 IndexShare、MiniMax M3/M3.1 MSA Top-16、DeepSeek V4 CSA+HCA、Hy4）**：
 *   单步精确历史注意力预算约 ~2,048 tokens，高水位易失焦；
 * - **阵营 C（Step-3.5/3.7 SWA W=512、Step-5 深窄网、MiMo-V2.6 SWA W=128）**：
 *   局部滑窗极窄，超过 128–512 tokens 外的目标约束难以进入局部层。
 *
 * 仅在步数周期、上下文水位首次跨越或连续工具失败时，于 `agent/pre-step` 尾部追加一段
 * 紧凑的状态锚——0% 破坏前方前缀缓存，严格排除 DeepSeek V4.1 Flash
 * 与全部闭源模型。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/host/open-models/state-anchor
 */
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { defaultEstimateContextTokens, readSessionTaskLine, summarizeTodos } from '../deepseek-v41-flash/state-anchor.ts'
import {
  absorbGoalMessages,
  createGoalLedger,
  currentGoal,
  earlierGoals,
  messageText,
  recoverGoalFromEvents,
  type GoalLedger,
} from '../deepseek-v41-flash/goal-intake.ts'
import { matchOpenModelScope, type OpenModelProfile } from './profiles.ts'

/** 开源模型共享状态锚的消息来源 kind。 */
export const OPEN_MODEL_ANCHOR_SOURCE_KIND = 'open-model-state-anchor'

/** 锚点文本固定前缀（供检索意图分类器与自身幂等检查识别）。 */
export const OPEN_MODEL_ANCHOR_PREFIX = '[Open-Model State Anchor'

/** 连续工具失败触发即时纠偏锚点的默认次数。 */
export const OPEN_MODEL_CONSECUTIVE_ERROR_THRESHOLD = 2

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 本包面向开源长上下文/稀疏/线性/SWA 模型在尾部追加的零改前缀状态锚。 */
    'open-model-state-anchor': { kind: 'open-model-state-anchor' } & { form?: 'notice'; summary?: string }
  }
}

const MAX_ACTIVE_FILES = 4
const MAX_FILE_LABEL_CHARS = 36

interface SessionEventLike {
  readonly type?: unknown
  readonly data?: unknown
}

interface AgentLike {
  readonly id?: unknown
  readonly session?: {
    readonly events?: readonly SessionEventLike[]
    snapshotEvents?(): readonly SessionEventLike[]
  }
}

interface PreStepPayloadLike {
  readonly agent?: AgentLike
  readonly messages?: readonly unknown[]
  readonly turn?: unknown
  readonly signal?: { readonly aborted?: boolean }
  readonly modelSelection?: unknown
}

interface PreStepDecisionLike {
  readonly kind?: string
  readonly messages?: readonly unknown[]
  readonly [key: string]: unknown
}

interface ToolExecutionLike {
  readonly name?: unknown
  readonly arguments?: unknown
  readonly agent?: unknown
  readonly parent?: unknown
}

interface ToolExecutionResultLike {
  readonly isError?: unknown
}

interface EventHostLike {
  on?(name: string, listener: (...args: never[]) => unknown, options?: unknown): unknown
  off?(name: string, listener: (...args: never[]) => unknown): unknown
  get?(name: string): unknown
}

interface AnchorSessionState {
  /** 最近几个回合的目标；GOAL 取最新回合，更早回合仅作参考。 */
  goals: GoalLedger
  stepsInTurn: number
  lastAnchoredStep: number
  crossedWatermarkIndex: number
  consecutiveToolErrors: number
  lastErrorTool: string | undefined
  errorAnchorPending: boolean
  activeFiles: string[]
  /** 最近一次 `todo_write` 或持久化 `todos` / `todoReminder` 投影归纳出的紧凑任务进度。 */
  taskLine: string
  observedChars: number
}

export interface OpenModelStateAnchorOptions {
  /** 活引用读取器；返回 false 时彻底旁路。默认 true。 */
  readonly enabled?: () => boolean
  /** 可选自定义步数周期覆盖（测试用）。 */
  readonly stepIntervalOverride?: number
  /** 可选自定义水位表覆盖（测试用）。 */
  readonly contextWatermarksOverride?: readonly number[]
  /** 可选连续工具报错阈值（默认 2）。 */
  readonly consecutiveErrorThreshold?: number
  /** 可选上下文 token 估算覆盖（测试用）。 */
  readonly estimateContextTokens?: (agent: unknown, observedChars: number) => number
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

function createSessionState(): AnchorSessionState {
  return {
    goals: createGoalLedger(),
    stepsInTurn: 0,
    lastAnchoredStep: 0,
    crossedWatermarkIndex: -1,
    consecutiveToolErrors: 0,
    lastErrorTool: undefined,
    errorAnchorPending: false,
    activeFiles: [],
    taskLine: '',
    observedChars: 0,
  }
}

function shortFileLabel(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, '/').trim()
  if (normalized.length <= MAX_FILE_LABEL_CHARS) return normalized
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length >= 2) {
    const tail = parts.slice(-2).join('/')
    if (tail.length <= MAX_FILE_LABEL_CHARS) return '.../' + tail
  }
  return '...' + normalized.slice(-(MAX_FILE_LABEL_CHARS - 3))
}

function extractTargetFile(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined
  for (const key of ['path', 'file_path', 'filePath', 'target', 'file', 'AbsolutePath', 'Path']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return shortFileLabel(value)
    }
  }
  return undefined
}

function recordActiveFile(state: AnchorSessionState, file: string): void {
  const existing = state.activeFiles.indexOf(file)
  if (existing >= 0) state.activeFiles.splice(existing, 1)
  state.activeFiles.push(file)
  if (state.activeFiles.length > MAX_ACTIVE_FILES) {
    state.activeFiles.splice(0, state.activeFiles.length - MAX_ACTIVE_FILES)
  }
}

function formatApproxTokens(tokens: number): string {
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
  return String(tokens)
}

/** 渲染紧凑尾部状态锚文本（保持简短以减少噪声与 token 开销）。 */
export function renderOpenModelStateAnchorText(input: {
  readonly profile: Pick<OpenModelProfile, 'label' | 'anchorRuleLine'>
  readonly step: number
  readonly approxTokens: number
  readonly reason: 'periodic' | 'watermark' | 'consecutive-errors'
  readonly goal: string
  readonly goalMerged?: boolean | undefined
  readonly earlierGoal?: string | undefined
  readonly tasks?: string | undefined
  readonly activeFiles: readonly string[]
  readonly consecutiveErrors: number
  readonly lastErrorTool?: string
}): string {
  const header = `${OPEN_MODEL_ANCHOR_PREFIX} | model=${input.profile.label} | step=${input.step} | ctx~${formatApproxTokens(input.approxTokens)} | trigger=${input.reason}]`
  const lines = [header]
  if (input.goal.length > 0) lines.push(`${input.goalMerged === true ? 'GOAL (later parts override earlier)' : 'GOAL'}: ${input.goal}`)
  const hasTasks = input.tasks !== undefined && input.tasks.length > 0
  if (hasTasks) lines.push(`TASKS: ${input.tasks}`)
  if (!hasTasks && input.goal.length > 0 && input.earlierGoal !== undefined && input.earlierGoal.length > 0) {
    lines.push(`EARLIER (context only; GOAL wins on conflict): ${input.earlierGoal}`)
  }
  if (input.activeFiles.length > 0) lines.push(`FILES: ${input.activeFiles.join(', ')}`)
  if (input.reason === 'consecutive-errors') {
    const toolLabel = input.lastErrorTool ? ` (${input.lastErrorTool})` : ''
    lines.push(`ALERT: ${input.consecutiveErrors} consecutive tool failures${toolLabel}. Switch strategy or inspect the root definition instead of retrying unchanged.`)
  }
  lines.push(input.profile.anchorRuleLine)
  return lines.join('\n')
}

function createAnchorMessage(text: string, label: string): unknown {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: OPEN_MODEL_ANCHOR_SOURCE_KIND,
      form: 'notice',
      summary: boundContextSummary(`${label} long-horizon state anchor`),
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
 * 安装面向开源模型共享的尾部状态锚点。
 */
export function installOpenModelStateAnchor(
  ctx: unknown,
  options: OpenModelStateAnchorOptions = {},
): () => void {
  const host = typeof ctx === 'object' && ctx !== null ? (ctx as EventHostLike) : undefined
  const errorThreshold = Math.max(1, options.consecutiveErrorThreshold ?? OPEN_MODEL_CONSECUTIVE_ERROR_THRESHOLD)
  const estimateTokens = options.estimateContextTokens ?? defaultEstimateContextTokens

  const states = new WeakMap<object, AnchorSessionState>()
  const statesBySessionId = new Map<string, AnchorSessionState>()
  let disposed = false

  const stateFor = (agent: unknown, sessionId?: string): AnchorSessionState | undefined => {
    if (sessionId !== undefined) {
      let existing = statesBySessionId.get(sessionId)
      if (existing === undefined) {
        existing = createSessionState()
        statesBySessionId.set(sessionId, existing)
      }
      if (typeof agent === 'object' && agent !== null) states.set(agent, existing)
      return existing
    }
    if (typeof agent !== 'object' || agent === null) return undefined
    let existing = states.get(agent)
    if (existing === undefined) {
      existing = createSessionState()
      states.set(agent, existing)
    }
    return existing
  }

  const onPreStep = async (
    payload: PreStepPayloadLike,
    next: () => Promise<PreStepDecisionLike | undefined>,
  ): Promise<PreStepDecisionLike | undefined> => {
    const decision = await next()
    if (disposed || decision === undefined || decision.kind === 'reject') return decision
    if (payload?.signal?.aborted === true || !isEnabled(options.enabled)) return decision

    const matched = matchOpenModelScope(payload?.agent, payload?.modelSelection)
    if (matched === undefined || !matched.profile.stateAnchor) return decision

    const { route, profile } = matched
    const state = stateFor(payload?.agent, route.sessionId)
    if (state === undefined) return decision

    const incoming = Array.isArray(decision.messages)
      ? decision.messages
      : Array.isArray(payload?.messages)
        ? payload.messages
        : []

    for (const msg of incoming) {
      if (isRecord(msg)) {
        state.observedChars += messageText(msg['content']).length
      }
    }

    const approxTokens = estimateTokens(payload?.agent, state.observedChars)

    // 只有真人（或上级代理）消息能改写目标；“继续”这类短句保留原目标但开启新回合。
    const currentTurn = typeof payload?.turn === 'number' ? payload.turn : undefined
    if (absorbGoalMessages(state.goals, incoming, currentTurn)) {
      state.stepsInTurn = 0
      state.lastAnchoredStep = 0
      state.consecutiveToolErrors = 0
      state.lastErrorTool = undefined
      state.errorAnchorPending = false
      return decision
    }

    state.stepsInTurn += 1

    if (currentGoal(state.goals).length === 0 && isRecord(payload?.agent) && isRecord(payload.agent.session)) {
      const session = payload.agent.session
      let events: readonly SessionEventLike[] | undefined
      if (Array.isArray(session.events)) events = session.events
      else if (typeof session.snapshotEvents === 'function') {
        try { events = session.snapshotEvents() } catch { events = undefined }
      }
      if (events !== undefined) recoverGoalFromEvents(state.goals, events, currentTurn)
    }

    const stepInterval = Math.max(1, options.stepIntervalOverride ?? profile.anchorStepInterval)
    const watermarks = options.contextWatermarksOverride ?? profile.anchorWatermarks

    let trigger: 'periodic' | 'watermark' | 'consecutive-errors' | undefined
    let nextWatermarkIndex = state.crossedWatermarkIndex
    for (let i = state.crossedWatermarkIndex + 1; i < watermarks.length; i += 1) {
      if (approxTokens >= watermarks[i]!) nextWatermarkIndex = i
    }

    if (state.errorAnchorPending && state.consecutiveToolErrors >= errorThreshold) {
      trigger = 'consecutive-errors'
      state.errorAnchorPending = false
    } else if (nextWatermarkIndex > state.crossedWatermarkIndex) {
      trigger = 'watermark'
      state.crossedWatermarkIndex = nextWatermarkIndex
    } else if (
      state.stepsInTurn >= stepInterval
      && state.stepsInTurn - state.lastAnchoredStep >= stepInterval
    ) {
      trigger = 'periodic'
    }

    if (trigger === undefined) return decision
    const projectedTasks = readSessionTaskLine(host, payload?.agent)
    if (projectedTasks !== undefined) state.taskLine = projectedTasks
    const goal = currentGoal(state.goals)
    // 周期锚只是重申；既无目标也无待办任务时没有可重申的内容。
    if (trigger === 'periodic' && goal.length === 0 && state.taskLine.length === 0) return decision

    if (incoming.some(msg => isRecord(msg) && isRecord(msg['source']) && msg['source']['kind'] === OPEN_MODEL_ANCHOR_SOURCE_KIND)) {
      return decision
    }

    state.lastAnchoredStep = state.stepsInTurn
    const text = renderOpenModelStateAnchorText({
      profile,
      step: state.stepsInTurn,
      approxTokens,
      reason: trigger,
      goal,
      goalMerged: state.goals.turns[state.goals.turns.length - 1]?.merged === true,
      earlierGoal: earlierGoals(state.goals),
      tasks: state.taskLine,
      activeFiles: state.activeFiles,
      consecutiveErrors: state.consecutiveToolErrors,
      lastErrorTool: state.lastErrorTool,
    })
    const existingMessages = Array.isArray(decision.messages) ? decision.messages : []
    return {
      ...decision,
      messages: [...existingMessages, createAnchorMessage(text, profile.label)],
    }
  }

  const onPostExecute = async (
    exec: ToolExecutionLike,
    result: ToolExecutionResultLike,
    next: () => Promise<unknown>,
  ): Promise<unknown> => {
    const decision = await next()
    if (disposed || !isEnabled(options.enabled)) return decision
    const matched = matchOpenModelScope(exec?.agent)
    if (matched === undefined || !matched.profile.stateAnchor) return decision

    const state = stateFor(exec?.agent, matched.route.sessionId)
    if (state === undefined) return decision

    // Code Mode 中 `todo_write` 以嵌套调用出现，任务进度同样需要实时采集。
    const isError = result?.isError === true || (isRecord(decision) && decision['kind'] === 'block')
    if (!isError && exec?.name === 'todo_write') {
      const tasks = summarizeTodos(exec.arguments)
      if (tasks !== undefined) state.taskLine = tasks
    }
    if (exec?.parent !== undefined) return decision

    const targetFile = extractTargetFile(exec?.arguments)
    if (targetFile !== undefined) recordActiveFile(state, targetFile)

    if (isError) {
      state.consecutiveToolErrors += 1
      state.lastErrorTool = typeof exec?.name === 'string' ? exec.name : undefined
      if (state.consecutiveToolErrors >= errorThreshold) {
        state.errorAnchorPending = true
      }
    } else {
      state.consecutiveToolErrors = 0
      state.lastErrorTool = undefined
      state.errorAnchorPending = false
    }
    return decision
  }

  const onDisposed = (payload: { readonly agent?: unknown } | undefined): void => {
    const matched = matchOpenModelScope(payload?.agent)
    if (matched?.route.sessionId !== undefined) {
      statesBySessionId.delete(matched.route.sessionId)
    }
  }

  const offPreStep = subscribe(host, 'agent/pre-step', onPreStep as never)
  const offPostExec = subscribe(host, 'tools/post-execute', onPostExecute as never)
  const offDisposed = subscribe(host, 'agent/disposed', onDisposed as never)

  return () => {
    if (disposed) return
    disposed = true
    for (const off of [offPreStep, offPostExec, offDisposed]) {
      try {
        off?.()
      } catch {
        // 忽略单点卸载异常。
      }
    }
    statesBySessionId.clear()
  }
}
