/**
 * Tests for the '/claude/api' settings surface.
 *
 * WHAT THIS FILE PROVES, and why each one is here rather than assumed:
 *
 * 1. NOTHING GATES THE ROUTES. Every mutating route works with no prior state at
 *    all — no acknowledgement, no stored preference, an untouched settings file
 *    — and the assertion is the POSITIVE one (a sign-in actually starts, the
 *    settings actually persist), because "no 403" alone would also be true of a
 *    route that was simply broken. See 'no route is gated' below.
 * 2. THE STATUS ROUTE SPENDS THE CREDENTIAL. It polls the account's usage with
 *    nothing acknowledged, which is the read a gate used to suppress.
 * 3. 'adopt' IS THE ONLY ROUTE THAT READS the local Claude Code credential file.
 *    A spy on 'node:fs/promises'.readFile matches on the path, and the fixture is
 *    a real file on disk, so the status route's stat-not-read property is
 *    observable rather than asserted in prose.
 * 4. A CROSS-ORIGIN POST IS REJECTED — on every mutating route, with the
 *    'Cross-origin request rejected.' body the sibling lines use.
 * 5. The envelope matches the sibling lines: '{ok,value}' / '{ok,error}', 405 for
 *    a wrong method, 404 for an unknown path, and a failure reported as
 *    'quotaError' rather than as a failed request.
 *
 * WHAT THIS FILE DOES NOT PROVE. Nothing here reaches Anthropic, Claude Code, or
 * a browser: the fetch seam is a double, the sign-in flow is started with
 * injected 'openBrowser' and no loopback probing, and the adopted credential is a
 * fixture this test wrote. A real sign-in is exercised by
 * 'test/claude-oauth.test.ts' against its own fixtures; this file is about the
 * HTTP surface.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import {
  ROUTE_PREFIX,
  claudeReasoningEffortDrift,
  registerClaudeRoutes,
} from '../src/host/claude/routes.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  type ClaudeCredentials,
} from '../src/host/claude/token-store.ts'
import { ClaudeAccountPool } from '../src/host/claude/account-pool.ts'
import { clearCachedCatalog, clearCachedQuota } from '../src/host/claude/client.ts'
import { getLoginStatus } from '../src/host/claude/oauth.ts'
import { CLAUDE_CONFIG_DIR_ENV, CLAUDE_CODE_CREDENTIAL_KEY } from '../src/host/claude/adopt.ts'
import { CLAUDE_REASONING_EFFORTS, type ClaudeWebStatus } from '../src/shared/claude-contracts.ts'

/** Every adoption read goes through this spy, so "was it read" is observable. */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})
const fsModule = await import('node:fs/promises')
const readFileSpy = vi.mocked(fsModule.readFile)

/**
 * Mirrors the platform backends: JSON in memory, parse hook on read.
 *
 * {@link snapshot} is exposed so a test can assert that stored bytes SURVIVED an
 * operation. Reading the file back is not available here — the real platform
 * backends are DPAPI/Keychain/Secret Service and this double replaces them — so
 * the honest equivalent is to read the ciphertext-side of the seam, which is
 * exactly what 'clear()' would have destroyed.
 */
class MemoryBackend {
  private data: unknown = null
  async load() { return this.data === null ? null : JSON.parse(JSON.stringify(this.data)) }
  async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
  /** The stored document, serialized. Null when nothing is stored. */
  snapshot(): string | null { return this.data === null ? null : JSON.stringify(this.data) }
}

const SUBSCRIPTION_SCOPES = ['user:inference', 'user:profile']

