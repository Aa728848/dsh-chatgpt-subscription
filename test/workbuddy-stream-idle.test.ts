import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { WorkBuddyAdapter } from '../src/host/workbuddy/adapter.ts'
import { FileModelSettingsStore } from '../src/host/workbuddy/token-store.ts'
import { createWorkBuddyStore } from './support/workbuddy-fixtures.ts'
import type { WorkBuddyModelEntry } from '../src/host/workbuddy/model-catalog.ts'

/**
 * 只缩短**这条线路自己的**阈值常量。
 *
 * 缩短的是 `types.ts` 里那个 300_000，而不是 `idle-watchdog.ts`：看门狗本身
 * 必须是真的，否则「pulse 复位了计时」这件事就无从证明。
 */
vi.mock('../src/host/workbuddy/types.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // 内联而不是引用下面的常量：vi.mock 会被提升到文件顶部。
  STREAM_IDLE_TIMEOUT_MS: 250,
}))

const TIMEOUT_MS = 250
/** 心跳间隔必须远小于阈值，否则一次机器卡顿就会误伤正向用例。 */
const HEARTBEAT_GAP_MS = 40
/** 纯注释心跳帧：连接活着，但解析器什么都不产出。 */
const HEARTBEAT = ': ping\n\n'

const CATALOG: WorkBuddyModelEntry[] = [
  {
    id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxContextWindow: 1_000_000, maxTokens: 48_000,
    regions: ['cn', 'intl'], supportsImage: true, reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high', canDisableThinking: true, description: '',
  },
]

const temporaryDirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const dir of temporaryDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

async function makeStore(): Promise<ReturnType<typeof createWorkBuddyStore>> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-idle-'))
  temporaryDirs.push(dir)
  await fs.writeFile(path.join(dir, 'workbuddy-desktop.info'), JSON.stringify({
    account: { uid: 'uid-1', nickname: 'tester', uin: '100000000001', type: 'personal' },
    auth: {
      accessToken: 'token-abc',
      refreshToken: 'refresh-abc',
      expiresAt: Date.now() + 3_600_000,
      domain: 'copilot.tencent.com',
    },
  }), 'utf8')
  return createWorkBuddyStore(dir)
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

const COMPLETION = 'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'

const OPTIONS = {
  provider: 'workbuddy',
  model: 'glm-5.3',
  messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
} as unknown as GenerateOptions

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('WorkBuddy idle watchdog counts transport activity, not displayable chunks', () => {
  it('survives a long run of heartbeat-only frames that never produce a chunk', async () => {
    const store = await makeStore()
    let sentPulses = 0
    const fetchFn = (async (_url: any, init: any) => {
      const body = scheduledBody(
        init?.signal,
        // 25 × 40ms = 1000ms 的纯心跳，是 250ms 阈值的四倍。
        heartbeatsThen([COMPLETION], 25),
      )
      sentPulses += 1
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch

    const adapter = new WorkBuddyAdapter(
      store,
      new FileModelSettingsStore(path.join(os.tmpdir(), `wb-idle-models-${Date.now()}.json`)),
      undefined,
      { fetchFn, loadCatalog: async () => CATALOG },
    )

    const chunks = await drain(adapter.stream(OPTIONS))

    expect(sentPulses).toBe(1)
    expect(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')).toBe('ok')
    expect(chunks.find((chunk) => chunk.type === 'finish')).toMatchObject({ reason: { kind: 'stop' } })
  })

  it('still throws TIMEOUT when the connection really is silent', async () => {
    const store = await makeStore()
    const fetchFn = (async (_url: any, init: any) => {
      // 一个字节都不给：阈值之后才关门，所以看门狗必须先动手。
      const body = scheduledBody(init?.signal, [{ text: COMPLETION, afterMs: TIMEOUT_MS * 4 }])
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch

    const adapter = new WorkBuddyAdapter(
      store,
      new FileModelSettingsStore(path.join(os.tmpdir(), `wb-idle-silent-${Date.now()}.json`)),
      undefined,
      { fetchFn, loadCatalog: async () => CATALOG },
    )

    await expect(drain(adapter.stream(OPTIONS))).rejects.toMatchObject({ code: 'TIMEOUT' })
  })
})
