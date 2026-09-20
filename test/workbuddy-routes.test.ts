import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  billingMeters,
  clearCachedCatalog,
  clearCachedQuota,
  fetchAccountQuota,
  parseBilling,
  parseConfigModels,
  loadConfigCatalog,
  parseCycleTime,
  refreshCredentials,
  workBuddyHeaders,
} from '../src/host/workbuddy/client.ts'
import {
  buildModelOptions,
  getWorkBuddyWebStatus,
  registerWorkBuddyRoutes,
  resolveEnabledModelIds,
} from '../src/host/workbuddy/routes.ts'
import type { WorkBuddyCredentials } from '../src/host/workbuddy/token-store.ts'
import { FileCredentialStore, FileModelSettingsStore } from '../src/host/workbuddy/token-store.ts'
import { DEFAULT_VISIBLE_MODEL_IDS, FALLBACK_MODELS } from '../src/host/workbuddy/model-catalog.ts'
import type { WorkBuddyModelEntry } from '../src/host/workbuddy/model-catalog.ts'

const temporaryDirs: string[] = []

async function makeAuthDir(options: { domain?: string; expiresAt?: number } = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-routes-'))
  temporaryDirs.push(dir)
  await fs.writeFile(path.join(dir, 'workbuddy-desktop.info'), JSON.stringify({
    account: { uid: 'uid-1', nickname: 'tester', uin: '100000000001', type: 'personal' },
    auth: {
      accessToken: 'token-abc',
      refreshToken: 'refresh-abc',
      expiresAt: options.expiresAt ?? Date.now() + 3_600_000,
      domain: options.domain ?? 'copilot.tencent.com',
    },
  }), 'utf8')
  return dir
}

async function makeSettings(): Promise<FileModelSettingsStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-set-'))
  temporaryDirs.push(dir)
  return new FileModelSettingsStore(path.join(dir, 'models.json'))
}