function tmpFile(name: string): string {
  return path.join(os.tmpdir(), name + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json')
}

/** A credential that would pass the store's strict subscription check. */
function credential(overrides: Partial<ClaudeCredentials> = {}): ClaudeCredentials {
  return {
    accessToken: 'access-token-value',
    refreshToken: 'refresh-token-value',
    expiresAt: Date.now() + 3_600_000,
    scopes: [...SUBSCRIPTION_SCOPES],
    subscriptionType: 'max',
    account: { uuid: 'uuid-1', email_address: 'user@example.com' },
    ...overrides,
  }
}

/**
 * The live listing.
 *
 * It names every id the tests assert on, because 'client.ts' deliberately
 * NARROWS the catalog to whatever the server lists — an id the account did not
 * report is not offered. A fixture that named only one model would make the
 * capability assertions below fail for a reason that has nothing to do with
 * capabilities.
 *
 * The windows here are deliberately different from the shipped table's, so the
 * "listing wins on the window and on nothing else" rule is observable.
 */
const CATALOG = {
  data: [
    { id: 'claude-opus-4-6', context_window: 1_000_000 },
    { id: 'claude-opus-4-7', context_window: 1_000_000 },
    { id: 'claude-opus-5', context_window: 1_000_000 },
    { id: 'claude-haiku-4-5', context_window: 200_000 },
  ],
}
const USAGE = { five_hour: { utilization: 25, resets_at: '2026-09-11T18:00:00Z' } }

interface Captured {
  status: number
  body: { ok: boolean; value?: Record<string, unknown>; error?: string }
}

function fakeExchange(): { response: ServerResponse; captured: Captured } {
  const captured = { status: 0, body: { ok: false } as Captured['body'] }
  const response = {
    writeHead(status: number) { captured.status = status; return response },
    end(raw?: string) { captured.body = raw === undefined ? captured.body : JSON.parse(raw) as Captured['body'] },
  } as unknown as ServerResponse
  return { response, captured }
}

/**
 * A request whose body is REPLAYED to whatever attaches a listener.
 *
 * The replay is not a convenience — a naive 'emit on the next microtask' harness
 * deadlocks against this route surface, and the reason is worth recording so it
 * is not "fixed" back: several handlers await the settings store or the account
 * pool BEFORE calling readRequestJson, so their body listeners are attached after
 * any microtask scheduled at request-construction time has already fired. The
 * emission would then reach nobody, 'end' would never fire, and readRequestJson's
 * promise would never settle — a hang, not a failure.
 *
 * Replaying from a buffer makes attachment order irrelevant: a listener that
 * arrives late still receives every chunk and the terminal 'end'.
 */
function fakeRequest(input: {
  url: string
  method?: string
  body?: unknown
  origin?: string | null
}): IncomingMessage {
  const listeners = new Map<string, Array<(value?: unknown) => void>>()
  const headers: Record<string, string> = { host: '127.0.0.1:3000' }
  const origin = input.origin === undefined ? 'http://127.0.0.1:3000' : input.origin
  if (origin !== null) headers.origin = origin

  const hasBody = input.method === 'POST' || input.method === 'PATCH'
  const chunks: Buffer[] = hasBody && input.body !== undefined
    ? [Buffer.from(JSON.stringify(input.body))]
    : []
  let ended = hasBody

  const deliver = (event: string, listener: (value?: unknown) => void): void => {
    if (!ended) return
    if (event === 'data') {
      for (const chunk of chunks) listener(chunk)
      return
    }
    if (event === 'end') listener()
  }

  const request = {
    url: input.url,
    method: input.method ?? 'GET',
    headers,
    on(event: string, listener: (value?: unknown) => void) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      deliver(event, listener)
      return request
    },
    destroy() {},
  } as unknown as IncomingMessage
  return request
}

