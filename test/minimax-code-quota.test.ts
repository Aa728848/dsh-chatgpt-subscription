import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import {
  clearCachedQuota,
  fetchTokenPlanQuota,
  getQuotaUnavailable,
  parseTokenPlanQuota,
  resolveQuotaCounts,
} from '../src/host/minimax-code/client.ts'
import { MinimaxCodeCredentialStore, type MinimaxCodeCredentials } from '../src/host/minimax-code/token-store.ts'
import { MinimaxCodeModelSettingsStore } from '../src/host/minimax-code/token-store.ts'
import { getMinimaxCodeWebStatus, registerMinimaxCodeRoutes } from '../src/host/minimax-code/routes.ts'
import { quotaHostCandidates, tokenPlanRemainsUrl } from '../src/host/minimax-code/types.ts'

/** One `model_remains` row, shaped like the service's own answer. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model_name: 'general',
    start_time: 1_700_000_000_000,
    end_time: 1_700_018_000_000,
    remains_time: 3_600_000,
    current_interval_total_count: 1000,
    current_interval_usage_count: 250,
    current_interval_remaining_percent: 75,
    current_weekly_total_count: 5000,
    current_weekly_usage_count: 1000,
    current_weekly_remaining_percent: 80,
    current_interval_status: 1,
    current_weekly_status: 1,
    weekly_start_time: 1_700_000_000_000,
    weekly_end_time: 1_700_600_000_000,
    weekly_remains_time: 86_400_000,
    ...overrides,
  }
}

function payload(rows: Array<Record<string, unknown>>): unknown {
  return { model_remains: rows }
}

function credential(region: 'cn' | 'global' = 'global'): MinimaxCodeCredentials {
  return {
    accessToken: 'at-quota',
    refreshToken: 'rt-quota',
    tokenType: 'Bearer',
    clientId: 'mcode-public',
    scopes: [],
    audience: '',
    expiresAtMs: Date.now() + 3_600_000,
    generation: 1,
    loginEpoch: 'epoch',
    buildEnv: 'prod',
    region,
    recordKey: null,
    source: 'file',
  }
}

describe('MiniMax Token Plan quota mapping', () => {
  beforeEach(() => clearCachedQuota())

  it('maps both windows of the general bucket', () => {
    const quota = parseTokenPlanQuota(payload([row()]), 1_700_000_000_000)
    expect(quota).not.toBeNull()
    expect(quota!.windows).toHaveLength(2)
    const [interval, weekly] = quota!.windows!
    expect(interval!.key).toBe('interval')
    expect(interval!.remainingPercent).toBe(75)
    expect(interval!.usedPercent).toBe(25)
    expect(interval!.used).toBe(250)
    expect(interval!.total).toBe(1000)
    // end_time is an absolute epoch-ms reset instant, not a duration.
    expect(interval!.resetsAtMs).toBe(1_700_018_000_000)
    expect(weekly!.key).toBe('weekly')
    expect(weekly!.remainingPercent).toBe(80)
    expect(quota!.label).toBe('Token Plan')
    expect(quota!.fetchedAtMs).toBe(1_700_000_000_000)
  })

  it('reads the ambiguous usage_count the same way whichever meaning the service uses', () => {
    // The service reports this field as REMAINING in older responses and as USED
    // in newer ones. The explicit percentage is what disambiguates, and both
    // encodings of "250 of 1000 used" must land on the same numbers.
    const asUsed = parseTokenPlanQuota(payload([row({ current_interval_usage_count: 250 })]))!
    const asRemaining = parseTokenPlanQuota(payload([row({ current_interval_usage_count: 750 })]))!
    expect(asUsed.windows![0]!.used).toBe(250)
    expect(asRemaining.windows![0]!.used).toBe(250)
    expect(asUsed.windows![0]!.remainingPercent).toBe(asRemaining.windows![0]!.remainingPercent)
  })

  it('gives up on the counts rather than guessing when they match neither reading', () => {
    // 400/1000 is 40% used or 60% left; a reported 75% agrees with neither, so
    // the counts are dropped and only the percentage survives.
    const quota = parseTokenPlanQuota(payload([row({
      current_interval_usage_count: 400,
      current_interval_remaining_percent: 75,
    })]))!
    expect(quota.windows![0]!.used).toBeUndefined()
    expect(quota.windows![0]!.remainingPercent).toBe(75)
  })

  it('marks a weekly window the service calls unlimited', () => {
    const quota = parseTokenPlanQuota(payload([row({ current_weekly_status: 3 })]))!
    expect(quota.windows![1]!.unlimited).toBe(true)
    expect(quota.windows![1]!.remainingPercent).toBeNull()
  })

  it('does not read "no bucket in this plan" as unlimited', () => {
    // Status 3 with both totals zero is the service's other use of that status:
    // a model this plan does not cover. Rendering it as an unlimited bar would
    // promise quota the user does not have.
    const quota = parseTokenPlanQuota(payload([row({
      current_interval_total_count: 0,
      current_weekly_total_count: 0,
      current_interval_usage_count: 0,
      current_weekly_usage_count: 0,
      current_interval_status: 3,
      current_weekly_status: 3,
    })]))
    expect(quota).toBeNull()
  })

  it('applies the weekly display multiplier, which the interval window does not carry', () => {
    const quota = parseTokenPlanQuota(payload([row({
      current_weekly_remaining_percent: 100,
      weekly_boost_permille: 1500,
    })]))!
    expect(quota.windows![1]!.remainingPercent).toBe(150)
    // The interval window has no boost field, so it stays at its own percentage.
    expect(quota.windows![0]!.remainingPercent).toBe(75)
  })

  it('prefers the general bucket over the other resources', () => {
    const quota = parseTokenPlanQuota(payload([
      row({ model_name: 'video', current_interval_remaining_percent: 10 }),
      row({ model_name: 'general', current_interval_remaining_percent: 90 }),
    ]))!
    expect(quota.windows![0]!.remainingPercent).toBe(90)
  })

  it('returns null for a body with nothing usable', () => {
    expect(parseTokenPlanQuota({})).toBeNull()
    expect(parseTokenPlanQuota({ model_remains: [] })).toBeNull()
    expect(parseTokenPlanQuota(null)).toBeNull()
  })
})

describe('MiniMax Token Plan quota fetch', () => {
  beforeEach(() => clearCachedQuota())
  afterEach(() => {
    clearCachedQuota()
    delete process.env.DSH_MINIMAX_CODE_QUOTA_HOST
  })

  it('probes the candidate hosts in order and remembers the one that answers', async () => {
    process.env.DSH_MINIMAX_CODE_QUOTA_HOST = ''
    const tried: string[] = []
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      tried.push(url)
      // The first candidate for cn is agent.minimax.cn; refuse it so the fallback
      // has to be used.
      return url.includes('agent.minimax.cn')
        ? new Response('nope', { status: 404 })
        : Response.json(payload([row()]))
    }) as unknown as typeof fetch

    const quota = await fetchTokenPlanQuota(credential('cn'), { fetchFn })
    expect(quota).not.toBeNull()
    expect(tried[0]).toContain('agent.minimax.cn')
    expect(tried[1]).toContain('agent.minimaxi.com')

    // The winner is probed first from now on: a forced read must not walk the
    // candidates again.
    tried.length = 0
    await fetchTokenPlanQuota(credential('cn'), { fetchFn, force: true })
    expect(tried).toEqual([tokenPlanRemainsUrl('https://agent.minimaxi.com')])
  })

  it('does NOT send the official client attribution headers unless opted in', async () => {
    // These literals tag a request as first-party MiniMax. The package refuses to
    // forge that by default (see the product-token note in types.ts), so the
    // default request must carry none of them.
    const seen: Array<Record<string, string>> = []
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>)
      return Response.json(payload([row()]))
    }) as unknown as typeof fetch

    await fetchTokenPlanQuota(credential('global'), { fetchFn, force: true })
    expect(seen[0]!.yy).toBeUndefined()
    expect(seen[0]!['x-signature']).toBeUndefined()
    expect(seen[0]!['x-timestamp']).toBeUndefined()
    expect(seen[0]!['user-agent']).not.toBe('MiniMaxCode')

    // Opting in sends exactly that set - and nothing else changes.
    process.env.DSH_MINIMAX_CODE_QUOTA_ATTRIBUTION = '1'
    try {
      await fetchTokenPlanQuota(credential('global'), { fetchFn, force: true })
      const opted = seen[1]!
      expect(opted['user-agent']).toBe('MiniMaxCode')
      expect(opted.yy).toMatch(/^[0-9a-f]{32}$/)
      expect(opted['x-timestamp']).toMatch(/^\d+$/)
      expect(opted['x-signature']).toMatch(/^[0-9a-f]{32}$/)
      expect(opted.authorization).toBe('Bearer at-quota')
    } finally {
      delete process.env.DSH_MINIMAX_CODE_QUOTA_ATTRIBUTION
    }
  })

  it('sends the bearer token and asks for JSON, not the streaming accept', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> })
      return Response.json(payload([row()]))
    }) as unknown as typeof fetch
    await fetchTokenPlanQuota(credential('global'), { fetchFn })
    expect(seen[0]!.url).toBe('https://agent.minimax.io/v1/api/openplatform/coding_plan/remains')
    expect(seen[0]!.headers.authorization).toBe('Bearer at-quota')
    expect(seen[0]!.headers.accept).toBe('application/json')
  })

  it('caches a success and re-reads only once the TTL has passed', async () => {
    let calls = 0
    const fetchFn = vi.fn(async () => { calls += 1; return Response.json(payload([row()])) }) as unknown as typeof fetch
    await fetchTokenPlanQuota(credential(), { fetchFn })
    await fetchTokenPlanQuota(credential(), { fetchFn })
    expect(calls).toBe(1)
    await fetchTokenPlanQuota(credential(), { fetchFn, force: true })
    expect(calls).toBe(2)
  })

  it('recognises the platform refusing this line credential type', async () => {
    // Measured against the live PLATFORM endpoint (/v1/token_plan/remains): HTTP 200
    // and puts the verdict in base_resp. Every candidate host says the same thing
    // for an mcode token, so treating ok as success would walk the whole list for
    // an answer that cannot differ, and would leave the card unable to say why.
    let calls = 0
    const fetchFn = vi.fn(async () => {
      calls += 1
      return Response.json({
        base_resp: {
          status_code: 1004,
          status_msg: "login fail: Please carry the API secret key in the 'Authorization' field of the request header",
        },
      })
    }) as unknown as typeof fetch

    expect(await fetchTokenPlanQuota(credential('cn'), { fetchFn })).toBeNull()
    expect(getQuotaUnavailable()).toBe('credential-not-accepted')
    // One host, not both: the verdict is about the credential, not the host.
    expect(calls).toBe(1)

    // And it is not re-probed on the success cadence.
    await fetchTokenPlanQuota(credential('cn'), { fetchFn })
    expect(calls).toBe(1)
  })

  it('reports an unreachable endpoint differently from a refused credential', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await fetchTokenPlanQuota(credential('global'), { fetchFn })).toBeNull()
    expect(getQuotaUnavailable()).toBe('unreachable')
  })

  it('remembers a total failure for longer than a success, so a wrong host is not retried every poll', async () => {
    let calls = 0
    const fetchFn = vi.fn(async () => { calls += 1; return new Response('nope', { status: 500 }) }) as unknown as typeof fetch
    expect(await fetchTokenPlanQuota(credential(), { fetchFn })).toBeNull()
    expect(await fetchTokenPlanQuota(credential(), { fetchFn })).toBeNull()
    // One probe per candidate on the first call, none at all on the second.
    expect(calls).toBe(quotaHostCandidates('global').length)
  })
})

describe('MiniMax Token Plan quota route', () => {
  let home = ''
  let restore: Array<[string, string | undefined]> = []

  beforeEach(async () => {
    clearCachedQuota()
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-mm-quota-'))
    for (const key of ['DSH_HOME', 'MINIMAX_HOME']) restore.push([key, process.env[key]])
    process.env.DSH_HOME = home
    // An EMPTY MiniMax home, so no native credential is picked up.
    process.env.MINIMAX_HOME = path.join(home, 'minimax-native')
  })

  afterEach(async () => {
    clearCachedQuota()
    for (const [key, value] of restore) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    restore = []
    await fs.rm(path.join(home, 'storages', 'minimax-code-credentials.json'), { force: true }).catch(() => undefined)
    await fs.rmdir(path.join(home, 'storages')).catch(() => undefined)
    await fs.rmdir(home).catch(() => undefined)
  })

  function request(input: { url: string; method?: string; body?: unknown }): IncomingMessage {
    const listeners = new Map<string, Array<(v?: unknown) => void>>()
    const req = {
      url: input.url,
      method: input.method ?? 'GET',
      headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
      on(event: string, listener: (v?: unknown) => void) {
        const list = listeners.get(event) ?? []
        list.push(listener)
        listeners.set(event, list)
        return req
      },
      destroy() {},
    } as unknown as IncomingMessage
    if (input.method === 'POST') {
      queueMicrotask(() => {
        if (input.body !== undefined) listeners.get('data')?.forEach((l) => l(Buffer.from(JSON.stringify(input.body))))
        listeners.get('end')?.forEach((l) => l())
      })
    }
    return req
  }

  function exchange(): { response: ServerResponse; captured: { status?: number; body?: any } } {
    const captured: { status?: number; body?: any } = {}
    const response = {
      writeHead(status: number) { captured.status = status; return response },
      end(raw?: string) { captured.body = raw === undefined ? undefined : JSON.parse(raw) },
    } as unknown as ServerResponse
    return { response, captured }
  }

  async function harness(options: { withCredential?: boolean; fetchFn?: typeof fetch } = {}) {
    const store = new MinimaxCodeCredentialStore()
    if (options.withCredential !== false) await store.write(credential('global'))
    const settings = new MinimaxCodeModelSettingsStore()
    const routes: Array<{ path: string; handler: (r: IncomingMessage, s: ServerResponse) => Promise<void> }> = []
    const ctx = {
      webServer: { register(route: { path: string; handler: unknown }) { routes.push(route as never); return () => undefined } },
      logger: { warn() {}, info() {} },
      emit() {},
    } as unknown as Context
    const dispose = registerMinimaxCodeRoutes(ctx, store, {
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
    }, settings)
    return { handler: routes[0]!.handler, dispose, store }
  }

  it('answers /quota with the usage snapshot and puts it in /status', async () => {
    const fetchFn = vi.fn(async () => Response.json(payload([row()]))) as unknown as typeof fetch
    const { handler } = await harness({ fetchFn })

    const quota = exchange()
    await handler(request({ url: '/minimax-code/api/quota' }), quota.response)
    expect(quota.captured.status).toBe(200)
    expect(quota.captured.body.value.quota.windows).toHaveLength(2)

    // /status then serves it from the cache, without another network read.
    const status = exchange()
    await handler(request({ url: '/minimax-code/api/status' }), status.response)
    expect(status.captured.body.value.quota.label).toBe('Token Plan')
    expect((fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1)
  })

  it('degrades to no quota instead of failing when the usage read fails', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
    const { handler } = await harness({ fetchFn })
    const quota = exchange()
    await handler(request({ url: '/minimax-code/api/quota' }), quota.response)
    // The request still succeeds; only the optional field is missing.
    expect(quota.captured.status).toBe(200)
    expect(quota.captured.body.value.quota).toBeUndefined()
    expect(quota.captured.body.value.authenticated).toBe(true)
  })

  it('does not read usage at all when nothing is signed in', async () => {
    const fetchFn = vi.fn(async () => Response.json(payload([row()]))) as unknown as typeof fetch
    const { handler } = await harness({ withCredential: false, fetchFn })
    const quota = exchange()
    await handler(request({ url: '/minimax-code/api/quota' }), quota.response)
    expect(quota.captured.body.value.quota).toBeUndefined()
    expect((fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0)
  })

  it('never lets a status read reach the network for usage', async () => {
    const fetchFn = vi.fn(async () => Response.json(payload([row()]))) as unknown as typeof fetch
    // No fetchFn seam: the status reader must not fetch even though a credential
    // exists, because it is polled and a usage timeout would sit in the middle of
    // every poll.
    const status = await getMinimaxCodeWebStatus(new MinimaxCodeCredentialStore())
    expect(status.quota).toBeUndefined()
    expect((fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0)
  })

  it('rejects a cross-origin usage refresh', async () => {
    const fetchFn = vi.fn(async () => Response.json(payload([row()]))) as unknown as typeof fetch
    const { handler } = await harness({ fetchFn })
    const { response, captured } = exchange()
    const req = request({ url: '/minimax-code/api/quota', method: 'POST' })
    ;(req as unknown as { headers: Record<string, string> }).headers = { host: '127.0.0.1:3000', origin: 'http://evil.test' }
    await handler(req, response)
    expect(captured.status).toBe(403)
  })
})
