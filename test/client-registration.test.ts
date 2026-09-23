// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { CODEX_IMAGE_TOOL_NAME } from '../src/compat.ts'
import { CODEX_MODEL_CATALOG } from '../src/shared/model-catalog.ts'
import { CodexSubscriptionSection, parseCapacity, storageLabel, storageNotice } from '../src/client/CodexSubscriptionSection.tsx'
import { ProviderHubSection } from '../src/client/ProviderHubSection.tsx'
import { apply, inject } from '../src/client/index.tsx'
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

  it('enforces the GPT-6 family subscription context limit', () => {
    expect(parseCapacity('872K', 872_000)).toBe(872_000)
    expect(parseCapacity('872001', 872_000)).toBeNull()
    expect(parseCapacity('1M', 872_000)).toBeNull()
  })

  /**
   * Mount the ChatGPT tab over a fake host that applies preference patches the
   * way the real route does: a `null` override deletes that model's key.
   */
  async function mountCodexSection(options: {
    visibleModelIds: string[]
    contextWindowOverrides?: Record<string, number>
  }): Promise<{ container: HTMLElement; fetchMock: ReturnType<typeof vi.fn>; teardown: () => Promise<void> }> {
    const preferences = {
      visibleModelIds: [...options.visibleModelIds],
      contextWindowOverrides: { ...(options.contextWindowOverrides ?? {}) },
    }
    const payload = (): Record<string, unknown> => ({
      quickQuotaVisible: false,
      fastMode: false,
      outputVerbosity: null,
      reasoningSummary: null,
      visibleModelIds: preferences.visibleModelIds,
      searchProvider: 'dsh',
      contextWindowOverrides: preferences.contextWindowOverrides,
      proxyMode: 'auto',
      customProxyUrl: null,
      writable: true,
    })
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const patch = JSON.parse(String(init.body)) as {
          visibleModelIds?: string[]
          contextWindowOverrides?: Record<string, number | null>
        }
        if (patch.visibleModelIds !== undefined) preferences.visibleModelIds = patch.visibleModelIds
        for (const [model, value] of Object.entries(patch.contextWindowOverrides ?? {})) {
          if (value === null) delete preferences.contextWindowOverrides[model]
          else preferences.contextWindowOverrides[model] = value
        }
        return Response.json({ ok: true, value: payload() })
      }
      return Response.json({ ok: true, value: {
        authenticated: false,
        account: null,
        storage: { kind: 'memory', encrypted: false, available: true },
        login: { active: false, loginId: null, expiresAt: null },
        quota: { state: 'signed-out', buckets: [], credits: null, individualLimit: null, spendControlReached: null, resetCredits: null, fetchedAt: null, stale: false },
        preferences: payload(),
      } })
    })
    const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT
    const originalFetch = globalThis.fetch
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    globalThis.fetch = fetchMock as typeof fetch
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const t = ((key: keyof typeof zh) => zh[key]) as never
    await act(async () => root.render(createElement(CodexSubscriptionSection, { t } as never)))
    return {
      container,
      fetchMock,
      teardown: async () => {
        await act(async () => root.unmount())
        container.remove()
        globalThis.fetch = originalFetch
        globalThis.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
      },
    }
  }

  it.each([
    ['gpt-5.6-sol', '5.6 Sol'],
    ['gpt-6-astra', '6 Astra'],
    ['gpt-6-sol', '6 Sol'],
    ['gpt-6-luna', '6 Luna'],
  ] as const)('keeps %s context options rendered while typing a numeric draft', async (model, modelName) => {
    const harness = await mountCodexSection({ visibleModelIds: CODEX_MODEL_CATALOG.map((entry) => entry.id) })
    try {
      const { container, fetchMock } = harness
      const input = container.querySelector<HTMLInputElement>(`input[aria-label="${modelName} 上下文窗口"]`)
      expect(input).not.toBeNull()
      const modelChecks = container.querySelectorAll<HTMLInputElement>('.dsha-models input[type="checkbox"]')
      expect(modelChecks).toHaveLength(10)
      // One row per checked model, so checking everything shows the whole catalog.
      expect(container.querySelectorAll('.dsha-context-row')).toHaveLength(10)
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '5')
        input!.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(input?.value).toBe('5')
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
      }
    } finally {
      await harness.teardown()
    }
  })

  it('lists a context row only for the models checked under Available models', async () => {
    const harness = await mountCodexSection({ visibleModelIds: ['gpt-5.6-sol', 'gpt-5.6-terra'] })
    try {
      const { container, fetchMock } = harness
      expect([...container.querySelectorAll('.dsha-context-row label')].map((label) => label.textContent)).toEqual(['5.6 Sol', '5.6 Terra'])
      expect(container.querySelector('input[aria-label="6 Astra 上下文窗口"]')).toBeNull()
      // Nothing is overridden yet, so there is nothing to restore.
      expect(container.querySelector<HTMLButtonElement>('.dsha-context-settings .dsha-actions button')?.disabled).toBe(true)

      const astraCheck = container.querySelector<HTMLInputElement>('label[title="gpt-6-astra"] input')
      expect(astraCheck?.checked).toBe(false)
      await act(async () => astraCheck?.click())
      expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
        visibleModelIds: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra'],
      })
      // The freshly checked model gets a row showing its catalog value, not an empty box.
      expect(container.querySelector<HTMLInputElement>('input[aria-label="6 Astra 上下文窗口"]')?.value).toBe('384K')
      expect(container.querySelectorAll('.dsha-context-row')).toHaveLength(3)
    } finally {
      await harness.teardown()
    }
  })

  it('restores one modified model context window to its default', async () => {
    const harness = await mountCodexSection({
      visibleModelIds: ['gpt-5.6-sol', 'gpt-5.6-terra'],
      contextWindowOverrides: { 'gpt-5.6-sol': 500_000 },
    })
    try {
      const { container, fetchMock } = harness
      expect(container.querySelector<HTMLInputElement>('input[aria-label="5.6 Sol 上下文窗口"]')?.value).toBe('500K')
      const modified = container.querySelector<HTMLButtonElement>('button[data-reset-model="gpt-5.6-sol"]')
      const untouched = container.querySelector<HTMLButtonElement>('button[data-reset-model="gpt-5.6-terra"]')
      expect(modified?.className).toContain('dsha-context-reset')
      expect(modified?.disabled).toBe(false)
      expect(untouched?.disabled).toBe(true)

      await act(async () => modified?.click())
      expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ contextWindowOverrides: { 'gpt-5.6-sol': null } })
      expect(container.querySelector<HTMLInputElement>('input[aria-label="5.6 Sol 上下文窗口"]')?.value).toBe('272K')
      expect(container.querySelector<HTMLButtonElement>('button[data-reset-model="gpt-5.6-sol"]')?.disabled).toBe(true)
    } finally {
      await harness.teardown()
    }
  })

  it('restores every modified context window at once', async () => {
    const confirmMock = vi.fn(() => true)
    const originalConfirm = window.confirm
    window.confirm = confirmMock
    // The second override belongs to a model that is not checked, and is cleared too.
    const harness = await mountCodexSection({
      visibleModelIds: ['gpt-5.6-sol'],
      contextWindowOverrides: { 'gpt-5.6-sol': 500_000, 'gpt-5.4': 300_000 },
    })
    try {
      const { container, fetchMock } = harness
      const resetAll = container.querySelector<HTMLButtonElement>('.dsha-context-settings .dsha-actions button')
      expect(resetAll?.textContent).toBe(zh.contextWindowResetAll)
      expect(resetAll?.disabled).toBe(false)
      await act(async () => resetAll?.click())
      expect(confirmMock).toHaveBeenCalledWith(zh.contextWindowResetAllConfirm)
      expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
        contextWindowOverrides: { 'gpt-5.6-sol': null, 'gpt-5.4': null },
      })
      expect(resetAll?.disabled).toBe(true)
    } finally {
      await harness.teardown()
      window.confirm = originalConfirm
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
      expect.objectContaining({ name: 'conversation.input.right', id: 'zhipu-quota', order: 40 }),
    ])
    expect(registrations.find((registration) => registration.name === 'tool.call.toolview')).toMatchObject({
      key: CODEX_IMAGE_TOOL_NAME,
    })
    expect(document.querySelector('style[data-plugin="@eddyskywalker/dsh-chatgpt-subscription"]')).not.toBeNull()
    for (const dispose of disposers.reverse()) dispose()
  })

  it('hosts every subscription provider behind tabs in one settings page', async () => {
    const TAB_IDS = ['chatgpt', 'antigravity', 'command-code', 'kimi-code', 'workbuddy', 'zhipu'] as const
    const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/antigravity/api') || url.startsWith('/command-code/api') || url.startsWith('/kimi-code/api') || url.startsWith('/workbuddy/api') || url.startsWith('/zhipu/api')) {
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
      expect(tabs.map((tab) => tab.textContent)).toEqual(['ChatGPT', 'Antigravity', 'Command Code', 'Kimi Code', 'WorkBuddy', 'GLM'])
      expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
      // The ChatGPT provider panel mounts by default; the other providers stay unmounted.
      expect(container.querySelector('#dsh-codex-title')).not.toBeNull()
      // Every tab, ChatGPT included, renders the same shared settings layout and
      // the same account-management card.
      expect(container.querySelector('#dsh-hub-panel-chatgpt .dsha-page')).not.toBeNull()
      expect(container.querySelector('#dsh-hub-panel-chatgpt .dsha-grouphead')?.textContent).toContain(zh.accountPool)

      for (const [index, apiPrefix] of [[1, '/antigravity/api/status'], [2, '/command-code/api/status'], [3, '/kimi-code/api/status'], [4, '/workbuddy/api/status'], [5, '/zhipu/api/status']] as const) {
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
        container.querySelector<HTMLButtonElement>('#dsh-hub-tab-zhipu')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
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
    rootCtx.provide('sessions', {} as any)
    rootCtx.provide('remote', { session: {} } as any)
    rootCtx.provide('remote.session', {} as any)

    expect(() => {
      rootCtx.plugin({
        inject,
        apply,
      })
    }).not.toThrow()
  })

  it('allows accessing remote.session through client context inject', async () => {
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
    rootCtx.provide('sessions', {} as any)
    rootCtx.provide('remote', { session: {} } as any)
    rootCtx.provide('remote.session', {} as any)

    let capturedCtx: any
    await rootCtx.plugin({
      inject,
      apply(ctx) {
        capturedCtx = ctx
      },
    })

    expect(capturedCtx.remote.session).toBeDefined()
    expect(capturedCtx.sessions).toBeDefined()
  })

  it('allows modelDirectories.directoryFor to access remote.session without throwing', async () => {
    const { Context, Service } = await import('@deepseek-ai/cordis')
    const rootCtx = new Context()
    rootCtx.provide('slots', {
      inject: () => () => undefined,
      register: () => () => undefined,
    })
    rootCtx.provide('locale', {
      register: () => () => undefined,
      bind: () => (key: string) => key,
    })
    rootCtx.provide('conversation', {
      resolveImage: async () => '',
    })
    rootCtx.provide('sessions', {
      scope: () => ({}),
      binding: () => ({ session: { projections: { faceOf: () => ({}) } } }),
      subagentAddress: () => undefined,
    } as any)
    rootCtx.provide('remote', { session: { modelCatalog: async () => ({}) } } as any)
    rootCtx.provide('remote.session', { modelCatalog: async () => ({}) } as any)

    class MockModelDirectoryResolver extends Service {
      constructor(ctx: any) {
        super(ctx, 'modelDirectories')
      }
      directoryFor(sessionId: string) {
        const session = (this.ctx as any).remote.session
        return { session, store: {}, load: async () => {} }
      }
    }
    new MockModelDirectoryResolver(rootCtx)

    let capturedCtx: any
    await rootCtx.plugin({
      inject,
      apply(ctx) {
        capturedCtx = ctx
      },
    })

    expect(() => {
      const dir = capturedCtx.modelDirectories.directoryFor('test-session')
      expect(dir.session).toBeDefined()
    }).not.toThrow()
  })
})
