// @vitest-environment jsdom
/**
 * 「进展更新」浏览器半边的验收：**注册在哪、渲染成什么、数据真的从宿主来**。
 *
 * 这一组测试钉住三条用户可见的链路：
 *
 * A. 对话流 —— 视图注册在 `tool.call.toolview` 上、key 是 `progress_update`，
 *    注册的那个组件渲染出来就是这次调用的进展（三个工具阶段都读得对）；
 * B. 设置页 —— 独立一格 `settings.section`，三行都渲染，点「打开进展面板」
 *    **确实调用了 openTab**（`vi.fn` + 真实 click），并且开关/阈值写的是本插件
 *    Config 的那两个字段；
 * C. 取数 —— 面板真的发请求到 `/api/dsh-progress-updates/updates`，路由返回的
 *    进展真的进了快照。
 *
 * ## 为什么不用 @testing-library
 *
 * 本仓库没有装 @testing-library（兄弟仓库 dsh-web 装了）。既有 UI 测试
 * （`hub-overview-ui.test.tsx`、`codex-image-tool-view.test.tsx` 等）一律用
 * `createRoot` + `act` 手搓，这里与它们保持一致，免得为一个测试新增依赖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import {
  PANEL_TAB_ID,
  PANEL_TAB_KIND,
  SETTINGS_SECTION_ID,
  SETTINGS_SECTION_ORDER,
  installProgressUpdatesClient,
} from '../src/client/progress-updates/index.ts'
import { ProgressRow, progressOfBlock } from '../src/client/progress-updates/progress-row.tsx'
import { ProgressUpdatesSettingsSection } from '../src/client/progress-updates/settings-section.tsx'
import { ProgressUpdatesPanel, ProgressUpdatesTab } from '../src/client/progress-updates/updates-panel.tsx'
import type { ProgressSnapshotSource } from '../src/client/progress-updates/updates-panel.tsx'
import type { ProgressSettingsForm, ProgressUpdatesSettingsValues } from '../src/client/progress-updates/settings-binding.ts'
import { PROGRESS_UPDATES_PATH, createHostProgressSource } from '../src/client/progress-updates/host-source.ts'
import { PROGRESS_UPDATE_TOOL_NAME } from '../src/client/progress-updates/tool-name.ts'
import { NS_PROGRESS_UPDATES, en, zh } from '../src/client/progress-updates/locales.ts'
import { NOTIFY_USER_TOOL } from '../src/host/progress-updates/tool.ts'
import type { ProgressUpdate as HostProgressUpdate } from '../src/host/progress-updates/store.ts'
import type { ProgressUpdate } from '../src/client/progress-updates/contracts.ts'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

/** 一次槽位注册记录。 */
interface Registration {
  name: string
  key?: string
  id?: string
  order?: number
  locale?: string
  label?: () => string
  inject?: (...args: unknown[]) => Record<string, unknown>
  component: unknown
}

/**
 * 假的浏览器上下文：只实现入口真正用到的几个面（effect / get / locale / slots）。
 * @param services - `ctx.get()` 能读到的可选服务（侧栏、设置表单）。
 * @returns 上下文与记录下来的注册表。
 */
function makeCtx(services: Record<string, unknown> = {}) {
  const registrations: Registration[] = []
  const disposers: Array<() => void> = []
  /** 入口申请过的槽位名：inject 与 register 必须指向同一个槽位。 */
  const injects: string[] = []
  const ctx = {
    effect: (fn: () => unknown) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
      return () => {}
    },
    get: (name: string) => services[name],
    locale: {
      register: () => () => {},
      bind: () => (key: string) => (zh as Record<string, string>)[key] ?? key,
    },
    slots: {
      inject: (key: string, callback: () => () => void) => {
        injects.push(key)
        return callback()
      },
      register: (options: Registration, component: unknown) => {
        registrations.push({ ...options, component })
        return () => {}
      },
    },
  }
  return { ctx: ctx as never, registrations, disposers, injects }
}

