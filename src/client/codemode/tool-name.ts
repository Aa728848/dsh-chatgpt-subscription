/**
 * 客户端半边的 `code_run` 工具名常量。
 *
 * 独立于 `../../host/codemode/transport.ts`，避免浏览器 bundle 引入 Node 端模块；
 * 单测会校验两边字面量逐字一致。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/codemode/tool-name
 */

export const CODE_RUN_TOOL_NAME = 'code_run'
