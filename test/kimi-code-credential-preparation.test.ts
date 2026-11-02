/**
 * Credential preparation for a Kimi Code model request.
 *
 * The question this file answers is not "does a refresh work" — the OAuth tests
 * answer that — but "how many times does one upstream hiccup cost the
 * service".
 *
 * Two budgets exist and they used to multiply. The provider's own refresh
 * budget is three attempts; the harness's native retry of a model request is
 * `maxRetries: 3`, so four attempts. A refresh that retried INSIDE the
 * request therefore spent twelve POSTs where four were intended.
 *
 * Everything here is offline: the OAuth host and the coding host are stubbed,
 * no test reads a real credential, and no test opens a socket.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  KimiCodeOAuthError,
  KimiCodeRetryableError,
  KimiCodeUnauthorizedError,
  ensureAccessToken,
  refreshAccessToken,
  resetRefreshRejections,
} from '../src/host/kimi-code/oauth.ts'
import { KimiCodeAccountPool, parseKimiCodePoolData } from '../src/host/kimi-code/account-pool.ts'
import {
  KIMI_CODE_RETRY_POLICY_CONFIG,
  KimiCodeAdapter,
  resetColdStartSingleflightForTests,
} from '../src/host/kimi-code/adapter.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  type KimiCodeCatalogModel,
  type KimiCodeCredentials,
} from '../src/host/kimi-code/token-store.ts'
import { PROVIDER_ID } from '../src/host/kimi-code/types.ts'

function tmp(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

function creds(overrides: Partial<KimiCodeCredentials> = {}): KimiCodeCredentials {
  return {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: Date.now() + 3_600_000,
    expiresIn: 3_600,
    region: 'mainland-cn',
    oauthHost: 'https://auth.kimi.com',
    baseUrl: 'https://api.kimi.com/coding',
    ...overrides,
  }
}

/** A credential close enough to expiry that a refresh is unavoidable. */
function expiringCreds(overrides: Partial<KimiCodeCredentials> = {}): KimiCodeCredentials {
  return creds({ expiresAt: Date.now() + 1_000, expiresIn: 3_600, ...overrides })
}

const CATALOG: KimiCodeCatalogModel[] = [
  { id: 'k3', name: 'K3', contextWindow: 262_144 },
]

/** Mirrors the platform backends: JSON in memory, and the parse hook on read. */
class PoolBackend {
  private data: unknown = null
  constructor(private readonly parse: (value: unknown) => unknown) {}
  async load() { return this.data === null ? null : this.parse(JSON.parse(JSON.stringify(this.data))) }
  async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

/** Mirrors the single-credential store's platform backend. */
class CredentialBackend {
  private data: KimiCodeCredentials | null = null
  async load() { return this.data === null ? null : JSON.parse(JSON.stringify(this.data)) }
  async save(data: KimiCodeCredentials) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

/**
 * The response the stubbed OAuth host answers with.
 *
 * A plain object rather than a `Response`: the body is read straight from
 * memory, so the whole retry ladder runs on microtasks and a test that drives
 * a faked clock never waits for a stream.
 */
function oauthResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

/**
 * One stubbed OAuth host, counting the POSTs it received.
 *
 * The signal is honoured the way a real transport honours it, so a cancelled
 * request fails the way it would against the live service rather than
 * succeeding by accident.
 */
function oauthStub(
  answer: () => Response | Promise<Response>,
): { posts: string[]; fetchFn: typeof fetch } {
  const posts: string[] = []
  const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (init?.signal?.aborted) throw init.signal.reason ?? new Error('aborted')
    posts.push(String(url))
    return answer()
  }) as unknown as typeof fetch
  return { posts, fetchFn }
}

/** The OAuth host answering one status, every time. */
function statusStub(status: number, body: unknown = { error: { message: 'slow down' } }): {
  posts: string[]
  fetchFn: typeof fetch
} {
  return oauthStub(() => oauthResponse(status, body))
}

/** The OAuth host whose connection never carries a response. */
function transportStub(failure: unknown): { posts: string[]; fetchFn: typeof fetch } {
  return oauthStub(() => { throw failure })
}

