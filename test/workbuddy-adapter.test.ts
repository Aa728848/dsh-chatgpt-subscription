import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { WorkBuddyAdapter, classifyFailure, readErrorCode } from '../src/host/workbuddy/adapter.ts'
import { FileCredentialStore, FileModelSettingsStore } from '../src/host/workbuddy/token-store.ts'
import { createStreamState, processStreamLine, closeStream } from '../src/host/workbuddy/mapper.ts'
import type { WorkBuddyModelEntry } from '../src/host/workbuddy/model-catalog.ts'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** A tiny live-shaped catalog so tests do not depend on the shipped table. */
const CATALOG: WorkBuddyModelEntry[] = [
  {
    id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxContextWindow: 1_000_000, maxTokens: 48_000,
    regions: ['cn', 'intl'], supportsImage: true, reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high', canDisableThinking: true, description: '',
  },
  {
    id: 'kimi-k2-thinking', name: 'Kimi-K2-Thinking', contextWindow: 164_000, maxContextWindow: 164_000, maxTokens: 32_000,
    regions: ['cn'], supportsImage: false, reasoningEfforts: ['high'],
    defaultReasoningEffort: 'high', canDisableThinking: false, description: '',
  },
]

const temporaryDirs: string[] = []

async function makeStore(options: { domain?: string; expiresAt?: number } = {}): Promise<FileCredentialStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-adapter-'))
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
  return new FileCredentialStore(dir)
}

function makeAdapter(store: FileCredentialStore, fetchFn?: typeof fetch): WorkBuddyAdapter {
  return new WorkBuddyAdapter(
    store,
    new FileModelSettingsStore(path.join(os.tmpdir(), `wb-models-${Date.now()}-${Math.random()}.json`)),
    undefined,
    {
      ...(fetchFn ? { fetchFn } : {}),
      loadCatalog: async () => CATALOG,
    },
  )
}

/**
 * An adapter whose settings enable every catalog model.
 *
 * `listModels` applies the user's enabled selection on top of the region
 * filter, and the shipped default is a deliberately short list — so a test
 * about *region* filtering must not be confounded by the *selection* filter.
 */
function makeOpenAdapter(store: FileCredentialStore, fetchFn?: typeof fetch): WorkBuddyAdapter {
  const preferences = {
    status: () => ({
      enabled: true,
      enabledModelIds: CATALOG.map((model) => model.id),
      contextWindowOverrides: {},
      defaultReasoningEffort: null,
    }),
    update: async () => { throw new Error('not used in this test') },
  }
  return new WorkBuddyAdapter(
    store,
    new FileModelSettingsStore(path.join(os.tmpdir(), `wb-models-${Date.now()}-${Math.random()}.json`)),
    preferences as any,
    {
      ...(fetchFn ? { fetchFn } : {}),
      loadCatalog: async () => CATALOG,
    },
  )
}

/** Build a Response whose body is the given SSE text. */
function sseResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const dir of temporaryDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

