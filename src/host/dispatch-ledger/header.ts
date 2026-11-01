/**
 * Mandate v2 的**头部文法与 schema**。
 *
 * ## 头部长什么样
 *
 * 头部是**一段围栏块**，必须从文本的**第 0 个字符**开始（允许前导空白），
 * 后面紧跟 JSON 与结束围栏：
 *
 * ```
 * ```dsh-mandate-v2
 * {"v":2,"kind":"dispatch","brief_id":"b-7f","run_id":"r-1","idem":"i-1", ...}
 * ```
 *
 * 三种状态，缺一不可：
 *
 * - `none`：文本不以围栏开头 → **没有头部**（旧消息）。调用方按"降级审计"
 *   处理，不做拦截。
 * - `invalid`：围栏在，但 JSON 非法、字段越界、版本不认识、kind 与字段组合
 *   不合法 → **头部损坏**。
 * - `ok`：解析出符合 v2 schema 的头部。
 *
 * ## 为什么头部里没有 session id
 *
 * 模型**天然不知道自己的 session id**，而"owner 必须等于我的 session id"
 * 这种要求模型根本无法满足。身份全部由宿主从持久事实推导：签发方是发起
 * 派发的那次调用的会话，持有方是自身日志里含有这份 Mandate 的子会话，
 * 报告接收方是持有方的 `header.parentSession`。
 *
 * ## 为什么正文不进头部
 *
 * 头部会被抄进子会话日志与父会话的 inbox 日志，正文再抄一遍就是双份存储。
 * 正文由**插件自己算出的 sha256** 锚定（围栏之后的全部文本），账本只存哈希。
 *
 * 模型**不能**在头部里提供正文哈希：提供了就是伪造，schema 会因为未知字段
 * 直接判它损坏。哈希只由插件算，模型无从干预。
 *
 * @module dsh-chatgpt-subscription/host/dispatch-ledger/header
 */

import { z } from 'zod'

/** 围栏协议 id：头部围栏的固定标识。 */
export const MANDATE_PROTOCOL_ID = 'dsh-mandate-v2'

/** 头部格式版本（`v`）。 */
export const MANDATE_HEADER_VERSION = 2

/** 受支持的授权快照版本（`mandate_version`）。 */
export const MANDATE_SUPPORTED_MANDATE_VERSION = 1

/** 围栏内 JSON 的最大 UTF-8 字节数。 */
export const MANDATE_HEADER_MAX_BYTES = 4096

/** id 字段允许的字符集。 */
export const MANDATE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/

/** 头部的开场围栏。 */
export const MANDATE_FENCE_OPEN = '```' + MANDATE_PROTOCOL_ID

/** 头部的收尾围栏。 */
export const MANDATE_FENCE_CLOSE = '```'

/** 消息角色。 */
export type MandateKind = 'dispatch' | 'report' | 'steer'

/** 报告状态。 */
export type MandateReportStatus = 'ready' | 'hand_back' | 'blocked' | 'failed' | 'dropped'

/** 策略引用。 */
export interface MandatePolicyRef {
  /** 策略 id。 */
  readonly id: string
  /** 策略版本。 */
  readonly version: string
  /** 策略摘要（前缀）。 */
  readonly sha256: string
}

/** 一次运行的引用（血缘用）。 */
export interface MandateRunRef {
  /** 工作项 id。 */
  readonly brief_id: string
  /** 运行 id。 */
  readonly run_id: string
  /** 幂等键。 */
  readonly idem: string
}

/** 上下文扩权声明。 */
export interface MandateGrant {
  /** 允许的后续上下文引用。 */
  readonly context: readonly string[]
}

/** 一份解析通过的 Mandate v2 头部。 */
export interface MandateHeader {
  /** 头部格式版本。 */
  readonly v: 2
  /** 消息角色。 */
  readonly kind: MandateKind
  /** 工作项 id（跨运行稳定）。 */
  readonly brief_id: string
  /** 运行 id（一次派发尝试）。 */
  readonly run_id: string
  /** 运行内的幂等键。 */
  readonly idem: string
  /** 授权快照版本。 */
  readonly mandate_version: number
  /** 提示词修订号。 */
  readonly prompt_ref: string
  /** 策略引用。 */
  readonly policy: MandatePolicyRef
  /** 原始任务的**引用**（不是正文）。 */
  readonly task?: readonly string[]
  /** 结构化边界。 */
  readonly boundary?: readonly string[]
  /** 允许的后续上下文。 */
  readonly followup?: readonly string[]
  /** 血缘：本次运行接替的那一次运行。 */
  readonly parent_mandate?: MandateRunRef | null
  /** 上下文扩权声明（只有 steer 带）。 */
  readonly grant?: MandateGrant | null
  /** 报告状态（只有 report 带）。 */
  readonly status?: MandateReportStatus
}

/** 解析状态。 */
export type MandateParseState = 'none' | 'invalid' | 'ok'

