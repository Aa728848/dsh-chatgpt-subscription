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
import { buildMinimaxRequest } from '../src/host/minimax-code/mapper.ts'
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

  describe('the request asks for the stream the adapter parses', () => {
    // The stream flag itself, and the parser's verdicts on a real stream versus a
    // non-SSE body, are covered by test/minimax-code-mapper.test.ts. What is
    // asserted here is the shape that file does not build: the flag has to survive
    // the branches that add system text, tools and thinking, because losing it on
    // exactly those requests is what would break tool-calling turns silently.
    it('keeps stream: true on a body carrying system text, tools and thinking', () => {
      const body = buildMinimaxRequest({
        model: 'MiniMax-M3',
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hi' },
        ],
        tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }],
        reasoningEffort: 'high',
      } as never)
      expect(body.stream).toBe(true)
      expect(body.tools).toBeDefined()
      // Caching is on by default, and a breakpoint cannot sit on a plain string,
      // so the system text goes out as a marked block array.
      expect(body.system).toEqual([{ type: 'text', text: 'be brief', cache_control: { type: 'ephemeral' } }])
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
    it('advertises video only on the models that take it', () => {
      // The catalog is a claim DSH's capability pipeline acts on, so it may
      // list video only now that a real byte reader exists and the endpoint's
      // block shape has been measured rather than assumed.
      for (const model of MINIMAX_CODE_MODELS) {
        const expected = model.id === 'MiniMax-M3' || model.id === 'MiniMax-M3.1-Flash-Preview'
        expect(model.inputModalities.includes('video')).toBe(expected)
      }
    })

    it('sends a measured video block when the clip is readable', () => {
      const body = buildMinimaxRequest(
        {
          model: 'MiniMax-M3',
          messages: [{
            role: 'user',
            content: [{
              type: 'video',
              attachment: { attachmentId: 'v1', mediaType: 'video/mp4', bytes: 3 },
            } as never],
          }],
        } as never,
        undefined,
        {
          videos: new Map([['v1', { kind: 'inline', mediaType: 'video/mp4', data: 'AAAA' }]]),
          videoAccepted: true,
        },
      )
      // The shape and the framing were both measured: this endpoint decodes
      // { type: 'video', source: { type: 'base64', ... } } with BARE base64, and
      // a data-URL string fails at the ':' because it is read as base64.
      const block = (body['messages'] as Array<{ content: unknown[] }>)[0]!.content
        .find((b) => (b as { type?: string }).type === 'video') as Record<string, unknown>
      expect(block['source']).toEqual({ type: 'base64', media_type: 'video/mp4', data: 'AAAA' })
      expect(JSON.stringify(body)).not.toContain('data:video/mp4')
    })

    it('explains a video the selected model cannot take', () => {
      const body = buildMinimaxRequest({
        model: 'MiniMax-M2.7',
        messages: [{ role: 'user', content: [{ type: 'video' } as never] }],
      } as never, undefined, { videoAccepted: false })
      const serialized = JSON.stringify(body)
      expect(serialized).not.toMatch(/"type": ?"video"/)
      expect(serialized).toContain('video omitted')
    })

    it('explains a video whose bytes were never read', () => {
      const body = buildMinimaxRequest(
        {
          model: 'MiniMax-M3',
          messages: [{ role: 'user', content: [{ type: 'video' } as never] }],
        } as never,
        undefined,
        { videoAccepted: true },
      )
      // No reader resolved it, so the model must be told rather than left to
      // answer about an empty message.
      const serialized = JSON.stringify(body)
      expect(serialized).not.toMatch(/"type": ?"video"/)
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

// ---------------------------------------------------------------------------
// In-band stream errors
// ---------------------------------------------------------------------------

describe('minimax-code in-band stream errors', () => {
  const MESSAGE_START = { type: 'message_start', message: { usage: { input_tokens: 1 } } }
  let home: string
  const originalMinimaxHome = process.env.MINIMAX_HOME

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'minimax-inband-'))
    process.env.MINIMAX_HOME = home
  })

  afterEach(async () => {
    if (originalMinimaxHome === undefined) delete process.env.MINIMAX_HOME
    else process.env.MINIMAX_HOME = originalMinimaxHome
    await fs.rm(home, { recursive: true, force: true }).catch(() => undefined)
  })

  /** An adapter whose every request answers 200 and then reports the failure. */
  async function adapterFor(frames: unknown[], calls: string[]): Promise<MinimaxCodeAdapter> {
    const store = new MinimaxCodeCredentialStore()
    await store.write({
      accessToken: 'ACCESS', refreshToken: 'r-own', tokenType: 'Bearer', clientId: 'mcode-public',
      scopes: [], audience: '', expiresAtMs: Date.now() + 3_600_000, generation: 1, loginEpoch: 'e',
      buildEnv: 'prod', region: 'cn', recordKey: null, source: 'file',
    })
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return new Response(
        frames.map((frame) => 'data: ' + JSON.stringify(frame) + '\n\n').join(''),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }) as unknown as typeof fetch
    return new MinimaxCodeAdapter(store, { fetchFn })
  }

  async function failureOf(adapter: MinimaxCodeAdapter): Promise<unknown> {
    try {
      for await (const _chunk of adapter.stream({
        provider: 'minimax-code', model: 'MiniMax-M3',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      } as never)) { /* drain */ }
    } catch (error) {
      return error
    }
    throw new Error('expected the stream to fail')
  }

  it('reclassifies a transient in-band failure while nothing has reached the caller', async () => {
    // The shape that ended a real turn: HTTP 200, message_start, then an
    // overloaded_error event. The same overload sent as a 529 is SERVER, so the
    // in-band copy must not be the one that ends the turn on the first try.
    const policy = new MinimaxCodeAdapter(new MinimaxCodeCredentialStore()).providerRetryPolicy()
    const retryable = policy.mode === 'normal' ? policy.retryableCodes : []
    for (const [type, message, code] of [
      ['overloaded_error', 'Overloaded', 'SERVER'],
      ['api_error', 'Internal server error', 'SERVER'],
      ['rate_limit_error', 'Too many requests', 'RATE_LIMIT'],
    ] as const) {
      const calls: string[] = []
      const failure = await failureOf(await adapterFor(
        [MESSAGE_START, { type: 'error', error: { type, message } }], calls,
      ))
      expect(failure).toMatchObject({ code })
      // The provider's own diagnostic stays in the message, so the notice still
      // says what happened rather than becoming a bare code.
      expect((failure as Error).message).toContain(message)
      expect(retryable).toContain(code)
      // Classified, not re-requested inside the stream: the harness retry policy
      // owns the repeat.
      expect(calls).toHaveLength(1)
    }
  })

  it('keeps the mapper verdict once output has reached the caller', async () => {
    // A retry would repeat 'partial' for the user and could re-run a tool call.
    const calls: string[] = []
    const failure = await failureOf(await adapterFor([
      MESSAGE_START,
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    ], calls))
    expect(failure).toMatchObject({ code: 'PROVIDER_ERROR' })
    expect(calls).toHaveLength(1)
  })

  it('leaves a non-transient or unrecognized in-band type with the mapper verdict', async () => {
    for (const type of ['invalid_request_error', 'authentication_error', 'request_too_large', 'some_future_error']) {
      const calls: string[] = []
      const failure = await failureOf(await adapterFor(
        [MESSAGE_START, { type: 'error', error: { type, message: 'nope' } }], calls,
      ))
      expect(failure).toMatchObject({ code: 'PROVIDER_ERROR' })
    }
  })

  it('never rewrites a context-overflow verdict the mapper already typed', async () => {
    // A transient wire type and an overflow message can arrive together. The
    // mapper's code is what the harness acts on - CONTEXT_OVERFLOW is the signal
    // compaction runs on - so rewriting it into a retryable SERVER would throw
    // that recovery away while the request keeps failing identically.
    const calls: string[] = []
    const failure = await failureOf(await adapterFor([
      MESSAGE_START,
      { type: 'error', error: { type: 'api_error', message: 'prompt is too long: 400000 tokens > 200000 tokens maximum' } },
    ], calls))
    expect(failure).toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED' })
    expect(calls).toHaveLength(1)
  })
})
