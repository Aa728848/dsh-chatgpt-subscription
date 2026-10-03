/**
 * A sign-in opens the authorization page ONCE.
 *
 * The settings card opens the page itself (`window.open`, which the desktop
 * shell hands to the system browser). The Claude and Command Code hosts used to
 * open the same URL again from `/login`, so every sign-in showed the user two
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
async function post(handler: Handler, url: string): Promise<{ status: number; body: { ok: boolean; value?: { authUrl?: string } } }> {
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
  const captured = { status: 0, body: { ok: false } as { ok: boolean; value?: { authUrl?: string } } }
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

afterEach(() => {
  cancelLogin()
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
})
