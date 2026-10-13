import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions as CompatGenerateOptions } from '../src/host/common/llm-compat.ts'
import { AntigravityAdapter, withoutValidatedToolConfig } from '../src/host/antigravity/adapter.ts'
import { AccountPoolStore } from '../src/host/antigravity/account-pool.ts'
import { catalogMaxOutputFor, effectiveModelLimits, runtimeIdsFor } from '../src/host/antigravity/catalog-limits.ts'
import { parseCatalogModels } from '../src/host/antigravity/client.ts'
import { buildRequest } from '../src/host/antigravity/mapper.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  type AntigravityCatalogModel,
} from '../src/host/antigravity/token-store.ts'
import { MODELS } from '../src/host/antigravity/types.ts'

const OPUS = MODELS.find((model) => model.id === 'claude-opus-5-5')!
const FLASH = MODELS.find((model) => model.id === 'gemini-3.8-flash')!

const TOOLS = [{
  name: 'read_file',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}]

function options(extra: Record<string, unknown> = {}): CompatGenerateOptions {
  return {
    provider: 'antigravity',
    model: OPUS.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    tools: TOOLS,
    ...extra,
  } as unknown as CompatGenerateOptions
}

function modeOf(body: Record<string, unknown>): unknown {
  return (body.request as { toolConfig?: { functionCallingConfig?: { mode?: unknown } } }).toolConfig?.functionCallingConfig?.mode
}

describe('Claude VALIDATED tool calling', () => {
  it('asks Claude runtimes for VALIDATED when no explicit choice narrows the mode', () => {
    expect(modeOf(buildRequest(options(), OPUS, 'p', 'claude-opus-5-5-medium'))).toBe('VALIDATED')
    expect(modeOf(buildRequest(options({ toolChoice: 'auto' }), OPUS, 'p', 'claude-opus-5-5-medium'))).toBe('VALIDATED')
  })

  it('keeps an explicit none / any choice as it was', () => {
    expect(modeOf(buildRequest(options({ toolChoice: 'none' }), OPUS, 'p', 'claude-opus-5-5-medium'))).toBe('NONE')
    expect(modeOf(buildRequest(options({ toolChoice: 'required' }), OPUS, 'p', 'claude-opus-5-5-medium'))).toBe('ANY')
  })

  it('leaves Gemini, tool-less requests and a switched-off flag untouched', () => {
    expect(modeOf(buildRequest(options({ model: FLASH.id }), FLASH, 'p', 'gemini-3.8-flash-tiered'))).toBeUndefined()
    expect(modeOf(buildRequest(options({ tools: undefined }), OPUS, 'p', 'claude-opus-5-5-medium'))).toBeUndefined()
    expect(modeOf(buildRequest(options(), OPUS, 'p', 'claude-opus-5-5-medium', undefined, undefined, {
      claudeValidatedToolCalling: false,
    }))).toBeUndefined()
  })

  it('strips only a VALIDATED tool config', () => {
    const validated = JSON.stringify(buildRequest(options(), OPUS, 'p', 'claude-opus-5-5-medium'))
    const stripped = JSON.parse(withoutValidatedToolConfig(validated)!)
    expect(stripped.request.toolConfig).toBeUndefined()
    expect(stripped.request.tools).toEqual(JSON.parse(validated).request.tools)
    expect(withoutValidatedToolConfig(JSON.stringify(buildRequest(options({ toolChoice: 'none' }), OPUS, 'p', 'claude-opus-5-5-medium')))).toBeUndefined()
    expect(withoutValidatedToolConfig('not json')).toBeUndefined()
  })
})

function harness(catalogModels: AntigravityCatalogModel[] = []) {
  const settings = new FileModelSettingsStore()
  vi.spyOn(settings, 'read').mockResolvedValue({ enabledModelIds: [OPUS.id, FLASH.id], catalogModels })
  const pool = new AccountPoolStore()
  vi.spyOn(pool, 'getEffectiveAccount').mockResolvedValue({
    account: { id: 'test' }, token: 'test-token', projectId: 'test-project',
  } as Awaited<ReturnType<AccountPoolStore['getEffectiveAccount']>>)
  const ok = () => new Response('data: ' + JSON.stringify({
    response: { candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] },
  }) + '\n\n')
  const fetchFn = vi.fn(async () => ok())
  return { adapter: new AntigravityAdapter(new FileCredentialStore(), settings, undefined, { fetchFn }, pool), fetchFn, ok }
}

async function drain(adapter: AntigravityAdapter, opts: CompatGenerateOptions): Promise<void> {
  for await (const _chunk of adapter.stream(opts as unknown as GenerateOptions)) { /* consume */ }
}

function sentBodies(fetchFn: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return (fetchFn.mock.calls as unknown as [string, RequestInit][]).map(([, init]) => JSON.parse(String(init.body)))
}

