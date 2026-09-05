# DSH ChatGPT Subscription

让 DSH（DeepSeek Harness）通过 ChatGPT 订阅使用 Gpt 系列模型的插件。

插件注册 `codex-chatgpt` Provider（显示名 **“Codex（ChatGPT 订阅）”**），以当前 Host 用户的 ChatGPT OAuth 登录态访问模型，并在设置页展示账号信息、连接状态与订阅额度。支持 Windows 与 Linux。

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

**模型接入**

- 固定 Codex Responses 地址，支持流式文本、reasoning summary、图片输入与工具调用/结果；
- 原样转发 DSH 暴露的工具 schema；命令工具兼容 `pwsh` / `powershell`、`bash`、`sh` 与 `shell`，并按 PowerShell、Bash 或 POSIX sh 注入对应说明；
- 429/5xx 由 DSH retry policy 接管；401 只强制刷新并重试一次，支持 `AbortSignal`；
- Codex、Code review 及上游返回的额外窗口额度，支持 Credits、月度消费控制与 reset credits 展示；60 秒缓存、15 秒上游节流并遵守 `Retry-After`；
- 提供 ChatGPT 订阅侧 Codex 搜索 provider，可在设置页切换 DSH 默认搜索或 Codex 订阅搜索；
- 新增 `codex_image_generate` 工具，生成图片后通过 DSH 附件系统保存并在会话中渲染；
- 可选 composer 快捷用量徽标，按当前 `codex-chatgpt` 模型显示最紧张窗口的剩余额度。

**设置页**

- 展示账号（脱敏 email、套餐、账号 ID 后四位）、连接状态、额度与订阅增强功能开关；
- 独立的“子代理”设置页可全局选择 DSH 当前接入的任意 Provider/模型（如 DeepSeek V4 Flash）；思考深度来自所选模型公开能力，上下文在选定模型后展开配置，并适用于所有 DSH 内置子代理，不受父 Agent 当前 Provider/模型影响；
- 可全局设置 0–3 的最大嵌套深度与每个父 Agent 子树的活动子代理数量上限；限制即时作用于新委派，不中断已运行的子代理；
- 6 Astra 与 5.6 Sol / Terra / Luna 默认使用 272K 有效上下文；订阅侧 6 Astra 可配置最高 872K，5.6 系列最高 1M，用于 DSH 压缩与溢出判断；其他模型保持目录声明值；
- 可访问的进度条、窄窗口/200% 缩放布局、深浅主题与 reduced-motion。

## 模型目录

| 显示名 | 模型 slug |
| --- | --- |
| 5.6 Sol | `gpt-5.6-sol` |
| 6 Astra | `gpt-6-astra` |
| 5.6 Terra | `gpt-5.6-terra` |
| 5.6 Luna | `gpt-5.6-luna` |
| 5.5 | `gpt-5.5` |
| 5.4 | `gpt-5.4` |
| 5.4 Mini | `gpt-5.4-mini` |
| 5.3 Codex Spark | `gpt-5.3-codex-spark` |

> 目录只用于展示；账号实际可用的模型由 ChatGPT 套餐、workspace 策略与上游兼容状态决定。

6 Astra 支持文本、图片输入和工具调用，默认思考档位为 `medium`，可选 `low`、`medium`、`high`、`xhigh`、`max`。从旧会话带入的 `none` / `minimal` 会按 [OpenAI 官方迁移说明](https://developers.openai.com/api/docs/guides/latest-model) 转为 `low`。订阅侧 872K 上下文上限依据 2026-09-05 的 Codex 模型目录；[Codex Ultra](https://learn.chatgpt.com/zh-Hans/docs/models) 涉及客户端的子代理编排，本插件不将它作为 Responses 思考参数暴露。

新配置默认显示 6 Astra；已有配置保留原来的模型勾选，可在 **设置 → Codex 订阅 → 可用模型** 中勾选 **6 Astra**。

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
4. 执行 **测试连接**。

DSH 模型选择器应显示 **“Codex（ChatGPT 订阅）”**。6 Astra 与 GPT-5.6 系列的有效上下文窗口仍在“Codex 订阅 → 增强功能”中配置；子代理模型、思考深度、子代理上下文、最大嵌套深度和数量上限则统一位于独立的 **“子代理”** 设置页。模型路由适用于会话标记为 `origin: subagent` 的 DSH 内置子代理；运行限制在内置 spawn/fork 及已启用的原生子代理委派工具入口统一执行。

卸载前建议先在设置页点击 **“注销”**，它会删除当前平台的凭据和 Host 内存中的额度缓存。

若 DSH 已异常退出，可在确认路径后手动处理凭据文件：

- Windows：`%DSH_HOME%\storages\dsh-chatgpt-subscription\oauth.dpapi`，未设置 `DSH_HOME` 时为 `%USERPROFILE%\.dsh\storages\dsh-chatgpt-subscription\oauth.dpapi`；
- macOS：凭据位于登录钥匙串，可执行 `security delete-generic-password -s dsh-chatgpt-subscription -a oauth` 删除；
- Linux：`$DSH_HOME/storages/dsh-chatgpt-subscription/oauth.json`，未设置 `DSH_HOME` 时为 `~/.dsh/storages/dsh-chatgpt-subscription/oauth.json`。

> Windows 文件只能由创建它的用户通过 DPAPI 解密。macOS 凭据由登录钥匙串在本机加密保存。Linux 文件是未额外加密的 JSON，依赖目录 `0700` 和文件 `0600` 隔离；不要复制、打印或提交该文件。跨平台迁移需要重新登录。

## 安全边界

- OAuth 回调固定为 `http://localhost:1455/auth/callback`，登录任务五分钟超时，同一时刻只允许一个；
- OAuth token 只发送到 `https://auth.openai.com/oauth/token`；
- 模型、图片、搜索与额度地址分别固定为 `https://chatgpt.com/backend-api/codex/responses`、`https://chatgpt.com/backend-api/codex/images/generations`、`https://chatgpt.com/backend-api/codex/alpha/search` 和 `https://chatgpt.com/backend-api/wham/usage`，没有 endpoint override；
- Windows token bundle 使用 CurrentUser DPAPI；明文只经过 Host 内存和 PowerShell stdin/stdout；
- macOS token bundle 存入登录钥匙串，通过系统 `security` 命令读写；明文只经过 Host 内存和 `security` 命令行参数，Keychain 在本机加密保存；
- Linux token bundle 原子写入当前用户私有文件并在读取时校验普通文件、所有者与 `0600` 权限，同时拒绝符号链接；该文件没有应用层加密，同 UID 进程、root、备份和磁盘快照仍可读取；
- 所有平台的 token 都不会进入浏览器、`settings.yaml` 或日志；
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
| POST | `/preferences/update` | 更新搜索来源和 composer 快捷用量偏好 |

状态响应只包含脱敏 email、套餐、账号 ID 后四位、token 到期时间和额度 DTO。

## 开发与验证

```sh
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
| Linux 凭据存储不可用 | 确认凭据属于当前用户且权限为 `0600`，父目录权限为 `0700`；修复权限或注销后重新登录 |
| Linux 上工具调用语法错误 | 确认 DSH 暴露的是 `bash`、`sh` 或 `shell`，并使用相应的 Bash/POSIX 语法与 `/` 路径 |
