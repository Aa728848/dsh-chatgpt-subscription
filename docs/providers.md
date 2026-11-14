# 供应线路完整指南与接口参考

本文档详细记录 `@eddyskywalker/dsh-chatgpt-subscription` 接入的全部 **13 条供应线路**（Provider）的鉴权方式、协议细节、模型目录策略、多模态与思考档位映射、验证边界以及宿主 HTTP 路由表。

> 跨线路共用的号池调度、存储后端（`poolStorage`）、统一网络代理与环境变量详见 [部署配置与安全参考](configuration.md)。

---

## 目录

1. [线路总览与合规提示](#1-线路总览与合规提示)
2. [本机登录态收编（Adopt）](#2-本机登录态收编adopt)
3. [Codex（ChatGPT 订阅）：`codex-chatgpt`](#3-codexchatgpt-订阅codex-chatgpt)
4. [Claude（订阅）：`claude-subscription`](#4-claude订阅claude-subscription)
5. [Kimi Code：`kimi-code`](#5-kimi-codekimi-code)
6. [MiniMax Code（编程订阅）：`minimax-code`](#6-minimax-code编程订阅minimax-code)
7. [Command Code：`command-code`](#7-command-codecommand-code)
8. [GLM（ZCode 账号）：`glm-coding-plan`](#8-glmzcode-账号glm-coding-plan)
9. [Step Code（Step Plan 订阅）：`step-code`](#9-step-codestep-plan-订阅step-code)
10. [Cline Pass：`cline-pass`](#10-cline-passcline-pass)
11. [Qoder（订阅）：`qoder`](#11-qoder订阅qoder)
12. [OpenDesign：`opendesign`](#12-opendesignopendesign)
13. [WorkBuddy（CodeBuddy 订阅）：`workbuddy-subscription`](#13-workbuddycodebuddy-订阅workbuddy-subscription)
14. [Ollama：`ollama`](#14-ollamaollama)

---

## 1. 线路总览与合规提示

每条线路独立注册 DSH `LlmAdapter`、独立维护账号池与模型偏好、独立挂载宿主路由与输入框额度胶囊；单条线路的登录异常、额度耗尽或上游故障**不会**波及其余线路。

| Provider ID | 界面名称（中文） | 上游协议 | 登录 / 凭据方式 | 模型目录来源 | 路由前缀 |
| --- | --- | --- | --- | --- | --- |
| `codex-chatgpt` | Codex（ChatGPT 订阅） | OpenAI Responses / Responses Lite | 浏览器 OAuth（`localhost:1455`）/ 设备码 / 只读导入 Codex CLI | 实时 `/backend-api/codex/models` + 随包兜底 | `/api/dsh-chatgpt-subscription` |
| `claude-subscription` | Claude（订阅） | Anthropic Messages | PKCE 手动粘贴 `<code#state>` / loopback 回调 / 只读收编 Claude Code | 实时 `/v1/models` + 随包能力表 | `/claude/api` |
| `kimi-code` | Kimi Code | OpenAI Chat Completions（可选 Anthropic Messages） | RFC 8628 设备码（`auth.kimi.com` / `.ai`） | 实时 `/v1/models` + 随包兜底 | `/kimi-code/api` |
| `minimax-code` | MiniMax Code（编程订阅） | Anthropic Messages | 复用/导入桌面端 `auth.json` 或 RFC 8628 设备码 | 随包硬编码目录（4 款模型） | `/minimax-code/api` |
| `command-code` | Command Code | Anthropic Messages（`claude-*`）/ OpenAI Chat Completions（其余） | 浏览器 loopback OAuth（`127.0.0.1:5959+`）或粘贴 API Key | 实时 `/provider/v1/models` + 官方 109 条能力表 | `/command-code/api` |
| `glm-coding-plan` | GLM（ZCode 账号） | Anthropic Messages（Coding Plan 端点） | ZCode 浏览器轮询 OAuth / 手工粘贴 / 只读导入 ZCode | 随包目录（转录自官方 `zcode-builtin.json`） | `/glm-coding-plan/api` |
| `step-code` | Step Code（Step Plan 订阅） | OpenAI Chat Completions | 云端轮询浏览器授权 / Platform API Key / 只读导入 `stepcode` | 纯实时运行时发现 | `/step-code/api` |
| `cline-pass` | Cline Pass | OpenAI Chat Completions | WorkOS 设备码 OAuth（自动续期）/ API Key 兼容回退 | 随包兜底 + `recommended-models` / models.dev / 网关目录 | `/cline-pass/api` |
| `qoder` | Qoder（订阅） | Qoder 自有（COSY 签名 + 信封 SSE） | 浏览器设备流（全球区）/ 粘贴 PAT / 只读导入 `qodercli` | 实时 COSY 签名发现 + 随包能力兜底表 | `/qoder/api` |
| `opendesign` | OpenDesign | OpenAI Chat Completions | AMR 浏览器设备授权（签发控制 Key + 运行时 Key）/ 粘贴 API Key | 随包 41 模型表 + AMR 控制面与实时 `/v1/models` | `/opendesign/api` |
| `workbuddy-subscription` | WorkBuddy（CodeBuddy 订阅） | OpenAI `/v2/chat/completions`；国区 Claude 走 `/v1/messages` | 浏览器轮询授权 / 只读采纳 CodeBuddy 桌面端登录态 | 实时 `/v3/config` + 本地快照与随包兜底 | `/workbuddy/api` |
| `ollama` | Ollama | Ollama Native `/api/chat` + OpenAI `/v1/chat/completions` | 粘贴 Ollama Cloud API Key | 实时 `/api/tags` + `/api/show` 按模型元数据探测 | `/ollama/api` |

> **合规与风险声明**：
> - `claude-subscription` 使用订阅 OAuth 凭据模拟客户端身份转发请求，与 Anthropic 现行服务条款冲突，未获官方授权，存在账号受限或封禁风险。
> - `workbuddy-subscription`、`qoder` 等线路依赖非公开或逆向协议契约，上游可能随时收紧渠道校验或风控策略。
> - `step-code` 的额度查询使用非公开开发者中心接口（与模型请求完全隔离，失败不影响对话）。
> - **`antigravity-acp`：条款风险高于技术风险。** 该线路运行 Google 官方 `agy` CLI 与其官方 ACP 服务器（协议、凭据、网络全部由官方程序负责，不逆向任何协议），但 Google Antigravity FAQ 有两段直接相关的表述：①「使用第三方软件、工具或服务访问 Antigravity 违反本服务条款，可能导致账号被暂停或终止」；②「把 `agy` 包装进第三方编码 Agent/应用、或自动化账号轮换，在消费者套餐下不受支持」。Google 同时公开发布了 ACP 接入 Zed/JetBrains 的官方文档，因此「编辑器插件」与「第三方应用」的边界存在解释空间。本插件采取的降低风险措施：**默认启用但可一键关闭**（总览卡片上的开关；关闭后不再启动 `agy`、不再探测登录、子代理拒绝委派）、单账号（不做账号轮换）、不读取或搬运任何 Google 凭据、不伪装客户端身份；但**这些措施不能消除条款风险**。需要零争议时请改用 Gemini Enterprise 或 Google AI Studio API Key。
> 请在使用前自行评估账号与合规风险。

---

## 2. 本机登录态收编（Adopt）

多条线路支持一键导入本机已安装的官方 CLI 或桌面客户端登录态，免去重复授权：

| 线路 | 探测路径 | 续期与写回策略 |
| --- | --- | --- |
| `codex-chatgpt` | `$CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`） | **只读快照，永不刷新**；绝不写入或删除 CLI 文件 |
| `claude-subscription` | `$CLAUDE_CONFIG_DIR/.credentials.json`（默认 `~/.claude/.credentials.json`） | **只读快照，永不刷新**；绝不写入或删除 Claude Code 文件 |
| `minimax-code` | `~/.minimax/auth/<buildEnv>/<region>/mcode-public/auth.json` | 有效期内只读复用；临期（5 分钟内）通过临时文件 + `rename` 原子写回，不碰 `auth.lock`，登出绝不删除桌面凭据 |
| `glm-coding-plan` | `~/.zcode/v2/credentials.json`（`ZCODE_DATA_BASE_DIR` 可覆盖） | **只读导入**并走同一兑换链换取 Coding Plan Key（设置 `ZCODE_CREDENTIAL_SECRET` 时无法推导密钥，回落浏览器登录） |
| `step-code` | `~/.stepcode/auth.json` | **只读导入**，不修改原文件 |
| `qoder` | `~/.qoder/.auth/user`（AES-128-CBC 信封） | **只读导入**，自动探测全球区/中国站 userinfo 归属 |
| `workbuddy-subscription` | CodeBuddy 桌面端认证目录（`CODEBUDDY_AUTH_DIR` / `WORKBUDDY_CONFIG_DIR` 可覆盖） | **只读采纳**，桌面账号只能隐藏、绝不删除 |

**为什么 Codex CLI 与 Claude Code 的导入快照永不刷新？**
这两家的 `refresh_token` 采用单次轮换（rotation），官方 CLI 会在原地刷新自己的凭据文件。若插件与官方 CLI 跨进程各自刷新同一枚令牌，后刷新的一方会触发作废，导致用户被踢出官方 CLI。因此：
- 打开设置页时只做 `stat` 检查文件是否存在，**点击导入前绝不读取令牌内容**；
- 导入行在快照过期后自动退出号池调度，回官方 CLI 重新登录后再点一次导入即可原地更新；
- 点击「停止导入 / 停止收编」只清理插件侧保存的快照，原客户端文件逐字节不变。

---

## 3. Codex（ChatGPT 订阅）：`codex-chatgpt`

- **登录方式**：
  - 浏览器 OAuth（PKCE S256，一次性监听 `http://localhost:1455/auth/callback`，5 分钟超时）；
  - 设备码登录（无本地浏览器或远程主机场景）；
  - 只读导入本机 Codex CLI 登录态。
- **上游固定端点**（无自定义 baseURL 覆盖，保障凭据边界）：
  - OAuth 令牌：`https://auth.openai.com/oauth/token`
  - 模型响应：`https://chatgpt.com/backend-api/codex/responses`（携带 `openai-beta: responses=experimental`）
  - 生图 / 参考图改图：`https://chatgpt.com/backend-api/codex/images/generations` 与 `https://chatgpt.com/backend-api/codex/images/edits`（对应工具 `codex_image_generate`）
  - 搜索：`https://chatgpt.com/backend-api/codex/alpha/search`（可在设置页切换为 DSH 搜索后端）
  - 额度：`https://chatgpt.com/backend-api/wham/usage`（含 Codex、Code Review 窗口、Credits 与 Reset Credits）
- **协议与参数对齐官方 Codex CLI**：
  - 支持标准 Responses 与 `Responses Lite`（按模型目录声明自动切换 `additional_tools` 等请求形状）；
  - 多轮会话携带稳定的 `prompt_cache_key`，并在上游下发 `x-codex-turn-state` 时回传续接；
  - 推理摘要默认省略（避免无感消耗计费生成 token），显式选择 `auto` / `concise` / `detailed` 时才发送；
  - 输出详细程度默认按目录声明发 `low`（仅对声明 `supportsOutputVerbosity` 的模型发送）；
  - **不发送 `max_output_tokens`**（订阅端点在多款模型上对显式 `max_output_tokens` 返回 400）；模型最大输出（GPT-6 系列 128K，其余 32,768）仅在本地作为 DSH 上下文压缩的输出预留（`defaultMaxTokens`）；
  - 单次请求图片内联负载默认上限 **2 MiB**（可通过 `DSH_CODEX_MAX_IMAGE_BYTES` 覆盖），超限按最旧优先替换为可见文字占位；
  - 生图工具支持可选尺寸、质量、透明背景、GIF 帧参数及最多 5 张本地 PNG/JPEG/WebP 参考图；新参数仅在显式提供时发送，上游拒绝时明确报错，不静默降级。
- **随包兜底模型表**：
  - GPT-6 家族：`gpt-6.1-sol`、`gpt-6.1-terra`（默认窗口 500K）、`gpt-6-astra`、`gpt-6-sol`、`gpt-6-luna`（默认窗口 272K，最高可覆盖至 **872K**；档位 `low`/`medium`/`high`/`xhigh`/`max`，历史 `none`/`minimal` 自动折算为 `low`）；
  - GPT-5.6 及更早家族：`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini`、`gpt-5.3-codex-spark`（最高可覆盖至 **1M**）；
  - 实际可选模型以账号实时 `/backend-api/codex/models` 返回清单为准，本地持久化目录快照加速冷启动。

### 宿主路由（`/api/dsh-chatgpt-subscription`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/status` | 账号（脱敏）、连接状态、额度、抓取后端状态及本机 Codex CLI 文件存在性 |
| `GET` | `/hub/overview` | 订阅中心首页 13 条线路的聚合只读摘要 |
| `GET` / `POST` | `/update`（检测 / 应用） | 检查 npm 新版本并在支持的部署上一键升级插件 |
| `POST` | `/i18n/locale` | 客户端向宿主同步当前界面语言（`zh` / `en` / `ru`） |
| `POST` | `/login/start` | 启动浏览器回调 OAuth 登录 |
| `POST` | `/login/device/start` | 启动设备码登录，返回 `userCode` 与校验链接 |
| `GET` | `/login/events?loginId=...` | SSE 订阅登录进度 |
| `POST` | `/login/cancel` | 取消进行中的登录 |
| `POST` | `/adopt` / `/adopt/disable` | 导入或清除本机 Codex CLI 登录快照 |
| `POST` | `/accounts` | 号池操作（设为主账号、别名、冷却清理、轮换策略等） |
| `POST` | `/storage` | 切换全局号池存储后端（`keyring` / `credentials`） |
| `POST` | `/logout` | 注销并清理凭据与额度缓存 |
| `POST` | `/token/refresh` | 手动刷新访问令牌 |
| `POST` | `/quota/refresh` | 强制刷新订阅额度（遵守 15s 节流与 `Retry-After`） |
| `POST` | `/quota/reset-credit/use` | 使用一次可用的额度重置卡（Reset Credit） |
| `POST` | `/connection/test` | 测试当前账号连接 |
| `POST` | `/compaction/candidates` | 读取当前可用的上下文压缩候选模型列表 |
| `POST` | `/preferences/update` | 更新代理、搜索来源、压缩模型、模型勾选与窗口覆盖等偏好 |
| `GET` | `/subagent-route-audit` | 读取子代理路由审计摘要 |

---

## 4. Claude（订阅）：`claude-subscription`

- **鉴权与客户端身份**：
  - 使用 Claude Pro / Max 订阅 OAuth 令牌访问 `POST https://api.anthropic.com/v1/messages?beta=true`（`Authorization: Bearer <token>`，严格省略 `x-api-key`）；
  - 注入官方 Claude Code 必需的 `user-agent: claude-cli/<version>`、`x-app: cli`、`anthropic-beta`（含 `oauth-2025-04-20`、`claude-code-20250219` 及按需附加的 `thinking-binding-controls-2026-08-01`、`extended-cache-ttl-2025-04-11`）以及首块 `system` 身份声明；
  - OAuth PKCE 的 `state` 与 `code_verifier` 独立随机生成，支持**手动粘贴 `<code#state>`**（默认）与 **loopback 自动探测端口回调**两种模式；单次授权通过 CAS 防重兑换。
- **模型能力与思考模式**：
  - 随包内置 17 款 Claude 模型能力表（含 Opus 5.5、Sonnet 5.5、Haiku 5.5 等），实时可调用清单以 `GET /v1/models` 为准；未识别的新模型按官方规则继承当前代模板（adaptive thinking、effort、图片输入）；
  - 本地预检 `minCliVersion`（如 Opus 5.5 要求 `>= 2.1.280`，插件默认申报版本高于表内全部门槛，亦可用 `DSH_CLAUDE_CLI_VERSION` 覆盖）；
  - 四档思考形态按模型精确匹配：`mid-convo`（adaptive + `block_binding: drop_block` + `output_config.effort`）、`adaptive`（绑定前缀模型自动附带 `block_binding: drop_block`）、`budget`（`budget_tokens`，为正文至少预留 1024 token）、`none`；带签名的 `thinking` / `redacted_thinking` 块原样回放；
  - 支持合法位置的会话中途原生 `role: 'system'` 消息；单图 5 MiB base64 防线与整请求 8 MiB 图片预算独立执行；
  - **提示缓存 TTL** 可选「跟随官方（1h）/ 1 小时 / 5 分钟」。
- **额度与换号约束**：
  - 合并 `GET /api/oauth/usage`（0–100 百分比）与 `/v1/messages` 响应头（0–1 分数）双源额度；
  - 仅在凭据失效或账号级限流时换号（最多 3 次），全局过载/5xx 不换号，**一旦已产生流式输出绝不中途换号**。

### 宿主路由（`/claude/api`）

`GET /status` · `POST /login` · `GET /login/status` · `POST /login/cancel` · `POST /login/input` · `POST /adopt` · `POST /adopt/disable` · `GET|POST /quota` · `GET|POST /models` · `GET|POST /settings` · `POST /catalog/refresh` · `POST /connection/test` · `POST /accounts` · `POST /logout`

---

## 5. Kimi Code：`kimi-code`

- **鉴权与区域**：
  - 专用于 **Kimi Code 订阅**（`https://api.kimi.com/coding/v1`，与 Moonshot 按量开放平台互不通用）；
  - 采用 **RFC 8628 设备码登录**（默认中国大陆 `auth.kimi.com` / `api.kimi.com`；国际区可通过 `DSH_KIMI_CODE_OAUTH_HOST=https://auth.kimi.ai` 与 `DSH_KIMI_CODE_BASE_URL=https://api.kimi.ai/coding` 切换）；
  - 访问令牌提前续期、并发单飞；重新登录操作严格校验账号身份一致性，防止浏览器串号覆盖。
- **模型、思考与协议特性**：
  - 覆盖 `k3`、`k3-256k`、`kimi-for-coding`、`kimi-for-coding-highspeed`、`k3.1-pro`、`k3.1-pro-highspeed`，实时以 `GET /v1/models` 为准；默认走 OpenAI Chat Completions，实时目录声明支持时可走 Anthropic Messages（携带 `clear_thinking_20251015` 与尾部可缓存块 `ephemeral` 断点）；
  - 严格遵循 K3 规范：思考档位仅发模型声明集合（`low` / `high` / `max`；`k3.1-pro` 系列强制开启思考），开启思考时历史 assistant 消息必带 `reasoning_content`，不发 `temperature`，`stop` 裁剪至 ≤5 条且每条 ≤32 字节；
  - 支持 `k3` 消息级动态工具声明（`dynamically_loaded_tools`），并在工具调用批次未闭合前自动缓冲中途插入的系统/用户消息，杜绝工具结果乱序 400；
  - 支持视频输入（`k3`、`kimi-for-coding`、`k3.1-pro` 系列）并注册 `kimi_attach_video` 工具（视频预算 48 MiB base64）；
  - **粘性双水位内联图片预算**：默认 20 MiB 高水位 / 10 MiB 低水位（`DSH_KIMI_CODE_MAX_IMAGE_BYTES` 可覆盖），只计量实际发送的 base64 字节；OpenAI 协议下成功上传的 `ms://` 图片引用不占该预算，上传失败回退为内联时重新计量。已淘汰旧图持久化记录，避免后续轮次反复重算打断前缀缓存；
  - **请求体守卫与自动压缩衔接**：1M 档模型默认上限 **24 MiB**、256K 档默认 **2 MiB**（`DSH_KIMI_CODE_MAX_BODY_BYTES` 可覆盖），超限抛出 `CONTEXT_WINDOW_EXCEEDED` 交由 DSH 自动压缩重试；另支持 `DSH_KIMI_CODE_BYTES_PER_TOKEN` 提前压缩折算；
  - **缓存预热与等待策略**：自动监测约 25 分钟前缀缓存存活窗口，配合 `cache-warmup` 子系统（大结果 `ref://` 预览 + `cache_warmup_result` 精确分页补读）、主代理等待子代理期间的可选轻量续热，以及四段式重复工具调用刹车（`KIMI_CODE_REPEAT_BREAKER`）。
  - **共享化边界**：结果预览与分级重复提醒可覆盖其他受控线路；静态前缀排序和 in-flight 冷启动协调已复用到 Codex、Step、Claude、MiniMax。账号亲和、warm 跳过、等待续热和 hosted media 仍按各线路证据与 `promptCacheOverrides` 启用，Kimi 的 TTL、协议字段和错误词表不向外复制。
  - **慢预填充与断流**：首 chunk 前允许等待 360 秒，专用响应头传输兜底为 420 秒；首 chunk 后按 120 秒传输活动预算检测断流。看门狗 TIMEOUT 不自动重试，避免上游已接收长前缀后重复写入缓存并消耗额度。
- **额度窗口**：展示 5 小时、7 天、月度会员共享池、月度 Kimi Code 池四个窗口与加油包余额。

### 宿主路由（`/kimi-code/api`）

`GET /status` · `POST /login` · `GET /login/status` · `POST /login/cancel` · `POST /logout` · `GET|POST /quota` · `GET|POST /models` · `POST /catalog/refresh` · `POST /connection/test` · `POST /accounts`

---

## 6. MiniMax Code（编程订阅）：`minimax-code`

- **鉴权与桌面端共生**：
  - 接入 MiniMax Code 编程订阅 Anthropic Messages 接口（国区 `agent.minimax.cn` / 国际区 `agent.minimax.io`，仅使用 `Bearer` 认证）；
  - 优先只读复用本机桌面端 `~/.minimax/auth/<buildEnv>/<region>/mcode-public/auth.json`（或显式导入号池），无桌面端时使用 RFC 8628 设备码登录并存入 `$DSH_HOME/storages/minimax-code-credentials.json`；
  - 单次刷新令牌提前 5 分钟按身份单飞轮换，落盘前先核对磁盘是否已被桌面端刷新，避免跨进程误判失效。
- **模型、思考与视频能力**：
  - 因上游订阅网关未开放 `GET /v1/models`，随包内置硬编码目录（`MiniMax-M2.7`、`MiniMax-M2.7-highspeed`、`MiniMax-M3`、`MiniMax-M3.1-Flash`）；
  - 思考控制统一走 `output_config.effort`（M2.7 恒开无档位，M3 开关二态，M3.1 Flash 支持 `low`/`medium`/`high`/`xhigh`/`max`，未选档位时不默认顶到 `max`）；携带 `interleaved-thinking-2025-05-14` 支持跨轮签名思考回放；
  - 请求体默认上限 **64 MB**，单次请求图片预算 **16 MB**（可通过 `DSH_MINIMAX_CODE_MAX_BODY_BYTES` / `DSH_MINIMAX_CODE_MAX_IMAGE_BYTES` 覆盖）；
  - **全套视频工作流**：M3 / M3.1 Flash 支持原生视频块输入；注册 `minimax_generate_video`（支持 MiniMax-H3 / H3-Max / Hailuo-2.3 文生视频、首尾帧与多模态参考，自动下载至工作区）与 `minimax_understand_video` 工具，客户端配套提供 `/video` 交互式参数弹窗、对话内播放器与右侧栏文档预览器；
  - 内置工具参数无损强转与失控连击提醒守卫（`runtime-enhancements`），并支持每日签到与重置卡操作。
- **额度说明**：`coding_plan/remains` 端点要求第一方客户端标识头；插件默认**不伪造**客户端签名头，如需读取 5 小时 / 每周额度条，需显式设置环境变量 `DSH_MINIMAX_CODE_QUOTA_ATTRIBUTION=1`。

### 宿主路由（`/minimax-code/api`）

`GET /status` · `POST /login/start` · `POST /login/poll` · `POST /login/cancel` · `POST /logout` · `POST /test` · `GET|POST /models` · `GET|POST /settings` · `GET|POST /accounts` · `GET|POST /quota` · `POST /checkin` · `POST /reset-card`

---

## 7. Command Code：`command-code`

- **鉴权与双协议分发**：
  - 支持浏览器 loopback OAuth（`127.0.0.1:5959` 起顺延）或手动粘贴 Studio API Key，保存前均经 `/alpha/whoami` 校验；
  - 按模型 ID 自动分流：`claude-*` 走 Anthropic Messages（`/provider/v1/messages`，`system` 使用带 `ephemeral` 缓存断点的块数组，缺省 `max_tokens: 64000`），其余模型走 OpenAI Chat Completions（`/provider/v1/chat/completions`）。
- **模型目录与隐私控制**：
  - 实时目录取自公开 `/provider/v1/models`，多模态与思考档位查随包完整转录的官方 `command-code@1.88.4` 注册表（109 条模型记录，不做模型名前缀猜测），单次请求图片预算 **12 MiB**；
  - 支持零数据保留（Zero Data Retention）：设置 `DSH_COMMAND_CODE_ZDR=1`（或 `CMD_ZDR=1`）时强制附加 `x-cmd-zdr: 1`，若上游无满足 ZDR 的渠道（422 `cmd_zdr_no_providers`）则严格闭锁报错，绝不静默剥离隐私头重试；
  - 若 `command-code` 路由被内置 `llm-pi-ai` 同名配置占用，设置卡会清晰提示冲突并在移除占用后自动接管。

### 宿主路由（`/command-code/api`）

`GET /status` · `POST /login` · `GET /login/status` · `POST /login/apikey` · `POST /logout` · `GET|POST /quota` · `GET|POST /models` · `POST /settings` · `POST /catalog/refresh` · `POST /connection/test` · `POST /accounts`

---

## 8. GLM（ZCode 账号）：`glm-coding-plan`

- **鉴权与两区隔离**：
  - 面向 **GLM Coding Plan**（支持付费套餐与新用户 5 天免费体验额度），支持国区 BigModel（`bigmodel.cn` / `open.bigmodel.cn`）与国际区 Z.ai（`api.z.ai`），两区账号在号池内严格按区域隔离；
  - 通过 ZCode CLI OAuth 控制面（`zcode.z.ai/api/v1/oauth/cli/*`）轮询授权并自动兑换套餐专用 Coding Plan Key，也可只读导入 `~/.zcode/v2/credentials.json`；上游无 `refresh_token` 接口，令牌过期需重新发起登录（国际区业务 JWT 自动提前续期）。
- **协议与目录**：
  - 走套餐专用 Anthropic Messages 端点 `{apiHost}/api/anthropic/v1/messages`（绝不误走扣充值余额的通用开放平台 `/api/paas/v4`）；
  - 随包目录转录自官方 `zai-org/ZCode` 的 `zcode-builtin.json`（`GLM-5.3`、`GLM-5.3-Flash`、`GLM-5.2`、`GLM-5-Turbo`），思考档位走 `output_config.effort`，`system` 与末条非 system 消息自动布置 `ephemeral` 缓存断点；
  - 全部兑换与业务端点均支持 `DSH_GLM_*` 环境变量覆盖。
- **验证边界**：本线路基于官方开源仓库与契约构建并通过完整 mock 回归验收，尚未在生产环境用真实付费/体验账号完成端到端实机联调，首次接入建议先结合设置卡「测试连接」验证。

### 宿主路由（`/glm-coding-plan/api`）

`GET /status` · `POST /settings` · `POST /accounts` · `POST /login/start` · `GET /login/status` · `POST /login/cancel` · `POST /login/manual` · `POST /adopt` · `POST /connection/test` · `POST /quota` · `POST /catalog/refresh`

---

## 9. Step Code（Step Plan 订阅）：`step-code`

- **鉴权方式**：
  - 支持国区 `api.stepfun.com` 与国际区 `api.stepfun.ai`（按凭据 `profile` 严格隔离）；
  - 三种模型凭据入口：① 云端轮询浏览器授权（不开本地回调端口）；② 手工粘贴 Platform API Key；③ 只读导入 `~/.stepcode/auth.json`；
  - 可选独立提交开放平台账号密码或 `Oasis-Token` 仅用于读取开发者中心额度面板（提交后不回读、不与模型请求耦合）。
- **能力与缓存**：
  - OpenAI Chat Completions 协议；模型目录**纯运行时实时发现**（随包目录为空），图片支持、思考档位梯子与上下文窗口均以实时目录字段为准；无真实输出上限声明时省略 `max_tokens`；
  - Step 服务端采用自动前缀缓存，设置卡仅展示读侧缓存命中统计，不伪造写侧计数或未公开单价。
- **验证边界**：云端轮询登录、`Oasis-Token` 换取与额度接口、实时目录解析已完成实机验证；完整多轮模型对话与 `adopt` 异常分支由 mock 覆盖。

### 宿主路由（`/step-code/api`）

`GET /status` · `POST /settings` · `POST /accounts` · `POST /login/start` · `GET /login/status` · `POST /login/cancel` · `POST /login/manual` · `POST /adopt` · `POST /connection/test` · `POST /quota` · `POST /catalog/refresh` · `POST /quota/credential`

---

## 10. Cline Pass：`cline-pass`

- **鉴权方式**：
  - 默认通过 **WorkOS 设备码 OAuth** 登录，聊天请求携带 `Authorization: Bearer workos:<accessToken>` 并支持 `refresh_token` 自动轮换续期；
  - 保留静态 API Key（设置页添加或环境变量 `CLINE_PASS_API_KEY`）作为兼容回退。
- **自动路由与防呆**：
  - OpenAI Chat Completions 协议，对零内容、零工具的空正常结束轮次按官方策略有界重试（最多 3 次，内容出现前缓冲防泄漏）；
  - 上游渠道完全由 Cline 网关自动选择，不发送 `provider` / `providerOptions` 钉选字段；只从响应 `provider_metadata` 读回真实服务渠道；
  - 对无 ZDR 保障的匿名贡献者路由（`openai-compatible-private`）在 UI 上显式给出 `⚠` 警示；
  - 可选开启 5 个 `cline_pass_*` 管理工具（默认关闭以保持工具列表精简与缓存稳定，开启后重启 DSH 生效）。

### 宿主路由（`/cline-pass/api`）

`GET /status` · `POST /login/start` · `GET /login/status` · `POST /login/cancel` · `POST /settings` · `GET|POST /accounts` · `GET|POST /models` · `POST /models/test` · `POST /models/visibility` · `POST /models/visibility-all` · `POST /models/context-window` · `POST /catalog/refresh` · `GET|POST /usage` · `GET /history`

---

## 11. Qoder（订阅）：`qoder`

- **鉴权与双区隔离**：
  - 支持全球区 `qoder.com` 与中国站 `qoder.com.cn`（凭据严格绑定区域）；
  - 登录入口：① 浏览器设备流（仅全球区支持）；② 粘贴 Personal Access Token（`pt-...`，两区均支持，自动兑换短期 `jt-...` job token 并在到期前 1 小时续期）；③ 只读导入本机 `~/.qoder/.auth/user`（自动双区探测归属）。
- **协议与目录**：
  - 对接 Qoder 自有 `RemoteChatAsk` 信封 + 自定义 body codec + COSY 请求头签名 + 信封 SSE；生成请求纳入共享并发闸门，会话亲和 `session_id` 按账号 `uid + model` 隔离；
  - 模型目录通过 COSY 签名实时发现并结合随包能力兜底表解析 `context_config`、`is_vl`、`thinking_config`。
- **验证边界**：协议编解码、COSY 签名与流解析由官方 CLI v1.1.34 frozen fixtures 逐字节锁定测试，尚未做真实付费账号线上联调。

### 宿主路由（`/qoder/api`）

`GET /status` · `POST /settings` · `POST /accounts` · `POST /login/start` · `GET /login/status` · `POST /login/cancel` · `POST /login/manual` · `POST /adopt` · `POST /connection/test` · `POST /quota` · `POST /catalog/refresh`

---

## 12. OpenDesign：`opendesign`

- **鉴权与双钥机制**：
  - 官方明确支持包括 DSH 在内的第三方编码 Agent 接入；
  - **推荐浏览器设备授权**：签发 `vela_ctrl_…` 控制 Key（读取钱包余额与 Go / Plus / Pro / Max 账单周期摘要）与 `sk-amr-…` 运行时 Key（走 `https://amr-link.open-design.ai/v1` 对话）；
  - **回退粘贴 API Key**（或环境变量 `OPENDESIGN_API_KEY`）：仅用于对话，不含控制 Key 故不展示账单摘要。
- **模型目录与预算**：
  - 随包内置 37 款模型及官方公开单价与同族核对能力，登录后自动同步 AMR 控制面目录（含真实 `contextWindowTokens`）与网关 `/v1/models`；
  - 按官方规则自动区分 `max_tokens` 与 `max_completion_tokens`，并对特定字段拒收 400 做单次精确降级重试。

### 宿主路由（`/opendesign/api`）

`GET /status` · `POST /settings` · `GET|POST /accounts` · `POST /login/start` · `GET /login/status` · `POST /login/cancel` · `GET|POST /models` · `POST /models/visibility` · `POST /models/visibility-all` · `POST /models/context-window` · `POST /catalog/refresh` · `GET|POST /usage`

---

## 13. WorkBuddy（CodeBuddy 订阅）：`workbuddy-subscription`

- **鉴权与区域**：
  - 支持国区 `copilot.tencent.com` 与国际区 `www.workbuddy.ai`（按凭据 `domain` 绑定区域）；
  - 支持浏览器轮询登录或只读采纳本机 CodeBuddy 桌面端登录态（桌面端账号只可隐藏、不可删除）；支持国区每日自动签到与本地用量护栏。
- **协议与风控保护**：
  - 常规模型走 `/v2/chat/completions`，国区 Claude 模型走 `/v1/messages`（保留签名 thinking 与 `output_config.effort`），目录取自 `/v3/config`；
  - 针对上游 `11128` 渠道校验实现窄指纹修正与单次头部指令搬移记忆；遇到 `11140` 账号受限立即停用该账号，若 30 分钟内第二个不同账号再遇 `11140`，整个号池自动熔断暂停 **30 分钟**以保护剩余账号。

### 宿主路由（`/workbuddy/api`）

`GET /status` · `POST /login` · `GET /login/status` · `POST /login/cancel` · `POST /logout` · `GET|POST /quota` · `GET|POST /models` · `POST /settings` · `POST /catalog/refresh` · `POST /accounts` · `POST /checkin`

---

## 14. Ollama：`ollama`

- **定位与鉴权**：
  - 对接 **Ollama Cloud**（`https://ollama.com`），使用在 `https://ollama.com/settings/keys` 创建的静态 API Key（`Bearer` 认证，支持多 Key 号池轮换）；不开放任意本地/内网自定义出站地址，确保 SSRF 边界清晰。
- **双协议面与元数据发现**：
  - 同时对接 Ollama Native 接口（`/api/chat`、`/api/tags`、`/api/show`）与 OpenAI 兼容接口（`https://ollama.com/v1/chat/completions`）；
  - 通过 `/api/show` 逐模型探测真实的思考能力与档位（`none` / `low` / `medium` / `high`），对不可关闭思考的模型自动抬高极小辅助请求（如会话标题生成 `maxTokens: 64`）的输出下限至 `512`，防止思考耗尽预算导致空标题；
  - 流式空闲超时单独设为 **300 秒**（其余云端线路统一为 120 秒），适配长上下文慢首字延迟。

### 宿主路由（`/ollama/api`）

`GET /status` · `POST /settings` · `POST /accounts` · `POST /catalog/refresh` · `POST /logout`

---

## 15. Antigravity（ACP）：`antigravity-acp`

- **定位与鉴权**：
  - 走 **Google 官方 Antigravity CLI 的 Agent Client Protocol（ACP v1）**：本插件把一次模型调用翻译成一次 ACP `session/prompt`，模型联网、登录、思考签名与提示缓存全部由官方 `agy` 进程负责；
  - **单账号**：ACP 服务端只持有一套凭据，插件**不读取、不复制、不保存**任何 Google token；登录由 `agy acp --login` 或设置卡的「登录 Google 账号」发起，浏览器**只由官方进程打开一次**；
  - 与已移除的旧 `antigravity` 线路（Cloud Code Assist `streamGenerateContent` 逆向实现，v0.70.0 删除）**没有任何代码或凭据迁移关系**。
- **可执行文件**：`配置的路径` → `DSH_ANTIGRAVITY_ACP_BIN` → `~/.gemini/bin/agy` → 官方 ACP Registry 归档（版本与 sha256 随包固定，仅缺失时下载到 `<DSH_HOME>/cache/antigravity-acp/`）。下载拒绝重定向、校验哈希、失败按名删除半成品；**不随包分发 Google 二进制**。
- **工具由 DSH 执行并把关**：会话创建时带一个回环 MCP 桥描述符（127.0.0.1 + 每次会话新签发的 256-bit bearer token、校验 Host、拒绝浏览器 Origin、仅 `POST /mcp`、body ≤ 1 MiB）。agent 的 `tools/call` 被挂起并转成 DSH 工具调用，由 DSH 的权限预设执行；拒绝以 `isError` 回传，**永不绕过**。桥工具的权限请求**恒定放行**（它交回 DSH 后由 DSH 把关）；「工具权限」设置只作用于 agent 自己的工具，默认「自动批准」，可选「拒绝」。
- **自带工具策略（`nativeToolPolicy`）**：ACP 无法在协议层卸载 agent 的内置 shell/文件工具。默认 `allow`：模型一旦使用自带工具，对话里出现一条可见记录（工具名 + 参数），本轮继续；`cancel` 保留旧的严格行为，遇到即报 `ACP_NATIVE_TOOLS_UNSUPPORTED` 并取消整轮。
- **模型与思考档位**：目录来自实时 ACP `session/new`（`models.availableModels` 的档位 id 与 `configOptions[model].options` 的基名归一），思考档位走 DSH 的 reasoning effort → ACP `thought_level`；模型不接受的档位被丢弃而不是让整轮失败。
- **会话复用（跨轮）**：以 DSH 会话为键**停放**刚结束的 ACP 会话（连同跑它的进程与 MCP 桥，默认 2 个、闲置 5 分钟回收）；下一条用户消息若「前缀指纹未变 + 工具目录未变 + 进程存活」就只发送增量 prompt，换模型/思考档位用 `session/set_config_option` 在同一 conversation 内切。历史被压缩或改写、工具集变化、进程死亡、重配置被拒时一律新建会话冷重放，且重放 prompt 末尾追加 history-boundary 锚点（当前任务=最后一条用户消息、不重跑已完成请求）。会话标题与压缩这类辅助请求用同一个 `sessionId` 但历史独立，不消费也不覆盖停放的会话。
- **子代理形态**：同时注册 `antigravity-acp` 子代理后端（`ctx.get('subagents')` 存在时才注册）；子代理子进程使用官方 Agent 自己的工具集，这是与主模型形态的已知不对称。
- **明确的能力边界**：ACP 没有独立 system 提示槽位，也没有 `temperature` / `stop`（显式拒绝为 `ACP_UNSUPPORTED_OPTION`）；`maxTokens` 会被丢弃而不是拒绝，因为标题生成等辅助调用固定带一个上限。官方服务端**不公布剩余额度**，因此设置卡与额度胶囊只显示套餐档位与真实返回的 token 用量，不显示任何百分比或余额。

### 宿主路由（`/antigravity-acp/api`）

`GET /status` · `GET|POST /settings`（等同 `/models`）· `POST /login/start` · `GET /login/status` · `POST /logout` · `GET|POST /usage` · `POST /refresh`
