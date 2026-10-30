/**
 * 宿主级的「跨 preset 修剪守卫」。
 *
 * ## 为什么需要它
 *
 * 修剪器的判定要 provider，而 provider 只有**请求头快照**知道；但修剪器自己的
 * loader 行是挂在 preset 里的，preset 又把 `compaction` 整个隔离成一个 realm
 * （见 `presets/dispatch/agent.cordis.yml`）。隔离之后，行内实例只存在于那个
 * realm 的 `ctx.reflect.store` 里，宿主平面根本看不到它，也就没有地方把
 * "这场会话的 provider 该不该修剪" 插进去。
 *
 * 这一层守卫因此待在**宿主平面**：它不替换任何行，只在下述时机把已经挂载
 * 的 `toolResultPruner` 实例的 `pruneSession` 包一层 provider 短路 ——
 * 安装时先扫一遍，此后每个 agent 开始一步（`agent/pre-step`）、每次发起请求
 * （`agent/request`）或撞上上下文溢出（`agent/request-error`）时再扫一遍。
 * 三个事件都是 Cordis **瀑布**事件，监听器必须转交 `next()`（见下）。两个位置都要看：
 *
 * - `ctx.reflect.store`（宿主平面自己的服务记录，含安装后才挂上的实例）；
 * - `agent.ctx.get('toolResultPruner')` 与 `agent.ctx.reflect.store`
 *   （preset 隔离 realm 里的实例，宿主 store 里根本没有它）。
 *
 * 包装按 `WeakSet` 幂等，重复事件不会叠第二层；`dispose()` 逐条还原原方法并
 * 摘掉监听器。
 *
 * ## 瀑布事件必须转交 `next()`
 *
 * `agent/pre-step` / `agent/request` / `agent/request-error` 是 Cordis **瀑布**事件
 * （`ctx.waterfall`），最后一个参数就是 `next`。瀑布的返回值是**最外层监听器的返回值**：不调用 `next()`
 * 等于替整条链做了决定——后续监听器（连同内置的默认行为）一个都不跑，瀑布的返回值
 * 也变成监听器自己的返回值。于是 `agent-loop` 读 `decision.kind` 时拿到
 * `undefined`，每一轮都炸成
 * `TypeError: Cannot read properties of undefined (reading 'kind')`。
 * 本守卫是旁路，扫描失败只吞掉扫描本身，但 `next()` 在所有分支上都要被调用并原样
 * 交回去。
 *
 * ## 只做短路，不改语义
 *
 * 包装后的 `pruneSession` 只有一条分支：`shouldSkipPruningForSession` 命中就
 * 返回 `{ pruned: [], charsRemoved: 0 }`，否则原样转给底层实现。修剪算法、事件
 * 顺序、`surfaceOp` 全都不在这里——守卫不能成为第二个修剪实现。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/host/tool-result-pruner-guard
 */
import {
  DEFAULT_SKIP_PROVIDERS,
  PRUNER_SERVICE_NAME,
  resolveSkipProviders,
  shouldSkipPruningForSession,
} from '../entry-tool-result-pruner.ts'

/** 守卫的选项。 */
export interface ToolResultPrunerGuardOptions {
  /**
   * 命中即整场跳过修剪的 provider 名单。
   *
   * 省略时用入口模块的默认值（`['kimi-code']`）。
   */
  skipProviders?: readonly string[]
}

/** 守卫句柄。 */
export interface ToolResultPrunerGuard {
  /** 还原被包装的 `pruneSession` 并移除事件监听；可重复调用。 */
  dispose(): void
  /**
   * 立刻尝试包装一个修剪器实例。
   *
   * @param pruner - 候选实例（结构探测，不看类身份）。
   * @returns 本次是否真的包上了（已包过、不是修剪器、已销毁都为 `false`）。
   */
  wrapPruner(pruner: unknown): boolean
}

/** 被包装方法的原签名（`this` 由调用点决定）。 */
type PruneSessionMethod = (this: unknown, session: unknown) => unknown

