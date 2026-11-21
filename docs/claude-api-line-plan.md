# Claude API 线路设计与证据

线路 id `claude-api`，显示名 Claude API。单个 API Key、可自定义端点、Anthropic Messages 协议，以官方 Claude Code 客户端的请求形态发送。本文件是实现与评审的规格来源；冻结的导出名以 `src/shared/claude-api-contracts.ts` 与 `src/host/claude-api/{types,model-catalog,token-store,client-version}.ts` 为准。

## 决策

| 项 | 决定 |
| --- | --- |
| 端点 | 默认 `https://api.anthropic.com`，可自定义；http 与 https 都接受 |
| 凭据 | 单 Key，系统加密存储，无账号池 |
| 请求形态 | 只做 Claude Code 形态 |
| 客户端版本号 | 跟随 npm 上 `@anthropic-ai/claude-code` 的最新版，取不到时用最后一次取到的值；全局一致，新版本仅在线路空闲超过缓存 TTL 后采纳，采纳前在卡片上以 pending 显示 |
| 入口 | 枢纽卡片紧跟 `claude` 之后；沿用 Claude 品牌标记 |
| 服务端压缩 | 默认开，设置页有开关；只在本线路生效 |
| 可选能力 | 缓存时长 5m / 1h（默认 5m）、官方同款 `context_management`、快速模式（默认关）、单轮提醒 `clear_at` |
| 不做 | 额度显示与输入框徽章、账号池、原生 API 形态、阈值压缩、媒体工具、任务预算 |

## 证据来源

| 事实 | 来源 | 核验日期 |
| --- | --- | --- |
| 请求头、`system` 结构、`metadata`、beta 集、工具字段 | 本地抓包 `@anthropic-ai/claude-code@2.1.330`（print 模式、API key、回环端口）；结构副本 `test/fixtures/claude-api/request-2.1.330.json` | 2026-11-21 |
| 身份前缀、计费归因块、指纹算法与盐、`getAPIMetadata` | https://github.com/liuup/claude-code-analysis 的 `src/constants/system.ts`、`src/utils/fingerprint.ts`、`src/services/api/claude.ts`、`src/services/api/client.ts`（2026-03-31 源码快照） | 2026-11-21 |
| 对话中 system 消息、`tool_addition` / `tool_removal`、`clear_at` | https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages | 2026-11-21 |
| 前缀校验与 `block_binding` | https://platform.claude.com/docs/en/build-with-claude/preserved-thinking/prefix-checks | 2026-11-21 |
| 按需压缩 | https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand 、 compaction-keep-recent-turns 、 compaction-thinking-blocks | 2026-11-21 |
| beta 名单 | https://github.com/anthropics/anthropic-sdk-typescript 的 `AnthropicBeta` 枚举 | 2026-11-21 |
| 以上各项的实际行为 | 经一个上游为官方 API 的兼容网关实测，模型 `claude-haiku-5-5` 为主 | 2026-11-21 |

## 请求形态

- `POST <baseUrl>/v1/messages?beta=true`，流式。
- 请求头（大小写无关）：`accept: application/json`、`content-type: application/json`、`user-agent: claude-cli/<版本> (external, cli)`、`x-app: cli`、`x-claude-code-session-id: <会话 UUID>`、`anthropic-version: 2023-06-01`、`anthropic-dangerous-direct-browser-access: true`、`x-api-key`、`anthropic-beta`，以及 `CLAUDE_API_STAINLESS_HEADERS` 的八个头。
- `system` 恰好三块，顺序固定：
  1. 计费归因块 `claudeApiBillingBlock(version, firstUserText)`，不带缓存标记。
  2. 身份句 `CLAUDE_API_IDENTITY_TEXT`，带缓存标记。
  3. DSH 的系统提示（含折叠进来的 system 消息），带缓存标记；没有系统提示时省略这一块。
- `firstUserText` 是第一条用户消息里用户自己的第一段文本（不是工具结果，也不是排在它前面的提醒块）；没有则为空串。
- `metadata.user_id` = `claudeApiMetadataUserId(deviceId, claudeApiSessionUuid(sessionId))`；没有会话 ID 时每次请求用随机 UUID。
- 同一个调用里 UA、计费块、指纹用同一个版本号：适配器每调用只读一次 `ClaudeApiClientVersionResolver.current().value`（这也是 pending 版本可能被采纳的时机），随后 `noteActivity(settings.cacheTtl)` 记录活动，流结束或失败时再记一次；目录读取与连接测试不算活动。
- 工具只发 `name`、`description`、`input_schema`、`defer_loading` 四个字段，不做名称大小写归一。

