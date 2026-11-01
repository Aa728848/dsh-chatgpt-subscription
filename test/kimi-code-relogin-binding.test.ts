/**
 * Which account a "re-login" on one row is allowed to sign back in as.
 *
 * The device flow authorizes whichever account the browser already is, and the
 * pool then adds THAT account. Without a binding, clicking "re-login" on one row
 * while another account is signed in replaced a different row and moved the
 * rotation with it — the card then looked like the pool had switched by itself.
 * These pin the refusal, and that a refusal writes nothing at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { KimiCodeAccountPool, parseKimiCodePoolData } from '../src/host/kimi-code/account-pool.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  type KimiCodeCredentials,
} from '../src/host/kimi-code/token-store.ts'
import { resetWebLogin } from '../src/host/kimi-code/oauth.ts'
import { registerKimiCodeRoutes } from '../src/host/kimi-code/routes.ts'
import type { KimiCodeLoginFlowStatus } from '../src/shared/kimi-code-contracts.ts'

function tmp(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

class PoolBackend {
  private data: unknown = null
  async load() { return this.data === null ? null : parseKimiCodePoolData(JSON.parse(JSON.stringify(this.data))) }
  async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

class CredentialBackend {
  private data: KimiCodeCredentials | null = null
  async load() { return this.data === null ? null : JSON.parse(JSON.stringify(this.data)) }
  async save(data: KimiCodeCredentials) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

function credential(n: number): KimiCodeCredentials {
  return {
    accessToken: `at-${n}`,
    refreshToken: `rt-${n}`,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    expiresIn: 86_400,
    userId: `user-${n}`,
    email: `user${n}@example.com`,
    nickname: `Kimi ${n}`,
    region: 'mainland-cn',
    oauthHost: 'https://auth.kimi.com',
    baseUrl: 'https://api.kimi.com/coding',
  }
}

/** A token pair that names an account, in the shape the flow decodes. */
function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.')
}

/** A device flow that always signs in as `identity`. */
function deviceFlow(identity: { userId: string; email: string }): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input)
    if (url.includes('/api/oauth/device_authorization')) {
      return Response.json({
        device_code: 'device-1',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://auth.kimi.com/device',
        verification_uri_complete: 'https://auth.kimi.com/device?code=ABCD-EFGH',
        expires_in: 300,
        interval: 1,
      })
    }
    if (url.includes('/api/oauth/token')) {
      return Response.json({
        access_token: jwt({ user_id: identity.userId, email: identity.email }),
        refresh_token: jwt({ user_id: identity.userId }),
        expires_in: 3600,
        token_type: 'Bearer',
      })
    }
    // Anything else (the profile enrichment read) fails: sign-in already
    // succeeded, and the flow is expected to keep the credential it built.
    throw new Error(`unexpected request: ${url}`)
  }) as unknown as typeof fetch
}

interface FakeResponse { status: number; body: unknown }

function fakeExchange(): { response: ServerResponse; captured: FakeResponse } {
  const captured: FakeResponse = { status: 0, body: undefined }
  const response = {
    writeHead(status: number) { captured.status = status },
    end(raw?: string) { captured.body = raw === undefined ? undefined : JSON.parse(raw) },
  } as unknown as ServerResponse
  return { response, captured }
}

