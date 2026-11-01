/**
 * MiniMax Code 会话的运行时增强：参数修复、PTC 直调提醒、工具级失控守卫。
 *
 * 移植官方 `MiniMax-AI/minimax-code` 的三样东西，**只**对 MiniMax Code 这条
 * 线路生效：
 *
 * 1. **参数强转与修复**（官方 `edit-prepare-arguments.ts` / `input-validation.ts`）：
 *    模型把 `edits` 写成 JSON 字符串、把数字字段写成字符串、把数组包成
 *    `{"item": [...]}` —— 这些形状在 schema 校验处会直接失败。这里把它们改回
 *    本来的形状，**只做无损的改写**：数字字符串只在能无损还原成数字时才转，
 *    `"2.5"` 遇到 `integer` 不转，布尔字符串只在字面是 `"true"`/`"false"` 时才转。
 * 2. **PTC 直调提醒**：模型在 PTC 模式里直接调了原生工具（而不是在
 *    `run_code` 程序里调），提醒它改用 `run_code`。
 * 3. **工具级失控守卫**（官方 `packages/agent-modules/runaway-guard`）：同一
 *    次动作连续重复、同一个工具连续报同一族错误、连续轮询同一个后台任务而
 *    输出没变 —— 三种信号里挑一条，按官方文案提醒模型换个策略。
 *
 * ## 线路判定是结构探测
 *
 * 读 provider 的方式照抄本包既有的做法（见 `src/host/cache-warmup/install.ts`
 * 的 `cacheWarmupRouteOf` 与 `src/host/ptc-sdk-cache-guard.ts` 的
 * `readScopeProvider`）：会话请求头 → agent 的模型选择面 → agent 选项 → agent
 * 自身。不 import 任何宿主代次专属的类型，所以同一份代码在 0.1.2-alpha.5 到
 * 0.2.1-rc.3 上都装得上。
 *
 * ## 接线面
 *
 * - `ctx.tools.guard()`：参数修复。守卫**永远不拦**（返回 `undefined`）。
 * - `tools/pre-execute`：同一份参数修复，早一步做。
 * - `tools/post-execute`：直调提醒 + 失控守卫，都走 `additionalContexts`。
 * - `agent/pre-step` / `agent/disposed`：新的一轮用户输入重置连击计数。
 *
 * @module dsh-chatgpt-subscription/host/minimax-code/runtime-enhancements
 */

import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** PTC 直调提醒。 */
    'minimax-direct-call-reminder': { kind: 'minimax-direct-call-reminder' } & { form?: 'notice', summary?: string }
    /** 失控守卫提醒。 */
    'minimax-runaway-guard': { kind: 'minimax-runaway-guard' } & { form?: 'notice', summary?: string }
  }
}

/** 本模块只对 MiniMax Code 这条线路生效。 */
export const MINIMAX_CODE_PROVIDER = 'minimax-code'

/**
 * 判断一个值是不是普通对象（原型是 `Object.prototype` 或 `null`）。
 * @param value - 任意值。
 * @returns 是普通对象时为 true。
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * 判断一个值是不是普通对象（不要求原型，数组也算对象）。
 * @param value - 任意值。
 * @returns 是对象时为 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 读一个未知字段为非空字符串。
 * @param value - 候选值。
 * @returns 字符串，或任何其它类型的 undefined。
 */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 一次工具调用所属的线路。 */
export interface MinimaxSessionRoute {
  /** 当前会话被路由到的 provider id。 */
  readonly provider?: string
  /** 当前会话标识。 */
  readonly sessionId?: string
}

/** 事件里 agent 上本模块会读的部分（结构化类型，不绑定具体 SDK 版本）。 */
interface AgentLike {
  readonly id?: unknown
  readonly session?: {
    readonly header?: { readonly id?: unknown }
    /** 会话当前被路由到的模型线路。老宿主上可能没有这个方法。 */
    requestHeader?(): { readonly config?: { readonly provider?: unknown } } | undefined
  }
  /** 宿主的模型选择面：先给已记录的选择，没有记录时才退回 agent 选项。 */
  readonly model?: { current?(): { readonly provider?: unknown } | undefined }
  readonly options?: { readonly provider?: unknown }
  readonly provider?: unknown
}

/**
 * 读一次工具调用所属的线路。
 *
 * provider 的四个来源按可靠性排序：**请求头快照**（唯一反映「已经真的路由到
 * 哪个 provider」的那一份）→ **模型选择面**（首步还没有请求头时唯一还能说出
 * 这一场走哪条线路的地方）→ **agent 选项**（还没发出请求时唯一的意图）→
 * **agent 自身的 provider 字段**（最后的兜底）。
 *
 * 每一处读取都独立 try/catch：任何一处抛错都只是「这一处读不到」，不改变
 * 其余来源的行为，也不让整次读取失败。
 *
 * @param agent - 事件里的调用方 agent。
 * @returns 线路信息；读不到的字段省略。
 */
export function minimaxSessionRouteOf(agent: unknown): MinimaxSessionRoute {
  const record = isRecord(agent) ? (agent as unknown as AgentLike) : undefined
  const session = record?.session

  let provider: string | undefined
  try {
    provider = stringOf(session?.requestHeader?.()?.config?.provider)
  } catch {
    // 会话正在拆除、或这一代宿主没有 requestHeader：退回下一个来源。
    provider = undefined
  }
  if (provider === undefined) {
    try {
      provider = stringOf(record?.model?.current?.()?.provider)
    } catch {
      provider = undefined
    }
  }
  if (provider === undefined) provider = stringOf(record?.options?.provider)
  if (provider === undefined) provider = stringOf(record?.provider)

  // 会话 id 只认会话头，退一步才用 agent 自己的 id：前者是日志与引用归属的真名。
  const sessionId = stringOf(session?.header?.id) ?? stringOf(record?.id)
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(sessionId === undefined ? {} : { sessionId }),
  }
}

