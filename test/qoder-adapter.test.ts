/**
 * Qoder 适配器的端到端测试（mock fetch）：
 * 一次请求从 GenerateOptions 走到 COSY 签名 + 编码 body 的 POST，
 * 再把信封 SSE 拆回 DSH chunks。
 *
 * 这是把 cosy.ts 与 mapper.ts 缝在一起的那一层测试：请求侧的签名形状与
 * 响应侧的信封解析在同一拍里被看见。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { QoderAdapter } from '../src/host/qoder/adapter.ts'
import { QoderAccountPool } from '../src/host/qoder/account-pool.ts'
import { clearCachedQoderModelCatalog, loadQoderModelCatalog } from '../src/host/qoder/client.ts'
import { bundledQoderCatalog } from '../src/host/qoder/model-catalog.ts'
import { QoderCredentialStore, QoderModelSettingsStore, type QoderCredentials } from '../src/host/qoder/token-store.ts'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

class MemoryBackend<T> {
  private data: unknown = null
  async load(): Promise<T | null> { return this.data === null ? null : JSON.parse(JSON.stringify(this.data)) as T }
  async save(data: T): Promise<void> { this.data = JSON.parse(JSON.stringify(data)) }
  async clear(): Promise<void> { this.data = null }
}

function credentials(): QoderCredentials {
  return {
    accessToken: 'jt-test',
    refreshToken: 'jrt-test',
    expiresAt: Date.now() + 24 * 3_600_000,
    region: 'global',
    origin: 'device',
    uid: 'u-1',
    email: 'me@qoder.com',
    accountName: 'Me',
    personalToken: null,
    organizationId: null,
    organizationTags: [],
    dataPolicyAgreed: false,
    authenticatedAt: Date.now(),
  }
}

/** 信封 SSE 的一帧。 */
function frame(inner: unknown): string {
  return 'data:' + JSON.stringify({
    headers: { 'Content-Type': ['application/json'] },
    body: JSON.stringify(inner),
    statusCodeValue: 200,
    statusCode: 'OK',
  }) + '\n'
}