## beta 规则

底集 `CLAUDE_API_BASE_BETAS` 每次都发。其余由**最终请求体**推导：

| beta 常量 | 条件 |
| --- | --- |
| `CLAUDE_API_BETA_THINKING_BINDING` | 请求体含 `thinking.block_binding` |
| `CLAUDE_API_BETA_COMPACT` | 顶层有 `compaction`，或任一消息含 `type: "compaction"` 的块 |
| `CLAUDE_API_BETA_INLINE_TOOLS` | 任一 `tool_addition` 的 `tool.type` 是 `tool_definition`；或顶层有 `compaction` 且消息里有 `tool_addition` / `tool_removal` |
| `CLAUDE_API_BETA_CLEAR_AT` | 任一消息带 `clear_at` |
| `CLAUDE_API_BETA_FAST_MODE` | 请求体有 `speed` 且模型 `fastMode === 'beta'` |

实测：缺少对应 beta 时，兼容网关可能静默剥掉 `context_management`、`thinking.block_binding` 和消息级 `output_config` 并返回 200；`tool_addition`、`clear_at`、`compaction` 块缺头时上游明确 400。所以头必须从请求体推导，不能从设置推导。

## 消息映射

- **system 消息**：`midConversationSystem` 为真时原位保留为 `role: "system"`；否则折叠进 `system` 第三块。带内容的 system 消息必须紧跟 user 轮（含工具结果）或以服务端工具结果结尾的 assistant 轮，其后必须是 assistant 轮或已到末尾；不能是第一条；不能夹在 `tool_use` 与对应 `tool_result` 之间。相邻的 system 消息作为一组判定。位置不合法返回 400。
- **工具增删**：developer 消息里的 `tool-addition` / `tool-removal` 块在合法位置转成 system 消息里的 `{type:"tool_addition"|"tool_removal", tool:{type:"tool_reference", name}}`；位置不合法时改成一条用户侧文字说明。`defer_loading: true` 的工具在被 `tool_addition` 放出前模型不可见。全部工具都延迟且历史里有工具变更时，在工具表最前面补一个非延迟占位工具。对 `midConversationSystem` 为真的模型声明 `toolUpdate: 'in-history'`。
- **思考**：`thinkingMode === 'adaptive'` 发 `{type:"adaptive", display:"summarized"}`，选了档位才发 `output_config.effort`；`preservedThinking` 为真时再加 `block_binding: {prefix_mismatch_behavior:"drop_block"}`（无条件）。`block_binding` 只能出现在 adaptive 形态里：实测 `{type:"disabled", block_binding}` 被上游以 `thinking.disabled.block_binding: Extra inputs are not permitted` 拒绝。档位为 `none` 且 `canDisableThinking` 时发 `{type:"disabled"}`。`budget` 形态发 `{type:"enabled", budget_tokens}`。`supportsTemperature` 为假或思考开启时不发 `temperature`。思考块（含空正文）连同 `signature` 原样回放；`server_tool_use` 与对应结果块也原样回放。
- **`context_management`**：思考开启且 `contextEditing` 为真时发 `{edits:[{type:"clear_thinking_20251015", keep:"all"}]}`。带 `compaction` 的请求不能发（上游 400）。
- **缓存断点**：身份句、系统提示、最后一个可缓存的用户块、最后一个非延迟工具，至多四个。`cacheTtl === '5m'` 时标记为 `{type:"ephemeral"}` 不带 `ttl`；`'1h'` 时带 `ttl:"1h"`（API key 上不需要额外的 beta）。延迟加载的工具、带 `clear_at` 的消息不能带标记。
- **快速模式**：设置开启且模型 `fastMode !== null` 时发 `speed: "fast"`。已知模型严格按表值（表里 `fastMode` 为 null 的已知模型永不发 speed）；未知非 Claude id 永不发 speed。设置开启的未知 `claude-*` id 乐观尝试：能力记忆（`claude-api-capability-memory.json`，端点+模型为键，7 天过期）初值 'ga'（发 speed、不带 beta）；上游 400「does not support the `speed` parameter」→ 记 unsupported 并以无 speed 重试一次；400「需要 `anthropic-beta: fast-mode-2026-02-01`」→ 记 'beta' 并带该头重试一次；两种纠正每调用各至多一次且在任何输出之前，之后的请求直接按记忆构建。429/529 不纠正，按普通限流/过载上报。
- **单轮提醒**：消息的 `source.kind` 属于 `CLAUDE_API_TURN_SCOPED_SOURCE_KINDS`、模型 `midConversationSystem` 为真、且位置满足 system 消息规则并且其后不是直接跟一条 user 消息时，发成独立的 `{role:"system", clear_at:"next_user_message", content:[text...]}`：只含文本块、不带缓存标记、不带 `output_config`。判定必须是历史内容的纯函数，同一段历史两次构建字节一致。条件不满足时保持原来的用户侧文本形式。

