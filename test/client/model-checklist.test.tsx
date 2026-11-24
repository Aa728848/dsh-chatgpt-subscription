// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { ModelChecklist, type ModelChecklistItem } from '../../src/client/common/ModelChecklist.tsx'
import { commandCodeModelVendor } from '../../src/client/providers/command-code/model-vendors.ts'
import { modelVendorGroup, nextGroupSelection } from '../../src/client/common/model-vendors.ts'

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

  it('disables select-all when everything is enabled, and keeps clear-all live at zero', async () => {
    await render({ items: ITEMS.map((item) => ({ ...item, enabled: true })) })
    let [selectAll, clearAll] = [...container.querySelectorAll<HTMLButtonElement>('.dsh-mcl-action')]
    expect(selectAll!.disabled).toBe(true)
    expect(clearAll!.disabled).toBe(false)

    // "All off" is a legal terminal state (an explicit empty selection), not a
    // no-op: clear-all stays clickable so the commit that produced it is
    // repeatable, and select-all is the way back.
    await render({ items: ITEMS.map((item) => ({ ...item, enabled: false })) })
    ;[selectAll, clearAll] = [...container.querySelectorAll<HTMLButtonElement>('.dsh-mcl-action')]
    expect(selectAll!.disabled).toBe(false)
    expect(clearAll!.disabled).toBe(false)
  })

  it('disables every control while a commit is in flight', async () => {
    await render({ busy: true })
    for (const row of rows()) expect(row.disabled).toBe(true)
    for (const action of container.querySelectorAll<HTMLButtonElement>('.dsh-mcl-action')) {
      expect(action.disabled).toBe(true)
    }
  })

  it('names the list with the label its section supplies', async () => {
    await render()
    expect(container.querySelector('.dsh-mcl-list')?.getAttribute('aria-label')).toBe('模型')
    // A section that supplies none leaves the group unnamed. That is the state a
    // provider line must not be in: it had a list with an accessible name before
    // this component existed.
    await render({ labels: { selectAll: '全选', clearAll: '全不选' } })
    expect(container.querySelector('.dsh-mcl-list')?.getAttribute('aria-label')).toBeNull()
  })

  it('switches to a left-vendor + right-model split view when two or more groups exist', async () => {
    const grouped: ModelChecklistItem[] = [
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', hint: 'Anthropic · 1M', enabled: true, group: { key: 'anthropic', label: 'Anthropic', mark: 'claude' } },
      { id: 'claude-opus-5', name: 'Claude Opus 5', hint: 'Anthropic · 1M', enabled: false, group: { key: 'anthropic', label: 'Anthropic', mark: 'claude' } },
      { id: 'gpt-6-astra', name: 'GPT-6 Astra', hint: 'OpenAI · 1M', enabled: false, group: { key: 'openai', label: 'OpenAI', mark: 'openai' } },
      { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', hint: 'OpenAI · 128K', enabled: true, group: { key: 'deepseek', label: 'DeepSeek', mark: 'deepseek' } },
    ]
    const onToggleGroup = vi.fn()
    await render({
      items: grouped,
      onToggleGroup,
      labels: { ...LABELS, allGroups: '全部', enabledGroup: '已启用', searchPlaceholder: '搜索模型…', noMatches: '无匹配' },
    })

    // Defaults to first vendor (Anthropic) with only its 2 models shown on the right.
    expect(container.querySelector('.dsh-mcl-split')).not.toBeNull()
    expect(rows().map((r) => r.title)).toEqual(['claude-sonnet-5', 'claude-opus-5'])

    // Clicking a vendor on the left switches the right pane.
    const openaiTab = container.querySelector<HTMLButtonElement>('.dsh-mcl-vendor[data-vendor="openai"]')!
    await act(async () => openaiTab.click())
    expect(rows().map((r) => r.title)).toEqual(['gpt-6-astra'])

    // Group select-all targets only the active vendor's ids.
    const groupSelectAll = container.querySelector<HTMLButtonElement>('.dsh-mcl-pane-head .dsh-mcl-action')!
    await act(async () => groupSelectAll.click())
    expect(onToggleGroup).toHaveBeenCalledWith(['gpt-6-astra'], true)

    // Cross-vendor search matches across all vendors regardless of active tab.
    const search = container.querySelector<HTMLInputElement>('.dsh-mcl-search')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(search, 'deepseek')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(rows().map((r) => r.title)).toEqual(['deepseek/deepseek-v4-pro'])

    // Pressing Escape clears search and returns to the active vendor.
    await act(async () => {
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(rows().map((r) => r.title)).toEqual(['gpt-6-astra'])

    // Clicking "Enabled" tab shows only enabled models across vendors.
    const enabledTab = [...container.querySelectorAll<HTMLButtonElement>('.dsh-mcl-vendor')]
      .find((btn) => btn.querySelector('.dsh-mcl-vendor-name')?.textContent === '已启用')!
    await act(async () => enabledTab.click())
    expect(rows().map((r) => r.title)).toEqual(['claude-sonnet-5', 'deepseek/deepseek-v4-pro'])
  })

  it('derives vendor groups itself under groupByVendor, keeping the catch-all bucket last', async () => {
    const onToggleGroup = vi.fn()
    await render({
      items: [
        { id: 'Auto', name: 'Auto', enabled: false },
        { id: 'Qwen3.8-Max', name: 'Qwen3.8 Max', enabled: true },
        { id: 'DeepSeek-V4-Pro', name: 'DeepSeek V4 Pro', enabled: false },
        { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', enabled: false },
      ],
      onToggleGroup,
      groupByVendor: { minItems: 4 },
    })
    expect(container.querySelector('.dsh-mcl-split')).not.toBeNull()
    const vendorKeys = [...container.querySelectorAll<HTMLButtonElement>('.dsh-mcl-vendor[data-vendor]')].map((b) => b.dataset.vendor)
    expect(vendorKeys).toEqual(['qwen', 'deepseek', 'other'])
    // The first vendor is active and its batch toggle covers only its own ids.
    expect(rows().map((r) => r.title)).toEqual(['Qwen3.8-Max', 'qwen3.7-plus'])
    await act(async () => container.querySelector<HTMLButtonElement>('.dsh-mcl-pane-head .dsh-mcl-action')!.click())
    expect(onToggleGroup).toHaveBeenCalledWith(['Qwen3.8-Max', 'qwen3.7-plus'], true)
    // Without a caller label the split view uses the checklist's own copy.
    expect(container.querySelector('.dsh-mcl-search')?.getAttribute('placeholder')).toBe('搜索模型或厂商…')
  })

  it('keeps a short mixed catalog flat under the default size threshold', async () => {
    await render({ groupByVendor: true })
    expect(container.querySelector('.dsh-mcl-split')).toBeNull()
    expect(rows()).toHaveLength(ITEMS.length)
  })

  it('keeps a single-vendor catalog flat even under groupByVendor', async () => {
    await render({
      items: [
        { id: 'claude-opus-5', name: 'Claude Opus 5', enabled: true },
        { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', enabled: false },
      ],
      groupByVendor: { minItems: 0 },
    })
    expect(container.querySelector('.dsh-mcl-split')).toBeNull()
    expect(rows()).toHaveLength(2)
  })
})

describe('commandCodeModelVendor', () => {
  it('merges vendor aliases, recognizes bare families, and formats new prefixes', () => {
    expect(commandCodeModelVendor({ id: 'claude-sonnet-5-5' }, '其他')).toEqual({ key: 'anthropic', label: 'Anthropic', mark: 'claude' })
    expect(commandCodeModelVendor({ id: 'gpt-6-astra' }, '其他')).toEqual({ key: 'openai', label: 'OpenAI', mark: 'openai' })
    expect(commandCodeModelVendor({ id: 'z-ai/glm-5.3-flash' }, '其他').key).toBe('zai')
    expect(commandCodeModelVendor({ id: 'zai-org/GLM-5.3' }, '其他').key).toBe('zai')
    expect(commandCodeModelVendor({ id: 'minimax/minimax-m3.1-flash' }, '其他').key).toBe('minimax')
    expect(commandCodeModelVendor({ id: 'MiniMaxAI/MiniMax-M3' }, '其他').key).toBe('minimax')
    expect(commandCodeModelVendor({ id: 'future-lab/next-1' }, '其他')).toEqual({ key: 'future-lab', label: 'Future Lab', mark: null })
    expect(commandCodeModelVendor({ id: 'alpha-large' }, '其他')).toEqual({ key: 'other', label: '其他', mark: null })
  })
})

describe('modelVendorGroup', () => {
  it('reads families from bare ids that carry no vendor prefix', () => {
    expect(modelVendorGroup('qwen3.8-max', '其他').key).toBe('qwen')
    expect(modelVendorGroup('Qwen3.7Plus', '其他').key).toBe('qwen')
    expect(modelVendorGroup('hy4-preview', '其他').key).toBe('tencent')
    expect(modelVendorGroup('llama3.1:8b', '其他').key).toBe('meta')
    expect(modelVendorGroup('gpt-oss:20b', '其他').key).toBe('openai')
    expect(modelVendorGroup('gemma3:27b', '其他').key).toBe('google')
    expect(modelVendorGroup('k3.1-pro', '其他').key).toBe('moonshot')
    expect(modelVendorGroup('MiniMax-M3', '其他').key).toBe('minimax')
    expect(modelVendorGroup('Performance', '其他')).toEqual({ key: 'other', label: '其他', mark: null })
  })

  it('prefers the model family over an unknown namespace, and skips line-own prefixes', () => {
    expect(modelVendorGroup('huihui_ai/deepseek-r1-abliterated', '其他').key).toBe('deepseek')
    expect(modelVendorGroup('cline-pass/qwen3.8-max', '其他', { ignorePrefixes: ['cline-pass'] }).key).toBe('qwen')
    // Without the skip the line prefix would read as a vendor of its own.
    expect(modelVendorGroup('cline-pass/mystery', '其他').key).toBe('cline-pass')
  })
})

describe('nextGroupSelection', () => {
  it('adds or removes only the group ids, keeping the rest in order', () => {
    expect(nextGroupSelection(['a', 'b'], ['c', 'a'], true)).toEqual(['a', 'b', 'c'])
    expect(nextGroupSelection(['a', 'b', 'c'], ['a', 'c'], false)).toEqual(['b'])
  })
})
