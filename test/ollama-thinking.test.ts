import { describe, expect, it, vi } from 'vitest'
import { buildBody, fetchModelThinking } from '../src/host/ollama/client.ts'
import { OllamaAdapter, toOllamaRequest } from '../src/host/ollama/adapter.ts'
import {
  reasoningEffortsForModel,
  resolveOllamaDefaultEffort,
  thinkForModel,
  type OllamaThinkingCapability,
} from '../src/host/ollama/types.ts'

const CREDENTIALS = { apiKey: 'sk-test' }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function sse(frames: unknown[]): Response {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** The `/api/show` answers for one adapter: a model id, or the refusal it draws. */
type ShowStub = Record<string, () => Response>

interface AdapterFixture {
  adapter: OllamaAdapter
  /** Every model id `/api/show` was asked about, in order. */
  showCalls: string[]
  /** Every body the chat surface was sent. */
  bodies: Record<string, unknown>[]
}

function makeAdapter(options: {
  catalog: string[]
  show: ShowStub
  defaultReasoningEffort?: string | null
  credentials?: { apiKey: string } | null
}): AdapterFixture {
  const showCalls: string[] = []
  const bodies: Record<string, unknown>[] = []
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/show')) {
      const modelId = (JSON.parse(String(init?.body)) as { model: string }).model
      showCalls.push(modelId)
      const answer = options.show[modelId]
      // A model with no stub is a model the service says nothing about.
      return answer === undefined ? json({ details: {} }) : answer()
    }
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return sse([{ choices: [{ delta: { content: 'ok' } }] }])
  }) as unknown as typeof fetch
  const store = {
    read: vi.fn(async () => (options.credentials === null ? null : options.credentials ?? CREDENTIALS)),
    write: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  }
  const settings = {
    enabled: true,
    enabledModelIds: null,
    catalogModels: options.catalog.map((id) => ({ id })),
    defaultReasoningEffort: options.defaultReasoningEffort ?? null,
  }
  const modelSettings = {
    read: vi.fn(async () => settings),
    status: vi.fn(() => settings),
    update: vi.fn(async () => settings),
    storeCatalog: vi.fn(async () => settings),
  }
  const adapter = new OllamaAdapter(store as never, modelSettings as never, {
    fetchFn,
    loadCatalog: async () => options.catalog.map((id) => ({ id })),
  })
  return { adapter, showCalls, bodies }
}

function generateOptions(overrides: Record<string, unknown> = {}): never {
  return {
    provider: 'ollama',
    model: 'gpt-oss:120b',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    ...overrides,
  } as never
}

async function drain(adapter: OllamaAdapter, overrides: Record<string, unknown> = {}): Promise<void> {
  const chunks: unknown[] = []
  for await (const chunk of adapter.stream(generateOptions(overrides))) chunks.push(chunk)
  expect(chunks.length).toBeGreaterThan(0)
}

