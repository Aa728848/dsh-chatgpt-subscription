/**
 * The MiniMax Code reset-card surface.
 *
 * Every fetch here is MOCKED, and that is not merely good hygiene for this
 * repository: the third of these endpoints spends a real card. A test that
 * reached the service would consume a card the user actually owns, so the whole
 * file runs against an injected `fetchFn` and never touches the network.
 *
 * The fixtures are the real response documents, transcribed verbatim from a live
 * account, so the parse assertions are pinned to the shape the service actually
 * sends rather than to a shape this plugin would have chosen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import {
  MinimaxCodeResetCardError,
  RESET_CARD_FLOW_WINDOW_MS,
  RESET_CARD_FLOWS_PATH,
  RESET_CARD_LIST_PATH,
  RESET_CARD_USE_PATH,
  clearResetCardHost,
  fetchResetCards,
  parseResetCard,
  parseResetCardFlow,
  resetCardHost,
  useResetCard,
} from '../src/host/minimax-code/reset-card.ts'
import {
  MinimaxCodeCredentialStore,
  MinimaxCodeModelSettingsStore,
  type MinimaxCodeCredentials,
} from '../src/host/minimax-code/token-store.ts'
import { registerMinimaxCodeRoutes } from '../src/host/minimax-code/routes.ts'
import { QUOTA_HOST_CANDIDATES } from '../src/host/minimax-code/types.ts'

/** The real `list` answer, transcribed from a live account. */
const LIST_FIXTURE = {
  cards: [
    {
      card_id: '680',
      source_type: 'mcode_signin',
      expire_time: 1792857600000,
      create_time: 1791561814212,
      out_biz_no: '2108588420585517206:1',
    },
  ],
  total: 4,
  base_resp: { status_code: 0, status_msg: 'success' },
}

/** The real `flows` answer, likewise transcribed. */
const FLOWS_FIXTURE = {
  flows: [
    { card_id: '96554', event_type: 'GRANT', create_time: 1791734727341 },
  ],
  total: 4,
  base_resp: { status_code: 0, status_msg: 'success' },
}

function credential(region: 'cn' | 'global' = 'cn'): MinimaxCodeCredentials {
  return {
    accessToken: 'at-reset',
    refreshToken: 'rt-reset',
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

interface Call {
  url: string
  method: string
  body?: unknown
  headers: Record<string, string>
}

/** A fetch double that records every call and answers by pathname. */
function recorder(handlers: Record<string, () => Response>) {
  const calls: Call[] = []
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      url,
      method: init?.method ?? 'GET',
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
      headers: (init?.headers as Record<string, string> | undefined) ?? {},
    })
    const pathname = new URL(url).pathname
    const handler = handlers[pathname]
    if (handler === undefined) throw new Error('unexpected call to ' + url)
    return handler()
  }) as unknown as typeof fetch
  return { calls, fetchFn }
}

/** The default double: both reads answer with the recorded documents. */
function resetCardFetch(overrides: Record<string, () => Response> = {}) {
  return recorder({
    [RESET_CARD_LIST_PATH]: () => Response.json(LIST_FIXTURE),
    [RESET_CARD_FLOWS_PATH]: () => Response.json(FLOWS_FIXTURE),
    [RESET_CARD_USE_PATH]: () => Response.json({ outcome: 'SUCCESS', base_resp: { status_code: 0, status_msg: 'success' } }),
    ...overrides,
  })
}

const NOW = 1_792_000_000_000

