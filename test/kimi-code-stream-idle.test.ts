import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { KimiCodeAdapter } from '../src/host/kimi-code/adapter.ts'
import { FileCredentialStore, FileModelSettingsStore } from '../src/host/kimi-code/token-store.ts'
import { clearCachedCatalog } from '../src/host/kimi-code/client.ts'
import type { KimiCodeCatalogModel, KimiCodeCredentials } from '../src/host/kimi-code/token-store.ts'

/**
 * 只缩短**这条线路自己的**阈值常量。
 *
 * 缩短的是 `types.ts` 里那个 300_000，而不是 `idle-watchdog.ts`：看门狗本身
 * 必须是真的，否则「pulse 复位了计时」这件事就无从证明。
 */
vi.mock('../src/host/kimi-code/types.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // 内联而不是引用下面的常量：vi.mock 会被提升到文件顶部。
  STREAM_IDLE_TIMEOUT_MS: 250,
}))

const TIMEOUT_MS = 250
/** 心跳间隔必须远小于阈值，否则一次机器卡顿就会误伤正向用例。 */
const HEARTBEAT_GAP_MS = 40
/** 纯注释心跳帧：连接活着，但解析器什么都不产出。 */
const HEARTBEAT = ': ping\n\n'

const CATALOG = [
  { id: 'k3', name: 'K3', contextWindow: 262_144, protocol: 'anthropic' },
] satisfies KimiCodeCatalogModel[]

function credentials(): KimiCodeCredentials {
  return {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    // Far enough out that the adapter never tries to refresh during a test.
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    expiresIn: 86_400,
    region: 'mainland-cn',
    oauthHost: 'https://auth.kimi.com',
    baseUrl: 'https://api.kimi.com/coding',
  }
}

function tmp(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

function buildAdapter(fetchFn: typeof fetch): KimiCodeAdapter {
  const store = new FileCredentialStore(tmp('kc-idle-cred'))
  vi.spyOn(store, 'read').mockResolvedValue(credentials())
  vi.spyOn(store, 'write').mockResolvedValue(undefined)
  const modelSettings = new FileModelSettingsStore(tmp('kc-idle-models'))
  vi.spyOn(modelSettings, 'read').mockResolvedValue({
    enabled: true,
    enabledModelIds: CATALOG.map((model) => model.id),
    catalogModels: [],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
    cacheTtl: null,
  })
  return new KimiCodeAdapter(store, modelSettings, undefined, {
    fetchFn,
    loadCatalog: async () => CATALOG,
  })
}

/**
 * A response body that hands out bytes on a real timeline.
 *
 * The watchdog only *notifies* through its signal — it never rejects the pending
 * `reader.read()` itself — so a fake body that ignores abort would hang the
 * silence case forever instead of proving the timeout still fires.
 */
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
          // 流已经结束，abort 只是迟到的通知。
        }
      })
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer)
    },
  })
}

/** 心跳若干次之后才吐出真正的内容帧。 */
function heartbeatsThen(frames: string[], count: number): Array<{ text: string; afterMs: number }> {
  const plan: Array<{ text: string; afterMs: number }> = []
  for (let index = 0; index < count; index += 1) plan.push({ text: HEARTBEAT, afterMs: HEARTBEAT_GAP_MS })
  for (const frame of frames) plan.push({ text: frame, afterMs: 0 })
  return plan
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const COMPLETION = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
  'data: {"type":"message_stop"}',
  '',
].join('\n\n')

const OPTIONS = {
  model: 'k3',
  messages: [{ role: 'user', content: 'hello' } as never],
} as unknown as GenerateOptions

afterEach(() => {
  clearCachedCatalog()
  vi.restoreAllMocks()
})

describe('Kimi Code idle watchdog counts transport activity, not displayable chunks', () => {
  it('survives a long run of heartbeat-only frames that never produce a chunk', async () => {
    const fetchFn = (async (_url: any, init: any) => new Response(
      // 25 × 40ms = 1000ms 的纯心跳，是 250ms 阈值的四倍。
      scheduledBody(init?.signal, heartbeatsThen([COMPLETION], 25)),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )) as unknown as typeof fetch

    const chunks = await drain(buildAdapter(fetchFn).stream(OPTIONS))

    expect(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')).toBe('ok')
  })

  it('still throws TIMEOUT when the connection really is silent', async () => {
    const fetchFn = (async (_url: any, init: any) => new Response(
      // 一个字节都不给：阈值之后才关门，所以看门狗必须先动手。
      scheduledBody(init?.signal, [{ text: COMPLETION, afterMs: TIMEOUT_MS * 4 }]),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )) as unknown as typeof fetch

    await expect(drain(buildAdapter(fetchFn).stream(OPTIONS))).rejects.toMatchObject({ code: 'TIMEOUT' })
  })
})
