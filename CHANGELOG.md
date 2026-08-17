# Changelog

## 0.1.10 - 2026-08-17

- 移除临时 Bash Prompt 兼容模块：由于上游 DSH `0.1.0-rc.7` 已经原生修复持久化 Bash 提示符不匹配与重置问题，现按照标记 `DSH_COMPAT_REMOVE(persistent-bash-prompt-mismatch)` 安全移除全部相关兼容代码与测试。保留子代理报告去重兼容模块 `DSH_COMPAT_REMOVE(subagent-report-settlement-dedup)`。
- 增强 Responses Mapper 对 DSH `0.1.0-rc.7` 中新版规范 `ReplayEnvelope` 嵌套结构（`response.outputItems`）的兼容解构支持。

## 0.1.8 - 2026-08-17

- 修复 Cordis 插件依赖安全检查：使用 `ctx.inject(['terminals'], ...)` 作用域安全声明，解决在未加载 terminals 服务的 Profile 或非终端环境下直接访问 `ctx.terminals` 抛出 `cannot get property "terminals" without inject` 的启动崩溃问题。

## 0.1.7 - 2026-08-17

- 临时兼容 DSH `0.1.0-rc.6` 持久化 Bash 提示符不匹配（70倍命令提速）：修补 PTY 会话在 `tool-bash-persistent` 设置 `__DSH_PERSISTENT_BASH_PROMPT__ ` 时的就绪判定，避免因底层硬编码 `dsh> ` 及 6 字符截断导致回退到 3.5 秒静默超时。代码统一标记为 `DSH_COMPAT_REMOVE(persistent-bash-prompt-mismatch)`，待 DSH 原生修复后可整体移除。

## 0.1.6 - 2026-08-17

- 临时兼容 DSH `0.1.0-rc.6` 的子代理报告去重：当 `subagent-settled` 已携带与同一子代理排队 `subagent-report` 完全相同的最终内容时，删除重复报告，保留 settlement 通知；部分报告、不同内容和不同子代理不受影响。代码统一标记为 `DSH_COMPAT_REMOVE(subagent-report-settlement-dedup)`，待 DSH 原生修复后可整体移除。
- 新增 Linux Host 支持：平台凭据存储选择、用户私有 `0600` TokenStore，以及 Bash/POSIX shell 工具调用兼容说明与测试。
- 设置页现在根据 Host 返回值展示 Windows DPAPI 或 Linux 文件存储及其真实安全边界。
- 移除与 Codex 订阅接入无关的执行过程详情折叠功能。

## 0.1.2 - 2026-08-16

- 优化过程详情折叠（Process folding）的初始化时机与节点匹配探测逻辑。
- 增强客户端 DOM 观察与挂载测试用例覆盖。

## 0.1.1 - 2026-08-16

- 新增执行过程详情与思考过程的可折叠展示机制（Collapsible process detail folding）。
- 增强客户端与服务端 Responses 过程解析及 UI 交互。

## 0.1.0 - 2026-08-16

- 首个正式版本发布。
- 完善客户端 UI 样式体系与 `@eddyskywalker` 命名空间配置。
- 增强命令执行工具与无状态安全重试机制。

## 0.1.0-alpha.0 - 2026-08-14

- 新增 DSH Host/Client 双端插件与一级“Codex 订阅”设置入口。
- 新增 ChatGPT OAuth PKCE、localhost callback、DPAPI TokenStore、刷新和注销。
- 新增 `codex-chatgpt` LLM Adapter、固定 Responses SSE、vision、reasoning 与工具调用映射。
- 新增 401 单次刷新重试、DSH 有界 retry policy、取消与安全工具参数校验。
- 新增 Wham usage 双 bucket/双窗口解析、缓存、节流、连接测试和可访问进度条。
- 新增 OAuth、路由、DPAPI、Responses、额度与 Client 注册测试。
- 修复 OAuth 失败详情被状态刷新清空、旧 keep-alive 回调连接复用，以及 refresh token 失效后重复尝试的问题；token exchange 现在显示脱敏错误标识。
- 修复工具调用 replay 缺失时仍发送孤立 `function_call_output` 导致 Codex 返回 400；现在会补全调用配对，并安全处理被压缩历史中的孤立结果。

这是首个 prerelease；没有稳定版升级承诺。ChatGPT backend compatibility 可能随上游变化。
