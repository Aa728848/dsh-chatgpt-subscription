/**
 * 「压缩策略守卫」——把 `compaction-basic` 的预算换成 Kimi Code 的口径，
 * 并在摘要器接缝上原生替换压缩指令。
 *
 * ## 为什么需要它
 *
 * `compaction-basic` 的默认预算对 Kimi Code 这条线路是错的：
 *
 * - `retainRatio` 默认 0.16：压缩后保留的「逐字尾巴」按 16% 算，一条 256k 的
 *   会话就是 ~41k token。压缩本来是为了省上下文，结果重建尾巴又要付 41k 的
 *   全价输入。
 * - `thresholdRatio` 默认 0.8、`headroomTokens` 默认 65536：留给「还来得及压缩」
 *   的余量太大，真正该压缩的时候往往已经溢出了。
 *
 * 把 `retainTokens` 钉到 8192、`thresholdRatio` 收到 0.85、`headroomTokens`
 * 收到 32768，压缩后重建尾巴的代价就从 ~41k 降到 ~8k。
 *
 * ## 为什么不能直接改 preset 的配置
 *
 * `compaction-basic` 的配置在两处：
 *
 * 1. 本包的 `dispatch` preset 里（一个 isolate realm，行内实例）；
 * 2. 内置的 `standard` / `ptc` / `cordis` preset 里（各自的 realm）。
 *
 * realm 隔离之后，行内实例只存在于那个 realm 的 `ctx.reflect.store` 里，宿主
 * 平面根本看不到。所以这一层守卫待在**宿主平面**：它不替换任何行，只把已经挂载
 * 的压缩引擎的 `config` 就地改写一次，并在每次 agent 开始一步时补扫一遍。
 *
 * ## 改写是怎么生效的
 *
 * DSH 的 `resolveTargetPolicy(config, target)` 是这样找覆盖项的：
 *
 * ```ts
 * const override = config.modelPolicies.find(policy => (
 *   policy.provider === target.provider && policy.model === target.model
 * ))
 * ```
 *
 * 命中的覆盖项只要带 `retainTokens` 且没有 `retainRatio`，后面的
 * `resolveRetention` 就会用 `{ retainTokens }` 顶掉默认的 `{ retainRatio: 0.16 }`。
 *
 * 所以守卫把 `engine.config` 换成一份冻结副本，它的 `modelPolicies` 数组带一个
 * 自定义 `find`：
 *
 * 1. 先跑 `Array.prototype.find.call(原始策略, predicate, thisArg)`——用户自己写
 *    的显式策略永远优先，守卫不夺权。
 * 2. 没命中就拿预置的 Kimi 模型与动态观测到的 Kimi 模型逐个喂给 `predicate`。
 * 3. 还没命中就用一个 Proxy 探针问 `predicate` 要哪个模型：探针记录 predicate
 *    读过的属性，一旦 `predicate` 返回真，就合成一条冻结策略返回。
 *
 * 动态观测是主力：`resolveTargetPolicy` 的每个调用点（`compactIfNeeded` /
 * `compactPressure` / `compact` / `summarize`）都带着 `agent` 或 `header`，
 * 守卫在这些方法的入口读 `agent.session.requestHeader().config`（或
 * `agent.options`），把确切的 provider/model 登记进来——于是匹配用的是 100%
 * 标准的普通对象，没有一行依赖 Proxy 的巧合。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/host/compaction-policy-guard
 */
import { replaceCompactionInstruction, type PromptMessage } from './compaction-prompt.ts'

/** 压缩服务的名字（`ctx.reflect.store` 与 `ctx.get` 都用它）。 */
export const COMPACTION_SERVICE_NAME = 'compaction'

/** 受策略保护的 provider。 */
export const KIMI_COMPACTION_PROVIDER = 'kimi-code'

/**
 * Kimi Code 的压缩预算。
 *
 * - `retainTokens: 8192`：压缩后逐字保留的尾巴，替代默认的 16% 比例
 *   （一条 256k 会话上就是 ~41k → ~8k）。
 * - `thresholdRatio: 0.85`：更早触发压缩，别等溢出。
 * - `headroomTokens: 32768`：留给「还来得及压缩」的余量减半。
 * - `maxTokens: 32768`：摘要调用自身的输出上限。
 */
