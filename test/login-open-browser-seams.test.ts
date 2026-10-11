/**
 * 每条线路都要留一个「谁来开浏览器」的口子。
 *
 * GLM 真的踩过一次同款事故——卡片 window.open 一次、host 又 spawn 一次，于是每次
 * 登录都弹出两个一模一样的授权页。收口时全仓复查又找出两处同形状的隐患：今天还没有
 * 用例会触发它们，可将来只要有人给 kimi 的 /login 或 antigravity 的 loginAndSave
 * 补一条用例，就会在跑测试的机器上真的弹出窗口，而写用例的人不会事先知道。
 *
 * 这两条线路不在那次修复的范围里，所以这里的改动是**纯增量**：生产行为一个字没变，
 * 只是把「开浏览器」这件事变成可注入的。这一份钉的就是这件事——口子存在，且缺省
 * 仍然是生产原本的那一份。分工与 login-opens-browser-once.test.ts 相反：那一份钉的
 * 是「host 不许开」（GLM / Claude / Command Code），这一份钉的是「口子不许没有」。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  // 浏览器启动**记下来但不执行**：跑一次测试绝不能在人的机器上开窗口，而「漏注入」
  // 于是变成一条红断言，而不是一次外部副作用。别的命令照常走真实现。
  const inert = { on: () => inert, unref: () => inert }
  const spawn = vi.fn((command: string, ...rest: unknown[]) => (['cmd', 'open', 'xdg-open'].includes(command)
    ? inert
    : (actual.spawn as (...args: unknown[]) => unknown)(command, ...rest)))
  return { ...actual, spawn }
})
vi.mock('../src/host/kimi-code/oauth.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/kimi-code/oauth.ts')>()
  return {
    ...actual,
    // 真的开流会去要设备码并在后台轮询；这里要验的是路由把哪一份 opener 递下去。
    beginWebLogin: vi.fn(async () => ({
      status: 'pending',
      verificationUriComplete: 'https://auth.kimi.com/device?user_code=ABCD-EFGH',
      userCode: 'ABCD-EFGH',
    })),
  }
})

const childProcess = await import('node:child_process')
const spawnSpy = vi.mocked(childProcess.spawn)
const kimiOauth = await import('../src/host/kimi-code/oauth.ts')
const { registerKimiCodeRoutes } = await import('../src/host/kimi-code/routes.ts')
const KimiStores = await import('../src/host/kimi-code/token-store.ts')
const { loginAndSave } = await import('../src/host/antigravity/oauth.ts')
import type { FileCredentialStore } from '../src/host/antigravity/token-store.ts'

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>

function tmpFile(name: string): string {
  return path.join(os.tmpdir(), name + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json')
}

/** Register one route surface and return its handler. */
function capture(register: (ctx: Context) => void): Handler {
  const routes: Array<{ handler: Handler }> = []
  const ctx = {
    webServer: { register(route: { handler: Handler }) { routes.push(route); return () => undefined } },
    emit: () => undefined,
  } as unknown as Context
  register(ctx)
  return routes[0]!.handler
}

/** A same-origin JSON POST. */
async function post(handler: Handler, url: string): Promise<{ status: number; body: { ok: boolean } }> {
  const chunks = [Buffer.from('{}')]
  const request = {
    url,
    method: 'POST',
    headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
    on(event: string, listener: (value?: unknown) => void) {
      if (event === 'data') for (const chunk of chunks) listener(chunk)
      if (event === 'end') listener()
      return request
    },
    destroy() {},
  } as unknown as IncomingMessage
  const captured = { status: 0, body: { ok: false } as { ok: boolean } }
  const response = {
    writeHead(status: number) { captured.status = status; return response },
    end(raw?: string) { if (raw !== undefined) captured.body = JSON.parse(raw) },
  } as unknown as ServerResponse
  await handler(request, response)
  return captured
}

