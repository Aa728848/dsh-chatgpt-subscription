/**
 * The Kimi line's cache-warmup observation.
 *
 * `noteSessionCacheState` already files a durable per-session record at the end
 * of a turn. This file asserts the ONE thing that was added on top of it: the
 * same numbers are handed to the cache-warmup usage registry, once, after that
 * write — and that nothing about the existing record moved (its fields, its
 * order, its early return, the drift warning it already printed).
 *
 * The registry is read back through its own public reader rather than through a
 * spy wherever that is possible, so the assertions describe what a consumer
 * would actually see instead of what a mock was told.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import type { GenerateOptions as HarnessGenerateOptions } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '../src/host/common/llm-compat.ts'
import { KimiCodeAdapter } from '../src/host/kimi-code/adapter.ts'
import { FileCredentialStore, FileModelSettingsStore } from '../src/host/kimi-code/token-store.ts'
import type { KimiCodeCatalogModel, KimiCodeCredentials } from '../src/host/kimi-code/token-store.ts'
import { clearCachedCatalog } from '../src/host/kimi-code/client.ts'
import {
  getCacheStats,
  getLastDriftCause,
  recordDriftCause,
  resetCacheStats,
} from '../src/host/kimi-code/mapper.ts'
import { sessionCacheState } from '../src/host/kimi-code/session-cache-state.ts'
import {
  cacheWarmupUsageReports,
  cacheWarmupUsageSessions,
  resetCacheWarmupForTests,
} from '../src/host/cache-warmup/index.ts'

function tmp(prefix: string): string {
  return path.join(os.tmpdir(), prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json')
}

beforeEach(() => {
  resetCacheStats()
  resetCacheWarmupForTests()
})

afterEach(() => {
  clearCachedCatalog()
  resetCacheStats()
  resetCacheWarmupForTests()
  vi.restoreAllMocks()
})

const CATALOG: KimiCodeCatalogModel[] = [
  { id: 'k3', name: 'K3', contextWindow: 262_144, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high' },
  { id: 'k3.1-pro', name: 'K3.1 Pro', contextWindow: 262_144, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'max' },
]

function credentials(): KimiCodeCredentials {
  return {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    expiresIn: 86_400,
    region: 'mainland-cn',
    oauthHost: 'https://auth.kimi.com',
    baseUrl: 'https://api.kimi.com/coding',
  }
}

/**
 * One finished chat-completions turn whose usage splits cleanly.
 *
 * `prompt_tokens` is the TOTAL input on this wire, so with 300 of it served from
 * the prefix cache the fresh half is 400 - 300 - 0 = 100. Keeping the cache
 * write at 0 means each of the three numbers the observation passes through is
 * a different value, so a swapped field cannot pass unnoticed.
 */
const TURN = [
  { choices: [{ delta: { content: 'hi' } }] },
  {
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 400,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 300, cache_write_tokens: 0 },
    },
  },
]

function sseResponse(frames: unknown[]): Response {
  const bytes = new TextEncoder().encode(frames.map((frame) => 'data: ' + JSON.stringify(frame) + '\n\n').join(''))
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  }))
}

