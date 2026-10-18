/**
 * 「进展更新」浏览器半边的平台契约与线格式类型。
 *
 * ## 为什么要自己声明槽位
 *
 * `tool.call.toolview` 与 `settings.section` 由本插件已安装的 ui-tool /
 * ui-settings 在 `SlotMap` 上合并出来，所以**这两条不在这里重复声明**——同一个
 * SlotsMap 条目被两份形状不同的 augmentation 各写一次是编译错误。
 *
 * 而右侧栏的两处槽位（`sidebar.right.pane.tab` / `sidebar.right.pane.tab.title`）
 * 以及 `ctx.sidebarRightTabs` / `ctx.sidebarRight` 两个服务，由 ui-sidebar-right
 * 提供，它不是本插件的依赖：装了才有，没装就没有。为了这两条槽位去依赖那个包，
 * 等于把一个可选能力变成硬依赖。所以这里按平台同形把它们**声明**出来——运行
 * 语义完全由平台的槽位注册表决定，这里只是让 register/inject 的实参过类型检查。
 *
 * ## 为什么 ProgressUpdate 在这里再写一遍
 *
 * 宿主那一份在 `src/host/progress-updates/store.ts`。客户端 tsconfig 的
 * `rootDir` 是 `src`、include 只覆盖 `src/client/**` 与 `src/shared/**`，
 * 从浏览器半边 import 宿主模块既越界也会把宿主依赖拖进客户端闭包。两份形状必须
 * 逐字一致，由 `test/progress-updates-client.test.tsx` 的双向赋值断言钉住。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/progress-updates/contracts
 */

/** 一条已展示的进展（与 `src/host/progress-updates/store.ts` 的 `ProgressUpdate` 同形）。 */
export interface ProgressUpdate {
  /** 稳定标识，同一会话内唯一。 */
  id: string
  /** 单行标题，约 60 字以内，用户语言，纯文本，无 Markdown。 */
  title?: string
  /** 详情正文，约 1000 字以内，轻 Markdown。 */
  message: string
  /** 产生时刻，Unix 毫秒时间戳。 */
  at: number
  /** 来源标签（计数会话 id）。 */
  source?: string
}

/**
 * 右侧栏页签类型的注册面（阶段一）。
 *
 * 字段与官方 `SidebarRightTabDefinition` 同形，完整定义在 ui-sidebar-right 的
 * tab-registry 里；本插件只用到 id / kind / title。
 */
export interface SidebarRightTabDefinition {
  /** 本实现在页签系统里的身份，全域唯一，也是阶段二注册用的 key。 */
  readonly id: string
  /** 页签类型判别值，`openTab` 用它点名。 */
  readonly kind: string
  /** 资源地址 glob；**省略 = 页面型页签**，按 kind 打开。本面板不认领地址。 */
  readonly patterns?: readonly string[]
  /** 优先级档位；不表态时平台按 extension 处理。 */
  readonly priority?: 'extension' | 'builtin' | 'fallback'
  /** 页签条上的标题，打开时捕获。 */
  readonly title: (address: string) => string
}

/** 右侧栏页签类型注册表（阶段一的服务面）。 */
export interface SidebarRightTabRegistryService {
  /**
   * 注册一个页签类型。
   * @param definition - 类型的静态声明。
   * @returns 幂等卸载函数。
   */
  register(definition: SidebarRightTabDefinition): () => void
  /**
   * 读一个 kind 当前生效的类型。
   * @param kind - 类型判别值。
   * @returns 注册定义；没有注册时 undefined。
   */
  get?(kind: string): unknown
}

/** 右侧栏导航面：按 kind 打开一个页面型页签。 */
export interface SidebarRightService {
  /**
   * 按 kind 打开一个页面型页签。
   * @param kind - 阶段一声明过的类型判别值。
   */
  openTab(kind: string): void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * 右侧栏一个页签的正文，按页签类型的 id 分发（session 作用域的注入工厂会
     * 拿到当前会话 id）。本页签不消费平台给的其他注入面，所以只声明驱动
     * register/inject 过类型检查的这两轴。
     */
    'sidebar.right.pane.tab': { kind: 'keyed'; scope: 'session' }
    /** 同一个页签在标签条上显示的标题。 */
    'sidebar.right.pane.tab.title': { kind: 'keyed'; scope: 'session' }
  }
}
/*
 * `ctx.sidebarRightTabs` / `ctx.sidebarRight` 这两个服务 **刻意不 declare module
 * 到 cordis 上**。
 *
 * 实测：只要 src/client/** 里出现一条 `declare module '@deepseek-ai/cordis'` 的
 * Context 合并（哪怕文件里一个 import 都没有），本客户端工程里 cordis 自己的
 * `interface Context extends Pick<Fiber, 'effect'>` 就整片失效——同一个 tsc 会开始
 * 报 `Property 'effect' does not exist on type 'Context'`，连既有未改动的
 * src/client/index.tsx 都一起报。那是官方 augmentation 被顶掉的症状，收不回成本。
 *
 * 这两个服务本来就是**可选的**（装了 ui-sidebar-right 才有），本模块一律经
 * serviceOf() 以 unknown 取回再窄化，不依赖 Context 上的静态声明。这样也正好
 * 与本插件其余客户端模块保持一致：今天没有任何一个客户端文件合并 cordis 的
 * Context。
 */
