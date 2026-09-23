// @vitest-environment jsdom
/**
 * The WorkBuddy "模型上下文窗口" card lists the checked models only.
 *
 * The section used to render every catalog row, so a model the user had not
 * checked was editable there while DSH never offered it. Each row is now backed
 * by a checked model and can be restored to the catalog length, and one
 * section-level button clears every stored override.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkBuddySection } from '../src/client/workbuddy/WorkBuddySection.tsx'
import { zh } from '../src/client/workbuddy/locales.ts'
import type { WorkBuddyModelOption } from '../src/shared/workbuddy-contracts.ts'

const MODELS: WorkBuddyModelOption[] = [
  {
    id: 'glm-5.3',
    name: 'GLM-5.3',
    enabled: true,
    defaultContextWindow: 128_000,
    contextWindow: 128_000,
    defaultMaxTokens: 32_768,
    reasoningEfforts: ['low', 'high', 'max'],
    supportsImage: true,
    regions: ['cn'],
  },
  {
    id: 'glm-4.6',
    name: 'GLM-4.6',
    enabled: true,
    defaultContextWindow: 128_000,
    contextWindow: 128_000,
    defaultMaxTokens: 32_768,
    supportsImage: false,
    regions: ['cn'],
  },
  {
    id: 'hunyuan-t1',
    name: 'Hunyuan T1',
    enabled: false,
    defaultContextWindow: 256_000,
    contextWindow: 256_000,
    defaultMaxTokens: 16_384,
    supportsImage: false,
    regions: ['cn'],
  },
]

/** The host half this card talks to, reduced to the three stored settings. */
let enabledIds: string[] = ['glm-5.3', 'glm-4.6']
let overrides: Record<string, number> = { 'glm-5.3': 1_000_000 }
let calls: Array<{ url: string; body: unknown }> = []

function statusPayload() {
  return {
    authenticated: true,
    hasCredentials: true,
    authDirectory: '/home/me/auth',
    storagePath: '/home/me/models.json',
    managedStoragePath: '/home/me/accounts.json.dpapi',
    account: null,
    quota: null,
    lastFetchedAt: null,
    models: MODELS.map((model) => ({
      ...model,
      enabled: enabledIds.includes(model.id),
      contextWindow: overrides[model.id] ?? model.defaultContextWindow,
    })),
    contextWindowOverrides: { ...overrides },
    defaultReasoningEffort: null,
    selectedAccountId: null,
    accounts: [],
    rotationStrategy: 'sequential',
    enabled: true,
    serving: true,
    conflict: null,
  }
}

interface SettingsBody {
  enabledModelIds?: string[]
  contextWindowOverrides?: Record<string, number | null>
}

/** Replay each settings write onto the stub state, then answer with a status. */
function installFetch(): void {
  globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const body = init?.body === undefined
      ? undefined
      : (JSON.parse(String(init.body)) as SettingsBody)
    calls.push({ url: String(url), body })
    if (body?.enabledModelIds !== undefined) enabledIds = body.enabledModelIds
    if (body?.contextWindowOverrides !== undefined) {
      for (const [id, value] of Object.entries(body.contextWindowOverrides)) {
        if (value === null) delete overrides[id]
        else overrides[id] = value
      }
    }
    return Response.json({ ok: true, value: statusPayload() })
  }) as typeof fetch
}

let originalFetch: typeof globalThis.fetch
let originalActEnvironment: boolean | undefined
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

async function render(): Promise<void> {
  installFetch()
  await act(async () => root.render(createElement(WorkBuddySection, {})))
}

/** The context-window group, so assertions never match the model pills. */
function contextSection(): HTMLElement {
  const section = [...container.querySelectorAll<HTMLElement>('.dsha-group')].find(
    (group) => group.querySelector('.dsha-grouphead h3')?.textContent === zh.contextWindowSection,
  )
  if (section === undefined) throw new Error('context window section is not rendered')
  return section
}

function contextRows(section: HTMLElement): HTMLElement[] {
  return [...section.querySelectorAll<HTMLElement>('.dsha-context-row')]
}

function rowNames(section: HTMLElement): (string | null | undefined)[] {
  return contextRows(section).map((row) => row.querySelector('span')?.textContent)
}

function contextInput(section: HTMLElement, modelName: string): HTMLInputElement | null {
  return section.querySelector<HTMLInputElement>(`input[aria-label="${modelName} context window"]`)
}

function resetButton(section: HTMLElement, modelName: string): HTMLButtonElement {
  const button = section.querySelector<HTMLButtonElement>(
    `button[aria-label="${modelName} ${zh.contextWindowReset}"]`,
  )
  if (button === null) throw new Error(`no restore button for ${modelName}`)
  return button
}

