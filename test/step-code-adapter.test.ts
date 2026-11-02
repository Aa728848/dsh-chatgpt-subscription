/**
 * Step Code 适配器的端到端测试（mock fetch）：一次请求从 GenerateOptions 走到
 * chat/completions 的 POST，再把 SSE 拆回 DSH chunks。
 *
 * 这一层钉的是**只有适配器层能看见**的两件事：
 *
 * 1. **图片预算的顺序**：图片先解析（拿到真正上线的字节），再把**同一份**解析结果
 *    交给预算关卡。顺序反了，预算量到的就是**存储字节**——一张 20 MB 的截图被算成
 *    ~26 MB 的 base64，于是「缩放后其实只有几 KB、装得下」的图被当成超限丢掉。
 * 2. **wire 上的输出上限**：只有调用方要的、或目录**真实**声明的 cap 才会变成
 *    `max_tokens`；没有 cap 时整个字段不出现（上下文窗口是 host 元数据，不是上限）。
 *
 * 全部离线：fetch、附件存储与目录发现都是 mock / 本地 fixture，
 * **不发任何真实请求**，也不需要任何真实凭据。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { StepCodeAdapter } from '../src/host/step-code/adapter.ts'
import { clearCachedStepModelCatalog, loadStepModelCatalog } from '../src/host/step-code/client.ts'
import {
  StepCodeCredentialStore,
  StepCodeModelSettingsStore,
  type StepCodeCredentials,
} from '../src/host/step-code/token-store.ts'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

class MemoryBackend<T> {
  private data: unknown = null
  async load(): Promise<T | null> { return this.data === null ? null : JSON.parse(JSON.stringify(this.data)) as T }
  async save(data: T): Promise<void> { this.data = JSON.parse(JSON.stringify(data)) }
  async clear(): Promise<void> { this.data = null }
}

function credentials(): StepCodeCredentials {
  return {
    apiKey: 'sk-test',
    origin: 'manual',
    profile: 'platform_cn',
    uid: 'u-1',
    accountName: null,
    authenticatedAt: Date.now(),
  }
}

/** 一次完整的回答：两段文本 + 一帧 usage + [DONE]。 */
const ANSWER_SSE =
  'data: {"choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}\n'
  + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],'
  + '"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n'
  + 'data: [DONE]\n'

function sseResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/**
 * 实时目录里的一行：声明了图片输入，**没有**声明输出上限。
 *
 * 输出上限缺失是常态（端点不报它），所以这一行正好是「没有 cap」的样本。
 */
const CATALOG = {
  data: [
    {
      id: 'step-3',
      name: 'Step 3',
      max_input_tokens: 256000,
      enable_reason: true,
      enable_vision_input: true,
      reasoning_effort_support_list: ['low', 'high'],
    },
  ],
}

/** 目录里**报了**真实输出上限的那一行。 */
const CATALOG_WITH_CAP = {
  data: [
    {
      id: 'step-3',
      name: 'Step 3',
      max_input_tokens: 256000,
      max_output_tokens: 8192,
      enable_reason: true,
      enable_vision_input: true,
      reasoning_effort_support_list: ['low', 'high'],
    },
  ],
}

/**
 * 一张「存储态 20 MB、请求版本只有几 KB」的图。
 *
 * 长边 4000 > 1024，所以适配器走的是**缩放后的请求版本**；而存储字节
 * （20 MB）远在这条线的图片预算（12 MB）之上——这正是「缩放后装得下」与
 * 「按存储字节量就装不下」的分界线。
 */
const HUGE_STORED_IMAGE = {
  attachmentId: 'img-1',
  mediaType: 'image/png',
  bytes: 20_000_000,
  width: 4000,
  height: 3000,
} as const

/** 缩放后的请求版本：长边 1024（不超过上限），字节数很小。 */
const SCALED_VERSION = {
  width: 1024,
  height: 768,
  mediaType: 'image/png',
  data: Buffer.from('scaled-request-version'),
}

