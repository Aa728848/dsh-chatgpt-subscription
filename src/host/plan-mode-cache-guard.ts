/**
 * 「计划模式缓存守卫」—— 宿主级、**跨 preset** 的一次性修正。
 *
 * dispatch preset 用的是本包 fork 的 plan-mode 服务（src/entry-plan-mode.ts），它
 * 从设计上就不重建前缀缓存。可是内置 preset（standard / ptc / cordis）挂的仍是
 * harness 官方的 @deepseek-ai/dsh-plan-mode，那里有两处前缀重建：
 *
 * 1. 动态 plan:policy 段在进入/离开那一步从 '' 变成部署指引；
 * 2. exit_plan_mode 用 { when } 逐步准入，进那一步工具表变大。
 *
 * 本包的 preset 只影响用它的会话；用户切回内置 preset 时重建照旧发生。这个守卫在
 * **宿主级**把内置 preset 的那两处也压平，做法与本包 fork 同构，而且完全不改官方
 * 服务：官方服务照常注册自己的段与工具，守卫只在两个可以无条件插手的接缝上动手。
 *
 * ## 三条动作，对应两处重建与一次补偿
 *
 * 1. system-prompt/assemble 瀑布：把 plan:policy 段从呈现里摘掉，并记下它的正文。
 *    system 段从此在进出计划模式时逐字节恒定。
 * 2. agent/pre-step：把上一步记下的正文作为**尾部用户消息**投一次（每次激活一次）。
 *    指令没有丢，只是从「最前面的 system 段」搬到「末尾追加」——末尾追加不破坏
 *    已发前缀，所以之后的每一步都还在历史里，而前缀缓存归零只发生一次（本来就要
 *    发生的那一次）。
 * 3. tools.register 包装：遇到 exit_plan_mode 带 { when } 时把它摘掉，让它从会话
 *    第一步就在工具表里，native tools 与 PTC tools:sdk 两侧都不再重建。
 *
 * ## 顺序前提
 *
 * 守卫必须在官方 plan-mode 行**注册工具之前**装上，否则那个注册已经带着 { when }
 * 落进工具层的私有表里，而工具层没有公开的「改一条已注册项」的接口。宿主级插件
 * 先于会话/preset 挂载，所以正常路径满足；真遇到已注册的旧项，这里只记一条 warn，
 * 不假装成功。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/host/plan-mode-cache-guard
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  EXIT_PLAN_MODE,
  PLAN_POLICY_SECTION,
  PLAN_PROJECTION_KEY,
  createPlanNotice,
} from '../entry-plan-mode.ts'

/** 守卫交回的句柄。 */
export interface PlanModeCacheGuard {
  /** 摘掉本守卫挂上的全部东西（幂等）。 */
  dispose(): void
}

/** 一次计划模式激活的守卫状态，按 agent 分桶。 */
interface GuardState {
  /** 最近一次被摘掉的策略正文。 */
  policy: string
  /** 待投递的正文（只在本次激活还没投过时存在）。 */
  pending: string | undefined
  /** 本次激活已经投过没有。 */
  delivered: boolean
}

/** 事件订阅面。 */
interface EventHostLike {
  /** 订阅一个事件。 */
  on?(name: string, listener: (...args: never[]) => unknown): (() => void) | undefined
}

/** 注入面。 */
interface InjectHostLike {
  /** 等一组服务到齐。 */
  inject?(deps: string[], callback: (scope: unknown) => void): unknown
}

/** 日志面。 */
interface LoggerLike {
  /** 警告级日志。 */
  warn(message: string, ...rest: unknown[]): void
}

/** 投影读面（只读 plan 与 turnBoundary 的 key）。 */
interface ProjectionsLike {
  /** 旧代按 key 读。 */
  stateOf?(session: unknown, key: string): unknown
}

