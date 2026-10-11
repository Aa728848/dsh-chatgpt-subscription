/**
 * W1：GLM（ZCode 账号）登录与兑换链。
 *
 * 全部 mock fetch，不联网、不要任何真实凭据：fixture 里的 token / secret 都是
 * 明显的占位串（at- / bt- / sk- 前缀），没有一个是真值。
 *
 * 断言重点是计划 §3.1 逐条写下的那套**错误语义**——4xx（除 408/429）与信封
 * code !== 0、未知 status 致命；5xx / 网络错误 / 畸形 200 按 pending 重试。
 * 这套语义是逆向实测量化出来的（证据等级 B），改它之前先读 oauth.ts 的头注释。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLI_INIT_RESPONSE_FIELDS,
  GLM_KEY_NAME,
  OAUTH_FLOW_TIMEOUT_MS,
  POLL_MIN_INTERVAL_MS,
} from '../src/host/glm-coding-plan/types.ts'
import {
  GlmLoginFatalError,
  beginWebLogin,
  cancelWebLogin,
  extractAuthorizationCode,
  extractAuthorizationError,
  flowDeadlineMs,
  pollCliFlow,
  pollIntervalMs,
  pollWebLogin,
  requestCliInit,
  resetWebLogins,
  submitLoginCode,
} from '../src/host/glm-coding-plan/oauth.ts'
import {
  CN_EXCHANGE_UNVERIFIED_NOTICE,
  GlmCodingPlanUnavailableError,
  GlmExchangeError,
  exchangeForCodingPlanKey,
  loginBizToken,
} from '../src/host/glm-coding-plan/exchange.ts'
import {
  GlmBizTokenCache,
  refreshJitterSeconds,
  refreshThresholdMs,
  resetInFlightBizTokenFetches,
} from '../src/host/glm-coding-plan/biz-token-cache.ts'

/** 所有 fetch 都用它构造，彻底断开网络。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * 开流响应的 `expires_at`（秒），整个文件共用这一个值。
 *
 * fixture 必须在两次调用之间保持稳定：initBody() 若每次都重算 Date.now()，
 * 「秒 -> 毫秒」的换算断言拿到的就会是另一个秒值，跨过一个整秒边界就差 1000ms。
 * 所以在模块加载时算一次：一次运行内不再漂移，又不像写死常量那样日后会变成「已过期」。
 */
const INIT_EXPIRES_AT_SEC = Math.floor(Date.now() / 1000) + 600

/** 一份合法的开流响应，字段名逐字照 CLI_INIT_RESPONSE_FIELDS。 */
function initBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [CLI_INIT_RESPONSE_FIELDS.flowId]: 'flow-1',
    [CLI_INIT_RESPONSE_FIELDS.authorizeUrl]: 'https://chat.z.ai/authorize?x=1',
    [CLI_INIT_RESPONSE_FIELDS.expiresAt]: INIT_EXPIRES_AT_SEC,
    [CLI_INIT_RESPONSE_FIELDS.pollIntervalSec]: 2,
    ...overrides,
  }
}

/** 一份合法的就绪响应（国际区：provider 键是 zai）。 */
function readyBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'ready',
    token: 'zt-placeholder',
    user: { user_id: 'u-1', email: 'user@example.com', name: 'Tester', avatar: 'https://example.invalid/a.png' },
    zai: { access_token: 'at-placeholder', refresh_token: 'rt-placeholder' },
    ...overrides,
  }
}

interface Routed {
  fetchFn: typeof fetch
  calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }>
}

