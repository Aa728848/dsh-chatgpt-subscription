// @vitest-environment jsdom
/**
 * The Command Code context-window section follows its four sibling tabs: it
 * lists only the models the user checked, every row can be restored to the
 * catalog default, and one section-level button restores every stored override.
 *
 * The card used to render a row for every catalog model, which made the section
 * a second, redundant picker, and there was no way back from a custom capacity
 * to the catalog length.
 *
 * The fake server below keeps the overrides the way the host does: `null`
 * deletes the key, and the status payload derives each model's effective
 * `contextWindow` the same way the store does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { CommandCodeSection } from '../src/client/command-code/CommandCodeSection.tsx'
import { zh } from '../src/client/command-code/locales.ts'
import type {
  CommandCodeModelOption,
  CommandCodeWebStatus,
} from '../src/shared/command-code-contracts.ts'

interface CatalogEntry {
  id: string
  name: string
  defaultContextWindow: number
  defaultMaxTokens: number
  wire: CommandCodeModelOption['wire']
}

const CATALOG: CatalogEntry[] = [
  { id: 'alpha-large', name: 'Alpha Large', defaultContextWindow: 200_000, defaultMaxTokens: 32_000, wire: 'openai' },
  { id: 'beta-plain', name: 'Beta Plain', defaultContextWindow: 128_000, defaultMaxTokens: 16_000, wire: 'anthropic' },
  { id: 'gamma-hidden', name: 'Gamma Hidden', defaultContextWindow: 128_000, defaultMaxTokens: 16_000, wire: 'openai' },
]

interface ServerState {
  enabledModelIds: string[]
  overrides: Record<string, number>
}

function statusPayload(server: ServerState): CommandCodeWebStatus {
  return {
    enabled: true,
    authenticated: true,
    hasCredentials: true,
    storagePath: '/home/me/command-code-credentials.json',
    apiEnv: 'prod',
    account: {
      userId: 'u1',
      userName: 'me',
      email: 'me@example.com',
      organizationName: null,
      keyName: 'main key',
      planLabel: 'GOAT',
      planId: 'individual-goat',
      authenticatedAt: Date.now() - 60_000,
    },
    quota: null,
    lastFetchedAt: null,
    models: CATALOG.map((entry) => ({
      id: entry.id,
      name: entry.name,
      enabled: server.enabledModelIds.includes(entry.id),
      defaultContextWindow: entry.defaultContextWindow,
      contextWindow: server.overrides[entry.id] ?? entry.defaultContextWindow,
      defaultMaxTokens: entry.defaultMaxTokens,
      wire: entry.wire,
    })),
    contextWindowOverrides: { ...server.overrides },
    defaultReasoningEffort: null,
    serving: true,
    conflict: null,
  }
}

interface RecordedCall {
  path: string
  method: string
  body: Record<string, unknown> | undefined
}

let server: ServerState
let calls: RecordedCall[]
let originalFetch: typeof globalThis.fetch
let originalConfirm: typeof window.confirm
let originalActEnvironment: boolean | undefined
let confirmSpy: ReturnType<typeof vi.fn>
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

/** Answers the three routes this section talks to, mutating the fake store. */
function installFetch(): void {
  globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = String(url).replace('/command-code/api', '')
    const method = init?.method ?? 'GET'
    const body = init?.body === undefined
      ? undefined
      : (JSON.parse(String(init.body)) as Record<string, unknown>)
    calls.push({ path, method, body })
    if (path === '/status' || path === '/models' || path === '/settings') {
      if (method === 'POST' && path === '/models') {
        server.enabledModelIds = body?.enabledModelIds as string[]
      }
      if (method === 'POST' && path === '/settings') {
        for (const [key, value] of Object.entries((body?.contextWindowOverrides ?? {}) as Record<string, unknown>)) {
          if (value === null) delete server.overrides[key]
          else server.overrides[key] = value as number
        }
      }
      return Response.json({ ok: true, value: statusPayload(server) })
    }
    return Response.json({ ok: false, error: `unexpected ${path}` }, { status: 404 })
  }) as typeof fetch
}

async function mount(state: Partial<ServerState> = {}): Promise<void> {
  server = { enabledModelIds: [], overrides: {}, ...state }
  calls = []
  installFetch()
  await act(async () => root.render(createElement(CommandCodeSection, {})))
}

function contextGroup(): HTMLElement {
  const section = [...container.querySelectorAll<HTMLElement>('.dsha-group')]
    .find((group) => group.querySelector('h3')?.textContent === zh.contextWindowSection)
  expect(section).toBeDefined()
  return section!.querySelector<HTMLElement>('.dsha-context-settings')!
}

function contextRows(): HTMLElement[] {
  return [...contextGroup().querySelectorAll<HTMLElement>('.dsha-context-row')]
}

function rowLabels(): string[] {
  return contextRows().map((row) => row.querySelector('span')?.textContent ?? '')
}

function rowFor(name: string): HTMLElement {
  const row = contextRows().find((candidate) => candidate.querySelector('span')?.textContent === name)
  expect(row).toBeDefined()
  return row!
}

function inputFor(name: string): HTMLInputElement {
  return rowFor(name).querySelector<HTMLInputElement>('input')!
}

function resetButtonFor(name: string): HTMLButtonElement {
  const button = [...rowFor(name).querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.classList.contains('dsha-context-reset'))
  expect(button).toBeDefined()
  return button!
}

