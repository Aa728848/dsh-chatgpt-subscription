/**
 * Code Mode 的工具执行器：本包遮蔽与拒绝的唯一接缝。
 *
 * ## 为什么是 executor
 *
 * DSH 0.2.2 把「模型看到的工具清单」的归属权从 `system-prompt/assemble` 瀑布搬到了
 * per-scope `ToolExecutor`：注册表向当前作用域选中的 executor 要 schema，所以
 * `describe()` 就是请求面。它同时解决了归属问题——executor **按作用域链选择**，只有挂
 * 在本预设里的这一份会服务本预设的会话，因此不需要判断「这个 agent 是不是我的」。
 *
 * 三件事：
 *
 * 1. `describe()` 丢掉一切不该出现在模型清单里的名字，其余交给原生 executor 投影；
 * 2. `sections` 提供**恒定**的 Code Mode 说明段（见 rules.ts 的恒定契约）；
 * 3. `execute()` 在派发**之前**拒绝模型对被遮蔽名字的直接调用，其余整批委托给原生
 *    executor——委托而不是重写，是因为手写 pre-policy / 审批 / around-dispatch /
 *    post-execute 管线正是插件静默丢策略的方式。
 *
 * ## 程序内子调用怎么与模型直呼区分
 *
 * 批量 `execute()` 的入参没有 `parent` 字段（执行令牌由注册表自己的管线铸造，插件
 * 造不出来），所以传输层把自己持有的 `AbortSignal` 打上 {@link NESTED_MARK}，并让子调用 id
 * 形如 `<outer>:ptc:<n>`。signal 是模型无法伪造的对象，call id 不可改，两个标记互为兜底。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/host/codemode/executor
 */

import {
  isMaskedName,
  summarizeHidden,
  type CodemodeRules,
  type CodemodeView,
} from './rules.ts'

/** 传输层打在 AbortSignal 上的嵌套标记。 */
export const NESTED_MARK = Symbol.for('dsh-chatgpt-subscription.codemode.nested')

/** 子调用 id 里的一段：`<outer>:ptc:<n>`，与内核自己的命名一致。 */
export const NESTED_CALL_ID_MARKER = ':ptc:'

/**
 * 给一个 signal 打上嵌套标记。
 *
 * @param signal - 传给 `tools.execute()` 的那一个 signal。
 * @returns 同一个 signal（便于链式使用）。
 */
export function markNested(signal: AbortSignal | undefined): AbortSignal | undefined {
  if (signal === undefined) return undefined
  try {
    Object.defineProperty(signal, NESTED_MARK, { value: true, enumerable: false, configurable: true })
  } catch {
    // 冻结的 signal 仍带 `:ptc:` call id，两个标记互为兜底。
  }
  return signal
}

/**
 * 判断一批调用是不是来自程序内部。
 *
 * @param call - 批里的一条调用（结构探测）。
 * @param batchSignal - 批级 signal（`tools.execute()` 只收一份，注册表会复制给每条执行）。
 * @returns 来自程序内部时为 `true`。
 */
export function isNestedCall(call: unknown, batchSignal: unknown): boolean {
  if (isMarked(batchSignal)) return true
  if (typeof call !== 'object' || call === null) return false
  if (isMarked((call as { signal?: unknown }).signal)) return true
  const id = (call as { id?: unknown }).id
  return typeof id === 'string' && id.includes(NESTED_CALL_ID_MARKER)
}

/** 一个值是否带着本包的嵌套标记。 */
function isMarked(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[NESTED_MARK] === true
}

/** 执行器对外暴露的能力（结构契约，不 import 内核类型）。 */
export interface CodemodeExecutor {
  /** 执行器自带的提示词段。 */
  readonly sections: readonly CodemodeSection[]
  /** 本步的模型可见 schema。 */
  describe(tools: readonly unknown[]): { schemas: readonly unknown[] }
  /** 执行一整批调用。 */
  execute(input: CodemodeBatchInput): Promise<CodemodeBatchResult>
}

/** 一条 executor 所属的提示词段。 */
export interface CodemodeSection {
  /** 段名。 */
  readonly name: string
  /** 排序位。 */
  readonly order?: number
  /** 是否做 `{{variable}}` 插值。 */
  readonly interpolate?: boolean
  /** 段正文（恒定）。 */
  readonly text: string | ((tools: readonly unknown[]) => string)
}

/** 批入参里本模块会读的部分。 */
export interface CodemodeBatchInput {
  /** 原始调用。 */
  readonly calls: readonly unknown[]
  /** 批级 signal。 */
  readonly signal: AbortSignal
  /** 辅助字段透传。 */
  readonly [key: string]: unknown
}

/** 批结果。 */
export interface CodemodeBatchResult {
  /** 与入参一一对应的结果。 */
  readonly results: readonly unknown[]
  /** 需要附加到下一步的上下文。 */
  readonly additionalContexts: readonly unknown[]
  /** 本批是否结束了这一轮。 */
  readonly concluded: boolean
}

/** 委托目标（原生 executor 的实例，结构描述）。 */
export interface DelegateExecutor {
  /** 见 {@link CodemodeExecutor.describe}。 */
  describe(tools: readonly unknown[]): { schemas: readonly unknown[] }
  /** 见 {@link CodemodeExecutor.execute}。 */
  execute(input: CodemodeBatchInput): Promise<CodemodeBatchResult>
}

/** 执行器钩子。 */
export interface ExecutorHooks {
  /** 归属视图（整个清单）。 */
  view(): CodemodeView
  /** 归属视图（单个名字，供拒绝路径使用）。 */
  viewForName(name: string): CodemodeView
  /** 说明段正文。 */
  sectionText(): string
  /** 每次 describe 收到的完整定义集（含被遮蔽的），供程序内清单使用。 */
  onCatalog?(tools: readonly unknown[]): void
  /** 每次 describe 的决策（写日志 / debug 环）。 */
  onDescribe?(decision: DescribeDecision): void
  /** 委托目标；缺省时执行器不可用（入口保证它存在）。 */
  delegate: DelegateExecutor
}

