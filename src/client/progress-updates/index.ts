/**
 * 「进展更新」浏览器半边的挂载点 —— 本插件的一个子模块，由
 * `src/client/index.tsx` 调用 {@link installProgressUpdatesClient}。
 *
 * 复刻 Kimi Code 的「进展更新」在网页里的那一半。挂四样东西：
 *
 * 1. **对话流的进展行**（主形态）：给 `progress_update` 工具注册
 *    `tool.call.toolview` 视图，agent 每发一条进展，对话里就多一行；
 * 2. 侧栏页签的**类型**（阶段一，`ctx.sidebarRightTabs.register`）——
 *    没有它，下面的正文与标题注册得再对，面板也永远打不开；
 * 3. 侧栏页签的正文与标题（阶段二，`sidebar.right.pane.tab` /
 *    `sidebar.right.pane.tab.title`），键都是阶段一的 id；
 * 4. 设置页里的「进展更新」分区（`settings.section`，**独立一格**，不与订阅服务
 *    那格合并），点击「打开进展面板」调 `ctx.sidebarRight.openTab(kind)`。
 *
 * 字典与样式**不在这里登记**：`src/client/index.tsx` 像其余每条线路一样，自己
 * `ctx.locale.register(NS_PROGRESS_UPDATES, …)` 并安装样式表，本模块只挂槽位
 * ——同一个命名空间注册两次在真实 locale 服务里会抛重复登记，那是会被吞掉但毫无
 * 意义的第二次调用。
 *
 * ## 三段式依赖与降级
 *
 * ui-sidebar-right 不一定装着：页签类型注册与打开面板都在「服务在不在」的检查
 * 之后才做，缺了它就只留对话流行与设置页（按钮点了没反应而不是报错）。对话流视图
 * 本身只依赖 slots，所以它一定挂得上。
 *
 * ## 数据从哪来
 *
 * 侧栏面板**不读对话流**，它的数据只来自宿主半边的
 * `GET /api/dsh-progress-updates/updates?session=<id>` 路由
 * （`src/host/progress-updates/routes.ts`）。宿主与浏览器是两个运行时，中间只有
 * 同源 HTTP，所以浏览器这边必须**主动去读** —— 轮询客户端在 `./host-source.ts`。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/progress-updates
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SidebarRightTabDefinition, SidebarRightTabRegistryService } from './contracts.ts'
import { ProgressUpdatesArtwork } from './guide-artwork.tsx'
import { ProgressRow } from './progress-row.tsx'
import { ProgressUpdatesSettingsSection } from './settings-section.tsx'
import { ProgressUpdatesTab, ProgressUpdatesTabTitle, type ProgressSnapshotSource } from './updates-panel.tsx'
import { PROGRESS_UPDATE_TOOL_NAME } from './tool-name.ts'
import { createHostProgressSource, isProgressUpdatesHostPresent, type HostProgressSource } from './host-source.ts'
import { createProgressSettingsForm, type ProgressSettingsForm } from './settings-binding.ts'
import { NS_PROGRESS_UPDATES, zh } from './locales.ts'

/**
 * 本实现在右侧栏页签系统里的身份：它既是阶段一 `sidebarRightTabs` 里的 `id`，
 * 也是阶段二两处 keyed 槽位注册用的键。
 */
export const PANEL_TAB_ID = '@eddyskywalker/dsh-chatgpt-subscription/progress-updates'

/**
 * 页签类型判别值（`kind`）：`ctx.sidebarRight.openTab` 用它点名。语义上是
 * 「一类页签」，所以与上面的身份分开写。
 */
export const PANEL_TAB_KIND = 'progress-updates'

/**
 * 设置页那一格的 id。
 *
 * **独立一格**：本插件的订阅服务 hub 注册的是 `subscription-hub`（order 45），
 * 进展更新不进那一格——用户要求它是一个单独的分区。
 */
export const SETTINGS_SECTION_ID = 'progress-updates'

/**
 * 导航顺序：**150**，排在所有既有条目之后。
 *
 * 既有 order 分布（plugin 侧 `subscription-hub` = 45；平台侧 general=0、
 * models=10、plugins=15、agent-presets=20、account=-10）。150 远在这条线之外，
 * 既不会撞号，也不会把订阅服务那一格挤到别的位置——新条目只往后拿号。
 */
