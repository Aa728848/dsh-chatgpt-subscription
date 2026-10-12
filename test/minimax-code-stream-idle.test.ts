import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { MinimaxCodeAdapter } from '../src/host/minimax-code/adapter.ts'
import { MinimaxCodeCredentialStore } from '../src/host/minimax-code/token-store.ts'

/**
 * 只缩短**这条线路自己的**阈值常量。
 *
 * 缩短的是 `types.ts` 里那个 300_000，而不是 `idle-watchdog.ts`：看门狗本身
 * 必须是真的，否则「pulse 复位了计时」这件事就无从证明。
 */
vi.mock('../src/host/minimax-code/types.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // 内联而不是引用下面的常量：vi.mock 会被提升到文件顶部。
  STREAM_IDLE_TIMEOUT_MS: 250,
}))

const TIMEOUT_MS = 250
/** 心跳间隔必须远小于阈值，否则一次机器卡顿就会误伤正向用例。 */
const HEARTBEAT_GAP_MS = 40
/** 纯注释心跳帧：连接活着，但解析器什么都不产出。 */
const HEARTBEAT = ': ping\n\n'

const temporaryDirs: string[] = []
let originalMinimaxHome: string | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  if (originalMinimaxHome === undefined) delete process.env.MINIMAX_HOME
  else process.env.MINIMAX_HOME = originalMinimaxHome
  for (const dir of temporaryDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

async function makeStore(): Promise<MinimaxCodeCredentialStore> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-idle-'))
  temporaryDirs.push(home)
  originalMinimaxHome = process.env.MINIMAX_HOME
  process.env.MINIMAX_HOME = home
  const store = new MinimaxCodeCredentialStore()
  await store.write({
    accessToken: 'ACCESS', refreshToken: 'r-own', tokenType: 'Bearer', clientId: 'mcode-public',
    scopes: [], audience: '', expiresAtMs: Date.now() + 3_600_000, generation: 1, loginEpoch: 'e',
    buildEnv: 'prod', region: 'cn', recordKey: null, source: 'file',
  })
  return store
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
  provider: 'minimax-code',
  model: 'MiniMax-M3',
  messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
} as unknown as GenerateOptions

describe('MiniMax Code idle watchdog counts transport activity, not displayable chunks', () => {
  it('survives a long run of heartbeat-only frames that never produce a chunk', async () => {
    const store = await makeStore()
    const fetchFn = (async (_url: any, init: any) => new Response(
      // 25 × 40ms = 1000ms 的纯心跳，是 250ms 阈值的四倍。
      scheduledBody(init?.signal, heartbeatsThen([COMPLETION], 25)),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )) as unknown as typeof fetch

    const chunks = await drain(new MinimaxCodeAdapter(store, { fetchFn }).stream(OPTIONS))

    expect(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')).toBe('ok')
  })

  it('still throws TIMEOUT when the connection really is silent', async () => {
    const store = await makeStore()
    const fetchFn = (async (_url: any, init: any) => new Response(
      // 一个字节都不给：阈值之后才关门，所以看门狗必须先动手。
      scheduledBody(init?.signal, [{ text: COMPLETION, afterMs: TIMEOUT_MS * 4 }]),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )) as unknown as typeof fetch

    await expect(drain(new MinimaxCodeAdapter(store, { fetchFn }).stream(OPTIONS)))
      .rejects.toMatchObject({ code: 'TIMEOUT' })
  })
})