/** 事件监听器签名（瀑布事件要把 `next()` 的结果回传，故返回值不是 `void`）。 */
type Listener = (...args: unknown[]) => unknown

/** `ctx.on` 的第三个参数形态（布尔是 `prepend` 的简写）。 */
type ListenerOptions = boolean | { prepend?: boolean }

/** reflect store 里的一条服务实现记录（即 `reflect.d.ts` 的 `Impl`）。 */
interface ServiceImplLike {
  /** 服务名。 */
  name?: unknown
  /** 当前服务值。 */
  value?: unknown
  /** 个别代把值放在 `impl` 上。 */
  impl?: unknown
}

/** 只按结构描述宿主上下文里我们用到的四样东西。 */
interface HostContextLike {
  /** 反射与解析层。 */
  reflect?: { store?: Record<symbol, unknown> }
  /** 注册监听器。 */
  on?: (name: string, listener: Listener, options?: ListenerOptions) => unknown
  /** 老代移除监听器的入口。 */
  off?: (name: string, listener: Listener) => unknown
  /** 按名字取服务（不要求注入）。 */
  get?: (name: string, strict?: boolean) => unknown
}

/** 会先跑一遍扫描的宿主事件（全部是 Cordis 瀑布事件，监听器必须转交 `next()`）。 */
const GUARDED_EVENTS: readonly string[] = ['agent/pre-step', 'agent/request', 'agent/request-error']

/**
 * 安装跨 preset 守卫。
 *
 * 安装时会立刻扫一次（覆盖"守卫晚于修剪器挂载"），随后靠 `agent/pre-step` 与
 * `agent/request-error` 覆盖"修剪器晚于守卫挂载"。
 *
 * @param ctx - 宿主上下文（结构探测；传入非对象时只返回一个空守卫）。
 * @param options - 守卫选项。
 * @returns 可销毁的句柄。
 */
