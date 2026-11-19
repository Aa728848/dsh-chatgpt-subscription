import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ClaudeAdapter } from '../src/host/claude/adapter.ts'
import { FALLBACK_MODELS } from '../src/host/claude/model-catalog.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  type ClaudeCredentialDocument,
  type ClaudeCredentials,
} from '../src/host/claude/token-store.ts'
import { PROVIDER_ID } from '../src/host/claude/types.ts'
import type { CredentialStore } from '../src/host/token-store.ts'

// Keep the production watchdog real and shorten only this route's budgets.
vi.mock('../src/host/claude/types.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  STREAM_IDLE_TIMEOUT_MS: 250,
  STREAM_FIRST_OUTPUT_TIMEOUT_MS: 500,
}))

const TIMEOUT_MS = 250

function memoryBackend<T>(): CredentialStore<T> {
  let value: T | null = null
  return {
    async load() { return value },
    async save(next) { value = next },
    async clear() { value = null },
  }
}

function credentials(): ClaudeCredentials {
  return {
    accessToken: 'ACCESS-1',
    refreshToken: 'REFRESH-1',
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    scopes: ['user:inference', 'user:profile'],
    account: { uuid: 'uuid-ACCESS-1' },
  }
}

async function buildAdapter(fetchFn: typeof fetch): Promise<ClaudeAdapter> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const store = new FileCredentialStore(
    path.join(os.tmpdir(), `claude-idle-${suffix}.json`),
    memoryBackend<ClaudeCredentialDocument>(),
  )
  await store.saveAccount(credentials())
  const settings = new FileModelSettingsStore(path.join(os.tmpdir(), `claude-idle-models-${suffix}.json`))
  return new ClaudeAdapter(store, settings, undefined, {
    fetchFn,
    loadCatalog: async () => FALLBACK_MODELS as never[],
  })
}

/** A body whose delayed reads stop when the real watchdog aborts the request. */
function scheduledBody(
  signal: AbortSignal | null | undefined,
  plan: ReadonlyArray<{ text: string; afterMs: number }>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let timer: ReturnType<typeof setTimeout> | undefined
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let index = 0
      const pump = (): void => {
        const next = plan[index]
        if (next === undefined) {
          controller.close()
          return
        }
        index += 1
        timer = setTimeout(() => {
          if (signal?.aborted === true) return
          controller.enqueue(encoder.encode(next.text))
          pump()
        }, next.afterMs)
      }
      pump()
      signal?.addEventListener('abort', () => {
        if (timer !== undefined) clearTimeout(timer)
        try {
          controller.error(signal.reason)
        } catch {
          // The stream may already have finished when the abort arrives.
        }
      })
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer)
    },
  })
}

const MESSAGE_START = 'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":1}}}'
const BLOCK_START = 'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}'
const TEXT_DELTA = 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}'
const MESSAGE_STOP = 'data: {"type":"message_stop"}'
const FIRST_OUTPUT = [MESSAGE_START, BLOCK_START, TEXT_DELTA, ''].join('\n\n')
const COMPLETION = [FIRST_OUTPUT, MESSAGE_STOP, ''].join('\n\n')

const OPTIONS = {
  provider: PROVIDER_ID,
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
} as GenerateOptions

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

async function failureOf(stream: AsyncIterable<StreamChunk>): Promise<unknown> {
  try {
    await drain(stream)
  } catch (error) {
    return error
  }
  throw new Error('expected the stream to fail')
}

describe('Claude stream idle watchdog (#118)', () => {
  it('uses the longer first-output budget for a slow prefill', async () => {
    const fetchFn = (async (_url: any, init: any) => {
      // Longer than the 250 ms idle budget, but inside the 500 ms first-output one.
      await new Promise((resolve) => setTimeout(resolve, 300))
      return new Response(scheduledBody(init?.signal, [{ text: COMPLETION, afterMs: 0 }]), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as unknown as typeof fetch

    const chunks = await drain((await buildAdapter(fetchFn)).stream(OPTIONS))
    expect(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')).toBe('ok')
  })

  it('still reports TIMEOUT when no output ever arrives', async () => {
    const fetchFn = (async (_url: any, init: any) => new Response(
      scheduledBody(init?.signal, [{ text: COMPLETION, afterMs: TIMEOUT_MS * 4 }]),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )) as unknown as typeof fetch

    await expect(drain((await buildAdapter(fetchFn)).stream(OPTIONS))).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('returns to the shorter idle budget after the first output', async () => {
    const fetchFn = (async (_url: any, init: any) => new Response(
      scheduledBody(init?.signal, [
        { text: FIRST_OUTPUT, afterMs: 0 },
        { text: MESSAGE_STOP + '\n\n', afterMs: TIMEOUT_MS * 4 },
      ]),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )) as unknown as typeof fetch

    await expect(drain((await buildAdapter(fetchFn)).stream(OPTIONS))).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('classifies a raw disconnect after output as TRANSPORT and preserves its cause', async () => {
    const cause = new TypeError('terminated')
    const encoder = new TextEncoder()
    let sent = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true
          controller.enqueue(encoder.encode(FIRST_OUTPUT))
          return
        }
        controller.error(cause)
      },
    })
    const fetchFn = (async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })) as unknown as typeof fetch

    const error = await failureOf((await buildAdapter(fetchFn)).stream(OPTIONS))
    expect(error).toMatchObject({
      code: 'TRANSPORT',
      message: 'Claude stream failed: terminated',
      cause,
    })
  })

  it('ships a first-output budget above the in-stream idle budget', async () => {
    const actual = await vi.importActual<typeof import('../src/host/claude/types.ts')>(
      '../src/host/claude/types.ts',
    )
    expect(actual.STREAM_FIRST_OUTPUT_TIMEOUT_MS).toBe(360_000)
    expect(actual.STREAM_FIRST_OUTPUT_TIMEOUT_MS).toBeGreaterThan(actual.STREAM_IDLE_TIMEOUT_MS)
  })
})
