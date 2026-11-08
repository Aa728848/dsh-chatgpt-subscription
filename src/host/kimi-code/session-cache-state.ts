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

import path from 'node:path'
import { dshHomeDir } from '../common/home.ts'
import { CommonSessionCacheStateStore } from '../common/session-cache-state.ts'

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
   * Prompt tokens of this conversation's FIRST request that came from cache.
   *
   * The only measurement of cross-session inheritance: a brand-new conversation
   * can read a prefix another conversation wrote minutes earlier, because the
   * service matches the cache by content rather than by conversation. Written
   * once, when the first request closes, and never rewritten — later turns pile
   * up their own reads and would drown the one number that answers "did this
   * conversation start warm".
   */
  firstRequestCachedTokens?: number
  /** Total prompt tokens that first request carried (cache read + fresh input). */
  firstRequestPromptTokens?: number
  /**
   * Consecutive warmup-qualified hits recorded for this session, when non-zero.
   *
   * Optional and only persisted on secondary/explicit state updates so the
   * initial turn record shape stays byte-identical when no warmup streak exists.
   */
  warmupConsecutiveHits?: number
  /**
   * Identities of the images this session has already given back to the image
   * budget.
   *
   * Durable because the budget is STICKY: a picture that was omitted stays
   * omitted for the rest of the conversation, and a restart that forgot that
   * would send the picture again and rebuild the cached prefix on the very
   * next turn.
   */
  budgetDropped?: string[]
  /** Base64 image bytes the most recent request carried. */
  lastRequestImageBytes?: number
  /** Image occurrences the most recent request replaced with a placeholder. */
  lastDroppedImages?: number
  /** When any field above last changed, epoch ms. Used for pruning and ordering. */
  updatedAt: number
}

/** Where the document lives; beside the other plugin-owned JSON. */
export function sessionCacheStatePath(): string {
  return path.join(dshHomeDir(), 'storages', 'dsh-chatgpt-subscription-kimi-cache.json')
}

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
export class SessionCacheStateStore extends CommonSessionCacheStateStore<KimiCodeSessionCacheRecord> {
  constructor(filePath = sessionCacheStatePath(), maxEntries = MAX_SESSION_RECORDS) {
    super({
      filePath,
      maxEntries,
      allowWrite: filePath !== sessionCacheStatePath() || persistenceEnabled(),
      normalizeRecord,
    })
  }

  /** Update the warmup streak without creating a record for an unknown session. */
  noteWarmupStreak(sessionId: string, consecutiveHits: number): void {
    this.update(sessionId, existing => {
      const normalized = count(consecutiveHits)
      if (normalized > 0) return { ...existing, warmupConsecutiveHits: normalized }
      if (existing.warmupConsecutiveHits === undefined) return existing
      const { warmupConsecutiveHits: _dropped, ...rest } = existing
      return rest
    })
  }
}

function normalizeRecord(value: unknown): KimiCodeSessionCacheRecord | undefined {
  if (!isRecord(value)) return undefined
  const lastActiveAt = finite(value.lastActiveAt)
  const updatedAt = finite(value.updatedAt)
  if (lastActiveAt === undefined || updatedAt === undefined) return undefined
  const drift = typeof value.lastDrift === 'string' && value.lastDrift !== '' ? value.lastDrift : undefined
  const firstRequestCachedTokens = nonNegative(value.firstRequestCachedTokens)
  const firstRequestPromptTokens = nonNegative(value.firstRequestPromptTokens)
  const warmupStreak = count(value.warmupConsecutiveHits)
  const budgetDropped = droppedImageKeys(value.budgetDropped)
  const lastRequestImageBytes = nonNegative(value.lastRequestImageBytes)
  const lastDroppedImages = nonNegative(value.lastDroppedImages)
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
    ...(firstRequestCachedTokens === undefined ? {} : { firstRequestCachedTokens }),
    ...(firstRequestPromptTokens === undefined ? {} : { firstRequestPromptTokens }),
    ...(warmupStreak > 0 ? { warmupConsecutiveHits: warmupStreak } : {}),
    ...(budgetDropped.length > 0 ? { budgetDropped } : {}),
    ...(lastRequestImageBytes === undefined ? {} : { lastRequestImageBytes }),
    ...(lastDroppedImages === undefined ? {} : { lastDroppedImages }),
  }
}

/**
 * How many dropped image identities one record keeps.
 *
 * A session that pastes hundreds of pictures would otherwise grow this
 * document without bound, and it is a diagnostic file: the identities that
 * matter are the ones a later turn still has to replace.
 */
const MAX_BUDGET_DROPPED_KEYS = 512

/**
 * The dropped image identities a stored record carries.
 *
 * Only non-empty strings, deduplicated and capped: the file is written from
 * whatever the process happened to hold, and a malformed entry must not take
 * the record down with it.
 */
function droppedImageKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const keys: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '') continue
    if (seen.has(entry)) continue
    seen.add(entry)
    keys.push(entry)
    if (keys.length >= MAX_BUDGET_DROPPED_KEYS) break
  }
  return keys
}

/** A stored byte or image count, or undefined when the field is absent or absurd. */
function nonNegative(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.floor(value)
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
