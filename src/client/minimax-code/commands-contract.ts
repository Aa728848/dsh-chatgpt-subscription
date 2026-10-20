/**
 * 宿主命令契约的类型入口。
 *
 * ## 为什么要绕这一层
 *
 * 这些形状住在 `@deepseek-ai/dsh-client-ui-commands` 里，而那个包**只提供类型**给本
 * 插件：运行时服务由宿主 web app 装配好，通过 `ctx.commandUi` 交过来。所以这里
 * 一律 `import type`，`export type` 转发——**任何一处写成值导入，宿主的运行时就会
 * 被打进本插件自己的 `lib/client.js`**，两个副本注册同一个服务名是比编译错误难查
 * 得多的问题。
 *
 * 转发而不是在各文件里直接 import，是为了让「本插件只依赖这些类型」这件事有一个
 * 可以一眼看完的地方。
 *
 * ## 依赖声明
 *
 * `package.json` 里它同时出现在 `peerDependencies`（宽范围，与其余六个
 * `dsh-client-*` 相同的写法）和 `devDependencies`（`^0.2.1-rc.1`，编译期需要）。
 * 运行时不从这里取任何东西。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/minimax-code/commands-contract
 */

export type {
  ActionSpec,
  CommandContribution,
  CommandUiContract,
  CommandUiSpec,
  PopupSelectSpec,
  SelectOption,
  SelectOptionGroup,
} from '@deepseek-ai/dsh-client-ui-commands/client'

/**
 * 命令回调拿到的会话投影。
 *
 * 它来自 `@deepseek-ai/dsh-client-ui-input-trigger/client` 的
 * `ClientSessionContext`，那个包同样只提供类型、同样不是本插件的直接依赖；而这个
 * 形状只有一个字段，抄一行比再挂一个 peer 便宜。
 */
export interface CommandSessionContext {
  /** 会话身份。宿主不交出 provider、也不交出 RPC —— 见 video-command.ts 顶部。 */
  readonly sessionId: string
}
