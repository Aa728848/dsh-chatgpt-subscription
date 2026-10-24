/**
 * 「进展更新」设置卡片的**数据通道**：把本插件 Config 里的两个字段接到共享设置表单上。
 *
 * ## 和源实现（独立插件 dsh-progress-updates）的区别
 *
 * 那边绑的是一个**自己的命名空间** `dsh-progress-updates` 的 `enabled` /
 * `nudgeThreshold`。搬进本插件之后设置项已经并进了本插件的 Config，字段名是
 * `progressUpdates` / `progressUpdatesNudgeThreshold`（见 `src/index.ts` 的
 * `Config` schema），两个都是 `volatile()`——保存即生效、不重挂插件行。
 * 所以这里绑的是**本插件自己的 profile 条目**，字段名也必须逐字对上：表单写入
 * 走的是条目配置的根字段路径，写错一个字母就是写到别处（或者被 schema 拒掉）。
 *
 * ## 条目 id 从哪来
 *
 * 0.1.7 之后的设置面按 profile 条目 id 寻址一张表单（`ctx.configForms.get(entryId)`），
 * 而插件只知道自己的名字。条目 id 随安装形态而变：独立安装是 `cordis.patch.yml`
 * 那行的 `id: dsh-chatgpt-subscription`；聚合安装（dsh-web-all 一类）会套一层
 * 家族前缀。所以这里**先问镜像**：`describe()` 会把每个活跃条目的解析值都列出来，
 * 谁的值里带 `progressUpdates` 这个键，谁就是本插件的那一条——这比硬编码一串
 * 候选 id 更准，而且不含任何允许清单。
 *
 * 镜像还没答上来时先按第一个候选绑定，镜像一答上来就重绑到它真正服务的那一个。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/progress-updates/settings-binding
 */

export interface ConfigFormSnapshot<T> {
  status: 'loading' | 'ready' | 'unavailable'
  value: T | undefined
  base: unknown
  user: unknown
  revision: number | undefined
  writable: boolean
}

interface ConfigForm<T> {
  getSnapshot(): ConfigFormSnapshot<T>
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<boolean>
}

/**
 * 本卡片驱动的两个字段。
 *
 * 名字与 `src/index.ts` 的 `Config` schema **逐字一致**（`progressUpdates` /
 * `progressUpdatesNudgeThreshold`），不是源实现那套 `enabled` / `nudgeThreshold`。
 */
export interface ProgressUpdatesSettingsValues {
  /** 总开关。 */
  progressUpdates?: boolean
  /** 催促阈值：连续多少轮无进展就提醒一次。 */
  progressUpdatesNudgeThreshold?: number
  /**
   * 输出语言：auto 跟随对话、zh 中文、en 英文。
   *
   * 这里手写这三个字面量而不是从宿主侧 import 类型：浏览器半边是另一个运行时
   * 的独立 bundle，把宿主模块拉进来只为拿一个联合类型不值得。两边的取值必须
   * 逐字一致（宿主 Config schema 里的枚举就是这三个）。
   */
  progressUpdatesLanguage?: 'auto' | 'zh' | 'en'
}

/** 输出语言的三种取值，供界面侧声明变量类型。 */
export type ProgressUpdatesLanguage = NonNullable<ProgressUpdatesSettingsValues['progressUpdatesLanguage']>

/** 表单可写的那三个字段名（联合类型，写错名字编译期就报）。 */
export type ProgressUpdatesField =
  | 'progressUpdates'
  | 'progressUpdatesNudgeThreshold'
  | 'progressUpdatesLanguage'

/**
 * 候选条目 id，按可能性从高到低。
 *
 * 第一项来自 `cordis.patch.yml` 的行 id（独立安装的唯一形态）；后两项是聚合安装
 * 可能套的前缀。镜像答上来之后不再用这张表的顺序，改用"值里带 `progressUpdates`
 * 的那一条"。
 */
export const PROGRESS_SETTINGS_ENTRY_IDS: readonly string[] = [
  'dsh-chatgpt-subscription',
  'web-ui-chatgpt-subscription',
  'chatgpt-subscription',
]

/** 卡片真正用到的那几个成员，外加一个释放函数。 */
export interface ProgressSettingsForm {
  /** 当前快照（引用必须稳定，供 useSyncExternalStore 使用）。 */
  getSnapshot(): ConfigFormSnapshot<ProgressUpdatesSettingsValues>
  /** 订阅快照变化。 */
  subscribe(listener: () => void): () => void
  /** 写一个根字段；返回宿主是否接受。 */
  set(field: ProgressUpdatesField, value: boolean | number | string): Promise<boolean>
  /** 释放镜像订阅与内部表单订阅（插件卸载时调用）。 */
  dispose(): void
}

/** 还没拿到宿主答案时的快照。 */
const PENDING: ConfigFormSnapshot<ProgressUpdatesSettingsValues> = Object.freeze({
  status: 'loading',
  value: undefined,
  base: undefined,
  user: undefined,
  revision: undefined,
  writable: false,
}) as ConfigFormSnapshot<ProgressUpdatesSettingsValues>

