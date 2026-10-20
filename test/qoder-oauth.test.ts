/**
 * Qoder 登录的测试：设备流参数、授权页 URL、轮询状态机、PAT 兑换与刷新。
 *
 * 全程 mock fetch，不碰真实网络与真实凭据。协议常量逐字对照
 * qodercli2api docs/oauth.md §2 与 pi-provider 的实现。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  beginQoderLogin,
  createQoderDeviceParams,
  getQoderLoginStatus,
  pollQoderDeviceToken,
  qoderCredentialsFromPat,
  qoderDeviceAuthorizeUrl,
  refreshQoderCredential,
  resetQoderLogin,
} from '../src/host/qoder/oauth.ts'
import { QODER_DEVICE_CLIENT_ID } from '../src/host/qoder/types.ts'
import type { QoderCredentials } from '../src/host/qoder/token-store.ts'

/** 一条 fetch 脚本：按顺序回答，每次调用记录 url 与 body。 */
function fetchScript(answers: Array<{ status?: number; body?: unknown }>): {
  fetchFn: typeof fetch
  calls: Array<{ url: string; body?: unknown }>
} {
  const calls: Array<{ url: string; body?: unknown }> = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const answer = answers.length > 1 ? answers.shift()! : answers[0]!
    calls.push({
      url: String(input),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    return Response.json(answer.body ?? {}, { status: answer.status ?? 200 })
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

describe('设备流参数与授权页', () => {
  it('PKCE 风格参数的形状（docs/oauth.md §2.1）', () => {
    const params = createQoderDeviceParams({ HOME: '/tmp/qoder-test-none' } as NodeJS.ProcessEnv)
    // verifier 43..128 字符（32 字节 base64url = 43）。
    expect(params.verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/)
    expect(params.challenge).toMatch(/^[A-Za-z0-9\-_]{43}$/)
    expect(params.nonce).toMatch(/^[0-9a-f-]{36}$/)
    expect(params.machineId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('授权页 URL 的参数表逐字（含官方 CLI 的固定 client_id）', () => {
    const url = new URL(qoderDeviceAuthorizeUrl({ challenge: 'c', nonce: 'n', machineId: 'm' }))
    expect(url.origin + url.pathname).toBe('https://qoder.com/device/selectAccounts')
    expect(url.searchParams.get('challenge')).toBe('c')
    expect(url.searchParams.get('challenge_method')).toBe('S256')
    expect(url.searchParams.get('nonce')).toBe('n')
    expect(url.searchParams.get('machine_id')).toBe('m')
    expect(url.searchParams.get('client_id')).toBe(QODER_DEVICE_CLIENT_ID)
  })
})

describe('设备轮询', () => {
  it('404 / 202 = pending；200 缺 token = failed（看形状不只看状态码）', async () => {
    const pending = fetchScript([{ status: 404 }])
    expect((await pollQoderDeviceToken({ nonce: 'n', verifier: 'v' }, { fetchFn: pending.fetchFn })).state).toBe('pending')

    const shapeless = fetchScript([{ status: 200, body: { notoken: true } }])
    const failed = await pollQoderDeviceToken({ nonce: 'n', verifier: 'v' }, { fetchFn: shapeless.fetchFn })
    expect(failed.state).toBe('failed')
  })

  it('200 带 token = ready，字段逐个读出', async () => {
    const { fetchFn } = fetchScript([{
      status: 200,
      body: { token: 'jt-1', user_id: 'u-1', refresh_token: 'jrt-1', expires_in: 86_400_000 },
    }])
    const result = await pollQoderDeviceToken({ nonce: 'n', verifier: 'v' }, { fetchFn })
    expect(result.state).toBe('ready')
    if (result.state === 'ready') {
      expect(result.token).toBe('jt-1')
      expect(result.userId).toBe('u-1')
      expect(result.refreshToken).toBe('jrt-1')
      expect(result.expiresAt).toBeGreaterThan(Date.now())
    }
  })
})

describe('beginQoderLogin 状态机', () => {
  it('CN 没有设备流：直接 error 且不碰网络', async () => {
    const { fetchFn, calls } = fetchScript([])
    const flow = await beginQoderLogin('cn', { fetchFn })
    expect(flow.status).toBe('error')
    expect(flow.retryable).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('全球区：pending → 轮询到 ready → complete，凭据交给 onSave', async () => {
    const { fetchFn } = fetchScript([
      { status: 404 },  // 第一拍 pending
      { status: 200, body: { token: 'jt-1', user_id: 'u-1', refresh_token: 'jrt-1', expires_in: 86_400_000 } },
      { status: 200, body: { id: 'u-1', email: 'me@qoder.com', name: 'Me' } },  // userinfo 补齐
    ])
    const saved: QoderCredentials[] = []
    const flow = await beginQoderLogin('global', {
      fetchFn,
      onSave: async (credential) => { saved.push(credential) },
    })
    expect(flow.status).toBe('pending')
    expect(flow.authorizeUrl).toContain('https://qoder.com/device/selectAccounts')
    await vi.waitFor(() => {
      expect(getQoderLoginStatus().status).toBe('complete')
    }, { timeout: 10_000, interval: 50 })
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({
      accessToken: 'jt-1',
      refreshToken: 'jrt-1',
      region: 'global',
      origin: 'device',
      uid: 'u-1',
      email: 'me@qoder.com',
    })
    resetQoderLogin()
  })
})

describe('PAT 兑换与刷新', () => {
  it('PAT → job token + userinfo；PAT 本体留在凭据里供重兑换', async () => {
    const { fetchFn, calls } = fetchScript([
      { status: 200, body: { token: 'jt-9', refresh_token: 'jrt-9', expires_at: '2027-01-01T00:00:00Z' } },
      { status: 200, body: { id: 'u-9', email: 'cn@qoder.com.cn', name: 'CN User' } },
    ])
    const credentials = await qoderCredentialsFromPat('pt-secret', 'cn', { fetchFn })
    expect(calls[0]!.url).toBe('https://openapi.qoder.com.cn/api/v1/jobToken/exchange')
    expect(calls[0]!.body).toEqual({ personal_token: 'pt-secret' })
    expect(calls[1]!.url).toBe('https://openapi.qoder.com.cn/api/v1/userinfo')
    expect(credentials).toMatchObject({
      accessToken: 'jt-9',
      refreshToken: 'jrt-9',
      region: 'cn',
      origin: 'pat',
      uid: 'u-9',
      personalToken: 'pt-secret',
    })
  })

  it('PAT 来源的刷新 = 拿存下的 PAT 重兑换', async () => {
    const { fetchFn } = fetchScript([
      { status: 200, body: { token: 'jt-new', refresh_token: 'jrt-new' } },
      { status: 200, body: { id: 'u-9' } },
    ])
    const old = await qoderCredentialsFromPat('pt-secret', 'cn', {
      fetchFn: fetchScript([
        { status: 200, body: { token: 'jt-old' } },
        { status: 200, body: { id: 'u-9' } },
      ]).fetchFn,
    })
    const refreshed = await refreshQoderCredential(old, fetchFn)
    expect(refreshed.accessToken).toBe('jt-new')
    expect(refreshed.refreshToken).toBe('jrt-new')
    expect(refreshed.personalToken).toBe('pt-secret')
  })

  it('设备流来源的刷新 = refresh_token 走 center 端点；token 轮换整体替换', async () => {
    const { fetchFn, calls } = fetchScript([
      { status: 200, body: { token: 'jt-2', refresh_token: 'jrt-2', expires_in: 3_600_000 } },
    ])
    const credentials: QoderCredentials = {
      accessToken: 'jt-1',
      refreshToken: 'jrt-1',
      expiresAt: Date.now() - 1000,
      region: 'global',
      origin: 'device',
      uid: 'u-1',
      email: null,
      accountName: null,
      personalToken: null,
      organizationId: null,
      organizationTags: [],
      dataPolicyAgreed: false,
      authenticatedAt: Date.now(),
    }
    const refreshed = await refreshQoderCredential(credentials, fetchFn)
    expect(calls[0]!.url).toBe('https://center.qoder.sh/algo/api/v3/user/refresh_token')
    expect(calls[0]!.body).toEqual({ refreshToken: 'jrt-1' })
    expect(refreshed.accessToken).toBe('jt-2')
    expect(refreshed.refreshToken).toBe('jrt-2')
    expect(refreshed.uid).toBe('u-1')
  })

  it('没有刷新令牌的凭据拒绝刷新（401 语义：只有重新登录能续期）', async () => {
    const credentials: QoderCredentials = {
      accessToken: 'jt-1',
      refreshToken: null,
      expiresAt: Date.now() - 1000,
      region: 'global',
      origin: 'device',
      uid: 'u-1',
      email: null,
      accountName: null,
      personalToken: null,
      organizationId: null,
      organizationTags: [],
      dataPolicyAgreed: false,
      authenticatedAt: Date.now(),
    }
    await expect(refreshQoderCredential(credentials, vi.fn() as never)).rejects.toThrow(/没有刷新令牌/)
  })
})
