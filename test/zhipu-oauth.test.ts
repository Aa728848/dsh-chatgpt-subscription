import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import {
  clearCachedCatalog,
  clearCachedQuota,
} from '../src/host/zhipu/client.ts'
import { registerZhipuRoutes } from '../src/host/zhipu/routes.ts'
import {
  beginWebLogin,
  buildAuthorizeUrl,
  defaultOAuthEndpoints,
  exchangeAuthorizationCode,
  extractAuthorizationCode,
  getWebLoginStatus,
  mintApiKey,
  resetWebLogin,
  submitLoginCode,
  type ZaiOAuthEndpoints,
} from '../src/host/zhipu/oauth.ts'
import { FileCredentialStore, FileModelSettingsStore } from '../src/host/zhipu/token-store.ts'
import {
  createZhipuCredentialStore,
  makeZhipuFetch,
  zhipuSettingsFile,
} from './support/zhipu-fixtures.ts'

/**
 * A stand-in for ZCode's own console.
 *
 * Every endpoint here is a first-party, undocumented contract, so the fixtures
 * deliberately assert the *shape this implementation depends on* rather than a
 * captured transcript: the envelope convention, the nested `data.zai` token,
 * and the org/project → key → copy sequence. If one of those moves upstream the
 * test is what says which assumption broke.
 */
const ENDPOINTS: ZaiOAuthEndpoints = {
  clientId: 'client-test',
  authorizeUrl: 'https://chat.z.ai/api/oauth/authorize',
  tokenUrl: 'https://zcode.z.ai/api/v1/oauth/token',
  bizBase: 'https://api.z.ai',
  businessLoginUrl: 'https://api.z.ai/api/auth/z/login',
  keyName: 'dsh-chatgpt-subscription',
}

/** The model listing the Coding Plan surface answers a valid key with. */
const CATALOG = { data: [{ id: 'glm-5.3', context_window: 1_000_000 }] }

interface ConsoleCalls {
  urls: string[]
  bodies: Array<Record<string, unknown> | undefined>
}

/**
 * A console double covering the whole sign-in sequence.
 *
 * `options.mintSecret` and `options.existingKey` shape the two branches the
 * key provisioning has; `options.tokenStatus` / `options.businessStatus` let a
 * test drive the envelope refusals.
 */
function makeConsole(options: {
  calls?: ConsoleCalls
  existingKey?: Record<string, unknown>
  omitSecret?: boolean
  tokenEnvelope?: unknown
  businessEnvelope?: unknown
} = {}): typeof fetch {
  const calls = options.calls ?? { urls: [], bodies: [] }
  return makeZhipuFetch((url, init) => {
    calls.urls.push(url)
    calls.bodies.push(init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>)
    if (url.startsWith(ENDPOINTS.tokenUrl)) {
      return Response.json(options.tokenEnvelope ?? {
        code: 0,
        data: {
          zai: { access_token: 'oauth-access-token' },
          user: { email: 'user@example.com', id: 42 },
        },
      })
    }
    if (url === ENDPOINTS.businessLoginUrl) {
      return Response.json(options.businessEnvelope ?? { code: 200, success: true, data: { access_token: 'biz-token' } })
    }
    if (url.endsWith('/api/biz/customer/getCustomerInfo')) {
      return Response.json({
        code: 200,
        success: true,
        data: {
          organizations: [
            { organizationId: 'org-1', isDefault: true, projects: [{ projectId: 'proj-1', isDefault: true }] },
          ],
        },
      })
    }
    if (url.endsWith('/projects/proj-1/api_keys')) {
      const method = init?.method ?? 'GET'
      if (method === 'GET') {
        return Response.json({ code: 200, success: true, data: options.existingKey === undefined ? [] : [options.existingKey] })
      }
      return Response.json({ code: 200, success: true, data: { apiKey: 'key-id-1' } })
    }
    if (url.includes('/api_keys/copy/')) {
      return Response.json({
        code: 200,
        success: true,
        data: options.omitSecret === true ? {} : { secretKey: 'secret-1' },
      })
    }
    // The verification read the flow performs before it persists anything.
    if (url.includes('/coding/paas/v4/models')) return Response.json(CATALOG)
    throw new Error(`Unexpected request: ${url}`)
  })
}

