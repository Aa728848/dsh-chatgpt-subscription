/**
 * 浏览器半边的**真实取数通道**：轮询宿主路由，把结果包成面板认的快照源。
 *
 * ## 为什么是 HTTP
 *
 * 宿主半边（`src/host/progress-updates/`）跑在 DSH 宿主进程里，浏览器半边跑在
 * 用户浏览器的另一个运行时里：两者之间没有共享对象、没有事件总线，只有同源
 * HTTP。所以这里的数据来源只有一条 —— `GET /api/dsh-progress-updates/updates`
 * （宿主那一侧的注册见 `src/host/progress-updates/routes.ts`，路径是冻结契约，
 * 搬家时不能顺手改名，否则面板读到的是 404）。**不读对话流**：进展是 agent 自己
 * 汇报的，不是从消息流里刮出来的。
 *
 * ## 生命周期（谁在什么时候轮询）
 *
 * 轮询不是常驻的。{@link createHostProgressSource} 返回的源在**第一个订阅者到来
 * 时**才开始轮询，**最后一个订阅者离开时**停表并清空定时器。面板只在页签打开、
 * 页签正文组件挂载时才订阅（`useSyncExternalStore`），所以页签关着就完全不发请求。
 *
 * 页面切到后台（`document.hidden`）时也停表，回到前台立刻补一次再继续 —— 和
 * `dsh-usage` 的设置页同一个节奏。判断不出可见性时退化成固定间隔轮询，见
 * {@link isDocumentVisible}。
 *
 * ## 失败策略
 *
 * 403 / 500 / 网络错误 / 超时 / JSON 坏掉 —— 一律**吞掉**，保留最后一份成功快照，
 * 不抛错、不白屏。面板因此永远显示"已知的最新状态"，而不是因为一次抖动整块消失。
 * 首次请求就失败时快照是空数组，面板渲染正常的空态。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/progress-updates/host-source
 */

import type { ProgressUpdate } from './contracts.ts'
import type { ProgressSnapshotSource } from './updates-panel.tsx'

/**
 * 本路由族的前缀（**文档相对**，不带前导斜杠）。
 *
 * 宿主那边注册的是绝对路径 `/api/dsh-progress-updates/updates`；浏览器这边必须写
 * 成不带前导斜杠的相对路径：GUI 以 `<base href="./">` 提供，子路径部署时相对路径
 * 才会解析到该部署的入口目录下，前导斜杠会逃逸出这个前缀、永远打不到路由
 * （同 dsh-usage / dsh-git-graph 的处理）。
 */
export const PROGRESS_UPDATES_PATH = 'api/dsh-progress-updates/updates'

/**
 * 宿主那一行今天装没装。
 *
 * 这个包的浏览器半边按**包**加载：即使「进展更新」那一行被关掉，本 bundle 照样
 * 会跑，面板与设置分区就会变成两个永远空的壳。所以挂载前问一次宿主的只读路由。
 *
 * **只在路由自己说不存在时判「没装」**：本路由的 403（非 loopback）与 200 都说明
 * 它在；而网关对一个不认识的路径回的那句 `not found`（纯文本或 HTML）也常常是
 * 404，把「任何 404」当成没装会让装着它的实例把 UI 自己撤掉——第一版就是这么写的，
 * 实测踩到了。
 *
 * 探测失败（网络错误、超时、无法判断）一律按「装着」处理：宁可多一格外壳，也不能
 * 因为一次抖动把装着的功能判成没装。
 * @returns 宿主半边是否在线。
 */