/**
 * Run one operation with the retry backoff collapsed.
 *
 * The backoff is real (1s, then 2s), and a test that paid it four times over
 * would spend half a minute proving arithmetic. The clock is moved instead,
 * so the retry LADDER is still walked — only the waiting is skipped.
 *
 * The clock is moved in small steps, and the event loop is given a real turn
 * between them: the chain schedules its next timer only after the previous
 * await has resolved, so one big jump would land before that timer exists.
 */
async function withFastClock<T>(run: () => Promise<T>): Promise<T> {
  const realSetTimeout = globalThis.setTimeout
  vi.useFakeTimers()
  try {
    let settled = false
    let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined
    const pending = run().then(
      (value) => { outcome = { ok: true, value }; settled = true },
      (error: unknown) => { outcome = { ok: false, error }; settled = true },
    )
    for (let step = 0; step < 1_000 && !settled; step += 1) {
      await new Promise((resolve) => realSetTimeout(resolve, 0))
      if (settled) break
      await vi.advanceTimersByTimeAsync(1_000)
    }
    await pending
    if (outcome === undefined) throw new Error('the operation never settled')
    if (!outcome.ok) throw outcome.error
    return outcome.value
  } finally {
    vi.useRealTimers()
  }
}

/**
 * The code the harness routes on, as the route itself would name it.
 *
 * The adapter's own mapping is not exported, and the control in this file
 * needs to know whether a failure is worth retrying: a refresh that exhausts
 * its budget on a 429 is exactly the RATE_LIMIT the route reports.
 */
function nativeCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string') return code
  if (error instanceof KimiCodeRetryableError) {
    return error.status === 429
      ? 'RATE_LIMIT'
      : error.status !== undefined ? 'SERVER' : 'TRANSPORT'
  }
  return undefined
}

/**
 * The harness's own native retry loop, as the route's policy states it.
 *
 * `maxRetries: 3` means the first attempt plus three retries, and the loop
 * retries exactly the codes the route declares retryable. The last failure is
 * reported rather than thrown: what this file measures is how many requests
 * the loop spent, not how it reports the outcome.
 */
async function nativeRetryLoop(attempt: () => Promise<void>): Promise<number> {
  const { maxRetries, retryableCodes } = KIMI_CODE_RETRY_POLICY_CONFIG
  let attempts = 0
  for (let retry = 0; retry <= maxRetries; retry += 1) {
    attempts += 1
    try {
      await attempt()
      return attempts
    } catch (error) {
      if (retry === maxRetries) return attempts
      const code = nativeCodeOf(error)
      if (code === undefined || !retryableCodes.includes(code)) return attempts
    }
  }
  return attempts
}

function generateOptions(model: string): GenerateOptions {
  return {
    provider: PROVIDER_ID,
    model,
    messages: [{ role: 'user', content: 'hello' } as never],
  }
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) { /* drain */ }
}

/** The adapter a model request runs through, with both transports stubbed. */
function adapterFor(options: { fetchFn: typeof fetch; pool?: KimiCodeAccountPool }) {
  const store = new FileCredentialStore(tmp('kc-prep'))
  vi.spyOn(store, 'read').mockResolvedValue(expiringCreds())
  vi.spyOn(store, 'write').mockResolvedValue(undefined)
  const modelSettings = new FileModelSettingsStore(tmp('kc-prep-models'))
  vi.spyOn(modelSettings, 'read').mockResolvedValue({
    enabled: true,
    enabledModelIds: ['k3'],
    catalogModels: [],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
  })
  const adapter = new KimiCodeAdapter(store, modelSettings, undefined, {
    fetchFn: options.fetchFn,
    loadCatalog: async () => CATALOG,
  }, options.pool)
  return { adapter, store }
}

/** A pool holding one account whose credential is due for a refresh. */
async function poolWithExpiringAccount(): Promise<KimiCodeAccountPool> {
  const mirror = new FileCredentialStore(tmp('kc-prep-mirror'), new CredentialBackend() as never)
  const pool = new KimiCodeAccountPool({
    store: mirror,
    backend: new PoolBackend(parseKimiCodePoolData) as never,
  })
  await pool.addAccount(expiringCreds())
  return pool
}

