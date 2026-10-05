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
  it('warns when a large context sat idle beyond the tier', () => {
    const decision = evaluateCacheHint({
      now: NOW,
      lastActiveAt: NOW - CACHE_TTL_MS['5m'] - 1,
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

  it('stays silent at exactly the tier lifetime', () => {
    // Strictly-greater: an entry alive to its TTL has not expired.
    expect(evaluateCacheHint({
      now: NOW,
      lastActiveAt: NOW - CACHE_TTL_MS['5m'],
      totalTokens: 200_000,
    }).kind).toBe('skip')
  })

  it('uses the stated tier rather than always assuming five minutes', () => {
    const idle = CACHE_TTL_MS['1h'] - 1
    expect(evaluateCacheHint({ now: NOW, lastActiveAt: NOW - idle, totalTokens: 200_000, cacheTtl: '1h' }).kind)
      .toBe('skip')
    expect(evaluateCacheHint({ now: NOW, lastActiveAt: NOW - idle, totalTokens: 200_000, cacheTtl: '5m' }).kind)
      .toBe('hint')
  })

  it('stays silent for a small context, where reprocessing is free', () => {
    expect(evaluateCacheHint({
      now: NOW,
      lastActiveAt: NOW - CACHE_TTL_MS['1h'] * 10,
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