## 历史顺序

本线路按 DSH 给出的顺序原样发送历史，不使用共享的静态前缀重排（策略表里 `staticPrefix: false`，适配器不调用 `withStaticPrefixOrdering`）。原因有三：重排会把重新注入的提醒移到检查点之前，使检查点不再是第一条消息、压缩块无法回放；重排在压缩后第一次出现提醒时会改动更早轮次的前缀，使这些轮次的思考块被丢弃；而 `system` 第一块（计费归因块）本来就随会话不同，跨会话共享消息前缀无从谈起。

位置规则一律按最终发出的角色判断：检查点被换成压缩块后是 assistant 消息，紧跟其后的 system 消息不在合法位置，要走各自的退回形式。历史缓存断点打在最后一条 user 角色消息上，即使其后还有 system 或单轮提醒消息。

本线路在工具结果中部修剪的默认跳过名单里（`DEFAULT_SKIP_PROVIDERS`，与 Kimi 线路同样的理由）：改写历史里的工具结果会让缓存前缀从改写点起失效，并使其后的思考块过不了前缀校验，所以默认一次都不改历史。用户仍可用 `skipProviders` 配置整体替换这份名单。

## 等待续热

主会话把活派出去以后自己空闲下来，提示缓存仍在按 TTL 倒计时。本线路在策略表里声明 `waitWarmup: true`、`waitJobs: true`、`ttlMs: 3_600_000`（`staticPrefix`、`hint`、`affinity` 仍为 false，`coldStart` 仍为 in-flight），由共享控制器 `KimiCacheWaitController`（`src/host/kimi-code/cache-wait.ts`，装在 `src/index.ts` 一处）执行，与 Kimi 线路共用同一套机制。