describe('ollama reasoning ladder from model metadata', () => {
  it('offers gpt-oss its three levels, cloud name included, when the probe cannot answer', async () => {
    // The prefix list is the fallback for a model whose metadata could not be
    // read, and the cloud suffix (gpt-oss:120b-cloud) has to keep hitting it.
    const { adapter, showCalls } = makeAdapter({
      catalog: ['gpt-oss:120b', 'gpt-oss:120b-cloud'],
      show: {
        'gpt-oss:120b': () => json({ error: 'model not found' }, 404),
        'gpt-oss:120b-cloud': () => { throw new Error('ECONNRESET') },
      },
    })

    const local = await adapter.resolveModel('ollama', 'gpt-oss:120b')
    expect(local.reasoning?.efforts.map((effort) => effort.id)).toEqual(['low', 'medium', 'high'])
    expect(local.reasoning?.defaultEffort).toBe('low')

    const cloud = await adapter.resolveModel('ollama', 'gpt-oss:120b-cloud')
    expect(cloud.reasoning?.efforts.map((effort) => effort.id)).toEqual(['low', 'medium', 'high'])
    // The failed probes were made, not cached as an answer.
    expect(showCalls).toEqual(['gpt-oss:120b', 'gpt-oss:120b-cloud'])
  })

  it('offers a boolean thinking model on and off, and sends think:false when the user turns it off', async () => {
    const { adapter, bodies } = makeAdapter({
      catalog: ['deepseek-r1:70b'],
      show: { 'deepseek-r1:70b': () => json({ thinking: { values: [true, false], default: true } }) },
    })

    const resolved = await adapter.resolveModel('ollama', 'deepseek-r1:70b')
    expect(resolved.reasoning?.efforts.map((effort) => effort.id)).toEqual(['none', 'low'])
    expect(resolved.reasoning?.efforts.map((effort) => effort.name)).toEqual(['关闭思考', '开启思考'])
    // The model says it thinks by default, and the ladder has no other on/off id.
    expect(resolved.reasoning?.defaultEffort).toBe('low')

    const request = await toOllamaRequest(
      generateOptions({ model: 'deepseek-r1:70b', reasoningEffort: 'none' }),
      undefined,
      undefined,
      { values: [true, false] },
    )
    expect(request.think).toBe(false)
    expect((buildBody('native', request) as { think?: unknown }).think).toBe(false)

    // The same choice through the adapter, on the surface it actually routes to.
    await drain(adapter, { model: 'deepseek-r1:70b', reasoningEffort: 'none' })
    expect(bodies[0]?.reasoning_effort).toBe('none')
  })

  it('offers no ladder at all for a model the service says nothing about', async () => {
    const { adapter } = makeAdapter({
      catalog: ['llama3:8b'],
      show: { 'llama3:8b': () => json({ details: { family: 'llama', parameter_size: '8B' } }) },
    })

    const resolved = await adapter.resolveModel('ollama', 'llama3:8b')
    expect('reasoning' in resolved).toBe(false)
  })

  it('takes the ladder from the metadata of a family the prefix list has never seen', async () => {
    const { adapter, bodies } = makeAdapter({
      catalog: ['glm-4.6:cloud'],
      show: { 'glm-4.6:cloud': () => json({ thinking: { values: ['low', 'high'], default: 'high' } }) },
    })

    const resolved = await adapter.resolveModel('ollama', 'glm-4.6:cloud')
    expect(resolved.reasoning?.efforts.map((effort) => effort.id)).toEqual(['low', 'high'])
    expect(resolved.reasoning?.defaultEffort).toBe('high')

    const request = await toOllamaRequest(
      generateOptions({ model: 'glm-4.6:cloud', reasoningEffort: 'high' }),
      undefined,
      undefined,
      { values: ['low', 'high'] },
    )
    expect(request.think).toBe('high')
    expect((buildBody('native', request) as { think?: unknown }).think).toBe('high')

    await drain(adapter, { model: 'glm-4.6:cloud', reasoningEffort: 'high' })
    expect(bodies[0]?.reasoning_effort).toBe('high')
  })

  it('offers no ladder when the service says the model cannot think', async () => {
    const { adapter } = makeAdapter({
      catalog: ['qwen2.5:7b'],
      show: { 'qwen2.5:7b': () => json({ thinking: { values: [false] } }) },
    })

    const resolved = await adapter.resolveModel('ollama', 'qwen2.5:7b')
    expect('reasoning' in resolved).toBe(false)
  })

  it('resolves models anyway when the metadata read fails in every way', async () => {
    const failures: Record<string, () => Response> = {
      'network:down': () => { throw new TypeError('fetch failed') },
      'http:401': () => json({ error: 'unauthorized' }, 401),
      'http:500': () => json({ error: 'boom' }, 500),
      'json:garbage': () => new Response('<html>captive portal</html>', { status: 200 }),
      'json:not-an-object': () => new Response('null', { status: 200 }),
      'thinking:not-an-object': () => json({ thinking: 'yes' }),
      'values:not-an-array': () => json({ thinking: { values: 'low' } }),
      'values:only-junk': () => json({ thinking: { values: [null, 7, ''] } }),
    }

    for (const [label, failure] of Object.entries(failures)) {
      const { adapter } = makeAdapter({ catalog: ['llama3:8b'], show: { 'llama3:8b': failure } })
      const resolved = await adapter.resolveModel('ollama', 'llama3:8b')
      expect(resolved.id, label).toBe('llama3:8b')
      expect('reasoning' in resolved, label).toBe(false)
    }
  })

  it('converges a stored level this model cannot express onto one it can', async () => {
    // A stored default is a per-route preference, not a per-model promise: the
    // settings card offers one ladder for the whole line.
    const boolean = makeAdapter({
      catalog: ['deepseek-r1:70b'],
      show: { 'deepseek-r1:70b': () => json({ thinking: { values: [true, false] } }) },
      defaultReasoningEffort: 'high',
    })
    const booleanResolved = await boolean.adapter.resolveModel('ollama', 'deepseek-r1:70b')
    expect(booleanResolved.reasoning?.efforts.map((effort) => effort.id)).toEqual(['none', 'low'])
    expect(booleanResolved.reasoning?.defaultEffort).toBe('low')

    const levels = makeAdapter({
      catalog: ['gpt-oss:120b'],
      show: { 'gpt-oss:120b': () => json({ error: 'nope' }, 500) },
      defaultReasoningEffort: 'xhigh',
    })
    const levelsResolved = await levels.adapter.resolveModel('ollama', 'gpt-oss:120b')
    expect(levelsResolved.reasoning?.defaultEffort).toBe('low')

    // A configured level the model does have is left alone.
    const kept = makeAdapter({
      catalog: ['glm-4.6:cloud'],
      show: { 'glm-4.6:cloud': () => json({ thinking: { values: ['low', 'high'], default: 'high' } }) },
      defaultReasoningEffort: 'low',
    })
    expect((await kept.adapter.resolveModel('ollama', 'glm-4.6:cloud')).reasoning?.defaultEffort).toBe('low')
  })

  it('sends the stored default when the caller states no level', async () => {
    const { adapter, bodies } = makeAdapter({
      catalog: ['glm-4.6:cloud'],
      show: { 'glm-4.6:cloud': () => json({ thinking: { values: ['low', 'high'], default: 'high' } }) },
      defaultReasoningEffort: 'high',
    })

    await drain(adapter, { model: 'glm-4.6:cloud' })
    expect(bodies[0]?.reasoning_effort).toBe('high')
  })

  it('drops an unexpressible stored level instead of failing the turn', async () => {
    // The user picked "high" on the settings card; this model declares it takes
    // booleans only. The level is dropped - not coerced into the on position, which
    // would be asking the model for a value it never declared - so the service
    // applies its own default and the turn runs.
    const { adapter, bodies } = makeAdapter({
      catalog: ['deepseek-r1:70b'],
      show: { 'deepseek-r1:70b': () => json({ thinking: { values: [true, false], default: true } }) },
      defaultReasoningEffort: 'high',
    })

    await drain(adapter, { model: 'deepseek-r1:70b' })
    expect(bodies[0]?.reasoning_effort).toBeUndefined()
  })

  it('offers no off switch to a model that declared it cannot switch thinking off', async () => {
    // values: [true] is a model that thinks and takes no false. Offering the off
    // position would put `false` on the wire for a model that never declared it.
    const declared: OllamaThinkingCapability = { values: [true] }
    const { adapter } = makeAdapter({
      catalog: ['deepseek-r1:70b'],
      show: { 'deepseek-r1:70b': () => json({ thinking: declared }) },
    })

    const resolved = await adapter.resolveModel('ollama', 'deepseek-r1:70b')
    expect(resolved.reasoning?.efforts.map((effort) => effort.id)).toEqual(['low'])
    expect(resolved.reasoning?.efforts.map((effort) => effort.name)).toEqual(['开启思考'])
    // Nothing else to converge onto: the one position it has is the default.
    expect(resolved.reasoning?.defaultEffort).toBe('low')
    expect(thinkForModel('deepseek-r1:70b', 'none', declared)).toBeUndefined()
    expect(thinkForModel('deepseek-r1:70b', 'low', declared)).toBe(true)

    // And through the wire: the off position sends nothing, the on one sends true.
    const off = await toOllamaRequest(generateOptions({ model: 'deepseek-r1:70b', reasoningEffort: 'none' }), undefined, undefined, declared)
    expect(off.think).toBeUndefined()
    expect('think' in (buildBody('native', off) as Record<string, unknown>)).toBe(false)
    const on = await toOllamaRequest(generateOptions({ model: 'deepseek-r1:70b', reasoningEffort: 'low' }), undefined, undefined, declared)
    expect(on.think).toBe(true)
    expect((buildBody('native', on) as { think?: unknown }).think).toBe(true)
  })

  it('sends true for the only position a [true] model declares', async () => {
    const { adapter, bodies } = makeAdapter({
      catalog: ['deepseek-r1:70b'],
      show: { 'deepseek-r1:70b': () => json({ thinking: { values: [true] } }) },
      defaultReasoningEffort: 'low',
    })

    await drain(adapter, { model: 'deepseek-r1:70b' })
    expect(bodies[0]?.reasoning_effort).toBe('auto')
  })

  it('offers the same on/off ladder whichever order the booleans are declared in', async () => {
    for (const values of [[true, false], [false, true]] as const) {
      const declared: OllamaThinkingCapability = { values: [...values] }
      expect(reasoningEffortsForModel('deepseek-r1:70b', declared).map((effort) => effort.id), values.join()).toEqual(['none', 'low'])
      expect(thinkForModel('deepseek-r1:70b', 'none', declared), values.join()).toBe(false)
      expect(thinkForModel('deepseek-r1:70b', 'low', declared), values.join()).toBe(true)

      const { adapter } = makeAdapter({
        catalog: ['deepseek-r1:70b'],
        show: { 'deepseek-r1:70b': () => json({ thinking: declared }) },
      })
      const resolved = await adapter.resolveModel('ollama', 'deepseek-r1:70b')
      expect(resolved.reasoning?.efforts.map((effort) => effort.id), values.join()).toEqual(['none', 'low'])
    }
  })

  it('keeps declared levels and a declared off switch side by side', async () => {
    // A mixed declaration: two levels the model names, plus false as the switch
    // that leaves thinking off. All three positions, each with its own value.
    const declared: OllamaThinkingCapability = { values: ['low', 'high', false] }
    const { adapter, bodies } = makeAdapter({
      catalog: ['glm-4.6:cloud'],
      show: { 'glm-4.6:cloud': () => json({ thinking: declared }) },
    })

    const resolved = await adapter.resolveModel('ollama', 'glm-4.6:cloud')
    expect(resolved.reasoning?.efforts.map((effort) => effort.id)).toEqual(['low', 'high', 'none'])
    expect(resolved.reasoning?.efforts.map((effort) => effort.name)).toEqual(['low', 'high', '关闭思考'])
    expect(resolved.reasoning?.defaultEffort).toBe('low')

    for (const [effort, wire] of [['low', 'low'], ['high', 'high'], ['none', false]] as const) {
      const request = await toOllamaRequest(generateOptions({ model: 'glm-4.6:cloud', reasoningEffort: effort }), undefined, undefined, declared)
      expect(request.think, effort).toBe(wire)
      expect((buildBody('native', request) as { think?: unknown }).think, effort).toBe(wire)
    }
    // A level the model never declared is still nothing to send.
    const missing = await toOllamaRequest(generateOptions({ model: 'glm-4.6:cloud', reasoningEffort: 'medium' }), undefined, undefined, declared)
    expect(missing.think).toBeUndefined()

    await drain(adapter, { model: 'glm-4.6:cloud', reasoningEffort: 'none' })
    expect(bodies[0]?.reasoning_effort).toBe('none')
  })

  it('reads the metadata once per model, and re-reads after a failure', async () => {
    const { adapter, showCalls } = makeAdapter({
      catalog: ['glm-4.6:cloud', 'gpt-oss:120b'],
      show: { 'glm-4.6:cloud': () => json({ thinking: { values: ['low', 'high'] } }) },
    })

    await adapter.resolveModel('ollama', 'glm-4.6:cloud')
    await adapter.resolveModel('ollama', 'glm-4.6:cloud')
    await adapter.resolveModel('ollama', 'gpt-oss:120b')
    await adapter.resolveModel('ollama', 'glm-4.6:cloud')
    expect(showCalls).toEqual(['glm-4.6:cloud', 'gpt-oss:120b'])

    // A failed read is a transient condition, not an answer to remember.
    const failing = makeAdapter({
      catalog: ['glm-4.6:cloud'],
      show: { 'glm-4.6:cloud': () => json({ error: 'boom' }, 500) },
    })
    await failing.adapter.resolveModel('ollama', 'glm-4.6:cloud')
    await failing.adapter.resolveModel('ollama', 'glm-4.6:cloud')
    expect(failing.showCalls).toEqual(['glm-4.6:cloud', 'glm-4.6:cloud'])
  })

  it('merges concurrent reads of one model into a single probe', async () => {
    const { adapter, showCalls } = makeAdapter({
      catalog: ['glm-4.6:cloud'],
      show: { 'glm-4.6:cloud': () => json({ thinking: { values: ['low', 'high'] } }) },
    })

    const resolved = await Promise.all([
      adapter.resolveModel('ollama', 'glm-4.6:cloud'),
      adapter.resolveModel('ollama', 'glm-4.6:cloud'),
      adapter.resolveModel('ollama', 'glm-4.6:cloud'),
    ])
    expect(showCalls).toEqual(['glm-4.6:cloud'])
    for (const model of resolved) expect(model.reasoning?.efforts).toHaveLength(2)
  })

  it('skips the probe entirely when no key is stored', async () => {
    const { adapter, showCalls } = makeAdapter({
      catalog: ['gpt-oss:120b'],
      show: { 'gpt-oss:120b': () => json({ thinking: { values: ['low'] } }) },
      credentials: null,
    })

    const resolved = await adapter.resolveModel('ollama', 'gpt-oss:120b')
    expect(resolved.id).toBe('gpt-oss:120b')
    expect(resolved.reasoning?.efforts.map((effort) => effort.id)).toEqual(['low', 'medium', 'high'])
    expect(showCalls).toEqual([])
  })
})