export const SETTINGS_SECTION_ORDER = 150

/** 浏览器半边的挂载参数。 */
export interface ProgressUpdatesClientOptions {
  /**
   * 面板数据源；**显式传入时优先**（测试、将来替换取数实现都走这里）。
   * 缺省时按会话各建一份宿主路由轮询源，见 {@link createHostProgressSource}。
   */
  source?: ProgressSnapshotSource
  /**
   * 打开侧栏面板的通道；缺省时读 `ctx.sidebarRight`。测试注入一个假通道来断言
   * 「按钮真的调了 openTab」。
   */
  openPanel?: (kind: string) => void
  /**
   * 设置表单通道；缺省时从 `ctx.configForms` 现取。测试注入一个假的来断言
   * 「开关写的是本插件 Config 的那两个字段」。
   */
  settings?: ProgressSettingsForm
}

/**
 * 从上下文里读一个可选服务，读不到就当作没有。
 *
 * 只有 `get` 是 Cordis 的基础成员；没写进 `inject` 的服务名直接当属性读会抛错，
 * 而这里要读的 `configForms` / `sidebarRight*` 都是可选的，所以一律走 `get`。
 * @param ctx - 浏览器根上下文。
 * @param name - 服务名。
 * @returns 服务实例或 undefined。
 */
function serviceOf(ctx: ClientContext, name: string): unknown {
  try {
    return (ctx as unknown as { get(name: string): unknown }).get(name)
  } catch {
    // 上下文拒绝查询（服务不存在或已卸载）：按缺失处理。
    return undefined
  }
}

/**
 * 解析「打开面板」这一动作。
 *
 * 优先用调用方显式给的通道（测试、将来换实现），否则读 `ctx.sidebarRight`，
 * 都没有时退化成空操作——设置页的按钮永远不该把 GUI 带下水。
 *
 * 每次点击都重新读一遍服务：页签服务可能比本插件晚挂载，也可能中途被卸载，
 * 在 apply 时抓一份闭包会把这两种情况都写成死值。
 * @param ctx - 浏览器根上下文。
 * @param explicit - 调用方显式传入的通道。
 * @returns 打开面板的动作。
 */
function openPanelAction(ctx: ClientContext, explicit?: (kind: string) => void): () => void {
  return () => {
    if (explicit !== undefined) {
      explicit(PANEL_TAB_KIND)
      return
    }
    const sidebarRight = serviceOf(ctx, 'sidebarRight') as { openTab?: (kind: string) => void } | undefined
    if (typeof sidebarRight?.openTab !== 'function') return
    sidebarRight.openTab(PANEL_TAB_KIND)
  }
}

/**
 * 挂载「进展更新」的浏览器半边。
 *
 * 失败策略与家族其它模块一致：槽位/页签注册失败只吞掉、不抛出 —— web shell 在
 * 插件 apply 抛错时会整页启动失败，外部插件不能把 GUI 带下水。
 * @param ctx - 浏览器根上下文。
 * @param options - 可选的数据源、打开面板通道与设置表单通道。
 */
