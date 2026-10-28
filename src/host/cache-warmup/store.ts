/**
 * 结果引用存储：内容寻址、原子写入、按字节安全分页。
 *
 * 三条不变量：
 *
 * 1. **原文逐字保存**。文件名是原文 UTF-8 字节的 sha256，所以同一份内容重复入库是幂等的，
 *    也不可能有一条引用悄悄指向别的字节。
 * 2. **历史 preview 与存储生命周期无关**。过期/淘汰/释放只影响「还能不能读到原文」，
 *    已经写进历史的那段预览文本是常量 —— 本模块从不接触历史。
 * 3. **只删具体文件**。淘汰按 mtime 逐个 `rm` 文件，绝不递归删除任何目录。
 *
 * @module dsh-chatgpt-subscription/host/cache-warmup/store
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { dshHomeDir } from '../common/home.ts'
import {
  CACHE_WARMUP_DEFAULTS,
  CacheWarmupStoreError,
  parseStructuredResultRows,
  type ResultPage,
  type ResultPageQuery,
  type ResultPutInput,
  type ResultReferenceStore,
  type StoredResultReference,
} from './contracts.ts'

/** 会话 id 的合法形状：单个路径段，不允许分隔符与 `..`。 */
const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** `ref://<session>/<sha256>`。 */
const REFERENCE_PATTERN = /^ref:\/\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/([0-9a-f]{64})$/

/** 引用前缀。 */
export const RESULT_REFERENCE_PREFIX = 'ref://'

/** 原文文件后缀。 */
const RESULT_SUFFIX = '.txt'

/** 临时文件标记（原子写入的中转，永不被分页读到）。 */
const TMP_MARKER = '.tmp.'

/**
 * 拼一条引用。digest 必须是 64 位小写十六进制，否则分页时会拒绝解析。
 * @param sessionId - 会话 id。
 * @param digest - 原文 sha256。
 * @returns `ref://<session>/<digest>`。
 */
export function formatResultRefId(sessionId: string, digest: string): string {
  return `${RESULT_REFERENCE_PREFIX}${sessionId}/${digest}`
}

/**
 * 解析一条引用。
 * @param refId - 待解析的引用。
 * @returns 会话与 digest；形状不合法时 undefined。
 */
export function parseResultRefId(refId: string): { sessionId: string; digest: string } | undefined {
  if (typeof refId !== 'string') return undefined
  const match = REFERENCE_PATTERN.exec(refId)
  if (match === null) return undefined
  return { sessionId: match[1]!, digest: match[2]! }
}

/** `FileResultReferenceStore` 的构造选项；全部可选，零参构造走 {@link defaultResultStoreRootDir}。 */
export interface FileResultReferenceStoreOptions {
  /** 根目录；不传则用 `<DSH_HOME>/storages/cache-warmup`。 */
  rootDir?: string
  /** 单结果字节上限。 */
  maxResultBytes?: number
  /** 每 session 字节总量上限。 */
  maxSessionBytes?: number
  /** 引用有效期（毫秒）；不传表示不过期。 */
  ttlMs?: number
  /** 时钟（毫秒），只用于有效期判定与记录时刻；测试可注入。 */
  now?: () => number
}

/**
 * 默认根目录。
 *
 * 每次调用都重新解析 `DSH_HOME`，所以构造之后再改环境变量（测试、多 profile）
 * 仍然生效；这也是零参构造能安全地只拿一个惰性默认值的原因。
 * @returns 默认根目录的绝对路径。
 */
export function defaultResultStoreRootDir(): string {
  return path.join(dshHomeDir(), 'storages', 'cache-warmup')
}

/** 校验会话 id 形状，非法直接拒绝（路径穿越在这里被挡住）。 */
function assertSessionId(sessionId: unknown): string {
  if (typeof sessionId !== 'string' || !SESSION_PATTERN.test(sessionId)) {
    throw new CacheWarmupStoreError('session id is not a single safe path segment', 'SESSION_INVALID')
  }
  return sessionId
}