describe('Claude settings routes', () => {
  let store: FileCredentialStore
  let modelSettings: FileModelSettingsStore
  let pool: ClaudeAccountPool
  let handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  let credentialFile: string
  let configDir: string
  let claudeCodeFile: string
  const savedConfigDir = process.env[CLAUDE_CONFIG_DIR_ENV]

  const setup = async (options: { adoptPaths?: string[]; poolBackend?: MemoryBackend } = {}) => {
    delete process.env[CLAUDE_CONFIG_DIR_ENV]
    configDir = path.join(os.tmpdir(), 'claude-adopt-' + Date.now() + '-' + Math.random().toString(36).slice(2))
    await fs.mkdir(configDir, { recursive: true })
    claudeCodeFile = path.join(configDir, '.credentials.json')
    credentialFile = tmpFile('claude-doc')
    store = new FileCredentialStore(credentialFile, new MemoryBackend() as never)
    modelSettings = new FileModelSettingsStore(tmpFile('claude-models'))
    pool = new ClaudeAccountPool({ store, backend: (options.poolBackend ?? new MemoryBackend()) as never })
    const routes: Array<{ path: string; handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }> = []
    const ctx = {
      webServer: {
        register(route: { path: string; handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }) {
          routes.push(route)
          return () => undefined
        },
      },
      emit: () => undefined,
    } as unknown as Context
    registerClaudeRoutes(ctx, store, modelSettings, undefined, {
      fetchFn: fetchImpl as unknown as typeof fetch,
      accountPool: pool,
      adoptPaths: options.adoptPaths ?? [claudeCodeFile],
      // No browser, no loopback port, no real user: the flow is started and
      // polled entirely in-process.
      login: { openBrowser: () => undefined },
    })
    handler = routes[0]!.handler
  }

  const fetchImpl = async (url: string | URL): Promise<Response> => {
    const target = String(url)
    if (target.includes('/v1/models')) return Response.json(CATALOG)
    if (target.includes('/api/oauth/usage')) return Response.json(USAGE)
    return Response.json({ stop_reason: 'end_turn' })
  }

  const call = async (
    endpoint: string,
    method = 'GET',
    body?: unknown,
    origin?: string | null,
  ): Promise<Captured> => {
    const { response, captured } = fakeExchange()
    await handler(fakeRequest({ url: ROUTE_PREFIX + endpoint, method, ...(body === undefined ? {} : { body }), ...(origin === undefined ? {} : { origin }) }), response)
    return captured
  }

  beforeEach(() => {
    clearCachedQuota()
    clearCachedCatalog()
  })

  afterEach(async () => {
    clearCachedQuota()
    clearCachedCatalog()
    vi.restoreAllMocks()
    if (savedConfigDir === undefined) delete process.env[CLAUDE_CONFIG_DIR_ENV]
    else process.env[CLAUDE_CONFIG_DIR_ENV] = savedConfigDir
    await fs.rm(configDir, { recursive: true, force: true }).catch(() => undefined)
  })

  // -------------------------------------------------------------------------
  // 1. Nothing is gated
  // -------------------------------------------------------------------------

  describe('no route is gated', () => {
    /**
     * The settings document, as the store holds it on a machine where nobody has
     * ever touched this line, is the entire pre-state of every assertion here:
     * 'setup()' writes no settings at all.
     */
    it('starts a sign-in flow with no prior state of any kind', async () => {
      await setup()
      const result = await call('/login', 'POST', {})
      expect(result.status).toBe(200)
      expect(result.body.ok).toBe(true)
      // The POSITIVE half, which is what makes this about the absence of a gate
      // rather than about a route that answers 200 and does nothing: a flow is
      // genuinely armed afterwards.
      expect(getLoginStatus().status).toBe('pending')
      expect(getLoginStatus().flowId).toBeDefined()
      expect((result.body.value as unknown as { status: string }).status).toBe('pending')
    })

    it('spends the credential on the status route with nothing acknowledged', async () => {
      // The route's fetch seam is bound at registration, so the outbound calls
      // are counted by registering a route whose seam records them. This is the
      // assertion that matters: "the credential is spent" is a statement about
      // requests to Anthropic, and a card-side flag cannot make it true.
      const calls: string[] = []
      const counting = async (url: string | URL): Promise<Response> => {
        calls.push(String(url))
        return fetchImpl(url)
      }
      const routes: Array<{ handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }> = []
      const ctx = {
        webServer: { register(route: { handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }) { routes.push(route); return () => undefined } },
        emit: () => undefined,
      } as unknown as Context
      registerClaudeRoutes(ctx, store, modelSettings, undefined, {
        fetchFn: counting as unknown as typeof fetch,
        accountPool: pool,
        login: { openBrowser: () => undefined },
      })
      await pool.addAccount(credential())
      clearCachedQuota()
      const { response, captured } = fakeExchange()
      await routes[0]!.handler(fakeRequest({ url: ROUTE_PREFIX + '/status' }), response)
      expect(captured.status).toBe(200)
      expect(calls.filter((url) => url.includes('/api/oauth/usage')).length).toBeGreaterThan(0)
      expect(captured.body.value!.quota).not.toBeNull()
    })

    it('answers EVERY credential-spending route without an acknowledgement', async () => {
      // Previously each of these returned 403 before doing any work. The
      // assertion is that they now reach their handler and answer on their own
      // merits — the route's own "not signed in" refusal, or a plain status
      // refresh — and never the gate's 403.
      await setup()
      const quota = await call('/quota', 'POST', {})
      expect(quota.status).toBe(400)
      expect(quota.body).toEqual({ ok: false, error: 'Not signed in to Claude.' })
      const probe = await call('/connection/test', 'POST', {})
      expect(probe.status).toBe(400)
      expect(probe.body).toEqual({ ok: false, error: 'Not signed in.' })
      // A catalog refresh has nothing to refuse: with no credential it still
      // answers the refreshed status, which is the route's own contract.
      const catalog = await call('/catalog/refresh', 'POST', {})
      expect(catalog.status).toBe(200)
      expect(catalog.body.ok).toBe(true)

      const settings = await call('/settings', 'POST', { enabled: false })
      expect(settings.status).toBe(200)
      expect((await modelSettings.read()).enabled).toBe(false)
    })

    it('un-gates a real settings POST end to end, with no acknowledgement on file', async () => {
      // THE PIN. This route used to be behind the gate; the patch has to reach
      // the store and be reported back, not merely avoid a 403. 'setup()' writes
      // no settings of its own, so the document asserted below is written
      // entirely by this request.
      await setup()
      const result = await call('/settings', 'POST', {
        enabledModelIds: ['claude-opus-4-6'],
        contextWindowOverrides: { 'claude-opus-4-6': 123_456 },
        defaultReasoningEffort: 'high',
      })

      expect(result.status).toBe(200)
      const value = result.body.value as unknown as ClaudeWebStatus
      expect(value.contextWindowOverrides['claude-opus-4-6']).toBe(123_456)
      expect(value.defaultReasoningEffort).toBe('high')
      // Persisted, not just echoed: the store on disk holds it.
      const stored = await modelSettings.read()
      expect(stored.contextWindowOverrides).toEqual({ 'claude-opus-4-6': 123_456 })
      expect(stored.defaultReasoningEffort).toBe('high')
      // And the settings document states no acceptance field of any kind.
      const raw = JSON.parse(await fs.readFile(modelSettings.path(), 'utf8')) as Record<string, unknown>
      expect(Object.keys(raw).sort()).toEqual([
        'contextWindowOverrides', 'defaultReasoningEffort', 'enabled', 'enabledModelIds', 'selectedAccountId',
      ])
    })

    it('serves every pool action with no acknowledgement', async () => {
      await setup()
      for (const action of ['set-primary', 'set-alias', 'delete', 'clear-cooldown', 'clear-auth-failed', 'strategy']) {
        const result = await call('/accounts', 'POST', { action, accountId: 'cl_00000000000000000000' })
        // Reaches the pool: the unknown id is refused by the POOL, and the gate's
        // blanket 403 is gone.
        expect(result.status, 'action ' + action).toBeLessThan(500)
        expect(result.body.error, 'action ' + action).not.toBe('Cross-origin request rejected.')
      }
    })
  })

  // -------------------------------------------------------------------------
  // 3. The envelope, the origin check, and the methods
  // -------------------------------------------------------------------------

  describe('the envelope and the origin check', () => {
    it('rejects a cross-origin POST with the shared message and 403', async () => {
      await setup()
      for (const [endpoint, body] of [
        ['/login', {}],
        ['/login/cancel', {}],
        ['/login/input', { input: 'x' }],
        ['/accounts', { action: 'set-primary', accountId: 'cl_1' }],
        ['/adopt', {}],
        ['/adopt/disable', {}],
        ['/quota', {}],
        ['/connection/test', {}],
        ['/catalog/refresh', {}],
        ['/settings', {}],
        ['/logout', {}],
      ] as const) {
        const result = await call(endpoint, 'POST', body, 'http://evil.example')
        expect(result.status, endpoint).toBe(403)
        expect(result.body, endpoint).toEqual({ ok: false, error: 'Cross-origin request rejected.' })
      }
    })

    it('rejects the origin check on EVERY method a mutating route takes', async () => {
      // The surface has no PATCH route left, so the check is pinned on the two
      // methods that can still carry a mutation: an ordinary POST, and a GET to
      // a route that also accepts POST ('/quota' takes both, and the GET half is
      // a read that a cross-origin caller must not perform either).
      await setup()
      const post = await call('/settings', 'POST', { enabled: false }, 'http://evil.example')
      expect(post.status).toBe(403)
      expect(post.body.error).toBe('Cross-origin request rejected.')
      // The refused patch was not applied.
      expect((await modelSettings.read()).enabled).toBe(true)
    })

    it('answers 405 for a method the route does not take', async () => {
      await setup()
      expect((await call('/status', 'POST', {})).status).toBe(405)
      expect((await call('/login')).status).toBe(405)
      expect((await call('/quota', 'DELETE')).status).toBe(405)
      expect((await call('/settings', 'PATCH', {})).status).toBe(405)
    })

    it('answers 404 for an unknown path, with the shared body', async () => {
      await setup()
      const result = await call('/nope')
      expect(result.status).toBe(404)
      expect(result.body).toEqual({ ok: false, error: 'not-found' })
    })

    it('reports a failed quota read as quotaError rather than as a failed request', async () => {
      await setup()
      await store.saveAccount(credential())
      const failing = async (url: string | URL): Promise<Response> => {
        if (String(url).includes('/api/oauth/usage')) return new Response('{"error":{"type":"api_error","message":"boom"}}', { status: 500 })
        return Response.json(CATALOG)
      }
      const routes: Array<{ handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }> = []
      const ctx = {
        webServer: { register(route: { handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }) { routes.push(route); return () => undefined } },
        emit: () => undefined,
      } as unknown as Context
      registerClaudeRoutes(ctx, store, modelSettings, undefined, {
        fetchFn: failing as unknown as typeof fetch,
        accountPool: pool,
        login: { openBrowser: () => undefined },
      })
      const { response, captured } = fakeExchange()
      await routes[0]!.handler(fakeRequest({ url: ROUTE_PREFIX + '/quota', method: 'POST', body: {} }), response)
      expect(captured.status).toBe(200)
      expect(captured.body.ok).toBe(true)
      const value = captured.body.value as unknown as ClaudeWebStatus
      expect(typeof value.quotaError).toBe('string')
      expect(value.quotaError!.length).toBeGreaterThan(0)
      // The account can still be rendered: a missing meter must not take the
      // signed-in row down with it.
      expect(value.account).toMatchObject({ email: 'user@example.com' })
      expect(value.hasCredentials).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // 4. Settings, models and adoption
  // -------------------------------------------------------------------------

  describe('settings and models', () => {
    it('keeps the shared reasoning ladder identical to the catalog\'s, both directions', () => {
      // The shared constant lives in a module the CLIENT project compiles and
      // that module cannot read 'src/host/**', so the equivalence cannot be a
      // type-level derivation. 'routes.ts' asserts it at import time against the
      // real table and exposes the difference, which is what this checks — an
      // asymmetric assertion would pass while the card silently omitted a level
      // the wire accepts, or offered one it rejects.
      expect(claudeReasoningEffortDrift()).toEqual({ missing: [], extra: [] })
      expect([...CLAUDE_REASONING_EFFORTS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    })

    it('persists the settings patch and preserves a null override through normalization', async () => {
      await setup()
      await store.saveAccount(credential())

      const first = await call('/settings', 'POST', {
        enabled: true,
        enabledModelIds: ['claude-opus-4-6'],
        contextWindowOverrides: { 'claude-opus-4-6': 123_456 },
        defaultReasoningEffort: 'high',
      })
      expect(first.status).toBe(200)
      let value = first.body.value as unknown as ClaudeWebStatus
      expect(value.contextWindowOverrides['claude-opus-4-6']).toBe(123_456)
      expect(value.defaultReasoningEffort).toBe('high')

      // 'null' is the card's restore button: it has to DELETE the key rather
      // than store a null that the parser would then drop as invalid.
      const restored = await call('/settings', 'POST', {
        contextWindowOverrides: { 'claude-opus-4-6': null },
      })
      value = restored.body.value as unknown as ClaudeWebStatus
      expect('claude-opus-4-6' in value.contextWindowOverrides).toBe(false)
      expect((await modelSettings.read()).contextWindowOverrides).toEqual({})
    })

    it('refuses a reasoning level no model accepts', async () => {
      await setup()
      await store.saveAccount(credential())
      await call('/settings', 'POST', { defaultReasoningEffort: 'ultra' })
      // Refused quietly rather than persisted: the patch is not applied at all,
      // which is what keeps an unnameable level off the wire.
      expect((await modelSettings.read()).defaultReasoningEffort).toBeNull()
    })

    it('clears the default effort with an explicit null', async () => {
      await setup()
      await store.saveAccount(credential())
      await call('/settings', 'POST', { defaultReasoningEffort: 'max' })
      expect((await modelSettings.read()).defaultReasoningEffort).toBe('max')
      await call('/settings', 'POST', { defaultReasoningEffort: null })
      expect((await modelSettings.read()).defaultReasoningEffort).toBeNull()
    })

    it('rejects a non-string, non-null selected account id', async () => {
      await setup()
      const result = await call('/settings', 'POST', { selectedAccountId: 4 })
      expect(result.status).toBe(400)
      expect(result.body.ok).toBe(false)
    })

    it('reports the models with their ladders, thinking form and capabilities', async () => {
      await setup()
      await store.saveAccount(credential())
      const value = (await call('/status')).body.value as unknown as ClaudeWebStatus
      const opus46 = value.models.find((model) => model.id === 'claude-opus-4-6')
      expect(opus46).toBeDefined()
      expect(opus46!.canDisableThinking).toBe(true)
      expect(opus46!.thinkingMode).toBe('adaptive')
      expect(opus46!.supportsImage).toBe(true)
      expect(opus46!.reasoningEfforts).toEqual(['low', 'medium', 'high', 'max'])
      // A model whose catalog entry maps 'off: null' must report both facts,
      // and they must disagree with the naive derivation from the ladder.
      const opus5 = value.models.find((model) => model.id === 'claude-opus-5')
      expect(opus5!.reasoningEfforts.length).toBeGreaterThan(0)
      expect(opus5!.canDisableThinking).toBe(false)
      // And the temperature capability, which three catalog rows deny.
      const opus47 = value.models.find((model) => model.id === 'claude-opus-4-7')
      expect(opus47!.supportsTemperature).toBe(false)
      expect(opus46!.supportsTemperature).toBe(true)
    })
  })

  describe('adoption', () => {
    it('imports a local Claude Code sign-in with nothing acknowledged, without touching the file', async () => {
      await setup()
      const document = {
        [CLAUDE_CODE_CREDENTIAL_KEY]: {
          accessToken: 'adopted-access',
          refreshToken: 'adopted-refresh',
          expiresAt: Date.now() + 3_600_000,
        },
      }
      await fs.writeFile(claudeCodeFile, JSON.stringify(document), 'utf8')
      const before = await fs.readFile(claudeCodeFile, 'utf8')
      const mtimeBefore = (await fs.stat(claudeCodeFile)).mtimeMs

      const result = await call('/adopt', 'POST', {})
      expect(result.status).toBe(200)
      const accounts = await pool.listAccounts()
      expect(accounts.length).toBe(1)
      expect(accounts[0]).toMatchObject({ adopted: true, source: 'claude-code', sourcePath: claudeCodeFile })

      // Rule 1 of 'adopt.ts': this plugin never writes Claude Code's file.
      expect(await fs.readFile(claudeCodeFile, 'utf8')).toBe(before)
      expect((await fs.stat(claudeCodeFile)).mtimeMs).toBe(mtimeBefore)
      expect(await fs.readdir(configDir)).toEqual(['.credentials.json'])
    })

    it('removes an imported snapshot without touching Claude Code\'s file', async () => {
      await setup()
      await fs.writeFile(claudeCodeFile, JSON.stringify({
        [CLAUDE_CODE_CREDENTIAL_KEY]: {
          accessToken: 'adopted-access',
          refreshToken: 'adopted-refresh',
          expiresAt: Date.now() + 3_600_000,
        },
      }), 'utf8')
      await call('/adopt', 'POST', {})
      const before = await fs.readFile(claudeCodeFile, 'utf8')

      const result = await call('/adopt/disable', 'POST', {})
      expect(result.status).toBe(200)
      expect(await pool.listAccounts()).toEqual([])
      // The snapshot is forgotten; the file it came from is not.
      expect(await fs.readFile(claudeCodeFile, 'utf8')).toBe(before)
      expect(await fs.readdir(configDir)).toEqual(['.credentials.json'])
    })

    it('reports a local sign-in as available WITHOUT reading it', async () => {
      await setup()
      await fs.writeFile(claudeCodeFile, 'not even json', 'utf8')
      readFileSpy.mockClear()
      const value = (await call('/status')).body.value as unknown as ClaudeWebStatus
      expect(value.claudeCodeSignInAvailable).toBe(true)
      expect(value.claudeCodePaths).toContain(claudeCodeFile)
      const readPaths = readFileSpy.mock.calls.map((call) => String(call[0]))
      expect(readPaths.filter((p) => p.includes('.credentials.json'))).toEqual([])
    })

    it('reports an unrecognised local sign-in as a refusal, not a throw', async () => {
      await setup()
      await fs.writeFile(claudeCodeFile, JSON.stringify({ mcpOAuth: { accessToken: 'mcp-token' } }), 'utf8')
      const result = await call('/adopt', 'POST', {})
      expect(result.status).toBe(400)
      expect(result.body.ok).toBe(false)
      // The MCP token must NOT have been adopted as a subscription credential.
      expect(await pool.listAccounts()).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // 5. Pure helpers
  // -------------------------------------------------------------------------

})
