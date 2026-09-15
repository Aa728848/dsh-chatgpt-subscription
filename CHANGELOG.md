# Changelog

## Unreleased

- 新增 Kimi Code（Kimi For Coding 订阅）线路：注册 `kimi-code` Provider，把 Moonshot 的 Kimi Code 订阅作为本插件第四条线路接入 DSH。Kimi Code 与 Moonshot 开放平台（pay-as-you-go）是**两套互不通用的系统**：订阅走 `https://api.kimi.com/coding/v1`、凭据来自 `auth.kimi.com` 的 OAuth；开放平台的 key 与 base URL 在订阅端会被判为 `401 Invalid Authentication`，插件据此把两者严格分开。
- OAuth 采用 RFC 8628 设备码流程（`src/host/kimi-code/oauth.ts`），复刻官方 CLI 的协议细节：`POST /api/oauth/device_authorization` 只带 `client_id`（公共客户端，**无 client secret、无 PKCE、无 scope**），`POST /api/oauth/token` 轮询用 `grant_type=urn:ietf:params:oauth:grant-type:device_code`；令牌响应字段（`access_token` / `refresh_token` / `expires_in` / `scope` / `token_type`）与官方实现逐字段对应。`slow_down` 按 RFC 把轮询间隔永久 `+5s`；`authorization_pending` 继续等待；`expired_token` **不当作失败**，而是像官方 CLI 一样重新申请设备码（用户授权慢了仍能登入）；`access_denied` 单独分类。设置卡展示用户码、一次性链接与到期时间，可复制用户码、可取消。
- 令牌自动续期：阈值取 `max(300s, expires_in × 0.5)`（与官方一致），同一进程内并发调用**共用一次刷新请求**（避免订阅侧并发轮换同一 refresh token）；被拒的 refresh token 记入进程级 tombstone 并进入 5 分钟冷却，之后直接提示重新登录而不是反复打扰服务端。
- **重试语义按错误类别区分**（`src/host/kimi-code/adapter.ts` 的 `classifyKimiFailure`），这是本线路的关键设计：服务把多种含义压进同一个状态码，因此分类读取响应正文而不只看状态码。
  - **会重试**：任意 5xx（含截图里那条 `502 {"error":{"message":"Upstream model provider is temporarily unavailable. Please try again in a moment.","type":"server_error"}}`——上游模型供应商瞬时故障，与账号、模型、凭据都无关）；真正的 429 背压（`We're receiving too many requests`、`The engine is currently overloaded`）；连接层失败（`TRANSPORT`）；流停滞（`TIMEOUT`，由 idle watchdog 触发）。策略固定为 `maxRetries: 3`、`retryableCodes: ['RATE_LIMIT','SERVER','TIMEOUT','TRANSPORT']`、1.5s 起步、15s 上限、0.2 抖动，并**honor `Retry-After`**（作为 `providerRetryAfterMs` 随错误上抛，由 DSH 重试策略原样等待）。402（`unable to verify your membership benefits`）被官方描述为「通常是暂时问题」，同样归类为可重试。
  - **不重试**：401 里其实是**套餐权限**被拒的情况（`does not have access to k3`、`supports only … up to … context`、`model id does not exist`）——与真正凭据失效分开，前者提示换模型/降上下文/升级套餐，后者才提示重新登录；403 的各类账号额度上限（5 小时 / 7 天 / 月度共享池 / 并发上限），提示等待重置或加油包；**配额耗尽型的 429**（`exceeded_current_quota_error`、`insufficient balance`、`please recharge` 等）——这与背压型 429 是两回事，重试只会白白消耗请求并推迟用户该看到的提示；以及 400 请求格式错误。
- K3 系列行为按其官方文档精确实现（`src/host/kimi-code/mapper.ts`）：
  - **思考档位只发 `low` / `high` / `max`**，其余输入被收敛映射（`ultra`/`max`/`xhigh`→`max`、`high`/`medium`→`high`、`low`/`minimum`/`light`→`low`、`none`→`thinking:{type:'disabled'}`），未知档位**不发送**而不是发出去吃 400；Anthropic 线路映射为 `thinking` 预算（low 2048 / high 8192 / max 16384），预算放不下时不启用。
  - **当思考开启时，带工具调用的 assistant 消息必须回传 `reasoning_content`**，否则服务返回 400 `thinking is enabled but reasoning_content is missing in assistant tool call message`。本线路因此**保留 reasoning 块**（同插件的其他线路是丢弃的，因为那些上游要求签名），无工具调用的普通回复则不回传。
  - **不发送 `temperature`**：采样参数按模型固定（1.0 / 0.95 / n=1），服务对显式值直接报错而非钳制，因此调用方的 temperature 被有意丢弃；输出上限统一用 `max_completion_tokens`（旧字段会被服务归一化掉）。
  - 工具调用 id 截断到服务要求的 **64 字符**上限。
  - 发送 `prompt_cache_key`（由首轮用户消息推导的稳定会话标识），让续接的会话能命中前缀缓存；模型或思考档位切换会使缓存失效。