afterEach(async () => {
  clearCachedQuota()
  clearCachedCatalog()
  vi.restoreAllMocks()
  for (const dir of temporaryDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

/** A /v3/config payload shaped exactly like the live gateway's. */
const CONFIG = {
  code: 0,
  data: {
    models: [
      {
        id: 'glm-5.3',
        name: 'GLM-5.3',
        maxAllowedSize: 1_000_000,
        maxInputTokens: 1_000_000,
        maxOutputTokens: 48_000,
        supportsImages: true,
        supportsReasoning: true,
        reasoning: { canDisableThinking: true, defaultEffort: 'high', supportedEfforts: ['low', 'high', 'max'] },
        descriptionZh: '能力均衡，适合日常使用',
      },
      {
        id: 'deepseek-v4.1-flash',
        name: 'Deepseek-V4.1-Flash',
        maxAllowedSize: 1_000_000,
        maxOutputTokens: 128_000,
        supportsImages: true,
        supportsReasoning: true,
        contextWindow: { defaultLength: 300_000, supportedLengths: [300_000, 1_000_000] },
        reasoning: { effort: 'high' },
      },
      {
        id: 'kimi-k2-thinking',
        name: 'Kimi-K2-Thinking',
        maxAllowedSize: 164_000,
        maxOutputTokens: 32_000,
        supportsImages: false,
        supportsReasoning: true,
        reasoning: { effort: 'high' },
      },
      // Image-generation tools carry no chat capabilities and must be skipped.
      { id: 'hunyuan-image-alpha', name: 'Hunyuan Image Alpha', tags: ['text-to-image'] },
    ],
  },
}

describe('WorkBuddy config catalog parsing', () => {
  it('reads the gateway fields without inferring anything from the model name', () => {
    const models = parseConfigModels(CONFIG, 'cn')
    const glm = models.find((m) => m.id === 'glm-5.3')!
    expect(glm.contextWindow).toBe(1_000_000)
    expect(glm.maxTokens).toBe(48_000)
    expect(glm.supportsImage).toBe(true)
    expect(glm.reasoningEfforts).toEqual(['low', 'high', 'max'])
    expect(glm.defaultReasoningEffort).toBe('high')
    expect(glm.canDisableThinking).toBe(true)
    expect(glm.regions).toEqual(['cn'])
  })

  it('uses the served default length rather than the model maximum', () => {
    const models = parseConfigModels(CONFIG, 'cn')
    const deepseek = models.find((m) => m.id === 'deepseek-v4.1-flash')!
    // The gateway serves 300K by default while allowing 1M; DSH must size its
    // overflow decisions against what the backend actually serves.
    expect(deepseek.contextWindow).toBe(300_000)
    expect(deepseek.maxContextWindow).toBe(1_000_000)
  })

  it('treats a lone `effort` field as a DEFAULT, not as the whole ladder', () => {
    // Regression: `{ effort: 'high' }` used to become a one-entry ladder, so a
    // caller's explicit `low` was rejected as unsupported and silently replaced
    // by the default. Measured on `deepseek-v4.1-flash`, which reports exactly
    // that shape, every level from `minimal` to `max` is accepted.
    const models = parseConfigModels(CONFIG, 'cn')
    const deepseek = models.find((m) => m.id === 'deepseek-v4.1-flash')!
    expect(deepseek.reasoningEfforts).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(deepseek.defaultReasoningEffort).toBe('high')
    // The same shape on a text-only model behaves identically.
    const kimi = models.find((m) => m.id === 'kimi-k2-thinking')!
    expect(kimi.defaultReasoningEffort).toBe('high')
    expect(kimi.supportsImage).toBe(false)
  })

  it('keeps a declared ladder exactly as the gateway states it', () => {
    const models = parseConfigModels(CONFIG, 'cn')
    const glm = models.find((m) => m.id === 'glm-5.3')!
    // A `supportedEfforts` list is authoritative and must not be widened.
    expect(glm.reasoningEfforts).toEqual(['low', 'high', 'max'])
  })

  it('skips image-generation tools and entries with no context window', () => {
    const ids = parseConfigModels(CONFIG, 'cn').map((m) => m.id)
    expect(ids).not.toContain('hunyuan-image-alpha')
  })

  it('tolerates a malformed payload', () => {
    expect(parseConfigModels(null, 'cn')).toEqual([])
    expect(parseConfigModels({ data: {} }, 'cn')).toEqual([])
    expect(parseConfigModels({ data: { models: 'nope' } }, 'cn')).toEqual([])
  })
})

describe('WorkBuddy request headers', () => {
  it('sends the CLI identity, which is the only one the gateway accepts everywhere', () => {
    const headers = workBuddyHeaders({
      accessToken: 't', domain: 'copilot.tencent.com', uid: 'u1', enterpriseId: 'e1', backend: 'https://copilot.tencent.com',
    })
    // Measured: the IDE identity is rejected by /v3/config with code 12403.
    expect(headers['user-agent']).toBe('CLI/2.63.2 CodeBuddy/2.63.2')
    expect(headers.authorization).toBe('Bearer t')
    expect(headers['x-user-id']).toBe('u1')
    expect(headers['x-domain']).toBe('copilot.tencent.com')
    // The domestic backend must not receive a foreign origin.
    expect(headers.origin).toBeUndefined()
  })

  it('adds the matching origin and referer for the international backend', () => {
    const headers = workBuddyHeaders({
      accessToken: 't', domain: 'www.workbuddy.ai', uid: 'u1', backend: 'https://www.workbuddy.ai',
    })
    // The international gateway validates the browser origin the IDE would send.
    expect(headers.origin).toBe('https://www.workbuddy.ai')
    expect(headers.referer).toBe('https://www.workbuddy.ai/')
  })
})

describe('WorkBuddy token refresh', () => {
  it('merges the new auth block over the stored one', async () => {
    const credentials = {
      accessToken: 'old', refreshToken: 'old-refresh', expiresAt: 1,
      region: 'cn' as const, domain: 'copilot.tencent.com', backend: 'https://copilot.tencent.com',
      uid: 'u1', sourceFile: '/tmp/a.info', sourceMtimeMs: 0, source: 'desktop' as const,
    }
    const fetchFn = (async () => new Response(JSON.stringify({
      code: 0,
      data: { accessToken: 'new', refreshToken: 'new-refresh', expiresIn: 3600 },
    }), { status: 200 })) as unknown as typeof fetch

    const refreshed = await refreshCredentials(credentials, { fetchFn })
    expect(refreshed.accessToken).toBe('new')
    expect(refreshed.refreshToken).toBe('new-refresh')
    // The endpoint omits the domain; losing it would strand the next refresh.
    expect(refreshed.domain).toBe('copilot.tencent.com')
    expect(refreshed.expiresAt).toBeGreaterThan(Date.now())
  })

  it('rejects a refresh the service refused', async () => {
    const credentials = {
      accessToken: 'old', refreshToken: 'r', expiresAt: 1,
      region: 'cn' as const, domain: 'copilot.tencent.com', backend: 'https://copilot.tencent.com',
      sourceFile: '/tmp/a.info', sourceMtimeMs: 0, source: 'desktop' as const,
    }
    const fetchFn = (async () => new Response(JSON.stringify({ code: 40001, msg: 'invalid refresh token' }), { status: 200 })) as unknown as typeof fetch
    await expect(refreshCredentials(credentials, { fetchFn })).rejects.toThrow(/invalid refresh token/)
  })
})

describe('WorkBuddy billing parsing', () => {
  const BILLING = {
    code: 0,
    data: {
      Response: {
        Data: {
          TotalCount: 7,
          Accounts: [
            {
              PackageName: 'Free Plan Subscription',
              CapacitySize: 100,
              CapacityRemain: 93,
              CycleCapacityUsed: 7,
              CycleCapacitySize: 100,
              CycleStartTime: '2026-09-01 00:00:00',
              CycleEndTime: '2026-09-30 23:59:59',
            },
          ],
        },
      },
    },
  }

  it('reads the nested account block', () => {
    const billing = parseBilling(BILLING)
    expect(billing.packageName).toBe('Free Plan Subscription')
    expect(billing.totalCredits).toBe(100)
    expect(billing.remainingCredits).toBe(93)
    expect(billing.cycleUsedCredits).toBe(7)
    expect(billing.cycleCredits).toBe(100)
    expect(billing.cycleEndsAt).toBeGreaterThan(0)
  })

  it('sums several packages rather than reporting only the first', () => {
    const two = {
      data: {
        Response: {
          Data: {
            Accounts: [
              { PackageName: 'A', CapacitySize: 100, CapacityRemain: 50, CycleCapacityUsed: 5, CycleCapacitySize: 100 },
              { PackageName: 'B', CapacitySize: 200, CapacityRemain: 150, CycleCapacityUsed: 10, CycleCapacitySize: 200 },
            ],
          },
        },
      },
    }
    const billing = parseBilling(two)
    expect(billing.totalCredits).toBe(300)
    expect(billing.remainingCredits).toBe(200)
    expect(billing.cycleUsedCredits).toBe(15)
  })

  it('reports nothing rather than a fabricated zero for an unknown payload', () => {
    const billing = parseBilling({ data: {} })
    expect(billing.totalCredits).toBeNull()
    expect(billing.remainingCredits).toBeNull()
    expect(billingMeters(billing)).toEqual([])
  })

  it('parses the zone-less cycle timestamps the service sends', () => {
    expect(parseCycleTime('2026-09-01 00:00:00')).toBe(new Date('2026-09-01T00:00:00').getTime())
    expect(parseCycleTime(1_788_000_000_000)).toBe(1_788_000_000_000)
    expect(parseCycleTime('')).toBeNull()
    expect(parseCycleTime(undefined)).toBeNull()
  })

  it('builds a bounded cycle meter and a package-balance meter', () => {
    const meters = billingMeters(parseBilling(BILLING))
    const cycle = meters.find((m) => m.id === 'cycle')!
    expect(cycle.usedFraction).toBeCloseTo(0.07)
    expect(cycle.remainingFraction).toBeCloseTo(0.93)
    expect(cycle.used).toBe('7')
    expect(cycle.limit).toBe('100')
    const pkg = meters.find((m) => m.id === 'package')!
    expect(pkg.label).toBe('Free Plan Subscription')
    expect(pkg.limit).toBe('100')
  })
})

describe('WorkBuddy quota fetch', () => {
  it('reads the allowance through the credential store', async () => {
    const dir = await makeAuthDir()
    const store = new FileCredentialStore(dir)
    const fetchFn = (async (url: any) => {
      expect(String(url)).toBe('https://copilot.tencent.com/billing/meter/get-user-resource')
      return new Response(JSON.stringify({
        code: 0,
        data: { Response: { Data: { Accounts: [{ PackageName: 'Free', CapacitySize: 100, CapacityRemain: 90 }] } } },
      }), { status: 200 })
    }) as unknown as typeof fetch

    const quota = await fetchAccountQuota(store, fetchFn, true)
    expect(quota.packageName).toBe('Free')
    expect(quota.account.region).toBe('cn')
    expect(quota.meters.length).toBeGreaterThan(0)
  })

  it('refuses to report a quota without a credential', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-empty-'))
    temporaryDirs.push(dir)
    await expect(fetchAccountQuota(new FileCredentialStore(dir), fetch, true)).rejects.toThrow(/Not signed in/)
  })

  it('surfaces a billing rejection rather than reporting an empty allowance', async () => {
    const dir = await makeAuthDir()
    const store = new FileCredentialStore(dir)
    const fetchFn = (async () => new Response(JSON.stringify({ code: 12403, msg: 'check ua' }), { status: 200 })) as unknown as typeof fetch
    await expect(fetchAccountQuota(store, fetchFn, true)).rejects.toThrow(/check ua/)
  })
})

describe('WorkBuddy model selection', () => {
  it('expands an untouched default to everything the account can call', () => {
    const available = ['glm-5.3', 'kimi-k3', 'deepseek-v4.1-flash', 'hy4-preview', 'gpt-6-astra']
    // The shipped default is a short list; a first run must not hide the rest.
    const resolved = resolveEnabledModelIds([...DEFAULT_VISIBLE_MODEL_IDS], available, true)
    expect(resolved).toEqual(available)
  })

  it('honours an explicit selection exactly, dropping ids the region lost', () => {
    const available = ['glm-5.3', 'kimi-k3']
    expect(resolveEnabledModelIds(['glm-5.3', 'gemini-3.5-flash'], available, true)).toEqual(['glm-5.3'])
  })

  it('selects nothing when the provider is disabled', () => {
    expect(resolveEnabledModelIds(['glm-5.3'], ['glm-5.3'], false)).toEqual([])
  })

  it('reports the catalog context window and lets an override win', () => {
    const options = buildModelOptions(FALLBACK_MODELS, ['glm-5.3'], ['glm-5.3'], { 'glm-5.3': 500_000 })
    const glm = options[0]!
    expect(glm.defaultContextWindow).toBe(1_000_000)
    expect(glm.contextWindow).toBe(500_000)
    expect(glm.supportsImage).toBe(true)
    expect(glm.reasoningEfforts).toEqual(['low', 'high', 'max'])
  })
})

describe('WorkBuddy web status', () => {
  it('renders an unauthenticated card with a usable catalog and no credential leak', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-empty-'))
    temporaryDirs.push(dir)
    const store = new FileCredentialStore(dir)
    const status = await getWorkBuddyWebStatus(store, await makeSettings())
    expect(status.authenticated).toBe(false)
    expect(status.account).toBeNull()
    // The card still needs a list to render before the first sign-in.
    expect(status.models.length).toBeGreaterThan(0)
    expect(status.authDirectory).toBe(dir)
  })

  it('reports the account and a region-filtered catalog when signed in', async () => {
    const dir = await makeAuthDir({ domain: 'copilot.tencent.com' })
    const store = new FileCredentialStore(dir)
    const fetchFn = (async (url: any) => {
      if (String(url).includes('/v3/config')) {
        return new Response(JSON.stringify(CONFIG), { status: 200 })
      }
      return new Response(JSON.stringify({
        code: 0,
        data: { Response: { Data: { Accounts: [{ PackageName: 'Free', CapacitySize: 100, CapacityRemain: 90 }] } } },
      }), { status: 200 })
    }) as unknown as typeof fetch

    const status = await getWorkBuddyWebStatus(store, await makeSettings(), undefined, { fetchFn })
    expect(status.authenticated).toBe(true)
    expect(status.account?.region).toBe('cn')
    // The international-only model must not be offered on a domestic account.
    expect(status.models.map((m) => m.id)).not.toContain('gemini-3.5-flash')
    expect(status.models.length).toBeGreaterThan(0)
  })

  it('never exposes a token or refresh token in the payload', async () => {
    const dir = await makeAuthDir()
    const store = new FileCredentialStore(dir)
    const status = await getWorkBuddyWebStatus(store, await makeSettings(), undefined, { fetchFn: (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch })
    const serialized = JSON.stringify(status)
    expect(serialized).not.toContain('token-abc')
    expect(serialized).not.toContain('refresh-abc')
  })

  it('falls back to the shipped catalog when the gateway is unreachable', async () => {
    const dir = await makeAuthDir()
    const store = new FileCredentialStore(dir)
    const fetchFn = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    const status = await getWorkBuddyWebStatus(store, await makeSettings(), undefined, { fetchFn })
    expect(status.models.length).toBeGreaterThan(0)
  })
})

/** Minimal IncomingMessage/ServerResponse doubles for the route handler. */
function makeRequest(method: string, url: string, body?: unknown, origin?: string) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers: {
      host: '127.0.0.1:43120',
      ...(origin === undefined ? {} : { origin }),
      'content-type': 'application/json',
    },
    on(event: string, handler: any) {
      if (event === 'data') for (const chunk of chunks) handler(chunk)
      if (event === 'end') handler()
      return this
    },
    destroy() {},
  } as any
}

