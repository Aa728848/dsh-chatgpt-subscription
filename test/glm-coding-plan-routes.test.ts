import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { registerGlmCodingPlanRoutes, glmSubPathOf } from '../src/host/glm-coding-plan/routes.ts'
import {
  GlmCodingPlanCredentialStore,
  type GlmCodingPlanModelSettings,
  type GlmCodingPlanSettingsPatch,
} from '../src/host/glm-coding-plan/token-store.ts'
import { mergeContextWindowOverrides } from '../src/host/common/context-window-overrides.ts'
import { GlmCodingPlanAccountPool } from '../src/host/glm-coding-plan/account-pool.ts'
import { clearCachedCatalog, clearCachedQuota } from '../src/host/glm-coding-plan/client.ts'
import { openBrowser as openRealBrowser, resetWebLogins } from '../src/host/glm-coding-plan/oauth.ts'
import { resetInFlightBizTokenFetches } from '../src/host/glm-coding-plan/biz-token-cache.ts'
import type { GlmLoginFlowStatus, GlmStatusDto } from '../src/shared/glm-coding-plan-contracts.ts'
import type { CredentialStore } from '../src/host/token-store.ts'

/**
 * 本文件不许真的弹出系统浏览器。
 *
 * /login/start 会走 beginWebLogin，而 oauth.ts 的默认 openBrowser 是 spawn
 * 'cmd /c start'（Windows）——一旦路由装配漏了注入，跑一次测试就会在跑测试的
 * 人的机器上真的打开一个窗口。这条 mock 把浏览器启动**记下来但不执行**：
 * 于是「漏注入」变成一条红断言，而不是一次外部副作用。
 * 非浏览器命令（DPAPI 的 powershell 等）照常走真实现，本文件用内存后端，不受影响。
 */
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  // 调用方按 spawn(...).on('error', ...).unref() 用它，所以桩件必须能链上这两个方法。
  const inert = { on: () => inert, unref: () => inert }
  // 名单只能写死在这里：vi.mock 的工厂会被提升到所有 import 之前求值，
  // 引用外面那个 const 会撞上 TDZ。
  const spawn = vi.fn((command: string, ...rest: unknown[]) => (['cmd', 'open', 'xdg-open'].includes(command)
    ? inert
    : (actual.spawn as (...args: unknown[]) => unknown)(command, ...rest)))
  return { ...actual, spawn }
})

/** 各平台「打开浏览器」用的可执行文件名；与 oauth.ts 里那三行一一对应。 */
const BROWSER_COMMANDS = ['cmd', 'open', 'xdg-open']

const childProcess = await import('node:child_process')
const spawnSpy = vi.mocked(childProcess.spawn)

const HOST = '127.0.0.1:3080'
const ORIGIN = 'http://' + HOST

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * 整条兑换链 + 配额 + OAuth 控制面的假上游。
 *
 * 覆盖四段兑换（z/login → getCustomerInfo → api_keys → copy）+ 配额 + 订阅 + 模型清单，
 * 于是「登录一次真的能把账号落进号池」这件事在离网环境下可测。
 */
function upstreamFetch(overrides: {
  initReady?: () => boolean
  /**
   * 让配额端点一律 500。**在每次请求时读**：登录时的额度探活走的正是同一个端点，
   * 所以要先把登录跑完、再把开关翻过去，才能造出「登录成功但配额读不到」这个局面。
   */
  quotaFails?: boolean | (() => boolean)
} = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input)
    const quota = {
      success: true,
      data: {
        level: 'pro',
        limits: [
          { type: 'TOKENS_LIMIT', unit: 3, percentage: 25, nextResetTime: 1_800_000_000 },
          { type: 'TIME_LIMIT', unit: 9, percentage: 5 },
        ],
      },
    }
    if (url.includes('/oauth/cli/init')) {
      return jsonResponse({
        data: {
          flow_id: 'flow_1',
          authorize_url: 'https://chat.z.ai/api/oauth/authorize?client_id=x',
          expires_at: Math.floor(Date.now() / 1000) + 300,
          poll_interval_sec: 1,
        },
      })
    }
    if (url.includes('/oauth/cli/poll/')) {
      if (overrides.initReady !== undefined && !overrides.initReady()) {
        return jsonResponse({ data: { status: 'pending' } })
      }
      return jsonResponse({
        data: {
          status: 'ready',
          user: { user_id: 'user_1', email: 'a@example.com', name: 'A' },
          zai: { access_token: 'oauth-access-token', refresh_token: null },
        },
      })
    }
    if (url.endsWith('/api/auth/z/login')) {
      return jsonResponse({ code: 0, data: { access_token: 'biz.jwt', expires_in: 3600 } })
    }
    if (url.includes('/api/biz/customer/getCustomerInfo')) {
      return jsonResponse({
        code: 0,
        data: {
          organizations: [{
            organizationId: 'org_1',
            organizationName: '默认机构',
            projects: [{ projectId: 'proj_1', projectName: '默认项目' }],
          }],
        },
      })
    }
    if (url.includes('/api_keys/copy/')) {
      return jsonResponse({ code: 0, data: { secretKey: 'sk_1' } })
    }
    if (url.includes('/api_keys')) {
      return jsonResponse({ code: 0, data: [{ name: 'dsh-glm-coding-plan', apiKey: 'ak_1' }] })
    }
    if (url.includes('/api/biz/subscription/list')) {
      return jsonResponse({ code: 0, data: { list: [{ planName: 'GLM Coding Plan Pro', renewTime: 1_800_000_000 }] } })
    }
    if (url.includes('/api/coding/paas/v4/models')) {
      return jsonResponse({ data: [{ id: 'GLM-5.3', context_length: 1_000_000 }] })
    }
    if (url.includes('/api/monitor/usage/quota/limit')) {
      const failing = overrides.quotaFails
      if (typeof failing === 'function' ? failing() : failing === true) {
        return jsonResponse({ success: false, code: 500 }, 500)
      }
      // 回归点：配额接口用裸 Key，不加 Bearer（计划 §8.2）。
      const headers = new Headers(init?.headers)
      if ((headers.get('authorization') ?? '').startsWith('Bearer ')) {
        return jsonResponse({ success: false, code: 401 }, 401)
      }
      return jsonResponse(quota)
    }
    return jsonResponse({ code: 0, data: {} })
  }) as typeof fetch
}