export function installToolResultPrunerGuard(
  ctx: unknown,
  options: ToolResultPrunerGuardOptions = {},
): ToolResultPrunerGuard {
  const host = isRecord(ctx) ? (ctx as HostContextLike) : undefined
  const skipSet = resolveSkipProviders(options.skipProviders ?? DEFAULT_SKIP_PROVIDERS)
  /** 已包装过的实例（幂等标记）。 */
  const alreadyWrapped = new WeakSet<object>()
  /** 已包装过的「方法宿主 + 方法名」：同一个原型不叠第二层包装。 */
  const patchedMethods = new WeakMap<object, Set<string>>()
  /** 已包装的方法，销毁时逐条还原。 */
  const restores: Array<() => void> = []
  /** 事件监听的 disposer。 */
  const disposers: Array<() => void> = []
  let disposed = false

  /**
   * 把一个修剪器实例的 `pruneSession` 包上 provider 短路。
   *
   * @param pruner - 候选实例。
   * @returns 是否真的包上了。
   */
  const wrapPruner = (pruner: unknown): boolean => {
    if (disposed || !isRecord(pruner)) return false
    if (alreadyWrapped.has(pruner)) return false
    // 取原型上那份**未绑定**的实现：跟踪代理读出来的那份绑在读取它的那一层作用域上，
    // 再 original.call(this, …) 会把调用方的作用域弄丢。
    const target = resolveMethodTarget(pruner, 'pruneSession')
    if (target === undefined) return false
    if (alreadyPatched(patchedMethods, target.holder, target.name)) {
      // 同一类的另一个实例共享原型上那份包装，不再叠一层。
      alreadyWrapped.add(pruner)
      return false
    }
    const original = target.original as PruneSessionMethod
    const replacement = function (this: unknown, session: unknown): unknown {
      if (shouldSkipPruningForSession(session, skipSet)) {
        return { pruned: [], charsRemoved: 0 }
      }
      // receiver 用**调用方**的 this：服务里的 this.ctx 留在调用方那一层作用域。
      return original.call(this ?? pruner, session)
    }
    if (!installMethod(target, replacement)) return false
    markPatched(patchedMethods, target.holder, target.name)
    alreadyWrapped.add(pruner)
    restores.push(() => {
      restoreMethod(target)
    })
    return true
  }

  /**
   * 按 reflect store 里的一条记录包装其中的修剪器实例。
   *
   * 名字对不上就跳过；名字缺失（个别代不填 `name`）时只按结构判断——"有
   * `pruneSession` 方法"。名字明确是别的服务则一律不碰。
   *
   * @param entry - store 里的一条记录。
   * @returns 是否包上了新实例。
   */
  const wrapStoreEntry = (entry: unknown): boolean => {
    if (!isRecord(entry)) return false
    const record = entry as ServiceImplLike
    const name = readServiceName(record)
    if (name !== undefined && name !== PRUNER_SERVICE_NAME) return false
    const value = record.value ?? record.impl
    if (isRecord(value)) return wrapPruner(value)
    return wrapPruner(entry)
  }

  /**
   * 扫描一个上下文自己的 reflect store。
   *
   * @param target - 任意宿主上下文（宿主平面或某个 agent 的 realm）。
   * @returns 本次新包上的实例数。
   */
  const scanStore = (target: unknown): number => {
    if (!isRecord(target)) return 0
    const store = (target as HostContextLike).reflect?.store
    if (!isRecord(store)) return 0
    let count = 0
    for (const key of Object.getOwnPropertySymbols(store)) {
      if (wrapStoreEntry(store[key])) count += 1
    }
    return count
  }

  /**
   * 用 `ctx.get(name)` 取一个服务并尝试包装。
   *
   * @param target - 任意宿主上下文。
   * @param name - 服务名。
   * @returns 是否包上了新实例。
   */
  const wrapServiceFrom = (target: unknown, name: string): boolean => {
    if (!isRecord(target)) return false
    const get = (target as HostContextLike).get
    if (typeof get !== 'function') return false
    try {
      return wrapPruner(get.call(target, name))
    } catch {
      // 这一代没有该服务，或读取抛错（fiber 未激活）：下一轮事件再看。
      return false
    }
  }

  /**
   * 扫描宿主平面的所有已知位置。
   *
   * @returns 本次新包上的实例数。
   */
  const scanAndWrap = (): number => {
    if (disposed) return 0
    let count = scanStore(host)
    if (wrapServiceFrom(host, PRUNER_SERVICE_NAME)) count += 1
    return count
  }

  /**
   * 事件回调：先扫宿主平面，再扫事件里那个 agent 自己的 realm。
   *
   * ## 瀑布必须转交
   *
   * `agent/pre-step` / `agent/request` / `agent/request-error` 在 DSH 里是 Cordis
   * **瀑布**事件（`ctx.waterfall`），最后一个参数就是 `next`。瀑布的返回值是**最外层监听器
   * 的返回值**：不调用 `next()` 等于替整条链做了决定——后续监听器（连同内置的
   * 默认行为）一个都不会跑，瀑布的返回值也变成监听器自己的返回值（这里是
   * `undefined`）。`agent-loop` 随后读 `decision.kind`，于是每一轮都炸成
   * `TypeError: Cannot read properties of undefined (reading 'kind')`。
   *
   * 所以扫描照旧做（扫描失败也只吞掉扫描本身），但 `next()` **必须**在所有分支上
   * 被调用，并把它的结果原样交回去。
   *
   * @param args - 事件参数（最后一个参数可能是 `next`）。
   * @returns `next()` 的结果；没有 `next` 时为 `undefined`。
   */
  const handleAgentEvent: Listener = (...args) => {
    // 瀑布的 `next` 永远是最后一个参数；`typeof fn === 'object'` 为假，所以
    // `findAgentContext` /`isRecord` 之类的结构探测本来就认不出它，不会误认。
    const next = args.length > 0 && typeof args[args.length - 1] === 'function'
      ? (args[args.length - 1] as () => unknown)
      : undefined
    try {
      scanAndWrap()
      const agentCtx = findAgentContext(args)
      if (agentCtx !== undefined) {
        scanStore(agentCtx)
        wrapServiceFrom(agentCtx, PRUNER_SERVICE_NAME)
      }
    } catch {
      // 守卫是旁路：任何一步失败都不该影响这一步本身。
    }
    // 瀑布的返回值必须来自 `next()`：短路会让这一步拿到 `undefined`。
    return next === undefined ? undefined : next()
  }

  for (const event of GUARDED_EVENTS) {
    const disposer = subscribe(host, event, handleAgentEvent)
    if (disposer !== undefined) disposers.push(disposer)
  }
  scanAndWrap()

  return {
    wrapPruner,
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const disposer of disposers.splice(0)) {
        try {
          disposer()
        } catch {
          // 已经拆掉的监听器：忽略。
        }
      }
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
 * 注册一个监听器，优先用 `prepend: true`。
 *
 * 守卫要赶在这一步真正的动作之前，所以先试 `{ prepend: true }`（4.x），再试
 * 布尔简写 `true`（只认布尔的代），都不行就退回普通注册——顺序不那么重要时
 * 也总比不注册好。
 *
 * @param host - 宿主上下文。
 * @param event - 事件名。
 * @param listener - 回调。
 * @returns 移除监听器的 disposer；宿主不支持事件时为 `undefined`。
 */
function subscribe(
  host: HostContextLike | undefined,
  event: string,
  listener: Listener,
): (() => void) | undefined {
  const on = host?.on
  if (typeof on !== 'function') return undefined
  const attempts: readonly ListenerOptions[] = [{ prepend: true }, true, false]
  for (const options of attempts) {
    let result: unknown
    try {
      result = on.call(host, event, listener, options)
    } catch {
      continue
    }
    if (typeof result === 'function') return result as () => void
    // 这一代 `on` 返回上下文本身而不是 disposer：退回 `off`。
    return () => {
      const off = host?.off
      if (typeof off !== 'function') return
      try {
        off.call(host, event, listener)
      } catch {
        // 已经拆掉的监听器：忽略。
      }
    }
  }
  return undefined
}

/**
 * 从一条 service 记录里读服务名。
 *
 * @param record - `ctx.reflect.store` 里的一条记录。
 * @returns 服务名；读不到时为 `undefined`。
 */
function readServiceName(record: ServiceImplLike): string | undefined {
  if (typeof record.name === 'string') return record.name
  const impl = record.impl
  if (isRecord(impl) && typeof impl['name'] === 'string') return impl['name']
  const value = record.value
  if (isRecord(value) && typeof value['name'] === 'string') return value['name']
  return undefined
}

/**
 * 从一次事件派发的参数里找出 agent 的上下文。
 *
 * 事件载荷在不同代里是 `agent`、`(agent, ...)` 或 `{ agent, ... }`；三种都认，
 * 认不出就返回 `undefined`（不是错误）。
 *
 * @param args - 事件参数。
 * @returns agent 的上下文；认不出时为 `undefined`。
 */
function findAgentContext(args: readonly unknown[]): HostContextLike | undefined {
  for (const arg of args) {
    const direct = readContext(arg)
    if (direct !== undefined) return direct
    if (isRecord(arg)) {
      const nested = readContext(arg['agent'])
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/**
 * 读一个对象上的 `ctx`，并要求它看起来确实是个上下文。
 *
 * @param value - 候选 agent。
 * @returns 上下文；不像时返回 `undefined`。
 */
function readContext(value: unknown): HostContextLike | undefined {
  if (!isRecord(value)) return undefined
  const ctx = value['ctx']
  if (!isRecord(ctx)) return undefined
  if (typeof ctx['get'] === 'function' || isRecord(ctx['reflect'])) return ctx as HostContextLike
  return undefined
}

/**
 * 判断一个值是否是普通对象。
 *
 * @param value - 任意值。
 * @returns 是非 null 的对象时为 `true`。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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

export default installToolResultPrunerGuard
