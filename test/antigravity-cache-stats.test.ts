import { beforeEach, describe, expect, it } from 'vitest'
import {
  getCacheStats,
  recordCacheRequest,
  recordCacheUsage,
  resetCacheStats,
  type AntigravityPrefixDriftCause,
} from '../src/host/antigravity/cache-stats.ts'
import { poolRotationStrategy } from '../src/host/antigravity/account-pool.ts'

/**
 * A request body shaped like the one the mapper builds, serialized the way the
 * adapter serializes it. Only the three prefix segments are ever inspected.
 */
function body(
  contents: unknown,
  systemInstruction: unknown = { role: 'user', parts: [{ text: 'fixed' }] },
  tools?: unknown,
): string {
  return JSON.stringify({
    project: 'antigravity-default',
    model: 'gemini-3.8-flash',
    requestType: 'agent',
    request: {
      contents,
      systemInstruction,
      ...(tools === undefined ? {} : { tools }),
    },
  })
}

/** One turn: fingerprint the request, then land the usage it reported. */
function turn(
  sessionId: string | undefined,
  requestBody: string,
  cachedTokens: number,
  freshTokens: number,
  accountId?: string,
): AntigravityPrefixDriftCause {
  const cause = recordCacheRequest(requestBody, sessionId)
  recordCacheUsage({ cachedTokens, freshTokens }, sessionId, accountId)
  return cause
}

const USER_TURN = [{ role: 'user', parts: [{ text: 'hello' }] }]