describe('WorkBuddy failure classification', () => {
  it('reads the subscription error code out of a response body', () => {
    expect(readErrorCode('{"code":11102,"msg":"nope"}')).toBe(11102)
    expect(readErrorCode('{"code": 6004 ,"msg":"x"}')).toBe(6004)
    expect(readErrorCode('<html>401</html>')).toBeNull()
  })

  it('treats 401 and 403 as a rejected credential that must not be retried', () => {
    const error = classifyFailure(401, 'unauthorized')
    expect(error.code).toBe('INVALID_CREDENTIAL')
  })

  it('classifies quota exhaustion carried inside a 400 as retryable rate limiting', () => {
    // The subscription reports a usage cap with code 6004, whose message names
    // the reset instant; the HTTP status alone does not express that.
    const error = classifyFailure(400, '{"code":6004,"msg":"usage exceeded, resets at 2026-09-20 10:50:48 UTC+8"}')
    expect(error.code).toBe('RATE_LIMIT')
  })

  it('honors a Retry-After header on a 429', () => {
    const headers = new Headers({ 'retry-after': '30' })
    const error = classifyFailure(429, '{"code":6004}', headers)
    expect(error.code).toBe('RATE_LIMIT')
    // Structured provider facts ride `failure`, not the error itself.
    expect(error.failure.providerRetryAfterMs).toBe(30_000)
  })

  it('explains a wrong-region or unentitled model rather than calling it transient', () => {
    const error = classifyFailure(400, '{"code":11102,"msg":"model [x] service info not found"}')
    expect(error.code).toBe('PROVIDER_ERROR')
    // 11102 covers both "wrong region" and "plan does not include it"; the fix
    // is the same, so the message names both rather than guessing.
    expect(error.message).toMatch(/region/i)
    expect(error.message).toMatch(/plan/i)
  })

  it('treats an unusable image as a request problem, not a transient one', () => {
    expect(classifyFailure(400, '{"code":11135}').code).toBe('PROVIDER_ERROR')
    expect(classifyFailure(400, '{"code":11133}').code).toBe('PROVIDER_ERROR')
  })

  it('names the system-first requirement when the history is rejected', () => {
    const error = classifyFailure(400, '{"code":11128,"msg":"first message is not system prompt"}')
    expect(error.code).toBe('PROVIDER_ERROR')
    expect(error.message).toMatch(/system prompt/i)
  })

  it('classifies 5xx and the upstream vendor code as a retryable server failure', () => {
    expect(classifyFailure(503, 'busy').code).toBe('SERVER')
    expect(classifyFailure(500, '{"code":11134}').code).toBe('SERVER')
  })

  it('falls back to a provider error for anything else', () => {
    expect(classifyFailure(400, '{"code":12345}').code).toBe('PROVIDER_ERROR')
  })
})

describe('WorkBuddy adapter catalog', () => {
  it('offers only the models the account region serves', async () => {
    const cn = makeOpenAdapter(await makeStore({ domain: 'copilot.tencent.com' }))
    const cnIds = (await cn.listModels()).map((m) => m.id)
    expect(cnIds).toContain('kimi-k2-thinking')

    const intl = makeOpenAdapter(await makeStore({ domain: 'www.workbuddy.ai' }))
    const intlIds = (await intl.listModels()).map((m) => m.id)
    // Asking a region for a model it does not serve answers 400 code 11102, so
    // offering one would hand the user a model that cannot work.
    expect(intlIds).not.toContain('kimi-k2-thinking')
  })

  it('declares image input only for models the catalog says accept it', async () => {
    const adapter = makeOpenAdapter(await makeStore())
    const models = await adapter.listModels()
    const glm = models.find((m) => m.id === 'glm-5.3')!
    const kimi = models.find((m) => m.id === 'kimi-k2-thinking')!
    expect(glm.inputModalities).toEqual(['text', 'image'])
    expect(kimi.inputModalities).toEqual(['text'])
  })

  it('resolves the catalog context window and reasoning ladder', async () => {
    const adapter = makeAdapter(await makeStore())
    const resolved = await adapter.resolveModel('workbuddy', 'glm-5.3')
    expect(resolved.context?.contextWindow).toBe(1_000_000)
    expect(resolved.defaultMaxTokens).toBe(48_000)
    expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(['low', 'high', 'max'])
    expect(resolved.reasoning?.defaultEffort).toBe('high')
  })

  it('omits reasoning entirely for a model that declares none', async () => {
    const adapter = new WorkBuddyAdapter(
      await makeStore(),
      new FileModelSettingsStore(path.join(os.tmpdir(), `wb-m-${Date.now()}.json`)),
      undefined,
      { loadCatalog: async () => [{ ...CATALOG[0]!, id: 'plain', reasoningEfforts: [], defaultReasoningEffort: null }] },
    )
    const resolved = await adapter.resolveModel('workbuddy', 'plain')
    expect(resolved.reasoning).toBeUndefined()
  })

  it('falls back to the shipped table when the gateway catalog is unreachable', async () => {
    const adapter = new WorkBuddyAdapter(
      await makeStore(),
      new FileModelSettingsStore(path.join(os.tmpdir(), `wb-m-${Date.now()}.json`)),
      undefined,
      { loadCatalog: async () => { throw new Error('offline') } },
    )
    const ids = (await adapter.listModels()).map((m) => m.id)
    expect(ids.length).toBeGreaterThan(0)
  })

  it('hides every model when the provider is disabled', async () => {
    const preferences = {
      status: () => ({ enabled: false, enabledModelIds: ['glm-5.3'], contextWindowOverrides: {}, defaultReasoningEffort: null }),
      update: async () => { throw new Error('unused') },
    }
    const adapter = new WorkBuddyAdapter(
      await makeStore(),
      new FileModelSettingsStore(path.join(os.tmpdir(), `wb-m-${Date.now()}.json`)),
      preferences as any,
      { loadCatalog: async () => CATALOG },
    )
    expect(await adapter.listModels()).toEqual([])
  })

  it('returns no models before a credential exists', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-empty-'))
    temporaryDirs.push(dir)
    const adapter = makeAdapter(new FileCredentialStore(dir))
    expect(await adapter.listModels()).toEqual([])
  })
})