describe('MiniMax reset-card reads', () => {
  beforeEach(() => clearResetCardHost())
  afterEach(() => clearResetCardHost())

  it('parses the real list and flows documents into the frozen panel', async () => {
    const { calls, fetchFn } = resetCardFetch()
    const panel = await fetchResetCards(credential(), { fetchFn, nowMs: () => NOW })

    expect(panel.cards).toEqual([
      {
        cardId: '680',
        sourceType: 'mcode_signin',
        expiresAtMs: 1792857600000,
        createdAtMs: 1791561814212,
        outBizNo: '2108588420585517206:1',
      },
    ])
    expect(panel.flows).toEqual([
      { cardId: '96554', eventType: 'GRANT', createdAtMs: 1791734727341 },
    ])
    expect(panel.fetchedAtMs).toBe(NOW)
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      RESET_CARD_LIST_PATH,
      RESET_CARD_FLOWS_PATH,
    ])
    // The credential never leaves this process in a log line or an error; the
    // bearer is the only credential field the route accepts.
    expect(calls[0]!.headers.authorization).toBe('Bearer at-reset')
    expect(calls[0]!.headers.token).toBeUndefined()
    expect(calls[0]!.headers.yy).toBeUndefined()
  })

  it('always sends create_time on the flow read, because the service rejects it without one', async () => {
    // Measured: omitting the parameter answers HTTP 200 with
    // base_resp.status_code 2013 "invalid params", so the window start is part
    // of the request, not an optimisation.
    const { calls, fetchFn } = resetCardFetch()
    await fetchResetCards(credential(), { fetchFn, nowMs: () => NOW })

    const flowUrl = new URL(calls[1]!.url)
    expect(flowUrl.searchParams.get('create_time')).toBe(String(NOW - RESET_CARD_FLOW_WINDOW_MS))
    expect(flowUrl.searchParams.get('page')).toBe('1')
    expect(flowUrl.searchParams.get('size')).toBe('20')
  })

  it('reports a business refusal from base_resp instead of rendering an empty panel', async () => {
    const { fetchFn } = resetCardFetch({
      [RESET_CARD_LIST_PATH]: () => Response.json({
        cards: [],
        base_resp: { status_code: 1004, status_msg: 'unauthorized' },
      }),
    })

    // status_code !== 0 is a REFUSAL that arrives with HTTP 200, so reading it
    // as an empty card list would tell the user their cards are gone.
    await expect(fetchResetCards(credential(), { fetchFn, nowMs: () => NOW }))
      .rejects.toBeInstanceOf(MinimaxCodeResetCardError)
  })

  it('maps the known refusal codes onto the status the browser should see', async () => {
    const refuse = (status_code: number) => resetCardFetch({
      [RESET_CARD_LIST_PATH]: () => Response.json({
        cards: [],
        base_resp: { status_code, status_msg: 'nope' },
      }),
    })
    for (const [code, status] of [[1002, 429], [1004, 401], [2013, 404]] as const) {
      const { fetchFn } = refuse(code)
      const error = await fetchResetCards(credential(), { fetchFn, nowMs: () => NOW }).catch((cause: unknown) => cause)
      expect(error).toBeInstanceOf(MinimaxCodeResetCardError)
      const { resetCardHttpStatus } = await import('../src/host/minimax-code/reset-card.ts')
      expect(resetCardHttpStatus(error)).toBe(status)
    }
  })

  it('degrades the flow read to an empty history and keeps the cards', async () => {
    // The flow is context, the card list is the point: a user whose history read
    // is refused must still see (and be able to press) the card they hold.
    const { fetchFn } = resetCardFetch({
      [RESET_CARD_FLOWS_PATH]: () => Response.json({
        base_resp: { status_code: 2013, status_msg: 'invalid params' },
      }),
    })
    const panel = await fetchResetCards(credential(), { fetchFn, nowMs: () => NOW })
    expect(panel.cards).toHaveLength(1)
    expect(panel.flows).toEqual([])
  })

  it('skips a malformed card instead of blanking the panel', async () => {
    const { fetchFn } = resetCardFetch({
      [RESET_CARD_LIST_PATH]: () => Response.json({
        cards: [
          null,
          { card_id: 'no-key', source_type: 'mcode_signin', expire_time: 1, create_time: 1 },
          { card_id: '700', source_type: 'mcode_signin', expire_time: 'soon', create_time: 1, out_biz_no: 'x:1' },
          LIST_FIXTURE.cards[0],
        ],
        base_resp: { status_code: 0, status_msg: 'success' },
      }),
      [RESET_CARD_FLOWS_PATH]: () => Response.json({
        flows: [
          { card_id: '1', event_type: 'REFUND', create_time: 1 },
          { card_id: '1', event_type: 'USE' },
          null,
        ],
        base_resp: { status_code: 0, status_msg: 'success' },
      }),
    })
    const panel = await fetchResetCards(credential(), { fetchFn, nowMs: () => NOW })
    expect(panel.cards.map((card) => card.cardId)).toEqual(['680'])
    expect(panel.flows).toEqual([])
  })

  it('parses a card and a flow row directly, and refuses a row that is not one', () => {
    expect(parseResetCard(LIST_FIXTURE.cards[0])?.outBizNo).toBe('2108588420585517206:1')
    expect(parseResetCard({ card_id: '1' })).toBeUndefined()
    expect(parseResetCardFlow(FLOWS_FIXTURE.flows[0])).toEqual({
      cardId: '96554',
      eventType: 'GRANT',
      createdAtMs: 1791734727341,
    })
    expect(parseResetCardFlow({ card_id: '1', event_type: 'GRANT' })).toBeUndefined()
  })

  it('falls back to the next host when the first refuses the route', async () => {
    // cn lists two measured candidates, api.minimax.cn first. A 401 on the
    // first says that host does not serve this route, not that the credential is
    // bad, so the second must be tried and the panel still produced.
    const seen: string[] = []
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      seen.push(url.host)
      if (url.host === 'api.minimax.cn') return new Response('unauthorized', { status: 401 })
      if (url.pathname === RESET_CARD_LIST_PATH) return Response.json(LIST_FIXTURE)
      return Response.json(FLOWS_FIXTURE)
    }) as unknown as typeof fetch

    const panel = await fetchResetCards(credential('cn'), { fetchFn, nowMs: () => NOW })
    expect(panel.cards).toHaveLength(1)
    expect(seen[0]).toBe('api.minimax.cn')
    expect(seen).toContain('api.minimaxi.com')
    // And the winner is remembered, so the next read does not re-probe the host
    // that answered 401.
    expect(resetCardHost()).toBe('https://api.minimaxi.com')
    seen.length = 0
    await fetchResetCards(credential('cn'), { fetchFn, nowMs: () => NOW })
    expect(new Set(seen)).toEqual(new Set(['api.minimaxi.com']))
  })

  it('walks every candidate before reporting a total failure', async () => {
    const fetchFn = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    await expect(fetchResetCards(credential('cn'), { fetchFn, nowMs: () => NOW }))
      .rejects.toBeInstanceOf(MinimaxCodeResetCardError)
    expect(fetchFn).toHaveBeenCalledTimes(QUOTA_HOST_CANDIDATES.cn.length)
  })
})