/** 一次完整的回答：两段文本 + 一帧 usage + [DONE]。 */
const ANSWER_SSE =
  frame({ id: 'rsp-1', model: 'lite', choices: [{ delta: { content: '你好' } }] })
  + frame({ id: 'rsp-1', choices: [{ delta: { content: '，世界' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })
  + 'data:[DONE]\n'

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('QoderAdapter 端到端（mock fetch）', () => {
  it('请求：COSY 头 + 编码 body；响应：信封 SSE 拆回 text 与 usage', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'qoder-adapter-'))
    const pool = new QoderAccountPool({ backend: new MemoryBackend() as never })
    await pool.addAccount(credentials())
    const adapter = new QoderAdapter(
      new QoderCredentialStore(path.join(dir, 'credentials.json'), new MemoryBackend() as never),
      new QoderModelSettingsStore(path.join(dir, 'models.json')),
      undefined,
      { accountPool: pool },
    )

    let seenUrl = ''
    let seenHeaders: Record<string, string> = {}
    let seenBody = ''
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input)
      seenHeaders = Object.fromEntries(new Headers(init?.headers).entries())
      seenBody = typeof init?.body === 'string' ? init.body : ''
      return sseResponse(ANSWER_SSE)
    }) as unknown as typeof fetch
    const withFetch = new QoderAdapter(
      new QoderCredentialStore(path.join(dir, 'credentials2.json'), new MemoryBackend() as never),
      new QoderModelSettingsStore(path.join(dir, 'models2.json')),
      undefined,
      { accountPool: pool, fetchFn },
    )
    void adapter

    const prepared = await withFetch.prepareCall('qoder', 'Lite')
    const chunks: Array<Record<string, unknown>> = []
    for await (const chunk of prepared.stream({
      provider: 'qoder',
      model: 'Lite',
      messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
    } as never)) {
      chunks.push(chunk as Record<string, unknown>)
    }

    // 请求侧：URL 是对话端点，头是 COSY 形状，body 是编码后的 ASCII。
    expect(seenUrl).toBe('https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1')
    expect(seenHeaders['authorization']).toMatch(/^Bearer COSY\.[A-Za-z0-9+/=]+\.[0-9a-f]{32}$/)
    expect(seenHeaders['cosy-user']).toBe('u-1')
    expect(seenHeaders['x-model-key']).toBe('lite')
    expect(seenHeaders['accept']).toBe('text/event-stream')
    // 编码 body 不含标准 base64 的 '+' '/'（被自定义 alphabet 换掉）。
    expect(seenBody.length).toBeGreaterThan(0)
    expect(seenBody).not.toMatch(/[+/=]/)

    // 响应侧：文本增量与 usage 都在，finish 收尾。
    const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
    expect(text).toBe('你好，世界')
    const usage = chunks.find((chunk) => chunk.type === 'usage') as { usage: { inputTokens: number; outputTokens: number } }
    expect(usage.usage).toMatchObject({ inputTokens: 10, outputTokens: 2 })
    expect(chunks[chunks.length - 1]!.type).toBe('finish')
  })

  it('没登录时给 MISSING_CREDENTIAL，而不是发一个必然 401 的请求', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'qoder-adapter-empty-'))
    const adapter = new QoderAdapter(
      new QoderCredentialStore(path.join(dir, 'credentials.json'), new MemoryBackend() as never),
      new QoderModelSettingsStore(path.join(dir, 'models.json')),
      undefined,
      { fetchFn: (async () => { throw new Error('must not be called') }) as unknown as typeof fetch },
    )
    const prepared = await adapter.prepareCall('qoder', 'Lite')
    await expect((async () => {
      for await (const chunk of prepared.stream({
        provider: 'qoder',
        model: 'Lite',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)) void chunk
    })()).rejects.toThrow(/还没有登录/)
  })

  it('listModels：总开关关掉后一个模型都不暴露；兜底目录让选择器不为空', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'qoder-adapter-list-'))
    const pool = new QoderAccountPool({ backend: new MemoryBackend() as never })
    await pool.addAccount(credentials())
    const settingsStore = new QoderModelSettingsStore(path.join(dir, 'models.json'))
    const adapter = new QoderAdapter(
      new QoderCredentialStore(path.join(dir, 'credentials.json'), new MemoryBackend() as never),
      settingsStore,
      undefined,
      { accountPool: pool, fetchFn: (async () => new Response('{}')) as unknown as typeof fetch },
    )
    // 随包兜底表：全球区目录。
    const listed = await adapter.listModels('qoder')
    expect(listed.length).toBeGreaterThan(0)
    expect(listed.some((model) => model.id === 'Lite')).toBe(true)

    await settingsStore.updateSettings({ enabled: false })
    expect(await adapter.listModels('qoder')).toEqual([])
  })

  it('listModels：三态 —— null 全部可用、[] 一个都不给、非空白名单', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'qoder-adapter-tri-'))
    const pool = new QoderAccountPool({ backend: new MemoryBackend() as never })
    await pool.addAccount(credentials())
    const settingsStore = new QoderModelSettingsStore(path.join(dir, 'models.json'))
    const adapter = new QoderAdapter(
      new QoderCredentialStore(path.join(dir, 'credentials.json'), new MemoryBackend() as never),
      settingsStore,
      undefined,
      { accountPool: pool, fetchFn: (async () => new Response('{}')) as unknown as typeof fetch },
    )

    // 出厂：null = 不过滤，兜底目录里的每一行都在。
    expect((await settingsStore.read()).enabledModelIds).toBeNull()
    const all = await adapter.listModels('qoder')
    expect(all.length).toBeGreaterThan(0)

    // [] = 用户明确全关：一个模型都不暴露（这正是旧语义下点不出来的状态）。
    await settingsStore.updateSettings({ enabledModelIds: [] })
    expect(await adapter.listModels('qoder')).toEqual([])

    // 白名单在**兜底表阶段**不负责过滤：这里没有实时目录，白名单是另一套词汇，
    // 拿它筛兜底表只会把这一行整个筛没（见下面「白名单只在实时目录上收敛」那一组，
    // 那里钉的是实时目录存在时照旧收敛过滤）。
    await settingsStore.updateSettings({ enabledModelIds: ['Lite', 'gone-from-upstream'] })
    expect((await adapter.listModels('qoder')).length).toBe(all.length)

    // 回到 null：又变成全部可用。
    await settingsStore.updateSettings({ enabledModelIds: null })
    expect((await adapter.listModels('qoder')).length).toBe(all.length)
  })

  it('上游排队（HTTP 200 + 错误信封）不再被说成「API 密钥无效」，账号也不被判成要重新登录', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'qoder-adapter-queue-'))
    const pool = new QoderAccountPool({ backend: new MemoryBackend() as never })
    await pool.addAccount(credentials())
    // 上游把排队信息装在 **HTTP 200 的 SSE 错误信封** 里（statusCodeValue: 403）。
    const fetchFn = (async () => new Response(
      'data:' + JSON.stringify({
        headers: { 'Content-Type': ['application/json'] },
        body: JSON.stringify({
          code: 10605,
          subCode: 'RESOURCE_LIMIT',
          modelKey: 'dfmodel',
          queueCount: 3239,
          retryAfterSeconds: 30,
          serviceAvailable: false,
        }),
        statusCodeValue: 403,
        statusCode: 'FORBIDDEN',
      }) + '\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )) as unknown as typeof fetch
    const adapter = new QoderAdapter(
      new QoderCredentialStore(path.join(dir, 'credentials.json'), new MemoryBackend() as never),
      new QoderModelSettingsStore(path.join(dir, 'models.json')),
      undefined,
      { accountPool: pool, fetchFn },
    )

    const prepared = await adapter.prepareCall('qoder', 'Lite')
    let caught: { code?: string; message?: string } | undefined
    try {
      for await (const chunk of prepared.stream({
        provider: 'qoder',
        model: 'Lite',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)) void chunk
    } catch (error) {
      caught = error as { code?: string; message?: string }
    }
    // 排队说的是上游容量：归 SERVER，不归 AUTH（DSH 只在 AUTH 时显示「API 密钥无效」）。
    expect(caught?.code).toBe('SERVER')
    expect(caught?.message).toContain('排队')
    // 凭据是好的：账号没有被判成「要重新登录」。
    const accounts = await pool.listAccounts()
    expect(accounts.every((account) => account.authStatus !== 'expired')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 冷启动回归：兜底表阶段不按白名单收敛
// ---------------------------------------------------------------------------

/**
 * 一个里外都自洽的适配器 + 设置存储：凭据在号池里，目录缓存由用例自己决定。
 *
 * `fetchFn` 只答「模型目录」这一个端点，别的 URL 一律 404（COSY 版本跟随走的是
 * GitHub releases，那条路径是尽力而为的，404 会被安静吞掉）。
 */
async function listModelsRig(options: { modelIds?: string[] } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qoder-adapter-live-'))
  const modelIds = options.modelIds ?? ['Lite', 'DeepSeek-Flash']
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/model/list')) {
      return Response.json({
        chat: modelIds.map((id) => ({ key: id.toLowerCase(), display_name: id, enable: true })),
      })
    }
    return new Response('', { status: 404 })
  }) as unknown as typeof fetch
  const pool = new QoderAccountPool({ backend: new MemoryBackend() as never })
  const settingsStore = new QoderModelSettingsStore(path.join(dir, 'models.json'))
  const adapter = new QoderAdapter(
    new QoderCredentialStore(path.join(dir, 'credentials.json'), new MemoryBackend() as never),
    settingsStore,
    undefined,
    { accountPool: pool, fetchFn },
  )
  // 有账号才拿得到凭据，`listModels` 才走得进目录那一段（没有凭据时它按契约返回空表）。
  await pool.addAccount(credentials())
  return { adapter, settingsStore, pool, fetchFn, modelIds }
}

describe('QoderAdapter.listModels：白名单只在实时目录上收敛', () => {
  // 目录缓存是进程级的：每条用例都必须从「冷启动（只有随包兜底表）」开始，
  // 否则上一条留下的实时目录会让「兜底阶段」根本走不到。
  beforeEach(() => {
    clearCachedQoderModelCatalog()
  })

  /**
   * 冷启动回归（这一条是本轮修的缺陷本身）。
   *
   * 白名单里的 `DeepSeek-Flash` 来自**实时目录**的词汇表（上游 display_name 去空白），
   * 而随包兜底表把同一批模型叫 `DeepSeek-V4-Flash`。旧实现在冷启动时拿白名单去收敛
   * 兜底表，两边 id 对不上 → 收敛成 `[]` → listModels 返回 0 个模型 → DSH 把整个
   * provider 分组过滤掉，模型选择器里连 Qoder 都不剩。
   *
   * 兜底表是能力占位，不是这个账号真实可用的集合，不该被一份只对某一版目录有意义的
   * 白名单筛掉：占位期间全部返回，实时目录一到再收敛成真实集合。
   */
  it('冷启动回归：无实时目录 + 白名单是实时目录词汇 → 返回兜底表全部模型，不为空', async () => {
    const { adapter, settingsStore } = await listModelsRig()
    await settingsStore.updateSettings({ enabledModelIds: ['DeepSeek-Flash'] })

    const listed = await adapter.listModels('qoder')
    // 变红的那条断言就是这一行：旧实现这里是 0。
    expect(listed.length).toBeGreaterThan(0)
    expect(listed.length).toBe(bundledQoderCatalog('global').length)
    expect(listed.map((model) => model.id)).toEqual(bundledQoderCatalog('global').map((entry) => entry.id))
    // 兜底表里那一行真的在（白名单里的另一个词汇不会把它顶掉）。
    expect(listed.some((model) => model.id === 'DeepSeek-V4-Flash')).toBe(true)
  })

  it('[] 在兜底表阶段同样生效：用户明确全关，一个都不返回', async () => {
    const { adapter, settingsStore } = await listModelsRig()
    await settingsStore.updateSettings({ enabledModelIds: [] })

    expect(await adapter.listModels('qoder')).toEqual([])
  })

  it('实时目录存在时照旧收敛过滤：白名单里目录没有的 id 被丢掉', async () => {
    const { adapter, settingsStore, fetchFn, modelIds } = await listModelsRig()
    await settingsStore.updateSettings({ enabledModelIds: ['Lite', 'gone-from-upstream'] })

    // 把实时目录灌进进程内缓存（登录/adopt，或应答背后那次自动刷新，都是这个效果）。
    // 兜底表里根本没有 'DeepSeek-Flash' 这个名字，所以下面那条断言顺带证明了
    // 「这时的目录确实来自上游」——它只能是实时目录。
    await loadQoderModelCatalog(
      { accessToken: 'jt-test', region: 'global', uid: 'u-1', email: null, accountName: null },
      { fetchFn },
    )

    // 实时目录就是 [Lite, DeepSeek-Flash]：上线后残留的 id 被收敛掉，只剩真实存在的那一个。
    expect((await adapter.listModels('qoder')).map((model) => model.id)).toEqual(['Lite'])
    expect(modelIds).toContain('DeepSeek-Flash')
    expect(bundledQoderCatalog('global').some((entry) => entry.id === 'DeepSeek-Flash')).toBe(false)
  })

  it('冷启动的 null（不过滤）与实时目录的 null 走同一条路：都是全部可用', async () => {
    const { adapter, settingsStore } = await listModelsRig()
    // 出厂值就是 null。
    expect((await settingsStore.read()).enabledModelIds).toBeNull()
    expect((await adapter.listModels('qoder')).length).toBe(bundledQoderCatalog('global').length)
  })
})
