/**
 * 工具归属判定：一个名字是**全局层**注册的，还是**本预设**注册的。
 *
 * ## 为什么要这么绕
 *
 * 注册表没有公开「某个工具注册在哪个作用域」的 API。`@deepseek-ai/dsh-scope` 把作用域标签
 * 写在一个模块私有的 `Symbol('dsh.scope')` 上，链关系（parent）也在私有 WeakMap 里，
 * 都不导出。能用的只有两件事：
 *
 * 1. 本包自己所在作用域的 key —— 按符号描述从 ctx 上扫出来（{@link findScopeKey}）；
 * 2. 公开的 `ctx.tools.get(name)`（全局视图）与 `ctx.tools.get(name, key)`（该作用域视图）。
 *
 * 于是归属判定变成两次公开查询：
 *
 * - 全局视图能解析 → 全局层（MCP 服务端、profile 级 bundle）；
 * - 只有本预设视图能解析 → 本预设自己注册的；
 * - 两处都解析不到 → 只可能注册在本预设之下（agent 层）。
 *
 * 探测失败（本包被挂在 host 层而不是预设里）时返回 `enabled: false`：规则整体降级为
 * 纯名字匹配，绝不因为读不到归属就误遮蔽。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/host/codemode/scope
 */

import { DISABLED_VIEW, type CodemodeView } from './rules.ts'

/** 作用域不可用时的空视图（从规则模块转出，调用方只需认识一个模块）。 */
export { DISABLED_VIEW } from './rules.ts'

/** 内核写作用域标签用的符号描述。 */
const SCOPE_SYMBOL_DESCRIPTION = 'dsh.scope'

/** 注册表上本模块会用到的那一个方法。 */
interface RegistryLike {
  /** 按名字（可选作用域）解析可见定义。 */
  get(name: string, scope?: object): unknown
}

/**
 * 从一个 ctx 上找出「本包所在作用域」的 key。
 *
 * Cordis 的 scoped context 把作用域标签写成自有（或原型上）的一个 symbol 属性，
 * 描述是 `dsh.scope`。这里按描述扫，不猜符号本身——写法与参考实现一致，因为
 * 直接 `import` 内核的 scope 包在 profile 插件里解析不到。
 *
 * @param ctx - 本包的行上下文。
 * @returns 作用域 key；读不到时为 `undefined`。
 */
export function findScopeKey(ctx: unknown): object | undefined {
  if (typeof ctx !== 'object' || ctx === null) return undefined
  const found = scanForScope(ctx as Record<PropertyKey, unknown>, 0)
  return found
}

/** 在对象自身及其原型链上找作用域标签（只看 symbol 属性，深度上限 4）。 */
function scanForScope(source: Record<PropertyKey, unknown>, depth: number): object | undefined {
  if (depth > 4) return undefined
  let symbols: symbol[]
  try {
    symbols = Object.getOwnPropertySymbols(source)
  } catch {
    return undefined
  }
  for (const symbol of symbols) {
    if (symbol.description !== SCOPE_SYMBOL_DESCRIPTION) continue
    let value: unknown
    try {
      value = (source as Record<symbol, unknown>)[symbol]
    } catch {
      continue
    }
    if (typeof value === 'object' && value !== null) return value
  }
  const proto = Object.getPrototypeOf(source) as Record<PropertyKey, unknown> | null
  if (proto === null || proto === Object.prototype) return undefined
  return scanForScope(proto, depth + 1)
}

/**
 * 为一个名字清单建立归属视图。
 *
 * @param tools - 工具注册表（结构探测，不看类身份）。
 * @param scopeKey - 本预设的作用域 key；`undefined` 表示探测失败。
 * @param names - 要判定的名字（通常是本步的模型可见清单）。
 * @returns 归属视图；读不到任何归属时返回禁用视图。
 */
export function resolveCatalogView(
  tools: unknown,
  scopeKey: object | undefined,
  names: readonly string[],
): CodemodeView {
  const registry = asRegistry(tools)
  if (scopeKey === undefined || registry === undefined) return DISABLED_VIEW
  const globalNames = new Set<string>()
  const presetNames = new Set<string>()
  for (const name of names) {
    if (typeof name !== 'string' || name.length === 0) continue
    if (probes(registry, name, undefined)) globalNames.add(name)
    if (probes(registry, name, scopeKey)) presetNames.add(name)
  }
  return { enabled: true, globalNames, presetNames }
}

/**
 * 判定一个名字在**调用时**是否属于本预设之外的层。
 *
 * 拒绝路径（模型直呼被遮蔽的名字）没有当步清单可用，只能按同一个视图单独判一次；
 * 判定规则与 {@link resolveCatalogView} 完全一致，两处因此不可能给出互相矛盾的结论。
 *
 * @param tools - 工具注册表。
 * @param scopeKey - 本预设的作用域 key。
 * @param name - 工具名。
 * @returns 归属视图（只含这一个名字）。
 */
export function resolveNameView(tools: unknown, scopeKey: object | undefined, name: string): CodemodeView {
  const registry = asRegistry(tools)
  if (scopeKey === undefined || registry === undefined) return DISABLED_VIEW
  const globalNames = new Set<string>()
  const presetNames = new Set<string>()
  if (probes(registry, name, undefined)) globalNames.add(name)
  if (probes(registry, name, scopeKey)) presetNames.add(name)
  return { enabled: true, globalNames, presetNames }
}

/** 一次公开查询：解析得到定义时为 `true`。 */
function probes(registry: RegistryLike, name: string, scope: object | undefined): boolean {
  try {
    return registry.get(name, scope) !== undefined
  } catch {
    return false
  }
}

/** 结构探测：读得到 `get` 就当注册表用。 */
function asRegistry(tools: unknown): RegistryLike | undefined {
  if (typeof tools !== 'object' || tools === null) return undefined
  const get = (tools as { get?: unknown }).get
  if (typeof get !== 'function') return undefined
  return tools as RegistryLike
}
