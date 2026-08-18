# DSH ChatGPT Subscription

让 DSH（DeepSeek Harness）通过官方 OAuth 或官方客户端会话使用订阅模型的多 Provider 插件。

插件保留原有 `codex-chatgpt` Provider（显示名 **“Codex（ChatGPT 订阅）”**），并新增 `claude`、`grok`、`cursor` 与 `antigravity` Provider。支持浏览器 OAuth、官方客户端/CLI 会话扫描、动态模型目录、原生流式传输和安全的 Host-only 凭据存储。支持 Windows 与 Linux。

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
- Windows 使用 CurrentUser DPAPI 加密存储 token；Linux 使用当前用户独占的 `0600` 文件存储；明文不发送给 Client；
- 设置页会明确显示当前存储类型，并在 Linux 上提示文件存储未额外加密。

**多 Provider OAuth / 官方会话**

- Claude：官方浏览器 OAuth、带 `state` 的手工回调/授权码、Claude CLI/官方会话扫描及 Anthropic Messages 原生流；
- Grok：xAI 浏览器 OAuth、Grok CLI/本机会话扫描、实时模型缓存、Build credits 与原生流；
- Cursor：`loginDeepControl` + `/auth/poll` 浏览器登录、Cursor 桌面/CLI 会话扫描、AvailableModels RPC 与原生 HTTP/2 流；
- Antigravity：Google OAuth、官方客户端/CLI 会话扫描、实时目录/credits 与 Gemini SSE；浏览器 OAuth 需要配置 `DOCKYARD_ANTIGRAVITY_CLIENT_ID` 和 `DOCKYARD_ANTIGRAVITY_CLIENT_SECRET`；
- 所有新增 Provider 都通过独立账号池管理，凭据以 opaque reference 关联，不进入浏览器状态或账号池 JSON。

**模型接入**

- 固定 Codex Responses 地址，支持流式文本、reasoning summary、图片输入与工具调用/结果；
- 原样转发 DSH 暴露的工具 schema；命令工具兼容 `pwsh` / `powershell`、`bash`、`sh` 与 `shell`，并按 PowerShell、Bash 或 POSIX sh 注入对应说明；
- 429/5xx 由 DSH retry policy 接管；401 只强制刷新并重试一次，支持 `AbortSignal`；
- Codex 与 Code review 多窗口额度，60 秒缓存、15 秒上游节流并遵守 `Retry-After`；
- 临时兼容 DSH `0.1.0-rc.6` 的子代理最终报告去重：若 settlement 已向父 Agent 提供同一子代理、完全相同的最终内容，则删除仍在 inbox 中的重复 report；部分报告、不同内容和不同子代理不受影响。兼容代码以 `DSH_COMPAT_REMOVE(subagent-report-settlement-dedup)` 集中标记，待 DSH 原生修复后删除。

**设置页**

- 展示账号（脱敏 email、套餐、账号 ID 后四位）、连接状态与额度；
- 可访问的进度条、窄窗口/200% 缩放布局、深浅主题与 reduced-motion。

## 模型目录

`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini`、`gpt-5.2`

> Codex 目录只用于展示；账号实际可用的模型由 ChatGPT 套餐、workspace 策略与上游兼容状态决定。Claude 目录从当前 DSH 安装携带的 pi-ai Anthropic registry 读取；Grok、Cursor 与 Antigravity 优先使用对应官方 CLI、官方会话 API 或本地官方缓存提供的实时目录。目录为空时插件不会伪造模型。

## 环境要求

- Windows 或 Linux；
  - Windows：系统需提供 Windows PowerShell，以使用 CurrentUser DPAPI；
  - Linux：Host 用户必须拥有可写的 `~/.dsh`（或 `$DSH_HOME`），凭据文件会强制使用 `0600`、目录使用 `0700`；
- 已安装 DSH；
- Node.js 与 npm。

## 安装

### 方式 1：通过 DSH CLI 安装（推荐）

直接从 npm 安装已发布的插件包：

```sh
# Windows PowerShell、Bash 和 POSIX sh 均可执行
# 如果全局安装了 dsh
dsh plugin --profile web add @eddyskywalker/dsh-chatgpt-subscription

# 或使用 npx 直接运行
npx @deepseek-ai/dsh plugin --profile web add @eddyskywalker/dsh-chatgpt-subscription
```

### 方式 2：通过 DSH 插件市场安装

1. 打开 DSH 界面中的 **插件市场** / **Plugin Market**；
2. 搜索 `@eddyskywalker/dsh-chatgpt-subscription` 或 `dsh-chatgpt-subscription`；
3. 点击 **安装**。

