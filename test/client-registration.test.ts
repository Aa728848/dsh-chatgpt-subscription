// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { CODEX_IMAGE_TOOL_NAME } from '../src/compat.ts'
import { CodexSubscriptionSection, parseCapacity, storageLabel, storageNotice } from '../src/client/CodexSubscriptionSection.tsx'
import { SubagentSettingsSection, parseNonNegativeInteger, parsePositiveInteger } from '../src/client/SubagentSettingsSection.tsx'
import { apply } from '../src/client/index.tsx'
import { zh } from '../src/client/locales.ts'

describe('client registration', () => {
  it('parses context capacities within the GPT-5.6 provider limit', () => {
    expect(parseCapacity('128K')).toBe(128_000)
    expect(parseCapacity('256,000')).toBe(256_000)
    expect(parseCapacity('1M')).toBe(1_000_000)
    expect(parseCapacity('1000001')).toBeNull()
    expect(parseCapacity('128.5K')).toBe(128_500)
    expect(parseCapacity('invalid')).toBeNull()
  })

  it('validates subagent limits as safe integers', () => {
    expect(parseNonNegativeInteger('0')).toBe(0)
    expect(parseNonNegativeInteger('3')).toBe(3)
    expect(parseNonNegativeInteger('-1')).toBeNull()
    expect(parseNonNegativeInteger('4')).toBe(4)
    expect(parsePositiveInteger('8')).toBe(8)
    expect(parsePositiveInteger('0')).toBeNull()
    expect(parsePositiveInteger('1.5')).toBeNull()
  })

  it('keeps context options rendered while typing a numeric draft', async () => {
    const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/models')) return Response.json({ ok: true, value: {
        providers: [{ id: 'codex-chatgpt', name: 'Codex', models: [{ id: 'gpt-5.6-sol', name: '5.6 Sol', contextWindow: 272_000, maxContextWindow: 1_000_000, reasoning: { efforts: [{ id: 'medium', name: 'medium' }], defaultEffort: 'medium' } }] }],
        failures: [],
      } })
      const body = init?.body === undefined ? null : JSON.parse(String(init.body)) as { contextWindowOverrides?: { 'gpt-5.6-sol'?: number } }
      const contextWindow = body?.contextWindowOverrides?.['gpt-5.6-sol'] ?? 272_000
      const preferences = {
        quickQuotaVisible: false,
        searchProvider: 'dsh',
        subagentProvider: 'codex-chatgpt',
        subagentModel: 'gpt-5.6-sol',
        subagentReasoningEffort: 'medium',
        subagentContextWindow: 272_000,
        subagentMaxDepth: 3,
        subagentMaxAgents: 8,
        contextWindowOverrides: { 'gpt-5.6-sol': contextWindow, 'gpt-5.6-terra': 272_000, 'gpt-5.6-luna': 272_000 },
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
      const input = container.querySelector<HTMLInputElement>('input[aria-label="5.6 Sol 上下文窗口"]')
      expect(input).not.toBeNull()
      const modelChecks = container.querySelectorAll<HTMLInputElement>('.dsh-codex-models input[type="checkbox"]')
      expect(modelChecks).toHaveLength(7)
      expect(Array.from(modelChecks).filter(model => model.checked)).toHaveLength(3)
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '5')
        input!.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(input?.value).toBe('5')
      expect(container.querySelectorAll('.dsh-codex-context-row')).toHaveLength(3)
      const save = container.querySelector<HTMLButtonElement>('button[data-model="gpt-5.6-sol"]')
      expect(save).not.toBeNull()
      expect(save?.disabled).toBe(false)
      await act(async () => save?.click())
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ contextWindowOverrides: { 'gpt-5.6-sol': 5 } })
      expect(save?.disabled).toBe(true)
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
  it('renders global subagent model and limit controls on their own page', async () => {
    const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/models')) return Response.json({ ok: true, value: {
        providers: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'V4 Flash', contextWindow: 128_000, reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } }] }],
        failures: [],
      } })
      return Response.json({ ok: true, value: {
        authenticated: false,
        account: null,
        storage: { kind: 'memory', encrypted: false, available: true },
        login: { active: false, loginId: null, expiresAt: null },
        quota: { state: 'signed-out', buckets: [], credits: null, individualLimit: null, spendControlReached: null, resetCredits: null, fetchedAt: null, stale: false },
        preferences: {
          quickQuotaVisible: false,
          visibleModelIds: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
          searchProvider: 'dsh',
          subagentProvider: 'deepseek-official',
          subagentModel: 'deepseek-v4-flash',
          subagentReasoningEffort: 'high',
          subagentContextWindow: 128_000,
          subagentMaxDepth: 3,
          subagentMaxAgents: 8,
          contextWindowOverrides: { 'gpt-5.6-sol': 272_000, 'gpt-5.6-terra': 272_000, 'gpt-5.6-luna': 272_000 },
          writable: true,
        },
      } })
    }) as typeof fetch
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const t = ((key: keyof typeof zh) => zh[key]) as never
    try {
      await act(async () => root.render(createElement(SubagentSettingsSection, { t } as never)))
      expect(container.querySelector('#dsh-subagent-title')?.textContent).toBe('子代理设置')
      expect(container.querySelector<HTMLSelectElement>('select[aria-label="子代理 Provider"]')?.value).toBe('deepseek-official')
      expect(container.querySelector<HTMLInputElement>('#dsh-subagent-depth')?.value).toBe('3')
      expect(container.querySelector<HTMLInputElement>('#dsh-subagent-agents')?.value).toBe('8')
    } finally {
      await act(async () => root.unmount())
      container.remove()
      globalThis.fetch = originalFetch
      globalThis.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
    }
  })

  it('contributes separate top-level Subagents and Codex settings sections', () => {
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

    expect(injectedSlots).toEqual(['settings.section', 'settings.section', 'conversation.input.right', 'tool.call.toolview'])
    expect(registrations.filter((registration) => registration.name === 'settings.section')).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'settings.section', id: 'subagents', order: 30 }),
      expect.objectContaining({ name: 'settings.section', id: 'codex-subscription', order: 45 }),
    ]))
    expect(registrations.find((registration) => registration.name === 'tool.call.toolview')).toMatchObject({
      key: CODEX_IMAGE_TOOL_NAME,
    })
    expect(document.querySelector('style[data-plugin="@eddyskywalker/dsh-chatgpt-subscription"]')).not.toBeNull()
    for (const dispose of disposers.reverse()) dispose()
  })
})