describe('Claude VALIDATED fallback in the adapter', () => {
  it('retries once on the same model without the mode, then stops sending it', async () => {
    const { adapter, fetchFn } = harness()
    const rejection = JSON.stringify({ error: { code: 400, message: "Invalid value at 'request.tool_config.function_calling_config.mode', \"VALIDATED\"" } })
    fetchFn.mockResolvedValueOnce(new Response(rejection, { status: 400 }))

    await drain(adapter, options())
    await drain(adapter, options())

    const bodies = sentBodies(fetchFn)
    expect(bodies).toHaveLength(3)
    expect(modeOf(bodies[0]!)).toBe('VALIDATED')
    expect(modeOf(bodies[1]!)).toBeUndefined()
    expect(bodies[1]!.model).toBe(bodies[0]!.model)
    // The next request never asks for the refused mode again.
    expect(modeOf(bodies[2]!)).toBeUndefined()
  })

  it('reports an unrelated 400 as itself without retrying', async () => {
    const { adapter, fetchFn } = harness()
    fetchFn.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'contents is empty' } }), { status: 400 }))
    await expect(drain(adapter, options())).rejects.toThrow('contents is empty')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})

describe('Catalog-reported limits', () => {
  it('parses maxTokens / maxOutputTokens, numeric strings included, and ignores junk', () => {
    expect(parseCatalogModels({ models: {
      'claude-opus-5-5-high': { displayName: 'Claude Opus 5.5 (High)', maxTokens: 200000, maxOutputTokens: '128000' },
      'gemini-3.8-flash-tiered': { displayName: 'Gemini 3.8 Flash', inputTokenLimit: '1048576', outputTokenLimit: 65536 },
      'gemini-3.1-flash-lite': { displayName: 'Lite', maxTokens: 'lots', maxOutputTokens: -1 },
    } })).toEqual([
      { id: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)', description: undefined, contextWindow: 200000, maxOutputTokens: 128000 },
      { id: 'gemini-3.8-flash-tiered', name: 'Gemini 3.8 Flash', description: undefined, contextWindow: 1048576, maxOutputTokens: 65536 },
      { id: 'gemini-3.1-flash-lite', name: 'Lite', description: undefined },
    ])
  })

  it('sizes a model by the smallest runtime it can route to, falling back to the built-in table', () => {
    expect(runtimeIdsFor(OPUS.id)).toEqual(expect.arrayContaining(['claude-opus-5-5-low', 'claude-opus-5-5-medium', 'claude-opus-5-5-high']))
    expect(effectiveModelLimits(OPUS, [])).toEqual({ contextWindow: OPUS.contextWindow, maxTokens: OPUS.maxTokens })
    expect(effectiveModelLimits(OPUS, [
      { id: 'claude-opus-5-5-low', contextWindow: 200000, maxOutputTokens: 128000 },
      { id: 'claude-opus-5-5-high', contextWindow: 180000, maxOutputTokens: 96000 },
    ])).toEqual({ contextWindow: 180000, maxTokens: 96000 })
    // An implausibly small window is a misread field, not a limit.
    expect(effectiveModelLimits(OPUS, [{ id: 'claude-opus-5-5-low', contextWindow: 100 }]).contextWindow).toBe(OPUS.contextWindow)
    // A ceiling that would swallow the whole window leaves half for input.
    expect(effectiveModelLimits(OPUS, [{ id: 'claude-opus-5-5-low', contextWindow: 64000, maxOutputTokens: 64000 }]))
      .toEqual({ contextWindow: 64000, maxTokens: 32000 })
    // A stored catalog read back with the wrong type is ignored.
    expect(catalogMaxOutputFor('claude-opus-5-5-low', [{ id: 'claude-opus-5-5-low', maxOutputTokens: '9' as unknown as number }])).toBeUndefined()
  })

  it('advertises and sends the catalog limits, user overrides still winning', async () => {
    const catalog = [
      { id: 'claude-opus-5-5-low', contextWindow: 200000, maxOutputTokens: 128000 },
      { id: 'claude-opus-5-5-medium', contextWindow: 200000, maxOutputTokens: 128000 },
      { id: 'claude-opus-5-5-high', contextWindow: 200000, maxOutputTokens: 128000 },
    ]
    const { adapter, fetchFn } = harness(catalog)
    const listed = (await adapter.listModels()).find((model) => model.id === OPUS.id)
    expect((listed as { context?: unknown } | undefined)?.context).toEqual({ contextWindow: 200000 })
    expect((await adapter.resolveModel('antigravity', OPUS.id)).context).toEqual({ contextWindow: 200000 })

    await drain(adapter, options({ tools: undefined }))
    expect((sentBodies(fetchFn)[0]!.request as { generationConfig: unknown }).generationConfig).toEqual({ maxOutputTokens: 128000 })
  })

  it('keeps the built-in output ceiling while the catalog is silent', async () => {
    const { adapter, fetchFn } = harness()
    await drain(adapter, options({ tools: undefined }))
    expect((sentBodies(fetchFn)[0]!.request as { generationConfig: unknown }).generationConfig).toEqual({ maxOutputTokens: OPUS.maxTokens })
  })
})
