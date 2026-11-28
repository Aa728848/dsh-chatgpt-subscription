/**
 * 「Agent Teams 策略段前缀缓存守卫」—— 把内置 `team:policy` 段从 system 里摘掉，
 * 改为切开关时**尾部投递**一次。
 * @module @eddyskywalker/dsh-chatgpt-subscription/host/team-policy-cache-guard
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** 官方 Agent Teams 的指引段名。 */
export const TEAM_POLICY_SECTION = 'team:policy'

/** 官方 Agent Teams 的四个共享任务板工具名（DSH 0.2.3-alpha.3+ 通过 `AgentToolRegistry` + `ctx.tools.include()` 注入）。 */
export const TEAM_TOOL_NAMES: readonly string[] = Object.freeze([
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
])

const TEAM_TOOL_NAME_SET: ReadonlySet<string> = new Set(TEAM_TOOL_NAMES)

/** 尾部撤销通知的来源 kind（本包自有，见下方 MessageSourceMap 增补）。 */
export const TEAM_BOARD_NOTICE_SOURCE_KIND = 'team-board-notice'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 本包在 agent/pre-step 末尾追加的团队任务板提示（不是新的用户回合）。 */
    'team-board-notice': { kind: 'team-board-notice' } & { form?: 'notice', summary?: string }
  }
}

/** 开关关掉时补投的那句话。 */
const BOARD_OFF_NOTICE = 'The shared team task board was turned off. Ignore earlier guidance describing an '
  + 'available board and coordinate through list_agents and send_message.'

/** 守卫交回的句柄。 */
export interface TeamPolicyCacheGuard {
  /** 摘掉本守卫挂上的全部东西（幂等）。 */
  dispose(): void
}

/** 守卫选项。 */
export interface TeamPolicyCacheGuardOptions {
  /** 是否启用；每次装配与每步都重读，所以设置保存后下一步就生效。默认开启。 */
  readonly enabled?: () => boolean
}

/**
 * 从插件配置里读开关。
 * @param config - 插件配置（结构化：只读一个键）。
 * @returns 是否启用本守卫；未声明时按开启处理（宿主 schema 的默认值）。
 */
export function resolveTeamPolicyCacheGuardEnabled(
  config: { teamPolicyCacheGuard?: unknown } | undefined,
): boolean {
  return config?.teamPolicyCacheGuard !== false
}

/** 一次团队开关激活的守卫状态，按 agent 分桶。 */
interface GuardState {
  /** 最近一次捕获到的策略正文。 */
  policy: string
  /** 待投递的正文（只在本次激活还没投过时存在）。 */
  pending: string | undefined
  /** 本次激活投过没有。 */
  delivered: boolean
  /** 下一步要补投「已关闭」通知。 */
  revoked: boolean
}

/** 装配期见过 `team:policy` 段没有（用来判断守卫是不是在空转）。 */
interface GuardStats {
  /** 是否至少见过一次该段。 */
  seen: boolean
  /** 是否已经为「从没见过」报过警。 */
  warned: boolean
}

/** 事件订阅面。 */
interface EventHostLike {
  /** 订阅一个事件。 */
  on?(name: string, listener: (...args: never[]) => unknown): (() => void) | undefined
}

/** 日志面。 */
interface LoggerLike {
  /** 警告级日志。 */
  warn(message: string, ...rest: unknown[]): void
}

/** 注入面。 */
interface InjectHostLike {
  inject?(deps: string[], callback: (scope: unknown) => void): unknown
}

/** 轻量动态工具源结构（对齐 DSH 0.2.3-alpha.3+ `ToolSource`）。 */
interface ToolSourceLike {
  get(name: string, scope?: unknown): unknown
  getAll(scope?: unknown): readonly unknown[]
}

/** 工具注册面（只读我们用到的 `include`）。 */
interface ToolsRegistryLike {
  include?(source: ToolSourceLike, ...rest: unknown[]): unknown
}

type UnboundMethod = (this: unknown, ...args: unknown[]) => unknown

interface MethodTarget {
  holder: object
  name: string
  original: UnboundMethod
  descriptor: PropertyDescriptor | undefined
}

function serviceOf<T>(ctx: unknown, service: string): T | undefined {
  const read = (ctx as { get?: (name: string) => unknown } | undefined)?.get
  if (typeof read !== 'function') return undefined
  try {
    return read.call(ctx, service) as T | undefined
  } catch {
    return undefined
  }
}

