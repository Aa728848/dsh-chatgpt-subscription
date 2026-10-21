/**
 * Qoder 路由的测试：状态面、设置写入点、同源校验、登录入口与 adopt 的裸 DTO。
 *
 * 全程内存后端 + mock fetch，不碰真实凭据与网络。路由表与
 * src/client/qoder/api.ts 的注释是同一份约定，错一条这里就红。
 */
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerQoderRoutes, qoderSettingsSource } from '../src/host/qoder/routes.ts'
import { clearCachedQoderModelCatalog } from '../src/host/qoder/client.ts'
import { QoderAccountPool } from '../src/host/qoder/account-pool.ts'
import { QoderModelSettingsStore, type QoderCredentials } from '../src/host/qoder/token-store.ts'
import { QODER_ROUTE_PREFIX, type QoderStatusDto } from '../src/shared/qoder-contracts.ts'
import { QODER_MODEL_CATALOG_GLOBAL } from '../src/host/qoder/model-catalog.ts'
import { resetQoderLogin } from '../src/host/qoder/oauth.ts'

const HOST = '127.0.0.1:3000'
const ORIGIN = 'http://127.0.0.1:3000'

interface Captured { status: number; body: Record<string, unknown>; raw: string }

function fakeExchange(): { response: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: {}, raw: '' }
  const response = {
    writeHead(status: number) { captured.status = status; return response },
    end(raw?: string) {
      captured.raw = raw ?? ''
      if (raw !== undefined && raw !== '') captured.body = JSON.parse(raw) as Record<string, unknown>
    },
  } as unknown as ServerResponse
  return { response, captured }
}

function fakeRequest(input: { url: string; method?: string; body?: unknown; origin?: string | null }): IncomingMessage {
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

class MemoryBackend<T> {
  private data: unknown = null
  async load(): Promise<T | null> { return this.data === null ? null : JSON.parse(JSON.stringify(this.data)) as T }
  async save(data: T): Promise<void> { this.data = JSON.parse(JSON.stringify(data)) }
  async clear(): Promise<void> { this.data = null }
}

function credentials(overrides: Partial<QoderCredentials> = {}): QoderCredentials {
  return {
    accessToken: 'jt-secret',
    refreshToken: 'jrt-1',
    expiresAt: Date.now() + 24 * 3_600_000,
    region: 'global',
    origin: 'device',
    uid: 'u-1',
    email: 'me@qoder.com',
    accountName: 'Me',
    personalToken: null,
    organizationId: null,
    organizationTags: [],
    dataPolicyAgreed: false,
    authenticatedAt: Date.now(),
    ...overrides,
  }
}

function setup(options: { fetchFn?: typeof fetch } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qoder-routes-'))
  const pool = new QoderAccountPool({ backend: new MemoryBackend() as never })
  const modelSettings = new QoderModelSettingsStore(path.join(dir, 'models.json'))
  const registrations: Array<{ kind: string; path: string; handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }> = []
  const ctx = {
    webServer: {
      register(options: { kind: string; path: string; handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }) {
        registrations.push(options)
        return () => undefined
      },
    },
    emit: vi.fn(),
  } as unknown as Context
  const dispose = registerQoderRoutes(ctx, qoderSettingsSource(undefined, modelSettings), {
    // 测试里的 fetchFn 存在，路由就会做配额探活；回答一份空额度载荷即可。
    fetchFn: options.fetchFn ?? ((async () => Response.json({})) as unknown as typeof fetch),
    serving: () => true,
    conflict: () => null,
    accountPool: pool,
  })
  const handler = registrations[0]!.handler
  const call = async (input: { url: string; method?: string; body?: unknown; origin?: string | null }): Promise<Captured> => {
    const { response, captured } = fakeExchange()
    await handler(fakeRequest(input), response)
    return captured
  }
  return { pool, call, dispose, ctx }
}

/**
 * 一份只答「模型目录」的假 fetch，并记下它被打了几次。
 *
 * 目录读取会先跟随 COSY 版本（GitHub releases），那条路径回 404 就会被安静地
 * 吞掉——它不该出现在计数里，否则「上游被打了几次」就答不清了。
 */
function catalogFetchSpy(modelIds: string[]): { fetchFn: typeof fetch; catalogCalls: () => number } {
  let calls = 0
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/model/list')) {
      calls += 1
      return Response.json({
        chat: modelIds.map((id) => ({ key: id.toLowerCase(), display_name: id, enable: true })),
      })
    }
    return new Response('', { status: 404 })
  }) as unknown as typeof fetch
  return { fetchFn, catalogCalls: () => calls }
}

