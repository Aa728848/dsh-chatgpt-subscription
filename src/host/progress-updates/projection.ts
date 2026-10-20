/**
 * 「进展更新」的会话投影：把日志里的 progress_update 调用折叠成一条条进展。
 *
 * ## 为什么要有它
 *
 * 进展更新原来只活在进程内的一个 Map 里（`store.ts` 的环形缓冲）：重开对话、
 * 刷新页面、宿主重启之后那份状态就没了，用户看到的是「进展面板空了」。而数据其实
 * 一直没丢 —— `progress_update` 的每次调用本身就是一条 `tool/call` 会话事件，
 * 早已被 DSH 持久化。所以这里把**日志**当成唯一真源：事件提交时折叠一次，读的
 * 时候就是一份可以直接回放的历史。
 *
 * ## 为什么不 import 投影包
 *
 * `@deepseek-ai/dsh-session-projection` **不在** peerDependencies 里：本插件要
 * 同时支持 0.1.2-alpha.5 ~ 0.2.1-rc.2，那一串宿主里有的根本没有这个包，运行时
 * import 会让整个插件在那代宿主上装载失败。所以这里按**结构化类型**自己声明
 * 契约（与 `nudge.ts` 的 `NudgeSessionLookup` / `TurnBoundaryLookup` 同一套
 * 做法），运行时只经 `ctx.get('sessionProjections')` 拿服务。
 *
 * ## 折叠是日志重放路径，任何情况都不许抛错
 *
 * `apply` 在每条提交事件上跑一次。这里抛出一次，毁掉的不只是本单元：重放链路
 * 会当场断掉，会话可能连读都读不出来。所以对事件形状一律**不信任** —— 不是
 * tool/call、不是 progress_update、arguments 不是合法 JSON、message 不是字符串、
 * seq/time 不是数字 —— 全部原样返回**同一个 state 引用**（`Object.is` 相等，
 * 下游零工作）。
 *
 * ## id 为什么用 seq，还要带上会话 id
 *
 * 客户端（`src/client/progress-updates/host-source.ts` 的 `sameList`）按 id 比较
 * 两份快照，面板列表也拿 id 当 React key。时间戳会随重放时的时钟漂移，seq 不会：
 * 同一段日志重放两次必须得到**逐字相同**的 id。会话 id 后缀解决的是另一半问题 ——
 * 读值要合并整棵委派树（见 `index.ts` 的 `projectionUpdatesOf`），而 seq 在
 * 每个会话里都从 0 开始，只带 seq 的话根会话与子会话的第一条进展会撞 id。
 *
 * @module dsh-chatgpt-subscription/host/progress-updates/projection
 */

import { z } from 'zod'
import { MAX_UPDATES, capUpdates, type ProgressUpdate } from './store.ts'
import { NOTIFY_USER_TOOL } from './tool.ts'

/** 投影键：宿主读状态、客户端取 wire 值都用这个名字。 */
export const PROGRESS_UPDATES_PROJECTION_KEY = 'progressUpdates'

/**
 * 折叠状态的持久化版本。
 *
 * 投影缓存按 `(sessionId, key, ver, seq, val)` 落盘。字段结构或折叠语义一变就
 * +1：版本对不上的旧行会被丢弃重折，而不是被续折成一份混着两套语义的垃圾。
 */
export const PROGRESS_UPDATES_STATE_VERSION = 1

/**
 * 折叠出来的状态。
 *
 * 只有一条环形缓冲 —— `roundsSinceUpdate` / `nudges` 是催促节奏的进程内状态，
 * 不进日志，也不该被缓存下来。
 *
 * `source` 记的是这一份折叠属于哪个会话（投影契约的 `init(header)` 拿得到，
 * `apply` 拿不到）。它喂给每条进展的 `source` 字段，同时是 id 的后缀：合并整棵
 * 委派树时靠它区分不同会话里从 0 开始的 seq。
 */
