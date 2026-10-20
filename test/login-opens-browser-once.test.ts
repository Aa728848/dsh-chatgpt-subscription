/**
 * A sign-in opens the authorization page ONCE.
 *
 * The settings card opens the page itself (`window.open`, which the desktop
 * shell hands to the system browser). The Claude, Command Code and GLM hosts used
 * to open the same URL again from `/login`, so every sign-in showed the user two
 * identical login pages. These tests pin the host side: `/login` must answer the
 * URL for the card and launch nothing on its own.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  // A browser launch is recorded and NOT performed (a failing run must not open
  // real windows); anything else runs for real.
  const inert = { on: () => inert, unref: () => inert }
  const spawn = vi.fn((command: string, ...rest: unknown[]) => (['cmd', 'open', 'xdg-open'].includes(command)
    ? inert
    : (actual.spawn as (...args: unknown[]) => unknown)(command, ...rest)))
  return { ...actual, spawn }
})
vi.mock('../src/host/glm-coding-plan/oauth.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/glm-coding-plan/oauth.ts')>()
  return {
    ...actual,
    // Same reason as the Command Code stub below: the flow itself talks to the
    // upstream and keeps polling, and what is under test here is the route's
    // choice of opener, not the flow.
    beginWebLogin: vi.fn(async () => ({
      status: 'pending',
      loginId: 'login-1',
      credentials: null,
      region: 'intl',
      authorizeUrl: 'https://chat.z.ai/api/oauth/authorize?client_id=x',
    })),
  }
})
vi.mock('../src/host/command-code/oauth.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/command-code/oauth.ts')>()
  return {
    ...actual,
    // The real flow binds a callback listener and offers no cancel; the route's
    // choice of opener is what this file is about, so the flow itself is stubbed.
    beginWebLogin: vi.fn(async () => ({ status: 'pending', authUrl: 'https://commandcode.ai/auth?x=1' })),
  }
})

const childProcess = await import('node:child_process')
const spawnSpy = vi.mocked(childProcess.spawn)
const { registerClaudeRoutes, ROUTE_PREFIX: CLAUDE_PREFIX } = await import('../src/host/claude/routes.ts')
const { FileCredentialStore, FileModelSettingsStore } = await import('../src/host/claude/token-store.ts')
const { cancelLogin } = await import('../src/host/claude/oauth.ts')
const commandCodeOauth = await import('../src/host/command-code/oauth.ts')
const { registerCommandCodeRoutes } = await import('../src/host/command-code/routes.ts')
const CommandCodeStores = await import('../src/host/command-code/token-store.ts')
const glmOauth = await import('../src/host/glm-coding-plan/oauth.ts')
const { registerGlmCodingPlanRoutes } = await import('../src/host/glm-coding-plan/routes.ts')
const { GLM_CODING_PLAN_ROUTE_PREFIX: GLM_PREFIX } = await import('../src/shared/glm-coding-plan-contracts.ts')
const { ClinePassLoginManager } = await import('../src/host/cline-pass/oauth.ts')
const { registerClinePassRoutes } = await import('../src/host/cline-pass/routes.ts')
const { ClinePassAccountPool } = await import('../src/host/cline-pass/account-pool.ts')
const { createClinePassStore } = await import('../src/host/cline-pass/store.ts')
const { ClinePassModelSettingsStore, FileCredentialStore: ClinePassCredentialStore } = await import('../src/host/cline-pass/token-store.ts')
const { CLINE_PASS_ROUTE_PREFIX: CLINE_PASS_PREFIX } = await import('../src/shared/cline-pass-contracts.ts')

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>

class MemoryBackend {
  private data: unknown = null
  async load() { return this.data === null ? null : JSON.parse(JSON.stringify(this.data)) }
  async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

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

/** A same-origin JSON POST whose body is replayed to late listeners. */
async function post(handler: Handler, url: string): Promise<{ status: number; body: { ok: boolean; value?: { authUrl?: string; authorizeUrl?: string; verificationUri?: string } } }> {
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
  const captured = { status: 0, body: { ok: false } as { ok: boolean; value?: { authUrl?: string; authorizeUrl?: string; verificationUri?: string } } }
  const response = {
    writeHead(status: number) { captured.status = status; return response },
    end(raw?: string) { if (raw !== undefined) captured.body = JSON.parse(raw) },
  } as unknown as ServerResponse
  await handler(request, response)
  return captured
}

/** Calls that would put a browser window in front of the user. */
function browserLaunches(): unknown[][] {
  return spawnSpy.mock.calls.filter(([command]) => ['cmd', 'open', 'xdg-open'].includes(String(command)))
}

