import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import {
  MINIMAX_CODE_ROUTE_PREFIX,
} from '../src/shared/minimax-code-contracts.ts'
import { getMinimaxCodeWebStatus, registerMinimaxCodeRoutes, resetLatestLogin, subPathOf } from '../src/host/minimax-code/routes.ts'
import { MinimaxCodeCredentialStore, authJsonPath, credentialIsFresh, parseMinimaxCodeCredentials } from '../src/host/minimax-code/token-store.ts'
import { MinimaxCodeAdapter } from '../src/host/minimax-code/adapter.ts'
import { MINIMAX_CODE_MODELS, minimaxCodeModelIds } from '../src/host/minimax-code/model-catalog.ts'
import { buildMinimaxRequest, createStreamState, processMinimaxStreamLine } from '../src/host/minimax-code/mapper.ts'
import { resetRefreshRejections } from '../src/host/minimax-code/oauth.ts'
import { redactToken } from '../src/host/minimax-code/types.ts'

function fakeExchange(): { response: ServerResponse; captured: { status?: number; body?: any } } {
  const captured: { status?: number; body?: any } = {}
  const response = {
    writeHead(status: number) { captured.status = status; return response },
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
      if (input.body !== undefined) listeners.get('data')?.forEach((l) => l(Buffer.from(JSON.stringify(input.body))))
      listeners.get('end')?.forEach((l) => l())
    })
  }
  return request
}

/** A native auth.json document shaped like the desktop app's. */
function nativeDocument(record: Record<string, unknown>): string {
  return JSON.stringify({
    schemaVersion: 1,
    records: { 'mcode-public/hash': { clientId: 'mcode-public', ...record } },
    untouched: 'keep-me',
  }, null, 2)
}

