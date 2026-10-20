/**
 * Qoder 适配器的端到端测试（mock fetch）：
 * 一次请求从 GenerateOptions 走到 COSY 签名 + 编码 body 的 POST，
 * 再把信封 SSE 拆回 DSH chunks。
 *
 * 这是把 cosy.ts 与 mapper.ts 缝在一起的那一层测试：请求侧的签名形状与
 * 响应侧的信封解析在同一拍里被看见。
 */
import { describe, expect, it } from 'vitest'
import { QoderAdapter } from '../src/host/qoder/adapter.ts'
import { QoderAccountPool } from '../src/host/qoder/account-pool.ts'
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
})