/** 工具注册面。 */
interface ToolsRegistryLike {
  /** 注册一个工具定义。 */
  register(definition: ToolDefinition, options?: { when?: unknown }): unknown
  /** 按名字读一条已注册的定义（用来识别「守卫来晚了」）。 */
  get?(name: string, ...rest: unknown[]): unknown
}

/** 系统段（只读名字与正文）。 */
interface AssembledSectionLike {
  /** 段名。 */
  name?: unknown
  /** 段正文。 */
  text?: unknown
  /** 是否插值。 */
  interpolate?: unknown
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
 * 读一个可选服务。
 * @param ctx - 宿主上下文。
 * @param service - 服务名。
 * @returns 服务实例或 undefined。
 */
function serviceOf<T>(ctx: unknown, service: string): T | undefined {
  const read = (ctx as { get?: (name: string) => unknown } | undefined)?.get
  if (typeof read !== 'function') return undefined
  try {
    return read.call(ctx, service) as T | undefined
  } catch {
    return undefined
  }
}

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
 * 装一台「计划模式缓存守卫」。
 *
 * 幂等性问题留给调用方：同一个 ctx 装两次会得到两条监听器（它们互相之间是幂等的，
 * 只是多一份工作），所以宿主入口应当只装一次。
 * @param ctx - 宿主上下文（结构化：老代 ctx 也认）。
 * @returns 句柄，dispose 摘掉全部挂载。
 */
export function installPlanModeCacheGuard(ctx: unknown): PlanModeCacheGuard {
  const states = new WeakMap<object, GuardState>()
  const restores: (() => void)[] = []
  /** 已包装过的「方法宿主 + 方法名」：同一个原型不叠第二层包装。 */
  const patchedMethods = new WeakMap<object, Set<string>>()
  let closed = false

  /**
   * 取（或建）一个桶的状态。
   * @param key - 桶键。
   * @returns 该桶状态。
   */
  const stateOf = (key: object): GuardState => {
    let state = states.get(key)
    if (state === undefined) {
      state = { policy: '', pending: undefined, delivered: false }
      states.set(key, state)
    }
    return state
  }

  // ── 1. 摘掉 plan:policy ───────────────────────────────────────────────────
  const onAssemble = async (
    assembly: PresentationLike,
    context: AssembleContextLike,
    next: () => Promise<PresentationLike>,
  ): Promise<PresentationLike> => {
    const result = await next()
    const sections = Array.isArray(result?.sections) ? result.sections : undefined
    if (sections === undefined) return result
    const kept: AssembledSectionLike[] = []
    let policy: string | undefined
    for (const section of sections) {
      if (section?.name === PLAN_POLICY_SECTION) {
        policy = typeof section.text === 'string' ? section.text : ''
        continue
      }
      kept.push(section)
    }
    const state = stateOf(bucketOf(context?.scope ?? context?.agent))
    if (policy !== undefined) {
      if (policy.trim() === '') {
        // 官方段在非计划模式时就是空串：这是「一次激活结束」的信号，下一次进入
        // 要重新投递。
        state.pending = undefined
        state.delivered = false
      } else {
        state.policy = policy
        // 已经投过的激活不再重复；还没投过就排进待投递。
        if (!state.delivered) state.pending = policy
      }
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
    if (decision === undefined || decision.kind === 'reject') return decision
    if (payload?.signal?.aborted === true) return decision
    const agent = payload?.agent
    const key = bucketOf(agent ?? undefined)
    const state = states.get(key)
    if (state === undefined) return decision
    // 已投过的激活，若投影说计划模式已经关了，就复位：下次进入要重新讲。
    if (state.delivered) {
      const active = planActiveOf(ctx, agent?.session)
      if (active === false) state.delivered = false
      else return decision
    }
    const text = state.pending
    if (text === undefined) return decision
    state.pending = undefined
    state.delivered = true
    const messages = Array.isArray(decision.messages) ? decision.messages : []
    return {
      ...decision,
      messages: [...messages, createPlanNotice(text, undefined, 'Plan mode guidance')],
    }
  }

  const offAssemble = subscribe(ctx, 'system-prompt/assemble', onAssemble as unknown as (...args: never[]) => unknown)
  const offPreStep = subscribe(ctx, 'agent/pre-step', onPreStep as unknown as (...args: never[]) => unknown)
  if (offAssemble !== undefined) restores.push(() => { offAssemble() })
  if (offPreStep !== undefined) restores.push(() => { offPreStep() })

  // ── 3. 摘掉 exit_plan_mode 的 { when } ────────────────────────────────────
  const wrap = (tools: ToolsRegistryLike | undefined): void => {
    if (tools === undefined) return
    // 关键：原实现必须取**原型上那份未绑定的方法**。
    // Cordis 的 Service 代理读属性时会把方法绑到读取它的那一层作用域（根作用域），
    // 那份绑定版一旦再 original.call(tools, …)，每个 preset 的注册都被塞回根作用域，
    // 全局层于是撞上 "already registered"。
    const target = resolveMethodTarget(tools, 'register')
    if (target === undefined) return
    if (alreadyPatched(patchedMethods, target.holder, target.name)) return
    const original = target.original
    const wrapped: UnboundMethod = function (this: unknown, ...args: unknown[]): unknown {
      // receiver 用**调用方**的 this：Cordis 会把它换成那一层作用域的影子，
      // 于是 ToolsService 里的 this.ctx 留在调用方自己的作用域里，而不是根上下文。
      const receiver = this ?? tools
      const definition = args[0] as ToolDefinition
      const options = args[1] as { when?: unknown } | undefined
      if (definition?.name === EXIT_PLAN_MODE && options !== undefined && options !== null && 'when' in options) {
        const { when: _dropped, ...rest } = options
        return original.call(receiver, definition, rest)
      }
      return original.call(receiver, definition, options)
    }
    if (!installMethod(target, wrapped)) return
    markPatched(patchedMethods, target.holder, target.name)
    restores.push(() => {
      restoreMethod(target)
    })
    // 守卫来晚了：那条注册已经带着 { when } 落进工具层，工具层没有公开的改法。
    if (typeof tools.get === 'function') {
      try {
        if (tools.get(EXIT_PLAN_MODE) !== undefined) {
          logWarn(ctx, '[dsh-chatgpt-subscription] plan-mode cache guard was installed after exit_plan_mode '
            + 'was already registered; this session keeps the conditional admission')
        }
      } catch {
        // 只读探测失败不该影响守卫。
      }
    }
  }

  const tools = serviceOf<ToolsRegistryLike>(ctx, 'tools')
  if (tools !== undefined) {
    wrap(tools)
  } else {
    // tools 还没到：等它到齐。cordis 的注入回调在服务变化时会重跑，所以这里自己
    // 去重，避免同一次会话里叠两条包装。
    const inject = (ctx as InjectHostLike | undefined)?.inject
    if (typeof inject === 'function') {
      let wrapped = false
      try {
        inject.call(ctx, ['tools'], (scope: unknown) => {
          if (wrapped || closed) return
          wrapped = true
          wrap(serviceOf<ToolsRegistryLike>(scope, 'tools'))
        })
      } catch {
        // 没有注入面：这一代就只能靠上面那次直接探测。
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

/**
 * 读 plan 投影的 active。
 * @param ctx - 宿主上下文。
 * @param session - 会话。
 * @returns true / false；读不到时 undefined。
 */
function planActiveOf(ctx: unknown, session: unknown): boolean | undefined {
  const projections = serviceOf<ProjectionsLike>(ctx, 'sessionProjections')
  if (typeof projections?.stateOf !== 'function') return undefined
  try {
    const state = projections.stateOf(session, PLAN_PROJECTION_KEY) as { active?: unknown } | undefined
    return typeof state?.active === 'boolean' ? state.active : undefined
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
  const logger = (ctx as { logger?: LoggerLike } | undefined)?.logger
  try {
    logger?.warn(message)
  } catch {
    // 日志失败不影响守卫。
  }
}

/**
 * 一个未绑定的方法（`this` 由调用点决定）。
 */
type UnboundMethod = (this: unknown, ...args: unknown[]) => unknown

/**
 * 一个待包装的方法：装它的位置、未绑定的原实现与原描述符。
 */
interface MethodTarget {
  /** 包装写在哪：原型（真实 Cordis `Service`）或实例（单测里的普通假对象）。 */
  holder: object
  /** 方法名。 */
  name: string
  /** 未绑定的原实现。 */
  original: UnboundMethod
  /** 原实现的属性描述符（还原用）。 */
  descriptor: PropertyDescriptor | undefined
}

/**
 * 定位一个待包装的方法。
 *
 * Cordis 的 `Service` 代理在读属性时会把方法**绑定到读取它的那一层作用域**
 * （`Reflect.get(target, prop, receiver).bind(receiver)`）。于是
 * `const original = tools.register` 拿到的是一份**已经绑到根作用域**的函数；再
 * `original.call(tools, …)` 就把根作用域硬塞回每一个 preset 的注册里，全局层
 * 于是撞上 "already registered"。
 *
 * 真正要的是**原型上那份未绑定的方法**：包装器用 `original.call(this, …)` 把
 * 调用方自己的 receiver 传下去，服务里的 `this.ctx` 才留在调用方那一层作用域
 * （child ctx）里。方法挂在原型上时（真实 Cordis `Service`），包装也写在原型上；
 * 只有普通假对象（单测）才把方法作为自有属性挂在实例上。
 *
 * @param service - 服务实例（可以是 Cordis 的跟踪代理）。
 * @param name - 方法名。
 * @returns 目标；方法不存在时为 `undefined`。
 */
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
  if (proto === null) return undefined
  // 不许动 Object.prototype / Function.prototype：那会把包装写到所有对象身上。
  if (proto === (Object.prototype as object) || proto === (Function.prototype as object)) return undefined
  const original = (proto as Record<string, unknown>)[name]
  if (typeof original !== 'function') return undefined
  return {
    holder: proto,
    name,
    original: original as UnboundMethod,
    descriptor: Object.getOwnPropertyDescriptor(proto, name),
  }
}

/**
 * 把一个包装写到方法所在的位置上。
 *
 * @param target - 目标。
 * @param replacement - 包装实现。
 * @returns 是否装上了。
 */
function installMethod(target: MethodTarget, replacement: UnboundMethod): boolean {
  try {
    Object.defineProperty(target.holder, target.name, {
      value: replacement,
      configurable: true,
      writable: true,
      enumerable: target.descriptor?.enumerable ?? false,
    })
    return true
  } catch {
    return false
  }
}

/**
 * 还原方法所在位置上原来的实现。
 *
 * @param target - 目标。
 */
function restoreMethod(target: MethodTarget): void {
  try {
    if (target.descriptor === undefined) {
      Reflect.deleteProperty(target.holder, target.name)
    } else {
      Object.defineProperty(target.holder, target.name, target.descriptor)
    }
  } catch {
    // 服务已经卸载：忽略。
  }
}

/**
 * 判断某个「方法宿主 + 方法名」是不是已经被本守卫包过。
 *
 * @param patched - 已包装记录。
 * @param holder - 方法宿主。
 * @param name - 方法名。
 * @returns 是否已经包过。
 */
function alreadyPatched(patched: WeakMap<object, Set<string>>, holder: object, name: string): boolean {
  return patched.get(holder)?.has(name) === true
}

/**
 * 记下某个「方法宿主 + 方法名」已经被本守卫包过。
 *
 * @param patched - 已包装记录。
 * @param holder - 方法宿主。
 * @param name - 方法名。
 */
function markPatched(patched: WeakMap<object, Set<string>>, holder: object, name: string): void {
  const names = patched.get(holder)
  if (names === undefined) patched.set(holder, new Set([name]))
  else names.add(name)
}

export default installPlanModeCacheGuard
