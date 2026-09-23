import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '../src/host/common/llm-compat.ts'
import {
  ZhipuAdapter,
  classifyFailure,
  readErrorCode,
  resolveDefaultReasoningEffort,
} from '../src/host/zhipu/adapter.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  parseZhipuCredentials,
  zhipuAccountKey,
  zhipuKeyHint,
} from '../src/host/zhipu/token-store.ts'
import {
  buildChatRequest,
  closeStream,
  createStreamState,
  processStreamLine,
} from '../src/host/zhipu/mapper.ts'
import {
  FALLBACK_MODELS,
  ZHIPU_MODELS,
  resolveZhipuModel,
  zhipuModelSupportsImage,
  zhipuReasoningEfforts,
} from '../src/host/zhipu/model-catalog.ts'
import {
  parseCatalogModels,
  parsePlan,
  parseQuotaLimits,
  quotaMeters,
  quotaWindows,
  readEnvelopeError,
  windowMinutesOf,
  zhipuHeaders,
  zhipuMonitorHeaders,
} from '../src/host/zhipu/client.ts'
import { convergeZhipuEffort } from '../src/shared/zhipu-contracts.ts'
import { ERROR_CODE, regionForBaseUrl } from '../src/host/zhipu/types.ts'
import {
  createZhipuCredentialStore,
  makeZhipuFetch,
  zhipuSettingsFile,
  temporaryDirs,
} from './support/zhipu-fixtures.ts'

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirs.splice(0).map(async (dir) => {
    const fs = await import('node:fs/promises')
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }))
})

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

