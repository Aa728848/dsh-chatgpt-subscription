/**
 * 进展更新的会话维度状态 —— 纯逻辑。
 *
 * 这里刻意不 import 任何 `node:` 内置模块，也不 import 任何 `@deepseek-ai` 运行时
 * 服务：同一份实现既要在宿主进程里维护推进节奏（轮次计数、催促次数），也可能被
 * 浏览器半边复用做渲染推导，任何一端专属的依赖都会让另一端无法装载。
 *
 * @module dsh-chatgpt-subscription/host/progress-updates/store
 */

/** 环形缓冲上限：最多保留的进展条数。 */
export const MAX_UPDATES = 50

/** 催促阈值：连续这么多轮带工具调用却没有进展更新时，注入一条提醒。 */
export const NUDGE_THRESHOLD = 8

/** 一条已展示的进展。 */
export interface ProgressUpdate {
  /** 稳定标识，同一会话内唯一（进程内自增 + 时间戳，无外部依赖）。 */
  id: string
  /** 单行标题，约 60 字以内，用户语言，纯文本，无 Markdown，无结尾句号。 */
  title?: string
  /** 详情正文，约 1000 字以内，轻 Markdown：一段正文 + 少量 bullet。 */
  message: string
  /** 产生时刻，Unix 毫秒时间戳。 */
  at: number
  /** 来源标签（计数会话 id），供浏览器侧分组显示。 */
  source?: string
}

/** 一个会话维度的进展更新状态。 */
export interface ProgressUpdateState {
  /** 进展环形缓冲，按产生顺序排列，最多 {@link MAX_UPDATES} 条。 */
  updates: ProgressUpdate[]
  /** 自上次进展更新以来连续带工具调用的轮次数。 */
  roundsSinceUpdate: number
  /** 本会话已经发出的催促次数。 */
  nudges: number
}

/**
 * 判断是否该催促。达到阈值即触发，注入之后调用方把计数清零。
 * @param rounds - 自上次进展更新以来的连续轮次数。
 * @returns 是否达到 {@link NUDGE_THRESHOLD}。
 */
export function shouldNudge(rounds: number): boolean {
  return rounds >= NUDGE_THRESHOLD
}

/**
 * 把进展列表截断到环形缓冲上限，保留最新的一批。
 * @param list - 任意长度的进展列表（不会被就地修改）。
 * @returns 截断后的新数组。
 */
export function capUpdates(list: readonly ProgressUpdate[]): ProgressUpdate[] {
  return list.length <= MAX_UPDATES ? [...list] : list.slice(list.length - MAX_UPDATES)
}

/** 进程内自增序号，只用于拼出稳定 id；不含任何运行时依赖。 */
let sequence = 0

/**
 * 生成一条进展的稳定 id。
 * @param at - 产生时刻（Unix 毫秒）。
 * @returns 形如 `pu-<时间戳>-<序号>` 的字符串。
 */
export function nextUpdateId(at: number): string {
  sequence += 1
  return `pu-${at}-${sequence}`
}

/** 会话维度状态容器：宿主持有它推进计数，路由只读它渲染。 */
export interface ProgressUpdateStore {
  /** 读取当前状态（快照语义，返回的是引用，调用方不要就地改）。 */
  state(): ProgressUpdateState
  /** 追加一条进展；超出 {@link MAX_UPDATES} 时丢弃最旧的。 */
  push(update: ProgressUpdate): ProgressUpdateState
  /** 记一轮「带工具调用」的轮次，返回新的轮次数。 */
  bumpRound(): number
  /** 记录一次进展更新：轮次计数归零。 */
  markUpdated(): ProgressUpdateState
  /** 记录一次催促：催促次数 +1，轮次计数归零。 */
  markNudged(): ProgressUpdateState
  /** 清空进展（会话结束时用）。 */
  reset(): ProgressUpdateState
}

/**
 * 创建一个空的进展更新 store。
 * @returns 新的会话维度 store。
 */
export function createProgressUpdateStore(): ProgressUpdateStore {
  let current: ProgressUpdateState = { updates: [], roundsSinceUpdate: 0, nudges: 0 }

  return {
    state: () => current,
    push: (update) => {
      current = { ...current, updates: capUpdates([...current.updates, update]) }
      return current
    },
    bumpRound: () => {
      current = { ...current, roundsSinceUpdate: current.roundsSinceUpdate + 1 }
      return current.roundsSinceUpdate
    },
    markUpdated: () => {
      current = { ...current, roundsSinceUpdate: 0 }
      return current
    },
    markNudged: () => {
      current = { ...current, roundsSinceUpdate: 0, nudges: current.nudges + 1 }
      return current
    },
    reset: () => {
      current = { updates: [], roundsSinceUpdate: 0, nudges: 0 }
      return current
    },
  }
}
