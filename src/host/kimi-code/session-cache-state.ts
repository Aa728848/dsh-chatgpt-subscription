/**
 * Durable per-session cache state for the Kimi route.
 *
 * Kimi's prefix cache lives on the service, but everything a status card needs
 * to describe it - when this conversation last ran, how large its prompt is, and
 * why the last request's prefix broke - used to live in process memory only. A
 * restart therefore erased the one fact the expiry hint depends on, exactly when
 * the user resumes a task and pays for the whole prompt again: the card showed
 * an empty state instead of "this conversation sat idle past the cache lifetime".
 *
 * This module keeps that state on disk, in the same storages directory the
 * preferences store uses, so the hint and the attribution survive a restart.
 * It is a diagnostic: nothing here changes a request.
 * @module dsh-chatgpt-subscription/kimi-code-session-cache-state
 */

import fs from 'node:fs'
import path from 'node:path'
import { dshHomeDir } from '../common/home.ts'

/**
 * Conversations kept in the document.
 *
 * The hint only ever describes a conversation that ran recently, so an install
 * that opens hundreds of sessions does not need all of them on disk. Old entries
 * are dropped by {@link SessionCacheStateStore.write} in updatedAt order, which
 * is the same order the "most recent conversation" fallback reads.
 */
export const MAX_SESSION_RECORDS = 64

/** One conversation's cache state, as it survives the process. */
export interface KimiCodeSessionCacheRecord {
  /** When this conversation last sent a request, epoch ms. */
  lastActiveAt: number
  /**
   * Prompt tokens of the most recent request (cache read + fresh input).
   *
   * The LAST request, not the rolling total: the expiry hint is about how much
   * the next turn will have to reprocess, and summing every turn of a long
   * conversation would overstate that by an order of magnitude.
   */
  totalTokens: number
  /** Rolling totals for the card, mirroring the mapper's per-session stats. */
  requests: number
  cachedTokens: number
  freshTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
  /** Cause attributed to the most recent request's prefix break, when there was one. */
  lastDrift?: string
  /**
   * Consecutive warmup-qualified hits recorded for this session, when non-zero.
   *
   * Optional and only persisted on secondary/explicit state updates so the
   * initial turn record shape stays byte-identical when no warmup streak exists.
   */
  warmupConsecutiveHits?: number
  /** When any field above last changed, epoch ms. Used for pruning and ordering. */
  updatedAt: number
}

/** On-disk shape. */
interface SessionCacheDocument {
  version: 1
  sessions: Record<string, KimiCodeSessionCacheRecord>
}

/** Where the document lives; beside the other plugin-owned JSON. */
export function sessionCacheStatePath(): string {
  return path.join(dshHomeDir(), 'storages', 'dsh-chatgpt-subscription-kimi-cache.json')
}

/** Distinguishes concurrent temporary files written by one process. */
let writeSequence = 0

/**
 * Whether a scheduled write should reach the disk.
 *
 * A unit test that exercises the request path must not overwrite the state file
 * of the machine running it; tests build their own store against a temporary
 * path (which always writes) and call {@link SessionCacheStateStore.flush}.
 */
function persistenceEnabled(): boolean {
  return process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test'
}

/**
 * Per-session cache state held in one JSON document.
 *
 * Reads are synchronous because every caller is answering a status request or
 * closing a turn, both of which are allowed to block on a file this size. Writes
 * are debounced: a turn reports once, and several turns in flight must not
 * rewrite the document several times.
 */
export class SessionCacheStateStore {
  private document: SessionCacheDocument | undefined
  private pending: ReturnType<typeof setTimeout> | undefined

  /**
   * @param filePath - Document location; defaults to {@link sessionCacheStatePath}.
   * @param maxEntries - Conversations kept; the oldest are dropped first.
   */
  private readonly filePath: string
  private readonly maxEntries: number
  /**
   * Whether this store may write at all.
   *
   * A store built on an explicit path is someone's own file - a test's temporary
   * document - and always writes. The default-path store belongs to the user's
   * harness home, and a test that never named a path must not overwrite it.
   */
  private readonly allowWrite: boolean