/**
 * 判断一次工具调用是不是 MiniMax Code 这条线路上的。
 * @param agent - 事件里的调用方 agent。
 * @returns 是 MiniMax Code 时为 true。
 */
export function isMinimaxSession(agent: unknown): boolean {
  return minimaxSessionRouteOf(agent).provider === MINIMAX_CODE_PROVIDER
}

/** 无损的数字字符串：允许小数、指数、前导负号。 */
const NUMERIC_STRING = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u

/**
 * 顶层已知的数字字段（没有 schema 时按字段名强转）。
 *
 * 这些是本宿主工具面里**本来就该是数字**的字段：模型把它们写成字符串时，
 * schema 校验会直接失败，而它们强转回来是**无损**的。
 */
export const NUMERIC_TOOL_FIELDS: readonly string[] = Object.freeze([
  'offset',
  'limit',
  'timeout',
  'timeoutMs',
  'timeout_ms',
  'line',
  'delta_x',
  'delta_y',
  'x',
  'y',
  'ref',
])

/**
 * 顶层已知的布尔字段（没有 schema 时按字段名强转）。
 *
 * 只有字面 `"true"` / `"false"` 才转：别的写法（`"1"`、`"yes"`）在布尔
 * 字段上是**有歧义**的，转过去等于替模型猜了一个开关的状态。
 */
export const BOOLEAN_TOOL_FIELDS: readonly string[] = Object.freeze([
  'replace_all',
  'wait',
  'run_in_background',
  'new_tab',
  'multi_select',
])

/** 一次参数修复的结果。 */
export interface MinimaxArgumentRepair {
  /** 修复后的参数；没有修复时与传入值等价。 */
  readonly value: unknown
  /** 修复项的名字，按发生顺序。 */
  readonly fixes: string[]
}

/**
 * 按 schema 强转一个值，并把强转过程记进 `fixes`。
 *
 * 只认三种形状：
 *
 * - `type: 'array'`：值是单键对象 `{ item: X }` 时拆包（官方 Pi 的
 *   `item_wrapper` 形状），然后按 `items` 递归每个元素；
 * - `type: 'number' | 'integer'`：值是**无损**数字字符串时转成数字
 *   （`integer` 还要求转出来确实是整数，`"2.5"` 不转）；
 * - `type: 'boolean'`：值是 `"true"` / `"false"` 时转成布尔。
 *
 * @param value - 当前值。
 * @param schema - 这一层的 JSON Schema。
 * @param fixes - 修复项累加器。
 * @returns 强转后的值。
 */
function coerceBySchema(value: unknown, schema: unknown, fixes: string[]): unknown {
  if (!isRecord(schema)) return value
  const type = schema['type']

  if (type === 'array') {
    let current = value
    if (isPlainRecord(current) && Object.keys(current).length === 1 && 'item' in current) {
      const inner = current['item']
      current = Array.isArray(inner) ? [...inner] : [inner]
      fixes.push('item_wrapper')
    }
    const items = schema['items']
    if (Array.isArray(current) && items !== undefined) {
      current = current.map(entry => coerceBySchema(entry, items, fixes))
    }
    return current
  }

  if (type === 'number' || type === 'integer') {
    if (typeof value === 'string' && NUMERIC_STRING.test(value)) {
      const parsed = Number(value)
      if (Number.isFinite(parsed) && (type !== 'integer' || Number.isInteger(parsed))) {
        fixes.push('number_string')
        return parsed
      }
    }
    return value
  }

  if (type === 'boolean') {
    if (value === 'true') {
      fixes.push('boolean_string')
      return true
    }
    if (value === 'false') {
      fixes.push('boolean_string')
      return false
    }
    return value
  }

  if (type === 'object') {
    const properties = schema['properties']
    if (!isPlainRecord(value) || !isRecord(properties)) return value
    const next: Record<string, unknown> = { ...value }
    for (const [key, subSchema] of Object.entries(properties)) {
      if (!(key in next)) continue
      next[key] = coerceBySchema(next[key], subSchema, fixes)
    }
    return next
  }

  // 没有显式 type 时仍然按 properties / items 递归：不少 schema 只写了结构。
  const properties = schema['properties']
  if (isPlainRecord(value) && isRecord(properties)) {
    const next: Record<string, unknown> = { ...value }
    for (const [key, subSchema] of Object.entries(properties)) {
      if (!(key in next)) continue
      next[key] = coerceBySchema(next[key], subSchema, fixes)
    }
    return next
  }
  const items = schema['items']
  if (Array.isArray(value) && items !== undefined) {
    return value.map(entry => coerceBySchema(entry, items, fixes))
  }
  return value
}

/**
 * 没有 schema 时按字段名做的顶层强转。
 *
 * 只动**顶层**的已知字段：嵌套结构没有 schema 就没有依据，猜不得。
 * @param args - 参数副本。
 * @param fixes - 修复项累加器。
 */
function coerceByKnownFields(args: Record<string, unknown>, fixes: string[]): void {
  for (const field of NUMERIC_TOOL_FIELDS) {
    const current = args[field]
    if (typeof current !== 'string' || !NUMERIC_STRING.test(current)) continue
    const parsed = Number(current)
    if (!Number.isFinite(parsed)) continue
    args[field] = parsed
    fixes.push('number_string')
  }
  for (const field of BOOLEAN_TOOL_FIELDS) {
    const current = args[field]
    if (current === 'true') {
      args[field] = true
      fixes.push('boolean_string')
    } else if (current === 'false') {
      args[field] = false
      fixes.push('boolean_string')
    }
  }
}

