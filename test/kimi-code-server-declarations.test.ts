import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  buildModelOptions,
  clearCachedCatalog,
  defaultReasoningEffortForEntry,
  dynamicToolsForEntry,
  inputModalitiesForEntry,
  loadProviderModels,
  maxInputTokensForEntry,
  reasoningEffortsForEntry,
  toolUseForEntry,
} from '../src/host/kimi-code/client.ts'
import { FileCredentialStore } from '../src/host/kimi-code/token-store.ts'
import type { KimiCodeCatalogModel, KimiCodeCredentials } from '../src/host/kimi-code/token-store.ts'
import { catalogSnapshotName, catalogSnapshotPath, flushCatalogSnapshots } from '../src/host/common/catalog-snapshot.ts'

function credentials(): KimiCodeCredentials {
  return {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: Date.now() + 86_400_000,
    expiresIn: 86_400,
    region: 'mainland-cn',
    oauthHost: 'https://auth.kimi.com',
    baseUrl: 'https://api.kimi.com/coding',
  }
}

/** Parse a live listing the way the catalog loader does. */
async function catalogFrom(entries: Record<string, unknown>[]): Promise<KimiCodeCatalogModel[]> {
  clearCachedCatalog()
  return loadProviderModels({
    store: new FileCredentialStore(path.join(os.tmpdir(), 'kc-decl-store.json')),
    accessToken: 'at-1',
    region: 'mainland-cn',
    fetchFn: async () =>
      new Response(JSON.stringify({ data: entries }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  })
}

beforeEach(async () => {
  await fs.rm(catalogSnapshotPath(catalogSnapshotName('kimi-code', 'mainland-cn')), { force: true })
})

afterEach(async () => {
  clearCachedCatalog()
  await flushCatalogSnapshots()
})

describe('supports_thinking_type', () => {
  it('removes none from a model that can only reason', async () => {
    const catalog = await catalogFrom([
      {
        id: 'k3',
        context_length: 262_144,
        supports_thinking_type: 'only',
        think_efforts: { valid_efforts: ['low', 'high', 'max', 'none'], default_effort: 'high' },
      },
    ])
    // The declaration wins over the effort list, which still names `none`.
    expect(reasoningEffortsForEntry('k3', catalog)).toEqual(['low', 'high', 'max'])
    expect(reasoningEffortsForEntry('k3', catalog)).not.toContain('none')
  })

  it('offers no levels for a model that does not reason', async () => {
    const catalog = await catalogFrom([
      { id: 'k3', context_length: 262_144, supports_thinking_type: 'no' },
    ])
    expect(reasoningEffortsForEntry('k3', catalog)).toEqual([])
  })

  it('keeps the list untouched for a model that can toggle', async () => {
    const catalog = await catalogFrom([
      {
        id: 'k3',
        context_length: 262_144,
        supports_thinking_type: 'both',
        think_efforts: { valid_efforts: ['low', 'high', 'none'] },
      },
    ])
    expect(reasoningEffortsForEntry('k3', catalog)).toEqual(['low', 'high', 'none'])
  })

  it('falls back to the effort list on a server that omits the field', async () => {
    const catalog = await catalogFrom([
      { id: 'k3', context_length: 262_144, think_efforts: { valid_efforts: ['low', 'high'] } },
    ])
    expect(reasoningEffortsForEntry('k3', catalog)).toEqual(['low', 'high'])
  })

  it('drops a default the thinking rule removed', () => {
    const catalog: KimiCodeCatalogModel[] = [
      {
        id: 'k3',
        contextWindow: 262_144,
        reasoningEfforts: ['none'],
        defaultReasoningEffort: 'none',
        thinkingType: 'only',
      },
    ]
    // `none` was the only level and the model cannot be told not to reason, so
    // no default survives, rather than defaulting to a rejected effort.
    expect(reasoningEffortsForEntry('k3', catalog)).toEqual([])
    expect(defaultReasoningEffortForEntry('k3', catalog)).toBeUndefined()
  })
})

describe('limit.input', () => {
  it('reads a nested input cap and keeps it below the window', async () => {
    const catalog = await catalogFrom([
      { id: 'k3', context_length: 1_048_576, limit: { input: 400_000, output: 131_072 } },
    ])
    expect(maxInputTokensForEntry('k3', catalog)).toBe(400_000)
  })

  it('reads a flat max_input_tokens too', async () => {
    const catalog = await catalogFrom([
      { id: 'k3', context_length: 1_048_576, max_input_tokens: 200_000 },
    ])
    expect(maxInputTokensForEntry('k3', catalog)).toBe(200_000)
  })

  it('reports no cap when the input limit equals the window', async () => {
    const catalog = await catalogFrom([
      { id: 'k3', context_length: 262_144, limit: { input: 262_144 } },
    ])
    expect(maxInputTokensForEntry('k3', catalog)).toBeUndefined()
  })

  it('sizes the prompt budget by the cap while the window still bounds output', async () => {
    const catalog = await catalogFrom([
      { id: 'k3', context_length: 1_048_576, limit: { input: 400_000 } },
    ])
    const [option] = buildModelOptions(catalog, ['k3'], {})
    expect(option!.contextWindow).toBe(1_048_576)
    expect(option!.maxInputTokens).toBe(400_000)
    expect(option!.promptBudget).toBe(400_000)
  })
})

describe('supports_tool_use', () => {
  it('reports a denial', async () => {
    const catalog = await catalogFrom([
      { id: 'k3', context_length: 262_144, supports_tool_use: false },
    ])
    expect(toolUseForEntry('k3', catalog)).toBe(false)
  })

  it('assumes support when the listing is silent', async () => {
    const catalog = await catalogFrom([
      { id: 'k3', context_length: 262_144 },
    ])
    expect(toolUseForEntry('k3', catalog)).toBe(true)
  })

  it('turns dynamic tools off for a model that takes no tools at all', async () => {
    const catalog = await catalogFrom([
      { id: 'k3', context_length: 262_144, supports_dynamic_tools: true, supports_tool_use: false },
    ])
    // A model cannot accept per-message declarations when it accepts none.
    expect(dynamicToolsForEntry('k3', catalog)).toBe(true)
    expect(toolUseForEntry('k3', catalog)).toBe(false)
    const [option] = buildModelOptions(catalog, ['k3'], {})
    expect(option!.supportsToolUse).toBe(false)
    expect(option!.supportsDynamicTools).toBe(false)
  })
})

describe('status lifecycle', () => {
  it('drops a deprecated alias from the picker', async () => {
    const catalog = await catalogFrom([
      { id: 'kimi-k2', context_length: 131_072, status: 'deprecated' },
      { id: 'k3', context_length: 262_144 },
    ])
    expect(catalog.map((m) => m.id)).toEqual(['k3'])
  })

  it('drops an alpha model from the picker', async () => {
    const catalog = await catalogFrom([
      { id: 'k3-preview', context_length: 262_144, status: 'alpha' },
    ])
    expect(catalog).toEqual([])
  })

  it('keeps a model whose status is something else', async () => {
    const catalog = await catalogFrom([
      { id: 'k3', context_length: 262_144, status: 'stable' },
    ])
    expect(catalog.map((m) => m.id)).toEqual(['k3'])
  })
})

/**
 * The unified listing the service now publishes.
 *
 * The same facts as the flat listing, nested: the window under `limit.context`,
 * the thinking declaration and the effort ladder under `reasoning`, the
 * accepted media under `modalities.input` and the message-level tool flag
 * under `tools.dynamic_load`. A listing in this shape used to be dropped
 * outright, because it carries no `context_length` for the picker to read.
 */
describe('unified /models schema', () => {
  it('reads the window and the input cap from the nested limit', async () => {
    const catalog = await catalogFrom([
      { id: 'k3', limit: { context: 262_144, input: 200_000, output: 131_072 } },
    ])
    expect(catalog.map((m) => m.id)).toEqual(['k3'])
    expect(catalog[0]!.contextWindow).toBe(262_144)
    expect(maxInputTokensForEntry('k3', catalog)).toBe(200_000)
  })

  it('reads the thinking declaration from the nested reasoning object', async () => {
    const catalog = await catalogFrom([
      {
        id: 'k3',
        limit: { context: 262_144 },
        reasoning: { type: 'only', effort: { valid: ['low', 'high', 'max', 'none'], default: 'max' } },
      },
    ])
    // The declaration wins over the effort list, which still names `none`.
    expect(reasoningEffortsForEntry('k3', catalog)).toEqual(['low', 'high', 'max'])
    expect(defaultReasoningEffortForEntry('k3', catalog)).toBe('max')
  })

  it('maps the unified none type onto the legacy no-thinking state', async () => {
    const catalog = await catalogFrom([
      { id: 'k3', limit: { context: 262_144 }, reasoning: { type: 'none' } },
    ])
    expect(reasoningEffortsForEntry('k3', catalog)).toEqual([])
  })

  it('reads the effort ladder and its default from the nested reasoning object', async () => {
    const catalog = await catalogFrom([
      {
        id: 'k3.5',
        limit: { context: 262_144 },
        reasoning: { type: 'both', effort: { valid: ['low', 'high', 'none'], default: 'high' } },
      },
    ])
    expect(reasoningEffortsForEntry('k3.5', catalog)).toEqual(['low', 'high', 'none'])
    expect(defaultReasoningEffortForEntry('k3.5', catalog)).toBe('high')
  })

  it('drops a default the valid list does not contain', async () => {
    const catalog = await catalogFrom([
      {
        id: 'k3.5',
        limit: { context: 262_144 },
        reasoning: { type: 'both', effort: { valid: ['low', 'high'], default: 'max' } },
      },
    ])
    // A default naming a level the model cannot be asked for would fail the
    // first turn that relied on it, so it is dropped rather than published.
    expect(reasoningEffortsForEntry('k3.5', catalog)).toEqual(['low', 'high'])
    expect(defaultReasoningEffortForEntry('k3.5', catalog)).toBeUndefined()
  })

  it('ignores the effort list of a listing that says thinking is unsupported', async () => {
    const catalog = await catalogFrom([
      {
        id: 'k3.5-off',
        limit: { context: 262_144 },
        think_efforts: { support: false, valid_efforts: ['low', 'high'], default_effort: 'high' },
      },
      {
        id: 'k3.5-on',
        limit: { context: 262_144 },
        think_efforts: { support: true, valid_efforts: ['low', 'high'], default_effort: 'high' },
      },
    ])
    // `support` gates the whole object: the list it carries is not to be
    // believed when the server says the model has no adjustable thinking.
    expect(reasoningEffortsForEntry('k3.5-off', catalog)).toEqual([])
    expect(defaultReasoningEffortForEntry('k3.5-off', catalog)).toBeUndefined()
    expect(reasoningEffortsForEntry('k3.5-on', catalog)).toEqual(['low', 'high'])
    expect(defaultReasoningEffortForEntry('k3.5-on', catalog)).toBe('high')
  })

  it('reads the accepted media from the nested modalities list', async () => {
    const catalog = await catalogFrom([
      { id: 'k3', limit: { context: 262_144 }, modalities: { input: ['text', 'image', 'video'] } },
    ])
    expect(inputModalitiesForEntry('k3', catalog)).toEqual(['text', 'image', 'video'])
    expect(catalog[0]!.supportsVideo).toBe(true)
  })

  it('reads the dynamic-tool flag from the nested tools object', async () => {
    const catalog = await catalogFrom([
      { id: 'k3', limit: { context: 262_144 }, tools: { dynamic_load: true } },
      { id: 'k3-256k', limit: { context: 262_144 }, tools: { dynamic_load: false } },
    ])
    // The nested flag wins over the shipped registry, including to turn the
    // capability off for an id the registry declares as taking dynamic tools.
    expect(dynamicToolsForEntry('k3', catalog)).toBe(true)
    expect(dynamicToolsForEntry('k3-256k', catalog)).toBe(false)
  })

  it('still reads the flat listing the older server sends', async () => {
    const catalog = await catalogFrom([
      {
        id: 'k3',
        context_length: 262_144,
        supports_thinking_type: 'both',
        think_efforts: { valid_efforts: ['low', 'high'], default_effort: 'high' },
        supports_image_in: true,
        supports_dynamic_tools: true,
      },
    ])
    expect(catalog[0]!.contextWindow).toBe(262_144)
    expect(reasoningEffortsForEntry('k3', catalog)).toEqual(['low', 'high'])
    expect(defaultReasoningEffortForEntry('k3', catalog)).toBe('high')
    expect(inputModalitiesForEntry('k3', catalog)).toEqual(['text', 'image'])
    expect(dynamicToolsForEntry('k3', catalog)).toBe(true)
  })
})