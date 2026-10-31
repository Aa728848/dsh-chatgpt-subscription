import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SessionCacheStateStore,
  resolveSessionCacheView,
  type KimiCodeSessionCacheRecord,
} from '../src/host/kimi-code/session-cache-state.ts'

const NOW = 1_700_000_000_000

let root: string
let file: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kimi-cache-state-'))
  file = path.join(root, 'storages', 'kimi-cache.json')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function record(overrides: Partial<KimiCodeSessionCacheRecord> = {}): KimiCodeSessionCacheRecord {
  return {
    lastActiveAt: NOW,
    totalTokens: 620_000,
    requests: 3,
    cachedTokens: 600_000,
    freshTokens: 20_000,
    outputTokens: 900,
    cacheWriteTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    updatedAt: NOW,
    ...overrides,
  }
}

describe('SessionCacheStateStore', () => {
  it('round-trips one session through the document', () => {
    const store = new SessionCacheStateStore(file)
    store.write('session-a', record({ lastDrift: 'tools' }))
    store.flush()

    const reopened = new SessionCacheStateStore(file)
    expect(reopened.read('session-a')).toMatchObject({
      lastActiveAt: NOW,
      totalTokens: 620_000,
      requests: 3,
      lastDrift: 'tools',
    })
  })

  it('answers with the most recently active conversation when none is named', () => {
    const store = new SessionCacheStateStore(file)
    store.write('older', record({ updatedAt: NOW - 10_000 }))
    store.write('newer', record({ updatedAt: NOW }))
    store.flush()

    expect(new SessionCacheStateStore(file).read()).toMatchObject({ updatedAt: NOW })
  })

  it('reads a missing or corrupt document as empty instead of throwing', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{ not json', 'utf8')
    const store = new SessionCacheStateStore(file)
    expect(store.read('session-a')).toBeUndefined()
    store.write('session-a', record())
    store.flush()
    expect(new SessionCacheStateStore(file).read('session-a')?.totalTokens).toBe(620_000)
  })

  it('drops the oldest conversations beyond its bound', () => {
    const store = new SessionCacheStateStore(file, 2)
    store.write('first', record({ updatedAt: NOW - 3_000 }))
    store.write('second', record({ updatedAt: NOW - 2_000 }))
    store.write('third', record({ updatedAt: NOW }))
    store.flush()

    const reopened = new SessionCacheStateStore(file, 2)
    expect(reopened.read('first')).toBeUndefined()
    expect(reopened.read('second')).toBeDefined()
    expect(reopened.read('third')).toBeDefined()
  })

  it('keeps a record whose stored fields are malformed from poisoning the file', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      sessions: {
        broken: { totalTokens: 5 },
        healthy: { lastActiveAt: NOW, updatedAt: NOW, totalTokens: 7, requests: 1 },
      },
    }), 'utf8')

    const store = new SessionCacheStateStore(file)
    expect(store.read('broken')).toBeUndefined()
    expect(store.read('healthy')).toMatchObject({ totalTokens: 7 })
  })

  it('round-trips the image budget state', () => {
    // The omissions are STICKY, so they have to survive a restart: a session that
    // forgot them would send a picture again and rebuild the cached prefix on
    // the very next turn.
    const store = new SessionCacheStateStore(file)
    store.write('session-a', record({
      lastDrift: 'image-offload',
      budgetDropped: ['attachment:shot-0', 'inline:abc123'],
      lastRequestImageBytes: 4096,
      lastDroppedImages: 2,
    }))
    store.flush()

    const reopened = new SessionCacheStateStore(file)
    expect(reopened.read('session-a')).toMatchObject({
      lastDrift: 'image-offload',
      budgetDropped: ['attachment:shot-0', 'inline:abc123'],
      lastRequestImageBytes: 4096,
      lastDroppedImages: 2,
    })
  })

  it('drops malformed budget entries instead of poisoning the record', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      sessions: {
        broken: {
          lastActiveAt: NOW,
          updatedAt: NOW,
          totalTokens: 5,
          // Only real identities survive, and only once each.
          budgetDropped: ['', 3, null, 'attachment:a', 'attachment:a'],
          lastRequestImageBytes: -1,
          lastDroppedImages: 'many',
        },
      },
    }), 'utf8')

    const store = new SessionCacheStateStore(file)
    expect(store.read('broken')?.budgetDropped).toEqual(['attachment:a'])
    // A negative byte count and a non-numeric image count are not counts.
    expect(store.read('broken')?.lastRequestImageBytes).toBeUndefined()
    expect(store.read('broken')?.lastDroppedImages).toBeUndefined()
  })

  it('persists and clears warmupConsecutiveHits via noteWarmupStreak without an extra write()', () => {
    const store = new SessionCacheStateStore(file)
    store.write('session-a', record())
    store.noteWarmupStreak('session-a', 2)
    store.flush()

    const reopened = new SessionCacheStateStore(file)
    expect(reopened.read('session-a')?.warmupConsecutiveHits).toBe(2)

    reopened.noteWarmupStreak('session-a', 0)
    reopened.flush()
    expect(new SessionCacheStateStore(file).read('session-a')?.warmupConsecutiveHits).toBeUndefined()
  })
})

describe('resolveSessionCacheView', () => {
  it('prefers the process idle baseline and the durable prompt size for a named session', () => {
    const view = resolveSessionCacheView(
      'session-a',
      { memoryLastActiveAt: NOW, memoryTotalTokens: 1_500_000 },
      record({ totalTokens: 620_000 }),
    )
    expect(view).toEqual({ lastActiveAt: NOW, totalTokens: 620_000 })
  })

  it('falls back to the durable record when the process has served nothing', () => {
    const view = resolveSessionCacheView('session-a', { memoryTotalTokens: 0 }, record())
    expect(view).toEqual({ lastActiveAt: NOW, totalTokens: 620_000 })
  })

  it('ignores process memory entirely when no session is named', () => {
    const view = resolveSessionCacheView(undefined, {
      memoryLastActiveAt: NOW + 5_000,
      memoryTotalTokens: 900_000,
    }, record())
    expect(view).toEqual({ lastActiveAt: NOW, totalTokens: 620_000 })
  })

  it('has nothing to say when neither source knows the conversation', () => {
    expect(resolveSessionCacheView('session-a', { memoryTotalTokens: 0 }, undefined))
      .toEqual({ lastActiveAt: undefined, totalTokens: 0 })
  })
})