### 方式 3：本地开发调试（源码软链接）

如需进行二次开发或本地源码调试：

```sh
git clone https://github.com/Aa728848/dsh-chatgpt-subscription.git
cd dsh-chatgpt-subscription
npm install
npm run build

# Linux
npx @deepseek-ai/dsh plugin --profile web add "link:/absolute/path/to/dsh-chatgpt-subscription"

# Windows PowerShell
npx @deepseek-ai/dsh plugin --profile web add "link:C:\absolute\path\to\dsh-chatgpt-subscription"
```

## 使用

1. 重启 `dsh web`；
2. 打开 **设置 → Codex 订阅**；
3. 完成 ChatGPT 登录；
4. 执行 **测试连接**；
5. 打开 **设置 → 订阅 Provider**，扫描现有官方会话，或分别登录 Claude、Grok、Cursor、Antigravity。

DSH 模型选择器会保留 **“Codex（ChatGPT 订阅）”**；新增 Provider 在成功导入账号且实时目录返回模型后出现。

卸载前建议先在设置页点击 **“注销”**，它会删除当前平台的凭据和 Host 内存中的额度缓存。

若 DSH 已异常退出，可在确认路径后手动处理凭据文件：

- Windows：`%DSH_HOME%\storages\dsh-chatgpt-subscription\oauth.dpapi`，未设置 `DSH_HOME` 时为 `%USERPROFILE%\.dsh\storages\dsh-chatgpt-subscription\oauth.dpapi`；
- Linux：`$DSH_HOME/storages/dsh-chatgpt-subscription/oauth.json`，未设置 `DSH_HOME` 时为 `~/.dsh/storages/dsh-chatgpt-subscription/oauth.json`；
- 新增 Provider 的秘密凭据：Windows 为同目录 `providers.dpapi`，Linux 为 `providers.json.secrets`；账号池元数据为 `providers.json`，其中不包含原始 token。

> Windows 文件只能由创建它的用户通过 DPAPI 解密。Linux 文件是未额外加密的 JSON，依赖目录 `0700` 和文件 `0600` 隔离；不要复制、打印或提交该文件。跨平台迁移需要重新登录。

## Provider 兼容性与风险

这里的“官方会话”仅表示读取或导入相应厂商客户端/CLI 创建的本地登录态，**不表示厂商认可、验证、赞助或支持本插件**。本项目与 Anthropic、xAI、Cursor、Google/OpenAI 均无隶属或合作关系。Claude、Grok、Cursor 与 Antigravity 的部分接口属于未公开或由客户端行为观察得到的协议，可能因上游版本、账号策略或服务条款变化而失效。

- Claude 浏览器账号的“订阅有效”状态由成功保存并可刷新的 OAuth 凭据推导，并非 Anthropic 服务端订阅 introspection；浏览器状态没有实时额度数据，因此额度通常显示未知。Claude 模型目录来自当前 DSH 安装携带的 pi-ai Anthropic registry，而不是 Anthropic 实时模型接口。授权 scope 包含 `org:create_api_key`、推理、会话、MCP 与文件权限，属于高权限授权；请只在可信本机 Host 使用。`ANTHROPIC_API_KEY`、`CLAUDE_CODE_OAUTH_TOKEN`、`ANTHROPIC_AUTH_TOKEN` 及本地明文 credential 文件不会被静默当作本 Provider 的订阅账号。手工回调 URL/授权码只进入受限 POST body 和 Host 内存，不写入日志。
- Cursor 接入使用 Cursor 托管端点和对客户端协议的观察实现，不应理解为 Cursor 验证的第三方集成。macOS 桌面数据库扫描会提取原始 access/refresh 凭据，因此当前默认关闭；只有宿主以后提供明确的知情同意开关时才允许启用。现有设置页扫描不会读取 `state.vscdb`。本插件不宣称 Windows/Linux 桌面会话兼容，这两个平台请使用浏览器登录或 `cursor-agent` CLI 会话。浏览器授权会话 10 分钟超时，终止性轮询错误会立即显示失败。Cursor 原生 Run 链路固定为文本输入、不向上游开放 DSH 工具，单次请求硬超时为 120 秒；Connect 单帧和未完成缓冲上限为 8 MiB、累计响应上限为 32 MiB，并拒绝压缩 frame。额度只有在客户端 status 返回窗口时才显示，否则为未知。
- Antigravity 浏览器 OAuth 必须使用用户自行配置、且已允许对应 loopback redirect URI 的 Google OAuth client。Client secret 只允许进入 Host 环境，不能发送到浏览器、写入账号池状态或提交到仓库。
- Antigravity 保留官方返回的完整 tier-suffixed model ID；不能把目录中的显示名当成可调用 ID。
- Grok 使用客户端中观察到的 client ID 和较宽的 CLI scopes；这不表示该 client ID、模拟客户端请求头或 billing endpoint 是面向第三方的受支持公开合同。账号刷新并非插件直接调用 refresh-token grant：它会把所选 OAuth 账号写入临时 `GROK_HOME/auth.json`（文件模式 `0600`），调用 `grok models` 让官方 CLI 负责刷新/轮换，再安全回写并删除临时目录。Grok credits 读取固定调用 `https://cli-chat-proxy.grok.com/v1/billing?format=credits`；不可用时余额为未知。`XAI_API_KEY`/`GROK_API_KEY` 不会被当作订阅 OAuth 账号。
- Grok/Claude/Cursor/Antigravity 的 endpoint override 不通过 Web 设置暴露；授权、身份、额度和原生生成固定发送到代码中审核过的官方 HTTPS 地址。
- OAuth/官方会话接入可能受到 Provider 服务条款和账号风控约束；使用者应自行确认其账号和地区允许的用途。

