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
    models: [model('claude-fable-5-2', 'Claude Fable 5.2'), model('claude-haiku-5-5', 'Claude Haiku 5.5')],
    contextWindowOverrides: {}, defaultReasoningEffort: null, cacheTtl: '5m', fastMode: false, serverCompaction: true,
    clientVersion: { value: '2.1.330', source: 'npm', fetchedAt: 1, pending: null },
    catalog: { state: 'ready', fetchedAt: 1, error: null },
    serving: true, conflict: null,
    ...overrides,
  }
}
interface Call { url: string; method: string; body?: unknown }
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
})
interface MockOptions {
  keyAnswer?: unknown
  background?: () => Partial<ClaudeApiStatusDto>
  /** Keeps one answer back; the answer itself is still built from the state at request time. */
  hold?: (url: string, method: string) => Promise<void> | undefined
}
function deferred() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
function mockFetch(initial: ClaudeApiStatusDto, options: MockOptions = {}) {
  let current = initial
  const calls: Call[] = []
  const respond = (input: RequestInfo | URL, init?: RequestInit): Response => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    let body: unknown
    if (typeof init?.body === 'string') body = JSON.parse(init.body)
    calls.push({ url, method, ...(body === undefined ? {} : { body }) })
    if (url.endsWith('/claude-api/api/settings') && typeof body === 'object' && body !== null) {
      const patch = body as Record<string, unknown>
      if (Array.isArray(patch.enabledModelIds)) {
        const selected = patch.enabledModelIds as string[]
        current = { ...current, models: current.models.map(entry => ({ ...entry, enabled: selected.includes(entry.id) })) }
      }
      if ('baseUrl' in patch) current = { ...current, baseUrl: typeof patch.baseUrl === 'string' ? patch.baseUrl : current.defaultBaseUrl }
      if (patch.cacheTtl === '5m' || patch.cacheTtl === '1h') current = { ...current, cacheTtl: patch.cacheTtl }
      if (typeof patch.fastMode === 'boolean') current = { ...current, fastMode: patch.fastMode }
      if (typeof patch.serverCompaction === 'boolean') current = { ...current, serverCompaction: patch.serverCompaction }
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
    if (url.endsWith('/claude-api/api/key')) {
      current = { ...current, authenticated: method !== 'DELETE' }
      return Response.json({ ok: true, value: 'keyAnswer' in options ? options.keyAnswer : current })
    }
    // What the host's background catalog refresh has produced by the time of this read.
    if (url.endsWith('/claude-api/api/status') && options.background !== undefined) current = { ...current, ...options.background() }
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
async function render() {
  await act(async () => root.render(createElement(ClaudeApiSection)))
}
const settingsBodies = (calls: Call[]): string[] => calls.filter(call => call.url.endsWith('/claude-api/api/settings')).map(call => JSON.stringify(call.body))
async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function click(element: Element | null | undefined) {
  expect(element).toBeInstanceOf(HTMLElement)
  await act(async () => (element as HTMLElement).click())
}
const buttonNamed = (scope: ParentNode, text: string) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)
const statusReads = (calls: Call[]): number => calls.filter(call => call.url.endsWith('/claude-api/api/status')).length
// Only the timers the card itself arms are faked, so fetch and React keep their own scheduling.
const useCardFakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

describe('Claude API settings section', () => {
  it('uses the shared card skeleton with exactly two account heading actions', async () => {
    mockFetch(status())
    await render()
    const page = container.querySelector('.dsha-page.dshca-page[data-provider="claude-api"]')
    expect(page).not.toBeNull()
    const groups = [...page!.querySelectorAll(':scope > section.dsha-group')]
    expect(groups.map(group => group.className.replace('dsha-group', '').trim() || group.getAttribute('data-line-proxy'))).toEqual([
      'dshca-account', 'dshca-models', 'dshca-reasoning', 'dshca-options', 'dshca-context', 'claude-api',
    ])
    for (const group of groups) expect(group.querySelector(':scope > .dsha-grouphead > h3')).not.toBeNull()
    const actions = [...container.querySelectorAll('.dshca-account .dsha-grouphead button')].map(button => button.textContent)
    expect(actions).toEqual([zh.testConnection, zh.removeKey])
    expect(container.querySelectorAll('.dshca-account > p.dsha-muted')).toHaveLength(2)
    expect(container.querySelectorAll('.dshca-account > .dsha-empty')).toHaveLength(1)
    expect(container.textContent).toContain('Claude Fable 5.2')
    expect(container.textContent).toContain('1M / 128K')
  })
  it('hides the remove action until a key is stored', async () => {
    mockFetch(status({ authenticated: false }))
    await render()
    expect([...container.querySelectorAll('.dshca-account .dsha-grouphead button')].map(button => button.textContent)).toEqual([zh.testConnection])
    expect(container.textContent).toContain(zh.keyMissing)
  })
  it('keeps the key field on a full-width row and posts { apiKey } to the key route', async () => {
    const calls = mockFetch(status({ authenticated: false }))
    await render()
    const row = container.querySelector('.dshca-account > .dshca-key-row')
    expect(row).not.toBeNull()
    expect(row!.closest('.dsha-pref-row')).toBeNull()
    const input = row!.querySelector<HTMLInputElement>('input[type="password"]')!
    expect(row!.children).toHaveLength(2)
    await type(input, '  sk-ant-test  ')
    await click(row!.querySelector('button'))
    expect(calls.filter(call => call.url.endsWith('/key'))).toEqual([{ url: '/claude-api/api/key', method: 'POST', body: { apiKey: 'sk-ant-test' } }])
    expect(input.value).toBe('')
    await click(buttonNamed(container, zh.removeKey))
    expect(calls.filter(call => call.url.endsWith('/key')).at(-1)).toEqual({ url: '/claude-api/api/key', method: 'DELETE' })
    expect(container.querySelector('.dshca-account > .dshca-key-row input[type="password"]')).not.toBeNull()
  })
  it('re-reads the status when the key route does not answer with one', async () => {
    const calls = mockFetch(status({ authenticated: false }), { keyAnswer: {} })
    await render()
    const row = container.querySelector('.dshca-key-row')!
    await type(row.querySelector<HTMLInputElement>('input')!, 'sk-ant-test')
    await click(row.querySelector('button'))
    expect(calls.at(-1)).toEqual({ url: '/claude-api/api/status', method: 'GET' })
    expect(container.textContent).toContain(zh.keyConfigured)
  })
  it('re-reads the status about 2 s and 6 s after a key save, so the background catalog shows up without the 60 s poll', async () => {
    useCardFakeTimers()
    try {
      let landed = false
      const calls = mockFetch(status({ authenticated: false }), {
        background: () => landed ? { models: [...status().models, model('claude-opus-5', 'Claude Opus 5')] } : {},
      })
      await render()
      expect(statusReads(calls)).toBe(1)
      const row = container.querySelector('.dshca-key-row')!
      await type(row.querySelector<HTMLInputElement>('input')!, 'sk-ant-test')
      await click(row.querySelector('button'))
      // The key route answered with a status (the built-in table); nothing was re-read yet.
      expect(statusReads(calls)).toBe(1)
      expect(container.textContent).not.toContain('Claude Opus 5')
      landed = true
      await advance(1_999)
      expect(statusReads(calls)).toBe(1)
      await advance(1)
      expect(statusReads(calls)).toBe(2)
      expect(container.textContent).toContain('Claude Opus 5')
      await advance(3_999)
      expect(statusReads(calls)).toBe(2)
      await advance(1)
      expect(statusReads(calls)).toBe(3)
      // Two follow-ups, then silence until the regular poll.
      await advance(30_000)
      expect(statusReads(calls)).toBe(3)
    } finally { vi.useRealTimers() }
  })
  it('schedules the same follow-up reads after an endpoint save, an endpoint restore and a catalog refresh, restarts them on a new change and drops them on unmount', async () => {
    useCardFakeTimers()
    try {
      const calls = mockFetch(status())
      await render()
      expect(statusReads(calls)).toBe(1)
      const row = container.querySelector('.dshca-account .dsha-pref-row.dshca-endpoint-row')!
      const [save, restore] = [...row.querySelectorAll<HTMLButtonElement>('button')]
      const refresh = buttonNamed(container.querySelector('.dshca-models')!, zh.refreshCatalog)

      // A refused endpoint never reached the host, so there is nothing to follow up.
      await type(row.querySelector<HTMLInputElement>('input')!, 'ftp://gateway.example')
      await click(save)
      await advance(7_000)
      expect(statusReads(calls)).toBe(1)

      await type(row.querySelector<HTMLInputElement>('input')!, 'https://gateway.example')
      await click(save)
      expect(settingsBodies(calls)).toEqual(['{"baseUrl":"https://gateway.example"}'])
      await advance(2_000)
      expect(statusReads(calls)).toBe(2)
      await advance(4_000)
      expect(statusReads(calls)).toBe(3)

      await click(restore)
      expect(settingsBodies(calls).at(-1)).toBe('{"baseUrl":null}')
      await advance(2_000)
      expect(statusReads(calls)).toBe(4)
      await advance(4_000)
      expect(statusReads(calls)).toBe(5)

      await click(refresh)
      expect(calls.at(-1)).toEqual({ url: '/claude-api/api/catalog/refresh', method: 'POST', body: {} })
      await advance(2_000)
      expect(statusReads(calls)).toBe(6)
      // A second refresh before the 6 s read replaces the pending one instead of stacking on it.
      await click(refresh)
      await advance(2_000)
      expect(statusReads(calls)).toBe(7)
      await advance(2_000)
      expect(statusReads(calls)).toBe(7)
      await advance(2_000)
      expect(statusReads(calls)).toBe(8)

      // A plain option change is answered with the final state: no follow-up.
      await click(container.querySelector('.dshca-options input[type="checkbox"]'))
      await advance(7_000)
      expect(statusReads(calls)).toBe(8)

      await click(refresh)
      await act(async () => root.unmount())
      root = createRoot(container)
      await advance(10_000)
      expect(statusReads(calls)).toBe(8)
    } finally { vi.useRealTimers() }
  })
  it('keeps an unsaved context-window draft and an unsaved endpoint draft across the follow-up reads, and still takes their result', async () => {
    useCardFakeTimers()
    try {
      let landed = false
      const calls = mockFetch(status(), {
        background: () => landed ? { models: [...status().models, model('claude-opus-5', 'Claude Opus 5')] } : {},
      })
      await render()
      await click(buttonNamed(container.querySelector('.dshca-models')!, zh.refreshCatalog))
      const contextInputs = () => [...container.querySelectorAll<HTMLInputElement>('.dshca-context .dsha-context-row input')]
      const endpointInput = () => container.querySelector<HTMLInputElement>('.dshca-endpoint-row input')!
      await type(contextInputs()[0], '640K')
      await type(endpointInput(), 'https://draft.example')
      landed = true
      await advance(2_000)
      expect(statusReads(calls)).toBe(2)
      expect(container.textContent).toContain('Claude Opus 5')
      // The typed row survives; untouched rows, the new model's included, are seeded from the fresh status.
      expect(contextInputs().map(input => input.value)).toEqual(['640K', formatCapacity(1_000_000), formatCapacity(1_000_000)])
      expect(endpointInput().value).toBe('https://draft.example')
      await advance(4_000)
      expect(statusReads(calls)).toBe(3)
      expect(contextInputs()[0].value).toBe('640K')
      expect(endpointInput().value).toBe('https://draft.example')
    } finally { vi.useRealTimers() }
  })
  it('drops a follow-up answer that started before a later change, so the newer result stays on screen', async () => {
    useCardFakeTimers()
    try {
      const gate = deferred()
      let holdReads = false
      const calls = mockFetch(status(), { hold: url => holdReads && url.endsWith('/claude-api/api/status') ? gate.promise : undefined })
      await render()
      await click(buttonNamed(container.querySelector('.dshca-models')!, zh.refreshCatalog))
      holdReads = true
      await advance(2_000)
      // In flight now, carrying the state from before the change below.
      expect(statusReads(calls)).toBe(2)
      const firstModel = () => container.querySelector('.dshca-models [role="checkbox"]')!
      expect(firstModel().getAttribute('aria-checked')).toBe('true')
      await click(firstModel())
      expect(settingsBodies(calls)).toEqual(['{"enabledModelIds":["claude-haiku-5-5"]}'])
      expect(firstModel().getAttribute('aria-checked')).toBe('false')
      await act(async () => gate.release())
      expect(firstModel().getAttribute('aria-checked')).toBe('false')
      holdReads = false
      await advance(4_000)
      expect(statusReads(calls)).toBe(3)
      expect(firstModel().getAttribute('aria-checked')).toBe('false')
    } finally { vi.useRealTimers() }
  })
  it('drops the answer of an older change when it arrives after a newer one', async () => {
    const gate = deferred()
    let settingsPosts = 0
    const calls = mockFetch(status(), { hold: url => url.endsWith('/claude-api/api/settings') && settingsPosts++ === 0 ? gate.promise : undefined })
    await render()
    const rows = () => [...container.querySelectorAll('.dshca-context .dsha-context-row')]
    const resetDisabled = () => rows().map(row => row.querySelector<HTMLButtonElement>('.dsha-context-reset')!.disabled)
    const saveRow = async (index: number, value: string) => {
      await type(rows()[index].querySelector<HTMLInputElement>('input')!, value)
      await click(rows()[index].querySelector('.dsha-context-save:not(.dsha-context-reset)'))
    }
    expect(resetDisabled()).toEqual([true, true])
    await saveRow(0, '500000')
    await saveRow(1, '300000')
    expect(settingsBodies(calls)).toEqual([
      '{"contextWindowOverrides":{"claude-fable-5-2":500000}}', '{"contextWindowOverrides":{"claude-haiku-5-5":300000}}',
    ])
    expect(resetDisabled()).toEqual([false, false])
    // The first answer was built before the second override existed.
    await act(async () => gate.release())
    expect(resetDisabled()).toEqual([false, false])
  })
  it('skips a follow-up read while another request of the card is still in flight', async () => {
    useCardFakeTimers()
    try {
      const gate = deferred()
      const calls = mockFetch(status(), { hold: url => url.endsWith('/claude-api/api/test') ? gate.promise : undefined })
      await render()
      await click(buttonNamed(container.querySelector('.dshca-models')!, zh.refreshCatalog))
      await click(buttonNamed(container.querySelector('.dshca-account')!, zh.testConnection))
      expect(calls.at(-1)).toEqual({ url: '/claude-api/api/test', method: 'POST', body: {} })
      await advance(2_000)
      expect(statusReads(calls)).toBe(1)
      // The connection test reads the status itself once it is answered.
      await act(async () => gate.release())
      expect(statusReads(calls)).toBe(2)
      await advance(4_000)
      expect(statusReads(calls)).toBe(3)
    } finally { vi.useRealTimers() }
  })
  it('posts the normalized endpoint, refuses an invalid one with its reason, and restores the default with null', async () => {
    const calls = mockFetch(status())
    await render()
    const row = container.querySelector('.dshca-account .dsha-pref-row.dshca-endpoint-row')!
    const input = row.querySelector<HTMLInputElement>('input')!
    const [save, restore] = [...row.querySelectorAll<HTMLButtonElement>('button')]
    expect(row.querySelectorAll('button')).toHaveLength(2)
    expect(input.value).toBe(CLAUDE_API_DEFAULT_BASE_URL)
    expect(save.disabled).toBe(true)
    expect(restore.disabled).toBe(true)

    await type(input, 'ftp://gateway.example')
    await click(save)
    expect(settingsBodies(calls)).toEqual([])
    expect(container.querySelector('.dshca-endpoint-error')?.textContent).toBe(zh.endpointErrorScheme)
    await type(input, 'https://user:pw@gateway.example')
    await click(save)
    expect(container.querySelector('.dshca-endpoint-error')?.textContent).toBe(zh.endpointErrorCredentials)
    await type(input, '')
    await click(save)
    expect(container.querySelector('.dshca-endpoint-error')?.textContent).toBe(zh.endpointErrorEmpty)
    expect(settingsBodies(calls)).toEqual([])

    await type(input, '  http://gateway.example:8080/proxy/v1/  ')
    expect(container.querySelector('.dshca-endpoint-error')).toBeNull()
    await click(save)
    expect(settingsBodies(calls)).toEqual(['{"baseUrl":"http://gateway.example:8080/proxy"}'])
    expect(input.value).toBe('http://gateway.example:8080/proxy')

    expect(restore.disabled).toBe(false)
    await click(restore)
    expect(settingsBodies(calls).at(-1)).toBe('{"baseUrl":null}')
    expect(input.value).toBe(CLAUDE_API_DEFAULT_BASE_URL)
  })
  it('renders the client version and its source as one single-line value', async () => {
    const labels: Record<ClaudeApiClientVersionSource, string> = {
      env: zh.versionSourceEnv, npm: zh.versionSourceNpm, cached: zh.versionSourceCached, default: zh.versionSourceDefault,
    }
    for (const source of Object.keys(labels) as ClaudeApiClientVersionSource[]) {
      mockFetch(status({ clientVersion: { value: '2.1.330', source, fetchedAt: null, pending: null } }))
      await render()
      const value = container.querySelector('.dshca-account > .dsha-row.dshca-version-row > .dsha-value')
      expect(value?.textContent).toBe('2.1.330 \u00b7 ' + labels[source])
      expect(value?.childElementCount).toBe(0)
      expect(value?.classList.contains('dshca-version')).toBe(true)
      await act(async () => root.unmount())
      root = createRoot(container)
    }
    installClaudeApiStyles()
    expect(document.getElementById(STYLE_ID)?.textContent).toMatch(/\.dshca-version\{[^}]*white-space:nowrap/)
  })
  it('appends the pending-version note on the same single line only when pending is set', async () => {
    mockFetch(status({ clientVersion: { value: '2.1.330', source: 'npm', fetchedAt: 1, pending: '2.2.0' } }))
    await render()
    const value = container.querySelector('.dshca-account > .dsha-row.dshca-version-row > .dsha-value')
    expect(value?.textContent).toBe('2.1.330 \u00b7 ' + zh.versionSourceNpm + ' \u00b7 ' + zh.versionPending.replace('{version}', '2.2.0'))
    expect(value?.childElementCount).toBe(0)
    await act(async () => root.unmount())
    root = createRoot(container)
    mockFetch(status())
    await render()
    const plain = container.querySelector('.dshca-account > .dsha-row.dshca-version-row > .dsha-value')
    expect(plain?.textContent).toBe('2.1.330 \u00b7 ' + zh.versionSourceNpm)
  })
  it('posts exactly one field for each request option', async () => {
    const calls = mockFetch(status())
    await render()
    const options = container.querySelector('.dshca-options')!
    const select = options.querySelector<HTMLSelectElement>('select')!
    expect([...select.options].map(option => option.value)).toEqual(['5m', '1h'])
    await act(async () => { select.value = '1h'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    const [fast, compaction] = [...options.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(fast.checked).toBe(false)
    expect(compaction.checked).toBe(true)
    await click(fast)
    await click(compaction)
    expect(settingsBodies(calls)).toEqual(['{"cacheTtl":"1h"}', '{"fastMode":true}', '{"serverCompaction":false}'])
    expect(select.value).toBe('1h')
    expect(options.querySelectorAll(':scope > p.dsha-muted')).toHaveLength(1)
    const details = options.querySelector<HTMLDetailsElement>('details.dshca-details')!
    expect(details.open).toBe(false)
    expect([...details.querySelectorAll('p')].map(note => note.textContent)).toEqual([zh.cacheTtlNote, zh.fastModeNote, zh.serverCompactionNote])
  })
  it('commits an explicit all-off selection through the shared checklist', async () => {
    const calls = mockFetch(status())
    await render()
    await click(buttonNamed(container.querySelector('.dshca-models .dsh-mcl')!, zh.clearAll))
    expect(settingsBodies(calls)).toEqual(['{"enabledModelIds":[]}'])
    await click(container.querySelector('.dshca-models [role="checkbox"]'))
    expect(settingsBodies(calls).at(-1)).toBe('{"enabledModelIds":["claude-fable-5-2"]}')
  })
  it('has no quota row, no quota badge, no media section and no sign-in flow', async () => {
    mockFetch(status())
    await render()
    expect(container.querySelector('[class*="quota"]')).toBeNull()
    expect(container.querySelector('[class*="media"]')).toBeNull()
    expect(container.querySelector('[class*="login"]')).toBeNull()
    // The shared proxy card words its own hint with some of these terms, so the
    // text check covers the sections this line owns.
    const own = [...container.querySelectorAll('section[class*="dshca-"]')].map(section => section.textContent).join('')
    expect(own).toContain(zh.optionsSection)
    // quota, media, sign-in, account pool (escaped: this file stays ASCII)
    for (const word of ['\u989d\u5ea6', '\u5a92\u4f53', '\u767b\u5f55', '\u53f7\u6c60']) expect(own).not.toContain(word)
  })
  it('keeps zh, en and ru on one key set under the line namespace', () => {
    const keys = Object.keys(zh).sort()
    expect(NS_CLAUDE_API).toBe('dsh-claude-api')
    expect(dictionaries).toEqual({ zh, en })
    expect(Object.keys(en).sort()).toEqual(keys)
    expect(Object.keys(ru).sort()).toEqual(keys)
    for (const dict of [zh, en, ru] as Record<string, string>[]) for (const key of keys) expect(dict[key].trim()).not.toBe('')
  })
  it('pins a full-width key grid, the style ownership tag, and declares no shared class', () => {
    installClaudeApiStyles()
    const style = document.getElementById(STYLE_ID)
    const css = style?.textContent ?? ''
    expect(STYLE_ID).toBe('dsh-claude-api-settings-style')
    expect(css).toMatch(/\.dshca-key-row\{[^}]*grid-template-columns:minmax\(0,1fr\) auto[^}]*width:100%/)
    expect(css).toMatch(/\.dshca-key-row input\{[^}]*max-width:none/)
    expect(css).not.toMatch(/(^|[},])\s*\.dsha-/m)
    expect(style?.getAttribute('data-plugin-css')).toBe('@eddyskywalker/dsh-chatgpt-subscription/claude-api')
  })
})

describe('Claude API cache-duration keepalive wording', () => {
  it('explains the 1h wait keepalive in zh, en and ru on one unchanged key set', () => {
    const keys = Object.keys(zh).sort()
    expect(Object.keys(en).sort()).toEqual(keys)
    expect(Object.keys(ru).sort()).toEqual(keys)
    // zh: subagents, background tasks, 55 minutes, and the 5-minute exemption.
    expect(zh.cacheTtlNote).toContain('55')
    expect(zh.cacheTtlNote).toContain('\u5b50\u4ee3\u7406')
    expect(zh.cacheTtlNote).toContain('\u540e\u53f0')
    expect(zh.cacheTtlNote).toContain('5 \u5206\u949f')
    expect(en.cacheTtlNote).toContain('55 minutes')
    expect(en.cacheTtlNote).toContain('subagents or background tasks')
    expect(en.cacheTtlNote).toContain('5-minute duration never does this')
    // ru: subagents and background tasks, same 55-minute figure.
    expect(ru.cacheTtlNote).toContain('55')
    expect(ru.cacheTtlNote).toContain('\u0441\u0443\u0431\u0430\u0433\u0435\u043d\u0442')
    expect(ru.cacheTtlNote).toContain('\u0444\u043e\u043d\u043e\u0432')
    expect(ru.cacheTtlNote).toContain('5 \u043c\u0438\u043d\u0443\u0442')
  })
})