/**
 * 修复一次工具调用的参数。
 *
 * 三步，顺序固定：
 *
 * 1. **`edits` 字符串解析**（官方 `edit-prepare-arguments.ts`）：`edits` 是
 *    JSON 字符串时解析回数组。解析失败就**原样留着**，让 schema 校验照常报错
 *    ——在这里猜一个数组比不猜更糟。
 * 2. **按 schema 强转**（官方 `direct-call-arguments.ts` / `input-validation.ts`）：
 *    `item_wrapper` 拆包、数字字符串转数字、布尔字符串转布尔，并递归进
 *    `properties` 与 `items`。
 * 3. **按字段名强转**：**没有传 schema** 时才做，因为那时唯一的依据就是字段名。
 *
 * 入参**不被修改**：返回值是一份新对象。
 *
 * @param toolName - 工具名（只用于日志与将来按工具定制规则）。
 * @param args - 原始参数。
 * @param schema - 该工具的 JSON Schema（参数面），可选。
 * @returns 修复后的参数与修复项列表。
 */
export function repairMinimaxToolArguments(
  toolName: string,
  args: unknown,
  schema?: unknown,
): MinimaxArgumentRepair {
  void toolName
  if (!isPlainRecord(args)) return { value: args, fixes: [] }

  const fixes: string[] = []
  const working: Record<string, unknown> = { ...args }

  // 1) edits 的 JSON 字符串。
  if (typeof working['edits'] === 'string') {
    const parsed = tryParseJson(working['edits'])
    if (Array.isArray(parsed)) {
      working['edits'] = parsed
      fixes.push('edits_json_string')
    }
  }

  // 2) 按 schema 强转。
  if (schema !== undefined) {
    const coerced = coerceBySchema(working, schema, fixes)
    if (isPlainRecord(coerced)) Object.assign(working, coerced)
  } else {
    // 3) 没有 schema：按字段名强转顶层。
    coerceByKnownFields(working, fixes)
  }

  return { value: working, fixes }
}

/**
 * 解析一段 JSON，失败时返回 undefined（不抛）。
 * @param text - 待解析的文本。
 * @returns 解析结果，或 undefined。
 */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/**
 * 直接调用需要提醒的工具名。
 *
 * 这些是**原生**工具：在 PTC 模式里模型只能直接调 `run_code`，原生工具要
 * 从 `run_code` 程序里调。
 */
export const DIRECT_CALL_REMINDER_TOOLS: readonly string[] = Object.freeze([
  'read',
  'edit',
  'write',
  'grep',
  'glob',
  'win_bash',
  'bash',
  'pwsh',
])

/**
 * 各个原生工具在 `run_code` 里的调用示例参数。
 *
 * 例子必须**真的能跑**：提醒里给一个跑不通的示例，比不给示例更糟。
 */
const DIRECT_CALL_EXAMPLE_ARGS: Readonly<Record<string, string>> = Object.freeze({
  read: '{ file_path: "README.md" }',
  write: '{ file_path: "README.md", content: "..." }',
  edit: '{ file_path: "README.md", old_string: "...", new_string: "..." }',
  grep: '{ pattern: "TODO", path: "." }',
  glob: '{ pattern: "src/**/*.ts" }',
  bash: '{ command: "ls -la" }',
  win_bash: '{ command: "ls -la" }',
  pwsh: '{ command: "Get-ChildItem" }',
})

/**
 * 造一条 `run_code` 调用示例。
 * @param toolName - 工具名。
 * @returns 一句可读的调用示例。
 */
function directCallExampleOf(toolName: string): string {
  const args = DIRECT_CALL_EXAMPLE_ARGS[toolName] ?? '{ ... }'
  return `await tools.${toolName}(${args})`
}

/**
 * 渲染 PTC 直调提醒。
 *
 * 文案与官方 `direct-call-reminder.ts` 同形：
 *
 * ```text
 * <system-reminder>
 * Do not call read directly in this turn. Call it inside run_code: await tools.read({ file_path: "README.md" }). Put your next tool calls in one run_code program.
 * </system-reminder>
 * ```
 *
 * @param toolNames - 被直接调用的工具名。
 * @returns 提醒正文。
 */
export function renderDirectCallReminder(toolNames: readonly string[]): string {
  const names = [...new Set(toolNames.filter(name => name !== ''))]
  if (names.length === 0) {
    return [
      '<system-reminder>',
      'Do not call tools directly in this turn. Call them inside run_code. Put your next tool calls in one run_code program.',
      '</system-reminder>',
    ].join('\n')
  }
  const listed = names.join(', ')
  const pronoun = names.length === 1 ? 'it' : 'them'
  // 示例最多两个工具：再多就不是示例，是清单。
  const example = names.slice(0, 2).map(name => directCallExampleOf(name)).join('; ')
  return [
    '<system-reminder>',
    `Do not call ${listed} directly in this turn. Call ${pronoun} inside run_code: ${example}. Put your next tool calls in one run_code program.`,
    '</system-reminder>',
  ].join('\n')
}

/** 失控守卫能识别的信号。 */
export type MinimaxRunawaySignalKind =
  | 'exact_action_repeat'
  | 'same_error_family'
  | 'polling_repeat'
  | 'abab_action_cycle'

/** 一次工具执行的可观察事实。 */
export interface MinimaxRunawayObservation {
  /** 工具名。 */
  readonly toolName: string
  /** 已解析的参数。 */
  readonly arguments?: unknown
  /** 这次执行是否失败。 */
  readonly isError?: boolean
  /** 工具自己报的结构化错误码。 */
  readonly errorCode?: string
  /** 失败文本。 */
  readonly errorText?: string
  /** 成功结果文本（轮询判定用）。 */
  readonly resultText?: string
}

