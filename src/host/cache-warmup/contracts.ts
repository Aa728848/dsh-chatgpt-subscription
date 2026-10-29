/**
 * 缓存预热子包（cache-warmup）的共享契约：类型、默认值与错误码。
 *
 * 这一层刻意不 import 任何 `node:` 内置模块：投影与预算的一半逻辑是纯字符串/数字运算，
 * 保持零依赖才能让消费者（宿主适配层、设置路由、测试）只为了一个类型就拖进文件系统实现。
 * 唯一的例外是 `parseStructuredResultRows` —— 它是对**已存储原文**的解析器，
 * 存储分页与投影预览必须共用同一份判定，否则「能分页但预览判断不同」会立刻变成幻觉。
 *
 * @module dsh-chatgpt-subscription/host/cache-warmup/contracts
 */

/**
 * 子包默认值。
 *
 * 预热期的字符上限是**按 token 反推的保守字符预算**：中文/代码混排大约每 token 1.6-2.0
 * 字符，1200 字符落在 512-1024 token 区间的中段，宁可少给也不要在预热期用一个
 * 还没被验证过的更大预算去撞缓存键。命中率与连续次数见约束 4。
 */
export const CACHE_WARMUP_DEFAULTS = {
  /** 预热期单次预览的字符预算。约 600-750 tokens。 */
  warmupMaxChars: 1200,
  /** 稳态（连续两次高命中率且无 drift 之后）的字符预算。 */
  steadyStateMaxChars: 8000,
  /** 视为命中的最低命中率。 */
  hitRatioThreshold: 0.97,
  /** 退出预热期需要连续命中的报告条数。 */
  consecutiveHitsRequired: 2,
  /**
   * 稳态第二轨（短会话分母效应兜底）：已命中的缓存前缀至少达到该 token 规模，
   * 且相比上一条报告一字未掉（`cacheReadTokens >= prev.cacheReadTokens`），
   * 同时本轮新增未命中部分不超过 `retainedPrefixMaxFreshTokens` 时，同样计为一次有效命中。
   */
  retainedPrefixMinCachedTokens: 1024,
  /** 稳态第二轨允许的单轮最大新增未命中 token 数（与 Kimi 256-token 缓存块对齐）。 */
  retainedPrefixMaxFreshTokens: 256,
  /**
   * 缓存存活窗口（毫秒，25 分钟，与 Kimi 实测全热上限一致）。
   * 距离最近一次报告超过该时长时，预算计算自动预判缓存已冷、退回预热期保守预算。
   */
  cacheTtlMs: 25 * 60 * 1000,
  /** 单结果原文上限（字节）。 */
  maxResultBytes: 8 * 1024 * 1024,
  /** 每 session 原文总量上限（字节）。 */
  maxSessionBytes: 64 * 1024 * 1024,
  /** 分页 limit 默认值（行）。 */
  pageLimitDefault: 64,
  /** 分页 limit 上限（行）。 */
  pageLimitMax: 512,
  /** 分页 maxBytes 默认值（字节）。 */
  pageMaxBytesDefault: 16 * 1024,
  /** 分页 maxBytes 上限（字节）。 */
  pageMaxBytesMax: 64 * 1024,
  /** usage registry 的 session 数上限。 */
  maxUsageSessions: 256,
  /** 每 session 保留的用量报告条数上限。 */
  maxUsageReportsPerSession: 32,
} as const

/** 预览预算，也是 `cacheWarmupBudget()` 的返回形状。 */
export interface PreviewBudget {
  /** 一次预览最多占用的字符数。 */
  maxChars: number
  /** 是否仍处于预热期。 */
  warmup: boolean
  /** 当前连续高命中率报告条数（drift 会把它清零）。 */
  consecutiveHits: number
  /** 最近一次报告的缓存命中率（0-1）；没有报告时为 0。 */
  hitRatio: number
}

/** 一次缓存用量报告，形状与宿主 usage 统计一一对应。 */
export interface CacheWarmupUsage {
  /** 会话 id。 */
  sessionId: string
  /** 本次请求的输入 token 总数。 */
  inputTokens: number
  /** 其中命中缓存的 token 数。 */
  cacheReadTokens: number
  /** 本次请求的输出 token 数。 */
  outputTokens: number
  /** 本次请求的总 token 数。 */
  totalTokens: number
  /** 报告时刻（Unix 毫秒）。 */
  at: number
  /** 非空表示这次观测到缓存漂移（前缀被改、工具集变化等），连续命中计数随之清零。 */
  driftCause?: string
}

