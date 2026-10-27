// @vitest-environment jsdom
/**
 * 「宿主那一行装没装」的判定表。
 *
 * 组件的浏览器半边按**包**加载，所以关掉「进展更新」那一行之后它照样会跑；面板与
 * 设置分区必须自己发现宿主不在并撤掉。判定只能靠 HTTP，而这里踩过一次真实的坑：
 * 把自己路由的 404 与网关兜底的 404 当成同一件事，结果装着它的实例把自己的 UI
 * 撤了（网关回的是纯文本 `not found`）。这张表把「哪种 404 才算没装」钉死。
 */
import { describe, expect, it, vi } from 'vitest'
import { isProgressUpdatesHostPresent } from '../src/client/progress-updates/host-source.ts'

interface FakeResponse {
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
}

/** 一张够用的假响应：只看状态码、content-type 与正文。 */
function fakeResponse(status: number, contentType: string, body: unknown): FakeResponse {
  return { status, headers: { get: () => contentType }, json: async () => body }
}

describe('isProgressUpdatesHostPresent', () => {
  const cases: Array<[string, FakeResponse, boolean]> = [
    // 路由自己说「这一行没装」：JSON 404，正文是错误块。
    ['JSON 404 视为没装', fakeResponse(404, 'application/json', { ok: false, error: 'not found' }), false],
    ['JSON 405 视为没装', fakeResponse(405, 'application/json', { ok: false }), false],
    // 网关的兜底：同样是 404，但回的是纯文本，不能据此撤 UI。
    ['纯文本 404 不算没装', fakeResponse(404, 'text/plain', 'not found'), true],
    ['200 装着', fakeResponse(200, 'application/json', { updates: [] }), true],
    ['403 装着但拒绝非 loopback', fakeResponse(403, 'application/json', { ok: false }), true],
    // 有 JSON 头却读不出错误块：无法判断，按装着处理。
    ['JSON 404 但正文不是错误块', fakeResponse(404, 'application/json', { updates: [] }), true],
  ]

  for (const [name, response, expected] of cases) {
    it(name, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => response))
      await expect(isProgressUpdatesHostPresent()).resolves.toBe(expected)
    })
  }

  it('网络错误按装着处理', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await expect(isProgressUpdatesHostPresent()).resolves.toBe(true)
  })
})
