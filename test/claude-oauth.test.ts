/**
 * Security and behaviour tests for the Claude subscription OAuth flow.
 *
 * WHAT THESE TESTS ARE FOR.
 *
 * Most of them exist because a plausible-looking implementation gets the
 * property WRONG in a way no type checker can see, and each is named after the
 * property rather than after the function:
 *
 *   1. the authorize URL must not contain the PKCE verifier — the locally
 *      installed reference leaks it there (it sends 'state: verifier');
 *   2. concurrent ensureAccessToken callers must share exactly ONE refresh — on
 *      a rotation endpoint a burst spends the same refresh token twice and
 *      signs the user out over a race they never caused;
 *   3. a browser callback and a pasted code must race to exactly ONE exchange —
 *      two exchanges of one authorization code collect a final verdict on a
 *      code that was in fact valid, with the same effect;
 *   4. the polled status payload must carry no token material at any point.
 *
 * Everything runs against injected seams: a fetch mock, an injected listener,
 * an injected port probe, an injected browser opener. No test touches the real
 * network, opens a browser, or binds a port it did not choose — where a
 * listener is used it is created by this file, so the test never races with the
 * developer's own machine state or with another test run.
 */

import { createHash } from 'node:crypto'
import http, { request as httpRequest, type Server } from 'node:http'
import net from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ClaudeRetryableError,
  ClaudeUnauthorizedError,
  LOOPBACK_HOST,
  beginLogin,
  buildAuthorizeUrl,
  cancelLogin,
  ensureAccessToken,
  exchangeAuthorizationCode,
  generatePkceMaterial,
  getLoginStatus,
  refreshAccessToken,
  resolveCallbackPort,
  resolveLoginInput,
  submitLoginInput,
  type ClaudeTokenStore,
} from '../src/host/claude/oauth.ts'
import { isSubscriptionCredential, type ClaudeCredentials } from '../src/host/claude/token-store.ts'
import {
  CALLBACK_PATH,
  CALLBACK_PORT_ATTEMPTS,
  DEFAULT_CALLBACK_PORT,
  OAUTH_MANUAL_REDIRECT_URI,
  OAUTH_TOKEN_URL,
  loopbackRedirectUri,
} from '../src/host/claude/types.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Distinctive secret sentinels, so a leak is greppable rather than plausible. */
const ACCESS_TOKEN = 'ACCESS-TOKEN-SENTINEL-8f3a'
const REFRESH_TOKEN = 'REFRESH-TOKEN-SENTINEL-91cd'
const AUTHORIZATION_CODE = 'AUTHORIZATION-CODE-SENTINEL-40be'

interface FetchCall {
  url: string
  body: Record<string, unknown>
  headers: Record<string, string>
}

/** A fetch stub that records every body it was handed. */
function recordingFetch(respond: (call: FetchCall, index: number) => Response | Promise<Response>) {
  const calls: FetchCall[] = []
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
    const headers = (init?.headers ?? {}) as Record<string, string>
    const call: FetchCall = { url: String(input), body, headers }
    calls.push(call)
    return respond(call, calls.length - 1)
  })
  return { fn: fn as unknown as typeof fetch, calls, mock: fn }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

/** A successful token response. */
function tokenBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: ACCESS_TOKEN,
    refresh_token: REFRESH_TOKEN,
    expires_in: 3600,
    scope: 'user:inference',
    ...overrides,
  }
}

/** An in-memory store, so nothing here depends on token-store.ts. */
/**
 * An in-memory store written in the SIBLING store's own credential shape.
 *
 * Deliberately the real type, not a local stand-in: the whole point of these
 * cases is that what this module writes is what the store will accept, and a
 * hand-rolled shape would let the two drift while every test stayed green.
 */
function memoryStore(initial: ClaudeCredentials | null) {
  let value = initial
  const writes: ClaudeCredentials[] = []
  const store: ClaudeTokenStore = {
    read: async () => value,
    write: async (credentials) => { value = credentials; writes.push(credentials) },
  }
  return { store, writes, current: () => value }
}

function credentials(overrides: Partial<ClaudeCredentials> = {}): ClaudeCredentials {
  return {
    accessToken: 'stored-access-token',
    refreshToken: 'stored-refresh-token',
    // Already inside the 5-minute margin, so an ordinary call must refresh it.
    expiresAt: Date.now() - 1_000,
    scopes: ['user:inference'],
    ...overrides,
  }
}

/** A promise whose settlement this test controls, so a race is real, not merely fast. */
function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// ---------------------------------------------------------------------------
// Loopback helpers
// ---------------------------------------------------------------------------

function listenOn(port: number, host = LOOPBACK_HOST): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    server.once('error', reject)
    server.listen(port, host, () => resolve(server))
  })
}

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = http.createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, LOOPBACK_HOST)
  })
}

/**
 * The first bindable port in the range the flow itself probes.
 *
 * The default port may genuinely be occupied on the machine running the tests,
 * and the frozen redirect-URI helper will not invent a port, so the test
 * discovers the port the probe will actually resolve and asserts against that
 * one. The discovery cannot drift from the implementation: it walks the same
 * range from the same constant.
 */
async function firstBindablePort(): Promise<number> {
  for (let offset = 0; offset < CALLBACK_PORT_ATTEMPTS; offset += 1) {
    const port = DEFAULT_CALLBACK_PORT + offset
    if (await probePort(port)) return port
  }
  throw new Error('No bindable loopback port in the probe range.')
}

interface CallbackResponse {
  status: number
  body: string
}