function fakeResponse(): { response: ServerResponse; captured: { status?: number; body?: Record<string, unknown> } } {
  const captured: { status?: number; body?: Record<string, unknown> } = {}
  const response = {
    writeHead(status: number) { captured.status = status; return response },
    end(raw?: string) { captured.body = raw === undefined ? undefined : JSON.parse(raw) as Record<string, unknown> },
  } as unknown as ServerResponse
  return { response, captured }
}

function fakeRequest(input: {
  url: string
  method?: string
  body?: unknown
  origin?: string | null
}): IncomingMessage {
  const listeners = new Map<string, Array<(value?: unknown) => void>>()
  const request = {
    url: input.url,
    method: input.method ?? 'GET',
    headers: {
      host: HOST,
      ...(input.origin === null ? {} : { origin: input.origin ?? ORIGIN }),
    },
    on(event: string, listener: (value?: unknown) => void) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return request
    },
    destroy() {},
  } as unknown as IncomingMessage
  if (input.method === 'POST') {
    queueMicrotask(() => {
      if (input.body !== undefined) {
        listeners.get('data')?.forEach((listener) => listener(Buffer.from(JSON.stringify(input.body))))
      }
      listeners.get('end')?.forEach((listener) => listener())
    })
  }
  return request
}

/** 内存设置存储，替掉明文文件与 register scope 两端。 */
function memorySettings(initial: GlmCodingPlanModelSettings = {
  enabled: true,
  enabledModelIds: ['GLM-5.3', 'GLM-5.2'],
  contextWindowOverrides: {},
  defaultReasoningEffort: null,
  selectedAccountId: null,
}) {
  let value = initial
  return {
    value: () => value,
    update: (patch: GlmCodingPlanSettingsPatch) => {
      value = {
        enabled: patch.enabled !== undefined ? patch.enabled : value.enabled !== false,
        enabledModelIds: patch.enabledModelIds ?? value.enabledModelIds,
        contextWindowOverrides: patch.contextWindowOverrides !== undefined
          ? mergeContextWindowOverrides(value.contextWindowOverrides, patch.contextWindowOverrides)
          : value.contextWindowOverrides,
        defaultReasoningEffort: patch.defaultReasoningEffort !== undefined
          ? patch.defaultReasoningEffort
          : value.defaultReasoningEffort,
        selectedAccountId: patch.selectedAccountId !== undefined
          ? patch.selectedAccountId
          : value.selectedAccountId,
      }
      return Promise.resolve(value)
    },
  }
}

function memoryPoolBackend<T>(): CredentialStore<T> {
  let data: T | null = null
  return {
    async load() { return data === null ? null : JSON.parse(JSON.stringify(data)) as T },
    async save(next: T) { data = JSON.parse(JSON.stringify(next)) as T },
    async clear() { data = null },
  }
}

/**
 * 本文件的装配默认注入一个空 openBrowser，让绝大多数用例不必知道「这条路由会开浏览器」。
 *
 * `opener.omit` 是**生产那份接线**——src/index.ts 一栏都不传。生产靠的是路由自己的
 * 缺省（什么都不做），所以只有这一档能证明生产路径不会弹窗。
 */