/** 一条要注入模型的提醒。 */
export interface MinimaxRunawayReminder {
  /** 信号种类。 */
  readonly kind: MinimaxRunawaySignalKind
  /** 连击次数。 */
  readonly occurrences: number
  /** 提醒正文。 */
  readonly text: string
}

/** 守卫观察到的一次信号。 */
export interface MinimaxRunawaySignal {
  /** 信号种类。 */
  readonly kind: MinimaxRunawaySignalKind
  /** 连击次数。 */
  readonly occurrences: number
  /** 涉及的工具名。 */
  readonly toolName: string
}

/** 工具级失控守卫。 */
export interface MinimaxRunawayGuard {
  /**
   * 观察一次工具执行。
   * @param observation - 这一次执行的可观察事实。
   * @returns 要注入的提醒（每轮至多一条），没有时为 undefined。
   */
  observe(observation: MinimaxRunawayObservation): MinimaxRunawayReminder | undefined
  /** 清空连击计数与「本轮已提醒」标记（新的一轮用户输入 / agent 拆除时调用）。 */
  reset(): void
  /** 到目前为止观察到的信号。 */
  readonly signals: readonly MinimaxRunawaySignal[]
}

/** 失控守卫选项。 */
export interface MinimaxRunawayGuardOptions {
  /** 连击多少次才提醒（默认 3）。 */
  readonly remindAfterOccurrences?: number
}

/**
 * 失控守卫的默认连击阈值。
 *
 * 与官方一致：提醒在**第三次**重复时给出。
 */
export const DEFAULT_REMIND_AFTER_OCCURRENCES = 3

/**
 * 官方提醒文案的后缀：提醒只对当前这一轮有效。
 * @returns 后缀正文。
 */
const TURN_ONLY_SUFFIX = ' This is a temporary runtime reminder for the current Turn only, not a user preference or a durable rule; do not save this reminder or generalize it into Memory, Skills, or other persistent instruction files for future Turns or sessions.'

/**
 * 渲染「同一个动作立刻重复」提醒。
 *
 * 与官方 `packages/agent-modules/runaway-guard/src/reminder.ts` 逐字一致。
 * @param occurrences - 连击次数。
 * @returns 提醒正文。
 */
export function renderExactActionRepeatReminder(occurrences: number): string {
  return `[runaway guard] The immediately repeated tool action has now occurred ${occurrences} times with the same arguments. Do not repeat it unchanged. Inspect the results already available, then either change strategy with a concrete expected state change, or report the blocker. Repetition alone does not establish that the task is complete or impossible.${TURN_ONLY_SUFFIX}`
}

/**
 * 渲染「同一族错误连续发生」提醒。
 *
 * 与官方 `packages/agent-modules/runaway-guard/src/reminder.ts` 逐字一致。
 * @param occurrences - 连击次数。
 * @returns 提醒正文。
 */
export function renderSameErrorFamilyReminder(occurrences: number): string {
  return `[runaway guard] The same tool error family has now occurred ${occurrences} times in a row. Do not retry the same route unchanged. Diagnose the cause, change one controlled variable or switch route. Do not infer that the entire task has failed from this signal.${TURN_ONLY_SUFFIX}`
}

/**
 * 渲染「反复轮询同一个后台任务」提醒。
 *
 * 与官方 `packages/agent-modules/runaway-guard/src/reminder.ts` 逐字一致：
 * 三次读同一个任务时写的是 `Three`，其它次数写数字。
 * @param occurrences - 连击次数。
 * @returns 提醒正文。
 */
export function renderPollingRepeatReminder(occurrences: number): string {
  const count = occurrences === 3 ? 'Three' : String(occurrences)
  return [
    '<system-reminder>',
    `${count} task_output reads for the same task have returned an unchanged status and output cursor. Avoid repeated polling; you will be notified automatically and this conversation will resume when the background task completes.`,
    'This reminder applies only to the current Turn. Do not save or generalize it into Memory, Skills, or other persistent instructions.',
    '</system-reminder>',
  ].join('\n')
}

/**
 * 轮询类工具名（后台任务的结果读取）。
 *
 * 这两个工具读的是后台任务的状态；反复读同一个任务而输出没变，就是官方说的
 * 「polling repeat」。
 */
export const POLLING_TOOL_NAMES: readonly string[] = Object.freeze(['job_output', 'task_output'])

/**
 * 规范化一段错误文本，取它的「族」。
 *
 * 族的作用是**把同一类错误认成同一类**：路径里的数字、id、时间戳都不该让
 * 两次一模一样的失败看起来是两回事。
 * @param text - 错误文本。
 * @returns 族标识。
 */
function errorFamilyOf(text: string | undefined): string {
  if (text === undefined || text === '') return 'unknown'
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  return firstLine.replace(/\d+/g, '#').slice(0, 200)
}

/**
 * 把参数规范化成可比较的字符串（键排序）。
 * @param value - 参数值。
 * @returns 规范化后的 JSON 文本。
 */
function canonicalize(value: unknown): string {
  return JSON.stringify(sortJsonValue(value))
}

/**
 * 深拷贝一份键排序后的 JSON 值。
 * @param value - 任意值。
 * @returns 排序后的副本。
 */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (isPlainRecord(value)) {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) sorted[key] = sortJsonValue(value[key])
    return sorted
  }
  return value
}