async function buildAdapter(fetchFn: typeof fetch) {
  const store = new FileCredentialStore(tmp('kc-warmup-cred'))
  vi.spyOn(store, 'read').mockResolvedValue(credentials())
  vi.spyOn(store, 'write').mockResolvedValue(undefined)
  const modelSettings = new FileModelSettingsStore(tmp('kc-warmup-models'))
  vi.spyOn(modelSettings, 'read').mockResolvedValue({
    enabled: true,
    enabledModelIds: CATALOG.map((model) => model.id),
    catalogModels: [],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
  })
  return new KimiCodeAdapter(store, modelSettings, undefined, {
    loadCatalog: async () => CATALOG,
    fetchFn,
  })
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function generateOptions(overrides: Record<string, unknown> = {}): HarnessGenerateOptions {
  return {
    model: 'k3.1-pro',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    ...overrides,
  } as unknown as HarnessGenerateOptions
}

/**
 * Watch the durable write without replacing it.
 *
 * The wrapped implementation still calls through, and records how many
 * cache-warmup reports the session had AT THAT MOMENT — which is the only way
 * to tell "the observation ran after the write" from "the observation ran, and
 * so did the write", since both are side effects of the same turn.
 */
function captureDurableWrite() {
  const realWrite = sessionCacheState.write.bind(sessionCacheState)
  const reportsAtWrite: number[] = []
  const writeSpy = vi.spyOn(sessionCacheState, 'write').mockImplementation((sessionId, record) => {
    reportsAtWrite.push(cacheWarmupUsageReports(sessionId).length)
    realWrite(sessionId, record)
  })
  return { writeSpy, reportsAtWrite }
}

describe('the Kimi cache-warmup observation', () => {
  it('files the turn\'s real token split under the same timestamp as the durable record', async () => {
    const session = 'sess-warmup-fields'
    const { writeSpy, reportsAtWrite } = captureDurableWrite()
    const adapter = await buildAdapter((async () => sseResponse(TURN)) as unknown as typeof fetch)

    await drain(adapter.stream(generateOptions({ sessionId: session })))

    const reports = cacheWarmupUsageReports(session)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      sessionId: session,
      // unused prompt, cache hit, output — three distinct numbers, each its own field
      inputTokens: 100,
      cacheReadTokens: 300,
      outputTokens: 10,
      // the registry's hit ratio divides by input+cached, so this sum is load-bearing
      totalTokens: 400,
    })

    // One Date.now() per turn: the observation reuses the durable record's, so a
    // status card and the registry can never disagree about when this happened.
    expect(writeSpy).toHaveBeenCalledTimes(1)
    const record = writeSpy.mock.calls[0]![1]
    expect(reports[0]!.at).toBe(record.lastActiveAt)
    expect(record.updatedAt).toBe(record.lastActiveAt)

    // Reading the registry back changed nothing about the turn's own accounting.
    expect(getCacheStats(session)).toMatchObject({
      requests: 1,
      cachedTokens: 300,
      freshTokens: 100,
      outputTokens: 10,
    })
  })

  it('passes the drift cause through unchanged and still prints the existing warning', async () => {
    const session = 'sess-warmup-drift'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fetchFn = (async () => {
      // Runs after the request was built (and after the mapper recorded its own
      // first-request cause), so this is the cause the turn closes with.
      recordDriftCause('tools', session)
      return sseResponse(TURN)
    }) as unknown as typeof fetch
    const adapter = await buildAdapter(fetchFn)

    await drain(adapter.stream(generateOptions({ sessionId: session })))

    const report = cacheWarmupUsageReports(session)[0]
    expect(report?.driftCause).toBe('tools')
    // Identity, not a re-derivation: whatever the mapper attributed is what the
    // registry stores, unclassified and without triggering any re-warm.
    expect(report?.driftCause).toBe(getLastDriftCause(session))
    expect(warn.mock.calls.some((args) => String(args[0]).includes('prompt cache rebuilt for session ' + session))).toBe(true)
  })

  it('records nothing when the turn has no session id', async () => {
    const { writeSpy, reportsAtWrite } = captureDurableWrite()
    const adapter = await buildAdapter((async () => sseResponse(TURN)) as unknown as typeof fetch)

    // No sessionId on the options, so the stream state has none either: the
    // existing guard returns before either side effect runs.
    await drain(adapter.stream(generateOptions()))

    expect(writeSpy).not.toHaveBeenCalled()
    expect(reportsAtWrite).toEqual([])
    expect(cacheWarmupUsageSessions()).toHaveLength(0)
  })

  it('leaves the durable record byte-identical, and writes it before observing', async () => {
    const session = 'sess-warmup-order'
    const { writeSpy, reportsAtWrite } = captureDurableWrite()
    const adapter = await buildAdapter((async () => sseResponse(TURN)) as unknown as typeof fetch)

    await drain(adapter.stream(generateOptions({ sessionId: session })))

    // The whole record, field for field: the observation added a call, not a
    // change to what was already being filed. `lastDrift` is present because the
    // mapper attributes a cause to EVERY request — this one is a session's first,
    // so it carries 'first-request' rather than a real prefix break.
    expect(writeSpy.mock.calls[0]).toEqual([session, {
      lastActiveAt: expect.any(Number),
      totalTokens: 400,
      requests: 1,
      cachedTokens: 300,
      freshTokens: 100,
      outputTokens: 10,
      cacheWriteTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      lastDrift: 'first-request',
      updatedAt: expect.any(Number),
    }])

    // At the moment of the durable write the registry held nothing for this
    // session, so the single report came after it — the order the invariant asks
    // for (protect the existing path, then observe), never the reverse.
    expect(reportsAtWrite).toEqual([0])
    expect(cacheWarmupUsageReports(session)).toHaveLength(1)
  })
})
