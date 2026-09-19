import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  KIMI_CODE_RETRY_POLICY_CONFIG,
  KimiCodeAdapter,
  classifyKimiFailure,
  resolveDefaultReasoningEffort,
} from '../src/host/kimi-code/adapter.ts'
import { FileCredentialStore, FileModelSettingsStore } from '../src/host/kimi-code/token-store.ts'
import { clearCachedCatalog } from '../src/host/kimi-code/client.ts'
import type { KimiCodeCredentials } from '../src/host/kimi-code/token-store.ts'

function tmp(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

function credentials(overrides: Partial<KimiCodeCredentials> = {}): KimiCodeCredentials {
  return {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    // Far enough out that the adapter never tries to refresh during a test.
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    expiresIn: 86_400,
    region: 'mainland-cn',
    oauthHost: 'https://auth.kimi.com',
    baseUrl: 'https://api.kimi.com/coding',
    ...overrides,
  }
}

const CATALOG = [
  { id: 'k3', name: 'K3', contextWindow: 262_144, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high' },
  { id: 'kimi-for-coding', name: 'Kimi for Coding', contextWindow: 1_048_576, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'max' },
]

async function buildAdapter(options: {
  enabled?: boolean
  enabledModelIds?: string[]
  contextWindowOverrides?: Record<string, number>
  defaultReasoningEffort?: 'low' | 'high' | 'max' | 'none' | null
  creds?: KimiCodeCredentials
} = {}) {
  const store = new FileCredentialStore(tmp('kc-cred'))
  vi.spyOn(store, 'read').mockResolvedValue(options.creds ?? credentials())
  vi.spyOn(store, 'write').mockResolvedValue(undefined)
  const modelSettings = new FileModelSettingsStore(tmp('kc-models'))
  vi.spyOn(modelSettings, 'read').mockResolvedValue({
    enabled: options.enabled !== false,
    enabledModelIds: options.enabledModelIds ?? CATALOG.map((model) => model.id),
    catalogModels: [],
    contextWindowOverrides: options.contextWindowOverrides ?? {},
    defaultReasoningEffort: options.defaultReasoningEffort ?? null,
  })
  const adapter = new KimiCodeAdapter(store, modelSettings, undefined, {
    loadCatalog: async () => CATALOG,
  })
  return { adapter, store, modelSettings }
}

function sseResponse(frames: unknown[]): Response {
  const bytes = new TextEncoder().encode(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''))
  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 5) controller.enqueue(bytes.slice(offset, offset + 5))
      controller.close()
    },
  }))
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function generateOptions(model: string, overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    model,
    messages: [{ role: 'user', content: 'hello' } as never],
    ...overrides,
  } as GenerateOptions
}

