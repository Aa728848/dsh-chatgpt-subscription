/**
 * Tests for the Claude subscription adapter.
 *
 * Each test is named after the property it protects rather than the function it
 * calls. The properties below are the ones a plausible implementation gets wrong
 * in a way no type checker can see:
 *
 *   1. NO ROTATION AFTER OUTPUT. A retried request would repeat text the user has
 *      already read and re-issue a tool call that may already have run, so the
 *      refusal has to be observable as "exactly one request was issued".
 *   2. ONLY AN ACCOUNT-SCOPED LIMIT ROTATES. A global limit is shared by every
 *      account behind the same gateway; rotating against it burns the pool.
 *   3. THE EFFORT LADDER PASSES THROUGH UNCONVERGED. 'xhigh' is a real rung on
 *      this route, and a convergence table would silently collapse it.
 *   4. ONE TOOL-NAME TABLE FOR BOTH DIRECTIONS. The body renames a tool to its
 *      canonical wire spelling and the response side maps it back; two
 *      independently built tables would dispatch a call to the wrong tool.
 *   5. A CLIENT-VERSION REJECTION IS NOT A CREDENTIAL FAILURE. It must not sign
 *      the user out.
 *   6. A VERSION BELOW A MODEL'S FLOOR IS REFUSED LOCALLY, BEFORE THE REQUEST.
 *      Upstream answers it with an opaque 400 about a version that is our own
 *      claim echoed back, which reads like a credential problem; the catalog
 *      records the floor, so the same verdict is produced here, naming the model,
 *      both versions and the remedy, with no request spent.
 *
 * Everything runs against an injected fetch and an in-memory encrypted
 * credential backend. No test here touches the network or a platform credential
 * store.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  ClaudeAdapter,
  assertClaudeCliVersionMeetsFloor,
  codeForFailure,
  cooldownMsFor,
  resolveDefaultReasoningEffort,
  shouldRotateAccount,
  type ClaudeAccountPoolLike,
} from '../src/host/claude/adapter.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  type ClaudeCredentialDocument,
  type ClaudeCredentials,
} from '../src/host/claude/token-store.ts'
import {
  FALLBACK_MODELS,
  DEFAULT_VISIBLE_MODEL_IDS,
  type ClaudeModelEntry,
} from '../src/host/claude/model-catalog.ts'
import {
  API_BASE,
  CLAUDE_CLI_VERSION,
  MESSAGES_PATH,
  PROVIDER_ID,
  claudeCliVersion,
  setClaudeCliVersion,
} from '../src/host/claude/types.ts'
import { classifyFailure } from '../src/host/claude/client.ts'
import type { CredentialStore } from '../src/host/token-store.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const temporaryDirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirs.splice(0).map(async (dir) => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }))
})

/** In-memory encrypted backend, so no test reaches a platform credential store. */
function memoryBackend<T>(): CredentialStore<T> {
  let value: T | null = null
  return {
    async load() { return value },
    async save(next) { value = next },
    async clear() { value = null },
  }
}

async function scratchDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-adapter-'))
  temporaryDirs.push(dir)
  return dir
}

/** A credential far from expiry, so the single-credential path never refreshes. */
function credentials(accessToken: string, overrides: Partial<ClaudeCredentials> = {}): ClaudeCredentials {
  return {
    accessToken,
    refreshToken: 'refresh-' + accessToken,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    scopes: ['user:inference', 'user:profile'],
    account: { uuid: 'uuid-' + accessToken },
    ...overrides,
  }
}

interface Mounted {
  store: FileCredentialStore
  settings: FileModelSettingsStore
}

/** A credential store holding one account, and a settings file beside it. */
async function mount(overrides: Partial<ClaudeCredentials> = {}): Promise<Mounted> {
  const dir = await scratchDir()
  const store = new FileCredentialStore(
    path.join(dir, 'credentials.json'),
    memoryBackend<ClaudeCredentialDocument>(),
  )
  await store.saveAccount(credentials('ACCESS-1', overrides))
  return { store, settings: new FileModelSettingsStore(path.join(dir, 'models.json')) }
}

interface FetchCall {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** A recording fetch. Headers are read through a real Headers object. */
function recordingFetch(respond: (call: FetchCall, index: number) => Response | Promise<Response>) {
  const calls: FetchCall[] = []
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers((init?.headers ?? {}) as HeadersInit)
    const flat: Record<string, string> = {}
    headers.forEach((value, key) => { flat[key] = value })
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: flat,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {},
    }
    calls.push(call)
    return respond(call, calls.length - 1)
  })
  return { fn: fn as unknown as typeof fetch, calls, mock: fn }
}