describe('zhipu credentials', () => {
  it('derives the base URL from the region rather than trusting the payload', () => {
    const cn = parseZhipuCredentials({ apiKey: 'k-1', region: 'cn', apiBase: 'https://evil.test' })
    expect(cn.apiBase).toBe('https://open.bigmodel.cn')
    const intl = parseZhipuCredentials({ apiKey: 'k-1', region: 'intl' })
    expect(intl.apiBase).toBe('https://api.z.ai')
  })

  it('defaults an unstated region to the international deployment', () => {
    expect(parseZhipuCredentials({ apiKey: 'k-1' }).region).toBe('intl')
  })

  it('rejects a payload with no usable key', () => {
    expect(() => parseZhipuCredentials({ apiKey: '   ' })).toThrow(/missing its API key/)
    expect(() => parseZhipuCredentials('not-an-object')).toThrow(/invalid/)
  })

  it('keeps the key out of the account id and the displayed hint', () => {
    const credentials = parseZhipuCredentials({ apiKey: 'super-secret-key-9f2c', region: 'intl' })
    const id = zhipuAccountKey(credentials)
    expect(id).not.toContain('super-secret-key')
    expect(zhipuKeyHint(credentials.apiKey)).toBe('••••9f2c')
    // Two keys on one console must stay distinguishable, and the same key on
    // two deployments must not collide.
    expect(zhipuAccountKey(credentials)).not.toBe(zhipuAccountKey({ apiKey: 'super-secret-key-1111', region: 'intl' }))
    expect(zhipuAccountKey(credentials)).not.toBe(zhipuAccountKey({ apiKey: credentials.apiKey, region: 'cn' }))
  })

  it('round-trips through the encrypted store and clears it on delete', async () => {
    const store = await createZhipuCredentialStore()
    const credentials = parseZhipuCredentials({ apiKey: 'key-abc-1234', region: 'cn' })
    await store.write(credentials)
    const restored = await store.read()
    expect(restored?.apiKey).toBe('key-abc-1234')
    expect(restored?.region).toBe('cn')
    expect(restored?.apiBase).toBe('https://open.bigmodel.cn')
    await store.delete()
    expect(await store.read()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

describe('zhipu model catalog', () => {
  it('declares capabilities per model rather than by family name', () => {
    // The GLM-5.x split runs inside one family: flash takes images, the
    // flagship does not. Inferring from the name cannot express this.
    expect(zhipuModelSupportsImage('glm-5.3-flash')).toBe(true)
    expect(zhipuModelSupportsImage('glm-5.3')).toBe(false)
    expect(zhipuModelSupportsImage('glm-5.2')).toBe(false)
    // Nor can it express the ladder: 5.3 has three rungs, 5.2 has two.
    expect(zhipuReasoningEfforts('glm-5.3')).toEqual(['low', 'high', 'max'])
    expect(zhipuReasoningEfforts('glm-5.2')).toEqual(['high', 'max'])
    // A toggle-reasoning model takes no effort field at all.
    expect(zhipuReasoningEfforts('glm-4.7')).toEqual([])
  })

  it('gives an unknown model a conservative stub that claims nothing', () => {
    const unknown = resolveZhipuModel('glm-9.9-unreleased')
    expect(unknown.supportsImage).toBe(false)
    expect(unknown.reasoningEfforts).toEqual([])
    expect(unknown.id).toBe('glm-9.9-unreleased')
  })

  it('merges a live window over the shipped entry and keeps declared capabilities', () => {
    const live = parseCatalogModels({
      data: [
        { id: 'glm-5.3', context_window: 2_000_000 },
        { id: 'glm-5.3-flash' },
        { id: 'brand-new-model', context_window: 300_000 },
      ],
    }, 'intl')
    const flagship = live.find((model) => model.id === 'glm-5.3')!
    expect(flagship.contextWindow).toBe(2_000_000)
    // The window moved but the ladder is a declared fact the listing does not state.
    expect(flagship.reasoningEfforts).toEqual(['low', 'high', 'max'])
    // A listing entry with no window keeps the shipped one.
    expect(live.find((model) => model.id === 'glm-5.3-flash')!.contextWindow).toBe(1_000_000)
    // An entry newer than the shipped table claims nothing it did not state.
    const fresh = live.find((model) => model.id === 'brand-new-model')!
    expect(fresh.reasoningEfforts).toEqual([])
    expect(fresh.supportsImage).toBe(false)
  })

  it('falls back to the shipped table when the live listing is unusable', () => {
    expect(parseCatalogModels({}, 'intl')).toEqual([])
    expect(FALLBACK_MODELS).toBe(ZHIPU_MODELS)
  })
})

// ---------------------------------------------------------------------------
// Headers and envelope
// ---------------------------------------------------------------------------

describe('zhipu wire headers', () => {
  it('uses the bearer form on the model surface and the raw key on the monitor surface', () => {
    // Measured against both hosted deployments: the monitor routes authenticate
    // the raw key and reject the prefixed form, while the model route documents
    // the prefix. Sending one form to both surfaces fails one of them.
    expect(zhipuHeaders({ apiKey: 'secret' }).authorization).toBe('Bearer secret')
    expect(zhipuMonitorHeaders('secret').authorization).toBe('secret')
  })

  it('reads the platform envelope so a business refusal is not mistaken for success', () => {
    expect(readEnvelopeError({ code: 401, msg: 'token expired', success: false })).toEqual({ code: 401, message: 'token expired' })
    // HTTP 200 with `success: false` is how these routes report a rejected key.
    expect(readEnvelopeError({ success: true, data: {} })).toBeNull()
    expect(readEnvelopeError({ data: {}, code: 0 })).toBeNull()
  })

  it('resolves the deployment from the base URL and the region name', () => {
    expect(regionForBaseUrl('https://open.bigmodel.cn')).toBe('cn')
    expect(regionForBaseUrl('https://api.z.ai')).toBe('intl')
    expect(regionForBaseUrl(undefined)).toBe('intl')
  })
})

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

describe('zhipu quota parsing', () => {
  it('maps the documented window combinations to their real lengths', () => {
    // unit 3 x number 5 is the plan's 5-hour credit window, unit 6 x number 1
    // is its weekly one; both are the combinations the plan's own page shows.
    expect(windowMinutesOf(3, 5)).toBe(300)
    expect(windowMinutesOf(6, 1)).toBe(10_080)
    expect(windowMinutesOf(undefined, 5)).toBeNull()
  })

  it('labels a 5-hour and a weekly window the way the plan states them', () => {
    const limits = parseQuotaLimits({
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 40.5, currentValue: 12_500_000, usage: 40_000_000, nextResetTime: 1_800_000_000_000 },
          { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 52, currentValue: 31_000_000, usage: 60_000_000, nextResetTime: 1_800_500_000_000 },
          { type: 'TIME_LIMIT', percentage: 12.3, currentValue: 123, usage: 1_000 },
        ],
      },
    })
    const windows = quotaWindows(limits)
    expect(windows.map((window) => window.label)).toEqual(['5 小时额度', '每周额度'])
    expect(windows[0]!.usedFraction).toBeCloseTo(0.405, 5)
    expect(windows[0]!.remainingFraction).toBeCloseTo(0.595, 5)
    expect(windows[0]!.used).toBe('12500000')
    expect(windows[0]!.limit).toBe('40000000')
    expect(windows[0]!.resetsAt).toBe(1_800_000_000_000)

    const meters = quotaMeters(windows, limits)
    // The tool allowance is a meter of its own, not a window.
    expect(meters.map((meter) => meter.id)).toEqual(['tokens-3-5', 'tokens-6-1', 'tools-month'])
    expect(meters[2]!.label).toContain('MCP')
  })

  it('accepts the newer CREDIT_LIMIT spelling of the same window', () => {
    // The platform renamed the entry; a card pinned to one spelling would
    // report "no rate limits" for a live account.
    const limits = parseQuotaLimits({
      data: { limits: [{ type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 10 }] },
    })
    expect(quotaWindows(limits)).toHaveLength(1)
    expect(quotaWindows(limits)[0]!.usedFraction).toBeCloseTo(0.1, 5)
  })

  it('reports no windows rather than zero usage when the payload has none', () => {
    expect(quotaWindows(parseQuotaLimits({ data: { limits: [] } }))).toEqual([])
    expect(quotaMeters([], []).filter((meter) => meter.id !== 'tools-month')).toEqual([])
  })

  it('reads the plan line but never lets it be required', () => {
    expect(parsePlan({ data: { planName: 'GLM Coding Pro', planLevel: 'pro', expireTime: 1_800_000_000_000 } }))
      .toEqual({ planName: 'GLM Coding Pro', planLevel: 'pro', renewsAt: 1_800_000_000_000 })
    // A seconds-based timestamp is scaled so the card cannot render 1970.
    expect(parsePlan({ data: { planLevel: 'lite', renewTime: 1_800_000_000 } }).renewsAt).toBe(1_800_000_000_000)
    expect(parsePlan({}).planName).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Reasoning effort
// ---------------------------------------------------------------------------

describe('zhipu reasoning effort', () => {
  it('converges a level DSH can name but this provider cannot', () => {
    // DSH's vocabulary is wider than the plan's; sending `medium` verbatim is
    // an error upstream, so it has to land on a real rung.
    expect(convergeZhipuEffort('medium', ['low', 'high', 'max'])).toBe('high')
    expect(convergeZhipuEffort('minimal', ['low', 'high', 'max'])).toBe('low')
    expect(convergeZhipuEffort('xhigh', ['low', 'high', 'max'])).toBe('max')
    expect(convergeZhipuEffort('max', ['high', 'max'])).toBe('max')
    // A model with no ladder yields nothing to converge onto.
    expect(convergeZhipuEffort('high', [])).toBeNull()
  })

  it('resolves a configured default onto the model ladder and skips a toolless model', () => {
    expect(resolveDefaultReasoningEffort(['low', 'high', 'max'], 'medium')).toBe('high')
    expect(resolveDefaultReasoningEffort(['low', 'high', 'max'], null)).toBeUndefined()
    expect(resolveDefaultReasoningEffort([], 'high')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

describe('zhipu request building', () => {
  const options: GenerateOptions = {
    provider: 'zhipu-coding-plan',
    model: 'glm-5.3',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  }

  it('always streams and never sends an undocumented stream_options field', () => {
    const body = buildChatRequest(options, undefined, ['low', 'high', 'max'])
    expect(body.stream).toBe(true)
    // The provider's streaming docs show usage arriving without it, and the
    // field is absent from the documented schema.
    expect(body).not.toHaveProperty('stream_options')
  })

  it('omits reasoning_effort unless the model declares it, and never disables thinking', () => {
    // A declared level is sent; an undeclared one is withheld rather than
    // guessed, because the provider errors on an unsupported value.
    const sent = buildChatRequest({ ...options, reasoningEffort: 'max' as never }, undefined, ['low', 'high', 'max'])
    expect(sent.reasoning_effort).toBe('max')
    const withheld = buildChatRequest({ ...options, reasoningEffort: 'medium' as never }, undefined, ['low', 'high', 'max'])
    expect(withheld).not.toHaveProperty('reasoning_effort')
    const toolless = buildChatRequest({ ...options, reasoningEffort: 'max' as never }, undefined, [])
    expect(toolless).not.toHaveProperty('reasoning_effort')
    // GLM-5.3 rejects `thinking.type: "disabled"`, so this route never sends a
    // disabling value; omitting the field is the enabled default.
    expect(sent).not.toHaveProperty('thinking')
  })

  it('maps tools and a tool result run onto the OpenAI shape', () => {
    const body = buildChatRequest({
      ...options,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'call_1', name: 'get_weather', arguments: { city: 'Beijing' } } as never],
        },
        {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'sunny' }] } as never],
          source: { kind: 'tool' },
        },
      ],
      tools: [{ name: 'get_weather', description: 'Get weather', parameters: { $schema: 'x', type: 'object' } }],
    }, undefined, [])
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages[1]!.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Beijing"}' } },
    ])
    expect(messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: 'sunny' })
    expect((body.tools as Array<Record<string, unknown>>)[0]!.function).toMatchObject({ name: 'get_weather' })
    // A meta-schema keyword the gateway rejects is stripped.
    expect((body.tools as Array<{ function: { parameters: Record<string, unknown> } }>)[0]!.function.parameters)
      .not.toHaveProperty('$schema')
  })

  it('carries a system prompt when the caller supplied one and omits it otherwise', () => {
    const withSystem = buildChatRequest({ ...options, system: 'be terse' }, undefined, [])
    expect((withSystem.messages as Array<Record<string, unknown>>)[0]).toEqual({ role: 'system', content: 'be terse' })
    // This endpoint does not require a leading system turn, unlike the sibling
    // subscription backend, so nothing is synthesized.
    const without = buildChatRequest(options, undefined, [])
    expect((without.messages as Array<Record<string, unknown>>)[0]!.role).toBe('user')
  })
})

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