  constructor(filePath = sessionCacheStatePath(), maxEntries = MAX_SESSION_RECORDS) {
    this.filePath = filePath
    this.maxEntries = maxEntries
    this.allowWrite = filePath !== sessionCacheStatePath() || persistenceEnabled()
  }

  /**
   * The record for one conversation, or the most recently active one.
   *
   * The fallback is what makes the status card useful without a session named:
   * the card describes the line, and the only conversation it can honestly
   * describe in that case is the one that ran last.
   * @param sessionId - Conversation to read; omit for the most recent one.
   * @returns the record, or undefined when nothing has ever been recorded.
   */
  read(sessionId?: string): KimiCodeSessionCacheRecord | undefined {
    const sessions = this.load().sessions
    const named = sessionId?.trim()
    if (named !== undefined && named !== '') return sessions[named]
    let newest: KimiCodeSessionCacheRecord | undefined
    for (const record of Object.values(sessions)) {
      if (newest === undefined || record.updatedAt > newest.updatedAt) newest = record
    }
    return newest
  }

  /**
   * File one conversation's state and schedule the document write.
   * @param sessionId - Conversation the record belongs to; ignored when blank.
   * @param record - Complete record for that conversation.
   */
  write(sessionId: string, record: KimiCodeSessionCacheRecord): void {
    const key = sessionId.trim()
    if (key === '') return
    const document = this.load()
    document.sessions[key] = record
    this.prune(document)
    this.schedule()
  }

  /**
   * Update the warmup consecutive-hit streak on an already-written session record
   * in place, without issuing a second `write()` call.
   */
  noteWarmupStreak(sessionId: string, consecutiveHits: number): void {
    const key = sessionId.trim()
    if (key === '') return
    const document = this.load()
    const existing = document.sessions[key]
    if (existing === undefined) return
    const normalized = count(consecutiveHits)
    if (normalized > 0) {
      document.sessions[key] = { ...existing, warmupConsecutiveHits: normalized }
    } else if (existing.warmupConsecutiveHits !== undefined) {
      const { warmupConsecutiveHits: _dropped, ...rest } = existing
      document.sessions[key] = rest
    } else {
      return
    }
    this.schedule()
  }

  /**
   * Write the document now, synchronously.
   *
   * Exposed for tests and for a caller that is about to lose the process; the
   * debounced path is what normal turns use.
   */
  flush(): void {
    this.cancelPending()
    const document = this.document
    if (document === undefined) return
    this.persist(document)
  }

  /** Drop everything older than the newest maxEntries conversations. */
  private prune(document: SessionCacheDocument): void {
    const entries = Object.entries(document.sessions)
    if (entries.length <= this.maxEntries) return
    entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    document.sessions = Object.fromEntries(entries.slice(0, this.maxEntries))
  }

  /** Read the document once; a missing or corrupt file reads as empty. */
  private load(): SessionCacheDocument {
    if (this.document !== undefined) return this.document
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      this.document = normalizeDocument(parsed)
    } catch {
      this.document = { version: 1, sessions: {} }
    }
    return this.document
  }

  /** Coalesce the writes one turn's several fields would otherwise cause. */
  private schedule(): void {
    if (!this.allowWrite || this.pending !== undefined) return
    this.pending = setTimeout(() => {
      this.pending = undefined
      const document = this.document
      if (document !== undefined) this.persist(document)
    }, 250)
    // A status read must never keep the process alive.
    ;(this.pending as unknown as { unref?: () => void }).unref?.()
  }

  private cancelPending(): void {
    if (this.pending === undefined) return
    clearTimeout(this.pending)
    this.pending = undefined
  }

  /** Write through a temporary file so a crash cannot leave half a document. */
  private persist(document: SessionCacheDocument): void {
    if (!this.allowWrite) return
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const temporary = this.filePath + '.' + process.pid + '.' + (++writeSequence) + '.tmp'
      fs.writeFileSync(temporary, JSON.stringify(document), 'utf8')
      fs.renameSync(temporary, this.filePath)
    } catch {
      // Diagnostic state only: an unwritable home must not fail a turn.
    }
  }
}