export interface ProgressUpdatesProjectionState {
  /** 进展环形缓冲，按产生顺序排列，最多 {@link MAX_UPDATES} 条。 */
  updates: ProgressUpdate[]
  /** 这一份折叠所属的会话 id（来自会话头）；拿不到会话头时缺省。 */
  source?: string
}

/** `apply` 会读到的会话事件字段（结构化；真实类型是 `SessionEvent` 的可判空子集）。 */
export interface ProjectionEventLike {
  /** 事件类型判别值；只认 `'tool/call'`。 */
  readonly type?: unknown
  /** 事件在会话日志里的序号（单调、重放稳定）；进展 id 用它。 */
  readonly seq?: unknown
  /** 事件时刻，Unix 毫秒；进展的 `at` 用它。 */
  readonly time?: unknown
  /** 事件载荷；`tool/call` 下是 `{ turn, step, callId, name, arguments }`。 */
  readonly data?: unknown
}

/** `init` 会读到的会话头字段。 */
export interface ProjectionHeaderLike {
  /** 会话 id。 */
  readonly id?: unknown
}

/**
 * 一个投影单元的定义（结构上满足 `@deepseek-ai/dsh-session-projection` 的
 * `ProjectionDefinition`，刻意不做运行时 import）。
 */
export interface ProgressUpdatesProjectionDefinition {
  /**
   * 投影键。
   *
   * 写成**字面量类型**而不是 `string`：投影契约的 `register()` 要求键是合并过的
   * 投影键联合的成员，宽化成 `string` 会让这份定义在同一条调用上不可赋值。这里
   * 不收窄的话，将来谁把结构化声明换回官方类型时会撞上一个与运行期无关的编译错。
   */
  readonly key: 'progressUpdates'
  /** 折叠状态的持久化版本。 */
  readonly stateVersion: number
  /**
   * 校验持久化状态，避免旧缓存被续折成垃圾。
   *
   * 类型直接写 zod 的 `ZodType`，**不要**自己声明一个"只要有 parse"的结构类型：
   * 投影契约要的就是它本人，声明宽了在真正调用 `register()` 时不可赋值（实测：
   * 宽声明能骗过这里的类型检查，却会在换成官方类型的那一刻炸出来）。zod 本来就是
   * 本插件的运行时依赖，这样写既没有额外负担，也顺带把折叠状态钉在编译期。
   */
  readonly stateSchema: z.ZodType<ProgressUpdatesProjectionState>
  /**
   * 空日志的初始状态。
   * @param header - 被投影会话的不可变元数据。
   * @param inheritedEventCount - fork 继承的前缀长度；本单元用不到（继承来的事件
   *   同样是日志的一部分，照常折叠）。
   * @returns 初始状态。
   */
  init(header: ProjectionHeaderLike, inheritedEventCount: unknown): ProgressUpdatesProjectionState
  /**
   * 纯转换：上一条状态 + 一条已提交事件 → 下一条状态。
   * @param state - 覆盖了此前全部事件的状态。
   * @param event - 下一条已提交的会话事件。
   * @returns 新状态；事件与本单元无关时返回**同一个引用**。
   */
  apply(state: ProgressUpdatesProjectionState, event: ProjectionEventLike): ProgressUpdatesProjectionState
  /** 客户端视图：交给浏览器半边的就是现有的 `ProgressUpdate[]` 形状。 */
  readonly wire: {
    /** 出去的 wire 值先过一遍 schema。 */
    readonly viewSchema: z.ZodType<readonly ProgressUpdate[]>
    /**
     * 状态 → wire 值。
     *
     * 返回的必须是**稳定引用**：投影驱动按 `Object.is` 比较两次结果，只有引用变了
     * 才会发布。`state.updates` 正好只有「真的多了一条进展」时才换引用。
     * @param state - 当前状态。
     * @returns 该单元的整个当前值。
     */
    view(state: ProgressUpdatesProjectionState): readonly ProgressUpdate[]
  }
}