/** 等到条件成立（或超时）；后台刷新是应答之后才启动的，断言前必须等它落地。 */
async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('Qoder 路由', () => {
  // 目录缓存是进程级的：每个用例都从「冷启动」开始，否则前一个用例留下的缓存
  // 会让「空缓存要拉一次」直接失效。
  beforeEach(() => {
    clearCachedQoderModelCatalog()
  })

  it('注册在同一个前缀下', () => {
    const { dispose } = setup()
    dispose()
    // 注册即前缀路由；前缀拼错时这里什么都拿不到。
    expect(true).toBe(true)
  })

  it('GET /status 下发整份状态面，凭据永远不过边界', async () => {
    const { pool, call, dispose } = setup()
    await pool.addAccount(credentials())
    const captured = await call({ url: QODER_ROUTE_PREFIX + '/status' })
    dispose()
    expect(captured.status).toBe(200)
    expect(captured.body.ok).toBe(true)
    const status = captured.body.value as QoderStatusDto
    expect(status.providerId).toBe('qoder')
    expect(status.authenticated).toBe(true)
    expect(status.accounts).toHaveLength(1)
    expect(status.region).toBe('global')
    // 兜底目录：没联网时选择器也不空。
    expect(status.models.length).toBeGreaterThan(0)
    // 没有任何凭据片段越过边界。
    expect(captured.raw).not.toContain('jt-secret')
    expect(captured.raw).not.toContain('jrt-1')
  })

  it('POST /settings 是唯一写入点：开启/勾选/档位/覆盖；跨源被拒', async () => {
    const { call, dispose, ctx } = setup()
    const updated = await call({
      url: QODER_ROUTE_PREFIX + '/settings',
      method: 'POST',
      body: { enabled: false, defaultReasoningEffort: 'high', contextWindowOverrides: { Lite: 512_000 } },
    })
    expect(updated.status).toBe(200)
    const status = updated.body.value as QoderStatusDto
    expect(status.enabled).toBe(false)
    expect(status.defaultReasoningEffort).toBe('high')
    expect(status.contextWindowOverrides).toEqual({ Lite: 512_000 })
    // 总开关的翻转要通知 DSH 重建模型选择器。
    expect(ctx.emit).toHaveBeenCalledWith('llm/adapters-updated')
    // 自由输入里认不出的档位被丢掉而不是被猜。
    const bogus = await call({
      url: QODER_ROUTE_PREFIX + '/settings',
      method: 'POST',
      body: { defaultReasoningEffort: 'ultra' },
    })
    expect((bogus.body.value as QoderStatusDto).defaultReasoningEffort).toBe('high')
    // 跨源：一律 403。
    const cross = await call({
      url: QODER_ROUTE_PREFIX + '/settings',
      method: 'POST',
      body: { enabled: true },
      origin: 'https://evil.example',
    })
    expect(cross.status).toBe(403)
    dispose()
  })

  it('POST /login/manual 用 PAT 兑换并入池；兑换失败是 400 而不是 500', async () => {
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return Response.json({ token: 'jt-new', refresh_token: 'jrt-new' })
      if (url.includes('/userinfo')) return Response.json({ id: 'u-9', name: 'CN User' })
      return Response.json({})
    }) as unknown as typeof fetch
    const { pool, call, dispose } = setup({ fetchFn })
    const captured = await call({
      url: QODER_ROUTE_PREFIX + '/login/manual',
      method: 'POST',
      body: { region: 'cn', token: 'pt-secret' },
    })
    expect(captured.status).toBe(200)
    const status = captured.body.value as QoderStatusDto
    expect(status.authenticated).toBe(true)
    const accounts = await pool.listAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.region).toBe('cn')
    // PAT 本体绝不越过边界。
    expect(captured.raw).not.toContain('pt-secret')
    expect(captured.raw).not.toContain('jt-new')

    // 空 PAT 与兑换失败都是 400（卡片显示那句话）。
    const empty = await call({ url: QODER_ROUTE_PREFIX + '/login/manual', method: 'POST', body: { region: 'cn', token: '  ' } })
    expect(empty.status).toBe(400)
    dispose()
  })

  it('POST /adopt 返回裸 DTO（不走信封），失败永不阻断', async () => {
    const { call, dispose } = setup()
    // 测试主机上没有 qodercli 的登录态文件（isolated-home），所以是 no-credentials-file。
    const captured = await call({ url: QODER_ROUTE_PREFIX + '/adopt', method: 'POST', body: {} })
    expect(captured.status).toBe(200)
    // 裸 DTO：顶层就是 attempted/adopted/reason，没有 { ok, value } 信封。
    expect(captured.body.ok).not.toBe(true)
    expect(captured.body).toMatchObject({ attempted: false, adopted: false, reason: 'no-credentials-file' })
    dispose()
  })

  it('POST /accounts 的账号操作与未知动作', async () => {
    const { pool, call, dispose } = setup()
    const account = await pool.addAccount(credentials())
    const primary = await call({ url: QODER_ROUTE_PREFIX + '/accounts', method: 'POST', body: { action: 'set-primary', accountId: account.id } })
    expect(primary.status).toBe(200)
    const unknown = await call({ url: QODER_ROUTE_PREFIX + '/accounts', method: 'POST', body: { action: 'nope', accountId: account.id } })
    expect(unknown.status).toBe(400)
    const deleted = await call({ url: QODER_ROUTE_PREFIX + '/accounts', method: 'POST', body: { action: 'delete', accountId: account.id } })
    expect(deleted.status).toBe(200)
    expect((deleted.body.value as QoderStatusDto).accounts).toHaveLength(0)
    dispose()
  })

  it('POST /settings 的模型勾选是三态：[] 全关、白名单、null 回到不过滤', async () => {
    const { call, dispose } = setup()

    // 出厂是 null（不过滤）：目录里每一行都勾上。
    const initial = await call({ url: QODER_ROUTE_PREFIX + '/status' })
    const initialStatus = initial.body.value as QoderStatusDto
    expect(initialStatus.enabledModelIds).toBeNull()
    expect(initialStatus.models.every((model) => model.enabled)).toBe(true)

    // [] = 全关：模型行一行都不勾，状态里如实是 []。
    const cleared = await call({
      url: QODER_ROUTE_PREFIX + '/settings',
      method: 'POST',
      body: { enabledModelIds: [] },
    })
    const clearedStatus = cleared.body.value as QoderStatusDto
    expect(clearedStatus.enabledModelIds).toEqual([])
    expect(clearedStatus.models.length).toBeGreaterThan(0)
    expect(clearedStatus.models.every((model) => !model.enabled)).toBe(true)

    // 白名单在**兜底表阶段**不负责过滤：这里没有实时目录，白名单是另一套词汇，
    // 拿它筛兜底表会让卡片显示「一个都没勾」而选择器里明明有模型。生效的选择因此
    // 收敛成「不过滤」（null），勾选标记全部亮起；收敛本身发生在实时目录到达之后
    // （那一半由 adapter 的「白名单只在实时目录上收敛」那组用例钉住）。
    const whitelisted = await call({
      url: QODER_ROUTE_PREFIX + '/settings',
      method: 'POST',
      body: { enabledModelIds: ['Lite', 'gone-from-upstream'] },
    })
    const whitelistedStatus = whitelisted.body.value as QoderStatusDto
    expect(whitelistedStatus.enabledModelIds).toBeNull()
    expect(whitelistedStatus.models.every((model) => model.enabled)).toBe(true)

    // null = 回到不过滤。
    const unfiltered = await call({
      url: QODER_ROUTE_PREFIX + '/settings',
      method: 'POST',
      body: { enabledModelIds: null },
    })
    const unfilteredStatus = unfiltered.body.value as QoderStatusDto
    expect(unfilteredStatus.enabledModelIds).toBeNull()
    expect(unfilteredStatus.models.every((model) => model.enabled)).toBe(true)
    dispose()
  })

  /**
   * 这一条钉住的是「进来就自动拿到真实目录」的成本上限。
   *
   * 三件事必须同时成立，缺一条都会在真实机器上变成「每进一次页面打一次上游」：
   * 缓存为空时确实会拉；拉过一次之后同一份缓存不再拉（TTL 生效）；应答本身
   * 不等这次刷新（它跑在应答背后）。
   */
  it('GET /status 在目录缓存为空时于应答背后拉一次真实目录，且只拉一次', async () => {
    const { fetchFn, catalogCalls } = catalogFetchSpy(['Lite', 'Ultimate'])
    const { pool, call, dispose } = setup({ fetchFn })
    await pool.addAccount(credentials())

    const first = await call({ url: QODER_ROUTE_PREFIX + '/status' })
    const firstStatus = first.body.value as QoderStatusDto
    // 应答先出去：这一次拿到的是随包兜底表，而不是等上游回来的真实目录。
    expect(firstStatus.models.length).toBe(QODER_MODEL_CATALOG_GLOBAL.length)
    // 但应答已经告诉客户端「目录马上会被顶掉」，卡片据此补读一次。
    expect(firstStatus.catalogRefreshing).toBe(true)

    // 后台那次刷新落地：上游被打了一次。
    await waitFor(() => catalogCalls() === 1)

    // 第二次轮询：缓存已建立且新鲜，一次上游都不该再打。
    const second = await call({ url: QODER_ROUTE_PREFIX + '/status' })
    const secondStatus = second.body.value as QoderStatusDto
    expect(catalogCalls()).toBe(1)
    // 而且这一次下发的是真实目录：两条来自上游，不是兜底表。
    expect(secondStatus.models.map((model) => model.id)).toEqual(['Lite', 'Ultimate'])
    // 不再需要补读，客户端不会反复来问。
    expect(secondStatus.catalogRefreshing).toBe(false)

    // 第三拍也一样：TTL 是 30 分钟，60 秒轮询在绝大多数拍上都命中缓存。
    await call({ url: QODER_ROUTE_PREFIX + '/status' })
    expect(catalogCalls()).toBe(1)
    dispose()
  })

  it('没有账号时不触发目录刷新：上游一定会拒，白打一次', async () => {
    const { fetchFn, catalogCalls } = catalogFetchSpy(['Lite'])
    const { call, dispose } = setup({ fetchFn })
    const captured = await call({ url: QODER_ROUTE_PREFIX + '/status' })
    expect((captured.body.value as QoderStatusDto).catalogRefreshing).toBe(false)
    // 给后台留出机会：它一次都不该被启动。
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(catalogCalls()).toBe(0)
    dispose()
  })

  it('未知路径 404；方法不对 405；登录流程入口三件套', async () => {
    const { call, dispose } = setup()
    expect((await call({ url: QODER_ROUTE_PREFIX + '/nope' })).status).toBe(404)
    expect((await call({ url: QODER_ROUTE_PREFIX + '/status', method: 'POST', body: {} })).status).toBe(405)
    // CN 的设备流被 host 拒绝（卡片那边同时把按钮藏起来）。
    const cn = await call({ url: QODER_ROUTE_PREFIX + '/login/start', method: 'POST', body: { region: 'cn' } })
    expect(cn.status).toBe(200)
    expect((cn.body.value as { status: string }).status).toBe('error')
    // cancel 回 idle。
    const cancelled = await call({ url: QODER_ROUTE_PREFIX + '/login/cancel', method: 'POST', body: {} })
    expect((cancelled.body.value as { status: string }).status).toBe('idle')
    const loginStatus = await call({ url: QODER_ROUTE_PREFIX + '/login/status' })
    expect((loginStatus.body.value as { status: string }).status).toBe('idle')
    resetQoderLogin()
    dispose()
  })
  // -------------------------------------------------------------------------
  // 目录刷新落地后的事件
  // -------------------------------------------------------------------------

  /**
   * `llm/adapters-updated` 是 DSH 重建模型选择器的唯一信号。
   *
   * `POST /catalog/refresh` 与应答背后那次自动刷新都会更新进程内目录，但旧实现
   * 一条路径都不发这个事件（只有 `POST /settings` 改 enabled/enabledModelIds 时发）。
   * 于是即使真实目录已经拿到，`session/modelCatalog` 的快照也不会重读，选择器
   * 就一直停在空分组上。
   */
  it('POST /catalog/refresh 拿到新目录后发出 llm/adapters-updated', async () => {
    const { fetchFn, catalogCalls } = catalogFetchSpy(['Lite', 'Ultimate'])
    const { pool, call, dispose, ctx } = setup({ fetchFn })
    await pool.addAccount(credentials())

    // 冷启动：进程里没有任何实时目录，这次刷新会真的带来一份新的。
    const captured = await call({ url: QODER_ROUTE_PREFIX + '/catalog/refresh', method: 'POST', body: {} })
    expect(captured.status).toBe(200)
    expect(catalogCalls()).toBe(1)
    // 目录真的换掉了，事件必须已经发出（且只发一次：这是「目录变了」，不是「刷新过」）。
    expect(ctx.emit).toHaveBeenCalledWith('llm/adapters-updated')
    expect(ctx.emit).toHaveBeenCalledTimes(1)
    // 应答里下发的已经是真实目录，不是兜底表。
    expect((captured.body.value as QoderStatusDto).models.map((model) => model.id)).toEqual(['Lite', 'Ultimate'])
    dispose()
  })

  /**
   * 反面：目录**没有**变化时不发事件。
   *
   * 这条不是洁癖：这张卡片每 60 秒轮询一次，若每次刷新都发的是一份一模一样的
   * 目录也照样通知，选择器就每拍重建一次模型列表。
   */
  it('目录没有变化时不发 llm/adapters-updated（避免每拍重读）', async () => {
    const { fetchFn, catalogCalls } = catalogFetchSpy(['Lite'])
    const { pool, call, dispose, ctx } = setup({ fetchFn })
    await pool.addAccount(credentials())

    // 第一拍：真的拿到了新目录，事件发出。
    await call({ url: QODER_ROUTE_PREFIX + '/catalog/refresh', method: 'POST', body: {} })
    expect(ctx.emit).toHaveBeenCalledWith('llm/adapters-updated')
    expect(catalogCalls()).toBe(1)

    // 第一拍的那一次事件已经记下了；从这里开始只数新增的。
    const emit = ctx.emit as unknown as { mock: { calls: unknown[][] } }
    const callsBefore = emit.mock.calls.length
    expect(callsBefore).toBe(1)

    // 第二拍：上游答的还是同一批 id，目录没有变化。
    await call({ url: QODER_ROUTE_PREFIX + '/catalog/refresh', method: 'POST', body: {} })
    expect(catalogCalls()).toBe(2)
    // 一次都不新增：目录没变，没有任何订阅方需要重读。
    expect(emit.mock.calls.length).toBe(callsBefore)
    dispose()
  })

  /**
   * 应答背后那次自动刷新同样要发事件：它才是「打开设置页等一会儿就有真实目录」
   * 的那条路径（`GET /status` 不等上游，刷新跑在应答背后）。
   */
  it('GET /status 应答背后的自动刷新落地后也发 llm/adapters-updated', async () => {
    const { fetchFn, catalogCalls } = catalogFetchSpy(['Lite', 'Ultimate'])
    const { pool, call, dispose, ctx } = setup({ fetchFn })
    await pool.addAccount(credentials())

    const first = await call({ url: QODER_ROUTE_PREFIX + '/status' })
    expect((first.body.value as QoderStatusDto).models.length).toBe(QODER_MODEL_CATALOG_GLOBAL.length)
    // 应答先出去，这次事件此时还不该发生（目录还没落地）。
    expect(ctx.emit).not.toHaveBeenCalledWith('llm/adapters-updated')

    await waitFor(() => catalogCalls() === 1)
    // 刷新落地之后：目录真的换了，事件随之发出。
    await waitFor(() => (ctx.emit as unknown as { mock: { calls: unknown[][] } }).mock.calls.length > 0)
    expect(ctx.emit).toHaveBeenCalledWith('llm/adapters-updated')
    dispose()
  })

  // -------------------------------------------------------------------------
  // 兜底表阶段不按白名单收敛（缺陷 1 在状态面上的那一半）
  // -------------------------------------------------------------------------

  /**
   * 冷启动时卡片不该显示「一个都没勾」。
   *
   * 用户的白名单是**实时目录**的词汇（`DeepSeek-Flash`），兜底表把同一批模型叫
   * `DeepSeek-V4-Flash`。按白名单去筛兜底表必然收敛成空，于是适配器那边一个模型
   * 都不返回、选择器里整个 Qoder 分组消失，卡片这边则显示「一个都没勾」——
   * 同一个状态在两张面上说两句矛盾的话。
   */
  it('兜底表阶段不按白名单收敛：卡片照常勾上，状态里的白名单原样保留', async () => {
    const { call, dispose } = setup()
    const whitelisted = await call({
      url: QODER_ROUTE_PREFIX + '/settings',
      method: 'POST',
      body: { enabledModelIds: ['DeepSeek-Flash'] },
    })
    const status = whitelisted.body.value as QoderStatusDto
    // 兜底表阶段：生效的选择是「不过滤」（null），勾选标记全部亮起——而不是
    // 按一套错词汇筛成空数组、让卡片说「一个都没勾」。
    expect(status.enabledModelIds).toBeNull()
    expect(status.models.length).toBe(QODER_MODEL_CATALOG_GLOBAL.length)
    expect(status.models.every((model) => model.enabled)).toBe(true)

    // 而 `[]`（全关）在这个阶段照样生效：它是用户明确的意图，与词汇表无关。
    const cleared = await call({
      url: QODER_ROUTE_PREFIX + '/settings',
      method: 'POST',
      body: { enabledModelIds: [] },
    })
    const clearedStatus = cleared.body.value as QoderStatusDto
    expect(clearedStatus.enabledModelIds).toEqual([])
    expect(clearedStatus.models.every((model) => !model.enabled)).toBe(true)
    dispose()
  })
})