## 安全边界

- OAuth 回调固定为 `http://localhost:1455/auth/callback`，登录任务五分钟超时，同一时刻只允许一个；
- OAuth token 只发送到 `https://auth.openai.com/oauth/token`；
- 模型与额度地址分别固定为 `https://chatgpt.com/backend-api/codex/responses` 和 `https://chatgpt.com/backend-api/wham/usage`，没有 endpoint override；
- Windows token bundle 使用 CurrentUser DPAPI；明文只经过 Host 内存和 PowerShell stdin/stdout；
- Linux token bundle 原子写入当前用户私有文件并在读取时校验普通文件、所有者与 `0600` 权限，同时拒绝符号链接；该文件没有应用层加密，同 UID 进程、root、备份和磁盘快照仍可读取；
- 两个平台的 token 都不会进入浏览器、`settings.yaml` 或日志；
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
| GET | `/providers` | 查询 Claude/Grok/Cursor/Antigravity 公开账号状态 |
| POST | `/providers/scan` | 扫描官方客户端/CLI 会话 |
| POST | `/providers/candidate/import` | 将扫描到的官方会话安全导入账号池 |
| POST | `/providers/login/start` | 发起指定 Provider OAuth |
| POST | `/providers/login/poll` | 轮询官方登录状态 |
| POST | `/providers/login/code` | 提交手工回调地址或授权码 |
| POST | `/providers/login/cancel` | 取消指定 Provider 授权 |
| POST | `/providers/refresh` | 刷新账号、额度和目录状态 |
| POST | `/providers/account/remove` | 删除账号及对应安全凭据 |

状态响应只包含脱敏 email、套餐、账号 ID 后四位、token 到期时间和额度 DTO。

## 开发与验证

```sh
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

测试使用 mock OAuth、Responses SSE、Wham usage 和隔离的 Provider secret store，不需要真实订阅凭据。新增 Provider 的原生协议实现移植自 MIT License 的 Dockyard DSH（版权声明保留于 `vendor/dockyard/LICENSE`）。真实账号的端到端登录与生成应在独立 DSH profile 中人工验收，避免影响日常 profile。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 1455 端口占用 | 结束旧登录任务或占用该端口的进程后重试；插件卸载会关闭 listener |
| 登录后仍是 401 | 刷新 token；若刷新 token 已失效，注销并重新登录，不会循环请求 |
| 额度显示旧数据 | 设置页会保留最后成功值；等待 15 秒节流窗口后手动刷新 |
| 429 | 插件遵守 `Retry-After`，不会高频轮询；模型请求由 DSH retry policy 有界重试 |
| 模型不可用 | 检查 ChatGPT 套餐、workspace 权限与当前模型可用性 |
| DPAPI 读取失败 | 确认 DSH 以创建凭据时的同一 Windows 用户运行；必要时清理凭据后重新登录 |
| Linux 凭据存储不可用 | 确认凭据属于当前用户且权限为 `0600`，父目录权限为 `0700`；修复权限或注销后重新登录 |
| Linux 上工具调用语法错误 | 确认 DSH 暴露的是 `bash`、`sh` 或 `shell`，并使用相应的 Bash/POSIX 语法与 `/` 路径 |
| 父 Agent 已收到子代理结果，但相同报告仍显示为排队消息 | 本插件为 DSH `0.1.0-rc.6` 提供临时 report/settlement 精确去重；升级或重载插件并新建会话后验证。若未来 DSH 已原生修复，可移除所有 `DSH_COMPAT_REMOVE(subagent-report-settlement-dedup)` 标记代码 |