/** Validate one parsed document, dropping entries that do not describe a record. */
function normalizeDocument(value: unknown): SessionCacheDocument {
  const sessions: Record<string, KimiCodeSessionCacheRecord> = {}
  if (isRecord(value) && isRecord(value.sessions)) {
    for (const [key, entry] of Object.entries(value.sessions)) {
      const record = normalizeRecord(entry)
      if (record !== undefined) sessions[key] = record
    }
  }
  return { version: 1, sessions }
}

function normalizeRecord(value: unknown): KimiCodeSessionCacheRecord | undefined {
  if (!isRecord(value)) return undefined
  const lastActiveAt = finite(value.lastActiveAt)
  const updatedAt = finite(value.updatedAt)
  if (lastActiveAt === undefined || updatedAt === undefined) return undefined
  const drift = typeof value.lastDrift === 'string' && value.lastDrift !== '' ? value.lastDrift : undefined
  const warmupStreak = count(value.warmupConsecutiveHits)
  return {
    lastActiveAt,
    updatedAt,
    totalTokens: count(value.totalTokens),
    requests: count(value.requests),
    cachedTokens: count(value.cachedTokens),
    freshTokens: count(value.freshTokens),
    outputTokens: count(value.outputTokens),
    cacheWriteTokens: count(value.cacheWriteTokens),
    cacheWrite5mTokens: count(value.cacheWrite5mTokens),
    cacheWrite1hTokens: count(value.cacheWrite1hTokens),
    ...(drift === undefined ? {} : { lastDrift: drift }),
    ...(warmupStreak > 0 ? { warmupConsecutiveHits: warmupStreak } : {}),
  }
}

/** What the running process knows about one conversation, before any disk read. */
export interface SessionCacheViewInput {
  /** Last activity the process remembers, if the conversation ran in it. */
  memoryLastActiveAt?: number
  /** Prompt tokens the process has seen for this conversation; 0 when none. */
  memoryTotalTokens: number
}

/**
 * Combine process memory with the durable record into the hint's two inputs.
 *
 * The process supplies the idle baseline whenever it has served the conversation,
 * because only it knows about the turn that just ended. The prompt size comes
 * from the file when it has one: the record is rewritten at every turn close, so
 * it holds the LAST request's size, while the process only offers a sum across
 * every turn of the conversation - which can overstate the next turn's cost by
 * an order of magnitude. With no conversation named the file is the only source,
 * because a process aggregate spans several conversations and would make "this
 * conversation's prompt" a number no single conversation has.
 * @param sessionId - Conversation being described; omit for "the most recent".
 * @param memory - What this process knows about it.
 * @param durable - What the last run on this machine left behind.
 * @returns the idle baseline and prompt size the expiry rule needs.
 */
export function resolveSessionCacheView(
  sessionId: string | undefined,
  memory: SessionCacheViewInput,
  durable: KimiCodeSessionCacheRecord | undefined,
): { lastActiveAt?: number; totalTokens: number } {
  const unnamed = sessionId === undefined || sessionId.trim() === ''
  if (unnamed) {
    return {
      ...(durable === undefined ? {} : { lastActiveAt: durable.lastActiveAt }),
      totalTokens: durable?.totalTokens ?? 0,
    }
  }
  return {
    lastActiveAt: memory.memoryLastActiveAt ?? durable?.lastActiveAt,
    totalTokens: durable?.totalTokens ?? memory.memoryTotalTokens,
  }
}

/** The process-wide store the adapter writes and the routes read. */
export const sessionCacheState = new SessionCacheStateStore()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function count(value: unknown): number {
  const number = finite(value)
  return number === undefined || number < 0 ? 0 : Math.floor(number)
}