/** 一次头部解析的结果。 */
export interface MandateParseResult {
  /** 解析状态。 */
  readonly state: MandateParseState
  /** 解析通过时的头部。 */
  readonly header?: MandateHeader
  /** 失败原因（`invalid` 时有）。 */
  readonly reason?: string
  /** 围栏之后的正文（`ok` 时有）。 */
  readonly body?: string
}

const ID_SCHEMA = z.string().min(1).max(64).regex(MANDATE_ID_PATTERN)
const TASK_REFERENCE_SCHEMA = z.string().min(1).max(160)
const BOUNDARY_SCHEMA = z.string().min(1).max(120)
const CONTEXT_SCHEMA = z.string().min(1).max(120)

const POLICY_SCHEMA = z.strictObject({
  id: z.string().min(1).max(64),
  version: z.string().min(1).max(32),
  sha256: z.string().regex(/^[0-9a-f]{12,64}$/),
})

const RUN_REF_SCHEMA = z.strictObject({
  brief_id: ID_SCHEMA,
  run_id: ID_SCHEMA,
  idem: ID_SCHEMA,
})

const GRANT_SCHEMA = z.strictObject({
  context: z.array(CONTEXT_SCHEMA).max(8),
})

const HEADER_SCHEMA = z.strictObject({
  v: z.literal(MANDATE_HEADER_VERSION),
  kind: z.enum(['dispatch', 'report', 'steer']),
  brief_id: ID_SCHEMA,
  run_id: ID_SCHEMA,
  idem: ID_SCHEMA,
  mandate_version: z.literal(MANDATE_SUPPORTED_MANDATE_VERSION),
  prompt_ref: ID_SCHEMA,
  policy: POLICY_SCHEMA,
  task: z.array(TASK_REFERENCE_SCHEMA).max(4).optional(),
  boundary: z.array(BOUNDARY_SCHEMA).max(16).optional(),
  followup: z.array(CONTEXT_SCHEMA).max(8).optional(),
  parent_mandate: RUN_REF_SCHEMA.nullable().optional(),
  grant: GRANT_SCHEMA.nullable().optional(),
  status: z.enum(['ready', 'hand_back', 'blocked', 'failed', 'dropped']).optional(),
})

/**
 * 每种角色**允许携带**的字段集。
 *
 * 同一个字段集只写一次：它既出现在 kind 违规的拒绝文案尾部（模型被拒时当场
 * 唯一的纠错入口），也出现在守卫的两条 `MANDATE_KIND` 拒绝里。文案与 schema
 * 各写一套，迟早会重演"样板自己非法"那类事故。
 */
export const MANDATE_KIND_FIELDS: Readonly<Record<MandateKind, string>> = {
  dispatch: 'v, kind, brief_id, run_id, idem, mandate_version, prompt_ref, policy, task, boundary, followup, parent_mandate',
  report: 'v, kind, brief_id, run_id, idem, mandate_version, prompt_ref, policy, status',
  steer: 'v, kind, brief_id, run_id, idem, mandate_version, prompt_ref, policy, grant',
}

/**
 * 拼出"这个方向到底该带什么"的纠错尾巴。
 *
 * 拒绝文案只说"不许带 X"时，模型只能逐个字段试错——它反复写不对的原因正在这里。
 * 把该方向的字段集直接贴在违规说明后面，一次往返就能改对。
 * @param kind - 声明了角色、却用错了字段的那种角色。
 * @returns 追加在违规说明之后的纠错尾巴。
 */
function kindRepairHint(kind: MandateKind): string {
  return ' (a ' + kind + ' header carries exactly: ' + MANDATE_KIND_FIELDS[kind]
    + '; copy the ready-to-send block from dispatch_ledger {action:"self"})'
}

/**
 * 校验 kind 与字段的组合。
 *
 * 字段是"按角色出现"的：dispatch 带 task/boundary/followup/parent_mandate，
 * report 带 status，steer 带 grant。组合不合法 = 头部损坏，而不是"忽略
 * 多余字段"——多带字段往往意味着模型抄错了角色。
 *
 * `null` 与"没写"同义：schema 把 parent_mandate / grant 声明成 nullable，模型
 * 也习惯把用不到的字段写成 null。把 null 当成"携带了这个字段"，等于拒绝一个
 * 语义上完全正确、只是写法啰嗦的头部。
 * @param header - 已通过 schema 的头部。
 * @returns 违规说明；合法时 undefined。
 */
