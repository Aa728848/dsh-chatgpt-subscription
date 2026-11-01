/**
 * 从**持久会话日志**里读出 Mandate 的地方。
 *
 * ## 为什么需要单独一层
 *
 * 头部散落在三类持久事实里，而它们各自的形状不同：
 *
 * - **子会话的首条 `user/message`**：内容是 `[...提示词块, "Your parent agent
 *   id is …" 指引块]`，头部在提示词块里（第一个块）；
 * - **收件方的 `agent/inbox/spliced`**：内容是 `["Agent <id> sent a message: ",
 *   ...原文]`，头部在**第二个**块里；
 * - **`tool/call` / `tool/ptc-dispatch*` 的 arguments**：一次派发尝试的原文。
 *
 * 所以解析器**必须扫描全部 text block**，取第一个以围栏开头的——固定取第 0
 * 块会在"第二个块"这条路径上读不到头部。
 *
 * ## 这里只读，不判定
 *
 * 本模块只回答"这份日志里有没有 Mandate、是哪一份"。**授权判定**（持有、
 * 血缘、版本、扩权）属于守卫与工具的后续实现；账本只负责折叠事实。
 *
 * @module dsh-chatgpt-subscription/host/dispatch-ledger/binding
 */

import {
  mandateNamespaceKey,
  parseMandateHeader,
  type MandateHeader,
  type MandateParseResult,
} from './header.ts'

/** 一条会话事件（结构化；真实类型是 `SessionEvent` 的可判空子集）。 */
export interface SessionEventLike {
  /** 事件类型判别值。 */
  readonly type?: unknown
  /** 事件在会话日志里的序号。 */
  readonly seq?: unknown
  /** 事件时刻（Unix 毫秒）。 */
  readonly time?: unknown
  /** 事件载荷。 */
  readonly data?: unknown
}

/** 本模块读到的最小会话视图。 */
export interface SessionLike {
  /** 会话 id。 */
  readonly id?: unknown
  /** 会话头：血缘与角色。 */
  readonly header?: {
    /** 直接父会话 id。 */
    readonly parentSession?: unknown
    /** 会话来源分类。 */
    readonly origin?: unknown
  }
  /** 事件日志（轻量夹具可直接给）。 */
  readonly events?: readonly SessionEventLike[]
  /** 真实 Session 的读取器。 */
  snapshotEvents?(): readonly SessionEventLike[]
}

/**
 * 判断一个值是不是普通记录对象。
 * @param value - 候选值。
 * @returns 是记录对象时 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 读一个值里的非空字符串。
 * @param value - 候选值。
 * @returns 字符串；其它类型为 undefined。
 */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 读一个会话的有序日志。
 * @param session - 会话。
 * @returns 事件数组；读不到时是空数组。
 */
export function eventsOf(session: SessionLike): readonly SessionEventLike[] {
  if (!isRecord(session)) return []
  if (Array.isArray(session.events)) return session.events
  const snapshot = (session as { snapshotEvents?: () => unknown }).snapshotEvents
  if (typeof snapshot !== 'function') return []
  try {
    const listed = snapshot.call(session)
    return Array.isArray(listed) ? listed as readonly SessionEventLike[] : []
  } catch {
    return []
  }
}

/**
 * 取出一个内容数组里的全部 text 块文本。
 *
 * 块形状是 `{ type: 'text', text: string }`；其它形状（图片、工具块）跳过。
 * @param content - 内容数组。
 * @returns 文本数组。
 */
export function textBlocksOf(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const texts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block['type'] !== 'text') continue
    const text = asString(block['text'])
    if (text !== undefined) texts.push(text)
  }
  return texts
}

/**
 * 从一组文本块里找出 Mandate 头部。
 *
 * 扫描**全部**块，返回第一个成功解析的头部；没有成功但有损坏的块时返回损坏
 * 结果；否则返回"没有头部"。
 * @param blocks - 内容块数组。
 * @returns 解析结果。
 */
export function mandateFromTextBlocks(blocks: readonly unknown[]): MandateParseResult {
  let invalid: MandateParseResult | undefined
  for (const block of blocks) {
    if (!isRecord(block)) continue
    if (block['type'] !== 'text') continue
    const text = asString(block['text'])
    if (text === undefined) continue
    const parsed = parseMandateHeader(text)
    if (parsed.state === 'ok') return parsed
    if (parsed.state === 'invalid' && invalid === undefined) invalid = parsed
  }
  return invalid ?? { state: 'none' }
}

/**
 * 从一段消息内容里找出 Mandate 头部。
 * @param content - 消息的 content 数组。
 * @returns 解析结果。
 */
export function mandateFromContent(content: unknown): MandateParseResult {
  return mandateFromTextBlocks(Array.isArray(content) ? content : [])
}

/**
 * 列出��个会话日志里持有的全部 Mandate。
 *
 * 覆盖两条持久路径：子会话自己收到的提示词（`user/message`）与被投递进来的
 * 消息（`agent/inbox/spliced`）。按命名空间去重。
 * @param session - 会话。
 * @returns 持有的头部列表。
 */
export function heldMandatesOfSession(session: SessionLike): MandateHeader[] {
  const found = new Map<string, MandateHeader>()
  const collect = (content: unknown): void => {
    const parsed = mandateFromContent(content)
    if (parsed.state !== 'ok' || parsed.header === undefined) return
    found.set(mandateNamespaceKey(parsed.header), parsed.header)
  }
  for (const event of eventsOf(session)) {
    const data = event.data
    if (!isRecord(data)) continue
    if (event.type === 'user/message') {
      collect(data['content'])
      continue
    }
    if (event.type === 'agent/inbox/spliced') {
      const inserted = data['inserted']
      if (!Array.isArray(inserted)) continue
      for (const message of inserted) {
        if (!isRecord(message)) continue
        collect(message['content'])
      }
    }
  }
  return [...found.values()]
}

/**
 * 读一个会话的直接父会话 id。
 * @param session - 会话。
 * @returns 父会话 id；没有时 undefined。
 */
export function parentSessionIdOfSession(session: SessionLike): string | undefined {
  if (!isRecord(session)) return undefined
  const header = (session as Record<string, unknown>)['header']
  if (!isRecord(header)) return undefined
  return asString(header['parentSession'])
}

/**
 * 读一个会话的 id。
 * @param session - 会话。
 * @returns 会话 id；没有时 undefined。
 */
export function sessionIdOf(session: SessionLike): string | undefined {
  if (!isRecord(session)) return undefined
  return asString((session as Record<string, unknown>)['id'])
}

/** 父会话目录里的一条子代理记录。 */
export interface CatalogChild {
  /** 子会话 id。 */
  readonly childId: string
  /** 展示标签。 */
  readonly label?: string
}

/**
 * 读一个会话记录下来的直接子代理。
 *
 * 只读 `subagent/catalog` 事件：这是**父会话自己**写的、唯一一处"我知道我
 * 派了哪些子代理"的持久事实。
 * @param session - 会话。
 * @returns 子代理列表。
 */
export function catalogChildrenOfSession(session: SessionLike): CatalogChild[] {
  const children: CatalogChild[] = []
  const seen = new Set<string>()
  for (const event of eventsOf(session)) {
    if (event.type !== 'subagent/catalog') continue
    const data = event.data
    if (!isRecord(data)) continue
    const childId = asString(data['childId'])
    if (childId === undefined || seen.has(childId)) continue
    seen.add(childId)
    const label = asString(data['label'])
    children.push({ childId, ...label === undefined ? {} : { label } })
  }
  return children
}