/** 一次 describe 的决策。 */
export interface DescribeDecision {
  /** 保持原生的名字。 */
  readonly visible: readonly string[]
  /** 被遮蔽的名字。 */
  readonly masked: readonly string[]
}

/**
 * 造一个 Code Mode 执行器。
 *
 * @param ctx - 本包的行上下文（读取系统提示段的排序位）。
 * @param rules - 已归一化的规则。
 * @param hooks - 归属视图、说明段与委托目标。
 * @returns 执行器。
 */
export function createCodemodeExecutor(
  ctx: unknown,
  rules: CodemodeRules,
  hooks: ExecutorHooks,
): CodemodeExecutor {
  const sectionOrder = sectionOrderOf(ctx)
  const sections: CodemodeSection[] = rules.options.sdkSection
    ? [{ name: 'tools:sdk', order: sectionOrder, interpolate: false, text: () => hooks.sectionText() }]
    : []
  const visibleNames = new Set<string>()

  return {
    sections,
    describe(tools) {
      hooks.onCatalog?.(tools ?? [])
      const view = hooks.view()
      const visible: unknown[] = []
      const masked: string[] = []
      visibleNames.clear()
      for (const tool of tools ?? []) {
        const name = nameOf(tool)
        if (name === undefined) continue
        if (isMaskedName(name, rules, view)) masked.push(name)
        else {
          visible.push(tool)
          visibleNames.add(name)
        }
      }
      hooks.onDescribe?.({ visible: [...visibleNames], masked })
      return hooks.delegate.describe(visible)
    },
    async execute(input) {
      const calls = Array.isArray(input?.calls) ? input.calls : []
      const denials = new Map<number, string>()
      if (rules.options.guard) {
        for (let index = 0; index < calls.length; index += 1) {
          const reason = denialFor(calls[index], rules, hooks, input?.signal)
          if (reason !== undefined) denials.set(index, reason)
        }
      }
      if (denials.size === 0) return hooks.delegate.execute(input)
      // 整批在派发前结束：委托方会先跑允许的兄弟调用，半执行的批比干净拒绝更难自愈。
      const results = calls.map((call, index) => {
        const callId = idOf(call) ?? 'call-' + String(index)
        const reason = denials.get(index)
          ?? 'This call was not run: the batch also contained a call that is not part of this session tool list. Re-issue it on its own.'
        return {
          callId,
          result: {
            isError: true,
            error: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL', message: reason },
            content: [{ type: 'text', text: 'Error: ' + reason }],
          },
        }
      })
      return { results, additionalContexts: [], concluded: false }
    },
  }
}

/**
 * 一条模型直呼调用的拒绝理由，或 `undefined` 表示放行。
 *
 * @param call - 批里的一条调用。
 * @param rules - 已归一化的规则。
 * @param hooks - 归属视图与说明段。
 * @param batchSignal - 批级 signal。
 * @returns 拒绝理由或 `undefined`。
 *
 * 判定不读「本步可见名清单」：那份集合是**执行器级**的，多个会话并发时会被后一次 describe
 * 覆盖，用它放行等于给另一个会话开一个不该开的口子。这里只按名字自身的归属判一次。
 */
export function denialFor(
  call: unknown,
  rules: CodemodeRules,
  hooks: Pick<ExecutorHooks, 'viewForName' | 'sectionText'>,
  batchSignal: unknown,
): string | undefined {
  if (typeof call !== 'object' || call === null) return undefined
  const name = (call as { name?: unknown }).name
  if (typeof name !== 'string' || name.length === 0) return undefined
  if (isNestedCall(call, batchSignal)) return undefined
  // 传输工具永远可调：它是模型够到其它工具的唯一途径。
  if (name === rules.options.runToolName) return undefined
  if (!isMaskedName(name, rules, hooks.viewForName(name))) return undefined
  if (rules.options.metaTools.includes(name)) {
    return 'The discovery tool "' + name + '" is callable only from inside ' + rules.options.runToolName
      + ': run a program and call await tools.' + name + '(...) there.'
  }
  const searchTool = rules.options.metaTools[1] ?? rules.options.metaTools[0] ?? 'code_tools_search'
  return 'The tool "' + name + '" is not part of this session tool list. In Code Mode, tools this preset does not own '
    + '(MCP servers, plugins outside the preset) are reachable only from inside ' + rules.options.runToolName + ': call '
    + 'tools.' + searchTool + '({ query: "..." }) there to discover it, then call it by exact name.'
}

/** 读一段工具定义的 ``name``。 */
function nameOf(tool: unknown): string | undefined {
  if (typeof tool !== 'object' || tool === null) return undefined
  const name = (tool as { name?: unknown }).name
  return typeof name === 'string' && name.length > 0 ? name : undefined
}

/** 读一条调用的 id。 */
function idOf(call: unknown): string | undefined {
  if (typeof call !== 'object' || call === null) return undefined
  const id = (call as { id?: unknown }).id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** 取 `tools:sdk` 的排序位；取不到时退回 5000（内核 TOOLS_SDK 的默认位）。 */
function sectionOrderOf(ctx: unknown): number {
  try {
    const systemPrompt = (ctx as { get?: (name: string) => unknown })?.get?.('systemPrompt')
    const order = (systemPrompt as { getSectionOrder?: (name: string) => unknown })?.getSectionOrder?.('TOOLS_SDK')
    return typeof order === 'number' && Number.isFinite(order) ? order : 5000
  } catch {
    return 5000
  }
}