- **只在 1 小时档生效**：适配器为每个主轮次把本次请求实际写入的缓存寿命记进 `promptCacheActivityStore('claude-api')`（`'1h'` → 3_600_000，`'5m'` → 300_000）。控制器发现活动记录里的 `ttlMs` 与策略 `ttlMs` 不一致时，对该会话什么都不做：不排定时器、不续热，已排定的定时器在下一次 reconcile 时清除。记录不带 `ttlMs` 时按原规则处理；其他线路的存储从不写这个字段，因此它们的行为不变。
- **55 分钟决策点（TTL 前 5 分钟）**：所有线路统一取 `ttlMs - 5 分钟`，由导出纯函数 `cacheWaitDecisionMs(ttlMs)` 与余量常量 `CACHE_WAIT_MARGIN_MS` 表达（旧的「TTL 的 80%」规则已废弃）。1 小时档即空闲满 55 分钟，Kimi 的 25 分钟 TTL 同样得到 20 分钟。此时若仍有委派在跑，就向主会话 steer 一条很小的续热消息；该轮结束后重新排定下一个 55 分钟。空闲达到 TTL 本身走冷恢复，不再续热。
- **TTL ≤ 5 分钟没有续热**：余量放不下时函数返回 `undefined`，控制器对该会话什么都不做——不排定时器、不续热、不留定时器，每进程每线路只告警一次。策略校验不变，这样的部署照常启动；任何 TTL 都不可能产生 0 或接近 0 的决策点而自我重排成循环。
- **空闲时钟从请求发出时算起**：适配器在请求发出时记 `lastActiveAt`，流结束那次记录只补 `totalTokens`，绝不把 `lastActiveAt` 往后移。上游最后一次触碰缓存是请求发出的时刻；若按流结束计时，一个流式输出好几分钟的轮次会把决策点整体推后同样几分钟，续热就可能落在缓存过期之后。辅助请求（标题、压缩、时间线）不记活动，因此不会重置空闲时钟；续热轮本身是普通主轮次，会重新记录，这正是定时器重新排定的方式。
- **子代理与后台任务都算委派**：控制器既看 `subagent/catalog` / `subagent/end` / `subagent-settled`，也看宿主写进同一个所有者会话的 `job/registered` / `job/settled`（`dsh-jobs-local`，同一条 `session/event` 总线）。新注册的任务与新子代理一样重置本批次的续热记账；每会话最多记 256 个任务 id，超出忽略；任务 id 随会话状态一起丢弃。旧世代宿主不发这两个事件时任务跟踪自然失效，子代理路径不受影响。
- **成本**：每次续热都是一次真实请求，按缓存读取价格读回整段已缓存前缀，并产生少量输出 token；它不是免费保活。1 小时档的缓存写入本身按基础输入价格 2 倍计费。
- **痕迹**：续热消息以 `notice` 形式进入主会话历史，留下一条简短说明与模型的一句确认；正文明确要求不改变优先级、不触发工具调用、不向子代理催进度。
- **开关**：沿用全局 `cacheWaitWarmup`（环境变量 `DSH_KIMI_CODE_CACHE_WAIT_WARMUP`），没有新增设置项；关掉后本线路与其他线路一样只走冷恢复。

## 服务端压缩

DSH 的压缩引擎发出的请求是 `purpose: 'compaction'`，消息为“待压缩的那段旧历史 + 末尾一条指令 user 消息”，保留的尾巴不在其中。之后它把摘要包成检查点消息放回历史开头，文本形如 `<前言>\n\n<compacted-summary>…</compacted-summary>`，消息的 `source.kind` 是 `compact-checkpoint`。

**请求**：去掉末尾的指令消息（文本以 `SHIPPED_INSTRUCTION_OPENING` 或 `COMPACTION_INSTRUCTION` 的首行开头，两者导出自 `src/host/compaction-prompt.ts`）；其余与主轮次完全同样地构建（`system`、`tools`、缓存标记一致；思考形态一致，effort 按下条跟随会话）；去掉 `context_management`、`stop_sequences`、结构化输出格式、强制 `tool_choice`；加 `compaction: {type:"summarize", instructions}`；`max_tokens` 不低于 8192。若消息末尾是带未答复工具调用的 assistant 轮，上游会拒绝。

**Effort 跟随会话（用户决策）**：宿主的压缩引擎构建请求时不带 `reasoningEffort`（只传 provider、model、messages、toolHistory、tools、maxTokens、sessionId、purpose）。若压缩请求沿用设置页默认 effort，用户把会话从 high 切到 medium 后再 /compact，压缩请求仍会发 high（真实会话实测缺陷）。因此适配器按会话记住最近一次主轮次（无 purpose 的请求）实际解析出的 effort：请求自身点名的优先，否则设置默认，否则「未发 effort」；在发出主请求时记录（请求后来失败也记），内存上限 500 会话、最旧先丢。压缩请求未点名 effort 时，整次调用（服务端压缩体、客户端回退体与所有调用内重试）沿用该记忆值：「未发 effort」也是记忆值，即使设置默认已设也不发 `output_config.effort`；记忆值不在当前模型档位表（会话换了模型）、或无记忆（宿主重启、无会话 ID、别的线路改派而来的压缩）时，回退今天的规则：设置默认，再模型默认。压缩请求自己点名 effort 时保持原值；其他 purpose（标题、时间线报告）不受影响。实现不改 mapper：给 mapper 传带选定 effort 的 options 副本，或默认 effort 被置空的 settings 副本，其余字节不变。

**响应**：流式下压缩块在一个 `content_block_start` 里整块到齐（`{type:"compaction", content, signature, tool_changes?}`），没有增量事件，`stop_reason` 是 `compaction`。顶层 `usage` 的输入输出为 0，真实用量在 `usage.iterations[]`（`type: "compaction"` 项）。摘要写不完时内容为空且 `stop_reason` 为 `max_tokens`。