/**
 * 会话投影服务里本模块会读的那部分（结构化类型）。
 *
 * 三个成员都按可选声明：`register` 之外的读值入口在不同 harness 代次里叫法不同，
 * 缺哪个就少一条读取路径，而不是让整个插件挂不上。
 */
export interface SessionProjectionServiceLike {
  /**
   * 登记一个投影单元。
   * @param definition - 键、schema、纯函数与版本号。
   * @returns 注销该单元的函数。
   */
  register?(definition: ProgressUpdatesProjectionDefinition): () => void
  /**
   * 读一个单元在某个会话上的**宿主状态**。
   * @param session - 会话对象。
   * @param key - 投影键。
   * @returns 状态；键没有登记时 undefined。
   */
  stateOf?(session: unknown, key: string): unknown
  /**
   * 读一份客户端可见的一致切面。
   * @param session - 会话对象。
   * @param keys - 想读的 wire 键。
   * @returns 带 `values` 的切面。
   */
  snapshot?(session: unknown, keys?: readonly string[]): { values?: Readonly<Record<string, unknown>> } | undefined
}

/** 单条进展的 schema：与 `ProgressUpdate` 逐字同形。 */
const UPDATE_SCHEMA = z.object({
  id: z.string(),
  title: z.string().optional(),
  message: z.string(),
  at: z.number(),
  source: z.string().optional(),
})

/** 折叠状态的 schema（宿主状态）。 */
export const progressUpdatesStateSchema = z.object({
  updates: z.array(UPDATE_SCHEMA),
  source: z.string().optional(),
})

/** wire 值的 schema（客户端看到的数组）。 */
export const progressUpdatesViewSchema = z.array(UPDATE_SCHEMA)

/**
 * 造一条进展的稳定 id。
 * @param seq - 事件在会话日志里的序号（重放稳定）。
 * @param source - 所属会话 id；拿不到时省略后缀。
 * @returns 形如 `pu-<seq>-<sessionId>` 的字符串。
 */
function updateIdOf(seq: number, source: string | undefined): string {
  return source === undefined ? 'pu-' + seq : 'pu-' + seq + '-' + source
}

/**
 * 读一个未知值为非空字符串。
 * @param value - 候选值。
 * @returns 非空字符串，其它类型的 undefined。
 */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 把 `tool/call` 里的 `arguments` 原文解析成进展内容。
 *
 * **任何一点不对就返回 undefined**（而不是抛错，也不是造一条半截进展）：这是重放
 * 路径，一条形状坏掉的历史事件只该被跳过。
 * @param raw - 工具入参 JSON 原文。
 * @returns 正文与（去空白后的）可选标题。
 */
function parseArguments(raw: unknown): { message: string, title?: string } | undefined {
  if (typeof raw !== 'string') return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as { title?: unknown, message?: unknown }
  if (typeof record.message !== 'string') return undefined
  // 标题留白等于没给标题：写进一步进展卡片只该有一行正文，而不是一个空白标题行。
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  return title === '' ? { message: record.message } : { message: record.message, title }
}

/**
 * 造一个进展折叠单元。
 *
 * 每次登记都要一份**新的**定义对象：它是纯函数集合，没有跨会话的状态，但把
 * `init` 闭包里的会话头漏进来就会把不同会话串成一份。
 * @returns 可交给 `sessionProjections.register` 的定义。
 */