function resolveMethodTarget(service: unknown, name: string): MethodTarget | undefined {
  if (typeof service !== 'object' || service === null) return undefined
  const own = service as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(own, name)) {
    const original = own[name]
    if (typeof original !== 'function') return undefined
    return {
      holder: own,
      name,
      original: original as UnboundMethod,
      descriptor: Object.getOwnPropertyDescriptor(own, name),
    }
  }
  const proto = Object.getPrototypeOf(service) as object | null
  if (proto === null || proto === (Object.prototype as object) || proto === (Function.prototype as object)) {
    return undefined
  }
  const original = (proto as Record<string, unknown>)[name]
  if (typeof original !== 'function') return undefined
  return {
    holder: proto,
    name,
    original: original as UnboundMethod,
    descriptor: Object.getOwnPropertyDescriptor(proto, name),
  }
}

/** 系统段（只读名字、正文与退役标记）。 */
interface AssembledSectionLike {
  /** 段名。 */
  name?: unknown
  /** 段正文。 */
  text?: unknown
  /** DSH 0.2.3+：该段注册已被卸载，正文为退役提示而非开启指引。 */
  retire?: unknown
}

/** 一次装配的呈现面。 */
interface PresentationLike {
  /** 已解析的段。 */
  sections?: AssembledSectionLike[]
}

/** 装配上下文里本守卫会读的部分。 */
interface AssembleContextLike {
  /** 本次装配的 scope（会话装配时就是 agent）。 */
  scope?: unknown
  /** 装配发起方 agent（部分宿主直接给 agent）。 */
  agent?: unknown
}

/** 一条 pre-step 决策。 */
interface PreStepDecisionLike {
  /** enter / reject。 */
  kind?: string
  /** 本步输入消息。 */
  messages?: unknown[]
}

/** pre-step 载荷。 */
interface PreStepPayloadLike {
  /** 本步 agent。 */
  agent?: { session?: unknown }
  /** 取消信号。 */
  signal?: { aborted?: boolean }
}

/** 没有 scope 的装配（会话标题之类）用的桶键。 */
const GLOBAL_KEY = Object.freeze({})

/**
 * 桶键：agent 对象本身，或全局桶。
 * @param value - scope / agent。
 * @returns WeakMap 键。
 */
function bucketOf(value: unknown): object {
  return typeof value === 'object' && value !== null ? value as object : GLOBAL_KEY
}

/**
 * 订阅一个事件。
 * @param ctx - 宿主上下文。
 * @param event - 事件名。
 * @param listener - 监听器。
 * @returns 解绑函数或 undefined。
 */
function subscribe(
  ctx: unknown,
  event: string,
  listener: (...args: never[]) => unknown,
): (() => void) | undefined {
  const on = (ctx as EventHostLike | undefined)?.on
  if (typeof on !== 'function') return undefined
  try {
    return on.call(ctx, event, listener)
  } catch {
    return undefined
  }
}

/**
 * 记一条警告。
 * @param ctx - 宿主上下文。
 * @param message - 正文。
 */
function logWarn(ctx: unknown, message: string): void {
  try {
    (ctx as { logger?: LoggerLike } | undefined)?.logger?.warn(message)
  } catch {
    // 日志失败不影响守卫。
  }
}

/**
 * 造一条尾部通知消息。
 * @param text - 正文。
 * @param summary - 卡片上显示的一句摘要。
 * @returns 用户角色的通知消息。
 */
function createBoardNotice(text: string, summary: string): unknown {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: TEAM_BOARD_NOTICE_SOURCE_KIND, form: 'notice', summary },
  })
}

/**
 * 装一台「Agent Teams 策略段缓存守卫」。
 *
 * 幂等性留给调用方：同一个 ctx 装两次会得到两条监听器，宿主入口应当只装一次。
 * @param ctx - 宿主上下文（结构化：老代 ctx 也认）。
 * @param options - 开关读取器。
 * @returns 句柄，dispose 摘掉全部挂载。
 */
