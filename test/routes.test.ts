import http from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ROUTE_PREFIX } from '../src/compat.ts'
import { CodexAccountPool, parseCodexPoolData } from '../src/host/codex-account-pool.ts'
import { OAuthService } from '../src/host/oauth-service.ts'
import { registerRoutes } from '../src/host/routes.ts'
import { MemoryTokenStore } from '../src/host/token-store.ts'
import { UsageService } from '../src/host/usage-service.ts'
import type { SubscriptionPreferenceStore } from '../src/host/preferences.ts'

const servers: http.Server[] = []
const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })))
})

describe('host routes', () => {
  it('returns masked status and rejects cross-origin mutations', async () => {
    const store = new MemoryTokenStore()
    await store.save({
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      expiresAt: Date.now() + 3_600_000,
      accountId: 'account-secret-1234',
      email: 'owner@example.com',
      planType: 'plus',
    })
    const oauth = new OAuthService(store, { logger: { info: () => undefined, warn: () => undefined } })
    const routes: Array<{ kind: string; path: string; handler: http.RequestListener }> = []
    const emit = vi.fn()
    const ctx = {
      emit,
      llm: {
        listProviders: () => [
          { id: 'codex-chatgpt', name: 'Codex' },
          { id: 'deepseek-official', name: 'DeepSeek Official' },
        ],
        listModels: async (provider: string) => provider === 'codex-chatgpt'
          ? [{ provider, id: 'gpt-5.6-sol', name: '5.6 Sol' }]
          : [{ provider, id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
        resolveModelInfo: async (provider: string, model: string) => ({
          provider,
          id: model,
          name: model,
          context: { contextWindow: provider === 'codex-chatgpt' ? 384_000 : 128_000 },
          reasoning: {
            efforts: provider === 'codex-chatgpt' ? [{ id: 'medium', name: 'medium' }] : [{ id: 'high', name: 'high' }],
            defaultEffort: provider === 'codex-chatgpt' ? 'medium' : 'high',
          },
        }),
      },
      webServer: {
        register(route: { kind: string; path: string; handler: http.RequestListener }) {
          routes.push(route)
          return () => undefined
        },
      },
    }
    const usage = new UsageService(oauth, {
      fetchFn: async () => Response.json({
        plan_type: 'plus',
        rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_at: 2_000_000_000 } },
      }),
    })
    // One mutable override map, so a patch that clears a key is observable.
    const overrides: Record<string, number> = {
      'gpt-6-astra': 384_000,
      'gpt-6-sol': 384_000,
      'gpt-6-luna': 384_000,
      'gpt-5.6-sol': 272_000,
      'gpt-5.6-terra': 272_000,
      'gpt-5.6-luna': 272_000,
    }
    const preferences: SubscriptionPreferenceStore = {
      status: () => ({
        quickQuotaVisible: false,
        fastMode: false,
        outputVerbosity: null,
        reasoningSummary: null,
        visibleModelIds: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
        searchProvider: 'dsh',
        contextWindowOverrides: { ...overrides },
        proxyMode: 'auto',
        customProxyUrl: null,
        writable: true,
      }),
      update: async (patch) => {
        if (patch.contextWindowOverrides !== undefined) {
          for (const [model, value] of Object.entries(patch.contextWindowOverrides)) {
            if (value === null) delete overrides[model]
            else overrides[model] = value
          }
        }
        return {
          quickQuotaVisible: patch.quickQuotaVisible ?? false,
          fastMode: patch.fastMode ?? false,
          outputVerbosity: patch.outputVerbosity ?? null,
          reasoningSummary: patch.reasoningSummary !== undefined ? patch.reasoningSummary : null,
          visibleModelIds: patch.visibleModelIds ?? ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
          searchProvider: patch.searchProvider ?? 'dsh',
          contextWindowOverrides: { ...overrides },
          proxyMode: patch.proxyMode !== undefined ? patch.proxyMode : 'auto',
          customProxyUrl: patch.customProxyUrl !== undefined ? patch.customProxyUrl : null,
          writable: true,
        }
      },
      watch: () => () => undefined,
    }
    const fetchConfiguration = { fetchProvider: 'dsh' as const, fetchMaxBodyChars: 150_000, fetchMaxResponseBytes: 4_194_304 }
    registerRoutes(ctx as never, oauth, usage, preferences, undefined, {
      status: () => ({ state: 'applied', configuredSearchProvider: 'deepseek-official', configuredFetchProvider: 'http' }),
    } as never, undefined, undefined, fetchConfiguration)
    const prefix = routes.find((route) => route.kind === 'prefix')!
    const { server, origin } = await serve(prefix.handler)
    servers.push(server)

    const statusResponse = await fetch(`${origin}${ROUTE_PREFIX}/status`)
    const statusText = await statusResponse.text()
    expect(statusResponse.status).toBe(200)
    expect(statusText).toContain('o***@example.com')
    expect(statusText).toContain('…1234')
    expect(JSON.parse(statusText).value).toMatchObject({
      fetchConfiguration,
      switcher: { state: 'applied', configuredFetchProvider: 'http' },
    })
    expect(statusText).not.toContain('access-secret')
    expect(statusText).not.toContain('refresh-secret')
    expect(statusText).not.toContain('account-secret-1234')
    expect(statusText).toContain('"usedPercent":25')
    expect(statusText).toContain('"quickQuotaVisible":false')
    expect(statusText).not.toContain('"allProviders"')

    const mermaidResponse = await fetch(`${origin}${ROUTE_PREFIX}/mermaid.min.js`)
    expect(mermaidResponse.status).toBe(200)
    expect(mermaidResponse.headers.get('content-type')).toContain('application/javascript')
    expect((await mermaidResponse.text()).length).toBeGreaterThan(0)

    const updatedPreferences = await fetch(`${origin}${ROUTE_PREFIX}/preferences/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({
        fastMode: true,
        outputVerbosity: 'high',
        reasoningSummary: 'concise',
        visibleModelIds: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.4-mini'],
        contextWindowOverrides: { 'gpt-6-astra': 872_000, 'gpt-5.6-sol': 1_000_000 },
        proxyMode: 'custom',
        customProxyUrl: 'http://127.0.0.1:8888',
      }),
    })
    expect(updatedPreferences.status).toBe(200)
    expect(await updatedPreferences.json()).toMatchObject({
      ok: true,
      value: {
        fastMode: true,
        outputVerbosity: 'high',
        reasoningSummary: 'concise',
        visibleModelIds: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.4-mini'],
        contextWindowOverrides: { 'gpt-6-astra': 872_000, 'gpt-5.6-sol': 1_000_000 },
        proxyMode: 'custom',
        customProxyUrl: 'http://127.0.0.1:8888',
      },
    })

    expect(emit).toHaveBeenCalledWith('llm/adapters-updated')
    emit.mockClear()
    const unrelatedPreferences = await fetch(`${origin}${ROUTE_PREFIX}/preferences/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ fastMode: false }),
    })
    expect(unrelatedPreferences.status).toBe(200)
    expect(emit).not.toHaveBeenCalled()

    const rejectedReasoningSummary = await fetch(`${origin}${ROUTE_PREFIX}/preferences/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ reasoningSummary: 'super-long' }),
    })
    expect(rejectedReasoningSummary.status).toBe(400)

    // Every catalog model is configurable now, not only the default-visible six.
    emit.mockClear()
    const updatedLegacyModel = await fetch(`${origin}${ROUTE_PREFIX}/preferences/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ contextWindowOverrides: { 'gpt-5.4': 128_000 } }),
    })
    expect(updatedLegacyModel.status).toBe(200)
    expect((await updatedLegacyModel.json()).value.contextWindowOverrides['gpt-5.4']).toBe(128_000)
    // The resolved context window is part of the cached model directory.
    expect(emit).toHaveBeenCalledWith('llm/adapters-updated')

    const rejectedContextModel = await fetch(`${origin}${ROUTE_PREFIX}/preferences/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ contextWindowOverrides: { 'gpt-9-unknown': 128_000 } }),
    })
    expect(rejectedContextModel.status).toBe(400)

    // null clears one override back to the catalog default and leaves the rest.
    emit.mockClear()
    const clearedContext = await fetch(`${origin}${ROUTE_PREFIX}/preferences/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ contextWindowOverrides: { 'gpt-5.4': null } }),
    })
    expect(clearedContext.status).toBe(200)
    const clearedOverrides = (await clearedContext.json()).value.contextWindowOverrides
    expect(clearedOverrides['gpt-5.4']).toBeUndefined()
    expect(clearedOverrides['gpt-6-sol']).toBe(384_000)
    expect(emit).toHaveBeenCalledWith('llm/adapters-updated')

    for (const contextWindow of [0, 1.5, 872_001, 1_000_000]) {
      const rejectedAstraContext = await fetch(`${origin}${ROUTE_PREFIX}/preferences/update`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ contextWindowOverrides: { 'gpt-6-astra': contextWindow } }),
      })
      expect(rejectedAstraContext.status).toBe(400)
    }

    const rejected = await fetch(`${origin}${ROUTE_PREFIX}/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: '{}',
    })
    expect(rejected.status).toBe(403)
    expect(await store.load()).not.toBeNull()

    const accepted = await fetch(`${origin}${ROUTE_PREFIX}/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: '{}',
    })
    expect(accepted.status).toBe(200)
    expect(await store.load()).toBeNull()
    oauth.dispose()
  })
})


