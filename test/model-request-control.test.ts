import { describe, it, expect, vi } from 'vitest'
import { CONTROLLED_PROVIDERS, createControlledModelFetch, isModelRequest, readModelRequestLimits } from '../src/host/common/model-request-control.ts'
const request = (token = 'mock-secret') => ({ method: 'POST', headers: { authorization: 'Bearer ' + token } })
const url = 'https://example.test/v1/messages'
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }

describe('model request concurrency', () => {
  it('keeps FIFO occupancy through a queued grant cancelled before resuming', async () => {
    const base = vi.fn(async () => new Response('ok'))
    const wrapped = createControlledModelFetch(base, { provider: 'claude', limits: { default: 1 } })
    const first = await wrapped(url, request())
    const cancelled = new AbortController()
    const second = wrapped(url, { ...request(), signal: cancelled.signal })
    const rejected = expect(second).rejects.toThrow('queued cancel')
    const third = wrapped(url, request())
    cancelled.abort(new Error('queued cancel'))
    await rejected
    await first.text()
    expect(await (await third).text()).toBe('ok')
    expect(base).toHaveBeenCalledTimes(2)
  })
  it('bypasses model slots for credential renewal and preserves response metadata', async () => {
    const base = vi.fn(async () => { const r = new Response('ok'); Object.defineProperty(r, 'url', { value: url }); return r })
    const wrapped = createControlledModelFetch(base, { provider: 'claude', limits: { default: 1 } })
    const first = await wrapped(url, request())
    expect(first.url).toBe(url)
    const auth = await wrapped('https://example.test/oauth/token', request())
    expect(await auth.text()).toBe('ok')
    await first.body!.cancel()
    expect(base).toHaveBeenCalledTimes(2)
  })

  it('parses explicit limits and rejects malformed configuration', () => {
    expect(readModelRequestLimits({})).toEqual({})
    expect(readModelRequestLimits({ DSH_PROVIDER_CONCURRENCY: '{"default":2,"ollama":1,"queueTimeoutMs":10}' })).toEqual({ default: 2, providers: { ollama: 1 }, queueTimeoutMs: 10 })
    for (const value of ['bad', '[]', '{"unknown":1}', '{"claude":0.5}', '{"default":-1}']) expect(() => readModelRequestLimits({ DSH_PROVIDER_CONCURRENCY: value })).toThrow()
  })
  it('matches only model endpoints', () => {
    for (const path of ['/v1/messages','/provider/v1/responses','/coding/v1/chat/completions','/api/chat','/v1internal:streamGenerateContent']) expect(isModelRequest('https://example.test'+path, request())).toBe(true)
    expect(isModelRequest(url)).toBe(false)
    for (const path of ['/oauth/token','/v1/models','/alpha/whoami']) expect(isModelRequest('https://example.test'+path, request())).toBe(false)
  })
  it.each(CONTROLLED_PROVIDERS)('holds %s slot through body lifetime, isolates credentials', async provider => {
    const called = vi.fn(async () => new Response('body'))
    const wrapped = createControlledModelFetch(called, { provider, limits: { default: 1 } })
    const first = await wrapped(url, request())
    const pending = wrapped(url, request())
    await Promise.resolve(); expect(called).toHaveBeenCalledTimes(1)
    const other = await wrapped(url, request('other'))
    expect(called).toHaveBeenCalledTimes(2)
    await other.text(); await first.text()
    const second = await pending; await second.text()
    expect(called).toHaveBeenCalledTimes(3)
  })
  it('cancels queued work without issuing a network request', async () => {
    const base = vi.fn(async () => new Response('body'))
    const wrapped = createControlledModelFetch(base, { provider: 'claude', limits: { default: 1 } })
    const first = await wrapped(url, request())
    const controller = new AbortController()
    const pending = wrapped(url, { ...request(), signal: controller.signal })
    const rejected = expect(pending).rejects.toThrow('cancelled')
    controller.abort(new Error('cancelled')); await rejected
    await first.body!.cancel(); expect(base).toHaveBeenCalledTimes(1)
    const next = await wrapped(url, request()); await next.text()
  })
  it('times out waiting without aborting the current holder', async () => {
    vi.useFakeTimers()
    try {
      const base = vi.fn(async () => new Response('body'))
      const wrapped = createControlledModelFetch(base, { provider: 'claude', limits: { default: 1, queueTimeoutMs: 10 } })
      const first = await wrapped(url, request())
      const pending = expect(wrapped(url, request())).rejects.toThrow('queue timed out')
      await vi.advanceTimersByTimeAsync(11); await pending
      expect(await first.text()).toBe('body'); expect(base).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })
  it('releases on fetch errors and errors while reading', async () => {
    let count = 0
    const wrapped = createControlledModelFetch(async () => {
      if (++count === 1) throw new Error('fetch error')
      if (count === 2) return new Response(new ReadableStream({ start(c) { c.error(new Error('read error')) } }))
      return new Response('ok')
    }, { provider: 'claude', limits: { default: 1 } })
    await expect(wrapped(url, request())).rejects.toThrow('fetch error')
    await expect((await wrapped(url, request())).text()).rejects.toThrow('read error')
    expect(await (await wrapped(url, request())).text()).toBe('ok')
  })
  it('releases on abort even when the consumer is not reading', async () => {
    const base = vi.fn(async () => new Response(new ReadableStream()))
    const wrapped = createControlledModelFetch(base, { provider: 'ollama', limits: { default: 1 } })
    const controller = new AbortController()
    const first = await wrapped(url, { ...request(), signal: controller.signal })
    const next = wrapped(url, request())
    controller.abort(new Error('stop'))
    await expect(first.text()).rejects.toThrow('stop')
    await (await next).body!.cancel()
    expect(base).toHaveBeenCalledTimes(2)
  })
  it('does not prefetch response bytes or affect disabled/auth requests', async () => {
    const pull = vi.fn(c => { c.enqueue(new Uint8Array([1])); c.close() })
    const base = vi.fn(async () => new Response(new ReadableStream({ pull }, { highWaterMark: 0 })))
    expect(createControlledModelFetch(base, { provider: 'claude', limits: {} })).toBe(base)
    const wrapped = createControlledModelFetch(base, { provider: 'claude', limits: { default: 1 } })
    const first = await wrapped(url, request()); expect(pull).not.toHaveBeenCalled()
    await first.arrayBuffer(); expect(pull).toHaveBeenCalledTimes(1)
  })
})
