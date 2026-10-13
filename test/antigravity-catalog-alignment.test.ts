import { describe, expect, it } from 'vitest'
import type { GenerateOptions } from '../src/host/common/llm-compat.ts'
import { MODELS, ROUTING } from '../src/host/antigravity/types.ts'
import { buildRequest, closeStream, createStreamState, gemini25ThinkingBudget, processStreamLine } from '../src/host/antigravity/mapper.ts'
import { parseCatalogModels } from '../src/host/antigravity/client.ts'
import { parseDurationMs, retryDelayMs } from '../src/host/antigravity/adapter.ts'
import { quotaFamilyForModel } from '../src/host/antigravity/account-pool.ts'

/**
 * Runtime ids `fetchAvailableModels` listed on 2026-10-12 (internal `tab_*`
 * completion models omitted). Every id the routing table sends must be one of
 * them: an id the service does not advertise is how 3.7 Flash ended up routed
 * through `gemini-3.7-flash-tiered` with a silent fallback to 3.6.
 */
const CATALOG_2026_10_12 = new Set([
  'gemini-2.5-flash-thinking', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro',
  'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3-flash', 'gemini-3-flash-agent',
  'gemini-3.5-flash-extra-low', 'gemini-3.5-flash-low',
  'gemini-3.6-flash-low', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-high',
  'gemini-3.7-flash-low', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-high',
  'gemini-3.8-flash-tiered', 'gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high',
  'gemini-3.1-pro-low', 'gemini-3.1-pro-high', 'gemini-pro-agent', 'gemini-3.1-flash-image',
  'claude-opus-5-5-low', 'claude-opus-5-5-medium', 'claude-opus-5-5-high',
  'claude-sonnet-5-5-low', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-high',
  'gpt-oss-120b-medium',
])

function model(id: string) {
  return MODELS.find((entry) => entry.id === id)!
}

function options(modelId: string): GenerateOptions {
  return {
    provider: 'antigravity',
    model: modelId,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  } as unknown as GenerateOptions
}

function finishOf(frames: unknown[]) {
  const state = createStreamState()
  for (const frame of frames) processStreamLine('data: ' + JSON.stringify(frame), state)
  return closeStream(state).find((chunk) => chunk.type === 'finish') as { reason: { kind: string; failure?: { message: string } } }
}