function restoreAllButton(): HTMLButtonElement {
  const button = [...contextGroup().querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent === zh.contextWindowResetAll)
  expect(button).toBeDefined()
  return button!
}

function modelCheckbox(name: string): HTMLInputElement {
  const label = [...container.querySelectorAll<HTMLLabelElement>('.dsha-models label')]
    .find((candidate) => candidate.querySelector('span')?.textContent === name)
  expect(label).toBeDefined()
  return label!.querySelector<HTMLInputElement>('input')!
}

function callsTo(path: string): RecordedCall[] {
  return calls.filter((call) => call.path === path && call.method === 'POST')
}

beforeEach(() => {
  originalFetch = globalThis.fetch
  originalConfirm = window.confirm
  originalActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  confirmSpy = vi.fn(() => true)
  window.confirm = confirmSpy as unknown as typeof window.confirm
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  globalThis.fetch = originalFetch
  window.confirm = originalConfirm
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
  vi.restoreAllMocks()
})

describe('Command Code context window section', () => {
  it('renders a row only for checked models, in catalog order', async () => {
    await mount({ enabledModelIds: ['alpha-large', 'beta-plain'], overrides: { 'alpha-large': 512_000 } })

    expect(rowLabels()).toEqual(['Alpha Large', 'Beta Plain'])
    // The stored override is what the input shows; the unchecked model has no
    // row at all, so the section is no longer a second model picker.
    expect(inputFor('Alpha Large').value).toBe('512K')
    expect(inputFor('Beta Plain').value).toBe('128K')
    expect(contextGroup().textContent).not.toContain('Gamma Hidden')
  })

  it('renders the empty state while no model is checked', async () => {
    await mount({ enabledModelIds: [], overrides: {} })

    expect(contextRows()).toHaveLength(0)
    expect(contextGroup().textContent).toContain(zh.contextWindowNoneEnabled)
  })

  it('seeds a draft when a model is checked on after load', async () => {
    await mount({ enabledModelIds: ['alpha-large'], overrides: {} })
    expect(rowLabels()).toEqual(['Alpha Large'])

    await act(async () => modelCheckbox('Beta Plain').click())

    expect(callsTo('/models')).toEqual([
      { path: '/models', method: 'POST', body: { enabledModelIds: ['alpha-large', 'beta-plain'] } },
    ])
    expect(rowLabels()).toEqual(['Alpha Large', 'Beta Plain'])
    // Seeded from the catalog default, not left as an empty input.
    expect(inputFor('Beta Plain').value).toBe('128K')
  })

  it('disables the row restore and the batch restore until an override is stored', async () => {
    await mount({ enabledModelIds: ['alpha-large'], overrides: {} })

    const row = resetButtonFor('Alpha Large')
    expect(row.disabled).toBe(true)
    expect(row.classList.contains('dsha-context-save')).toBe(true)
    expect(row.classList.contains('dsha-context-reset')).toBe(true)
    expect(row.textContent).toBe(zh.contextWindowReset)

    const batch = restoreAllButton()
    expect(batch.disabled).toBe(true)
    expect(batch.classList.contains('dsha-btn')).toBe(true)
    expect(batch.parentElement?.classList.contains('dsha-actions')).toBe(true)

    await act(async () => {
      row.click()
      batch.click()
    })
    expect(callsTo('/settings')).toHaveLength(0)
  })

  it('restores one row to its catalog default through a null override', async () => {
    await mount({ enabledModelIds: ['alpha-large'], overrides: { 'alpha-large': 512_000 } })
    expect(inputFor('Alpha Large').value).toBe('512K')

    const row = resetButtonFor('Alpha Large')
    expect(row.disabled).toBe(false)
    await act(async () => row.click())

    expect(callsTo('/settings')).toEqual([
      { path: '/settings', method: 'POST', body: { contextWindowOverrides: { 'alpha-large': null } } },
    ])
    // The draft falls back to the catalog length and the row is inactive again
    // because no override is stored any more.
    expect(inputFor('Alpha Large').value).toBe('200K')
    expect(resetButtonFor('Alpha Large').disabled).toBe(true)
  })

  it('restores every stored override in one request after confirmation', async () => {
    await mount({
      enabledModelIds: ['alpha-large'],
      overrides: { 'alpha-large': 512_000, 'gamma-hidden': 64_000 },
    })
    expect(restoreAllButton().disabled).toBe(false)

    // The user can still decline; nothing is posted then.
    confirmSpy.mockReturnValue(false)
    await act(async () => restoreAllButton().click())
    expect(confirmSpy).toHaveBeenCalledWith(zh.contextWindowResetAllConfirm)
    expect(callsTo('/settings')).toHaveLength(0)

    const posts = callsTo('/settings').length
    confirmSpy.mockReturnValue(true)
    await act(async () => restoreAllButton().click())
    // One request carries `null` for every stored key, including the override
    // left behind by a model that is not checked any more.
    expect(callsTo('/settings').slice(posts)).toEqual([
      {
        path: '/settings',
        method: 'POST',
        body: { contextWindowOverrides: { 'alpha-large': null, 'gamma-hidden': null } },
      },
    ])
    expect(inputFor('Alpha Large').value).toBe('200K')
    expect(restoreAllButton().disabled).toBe(true)
  })
})
