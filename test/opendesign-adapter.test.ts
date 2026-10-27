/**
 * The OpenDesign adapter: stream translation over a live socket double, account
 * rotation on account-level refusals, and the pre-connection retry rule.
 *
 * Nothing here reaches OpenDesign: the pool and settings stores are in-memory
 * or in a temp directory, and fetch is a double.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { OpenDesignAdapter } from '../src/host/opendesign/adapter.ts'
import { DEFAULT_MODELS } from '../src/host/opendesign/types.ts'
import { OpenDesignAccountPool } from '../src/host/opendesign/account-pool.ts'
import {
  FileCredentialStore,
  OpenDesignModelSettingsStore,
  type OpenDesignCredentials,
} from '../src/host/opendesign/token-store.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

class MemoryBackend<T> {
  private data: unknown = null
  async load(): Promise<T | null> {
    return this.data === null ? null : JSON.parse(JSON.stringify(this.data)) as T
  }
  async save(data: T): Promise<void> {
    this.data = JSON.parse(JSON.stringify(data))
  }
  async clear(): Promise<void> {
    this.data = null
  }
}

let dir = ''
let pool: OpenDesignAccountPool
let settings: OpenDesignModelSettingsStore

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opendesign-adapter-'))
  const credential = new FileCredentialStore(path.join(dir, 'credentials.json'), new MemoryBackend<OpenDesignCredentials>() as never)
  pool = new OpenDesignAccountPool({ store: credential, backend: new MemoryBackend() as never })
  settings = new OpenDesignModelSettingsStore(path.join(dir, 'models.json'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function sse(frames: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function options(model = 'gpt-6-luna'): GenerateOptions {
  return { model, messages: [], signal: new AbortController().signal } as unknown as GenerateOptions
}

async function collect(adapter: OpenDesignAdapter, opts: GenerateOptions): Promise<unknown[]> {
  const chunks: unknown[] = []
  for await (const chunk of adapter.stream(opts)) chunks.push(chunk)
  return chunks
}

describe('OpenDesignAdapter', () => {
  it('lists the fallback table before any sync, gated by the line switch', async () => {
    const adapter = new OpenDesignAdapter(settings, { fetchFn: (async () => new Response('{}')) as typeof fetch, accountPool: pool })
    const listed = await adapter.listModels('opendesign')
    expect(listed.length).toBeGreaterThan(0)
    expect(listed.every((model) => model.provider === 'opendesign')).toBe(true)
    await settings.update({ enabled: false })
    expect(await adapter.listModels('opendesign')).toEqual([])
  })

  it('resolves a model with its published window and effort ladder', async () => {
    const adapter = new OpenDesignAdapter(settings, { fetchFn: (async () => new Response('{}')) as typeof fetch, accountPool: pool })
    const resolved = await adapter.resolveModel('opendesign', 'gpt-6-luna')
    expect(resolved.name).toBe('GPT-6 Luna')
    expect(resolved.context?.contextWindow).toBe(1_050_000)
    expect(resolved.reasoning?.efforts.map((effort) => effort.name)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(resolved.reasoning?.defaultEffort).toBeUndefined()
    // The context slot still reserves the configured budget, not the window.
    expect(resolved.defaultMaxTokens).toBe(64_000)
  })

  it('advertises the ladder the table publishes per model, and the default trio where it publishes none', async () => {
    const adapter = new OpenDesignAdapter(settings, { fetchFn: (async () => new Response('{}')) as typeof fetch, accountPool: pool })
    const deepseek = await adapter.resolveModel('opendesign', 'deepseek-v4.1-flash')
    expect(deepseek.reasoning?.efforts.map((effort) => effort.name)).toEqual(['none', 'low', 'high', 'max'])
    expect(deepseek.context?.contextWindow).toBe(1_000_000)
    for (const id of ['deepseek-v4.1-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro']) {
      const model = await adapter.resolveModel('opendesign', id)
      expect(model.reasoning?.defaultEffort).toBe('high')
    }
    // MiMo's rows publish no ladder of their own, and a missing ladder is a fact
    // about the SOURCE rather than a non-reasoning model: the default trio applies.
    const mimo = await adapter.resolveModel('opendesign', 'mimo-v2.6-flash')
    expect(mimo.reasoning?.efforts.map((effort) => effort.name)).toEqual(['low', 'medium', 'high'])
    expect(mimo.context?.contextWindow).toBe(1_048_576)
  })

  it('streams a chat answer through the SSE translator', async () => {
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_good' }, 'main')
    const fetchFn = (async (input: unknown) => {
      const url = String(input)
      expect(url).toBe('https://amr-link.open-design.ai/v1/chat/completions')
      return sse('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\ndata: [DONE]\n\n')
    }) as unknown as typeof fetch
    const adapter = new OpenDesignAdapter(settings, { fetchFn, accountPool: pool })
    const chunks = await collect(adapter, options())
    const texts = chunks.filter((chunk) => (chunk as { type: string }).type === 'text-delta')
    expect(texts.map((chunk) => (chunk as { text: string }).text).join('')).toBe('hello')
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } }
    expect(finish.type).toBe('finish')
    expect(finish.reason.kind).toBe('stop')
    // The account remembers what it served.
    const accounts = await pool.listAccounts()
    expect(accounts[0]!.planLabel).toBe('gpt-6-luna')
  })

  it('rotates past a rejected key and marks it invalid', async () => {
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_bad' }, 'bad')
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_good' }, 'good')
    const fetchFn = (async (input: unknown, init?: RequestInit) => {
      const key = new Headers(init?.headers).get('authorization') ?? ''
      if (key.includes('od_bad')) {
        return Response.json({ error: { code: 'invalid_api_key', message: 'api key not found' } }, { status: 401 })
      }
      return sse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    }) as unknown as typeof fetch
    const adapter = new OpenDesignAdapter(settings, { fetchFn, accountPool: pool })
    const chunks = await collect(adapter, options())
    expect(chunks.some((chunk) => (chunk as { type: string }).type === 'text-delta')).toBe(true)
    const accounts = await pool.listAccounts()
    const bad = accounts.find((account) => account.alias === 'bad')!
    expect(bad.authStatus).toBe('invalid')
    expect(bad.authFailedReason).toContain('rejected')
  })

  it('an OAuth account chats with its runtime key, never the control key', async () => {
    await pool.addAccount({
      kind: 'oauth',
      controlKey: 'vela_ctrl_secret',
      runtimeKey: 'sk-amr-chat',
      user: { name: 'Dev', email: 'dev@example.com' },
    }, 'Dev')
    let seenAuth = ''
    const fetchFn = (async (_input: unknown, init?: RequestInit) => {
      seenAuth = new Headers(init?.headers).get('authorization') ?? ''
      return sse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
    }) as unknown as typeof fetch
    const adapter = new OpenDesignAdapter(settings, { fetchFn, accountPool: pool })
    await collect(adapter, options())
    expect(seenAuth).toBe('Bearer sk-amr-chat')
  })

  it('parks an account whose credits are spent', async () => {
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_spent' }, 'spent')
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_good' }, 'good')
    const fetchFn = (async (_input: unknown, init?: RequestInit) => {
      const key = new Headers(init?.headers).get('authorization') ?? ''
      if (key.includes('od_spent')) {
        return Response.json({ error: { message: 'insufficient credits' } }, { status: 402 })
      }
      return sse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
    }) as unknown as typeof fetch
    const adapter = new OpenDesignAdapter(settings, { fetchFn, accountPool: pool })
    await collect(adapter, options())
    const accounts = await pool.listAccounts()
    const spent = accounts.find((account) => account.alias === 'spent')!
    expect(spent.cooldownUntil).toBeGreaterThan(Date.now())
  })

  it('retries a pre-connection failure instead of blaming the account', async () => {
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_flaky' }, 'flaky')
    let calls = 0
    const fetchFn = (async () => {
      calls += 1
      if (calls === 1) throw new Error('Connect Timeout Error')
      return sse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
    }) as unknown as typeof fetch
    const adapter = new OpenDesignAdapter(settings, { fetchFn, accountPool: pool })
    const chunks = await collect(adapter, options())
    expect(calls).toBe(2)
    expect(chunks.some((chunk) => (chunk as { type: string }).type === 'text-delta')).toBe(true)
    // A transport failure must not mark the account.
    const accounts = await pool.listAccounts()
    expect(accounts[0]!.authStatus).toBeUndefined()
  })

  it('refuses plainly when the line is disabled', async () => {
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_x' }, 'main')
    await settings.update({ enabled: false })
    const adapter = new OpenDesignAdapter(settings, { fetchFn: (async () => new Response('{}')) as typeof fetch, accountPool: pool })
    await expect(collect(adapter, options())).rejects.toThrow(/disabled/)
  })

  it('names the fix when the pool is empty', async () => {
    const adapter = new OpenDesignAdapter(settings, { fetchFn: (async () => new Response('{}')) as typeof fetch, accountPool: pool })
    await expect(collect(adapter, options())).rejects.toThrow(/no usable account/)
  })
})

/**
 * The plan filter: what the subscription actually serves, once somebody measured
 * it, narrows the picker — and nothing else does. The measurement lives in
 * `servedModelIds`; the user's override lives in `forceVisibleModels`.
 */
