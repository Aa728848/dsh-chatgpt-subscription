/**
 * 「PTC SDK 段前缀缓存守卫」——把 `tools:sdk` 段按会话冻结下来。
 *
 * ## 为什么需要它
 *
 * PTC 模式下模型看到的不是逐个工具 schema，而是 system prompt 里的一段
 * `tools:sdk`（TypeScript / Python 的 SDK 声明）。这段正文由工具注册表在
 * **装配那一刻**现算：`tools.definitions(scope, toolSet)`。
 *
 * 带 `when` 条件的工具（按步骤准入）会让 `toolSet` 逐步变化：这一步准入了
 * `exit_plan_mode`，下一步又没准入，于是 `tools:sdk` 段逐步重写。system prompt
 * 一旦被改写，前缀缓存从改写处起全部作废——在 Kimi Code 这种按前缀缓存计费的
 * 线路上，一次抖动就是几万 token 的全价重建。
 *
 * ## 做什么、不做什么
 *
 * 1. 包住 `tools.definitions(scope, toolSet)`：受保护 provider 下忽略步骤级
 *    `toolSet`，一律取未过滤的 `definitions(scope, undefined)`。
 * 2. **不碰** `tools.executable(name, scope, toolSet)`：执行期的步骤准入闸门
 *    原样保留，`when` 为假时调用该工具照样失败（`UNKNOWN_TOOL`）。工具「看得见」
 *    与「叫得动」被刻意拆开：看得见是为了缓存稳定，叫得动仍由步骤准入说话。
 * 3. 监听 `system-prompt/assemble` 瀑布，把首个非空 `tools:sdk` 正文按会话缓存；
 *    只要未过滤工具集的名字与数量没变（工具注册/注销是唯一的合法变更来源），
 *    后续每一步都复用同一份字节。
 *
 * ## 跨代兼容
 *
 * `definitions(scope, toolSet)` 只在较新的工具层里存在。没有它的那一代
 * （`schemas(scope)` 形态）本守卫什么也不包：那一代的工具表本来就是逐步稳定的，
 * 缓存不会抖动，守卫无事可做。因此这里全程结构探测，不 import 任何工具层类型。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/host/ptc-sdk-cache-guard
 */

/** 受保护的 provider：默认只有 Kimi Code 线路。 */
export const KIMI_CODE_PROVIDER = 'kimi-code'

/** PTC 生成的 SDK 段名。 */
export const PTC_SDK_SECTION_NAME = 'tools:sdk'

/** 守卫选项。 */
export interface PtcSdkCacheGuardOptions {
  /**
   * 命中即冻结 `tools:sdk` 的 provider 名单。
   *
   * 省略时用 `['kimi-code']`。
   */
  providers?: readonly string[]
}

/** 守卫句柄。 */
export interface PtcSdkCacheGuard {
  /** 还原被包装的 `tools.definitions` 并移除事件监听；可重复调用。 */
  dispose(): void
  /**
   * 立刻尝试包装一个工具注册表实例。
   *
   * @param tools - 候选实例（结构探测，不看类身份）。
   * @returns 本次是否真的包上了（已包过、不是工具层、没有 `definitions` 都为 `false`）。
   */
  wrapToolsService(tools: unknown): boolean
}

/** 被包装方法的原签名。 */
type DefinitionsMethod = (this: unknown, scope?: unknown, toolSet?: unknown) => readonly unknown[]

/** 工具注册表（只按结构描述我们用到的那一个方法）。 */
interface ToolsServiceLike {
  /** 可见定义；新代带步骤准入参数，旧代没有。 */
  definitions?: DefinitionsMethod
}

/** 事件监听器签名。 */
type Listener = (...args: never[]) => unknown

/** `ctx.on` 的第三个参数形态（布尔是 `prepend` 的简写）。 */
type ListenerOptions = boolean | { prepend?: boolean }