// ---------------------------------------------------------------------------
// The adopt and local-login surface
// ---------------------------------------------------------------------------

/** Mirrors the platform backends: JSON on disk, and the parse hook on read. */
class MemoryBackend {
  private data: unknown = null
  constructor(private readonly parse: (value: unknown) => unknown) {}
  async load() { return this.data === null ? null : this.parse(JSON.parse(JSON.stringify(this.data))) }
  async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

/** A JWT-shaped token whose payload this module can actually decode. */
function jwt(claims: Record<string, unknown>): string {
  const segment = (value: object): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  return [segment({ alg: 'RS256', typ: 'JWT' }), segment(claims), 'not-a-signature'].join('.')
}

/** A private directory that is removed after the test. */
async function fixtureDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-routes-adopt-'))
  fixtures.push(directory)
  return directory
}

/** Write a Codex auth.json fixture and answer its path. */
async function codexAuthFile(document: unknown): Promise<string> {
  const file = join(await fixtureDir(), 'auth.json')
  await writeFile(file, typeof document === 'string' ? document : JSON.stringify(document), 'utf8')
  return file
}

/** A document this plugin can adopt, with a far-future access token. */
function adoptableDocument(): Record<string, unknown> {
  return {
    auth_mode: 'chatgpt',
    tokens: {
      id_token: jwt({ email: 'adopted@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } }),
      access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3_600 }),
      refresh_token: 'codex-refresh-token',
      account_id: 'adopted-acct-1',
    },
    last_refresh: '2026-01-01T00:00:00Z',
  }
}