- 模型目录为官方四款订阅模型（`src/host/kimi-code/model-catalog.ts`）：`k3`（1M 上下文，需 Allegretto+；Moderato 上限 256K，故默认按 **256K** 计算以免会话悄悄超出后被 401 拒绝，可用上下文覆盖升到 1M）、`k3-256k`（固定 256K、无视频输入）、`kimi-for-coding`（K2.8 Preview，各套餐均 1M，默认档位 max）、`kimi-for-coding-highspeed`（约 6× 输出速度、3× 额度消耗，需 Allegretto+）。运行时仍以 `GET /v1/models` 为准（含每模型 `context_length`、`think_efforts`、`supports_image_in`），30 分钟缓存、可手动刷新、离线回落内置表。
- 额度卡片读取 `GET /v1/usages`：5 小时 / 7 天 / 月度（会员共享池）/ 月度（Kimi Code 池）四个窗口各自显示百分比与重置时间——把两个月度池**分开标注**，因为共享池耗尽时即使 Code 池还有余额也会被拒；加油包（booster wallet）按服务的定点数换算（1e-6 分，正数不足 1 分记 1 分；`priceInCents` 已是分，不再二次换算）。同时容忍社区记录到的另一种 `usage` + `limits[]` 形状，且从 `used`/`limit` 推导比例，避免服务换形状时卡片直接空白。账号资料取自 `/me`，失败只降级为「已登录但无资料」而不影响额度。
- OAuth 凭据只存 Host：Windows CurrentUser DPAPI、macOS 登录钥匙串、Linux Secret Service（与 Antigravity / Command Code 同一存储栈），明文 JSON 仅作迁移来源；存储的 oauth/API 主机需为绝对 https 源，防止被篡改的凭据文件把刷新请求指向他处。
- 新增 `/kimi-code/api` 设置路由（status / login / login/status / login/cancel / logout / quota / models / settings / catalog/refresh / connection/test），改状态的操作只接受同源 JSON POST；设置页新增「Kimi Code」卡片，对话输入框新增该线路的额度胶囊（最短窗口优先，余额兜底）。
- 修复 Kimi Code 已登录后账号显示为 `—`、以及刷新用量与实际状态不符的问题，根因是三个独立缺陷：
  - **账号资料接口不存在**。此前 `fetchUserInfo` 会去请求 `/coding/v1/me`，而该端点在订阅侧并未提供，非 2xx 时静默返回 null，于是卡片永远是空白。Kimi 的 access/refresh token 本身是 **JWT**，账号身份（`user_id` 优先、`sub` 兜底、`email` 小写化）就在其 payload 里——现在从 token 解码得到账号并在登录时落盘（刷新时也会补齐旧凭据缺失的声明），卡片不再依赖任何网络调用即可显示已登录身份；套餐名仍以 `/usages` 返回的 `user_level_name` 为准并写回凭据。
  - **测试连接按钮没有任何反馈**。`/connection/test` 的处理函数**缺少 return**，响应永远不会结束（按钮点了没反应）；而且探测目标正是那个不存在的资料接口。现在改为以真实的 `/usages` 调用作为探测（200 即证明凭据可用，同时顺带刷新额度卡片），并在卡片上显示结论与延迟。
  - **刷新用量会把失败吞掉**。`/quota` 与 `/status` 都用 `.catch(() => null)` 包住上游错误，于是上游 401/403/5xx 时接口照样返回 200 空数据——这正是「刷新不正常」的观感：按钮看似成功、面板依旧为空。现在显式刷新会把真实原因以 502 + 文案返回，背景刷新则通过新的 `quotaError` 字段随状态一起展示，既说明原因又不隐藏已登录账号；对 `/usages` 的 401 也改为抛出类型化的未授权错误（此前是普通 Error），使「凭据失效」与「服务瞬时故障」在测试连接里能被区分。
- 修复 Kimi Code 套餐一直显示为空，并补齐模型能力展示（新增 `test/kimi-code-plan.test.ts`，19 条）：
  - **套餐名的来源是 `/me`，而它被我上一轮误删了**。Kimi **在 2026 年 9 月把 `user_level_name` 从 `/usages` 里移除**，因此 `/usages` 不再返回套餐名——而该字段正是我当时唯一的来源。现在恢复调用 `GET /coding/v1/me`（仅用 OAuth 访问令牌，不导入粘贴的套餐 key；4 秒超时、失败只降级不影响卡片），并保留 `/usages` 作为回退；两者都拿不到时再读凭据里缓存的套餐名。
  - 新增**会员等级代码映射表**：`LEVEL_STANDARD`/`LEVEL_MODERATO` → Moderato、`LEVEL_INTERMEDIATE` → Allegretto、`LEVEL_ADVANCED` → Allegro、`LEVEL_PREMIUM` → Vivace（旧代码 `LEVEL_FREE`/`LEVEL_BASIC` → Adagio、`LEVEL_ANDANTE` → Andante 也一并支持）。此前若服务只发机器代码，卡片会显示原始枚举；现在映射为 Kimi 定价页使用的名称。昵称同样从 `/me` 读取。
  - **修复 `buildModelOptions` 丢弃目录能力的问题**：`supportsVideo` 与 `minimumPlan` 此前被硬编码为 `false`/`null`，`description` 恒为 `null`——即实时目录与静态注册表已知的信息被直接丢掉。现在按「实时目录 > 静态注册表」取值，视频输入标记与描述都能正确显示。
- 关于截图里两个特殊能力的说明（已核对官方文档与实测资料，并据此决定是否接入）：
  - **视频输入**：`k3` 与 `kimi-for-coding` 确实支持视频，`k3-256k` **只支持图片**。但 **DSH 的模态词汇表只有 `text` 与 `image` 两项**（`ModelModalityMap`），没有 video——若谎报支持视频，DSH 会把无法投递的字节交给该线路。因此**不将其声明为可发送模态**，只在模型提示与能力行中如实标注，避免误导。
  - **`dynamically_loaded_tools`**：这是 K3 的独有能力，允许在会话中途以「不含 content 的 `system` 消息 + `tools` 数组」注入额外工具定义，从而让顶层工具列表保持小而稳定（`system`/`tools` 属于缓存前缀，改动会使整个前缀缓存失效）。DSH 没有对应概念，本插件也无法从适配器层注入消息，因此**仅作展示说明**，不实现——这也解释了为什么官方把工具集稳定性作为优化建议。
- 依据官方文档与实测数据补齐 K3 系列的能力、参数与优化（新增 `test/kimi-code-k3.test.ts`，31 条）：
  - **保留思考 (Preserved Thinking) 默认开启**。官方 CLI 的默认是 `[thinking] keep = "all"`，即服务会跨轮保留推理内容——其错误参考里要求「每个缺 `reasoning_content` 的 assistant 消息都要补上」正以此为前提。此前我们只在**带工具调用**时回传 `reasoning_content`，普通文本轮次不带，这既与官方 `keep=all` 的约定不符，也在长会话里丢失了多轮推理的连贯性。现在思考开启时（含未显式指定档位，因为模型默认就推理）**每条 assistant 消息都写该字段**，无推理时写空串（服务要求的正是空值而非省略）；思考关闭则完全不写。可用 `DSH_KIMI_CODE_PRESERVE_THINKING=0` 关闭，卡片会显示当前状态。
  - **输出上限改为跟随上下文窗口**（`maxOutputTokensFor(modelId, contextWindow)`）。`reasoning_content` 计入输出，而此前固定 32768 的上限会把 `max` 档的长思考**中途截断**并返回 `length`；官方客户端是按窗口封顶（并夹到 窗口 − prompt）——这正是官方文档所说「官方 kimi-code 行为」的 `computeCompletionBudgetCap`。现在按窗口封顶并保留 4096 余量，同时不低于模型声明的下限，避免小窗口把答案饿死。
  - **新增请求前夹取**（`clampOutputToContext` + `estimatedInputTokens`）：调用方若已知 prompt 规模，`max_tokens` 会被下调到 prompt + 输出可容纳；prompt 规模未知时**不做猜测**——猜小会截断推理、猜大被直接拒绝，只有服务知道真实大小。
  - **请求体超过 2 MB 时本地拒绝**（`assertRequestBodyFits`）。这是该端点最常被触发的 400（`total message size N exceeds limit 2097152`），官方文案不给出路；现在按真实序列化体积判断并直接提示「压缩会话/开新会话、检查大工具结果与图片」，既给出可操作建议也省掉一次注定失败的往返。
  - **stop 序列按服务的硬上限裁剪**：最多 5 条、每条不超过 32 字节。超长的序列**整条丢弃而不是截断**——截断后的停止串会在错误位置终止生成，静默改变答案是比不停止更糟的结果。
  - **新增缓存与 K3 调优卡片**：滚动统计命中/新处理的 prompt tokens、输出 tokens 与**缓存命中率**。Kimi 的缓存按内容哈希自动命中、无需也无法手动声明（实测 `prompt_cache_key` 与 Anthropic `cache_control` 标记均被忽略），所以读缓存比例是唯一能证明缓存真的生效的证据；卡片同时说明「同一会话内系统提示与工具列表一旦变化会使整个前缀缓存失效，应保持工具集合稳定、把新增内容追加在末尾」。
  - 澄清并锁定一个此前的错误假设：`prompt_cache_key` 在订阅端**完全是 no-op**（实测：设与不设、相同与不同 key 均命中同一缓存）。我们仍发送它（与官方 CLI 行为一致且无害），但代码注释已改为如实说明，不再声称它能提高命中率。