/**
 * 附件存储的 mock：只有缩放后的请求版本会真的被读到。
 *
 * `versions` 按 attachmentId 给出各自的请求版本字节（不给就用默认那份小的）。
 */
function attachmentsStore(versions: Record<string, Buffer> = {}) {
  return {
    readImage: async () => {
      throw new Error('must not read the stored image: the long edge is over the ceiling')
    },
    readImageRequest: async (ref: { attachmentId: string }) => ({
      width: 1024,
      height: 768,
      mediaType: 'image/png',
      data: versions[ref.attachmentId] ?? SCALED_VERSION.data,
    }),
  }
}

/**
 * 两张附件图：旧的请求版本仍然很大，新的很小。
 *
 * 合起来超过这条线的图片预算（12 MB），所以最旧的那张要让位——
 * 这正是「真超预算最旧优先」。
 */
const OLD_BIG_IMAGE = {
  attachmentId: 'img-old',
  mediaType: 'image/png',
  bytes: 12_000_000,
  width: 4000,
  height: 3000,
} as const

const NEW_SMALL_IMAGE = {
  attachmentId: 'img-new',
  mediaType: 'image/png',
  bytes: 64,
  width: 4000,
  height: 3000,
} as const

/** 旧图的请求版本：9.5 MB 原始字节 → base64 约 12.67 MB（单张就顶满预算）。 */
const OLD_BIG_VERSION = Buffer.alloc(9_500_000, 0x41)

/** 新图的请求版本：几十字节。 */
const NEW_SMALL_VERSION = Buffer.from('small-request-version')

interface Rig {
  adapter: StepCodeAdapter
  settingsStore: StepCodeModelSettingsStore
  body: () => string
}

/** 一套自洽的适配器：凭据在内存里，目录由 mock fetch 应答，附件由 mock 提供。 */
async function rig(options: { catalog?: unknown; attachments?: unknown } = {}): Promise<Rig> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'step-adapter-'))
  const backend = new MemoryBackend<StepCodeCredentials>()
  await backend.save(credentials())

  let body = ''
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/v1/models')) return Response.json(options.catalog ?? CATALOG)
    body = typeof init?.body === 'string' ? init.body : ''
    return sseResponse(ANSWER_SSE)
  }) as unknown as typeof fetch

  // 实时目录：灌进进程内缓存（登录/adopt，或应答背后那次自动刷新，都是这个效果）。
  await loadStepModelCatalog(
    { apiKey: 'sk-test', profile: 'platform_cn', uid: 'u-1' },
    { fetchFn },
  )

  const settingsStore = new StepCodeModelSettingsStore(path.join(dir, 'models.json'))
  const adapter = new StepCodeAdapter(
    new StepCodeCredentialStore(path.join(dir, 'credentials.json'), backend as never),
    settingsStore,
    undefined,
    { fetchFn, attachments: options.attachments as never },
  )
  return { adapter, settingsStore, body: () => body }
}

async function run(adapter: StepCodeAdapter, messages: unknown[], extra: Record<string, unknown> = {}): Promise<void> {
  const prepared = await adapter.prepareCall('step-code', 'step-3')
  for await (const chunk of prepared.stream({
    provider: 'step-code',
    model: 'step-3',
    messages,
    ...extra,
  } as never)) void chunk
}