/** 把 limit 收进 [1, 512]。 */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return CACHE_WARMUP_DEFAULTS.pageLimitDefault
  const rounded = Math.floor(limit)
  if (rounded < 1) return 1
  return Math.min(rounded, CACHE_WARMUP_DEFAULTS.pageLimitMax)
}

/** 把 maxBytes 收进 [1, 65536]。 */
function clampMaxBytes(maxBytes: number | undefined): number {
  if (maxBytes === undefined || !Number.isFinite(maxBytes)) return CACHE_WARMUP_DEFAULTS.pageMaxBytesDefault
  const rounded = Math.floor(maxBytes)
  if (rounded < 1) return 1
  return Math.min(rounded, CACHE_WARMUP_DEFAULTS.pageMaxBytesMax)
}

/** 一段文本的行数（末尾没有换行也算一行）。 */
function countLines(text: string): number {
  if (text === '') return 0
  let lines = 0
  for (const char of text) if (char === '\n') lines += 1
  return text.endsWith('\n') ? lines : lines + 1
}

/**
 * 按 UTF-8 字节安全分页。
 *
 * `offset` 是字节偏移，必须落在字符边界上（上一页的 `nextOffset` 天然满足）；
 * 每页最多 `limit` 行且不超过 `maxBytes` 字节，任何一页都不会把一个字符切成两半。
 * 两个上限谁先到就在谁那里收手，`nextOffset` 精确指回同一位置，所以
 * 「两次翻页拼起来等于原文」是构造出来的性质，不是巧合。
 */
function pageText(args: {
  sessionId: string
  refId: string
  text: string
  buffer: Buffer
  offset: number
  limit: number
  maxBytes: number
}): ResultPage {
  const { sessionId, refId, text, buffer, offset, limit, maxBytes } = args
  const totalBytes = buffer.length
  if (!Number.isInteger(offset) || offset < 0) {
    throw new CacheWarmupStoreError('offset must be a non-negative integer byte offset', 'OFFSET_OUT_OF_RANGE')
  }
  if (offset > totalBytes) {
    throw new CacheWarmupStoreError(`offset ${offset} is past the ${totalBytes}-byte result`, 'OFFSET_OUT_OF_RANGE')
  }
  if (offset < totalBytes && (buffer[offset]! & 0xc0) === 0x80) {
    throw new CacheWarmupStoreError('offset is not on a UTF-8 character boundary', 'OFFSET_INVALID')
  }

  const rest = offset === 0 ? text : new TextDecoder('utf-8').decode(buffer.subarray(offset))
  let content = ''
  let contentBytes = 0
  let lines = 0
  let stoppedByBytes = false
  let stoppedByLines = false
  for (const char of rest) {
    const charBytes = Buffer.byteLength(char, 'utf8')
    if (lines >= limit) {
      stoppedByLines = true
      break
    }
    if (contentBytes + charBytes > maxBytes) {
      // 宁可让这一页略微超过预算，也要整字符返回：绝不在字符中间切断。
      if (content === '') {
        content = char
        contentBytes = charBytes
      }
      stoppedByBytes = true
      break
    }
    content += char
    contentBytes += charBytes
    if (char === '\n') lines += 1
  }

  const consumedBytes = Buffer.byteLength(content, 'utf8')
  const nextOffset = offset + consumedBytes
  const complete = nextOffset >= totalBytes
  const remaining = rest.slice(content.length)
  return {
    sessionId,
    refId,
    mode: 'text',
    content,
    offset,
    nextOffset: complete ? null : nextOffset,
    complete,
    omitted: {
      reason: complete ? 'none' : stoppedByBytes ? 'bytes' : stoppedByLines ? 'lines' : 'bytes',
      chars: remaining.length,
      lines: countLines(remaining),
      rows: 0,
      bytes: Buffer.byteLength(remaining, 'utf8'),
    },
    totalChars: text.length,
    totalBytes,
    limit,
    maxBytes,
  }
}

