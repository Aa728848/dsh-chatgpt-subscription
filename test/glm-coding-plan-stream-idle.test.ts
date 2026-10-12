import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { GlmCodingPlanAdapter } from '../src/host/glm-coding-plan/adapter.ts'
import {
  credentialsFromCliLogin,
  type GlmCodingPlanCredentials,
} from '../src/host/glm-coding-plan/token-store.ts'
import { undeclaredGlmModelEntry, type GlmModelEntry } from '../src/host/glm-coding-plan/model-catalog.ts'
import type { GlmCliCredentials } from '../src/host/glm-coding-plan/oauth.ts'

/**
 * 只缩短**这条线路自己的**阈值常量。
 *
 * 缩短的是 `types.ts` 里那个 300_000，而不是 `idle-watchdog.ts`：看门狗本身
 * 必须是真的，否则「pulse 复位了计时」这件事就无从证明。
 */
vi.mock('../src/host/glm-coding-plan/types.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // 内联而不是引用下面的常量：vi.mock 会被提升到文件顶部。
  STREAM_IDLE_TIMEOUT_MS: 250,
}))

/**
 * 随包目录四行全是 anthropic 面，openai 面只能由运行期目录带进来。
 * 这里换掉的是目录来源——看门狗没有被换掉。
 */
let CACHED_CATALOG: GlmModelEntry[] = []
vi.mock('../src/host/glm-coding-plan/client.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedCatalog: () => CACHED_CATALOG,
}))

const TIMEOUT_MS = 250
/** 心跳间隔必须远小于阈值，否则一次机器卡顿就会误伤正向用例。 */
const HEARTBEAT_GAP_MS = 40
/** 纯注释心跳帧：连接活着，但解析器什么都不产出。 */
const HEARTBEAT = ': ping\n\n'

const OPENAI_ENTRY: GlmModelEntry = {
  ...undeclaredGlmModelEntry('glm-openai-row'),
  wire: 'openai',
  reasoningEfforts: ['low', 'high', 'max'],
  supportsImages: true,
  defaultMaxTokens: 32_768,
}

function credentials(): GlmCodingPlanCredentials {
  const session: GlmCliCredentials = {
    region: 'intl',
    accessToken: 'access-token',
    refreshToken: null,
    zcodeToken: null,
    userId: 'user_1',
    email: 'a@example.com',
    displayName: 'A',
    hasAvatar: false,
    authenticatedAt: 1_700_000_000_000,
  }
  return credentialsFromCliLogin(session, {
    region: 'intl',
    codingPlanKey: 'ak_1.sk_1',
    apiKeyId: 'ak_1',
    secretKey: 'sk_1',
    keyName: 'dsh-glm-coding-plan',
    keyCreated: false,
    organizationId: 'org_1',
    projectId: 'proj_1',
    accountName: '测试机构',
    bizToken: 'biz.jwt',
    bizTokenExpiresAt: Date.now() + 3_600_000,
    planLevel: 'pro',
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

const ANTHROPIC_COMPLETION = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
  'data: {"type":"message_stop"}',
  '',
].join('\n\n')

const OPENAI_COMPLETION = [
  'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  'data: [DONE]',
  '',
].join('\n\n')

function adapterFor(fetchFn: typeof fetch): GlmCodingPlanAdapter {
  return new GlmCodingPlanAdapter(
    { read: async () => credentials() } as never,
    {
      read: async () => ({
        enabled: true,
        enabledModelIds: ['GLM-5.3', OPENAI_ENTRY.id],
        contextWindowOverrides: {},
        defaultReasoningEffort: null,
        selectedAccountId: null,
      }),
    } as never,
    undefined,
    { fetchFn },
  )
}

const OPTIONS = (model: string): GenerateOptions => ({
  model,
  messages: [{ role: 'user', content: '你好' }],
} as unknown as GenerateOptions)

afterEach(() => {
  CACHED_CATALOG = []
  vi.restoreAllMocks()
})

describe('GLM Coding Plan idle watchdog counts transport activity, not displayable chunks', () => {
  // 这条线路有两份读取分支，两个都接线，所以两个都验。
  it.each([
    ['anthropic', 'GLM-5.3', ANTHROPIC_COMPLETION],
    ['openai', OPENAI_ENTRY.id, OPENAI_COMPLETION],
  ])('survives a heartbeat-only %s run that never produces a chunk', async (wire, model, completion) => {
    if (wire === 'openai') CACHED_CATALOG = [OPENAI_ENTRY]
    const fetchFn = (async (_url: any, init: any) => new Response(
      // 25 × 40ms = 1000ms 的纯心跳，是 250ms 阈值的四倍。
      scheduledBody(init?.signal, heartbeatsThen([completion], 25)),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )) as unknown as typeof fetch

    const chunks = await drain(adapterFor(fetchFn).stream(OPTIONS(model)))

    expect(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')).toBe('ok')
  })

  it.each([
    ['anthropic', 'GLM-5.3'],
    ['openai', OPENAI_ENTRY.id],
  ])('still throws TIMEOUT on a truly silent %s stream', async (wire, model) => {
    if (wire === 'openai') CACHED_CATALOG = [OPENAI_ENTRY]
    const fetchFn = (async (_url: any, init: any) => new Response(
      // 一个字节都不给：阈值之后才关门，所以看门狗必须先动手。
      scheduledBody(init?.signal, [{ text: ANTHROPIC_COMPLETION, afterMs: TIMEOUT_MS * 4 }]),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )) as unknown as typeof fetch

    await expect(drain(adapterFor(fetchFn).stream(OPTIONS(model)))).rejects.toMatchObject({ code: 'TIMEOUT' })
  })
})
