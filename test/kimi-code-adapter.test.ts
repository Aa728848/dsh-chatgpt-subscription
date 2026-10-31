import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  COLD_START_WARMUP_WAIT_MS,
  KIMI_CODE_RETRY_POLICY_CONFIG,
  KimiCodeAdapter,
  accountLimitCooldownMs,
  classifyKimiFailure,
  resetColdStartSingleflightForTests,
  resolveDefaultReasoningEffort,
} from '../src/host/kimi-code/adapter.ts'
import { sessionCacheState } from '../src/host/kimi-code/session-cache-state.ts'
import {
  buildRequest,
  getLastDriftCause,
  isSideChannelTitleRequest,
  markPendingImageOffload,
  resetCacheStats,
} from '../src/host/kimi-code/mapper.ts'
import { resetSessionActivity, sessionLastActiveAt } from '../src/host/kimi-code/cache-hint.ts'
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
  catalog?: KimiCodeCatalogModel[]
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
    loadCatalog: async () => options.catalog ?? CATALOG,
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

  it('files an overloaded 429 as a retryable server error and never as this account fault', () => {
    // The exact body a real turn failed on: status 429, but the sentence names
    // the engine rather than the account. Read as back-pressure it became a
    // 15-minute cooldown on the only account in the pool, after which every
    // harness retry was refused by isEligible before a request was ever sent.
    for (const message of [
      'The engine is currently overloaded, please try again later.',
      'the engine is overloaded',
      'Service is overloaded, try again shortly',
      'Our servers are currently overloaded. Please try again later.',
      'Upstream model provider is temporarily unavailable. Please try again in a moment.',
    ]) {
      const failure = classifyKimiFailure(429, JSON.stringify({ error: { message, type: 'server_error' } }))
      // SERVER and RATE_LIMIT are both in this route's retryable set, so the
      // bounded backoff still runs either way; SERVER is the code that does not
      // tell the pool (or the user) that an account was limited.
      expect(failure.code).toBe('SERVER')
      expect(failure.retryable).toBe(true)
      expect(failure.accountScoped).toBe(false)
      // The field the pool branch actually reads: true here, false for real
      // back-pressure. Without it the status code is all the pool has, and that
      // is the whole bug.
      expect(failure.upstreamOverload).toBe(true)
    }
  })

  it('keeps a genuine 429 back-pressure an ordinary rate limit', () => {
    // The other half of the same 429: this one IS about the account, so it
    // keeps cooling it and rotating away from it.
    for (const message of [
      'too many requests',
      "We're receiving too many requests at the moment. Please wait a moment and try again.",
    ]) {
      const failure = classifyKimiFailure(429, JSON.stringify({ error: { message } }))
      expect(failure.code).toBe('RATE_LIMIT')
      expect(failure.upstreamOverload).toBe(false)
    }
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
      error: { message: 'Invalid request: unsupported value for messages[0].role' },
    }))
    expect(failure.code).toBe('PROVIDER_ERROR')
    expect(failure.retryable).toBe(false)
  })

  it('files the gateway 2 MB refusal as a context overflow rather than a dead end', () => {
    // The body a long session actually gets back. It used to be classified as a
    // plain 400, which DSH does not recover from: the turn ended and the
    // conversation that caused it was never compacted. CONTEXT_WINDOW_EXCEEDED
    // is the only code the host runs its forced compaction on, and compaction is
    // what shrinks a body, so the byte refusal belongs there.
    const failure = classifyKimiFailure(400, JSON.stringify({
      error: { message: 'Invalid request: total message size 5943865 exceeds limit 2097152' },
    }))
    expect(failure.code).toBe('CONTEXT_WINDOW_EXCEEDED')
    // Not retried either: the same bytes would be refused again. The recovery is
    // the compaction-then-retry the host performs, not a blind backoff.
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
    // The override IS the window: folding against the 2 MB byte ceiling is opt-in
    // (DSH_KIMI_CODE_BYTES_PER_TOKEN), so by default the 1M this user chose is
    // published as 1M — the number the settings card shows and the harness
    // computes its compaction threshold from. A session that outgrows the wire is
    // recovered at the wall (CONTEXT_OVERFLOW_CODE), not pre-emptively summarized.
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

  it('orders a live ladder by reasoning strength without changing its default', async () => {
    const { adapter } = await buildAdapter({
      catalog: [{
        ...CATALOG[0]!,
        reasoningEfforts: ['low', 'high', 'none'],
        defaultReasoningEffort: 'high',
        thinkingType: 'both',
      }],
    })

    const resolved = await adapter.resolveModel('kimi-code', 'k3')
    expect(resolved.reasoning?.efforts.map((effort) => effort.id)).toEqual(['none', 'low', 'high'])
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
  /** A body of the test's own, for a failure no frame can express. */
  response?: Response,
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
  })
  const calls: string[] = []
  const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input))
    return response ?? sseResponse(frames)
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
async function streamOf(adapter: KimiCodeAdapter, signal?: AbortSignal): Promise<{ error: unknown; chunks: StreamChunk[] }> {
  const chunks: StreamChunk[] = []
  try {
    for await (const chunk of adapter.stream(generateOptions('k3', signal === undefined ? {} : { signal }))) chunks.push(chunk)
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

/**
 * The exact shape undici throws when a connection dies mid-body: a bare
 * `TypeError: terminated` that names no code, with the real reason — the reset,
 * the far-side close, the body timeout — only on `cause`. DSH persists only
 * `{message, code}`, so an untyped value used to reach the user as the bare word
 * `terminated` filed under UNKNOWN, which this route never retries.
 *
 * `onSevered` runs at the moment the body dies, so a caller abort can be timed
 * to the read that fails.
 */
function severedResponse(frames: unknown[], cause: unknown, onSevered?: () => void): Response {
  const encoder = new TextEncoder()
  let sent = 0
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent < frames.length) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frames[sent++])}\n\n`))
        return
      }
      onSevered?.()
      controller.error(new TypeError('terminated', { cause }))
    },
  }), { headers: { 'content-type': 'text/event-stream' } })
}

/** Enough frames for a text delta to reach the caller before the body dies. */
const PARTIAL_ANSWER = [
  MESSAGE_START,
  { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
]

describe('kimi-code severed streams', () => {
  it('reports a body that dies mid-stream as a transport failure that keeps its cause', async () => {
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    const { adapter, calls } = await adapterFor([], 'anthropic', undefined, severedResponse(PARTIAL_ANSWER, reset))

    const { error, chunks } = await streamOf(adapter)

    // The delta reaches the caller first: the connection dies with output already
    // on the wire, which is the shape a long turn actually fails in.
    expect(JSON.stringify(chunks)).toContain('partial')
    // TRANSPORT, not UNKNOWN: UNKNOWN is absent from this route's retryable
    // codes, which is what let one dropped connection end the turn outright.
    expect(error).toMatchObject({ code: 'TRANSPORT' })
    // The cause survives into the persisted message, so the report says what
    // happened instead of only that the body ended.
    expect((error as Error).message).toContain('terminated')
    expect((error as Error).message).toContain('ECONNRESET')
    expect(retryableCodes()).toContain('TRANSPORT')
    // Classified, not re-requested inside the stream. The harness retry policy
    // owns the repeat.
    expect(calls).toHaveLength(1)
  })

  it('leaves a caller abort reported as an abort rather than a transport fault', async () => {
    const caller = new AbortController()
    const { adapter } = await adapterFor(
      [],
      'anthropic',
      undefined,
      severedResponse(PARTIAL_ANSWER, new Error('other side closed'), () => caller.abort()),
    )
    const { error } = await streamOf(adapter, caller.signal)
    expect(error).toMatchObject({ code: 'ABORTED' })
  })

  it('reports a stream that ends without its terminal event as retryable too', async () => {
    // The sibling shape: the connection closes cleanly, but no message_stop ever
    // arrives, so what came back is half an answer.
    const { adapter } = await adapterFor(PARTIAL_ANSWER, 'anthropic')
    const { error, chunks } = await streamOf(adapter)
    expect(JSON.stringify(chunks)).toContain('partial')
    expect(error).toMatchObject({ code: 'TRANSPORT' })
    expect((error as Error).message).toContain('before its terminal event')
    expect(retryableCodes()).toContain('TRANSPORT')
  })
})

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
    //
    // The 256K tier is named deliberately: 2.4 MB clears its 2 MB ceiling, while
    // the 1M tier raised its own to 12 MiB and would accept this body. The loop
    // behaviour under test does not depend on which tier supplied the ceiling.
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

    const options = generateOptions('k3-256k', {
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

describe('the Kimi Code side-channel title request', () => {
  beforeEach(() => {
    resetColdStartSingleflightForTests()
    resetSessionActivity()
    resetCacheStats()
  })

  afterEach(() => {
    resetColdStartSingleflightForTests()
    resetCacheStats()
  })

  it('files nothing under the conversation it titles', async () => {
    const { adapter } = await buildAdapter({
      fetchFn: (async () => sseResponse([
        { choices: [{ delta: { content: 'hello' } }] },
        {
          choices: [{ delta: {}, finish_reason: 'stop' }],
          // A near-total cache hit, so the conversation earns a warmup streak
          // the title request would destroy if it filed its own usage.
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 4,
            prompt_tokens_details: { cached_tokens: 980 },
          },
        },
      ])) as typeof fetch,
    })
    const sessionId = 'kc-side-channel'
    await drain(adapter.stream(generateOptions('k3', {
      sessionId: sessionId as never,
      system: 'the conversation system prompt',
    })))

    const afterConversation = sessionCacheState.read(sessionId)
    expect(afterConversation?.requests).toBe(1)
    expect(afterConversation?.warmupConsecutiveHits).toBe(1)
    const activeAfterConversation = sessionLastActiveAt(sessionId)
    expect(activeAfterConversation).toBeTypeOf('number')

    // The title request: the same session id, a different conversation.
    await drain(adapter.stream(generateOptions('k3', {
      sessionId: sessionId as never,
      system: 'Create a concise title for an AI coding-assistant session',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'Generate the session title from this JSON array of human messages: []' }],
      }] as never,
    })))

    const afterTitle = sessionCacheState.read(sessionId)
    // The title request must not have touched the session's numbers, its drift
    // attribution, its warmup streak or its activity timestamp.
    expect(afterTitle?.requests).toBe(1)
    expect(afterTitle?.cachedTokens).toBe(afterConversation?.cachedTokens)
    expect(afterTitle?.lastActiveAt).toBe(afterConversation?.lastActiveAt)
    expect(afterTitle?.lastDrift).toBe(afterConversation?.lastDrift)
    expect(afterTitle?.warmupConsecutiveHits).toBe(1)
    expect(sessionLastActiveAt(sessionId)).toBe(activeAfterConversation)
  })

  it('does not classify a tool result containing the title prompt as a title request', () => {
    const options = generateOptions('k3', {
      messages: [{
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1',
          content: [{
            type: 'text',
            text: 'Generate the session title from this JSON array of human messages: this is quoted evidence',
          }],
        }],
      }] as never,
      tools: [{ name: 'run_code', description: 'runs code', parameters: { type: 'object' } }] as never,
    })
    expect(isSideChannelTitleRequest(options as never)).toBe(false)
  })

  it('does not let a title request clear the conversation pending image-offload attribution', async () => {
    const sessionId = 'kc-title-image-race'
    const conversation = generateOptions('k3', {
      sessionId: sessionId as never,
      system: 'the conversation system prompt',
    })
    buildRequest(conversation as never, 'openai')
    // Simulates the main turn having dropped an image and then pausing before
    // its body build while the title request runs on the same session id.
    markPendingImageOffload(sessionId, 1)

    const { adapter } = await buildAdapter({
      fetchFn: (async () => sseResponse([
        { choices: [{ delta: { content: 'title' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ])) as typeof fetch,
    })
    await drain(adapter.stream(generateOptions('k3', {
      sessionId: sessionId as never,
      system: 'Create a concise title for an AI coding-assistant session',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'Generate the session title from this JSON array of human messages: []' }],
      }] as never,
    })))

    buildRequest(conversation as never, 'openai')
    expect(getLastDriftCause(sessionId)).toBe('image-offload')
  })
})

describe('the Kimi Code cold-start singleflight', () => {
  beforeEach(() => {
    resetColdStartSingleflightForTests()
  })

  afterEach(() => {
    resetColdStartSingleflightForTests()
  })

  /**
   * Wait until the predicate holds.
   *
   * @param predicate - The condition to wait for.
   * @param timeoutMs - How long to wait before giving up.
   */
  async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the condition')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  it('staggers a cold-start follower behind the leader, and sends the next request out with no wait', async () => {
    const gates: Array<Promise<void>> = []
    let calls = 0
    const fetchFn = vi.fn(async () => {
      const index = calls
      calls += 1
      const gate = gates[index]
      if (gate !== undefined) await gate
      return sseResponse([
        { choices: [{ delta: { content: 'hi' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ])
    }) as unknown as typeof fetch
    const { adapter } = await buildAdapter({ fetchFn })

    const system = 'a shared conversation system prompt'
    let releaseLeader: (() => void) | undefined
    gates[0] = new Promise<void>((resolve) => { releaseLeader = resolve })

    const leader = drain(adapter.stream(generateOptions('k3', { sessionId: 'kc-cold-a' as never, system })))
    await waitUntil(() => calls === 1)

    // The follower shares the prefix, so it waits for the leader instead of
    // starting a second cold request of its own.
    const follower = drain(adapter.stream(generateOptions('k3', { sessionId: 'kc-cold-b' as never, system })))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(calls).toBe(1)

    // The leader reaches the response headers: the follower may go now.
    releaseLeader!()
    await Promise.all([leader, follower])
    expect(calls).toBe(2)

    // The prefix is warm. Neither of the next two requests waits behind a
    // leader, because a warm prefix starts no leader at all.
    let releaseWarm: (() => void) | undefined
    gates[2] = new Promise<void>((resolve) => { releaseWarm = resolve })
    const warm = drain(adapter.stream(generateOptions('k3', { sessionId: 'kc-cold-c' as never, system })))
    await waitUntil(() => calls === 3)
    const warmFollower = drain(adapter.stream(generateOptions('k3', { sessionId: 'kc-cold-d' as never, system })))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(calls).toBe(4)
    releaseWarm!()
    await Promise.all([warm, warmFollower])
  })

  it('gives the follower up after the wait budget when the leader never answers', async () => {
    const gates: Array<Promise<void>> = []
    let calls = 0
    const fetchFn = vi.fn(async () => {
      const index = calls
      calls += 1
      const gate = gates[index]
      if (gate !== undefined) await gate
      return sseResponse([
        { choices: [{ delta: { content: 'hi' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ])
    }) as unknown as typeof fetch
    const { adapter } = await buildAdapter({ fetchFn })

    const system = 'a shared conversation system prompt'
    let releaseLeader: (() => void) | undefined
    gates[0] = new Promise<void>((resolve) => { releaseLeader = resolve })

    const leader = drain(adapter.stream(generateOptions('k3', { sessionId: 'kc-timeout-a' as never, system })))
    await waitUntil(() => calls === 1)

    const started = Date.now()
    const follower = drain(adapter.stream(generateOptions('k3', { sessionId: 'kc-timeout-b' as never, system })))
    await waitUntil(() => calls === 2, COLD_START_WARMUP_WAIT_MS + 3_000)
    // The follower waited out the budget and then sent its own request.
    expect(Date.now() - started).toBeGreaterThanOrEqual(COLD_START_WARMUP_WAIT_MS - 100)
    expect(calls).toBe(2)

    releaseLeader!()
    await Promise.all([leader, follower])
  }, 20_000)

  it('re-elects a leader after a hung leader exceeds the wait budget', async () => {
    const gates: Array<Promise<void>> = []
    let calls = 0
    const fetchFn = vi.fn(async () => {
      const index = calls
      calls += 1
      const gate = gates[index]
      if (gate !== undefined) await gate
      return sseResponse([
        { choices: [{ delta: { content: 'hi' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ])
    }) as unknown as typeof fetch
    const { adapter } = await buildAdapter({ fetchFn })

    const system = 'a shared conversation system prompt'
    let releaseHungLeader: (() => void) | undefined
    gates[0] = new Promise<void>((resolve) => { releaseHungLeader = resolve })
    const hungLeader = drain(adapter.stream(generateOptions('k3', { sessionId: 'kc-stale-a' as never, system })))
    await waitUntil(() => calls === 1)

    // The first follower sends after the wait budget, while the original
    // leader is still stuck before its response headers.
    const follower = drain(adapter.stream(generateOptions('k3', { sessionId: 'kc-stale-b' as never, system })))
    await waitUntil(() => calls === 2, COLD_START_WARMUP_WAIT_MS + 3_000)
    await follower

    // Once the old leader is beyond the same budget, the next request must be
    // allowed to lead immediately instead of paying another follower wait.
    let releaseNewLeader: (() => void) | undefined
    gates[2] = new Promise<void>((resolve) => { releaseNewLeader = resolve })
    const newLeader = drain(adapter.stream(generateOptions('k3', { sessionId: 'kc-stale-c' as never, system })))
    await waitUntil(() => calls === 3, COLD_START_WARMUP_WAIT_MS - 100)
    releaseNewLeader!()
    await newLeader

    releaseHungLeader!()
    await hungLeader
  }, 20_000)
})