describe('zhipu stream mapping', () => {
  it('emits reasoning_content as its own reasoning block', () => {
    const state = createStreamState()
    const chunks = [
      ...processStreamLine('data: {"choices":[{"delta":{"reasoning_content":"think "}}]}', state),
      ...processStreamLine('data: {"choices":[{"delta":{"reasoning_content":"harder"}}]}', state),
      ...processStreamLine('data: {"choices":[{"delta":{"content":"answer"}}]}', state),
    ]
    expect(chunks.filter((chunk) => chunk.type === 'reasoning-delta')).toEqual([
      { type: 'reasoning-delta', index: 0, text: 'think ' },
      { type: 'reasoning-delta', index: 0, text: 'harder' },
    ])
    const text = chunks.find((chunk) => chunk.type === 'text-delta')
    expect(text).toEqual({ type: 'text-delta', index: 1, text: 'answer' })
  })

  it('reports disjoint usage counts', () => {
    const state = createStreamState()
    processStreamLine('data: {"choices":[{"delta":{"content":"hi"}}]}', state)
    processStreamLine(
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":40},"completion_tokens_details":{"reasoning_tokens":7}}}',
      state,
    )
    const usage = closeStream(state).find((chunk) => chunk.type === 'usage')
    expect(usage).toEqual({
      type: 'usage',
      usage: { inputTokens: 60, outputTokens: 20, cacheReadTokens: 40, reasoningTokens: 7 },
    })
  })

  it('finishes on [DONE] and refuses to present a truncated stream as complete', () => {
    const done = createStreamState()
    processStreamLine('data: {"choices":[{"delta":{"content":"hi"}}]}', done)
    const terminal = processStreamLine('data: [DONE]', done)
    expect(terminal.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })

    const truncated = createStreamState()
    processStreamLine('data: {"choices":[{"delta":{"content":"half"}}]}', truncated)
    expect(truncated.finished).toBe(false)
    expect(truncated.done).toBe(false)
    expect(truncated.finishReason).toBeNull()
  })

  it('surfaces an error frame rather than flushing a clean stop', () => {
    const state = createStreamState()
    expect(() => processStreamLine('data: {"error":{"message":"model overloaded"}}', state))
      .toThrow(/model overloaded/)
  })
})

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