function kimiHandler(openBrowser?: (url: string) => void): Handler {
  return capture((ctx) => registerKimiCodeRoutes(
    ctx,
    new KimiStores.FileCredentialStore(tmpFile('kimi-seam-cred')),
    new KimiStores.FileModelSettingsStore(tmpFile('kimi-seam-models')),
    undefined,
    {
      fetchFn: (async () => Response.json({})) as unknown as typeof fetch,
      ...(openBrowser === undefined ? {} : { openBrowser }),
    },
  ))
}

/**
 * 走到「开浏览器」为止就中止的凭据存储。
 *
 * loginAndSave 先开回调服务、再开浏览器、然后才检查 abort，所以这一个中止信号足以
 * 让它在写盘之前抛出；而它一次也没读过这个存储。真的 FileCredentialStore 在 Windows
 * 上读一次要 spawn powershell 走 DPAPI，这条用例要验的不是平台加密。
 */
function antigravityStore(): FileCredentialStore {
  return {
    read: async () => null,
    write: async () => undefined,
    clear: async () => undefined,
  } as unknown as FileCredentialStore
}

/** Calls that would put a browser window in front of the user. */
function browserLaunches(): unknown[][] {
  return spawnSpy.mock.calls.filter(([command]) => ['cmd', 'open', 'xdg-open'].includes(String(command)))
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('kimi-code: /login 留着一个可注入的 opener', () => {
  it('装配注入的 opener 会被原样交给登录流程', async () => {
    const opened: string[] = []
    const result = await post(kimiHandler((url) => { opened.push(url) }), '/kimi-code/api/login')
    expect(result.status).toBe(200)

    const begin = vi.mocked(kimiOauth.beginWebLogin)
    expect(begin).toHaveBeenCalledTimes(1)
    const options = begin.mock.calls[0]![1]!
    expect(options.openBrowser).toBeTypeOf('function')
    options.openBrowser!('https://auth.kimi.com/device?user_code=ABCD-EFGH')
    expect(opened).toEqual(['https://auth.kimi.com/device?user_code=ABCD-EFGH'])
    expect(browserLaunches()).toEqual([])
  })

  it('装配不注入时 opener 就是 undefined，生产仍由 oauth.ts 的平台实现来开', async () => {
    // 「生产行为未变」的证据：src/index.ts 一栏都不传，路由递给流程的值与加这一栏
    // 之前逐字相同（undefined），oauth.ts 的「注入的 ?? 平台默认」于是仍取到平台默认
    // ——线上依旧会开浏览器，这两条线路本次只补口子、不改行为。
    const result = await post(kimiHandler(), '/kimi-code/api/login')
    expect(result.status).toBe(200)
    const options = vi.mocked(kimiOauth.beginWebLogin).mock.calls[0]![1]!
    expect(options.openBrowser).toBeUndefined()

    // 正向对照：平台默认那份真的会 spawn 浏览器（本文件的 mock 只记不执行）。
    kimiOauth.openBrowser('https://auth.kimi.com/device?user_code=ABCD-EFGH')
    expect(browserLaunches()).toHaveLength(1)
  })
})

describe('antigravity: loginAndSave 留着一个可注入的 opener', () => {
  it('注入的 opener 被真的用上，而不是硬编码那一份', async () => {
    const opened: string[] = []
    await expect(loginAndSave(
      antigravityStore(),
      AbortSignal.abort(),
      undefined,
      undefined,
      undefined,
      (url) => { opened.push(url) },
    )).rejects.toThrow(/aborted/i)
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatch(/^https:\/\//)
    expect(browserLaunches()).toEqual([])
  })

  it('不注入时走的仍是平台实现，生产行为未变', async () => {
    // 反向证据：同一段流程，不注入就落到 oauth.ts 自己那份，会 spawn 浏览器。
    await expect(loginAndSave(antigravityStore(), AbortSignal.abort())).rejects.toThrow(/aborted/i)
    expect(browserLaunches()).toHaveLength(1)
    expect(['cmd', 'open', 'xdg-open']).toContain(String(spawnSpy.mock.calls[0]![0]))
  })
})
