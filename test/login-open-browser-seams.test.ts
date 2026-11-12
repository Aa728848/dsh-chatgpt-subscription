/**
 * 每条线路都要留一个「谁来开浏览器」的口子。
 *
 * GLM 真的踩过一次同款事故——卡片 window.open 一次、host 又 spawn 一次，于是每次
 * 登录都弹出两个一模一样的授权页。Kimi 的登录路由也需要同样的可注入口子，
 * 否则测试会真的弹出窗口，而写用例的人不会事先知道。
 *
 * 这一份钉的就是这件事——口子存在，且缺省
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
