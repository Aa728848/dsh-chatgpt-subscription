/**
 * Cache accounting and the thinking gate, on the wires this line actually speaks.
 *
 * These cases used to live in a file about the Responses dialect, and they were
 * never about that protocol: the chat-completions usage split, the Anthropic
 * total that excludes the cache, the per-tier cache-write headers, and the gate
 * that lifts a disabled-thinking request are properties of the chat and
 * Anthropic wires themselves. They are kept (and kept green) here.
 *
 * The three claims worth stating because each can look right and be wrong:
 *
 * - chat-completions `prompt_tokens` is the TOTAL input, so fresh = total minus
 *   BOTH the hit and the write; subtracting only the hit double-counts writes;
 * - Anthropic `input_tokens` EXCLUDES the cache, so subtracting anything there
 *   would produce a negative fresh count;
 * - the 5m/1h split exists only in the response headers, so a missing header is
 *   silence (0) rather than a claim that nothing was written to that tier.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import type { GenerateOptions as HarnessGenerateOptions } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '../src/host/common/llm-compat.ts'
import { KimiCodeAdapter } from '../src/host/kimi-code/adapter.ts'
import { FileCredentialStore, FileModelSettingsStore } from '../src/host/kimi-code/token-store.ts'
import type { KimiCodeCatalogModel, KimiCodeCredentials } from '../src/host/kimi-code/token-store.ts'
import { clearCachedCatalog, requestUrl } from '../src/host/kimi-code/client.ts'
import {
  cacheWriteTiers,
  closeStream,
  createStreamState,
  getCacheStats,
  getLastThinkingCoercion,
  processAnthropicStreamLine,
  processOpenAIStreamLine,
  resetCacheStats,
} from '../src/host/kimi-code/mapper.ts'
import { getKimiCodeWebStatus } from '../src/host/kimi-code/routes.ts'

function tmp(prefix: string): string {
  return path.join(os.tmpdir(), prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json')
}

beforeEach(() => {
  resetCacheStats()
})

afterEach(() => {
  clearCachedCatalog()
  resetCacheStats()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('cache write accounting per wire', () => {
  it('subtracts BOTH hit and write from the chat-completions prompt total', () => {
    // prompt_tokens is the total input on this dialect; a fresh count that only
    // removed the hit would report the written tokens twice.
    const state = createStreamState('openai')
    processOpenAIStreamLine('data: ' + JSON.stringify({
      usage: {
        prompt_tokens: 500,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 50 },
      },
    }), state)
    const out = closeStream(state)
    const usage = out.find((chunk) => chunk.type === 'usage') as unknown as { usage: Record<string, number> }
    expect(usage.usage).toMatchObject({ inputTokens: 250, cacheReadTokens: 200, cacheWriteTokens: 50 })
  })

  it('keeps the Anthropic input_tokens untouched, because it excludes the cache', () => {
    // Messages input_tokens is NOT the total: the read and the write are reported
    // beside it. Subtracting them here would produce a negative fresh count.
    const state = createStreamState('anthropic')
    const out = [
      ...processAnthropicStreamLine('data: ' + JSON.stringify({
        type: 'message_start',
        message: {
          usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 700, cache_creation_input_tokens: 40 },
        },
      }), state),
      ...processAnthropicStreamLine('data: ' + JSON.stringify({ type: 'message_stop' }), state),
    ]
    const usage = out.find((chunk) => chunk.type === 'usage') as unknown as { usage: Record<string, number> }
    expect(usage.usage).toMatchObject({ inputTokens: 100, cacheReadTokens: 700, cacheWriteTokens: 40 })
  })

  it('reads the two tier headers off a Response, and silence as zero', () => {
    expect(cacheWriteTiers(new Headers({
      'Msh-Usage-Cache-Write-Tokens-5m': '120',
      'Msh-Usage-Cache-Write-Tokens-1h': '80',
    }))).toEqual({ write5m: 120, write1h: 80 })

    // Absent headers are silence, not a claim that nothing was written.
    expect(cacheWriteTiers(new Headers())).toEqual({ write5m: 0, write1h: 0 })
    // And a value that is not a plain decimal integer is not a token count.
    expect(cacheWriteTiers(new Headers({
      'Msh-Usage-Cache-Write-Tokens-5m': 'lots',
      'Msh-Usage-Cache-Write-Tokens-1h': '-4',
    }))).toEqual({ write5m: 0, write1h: 0 })
  })
})

/* ------------------------------------------------------------------------- */
/* Adapter: the same accounting, through a real turn                            */
/* ------------------------------------------------------------------------- */