/**
 * 造一台工具级失控守卫。
 *
 * 三种可提醒信号（顺序即官方提醒优先级）：
 *
 * 1. `same_error_family` —— 同一个工具连续报同一族错误；
 * 2. `exact_action_repeat` —— 同一次动作（同名 + 同参数）立刻重复；
 * 3. `polling_repeat` —— 连续轮询同一个后台任务而输出没变。
 *
 * `abab_action_cycle`（A B A B 的循环）**只记录不提醒**：官方把它排在提醒
 * 候选之外——模型在两个动作之间来回跳时，提醒它「别重复」是没有意义的。
 *
 * 每轮**至多一条**提醒：官方在发出第一条后就把本轮的提醒机会用掉了。
 *
 * @param options - 守卫选项。
 * @returns 守卫。
 */
export function createMinimaxRunawayGuard(
  options: MinimaxRunawayGuardOptions = {},
): MinimaxRunawayGuard {
  const threshold = options.remindAfterOccurrences ?? DEFAULT_REMIND_AFTER_OCCURRENCES

  /** 同一次动作的连击。 */
  let actionStreak: { key: string; count: number } | undefined
  /** 同一族错误的连击（键是工具名 + 错误族）。 */
  const errorStreaks = new Map<string, { toolName: string; count: number }>()
  /** 轮询连击（键是工具名）。 */
  const pollingStreaks = new Map<string, { key: string; count: number }>()
  /** 最近几次动作，用来认 A B A B 的循环。 */
  const recentActions: string[] = []
  /** 当前正在计数的 A B 循环对。 */
  let activeAbabKey: string | undefined
  /** 本轮是否已经提醒过。 */
  let reminderAttempted = false
  /** 观察到的信号。 */
  const signals: MinimaxRunawaySignal[] = []

  /**
   * 记一条信号。
   * @param kind - 信号种类。
   * @param occurrences - 连击次数。
   * @param toolName - 工具名。
   */
  const record = (kind: MinimaxRunawaySignalKind, occurrences: number, toolName: string): void => {
    signals.push({ kind, occurrences, toolName })
  }

  /**
   * 判断这次执行是不是一次「原地不动」的轮询。
   * @param observation - 观察事实。
   * @returns 是轮询时为 true。
   */
  const isPolling = (observation: MinimaxRunawayObservation): boolean => {
    if (!POLLING_TOOL_NAMES.includes(observation.toolName)) return false
    const args = isPlainRecord(observation.arguments) ? observation.arguments : undefined
    // wait=true 是「等它结束」，不是轮询；它打断轮询连击。
    return args?.['wait'] !== true
  }

  return {
    observe(observation: MinimaxRunawayObservation): MinimaxRunawayReminder | undefined {
      const toolName = observation.toolName
      const actionKey = `${toolName}\u0000${canonicalize(observation.arguments)}`
      // 轮询类工具**不**计入「同一次动作重复」：官方给轮询工具单开一条策略，
      // 它们只由 polling_repeat 计数。否则「等一个后台任务」会被说成「同一个
      // 动作立刻重复」，而那正是模型该做的事。
      const countsAsAction = !POLLING_TOOL_NAMES.includes(toolName)

      // 1) 同一次动作立刻重复。
      if (countsAsAction) {
        if (actionStreak?.key === actionKey) actionStreak = { key: actionKey, count: actionStreak.count + 1 }
        else actionStreak = { key: actionKey, count: 1 }
        record('exact_action_repeat', actionStreak.count, toolName)
      }

      // 2) A B A B 的循环：只记，不提醒。
      if (countsAsAction) {
        recentActions.push(actionKey)
        if (recentActions.length > 4) recentActions.shift()
        if (recentActions.length === 4) {
          const [a, b, c, d] = recentActions
          if (a !== undefined && b !== undefined && a !== b && a === c && b === d) {
            const episode = `${a}\u0000${b}`
            if (activeAbabKey !== episode) {
              activeAbabKey = episode
              record('abab_action_cycle', 2, toolName)
            }
          } else {
            activeAbabKey = undefined
          }
        }
      }

      // 3) 同一族错误连击。
      if (observation.isError === true) {
        const family = observation.errorCode ?? errorFamilyOf(observation.errorText)
        const key = `${toolName}\u0000${family}`
        const previous = errorStreaks.get(key)
        const count = previous === undefined ? 1 : previous.count + 1
        errorStreaks.set(key, { toolName, count })
        record('same_error_family', count, toolName)
      } else {
        // 这个工具成功了：它的错误连击到此为止。
        for (const [key, entry] of [...errorStreaks]) {
          if (entry.toolName === toolName) errorStreaks.delete(key)
        }
      }

      // 4) 轮询连击。
      if (isPolling(observation)) {
        // 「原地不动」= 同一个任务 + 同一份输出。任务变了或者输出变了，计数归零。
        const key = `${toolName}\u0000${canonicalize(observation.arguments)}\u0000${observation.resultText ?? ''}`
        const previous = pollingStreaks.get(toolName)
        const count = previous !== undefined && previous.key === key ? previous.count + 1 : 1
        pollingStreaks.set(toolName, { key, count })
        record('polling_repeat', count, toolName)
      } else {
        pollingStreaks.delete(toolName)
      }

      if (reminderAttempted) return undefined

      // 提醒优先级：同族错误 > 同一次动作重复 > 反复轮询（官方顺序）。
      const errorCandidate = [...errorStreaks.values()].find(entry => entry.count >= threshold)
      if (errorCandidate !== undefined) {
        reminderAttempted = true
        return {
          kind: 'same_error_family',
          occurrences: errorCandidate.count,
          text: renderSameErrorFamilyReminder(errorCandidate.count),
        }
      }
      if (countsAsAction && actionStreak !== undefined && actionStreak.count >= threshold) {
        reminderAttempted = true
        return {
          kind: 'exact_action_repeat',
          occurrences: actionStreak.count,
          text: renderExactActionRepeatReminder(actionStreak.count),
        }
      }
      const pollingCandidate = [...pollingStreaks.values()].find(entry => entry.count >= threshold)
      if (pollingCandidate !== undefined) {
        reminderAttempted = true
        return {
          kind: 'polling_repeat',
          occurrences: pollingCandidate.count,
          text: renderPollingRepeatReminder(pollingCandidate.count),
        }
      }
      return undefined
    },
    reset(): void {
      actionStreak = undefined
      errorStreaks.clear()
      pollingStreaks.clear()
      recentActions.length = 0
      activeAbabKey = undefined
      reminderAttempted = false
    },
    get signals(): readonly MinimaxRunawaySignal[] {
      return signals
    },
  }
}