export async function isProgressUpdatesHostPresent(): Promise<boolean> {
  if (typeof fetch !== 'function') return true
  let response: Response
  try {
    response = await fetch(PROGRESS_UPDATES_PATH, {
      method: 'GET',
      headers: { accept: 'application/json' },
    })
  } catch {
    // 网络错误不等于没装：宁可留一格外壳，也不能把装着的功能判成没装。
    return true
  }
  if (response.status !== 404 && response.status !== 405) return true
  // 路由自己说不存在时回 JSON；网关的兜底是纯文本（实测 `not found`），不能当成
  // 「那一行没装」——第一版就是那样，把装着的实例的 UI 自己撤掉了。
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  if (!contentType.includes('json')) return true
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return true
  }
  if (body === null || typeof body !== 'object') return true
  const ok = (body as { ok?: unknown }).ok
  return typeof ok === 'boolean' ? ok : true
}

/** 轮询间隔（毫秒）。进展更新是人读的一行行文字，2 秒足够跟手，也不至于压宿主。 */
export const PROGRESS_POLL_MS = 2_000

/** 单次请求的硬上限；宿主卡住时不能把请求越堆越多。 */
export const PROGRESS_FETCH_TIMEOUT_MS = 8_000

/** 路由返回的响应体形状（与宿主的 `{ updates }` 对齐）。 */
export interface ProgressUpdatesResponse {
  /** 该会话的进展，按产生顺序排列。 */
  updates: ProgressUpdate[]
}

/** 定时器宿主的最小形状；抽出来是为了测试能塞假时钟。 */
export interface ProgressTimers {
  /** 起一个重复定时器，返回句柄。 */
  setInterval: (handler: () => void, ms: number) => unknown
  /** 清掉重复定时器。 */
  clearInterval: (handle: unknown) => void
  /** 起一个一次性定时器，返回句柄。 */
  setTimeout: (handler: () => void, ms: number) => unknown
  /** 清掉一次性定时器。 */
  clearTimeout: (handle: unknown) => void
}

/** 默认定时器：直接转发到 `globalThis`（浏览器与 Node 都能跑）。 */
const DEFAULT_TIMERS: ProgressTimers = {
  setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
  clearInterval: (handle) => { globalThis.clearInterval(handle as Parameters<typeof globalThis.clearInterval>[0]) },
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) => { globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]) },
}

/** 取数客户端的可注入依赖（测试用它塞假 fetch / 假时钟 / 假可见性）。 */
export interface ProgressFetchDeps {
  /**
   * fetch 实现；缺省时**每次请求**现取 `globalThis.fetch`。
   *
   * 现取而不是在工厂里抓一份闭包，是为了让测试可以在 apply 之后替换
   * `globalThis.fetch`，也为了让某些在 fetch 外面包一层鉴权的宿主环境生效。
   */
  fetch?: typeof globalThis.fetch
  /** 轮询间隔（毫秒），缺省 {@link PROGRESS_POLL_MS}。 */
  pollMs?: number
  /** 单次请求超时（毫秒），缺省 {@link PROGRESS_FETCH_TIMEOUT_MS}。 */
  timeoutMs?: number
  /** 是否可见（缺省读 `document.visibilityState`）；不可见时停表。 */
  isVisible?: () => boolean
  /** 定时器宿主，缺省 {@link DEFAULT_TIMERS}。 */
  timers?: ProgressTimers
  /** 解析响应体，缺省按 {@link ProgressUpdatesResponse} 取 `updates`。 */
  decode?: (body: unknown) => readonly ProgressUpdate[]
  /** 观测一次失败（错误已被吞掉，只为测试与诊断）。 */
  onError?: (error: unknown) => void
}

/** 面板数据源 + 一个显式停止入口（apply 卸载时调用）。 */
export interface HostProgressSource extends ProgressSnapshotSource {
  /**
   * 停止轮询并清空监听（幂等，且**是终态**）。
   *
   * 停止之后新的订阅者不会让它重新起表：卸载路径上可能还有一次迟到重订阅，
   * 那时重新起表就等于给一个已经卸载的插件留下常驻定时器。快照仍然可读。
   */
  stop(): void
}

/**
 * 判断页面当前是否可见。
 *
 * 只在明确拿到 `hidden` 时判为不可见：恒为 `prerender` 的嵌入式 WebView、或者
 * 压根没有 `document` 的运行环境都会落到"可见"这一侧 —— **退化行为是继续按固定
 * 间隔轮询**，而不是静默停摆（面板停摆比多轮询几次糟糕得多）。
 * @returns 是否应该继续轮询。
 */