describe('MiniMax reset-card use', () => {
  beforeEach(() => clearResetCardHost())
  afterEach(() => clearResetCardHost())

  it('passes every one of the six outcomes through unchanged', async () => {
    // They are NOT collapsed: REPLAYED / LOCK_BUSY / RETRYABLE_FAIL all mean
    // "possibly spent, confirm with THIS card", which a boolean would erase and
    // turn into "use another card" — really spending another one.
    const outcomes = ['SUCCESS', 'REPLAYED', 'EXPIRED', 'NOT_FOUND', 'RETRYABLE_FAIL', 'LOCK_BUSY'] as const
    for (const outcome of outcomes) {
      clearResetCardHost()
      const { fetchFn } = resetCardFetch({
        [RESET_CARD_USE_PATH]: () => Response.json({ outcome, base_resp: { status_code: 0, status_msg: 'success' } }),
      })
      const result = await useResetCard(
        credential(),
        { sourceType: 'mcode_signin', outBizNo: '2108588420585517206:1' },
        { fetchFn },
      )
      expect(result).toBe(outcome)
    }
  })

  it('sends the card own source_type and out_biz_no verbatim, with no invented request id', async () => {
    // The idempotency key is the card's. A self-minted id is a key the service
    // has never seen, so a second click would really spend a second card.
    const { calls, fetchFn } = resetCardFetch()
    await useResetCard(
      credential(),
      { sourceType: 'mcode_signin', outBizNo: '2108588420585517206:1' },
      { fetchFn },
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('POST')
    expect(new URL(calls[0]!.url).pathname).toBe(RESET_CARD_USE_PATH)
    expect(calls[0]!.body).toEqual({
      source_type: 'mcode_signin',
      out_biz_no: '2108588420585517206:1',
    })
    expect(Object.keys(calls[0]!.body as Record<string, unknown>).sort()).toEqual(['out_biz_no', 'source_type'])
  })

  it('spends the same key on a retry, which is what makes the retry safe', async () => {
    const { calls, fetchFn } = resetCardFetch({
      [RESET_CARD_USE_PATH]: () => Response.json({
        outcome: 'LOCK_BUSY',
        base_resp: { status_code: 0, status_msg: 'success' },
      }),
    })
    const card = { sourceType: 'mcode_signin', outBizNo: '2108588420585517206:1' }
    expect(await useResetCard(credential(), card, { fetchFn })).toBe('LOCK_BUSY')
    expect(await useResetCard(credential(), card, { fetchFn })).toBe('LOCK_BUSY')
    expect(calls.map((call) => (call.body as Record<string, unknown>).out_biz_no)).toEqual([
      '2108588420585517206:1',
      '2108588420585517206:1',
    ])
  })

  it('refuses an answer with no usable outcome rather than calling it a success', async () => {
    const { fetchFn } = resetCardFetch({
      [RESET_CARD_USE_PATH]: () => Response.json({
        outcome: 'DEFINITELY_SPENT',
        base_resp: { status_code: 0, status_msg: 'success' },
      }),
    })
    await expect(useResetCard(credential(), { sourceType: 'mcode_signin', outBizNo: 'x:1' }, { fetchFn }))
      .rejects.toBeInstanceOf(MinimaxCodeResetCardError)
  })

  it('refuses a business refusal from the use call', async () => {
    const { fetchFn } = resetCardFetch({
      [RESET_CARD_USE_PATH]: () => Response.json({
        outcome: 'NOT_FOUND',
        base_resp: { status_code: 1002, status_msg: 'rate limited' },
      }),
    })
    await expect(useResetCard(credential(), { sourceType: 'mcode_signin', outBizNo: 'x:1' }, { fetchFn }))
      .rejects.toBeInstanceOf(MinimaxCodeResetCardError)
  })
})

describe('MiniMax reset-card routes', () => {
  let home = ''
  let restore: Array<[string, string | undefined]> = []

  beforeEach(async () => {
    clearResetCardHost()
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-mm-reset-'))
    for (const key of ['DSH_HOME', 'MINIMAX_HOME']) restore.push([key, process.env[key]])
    process.env.DSH_HOME = home
    process.env.MINIMAX_HOME = path.join(home, 'minimax-native')
  })

  afterEach(async () => {
    clearResetCardHost()
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

  async function harness(fetchFn: typeof fetch) {
    const store = new MinimaxCodeCredentialStore()
    await store.write(credential('cn'))
    const routes: Array<{ path: string; handler: (r: IncomingMessage, s: ServerResponse) => Promise<void> }> = []
    const ctx = {
      webServer: { register(route: { path: string; handler: unknown }) { routes.push(route as never); return () => undefined } },
      logger: { warn() {}, info() {} },
      emit() {},
    } as unknown as Context
    registerMinimaxCodeRoutes(ctx, store, { fetchFn }, new MinimaxCodeModelSettingsStore())
    return routes[0]!.handler
  }

  it('serves the panel on GET', async () => {
    const { fetchFn } = resetCardFetch()
    const handler = await harness(fetchFn)
    const res = exchange()
    await handler(request({ url: '/minimax-code/api/reset-cards' }), res.response)
    expect(res.captured.status).toBe(200)
    expect(res.captured.body.value.cards).toHaveLength(1)
    expect(res.captured.body.value.flows).toHaveLength(1)
  })

  it('spends the card the panel holds, resolving cardId on the host side', async () => {
    const { calls, fetchFn } = resetCardFetch()
    const handler = await harness(fetchFn)
    const res = exchange()
    await handler(
      request({ url: '/minimax-code/api/reset-cards/use', method: 'POST', body: { cardId: '680' } }),
      res.response,
    )
    expect(res.captured.status).toBe(200)
    expect(res.captured.body.value.outcome).toBe('SUCCESS')
    const use = calls.find((call) => new URL(call.url).pathname === RESET_CARD_USE_PATH)
    expect(use!.body).toEqual({
      source_type: 'mcode_signin',
      out_biz_no: '2108588420585517206:1',
    })
  })

  it('never lets the browser name the idempotency key', async () => {
    const { calls, fetchFn } = resetCardFetch()
    const handler = await harness(fetchFn)
    const res = exchange()
    await handler(
      request({
        url: '/minimax-code/api/reset-cards/use',
        method: 'POST',
        // The client tries to spend a card of its own choosing. The host must
        // ignore both fields and spend the one its own panel read.
        body: { cardId: '680', out_biz_no: 'forged:9', source_type: 'forged' },
      }),
      res.response,
    )
    expect(res.captured.status).toBe(200)
    const use = calls.find((call) => new URL(call.url).pathname === RESET_CARD_USE_PATH)
    expect(use!.body).toEqual({
      source_type: 'mcode_signin',
      out_biz_no: '2108588420585517206:1',
    })
  })

  it('refuses a cardId the account does not hold, without calling the use endpoint', async () => {
    const { calls, fetchFn } = resetCardFetch()
    const handler = await harness(fetchFn)
    const res = exchange()
    await handler(
      request({ url: '/minimax-code/api/reset-cards/use', method: 'POST', body: { cardId: 'not-mine' } }),
      res.response,
    )
    expect(res.captured.status).toBe(404)
    expect(calls.some((call) => new URL(call.url).pathname === RESET_CARD_USE_PATH)).toBe(false)
  })

  it('answers a cross-origin POST with a refusal', async () => {
    const { calls, fetchFn } = resetCardFetch()
    const handler = await harness(fetchFn)
    const res = exchange()
    const req = request({ url: '/minimax-code/api/reset-cards/use', method: 'POST', body: { cardId: '680' } })
    ;(req as unknown as { headers: Record<string, string> }).headers.origin = 'http://evil.example'
    await handler(req, res.response)
    expect(res.captured.status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('reports an upstream refusal with the mapped status rather than a bare 500', async () => {
    const { fetchFn } = resetCardFetch({
      [RESET_CARD_LIST_PATH]: () => Response.json({
        cards: [],
        base_resp: { status_code: 1002, status_msg: 'rate limited' },
      }),
    })
    const handler = await harness(fetchFn)
    const res = exchange()
    await handler(request({ url: '/minimax-code/api/reset-cards' }), res.response)
    expect(res.captured.status).toBe(429)
    expect(res.captured.body.ok).toBe(false)
  })
})
