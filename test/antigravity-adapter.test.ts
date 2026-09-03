import { describe, expect, it, vi } from 'vitest'
import { AntigravityAdapter } from '../src/host/antigravity/adapter.ts'
import { FileCredentialStore, FileModelSettingsStore } from '../src/host/antigravity/token-store.ts'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

import os from 'node:os'
import path from 'node:path'

describe('AntigravityAdapter', () => {
  it('reports provider info and lists enabled models including gemini-3.8-flash', async () => {
    const store = new FileCredentialStore(path.join(os.tmpdir(), `test-cred-${Date.now()}.json`))
    const modelSettings = new FileModelSettingsStore(path.join(os.tmpdir(), `test-models-${Date.now()}.json`))
    const adapter = new AntigravityAdapter(store, modelSettings)

    const info = adapter.providerInfo('antigravity')
    expect(info.id).toBe('antigravity')
    expect(info.name).toBe('Antigravity')

    const models = await adapter.listModels('antigravity')
    expect(models.length).toBeGreaterThan(0)
    expect(models.some((m) => m.id === 'gemini-3.8-flash')).toBe(true)
    expect(models.some((m) => m.id === 'gemini-3.7-flash')).toBe(true)
    expect(models.some((m) => m.id === 'claude-opus-4-6')).toBe(true)

    const g38 = models.find((m) => m.id === 'gemini-3.8-flash')!
    expect(g38.name).toBe('Gemini 3.8 Flash')
    expect(g38.reasoningEfforts).toEqual(['low', 'medium', 'high'])
  })

  it('resolves model correctly with reasoning efforts and context window overrides', async () => {
    const store = new FileCredentialStore()
    const modelSettings = new FileModelSettingsStore()

    // 预设上下文覆盖
    vi.spyOn(modelSettings, 'read').mockResolvedValue({
      enabledModelIds: ['gemini-3.8-flash'],
      catalogModels: [],
      contextWindowOverrides: {
        'gemini-3.8-flash': 524288, // 自定义 512K
      },
    })

    const adapter = new AntigravityAdapter(store, modelSettings)
    const resolved = await adapter.resolveModel('antigravity', 'gemini-3.8-flash')
    expect(resolved.id).toBe('gemini-3.8-flash')
    expect(resolved.name).toBe('Gemini 3.8 Flash')
    expect(resolved.context.contextWindow).toBe(524288) // 覆盖生效
    expect(resolved.reasoning?.efforts.map((e) => e.name)).toEqual(['low', 'medium', 'high'])
    expect(resolved.reasoning?.defaultEffort).toBe('medium')

    const list = await adapter.listModels('antigravity')
    expect(list[0].context.contextWindow).toBe(524288)
  })

  it('uses defaultReasoningEffort when options.reasoningEffort is not specified', async () => {
    const store = new FileCredentialStore()
    const modelSettings = new FileModelSettingsStore()

    vi.spyOn(store, 'read').mockResolvedValue({
      access: 'mock-access-token',
      expires: Date.now() + 3_600_000,
    })

    vi.spyOn(modelSettings, 'read').mockResolvedValue({
      enabledModelIds: ['gemini-3.8-flash'],
      catalogModels: [],
      defaultReasoningEffort: 'high',
    })

    let capturedBody: any
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body))
      const sseContent = 'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}],"finishReason":"STOP"}\n'
      return new Response(sseContent, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as typeof fetch

    try {
      const adapter = new AntigravityAdapter(store, modelSettings)
      const chunks: StreamChunk[] = []
      for await (const chunk of adapter.stream({
        provider: 'antigravity',
        model: 'gemini-3.8-flash',
        // 未传 reasoningEffort，应自动应用默认 high
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as unknown as GenerateOptions)) {
        chunks.push(chunk)
      }

      expect(capturedBody.model).toBe('gemini-3.8-flash-tiered')
      expect(capturedBody.request.generationConfig.thinkingConfig.thinkingLevel).toBe('HIGH')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('handles 404 fallback routing when primary runtime candidate fails', async () => {
    const store = new FileCredentialStore()
    const modelSettings = new FileModelSettingsStore()

    vi.spyOn(store, 'read').mockResolvedValue({
      access: 'mock-access-token',
      refresh: 'mock-refresh-token',
      expires: Date.now() + 3_600_000,
      projectId: 'mock-proj',
    })

    const fetchCalls: Array<{ url: string; model: string }> = []
    const originalFetch = globalThis.fetch

    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      const reqModel = body.model
      fetchCalls.push({ url: String(url), model: reqModel })

      if (reqModel === 'gemini-3.6-flash-high') {
        return new Response('runtime model not found', { status: 404 })
      }

      const sseContent = [
        'data: {"candidates":[{"content":{"parts":[{"text":"Hello from fallback"}]}}],"finishReason":"STOP"}',
        '',
      ].join('\n')

      return new Response(sseContent, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as typeof fetch

    try {
      const adapter = new AntigravityAdapter(store, modelSettings)
      const chunks: StreamChunk[] = []
      for await (const chunk of adapter.stream({
        provider: 'antigravity',
        model: 'gemini-3.6-flash',
        reasoningEffort: 'high',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as unknown as GenerateOptions)) {
        chunks.push(chunk)
      }

      expect(fetchCalls.length).toBe(2)
      expect(fetchCalls[0].model).toBe('gemini-3.6-flash-high')
      expect(fetchCalls[1].model).toBe('gemini-3.6-flash-low')
      expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'Hello from fallback' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('handles 429 fallback routing to next candidate when primary model is exhausted', async () => {
    const store = new FileCredentialStore()
    const modelSettings = new FileModelSettingsStore()

    vi.spyOn(store, 'read').mockResolvedValue({
      access: 'mock-access-token',
      expires: Date.now() + 3_600_000,
    })

    const fetchCalls: Array<{ model: string }> = []
    const originalFetch = globalThis.fetch

    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      const reqModel = body.model
      fetchCalls.push({ model: reqModel })

      if (reqModel === 'gemini-3.8-flash-tiered') {
        return new Response('{"error":{"code":429,"message":"RESOURCE_EXHAUSTED"}}', { status: 429 })
      }

      const sseContent = 'data: {"candidates":[{"content":{"parts":[{"text":"Hello from 3.7 fallback"}]}}],"finishReason":"STOP"}\n'
      return new Response(sseContent, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as typeof fetch

    try {
      const adapter = new AntigravityAdapter(store, modelSettings)
      const chunks: StreamChunk[] = []
      for await (const chunk of adapter.stream({
        provider: 'antigravity',
        model: 'gemini-3.8-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'test 429' }] }],
      } as unknown as GenerateOptions)) {
        chunks.push(chunk)
      }

      expect(fetchCalls.length).toBe(3)
      expect(fetchCalls[0].model).toBe('gemini-3.8-flash-tiered')
      expect(fetchCalls[1].model).toBe('gemini-3.8-flash-tiered')
      expect(fetchCalls[2].model).toBe('gemini-3.7-flash-tiered')
      expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'Hello from 3.7 fallback' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
