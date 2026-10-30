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
 * 这一层守卫因此待在**宿主平面**：它不替换任何行，只在下述两个时机把已经挂载
 * 的 `toolResultPruner` 实例的 `pruneSession` 包一层 provider 短路 ——
 * 安装时先扫一遍，此后每个 agent 开始一步（`agent/pre-step`）或撞上上下文溢出
 * （`agent/request-error`）时再扫一遍。两个位置都要看：
 *
 * - `ctx.reflect.store`（宿主平面自己的服务记录，含安装后才挂上的实例）；
 * - `agent.ctx.get('toolResultPruner')` 与 `agent.ctx.reflect.store`
 *   （preset 隔离 realm 里的实例，宿主 store 里根本没有它）。
 *
 * 包装按 `WeakSet` 幂等，重复事件不会叠第二层；`dispose()` 逐条还原原方法并
 * 摘掉监听器。
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

/** 事件监听器签名。 */
type Listener = (...args: unknown[]) => void

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

/** 会先跑一遍扫描的宿主事件。 */
const GUARDED_EVENTS: readonly string[] = ['agent/pre-step', 'agent/request-error']

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
  /** 已包装的方法，销毁时逐条还原。 */
  const restores: Array<{ target: Record<string, unknown>; original: unknown }> = []
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
    const target = pruner as Record<string, unknown>
    const current = target['pruneSession']
    if (typeof current !== 'function') return false
    const original = current as PruneSessionMethod
    const replacement = function (this: unknown, session: unknown): unknown {
      if (shouldSkipPruningForSession(session, skipSet)) {
        return { pruned: [], charsRemoved: 0 }
      }
      return original.call(this, session)
    }
    target['pruneSession'] = replacement
    alreadyWrapped.add(pruner)
    restores.push({ target, original })
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
   * @param args - 事件参数（通常第一个是 agent 本身）。
   */
  const handleAgentEvent: Listener = (...args) => {
    try {
      scanAndWrap()
      const agentCtx = findAgentContext(args)
      if (agentCtx === undefined) return
      scanStore(agentCtx)
      wrapServiceFrom(agentCtx, PRUNER_SERVICE_NAME)
    } catch {
      // 守卫是旁路：任何一步失败都不该影响这一步本身。
    }
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
      for (const record of restores.splice(0)) {
        record.target['pruneSession'] = record.original
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

export default installToolResultPrunerGuard
