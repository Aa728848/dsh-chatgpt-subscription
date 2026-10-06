// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { CODEX_IMAGE_TOOL_NAME } from '../src/compat.ts'
import { CODEX_MODEL_CATALOG } from '../src/shared/model-catalog.ts'
import { CodexSubscriptionSection, parseCapacity } from '../src/client/CodexSubscriptionSection.tsx'
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
    /** Pooled accounts as the host reports them, quota included. */
    accounts?: Array<Record<string, unknown>>
    activeAccountId?: string
    quota?: Record<string, unknown>
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
        accounts: options.accounts ?? [],
        ...(options.activeAccountId === undefined ? {} : { activeAccountId: options.activeAccountId }),
        rotationStrategy: 'sequential',
        storage: { kind: 'memory', encrypted: false, available: true },
        login: { active: false, loginId: null, expiresAt: null },
        quota: options.quota ?? { state: 'signed-out', buckets: [], credits: null, individualLimit: null, spendControlReached: null, resetCredits: null, fetchedAt: null, stale: false },
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
    ['gpt-6.1-sol', '6.1 Sol'],
    ['gpt-6-sol', '6 Sol'],
    ['gpt-6-luna', '6 Luna'],
  ] as const)('keeps %s context options rendered while typing a numeric draft', async (model, modelName) => {
    const harness = await mountCodexSection({ visibleModelIds: CODEX_MODEL_CATALOG.map((entry) => entry.id) })
    try {
      const { container, fetchMock } = harness
      const input = container.querySelector<HTMLInputElement>(`input[aria-label="${modelName} 上下文窗口"]`)
      expect(input).not.toBeNull()
      const modelChecks = container.querySelectorAll<HTMLButtonElement>('.dsh-mcl-option[role="checkbox"]')
      // Derived rather than pinned: adding a catalog entry must not require
      // editing a count in a test about rendering.
      expect(modelChecks).toHaveLength(CODEX_MODEL_CATALOG.length)
      // One row per checked model, so checking everything shows the whole catalog.
      expect(container.querySelectorAll('.dsha-context-row')).toHaveLength(CODEX_MODEL_CATALOG.length)
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

  it('puts each account its own quota, and leaves only facts on the quota block', async () => {
    const readAt = Date.parse('2030-06-15T00:00:00Z')
    const harness = await mountCodexSection({
      visibleModelIds: ['gpt-5.6-sol'],
      activeAccountId: 'acc_1',
      accounts: [
        { id: 'acc_1', alias: '主账号', isPrimary: true, quota: { fetchedAt: readAt, windows: [{ label: '', usedPercent: 42, windowDurationMins: 300, resetsAt: null }] } },
        { id: 'acc_2', alias: '备用账号', isPrimary: false },
      ],
      quota: {
        state: 'ready',
        buckets: [{ id: 'codex', name: 'Codex', planType: 'plus', primary: null, secondary: null, windows: [{ usedPercent: 42, windowDurationMins: 300, resetsAt: null }] }],
        credits: { hasCredits: true, unlimited: false, balance: '12.50' },
        individualLimit: null,
        spendControlReached: null,
        resetCredits: null,
        fetchedAt: readAt,
        stale: false,
      },
    })
    try {
      const { container } = harness
      // The progress bar is drawn inside the account it belongs to…
      const row = container.querySelector('.dsha-account-card .dsha-account-quota-row')
      expect(row).not.toBeNull()
      expect(row!.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('42')
      expect(row!.textContent).toContain('42%')
      // …the account nobody has read says exactly that…
      expect(container.textContent).toContain(zh.quotaNone)
      // …and the page-level block keeps the facts and says whose they are.
      const block = [...container.querySelectorAll('.dsha-group')].find((group) => group.textContent?.includes(zh.quota))!
      expect(block.textContent).toContain(zh.quotaFactsScope)
      expect(block.textContent).toContain('plus')
      expect(block.textContent).toContain('12.50')
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

      const astraCheck = container.querySelector<HTMLButtonElement>('.dsh-mcl-option[title="gpt-6-astra"]')
      expect(astraCheck?.getAttribute('aria-checked')).toBe('false')
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
      'conversation.input.right',
      'tool.call.toolview',
    ])
    // Every provider, MiniMax Code included, lives behind one tabbed settings
    // page, so the hub is the only settings.section entry registered.
    expect(registrations.filter((registration) => registration.name === 'settings.section')).toEqual([
      expect.objectContaining({ name: 'settings.section', id: 'subscription-hub', order: 45 }),
    ])
    expect(registrations.filter((registration) => registration.name === 'conversation.input.right')).toEqual([
      expect.objectContaining({ name: 'conversation.input.right', id: 'codex-subscription-quota', order: 35 }),
      expect.objectContaining({ name: 'conversation.input.right', id: 'antigravity-quota', order: 36 }),
      expect.objectContaining({ name: 'conversation.input.right', id: 'command-code-quota', order: 37 }),
      expect.objectContaining({ name: 'conversation.input.right', id: 'kimi-code-quota', order: 38 }),
      expect.objectContaining({ name: 'conversation.input.right', id: 'workbuddy-quota', order: 39 }),
      expect.objectContaining({ name: 'conversation.input.right', id: 'minimax-code-quota', order: 40 }),
      expect.objectContaining({ name: 'conversation.input.right', id: 'claude-quota', order: 41 }),
    ])
    expect(registrations.find((registration) => registration.name === 'tool.call.toolview')).toMatchObject({
      key: CODEX_IMAGE_TOOL_NAME,
    })
    expect(document.querySelector('style[data-plugin="@eddyskywalker/dsh-chatgpt-subscription"]')).not.toBeNull()
    for (const dispose of disposers.reverse()) dispose()
  })

  it('hosts every subscription provider behind an overview hub in one settings page', async () => {
    const TAB_IDS = ['chatgpt', 'antigravity', 'command-code', 'kimi-code', 'workbuddy', 'minimax-code', 'claude', 'ollama'] as const
    const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/dsh-chatgpt-subscription/hub/overview')) {
        return Response.json({ ok: true, value: {
          providers: TAB_IDS.map((id, index) => ({
            id,
            providerId: `${id}-provider`,
            canToggle: id !== 'ollama',
            enabled: true,
            accountCount: index % 3,
            authenticated: index % 3 > 0,
            enabledModelCount: id === 'chatgpt' ? 2 : null,
            totalModelCount: id === 'chatgpt' ? CODEX_MODEL_CATALOG.length : null,
          })),
        } })
      }
      // MiniMax Code mounts under its own `/minimax-code/api` prefix like every
      // sibling line, and its card treats a missing quota as "this line exposes
      // no usage endpoint".
      if (url.startsWith('/minimax-code/api/accounts')) {
        return Response.json({ ok: true, value: {
          accounts: [{
            id: 'acc_1',
            alias: 'mini@example.com',
            isPrimary: true,
            email: 'mini@example.com',
            removable: false,
          }],
          activeAccountId: 'acc_1',
          rotationStrategy: 'sequential',
        } })
      }
      if (url.startsWith('/minimax-code/api')) {
        return Response.json({ ok: true, value: {
          enabled: true,
          authenticated: false,
          account: null,
          region: 'cn',
          storage: { kind: 'minimax-native', path: '/tmp/minimax-auth.json' },
          models: [{
            id: 'MiniMax-M3',
            name: 'MiniMax M3',
            enabled: true,
            defaultContextWindow: 200_000,
            contextWindow: 200_000,
            defaultMaxTokens: 128_000,
            thinking: 'toggle',
            description: 'flagship',
          }],
          contextWindowOverrides: {},
          defaultReasoningEffort: null,
          serving: true,
          conflict: null,
          ownedByPlugin: false,
        } })
      }
      if (url.startsWith('/ollama/api')) {
        // Ollama's card is the shared account card over an API-key pool, so the
        // payload is the pool slice plus a synced catalog.
        return Response.json({ ok: true, value: {
          pool: {
            accounts: [{ id: 'ok_1', alias: 'Ollama 账号 1', isPrimary: true }],
            activeAccountId: 'ok_1',
            rotationStrategy: 'sequential',
          },
          models: [{ id: 'gpt-oss:120b-cloud' }],
          usable: true,
          catalogSynced: true,
        } })
      }
      if (url.startsWith('/antigravity/api') || url.startsWith('/claude/api') || url.startsWith('/command-code/api') || url.startsWith('/kimi-code/api') || url.startsWith('/workbuddy/api')) {
        return Response.json({ ok: true, value: {
          authenticated: false,
          account: null,
          quota: null,
          models: [],
          contextWindowOverrides: {},
          defaultReasoningEffort: '',
          authDirectory: '/tmp/auth',
          claudeCodeSignInAvailable: false,
          claudeCodePaths: [],
        } })
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
      sessionStorage.removeItem('dsh-chatgpt-subscription:hub-view')
      await act(async () => root.render(createElement(ProviderHubSection, { t, close: () => undefined } as never)))

      // The opening screen is the overview: one card per provider, in registry
      // order, and no provider section mounted underneath.
      const cards = [...container.querySelectorAll<HTMLElement>('.dsh-hub-card')]
      expect(cards.map((card) => card.querySelector('.dsh-hub-card-name')?.textContent)).toEqual(['ChatGPT', 'Antigravity', 'Command Code', 'Kimi Code', 'WorkBuddy', 'MiniMax Code', 'Claude', 'Ollama'])
      expect(container.querySelector('.dsh-hub-detail')).toBeNull()
      expect(container.querySelector('#dsh-codex-title')).toBeNull()
      // Every toggleable line renders a switch on its card; Ollama, which has
      // no enable switch on the host, renders none.
      expect(container.querySelectorAll('.dsh-hub-card [role="switch"]')).toHaveLength(7)
      const ollamaCard = cards.find((card) => card.textContent?.includes('Ollama'))!
      expect(ollamaCard.querySelector('[role="switch"]')).toBeNull()
      // Annotations carry the account count from the aggregated overview.
      expect(cards[1]?.textContent).toContain('1 个账号')

      // Drilling in replaces the overview with that line's section, mounted
      // under the back bar; leaving the page means the section unmounts.
      for (const [index, apiPrefix] of [[1, '/antigravity/api/status'], [2, '/command-code/api/status'], [3, '/kimi-code/api/status'], [4, '/workbuddy/api/status'], [5, '/minimax-code/api/status'], [6, '/claude/api/status']] as const) {
        const id: string = TAB_IDS[index]
        fetchMock.mockClear()
        await act(async () => { container.querySelectorAll<HTMLElement>('.dsh-hub-card')[index]?.click() })
        expect(container.querySelector('.dsh-hub-overview')).toBeNull()
        expect(container.querySelector('.dsh-hub-detail .dsha-page')).not.toBeNull()
        expect(container.querySelector('.dsh-hub-backbar-name')?.textContent?.length).toBeGreaterThan(0)
        expect(fetchMock.mock.calls.some((call) => String(call[0]).startsWith(apiPrefix))).toBe(true)
        await act(async () => { container.querySelector<HTMLButtonElement>('.dsh-hub-back')?.click() })
        expect(container.querySelector('.dsh-hub-overview')).not.toBeNull()
        expect(container.querySelector('.dsh-hub-detail')).toBeNull()
      }

      // The ChatGPT card mounts the ChatGPT section, which is the one section
      // with its own page-level header.
      fetchMock.mockClear()
      await act(async () => { container.querySelectorAll<HTMLElement>('.dsh-hub-card')[0]?.click() })
      expect(container.querySelector('.dsh-hub-detail .dsha-page')).not.toBeNull()
      expect(container.querySelector('#dsh-codex-title')).not.toBeNull()
      expect(container.querySelector('.dsh-hub-detail .dsha-grouphead')?.textContent).toContain(zh.accountPool)
      await act(async () => { container.querySelector<HTMLButtonElement>('.dsh-hub-back')?.click() })

      // The MiniMax detail renders its OWN dictionary, not the hub's locale seat.
      // The hub's `t` is bound to the ChatGPT namespace, whose key set is not a
      // superset of this card's: using it resolved 35 keys to their literal names
      // and 8 others to ChatGPT wording (the sign-in button literally read
      // "使用 ChatGPT 登录"). Resolve `t` the way the real LocaleFace does — an
      // unknown key falls through to the key itself — and assert no key leaks.
      await act(async () => { container.querySelectorAll<HTMLElement>('.dsh-hub-card')[5]?.click() })
      const minimaxText = container.querySelector('.dsh-hub-detail .dsha-page')?.textContent ?? ''
      expect(minimaxText).not.toContain('使用 ChatGPT 登录')
      expect(minimaxText).not.toContain(zh.signIn)
      // A literal key name would appear as a camelCase word with no CJK context.
      for (const key of ['pageDesc', 'accountLabel', 'storagePath', 'quotaSection', 'regionCn']) {
        expect(minimaxText).not.toContain(key)
      }
      expect(minimaxText).toContain('MiniMax Code')
      await act(async () => { container.querySelector<HTMLButtonElement>('.dsh-hub-back')?.click() })

      // The detail the user was last on survives a remount of the settings page.
      await act(async () => { container.querySelectorAll<HTMLElement>('.dsh-hub-card')[6]?.click() })
      expect(container.querySelector('.dsh-hub-backbar-name')?.textContent).toBe('Claude')
      await act(async () => root.unmount())
      const remountRoot = createRoot(container)
      await act(async () => remountRoot.render(createElement(ProviderHubSection, { t, close: () => undefined } as never)))
      expect(container.querySelector('.dsh-hub-backbar-name')?.textContent).toBe('Claude')
      expect(container.querySelector('.dsh-hub-detail .dsha-page')).not.toBeNull()
      await act(async () => remountRoot.unmount())
    } finally {
      // The remount check above may have unmounted the first root already.
      await act(async () => { try { root.unmount() } catch { /* already unmounted */ } })
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