/**
 * 按槽位名取一次注册。
 * @param registrations - 记录的注册表。
 * @param name - 槽位名。
 * @returns 该槽位的注册。
 */
function registrationOf(registrations: readonly Registration[], name: string): Registration {
  const found = registrations.find((entry) => entry.name === name)
  if (found === undefined) throw new Error(`入口没有注册 ${name}`)
  return found
}

/** 渲染宿主。 */
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
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 造一个工具调用的参数视图（流式阶段的前缀读法）。 */
function argsOf(fields: Record<string, string>): { text: (key: string) => string | undefined } {
  return { text: (key) => fields[key] }
}

describe('A. 对话流里的进展行', () => {
  /**
   * 回归守卫：`slots.inject(key, …)` 里的 key 与 `slots.register({ name: … })` 里的
   * name 必须是**同一个槽位**。假 ctx 的 inject 会无视 key 直接跑回调，所以只断言
   * register 的 name 抓不到「inject 写错槽位」这类回归——两处都要断言。
   */
  it('申请与注册落在同一个 tool.call.toolview 槽位上', async () => {
    const harness = makeCtx()
    await act(async () => { installProgressUpdatesClient(harness.ctx) })

    const row = registrationOf(harness.registrations, 'tool.call.toolview')
    expect(harness.injects).toContain('tool.call.toolview')
    expect(row.name).toBe('tool.call.toolview')
    expect(row.key).toBe(PROGRESS_UPDATE_TOOL_NAME)
  })

  it('注册在 tool.call.toolview 上，key 是工具名 progress_update', () => {
    // Given 一个空的浏览器上下文
    const { ctx, registrations } = makeCtx()
    // When 子模块挂载
    installProgressUpdatesClient(ctx)
    // Then —— 这一行就是「对话流视图注册在 tool.call.toolview、key = progress_update」
    //  的证据：三者必须同时对上，错一个这一行就渲染不出来。
    const row = registrationOf(registrations, 'tool.call.toolview')
    expect(row.name).toBe('tool.call.toolview')
    expect(row.key).toBe('progress_update')
    expect(row.key).toBe(PROGRESS_UPDATE_TOOL_NAME)
    expect(row.component).toBe(ProgressRow)
    // And 文案走本插件的进展更新命名空间
    expect(row.locale).toBe(NS_PROGRESS_UPDATES)
  })

  it('工具名常量与宿主侧逐字相同（冻结契约）', () => {
    expect(PROGRESS_UPDATE_TOOL_NAME).toBe(NOTIFY_USER_TOOL)
  })

  it('已结算的进展行渲染出这次调用的标题与状态词', async () => {
    // Given 一次已结算的 progress_update 调用
    const block = {
      kind: 'tool-result',
      callId: 'call-1',
      name: PROGRESS_UPDATE_TOOL_NAME,
      args: argsOf({ title: '读取仓库结构', message: '已读完 packages 目录。' }),
      isError: false,
    }
    // When 视图渲染
    await act(async () => root.render(createElement(ProgressRow, { block } as never)))
    // Then 标题行显示的就是进展标题
    expect(container.querySelector('[data-dsh-part="progress-row-title"]')?.textContent).toBe('读取仓库结构')
    expect(container.querySelector('[data-dsh-part="progress-row-state"]')?.textContent).toBe(zh.rowDone)
    expect(container.querySelector('[data-dsh-part="progress-row"]')?.getAttribute('data-state')).toBe('done')
  })

  it('参数还在流式生成（preparing）时用已到达的前缀显示标题，状态是进行中', async () => {
    // Given 一次还在准备参数的调用（没有 argsRaw，只有前缀视图）
    const block = { phase: 'preparing', callId: 'call-2', name: PROGRESS_UPDATE_TOOL_NAME, args: argsOf({ title: '正在读仓库' }) }
    // When 视图渲染
    await act(async () => root.render(createElement(ProgressRow, { block } as never)))
    // Then 标题已经是到达的那一段，状态词是「进行中」
    expect(container.querySelector('[data-dsh-part="progress-row-title"]')?.textContent).toBe('正在读仓库')
    expect(container.querySelector('[data-dsh-part="progress-row-state"]')?.textContent).toBe(zh.rowRunning)
  })

  it('参数已完整但结果未到时从 argsRaw 里读标题', async () => {
    // Given 一次 start 阶段的调用：参数视图给不出内容，完整 JSON 在 argsRaw 上
    const block = {
      phase: 'start',
      callId: 'call-3',
      name: PROGRESS_UPDATE_TOOL_NAME,
      args: argsOf({}),
      argsRaw: JSON.stringify({ title: '准备跑测试', message: '先跑 typecheck。' }),
    }
    // When 视图渲染
    await act(async () => root.render(createElement(ProgressRow, { block } as never)))
    // Then 标题从 argsRaw 解析出来了
    expect(container.querySelector('[data-dsh-part="progress-row-title"]')?.textContent).toBe('准备跑测试')
  })

  it('点标题展开正文，再点收起', async () => {
    // Given 一条带正文的已结算进展
    const block = {
      kind: 'tool-result',
      callId: 'call-4',
      name: PROGRESS_UPDATE_TOOL_NAME,
      args: argsOf({ title: '运行测试', message: '第一行\n第二行' }),
      isError: false,
    }
    await act(async () => root.render(createElement(ProgressRow, { block } as never)))
    const header = container.querySelector('[data-dsh-part="progress-row-header"]')!
    // When 用户点标题
    await act(async () => { (header as HTMLElement).click() })
    // Then 正文展开，且保留换行
    expect(container.querySelector('[data-dsh-part="progress-row-message"]')?.textContent).toBe('第一行\n第二行')
    // When 再点一次
    await act(async () => { (header as HTMLElement).click() })
    // Then 正文收起
    expect(container.querySelector('[data-dsh-part="progress-row-message"]')).toBeNull()
  })

  it('失败的调用把状态词换成「未发出」，英文座位全程英文', async () => {
    // Given 一次 isError 的已结算调用 + 一个英文文案座位
    const block = { kind: 'tool-result', callId: 'call-5', name: PROGRESS_UPDATE_TOOL_NAME, args: argsOf({ title: 'Run tests' }), isError: true }
    const t = (key: string): string => (en as Record<string, string>)[key] ?? key
    // When 视图用英文座位渲染
    await act(async () => root.render(createElement(ProgressRow, { block, t } as never)))
    // Then 状态词与无障碍标签都是英文
    expect(container.querySelector('[data-dsh-part="progress-row-state"]')?.textContent).toBe(en.rowError)
    expect(container.querySelector('[data-dsh-part="progress-row-header"]')?.getAttribute('aria-label')).toBe(en.rowExpand)
  })

  it('标题缺省时退回正文首行，两个参数都缺时只有空正文', () => {
    expect(progressOfBlock({ args: argsOf({ message: '只有正文\n第二行' }) })).toEqual({ message: '只有正文\n第二行' })
    expect(progressOfBlock({ args: argsOf({}) })).toEqual({ message: '' })
  })
})