- 新增 `test/kimi-code-identity.test.ts`（15 条：JWT 解码、`user_id` 优先于 `sub`、邮箱归一化、不透明 token 回退、账号解析与套餐来源、刷新补全身份、连接测试的成功/401/5xx 三分支）与 `test/kimi-code-routes.test.ts`（8 条：无额度时仍显示账号、status 携带 `quotaError`、显式刷新的成功与失败、连接测试的结论与延迟、未登录拒绝、目录与启用集合）。
- 新增 79 条单测：`test/kimi-code-oauth.test.ts`（设备码请求只带 client_id、区域主机切换、`expires_in`/`interval` 缺省回落、刷新对 502/429 的重试与对 401/invalid_grant 的立即失败、刷新阈值下限、并发共用刷新、被拒令牌不再重试）、`test/kimi-code-mapper.test.ts`（档位映射全表、未知档位不发送、temperature 被丢弃、`reasoning_content` 仅在带工具调用时回传、cache key 稳定、两条线路的请求形状与流式解码、usage 与工具增量拼接）、`test/kimi-code-adapter.test.ts`（重试策略取值、上文那类 502 判定为可重试、配额型 429 不重试、403 额度与 401 权限/凭据的区分、`Retry-After` 透传、目录与上下文覆盖）、`test/kimi-code-quota.test.ts`（四窗口标签与重置时间、字符串比例、越界钳制、两种响应形状、定点数换算、套餐名解析、模型目录能力）。
- 在 `README` 增补 Kimi Code 线路说明与故障排查条目，并更新客户端注册用例以覆盖新增的设置区块与额度胶囊。