/** GLM 的设置源：`/login/start` 这一条路由只读登录状态，根本不会碰它。 */
function glmSettingsSource() {
  return {
    status: () => ({}) as never,
    update: () => ({}) as never,
  }
}

afterEach(() => {
  cancelLogin()
  glmOauth.resetWebLogins()
  spawnSpy.mockClear()
})

describe('a sign-in opens the login page once', () => {
  it('Claude: /login answers the URL for the card and launches no browser of its own', async () => {
    const handler = capture((ctx) => registerClaudeRoutes(
      ctx,
      new FileCredentialStore(tmpFile('claude-doc'), new MemoryBackend() as never),
      new FileModelSettingsStore(tmpFile('claude-models')),
      undefined,
      // NO `login` override: this is the production wiring.
      { fetchFn: (async () => Response.json({})) as unknown as typeof fetch },
    ))
    const result = await post(handler, CLAUDE_PREFIX + '/login')
    expect(result.status).toBe(200)
    expect(result.body.value?.authUrl).toMatch(/^https:\/\//)
    expect(browserLaunches()).toEqual([])
  })

  it('Command Code: /login asks the flow for a no-op opener, so only the card opens the page', async () => {
    const handler = capture((ctx) => registerCommandCodeRoutes(
      ctx,
      new CommandCodeStores.FileCredentialStore(tmpFile('cc-cred')),
      new CommandCodeStores.FileModelSettingsStore(tmpFile('cc-models')),
    ))
    const result = await post(handler, '/command-code/api/login')
    expect(result.status).toBe(200)
    expect(result.body.value?.authUrl).toMatch(/^https:\/\//)

    const begin = vi.mocked(commandCodeOauth.beginWebLogin)
    expect(begin).toHaveBeenCalledTimes(1)
    const options = begin.mock.calls[0]![1]!
    // Absent would mean the flow's own default, which spawns the system browser.
    expect(options.openBrowser).toBeTypeOf('function')
    options.openBrowser!('https://commandcode.ai/auth?x=1')
    expect(browserLaunches()).toEqual([])
  })

  it('GLM: /login/start asks the flow for a no-op opener, so only the card opens the page', async () => {
    const handler = capture((ctx) => registerGlmCodingPlanRoutes(
      ctx,
      glmSettingsSource(),
      {
        fetchFn: (async () => Response.json({})) as unknown as typeof fetch,
        // NO `openBrowser` override: this is the production wiring.
      },
    ))
    const result = await post(handler, GLM_PREFIX + '/login/start')
    expect(result.status).toBe(200)
    expect(result.body.value?.authorizeUrl).toMatch(/^https:\/\//)

    const begin = vi.mocked(glmOauth.beginWebLogin)
    expect(begin).toHaveBeenCalledTimes(1)
    const options = begin.mock.calls[0]![0]!
    // Absent would mean the flow's own default, which spawns the system browser.
    expect(options.openBrowser).toBeTypeOf('function')
    options.openBrowser!('https://chat.z.ai/api/oauth/authorize?client_id=x')
    expect(browserLaunches()).toEqual([])
  })

  it('Cline Pass: /login/start answers the verification URL for the card and launches no browser of its own', async () => {
    const fetchFn = (async () => Response.json({
      device_code: 'dev-1',
      user_code: 'ABCD-1234',
      verification_uri: 'https://app.cline.bot/device',
      verification_uri_complete: 'https://app.cline.bot/device?code=ABCD-1234',
      expires_in: 300,
      interval: 5,
    })) as unknown as typeof fetch
    const credStore = new ClinePassCredentialStore(tmpFile('cp-cred'), new MemoryBackend() as never)
    const accountPool = new ClinePassAccountPool({ store: credStore, backend: new MemoryBackend() as never })
    const settings = new ClinePassModelSettingsStore(tmpFile('cp-models'))
    const store = createClinePassStore()
    const login = new ClinePassLoginManager({
      fetchFn,
      baseURL: () => 'https://api.cline.bot/api/v1',
      onLogin: async () => undefined,
    })
    const handler = capture((ctx) => registerClinePassRoutes(ctx, {
      settings,
      accountPool,
      store,
      engine: {} as never,
      fetchFn,
      login,
      serving: () => true,
      conflict: () => null,
    }))
    const result = await post(handler, CLINE_PASS_PREFIX + '/login/start')
    expect(result.status).toBe(200)
    expect(result.body.value?.verificationUri).toMatch(/^https:\/\//)
    expect(browserLaunches()).toEqual([])
  })
})