/** Send one request to a callback listener and read the whole answer. */
function sendCallback(port: number, path: string, options: { localAddress?: string } = {}): Promise<CallbackResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: LOOPBACK_HOST,
      port,
      path,
      method: 'GET',
      headers: { host: LOOPBACK_HOST + ':' + port },
      // A different 127/8 source address is the only way to be a non-loopback
      // peer on a listener bound to the loopback interface.
      ...(options.localAddress === undefined
        ? {}
        : { createConnection: () => net.connect({ host: LOOPBACK_HOST, port, localAddress: options.localAddress }) }),
    }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
    })
    request.on('error', reject)
    request.end()
  })
}

/** The state the authorize URL carries; the only flow secret the URL may hold. */
function stateFromAuthUrl(authUrl: string): string {
  return new URL(authUrl).searchParams.get('state') ?? ''
}

function stateOf(status: { authUrl?: string }): string {
  return stateFromAuthUrl(status.authUrl ?? '')
}

afterEach(() => {
  // Every test ends with no flow armed, so a listener or timer leaked by one
  // case cannot influence the next case's status reading.
  cancelLogin()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// 1. PKCE and state independence
// ---------------------------------------------------------------------------

describe('PKCE material', () => {
  it('derives the challenge from the verifier and draws the state independently', () => {
    const material = generatePkceMaterial()
    expect(material.verifier.length).toBeGreaterThanOrEqual(43)
    expect(material.challenge).toBe(createHash('sha256').update(material.verifier).digest('base64url'))
    // The state is a second draw, not a function of the verifier.
    expect(material.state).not.toBe(material.verifier)
    expect(material.state).not.toBe(material.challenge)
    // At least 16 bytes, which is 22 base64url characters.
    expect(material.state.length).toBeGreaterThanOrEqual(22)

    const second = generatePkceMaterial()
    expect(second.verifier).not.toBe(material.verifier)
    expect(second.state).not.toBe(material.state)
  })

  it('puts the challenge and the state in the authorize URL, and NEVER the verifier', async () => {
    const store = memoryStore(null)
    const opened: string[] = []
    const stub = recordingFetch(() => jsonResponse(tokenBody()))

    const flow = await beginLogin(store.store, {
      mode: 'manual',
      openBrowser: (url) => { opened.push(url) },
      fetchFn: stub.fn,
    })

    const authUrl = opened[0] ?? ''
    expect(authUrl).not.toBe('')
    expect(authUrl).toBe(flow.authUrl)
    const params = new URL(authUrl).searchParams
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('redirect_uri')).toBe(OAUTH_MANUAL_REDIRECT_URI)
    const challenge = params.get('code_challenge') ?? ''
    const state = params.get('state') ?? ''
    expect(challenge).not.toBe('')
    expect(state).not.toBe('')

    // The verifier is observable from exactly one place: the exchange request.
    // Recovering it is what makes the negative assertion below bite.
    await expect(submitLoginInput(AUTHORIZATION_CODE + '#' + state)).resolves.toEqual({ ok: true })
    const verifier = String(stub.calls[0]?.body.code_verifier ?? '')
    expect(verifier.length).toBeGreaterThanOrEqual(43)

    // THE POINT OF THIS TEST: the secret the exchange used is in no URL.
    expect(authUrl).not.toContain(verifier)
    // ...and the pair behaves as PKCE requires: the challenge is its digest.
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
    expect(state).not.toBe(verifier)
  })

  it('never encrypts the verifier into the browser URL, in any flow of a run', async () => {
    const store = memoryStore(null)
    const opened: string[] = []
    const stub = recordingFetch(() => jsonResponse(tokenBody()))

    for (let round = 0; round < 3; round += 1) {
      const flow = await beginLogin(store.store, {
        mode: 'manual',
        openBrowser: (url) => { opened.push(url) },
        fetchFn: stub.fn,
      })
      await submitLoginInput(AUTHORIZATION_CODE + '#' + stateOf(flow))
    }

    const verifiers = stub.calls.map((call) => String(call.body.code_verifier ?? ''))
    expect(verifiers).toHaveLength(3)
    expect(new Set(verifiers).size).toBe(3)
    for (const [index, url] of opened.entries()) {
      for (const verifier of verifiers) {
        expect(url).not.toContain(verifier)
      }
      // Each authorize URL belongs to its own flow, so its own verifier is the
      // one that must be absent.
      expect(url).not.toContain(verifiers[index] ?? '')
    }
  })

  it('omits the verifier from a URL built directly from explicit material', () => {
    const material = generatePkceMaterial()
    const url = buildAuthorizeUrl({ redirectUri: OAUTH_MANUAL_REDIRECT_URI, state: material.state }, material.challenge)
    const params = new URL(url).searchParams
    expect(params.get('code_challenge')).toBe(material.challenge)
    expect(params.get('state')).toBe(material.state)
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('client_id')).toBeTruthy()
    expect(params.get('response_type')).toBe('code')
    expect(url).not.toContain(material.verifier)
  })
})

// ---------------------------------------------------------------------------
// 2. Manual sign-in input
// ---------------------------------------------------------------------------