export function progressUpdatesProjection(): ProgressUpdatesProjectionDefinition {
  return {
    key: PROGRESS_UPDATES_PROJECTION_KEY as 'progressUpdates',
    stateVersion: PROGRESS_UPDATES_STATE_VERSION,
    stateSchema: progressUpdatesStateSchema,

    init(header) {
      // 会话头里的 id 是这条折叠唯一能拿到的身份来源：apply 只看得到事件。
      const source = stringOf(header?.id)
      return source === undefined ? { updates: [] } : { updates: [], source }
    },

    apply(state, event) {
      if (event?.type !== 'tool/call') return state

      const data = event.data as { name?: unknown, arguments?: unknown } | null | undefined
      if (typeof data !== 'object' || data === null) return state
      if (data.name !== NOTIFY_USER_TOOL) return state

      const body = parseArguments(data.arguments)
      if (body === undefined) return state

      // seq 与 time 缺一不可：没有 seq 就没有稳定 id，没有 time 就排不出整棵树。
      const seq = event.seq
      if (typeof seq !== 'number' || !Number.isFinite(seq)) return state
      const at = event.time
      if (typeof at !== 'number' || !Number.isFinite(at)) return state

      const update: ProgressUpdate = {
        id: updateIdOf(seq, state.source),
        message: body.message,
        at,
        ...(body.title === undefined ? {} : { title: body.title }),
        ...(state.source === undefined ? {} : { source: state.source }),
      }
      return { ...state, updates: capUpdates([...state.updates, update]) }
    },

    wire: {
      viewSchema: progressUpdatesViewSchema,
      view: state => state.updates,
    },
  }
}

/**
 * 读一个会话上折叠出来的进展。
 *
 * 两条读取路径，都按**不可用就当没读到**处理（返回 undefined，调用方回退到内存
 * 实现）：先问 `stateOf`（宿主状态，最直接），没有再问 `snapshot`（wire 切面，
 * 老一点的投影服务上只有它）。读出来的值一律过 schema，形状不对就当投影不可用 ——
 * 宁可用进程内那份，也不要把一份坏数据渲染成历史。
 * @param projections - 会话投影服务。
 * @param session - 会话对象。
 * @returns 该会话的进展；投影不可用时 undefined。
 */
export function readProjectedUpdates(
  projections: SessionProjectionServiceLike,
  session: unknown,
): ProgressUpdate[] | undefined {
  const stateOf = projections.stateOf
  if (typeof stateOf === 'function') {
    let state: unknown
    try {
      state = stateOf.call(projections, session, PROGRESS_UPDATES_PROJECTION_KEY)
    } catch {
      // 会话没 attach、服务正在拆除：按不可用处理。
      return undefined
    }
    if (state === undefined) return undefined
    const parsed = progressUpdatesStateSchema.safeParse(state)
    return parsed.success ? parsed.data.updates : undefined
  }

  const snapshot = projections.snapshot
  if (typeof snapshot !== 'function') return undefined
  let values: Readonly<Record<string, unknown>> | undefined
  try {
    values = snapshot.call(projections, session, [PROGRESS_UPDATES_PROJECTION_KEY])?.values
  } catch {
    return undefined
  }
  if (values === undefined) return undefined
  const parsed = progressUpdatesViewSchema.safeParse(values[PROGRESS_UPDATES_PROJECTION_KEY])
  return parsed.success ? parsed.data : undefined
}

/**
 * 把多个会话的进展合并成一份。
 *
 * 按 `at` 升序排（同一毫秒时按输入顺序，JS 的排序是稳定的：传入方把"被查询的
 * 会话自己"放在最前面），再按 {@link MAX_UPDATES} 截断保留最新的。整棵委派树共用
 * 一份进展是今天的语义，所以合并后的上限与单会话一致，不随子会话数量膨胀。
 * @param lists - 各会话各自的进展（每条已各自截断过）。
 * @returns 合并后的进展，最多 {@link MAX_UPDATES} 条。
 */
export function mergeProjectedUpdates(lists: readonly (readonly ProgressUpdate[])[]): ProgressUpdate[] {
  const merged = ([] as ProgressUpdate[]).concat(...lists.map(list => [...list]))
  merged.sort((left, right) => left.at - right.at)
  return capUpdates(merged)
}
