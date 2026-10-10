import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  KIMI_CODE_RETRY_POLICY_CONFIG,
  KimiCodeAdapter,
  accountLimitCooldownMs,
  classifyKimiFailure,
  resolveDefaultReasoningEffort,
} from '../src/host/kimi-code/adapter.ts'
import { FileCredentialStore, FileModelSettingsStore } from '../src/host/kimi-code/token-store.ts'
import type { KimiCodeAccountPool } from '../src/host/kimi-code/account-pool.ts'
import type { KimiCodeWire } from '../src/shared/kimi-code-contracts.ts'
import type { KimiCodeCatalogModel } from '../src/host/kimi-code/token-store.ts'
import { clearCachedCatalog } from '../src/host/kimi-code/client.ts'
import type { KimiCodeCredentials } from '../src/host/kimi-code/token-store.ts'
import type { AttachmentImageReader } from '../src/host/common/request-images.ts'

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
] satisfies KimiCodeCatalogModel[]

async function buildAdapter(options: {
  enabled?: boolean
  enabledModelIds?: string[]
  contextWindowOverrides?: Record<string, number>
  defaultReasoningEffort?: 'low' | 'high' | 'max' | 'none' | null
  creds?: KimiCodeCredentials
  fetchFn?: typeof fetch
  attachments?: AttachmentImageReader
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
    cacheTtl: null,
  })
  const adapter = new KimiCodeAdapter(store, modelSettings, undefined, {
    loadCatalog: async () => CATALOG,
    fetchFn: options.fetchFn,
    attachments: options.attachments,
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
    // Never retried against this account — and yet it IS this account's own
    // window, so the pool is still allowed to route the request elsewhere.
    expect(failure.accountScoped).toBe(true)
  })

  it('marks a plan refusal and ordinary back-pressure as not the account own', () => {
    // Rotating on either would spend the pool to learn the same answer twice.
    const entitlement = classifyKimiFailure(403, JSON.stringify({
      error: { message: 'Your current subscription does not have access to this model.' },
    }))
    expect(entitlement.accountScoped).toBe(false)

    const overloaded = classifyKimiFailure(429, JSON.stringify({ error: { message: 'too many requests' } }))
    expect(overloaded.accountScoped).toBe(false)

    const deadToken = classifyKimiFailure(401, JSON.stringify({ error: { message: 'Invalid Authentication' } }))
    expect(deadToken.accountScoped).toBe(false)

    // A spent balance is this account's own, and it does not lift when the
    // window turns over: the same account has to stop being asked.
    const spent = classifyKimiFailure(429, JSON.stringify({
      error: { message: 'insufficient balance, please recharge your account' },
    }))
    expect(spent.accountScoped).toBe(true)
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

describe('kimi account-limit cooldown', () => {
  const FIVE_HOURS = 5 * 60 * 60 * 1000

  it('falls back to the window length when the body states no reset time', () => {
    // The 15 minutes a 429 gets would put the account back into rotation four
    // times inside the very window that just refused it.
    expect(accountLimitCooldownMs("You've reached your 5-hour usage limit.")).toBe(FIVE_HOURS)
  })

  it('cools down until the reset instant the service states', () => {
    const now = Date.now()
    const resetsAt = now + 90 * 60 * 1000
    const body = JSON.stringify({ error: { message: 'usage limit reached', reset_at: Math.floor(resetsAt / 1000) } })
    // Unix seconds, so the stated instant may be up to a second behind.
    expect(Math.abs(accountLimitCooldownMs(body, now) - 90 * 60 * 1000)).toBeLessThan(1_000)
  })

  it('trusts a zoned instant and refuses to guess at an unqualified one', () => {
    const now = Date.parse('2026-09-04T10:00:00Z')
    expect(accountLimitCooldownMs('{"error":{"resetsAt":"2026-09-04T11:30:00Z"}}', now)).toBe(90 * 60 * 1000)
    // Without a zone the instant is local or UTC depending on the machine, and a
    // cooldown off by that offset is either hours long or already over.
    expect(accountLimitCooldownMs('{"error":{"resetsAt":"2026-09-04T11:30:00"}}', now)).toBe(FIVE_HOURS)
  })

  it('keeps a stale or absurd reset time from parking or releasing the account', () => {
    const now = Date.now()
    // A reset instant already in the past is stale, not "no cooldown at all".
    expect(accountLimitCooldownMs(JSON.stringify({ reset_at: Math.floor((now - 60_000) / 1000) }), now)).toBe(FIVE_HOURS)
    // Two seconds away is still a real window, so it gets the 429 floor.
    expect(accountLimitCooldownMs(JSON.stringify({ reset_at: Math.floor((now + 2_000) / 1000) }), now)).toBe(15 * 60 * 1000)
    // And a timestamp far past the horizon cannot park the account for years.
    expect(accountLimitCooldownMs(JSON.stringify({ reset_at: 99_999_999_999 }), now)).toBe(30 * 24 * 60 * 60 * 1000)
    expect(accountLimitCooldownMs('You have reached your usage limit for this billing cycle.')).toBe(30 * 24 * 60 * 60 * 1000)
  })
})

describe('KimiCodeAdapter upstream failures', () => {
  it('recovers the counted completion budget on a compaction request without changing messages', async () => {
    const { adapter } = await buildAdapter()
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(init!.body as string)
      bodies.push(body)
      if (bodies.length === 1) return new Response(JSON.stringify({ error: { message:
        "This model's maximum context length is 1048576 tokens. However, you requested 1059229 tokens (803229 in the messages, 256000 in the completion). Please reduce the length of the messages or completion.",
      } }), { status: 400 })
      return sseResponse([
        { choices: [{ delta: { content: 'checkpoint' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ])
    }))
    const chunks = await drain(adapter.stream(generateOptions('kimi-for-coding', {
      maxTokens: 256000, purpose: 'compaction',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'summarize history' }] }] as never,
    })))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(bodies).toHaveLength(2)
    expect(bodies[0]!.max_completion_tokens).toBe(256000)
    expect(bodies[1]!.max_completion_tokens).toBe(244323)
    expect({ ...bodies[1], max_completion_tokens: 256000 }).toEqual(bodies[0])
  })

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
      cacheTtl: null,
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
      cacheTtl: null,
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

// ---------------------------------------------------------------------------
// In-band stream errors
// ---------------------------------------------------------------------------

/**
 * The Anthropic wire, which reports a failure as an `error` EVENT.
 *
 * Selected exactly the way the service selects it: a live catalog entry that
 * declares the protocol. The OpenAI wire is this route's DEFAULT, so the plain
 * catalog the rest of this file uses already selects it, with no ceremony.
 */
// `protocol` is typed as a literal union, so the stub says `as const` rather
// than widening itself to string and failing the assignment.
const ANTHROPIC_CATALOG: KimiCodeCatalogModel[] = [
  { id: 'k3', name: 'K3', contextWindow: 262_144, protocol: 'anthropic' },
]
const MESSAGE_START = { type: 'message_start', message: { usage: { input_tokens: 1 } } }

/** The window an ordinary rate limit gets, and the one a spent window gets instead. */
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000
const SPENT_WINDOW_MS = 5 * 60 * 60 * 1000

/** The pool surface the adapter uses, recorded instead of persisted. */
class FakePool {
  readonly cooldowns: Array<{ id: string; ms: number; reason: string }> = []
  readonly authFailures: Array<{ id: string; reason: string }> = []

  async getEffectiveCredential() {
    return { account: { id: 'kc-1' }, credentials: credentials({ accessToken: 'at-1' }) }
  }

  async hasAnotherAvailableAccount(triedAccountIds: ReadonlySet<string>): Promise<boolean> {
    return !triedAccountIds.has('kc-1')
  }

  async markCooldown(id: string, ms: number, reason: string): Promise<void> {
    this.cooldowns.push({ id, ms, reason })
  }

  async markAuthFailed(id: string, reason: string): Promise<void> {
    this.authFailures.push({ id, reason })
  }
}

/**
 * An adapter whose one request answers 200 and then reports the failure.
 *
 * The wire is named rather than inferred because the two vocabularies state
 * the same failure differently - an `error` event on one, an `error` field on an
 * ordinary data frame on the other - and each test says which one it exercises.
 */
async function adapterFor(
  frames: unknown[],
  wire: KimiCodeWire = 'anthropic',
  pool?: FakePool,
): Promise<{ adapter: KimiCodeAdapter; calls: string[] }> {
  const store = new FileCredentialStore(tmp('kc-inband'))
  vi.spyOn(store, 'read').mockResolvedValue(credentials())
  const modelSettings = new FileModelSettingsStore(tmp('kc-inband-models'))
  vi.spyOn(modelSettings, 'read').mockResolvedValue({
    enabled: true,
    enabledModelIds: ['k3'],
    catalogModels: [],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
    cacheTtl: null,
  })
  const calls: string[] = []
  const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input))
    return sseResponse(frames)
  }) as unknown as typeof fetch
  return {
    adapter: new KimiCodeAdapter(store, modelSettings, undefined, {
      fetchFn,
      loadCatalog: async () => (wire === 'anthropic' ? ANTHROPIC_CATALOG : CATALOG),
    }, pool as unknown as KimiCodeAccountPool | undefined),
    calls,
  }
}

