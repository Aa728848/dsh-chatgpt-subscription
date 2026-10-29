import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  beginWebLogin,
  getWebLoginStatus,
  parseLoginCredential,
  requestLoginState,
  resetWebLogin,
} from '../src/host/workbuddy/oauth.ts'

const attempt = {
  state: 'state-1',
  authUrl: 'https://www.workbuddy.ai/login?platform=cli&state=state-1',
  region: 'intl' as const,
  domain: 'www.workbuddy.ai',
}

/** Build an unsigned JWT-shaped token carrying the claims under test. */
function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}.signature`
}

afterEach(() => {
  resetWebLogin()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('WorkBuddy browser authorization', () => {
  it('requests a state from the selected regional gateway', async () => {
    const seen: string[] = []
    const fetchFn = (async (url: string) => {
      seen.push(String(url))
      return new Response(JSON.stringify({ code: 0, data: { state: 's', authUrl: 'https://www.workbuddy.ai/login?state=s' } }))
    }) as unknown as typeof fetch
    const result = await requestLoginState('intl', fetchFn)
    expect(result.state).toBe('s')
    expect(seen[0]).toBe('https://www.workbuddy.ai/v2/plugin/auth/state?platform=cli')
  })

  it('returns null while the browser authorization is pending', () => {
    expect(parseLoginCredential({ code: 11217, msg: 'login ing...' }, attempt)).toBeNull()
  })

  it('parses a completed credential without exposing a desktop source file', () => {
    const credential = parseLoginCredential({
      code: 0,
      data: {
        auth: { accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600, domain: 'www.workbuddy.ai' },
        account: { uid: 'u1', nickname: 'test@example.com', type: 'personal' },
      },
    }, attempt)!
    expect(credential.accessToken).toBe('access')
    expect(credential.region).toBe('intl')
    expect(credential.source).toBe('managed')
    expect(credential.sourceFile).toBe('')
  })

  it('persists the completed credential in the managed store', async () => {
    vi.useFakeTimers()
    const addManaged = vi.fn(async () => undefined)
    const urls: string[] = []
    const fetchFn = (async (url: string) => {
      urls.push(String(url))
      if (String(url).includes('/auth/state')) {
        return new Response(JSON.stringify({ code: 0, data: { state: 's', authUrl: 'https://copilot.tencent.com/login?state=s' } }))
      }
      if (String(url).includes('/v2/plugin/account')) {
        return new Response(JSON.stringify({ code: 0, data: { uid: 'cn-user', nickname: 'cn', uin: '10001' } }))
      }
      return new Response(JSON.stringify({
        code: 0,
        data: {
          accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600,
          domain: 'copilot.tencent.com',
        },
      }))
    }) as unknown as typeof fetch
    const flow = await beginWebLogin({ addManaged } as any, 'cn', fetchFn)
    expect(flow.status).toBe('pending')
    await vi.advanceTimersByTimeAsync(1_600)
    expect(urls.filter((url) => url.includes('/auth/token'))).toHaveLength(1)
    expect(addManaged).toHaveBeenCalledOnce()
    expect(getWebLoginStatus()).toMatchObject({ status: 'complete', accountId: 'cn:cn-user' })
  })

  it('identifies the signed-in account from its token, not its display name', async () => {
    vi.useFakeTimers()
    // The shape a real login returns: a token and a display name, no uid. The
    // file the IDE holds for this same account carries the uuid, so keying on
    // the e-mail would store a second copy of one account.
    const addManaged = vi.fn(async (_credentials: any) => undefined)
    const accessToken = jwt({ sub: '1fb74d2b-3883-43b2-a3a3-417e04e49531', preferred_username: 'cchen2422@gmail.com' })
    const fetchFn = (async (url: string) => {
      if (String(url).includes('/auth/state')) {
        return new Response(JSON.stringify({ code: 0, data: { state: 's', authUrl: 'https://www.workbuddy.ai/login?state=s' } }))
      }
      if (String(url).includes('/v2/plugin/account')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { uid: '1fb74d2b-3883-43b2-a3a3-417e04e49531', nickname: 'cchen2422@gmail.com', uin: '450701882909' },
        }))
      }
      return new Response(JSON.stringify({
        code: 0,
        data: { accessToken, refreshToken: 'refresh', expiresIn: 3600, nickname: 'cchen2422@gmail.com', domain: 'www.workbuddy.ai' },
      }))
    }) as unknown as typeof fetch

    await beginWebLogin({ addManaged } as any, 'intl', fetchFn)
    await vi.advanceTimersByTimeAsync(1_600)

    const saved = addManaged.mock.calls[0]![0] as any
    expect(saved.uid).toBe('1fb74d2b-3883-43b2-a3a3-417e04e49531')
    expect(saved.nickname).toBe('cchen2422@gmail.com')
    // The id must be the same one the IDE's own file produces for this account.
    expect(getWebLoginStatus()).toMatchObject({ status: 'complete', accountId: 'intl:1fb74d2b-3883-43b2-a3a3-417e04e49531' })
  })

  it('keeps the display name as the nickname when the token has no nickname claim', async () => {
    vi.useFakeTimers()
    const addManaged = vi.fn(async (_credentials: any) => undefined)
    const fetchFn = (async (url: string) => {
      if (String(url).includes('/auth/state')) {
        return new Response(JSON.stringify({ code: 0, data: { state: 's', authUrl: 'https://www.workbuddy.ai/login?state=s' } }))
      }
      if (String(url).includes('/v2/plugin/account')) return new Response('', { status: 500 })
      return new Response(JSON.stringify({
        code: 0,
        data: {
          accessToken: jwt({ sub: 'uuid-1' }), refreshToken: 'refresh', expiresIn: 3600,
          nickname: 'Someone', domain: 'www.workbuddy.ai',
        },
      }))
    }) as unknown as typeof fetch

    await beginWebLogin({ addManaged } as any, 'intl', fetchFn)
    await vi.advanceTimersByTimeAsync(1_600)

    // An unreachable account endpoint must not fail the sign-in.
    const saved = addManaged.mock.calls[0]![0] as any
    expect(saved.uid).toBe('uuid-1')
    expect(saved.nickname).toBe('Someone')
    expect(getWebLoginStatus()).toMatchObject({ status: 'complete', accountId: 'intl:uuid-1' })
  })
})