/** 结果内容的「块」形状，与宿主工具结果的文本块对齐。 */
export interface ToolResultBlock {
  /** 块类型；只有 `text` 会被投影考虑。 */
  type: string
  /** 文本块正文。 */
  text?: string
  /** 其他字段原样保留，永不改写。 */
  [key: string]: unknown
}

/** 工具结果内容：纯文本，或块数组（非文本块必须原样保留）。 */
export type ToolResultContent = string | readonly ToolResultBlock[]

/** 投影策略。`verbatim-*` 一律 `changed: false`。 */
export type ProjectionStrategy =
  | 'verbatim-small'
  | 'verbatim-non-text'
  | 'verbatim-unparsed'
  | 'verbatim-source-code'
  | 'verbatim-contract'
  | 'verbatim-subagent-report'
  | 'verbatim-intent'
  | 'verbatim-budget'
  | 'store-unavailable'
  | 'test-failure'
  | 'shell-output'
  | 'grep-results'
  | 'glob-results'
  | 'structured-rows'
  | 'file-outline'
  | 'web-outline'

/** 投影度量。契约要求前四个字段。 */
export interface ProjectionMetrics {
  /** 输入字符数（原文长度）。 */
  inputChars: number
  /** 输出字符数（预览长度）。 */
  outputChars: number
  /** 被预览省略掉的字符数。 */
  omittedChars: number
  /** 本次采用的策略。 */
  strategy: ProjectionStrategy
}

/** `projectToolResult` 的返回值。 */
export interface ProjectionResult {
  /** 新内容：未改变时与入参逐字相同，改变时是预览文本（或替换了单个文本块的块数组）。 */
  content: ToolResultContent
  /** 是否真的改写了内容。只有可证明结构化预览时才为 true。 */
  changed: boolean
  /** 度量。 */
  metrics: ProjectionMetrics
  /** 原文引用（只有在 `changed: true` 时存在）。 */
  refId?: string
  /** 预览正文（只有在 `changed: true` 时存在）。 */
  preview?: string
  /** 工具名（原样回显，便于统计）。 */
  toolName: string
  /** 会话 id。 */
  sessionId: string
  /** provider id（有就回显）。 */
  provider?: string
  /** 投影时刻（Unix 毫秒）。 */
  at: number
}

/** `projectToolResult` 的入参。 */
export interface ProjectToolResultInput {
  /** 工具名；用于识别测试/shell/grep/glob 结果。 */
  toolName: string
  /** provider id，可选，只回显。 */
  provider?: string
  /** 会话 id；refId 与分页的归属校验都基于它。 */
  sessionId: string
  /** 工具结果内容。 */
  content: ToolResultContent
  /** 是否为失败结果；失败结果的失败集必须完整保留。 */
  isError?: boolean
  /** 是否已明确判定为导航任务；直接 read/web_fetch/grep/glob 只有 true 才考虑投影。 */
  navigation?: boolean
  /** 原日志开关关闭时，PTC 仅允许文件大纲，不得落回日志投影。 */
  retrievalOnly?: boolean
  /** 预览预算；不传则按 `cacheWarmupBudget(sessionId)` 取当前预算。 */
  budget?: PreviewBudget
  /** 原文存储；不传则保持原样（没有 ref 的预览等于丢数据）。 */
  store?: ResultReferenceStore
  /** 投影时刻（Unix 毫秒），默认 `Date.now()`。 */
  at?: number
}

/** 一条已存储的结果引用。 */
export interface StoredResultReference {
  /** `ref://<session>/<sha256>`。 */
  refId: string
  /** 所属会话。 */
  sessionId: string
  /** 原文的 sha256（小写十六进制）。 */
  digest: string
  /** 原文字节数。 */
  bytes: number
  /** 原文字符数。 */
  chars: number
  /** 入库时刻（Unix 毫秒）。 */
  at: number
  /** 是否本次新写入（false 表示命中了已存在的同一份内容）。 */
  created: boolean
}

