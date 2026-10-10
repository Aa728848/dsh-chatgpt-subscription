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
- [Command Code 线路](#command-code-线路)
- [WorkBuddy 线路](#workbuddy-线路)
- [Claude（订阅）线路](#claude订阅线路)
- [子代理模型授权](#子代理模型授权0215-起032-起强制指定模型)
- [随包分发的 Agent Preset](#随包分发的-agent-preset)
- [本机登录](#本机登录)
- [安全边界](#安全边界)
- [插件路由](#插件路由)
- [开发与验证](#开发与验证)
- [故障排查](#故障排查)

## 线路总览

本插件同时接入 **7 条订阅线路**，每条各自独立注册 Provider、独立登录、独立额度卡片。

| Provider ID | 订阅 | 协议 | 登录方式 | 模型目录来源 |
| --- | --- | --- | --- | --- |
| `codex-chatgpt` | ChatGPT（Plus / Pro / Business…） | Responses | 浏览器 OAuth（localhost:1455 回调），或导入本机 Codex CLI 登录 | **实时** `/backend-api/codex/models` |
| `kimi-code` | Kimi 会员 | Anthropic Messages | **设备码**（RFC 8628） | 实时 `/v1/models` + 本地兜底 |
| `command-code` | Command Code | Anthropic / OpenAI 双轨 | 浏览器 OAuth 或粘贴 API Key | 实时 `/provider/v1/models` |
| `workbuddy-subscription` | 腾讯 WorkBuddy / CodeBuddy | OpenAI 兼容（仅流式） | 扫描桌面端凭据或官方浏览器授权 | 实时 `/v3/config` |
| `claude-subscription` | Claude Pro / Max | Anthropic Messages | 手动粘贴 / loopback 回调 | 实时 `/v1/models` + 本地兜底 |
| `minimax-code` | MiniMax Code 编程订阅 | Anthropic Messages | **复用桌面端登录态** 或设备码 | **硬编码**（见下） |
| `antigravity` | Google Antigravity | Gemini | Google OAuth | 内置表 |

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
- **请求体超 2 MB 本地即拒绝**：该端点最常见的 400 是 `total message size N exceeds limit 2097152`，官方文案不给建议，这里直接按真实序列化体积拦截，并按「循环实际做了什么」给出处方（有图可丢但丢了也补不上缺口 / 图已丢完仍超限 / 本来无图，三种情况文案不同，不再声称发生了没发生的省略）；确有实测上限的部署（前置代理/网关）可设 `DSH_KIMI_CODE_MAX_BODY_BYTES` 指定该档上限，取值非正整数时**回落到默认值而不是关闭守卫**；带视频的请求走 64 MiB 档，不受该变量影响；
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

### WorkBuddy 线路

- 注册 `workbuddy-subscription` Provider，接入腾讯 **WorkBuddy / CodeBuddy 订阅**。
  - 该 ID 特意与用户常用的自定义 OpenAI 兼容线路 `workbuddy` 分开，安装插件不会覆盖或隐藏原有自定义 API；
  - 可直接扫描 CodeBuddy 桌面端已登录的 `*.info` 凭据，也可从设置页选择国区/国际区并通过官方浏览器授权添加账号；
  - 插件添加的凭据保存在系统加密存储中（Windows DPAPI / macOS Keychain / Linux Secret Service），token 只留在 Host 进程内，不进入浏览器；
- **多账号号池，与其它线路同源**：走共享内核 `AccountPoolCore` 并复用同一张设置卡片，具备顺序耗尽 / 轮询调度 / 粘性会话、429 冷却换号、账号级失效保留、设为主账号与备注；
  - **账号身份是两层**：不可变的 `internalId` 是唯一路由键，`identityKeys`（uuid / email / 派生 seed）是**只增不换**的别名集，同一账号再次登录会**合并**而不是产生幽灵账号；
  - **唯一例外的诚实说明**：当服务端既没返回 uuid 也没返回 email 时无法自动识别同一账号，卡片会把该账号标注出来并提供**手动合并**；
  - **顺序耗尽 / 轮询调度 / 粘性会话**三种策略；
  - 429 冷却换号、401/403 账号级失效（保留账号、重新登录即恢复）；
  - 设为主账号、账号备注、清除冷却与重新登录；
  - 桌面端扫描到的账号与插件内添加的账号**在同一号池里参与调度**；
- **桌面账号归 IDE 所有，不可删除**：卡片只对插件自己添加的账号显示「删除」，桌面账号显示「隐藏 / 恢复」——隐藏只把它移出本插件的调度，绝不改动 CodeBuddy 的凭据文件；号池层同样拒绝删除桌面账号（双保险，均有测试）；
- **续期后原子写回**原凭据文件（只改 `auth` 块），以免桌面端掉线——桌面账号的 refresh token 会轮换，若只写进插件自己的加密存储，IDE 手里就只剩一个已作废的 token。同一进程内的并发调用**共用一次刷新**，且不会二次刷新；
- 上游是 OpenAI 兼容的 `POST {backend}/v2/chat/completions`，但有两条硬约束：**只支持流式**（`stream:false` → 400 `code 11101`），且**首条消息必须是 system**（否则国际区返回 400 `code 11128`）。因此请求构造器始终发送 `stream:true`，并在调用方没给系统提示时补一条中性的，避免手搓的一次性请求踩到这条规则；
- **区域是凭据属性，不是请求属性**：`*.workbuddy.ai` / `*.codebuddy.ai` 走国际区 `https://www.<apex>`，其余走国区 `https://copilot.tencent.com`；
  - 账号卡片逐条标注每个账号的**国区 / 国际区**并允许选择；切换后，模型目录、额度和后续对话都使用该账号；历史凭据快照按账号身份自动去重；
  - 插件托管账号可真正删除；桌面扫描账号只能从本插件隐藏/恢复，永不删除 CodeBuddy 的原文件；
  - 两区模型清单不同，把模型发到不服务它的区会返回 400 `code 11102`，因此模型选择器**按当前账号区域过滤**；
- **模型目录取自网关自己的 `/v3/config`**（官方 CLI 启动时读的就是它）：每个模型的真实上下文上限、输出上限、是否接受图片、以及可用的思考档位都在这里，不做任何按模型名猜测。`/v1/models` 在这条线路上是 404，所以此前只能靠内置表——现在内置表只作为离线兜底，且是**从真实 `/v3/config` 转录**的（早期手写版本把 `glm-5.3`、`kimi-k3` 的窗口猜成 200K/256K，实际都是 1M）；
- **目录不是服务全集，模型必须实测**：实测国际区的 `gpt-6-sol`、`gpt-6-luna`、`gemini-3.8-flash` 都能正常返回 200，却**完全不在 `/v3/config` 里**（该接口只公布 `gpt-6-astra`）。而联网时目录会**整体替换**内置表，只加进内置表等于加了个看不见的模型——所以这三个单列一份实测表（`UNPUBLISHED_MODELS`），并合并进实时目录。存在性、思考档位、图片支持是**打接口量出来的**（`gpt-6-sol` 只收 `low`/`medium`/`high`/`xhigh`/`max`，`minimal` 被拒）；上下文与输出上限**继承同族已公布的兄弟模型**（`gpt-6-astra` / `gemini-3.5-flash`），因为网关对这些 id 不公布任何信息，而 `max_tokens` 也不受窗口约束（连 `gpt-6-astra` 自己都接受远超其公布上限的值），无从反推。三者仍可在设置页逐模型覆盖；判定一个 id 是否存在只有一条路——直接问：`code 11102` 是没有这个模型，`code 11133` 是模型存在但参数被拒；
- 目录同时区分**默认服务的上下文长度**与**模型上限**（如 `deepseek-v4.1-flash` 默认 300K、最大 1M）。本线路不发送显式长度参数，所以 DSH 的压缩与溢出判断按**默认服务长度**计算，不会让请求越过后端实际接受的窗口；
- 思考档位**逐模型**取目录声明的档位表，回落顺序为「调用方显式指定 → 用户配置的默认档 → 目录为该模型声明的默认档」；
  - **最后一档不能省**：上游在请求不带 `reasoning_effort` 时返回**空的 `reasoning_content`**（实测同一提示：不带字段 0 字符，带字段 130–215 字符）——不发送等于静默丢弃模型的思考；
  - 目录里的单个 `effort` 字段是**默认值**，既不是完整档位表也不是「只此一档」：实测这类模型接受 `low` / `high` / `max`（其余取值被上游收敛到最近档），因此使用这三档的标准表（`WORKBUDDY_STANDARD_EFFORTS`）；显式声明了 `supportedEfforts` 的模型则原样采信；
  - 目录给出的**默认档也可能落在档位表之外**（`minimax-m3`、`kimi-k3`、国区 `glm-5.3` 都报 `medium` 却只有三档），这种值会收敛到最近档——否则默认档被判不支持而丢弃，退化成上一条的空 `reasoning_content`；
  - 不在该模型档位集合内的取值会被**忽略而不是发出去**（上游对不支持的档位返回 `code 11150`）；
- **瞬时失败按错误类别重试**（`src/host/workbuddy/adapter.ts`）：
  - 上游 5xx 与 `code 11134` 归为 `SERVER` 并走有界退避（最多 3 次，1.5s 起步、15s 上限、0.2 抖动）；
  - 额度耗尽（429 / `code 6004` / `code 14003`，其中 6004 的正文带重置时刻）归为 `RATE_LIMIT` 并遵守 `Retry-After`；
  - 401/403、跨区模型、不可用图片、历史形状错误都**不重试**，并给出可操作的提示（换模型 / 换图片 / 重新登录桌面端）；
- **流中断即失败**：上游必然以 `finish_reason` 或 `data: [DONE]` 结束，两者都缺失说明连接中途断开，此时抛出错误而不是把半截文本当成完整回答；
- 额度来自 `/billing/meter/get-user-resource`，卡片展示套餐名、本周期已用/上限、剩余额度与重置时间；设置页为「设置 → 订阅服务 → WorkBuddy」标签页，对话输入框右侧有该线路的额度胶囊。


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
  - **登出只作用于本插件自己那份凭据**：桌面端的登录态会被续期写回（只读优先），但**绝不撤销、绝不删除**，登出请求对它会被拒绝并说明原因（撤销它等于把你从正在跑的 MiniMax Code 里踢下线），这也是 WorkBuddy 对桌面账号的既有做法；
- **区域是凭据属性**：`cn` 用 `account.minimax.cn` / `agent.minimax.cn`，`global` 用对应 `.io` 域名。两个区域的目录都会被探测，因此国际区账号不会因为没有国区文件而「未登录」；读回凭据时**以记录里存的区域为准**，而不是拿默认区域覆盖它；
- **模型目录是硬编码的，而且必须硬编码**（`src/host/minimax-code/model-catalog.ts`）：
  - 该端点的 `GET /v1/models` **未对订阅流量开放**（503 `"{\"errorCode\":50115,\"errorReason\":\"direct_route_not_configured\"}"`），所以任何「实时目录」都只会是一个必然失败的请求；
  - 四款模型（M2.7 / M2.7 HighSpeed / M3 / M3.1 Flash Preview）的上下文、输出上限与思考形态都取自本机 `~/.minimax/config.yaml` 的模型表，**不从不存在的接口推断**；
- **思考形态按模型表三态实现**：M2.7 系列**恒定开启且没有档位**（不发送任何字段）；M3 是**开关二态**（`{type:'enabled'|'disabled'}`）；M3.1 Flash Preview **强制开启并可指定档位**（`{type:'enabled',effort:...}`）。未知或越档的取值一律回落到该模型目录声明的默认档，不会把模型没有声明的档位发出去；
- **视频不在能力声明里**：模型表虽然给 M3 / M3.1 标了视频输入，但 DSH 的附件服务只存图片、本线路也没有安装视频字节读取器，映射器只能把它替换成一条说明文本。**声明一个做不到的能力比不声明更糟**（DSH 的能力闸门、模型选择器与子代理委派都会当它成立），所以这里只声明 `text` 与 `image`；要加 `video` 必须先有真正的读取器（对照 Kimi Code 线路的 `video-store.ts`）；
- **瞬时失败按错误类别重试**（`src/host/minimax-code/adapter.ts`）：上游模型供应商临时不可用（5xx）归为 `SERVER`、429 归为 `RATE_LIMIT`、连接未产出响应归为 `TRANSPORT`，走 DSH retry policy 的有界退避（最多 3 次，1.5s 起步、15s 上限、0.2 抖动）；**但 429 的正文若说的是余额/额度耗尽，则判为终局**——重试只会推迟用户真正需要看到的提示；
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

**设置 → Codex 订阅 → 网络代理** 同时控制 GPT 与 Antigravity（Gemini）的 Host 请求，可选择系统代理（自动检测）、自定义代理或直连。Gemini 模型生成、网页登录后的令牌交换、令牌刷新、账号信息、项目发现、配额与模型目录查询均使用此设置；修改后对后续请求生效，无需重启 DSH。浏览器中的 Google 授权页面使用浏览器自己的网络设置。

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

### 协作模式自适应（teammate / subagent）

DSH 的 Agent Teams（bundle `@deepseek-ai/dsh-experimental-agent-team-profile`）会在**每个会话自己的作用域**里注册一套与内置**同名**的协调工具。工具注册表按作用域链解析、**近的层遮蔽远的层**，所以一旦该 bundle 被组合进来，会话里的 `send_message`、`list_agents`、`interrupt_agent` 就都换成了 teammate 版：

- `list_agents()` 只列 Team 成员（Lead 自己显示为 `lead`），**看不到 `subagent` 派出去的子代理**；
- `send_message` 的 `target` 只接受成员名，把子代理的 session id 传进去会抛 `active teammate "…" not found`（实测）；
- 于是「派得出去、回访不了」——`subagent` 的孩子只能等完成通知，无法追问。

`dispatch` preset 现在**每个任务开始时先侦测一次协作模式**（persona 的 R0.5），再按模式选择协调词汇（R-T）：

| 侦测为 | 判据 | 协调词汇 | 派发 |
|---|---|---|---|
| teammate | `spawn_teammate` / `wait_agent` 存在 | `list_agents()`、`send_message({ target: <成员名> })`、`wait_agent()`、`team_task_*` | `spawn_teammate`（无路由参数，继承主代理路由）或 `subagent`（按 R2 显式路由） |
| subagent | 二者都不存在 | `list_agents()`、`send_message({ agent_id })`、`interrupt_agent` | `subagent` / `subagent_fork` |

两种模式下 R0 分诊、R1 职责边界、R3 自治、R6 验收都照常执行；**模型路由守卫（`subagentModelAuthorization`）不变**——它默认把 `spawn_teammate` 与 `subagent_fork` 同为 **inherit 模式**（见下），校验的是成员实际继承到的路由，而不是要求它给出并不存在的路由参数。

> **不要**把 `spawn_teammate` 加进 `subagentModelTools`。该列表是 **explicit** 模式：要求每次调用成对给出 `provider` + `model`，而 `spawn_teammate` 的参数里根本没有这两个字段（DSH 设计如此：成员一律继承 Lead 的路由），结果是每一次 teammate 创建都会被硬拒，且模型无法通过补参数自救。它的正确归属是 `subagentModelInheritTools`（默认已包含）。

### 已知上游限制：teammate 不能选模型

`spawn_teammate` 目前**无法**指定 `provider`/`model`，这不是插件的问题，而是 Agent Teams 有意不做 per-teammate 路由。三层都已核对：

| 层 | 能否带路由 | 证据 |
|---|---|---|
| 工具入参 | ❌ | `spawn_teammate` 的 schema 只有 `name`/`description`/`prompt`/`context` |
| Team 服务 | ❌ | `SpawnTeammateRequest.provider` 是 **subagent 后端名**（`spawn`/`fork`），不是 LLM provider；且无 `model` 字段 |
| 底层 API | ✅ | `ContinuableStartSpec.request` 可带 `agentOptions`（含 provider/model/reasoningEffort），但 Team 服务构造 request 时**只放 prompt 与 parent**，整个省略 |

因此成员必然跑在 Lead 自己的路由上——这正是守卫把它归 inherit 模式的原因，也是**不应**把它加进 explicit 的 `subagentModelTools` 的原因。

**插件侧无法绕过**，四条路都已验证死：pre-execute 明确排除输入改写（参数已被记录与呈现，`PreToolDecision` 只有 allow/deny/cancel/ask）；`agentTeams` 服务在内部丢弃后包装不到；注册自定义 subagent provider 也拿不到路由（`agentOptions` 在 continuation manager 就已解析完，provider 只返回 `seed`）；唯一能改子会话路由的 `selectForNextRequest` 只作用于「下一个请求」，而 teammate 创建后立刻开跑，抢不进去。

**上游正路**：在 `packages/experimental/agent-team/src/roster.ts` 构造 `startContinuable` 的 `request` 处补上 `agentOptions`，并给 `SpawnTeammateRequest` 加字段、给工具 schema 加参数、创建前接 `assertAllowedModelSelection`。**该改动落地后**，`spawn_teammate` 就应从 `subagentModelInheritTools` 移到 `subagentModelTools`（explicit）——否则它会变成「能选模型却没人管」。

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

改动只在设置卡片里保存过的勾选生效：设置改动只影响之后新建的会话（DSH 的会话快照语义），已运行的会话继续使用它自己记录的那份列表。

> 升级提示：从 0.3.2 起，带有允许列表的会话里**任何**未写明 `provider` + `model` 的委派都会被拒绝（此前只有写明且不在列表内的路由会被拒绝）。这是有意的行为变更——它消除了「子代理悄悄继承主代理模型」的漏洞；把 `subagentModelAuthorization` 设为 `false` 可回到 DSH 原始行为。

### Kimi Code

1. 重启 `dsh web`；
2. 打开 **设置 → Kimi Code**；
3. 点击 **设备码登录**，在弹出的浏览器页面确认授权（页面已预填用户码；也可手工复制用户码到 `verification_uri`）；
4. 登录完成后按需勾选模型、设置默认思考档位与上下文窗口。

`kimi-code` 会像其他 Provider 一样出现在 DSH 模型选择器中。**上下文窗口**默认取模型目录值，可逐模型覆盖（用于 DSH 的压缩与溢出判断，支持 `1M` / `256K` / `200000` 等写法）——注意 `k3` 的 1M 上下文需要 Allegretto 及以上套餐，因此默认按 256K 计算，升级后再在此覆盖为 1M。**默认思考档位**只提供 `low` / `high` / `max` 三档与「关闭思考」（服务对这三档以外的取值直接报 400）；切换模型或切换档位都会使上下文缓存失效，建议在同一会话内保持一致。

**区域**：默认使用中国大陆主机（`auth.kimi.com` / `api.kimi.com`）。国际账号可设置 `DSH_KIMI_CODE_OAUTH_HOST=https://auth.kimi.ai` 与 `DSH_KIMI_CODE_BASE_URL=https://api.kimi.ai/coding` 后重新登录；环境变量同时会钉住区域，设置页会显示当前解析到的主机。

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

## WorkBuddy 线路

1. 重启 DSH，让 Host 加载本插件；
2. 打开 **设置 → WorkBuddy**；
3. 二选一：登录 CodeBuddy 桌面端后点「重新扫描」，或点「账号管理」右上角的「添加国区账号 / 添加国际区账号」并在官方页面完成浏览器授权；
4. 在「账号管理」里选择账号（每条都标注国区 / 国际区），再按需勾选模型、设置默认思考深度与上下文窗口。

`workbuddy-subscription` 会像其他 Provider 一样出现在 DSH 模型选择器中，并可与名为 `workbuddy` 的自定义 API 同时存在。**上下文窗口**默认取网关 `/v3/config` 声明的**默认服务长度**，可逐模型覆盖（用于 DSH 的压缩与溢出判断，支持 `1M` / `300K` / `200000` 等写法）；**默认思考深度**逐模型生效，选项由当前账号各模型**实际声明的档位**取并集（仅部分模型支持的档位会标注数量），档位不在该模型集合内时不会被发送。

**消耗倍率**也来自同一份目录：每个模型在 `/v3/config` 里带一个 `credits` 字符串（如 `x0.79 credits`、`x6.67`），就是该模型消耗套餐额度的相对速率——官方 CodeBuddy 客户端把它渲染成 `6.67x` 显示在模型下拉里。设置页的模型行末尾会以 `倍率 0.79x` 的形式给出，**两区不一致时把两区都写出来**（实测国际区 `deepseek-v4.1-flash` 是 `0.00`、国区是 `0.11`），账号区域已知时只显示该区的值，**绝不拿另一个区的数字顶上**（跨区调用本来就会被上游以 400 `code 11102` 拒绝）。`x0.00` 是真实声明（该模型不消耗额度），照常显示；网关没给倍率的模型（如 `default-model`）则**整项不出现在提示里**，而不是编一个 0。

**凭据目录**按平台解析，可用 `CODEBUDDY_AUTH_DIR` 覆盖（与官方工具链一致）：

| 平台 | 默认目录 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth` |
| macOS | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth` |
| Linux | `$XDG_DATA_HOME/CodeBuddyExtension/Data/Public/auth`（默认 `~/.local/share`） |

目录里通常同时存在当前凭据与若干带时间戳的历史快照。插件**优先取 `workbuddy-desktop.info` / `codebuddy-desktop.info` 这类规范文件名**，其余按 token 剩余有效期取最长的一个——只按文件 mtime 选会选到过期快照。卡片会列出目录里所有可用凭据，标明各自区域。

**上游接口**：

| 用途 | 路径（前缀为区域后端） |
| --- | --- |
| 模型生成 | `POST /v2/chat/completions`（仅流式） |
| 模型目录 | `GET /v3/config` |
| 浏览器授权 | `POST /v2/plugin/auth/state` + `GET /v2/plugin/auth/token` |
| 令牌续期 | `POST /v2/plugin/auth/token/refresh` |
| 额度 | `POST /billing/meter/get-user-resource` |
| 签到状态 | `POST /billing/meter/checkin-activity-status`（仅国区） |
| 每日签到 | `POST /billing/meter/daily-checkin`（仅国区） |

两区后端分别是 `https://copilot.tencent.com`（国区）与 `https://www.workbuddy.ai` / `https://www.codebuddy.ai`（国际区）。**请求身份统一使用 CLI UA**（`CLI/2.63.2 CodeBuddy/2.63.2`）：实测 `CodeBuddyIDE` 被 `/v3/config` 以 400 `code 12403` 拒绝，国际区对话端点也直接返回 401，因此不做按端点切换。

**每日自动签到**（仅国区；语义与 workbuddy2api 的 `daily_checkin.py` 对齐）：DSH 启动时自动签到一轮，运行期间每 10 分钟幂等补检（当日已签的账号不再发请求）；签到前先查签到状态，token 过期会自动续期并回写（桌面账号写回 CodeBuddy 自己的凭据文件）。失败当天最多自动重试 3 次；**活动尚未开启的账号不会当天放弃**——首次签到状态若报无权益，之后每小时复查一次，避免开机早于活动开放时间就错过当天。国际区账号不参与（国际后端没有签到活动）。**DSH 没开机的当天不会签到**——插件不是常驻服务。设置页「每日签到」区块可开关自动签到、查看「今日已签 x/y · 无活动 z · 失败 w」并手动「立即签到」（手动会重跑一轮并绕过开关与重试上限）。签到状态存在 `storages/workbuddy-checkin.json`，token 不出 Host。

### 插件路由（WorkBuddy）
所有路由都以 `/workbuddy/api` 为前缀：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/status` | 账号、额度、模型目录与路由归属（每次都重扫凭据目录） |
| GET | `/accounts` | 列出桌面扫描及插件托管账号（不含 token） |
| POST | `/accounts/login` | 按国区/国际区启动官方浏览器授权 |
| GET | `/accounts/login/status` | 读取授权轮询状态（不含 token） |
| POST | `/accounts/action` | 删除插件托管账号，或隐藏/恢复桌面账号 |
| POST | `/rescan` | 清缓存并重扫凭据目录 |
| GET / POST | `/quota` | 强制刷新额度（POST）或读取当前状态（GET） |
| GET / POST | `/models`、`/settings` | 读取或更新勾选模型、上下文窗口与默认思考深度 |
| POST | `/catalog/refresh` | 强制刷新网关模型目录 |
| POST | `/connection/test` | 用已识别凭据向上游发一次最小请求测试连接 |
| POST | `/checkin/now` | 立即执行一轮每日签到（忽略开关与重试上限、不受无活动复查节流限制；当日已签的账号仍跳过） |

与其它线路一样，所有修改状态的路由只接受同源 JSON POST，并校验 `Origin` 与 `Host`。

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
kimi-code / workbuddy 一致），**不**占用 Codex 那条线路的 `/api/dsh-chatgpt-subscription` 前缀。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/status` | 账号、区域、凭据来源与路径、硬编码模型目录、路由归属（`serving` / `conflict`）与凭据归属（`ownedByPlugin`） |
| POST | `/login/start` | 开始设备码授权（可带 `region`） |
| POST | `/login/poll` | 轮询一次授权结果 |
| POST | `/login/cancel` | 取消授权 |
| POST | `/logout` | 注销**本插件自己那份**凭据；桌面端的登录态会拒绝并说明原因 |
| POST | `/test` | 向上游发一次最小 Messages 请求测试连接 |
| GET / POST | `/models`、`/settings` | 读取或更新启用开关、勾选模型、上下文窗口覆盖与默认思考深度；两个路径等价（kimi/claude 叫 `/models`，workbuddy/command-code 叫 `/settings`） |
| GET / POST | `/accounts` | 号池动作：`set-primary` / `set-alias` / `delete` / `clear-cooldown` / `strategy` / `relogin` / `adopt`（`adopt` = 把桌面端当前登录态导入号池，只读、不改动官方客户端文件） |
| GET / POST | `/quota` | 读取用量快照（POST 强制刷新）：Token Plan 的 5 小时与每周窗口。**上游读失败不算请求失败**——`quota` 是可选字段，失败时卡片显示“暂无数据”，对话不受任何影响 |

与其它线路一样，所有修改状态的路由只接受同源 JSON POST，并校验 `Origin` 与 `Host`。**响应里永远不含
access token / refresh token / 授权码 / PKCE verifier**；诊断里提到某个令牌时只输出它的
**SHA-256 指纹前缀**（`sha256:.../len:...`），**不是**令牌的任何一段原文——早前版本会打印前 6 个字符，
那本身就是一次凭据泄露，因为同一个字符串会被渲染到设置卡片并写进 Host 日志（有测试锁定）。

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

**WorkBuddy token 仅在 Host 内处理，从不进入浏览器**（`/workbuddy/api` 响应不含 `accessToken` / `refreshToken`，有测试锁定）。桌面扫描账号仍使用 CodeBuddy 自己的登录态文件：续期只原子写回其 `auth` 块；从本插件删除时只隐藏/恢复，绝不删除原文件。通过浏览器授权添加的账号归本插件所有，保存在独立系统凭据存储中：Windows CurrentUser DPAPI（`$DSH_HOME/storages/workbuddy-accounts.json.dpapi`）、macOS 登录钥匙串、Linux Secret Service；这类账号可在设置页真正删除。

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

Kimi Code、MiniMax Code、Command Code、Claude、WorkBuddy 遇到“输入加输出预留超限”时，插件可在 HTTP 400/422 的完整 token 计数证明输入仍能放下、且上游确实采用了请求输出上限的情况下，仅降低输出上限重试一次。消息、工具和历史保持不变，摘要请求也适用。降低后的输出仍可能截断，截断不会冒充完整摘要。Codex 不支持该输出参数，不走此恢复；输入本身超限、模糊错误或流内错误仍交给 Harness 处理。这不是对所有压缩故障的通用修复。

MiniMax、Kimi、Codex、Claude、Command Code、WorkBuddy 和 Antigravity 的错误处理会将明确的上下文超限错误交给 Harness 的溢出恢复机制。该机制需要宿主启用压缩后端；它不是无条件重发同一个超限请求。认证、配额、请求体字节限制和输出截断不会因此被当作上下文超限。手动压缩仍需生成完整摘要；如果摘要请求本身超限、被截断或缺少正文，修正错误分类也不能保证它成功。请保留失败会话中的 `compaction/end` 错误、provider/model、宿主及插件版本，以便定位。

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