describe('WorkBuddy adapter streaming', () => {
  it('refuses to call the endpoint without a credential', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-empty-'))
    temporaryDirs.push(dir)
    const adapter = makeAdapter(new FileCredentialStore(dir))
    const options = {
      provider: 'workbuddy',
      model: 'glm-5.3',
      messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
    } as unknown as GenerateOptions

    await expect(async () => {
      for await (const _chunk of adapter.stream(options)) { /* drain */ }
    }).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('streams a completion and posts to the account backend with the CLI identity', async () => {
    const store = await makeStore({ domain: 'www.workbuddy.ai' })
    const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = []
    const fetchFn = (async (url: any, init: any) => {
      calls.push({ url: String(url), headers: init.headers, body: JSON.parse(String(init.body)) })
      return sseResponse([
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
        'data: {"choices":[{"index":0,"delta":{"content":"po"},"finish_reason":null}]}',
        'data: {"choices":[{"index":0,"delta":{"content":"ng"},"finish_reason":null}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}',
        'data: [DONE]',
        '',
      ].join('\n'))
    }) as unknown as typeof fetch

    const adapter = makeAdapter(store, fetchFn)
    const options = {
      provider: 'workbuddy',
      model: 'glm-5.3',
      messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
    } as unknown as GenerateOptions

    const chunks: any[] = []
    for await (const chunk of adapter.stream(options)) chunks.push(chunk)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://www.workbuddy.ai/v2/chat/completions')
    // The international gateway rejects the IDE identity outright.
    expect(calls[0]!.headers['user-agent']).toBe('CLI/2.63.2 CodeBuddy/2.63.2')
    expect(calls[0]!.headers.origin).toBe('https://www.workbuddy.ai')
    expect(calls[0]!.headers['x-user-id']).toBe('uid-1')
    expect(calls[0]!.body.stream).toBe(true)
    expect(calls[0]!.body.messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' })

    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')).toBe('pong')
    expect(chunks.find((c) => c.type === 'finish')).toMatchObject({ reason: { kind: 'stop' } })
  })

  it('refreshes an expired token before the call and writes it back', async () => {
    const store = await makeStore({ expiresAt: Date.now() - 1000 })
    const urls: string[] = []
    const fetchFn = (async (url: any, init: any) => {
      urls.push(String(url))
      if (String(url).includes('/v2/plugin/auth/token/refresh')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { accessToken: 'refreshed-token', refreshToken: 'rotated', expiresIn: 3600, domain: 'copilot.tencent.com' },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      const auth = JSON.parse(String(init.body))
      expect(auth.model).toBe('glm-5.3')
      expect(init.headers.authorization).toBe('Bearer refreshed-token')
      return sseResponse('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    }) as unknown as typeof fetch

    const adapter = makeAdapter(store, fetchFn)
    const options = {
      provider: 'workbuddy',
      model: 'glm-5.3',
      messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
    } as unknown as GenerateOptions

    for await (const _chunk of adapter.stream(options)) { /* drain */ }

    expect(urls[0]).toContain('/v2/plugin/auth/token/refresh')
    expect(urls[1]).toContain('/v2/chat/completions')
  })

  it('surfaces a truncated stream instead of presenting partial text as complete', async () => {
    const store = await makeStore()
    const fetchFn = (async () => sseResponse(
      'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
    )) as unknown as typeof fetch

    const adapter = makeAdapter(store, fetchFn)
    const options = {
      provider: 'workbuddy',
      model: 'glm-5.3',
      messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
    } as unknown as GenerateOptions

    await expect(async () => {
      for await (const _chunk of adapter.stream(options)) { /* drain */ }
    }).rejects.toBeInstanceOf(LlmError)
  })

  it('reports a provider failure with its classified code', async () => {
    const store = await makeStore()
    const fetchFn = (async () => new Response(
      JSON.stringify({ code: 11102, msg: 'model [x] service info not found' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch

    const adapter = makeAdapter(store, fetchFn)
    const options = {
      provider: 'workbuddy',
      model: 'glm-5.3',
      messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
    } as unknown as GenerateOptions

    await expect(async () => {
      for await (const _chunk of adapter.stream(options)) { /* drain */ }
    }).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
  })
})

describe('WorkBuddy adapter retry policy', () => {
  it('retries transient failures but not a rejected credential', () => {
    const policy = makeAdapter(new FileCredentialStore()).providerRetryPolicy()
    // The resolved policy is a discriminated union; `retryableCodes` exists only
    // on the bounded `normal` mode this route declares.
    expect(policy.mode).toBe('normal')
    if (policy.mode !== 'normal') throw new Error('expected the bounded normal policy')
    expect(policy.retryableCodes).toContain('RATE_LIMIT')
    expect(policy.retryableCodes).toContain('SERVER')
    expect(policy.retryableCodes).toContain('TIMEOUT')
    expect(policy.retryableCodes).toContain('TRANSPORT')
    expect(policy.retryableCodes).not.toContain('INVALID_CREDENTIAL')
    expect(policy.retryableCodes).not.toContain('ABORTED')
    expect(policy.maxRetries).toBe(3)
  })
})

describe('WorkBuddy reasoning effort on the wire', () => {
  /**
   * Capture the body one `stream()` call sends.
   *
   * The upstream returns an EMPTY `reasoning_content` when the request carries
   * no `reasoning_effort` (measured on `deepseek-v4.1-flash`: 0 characters with
   * no field, 130-215 with one), so whether the field goes out is the thing
   * that decides whether the model's thinking survives.
   */
  async function capture(model: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> | null = null
    const store = await makeStore()
    const adapter = new WorkBuddyAdapter(
      store,
      new FileModelSettingsStore(path.join(os.tmpdir(), `wb-effort-${Date.now()}-${Math.random()}.json`)),
      undefined,
      {
        fetchFn: (async (url: any, init: any) => {
          if (String(url).includes('/v2/chat/completions')) body = JSON.parse(String(init.body))
          return sseResponse('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        }) as unknown as typeof fetch,
        loadCatalog: async () => CATALOG,
      },
    )
    const options = {
      provider: 'workbuddy',
      model,
      messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
      ...extra,
    } as unknown as GenerateOptions
    for await (const _chunk of adapter.stream(options)) { /* drain */ }
    if (body === null) throw new Error('the adapter sent no chat request')
    return body
  }

  it('materializes the catalog default when the caller names no effort', async () => {
    // Regression: `stream()` used to consult only the user's global preference,
    // so a model whose catalog default is `high` sent no effort at all and the
    // endpoint answered with empty reasoning_content.
    const body = await capture('glm-5.3')
    expect(body.reasoning_effort).toBe('high')
  })

  it('lets an explicit caller effort win over the catalog default', async () => {
    // Regression: a model whose gateway entry carries only `{ effort: 'high' }`
    // was given a one-entry ladder, so an explicit `low` was rejected as
    // unsupported and silently replaced by the default.
    expect((await capture('glm-5.3', { reasoningEffort: 'low' })).reasoning_effort).toBe('low')
    expect((await capture('glm-5.3', { reasoningEffort: 'max' })).reasoning_effort).toBe('max')
  })

  it('sends no effort for a model that declares none', async () => {
    const store = await makeStore()
    const adapter = new WorkBuddyAdapter(
      store,
      new FileModelSettingsStore(path.join(os.tmpdir(), `wb-effort-${Date.now()}.json`)),
      undefined,
      {
        fetchFn: (async (url: any, init: any) => {
          const body = JSON.parse(String(init.body))
          expect(body.reasoning_effort).toBeUndefined()
          return sseResponse('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        }) as unknown as typeof fetch,
        loadCatalog: async () => [{ ...CATALOG[0]!, id: 'plain', reasoningEfforts: [], defaultReasoningEffort: null }],
      },
    )
    const options = {
      provider: 'workbuddy',
      model: 'plain',
      messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
    } as unknown as GenerateOptions
    for await (const _chunk of adapter.stream(options)) { /* drain */ }
  })

  it('ignores a configured level the model does not accept', async () => {
    // The endpoint rejects an unsupported level with code 11150, so a value the
    // model's ladder excludes must never be forwarded.
    const store = await makeStore()
    const preferences = {
      status: () => ({
        enabled: true,
        enabledModelIds: CATALOG.map((m) => m.id),
        contextWindowOverrides: {},
        defaultReasoningEffort: 'xhigh',
      }),
      update: async () => { throw new Error('not used') },
    }
    let body: Record<string, unknown> | null = null
    const adapter = new WorkBuddyAdapter(
      store,
      new FileModelSettingsStore(path.join(os.tmpdir(), `wb-effort-${Date.now()}.json`)),
      preferences as any,
      {
        fetchFn: (async (url: any, init: any) => {
          if (String(url).includes('/v2/chat/completions')) body = JSON.parse(String(init.body))
          return sseResponse('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        }) as unknown as typeof fetch,
        // This model accepts low/high/max only.
        loadCatalog: async () => CATALOG,
      },
    )
    const options = {
      provider: 'workbuddy',
      model: 'glm-5.3',
      messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
    } as unknown as GenerateOptions
    for await (const _chunk of adapter.stream(options)) { /* drain */ }
    // `xhigh` is outside this model's ladder, so the catalog default is used.
    expect(body!.reasoning_effort).toBe('high')
  })
})

describe('WorkBuddy stream state helper parity', () => {
  it('matches the adapter pipeline on a reasoning-then-text turn', () => {
    const state = createStreamState()
    const chunks = [
      ...processStreamLine('data: {"choices":[{"index":0,"delta":{"reasoning_content":"hmm"},"finish_reason":null}]}', state),
      ...processStreamLine('data: {"choices":[{"index":0,"delta":{"content":"yes"},"finish_reason":null}]}', state),
      ...processStreamLine('data: [DONE]', state),
    ]
    expect(chunks.filter((c) => c.type === 'reasoning-delta')).toHaveLength(1)
    expect(chunks.filter((c) => c.type === 'text-delta')).toHaveLength(1)
    expect(closeStream(state)).toEqual([])
  })
})