const minimalPreferences: SubscriptionPreferenceStore = {
  status: () => ({
    quickQuotaVisible: false,
    fastMode: false,
    outputVerbosity: null,
    reasoningSummary: null,
    visibleModelIds: ['gpt-5.6-sol'],
    searchProvider: 'dsh',
    contextWindowOverrides: {},
    proxyMode: 'auto',
    customProxyUrl: null,
    writable: true,
  }),
  update: async () => { throw new Error('unused') },
  watch: () => () => undefined,
}

/** Register the route table over a pool and a set of fixture paths. */
async function adoptHarness(options: {
  authPath: string
  claudePaths?: string[],
  minimaxPaths?: string[],
  withPool?: boolean,
}): Promise<{ origin: string; pool: CodexAccountPool; mirror: MemoryTokenStore; dispose: () => void }> {
  const backend = new MemoryBackend(parseCodexPoolData)
  const mirror = new MemoryTokenStore()
  const pool = new CodexAccountPool({ store: mirror, backend: backend as never })
  const oauth = new OAuthService(mirror, { pool, logger: { info: () => undefined, warn: () => undefined } })
  // No upstream is reachable in a test, so the quota read is answered from a
  // fetch that never has to be asked for anything this suite asserts on.
  const usage = new UsageService(oauth, {
    fetchFn: (async () => Response.json({ rate_limit: {} })) as unknown as typeof fetch,
  })
  const routes: Array<{ kind: string; path: string; handler: http.RequestListener }> = []
  const ctx = {
    emit: vi.fn(),
    webServer: {
      register(route: { kind: string; path: string; handler: http.RequestListener }) {
        routes.push(route)
        return () => undefined
      },
    },
  }
  const disposeRoutes = registerRoutes(
    ctx as never, oauth, usage, minimalPreferences, undefined, undefined, undefined,
    options.withPool === false ? undefined : pool, undefined,
    {
      adoptPaths: [options.authPath],
      localLoginPaths: {
        codex: [options.authPath],
        claude: options.claudePaths ?? [join('C:', 'absent', '.credentials.json')],
        minimax: options.minimaxPaths ?? [join('C:', 'absent', 'auth.json')],
      },
    },
  )
  const served = await serve(routes.find((route) => route.kind === 'prefix')!.handler)
  servers.push(served.server)
  return {
    origin: served.origin,
    pool,
    mirror,
    dispose: () => { disposeRoutes(); oauth.dispose() },
  }
}