const CATALOG: KimiCodeCatalogModel[] = [
  { id: 'k3', name: 'K3', contextWindow: 262_144, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high' },
  { id: 'k3.1-pro', name: 'K3.1 Pro', contextWindow: 262_144, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'max' },
]

function credentials(): KimiCodeCredentials {
  return {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    expiresIn: 86_400,
    region: 'mainland-cn',
    oauthHost: 'https://auth.kimi.com',
    baseUrl: 'https://api.kimi.com/coding',
  }
}

/** An SSE response, with the headers the service states its cache tier split in. */
function sseResponse(frames: unknown[], headers: Record<string, string> = {}): Response {
  const bytes = new TextEncoder().encode(frames.map((frame) => 'data: ' + JSON.stringify(frame) + '\n\n').join(''))
  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 5) controller.enqueue(bytes.slice(offset, offset + 5))
      controller.close()
    },
  }), { headers })
}

/** The chat-completions frames one finished turn produces, usage included. */
const CHAT_TURN = [
  { choices: [{ delta: { content: 'hi' } }] },
  {
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 40,
      completion_tokens: 6,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 40 },
    },
  },
]

async function buildAdapter(options: {
  catalog?: KimiCodeCatalogModel[]
  fetchFn?: typeof fetch
} = {}) {
  const store = new FileCredentialStore(tmp('kc-cache-cred'))
  vi.spyOn(store, 'read').mockResolvedValue(credentials())
  vi.spyOn(store, 'write').mockResolvedValue(undefined)
  const modelSettings = new FileModelSettingsStore(tmp('kc-cache-models'))
  vi.spyOn(modelSettings, 'read').mockResolvedValue({
    enabled: true,
    enabledModelIds: (options.catalog ?? CATALOG).map((model) => model.id),
    catalogModels: [],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
  })
  const adapter = new KimiCodeAdapter(store, modelSettings, undefined, {
    loadCatalog: async () => options.catalog ?? CATALOG,
    fetchFn: options.fetchFn,
  })
  return { adapter, store, modelSettings }
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function generateOptions(model: string, overrides: Record<string, unknown> = {}): HarnessGenerateOptions {
  return {
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    ...overrides,
  } as unknown as HarnessGenerateOptions
}

describe('the chat-completions wire through the adapter', () => {
  it('posts the K3.1 Pro pair to /v1/chat/completions, the same endpoint as every other model', async () => {
    const urls: string[] = []
    const bodies: Array<Record<string, unknown>> = []
    const fetchFn = (async (url: string, init: RequestInit) => {
      urls.push(String(url))
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return sseResponse(CHAT_TURN)
    }) as unknown as typeof fetch

    const { adapter } = await buildAdapter({ fetchFn })
    const chunks = await drain(adapter.stream(generateOptions('k3.1-pro', { sessionId: 'sess-chat-1' })))

    expect(urls).toEqual(['https://api.kimi.com/coding/v1/chat/completions'])
    expect(bodies[0]).toMatchObject({ model: 'k3.1-pro', stream: true })
    expect(bodies[0]!.max_completion_tokens).toBeTypeOf('number')
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    // The shared URL resolver agrees: one protocol for every model on this line.
    expect(requestUrl('openai', 'mainland-cn')).toBe('https://api.kimi.com/coding/v1/chat/completions')
  })

  it('sends no cache tier field, leaving the lifetime to the service', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchFn = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return sseResponse(CHAT_TURN)
    }) as unknown as typeof fetch

    const { adapter } = await buildAdapter({ fetchFn })
    await drain(adapter.stream(generateOptions('k3.1-pro')))
    expect(bodies[0]).not.toHaveProperty('prompt_cache_options')
  })

  it('turns the tier headers into non-zero cacheWrite5m / 1h totals, all the way to the card', async () => {
    const fetchFn = (async () => sseResponse(CHAT_TURN, {
      'Msh-Usage-Cache-Write-Tokens-5m': '24',
      'Msh-Usage-Cache-Write-Tokens-1h': '16',
    })) as unknown as typeof fetch

    const { adapter, store, modelSettings } = await buildAdapter({ fetchFn })
    await drain(adapter.stream(generateOptions('k3.1-pro', { sessionId: 'sess-chat-2' })))

    const stats = getCacheStats('sess-chat-2')
    expect(stats.cacheWriteTokens).toBe(40)
    expect(stats.cacheWrite5mTokens).toBe(24)
    expect(stats.cacheWrite1hTokens).toBe(16)

    // The status DTO the settings card reads carries the same three numbers.
    const status = await getKimiCodeWebStatus(store, modelSettings, undefined, {
      sessionId: 'sess-chat-2',
      fetchFn: (async () => new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
    })
    expect(status.cache).toMatchObject({
      cacheWriteTokens: 40,
      cacheWrite5mTokens: 24,
      cacheWrite1hTokens: 16,
    })
  })
})