- 修复 Command Code 额度卡片显示 `meter-1` / `meter-2` 的问题：`/alpha/billing/credits` 的窗口是按名字键控的（`windowLimits.fiveHour` / `weekly`），记录本身**只有数字没有名称字段**，此前的通用扫描找不到可用的 id/label，只能回退到序号占位。现在按名字读取该区块并套用官方 CLI 同款标签（`5-hour` / `Weekly`，另支持 `daily` / `monthly`），排序固定为最短窗口在前；`credits.monthlyCredits` / `purchasedCredits` / `freeCredits` 三笔余额也各自成条。通用扫描保留为兜底，并改为按对象身份跳过已读记录，避免同一份数据被重复上报。
- 修复 Command Code 套餐名称为空的问题：服务只在订阅（或账单）里给出机器 id（`individual-goat`），`/alpha/whoami` 完全不提套餐，因此卡片一直是空白。新增 `src/host/command-code/plans.ts`，转录官方 CLI 的套餐表（Go / GOAT / Pro / Pro / Provider / Max / Ultra / Teams Pro 及各自月度额度），按**最长前缀**匹配——`individual-pro` 同时是 `individual-pro-v1` 与 `individual-provider` 的前缀，按最短匹配会把 Provider 误判成 Pro；同时按服务实际大小写与 `_`/`-` 混用做归一化，未识别的 id 原样显示而不是隐藏。
- 额度卡片同时补齐订阅状态与续费日期（`active` / `trialing` / `past_due` 等）与套餐月度额度；余额解析此前查 `credits` 只会命中外层对象而返回 null（这也是余额一直空白的原因），现按三个池求和。
- 修正无名称的额度条目不再被静默丢弃：仍会展示，但改用可读标签（`Extra allowance`）与说明，而不是此前既不可读、又可能掩盖真实额度的 `meter-N`。
- 新增 `test/command-code-quota.test.ts`（13 条），fixture 为**从真实账号抓取的原样响应**：套餐名解析（含最长前缀与归一化）、订阅状态与周期、5 小时/周窗口的标签与毫秒级 resetAt 保真、窗口排序、三个余额池求和、无名称额度标签，以及 usage/summary 不产生伪额度。
- 修复 Command Code 线路按“厂商/模型名前缀”猜测模型能力的错误做法：模型是否支持图片输入、支持哪些思考深度，都改由官方 CLI 自带的模型能力表（`src/host/command-code/model-catalog.ts`）逐模型查表决定，未知模型回落到纯文本。此前的前缀启发式把 **DeepSeek V4.1 Flash 这类真正的视觉模型判成了纯文本**，导致设置页不声明图片能力、DSH 不会把粘贴的图片交给该线路。同类错误还有多处：`moonshotai/Kimi-K3`、`xai/grok-4.5`、`xai/grok-4.6`、`MiniMaxAI/MiniMax-M3`、`Qwen/Qwen3.8-*` 都被误判为纯文本；而 `deepseek/deepseek-v4-flash`、`deepseek/deepseek-v4-pro`、`zai-org/GLM-5.3` 才是纯文本——同一个厂商内部两种都有（`z-ai/glm-5.3-flash` 支持图片，`zai-org/GLM-5.3` 不支持），前缀判断无法区分。
- 思考深度同样改为查表：此前用 `['low','high','max']` / `['minimal','low','medium','high']` 等族级猜测覆盖所有模型，现在逐模型取注册表声明的集合（例如 `claude-*` 是 `low,medium,high,xhigh,max`，`gpt-5.4-mini` 是 `low,medium,high`，`deepseek/deepseek-v4-pro` 是 `high,max`，`claude-haiku-4-5` 与多数 Kimi/Qwen 模型没有思考档位）。
- 因此新增 `xhigh` 与 `minimal` 两个思考档位：`CommandCodeReasoningEffort` 联合类型、设置卡下拉、路由校验与偏好 schema 一并放开；Anthropic 线路的 `xhigh` 映射为 24576 thinking 预算（介于 `high` 16384 与 `max` 32768 之间），`minimal` 为 1024。
- 修复输出上限被误降到族级默认值的问题：注册表只为 5 个条目声明了 `maxTokens`，此前其余模型一律落到 32768。现在未声明的模型按多 provider 一致的 `limit.output` 补齐（Claude/GPT 系列 64K–128K、DeepSeek 384K、Kimi K3 131072、Grok 500K 等），注册表声明值优先。
- 新增 12 条用例锁定上述行为：逐模型模态（含 `deepseek-v4.1-flash` 支持图片、`deepseek-v4-flash` 不支持、GLM 同厂商正反例、Kimi/Grok/MiniMax/Qwen 视觉模型）、未知模型回落纯文本、逐模型思考档位（含空档位与 `xhigh`）、输出上限三级优先级，以及适配器对视觉模型发送内联图片的端到端路径。
- 新增 Command Code Provider（`command-code`），把 Command Code 的 Provider API 作为本插件的第三条线路接入 DSH：Anthropic 格式模型走 `https://api.commandcode.ai/provider/v1/messages`，其余（开源模型与 GPT 系列）走 `.../chat/completions`，两条线路各自把 DSH 的消息 / 工具 / 图片 / 流式协议映射到对应线上格式。模型 id 决定线路（`claude-*` 为 Anthropic），因为该 API 会拒绝把模型发到格式不符的端点。
- 浏览器登录复刻官方 CLI 的回环回调契约：本机 `127.0.0.1:5959` 起一次性回调服务器（端口占用时顺延，最多 10 个），打开 `https://commandcode.ai/studio/auth/cli?callback=…&state=…&mode=redirect`，Studio 页面以跨域 POST 回传 `{apiKey,state,userId,userName,keyName}`。因此回调端点实现了 CORS 预检（含 Chrome 的 `Access-Control-Allow-Private-Network`）、10 KB 体积上限、`state` 校验、授权拒绝（`access_denied`）路径，以及成功后 303 跳转到 `/callback/complete` 的人工可读页面。另提供“手动填写 API Key”入口作为无浏览器环境的兜底；两条路径都先用 `/alpha/whoami` 验证再落盘。
- 新增 `/command-code/api` 设置路由（status / login / login/status / login/apikey / logout / quota / models / settings / catalog/refresh / connection/test），修改状态的操作只接受同源 JSON POST。
- 设置页新增「Command Code」卡片：账号与密钥信息、连接状态与路由归属、模型勾选（含该模型走的线路）、默认思考深度、逐模型上下文窗口覆盖、额度与用量；对话输入框新增 `command-code` 线路的额度胶囊。
- 模型目录取自公开的 `/provider/v1/models`（含每个模型的 `context_length`），30 分钟缓存、可手动刷新；离线时回落到内置目录。上下文窗口默认取目录值，可逐模型覆盖（用于 DSH 的压缩与溢出判断）。
- 额度来自 `/alpha/billing/credits`、`/alpha/billing/subscriptions`、`/alpha/usage/summary` 与 `/alpha/whoami`：各线路独立容错（一条失败不影响其余），解析器按“带 limit/used/百分比的对象”通用识别而不绑定某个具体响应 schema，识别不出时给出空态而不是伪造 0%。
- Command Code 凭据（API Key）与 Antigravity 一样只存 Host：Windows 使用 CurrentUser DPAPI（`$DSH_HOME/storages/command-code-credentials.json.dpapi`），macOS 使用登录钥匙串，Linux 使用 Secret Service；明文 JSON 仅作为迁移来源，读取后加密回写并删除。凭据不会进入浏览器、`settings.yaml` 或日志。
- `command-code` 路由可能已被其他适配器占用（例如内置 `llm-pi-ai` 用同一端点声明过同名 Provider），而 DSH 的 `registerAdapter` 对重复路由是 all-or-nothing 并抛 `DUPLICATE_ADAPTER`。插件因此把注册做成“可用即接管”：冲突时不让插件加载失败，只在设置页显示路由归属与冲突原因，并监听 `llm/adapters-updated`——原占用方释放该路由后自动接管，无需重启。
- 新增 Kimi 系列的两项「能力补齐」（`src/host/kimi-code/modalities.ts`）：
  - **视频输入真正可用**，不再只是提示文字。DSH 的 `ModelModalityMap` 只有 `text` / `image`，但它是**可合并扩展的接口**，因此本插件用 TypeScript 模块增强把它扩成 `text` / `image` / `video`（`ContentBlockMap` 同理新增 `video` 块）——**没有改动 DSH 任何一行代码**，增强只存在于本插件的编译单元里。此前 `k3` / `kimi-for-coding` 的视频能力只能在设置卡里显示为说明文字；现在它是真实模态：`resolveModel` 会声明 video，适配器会把 `{ type: 'video', attachment }` 映射成服务文档的 `{ type: 'video_url', video_url: { url: 'data:video/mp4;base64,…' } }`（`api.kimi.com/coding` 的 OpenAI 线路）。
  - 视频与图片**各有独立预算**：图片仍是文档的 2 MB 上限，视频按自己的 48 MiB base64 预算按「最旧优先」省略（一个视频片段就远超整段对话的图片额度，共用一个预算会让图片永远发不出去）；请求体校验也据此只在**确实携带视频**时才放宽到 64 MiB，纯文本/图片请求仍按 2 MB 本地拦截。
  - **不臆造未记录的字段**：`k3-256k` 只接受图片，选中它时视频会降级为明确的文字说明（提示改用 k3/kimi-for-coding）；不在文档容器白名单内的格式（白名单来自官方 vision guide：mp4/mpeg/mov/avi/x-flv/mpg/webm/wmv/3gpp）同样降级并说明；而 **Anthropic Messages 线路没有文档化的视频内容块**，因此走该线路时视频一律降级为文字而不是猜一个字段名发出去。
  - `dynamically_loaded_tools` 按官方线格式实现：K3 接受**消息级工具声明**（`messages[].tools`），即可在会话中途以「无 `content` 字段的 `system` 消息」注入完整工具定义（`{ name, description, parameters }` 三元组，服务拒绝只给工具名）。这正是**保护前缀缓存**的手段——官方文档明确把「保持顶层 `tools` 字节稳定」列为该特性目的之一（顶层工具变化、或中途修改/删除已发出的声明都会使缓存从该点起失效，而在末尾追加不影响缓存前缀）。本插件提供 `withMessageTools()` 在 system 消息上挂声明，映射器按历史顺序输出；声明按请求重发（服务端不保留），且仅在模型声明该能力时发送，否则降级为一条说明消息而不是发出必然 400 的请求。
  - 能力判定统一走「实时 `/v1/models` > 内置注册表」：listing 的 `supports_video_in` / `supports_dynamic_tools` 直接采信，离线回落内置表（`k3` / `k3-256k` 具备动态工具加载，`kimi-for-coding` 系列不具备）。设置卡把两项能力显示在模型旁。
  - 修复动态工具声明**位置被提升**的问题：首版把历史里所有 `messages[].tools` 声明收集后统一发在请求最前面，但 Kimi 的缓存是**前缀匹配**——把声明放到它首次发出位置之前会重写缓存前缀并使已缓存对话失效，恰好破坏该特性存在的唯一理由。现在每条声明按其在历史中的真实位置插入（`flushSlots` 按「非 system 消息数」定位并交错输出），因此**末尾追加**仍是缓存安全的追加，而中途新增的声明不会前移。