function fakeRequest(input: { url: string; method?: string; body?: unknown }): IncomingMessage {
  const listeners = new Map<string, Array<(value?: unknown) => void>>()
  const request = {
    url: input.url,
    method: input.method ?? 'GET',
    headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
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

function modelSettingsStore(): FileModelSettingsStore {
  const store = new FileModelSettingsStore(tmp('kc-models'))
  vi.spyOn(store, 'read').mockResolvedValue({
    enabled: true,
    enabledModelIds: ['k3'],
    catalogModels: [],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
  })
  return store
}

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>

function harness(fetchFn: typeof fetch): {
  pool: KimiCodeAccountPool
  routeStore: FileCredentialStore
  handler: Handler
  /** Pages the flow asked for; the route's own seam, so no real browser opens. */
  opened: string[]
} {
  const pool = new KimiCodeAccountPool({
    store: new FileCredentialStore(tmp('kc-mirror'), new CredentialBackend() as never),
    backend: new PoolBackend() as never,
  })
  const routeStore = new FileCredentialStore(tmp('kc-route'), new CredentialBackend() as never)
  const routes: Array<{ handler: Handler }> = []
  const ctx = {
    webServer: {
      register(route: { handler: Handler }) { routes.push(route); return () => undefined },
    },
  } as unknown as Context
  // openBrowser is the route's test seam for exactly this: its default really
  // spawns the platform browser, and a test that signs in must not do that.
  const opened: string[] = []
  registerKimiCodeRoutes(
    ctx,
    routeStore,
    modelSettingsStore(),
    undefined,
    { fetchFn, openBrowser: (url: string) => { opened.push(url) } },
    pool,
  )
  return { pool, routeStore, handler: routes[0]!.handler, opened }
}

/** Poll the flow the way the card does until it is no longer pending. */
async function settledFlow(handler: Handler): Promise<KimiCodeLoginFlowStatus> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const exchange = fakeExchange()
    await handler(fakeRequest({ url: '/kimi-code/api/login/status' }), exchange.response)
    const value = (exchange.captured.body as { value: KimiCodeLoginFlowStatus }).value
    if (value.status !== 'pending') return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('the login flow never settled')
}

beforeEach(() => { resetWebLogin() })
afterEach(() => {
  resetWebLogin()
  vi.restoreAllMocks()
})

describe('kimi-code: a re-login may only sign back in as the row it was started from', () => {
  it('refuses an account the row did not name, and writes nothing', async () => {
    // The browser is signed in as user-9, but the user asked to re-authorize
    // user-1's row.
    const { pool, routeStore, handler, opened } = harness(deviceFlow({ userId: 'user-9', email: 'other@example.com' }))
    const first = await pool.addAccount(credential(1))
    const second = await pool.addAccount(credential(2))
    const before = await pool.read()

    const login = fakeExchange()
    await handler(fakeRequest({
      url: '/kimi-code/api/login',
      method: 'POST',
      body: { region: 'mainland-cn', accountId: first.id },
    }), login.response)
    expect(login.captured.status).toBe(200)

    const flow = await settledFlow(handler)
    // The flow reached the authorization page through the injected opener, which
    // is what keeps this suite from launching a real browser.
    expect(opened).toHaveLength(1)
    expect(flow.status).toBe('error')
    expect(flow.error).toContain('已取消')
    expect(flow.error).toContain('user1@example.com')
    expect(flow.error).toContain('other@example.com')

    const after = await pool.read()
    expect(after.accounts).toHaveLength(2)
    expect(after.accounts.map((account) => account.id)).toEqual([first.id, second.id])
    expect(after.activeAccountId).toBe(before.activeAccountId)
    // Nothing was mirrored either: a refusal must not leave another account's
    // token pair in the single-credential file.
    expect(await routeStore.read()).toBeNull()
  })

  it('accepts the row the flow actually signed in as', async () => {
    const { pool, routeStore, handler } = harness(deviceFlow({ userId: 'user-1', email: 'user1@example.com' }))
    const first = await pool.addAccount(credential(1))
    await pool.addAccount(credential(2))

    const login = fakeExchange()
    await handler(fakeRequest({
      url: '/kimi-code/api/login',
      method: 'POST',
      body: { region: 'mainland-cn', accountId: first.id },
    }), login.response)

    const flow = await settledFlow(handler)
    expect(flow.status).toBe('complete')

    const data = await pool.read()
    expect(data.accounts).toHaveLength(2)
    const row = data.accounts.find((account) => account.id === first.id)!
    expect(row.credentials.accessToken).not.toBe('at-1')
    expect(data.activeAccountId).toBe(first.id)
    // The mirror now carries the re-authorized pair.
    expect(await routeStore.read()).not.toBeNull()
  })

  it('a plain sign-in keeps no binding and still adds an account', async () => {
    const { pool, handler } = harness(deviceFlow({ userId: 'user-9', email: 'other@example.com' }))
    await pool.addAccount(credential(1))

    const login = fakeExchange()
    await handler(fakeRequest({ url: '/kimi-code/api/login', method: 'POST', body: { region: 'mainland-cn' } }), login.response)

    const flow = await settledFlow(handler)
    expect(flow.status).toBe('complete')
    const data = await pool.read()
    expect(data.accounts).toHaveLength(2)
    expect(data.accounts.some((account) => account.userId === 'user-9')).toBe(true)
    // Adding an account is not a switch: the existing choice stands.
    expect(data.activeAccountId).toBe(data.accounts[0]!.id)
  })
})
