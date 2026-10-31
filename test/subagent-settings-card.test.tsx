// @vitest-environment jsdom
/**
 * 「子智能体」设置卡的验收：**注册在哪、渲染成什么、保存写了什么**。
 *
 * 三组断言钉住三条用户可见的链路：
 *
 * A. 注册 —— 进 plugins.item、id 是 subagent、order 10、priority -10（遮蔽宿主同名卡）；
 *    configForms 缺席时整段是空操作，不抛错。
 * B. 渲染 —— summary 是一句简介；page 渲染限制区 + 模型选择区 + 保存栏；
 *    全局默认与按主代理模型的专属列表都能编辑，快捷切换标签与「恢复跟随全局默认」
 *    都真的改了草稿。
 * C. 保存 —— 一次点击同时写偏好文档（默认列表 + 主代理补丁）与宿主
 *    subagent-model-selection-settings（enabled + 并集）。
 *
 * 与仓库其余 UI 测试一致：createRoot + act 手搓，不引入 @testing-library。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import {
  GLOBAL_TARGET,
  SubagentSettingsController,
  parseRouteKey,
  routeKey,
  type SubagentFormScope,
  type SubagentModelRoute,
} from '../src/client/subagent/subagent-card-controller.ts'
import {
  SUBAGENT_SLOT_ID,
  SUBAGENT_SLOT_ORDER,
  SUBAGENT_SLOT_PRIORITY,
  installSubagentSettingsCard,
} from '../src/client/subagent/index.ts'
import { SubagentCard } from '../src/client/subagent/SubagentCard.tsx'
import { NS_SUBAGENT, en, zh } from '../src/client/subagent/locales.ts'
import { installSubagentStyles } from '../src/client/subagent/styles.ts'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

const ROUTES: SubagentModelRoute[] = [
  { provider: 'codex-chatgpt', model: 'gpt-5.6-sol' },
  { provider: 'codex-chatgpt', model: 'gpt-5.6-mini' },
  { provider: 'kimi-code', model: 'kimi-for-coding' },
]

/** 一份可控的设置表单替身（鸭子类型：getSnapshot / subscribe / mutate）。 */
function makeForm<T>(initial: T, options: { writable?: boolean } = {}) {
  let value = initial
  let revision = 1
  const listeners = new Set<() => void>()
  const writes: Array<{ ops: ReadonlyArray<{ op: 'set' | 'unset'; path: readonly string[]; value?: unknown }>; revision?: number }> = []
  const snapshot = () => ({
    status: 'ready' as const,
    value,
    base: value,
    user: undefined as unknown,
    revision,
    writable: options.writable !== false,
  })
  const form: SubagentFormScope<T> & { writes: typeof writes; setValue(next: T): void } = {
    getSnapshot: snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    mutate: async (ops, expected) => {
      writes.push({ ops, revision: expected })
      for (const op of ops) {
        if (op.op === 'set') value = { ...(value as object), [op.path[0]!]: op.value } as T
      }
      revision += 1
      for (const listener of [...listeners]) listener()
      return true
    },
    writes,
    setValue: (next: T) => {
      value = next
      revision += 1
      for (const listener of [...listeners]) listener()
    },
  }
  return form
}

const CATALOG = [
  { provider: 'codex-chatgpt', providerName: 'ChatGPT', models: [
    { id: 'gpt-5.6-sol', name: '5.6 Sol' },
    { id: 'gpt-5.6-mini', name: '5.6 Mini' },
  ] },
  { provider: 'kimi-code', providerName: 'Kimi Code', models: [
    { id: 'kimi-for-coding', name: 'Kimi For Coding' },
  ] },
]

