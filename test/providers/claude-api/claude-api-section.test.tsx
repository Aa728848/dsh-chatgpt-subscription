// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ClaudeApiSection } from '../../../src/client/providers/claude-api/ClaudeApiSection.tsx'
import { dictionaries, en, NS_CLAUDE_API, zh } from '../../../src/client/providers/claude-api/locales.ts'
import { installClaudeApiStyles, STYLE_ID } from '../../../src/client/providers/claude-api/styles.ts'
import { dictionary as ru } from '../../../src/client/locales-ru/claude-api.ts'
import {
  CLAUDE_API_DEFAULT_BASE_URL,
  CLAUDE_API_PROVIDER_ID,
  type ClaudeApiModelDto,
  type ClaudeApiStatusDto,
} from '../../../src/shared/claude-api-contracts.ts'

function model(id: string, name: string, enabled = true): ClaudeApiModelDto {
  return {
    id, name, hint: '1M / 128K', enabled, contextWindow: 1_000_000, defaultContextWindow: 1_000_000, maxOutputTokens: 128_000,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], supportsImages: true, supportsFastMode: false, supportsServerCompaction: true,
  }
}
function status(overrides: Partial<ClaudeApiStatusDto> = {}): ClaudeApiStatusDto {
  return {
    providerId: CLAUDE_API_PROVIDER_ID, enabled: true, authenticated: true, storagePath: 'encrypted',
    baseUrl: CLAUDE_API_DEFAULT_BASE_URL, defaultBaseUrl: CLAUDE_API_DEFAULT_BASE_URL,
    accounts: [{ id: 'acc_primary', alias: 'Primary', isPrimary: true, baseUrl: CLAUDE_API_DEFAULT_BASE_URL }],
    activeAccountId: 'acc_primary', rotationStrategy: 'sequential',
    models: [model('claude-fable-5-2', 'Claude Fable 5.2'), model('claude-haiku-5-5', 'Claude Haiku 5.5')],
    contextWindowOverrides: {}, defaultReasoningEffort: null, cacheTtl: '5m', subagentCacheTtl: '5m',
    fastMode: false, serverCompaction: true, autoCompactSubagents: true,
    clientVersion: { value: '2.1.330', source: 'npm', fetchedAt: 1, pending: null },
    catalog: { state: 'ready', fetchedAt: 1, error: null }, serving: true, conflict: null,
    ...overrides,
  }
}
interface Call { url: string; method: string; body?: unknown }
interface MockOptions {
  accountAnswer?: unknown
  background?: () => Partial<ClaudeApiStatusDto>
  hold?: (url: string, method: string) => Promise<void> | undefined
}
let container: HTMLDivElement
let root: Root
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
  vi.useRealTimers()
})
function mockFetch(initial: ClaudeApiStatusDto, options: MockOptions = {}) {
  let current = initial
  const calls: Call[] = []
  const respond = (input: RequestInfo | URL, init?: RequestInit): Response => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    let body: unknown
    if (typeof init?.body === 'string') body = JSON.parse(init.body)
    calls.push({ url, method, ...(body === undefined ? {} : { body }) })
    if (url.endsWith('/settings') && typeof body === 'object' && body !== null) {
      const patch = body as Record<string, unknown>
      current = { ...current, ...patch } as ClaudeApiStatusDto
      if (Array.isArray(patch.enabledModelIds)) {
        const selected = patch.enabledModelIds as string[]
        current = { ...current, models: current.models.map(entry => ({ ...entry, enabled: selected.includes(entry.id) })) }
      }
      return Response.json({ ok: true, value: current })
    }
    if (url.endsWith('/accounts') && typeof body === 'object' && body !== null) {
      const patch = body as Record<string, unknown>
      if (patch.action === 'save') {
        const accountId = typeof patch.accountId === 'string' ? patch.accountId : 'acc_' + (current.accounts.length + 1)
        const previous = current.accounts.find(account => account.id === accountId)
        const account = {
          id: accountId,
          alias: typeof patch.alias === 'string' && patch.alias ? patch.alias : previous?.alias ?? 'Account ' + current.accounts.length,
          isPrimary: previous?.isPrimary ?? current.accounts.length === 0,
          baseUrl: String(patch.baseUrl),
        }
        const accounts = previous === undefined ? [...current.accounts, account] : current.accounts.map(entry => entry.id === accountId ? account : entry)
        const primary = accounts.find(entry => entry.isPrimary) ?? accounts[0]
        current = { ...current, accounts, authenticated: accounts.length > 0, activeAccountId: current.activeAccountId ?? accountId, baseUrl: primary?.baseUrl ?? current.baseUrl }
      } else if (patch.action === 'set-primary') {
        const accounts = current.accounts.map(account => ({ ...account, isPrimary: account.id === patch.accountId }))
        current = { ...current, accounts, activeAccountId: String(patch.accountId), baseUrl: accounts.find(account => account.isPrimary)?.baseUrl ?? current.baseUrl }
      } else if (patch.action === 'strategy') {
        current = { ...current, rotationStrategy: patch.strategy as ClaudeApiStatusDto['rotationStrategy'] }
      }
      return Response.json({ ok: true, value: 'accountAnswer' in options ? options.accountAnswer : current })
    }
    if (url.endsWith('/test')) return Response.json({ ok: true, value: { connected: true, latencyMs: 1, checkedAt: 1, modelCount: current.models.length } })
    if (url.endsWith('/status') && options.background !== undefined) current = { ...current, ...options.background() }
    if (url.includes('/claude-api/api/')) return Response.json({ ok: true, value: current })
    return Response.json({ ok: true, value: { lineProxies: {}, noProxy: null, detectedProxy: null, activeProxies: {} } })
  }
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = respond(input, init)
    await options.hold?.(String(input), init?.method ?? 'GET')
    return response
  }) as typeof fetch
  return calls
}
async function render() { await act(async () => root.render(createElement(ClaudeApiSection))) }
async function click(element: Element | null | undefined) {
  expect(element).toBeInstanceOf(HTMLElement)
  await act(async () => (element as HTMLElement).click())
}
async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function select(input: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('change', { bubbles: true })) })
}
const buttonNamed = (scope: ParentNode, text: string) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)
const statusReads = (calls: Call[]) => calls.filter(call => call.url.endsWith('/status')).length
const settingsBodies = (calls: Call[]) => calls.filter(call => call.url.endsWith('/settings')).map(call => JSON.stringify(call.body))
const useCardFakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

