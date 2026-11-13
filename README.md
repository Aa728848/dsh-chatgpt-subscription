# DSH Multi-Subscription Hub (`@eddyskywalker/dsh-chatgpt-subscription`)

面向 **DeepSeek Harness（DSH）** 的多平台订阅接入与智能体运行时增强插件包。

插件最初为接入 ChatGPT Plus / Pro / Business 订阅的 Codex 模型而建，现已演进为统一的**多订阅服务中枢（Subscription Hub）与编码 Agent 增强套件**：在单一插件包内同时提供 **13 条独立模型供应线路**、跨平台加密多账号池、多模态生图/视频工具链、前缀缓存零漂移保护，以及随包分发的 `dispatch` 多子代理编排预设。

- **跨平台支持**：Windows、macOS、Linux（含无桌面密钥环的远程服务器部署模式）
- **跨代际兼容**：单一代码库兼容 `@deepseek-ai/dsh` **0.1.2-alpha.5 至 0.2.2-rc.2** 全系列版本
- **全栈多语言**：Web 设置中心与宿主侧提示/报错完整支持 **简体中文（`zh`）/ English（`en`）/ Русский（`ru`）**

---

## 目录

- [供应线路总览](#供应线路总览)
- [核心特性](#核心特性)
- [环境要求](#环境要求)
- [安装与升级](#安装与升级)
- [快速上手](#快速上手)
- [内置工具与界面扩展](#内置工具与界面扩展)
- [Agent 编排与运行时增强](#agent-编排与运行时增强)
- [常用配置速查](#常用配置速查)
- [安全与隐私边界](#安全与隐私边界)
- [开发与测试验证](#开发与测试验证)
- [进阶文档索引](#进阶文档索引)

---

## 供应线路总览

插件同时注册 **13 条相互隔离的供应线路**。每条线路拥有独立的 Provider ID、独立的账号池与轮换策略、独立的模型目录与上下文窗口覆盖，以及独立的额度卡片；任意一条线路限流或故障均不影响其它线路。

| Provider ID | 订阅 / 服务 | 传输协议 | 登录与凭据方式 | 模型目录来源 |
| --- | --- | --- | --- | --- |
| `codex-chatgpt` | ChatGPT（Plus / Pro / Business 等） | OpenAI Responses / Lite | 浏览器 OAuth（`:1455`）/ 设备码 / 只读导入 Codex CLI | 实时 `/backend-api/codex/models` + 随包兜底 |
| `claude-subscription` | Claude Pro / Max | Anthropic Messages | PKCE 手动粘贴 `<code#state>` / loopback 回调 / 只读收编 Claude Code | 实时 `/v1/models` + 随包 17 模型能力表 |
| `kimi-code` | Kimi Code 编程订阅 | OpenAI Chat Completions（可选 Anthropic） | RFC 8628 设备码授权（国区 / 国际区） | 实时 `/v1/models` + 随包兜底 |
| `minimax-code` | MiniMax Code 编程订阅 | Anthropic Messages | 复用/导入本机桌面端 `auth.json` 或 RFC 8628 设备码 | 随包硬编码目录（上游未开放订阅侧 `/v1/models`） |
| `command-code` | Command Code | Anthropic（`claude-*`）/ OpenAI（其余） | 浏览器 loopback OAuth（`:5959+`）或粘贴 API Key | 实时 `/provider/v1/models` + 官方 109 条能力表 |
| `glm-coding-plan` | GLM Coding Plan（国区 BigModel / 国际区 Z.ai） | Anthropic Messages（套餐专用端点） | ZCode 浏览器轮询 OAuth / 手工粘贴 / 只读导入 ZCode | 随包目录（源自官方 `zcode-builtin.json`） |
| `step-code` | StepFun Step Plan 订阅 / 开放平台 | OpenAI Chat Completions | 云端轮询浏览器授权 / Platform API Key / 只读导入 `stepcode` | 纯实时运行时发现 |
| `cline-pass` | Cline Pass | OpenAI Chat Completions | WorkOS 设备码 OAuth（自动续期）/ API Key 兼容回退 | 随包兜底 + 官方推荐与上游网关目录补全 |
| `qoder` | Qoder 订阅（全球区 / 中国站） | Qoder 自有（COSY 签名 + 信封 SSE） | 浏览器设备流（全球区）/ 粘贴 PAT / 只读导入 `qodercli` | 实时 COSY 签名发现 + 随包能力兜底表 |
| `opendesign` | OpenDesign（Go / Plus / Pro / Max） | OpenAI Chat Completions | AMR 浏览器设备授权（双 Key 签发）/ 粘贴 API Key | 随包 41 模型表 + AMR 控制面与实时 `/v1/models` |
| `workbuddy-subscription` | WorkBuddy（CodeBuddy 国区 / 国际区） | OpenAI `/v2/chat/completions`；国区 Claude 走 `/v1/messages` | 浏览器轮询授权 / 只读采纳 CodeBuddy 桌面登录态 | 实时 `/v3/config` + 本地快照与随包兜底 |
| `ollama` | Ollama Cloud | Ollama Native `/api/chat` + OpenAI `/v1/chat/completions` | 粘贴 Ollama Cloud API Key | 实时 `/api/tags` + `/api/show` 元数据探测 |
| `antigravity-acp` | Google Antigravity（官方 CLI） | **ACP v1 / stdio JSON-RPC**（官方 `agy acp` 服务端） | 复用官方 CLI 自己的登录态（`agy acp --login`）；本插件不读取、不保存凭据 | 实时 ACP `session/new` 目录 + 本地快照 |

> **合规与风险提示**：
> - `claude-subscription` 通过订阅 OAuth 凭据模拟官方 CLI 身份转发请求，与 Anthropic 现行服务条款存在冲突，未获官方授权，存在账号被限制或封禁的风险。
> - `workbuddy-subscription`、`qoder` 等线路部分依赖非公开或逆向协议契约；`step-code` 额度面板使用非公开开发者中心接口（与对话请求完全隔离）。
> - **`antigravity-acp` 的合规风险不是技术风险，而是条款风险**：它运行的是 Google 官方 `agy` 与其官方 ACP 服务器（协议、凭据、网络全部由官方程序负责，与旧的逆向 `antigravity` 线路有本质区别），但 Google 的 Antigravity FAQ 明确写着：*使用第三方软件、工具或服务访问 Antigravity 违反其服务条款*，且 *把 `agy` 包在第三方编码 Agent/应用中、或自动化账号轮换，在消费者套餐下不受支持*，可能导致账号被暂停或终止。Google 同时公开推荐了 ACP 接入编辑器的方式，两者之间存在解释空间。**默认关闭该线路**；是否启用由使用者自行判断并承担账号风险。Gemini Enterprise / AI Studio API Key 是 Google 官方指引中风险最低的替代路径。
> - 各线路详细的鉴权细节、验证置信度分档与宿主 API 路由请参阅 **[供应线路完整指南（docs/providers.md）](docs/providers.md)**。

---

## 核心特性

### 1. 统一订阅中心与多账号池调度
- **聚合总览页**：在 **设置 → 订阅服务** 提供单页总览卡片，集中查看 13 条线路的启停状态、可用账号数与已勾选模型数，支持在线检测 npm 更新并一键升级插件（自动保护本地 `link:` 开发目录）。
- **统一号池内核**：所有线路共享多账号池架构，支持 **顺序耗尽（`sequential`）/ 轮流使用（`round-robin`）/ 固定当前（`sticky`）** 三种策略；遇到账号级 429 配额耗尽自动按重置窗口冷却换号，遇到全局瞬时过载则原地指数退避，防止抽干号池。
- **本机登录态零侵入收编**：支持只读导入本机已登录的 Codex CLI、Claude Code、ZCode、StepCode、Qoder CLI、CodeBuddy 桌面端凭据，以及复用 MiniMax Code 桌面端登录态。导入前仅做 `stat` 存在性检查，绝不修改或删除第三方客户端文件，也不跨进程抢刷单次轮换令牌。
- **桌面与无头服务器双存储模式**：默认使用系统加密密钥环（`keyring`：Windows DPAPI / macOS Keychain / Linux Secret Service）；无桌面环境的 Linux 服务器可一键切换至 DSH 标准凭据库（`credentials`：`$DSH_HOME/.credentials.yaml`，强制 `0600` 权限），告别安装 `gnome-keyring` 的繁琐配置。

### 2. 全共享网络代理与智能网页抓取
- **一处配置、全线生效**：在 ChatGPT 设置卡配置的 **网络代理**（系统代理自动检测 / 自定义代理 / 直连）同时作用于全部 13 条线路的对话、OAuth 登录续期、额度查询与目录拉取，自动绕行回环地址与 `NO_PROXY` 主机。
- **Codex 搜索与 `fake-ip` 友好的 `web_fetch`**：支持将 DSH 搜索切换为 ChatGPT 订阅侧 Codex 搜索；在 Clash / Mihomo 等开启 `fake-ip`（`198.18.0.0/15`）的代理环境下，`fetchProvider: auto` 会自动用插件抓取器接管 `web_fetch`，交由远端代理解析域名，解决内置抓取器因本地 DNS 固定报错 `WEB_BLOCKED_URL` 的痛点。

### 3. 精细上下文预算、独立压缩路由与前缀缓存保护
- **逐模型能力与窗口覆盖**：按上游实时目录与官方注册表精确声明图片/视频模态、思考档位梯子与上下文窗口（支持 `1M`、`512K`、`272000` 等自定义覆盖写法）。
- **独立压缩模型**：支持在设置页指定更快或更便宜的跨线路模型专门执行上下文压缩摘要（`purpose: 'compaction'`），自动处理多模态降级与半截摘要回退。
- **前缀缓存零漂移架构**：针对 Kimi Code、MiniMax Code、Claude 等前缀缓存敏感线路，内置计划模式指引尾部一次性投递、PTC `tools:sdk` 声明冻结、历史工具结果修剪自动跳过（`./tool-result-pruner`），以及 Kimi 大结果 `ref://` 引用投影与 `cache_warmup_result` 分页补读。

---

## 环境要求

- **操作系统**：Windows（需内置 PowerShell 以支持 CurrentUser DPAPI）、macOS 或 Linux
- **运行时**：Node.js **≥ 22.19**（内置 `undici` 8 的下限，已写入 `package.json` 的 `engines`；建议 24 LTS）与 npm
- **宿主版本**：DeepSeek Harness `@deepseek-ai/dsh` `0.1.2-alpha.5` 至 `0.2.2-rc.2`

---

## 安装与升级

### 方式 1：通过 DSH CLI 安装（推荐）

```sh
# 若已全局安装 dsh
dsh plugin --profile web add @eddyskywalker/dsh-chatgpt-subscription

# 或通过 npx 执行
npx @deepseek-ai/dsh plugin --profile web add @eddyskywalker/dsh-chatgpt-subscription
```

如需尝鲜预发布通道，可显式指定 `@alpha` 标签：

```sh
dsh plugin --profile web add @eddyskywalker/dsh-chatgpt-subscription@alpha
```

### 方式 2：通过 DSH Web 界面安装

1. 打开 DSH Web 侧边栏的 **Plugins（插件）** 页面；
2. 输入包名 `@eddyskywalker/dsh-chatgpt-subscription` 并安装；
3. 按界面提示重载或重启 `dsh web`（Live Profile 支持热应用更新）。

### 方式 3：源码软链接（本地开发调试）

```sh
git clone https://github.com/Aa728848/dsh-chatgpt-subscription.git
cd dsh-chatgpt-subscription
npm install
npm run build

# Linux / macOS
npx @deepseek-ai/dsh plugin --profile web add "link:/absolute/path/to/dsh-chatgpt-subscription"

# Windows PowerShell
npx @deepseek-ai/dsh plugin --profile web add "link:C:\absolute\path\to\dsh-chatgpt-subscription"
```

---

## 快速上手

1. 启动或重启 `dsh web` 并打开 Web 界面；
2. 进入 **设置 → 订阅服务**，点击任一目标线路卡片（如 **ChatGPT**、**Kimi Code**、**Claude**、**MiniMax Code** 等）；
3. **无头 Linux 服务器首次使用提示**：若主机未运行桌面钥匙环守护进程，先在 **ChatGPT → 账号存储位置** 将存储切换为 **DSH 凭据库（`credentials`）**；
4. 点击 **登录**（浏览器 OAuth / 设备码 / API Key）或 **导入本机登录** 完成账号入池；
5. 按需调整 **可用模型勾选**、**默认思考深度**、**上下文窗口覆盖** 与 **网络代理**，点击 **测试连接** 验证；
6. 回到对话页，即可在模型选择器中选用已启用线路的模型，输入框右侧将实时展示当前线路最紧迫窗口的剩余额度胶囊。

---

## 内置工具与界面扩展

### 注册给 Agent 的工具

| 工具名 | 适用范围 | 功能说明 |
| --- | --- | --- |
| `progress_update` | 全线路通用 | 在不中断当前回合的前提下向用户汇报结构化阶段进展，渲染于对话行与右侧进展面板 |
| `dispatch_ledger` | 全线路通用（配合 `dispatch` 预设） | 只读查询委派账本并获取 Mandate v2 协议及预填好的可复制头部骨架 |
| `codex_image_generate` | 需已登录 `codex-chatgpt` | 通过 ChatGPT 订阅生图接口生成 PNG 图片并写入会话附件 |
| `kimi_attach_video` | `kimi-code` 支持视频的模型 | 将本地视频路径或 URL 挂载进下一轮多模态请求 |
| `cache_warmup_result` | `kimi-code` 会话 | 对被替换为 `ref://<session>/<sha256>` 预览的大工具结果按字节/行精确分页补读或释放 |
| `minimax_generate_video` | `minimax-code` 会话 | 调用 MiniMax-H3 / H3-Max / Hailuo-2.3 生成视频（支持首尾帧与参考图/视频/音频）并下载至工作区 |
| `minimax_understand_video` | `minimax-code` 会话 | 上传或内联本地视频并调用 MiniMax 视频理解接口回答问题 |
| `enter_plan_mode` / `leave_plan_mode` | `dispatch` 预设会话 | 调度模式下在澄清访谈收敛后进入只读计划模式，或显式放弃规划 |
| `cline_pass_*`（共 5 个） | 可选开启（默认不注册） | Cline Pass 状态、目录、普通模型测试、账号与请求历史管理工具 |

### Web 客户端与看板扩展

- **MiniMax `/video` 斜杠命令与预览**：在对话输入框输入 `/video` 即可唤出可视化视频参数表单（自动校验模型专属分辨率与时长联动规则），生成的视频支持对话内播放与右侧文档预览栏直接播放。
- **Mermaid 图表自动渲染**：对话流中的 Mermaid 代码块在客户端经安全消毒后自动渲染为矢量图。
- **组件看板卡片（`dsh-widget-board`）**：随包发布双面翻转组件 `line-flip`（**线路额度**）——正面展示指定订阅线路（`props.line`）的多窗口进度条与重置倒计时，背面展示该线路号池列表、当前激活账号与轮换策略切换器。

---

## Agent 编排与运行时增强

- **随包分发 `dispatch`（调度模式）预设**：安装插件后自动注册到新建会话的 Agent Preset 列表中。遵循 `分诊(L0/L1/L2) → 澄清访谈(R-G) → 计划模式审批(R9) → 拓扑派发(Lead-Core / Hybrid / Fan-out) → 证据验收(R6)` 纪律，配合 `dispatchExecutionGuard` 与 `dispatch_ledger` Mandate v2 血缘守卫防重、防越权、禁空 `sleep`。详见 **[调度模式说明（presets/dispatch/README.md）](presets/dispatch/README.md)**。
- **子代理模型白名单强制守卫（`subagentModelAuthorization`）**：消除省略 `provider`/`model` 时悄悄继承主模型绕过白名单的漏洞（覆盖直接工具调用与 PTC `run_code` 内 SDK 调用）；客户端插件页同步提供支持「全局默认 + 按主代理模型分别配置」的增强版 **子智能体** 设置卡。
- **流式健康与自动续跑保护**：全线路配备双阶段流式空闲看门狗（响应头脉冲 + 流内 120s 静默判死重试，Ollama 为 300s）、空结束轮次自动续跑（`noAnswerResume`，默认开启），以及可选的字面 + 语义双信号推理复读熔断器（`reasoningCollapseGuard`，默认关闭）。

---

## 常用配置速查

插件级部署参数位于 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 的 `id: dsh-chatgpt-subscription` 条目下（标记 **热生效** 的字段亦可在 Web 设置页直接开关，保存即生效）：

| 配置键 | 默认值 | 生效时机 | 作用简述 |
| --- | --- | --- | --- |
| `poolStorage` | `'keyring'` | 重载插件（UI 切换即时生效） | 号池存储：`keyring`（系统密钥环）或 `credentials`（DSH 凭据库，服务器推荐） |
| `fetchProvider` | `'auto'` | 重载插件 | `web_fetch` 策略：`auto`（有代理或 Codex 搜索时插件接管）/ `plugin` / `dsh` |
| `syncAgentPresets` | `true` | 重启 / 重载 | 是否自动注册或同步随包 `dispatch` Agent Preset |
| `subagentModelAuthorization` | `true` | 重载插件 | 启用子代理显式/继承路由白名单单调守卫 |
| `progressUpdates` | `true` | 热生效 | 启用 `progress_update` 工具、提示词引导与右侧进展面板 |
| `planModePipeline` | `true` | 热生效 | 允许 `dispatch` 预设使用 `enter_plan_mode` / `leave_plan_mode` |
| `dispatchExecutionGuard` | `true` | 热生效 | 启用子代理主控工具越权拦截、空等拦截与 Mandate v2 账本守卫 |
| `cacheWarmup` / `cacheWarmupRetrieval` | `true` | 热生效 | Kimi Code 大日志结果与导航检索大纲的 `ref://` 预览投影 |
| `noAnswerResume` | `{}`（开启） | 重载插件 | 无正文且无工具调用异常收尾时自动续跑；设 `false` 关闭 |
| `reasoningCollapseGuard` | `false`（关闭） | 重载插件 | 传 `{}` 或阈值对象开启双信号推理复读熔断器 |

完整的配置参数、并发控制（`DSH_PROVIDER_CONCURRENCY`）与全量环境变量表请参阅 **[部署配置与安全参考（docs/configuration.md）](docs/configuration.md)**。

---

## 安全与隐私边界

- **凭据不出宿主**：所有 OAuth 令牌、刷新令牌、API Key、PKCE `code_verifier` 仅存于宿主内存与加密存储（Windows CurrentUser DPAPI / macOS Keychain / Linux Secret Service 或 `0600` 独占文件），**永不进入浏览器响应、`settings.yaml` 或日志**；诊断信息只输出 SHA-256 指纹前缀。
- **同源防伪校验**：全部修改状态的宿主 HTTP 路由强制要求同源 JSON `POST` 并校验 `Origin` 与 `Host`。
- **外部凭据零写入**：所有本机 CLI / 桌面端凭据收编逻辑严守只读边界，从不篡改、移动或删除原客户端文件。
- **地址安全策略**：本地图片仅通过回环通道读取；插件网页抓取器严格拦截私网、回环、链路本地等非公网字面量地址（仅放行本地代理的 `198.18.0.0/15` fake-ip 解析结果）。

---

## 开发与测试验证

```sh
# 运行宿主、客户端、测试与脚本工程的 TypeScript 类型检查
npm run typecheck

# 运行全量离线 Vitest 测试套件（全 mock，无需真实账号或外网连接）
npm test

# 构建类型声明与 lib/ 产物（ESM 宿主入口 + CJS 浏览器 bundle）
npm run build

# 检查 npm 打包文件清单与体积
npm pack --dry-run
```

> 升级 `@deepseek-ai/dsh*` 依赖或重构公共类型后，请执行 `npx tsc -b --force` 绕过增量 `.tsbuildinfo` 缓存做完整编译校验。架构细节与贡献规范详见 **[架构设计与开发指南（docs/architecture.md）](docs/architecture.md)**。

---

## 进阶文档索引

- **[文档总导航（docs/README.md）](docs/README.md)** — 全部参考手册与历史工程审计档案目录
- **[供应线路完整指南（docs/providers.md）](docs/providers.md)** — 13 条线路的鉴权、模型能力、协议细节、验证边界与 HTTP 路由表
- **[部署配置与安全参考（docs/configuration.md）](docs/configuration.md)** — `cordis.patch.yml` 全字段、`poolStorage`、代理策略与全量环境变量表
- **[架构设计与开发指南（docs/architecture.md）](docs/architecture.md)** — 多入口设计、共享内核、三语国际化、缓存守卫与跨代际兼容规范
- **[故障排查手册（docs/troubleshooting.md）](docs/troubleshooting.md)** — 登录回调、钥匙环、路由冲突、429 冷却、压缩溢出与代理抓网页排障
- **[调度模式预设说明（presets/dispatch/README.md）](presets/dispatch/README.md)** — `dispatch` 编排规则（`R0`–`R9`）与 Mandate v2 账本协议