/** 系统段（只读名字与正文）。 */
interface AssembledSectionLike {
  /** 段名。 */
  name?: unknown
  /** 段正文。 */
  text?: unknown
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

/** 一个会话桶里缓存的 SDK 段。 */
interface SdkCacheEntry {
  /** 未过滤工具集的名字指纹；变了就重新缓存。 */
  key: string
  /** 缓存的正文。 */
  text: string
}

/** 没有 scope 的装配（会话标题之类）用的桶键。 */
const GLOBAL_KEY = Object.freeze({})

/**
 * 读一个装配 scope 的 provider。
 *
 * 三处来源按可靠性排序：请求头快照（唯一反映「这一步真的路由到哪个 provider」）
 * → agent 选项（还没发出请求时唯一的意图） → scope 上的裸 provider 字段。
 *
 * @param scope - 装配 scope（通常是 agent）。
 * @returns provider id；读不到时为 `undefined`。
 */
export function readScopeProvider(scope: unknown): string | undefined {
  if (!isRecord(scope)) return undefined
  const session = scope['session']
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
          const provider = config['provider']
          if (typeof provider === 'string' && provider.length > 0) return provider
        }
      }
    }
  }
  const options = scope['options']
  if (isRecord(options)) {
    const provider = options['provider']
    if (typeof provider === 'string' && provider.length > 0) return provider
  }
  const provider = scope['provider']
  if (typeof provider === 'string' && provider.length > 0) return provider
  return undefined
}

/**
 * 装一台「PTC SDK 段缓存守卫」。
 *
 * 幂等性由 `WeakSet` 保证：同一个工具注册表实例只包一次。
 *
 * @param ctx - 宿主上下文（结构探测；传入非对象时只返回一个空守卫）。
 * @param options - 守卫选项。
 * @returns 可销毁的句柄。
 */
