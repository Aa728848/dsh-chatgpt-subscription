// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ClaudeApiSection } from '../../../src/client/providers/claude-api/ClaudeApiSection.tsx'
import { formatCapacity } from '../../../src/client/common/format.ts'
import { dictionaries, en, NS_CLAUDE_API, zh } from '../../../src/client/providers/claude-api/locales.ts'
import { installClaudeApiStyles, STYLE_ID } from '../../../src/client/providers/claude-api/styles.ts'
import { dictionary as ru } from '../../../src/client/locales-ru/claude-api.ts'
import {
  CLAUDE_API_DEFAULT_BASE_URL,
  CLAUDE_API_PROVIDER_ID,
  type ClaudeApiClientVersionSource,
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
      if (typeof patch.contextWindowOverrides === 'object' && patch.contextWindowOverrides !== null) {
        const overrides = { ...current.contextWindowOverrides }
        for (const [id, value] of Object.entries(patch.contextWindowOverrides as Record<string, number | null>)) {
          if (value === null) delete overrides[id]
          else overrides[id] = value
        }
        current = { ...current, contextWindowOverrides: overrides }
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
      } else if (patch.action === 'delete') {
        const accounts = current.accounts.filter(account => account.id !== patch.accountId)
        if (accounts.length > 0 && !accounts.some(account => account.isPrimary)) accounts[0] = { ...accounts[0]!, isPrimary: true }
        const primary = accounts.find(entry => entry.isPrimary) ?? accounts[0]
        current = { ...current, accounts, authenticated: accounts.length > 0, activeAccountId: primary?.id, baseUrl: primary?.baseUrl ?? current.defaultBaseUrl }
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

  it('edits an account without resending its key, closes the form if that account is deleted, and validates invalid endpoints locally', async () => {
    const calls = mockFetch(status())
    await render()
    await click(buttonNamed(container, zh.editAccount))
    const key = container.querySelector<HTMLInputElement>('input[type="password"]')!
    expect(key.placeholder).toBe(zh.keyKeepPlaceholder)
    await type(key, '')
    await click(buttonNamed(container, zh.saveAccount))
    expect(calls.find(call => call.url.endsWith('/accounts'))?.body).not.toHaveProperty('apiKey')
    await click(buttonNamed(container, zh.editAccount))
    const endpoint = container.querySelector<HTMLInputElement>('input[aria-label="' + zh.endpoint + '"]')!
    const before = calls.filter(call => call.url.endsWith('/accounts')).length
    for (const [value, message] of [
      ['nonsense', zh.endpointErrorInvalid],
      ['ftp://gateway.example', zh.endpointErrorScheme],
      ['https://user:pw@gateway.example', zh.endpointErrorCredentials],
      ['https://gateway.example?a=1', zh.endpointErrorQuery],
      ['', zh.endpointErrorEmpty],
    ] as const) {
      await type(endpoint, value)
      await click(buttonNamed(container, zh.saveAccount))
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(message)
    }
    expect(calls.filter(call => call.url.endsWith('/accounts'))).toHaveLength(before)
    await click(buttonNamed(container, zh.deleteAccount))
    expect(container.querySelector('.dshca-account-form')).toBeNull()
  })

  it('submits all five request options independently, including both cache tiers and pricing notes', async () => {
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
    const details = container.querySelector<HTMLDetailsElement>('.dshca-options details.dshca-details')!
    expect(details.open).toBe(false)
    expect([...details.querySelectorAll('p')].map(note => note.textContent)).toEqual([zh.cacheTtlNote, zh.fastModeNote, zh.serverCompactionNote])
  })

  it('re-reads about 2 s and 6 s after account saves and catalog refreshes without waiting for the minute poll', async () => {
    useCardFakeTimers()
    let landed = false
    const calls = mockFetch(status({ authenticated: false, accounts: [], activeAccountId: undefined }), {
      background: () => landed ? { models: [...status().models, model('claude-opus-5', 'Claude Opus 5')] } : {},
    })
    await render()
    expect(statusReads(calls)).toBe(1)
    await click(buttonNamed(container, zh.addAccount))
    await type(container.querySelector<HTMLInputElement>('input[type="password"]')!, 'sk-ant-test')
    await click(buttonNamed(container, zh.saveAccount))
    expect(statusReads(calls)).toBe(1)
    landed = true
    await advance(1_999)
    expect(statusReads(calls)).toBe(1)
    await advance(1)
    expect(statusReads(calls)).toBe(2)
    expect(container.textContent).toContain('Claude Opus 5')
    await advance(4_000)
    expect(statusReads(calls)).toBe(3)
    await click(buttonNamed(container, zh.refreshCatalog))
    await advance(2_000)
    expect(statusReads(calls)).toBe(4)
  })

  it('drops a stale follow-up status that started before a newer option change and skips follow-ups while in flight', async () => {
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
    await advance(2_000)
    expect(statusReads(calls)).toBe(2)
    await click(container.querySelector<HTMLInputElement>('input[aria-label="' + zh.fastMode + '"]'))
    holdReads = false
    release()
    await act(async () => { await gate })
    expect(container.querySelector<HTMLInputElement>('input[aria-label="' + zh.fastMode + '"]')?.checked).toBe(true)
  })

  it('keeps an unsaved context draft across follow-up reads while adopting newly listed models', async () => {
    useCardFakeTimers()
    let landed = false
    const calls = mockFetch(status(), {
      background: () => landed ? { models: [...status().models, model('claude-opus-5', 'Claude Opus 5')] } : {},
    })
    await render()
    await click(buttonNamed(container.querySelector('.dshca-models')!, zh.refreshCatalog))
    const contextInputs = () => [...container.querySelectorAll<HTMLInputElement>('.dshca-context .dsha-context-row input')]
    await type(contextInputs()[0]!, '640K')
    landed = true
    await advance(2_000)
    expect(statusReads(calls)).toBe(2)
    expect(container.textContent).toContain('Claude Opus 5')
    expect(contextInputs().map(input => input.value)).toEqual(['640K', formatCapacity(1_000_000), formatCapacity(1_000_000)])
  })

  it('renders the client version, its source, and any pending update on one single line', async () => {
    const labels: Record<ClaudeApiClientVersionSource, string> = {
      env: zh.versionSourceEnv, npm: zh.versionSourceNpm, cached: zh.versionSourceCached, default: zh.versionSourceDefault,
    }
    for (const source of Object.keys(labels) as ClaudeApiClientVersionSource[]) {
      mockFetch(status({ clientVersion: { value: '2.1.330', source, fetchedAt: null, pending: null } }))
      await render()
      const value = container.querySelector('.dsha-row.dshca-version-row > .dsha-value')
      expect(value?.textContent).toBe('2.1.330 \u00b7 ' + labels[source])
      expect(value?.childElementCount).toBe(0)
      expect(value?.classList.contains('dshca-version')).toBe(true)
      await act(async () => root.unmount())
      root = createRoot(container)
    }
    mockFetch(status({ clientVersion: { value: '2.1.330', source: 'npm', fetchedAt: 1, pending: '2.2.0' } }))
    await render()
    expect(container.querySelector('.dsha-row.dshca-version-row > .dsha-value')?.textContent)
      .toBe('2.1.330 \u00b7 ' + zh.versionSourceNpm + ' \u00b7 ' + zh.versionPending.replace('{version}', '2.2.0'))
  })

  it('commits an explicit all-off model selection through the shared checklist', async () => {
    const calls = mockFetch(status())
    await render()
    await click(buttonNamed(container, zh.clearAll))
    expect(settingsBodies(calls)).toContain('{"enabledModelIds":[]}')
  })

  it('keeps zh, en and ru on one non-empty key set under the line namespace', () => {
    const keys = Object.keys(zh).sort()
    expect(Object.keys(en).sort()).toEqual(keys)
    expect(Object.keys(ru).sort()).toEqual(keys)
    expect(dictionaries).toEqual({ zh, en })
    expect(NS_CLAUDE_API).toBe('dsh-claude-api')
    for (const dict of [zh, en, ru] as Record<string, string>[]) {
      for (const key of keys) expect(dict[key]!.trim()).not.toBe('')
    }
  })

  it('pins the account form grid, style ownership and shared-class boundary', () => {
    installClaudeApiStyles()
    const style = document.getElementById(STYLE_ID)
    expect(style?.textContent).toContain('grid-template-columns:minmax(0,1fr) auto auto')
    expect(style?.textContent).toContain('.dshca-account-form')
    expect(style?.textContent).not.toMatch(/(^|[},])\s*\.dsha-/m)
    expect(style?.getAttribute('data-plugin-css')).toBe('@eddyskywalker/dsh-chatgpt-subscription/claude-api')
  })
})

describe('Claude API cache-duration keepalive wording', () => {
  it('explains the 1h wait keepalive in zh, en and ru', () => {
    expect(zh.cacheTtlNote).toContain('55')
    expect(zh.cacheTtlNote).toContain('\u5b50\u4ee3\u7406')
    expect(zh.cacheTtlNote).toContain('\u540e\u53f0')
    expect(zh.cacheTtlNote).toContain('5 \u5206\u949f')
    expect(en.cacheTtlNote).toContain('55 minutes')
    expect(en.cacheTtlNote).toContain('subagents or background tasks')
    expect(en.cacheTtlNote).toContain('5-minute duration never does this')
    expect(ru.cacheTtlNote).toContain('55')
    expect(ru.cacheTtlNote).toContain('\u0441\u0443\u0431\u0430\u0433\u0435\u043d\u0442')
    expect(ru.cacheTtlNote).toContain('\u0444\u043e\u043d\u043e\u0432')
    expect(ru.cacheTtlNote).toContain('5 \u043c\u0438\u043d\u0443\u0442')
  })
})
