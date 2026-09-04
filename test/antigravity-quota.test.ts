import { describe, expect, it } from 'vitest'
import { parseCatalogModels, parseQuotaSummary } from '../src/host/antigravity/client.ts'
import { DEFAULT_ENDPOINT, DAILY_ENDPOINT, ENDPOINT_FALLBACKS } from '../src/host/antigravity/types.ts'

describe('Antigravity Quota & Catalog Parser', () => {
  it('parses quota groups and buckets with remaining fraction clamping', () => {
    const rawData = {
      groups: [
        {
          displayName: 'Gemini Models',
          description: 'Gemini Pro and Flash quotas',
          buckets: [
            {
              bucketId: 'gemini-5h',
              displayName: '5 hours',
              remainingFraction: 0.85,
              resetTime: '2026-09-03T18:00:00Z',
            },
            {
              bucketId: 'gemini-weekly',
              displayName: 'Weekly',
              remainingFraction: 1.2, // 超过 1 应 clamp 为 1
            },
          ],
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [
            {
              bucketId: 'claude-5h',
              displayName: '5 hours',
              remainingFraction: -0.1, // 小于 0 应 clamp 为 0
            },
          ],
        },
      ],
    }

    const { groups } = parseQuotaSummary(rawData)
    expect(groups).toHaveLength(2)

    expect(groups[0].displayName).toBe('Gemini Models')
    expect(groups[0].buckets).toHaveLength(2)
    expect(groups[0].buckets[0].remainingFraction).toBe(0.85)
    expect(groups[0].buckets[1].remainingFraction).toBe(1)

    expect(groups[1].displayName).toBe('Claude and GPT models')
    expect(groups[1].buckets[0].remainingFraction).toBe(0)
  })

  it('parses catalog models and filters internal or chat models', () => {
    const rawModels = {
      models: {
        'gemini-3.7-flash': {
          displayName: 'Gemini 3.7 Flash',
          description: 'Flash model with reasoning',
        },
        'claude-opus-4-6': {
          displayName: 'Claude Opus 4.6',
        },
        chat_internal_test: {
          displayName: 'Internal Chat',
          isInternal: false,
        },
        hidden_model: {
          displayName: 'Hidden Model',
          isInternal: true,
        },
      },
    }

    const catalog = parseCatalogModels(rawModels)
    expect(catalog).toHaveLength(2)
    expect(catalog.map((m) => m.id)).toEqual(['gemini-3.7-flash', 'claude-opus-4-6'])
    expect(catalog[0].name).toBe('Gemini 3.7 Flash')
  })

  it('queries the daily endpoint first, matching the official Antigravity call chain', () => {
    // 生产端点对流式生成间歇性 429、不回传 thought 部分、配额摘要是冻结快照；
    // daily 端点三类数据都正常，官方客户端即以 daily 为首选。
    expect(ENDPOINT_FALLBACKS[0]).toBe(DAILY_ENDPOINT)
    expect(ENDPOINT_FALLBACKS).toContain(DEFAULT_ENDPOINT)
    expect(ENDPOINT_FALLBACKS.indexOf(DAILY_ENDPOINT)).toBeLessThan(ENDPOINT_FALLBACKS.indexOf(DEFAULT_ENDPOINT))
  })
})