describe('zai browser sign-in', () => {
  beforeEach(() => {
    resetWebLogin()
    clearCachedCatalog()
    clearCachedQuota()
  })

  afterEach(() => {
    resetWebLogin()
    vi.restoreAllMocks()
  })

  it('builds the console authorization URL with the loopback redirect and the state', () => {
    const url = new URL(buildAuthorizeUrl({ redirectUri: 'http://127.0.0.1:54548/callback', state: 'st-1', endpoints: ENDPOINTS }))
    expect(url.origin + url.pathname).toBe(ENDPOINTS.authorizeUrl)
    expect(url.searchParams.get('client_id')).toBe(ENDPOINTS.clientId)
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:54548/callback')
    expect(url.searchParams.get('state')).toBe('st-1')
    expect(url.searchParams.get('response_type')).toBe('code')
    // The console's own request carries no PKCE; inventing one would be a
    // different request than the client the state was minted for.
    expect(url.searchParams.has('code_challenge')).toBe(false)
  })

  it('extracts the code from a pasted redirect URL as well as from a bare code', () => {
    expect(extractAuthorizationCode('  abc123  ')).toBe('abc123')
    expect(extractAuthorizationCode('http://127.0.0.1:54548/callback?code=xyz&state=st-1')).toBe('xyz')
    expect(extractAuthorizationCode('')).toBe('')
    // A URL without a code is not a code; turning the URL text into one would
    // send a value the token endpoint rejects with no hint about why.
    expect(extractAuthorizationCode('https://chat.z.ai/authorize')).toBe('')
  })

  it('mints a durable key: business login, default project, reuse-or-create, then copy', async () => {
    const calls: ConsoleCalls = { urls: [], bodies: [] }
    const fetchFn = makeConsole({ calls })
    const key = await mintApiKey('oauth-access-token', { fetchFn, endpoints: ENDPOINTS })

    expect(key).toBe('key-id-1.secret-1')
    // The full sequence, in order — each step depends on the previous one's id.
    expect(calls.urls).toEqual([
      ENDPOINTS.businessLoginUrl,
      'https://api.z.ai/api/biz/customer/getCustomerInfo',
      'https://api.z.ai/api/biz/v1/organization/org-1/projects/proj-1/api_keys',
      'https://api.z.ai/api/biz/v1/organization/org-1/projects/proj-1/api_keys',
      'https://api.z.ai/api/biz/v1/organization/org-1/projects/proj-1/api_keys/copy/key-id-1',
    ])
    // The OAuth token is traded for a biz token first; the key APIs never see it.
    expect(calls.bodies[0]).toEqual({ token: 'oauth-access-token' })
    expect(calls.bodies[4]).toBeUndefined()
  })

  it('reuses an existing key of its own name instead of creating a second one', async () => {
    const calls: ConsoleCalls = { urls: [], bodies: [] }
    const fetchFn = makeConsole({ calls, existingKey: { name: ENDPOINTS.keyName, apiKey: 'existing-key' } })
    const key = await mintApiKey('oauth-access-token', { fetchFn, endpoints: ENDPOINTS })

    expect(key).toBe('existing-key.secret-1')
    // No POST to the listing: the name already exists, and creating a second
    // key would leave a growing pile of live credentials on the account.
    expect(calls.urls.filter((url) => url.endsWith('/api_keys'))).toHaveLength(1)
    expect(calls.bodies.filter((body) => body?.name !== undefined)).toEqual([])
  })

  it('returns the durable key and the account facts the token response carried', async () => {
    const authorization = await exchangeAuthorizationCode('code-1', 'st-1', 'http://127.0.0.1:1/callback', {
      fetchFn: makeConsole({}),
      endpoints: ENDPOINTS,
    })
    expect(authorization).toEqual({
      apiKey: 'key-id-1.secret-1',
      email: 'user@example.com',
      accountId: '42',
    })
  })

  it('surfaces the console envelope message rather than treating it as success', async () => {
    const fetchFn = makeConsole({ tokenEnvelope: { code: 1001, msg: 'authorization code expired' } })
    await expect(
      exchangeAuthorizationCode('expired', 'st-1', 'http://127.0.0.1:1/callback', { fetchFn, endpoints: ENDPOINTS }),
    ).rejects.toThrow(/authorization code expired/)
  })

  it('fails with a named reason when the account has no project to mint on', async () => {
    const fetchFn = makeZhipuFetch((url) => {
      if (url === ENDPOINTS.businessLoginUrl) return Response.json({ code: 200, success: true, data: { access_token: 'biz' } })
      if (url.endsWith('/getCustomerInfo')) {
        return Response.json({ code: 200, success: true, data: { organizations: [] } })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    await expect(mintApiKey('token', { fetchFn, endpoints: ENDPOINTS })).rejects.toThrow(/no organization.project/)
  })

  it('fails when the secret cannot be read, instead of storing a partial key', async () => {
    const fetchFn = makeConsole({ omitSecret: true })
    await expect(mintApiKey('token', { fetchFn, endpoints: ENDPOINTS })).rejects.toThrow(/no secret/)
  })

  it('completes a sign-in whose code is pasted back, storing the verified international key', async () => {
    const store = await createZhipuCredentialStore()
    const calls: ConsoleCalls = { urls: [], bodies: [] }
    const fetchFn = makeConsole({ calls })

    // A port of 0 lets the OS pick, so the test never collides with a real
    // listener; the console double routes by path, not by port.
    const started = await beginWebLogin(store, { fetchFn, port: 0, endpoints: ENDPOINTS, openBrowser: () => undefined })
    expect(started.status).toBe('pending')
    expect(started.authUrl).toContain(ENDPOINTS.authorizeUrl)
    expect(started.region).toBe('intl')

    const submitted = submitLoginCode('http://127.0.0.1:9/callback?code=code-1&state=whatever')
    expect(submitted.status).toBe('pending')

    await vi.waitFor(async () => {
      expect(getWebLoginStatus().status).toBe('complete')
    })
    expect(getWebLoginStatus().email).toBe('user@example.com')

    const stored = await store.read()
    expect(stored?.apiKey).toBe('key-id-1.secret-1')
    expect(stored?.region).toBe('intl')
    expect(stored?.apiBase).toBe('https://api.z.ai')
  })

  it('receives a real loopback callback, refusing a state this attempt did not mint', async () => {
    const store = await createZhipuCredentialStore()
    const started = await beginWebLogin(store, {
      fetchFn: makeConsole({}),
      port: 0,
      endpoints: ENDPOINTS,
      openBrowser: () => undefined,
    })
    const redirect = new URL(new URL(started.authUrl!).searchParams.get('redirect_uri')!)
    expect(redirect.hostname).toBe('127.0.0.1')
    expect(redirect.pathname).toBe('/callback')

    // A forged state must not be exchangeable — the code would otherwise be
    // handed to whoever guessed the port — and it must not kill the attempt
    // either: a stranger on the port (or a browser prefetch) is not the console
    // answering, so the real callback below still completes.
    const forged = await fetch(`${redirect.origin}${redirect.pathname}?code=stolen&state=not-this-attempt`)
    expect(forged.status).toBe(400)
    expect(getWebLoginStatus().status).toBe('pending')

    const state = new URL(started.authUrl!).searchParams.get('state')!
    const accepted = await fetch(`${redirect.origin}${redirect.pathname}?code=REAL-CODE&state=${encodeURIComponent(state)}`)
    expect(accepted.status).toBe(200)
    expect(await accepted.text()).toContain('Signed in')
    await vi.waitFor(() => { expect(getWebLoginStatus().status).toBe('complete') })
    expect((await store.read())?.apiKey).toBe('key-id-1.secret-1')
    expect((await store.read())?.region).toBe('intl')
  })

  it('rejects a pasted value that carries no code', async () => {
    const store = await createZhipuCredentialStore()
    await beginWebLogin(store, { fetchFn: makeConsole({}), port: 0, endpoints: ENDPOINTS, openBrowser: () => undefined })
    expect(() => submitLoginCode('   ')).toThrow(/authorization code/)
  })

  it('reports an error rather than staying pending when there is no sign-in to finish', () => {
    expect(() => submitLoginCode('code-1')).toThrow(/no GLM sign-in in progress/)
  })

  it('passes the verified key to the pool instead of the single-credential store', async () => {
    const store = await createZhipuCredentialStore()
    const saved: string[] = []
    await beginWebLogin(store, {
      fetchFn: makeConsole({}),
      port: 0,
      endpoints: ENDPOINTS,
      openBrowser: () => undefined,
      onSave: async (credentials) => { saved.push(credentials.apiKey) },
    })
    submitLoginCode('code-1')
    await vi.waitFor(() => { expect(saved).toEqual(['key-id-1.secret-1']) })
    // The pool is the routing table; the flow must not write the mirror itself.
    expect(await store.read()).toBeNull()
  })

  it('reports a minted key the Coding Plan surface refuses as an error, and stores nothing', async () => {
    const store = await createZhipuCredentialStore()
    // The mint succeeds; only the verification read says the account has no
    // usable plan, which is the case that must not be persisted.
    const console_ = makeConsole({})
    const failing = makeZhipuFetch((url, init) => {
      if (url.includes('/coding/paas/v4/models')) {
        return Response.json({ code: 1003, success: false, msg: 'the plan has expired' })
      }
      return console_(url as never, init as never) as unknown as Response
    })
    await beginWebLogin(store, { fetchFn: failing, port: 0, endpoints: ENDPOINTS, openBrowser: () => undefined })
    submitLoginCode('code-1')
    await vi.waitFor(() => { expect(getWebLoginStatus().status).toBe('error') })
    expect(getWebLoginStatus().error).toMatch(/GLM Coding Plan/)
    expect(getWebLoginStatus().error).toMatch(/the plan has expired/)
    expect(await store.read()).toBeNull()
  })

  it('retries on an ephemeral port when the preferred one cannot be bound', async () => {
    // The console takes the redirect URI from the request, so a machine whose
    // preferred port is taken (or reserved on Windows, which reports EACCES
    // rather than EADDRINUSE) still signs in — the URL just names another port.
    const store = await createZhipuCredentialStore()
    const started = await beginWebLogin(store, {
      fetchFn: makeConsole({}),
      port: 54548,
      endpoints: ENDPOINTS,
      openBrowser: () => undefined,
    })
    expect(started.status).toBe('pending')
    expect(started.authUrl).toBeDefined()
  })
})

describe('zhipu login routes', () => {
  let store: FileCredentialStore
  let handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  let originalFetch: typeof fetch

  function fakeExchange(): { response: ServerResponse; captured: { status: number; body: unknown } } {
    const captured = { status: 0, body: undefined as unknown }
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
        if (input.body !== undefined) listeners.get('data')?.forEach((listener) => listener(Buffer.from(JSON.stringify(input.body))))
        listeners.get('end')?.forEach((listener) => listener())
      })
    }
    return request
  }

  beforeEach(async () => {
    resetWebLogin()
    clearCachedCatalog()
    clearCachedQuota()
    store = await createZhipuCredentialStore()
    const modelSettings = new FileModelSettingsStore(await zhipuSettingsFile())
    const routes: Array<{ handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }> = []
    const ctx = {
      webServer: {
        register(route: { handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }) {
          routes.push(route)
          return () => undefined
        },
      },
    } as unknown as Context
    originalFetch = globalThis.fetch
    registerZhipuRoutes(ctx, store, modelSettings, undefined, { fetchFn: makeConsole({}), oauthPort: 0 })
    handler = routes[0]!.handler
  })

  afterEach(() => {
    resetWebLogin()
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('refuses a China-region sign-in and points at the key field instead', async () => {
    const { response, captured } = fakeExchange()
    await handler(fakeRequest({ url: '/zhipu/api/login', method: 'POST', body: { region: 'cn' } }), response)
    expect(captured.status).toBe(400)
    expect((captured.body as { error: string }).error).toMatch(/open\.bigmodel\.cn/)
  })

  it('refuses a cross-origin sign-in request', async () => {
    const { response, captured } = fakeExchange()
    const request = fakeRequest({ url: '/zhipu/api/login', method: 'POST', body: {} })
    ;(request as unknown as { headers: Record<string, string> }).headers = { host: '127.0.0.1:3000', origin: 'http://evil.example' }
    await handler(request, response)
    expect(captured.status).toBe(403)
  })

  it('starts a sign-in and reports it through the polled status route', async () => {
    const { response, captured } = fakeExchange()
    await handler(fakeRequest({ url: '/zhipu/api/login', method: 'POST', body: { region: 'intl' } }), response)
    expect(captured.status).toBe(200)
    expect((captured.body as { value: { status: string } }).value.status).toBe('pending')

    const polled = fakeExchange()
    await handler(fakeRequest({ url: '/zhipu/api/login/status' }), polled.response)
    expect((polled.captured.body as { value: { authUrl?: string } }).value.authUrl).toContain('chat.z.ai')
  })

  it('answers a cancel with an idle flow', async () => {
    const start = fakeExchange()
    await handler(fakeRequest({ url: '/zhipu/api/login', method: 'POST', body: {} }), start.response)
    const cancelled = fakeExchange()
    await handler(fakeRequest({ url: '/zhipu/api/login/cancel', method: 'POST', body: {} }), cancelled.response)
    expect((cancelled.captured.body as { value: { status: string } }).value.status).toBe('idle')
  })

  it('reports a code submission with no sign-in in progress as a 400', async () => {
    const { response, captured } = fakeExchange()
    await handler(fakeRequest({ url: '/zhipu/api/login/code', method: 'POST', body: { code: 'abc' } }), response)
    expect(captured.status).toBe(400)
  })

  it('routes the whole sign-in through the pool when one is installed', async () => {
    const routes: Array<{ handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }> = []
    const ctx = {
      webServer: {
        register(route: { handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }) {
          routes.push(route)
          return () => undefined
        },
      },
    } as unknown as Context
    const added: string[] = []
    const pool = {
      async addAccount(credentials: { apiKey: string }) { added.push(credentials.apiKey) },
    }
    registerZhipuRoutes(ctx, store, new FileModelSettingsStore(await zhipuSettingsFile()), undefined, {
      fetchFn: makeConsole({}),
      accountPool: pool as never,
      oauthPort: 0,
    })
    const { response, captured } = fakeExchange()
    await routes[0]!.handler(fakeRequest({ url: '/zhipu/api/login', method: 'POST', body: {} }), response)
    expect(captured.status).toBe(200)
    const started = (captured.body as { value: { authUrl?: string } }).value
    expect(started.authUrl).toBeDefined()

    const code = fakeExchange()
    await routes[0]!.handler(fakeRequest({ url: '/zhipu/api/login/code', method: 'POST', body: { code: 'code-1' } }), code.response)
    await vi.waitFor(() => { expect(added).toEqual(['key-id-1.secret-1']) })
  })
})

describe('zai oauth endpoint defaults', () => {
  it('uses the console hosts the flow depends on', () => {
    const endpoints = defaultOAuthEndpoints()
    expect(endpoints.authorizeUrl).toBe('https://chat.z.ai/api/oauth/authorize')
    expect(endpoints.tokenUrl).toBe('https://zcode.z.ai/api/v1/oauth/token')
    expect(endpoints.bizBase).toBe('https://api.z.ai')
    expect(endpoints.businessLoginUrl).toBe('https://api.z.ai/api/auth/z/login')
    // The key name is this plugin's own so the official client's key is untouched.
    expect(endpoints.keyName).not.toBe('zcode-api-key')
  })
})
