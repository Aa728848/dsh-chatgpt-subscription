import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearCachedQuota,
  fetchAccountQuota,
  getCachedQuota,
  parseCatalogModels,
  parseQuotaSummary,
} from '../src/host/antigravity/client.ts'
import { FileCredentialStore } from '../src/host/antigravity/token-store.ts'
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

describe('Antigravity Quota Cache & Concurrency', () => {
  beforeEach(() => {
    clearCachedQuota()
  })

  function createMockStore() {
    return {
      read: vi.fn(async () => ({
        access_token: 'token-quota-test',
        refresh_token: 'refresh-quota-test',
        expires_at: Date.now() + 3600_000,
        projectId: 'quota-proj-1',
      })),
      write: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    } as unknown as FileCredentialStore
  }

  it('reuses cached quota within TTL when force is false', async () => {
    let callCount = 0
    const fakeFetch = vi.fn(async (url: string) => {
      callCount++
      if (url.includes('/v1internal:retrieveUserQuotaSummary')) {
        return new Response(JSON.stringify({ groups: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/v1internal:fetchAvailableModels')) {
        return new Response(JSON.stringify({ models: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ cloudaicompanionProject: 'quota-proj-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    const store = createMockStore()
    const first = await fetchAccountQuota(store, undefined, fakeFetch, false)
    expect(first.projectId).toBe('quota-proj-1')
    expect(callCount).toBeGreaterThan(0)
    const initialCalls = callCount

    // 第二次调用，force=false，命中 2 分钟缓存
    const second = await fetchAccountQuota(store, undefined, fakeFetch, false)
    expect(second).toBe(first)
    expect(callCount).toBe(initialCalls) // 没有任何新网络调用
  })

  it('bypasses cache when force is true', async () => {
    let callCount = 0
    const fakeFetch = vi.fn(async (url: string) => {
      callCount++
      if (url.includes('/v1internal:retrieveUserQuotaSummary')) {
        return new Response(JSON.stringify({ groups: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/v1internal:fetchAvailableModels')) {
        return new Response(JSON.stringify({ models: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ cloudaicompanionProject: 'quota-proj-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    const store = createMockStore()
    await fetchAccountQuota(store, undefined, fakeFetch, false)
    const initialCalls = callCount

    // 传入 force=true 强制刷新
    await fetchAccountQuota(store, undefined, fakeFetch, true)
    expect(callCount).toBeGreaterThan(initialCalls)
  })

  it('deduplicates concurrent quota fetch calls via in-flight promise', async () => {
    let summaryRequests = 0
    const fakeFetch = vi.fn(async (url: string) => {
      if (url.includes('/v1internal:retrieveUserQuotaSummary')) {
        summaryRequests++
        // 模拟异步请求耗时
        await new Promise((resolve) => setTimeout(resolve, 20))
        return new Response(JSON.stringify({ groups: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    const store = createMockStore()
    const [res1, res2, res3] = await Promise.all([
      fetchAccountQuota(store, undefined, fakeFetch, false),
      fetchAccountQuota(store, undefined, fakeFetch, false),
      fetchAccountQuota(store, undefined, fakeFetch, false),
    ])

    expect(res1).toBe(res2)
    expect(res2).toBe(res3)
    expect(summaryRequests).toBe(1)
  })

  it('clears cached quota on clearCachedQuota call', async () => {
    const fakeFetch = vi.fn(async () => {
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    const store = createMockStore()
    await fetchAccountQuota(store, undefined, fakeFetch, false)
    expect(getCachedQuota()).toBeDefined()

    clearCachedQuota()
    expect(getCachedQuota()).toBeUndefined()
  })
})
