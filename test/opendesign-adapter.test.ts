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

  /**
   * The header deadline is a HEADER deadline.
   *
   * A thinking-heavy answer can run for minutes, and the failure it used to
   * cause was silent and repeatable: the deadline stayed armed on the fetch
   * signal, so at 180s the body was aborted mid-reasoning with "The operation
   * was aborted due to timeout", the host retried, and the retry died at the
   * same wall clock. Here the budget is 30ms and the answer starts after 40ms,
   * so an armed deadline fails this test while a cleared one passes.
   */
  it('keeps streaming past the header deadline once the headers arrived', async () => {
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_good' }, 'main')
    const encoder = new TextEncoder()
    const frames = [
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" again"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    ]
    const fetchFn = (async (_input: unknown, init?: RequestInit) => {
      const signal = init?.signal ?? undefined
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          let settled = false
          signal?.addEventListener('abort', () => {
            if (settled) return
            settled = true
            try {
              controller.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
            } catch { /* already closed */ }
          })
          let index = 0
          const push = (): void => {
            if (settled) return
            if (index >= frames.length) {
              settled = true
              controller.close()
              return
            }
            controller.enqueue(encoder.encode(frames[index]!))
            index += 1
            setTimeout(push, 25)
          }
          // Longer than the 30ms header budget, so nothing but the clear() keeps
          // this answer alive.
          setTimeout(push, 40)
        },
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch
    const adapter = new OpenDesignAdapter(settings, { fetchFn, accountPool: pool, headerTimeoutMs: 30 })
    const chunks = await collect(adapter, options())
    const text = chunks
      .filter((chunk) => (chunk as { type: string }).type === 'text-delta')
      .map((chunk) => (chunk as { text: string }).text)
      .join('')
    expect(text).toBe('hello again')
    expect((chunks[chunks.length - 1] as { type: string }).type).toBe('finish')
  })

  it('still gives up when the headers never arrive', async () => {
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_good' }, 'main')
    const fetchFn = (async (_input: unknown, init?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
      })
    })) as unknown as typeof fetch
    const adapter = new OpenDesignAdapter(settings, { fetchFn, accountPool: pool, headerTimeoutMs: 30 })
    await expect(collect(adapter, options())).rejects.toThrow(/aborted due to timeout/i)
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

/**
 * The wire-level seams that live at the adapter boundary rather than in the
 * mapper: the tool-update capability it advertises, the request image budget it
 * applies before resolving attachments, and the ordering refusal it raises
 * before a request can leave the process.
 */
