# DSH ChatGPT Subscription

让 DSH（DeepSeek Harness）通过 ChatGPT 订阅使用 Gpt 系列模型的插件。

插件注册 `codex-chatgpt` Provider（显示名 **“Codex（ChatGPT 订阅）”**），以当前 Host 用户的 ChatGPT OAuth 登录态访问模型，并在设置页展示账号信息、连接状态与订阅额度。支持 Windows 与 Linux。

## 目录

- [功能特性](#功能特性)
- [模型目录](#模型目录)
- [环境要求](#环境要求)
- [安装](#安装)
- [使用](#使用)
- [子代理模型授权](#子代理模型授权0215-起)
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
- 子代理的模型与思考深度沿用 DSH 自身设置：**设置 → Subagent** 卡片授权 Agent 可以为子代理挑选的模型（来自 DSH 已接入的全部 Provider，包含本插件的 Codex / Antigravity），新 Agent 的默认路由由 DSH 的 `agent-default-model` 设置提供；
- 最大嵌套深度是 DSH 子代理工具的装配配置（preset 中 `tool-subagent` 的 `maxDepth`，默认 3；`provider-managed` 表示把预算交给进程外提供方），不在本插件设置内；
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

DSH 模型选择器应显示 **“Codex（ChatGPT 订阅）”**。6 Astra 与 GPT-5.6 系列的有效上下文窗口在“Codex 订阅 → 增强功能”中配置。子代理的模型与思考深度由 DSH 自身的设置决定（**设置 → Subagent** 卡片授权的模型清单，以及 `agent-default-model` 的默认路由）；最大嵌套深度由 DSH preset 中 `tool-subagent` 的 `maxDepth` 决定。

**设置 → Codex 订阅 → 网络代理** 同时控制 GPT 与 Antigravity（Gemini）的 Host 请求，可选择系统代理（自动检测）、自定义代理或直连。Gemini 模型生成、网页登录后的令牌交换、令牌刷新、账号信息、项目发现、配额与模型目录查询均使用此设置；修改后对后续请求生效，无需重启 DSH。浏览器中的 Google 授权页面使用浏览器自己的网络设置。

**搜索与抓取来源** 切换 DSH 的搜索后端；网页抓取后端在有可用代理时自动改用本插件。选择 ChatGPT 来源后，网页由本插件在 Host 抓取，并使用上述网络代理设置；纯 TUN 模式可使用直连，流量由虚拟网卡接管。来源切换即时生效，DSH web 服务重载后会重新注册插件后端，并保留切回 DSH 默认来源所需的配置。

**网页抓取后端（web_fetch）** DSH 内置抓取 provider 会先解析域名、校验并固定解析结果，而且只在进程环境变量里读到代理时才走代理——系统代理对它不可见。代理工具（Clash/Mihomo 等）常把域名解析成自己的 fake-ip 地址（默认 `198.18.0.0/15`），于是内置 provider 直接以 `WEB_BLOCKED_URL`（resolves to a non-public IP address）拒绝，代理根本没被用上。因此只要插件配置了可用代理（**网络代理** 选系统代理且检测到，或填写自定义代理），`web_fetch` 就改用本插件的 provider：由代理解析源站，与 DSH 对“走代理的请求”采用的语义一致；未配置代理时仍由 DSH 内置 provider 抓取，保留其解析与固定策略。若在纯 TUN 模式下把代理设为**直连**，内置 provider 会重新接管，此时可改回系统代理让插件接管抓取。

卸载前建议先在设置页点击 **“注销”**，它会删除当前平台的凭据和 Host 内存中的额度缓存。

若 DSH 已异常退出，可在确认路径后手动处理凭据文件：

- Windows：`%DSH_HOME%\storages\dsh-chatgpt-subscription\oauth.dpapi`，未设置 `DSH_HOME` 时为 `%USERPROFILE%\.dsh\storages\dsh-chatgpt-subscription\oauth.dpapi`；
- macOS：凭据位于登录钥匙串，可执行 `security delete-generic-password -s dsh-chatgpt-subscription -a oauth` 删除；
- Linux：`$DSH_HOME/storages/dsh-chatgpt-subscription/oauth.json`，未设置 `DSH_HOME` 时为 `~/.dsh/storages/dsh-chatgpt-subscription/oauth.json`。

> Windows 文件只能由创建它的用户通过 DPAPI 解密。macOS 凭据由登录钥匙串在本机加密保存。Linux 文件是未额外加密的 JSON，依赖目录 `0700` 和文件 `0600` 隔离；不要复制、打印或提交该文件。跨平台迁移需要重新登录。

## 子代理模型授权（0.2.15 起）

DSH 设置页的「Subagent」卡片会把勾选的模型写成会话级的允许列表（会话日志事件 `subagent/model-selection-policy`）。DSH 内置委派工具只拒绝**模型显式填写**且不在列表内的路由；调用里不写 `provider`/`model` 时，子代理会继承父级模型，于是白名单之外的主模型（例如 `deepseek-official/deepseek-flash`）仍会被子代理使用。

插件在 Host 工具注册表上补一个单调守卫（`ctx.tools.guard`），在委派执行前判定生效路由：

- 调用会话（或最近的、记录了策略的祖先会话）带有允许列表时，生效路由必须落在列表内；
- 不写路由的委派按“继承父级模型”判定，因此父级模型不在列表内时会被拒绝；
- 拒绝结果里会列出全部已授权路由（例如 `antigravity/gemini-3.8-flash`），模型照此重试即可；`list_subagent_models` 仍只展示已授权路由；
- 未记录允许列表的会话（例如恢复的旧会话、未启用该设置的会话）保持 DSH 原有行为。

配置项（插件行 `config`，全部可省略）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `subagentModelAuthorization` | `true` | 是否启用上述授权守卫；设为 `false` 回到 DSH 原有行为 |
| `subagentModelTools` | `['subagent']` | 需要授权的委派工具名；preset 里自定义了 `toolName` 时在此列出 |
| `subagentModelScope` | `session` | `session` 只约束记录了允许列表的会话；`preference` 额外用当前设置卡列表约束未记录的会话 |

改动只在设置卡片里保存过的勾选生效：设置改动只影响之后新建的会话（DSH 的会话快照语义），已运行的会话继续使用它自己记录的那份列表。

## 安全边界

Antigravity 的 access token / refresh token 使用独立的系统凭据存储：Windows 使用 CurrentUser DPAPI（`$DSH_HOME/storages/antigravity-oauth.json.dpapi`），macOS 使用登录钥匙串，Linux 使用 Secret Service。macOS / Linux 的服务名为 `dsh-antigravity`，账号键按旧凭据文件的绝对路径生成，隔离不同的 `DSH_HOME`。

升级后首次访问 Antigravity 凭据时，会读取旧 `storages/antigravity-oauth.json`，加密保存并读回校验；成功后删除旧 JSON，通常无需重新登录。失败会保留旧文件并报告错误，不会回退到明文存储。注销同时清理旧文件和新凭据。Linux 需要 `secret-tool`（libsecret 工具包）及可用、已解锁的 Secret Service 钥匙环；无桌面服务的主机也需要配置该服务。系统凭据存储保护落盘数据，不防御当前用户下已获权限的进程。

Antigravity 的 Gemini 用量以流结束时的上游累计计数为准，缓存输入单列、思考 token 计入输出并另行提供明细；DSH 使用该输出计数计算 tok/s。Gemini 工具往返会保留原始思考签名，并在支持的运行时请求思考摘要；若上游没有返回摘要文本，插件不会生成替代内容。

以下为 Codex（ChatGPT 订阅）Provider 的存储与网络边界：

- OAuth 回调固定为 `http://localhost:1455/auth/callback`，登录任务五分钟超时，同一时刻只允许一个；
- OAuth token 只发送到 `https://auth.openai.com/oauth/token`；
- 模型、图片、搜索与额度地址分别固定为 `https://chatgpt.com/backend-api/codex/responses`、`https://chatgpt.com/backend-api/codex/images/generations`、`https://chatgpt.com/backend-api/codex/alpha/search` 和 `https://chatgpt.com/backend-api/wham/usage`，没有 endpoint override；
- Windows token bundle 使用 CurrentUser DPAPI；明文只经过 Host 内存和 PowerShell stdin/stdout；
- macOS token bundle 存入登录钥匙串，通过系统 `security` 命令读写；明文只经过 Host 内存和 `security` 命令行参数，Keychain 在本机加密保存；
- Linux token bundle 原子写入当前用户私有文件并在读取时校验普通文件、所有者与 `0600` 权限，同时拒绝符号链接；该文件没有应用层加密，同 UID 进程、root、备份和磁盘快照仍可读取；
- 本插件抓取 provider 的地址策略：URL 里直接写明的 IP 字面量只有在全球可路由单播时才放行（loopback、私网、链路本地、CGNAT、多播、保留地址、IPv6 转换与隧道前缀一律拒绝）；域名会先用本机解析器检查一次，解析结果落在私网时同样拒绝，只有代理的 fake-ip 地址（`198.18.0.0/15`）被接受——那正是本机代理声称拥有该域名的表现；本机解析不出的域名交给代理处理。与 DSH 内置 provider 的差别是不固定（pin）连接地址，因为 fake-ip 环境下这一步无法成立；
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
| `web_fetch` 报 `resolves to a non-public IP address` | 机器启用了系统代理（fake-ip DNS），但插件没有可用代理可接管抓取：在 **设置 → Codex 订阅 → 网络代理** 选择系统代理（自动检测）或填写自定义代理 |
| DPAPI 读取失败 | 确认 DSH 以创建凭据时的同一 Windows 用户运行；必要时清理凭据后重新登录 |
| Linux 凭据存储不可用 | 确认凭据属于当前用户且权限为 `0600`，父目录权限为 `0700`；修复权限或注销后重新登录 |
| Linux 上工具调用语法错误 | 确认 DSH 暴露的是 `bash`、`sh` 或 `shell`，并使用相应的 Bash/POSIX 语法与 `/` 路径 |