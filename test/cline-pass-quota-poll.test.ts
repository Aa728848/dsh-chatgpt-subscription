/**
 * The Cline Pass quota snapshot: who refreshes it, and when.
 *
 * A status read answers the cache and schedules one read behind it; the explicit
 * action reads now. Both go through the same single flight, so the property
 * under test here is not merely "the meters move" but "they never fan out one
 * upstream call per poll". Nothing reaches Cline: the fetch is a double, the
 * pool is in-memory, and the settings file lives in a temp directory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import {
  CLINE_PASS_QUOTA_TTL_MS,
  registerClinePassRoutes,
  type ClinePassRouteOptions,
} from '../src/host/cline-pass/routes.ts'
import { USAGE_LIMITS_PATH } from '../src/host/cline-pass/types.ts'
import { ClinePassAccountPool } from '../src/host/cline-pass/account-pool.ts'
import { createClinePassStore } from '../src/host/cline-pass/store.ts'
import {
  ClinePassModelSettingsStore,
  FileCredentialStore,
  type ClinePassCredentials,
} from '../src/host/cline-pass/token-store.ts'
import { createClinePassEngine } from './cline-pass-test-helpers.ts'
import { clinePassWindowLabel, type ClinePassUsageDto, type ClinePassWebStatus } from '../src/shared/cline-pass-contracts.ts'

interface Captured {
  status: number
  body: { ok: boolean; value?: unknown; error?: unknown }
  raw: string
}

function fakeExchange(): { response: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: { ok: false }, raw: '' }
  const response = {
    writeHead(status: number) {
      captured.status = status
      return response
    },
    end(raw?: string) {
      captured.raw = raw ?? ''
      if (raw !== undefined && raw !== '') captured.body = JSON.parse(raw) as Captured['body']
    },
  } as unknown as ServerResponse
  return { response, captured }
}

function fakeRequest(input: { url: string; method?: string; body?: unknown; origin?: string | null }): IncomingMessage {
  const headers: Record<string, string> = { host: '127.0.0.1:3000' }
  const origin = input.origin === undefined ? 'http://127.0.0.1:3000' : input.origin
  if (origin !== null) headers.origin = origin
  const chunks = input.method === 'POST' && input.body !== undefined ? [Buffer.from(JSON.stringify(input.body))] : []
  return {
    url: input.url,
    method: input.method ?? 'GET',
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
    destroy() {},
  } as unknown as IncomingMessage
}

class MemoryBackend<T> {
  private data: unknown = null
  async load(): Promise<T | null> {
    return this.data === null ? null : JSON.parse(JSON.stringify(this.data)) as T
  }
  async save(data: T): Promise<void> {
    this.data = JSON.parse(JSON.stringify(data))
  }
  async clear(): Promise<void> {
    this.data = null
  }
}

/** One usage-limits answer whose single percent identifies the read that made it. */
function usagePayload(percentUsed: number): unknown {
  return {
    success: true,
    data: { limits: [{ type: 'five_hour', percentUsed, resetsAt: '2026-10-20T10:00:00Z' }] },
  }
}

/** A fetch that records every URL it was asked for, so a fan-out can be counted. */
function countingFetch(answer: () => Promise<Response> | Response) {
  const calls: string[] = []
  const fetchFn = (async (input: RequestInfo | URL) => {
    calls.push(String(input))
    return await answer()
  }) as typeof fetch
  return { fetchFn, calls }
}