/** 工具注册面（本模块用到的两条接缝）。 */
interface ToolsLike {
  /** 注册一条单调守卫；返回注销器。 */
  guard?: (guard: (execution: unknown) => string | undefined) => (() => void) | undefined
  /** 查一个工具的定义。 */
  get?: (name: string, scope?: unknown) => unknown
}

/** 本模块读得到的宿主上下文（结构化类型，不绑定具体 SDK 版本）。 */
export interface MinimaxRuntimeEnhancementsContext {
  /** Cordis 的副作用登记。 */
  effect?<T>(execute: () => T, label?: string): unknown
  /** Cordis 的事件总线。 */
  on?(event: string, listener: (...args: never[]) => unknown): () => void
  /** 服务查找：**调用时**读可选服务。 */
  get?(name: string): unknown
  /** 工具注册面（没走 `get` 时的兜底读法）。 */
  readonly tools?: unknown
}

/**
 * 读宿主上下文上的工具注册面。
 * @param ctx - 宿主上下文。
 * @returns 工具注册面；没有时为 undefined。
 */
function toolsServiceOf(ctx: MinimaxRuntimeEnhancementsContext): ToolsLike | undefined {
  const read = ctx.get
  if (typeof read === 'function') {
    try {
      const found = read.call(ctx, 'tools')
      if (found !== undefined) return found as ToolsLike
    } catch {
      // 服务缺席或正在拆除：走下面的兜底读法。
    }
  }
  const direct = ctx.tools
  return direct === undefined ? undefined : (direct as ToolsLike)
}

/**
 * 判断一个会话是不是处于 PTC 模式（模型只能直接调 `run_code`）。
 *
 * 三个来源，按可靠性排序：
 *
 * 1. **注册表自己的判定面**（结构探测 `modeFor`）：这是宿主真正用来决定
 *    「这个作用域是 native 还是 ptc」的那一个函数，读到的就是事实。
 * 2. **保留通道的可见性**（公开 API `get('run_code', scope)`）：`run_code` 这条
 *    传输通道只对 PTC 作用域可见，所以「能不能查到它」就是同一个问题的公开问法。
 * 3. **agent 自己声明的呈现模式**：宿主选项里直接写了 `ptc` 时的兜底。
 *
 * 读不出来时**当作不是 PTC**：提醒是加法，不是减法，宁可少提醒也不要在
 * native 会话里催模型去用 `run_code`。
 *
 * @param agent - 调用方 agent。
 * @param tools - 工具注册面。
 * @returns 处于 PTC 模式时为 true。
 */
export function isPtcSessionOf(agent: unknown, tools: unknown): boolean {
  const mode = declaredModeOf(tools, agent)
  if (mode !== undefined) return mode
  if (runCodeTransportVisible(tools, agent) === true) return true
  return declaredPresentationOf(agent) === 'ptc'
}

/**
 * 读注册表自己的呈现模式判定面。
 * @param tools - 工具注册面。
 * @param agent - 调用方 agent。
 * @returns true/false 表示读到了；undefined 表示这一代宿主没有这条接缝。
 */
function declaredModeOf(tools: unknown, agent: unknown): boolean | undefined {
  const record = isRecord(tools) ? (tools as { modeFor?: (scope: unknown) => unknown }) : undefined
  const modeFor = record?.modeFor
  if (typeof modeFor !== 'function') return undefined
  try {
    const mode = modeFor.call(tools, agent)
    if (mode === 'ptc') return true
    if (mode === 'native') return false
  } catch {
    // 这一代宿主没有这条接缝，或它正在拆除。
  }
  return undefined
}

/**
 * 看 `run_code` 这条保留通道对这个作用域是否可见。
 * @param tools - 工具注册面。
 * @param agent - 调用方 agent。
 * @returns true/false 表示读到了；undefined 表示这一代宿主没有这条接缝。
 */
function runCodeTransportVisible(tools: unknown, agent: unknown): boolean | undefined {
  const record = isRecord(tools) ? (tools as { get?: (name: string, scope?: unknown) => unknown }) : undefined
  const get = record?.get
  if (typeof get !== 'function') return undefined
  try {
    return get.call(tools, 'run_code', agent) !== undefined
  } catch {
    return undefined
  }
}

/**
 * 读 agent 自己声明的呈现模式。
 * @param agent - 调用方 agent。
 * @returns 'ptc' / 'native' / undefined。
 */
function declaredPresentationOf(agent: unknown): 'ptc' | 'native' | undefined {
  const record = isRecord(agent) ? agent : undefined
  const options = isRecord(record?.['options']) ? (record?.['options'] as Record<string, unknown>) : undefined
  const agentOptions = isRecord(record?.['agentOptions']) ? (record?.['agentOptions'] as Record<string, unknown>) : undefined
  const preset = isRecord(record?.['preset']) ? (record?.['preset'] as Record<string, unknown>) : undefined
  const candidates: unknown[] = [
    options?.['presentation'],
    options?.['toolPresentation'],
    options?.['toolsMode'],
    options?.['mode'],
    agentOptions?.['presentation'],
    preset?.['presentation'],
  ]
  for (const candidate of candidates) {
    if (candidate === 'ptc') return 'ptc'
    if (candidate === 'native') return 'native'
  }
  return undefined
}

