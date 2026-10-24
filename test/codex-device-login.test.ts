/**
 * The device-code sign-in: the one ChatGPT sign-in a headless host can finish.
 *
 * The browser flow redirects to a fixed `http://localhost:1455/auth/callback`,
 * which a server cannot serve and an HTTPS page cannot reach, so the only way to
 * add an account there is the device grant. These tests hold the parts that make
 * it safe: the poll cadence, the deadline, cancellation, and the rule that a
 * token answer which is not a credential never becomes an account.
 *
 * Everything runs on a fake clock and a fake fetch — no real network, no real
 * waiting, and the assertions are about requests actually made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OAUTH_DEVICE_TOKEN_URL,
  OAUTH_DEVICE_USERCODE_URL,
  OAUTH_TOKEN_URL,
} from '../src/compat.ts'
import { OAuthService, type OAuthServiceOptions } from '../src/host/oauth-service.ts'
import { MemoryTokenStore } from '../src/host/token-store.ts'
import type { LoginEventDto } from '../src/shared/contracts.ts'

const services: OAuthService[] = []

beforeEach(() => {
  // Only the timers move: `Date.now()` follows them, which is exactly what the
  // poll loop reads for its deadline.
  vi.useFakeTimers()
})

afterEach(() => {
  for (const service of services.splice(0)) service.dispose()
  vi.useRealTimers()
})

/** One queued device-endpoint answer, in the order the service will ask. */
type Reply = { status: number; body: unknown } | ((url: string, body: string) => Response)

function service(options: OAuthServiceOptions = {}): OAuthService {
  const created = new OAuthService(new MemoryTokenStore(), { logger: silentLogger, ...options })
  services.push(created)
  return created
}

/** A fake fetch that answers by URL, counting what was actually asked for. */
function fakeFetch(replies: {
  usercode?: Reply
  device?: Reply[]
  token?: Reply
}): { fetchFn: typeof fetch; calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = []
  const deviceReplies = [...(replies.device ?? [])]
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = String(init?.body ?? '')
    calls.push({ url, body })
    if (url === OAUTH_DEVICE_USERCODE_URL) return answer(replies.usercode ?? usercodeReply())
    if (url === OAUTH_DEVICE_TOKEN_URL) {
      const next = deviceReplies.shift()
      if (next === undefined) throw new Error(`unexpected extra device poll: ${calls.length}`)
      return answer(next)
    }
    if (url === OAUTH_TOKEN_URL) {
      if (replies.token === undefined) throw new Error('unexpected token exchange')
      return answer(replies.token)
    }
    throw new Error(`unexpected url ${url}`)
  }) as typeof fetch
  return { fetchFn, calls }
}

function answer(reply: Reply): Response {
  if (typeof reply === 'function') return reply('', '')
  return Response.json(reply.body, { status: reply.status })
}

function usercodeReply(overrides: Record<string, unknown> = {}): Reply {
  return {
    status: 200,
    body: {
      device_auth_id: 'device-auth-secret',
      user_code: 'ABCD-EFGH',
      interval: '5',
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      ...overrides,
    },
  }
}

const PENDING: Reply = { status: 403, body: { error: { code: 'deviceauth_pending' } } }
const GRANT: Reply = {
  status: 200,
  body: { authorization_code: 'authorization-code-secret', code_verifier: 'code-verifier-secret' },
}
const TOKENS: Reply = {
  status: 200,
  body: {
    access_token: jwt({ email: 'device@example.com', chatgpt_account_id: 'acct-device-9911' }),
    refresh_token: 'refresh-device-secret',
    expires_in: 3600,
  },
}

/** The JSON body of a canned reply, for the stubs that build a `Response` by hand. */
function BODY_OF(reply: Reply): Record<string, unknown> {
  if (typeof reply === 'function') throw new Error('a function reply has no fixed body')
  return reply.body as Record<string, unknown>
}

function polls(calls: Array<{ url: string }>): number {
  return calls.filter((call) => call.url === OAUTH_DEVICE_TOKEN_URL).length
}

