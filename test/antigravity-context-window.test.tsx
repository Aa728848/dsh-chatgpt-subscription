// @vitest-environment jsdom
/**
 * The Antigravity tab's context-window section lists only the checked models.
 *
 * The section used to render every catalog model, so a model the user had not
 * checked still offered a capacity box, and a freshly checked model rendered an
 * empty draft because the drafts were seeded only from the status loader. These
 * assertions pin the two behaviours the other four tabs now share: the row set
 * follows the checkboxes, and every row and the section itself can drop its
 * stored override through a `null` patch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { AntigravitySection, formatCapacity } from '../src/client/antigravity/AntigravitySection.tsx'
import { zh } from '../src/client/antigravity/locales.ts'
import type { AntigravityWebStatus } from '../src/shared/antigravity-contracts.ts'

const PRO = {
  id: 'gemini-2.5-pro',
  name: 'Gemini 2.5 Pro',
  enabled: true,
  defaultContextWindow: 1_000_000,
  contextWindow: 500_000,
}

const SONNET = {
  id: 'claude-sonnet-4-6',
  name: 'Claude Sonnet 4.6',
  enabled: true,
  defaultContextWindow: 200_000,
  contextWindow: 200_000,
}

const DISABLED = {
  id: 'gpt-5',
  name: 'GPT-5',
  enabled: false,
  defaultContextWindow: 400_000,
  contextWindow: 400_000,
}

function statusPayload(overrides: Partial<AntigravityWebStatus> = {}): AntigravityWebStatus {
  return {
    enabled: true,
    authenticated: true,
    hasCredentials: true,
    storagePath: 'C:\\Users\\A\\.dsh\\storages\\antigravity-pool.json.dpapi',
    models: [PRO, SONNET, DISABLED],
    // The pro model carries a stored override; the legacy key belongs to a model
    // the picker no longer lists, which only the batch restore can reach.
    contextWindowOverrides: { 'gemini-2.5-pro': 500_000, 'legacy-model-x': 100_000 },
    accounts: [
      {
        id: 'acc_1',
        alias: '主力账号',
        isPrimary: true,
        email: 'primary@example.com',
        projectId: 'proj-primary',
        lastUsedAt: Date.now() - 60_000,
      },
    ],
    activeAccountId: 'acc_1',
    rotationStrategy: 'sequential',
    quota: {
      groups: [
        {
          displayName: 'Gemini',
          buckets: [{ bucketId: 'daily', displayName: 'Daily', remainingFraction: 1 }],
        },
      ],
      models: [{ modelId: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' }],
      catalogModels: [{ id: 'gemini-2.5-pro' }],
      fetchedAt: Date.now(),
    },
    ...overrides,
  }
}

interface Api {
  calls: Array<{ url: string; body: unknown }>
  /** Swap what the next response carries, so a POST can return the refreshed card. */
  set: (next: AntigravityWebStatus) => void
}

let originalFetch: typeof globalThis.fetch
let originalActEnvironment: boolean | undefined
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

/** A stubbed API whose every route answers with the status it currently holds. */
function mockApi(initial: AntigravityWebStatus): Api {
  const calls: Array<{ url: string; body: unknown }> = []
  let current = initial
  globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown),
    })
    return Response.json({ ok: true, value: current })
  }) as typeof fetch
  return { calls, set: (next) => { current = next } }
}

async function render(
  status: AntigravityWebStatus = statusPayload(),
  props: { onModelChange?: () => void } = {},
): Promise<Api> {
  const api = mockApi(status)
  await act(async () => root.render(createElement(AntigravitySection, props)))
  return api
}

/** Every context row, in the order the section renders them. */
function contextRows(): HTMLDivElement[] {
  return [...container.querySelectorAll<HTMLDivElement>('.dsha-context-row')]
}

function rowFor(name: string): HTMLDivElement {
  const row = contextRows().find((candidate) => candidate.querySelector('span')?.textContent === name)
  expect(row).toBeDefined()
  return row!
}

function inputFor(name: string): HTMLInputElement {
  const input = rowFor(name).querySelector('input')
  expect(input).not.toBeNull()
  return input!
}

function resetButtonFor(name: string): HTMLButtonElement {
  return rowFor(name).querySelector<HTMLButtonElement>('.dsha-context-reset')!
}

function resetAllButton(): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('.dsha-context-settings .dsha-actions button')]
    .find((candidate) => candidate.textContent === zh.contextWindowResetAll)
  expect(button).toBeDefined()
  return button!
}

/** The checkbox on the model pill in the connection group. */
function pillFor(name: string): HTMLInputElement {
  const label = [...container.querySelectorAll<HTMLLabelElement>('.dsha-models label')]
    .find((candidate) => candidate.textContent === name)
  expect(label).toBeDefined()
  return label!.querySelector('input')!
}

beforeEach(() => {
  originalFetch = globalThis.fetch
  originalActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  globalThis.fetch = originalFetch
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
  vi.restoreAllMocks()
})