- 修复 `isAbort` 用 `instanceof Error` 判定取消的缺陷：DSH 的 `LlmError` **不是 Error 子类**，所以在真实调用链上取消会被误判为「读取失败」并降级成模型可见的占位文本——把用户主动取消变成了一个错误答案。改为按 `name === 'AbortError'` 结构化判定，并保留 `signal.aborted` 短路。
- 声明所在 system 消息**同时带有文本**时不再静默丢弃：服务的动态工具 schema 没有 `content` 字段，两者无法合成一条消息，因此现在保留文本（另发一条），并把声明替换为明确的说明消息，而不是让工具无声消失。
- **按官方 CLI 的能力表逐模型修正两项能力**（依据 `managed:kimi-code` 托管模型表里每个模型的 `capabilities` 列表）：`k3` = image_in + video_in + dynamically_loaded_tools；`k3-256k` = image_in + **dynamically_loaded_tools**（无 video）；`kimi-for-coding` = image_in + video_in + **dynamically_loaded_tools**；`kimi-for-coding-highspeed` = image_in + video_in（**无** dynamically_loaded_tools）。修正了先前把 `dynamically_loaded_tools` 当成「K3 独有」的推导错误——官方线文档只提 K3 是因为它描述的是 K3 的请求 schema，而 CLI 自己的能力表把它也标给了 K2.8 Preview。
- 修正能力判定与官方表格的一致性（已对照 https://www.kimi.com/code/docs/en/kimi-code/models.html 逐项核对）：`k3` 与 `kimi-for-coding` 为「Image, video」、`k3-256k` 为「Image only」，与内置表一致；`kimi-for-coding-highspeed` 官方标为 K2.7 Code HighSpeed，「Thinking: ON」且无可选档位，故其固有档位仍按官方标注为 `high`。
- **重排模型能力展示**：此前把能力说明当成长句塞在模型名那一列，把名称列撑开、右侧描述错位。现改为独立的四列表格（模型 / 多模态 / 动态工具 / 说明）：能力只显示短标签（视频 / 仅图片 / 动态工具 / —），逐模型的协议、默认思考档位与所需套餐移入悬停提示；表格自身不再附带任何解释段落。表格抽成可测组件 `KimiModelCapabilities`（`src/client/kimi-code/KimiModelCapabilities.tsx`），新增 `test/kimi-code-capability-ui.test.tsx`（5 条）钉住列数、每模型一行、长句不得进入单元格、悬停内容，以及说明为空时不渲染 `null`。该表也**不再依赖 `description` 是否存在**——实时目录条目缺描述时整个表格（含能力）仍渲染。
- 澄清并测试这两项能力的**跨模型隔离**：机制本身有三重隔离——符号载体**不可枚举**（其他线路的序列化器看不到它）、映射器只在 `messageTools === true` 时输出、且声明只存在于 Kimi 的 OpenAI 线路映射中。新增 `test/kimi-code-capability-isolation.test.ts`（6 条）：Command Code 各模型仍不含 video（证明模块增强是**纯类型、不产生运行时值**）、Kimi 四个模型 id 的 video 与 dynamically_loaded_tools 与官方能力表**逐项**一致（并断言两者并非同一集合：HighSpeed 有 video 却无动态工具）、视频块不会出现在兄弟线路的请求体里、同一段历史里的声明也不会被兄弟线路带出去。
- 另记录一个**证据取舍**：公共 `models.dev` 目录虽声明了 `dynamically_loaded_tools` 字段，但 Moonshot 自家四个条目均未标注，故本插件**不采信该目录**，改以官方 CLI 托管模型表的 `capabilities` 为准；运行时仍以实时 `/v1/models` 的 `supports_dynamic_tools` / `supports_video_in` 覆盖内置表。
- 新增 `test/kimi-code-declaration-position.test.ts`（7 条回归用例）：声明按历史位置交错（含前后两条声明之间有对话的情形）、末尾追加落在队尾且前缀不变、首条声明仍在队首、文本与声明同处一条消息时保留文本并给出说明、以及取消检测在「非 Error 的 AbortError 对象」与「signal 已 abort」两条真实路径上都向上抛出、而真正的读取失败仍降级。这 7 条在把两个缺陷临时改回后**确有 3 条失败**（位置 2 条 + 取消 1 条），确认它们是真的回归用例而非同义反复。
- 新增 `test/kimi-code-capabilities.test.ts`（24 条）：模态词表与容器白名单、视频解析与缺字节/无 reader 的降级、最旧优先省略、两种模型能力下的线级视频形状、Anthropic 线路绝不发未记录字段、消息级工具声明的符号载体（不污染 `Object.keys`）、`content` 字段不得出现、能力缺失时的降级、历史顺序保持、以及请求体预算（纯文本仍按 2 MB 拒绝、带视频才放宽）。另有 3 条既有断言随行为变更更新（`inputModalities` 现含 `video`）。
- 新增 80 条单测：`test/command-code-mapper.test.ts`（两条线路的请求映射、图片内联与超限省略、OpenAI/Anthropic 流式解码、工具调用增量拼接、usage 与 finish reason、截断流拒绝）、`test/command-code-oauth.test.ts`（回环回调服务器：CORS 预检、表单/JSON 回调、state 校验、拒绝路径、303 跳转、宽限期发布）、`test/command-code-routes.test.ts`（账户/额度/目录解析、模型选项与启用集合、设置路由与同源校验）、`test/command-code-adapter.test.ts`（目录、上下文覆盖、两条线路的端到端流式与工具往返、缺凭据/401/429/截断的错误分类）、`test/command-code-store.test.ts`（凭据校验、模型设置文件、设置卡与胶囊的纯函数）、`test/command-code-plugin.test.ts`（插件装配、路由接管与释放后自动接管）。
- 修复开启系统代理的机器上 `web_fetch` 必然失败的问题：DSH 内置抓取 provider 在连接前解析、校验并固定目标地址，而代理工具（Clash/Mihomo 等）的 fake-ip DNS 会把域名解析成 `198.18.0.0/15` 里的保留地址（实测 `api.github.com` → `198.18.0.17`），于是每次调用都以 `WEB_BLOCKED_URL`（`resolves to a non-public IP address`）结束——代理根本没被用上。DSH 只在进程环境变量里读到代理时才走代理，看不到系统代理。现在只要插件配置了可用代理（系统代理自动检测或自定义代理），`web_fetch` 就改用本插件的抓取 provider：由代理解析源站，与 DSH 对“走代理的请求”采用的语义一致；未配置代理时仍由内置 provider 抓取，其解析与固定策略不变。
- 抓取 provider 新增地址策略 `src/host/fetch-address-policy.ts`，保留内置 provider 安全边界中不需要 DNS 的那一半：URL 里写明的 IP 字面量只有全球可路由单播才放行（loopback、私网、链路本地、CGNAT、多播、保留地址、IPv6 转换与隧道前缀一律拒绝）；域名用本机解析器检查一次，落在私网（含 `localhost`、`127.0.0.1.nip.io` 这类）一律拒绝；只有代理的 fake-ip 答案被接受，本机解析不出的域名交给代理处理。与内置 provider 的差别是不再固定（pin）连接地址——fake-ip 环境下这一步无法成立，已在 README 的安全边界中写明。
- 代理偏好在运行时变化（例如系统代理 ↔ 直连）会重新选择抓取后端；选择 ChatGPT 搜索来源时同时切换搜索与抓取的行为保持不变。
- `ProxyManager` 新增系统代理探测的观察点（`onSystemProxyDetected`）：只在「从未知变为已知代理」时通知——探测失败与「本机没有代理」都读作 `null`，因此不会因为一次 `reg query` / `scutil` 抖动就把已经可用的路由拆掉。插件据此在代理迟于 DSH 出现时自动重新选择抓取后端，否则内置 provider 会一直占到进程结束。
- 新增 `test/fetch-address-policy.test.ts`（地址分类、fake-ip 识别、私网解析拒绝、解析失败放行），并扩充 `test/codex-fetch.test.ts`、`test/search-provider-switcher.test.ts`、`test/web-provider-lifecycle.test.ts` 覆盖抓取 provider 的拒绝路径与后端切换。
- 修复 Antigravity 线路静默丢弃用户上传图片的问题（issue #5）：本插件把 `gemini-*` / `claude-*` 都声明为支持图片输入，DSH 因此不把图片投影成文本，而是以 `{ type: 'image', attachment }` 的形式原样交给适配器；但 `mapper.ts` 只认内联 `data` / `base64` / `source.*`，`contentToUserParts()` 又用 `if (img) parts.push(img)` 静默跳过，于是发给 Google 的 `streamGenerateContent` 请求里只剩下文本，模型只能回答「没有收到图片」。现在 `AntigravityAdapter` 接入 `ctx.attachments`，在组装请求前把附件解析为 Gemini `inlineData`（媒体类型取自已校验的附件引用），同一附件在多条消息中只读取一次。
- 读不出字节的图片不再静默消失：降级为 `[image unavailable: …]` 文本让模型能说明图片没读到；取消（AbortSignal）仍向上抛出，不会变成模型可见的文本。工具结果中的图片同样以 `[image: 名称]` 保留，与 Codex 线路一致。
- 新增 8 条 `test/antigravity-mapper.test.ts` 用例（内联映射、跨消息去重、读取失败降级、无附件服务降级、取消传播、旧内联格式、工具结果图片标记，以及不传解析结果时默认参数仍不静默丢弃）与 3 条 `test/antigravity-adapter.test.ts` 端到端用例：`gemini-3.8-flash` 与 `claude-opus-4-6` 各断言一次真实请求体中的 `inlineData`（两个 provider 共用同一 mapper），另一条用 429 逼出候选链，断言每个 runtime model 候选都带着图片、且附件只读一次。新增 `test/antigravity-image-wire.test.ts` 做线级验证：不 mock `fetch`，改为在 127.0.0.1 上起回环服务器并把 `DSH_ANTIGRAVITY_ENDPOINT` 指向它，读取真正离开进程的请求体，断言 `contents[0].parts` 是 `[text, inlineData]`。把这三组用例跑在回退后的修复前源码上，共 12 条失败（其中线级用例显示 socket 上只剩文本），因此它们是货真价实的回归用例。再新增 `test/antigravity-image-bundle.test.ts`：issue 是在 npm 安装版上发现的，所以这条用例直接 import 打包产物 `lib/index.js`（而不是 `src`）跑同一段线级断言，证明用户装到的那个 bundle 里同样带着修复；`lib/` 是提交进仓库的生成物，源码改动后忘记 `npm run build` 时它会失败。工具结果里的图片仍只记名不内联——DSH 自己的多 provider 适配器（`llm-pi-ai`）对工具结果里的非文本块是直接丢掉的，记名已经比参照实现保留得更多，而 `functionResponse.parts` 是否被该端点接受在本地无从验证，故按「不臆造线上行为」处理，并在代码里写明理由。
- 新增单次请求的图片体积上限（`MAX_REQUEST_IMAGE_BYTES`，12 MiB base64）：修复后本线路会把历史里的图片全部内联，图片多的会话会让请求体持续膨胀直到被 Google 的 20 MB 体积上限拒绝，而最先被牺牲的恰是模型最不需要的旧图。现在超过预算时按 DSH 的顺序（最旧优先）把图片替换为上游同款占位文案，`test/antigravity-mapper.test.ts` 与 `test/antigravity-adapter.test.ts` 各有一条用例覆盖（被省略的图片不会被读取，最新一张仍以 `inlineData` 发出，且不改动持久历史）。该逻辑在插件内实现而非调用 DSH 的 `offloadRequestImagesWithPolicy`：本插件支持的 DSH 区间里这个符号的形态发生了不兼容变化（`OFFLOADED_IMAGE_TEXT` 常量 → `offloadedImageText()` 函数；`offloadRequestImages()` 在 0.1.5-rc.1 被移除；`placeholder` 由可选变必填），绑定任一形态都会重演 issue #4 那种"在某个受支持版本上直接加载失败"。
- 修正 `test/subagent-model-authorization.test.ts` 的守卫类型：Host 工具注册表登记的是单参数 `ToolGuard`（`@deepseek-ai/dsh-tools`），测试却按插件内部的三参数 `DelegationGuard` 别名调用，导致 `npm run typecheck` 长期以 TS2554 失败。模拟注册表改为按真实契约取类型后，仓库自带的 `npm run typecheck` 恢复通过。