describe('ollama thinking capability parsing', () => {
  it('reads the declared values and default', async () => {
    const declared = await fetchModelThinking(
      (async () => json({ model: 'glm-4.6:cloud', thinking: { values: ['low', 'high'], default: 'high' } })) as unknown as typeof fetch,
      CREDENTIALS,
      'glm-4.6:cloud',
    )
    expect(declared).toEqual({ values: ['low', 'high'], default: 'high' })
  })

  it('drops a default of a type the wire has no use for', async () => {
    const declared = await fetchModelThinking(
      (async () => json({ thinking: { values: ['low'], default: { level: 'high' } } })) as unknown as typeof fetch,
      CREDENTIALS,
      'glm-4.6:cloud',
    )
    expect(declared).toEqual({ values: ['low'] })
  })

  it('keeps a boolean default, and filters junk out of the values', async () => {
    const declared = await fetchModelThinking(
      (async () => json({ thinking: { values: [true, false, null, '', 3, 'High'], default: false } })) as unknown as typeof fetch,
      CREDENTIALS,
      'deepseek-r1:70b',
    )
    expect(declared).toEqual({ values: [true, false, 'High'], default: false })
  })

  it('returns undefined for every shape that is not a capability', async () => {
    const answers: Response[] = [
      json({ error: 'unauthorized' }, 401),
      json({}, 200),
      json({ thinking: null }),
      json({ thinking: [] }),
      json({ thinking: { values: [] } }),
      json({ thinking: { default: 'low' } }),
      new Response('not json at all', { status: 200 }),
    ]
    for (const answer of answers) {
      const declared = await fetchModelThinking((async () => answer) as unknown as typeof fetch, CREDENTIALS, 'm')
      expect(declared).toBeUndefined()
    }
    const thrown = await fetchModelThinking(
      (async () => { throw new Error('fetch failed') }) as unknown as typeof fetch,
      CREDENTIALS,
      'm',
    )
    expect(thrown).toBeUndefined()
  })
})