function harness(fetchFn: typeof fetch, opener: { openBrowser?: (url: string) => void; omit?: boolean } = {}) {
  const settings = memorySettings()
  const pool = new GlmCodingPlanAccountPool({
    // 凭据存储也给内存后端：Windows 上真读一次要 spawn powershell 走 DPAPI，
    // 一条测试多花一秒，而这条测试要验的是路由行为不是平台加密。
    store: new GlmCodingPlanCredentialStore('unused.json', memoryPoolBackend()),
    backend: memoryPoolBackend(),
  })
  // 放进一个对象而不是闭包变量：赋值发生在 webServer.register 的回调里，
  // 局部变量会被 TS 收窄成「永远是 null」。
  const registered: { handler?: (request: IncomingMessage, response: ServerResponse) => Promise<void> } = {}
  let disposeCount = 0
  const ctx = {
    emit: () => undefined,
    webServer: {
      // 签名照实现与全仓约定：单参数对象 { kind, path, handler }
      // （src/host/glm-coding-plan/routes.ts 与 minimax-code / hub-overview 一致）。
      register(route: { kind?: string; path?: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) {
        registeredPath = route.path ?? ''
        registered.handler = route.handler
        return () => { disposeCount += 1; delete registered.handler }
      },
    },
  } as unknown as Context
  let registeredPath = ''
  const dispose = registerGlmCodingPlanRoutes(
    ctx,
    { status: () => settings.value(), update: settings.update },
    {
      fetchFn,
      accountPool: pool,
      serving: () => true,
      conflict: () => null,
      // /login/start 的浏览器副作用只发生在 routes.ts 那一行 beginWebLogin 上，
      // 所以注入点放在**装配**而不是每个用例：一次注入盖住本文件全部用例，
      // 将来新写的用例不必再知道「这条路由会开浏览器」这件实现细节。
      ...(opener.omit ? {} : { openBrowser: opener.openBrowser ?? (() => undefined) }),
    },
  )
  return {
    settings,
    pool,
    dispose,
    disposeCount: () => disposeCount,
    registeredPath: () => registeredPath,
    async call(input: { url: string; method?: string; body?: unknown; origin?: string | null }) {
      const handler = registered.handler
      if (handler === undefined) throw new Error('routes not registered')
      const { response, captured } = fakeResponse()
      await handler(fakeRequest(input), response)
      return captured
    },
  }
}

function valueOf(captured: { body?: Record<string, unknown> }): Record<string, unknown> {
  const value = captured.body?.value
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

describe('GLM 路由：同源校验不可省', () => {
  beforeEach(() => {
    resetWebLogins()
    resetInFlightBizTokenFetches()
    clearCachedQuota()
    clearCachedCatalog()
  })

  it('每个 POST 都拒绝跨源', async () => {
    const api = harness(upstreamFetch())
    for (const path of ['settings', 'accounts', 'quota', 'catalog/refresh', 'connection/test',
      'login/start', 'login/cancel', 'login/manual', 'adopt']) {
      const captured = await api.call({
        url: '/glm-coding-plan/api/' + path,
        method: 'POST',
        body: {},
        origin: 'http://evil.example',
      })
      expect(captured.status).toBe(403)
      expect(captured.body?.ok).toBe(false)
    }
    api.dispose()
  })

  it('无 origin 的请求只在环回地址上被接受', async () => {
    const api = harness(upstreamFetch())
    // 桌面外壳转发到环回 Host 时会去掉 origin；这不是 CSRF 开口（见 same-origin.ts）。
    const loopback = await api.call({ url: '/glm-coding-plan/api/quota', method: 'POST', body: {}, origin: null })
    expect(loopback.status).toBe(200)
    api.dispose()
  })
})

describe('GLM 路由：/status 是页面的唯一读口', () => {
  beforeEach(() => {
    resetWebLogins()
    resetInFlightBizTokenFetches()
    clearCachedQuota()
    clearCachedCatalog()
  })

  it('注册在契约前缀下，未登录时优雅降级', async () => {
    const api = harness(upstreamFetch())
    expect(api.registeredPath()).toBe('/glm-coding-plan/api')
    const captured = await api.call({ url: '/glm-coding-plan/api/status' })
    expect(captured.status).toBe(200)
    expect(captured.body?.ok).toBe(true)
    const status = valueOf(captured) as unknown as GlmStatusDto
    expect(status.providerId).toBe('glm-coding-plan')
    expect(status.authenticated).toBe(false)
    expect(status.accounts).toEqual([])
    expect(status.rotationStrategy).toBe('sequential')
    expect(status.serving).toBe(true)
    expect(status.conflict).toBeNull()
    expect(status.login).toEqual({ status: 'idle' })
    // 随包目录逐行下发，每行都带自己的 hint 与 wire（能力不从模型名推断）。
    expect(status.models.length).toBeGreaterThan(0)
    expect(status.models.every((model) => model.wire === 'anthropic')).toBe(true)
    expect(status.models.map((model) => model.id)).toContain('GLM-5.3')
    api.dispose()
  })

  it('子路径解析认得契约前缀', () => {
    expect(glmSubPathOf('/glm-coding-plan/api/status')).toBe('status')
    expect(glmSubPathOf('/glm-coding-plan/api')).toBe('')
    expect(glmSubPathOf('/glm-coding-plan/api/login/status')).toBe('login/status')
  })
})

describe('GLM 路由：登录全流程（开流 → 轮询 → 兑换 → 进号池）', () => {
  beforeEach(() => {
    resetWebLogins()
    resetInFlightBizTokenFetches()
    clearCachedQuota()
    clearCachedCatalog()
  })

  it('/login/start 返回 pending 与授权页，且不泄漏任何凭据', async () => {
    const api = harness(upstreamFetch())
    const captured = await api.call({
      url: '/glm-coding-plan/api/login/start',
      method: 'POST',
      body: { region: 'intl' },
    })
    expect(captured.status).toBe(200)
    const login = valueOf(captured) as unknown as GlmLoginFlowStatus
    expect(login.status).toBe('pending')
    expect(login.region).toBe('intl')
    expect(login.authorizeUrl).toContain('chat.z.ai')
    // 凭据与 host 自己的会话 id 都不许过这条边界。
    const raw = JSON.stringify(captured.body)
    expect(raw).not.toContain('credentials')
    expect(raw).not.toContain('loginId')
    expect(raw).not.toContain('oauth-access-token')
    api.dispose()
  })

  it('/login/status 推进状态机并把账号落进号池', async () => {
    // 上游第一次轮询还没就绪，之后就绪（逐字证据：oauth.ts 会按 poll_interval_sec 节流，
    // 所以第二次轮询必须等过一个间隔，而不是立刻连打）。
    let polls = 0
    const api = harness(upstreamFetch({ initReady: () => ++polls > 1 }))
    await api.call({ url: '/glm-coding-plan/api/login/start', method: 'POST', body: { region: 'intl' } })

    const pending = await api.call({ url: '/glm-coding-plan/api/login/status' })
    expect((valueOf(pending) as unknown as GlmLoginFlowStatus).status).toBe('pending')
    expect(await api.pool.listAccounts()).toEqual([])

    await new Promise((resolve) => { setTimeout(resolve, 1_100) })
    const ready = await api.call({ url: '/glm-coding-plan/api/login/status' })
    expect((valueOf(ready) as unknown as GlmLoginFlowStatus).status).toBe('complete')
    const rows = await api.pool.listAccounts()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.region).toBe('intl')
    expect(rows[0]?.organizationId).toBe('org_1')
    expect(rows[0]?.email).toBe('a@example.com')
    expect(rows[0]?.removable).toBe(true)
    const stored = (await api.pool.read()).accounts[0]!.credentials
    expect(stored.codingPlan.codingPlanKey).toBe('ak_1.sk_1')
    expect(stored.codingPlan.bizToken).toBe('biz.jwt')
    api.dispose()
  })

  it('/login/status 在没有流程时回答 idle', async () => {
    const api = harness(upstreamFetch())
    const captured = await api.call({ url: '/glm-coding-plan/api/login/status' })
    expect(captured.status).toBe(200)
    expect(captured.body?.value).toEqual({ status: 'idle' })
    api.dispose()
  })

  it('登录成功后 /login/status 与 /status 都仍然回答 complete（终态不被清空）', async () => {
    let polls = 0
    const api = harness(upstreamFetch({ initReady: () => ++polls > 1 }))
    await api.call({ url: '/glm-coding-plan/api/login/start', method: 'POST', body: { region: 'intl' } })
    expect((valueOf(await api.call({ url: '/glm-coding-plan/api/login/status' })) as unknown as GlmLoginFlowStatus).status)
      .toBe('pending')
    await new Promise((resolve) => { setTimeout(resolve, 1_100) })
    const done = (valueOf(await api.call({ url: '/glm-coding-plan/api/login/status' })) as unknown as GlmLoginFlowStatus)
    expect(done.status).toBe('complete')

    // 回归点：这条终态必须**留住**。oauth.ts 在流程结束时已经把会话删了，
    // 路由层再把 latestLogin 清掉的话，下一拍读到的就是 idle——
    // 卡片于是刚显示账号进池，紧接着改口「尚未开始登录」。
    for (let read = 0; read < 3; read += 1) {
      const again = (valueOf(await api.call({ url: '/glm-coding-plan/api/login/status' })) as unknown as GlmLoginFlowStatus)
      expect(again.status).toBe('complete')
      expect(again.email).toBe('a@example.com')
      expect(typeof again.completedAt).toBe('number')
    }
    // /status 是卡片的唯一读口：它必须给出同一条终态，而不是 idle。
    const status = valueOf(await api.call({ url: '/glm-coding-plan/api/status' })) as unknown as GlmStatusDto
    expect(status.login?.status).toBe('complete')
    expect(status.login?.email).toBe('a@example.com')
    expect(status.authenticated).toBe(true)

    // 终态是终态，不是 pending：读过它之后不得再向上游打一次轮询。
    expect(polls).toBe(2)
    api.dispose()
  })

  it('手工粘贴登录成功后随后的 /status 仍然是 complete', async () => {
    const api = harness(upstreamFetch())
    await api.call({ url: '/glm-coding-plan/api/login/start', method: 'POST', body: { region: 'intl' } })
    const pasted = valueOf(await api.call({
      url: '/glm-coding-plan/api/login/manual',
      method: 'POST',
      body: { region: 'intl', code: 'cb' },
    })) as unknown as GlmStatusDto
    // 这条路由回的是**整份 status**（文件头的路由表与客户端都这么读）。
    expect(pasted.models.length).toBeGreaterThan(0)
    expect(pasted.login?.status).toBe('complete')

    const after = valueOf(await api.call({ url: '/glm-coding-plan/api/status' })) as unknown as GlmStatusDto
    expect(after.login?.status).toBe('complete')
    expect(after.login?.email).toBe('a@example.com')
    api.dispose()
  })

  it('用户取消之后终态回到 idle（保留策略的另一半）', async () => {
    const api = harness(upstreamFetch())
    await api.call({ url: '/glm-coding-plan/api/login/start', method: 'POST', body: { region: 'intl' } })
    await api.call({ url: '/glm-coding-plan/api/login/manual', method: 'POST', body: { region: 'intl', code: 'cb' } })
    expect((valueOf(await api.call({ url: '/glm-coding-plan/api/status' })) as unknown as GlmStatusDto).login?.status)
      .toBe('complete')
    await api.call({ url: '/glm-coding-plan/api/login/cancel', method: 'POST', body: { region: 'intl' } })
    // 取消是用户动作，不是超时：它明确地把这条流程的存在痕迹收掉。
    expect((valueOf(await api.call({ url: '/glm-coding-plan/api/status' })) as unknown as GlmStatusDto).login?.status)
      .toBe('idle')
    api.dispose()
  })
  it('/login/cancel 让后续轮询无从恢复', async () => {
    const api = harness(upstreamFetch())
    await api.call({ url: '/glm-coding-plan/api/login/start', method: 'POST', body: { region: 'intl' } })
    const cancelled = await api.call({ url: '/glm-coding-plan/api/login/cancel', method: 'POST', body: {} })
    expect((valueOf(cancelled) as unknown as GlmLoginFlowStatus).status).toBe('idle')
    expect(api.disposeCount()).toBe(0)
    const after = await api.call({ url: '/glm-coding-plan/api/login/status' })
    expect((valueOf(after) as unknown as GlmLoginFlowStatus).status).toBe('idle')
    api.dispose()
  })

  it('/login/manual 没有进行中的流程时给出可操作报错，粘贴后推进一次轮询', async () => {
    const api = harness(upstreamFetch())
    const orphan = await api.call({
      url: '/glm-coding-plan/api/login/manual',
      method: 'POST',
      body: { region: 'intl', code: 'abc' },
    })
    expect(orphan.status).toBe(400)
    expect(String(orphan.body?.error)).toContain('没有进行中的登录流程')

    await api.call({ url: '/glm-coding-plan/api/login/start', method: 'POST', body: { region: 'intl' } })
    const pasted = await api.call({
      url: '/glm-coding-plan/api/login/manual',
      method: 'POST',
      body: { region: 'intl', code: 'zcode://oauth/callback?code=abc' },
    })
    expect(pasted.status).toBe(200)
    // 上游已就绪，所以这一次粘贴直接完成了整条链。
    expect(await api.pool.listAccounts()).toHaveLength(1)
    api.dispose()
  })
})

describe('GLM 路由：设置与账号', () => {
  beforeEach(() => {
    resetWebLogins()
    resetInFlightBizTokenFetches()
    clearCachedQuota()
    clearCachedCatalog()
  })

  /** 走完一次浏览器登录，让池里有一行可操作的账号。 */
  async function signedIn() {
    const api = harness(upstreamFetch())
    await api.call({ url: '/glm-coding-plan/api/login/start', method: 'POST', body: { region: 'intl' } })
    await api.call({ url: '/glm-coding-plan/api/login/manual', method: 'POST', body: { region: 'intl', code: 'cb' } })
    return api
  }

  it('/settings 落盘并回整份状态，模型集合变化才影响勾选', async () => {
    const api = harness(upstreamFetch())
    const captured = await api.call({
      url: '/glm-coding-plan/api/settings',
      method: 'POST',
      body: {
        enabled: false,
        enabledModelIds: ['GLM-5.2'],
        contextWindowOverrides: { 'GLM-5.2': 262144, 'GLM-5.3': null },
        defaultReasoningEffort: 'high',
      },
    })
    expect(captured.status).toBe(200)
    const status = valueOf(captured) as unknown as GlmStatusDto
    expect(status.enabled).toBe(false)
    expect(api.settings.value().enabledModelIds).toEqual(['GLM-5.2'])
    // null 是「恢复目录默认」，活过归一化删掉恰好那一个键。
    expect(api.settings.value().contextWindowOverrides).toEqual({ 'GLM-5.2': 262144 })
    expect(api.settings.value().defaultReasoningEffort).toBe('high')
    expect(status.models.find((model) => model.id === 'GLM-5.3')?.enabled).toBe(false)
    expect(status.models.find((model) => model.id === 'GLM-5.2')?.enabled).toBe(true)
    api.dispose()
  })

  it('/settings 认不出的档位被丢掉，而不是被存成会被发出去的值', async () => {
    const api = harness(upstreamFetch())
    await api.call({
      url: '/glm-coding-plan/api/settings',
      method: 'POST',
      body: { defaultReasoningEffort: 'ultra' },
    })
    expect(api.settings.value().defaultReasoningEffort).toBeNull()
    api.dispose()
  })

  it('/accounts 支持 set-primary / clear-cooldown / relogin / strategy / delete', async () => {
    const api = await signedIn()
    const accountId = (await api.pool.listAccounts())[0]!.id

    await api.pool.markCooldown(accountId, 600_000, '测试冷却')
    await api.pool.markAuthFailed(accountId, '测试鉴权失败')
    await api.call({ url: '/glm-coding-plan/api/accounts', method: 'POST', body: { action: 'clear-cooldown', accountId } })
    let rows = await api.pool.listAccounts()
    expect(rows[0]?.cooldownUntil).toBeUndefined()
    // relogin 撤销鉴权失败标记：本线路没有 refresh 接口，重登由卡片重新开流程。
    await api.call({ url: '/glm-coding-plan/api/accounts', method: 'POST', body: { action: 'relogin', accountId } })
    rows = await api.pool.listAccounts()
    expect(rows[0]?.authStatus).toBeUndefined()

    const strategy = await api.call({
      url: '/glm-coding-plan/api/accounts',
      method: 'POST',
      body: { action: 'strategy', strategy: 'round-robin' },
    })
    expect((valueOf(strategy) as unknown as GlmStatusDto).rotationStrategy).toBe('round-robin')

    const primary = await api.call({
      url: '/glm-coding-plan/api/accounts',
      method: 'POST',
      body: { action: 'set-primary', accountId },
    })
    expect((valueOf(primary) as unknown as GlmStatusDto).activeAccountId).toBe(accountId)

    const deleted = await api.call({
      url: '/glm-coding-plan/api/accounts',
      method: 'POST',
      body: { action: 'delete', accountId },
    })
    expect((valueOf(deleted) as unknown as GlmStatusDto).accounts).toEqual([])
    api.dispose()
  })

  it('/accounts 拒绝未知动作与缺 accountId', async () => {
    const api = harness(upstreamFetch())
    const unknown = await api.call({ url: '/glm-coding-plan/api/accounts', method: 'POST', body: { action: 'nope', accountId: 'x' } })
    expect(unknown.status).toBe(400)
    const missing = await api.call({ url: '/glm-coding-plan/api/accounts', method: 'POST', body: { action: 'delete' } })
    expect(missing.status).toBe(400)
    api.dispose()
  })
})

describe('GLM 路由：配额 / 目录 / adopt / 连接测试', () => {
  beforeEach(() => {
    resetWebLogins()
    resetInFlightBizTokenFetches()
    clearCachedQuota()
    clearCachedCatalog()
  })

  async function signedIn() {
    const api = harness(upstreamFetch())
    await api.call({ url: '/glm-coding-plan/api/login/start', method: 'POST', body: { region: 'intl' } })
    await api.call({ url: '/glm-coding-plan/api/login/manual', method: 'POST', body: { region: 'intl', code: 'cb' } })
    return api
  }

  it('登录成功后自动拉的那次配额读会落在同一份应答里', async () => {
    // 回归点：/status 在没有快照时会 await 一次配额读（routes.ts 的 status 分支），
    // 而卡片在读到 complete 之后立刻读 /status——所以这条链本身就是「自动拉一次」。
    const api = harness(upstreamFetch())
    await api.call({ url: '/glm-coding-plan/api/login/start', method: 'POST', body: { region: 'intl' } })
    await api.call({ url: '/glm-coding-plan/api/login/manual', method: 'POST', body: { region: 'intl', code: 'cb' } })
    const status = valueOf(await api.call({ url: '/glm-coding-plan/api/status' })) as unknown as GlmStatusDto
    expect(status.quota?.planLevel).toBe('pro')
    expect(status.quota?.windows.map((window) => window.key)).toEqual(['five-hour'])
    expect(status.quotaError).toBeNull()
    api.dispose()
  })

  it('配额读不到时如实给出原因，而不是只留一句「暂无配额数据」', async () => {
    let failing = false
    const api = harness(upstreamFetch({ quotaFails: () => failing }))
    await api.call({ url: '/glm-coding-plan/api/login/start', method: 'POST', body: { region: 'intl' } })
    await api.call({ url: '/glm-coding-plan/api/login/manual', method: 'POST', body: { region: 'intl', code: 'cb' } })
    // 登录时的额度探活要成功，所以从这里起才让配额端点开始拒绝。
    failing = true
    const status = valueOf(await api.call({ url: '/glm-coding-plan/api/status' })) as unknown as GlmStatusDto
    expect(status.quota).toBeNull()
    // fetchGlmQuota 的失败以返回值呈现（不抛），所以它必须被记进 quotaError；
    // 否则用户分不清「上游还没准备好」与「这把 Key 读不了配额」。
    expect(typeof status.quotaError).toBe('string')
    expect(status.quotaError?.length ?? 0).toBeGreaterThan(0)
    // 账号仍然是登录好的：一次配额读失败不是一次登录失败。
    expect(status.authenticated).toBe(true)
    expect(status.login?.status).toBe('complete')
    api.dispose()
  })

  it('未登录时不存在「配额读取失败」这句话', async () => {
    const api = harness(upstreamFetch({ quotaFails: true }))
    const status = valueOf(await api.call({ url: '/glm-coding-plan/api/status' })) as unknown as GlmStatusDto
    expect(status.authenticated).toBe(false)
    // 池里没有账号时，探活报的是「号池中没有账号」，那不是配额失败。
    expect(status.quotaError).toBeNull()
    api.dispose()
  })
  it('/quota 强制刷新并把快照装配进账号配额', async () => {
    const api = await signedIn()
    const captured = await api.call({ url: '/glm-coding-plan/api/quota', method: 'POST', body: {} })
    expect(captured.status).toBe(200)
    const status = valueOf(captured) as unknown as GlmStatusDto
    expect(status.quota?.planLevel).toBe('pro')
    // TIME_LIMIT 是 MCP 请求上限，不是套餐窗口；未知 unit 也不发明窗口。
    expect(status.quota?.windows.map((window) => window.key)).toEqual(['five-hour'])
    expect(status.quota?.windows[0]?.usedPercent).toBe(25)
    const row = status.accounts?.[0]
    expect(row?.quota?.windows[0]?.windowDurationMins).toBe(300)
    // 窗口名由客户端按长度本地化，host 一律传空串。
    expect(row?.quota?.windows[0]?.label).toBe('')
    api.dispose()
  })

  it('配额接口用裸 Key：mock 对任何 Bearer 前缀直接 401，所以读到即证明', async () => {
    const api = await signedIn()
    await api.call({ url: '/glm-coding-plan/api/quota', method: 'POST', body: {} })
    expect((valueOf(await api.call({ url: '/glm-coding-plan/api/status' })) as unknown as GlmStatusDto).quota)
      .not.toBeNull()
    api.dispose()
  })

  it('/catalog/refresh 强制重拉目录并反映到 /status 的模型行', async () => {
    const api = await signedIn()
    const captured = await api.call({ url: '/glm-coding-plan/api/catalog/refresh', method: 'POST', body: {} })
    expect(captured.status).toBe(200)
    const status = valueOf(captured) as unknown as GlmStatusDto
    expect(status.models.map((model) => model.id)).toContain('GLM-5.3')
    api.dispose()
  })

  it('/adopt 直接返回 DTO（没有信封），失败也不阻断', async () => {
    const api = harness(upstreamFetch())
    // 机器上没有 ZCode 客户端凭据文件：adopt 返回一个 reason 而不是 500。
    const captured = await api.call({ url: '/glm-coding-plan/api/adopt', method: 'POST', body: { region: 'intl' } })
    expect(captured.status).toBe(200)
    expect(captured.body).not.toHaveProperty('ok')
    expect(captured.body?.adopted).toBe(false)
    expect(typeof captured.body?.reason).toBe('string')
    expect(await api.pool.listAccounts()).toEqual([])
    api.dispose()
  })

  it('/connection/test 直接返回 DTO，未登录时给出可操作原因', async () => {
    const api = harness(upstreamFetch())
    const captured = await api.call({ url: '/glm-coding-plan/api/connection/test', method: 'POST', body: {} })
    expect(captured.status).toBe(200)
    expect(captured.body).not.toHaveProperty('ok')
    expect(captured.body?.connected).toBe(false)
    expect(String(captured.body?.error)).toContain('还没有登录')
    api.dispose()
  })

  it('/connection/test 在有账号时用裸 Key 验活并回一个模型名', async () => {
    const api = await signedIn()
    const captured = await api.call({ url: '/glm-coding-plan/api/connection/test', method: 'POST', body: {} })
    expect(captured.body?.connected).toBe(true)
    expect(typeof captured.body?.latencyMs).toBe('number')
    expect(typeof captured.body?.model).toBe('string')
    expect((captured.body?.account as { region?: string } | undefined)?.region).toBe('intl')
    api.dispose()
  })

  it('未知路由 404、方法不对 405', async () => {
    const api = harness(upstreamFetch())
    const missing = await api.call({ url: '/glm-coding-plan/api/nope' })
    expect(missing.status).toBe(404)
    const wrongMethod = await api.call({ url: '/glm-coding-plan/api/status', method: 'POST', body: {} })
    expect(wrongMethod.status).toBe(405)
    api.dispose()
  })
})

describe('GLM 路由：/login/start 不许弹出系统浏览器', () => {
  beforeEach(() => {
    resetWebLogins()
    resetInFlightBizTokenFetches()
    clearCachedQuota()
    clearCachedCatalog()
    spawnSpy.mockClear()
  })

  it('整条 /login/start 一个进程都不 spawn：装配必须注入空 openBrowser', async () => {
    const api = harness(upstreamFetch())
    const captured = await api.call({
      url: '/glm-coding-plan/api/login/start',
      method: 'POST',
      body: { region: 'intl' },
    })
    // 功能断言照旧：这条护栏管的是副作用，不是把功能一起断言没了。
    expect(captured.status).toBe(200)
    expect((valueOf(captured) as unknown as GlmLoginFlowStatus).authorizeUrl).toContain('chat.z.ai')
    // 回归点：oauth.ts:492 取的是「注入的开浏览器 ?? 平台默认那份」，默认那份会
    // spawn('cmd', ['/c', 'start', ...])。装配漏注入时这里立刻红。
    expect(spawnSpy.mock.calls.map(([command]) => command)).toEqual([])
    api.dispose()
  })

  it('生产接线（src/index.ts 一栏都不传）整条 /login/start 也是一个进程都不 spawn', async () => {
    // 这一档才是今天线上跑的那一档：卡片自己 window.open 授权页，host 恒定给出
    // 一个空 opener。曾经这里是「装配不注入 → oauth.ts 的平台默认 → 真弹窗」，
    // 于是每次登录都弹出两个一模一样的页面。卡片是唯一开浏览器的地方。
    const api = harness(upstreamFetch(), { omit: true })
    const captured = await api.call({
      url: '/glm-coding-plan/api/login/start',
      method: 'POST',
      body: { region: 'intl' },
    })
    expect(captured.status).toBe(200)
    expect((valueOf(captured) as unknown as GlmLoginFlowStatus).authorizeUrl).toContain('chat.z.ai')
    expect(spawnSpy.mock.calls.map(([command]) => command)).toEqual([])
    api.dispose()
  })

  it('显式注入的 opener 会被真的用上，否则这一栏只是个摆设', async () => {
    // 缺省恒定是空函数，但显式传入时必须用传入的那一份——否则将来没人能在这里
    // 换掉「谁来开浏览器」，而这条缝隙存在的理由就是给测试留这一个口。
    const opened: string[] = []
    const api = harness(upstreamFetch(), { openBrowser: (url) => { opened.push(url) } })
    const captured = await api.call({
      url: '/glm-coding-plan/api/login/start',
      method: 'POST',
      body: { region: 'intl' },
    })
    expect(captured.status).toBe(200)
    expect(opened).toHaveLength(1)
    expect(opened[0]).toContain('chat.z.ai')
    // 注入的那一份不是平台的 spawn，所以仍然一个进程都没起。
    expect(spawnSpy.mock.calls.map(([command]) => command)).toEqual([])
    api.dispose()
  })

  it('正向对照：护栏看得见一次真实的浏览器启动，否则上一条只是空断言', () => {
    // 直接调生产那份 openBrowser；本文件的 mock 只记不执行，所以这里不会真的开窗口。
    openRealBrowser('https://chat.z.ai/api/oauth/authorize?client_id=x')
    expect(spawnSpy).toHaveBeenCalledTimes(1)
    expect(BROWSER_COMMANDS).toContain(String(spawnSpy.mock.calls[0]![0]))
  })
})