describe('zhipu failure classification', () => {
  it('reads the platform business code out of the body', () => {
    expect(readErrorCode('{"code":1310,"msg":"Weekly/Monthly Limit Exhausted"}')).toBe(1310)
    expect(readErrorCode('no code here')).toBeNull()
  })

  it('treats a rejected key as permanent', () => {
    for (const status of [401, 403]) {
      expect(classifyFailure(status, '').code).toBe('INVALID_CREDENTIAL')
    }
    // The same verdict also arrives as HTTP 200 with a business code.
    expect(classifyFailure(200, `{"code":${ERROR_CODE.AUTH_INVALID}}`).code).toBe('INVALID_CREDENTIAL')
  })

  it('separates a spent window from a gap the plan will never close', () => {
    // All four are 429 upstream, but only the first two are worth retrying.
    const spent = classifyFailure(429, `{"code":${ERROR_CODE.PLAN_LIMIT}}`)
    expect(spent.code).toBe('RATE_LIMIT')
    expect(classifyFailure(429, `{"code":${ERROR_CODE.USAGE_LIMIT}}`).code).toBe('RATE_LIMIT')
    expect(classifyFailure(429, `{"code":${ERROR_CODE.MODEL_NOT_IN_PLAN}}`).code).toBe('PROVIDER_ERROR')
    expect(classifyFailure(429, `{"code":${ERROR_CODE.PLAN_EXPIRED}}`).code).toBe('PROVIDER_ERROR')
  })

  it('honours a provider-requested delay on a rate limit', () => {
    const headers = new Headers({ 'retry-after': '42' })
    const failure = classifyFailure(429, '', headers)
    expect(failure.code).toBe('RATE_LIMIT')
    // The delay rides the structured failure facts, which is where the DSH
    // retry policy reads it from.
    expect(failure.failure).toMatchObject({ providerRetryAfterMs: 42_000 })
  })

  it('treats a rejected parameter and an unknown model as request problems', () => {
    expect(classifyFailure(400, `{"code":${ERROR_CODE.INVALID_PARAM}}`).code).toBe('PROVIDER_ERROR')
    expect(classifyFailure(400, `{"code":${ERROR_CODE.UNKNOWN_MODEL}}`).code).toBe('PROVIDER_ERROR')
    expect(classifyFailure(400, `{"code":${ERROR_CODE.PROMPT_TOO_LONG}}`).message).toContain('context window')
  })

  it('retries a server fault and an overload alike', () => {
    expect(classifyFailure(503, '').code).toBe('SERVER')
    expect(classifyFailure(500, `{"code":1230}`).code).toBe('SERVER')
    expect(classifyFailure(429, `{"code":${ERROR_CODE.OVERLOADED}}`).code).toBe('RATE_LIMIT')
  })
})

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