describe('Antigravity context window section', () => {
  it('renders a context row only for the checked models', async () => {
    await render()

    expect(contextRows().map((row) => row.querySelector('span')?.textContent))
      .toEqual(['Gemini 2.5 Pro', 'Claude Sonnet 4.6'])
    // The unchecked model keeps its pill in the connection group.
    expect(container.querySelector('.dsha-models')?.textContent).toContain('GPT-5')
    // The stored override seeds the draft, not the catalog default.
    expect(inputFor('Gemini 2.5 Pro').value).toBe(formatCapacity(500_000))
    expect(inputFor('Claude Sonnet 4.6').value).toBe(formatCapacity(SONNET.defaultContextWindow))
  })

  it('shows the empty-state sentence while no model is checked', async () => {
    await render(statusPayload({
      models: [{ ...PRO, enabled: false }, { ...SONNET, enabled: false }, DISABLED],
    }))

    expect(contextRows()).toHaveLength(0)
    expect(container.querySelector('.dsha-context-settings')?.textContent).toContain(zh.contextWindowNoneEnabled)
  })

  it('keeps both restore buttons disabled while nothing is overridden', async () => {
    await render(statusPayload({ contextWindowOverrides: {} }))

    expect(resetAllButton().disabled).toBe(true)
    expect(resetButtonFor('Gemini 2.5 Pro').disabled).toBe(true)
    expect(resetButtonFor('Claude Sonnet 4.6').disabled).toBe(true)
  })

  it('renders a newly checked model with its catalog window, not an empty draft', async () => {
    const api = await render()
    expect(contextRows()).toHaveLength(2)

    // A picker write makes the host rescan the catalog, so the response can carry
    // a model the previous payload never listed. Only the toggle path's re-seed
    // gives that model a draft; otherwise its enabled row renders an empty input.
    api.set(statusPayload({
      models: [
        PRO,
        SONNET,
        { ...DISABLED, enabled: true },
        { id: 'gemini-3-pro', name: 'Gemini 3 Pro', enabled: true, defaultContextWindow: 500_000, contextWindow: 500_000 },
      ],
    }))
    await act(async () => pillFor('GPT-5').click())

    expect(api.calls[1]).toEqual({
      url: '/antigravity/api/models',
      body: { enabledModelIds: ['gemini-2.5-pro', 'claude-sonnet-4-6', 'gpt-5'] },
    })
    expect(contextRows()).toHaveLength(4)
    expect(inputFor('GPT-5').value).toBe(formatCapacity(DISABLED.defaultContextWindow))
    expect(inputFor('GPT-5').value).toBe('400K')
    expect(inputFor('Gemini 3 Pro').value).toBe('500K')
  })

  it('restores one row through a null patch and re-seeds its draft from the default', async () => {
    const onModelChange = vi.fn()
    const api = await render(statusPayload(), { onModelChange })

    // Only the model with a stored override can be restored.
    expect(resetButtonFor('Gemini 2.5 Pro').disabled).toBe(false)
    expect(resetButtonFor('Claude Sonnet 4.6').disabled).toBe(true)

    api.set(statusPayload({
      models: [{ ...PRO, contextWindow: PRO.defaultContextWindow }, SONNET, DISABLED],
      contextWindowOverrides: { 'legacy-model-x': 100_000 },
    }))
    await act(async () => resetButtonFor('Gemini 2.5 Pro').click())

    expect(api.calls[1]).toEqual({
      url: '/antigravity/api/settings',
      body: { contextWindowOverrides: { 'gemini-2.5-pro': null } },
    })
    // The row falls back to the catalog length and locks again.
    expect(inputFor('Gemini 2.5 Pro').value).toBe(formatCapacity(PRO.defaultContextWindow))
    expect(inputFor('Gemini 2.5 Pro').value).toBe('1M')
    expect(resetButtonFor('Gemini 2.5 Pro').disabled).toBe(true)
    // The change is announced once, the way the sibling save handler does it.
    expect(onModelChange).toHaveBeenCalledTimes(1)
  })

  it('restores every stored override in one patch after confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const api = await render()
    expect(resetAllButton().disabled).toBe(false)

    api.set(statusPayload({
      models: [{ ...PRO, contextWindow: PRO.defaultContextWindow }, SONNET, DISABLED],
      contextWindowOverrides: {},
    }))
    await act(async () => resetAllButton().click())

    expect(confirm).toHaveBeenCalledWith(zh.contextWindowResetAllConfirm)
    // Every stored key goes out as a deletion, including the one whose model the
    // picker no longer lists.
    expect(api.calls[1]).toEqual({
      url: '/antigravity/api/settings',
      body: { contextWindowOverrides: { 'gemini-2.5-pro': null, 'legacy-model-x': null } },
    })
    expect(inputFor('Gemini 2.5 Pro').value).toBe(formatCapacity(PRO.defaultContextWindow))
    expect(inputFor('Claude Sonnet 4.6').value).toBe(formatCapacity(SONNET.defaultContextWindow))
    expect(resetAllButton().disabled).toBe(true)
  })

  it('posts nothing when the confirmation is declined', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const api = await render()

    await act(async () => resetAllButton().click())

    expect(confirm).toHaveBeenCalledWith(zh.contextWindowResetAllConfirm)
    expect(api.calls).toHaveLength(1)
    expect(inputFor('Gemini 2.5 Pro').value).toBe(formatCapacity(500_000))
  })
})