describe('ollama effort mapping rules', () => {
  it('sends a declared level in the spelling the model declared it', () => {
    const declared: OllamaThinkingCapability = { values: ['Low', 'High'] }
    expect(thinkForModel('glm-4.6:cloud', 'high', declared)).toBe('High')
    expect(thinkForModel('glm-4.6:cloud', 'LOW', declared)).toBe('Low')
    // A level this model never declared is dropped, never guessed at.
    expect(thinkForModel('glm-4.6:cloud', 'medium', declared)).toBeUndefined()
  })

  it('lets the metadata override the prefix list, and the prefix list stand alone', () => {
    expect(thinkForModel('glm-4.6:cloud', 'high', { values: ['low', 'high'] })).toBe('high')
    expect(thinkForModel('glm-4.6:cloud', 'high')).toBeUndefined()
    expect(thinkForModel('gpt-oss:120b-cloud', 'high')).toBe('high')
    expect(thinkForModel('gpt-oss:120b', 'auto')).toBe('medium')
    expect(thinkForModel('gpt-oss:120b', 'xhigh')).toBeUndefined()
    expect(thinkForModel('qwq:32b', 'medium')).toBe(true)
    expect(thinkForModel('llama3:8b', 'high', { values: [false] })).toBeUndefined()
  })

  it('builds the ladder from the mode alone', () => {
    expect(reasoningEffortsForModel('gpt-oss:120b')).toEqual([
      { id: 'low', name: 'low' },
      { id: 'medium', name: 'medium' },
      { id: 'high', name: 'high' },
    ])
    expect(reasoningEffortsForModel('deepseek-r1:70b').map((effort) => effort.id)).toEqual(['none', 'low'])
    expect(reasoningEffortsForModel('llama3:8b')).toEqual([])
    expect(reasoningEffortsForModel('glm-4.6:cloud', { values: ['minimal', 'low', 'high'] }))
      .toEqual([
        { id: 'minimal', name: 'minimal' },
        { id: 'low', name: 'low' },
        { id: 'high', name: 'high' },
      ])
    // Every id on a boolean ladder maps to a value the wire accepts.
    for (const effort of reasoningEffortsForModel('qwq:32b')) {
      expect(typeof thinkForModel('qwq:32b', effort.id)).toBe('boolean')
    }
  })

  it('resolves the default through the same mapping a request uses', () => {
    const declared: OllamaThinkingCapability = { values: [true, false], default: false }
    // A boolean default is a wire value, not an effort id: it lands on 'none'.
    expect(resolveOllamaDefaultEffort('deepseek-r1:70b', declared, 'high')).toBe('none')
    expect(resolveOllamaDefaultEffort('deepseek-r1:70b', { values: [true, false], default: true }, null)).toBe('low')
    // A level the ladder has is never overridden by the model's own default.
    expect(resolveOllamaDefaultEffort('deepseek-r1:70b', declared, 'none')).toBe('none')
    // No ladder, no default.
    expect(resolveOllamaDefaultEffort('llama3:8b', undefined, 'high')).toBeUndefined()
  })
})