describe('B. 设置页：独立一格，三行都渲染，按钮真的调 openTab', () => {
  /** 一份假的表单通道：记录 set 的字段与值。 */
  function fakeForm(value: Partial<ProgressUpdatesSettingsValues>): ProgressSettingsForm & { writes: Array<[string, unknown]> } {
    const writes: Array<[string, unknown]> = []
    let snapshot = {
      status: 'ready' as const,
      value,
      base: undefined,
      user: undefined,
      revision: 1,
      writable: true,
    }
    const listeners = new Set<() => void>()
    return {
      writes,
      getSnapshot: () => snapshot as never,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      set: async (field, next) => {
        writes.push([field, next])
        snapshot = { ...snapshot, value: { ...snapshot.value, [field]: next } }
        for (const listener of Array.from(listeners)) listener()
        return true
      },
      dispose: () => { listeners.clear() },
    }
  }

  it('注册成独立的一格：id 是 progress-updates，order 与订阅服务那格不冲突', () => {
    // Given 一个装着侧栏服务的上下文
    const { ctx, registrations } = makeCtx({ sidebarRightTabs: { register: () => () => {} }, sidebarRight: { openTab: vi.fn() } })
    // When 子模块挂载
    installProgressUpdatesClient(ctx)
    // Then 设置页多了一格，**不是**订阅服务那一格
    const sections = registrations.filter((entry) => entry.name === 'settings.section')
    expect(sections).toHaveLength(1)
    expect(sections[0]!.id).toBe(SETTINGS_SECTION_ID)
    expect(sections[0]!.id).not.toBe('subscription-hub')
    // And 顺序取 150：既有的订阅服务是 45，平台侧是 -10/0/10/15/20，都不撞号
    expect(sections[0]!.order).toBe(SETTINGS_SECTION_ORDER)
    expect(SETTINGS_SECTION_ORDER).toBe(150)
    // And 导航标签就是「进展更新」
    expect(sections[0]!.label?.()).toBe(zh.navTitle)
    expect(sections[0]!.locale).toBe(NS_PROGRESS_UPDATES)
  })

  it('三行卡片都渲染：开关、阈值、打开面板', async () => {
    // Given 一份就绪的表单与一个假侧栏
    const form = fakeForm({ progressUpdates: false, progressUpdatesNudgeThreshold: 8 })
    await act(async () => root.render(createElement(ProgressUpdatesSettingsSection, {
      openPanel: vi.fn(), close: vi.fn(), settings: form,
    } as never)))
    // Then 三行都在
    expect(container.querySelector('[data-dsh-part="settings-row-enabled"]')).not.toBeNull()
    expect(container.querySelector('[data-dsh-part="settings-row-threshold"]')).not.toBeNull()
    expect(container.querySelector('[data-dsh-part="settings-row-panel"]')).not.toBeNull()
    // And 名称与说明用的是本插件的文案
    expect(container.textContent).toContain(zh.settingsEnabledName)
    expect(container.textContent).toContain(zh.settingsThresholdName)
    expect(container.textContent).toContain(zh.settingsPanelName)
    expect(container.textContent).toContain(zh.settingsHint)
    // And 行上挂的是本插件自己的样式类（与 hub 那套同形但不覆盖）
    expect(container.querySelectorAll('.dsh-progress-card')).toHaveLength(3)
  })

  it('点「打开进展面板」真的调用了 openTab（vi.fn + 真实 click）', async () => {
    // Given 一个记录 openTab 参数的假侧栏，以及一个假设置壳
    const openTab = vi.fn()
    const close = vi.fn()
    const { ctx, registrations } = makeCtx({ sidebarRightTabs: { register: () => () => {} }, sidebarRight: { openTab } })
    installProgressUpdatesClient(ctx)
    const section = registrationOf(registrations, 'settings.section')
    const face = section.inject?.() as { openPanel: () => void }
    // And 用入口注入的 openPanel 渲染真正的设置组件
    await act(async () => root.render(createElement(ProgressUpdatesSettingsSection, {
      openPanel: face.openPanel, close, settings: fakeForm({ progressUpdates: true }),
    } as never)))
    // When 用户真的点了那个按钮（派发一个真实的 DOM click 事件，而不是直接调
    //      注入函数——只断言"注入了函数"证明不了入口是通的）
    const button = container.querySelector<HTMLElement>('[data-dsh-part="settings-open"]')!
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    // Then —— 这一行就是「按钮调用了 openTab」的证据：
    //      参数正是阶段一声明的那个 kind，两段用的是同一套身份
    expect(openTab).toHaveBeenCalledTimes(1)
    expect(openTab).toHaveBeenCalledWith(PANEL_TAB_KIND)
    // And 打开之后设置弹层自行收起，用户才看得见侧栏
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('开关写的是本插件 Config 的 progressUpdates，阈值写 progressUpdatesNudgeThreshold', async () => {
    // Given 一份可写的表单
    const form = fakeForm({ progressUpdates: false, progressUpdatesNudgeThreshold: 8 })
    await act(async () => root.render(createElement(ProgressUpdatesSettingsSection, {
      openPanel: vi.fn(), close: vi.fn(), settings: form,
    } as never)))
    // When 用户点开关
    await act(async () => { container.querySelector<HTMLElement>('[data-dsh-part="settings-switch"]')!.click() })
    // Then 写的是本插件 Config 的根字段名（不是源实现那套 enabled / nudgeThreshold）
    expect(form.writes).toEqual([['progressUpdates', true]])
    // When 用户改阈值
    const input = container.querySelector<HTMLInputElement>('[data-dsh-part="settings-threshold"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '12')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // Then 阈值同样落到本插件 Config 的字段上
    expect(form.writes).toEqual([['progressUpdates', true], ['progressUpdatesNudgeThreshold', 12]])
  })

  it('没有设置服务时控件只读，说明行写明原因', async () => {
    // Given 一个没有 configForms 的部署
    await act(async () => root.render(createElement(ProgressUpdatesSettingsSection, {
      openPanel: vi.fn(), close: vi.fn(),
    } as never)))
    // Then 开关与输入框都是禁用的
    expect(container.querySelector<HTMLButtonElement>('[data-dsh-part="settings-switch"]')?.disabled).toBe(true)
    expect(container.querySelector<HTMLInputElement>('[data-dsh-part="settings-threshold"]')?.disabled).toBe(true)
    // And 说明行说清了为什么
    expect(container.textContent).toContain(zh.settingsUnavailable)
  })

  it('没有侧栏服务时按钮退化成空操作，不把设置页带下水', async () => {
    // Given 一个没装 ui-sidebar-right 的上下文
    const { ctx, registrations } = makeCtx()
    installProgressUpdatesClient(ctx)
    const section = registrationOf(registrations, 'settings.section')
    const face = section.inject?.() as { openPanel: () => void }
    // When 点开面板
    // Then 不抛错（按钮永远不该把 GUI 带下水）
    expect(() => face.openPanel()).not.toThrow()
  })
})

describe('C. 取数：真的请求宿主路由', () => {
  const FIXTURE: ProgressUpdate = { id: 'pu-1', title: '读仓库结构', message: '已读完 packages 目录。', at: 1_700_000_000_000 }

  /** 假时钟：setInterval / setTimeout 只记账，测试自己决定什么时候打一拍。 */
  function makeTimers() {
    const intervals: Array<{ handler: () => void }> = []
    const timeouts: Array<{ handler: () => void }> = []
    return {
      intervals,
      timers: {
        setInterval: (handler: () => void) => { const h = { handler }; intervals.push(h); return h },
        clearInterval: (handle: unknown) => { const i = intervals.indexOf(handle as (typeof intervals)[number]); if (i >= 0) intervals.splice(i, 1) },
        setTimeout: (handler: () => void) => { const h = { handler }; timeouts.push(h); return h },
        clearTimeout: (handle: unknown) => { const i = timeouts.indexOf(handle as (typeof timeouts)[number]); if (i >= 0) timeouts.splice(i, 1) },
      },
    }
  }

  /** 等到所有微任务与已 resolve 的 promise 都跑完。 */
  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('面板订阅后确实发出指向 api/dsh-progress-updates/updates 的请求', async () => {
    // Given 一个假 fetch 与一个浏览器上下文
    const fakeFetch = vi.fn(async () => Response.json({ updates: [] }))
    vi.stubGlobal('fetch', fakeFetch)
    const { ctx, registrations } = makeCtx()
    installProgressUpdatesClient(ctx)
    const inject = registrationOf(registrations, 'sidebar.right.pane.tab').inject as (sessionId: string) => { source: ProgressSnapshotSource }
    // When 面板拿到注入的数据源并订阅（框架渲染页签正文时就是这么做的）
    const unsubscribe = inject('session-abc').source.subscribe(() => {})
    await flush()
    // Then —— 这一行就是「取数客户端真的发请求到那条路由」的证据
    expect(fakeFetch).toHaveBeenCalled()
    const [url] = fakeFetch.mock.calls[0] as unknown as [string]
    expect(String(url)).toContain(PROGRESS_UPDATES_PATH)
    expect(String(url)).toBe(`${PROGRESS_UPDATES_PATH}?session=session-abc`)
    // And 路径是文档相对的（子路径部署时靠它解析到入口目录）
    expect(String(url).startsWith('/')).toBe(false)
    unsubscribe()
  })

  it('路由返回的进展真的进到面板快照里，并渲染出来', async () => {
    // Given 宿主路由会返回一条进展
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ updates: [FIXTURE] })))
    const { ctx, registrations } = makeCtx()
    installProgressUpdatesClient(ctx)
    const inject = registrationOf(registrations, 'sidebar.right.pane.tab').inject as (sessionId: string) => { source: ProgressSnapshotSource }
    const source = inject('session-abc').source
    // When 面板组件订阅并渲染
    await act(async () => root.render(createElement(ProgressUpdatesTab, { source } as never)))
    await flush()
    // Then 快照里是那条进展，页面上也显示了它的标题
    expect(source.getSnapshot()).toEqual([FIXTURE])
    expect(container.textContent).toContain('读仓库结构')
    expect(container.textContent).toContain('共 1 条')
  })

  it('宿主 403 时保留上一份快照，不抛异常', async () => {
    // Given 第一次成功、第二次被宿主拒绝（loopback 之外的来源就是 403）
    const fakeFetch = vi.fn()
      .mockImplementationOnce(async () => Response.json({ updates: [FIXTURE] }))
      .mockImplementationOnce(async () => Response.json({ ok: false }, { status: 403 }))
    vi.stubGlobal('fetch', fakeFetch)
    const clock = makeTimers()
    const source = createHostProgressSource('s', { timers: clock.timers, isVisible: () => true })
    const unsubscribe = source.subscribe(() => {})
    await flush()
    const first = source.getSnapshot()
    expect(first).toHaveLength(1)
    // When 下一拍轮询撞上 403
    clock.intervals[0]?.handler()
    await flush()
    // Then 快照还是上一份，没有任何异常冒出来
    expect(source.getSnapshot()).toBe(first)
    unsubscribe()
  })

  it('没有订阅者时不发任何请求（页签关着 = 零流量）', async () => {
    const fakeFetch = vi.fn(async () => Response.json({ updates: [] }))
    vi.stubGlobal('fetch', fakeFetch)
    const clock = makeTimers()
    createHostProgressSource('s', { timers: clock.timers, isVisible: () => true })
    await flush()
    expect(fakeFetch).not.toHaveBeenCalled()
  })

  it('拿不到会话 id 时退化成不带 session 的请求', async () => {
    // Given 槽位没有把 sessionId 传下来
    const fakeFetch = vi.fn(async () => Response.json({ updates: [FIXTURE] }))
    vi.stubGlobal('fetch', fakeFetch)
    const clock = makeTimers()
    const source = createHostProgressSource(undefined, { timers: clock.timers, isVisible: () => true })
    const unsubscribe = source.subscribe(() => {})
    await flush()
    // Then 请求地址上没有 session 参数（宿主对空 session 的语义是「当前/合并桶」）
    const [url] = fakeFetch.mock.calls[0] as unknown as [string]
    expect(String(url)).toBe(PROGRESS_UPDATES_PATH)
    unsubscribe()
  })

  it('插件卸载时停掉所有轮询', async () => {
    // Given 子模块挂载并订阅了一份按会话的源
    const fakeFetch = vi.fn(async () => Response.json({ updates: [] }))
    vi.stubGlobal('fetch', fakeFetch)
    const { ctx, registrations, disposers } = makeCtx()
    installProgressUpdatesClient(ctx)
    const inject = registrationOf(registrations, 'sidebar.right.pane.tab').inject as (sessionId: string) => { source: ProgressSnapshotSource }
    const source = inject('session-abc').source
    const unsubscribe = source.subscribe(() => {})
    await flush()
    expect(fakeFetch).toHaveBeenCalledTimes(1)
    // When 插件行被卸载（effect 的清理函数全部执行）
    for (const dispose of disposers) dispose()
    // Then 原来那份源已经停掉：它后续的订阅者只登记监听，不再发请求
    //      （stop() 是终态——卸载路径上的一次迟到重订阅不能给插件留下常驻定时器）
    expect(() => source.subscribe(() => {})).not.toThrow()
    expect(fakeFetch).toHaveBeenCalledTimes(1)
    unsubscribe()
  })
})