/**
 * 结构化行分页：先可靠解析，再按 `fields`/`equals` 过滤，最后按行取一页。
 *
 * 解析不可信就抛 `NOT_STRUCTURED`，而不是退回文本模式 —— 调用方要的是「按字段取」，
 * 悄悄给回一段原文等于让它以为字段过滤生效了。
 */
function pageStructured(args: {
  sessionId: string
  refId: string
  text: string
  buffer: Buffer
  offset: number
  limit: number
  maxBytes: number
  fields?: readonly string[]
  equals?: Readonly<Record<string, string>>
}): ResultPage {
  const { sessionId, refId, text, buffer, offset, limit, maxBytes } = args
  const parsed = parseStructuredResultRows(text)
  if (parsed === undefined) {
    throw new CacheWarmupStoreError('stored result is not reliably structured rows', 'NOT_STRUCTURED')
  }
  const requested = args.fields === undefined ? [...parsed.fields] : [...args.fields]
  for (const field of requested) {
    if (!parsed.fields.includes(field)) {
      throw new CacheWarmupStoreError(`unknown field "${field}"`, 'FIELD_UNKNOWN')
    }
  }
  const equals = args.equals ?? {}
  for (const key of Object.keys(equals)) {
    if (!parsed.fields.includes(key)) {
      throw new CacheWarmupStoreError(`unknown field "${key}"`, 'FIELD_UNKNOWN')
    }
  }
  const matched = parsed.rows.filter((row) =>
    Object.entries(equals).every(([key, value]) => (row[key] ?? '') === value),
  )
  if (!Number.isInteger(offset) || offset < 0) {
    throw new CacheWarmupStoreError('offset must be a non-negative integer row index', 'OFFSET_OUT_OF_RANGE')
  }
  if (offset > matched.length) {
    throw new CacheWarmupStoreError(`offset ${offset} is past the ${matched.length}-row result`, 'OFFSET_OUT_OF_RANGE')
  }

  const project = (row: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const field of requested) out[field] = row[field] ?? ''
    return out
  }
  const serialized = (row: Record<string, string>): string => JSON.stringify(project(row))
  const selected: string[] = []
  let bytes = 0
  let index = offset
  let hitByteCap = false
  while (index < matched.length && selected.length < limit) {
    const line = serialized(matched[index]!)
    const lineBytes = Buffer.byteLength(line, 'utf8') + (selected.length === 0 ? 0 : 1)
    if (bytes + lineBytes > maxBytes && selected.length > 0) {
      hitByteCap = true
      break
    }
    if (lineBytes > maxBytes) hitByteCap = true
    selected.push(line)
    bytes += lineBytes
    index += 1
  }

  const remainingRows = matched.slice(index)
  const remainingText = remainingRows.map(serialized).join('\n')
  const complete = index >= matched.length
  return {
    sessionId,
    refId,
    mode: 'structured',
    content: selected.join('\n'),
    offset,
    nextOffset: complete ? null : index,
    complete,
    omitted: {
      reason: complete ? 'none' : hitByteCap ? 'bytes' : 'rows',
      chars: remainingText.length,
      lines: remainingRows.length,
      rows: remainingRows.length,
      bytes: Buffer.byteLength(remainingText, 'utf8'),
    },
    totalChars: text.length,
    totalBytes: buffer.length,
    limit,
    maxBytes,
    fields: requested,
    totalRows: parsed.rows.length,
    matchedRows: matched.length,
  }
}

/**
 * 文件系统结果存储。
 *
 * 目录布局：`<rootDir>/<sessionId>/<sha256>.txt`。会话 id 已经是单个安全路径段，
 * 所以「另一个 session 的引用」在路径上就构造不出来；即便如此 page 仍然先做归属校验，
 * 免得将来换布局时丢掉这道闸。
 */