## 0.2.15 - 2026-09-11

- 新增子代理模型授权守卫：DSH 的「Subagent」允许列表（`subagent-model-selection`）原本只在模型**显式**填写 `provider`/`model` 时生效，而委派调用不填路由时子代理会继承父级模型——于是 DeepSeek 会话里的子代理仍会在未授权模型上运行。插件现在在 Host 工具注册表上注册一个单调守卫（`ctx.tools.guard`），当调用会话（或最近的、记录了策略的祖先会话）带有允许列表时，任何生效路由不在此列表内的委派都会在子代理启动前被拒绝，拒绝理由里带上全部已授权路由，模型据此重试即可选中合规模型。
- 该守卫只在会话确实记录了允许列表时介入（与 DSH 委派工具的会话快照语义一致），不会改变未启用该设置的会话；`subagentModelScope: 'preference'` 可让当前设置卡允许列表也约束未记录策略的会话（含恢复的旧会话）。
- 只读取公开接口：会话日志事件 `subagent/model-selection-policy`、父会话谱系、Host 设置文档与 `ctx.tools.guard`，不修改 DSH 本体。
- 新增配置项：`subagentModelAuthorization`（默认 `true`）、`subagentModelTools`（默认 `['subagent']`）、`subagentModelScope`（默认 `session`，可选 `preference`）。
- 新增 14 条单测覆盖策略解析、谱系继承、设置读取、显式/继承路由的拒绝与放行、作用域切换以及守卫安装路径（含注册与释放）。
## 0.2.14 - 2026-09-10