describe('MiniMax Code line', () => {
  let home: string
  let originalHome: string | undefined
  let originalMinimaxHome: string | undefined
  let originalFetch: typeof fetch
  let routes: Array<{ path: string; handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }>

  beforeEach(async () => {
    resetLatestLogin()
    resetRefreshRejections()
    originalHome = process.env.DSH_HOME
    originalMinimaxHome = process.env.MINIMAX_HOME
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-line-'))
    process.env.DSH_HOME = home
    process.env.MINIMAX_HOME = path.join(home, '.minimax')
    originalFetch = globalThis.fetch
    routes = []
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    if (originalHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalHome
    if (originalMinimaxHome === undefined) delete process.env.MINIMAX_HOME
    else process.env.MINIMAX_HOME = originalMinimaxHome
    await fs.rm(home, { recursive: true, force: true }).catch(() => undefined)
  })

  function register(store = new MinimaxCodeCredentialStore(), options: Record<string, unknown> = {}) {
    const ctx = {
      webServer: {
        register(route: { path: string; handler: any }) { routes.push(route); return () => undefined },
      },
      logger: { warn() {}, info() {} },
    } as unknown as Context
    const dispose = registerMinimaxCodeRoutes(ctx, store, options as never)
    return { store, dispose }
  }

  describe('route prefix', () => {
    it('mounts under its own sibling prefix, not the Codex one', () => {
      expect(MINIMAX_CODE_ROUTE_PREFIX).toBe('/minimax-code/api')
      register()
      expect(routes.map((route) => route.path)).toEqual(['/minimax-code/api'])
    })

    it('resolves sub-paths under the single prefix', () => {
      expect(subPathOf('/minimax-code/api')).toBe('')
      expect(subPathOf('/minimax-code/api/status')).toBe('status')
      expect(subPathOf('/minimax-code/api/login/poll')).toBe('login/poll')
    })
  })

  describe('credential store', () => {
    it('reads a native auth.json and reports its provenance', async () => {
      const store = new MinimaxCodeCredentialStore()
      await fs.mkdir(path.dirname(authJsonPath('cn')), { recursive: true })
      await fs.writeFile(authJsonPath('cn'), nativeDocument({
        accessToken: 'access-native', refreshToken: 'refresh-native', expiresAtMs: Date.now() + 3_600_000,
      }), 'utf8')
      const credentials = await store.read()
      expect(credentials?.source).toBe('minimax-native')
      expect(credentials?.accessToken).toBe('access-native')
      expect(await store.activeSource()).toBe('minimax-native')
    })

    it('finds a global sign-in even though the default region is cn', async () => {
      const store = new MinimaxCodeCredentialStore('cn')
      await fs.mkdir(path.dirname(authJsonPath('global')), { recursive: true })
      await fs.writeFile(authJsonPath('global'), nativeDocument({
        accessToken: 'access-global', refreshToken: 'refresh-global', expiresAtMs: Date.now() + 3_600_000,
      }), 'utf8')
      const credentials = await store.read()
      expect(credentials?.accessToken).toBe('access-global')
      expect(credentials?.region).toBe('global')
      // The path the card reports must name the file actually in force, which is
      // the global one — not the constructor's default region.
      const provenance = await store.readWithProvenance()
      expect(provenance.source).toBe('minimax-native')
      expect(provenance.path).toBe(authJsonPath('global'))
    })

    it('keeps the stored region instead of defaulting it away', () => {
      const parsed = parseMinimaxCodeCredentials({
        accessToken: 'a', refreshToken: 'r', expiresAtMs: 1, region: 'global',
      }, { region: 'cn' })
      expect(parsed.region).toBe('global')
    })

    it('writes atomically without leaving a plaintext sidecar beside the app file', async () => {
      const store = new MinimaxCodeCredentialStore()
      await fs.mkdir(path.dirname(authJsonPath('cn')), { recursive: true })
      await fs.writeFile(authJsonPath('cn'), nativeDocument({
        accessToken: 'access-1', refreshToken: 'refresh-1', expiresAtMs: Date.now() + 3_600_000,
      }), 'utf8')
      const credentials = (await store.read())!
      await store.write({ ...credentials, accessToken: 'access-2', generation: credentials.generation + 1 })
      const entries = await fs.readdir(path.dirname(authJsonPath('cn')))
      expect(entries.filter((name) => name.includes('dsh-bak'))).toEqual([])
      expect(entries.filter((name) => name.includes('dsh-tmp-'))).toEqual([])
      const document = JSON.parse(await fs.readFile(authJsonPath('cn'), 'utf8'))
      expect(document.untouched).toBe('keep-me')
      expect(document.schemaVersion).toBe(1)
      expect(document.records['mcode-public/hash'].accessToken).toBe('access-2')
    })

    it('rejects a credential with no expiry rather than inventing one', () => {
      expect(() => parseMinimaxCodeCredentials({ accessToken: 'a', refreshToken: 'r' }, { region: 'cn' })).toThrow()
      expect(credentialIsFresh({ expiresAtMs: Date.now() - 1000 } as never)).toBe(false)
    })
  })

  describe('routes', () => {
    it('reports serving/conflict and ownership on /status', async () => {
      // A signed-out state has no credential and therefore no ownership.
      const { store } = register()
      const status = await getMinimaxCodeWebStatus(store, { serving: () => false, conflict: () => 'another adapter owns it' })
      expect(status.serving).toBe(false)
      expect(status.conflict).toBe('another adapter owns it')
      expect(status.ownedByPlugin).toBe(false)
      // `models` is the card's render model (id + enabled + effective window),
      // not a bare id list: this is the settings surface every sibling line has.
      expect(status.models.map((model) => model.id)).toEqual(minimaxCodeModelIds())
      expect(status.models.every((model) => model.enabled)).toBe(true)
      expect(status.enabled).toBe(true)
    })

    it('does not revoke or delete a sign-in the desktop app owns', async () => {
      const store = new MinimaxCodeCredentialStore()
      await fs.mkdir(path.dirname(authJsonPath('cn')), { recursive: true })
      await fs.writeFile(authJsonPath('cn'), nativeDocument({
        accessToken: 'access-native', refreshToken: 'refresh-native', expiresAtMs: Date.now() + 3_600_000,
      }), 'utf8')
      const { dispose } = register(store)
      const { response, captured } = fakeExchange()
      await routes[0]!.handler(fakeRequest({ url: '/minimax-code/api/logout', method: 'POST' }), response)
      expect(captured.status).toBe(200)
      expect(captured.body.value.native).toBe(true)
      // The app's own file must survive, and its token must not have been revoked.
      await expect(fs.readFile(authJsonPath('cn'), 'utf8')).resolves.toContain('refresh-native')
      dispose()
    })

    it('revokes and deletes a credential the plugin owns', async () => {
      const store = new MinimaxCodeCredentialStore()
      process.env.MINIMAX_HOME = path.join(home, 'empty-minimax')
      await store.write({
        accessToken: 'a', refreshToken: 'r-own', tokenType: 'Bearer', clientId: 'mcode-public',
        scopes: [], audience: '', expiresAtMs: Date.now() + 3_600_000, generation: 1, loginEpoch: 'e',
        buildEnv: 'prod', region: 'cn', recordKey: null, source: 'file',
      })
      const revoked: string[] = []
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        revoked.push(String(input))
        return Response.json({ ok: true })
      }) as typeof fetch
      const { dispose } = register(store)
      const { response, captured } = fakeExchange()
      await routes[0]!.handler(fakeRequest({ url: '/minimax-code/api/logout', method: 'POST' }), response)
      expect(captured.body.value.native).toBe(false)
      expect(revoked.some((url) => url.includes('/oauth2/revoke'))).toBe(true)
      expect(await store.read()).toBeNull()
      dispose()
    })

    it('rejects a cross-origin mutation', async () => {
      const { dispose } = register()
      const { response, captured } = fakeExchange()
      const request = fakeRequest({ url: '/minimax-code/api/logout', method: 'POST' })
      ;(request as unknown as { headers: Record<string, string> }).headers = { host: '127.0.0.1:3000', origin: 'http://evil.test' }
      await routes[0]!.handler(request, response)
      expect(captured.status).toBe(403)
      dispose()
    })
  })

  describe('credential non-disclosure', () => {
    it('never renders any part of a token', () => {
      const token = 'sk-live-SUPERSECRET-abcdef1234567890'
      const rendered = redactToken(token)
      expect(rendered).not.toContain('sk-live')
      expect(rendered).not.toContain('SUPERSECRET')
      expect(rendered).not.toContain(token.slice(0, 6))
      // It must still distinguish two credentials, which is its whole purpose.
      expect(redactToken(token)).not.toBe(redactToken(token + 'x'))
      expect(redactToken(undefined)).toBe('<none>')
    })
  })

  describe('catalog claims match what the route can send', () => {
    it('never advertises video, which this line has no reader for', () => {
      for (const model of MINIMAX_CODE_MODELS) {
        expect(model.inputModalities).not.toContain('video')
      }
    })

    it('produces a body with no video part even when a video block is supplied', () => {
      const body = buildMinimaxRequest({
        model: 'MiniMax-M3',
        messages: [{ role: 'user', content: [{ type: 'video' } as never] }],
      } as never)
      // No wire-level video part may appear: the only mention allowed is the
      // placeholder text explaining that the clip could not be sent.
      const serialized = JSON.stringify(body)
      expect(serialized).not.toMatch(/video_url|"type":"video"|"type": "video"/)
      expect(serialized).toContain('video omitted')
    })
  })

  describe('adapter 401 recovery', () => {
    it('forces exactly one refresh and retries the same body', async () => {
      const store = new MinimaxCodeCredentialStore()
      process.env.MINIMAX_HOME = path.join(home, 'empty-minimax-2')
      await store.write({
        accessToken: 'stale', refreshToken: 'r-own', tokenType: 'Bearer', clientId: 'mcode-public',
        scopes: [], audience: '', expiresAtMs: Date.now() + 3_600_000, generation: 1, loginEpoch: 'e',
        buildEnv: 'prod', region: 'cn', recordKey: null, source: 'file',
      })
      const calls: Array<{ url: string; auth: string }> = []
      const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const auth = String((init?.headers as Record<string, string>)?.authorization ?? '')
        calls.push({ url, auth })
        if (url.includes('/oauth2/token')) {
          return Response.json({ access_token: 'fresh', refresh_token: 'r-own', token_type: 'Bearer', expires_in: 3600 })
        }
        if (auth === 'Bearer stale') return new Response('{"message":"token is required"}', { status: 401 })
        return new Response(
          'data: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1 } } }) + '\n\n'
          + 'data: ' + JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }) + '\n\n'
          + 'data: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }) + '\n\n'
          + 'data: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }) as unknown as typeof fetch
      const adapter = new MinimaxCodeAdapter(store, { fetchFn })
      const chunks: any[] = []
      for await (const chunk of adapter.stream({
        provider: 'minimax-code', model: 'MiniMax-M3',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      } as never)) chunks.push(chunk)
      expect(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'hi')).toBe(true)
      // One 401, one refresh, one retry that succeeded.
      expect(calls.filter((call) => call.url.includes('/messages'))).toHaveLength(2)
      expect(calls.filter((call) => call.url.includes('/oauth2/token'))).toHaveLength(1)
    })
  })
})
