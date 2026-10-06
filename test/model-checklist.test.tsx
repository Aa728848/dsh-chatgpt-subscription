// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { ModelChecklist, type ModelChecklistItem } from '../src/client/common/ModelChecklist.tsx'

const LABELS = { selectAll: '全选', clearAll: '全不选', countTemplate: '已启用 {count}/{total}', list: '模型' }

const ITEMS: ModelChecklistItem[] = [
  { id: 'gpt-5.6-sol', name: '5.6 Sol', hint: '272K tokens', enabled: true },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', enabled: false },
  { id: 'kimi-for-coding', name: 'Kimi For Coding', enabled: true },
  { id: 'some-unknown-model', name: 'Mystery', enabled: false },
]

describe('ModelChecklist', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  async function render(overrides: Partial<Parameters<typeof ModelChecklist>[0]> = {}) {
    const onToggle = vi.fn()
    const onToggleAll = vi.fn()
    await act(async () => root.render(createElement(ModelChecklist, {
      items: ITEMS,
      busy: false,
      onToggle,
      onToggleAll,
      labels: LABELS,
      ...overrides,
    })))
    return { onToggle, onToggleAll }
  }

  function rows(): HTMLButtonElement[] {
    return [...container.querySelectorAll<HTMLButtonElement>('.dsh-mcl-option')]
  }

  it('renders one row per model with name, hint and checked state', async () => {
    await render()
    expect(rows()).toHaveLength(4)
    expect(rows()[0]!.getAttribute('role')).toBe('checkbox')
    expect(rows()[0]!.getAttribute('aria-checked')).toBe('true')
    expect(rows()[1]!.getAttribute('aria-checked')).toBe('false')
    expect(rows()[0]!.querySelector('.dsh-mcl-name')?.textContent).toBe('5.6 Sol')
    expect(rows()[0]!.querySelector('.dsh-mcl-hint')?.textContent).toBe('272K tokens')
    // A row without a hint renders no hint line at all.
    expect(rows()[1]!.querySelector('.dsh-mcl-hint')).toBeNull()
    // The header counts the enabled share.
    expect(container.querySelector('.dsh-mcl-count')?.textContent).toBe('已启用 2/4')
  })

  it('draws a vendor mark for ids a rule claims and none for the rest', async () => {
    await render()
    expect(rows()[0]!.querySelector('svg')).not.toBeNull() // gpt → openai
    expect(rows()[1]!.querySelector('svg')).not.toBeNull() // claude
    expect(rows()[2]!.querySelector('svg')).not.toBeNull() // kimi
    // An unknown vendor gets no mark rather than a wrong one.
    expect(rows()[3]!.querySelector('svg')).toBeNull()
  })

  it('commits a toggle from a row click', async () => {
    const { onToggle } = await render()
    await act(async () => rows()[1]!.click())
    expect(onToggle).toHaveBeenCalledWith('claude-opus-4-6', true)
    await act(async () => rows()[0]!.click())
    expect(onToggle).toHaveBeenCalledWith('gpt-5.6-sol', false)
  })

  it('commits the bulk actions and disables the one that would be a no-op', async () => {
    const { onToggleAll } = await render()
    const [selectAll, clearAll] = [...container.querySelectorAll<HTMLButtonElement>('.dsh-mcl-action')]
    // Two of four are on: both directions are meaningful.
    expect(selectAll!.disabled).toBe(false)
    expect(clearAll!.disabled).toBe(false)
    await act(async () => selectAll!.click())
    expect(onToggleAll).toHaveBeenCalledWith(true)
    await act(async () => clearAll!.click())
    expect(onToggleAll).toHaveBeenCalledWith(false)
  })

  it('disables clear-all when nothing is enabled and select-all when everything is', async () => {
    await render({ items: ITEMS.map((item) => ({ ...item, enabled: true })) })
    let [selectAll, clearAll] = [...container.querySelectorAll<HTMLButtonElement>('.dsh-mcl-action')]
    expect(selectAll!.disabled).toBe(true)
    expect(clearAll!.disabled).toBe(false)

    await render({ items: ITEMS.map((item) => ({ ...item, enabled: false })) })
    ;[selectAll, clearAll] = [...container.querySelectorAll<HTMLButtonElement>('.dsh-mcl-action')]
    expect(selectAll!.disabled).toBe(false)
    expect(clearAll!.disabled).toBe(true)
  })

  it('disables every control while a commit is in flight', async () => {
    await render({ busy: true })
    for (const row of rows()) expect(row.disabled).toBe(true)
    for (const action of container.querySelectorAll<HTMLButtonElement>('.dsh-mcl-action')) {
      expect(action.disabled).toBe(true)
    }
  })
})
