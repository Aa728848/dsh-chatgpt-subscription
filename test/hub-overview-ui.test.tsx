// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { HubOverview, cardAnnotation, HUB_PROVIDER_ORDER_STORAGE_KEY } from '../src/client/hub/HubOverview.tsx'
import { BrandTile } from '../src/client/hub/brand-icons.tsx'
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
      summary('command-code', { enabled: false, accountCount: 1 }),
      summary('kimi-code'),
      summary('minimax-code', { error: true }),
      summary('glm-coding-plan'),
      summary('claude'),
      summary('ollama', { canToggle: false, accountCount: 3, authenticated: true }),
      summary('step-code'),
      summary('cline-pass'),
      summary('qoder'),
      summary('opendesign'),
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

describe('the AWS Quick card mark', () => {
  it('uses the official application icon, never a monogram fallback', () => {
    const markup = renderToStaticMarkup(<BrandTile id="aws-quick" />)
    expect(markup).toContain('data:image/png;base64,')
    expect(markup).not.toContain('dsh-hub-brand-mono')
  })
})

describe('the Qoder card mark', () => {
  it('renders the official app icon instead of the old monogram', () => {
    const markup = renderToStaticMarkup(<BrandTile id="qoder" />)
    // The vendor's own 412×412 PNG, inlined as a data URI. The previous version
    // drew a letter Q because a 73 KB favicon "was too big to inline" — that
    // reading was of a URL that now serves the site's HTML, and the real icon is
    // 5 KB, so the fallback no longer has a reason to exist.
    expect(markup).toContain('data:image/png;base64,')
    expect(markup).toContain('dsh-hub-brand-image')
    expect(markup).not.toContain('dsh-hub-brand-mono')
    expect(markup).toContain('#F3F3F3')
  })
})

describe('the OpenDesign card mark', () => {
  it('renders the official logo-mark and no monogram', () => {
    const markup = renderToStaticMarkup(<BrandTile id="opendesign" />)
    // The vendor's own logo-mark, inlined as currentColor SVG geometry with its
    // provenance recorded beside the constant. A letter tile would read as an
    // unfinished placeholder next to the other vendors' artwork.
    expect(markup).toContain('<svg')
    expect(markup).toContain('M49.8906 29.7598')
    expect(markup).not.toContain('dsh-hub-brand-mono')
    expect(markup).toContain('#EFF8E9')
  })
})

describe('the Claude API card', () => {
  it('sits immediately after the Claude card', () => {
    // The one deliberate mid-list insertion (a user decision): every other line
    // is appended, this one belongs next to the card whose vendor it shares.
    const ids = HUB_PROVIDERS.map((provider) => provider.id)
    expect(ids.indexOf('claude')).toBeGreaterThanOrEqual(0)
    expect(ids.indexOf('claude-api')).toBe(ids.indexOf('claude') + 1)
  })

  it('shares the Claude mark, color and tile instead of new artwork or a monogram', () => {
    const markup = renderToStaticMarkup(<BrandTile id="claude-api" />)
    expect(markup).toBe(renderToStaticMarkup(<BrandTile id="claude" />))
    expect(markup).toContain('<svg')
    expect(markup).toContain('#D97757')
    expect(markup).not.toContain('dsh-hub-brand-mono')
    expect(markup).not.toContain('dsh-hub-brand-image')
  })
})