describe('OpenDesignAdapter plan filter', () => {
  it('hides nothing when no scan has ever succeeded', async () => {
    const adapter = new OpenDesignAdapter(settings, { fetchFn: (async () => new Response('{}')) as typeof fetch, accountPool: pool })
    expect((await settings.read()).servedModelIds).toBeNull()
    const listed = (await adapter.listModels('opendesign')).map((model) => model.id)
    expect(listed).toContain('claude-sonnet-5.5')
    expect(listed).toContain('mimo-v2.6-flash')
    expect(listed).toHaveLength(DEFAULT_MODELS.length)
  })

  it('drops an id the last scan did not list, and keeps the ones it did', async () => {
    await settings.update({ servedModelIds: ['gpt-6-luna', 'kimi-k3'] })
    const adapter = new OpenDesignAdapter(settings, { fetchFn: (async () => new Response('{}')) as typeof fetch, accountPool: pool })
    const listed = (await adapter.listModels('opendesign')).map((model) => model.id)
    expect(listed).toEqual(['gpt-6-luna', 'kimi-k3'])
  })

  it('brings a forced id back without un-hiding anything else', async () => {
    await settings.update({ servedModelIds: ['gpt-6-luna'], forceVisibleModels: ['claude-sonnet-5.5'] })
    const adapter = new OpenDesignAdapter(settings, { fetchFn: (async () => new Response('{}')) as typeof fetch, accountPool: pool })
    const listed = (await adapter.listModels('opendesign')).map((model) => model.id)
    expect(listed).toContain('claude-sonnet-5.5')
    expect(listed).toContain('gpt-6-luna')
    expect(listed).not.toContain('kimi-k3')
  })

  it('leaves a plan-omitted model resolvable, so a forced pick still answers', async () => {
    // The filter narrows what is OFFERED, never whether the model can be resolved:
    // a model the user forced visible — or a session that already named it — must
    // still produce a descriptor rather than a "no such model" error.
    await settings.update({ servedModelIds: ['gpt-6-luna'], forceVisibleModels: ['claude-sonnet-5.5'] })
    const adapter = new OpenDesignAdapter(settings, { fetchFn: (async () => new Response('{}')) as typeof fetch, accountPool: pool })
    const resolved = await adapter.resolveModel('opendesign', 'claude-sonnet-5.5')
    expect(resolved.name).toBe('Claude Sonnet 5.5')
    expect(resolved.context?.contextWindow).toBe(1_000_000)
  })

  it('keeps the tick list and the hidden list in charge of the served models', async () => {
    await settings.update({
      servedModelIds: ['gpt-6-luna', 'kimi-k3', 'claude-sonnet-5.5'],
      enabledModelIds: ['gpt-6-luna', 'kimi-k3'],
      hiddenModels: ['kimi-k3'],
    })
    const adapter = new OpenDesignAdapter(settings, { fetchFn: (async () => new Response('{}')) as typeof fetch, accountPool: pool })
    expect((await adapter.listModels('opendesign')).map((model) => model.id)).toEqual(['gpt-6-luna'])
  })
})
