import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { KIMI_CODE_MODELS, kimiCodeModelDef } from '../src/host/kimi-code/model-catalog.ts'
import {
  coerceThinkingEffort,
  defaultReasoningEffortFor,
  reasoningEffortsFor,
  thinkingTypeFor,
  wireForModel,
} from '../src/host/kimi-code/types.ts'
import {
  buildModelOptions,
  clearCachedCatalog,
  defaultReasoningEffortForEntry,
  inputModalitiesForEntry,
  loadProviderModels,
  reasoningEffortsForEntry,
  wireForCatalogEntry,
} from '../src/host/kimi-code/client.ts'
import type { KimiCodeCatalogModel } from '../src/host/kimi-code/token-store.ts'
import { FileCredentialStore } from '../src/host/kimi-code/token-store.ts'
import { catalogSnapshotName, catalogSnapshotPath, flushCatalogSnapshots } from '../src/host/common/catalog-snapshot.ts'
import type { KimiCodeCacheStatsDto } from '../src/shared/kimi-code-contracts.ts'

/** Row the settings card would render for one id, from the shipped registry. */
function optionFor(modelId: string) {
  const all = KIMI_CODE_MODELS.map((model) => ({ id: model.id, contextWindow: model.contextWindow }))
  const [option] = buildModelOptions(all.filter((model) => model.id === modelId), [modelId], {})
  return option!
}