/** `put` 的入参。 */
export interface ResultPutInput {
  /** 会话 id。 */
  sessionId: string
  /** 原文（逐字保存）。 */
  content: string
  /** 工具名，只做记录，不参与寻址。 */
  toolName?: string
  /** 入库时刻（Unix 毫秒）。 */
  at?: number
}

/** `page` 的入参。offset 从 0 开始。 */
export interface ResultPageQuery {
  /** 会话 id；必须与 refId 内嵌的 session 一致。 */
  sessionId: string
  /** `ref://<session>/<sha256>`。 */
  refId: string
  /** 起始位置：文本模式是 UTF-8 字节偏移，结构化模式是（过滤后的）行下标。 */
  offset?: number
  /** 本页最多行数，默认 64，上限 512。 */
  limit?: number
  /** 本页最多字节数，默认 16384，上限 65536。 */
  maxBytes?: number
  /** 结构化模式下要返回的字段；不传则返回全部字段。 */
  fields?: readonly string[]
  /** 结构化模式下的等值过滤（字符串比较，全部命中才算匹配）。 */
  equals?: Readonly<Record<string, string>>
}

/** 一页里被省略掉的部分；`reason: 'none'` 表示这一页就是全部。 */
export interface ResultPageOmitted {
  /** 省略原因。 */
  reason: 'none' | 'bytes' | 'lines' | 'rows'
  /** 省略的字符数。 */
  chars: number
  /** 省略的行数。 */
  lines: number
  /** 省略的行数（结构化模式）。 */
  rows: number
  /** 省略的字节数。 */
  bytes: number
}

/** `page` 的返回值。 */
export interface ResultPage {
  /** 会话 id。 */
  sessionId: string
  /** 原文引用。 */
  refId: string
  /** 分页模式。 */
  mode: 'text' | 'structured'
  /** 本页内容；文本模式下是原文的一段，结构化模式下是 JSON 行。 */
  content: string
  /** 本页起始位置（与入参同一单位）。 */
  offset: number
  /** 下一页的起始位置；`null` 表示已经取完。 */
  nextOffset: number | null
  /** 本页取完是否就是全文（不要用 content 长度去猜）。 */
  complete: boolean
  /** 被省略的部分。 */
  omitted: ResultPageOmitted
  /** 原文总字符数。 */
  totalChars: number
  /** 原文总字节数。 */
  totalBytes: number
  /** 实际生效的 limit。 */
  limit: number
  /** 实际生效的 maxBytes。 */
  maxBytes: number
  /** 结构化模式下返回的字段。 */
  fields?: string[]
  /** 结构化模式下的总行数。 */
  totalRows?: number
  /** 结构化模式下过滤后参与分页的行数。 */
  matchedRows?: number
}

/**
 * 结果引用存储。
 *
 * 一条结果一旦进入历史，它的 preview 与 refId 就是常量：存储过期、淘汰、
 * 释放都只影响「还能不能读到原文」，永不影响已经写进历史的那段文本。
 */
export interface ResultReferenceStore {
  /** 保存原文并返回引用；同内容重复保存必须幂等。 */
  put(input: ResultPutInput): Promise<StoredResultReference>
  /** 读取一页；必须校验 session 归属。 */
  page(input: ResultPageQuery): Promise<ResultPage>
  /** 释放一条引用（只删这个具体文件）；返回是否真的删掉了。 */
  release(input: { sessionId: string; refId: string }): Promise<boolean>
}

/** 错误码。 */
export type CacheWarmupErrorCode =
  | 'SESSION_INVALID'
  | 'CONTENT_INVALID'
  | 'RESULT_TOO_LARGE'
  | 'STORE_FULL'
  | 'ROOT_INVALID'
  | 'REFERENCE_INVALID'
  | 'SESSION_MISMATCH'
  | 'RESULT_NOT_FOUND'
  | 'RESULT_EXPIRED'
  | 'OFFSET_OUT_OF_RANGE'
  | 'OFFSET_INVALID'
  | 'NOT_STRUCTURED'
  | 'FIELD_UNKNOWN'