function batchButton(section: HTMLElement): HTMLButtonElement {
  const button = [...section.querySelectorAll<HTMLButtonElement>('.dsha-actions button')].find(
    (candidate) => candidate.textContent === zh.contextWindowResetAll,
  )
  if (button === undefined) throw new Error('no restore-all button')
  return button
}

function settingsCalls(): Array<{ url: string; body: unknown }> {
  return calls.filter((call) => call.url === '/workbuddy/api/settings')
}

beforeEach(() => {
  enabledIds = ['glm-5.3', 'glm-4.6']
  overrides = { 'glm-5.3': 1_000_000 }
  calls = []
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

describe('WorkBuddy context window section', () => {
  it('lists checked models only, in catalog order', async () => {
    await render()

    const section = contextSection()
    expect(rowNames(section)).toEqual(['GLM-5.3', 'GLM-4.6'])
    // The unchecked model is still a pill above, but has no context row.
    expect(container.textContent).toContain('Hunyuan T1')
    expect(contextInput(section, 'Hunyuan T1')).toBeNull()
    // Each checked model keeps its stored override or its catalog length.
    expect(contextInput(section, 'GLM-5.3')?.value).toBe('1M')
    expect(contextInput(section, 'GLM-4.6')?.value).toBe('128K')
  })

  it('says so when nothing is checked', async () => {
    enabledIds = []
    await render()

    const section = contextSection()
    expect(contextRows(section)).toHaveLength(0)
    expect(section.textContent).toContain(zh.contextWindowNoneEnabled)
  })

  it('gives a freshly checked model a row seeded with its own default', async () => {
    await render()
    expect(contextInput(contextSection(), 'Hunyuan T1')).toBeNull()

    const pill = [...container.querySelectorAll<HTMLElement>('.dsha-models label')].find(
      (label) => label.querySelector('span')?.textContent === 'Hunyuan T1',
    )
    expect(pill).toBeDefined()
    await act(async () => pill!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())

    expect(settingsCalls()).toEqual([
      {
        url: '/workbuddy/api/settings',
        body: { enabledModelIds: ['glm-5.3', 'glm-4.6', 'hunyuan-t1'] },
      },
    ])
    const section = contextSection()
    expect(rowNames(section)).toEqual(['GLM-5.3', 'GLM-4.6', 'Hunyuan T1'])
    // Its draft comes from the model's default, never from an undefined entry.
    expect(contextInput(section, 'Hunyuan T1')?.value).toBe('256K')
    // A model with no stored override cannot be restored yet.
    expect(resetButton(section, 'Hunyuan T1').disabled).toBe(true)
  })

  it('restores one row to the catalog default', async () => {
    await render()
    const section = contextSection()

    // Only the model with a stored override can be restored.
    const reset = resetButton(section, 'GLM-5.3')
    expect(reset.className).toBe('dsha-context-save dsha-context-reset')
    expect(reset.disabled).toBe(false)
    expect(resetButton(section, 'GLM-4.6').disabled).toBe(true)

    await act(async () => reset.click())

    expect(settingsCalls()).toEqual([
      { url: '/workbuddy/api/settings', body: { contextWindowOverrides: { 'glm-5.3': null } } },
    ])
    // The row falls back to the model's own default and stops being restorable.
    expect(contextInput(section, 'GLM-5.3')?.value).toBe('128K')
    expect(resetButton(section, 'GLM-5.3').disabled).toBe(true)
  })

  it('restores every stored override at once', async () => {
    // One stored override belongs to a model the user has since unchecked: the
    // batch restore must still send it.
    overrides = { 'glm-5.3': 1_000_000, 'hunyuan-t1': 512_000 }
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await render()
    const section = contextSection()

    expect(batchButton(section).disabled).toBe(false)
    await act(async () => batchButton(section).click())

    expect(confirm).toHaveBeenCalledWith(zh.contextWindowResetAllConfirm)
    expect(settingsCalls()).toEqual([
      {
        url: '/workbuddy/api/settings',
        body: { contextWindowOverrides: { 'glm-5.3': null, 'hunyuan-t1': null } },
      },
    ])
    expect(contextInput(section, 'GLM-5.3')?.value).toBe('128K')
    // Nothing is left to restore, so the button disables itself.
    expect(batchButton(section).disabled).toBe(true)
  })

  it('writes nothing when the user cancels the batch restore', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await render()

    await act(async () => batchButton(contextSection()).click())

    expect(confirm).toHaveBeenCalledWith(zh.contextWindowResetAllConfirm)
    expect(settingsCalls()).toEqual([])
  })

  it('disables the batch restore when no override is stored', async () => {
    overrides = {}
    await render()

    expect(batchButton(contextSection()).disabled).toBe(true)
  })
})
