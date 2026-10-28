import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/**
 * `cache_warmup_result` 的补读面：分页、释放、越权拒绝，以及"错误是值不是异常"。
 *
 * 存储在这里是完全可控的替身（`store.page` / `store.release` 都是 spy），所以每条
 * 断言都能分清"工具做了什么"和"存储做了什么"——越权那几条尤其重要：拒绝必须发生
 * 在碰存储**之前**，否则一条被拒绝的调用仍然会在别人的引用上留下痕迹。
 */

import { createCacheWarmupResultTool, type CacheWarmupResultValue } from '../src/host/cache-warmup/result-tool.ts'

/** 本文件固定服务的线路。 */
const PROVIDER = 'kimi-code'

/** 一次 page 调用收到的请求（spy 捕获）。 */
let pageRequests: Array<Record<string, unknown>>

/** 一次 release 调用收到的请求。 */
let releaseRequests: Array<Record<string, unknown>>

/** 当前线路；用例可以按需改写。 */
let route: { provider?: string, sessionId?: string }

/** 当前存储：`undefined` 模拟这台主机上没有引用存储。 */
let store: { page: (request: Record<string, unknown>) => Promise<unknown>, release: (request: Record<string, unknown>) => Promise<unknown> } | undefined

/** 工具产出的指标日志事件。 */
let logged: Array<Record<string, unknown>>

/** 造一次调用。 */
function makeTool(): ToolDefinition {
  return createCacheWarmupResultTool({
    provider: PROVIDER,
    routeOf: () => route,
    store: () => store as never,
    log: event => { logged.push(event as unknown as Record<string, unknown>) },
  })
}

/**
 * 执行一次工具。
 * @param args - 模型给的参数。
 * @returns 规范值。
 */
async function run(args: Record<string, unknown>): Promise<CacheWarmupResultValue> {
  const tool = makeTool()
  return await tool.execute(args, { agent: undefined } as never) as CacheWarmupResultValue
}

/**
 * 渲染一次输出。
 * @param value - 规范值。
 * @returns 模型看到的正文。
 */
function render(value: CacheWarmupResultValue): string {
  const tool = makeTool()
  const blocks = tool.output.render({}, value as never) as ContentBlock[]
  return blocks.map(block => (block as { text?: string }).text ?? '').join('\n')
}

beforeEach(() => {
  pageRequests = []
  releaseRequests = []
  logged = []
  route = { provider: PROVIDER, sessionId: 'sess-1' }
  store = {
    page: (request) => {
      pageRequests.push(request)
      return Promise.resolve({ text: 'SLICE', complete: false, nextOffset: 12, omitted: 40 })
    },
    release: (request) => {
      releaseRequests.push(request)
      return Promise.resolve(true)
    },
  }
})

describe('cache_warmup_result page', () => {
  it('reads a page and reports completeness explicitly', async () => {
    const value = await run({ action: 'page', refId: 'ref://sess-1/abc' })
    expect(value.ok).toBe(true)
    expect(value.complete).toBe(false)
    expect(value.nextOffset).toBe(12)
    expect(value.omitted).toBe(40)
    expect(value.text).toBe('SLICE')
    expect(value.chars).toBe('SLICE'.length)
    // 会话来自当前线路，不是从 refId 里解析出来的。
    expect(pageRequests[0]?.sessionId).toBe('sess-1')
    expect(pageRequests[0]?.refId).toBe('ref://sess-1/abc')
    // 调用方没给的参数不出现在请求里（交给存储默认值）。
    expect(Object.keys(pageRequests[0] ?? {}).sort()).toEqual(['refId', 'sessionId'])
  })

  it('never fabricates completeness when the store omits it', async () => {
    store = { page: () => Promise.resolve({ text: 'X' }), release: () => Promise.resolve(true) }
    const value = await run({ action: 'page', refId: 'ref://sess-1/abc' })
    expect(value.complete).toBe(false)
    expect(value.nextOffset).toBeUndefined()
  })

  it('passes offset, limit, maxBytes, fields and equals through', async () => {
    await run({
      action: 'page',
      refId: 'ref://sess-1/abc',
      offset: 10,
      limit: 5,
      maxBytes: 64,
      fields: ['name', 'size'],
      equals: { kind: 'file' },
    })
    const request = pageRequests[0] ?? {}
    expect(request.offset).toBe(10)
    expect(request.limit).toBe(5)
    expect(request.maxBytes).toBe(64)
    expect(request.fields).toEqual(['name', 'size'])
    expect(request.equals).toEqual({ kind: 'file' })
  })

  it('refuses a non-integer offset instead of forwarding it', async () => {
    const value = await run({ action: 'page', refId: 'ref://sess-1/abc', offset: -3 })
    expect(value.ok).toBe(false)
    expect(value.error?.code).toBe('BAD_ARGUMENT')
    expect(pageRequests).toHaveLength(0)
  })

  it('logs the page metrics without the payload', async () => {
    await run({ action: 'page', refId: 'ref://sess-1/abc' })
    const event = logged.find(entry => entry.event === 'ref-page')
    expect(event).toBeDefined()
    expect(event?.returnedChars).toBe('SLICE'.length)
    expect(JSON.stringify(event)).not.toContain('SLICE')
  })
})