describe('OpenDesignAdapter wire seams', () => {
  it('advertises the in-history tool update mode older harnesses ignore', async () => {
    const adapter = new OpenDesignAdapter(settings, { fetchFn: (async () => new Response('{}')) as typeof fetch, accountPool: pool })
    const resolved = await adapter.resolveModel('opendesign', 'gpt-6-luna')
    expect((resolved as unknown as { toolUpdate?: string }).toolUpdate).toBe('in-history')
  })

  it('drops the oldest image when the request payload really exceeds the shared budget', async () => {
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_good' }, 'main')
    let sent: Record<string, unknown> | undefined
    const fetchFn = (async (_input: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>
      return sse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    }) as unknown as typeof fetch
    // 1.2 MB stored encodes to ~1.6 MB of base64 on the wire: that is the length
    // the budget is about, and both images are sent as stored (both fit the
    // long-edge ceiling, so no smaller request version exists).
    const big = Buffer.alloc(1_200_000, 9)
    const small = Buffer.alloc(1024, 7)
    const attachments = {
      async readImage(ref: { attachmentId: string }) {
        const data = ref.attachmentId === 'big' ? big : small
        return {
          ref: { attachmentId: ref.attachmentId, mediaType: 'image/png', bytes: data.length, width: 100, height: 100, name: ref.attachmentId + '.png' },
          data,
        }
      },
      async readImageRequest() {
        throw new Error('no downscale is expected for an image inside the long-edge ceiling')
      },
    }
    const adapter = new OpenDesignAdapter(settings, {
      fetchFn,
      accountPool: pool,
      attachments: attachments as never,
    })
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'first' },
          // 1.2 MB stored encodes to ~1.6 MB of base64, over the shared 1.5 MiB budget.
          { type: 'image', attachment: { attachmentId: 'big', mediaType: 'image/png', bytes: 1_200_000, width: 800, height: 600, name: 'big.png' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'image', attachment: { attachmentId: 'small', mediaType: 'image/png', bytes: 1024, width: 100, height: 100, name: 'small.png' } },
        ],
      },
    ]
    await collect(adapter, { model: 'gpt-6-luna', signal: new AbortController().signal, messages } as unknown as GenerateOptions)
    const wire = JSON.stringify(sent?.messages)
    // The oldest occurrence is the one replaced, and it is replaced by the
    // shared placeholder rather than by an unreadable-image notice.
    expect(wire).toContain('image omitted to keep the request within its size limit')
    expect(wire).not.toContain('image unavailable')
    // The remaining image is still sent, and it is the only one sent: the
    // replaced occurrence contributes text, not a second image part.
    const shape = (sent?.messages as Array<{ role: string; content: unknown }>).map((message) => {
      if (typeof message.content === 'string') return message.role + ':text'
      return message.role + ':' + (message.content as Array<{ type: string }>).map((part) => part.type).join('+')
    })
    // The first message no longer carries an image at all, so it collapses to
    // the plain-string form (its text keeps both the original text and the
    // placeholder); the second still sends its picture.
    expect(shape).toEqual(['user:text', 'user:image_url'])
    expect(wire).toContain(small.toString('base64').slice(0, 24))
    // Durable history is untouched: only the request that was about to be built changed.
    expect((messages[0]!.content[1] as { type: string }).type).toBe('image')
  })

  /**
   * The budget measures what is SENT, not what is STORED.
   *
   * An oversized image is downsized before delivery — that is what
   * `readImageRequest` is for — so a 5 MB screenshot reaches the wire as a
   * ~270 KB request version. Screening on `attachment.bytes` counted that image
   * as ~6.7 MB of base64 and dropped it, which is the over-count the shared
   * helper documents on `requestImagePayloadLength`.
   */
  it('keeps an image whose stored bytes exceed the budget once a request version fits', async () => {
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_good' }, 'main')
    let sent: Record<string, unknown> | undefined
    const fetchFn = (async (_input: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>
      return sse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    }) as unknown as typeof fetch
    const stored = Buffer.alloc(5_000_000, 3)
    const version = Buffer.alloc(200_000, 5)
    let requestReads = 0
    let storedReads = 0
    const attachments = {
      async readImage() {
        storedReads += 1
        return {
          ref: { attachmentId: 'screenshot', mediaType: 'image/png', bytes: stored.length, width: 2000, height: 1500, name: 'screenshot.png' },
          data: stored,
        }
      },
      async readImageRequest(_ref: unknown, target: { width: number; height: number }) {
        requestReads += 1
        // The target the shared helper derives from 2000x1500 and its ceiling.
        expect(target.width).toBe(1024)
        expect(target.height).toBe(768)
        return { mediaType: 'image/png', data: version, width: 1024, height: 768 }
      },
    }
    const adapter = new OpenDesignAdapter(settings, {
      fetchFn,
      accountPool: pool,
      attachments: attachments as never,
    })
    await collect(adapter, {
      model: 'gpt-6-luna',
      signal: new AbortController().signal,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', attachment: { attachmentId: 'screenshot', mediaType: 'image/png', bytes: 5_000_000, width: 2000, height: 1500, name: 'screenshot.png' } },
          ],
        },
      ],
    } as unknown as GenerateOptions)
    const wire = JSON.stringify(sent?.messages)
    // ONE resolution: the same map measured the budget and built the body, so a
    // second read of the same attachment would mean the offload step was looking
    // at a different view than the mapper.
    expect(requestReads).toBe(1)
    expect(storedReads).toBe(0)
    // Not offloaded: the request version fits the shared 1.5 MiB budget.
    expect(wire).not.toContain('image omitted to keep the request within its size limit')
    // ...and what reached the wire is the request version, not the stored 5 MB.
    expect(wire).toContain(version.toString('base64').slice(0, 24))
    expect(wire).not.toContain(stored.toString('base64').slice(0, 24))
    const shape = (sent?.messages as Array<{ role: string; content: unknown }>).map((message) => {
      if (typeof message.content === 'string') return message.role + ':text'
      return message.role + ':' + (message.content as Array<{ type: string }>).map((part) => part.type).join('+')
    })
    expect(shape).toEqual(['user:image_url'])
  })

  it('refuses an orphan tool result before the request goes out', async () => {
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_good' }, 'main')
    let calls = 0
    const fetchFn = (async () => {
      calls += 1
      return sse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
    }) as unknown as typeof fetch
    const adapter = new OpenDesignAdapter(settings, { fetchFn, accountPool: pool })
    const failure = await collect(adapter, {
      model: 'gpt-6-luna',
      signal: new AbortController().signal,
      messages: [
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 'orphan_9', content: [{ type: 'text', text: 'x' }] }] },
      ],
    } as unknown as GenerateOptions).then(() => undefined, (error: unknown) => error)
    expect(calls).toBe(0)
    const caught = failure as { code?: string; message?: string }
    expect(caught.code).toBe('INVALID_REQUEST')
    expect(String(caught.message)).toContain('orphan_9')
  })
})