describe('D. 侧栏页签：身份一致', () => {
  it('阶段一声明的 kind 与阶段二两处槽位注册的 key 对得上', () => {
    // Given 一个装着侧栏类型注册表与导航面的上下文
    const definitions: Array<{ id: string; kind: string; patterns?: readonly string[] }> = []
    const { ctx, registrations } = makeCtx({
      sidebarRightTabs: { register: (definition: { id: string, kind: string }) => { definitions.push(definition); return () => {} } },
      sidebarRight: { openTab: vi.fn() },
    })
    // When 子模块挂载
    installProgressUpdatesClient(ctx)
    // Then 恰好声明了一个页面型页签类型
    expect(definitions).toHaveLength(1)
    expect(definitions[0]!.kind).toBe(PANEL_TAB_KIND)
    expect(definitions[0]!.id).toBe(PANEL_TAB_ID)
    expect(definitions[0]!.patterns).toBeUndefined()
    // And 阶段二的两处 key 都等于阶段一的 id —— 两阶段对不上就渲染不出正文
    expect(registrationOf(registrations, 'sidebar.right.pane.tab').key).toBe(definitions[0]!.id)
    expect(registrationOf(registrations, 'sidebar.right.pane.tab.title').key).toBe(definitions[0]!.id)
  })

  /**
   * 回归守卫：右侧栏 guide 页里必须有「进展更新」那一格。
   *
   * 页签类型只是声明，**guide 条目才是用户在右侧栏里看得见、点得到的入口**。
   * 线上真出现过这一格缺失：面板注册齐全但右侧栏空着，用户根本找不到它。
   * 所以这里钉住三件事：有一条 guide 项、它有标题与彩色图标、它是点得开的。
   */
  it('右侧栏 guide 里有一格进展更新，且带彩色图标', () => {
    // Given 装着侧栏类型注册表的上下文
    const definitions: Array<{
      id: string
      kind: string
      guide?: ReadonlyArray<{ id: string, order: number, title: () => string, description?: () => string, icon?: unknown }>
    }> = []
    const { ctx } = makeCtx({
      sidebarRightTabs: { register: (definition: never) => { definitions.push(definition); return () => {} } },
      sidebarRight: { openTab: vi.fn() },
    })
    // When 子模块挂载
    installProgressUpdatesClient(ctx)
    // Then 恰好一格 guide 入口，且它带着可渲染的标题与图标
    const guide = definitions[0]?.guide
    expect(guide).toBeDefined()
    expect(guide).toHaveLength(1)
    expect(guide![0]!.title()).toBe(zh.progressTitle)
    expect(guide![0]!.order).toBeTypeOf('number')
    // icon 必须是组件（平台会把它当 ComponentType 渲染），不是字符串也不是空
    expect(typeof guide![0]!.icon === 'function' || typeof guide![0]!.icon === 'object').toBe(true)
    // And 说明行也走本插件字典，不是硬编码
    expect(guide![0]!.description?.()).toBe(zh.progressGuideNote)
  })

  it('guide 图标能渲染出彩色 SVG（不依赖 currentColor）', async () => {
    const { ProgressUpdatesArtwork } = await import('../src/client/progress-updates/guide-artwork.tsx')
    await act(async () => root.render(createElement(ProgressUpdatesArtwork, { size: 36 })))
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg!.getAttribute('viewBox')).toBe('0 0 36 36')
    // 带自己的填充色（渐变引用或十六进制），而不是完全交给 currentColor
    expect(container.innerHTML).toContain('linearGradient')
    expect(container.innerHTML).toMatch(/#[0-9A-Fa-f]{6}/)
  })
})