export function isDocumentVisible(): boolean {
  try {
    if (typeof document === 'undefined') return true
    return document.visibilityState !== 'hidden'
  } catch {
    return true
  }
}

/**
 * 把路由响应体解成进展数组。
 *
 * 形状不对就当空列表，而**不是**当失败：宿主回了"当前为空"也要如实显示空态。
 * @param body - 解析后的 JSON。
 * @returns 进展数组。
 */
function decodeUpdates(body: unknown): readonly ProgressUpdate[] {
  if (typeof body !== 'object' || body === null) return []
  const updates = (body as { updates?: unknown }).updates
  if (!Array.isArray(updates)) return []
  return updates.filter((item): item is ProgressUpdate => {
    if (typeof item !== 'object' || item === null) return false
    const record = item as Partial<ProgressUpdate>
    return typeof record.id === 'string' && typeof record.message === 'string' && typeof record.at === 'number'
  })
}

/**
 * 拼出这次请求的地址。
 *
 * 拿得到会话 id 就带上 `?session=<id>`（宿主按会话分桶）；拿不到（槽位没有把
 * sessionId 传下来）就**退化到不带参数**的请求 —— 宿主对空 session 的语义是
 * "当前/合并桶"（`src/host/progress-updates/index.ts` 的 `updatesOf('')` 回退到
 * `session` 桶），因此单会话部署下仍能拿到进展。
 * @param sessionId - 当前会话 id，空串/undefined 表示退化。
 * @returns 文档相对的请求地址。
 */
export function progressUpdatesUrl(sessionId?: string): string {
  if (sessionId === undefined || sessionId === '') return PROGRESS_UPDATES_PATH
  return `${PROGRESS_UPDATES_PATH}?session=${encodeURIComponent(sessionId)}`
}

/**
 * 两份快照内容是否相同（逐条比 id / 标题 / 正文 / 时间戳 / 来源）。
 *
 * 相同就沿用旧引用：无意义的通知会让整棵面板重渲染，也会让
 * `useSyncExternalStore` 白白跑一轮比较。
 * @param left - 上一份快照。
 * @param right - 这次拿到的快照。
 * @returns 内容是否一致。
 */
function sameList(left: readonly ProgressUpdate[], right: readonly ProgressUpdate[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a.id !== b.id || a.message !== b.message || a.at !== b.at || a.title !== b.title || a.source !== b.source) return false
  }
  return true
}

/**
 * 起一个轮询数据源：真正发 `GET` 请求，把结果喂给面板。
 *
 * 语义要点：
 * - 惰性：没有订阅者时不发任何请求（页签关着 = 零流量）；
 * - 稳定引用：两次成功请求之间 `getSnapshot()` 返回**同一个数组对象**，
 *   `useSyncExternalStore` 不会判成无限更新；新快照内容不变时也沿用旧引用；
 * - 吞错：任何失败都只是"这次没更新"，最后一份快照原样保留。
 *
 * @param sessionId - 当前会话 id（可能为空：见 {@link progressUpdatesUrl} 的退化说明）。
 * @param deps - 可注入依赖（fetch、定时器、可见性、间隔）。
 * @returns 面板数据源 + 显式停止入口。
 */
