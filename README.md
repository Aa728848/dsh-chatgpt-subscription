# DSH ChatGPT Subscription

让 DSH（DeepSeek Harness）通过 ChatGPT 订阅使用 Gpt 系列模型的插件。

插件注册 `codex-chatgpt` Provider（显示名 **“Codex（ChatGPT 订阅）”**），以当前 Host 用户的 ChatGPT OAuth 登录态访问模型，并在设置页展示账号信息、连接状态与订阅额度。支持 Windows 与 Linux。

## 目录

- [功能特性](#功能特性)
- [模型目录](#模型目录)
- [环境要求](#环境要求)
- [安装](#安装)
- [使用](#使用)
- [Kimi Code 线路](#kimi-code-线路)
- [Command Code 线路](#command-code-线路)
- [WorkBuddy 线路](#workbuddy-线路)
- [GLM（智谱 Coding Plan）线路](#glm智谱-coding-plan线路)
- [子代理模型授权](#子代理模型授权0215-起)
- [随包分发的 Agent Preset](#随包分发的-agent-preset)
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
- Antigravity（Gemini / Claude）线路同样接受图片输入：DSH 以 `{ type: 'image', attachment }` 下发的粘贴图片会经附件服务读出字节并按 Gemini `inlineData` 发出，读不出的图片降级为一条可见的说明文本而不是被静默丢弃。单次请求的图片 base64 负载超过 12 MiB 时，最旧的图片按上游同款占位文案替换为文本，避免整条请求被体积上限拒绝；
- 原样转发 DSH 暴露的工具 schema；命令工具兼容 `pwsh` / `powershell`、`bash`、`sh` 与 `shell`，并按 PowerShell、Bash 或 POSIX sh 注入对应说明；
- 429/5xx 由 DSH retry policy 接管；401 只强制刷新并重试一次，支持 `AbortSignal`；
- Codex、Code review 及上游返回的额外窗口额度，支持 Credits、月度消费控制与 reset credits 展示；60 秒缓存、15 秒上游节流并遵守 `Retry-After`；
- 提供 ChatGPT 订阅侧 Codex 搜索 provider，可在设置页切换 DSH 默认搜索或 Codex 订阅搜索；
- 新增 `codex_image_generate` 工具，生成图片后通过 DSH 附件系统保存并在会话中渲染；
- 可选 composer 快捷用量徽标，按当前 `codex-chatgpt` 模型显示最紧张窗口的剩余额度。


**Command Code 线路**

- 注册 `command-code` Provider，使用 Command Code 的 Provider API 与账户 API；模型 id 决定线路：`claude-*` 走 Anthropic Messages（`/provider/v1/messages`），其余模型走 OpenAI Chat Completions（`/provider/v1/chat/completions`），因为该 API 会拒绝把模型发到格式不符的端点；
- 浏览器登录复刻官方 CLI 的回环回调契约（`127.0.0.1:5959` 起顺延，`/callback` 接受 Studio 页面的跨域 POST），也可在设置页手动粘贴 API Key；两条路径都先用 `/alpha/whoami` 验证再加密保存；
- 模型目录取自公开的 `/provider/v1/models`，每个模型的 `context_length` 作为默认上下文窗口，可逐模型覆盖；
- **模型能力逐模型查表**（`src/host/command-code/model-catalog.ts`，转录自官方 CLI 的模型注册表）：是否接受图片输入、支持哪些思考档位由该表决定，未知模型回落纯文本。图片能力不能靠厂商/模型名前缀推断——`deepseek/deepseek-v4.1-flash` 与 `deepseek/deepseek-v4-flash-vision-exp` 支持图片而 `deepseek/deepseek-v4-flash`、`deepseek/deepseek-v4-pro` 不支持，`z-ai/glm-5.3-flash` 支持而 `zai-org/GLM-5.3` 不支持；
- 额度与用量来自账户 API 的账单/用量线路，任一条失败不影响其余；
- **瞬时失败按 DSH retry policy 有界重试**：`command-code` 路由显式声明 `normal` 策略（最多 3 次，1.5s 起指数退避、15s 上限、0.2 抖动），覆盖 `RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`。上游模型供应商临时不可用（502/503/504/500，典型响应体是 `{"error":{"type":"server_error"}}`）被归类为 `SERVER` 并自动重试，429 会带上上游的 `Retry-After` 让退避按对方的节奏走；401/403 与 `ABORTED` 明确不重试；
- 模型勾选（含线路标签）、思考深度、上下文窗口覆盖与额度在「设置 → 订阅服务 → Command Code」标签页中配置，输入框右侧另有额度胶囊。

**Kimi Code 线路**

- 注册 `kimi-code` Provider，接入 Moonshot 的 **Kimi Code 订阅**（`https://www.kimi.com/code`）。它与 Moonshot 开放平台（pay-as-you-go）是两套互不通用的系统：订阅的模型接口是 `https://api.kimi.com/coding/v1`，凭据只来自订阅 OAuth；把开放平台的 key 或 base URL 用在这里会被判为 `401 Invalid Authentication`；
- 登录用 **RFC 8628 设备码流程**（`auth.kimi.com`）：设置页点「设备码登录」后直接展示用户码与一次性链接（浏览器会自动打开），装好后无需回调端口、无浏览器环境也能手工完成；`slow_down` 会按 RFC 调宽轮询间隔，设备码过期会自动重新申请而不是直接失败；
- 访问令牌到期前按 `max(300s, expires_in×0.5)` 自动续期，同进程并发调用共用一次刷新；被拒的 refresh token 进入冷却并提示重新登录；
- **瞬时失败按错误类别重试**（`src/host/kimi-code/adapter.ts`）。上游模型供应商临时不可用（典型是 502 `{"error":{"message":"Upstream model provider is temporarily unavailable. Please try again in a moment.","type":"server_error"}}`）、真正的 429 背压（`too many requests` / `engine is currently overloaded`）、连接失败与流停滞都会走有界退避（最多 3 次，1.5s 起步、15s 上限、0.2 抖动），并遵守上游的 `Retry-After`；而**配额耗尽型的 429、403 的账号额度上限、401 里的套餐权限不足、400 请求格式错误都不重试**——服务把这些含义压进同一个状态码，因此分类读响应正文而不只看状态码，重试无望时直接给出可操作的提示（换模型 / 降上下文 / 等窗口重置 / 重新登录）；
- 模型目录为订阅侧的四款模型：`k3`（1M 上下文，需 Allegretto+；Moderato 上限 256K，故默认按 256K 计算，可用上下文覆盖升到 1M）、`k3-256k`、`kimi-for-coding`（K2.8 Preview）、`kimi-for-coding-highspeed`（约 6× 速度、3× 额度），运行时以 `GET /v1/models` 为准；
- **K3 行为按其官方文档实现**：思考档位只发 \`low\` / \`high\` / \`max\`（其余写法收敛映射，未知档位不发送），关闭思考发 \`thinking:{type:"disabled"}\`，开启时发 \`thinking:{type,effort,keep:"all"}\`；**开启思考时每条 assistant 消息都回传 \`reasoning_content\`**（无推理则回传空串——服务要求的是空值而非省略，否则 400）；不发送 \`temperature\`（采样参数按模型固定，显式值会报错）；工具调用 id 截断到 64 字符；\`stop\` 按上限裁剪为最多 5 条、每条 ≤32 字节，超长整条丢弃（截断的停止串会在错误位置终止生成）；
- **K3 的长思考不会被截断**：输出上限跟随上下文窗口（保留 4096 余量），因为 \`reasoning_content\` 计入输出，固定 32K 会把 \`max\` 档的长推理中途截断并返回 \`length\`；调用方已知 prompt 规模时上限会被下调到放得下，未知时不做猜测；
- **请求体超 2 MB 本地即拒绝**：该端点最常见的 400 是 \`total message size N exceeds limit 2097152\`，官方文案不给建议，这里直接按真实序列化体积拦截并提示压缩会话或检查大工具结果；
- **缓存是自动的，且无法手动干预**：Kimi 按请求内容哈希命中前缀缓存，实测 \`prompt_cache_key\` 与 Anthropic \`cache_control\` 标记**均被忽略**（设与不设、同 key 与异 key 命中的是同一缓存），设备 id 与协议切换也不影响；TTL 实测在 300–1800 秒之间，按 256 token 对齐，\`/messages\` 与 \`/chat/completions\` **共享同一缓存**。真正决定命中率的是**内容稳定性**：同一会话内 \`system\` 或工具列表一旦变化会使整个前缀缓存失效（实测归零），因此应保持工具集合稳定、把新增内容追加在末尾。卡片会显示滚动命中率，方便验证效果；
- **视频输入可用**（`k3`、`kimi-for-coding`）：DSH 的模态词表只有 `text`/`image`，但它是可合并扩展的接口，本插件用 TypeScript 模块增强把它扩到 `video`（**未改动 DSH 任何代码**），因此视频走 DSH 真实的能力通道，而不是只能显示在提示里。适配器把视频映射为服务文档的 `{type:'video_url',video_url:{url:'data:…'}}`。视频与图片**各有独立预算**（图片 2 MB、视频 48 MiB base64，最旧优先省略），请求体校验只在确实带视频时才放宽到 64 MiB。`k3-256k` 只接受图片、文档白名单外的容器、以及未文档化视频内容块的 **Anthropic 线路**，都会把视频降级为明确的文字说明而不是猜字段发出去；
- **`dynamically_loaded_tools`（仅 K3）已实现**：K3 接受**消息级工具声明**（`messages[].tools`），可在会话中途用「无 `content` 字段的 system 消息」注入完整工具定义。官方把「保持顶层 `tools` 字节稳定」列为该特性的目的之一——中途修改/删除已发出的声明会使缓存从该点起失效，而在末尾追加不影响已缓存前缀，所以这是提升缓存命中的正道。声明按请求重发（服务端不保留），且仅在模型声明该能力时发送；
- 额度卡片区分 **5 小时 / 7 天 / 月度（会员共享池）/ 月度（Kimi Code 池）** 四个窗口并显示重置时间，另可显示加油包余额；设置页为「设置 → 订阅服务 → Kimi Code」标签页，对话输入框右侧有该线路的额度胶囊。

**WorkBuddy 线路**

- 注册 `workbuddy-subscription` Provider，接入腾讯 **WorkBuddy / CodeBuddy 订阅**。该 ID 特意与用户常用的自定义 OpenAI 兼容线路 `workbuddy` 分开，安装插件不会覆盖或隐藏原有自定义 API。可直接扫描 CodeBuddy 桌面端已登录的 `*.info` 凭据，也可从设置页选择国区/国际区并通过官方浏览器授权添加账号；插件添加的凭据保存在系统加密存储中（Windows DPAPI / macOS Keychain / Linux Secret Service），token 只留在 Host 进程内，不进入浏览器；
- **多账号号池，与另外四条线路同源**：WorkBuddy 走共享内核 `AccountPoolCore`（`src/host/common/account-pool.ts`）并复用同一张设置卡片（`src/client/common/AccountPoolSection.tsx`），因此具备**顺序耗尽 / 轮询调度 / 粘性会话**三种策略、429 冷却换号、401/403 账号级失效（保留账号、重新登录即恢复）、设为主账号、账号备注、清除冷却与重新登录。桌面端扫描到的账号与插件内添加的账号**在同一号池里参与调度**；
- **桌面账号归 IDE 所有，不可删除**：卡片只对插件自己添加的账号显示「删除」，桌面账号显示「隐藏 / 恢复」——隐藏只把它移出本插件的调度，绝不改动 CodeBuddy 的凭据文件；号池层同样拒绝删除桌面账号（双保险，均有测试）；
- **续期后原子写回**原凭据文件（只改 `auth` 块），以免桌面端掉线——桌面账号的 refresh token 会轮换，若只写进插件自己的加密存储，IDE 手里就只剩一个已作废的 token。同一进程内的并发调用**共用一次刷新**，且不会二次刷新；
- 上游是 OpenAI 兼容的 `POST {backend}/v2/chat/completions`，但有两条硬约束：**只支持流式**（`stream:false` → 400 `code 11101`），且**首条消息必须是 system**（否则国际区返回 400 `code 11128`）。因此请求构造器始终发送 `stream:true`，并在调用方没给系统提示时补一条中性的，避免手搓的一次性请求踩到这条规则；
- **区域是凭据属性，不是请求属性**：`*.workbuddy.ai` / `*.codebuddy.ai` 走国际区 `https://www.<apex>`，其余走国区 `https://copilot.tencent.com`。账号卡片逐条标注每个账号的**国区 / 国际区**并允许选择；切换后，模型目录、额度和后续对话都使用该账号。历史凭据快照按账号身份自动去重。插件托管账号可真正删除；桌面扫描账号只能从本插件隐藏/恢复，永不删除 CodeBuddy 的原文件。两区模型清单不同，把模型发到不服务它的区会返回 400 `code 11102`，因此模型选择器**按当前账号区域过滤**；
- **模型目录取自网关自己的 `/v3/config`**（官方 CLI 启动时读的就是它）：每个模型的真实上下文上限、输出上限、是否接受图片、以及可用的思考档位都在这里，不做任何按模型名猜测。`/v1/models` 在这条线路上是 404，所以此前只能靠内置表——现在内置表只作为离线兜底，且是**从真实 `/v3/config` 转录**的（早期手写版本把 `glm-5.3`、`kimi-k3` 的窗口猜成 200K/256K，实际都是 1M）；
- 目录同时区分**默认服务的上下文长度**与**模型上限**（如 `deepseek-v4.1-flash` 默认 300K、最大 1M）。本线路不发送显式长度参数，所以 DSH 的压缩与溢出判断按**默认服务长度**计算，不会让请求越过后端实际接受的窗口；
- 思考档位**逐模型**取目录声明的档位表，回落顺序为「调用方显式指定 → 用户配置的默认档 → 目录为该模型声明的默认档」。最后一档不能省：上游在请求不带 `reasoning_effort` 时返回**空的 `reasoning_content`**（实测同一提示：不带字段 0 字符，带字段 130–215 字符），不发送就等于静默丢弃模型的思考。目录里的单个 `effort` 字段是**默认值**，既不是完整档位表也不是「只此一档」：实测这类模型接受 `low` / `high` / `max`，其余取值会被上游收敛到最近的档位，因此它们使用这三档的标准表（`WORKBUDDY_STANDARD_EFFORTS`）；显式声明了 `supportedEfforts` 的模型则原样采信。目录给出的**默认档**也可能落在档位表之外（如 `minimax-m3`、`kimi-k3`、国区 `glm-5.3` 都报 `medium` 却只有三档），这种值会被收敛到最近的档位——否则默认档会被判为不支持而丢弃，请求不带 `reasoning_effort`，上游返回**空的 `reasoning_content`**。不在该模型档位集合内的取值会被忽略而不是发出去（上游对不支持的档位返回 `code 11150`）；
- **瞬时失败按错误类别重试**（`src/host/workbuddy/adapter.ts`）。上游 5xx 与 `code 11134` 归为 `SERVER` 并走有界退避（最多 3 次，1.5s 起步、15s 上限、0.2 抖动）；额度耗尽（429 / `code 6004` / `code 14003`，其中 6004 的正文带重置时刻）归为 `RATE_LIMIT` 并遵守 `Retry-After`；而 401/403、跨区模型、不可用图片、历史形状错误都**不重试**，并给出可操作的提示（换模型 / 换图片 / 重新登录桌面端）；
- **流中断即失败**：上游必然以 `finish_reason` 或 `data: [DONE]` 结束，两者都缺失说明连接中途断开，此时抛出错误而不是把半截文本当成完整回答；
- 额度来自 `/billing/meter/get-user-resource`，卡片展示套餐名、本周期已用/上限、剩余额度与重置时间；设置页为「设置 → 订阅服务 → WorkBuddy」标签页，对话输入框右侧有该线路的额度胶囊。

**GLM（智谱 Coding Plan）线路**

- 注册 `zhipu-coding-plan` Provider，接入**智谱 / Z.ai 的 GLM Coding Plan 订阅**。该 ID 特意与用户常用的自定义 OpenAI 兼容线路 `zai` / `zhipu` 分开，安装插件不会覆盖或隐藏原有自定义 API；
- **订阅接口与开放平台是两套东西**：Coding Plan 的模型接口是 OpenAI 兼容的 `{base}/api/coding/paas/v4`，**不是** 通用付费的 `/api/paas/v4`——把开放平台的 Key 或后者当 base URL 用会被判为鉴权失败。国区（`open.bigmodel.cn`）与国际区（`api.z.ai`）的 Key **互不通用**，因此区域是**凭据属性**：添加时显式选择，卡片逐条标注，模型请求走该账号自己的 host；
- **添加 Key 前先验证**：`POST /zhipu/api/accounts/add` 先用该 Key 读一次部署自己的模型目录，未通过就不落盘，并直接告出「Key 大概来自哪个控制台」——这是这个产品最常见的一次配错。整个登录只花一次上游读（验证用的目录会被缓存）；
- **多账号号池，与另外四条线路同源**：走共享内核 `AccountPoolCore`（`src/host/common/account-pool.ts`）并复用同一张设置卡片（`src/client/common/AccountPoolCard`），因此具备**顺序耗尽 / 轮询调度 / 粘性会话**三种策略、429 冷却换号、账号级失效（保留账号、重新添加即恢复）、设为主账号、账号备注与清除冷却。账号 id 是 **Key 摘要 + 区域**，别名只显示「区域 + Key 后四位」，明文 Key 既不进别名也不进 id，更不会出现在卡片上（有测试锁定）；
- **模型能力逐模型查表**（`src/host/zhipu/model-catalog.ts`）：是否接受图片、有哪些思考档位、能否关闭思考都由该表决定，运行时以订阅侧 `GET /models` 为准（只覆盖上下文窗口，能力不被上游列表改写）。图片能力不能按族名推断——**`glm-5.3-flash` 接受图片而 `glm-5.3` 不接受**；档位也不能——`glm-5.3` 有三档而 `glm-5.2` 只有两档，`glm-4.7` / `glm-4.5-air` 这类 toggle 模型根本不收 `reasoning_effort`；
- **思考档位只发上游认的值**：上游对 GLM-5.x 只接受 `low` / `high` / `max`，其余取值**直接报错**（不是被忽略）。DSH 的档位词表比这宽，因此每个取值都先收敛到该模型自己的档位表再发出；收敛按**两套词表统一排序**，`minimal` 这类「比 low 更省」的档位会落到 `low` 而不是被当成未知值弹到中间档——否则用户选了最省的一档反而会换来 `high`，既不符合意图又更费额度。关闭思考的值本线路一律不发：GLM-5.3 / GLM-5.3-FLASH / GLM-4.7 把 `thinking.type: "disabled"` 判为错误，省略该字段就是它们的 `enabled` 默认；
- **额度来自订阅自己的监控接口**：`{base}/api/monitor/usage/quota/limit` 给 5 小时与每周两个额度窗口（外加月度 MCP 工具调用次数），`{base}/api/biz/subscription/list` 给套餐名。这两个接口的鉴权用的是**不带 `Bearer` 前缀的裸 Key**（实测：带前缀判 401，裸 Key 通过），与模型接口的 `Bearer` 形式不同，因此两条 header 各自成函数。窗口按上游的 `unit`/`number` 描述换算成分钟后再命名，兼容 `TOKENS_LIMIT` 与新版 `CREDIT_LIMIT` 两种拼写；
- **瞬时失败按错误类别重试**（`src/host/zhipu/adapter.ts`）：上游 5xx、`code 1230/1234` 与服务过载归为可重试并走有界退避（最多 3 次，1.5s 起步、15s 上限、0.2 抖动），429 会带上上游 `Retry-After`。而 **401/403 与 `code 1000/1003/1001`（Key 失效）、`code 1311`（套餐不含该模型）、`code 1309`（套餐已过期）明确不重试**——它们与「额度窗口用尽」同样是 429，但只有后者值得重试，因此分类读响应正文的 `code` 而不只看状态码，并给出可操作的提示（换模型 / 续费 / 重新添加 Key）；
- 模型勾选、思考深度、上下文窗口覆盖与额度在「设置 → 订阅服务 → GLM」标签页中配置，输入框右侧另有额度胶囊（取**最紧的那个窗口**，因为 5 小时窗口和每周窗口会各自先耗尽）。

**设置页**
- 展示账号（脱敏 email、套餐、账号 ID 后四位）、连接状态、额度与订阅增强功能开关；
- **偏好落盘位置随 harness 生成**：有 `settings.register` 的一代（≤0.1.6）仍写进 harness 的设置文档；0.1.7 起该 API 被 `SettingsForms` 取代，偏好改由插件自己持久化到 `<dshHome>/storages/dsh-chatgpt-subscription-preferences.json`（0600、原子写；读取失败或校验不过就回落默认值；**首次运行会从旧设置文档里本插件的段一次性迁移**），五条线路的模型开关同样从各自既有的 `storages/*-models.json` 水合，因此重启后不会像被重置；
- 子代理的模型与思考深度沿用 DSH 自身设置：**设置 → Subagent** 卡片授权 Agent 可以为子代理挑选的模型（来自 DSH 已接入的全部 Provider，包含本插件的 Codex / Antigravity），新 Agent 的默认路由由 DSH 的 `agent-default-model` 设置提供；
- 最大嵌套深度不在本插件设置内，由 DSH 侧决定：0.1.5 及以前是 preset 中 `tool-subagent` 行的 `maxDepth`（默认 3），0.1.6 起改由 `subagent` 服务的设置项提供（默认 1）；`provider-managed` 表示把预算交给进程外提供方；
- GPT-6 系列（6 Astra / 6 Sol / 6 Luna）默认使用 384K 有效上下文，可配置最高 872K；5.6 Sol / Terra / Luna 保持 272K，最高 1M，用于 DSH 压缩与溢出判断；其他模型保持目录声明值；
- 单次输出上限按模型区分：GPT-6 系列为 128K（官方对 6 Astra / 6 Sol / 6 Luna 均标 128K），更早的模型保持 32768；调用方未显式指定时生效，Responses 报文本身不发送输出长度参数。
- 可访问的进度条、窄窗口/200% 缩放布局、深浅主题与 reduced-motion。

## 模型目录

| 显示名 | 模型 slug |
| --- | --- |
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

GPT-6 系列（6 Astra / 6 Sol / 6 Luna）支持文本、图片输入和工具调用，默认思考档位为 `medium`，可选 `low`、`medium`、`high`、`xhigh`、`max`。从旧会话带入的 `none` / `minimal` 会按 [OpenAI 官方迁移说明](https://developers.openai.com/api/docs/guides/latest-model) 转为 `low`。三个模型的默认 384K 与上限 872K 均取自 2026-09-23 的 Codex 模型目录（`gpt-6-sol` / `gpt-6-luna` 于 2026-09-22 发布，能力与 `gpt-6-astra` 一致；目录里的 `context_window` 是 272K，本插件把默认有效上下文提高到 384K，仍低于 872K 上限）；[Codex Ultra](https://learn.chatgpt.com/zh-Hans/docs/models) 涉及客户端的子代理编排，本插件不将它作为 Responses 思考参数暴露。

新配置默认显示 GPT-6 系列与 GPT-5.6 系列；已有配置保留原来的模型勾选，可在 **设置 → Codex 订阅 → 可用模型** 中勾选 **6 Sol** / **6 Luna**。

## 环境要求

- Windows 或 Linux；
  - Windows：系统需提供 Windows PowerShell，以使用 CurrentUser DPAPI；
  - Linux：Host 用户必须拥有可写的 `~/.dsh`（或 `$DSH_HOME`），凭据文件会强制使用 `0600`、目录使用 `0700`；
- 已安装 DSH：peer 范围覆盖 0.1.2-alpha.5 及以后的 0.1.x（含 0.1.5-rc.2、0.1.6-alpha 与 0.1.7-alpha.1）。构建与测试以 **0.1.7-alpha.1**（npm 上 `@deepseek-ai/dsh` 的 `alpha`）为基线，旧版行为由版本兼容层保留：0.1.7 重写了会话消息模型（工具结果由 `tool-result` 内容块改为 `role: "tool"` 消息）、删除了 `settings.register`（偏好改由插件自有存储落盘）、并让 agent preset 不再从 `~/.dsh/.agent-presets` 读取，插件在请求边界、设置服务与 preset 注册三处同时适配，因此同一份代码可装在 0.1.2-alpha.5 以来的各代上。0.1.1-rc.2 不再声明支持——它既没有 preset 用到的 `present` 工具，`mode` 枚举那时也还写作 `code`；0.1.6 把 workflow 引擎改了包名，插件在 preset 同步时按当前安装自动适配（见下）；
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

**版本阶段**：`latest` 目前是 0.7.0；0.8.0 的正式版尚未定稿，先以 `0.8.0-alpha.0` 发到 `alpha` 标签，因此上面两条命令装到的仍是 0.7.0。要试用 alpha，需显式带上标签或版本号：

```sh
dsh plugin --profile web add @eddyskywalker/dsh-chatgpt-subscription@alpha
npm install @eddyskywalker/dsh-chatgpt-subscription@0.8.0-alpha.0
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

**搜索与抓取来源** 切换 DSH 的搜索后端；网页抓取后端在有可用代理时自动改用本插件。选择 ChatGPT 来源后，网页由本插件在 Host 抓取，并使用上述网络代理设置；纯 TUN 模式可使用直连，流量由虚拟网卡接管。来源切换即时生效，DSH web 服务重载后会重新注册插件后端，并保留切回 DSH 默认来源所需的配置。

**网页抓取后端（web_fetch）** DSH 内置抓取 provider 会先解析域名、校验并固定解析结果，而且只在进程环境变量里读到代理时才走代理——系统代理对它不可见。代理工具（Clash/Mihomo 等）常把域名解析成自己的 fake-ip 地址（默认 `198.18.0.0/15`），于是内置 provider 直接以 `WEB_BLOCKED_URL`（resolves to a non-public IP address）拒绝，代理根本没被用上。因此只要插件配置了可用代理（**网络代理** 选系统代理且检测到，或填写自定义代理），`web_fetch` 就改用本插件的 provider：由代理解析源站，与 DSH 对“走代理的请求”采用的语义一致；未配置代理时仍由 DSH 内置 provider 抓取，保留其解析与固定策略。若在纯 TUN 模式下把代理设为**直连**，内置 provider 会重新接管，此时可改回系统代理让插件接管抓取。代理如果在 DSH 启动之后才可用（代理工具后启动，或首次探测失败），插件会在下一次探测到代理时重新选择抓取后端，不必重启或改设置。

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

守卫装在 DSH 工具注册表的调度入口上，因此 **`run_code`（代码模式 / PTC）里通过 SDK 调用的 `tools["subagent"]` 同样被拦截**：该子调用走的是与直接调用相同的 `prepare → guard → dispatch` 流水线，拒绝理由以 `ToolCallError` 抛回程序。也就是说模型无法靠把委派写进代码里绕过白名单（`test/subagent-model-authorization-ptc.test.ts` 用真实 `ToolRuntime` + 假 code runtime 验证了放行、缺省拒绝与越权拒绝三条路径）。

配置项（插件行 `config`，全部可省略）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `subagentModelAuthorization` | `true` | 是否启用上述授权守卫；设为 `false` 回到 DSH 原有行为 |
| `subagentModelTools` | `['subagent']` | 需要授权的委派工具名；preset 里自定义了 `toolName` 时在此列出 |
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

**每日自动签到**（仅国区；语义与 workbuddy2api 的 `daily_checkin.py` 对齐）：DSH 启动时自动签到一轮，运行期间每 10 分钟幂等补检（当日已签的账号不再发请求）；签到前先查签到状态，token 过期会自动续期并回写（桌面账号写回 CodeBuddy 自己的凭据文件）。失败当天最多自动重试 3 次，活动无权益的账号当天不再打扰；国际区账号不参与（国际后端没有签到活动）。**DSH 没开机的当天不会签到**——插件不是常驻服务。设置页「每日签到」区块可开关自动签到、查看「今日已签 x/y」并手动「立即签到」。签到状态存在 `storages/workbuddy-checkin.json`，token 不出 Host。

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
| POST | `/checkin/now` | 立即执行一轮每日签到（忽略时间窗，当日已签的账号仍跳过） |

与其它线路一样，所有修改状态的路由只接受同源 JSON POST，并校验 `Origin` 与 `Host`。

## GLM（智谱 Coding Plan）线路

1. 在你要用的平台上订阅 **GLM Coding Plan**，并在对应控制台创建 API Key：[Z.ai](https://z.ai/manage-apikey/apikey-list)（国际区）或 [智谱开放平台](https://open.bigmodel.cn/)（国区）；
2. 重启 DSH，让 Host 加载本插件；
3. 打开 **设置 → 订阅服务 → GLM**；
4. 在「添加账号」里**先选区域**（国际区 / 国区），粘贴 Key 后点「保存并验证」——验证不通过就不会写入，并会提示 Key 应来自哪个控制台；
5. 按需勾选模型、设置默认思考深度与上下文窗口。

`zhipu-coding-plan` 会像其他 Provider 一样出现在 DSH 模型选择器中，并可与名为 `zai` / `zhipu` 的自定义 API 同时存在。**上下文窗口**默认取该模型官方声明的窗口（GLM-5.x 系列为 1M），可逐模型覆盖（用于 DSH 的压缩与溢出判断，支持 `1M` / `512K` / `200000` 等写法）；**默认思考深度**只对该模型声明了档位时生效，选项为上游真正接受的 `low` / `high` / `max`。

**上游接口**（前缀 `{base}` 为该账号区域的 host）：

| 用途 | 路径 | 鉴权 |
| --- | --- | --- |
| 模型生成 | `POST {base}/api/coding/paas/v4/chat/completions` | `Authorization: Bearer <Key>` |
| 模型目录（也是添加 Key 时的验证接口） | `GET {base}/api/coding/paas/v4/models` | `Authorization: Bearer <Key>` |
| 额度窗口 | `GET {base}/api/monitor/usage/quota/limit` | `Authorization: <Key>`（**无 `Bearer`**） |
| 套餐信息 | `GET {base}/api/biz/subscription/list` | `Authorization: <Key>`（**无 `Bearer`**） |

两区 host 分别是 `https://open.bigmodel.cn`（国区）与 `https://api.z.ai`（国际区）。请求只带本插件自己的 UA，不冒充官方客户端。

### 插件路由（GLM Coding Plan）

所有路由都以 `/zhipu/api` 为前缀：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/status` | 账号、额度、模型目录与路由归属 |
| POST | `/accounts/add` | 验证并保存一个 API Key（可选 `alias`） |
| POST | `/accounts/remove` | 删除当前账号（单凭据模式） |
| POST | `/accounts/action` | 号池动作：`set-primary` / `set-alias` / `delete` / `clear-cooldown` / `clear-auth-failure` / `strategy` |
| GET / POST | `/quota` | 强制刷新额度（POST）或读取当前状态（GET） |
| GET / POST | `/models`、`/settings` | 读取或更新勾选模型、上下文窗口、默认思考深度与选中账号 |
| POST | `/catalog/refresh` | 强制刷新模型目录 |
| POST | `/connection/test` | 向上游对话接口发一次最小流式请求测试连接 |

与其它线路一样，所有修改状态的路由只接受同源 JSON POST，并校验 `Origin` 与 `Host`；响应里永远不含 API Key（只含 Key 后四位）。

## 安全边界

Antigravity 的 access token / refresh token 使用独立的系统凭据存储：Windows 使用 CurrentUser DPAPI（`$DSH_HOME/storages/antigravity-oauth.json.dpapi`），macOS 使用登录钥匙串，Linux 使用 Secret Service。macOS / Linux 的服务名为 `dsh-antigravity`，账号键按旧凭据文件的绝对路径生成，隔离不同的 `DSH_HOME`。

**WorkBuddy token 仅在 Host 内处理，从不进入浏览器**（`/workbuddy/api` 响应不含 `accessToken` / `refreshToken`，有测试锁定）。桌面扫描账号仍使用 CodeBuddy 自己的登录态文件：续期只原子写回其 `auth` 块；从本插件删除时只隐藏/恢复，绝不删除原文件。通过浏览器授权添加的账号归本插件所有，保存在独立系统凭据存储中：Windows CurrentUser DPAPI（`$DSH_HOME/storages/workbuddy-accounts.json.dpapi`）、macOS 登录钥匙串、Linux Secret Service；这类账号可在设置页真正删除。

**GLM Coding Plan 的 API Key 同样只在 Host 内处理，从不进入浏览器**（`/zhipu/api` 响应只含后四位提示，不含 Key 本身，有测试锁定）。它保存在独立系统凭据存储中：Windows CurrentUser DPAPI（`$DSH_HOME/storages/zhipu-credentials.json.dpapi`）、macOS 登录钥匙串、Linux Secret Service；号池另用一份同样加密的文件 `$DSH_HOME/storages/zhipu-pool.json`，账号 id 与别名都只是 Key 的摘要与后四位。

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

`vitest.config.ts` 把 `testTimeout` 设为 60s、`maxWorkers` 限到 4 是有原因的，改回去会让套件重新变得不稳定：多条目测真的会 spawn `powershell.exe` 跑 Windows DPAPI 凭据存储，隔离测量最慢的一条要 12–14s。超时余量不够时不只是那一条失败——**超时后仍在飞的请求会落进下一个用例的 fetch mock**，把邻居也判失败（表现为 `expected to be called 4 times, but got 8 times`）。限并发不增加耗时：这些用例受子进程延迟约束，4 个 worker 约 51s，15 个约 54s。

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
| Kimi Code 账号一栏为空 | 账号身份取自 OAuth token 自身的 JWT 声明，套餐名取自 `/me`（`/usages` 自 2026-09 起不再返回 `user_level_name`）。重新登录或点「刷新用量」即可写入；若仍为空但显示「已登录」，点「测试连接」可确认凭据是否仍被接受 |
| GLM 添加 Key 报「rejected the API key」 | Key 与所选**区域**不匹配，或它不是 Coding Plan 的 Key。错误文案会指明应来自哪个控制台（`api.z.ai` 或 `open.bigmodel.cn`）：换区域重试，并确认订阅生效；开放平台按量付费的 Key 在订阅接口上不被接受 |
| GLM 报 `code 1311`（套餐不含该模型） / `code 1309`（套餐已过期） | 这两个都是账号权益问题而非瞬时故障，插件不会重试：前者换一个模型，后者去官网续费。两者与「额度窗口用尽」共用 429 状态码，插件按响应正文的 `code` 区分处理 |
| GLM 报 `code 1214`（参数被拒） | 多为该模型不支持的思考档位或不可读的图片：`glm-5.3` 不接受图片（用 `glm-5.3-flash`），档位只有 `low` / `high` / `max`。卡片只会列出该模型真正声明过的能力 |
| GLM 额度显示为空或「该账号没有可用的配额数据」 | 监控接口可用但该账号没有生效的套餐；确认订阅已开通，再点「刷新用量」。卡片会同时显示接口本身的失败原因（如 401 / 5xx 文案） |
| GLM 模型不出现在选择器里 | 卡片上若显示「模型路由已被其他 Provider 占用」，从占用方（自定义的 `zai` / `zhipu` 线路）移除该 Provider，插件会在下一次路由变更时自动接管；否则检查是否勾选了模型 |
| Kimi Code 发送视频却没有画面 | `k3-256k` 不支持视频，切到 `k3` 或 `kimi-for-coding`；容器须在白名单内（mp4/mpeg/mov/avi/x-flv/mpg/webm/wmv/3gpp）；若该模型走的是 Anthropic 线路，视频会降级为文字（该协议没有文档化的视频块）。以上情况模型都会收到明确的文字说明，据此向你说明而不是凭空回答 |