describe('HubOverview', () => {
  function installMemoryStorage(): void {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      get length() { return values.size },
      clear: () => { values.clear() },
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => { values.delete(key) },
      setItem: (key: string, value: string) => { values.set(key, String(value)) },
    })
  }

  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    installMemoryStorage()
    root = createRoot(container)
    localStorage.clear()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    globalThis.fetch = originalFetch
    localStorage.clear()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
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
      if (url.includes('/proxy')) {
        return Response.json({ ok: true, value: { lineProxies: {}, noProxy: null, detectedProxy: null, activeProxies: {} } })
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
    expect(cards()).toHaveLength(HUB_PROVIDERS.length)
    expect(cards().map((card) => card.querySelector('.dsh-hub-card-name')?.textContent))
      .toEqual(['ChatGPT', 'Command Code', 'Kimi Code', 'MiniMax Code', 'GLM（ZCode 账号）', 'Claude', 'Claude API', 'Ollama', 'Step Code（Step Plan 订阅）', 'Cline Pass', 'Qoder（订阅）', 'OpenDesign', 'WorkBuddy', 'Antigravity（ACP）', 'Qwen Token Plan（千问）', 'RelayOne', 'AWS Quick'])
    expect(cards()[0]!.textContent).toContain('2 个账号')
    expect(cards()[0]!.textContent).toContain('2/11 个模型可用')
    // A disabled line's card is marked and leads with the state.
    expect(cards()[1]!.dataset.enabled).toBe('false')
    expect(cards()[1]!.textContent).toContain('已停用')
    // Ollama has no switch; every other card does.
    expect(cards()[7]!.querySelector('[role="switch"]')).toBeNull()
    expect(container.querySelectorAll('[role="switch"]')).toHaveLength(16)
    // RelayOne stays present; upstream adds drag handles and per-line proxy shortcuts.
    expect(container.querySelectorAll('.dsh-hub-brand-tile')).toHaveLength(HUB_PROVIDERS.length)
    expect(container.querySelectorAll('.dsh-hub-drag-handle')).toHaveLength(HUB_PROVIDERS.length)
    // Antigravity's official CLI owns networking, so the other fifteen get a proxy select.
    expect(container.querySelectorAll('.dsh-hub-proxy-select')).toHaveLength(15)
    const antigravity = cards().find((card) => card.querySelector('.dsh-hub-card-name')?.textContent === 'Antigravity（ACP）')!
    expect(antigravity.querySelector('.dsh-hub-proxy-select')).toBeNull()
  })

  it('drills into the detail page from a card click', async () => {
    mockFetch()
    const onOpen = await render()
    await act(async () => cards()[2]!.click())
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
    expect(cards()).toHaveLength(HUB_PROVIDERS.length)
    expect(calls.some((call) => call.url.includes('/hub/overview'))).toBe(true)
  })

  it('drags a card into a new order and persists the ordered ids', async () => {
    mockFetch()
    const onOpen = await render()
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn() }
    const dragEvent = (type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
      return event
    }
    await act(async () => {
      cards()[0]!.querySelector('.dsh-hub-drag-handle')!.dispatchEvent(dragEvent('dragstart'))
    })
    await act(async () => {
      cards()[2]!.dispatchEvent(dragEvent('dragover'))
      cards()[2]!.dispatchEvent(dragEvent('drop'))
    })
    expect(cards().slice(0, 4).map((card) => card.querySelector('.dsh-hub-card-name')?.textContent))
      .toEqual(['Command Code', 'Kimi Code', 'ChatGPT', 'MiniMax Code'])
    expect(JSON.parse(localStorage.getItem(HUB_PROVIDER_ORDER_STORAGE_KEY)!)).toEqual([
      'command-code', 'kimi-code', 'chatgpt', 'minimax-code', 'glm-coding-plan', 'claude', 'claude-api', 'ollama',
      'step-code', 'cline-pass', 'qoder', 'opendesign', 'workbuddy', 'antigravity-acp', 'qianwen-token-plan', 'relayone', 'aws-quick',
    ])
    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'chatgpt')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('restores saved order, drops unknown ids and appends new providers', async () => {
    localStorage.setItem(HUB_PROVIDER_ORDER_STORAGE_KEY, JSON.stringify(['kimi-code', 'removed-line', 'kimi-code']))
    mockFetch()
    await render()
    const names = cards().map((card) => card.querySelector('.dsh-hub-card-name')?.textContent)
    expect(names.slice(0, 3)).toEqual(['Kimi Code', 'ChatGPT', 'Command Code'])
    expect(names).toHaveLength(HUB_PROVIDERS.length)
  })

  it('falls back to registry order when the saved order is corrupt', async () => {
    localStorage.setItem(HUB_PROVIDER_ORDER_STORAGE_KEY, '{bad json')
    mockFetch()
    await render()
    expect(cards()[0]!.querySelector('.dsh-hub-card-name')?.textContent).toBe('ChatGPT')
  })

  it('moves a focused drag handle with arrow keys without opening the card', async () => {
    mockFetch()
    const onOpen = await render()
    const handle = cards()[0]!.querySelector('.dsh-hub-drag-handle')!
    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    expect(cards().slice(0, 2).map((card) => card.querySelector('.dsh-hub-card-name')?.textContent))
      .toEqual(['Command Code', 'ChatGPT'])
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('saves a direct proxy mode without drilling into the card', async () => {
    const calls = mockFetch()
    const onOpen = await render()
    const select = cards()[0]!.querySelector<HTMLSelectElement>('.dsh-hub-proxy-select')!
    await act(async () => {
      select.value = 'direct'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const commit = calls.find((call) => call.url.includes('/preferences/update') && typeof call.body === 'object' && call.body !== null && 'lineProxies' in call.body)
    expect(commit?.body).toEqual({ lineProxies: { 'codex-chatgpt': { mode: 'direct', customProxyUrl: null } } })
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('reuses a saved custom proxy address', async () => {
    const calls: Array<{ url: string; body?: unknown }> = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.body !== undefined) calls.push({ url, body: JSON.parse(String(init.body)) })
      if (url.includes('/hub/overview')) return Response.json({ ok: true, value: overviewDto() })
      if (url.includes('/proxy')) return Response.json({ ok: true, value: {
        lineProxies: { 'codex-chatgpt': { mode: 'auto', customProxyUrl: 'http://127.0.0.1:7890' } },
        noProxy: null, detectedProxy: null, activeProxies: {},
      } })
      return Response.json({ ok: true, value: {} })
    }) as typeof fetch
    await render()
    const select = cards()[0]!.querySelector<HTMLSelectElement>('.dsh-hub-proxy-select')!
    await act(async () => {
      select.value = 'custom'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(calls.find((call) => call.url.includes('/preferences/update'))?.body).toEqual({
      lineProxies: { 'codex-chatgpt': { mode: 'custom', customProxyUrl: 'http://127.0.0.1:7890' } },
    })
  })

  it('opens the detail page instead of saving an empty custom proxy', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined)
    const calls = mockFetch()
    const onOpen = await render()
    const select = cards()[0]!.querySelector<HTMLSelectElement>('.dsh-hub-proxy-select')!
    await act(async () => {
      select.value = 'custom'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(alert).toHaveBeenCalledWith('请先在 ChatGPT 详情页保存自定义代理地址。')
    expect(onOpen).toHaveBeenCalledWith('chatgpt')
    expect(calls.some((call) => typeof call.body === 'object' && call.body !== null && 'lineProxies' in call.body)).toBe(false)
    expect(select.value).toBe('auto')
  })

  it('keeps the last saved proxy mode and shows an error when saving fails', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/hub/overview')) return Response.json({ ok: true, value: overviewDto() })
      if (url.includes('/proxy')) return Response.json({ ok: true, value: { lineProxies: {}, noProxy: null, detectedProxy: null, activeProxies: {} } })
      return Response.json({ ok: false, error: { code: 'internal', message: 'proxy save failed' } }, { status: 500 })
    }) as typeof fetch
    const onOpen = await render()
    const select = cards()[0]!.querySelector<HTMLSelectElement>('.dsh-hub-proxy-select')!
    await act(async () => {
      select.value = 'direct'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(select.value).toBe('auto')
    expect(cards()[0]!.querySelector('.dsh-hub-card-note')?.textContent).toContain('proxy save failed')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('keeps cards and switches usable when the proxy snapshot fails', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/hub/overview')) return Response.json({ ok: true, value: overviewDto() })
      if (url.includes('/proxy')) return Response.json({ ok: false, error: { code: 'internal', message: 'proxy unavailable' } }, { status: 500 })
      return Response.json({ ok: true, value: {} })
    }) as typeof fetch
    await render()
    expect(cards()).toHaveLength(HUB_PROVIDERS.length)
    expect(cards()[0]!.querySelector<HTMLSelectElement>('.dsh-hub-proxy-select')!.disabled).toBe(true)
    expect(cards()[0]!.querySelector('.dsh-hub-proxy-select')!.getAttribute('title')).toContain('proxy unavailable')
    expect(cards()[0]!.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(false)
  })
})