describe('StepCodeAdapter：图片预算按真正上线的字节算', () => {
  beforeEach(() => {
    clearCachedStepModelCatalog()
  })

  it('★ 缩放后装得下的图**不丢**：预算是按请求版本量的，不是按存储字节量的', async () => {
    const { adapter, body } = await rig({ attachments: attachmentsStore() })

    await run(adapter, [{
      role: 'user',
      content: [
        { type: 'text', text: '看看这张图' },
        { type: 'image', attachment: HUGE_STORED_IMAGE },
      ],
    }])

    const sent = JSON.parse(body()) as { messages: Array<{ content: unknown }> }
    const serialized = JSON.stringify(sent.messages)
    // 图还在：它被缩放后只有几十字节，装得下预算。
    expect(serialized).toContain('image_url')
    expect(serialized).toContain('data:image/png;base64,')
    // 旧实现会在这里把图换成占位文本（按 20 MB 的存储字节量预算）。
    expect(serialized).not.toContain('image omitted to keep the request within its size limit')
  })

  it('★ 真超预算时**最旧的先让位**（附件图也受预算约束）', async () => {
    const { adapter, body } = await rig({
      attachments: attachmentsStore({
        'img-old': OLD_BIG_VERSION,
        'img-new': NEW_SMALL_VERSION,
      }),
    })

    await run(adapter, [{
      role: 'user',
      content: [
        { type: 'text', text: '两张图' },
        { type: 'image', attachment: OLD_BIG_IMAGE },
        { type: 'image', attachment: NEW_SMALL_IMAGE },
      ],
    }])

    const sent = body()
    // 新图留着（它很小）。
    expect(sent).toContain(NEW_SMALL_VERSION.toString('base64'))
    // 旧图让位：超预算时先丢最旧的（base64 以 'QUFB' 开头）。
    expect(sent).not.toContain('QUFB')
    expect(sent).toContain('image omitted to keep the request within its size limit')
  })

  it('图片在工具结果里也一样按请求版本算', async () => {
    const { adapter, body } = await rig({ attachments: attachmentsStore() })

    await run(adapter, [{
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: 'call-1',
        content: [{ type: 'image', attachment: HUGE_STORED_IMAGE }],
      }],
      source: { kind: 'tool', callId: 'call-1' },
    }])

    expect(body()).toContain('image_url')
    expect(body()).not.toContain('image omitted to keep the request within its size limit')
  })
})

describe('StepCodeAdapter：wire 上的输出上限', () => {
  beforeEach(() => {
    clearCachedStepModelCatalog()
  })

  it('★ 目录没有真实 cap 时请求体**不带** max_tokens（窗口不是上限）', async () => {
    const { adapter, body } = await rig()

    await run(adapter, [{ role: 'user', content: [{ type: 'text', text: '你好' }] }])

    const sent = JSON.parse(body()) as Record<string, unknown>
    expect(sent).not.toHaveProperty('max_tokens')
    expect(sent).not.toHaveProperty('max_completion_tokens')
  })

  it('目录报了真实 cap 时发那个 cap', async () => {
    const { adapter, body } = await rig({ catalog: CATALOG_WITH_CAP })

    await run(adapter, [{ role: 'user', content: [{ type: 'text', text: '你好' }] }])

    const sent = JSON.parse(body()) as Record<string, unknown>
    expect(sent.max_tokens).toBe(8192)
  })

  it('★ host 侧的输出预留只认真实 cap：窗口派生值**不**发布成 defaultMaxTokens', async () => {
    const { adapter, settingsStore } = await rig()
    // 用户把窗口覆盖成 1M：窗口变了，但输出上限**仍然**没有声明。
    await settingsStore.write({
      ...(await settingsStore.read()),
      contextWindowOverrides: { 'step-3': 1_000_000 },
    })

    const resolved = await adapter.resolveModel('step-code', 'step-3')

    // 窗口照旧发布（那是容量）。
    expect(resolved.context?.contextWindow).toBe(1_000_000)
    // 但输出上限**不**发布：这份元数据会一路走到 wire（宿主在调用方没指定时
    // 用它填请求的 maxTokens），窗口派生值放进来就是每个请求都带着一个编出来的上限。
    expect(resolved.defaultMaxTokens).toBeUndefined()
  })

  it('目录报了真实 cap 时，host 侧发布的输出预留就是那个 cap', async () => {
    const { adapter } = await rig({ catalog: CATALOG_WITH_CAP })

    const resolved = await adapter.resolveModel('step-code', 'step-3')

    expect(resolved.defaultMaxTokens).toBe(8192)
  })

  it('调用方显式要的上限照样发', async () => {
    const { adapter, body } = await rig()

    await run(
      adapter,
      [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
      { maxTokens: 4096 },
    )

    const sent = JSON.parse(body()) as Record<string, unknown>
    expect(sent.max_tokens).toBe(4096)
  })
})
