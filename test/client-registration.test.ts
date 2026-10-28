// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { ANTIGRAVITY_IMAGE_TOOL_NAME, CODEX_IMAGE_TOOL_NAME } from '../src/compat.ts'
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
    ['gpt-6.1-terra', '6.1 Terra'],
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
      // order 35-41 这一段：ChatGPT 自己的胶囊，加上每一条线路各一格。
      'conversation.input.right',
      'conversation.input.right',
      'conversation.input.right',
      'conversation.input.right',
      'conversation.input.right',
      'conversation.input.right',
      // 一条新线路加一个胶囊槽位：注入次数由线路数决定，这里跟着 HUB_PROVIDERS 走。
      'conversation.input.right',
      // Step Code 的胶囊同样只是又一个槽位，顺序接在 GLM 那条之后（order 43）。
      'conversation.input.right',
      // Cline Pass 的胶囊接在 Step Code 之后（order 44）。
      'conversation.input.right',
      // Qoder 的胶囊接在 Cline Pass 之后（order 45）。
      'conversation.input.right',
      // OpenDesign 的胶囊接在 Qoder 之后（order 46）。
      'conversation.input.right',
      'tool.call.toolview',
      // Antigravity 生图工具复用同一张生图卡片，按工具名再注册一次。
      'tool.call.toolview',
      // MiniMax 生成视频：第三张工具卡片，同一个 keyed 槽，按工具名再注册一次。
      'tool.call.toolview',
      // MiniMax 视频的侧边栏渲染器：正文注册在宿主的文档页签槽上。
      'sidebar.right.tab.document',
      // 进展更新子模块（./progress-updates/）：对话流进展行、侧栏页签的正文与
      // 标题（阶段二的 keyed 槽位）、以及它自己那一格设置页。页签**类型**的注册走
      // ctx.sidebarRightTabs（服务，不是槽位），所以这里看不到第四类槽位。
      'tool.call.toolview',
      'sidebar.right.pane.tab',
      'sidebar.right.pane.tab.title',
      'settings.section',
      // MiniMax 视频的 `/video` 参数弹窗：渲染座位挂在输入框的 overlay 槽上。
      // 弹窗本身是全局的（命令回调在一段没有 React 树的代码里，靠模块级句柄
      // 打开它），但 overlay 是宿主唯一为「盖在输入框上的层」准备的槽位。
      'conversation.input.overlay',
    ])
    // Every provider, MiniMax Code included, lives behind one tabbed settings
    // page, so the hub is the one subscription settings.section entry. Progress
    // updates get their OWN page (order 150) beside it — a separate concern from
    // the provider lines, and the user asked for a distinct section.
    expect(registrations.filter((registration) => registration.name === 'settings.section')).toEqual([
      expect.objectContaining({ name: 'settings.section', id: 'subscription-hub', order: 45 }),
      expect.objectContaining({ name: 'settings.section', id: 'progress-updates', order: 150 }),
    ])
    expect(registrations.filter((registration) => registration.name === 'conversation.input.right')).toEqual([
      expect.objectContaining({ name: 'conversation.input.right', id: 'codex-subscription-quota', order: 35 }),
      expect.objectContaining({ name: 'conversation.input.right', id: 'antigravity-quota', order: 36 }),
      expect.objectContaining({ name: 'conversation.input.right', id: 'command-code-quota', order: 37 }),
      expect.objectContaining({ name: 'conversation.input.right', id: 'kimi-code-quota', order: 38 }),
      expect.objectContaining({ name: 'conversation.input.right', id: 'minimax-code-quota', order: 40 }),
      expect.objectContaining({ name: 'conversation.input.right', id: 'claude-quota', order: 41 }),
      expect.objectContaining({ name: 'conversation.input.right', id: 'glm-coding-plan-quota', order: 42 }),
      expect.objectContaining({ name: 'conversation.input.right', id: 'step-code-quota', order: 43 }),
      expect.objectContaining({ name: 'conversation.input.right', id: 'cline-pass-quota', order: 44 }),
      expect.objectContaining({ name: 'conversation.input.right', id: 'qoder-quota', order: 45 }),
      expect.objectContaining({ name: 'conversation.input.right', id: 'opendesign-quota', order: 46 }),
    ])
    // 视频参数弹窗的那一格：与设置卡片同一种「插件自己的一格」写法，插在输入框
    // 浮层里、排在那条反馈弹窗（order 2）之后。
    expect(registrations.filter((registration) => registration.name === 'conversation.input.overlay')).toEqual([
      expect.objectContaining({ name: 'conversation.input.overlay', id: 'minimax-video-form', order: 3 }),
    ])
    expect(registrations.filter((registration) => registration.name === 'tool.call.toolview')).toEqual([
      expect.objectContaining({ key: CODEX_IMAGE_TOOL_NAME }),
      expect.objectContaining({ key: ANTIGRAVITY_IMAGE_TOOL_NAME }),
      expect.objectContaining({ key: 'minimax_generate_video' }),
      expect.objectContaining({ key: 'progress_update' }),
    ])
    expect(document.querySelector('style[data-plugin="@eddyskywalker/dsh-chatgpt-subscription"]')).not.toBeNull()
    for (const dispose of disposers.reverse()) dispose()
  })

  it('hosts every subscription provider behind an overview hub in one settings page', async () => {
    const TAB_IDS = ['chatgpt', 'antigravity', 'command-code', 'kimi-code', 'minimax-code', 'glm-coding-plan', 'claude', 'ollama', 'step-code', 'cline-pass', 'qoder', 'opendesign'] as const
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
      if (url.startsWith('/glm-coding-plan/api')) {
        // GLM mounts under its own prefix like every sibling line, and reads one
        // /status carrying the whole card: pool, models, quota and the login flow.
        return Response.json({ ok: true, value: {
          enabled: true,
          authenticated: false,
          hasCredentials: false,
          providerId: 'glm-coding-plan',
          storagePath: 'DPAPI: /tmp/glm-credentials.json.dpapi',
          region: 'cn',
          account: null,
          quota: null,
          lastFetchedAt: null,
          models: [],
          contextWindowOverrides: {},
          defaultReasoningEffort: null,
          login: { status: 'idle' },
          accounts: [],
          rotationStrategy: 'sequential',
          serving: true,
          conflict: null,
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
      if (url.startsWith('/step-code/api')) {
        // Step Code mounts under its own prefix like every sibling line, and reads
        // one /status carrying the whole card: pool, models, quota, cache and the
        // login flow. Signed out with no quota here, so the card renders its empty
        // branches rather than a fake plan.
        return Response.json({ ok: true, value: {
          enabled: true,
          authenticated: false,
          hasCredentials: false,
          providerId: 'step-code',
          storagePath: 'DPAPI: /tmp/step-code-credentials.json.dpapi',
          profile: 'step_plan',
          account: null,
          quota: null,
          lastFetchedAt: null,
          models: [],
          contextWindowOverrides: {},
          defaultReasoningEffort: null,
          login: { status: 'idle' },
          accounts: [],
          rotationStrategy: 'sequential',
          cacheRequestParams: false,
          serving: true,
          conflict: null,
        } })
      }
      if (url.startsWith('/antigravity/api') || url.startsWith('/claude/api') || url.startsWith('/command-code/api') || url.startsWith('/kimi-code/api')) {
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
      expect(cards.map((card) => card.querySelector('.dsh-hub-card-name')?.textContent)).toEqual(['ChatGPT', 'Antigravity', 'Command Code', 'Kimi Code', 'MiniMax Code', 'GLM（ZCode 账号）', 'Claude', 'Ollama', 'Step Code（Step Plan 订阅）', 'Cline Pass', 'Qoder（订阅）', 'OpenDesign'])
      expect(container.querySelector('.dsh-hub-detail')).toBeNull()
      expect(container.querySelector('#dsh-codex-title')).toBeNull()
      // Every toggleable line renders a switch on its card; Ollama, which has
      // no enable switch on the host, renders none. Step Code joins the toggleable
      // side (it posts enabled to its own /settings like every other line).
      expect(container.querySelectorAll('.dsh-hub-card [role="switch"]')).toHaveLength(11)
      const ollamaCard = cards.find((card) => card.textContent?.includes('Ollama'))!
      expect(ollamaCard.querySelector('[role="switch"]')).toBeNull()
      // Annotations carry the account count from the aggregated overview.
      expect(cards[1]?.textContent).toContain('1 个账号')

      // Drilling in replaces the overview with that line's section, mounted
      // under the back bar; leaving the page means the section unmounts.
      for (const [index, apiPrefix] of [[1, '/antigravity/api/status'], [2, '/command-code/api/status'], [3, '/kimi-code/api/status'], [4, '/minimax-code/api/status'], [5, '/glm-coding-plan/api/status'], [6, '/claude/api/status']] as const) {
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
      await act(async () => { container.querySelectorAll<HTMLElement>('.dsh-hub-card')[4]?.click() })
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

    const errors: unknown[] = []
    ;(rootCtx as any).on('internal/error', (err: unknown) => { errors.push(err) })
    const fiber = rootCtx.plugin({
      inject,
      apply,
    })
    await fiber
    expect(errors).toEqual([])
    expect(fiber.state).toBe(2)
  })

  it('activates cleanly in a real Cordis Context when optional services (commandUi, remote.workspaceFiles, documentPreviews) are guarded Cordis Services', async () => {
    const { Context, Service } = await import('@deepseek-ai/cordis')
    const rootCtx = new Context()
    const errors: unknown[] = []
    ;(rootCtx as any).on('internal/error', (err: unknown) => { errors.push(err) })

    const slotRegistrations: Array<Record<string, unknown>> = []
    rootCtx.provide('slots', {
      inject: (_name: string, cb: () => () => void) => cb(),
      register: (options: Record<string, unknown>) => {
        slotRegistrations.push(options)
        return () => undefined
      },
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

    class MockRemoteService extends Service {
      constructor(ctx: any) {
        super(ctx, 'remote')
      }
    }
    class MockRemoteSessionService extends Service {
      constructor(ctx: any) {
        super(ctx, 'remote.session')
      }
    }
    class MockWorkspaceFilesService extends Service {
      constructor(ctx: any) {
        super(ctx, 'remote.workspaceFiles')
      }
      async readBytes(_sessionId: string, _path: string) {
        // 远端不抛异常：成功是 { ok: true, value }，字节在 value.data。
        return { ok: true as const, value: { data: new Uint8Array([1, 2, 3, 4]) } }
      }
    }
    const registeredCommands: unknown[] = []
    class MockCommandUiService extends Service {
      constructor(ctx: any) {
        super(ctx, 'commandUi')
      }
      register(contribution: unknown) {
        registeredCommands.push(contribution)
        return () => undefined
      }
    }
    const registeredPreviews: unknown[] = []
    class MockDocumentPreviewsService extends Service {
      constructor(ctx: any) {
        super(ctx, 'documentPreviews')
      }
      register(definition: unknown) {
        registeredPreviews.push(definition)
        return () => undefined
      }
    }

    await rootCtx.plugin(MockRemoteService)
    await rootCtx.plugin(MockRemoteSessionService)
    await rootCtx.plugin(MockWorkspaceFilesService)
    await rootCtx.plugin(MockCommandUiService)

    const fiber = rootCtx.plugin({
      inject,
      apply,
    })
    await fiber

    // Regression check: uninjected property reads (`ctx.commandUi`,
    // `ctx.remote.workspaceFiles`) on real Cordis Services throw synchronously in
    // `apply` and put the plugin fiber into state 3 (FAILED), which fails
    // `bootClient` with `web boot: 1 entry did not activate`.
    expect(errors).toEqual([])
    expect(fiber.state).toBe(2)
    expect(registeredCommands).toHaveLength(1)

    // `documentPreviews` typically activates AFTER this plugin in the browser
    // because `ui-sidebar-documentpreview` waits on extra services; late
    // mounting must still register the video preview definition.
    await rootCtx.plugin(MockDocumentPreviewsService)
    expect(registeredPreviews).toHaveLength(1)

    // And the video byte reader must resolve `remote.workspaceFiles` without
    // tripping Cordis's property guard. The tool card reads the file itself:
    // the conversation stream has no host-delivered bytes.
    const toolEntry = slotRegistrations.find(
      (entry) => entry.name === 'tool.call.toolview' && entry.key === 'minimax_generate_video',
    ) as { inject?: (sessionId: string) => { readVideo: (sessionId: string, path: string, signal?: AbortSignal) => Promise<Uint8Array> } } | undefined
    expect(toolEntry?.inject).toBeTypeOf('function')
    const { readVideo } = toolEntry!.inject!('s1')
    await expect(readVideo('s1', '/tmp/clip.mp4')).resolves.toEqual(new Uint8Array([1, 2, 3, 4]))

    // The sidebar body reads nothing: the Host already read the file (the
    // definition declares `loading: 'bytes-complete'`) and hands the bytes
    // down through the keyed slot's `content`.
    const docEntry = slotRegistrations.find(
      (entry) => entry.name === 'sidebar.right.tab.document',
    ) as { inject?: () => unknown } | undefined
    expect(docEntry?.inject).toBeUndefined()
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