export const KIMI_COMPACTION_POLICY_DEFAULTS = Object.freeze({
  thresholdRatio: 0.85,
  headroomTokens: 32768,
  retainTokens: 8192,
  maxTokens: 32768,
  compactionRetries: 1,
  maxOverflowRetries: 1,
})

/** 预置的 Kimi Code 模型 id。 */
export const KIMI_CODE_MODELS: readonly string[] = Object.freeze([
  'kimi-for-coding',
  'kimi-for-coding-highspeed',
  'k3',
  'k3-256k',
  'k3.1-pro',
  'k3.1-pro-highspeed',
])

/** 守卫选项。 */
export interface CompactionPolicyGuardOptions {
  /** 受保护的 provider；省略时用 `kimi-code`。 */
  provider?: string
  /** 触发压缩的水位比例。 */
  thresholdRatio?: number
  /** 压力余量（token）。 */
  headroomTokens?: number
  /** 压缩后逐字保留的尾巴（token）。 */
  retainTokens?: number
  /** 摘要调用自身的输出上限（token）。 */
  maxTokens?: number
}

/** 守卫句柄。 */
export interface CompactionPolicyGuard {
  /** 还原所有被改写的引擎并移除事件监听；可重复调用。 */
  dispose(): void
  /**
   * 立刻尝试改写一个压缩引擎。
   *
   * @param engine - 候选引擎（结构探测，不看类身份）。
   * @returns 本次是否真的改写了（已改过、不是压缩引擎都为 `false`）。
   */
  patchEngine(engine: unknown): boolean
}

/** 一条策略的形状。 */
interface PolicyLike {
  provider: string
  model: string
  thresholdRatio?: number
  headroomTokens?: number
  retainTokens?: number
  maxTokens?: number
  compactionRetries?: number
  maxOverflowRetries?: number
}

/** 事件监听器签名。 */
type Listener = (...args: never[]) => unknown

/** `ctx.on` 的第三个参数形态（布尔是 `prepend` 的简写）。 */
type ListenerOptions = boolean | { prepend?: boolean }

/** reflect store 里的一条服务实现记录。 */
interface ServiceImplLike {
  /** 服务名。 */
  name?: unknown
  /** 当前服务值。 */
  value?: unknown
  /** 个别代把值放在 `impl` 上。 */
  impl?: unknown
}

/** 会先跑一遍扫描的宿主事件。 */
const GUARDED_EVENTS: readonly string[] = ['agent/pre-step', 'agent/request', 'agent/request-error']

/**
 * 装一台「压缩策略守卫」。
 *
 * @param ctx - 宿主上下文（结构探测；传入非对象时只返回一个空守卫）。
 * @param options - 守卫选项。
 * @returns 可销毁的句柄。
 */
