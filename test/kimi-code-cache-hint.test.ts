import { beforeEach, describe, expect, it } from 'vitest'
import {
  CACHE_TTL_MS,
  MIN_TOKENS_TO_HINT,
  evaluateCacheHint,
  markSessionActive,
  resetSessionActivity,
  sessionLastActiveAt,
} from '../src/host/kimi-code/cache-hint.ts'

const NOW = 1_700_000_000_000

beforeEach(() => {
  resetSessionActivity()
})

describe('evaluateCacheHint', () => {
  it('warns when a large context sat idle beyond the lifetime', () => {
    const decision = evaluateCacheHint({
      now: NOW,
      lastActiveAt: NOW - CACHE_TTL_MS - 1,
      totalTokens: 200_000,
    })
    expect(decision.kind).toBe('hint')
  })

  it('stays silent while the entry can still be alive', () => {
    expect(evaluateCacheHint({
      now: NOW,
      lastActiveAt: NOW - 1_000,
      totalTokens: 200_000,
    }).kind).toBe('skip')
  })

  it('stays silent at exactly the lifetime', () => {
    // Strictly-greater: an entry alive to its TTL has not expired.
    expect(evaluateCacheHint({
      now: NOW,
      lastActiveAt: NOW - CACHE_TTL_MS,
      totalTokens: 200_000,
    }).kind).toBe('skip')
  })

  it('pins the lifetime to the measured 30 minutes, not the "5m" tier name', () => {
    // Measured on the coding endpoint (three replicas per age, one fresh prefix
    // per age): 3/3 warm through 25 minutes, 1/3 at 30, 0/3 at 35. The old
    // 5-minute value was the write tier's NAME, and it warned from minute 6
    // while the entry stayed warm for another 19.
    expect(CACHE_TTL_MS).toBe(30 * 60 * 1000)
  })

  it('does not warn during the window the measurement kept warm', () => {
    // 25 minutes was 3/3 warm. Warning here would be the false positive the
    // "skip on doubt" rule exists to prevent.
    expect(evaluateCacheHint({
      now: NOW,
      lastActiveAt: NOW - 25 * 60 * 1000,
      totalTokens: 200_000,
    }).kind).toBe('skip')
  })

  it('stays silent for a small context, where reprocessing is free', () => {
    expect(evaluateCacheHint({
      now: NOW,
      lastActiveAt: NOW - CACHE_TTL_MS * 10,
      totalTokens: MIN_TOKENS_TO_HINT - 1,
    }).kind).toBe('skip')
  })

  it('skips rather than guessing when the idle time is unknown', () => {
    expect(evaluateCacheHint({ now: NOW, totalTokens: 200_000 }).kind).toBe('skip')
  })

  it('skips rather than guessing when the context size is unknown', () => {
    expect(evaluateCacheHint({ now: NOW, lastActiveAt: NOW - 1 }).kind).toBe('skip')
  })

  it('skips on a non-finite timestamp', () => {
    expect(evaluateCacheHint({ now: NOW, lastActiveAt: Number.NaN, totalTokens: 200_000 }).kind).toBe('skip')
    expect(evaluateCacheHint({ now: NOW, lastActiveAt: NOW, totalTokens: Number.NaN }).kind).toBe('skip')
  })

  it('stays silent for a session that never ran', () => {
    expect(evaluateCacheHint({ now: NOW, totalTokens: 200_000 }).kind).toBe('skip')
  })
})

describe('session activity', () => {
  it('remembers when a session last did something', () => {
    markSessionActive('sess-a', NOW)
    expect(sessionLastActiveAt('sess-a')).toBe(NOW)
  })

  it('moves the timestamp forward on a later turn', () => {
    markSessionActive('sess-a', NOW)
    markSessionActive('sess-a', NOW + 60_000)
    expect(sessionLastActiveAt('sess-a')).toBe(NOW + 60_000)
  })

  it('keeps sessions apart', () => {
    markSessionActive('a', NOW)
    markSessionActive('b', NOW + 1_000)
    expect(sessionLastActiveAt('a')).toBe(NOW)
    expect(sessionLastActiveAt('b')).toBe(NOW + 1_000)
  })

  it('reports nothing for a session that never ran', () => {
    expect(sessionLastActiveAt('never-seen')).toBeUndefined()
    expect(sessionLastActiveAt(undefined)).toBeUndefined()
  })

  it('ignores a blank session id', () => {
    markSessionActive('   ', NOW)
    expect(sessionLastActiveAt('   ')).toBeUndefined()
  })
})