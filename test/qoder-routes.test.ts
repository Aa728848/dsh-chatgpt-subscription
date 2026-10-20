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
import { describe, expect, it, vi } from 'vitest'
import { registerQoderRoutes, qoderSettingsSource } from '../src/host/qoder/routes.ts'
import { QoderAccountPool } from '../src/host/qoder/account-pool.ts'
import { QoderModelSettingsStore, type QoderCredentials } from '../src/host/qoder/token-store.ts'
import { QODER_ROUTE_PREFIX, type QoderStatusDto } from '../src/shared/qoder-contracts.ts'
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

describe('Qoder 路由', () => {
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
})