/**
 * 判断一次工具执行是不是「模型直接调了原生工具」。
 *
 * 直接调用的判据是**没有父调用**：嵌套调用（`run_code` 程序里的子调用）带
 * 父标记，直接调用不带。DSH 用 `parent` 这枚不透明令牌，官方 minimax-code
 * 用 `parentToolCallId`，两个都认。
 *
 * @param exec - 工具执行。
 * @returns 直接调用时为 true。
 */
export function isDirectToolCall(exec: unknown): boolean {
  const record = isRecord(exec) ? exec : undefined
  if (record?.['parent'] !== undefined) return false
  if (record?.['parentToolCallId'] !== undefined) return false
  return true
}

/**
 * 读一次执行是不是「模型直接调了需要提醒的原生工具」。
 * @param exec - 工具执行。
 * @returns 工具名；不是这类调用时为 undefined。
 */
export function directCallToolNameOf(exec: unknown): string | undefined {
  const record = isRecord(exec) ? exec : undefined
  const name = stringOf(record?.['name'])
  if (name === undefined || !DIRECT_CALL_REMINDER_TOOLS.includes(name)) return undefined
  if (!isDirectToolCall(exec)) return undefined
  return name
}

/**
 * 把一条 post-execute 决策接上附加上下文，保住它原有的形状。
 * @param decision - `next()` 交回来的决策。
 * @param contexts - 要追加的上下文。
 * @returns 追加后的决策。
 */
function withAdditionalContexts(decision: PostToolDecision, contexts: UserMessage[]): PostToolDecision {
  const additionalContexts = [...decision.additionalContexts ?? [], ...contexts]
  if (decision.kind === 'block') {
    return { kind: 'block', feedback: decision.feedback, additionalContexts }
  }
  if (decision.value !== undefined) {
    return { kind: 'accept', value: decision.value, additionalContexts }
  }
  if (decision.content !== undefined) {
    return { kind: 'accept', content: decision.content, additionalContexts }
  }
  return { kind: 'accept', additionalContexts }
}

/**
 * 造一条 PTC 直调提醒上下文。
 * @param toolName - 被直接调用的工具名。
 * @returns 可直接放进 `additionalContexts` 的用户角色消息。
 */
function createDirectCallReminder(toolName: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: renderDirectCallReminder([toolName]) }],
    source: {
      kind: 'minimax-direct-call-reminder',
      form: 'notice',
      summary: `PTC direct call: ${toolName}`,
    },
  })
}

/**
 * 造一条失控守卫提醒上下文。
 * @param reminder - 提醒。
 * @returns 可直接放进 `additionalContexts` 的用户角色消息。
 */
function createRunawayReminder(reminder: MinimaxRunawayReminder): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: reminder.text }],
    source: {
      kind: 'minimax-runaway-guard',
      form: 'notice',
      summary: `runaway guard: ${reminder.kind} x${reminder.occurrences}`,
    },
  })
}

/**
 * 读一次执行的结果是不是失败。
 * @param result - 工具执行结果。
 * @returns 失败时为 true。
 */
function isErrorResult(result: unknown): boolean {
  return isRecord(result) && result['isError'] === true
}

/**
 * 读一次执行的结构化错误码。
 * @param result - 工具执行结果。
 * @returns 错误码；没有时为 undefined。
 */
function errorCodeOf(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined
  const error = result['error']
  if (!isRecord(error)) return undefined
  const info = error['info']
  if (!isRecord(info)) return undefined
  return stringOf(info['code'])
}

/**
 * 读一次执行的失败文本。
 * @param result - 工具执行结果。
 * @returns 失败文本；没有时为 undefined。
 */
function errorTextOf(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined
  const error = result['error']
  if (!isRecord(error)) return undefined
  return stringOf(error['message'])
}

/**
 * 读一次执行的结果文本（轮询判定用）。
 * @param result - 工具执行结果。
 * @returns 结果文本；没有时是空串。
 */
function resultTextOf(result: unknown): string {
  if (!isRecord(result)) return ''
  const content = result['content']
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (isRecord(block) && block['type'] === 'text') parts.push(stringOf(block['text']) ?? '')
  }
  return parts.join('\n')
}

/**
 * 找一次工具调用的参数 schema。
 * @param tools - 工具注册面。
 * @param name - 工具名。
 * @param agent - 调用方 agent。
 * @returns JSON Schema；找不到时为 undefined。
 */
function schemaOf(tools: ToolsLike | undefined, name: string, agent: unknown): unknown {
  const get = tools?.get
  if (typeof get !== 'function') return undefined
  try {
    const definition = get.call(tools, name, agent)
    if (!isRecord(definition)) return undefined
    return definition['parameters']
  } catch {
    return undefined
  }
}

/**
 * 就地把一次执行的参数改成修复后的形状。
 *
 * **尽力而为**：新一代宿主把执行参数**冻结**了（`deepFreeze`），写回会抛，
 * 于是这次修复在那一代上落不了地 —— 但函数本身不抛，调用方也拿不到错误。
 * 老一代宿主不冻结参数时，写回是真正生效的。
 *
 * @param execution - 工具执行。
 * @param tools - 工具注册面。
 */