export function createHostProgressSource(
  sessionId?: string,
  deps: ProgressFetchDeps = {},
): HostProgressSource {
  const pollMs = deps.pollMs ?? PROGRESS_POLL_MS
  const timeoutMs = deps.timeoutMs ?? PROGRESS_FETCH_TIMEOUT_MS
  const timers = deps.timers ?? DEFAULT_TIMERS
  const visible = deps.isVisible ?? isDocumentVisible
  const decode = deps.decode ?? decodeUpdates

  /** 最后一份**成功**快照；面板只认它。失败不会把它清空。 */
  let snapshot: readonly ProgressUpdate[] = []
  /** 订阅者集合；空集 = 没人看 = 不轮询。 */
  const listeners = new Set<() => void>()
  /** 当前轮询定时器句柄。 */
  let timer: unknown = undefined
  /** 有没有正在飞的请求：慢宿主上不叠加请求。 */
  let inFlight = false
  /** 每条请求的超时定时器，停止时统一清掉。 */
  const pendingTimeouts = new Set<unknown>()
  /** 是否已经被 {@link HostProgressSource.stop} 停掉（终态，不再起表）。 */
  let stopped = false

  const notify = (): void => {
    // 快照式遍历：订阅者在回调里退订/新订阅都不能打乱这一轮。
    for (const listener of Array.from(listeners)) {
      try {
        listener()
      } catch {
        // 订阅者自己的异常不能打断别的订阅者，也不能冒到轮询回调里。
      }
    }
  }

  /** 发一次读取请求。永不 reject —— 失败就是"这次没更新"。 */
  const refresh = async (): Promise<void> => {
    if (inFlight) return
    inFlight = true
    const controller = new AbortController()
    const timeoutTimer = timers.setTimeout(() => { controller.abort() }, timeoutMs)
    pendingTimeouts.add(timeoutTimer)
    try {
      const fetchImpl = deps.fetch ?? globalThis.fetch
      if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable')
      const response = await fetchImpl(progressUpdatesUrl(sessionId), {
        method: 'GET',
        headers: { accept: 'application/json' },
        // 进展列表随 agent 干活实时变化，缓存住就等于展示过期进展（路由也带了 no-store）。
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`progress updates: HTTP ${response.status}`)
      const body: unknown = await response.json()
      const next = decode(body)
      if (sameList(snapshot, next)) return
      snapshot = Object.freeze([...next])
      notify()
    } catch (error) {
      // 403 / 500 / 网络错误 / 超时 / JSON 坏掉：都只是"这次没更新"。
      deps.onError?.(error)
    } finally {
      timers.clearTimeout(timeoutTimer)
      pendingTimeouts.delete(timeoutTimer)
      inFlight = false
    }
  }

  const stopTimer = (): void => {
    if (timer === undefined) return
    timers.clearInterval(timer)
    timer = undefined
  }

  const startTimer = (): void => {
    if (timer !== undefined) return
    timer = timers.setInterval(() => {
      if (!visible()) {
        stopTimer()
        return
      }
      void refresh()
    }, pollMs)
  }

  /** 可见性变化：切回来立刻补一次再继续轮询，切走立刻停表。 */
  const onVisibilityChange = (): void => {
    if (listeners.size === 0) return
    if (visible()) {
      void refresh()
      startTimer()
    } else {
      stopTimer()
    }
  }

  const attachVisibility = (): void => {
    try {
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', onVisibilityChange)
      }
    } catch {
      // 没有 document 事件面就算了：固定间隔轮询仍然在跑。
    }
  }

  const detachVisibility = (): void => {
    try {
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
    } catch {
      // 同上。
    }
  }

  const subscribe = (listener: () => void): (() => void) => {
    // 已经卸载：只登记监听（快照仍可读），不再发请求也不再起表。
    if (stopped) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }
    const isFirst = listeners.size === 0
    listeners.add(listener)
    if (isFirst) {
      // 页签打开：先取一次，再起表。
      void refresh()
      if (visible()) startTimer()
      attachVisibility()
    }
    return () => {
      listeners.delete(listener)
      if (listeners.size > 0) return
      // 页签关闭：停表、摘掉可见性监听，零常驻流量。
      stopTimer()
      detachVisibility()
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe,
    stop: () => {
      stopped = true
      stopTimer()
      detachVisibility()
      listeners.clear()
      inFlight = false
      for (const pending of pendingTimeouts) timers.clearTimeout(pending)
      pendingTimeouts.clear()
    },
  }
}