/** 把一组 URL 路由包成 fetch mock，并记录每次调用的形状。 */
function routedFetch(routes: Array<[RegExp, (init?: RequestInit) => Response]>): Routed {
  const calls: Routed['calls'] = []
  const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url)
    calls.push({
      url: href,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    const route = routes.find(([pattern]) => pattern.test(href))
    if (route === undefined) throw new Error('unexpected request: ' + href)
    return route[1](init)
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

afterEach(() => {
  resetWebLogins()
  resetInFlightBizTokenFetches()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// 开流
// ---------------------------------------------------------------------------

describe('开流请求形状（计划 §3.1）', () => {
  it('POST zcode.z.ai/api/v1/oauth/cli/init，头是 Bearer <32 字节 hex pollToken>', async () => {
    // fixture 取一次并复用：期望值必须来自**同一个**响应体，不能再调一次 initBody()，
    // 否则比对的是两次调用、两个可能不同的秒值。
    const body = initBody()
    const { fetchFn, calls } = routedFetch([[/\/api\/v1\/oauth\/cli\/init$/, () => jsonResponse(body)]])
    const init = await requestCliInit('intl', { fetchFn, env: {} })

    expect(calls[0]!.url).toBe('https://zcode.z.ai/api/v1/oauth/cli/init')
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.headers['authorization']).toMatch(/^Bearer [0-9a-f]{64}$/)
    expect(calls[0]!.headers['content-type']).toBe('application/json')
    // 逐字（cli-oauth.ts:98）：国际区 zai、国区 bigmodel，只有这一个词不同。
    expect(calls[0]!.body).toEqual({ provider: 'zai' })
    expect(init.flowId).toBe('flow-1')
    expect(init.pollIntervalSec).toBe(2)
    // 实现是 expiresAtSec * 1000（oauth.ts:216），不取整、不留容差，两边本就该完全相等，
    // 所以只能 toBe 逐字比。旧的 toBeCloseTo(x, -2) 容差只有 ±50ms，是拿「近似」去比一个
    // 精确值——CI 上正是它把一次分毫不差的换算判成了失败（差 1000ms，来自 fixture 自身漂移）。
    expect(init.expiresAt).toBe((body[CLI_INIT_RESPONSE_FIELDS.expiresAt] as number) * 1000)
    expect(init.pollToken).toMatch(/^[0-9a-f]{64}$/)
  })

  it('expires_at 秒 -> 毫秒是精确换算，不是近似', async () => {
    // 喂一个写死的秒值，把「fixture 恰好没漂移」这个变量彻底排除掉。
    // 换算强度因此钉死：少了乘 1000、多了一次取整或四舍五入，下两行都会红。
    const expiresAtSec = 1_800_000_000
    const { fetchFn } = routedFetch([
      [/\/cli\/init$/, () => jsonResponse(initBody({ [CLI_INIT_RESPONSE_FIELDS.expiresAt]: expiresAtSec }))],
    ])
    const init = await requestCliInit('intl', { fetchFn, env: {} })

    expect(init.expiresAt).toBe(expiresAtSec * 1000)
    // 漏乘 1000（把秒当毫秒用）时这里会红。
    expect(init.expiresAt).not.toBe(expiresAtSec)
  })

  it('国区把 provider 翻成 bigmodel，其余请求形状不变', async () => {
    const { fetchFn, calls } = routedFetch([[/\/api\/v1\/oauth\/cli\/init$/, () => jsonResponse(initBody())]])
    await requestCliInit('cn', { fetchFn, env: {} })
    expect(calls[0]!.body).toEqual({ provider: 'bigmodel' })
  })

  it('DSH_GLM_OAUTH_API_BASE 覆盖开流地址', async () => {
    const { fetchFn, calls } = routedFetch([[/\/cli\/init$/, () => jsonResponse(initBody())]])
    await requestCliInit('intl', { fetchFn, env: { DSH_GLM_OAUTH_API_BASE: 'https://proxy.invalid/api/v2' } })
    expect(calls[0]!.url).toBe('https://proxy.invalid/api/v2/oauth/cli/init')
  })

  it('开流非 2xx 是致命失败', async () => {
    const { fetchFn } = routedFetch([[/\/cli\/init$/, () => jsonResponse({ msg: 'bad' }, 500)]])
    await expect(requestCliInit('intl', { fetchFn, env: {} })).rejects.toBeInstanceOf(GlmLoginFatalError)
  })
})

// ---------------------------------------------------------------------------
// 开流响应校验
// ---------------------------------------------------------------------------

describe('开流响应校验（四个字段缺一不可）', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['flow_id', { [CLI_INIT_RESPONSE_FIELDS.flowId]: undefined }],
    ['authorize_url', { [CLI_INIT_RESPONSE_FIELDS.authorizeUrl]: '' }],
    ['expires_at', { [CLI_INIT_RESPONSE_FIELDS.expiresAt]: 'soon' }],
    ['poll_interval_sec', { [CLI_INIT_RESPONSE_FIELDS.pollIntervalSec]: null }],
  ]
  for (const [field, override] of cases) {
    it('缺少 ' + field + ' 时拒绝开流', async () => {
      const body = initBody()
      for (const [key, value] of Object.entries(override)) {
        if (value === undefined) delete body[key]
        else body[key] = value
      }
      const { fetchFn } = routedFetch([[/\/cli\/init$/, () => jsonResponse(body)]])
      await expect(requestCliInit('intl', { fetchFn, env: {} })).rejects.toThrow(field)
    })
  }

  it('poll_interval_sec 走 1 秒下限（max(POLL_MIN_INTERVAL_MS, sec*1000)）', () => {
    expect(pollIntervalMs(0)).toBe(POLL_MIN_INTERVAL_MS)
    expect(pollIntervalMs(2)).toBe(2_000)
    expect(pollIntervalMs(-5)).toBe(POLL_MIN_INTERVAL_MS)
  })

  it('信封包裹的 {code:0,data:{...}} 也能解析', async () => {
    const { fetchFn } = routedFetch([[/\/cli\/init$/, () => jsonResponse({ code: 0, data: initBody() })]])
    const init = await requestCliInit('intl', { fetchFn, env: {} })
    expect(init.flowId).toBe('flow-1')
  })
})

// ---------------------------------------------------------------------------
// 轮询错误语义（计划 §3.1，证据等级 B：照抄，不得自行放宽或收紧）
// ---------------------------------------------------------------------------

describe('轮询错误语义', () => {
  const flow = { flowId: 'flow-1', pollToken: 'pt-1', region: 'intl' } as const

  it('GET .../oauth/cli/poll/{flow_id}，同一个 Bearer pollToken', async () => {
    const { fetchFn, calls } = routedFetch([[/\/oauth\/cli\/poll\/flow-1$/, () => jsonResponse({ status: 'pending' })]])
    await pollCliFlow(flow, { fetchFn, env: {} })
    expect(calls[0]!.url).toBe('https://zcode.z.ai/api/v1/oauth/cli/poll/flow-1')
    expect(calls[0]!.method).toBe('GET')
    expect(calls[0]!.headers['authorization']).toBe('Bearer pt-1')
  })

  it('status=pending 按 pending 重试', async () => {
    const { fetchFn } = routedFetch([[/\/poll\//, () => jsonResponse({ status: 'pending' })]])
    expect((await pollCliFlow(flow, { fetchFn, env: {} })).kind).toBe('pending')
  })

  it('status=ready 取出 access_token 与 user', async () => {
    const { fetchFn } = routedFetch([[/\/poll\//, () => jsonResponse(readyBody())]])
    const outcome = await pollCliFlow(flow, { fetchFn, env: {} })
    expect(outcome.kind).toBe('ready')
    if (outcome.kind !== 'ready') throw new Error('unreachable')
    expect(outcome.credentials.accessToken).toBe('at-placeholder')
    expect(outcome.credentials.refreshToken).toBe('rt-placeholder')
    expect(outcome.credentials.email).toBe('user@example.com')
    expect(outcome.credentials.userId).toBe('u-1')
    expect(outcome.credentials.region).toBe('intl')
  })

  it('国区从 bigmodel 键取 access_token', async () => {
    const { fetchFn } = routedFetch([[/\/poll\//, () => jsonResponse(readyBody({
      zai: undefined,
      bigmodel: { access_token: 'at-cn-placeholder' },
    }))]])
    const outcome = await pollCliFlow({ ...flow, region: 'cn' }, { fetchFn, env: {} })
    expect(outcome.kind).toBe('ready')
    if (outcome.kind !== 'ready') throw new Error('unreachable')
    expect(outcome.credentials.accessToken).toBe('at-cn-placeholder')
  })

  it('信封包裹的就绪载荷同样解析', async () => {
    const { fetchFn } = routedFetch([[/\/poll\//, () => jsonResponse({ code: 0, data: readyBody() })]])
    expect((await pollCliFlow(flow, { fetchFn, env: {} })).kind).toBe('ready')
  })

  it('4xx（除 408/429）一律致命', async () => {
    for (const status of [400, 401, 403, 404]) {
      const { fetchFn } = routedFetch([[/\/poll\//, () => jsonResponse({ msg: 'no' }, status)]])
      await expect(pollCliFlow(flow, { fetchFn, env: {} })).rejects.toBeInstanceOf(GlmLoginFatalError)
    }
  })

  it('408 与 429 按 pending 重试（上游自己在限流 / 处理超时）', async () => {
    for (const status of [408, 429]) {
      const { fetchFn } = routedFetch([[/\/poll\//, () => jsonResponse({ msg: 'slow down' }, status)]])
      expect((await pollCliFlow(flow, { fetchFn, env: {} })).kind).toBe('pending')
    }
  })

  it('5xx 按 pending 重试', async () => {
    for (const status of [500, 502, 503]) {
      const { fetchFn } = routedFetch([[/\/poll\//, () => jsonResponse({}, status)]])
      expect((await pollCliFlow(flow, { fetchFn, env: {} })).kind).toBe('pending')
    }
  })

  it('网络错误按 pending 重试', async () => {
    const { fetchFn } = routedFetch([[/\/poll\//, () => { throw new TypeError('fetch failed') }]])
    expect((await pollCliFlow(flow, { fetchFn, env: {} })).kind).toBe('pending')
  })

  it('畸形 200（非 JSON / 非对象 / ready 缺 access_token）按 pending 重试', async () => {
    const notJson = routedFetch([[/\/poll\//, () => new Response('<html>502</html>', { status: 200 })]])
    expect((await pollCliFlow(flow, { fetchFn: notJson.fetchFn, env: {} })).kind).toBe('pending')

    const notObject = routedFetch([[/\/poll\//, () => jsonResponse([1, 2, 3])]])
    expect((await pollCliFlow(flow, { fetchFn: notObject.fetchFn, env: {} })).kind).toBe('pending')

    const missingToken = routedFetch([[/\/poll\//, () => jsonResponse(readyBody({ zai: { refresh_token: 'rt' } }))]])
    expect((await pollCliFlow(flow, { fetchFn: missingToken.fetchFn, env: {} })).kind).toBe('pending')
  })

  it('信封 code !== 0 致命（哪怕 HTTP 是 200）', async () => {
    const { fetchFn } = routedFetch([[/\/poll\//, () => jsonResponse({ code: 1003, msg: 'expired' })]])
    await expect(pollCliFlow(flow, { fetchFn, env: {} })).rejects.toThrow('1003')
  })

  it('未知 status 致命', async () => {
    const unknown = routedFetch([[/\/poll\//, () => jsonResponse({ status: 'half-done' })]])
    await expect(pollCliFlow(flow, { fetchFn: unknown.fetchFn, env: {} })).rejects.toBeInstanceOf(GlmLoginFatalError)

    const missing = routedFetch([[/\/poll\//, () => jsonResponse({ token: 'x' })]])
    await expect(pollCliFlow(flow, { fetchFn: missing.fetchFn, env: {} })).rejects.toBeInstanceOf(GlmLoginFatalError)
  })

  it('调用方已经取消时不把网络错误吞成 pending', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    const { fetchFn } = routedFetch([[/\/poll\//, () => { throw new TypeError('fetch failed') }]])
    await expect(
      pollCliFlow(flow, { fetchFn, env: {}, signal: controller.signal }),
    ).rejects.toThrow('fetch failed')
  })
})

// ---------------------------------------------------------------------------
// 截止时间算法
// ---------------------------------------------------------------------------

describe('截止时间与轮询间隔', () => {
  it('deadline = min(now + 5min, expires_at * 1000)', () => {
    const now = 1_000_000_000_000
    expect(flowDeadlineMs(now, now + 600_000)).toBe(now + OAUTH_FLOW_TIMEOUT_MS)
    expect(flowDeadlineMs(now, now + 10_000)).toBe(now + 10_000)
    expect(OAUTH_FLOW_TIMEOUT_MS).toBe(5 * 60 * 1000)
  })

  it('上游给的 expires_at 已经过去时，按超时处理而不是多轮询 5 分钟', async () => {
    const { fetchFn } = routedFetch([
      [/\/cli\/init$/, () => jsonResponse(initBody({ expires_at: Math.floor(Date.now() / 1000) - 30 }))],
      [/\/poll\//, () => jsonResponse({ status: 'pending' })],
    ])
    const flow = await beginWebLogin({ fetchFn, env: {}, openBrowser: () => undefined })
    const status = await pollWebLogin(flow.loginId, { fetchFn, env: {} })
    expect(status.status).toBe('error')
    expect(status.retryable).toBe(false)
    expect(status.error).toContain('超时')
  })
})

// ---------------------------------------------------------------------------
// 登录流程状态机
// ---------------------------------------------------------------------------

describe('登录流程状态机', () => {
  it('begin 下发 pending 状态与授权 URL，并且只打开一次浏览器', async () => {
    const opened: string[] = []
    const { fetchFn } = routedFetch([[/\/cli\/init$/, () => jsonResponse(initBody())]])
    const flow = await beginWebLogin({ fetchFn, env: {}, openBrowser: (url) => opened.push(url) })

    expect(flow.status).toBe('pending')
    expect(flow.region).toBe('intl')
    expect(flow.authorizeUrl).toBe('https://chat.z.ai/authorize?x=1')
    expect(flow.pollIntervalSec).toBe(2)
    expect(typeof flow.expiresAt).toBe('number')
    expect(opened).toEqual(['https://chat.z.ai/authorize?x=1'])
  })

  it('浏览器打不开不算失败：URL 仍然下发', async () => {
    const { fetchFn } = routedFetch([[/\/cli\/init$/, () => jsonResponse(initBody())]])
    const flow = await beginWebLogin({
      fetchFn,
      env: {},
      openBrowser: () => { throw new Error('no browser') },
    })
    expect(flow.status).toBe('pending')
    expect(flow.authorizeUrl).toBeTruthy()
  })

  it('间隔未到时不打上游（防止卡片把上游打成限流）', async () => {
    const { fetchFn, calls } = routedFetch([
      [/\/cli\/init$/, () => jsonResponse(initBody())],
      [/\/poll\//, () => jsonResponse({ status: 'pending' })],
    ])
    const flow = await beginWebLogin({ fetchFn, env: {}, openBrowser: () => undefined })
    expect((await pollWebLogin(flow.loginId, { fetchFn, env: {} })).status).toBe('pending')
    expect((await pollWebLogin(flow.loginId, { fetchFn, env: {} })).status).toBe('pending')
    expect(calls.filter((call) => call.url.includes('/poll/')).length).toBe(1)
  })

  it('就绪后状态转 complete，并把凭据交给 onAuthenticated', async () => {
    const saved: string[] = []
    const { fetchFn } = routedFetch([
      [/\/cli\/init$/, () => jsonResponse(initBody())],
      [/\/poll\//, () => jsonResponse(readyBody())],
    ])
    const flow = await beginWebLogin({ fetchFn, env: {}, openBrowser: () => undefined })
    const status = await pollWebLogin(flow.loginId, {
      fetchFn,
      env: {},
      onAuthenticated: async (credentials) => { saved.push(credentials.accessToken) },
    })
    expect(status.status).toBe('complete')
    expect(status.email).toBe('user@example.com')
    expect(status.credentials?.accessToken).toBe('at-placeholder')
    expect(saved).toEqual(['at-placeholder'])
  })

  it('致命轮询错误转成 error 且不可重试', async () => {
    const { fetchFn } = routedFetch([
      [/\/cli\/init$/, () => jsonResponse(initBody())],
      [/\/poll\//, () => jsonResponse({ msg: 'denied' }, 403)],
    ])
    const flow = await beginWebLogin({ fetchFn, env: {}, openBrowser: () => undefined })
    const status = await pollWebLogin(flow.loginId, { fetchFn, env: {} })
    expect(status.status).toBe('error')
    expect(status.retryable).toBe(false)
    expect(status.error).toContain('403')
  })

  it('取消之后轮询不再恢复这条流程', async () => {
    const { fetchFn, calls } = routedFetch([
      [/\/cli\/init$/, () => jsonResponse(initBody())],
      [/\/poll\//, () => jsonResponse({ status: 'pending' })],
    ])
    const flow = await beginWebLogin({ fetchFn, env: {}, openBrowser: () => undefined })
    expect(cancelWebLogin(flow.loginId)).toBe(true)
    const after = await pollWebLogin(flow.loginId, { fetchFn, env: {} })
    expect(after.status).toBe('error')
    expect(calls.filter((call) => call.url.includes('/poll/')).length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 手工粘贴兜底
// ---------------------------------------------------------------------------

describe('手工粘贴兜底（防火墙 / 远程会话下浏览器回不来）', () => {
  it('裸 code 与整条回调 URL 都能解出 code', () => {
    expect(extractAuthorizationCode('abc123')).toBe('abc123')
    expect(extractAuthorizationCode('  abc123  ')).toBe('abc123')
    expect(extractAuthorizationCode('zcode://oauth/callback?code=url-code&state=s1')).toBe('url-code')
    expect(extractAuthorizationCode('https://zcode.z.ai/app/oauth/login?code=relay-code')).toBe('relay-code')
    expect(extractAuthorizationCode('https://chat.z.ai/cb#code=hash-code')).toBe('hash-code')
    expect(extractAuthorizationCode('code=query-code&state=s2')).toBe('query-code')
    expect(extractAuthorizationCode('zcode://oauth/callback?state=s1')).toBe('')
    expect(extractAuthorizationCode('')).toBe('')
  })

  it('回调里的 error 被读成用户拒绝', () => {
    expect(extractAuthorizationError('https://x.invalid/cb?error=access_denied')).toBe('access_denied')
    expect(extractAuthorizationError('zcode://oauth/callback?error=access_denied&error_description=user+said+no')).toBe('user said no')
    expect(extractAuthorizationError('https://x.invalid/cb?code=ok')).toBe('')
  })

  it('粘贴裸 code 会强制立刻复查平台流程', async () => {
    const { fetchFn, calls } = routedFetch([
      [/\/cli\/init$/, () => jsonResponse(initBody())],
      [/\/poll\//, () => jsonResponse(readyBody())],
    ])
    const flow = await beginWebLogin({ fetchFn, env: {}, openBrowser: () => undefined })
    const submitted = submitLoginCode('zcode://oauth/callback?code=pasted&state=s1')
    expect(submitted.status).toBe('pending')
    // 状态快照里不得出现凭据。
    expect(JSON.stringify(submitted)).not.toContain('pasted')

    const status = await pollWebLogin(flow.loginId, { fetchFn, env: {} })
    expect(status.status).toBe('complete')
    expect(calls.filter((call) => call.url.includes('/poll/')).length).toBe(1)
  })

  it('没有进行中的流程时拒绝粘贴', () => {
    expect(() => submitLoginCode('abc123')).toThrow(/没有进行中/)
  })

  it('URL 里没有 code 时拒绝提交', async () => {
    const { fetchFn } = routedFetch([[/\/cli\/init$/, () => jsonResponse(initBody())]])
    await beginWebLogin({ fetchFn, env: {}, openBrowser: () => undefined })
    expect(() => submitLoginCode('https://chat.z.ai/cb?state=s1')).toThrow(/授权码/)
    expect(() => submitLoginCode('zcode://oauth/callback?state=s1')).toThrow(/授权码/)
    expect(() => submitLoginCode('   ')).toThrow(/授权码/)
  })

  it('用户拒绝授权时流程终止且不可重试', async () => {
    const { fetchFn, calls } = routedFetch([[/\/cli\/init$/, () => jsonResponse(initBody())]])
    const flow = await beginWebLogin({ fetchFn, env: {}, openBrowser: () => undefined })
    const submitted = submitLoginCode('https://chat.z.ai/cb?error=access_denied&error_description=用户拒绝')
    expect(submitted.status).toBe('error')
    expect(submitted.retryable).toBe(false)
    expect(submitted.error).toContain('用户拒绝')

    const after = await pollWebLogin(flow.loginId, { fetchFn, env: {} })
    expect(after.status).toBe('error')
    expect(calls.filter((call) => call.url.includes('/poll/')).length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 兑换链（计划 §3.2）
// ---------------------------------------------------------------------------

/** 业务面 fixture：一条完整的国际区兑换链。`reused` 决定列表里有没有同名 Key。 */
function exchangeRoutes(overrides: {
  keys?: unknown[]
  quota?: () => Response
  customerInfo?: unknown
  copy?: unknown
} = {}): Array<[RegExp, (init?: RequestInit) => Response]> {
  return [
    [/\/api\/auth\/z\/login$/, () => jsonResponse({ code: 0, data: { access_token: 'bt-placeholder', expires_in: 3600 } })],
    [/\/api\/biz\/customer\/getCustomerInfo$/, () => jsonResponse(overrides.customerInfo ?? { code: 0, data: {
      organizations: [
        { organizationId: 'org-2', organizationName: '别人的机构', projects: [{ projectId: 'p-2', projectName: '默认项目' }] },
        { organizationId: 'org-1', organizationName: '默认机构（个人）', projects: [
          { projectId: 'p-9', projectName: '别的项目' },
          { projectId: 'p-1', projectName: '默认项目' },
        ] },
      ],
    } })],
    [/\/api_keys$/, (init) => (init?.method === 'POST'
      ? jsonResponse({ code: 0, data: { apiKey: 'dsh-created-placeholder' } })
      : jsonResponse({ code: 0, data: overrides.keys ?? [] }))],
    [/\/api_keys\/copy\//, () => jsonResponse(overrides.copy ?? { code: 0, data: { secretKey: 'sk-placeholder' } })],
    [/\/api\/monitor\/usage\/quota\/limit$/, () => (overrides.quota?.() ?? jsonResponse({ code: 0, data: { level: 'pro' } }))],
  ]
}

describe('兑换链（计划 §3.2，证据等级 B）', () => {
  it('五步端点与顺序逐字对齐，并拼成 {apiKeyId}.{secretKey}', async () => {
    const { fetchFn, calls } = routedFetch(exchangeRoutes({
      keys: [{ name: GLM_KEY_NAME, apiKey: 'dsh-existing' }],
    }))
    const key = await exchangeForCodingPlanKey('at-placeholder', 'intl', { fetchFn, env: {} })

    expect(calls.map((call) => call.url.replace('https://api.z.ai', ''))).toEqual([
      '/api/auth/z/login',
      '/api/biz/customer/getCustomerInfo',
      '/api/biz/v1/organization/org-1/projects/p-1/api_keys',
      '/api/biz/v1/organization/org-1/projects/p-1/api_keys/copy/dsh-existing',
      '/api/monitor/usage/quota/limit',
    ])
    expect(key.codingPlanKey).toBe('dsh-existing.sk-placeholder')
    expect(key.organizationId).toBe('org-1')
    expect(key.projectId).toBe('p-1')
    expect(key.planLevel).toBe('pro')
    expect(key.keyCreated).toBe(false)
  })

  it('Key 名必须是 GLM_KEY_NAME，绝不是社区实现的 zcode-api-key', async () => {
    const { fetchFn, calls } = routedFetch(exchangeRoutes())
    const key = await exchangeForCodingPlanKey('at-placeholder', 'intl', { fetchFn, env: {} })

    const created = calls.find((call) => call.method === 'POST' && call.url.endsWith('/api_keys'))
    expect(created?.body).toEqual({ name: GLM_KEY_NAME })
    expect(GLM_KEY_NAME).toBe('dsh-glm-coding-plan')
    expect(key.keyName).toBe(GLM_KEY_NAME)
    expect(key.keyCreated).toBe(true)
  })

  it('不复用别人的同名 Key：列表里只有 zcode-api-key 时新建自己的', async () => {
    const { fetchFn, calls } = routedFetch(exchangeRoutes({
      keys: [{ name: 'zcode-api-key', apiKey: 'official-key' }],
    }))
    const key = await exchangeForCodingPlanKey('at-placeholder', 'intl', { fetchFn, env: {} })
    expect(key.apiKeyId).not.toBe('official-key')
    expect(key.keyCreated).toBe(true)
    expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/api_keys'))).toBe(true)
  })

  it('业务面请求带 Bearer 业务 JWT，业务登录把 access_token 放在体里', async () => {
    const { fetchFn, calls } = routedFetch(exchangeRoutes())
    await exchangeForCodingPlanKey('at-placeholder', 'intl', { fetchFn, env: {} })

    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.body).toEqual({ token: 'at-placeholder' })
    // 业务登录不带 Authorization：access_token 在体里。
    expect(calls[0]!.headers['authorization']).toBeUndefined()
    expect(calls[1]!.headers['authorization']).toBe('Bearer bt-placeholder')
  })

  it('落盘前用配额接口验活，裸 Key 且不加 Bearer', async () => {
    const { fetchFn, calls } = routedFetch(exchangeRoutes())
    const key = await exchangeForCodingPlanKey('at-placeholder', 'intl', { fetchFn, env: {} })

    const probe = calls[calls.length - 1]!
    expect(probe.url).toBe('https://api.z.ai/api/monitor/usage/quota/limit')
    expect(probe.headers['authorization']).toBe(key.apiKeyId + '.sk-placeholder')
    expect(probe.headers['authorization']).not.toMatch(/^Bearer /)
  })

  // 三种情形各自的判定。依据全部来自官方文档与本仓库冻结的错误码表，没有实机样本。
  it('情形一：有付费套餐 → 登录成功，额度类型如实标为 plan', async () => {
    const { fetchFn } = routedFetch(exchangeRoutes({
      quota: () => jsonResponse({ code: 0, data: { level: 'pro' } }),
    }))
    const key = await exchangeForCodingPlanKey('at-placeholder', 'intl', { fetchFn, env: {} })

    expect(key.codingPlanKey).toBe('dsh-created-placeholder.sk-placeholder')
    expect(key.planLevel).toBe('pro')
    expect(key.allowance).toBe('plan')
  })

  it('情形二：无付费套餐但凭据有效 → 登录成功，额度类型标为 free-trial（不是拒在登录阶段）', async () => {
    // 1220 = NO_PERMISSION「当前套餐不包含 Coding Plan API」：配额面已经认出了这把 Key，
    // 拒的是套餐维度。官方文档写明新用户有免费体验额度，所以必须放行。
    const { fetchFn } = routedFetch(exchangeRoutes({
      quota: () => jsonResponse({ code: 1220, msg: 'no permission' }, 403),
    }))
    const key = await exchangeForCodingPlanKey('at-placeholder', 'intl', { fetchFn, env: {} })

    expect(key.codingPlanKey).toBe('dsh-created-placeholder.sk-placeholder')
    expect(key.allowance).toBe('free-trial')
    // 免费额度没有付费档位，planLevel 必须如实为 null，而不是编一个出来。
    expect(key.planLevel).toBeNull()
  })

  it('情形二（另一支）：套餐失效 1309 同样放行成 free-trial，而不是报「不可用」', async () => {
    const { fetchFn } = routedFetch(exchangeRoutes({
      quota: () => jsonResponse({ code: 1309, msg: 'expired' }, 429),
    }))
    const key = await exchangeForCodingPlanKey('at-placeholder', 'intl', { fetchFn, env: {} })

    expect(key.allowance).toBe('free-trial')
    expect(key.planLevel).toBeNull()
  })

  it('情形三：凭据无效 → 仍然登录失败（这一条行为不变）', async () => {
    // 1000 = AUTH_INVALID。凭据本身坏了必须失败：放行等于拿着一把废 Key 进对话，
    // 用户只会在某次请求里以一个莫名其妙的 401 看到它。
    for (const code of [1000, 1001, 1003]) {
      const { fetchFn } = routedFetch(exchangeRoutes({
        quota: () => jsonResponse({ code, msg: 'unauthorized' }, 401),
      }))
      await expect(
        exchangeForCodingPlanKey('at-placeholder', 'intl', { fetchFn, env: {} }),
      ).rejects.toBeInstanceOf(GlmCodingPlanUnavailableError)
    }
  })

  it('分不出「key 坏了」与「没有套餐」时放行并标为 unknown（安全方向：不误拒有效账号）', async () => {
    // 裸 401，正文里没有可识别的业务码。**未验证**上游在这两种情况下是否给不同形状。
    const { fetchFn } = routedFetch(exchangeRoutes({
      quota: () => jsonResponse({ msg: 'Unauthorized' }, 401),
    }))
    const key = await exchangeForCodingPlanKey('at-placeholder', 'intl', { fetchFn, env: {} })

    expect(key.codingPlanKey).toBe('dsh-created-placeholder.sk-placeholder')
    expect(key.allowance).toBe('unknown')
  })

  it('成功但读不出已知付费档位时标为 unknown，不谎报成 plan', async () => {
    const { fetchFn } = routedFetch(exchangeRoutes({
      quota: () => jsonResponse({ code: 0, data: { level: 'some-new-tier' } }),
    }))
    const key = await exchangeForCodingPlanKey('at-placeholder', 'intl', { fetchFn, env: {} })

    // planLevel 如实保留上游给的那个字符串（那是诊断事实），
    // 但额度类型不能因为「读到了东西」就报成付费套餐。
    expect(key.planLevel).toBe('some-new-tier')
    expect(key.allowance).toBe('unknown')
  })

  it('业务登录缺 access_token 时不静默，形状漂移要报错', async () => {
    const { fetchFn } = routedFetch([
      [/\/api\/auth\/z\/login$/, () => jsonResponse({ code: 0, data: { expires_in: 3600 } })],
    ])
    await expect(loginBizToken('at-placeholder', 'intl', { fetchFn, env: {} })).rejects.toBeInstanceOf(GlmExchangeError)
  })

  it('expires_in 缺失时退回 JWT 自身的 exp（只解码不校验）', async () => {
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 900 })).toString('base64url')
    const token = 'h.' + payload + '.s'
    const { fetchFn } = routedFetch([
      [/\/api\/auth\/z\/login$/, () => jsonResponse({ code: 0, access_token: token })],
    ])
    const biz = await loginBizToken('at-placeholder', 'intl', { fetchFn, env: {} })
    expect(biz.token).toBe(token)
    expect(biz.expiresInSec).toBeGreaterThan(800)
    expect(biz.expiresInSec).toBeLessThanOrEqual(900)
  })

  it('国区跳过 z/login，直接拿裸 access_token 打 /api/biz/*，host 是 bigmodel.cn', async () => {
    const { fetchFn, calls } = routedFetch(exchangeRoutes({
      keys: [{ name: GLM_KEY_NAME, apiKey: 'dsh-existing' }],
    }))
    const key = await exchangeForCodingPlanKey('at-placeholder', 'cn', { fetchFn, env: {} })

    // 逐字（resolver.ts 的 bigmodel 分支）：国区没有 z/login 这一步。
    expect(calls.some((call) => call.url.endsWith('/api/auth/z/login'))).toBe(false)
    expect(calls.map((call) => call.url.replace('https://bigmodel.cn', ''))).toEqual([
      '/api/biz/customer/getCustomerInfo',
      '/api/biz/v1/organization/org-1/projects/p-1/api_keys',
      '/api/biz/v1/organization/org-1/projects/p-1/api_keys/copy/dsh-existing',
      '/api/monitor/usage/quota/limit',
    ])
    // /api/biz/* 用裸 access_token，不加 Bearer；国际区才是 Bearer <bizToken>。
    const bizCalls = calls.filter((call) => call.url.includes('/api/biz/'))
    expect(bizCalls.length).toBe(3)
    for (const call of bizCalls) {
      expect(call.headers['authorization']).toBe('at-placeholder')
    }
    // 验活那一次带的是 Coding Plan Key 本身（裸值，不是 access_token）。
    expect(calls[calls.length - 1]!.headers['authorization']).toBe('dsh-existing.sk-placeholder')
    expect(key.codingPlanKey).toBe('dsh-existing.sk-placeholder')
    // 国区没有业务 JWT 可缓存。
    expect(key.bizToken).toBeNull()
    expect(key.bizTokenExpiresAt).toBeNull()
  })

  it('国际区仍然走 z/login 并带 Bearer <bizToken>', async () => {
    const { fetchFn, calls } = routedFetch(exchangeRoutes())
    const key = await exchangeForCodingPlanKey('at-placeholder', 'intl', { fetchFn, env: {} })

    expect(calls[0]!.url).toBe('https://api.z.ai/api/auth/z/login')
    expect(key.bizToken).toBe('bt-placeholder')
    expect(calls[1]!.headers['authorization']).toBe('Bearer bt-placeholder')
  })

  it('两区都要求 secretKey：缺失即登录失败，不落一把永远签不了名的 Key', async () => {
    for (const region of ['intl', 'cn'] as const) {
      const { fetchFn } = routedFetch(exchangeRoutes({ copy: { code: 0, data: {} } }))
      await expect(
        exchangeForCodingPlanKey('at-placeholder', region, { fetchFn, env: {} }),
      ).rejects.toThrow(/secretKey/)
    }
  })

  it('国区链路的每一条失败都带「未验证」声明', async () => {
    const { fetchFn } = routedFetch([[
      /\/api\/biz\/customer\/getCustomerInfo$/,
      () => jsonResponse({ code: 0, data: { organizations: [] } }),
    ]])
    await expect(
      exchangeForCodingPlanKey('at-placeholder', 'cn', { fetchFn, env: {} }),
    ).rejects.toThrow(CN_EXCHANGE_UNVERIFIED_NOTICE)
  })

  it('国际区不附带未验证声明（那是国区专属的事实）', async () => {
    const { fetchFn } = routedFetch([[
      /\/api\/biz\/customer\/getCustomerInfo$/,
      () => jsonResponse({ code: 0, data: { organizations: [] } }),
    ]])
    await expect(
      exchangeForCodingPlanKey('at-placeholder', 'intl', { fetchFn, env: {} }),
    ).rejects.not.toThrow(CN_EXCHANGE_UNVERIFIED_NOTICE)
  })
})

// ---------------------------------------------------------------------------
// 业务 JWT 缓存（计划 §3.6）
// ---------------------------------------------------------------------------

describe('业务 JWT 缓存', () => {
  const freshFetch = () => routedFetch([
    [/\/api\/auth\/z\/login$/, () => jsonResponse({ code: 0, data: { access_token: 'bt-placeholder', expires_in: 3600 } })],
  ])

  it('提前量 = 120 秒 + 0~60 秒抖动，抖动抽自可注入的 random', () => {
    expect(refreshJitterSeconds(() => 0)).toBe(0)
    expect(refreshJitterSeconds(() => 0.999999)).toBe(59)
    expect(refreshThresholdMs(0)).toBe(120_000)
    expect(refreshThresholdMs(30)).toBe(150_000)

    const cache = new GlmBizTokenCache({ accountKey: 'a-1', region: 'intl' }, { random: () => 0.5 })
    expect(cache.jitter).toBe(30)
  })

  it('新鲜期内直接复用，不打上游', async () => {
    const cache = new GlmBizTokenCache({ accountKey: 'a-1', region: 'intl' }, { random: () => 0 })
    cache.put({ token: 'bt-cached', expiresAt: Date.now() + 3600_000, expiresInSec: 3600, fetchedAt: Date.now() })
    const { fetchFn, calls } = freshFetch()
    const entry = await cache.ensure({ accessToken: 'at-placeholder' }, { fetchFn, env: {} })
    expect(entry.token).toBe('bt-cached')
    expect(calls.length).toBe(0)
  })

  it('进入提前量就重取一次', async () => {
    const cache = new GlmBizTokenCache({ accountKey: 'a-1', region: 'intl' }, { random: () => 0 })
    cache.put({ token: 'bt-old', expiresAt: Date.now() + 60_000, expiresInSec: 60, fetchedAt: Date.now() })
    const { fetchFn, calls } = freshFetch()
    const entry = await cache.ensure({ accessToken: 'at-placeholder' }, { fetchFn, env: {} })
    expect(entry.token).toBe('bt-placeholder')
    expect(calls.length).toBe(1)
  })

  it('同一账号的并发调用共享一次重取（单飞）', async () => {
    const cache = new GlmBizTokenCache({ accountKey: 'a-1', region: 'intl' }, { random: () => 0 })
    const { fetchFn, calls } = freshFetch()
    const [first, second] = await Promise.all([
      cache.ensure({ accessToken: 'at-placeholder' }, { fetchFn, env: {} }),
      cache.ensure({ accessToken: 'at-placeholder' }, { fetchFn, env: {} }),
    ])
    expect(first.token).toBe('bt-placeholder')
    expect(second.token).toBe('bt-placeholder')
    expect(calls.length).toBe(1)
  })

  it('两个账号各自一份缓存，不共用一条 JWT', async () => {
    const a = new GlmBizTokenCache({ accountKey: 'a-1', region: 'intl' }, { random: () => 0 })
    const b = new GlmBizTokenCache({ accountKey: 'a-2', region: 'intl' }, { random: () => 0 })
    const { fetchFn, calls } = freshFetch()
    await a.ensure({ accessToken: 'at-placeholder' }, { fetchFn, env: {} })
    await b.ensure({ accessToken: 'at-placeholder' }, { fetchFn, env: {} })
    expect(calls.length).toBe(2)
  })

  it('clear 之后下一次 ensure 一定重取（重登时必须调用）', async () => {
    const cache = new GlmBizTokenCache({ accountKey: 'a-1', region: 'intl' }, { random: () => 0 })
    cache.put({ token: 'bt-old', expiresAt: Date.now() + 3600_000, expiresInSec: 3600, fetchedAt: Date.now() })
    cache.clear()
    const { fetchFn, calls } = freshFetch()
    const entry = await cache.ensure({ accessToken: 'at-placeholder' }, { fetchFn, env: {} })
    expect(entry.token).toBe('bt-placeholder')
    expect(calls.length).toBe(1)
  })

  it('国区账号没有业务 JWT 可缓存：直接报错，不去打那条链路不用的 z/login', async () => {
    const cache = new GlmBizTokenCache({ accountKey: 'a-cn', region: 'cn' }, { random: () => 0 })
    const { fetchFn, calls } = freshFetch()
    await expect(cache.ensure({ accessToken: 'at-placeholder' }, { fetchFn, env: {} }))
      .rejects.toBeInstanceOf(GlmExchangeError)
    expect(calls.length).toBe(0)
  })

  it('重取失败不写缓存：宁可这次失败，也不顶上没验证过的 JWT', async () => {
    const cache = new GlmBizTokenCache({ accountKey: 'a-1', region: 'intl' }, { random: () => 0 })
    const { fetchFn } = routedFetch([
      [/\/api\/auth\/z\/login$/, () => jsonResponse({ code: 1003, msg: 'access_token 过期' }, 401)],
    ])
    await expect(cache.ensure({ accessToken: 'at-placeholder' }, { fetchFn, env: {} })).rejects.toBeInstanceOf(GlmExchangeError)
    expect(cache.peek()).toBeNull()
  })
})