function repairExecutionArguments(execution: unknown, tools: ToolsLike | undefined): void {
  const record = isRecord(execution) ? execution : undefined
  const args = record?.['arguments']
  if (!isPlainRecord(args)) return
  const name = stringOf(record?.['name'])
  if (name === undefined) return
  const agent = record?.['agent']
  const schema = schemaOf(tools, name, agent)
  const repaired = repairMinimaxToolArguments(name, args, schema)
  if (repaired.fixes.length === 0) return
  const target = repaired.value
  if (!isPlainRecord(target)) return
  try {
    for (const key of Object.keys(args)) {
      if (!(key in target)) delete (args as Record<string, unknown>)[key]
    }
    Object.assign(args, target)
  } catch {
    // 参数被冻结：这一代宿主上写不回去，安静放弃。
  }
}

/**
 * 装上 MiniMax Code 的运行时增强。
 *
 * @param ctx - 宿主插件上下文。
 * @param options - 增强选项。
 * @returns 卸载函数。
 */
export function installMinimaxRuntimeEnhancements(
  ctx: MinimaxRuntimeEnhancementsContext,
  options: { remindAfterOccurrences?: number } = {},
): () => void {
  /** 登记一个副作用；上下文没有 effect 时立即执行（测试用假上下文）。 */
  const track = (execute: () => unknown, label: string): void => {
    if (typeof ctx.effect === 'function') ctx.effect(execute, label)
    else execute()
  }

  const tools = toolsServiceOf(ctx)
  /** 每个 agent 一台守卫：连击是**这个会话**的事。 */
  const guards = new WeakMap<object, MinimaxRunawayGuard>()
  /**
   * 没有 agent 的执行（有人绕过 agent-loop 直接调 `ctx.tools.execute`）共用这一台。
   *
   * 它是**一台**，不是每次新建：连击要跨调用累积，新建一台等于永远停在第一次。
   */
  const agentlessGuard = createMinimaxRunawayGuard(options)

  /**
   * 取一个 agent 的守卫。
   * @param agent - 调用方 agent。
   * @returns 守卫。
   */
  const guardOf = (agent: unknown): MinimaxRunawayGuard => {
    const key = isRecord(agent) ? agent : undefined
    if (key === undefined) return agentlessGuard
    const existing = guards.get(key)
    if (existing !== undefined) return existing
    const created = createMinimaxRunawayGuard(options)
    guards.set(key, created)
    return created
  }

  // 1) 参数修复：守卫面。守卫**永远不拦**，只改参数。
  track(() => {
    if (typeof tools?.guard !== 'function') return () => undefined
    const dispose = tools.guard((execution: unknown) => {
      try {
        const agent = isRecord(execution) ? execution['agent'] : undefined
        if (!isMinimaxSession(agent)) return undefined
        repairExecutionArguments(execution, tools)
      } catch {
        // 修复失败不该让这一次工具调用失败。
      }
      return undefined
    })
    return () => { dispose?.() }
  }, 'dsh-chatgpt-subscription: minimax argument repair guard')

  // 2) 参数修复：pre-execute 面（同一份修复，早一步做）。
  const disposePreExecute = ctx.on?.('tools/pre-execute', (async (
    exec: ToolExecution,
    next: () => Promise<unknown>,
  ): Promise<unknown> => {
    // 先修再转交：后来的 pre-execute 监听器看到的应该是修好的参数。
    try {
      if (isMinimaxSession((exec as { agent?: unknown }).agent)) {
        repairExecutionArguments(exec, tools)
      }
    } catch {
      // 修复失败不该影响这一次调用。
    }
    return next()
  }) as never)

  // 3) 直调提醒 + 失控守卫：post-execute 面。
  const disposePostExecute = ctx.on?.('tools/post-execute', (async (
    exec: ToolExecution,
    result: unknown,
    next: () => Promise<PostToolDecision>,
  ): Promise<PostToolDecision> => {
    const decision = await next()
    try {
      const agent = (exec as { agent?: unknown }).agent
      if (!isMinimaxSession(agent)) return decision
      const contexts: UserMessage[] = []

      const directName = directCallToolNameOf(exec)
      if (directName !== undefined && isPtcSessionOf(agent, tools)) {
        contexts.push(createDirectCallReminder(directName))
      }

      const reminder = guardOf(agent).observe({
        toolName: exec.name,
        arguments: exec.arguments,
        isError: isErrorResult(result),
        errorCode: errorCodeOf(result),
        errorText: errorTextOf(result),
        resultText: resultTextOf(result),
      })
      if (reminder !== undefined) contexts.push(createRunawayReminder(reminder))

      if (contexts.length === 0) return decision
      return withAdditionalContexts(decision, contexts)
    } catch {
      // 旁路：任何一步失败都不该影响这一步本身。
      return decision
    }
  }) as never)

  // 4) 新的一轮用户输入：连击归零（官方在 turn 结束时清检测连击）。
  const disposePreStep = ctx.on?.('agent/pre-step', (async (
    payload: { agent?: unknown; messages?: unknown[] },
    next: () => Promise<unknown>,
  ): Promise<unknown> => {
    const decision = await next()
    try {
      const messages = Array.isArray(payload?.messages) ? payload.messages : []
      const isNewUserTurn = messages.some(message => {
        const source = isRecord(message) ? message['source'] : undefined
        return isRecord(source) && source['kind'] === 'user'
      })
      if (!isNewUserTurn) return decision
      const agent = payload?.agent
      if (isRecord(agent)) guards.get(agent)?.reset()
    } catch {
      return decision
    }
    return decision
  }) as never)

  // 5) agent 拆除：这台会话的连击计数一起走。
  const disposeDisposed = ctx.on?.('agent/disposed', ((payload: { agent?: unknown }) => {
    const agent = payload?.agent
    if (isRecord(agent)) guards.delete(agent)
  }) as never)

  return () => {
    disposePreExecute?.()
    disposePostExecute?.()
    disposePreStep?.()
    disposeDisposed?.()
  }
}