describe('the thinking gate', () => {
  it('lifts a disabled level to the model default on the chat wire', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchFn = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return sseResponse(CHAT_TURN)
    }) as unknown as typeof fetch

    const { adapter } = await buildAdapter({ fetchFn })
    await drain(adapter.stream(generateOptions('k3.1-pro', {
      sessionId: 'sess-gate-1',
      reasoningEffort: 'none' as never,
    })))

    // K3.1 Pro answers 400 for a disabled-thinking request, so the level is
    // raised to the model's own default instead of failing the turn — and the
    // chat wire never sees the "disabled" encoding.
    expect(bodies[0]!.reasoning_effort).toBe('max')
    expect(bodies[0]!.thinking).toMatchObject({ type: 'enabled', effort: 'max' })
    expect(bodies[0]!.thinking).not.toEqual({ type: 'disabled' })
    expect(getLastThinkingCoercion('sess-gate-1')).toMatchObject({ model: 'k3.1-pro', from: 'none', to: 'max' })
  })

  it('applies the same gate on the Anthropic wire too', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchFn = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return sseResponse([
        { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 1 } } },
        { type: 'message_stop' },
      ])
    }) as unknown as typeof fetch

    // The listing routes this id to the Anthropic dialect, which CAN express a
    // disabled thinking block — and must still never send one for a model that
    // cannot stop reasoning. The gate runs before the wire branch, so the wire
    // it was built for is recorded on the diagnostic rather than assumed.
    const { adapter } = await buildAdapter({
      fetchFn,
      catalog: [{ id: 'k3.1-pro', contextWindow: 262_144, protocol: 'anthropic' }],
    })
    await drain(adapter.stream(generateOptions('k3.1-pro', {
      sessionId: 'sess-gate-2',
      reasoningEffort: 'none' as never,
    })))

    expect(bodies[0]!.thinking).toMatchObject({ type: 'enabled' })
    expect(bodies[0]!.thinking).not.toEqual({ type: 'disabled' })
    expect(getLastThinkingCoercion('sess-gate-2')).toMatchObject({ wire: 'anthropic', to: 'max' })
  })

  it('leaves a switchable model free to disable thinking', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchFn = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return sseResponse([{ choices: [{ delta: { content: 'ok' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }])
    }) as unknown as typeof fetch

    const { adapter } = await buildAdapter({ fetchFn })
    await drain(adapter.stream(generateOptions('k3', { reasoningEffort: 'none' as never })))
    expect(bodies[0]!.thinking).toEqual({ type: 'disabled' })
    expect(getLastThinkingCoercion(undefined)).toBeUndefined()
  })
})