export function installTeamPolicyCacheGuard(
  ctx: unknown,
  options: TeamPolicyCacheGuardOptions = {},
): TeamPolicyCacheGuard {
  const states = new WeakMap<object, GuardState>()
  const stats: GuardStats = { seen: false, warned: false }
  const restores: (() => void)[] = []
  const patchedMethods = new WeakMap<object, Set<string>>()
  let closed = false

  const enabled = (): boolean => {
    try {
      return options.enabled?.() === true
    } catch {
      return false
    }
  }

  const stateOf = (key: object): GuardState => {
    let state = states.get(key)
    if (state === undefined) {
      state = { policy: '', pending: undefined, delivered: false, revoked: false }
      states.set(key, state)
    }
    return state
  }

  // ── 1. 摘掉 team:policy ───────────────────────────────────────────────────
  const onAssemble = async (
    _assembly: PresentationLike,
    context: AssembleContextLike,
    next: () => Promise<PresentationLike>,
  ): Promise<PresentationLike> => {
    const result = await next()
    if (closed || !enabled()) return result
    const sections = Array.isArray(result?.sections) ? result.sections : undefined
    if (sections === undefined) return result
    const kept: AssembledSectionLike[] = []
    let policy: string | undefined
    let retired = false
    for (const section of sections) {
      if (section?.name === TEAM_POLICY_SECTION) {
        stats.seen = true
        policy = typeof section.text === 'string' ? section.text : ''
        retired = section.retire === true
        continue
      }
      kept.push(section)
    }
    if (policy === undefined) {
      // 启用却一直没见过这个段：说明 harness 改了形态，本守卫在空转。只报一次。
      if (!stats.seen && !stats.warned) {
        stats.warned = true
        logWarn(ctx, `[dsh-chatgpt-subscription] team policy cache guard is enabled but no "${TEAM_POLICY_SECTION}" `
          + 'section has appeared; the guard is inert on this deployment')
      }
      return result
    }
    const state = stateOf(bucketOf(context?.scope ?? context?.agent))
    if (retired || policy.trim() === '') {
      // 官方段在关闭或退役时结束本次激活；下一步补一条撤销通知。
      if (state.delivered) state.revoked = true
      state.delivered = false
      state.pending = undefined
    } else {
      state.policy = policy
      // 板又回来了：上一步排队的「已关闭」通知作废，不再补投。
      state.revoked = false
      if (!state.delivered) state.pending = policy
    }
    if (kept.length === sections.length) return result
    return { ...result, sections: kept }
  }

  // ── 2. 一次激活投一次尾部消息 ─────────────────────────────────────────────
  const onPreStep = async (
    payload: PreStepPayloadLike,
    next: () => Promise<PreStepDecisionLike | undefined>,
  ): Promise<PreStepDecisionLike | undefined> => {
    const decision = await next()
    if (closed || decision === undefined || decision.kind === 'reject') return decision
    if (payload?.signal?.aborted === true) return decision
    if (!enabled()) return decision
    const state = states.get(bucketOf(payload?.agent ?? undefined))
    if (state === undefined) return decision
    const messages = Array.isArray(decision.messages) ? decision.messages : []
    if (!state.delivered) {
      const text = state.pending
      if (text !== undefined) {
        // 新一次激活的正文优先于「已关闭」通知：板已经回来，撤销就不必再提。
        state.pending = undefined
        state.delivered = true
        state.revoked = false
        return {
          ...decision,
          messages: [...messages, createBoardNotice(text, 'Team board guidance')],
        }
      }
    }
    if (state.revoked) {
      state.revoked = false
      return {
        ...decision,
        messages: [...messages, createBoardNotice(BOARD_OFF_NOTICE, 'Team board off')],
      }
    }
    return decision
  }

  const offAssemble = subscribe(ctx, 'system-prompt/assemble', onAssemble as unknown as (...args: never[]) => unknown)
  const offPreStep = subscribe(ctx, 'agent/pre-step', onPreStep as unknown as (...args: never[]) => unknown)
  if (offAssemble !== undefined) restores.push(() => { offAssemble() })
  if (offPreStep !== undefined) restores.push(() => { offPreStep() })

  // ── 3. DSH 0.2.3-alpha.3+：保持 Agent Teams 工具表跨开关恒定 ───────────────
  // 官方 `tool-agent-team` 改用 `AgentToolRegistry` + `ctx.tools.include()` 按 Team 开关
  // 动态增删 4 个 `team_task_*` 工具，在原生 `standard` 预设中途切 `/team` 时会重建工具表
  // 导致前缀缓存失效；上游 `agent-team` 任务板本身会检查 `state.enabled` 并干净拒掉未启用
  // 时的调用（`TEAM_DISABLED`），因此开启守卫时恒定暴露原始 `ToolDefinition` 引用即可。
  const wrapTeamToolsSource = (source: ToolSourceLike): ToolSourceLike => {
    const readUnscoped = (name: string): unknown => {
      try {
        return source.get(name)
      } catch {
        return undefined
      }
    }
    return {
      get(name: string, scope?: unknown): unknown {
        const found = source.get(name, scope)
        if (found !== undefined || closed || !enabled() || scope === undefined || !TEAM_TOOL_NAME_SET.has(name)) {
          return found
        }
        return readUnscoped(name)
      },
      getAll(scope?: unknown): readonly unknown[] {
        const list = source.getAll(scope)
        if (closed || !enabled() || scope === undefined || !Array.isArray(list)) return list
        const present = new Set<string>()
        for (const entry of list) {
          if (typeof entry === 'object' && entry !== null) {
            const name = (entry as { name?: unknown }).name
            if (typeof name === 'string') present.add(name)
          }
        }
        const missing: unknown[] = []
        for (const name of TEAM_TOOL_NAMES) {
          if (present.has(name)) continue
          const def = readUnscoped(name)
          if (def !== undefined) missing.push(def)
        }
        return missing.length === 0 ? list : [...list, ...missing]
      },
    }
  }

  const wrapTools = (tools: ToolsRegistryLike | undefined): void => {
    if (tools === undefined) return
    const target = resolveMethodTarget(tools, 'include')
    if (target === undefined) return
    if (patchedMethods.get(target.holder)?.has(target.name) === true) return
    const originalInclude = target.original
    const wrappedInclude: UnboundMethod = function (this: unknown, ...args: unknown[]): unknown {
      const receiver = this ?? tools
      const source = args[0] as Partial<ToolSourceLike> | undefined
      if (typeof source?.get === 'function' && typeof source?.getAll === 'function') {
        let offersTeamTools = false
        try {
          offersTeamTools = TEAM_TOOL_NAMES.some(name => source.get!(name) !== undefined)
        } catch {
          offersTeamTools = false
        }
        if (offersTeamTools) {
          return originalInclude.call(receiver, wrapTeamToolsSource(source as ToolSourceLike), ...args.slice(1))
        }
      }
      return originalInclude.call(receiver, ...args)
    }
    try {
      Object.defineProperty(target.holder, target.name, {
        value: wrappedInclude,
        configurable: true,
        writable: true,
        enumerable: target.descriptor?.enumerable ?? false,
      })
    } catch {
      return
    }
    const names = patchedMethods.get(target.holder) ?? new Set<string>()
    names.add(target.name)
    patchedMethods.set(target.holder, names)
    restores.push(() => {
      try {
        // 仅在仍位于包装链顶层时还原，避免与其他拦截 `include` 的守卫交叉卸载时踩掉对方。
        if (Object.getOwnPropertyDescriptor(target.holder, target.name)?.value !== wrappedInclude) return
        if (target.descriptor === undefined) Reflect.deleteProperty(target.holder, target.name)
        else Object.defineProperty(target.holder, target.name, target.descriptor)
      } catch {
        // 忽略卸载期单点异常。
      }
    })
  }

  const initialTools = serviceOf<ToolsRegistryLike>(ctx, 'tools')
  if (initialTools !== undefined) {
    wrapTools(initialTools)
  } else {
    const inject = (ctx as InjectHostLike | undefined)?.inject
    if (typeof inject === 'function') {
      let wrapped = false
      try {
        inject.call(ctx, ['tools'], (scope: unknown) => {
          if (wrapped || closed) return
          wrapped = true
          wrapTools(serviceOf<ToolsRegistryLike>(scope, 'tools'))
        })
      } catch {
        // 没有注入面时静默跳过。
      }
    }
  }

  return {
    dispose(): void {
      if (closed) return
      closed = true
      for (const restore of restores.splice(0)) {
        try {
          restore()
        } catch {
          // 卸载期的单点失败不影响其余卸载。
        }
      }
    },
  }
}

export default installTeamPolicyCacheGuard
