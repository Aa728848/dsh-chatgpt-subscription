// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  HubOverview,
  cardAnnotation,
  HUB_PROVIDER_ORDER_STORAGE_KEY,
} from '../../src/client/hub/HubOverview.tsx'
import { ProviderHubSection } from '../../src/client/hub/ProviderHubSection.tsx'
import { BrandTile, PROVIDER_BRANDS } from '../../src/client/hub/brand-icons.tsx'
import { HUB_PROVIDERS } from '../../src/client/hub/providers.tsx'
import { zh } from '../../src/client/providers/codex-chatgpt/locales.ts'
import type { HubOverviewDto, HubProviderSummaryDto } from '../../src/shared/hub-contracts.ts'

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
      summary('chatgpt', {
        accountCount: 2,
        authenticated: true,
        accountHint: 'ChatGPT Plus',
        enabledModelCount: 2,
        totalModelCount: 11,
        modelIds: ['gpt-5.4', 'o3'],
      }),
      summary('command-code', { enabled: false, accountCount: 1, authenticated: true, accountHint: 'work@example.com' }),
      summary('kimi-code', { accountCount: 1, authenticated: true, enabledModelCount: 4, totalModelCount: 4, modelIds: ['kimi-k3'] }),
      summary('minimax-code', { error: true }),
      summary('glm-coding-plan', { enabled: false, accountCount: 0 }),
      summary('claude', { enabled: false, accountCount: 0 }),
      summary('ollama', { canToggle: false, accountCount: 3, authenticated: true }),
      summary('step-code', { enabled: false, accountCount: 0 }),
      summary('cline-pass', { enabled: false, accountCount: 0 }),
      summary('qoder', { enabled: false, accountCount: 0 }),
      summary('opendesign', { enabled: false, accountCount: 0 }),
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
    expect(cardAnnotation(summary('minimax-code', { error: true }), descriptor('minimax-code'), t)).toBe(zh.hubStatusFailed)
    expect(cardAnnotation(undefined, descriptor('chatgpt'), t)).toBe('…')
  })
})