afterEach(() => {
  clearCachedCatalog()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('KimiCodeAdapter retry policy', () => {
  it('declares the bounded policy that covers upstream outages', async () => {
    const policy = (await buildAdapter()).adapter.providerRetryPolicy()
    expect(policy).toMatchObject({
      mode: 'normal',
      maxRetries: 3,
      retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
    })
    expect(KIMI_CODE_RETRY_POLICY_CONFIG.backoff).toEqual({
      initialDelayMs: 1_500,
      maxDelayMs: 15_000,
      jitterRatio: 0.2,
    })
  })

  it('classifies the documented upstream-unavailable 502 as a retryable server error', () => {
    // This is the exact body the service sends when the upstream model provider
    // is briefly unavailable, which is the case retries exist for.
    const body = JSON.stringify({
      error: {
        message: 'Upstream model provider is temporarily unavailable. Please try again in a moment.',
        type: 'server_error',
      },
    })
    const failure = classifyKimiFailure(502, body)
    expect(failure.code).toBe('SERVER')
    expect(failure.retryable).toBe(true)
    expect(failure.message).toContain('Upstream model provider is temporarily unavailable')
  })

  it('treats every other 5xx as retryable', () => {
    for (const status of [500, 503, 504]) {
      const failure = classifyKimiFailure(status, '')
      expect(failure.code).toBe('SERVER')
      expect(failure.retryable).toBe(true)
    }
  })

  it('retries ordinary 429 back-pressure and honors a provider delay', () => {
    const failure = classifyKimiFailure(429, JSON.stringify({
      error: { message: "We're receiving too many requests at the moment. Please wait a moment and try again." },
    }))
    expect(failure.code).toBe('RATE_LIMIT')
    expect(failure.retryable).toBe(true)
  })

  it('does NOT retry a 429 that reports a spent quota', () => {
    // Retrying cannot succeed until the account is topped up, so it must fail
    // fast and tell the user, not burn the retry budget.
    for (const message of [
      'You exceeded your current quota, please check your plan and billing details',
      'exceeded_current_quota_error',
      'insufficient balance, please recharge your account',
    ]) {
      const failure = classifyKimiFailure(429, JSON.stringify({ error: { message, type: 'exceeded_current_quota_error' } }))
      expect(failure.retryable).toBe(false)
      expect(failure.code).toBe('PROVIDER_ERROR')
    }
  })

  it('does NOT retry a 403 account limit and points at the reset', () => {
    const failure = classifyKimiFailure(403, JSON.stringify({
      error: { message: "You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends." },
    }))
    expect(failure.retryable).toBe(false)
    expect(failure.code).toBe('PROVIDER_ERROR')
    expect(failure.message).toContain('5-hour usage limit')
  })

  it('distinguishes a plan-entitlement 401 from a bad credential', () => {
    // The service returns 401 both for a dead token and for a plan that does not
    // include k3; only the latter should tell the user to switch models.
    const entitlement = classifyKimiFailure(401, JSON.stringify({
      error: { message: 'Your current subscription does not have access to k3. Upgrade to higher-tier Kimi Code plans.' },
    }))
    expect(entitlement.code).toBe('PROVIDER_ERROR')
    expect(entitlement.retryable).toBe(false)

    const badToken = classifyKimiFailure(401, JSON.stringify({ error: { message: 'Invalid Authentication' } }))
    expect(badToken.code).toBe('INVALID_CREDENTIAL')
    expect(badToken.retryable).toBe(false)
  })

  it('does not retry a 400 request-format error', () => {
    const failure = classifyKimiFailure(400, JSON.stringify({
      error: { message: 'Invalid request: total message size 5943865 exceeds limit 2097152' },
    }))
    expect(failure.code).toBe('PROVIDER_ERROR')
    expect(failure.retryable).toBe(false)
  })

  it('treats a membership-verification 402 as transient', () => {
    const failure = classifyKimiFailure(402, JSON.stringify({
      error: { message: "We're unable to verify your membership benefits at this time." },
    }))
    expect(failure.retryable).toBe(true)
  })
})

describe('KimiCodeAdapter upstream failures', () => {
  it('surfaces a 502 as a SERVER LlmError so DSH retries it', async () => {
    const { adapter } = await buildAdapter()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: {
        message: 'Upstream model provider is temporarily unavailable. Please try again in a moment.',
        type: 'server_error',
      },
    }), { status: 502 }))
    vi.stubGlobal('fetch', fetchMock)

    const failing = new KimiCodeAdapter(
      (adapter as never as { store: FileCredentialStore }).store,
      new FileModelSettingsStore(tmp('kc-models2')),
      undefined,
      { fetchFn: fetchMock as unknown as typeof fetch, loadCatalog: async () => CATALOG },
    )
    // Keep the settings store deterministic for this instance.
    vi.spyOn((failing as never as { modelSettings: FileModelSettingsStore }).modelSettings, 'read').mockResolvedValue({
      enabledModelIds: ['k3'],
      catalogModels: [],
      contextWindowOverrides: {},
      defaultReasoningEffort: null,
    })

    const stream = failing.stream(generateOptions('k3'))
    await expect(drain(stream)).rejects.toMatchObject({ code: 'SERVER' })
  })

  it('propagates a provider delay on a retryable 429', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: "We're receiving too many requests" } }),
      { status: 429, headers: { 'retry-after': '30' } },
    )) as unknown as typeof fetch
    const store = new FileCredentialStore(tmp('kc-cred-429'))
    vi.spyOn(store, 'read').mockResolvedValue(credentials())
    const modelSettings = new FileModelSettingsStore(tmp('kc-models-429'))
    vi.spyOn(modelSettings, 'read').mockResolvedValue({
      enabledModelIds: ['k3'], catalogModels: [], contextWindowOverrides: {}, defaultReasoningEffort: null,
    })
    const adapter = new KimiCodeAdapter(store, modelSettings, undefined, {
      fetchFn: fetchMock,
      loadCatalog: async () => CATALOG,
    })

    let caught: { code?: string; failure?: { status?: number; providerRetryAfterMs?: number } } | undefined
    try {
      await drain(adapter.stream(generateOptions('k3')))
    } catch (error) {
      caught = error as typeof caught
    }
    expect(caught).toBeDefined()
    expect(caught?.code).toBe('RATE_LIMIT')
    expect(caught?.failure?.status).toBe(429)
    // The provider-requested delay travels with the failure so the DSH retry
    // policy waits exactly as long as the service asked.
    expect(caught?.failure?.providerRetryAfterMs).toBe(30_000)
  })
})

