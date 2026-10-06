// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { HubOverview, cardAnnotation } from '../src/client/hub/HubOverview.tsx'
import { HUB_PROVIDERS } from '../src/client/hub/providers.tsx'
import { zh } from '../src/client/locales.ts'
import type { HubOverviewDto, HubProviderSummaryDto } from '../src/shared/hub-contracts.ts'

const t = ((key: keyof typeof zh) => zh[key]) as never

function summary(id: string, overrides: Partial<HubProviderSummaryDto> = {}): HubProviderSummaryDto {
  return {
    id,
    providerId: `${id}-provider`,
    canToggle: id !== 'ollama',
    enabled: true,
    accountCount: 0,
    authenticated: false,
    enabledModelCount: null,
    totalModelCount: null,
    ...overrides,
  }
}

function overviewDto(): HubOverviewDto {
  return {
    providers: [
      summary('chatgpt', { accountCount: 2, authenticated: true, enabledModelCount: 2, totalModelCount: 11 }),
      summary('antigravity'),
      summary('command-code', { enabled: false, accountCount: 1 }),
      summary('kimi-code'),
      summary('workbuddy'),
      summary('minimax-code', { error: true }),
      summary('claude'),
      summary('ollama', { canToggle: false, accountCount: 3, authenticated: true }),
    ],
  }
}

describe('hub overview card annotation', () => {
  const descriptor = (id: string) => HUB_PROVIDERS.find((provider) => provider.id === id)!

  it('joins accounts and model counts, and leads with the disabled state', () => {
    expect(cardAnnotation(summary('chatgpt', { accountCount: 2, enabledModelCount: 2, totalModelCount: 11 }), descriptor('chatgpt'), t))
      .toBe('2 个账号 · 2/11 个模型可用')
    expect(cardAnnotation(summary('command-code', { enabled: false, accountCount: 1 }), descriptor('command-code'), t))
      .toBe('已停用 · 1 个账号')
    expect(cardAnnotation(summary('kimi-code'), descriptor('kimi-code'), t)).toBe(zh.hubNoAccounts)
    // A line whose summary failed to load says so, in place of guessed counts.
    expect(cardAnnotation(summary('minimax-code', { error: true }), descriptor('minimax-code'), t)).toBe(zh.hubStatusFailed)
    // Nothing loaded yet: a quiet placeholder, not a lie.
    expect(cardAnnotation(undefined, descriptor('chatgpt'), t)).toBe('…')
  })
})

describe('HubOverview', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    globalThis.fetch = originalFetch
  })

  function mockFetch(overview: HubOverviewDto | null = overviewDto()) {
    const calls: Array<{ url: string; body?: unknown }> = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) })
      if (url.includes('/hub/overview')) {
        if (overview === null) return Response.json({ ok: false, error: { code: 'internal', message: 'boom' } }, { status: 500 })
        return Response.json({ ok: true, value: overview })
      }
      // Every line's settings endpoint answers the toggle.
      return Response.json({ ok: true, value: {} })
    }) as typeof fetch
    return calls
  }

  async function render(onOpen = vi.fn()) {
    await act(async () => root.render(createElement(HubOverview, { t, onOpen } as never)))
    return onOpen
  }

  function cards(): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>('.dsh-hub-card')]
  }

  it('renders one card per provider with its annotation and brand tile', async () => {
    mockFetch()
    await render()
    expect(cards()).toHaveLength(8)
    expect(cards().map((card) => card.querySelector('.dsh-hub-card-name')?.textContent))
      .toEqual(['ChatGPT', 'Antigravity', 'Command Code', 'Kimi Code', 'WorkBuddy', 'MiniMax Code', 'Claude', 'Ollama'])
    expect(cards()[0]!.textContent).toContain('2 个账号')
    expect(cards()[0]!.textContent).toContain('2/11 个模型可用')
    // A disabled line's card is marked and leads with the state.
    expect(cards()[2]!.dataset.enabled).toBe('false')
    expect(cards()[2]!.textContent).toContain('已停用')
    // Ollama has no switch; every other card does.
    expect(cards()[7]!.querySelector('[role="switch"]')).toBeNull()
    expect(container.querySelectorAll('[role="switch"]')).toHaveLength(7)
    // Every card renders its brand tile.
    expect(container.querySelectorAll('.dsh-hub-brand-tile')).toHaveLength(8)
  })

  it('drills into the detail page from a card click', async () => {
    mockFetch()
    const onOpen = await render()
    await act(async () => cards()[3]!.click())
    expect(onOpen).toHaveBeenCalledWith('kimi-code')
  })

  it('flips the switch optimistically without drilling in', async () => {
    // Stateful mock: the overview re-fetch after the commit reflects the flip.
    let chatgptEnabled = true
    const calls: Array<{ url: string; body?: unknown }> = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) })
      if (url.includes('/hub/overview')) {
        const dto = overviewDto()
        dto.providers[0]!.enabled = chatgptEnabled
        return Response.json({ ok: true, value: dto })
      }
      if (url.includes('/preferences/update')) {
        chatgptEnabled = (JSON.parse(String(init?.body)) as { enabled: boolean }).enabled
      }
      return Response.json({ ok: true, value: {} })
    }) as typeof fetch
    const onOpen = await render()
    const toggle = cards()[0]!.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    await act(async () => toggle.click())
    // The switch committed to ChatGPT's own preferences endpoint…
    const commit = calls.find((call) => call.url === '/api/dsh-chatgpt-subscription/preferences/update')
    expect(commit?.body).toEqual({ enabled: false })
    // …and the click never reached the card behind it.
    expect(onOpen).not.toHaveBeenCalled()
    // The flipped state settled.
    expect(cards()[0]!.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false')
  })

  it('rolls the switch back and says so when the commit fails', async () => {
    const overview = overviewDto()
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/hub/overview')) return Response.json({ ok: true, value: overview })
      if (url.includes('/settings') || url.includes('/preferences')) {
        return Response.json({ ok: false, error: { code: 'internal', message: 'disk full' } }, { status: 500 })
      }
      return Response.json({ ok: true, value: {} })
    }) as typeof fetch
    await render()
    const toggle = cards()[0]!.querySelector<HTMLButtonElement>('[role="switch"]')!
    await act(async () => toggle.click())
    await act(async () => Promise.resolve())
    expect(cards()[0]!.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true')
    expect(cards()[0]!.querySelector('.dsh-hub-card-note')?.textContent).toContain('disk full')
  })

  it('offers a retry when the overview itself fails to load', async () => {
    const calls = mockFetch(null)
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('boom')
    const retry = container.querySelector<HTMLButtonElement>('[role="alert"] button')!
    expect(retry.textContent).toBe(zh.retry)
    // Recover on retry: swap the mock to a working overview before clicking.
    mockFetch()
    await act(async () => retry.click())
    expect(cards()).toHaveLength(8)
    expect(calls.some((call) => call.url.includes('/hub/overview'))).toBe(true)
  })
})