- 移除失效的「子代理最大嵌套深度 / 子代理上下文预算」设置：这两个偏好键在 DSH 侧没有任何消费方（全仓库无引用），插件自身也只有写、没有读，保存了也不生效。它们源于 2026-08-28 的 `5b08e2e`——那次提交迁移到 DSH 原生子代理模型路由，删除了 `subagent-context-adapter` / `subagent-policy` / `SubagentSettingsSection`，但把这两个控件和偏好键留了下来。相关 DTO 字段、schema、路由校验、界面控件、6 条未引用文案与失效单测一并移除；子代理模型与思考深度改用 DSH 自身的“Subagent”设置卡片，最大嵌套深度由 preset 中 `tool-subagent` 的 `maxDepth` 决定，README 同步更正。

## 0.2.13 - 2026-09-10

- 回退 Codex 与 Antigravity 模型上新增的 `systemPromptUpdate: 'in-history'` 声明：Responses 线路把系统提示词放在顶层 `instructions`，Antigravity 把它放在固定的 `systemInstruction` 加一条 user turn，两条路由都无法把"历史中最后一条 system 消息"当作完整系统提示词。声明该能力会让 DSH 在提示词变化时改为追加 system 节点并保留旧节点，而两个 mapper 会把新旧提示词一并发出。Codex mapper 同时改为只取最新一条非空 system 消息，避免将来重新声明时再次拼接过期提示词。
- 移除 `src/compat.ts` 对 `@deepseek-ai/dsh-llm` 的 `ContentBlockMap.file` / `LlmResolvedModelInfo.systemPromptUpdate` 模块增强：本地 DSH（`packages/llm/llm`，0.1.5-rc.1）已经声明 `'file': FileBlock`，与增强中的 `Record<string, unknown>` 冲突（TS2717），对着本地依赖编译会直接失败。
- 移除两个 mapper 中不可达的 `file` 内容块处理：DSH 内核在进入适配器之前已把文件块投影为 `fileHandleText`（`dsh-llm` 的 `projectFilesToText`），适配器永远收不到 `file` 块；原实现读取的 `byteSize` / `savedPath` 在真实 `FileAttachmentRef` 中也不存在（真实字段是 `bytes`）。
- 移除只完成一半的「智能体团队混合模型规则」（`teamModelRules`）：该功能当时只有偏好存储、路由白名单校验、匹配函数和 64 条中英文案，没有任何地方据此选择子代理模型（DSH 内核对子代理模型走 `subagent/model-selection-policy`），因此连同 DTO、schema、路由处理、单测与未引用文案一并移除，等 DSH 提供介入点后再实现。
- 修复 Antigravity 新账号开通在全部端点失败时静默返回成功：`onboardUser` 现在会在候选端点循环结束后抛出最后一次失败，而不是让调用方误以为已开通。
- 修复登出竞态：`clearCachedQuota()` 增加 epoch 标记，登出时仍在途的配额请求不再回写 `cachedQuota`，也不再为已登出账号写入模型目录；in-flight 槽位改为按持有者清理，避免"清理后重新拉取"丢失新的在途请求。
- `/antigravity/api/status` 改用导出的 `ANTIGRAVITY_QUOTA_CACHE_TTL_MS`，不再内联 120000。
- 移除 Antigravity 设置页与输入框配额胶囊里重复的 `POST /quota`：Host 在 `/status` 中已经会刷新过期缓存，客户端再发一次会让单次挂载产生 2–4 次上游配额请求；配额空态改为明确提示（新增 `quotaEmpty` / `googleValidation` 文案，不再硬编码中文）。
- `parseEnvProxy` 新增 `envFile` 注入点：`$DSH_HOME/.env` 兜底代理探测现在有测试覆盖（含 `export` 前缀、引号、注释、空值、环境变量优先），既有"无代理返回 null"的断言也不再依赖运行机器上是否真的存在 `~/.dsh/.env`。
- Antigravity User-Agent 恢复按真实平台填写 `os_type` / `arch`（仍可用 `DSH_ANTIGRAVITY_OS` / `DSH_ANTIGRAVITY_ARCH` 覆盖），不再默认冒充 darwin/arm64。
- 移除未被引用的 `SANDBOX_ENDPOINT` 并修正端点注释；DSH 依赖区间末项由 `^0.1.5` 改为 `^0.1.5-rc.1`（`^0.1.5` 不匹配本地实际依赖 0.1.5-rc.1），并同步了长期滞后的 `package-lock.json` 根信息。