function makeResponse() {
  const captured = { status: 0, body: '' }
  return {
    captured,
    writeHead(status: number) { captured.status = status; return this },
    end(body: string) { captured.body = body },
  } as any
}

function makeContext(handlers: any[]): any {
  return {
    webServer: {
      register(route: any) {
        handlers.push(route)
        return () => undefined
      },
    },
  }
}

describe('WorkBuddy routes', () => {
  it('registers under /workbuddy/api and serves status', async () => {
    const dir = await makeAuthDir()
    const store = new FileCredentialStore(dir)
    const handlers: any[] = []
    registerWorkBuddyRoutes(makeContext(handlers), store, await makeSettings(), undefined, {
      fetchFn: (async () => new Response(JSON.stringify(CONFIG), { status: 200 })) as unknown as typeof fetch,
    })
    expect(handlers[0]!.path).toBe('/workbuddy/api')

    const res = makeResponse()
    await handlers[0]!.handler(makeRequest('GET', '/workbuddy/api/status'), res)
    expect(res.captured.status).toBe(200)
    const payload = JSON.parse(res.captured.body)
    expect(payload.ok).toBe(true)
    expect(payload.value.authenticated).toBe(true)
  })

  it('rejects a cross-origin mutation', async () => {
    const dir = await makeAuthDir()
    const handlers: any[] = []
    registerWorkBuddyRoutes(makeContext(handlers), new FileCredentialStore(dir), await makeSettings())
    const res = makeResponse()
    await handlers[0]!.handler(makeRequest('POST', '/workbuddy/api/settings', {}, 'https://evil.example'), res)
    expect(res.captured.status).toBe(403)
  })
  it('rejects a cross-origin quota refresh but still serves a same-origin one', async () => {
    const dir = await makeAuthDir()
    const handlers: any[] = []
    const fetchFn = (async (url: any) => {
      const target = String(url)
      if (target.includes('/billing/meter/get-user-resource')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { Response: { Data: { Accounts: [{ PackageName: 'Free', CapacitySize: 100, CapacityRemain: 90 }] } } },
        }), { status: 200 })
      }
      return new Response(JSON.stringify(CONFIG), { status: 200 })
    }) as unknown as typeof fetch
    registerWorkBuddyRoutes(makeContext(handlers), new FileCredentialStore(dir), await makeSettings(), undefined, { fetchFn })

    // A POST forces an upstream read and can rotate the refresh token, so it is
    // gated exactly like the other mutations.
    const denied = makeResponse()
    await handlers[0]!.handler(makeRequest('POST', '/workbuddy/api/quota', {}, 'https://evil.example'), denied)
    expect(denied.captured.status).toBe(403)

    const allowed = makeResponse()
    await handlers[0]!.handler(makeRequest('POST', '/workbuddy/api/quota', {}, 'http://127.0.0.1:43120'), allowed)
    expect(allowed.captured.status).toBe(200)
    expect(JSON.parse(allowed.captured.body).ok).toBe(true)
  })

  it('never serves one region the catalog snapshot read for another', async () => {
    const offline = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    const online = (async () => new Response(JSON.stringify(CONFIG), { status: 200 })) as unknown as typeof fetch
    const credentials = (region: 'cn' | 'intl'): WorkBuddyCredentials => ({
      accessToken: 't',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      region,
      domain: region === 'intl' ? 'www.workbuddy.ai' : 'copilot.tencent.com',
      backend: region === 'intl' ? 'https://www.workbuddy.ai' : 'https://copilot.tencent.com',
      sourceFile: '',
      sourceMtimeMs: 0,
      source: 'desktop',
    })

    const cn = await loadConfigCatalog(credentials('cn'), { fetchFn: online })
    expect(cn.length).toBeGreaterThan(0)
    // The same region still reuses its own snapshot when the gateway is down.
    expect(await loadConfigCatalog(credentials('cn'), { fetchFn: offline })).toEqual(cn)

    // The other region must not inherit it: those entries declare only `cn`, so
    // the picker would filter every model out instead of using the shipped table.
    expect(await loadConfigCatalog(credentials('intl'), { fetchFn: offline })).toEqual([])
  })
  it('renews an expired token before the connection probe', async () => {
    const dir = await makeAuthDir({ expiresAt: Date.now() - 1000 })
    const handlers: any[] = []
    const urls: string[] = []
    const fetchFn = (async (url: any, init: any) => {
      urls.push(String(url))
      if (String(url).includes('/v2/plugin/auth/token/refresh')) {
        return new Response(JSON.stringify({ code: 0, data: { accessToken: 'fresh-token', expiresIn: 3600 } }), { status: 200 })
      }
      expect(init.headers.authorization).toBe('Bearer fresh-token')
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch
    registerWorkBuddyRoutes(makeContext(handlers), new FileCredentialStore(dir), await makeSettings(), undefined, { fetchFn })

    const res = makeResponse()
    await handlers[0]!.handler(makeRequest('POST', '/workbuddy/api/connection/test', {}, 'http://127.0.0.1:43120'), res)
    expect(res.captured.status).toBe(200)
    expect(JSON.parse(res.captured.body).value.connected).toBe(true)
    expect(urls[0]).toContain('/v2/plugin/auth/token/refresh')
  })

  it('stops an in-flight browser login when the routes are disposed', async () => {
    vi.useFakeTimers()
    try {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-login-'))
      temporaryDirs.push(dir)
      const handlers: any[] = []
      const fetchFn = (async (url: any) => {
        if (String(url).includes('/auth/state')) {
          return new Response(JSON.stringify({ code: 0, data: { state: 's', authUrl: 'https://copilot.tencent.com/login' } }), { status: 200 })
        }
        return new Response(JSON.stringify({ code: 11217, msg: 'login ing...' }), { status: 200 })
      }) as unknown as typeof fetch
      const dispose = registerWorkBuddyRoutes(makeContext(handlers), new FileCredentialStore(dir), await makeSettings(), undefined, { fetchFn })

      const started = makeResponse()
      await handlers[0]!.handler(makeRequest('POST', '/workbuddy/api/accounts/login', { region: 'cn' }, 'http://127.0.0.1:43120'), started)
      expect(JSON.parse(started.captured.body).value.status).toBe('pending')

      dispose()
      await vi.advanceTimersByTimeAsync(10_000)

      const status = makeResponse()
      await handlers[0]!.handler(makeRequest('GET', '/workbuddy/api/accounts/login/status'), status)
      expect(JSON.parse(status.captured.body).value.status).toBe('idle')
    } finally {
      vi.useRealTimers()
    }
  })

  it('accepts a same-origin settings update and persists it', async () => {
    const dir = await makeAuthDir()
    const settings = await makeSettings()
    const handlers: any[] = []
    registerWorkBuddyRoutes(makeContext(handlers), new FileCredentialStore(dir), settings, undefined, {
      fetchFn: (async () => new Response(JSON.stringify(CONFIG), { status: 200 })) as unknown as typeof fetch,
    })
    const res = makeResponse()
    await handlers[0]!.handler(
      makeRequest('POST', '/workbuddy/api/settings', { enabledModelIds: ['glm-5.3'], defaultReasoningEffort: 'max' }, 'http://127.0.0.1:43120'),
      res,
    )
    expect(res.captured.status).toBe(200)
    expect((await settings.read()).enabledModelIds).toEqual(['glm-5.3'])
    expect((await settings.read()).defaultReasoningEffort).toBe('max')
  })

  it('persists a selected regional account and returns its model catalog', async () => {
    const dir = await makeAuthDir()
    await fs.writeFile(path.join(dir, 'intl.info'), JSON.stringify({
      account: { uid: 'intl-user', nickname: 'international' },
      auth: { accessToken: 'intl-token', expiresAt: Date.now() + 2_000_000, domain: 'www.workbuddy.ai' },
    }), 'utf8')
    const settings = await makeSettings()
    const handlers: any[] = []
    registerWorkBuddyRoutes(makeContext(handlers), new FileCredentialStore(dir), settings, undefined, {
      fetchFn: (async () => new Response(JSON.stringify(CONFIG), { status: 200 })) as unknown as typeof fetch,
    })
    const res = makeResponse()
    await handlers[0]!.handler(
      makeRequest('POST', '/workbuddy/api/settings', { selectedAccountId: 'intl:intl-user' }, 'http://127.0.0.1:43120'),
      res,
    )
    expect(res.captured.status).toBe(200)
    const payload = JSON.parse(res.captured.body)
    expect(payload.value.account.id).toBe('intl:intl-user')
    expect(payload.value.account.region).toBe('intl')
    expect((await settings.read()).selectedAccountId).toBe('intl:intl-user')
  })

  it('rejects an account id that is not present on this machine', async () => {
    const dir = await makeAuthDir()
    const settings = await makeSettings()
    const handlers: any[] = []
    registerWorkBuddyRoutes(makeContext(handlers), new FileCredentialStore(dir), settings)
    const res = makeResponse()
    await handlers[0]!.handler(
      makeRequest('POST', '/workbuddy/api/settings', { selectedAccountId: 'intl:missing' }, 'http://127.0.0.1:43120'),
      res,
    )
    expect(res.captured.status).toBe(400)
    expect((await settings.read()).selectedAccountId).toBeNull()
  })

  it('ignores an unknown reasoning level instead of storing it', async () => {
    const dir = await makeAuthDir()
    const settings = await makeSettings()
    const handlers: any[] = []
    registerWorkBuddyRoutes(makeContext(handlers), new FileCredentialStore(dir), settings, undefined, {
      fetchFn: (async () => new Response(JSON.stringify(CONFIG), { status: 200 })) as unknown as typeof fetch,
    })
    const res = makeResponse()
    await handlers[0]!.handler(
      makeRequest('POST', '/workbuddy/api/settings', { defaultReasoningEffort: 'ultra' }, 'http://127.0.0.1:43120'),
      res,
    )
    expect(res.captured.status).toBe(200)
    expect((await settings.read()).defaultReasoningEffort).toBeNull()
  })

  it('rejects a method that does not belong to the route', async () => {
    const dir = await makeAuthDir()
    const handlers: any[] = []
    registerWorkBuddyRoutes(makeContext(handlers), new FileCredentialStore(dir), await makeSettings())
    const res = makeResponse()
    await handlers[0]!.handler(makeRequest('DELETE', '/workbuddy/api/status'), res)
    expect(res.captured.status).toBe(405)
  })

  it('answers not-found for an unknown subpath', async () => {
    const dir = await makeAuthDir()
    const handlers: any[] = []
    registerWorkBuddyRoutes(makeContext(handlers), new FileCredentialStore(dir), await makeSettings())
    const res = makeResponse()
    await handlers[0]!.handler(makeRequest('GET', '/workbuddy/api/nope'), res)
    expect(res.captured.status).toBe(404)
  })

  it('lists every credential in the auth directory without leaking tokens', async () => {
    const dir = await makeAuthDir()
    await fs.writeFile(path.join(dir, 'workbuddy-desktop.2026-01-01T00-00-00-000Z.1.info'), JSON.stringify({
      account: { uid: 'uid-2', nickname: 'second' },
      auth: { accessToken: 'other-token', expiresAt: Date.now() + 1_000_000, domain: 'www.workbuddy.ai' },
    }), 'utf8')
    const handlers: any[] = []
    registerWorkBuddyRoutes(makeContext(handlers), new FileCredentialStore(dir), await makeSettings())
    const res = makeResponse()
    await handlers[0]!.handler(makeRequest('GET', '/workbuddy/api/accounts'), res)
    expect(res.captured.status).toBe(200)
    const payload = JSON.parse(res.captured.body)
    expect(payload.value.accounts).toHaveLength(2)
    expect(payload.value.accounts.map((account: any) => account.id)).toEqual(['cn:uid-1', 'intl:uid-2'])
    expect(res.captured.body).not.toContain('token')
  })

  it('hides and restores a desktop account without deleting its source file', async () => {
    const dir = await makeAuthDir()
    const source = path.join(dir, 'workbuddy-desktop.info')
    const settings = await makeSettings()
    const handlers: any[] = []
    registerWorkBuddyRoutes(makeContext(handlers), new FileCredentialStore(dir), settings)
    const hide = makeResponse()
    await handlers[0]!.handler(
      makeRequest('POST', '/workbuddy/api/accounts/action', { action: 'hide', accountId: 'cn:uid-1' }, 'http://127.0.0.1:43120'),
      hide,
    )
    expect(hide.captured.status).toBe(200)
    expect((await settings.read()).hiddenAccountIds).toContain('cn:uid-1')
    expect(await fs.stat(source)).toBeTruthy()
    const restore = makeResponse()
    await handlers[0]!.handler(
      makeRequest('POST', '/workbuddy/api/accounts/action', { action: 'restore', accountId: 'cn:uid-1' }, 'http://127.0.0.1:43120'),
      restore,
    )
    expect(restore.captured.status).toBe(200)
    expect((await settings.read()).hiddenAccountIds).toEqual([])
    expect(await fs.stat(source)).toBeTruthy()
  })

  it('refuses to delete a desktop-owned credential', async () => {
    const dir = await makeAuthDir()
    const handlers: any[] = []
    registerWorkBuddyRoutes(makeContext(handlers), new FileCredentialStore(dir), await makeSettings())
    const res = makeResponse()
    await handlers[0]!.handler(
      makeRequest('POST', '/workbuddy/api/accounts/action', { action: 'delete', accountId: 'cn:uid-1' }, 'http://127.0.0.1:43120'),
      res,
    )
    expect(res.captured.status).toBe(400)
    expect(res.captured.body).toContain('cannot be deleted')
  })

  it('refuses a connection test without a credential', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-empty-'))
    temporaryDirs.push(dir)
    const handlers: any[] = []
    registerWorkBuddyRoutes(makeContext(handlers), new FileCredentialStore(dir), await makeSettings())
    const res = makeResponse()
    await handlers[0]!.handler(
      makeRequest('POST', '/workbuddy/api/connection/test', {}, 'http://127.0.0.1:43120'),
      res,
    )
    expect(res.captured.status).toBe(400)
  })

  it('probes a real model on the connection test', async () => {
    const dir = await makeAuthDir()
    const seen: string[] = []
    const handlers: any[] = []
    registerWorkBuddyRoutes(makeContext(handlers), new FileCredentialStore(dir), await makeSettings(), undefined, {
      fetchFn: (async (url: any, init: any) => {
        seen.push(String(url))
        if (String(url).includes('/v3/config')) return new Response(JSON.stringify(CONFIG), { status: 200 })
        const body = JSON.parse(String(init.body))
        expect(body.messages[0].role).toBe('system')
        return new Response('data: [DONE]\n\n', { status: 200 })
      }) as unknown as typeof fetch,
    })
    const res = makeResponse()
    await handlers[0]!.handler(
      makeRequest('POST', '/workbuddy/api/connection/test', {}, 'http://127.0.0.1:43120'),
      res,
    )
    expect(res.captured.status).toBe(200)
    const payload = JSON.parse(res.captured.body)
    expect(payload.value.connected).toBe(true)
    expect(seen.some((u) => u.includes('/v2/chat/completions'))).toBe(true)
  })
})