/** describe 镜像里这一份视图够用了：条目名列表、它们的解析值、订阅。 */
interface DescribeFace {
  getSnapshot(): {
    view?: {
      namespaces: readonly { ns: string; value?: unknown }[]
    } | undefined
  }
  subscribe(listener: () => void): () => void
}

/** 共享表单服务的鸭子类型面（服务缺席时不该让整页报错）。 */
interface ConfigFormsFace {
  get<T>(entryId: string): ConfigForm<T>
  describe(): DescribeFace
}

/**
 * 读一个服务，读不到就当作没有。
 * @param ctx - 浏览器根上下文（只用到 `get`）。
 * @param name - 服务名。
 * @returns 服务实例或 undefined。
 */
function serviceOf(ctx: { get(name: string): unknown }, name: string): unknown {
  try {
    return ctx.get(name)
  } catch {
    // 上下文拒绝查询（服务不存在或已卸载）：按缺失处理。
    return undefined
  }
}

/**
 * 判断取到的对象是不是共享设置表单服务。
 * @param value - 任意服务值。
 * @returns 是否具备 get / describe 两个成员。
 */
function isConfigForms(value: unknown): value is ConfigFormsFace {
  if (typeof value !== 'object' || value === null) return false
  const face = value as { get?: unknown; describe?: unknown }
  return typeof face.get === 'function' && typeof face.describe === 'function'
}

/**
 * 判断一个条目的解析值是不是本插件的 Config 切片。
 * @param value - describe 交来的解析值。
 * @returns 是否带 `progressUpdates` 这个键。
 */
function isProgressSection(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return 'progressUpdates' in (value as Record<string, unknown>)
}

/**
 * 创建本插件设置卡片的表单。
 *
 * 共享表单服务缺席时返回 undefined：调用方据此把开关渲染成只读（禁用），
 * 而不是造一个点了存不住的假开关。
 * @param ctx - 浏览器根上下文。
 * @returns 表单通道，或 undefined（这个部署没有设置服务）。
 */
export function createProgressSettingsForm(ctx: { get(name: string): unknown }): ProgressSettingsForm | undefined {
  const forms = serviceOf(ctx, 'configForms')
  if (!isConfigForms(forms)) return undefined

  const listeners = new Set<() => void>()
  let boundId: string | undefined
  let bound: ConfigForm<ProgressUpdatesSettingsValues> | undefined
  let offBound: (() => void) | undefined
  let snapshot: ConfigFormSnapshot<ProgressUpdatesSettingsValues> = PENDING

  /** 重发一次：有绑定就发它的最新快照，没有就发 pending。 */
  const publish = (): void => {
    if (bound !== undefined) snapshot = bound.getSnapshot()
    for (const listener of Array.from(listeners)) listener()
  }

  /**
   * 镜像当前服务的条目。还没答上来（或拒绝读）时返回 undefined —— 没答上来不等于
   * 没有，不能当成「这个部署不服务本插件」。
   * @returns 条目列表或 undefined。
   */
  const servedEntries = (): readonly { ns: string; value?: unknown }[] | undefined => {
    try {
      return forms.describe().getSnapshot().view?.namespaces
    } catch {
      return undefined
    }
  }

  /**
   * 解析这次该绑定哪个条目 id。
   *
   * 先按解析值认领（值里带 `progressUpdates` 的那一条），认不出来再按候选表顺延。
   * @returns 条目 id。
   */
  const resolve = (): string => {
    const served = servedEntries()
    if (served === undefined || served.length === 0) return PROGRESS_SETTINGS_ENTRY_IDS[0]!
    const claimed = served.find((entry) => isProgressSection(entry.value))
    if (claimed !== undefined) return claimed.ns
    const byName = PROGRESS_SETTINGS_ENTRY_IDS.find((id) => served.some((entry) => entry.ns === id))
    return byName ?? served[0]!.ns
  }

  /** 绑定（或重绑）到解析出的条目；id 没变时是空操作。 */
  const bind = (): void => {
    const target = resolve()
    if (target === boundId) return
    offBound?.()
    offBound = undefined
    bound = undefined
    let form: ConfigForm<ProgressUpdatesSettingsValues>
    try {
      form = forms.get<ProgressUpdatesSettingsValues>(target)
    } catch {
      // 服务拒绝了这次寻址：保持未绑定，等镜像下一次给出答案再试，
      // 而不是把一个错 id 钉死在这个会话里。
      boundId = undefined
      return
    }
    boundId = target
    bound = form
    offBound = form.subscribe(() => { publish() })
    publish()
  }

  let offDescribe: (() => void) | undefined
  try {
    offDescribe = forms.describe().subscribe(() => { bind() })
  } catch {
    // 镜像没有订阅座位：初始绑定照旧成立。
  }
  bind()

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    // 没有绑定就回答「没接受」，绝不假装写成功。
    set: (field, value) => bound?.set(field, value) ?? Promise.resolve(false),
    dispose: () => {
      offDescribe?.()
      offDescribe = undefined
      offBound?.()
      offBound = undefined
      bound = undefined
      boundId = undefined
      listeners.clear()
    },
  }
}