describe('adopting a local sign-in', () => {
  /** A same-origin JSON POST, which is what every mutating case requires. */
  async function post(
    origin: string,
    route: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(origin + ROUTE_PREFIX + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, ...headers },
      body: JSON.stringify(body),
    })
  }

  it('imports a local Codex CLI sign-in and answers with the refreshed status', async () => {
    const authPath = await codexAuthFile(adoptableDocument())
    const { origin, pool, mirror, dispose } = await adoptHarness({ authPath })
    try {
      const response = await post(origin, '/adopt', { source: 'codex' })
      expect(response.status).toBe(200)
      const value = (await response.json()).value
      // The SAME status shape the /accounts action answers with, so the card can
      // re-render without a second request.
      expect(value).toHaveProperty('authenticated')
      expect(value).toHaveProperty('quota')
      expect(value).toHaveProperty('preferences')

      const accounts = await pool.listAccounts()
      expect(accounts).toHaveLength(1)
      expect(accounts[0]).toMatchObject({
        email: 'adopted@example.com',
        planLabel: 'plus',
        adopted: true,
        source: 'codex',
        removable: false,
        sourcePath: authPath,
      })
      // Borrowed, not owned: the single-credential store still holds nothing, so
      // the pre-pool projection cannot resurrect it as this plugin's sign-in.
      expect(await mirror.load()).toBeNull()
      // No token value crosses the wire back to the browser.
      const text = JSON.stringify(value)
      expect(text).not.toContain('codex-refresh-token')
    } finally {
      dispose()
    }
  })

  it('re-importing the same file updates one row rather than adding another', async () => {
    const authPath = await codexAuthFile(adoptableDocument())
    const { origin, pool, dispose } = await adoptHarness({ authPath })
    try {
      expect((await post(origin, '/adopt', { source: 'codex' })).status).toBe(200)
      const second = await post(origin, '/adopt', { source: 'codex' })
      expect(second.status).toBe(200)
      expect(await pool.listAccounts()).toHaveLength(1)
    } finally {
      dispose()
    }
  })

  it('answers an unrecognised local sign-in without throwing', async () => {
    const cases: unknown[] = [
      '}{ not json at all',
      {},
      { auth_mode: 'chatgpt' },
      { auth_mode: 'apiKey', tokens: { access_token: 'sk-not-a-jwt', refresh_token: 'r' } },
      // A JWT with no usable exp: validity that nothing established.
      { auth_mode: 'chatgpt', tokens: { access_token: 'a.b.c', refresh_token: 'r' } },
    ]
    for (const document of cases) {
      const authPath = await codexAuthFile(document)
      const { origin, pool, dispose } = await adoptHarness({ authPath })
      try {
        const response = await post(origin, '/adopt', { source: 'codex' })
        // A clear refusal, not a 500: this is a user's file, not a bug.
        expect(response.status).toBe(400)
        const body = await response.json()
        expect(body.ok).toBe(false)
        expect(body.error.message).toContain('unrecognised local sign-in format')
        expect(await pool.listAccounts()).toHaveLength(0)
      } finally {
        dispose()
      }
    }
  })

  it('refuses a source this line does not import, and says where that one lives', async () => {
    const authPath = await codexAuthFile(adoptableDocument())
    const { origin, pool, dispose } = await adoptHarness({ authPath })
    try {
      const response = await post(origin, '/adopt', { source: 'claude-code' })
      expect(response.status).toBe(400)
      // The sentence points at the provider that owns the control, rather than
      // inventing a second import path to the same file.
      expect((await response.json()).error.message).toContain('their own provider settings')
      expect(await pool.listAccounts()).toHaveLength(0)
    } finally {
      dispose()
    }
  })

  it('refuses adoption without a pool rather than writing a snapshot somewhere unmanaged', async () => {
    const authPath = await codexAuthFile(adoptableDocument())
    const { origin, dispose } = await adoptHarness({ authPath, withPool: false })
    try {
      const response = await post(origin, '/adopt', { source: 'codex' })
      expect(response.status).toBe(400)
      expect((await response.json()).error.message).toContain('account pool')
    } finally {
      dispose()
    }
  })

  it('requires a same-origin JSON POST, like every other mutation', async () => {
    const authPath = await codexAuthFile(adoptableDocument())
    const { origin, pool, dispose } = await adoptHarness({ authPath })
    try {
      const crossOrigin = await post(origin, '/adopt', { source: 'codex' }, { origin: 'https://evil.example' })
      expect(crossOrigin.status).toBe(403)
      expect(await pool.listAccounts()).toHaveLength(0)

      const noJson = await fetch(origin + ROUTE_PREFIX + '/adopt', {
        method: 'POST',
        headers: { origin, 'content-type': 'text/plain' },
        body: 'source=codex',
      })
      expect(noJson.status).toBe(415)
      expect(await pool.listAccounts()).toHaveLength(0)
    } finally {
      dispose()
    }
  })

  it('adopt/disable removes the adopted rows only, and leaves the Codex CLI file alone', async () => {
    const authPath = await codexAuthFile(adoptableDocument())
    const { origin, pool, mirror, dispose } = await adoptHarness({ authPath })
    try {
      // A managed sign-in and an imported one, side by side.
      await pool.addAccount({
        accessToken: 'managed-access',
        refreshToken: 'managed-refresh',
        expiresAt: Date.now() + 3_600_000,
        accountId: 'managed-acct',
        email: 'managed@example.com',
      })
      expect((await post(origin, '/adopt', { source: 'codex' })).status).toBe(200)
      expect(await pool.listAccounts()).toHaveLength(2)

      const response = await post(origin, '/adopt/disable', {})
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('application/json')
      // The refreshed status again, so the card re-renders from one answer.
      expect((await response.json()).value).toHaveProperty('quota')

      const remaining = await pool.listAccounts()
      expect(remaining).toHaveLength(1)
      // The managed sign-in is untouched, in the pool and in the mirror.
      expect(remaining[0]).toMatchObject({ email: 'managed@example.com', adopted: false, removable: true })
      expect((await mirror.load())?.accessToken).toBe('managed-access')
    } finally {
      dispose()
    }
  })

  it('adopt/disable is harmless when nothing was ever imported', async () => {
    const authPath = await codexAuthFile(adoptableDocument())
    const { origin, dispose } = await adoptHarness({ authPath })
    try {
      const response = await post(origin, '/adopt/disable', {})
      expect(response.status).toBe(200)
    } finally {
      dispose()
    }
  })

  it('reports presence in the status without reading the credential', async () => {
    const authPath = await codexAuthFile(adoptableDocument())
    const { origin, dispose } = await adoptHarness({ authPath })
    try {
      const present = await (await fetch(origin + ROUTE_PREFIX + '/status')).json()
      expect(present.value.codexCliSignInAvailable).toBe(true)
    } finally {
      dispose()
    }

    const absent = await codexAuthFile(adoptableDocument())
    const missing = join(await fixtureDir(), 'nope.json')
    const { origin: absentOrigin, dispose: disposeAbsent } = await adoptHarness({ authPath: missing })
    try {
      const status = await (await fetch(absentOrigin + ROUTE_PREFIX + '/status')).json()
      // Presence is a stat: an absent file is false, not an error, and the whole
      // status call still answers.
      expect(status.value.codexCliSignInAvailable).toBe(false)
      expect(absent).toBeDefined()
    } finally {
      disposeAbsent()
    }
  })
})