describe('manual sign-in input', () => {
  it('accepts a full redirect URL, a code#state pair, and a query fragment', () => {
    expect(resolveLoginInput('https://platform.claude.com/oauth/code/callback?code=abc&state=xyz'))
      .toEqual({ ok: true, code: 'abc', state: 'xyz' })
    expect(resolveLoginInput('abc#xyz')).toEqual({ ok: true, code: 'abc', state: 'xyz' })
    expect(resolveLoginInput('code=abc&state=xyz')).toEqual({ ok: true, code: 'abc', state: 'xyz' })
    expect(resolveLoginInput('  abc#xyz  ')).toEqual({ ok: true, code: 'abc', state: 'xyz' })
  })

  it('rejects a bare code, which cannot be bound to this flow', () => {
    // Accepting this would mean substituting the flow's own state, which
    // defeats the state parameter: anyone who can talk a user into pasting a
    // code they supplied would bind that user's session to another account.
    const parsed = resolveLoginInput('just-a-code')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toMatch(/bare code/)
  })

  it('rejects a URL or fragment with no state rather than guessing one', () => {
    expect(resolveLoginInput('https://platform.claude.com/oauth/code/callback?code=abc').ok).toBe(false)
    expect(resolveLoginInput('code=abc').ok).toBe(false)
  })

  it('rejects an empty paste and a half a pair', () => {
    expect(resolveLoginInput('   ').ok).toBe(false)
    expect(resolveLoginInput('abc#').ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. Flow isolation between the two modes
// ---------------------------------------------------------------------------

describe('flow isolation', () => {
  it('abandons the previous flow and issues a new authorization request when the mode changes', async () => {
    const store = memoryStore(null)
    const freePort = await firstBindablePort()
    const stub = recordingFetch(() => jsonResponse(tokenBody()))

    const manual = await beginLogin(store.store, { mode: 'manual', openBrowser: () => undefined, fetchFn: stub.fn })
    expect(manual.mode).toBe('manual')
    expect(manual.redirectUri).toBe(OAUTH_MANUAL_REDIRECT_URI)

    const loopback = await beginLogin(store.store, {
      mode: 'loopback',
      probe: async (port) => port === freePort,
      listen: listenOn,
      openBrowser: () => undefined,
      fetchFn: stub.fn,
    })
    expect(loopback.mode).toBe('loopback')
    expect(loopback.redirectUri).toBe(loopbackRedirectUri(freePort))

    // A NEW flow: nothing about the authorization request survives the switch.
    expect(loopback.flowId).not.toBe(manual.flowId)
    expect(loopback.authUrl).not.toBe(manual.authUrl)
    expect(stateOf(loopback)).not.toBe(stateOf(manual))

    // The abandoned flow's code/state pair can no longer exchange anything.
    const stale = await submitLoginInput(AUTHORIZATION_CODE + '#' + stateOf(manual))
    expect(stale.ok).toBe(false)
    if (!stale.ok) {
      expect(stale.httpStatus).toBe(400)
      expect(stub.calls).toHaveLength(0)
    }
  })

  it('exchanges with the redirect URI recorded on the flow, not a current-UI value', async () => {
    const store = memoryStore(null)
    const freePort = await firstBindablePort()
    const stub = recordingFetch(() => jsonResponse(tokenBody()))

    const flow = await beginLogin(store.store, {
      mode: 'loopback',
      probe: async (port) => port === freePort,
      listen: listenOn,
      openBrowser: () => undefined,
      fetchFn: stub.fn,
    })
    expect(flow.redirectUri).toBe(loopbackRedirectUri(freePort))

    const result = await submitLoginInput(AUTHORIZATION_CODE + '#' + stateOf(flow))
    expect(result.ok).toBe(true)

    expect(stub.calls).toHaveLength(1)
    const call = stub.calls[0]
    expect(call?.url).toBe(OAUTH_TOKEN_URL)
    const body = call?.body ?? {}
    // The code was issued for the loopback request, so the loopback URI is what
    // the exchange must send — never the manual URI the UI could be showing.
    expect(body.redirect_uri).toBe(loopbackRedirectUri(freePort))
    expect(body.redirect_uri).not.toBe(OAUTH_MANUAL_REDIRECT_URI)
    expect(body.grant_type).toBe('authorization_code')
    expect(body.code).toBe(AUTHORIZATION_CODE)
    expect(body.state).toBe(stateOf(flow))
    expect(String(body.code_verifier ?? '').length).toBeGreaterThanOrEqual(43)
    expect(String(body.client_id ?? '')).not.toBe('')
  })

  it('starts the manual flow by default and opens exactly one URL', async () => {
    const store = memoryStore(null)
    const opened: string[] = []
    const status = await beginLogin(store.store, { openBrowser: (url) => { opened.push(url) } })
    expect(status.mode).toBe('manual')
    expect(status.redirectUri).toBe(OAUTH_MANUAL_REDIRECT_URI)
    expect(status.status).toBe('pending')
    expect(status.flowId).toBeTruthy()
    expect(opened).toEqual([status.authUrl])
  })
})

// ---------------------------------------------------------------------------
// 4. Loopback listener
// ---------------------------------------------------------------------------

describe('loopback callback listener', () => {
  it('binds IPv4 loopback and completes the sign-in on the callback path', async () => {
    const store = memoryStore(null)
    const freePort = await firstBindablePort()
    const holder: { server: Server | null } = { server: null }
    const stub = recordingFetch(() => jsonResponse(tokenBody()))

    const flow = await beginLogin(store.store, {
      mode: 'loopback',
      probe: async (port) => port === freePort,
      listen: async (port, host) => {
        const server = await listenOn(port, host)
        holder.server = server
        return server
      },
      openBrowser: () => undefined,
      fetchFn: stub.fn,
    })

    const bound = holder.server
    expect(bound).not.toBeNull()
    const address = bound === null ? null : bound.address()
    expect(address !== null && typeof address === 'object').toBe(true)
    if (address !== null && typeof address === 'object' && typeof address !== 'string') {
      // The family is asserted, not assumed: a listener that came up on '::'
      // or '0.0.0.0' would answer on every interface the machine has.
      expect(address.family).toBe('IPv4')
      expect(address.address).toBe(LOOPBACK_HOST)
      expect(address.port).toBe(freePort)
    }
    const redirect = new URL(flow.redirectUri ?? '')
    expect(redirect.hostname).toBe('localhost')
    expect(redirect.port).toBe(String(freePort))
    expect(redirect.pathname).toBe(CALLBACK_PATH)

    const response = await sendCallback(freePort, CALLBACK_PATH + '?code=' + AUTHORIZATION_CODE + '&state=' + stateOf(flow))
    expect(response.status).toBe(200)
    expect(response.body).toContain('Claude sign-in completed')
    expect(getLoginStatus().status).toBe('complete')
    expect(store.current()?.accessToken).toBe(ACCESS_TOKEN)
    if (bound !== null) await new Promise<void>((resolve) => { bound.close(() => resolve()) })
  })

  it('answers 404 off the callback path', async () => {
    const store = memoryStore(null)
    const freePort = await firstBindablePort()
    await beginLogin(store.store, {
      mode: 'loopback',
      probe: async (port) => port === freePort,
      listen: listenOn,
      openBrowser: () => undefined,
      fetchFn: recordingFetch(() => jsonResponse(tokenBody())).fn,
    })
    const response = await sendCallback(freePort, '/not-the-callback')
    expect(response.status).toBe(404)
  })

  it('answers 403 to a peer that is not one of the accepted loopback literals', async () => {
    const store = memoryStore(null)
    const freePort = await firstBindablePort()
    const stub = recordingFetch(() => jsonResponse(tokenBody()))
    const flow = await beginLogin(store.store, {
      mode: 'loopback',
      probe: async (port) => port === freePort,
      listen: listenOn,
      openBrowser: () => undefined,
      fetchFn: stub.fn,
    })
    const response = await sendCallback(
      freePort,
      CALLBACK_PATH + '?code=' + AUTHORIZATION_CODE + '&state=' + stateOf(flow),
      { localAddress: '127.0.0.2' },
    )
    expect(response.status).toBe(403)
    // A refused request disturbs nothing: no exchange, and the flow is still live.
    expect(stub.calls).toHaveLength(0)
    expect(getLoginStatus().status).toBe('pending')
  })

  it('skips an occupied port and reports the one it really bound', async () => {
    const store = memoryStore(null)
    const freePort = await firstBindablePort()
    const blocker = await listenOn(freePort)
    const nextPort = freePort + 1
    try {
      const probed: number[] = []
      const flow = await beginLogin(store.store, {
        mode: 'loopback',
        probe: async (port) => { probed.push(port); return port === nextPort },
        listen: listenOn,
        openBrowser: () => undefined,
        fetchFn: recordingFetch(() => jsonResponse(tokenBody())).fn,
      })
      expect(flow.mode).toBe('loopback')
      expect(flow.redirectUri).toBe(loopbackRedirectUri(nextPort))
      expect(probed).toContain(freePort)
      expect(probed).toContain(nextPort)
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  it('falls back to manual when no port can be bound, and says why', async () => {
    const store = memoryStore(null)
    const probed: number[] = []
    const opened: string[] = []
    const flow = await beginLogin(store.store, {
      mode: 'loopback',
      probe: async (port) => { probed.push(port); return false },
      openBrowser: (url) => { opened.push(url) },
      fetchFn: recordingFetch(() => jsonResponse(tokenBody())).fn,
    })

    // Probing failure is NOT a hard error: the flow degrades to manual, which
    // needs no port at all, and the caller is told why.
    expect(flow.mode).toBe('manual')
    expect(flow.redirectUri).toBe(OAUTH_MANUAL_REDIRECT_URI)
    expect(flow.fallbackReason).toBeTruthy()
    expect(flow.fallbackReason).toContain(String(DEFAULT_CALLBACK_PORT))
    expect(probed.length).toBeGreaterThan(0)
    expect(probed.length).toBeLessThanOrEqual(CALLBACK_PORT_ATTEMPTS)
    expect(opened).toHaveLength(1)
    expect(new URL(opened[0] ?? 'https://invalid/').searchParams.get('redirect_uri')).toBe(OAUTH_MANUAL_REDIRECT_URI)
  })

  it('rejects a wrong state without cancelling the in-flight sign-in', async () => {
    const store = memoryStore(null)
    const freePort = await firstBindablePort()
    const stub = recordingFetch(() => jsonResponse(tokenBody()))
    const flow = await beginLogin(store.store, {
      mode: 'loopback',
      probe: async (port) => port === freePort,
      listen: listenOn,
      openBrowser: () => undefined,
      fetchFn: stub.fn,
    })

    const rejected = await sendCallback(freePort, CALLBACK_PATH + '?code=' + AUTHORIZATION_CODE + '&state=not-the-state')
    expect(rejected.status).toBe(400)
    // The flow is untouched: no exchange happened and the sign-in is still live.
    expect(stub.calls).toHaveLength(0)
    expect(getLoginStatus().status).toBe('pending')

    // ...so the REAL callback still succeeds afterwards.
    const accepted = await sendCallback(freePort, CALLBACK_PATH + '?code=' + AUTHORIZATION_CODE + '&state=' + stateOf(flow))
    expect(accepted.status).toBe(200)
    expect(stub.calls).toHaveLength(1)
    expect(getLoginStatus().status).toBe('complete')
  })

  it('degrades to manual when the listener cannot bind IPv4 loopback', async () => {
    const store = memoryStore(null)
    const freePort = await firstBindablePort()
    const flow = await beginLogin(store.store, {
      mode: 'loopback',
      probe: async (port) => port === freePort,
      // A listener that cannot prove it bound the loopback literal is not
      // acceptable, and the flow must notice rather than trust the probe.
      listen: async () => { throw new Error('The Claude sign-in callback listener did not bind IPv4 loopback.') },
      openBrowser: () => undefined,
      fetchFn: recordingFetch(() => jsonResponse(tokenBody())).fn,
    })
    expect(flow.mode).toBe('manual')
    expect(flow.redirectUri).toBe(OAUTH_MANUAL_REDIRECT_URI)
    expect(flow.fallbackReason).toMatch(/did not bind IPv4 loopback/)
  })

  it('resolves a port through the probe, and gives up after the attempt budget', async () => {
    expect(await resolveCallbackPort(async (port) => port === DEFAULT_CALLBACK_PORT + 3, 8)).toBe(DEFAULT_CALLBACK_PORT + 3)
    expect(await resolveCallbackPort(async (port) => port === DEFAULT_CALLBACK_PORT, 1)).toBe(DEFAULT_CALLBACK_PORT)
    expect(await resolveCallbackPort(async () => false, 4)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 5. Exactly-once exchange
// ---------------------------------------------------------------------------

describe('exactly-once exchange', () => {
  it('lets a pasted code and a browser callback race to exactly ONE exchange', async () => {
    const store = memoryStore(null)
    const freePort = await firstBindablePort()

    // The exchange is held open at the network boundary, so the callback
    // provably arrives WHILE the first exchange is still in flight rather than
    // after it finished.
    const gate = deferred()
    const stub = recordingFetch(async () => {
      await gate.promise
      return jsonResponse(tokenBody())
    })

    const flow = await beginLogin(store.store, {
      mode: 'loopback',
      probe: async (port) => port === freePort,
      listen: listenOn,
      openBrowser: () => undefined,
      fetchFn: stub.fn,
    })
    const state = stateOf(flow)

    // The paste claims the one exchange. It reaches the fetch call before this
    // line returns — the claim is synchronous and the request is issued before
    // the first await resolves — so the overlap below is deterministic, not a
    // sleep-based guess.
    const paste = submitLoginInput(AUTHORIZATION_CODE + '#' + state)
    expect(stub.calls).toHaveLength(1)

    // The browser callback now arrives for the SAME code, mid-exchange.
    const raced = await sendCallback(freePort, CALLBACK_PATH + '?code=' + AUTHORIZATION_CODE + '&state=' + state)
    expect(raced.status).toBe(409)
    expect(raced.body).toContain('already in progress')
    // The loser performed NO second exchange.
    expect(stub.calls).toHaveLength(1)

    gate.resolve()
    await expect(paste).resolves.toEqual({ ok: true })
    expect(stub.calls).toHaveLength(1)
    // The one exchange that happened carried this flow's verifier.
    expect(String(stub.calls[0]?.body.code_verifier ?? '').length).toBeGreaterThanOrEqual(43)
    expect(store.current()?.accessToken).toBe(ACCESS_TOKEN)
    expect(store.current()?.refreshToken).toBe(REFRESH_TOKEN)
    expect(getLoginStatus().status).toBe('complete')
  })

  it('refuses a second paste with 409 while the first exchange is in flight', async () => {
    const store = memoryStore(null)
    const gate = deferred()
    const stub = recordingFetch(async () => { await gate.promise; return jsonResponse(tokenBody()) })

    const flow = await beginLogin(store.store, { mode: 'manual', openBrowser: () => undefined, fetchFn: stub.fn })
    const state = stateOf(flow)

    const first = submitLoginInput(AUTHORIZATION_CODE + '#' + state)
    const second = await submitLoginInput(AUTHORIZATION_CODE + '#' + state)
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.httpStatus).toBe(409)
      expect(second.error).toContain('already in progress')
    }
    expect(stub.calls).toHaveLength(1)

    gate.resolve()
    await expect(first).resolves.toEqual({ ok: true })
    expect(stub.calls).toHaveLength(1)
  })

  it('answers 410 and performs no exchange once the flow has settled', async () => {
    const store = memoryStore(null)
    const freePort = await firstBindablePort()
    const stub = recordingFetch(() => jsonResponse(tokenBody()))
    const flow = await beginLogin(store.store, {
      mode: 'loopback',
      probe: async (port) => port === freePort,
      listen: listenOn,
      openBrowser: () => undefined,
      fetchFn: stub.fn,
    })
    const state = stateOf(flow)

    const first = await sendCallback(freePort, CALLBACK_PATH + '?code=' + AUTHORIZATION_CODE + '&state=' + state)
    expect(first.status).toBe(200)
    expect(stub.calls).toHaveLength(1)

    // A replayed callback: 410, and the code is NOT exchanged a second time.
    const replay = await sendCallback(freePort, CALLBACK_PATH + '?code=' + AUTHORIZATION_CODE + '&state=' + state)
    expect(replay.status).toBe(410)
    expect(stub.calls).toHaveLength(1)

    // The pasted path has the same semantics.
    const latePaste = await submitLoginInput(AUTHORIZATION_CODE + '#' + state)
    expect(latePaste.ok).toBe(false)
    if (!latePaste.ok) expect(latePaste.httpStatus).toBe(410)
    expect(stub.calls).toHaveLength(1)

    // And after a cancel there is no flow at all to exchange against.
    cancelLogin()
    const afterCancel = await submitLoginInput(AUTHORIZATION_CODE + '#' + state)
    expect(afterCancel.ok).toBe(false)
    if (!afterCancel.ok) expect(afterCancel.httpStatus).toBe(410)
    expect(getLoginStatus().status).toBe('idle')
    expect(stub.calls).toHaveLength(1)
  })

  it('cancelLogin aborts the flow and releases the listener and its port', async () => {
    const store = memoryStore(null)
    const freePort = await firstBindablePort()
    await beginLogin(store.store, {
      mode: 'loopback',
      probe: async (port) => port === freePort,
      listen: listenOn,
      openBrowser: () => undefined,
      fetchFn: recordingFetch(() => jsonResponse(tokenBody())).fn,
    })

    cancelLogin()
    expect(getLoginStatus()).toEqual({ status: 'idle' })

    // The port really came back: it can be bound again immediately.
    const rebind = await listenOn(freePort)
    await new Promise<void>((resolve) => rebind.close(() => resolve()))
  })

  it('ends the flow on LOGIN_TIMEOUT_MS and reports an actionable error', async () => {
    vi.useFakeTimers()
    const store = memoryStore(null)
    const flow = await beginLogin(store.store, {
      mode: 'manual',
      openBrowser: () => undefined,
      fetchFn: recordingFetch(() => jsonResponse(tokenBody())).fn,
      timeoutMs: 5_000,
    })
    const state = stateOf(flow)

    await vi.advanceTimersByTimeAsync(5_001)
    const status = getLoginStatus()
    expect(status.status).toBe('error')
    expect(status.error).toMatch(/timed out/)

    // A code that arrives after the timeout cannot revive the flow.
    vi.useRealTimers()
    const late = await submitLoginInput(AUTHORIZATION_CODE + '#' + state)
    expect(late.ok).toBe(false)
    if (!late.ok) expect(late.httpStatus).toBe(410)
  })
})

// ---------------------------------------------------------------------------
// 6. Token exchange, classification, refresh semantics
// ---------------------------------------------------------------------------

describe('token exchange', () => {
  it('treats a missing access token or a missing refresh token as an error', async () => {
    const noAccess = recordingFetch(() => jsonResponse({ refresh_token: REFRESH_TOKEN, expires_in: 3600 }))
    await expect(exchangeAuthorizationCode(
      { code: 'c', state: 's', verifier: 'v'.repeat(43), redirectUri: OAUTH_MANUAL_REDIRECT_URI },
      { fetchFn: noAccess.fn },
    )).rejects.toThrow(/access token/)

    // A subscription credential with no refresh token can never be renewed, so
    // storing one would produce an account that looks signed in and dies at the
    // first expiry. Not an empty credential — an error.
    const noRefresh = recordingFetch(() => jsonResponse({ access_token: ACCESS_TOKEN, expires_in: 3600 }))
    await expect(exchangeAuthorizationCode(
      { code: 'c', state: 's', verifier: 'v'.repeat(43), redirectUri: OAUTH_MANUAL_REDIRECT_URI },
      { fetchFn: noRefresh.fn },
    )).rejects.toThrow(/refresh token/)
  })

  it('refuses an invalid lifetime and applies the 5-minute margin', async () => {
    const bad = recordingFetch(() => jsonResponse(tokenBody({ expires_in: 0 })))
    await expect(exchangeAuthorizationCode(
      { code: 'c', state: 's', verifier: 'v'.repeat(43), redirectUri: OAUTH_MANUAL_REDIRECT_URI },
      { fetchFn: bad.fn },
    )).rejects.toThrow(/lifetime/)

    const before = Date.now()
    const good = recordingFetch(() => jsonResponse(tokenBody({ expires_in: 3600 })))
    const token = await exchangeAuthorizationCode(
      { code: 'c', state: 's', verifier: 'v'.repeat(43), redirectUri: OAUTH_MANUAL_REDIRECT_URI },
      { fetchFn: good.fn },
    )
    const expected = before + 3600 * 1000 - 300_000
    expect(token.expiresAt).toBeGreaterThanOrEqual(expected)
    expect(token.expiresAt).toBeLessThanOrEqual(expected + 5_000)
    expect(token.expiresIn).toBe(3600)
    expect(token.scopes).toEqual(['user:inference'])
    expect(token.account).toEqual({})
  })

  it('reads the account block when the response carries one', async () => {
    const stub = recordingFetch(() => jsonResponse(
      tokenBody({ account: { uuid: 'uuid-1', email_address: 'user@example.com' } }),
    ))
    const token = await exchangeAuthorizationCode(
      { code: 'c', state: 's', verifier: 'v'.repeat(43), redirectUri: OAUTH_MANUAL_REDIRECT_URI },
      { fetchFn: stub.fn },
    )
    expect(token.account).toEqual({ uuid: 'uuid-1', email_address: 'user@example.com' })
  })

  it('classifies 401 and invalid_grant as FINAL, and never retries them', async () => {
    for (const response of [
      jsonResponse({ error: { type: 'authentication_error', message: 'bad token' } }, 401),
      jsonResponse({ error: 'invalid_grant', error_description: 'grant is invalid' }, 400),
    ]) {
      const stub = recordingFetch(() => response.clone())
      await expect(refreshAccessToken('the-refresh-token', { fetchFn: stub.fn })).rejects.toBeInstanceOf(ClaudeUnauthorizedError)
      // Retrying a final verdict can never succeed, and on a rotation endpoint
      // it is another chance to spend the refresh token.
      expect(stub.calls).toHaveLength(1)
    }
  })

  it('classifies 429 and 5xx as retryable, within a bounded budget', async () => {
    vi.useFakeTimers()
    const stub = recordingFetch((_call, index) =>
      index < 2
        ? jsonResponse({ error: { type: 'overloaded_error', message: 'busy' } }, 500)
        : jsonResponse(tokenBody()))
    const pending = refreshAccessToken('the-refresh-token', { fetchFn: stub.fn })
    await vi.advanceTimersByTimeAsync(10_000)
    const token = await pending
    expect(token.accessToken).toBe(ACCESS_TOKEN)
    expect(stub.calls).toHaveLength(3)
    vi.useRealTimers()

    vi.useFakeTimers()
    const always = recordingFetch(() => jsonResponse({ error: 'rate limited' }, 429))
    const failing = refreshAccessToken('the-refresh-token', { fetchFn: always.fn })
    failing.catch(() => undefined)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(failing).rejects.toBeInstanceOf(ClaudeRetryableError)
    expect(always.calls).toHaveLength(3)
    vi.useRealTimers()
  })

  it('does not echo a request secret back in an error message', async () => {
    // A server that quotes part of the request in its error body must not be
    // able to put a secret into a message that ends up in the polled status.
    const verifier = 'v'.repeat(43)
    const stub = recordingFetch(() => jsonResponse(
      { error: { type: 'invalid_request_error', message: 'code ' + AUTHORIZATION_CODE + ' verifier ' + verifier + ' rejected' } },
      400,
    ))
    let failure: Error | null = null
    try {
      await exchangeAuthorizationCode(
        { code: AUTHORIZATION_CODE, state: 'a-state-value', verifier, redirectUri: OAUTH_MANUAL_REDIRECT_URI },
        { fetchFn: stub.fn },
      )
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
    }

    expect(failure).not.toBeNull()
    const message = failure?.message ?? ''
    expect(message).toContain('[redacted]')
    expect(message).not.toContain(AUTHORIZATION_CODE)
    expect(message).not.toContain(verifier)
  })

  it('rotates the stored refresh token, and keeps the old one when none is sent', async () => {
    const rotated = memoryStore(credentials({ refreshToken: 'old-refresh-token' }))
    const rotate = recordingFetch(() => jsonResponse(tokenBody({ refresh_token: REFRESH_TOKEN })))
    const refreshed = await ensureAccessToken(rotated.store, { fetchFn: rotate.fn })
    expect(refreshed.refreshToken).toBe(REFRESH_TOKEN)
    expect(rotated.current()?.refreshToken).toBe(REFRESH_TOKEN)

    const kept = memoryStore(credentials({ refreshToken: 'still-good-refresh-token' }))
    const omitted = recordingFetch(() => jsonResponse({ access_token: ACCESS_TOKEN, expires_in: 3600 }))
    const keptResult = await ensureAccessToken(kept.store, { fetchFn: omitted.fn })
    expect(keptResult.accessToken).toBe(ACCESS_TOKEN)
    // Nothing new was reported, so nothing is thrown away.
    expect(keptResult.refreshToken).toBe('still-good-refresh-token')
    expect(kept.current()?.refreshToken).toBe('still-good-refresh-token')
  })
})

// ---------------------------------------------------------------------------
// 7. Single-flight refresh
// ---------------------------------------------------------------------------

describe('ensureAccessToken', () => {
  it('shares exactly ONE refresh between concurrent callers', async () => {
    const store = memoryStore(credentials({ refreshToken: 'one-shot-refresh-token' }))

    // The rotation endpoint is held open, so every caller is provably inside
    // the SAME refresh rather than merely arriving after the first finished.
    const gate = deferred()
    const stub = recordingFetch(async () => {
      await gate.promise
      return jsonResponse(tokenBody({ refresh_token: 'rotated-refresh-token' }))
    })

    // TEN callers, because the failure this guards against scales: a burst of
    // tool calls at expiry would otherwise each rotate the token, and every
    // rotation after the first spends a refresh token the first already spent —
    // which the endpoint answers with a final verdict.
    const callers = Array.from({ length: 10 }, () => ensureAccessToken(store.store, { fetchFn: stub.fn }))
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve()
    expect(stub.calls).toHaveLength(1)

    gate.resolve()
    const results = await Promise.all(callers)

    // ONE network call for ten callers, ONE write, and one shared answer.
    expect(stub.calls).toHaveLength(1)
    expect(store.writes).toHaveLength(1)
    for (const result of results) expect(result).toEqual(results[0])
    expect(results[0]?.accessToken).toBe(ACCESS_TOKEN)
    expect(results[9]?.refreshToken).toBe('rotated-refresh-token')
    expect(store.current()?.refreshToken).toBe('rotated-refresh-token')
  })

  it('does not refresh a credential that still has margin, and does not touch the store', async () => {
    const store = memoryStore(credentials({ expiresAt: Date.now() + 3_600_000 }))
    const stub = recordingFetch(() => jsonResponse(tokenBody()))
    const result = await ensureAccessToken(store.store, { fetchFn: stub.fn })
    expect(result.accessToken).toBe('stored-access-token')
    expect(stub.calls).toHaveLength(0)
    expect(store.writes).toHaveLength(0)
  })

  it('refreshes when forced, and reports "not signed in" as a final verdict', async () => {
    const store = memoryStore(credentials({ expiresAt: Date.now() + 3_600_000 }))
    const stub = recordingFetch(() => jsonResponse(tokenBody()))
    await ensureAccessToken(store.store, { fetchFn: stub.fn, force: true })
    expect(stub.calls).toHaveLength(1)

    const empty = memoryStore(null)
    await expect(ensureAccessToken(empty.store, { fetchFn: stub.fn })).rejects.toBeInstanceOf(ClaudeUnauthorizedError)
  })

  it('clears the single-flight slot after a failure, so the next call retries', async () => {
    const store = memoryStore(credentials())
    const stub = recordingFetch(() => jsonResponse({ error: { type: 'authentication_error', message: 'no' } }, 401))
    await expect(ensureAccessToken(store.store, { fetchFn: stub.fn })).rejects.toBeInstanceOf(ClaudeUnauthorizedError)
    await expect(ensureAccessToken(store.store, { fetchFn: stub.fn })).rejects.toBeInstanceOf(ClaudeUnauthorizedError)
    // A rejected promise left in the slot would make every later caller inherit
    // the FIRST failure forever.
    expect(stub.calls).toHaveLength(2)
  })

  it('lets a second caller retry after the shared refresh failed', async () => {
    const store = memoryStore(credentials())
    // The first call exhausts refreshAccessToken's whole retry budget, so the
    // shared promise REJECTS; the next call must start a new refresh rather
    // than joining a promised failure forever.
    let attempt = 0
    const stub = recordingFetch(() => {
      attempt += 1
      return attempt <= 3
        ? jsonResponse({ error: { type: 'overloaded_error', message: 'busy' } }, 500)
        : jsonResponse(tokenBody())
    })
    vi.useFakeTimers()
    const first = ensureAccessToken(store.store, { fetchFn: stub.fn })
    first.catch(() => undefined)
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(first).rejects.toBeInstanceOf(ClaudeRetryableError)
    expect(stub.calls).toHaveLength(3)
    vi.useRealTimers()

    const second = await ensureAccessToken(store.store, { fetchFn: stub.fn })
    expect(second.accessToken).toBe(ACCESS_TOKEN)
    expect(stub.calls).toHaveLength(4)
  })
})

// ---------------------------------------------------------------------------
// 8. Secret hygiene of the polled status
// ---------------------------------------------------------------------------

describe('status payload hygiene', () => {
  it('carries no token material, and holds the state only inside the authorize URL that must carry it', async () => {
    const store = memoryStore(null)
    const payloads: string[] = []

    const pending = await beginLogin(store.store, { mode: 'manual', openBrowser: () => undefined })
    payloads.push(JSON.stringify(pending))

    const stub = recordingFetch(() => jsonResponse(
      tokenBody({ account: { uuid: 'uuid-1', email_address: 'user@example.com' } }),
    ))
    const flow = await beginLogin(store.store, { mode: 'manual', openBrowser: () => undefined, fetchFn: stub.fn })
    payloads.push(JSON.stringify(flow))

    const result = await submitLoginInput(AUTHORIZATION_CODE + '#' + stateOf(flow))
    expect(result.ok).toBe(true)
    const settled = getLoginStatus()
    payloads.push(JSON.stringify(settled))

    const verifier = String(stub.calls[0]?.body.code_verifier ?? '')
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    const serialized = payloads.join('\n')
    // Every credential is absent from every payload, at every point in time.
    for (const secret of [verifier, AUTHORIZATION_CODE, ACCESS_TOKEN, REFRESH_TOKEN, 'user@example.com']) {
      expect(secret.length).toBeGreaterThan(3)
      expect(serialized).not.toContain(secret)
    }
    // No status has a field that could hold one either. 'code_challenge' is
    // deliberately NOT in this pattern: it is public by construction and its
    // presence in the authorize URL is the PKCE contract, not a leak.
    expect(serialized).not.toMatch(/accessToken|refreshToken|"verifier"|code_verifier|access_token|refresh_token/)
    expect(settled.status).toBe('complete')
  })

  it('puts the flow state in a status field ONLY as part of the authorize URL it must be sent in', async () => {
    const store = memoryStore(null)
    const status = await beginLogin(store.store, { mode: 'manual', openBrowser: () => undefined })
    const state = stateOf(status)

    // The state is not a credential, but it must still be exposed in exactly
    // one shape — inside the URL the user opens — and nowhere else. A bare
    // 'state' field would be a needless second exposure of a one-time value.
    expect(state).not.toBe('')
    const withoutUrl = { ...status, authUrl: undefined }
    expect(JSON.stringify(withoutUrl)).not.toContain(state)
    expect(Object.keys(status)).not.toContain('state')
  })

  it('carries no token material in a failure status either', async () => {
    const store = memoryStore(null)
    const stub = recordingFetch(() => jsonResponse(
      { error: { type: 'invalid_request_error', message: 'rejected ' + AUTHORIZATION_CODE } },
      400,
    ))
    const flow = await beginLogin(store.store, { mode: 'manual', openBrowser: () => undefined, fetchFn: stub.fn })
    const state = stateOf(flow)

    const result = await submitLoginInput(AUTHORIZATION_CODE + '#' + state)
    expect(result.ok).toBe(false)

    const status = getLoginStatus()
    expect(status.status).toBe('error')
    expect(status.error).toBeTruthy()
    const serialized = JSON.stringify({ ...status, authUrl: undefined })
    expect(serialized).not.toContain(AUTHORIZATION_CODE)
    expect(serialized).not.toContain(state)
    expect(serialized).not.toContain(REFRESH_TOKEN)
  })

  it('writes a credential the sibling store accepts as a subscription credential', async () => {
    const store = memoryStore(null)
    const stub = recordingFetch(() => jsonResponse(
      tokenBody({ account: { uuid: 'uuid-1', email_address: 'user@example.com' } }),
    ))
    const flow = await beginLogin(store.store, { mode: 'manual', openBrowser: () => undefined, fetchFn: stub.fn })
    await expect(submitLoginInput(AUTHORIZATION_CODE + '#' + stateOf(flow))).resolves.toEqual({ ok: true })

    const written = store.current()
    expect(written).not.toBeNull()
    // The interface with token-store.ts, asserted rather than assumed: the
    // scope list it requires is what makes the credential usable at all, and a
    // space-delimited string left in place of the list would parse to zero
    // scopes and have the store refuse the credential this module just wrote.
    expect(written?.scopes).toEqual(['user:inference'])
    expect(isSubscriptionCredential(written ?? { scopes: [] })).toBe(true)
    expect(written?.account).toEqual({ uuid: 'uuid-1', email_address: 'user@example.com' })
    expect(typeof written?.expiresAt).toBe('number')
  })

  it('keeps the scopes a refresh reports nothing about', async () => {
    const store = memoryStore(credentials({ scopes: ['user:inference', 'user:profile'] }))
    const stub = recordingFetch(() => jsonResponse({ access_token: ACCESS_TOKEN, expires_in: 3600 }))
    const refreshed = await ensureAccessToken(store.store, { fetchFn: stub.fn })
    // Dropping the scope list would make the store refuse a credential that is
    // still perfectly good.
    expect(refreshed.scopes).toEqual(['user:inference', 'user:profile'])
    expect(isSubscriptionCredential(refreshed)).toBe(true)
  })

  it('has no field able to hold a credential', async () => {
    const store = memoryStore(null)
    const status = await beginLogin(store.store, { mode: 'manual', openBrowser: () => undefined })
    const keys = Object.keys(status).sort()
    expect(keys).toEqual(['authUrl', 'createdAt', 'flowId', 'hint', 'mode', 'redirectUri', 'status'])
  })
})