/**
 * 存储层错误。信息里只描述**请求本身**的问题，绝不回显其他 session 的内容或存在性。
 */
export class CacheWarmupStoreError extends Error {
  constructor(message: string, readonly code: CacheWarmupErrorCode) {
    super(message)
    this.name = 'CacheWarmupStoreError'
  }
}

/** 可靠解析出来的结构化行。 */
export interface StructuredResultRows {
  /** 字段名，按首次出现顺序。 */
  fields: string[]
  /** 行，非字符串值用 JSON 序列化后存放。 */
  rows: Array<Record<string, string>>
}

/** 一段文本被拆开的一列。 */
function splitDelimitedLine(line: string, delimiter: string): string[] {
  const cells: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"'
        index += 1
      } else {
        quoted = !quoted
      }
      continue
    }
    if (!quoted && char === delimiter) {
      cells.push(current)
      current = ''
      continue
    }
    current += char
  }
  cells.push(current)
  return cells
}

/** 把任意 JSON 值压成单元格文本；对象/数组保持可读的 JSON。 */
function cellOf(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/** JSON Lines：每一行都是一个结构一致的表格式对象，且至少 5 行（防止 2~3 个异构 tool 结果对象被当成一张表压掉）。 */
function parseJsonLines(lines: readonly string[]): StructuredResultRows | undefined {
  if (lines.length < 5) return undefined
  const fields: string[] = []
  const seen = new Set<string>()
  const rows: Array<Record<string, string>> = []
  let firstKeySet: Set<string> | undefined
  for (const line of lines) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return undefined
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    const keys = Object.keys(record)
    if (keys.length === 0) return undefined
    if (firstKeySet === undefined) {
      firstKeySet = new Set(keys)
    } else {
      // 要求每行至少与首行共享一个键，防止完全异构的 JSON 对象（如 read + bash 结果）被拼成稀疏宽表。
      const overlap = keys.some((k) => firstKeySet!.has(k))
      if (!overlap) return undefined
    }
    const row: Record<string, string> = {}
    for (const [key, value] of Object.entries(record)) {
      if (!seen.has(key)) {
        seen.add(key)
        fields.push(key)
      }
      row[key] = cellOf(value)
    }
    rows.push(row)
  }
  if (fields.length === 0) return undefined
  return { fields, rows }
}

/** 分隔符表格：首行合法表头（标识符列名，非 grep 路径行号或代码行）+ 至少两行同列数的数据。 */
function parseDelimitedRows(lines: readonly string[]): StructuredResultRows | undefined {
  if (lines.length < 3) return undefined
  const header = lines[0]!
  const delimiter = header.includes('\t') ? '\t' : header.includes(',') ? ',' : undefined
  if (delimiter === undefined) return undefined
  const fields = splitDelimitedLine(header, delimiter).map((cell) => cell.trim())
  if (fields.length < 2 || fields.some((field) => field === '')) return undefined
  // 表头单元格必须是简短列名（<= 64 字符，不含路径冒号行号、引号、花括号、分号或代码注释），防止把含 \t 的 grep 输出当成表头。
  if (
    fields.some(
      (field) =>
        field.length > 64 ||
        /[:;{}()[\]\\/*'"`]/.test(field) ||
        /^\d+$/.test(field),
    )
  ) {
    return undefined
  }
  if (new Set(fields).size !== fields.length) return undefined
  const rows: Array<Record<string, string>> = []
  for (const line of lines.slice(1)) {
    const cells = splitDelimitedLine(line, delimiter)
    if (cells.length !== fields.length) return undefined
    const row: Record<string, string> = {}
    fields.forEach((field, index) => {
      row[field] = cells[index]!
    })
    rows.push(row)
  }
  return rows.length === 0 ? undefined : { fields, rows }
}

/**
 * 把一段文本可靠地解析成结构化行；解析不可靠就返回 undefined。
 *
 * 判定刻意保守：宁可返回 undefined 让调用方保持原文，也不要猜出一张表，
 * 因为下游会把「猜出来的表」当成完整事实。
 */
export function parseStructuredResultRows(text: string): StructuredResultRows | undefined {
  const lines = text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
  if (lines.length < 2) return undefined
  return parseJsonLines(lines) ?? parseDelimitedRows(lines)
}
