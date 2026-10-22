/**
 * The OpenDesign settings API: envelope shape, account handling, catalog sync,
 * visibility and the no-secret boundary.
 *
 * Nothing here reaches OpenDesign: the pool and credential store are in-memory,
 * the model settings file lives in a temp directory, and fetch is a double.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { registerOpenDesignRoutes, type OpenDesignRouteOptions } from '../src/host/opendesign/routes.ts'
import { OpenDesignAccountPool } from '../src/host/opendesign/account-pool.ts'
import { FileCredentialStore, OpenDesignModelSettingsStore, type OpenDesignCredentials } from '../src/host/opendesign/token-store.ts'
import { DEFAULT_MODELS } from '../src/host/opendesign/types.ts'
import { OpenDesignLoginManager } from '../src/host/opendesign/oauth.ts'
import type { OpenDesignWebStatus } from '../src/shared/opendesign-contracts.ts'

interface Captured {
  status: number
  body: { ok: boolean; value?: unknown; error?: unknown }
  raw: string
}

function fakeExchange(): { response: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: { ok: false }, raw: '' }
  const response = {
    writeHead(status: number) {
      captured.status = status
      return response
    },
    end(raw?: string) {
      captured.raw = raw ?? ''
      if (raw !== undefined && raw !== '') captured.body = JSON.parse(raw) as Captured['body']
    },
  } as unknown as ServerResponse
  return { response, captured }
}

function fakeRequest(input: { url: string; method?: string; body?: unknown; origin?: string | null }): IncomingMessage {
  const headers: Record<string, string> = { host: '127.0.0.1:3000' }
  const origin = input.origin === undefined ? 'http://127.0.0.1:3000' : input.origin
  if (origin !== null) headers.origin = origin
  const chunks = input.method === 'POST' && input.body !== undefined ? [Buffer.from(JSON.stringify(input.body))] : []
  return {
    url: input.url,
    method: input.method ?? 'GET',
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
    destroy() {},
  } as unknown as IncomingMessage
}

class MemoryBackend<T> {
  private data: unknown = null
  async load(): Promise<T | null> {
    return this.data === null ? null : JSON.parse(JSON.stringify(this.data)) as T
  }
  async save(data: T): Promise<void> {
    this.data = JSON.parse(JSON.stringify(data))
  }
  async clear(): Promise<void> {
    this.data = null
  }
}

let dir = ''
let pool: OpenDesignAccountPool
let settings: OpenDesignModelSettingsStore
let handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
let emit: ReturnType<typeof vi.fn>
let dispose: () => void
let upstreamFetch: typeof fetch
let loginFetch: typeof fetch
let login: OpenDesignLoginManager

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opendesign-routes-'))
  const credential = new FileCredentialStore(path.join(dir, 'credentials.json'), new MemoryBackend<OpenDesignCredentials>() as never)
  pool = new OpenDesignAccountPool({
    store: credential,
    backend: new MemoryBackend() as never,
  })
  settings = new OpenDesignModelSettingsStore(path.join(dir, 'models.json'))
  const registrations: Array<{ kind: string; path: string; handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }> = []
  emit = vi.fn()
  const ctx = {
    webServer: {
      register(options: { kind: string; path: string; handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }) {
        registrations.push(options)
        return () => undefined
      },
    },
    emit,
  } as unknown as Context
  upstreamFetch = (async () => new Response('{"data":[]}')) as typeof fetch
  loginFetch = (async () => { throw new Error('login fetch not stubbed') }) as typeof fetch
  login = new OpenDesignLoginManager({
    fetchFn: (...args) => loginFetch(...args),
    host: () => 'test-host',
    onLogin: async (credentials) => {
      await pool.addAccount(credentials, credentials.user?.name ?? credentials.user?.email)
    },
  })
  const options: OpenDesignRouteOptions = {
    settings,
    accountPool: pool,
    fetchFn: (...args) => upstreamFetch(...args),
    login,
    serving: () => true,
    conflict: () => null,
  }
  dispose = registerOpenDesignRoutes(ctx, options)
  handler = registrations[0]!.handler
})

afterEach(async () => {
  login.dispose()
  dispose()
  await fs.rm(dir, { recursive: true, force: true })
})

async function call(input: { url: string; method?: string; body?: unknown; origin?: string | null }): Promise<Captured> {
  const { response, captured } = fakeExchange()
  await handler(fakeRequest(input), response)
  return captured
}

describe('OpenDesign settings API', () => {
  it('serves the whole status the card renders', async () => {
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_secret', alias: 'main' })
    const captured = await call({ url: '/opendesign/api/status' })
    expect(captured.status).toBe(200)
    expect(captured.body.ok).toBe(true)
    const status = captured.body.value as OpenDesignWebStatus
    expect(status.providerId).toBe('opendesign')
    expect(status.pool.accounts).toHaveLength(1)
    expect(status.authenticated).toBe(true)
    expect(status.models).toHaveLength(DEFAULT_MODELS.length)
    // No credential ever crosses this boundary.
    expect(captured.raw).not.toContain('od_secret')
  })

  it('reports an unsigned line honestly: no accounts, still configurable', async () => {
    const captured = await call({ url: '/opendesign/api/status' })
    const status = captured.body.value as OpenDesignWebStatus
    expect(status.pool.accounts).toEqual([])
    expect(status.authenticated).toBe(false)
    expect(status.serving).toBe(true)
    expect(status.catalogSynced).toBe(false)
  })

  it('adds an account without ever answering with the key', async () => {
    const captured = await call({
      url: '/opendesign/api/accounts',
      method: 'POST',
      body: { action: 'add', apiKey: 'od_live_key', alias: '主号' },
    })
    expect(captured.status).toBe(200)
    expect(captured.raw).not.toContain('od_live_key')
    const status = captured.body.value as OpenDesignWebStatus
    expect(status.pool.accounts).toHaveLength(1)
    expect(status.pool.accounts[0]!.alias).toBe('主号')
    expect(status.pool.accounts[0]!.authKind).toBe('api-key')
  })

  it('tests a typed key with the free catalog read, not a paid chat', async () => {
    upstreamFetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      expect(url).toBe('https://amr-link.open-design.ai/v1/models')
      const key = new Headers(init?.headers).get('authorization') ?? ''
      if (key === 'Bearer od_bad') {
        return Response.json({ error: { code: 'invalid_api_key', message: 'api key not found' } }, { status: 401 })
      }
      return Response.json({ data: [{ id: 'gpt-6-luna' }, { id: 'kimi-k3' }] })
    }) as typeof fetch
    const good = await call({ url: '/opendesign/api/accounts', method: 'POST', body: { action: 'test', apiKey: 'od_ok' } })
    expect((good.body.value as { authorized: boolean; modelCount: number }).authorized).toBe(true)
    expect((good.body.value as { modelCount: number }).modelCount).toBe(2)
    const bad = await call({ url: '/opendesign/api/accounts', method: 'POST', body: { action: 'test', apiKey: 'od_bad' } })
    const verdict = bad.body.value as { authorized: boolean; error: string }
    expect(verdict.authorized).toBe(false)
    expect(verdict.error).toContain('api key not found')
  })

  it('tests a stored account without the caller knowing the key', async () => {
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_stored', alias: 'main' })
    const accountId = (await pool.listAccounts())[0]!.id
    let seenKey = ''
    upstreamFetch = (async (_input: unknown, init?: RequestInit) => {
      seenKey = new Headers(init?.headers).get('authorization') ?? ''
      return Response.json({ data: [{ id: 'gpt-6-luna' }] })
    }) as typeof fetch
    const captured = await call({ url: '/opendesign/api/accounts', method: 'POST', body: { action: 'test', accountId } })
    expect(captured.status).toBe(200)
    expect(seenKey).toBe('Bearer od_stored')
    expect(captured.raw).not.toContain('od_stored')
  })

  it('rejects a cross-origin mutation', async () => {
    const captured = await call({
      url: '/opendesign/api/accounts',
      method: 'POST',
      body: { action: 'add', apiKey: 'od_x' },
      origin: 'https://evil.example',
    })
    expect(captured.status).toBe(403)
  })

  it('validates settings patches and resets a blank baseURL to the default', async () => {
    const bad = await call({ url: '/opendesign/api/settings', method: 'POST', body: { defaultContextWindow: -1 } })
    expect(bad.status).toBe(400)
    const noUrl = await call({ url: '/opendesign/api/settings', method: 'POST', body: { baseURL: 'not-a-url' } })
    expect(noUrl.status).toBe(400)
    const good = await call({ url: '/opendesign/api/settings', method: 'POST', body: { baseURL: '', maxConcurrentRequests: 0 } })
    expect(good.status).toBe(200)
    const settingsDoc = await settings.read()
    expect(settingsDoc.baseURL).toBe('https://amr-link.open-design.ai/v1')
    expect(settingsDoc.maxConcurrentRequests).toBe(0)
  })

  it('keeps the model selection tri-state: unset, empty, explicit', async () => {
    const explicit = await call({ url: '/opendesign/api/models', method: 'POST', body: { enabledModelIds: ['gpt-6-luna'] } })
    expect((explicit.body.value as OpenDesignWebStatus).models.filter((model) => model.enabled).map((model) => model.id)).toEqual(['gpt-6-luna'])
    const none = await call({ url: '/opendesign/api/models', method: 'POST', body: { enabledModelIds: [] } })
    expect((none.body.value as OpenDesignWebStatus).models.every((model) => !model.enabled)).toBe(true)
    const unset = await call({ url: '/opendesign/api/models', method: 'POST', body: { enabledModelIds: null } })
    expect((unset.body.value as OpenDesignWebStatus).models.every((model) => model.enabled)).toBe(true)
  })

  it('hides and restores a model through the visibility routes', async () => {
    const hidden = await call({ url: '/opendesign/api/models/visibility', method: 'POST', body: { model: 'gpt-6-luna', visible: false } })
    const status = hidden.body.value as OpenDesignWebStatus
    expect(status.models.find((model) => model.id === 'gpt-6-luna')!.enabled).toBe(false)
    const unknown = await call({ url: '/opendesign/api/models/visibility', method: 'POST', body: { model: 'not-a-model', visible: false } })
    expect(unknown.status).toBe(400)
    const restored = await call({ url: '/opendesign/api/models/visibility-all', method: 'POST', body: { mode: 'all' } })
    expect((restored.body.value as OpenDesignWebStatus).models.every((model) => model.enabled)).toBe(true)
  })

  it('stores and clears a context-window override', async () => {
    const captured = await call({ url: '/opendesign/api/models/context-window', method: 'POST', body: { model: 'gpt-6-luna', contextWindow: 256_000 } })
    const status = captured.body.value as OpenDesignWebStatus
    const model = status.models.find((entry) => entry.id === 'gpt-6-luna')!
    expect(model.contextWindow).toBe(256_000)
    expect(model.contextWindowOverride).toBe(256_000)
    // The published (vendor) window, before this model's override.
    expect(model.defaultContextWindow).toBe(1_050_000)
    const invalid = await call({ url: '/opendesign/api/models/context-window', method: 'POST', body: { model: 'gpt-6-luna', contextWindow: 0 } })
    expect(invalid.status).toBe(400)
    const cleared = await call({ url: '/opendesign/api/models/context-window', method: 'POST', body: { model: 'gpt-6-luna', contextWindow: null } })
    expect((cleared.body.value as OpenDesignWebStatus).models.find((entry) => entry.id === 'gpt-6-luna')!.contextWindowOverride).toBeUndefined()
  })

  it('syncs the live catalog with a pooled key and announces a change once', async () => {
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_sync' }, 'main')
    upstreamFetch = (async () => Response.json({
      data: [
        { id: 'gpt-6-luna', context_window: 272_000 },
        { id: 'new-model-x', name: 'New Model X' },
      ],
    })) as unknown as typeof fetch
    const captured = await call({ url: '/opendesign/api/catalog/refresh', method: 'POST', body: {} })
    expect(captured.status).toBe(200)
    const value = captured.body.value as { added: string[]; status: OpenDesignWebStatus }
    expect(value.added).toEqual(['gpt-6-luna', 'new-model-x'])
    const status = value.status
    expect(status.catalogSynced).toBe(true)
    expect(status.models.map((model) => model.id)).toContain('new-model-x')
    expect(status.models.find((model) => model.id === 'gpt-6-luna')!.contextWindow).toBe(272_000)
    // A model the listing omits keeps its shipped vendor facts, not a default.
    expect(status.models.find((model) => model.id === 'claude-sonnet-5.5')!.contextWindow).toBe(1_000_000)
    expect(status.models.find((model) => model.id === 'claude-sonnet-5.5')!.hint).toContain('reasoning(5)')
    const announces = emit.mock.calls.filter((args) => args[0] === 'llm/adapters-updated')
    expect(announces).toHaveLength(1)

    // A second sync over the same listing changes nothing and stays silent:
    // the picker rebuilds on that event, so a no-change sync must not emit.
    const again = await call({ url: '/opendesign/api/catalog/refresh', method: 'POST', body: {} })
    expect(again.status).toBe(200)
    expect((again.body.value as { added: string[] }).added).toEqual([])
    expect(emit.mock.calls.filter((args) => args[0] === 'llm/adapters-updated')).toHaveLength(1)
  })

  it('refuses a sync honestly when no account can read the catalog', async () => {
    const captured = await call({ url: '/opendesign/api/catalog/refresh', method: 'POST', body: {} })
    expect(captured.status).toBe(502)
    expect(String(captured.body.error)).toContain('could not be read')
  })

  it('a failed sync leaves the shipped table standing', async () => {
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_sync' }, 'main')
    upstreamFetch = (async () => { throw new Error('network down') }) as unknown as typeof fetch
    const captured = await call({ url: '/opendesign/api/catalog/refresh', method: 'POST', body: {} })
    expect(captured.status).toBe(502)
    const status = (await call({ url: '/opendesign/api/status' })).body.value as OpenDesignWebStatus
    expect(status.models).toHaveLength(DEFAULT_MODELS.length)
  })
})

describe('OpenDesign sign-in and wallet routes', () => {
  it('starts a device-authorization flow and answers the activation URL for the card', async () => {
    loginFetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      expect(body).toEqual({ host: 'test-host', profile: 'prod', cliVersion: 'dsh-chatgpt-subscription' })
      return Response.json({
        deviceId: 'dev-1',
        userCode: 'AB12CD',
        status: 'pending',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        deviceSecret: 'secret-1',
        activationUrl: 'https://open-design.ai/cloud/cli/activate?deviceId=dev-1&userCode=AB12CD',
        pollIntervalSeconds: 2,
      }, { status: 201 })
    }) as unknown as typeof fetch
    const captured = await call({ url: '/opendesign/api/login/start', method: 'POST', body: {} })
    expect(captured.status).toBe(200)
    const flow = captured.body.value as { id: string; userCode: string; verificationUri: string; status: string }
    expect(flow.status).toBe('pending')
    expect(flow.userCode).toBe('AB12CD')
    expect(flow.verificationUri).toContain('deviceId=dev-1')
    // The host must not leak the device secret into the card's payload.
    expect(captured.raw).not.toContain('secret-1')
  })

  it('completes sign-in through status polls and the card never sees the keys', async () => {
    let polls = 0
    loginFetch = (async () => {
      polls += 1
      if (polls === 1) {
        return Response.json({
          deviceId: 'dev-1', userCode: 'AB12CD', status: 'pending',
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          deviceSecret: 'secret-1',
          activationUrl: 'https://open-design.ai/cloud/cli/activate?deviceId=dev-1',
          pollIntervalSeconds: 1,
        }, { status: 201 })
      }
      return Response.json({
        deviceId: 'dev-1', userCode: 'AB12CD', status: 'approved',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        controlKey: 'vela_ctrl_abc', runtimeKey: 'sk-amr-xyz',
        user: { id: 'u-1', email: 'dev@example.com', name: 'Dev', plan: 'pro' },
      })
    }) as unknown as typeof fetch
    const started = await call({ url: '/opendesign/api/login/start', method: 'POST', body: {} })
    const flowId = (started.body.value as { id: string }).id
    vi.useFakeTimers()
    let completed: { status: string; accountAlias: string } | null = null
    try {
      vi.setSystemTime(Date.now() + 1_500)
      const polled = await call({ url: `/opendesign/api/login/status?id=${flowId}` })
      expect(polled.status).toBe(200)
      completed = polled.body.value as { status: string; accountAlias: string }
      expect(completed.status).toBe('complete')
      expect(completed.accountAlias).toBe('Dev')
      // Keys never cross to the card: not in the flow payload, not in status.
      expect(polled.raw).not.toContain('vela_ctrl_abc')
      expect(polled.raw).not.toContain('sk-amr-xyz')
    } finally {
      vi.useRealTimers()
    }
    const status = await call({ url: '/opendesign/api/status' })
    const body = status.body.value as OpenDesignWebStatus
    expect(body.pool.accounts).toHaveLength(1)
    expect(body.pool.accounts[0]!.authKind).toBe('oauth')
    expect(body.pool.accounts[0]!.plan).toBe('pro')
    expect(status.raw).not.toContain('vela_ctrl_abc')
    expect(status.raw).not.toContain('sk-amr-xyz')
  })

  it('rejects a cross-origin login start and a missing status id', async () => {
    const cross = await call({ url: '/opendesign/api/login/start', method: 'POST', body: {}, origin: 'https://evil.example' })
    expect(cross.status).toBe(403)
    const noId = await call({ url: '/opendesign/api/login/status' })
    expect(noId.status).toBe(400)
  })

  it('reads wallet balances for OAuth accounts only, and keeps failures as data', async () => {
    await pool.addAccount({
      kind: 'oauth',
      controlKey: 'vela_ctrl_ok',
      runtimeKey: 'sk-amr-ok',
      user: { name: 'Dev', email: 'dev@example.com', plan: 'pro' },
    }, 'Dev')
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_pasted' }, 'pasted')
    upstreamFetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      const auth = new Headers(init?.headers).get('authorization') ?? ''
      expect(auth).toBe('Bearer vela_ctrl_ok')
      if (url.endsWith('/wallet/balance')) {
        return Response.json({ balanceUsd: '12.34', updatedAt: '2026-10-21T05:00:00Z' })
      }
      if (url.endsWith('/billing/summary')) {
        return Response.json({
          balanceUsd: '12.3400',
          balances: { subscriptionCredits: '100000', rechargeCredits: '23400', totalAvailableCredits: '123400' },
          membershipTier: 'pro',
          billingInterval: 'monthly',
          subscriptionStatus: 'active',
          subscriptionEntitlementStatus: 'active',
          subscriptionCurrentPeriodStart: '2026-10-01T00:00:00.000Z',
          subscriptionCurrentPeriodEnd: '2026-11-01T00:00:00.000Z',
          subscriptionCreditsUsd: '10.0000',
          rechargeCreditsUsd: '2.3400',
          totalAvailableCreditsUsd: '12.3400',
          totalConsumedUsd: '0.4200',
          todayConsumedUsd: '0.0100',
          usageCount: 42,
          updatedAt: '2026-10-21T05:00:00.000Z',
        })
      }
      throw new Error('unexpected upstream: ' + url)
    }) as unknown as typeof fetch
    const captured = await call({ url: '/opendesign/api/usage', method: 'POST', body: {} })
    expect(captured.status).toBe(200)
    const value = captured.body.value as { usage: { accounts: Array<{ alias: string; ok: boolean; balanceUsd: string | null; billing?: { plan: string; subscriptionCredits: string } }> } }
    // The pasted key is skipped, not failed: it has no control key to read with.
    expect(value.usage.accounts).toHaveLength(1)
    expect(value.usage.accounts[0]).toMatchObject({ alias: 'Dev', ok: true, balanceUsd: '12.34' })
    expect(value.usage.accounts[0]!.billing).toMatchObject({ plan: 'pro', subscriptionCredits: '100000' })
    // The status now carries the reading, and still no secret.
    expect(captured.raw).not.toContain('vela_ctrl_ok')
    const status = await call({ url: '/opendesign/api/status' })
    const body = status.body.value as OpenDesignWebStatus
    expect(body.usage?.accounts[0]?.balanceUsd).toBe('12.34')
  })


  it('lets the billing summary name the tier, not the sign-in snapshot', async () => {
    await pool.addAccount({
      kind: 'oauth',
      controlKey: 'vela_ctrl_plan',
      runtimeKey: 'sk-amr_plan',
      user: { name: 'Dev', plan: 'free' },
    }, 'Dev')
    upstreamFetch = (async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/wallet/balance')) return Response.json({ balanceUsd: '1.5000' })
      if (url.endsWith('/billing/summary')) {
        return Response.json({
          balances: { subscriptionCredits: '10000', rechargeCredits: '5000', totalAvailableCredits: '15000' },
          membershipTier: 'go',
          subscriptionStatus: 'active',
          subscriptionEntitlementStatus: 'active',
          subscriptionCurrentPeriodStart: '2026-10-21T03:33:15.000Z',
          subscriptionCurrentPeriodEnd: '2026-11-21T03:33:15.000Z',
          totalAvailableCreditsUsd: '1.5000',
          totalConsumedUsd: '0.0000',
          todayConsumedUsd: '0.0000',
        })
      }
      throw new Error('unexpected upstream: ' + url)
    }) as unknown as typeof fetch
    const captured = await call({ url: '/opendesign/api/usage', method: 'POST', body: {} })
    expect(captured.status).toBe(200)
    const value = captured.body.value as {
      usage: { accounts: Array<{ billing?: { plan: string; status: string; periodEnd: string | null } }> }
      status: OpenDesignWebStatus
    }
    expect(value.usage.accounts[0]!.billing).toMatchObject({
      plan: 'go',
      status: 'active',
      periodEnd: '2026-11-21T03:33:15.000Z',
    })
    // The stale sign-in snapshot said "free"; one summary read corrects the
    // account everywhere the pool is projected.
    expect(value.status.pool.accounts[0]!.plan).toBe('go')
  })

  it('keeps the credits available when the wallet read is refused', async () => {
    await pool.addAccount({
      kind: 'oauth',
      controlKey: 'vela_ctrl_fallback',
      runtimeKey: 'sk-amr_fallback',
      user: { name: 'Dev' },
    }, 'Dev')
    upstreamFetch = (async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/wallet/balance')) return Response.json({ error: 'billing unavailable' }, { status: 403 })
      if (url.endsWith('/billing/summary')) {
        return Response.json({
          balances: { totalAvailableCredits: '15000' },
          membershipTier: 'go',
          subscriptionStatus: 'active',
          totalAvailableCreditsUsd: '1.5000',
        })
      }
      throw new Error('unexpected upstream: ' + url)
    }) as unknown as typeof fetch
    const captured = await call({ url: '/opendesign/api/usage', method: 'POST', body: {} })
    expect(captured.status).toBe(200)
    const value = captured.body.value as {
      usage: { accounts: Array<{ ok: boolean; balanceUsd: string | null; error: string; billing?: { plan: string } }> }
    }
    // One surface refusing is not the reading failing: the summary's total is
    // the balance, and the wallet's refusal stays attached as diagnostics.
    expect(value.usage.accounts[0]).toMatchObject({ ok: true, balanceUsd: '1.5000' })
    expect(value.usage.accounts[0]!.billing).toMatchObject({ plan: 'go' })
    expect(value.usage.accounts[0]!.error).toContain('HTTP 403')
  })

  it('refuses the usage read plainly when no OAuth account exists', async () => {
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_x' }, 'pasted')
    const captured = await call({ url: '/opendesign/api/usage', method: 'POST', body: {} })
    expect(captured.status).toBe(400)
    expect(String(captured.body.error)).toContain('control key')
  })
})

describe('OpenDesign catalog metadata', () => {
  it('reads the AMR control-plane catalog with the control key and normalizes public ids', async () => {
    await pool.addAccount({
      kind: 'oauth',
      controlKey: 'vela_ctrl_meta',
      runtimeKey: 'sk-amr_chat',
      user: { name: 'Dev' },
    }, 'Dev')
    const seen: string[] = []
    upstreamFetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      seen.push(url)
      const auth = new Headers(init?.headers).get('authorization') ?? ''
      if (url.endsWith('/api/v1/models')) {
        // The control-plane spelling: public_model_* ids + metadata.contextWindowTokens.
        expect(auth).toBe('Bearer vela_ctrl_meta')
        return Response.json({
          source: 'remote',
          data: [
            { id: 'public_model_deepseek_v4_1_flash', metadata: { contextWindowTokens: 1_000_000 } },
            { id: 'public_model_claude_haiku_5_5', metadata: { contextWindowTokens: 1_500_000 } },
          ],
        })
      }
      if (url.endsWith('/v1/models')) {
        // The link gateway answers the runtime key with the plan's ids only.
        expect(auth).toBe('Bearer sk-amr_chat')
        return Response.json({ data: [{ id: 'deepseek-v4.1-flash' }] })
      }
      throw new Error('unexpected upstream: ' + url)
    }) as unknown as typeof fetch

    const captured = await call({ url: '/opendesign/api/catalog/refresh', method: 'POST', body: {} })
    expect(captured.status).toBe(200)
    const status = (captured.body.value as { status: OpenDesignWebStatus }).status
    const deepseek = status.models.find((model) => model.id === 'deepseek-v4.1-flash')!
    // The control-plane window (1M) and the shipped ladder both apply.
    expect(deepseek.contextWindow).toBe(1_000_000)
    expect(deepseek.hint).toContain('reasoning(4)')
    // An id the table does not know is still adopted, normalized onto itself.
    const haiku = status.models.find((model) => model.id === 'claude-haiku-5.5')!
    expect(haiku.contextWindow).toBe(1_500_000)
    expect(seen.some((url) => url.endsWith('/v1/models'))).toBe(true)
  })

  it('a refused control-plane read still lets the gateway listing sync', async () => {
    await pool.addAccount({ kind: 'oauth', controlKey: 'vela_ctrl_refused', runtimeKey: 'sk-amr_r', user: { name: 'D' } }, 'D')
    upstreamFetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/models')) return Response.json({ error: 'unauthenticated' }, { status: 401 })
      if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: 'kimi-k3', context_window: 2_000_000 }] })
      throw new Error('unexpected ' + url)
    }) as unknown as typeof fetch
    const captured = await call({ url: '/opendesign/api/catalog/refresh', method: 'POST', body: {} })
    expect(captured.status).toBe(200)
    const status = (captured.body.value as { status: OpenDesignWebStatus }).status
    expect(status.models.find((model) => model.id === 'kimi-k3')!.contextWindow).toBe(2_000_000)
  })
})