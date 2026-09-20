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
    let polls = 0
    const fetchFn = (async (url: string) => {
      if (String(url).includes('/auth/state')) {
        return new Response(JSON.stringify({ code: 0, data: { state: 's', authUrl: 'https://copilot.tencent.com/login?state=s' } }))
      }
      polls += 1
      return new Response(JSON.stringify({
        code: 0,
        data: {
          accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600,
          uid: 'cn-user', nickname: 'cn', domain: 'copilot.tencent.com',
        },
      }))
    }) as unknown as typeof fetch
    const flow = await beginWebLogin({ addManaged } as any, 'cn', fetchFn)
    expect(flow.status).toBe('pending')
    await vi.advanceTimersByTimeAsync(1_600)
    expect(polls).toBe(1)
    expect(addManaged).toHaveBeenCalledOnce()
    expect(getWebLoginStatus()).toMatchObject({ status: 'complete', accountId: 'cn:cn-user' })
  })
})