describe('Antigravity cache statistics', () => {
  beforeEach(() => {
    // Every case starts from a clean process: the maps are module state, so a
    // leftover session would silently satisfy an isolation assertion.
    resetCacheStats()
  })

  describe('per-session totals', () => {
    it('accumulates tokens, request count and hit ratio across a session', () => {
      turn('sess-a', body(USER_TURN), 900, 100)
      turn('sess-a', body(USER_TURN), 0, 1000)

      const stats = getCacheStats('sess-a')
      expect(stats.requests).toBe(2)
      expect(stats.cachedTokens).toBe(900)
      expect(stats.freshTokens).toBe(1100)
      expect(stats.hitRatio).toBeCloseTo(900 / 2000, 10)
    })

    it('reports a null ratio until a request reports usage, and 0 for a fully cold one', () => {
      expect(getCacheStats('cold')).toEqual({ requests: 0, cachedTokens: 0, freshTokens: 0, hitRatio: null })

      turn('cold', body(USER_TURN), 0, 1000)
      // A measured zero is a real reading: every prompt token was reprocessed.
      expect(getCacheStats('cold').hitRatio).toBe(0)
    })

    it('keeps two sessions apart and never lets a cold one drag a warm one down', () => {
      turn('warm', body(USER_TURN), 900, 100)
      turn('cold', body(USER_TURN), 0, 1000)

      expect(getCacheStats('warm').requests).toBe(1)
      expect(getCacheStats('cold').requests).toBe(1)
      expect(getCacheStats('warm').hitRatio).toBeCloseTo(0.9, 10)
      expect(getCacheStats('cold').hitRatio).toBe(0)
      // Merged, the two would read 900 / 2000 = 0.45 and describe neither.
      expect(getCacheStats().requests).toBe(2)
      expect(getCacheStats().hitRatio).toBeCloseTo(900 / 2000, 10)
    })

    it('keeps one session\'s accounts apart, since each keeps its own cache', () => {
      turn('sess', body(USER_TURN), 800, 200, 'account-1')
      turn('sess', body(USER_TURN), 0, 1000, 'account-2')

      expect(getCacheStats('sess', 'account-1').hitRatio).toBeCloseTo(0.8, 10)
      expect(getCacheStats('sess', 'account-2').hitRatio).toBe(0)
      // Unnamed account reads the whole session, which is what a card asks for.
      expect(getCacheStats('sess').requests).toBe(2)
    })

    it('counts a request that names no session in the process total, never in a session', () => {
      turn(undefined, body(USER_TURN), 500, 500)
      turn('sess-a', body(USER_TURN), 100, 100)

      // The unscoped request is in the process aggregate and in no session's
      // totals: a one-shot caller must not be able to inflate, or be mistaken
      // for, a real conversation. (Naming no session to the reader asks for the
      // process aggregate, so the unscoped bucket is only reachable through it —
      // the same shape the sibling line's reader has.)
      expect(getCacheStats().requests).toBe(2)
      expect(getCacheStats('sess-a').requests).toBe(1)
      expect(getCacheStats('sess-a').cachedTokens).toBe(100)
    })

    it('ignores a token count that is not a count', () => {
      recordCacheUsage({ cachedTokens: Number.NaN, freshTokens: 100 }, 'sess-a')
      recordCacheUsage({ cachedTokens: 10, freshTokens: -1 }, 'sess-a')

      // Counting either as a zero would invent a measurement the service never
      // made and drag the ratio toward it.
      expect(getCacheStats('sess-a').requests).toBe(0)
    })
  })

  describe('prefix drift attribution', () => {
    it('reports nothing for a turn that hit the cache', () => {
      // The turn's own prefix change is real, but it cost nothing: everything
      // before it was still cached. Publishing it would put "contents changed"
      // on the card every single turn and never name what actually costs.
      expect(turn('sess-a', body(USER_TURN), 900, 100)).toBe('new-session')
      expect(getCacheStats('sess-a').lastMiss).toBeUndefined()

      expect(turn('sess-a', body(USER_TURN), 900, 100)).toBe('none')
      expect(getCacheStats('sess-a').lastMiss).toBeUndefined()
    })

    it('reports the miss once a turn comes back with nothing cached', () => {
      turn('sess-a', body(USER_TURN), 900, 100)
      // A total miss: cachedContentTokenCount was 0, so the whole prefix was
      // reprocessed. That is the event the card names.
      expect(turn('sess-a', body(USER_TURN), 0, 5000)).toBe('none')

      const miss = getCacheStats('sess-a').lastMiss
      expect(miss?.cause).toBe('none')
      // 'none' beside a real miss is the service-side expiry reading: the client
      // sent a byte-identical prefix and still lost the whole cache.
      expect(typeof miss?.at).toBe('number')
    })

    it('does not report drift when the same request is reserialized with a different key order', () => {
      // Key order is an accident of object assembly, not of meaning: hashing the
      // raw JSON would call this a change and blame the contents.
      recordCacheRequest(JSON.stringify({ request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } }), 'sess-a')
      const reordered = JSON.stringify({ request: { contents: [{ parts: [{ text: 'hi' }], role: 'user' }] } })

      expect(recordCacheRequest(reordered, 'sess-a')).toBe('none')
    })

    it('attributes a changed conversation to contents', () => {
      recordCacheRequest(body(USER_TURN), 'sess-a')
      const next = body([...USER_TURN, { role: 'model', parts: [{ text: 'answer' }] }])

      expect(recordCacheRequest(next, 'sess-a')).toBe('contents')
      // The cause alone is not published — only a miss publishes, and this
      // request has not reported usage yet.
      expect(getCacheStats('sess-a').lastMiss).toBeUndefined()

      recordCacheUsage({ cachedTokens: 0, freshTokens: 4200 }, 'sess-a')
      expect(getCacheStats('sess-a').lastMiss?.cause).toBe('contents')
    })

    it('records how long the client was idle before the miss', () => {
      // The service expires its cache on idle time it does not disclose, so this
      // reading is the only client-side way to see that boundary.
      turn('sess-a', body(USER_TURN), 900, 100)
      const before = Date.now()
      recordCacheRequest(body(USER_TURN), 'sess-a')
      recordCacheUsage({ cachedTokens: 0, freshTokens: 5000 }, 'sess-a')

      const idleMs = getCacheStats('sess-a').lastMiss?.idleMs
      expect(idleMs).toBeGreaterThanOrEqual(0)
      expect(idleMs).toBeLessThanOrEqual(Date.now() - before + 50)
    })

    it('leaves the idle reading off the session\'s very first request', () => {
      // There is no previous request to measure from, and inventing a zero would
      // read as "returned immediately" rather than "nothing to compare".
      recordCacheRequest(body(USER_TURN), 'sess-a')
      recordCacheUsage({ cachedTokens: 0, freshTokens: 5000 }, 'sess-a')

      expect(getCacheStats('sess-a').lastMiss?.idleMs).toBeUndefined()
    })

    it('attributes a changed system instruction to systemInstruction', () => {
      recordCacheRequest(body(USER_TURN, { parts: [{ text: 'fixed' }] }), 'sess-a')

      expect(recordCacheRequest(body(USER_TURN, { parts: [{ text: 'changed' }] }), 'sess-a'))
        .toBe('systemInstruction')
    })

    it('attributes a changed tool list to tools', () => {
      const tools = [{ name: 'run_code', parameters: { type: 'object' } }]
      recordCacheRequest(body(USER_TURN, undefined, tools), 'sess-a')

      expect(recordCacheRequest(body(USER_TURN, undefined, tools), 'sess-a')).toBe('none')
      expect(recordCacheRequest(body(USER_TURN, undefined, [...tools, { name: 'other' }]), 'sess-a'))
        .toBe('tools')
    })

    it('attributes a changed session id inside one scope to session-id', () => {
      recordCacheRequest(body(USER_TURN), 'sess-a')
      // The scope this map groups by trims the trailing space, so both calls
      // land on one session; the value the body carries verbatim does not, and a
      // service keying its cache on that value sees a different namespace.
      expect(recordCacheRequest(body(USER_TURN), 'sess-a ')).toBe('session-id')
    })

    it('treats the first request of a session as a new session, not as drift', () => {
      expect(recordCacheRequest(body(USER_TURN), 'brand-new')).toBe('new-session')
      // A second session's first request is its own first request, even though
      // the process has seen this exact body before.
      recordCacheRequest(body(USER_TURN), 'sess-a')
      expect(recordCacheRequest(body(USER_TURN), 'other-session')).toBe('new-session')
    })

    it('does not carry one session\'s previous prefix into another', () => {
      recordCacheRequest(body(USER_TURN), 'sess-a')

      // The second session sends different contents than its own (nonexistent)
      // previous request would have; if the snapshot were shared this would be
      // reported as a 'contents' drift caused by the first session.
      const cause = recordCacheRequest(body([{ role: 'user', parts: [{ text: 'other' }] }]), 'sess-b')
      expect(cause).toBe('new-session')
    })
  })

  /**
   * The line's own default, asserted beside the cache totals because the two
   * changes are one decision: an account that changes mid conversation is a
   * different cache namespace, so the strategy that keeps the account is what
   * makes the ratio above mean anything.
   */
  describe('rotation strategy default', () => {
    it('defaults to sticky when nothing is stored', () => {
      expect(poolRotationStrategy(undefined)).toBe('sticky')
      expect(poolRotationStrategy(null)).toBe('sticky')
      expect(poolRotationStrategy('nonsense')).toBe('sticky')
    })

    it('leaves an explicitly stored strategy alone, including sequential', () => {
      // A pool file written before the default moved carries an explicit
      // 'sequential'; upgrading must not silently move that user.
      expect(poolRotationStrategy('sequential')).toBe('sequential')
      expect(poolRotationStrategy('round-robin')).toBe('round-robin')
      expect(poolRotationStrategy('sticky')).toBe('sticky')
    })
  })

  describe('resetting', () => {
    it('clears only the named session, including every account under it', () => {
      turn('sess-a', body(USER_TURN), 800, 200, 'account-1')
      turn('sess-a', body(USER_TURN), 100, 100, 'account-2')
      turn('sess-b', body(USER_TURN), 300, 700)

      resetCacheStats('sess-a')

      expect(getCacheStats('sess-a')).toEqual({ requests: 0, cachedTokens: 0, freshTokens: 0, hitRatio: null })
      expect(getCacheStats('sess-a', 'account-1').requests).toBe(0)
      expect(getCacheStats('sess-a', 'account-2').requests).toBe(0)
      // The other session is untouched, and so is the process aggregate for it.
      expect(getCacheStats('sess-b').requests).toBe(1)
      expect(getCacheStats().requests).toBe(1)
    })

    it('drops the named session\'s prefix snapshot too, so its next request starts over', () => {
      recordCacheRequest(body(USER_TURN), 'sess-a')
      recordCacheUsage({ cachedTokens: 0, freshTokens: 100 }, 'sess-a')
      resetCacheStats('sess-a')

      expect(recordCacheRequest(body(USER_TURN), 'sess-a')).toBe('new-session')
      // Reset means the recorded miss is gone as well, not left over from before.
      expect(getCacheStats('sess-a').lastMiss).toBeUndefined()
    })

    it('clears every session when none is named', () => {
      turn('sess-a', body(USER_TURN), 1, 1)
      turn('sess-b', body(USER_TURN), 1, 1)
      resetCacheStats()

      expect(getCacheStats()).toEqual({ requests: 0, cachedTokens: 0, freshTokens: 0, hitRatio: null })
      expect(recordCacheRequest(body(USER_TURN), 'sess-a')).toBe('new-session')
    })
  })
})