export class FileResultReferenceStore implements ResultReferenceStore {
  private readonly options: FileResultReferenceStoreOptions
  private resolvedRootDir: string | undefined

  /** @param options - 根目录与上限；全部可选。 */
  constructor(options: FileResultReferenceStoreOptions = {}) {
    this.options = { ...options }
  }

  /** 当前生效的根目录。 */
  rootDir(): string {
    const configured = this.options.rootDir
    if (configured !== undefined && configured.trim() !== '') return path.resolve(configured)
    if (this.resolvedRootDir === undefined) this.resolvedRootDir = path.resolve(defaultResultStoreRootDir())
    return this.resolvedRootDir
  }

  /** 单结果字节上限。 */
  private maxResultBytes(): number {
    const value = this.options.maxResultBytes
    return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : CACHE_WARMUP_DEFAULTS.maxResultBytes
  }

  /** 每 session 字节总量上限。 */
  private maxSessionBytes(): number {
    const value = this.options.maxSessionBytes
    return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : CACHE_WARMUP_DEFAULTS.maxSessionBytes
  }

  /** 当前时钟。 */
  private now(): number {
    return this.options.now === undefined ? Date.now() : this.options.now()
  }

  /** 一个会话的目录。 */
  private sessionDir(sessionId: string): string {
    return path.join(this.rootDir(), sessionId)
  }

  /** 一个会话里一个 digest 的文件路径。 */
  private fileFor(sessionId: string, digest: string): string {
    return path.join(this.sessionDir(sessionId), digest + RESULT_SUFFIX)
  }

  /**
   * 保存原文。
   *
   * 幂等：文件已存在就直接返回同一个 refId，不重写、不改 mtime。
   * 原子：先写同目录的临时文件再 rename，读到一半的引用不可能存在。
   * 权限：写 0600（Windows 上是尽力而为，测试按平台跳过权限断言）。
   */
  async put(input: ResultPutInput): Promise<StoredResultReference> {
    const sessionId = assertSessionId(input.sessionId)
    if (typeof input.content !== 'string') {
      throw new CacheWarmupStoreError('content must be a string', 'CONTENT_INVALID')
    }
    const bytes = Buffer.from(input.content, 'utf8')
    const maxResultBytes = this.maxResultBytes()
    if (bytes.length > maxResultBytes) {
      throw new CacheWarmupStoreError(
        `result is ${bytes.length} bytes, above the ${maxResultBytes}-byte single-result limit`,
        'RESULT_TOO_LARGE',
      )
    }
    const digest = createHash('sha256').update(bytes).digest('hex')
    const refId = formatResultRefId(sessionId, digest)
    const at = input.at ?? this.now()
    const target = this.fileFor(sessionId, digest)

    const existing = await fs.stat(target).catch(() => undefined)
    if (existing !== undefined && existing.isFile()) {
      return { refId, sessionId, digest, bytes: existing.size, chars: input.content.length, at, created: false }
    }

    await fs.mkdir(this.sessionDir(sessionId), { recursive: true, mode: 0o700 })
    await this.enforceSessionBudget(this.sessionDir(sessionId), bytes.length, target)
    const tmp = path.join(
      this.sessionDir(sessionId),
      `${digest}.${process.pid}.${Date.now()}${TMP_MARKER}`,
    )
    await fs.writeFile(tmp, bytes, { mode: 0o600 })
    await fs.chmod(tmp, 0o600).catch(() => undefined)
    await fs.rename(tmp, target)
    await fs.chmod(target, 0o600).catch(() => undefined)
    return { refId, sessionId, digest, bytes: bytes.length, chars: input.content.length, at, created: true }
  }