describe('subagent settings card', () => {
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

  /** 建一个控制器 + 渲染卡片，返回可观测的写入记录。 */
  async function renderCard(options: {
    enabled?: boolean
    allowed?: SubagentModelRoute[]
    defaults?: SubagentModelRoute[]
    overrides?: Record<string, SubagentModelRoute[]>
    writable?: boolean
  } = {}) {
    const limits = makeForm({ maxDepth: 1, maxActiveSubagents: 4 }, { writable: options.writable })
    const models = makeForm(
      { enabled: options.enabled ?? true, allowedModels: options.allowed ?? ROUTES },
      { writable: options.writable },
    )
    const savePreferences = vi.fn(async (_patch: unknown) => {})
    const controller = new SubagentSettingsController({
      limits,
      modelSelection: models,
      loadCatalog: async () => ({ ok: true, groups: CATALOG }),
      loadPreferences: async () => ({
        subagentDefaultModels: options.defaults ?? ROUTES,
        subagentModelsByMainModel: options.overrides ?? {},
      }),
      savePreferences,
    })
    const face = controller.inject()
    const t = (key: keyof typeof zh): string => zh[key]
    await act(async () => {
      root.render(createElement(SubagentCard as never, { view: 'page', t, ...face }))
    })
    return { controller, limits, models, savePreferences, face }
  }

  it('renders the localized summary line for view=summary', async () => {
    const controller = new SubagentSettingsController({ loadPreferences: async () => ({}) })
    const face = controller.inject()
    const t = (key: keyof typeof zh): string => zh[key]
    await act(async () => {
      root.render(createElement(SubagentCard as never, { view: 'summary', t, ...face }))
    })
    expect(container.textContent).toBe('设置子智能体的递归层级、数量和模型。')
    controller.dispose()
  })

  it('renders limits, the model-selection toggle, the main-model bar and the footer', async () => {
    const { controller } = await renderCard()
    expect(container.querySelector('[data-dsh-part="subagent-form"]')).not.toBeNull()
    expect(container.querySelector('[data-dsh-part="plugin-config-subagent-depth"]')).not.toBeNull()
    expect(container.querySelector('[data-dsh-part="plugin-config-subagent-capacity"]')).not.toBeNull()
    expect(container.querySelector('[data-dsh-part="subagent-enabled-switch"]')?.getAttribute('aria-checked')).toBe('true')
    const select = container.querySelector('[data-dsh-part="subagent-main-model"]') as HTMLSelectElement
    expect(select.getAttribute('aria-label')).toBe(zh.subagentMainModelLabel)
    // 全局默认选项 + 两个提供方分组里的三个模型。
    expect(select.options).toHaveLength(4)
    expect(select.options[0]!.value).toBe(GLOBAL_TARGET)
    expect(select.options[1]!.value).toBe('codex-chatgpt/gpt-5.6-sol')
    // 模型清单按提供方分组渲染。
    expect(container.querySelectorAll('[data-dsh-part="subagent-model"]')).toHaveLength(3)
    // 保存按钮在未改动时是禁用的。
    expect((container.querySelector('[data-dsh-part="subagent-save"]') as HTMLButtonElement).disabled).toBe(true)
    controller.dispose()
  })

  it('creates a per-main-model override seeded from the global default on first toggle', async () => {
    const { controller, face, savePreferences } = await renderCard()
    // 切到某个主代理模型（它还没有专属列表）。
    await act(async () => { face.setActiveTarget('codex-chatgpt/gpt-5.6-sol') })
    expect(container.textContent).toContain(zh.subagentTargetFollowGlobalStatus)
    // 勾掉一个模型：专属列表应当从全局默认起步，只少了被点掉的那一个。
    const rows = [...container.querySelectorAll<HTMLLabelElement>('[data-dsh-part="subagent-model"]')]
    await act(async () => { rows[1]!.querySelector('input')!.click() })

    expect(container.textContent).toContain(zh.subagentTargetOverrideStatus.replace('{count}', '2'))
    expect(container.querySelector('[data-dsh-part="subagent-reset-to-global"]')).not.toBeNull()
    await act(async () => { (container.querySelector('[data-dsh-part="subagent-save"]') as HTMLButtonElement).click() })
    const patch = savePreferences.mock.calls[0]?.[0] as unknown as {
      subagentDefaultModels: SubagentModelRoute[]
      subagentModelsByMainModel: Record<string, SubagentModelRoute[] | null>
    }
    expect(patch.subagentModelsByMainModel['codex-chatgpt/gpt-5.6-sol']).toEqual([
      { provider: 'codex-chatgpt', model: 'gpt-5.6-sol' },
      { provider: 'kimi-code', model: 'kimi-for-coding' },
    ])
    controller.dispose()
  })

  it('removes an override with the reset-to-global button', async () => {
    const { controller, face, savePreferences } = await renderCard({
      overrides: { 'codex-chatgpt/gpt-5.6-sol': [{ provider: 'kimi-code', model: 'kimi-for-coding' }] },
    })
    await act(async () => { face.setActiveTarget('codex-chatgpt/gpt-5.6-sol') })
    expect(container.textContent).toContain(zh.subagentTargetOverrideStatus.replace('{count}', '1'))
    await act(async () => { (container.querySelector('[data-dsh-part="subagent-reset-to-global"]') as HTMLButtonElement).click() })
    expect(container.textContent).toContain(zh.subagentTargetFollowGlobalStatus)
    await act(async () => { (container.querySelector('[data-dsh-part="subagent-save"]') as HTMLButtonElement).click() })
    const patch = savePreferences.mock.calls[0]?.[0] as unknown as {
      subagentModelsByMainModel: Record<string, SubagentModelRoute[] | null>
    }
    // 删掉的键以 null 送出，宿主据此把它从文档里移除。
    expect(patch.subagentModelsByMainModel['codex-chatgpt/gpt-5.6-sol']).toBeNull()
    controller.dispose()
  })

  it('writes the union of every list to the host allowlist on save', async () => {
    // 宿主那边授权清单是空的，而本插件已经存了两级列表：保存必须把并集补回去。
    const { controller, face, models, savePreferences } = await renderCard({
      allowed: [],
      defaults: [{ provider: 'codex-chatgpt', model: 'gpt-5.6-sol' }],
      overrides: { 'kimi-code/kimi-for-coding': [{ provider: 'kimi-code', model: 'kimi-for-coding' }] },
    })
    await act(async () => { face.toggleModel('codex-chatgpt/gpt-5.6-mini') })
    await act(async () => { (container.querySelector('[data-dsh-part="subagent-save"]') as HTMLButtonElement).click() })
    expect(savePreferences).toHaveBeenCalledTimes(1)
    const write = models.writes[0]
    expect(write).toBeDefined()
    // 宿主授权清单必须是两份列表的并集，否则专属列表里的模型在真正派活时会被拒。
    const allowed = write!.ops.find(op => op.path[0] === 'allowedModels')!.value as SubagentModelRoute[]
    expect(allowed.map(routeKey).sort()).toEqual([
      'codex-chatgpt/gpt-5.6-mini',
      'codex-chatgpt/gpt-5.6-sol',
      'kimi-code/kimi-for-coding',
    ])
    controller.dispose()
  })

  it('marks the draft invalid when the global list would end up empty', async () => {
    const { controller, face } = await renderCard({ defaults: [{ provider: 'codex-chatgpt', model: 'gpt-5.6-sol' }] })
    await act(async () => { face.toggleModel('codex-chatgpt/gpt-5.6-sol') })
    expect(container.textContent).toContain(zh.subagentModelPerTargetRequired)
    expect((container.querySelector('[data-dsh-part="subagent-save"]') as HTMLButtonElement).disabled).toBe(true)
    controller.dispose()
  })

  it('seeds the global default from the host allowlist when preferences are empty', async () => {
    const { controller, face } = await renderCard({ defaults: [] })
    // 偏好文档里没有默认列表：宿主 allowedModels 就是初始默认。
    const checked = [...container.querySelectorAll<HTMLInputElement>('[data-dsh-part="subagent-model"] input')]
    expect(checked.filter(input => input.checked)).toHaveLength(3)
    expect(container.textContent).toContain(zh.subagentChipGlobal.replace('{count}', '3'))
    controller.dispose()
  })

  it('registers into plugins.item with the shadowing priority and deduplicates entries("plugins.item") by id', () => {
    const registered: Array<Record<string, unknown>> = []
    const injections: string[] = []
    const forms = {
      get: (id: string) => makeForm(id === 'subagent' ? { maxDepth: 1, maxActiveSubagents: 4 } : { enabled: true, allowedModels: [] }),
      whileServed: (_namespaces: readonly string[], register: () => () => void) => register(),
    }
    const rawLedger = [
      { options: { id: 'subagent', order: 10, priority: -10, label: 'ours' } },
      { options: { id: 'shell', order: 5, priority: 0, label: 'shell' } },
      { options: { id: 'subagent', order: 10, priority: 0, label: 'host' } },
    ]
    const slots = {
      entries: (key: string) => (key === 'plugins.item' ? rawLedger : []),
      inject: (name: string, factory: () => () => void) => { injections.push(name); return factory() },
      register: (options: Record<string, unknown>, _component: unknown) => { registered.push(options); return () => {} },
    }
    const ctx = {
      effect: (fn: () => unknown) => { fn(); return () => {} },
      get: (name: string) => (name === 'configForms' ? forms : undefined),
      locale: { bind: () => (key: string) => key },
      slots,
    }
    const dispose = installSubagentSettingsCard(ctx as never)
    expect(injections).toContain('plugins.item')
    expect(registered).toHaveLength(1)
    expect(registered[0]!.name).toBe('plugins.item')
    expect(registered[0]!.id).toBe(SUBAGENT_SLOT_ID)
    expect(registered[0]!.order).toBe(SUBAGENT_SLOT_ORDER)
    expect(registered[0]!.priority).toBe(SUBAGENT_SLOT_PRIORITY)
    expect(registered[0]!.locale).toBe(NS_SUBAGENT)
    const deduped = slots.entries('plugins.item')
    expect(deduped).toHaveLength(2)
    expect(deduped.map(e => e.options.id)).toEqual(['shell', 'subagent'])
    expect((deduped[1]!.options as { label: string }).label).toBe('ours')
    dispose()
    expect(slots.entries('plugins.item')).toHaveLength(3)
  })

  it('is a clean no-op when configForms is absent', () => {
    const ctx = {
      effect: (fn: () => unknown) => { fn(); return () => {} },
      get: () => undefined,
      locale: { bind: () => (key: string) => key },
      slots: { inject: () => { throw new Error('must not be reached') }, register: () => () => {} },
    }
    expect(() => installSubagentSettingsCard(ctx as never)).not.toThrow()
  })

  it('parses a route key on the first slash only', () => {
    expect(parseRouteKey('codex-chatgpt/gpt-5.6-sol')).toEqual({ provider: 'codex-chatgpt', model: 'gpt-5.6-sol' })
    expect(parseRouteKey('openrouter/anthropic/claude')).toEqual({ provider: 'openrouter', model: 'anthropic/claude' })
    expect(parseRouteKey('nope')).toBeUndefined()
  })

  it('keeps the English and Chinese dictionaries on the same key set', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    expect(en.subagentTitle).toBe('Subagent')
  })

  it('normalizes the real DSH ModelProviderGroup shape ({ id, name, models }) without undefined provider routes', async () => {
    const limits = makeForm({ maxDepth: 1, maxActiveSubagents: 8 })
    const models = makeForm({
      enabled: true,
      allowedModels: [
        { provider: 'minimax-code', model: 'MiniMax-M3.1-Flash' },
        { provider: 'workbuddy-subscription', model: 'deepseek-v4.1-flash' },
      ],
    })
    const controller = new SubagentSettingsController({
      limits,
      modelSelection: models,
      loadCatalog: async () => ({
        ok: true,
        groups: [
          {
            id: 'minimax-code',
            name: 'MiniMax Code（编程订阅）',
            models: [{ id: 'MiniMax-M3.1-Flash', name: 'MiniMax M3.1 Flash' }],
          },
          {
            id: 'workbuddy-subscription',
            name: 'WorkBuddy（CodeBuddy 订阅）',
            models: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
          },
        ] as unknown as never,
      }),
      loadPreferences: async () => ({ subagentDefaultModels: [], subagentModelsByMainModel: {} }),
      savePreferences: async () => {},
    })
    const face = controller.inject()
    const t = (key: keyof typeof zh): string => zh[key]
    await act(async () => {
      root.render(createElement(SubagentCard as never, { view: 'page', t, ...face }))
    })
    const select = container.querySelector('[data-dsh-part="subagent-main-model"]') as HTMLSelectElement
    expect(select.options[1]!.value).toBe('minimax-code/MiniMax-M3.1-Flash')
    expect(select.options[2]!.value).toBe('workbuddy-subscription/deepseek-v4.1-flash')
    expect(container.textContent).not.toContain('undefined/')
    expect(container.textContent).not.toContain(zh.subagentModelSelectionUnavailable)
    const checked = [...container.querySelectorAll<HTMLInputElement>('[data-dsh-part="subagent-model"] input')]
    expect(checked).toHaveLength(2)
    expect(checked.every(input => input.checked)).toBe(true)
    controller.dispose()
  })

  it('installs its own owned stylesheet', () => {
    installSubagentStyles()
    const tag = document.querySelector('style[data-plugin-css$="/subagent"]')
    expect(tag).not.toBeNull()
    expect(tag!.textContent).toContain('.dsh-subagent-form')
    tag!.remove()
  })
})