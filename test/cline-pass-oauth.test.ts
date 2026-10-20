import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ClinePassLoginManager,
  clineAuthURL,
  isClinePassInvalidGrant,
  refreshClinePassCredentials,
  registerClinePassTokens,
  ClinePassOAuthError,
} from '../src/host/cline-pass/oauth.ts'
import { bearerFor, isOAuthCredentials, parseClinePassCredentials } from '../src/host/cline-pass/token-store.ts'

const NOW = new Date('2026-10-20T06:00:00Z').getTime()

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

describe('Cline Pass WorkOS OAuth', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('runs device authorization, waits for the interval, registers the account', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const calls: string[] = []
    let authenticate = 0
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/user_management/authorize/device')) {
        return json({
          device_code: 'device-1',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://app.cline.bot/device',
          verification_uri_complete: 'https://app.cline.bot/device?code=ABCD-EFGH',
          expires_in: 300,
          interval: 5,
        })
      }
      if (url.endsWith('/user_management/authenticate')) {
        authenticate += 1
        return authenticate === 1
          ? json({ error: 'authorization_pending' }, 400)
          : json({ access_token: 'workos-access', refresh_token: 'workos-refresh', token_type: 'Bearer' })
      }
      if (url.endsWith('/api/v1/auth/register')) {
        return json({
          success: true,
          data: {
            accessToken: 'cline-access',
            refreshToken: 'cline-refresh',
            tokenType: 'Bearer',
            expiresAt: new Date(NOW + 3_600_000).toISOString(),
            userInfo: { email: 'user@example.com', name: 'Cline User', clineUserId: 'user-1' },
          },
        })
      }
      throw new Error('Unexpected request ' + url)
    }) as unknown as typeof fetch

    const added: unknown[] = []
    const manager = new ClinePassLoginManager({
      fetchFn,
      baseURL: () => 'https://api.cline.bot/api/v1',
      onLogin: async (credentials) => { added.push(credentials) },
    })
    const flow = await manager.begin()
    expect(flow.status).toBe('pending')
    expect(flow.userCode).toBe('ABCD-EFGH')
    expect(flow.verificationUri).toContain('ABCD-EFGH')
    expect(authenticate).toBe(0)

    // Before the advertised interval, a status read must not spend a poll.
    expect((await manager.status(flow.id)).status).toBe('pending')
    expect(authenticate).toBe(0)

    vi.setSystemTime(NOW + 5_000)
    expect((await manager.status(flow.id)).status).toBe('pending')
    expect(authenticate).toBe(1)

    vi.setSystemTime(NOW + 10_000)
    const complete = await manager.status(flow.id)
    expect(complete.status).toBe('complete')
    expect(complete.accountAlias).toBe('user@example.com')
    expect(added).toHaveLength(1)
    const credentials = added[0] as {
      kind: string
      access: string
      refresh: string
      email: string
      accountId: string
    }
    expect(credentials).toMatchObject({
      kind: 'oauth',
      access: 'cline-access',
      refresh: 'cline-refresh',
      email: 'user@example.com',
      accountId: 'user-1',
    })
    expect(bearerFor(credentials as never)).toBe('workos:cline-access')
    expect(calls.some((url) => url.endsWith('/api/v1/auth/register'))).toBe(true)
    manager.dispose()
  })

  it('turns denial into a failed flow and never calls the account sink', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/authorize/device')) {
        return json({ device_code: 'd', user_code: 'CODE', verification_uri: 'https://x', expires_in: 300, interval: 5 })
      }
      return json({ error: 'access_denied', error_description: 'User denied' }, 400)
    }) as unknown as typeof fetch
    const onLogin = vi.fn()
    const manager = new ClinePassLoginManager({ fetchFn, baseURL: () => 'https://api.cline.bot/api/v1', onLogin })
    const flow = await manager.begin()
    vi.setSystemTime(NOW + 5_000)
    const result = await manager.status(flow.id)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('User denied')
    expect(onLogin).not.toHaveBeenCalled()
  })

  it('registers and refreshes through the Cline auth endpoints', async () => {
    const bodies: unknown[] = []
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      const url = String(input)
      if (url.endsWith('/auth/register')) {
        return json({
          success: true,
          data: {
            accessToken: 'access-1',
            refreshToken: 'refresh-1',
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            userInfo: { email: 'a@b.c', clineUserId: 'u1' },
          },
        })
      }
      return json({
        success: true,
        data: {
          accessToken: 'access-2',
          refreshToken: 'refresh-2',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          userInfo: { email: 'a@b.c', clineUserId: 'u1' },
        },
      })
    }) as unknown as typeof fetch

    const credentials = await registerClinePassTokens(fetchFn, {
      baseURL: 'https://api.cline.bot/api/v1',
      accessToken: 'workos-access',
      refreshToken: 'workos-refresh',
    })
    expect(credentials).toMatchObject({ access: 'access-1', refresh: 'refresh-1', accountId: 'u1' })
    expect(bodies[0]).toEqual({ accessToken: 'workos-access', refreshToken: 'workos-refresh' })

    const refreshed = await refreshClinePassCredentials(fetchFn, credentials, {
      baseURL: 'https://api.cline.bot/api/v1',
    })
    expect(refreshed).toMatchObject({ access: 'access-2', refresh: 'refresh-2' })
    expect(bodies[1]).toEqual({ refreshToken: 'refresh-1', grantType: 'refresh_token' })
    expect(clineAuthURL('https://api.cline.bot', '/auth/register')).toBe('https://api.cline.bot/api/v1/auth/register')
  })

  it('classifies only a final rejection as an invalid grant', () => {
    expect(isClinePassInvalidGrant(new ClinePassOAuthError('Token refresh failed: 401 - invalid_grant', { status: 401, code: 'invalid_grant' }))).toBe(true)
    expect(isClinePassInvalidGrant(new ClinePassOAuthError('network down'))).toBe(false)
    expect(isClinePassInvalidGrant(new Error('socket hang up'))).toBe(false)
  })

  it('parses both credential generations and carries the bearer prefix', () => {
    const oauth = parseClinePassCredentials({
      access: 'a',
      refresh: 'r',
      expires: NOW + 1000,
      email: 'a@b.c',
      kind: 'oauth',
    })
    expect(isOAuthCredentials(oauth)).toBe(true)
    expect(bearerFor(oauth)).toBe('workos:a')
    const key = parseClinePassCredentials({ apiKey: 'sk-1' })
    expect(isOAuthCredentials(key)).toBe(false)
    expect(bearerFor(key)).toBe('sk-1')
  })
})