describe('KimiCodeAdapter catalog and models', () => {
  it('lists only the enabled models from the live catalog', async () => {
    const { adapter } = await buildAdapter({ enabledModelIds: ['k3'] })
    const models = await adapter.listModels('kimi-code')
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({ provider: 'kimi-code', id: 'k3', name: 'K3' })
    expect(adapter.providerInfo('kimi-code')).toEqual({ id: 'kimi-code', name: 'Kimi Code' })
  })

  it('returns empty model list when disabled or enabledModelIds is empty', async () => {
    const { adapter: disabledAdapter } = await buildAdapter({ enabled: false, enabledModelIds: ['k3'] })
    expect(await disabledAdapter.listModels('kimi-code')).toEqual([])

    const { adapter: emptyAdapter } = await buildAdapter({ enabled: true, enabledModelIds: [] })
    expect(await emptyAdapter.listModels('kimi-code')).toEqual([])
  })

  it('resolves a model with its context override and configured thinking level', async () => {
    const { adapter } = await buildAdapter({
      contextWindowOverrides: { k3: 1_048_576 },
      defaultReasoningEffort: 'max',
    })
    const resolved = await adapter.resolveModel('kimi-code', 'k3')
    expect(resolved.context).toEqual({ contextWindow: 1_048_576 })
    // Video is a declared modality on this route, not display-only metadata.
    expect(resolved.inputModalities).toEqual(['text', 'image', 'video'])
    expect(resolved.reasoning?.efforts.map((effort) => effort.id)).toEqual(['low', 'high', 'max'])
    expect(resolved.reasoning?.defaultEffort).toBe('max')
  })

  it('falls back to the model default thinking level when none is configured', async () => {
    const { adapter } = await buildAdapter({ enabledModelIds: ['k3'] })
    const resolved = await adapter.resolveModel('kimi-code', 'k3')
    expect(resolved.reasoning?.defaultEffort).toBe('high')
  })

  it('exposes only the levels a model actually accepts', () => {
    const efforts = ['low', 'high', 'max']
    expect(resolveDefaultReasoningEffort(efforts, 'max')).toBe('max')
    // A level the model does not accept must not be sent, because the service
    // answers an unmapped effort with HTTP 400.
    expect(resolveDefaultReasoningEffort(efforts, 'minimal')).toBeUndefined()
    expect(resolveDefaultReasoningEffort(efforts, null)).toBeUndefined()
  })
})