describe('brand marks', () => {
  it('uses unified white rounded tiles, official icons, and white-background Antigravity mark', () => {
    expect(renderToStaticMarkup(<BrandTile id="aws-quick" />)).toContain('data:image/png;base64,')
    expect(renderToStaticMarkup(<BrandTile id="qoder" />)).toContain('dsh-hub-brand-image')
    expect(renderToStaticMarkup(<BrandTile id="opendesign" />)).toContain('M49.8906 29.7598')
    expect(renderToStaticMarkup(<BrandTile id="claude-api" />)).toBe(renderToStaticMarkup(<BrandTile id="claude" />))
    expect(renderToStaticMarkup(<BrandTile id="claude" />)).toContain('fill="currentColor"')
    expect(renderToStaticMarkup(<BrandTile id="ollama" />)).toContain('<svg')
    expect(renderToStaticMarkup(<BrandTile id="ollama" />)).not.toContain('dsh-hub-brand-mono')
    // Antigravity uses a fixed white background without dark-mode black override
    const agSrc = PROVIDER_BRANDS['antigravity-acp'].image!.src
    const agSvg = Buffer.from(agSrc.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8')
    expect(agSvg).toContain('fill="#FFFFFF"')
    expect(agSvg).not.toContain('prefers-color-scheme: dark')
    // Every provider shares the unified white tile surface
    for (const provider of HUB_PROVIDERS) {
      expect(PROVIDER_BRANDS[provider.id].tile).toBe('#FFFFFF')
    }
    const ids = HUB_PROVIDERS.map((provider) => provider.id)
    expect(ids.indexOf('claude-api')).toBe(ids.indexOf('claude') + 1)
  })
})

describe('HubOverview (Magpie-style)', () => {
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

  function mockFetch(overview: HubOverviewDto | null = overviewDto(), proxyOverrides: Record<string, unknown> = {}) {
    const calls: Array<{ url: string; body?: unknown }> = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) })
      if (url.includes('/hub/overview')) {
        if (overview === null) return Response.json({ ok: false, error: { code: 'internal', message: 'boom' } }, { status: 500 })
        return Response.json({ ok: true, value: overview })
      }
      if (url.includes('/proxy')) {
        return Response.json({
          ok: true,
          value: { lineProxies: {}, noProxy: null, detectedProxy: null, activeProxies: {}, ...proxyOverrides },
        })
      }
      return Response.json({ ok: true, value: {} })
    }) as typeof fetch
    return calls
  }

  async function render(onOpen = vi.fn()) {
    await act(async () => root.render(createElement(HubOverview, { t, onOpen } as never)))
    return onOpen
  }

  function cards(selector = '.dsh-hub-card'): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>(selector)]
  }

  it('groups enabled lines in the main card, folds turned-off configured lines, and omits idle disabled lines', async () => {
    mockFetch(overviewDto(), { lineProxies: { 'codex-chatgpt': { mode: 'direct', customProxyUrl: null } } })
    await render()

    // Enabled: chatgpt, kimi-code, minimax-code, ollama (4 rows in primary list)
    const enabledCards = cards('[data-group="enabled"] .dsh-hub-card')
    expect(enabledCards.map((c) => c.dataset.id)).toEqual(['chatgpt', 'kimi-code', 'minimax-code', 'ollama'])
    // Status pill shows signed-in state without exposing account identifiers on the overview
    expect(enabledCards[0]!.textContent).toContain(zh.hubStatusSignedIn)
    expect(enabledCards[0]!.textContent).not.toContain('ChatGPT Plus')
    expect(enabledCards[0]!.textContent).toContain('2/11 个模型可用')
    expect(enabledCards[0]!.textContent).toContain(zh.hubProxyDirect)
    // Ollama has no switch; no permanent proxy dropdowns or legacy drag-handle clutter
    expect(enabledCards[3]!.querySelector('[role="switch"]')).toBeNull()
    expect(container.querySelectorAll('.dsh-hub-proxy-select')).toHaveLength(0)

    // Turned off section shows count 1 (command-code) and starts folded
    const foldBtn = container.querySelector<HTMLButtonElement>('.dsh-hub-fold')!
    expect(foldBtn.getAttribute('aria-expanded')).toBe('false')
    expect(foldBtn.textContent).toContain('1')
    expect(cards('[data-group="disabled"] .dsh-hub-card')).toHaveLength(0)

    // Expanding reveals command-code with the Off badge
    await act(async () => foldBtn.click())
    const offCards = cards('[data-group="disabled"] .dsh-hub-card')
    expect(offCards.map((c) => c.dataset.id)).toEqual(['command-code'])
    expect(offCards[0]!.textContent).toContain(zh.hubBadgeOff)
  })

  it('searches by model id and automatically expands matching turned-off providers', async () => {
    mockFetch()
    await render()
    const input = container.querySelector<HTMLInputElement>('.dsh-hub-toolbar .dsh-hub-search')!

    // Searching a model name surfaces the provider + matched model hint
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'kimi-k3')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(cards().map((c) => c.dataset.id)).toEqual(['kimi-code'])
    expect(cards()[0]!.querySelector('.dsh-hub-hits')?.textContent).toContain('kimi-k3')

    // Searching a turned-off provider auto-expands the folded off section
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'command')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(cards('[data-group="disabled"] .dsh-hub-card').map((c) => c.dataset.id)).toEqual(['command-code'])
    expect(container.querySelector<HTMLButtonElement>('.dsh-hub-fold')!.disabled).toBe(true)
  })

  it('opens the inline "+ Add provider" sheet, filters presets, and opens the picked provider', async () => {
    mockFetch()
    const onOpen = await render()
    const addBtn = container.querySelector<HTMLButtonElement>('.dsh-hub-add-btn')!
    await act(async () => addBtn.click())

    const sheet = container.querySelector('.dsh-hub-sheet')!
    expect(sheet).not.toBeNull()
    expect(sheet.querySelectorAll('.dsh-hub-tile')).toHaveLength(HUB_PROVIDERS.length)

    // Filter inside add sheet and pick claude-api
    const sheetSearch = sheet.querySelector<HTMLInputElement>('.dsh-hub-search')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(sheetSearch, 'claude-api')
      sheetSearch.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const tiles = [...sheet.querySelectorAll<HTMLButtonElement>('.dsh-hub-tile')]
    expect(tiles).toHaveLength(1)
    await act(async () => tiles[0]!.click())
    expect(onOpen).toHaveBeenCalledWith('claude-api')
  })

  it('auto-opens the add sheet when no providers are enabled or configured yet', async () => {
    mockFetch({ providers: [summary('chatgpt', { enabled: false, accountCount: 0 })] })
    await render()
    expect(container.querySelector('.dsh-hub-sheet')).not.toBeNull()
    expect(container.querySelector('.dsh-hub-toolbar')).toBeNull()
  })

  it('flips a switch optimistically and rolls back on failure', async () => {
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
    await act(async () => toggle.click())
    expect(calls.find((call) => call.url.includes('/preferences/update'))?.body).toEqual({ enabled: false })
    expect(onOpen).not.toHaveBeenCalled()
    // ChatGPT moved into the turned-off section (count grew from 1 to 2)
    expect(container.querySelector('.dsh-hub-fold-count')?.textContent).toBe('2')
  })

  it('rolls the switch back and surfaces an error when the commit fails', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/hub/overview')) return Response.json({ ok: true, value: overviewDto() })
      if (url.includes('/preferences')) return Response.json({ ok: false, error: { code: 'internal', message: 'disk full' } }, { status: 500 })
      return Response.json({ ok: true, value: {} })
    }) as typeof fetch
    await render()
    const toggle = cards()[0]!.querySelector<HTMLButtonElement>('[role="switch"]')!
    await act(async () => toggle.click())
    await act(async () => Promise.resolve())
    expect(cards()[0]!.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true')
    expect(cards()[0]!.querySelector('.dsh-hub-card-note')?.textContent).toContain('disk full')
  })

  it('supports logo drag reorder, keyboard arrow reorder, and right-click context menu', async () => {
    mockFetch()
    const onOpen = await render()
    const handle = cards()[0]!.querySelector('.dsh-hub-logo-handle')!
    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    expect(onOpen).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem(HUB_PROVIDER_ORDER_STORAGE_KEY)!)[0]).toBe('command-code')

    // Right-click on the second enabled row opens sort menu and moves it to top
    const enabled = cards('[data-group="enabled"] .dsh-hub-card')
    await act(async () => {
      enabled[1]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 60 }))
    })
    const menuItems = [...container.querySelectorAll<HTMLButtonElement>('.dsh-hub-menu-item')]
    expect(menuItems.map((m) => m.textContent)).toEqual([zh.hubMenuMoveTop, zh.hubMenuMoveUp, zh.hubMenuMoveDown, zh.hubMenuMoveBottom])
    await act(async () => menuItems[0]!.click())
    expect(cards('[data-group="enabled"] .dsh-hub-card')[0]!.dataset.id).toBe(enabled[1]!.dataset.id)
  })

  it('supports multi-select mode without a privacy mask button', async () => {
    mockFetch()
    await render()
    expect(container.querySelector('.dsh-hub-masked')).toBeNull()
    expect([...container.querySelectorAll<HTMLButtonElement>('.dsh-hub-tool-btn')].every((btn) => btn.getAttribute('aria-pressed') === null)).toBe(true)

    // Enter select mode and pick rows
    const selectBtn = [...container.querySelectorAll<HTMLButtonElement>('.dsh-hub-tool-btn')]
      .find((btn) => btn.textContent === zh.hubSelectMode)!
    await act(async () => selectBtn.click())
    expect(container.querySelector('.dsh-hub-sel-bar')).not.toBeNull()
    const checks = [...container.querySelectorAll<HTMLInputElement>('.dsh-hub-check')]
    expect(checks.length).toBeGreaterThanOrEqual(2)
    await act(async () => checks[0]!.click())
    expect(container.querySelector('.dsh-hub-sel-count')?.textContent).toContain('1')
  })

  it('places search, select, and update refresh on the same header row in ProviderHubSection', async () => {
    mockFetch()
    sessionStorage.removeItem('dsh-chatgpt-subscription:hub-view')
    await act(async () => root.render(createElement(ProviderHubSection, { t, close: () => undefined } as never)))
    const header = container.querySelector('.dsh-hub-head')!
    expect(header.querySelector('#dsh-hub-title')?.textContent).toBe(zh.hubTitle)
    expect(header.querySelector('.dsh-hub-search')).not.toBeNull()
    expect([...header.querySelectorAll<HTMLButtonElement>('.dsh-hub-tool-btn')].some((b) => b.textContent === zh.hubSelectMode)).toBe(true)
    expect(header.lastElementChild?.className).toBe('dsh-hub-update')
    // No duplicate toolbar row inside the overview body
    expect(container.querySelector('.dsh-hub-overview .dsh-hub-toolbar')).toBeNull()
  })

  it('offers a retry when the overview itself fails to load', async () => {
    mockFetch(null)
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('boom')
    const retry = container.querySelector<HTMLButtonElement>('[role="alert"] button')!
    mockFetch()
    await act(async () => retry.click())
    expect(cards('[data-group="enabled"] .dsh-hub-card').length).toBeGreaterThan(0)
  })
})