/** One SSE body from a list of event payloads. */
function sse(frames: unknown[]): string {
  return frames.map((frame) => 'data: ' + JSON.stringify(frame) + '\n\n').join('')
}

const MESSAGE_START = { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 7 } } }
const MESSAGE_STOP = { type: 'message_stop' }

/** A complete, well-formed text answer. */
function answerResponse(text = 'hi'): Response {
  return new Response(sse([
    MESSAGE_START,
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'message_stop' },
  ]), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function streamResponse(frames: unknown[]): Response {
  return new Response(sse(frames), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function errorResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function options(model = 'claude-sonnet-4-6', overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: PROVIDER_ID,
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    ...overrides,
  } as GenerateOptions
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** Collect the error one stream throws, or fail the test if it completes. */
async function failureOf(stream: AsyncIterable<StreamChunk>): Promise<unknown> {
  try {
    await drain(stream)
  } catch (error) {
    return error
  }
  throw new Error('expected the stream to fail')
}

function makeAdapter(
  store: FileCredentialStore,
  settings: FileModelSettingsStore,
  fetchFn: typeof fetch,
  extra: { accountPool?: ClaudeAccountPoolLike; loadCatalog?: () => Promise<never[]> } = {},
): ClaudeAdapter {
  return new ClaudeAdapter(store, settings, undefined, {
    fetchFn,
    loadCatalog: extra.loadCatalog ?? (async () => FALLBACK_MODELS as never[]),
    ...(extra.accountPool === undefined ? {} : { accountPool: extra.accountPool }),
  })
}

/** A pool double whose availability is purely a function of the tried set. */
class FakePool implements ClaudeAccountPoolLike {
  readonly cooldowns: Array<{ id: string; ms: number; reason: string }> = []
  readonly authFailures: Array<{ id: string; reason: string }> = []

  constructor(private readonly accounts: Array<{ id: string; credentials: ClaudeCredentials }>) {}

  async getEffectiveAccount(excludeIds?: ReadonlySet<string>) {
    const account = this.accounts.find((candidate) => !(excludeIds?.has(candidate.id) ?? false))
    if (account === undefined) throw new Error('no eligible account')
    return { account: { id: account.id }, credentials: account.credentials }
  }

  async hasAnotherAvailableAccount(triedAccountIds: ReadonlySet<string>): Promise<boolean> {
    return this.accounts.some((account) => !triedAccountIds.has(account.id))
  }

  async markCooldown(accountId: string, durationMs: number, reason: string): Promise<void> {
    this.cooldowns.push({ id: accountId, ms: durationMs, reason })
  }

  async markAuthFailed(accountId: string, reason: string): Promise<void> {
    this.authFailures.push({ id: accountId, reason })
  }
}

/** The unified rate-limit headers that make a 429 account-scoped. */
const ACCOUNT_SCOPED_429 = { 'anthropic-ratelimit-unified-5h-utilization': '1' }

// ---------------------------------------------------------------------------
// Route metadata
// ---------------------------------------------------------------------------

describe('claude adapter route metadata', () => {
  it('describes the route and pins the shared bounded retry policy', async () => {
    const { store, settings } = await mount()
    const adapter = makeAdapter(store, settings, vi.fn() as unknown as typeof fetch)
    expect(adapter.providerInfo(PROVIDER_ID)).toEqual({ id: PROVIDER_ID, name: 'Claude（订阅）' })
    // The resolved policy is FLAT: resolveRetryPolicy spreads the backoff fields
    // onto the policy itself rather than nesting them under `backoff` (which is
    // only the *config* shape).
    expect(adapter.providerRetryPolicy()).toEqual({
      mode: 'normal',
      maxRetries: 3,
      retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
      initialDelayMs: 1_500,
      maxDelayMs: 15_000,
      jitterRatio: 0.2,
    })
    // The subscription bills in windows, not per image, so no per-image price is
    // claimed; the harness's neutral estimate is the honest answer.
    expect(adapter.imageRequestPricing()).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Catalog and model resolution
// ---------------------------------------------------------------------------

describe('claude adapter catalog', () => {
  it('lists nothing while the route is disabled', async () => {
    const { store, settings } = await mount()
    await settings.updateSettings({ enabled: false })
    const adapter = makeAdapter(store, settings, vi.fn() as unknown as typeof fetch)
    expect(await adapter.listModels()).toEqual([])
  })

  it('treats an untouched shipped default as everything the account can call', async () => {
    const { store, settings } = await mount()
    // The shipped default is exactly what defaultClaudeSettings writes.
    expect((await settings.read()).enabledModelIds).toEqual([...DEFAULT_VISIBLE_MODEL_IDS])
    const adapter = makeAdapter(store, settings, vi.fn() as unknown as typeof fetch)
    const models = await adapter.listModels()
    // Every catalog entry is offered, including ones the shipped default does
    // not name, because an unedited default cannot know about a newer model.
    expect(models.map((model) => model.id)).toEqual(FALLBACK_MODELS.map((model) => model.id))
    expect(models.length).toBeGreaterThan(DEFAULT_VISIBLE_MODEL_IDS.length)
    const haiku = models.find((model) => model.id === 'claude-haiku-4-5')!
    expect(haiku.inputModalities).toEqual(['text', 'image'])
    // No description: a second line here would show for this route alone.
    expect('description' in haiku).toBe(false)
  })

  it('honours an explicit selection exactly', async () => {
    const { store, settings } = await mount()
    await settings.updateSettings({ enabledModelIds: ['claude-opus-5', 'not-a-model'] })
    const adapter = makeAdapter(store, settings, vi.fn() as unknown as typeof fetch)
    expect((await adapter.listModels()).map((model) => model.id)).toEqual(['claude-opus-5'])
  })
})

describe('claude adapter model resolution', () => {
  it('passes the effort ladder through unconverged, xhigh included', async () => {
    const { store, settings } = await mount()
    const adapter = makeAdapter(store, settings, vi.fn() as unknown as typeof fetch)
    const resolved = await adapter.resolveModel(PROVIDER_ID, 'claude-opus-4-7')
    // 'xhigh' is a real rung on this model. A convergence table — the sibling
    // lines' answer for providers whose vocabulary is narrower — would collapse
    // it onto 'high' and advertise a distinction the model does not have.
    expect(resolved.reasoning?.efforts.map((effort) => String(effort.id)))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(resolved.reasoning?.efforts.at(-2)?.id).toBe('xhigh')
    expect(resolved.reasoning?.efforts.at(-1)?.id).toBe('max')
    expect(resolved.reasoning?.efforts.at(-2)?.name).toBe('xhigh')
    expect(resolved.defaultMaxTokens).toBe(128_000)
    expect(resolved.context?.contextWindow).toBe(1_000_000)
  })

  it('offers no reasoning block on a model with no ladder, and a stub claims nothing', async () => {
    const { store, settings } = await mount()
    const adapter = makeAdapter(store, settings, vi.fn() as unknown as typeof fetch)
    const unknown = await adapter.resolveModel(PROVIDER_ID, 'claude-unreleased-9')
    expect(unknown.reasoning).toBeUndefined()
    expect(unknown.inputModalities).toEqual(['text'])
    expect(unknown.context?.contextWindow).toBe(200_000)
  })

  it('prefers a finite positive context override and ignores a broken one', async () => {
    const { store, settings } = await mount()
    await settings.updateSettings({
      contextWindowOverrides: { 'claude-sonnet-4-6': 500_000, 'claude-haiku-4-5': 0 },
    })
    const adapter = makeAdapter(store, settings, vi.fn() as unknown as typeof fetch)
    expect((await adapter.resolveModel(PROVIDER_ID, 'claude-sonnet-4-6')).context?.contextWindow).toBe(500_000)
    expect((await adapter.resolveModel(PROVIDER_ID, 'claude-haiku-4-5')).context?.contextWindow).toBe(200_000)
  })

  it('materializes a configured default only when the model accepts it', () => {
    expect(resolveDefaultReasoningEffort(['low', 'high', 'xhigh'], 'xhigh')).toBe('xhigh')
    // Membership, not convergence: a level outside the ladder is dropped rather
    // than moved onto a neighbour that would change how hard the model thinks.
    expect(resolveDefaultReasoningEffort(['low', 'high'], 'minimal')).toBeUndefined()
    expect(resolveDefaultReasoningEffort([], 'high')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// The request path
// ---------------------------------------------------------------------------

describe('claude adapter request path', () => {
  it('posts the Messages body with subscription headers and streams the answer', async () => {
    const { store, settings } = await mount()
    const { fn, calls } = recordingFetch(() => answerResponse('hello there'))
    const adapter = makeAdapter(store, settings, fn)
    const chunks = await drain(adapter.stream(options()))

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(API_BASE + MESSAGES_PATH)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.headers.authorization).toBe('Bearer ACCESS-1')
    // A subscription request authenticates with the bearer token and MUST NOT
    // carry the Console's API-key field alongside it.
    expect('x-api-key' in calls[0]!.headers).toBe(false)
    expect(calls[0]!.headers['anthropic-beta']).toContain('oauth-2025-04-20')
    // A non-haiku model gets the Claude Code identity beta; a haiku one does not.
    expect(calls[0]!.headers['anthropic-beta']).toContain('claude-code-20250219')
    expect(calls[0]!.headers['user-agent']).toMatch(/^claude-cli\//)

    expect(calls[0]!.body.model).toBe('claude-sonnet-4-6')
    expect(calls[0]!.body.stream).toBe(true)
    expect(typeof calls[0]!.body.max_tokens).toBe('number')
    expect(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')).toBe('hello there')
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('omits the claude-code beta for a haiku model, from the real model id', async () => {
    const { store, settings } = await mount()
    const { fn, calls } = recordingFetch(() => answerResponse())
    const adapter = makeAdapter(store, settings, fn)
    await drain(adapter.stream(options('claude-haiku-4-5')))
    expect(calls[0]!.headers['anthropic-beta']).not.toContain('claude-code-20250219')
    expect(calls[0]!.headers['anthropic-beta']).toContain('oauth-2025-04-20')
  })

  it('uses ONE tool-name table for the body and the response back-map', async () => {
    const { store, settings } = await mount()
    const { fn, calls } = recordingFetch(() => streamResponse([
      MESSAGE_START,
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"a"}' } },
      { type: 'content_block_stop', index: 0 },
      MESSAGE_STOP,
    ]))
    const adapter = makeAdapter(store, settings, fn)
    const chunks = await drain(adapter.stream(options('claude-sonnet-4-6', {
      tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object', properties: {} } }],
    } as Partial<GenerateOptions>)))

    // Request side: the caller's lowercase name went out canonically.
    const tools = calls[0]!.body.tools as Array<{ name: string }>
    expect(tools[0]!.name).toBe('Read')
    // Response side: the model's canonical spelling came back as the caller's.
    const call = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    expect(call).toMatchObject({ block: { name: 'read' } })
  })

  it('fails with MISSING_CREDENTIAL when nothing is signed in', async () => {
    const dir = await scratchDir()
    const store = new FileCredentialStore(path.join(dir, 'credentials.json'), memoryBackend<ClaudeCredentialDocument>())
    const settings = new FileModelSettingsStore(path.join(dir, 'models.json'))
    const { fn, calls } = recordingFetch(() => answerResponse())
    const adapter = makeAdapter(store, settings, fn)
    const error = await failureOf(adapter.stream(options()))
    expect(error).toMatchObject({ code: 'MISSING_CREDENTIAL' })
    expect(calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Failure classification and codes
// ---------------------------------------------------------------------------

describe('claude adapter failure codes', () => {
  it('maps each classified condition onto its DSH code', () => {
    expect(codeForFailure(classifyFailure(401, '', {}))).toBe('INVALID_CREDENTIAL')
    expect(codeForFailure(classifyFailure(429, '', new Headers(ACCOUNT_SCOPED_429)))).toBe('RATE_LIMIT')
    expect(codeForFailure(classifyFailure(429, '', {}))).toBe('RATE_LIMIT')
    expect(codeForFailure(classifyFailure(529, '', {}))).toBe('SERVER')
    expect(codeForFailure(classifyFailure(500, '', {}))).toBe('SERVER')
    expect(codeForFailure(classifyFailure(400, '', {}))).toBe('PROVIDER_ERROR')
  })

  it('reports a client-version rejection as a request problem, never a sign-out', async () => {
    const { store, settings } = await mount()
    const body = {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Your client version is below the minimum supported version. code: claude_code_version_too_old',
      },
    }
    const { fn, calls } = recordingFetch(() => errorResponse(400, body))
    const adapter = makeAdapter(store, settings, fn)
    const error = await failureOf(adapter.stream(options())) as { code: string; message: string }

    // The whole point: this must NOT be reported as a dead credential, because
    // the stored sign-in is still perfectly valid.
    expect(error.code).toBe('PROVIDER_ERROR')
    expect(error.code).not.toBe('INVALID_CREDENTIAL')
    expect(error.message).toContain('claude_code_version_too_old')
    expect(error.message).toContain('DSH_CLAUDE_CLI_VERSION')
    expect(calls).toHaveLength(1)
  })

  it('refuses a model whose floor the reported version misses — locally, as PROVIDER_ERROR, naming both versions and the remedy', async () => {
    const { store, settings } = await mount()
    const { fn, calls } = recordingFetch(() => answerResponse())
    const adapter = makeAdapter(store, settings, fn)

    try {
      // Simulates the pinned/environment version being too old — the state the
      // shipped 2.1.251 default was in for claude-opus-5-5.
      setClaudeCliVersion('2.1.251')
      const error = await failureOf(adapter.stream(options('claude-opus-5-5'))) as { code: string; message: string }

      // The whole point: no request is spent, and the user is told what to do.
      expect(calls).toHaveLength(0)

      // NOT a credential error. The upstream text invites a re-sign-in, which
      // cannot change a client version; the local refusal must not repeat that.
      expect(error.code).toBe('PROVIDER_ERROR')
      expect(error.code).not.toBe('INVALID_CREDENTIAL')
      // Every fact the user needs, in the message itself.
      expect(error.message).toContain('claude-opus-5-5')
      expect(error.message).toContain('2.1.251')
      expect(error.message).toContain('2.1.280')
      expect(error.message).toContain('DSH_CLAUDE_CLI_VERSION')
      expect(error.message).toContain('setClaudeCliVersion')
      // ...including that the stored sign-in is fine, which is the sentence the
      // upstream wording lacks.
      expect(error.message).toMatch(/sign(-| )?in is still valid|stored sign-in is still valid/)
      expect(error.message).toContain('not a credential problem')

      // A model this table records no floor for is untouched by the check.
      const fine = recordingFetch(() => answerResponse('ok'))
      await drain(makeAdapter(store, settings, fine.fn).stream(options('claude-opus-5')))
      expect(fine.calls).toHaveLength(1)

      // And raising the version clears the same model on the same adapter.
      setClaudeCliVersion('2.1.283')
      const raised = recordingFetch(() => answerResponse('ok'))
      await drain(makeAdapter(store, settings, raised.fn).stream(options('claude-opus-5-5')))
      expect(raised.calls).toHaveLength(1)
      expect(raised.calls[0]!.headers['user-agent']).toBe('claude-cli/2.1.283 (external, cli)')
    } finally {
      // No test may inherit a lowered version.
      setClaudeCliVersion(null)
    }
    expect(claudeCliVersion()).toBe(CLAUDE_CLI_VERSION)

    // The rule is also stated directly, so a reordering of the request path that
    // dropped the call would still be caught here.
    try {
      setClaudeCliVersion('2.1.279')
      expect(() => assertClaudeCliVersionMeetsFloor('claude-opus-5-5')).toThrow(/2.1.280/)
      setClaudeCliVersion('2.1.280')
      expect(() => assertClaudeCliVersionMeetsFloor('claude-opus-5-5')).not.toThrow()
    } finally {
      setClaudeCliVersion(null)
    }
  })

  it('honours a floor carried by a live-only catalog entry the shipped table does not have', async () => {
    const { store, settings } = await mount()
    // The check reads the catalog the REQUEST resolves against, not the frozen
    // table alone: a floor recorded for an id only the account's live listing
    // carries must be enforced too.
    const liveCatalog: ClaudeModelEntry[] = [{
      id: 'claude-live-only-9',
      name: 'Claude Live Only 9',
      contextWindow: 200_000,
      maxTokens: 64_000,
      supportsImage: true,
      supportsTemperature: true,
      thinkingMode: 'adaptive',
      reasoningEfforts: ['low', 'high'],
      canDisableThinking: true,
      minCliVersion: '2.1.282',
    }]
    const { fn, calls } = recordingFetch(() => answerResponse())
    const adapter = new ClaudeAdapter(store, settings, undefined, {
      fetchFn: fn,
      loadCatalog: async () => liveCatalog as never[],
    })

    try {
      setClaudeCliVersion('2.1.280')
      const error = await failureOf(adapter.stream(options('claude-live-only-9'))) as { code: string; message: string }
      expect(error.code).toBe('PROVIDER_ERROR')
      expect(error.message).toContain('claude-live-only-9')
      expect(error.message).toContain('2.1.282')
      expect(calls).toHaveLength(0)

      setClaudeCliVersion('2.1.283')
      await drain(adapter.stream(options('claude-live-only-9')))
      expect(calls).toHaveLength(1)
    } finally {
      setClaudeCliVersion(null)
    }
  })

  it('maps a live 401 and a live 529 from the real request path', async () => {
    const { store, settings } = await mount()
    const unauthorized = recordingFetch(() => errorResponse(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid token' } }))
    expect(await failureOf(makeAdapter(store, settings, unauthorized.fn).stream(options())))
      .toMatchObject({ code: 'INVALID_CREDENTIAL' })

    const { store: store2, settings: settings2 } = await mount()
    const overloaded = recordingFetch(() => errorResponse(529, { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }))
    expect(await failureOf(makeAdapter(store2, settings2, overloaded.fn).stream(options())))
      .toMatchObject({ code: 'SERVER' })
  })

  it('carries retry-after onto the error as the delay the policy reads', async () => {
    const { store, settings } = await mount()
    const { fn } = recordingFetch(() => errorResponse(
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
      { 'retry-after': '42', ...ACCOUNT_SCOPED_429 },
    ))
    const error = await failureOf(makeAdapter(store, settings, fn).stream(options())) as { failure: { providerRetryAfterMs?: number } }
    expect(error.failure.providerRetryAfterMs).toBe(42_000)
  })
})

// ---------------------------------------------------------------------------
// Rotation — the two limits
// ---------------------------------------------------------------------------

describe('claude adapter rotation', () => {
  async function pooledAdapter(pool: FakePool, respond: (call: FetchCall, index: number) => Response) {
    const dir = await scratchDir()
    // The single-credential store is unused on the pooled path, but the adapter
    // still takes one; it is pointed at a scratch path so nothing is shared.
    const store = new FileCredentialStore(path.join(dir, 'credentials.json'), memoryBackend<ClaudeCredentialDocument>())
    const settings = new FileModelSettingsStore(path.join(dir, 'models.json'))
    const { fn, calls } = recordingFetch(respond)
    return { adapter: makeAdapter(store, settings, fn, { accountPool: pool }), calls }
  }

  it('rotates on an ACCOUNT-SCOPED limit and finishes the turn on the next account', async () => {
    const pool = new FakePool([
      { id: 'cl-1', credentials: credentials('ACCESS-1') },
      { id: 'cl-2', credentials: credentials('ACCESS-2') },
    ])
    const { adapter, calls } = await pooledAdapter(pool, (_call, index) => (index === 0
      ? errorResponse(429, { type: 'error', error: { type: 'rate_limit_error', message: 'usage window spent' } }, ACCOUNT_SCOPED_429)
      : answerResponse('second')))
    const chunks = await drain(adapter.stream(options()))

    expect(calls.map((call) => call.headers.authorization)).toEqual(['Bearer ACCESS-1', 'Bearer ACCESS-2'])
    expect(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')).toBe('second')
    // The spent account is parked, which is what stops the next turn from
    // rediscovering the same wall.
    expect(pool.cooldowns.map((entry) => entry.id)).toEqual(['cl-1'])
    expect(pool.cooldowns[0]!.ms).toBeGreaterThan(0)
  })

  it('does NOT rotate on a GLOBAL limit — every account shares it', async () => {
    const pool = new FakePool([
      { id: 'cl-1', credentials: credentials('ACCESS-1') },
      { id: 'cl-2', credentials: credentials('ACCESS-2') },
    ])
    // A 429 with no unified rate-limit header is not attributable to this
    // account's window, so switching would burn the pool against a wall none of
    // the accounts can pass.
    const { adapter, calls } = await pooledAdapter(pool, () => errorResponse(
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'too many requests' } },
    ))
    const error = await failureOf(adapter.stream(options()))

    expect(error).toMatchObject({ code: 'RATE_LIMIT' })
    expect(calls).toHaveLength(1)
    expect(pool.cooldowns).toHaveLength(0)
  })

  it('does NOT rotate on an overload or a 5xx', async () => {
    for (const [status, type] of [[529, 'overloaded_error'], [503, 'api_error']] as const) {
      const pool = new FakePool([
        { id: 'cl-1', credentials: credentials('ACCESS-1') },
        { id: 'cl-2', credentials: credentials('ACCESS-2') },
      ])
      const { adapter, calls } = await pooledAdapter(pool, () => errorResponse(
        status,
        { type: 'error', error: { type, message: 'capacity' } },
      ))
      expect(await failureOf(adapter.stream(options()))).toMatchObject({ code: 'SERVER' })
      expect(calls).toHaveLength(1)
      expect(pool.cooldowns).toHaveLength(0)
    }
  })

  it('rotates on a credential verdict and takes that account out of the pool', async () => {
    const pool = new FakePool([
      { id: 'cl-1', credentials: credentials('ACCESS-1') },
      { id: 'cl-2', credentials: credentials('ACCESS-2') },
    ])
    const { adapter, calls } = await pooledAdapter(pool, (_call, index) => (index === 0
      ? errorResponse(401, { type: 'error', error: { type: 'authentication_error', message: 'revoked' } })
      : answerResponse('ok')))
    await drain(adapter.stream(options()))

    expect(calls.map((call) => call.headers.authorization)).toEqual(['Bearer ACCESS-1', 'Bearer ACCESS-2'])
    // The account is kept (signing in again restores it) but flagged.
    expect(pool.authFailures.map((entry) => entry.id)).toEqual(['cl-1'])
    expect(pool.cooldowns).toHaveLength(0)
  })

  it('stops after three attempts even when the pool keeps offering another account', async () => {
    const pool = new FakePool([
      { id: 'cl-1', credentials: credentials('ACCESS-1') },
      { id: 'cl-2', credentials: credentials('ACCESS-2') },
      { id: 'cl-3', credentials: credentials('ACCESS-3') },
      { id: 'cl-4', credentials: credentials('ACCESS-4') },
      { id: 'cl-5', credentials: credentials('ACCESS-5') },
    ])
    const { adapter, calls } = await pooledAdapter(pool, () => errorResponse(
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'spent' } },
      ACCOUNT_SCOPED_429,
    ))
    expect(await failureOf(adapter.stream(options()))).toMatchObject({ code: 'RATE_LIMIT' })
    // Bounded: the pool reports more accounts, the loop still stops.
    expect(calls).toHaveLength(3)
  })

  it('rotates nothing when no pool is installed', async () => {
    const { store, settings } = await mount()
    const { fn, calls } = recordingFetch(() => errorResponse(
      401,
      { type: 'error', error: { type: 'authentication_error', message: 'revoked' } },
    ))
    const adapter = makeAdapter(store, settings, fn)
    expect(await failureOf(adapter.stream(options()))).toMatchObject({ code: 'INVALID_CREDENTIAL' })
    expect(calls).toHaveLength(1)
  })

  it('decides rotation from the classified failure, not from the status alone', () => {
    const accountScoped = classifyFailure(429, '', new Headers(ACCOUNT_SCOPED_429))
    const global = classifyFailure(429, '', {})
    expect(shouldRotateAccount(accountScoped, false)).toBe(true)
    expect(shouldRotateAccount(global, false)).toBe(false)
    expect(shouldRotateAccount(classifyFailure(529, '', {}), false)).toBe(false)
    expect(shouldRotateAccount(classifyFailure(503, '', {}), false)).toBe(false)
    expect(shouldRotateAccount(classifyFailure(401, '', {}), false)).toBe(true)
    expect(shouldRotateAccount(classifyFailure(400, '', {}), false)).toBe(false)
  })

  it('prefers the stated delay, then the stated reset instant, then its own cooldown', () => {
    const withRetryAfter = classifyFailure(429, '', new Headers({ 'retry-after': '60' }))
    expect(cooldownMsFor(withRetryAfter)).toBe(60_000)

    const resetAt = new Date(Date.now() + 120_000).toISOString()
    const withReset = classifyFailure(429, JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'limit reached; will reset at ' + resetAt },
    }), {})
    expect(cooldownMsFor(withReset)).toBeGreaterThan(60_000)
    expect(cooldownMsFor(withReset)).toBeLessThanOrEqual(120_000)

    const bare = classifyFailure(429, '', {})
    expect(cooldownMsFor(bare)).toBe(15 * 60 * 1000)
    // A weekly window can name a reset days out; an account parked for days
    // would look exactly like a broken pool, so the cooldown is capped.
    const farOut = classifyFailure(429, JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'will reset at ' + new Date(Date.now() + 7 * 24 * 3600_000).toISOString() },
    }), {})
    expect(cooldownMsFor(farOut)).toBe(5 * 60 * 60 * 1000)
  })
})

// ---------------------------------------------------------------------------
// NO ROTATION AFTER OUTPUT — the hard requirement
// ---------------------------------------------------------------------------

describe('claude adapter never rotates after output has started', () => {
  it('emits a delta, then fails the connection mid-stream, and issues NO second request', async () => {
    const pool = new FakePool([
      { id: 'cl-1', credentials: credentials('ACCESS-1') },
      { id: 'cl-2', credentials: credentials('ACCESS-2') },
    ])
    const dir = await scratchDir()
    const store = new FileCredentialStore(path.join(dir, 'credentials.json'), memoryBackend<ClaudeCredentialDocument>())
    const settings = new FileModelSettingsStore(path.join(dir, 'models.json'))

    const encoder = new TextEncoder()
    let requestCount = 0
    const fetchFn = vi.fn(async () => {
      requestCount += 1
      // A stream that delivers one delta and then severs: the failure arrives
      // AFTER the caller has already seen content.
      // The error must arrive on a LATER read than the delta: erroring the
      // controller in the same tick as the enqueue discards the queued chunk
      // (the stream is settled before anything is pulled), which would make this
      // test pass for the wrong reason — no output, therefore trivially no
      // rotation-after-output.
      let delivered = false
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (delivered) {
            controller.error(new Error('connection reset by peer'))
            return
          }
          delivered = true
          controller.enqueue(encoder.encode(sse([
            MESSAGE_START,
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial answer' } },
          ])))
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch

    const adapter = makeAdapter(store, settings, fetchFn, { accountPool: pool })
    const seen: StreamChunk[] = []
    let failure: unknown
    try {
      for await (const chunk of adapter.stream(options())) seen.push(chunk)
    } catch (error) {
      failure = error
    }

    // The delta reached the caller...
    expect(seen.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text)).toEqual(['partial answer'])
    // ...and the failure was SURFACED rather than retried. A retry would have
    // repeated 'partial answer' and, on a tool call, re-executed the tool.
    expect(failure).toMatchObject({ code: 'PROVIDER_ERROR' })
    expect(requestCount).toBe(1)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(pool.cooldowns).toHaveLength(0)
    expect(pool.authFailures).toHaveLength(0)
  })

  it('states the rule itself: output started means no rotation, whatever the failure', () => {
    for (const status of [401, 429, 500, 529]) {
      const failure = classifyFailure(status, '', new Headers(status === 429 ? ACCOUNT_SCOPED_429 : {}))
      expect(shouldRotateAccount(failure, false)).toBe(status === 401 || status === 429)
      // Once output has started, every one of them is refused.
      expect(shouldRotateAccount(failure, true)).toBe(false)
    }
  })

  it('still rotates when the credential fails BEFORE any output', async () => {
    const pool = new FakePool([
      { id: 'cl-1', credentials: credentials('ACCESS-1') },
      { id: 'cl-2', credentials: credentials('ACCESS-2') },
    ])
    const dir = await scratchDir()
    const store = new FileCredentialStore(path.join(dir, 'credentials.json'), memoryBackend<ClaudeCredentialDocument>())
    const settings = new FileModelSettingsStore(path.join(dir, 'models.json'))
    const { fn, calls } = recordingFetch((_call, index) => (index === 0
      ? errorResponse(401, { type: 'error', error: { type: 'authentication_error', message: 'revoked' } })
      : answerResponse('after rotation')))
    const chunks = await drain(makeAdapter(store, settings, fn, { accountPool: pool }).stream(options()))
    expect(calls).toHaveLength(2)
    expect(chunks.some((chunk) => chunk.type === 'text-delta')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Abort and truncation
// ---------------------------------------------------------------------------

describe('claude adapter abort and truncation', () => {
  it('reports a caller cancellation as ABORTED rather than as a provider error', async () => {
    const { store, settings } = await mount()
    const controller = new AbortController()
    const { fn } = recordingFetch(() => {
      controller.abort()
      throw new Error('aborted')
    })
    const adapter = makeAdapter(store, settings, fn)
    const error = await failureOf(adapter.stream(options('claude-sonnet-4-6', { signal: controller.signal })))
    expect(error).toMatchObject({ code: 'ABORTED' })
  })

  it('refuses to present a severed stream as a completed answer', async () => {
    const { store, settings } = await mount()
    // No message_stop: the model never finished saying this. Flushing it as a
    // clean stop would report a wrong answer as a successful one.
    const { fn } = recordingFetch(() => streamResponse([
      MESSAGE_START,
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half' } },
    ]))
    const adapter = makeAdapter(store, settings, fn)
    expect(await failureOf(adapter.stream(options()))).toMatchObject({ code: 'PROVIDER_ERROR' })
  })
})