describe('Claude API account-pool settings section', () => {
  it('uses the shared account card and preserves the existing sections', async () => {
    mockFetch(status())
    await render()
    const groups = [...container.querySelectorAll('.dsha-page > section.dsha-group')]
    expect(groups).toHaveLength(6)
    expect(groups[0]!.querySelector('.dsha-grouphead h3')?.textContent).toContain(zh.title)
    expect(buttonNamed(groups[0]!, zh.addAccount)).not.toBeUndefined()
    expect(container.textContent).toContain('Claude Fable 5.2')
    expect(container.textContent).toContain('1M / 128K')
    expect(container.textContent).toContain('2.1.330')
    expect(container.textContent).not.toContain(zh.accountQuota)
  })

  it('opens an empty-state form and posts a normalized endpoint with its own key', async () => {
    const calls = mockFetch(status({ authenticated: false, accounts: [], activeAccountId: undefined }))
    await render()
    expect(container.textContent).toContain(zh.noAccounts)
    await click(buttonNamed(container, zh.addAccount))
    await type(container.querySelector<HTMLInputElement>('input[aria-label="' + zh.accountAlias + '"]')!, 'Main')
    await type(container.querySelector<HTMLInputElement>('input[aria-label="' + zh.endpoint + '"]')!, 'https://gw.example/api/v1/')
    await type(container.querySelector<HTMLInputElement>('input[type="password"]')!, '  sk-ant-test  ')
    await click(buttonNamed(container, zh.saveAccount))
    expect(calls.find(call => call.url.endsWith('/accounts'))?.body).toEqual({
      action: 'save', alias: 'Main', baseUrl: 'https://gw.example/api', apiKey: 'sk-ant-test',
    })
    expect(container.querySelector('input[type="password"]')).toBeNull()
  })

  it('edits an account without resending its key and rejects an invalid endpoint locally', async () => {
    const calls = mockFetch(status())
    await render()
    await click(buttonNamed(container, zh.editAccount))
    const key = container.querySelector<HTMLInputElement>('input[type="password"]')!
    expect(key.placeholder).toBe(zh.keyKeepPlaceholder)
    await type(key, '')
    await click(buttonNamed(container, zh.saveAccount))
    expect(calls.find(call => call.url.endsWith('/accounts'))?.body).not.toHaveProperty('apiKey')
    await click(buttonNamed(container, zh.editAccount))
    await type(container.querySelector<HTMLInputElement>('input[aria-label="' + zh.endpoint + '"]')!, 'nonsense')
    const before = calls.filter(call => call.url.endsWith('/accounts')).length
    await click(buttonNamed(container, zh.saveAccount))
    expect(calls.filter(call => call.url.endsWith('/accounts'))).toHaveLength(before)
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(zh.endpointErrorInvalid)
  })

  it('submits all five request options independently, including both cache tiers', async () => {
    const calls = mockFetch(status())
    await render()
    const selects = container.querySelectorAll<HTMLSelectElement>('.dshca-options select')
    await select(selects[0]!, '1h')
    await select(selects[1]!, '1h')
    for (const label of [zh.fastMode, zh.serverCompaction, zh.autoCompactSubagents]) {
      await click(container.querySelector<HTMLInputElement>('input[aria-label="' + label + '"]'))
    }
    expect(settingsBodies(calls)).toEqual([
      '{"cacheTtl":"1h"}', '{"subagentCacheTtl":"1h"}', '{"fastMode":true}', '{"serverCompaction":false}', '{"autoCompactSubagents":false}',
    ])
  })

  it('re-reads after account saves and catalog refreshes without waiting for the minute poll', async () => {
    useCardFakeTimers()
    const calls = mockFetch(status({ authenticated: false, accounts: [], activeAccountId: undefined }))
    await render()
    expect(statusReads(calls)).toBe(1)
    await click(buttonNamed(container, zh.addAccount))
    await type(container.querySelector<HTMLInputElement>('input[type="password"]')!, 'sk-ant-test')
    await click(buttonNamed(container, zh.saveAccount))
    await advance(400)
    expect(statusReads(calls)).toBe(2)
    await advance(1600)
    expect(statusReads(calls)).toBe(3)
    await click(buttonNamed(container, zh.refreshCatalog))
    await advance(400)
    expect(statusReads(calls)).toBe(4)
  })

  it('drops a stale follow-up status that started before a newer option change', async () => {
    useCardFakeTimers()
    let release!: () => void
    let holdReads = false
    const gate = new Promise<void>(resolve => { release = resolve })
    const calls = mockFetch(status({ authenticated: false, accounts: [], activeAccountId: undefined }), {
      hold: (url, method) => holdReads && method === 'GET' && url.endsWith('/status') ? gate : undefined,
    })
    await render()
    await click(buttonNamed(container, zh.addAccount))
    await type(container.querySelector<HTMLInputElement>('input[type="password"]')!, 'sk-ant-test')
    await click(buttonNamed(container, zh.saveAccount))
    holdReads = true
    await advance(400)
    expect(statusReads(calls)).toBe(2)
    await click(container.querySelector<HTMLInputElement>('input[aria-label="' + zh.fastMode + '"]'))
    holdReads = false
    release()
    await act(async () => { await gate })
    expect(container.querySelector<HTMLInputElement>('input[aria-label="' + zh.fastMode + '"]')?.checked).toBe(true)
  })

  it('keeps an unsaved context draft across a quiet status read', async () => {
    const calls = mockFetch(status())
    await render()
    const input = container.querySelector<HTMLInputElement>('.dshca-context input')!
    await type(input, '256K')
    await act(async () => { await globalThis.fetch('/claude-api/api/status') })
    expect(calls.some(call => call.url.endsWith('/status'))).toBe(true)
    expect(input.value).toBe('256K')
  })

  it('commits an explicit all-off model selection through the shared checklist', async () => {
    const calls = mockFetch(status())
    await render()
    await click(buttonNamed(container, zh.clearAll))
    expect(settingsBodies(calls)).toContain('{"enabledModelIds":[]}')
  })

  it('keeps zh, en and ru on one key set under the line namespace', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    expect(Object.keys(ru).sort()).toEqual(Object.keys(zh).sort())
    expect(dictionaries).toEqual({ zh, en })
    expect(NS_CLAUDE_API).toBe('dsh-claude-api')
  })

  it('pins the account form grid, style ownership and shared-class boundary', () => {
    installClaudeApiStyles()
    const style = document.getElementById(STYLE_ID)
    expect(style?.textContent).toContain('grid-template-columns:minmax(0,1fr) auto auto')
    expect(style?.textContent).toContain('.dshca-account-form')
    expect(style?.textContent).not.toMatch(/^.dsha-/m)
  })
})