afterEach(() => {
  resetRefreshRejections()
  resetColdStartSingleflightForTests()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('the refresh attempt budget', () => {
  it('spends the provider default of three attempts when no budget is stated', async () => {
    const oauth = statusStub(429)

    await expect(withFastClock(() => refreshAccessToken('rt-1', {
      fetchFn: oauth.fetchFn,
      region: 'mainland-cn',
    }))).rejects.toBeInstanceOf(KimiCodeRetryableError)

    // Three attempts, matching the official client's max_retries.
    expect(oauth.posts).toHaveLength(3)
  })

  it('spends exactly the budget the caller stated', async () => {
    const once = statusStub(429)
    await expect(refreshAccessToken('rt-1', {
      fetchFn: once.fetchFn,
      region: 'mainland-cn',
      maxAttempts: 1,
    })).rejects.toBeInstanceOf(KimiCodeRetryableError)
    expect(once.posts).toHaveLength(1)

    const twice = statusStub(429)
    await expect(withFastClock(() => refreshAccessToken('rt-1', {
      fetchFn: twice.fetchFn,
      region: 'mainland-cn',
      maxAttempts: 2,
    }))).rejects.toBeInstanceOf(KimiCodeRetryableError)
    expect(twice.posts).toHaveLength(2)
  })

  it('refuses a budget that is not a positive integer', async () => {
    for (const budget of [0, -1, 1.5, Number.NaN]) {
      const oauth = statusStub(429)
      await expect(refreshAccessToken('rt-1', {
        fetchFn: oauth.fetchFn,
        region: 'mainland-cn',
        maxAttempts: budget,
      })).rejects.toBeInstanceOf(RangeError)
      // A refused budget must not be repaired into the default: that would
      // spend requests the caller explicitly refused.
      expect(oauth.posts).toHaveLength(0)
    }
  })

  it('refuses an invalid budget before it touches the store', async () => {
    const store = new FileCredentialStore(tmp('kc-prep-budget'))
    const read = vi.spyOn(store, 'read').mockResolvedValue(expiringCreds())
    const oauth = statusStub(429)

    await expect(ensureAccessToken(store, {
      fetchFn: oauth.fetchFn,
      maxAttempts: 0,
    })).rejects.toBeInstanceOf(RangeError)

    expect(read).not.toHaveBeenCalled()
    expect(oauth.posts).toHaveLength(0)
  })
})

describe('which refresh failures are transient', () => {
  it('retries a 429, a 5xx and a 408', async () => {
    for (const status of [429, 500, 502, 503, 504, 408]) {
      const oauth = statusStub(status)
      await expect(withFastClock(() => refreshAccessToken('rt-1', {
        fetchFn: oauth.fetchFn,
        region: 'mainland-cn',
      }))).rejects.toBeInstanceOf(KimiCodeRetryableError)
      expect(oauth.posts).toHaveLength(3)
    }
  })

  it('retries a transport failure and a timeout', async () => {
    const transport = transportStub(new TypeError('fetch failed'))
    await expect(withFastClock(() => refreshAccessToken('rt-1', {
      fetchFn: transport.fetchFn,
      region: 'mainland-cn',
    }))).rejects.toBeInstanceOf(KimiCodeRetryableError)
    expect(transport.posts).toHaveLength(3)

    const timeout = transportStub(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))
    await expect(withFastClock(() => refreshAccessToken('rt-1', {
      fetchFn: timeout.fetchFn,
      region: 'mainland-cn',
    }))).rejects.toBeInstanceOf(KimiCodeRetryableError)
    expect(timeout.posts).toHaveLength(3)
  })

  it('does not retry a 400 or a 401', async () => {
    const badRequest = statusStub(400, { error: { message: 'malformed request' } })
    const rejected = await refreshAccessToken('rt-1', {
      fetchFn: badRequest.fetchFn,
      region: 'mainland-cn',
    }).catch((error: unknown) => error)
    expect(rejected).toBeInstanceOf(KimiCodeOAuthError)
    expect((rejected as KimiCodeOAuthError).status).toBe(400)
    expect(badRequest.posts).toHaveLength(1)

    const unauthorized = statusStub(401, { error: 'invalid_grant', error_description: 'expired' })
    await expect(refreshAccessToken('rt-1', {
      fetchFn: unauthorized.fetchFn,
      region: 'mainland-cn',
    })).rejects.toBeInstanceOf(KimiCodeUnauthorizedError)
    expect(unauthorized.posts).toHaveLength(1)
  })

  it('does not retry a cancelled request', async () => {
    const oauth = statusStub(429)
    const controller = new AbortController()
    const reason = new Error('cancelled by the caller')
    controller.abort(reason)

    await expect(refreshAccessToken('rt-1', {
      fetchFn: oauth.fetchFn,
      region: 'mainland-cn',
      signal: controller.signal,
    })).rejects.toBe(reason)

    // A cancellation is not a transient failure: it spends no retry budget,
    // and the request never reaches the service at all.
    expect(oauth.posts).toHaveLength(0)
  })
})

describe('what a failed refresh keeps', () => {
  it('keeps the status and the cause of a transient failure', async () => {
    const oauth = statusStub(429)
    const failure = await withFastClock(() => refreshAccessToken('rt-1', {
      fetchFn: oauth.fetchFn,
      region: 'mainland-cn',
    })).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(KimiCodeRetryableError)
    // The status is the one the service answered with, and the cause is the
    // failure that carried it.
    expect((failure as KimiCodeRetryableError).status).toBe(429)
    expect((failure as KimiCodeRetryableError).cause).toBeInstanceOf(KimiCodeRetryableError)
    expect(((failure as KimiCodeRetryableError).cause as KimiCodeRetryableError).status).toBe(429)
  })

  it('keeps the transport cause of a connection failure', async () => {
    const original = new TypeError('fetch failed')
    const oauth = transportStub(original)
    const failure = await withFastClock(() => refreshAccessToken('rt-1', {
      fetchFn: oauth.fetchFn,
      region: 'mainland-cn',
    })).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(KimiCodeRetryableError)
    // A connection failure carries no status, and the cause stays the
    // connection failure itself.
    expect((failure as KimiCodeRetryableError).status).toBeUndefined()
    expect((failure as KimiCodeRetryableError).cause).toBe(original)
  })
})

describe('the model request path', () => {
  it('spends one refresh attempt per preparation on the single-credential path', async () => {
    const oauth = statusStub(429)
    const { adapter } = adapterFor({ fetchFn: oauth.fetchFn })

    const failure = await drain(adapter.stream(generateOptions('k3'))).catch((error: unknown) => error)

    // The harness owns this request's retry budget, so the refresh spends one
    // attempt and lets the failure travel as a retryable route verdict.
    expect(oauth.posts).toHaveLength(1)
    expect((failure as { code?: string }).code).toBe('RATE_LIMIT')
    expect((failure as { failure?: { status?: number } }).failure?.status).toBe(429)
  })

  it('spends one refresh attempt per preparation on the pooled path', async () => {
    const oauth = statusStub(429)
    const pool = await poolWithExpiringAccount()
    const { adapter } = adapterFor({ fetchFn: oauth.fetchFn, pool })

    const failure = await drain(adapter.stream(generateOptions('k3'))).catch((error: unknown) => error)

    expect(oauth.posts).toHaveLength(1)
    expect((failure as { code?: string }).code).toBe('RATE_LIMIT')
  })

  it('keeps the whole native retry budget at four refresh POSTs, not twelve', async () => {
    const oauth = statusStub(429)
    const { adapter, store } = adapterFor({ fetchFn: oauth.fetchFn })

    // The harness's own loop: the first attempt plus three retries.
    const attempts = await nativeRetryLoop(async () => {
      await drain(adapter.stream(generateOptions('k3')))
    })

    expect(attempts).toBe(4)
    // Four native attempts, one refresh POST each.
    expect(oauth.posts).toHaveLength(4)

    // The same loop over the provider's DEFAULT inner budget: three refresh
    // attempts inside each of the four native attempts, which is where the
    // twelve came from.
    const control = statusStub(429)
    const controlAttempts = await withFastClock(() => nativeRetryLoop(async () => {
      await ensureAccessToken(store, { fetchFn: control.fetchFn })
    }))

    expect(controlAttempts).toBe(4)
    expect(control.posts).toHaveLength(12)
  })
})