describe('E. 进展更新的 ProgressUpdate 与宿主同形（双向赋值）', () => {
  it('客户端类型可以喂给宿主类型，反之亦然', () => {
    // Given 一条按客户端契约构造的进展
    const client: ProgressUpdate = { id: 'a', title: 't', message: 'm', at: 1, source: 's' }
    // When/Then 它可以原样当作宿主那一份用——形状漂移会在这里编译失败
    const host: HostProgressUpdate = client
    expect(host).toEqual(client)
    const back: ProgressUpdate = host
    expect(back).toEqual(client)
  })
})

describe('F. 面板的三个已修问题（回归守卫）', () => {
  /**
   * 守卫一：多条可以**同时**展开。
   * 线上真出现过：展开下面那条会把上面那条关掉，因为展开状态是单个 id。
   */
  it('展开两条时两条都保持展开，互不排挤', async () => {
    const updates = [
      { id: 'a', title: '第一条', message: '正文 A', at: 1 },
      { id: 'b', title: '第二条', message: '正文 B', at: 2 },
    ]
    await act(async () => root.render(createElement(ProgressUpdatesPanel, { updates } as never)))
    const headers = () => Array.from(container.querySelectorAll('[data-dsh-part="update-header"]'))
    // 默认最新一条（b）展开、a 收起
    expect(headers()[0]!.getAttribute('aria-expanded')).toBe('false')
    expect(headers()[1]!.getAttribute('aria-expanded')).toBe('true')
    // 展开 a 之后，b **仍然**展开 —— 这就是本条要钉住的行为
    await act(async () => headers()[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(headers()[0]!.getAttribute('aria-expanded')).toBe('true')
    expect(headers()[1]!.getAttribute('aria-expanded')).toBe('true')
    // 两条正文同时在场
    expect(container.querySelectorAll('[data-dsh-part="update-message"]')).toHaveLength(2)
  })

  /** 守卫二：正文真的按 Markdown 渲染，不是原文照搬。 */
  it('正文里的列表与行内标记渲染成元素，而不是原样显示星号', async () => {
    const updates = [{
      id: 'a',
      title: '带格式的进展',
      message: '这一段是**粗体**与 `代码`。\n\n- 第一条\n- 第二条',
      at: 1,
    }]
    await act(async () => root.render(createElement(ProgressUpdatesPanel, { updates } as never)))
    const body = container.querySelector('[data-dsh-part="update-message"]')!
    // 块级：列表被解析成 li
    expect(body.querySelectorAll('li')).toHaveLength(2)
    // 行内：粗体与代码成为元素
    expect(body.querySelector('[data-dsh-part="md-strong"]')?.textContent).toBe('粗体')
    expect(body.querySelector('[data-dsh-part="md-code"]')?.textContent).toBe('代码')
    // 原文的双星号与反引号不该以纯文本形式残留
    expect(body.textContent).not.toContain('**粗体**')
  })

  /** 守卫三：计数文案的 {n} 必须被替换（线上出现过「共 {n} 条」）。 */
  it('计数文案的占位符被替换成真实条数', async () => {
    const updates = [
      { id: 'a', title: '一', message: 'x', at: 1 },
      { id: 'b', title: '二', message: 'y', at: 2 },
    ]
    await act(async () => root.render(createElement(ProgressUpdatesPanel, { updates } as never)))
    const count = container.querySelector('[data-dsh-part="updates-count"]')!.textContent ?? ''
    expect(count).not.toContain('{n}')
    expect(count).toContain('2')
  })
})