describe('Antigravity catalog alignment', () => {
  it('routes every selectable model only to runtime ids the service lists', () => {
    for (const entry of MODELS) {
      const routing = ROUTING[entry.id]
      expect(routing, entry.id).toBeDefined()
      for (const runtime of new Set([routing!.off, routing!.defaultRequestId, ...Object.values(routing!.routing)])) {
        expect(CATALOG_2026_10_12.has(runtime), `${entry.id} -> ${runtime}`).toBe(true)
      }
    }
  })

  it('offers neither retired Claude 4.6 models nor the chat-unusable image model', () => {
    const ids = MODELS.map((entry) => entry.id)
    expect(ids).not.toContain('claude-opus-4-6')
    expect(ids).not.toContain('claude-sonnet-4-6')
    expect(ids).not.toContain('gemini-3.1-flash-image')
    expect(ids).toEqual(expect.arrayContaining(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']))
  })

  it('maps Gemini 3.5 Flash efforts by the published display names', () => {
    // extra-low is "(Low)", 3.5-flash-low is "(Medium)", 3-flash-agent is "(High)".
    expect(ROUTING['gemini-3.5-flash']!.routing).toMatchObject({
      low: 'gemini-3.5-flash-extra-low',
      medium: 'gemini-3.5-flash-low',
      high: 'gemini-3-flash-agent',
    })
  })

  it('routes Gemini 3.7 Flash through its suffixed tiers', () => {
    expect(ROUTING['gemini-3.7-flash']!.routing).toMatchObject({
      low: 'gemini-3.7-flash-low',
      medium: 'gemini-3.7-flash-medium',
      high: 'gemini-3.7-flash-high',
    })
  })

  it('filters the editor tab-completion models out of the catalog', () => {
    const catalog = parseCatalogModels({ models: {
      'gemini-3.1-flash-lite': { displayName: 'Gemini 3.1 Flash Lite' },
      tab_flash_lite_preview: {},
      tab_jump_flash_lite_preview: {},
    } })
    expect(catalog.map((entry) => entry.id)).toEqual(['gemini-3.1-flash-lite'])
  })
})

describe('Gemini 2.5 thinking budgets', () => {
  it.each([
    ['gemini-2.5-flash', 'high', 24576],
    ['gemini-2.5-flash', 'medium', 16384],
    ['gemini-2.5-flash', 'low', 4096],
    ['gemini-2.5-flash', 'off', 0],
    ['gemini-2.5-pro', 'high', 32768],
    ['gemini-2.5-pro', 'off', 128],
  ])('%s at %s stays inside the accepted range (%i)', (runtime, effort, budget) => {
    expect(gemini25ThinkingBudget(runtime, effort)).toBe(budget)
  })

  it('sends the clamped budget on the wire', () => {
    const flash = buildRequest(options('gemini-2.5-flash'), model('gemini-2.5-flash'), 'p', 'gemini-2.5-flash', 'high')
    expect((flash.request as any).generationConfig.thinkingConfig).toEqual({ thinkingBudget: 24576, includeThoughts: true })
    const pro = buildRequest(options('gemini-2.5-pro'), model('gemini-2.5-pro'), 'p', 'gemini-2.5-pro', 'off')
    expect((pro.request as any).generationConfig.thinkingConfig).toEqual({ thinkingBudget: 128, includeThoughts: false })
  })
})

describe('Antigravity finish reasons', () => {
  it('keeps STOP a clean stop', () => {
    expect(finishOf([{ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }]).reason).toEqual({ kind: 'stop' })
  })

  it.each(['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'MALFORMED_FUNCTION_CALL'])('reports %s as an error instead of a stop', (reason) => {
    const finish = finishOf([{ candidates: [{ finishReason: reason, finishMessage: 'upstream detail' }] }])
    expect(finish.reason.kind).toBe('error')
    expect(finish.reason.failure?.message).toContain(reason)
    expect(finish.reason.failure?.message).toContain('upstream detail')
  })

  it('reports a blocked prompt instead of a truncated stream', () => {
    const finish = finishOf([{ response: { promptFeedback: { blockReason: 'SAFETY' } } }])
    expect(finish.reason.kind).toBe('error')
    expect(finish.reason.failure?.message).toContain('prompt was blocked')
  })

  it('treats OTHER as a failure only when it left nothing behind', () => {
    expect(finishOf([{ candidates: [{ finishReason: 'OTHER' }] }]).reason.kind).toBe('error')
    expect(finishOf([{ candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'OTHER' }] }]).reason).toEqual({ kind: 'stop' })
  })
})

describe('Antigravity 429 handling helpers', () => {
  it.each([
    ['12.5s', 12_500],
    ['1h2m3s', 3_723_000],
    ['373.8ms', 373.8],
    ['soon', undefined],
  ])('parses duration %s', (text, ms) => {
    expect(parseDurationMs(text)).toBe(ms)
  })

  it('prefers the reset instant, then the reset delay, then RetryInfo, then the header', () => {
    const now = Date.parse('2026-10-13T00:00:00Z')
    const body = (details: unknown[]) => JSON.stringify({ error: { code: 429, details } })
    const headers = new Headers({ 'retry-after': '30' })
    expect(retryDelayMs(headers, body([
      { metadata: { quotaResetTimeStamp: '2026-10-13T01:00:00Z', quotaResetDelay: '5m' } },
    ]), now)).toBe(3_600_000)
    expect(retryDelayMs(headers, body([{ metadata: { quotaResetDelay: '5m' } }, { retryDelay: '2s' }]), now)).toBe(300_000)
    expect(retryDelayMs(headers, body([{ retryDelay: '2s' }]), now)).toBe(2_000)
    expect(retryDelayMs(headers, 'not json', now)).toBe(30_000)
    expect(retryDelayMs(new Headers(), 'not json', now)).toBeUndefined()
  })

  it('assigns models to the quota groups the service meters separately', () => {
    expect(quotaFamilyForModel('claude-opus-5-5')).toBe('claude-gpt')
    expect(quotaFamilyForModel('gpt-oss-120b')).toBe('claude-gpt')
    expect(quotaFamilyForModel('gemini-3.8-flash')).toBe('gemini')
  })
})