export function installProgressUpdatesClient(ctx: ClientContext, options: ProgressUpdatesClientOptions = {}): void {
  /**
   * 调用方显式给的数据源：给了就一直用它，不再发任何 HTTP（测试与将来替换用）。
   */
  const explicitSource = options.source

  /**
   * 宿主那一行是不是装着。
   *
   * 同包多组件之后，关掉「进展更新」只会卸掉宿主那一行：浏览器半边仍随本包的
   * bundle 加载，面板与设置分区就会变成永远空的壳。启动时问一次宿主的只读路由，
   * 缺了就撤掉已经注册的槽位、并且不再响应后续出现的槽位。
   *
   * 显式给了数据源（测试与将来替换实现）时不探测：那时宿主根本不在链路里。
   */
  let hostPresent = true
  const registrations: Array<() => void> = []
  const keep = (dispose: () => void): () => void => {
    registrations.push(dispose)
    return dispose
  }
  if (explicitSource === undefined) {
    void isProgressUpdatesHostPresent().then((present) => {
      if (present) return
      hostPresent = false
      for (const dispose of registrations.splice(0)) {
        try {
          dispose()
        } catch {
          // 槽位服务已经卸载：没有东西可撤。
        }
      }
    })
  }

  /**
   * 默认数据源：每个会话一份轮询源。
   *
   * 槽位是 session 作用域的，同一个页签在会话切换时会被重新注入一次；按会话 id
   * 缓存，切回原会话不会白起一个客户端。sessionId 拿不到（`undefined`）时退化
   * 到不带 `?session=` 的请求，宿主对空 session 的语义是"当前/合并桶"。
   */
  const hostSources = new Map<string, HostProgressSource>()

  /**
   * 取当前会话对应的一份宿主轮询源（不存在就建）。
   * @param sessionId - 框架注入的会话 id；`undefined` 表示当前没有会话身份。
   * @returns 该会话的面板数据源。
   */
  const hostSourceOf = (sessionId: string | undefined): HostProgressSource => {
    const key = sessionId ?? ''
    let source = hostSources.get(key)
    if (source === undefined) {
      source = createHostProgressSource(sessionId === undefined || sessionId === '' ? undefined : sessionId)
      hostSources.set(key, source)
    }
    return source
  }

  /**
   * 设置表单通道。
   *
   * 调用方给了就用它；否则从 `ctx.configForms` 现取一份，并登记到本插件的 effect
   * 上（插件卸载时释放镜像订阅）。若 `configForms` 晚于本插件挂载，设置页渲染时
   * 再次按需获取；服务始终缺席时是 undefined——卡片据此渲染成只读。
   */
  let settings: ProgressSettingsForm | undefined = options.settings
  const resolveSettings = (): ProgressSettingsForm | undefined => {
    if (settings !== undefined) return settings
    const form = createProgressSettingsForm(ctx as unknown as { get(name: string): unknown })
    if (form !== undefined) {
      settings = form
      ctx.effect(() => () => {
        form.dispose()
        if (settings === form) settings = undefined
      }, 'dsh-progress-updates: settings form')
    }
    return settings
  }
  resolveSettings()

  // 卸载时停掉所有轮询：插件行被禁用后不该还有请求在飞。
  ctx.effect(() => () => {
    for (const source of hostSources.values()) {
      try {
        source.stop()
      } catch {
        // 停止失败没有补救手段，也不该冒到卸载路径上。
      }
    }
    hostSources.clear()
  }, 'dsh-progress-updates: poll lifecycle')

  /**
   * 取侧栏页签类型注册表。
   *
   * 属性读只在服务名确实在当前 scope 的 inject 名单里时合法——本插件自己的
   * 静态 `inject` 没有 `sidebarRightTabs`，属性读会被 Cordis 拒绝，所以先试
   * 属性、失败再退回 `get()`（服务缺席时按缺失处理）。
   *
   * @param scope - 浏览器根上下文，或 `ctx.inject(['sidebarRightTabs'], ...)` 交来的 scope。
   * @returns 注册表实例，或 undefined。
   */
  const tabsOf = (scope: ClientContext): SidebarRightTabRegistryService | undefined => {
    try {
      const direct = (scope as unknown as { sidebarRightTabs?: SidebarRightTabRegistryService }).sidebarRightTabs
      if (direct !== undefined) return direct
    } catch {
      // Cordis 拒绝这次属性读（服务不在该 scope 的 inject 名单里）：按缺失处理。
    }
    return serviceOf(scope, 'sidebarRightTabs') as SidebarRightTabRegistryService | undefined
  }

  /**
   * 阶段一：声明页签**类型**。
   *
   * 这一步是面板能打开的前提。`patterns` 省略 = 页面型页签，按 kind 打开。
   * 服务不存在（没装 ui-sidebar-right）时整段跳过：对话流行与设置页照常挂上；
   * 若 `sidebarRightTabs` 晚于本插件挂载，通过 `ctx.inject(['sidebarRightTabs'], ...)`
   * 在服务就绪时自动补注册。
   */
  const registerTabDefinition = (targetCtx: ClientContext): (() => void) => {
    const tabs = tabsOf(targetCtx)
    if (typeof tabs?.register !== 'function') return () => {}
    try {
      const definition: SidebarRightTabDefinition = {
        id: PANEL_TAB_ID,
        kind: PANEL_TAB_KIND,
        title: () => {
          try {
            return ctx.locale.bind(NS_PROGRESS_UPDATES)('progressTitle')
          } catch {
            return zh.progressTitle
          }
        },
        // 右侧栏 guide 页里的那一格：没有它，面板虽然注册好了却没有任何可见入口
        // （截图里那四张卡片就是 guide 条目，不是槽位注册出来的）。
        guide: [{
          id: 'open',
          order: 60,
          title: () => {
            try {
              return ctx.locale.bind(NS_PROGRESS_UPDATES)('progressTitle')
            } catch {
              return zh.progressTitle
            }
          },
          description: () => {
            try {
              return ctx.locale.bind(NS_PROGRESS_UPDATES)('progressGuideNote')
            } catch {
              return zh.progressGuideNote
            }
          },
          icon: ProgressUpdatesArtwork,
        }],
      }
      return tabs.register(definition)
    } catch {
      return () => {}
    }
  }
  const immediateTabs = tabsOf(ctx)
  const injectService = (ctx as unknown as {
    inject?: (deps: readonly string[], callback: (scope: ClientContext) => void) => void
  }).inject
  if (typeof immediateTabs?.register === 'function' || typeof injectService !== 'function') {
    // 服务已经在位（或这个上下文没有 inject 能力）：就地注册。
    ctx.effect(() => registerTabDefinition(ctx), 'dsh-progress-updates: tab type')
  } else {
    // 服务还没上线：等它上线时补注册，否则右侧栏里永远没有这一格。
    injectService.call(ctx, ['sidebarRightTabs'], (scope) => {
      scope.effect(() => registerTabDefinition(scope), 'dsh-progress-updates: tab type')
    })
  }

  /**
   * 对话流里的进展行：`progress_update` 每次调用渲染成一行。
   *
   * 这是本特写的主形态——不依赖侧栏，也不依赖宿主路由，只看工具调用的参数。
   */
  ctx.slots.inject('tool.call.toolview', () => {
    if (!hostPresent) return () => {}
    try {
      return keep(ctx.slots.register({
        name: 'tool.call.toolview',
        key: PROGRESS_UPDATE_TOOL_NAME,
        locale: NS_PROGRESS_UPDATES,
      }, ProgressRow))
    } catch {
      return () => {}
    }
  })

  /** 阶段二：同一个 id 下渲染页签正文。 */
  ctx.slots.inject('sidebar.right.pane.tab', () => {
    if (!hostPresent) return () => {}
    try {
      return keep(ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: PANEL_TAB_ID,
        locale: NS_PROGRESS_UPDATES,
        // session 作用域的注入工厂：第一个实参就是当前会话 id。
        inject: (sessionId: string) => ({
          source: explicitSource ?? hostSourceOf(sessionId),
        }),
      }, ProgressUpdatesTab))
    } catch {
      return () => {}
    }
  })

  /** 阶段二：同一个 id 下渲染页签条上的标题。 */
  ctx.slots.inject('sidebar.right.pane.tab.title', () => {
    if (!hostPresent) return () => {}
    try {
      return keep(ctx.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: PANEL_TAB_ID,
        locale: NS_PROGRESS_UPDATES,
      }, ProgressUpdatesTabTitle))
    } catch {
      return () => {}
    }
  })

  /**
   * 设置页里的「进展更新」：**独立一格**，不与订阅服务那格合并。
   *
   * 没有这一格，面板就是注册好了也永远点不开——类型和正文都不会自己长出入口。
   */
  ctx.slots.inject('settings.section', () => {
    if (!hostPresent) return () => {}
    try {
      const openPanel = openPanelAction(ctx, options.openPanel)
      return keep(ctx.slots.register({
        name: 'settings.section',
        id: SETTINGS_SECTION_ID,
        order: SETTINGS_SECTION_ORDER,
        label: () => {
          try {
            return ctx.locale.bind(NS_PROGRESS_UPDATES)('navTitle')
          } catch {
            return zh.navTitle
          }
        },
        locale: NS_PROGRESS_UPDATES,
        inject: () => {
          const currentSettings = resolveSettings()
          return currentSettings === undefined ? { openPanel } : { openPanel, settings: currentSettings }
        },
      }, ProgressUpdatesSettingsSection))
    } catch {
      return () => {}
    }
  })
}
