/**
 * The client half of the language seam: the browser's resolved locale is the
 * only place the Host can learn which language the page is in, so what this
 * module posts — and when it stops posting — is what the Host's own copy is
 * built on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ROUTE_PREFIX } from '../src/compat.ts'
import { installHostLocaleMirror } from '../src/client/common/host-locale-mirror.ts'

/** The slice of the locale runtime the mirror actually uses. */
function fakeLocale(active: string): {
  getSnapshot(): { active: string; revision: number }
  subscribe(listener: () => void): () => void
  switch(next: string): void
} {
  const listeners = new Set<() => void>()
  let revision = 0
  return {
    getSnapshot: () => ({ active, revision }),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    switch: (next: string) => {
      active = next
      revision += 1
      for (const listener of [...listeners]) listener()
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('installHostLocaleMirror', () => {
  it('posts the resolved locale once on install', async () => {
    const fetchStub = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchStub)
    installHostLocaleMirror(fakeLocale('ru-RU') as never)
    expect(fetchStub).toHaveBeenCalledTimes(1)
    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${ROUTE_PREFIX}/i18n/locale`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ locale: 'ru' })
  })

  it('posts again after a switch, coalesced into one request', async () => {
    vi.useFakeTimers()
    const fetchStub = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchStub)
    const locale = fakeLocale('zh')
    installHostLocaleMirror(locale as never)
    expect(fetchStub).toHaveBeenCalledTimes(1)
    locale.switch('en')
    locale.switch('ru')
    vi.advanceTimersByTime(250)
    expect(fetchStub).toHaveBeenCalledTimes(2)
    const last = fetchStub.mock.calls.at(-1) as unknown as [string, RequestInit]
    expect(JSON.parse(String(last[1].body))).toEqual({ locale: 'ru' })
  })

  it('says nothing beyond the first post while the language does not change', async () => {
    vi.useFakeTimers()
    const fetchStub = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchStub)
    const locale = fakeLocale('zh')
    installHostLocaleMirror(locale as never)
    locale.switch('zh-CN')
    vi.advanceTimersByTime(250)
    expect(fetchStub).toHaveBeenCalledTimes(1)
  })

  it('tries again after a failed post rather than believing the Host knows', async () => {
    const fetchStub = vi.fn(async () => { throw new Error('offline') })
    vi.stubGlobal('fetch', fetchStub)
    installHostLocaleMirror(fakeLocale('ru') as never)
    await Promise.resolve()
    await Promise.resolve()
    // A later page load or switch re-posts the same language because the failure
    // cleared the "already sent" marker.
    installHostLocaleMirror(fakeLocale('ru') as never)
    expect(fetchStub).toHaveBeenCalledTimes(2)
  })

  it('does nothing visible without a locale runtime', () => {
    const fetchStub = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchStub)
    const dispose = installHostLocaleMirror(undefined)
    expect(() => dispose()).not.toThrow()
    expect(fetchStub).not.toHaveBeenCalled()
  })
})