describe('the local login scanner', () => {
  it('reports every provider in a uniform shape, presence only', async () => {
    const codexPath = await codexAuthFile(adoptableDocument())
    const claudePath = join(await fixtureDir(), '.credentials.json')
    const minimaxPath = join(await fixtureDir(), 'auth.json')
    await writeFile(claudePath, JSON.stringify({ claudeAiOauth: {} }), 'utf8')
    await writeFile(minimaxPath, JSON.stringify({ records: {} }), 'utf8')

    const { origin, dispose } = await adoptHarness({
      authPath: codexPath, claudePaths: [claudePath], minimaxPaths: [minimaxPath],
    })
    try {
      const response = await fetch(origin + ROUTE_PREFIX + '/local-logins')
      expect(response.status).toBe(200)
      // The same envelope every route here uses.
      const { sources } = (await response.json()).value as { sources: Array<Record<string, unknown>> }

      expect(sources.map((source) => source.id)).toEqual(['codex', 'claude-code', 'minimax-code'])
      expect(sources.every((source) => source.detected === true)).toBe(true)
      // One row, one rule: the Codex row is importable here; the other two
      // providers already own their own control, so the honest answer is to point
      // the user at it rather than invent a second import path.
      expect(sources[0]).toMatchObject({ id: 'codex', importMode: 'adopt', providerLabel: 'Codex CLI' })
      expect(sources[1]).toMatchObject({ id: 'claude-code', importMode: 'settings-only', providerLabel: 'Claude Code' })
      expect(sources[2]).toMatchObject({ id: 'minimax-code', importMode: 'settings-only', providerLabel: 'MiniMax Code' })
      // Every row names the exact candidates it stat'ed, in priority order.
      expect(sources[0]!.paths).toEqual([codexPath])
      expect(sources[1]!.paths).toEqual([claudePath])
      expect(sources[2]!.paths).toEqual([minimaxPath])
      // No token value is in the answer, which is what 'presence only' means.
      const text = JSON.stringify(sources)
      expect(text).not.toContain('codex-refresh-token')
    } finally {
      dispose()
    }
  })

  it('reports an absent sign-in as detected: false rather than failing', async () => {
    const missingCodex = join(await fixtureDir(), 'absent.json')
    const { origin, dispose } = await adoptHarness({ authPath: missingCodex })
    try {
      const envelope = (await (await fetch(origin + ROUTE_PREFIX + '/local-logins')).json()) as { value: { sources: Array<{ id: string; detected: boolean; paths: string[] }> } }
      const { sources } = envelope.value
      expect(sources.every((source) => source.detected === false)).toBe(true)
      // The path is still reported, so 'not found' is distinguishable from
      // 'your client stores it somewhere else'.
      expect(sources[0]!.paths).toEqual([missingCodex])
    } finally {
      dispose()
    }
  })
})
async function serve(handler: http.RequestListener): Promise<{ server: http.Server; origin: string }> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server has no TCP address')
  return { server, origin: `http://127.0.0.1:${address.port}` }
}