/** Let a background refresh that is already resolvable land before asserting. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

const opened: string[] = []

async function harness(options: { quotaTtlMs?: number; fetchFn?: typeof fetch } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cline-pass-quota-'))
  opened.push(dir)
  const credential = new FileCredentialStore(path.join(dir, 'credentials.json'), new MemoryBackend<ClinePassCredentials>() as never)
  const pool = new ClinePassAccountPool({
    store: credential,
    backend: new MemoryBackend() as never,
  })
  const settings = new ClinePassModelSettingsStore(path.join(dir, 'models.json'))
  const store = createClinePassStore()
  const engine = createClinePassEngine({ pool, store, settings })
  const registrations: Array<{ handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }> = []
  const ctx = {
    webServer: {
      register(route: { handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }) {
        registrations.push(route)
        return () => undefined
      },
    },
    emit: vi.fn(),
  } as unknown as Context
  const routeOptions: ClinePassRouteOptions = {
    settings,
    accountPool: pool,
    store,
    engine,
    fetchFn: options.fetchFn ?? ((async () => Response.json({})) as typeof fetch),
    serving: () => true,
    conflict: () => null,
    ...(options.quotaTtlMs === undefined ? {} : { quotaTtlMs: options.quotaTtlMs }),
  }
  const dispose = registerClinePassRoutes(ctx, routeOptions)
  const handler = registrations[0]!.handler
  const call = async (input: { url: string; method?: string; body?: unknown; origin?: string | null }): Promise<Captured> => {
    const { response, captured } = fakeExchange()
    await handler(fakeRequest(input), response)
    return captured
  }
  return { call, pool, store, settings, dispose }
}

let current: Awaited<ReturnType<typeof harness>> | null = null

beforeEach(() => {
  current = null
})

afterEach(async () => {
  current?.dispose()
  vi.useRealTimers()
  for (const dir of opened.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

async function start(options: { quotaTtlMs?: number; fetchFn?: typeof fetch } = {}) {
  current = await harness(options)
  return current
}

describe('Cline Pass quota polling', () => {
  it('reads the quota behind the first status answer', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { fetchFn, calls } = countingFetch(async () => {
      await gate
      return Response.json(usagePayload(42))
    })
    const line = await start({ fetchFn })
    await line.pool.addAccount({ apiKey: 'sk-secret', alias: 'main' }, 'main')

    const captured = await line.call({ url: '/cline-pass/api/status' })
    expect(captured.status).toBe(200)
    const status = captured.body.value as ClinePassWebStatus
    // A cold cache answers with nothing and schedules the read behind it.
    expect(status.usage).toBeNull()
    expect(status.quotaRefreshing).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain(USAGE_LIMITS_PATH)

    release!()
    await settle()
    // The read landed in the snapshot the next poll answers from.
    expect(line.store.usage().accounts[0]).toMatchObject({ alias: 'main', ok: true })
    expect(line.store.usage().accounts[0]?.windows[0]).toMatchObject({ type: 'five_hour', percentUsed: 42 })
    // And the credential it used never travels with the answer.
    expect(captured.raw).not.toContain('sk-secret')
  })

  it('answers a fresh snapshot without reaching upstream again', async () => {
    const { fetchFn, calls } = countingFetch(() => Response.json(usagePayload(7)))
    const line = await start({ fetchFn })
    await line.pool.addAccount({ apiKey: 'sk-a', alias: 'main' }, 'main')
    line.store.setUsage({
      accounts: [{ accountId: 'seed', alias: 'main', ok: true, windows: [], error: '', fetchedAt: Date.now() }],
    })

    const captured = await line.call({ url: '/cline-pass/api/status' })
    const status = captured.body.value as ClinePassWebStatus
    expect(status.usage?.accounts[0]?.alias).toBe('main')
    expect(status.quotaRefreshing).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('refreshes behind an answer once the snapshot aged past the TTL', async () => {
    // Only Date is faked, so the refresh below is still driven by real promises.
    vi.useFakeTimers({ toFake: ['Date'] })
    const now = new Date('2026-10-20T06:00:00Z').getTime()
    vi.setSystemTime(now)
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let reads = 0
    const { fetchFn, calls } = countingFetch(async () => {
      reads += 1
      if (reads > 1) await gate
      return Response.json(usagePayload(reads === 1 ? 10 : 90))
    })
    const line = await start({ fetchFn })
    await line.pool.addAccount({ apiKey: 'sk-a', alias: 'main' }, 'main')
    // Seed the snapshot the way the card's own button does, then let it age.
    const seeded = await line.call({ url: '/cline-pass/api/usage', method: 'POST', body: {} })
    expect((seeded.body.value as { usage: ClinePassUsageDto }).usage.accounts[0]?.windows[0]?.percentUsed).toBe(10)
    vi.setSystemTime(now + CLINE_PASS_QUOTA_TTL_MS + 60_000)

    const captured = await line.call({ url: '/cline-pass/api/status' })
    const status = captured.body.value as ClinePassWebStatus
    // The aged snapshot answered, and the read that replaces it is in flight.
    expect(status.usage?.accounts[0]?.windows[0]?.percentUsed).toBe(10)
    expect(status.quotaRefreshing).toBe(true)

    release!()
    await settle()
    expect(line.store.usage().accounts[0]?.windows[0]?.percentUsed).toBe(90)
    expect(calls).toHaveLength(2)
  })

  it('treats a zero TTL as always stale, so the seam is testable', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const now = new Date('2026-10-20T06:00:00Z').getTime()
    vi.setSystemTime(now)
    const { fetchFn, calls } = countingFetch(() => Response.json(usagePayload(30)))
    const line = await start({ fetchFn, quotaTtlMs: 0 })
    await line.pool.addAccount({ apiKey: 'sk-a', alias: 'main' }, 'main')
    line.store.setUsage({
      accounts: [{ accountId: 'seed', alias: 'main', ok: true, windows: [], error: '', fetchedAt: now }],
    })
    // Same millisecond: still "not older than 0"; a millisecond later is not.
    expect((await line.call({ url: '/cline-pass/api/status' })).body.value).toMatchObject({ quotaRefreshing: false })
    expect(calls).toHaveLength(0)
    vi.setSystemTime(now + 1)
    const captured = await line.call({ url: '/cline-pass/api/status' })
    expect((captured.body.value as ClinePassWebStatus).quotaRefreshing).toBe(true)
    await settle()
  })

  it('joins the running refresh instead of reading again on every poll', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { fetchFn, calls } = countingFetch(async () => {
      await gate
      return Response.json(usagePayload(55))
    })
    const line = await start({ fetchFn })
    await line.pool.addAccount({ apiKey: 'sk-a', alias: 'main' }, 'main')
    await line.pool.addAccount({ apiKey: 'sk-b', alias: 'backup' }, 'backup')

    for (let poll = 0; poll < 3; poll += 1) {
      const captured = await line.call({ url: '/cline-pass/api/status' })
      expect((captured.body.value as ClinePassWebStatus).quotaRefreshing).toBe(true)
    }
    // Two usable accounts, three polls: one fan-out, not one per poll.
    expect(calls).toHaveLength(2)

    release!()
    await settle()
    expect(line.store.usage().accounts).toHaveLength(2)
    expect((await line.call({ url: '/cline-pass/api/status' })).body.value).toMatchObject({ quotaRefreshing: false })
  })

  it('still refreshes immediately for the explicit action', async () => {
    const { fetchFn, calls } = countingFetch(() => Response.json(usagePayload(63)))
    const line = await start({ fetchFn })
    await line.pool.addAccount({ apiKey: 'sk-a', alias: 'main' }, 'main')

    const captured = await line.call({ url: '/cline-pass/api/usage', method: 'POST', body: {} })
    expect(captured.status).toBe(200)
    const value = captured.body.value as { usage: ClinePassUsageDto; status: ClinePassWebStatus }
    // The answer carries the numbers it just read, mapped the way the card reads them.
    expect(value.usage.accounts[0]).toMatchObject({ alias: 'main', ok: true })
    expect(value.usage.accounts[0]?.windows[0]).toMatchObject({
      type: 'five_hour',
      label: clinePassWindowLabel('five_hour'),
      percentUsed: 63,
    })
    // The wait is over by the time it answers, so nothing is left in flight.
    expect(value.status.quotaRefreshing).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('keeps refusing the explicit action when nothing can serve', async () => {
    const { fetchFn, calls } = countingFetch(() => Response.json(usagePayload(1)))
    const line = await start({ fetchFn })

    const captured = await line.call({ url: '/cline-pass/api/usage', method: 'POST', body: {} })
    expect(captured.status).toBe(400)
    expect(captured.body.error).toBe('Every Cline Pass account is disabled, cooling down, or unusable. Enable one first.')
    expect(calls).toHaveLength(0)
  })

  it('keeps the same-origin guard on the explicit action', async () => {
    const { fetchFn, calls } = countingFetch(() => Response.json(usagePayload(1)))
    const line = await start({ fetchFn })
    await line.pool.addAccount({ apiKey: 'sk-a', alias: 'main' }, 'main')

    const captured = await line.call({ url: '/cline-pass/api/usage', method: 'POST', body: {}, origin: 'https://evil.test' })
    expect(captured.status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('records a failed background read instead of failing the status', async () => {
    const { fetchFn } = countingFetch(async () => { throw new Error('offline') })
    const line = await start({ fetchFn })
    await line.pool.addAccount({ apiKey: 'sk-a', alias: 'main' }, 'main')

    const captured = await line.call({ url: '/cline-pass/api/status' })
    expect(captured.status).toBe(200)
    await settle()
    // The refusal is data on the snapshot, not a rejection escaping the refresh.
    expect(line.store.usage().accounts[0]).toMatchObject({ ok: false, error: 'offline' })
  })
})
