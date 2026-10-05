import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  buildModelOptions,
  clearCachedCatalog,
  defaultReasoningEffortForEntry,
  dynamicToolsForEntry,
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