# DSH ChatGPT Subscription

让 DSH（DeepSeek Host）通过 ChatGPT 订阅使用 Gpt 系列模型的插件。

插件注册 `codex-chatgpt` Provider（显示名 **“Codex（ChatGPT 订阅）”**），以当前 Windows 用户的 ChatGPT OAuth 登录态访问模型，并在设置页展示账号信息、连接状态与订阅额度。

## 目录

- [功能特性](#功能特性)
- [模型目录](#模型目录)
- [环境要求](#环境要求)
- [安装](#安装)
- [使用](#使用)
- [升级、降级与卸载](#升级降级与卸载)
- [安全边界](#安全边界)
- [插件路由](#插件路由)
- [开发与验证](#开发与验证)
- [故障排查](#故障排查)

## 功能特性

**登录与会话**

- Authorization Code + PKCE（S256）登录，一次性 localhost 回调；
- 支持 token 刷新、登录取消与账号注销；
- token 使用 Windows CurrentUser DPAPI 加密存储，明文不发送给 Client。

**模型接入**

- 固定 Codex Responses 地址，支持流式文本、reasoning summary、图片输入与工具调用/结果；
- 429/5xx 由 DSH retry policy 接管；401 只强制刷新并重试一次，支持 `AbortSignal`；
- Codex 与 Code review 多窗口额度，60 秒缓存、15 秒上游节流并遵守 `Retry-After`。

**设置页**

- 展示账号（脱敏 email、套餐、账号 ID 后四位）、连接状态与额度；
- 可访问的进度条、窄窗口/200% 缩放布局、深浅主题与 reduced-motion。

## 模型目录

`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini`、`gpt-5.2`

> 目录只用于展示；账号实际可用的模型由 ChatGPT 套餐、workspace 策略与上游兼容状态决定。

## 环境要求

- Windows（DPAPI 依赖当前 Windows 用户）；
- 已安装 DSH，且具备 `dsh` CLI 或 DSH 桌面版的插件管理能力；
- Node.js 与 npm。

## 安装

```powershell
cd C:\absolute\path\to\dsh-chatgpt-subscription
npm install
npm run build
dsh plugin --profile web add link:C:\absolute\path\to\dsh-chatgpt-subscription
```

如果本机没有 `dsh` CLI，请通过提供同等插件管理能力的 DSH 桌面版安装此目录；不要手工修改 DSH 核心文件。

## 使用

1. 重启 `dsh web`；
2. 打开 **设置 → Codex 订阅**；
3. 完成 ChatGPT 登录；
4. 执行 **测试连接**。

DSH 模型选择器应显示 **“Codex（ChatGPT 订阅）”**。

卸载前建议先在设置页点击 **“注销”**，它会删除 DPAPI 凭据和 Host 内存中的额度缓存


若 DSH 已异常退出，可在确认路径后删除凭据文件 `oauth.dpapi`：

- `%DSH_HOME%\storages\dsh-chatgpt-subscription\oauth.dpapi`
- 未设置 `DSH_HOME` 时为 `%USERPROFILE%\.dsh\storages\dsh-chatgpt-subscription\oauth.dpapi`

> 该文件只能由创建它的 Windows 用户通过 DPAPI 解密。

## 安全边界

- OAuth 回调固定为 `http://localhost:1455/auth/callback`，登录任务五分钟超时，同一时刻只允许一个；
- OAuth token 只发送到 `https://auth.openai.com/oauth/token`；
- 模型与额度地址分别固定为 `https://chatgpt.com/backend-api/codex/responses` 和 `https://chatgpt.com/backend-api/wham/usage`，没有 endpoint override；
- token bundle 使用 Windows CurrentUser DPAPI；明文只经过 Host 内存和 PowerShell stdin/stdout，不进入命令行参数、浏览器、`settings.yaml` 或日志；
- 工具调用只有在参数是完整 JSON 对象时才产生可执行的 `block-end`；畸形参数终止本次生成；
- 所有修改状态的路由只接受同源 JSON POST，并校验 `Origin` 与 `Host`。

## 插件路由

所有路由都以 `/api/dsh-chatgpt-subscription` 为前缀：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/status` | 查询账号、连接状态与额度 |
| POST | `/login/start` | 开始 OAuth 登录 |
| GET | `/login/events?loginId=...` | SSE 订阅登录进度 |
| POST | `/login/cancel` | 取消登录任务 |
| POST | `/logout` | 注销并清除凭据与额度缓存 |
| POST | `/token/refresh` | 刷新 token |
| POST | `/quota/refresh` | 刷新额度 |
| POST | `/connection/test` | 测试连接 |

状态响应只包含脱敏 email、套餐、账号 ID 后四位、token 到期时间和额度 DTO。

## 开发与验证

```powershell
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

测试使用 mock OAuth、Responses SSE 和 Wham usage，不需要真实 ChatGPT 凭据。真实账号的端到端登录与生成应在独立 DSH profile 中人工验收，避免影响日常 profile。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 1455 端口占用 | 结束旧登录任务或占用该端口的进程后重试；插件卸载会关闭 listener |
| 登录后仍是 401 | 刷新 token；若刷新 token 已失效，注销并重新登录，不会循环请求 |
| 额度显示旧数据 | 设置页会保留最后成功值；等待 15 秒节流窗口后手动刷新 |
| 429 | 插件遵守 `Retry-After`，不会高频轮询；模型请求由 DSH retry policy 有界重试 |
| 模型不可用 | 检查 ChatGPT 套餐、workspace 权限与当前模型可用性 |
| DPAPI 读取失败 | 确认 DSH 以创建凭据时的同一 Windows 用户运行；必要时清理凭据后重新登录 |
