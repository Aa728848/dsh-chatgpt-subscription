// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { CompactAfterTurnToggle, compactAfterTurnApi, type CompactAfterTurnApi } from '../../src/client/features/compact-after-turn/CompactAfterTurnToggle.tsx'
import { zh, type CompactAfterTurnLocaleKey } from '../../src/client/features/compact-after-turn/locales.ts'
import type { CompactAfterTurnPhase, CompactAfterTurnStateDto } from '../../src/shared/compact-after-turn.ts'

const t = (key: CompactAfterTurnLocaleKey, params: Record<string, string> = {}) =>
  zh[key].replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? '')

const state = (phase: CompactAfterTurnPhase, extra: Partial<CompactAfterTurnStateDto> = {}): CompactAfterTurnStateDto =>
  ({ sessionId: 's1', phase, available: true, last: null, ...extra })

describe('CompactAfterTurnToggle', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  async function mount(api: CompactAfterTurnApi, overrides: { locked?: boolean; reportFailure?: (message: string) => void } = {}) {
    await act(async () => root.render(createElement(CompactAfterTurnToggle, {
      sessionId: 's1', locked: false, reportFailure: overrides.reportFailure ?? (() => undefined), t, api, ...overrides,
    })))
    return container.querySelector<HTMLButtonElement>('button[role="switch"]')
  }

  /** Focus the ⓘ button, read the bubble it raises, and take it down again. */
  async function explanation(): Promise<string> {
    const info = container.querySelector<HTMLButtonElement>('.dshcat-info')!
    await act(async () => info.focus())
    const text = document.body.querySelector('.dshcat-tip')?.textContent ?? ''
    await act(async () => info.blur())
    return text
  }

  it('keeps the explanation behind the ⓘ button, the way the host rows do', async () => {
    vi.useFakeTimers()
    try {
      await mount({ read: vi.fn(async () => state('off')), write: vi.fn() })
      expect(container.querySelector('.dshcat-row')?.hasAttribute('title')).toBe(false)
      const info = container.querySelector<HTMLButtonElement>('.dshcat-info')!
      expect(info.getAttribute('aria-label')).toBe(zh.infoLabel)
      expect(document.body.querySelector('.dshcat-tip')).toBeNull()
      await act(async () => { info.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })) })
      await act(async () => { await vi.advanceTimersByTimeAsync(299) })
      expect(document.body.querySelector('.dshcat-tip')).toBeNull()
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      const tip = document.body.querySelector('.dshcat-tip')!
      expect(tip.textContent).toBe(zh.hint)
      expect(tip.getAttribute('role')).toBe('tooltip')
      expect(info.getAttribute('aria-describedby')).toBe(tip.id)
      await act(async () => { info.dispatchEvent(new PointerEvent('pointerout', { bubbles: true })) })
      expect(document.body.querySelector('.dshcat-tip')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders nothing until the Host answers, and nothing on a Host without the route', async () => {
    const api: CompactAfterTurnApi = { read: vi.fn(async () => { throw new Error('404') }), write: vi.fn() }
    expect(await mount(api)).toBeNull()
    expect(api.read).toHaveBeenCalledWith('s1')
  })

  it('arms the session and shows that it is pending', async () => {
    const api: CompactAfterTurnApi = { read: vi.fn(async () => state('off')), write: vi.fn(async () => state('armed')) }
    const button = (await mount(api))!
    expect(button.getAttribute('aria-checked')).toBe('false')
    expect(container.querySelector('.dshcat-label')?.textContent).toBe(zh.label)
    await act(async () => button.click())
    expect(api.write).toHaveBeenCalledWith('s1', true)
    expect(button.getAttribute('aria-checked')).toBe('true')
    expect(container.querySelector('.dshcat-state')?.textContent).toBe(zh.stateArmed)
    // Free to switch back off while nothing runs.
    vi.mocked(api.write).mockResolvedValueOnce(state('off'))
    await act(async () => button.click())
    expect(api.write).toHaveBeenLastCalledWith('s1', false)
    expect(button.getAttribute('aria-checked')).toBe('false')
  })

  it('locks the switch while the compaction runs', async () => {
    const api: CompactAfterTurnApi = { read: vi.fn(async () => state('compacting')), write: vi.fn() }
    const button = (await mount(api))!
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-checked')).toBe('true')
    expect(container.querySelector('.dshcat-state')?.textContent).toBe(zh.stateCompacting)
    await act(async () => button.click())
    expect(api.write).not.toHaveBeenCalled()
  })

  it('follows the Host turning the switch off by itself, and states the outcome', async () => {
    vi.useFakeTimers()
    try {
      const read = vi.fn(async () => state('armed'))
      const button = (await mount({ read, write: vi.fn() }))!
      expect(button.getAttribute('aria-checked')).toBe('true')
      read.mockResolvedValue(state('off', { last: { kind: 'compacted', at: 1 } }))
      await act(async () => { await vi.advanceTimersByTimeAsync(1_600) })
      expect(button.getAttribute('aria-checked')).toBe('false')
      expect(await explanation()).toContain(zh.lastCompacted)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a refused write through the menu', async () => {
    const reportFailure = vi.fn()
    const busy = Object.assign(new Error('running'), { code: 'busy' })
    const api: CompactAfterTurnApi = { read: vi.fn(async () => state('off')), write: vi.fn(async () => { throw busy }) }
    const button = (await mount(api, { reportFailure }))!
    await act(async () => button.click())
    expect(reportFailure).toHaveBeenCalledWith(zh.errorBusy)
    vi.mocked(api.write).mockRejectedValueOnce(new Error('HTTP 500'))
    await act(async () => button.click())
    expect(reportFailure).toHaveBeenLastCalledWith(zh.errorFailed.replace('{message}', 'HTTP 500'))
  })

  it('speaks the Host route: GET by session, same-origin POST, refusal codes kept', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST'
      ? new Response(JSON.stringify({ ok: false, error: { code: 'busy', message: 'running' } }), { status: 409 })
      : new Response(JSON.stringify({ ok: true, value: state('off') }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(compactAfterTurnApi.read('a b')).resolves.toEqual(state('off'))
      expect(fetchMock.mock.calls[0]![0]).toBe('/api/dsh-compact-after-turn/state?session=a%20b')
      await expect(compactAfterTurnApi.write('s1', true)).rejects.toMatchObject({ code: 'busy', message: 'running' })
      expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toEqual({ sessionId: 's1', armed: true })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('cannot be armed on a Host without a compaction engine', async () => {
    const api: CompactAfterTurnApi = { read: vi.fn(async () => state('off', { available: false })), write: vi.fn() }
    const button = (await mount(api))!
    expect(button.disabled).toBe(true)
    expect(await explanation()).toContain(zh.unavailable)
  })
})