describe('cache_warmup_result release', () => {
  it('releases a stored copy', async () => {
    const value = await run({ action: 'release', refId: 'ref://sess-1/abc' })
    expect(value.ok).toBe(true)
    expect(value.released).toBe(true)
    expect(releaseRequests[0]).toEqual({ sessionId: 'sess-1', refId: 'ref://sess-1/abc' })
    expect(logged.some(entry => entry.event === 'ref-release')).toBe(true)
  })

  it('reads a structured release result', async () => {
    store = { page: () => Promise.resolve({}), release: () => Promise.resolve({ released: true }) }
    const value = await run({ action: 'release', refId: 'ref://sess-1/abc' })
    expect(value.released).toBe(true)
  })
})

describe('cache_warmup_result authorization', () => {
  it('refuses a handle from another line before touching the store', async () => {
    route = { provider: 'openai', sessionId: 'sess-1' }
    const value = await run({ action: 'page', refId: 'ref://sess-1/abc' })
    expect(value.ok).toBe(false)
    expect(value.error?.code).toBe('WRONG_PROVIDER')
    expect(pageRequests).toHaveLength(0)
  })

  it('refuses when the session cannot be resolved', async () => {
    route = { provider: PROVIDER }
    const value = await run({ action: 'page', refId: 'ref://sess-1/abc' })
    expect(value.ok).toBe(false)
    expect(value.error?.code).toBe('NO_SESSION')
    expect(pageRequests).toHaveLength(0)
    expect(releaseRequests).toHaveLength(0)
  })

  it('refuses to release across sessions too', async () => {
    route = { provider: PROVIDER }
    const value = await run({ action: 'release', refId: 'ref://sess-9/abc' })
    expect(value.ok).toBe(false)
    expect(value.error?.code).toBe('NO_SESSION')
    expect(releaseRequests).toHaveLength(0)
  })

  it('returns a structured error when no store is wired', async () => {
    store = undefined
    const value = await run({ action: 'page', refId: 'ref://sess-1/abc' })
    expect(value.ok).toBe(false)
    expect(value.error?.code).toBe('NO_STORE')
  })

  it('turns a throwing store into a structured error', async () => {
    store = {
      page: () => Promise.reject(new Error('disk on fire')),
      release: () => Promise.reject(new Error('disk on fire')),
    }
    const page = await run({ action: 'page', refId: 'ref://sess-1/abc' })
    expect(page.ok).toBe(false)
    expect(page.error?.code).toBe('STORE_FAILED')
    expect(page.error?.message).toContain('disk on fire')
    const release = await run({ action: 'release', refId: 'ref://sess-1/abc' })
    expect(release.error?.code).toBe('STORE_FAILED')
  })
})

describe('cache_warmup_result render', () => {
  it('renders a page with its continuation hint', async () => {
    const text = render(await run({ action: 'page', refId: 'ref://sess-1/abc' }))
    expect(text).toContain('ref://sess-1/abc')
    expect(text).toContain('SLICE')
    expect(text).toContain('continue at offset 12')
    expect(text).toContain('40 chars omitted')
  })

  it('renders a refusal with its code', async () => {
    route = { provider: 'openai', sessionId: 'sess-1' }
    const text = render(await run({ action: 'page', refId: 'ref://sess-1/abc' }))
    expect(text).toContain('WRONG_PROVIDER')
  })

  it('renders a release without pretending the history changed', async () => {
    const text = render(await run({ action: 'release', refId: 'ref://sess-1/abc' }))
    expect(text).toContain('Released ref://sess-1/abc')
    expect(text).toContain('unchanged')
  })
})
