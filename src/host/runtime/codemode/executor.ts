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
  /** 重置指定 Agent 的常驻程序环境（对齐内核 `PtcExecutor.reset`）。 */
  reset?(agent: unknown): Promise<void>
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
  /** 重置指定 Agent 的常驻程序环境（对齐内核 `PtcExecutor.reset`）。 */
  reset?(agent: unknown): Promise<void>
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
    ...(typeof hooks.reset === 'function'
      ? {
          async reset(agent: unknown): Promise<void> {
            await hooks.reset!(agent)
          },
        }
      : {}),
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
export function sectionOrderOf(ctx: unknown): number {
  try {
    const systemPrompt = (ctx as { get?: (name: string) => unknown })?.get?.('systemPrompt')
    const order = (systemPrompt as { getSectionOrder?: (name: string) => unknown })?.getSectionOrder?.('TOOLS_SDK')
    return typeof order === 'number' && Number.isFinite(order) ? order : 5000
  } catch {
    return 5000
  }
}

/** 轻量动态工具源契约（对齐 DSH 0.2.3-alpha.3+ `ToolSource`）。 */
export interface CodemodeToolSource {
  get(name: string, scope?: object): unknown
  getAll(scope?: object): readonly unknown[]
}

/** DSH 0.2.3-alpha.3+ 可组合根注册表（对齐 `ToolRegistry`），供 `ctx.tools.setRoot()` 使用。 */
export interface CodemodeRootRegistry extends CodemodeToolSource {
  register(tool: unknown): () => void
  include(source: CodemodeToolSource): () => void
  /** 直接查询未遮蔽的底层绑定源（绝不回读 `ctx.tools`，避免 `ToolCompositionError`）。 */
  readonly sourceView: { get(name: string, scope?: object): unknown }
  /** 枚举程序内可用绑定（含被遮蔽工具）；带 `toolStep` 时首次查询即钉死该步绑定。 */
  bindings(scope?: object, toolStep?: unknown): readonly unknown[]
  /** 解析单条程序内绑定；带 `toolStep` 时校验其与该步钉死定义一致。 */
  binding(name: string, scope?: object, toolStep?: unknown): unknown
  /** 重置指定 Agent 的常驻程序环境。 */
  reset?(agent: unknown): Promise<void>
}

/** 构造 {@link CodemodeRootRegistry} 的钩子。 */
export interface RootRegistryHooks {
  /** 基于未遮蔽绑定源建立整表归属视图。 */
  view(names: readonly string[], sourceView: { get(name: string, scope?: object): unknown }): CodemodeView
  /** 基于未遮蔽绑定源判定单个名字归属。 */
  viewForName(name: string, sourceView: { get(name: string, scope?: object): unknown }): CodemodeView
  /** 每次 `getAll` 观察到全量绑定时的回调。 */
  onCatalog?(tools: readonly unknown[]): void
  /** 每次面向模型投影后的决策回调。 */
  onDescribe?(decision: DescribeDecision): void
  /** `setRoot()` 同步初始化探针期间跳过日志与 debugRing 写入。 */
  isProbing?(): boolean
  /** 重置指定 Agent 的常驻程序环境。 */
  reset?(agent: unknown): Promise<void>
}

/**
 * 造一个面向 DSH 0.2.3-alpha.3+ `ctx.tools.setRoot()` 的 Code Mode 根注册表。
 *
 * - `include(registrations)` 接收 `ctx.tools` 自动注入的未遮蔽注册表视图；
 * - `get()` / `getAll()` 仅暴露原生白名单与传输工具，模型直呼被遮蔽工具时由内核自动以
 *   `UNKNOWN_TOOL` 拒绝；
 * - `bindings()` / `binding()` 向程序传输层暴露完整未遮蔽绑定，并按 `ToolStep` 钉死步骤视图。
 */