  /**
   * 按 session 预算淘汰最旧的原文。
   *
   * 只按 mtime 从旧到新单个删除；删的是具体文件，路径来自 readdir，不含目录递归。
   * 淘汰永远不改任何历史 preview —— 那是调用方已经拿走的文本。
   */
  private async enforceSessionBudget(dir: string, incoming: number, keep: string): Promise<void> {
    const budget = this.maxSessionBytes()
    if (incoming > budget) {
      throw new CacheWarmupStoreError(
        `result is ${incoming} bytes, above the ${budget}-byte per-session limit`,
        'STORE_FULL',
      )
    }
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const files: Array<{ file: string; size: number; mtime: number }> = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(RESULT_SUFFIX)) continue
      const file = path.join(dir, entry.name)
      if (file === keep) continue
      const stats = await fs.stat(file).catch(() => undefined)
      if (stats === undefined) continue
      files.push({ file, size: stats.size, mtime: stats.mtimeMs })
    }
    let total = files.reduce((sum, file) => sum + file.size, 0)
    if (total + incoming <= budget) return
    files.sort((left, right) => left.mtime - right.mtime)
    for (const file of files) {
      if (total + incoming <= budget) break
      await fs.rm(file.file, { force: true }).catch(() => undefined)
      total -= file.size
    }
  }

  /**
   * 读一页。
   *
   * 归属校验在碰文件系统之前完成：别人的引用不会告诉你它存在不存在。
   */
  async page(input: ResultPageQuery): Promise<ResultPage> {
    const sessionId = assertSessionId(input.sessionId)
    const parsed = parseResultRefId(input.refId)
    if (parsed === undefined) {
      throw new CacheWarmupStoreError('reference is not one this store issues', 'REFERENCE_INVALID')
    }
    if (parsed.sessionId !== sessionId) {
      throw new CacheWarmupStoreError('reference does not belong to this session', 'SESSION_MISMATCH')
    }
    const file = this.fileFor(sessionId, parsed.digest)
    const stats = await fs.stat(file).catch(() => undefined)
    if (stats === undefined || !stats.isFile()) {
      throw new CacheWarmupStoreError('stored result is missing; it was released or evicted', 'RESULT_NOT_FOUND')
    }
    const ttlMs = this.options.ttlMs
    if (ttlMs !== undefined && ttlMs > 0 && this.now() - stats.mtimeMs > ttlMs) {
      throw new CacheWarmupStoreError('stored result expired', 'RESULT_EXPIRED')
    }
    const buffer = await fs.readFile(file)
    const text = new TextDecoder('utf-8').decode(buffer)
    const limit = clampLimit(input.limit)
    const maxBytes = clampMaxBytes(input.maxBytes)
    const offset = input.offset ?? 0
    if (input.fields !== undefined || input.equals !== undefined) {
      return pageStructured({
        sessionId,
        refId: input.refId,
        text,
        buffer,
        offset,
        limit,
        maxBytes,
        fields: input.fields,
        equals: input.equals,
      })
    }
    return pageText({ sessionId, refId: input.refId, text, buffer, offset, limit, maxBytes })
  }

  /**
   * 释放一条引用：只删这一个具体文件，缺了就当已经释放（返回 false）。
   * 清理路径上不抛文件系统错误，免得在 finally 里把原始异常顶掉。
   */
  async release(input: { sessionId: string; refId: string }): Promise<boolean> {
    const sessionId = assertSessionId(input.sessionId)
    const parsed = parseResultRefId(input.refId)
    if (parsed === undefined) {
      throw new CacheWarmupStoreError('reference is not one this store issues', 'REFERENCE_INVALID')
    }
    if (parsed.sessionId !== sessionId) {
      throw new CacheWarmupStoreError('reference does not belong to this session', 'SESSION_MISMATCH')
    }
    const file = this.fileFor(sessionId, parsed.digest)
    const exists = await fs.stat(file).catch(() => undefined)
    if (exists === undefined || !exists.isFile()) return false
    try {
      await fs.rm(file, { force: true })
      return true
    } catch {
      return false
    }
  }
}
