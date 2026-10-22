# DSH ChatGPT Subscription

让 DSH（DeepSeek Harness）通过 ChatGPT 订阅使用 Gpt 系列模型的插件。

插件注册 `codex-chatgpt` Provider（显示名 **“Codex（ChatGPT 订阅）”**），以当前 Host 用户的 ChatGPT OAuth 登录态访问模型，并在设置页展示账号信息、连接状态与订阅额度。支持 Windows 与 Linux。

## 目录

- [线路总览](#线路总览)
- [功能特性](#功能特性)
- [模型目录](#模型目录)
- [环境要求](#环境要求)
- [安装](#安装)
- [使用](#使用)
- [推理塌缩守卫（熔断，默认关闭）](#推理塌缩守卫熔断默认关闭)
- [Command Code 线路](#command-code-线路)
- [Claude（订阅）线路](#claude订阅线路)
- [GLM（ZCode 账号）线路](#glmzcode-账号线路)
- [Step Code（Step Plan 订阅）线路](#step-codestep-plan-订阅线路)
- [Cline Pass（OAuth 订阅）线路](#cline-passoauth-订阅线路)
- [Qoder（订阅）线路](#qoder订阅线路)
- [OpenDesign（订阅，API Key / 浏览器授权）线路](#opendesign订阅api-key--浏览器授权线路)
- [子代理模型授权](#子代理模型授权0215-起032-起强制指定模型)
- [随包分发的 Agent Preset](#随包分发的-agent-preset)
- [本机登录](#本机登录)
- [安全边界](#安全边界)
- [插件路由](#插件路由)
- [组件看板卡片（dsh-widget-board）](#组件看板卡片dsh-widget-board)
- [开发与验证](#开发与验证)
- [故障排查](#故障排查)

## 线路总览

本插件同时接入 **11 条订阅线路**，每条各自独立注册 Provider、独立登录、独立额度卡片。

| Provider ID | 订阅 | 协议 | 登录方式 | 模型目录来源 |
| --- | --- | --- | --- | --- |
| `codex-chatgpt` | ChatGPT（Plus / Pro / Business…） | Responses | 浏览器 OAuth（localhost:1455 回调），或导入本机 Codex CLI 登录 | **实时** `/backend-api/codex/models` |
| `kimi-code` | Kimi 会员 | Anthropic Messages | **设备码**（RFC 8628） | 实时 `/v1/models` + 本地兜底 |
| `command-code` | Command Code | Anthropic / OpenAI 双轨 | 浏览器 OAuth 或粘贴 API Key | 实时 `/provider/v1/models` |
| `claude-subscription` | Claude Pro / Max | Anthropic Messages | 手动粘贴 / loopback 回调 | 实时 `/v1/models` + 本地兜底 |
| `minimax-code` | MiniMax Code 编程订阅 | Anthropic Messages | **复用桌面端登录态** 或设备码 | **硬编码**（见下） |
| `antigravity` | Google Antigravity | Gemini | Google OAuth | 内置表 |
| `glm-coding-plan` | GLM Coding Plan（ZCode 账号，国区 BigModel / 国际区 Z.ai） | Anthropic Messages + OpenAI Chat Completions（按模型声明） | ZCode 账号 OAuth（浏览器中转轮询）+ 可选导入本机 ZCode 登录态 | 随包目录（源自官方 `zcode-builtin.json`） |
| `step-code` | StepFun Step Plan 订阅（国区 api.stepfun.com / 国际区 api.stepfun.ai）或开放平台 API Key | OpenAI Chat Completions | **云端轮询**浏览器授权（不开本地回调端口）/ 手工粘贴 Platform API Key / 只读导入本机 `~/.stepcode/auth.json` | **实时运行时发现**（随包表刻意为空） |
| `cline-pass` | Cline Pass | OpenAI Chat Completions | **浏览器设备码 OAuth**（WorkOS，账号入池、自动续期）；API Key 仅作兼容回退 | 随包表兜底 + 官方 `recommended-models` / models.dev / 上游网关目录补全 |
| `qoder` | Qoder 订阅（全球区 qoder.com / 中国站 qoder.com.cn） | Qoder 自有（COSY 签名 + 信封 SSE） | **浏览器设备流**（仅全球区）/ 手工粘贴 PAT（两区）/ 只读导入本机 `~/.qoder/.auth/user` | **实时运行时发现**（COSY 签名 GET）+ 随包能力兜底表 |
| `opendesign` | OpenDesign 订阅（Go / Plus / Pro / Max） | OpenAI Chat Completions | **浏览器设备授权**（AMR 设备流，签发控制 Key + 运行时 Key）；粘贴 Cloud 控制台的 API Key 作回退 | 随包表兜底（源自官方公开价目）+ 实时 `GET /v1/models` |

> **只有 minimax-code 是硬编码目录，而且是有意的**：该端点的 `GET /v1/models` **未对订阅流量开放**（返回 503 `direct_route_not_configured`），任何「实时目录」都只会是一个必然失败的请求。其取值转录自本机官方客户端的 `config.yaml`。
>
> **线路之间互不影响**：某条线路的登录失败、额度耗尽或上游故障都不会波及其它线路；它们共用同一套号池内核与账号卡片，但不是同一个池。
>
> ⚠️ **合规提示**：`claude-subscription` 使用的订阅凭据转发方式与 Anthropic 现行条款存在冲突（详见该章节开头的「风险须知」），且插件未获官方授权；`antigravity` 线路的用户亦有账号被限制的公开报告。请自行评估风险。
## 功能特性

### 登录与会话

- Authorization Code + PKCE（S256）登录，一次性 localhost 回调；
- 支持 token 刷新、登录取消与账号注销；
- Windows 使用 CurrentUser DPAPI 加密存储 token；Linux 使用当前用户独占的 `0600` 文件存储；明文不发送给 Client；
- 设置页会明确显示当前存储类型，并在 Linux 上提示文件存储未额外加密。
- **本机已经登录过 Codex CLI 的用户可以不再走一次 OAuth**（详见「本机登录」）：**ChatGPT 卡片**的账号池里，「登录」按钮**旁边**还有一个「导入本机 Codex CLI 登录」按钮——两者是同一件事的两种做法，布局与 Claude 页面上那个收编按钮一致。它**只看凭据文件是否存在、从不读取令牌**，且要你显式点那个导入按钮之后才会读取。导入得到的是一份**快照**，**永不由本插件刷新**——ChatGPT 的 refresh token 会轮换，而 CLI 会在原地刷新自己的文件，两个进程各自刷新会互相作废，最后是你被本插件的好意踢出 Codex CLI，而进程内的单飞解决不了这个**跨进程**竞态。快照过期后请**回 Codex CLI 重新登录后再导入**；本插件**绝不写入或删除 Codex CLI 的任何文件**。

### 模型接入

- 固定 Codex Responses 地址，支持流式文本、reasoning summary、图片输入与工具调用/结果；
- **模型目录来自订阅后端**（`GET /backend-api/codex/models`）：
  - 按账号缓存并持久化到本地快照，重启后无需等待网络即可渲染选择器；
  - 随包发布的模型表是**兜底**而非上限：取不到目录时选择器变宽，而不是消失；
  - 目录里本表没听过的模型照常出现，但未声明的能力按保守值回落，不会凭空多出图片或思考档位；
  - 只有目录**确实列出**的模型会进入选择器——它是「这个账号能调什么」的权威；
- **请求带 `openai-beta: responses=experimental`**：
  - 该订阅后端在 beta 标志下提供，官方 Codex CLI 一直发送这个头；
  - 缺它时请求面不同：当前后端宽容，但这正是收紧后会变成 400/403 的那一行；
- **读取参数默认值与官方 Codex 一致**（依据订阅目录 `GET /backend-api/codex/models`，与官方随包的 `codex-rs/models-manager/models.json` 同源）：
  - **推理摘要默认不发**：目录里每个模型都声明 `default_reasoning_summary: none`，官方以此为准。此前本插件在未配置时发 `summary: auto`，而摘要属于**计费生成**，等于每一轮都多花一块官方从不花的额度；现在默认省略该字段，用户显式选择 `auto` / `concise` / `detailed` 时照旧发送，选「无」也改为**省略字段**而不是发 `summary: none`（后者是让后端先生成再丢弃）。
  - **输出详细程度默认发目录值 `low`**：官方客户端每轮都发送模型目录里的 `default_verbosity`（当前全部为 `low`）。此前本插件在未配置时**整个不发** `text` 字段，于是服务端套用隐含的 `medium`——一个从未打开过该设置的用户，会拿到比官方客户端更啰嗦、也更贵的回答。现在未配置时按目录发 `low`，显式选择仍以用户为准。
  - 目录里**没有记录**的模型不猜：仅对该表声明了 `supportsOutputVerbosity` 的模型发送 `text`，避免把一个模型可能拒收的字段强加给它；
- **多轮续传**，避免每轮重发整个历史：
  - 每个会话发送稳定的 `prompt_cache_key`，让后端复用提示前缀；
  - 回传后端在响应头给出的 `x-codex-turn-state`，让它续接该轮；
  - 后端不再下发该头时立即停止回送——不重放过期值；
- **对话报文绝不发送 `max_output_tokens`**：订阅版 Responses 端点在部分账号/模型上直接以 `400 Unsupported parameter: max_output_tokens` 拒收该字段（[#29](https://github.com/Aa728848/dsh-chatgpt-subscription/issues/29)，实测 `gpt-6-sol` / `gpt-6.1-sol`），官方 CLI 的请求结构里也没有这个字段；输出长度由服务端默认值决定，撞上限仍以 `max-tokens` 结束原因上报（详见「模型目录」）；
- **单次请求的图片负载有上限（2 MiB，可用 `DSH_CODEX_MAX_IMAGE_BYTES` 覆盖）**：历史里的每张图片每轮都会被重新内联，此前这条线路**没有任何总量约束**，长会话的请求体随读图数量单调增长，超过传输层能接受的体积后整轮失败，而报错只是一句没有信息量的「Codex could not be reached.」（[#50](https://github.com/Aa728848/dsh-chatgpt-subscription/issues/50)）。现在按**最旧优先**把超出预算的图片替换为一条明确的占位文本，请求体因此有界，且模型知道那张图已经不在了；
  - 预算是**在构造好的请求体上**执行的，因为图片有两种到达方式：粘贴的附件是 `{ type: 'image', attachment }` 块，而工具读取的本地图片是 `![](/describe-image/raw/sha256:…)` 链接、由映射器在构造时才取回并内联。只扫消息块的方案看不到第二种；
  - 数字取自 #50 的实测（≤3 MB 全过、≥4 MB 全挂），而不是照搬别的线路：Kimi 的 1.5 MB 是按它自己的 2 MB 请求上限定的，用在这里会静默删掉本端点能接受的图片；MiniMax 的 16 MB 是按 64 MB 请求体定的，这里没有那个上限；
  - 只约束**图片**这部分。纯文本本身就超出传输层体积的请求仍然会被拒绝，任何图片预算都救不了它；
- **请求路径的传输层失败会带上原因链**：此前 `request()` 把任何失败都报成同一句 `Codex could not be reached.`，而 DSH 只持久化 `{message, code}`，于是 `NGHTTP2_ENHANCE_YOUR_CALM`、`ECONNRESET`、`UND_ERR_SOCKET` 在界面和日志里长得一模一样——上面那条体积问题正是因此无法自助定位。现在与流中段断流（`streamFailure`）一致，把 cause 链拼进 message；
- Antigravity（Gemini / Claude）线路同样接受图片输入：DSH 以 `{ type: 'image', attachment }` 下发的粘贴图片会经附件服务读出字节并按 Gemini `inlineData` 发出，读不出的图片降级为一条可见的说明文本而不是被静默丢弃。单次请求的图片 base64 负载超过 12 MiB 时，最旧的图片按上游同款占位文案替换为文本，避免整条请求被体积上限拒绝；
- 原样转发 DSH 暴露的工具 schema；命令工具兼容 `pwsh` / `powershell`、`bash`、`sh` 与 `shell`，并按 PowerShell、Bash 或 POSIX sh 注入对应说明；
- 429/5xx 由 DSH retry policy 接管；401 只强制刷新并重试一次，支持 `AbortSignal`；
- Codex、Code review 及上游返回的额外窗口额度，支持 Credits、月度消费控制与 reset credits 展示；60 秒缓存、15 秒上游节流并遵守 `Retry-After`；
- 提供 ChatGPT 订阅侧 Codex 搜索 provider，可在设置页切换 DSH 默认搜索或 Codex 订阅搜索；
- 新增 `codex_image_generate` 工具，生成图片后通过 DSH 附件系统保存并在会话中渲染；
- 可选 composer 快捷用量徽标，按当前 `codex-chatgpt` 模型显示最紧张窗口的剩余额度。


### Command Code 线路

- 注册 `command-code` Provider，使用 Command Code 的 Provider API 与账户 API；模型 id 决定线路：`claude-*` 走 Anthropic Messages（`/provider/v1/messages`），其余模型走 OpenAI Chat Completions（`/provider/v1/chat/completions`），因为该 API 会拒绝把模型发到格式不符的端点；
- 浏览器登录复刻官方 CLI 的回环回调契约（`127.0.0.1:5959` 起顺延，`/callback` 接受 Studio 页面的跨域 POST），也可在设置页手动粘贴 API Key；两条路径都先用 `/alpha/whoami` 验证再加密保存；
- 模型目录取自公开的 `/provider/v1/models`，每个模型的 `context_length` 作为默认上下文窗口，可逐模型覆盖；
- **模型能力逐模型查表**（`src/host/command-code/model-catalog.ts`，转录自官方 CLI 的模型注册表）：是否接受图片输入、支持哪些思考档位由该表决定，未知模型回落纯文本；
  - 图片能力**不能靠厂商/模型名前缀推断**——同厂商内部就会自相矛盾：`deepseek/deepseek-v4.1-flash` 与 `deepseek/deepseek-v4-flash-vision-exp` 支持图片，而 `deepseek/deepseek-v4-flash`、`deepseek/deepseek-v4-pro` 不支持；`z-ai/glm-5.3-flash` 支持而 `zai-org/GLM-5.3` 不支持；
- 额度与用量来自账户 API 的账单/用量线路，任一条失败不影响其余；
- **瞬时失败按 DSH retry policy 有界重试**：`command-code` 路由显式声明 `normal` 策略（最多 3 次，1.5s 起指数退避、15s 上限、0.2 抖动），覆盖 `RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`；
  - 上游模型供应商临时不可用（502/503/504/500，典型响应体是 `"{\"error\":{\"type\":\"server_error\"}}"`）被归类为 `SERVER` 并自动重试；
  - 429 会带上上游的 `Retry-After` 让退避按对方的节奏走；401/403 与 `ABORTED` 明确不重试；
- 模型勾选（含线路标签）、思考深度、上下文窗口覆盖与额度在「设置 → 订阅服务 → Command Code」标签页中配置，输入框右侧另有额度胶囊。

### Kimi Code 线路

- 注册 `kimi-code` Provider，接入 Moonshot 的 **Kimi Code 订阅**（`https://www.kimi.com/code`）。它与 Moonshot 开放平台（pay-as-you-go）是两套互不通用的系统：订阅的模型接口是 `https://api.kimi.com/coding/v1`，凭据只来自订阅 OAuth；把开放平台的 key 或 base URL 用在这里会被判为 `401 Invalid Authentication`；
- 登录用 **RFC 8628 设备码流程**（`auth.kimi.com`）：设置页点「设备码登录」后直接展示用户码与一次性链接（浏览器会自动打开），装好后无需回调端口、无浏览器环境也能手工完成；`slow_down` 会按 RFC 调宽轮询间隔，设备码过期会自动重新申请而不是直接失败；
- 访问令牌到期前按 `max(300s, expires_in×0.5)` 自动续期，同进程并发调用共用一次刷新；被拒的 refresh token 进入冷却并提示重新登录；
- **瞬时失败按错误类别重试**（`src/host/kimi-code/adapter.ts`）。**会重试**（有界退避，最多 3 次，1.5s 起步、15s 上限、0.2 抖动，并遵守上游 `Retry-After`）：
  - 上游模型供应商临时不可用（典型是 502 `"{\"error\":{\"message\":\"Upstream model provider is temporarily unavailable. Please try again in a moment.\",\"type\":\"server_error\"}}"`）；
  - 真正的 429 背压（`too many requests` / `engine is currently overloaded`）、连接失败与流停滞；
- **不重试**，直接给出可操作提示（换模型 / 降上下文 / 等窗口重置 / 重新登录）：配额耗尽型的 429、403 的账号额度上限、401 里的套餐权限不足、400 请求格式错误；
  - 服务把这些含义压进**同一个状态码**，因此分类读响应正文而不只看状态码；
- 模型目录为订阅侧的四款模型：`k3`（1M 上下文，需 Allegretto+；Moderato 上限 256K，故默认按 256K 计算，可用上下文覆盖升到 1M）、`k3-256k`、`kimi-for-coding`（K2.8 Preview）、`kimi-for-coding-highspeed`（约 6× 速度、3× 额度），运行时以 `GET /v1/models` 为准；
- **K3 行为按其官方文档实现**：
  - 思考档位只发 `low` / `high` / `max`（其余写法收敛映射，未知档位不发送）；关闭思考发 `thinking:{type:"disabled"}`，开启时发 `thinking:{type,effort,keep:"all"}`；
  - **开启思考时每条 assistant 消息都回传 `reasoning_content`**（无推理则回传空串——服务要求的是空值而非省略，否则 400）；
  - 不发送 `temperature`（采样参数按模型固定，显式值会报错）；
  - 工具调用 id 截断到 64 字符；
  - `stop` 按上限裁剪为最多 5 条、每条 ≤32 字节，超长整条丢弃（截断的停止串会在错误位置终止生成）；
- **K3 的长思考不会被截断**：输出上限跟随上下文窗口（保留 4096 余量），因为 `reasoning_content` 计入输出，固定 32K 会把 `max` 档的长推理中途截断并返回 `length`；调用方已知 prompt 规模时上限会被下调到放得下，未知时不做猜测；
- **请求体超 2 MB 本地即拒绝**：该端点最常见的 400 是 `total message size N exceeds limit 2097152`，官方文案不给建议，这里直接按真实序列化体积拦截，并按「循环实际做了什么」给出处方（有图可丢但丢了也补不上缺口 / 图已丢完仍超限 / 本来无图，三种情况文案不同，不再声称发生了没发生的省略）；确有实测上限的部署（前置代理/网关）可设 `DSH_KIMI_CODE_MAX_BODY_BYTES` 指定该档上限，取值非正整数时**回落到默认值而不是关闭守卫**；带视频的请求走 64 MiB 档，不受该变量影响；**超限时报的是可恢复的溢出码**（`CONTEXT_WINDOW_EXCEEDED`）：DSH 会对该码强制压缩本轮历史并重试同一步，所以长会话的表现是「压缩一次后继续」，而不是整轮失败——官方 `kimi-cli` 从不特殊处理 `2097152`，它靠 85% 提前压缩避开，详见下文「上下文窗口」那条；
- **缓存是自动的，且无法手动干预**：
  - Kimi 按请求内容哈希命中前缀缓存。实测 `prompt_cache_key` 与 Anthropic `cache_control` 标记**均被忽略**（设与不设、同 key 与异 key 命中的是同一缓存），设备 id 与协议切换也不影响；
  - TTL 实测在 300–1800 秒之间，按 256 token 对齐；`/messages` 与 `/chat/completions` **共享同一缓存**；
  - 真正决定命中率的是**内容稳定性**：同一会话内 `system` 或工具列表一旦变化会使整个前缀缓存失效（实测归零）。因此应保持工具集合稳定、把新增内容追加在末尾；
  - 卡片会显示滚动命中率，方便验证效果；
  - **写入时长可手动选择**（设置页）：`prompt_cache_options`（OpenAI 兼容线路）或**顶层** `cache_control`（Anthropic 兼容线路）控制缓存**写入时长**，与上面的「无法干预」不矛盾——那一条说的是**缓存身份**（由内容前缀哈希决定），TTL 管的是另一回事；
  - 档位在**首次写入时锁定**，之后无法改写、命中时按原档免费续期；1 小时写入约为 5 分钟的两倍价，只有同一前缀会在一小时内被反复读取才划算。不选择时不发任何缓存字段；
- **视频输入可用**（`k3`、`kimi-for-coding`）：
  - DSH 的模态词表只有 `text`/`image`，但它是可合并扩展的接口，本插件用 TypeScript 模块增强把它扩到 `video`（**未改动 DSH 任何代码**），因此视频走 DSH 真实的能力通道，而不是只能显示在提示里；
  - 适配器把视频映射为服务文档的 `{type:'video_url',video_url:{url:'data:…'}}`。视频与图片**各有独立预算**（图片 1.5 MB、视频 48 MiB base64，最旧优先省略），请求体校验只在确实带视频时才放宽到 64 MiB；
  - 图片预算可用 `DSH_KIMI_CODE_MAX_IMAGE_BYTES` 覆盖（取值非正整数时回落到默认值）。视频预算**没有**环境变量出口，与 MiniMax 线路一致；
  - 以下情况会把视频降级为明确的文字说明而不是猜字段发出去：`k3-256k` 只接受图片、文档白名单外的容器、以及未文档化视频内容块的 **Anthropic 线路**；
- **`dynamically_loaded_tools`（仅 K3）已实现**：K3 接受**消息级工具声明**（`messages[].tools`），可在会话中途用「无 `content` 字段的 system 消息」注入完整工具定义。官方把「保持顶层 `tools` 字节稳定」列为该特性的目的之一——中途修改/删除已发出的声明会使缓存从该点起失效，而在末尾追加不影响已缓存前缀，所以这是提升缓存命中的正道。声明按请求重发（服务端不保留），且仅在模型声明该能力时发送；
- 额度卡片区分 **5 小时 / 7 天 / 月度（会员共享池）/ 月度（Kimi Code 池）** 四个窗口并显示重置时间，另可显示加油包余额；设置页为「设置 → 订阅服务 → Kimi Code」标签页，对话输入框右侧有该线路的额度胶囊。

### MiniMax Code（编程订阅）线路

- 注册 `minimax-code` Provider，接入 **MiniMax Code 编程订阅**。它与 MiniMax 开放平台（按量计费的 API Key）是两套互不通用的系统：
  - 订阅的模型接口是 Anthropic Messages 协议（`https://agent.minimax.cn/mavis/api/v1/llm/v1/messages`）；
  - **只用 `authorization: Bearer <accessToken>` 认证**——实测 `x-api-key` 一律返回 401 `"{\"code\":401,\"message\":\"token is required\"}"`，因此本线路**没有** x-api-key 回退分支（回退只会在每次请求上白花一个往返）；
- **复用桌面端登录态，而不是让你再登录一次**：凭据就是 MiniMax Code 自己写的 `~/.minimax/auth/<buildEnv>/<region>/mcode-public/auth.json`。
  - **只读优先**：仍在有效期内（且距离到期还有 5 分钟以上）的令牌原样使用；
  - 进入续期窗口才轮换，并走**原子替换**（临时文件 + `rename`），失败或中断都让原文件保持逐字节不变；
  - **不创建、不删除、不等待** `auth.lock`（那是桌面端自己的刷新锁，第二方碰它就可能打断官方客户端的刷新）；
- **两种登录来源互不覆盖**：
  - 桌面端的 `auth.json` 归桌面端所有，本插件只读；若本机没有它，才在设置页用 **RFC 8628 设备码流程**（PKCE S256）登录，凭据存到本插件自己的 `$DSH_HOME/storages/minimax-code-credentials.json`；
  - **登出只作用于本插件自己那份凭据**：桌面端的登录态会被续期写回（只读优先），但**绝不撤销、绝不删除**，登出请求对它会被拒绝并说明原因（撤销它等于把你从正在跑的 MiniMax Code 里踢下线）；
- **区域是凭据属性**：`cn` 用 `account.minimax.cn` / `agent.minimax.cn`，`global` 用对应 `.io` 域名。两个区域的目录都会被探测，因此国际区账号不会因为没有国区文件而「未登录」；读回凭据时**以记录里存的区域为准**，而不是拿默认区域覆盖它；
- **模型目录是硬编码的，而且必须硬编码**（`src/host/minimax-code/model-catalog.ts`）：
  - 该端点的 `GET /v1/models` **未对订阅流量开放**（503 `"{\"errorCode\":50115,\"errorReason\":\"direct_route_not_configured\"}"`），所以任何「实时目录」都只会是一个必然失败的请求；
  - 四款模型：M2.7 / M2.7 HighSpeed / M3 取自本机 `~/.minimax/config.yaml` 的模型表；**M3.1 Flash 是 2026-10-19 换上的正式版 id**（`MiniMax-M3.1-Flash`，去掉了 `-Preview` 后缀），取自 MiniMax 自己的 Model Invocation 页 Supported Models 表并在该订阅端点上实测（正式 id、`output_config.effort` 的 low/max、内联图片）。无论哪一条，**都不从不存在的接口推断**；
- **思考形态按模型表三态实现，且一律走 `output_config`，不发 `thinking` 对象**（该字段从未被文档确认，发出去只是一种形状的猜测）：M2.7 系列**恒定开启且没有档位**（不发送任何字段）；M3 是**开关二态**（关闭时 `output_config.effort: 'none'`）；M3.1 Flash **强制开启并可指定档位**（`output_config.effort` 取 low/medium/high/xhigh/max，省略即 max）。未知或越档的取值一律回落到该模型目录声明的默认档，不会把模型没有声明的档位发出去；
- **视频已在能力声明里，并且真的能发出去**：M3 与 M3.1 Flash 的 `inputModalities` 都是 `['text', 'image', 'video']`（`model-catalog.ts`），线上形状取自实测——`{ type: 'video', source: { type: 'base64', … } }` 被该端点接受并解码（同一段实测也否掉了 data-URL 字符串那种封装，它会在 `:` 处按裸 base64 解码失败）。**能不能读到字节是宿主注入的接缝**：`AttachmentVideoReader`（`adapter.ts:372`，类型在 `src/host/common/video-request.ts`）由宿主提供，DSH 自己的附件服务只存图片，所以视频只能来自本部署里某个真实的生产者；宿主不提供读取器、或某一条读不出来时，`resolveRequestVideos` 把它解析成 `unavailable`，映射器（`mapper.ts:416`）才退化成一段说明文本——`modalities.ts` 的 `videoOmissionText` 按 4 种 reason 给出各自不同的措辞（`unsupported-model` / `unsupported-container` / `unreadable` / `unsupported-wire`），让模型知道「有这段视频、为什么没带上」，而不是对着空白回答。**降级发生在单个片段上，不发生在声明上**：声明的依据是接缝存在且线上形状实测可用，不是「任何情况下都一定能读到」；
- **失败按 8 级判决分类，判词决定重试与号池动作**（`classifyMinimaxFailure`，`adapter.ts:388-470`；读的是**原始正文**而不是 `summarizeFailureBody` 抽出的那一个字段，因为同一个判词在两种信封里放的位置不同）：
  - **上下文超限**——`isHttpContextOverflow` 先判，`CONTEXT_OVERFLOW_CODE`，终局、不归账号；
  - **账号级额度耗尽**——**`403` 或 `429`** 都可能落到这一类，判据是正文**点名了一个用尽的窗口**，与状态码无关：`isSpentWindow403`（`adapter.ts:355`）管 403，`429` 分支（`adapter.ts:425-431`）用同一个谓词问同一个问题，两条都返回**同一个** `quotaExhaustedFailure`（`adapter.ts:368`：`PROVIDER_ERROR` / `retryable: false` / `accountScoped: true`）。**判据本身是两个臂**（先问上游用量限额的**数字码**、再问**措辞表**兜底；这个先后只是求值顺序，不代表这条路由上真正会开火的是前者）：`namesUsageLimitStatusCode`（`adapter.ts:311`）读两种信封里的上游码（平台信封 `base_resp.status_code`、客户端信封 `errorCode`，并额外往流内错误体 `{ error: … }` 里多读一层），命中 `USAGE_LIMIT_UPSTREAM_STATUS_CODES = {2056, 2067}` 即算；非 JSON 或没有该字段的正文回落到措辞表 `QUOTA_EXHAUSTED_PATTERNS`。两个臂汇进同一个判决 `namesSpentWindow = namesUsageLimitStatusCode || 措辞表`（`adapter.ts:334`）——它们不是两套规则，而是同一个问题的两种承载方式：一句中文没有码，一个裸码没有句子。**但要把定位说准**：数字码臂在这条 Messages 路由上目前**不会开火**，它是**跨信封的前向兼容臂**（哪天服务真的在 Messages 路由上带出 `2056`/`2067`/`errorCode`，它就会生效），**不是这条路由当前的主要判据**。2026-10-20 的活体探针（`scripts/probe-minimax-capabilities.probe.ts`，原始证据 `docs/minimax-code-probe-capabilities.md`）把这条路由的错误信封量了个遍：端点上只有**两种**信封，**没有一种带 `base_resp`**——① 请求被拒 `400` 是 `{"type":"error","error":{"type":"invalid_request_error","message":"…"}}`（参数类错误上多一个 `request_id`），**没有任何数字字段**；② 认证被拒 `401` 是 `{"code":401,"message":"auth failed"}`，**顶层 `code` 是这条路由唯一的数字字段**。`base_resp.status_code` 那个信封属于这条线路的**别的**路由（配额 `coding_plan/remains`、Files API、`reset-card`），不属于 Messages。连探针抓到的 `2013` 也**不是字段**：它只以文本形式嵌在 `error.message` 的括号里（`… does not support max tokens > 524288 (2013)`），而且是**通用「参数非法」码**——超限的 `max_tokens`、空 body、畸形 JSON 全都归它；本仓库在 `reset-card` 与 Files API 上另有语义，**绝不拿它当额度判决**。所以在 Messages 路由上**当前真正 operative 的那一条是措辞表**：数字码臂留在这里，是为了不让一个将来可能带上数字码的信封被当成措辞去猜，而不是因为这条路由现在会给码。它必须排在下面的凭据分支**之前**，因为 `401`/`403` 的正文在这条线上是同一句 `token is required`，光看状态码分不出「窗口用尽」与「凭据被拒」。号池据此冷却到窗口重置（未命中周窗口词冷却 5 小时，命中 `WEEKLY_QUOTA_WINDOW_PATTERN` 冷却 7 天，见 `adapter.ts:172-184`），且**刻意不采信 Retry-After**——等 N 秒不会让一个用尽的窗口重新可用；
  - **凭据失效**——`401`/`403` 里不属于上面的，`INVALID_CREDENTIAL`，终局且归账号，但走 `markAuthFailed` 而不是 `markCooldown`；这条线的 401 正文在「没发凭据」和「凭据被拒」两种情况下是同一句 `token is required`，所以提示直接指向重新登录；
  - **纯背压 429**——**没有**点名用尽窗口的 429（数字码与措辞两个臂都没命中），`RATE_LIMIT`，**可重试**且**不归账号**（同一套餐后面的每个账号都会被同样拒绝，冷却它只会把号池抽干）；
  - **5xx**——`SERVER`，可重试、不归账号；
  - **400**——`PROVIDER_ERROR`，终局：请求本身不被接受，重发一次也不会被接受；
  - **其他状态码**——`PROVIDER_ERROR`，终局，正文为空时提示「无响应」；
  - **401 另有一次性补救**（合并下方一条）：第一次 401 会**强制续期一次并原样重试同一个请求体**，重试再被拒才是终局；
  - 可重试的四类（`RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT`）走 DSH retry policy 的有界退避：最多 3 次，1.5s 起步、15s 上限、0.2 抖动；**终局类不重试**——重试只会推迟用户真正需要看到的那句提示；
- **401 会强制续期一次再重试**：本地时钟看着还有效、服务端却拒收的令牌（在桌面端被撤销、时钟偏移、桌面端已轮换）与「真的需要重新登录」在状态码上无法区分，所以第一次 401 会**强制刷新一次并原样重试同一个请求体**；重试再被拒才是终局；
- **刷新令牌是单次使用的，因此续期提前 5 分钟、并全进程共用一次轮换**：
  - 这是「每小时自己掉线、然后要求重新登录」的根因。access token 实测只有 **1 小时**，而原先的续期阈值是「到期前 60 秒」——等于每次都在令牌已经会被拒收的那一瞬间才去轮换；
  - 并发请求（状态卡轮询、签到、用量读取、模型请求）会各自拿同一枚刷新令牌去换，除第一个之外全部拿到 `invalid_grant`，而这条终局判定会被记成「该账号需要重新登录」并写进号池（重启也在）；
  - 现在：① 续期窗口 `PRE_EXPIRY_REFRESH_MS` 为 5 分钟，轮换发生在服务端还没有拒收之前；② 同一份凭证的轮换**按身份（`recordKey` / `loginEpoch`）单飞**，后到的调用者要么加入在途轮换、要么采纳结果，绝不二次花费同一枚令牌；
  - ③ 轮换**先看 storage 再相信终局判定**——磁盘上的凭证若已前进（别人刚成功轮换，或桌面端自己刷新过），直接采纳，**不记 tombstone、不报「重新登录」**；
  - ④ 号池行上遗留的过期标记会在下次读取或请求时**自动核对并清除**；⑤ 卡片补上了「重新登录」按钮（`onRelogin` 此前未接线）；⑥ 响应未返回新 refresh token 时沿用旧值，不再当作失败；
- **请求体上限是本线路自己的 64 MB，不是 Kimi 线路的 2 MB**（本条为修复项，详见 CHANGELOG）：
  - **原缺陷**：守卫直接复用了 Kimi 线路的 `MAX_MESSAGE_BODY_BYTES`（2,097,152），理由写着「两条线路上游都是同一族端点」。**2,097,152 与 `total message size N exceeds limit 2097152` 是 Kimi Code 自己文档里的网关上限**（见其错误参考），MiniMax 没有任何文档这样规定；
  - **代价**：真实会话在 2,098,045 字节时被**本地拒绝**——请求根本没发出去，这一轮就失败了。该数字离 2,097,152 只差 893 字节，而**超过 2 MB 本身不代表这个路由发不出去**；
  - **更自相矛盾的地方**：本线路的模型目录给 M3 标了 **512K 上下文（可选 1M）**、单张图片 **10 MB**——一个 2 MB 的整包上限与「单图 10 MB」根本不能共存，一张合法图片就能单独触发它；
  - **现在**：上限改为本线路自己的 `DEFAULT_MAX_MESSAGE_BODY_BYTES`（64 MB，MiniMax 对带媒体请求自己公布的请求体量级），普通会话**永远不会被本地拒绝**，守卫只拦真正的失控请求（如每轮追加数 MB 工具结果的死循环），且仍在花掉连接之前拦下并给出同样的可操作提示；
  - 确有实测上限的部署（前置代理/网关）可设 `DSH_MINIMAX_CODE_MAX_BODY_BYTES` 指定；取值非正整数时**回落到默认值而不是关闭守卫**；
  - **同一个错误在图片预算上又犯了一次，而且更隐蔽**（已一并修复）：本线路调用的是 Kimi 的 `offloadOldestRequestImages`，其预算是 Kimi 的 **1,500,000**——那是为塞进 Kimi 自己的 2 MB 请求体上限而定的数字。MiniMax 的模型表允许**单图 10 MB 原始字节**（base64 约 13.3 MB），超出近 9 倍，于是**一张普通截图就被换成占位文本**；
    - **比拒绝更糟**：omit 是**静默替换**——没有报错、没有计数，模型是在一个「图根本不存在」的对话上作答的，而现场没有任何线索指向原因。现在预算是本线路自己的 `DEFAULT_MAX_REQUEST_IMAGE_BYTES`（16 MB，装得下模型 10 MB 单图上限并留出余量，且远在 64 MB 请求体上限之内），可用 `DSH_MINIMAX_CODE_MAX_IMAGE_BYTES` 覆盖；
    - **改法**：共享的是**机制**（度量、按最旧优先丢弃、不动持久历史），不是**数字**。`offloadOldestRequestImages(options, maxBytes)` 现把预算变成参数，缺省仍是 Kimi 的值，其余线路行为**逐字节不变**；
  - **守卫的形状仍与 Kimi 共用，数字不共用**——字节上限是上游网关的属性，不是什么通用常量；
- **额度面板有两套用量端点，第一轮打错了那一套**：
  - **平台端点** `/v1/token_plan/remains`（`api.minimax.cn` / `api.minimaxi.com` / `api.minimax.io`）**只接受平台 API 密钥**：`mcode-public` 登录态在四种认证写法（`Bearer` / 原始 / `x-api-key` / 两者都带）下全部被拒，且是 **HTTP 200 + `base_resp.status_code: 1004`**——不是 401，很容易被误读为成功；
  - 官方 `mmx` CLI 能用该端点，是因为它的 OAuth 是**平台**登录，与本线路的 mcode 登录是两套身份；
  - **mcode 自己的端点在官方客户端源码里**（`packages/tui/src/account/matrix-account-client.ts`）：`GET https://agent.minimaxi.com/v1/api/openplatform/coding_plan/remains`（国际 `agent.minimax.io`），路径与平台端点**完全不同**。本插件用的就是这条（本线路的 `agent.minimax.cn` 优先、官方主机兜底）；
  - ⚠️ **但它带 `yy` / `x-timestamp` / `x-signature` / `User-Agent: MiniMaxCode` 四个「官方客户端标识头」**——官方注释自己写明这些是「把请求标记为来自 MiniMax 第一方客户端」的字面量；
  - 本插件 `types.ts` 已明确决定**不伪造官方客户端身份**（伪造既失信，也可能是封号理由），因此**默认不发**，宁可拿到一个拒绝让卡片如实说明；
  - 确实要数字的用户可设 `DSH_MINIMAX_CODE_QUOTA_ATTRIBUTION=1` 显式选择该取舍；
- **用量端点不在 MiniMax 的 API 文档里**（文档只说「用量显示在控制台的用量条上」，这大概就是最初判定「没有端点」的原因），它来自官方 CLI——`mmx quota show`。返回的每个 `model_remains` 行带**两个窗口**（5 小时滚动 + 每周），卡片因此有两根条，各自显示重置时刻与「已用/总量」；
- **三个必须照抄官方实现的解析细节**：
  - ① **`*_usage_count` 的语义是模糊的**（老响应是「剩余」、新响应是「已用」），官方用显式百分比消歧——照抄，否则进度条会**反过来**；
  - ② **周窗口带显示倍率**（返回的是百分比 × `weekly_boost_permille`，可超过 100%）；
  - ③ `status: 3` 通常表示「不限量」，但**两个总量都为 0 时**它表示「当前套餐不含该模型」——渲染成不限量会凭空许诺额度；
- **三处降噪防护**：① `base_resp` 非 0 视为凭据被拒，**只试一台就停**并记住 30 分钟；② 其它失败按 `unreachable` 区分、记住 10 分钟；③ `/status` **只读缓存、绝不在轮询里发网络请求**；
- **读用量永远不影响对话**：独立只读路径，失败只让卡片换一句话；
- **设置面与其余各线路逐项对齐**（该 PR 最初缺失这一整块，用户明确指出）：
  - ① **「启用此供应商」总开关**——关闭后适配器**不暴露任何模型**（包括已勾选的），因为「关掉」如果还能用就等于没关；
  - ② **模型勾选**——只有勾选的模型进入对话页的模型选择列表，另有「全选 / 全不选」；
  - ③ **模型上下文窗口覆盖**——每个已勾选模型可填自定义容量（接受 `1M` / `512K` / `200000`），「恢复默认」以 `null` 语义在 host 侧**删除**该键而不是写入 0；
  - ④ **默认思考深度**——全局档位只在模型确实列了该档时生效，否则回落到该模型自己的默认档（广告一个模型会拒绝的档位只会让服务端拒掉请求），且「关闭思考」只对**可关闭**的模型生效；
  - ⑤ **号池管理**（见下条）；
- 目录仍然硬编码，但「这一安装当前怎么用它」是用户设置：**两者分开存储**（目录随代码发布、设置随用户数据保存），因此一份用户数据不会看起来像一条已发布的目录项；
- **号池与多账号登录**：复用与其它线路**同一个**号池内核（`src/host/common/account-pool.ts`）与**同一张**共享账号卡片，具备顺序耗尽 / 轮询 / 粘性调度、429 冷却换号、设为主账号与备注。**身份键不是令牌**：桌面端凭据用它自己的 `recordKey`（同一个记录槽每次轮换都是同一账号，因此在池里原地更新），插件自持凭据用 `loginEpoch`（每次设备码登录就是一次独立会话）——用刷新令牌做键在每次轮换后都会把同一账号看成新账号；
- **桌面端登录态可被显式「导入」为号池账号**（`POST /accounts {action:'adopt'}`）：只读取、只新增一行，不改动官方客户端的任何文件；重复导入按记录槽身份原地更新，不会产生重复账号。**在设置页新发起的设备码登录会自动加入号池**（`pollWebLogin` 的 `onSave` 钩子）——没有这个钩子，新登录只会写进镜像文件而号池看不见，这正是「多账号登录没配好」的根因；该钩子的失败**不会**让登录失败，因为凭据此时已经落盘。

### Claude（订阅）线路

- 注册 `claude-subscription` Provider，以 **Claude Pro / Max 订阅的 OAuth 登录态**访问 Claude 模型（Anthropic Messages 接口），**不使用 API Key、也不按量计费**；
- ⚠️ **风险须知（插件不设确认步骤，但事实不变）**：Anthropic 现行条款明确写明**不允许第三方应用提供 Claude.ai 登录、也不允许代用户经 Free / Pro / Max 凭据转发请求**，并保留不经预告的执法权；已有开源项目被下架、有账号因此被限制。**本插件未获 Anthropic 任何授权或认可**，使用风险由使用者自行承担。此前版本在卡片上设有确认步骤与配套主机门禁，两者均已移除；移除的只是那一步交互，**不改变上述事实**；
- **这不是抄一个 token 就能用**：订阅令牌要求请求**完整模仿 Claude Code 的身份**，否则会被服务端拒绝或分类判别。这些都在代码里显式实现并有测试锁定：
  - `Authorization: Bearer` 且 **`x-api-key` 必须缺省**；
  - `user-agent: claude-cli/<版本>`、`x-app: cli`；
  - `anthropic-beta` 至少含 `oauth-2025-04-20` 与 `claude-code-20250219`；
  - `system` 的**首个块必须是 Claude Code 身份声明**；
- **OAuth 用 PKCE，且 state 与 verifier 独立生成**。这一点特意**不照抄参照实现**：本机参照实现把 PKCE verifier 直接当作 OAuth `state`（`state: verifier`），那会把本应保密的 verifier 写进授权 URL、地址栏、浏览器历史乃至剪贴板。本线路是两次独立随机抽样，并有测试断言授权 URL 中**不出现原始 verifier**；
- **两条登录路径，模式在流程开始时确定且不可中途切换**：默认是**手动粘贴**（授权页把码显示在屏幕上，粘贴 `<code>#<state>`；也容错接受整条重定向 URL）。可选 loopback 回调，绑定 `127.0.0.1` 并顺序探测可用端口（Windows 的保留端口段会让固定端口绑定失败）。端口探测失败**降级为手动**而不是报错。切换模式等于作废当前流程并重新发起——授权码与签发它的那次请求的 `redirect_uri` 绑定，这是该流程最常见的失败；
- **一次授权只兑换一次**：浏览器回调与手动粘贴可能同时到达，用 compare-and-set 保证只有一方发起兑换（另一方得到「正在处理中」，已结算的流程得到 410 且**不做任何兑换**）。错误的 `state` **只拒绝那一个请求**，不会终止正在进行的合法登录。回调服务器只绑 loopback、只应答 `/callback`、只接受本机来源；
- **刷新是单飞的**：并发请求共享同一次刷新。否则到期瞬间的一批请求会各自轮换刷新令牌，除第一个之外全部作废（上游会给出终局判定）。刷新令牌轮换后**先读回校验再落盘**；
- **模型能力逐模型查表**（`src/host/claude/model-catalog.ts`），**不从模型名推断**。该表转录自本机随 harness 安装的参照目录，**只证明抄录忠实，不证明服务端提供这些模型**——服务端自己的 `GET /v1/models` 才是权威，且它**只覆盖上下文窗口**，能力字段不被改写；
- **思考形态有四类，顺序决定成败**（`thinkingMode`）：
  - `mid-convo` → `{type:'adaptive', block_binding:{prefix_mismatch_behavior:'drop_block'}}` 外加 `output_config.effort`；
  - `adaptive` → `{type:'adaptive'}`；
  - `budget` → `{type:'enabled', budget_tokens}`（预算算术按参照实现转录；思考预算计入 `max_tokens`，**必须为回答留出至少 1024 token**）；
  - `none` → 不发思考字段；
  - **`mid-convo` 排在最前且无条件**：`claude-fable-5-1` 与 `claude-opus-5` 同时带 `forceAdaptiveThinking`，把它们当成普通 `adaptive` 会**静默丢掉 `block_binding` 与 `output_config`**，而参照实现自己的注释写明该缺失会导致**持续 400**；
  - 反过来，**`block_binding` 本身必须由 `anthropic-beta: thinking-binding-controls-2026-08-01` 授权**（官方文档：缺该 beta 时返回 400 `block_binding: Extra inputs are not permitted`）。因此请求头从**已构建的请求体**读出是否带 `block_binding`，带则追加该 beta；
- **思考块带签名则原样回放**（这是思考模式下多轮工具调用的前提；`redacted_thinking` 同样回放），**无签名则丢弃**。工具名在出站时按 Claude Code 规范大小写归一化、入站时按大小写无关匹配回用户工具名；若两个工具归一化后碰撞，则**放弃归一化**原样发送，避免把结果投给错误的工具；
- **多账号号池，与其它线路同源**：复用与其它线路**同一个**号池内核（`src/host/common/account-pool.ts`）与**同一张**共享账号卡片，具备顺序耗尽 / 轮询 / 粘性调度、429 冷却换号、设为主账号与备注；
  - **身份键不是令牌**：桌面端凭据用它自己的 `recordKey`（同一个记录槽每次轮换都是同一账号，因此在池里原地更新），插件自持凭据用 `loginEpoch`（每次设备码登录就是一次独立会话）——用刷新令牌做键在每次轮换后都会把同一账号看成新账号；
- **可选择性收编本机已有的 Claude Code 登录（默认关闭）**：开启前只做一次「文件是否存在」的探测，**不读取内容**；只有你显式开启后才读取。收编得到的是一份**快照**，**永不由本插件刷新**——Claude Code 刷新的是同一枚轮换令牌，两个进程各自刷新会互相作废，而进程内的单飞解决不了跨进程竞态。快照过期后卡片会提示你**回 Claude Code 重新登录后再收编**，并且**绝不会写入或删除 Claude Code 的任何文件**；
- **额度面有两个来源、两套单位**，换算后有交叉测试证明它们描述同一状态：
  - 主来源 `GET /api/oauth/usage` 的 `utilization` 是**已用百分比 0–100**；
  - 而 `/v1/messages` 响应头 `anthropic-ratelimit-unified-5h-utilization` 是**分数 0–1**，重置时间是 **epoch 秒**；
  - 有真实流量时以响应头为准以降低查询频率，但卡片仍会按 `QUOTA_FULL_REFRESH_MS` 做一次完整读取；
- **提示缓存时长可选择**（设置页）：本线路用订阅凭据，而 [Claude Code 官方文档](https://code.claude.com/docs/en/prompt-caching) 写明**订阅用户在套餐额度内对主对话使用 1 小时 TTL**（超出额度改按用量计费后官方会降回 5 分钟）。此前固定使用 5 分钟默认值，与官方客户端行为不一致——同样的用量，官方用户享受 4 倍缓存窗口而本插件没有；
  - 1 小时是**需要许可的能力**：body 里写 `ttl: '1h'` 必须同时带 `anthropic-beta: extended-cache-ttl-2025-04-11`，否则被拒（与 `block_binding` 同理）。插件从**已构建的请求体**读出所选档位并据此发出该 beta，两者不可能不一致；
  - 写入 1 小时档价格更高，短会话不划算，因此设置项可覆盖为「跟随官方 / 1 小时 / 5 分钟」；
- **换号的两条硬约束**：只在**凭据失败**或**账号级限流**时换号——全局限流、过载与 5xx **绝不换号**（其它账号共享同一全局限制）。**一旦已有输出产出就绝不换号**（否则会重复文本或重复工具调用），改为直接报错。换号最多 3 次；
- 模型勾选、思考深度、上下文窗口覆盖与额度在「设置 → 订阅服务 → Claude」标签页中配置，输入框右侧另有额度胶囊（取**剩余最紧的那个窗口**）。

### 设置页
- 展示账号（脱敏 email、套餐、账号 ID 后四位）、连接状态、额度与订阅增强功能开关；「输出详细程度」「推理摘要」两项的默认值即官方 Codex 客户端的取值；
- **偏好落盘位置随 harness 生成**：
  - 有 `settings.register` 的一代（≤0.1.6）仍写进 harness 的设置文档；
  - 0.1.7 起该 API 被 `SettingsForms` 取代，偏好改由插件自己持久化到 `<dshHome>/storages/dsh-chatgpt-subscription-preferences.json`（0600、原子写；读取失败或校验不过就回落默认值）；
  - **首次运行会从旧设置文档里本插件的段一次性迁移**；五条线路的模型开关同样从各自既有的 `storages/*-models.json` 水合，因此重启后不会像被重置；
- 子代理的模型与思考深度沿用 DSH 自身设置：**设置 → Subagent** 卡片授权 Agent 可以为子代理挑选的模型（来自 DSH 已接入的全部 Provider，包含本插件的 Codex / Antigravity），新 Agent 的默认路由由 DSH 的 `agent-default-model` 设置提供；
- 最大嵌套深度不在本插件设置内，由 DSH 侧决定：0.1.5 及以前是 preset 中 `tool-subagent` 行的 `maxDepth`（默认 3），0.1.6 起改由 `subagent` 服务的设置项提供（默认 1）；`provider-managed` 表示把预算交给进程外提供方；
- GPT-6 系列（6 Astra / 6 Sol / 6 Luna）默认使用 384K 有效上下文，可配置最高 872K；5.6 Sol / Terra / Luna 保持 272K，最高 1M，用于 DSH 压缩与溢出判断；其他模型保持目录声明值；
- 单次输出上限按模型区分：GPT-6 系列为 128K（官方对 6 Astra / 6 Sol / 6 Luna 均标 128K），更早的模型保持 32768。**这个数字只在本插件进程内使用，不会写进请求**：订阅版 Responses 端点会以 `400 Unsupported parameter: max_output_tokens` 拒收该参数（[#29](https://github.com/Aa728848/dsh-chatgpt-subscription/issues/29)），官方 Codex CLI 的 `ResponsesApiRequest` 里同样没有这个字段。它的实际用途是作为 DSH 侧的输出预留量（`defaultMaxTokens`），供压缩判定把完成部分计入上下文窗口；请求本身交给服务端决定长度。撞上服务端上限时该轮仍以 `max-tokens` 结束原因呈现（后端以 `response.incomplete` 收尾）。
- 可访问的进度条、窄窗口/200% 缩放布局、深浅主题与 reduced-motion。

## 模型目录

| 显示名 | 模型 slug |
| --- | --- |
| 6.1 Sol | `gpt-6.1-sol` |
| 6 Astra | `gpt-6-astra` |
| 6 Sol | `gpt-6-sol` |
| 6 Luna | `gpt-6-luna` |
| 5.6 Sol | `gpt-5.6-sol` |
| 5.6 Terra | `gpt-5.6-terra` |
| 5.6 Luna | `gpt-5.6-luna` |
| 5.5 | `gpt-5.5` |
| 5.4 | `gpt-5.4` |
| 5.4 Mini | `gpt-5.4-mini` |
| 5.3 Codex Spark | `gpt-5.3-codex-spark` |

> 目录只用于展示；账号实际可用的模型由 ChatGPT 套餐、workspace 策略与上游兼容状态决定。

GPT-6 系列（6.1 Sol / 6 Astra / 6 Sol / 6 Luna）支持文本、图片输入和工具调用，默认思考档位为 `medium`，可选 `low`、`medium`、`high`、`xhigh`、`max`。从旧会话带入的 `none` / `minimal` 会按 [OpenAI 官方迁移说明](https://developers.openai.com/api/docs/guides/latest-model) 转为 `low`。三个模型的默认 384K 与上限 872K 均取自 2026-09-23 的 Codex 模型目录（`gpt-6-sol` / `gpt-6-luna` 于 2026-09-22 发布，能力与 `gpt-6-astra` 一致；目录里的 `context_window` 是 272K，本插件把默认有效上下文提高到 384K，仍低于 872K 上限）；[Codex Ultra](https://learn.chatgpt.com/zh-Hans/docs/models) 涉及客户端的子代理编排，本插件不将它作为 Responses 思考参数暴露。

新配置默认显示 GPT-6 系列与 GPT-5.6 系列；已有配置保留原来的模型勾选，可在 **设置 → Codex 订阅 → 可用模型** 中勾选 **6 Sol** / **6 Luna**。

## 环境要求

- Windows 或 Linux；
  - Windows：系统需提供 Windows PowerShell，以使用 CurrentUser DPAPI；
  - Linux：Host 用户必须拥有可写的 `~/.dsh`（或 `$DSH_HOME`），凭据文件会强制使用 `0600`、目录使用 `0700`；
- 已安装 DSH：peer 范围覆盖 **0.1.2-alpha.5 及以后的每一代**，一直到 0.2.0-rc.2。构建与测试以 **0.2.0-rc.2** 为基线，旧版行为由版本兼容层保留，因此**同一份代码**可装在 0.1.2-alpha.5 以来的所有代上（用户分散在 npm 的 `latest` / `next` / `alpha` 三个标签上，多数人跑的是比 `alpha` 落后几个版本的 `latest`）。需要桥接的破坏性变更：
  - **0.1.7** 重写了会话消息模型（工具结果由 `tool-result` 内容块改为 `role: "tool"` 消息）、删除了 `settings.register`（偏好改由插件自有存储落盘）、并让 agent preset 不再从 `~/.dsh/.agent-presets` 读取。插件在请求边界、设置服务与 preset 注册三处同时适配。
  - **0.1.6** 把 workflow 引擎改了包名，插件在 preset 同步时按当前安装自动适配（见「随包分发的 Agent Preset」）。
  - 0.1.1-rc.2 不再声明支持——它既没有 preset 用到的 `present` 工具，`mode` 枚举那时也还写作 `code`。
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

**版本阶段**：上面两条命令装到的是 npm `latest` 标签指向的版本（撰写时为 **0.10.12**）。包不预置 `publishConfig.tag`，因此稳定版一发布就落在 `latest`——也就是 `npm install` 与 `dsh plugin add` 解析到的那个标签；预发布版只进 `alpha`，需要显式带上标签或版本号：

```sh
dsh plugin --profile web add @eddyskywalker/dsh-chatgpt-subscription@alpha
npm install @eddyskywalker/dsh-chatgpt-subscription@alpha
```

### 方式 2：在 DSH 界面里安装

DSH 没有插件市场；Web 界面的 **Plugins** 页提供按包名安装的入口（底层与 `dsh plugin add` 相同）：

1. 打开侧栏的 **Plugins** 页；
2. 在添加插件的输入框里填 `@eddyskywalker/dsh-chatgpt-subscription` 并安装；
3. 重启 `dsh web`。

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

DSH 模型选择器应显示 **“Codex（ChatGPT 订阅）”**。GPT-6 系列与 GPT-5.6 系列的有效上下文窗口在“Codex 订阅 → 增强功能”中配置。子代理的模型与思考深度由 DSH 自身的设置决定（Subagent 卡片授权的模型清单，以及 `agent-default-model` 的默认路由；该卡片 0.1.5 及以前在「设置」页，0.1.6 起在 **Plugins** 页）；最大嵌套深度由 DSH 侧决定（0.1.5 及以前取 preset 中 `tool-subagent` 的 `maxDepth`，默认 3；0.1.6 起取 `subagent` 服务的设置，默认 1）。

**设置 → Codex 订阅 → 网络代理** 是本插件**全部供应线路共用**的一份代理设置（ChatGPT、Claude、Antigravity、Kimi Code、MiniMax Code、Command Code、Ollama、GLM Coding Plan、Step、Cline Pass、Qoder、OpenDesign），可选择系统代理（自动检测）、自定义代理或直连。各线路的模型生成、登录与令牌交换/续期、账号信息、项目发现、配额与模型目录查询，以及插件自带的工具与网页抓取，都使用此设置；修改后对后续请求生效，无需重启 DSH。

系统代理自动检测按平台分流：Windows 读注册表（同一份输出里的 `ProxyEnable`/`ProxyServer`）、macOS 读 `scutil --proxy`、Linux 读 GNOME 的 `gsettings`（`org.gnome.system.proxy` 的 mode/host/port；PAC 模式不支持，因为代理只能经代理端口转发，无法施用自动代理脚本）；都拿不到时回落到 `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` 环境变量与 `$DSH_HOME/.env`。

代理生效时，**回环地址**（整个 `127.0.0.0/8`、`::1`、`localhost`）与 **`NO_PROXY` / `no_proxy` 列表**里的主机仍然直连——把某条线路的 baseURL 指向本机网关（例如 `http://127.0.0.1:9090`）时不会被塞进代理。`NO_PROXY` 与代理同源读取（进程环境变量优先，其次 `$DSH_HOME/.env`），支持 `*`、域名后缀（`example.com` 与 `.example.com` 都匹配子域）以及 `host:port`；不支持 CIDR。浏览器中的授权页面使用浏览器自己的网络设置。

已经用官方 Codex CLI 登录过的用户可以跳过第 3 步的 OAuth：**设置 → 订阅服务 → ChatGPT**，在账号池卡片里点「登录」**旁边**的「导入本机 Codex CLI 登录」即可（见「本机登录」）。

### Command Code

1. 重启 `dsh web`；
2. 打开 **设置 → Command Code**；
3. 点击 **浏览器登录**（或把 Command Code Studio 里创建的 API Key 粘到「手动填写 API Key」里保存）；
4. 登录完成后按需勾选模型、设置上下文窗口与默认思考深度。

`command-code` 会像其他 Provider 一样出现在 DSH 模型选择器中。线路按模型 id 自动选择：`claude-*` 走 Anthropic Messages，其余走 OpenAI Chat Completions；设置卡片的模型标签会显示每个模型对应的线路。

**路由归属**：DSH 的 `registerAdapter` 对重复 Provider 是 all-or-nothing 并抛 `DUPLICATE_ADAPTER`，因此若 `command-code` 已被别的适配器占用（典型情况是内置 `llm-pi-ai` 用同一端点声明过同名 Provider），本插件不会加载失败，而是在卡片上显示“模型路由已被其他 Provider 占用”；从占用方的配置里移除该 Provider 后，插件会在下一次路由变更事件时自动接管，无需重启 DSH。

**上下文窗口**默认取 Command Code 模型目录的 `context_length`，可在卡片中逐模型覆盖（用于 DSH 的压缩与溢出判断，支持 `1M` / `512K` / `200000` 等写法）。**默认思考深度**逐模型生效：下拉里列出的档位可按模型能力选用（`minimal` / `low` / `medium` / `high` / `xhigh` / `max`），实际发给上游前会按当前模型声明的档位取值——模型不声明该档位时不发送。对 Anthropic 线路映射为 `thinking` 预算（`minimal` 1K / `low` 2K / `medium` 8K / `high` 16K / `xhigh` 24K / `max` 32K），预算放不下时该请求不启用 thinking；对 OpenAI 线路映射为 `reasoning_effort`。

**额度**来自 `/alpha/billing/credits`、`/alpha/billing/subscriptions` 与 `/alpha/usage/summary`，三条线路相互独立容错，页面可见时最多每 60 秒刷新一次；解析不出有界额度时显示空态而不是 0%。

额度卡片展示：**套餐名**（由订阅返回的机器 id 查表得出，表在 `src/host/command-code/plans.ts`，按最长前缀匹配）、**订阅状态与续费日期**、**滚动窗口用量**（`windowLimits` 的 `fiveHour` / `weekly`，按官方 CLI 同款标签 `5-hour` / `Weekly` 显示，并各自带重置倒计时），以及**余额明细**（月度额度 / 已购额度 / 赠送额度，另附合计）。服务只回报数字不回报名称的字段一律补上可读标签——窗口按 key 命名，余额按池命名，实在没有名字的兜底为 `Extra allowance` 并注明来源，不会渲染成 `meter-1` 这类无意义编号。

**搜索来源** 切换 DSH 的**搜索**后端；网页**抓取**来源由下面的**抓取模式**决定。模式为 `auto`（默认）时跟随此处的搜索选择：选择 ChatGPT 来源后，网页也改由本插件在 Host 抓取，并使用上述网络代理设置；模式为 `dsh` 时即使选了 ChatGPT 搜索，抓取也仍由 DSH 原有来源完成。纯 TUN 模式可使用直连，流量由虚拟网卡接管。来源切换即时生效，DSH web 服务重载后会重新注册插件后端，并保留切回 DSH 默认来源所需的配置。设置页在该选择器下方**只读**展示 Host 上报的抓取来源、切换器状态、抓取模式与插件上限；Host 未提供这些字段（较旧的 Host）时整个区块不显示。

**网页抓取后端（web_fetch）** DSH 内置抓取 provider 会先解析域名、校验并固定解析结果，而且只在进程环境变量里读到代理时才走代理——系统代理对它不可见。代理工具（Clash/Mihomo 等）常把域名解析成自己的 fake-ip 地址（默认 `198.18.0.0/15`），于是内置 provider 直接以 `WEB_BLOCKED_URL`（resolves to a non-public IP address）拒绝，代理根本没被用上。因此在 `auto` 模式下，只要插件配置了可用代理（**网络代理** 选系统代理且检测到，或填写自定义代理），`web_fetch` 就改用本插件的 provider：由代理解析源站，与 DSH 对“走代理的请求”采用的语义一致；未配置代理时仍由 DSH 内置 provider 抓取，保留其解析与固定策略。若在纯 TUN 模式下把代理设为**直连**，内置 provider 会重新接管（`auto` 模式下），此时可改回系统代理让插件接管抓取。代理如果在 DSH 启动之后才可用（代理工具后启动，或首次探测失败），插件会在下一次探测到代理时重新选择抓取后端，不必重启或改设置。

#### 抓取模式与上限（插件 Config）

抓取**模式**与**上限**属于插件部署配置，不在设置页的偏好里：设置页只读展示当前值，要改写在 profile 的 `cordis.patch.yml` 里，**重载插件或重启 DSH 后生效**。

写在**安装时已有的那一条插件行**上（`id: dsh-chatgpt-subscription`，包名 `@eddyskywalker/dsh-chatgpt-subscription`）的 `config` 片段：

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- id: dsh-chatgpt-subscription
  config:
    fetchProvider: auto              # auto | plugin | dsh
    fetchMaxBodyChars: 100000        # 解码后正文保留的字符数
    fetchMaxResponseBytes: 2097152   # 响应体保留的字节数（2 MiB）
```

> patch 按 id 定位条目并**整体替换**它的 `config`，所以在这一行上追加字段时请保留原有的其它字段。

| 字段 | 默认 | 含义 |
|---|---|---|
| `fetchProvider` | `auto` | `auto` 跟随搜索来源（有可用代理或选了 Codex 搜索时用插件抓取）；`plugin` 始终用本插件抓取；`dsh` **强制保留 DSH 原有的抓取来源**，即使有代理或选了 Codex 搜索也不接管 |
| `fetchMaxBodyChars` | `100000` | 解码后交给工具的正文上限（字符） |
| `fetchMaxResponseBytes` | `2097152` | 进入解码前的响应体上限（字节） |

两者都必须是**正安全整数**，否则该配置不被接受（DSH 不会把非法值当成 0 使用）。

必须说清的四条边界：

- **`fetchMaxResponseBytes` 是“读进来之后再截断”，不是下载量或内存的硬上限。** 实现仍是 `response.arrayBuffer()` 先把整个响应体读进内存，超出部分才被切掉；调小它省不下下载流量和峰值内存，只能限制进入解码与工具结果的内容量。
- **工具层另有上限。** 这两个数字只管本插件 provider 交给 `web_fetch` 的内容，DSH 工具结果本身还有自己的裁剪预算，因此**调大它们并不保证取回完整页面**。
- **两个上限只在实际使用插件抓取时生效**；走 DSH 原有抓取来源（`dsh` 模式，或 `auto` 模式下本次抓取没落到插件）时不适用。设置页会直接写明这一点。
- **plugin 抓取不做 DNS 固定（pinning）。** 内置 provider 会解析并固定解析结果，而代理的 fake-ip DNS 让这一步无法照搬；本插件沿用既有安全模型——只做 `http/https` 与**目标地址不得落在私网/回环**的校验，域名交给解析它的代理解析，解析失败也放行。抬高上限不改变这条边界。

卸载前建议先在设置页点击 **“注销”**，它会删除当前平台的凭据和 Host 内存中的额度缓存。

若 DSH 已异常退出，可在确认路径后手动处理凭据文件：

- Windows：`%DSH_HOME%\storages\dsh-chatgpt-subscription\oauth.dpapi`，未设置 `DSH_HOME` 时为 `%USERPROFILE%\.dsh\storages\dsh-chatgpt-subscription\oauth.dpapi`；
- macOS：凭据位于登录钥匙串，可执行 `security delete-generic-password -s dsh-chatgpt-subscription -a oauth` 删除；
- Linux：`$DSH_HOME/storages/dsh-chatgpt-subscription/oauth.json`，未设置 `DSH_HOME` 时为 `~/.dsh/storages/dsh-chatgpt-subscription/oauth.json`。

> Windows 文件只能由创建它的用户通过 DPAPI 解密。macOS 凭据由登录钥匙串在本机加密保存。Linux 文件是未额外加密的 JSON，依赖目录 `0700` 和文件 `0600` 隔离；不要复制、打印或提交该文件。跨平台迁移需要重新登录。

## 随包分发的 Agent Preset

插件自带一个 **调度模式** agent preset（id `dispatch`），随 npm 安装一起分发：0.1.7 起 harness 不再从发现根目录读取 preset，插件改为**运行时注册**（`src/host/agent-preset.ts`：探测 `@deepseek-ai/dsh-agent-preset` 能否解析、`agentPresets` 服务是否在场，然后在 `presets/dispatch/preset.yml` 与 `agent.cordis.yml` 转录出的定义上调用 `register()`，注册失败只记 warn）；0.1.6 及以前仍按老办法把包内 `presets/dispatch/` 同步到 `<dshHome>/.agent-presets/`。两条路都让装了本插件的机器在新建会话时直接选到它，不需要手工拷贝文件。

> 为什么不用静态声明行：0.1.7 的 preset 声明要写进 bundle patch，而 `assertEntriesLoaded` 会把「无 fiber 且未 disabled」的条目判为启动失败——`@deepseek-ai/dsh-agent-preset` 在 ≤0.1.6 上并不存在，静态声明会让那些机器直接开不了机。声明行也不能按运行环境条件化，所以选择运行时注册 + 能力探测。

同步在每个 profile 启动时执行一次（幂等）：

- 目标树与包内副本逐字节相同时跳过，有差异时整体重写，并把包内已删除的多余文件清理掉；
- **行里的包名按运行环境改写**：preset 要挂载 `@deepseek-ai/dsh-workflow-worker-thread`，而 harness 0.1.6 把它改名成了 `@deepseek-ai/dsh-workflow-ptc`，指向不存在的包会让整个 preset 被判为 broken、既不可选也不可复制。同步时用 `import.meta.resolve` 探测当前安装能解析哪个名字（旧名仍在就保留，否则改写成新名；两个都不可用时不改写，因为改名只会掩盖试过哪个），所以同一份 preset 在 0.1.5 与 0.1.6 上都能挂载；
- 只处理本包自己的 preset id（`BUNDLED_PRESET_IDS`），**绝不改动用户手写的 preset 或其它插件的 preset**；
- 包内已不再随附的旧 id 会从目标根目录移除（retire）；
- 同步失败（例如 home 只读）只记一条 warn，不会导致插件加载失败——preset 是便利项，不是本插件提供的核心能力。

> 路径解析不写死相对路径：`src/host/preset-sync.ts` 从模块位置向上查找最近的 `package.json` 作为包根，因此 `src/` 布局、打包后的 `lib/` 布局，以及通过 pnpm symlink / Windows junction 安装都能正确解析。注意 `fs.cpSync({ recursive: true })` 在 Node 22 + Windows 上遇到含非 ASCII 的源路径会直接崩进程（nodejs/node#54476），所以复制是逐条目实现的。

### 与 Agent Teams 不兼容（刻意互斥）

DSH 的 Agent Teams（bundle `@deepseek-ai/dsh-experimental-agent-team-profile`）会在**每个会话自己的作用域**里注册一套与内置**同名**的协调工具。工具注册表按作用域链解析、**近的层遮蔽远的层**，所以一旦该 bundle 被组合进来，会话里的 `send_message`、`list_agents`、`interrupt_agent` 就都换成了 teammate 版：

- `list_agents()` 只列 Team 成员（Lead 自己显示为 `lead`），**看不到 `subagent` 派出去的子代理**；
- `send_message` 的 `target` 只接受成员名，把子代理的 session id 传进去会抛 `active teammate "…" not found`（实测）；
- 于是「派得出去、回访不了」——`subagent` 的孩子只能等完成通知，无法追问。

**坏消息在时机上**：Agent Teams 的 `agent-team/src/roster.ts` 里 `tryMembership` 对任何「无 `parentSession`、且不是 subagent descriptor」的 Agent 直接判为 `lead`，**不需要先有 teammate**。于是 team 工具从会话第一轮起就装在 Lead 上，调度模式还没派发第一个子代理，复审与返工所依赖的三个工具已经没了。

上游对此的立场是明确的：`tool-agent-team` 的文档写着「当同名的旧全局 subagent 工具必须继续可用时，请不要选择……**想同时使用两者的组合必须禁用旧定义**」。而 `dispatch` preset 恰恰是那组旧定义的持有者——0.1.7+ 的运行时注册里由本插件自己挂了 `tool-subagent-control` / `tool-subagent-list-agents` / `tool-subagent` / `tool-subagent-fork` 四行（preset 每一代都是独立 `createScope`，与宿主组合里被 profile patch 置 `disabled` 的那四行不是同一批实例）。所以这不是「可以调好的配置」，而是一个上游明确不承诺的组合。

`dispatch` 的处理是**停，不降级**（persona 的 R0.5 兼容性闸门，每个新会话判一次，早于 R0 分诊）：

| 判据 | 行为 |
|---|---|
| `spawn_teammate` 与 `wait_agent` 都不存在 | 编排可用，写一行「编排可用：subagent」后按 R0 → R-G → R5 → R6 正常走 |
| 任一存在 | 本会话**不可编排**：一句话说明 → 一次 `ask_user_question` 给出三条出路 → 用户答复前**不分诊、不规划、不派发、不动文件** |

三条出路是：① 关掉 Agent Teams bundle、重启 Host 后**新建会话**；② 换用别的 preset，本会话不编排；③ 本次直接做，不进编排流程。**都要新建会话**——工具面在会话启动时就定死了，改完配置在旧会话里也不会回来。

刻意**没有**保留「切到 teammate 词汇继续编排」这条分支（原 R-T）。三条理由：

1. 遮蔽由 scope 链决定，persona 改不回工具注册表——「适配」只能改行为，改不了「哪些工具被顶替」这个事实；
2. 那条分支把「回访不了」从**明摆着的失败**变成**看不见的失败**：roster 里查不到孩子 ≠ 孩子没了，模型会误判并重复派发，白烧一轮预算；
3. teammate 结构上拿不到 per-task 路由（见下节），而 R2 显式路由正是这套设计里最值钱的部分——组队等于自愿放弃它。

> 想把误用也用机制挡掉：把 `spawn_teammate` 从 inherit 清单去掉即可，配置 `subagentModelInheritTools: ['subagent_fork']`，该工具在守卫里就变成**硬拒**（拒绝理由指向 `subagent`），而不是让它悄悄按 Lead 的路由跑完整轮。插件默认值不动——那是全局设置，改它会波及不使用调度模式的会话。

### 回合边界纪律（R-W）

调度模式的 persona 里有一条专门管「回合边界」的规则 `R-W`，约束三件最容易把编排拖慢、拖贵的事：

| 场景 | 规则 | 为什么 |
|---|---|---|
| 等子代理返回 | 默认**结束本轮回复**、一个工具都不调，由完成通知唤醒主代理；禁止 `sleep`、轮询循环和任何只为占位存在的长命令。确实被阻塞时才用 `job_output({ wait: true })` 有界地等一次 | 子代理完成通知是自带的；占位长命令不产出信息，只烧上下文和预算，还把用户晾在一段沉默里 |
| 任务开始建目标 | 除非用户明确要求，否则**不调用 `create_goal` / `/goal`**，任务清单一律走 `todo_write` | 机制性的：目标一旦激活，DSH 会自动续跑唤醒主代理，而子代理何时返回不由它控制——等待被从中间劈开，模型重新分诊、重新检查「还差什么」，每次续跑还要重载整段历史 |
| 需要用户拍板 | 一切「我停在这里是因为缺一个决定」的停点（收到子代理结果要选下一步、验收不过要定返工范围、前提被推翻要改计划）都用 `ask_user_question` 递出去，并给出选项与推荐答案 | 提问是代理的工具，不是用户的义务：否则用户得先替模型把那段话翻译成一次输入。例外是 plan mode 的计划审批（走 `exit_plan_mode`）与任务完成后的收尾 |

三条各自对应 persona 反模式列表里的第 13–15 条。此外，本插件在运行时通过 `system-prompt/assemble` 原位重写 `list_subagent_models` 与 `subagent` 工具描述中的 `"Catalog membership is advisory"` / `"Child LLM selection is optional..."` 误导措辞，并通过 `tools/post-execute` 在每次 `list_subagent_models` 返回末尾直接附上本会话全部已授权的 `{ provider, model }` 拆解对；`R2` 与 `plan-mode` 提示词也同步写明 `list_subagent_models` 是本会话允许清单的**唯一真源**，直接采信其输出即可，无需仅为了确认哪些子代理模型可用去翻找本地配置文件或工作区代码（对应 Anti-Pattern 第 16 条）。

### 为什么不降级：teammate 不能选模型

这是上面第三条理由的技术底座，也是上游修好之后才谈得上重新评估兼容性的前提。

`spawn_teammate` 目前**无法**指定 `provider`/`model`，这不是插件的问题，而是 Agent Teams 有意不做 per-teammate 路由。三层都已核对：

| 层 | 能否带路由 | 证据 |
|---|---|---|
| 工具入参 | ❌ | `spawn_teammate` 的 schema 只有 `name`/`description`/`prompt`/`context` |
| Team 服务 | ❌ | `SpawnTeammateRequest.provider` 是 **subagent 后端名**（`spawn`/`fork`），不是 LLM provider；且无 `model` 字段 |
| 底层 API | ✅ | `ContinuableStartSpec.request` 可带 `agentOptions`（含 provider/model/reasoningEffort），但 Team 服务构造 request 时**只放 prompt 与 parent**，整个省略 |

因此成员必然跑在 Lead 自己的路由上——这正是守卫把它归 inherit 模式的原因，也是**不应**把它加进 explicit 的 `subagentModelTools` 的原因。

**插件侧无法绕过**，四条路都已验证死：pre-execute 明确排除输入改写（参数已被记录与呈现，`PreToolDecision` 只有 allow/deny/cancel/ask）；`agentTeams` 服务在内部丢弃后包装不到；注册自定义 subagent provider 也拿不到路由（`agentOptions` 在 continuation manager 就已解析完，provider 只返回 `seed`）；唯一能改子会话路由的 `selectForNextRequest` 只作用于「下一个请求」，而 teammate 创建后立刻开跑，抢不进去。

**上游正路**：在 `packages/experimental/agent-team/src/roster.ts` 构造 `startContinuable` 的 `request` 处补上 `agentOptions`，并给 `SpawnTeammateRequest` 加字段、给工具 schema 加参数、创建前接 `assertAllowedModelSelection`。**该改动落地后**，`spawn_teammate` 就应从 `subagentModelInheritTools` 移到 `subagentModelTools`（explicit）——否则它会变成「能选模型却没人管」。只补这一条还不足以解除互斥：team 工具的遮蔽发生在会话第一轮（见上节），要真正共存还需要把安装条件从「是 team 成员」收紧成「**有 teammate**」，让没有队友的会话保留内置的 subagent 协调工具。

> 实践提醒：inherit 模式校验的是**当前会话路由**。若当前会话跑在允许清单之外的路由上（例如默认模型与勾选清单不是同一条），teammate 与 `subagent_fork` 都会被拒绝——拒绝文案会指出恢复路径（改用显式路由的 `subagent`，或先把会话切到清单内的模型）。`subagent` 的显式路由不受影响。

### 配置项

| 字段 | 默认 | 含义 |
|---|---|---|
| `syncAgentPresets` | `true` | 启动时是否把包内 preset 同步到 `<dshHome>/.agent-presets`；设为 `false` 则完全不写用户目录 |

### 手动安装（可选）

不想让插件写 home 目录时，可把 `syncAgentPresets` 设为 `false`，再自行拷贝包内的 `presets/dispatch/` 到 `<dshHome>/.agent-presets/dispatch/`。

## 子代理模型授权（0.2.15 起，0.3.2 起强制指定模型）

DSH 设置页的「Subagent」卡片会把勾选的模型写成会话级的允许列表（会话日志事件 `subagent/model-selection-policy`）。DSH 内置委派工具只拒绝**模型显式填写**且不在列表内的路由；调用里不写 `provider`/`model` 时，子代理会继承父级模型，于是白名单之外的主模型（例如 `deepseek-official/deepseek-flash`）仍会被子代理使用。

插件在 Host 工具注册表上补一个单调守卫（`ctx.tools.guard`），在委派执行前要求**每次委派都必须写明路由**：

- 调用会话（或最近的、记录了策略的祖先会话）带有允许列表时，`provider` 与 `model` 必须成对给出，且该路由必须落在列表内——缺省不再回退到配置默认值或父级模型；
- 只写一半（例如只给 `model`）同样被拒绝，拒绝理由会指出缺的是哪一个字段；
- **子代理永远和主代理同一个模型**的历史行为由此消失：模型必须先用 `list_subagent_models` 查出已授权路由，再按拒绝理由里列出的路由（例如 `antigravity/gemini-3.8-flash`）重试；该工具也只展示已授权路由；
- 未记录允许列表的会话（例如恢复的旧会话、未启用该设置的会话）保持 DSH 原有行为（继承父级模型）。

**inherit 模式（`subagentModelInheritTools`，默认 `['subagent_fork', 'spawn_teammate']`）**：有些委派工具**按设计**就没有路由参数，子代理必然跑在调用者自己的路由上——`subagent_fork`（复用对话与 KV Cache）与 Agent Teams 的 `spawn_teammate`（成员一律继承 Lead 的路由）都是这一类。「工具不能选」不等于「这个选择被授权」，所以守卫改为校验它**实际继承到的路由**：允许清单内有该路由就放行，没有就拒绝，并说明该工具无法改路由、要么改用能显式指定路由的 `subagent`、要么先把本会话切到清单内的模型。设为 `[]` 可关闭 inherit 模式的全部校验。

守卫装在 DSH 工具注册表的调度入口上，因此 **`run_code`（代码模式 / PTC）里通过 SDK 调用的 `tools["subagent"]` 同样被拦截**：该子调用走的是与直接调用相同的 `prepare → guard → dispatch` 流水线，拒绝理由以 `ToolCallError` 抛回程序。也就是说模型无法靠把委派写进代码里绕过白名单（`test/subagent-model-authorization-ptc.test.ts` 用真实 `ToolRuntime` + 假 code runtime 验证了放行、缺省拒绝与越权拒绝三条路径）。

配置项（插件行 `config`，全部可省略）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `subagentModelAuthorization` | `true` | 是否启用上述授权守卫；设为 `false` 回到 DSH 原有行为 |
| `subagentModelTools` | `['subagent']` | 需要授权的委派工具名（explicit：必须成对给出 `provider`+`model`）；preset 里自定义了 `toolName` 时在此列出 |
| `subagentModelInheritTools` | `['subagent_fork', 'spawn_teammate']` | 按设计继承调用者路由的委派工具（校验实际继承到的路由）；设 `[]` 关闭 |
| `subagentModelScope` | `session` | `session` 只约束记录了允许列表的会话；`preference` 额外用当前设置卡列表约束未记录的会话 |

> 同一份插件行 `config` 里还有推理塌缩守卫的开关 `reasoningCollapseGuard`——**默认 `false`（关闭）**，功能保留、将来需要时按[推理塌缩守卫（熔断，默认关闭）](#推理塌缩守卫熔断默认关闭)一节显式打开。

改动只在设置卡片里保存过的勾选生效：设置改动只影响之后新建的会话（DSH 的会话快照语义），已运行的会话继续使用它自己记录的那份列表。

> 升级提示：从 0.3.2 起，带有允许列表的会话里**任何**未写明 `provider` + `model` 的委派都会被拒绝（此前只有写明且不在列表内的路由会被拒绝）。这是有意的行为变更——它消除了「子代理悄悄继承主代理模型」的漏洞；把 `subagentModelAuthorization` 设为 `false` 可回到 DSH 原始行为。

### Kimi Code

1. 重启 `dsh web`；
2. 打开 **设置 → Kimi Code**；
3. 点击 **设备码登录**，在弹出的浏览器页面确认授权（页面已预填用户码；也可手工复制用户码到 `verification_uri`）；
4. 登录完成后按需勾选模型、设置默认思考档位与上下文窗口。

`kimi-code` 会像其他 Provider 一样出现在 DSH 模型选择器中。**上下文窗口**默认取模型目录值，可逐模型覆盖（用于 DSH 的压缩与溢出判断，支持 `1M` / `256K` / `200000` 等写法）——注意 `k3` 的 1M 上下文需要 Allegretto 及以上套餐，因此默认按 256K 计算，升级后再在此覆盖为 1M。

**申报的窗口默认就是目录值或你的覆盖值，不做折算**——`k3` 覆盖成 1M 就按 1M 申报。撞上 2 MB 请求体上限时，本地守卫抛的是 `CONTEXT_WINDOW_EXCEEDED`：DSH 会对该码**自动压缩本轮历史并重试同一步**，所以表现是「压缩一次后继续」，不是整轮失败。想要「撞墙之前就自动压缩」，可设 `DSH_KIMI_CODE_BYTES_PER_TOKEN` 启用窗口折算：申报值 = `min(声明值, floor(2MB / d))`。取值按内容密度选——DSH 的 token 计量是固定密度（4 字符/token，见 `@deepseek-ai/dsh-token-meter`），看不见中文占 3 字节，所以「一个计量 token 占多少字节」= 4 × 每字符字节数：纯 ASCII 约 4、中英混合约 8、密集中文约 12；对应的字节墙分别是 524288 / 262144 / 174763 计量 token。实测：`d=4` → 524288（代码为主的会话在 1.68 MB 处压缩）、`d=8` → 262144（混合）、`d=12` → 174762（中文，三种密度都在墙前）。压力阈值是 `min(floor(0.8 × 窗口), 窗口 − 65536)`（`compaction-basic`：`thresholdRatio` 默认 0.8、`headroomTokens` 默认 65536、本线路不申报 `defaultMaxTokens` 故无输出预留）。该变量是**可选的提前压缩开关**而不是安全守卫：不设或拼错等于不启用，真正兜底的是上面那个恢复码。**默认思考档位**只提供 `low` / `high` / `max` 三档与「关闭思考」（服务对这三档以外的取值直接报 400）；切换模型或切换档位都会使上下文缓存失效，建议在同一会话内保持一致。

**额度倍率**取自官方模型表并显示在设置页模型能力表的「说明」列（悬停可一并看到）：`k3` = **2×**、`k3-256k` = **1×**、`kimi-for-coding` = **1×**、`kimi-for-coding-highspeed` = **3×**。倍率绑定**模型 id**，与上下文长度、缓存命中率都无关——选 `k3` 就是 2×，哪怕只用几千 token。注册表不认识的新模型 id 显示为**未知**而不是猜成 1×。

**区域**：默认使用中国大陆主机（`auth.kimi.com` / `api.kimi.com`）。国际账号可设置 `DSH_KIMI_CODE_OAUTH_HOST=https://auth.kimi.ai` 与 `DSH_KIMI_CODE_BASE_URL=https://api.kimi.ai/coding` 后重新登录；环境变量同时会钉住区域，设置页会显示当前解析到的主机。

## 推理塌缩守卫（熔断，默认关闭）

本线的“熔断器”就是**推理塌缩守卫**（`src/host/reasoning-collapse-guard/index.ts`）。一个长推理流可能退化成复读——反复绕过同一小撮短语、既不调工具也不收尾，一直到输出上限把这一轮截断（曾经有一次会话就这样烧掉 128,000 输出 token 并返回空答案）。守卫订阅 `llm/stream` 瀑布，对**尾部推理窗口**同时算两个信号：

- **字面重复度**：n-gram 唯一性，健康推理接近 0，退化流接近 1；
- **语义复现度**：每条句子有多强地重复了 `semanticLag` 句之前已经说过的内容——用来抓“换着词说同一件事”，这类流的字面分只有 0.48，永远碰不到 0.85 的阈值。

两个信号必须在**同一个窗口同时越线**，并且连续 `semanticConfirmations` 个窗口都如此，守卫才会切断本轮流；切掉之后它只做一件事：在 Agent 空闲时 steer 一条续跑，让这一轮在新的步骤上跑完。单个信号或单个异常窗口只记日志、放行——**误杀一段健康回答的代价比放过一次失控更大**。

**现状：默认关闭。** 这个熔断在生产轮次里已经没有需要，所以本线不再默认接电；功能、实现与全部测试都原样保留，等将来需要时再打开。

| 现象 | 关闭后 |
|---|---|
| `llm/stream` 订阅 | 不注册（守卫连 `ctx.effect` 都不装） |
| 每回合的熔断簿记 | 不建立 |
| 切断后那条续跑 | 不排队 |
| 运行时开销 | 零：默认配置下这段代码根本不会进入执行路径 |

### 将来需要时怎么打开

守卫的开关是插件行 `config` 里的 `reasoningCollapseGuard`，写在 profile 的 `cordis.patch.yml`（与「抓取模式与上限」同一位置，**重载插件或重启 DSH 后生效**）：

```yaml
- id: dsh-chatgpt-subscription
  config:
    reasoningCollapseGuard: {}        # 空对象 = 用出厂默认值把熔断接回来
```

想调参就在这个对象里写字段；省略的字段取出厂默认值：

```yaml
- id: dsh-chatgpt-subscription
  config:
    reasoningCollapseGuard:
      threshold: 0.85                 # 字面重复度阈值（默认 0.85）
      windowChars: 4096               # 每次参与评分的尾部推理字符数（默认 4096）
      maxBreaksPerTurn: 3             # 单回合最多切断几次（默认 3）
      cooldownMs: 30000               # 两次切断的最小间隔毫秒（默认 30000）
      semanticThreshold: 0.35         # 语义复现度阈值（默认 0.35）
      semanticConfirmations: 3        # 双信号需连续命中的窗口数（默认 3）
      includeModels: [gpt-6.1-sol]    # 只看这些模型；空数组 = 看全部（默认 []）
```

| 取值 | 含义 |
|---|---|
| 不写（缺省） | **关闭**——2026-10 起的出厂默认 |
| `{}` | 打开，全部取出厂默认值 |
| 对象（含调参） | 打开，按对象覆盖默认值；数字由守卫自己的 fail-loud 校验，非法值会让插件加载失败而不是被静默忽略 |
| `false` | 显式关闭（与缺省等价，写出来更自明） |

> **将来重新开启前先验证一件事**：守卫与续跑队列共用 `llm/stream` 的**外层**位置，开启后它在切断时不会给出 finish chunk，因此 `noAnswerResume`（无答案续跑，默认仍开启）在那种被放弃的流上不结算、也不消耗预算——这条约束在 0.26.0 的续跑预算修复里已经落实并有回归用例（`test/no-answer-resume.test.ts`）。若将来改了守卫的切断方式，需要同时复查这条边界。

**升级提示**：默认安装的 Host 升级后不再有任何塌缩熔断与随之的续跑；依赖“死循环自动刹车”的部署按上面的 YAML 显式写回即可。新增回归用例 `test/circuit-breaker-default.test.ts` 钉住了“默认必须关闭”和“打开后仍可用”两半。

## Command Code 线路

插件注册 `command-code` Provider，对接 Command Code 的两套接口：

| 用途 | 地址 |
| --- | --- |
| 模型生成（Anthropic 格式） | `https://api.commandcode.ai/provider/v1/messages` |
| 模型生成（OpenAI 格式） | `https://api.commandcode.ai/provider/v1/chat/completions` |
| 模型目录（公开） | `https://api.commandcode.ai/provider/v1/models` |
| 账号信息 | `https://api.commandcode.ai/alpha/whoami` |
| 额度与用量 | `/alpha/billing/credits`、`/alpha/billing/subscriptions`、`/alpha/usage/summary` |
| 浏览器登录页 | `https://commandcode.ai/studio/auth/cli` |

模型 id 决定线路（`claude-*` 为 Anthropic），这也决定了请求体形态：Anthropic 线路的系统提示词放在顶层 `system`、工具用 `input_schema`、工具结果用 `tool_result` 内容块；OpenAI 线路的系统提示词是 `messages[0]`、工具用 `function.parameters`、工具结果用 `role: "tool"`。两条线路都只把 DSH 交付的可见文本、图片与工具调用发出去——reasoning 块不会被回放，因为这里的上游都不接受缺少签名的思考块。

**模型能力表**（`src/host/command-code/model-catalog.ts`）逐模型声明 `inputModalities`、`reasoningEfforts`、`contextWindow` 与可选的输出上限，内容转录自官方 CLI 的模型注册表——公开的 `/provider/v1/models` 只有 id、名称与 `context_length`，既不说模态也不说思考档位，而族级前缀推断在同一厂商内部就会出错（见上）。模型不在表内时按纯文本、无思考档位处理：DSH 会把图片转成一条可见的占位文本让用户改选模型，而反过来把图片发给不接受它的端点会让整个请求失败。

图片以 base64 内联（OpenAI 线路 `image_url` 的 `data:` URL，Anthropic 线路 `image` 块的 `base64` source）；单次请求的图片负载超过 12 MiB 时按最旧优先替换为本插件同款占位文案。读不出字节的图片降级为可见说明文本，不会被静默丢弃。

**失败分类与重试**：`command-code` 路由在注册时携带一份显式的 `normal` retry policy（`maxRetries: 3`、`initialDelayMs: 1500`、`maxDelayMs: 15000`、`jitterRatio: 0.2`），可重试码为 `RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`——与 `codex-chatgpt` 路由同源，只是未包含该路由的历史码 `SERVER_ERROR`/`NETWORK`。分类规则：HTTP 5xx（含上游 502）→ `SERVER`；连接层失败（fetch 抛错）→ `TRANSPORT`；429 → `RATE_LIMIT` 并附 `Retry-After`（上限 10 分钟）；401/403 → `INVALID_CREDENTIAL`（换 Key，不重试）；流式空闲超时由看门狗转成 `TIMEOUT`。策略由 DSH 的 `dsh-llm-retry` 插件在 `agent/request-error` 上执行，每次重试都会写入 `llm/retry` 会话事件。

**凭据存储**：API Key 使用与 Antigravity 相同的系统凭据存储——Windows 是 CurrentUser DPAPI（`$DSH_HOME/storages/command-code-credentials.json.dpapi`），macOS 是登录钥匙串，Linux 是 Secret Service（服务名 `dsh-command-code`，账号键按旧凭据文件绝对路径生成）。旧版明文 JSON 只作为迁移来源，读取后加密回写、校验并删除；注销会同时清理两者。凭据只存在于 Host 内存与系统凭据存储中，不会进入浏览器、`settings.yaml` 或日志。

**浏览器登录的回环服务器**只在 `127.0.0.1` 上监听 5959 起的空闲端口，只接受与该次登录 `state` 匹配的回调，10 KB 请求体上限，5 分钟超时；回调成功后浏览器标签页会跳到 `/callback/complete` 上的人工可读页面。登录成功后 Studio 页面回传的 API Key 会先经 `/alpha/whoami` 验证，验证失败的 Key 不会被保存。

### 插件路由（Command Code）

所有路由都以 `/command-code/api` 为前缀：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/status` | 账号（脱敏）、额度、模型目录与路由归属 |
| POST | `/login` | 开始浏览器登录，返回登录页地址 |
| GET | `/login/status` | 查询登录进度 |
| POST | `/login/apikey` | 校验并保存手动填写的 API Key |
| POST | `/logout` | 注销并清理凭据与缓存 |
| GET / POST | `/quota` | 强制刷新额度（POST）或读取当前状态（GET） |
| GET / POST | `/models` | 读取或更新勾选的模型与上下文窗口 |
| POST | `/settings` | 更新默认思考深度与上下文窗口覆盖 |
| POST | `/catalog/refresh` | 强制刷新模型目录 |
| POST | `/connection/test` | 用已存凭据调用 `/alpha/whoami` 测试连接 |

与 `codex-chatgpt` 线路一样，所有修改状态的路由只接受同源 JSON POST，并校验 `Origin` 与 `Host`。

## Claude（订阅）线路

### 风险须知（请先读）

本线路以 **Claude Pro / Max 订阅登录**访问模型。Anthropic 现行条款写明**不允许第三方应用提供 Claude.ai
登录、也不允许代用户经 Free / Pro / Max 凭据转发请求**，并保留不经预告的执法权；**本插件未获 Anthropic
任何授权或认可**，你的账号**可能因此被限制、暂停或终止**。

此前版本在设置卡片上设有一个必须显式接受的确认步骤，并配套一条主机侧门禁；**该步骤与门禁均已移除**，
现在打开卡片即可直接使用。移除的只是那一步交互——上面这段事实、以及由此产生的风险，都不因移除而改变。
是否使用请自行判断并承担后果。

### 登录

1. 订阅 **Claude Pro 或 Max**，并确保你能在浏览器里登录 claude.ai；
2. 重启 DSH，让 Host 加载本插件；
3. 打开 **设置 → 订阅服务 → Claude**；
4. 点「登录 Claude 订阅」。默认走**手动粘贴**：浏览器打开授权页后会把授权码显示在屏幕上，把
   `<授权码>#<state>` 整段复制粘贴回来即可（也接受直接粘贴整条重定向 URL）。若使用 loopback 回调模式，
   本机一个可用端口会被自动探测并绑定 `127.0.0.1`；
5. 按需勾选模型、设置默认思考深度与上下文窗口。

`claude-subscription` 会像其他 Provider 一样出现在 DSH 模型选择器中。**上下文窗口**默认取内置能力表声明的窗口，
可逐模型覆盖（用于 DSH 的压缩与溢出判断，支持 `1M` / `512K` / `200000` 等写法）；**默认思考深度**只对声明了
档位的模型生效。**档位原样透传**（`ReasoningEffortId` 在 harness 里是无约束 brand，本仓库多条线路都直接使用
`xhigh`），不做任何收敛，以免把用户选的档位静默降级。

**模型表**共 17 条：15 条转录自本机随 harness 安装的参照目录（**Claude Opus 5.5** 已在参照目录中，只是
`thinkingMode` 一项按官方文档取值，见下），另加 2 条**本地新增**：**Claude Sonnet 5.5**
（`claude-sonnet-5-5`，官方 2026-09-28 发布，1M 上下文 / 128K 输出 / 支持图片；不支持 temperature、思考不可关闭；
官方默认档位为 `high`，且思考块与会话前缀绑定，因此走 `mid-convo` 分支并带 `block_binding`），以及
**Claude Haiku 5.5**（`claude-haiku-5-5`，官方 2026-10-07 发布，规格同上；**固定 id，无日期后缀也没有别名**）。
以下说明针对 Opus 5.5。
它有一条**与其它模型不同的硬约束**：**思考永远开启、不能关闭**——官方文档明确 `thinking:{type:"disabled"}`
与 `{type:"enabled",budget_tokens:N}` **都会返回 400**，因此能力表把它标为不可关闭思考，档位表是控制思考深度的
唯一手段。它的**默认档位是 `medium`**（其余带 effort 的模型默认 `high`），这一点被刻意保留：本仓库有两类模型走
「强制 effort」分支，若把 Opus 5.5 一并归入，就会**静默把每次请求抬高一档、花更多钱**，因此它走的是普通 adaptive
分支。但它（与 Fable 5.1、Sonnet 5.5 一样）是官方文档列明的**思考块前缀校验模型**：2026-08-31 之后创建的账号，一旦
前缀变化（压缩、工具列表变化、图片卸载）回放思考块就会**每次都 400**，因此能力表用 `bindsThinkingToPrefix` 标记它，
adaptive 分支对这类模型额外发送 `block_binding: drop_block`（**不**强制 effort）。

它还有一条**版本门槛**：上游要求申报的客户端版本 **≥ 2.1.280** 才为该模型提供服务。能力表用 `minCliVersion`
记录这一点（**只有这一行有门槛**，其余 16 行缺省——缺省表示「未知」而不是「无门槛」，不臆造数字）。插件申报的
默认版本为 **2.1.293**（不低于首次提供 Sonnet 5.5 的 Claude Code 2.1.284，也不低于首次提供 **Haiku 5.5 的 2.1.293**——
加这一行时 npm 的 `stable` 标签仍停在 2.1.285，所以这里必须读 `latest` 而不是 `stable`），并且**在发出请求之前就本地校验**「申报版本 vs 该模型门槛」，不满足时直接给出模型、当前
版本与要求版本，**而不是白花一个往返让上游返回 400**。测试另有一条不变量：**申报的默认版本必须 ≥ 表中每个模型的
门槛**——这条锁让「加了高门槛模型却忘了抬版本」无法通过 CI。

**Claude Haiku 5.5** 有三条与上面两个 5.5 不同的地方，都是照抄官方文档、不是从模型名推的：

- **它可以关闭思考，但只在低档位**。官方明确 `thinking:{type:"disabled"}` 在 `low`/`medium`/`high` 被接受，在
  `xhigh`/`max` 是 400——因此能力表把它标为**可关闭**（`canDisableThinking: true`），这是本表里唯一一个为真的
  本地新增行。这条线路只在调用方明确要求「关闭思考」时才发这个 form，且此时**不申报任何档位**，请求因此跑在
  官方默认 `medium` 上——正落在被接受的一侧；而想用 `xhigh`/`max` 的人一定开着思考，走的是 adaptive form。
- **它不能沿用 Haiku 4.5 的 `budget` 表**。官方迁移指南写明手动预算形式
  `{type:"enabled",budget_tokens:N}` 在 5.5 上是 400，所以这一行改走 `adaptive`；又因为官方默认档位是
  `medium`（与 Opus 5.5 同列），它同样**不进 `mid-convo` 分支**——那一档会强制 `effort: high`，等于每次请求
  都替用户多花一档。它同样是官方文档列明的**思考块前缀校验模型**，所以 `bindsThinkingToPrefix` 为真。
- **它的思考块只在产出它的账号里有效**。官方写明换账号回放会被**静默丢弃**（请求成功，模型看不到那段推理）。
  Claude 号池会在多个账号之间轮换，所以长会话中途换号会表现为「同一段对话里答案质量忽高忽低」而**不报错**——
  这是换号的行为，不是模型不稳定。另外 5.5 与 4.7 之后的模型用同一个新 tokenizer，同样的文本约多 30% token。

### 收编本机已有的 Claude Code 登录（可选，默认关闭）

如果你本机已经登录过 Claude Code，可以点「收编本机登录」把它作为一条账号导入，省去再次登录。
两点必须清楚：

- 开启前插件只探测**文件是否存在**，不读取内容；只有你显式开启后才读取；
- 导入的是**快照**，**本插件永不再刷新它**。Claude Code 刷新的是同一枚轮换令牌，两个进程各自刷新会互相
  作废，进程内的单飞机制解决不了跨进程竞态。快照过期后请**回 Claude Code 重新登录，再收编一次**；
- 本插件**绝不写入或删除** Claude Code 的任何文件；「停止收编」只移除插件这边的记录。

### 上游接口

| 用途 | 路径 | 鉴权 |
| --- | --- | --- |
| 模型生成 | `POST https://api.anthropic.com/v1/messages?beta=true` | `Authorization: Bearer <access token>`，**且 `x-api-key` 必须缺省** |
| 模型目录 | `GET https://api.anthropic.com/v1/models` | 同上 |
| 订阅额度 | `GET https://api.anthropic.com/api/oauth/usage` | 同上，另带 `user-agent: claude-code/<版本>` |
| 授权 / 令牌 | `https://claude.ai/oauth/authorize`、`https://platform.claude.com/v1/oauth/token` | PKCE S256（端点可用环境变量覆盖） |

请求带有 Claude Code 身份头（`user-agent`、`x-app`、`anthropic-beta`），并在 `system` 首块声明 Claude Code 身份。
这是订阅令牌被服务端接受的前提，已在代码与测试中显式锁定。

### 插件路由（Claude 订阅）

所有路由都以 `/claude/api` 为前缀：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/status` | 账号、额度、模型目录、登录流程与路由归属 |
| POST | `/login` | 开始 OAuth 登录，立即返回流程状态（不阻塞） |
| GET | `/login/status` | 轮询登录流程状态（客户端每 2 秒一次，无 SSE） |
| POST | `/login/cancel` | 取消登录并释放回调端口 |
| POST | `/login/input` | 提交手动粘贴的授权码 / 重定向 URL |
| POST | `/adopt` | 收编本机 Claude Code 登录（只读，作快照入池） |
| POST | `/adopt/disable` | 停止收编（不触碰 Claude Code 的文件） |
| GET / POST | `/quota` | 读取或强制刷新额度；失败以 `quotaError` 呈现而非请求失败 |
| GET / POST | `/models`、`/settings` | 读取或更新勾选模型、上下文窗口、默认思考深度与选中账号 |
| POST | `/catalog/refresh` | 强制刷新模型目录 |
| POST | `/connection/test` | 向上游发一次最小请求测试连接 |
| POST | `/accounts` | 号池动作：`set-primary` / `set-alias` / `delete` / `clear-cooldown` / `clear-auth-failed` / `strategy` |
| POST | `/logout` | 注销（号池感知） |

### 插件路由（MiniMax Code）

所有路由都挂在本线路自己的 `/minimax-code/api` 前缀下（与 antigravity / claude / command-code /
kimi-code 一致），**不**占用 Codex 那条线路的 `/api/dsh-chatgpt-subscription` 前缀。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/status` | 账号、区域、凭据来源与路径、硬编码模型目录、路由归属（`serving` / `conflict`）与凭据归属（`ownedByPlugin`） |
| POST | `/login/start` | 开始设备码授权（可带 `region`） |
| POST | `/login/poll` | 轮询一次授权结果 |
| POST | `/login/cancel` | 取消授权 |
| POST | `/logout` | 注销**本插件自己那份**凭据；桌面端的登录态会拒绝并说明原因 |
| POST | `/test` | 向上游发一次最小 Messages 请求测试连接 |
| GET / POST | `/models`、`/settings` | 读取或更新启用开关、勾选模型、上下文窗口覆盖与默认思考深度；两个路径等价（kimi/claude 叫 `/models`，command-code 叫 `/settings`） |
| GET / POST | `/accounts` | 号池动作：`set-primary` / `set-alias` / `delete` / `clear-cooldown` / `strategy` / `relogin` / `adopt`（`adopt` = 把桌面端当前登录态导入号池，只读、不改动官方客户端文件） |
| GET / POST | `/quota` | 读取用量快照（POST 强制刷新）：Token Plan 的 5 小时与每周窗口。**上游读失败不算请求失败**——`quota` 是可选字段，失败时卡片显示“暂无数据”，对话不受任何影响 |

与其它线路一样，所有修改状态的路由只接受同源 JSON POST，并校验 `Origin` 与 `Host`。**响应里永远不含
access token / refresh token / 授权码 / PKCE verifier**；诊断里提到某个令牌时只输出它的
**SHA-256 指纹前缀**（`sha256:.../len:...`），**不是**令牌的任何一段原文——早前版本会打印前 6 个字符，
那本身就是一次凭据泄露，因为同一个字符串会被渲染到设置卡片并写进 Host 日志（有测试锁定）。

## GLM（ZCode 账号）线路

`glm-coding-plan`（显示名 **GLM（ZCode 账号）**）接入 **GLM Coding Plan** 订阅：你在 ZCode 页面用自己的**账号**完成授权，插件用 ZCode 自己的 CLI OAuth 控制面换出 Coding Plan Key，再打**套餐专用**端点——不粘贴 API Key，也不需要你手工铸造 Key。国区（BigModel）与国际区（Z.ai）是两套互不连通的部署：各自独立登录、独立凭据、独立号池行，同一个号池里可以同时存在两区账号且互不串用。

> ⚠️ **本线路没有经过实机账号验证。** 开发与验收环境不具备真实的 ZCode 账号，全部验收都是 mock 验收。下面「已知限制」逐条写明哪些上游行为**仍未验证**、以及拿到账号后必须先复验什么——那不是免责套话，是复审清单。

**登录**：

1. 确认自己属于国区还是国际区。**付费套餐与免费体验额度都可以登录**：官方文档写明新用户连接 BigModel 账号后自动获得「体验套餐：无需付费，在首次使用起的 5 天内，每天提供 800 万 token 的 GLM 系列模型体验额度」，所以本线路**不再要求**必须先订阅 Coding Plan；
2. 重启 DSH，打开 **设置 → 订阅服务 → GLM（ZCode 账号）**；
3. 选好区域后点「登录」：插件开一次 OAuth 流并自动打开授权页；浏览器打不开不是致命错误，授权链接始终显示在卡片上，可自行复制打开。卡片每 2 秒轮询一次进度；
4. 授权完成后插件自动跑兑换链换出 Coding Plan Key、验一次活、加密落盘并加入号池。验活只回答「这把 Key 会不会被上游认出来」，**不要求账号有付费套餐**：认得出来就落盘，卡片上如实标出当前是「付费套餐」还是「免费体验额度」。浏览器没走通时可以「手工粘贴」回调链接或授权码——粘贴只是「去问一次上游」的信号，**凭据仍然只来自上游轮询**；
5. 也可以点「导入本机 ZCode 登录态」省掉一次登录（见下）。

**导入本机 ZCode 登录态（可选，只读）**：只读本机已登录的 ZCode 客户端凭据文件 `~/.zcode/v2/credentials.json`（`ZCODE_DATA_BASE_DIR` 可覆盖），**从不创建、修改或删除** ZCode 的任何文件。该文件的加密密钥可由「平台 + 用户名 + 主目录」推导，因此普通用户的导入不依赖额外密钥；**设了 `ZCODE_CREDENTIAL_SECRET` 的用户会导入失败**，此时回落浏览器登录、不阻断。导入到的凭据与浏览器登录走**同一条兑换链**，下游完全共用。

**上游接口**：

| 用途 | 路径 | 鉴权 |
| --- | --- | --- |
| OAuth 开流 | `POST https://zcode.z.ai/api/v1/oauth/cli/init` | `Authorization: Bearer <pollToken>`；pollToken 是本地 `randomBytes(32)` 生成的绑定令牌，**不是登录凭据**、不落盘 |
| OAuth 轮询 | `GET https://zcode.z.ai/api/v1/oauth/cli/poll/{flow_id}` | 同一个 Bearer pollToken |
| 业务 JWT（**仅国际区**） | `POST {业务 host}/api/auth/z/login` | 请求体带 OAuth access_token；响应给出业务 JWT 与 `expires_in` |
| 兑换：默认机构与项目 | `GET {业务 host}/api/biz/customer/getCustomerInfo` | 国际区 `Authorization: Bearer <业务 JWT>`；国区是**裸 access_token**（见「两区差异」） |
| 兑换：Key 列表 / 创建 | `GET` / `POST {业务 host}/api/biz/v1/organization/{orgId}/projects/{projectId}/api_keys` | 同上 |
| 兑换：取 secretKey | `GET {业务 host}/api/biz/v1/organization/{orgId}/projects/{projectId}/api_keys/copy/{apiKeyId}` | 同上 |
| 模型生成（Anthropic 面） | `POST {api host}/api/anthropic/v1/messages` | `x-api-key` 与 `Authorization: Bearer` **同值双头**（该兼容网关两个都读） |
| 模型生成（OpenAI 兼容面） | `POST {api host}/api/coding/paas/v4/chat/completions` | `Authorization: Bearer <Coding Plan Key>` |
| 配额 | `GET {业务 host}/api/monitor/usage/quota/limit` | **`authorization: <id>.<secret>` 裸 Key，不可加 `Bearer`**（加了会鉴权失败，与模型面正好相反） |

模型面刻意**不是**通用开放平台的 `/api/paas/v4`：官方文档的 Common mistakes 段写明走那个面套餐额度不生效——用户会看到「买了套餐却在扣余额」。所以 `glm-5.1` / `glm-4.7` 那批只挂在通用面上的模型**不在本线路目录里**；上游目录真出现、而本插件未转录过的 id 会作为「未声明模型」进入目录（不猜协议、不发思考档位、不认图），而不是凭空补一行能力。

轮换出来的 Key 落盘前会用配额接口验一次活，而这一步的两类失败**处置相反**：**凭据本身无效**（鉴权类业务码 1000 / 1001 / 1003）仍然在**登录阶段**报错——放行等于拿着一把废 Key 进对话，用户只会在某次请求里以一个莫名其妙的 401 看到它；**凭据有效但没有付费套餐**（配额面按余额 / 套餐 / 额度维度拒绝）则**放行**，并把额度类型如实记为「免费体验额度」。额度耗尽时由上游返回 429 告知，本线路不预判、也不绕过。

**两区差异**：

| | 国区 `cn` | 国际区 `intl` |
| --- | --- | --- |
| 业务 host（兑换链、配额） | `https://bigmodel.cn` | `https://api.z.ai` |
| 模型面 host | `https://open.bigmodel.cn` | `https://api.z.ai`（国际区把控制台与模型面放在同一个源站上） |
| 浏览器授权入口 | `https://bigmodel.cn/login?appId=zcode` | `https://chat.z.ai/api/oauth/authorize?client_id=client_P8X5CMWmlaRO9gyO-KSqtg` |
| 开流请求里的 `provider` | `bigmodel` | `zai` |
| 业务 JWT | **跳过 `/api/auth/z/login`**，拿 OAuth access_token 当**裸 `Authorization`** 直接打 `/api/biz/*` | 先换业务 JWT，之后 `/api/biz/*` 带 `Bearer <业务 JWT>` |

两区共用同一个 OAuth 控制面（`zcode.z.ai/api/v1/oauth/cli/*`），分开的只有上面这几行。**业务 JWT 的自动重取只服务国际区**——国区没有这一层。授权参数里**没有 PKCE**（两个 provider 的授权参数只有 redirect / appId / state），本插件照抄上游形状，不自带 `code_challenge`。本仓库历史里那句「国区没有浏览器登录」是错的，本线路删除了它：国区**有**浏览器登录，只是入口与参数名都不同。

**模型目录**：随包目录 4 个模型（`GLM-5.3` / `GLM-5.3-Flash` / `GLM-5.2` / `GLM-5-Turbo`），逐模型事实转录自官方开源版内置配置 `zai-org/ZCode` 的 `config/provider/zcode-builtin.json`（revision 31）。能力**逐模型查表，不从模型名推断**，其中三处是被官方配置纠正过的历史值：

- **输出上限**：GLM-5.3 家族与 GLM-5.2 是 **128000**、GLM-5-Turbo 是 **64000**。历史转录引用的 docs.z.ai 通用参数表给的是 131072，按本仓库「取小值」的规则取 128000（高报会被网关拒，低报只是提前压缩）；128000 也正是**官方客户端自己在 Coding Plan 面上发的那个数**。同一代模型上限差一倍，正是「不得按家族名推」的又一处证据；
- **图片输入**：四个模型的 `supportsImages` 全为 `true`——**不是因为模型多模态**，而是官方配置里两条 `modelMatch: ".*"` 的站点规则把 `api.z.ai/api/anthropic` 与 `open.bigmodel.cn/api/anthropic` 这两个 Coding Plan 基址的 `supportsImage` 打开成 true（基础规则对 `GLM-5.3` / `GLM-5.2` / `GLM-5-Turbo` 写的都是 false）。所以这条能力读作「**经本线路这两个端点时**收不收图」；
- **套餐归属**：这四个**全部**是 Coding Plan 模型；反倒是 **Start Plan 缺 `GLM-5.3`**。这一条曾被写反过，写反的代价是把两个确实在套餐里的模型判成未订阅、用户连试都不能试。留着它是为了让复审记住：**套餐归属是账号的属性，不是模型的属性**，同一个 id 在不同 provider 规则下启用的集合是不同的。

思考档位同样逐模型声明：`GLM-5.3` / `GLM-5.3-Flash` 三档且**不可关闭思考**（上游把 `thinking.type: "disabled"` 当错误拒绝），`GLM-5.2` 两档（模型页面写的是更宽的词汇，但它同时写明套餐如何映射，真正能上线缆的只有这两级）且可关闭，`GLM-5-Turbo` **不收档位**（梯子为空，请求里根本不发思考控制字段）。DSH 词汇表更宽的 `minimal` / `medium` / `xhigh` 先收敛到模型真实的梯子再发出去，平手时向上取。

**瞬时失败按错误类别重试**：`glm-coding-plan` 路由显式声明 `normal` 策略（最多 3 次，1.5s 起指数退避、15s 上限、0.2 抖动），覆盖 `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT`。分类**不能停在状态行**——冻结的错误码表里七条 429 中**只有两条可重试**（1302 频率限制、1305 瞬时过载），其余五条全是额度类，所以**正文没给业务码的裸 429 一律判不可重试**（`Retry-After` 仍然读取并下发，它不改变判定）。同一张表在两个协议面上是**同一份取值**，Anthropic 面与 OpenAI 面各有一份判读函数，改一处必须同时改另一处。

### 插件路由（GLM Coding Plan）
所有路由都以 `/glm-coding-plan/api` 为前缀：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/status` | 账号、区域、配额快照、模型目录、登录流程与路由归属（`serving` / `conflict`）；页面唯一的读口 |
| POST | `/settings` | 启用开关、勾选模型、上下文窗口覆盖、默认思考深度、选中账号；**先落盘再发** `llm/adapters-updated` |
| POST | `/accounts` | 号池动作：`set-primary` / `clear-cooldown` / `delete` / `relogin` / `strategy`（`sequential` / `round-robin` / `sticky`） |
| POST | `/login/start` | 按区域开一次 OAuth 流，立即返回流程状态（不阻塞） |
| GET | `/login/status` | 轮询登录流程状态；**只有这一条 GET 会推进状态机**——host 刻意不在后台轮询，关掉设置页之后就不会继续打上游 |
| POST | `/login/cancel` | 取消登录流程 |
| POST | `/login/manual` | 手工粘贴回调链接或授权码 |
| POST | `/adopt` | 导入本机 ZCode 登录态（只读，作快照入池）；失败**永不阻断**，每种失败都是契约里的一个 reason，卡片据此回落浏览器登录 |
| POST | `/connection/test` | 沿用兑换链验活那条路径（配额接口裸 Key）：它答「这把 Key 还能不能读配额」，**答不了**「这个模型能不能被调用」——后者要花一次真实生成，交给用户发第一条消息 |
| POST | `/quota` | 强制刷新配额；一次失败的配额读不是一次失败的请求，卡片照旧渲染 |
| POST | `/catalog/refresh` | 强制刷新模型目录 |

与其它线路一样，所有修改状态的路由只接受同源 JSON POST，并校验 `Origin` 与 `Host`。`/adopt` 与 `/connection/test` 的 DTO 定在**顶层**（不带 `{ok,value}` 信封），其余一律走信封。**响应里永远不含 access token、refresh token、业务 JWT 或 Coding Plan Key 的原文**——登录状态 DTO 是逐字段显式投影出来的，而不是展开整个会话对象；将来给会话对象加字段会因此变成一次必须被看见的改动。

**已知限制（拿到账号后请先复验这几条）**：

- **本线路的全部验收都是 mock，没有任何实机账号验证。** 开发与验收环境不具备真实的 ZCode 账号：下面每一条上游行为都是照官方源码、官方文档与社区逆向实现实现的，并由 mock 走通流程与分支，**没有一条经过 live 验证**。因此本节不是「已知问题」清单，而是**拿到账号后的复审清单**——先复验它们，再谈这条线路在你的账号上可用。同批仍未验证的细项还有：服务端实际下发的 `poll_interval_sec`（只见最小 1 秒的校验，无实测样本）、桌面回调中转路径里的握手标识是否会轮换、以及周度 / 月度配额窗口的长度（按词义取 7 天 / 30 天，上游只给了「周度」「月度」这个名称，缺一份真实配额响应样本里的窗口起止时刻；5 小时那一档有逐字证据，不受影响）。
- **支持免费体验额度与付费套餐，但免费额度的具体行为未经验证。** 本线路现在
  「有额度就放行」：验活只判断这把 Coding Plan Key 会不会被上游认出来，不再要求账号
  已订阅付费 Coding Plan。官方文档（逐字：zcode.z.ai/cn/docs/configuration）写明新用户
  连接 BigModel 账号后自动获得「体验套餐：无需付费，在首次使用起的 5 天内，每天提供
  800 万 token 的 GLM 系列模型体验额度」，welcome 页也写明「新用户可享受每日免费的 GLM
  旗舰模型体验额度」——所以**「没有付费套餐」不等于「没有额度」**，登录阶段硬拒会把免费额度的
  新用户全部挡在门外。卡片会如实区分「付费套餐 / 免费体验额度 / 未判定」，不把免费额度
  渲染成套餐名。
  **仍未验证（拿到账号后请先复验）**：
  - 免费额度账号在配额接口上究竟返回什么形状——是 403 + 业务码（当前按「已知套餐类业务码」
    与「裸 401/403」两支分别处理），还是能读出一份带窗口的快照。**没有一份实机样本**；
  - 「凭据无效」与「没有付费套餐」在上游是否**一定**可区分。当前只认三个鉴权类业务码
    （1000 / 1001 / 1003）为凭据无效；分不出时按 `unknown` **放行**——因为额度耗尽的 429
    可恢复，而误拒一个有效账号不可恢复（用户再也登不进这条线路，且无从自查）；
  - 免费额度是否真的能服务模型面（配额接口答得了不代表模型接口答得了），以及它耗尽时的
    确切错误码与重置节奏；
  - 「闲时任务」类免费算力（welcome 页所述）本线路**未接入**，它属于另一条调度路径。
- **上游没有 refresh_token 交换接口。** 官方客户端对刷新直接抛「OAuth 暂未提供 refresh token 交换接口，请重新登录」。因此 `access_token` 过期**只能重新登录**；插件能自动重取的只有业务 JWT 这一层（提前 120 秒 + 0~60 秒抖动防尖峰），而且**它只服务国际区**。账号行上的「重新登录」在 host 这一侧只做两件事：撤掉鉴权失败标记与冷却，让这一行重新参与轮转；真正的登录要由卡片再开一次流程。
- **客户端签名层（Client Signing V4）已从本线路删除——不是默认关闭，也没有可显式打开的开关。** 生产路径上不再有任何签名接线、能力门控或环境变量入口，一个逆向来的签名算法连同它自己那份故障面一起被移除。删它的理由是它**从未有过能支撑上线的证据**：唯一有实测记录的项目做过 A/B 对照，**带签名与不带签名的响应归一化后完全一致**（都是 429/1113），从未观察到服务端因为缺签名而拒绝请求；而官方那个本可当作开关信号的 feature gate 端点 `/api/v1/agent/configs` **根本不校验凭据**——两类凭据拿到逐字相同的响应，所以它答不了「签名是否启用」，拿它当证据等于把一份不区分凭据的响应读成了区分。留下这条限制是为了同时记着**没被证明的那一半**：服务端是否真会因为缺签名返回签名错误，**至今从未被观察到**——这不是「已验证不需要签名」，而是「从未验证过」，两者的区别不因为实现被删掉而消失。
- **资源包 / 充值余额与套餐额度互不消耗，本线路两边都碰不到用户充的钱。** 官方文档 zcode.z.ai/cn/docs/configuration 把资源包写成**与 Coding Plan 并列的另一个入口**：一节标题就是『资源包 / 充值余额』，正文『使用开放平台模型资源包或充值余额等通用 API 场景，填写 OpenAI 接口地址即可』，给的地址是通用面 `https://open.bigmodel.cn/api/paas/v4`（国际区 `https://api.z.ai/api/paas/v4`）。同一页逐字：『Anthropic 接口不适用于资源包 / 余额场景：只有从未购买过 Coding Plan 的账号，走 Anthropic 接口时才会消耗余额；只要买过套餐（无论是否用完、是否到期），该接口都不会走余额，需要额外加白处理』；『Coding 端点仅限 Coding 场景，与通用端点不可互相替代，也不会互相消耗额度』。因此本线路的模型面（Anthropic）与套餐面在结构上就不触及资源包：**资源包的入口是上面那个通用面，凭据是开放平台的 API Key**——官方在这一节的措辞是「API Key 模式」，与「编程套餐」授权绑定账号的**非 API Key 模式**相对，**不是本线路换出来的那把 Coding Plan Key，本线路根本不接这类 Key**。用户在这条线路上**不会**误烧充值余额；要确实用资源包，请走 DSH 自带的「自定义模型 API」，那是另一个面、另一把 Key。
- **免费体验额度的逐模型构成与时限（只补上一条已有条目没写的两项，不重复它）。** 上一条只写了体验额度存在，没写它由哪几个模型、各多少、什么时候失效。官方配置页（逐字：zcode.z.ai/cn/docs/configuration）：『每日体验额度由两类模型额度组成…… GLM-5.3 300 万 token / 日；GLM-5.3-Flash 500 万 token / 日』；『注意：体验额度仅限 5 天。每日额度只在这 5 天内发放，体验期结束后即失效，并非长期每天都有』。两者相加正好是那句「每天 800 万 token」——但**这是两个模型各自的份额，不是所有 GLM 模型共享的一口池子**，也只有 GLM-5.3 / GLM-5.3-Flash 沾得到；体验期一过额度**不再补发**，卡片上「免费体验额度」那一档不能读成长期权益。**仍未验证（拿到账号后请先复验）**：这两个日额度用尽后服务端返回的确切业务码、以及每日重置发生在什么钟点，仍没有实机样本。
- **与官方路径的形态差异：本线路直连 `api.z.ai/api/anthropic`，官方客户端却在 fetch 层把同一个 URL 重写到托管网关。** 官方开源仓库 `zai-org/ZCode` 的 `apps/zcode-cli/packages/adapters/src/model/official-coding-plan-gateway.ts` 里，`GATEWAY_PATH_BY_ENDPOINT` 把 `'https://api.z.ai:443/api/anthropic/v1/messages'` 映射到 `'/api/v1/ultra-zai/anthropic/v1/messages'`、把 `'https://open.bigmodel.cn:443/api/anthropic/v1/messages'` 映射到 `'/api/v1/ultra/anthropic/v1/messages'`。也就是说官方那一侧**不打这个基址**，而是在 fetch 层改写到 `/api/v1/ultra*` 网关前缀下；本线路照抄的是前一个形状。这记为**观察项而不是缺陷**：两个独立的第三方实现直连该基址都成功过（能拿到 1113 业务码恰恰说明认证这一关已经过了），而网关前缀是官方托管面自己的编排，本线路不复刻它、也不需要它。**仍未验证**：托管网关是否会在某些请求特征上施加通用面没有的额外策略。
- **国区兑换链未验证。** 证据来自三个社区实现（等级 B，逆向实测而非官方契约），三者**都以国际区为主**，国区业务面的形状是否同构没有实测样本。国区兑换失败会带上明确说明与下一步建议（改用国际区，或用 `DSH_GLM_CN_BUSINESS_HOST` 等环境变量指向实测过的部署），**不静默失败**。同理，国区配额到底打 `bigmodel.cn` 还是官方文档里那句「亦可用 `open.bigmodel.cn`」也没有实测，本插件取 `bigmodel.cn`。
- **兑换链的所有端点都可用 `DSH_GLM_*` 环境变量覆盖**（两区的业务 host、模型面 host、授权入口、appId / client_id、Key 名、OAuth 控制面基址）。这是为等级 B 的兑换链准备的退路：上游一次变更让整条链失效时，回滚是改一个环境变量，而不是发一个版本。

## Step Code（Step Plan 订阅）线路

`step-code`（显示名 **Step Code（Step Plan 订阅）**）接入 **StepFun 的 Step Plan 订阅**（国区 `api.stepfun.com` / 国际区 `api.stepfun.ai`）以及开放平台 API Key。国区与国际区是**两套互不通用**的部署：`api.stepfun.ai` 的凭据打国区端点会被上游直接拒绝。因此**区域是凭据的属性而不是请求的属性**，它由凭据里的 `profile` 唯一决定，号池里可以同时持有两区账号且互不串用。

> ⚠️ **额度接口是非公开接口，这是本线路唯一的合规与稳定性风险点。** 用量与配额读的不是公开 API：先用开放平台**账号密码**换取一个 `Oasis-Token`，再用它读 Dashboard（见下）。上游随时可以改它的形状、改它的鉴权方式或直接关掉它。本插件的处置是把它彻底隔离成**一个只读、失败永不阻断**的面——额度读不出来时卡片照旧渲染、模型请求一个字节都不受影响。反过来说，**不要把额度数字当成有 SLA 的承诺**：它是尽力而为的读数，不是账单。而且它需要你额外交出一次开放平台账号密码，这件事本身就是把订阅账号的登录权交给了另一条链路。

**登录**（四条路，任选其一，互不替代）：

1. **云端轮询的浏览器授权**（订阅账号）：本线路**不开本地回调端口**，流程跑在 host 上，你在浏览器里人工确认，卡片每 2 秒轮询一次进度。授权页地址始终显示在卡片上——即使 host 打开浏览器失败，你也能自己复制打开；
2. **手工粘贴 Platform API Key**（对应两个 `platform_*` 凭据类型，按量计费）：没有浏览器、或不想走授权时用它。这条兜底通道**常驻在页面上**（收起态只是一个开关），因为它是浏览器打不开时唯一能完成登录的地方；
3. **只读导入本机 `stepcode` 登录态**（可选）：读 `~/.stepcode/auth.json`（**只读**，从不创建、修改或删除 stepcode 的任何文件）。四种失败各有各的下一步（没文件 / 读坏了 / 形状不认识 / 里面不是 Step 的登录态），**失败永不阻断**，一律回落上面两条路；
4. **额度凭据**（与上面三条都独立）：开放平台账号密码或手工粘贴的 `Oasis-Token`，**只**用于读额度，不参与模型请求。密码与 Token 只在你点击提交的那一刻随请求体交给 host：不写入本地存储、不进 URL、不写日志，也**没有任何接口能把它们读回来**。

**能力**：OpenAI Chat Completions；模型目录**完全靠运行时发现**，随包表**刻意为空**。卡片上每行模型的一句话描述、是否收图片、接受哪些思考档位、上下文窗口，全部来自上游目录字段，**拿不到证据时按兜底值显示而不是猜**（本线路明确禁止从模型名推断能力）。档位在本地先收敛到**模型真实梯子**（`reasoning_effort_support_list`）上再发出去，所以设置里列出 DSH 的完整档位词汇也不会给只认两档的模型发错档。区域交叉的凭据会被上游拒绝，所以卡片不给自由输入——四个 profile 取值与官方逐字相同。

**缓存**：Step 服务端是**自动前缀缓存**（前缀够了就命中），客户端既没有缓存参数也没有「写入」这个动作。因此本线路：(1) **只展示读侧一个维度**（读入 token、未命中输入、命中率、样本请求数）；(2) **写侧恒为 0 并被显式标注**（`always-zero-on-this-route`），不画一条永远是 0 的进度条——把线路事实渲染成故障比不画更糟；(3) **整页不出现任何金额**：官方模型表里四个 cost 键全是 0（单价未文档化），拿 0 当单价算出「省了 0 元」是正确但无用，拿编的费率算出「省了 N 元」是撒谎。(4) 「在请求里发送缓存参数」是一个**默认关闭**的能力位，因为它会让请求带上 Step 文档里没有说明过的字段（官方对 Step 端点也是不发的）。

**已知限制**：

- **实机验证到什么程度（如实分档，不打包成一句「已验证」）**：
  - **已用真实账号 live 验证**：① 云端轮询浏览器授权开流与轮询；② **开放平台账号密码换取 `Oasis-Token`**（`RegisterDevice` → `SignInByPassword`）；③ 用该 token 读 **`QueryStepPlanRateLimit` 与 `GetStepPlanStatus`**（返回真实套餐 `Plus`、`plan_family=2`、Credit 桶总额与剩余）；④ 模型目录字段与档位回落按实测载荷对齐。
  - **仅 mock 验收**：模型面的真实对话请求、手工粘贴 Platform API Key 走通完整会话、`adopt` 的四种失败分支、以及额度卡片在真实载荷下的渲染（形状取自实测响应，但渲染本身是单测覆盖）。
  - 因此这一节不是免责套话：**列出的分档就是上线时的实际置信度**，读的人可以据此判断哪一块需要自己再试一次；
- **额度读的是非公开的开发者中心接口**（见开头的风险提示）。两代套餐同时在用（老式 5 小时 / 周窗口，与 Credit 月池），判定**按载荷形状**（老式窗口字段 vs `credit_buckets`）而不是只信 `plan_family`；两端都认不出来时只显示「认不出」，**一个进度条都不画**；
- **没有 refresh_token 交换链**。access token 过期只能重新走登录；账号行上的「重新登录」在 host 侧只解除鉴权失败标记与冷却，真正重登要由卡片再开一次流程；
- **上下文窗口的输出上限是推导值**。端点不报输出上限，所以默认等于上下文窗口——这是一个诚实的兜底，不是一份上游声明；
- **品牌标记取自官方站点资产**，不是本地画的占位图形：形状逐字转录 `platform.stepfun.com/favicon.svg`，底砖色用该文件里的 `#1d1d1d`。抓取日期与字节数记在 `brand-icons.tsx` 的注释里，便于日后核对；

### 插件路由（Step Code）
所有路由都以 `/step-code/api` 为前缀：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/status` | 凭据类型与区域、号池、模型目录、额度快照、缓存统计与登录流程；页面唯一的读口 |
| POST | `/settings` | 启用开关、勾选模型、上下文窗口覆盖、默认思考档位、手选账号、缓存参数能力位 |
| POST | `/accounts` | 号池动作：`set-primary` / `clear-cooldown` / `delete` / `relogin` / `strategy` |
| POST | `/login/start` | 按 profile 开一次云端轮询登录流，立即返回流程状态（不阻塞、不开本地回调端口） |
| GET | `/login/status` | 轮询登录流程状态；**只有这一条 GET 会推进状态机**，关掉设置页之后就不会继续打上游 |
| POST | `/login/cancel` | 取消登录流程 |
| POST | `/login/manual` | 手工粘贴 Platform API Key（**请求体必然带凭据，刻意不在冻结契约里声明**） |
| POST | `/adopt` | 只读导入本机 stepcode 登录态；失败**永不阻断**，每种失败都是契约里的一个 reason，卡片据此回落 |
| POST | `/connection/test` | 沿模型面做一次探测（**裸 DTO，不走信封**）；它答「这个账号能不能发请求」，答不了「这个具体模型会不会成功」 |
| POST | `/quota` | 强制刷新额度；一次失败的额度读不是一次失败的请求，卡片照旧渲染 |
| POST | `/catalog/refresh` | 强制刷新模型目录 |
| POST | `/quota/credential` | `mode: 'password' | 'manual' | 'clear'`。**非公开的开发者中心接口**；凭据只在提交时的请求体里过一趟，永远不回读 |

与其它线路一样，所有修改状态的路由只接受同源 JSON POST 并校验 `Origin` 与 `Host`。**响应里永远不含 api_key、`Oasis-Token` 或账号密码的原文**——下发的只有「有没有凭据、从哪来、大概什么时候过期、上次读它出了什么问题」。

## Qoder（订阅）线路

\`qoder\`（显示名 **Qoder（订阅）**）接入 **Qoder 订阅**（全球区 \`qoder.com\` / 中国站 \`qoder.com.cn\`）。两个区域是**两套互不通用**的部署：一个区铸造的凭据打另一个区的端点会被上游直接拒绝。因此**区域是凭据的属性而不是请求的属性**，号池里可以同时持有两区账号且互不串用。

> ⚠️ **这条线路的协议面是逆向工程成果，不是官方公开契约，这是本线路唯一的合规与稳定性风险点。** COSY 签名、body codec、额度端点都来自开源实现（[pi-provider-qoder](https://github.com/simonsmh/pi-provider-qoder)，live 验证）与 [qodercli2api](https://github.com/Liki4/qodercli2api) 对官方 Qoder CLI v1.1.34 的全合成 frozen fixtures——本插件把每一步**逐字节**锁在测试里（\`test/fixtures/qoder/\` vendored），但上游随时可能改协议或收紧风控。额度端点（\`/api/v2/quota/usage\`）更是**非公开的个人接口**：它的失败绝不影响模型请求，卡片把它画成尽力而为的读数，不是账单。COSY 版本跟随官方 CLI 的 release feed（落后会拿到**缩减的**模型目录），拉取失败回落随包版本。

**登录**（三条路，任选其一，互不替代）：

1. **浏览器设备流**（仅全球区）：本线路**不开本地回调端口**，流程跑在 host 上，你在浏览器里人工确认，卡片每 2 秒跟随一次进度。授权页地址始终显示在卡片上——host 不自行开浏览器，即使自动打开失败你也能自己复制打开；
2. **手工粘贴 PAT**（两区都支持）：在账号的 Integrations 页生成一个 Personal Access Token（\`pt-...\`）粘贴进来。它先被兑换成短期 job token（\`jt-...\`）使用；**PAT 本体只存在 host 的加密存储里**，用途只有一个：过期后重新兑换；
3. **只读导入本机 \`qodercli\` 登录态**（可选）：读 \`~/.qoder/.auth/user\`（AES-128-CBC 信封，key 是 \`machine_id\` 前 16 个字符——格式逐字来自协议文档，且有 frozen fixture 锁定）。**只读**，从不创建、修改或删除 qodercli 的任何文件。文件不记录区域，所以导入时对两区的 userinfo 各探一次（只读 GET），哪区认账就是哪区；两区都不认（token 已过期/被撤销）就如实告知，**不替你猜一个必然 401 的区域**。

**凭据会过期、可刷新**（与 step-code 的静态凭据相反）：号池在 \`expiresAt - 1 小时\` 前自动续期——PAT 来源拿存下的 PAT 重兑换，其余走 \`refresh_token\` 轮换（轮换的新对先落盘再使用）。刷新被上游判 401/403 时账号标记为失效并提示重新登录；网络/5xx 只算瞬时失败，不会误登出。

**能力**：Qoder 自有对话面（OpenAI 形状的消息数组包在 \`RemoteChatAsk\` 信封里，过自定义 body codec，COSY 头签名，应答是信封 SSE）。模型目录**运行时发现**（COSY 签名的 \`GET /algo/api/v2/model/list?Encode=1\`）+ 随包能力兜底表；能力（上下文窗口 / 图片输入 / 思考档位）全部来自目录字段（\`context_config\` / \`is_vl\` / \`thinking_config\`），**不从模型名推断**，目录里那个 \`max_input_tokens\` 陈旧地板值明确不信。档位在本地先收敛到**模型真实梯子**再发出去；toggle 形态的模型只发开关。输出上限取上游文档化的 128K（目录不报输出上限）。


**模型行**：勾选行下面一行写清能力——上下文窗口、是否收图、思考档位、输出预算（例：`1M · text+image · 档位 low/high · 输出 131k`），全部取自目录字段（`context_config` / `is_vl` / `thinking_config`）与随包兜底表的逐模型事实，客户端不按模型名推断。

**缓存与用量**：响应 usage 里读缓存命中（\`prompt_tokens_details.cached_tokens\`，顶层 \`cached_tokens\` 兜底），缓存写入读 \`cache_write_tokens\`（上游不报就是 0，不做「恒零」声明）。**整页不出现任何金额**：订阅没有公开的 token 单价，Credits 与金额之间没有官方汇率——只显示 token 与 Credits 数字。

**已知限制**：

- **未用真实账号联调**：全部验收来自 mock + frozen fixtures（\`docs/qoder-line-plan.md\` §9 是联调清单与逐项风险）。上线时的实际置信度就是这句话，不打包成「已验证」；
- **中国站没有设备流**：它只接受 PAT 粘贴或导入本机 qodercli 登录态（卡片在选中国站时不显示浏览器登录按钮，host 侧同样拒绝）；
- **额度端点是非公开个人接口**（见开头的风险提示）；三只桶分开渲染，缺桶不画，没有总额的桶不参与任何百分比；
- **品牌标记是 monogram**：官方 favicon 是一枚 73KB 的复合字形，不适合内联转录；卡片用字母 Q，底砖与字形色的取值都取自官方站点资产（出处记在 \`brand-icons.tsx\` 注释里）；
- **\`chat_context\` 按官方 fixture 发最小形态** \`{}\`：若实测发现模型路由异常，对照 pi-provider 的 \`extra.modelConfig\` 补上（计划 §9 风险 10）。

### 插件路由（Qoder）

所有路由都以 \`/qoder/api\` 为前缀：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | \`/status\` | 区域、号池、模型目录、额度快照、缓存统计与登录流程；页面唯一的读口 |
| POST | \`/settings\` | 启用开关、勾选模型、上下文窗口覆盖、默认思考档位、手选账号 |
| POST | \`/accounts\` | 号池动作：\`set-primary\` / \`clear-cooldown\` / \`delete\` / \`relogin\` / \`strategy\` |
| POST | \`/login/start\` | 开一次设备流登录（仅全球区），立即返回流程状态（不阻塞、不开本地回调端口、host 不自行开浏览器） |
| GET | \`/login/status\` | 轮询登录流程状态；host 在后台轮询上游 |
| POST | \`/login/cancel\` | 取消登录流程 |
| POST | \`/login/manual\` | 手工粘贴 PAT（**请求体必然带凭据，刻意不在冻结契约里声明**） |
| POST | \`/adopt\` | 只读导入本机 qodercli 登录态；失败**永不阻断**，每种失败都是契约里的一个 reason |
| POST | \`/connection/test\` | 对目录端点做一次 COSY 签名的探测（**裸 DTO，不走信封**）；它答「这个账号能不能读目录」，答不了「这个具体模型会不会成功」 |
| POST | \`/quota\` | 强制刷新额度；一次失败的额度读不是一次失败的请求，卡片照旧渲染 |
| POST | \`/catalog/refresh\` | 强制刷新模型目录 |

与其它线路一样，所有修改状态的路由只接受同源 JSON POST 并校验 \`Origin\` 与 \`Host\`。**响应里永远不含 job token、PAT 或刷新令牌的原文**——下发的只有「有没有凭据、从哪来、大概什么时候过期」。

## Cline Pass（OAuth 订阅）线路

`cline-pass`（显示名 **Cline Pass**）接入 [Cline Pass](https://cline.bot/cline-pass)。与其它订阅线路一样，它**用 OAuth 登录**：Cline 账号走 **WorkOS 设备码授权**（RFC 8628 形态），浏览器确认后账号自动加入号池；聊天请求携带 `Authorization: Bearer workos:<accessToken>`，access token 到期前用轮换的 refresh token 自动续期。静态 API Key 仍保留为**兼容回退**（旧 `dsh-cline-pass` 用户或某些部署），但不再是默认入口。

设备码流程的四个上游调用与常量来自 Cline 官方开源仓库，不是猜的：

- `POST https://api.workos.com/user_management/authorize/device`（client id `client_01K3A541FN8TA3EPPHTD2325AR`）；
- 浏览器确认后轮询 `POST https://api.workos.com/user_management/authenticate`；
- `POST https://api.cline.bot/api/v1/auth/register` 换取 Cline 会话；
- `POST https://api.cline.bot/api/v1/auth/refresh` 续期。

对应源码：Cline 仓库 `sdk/packages/core/src/auth/cline.ts`、`auth/provider-auth-registry.ts`（`workos:` 前缀）、`sdk/packages/shared/src/runtime/cline-environment.ts`（client id 与端点）、`sdk/packages/llms/src/providers/vendors/cline.ts`（Bearer 发送）。抓取日期 2026-10-20。

**能力**

- OpenAI Chat Completions 协议，流式输出；透传工具 schema、工具调用/结果，图片按 `image_url` 内联，`reasoning_effort` 原样下发；支持 `temperature`、`stop` 与 `max_tokens`；
- 模型目录：随包 15 个 Cline Pass 模型是**兜底**。点「刷新模型目录」会读官方 `/ai/cline/recommended-models`、models.dev 与上游网关目录，只增不减，并把每个模型的能力（上下文窗口、输出上限、图片、推理档位）一起补上；新发布、本版本不认识的模型按保守值录取，不会被隐藏；
- **上游渠道可观测、可钉住**：同一模型可能由 OpenRouter（direct 管线）或 Vercel AI Gateway（planner 管线）转发。卡片可以对单个模型「探测」渠道、逐个「校验」、按顺序钉住或排除，并在**首个 token 之前**失败切换到下一个渠道；`strict` 只发允许列表，`preferred` 按顺序尝试。钉住字段默认**两种写法都写**（`provider.only/order/sort` 与 `providerOptions.gateway.*`），因为网关可以在两次请求之间换管线，只写一种会让钉住悄悄失效；
- **钉住是否被采纳以响应为准**：网关对未知/不可用的 `only` 不报错，直接从别的渠道服务。因此探测、校验与真实请求都会回读响应里的实际服务渠道；「请求 baseten、实际 deepseek」会被明确标成未被采纳，而不是当成成功；
- **登录态**：设备码确认后账号自动入池；access token 以 `workos:` 前缀发送，到期前 5 分钟自动 refresh（refresh token 轮换并先落盘再使用）；refresh 被上游判 `invalid_grant` 时账号标记为失效并提示重新登录，网络/5xx 只算瞬时失败，不会误登出；
- **号池**：多账号（OAuth）或 API Key、顺序/轮询/粘性三种调度、429 冷却、401/403 标记失效后换号；额度耗尽（`QUOTA`）与鉴权失败是**账号级**失败，会换账号；普通 429 是**渠道级**，只换渠道，不牺牲账号容量；
- **额度**：`GET /users/me/plan/usage-limits` 的 `five_hour` / `weekly` / `monthly` 三个窗口，**按账号**读取并显示；读取失败只报原因，不阻断请求；
- **请求历史**：记录模型、账号、实际服务渠道、首 token / 总耗时、token 用量、错误与失败尝试链；只在进程内存里，重启清空；
- **管理工具**：`cline_pass_status` / `models` / `probe` / `validate` / `test` / `pin` / `accounts` / `history` 八个工具，**默认不注册**——它们的 schema 会出现在每次请求的工具列表里，而大多数对话不需要它们。在卡片「高级设置」里勾选后，**重启 DSH** 生效；Provider 与设置卡本身不受影响。

**设置页路由**（前缀 `/cline-pass/api`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/status` | 号池、登录流程、模型与渠道观测、额度快照、历史条数、行级设置；页面唯一的读口 |
| POST | `/login/start` | 申请 WorkOS 设备码，返回短码与授权链接（不打开浏览器） |
| GET | `/login/status?id=` | 轮询设备码；host 按 WorkOS 的 interval 节流，成功时完成 `auth/register` 并把账号入池 |
| POST | `/login/cancel` | 放弃当前设备码；之后即使浏览器确认也不会落盘 |
| POST | `/settings` | 启用开关、默认网关、默认上下文/输出预算、每账号并发、流空闲超时、历史条数、目录/工具开关、钉住写法 |
| GET/POST | `/accounts` | 号池动作：`add` / `test` / `set-primary` / `set-alias` / `delete` / `clear-cooldown` / `strategy` |
| GET/POST | `/models` | 模型勾选（`enabledModelIds`，`null` = 全选）与线路启用 |
| POST | `/models/pin`、`/models/reset` | 保存/清除单个模型的渠道钉住 |
| POST | `/models/probe`、`/models/validate`、`/models/test` | 探测渠道、逐渠道校验、按当前钉住发一次真实小请求 |
| POST | `/models/visibility`、`/models/visibility-all` | 单个或批量显示/隐藏模型 |
| POST | `/models/context-window` | 单个模型的上下文窗口覆盖（`null` 恢复默认） |
| POST | `/catalog/refresh` | 重新扫描官方订阅目录 |
| GET/POST | `/usage` | 读缓存 / 强制为每个可用账号读一次官方额度 |
| GET | `/history` | 进程内请求历史（`limit`、`model` 过滤） |

OAuth 是默认入口；「使用 API Key」按钮保留为兼容回退，部署也可以用 `CLINE_PASS_API_KEY` 提供第一把 Key：号池为空时它会被投射为「首要账号」，无需先粘贴（环境变量不会被写入凭据库）。**从 `dsh-cline-pass` 迁移时不会自动导入旧插件的设置与凭据引用**——OAuth 账号重新登录一次即可，静态 Key 需要在卡片里重新添加；两个插件不要同时启用，否则会争抢同一个 `cline-pass` 路由（本卡会明确显示占用方）。

所有修改状态的路由只接受同源 JSON POST 并校验 `Origin` 与 `Host`。**响应里永远不含 access token、refresh token 或 API Key 原文**：下发的只有账号 id、别名、`authKind`、冷却/失效状态与错误原因；OAuth 会话与 Key 都存在操作系统的加密凭据库（Windows DPAPI / macOS Keychain / Linux Secret Service）里。登录流程的 DTO 同样是逐字段投影，而不是展开整个会话对象。

**已知边界与风险**

- **本线路来自 `dsh-cline-pass` 的功能移植**，网关的渠道探测/钉住/故障转移语义沿用该插件（MIT）与 `cline-pass-switcher`（MIT）的公开实现；OAuth 链路的端点、client id 与 `workos:` 前缀转录自 Cline 官方开源仓库（见上）。网关与 WorkOS 都不是公开契约：渠道名、`provider.only` 是否被采纳、错误措辞、设备码策略都可能变化；本线路的策略是**读回真实渠道并如实报告**，不把一次 200 当成钉住成功的证据。
- **没有实时订阅账号的验收记录**：本版本的准确度上限是「协议与映射按线上抓取/上游实现对齐 + mock 全绿」。设备码登录的四个请求与 refresh 链都有 mock 覆盖，但**尚未用一个真实 Cline 账号走完浏览器确认**；首次实机请先完成一次登录，再对目标模型点「探测」与「测试」。
- **两个管线对渠道名的拼写不同**（例如 Z.AI 在 planner 侧是 `zai`、direct 侧是 `z-ai`），本线路按管线翻译；即便如此，**未知渠道不会让请求失败，只会被网关静默忽略**，所以「保存了钉住」不等于「钉住生效」。
- **Host → 网关的 TLS/connect 失败与钉住无关**：请求体（含 `provider.only`）还没发出，网关也就没有机会选择上游。这类失败会先自动重试 2 次（仅限"请求未发出"的握手/连接错误），仍失败时错误文案会明确说明"未到达网关、钉住未生效"。如果反复出现，通常是本机到 `api.cline.bot` 的网络/代理/TUN 问题：在 ChatGPT 线路的代理设置里改用显式代理，或在 `$DSH_HOME/.env` 写 `HTTPS_PROXY=http://127.0.0.1:7897`（本机 Clash 端口）后再试。
- **额度窗口是网关的读数，不是账单**；接口失败时卡片保留上一次读数并显示原因，不编造 0。
- **模型目录随订阅变化**：随包表只覆盖发布时的模型；刷新失败不会清空已有目录，新模型按保守能力录取。

### 插件路由（Cline Pass）

见上表；与其它线路一样，路由表在 `src/host/cline-pass/routes.ts` 与客户端 `api.ts` 各有一份手写副本，集成结束时逐条对照。设置卡在「设置 → 订阅服务 → Cline Pass」，对话输入框右侧有该线路的额度胶囊（显示当前已读账号中最紧张的窗口）。

## OpenDesign（订阅，API Key / 浏览器授权）线路

`opendesign`（显示名 **OpenDesign**）接入 [OpenDesign](https://open-design.ai/) 订阅（开源项目 [nexu-io/open-design](https://github.com/nexu-io/open-design)）。OpenDesign 的付费计划（Go / Plus / Pro / Max）含模型额度，官方明确支持第三方 Agent 使用其 API，并点名支持 Codex、Claude Code、**DSH**、OpenCode 等客户端。

**登录有两条路，共用同一个号池**：

1. **浏览器授权（推荐）** — 点「登录 OpenDesign 账号」，宿主向 `POST /api/v1/cli/device-authorizations` 申请一次设备授权并给出激活地址与授权代码；在浏览器确认后，查询接口 `POST /api/v1/cli/device-authorizations/{deviceId}/token` 会返回一对 Key：`vela_ctrl_…` 控制 Key 与 `sk-amr-…` 运行时 Key，外加账号身份（邮箱 / 名称 / 套餐）。运行时 Key 走对话，控制 Key 读钱包余额与账单摘要（套餐档位、credits、周期）。签发的 Key 不过期，失效只能重新登录；**宿主自身不打开浏览器**，由卡片 `window.open` 打开激活页（与本插件其它线路同一条规则）。
2. **粘贴 API Key（回退）** — 在 Cloud 控制台（工作区 → API Keys）创建后粘贴，仅用于对话（没有控制 Key，因此读不了余额与套餐额度）。

号池支持多账号轮换；部署也可以用 `OPENDESIGN_API_KEY` 提供第一把 Key（号池为空时投射为首要账号，不写入凭据库）。

**能力**：OpenAI Chat Completions 流式对话（官方给 DeepSeek Harness 推荐的正是这个协议形态），工具调用、图片输入、推理档位透传。网关是 `https://amr-link.open-design.ai/v1`，Bearer 鉴权。

**模型目录**：随包内置 37 个聊天模型，每个都带 id、显示名、美元单价，以及**上下文窗口、最大输出、输入模态（是否收图）与推理档位**——价目来自官方公开价目接口，能力字段转录自本仓库已核对过的同族模型表（command-code 官方注册表、cline-pass、Claude 与 Antigravity 目录；两处冲突以 cline-pass 为准）。登录成功或添加 Key 后自动同步实时目录：**浏览器授权账号（带控制 Key）还会读 AMR 控制面目录**，那里有上游真实的 `metadata.contextWindowTokens`，会覆盖随包表；网关自己的 `/v1/models` 提供该 Key 实际可见的模型清单。同步条目持久化在设置文档里，重启无需网络即可恢复。**`minimax-m3.1-flash` 与 `muse-wonder` 没有任何同族表可核对**，按 128k / 默认三档处理并在文档里列名，不猜数字；任何模型都能在卡片的「上下文窗口」里按模型修正，覆盖值优先于以上全部来源。

**套餐与额度**：只有浏览器授权登录的账号带控制 Key，因此只有它们能读套餐与额度——`GET /api/v1/wallet/balance` 给当前余额（`balanceUsd` 字符串），`GET /api/v1/billing/summary` 给真正的档位（`membershipTier`：Go / Plus / Pro / Max）、订阅状态与本周期，以及订阅 / 充值 / 合计 credits 和已消耗美元。**档位不读登录应答里的 `user.plan`**：上游对已订阅账号也返回 `free`，且登录后不再更新。设置页打开时会自动读一次；「套餐与额度」区块按账号列出档位、状态、周期、credits 与消耗，账号行显示真实档位（例如 `Go · 生效中`）。钱包读取被拒时用账单的合计金额兜底，两个面互不掩盖；粘贴的 API Key 没有控制 Key，卡片会说明并建议去控制台查看。对话输入框右侧的胶囊仍显示主账号余额；读不到时显示原因而不是 0。**本线路不画百分比额度条**——摘要给的是剩余而不是可对照的配额上限，编一个分母就是编数据。

### 插件路由（OpenDesign）

所有路由都以 `/opendesign/api` 为前缀：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/status` | 卡片状态：开关、号池、模型、目录同步、余额与额度读数、登录流程 |
| POST | `/settings` | 线路开关与高级设置（网关地址、默认窗口、并发、空闲超时） |
| GET\|POST | `/accounts` | 账号增删、主账号、别名、轮换策略、Key 测试（用免费的目录读取验证，不花额度） |
| POST | `/login/start` | 申请设备授权，应答激活地址与授权代码（不含 deviceSecret） |
| GET | `/login/status?id=` | 轮询一次登录流程（宿主按服务给出的间隔节流） |
| POST | `/login/cancel` | 取消登录；迟到的确认不会落号 |
| GET\|POST | `/models` | 模型勾选（三态：不筛选 / 显式清单 / 全不选） |
| POST | `/models/visibility`、`/models/visibility-all` | 单个/批量隐藏 |
| POST | `/models/context-window` | 单模型上下文窗口覆盖 |
| POST | `/catalog/refresh` | 用号池里可用的 Key 同步实时目录；目录真的变了才通知模型选择器重建 |
| GET\|POST | `/usage` | 读取每个 OAuth 账号的钱包余额、账单摘要（套餐、credits、周期）与 **Design Plan 额度窗口**（5 小时 / 7 天，各自的 limit 与剩余；工作区 id 每个请求只解析一次）；三路相互独立，失败作为数据显示，绝不标记账号 |

协议事实与未验证项的完整证据记录见 `docs/opendesign-line-plan.md`：设备授权的创建与轮询响应是**实测**的，批准后的字段名来自上游 issue #8870；钱包与账单摘要在真实订阅账号上实测过，对话链路仍未与真实 Key 联调。**额度窗口**走控制台自己的 `GET /api/v1/workspaces/{workspaceId}/billing/coding-plan-usage`（带 `x-vela-workspace-id`）。**实测结论（2026-10-22，真实 Go 账号）**：该端点只认控制台会话，插件持有的三种凭据形状——`Bearer vela_ctrl_…`、`Bearer sk-amr-…`、`x-api-key: sk-amr-…`——**全部 401**；工作区 id 本身能正常解析，所以不是地址问题。因此设置页显示「额度窗口仅在 OpenDesign 控制台可见」，看板卡只写一句原因、绝不画 0% 的条；读取逻辑保留，上游哪天放开 key 就会自动生效。

## 本机登录

**每条线路只在自己的详情页里回答关于本机的问题**。ChatGPT（Codex）线路的 ChatGPT 卡片里，「登录」按钮**旁边**就是「导入本机 Codex CLI 登录」——与 Claude 页面上那个收编按钮同样的位置、同样的次要样式；点它可以省掉再走一次 ChatGPT 授权。Claude Code 与 MiniMax Code 各自的设置页里本来就各有一个导入入口，不在这里重复。

### 只看文件在不在，从不读令牌

打开 ChatGPT 卡片时，宿主用一次 `stat` 回答这件事，**没有任何文件被打开读取**：

| 线路 | 查过的路径 | 导入入口在哪 |
| --- | --- | --- |
| Codex CLI | `$CODEX_HOME/auth.json`，未设置该变量时为 `~/.codex/auth.json` | ChatGPT 卡片账号池里「登录」旁边的那个按钮 |
| Claude Code | `~/.claude/.credentials.json`（目录可用 `CLAUDE_CONFIG_DIR` 改，见「Claude（订阅）线路」） | Claude 线路自己的设置页 |
| MiniMax Code | `~/.minimax/auth/<buildEnv>/<region>/mcode-public/auth.json`，国区与国际区各一（见「MiniMax Code（编程订阅）线路」） | 不需要按钮：它的令牌库直接采用本机那份凭据 |

- **为什么不放在总览页**：总览页上一块跨线路的扫描，替别的线路回答问题，最后只能写一句「该供应商在自己的设置页里已有导入入口，请到那里导入」——而用户就在离那一页一步之遥的地方，那句话既答错了地方，本身也自相矛盾。信号归各自的线路，位置也就归各自的线路。
- **Kimi Code 不在这里**：本机 Kimi Code 的凭据文件**不带**本插件需要的区域、`oauthHost` 与 `baseUrl`，而插件**拒绝猜**这三个值，因此既不扫描也不显示——那一行若是显示成「未检测到」，看起来就像装个插件就能收编。

理由不是谨慎，而是这一块的位置：它要渲染的是一份**邀请**（一个可以点的按钮），而此时你还没有同意任何事。一个会读文件的扫描器会让后面那个 opt-in 变成装饰，同时为一页只需要「有 / 没有」的信息在内存里握着别家订阅的令牌。所以这一块**不显示**任何账号、套餐、邮箱或到期时间：这些答案要导入之后才存在，导入前显示它们等于提前读取。

因此**「已检测到」只表示那个文件在**，不表示它可用——判断可用必须读取文件，而那是 opt-in 之后的事。文件在却形状不认识时（不是 JSON、`auth_mode` 不是 `chatgpt`、`tokens` 不是对象、缺 access 或 refresh token、access token 不是一个带可用 `exp` 的 JWT），导入会明确报出「格式无法识别」而不是抛错或静默成功，也不会把默认值当成事实；邮箱与套餐则来自 id token 自己的声明，没有就不填。查过的路径**两种状态都写出来**，包括没找到的时候——「你到底去哪儿找了」问的往往正是它，而一个只说「没找到」却不给路径的答案没法据此行动。

### 导入 Codex CLI 登录（可选）

在 ChatGPT 卡片账号池里点「登录」**旁边**的「导入本机 Codex CLI 登录」。三点与 Claude Code 的收编同源：

- 导入的是**快照**，**本插件永不再刷新它**；
- 快照过期后请**回 Codex CLI 重新登录、再导入一次**，本插件里没有这条登录路径；
- 本插件**绝不写入、不创建、不移动、不删除** Codex CLI 的任何文件。

前两条的理由值得写全，因为这是整个功能最容易被误解的地方：ChatGPT 的 refresh token 会轮换，而 CLI 会在**原地刷新自己的文件**。两个进程刷同一份授权会互相作废，输的一方握着服务端已经作废的令牌，结果是**你被本插件的好意踢出 Codex CLI**。进程内的单飞解决不了它——这是**跨进程**竞态，两个进程之间唯一共享的就是那个文件，而按上一条本插件不能写它。所以这份快照只在 CLI 自己还为它作保的期间可用，**过期是收编这件事的一部分，而不是一个待修的缺陷**。

「绝不写入」是**结构性**的保证而不是承诺：`codex-adopt.ts` 只按名字从 `node:fs/promises` 导入 `readFile` 与 `stat`，加一次写操作必须先改这行 import，而 import 正是评审第一眼看的地方；测试还断言一次读取前后该凭据文件的**字节、大小与 mtime 完全不变**。

### 导入之后

- **只是号池里多一行**，不替换你当前的登录：已存储的登录态原样保留，两者在同一个池里参与调度；
- **同一个账号导入两次会原地更新**，不会多出一个重复账号：号池的去重键是 `accountId ?? email`；
- **导入的行与插件自持的登录语义不同**：它**永不被刷新**——`needsRefresh` 钩子对 adopted 凭据恒答否，刷新钩子本身也直接拒绝，两者都挡住是为了让将来漏掉前者的调用者大声失败而不是悄悄花掉一枚不属于本插件的授权；过期即**退出调度**且**不产生任何写入**，摘要标为**不可删除**，删除只能走显式的 `removeImportedAccount`（`POST /adopt/disable` 清掉插件这边记下的快照）。因此你在本插件里自己签入的账号不会被这个动作顺手清掉，而 CLI 自己的文件更不会被删除或改写；
- **过期不是失败**：卡片与号池会说明这份快照已过期、该回 Codex CLI 里重新登录后再导入一次；这一行随之退出调度，而不是拿一枚作废的令牌去试一次请求。
- **导入可以撤销，但撤销是「全部」而非「某一行」**：借来的凭据在账号池里被标为**不可删除**（这正是「过期不产生任何写入」与「插件自持的登录不会被顺手清掉」两条规则的代价），因此删除入口不在每一行上，而在 ChatGPT 标签页账号池卡片下方的一个按钮：**停止导入全部本机登录**。点它走 `POST /adopt/disable`，清掉插件这边记下的**所有**导入快照；你在本插件里自己签入的账号不在其中，**Codex CLI 自己的登录文件也不会被删除或改写**——这一步只是让本插件忘记它拷贝的那一份。按池级语义设计而不是行级，是因为该路由刻意不接受 `accountId`：一个摆在某一行上、却会连带清空邻居的按钮，比没有按钮更糟，所以按钮文案与提示里都写明「全部」，将来若改成逐行语义能被看见。

## 安全边界

Antigravity 的 access token / refresh token 使用独立的系统凭据存储：Windows 使用 CurrentUser DPAPI（`$DSH_HOME/storages/antigravity-oauth.json.dpapi`），macOS 使用登录钥匙串，Linux 使用 Secret Service。macOS / Linux 的服务名为 `dsh-antigravity`，账号键按旧凭据文件的绝对路径生成，隔离不同的 `DSH_HOME`。

**MiniMax Code 的 access token / refresh token 同样只在 Host 内处理，从不进入浏览器**（`/minimax-code/api` 的响应只含非机密事实，有测试锁定）。号池的**身份键也刻意不含机密**：桌面端凭据用 `recordKey`（路径摘要）、插件凭据用 `loginEpoch`，**不是**刷新令牌的哈希——用令牌做键在每次轮换后都会把同一账号看成新账号。它的凭据**不是本插件自持的**：正常路径是**只读复用** MiniMax Code 桌面端自己的 `~/.minimax/auth/<buildEnv>/<region>/mcode-public/auth.json`，续期时通过「同目录临时文件 + `rename`」原子写回，**不创建、不删除、不等待**桌面端的 `auth.lock`，也**不留任何旁路副本**——不会在桌面端的目录里写出明文 `.dsh-bak` 之类的第二份凭据。只有本机没有桌面端凭据时，本插件才把设备码登录得到的凭据存到自己的 `$DSH_HOME/storages/minimax-code-credentials.json`；**登出只删这一份**，桌面端的登录态绝不撤销、绝不删除（撤销它等于把用户从正在运行的官方客户端踢下线）。诊断中提及令牌时只输出 SHA-256 指纹前缀，不含令牌原文。

**Claude 订阅的 access token / refresh token 同样只在 Host 内处理，从不进入浏览器**（`/claude/api` 的响应只含非机密事实，有测试锁定）。它保存在独立系统凭据存储中：Windows CurrentUser DPAPI（`$DSH_HOME/storages/claude-credentials.json.dpapi`）、macOS 登录钥匙串、Linux Secret Service；号池另用一份同样加密的文件 `$DSH_HOME/storages/claude-pool.json`。凭据文档是**多账号**结构，账号身份由不可变的 `internalId` 与只增不换的别名集共同表达，**任何路由键都不是令牌或其摘要**（令牌会轮换，用它做键会产生幽灵账号）。每次写入都**先读回校验再落盘**，校验失败会抛错且不破坏既有数据。

**收编（adopt）是只读的**：本插件从不创建、修改、移动或删除 Claude Code 的任何文件；它只读取。收编得到的快照**永不由本插件刷新**（原因见上文）。

**Codex CLI 的导入（adopt）同样是只读的**：本插件从不创建、修改、移动或删除 Codex CLI 的任何文件。存在性与内容是两个函数——`/status` 里的 `codexCliSignInAvailable` 由一次 `stat` 回答，**在你点击导入之前没有任何令牌被读取**，而这一个字段也不含任何凭据内容（旁边的 `codexCliSignInPath` 只是被查看的那个文件路径）。导入得到的快照**永不由本插件刷新**；过期后该行退出调度，且**不产生任何写入**（原因见「本机登录」）。

macOS 钥匙串服务名为 `Claude Code-credentials`（**未核实**，本仓库不读取它：一份第三方指南与真实客户端对该名称说法不一致，因此它被明确列为非目标）。

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
| GET | `/status` | 查询账号、连接状态与额度；另带 `codexCliSignInAvailable`（本机是否有可导入的 Codex CLI 登录，**只 `stat` 不读取**）与 `codexCliSignInPath`（为此查看过的那个文件路径） |
| POST | `/login/start` | 开始 OAuth 登录 |
| GET | `/login/events?loginId=...` | SSE 订阅登录进度 |
| POST | `/login/cancel` | 取消登录任务 |
| POST | `/logout` | 注销并清除凭据与额度缓存 |
| POST | `/token/refresh` | 刷新 token |
| POST | `/quota/refresh` | 刷新额度 |
| POST | `/connection/test` | 测试连接 |
| POST | `/preferences/update` | 更新搜索来源和 composer 快捷用量偏好 |
| POST | `/adopt` | 导入本机登录（body `{source:'codex'}`），**只读**：快照作为一行加入 ChatGPT 号池，不触碰当前登录，也不触碰 Codex CLI 的文件 |
| POST | `/adopt/disable` | 停止导入：清掉插件这边记录的导入快照；**不删除也不改写 Codex CLI 的文件** |

状态响应只包含脱敏 email、套餐、账号 ID 后四位、token 到期时间和额度 DTO。

## 组件看板卡片（dsh-widget-board）

装了 `dsh-widget-board` 的 Host 上，本插件往组件库里放一张卡片 `line-flip`（**线路额度**）：**一条线路一张卡**，同一份组件摆多张、每张在 `props.line` 里写自己那条线路，不需要额外配置。

| 卡片 | 数据源 | 能力 |
| --- | --- | --- |
| **线路额度** `line-flip` | `dsh-chatgpt-subscription:line-card`（60 秒轮询，读 `props.line` 指的那一条线路） | `dsh-chatgpt-subscription:line-refresh`（让这条线路向上游强制读一次额度，等它返回）、`dsh-chatgpt-subscription:line-account-switch`、`dsh-chatgpt-subscription:line-account-strategy` |

- 卡片自己会翻面：正面是这条线路的额度窗口、进度条与重置倒计时；背面是它的号池、当前账号与三档轮换策略（顺序 / 轮询 / 粘住）。`props.line` 取 `codex`、`claude`、`kimi-code`、`minimax-code`、`antigravity`、`command-code`、`glm-coding-plan`、`step-code`、`qoder`、`cline-pass`、`opendesign` 之一，想看哪条线路就摆哪一张。
- 注册走看板发布的 `widgetBoard` 服务（注册时带服务自己报的 `apiVersion` 协商），组件目录 `widgets/` 随包发布；看板没装时这段什么都不做，看板拒绝注册时只记一条 warn，不影响插件装载；卸载时一次 `handle.dispose()` 把组件目录、数据源与能力一起撤掉。
- 数据源与三个能力都**不声明 `permission`**：它们只读本机这条线路自己的 `GET /status`、只写本插件持有的号池文档，不跑命令、不访问卡片指定的主机，所以不会弹授权按钮。
- 数据源与能力名都以 `dsh-chatgpt-subscription:` 为前缀（**不带** `@eddyskywalker/` 的 scope）：看板 manifest 的 id 正则不接受 `@` 与 `/`，带 scope 的名字在 manifest 里根本写不出来。
- 卡片里的时间戳一律是**毫秒**：各条线路在 wire 上的单位并不统一（codex 是 Unix 秒，antigravity / cline-pass 是 ISO 字符串，其余是毫秒），换算在 `src/host/widget-board/line-quota.ts` 里每条线路各做一次，卡片不按数量级猜单位。
- 插件更新后要**重启一次 Host**：看板没有插件热重载，新的组件目录只在装载时进组件库。

## 开发与验证

```sh
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

> `npm run typecheck` 里的 `tsc -b` **不带** `--force` 时会重放 `lib/*.tsbuildinfo`，在一份陈旧构建上只要几秒就返回——**看起来绿了，却从未真正编译过**。改 harness 版本或新增类型相关的代码后，请以 `npx tsc -b --force` 为准，并把 `tsc -p test/tsconfig.json` 单独跑一遍（测试树不在 `-b` 的范围内）。

`vitest.config.ts` 把 `testTimeout` 设为 60s、`maxWorkers` 限到 4 是有原因的，改回去会让套件重新变得不稳定：多条目测真的会 spawn `powershell.exe` 跑 Windows DPAPI 凭据存储，隔离测量最慢的一条要 12–14s。超时余量不够时不只是那一条失败——**超时后仍在飞的请求会落进下一个用例的 fetch mock**，把邻居也判失败（表现为 `expected to be called 4 times, but got 8 times`）。限并发不增加耗时：这些用例受子进程延迟约束，4 个 worker 约 51s，15 个约 54s。

测试使用 mock OAuth、Responses SSE 和 Wham usage，不需要真实 ChatGPT 凭据。真实账号的端到端登录与生成应在独立 DSH profile 中人工验收，避免影响日常 profile。

## 故障排查

### 压缩失败

Kimi Code、MiniMax Code、Command Code、Claude 遇到“输入加输出预留超限”时，插件可在 HTTP 400/422 的完整 token 计数证明输入仍能放下、且上游确实采用了请求输出上限的情况下，仅降低输出上限重试一次。消息、工具和历史保持不变，摘要请求也适用。降低后的输出仍可能截断，截断不会冒充完整摘要。Codex 不支持该输出参数，不走此恢复；输入本身超限、模糊错误或流内错误仍交给 Harness 处理。这不是对所有压缩故障的通用修复。

MiniMax、Kimi、Codex、Claude、Command Code 和 Antigravity 的错误处理会将明确的上下文超限错误交给 Harness 的溢出恢复机制。该机制需要宿主启用压缩后端；它不是无条件重发同一个超限请求。认证、配额和输出截断不会因此被当作上下文超限。**请求体字节限制是唯一按线路区分的**：Kimi Code 把「请求体超过 2 MB」的本地拒绝与网关原文 `total message size N exceeds limit 2097152` 都归入该码（压缩确实能缩小请求体，实测这是长会话最常见的 400），其余线路的请求体拒绝仍按普通错误呈现。手动压缩仍需生成完整摘要；如果摘要请求本身超限、被截断或缺少正文，修正错误分类也不能保证它成功。请保留失败会话中的 `compaction/end` 错误、provider/model、宿主及插件版本，以便定位。

| 现象 | 处理 |
| --- | --- |
| 1455 端口占用 | 结束旧登录任务或占用该端口的进程后重试；插件卸载会关闭 listener |
| 模型选择器里没有新发布的模型 | 该模型必须出现在 `/backend-api/codex/models` 返回的列表里（该列表是「这个账号能调什么」的权威）。若后端已发布而选择器没有，点设置页的**强制刷新目录**；仍不出现则说明当前套餐/workspace 无权调用 |
| 回答在中途被截断 | 可能是撞到服务端的输出上限。对话报文不发送 `max_output_tokens`（该参数会被上游 400 拒收，见「模型目录」），长度由服务端决定；被截断会以 `max-tokens` 结束原因呈现，可用**增强功能**里的上下文覆盖或换模型调整 |
| 断网后首次打开设置页很慢 | 目录有本地快照兜底，重启后第一次渲染不需要网络；若仍慢说明快照不可写（home 只读），此时不影响功能 |
| 登录后仍是 401 | 刷新 token；若刷新 token 已失效，注销并重新登录，不会循环请求 |
| 额度显示旧数据 | 设置页会保留最后成功值；等待 15 秒节流窗口后手动刷新 |
| 429 | 插件遵守 `Retry-After`，不会高频轮询；模型请求由 DSH retry policy 有界重试 |
| 模型不可用 | 检查 ChatGPT 套餐、workspace 权限与当前模型可用性 |
| `web_fetch` 报 `resolves to a non-public IP address` | 机器启用了系统代理（fake-ip DNS），但插件没有可用代理可接管抓取：在 **设置 → Codex 订阅 → 网络代理** 选择系统代理（自动检测）或填写自定义代理 |
| DPAPI 读取失败 | 确认 DSH 以创建凭据时的同一 Windows 用户运行；必要时清理凭据后重新登录 |
| Linux 凭据存储不可用 | 确认凭据属于当前用户且权限为 `0600`，父目录权限为 `0700`；修复权限或注销后重新登录 |
| Linux 上工具调用语法错误 | 确认 DSH 暴露的是 `bash`、`sh` 或 `shell`，并使用相应的 Bash/POSIX 语法与 `/` 路径 |
| `command-code` 模型不出现在选择器里 | 卡片上若显示“模型路由已被其他 Provider 占用”，从占用方（常见是 `llm-pi-ai` 的 `command-code` 条目）移除该 Provider，插件会在下一次路由变更时自动接管；否则检查是否勾选了模型 |
| Command Code 登录失败 | 确认 5959–5968 端口未被占用；无浏览器环境改用手动填写 API Key；`state` 校验失败时重开一次登录 |
| Command Code 返回 401 | 设置页重新登录或重新粘贴 API Key；插件不会保存无法通过 `/alpha/whoami` 的 Key |
| Claude 模型报格式错误 | 该 API 只接受把 `claude-*` 发到 `/messages`；请使用插件自动选择的线路，不要手工把 Claude 模型指向 OpenAI 端点 |
| Command Code 额度显示为空 | 账户 API 的账单/用量线路可能只对部分套餐开放；空态是解析不出有界额度时的正常表现，可点「刷新用量」重试 |
| Command Code 报 502 `Upstream model provider is temporarily unavailable` | 这是上游模型供应商的瞬时故障，不是账号或 API Key 的问题：插件会按 DSH retry policy 自动重试（最多 3 次）；连续失败即换用同一账号下的其他模型，或稍后再试 |
| Kimi Code 登录后立即失效 | 设备码只有几分钟有效期；重新点「设备码登录」即可。若刷新令牌被拒，卡片会明确提示重新登录（插件不会反复重试被拒的令牌） |
| Kimi Code 返回 401 `does not have access to k3` / `supports only … up to … context` | 这是**套餐权限**而非凭据问题：`k3` 需 Moderato 及以上、其 1M 上下文需 Allegretto 及以上。换用 `kimi-for-coding` 或 `k3-256k`，或把该模型的上下文覆盖降到 256K |
| Kimi Code 返回 403 `reached your … usage limit` | 账号额度用尽（5 小时 / 7 天 / 月度共享池）。卡片会显示各窗口的重置时间；共享池耗尽时即使 Kimi Code 池还有余额也会被拒 |
| Kimi Code 报 502 `Upstream model provider is temporarily unavailable` | 上游模型供应商的瞬时故障，与账号、模型、凭据都无关：插件会按 DSH retry policy 自动重试（最多 3 次，并遵守上游 `Retry-After`）；连续失败可稍后再试或换用同账号下其他模型 |
| Kimi Code 报 429 `engine is currently overloaded` | 服务容量问题（工作日 14:00–17:00 高峰更常见），会自动退避重试；若响应里带 `error.type = exceeded_current_quota_error` 则属于配额耗尽，插件不会重试而是提示补充额度 |
| Kimi Code 额度显示为空 | 卡片会同时给出失败原因（`/v1/usages` 的 401/403/5xx 文案），按提示处理后点「刷新用量」重试；确认用的是订阅账号——开放平台的 key 在这里不会被接受 |
| Kimi Code 报「rejected the stored credential (401). Sign in again…」但发消息却是好的 | 这是**过期 access token**，不是被拒的账号：Kimi 的 access token 只有 **15 分钟**，而设置卡片过去会把号池里存着的那个 token 直接拿去查用量，因此只要 15 分钟内没走过一次 Kimi 请求，卡片就必然拿到 401。现在卡片会先刷新再请求（401 还会触发一次强制续期），因此**不必重新登录**；若卡片仍提示重新登录，才是真的刷新令牌被拒，按提示处理即可 |
| Kimi Code 账号一栏为空 | 账号身份取自 OAuth token 自身的 JWT 声明，套餐名取自 `/me`（`/usages` 自 2026-09 起不再返回 `user_level_name`）。重新登录或点「刷新用量」即可写入；若仍为空但显示「已登录」，点「测试连接」可确认凭据是否仍被接受 |
| Claude 相关接口返回 403 | 403 现在是**同源校验**的结果（修改状态的路由只接受同源 JSON POST）。若出现在浏览器里，检查是否从其它来源发起了请求；插件已不再有任何"确认后才能用"的门禁 |
| 授权后粘贴授权码报「请把 # 后面的部分一起复制」 | 手动流程需要 `<授权码>#<state>` **整段**。只粘贴授权码是不被接受的：用流程自己的 state 顶上会架空 state 参数、把粘贴框变成登录 CSRF 的入口，因此插件宁可报错也不猜 |
| loopback 回调收不到 / 端口绑定失败 | 端口探测失败会自动**降级为手动粘贴**（卡片会说明原因），照提示粘贴授权码即可。另：若浏览器把 `localhost` 解析到 `::1`，依赖浏览器的跨地址族回退可达本机 v4 监听，这是**假定**而非实测 |
| 选择某个模型报 `claude_code_version_too_old`（例如 Opus 5.5 要求 2.1.280+） | 上游会校验本插件**申报的**客户端版本，新模型有各自的最低版本要求。插件现在会**在发出请求之前**本地拦下并告知模型、当前版本与要求版本（归类为**请求问题而非凭据问题**，**不会把你登出**——重新登录也不会有帮助）。用 `DSH_CLAUDE_CLI_VERSION` 抬高申报版本即可；已发布版本 ≥2.1.283 时 Opus 5.5 可直接使用 |
| 模型请求报持续 400 / 「You're out of extra usage」 | 可能是身份或版本门槛：订阅令牌要求 Claude Code 身份头与 `system` 首块，且服务端会校验你申报的客户端版本。此类错误被归类为**请求问题而非凭据问题**，不会把你登出 |
| 额度显示为空 / 某项显示「—」 | 额度接口的键集随账号类型变化，未提供的窗口会显示为未知而**不会伪造 0**。注意 **`utilization` 是已用百分比，0% 表示尚未使用（正常态）**，不是额度耗尽；真正的耗尽会以 429 与响应头状态呈现。接口被限流时卡片保留上次成功快照并标注时间 |
| 收编后提示「本机 Claude Code 登录已过期」 | 这是设计如此：收编的是**快照**，插件永不刷新它（Claude Code 刷新同一枚轮换令牌，两个进程各自刷新会互相作废）。回 Claude Code 重新登录后**再收编一次**即可 |
| 导入后提示「从 Codex CLI 导入的登录已过期」 | 同样如此：导入的是**快照**，插件永不刷新它（ChatGPT 的 refresh token 会轮换，而 CLI 会原地刷新自己的文件，两个进程各自刷新会互相作废，最后是你被本插件踢出 Codex CLI）。回 **Codex CLI** 重新登录后**再导入一次**即可——本插件里没有这条登录路径 |
| 账号被标为「无法识别账号身份」 | 服务端这个账号既没返回 uuid 也没返回 email，插件无法在再次登录时自动认出它。用卡片上的**手动合并**把它并入既有账号；这是已知限制，插件不会用假 id 掩盖它 |
| 模型不出现在选择器里 | 依次检查：卡片是否显示「模型路由已被其他 Provider 占用」（另一适配器持有该 id 时本插件会如实报告冲突而非抛错）；以及模型是否已勾选 |
| Kimi Code 发送视频却没有画面 | `k3-256k` 不支持视频，切到 `k3` 或 `kimi-for-coding`；容器须在白名单内（mp4/mpeg/mov/avi/x-flv/mpg/webm/wmv/3gpp）；若该模型走的是 Anthropic 线路，视频会降级为文字（该协议没有文档化的视频块）。以上情况模型都会收到明确的文字说明，据此向你说明而不是凭空回答 |