## 0.2.12 - 2026-09-10

- Antigravity 登录与开通：对齐官方 2.8.0 User-Agent 格式并支持环境变量覆盖，新增 `loadCodeAssist` 详情解析、免费层资格校验与 Google 账号安全验证链接提取，以及新账号的 `onboardUser` LRO 轮询开通。
- Antigravity 配额：`/status` 按 2 分钟 TTL 自动拉取配额，`/quota` 支持强制刷新并在并发调用间去重；Web 设置页与输入框配额胶囊自动获取配额，不再需要手动刷新。
- 代理：`auto` 模式在进程环境之外新增 `$DSH_HOME/.env` 兜底探测。
- 依赖：`@deepseek-ai/*` peer/dev 版本区间扩展到 `^0.1.3` / `^0.1.4` / `^0.1.5`。

## 0.2.10 - 2026-09-06

- 修复 Antigravity 模型元数据校验失败导致 Provider 整体消失的问题：在 `resolveModel` 中清洗并安全兜底 `defaultEffort`，确保透传给 DSH 内核的 `defaultEffort` 必定存在于当前模型的 `efforts` 清单内；解决 `gemini-3.1-pro` 等模型（仅支持 `low` / `high`）因默认回退 `medium` 触发 `@deepseek-ai/dsh-llm` 的 `INVALID_MODEL_REASONING` 校验异常导致 Provider 从模型选择列表中消失的问题（Issue #4）。

## 0.2.9 - 2026-09-06

- 修复在官方 DSH 0.1.2-rc.1 / dsh-llm 0.1.2-rc.1 上加载失败问题：移除 Antigravity 模块中对 `CallId` 的静态具名导入，统一采用 `toToolCallId` 兼容垫片，动态兼容 `ToolCallId` 与 `CallId`；解决启动（boot）阶段因缺失 `CallId` 导出抛出 SyntaxError 导致插件整树无法加载的问题（Issue #4）。
- 修复搜索与抓取来源切换未生效：正确更新 Loader 配置，并在 DSH web 服务重载时重新注册后端、保留默认来源；解决启用插件抓取后仍由 DSH 内置 fetch 拦截 TUN/Fake-IP 地址的问题。
- 修复 Antigravity 工具调用：原样回传 Google 工具 ID，兼容旧会话保存的原始 ID；转换工具参数 Schema，过滤 `propertyNames` 等不支持字段并处理嵌套结构。
- 修复 Gemini 3.7 / 3.8 的旧 `off` / `none` 思考配置，使用最低支持档位 `LOW` 并关闭思考摘要；400 请求错误直接保留原始详情，不再被模型降级错误覆盖。
- Codex 订阅供应商新增 `gpt-6-astra`（6 Astra），支持文本、图片、工具调用和 `low` 至 `max` 思考档位，默认 `medium`；旧会话的 `none` / `minimal` 转为 `low`。
- 新增 Astra 上下文设置：默认 272K，订阅侧最高 872K，界面与服务端统一校验；保留已有模型选择与上下文配置。

## 0.1.28 - 2026-08-28

- 新增支持 1.5x 倍速快速模式（Fast Mode / Priority Service Tier）：在设置页「增强功能」中提供开关，开启后向 Codex 后端请求自动注入 `service_tier: 'priority'`，以约 2x–2.5x 额度消耗换取约 1.5 倍的 Token 生成速度。
- 修复偏好设置更新白名单校验，支持持久化保存 `fastMode` 配置。

## 0.1.21 - 2026-08-22

- 修复 DSH 更新到 `0.1.1-rc.2` 后“本轮运行失败：registration.adapter.prepareCall is not a function”：新代理循环经 `ctx.llm.prepareCall()` 冻结每次调用，适配器必须实现 `prepareCall`；CodexChatGptAdapter 现显式绑定同一次解析的模型元数据与流分发（`PreparedAdapterCall`）。
- 将全部 `@deepseek-ai/*` peerDependencies 与 devDependencies 版本统一从 `^0.1.1-rc.1` 提升至 `^0.1.1-rc.2`，并重新生成 package-lock.json。
- 增强文件完整性与编码防御：确保 `package.json` 及全部工程文件均为无 BOM 的 UTF-8 编码，新增 `test/package-integrity.test.ts` 自动化防范 UTF-8 BOM 引入与依赖一致性。已在本机 rc.2 依赖集上验证：typecheck、69 项测试与 tsdown 构建全部通过。

## 0.1.20 - 2026-08-22

- 新增独立的“子代理”设置页；模型、思考深度和上下文预算改为所有 DSH 内置子代理的全局设置，不再要求父 Agent 使用 Codex 模型。
- 新增全局 0–3 最大嵌套深度和每个父 Agent 子树的活动子代理数量上限；新委派即时受限，现有运行不被中断。
- 子代理设置扩展为 DSH 全部已接入 Provider/模型；思考深度使用所选模型的真实 reasoning effort 目录，上下文在选定模型后展开并作为子 Agent 的有效压缩预算。
- 设置页新增 GPT-5.6 Sol / Terra / Luna 有效上下文窗口配置：默认 272K，可选最高 1M，并动态影响 DSH 的模型解析、压缩阈值与溢出判断。

## 0.1.12 - 2026-08-20

- 适配 DSH `0.1.0-rc.8`：peerDependencies / devDependencies 中全部 DSH 包范围从 `^0.1.0-rc.6` 提升至 `^0.1.0-rc.8`，并重新生成 package-lock.json。已在本机 rc.8 依赖集上验证：typecheck、55 项测试与 tsdown 构建全部通过，插件代码无需改动。
- 移除已无引用的 `@deepseek-ai/dsh-agent` peer 依赖（子代理报告去重兼容模块已于 0.1.11 移除）。
- 新增 `@deepseek-ai/dsh-client-connection` peer 依赖（客户端 `ContentBlock` 类型来源，符合 rc.8 客户端包 peer 声明惯例）。
- 说明：rc.8 中 `@deepseek-ai/dsh-client-ui-slots` 不再是 DSH 运行时依赖图成员（仅保留为各客户端包的 devDependency），插件继续将其声明为 peer 依赖以保证安装时解析（`^0.1.0-rc.6` 联网安装时解析到 rc.8；本地锁文件因离线环境暂固定 rc.7，API 与 rc.8 用法一致）。