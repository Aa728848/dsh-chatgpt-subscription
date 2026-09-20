// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { CODEX_IMAGE_TOOL_NAME } from '../src/compat.ts'
import { CodexSubscriptionSection, parseCapacity, storageLabel, storageNotice } from '../src/client/CodexSubscriptionSection.tsx'
import { ProviderHubSection } from '../src/client/ProviderHubSection.tsx'
import { apply } from '../src/client/index.tsx'
import { zh } from '../src/client/locales.ts'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

describe('client registration', () => {
  it('parses context capacities within the GPT-5.6 provider limit', () => {
    expect(parseCapacity('128K')).toBe(128_000)
    expect(parseCapacity('256,000')).toBe(256_000)
    expect(parseCapacity('1M')).toBe(1_000_000)
    expect(parseCapacity('1000001')).toBeNull()
    expect(parseCapacity('128.5K')).toBe(128_500)
    expect(parseCapacity('invalid')).toBeNull()
  })

  it('enforces the Astra subscription context limit', () => {
    expect(parseCapacity('872K', 872_000)).toBe(872_000)
    expect(parseCapacity('872001', 872_000)).toBeNull()
    expect(parseCapacity('1M', 872_000)).toBeNull()
  })

  it.each([
    ['gpt-5.6-sol', '5.6 Sol'],
    ['gpt-6-astra', '6 Astra'],
  ] as const)('keeps %s context options rendered while typing a numeric draft', async (model, modelName) => {
    const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body === undefined ? null : JSON.parse(String(init.body)) as { contextWindowOverrides?: Record<string, number>; visibleModelIds?: string[] }
      const contextWindow = body?.contextWindowOverrides?.[model] ?? 272_000
      const preferences = {
        quickQuotaVisible: false,
        fastMode: false,
        outputVerbosity: null,
        reasoningSummary: null,
        visibleModelIds: body?.visibleModelIds ?? ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
        searchProvider: 'dsh',
        contextWindowOverrides: { 'gpt-6-astra': 272_000, 'gpt-5.6-sol': 272_000, 'gpt-5.6-terra': 272_000, 'gpt-5.6-luna': 272_000, [model]: contextWindow },
        writable: true,
      }
      if (init?.method === 'POST') return Response.json({ ok: true, value: preferences })
      return Response.json({ ok: true, value: {
        authenticated: false,
        account: null,
        storage: { kind: 'memory', encrypted: false, available: true },
        login: { active: false, loginId: null, expiresAt: null },
        quota: { state: 'signed-out', buckets: [], credits: null, individualLimit: null, spendControlReached: null, resetCredits: null, fetchedAt: null, stale: false },
        preferences,
      } })
    })
    globalThis.fetch = fetchMock as typeof fetch
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const t = ((key: keyof typeof zh) => zh[key]) as never
    try {
      await act(async () => root.render(createElement(CodexSubscriptionSection, { t } as never)))
      const input = container.querySelector<HTMLInputElement>(`input[aria-label="${modelName} 上下文窗口"]`)
      expect(input).not.toBeNull()
      const modelChecks = container.querySelectorAll<HTMLInputElement>('.dsha-models input[type="checkbox"]')
      expect(modelChecks).toHaveLength(8)
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '5')
        input!.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(input?.value).toBe('5')
      // 每个可配置上下文窗口的模型一行（子代理上下文预算控件已随死设置移除）
      expect(container.querySelectorAll('.dsha-context-row')).toHaveLength(4)
      const save = container.querySelector<HTMLButtonElement>(`button[data-model="${model}"]`)
      expect(save).not.toBeNull()
      expect(save?.disabled).toBe(false)
      await act(async () => save?.click())
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ contextWindowOverrides: { [model]: 5 } })
      expect(save?.disabled).toBe(true)
      if (model === 'gpt-6-astra') {
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '1M')
          input!.dispatchEvent(new Event('input', { bubbles: true }))
        })
        await act(async () => save?.click())
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(container.textContent).toContain(zh.contextWindowInvalid)

        const astraCheck = container.querySelector<HTMLInputElement>('label[title="gpt-6-astra"] input')
        expect(astraCheck?.checked).toBe(false)
        await act(async () => astraCheck?.click())
        expect(astraCheck?.checked).toBe(true)
        expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
          visibleModelIds: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra'],
        })
      }
    } finally {
      await act(async () => root.unmount())
      container.remove()
      globalThis.fetch = originalFetch
      globalThis.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
    }
  })

  it('presents the actual Host credential storage security boundary', () => {
    const t = ((key: keyof typeof zh) => zh[key]) as never
    const linux = { kind: 'linux-file', encrypted: false, available: true } as const
    const windows = { kind: 'windows-dpapi', encrypted: true, available: true } as const
    const macos = { kind: 'macos-keychain', encrypted: true, available: true } as const

    expect(storageLabel(linux, t)).toContain('0600')
    expect(storageNotice(linux, t)).toContain('不会额外加密')
    expect(storageLabel(windows, t)).toContain('DPAPI')
    expect(storageLabel(macos, t)).toContain('钥匙串')
    expect(storageNotice(macos, t)).toContain('钥匙串')
    expect(storageNotice({ ...linux, available: false }, t)).toContain('无法安全访问')
  })

  it('contributes the tabbed subscription hub, composer quotas, and image toolview', () => {
    const injectedSlots: string[] = []
    const registrations: Array<Record<string, unknown>> = []
    const disposers: Array<() => void> = []
    const ctx = {
      effect(factory: () => void | (() => void)) {
        const dispose = factory()
        if (typeof dispose === 'function') disposers.push(dispose)
      },
      locale: {
        register() { return () => undefined },
        bind() { return (key: keyof typeof zh) => zh[key] },
      },
      slots: {
        inject(name: string, callback: () => () => void) {
          injectedSlots.push(name)
          disposers.push(callback())
        },
        register(options: Record<string, unknown>) {
          registrations.push(options)
          return () => undefined
        },
      },
    }

    apply(ctx as never)

    expect(injectedSlots).toEqual([
      'settings.section',
      'conversation.input.right',
      'conversation.input.right',
      'conversation.input.right',
      'conversation.input.right',
      'conversation.input.right',
      'tool.call.toolview',
    ])
    // All subscription providers live behind one tabbed settings page.
    expect(registrations.filter((registration) => registration.name === 'settings.section')).toEqual([
      expect.objectContaining({ name: 'settings.section', id: 'subscription-hub', order: 45 }),
    ])
    expect(registrations.filter((registration) => registration.name === 'conversation.input.right')).toEqual([
      expect.objectContaining({ name: 'conversation.input.right', id: 'codex-subscription-quota', order: 35 }),
      expect.objectContaining({ name: 'conversation.input.right', id: 'antigravity-quota', order: 36 }),
      expect.objectContaining({ name: 'conversation.input.right', id: 'command-code-quota', order: 37 }),
      expect.objectContaining({ name: 'conversation.input.right', id: 'kimi-code-quota', order: 38 }),
      expect.objectContaining({ name: 'conversation.input.right', id: 'workbuddy-quota', order: 39 }),
    ])
    expect(registrations.find((registration) => registration.name === 'tool.call.toolview')).toMatchObject({
      key: CODEX_IMAGE_TOOL_NAME,
    })
    expect(document.querySelector('style[data-plugin="@eddyskywalker/dsh-chatgpt-subscription"]')).not.toBeNull()
    for (const dispose of disposers.reverse()) dispose()
  })

  it('hosts every subscription provider behind tabs in one settings page', async () => {
    const TAB_IDS = ['chatgpt', 'antigravity', 'command-code', 'kimi-code', 'workbuddy'] as const
    const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/antigravity/api') || url.startsWith('/command-code/api') || url.startsWith('/kimi-code/api') || url.startsWith('/workbuddy/api')) {
        return Response.json({ ok: true, value: { authenticated: false, account: null, quota: null, models: [], defaultReasoningEffort: '', authDirectory: '/tmp/auth' } })
      }
      return Response.json({ ok: true, value: {
        authenticated: false,
        account: null,
        storage: { kind: 'memory', encrypted: false, available: true },
        login: { active: false, loginId: null, expiresAt: null },
        quota: { state: 'signed-out', buckets: [], credits: null, individualLimit: null, spendControlReached: null, resetCredits: null, fetchedAt: null, stale: false },
        preferences: {
          quickQuotaVisible: false,
          fastMode: false,
          outputVerbosity: null,
          reasoningSummary: null,
          visibleModelIds: ['gpt-5.6-sol'],
          searchProvider: 'dsh',
          contextWindowOverrides: {},
          writable: true,
        },
      } })
    })
    globalThis.fetch = fetchMock as typeof fetch
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const t = ((key: keyof typeof zh) => zh[key]) as never
    try {
      await act(async () => root.render(createElement(ProviderHubSection, { t, close: () => undefined } as never)))
      const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      expect(tabs.map((tab) => tab.textContent)).toEqual(['ChatGPT', 'Antigravity', 'Command Code', 'Kimi Code', 'WorkBuddy'])
      expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
      // The ChatGPT provider panel mounts by default; the other providers stay unmounted.
      expect(container.querySelector('#dsh-codex-title')).not.toBeNull()
      // Every tab, ChatGPT included, renders the same shared settings layout and
      // the same account-management card.
      expect(container.querySelector('#dsh-hub-panel-chatgpt .dsha-page')).not.toBeNull()
      expect(container.querySelector('#dsh-hub-panel-chatgpt .dsha-grouphead')?.textContent).toContain(zh.accountPool)

      for (const [index, apiPrefix] of [[1, '/antigravity/api/status'], [2, '/command-code/api/status'], [3, '/kimi-code/api/status'], [4, '/workbuddy/api/status']] as const) {
        const id: string = TAB_IDS[index]
        fetchMock.mockClear()
        await act(async () => { container.querySelector<HTMLButtonElement>('#dsh-hub-tab-' + id)?.click() })
        expect(container.querySelector('#dsh-codex-title')).toBeNull()
        expect(container.querySelector('#dsh-hub-panel-' + id + ' .dsha-page')).not.toBeNull()
        expect(fetchMock.mock.calls.some((call) => String(call[0]).startsWith(apiPrefix))).toBe(true)
        expect(container.querySelector<HTMLButtonElement>('#dsh-hub-tab-' + id)?.getAttribute('aria-selected')).toBe('true')
      }

      // Arrow keys move the active tab per the tablist pattern.
      await act(async () => {
        container.querySelector<HTMLButtonElement>('#dsh-hub-tab-workbuddy')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      })
      expect(container.querySelector<HTMLButtonElement>('#dsh-hub-tab-chatgpt')?.getAttribute('aria-selected')).toBe('true')
      expect(container.querySelector('#dsh-codex-title')).not.toBeNull()
    } finally {
      await act(async () => root.unmount())
      container.remove()
      globalThis.fetch = originalFetch
      globalThis.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
    }
  })

  it('safely mounts in a real Cordis Context with strict inject checks', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const rootCtx = new Context()
    rootCtx.provide('slots', {
      inject: () => () => undefined,
      register: () => () => undefined,
    })
    rootCtx.provide('locale', {
      register: () => () => undefined,
      bind: () => (key: string) => key,
    })
    rootCtx.provide('modelDirectories', {
      directoryFor: () => ({ store: {}, load: async () => {} }),
    })
    rootCtx.provide('conversation', {
      resolveImage: async () => '',
    })

    expect(() => {
      rootCtx.plugin({
        inject: ['slots', 'locale', 'modelDirectories', 'conversation'],
        apply,
      })
    }).not.toThrow()
  })
})
