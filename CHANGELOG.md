# Changelog

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