describe('zhipu adapter', () => {
  /**
   * An adapter whose settings come from the file store the test writes to.
   *
   * No preference stub is passed: the adapter would otherwise read the stub
   * instead of the file, and an override written by the test would silently not
   * be the override the adapter sees.
   */
  function makeAdapter(fetchFn: typeof fetch, modelSettings: FileModelSettingsStore, store: FileCredentialStore): ZhipuAdapter {
    return new ZhipuAdapter(
      store,
      modelSettings,
      undefined,
      { fetchFn, loadCatalog: async () => [...ZHIPU_MODELS] },
    )
  }

  async function mount() {
    const store = await createZhipuCredentialStore({
      credentials: parseZhipuCredentials({ apiKey: 'key-abc-1234', region: 'intl' }),
    })
    const settings = new FileModelSettingsStore(await zhipuSettingsFile())
    return { store, settings }
  }

  function streamResponse(): Response {
    const body = [
      'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}',
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}',
      'data: [DONE]',
      '',
    ].join('\n\n')
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }

  it('lists only the models the account region serves', async () => {
    const { store, settings } = await mount()
    const fetchFn = makeZhipuFetch(() => streamResponse())
    const adapter = makeAdapter(fetchFn, settings, store)
    const models = await adapter.listModels()
    expect(models.map((model) => model.id)).toContain('glm-5.3')
    // Capabilities come from the table, so the flash model advertises images.
    expect(models.find((model) => model.id === 'glm-5.3-flash')!.inputModalities).toEqual(['text', 'image'])
    expect(models.find((model) => model.id === 'glm-5.3')!.inputModalities).toEqual(['text'])
  })

  it('resolves a model with its declared ladder and honours a context override', async () => {
    const { store, settings } = await mount()
    await settings.updateSettings({ contextWindowOverrides: { 'glm-5.3': 500_000 }, defaultReasoningEffort: 'low' })
    const adapter = makeAdapter(makeZhipuFetch(() => streamResponse()), settings, store)
    const resolved = await adapter.resolveModel('zhipu-coding-plan', 'glm-5.3')
    expect(resolved.context?.contextWindow).toBe(500_000)
    expect(resolved.reasoning?.defaultEffort).toBe('low')
    expect(resolved.reasoning?.efforts.map((effort) => effort.id)).toEqual(['low', 'high', 'max'])
    expect(resolved.defaultMaxTokens).toBe(131_072)
  })

  it('posts to the Coding Plan surface with the bearer header and streams the answer', async () => {
    const { store, settings } = await mount()
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchFn = makeZhipuFetch((url, init) => {
      calls.push({ url, init: init as RequestInit })
      return streamResponse()
    })
    const adapter = makeAdapter(fetchFn, settings, store)
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'zhipu-coding-plan',
      model: 'glm-5.3',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) chunks.push(chunk)

    expect(calls[0]!.url).toBe('https://api.z.ai/api/coding/paas/v4/chat/completions')
    expect(new Headers(calls[0]!.init.headers as HeadersInit).get('authorization')).toBe('Bearer key-abc-1234')
    expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 0, text: 'thinking' })
    expect(chunks).toContainEqual({ type: 'text-delta', index: 1, text: 'hi' })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('fails with a missing-credential error when nothing is signed in', async () => {
    const store = await createZhipuCredentialStore()
    const settings = new FileModelSettingsStore(await zhipuSettingsFile())
    const adapter = makeAdapter(makeZhipuFetch(() => streamResponse()), settings, store)
    await expect(async () => {
      for await (const _chunk of adapter.stream({
        provider: 'zhipu-coding-plan',
        model: 'glm-5.3',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })) { /* drain */ }
    }).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('classifies an HTTP failure from the real request path', async () => {
    const { store, settings } = await mount()
    const fetchFn = makeZhipuFetch(() => new Response(JSON.stringify({ code: 1310, msg: 'Weekly Limit Exhausted' }), { status: 429 }))
    const adapter = makeAdapter(fetchFn, settings, store)
    await expect(async () => {
      for await (const _chunk of adapter.stream({
        provider: 'zhipu-coding-plan',
        model: 'glm-5.3',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })) { /* drain */ }
    }).rejects.toMatchObject({ code: 'RATE_LIMIT' })
  })
})