export function createCodemodeRootRegistry(
  rules: CodemodeRules,
  hooks: RootRegistryHooks,
): CodemodeRootRegistry {
  const own = new Map<string, unknown>()
  const sources: CodemodeToolSource[] = []
  const stepBindings = new WeakMap<object, ReadonlyMap<string, unknown>>()

  const resolveRaw = (name: string, scope?: object): unknown => {
    const direct = own.get(name)
    if (direct !== undefined) return direct
    for (const source of sources) {
      const found = source.get(name, scope)
      if (found !== undefined) return found
    }
    return undefined
  }

  const resolveAllRaw = (scope?: object): readonly unknown[] => {
    const out: unknown[] = [...own.values()]
    for (const source of sources) {
      const entries = source.getAll(scope)
      if (Array.isArray(entries)) {
        for (const entry of entries) out.push(entry)
      }
    }
    return out
  }

  const dedupeBindings = (list: readonly unknown[]): ReadonlyMap<string, unknown> => {
    const map = new Map<string, unknown>()
    for (const entry of list) {
      const name = nameOf(entry)
      if (name === undefined || map.has(name)) continue
      map.set(name, entry)
    }
    return map
  }

  const ensureStepBindings = (toolStep: object, fallbackScope?: object): ReadonlyMap<string, unknown> => {
    let declared = stepBindings.get(toolStep)
    if (declared === undefined) {
      const stepAgent = (toolStep as { readonly agent?: unknown }).agent
      const scope = typeof stepAgent === 'object' && stepAgent !== null ? stepAgent : fallbackScope
      declared = dedupeBindings(resolveAllRaw(scope))
      stepBindings.set(toolStep, declared)
    }
    return declared
  }

  const sourceView = {
    get: (name: string, scope?: object): unknown => resolveRaw(name, scope),
  }

  return {
    sourceView,
    register(tool: unknown): () => void {
      const toolName = nameOf(tool)
      if (toolName === undefined) return () => {}
      if (own.has(toolName)) {
        throw new Error(`tool "${toolName}" is already registered in codemode root registry`)
      }
      own.set(toolName, tool)
      return () => {
        if (own.get(toolName) === tool) own.delete(toolName)
      }
    },
    include(source: CodemodeToolSource): () => void {
      sources.push(source)
      return () => {
        const index = sources.indexOf(source)
        if (index >= 0) sources.splice(index, 1)
      }
    },
    get(name: string, scope?: object): unknown {
      const raw = resolveRaw(name, scope)
      if (raw === undefined) return undefined
      if (rules.options.guard && name !== rules.options.runToolName) {
        const view = hooks.viewForName(name, sourceView)
        if (isMaskedName(name, rules, view)) return undefined
      }
      return raw
    },
    getAll(scope?: object): readonly unknown[] {
      const all = resolveAllRaw(scope)
      hooks.onCatalog?.(all)
      const names: string[] = []
      for (const tool of all) {
        const name = nameOf(tool)
        if (name !== undefined) names.push(name)
      }
      const view = hooks.view(names, sourceView)
      const visible: unknown[] = []
      const visibleNames: string[] = []
      const masked: string[] = []
      for (const tool of all) {
        const name = nameOf(tool)
        if (name === undefined) continue
        if (isMaskedName(name, rules, view)) masked.push(name)
        else {
          visible.push(tool)
          visibleNames.push(name)
        }
      }
      if (hooks.isProbing?.() !== true) {
        hooks.onDescribe?.({ visible: visibleNames, masked })
      }
      return visible
    },
    bindings(scope?: object, toolStep?: unknown): readonly unknown[] {
      if (typeof toolStep === 'object' && toolStep !== null) {
        return [...ensureStepBindings(toolStep, scope).values()]
      }
      return [...dedupeBindings(resolveAllRaw(scope)).values()]
    },
    binding(name: string, scope?: object, toolStep?: unknown): unknown {
      const current = resolveRaw(name, scope)
      if (current === undefined || typeof toolStep !== 'object' || toolStep === null) return current
      return ensureStepBindings(toolStep, scope).get(name) === current ? current : undefined
    },
    ...(typeof hooks.reset === 'function'
      ? {
          async reset(agent: unknown): Promise<void> {
            await hooks.reset!(agent)
          },
        }
      : {}),
  }
}