**回放**：压缩块必须放在 `messages` 最前面（单独一条 assistant 消息），正文与签名逐字节不变（改一个字符即 400）；被摘要的消息必须全部移除；每个后续请求恰好一个压缩块，并带 `CLAUDE_API_BETA_COMPACT`。再次压缩时把旧压缩块一并发出即可。压缩请求带 `CLAUDE_API_BETA_INLINE_TOOLS` 时，压缩块会记录 `tool_changes`，换入后此前放出的工具继续可用。

**保留轮次的思考块**：只有服务端写的压缩块能让保留轮次的思考块通过前缀校验，条件是压缩请求与主轮次的 `system`、`tools` 一致，保留轮次紧跟压缩块且未被改动。把摘要作为普通文本放回时，保留轮次的思考块会被判为绑定到另一个对话：`error` 模式 400，`drop_block` 模式丢弃并在响应的 `input_transformations` 里报告。

**存储**：以摘要正文（去首尾空白）的 SHA-256 为键保存 `{content, signature, toolChanges, model, createdAt}`；写入器与读取器成对导出并用生产写入器测试；条数与保留天数有上限；文件属主可读写。每条记录还带作用域（Key 与端点的联合指纹），只在同一作用域内回放，换端点或换 Key 后既不误用也不误删；不按模型限制，上游接受在另一个支持压缩的模型上回放。回放时从检查点文本里取出标签之间的摘要，按哈希查到就整条替换成压缩块（检查点里摘要之前的前言随之不发），查不到就保持文本形式。

**退回**：上游在任何输出之前返回 400 且明确表示 `compaction` 参数是未知输入、压缩 beta 不被接受或模型不支持压缩，或返回空摘要，则在同一次调用内按原样的客户端请求重发并标记该端点与模型：模型级拒绝持久化到能力记忆（7 天），参数级/beta 级拒绝与空摘要只留内存 30 分钟。压缩块本身被拒（签名与正文不符、位置不对）不算“不支持”：此时忘掉这条记录并重试一次，主轮次与压缩请求都如此。

**模型门控与标记寿命**：块查表只在 `entry.serverCompaction` 为真且端点+模型未被标记不支持时交给 mapper；否则检查点保持文本形、不发 compact beta，存储里的块不遗忘，换回支持压缩的模型继续回放。未知 `claude-*` id 继承当前世代模板（乐观地尝试块回放、服务端压缩与快速模式），运行时纠正靠能力记忆落地：模型级压缩拒绝（`'<model>' does not support ... compaction ...`，已在 `claude-sonnet-4-5-20250929` 与 `claude-haiku-4-5-20251001` 实测）、两种快速模式结论与 system 角色结论写入 `claude-api-capability-memory.json`（键为归一化端点+模型 id，不含 Key；四个结论字段各自独立、各带 7 天过期；属主可读写、原子写入、500 键上限、每次写入清理过期），重启后不再重付被拒请求，过期后重新乐观尝试。参数级或 beta 级压缩拒绝描述的是端点（可能升级），只留在内存标记 30 分钟，不写入该文件。system 角色拒绝（"role 'system' is not supported on this model"，`claude-opus-4-7` 实测）记 `systemRole: 'unsupported'`：当次调用在任何输出之前以 `{...entry, midConversationSystem: false}` 重试一次（mapper 随之把 system 消息折叠进系统提示、工具增删改成文字说明、单轮提醒保持用户文本形），后续调用前置生效不再先失败，且记忆有效期内 `listModels`/`resolveModel` 不再为该模型声明 `toolUpdate: 'in-history'`；位置错误（"role 'system' must follow ..."）是我们请求的 bug，不匹配该识别器、原样上报。四种纠正可同调用组合，下一个请求体按已学到的全部纠正重建。支持压缩的模型之间不设模型限制（Haiku 5.5 制作的块在 Opus 5.5 回放、再压缩、跨模型历史压缩均 200）。带块请求被模型级 400 拒绝时标记并以文本形重试一次，块保留；块 validity 错误仍走遗忘+重试。