/** Parse a live listing the way the catalog loader does. */
async function catalogFrom(entries: Record<string, unknown>[]): Promise<KimiCodeCatalogModel[]> {
  clearCachedCatalog()
  return loadProviderModels({
    store: new FileCredentialStore(path.join(os.tmpdir(), 'kc-k31-store.json')),
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

describe('the K3.1 Pro registry rows', () => {
  it('appends both ids at the end of the shipped registry', () => {
    // Appended, not inserted: the rows a user already has selected stay first in
    // the order a picker built from this array renders.
    expect(KIMI_CODE_MODELS.slice(-2).map((model) => model.id))
      .toEqual(['k3.1-pro', 'k3.1-pro-highspeed'])
  })

  it('states k3.1-pro exactly as the official table does', () => {
    const row = kimiCodeModelDef('k3.1-pro')!
    expect(row.name).toBe('K3.1 Pro')
    expect(row.contextWindow).toBe(262_144)
    expect(row.maxContextWindow).toBe(1_048_576)
    expect(row.maxTokens).toBe(32_768)
    expect(row.inputModalities).toEqual(['text', 'image', 'video'])
    expect(row.reasoningEfforts).toEqual(['low', 'high', 'max'])
    expect(row.defaultReasoningEffort).toBe('max')
    expect(row.thinkingType).toBe('only')
    expect(row.minimumPlan).toBe('Moderato')
    expect(row.contextPlan).toBe('Allegretto')
    expect(row.supportsDynamicTools).toBe(true)
    expect(row.speed).toBe('regular')
  })

  it('states k3.1-pro-highspeed exactly as the official table does', () => {
    const row = kimiCodeModelDef('k3.1-pro-highspeed')!
    expect(row.name).toBe('K3.1 Pro Highspeed')
    // 1M is the only context this id is offered with, so there is no larger
    // window to unlock and no context plan above the model's own.
    expect(row.contextWindow).toBe(1_048_576)
    expect(row.maxContextWindow).toBeNull()
    expect(row.maxTokens).toBe(32_768)
    expect(row.inputModalities).toEqual(['text', 'image', 'video'])
    expect(row.reasoningEfforts).toEqual(['low', 'high', 'max'])
    expect(row.defaultReasoningEffort).toBe('max')
    expect(row.thinkingType).toBe('only')
    expect(row.minimumPlan).toBe('Allegretto')
    expect(row.contextPlan).toBeNull()
    expect(row.supportsDynamicTools).toBe(true)
    expect(row.speed).toBe('highspeed')
  })

  it('reports the quota multiplier as unknown instead of guessing one', () => {
    // The official pages publish no multiplier against the cheapest model for
    // either id, so both rows say null; the highspeed row carries the only
    // statement that exists (about 2x the regular version) in its description.
    expect(kimiCodeModelDef('k3.1-pro')!.quotaMultiplier).toBeNull()
    expect(kimiCodeModelDef('k3.1-pro-highspeed')!.quotaMultiplier).toBeNull()
    expect(kimiCodeModelDef('k3.1-pro-highspeed')!.description).toMatch(/twice the quota/i)
  })
})

describe('thinking-only semantics', () => {
  it('never offers none for a model that cannot stop reasoning', () => {
    for (const id of ['k3.1-pro', 'k3.1-pro-highspeed']) {
      expect(thinkingTypeFor(id)).toBe('only')
      expect(reasoningEffortsFor(id)).toEqual(['low', 'high', 'max'])
      expect(reasoningEffortsFor(id)).not.toContain('none')
      // Disabling thinking is a documented HTTP 400 for this family.
      expect(coerceThinkingEffort(id, 'none')).toEqual({ effort: 'max', coercedFrom: 'none' })
    }
  })

  it('defaults to the declared level rather than to the last one in the list', () => {
    expect(defaultReasoningEffortFor('k3.1-pro')).toBe('max')
    expect(defaultReasoningEffortFor('k3.1-pro-highspeed')).toBe('max')
  })

  it('applies the registry rule when the live listing is silent or absent', () => {
    // A cold start, an offline card, or a server that predates the declaration
    // must not turn a thinking-only model into a switchable one.
    expect(reasoningEffortsForEntry('k3.1-pro', [])).toEqual(['low', 'high', 'max'])
    expect(defaultReasoningEffortForEntry('k3.1-pro', [])).toBe('max')
    const silent: KimiCodeCatalogModel[] = [{ id: 'k3.1-pro', contextWindow: 262_144 }]
    expect(reasoningEffortsForEntry('k3.1-pro', silent)).toEqual(['low', 'high', 'max'])
  })

  it('lets the live declaration win over the registry, in both directions', () => {
    const toggleable: KimiCodeCatalogModel[] = [{
      id: 'k3.1-pro',
      contextWindow: 262_144,
      reasoningEfforts: ['low', 'high', 'max', 'none'],
      thinkingType: 'both',
    }]
    expect(reasoningEffortsForEntry('k3.1-pro', toggleable)).toContain('none')
    const silentReasoner: KimiCodeCatalogModel[] = [{
      id: 'k3.1-pro',
      contextWindow: 262_144,
      thinkingType: 'no',
    }]
    expect(reasoningEffortsForEntry('k3.1-pro', silentReasoner)).toEqual([])
  })

  it('drops a registry default the thinking rule removed', () => {
    // A row whose only level is none and which cannot stop reasoning has no
    // level left to default to, so the default is dropped rather than kept.
    const onlyNone: KimiCodeCatalogModel[] = [{
      id: 'k3',
      contextWindow: 262_144,
      reasoningEfforts: ['none'],
      defaultReasoningEffort: 'none',
      thinkingType: 'only',
    }]
    expect(reasoningEffortsForEntry('k3', onlyNone)).toEqual([])
    expect(defaultReasoningEffortForEntry('k3', onlyNone)).toBeUndefined()
  })

  it('lifts a disabled-thinking request instead of failing the turn', () => {
    // The service answers 400 for this request, and the user's intent is "spend
    // less", not "fail" — so it is raised to the model's own default and the
    // lift is reported.
    expect(coerceThinkingEffort('k3.1-pro', 'none')).toEqual({ effort: 'max', coercedFrom: 'none' })
    expect(coerceThinkingEffort('k3.1-pro-highspeed', 'none')).toEqual({ effort: 'max', coercedFrom: 'none' })
  })

  it('leaves every other effort and every other model untouched', () => {
    for (const effort of ['low', 'high', 'max'] as const) {
      expect(coerceThinkingEffort('k3.1-pro', effort)).toEqual({ effort, coercedFrom: null })
    }
    expect(coerceThinkingEffort('k3.1-pro', undefined)).toEqual({ effort: undefined, coercedFrom: null })
    // A model that may switch thinking off keeps the user's own choice.
    expect(coerceThinkingEffort('k3', 'none')).toEqual({ effort: 'none', coercedFrom: null })
    expect(coerceThinkingEffort('mystery-model', 'none')).toEqual({ effort: 'none', coercedFrom: null })
  })
})

describe('the chat-completions wire', () => {
  it('serves every model on this line over the one chat-completions dialect', () => {
    // K3.1 Pro is not special on the wire: it is an OpenAI-compatible model like
    // the rest, which is what the official agent configures for this provider
    // (`type = "kimi"`).
    for (const id of [
      'k3',
      'k3-256k',
      'kimi-for-coding',
      'kimi-for-coding-highspeed',
      'k3.1-pro',
      'k3.1-pro-highspeed',
    ]) {
      expect(wireForModel(id)).toBe('openai')
    }
  })

  it('honours a dialect the live listing declares', async () => {
    const catalog = await catalogFrom([
      { id: 'k3.1-pro', context_length: 262_144, protocol: 'anthropic' },
    ])
    expect(wireForCatalogEntry('k3.1-pro', catalog)).toBe('anthropic')
  })

  it('keeps the video input the official table declares for both ids', () => {
    // Video is a declared modality of the model, and nothing about the wire takes
    // it away: the card and DSH's capability gates report what the model accepts.
    for (const id of ['k3.1-pro', 'k3.1-pro-highspeed']) {
      expect(kimiCodeModelDef(id)!.inputModalities).toContain('video')
      const option = optionFor(id)
      expect(option.wire).toBe('openai')
      expect(option.supportsVideo).toBe(true)
    }
    expect(optionFor('k3').supportsVideo).toBe(true)
  })

  it('resolves the same video capability for the request path, not only for the card', () => {
    // One resolver feeds the picker, the capability gates and the request body,
    // so this is the list DSH's own video gates act on.
    expect(inputModalitiesForEntry('k3.1-pro', [])).toEqual(['text', 'image', 'video'])
    expect(inputModalitiesForEntry('k3.1-pro-highspeed', [])).toEqual(['text', 'image', 'video'])
    // A model that really is image-only stays image-only: the rule is the model's
    // declaration, never the wire it happens to travel on.
    expect(inputModalitiesForEntry('k3-256k', [])).toEqual(['text', 'image'])
  })

  it('carries the thinking declaration and the filtered levels into the card', () => {
    const option = optionFor('k3.1-pro')
    expect(option.thinkingType).toBe('only')
    expect(option.reasoningEfforts).toEqual(['low', 'high', 'max'])
    expect(option.defaultReasoningEffort).toBe('max')
    expect(option.minimumPlan).toBe('Moderato')
    expect(option.quotaMultiplier).toBeNull()
    // The registry says nothing about thinking for this id, so nothing is claimed.
    expect(optionFor('k3').thinkingType).toBeUndefined()
  })
})

describe('the cache-stats contract', () => {
  it('carries the three write counters and no placeholder note', () => {
    // Compile-time shape check as much as a runtime one: the field names are
    // what the settings card reads, so renaming them breaks this line.
    const dto: KimiCodeCacheStatsDto = {
      requests: 1,
      cachedTokens: 2,
      freshTokens: 3,
      outputTokens: 4,
      hitRatio: null,
      cacheWriteTokens: 5,
      cacheWrite5mTokens: 6,
      cacheWrite1hTokens: 7,
    }
    expect(dto.cacheWriteTokens).toBe(5)
    expect(dto.cacheWrite5mTokens).toBe(6)
    expect(dto.cacheWrite1hTokens).toBe(7)
    expect('cacheWriteTokensNote' in dto).toBe(false)
  })
})