/** Drain one turn, returning the error that ended it and what it had emitted. */
async function streamOf(adapter: KimiCodeAdapter): Promise<{ error: unknown; chunks: StreamChunk[] }> {
  const chunks: StreamChunk[] = []
  try {
    for await (const chunk of adapter.stream(generateOptions('k3'))) chunks.push(chunk)
  } catch (error) {
    return { error, chunks }
  }
  throw new Error('expected the in-band error to end the stream')
}

// The resolved policy is a union, so the always-retry variant has no code list
// to read: narrow it the way every other test in this repo does.
const retryableCodes = (): readonly string[] => {
  const policy = new KimiCodeAdapter(new FileCredentialStore(tmp('kc-inband-policy'))).providerRetryPolicy()
  return policy.mode === 'normal' ? policy.retryableCodes : []
}

describe('kimi-code in-band stream errors on the Anthropic wire', () => {
  it('reclassifies a transient in-band failure while nothing has reached the caller', async () => {
    // The shape that ends a real turn: HTTP 200, message_start, then the
    // failure. The same overload sent as a 529 is a retryable SERVER, so the
    // in-band copy must not be the one that ends the turn on the first try.
    for (const [type, message, code] of [
      ['overloaded_error', 'Overloaded', 'SERVER'],
      ['api_error', 'Internal server error', 'SERVER'],
      ['rate_limit_error', "We're receiving too many requests", 'RATE_LIMIT'],
    ] as const) {
      const { adapter, calls } = await adapterFor([
        MESSAGE_START,
        { type: 'error', error: { type, message } },
      ], 'anthropic')
      const { error } = await streamOf(adapter)
      expect(error).toMatchObject({ code })
      // The provider's own diagnostic stays in the message, so the notice still
      // says what happened rather than becoming a bare code.
      expect((error as Error).message).toContain(message)
      expect(retryableCodes()).toContain(code)
      // No synthetic status: the response really was a 200, and attaching one
      // would misreport what the provider said.
      expect((error as { failure?: { status?: number } }).failure?.status).toBeUndefined()
      // Classified, not re-requested inside the stream. The harness retry
      // policy owns the repeat.
      expect(calls).toHaveLength(1)
    }
  })

  it('keeps the mapper verdict once a chunk has reached the caller', async () => {
    // A retry here would repeat 'partial' for the user and could re-run a tool
    // call the model already emitted.
    const { adapter, calls } = await adapterFor([
      MESSAGE_START,
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    ], 'anthropic')
    const { error, chunks } = await streamOf(adapter)
    expect(error).toMatchObject({ code: 'PROVIDER_ERROR' })
    expect(chunks.map((chunk) => chunk.type)).toContain('text-delta')
    expect(JSON.stringify(chunks)).toContain('partial')
    expect(calls).toHaveLength(1)
  })

  it('leaves a non-transient or unrecognized in-band type with the mapper verdict', async () => {
    // Nothing here has a status behind it, and inventing one would file an
    // unknown type as a retryable server error.
    for (const type of ['invalid_request_error', 'authentication_error', 'request_too_large', 'some_future_error']) {
      const { adapter, calls } = await adapterFor([
        MESSAGE_START,
        { type: 'error', error: { type, message: 'nope' } },
      ], 'anthropic')
      const { error } = await streamOf(adapter)
      expect(error).toMatchObject({ code: 'PROVIDER_ERROR' })
      expect(calls).toHaveLength(1)
    }
  })

  it('keeps the context-overflow verdict the mapper already typed', async () => {
    // That code is how the turn is compacted and recovered. A retryable code
    // would spend the budget on a request that cannot fit and lose the
    // recovery the harness performs on this verdict.
    const { adapter, calls } = await adapterFor([
      MESSAGE_START,
      { type: 'error', error: { type: 'api_error', message: "prompt is too long for this model's context" } },
    ], 'anthropic')
    const { error } = await streamOf(adapter)
    expect(error).toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED' })
    expect(calls).toHaveLength(1)
  })

  it('takes an in-band rate limit out of rotation so the retry lands elsewhere', async () => {
    const pool = new FakePool()
    const { adapter, calls } = await adapterFor([
      MESSAGE_START,
      { type: 'error', error: { type: 'rate_limit_error', message: "We're receiving too many requests" } },
    ], 'anthropic', pool)
    const { error } = await streamOf(adapter)
    expect(error).toMatchObject({ code: 'RATE_LIMIT' })
    // The body cannot be re-requested from here, but the evidence is the same
    // one a 429 carries, so the account leaves rotation the same way. The
    // harness retry is about to repeat this request, and repeating it against
    // the account that just refused fails identically.
    expect(pool.cooldowns).toEqual([
      { id: 'kc-1', ms: RATE_LIMIT_WINDOW_MS, reason: 'Kimi Code in-stream 429' },
    ])
    expect(pool.authFailures).toHaveLength(0)
    expect(calls).toHaveLength(1)
  })

  it('cools an account-scoped in-band limit for its own window and does not retry it', async () => {
    // The 429 rule this line already owns: a spent balance is not
    // back-pressure, so it takes the window's length instead of the 15
    // minutes, and no amount of retrying fills it.
    const pool = new FakePool()
    const { adapter, calls } = await adapterFor([
      MESSAGE_START,
      { type: 'error', error: { type: 'rate_limit_error', message: 'insufficient balance, please recharge your account' } },
    ], 'anthropic', pool)
    const { error } = await streamOf(adapter)
    expect(error).toMatchObject({ code: 'PROVIDER_ERROR' })
    expect(pool.cooldowns).toEqual([
      { id: 'kc-1', ms: SPENT_WINDOW_MS, reason: 'Kimi Code in-stream 429' },
    ])
    expect(calls).toHaveLength(1)
  })

  it('leaves the pool alone for an in-band failure every account shares', async () => {
    // Overload is not this account's property, so cooling one of them would
    // take the pool offline for a fault none of them caused.
    const pool = new FakePool()
    const { adapter, calls } = await adapterFor([
      MESSAGE_START,
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    ], 'anthropic', pool)
    const { error } = await streamOf(adapter)
    expect(error).toMatchObject({ code: 'SERVER' })
    expect(pool.cooldowns).toHaveLength(0)
    expect(pool.authFailures).toHaveLength(0)
    expect(calls).toHaveLength(1)
  })

  it('cools nothing for a plan-scoped in-band rate limit', async () => {
    // Every account of one plan is refused the same way, so this is a request
    // failure: rotating could not change it, and cooling the pool after it
    // would take accounts that could still answer offline.
    const pool = new FakePool()
    const { adapter, calls } = await adapterFor([
      MESSAGE_START,
      { type: 'error', error: { type: 'rate_limit_error', message: 'Your current plan does not have access to this model.' } },
    ], 'anthropic', pool)
    const { error } = await streamOf(adapter)
    expect(error).toMatchObject({ code: 'RATE_LIMIT' })
    expect(pool.cooldowns).toHaveLength(0)
    expect(calls).toHaveLength(1)
  })
})
// The DEFAULT wire, so this is the delivery most turns actually fail through.
describe('kimi-code in-band stream errors on the OpenAI wire', () => {
  it('reclassifies a transient in-band failure while nothing has reached the caller', async () => {
    // No catalog entry is needed to reach this wire: it is what every model id
    // resolves to unless a live listing says otherwise, so the failure arrives
    // on an ordinary data frame that happens to carry an `error`.
    for (const [inBand, code] of [
      [{ code: 'rate_limit_exceeded', message: "We're receiving too many requests" }, 'RATE_LIMIT'],
      [{ code: 'server_error', message: 'The engine is currently overloaded.' }, 'SERVER'],
      // No structured code at all: on some deployments the message text is the
      // only evidence there is, so the text alone has to carry the verdict.
      [{ message: 'Service is overloaded, try again shortly' }, 'SERVER'],
    ] as const) {
      const { adapter, calls } = await adapterFor([{ error: inBand }], 'openai')
      const { error } = await streamOf(adapter)
      expect(error).toMatchObject({ code })
      // The provider's own diagnostic stays in the message, so the notice still
      // says what happened rather than becoming a bare code.
      expect((error as Error).message).toContain(inBand.message)
      expect(retryableCodes()).toContain(code)
      // No synthetic status: the response really was a 200.
      expect((error as { failure?: { status?: number } }).failure?.status).toBeUndefined()
      // Classified, not re-requested inside the stream.
      expect(calls).toHaveLength(1)
    }
  })

  it('keeps the mapper verdict once a chunk has reached the caller', async () => {
    // A retry here would repeat 'partial' for the user and could re-run a tool
    // call the model already emitted.
    const { adapter, calls } = await adapterFor([
      { choices: [{ delta: { content: 'partial' } }] },
      { error: { code: 'server_error', message: 'Overloaded' } },
    ], 'openai')
    const { error, chunks } = await streamOf(adapter)
    expect(error).toMatchObject({ code: 'PROVIDER_ERROR' })
    expect(chunks.map((chunk) => chunk.type)).toContain('text-delta')
    expect(JSON.stringify(chunks)).toContain('partial')
    expect(calls).toHaveLength(1)
  })

  it('leaves an unrecognized in-band failure with the mapper verdict', async () => {
    // Nothing here names a transient failure, and inventing one would file an
    // unknown shape as a retryable server error.
    for (const inBand of [
      { message: 'nope' },
      { code: 'invalid_request_error', message: 'bad request' },
      { code: 'permission_error', message: 'the model is not available to this account' },
    ]) {
      const { adapter, calls } = await adapterFor([{ error: inBand }], 'openai')
      const { error } = await streamOf(adapter)
      expect(error).toMatchObject({ code: 'PROVIDER_ERROR' })
      expect(calls).toHaveLength(1)
    }
  })

  it('keeps the context-overflow verdict the mapper already typed', async () => {
    // The wire code alone would call this a server error, and the harness would
    // then retry a request that cannot fit - losing the compaction this verdict
    // exists to trigger.
    const { adapter, calls } = await adapterFor([
      { error: { code: 'internal_error', message: "prompt is too long for this model's context" } },
    ], 'openai')
    const { error } = await streamOf(adapter)
    expect(error).toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED' })
    expect(calls).toHaveLength(1)
  })

  it('takes an in-band rate limit out of rotation so the retry lands elsewhere', async () => {
    const pool = new FakePool()
    const { adapter, calls } = await adapterFor([
      { error: { code: 'rate_limit_exceeded', message: "We're receiving too many requests" } },
    ], 'openai', pool)
    const { error } = await streamOf(adapter)
    expect(error).toMatchObject({ code: 'RATE_LIMIT' })
    // The same rule the 429 response would have applied, reached off the code
    // rather than off a status this vocabulary never carries.
    expect(pool.cooldowns).toEqual([
      { id: 'kc-1', ms: RATE_LIMIT_WINDOW_MS, reason: 'Kimi Code in-stream 429' },
    ])
    expect(pool.authFailures).toHaveLength(0)
    expect(calls).toHaveLength(1)
  })

  it('keeps the mapper verdict for an in-band limit that names a spent balance', async () => {
    // A balance that is spent is not a rate limit: retrying it verbatim repeats a
    // refusal the user can only clear by topping up, and this line's HTTP path
    // already says so - a 429 whose body names an exhausted plan is
    // PROVIDER_ERROR, cools nothing, and is not retried. The in-band delivery
    // must reach that same verdict, which is why the shared helper asks the
    // line's own classifier instead of trusting the vocabulary heuristic: the
    // heuristic only says "worth retrying", and only the classifier knows this
    // one is not.
    const pool = new FakePool()
    const { adapter, calls } = await adapterFor([
      { error: { code: 'rate_limit_exceeded', message: 'insufficient balance, please recharge your account' } },
    ], 'openai', pool)
    const { error } = await streamOf(adapter)
    expect(error).toMatchObject({ code: 'PROVIDER_ERROR' })
    expect(pool.cooldowns).toHaveLength(0)
    expect(calls).toHaveLength(1)
  })

  it('leaves the pool alone for an in-band failure every account shares', async () => {
    // Overload is not this account's property, and the HTTP path leaves the pool
    // alone for every 5xx for the same reason.
    const pool = new FakePool()
    const { adapter, calls } = await adapterFor([
      { error: { code: 'server_error', message: 'The engine is currently overloaded.' } },
    ], 'openai', pool)
    const { error } = await streamOf(adapter)
    expect(error).toMatchObject({ code: 'SERVER' })
    expect(pool.cooldowns).toHaveLength(0)
    expect(pool.authFailures).toHaveLength(0)
    expect(calls).toHaveLength(1)
  })

  it('cools nothing for a plan-scoped in-band rate limit', async () => {
    // Every account of one plan is refused the same way, so this is a request
    // failure: rotating could not change it, and cooling the pool after it
    // would take accounts that could still answer offline.
    const pool = new FakePool()
    const { adapter, calls } = await adapterFor([
      { error: { code: 'rate_limit_exceeded', message: 'Your current plan does not have access to this model.' } },
    ], 'openai', pool)
    const { error } = await streamOf(adapter)
    expect(error).toMatchObject({ code: 'RATE_LIMIT' })
    expect(pool.cooldowns).toHaveLength(0)
    expect(calls).toHaveLength(1)
  })
})
describe('the body-fit loop gives up on the first turn it cannot improve', () => {
  it('does not report an omission it never performed', async () => {
    // One small image plus enough text to clear the 2 MB ceiling. The overflow is
    // wider than the image, so dropping it could never fit the request — the loop
    // has nothing to gain from a second turn.
    const image = new Uint8Array(64 * 1024)
    const fetchCalls: number[] = []
    const { adapter } = await buildAdapter({
      fetchFn: (async () => { fetchCalls.push(1); return sseResponse([]) }) as typeof fetch,
      // The branded attachment ids are irrelevant here: the reader only has to
      // hand back a payload of the stated size, which is what the budget measures.
      attachments: {
        readImage: async () => ({
          ref: { attachmentId: 'small', mediaType: 'image/png', bytes: image.length, width: 1, height: 1 },
          data: image,
        }),
        readImageRequest: async (ref: { attachmentId: string }) => ({
          attachment: { attachmentId: ref.attachmentId, mediaType: 'image/png', bytes: image.length, width: 1, height: 1 },
          variantId: 'v', data: image, mediaType: 'image/png', bytes: image.length,
          width: 1, height: 1, depth: 'uchar', space: 'srgb', hasAlpha: false,
        }),
      } as never,
    })

    const options = generateOptions(CATALOG[0].id, {
      messages: [
        { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'small', mediaType: 'image/png', bytes: image.length, width: 1, height: 1 } }] },
        { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(2_400_000) }] },
      ] as never,
    })

    // Refused before the request went out, which is the pre-existing behaviour.
    await expect(drain(adapter.stream(options))).rejects.toThrow(/Kimi Code rejected the request before sending/)
    // What matters is what it says: the image is still attached, and dropping all
    // of it could not have closed a gap wider than it is.
    await expect(drain(adapter.stream(options))).rejects.toThrow(/cannot fit this request/i)
    await expect(drain(adapter.stream(options))).rejects.not.toThrow(/Older images are omitted first/)
    expect(fetchCalls).toEqual([])
  })
})