**适用条件**：请求 purpose 为 compaction、设置开启、模型 `serverCompaction` 为真、端点+模型未被标记为不支持、且能剥掉末尾指令；不要求会话 ID，也不要求本适配器服务过主轮次。别的线路明确改派到本线路的压缩同样走服务端压缩（用户决策：选本线路做摘要器就是想要它的服务端压缩），产生的压缩块 likewise 存储，该对话之后若跑在本线路上即可整块回放。

## 错误体

两种形状都要能解析出 `error.message` 与 `error.type`：官方的 `{"type":"error","error":{...,"details":{"error_code"}},"request_id"}` 和网关自己的 `{"error":{"message","type"},"type":"error"}`。网关还可能返回 `{"code","message"}`（例如额度耗尽）。

## 客户端版本

见 `client-version.ts` 的模块注释。取值顺序：环境变量 `DSH_CLAUDE_API_CLI_VERSION`（立即生效、永不延迟）→ 本进程从 npm 取到 → 磁盘上最后一次取到 → 内置默认。值全局一致：任何时刻所有会话报同一个版本；新版本仅当从未记录活动、或线路空闲不短于记住的 TTL（采纳以来见过的最长 5m/1h，初始 5m，采纳后重置为 5m）时才被采纳，采纳前 `current()` 返回旧值并把新版本报为 `pending`，卡片版本行在同一行追加「空闲后更新为 {version}」。采纳的代价是每个运行中的对话一次提示缓存 miss；preserved-thinking 模型上更早的思考块由 `drop_block` 丢弃并在 `input_transformations` 里报告。

**持久化文件**（均在 `$DSH_HOME/storages`，属主可读写）：`claude-api-credentials.json`（Windows 为 `.dpapi`）加密 API Key；`claude-api-settings.json` 设置与设备 id；`claude-api-client-version.json` 最后一次从 npm 取到的版本；`claude-api-compaction-blocks.json` 服务端压缩块（按 Key+端点作用域隔离）；`claude-api-capability-memory.json` 模型能力结论（端点+模型为键，7 天过期）；目录快照走共享内核 `catalog-snapshot`（按 Key+端点指纹隔离）。

## 隔离

全部行为代码在 `src/host/claude-api/` 与 `src/client/claude-api/`。共享文件只做单条追加（受控线路列表、诊断线路列表、线路代理列表、提示缓存策略表、三语线路名）。不改 `compaction-route`、`compaction-prompt`、压缩策略守卫与任何其他线路目录。其他线路只有在把自己的压缩明确路由到本线路时才受影响，其余行为不变。

## 补充实测（2026-11-21）

- 压缩块与 `context_management` 同时出现在主轮次上没有冲突（200）；两者只是不能同时出现在带 `compaction` 参数的那个请求里。
- 压缩请求与其后的主轮次，计费归因块里的指纹不同（首条用户文本变了），保留轮次的思考块在 `error` 模式下仍然有效。因此指纹按官方算法随当前首条用户文本计算，不做会话内固定。
- 上游接受的 `anthropic-beta` 取值：官方 SDK 枚举加客户端与源码里出现的共 73 个，71 个被接受，`dev-full-thinking-2025-05-14` 与 `agent-memory-2026-07-22` 被拒。

## 风险与未验证项

- 交互模式的入口标识 `cli` 与身份句只有源码依据，没有抓包；用它们构造的请求实测被接受。
- 请求形态按 2.1.330 抓取。版本号自动跟随 npm 后，若官方改了请求头、beta 集或 `system` 结构，线路不会自动跟上；指纹盐若被更换，指纹会与官方不一致。需要时重新抓包更新常量。
- `X-Stainless-*` 里的 SDK 与运行时版本不随 npm 变化。
- 没有直连官方端点做过实测。
- Opus 5 与 Opus 4.8 的快速模式带 beta 后一直被上游限流，未测通。
- Mythos 各型号的能力行照抄同代 Fable，未单独验证。
- 把仓库现有压缩指令作为 `instructions` 传入只在短对话上验证过会被遵守。
- 等待续热只经离线注入时钟/定时器与 mocked 流验证（含 `job/registered` / `job/settled` 事件形状）；没有对真实端点跑过「1 小时档 + 空闲 55 分钟 + 委派仍在跑」的长会话，也没有实测续热请求的缓存读取命中率。