describe('device-code sign-in', () => {
  it('walks usercode → pending → pending → grant → token and stores the account', async () => {
    const { fetchFn, calls } = fakeFetch({ device: [PENDING, PENDING, GRANT], token: TOKENS })
    const svc = service({ fetchFn })

    const login = await svc.startDeviceLogin()

    expect(login).toMatchObject({
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://auth.openai.com/codex/device',
    })
    // The usercode request is JSON with the same client id the browser flow uses.
    expect(calls[0]!.url).toBe(OAUTH_DEVICE_USERCODE_URL)
    expect(JSON.parse(calls[0]!.body)).toEqual({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' })
    // The code and grant id never ride on the DTO the card receives.
    expect(JSON.stringify(login)).not.toContain('device-auth-secret')
    expect((await svc.status()).login.device).toEqual({
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://auth.openai.com/codex/device',
      expiresAt: login.expiresAt,
      // The host's own clock, so the card can count `expiresAt - now`.
      now: Math.floor(Date.now() / 1000),
    })

    const terminal = waitForTerminal(svc, login.loginId)
    // One interval per attempt, and nothing asked before the first one elapses.
    await vi.advanceTimersByTimeAsync(4_999)
    expect(polls(calls)).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(polls(calls)).toBe(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(polls(calls)).toBe(2)
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(terminal).resolves.toBe('completed')
    expect(polls(calls)).toBe(3)
    // The poll body carries the grant id and the code, and nothing else.
    const poll = calls.find((call) => call.url === OAUTH_DEVICE_TOKEN_URL)!
    expect(JSON.parse(poll.body)).toEqual({ device_auth_id: 'device-auth-secret', user_code: 'ABCD-EFGH' })

    // The exchange redeems the grant against the device redirect, not the loopback one.
    const exchange = calls.find((call) => call.url === OAUTH_TOKEN_URL)!
    const form = new URLSearchParams(exchange.body)
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code')).toBe('authorization-code-secret')
    expect(form.get('code_verifier')).toBe('code-verifier-secret')
    expect(form.get('redirect_uri')).toBe('https://auth.openai.com/deviceauth/callback')
    expect(form.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann')

    const status = await svc.status()
    expect(status.authenticated).toBe(true)
    expect(status.account).toMatchObject({ email: 'd***@example.com', accountIdSuffix: '…9911' })
    expect(status.login).toMatchObject({ active: false, loginId: null })
    expect(JSON.stringify(status)).not.toContain('refresh-device-secret')
    expect(JSON.stringify(status)).not.toContain('code-verifier-secret')
  })

  it('accepts the usercode alias when the response spells the code that way', async () => {
    const { fetchFn } = fakeFetch({
      usercode: usercodeReply({ user_code: undefined, usercode: 'WXYZ-1234' }),
      device: [GRANT],
      token: TOKENS,
    })
    const svc = service({ fetchFn })

    const login = await svc.startDeviceLogin()

    expect(login.userCode).toBe('WXYZ-1234')
    const terminal = waitForTerminal(svc, login.loginId)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(terminal).resolves.toBe('completed')
  })

  it('treats a failure status as a failure even when its body looks pending', async () => {
    // 401 with a body that says `pending` — the shape that used to be read as
    // "not yet" and retried until the deadline, which hid an invalid user code
    // for fifteen minutes. One poll, one terminal error, nothing else asked.
    const { fetchFn, calls } = fakeFetch({
      device: [{ status: 401, body: { status: 'pending', error: { code: 'invalid_grant' } } }],
      token: TOKENS,
    })
    const svc = service({ fetchFn })

    const login = await svc.startDeviceLogin()
    const terminal = waitForTerminalEvent(svc, login.loginId)
    await vi.advanceTimersByTimeAsync(5_000)

    // Decided on the first answer, not at the deadline: the event is already here.
    const event = await terminal
    expect(event).toMatchObject({ type: 'failed', error: { code: 'oauth-token-exchange-failed' } })
    if (event.type !== 'failed') throw new Error('expected a failed event')
    expect(event.error.message).toBe('The ChatGPT device confirmation was refused (401, invalid_grant).')
    expect(polls(calls)).toBe(1)
    // Nothing waited for the deadline and nothing was exchanged.
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(polls(calls)).toBe(1)
    expect(calls.some((call) => call.url === OAUTH_TOKEN_URL)).toBe(false)
    expect((await svc.status()).authenticated).toBe(false)
  })

  it('turns a refused confirmation into a terminal error naming the status and code', async () => {
    const { fetchFn, calls } = fakeFetch({
      device: [PENDING, { status: 400, body: { error: { code: 'deviceauth_rejected' } } }],
      token: TOKENS,
    })
    const svc = service({ fetchFn })

    const login = await svc.startDeviceLogin()
    const terminal = waitForTerminalEvent(svc, login.loginId)
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(5_000)

    const event = await terminal
    expect(event).toMatchObject({ type: 'failed' })
    if (event.type !== 'failed') throw new Error('expected a failed event')
    expect(event.error.code).toBe('oauth-token-exchange-failed')
    expect(event.error.message).toBe('The ChatGPT device confirmation was refused (400, deviceauth_rejected).')
    // No endless retry, and no token exchange after a refusal.
    expect(polls(calls)).toBe(2)
    expect(calls.some((call) => call.url === OAUTH_TOKEN_URL)).toBe(false)
    expect((await svc.status()).authenticated).toBe(false)
  })

  it('stops at the grant deadline and never polls past it', async () => {
    const svc = service({ fetchFn: fakeFetch({
      usercode: usercodeReply({
        interval: '5',
        expires_at: new Date(Date.now() + 12_000).toISOString(),
      }),
      device: [PENDING, PENDING, PENDING, PENDING],
    }).fetchFn })

    const login = await svc.startDeviceLogin()
    // Seconds on the wire, so the deadline is the grant's to the second.
    expect(login.expiresAt).toBe(Math.floor((Date.now() + 12_000) / 1000))
    const terminal = waitForTerminalEvent(svc, login.loginId)

    // 5 s → poll, 10 s → poll, then the remaining 2 s run out before a third.
    await vi.advanceTimersByTimeAsync(60_000)

    const event = await terminal
    expect(event).toMatchObject({ type: 'failed' })
    if (event.type !== 'failed') throw new Error('expected a failed event')
    expect(event.error.code).toBe('login-expired')
    expect((await svc.status()).login.active).toBe(false)
  })

  it('rejects a grant that arrives at or after the deadline', async () => {
    const { fetchFn, calls } = fakeFetch({
      usercode: usercodeReply({
        interval: '5',
        expires_at: new Date(Date.now() + 5_000).toISOString(),
      }),
      device: [GRANT],
      token: TOKENS,
    })
    const svc = service({ fetchFn })

    const login = await svc.startDeviceLogin()
    const terminal = waitForTerminalEvent(svc, login.loginId)
    await vi.advanceTimersByTimeAsync(5_000)

    const event = await terminal
    expect(event).toMatchObject({ type: 'failed', error: { code: 'login-expired' } })
    // The grant existed but was not redeemed: an expired grant is not a sign-in.
    expect(polls(calls)).toBe(0)
    expect(calls.some((call) => call.url === OAUTH_TOKEN_URL)).toBe(false)
  })

  it('cancels the poll loop and leaves no account behind', async () => {
    const { fetchFn, calls } = fakeFetch({ device: [PENDING, PENDING, GRANT], token: TOKENS })
    const svc = service({ fetchFn })

    const login = await svc.startDeviceLogin()
    const terminal = waitForTerminal(svc, login.loginId)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(polls(calls)).toBe(1)

    svc.cancelLogin(login.loginId)

    await expect(terminal).resolves.toBe('cancelled')
    expect((await svc.status()).login).toMatchObject({ active: false, loginId: null })
    const pollsAfterCancel = polls(calls)
    await vi.advanceTimersByTimeAsync(120_000)
    // Nothing was polled and nothing exchanged after the cancellation.
    expect(polls(calls)).toBe(pollsAfterCancel)
    expect(calls.some((call) => call.url === OAUTH_TOKEN_URL)).toBe(false)
    expect((await svc.status()).authenticated).toBe(false)
  })

  it('fails the login when a 200 answer carries no access token', async () => {
    const { fetchFn } = fakeFetch({
      device: [GRANT],
      // A 200 is not a credential: no access_token, so nothing can be stored.
      token: { status: 200, body: { refresh_token: 'refresh-only-secret', expires_in: 3600 } },
    })
    const svc = service({ fetchFn })

    const login = await svc.startDeviceLogin()
    const terminal = waitForTerminalEvent(svc, login.loginId)
    await vi.advanceTimersByTimeAsync(5_000)

    const event = await terminal
    expect(event).toMatchObject({ type: 'failed', error: { code: 'oauth-token-exchange-failed' } })
    const status = await svc.status()
    expect(status.authenticated).toBe(false)
    expect(status.account).toBeNull()
    expect(JSON.stringify(status)).not.toContain('refresh-only-secret')
  })

  it('falls back to the default interval when the grant states no usable one', async () => {
    // The cadence is the host's business and the DTO no longer carries it, so the
    // default is asserted where it is observable: the first poll.
    const missing = fakeFetch({ usercode: usercodeReply({ interval: undefined }), device: [PENDING] })
    const svc = service({ fetchFn: missing.fetchFn })
    await svc.startDeviceLogin()
    await vi.advanceTimersByTimeAsync(4_999)
    expect(polls(missing.calls)).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(polls(missing.calls)).toBe(1)

    const nonsense = fakeFetch({ usercode: usercodeReply({ interval: 'soon' }), device: [PENDING] })
    const other = service({ fetchFn: nonsense.fetchFn })
    await other.startDeviceLogin()
    await vi.advanceTimersByTimeAsync(4_999)
    expect(polls(nonsense.calls)).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(polls(nonsense.calls)).toBe(1)
  })

  it('floors an absurdly small interval so a grant cannot spin the loop', async () => {
    const { fetchFn, calls } = fakeFetch({
      usercode: usercodeReply({ interval: '0.2' }),
      device: [PENDING, GRANT],
      token: TOKENS,
    })
    const svc = service({ fetchFn })

    const login = await svc.startDeviceLogin()
    const terminal = waitForTerminal(svc, login.loginId)
    await vi.advanceTimersByTimeAsync(999)
    expect(polls(calls)).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(polls(calls)).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(terminal).resolves.toBe('completed')
  })

  it('clamps an interval longer than the grant so the loop cannot outlive the deadline', async () => {
    const { fetchFn, calls } = fakeFetch({
      usercode: usercodeReply({
        interval: '3600',
        expires_at: new Date(Date.now() + 30_000).toISOString(),
      }),
      device: [GRANT],
      token: TOKENS,
    })
    const svc = service({ fetchFn })

    const login = await svc.startDeviceLogin()
    const terminal = waitForTerminalEvent(svc, login.loginId)
    // An hour-long wait is cut to what the grant has left: 30 s, then the expiry.
    await vi.advanceTimersByTimeAsync(29_000)
    expect(polls(calls)).toBe(0)
    await vi.advanceTimersByTimeAsync(1_000)

    const event = await terminal
    expect(event).toMatchObject({ type: 'failed', error: { code: 'login-expired' } })
    expect(polls(calls)).toBe(0)
  })

  it('aborts the confirmation request that is in flight when the sign-in is cancelled', async () => {
    // The token request never answers on its own: the only thing that can settle
    // it is the abort the service is supposed to send. The other stubs in this
    // file resolve immediately and ignore `init.signal`, so dropping the
    // AbortController entirely used to leave them all green.
    let inFlight: AbortSignal | undefined
    let settledBy: string | undefined
    const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const url = String(input)
      if (url === OAUTH_DEVICE_USERCODE_URL) {
        resolve(Response.json(BODY_OF(usercodeReply())))
        return
      }
      if (url === OAUTH_DEVICE_TOKEN_URL) {
        inFlight = init?.signal ?? undefined
        init?.signal?.addEventListener('abort', () => {
          settledBy = 'aborted'
          reject(new Error('This operation was aborted'))
        }, { once: true })
        return
      }
      reject(new Error(`unexpected url ${url}`))
    })) as typeof fetch
    const store = new MemoryTokenStore()
    const svc = new OAuthService(store, { logger: silentLogger, fetchFn })
    services.push(svc)

    const login = await svc.startDeviceLogin()
    const terminal = waitForTerminal(svc, login.loginId)
    await vi.advanceTimersByTimeAsync(5_000)
    // The request is genuinely open: nothing but Cancel can settle it.
    expect(inFlight).toBeDefined()
    expect(inFlight!.aborted).toBe(false)
    expect(settledBy).toBeUndefined()

    svc.cancelLogin(login.loginId)

    await expect(terminal).resolves.toBe('cancelled')
    expect(inFlight!.aborted).toBe(true)
    expect(settledBy).toBe('aborted')
    // The rejection the abort causes is the cancellation, not a second failure.
    expect(await store.load()).toBeNull()
    expect((await svc.status()).authenticated).toBe(false)
  })

  it('lets only one of two overlapping starts through', async () => {
    const { fetchFn, calls } = fakeFetch({ device: [PENDING] })
    const svc = service({ fetchFn })

    // Neither start is awaited before the second begins — that is the double
    // click, and the check that sat before the grant request let both through.
    const first = svc.startDeviceLogin()
    const second = svc.startDeviceLogin()

    await expect(second).rejects.toMatchObject({ code: 'login-active' })
    const login = await first
    // One grant for two clicks, and the flow that does run is still cancellable.
    expect(calls.filter((call) => call.url === OAUTH_DEVICE_USERCODE_URL)).toHaveLength(1)
    await expect(svc.startLogin()).rejects.toMatchObject({ code: 'login-active' })

    svc.cancelLogin(login.loginId)
    await vi.advanceTimersByTimeAsync(5_000)
    expect((await svc.status()).login.active).toBe(false)
  })

  it('cancels between the token answer and the write, and stores nothing', async () => {
    let svc: OAuthService | undefined
    let loginId: string | undefined
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === OAUTH_DEVICE_USERCODE_URL) return Response.json(BODY_OF(usercodeReply()))
      if (url === OAUTH_DEVICE_TOKEN_URL) return Response.json(BODY_OF(GRANT))
      if (url === OAUTH_TOKEN_URL) {
        // The 200 is already in hand here: cancelling inside `json()` lands in
        // exactly the window the old code got wrong — after the token answer,
        // before the write.
        return {
          ok: true,
          status: 200,
          json: async () => {
            svc!.cancelLogin(loginId!)
            return TOKENS.body
          },
        } as unknown as Response
      }
      throw new Error(`unexpected url ${url}`)
    }) as typeof fetch
    const store = new MemoryTokenStore()
    svc = new OAuthService(store, { logger: silentLogger, fetchFn })
    services.push(svc)

    const login = await svc.startDeviceLogin()
    loginId = login.loginId
    const terminal = waitForTerminal(svc, login.loginId)
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(terminal).resolves.toBe('cancelled')
    // The host said "cancelled", so the pool must not have gained an account.
    expect(await store.load()).toBeNull()
    const status = await svc.status()
    expect(status.authenticated).toBe(false)
    expect(status.account).toBeNull()
  })

  it('refuses a second sign-in while one is running, whichever flow started it', async () => {
    const svc = service({ fetchFn: fakeFetch({ device: [PENDING] }).fetchFn })

    const login = await svc.startDeviceLogin()
    await expect(svc.startDeviceLogin()).rejects.toMatchObject({ code: 'login-active' })
    await expect(svc.startLogin()).rejects.toMatchObject({ code: 'login-active' })
    svc.cancelLogin(login.loginId)
    await vi.advanceTimersByTimeAsync(5_000)
  })

  it('never logs the code verifier, the grant id or the user code', async () => {
    const logged: string[] = []
    const { fetchFn } = fakeFetch({ device: [PENDING, GRANT], token: TOKENS })
    const svc = service({
      fetchFn,
      logger: {
        info: (line: string) => logged.push(String(line)),
        warn: (line: string) => logged.push(String(line)),
      },
    })

    const login = await svc.startDeviceLogin()
    const terminal = waitForTerminal(svc, login.loginId)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(terminal).resolves.toBe('completed')

    const all = logged.join('\n')
    expect(all).not.toContain('code-verifier-secret')
    expect(all).not.toContain('device-auth-secret')
    expect(all).not.toContain('ABCD-EFGH')
    expect(all).not.toContain('authorization-code-secret')
  })
})

function waitForTerminal(svc: OAuthService, loginId: string): Promise<string> {
  return waitForTerminalEvent(svc, loginId).then((event) => event.type)
}

function waitForTerminalEvent(svc: OAuthService, loginId: string): Promise<Exclude<LoginEventDto, { type: 'pending' }>> {
  return new Promise((resolve, reject) => {
    const unsubscribe = svc.subscribe(loginId, (event) => {
      if (event.type === 'pending') return
      unsubscribe?.()
      resolve(event)
    })
    if (unsubscribe === null) reject(new Error('login event was not registered'))
  })
}

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.')
}

const silentLogger = { info: () => undefined, warn: () => undefined }
