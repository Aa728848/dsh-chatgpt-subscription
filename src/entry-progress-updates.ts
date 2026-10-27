/**
 * 「进展更新」的宿主入口 —— 本包的**第二个组件**（loader 行）。
 *
 * 这个包原先只有一行：`src/index.ts` 一个 `apply` 同时挂着十二条订阅线路、共享
 * 内核和若干与线路无关的子系统，管理页因此只显示「包含的组件 共1个」。进展更新
 * 是其中最独立的一块：它是一个**不结束回合**的 `progress_update` 工具、一段系统
 * 提示词引导、一个只读取数的 HTTP 路由，跟任何线路、任何号池都没有关系。把它单独
 * 成一行，用户可以在插件管理页里只关它，而宿主这边真的什么都不挂。
 *
 * ## 设置字段留在核心行
 *
 * 三个 `volatile` 字段仍声明在核心入口（`src/index.ts` 的 `Config`），由核心通过
 * 本模块导出的 {@link attachProgressSettings} 递交进来。理由不是偷懒：profile 的
 * patch 层是按 id 定位、**替换整行 config** 的，而用户的 profile 早就在核心行的
 * config 里写了 `progressUpdates: true`——字段若搬来这一行，那条 patch 就会把这行
 * 的配置整体换成空对象，schema 默认值填回 false，于是「设置里显示打开、实际是关的」
 * 同时成立。设置卡片也仍然按「哪个条目有 `progressUpdates` 这个键」定位写入目标，
 * 所以字段留在核心行，卡片与实现才对得上。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/progress-updates
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  installProgressUpdates,
  type ProgressUpdatesContext,
  type ProgressUpdatesSettings,
} from './host/progress-updates/index.ts'

/** Loader 行名；patch 里的行 id 另由 bundle 决定。 */
export const name = 'dsh-chatgpt-subscription-progress-updates'

/**
 * 这一行不为任何服务等待。
 *
 * `installProgressUpdates` 逐个用 `ctx.get()` 探可选服务（tools、systemPrompt、
 * sessions、sessionProjections、webServer），缺哪个就退化成更弱的实现；把它们的
 * 名字写进 `inject` 反而会让没装 agent-loop 的宿主整行挂不上——那是这一行原本的
 * 独立性所要避免的事。
 */
export const inject: string[] = []

/**
 * 设置是怎么到这一行的。
 *
 * 字段声明在核心入口（见文件头的理由）。行顺序不归这一行管，所以两种顺序都要成立：
 * 核心先挂上就直接递交；这一行先挂上就把读取器寄存下来，核心一调用就取走。
 */
let attachedSettings: (() => ProgressUpdatesSettings) | undefined
let waitingForSettings: ((read: () => ProgressUpdatesSettings) => void) | undefined

/**
 * 由核心入口在挂载时调用，把它的 `volatile` 设置读面交给这一行。
 *
 * 幂等：重复递交以最后一次为准（核心重挂时设置引用会换一份新的）。
 * @param read - 每次调用都重读活引用，返回当前的开关、阈值与语言。
 */
export function attachProgressSettings(read: () => ProgressUpdatesSettings): void {
  attachedSettings = read
  const waiting = waitingForSettings
  waitingForSettings = undefined
  waiting?.(read)
}

/**
 * 还没有设置就不挂。
 *
 * 用一个写死的默认值假装在跑，会让「设置显示打开」与「实际没挂」同时成立——那正是
 * 这一行第一版的样子。等核心把它交过来，再挂。
 * @returns 一个读完引用就返回当前设置的函数。
 */
async function readSettings(): Promise<() => ProgressUpdatesSettings> {
  if (attachedSettings !== undefined) return attachedSettings
  return await new Promise<() => ProgressUpdatesSettings>((resolve) => {
    waitingForSettings = resolve
  })
}

export async function apply(ctx: Context): Promise<void> {
  // 交进去的是**读取函数**而不是一份值：核心那边每次调用都重读 volatile 活引用，
  // 设置面板一保存就生效，不需要重挂任何一行。
  const read = await readSettings()
  ctx.effect(
    () => installProgressUpdates(ctx as unknown as ProgressUpdatesContext, { settings: read }),
    'dsh-progress-updates: host half',
  )
}