export function installPtcSdkCacheGuard(
  ctx: unknown,
  options: PtcSdkCacheGuardOptions = {},
): PtcSdkCacheGuard {
  const host = isRecord(ctx) ? (ctx as Record<string, unknown>) : undefined
  const providers = new Set<string>(options.providers ?? [KIMI_CODE_PROVIDER])
  /** 已包装过的实例（幂等标记）。 */
  const alreadyWrapped = new WeakSet<object>()
  /** 已包装过的「方法宿主 + 方法名」：同一个原型不叠第二层包装。 */
  const patchedMethods = new WeakMap<object, Set<string>>()
  /** 每个 scope 的 SDK 段缓存。 */
  const cache = new WeakMap<object, SdkCacheEntry>()
  /** 事件监听的 disposer。 */
  const disposers: Array<() => void> = []
  /** 被包装过的工具层与其还原动作。 */
  const restores: Array<() => void> = []
  let disposed = false

  /**
   * 取一个 scope 桶键。
   *
   * @param scope - 装配 scope。
   * @returns WeakMap 键。
   */
  const bucketOf = (scope: unknown): object =>
    typeof scope === 'object' && scope !== null ? scope as object : GLOBAL_KEY

  /**
   * 算未过滤工具集的名字指纹。
   *
   * 指纹变了就意味着工具被注册或注销了——那是唯一允许 `tools:sdk` 变化的合法
   * 原因，缓存据此失效。
   *
   * @param tools - 工具注册表。
   * @param scope - 装配 scope。
   * @returns 指纹；读不到时为空串（缓存永不失效）。
   */
  const toolFingerprint = (tools: unknown, scope: unknown): string => {
    if (!isRecord(tools)) return ''
    // 取原型上那份**未绑定**的实现：跟踪代理读出来的那份绑在读取它的那一层作用域上。
    const target = resolveMethodTarget(tools, 'definitions')
    if (target === undefined) return ''
    let list: unknown
    try {
      list = (target.original as DefinitionsMethod).call(tools, scope, undefined)
    } catch {
      return ''
    }
    if (!Array.isArray(list)) return ''
    return list
      .map(entry => (isRecord(entry) && typeof entry['name'] === 'string' ? entry['name'] : '?'))
      .join('\u0000')
  }

  /**
   * 包一个工具注册表的 `definitions`。
   *
   * @param tools - 候选实例。
   * @returns 是否真的包上了。
   */
  const wrapToolsService = (tools: unknown): boolean => {
    if (disposed || !isRecord(tools)) return false
    if (alreadyWrapped.has(tools)) return false
    // 取原型上那份**未绑定**的实现：跟踪代理读出来的那份绑在读取它的那一层作用域上，
    // 再 original.call(tools, …) 会把调用方的作用域弄丢。
    const target = resolveMethodTarget(tools, 'definitions')
    if (target === undefined) return false
    if (alreadyPatched(patchedMethods, target.holder, target.name)) {
      // 同一类的另一个实例共享原型上那份包装，不再叠一层。
      alreadyWrapped.add(tools)
      return false
    }
    const original = target.original as DefinitionsMethod
    const replacement = function (this: unknown, scope?: unknown, toolSet?: unknown): readonly unknown[] {
      // receiver 用**调用方**的 this：服务里的 this.ctx 留在调用方那一层作用域。
      const receiver = this ?? tools
      if (toolSet !== undefined) {
        const provider = readScopeProvider(scope)
        if (provider !== undefined && providers.has(provider)) {
          // 受保护线路：忽略步骤级过滤，工具表逐步恒定。
          return original.call(receiver, scope, undefined)
        }
      }
      return original.call(receiver, scope, toolSet)
    }
    if (!installMethod(target, replacement)) return false
    markPatched(patchedMethods, target.holder, target.name)
    alreadyWrapped.add(tools)
    restores.push(() => {
      restoreMethod(target)
    })
    return true
  }

  /**
   * 找一个上下文里的工具注册表并包它。
   *
   * @param target - 任意宿主上下文。
   * @returns 是否包上了新实例。
   */
  const wrapServiceFrom = (target: unknown): boolean => {
    if (!isRecord(target)) return false
    const get = target['get']
    if (typeof get !== 'function') return false
    try {
      return wrapToolsService(get.call(target, 'tools'))
    } catch {
      // 这一代没有该服务，或读取抛错（fiber 未激活）：下一轮再看。
      return false
    }
  }

  // ── system-prompt/assemble：按会话冻结 tools:sdk 正文 ────────────────────
  /** 当前已包装的工具层；指纹用它算未过滤工具集。 */
  let currentTools: unknown
  const onAssemble = async (
    _assembly: PresentationLike,
    context: AssembleContextLike,
    next: () => Promise<PresentationLike>,
  ): Promise<PresentationLike> => {
    const result = await next()
    const sections = Array.isArray(result?.sections) ? result.sections : undefined
    if (sections === undefined) return result
    const scope = context?.scope ?? context?.agent
    const provider = readScopeProvider(scope)
    if (provider === undefined || !providers.has(provider)) return result
    const index = sections.findIndex(section => section?.name === PTC_SDK_SECTION_NAME)
    if (index < 0) return result
    const section = sections[index]
    const text = typeof section?.text === 'string' ? section.text : ''
    const bucket = bucketOf(scope)
    const fingerprint = toolFingerprint(currentTools, scope)
    const cached = cache.get(bucket)
    if (cached !== undefined && cached.key === fingerprint && cached.text.length > 0) {
      if (cached.text === text) return result
      const kept = [...sections]
      kept[index] = { ...section, text: cached.text }
      return { ...result, sections: kept }
    }
    if (text.length > 0) {
      cache.set(bucket, { key: fingerprint, text })
    }
    return result
  }

  const offAssemble = subscribe(host, 'system-prompt/assemble', onAssemble as unknown as Listener)
  if (offAssemble !== undefined) disposers.push(offAssemble)

  // ── 工具层：现在有就包，没有就等注入 ─────────────────────────────────────
  const initialTools = serviceOf(host, 'tools')
  if (initialTools !== undefined) {
    currentTools = initialTools
    wrapToolsService(initialTools)
  } else {
    const inject = host?.['inject']
    if (typeof inject === 'function') {
      try {
        inject.call(host, ['tools'], (scope: unknown) => {
          if (disposed) return
          const tools = serviceOf(scope, 'tools')
          if (tools === undefined) return
          currentTools = tools
          wrapToolsService(tools)
        })
      } catch {
        // 没有注入面：这一代就只能靠上面那次直接探测。
      }
    }
  }

  return {
    wrapToolsService,
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
 * 读一个可选服务。
 *
 * @param ctx - 宿主上下文。
 * @param service - 服务名。
 * @returns 服务实例；读不到时为 `undefined`。
 */
function serviceOf(ctx: unknown, service: string): unknown {
  if (!isRecord(ctx)) return undefined
  const read = ctx['get']
  if (typeof read !== 'function') return undefined
  try {
    return read.call(ctx, service)
  } catch {
    return undefined
  }
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

export default installPtcSdkCacheGuard