export function installCompactionPolicyGuard(
  ctx: unknown,
  options: CompactionPolicyGuardOptions = {},
): CompactionPolicyGuard {
  const host = isRecord(ctx) ? (ctx as Record<string, unknown>) : undefined
  const provider = options.provider ?? KIMI_COMPACTION_PROVIDER
  const defaults: PolicyLike = {
    provider,
    model: '',
    thresholdRatio: options.thresholdRatio ?? KIMI_COMPACTION_POLICY_DEFAULTS.thresholdRatio,
    headroomTokens: options.headroomTokens ?? KIMI_COMPACTION_POLICY_DEFAULTS.headroomTokens,
    retainTokens: options.retainTokens ?? KIMI_COMPACTION_POLICY_DEFAULTS.retainTokens,
    maxTokens: options.maxTokens ?? KIMI_COMPACTION_POLICY_DEFAULTS.maxTokens,
    compactionRetries: KIMI_COMPACTION_POLICY_DEFAULTS.compactionRetries,
    maxOverflowRetries: KIMI_COMPACTION_POLICY_DEFAULTS.maxOverflowRetries,
  }
  /** 动态观测到的 Kimi 模型（按 provider 分桶）。 */
  const observed = new Map<string, Set<string>>()
  /** 已改写的引擎（幂等标记）与还原动作。 */
  const patched = new WeakMap<object, () => void>()
  /** 已包装过的「方法宿主 + 方法名」：同一个原型不叠第二层包装。 */
  const patchedMethods = new WeakMap<object, Set<string>>()
  const restores: Array<() => void> = []
  /** 事件监听的 disposer。 */
  const disposers: Array<() => void> = []
  let disposed = false

  /**
   * 合成一条 Kimi 策略。
   *
   * @param model - 模型 id。
   * @param targetProvider - provider。
   * @returns 冻结的策略。
   */
  const policyFor = (model: string, targetProvider: string): PolicyLike =>
    Object.freeze({ ...defaults, provider: targetProvider, model })

  /**
   * 登记一个观测到的 provider/model。
   *
   * @param targetProvider - provider。
   * @param model - 模型 id。
   */
  const observe = (targetProvider: string, model: string): void => {
    if (targetProvider.length === 0 || model.length === 0) return
    let models = observed.get(targetProvider)
    if (models === undefined) {
      models = new Set<string>()
      observed.set(targetProvider, models)
    }
    models.add(model)
  }

  /**
   * 当前可用的候选策略：预置的 Kimi 模型 + 动态观测到的模型。
   *
   * @returns 候选策略列表。
   */
  const candidates = (): PolicyLike[] => {
    const list: PolicyLike[] = []
    const models = observed.get(provider)
    const seen = new Set<string>()
    for (const model of KIMI_CODE_MODELS) {
      seen.add(model)
      list.push(policyFor(model, provider))
    }
    if (models !== undefined) {
      for (const model of models) {
        if (seen.has(model)) continue
        seen.add(model)
        list.push(policyFor(model, provider))
      }
    }
    return list
  }

  /**
   * 从一个 agent（或一个 header）读出确切的 provider/model 并登记。
   *
   * @param source - agent、header 或配置对象。
   */
  const observeFrom = (source: unknown): void => {
    if (!isRecord(source)) return
    const session = source['session']
    if (isRecord(session)) {
      const requestHeader = session['requestHeader']
      if (typeof requestHeader === 'function') {
        let header: unknown
        try {
          header = requestHeader.call(session)
        } catch {
          header = undefined
        }
        if (isRecord(header)) {
          const config = header['config']
          if (isRecord(config)) {
            observe(readString(config['provider']), readString(config['model']))
          }
        }
      }
    }
    const optionsField = source['options']
    if (isRecord(optionsField)) {
      observe(readString(optionsField['provider']), readString(optionsField['model']))
    }
    // header 本身就是一次请求的配置。
    const config = source['config']
    if (isRecord(config)) {
      observe(readString(config['provider']), readString(config['model']))
    }
  }

  /**
   * 读一个字符串字段。
   *
   * @param value - 任意值。
   * @returns 非空字符串；否则为空串。
   */
  const readString = (value: unknown): string =>
    typeof value === 'string' ? value : ''

  /**
   * 造一个探针：predicate 读 `provider` / `model` 时都被记录下来。
   *
   * @param model - 探针提供的模型 id。
   * @param targetProvider - 探针提供的 provider。
   * @returns 代理对象。
   */
  const probeFor = (model: string, targetProvider: string): PolicyLike => {
    const base = policyFor(model, targetProvider)
    return new Proxy(base, {
      get(target, property, receiver): unknown {
        if (property === 'provider' || property === 'model') {
          return Reflect.get(target, property, receiver)
        }
        return Reflect.get(target, property, receiver)
      },
    })
  }

  /**
   * 改写一个压缩引擎。
   *
   * @param engine - 候选引擎。
   * @returns 是否真的改写了。
   */
  const patchEngine = (engine: unknown): boolean => {
    if (disposed || !isRecord(engine)) return false
    if (patched.has(engine)) return false
    const config = engine['config']
    if (!isRecord(config)) return false
    const originalPolicies = config['modelPolicies']
    if (!Array.isArray(originalPolicies)) return false

    const originalConfig = config
    const policies = [...originalPolicies] as PolicyLike[]

    /**
     * 自定义 `find`：显式策略优先，其次候选策略，最后探针。
     *
     * @param predicate - `resolveTargetPolicy` 传进来的匹配函数。
     * @param thisArg - 调用方给的 this。
     * @returns 命中的策略；没有时为 `undefined`。
     */
    const find = function (this: unknown, predicate: unknown, thisArg: unknown): PolicyLike | undefined {
      const match = predicate as ((value: unknown, index: number, array: unknown[]) => unknown) | undefined
      if (typeof match !== 'function') {
        return Array.prototype.find.call(originalPolicies, predicate as never, thisArg) as PolicyLike | undefined
      }
      // 1. 用户自己写的显式策略永远优先。
      const explicit = Array.prototype.find.call(
        originalPolicies,
        predicate as never,
        thisArg,
      ) as PolicyLike | undefined
      if (explicit !== undefined) return explicit
      // 2. 预置 + 动态观测到的 Kimi 策略。
      for (const candidate of candidates()) {
        if (match.call(thisArg, candidate, 0, policies)) return candidate
      }
      // 3. 探针：问 predicate 要哪个模型。命中就合成一条冻结策略。
      const observedModels = observed.get(provider)
      const lastModel = observedModels === undefined ? undefined : [...observedModels].at(-1)
      if (lastModel !== undefined) {
        const probe = probeFor(lastModel, provider)
        if (match.call(thisArg, probe, 0, policies)) return policyFor(lastModel, provider)
      }
      return undefined
    }

    Object.defineProperty(policies, 'find', {
      value: find,
      configurable: true,
      writable: true,
      enumerable: false,
    })
    Object.freeze(policies)

    const patchedConfig = Object.freeze({ ...originalConfig, modelPolicies: policies })
    const configDescriptor = Object.getOwnPropertyDescriptor(engine, 'config')
    try {
      Object.defineProperty(engine, 'config', {
        value: patchedConfig,
        configurable: true,
        writable: true,
        enumerable: configDescriptor?.enumerable ?? true,
      })
    } catch {
      return false
    }

    const restoresForEngine: Array<() => void> = []
    restoresForEngine.push(() => {
      try {
        if (configDescriptor === undefined) {
          delete (engine as Record<string, unknown>)['config']
        } else {
          Object.defineProperty(engine, 'config', configDescriptor)
        }
      } catch {
        // 引擎已经卸载：忽略。
      }
    })

    // ── 方法包装：观测模型 + 原生替换压缩指令 ─────────────────────────────
    for (const name of ['compactIfNeeded', 'compactPressure', 'compact', 'summarize'] as const) {
      // 取原型上那份**未绑定**的实现：跟踪代理读出来的那份绑在读取它的那一层作用域上，
      // 再 original.apply(this, …) 会把调用方的作用域弄丢。
      const target = resolveMethodTarget(engine, name)
      if (target === undefined) continue
      if (alreadyPatched(patchedMethods, target.holder, target.name)) continue
      const original = target.original
      const replacement: UnboundMethod = function (this: unknown, ...args: unknown[]): unknown {
        // 观测：这些方法的入参里一定带着 agent 或 header。
        observeFrom(args[0])
        observeFrom(args[1])
        let nextArgs = args
        if (name === 'summarize') {
          const input = args[0]
          if (isRecord(input)) {
            const messages = input['messages']
            if (Array.isArray(messages)) {
              const replaced = replaceCompactionInstruction(messages as readonly PromptMessage[])
              if (replaced !== messages) {
                nextArgs = [{ ...input, messages: replaced }, ...args.slice(1)]
              }
            }
          }
        }
        // receiver 用**调用方**的 this：服务里的 this.ctx 留在调用方那一层作用域。
        return original.apply(this ?? engine, nextArgs)
      }
      if (!installMethod(target, replacement)) continue
      markPatched(patchedMethods, target.holder, target.name)
      restoresForEngine.push(() => {
        restoreMethod(target)
      })
    }

    const restore = (): void => {
      for (const undo of restoresForEngine.splice(0).reverse()) {
        try {
          undo()
        } catch {
          // 卸载期的单点失败不影响其余卸载。
        }
      }
    }
    patched.set(engine, restore)
    restores.push(restore)
    return true
  }

  /**
   * 按 reflect store 里的一条记录找引擎。
   *
   * @param entry - store 里的一条记录。
   * @returns 是否改写了新引擎。
   */
  const patchStoreEntry = (entry: unknown): boolean => {
    if (!isRecord(entry)) return false
    const record = entry as ServiceImplLike
    const name = readServiceName(record)
    if (name !== undefined && name !== COMPACTION_SERVICE_NAME) return false
    const value = record.value ?? record.impl
    if (isRecord(value)) {
      if (patchEngine(value)) return true
      const nested = value['engine']
      if (nested !== undefined) return patchEngine(nested)
      return false
    }
    return patchEngine(entry)
  }

  /**
   * 扫描一个上下文自己的 reflect store。
   *
   * @param target - 任意宿主上下文（宿主平面或某个 agent 的 realm）。
   * @returns 本次新改写的引擎数。
   */
  const scanStore = (target: unknown): number => {
    if (!isRecord(target)) return 0
    const reflect = target['reflect']
    if (!isRecord(reflect)) return 0
    const store = reflect['store']
    if (!isRecord(store)) return 0
    const services = store as Record<symbol, unknown>
    let count = 0
    for (const key of Object.getOwnPropertySymbols(services)) {
      if (patchStoreEntry(services[key])) count += 1
    }
    return count
  }

  /**
   * 用 `ctx.get(name)` 取一个服务并尝试改写。
   *
   * @param target - 任意宿主上下文。
   * @param name - 服务名。
   * @returns 是否改写了新引擎。
   */
  const patchServiceFrom = (target: unknown, name: string): boolean => {
    if (!isRecord(target)) return false
    const get = target['get']
    if (typeof get !== 'function') return false
    try {
      const service = get.call(target, name)
      if (!isRecord(service)) return false
      if (patchEngine(service)) return true
      const nested = service['engine']
      return nested === undefined ? false : patchEngine(nested)
    } catch {
      // 这一代没有该服务，或读取抛错（fiber 未激活）：下一轮事件再看。
      return false
    }
  }

  /**
   * 扫描宿主平面的所有已知位置。
   *
   * @returns 本次新改写的引擎数。
   */
  const scanAndPatch = (): number => {
    if (disposed) return 0
    let count = scanStore(host)
    if (patchServiceFrom(host, COMPACTION_SERVICE_NAME)) count += 1
    return count
  }

  /**
   * 事件回调：先观测模型，再扫宿主平面与 agent 自己的 realm。
   *
   * @param args - 事件参数。
   */
  const handleAgentEvent: Listener = (...args) => {
    try {
      for (const arg of args) {
        observeFrom(arg)
        if (isRecord(arg)) {
          observeFrom(arg['agent'])
        }
      }
      scanAndPatch()
      const agentCtx = findAgentContext(args)
      if (agentCtx === undefined) return
      scanStore(agentCtx)
      patchServiceFrom(agentCtx, COMPACTION_SERVICE_NAME)
    } catch {
      // 守卫是旁路：任何一步失败都不该影响这一步本身。
    }
  }

  for (const event of GUARDED_EVENTS) {
    const disposer = subscribe(host, event, handleAgentEvent)
    if (disposer !== undefined) disposers.push(disposer)
  }
  scanAndPatch()

  return {
    patchEngine,
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
      for (const restore of restores.splice(0).reverse()) {
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
 * @param args - 事件参数。
 * @returns agent 的上下文；认不出时为 `undefined`。
 */
function findAgentContext(args: readonly unknown[]): Record<string, unknown> | undefined {
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
function readContext(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const ctx = value['ctx']
  if (!isRecord(ctx)) return undefined
  if (typeof ctx['get'] === 'function' || isRecord(ctx['reflect'])) return ctx
  return undefined
}

/**
 * 订阅一个事件，优先用 `prepend: true`。
 *
 * @param host - 宿主上下文。
 * @param event - 事件名。
 * @param listener - 回调。
 * @returns 移除监听器的 disposer；宿主不支持事件时为 `undefined`。
 */
function subscribe(
  host: Record<string, unknown> | undefined,
  event: string,
  listener: Listener,
): (() => void) | undefined {
  const on = host?.['on']
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
      const off = host?.['off']
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

export default installCompactionPolicyGuard
