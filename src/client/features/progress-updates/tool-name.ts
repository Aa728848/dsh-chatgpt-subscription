/**
 * 客户端半边的工具名常量。
 *
 * 不能直接从 `../../host/progress-updates/tool.ts` 取 `NOTIFY_USER_TOOL`：那一侧
 * import 了 `@deepseek-ai/dsh-tools` 的 `defineTool`，浏览器闭包包拉进宿主工具
 * 注册表既无意义也违反客户端的模块纯度纪律（客户端 tsconfig 的 include 也不含
 * `src/host/**`）。这里按同一份冻结契约再写一遍，由
 * `test/progress-updates-client.test.tsx` 断言它与宿主侧逐字相同。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/progress-updates/tool-name
 */

/** 注册的工具名（与 `../../host/progress-updates/tool.ts` 的 `NOTIFY_USER_TOOL` 同一冻结契约）。 */
export const PROGRESS_UPDATE_TOOL_NAME = 'progress_update'