function kindViolation(header: MandateHeader): string | undefined {
  const carriedParent = header.parent_mandate !== undefined && header.parent_mandate !== null
  const carriedGrant = header.grant !== undefined && header.grant !== null
  if (header.kind === 'dispatch') {
    if (header.task === undefined) return 'a dispatch header must carry task' + kindRepairHint('dispatch')
    if (header.boundary === undefined) return 'a dispatch header must carry boundary' + kindRepairHint('dispatch')
    if (header.followup === undefined) return 'a dispatch header must carry followup' + kindRepairHint('dispatch')
    if (header.parent_mandate === undefined) return 'a dispatch header must carry parent_mandate' + kindRepairHint('dispatch')
    if (carriedGrant) return 'a dispatch header must not carry grant' + kindRepairHint('dispatch')
    if (header.status !== undefined) return 'a dispatch header must not carry status' + kindRepairHint('dispatch')
    return undefined
  }
  if (header.kind === 'report') {
    if (header.status === undefined) return 'a report header must carry status' + kindRepairHint('report')
    if (header.task !== undefined) return 'a report header must not carry task' + kindRepairHint('report')
    if (header.boundary !== undefined) return 'a report header must not carry boundary' + kindRepairHint('report')
    if (header.followup !== undefined) return 'a report header must not carry followup' + kindRepairHint('report')
    if (carriedParent) return 'a report header must not carry parent_mandate' + kindRepairHint('report')
    if (carriedGrant) return 'a report header must not carry grant' + kindRepairHint('report')
    return undefined
  }
  if (header.grant === undefined) return 'a steer header must carry grant' + kindRepairHint('steer')
  if (header.status !== undefined) return 'a steer header must not carry status' + kindRepairHint('steer')
  if (header.task !== undefined) return 'a steer header must not carry task' + kindRepairHint('steer')
  if (header.boundary !== undefined) return 'a steer header must not carry boundary' + kindRepairHint('steer')
  if (header.followup !== undefined) return 'a steer header must not carry followup' + kindRepairHint('steer')
  if (carriedParent) return 'a steer header must not carry parent_mandate' + kindRepairHint('steer')
  return undefined
}

/**
 * 解析一段文本里的 Mandate v2 头部。
 *
 * 这是**纯函数**：同样的文本永远得到同样的结果，不抛错。
 * @param text - 候选文本（一段提示词或一条消息）。
 * @returns 解析结果。
 */
export function parseMandateHeader(text: unknown): MandateParseResult {
  if (typeof text !== 'string') return { state: 'none' }
  const trimmed = text.trimStart()
  if (!trimmed.startsWith(MANDATE_FENCE_OPEN)) return { state: 'none' }
  const rest = trimmed.slice(MANDATE_FENCE_OPEN.length)
  if (!rest.startsWith('\n')) {
    return { state: 'invalid', reason: 'the mandate fence must be followed by a newline' }
  }
  const close = rest.indexOf('\n' + MANDATE_FENCE_CLOSE)
  if (close < 0) return { state: 'invalid', reason: 'the mandate block is not closed' }
  const json = rest.slice(1, close)
  if (Buffer.byteLength(json, 'utf8') > MANDATE_HEADER_MAX_BYTES) {
    return { state: 'invalid', reason: 'the mandate header exceeds the byte budget' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { state: 'invalid', reason: 'the mandate header is not valid JSON' }
  }
  const result = HEADER_SCHEMA.safeParse(parsed)
  if (!result.success) {
    return { state: 'invalid', reason: 'the mandate header does not match the v2 schema' }
  }
  const header = result.data
  const violation = kindViolation(header)
  if (violation !== undefined) return { state: 'invalid', reason: violation }
  const tail = rest.slice(close + 1 + MANDATE_FENCE_CLOSE.length)
  // 收尾围栏所在那一行以换行结束：正文从**下一行**开始，所以去掉恰好一个换行。
  const body = tail.startsWith('\n') ? tail.slice(1) : tail
  return { state: 'ok', header, body }
}

/**
 * 取出围栏之后的正文。
 *
 * 正文是"任务描述"本身：它不进账本，只被插件算出的 sha256 锚定。
 * @param text - 含头部的文本。
 * @returns 正文；没有头部时 undefined。
 */
export function mandateBodyOf(text: unknown): string | undefined {
  const parsed = parseMandateHeader(text)
  return parsed.state === 'ok' ? parsed.body : undefined
}

/**
 * 算出一个头部的命名空间键。
 *
 * 命名空间 = (brief_id, run_id, idem)。它由第一次派发尝试占用，此后**永不
 * 可复用**；`released` 只解禁 brief，不解禁命名空间。
 * @param header - 头部。
 * @returns 命名空间键。
 */
export function mandateNamespaceKey(header: MandateHeader): string {
  return mandateNamespaceKeyOf(header.brief_id, header.run_id, header.idem)
}

/**
 * 算出一个命名空间键。
 * @param brief_id - 工作项 id。
 * @param run_id - 运行 id。
 * @param idem - 幂等键。
 * @returns 命名空间键。
 */
export function mandateNamespaceKeyOf(brief_id: string, run_id: string, idem: string): string {
  return brief_id + '\u0000' + run_id + '\u0000' + idem
}

/**
 * 算出一个头部所属的工作项键。
 * @param header - 头部。
 * @returns 工作项 id。
 */
export function mandateBriefKey(header: MandateHeader): string {
  return header.brief_id
}

/**
 * 取出一个头部的运行引用（血缘用）。
 * @param header - 头部。
 * @returns 运行引用。
 */
export function mandateRunRefOf(header: MandateHeader): MandateRunRef {
  return { brief_id: header.brief_id, run_id: header.run_id, idem: header.idem }
}
