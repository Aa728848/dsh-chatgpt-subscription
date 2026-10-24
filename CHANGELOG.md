# Changelog

## Unreleased
- **[harness] 新增 DSH 0.2.1-rc.3 支持，并补齐旧世代的客户端类型兼容**
  - **基线**：18 个直接 DSH `devDependencies` 提升到 `^0.2.1-rc.3`，对应 peer 联合范围追加同项，npm 与 pnpm 锁文件同步更新；0.1.2-alpha.5 以来的旧范围全部保留。`rc.3` 对插件导入面的变化集中在 Conversation View 与右侧指南卡片的固定 / More 菜单，以及草稿初始化的追加模式；现有插槽、`setDraft`、LLM / 工具 / 设置 / WebServer 等接口无破坏变化，因此不新增版本分支，也不改变任何供应线路的请求行为。
  - **旧世代类型桥**：`src/index.ts` 用本地结构类型表示 volatile 配置，避免直接依赖 Cordis 4.0.2 尚未导出的 `Volatile`；`minimax-code/commands-contract.ts` 在既有命令类型边界补充 `label` / `icon` / `SelectOptionGroup` 的兼容形状；进展更新设置改用本地 `ConfigForm` / `ConfigFormSnapshot` 结构类型，旧版没有 `configForms` 服务时仍按原逻辑降级，新版仍使用真实服务。以上均为类型适配，无运行时协议变化。
  - **验证**：`rc.3` 三工程强制类型检查、构建、`npm ci --dry-run` 与打包通过，全量 **282 文件通过 / 2 skipped，4649 passed / 8 skipped / 0 failed**；精确 `rc.2` 隔离房间结果完全相同。`0.1.5-rc.1` 隔离房间强制类型检查通过，其余可运行套件 **281 文件通过 / 2 skipped，4644 passed / 9 skipped / 0 failed**；唯一不能加载的是该世代没有 `@deepseek-ai/dsh-ptc-runtime` 的 `subagent-model-authorization-ptc.test.ts`，与既有世代限定约定一致。
  - **实机**：用 npm 发布的 `@deepseek-ai/dsh@0.2.1-rc.3` 在隔离 `DSH_HOME` 安装本次 tarball，启动无条目激活警告；插件管理页显示 1 个组件运行中，设置页确认版本为 `0.2.1-rc.3`，12 条订阅线路与进展更新设置均正常渲染。未使用真实订阅凭据或发起模型请求。

## 0.38.1 - 2026-10-24
- **[kimi-code] 请求体上限改成按模型分档：1M 档 8 MiB、256K 档 2 MiB（`DSH_KIMI_CODE_MAX_BODY_BYTES` 仍是全局强制覆盖）**
  - **现象**：1M 上下文档位（`k3` / `k3.1-pro` / `k3.1-pro-highspeed` / `kimi-for-coding`）的会话把中文正文写到 3–4 MB 就被本线路的本地字节守卫拒绝，请求根本没发出去；宿主压缩也救不回来——压缩请求自己同样超过那个上限，于是长会话表现为「压缩一次后仍然失败」，而服务端从未拒绝过这个体积。
  - **根因**：这条线路对**所有**模型套用同一个 `MAX_MESSAGE_BODY_BYTES`（2,097,152）。该数字来自官方错误参考里的通用示例（`total message size N exceeds limit 2097152`），**从未针对 1M 上下文档位实测**；而 1M 窗口的正文按英文约 4 MB、按密集中文约 4.5 MB，2 MB 必然先到。官方 `kimi-cli` 全仓库没有字节守卫，说明这个上限至少不是客户端必需的。
  - **改法（分档）**：`model-catalog.ts` 的 `KimiCodeCatalogModel` 新增必填字段 `maxRequestBodyBytes`：`k3` / `k3.1-pro` / `k3.1-pro-highspeed` / `kimi-for-coding` = **8 MiB（8,388,608）**，`k3-256k` / `kimi-for-coding-highspeed` = **2 MiB（2,097,152，保持原值）**。8 MiB 的依据是「1M 窗口的正文大小」：一个 1M token 的请求体按英文约 4 MB、按密集中文约 4.5 MB，8 MiB 留出近一倍余量，所以**字节上限不会成为 1M 会话的实际瓶颈**；真正先到的是模型自身的 token 窗口——服务端回 `Your request exceeded model token limit`，该措辞已被 `common/context-overflow.ts` 归一到 `CONTEXT_WINDOW_EXCEEDED`，压缩与重试照旧生效。8 MiB 仍是**待实测的上界**，不是文档写明的网关上限。
  - **改法（代码）**：`types.ts` 新增 `LONG_CONTEXT_MESSAGE_BODY_BYTES`（8 × 1024 × 1024，常量定义在 `model-catalog.ts`、由 `types.ts` 重新导出，避免 ESM 循环）与 `maxRequestBodyBytesFor(model, env)`，优先级为 **env → `model.maxRequestBodyBytes` → `DEFAULT_MAX_MESSAGE_BODY_BYTES`**（注册表不认识的 id 走最保守的 2 MiB）；`maxMessageBodyBytes(env)` 与其语义**原样保留**（无模型上下文的调用方仍拿 2 MiB）。`mapper.ts` 的 `assertRequestBodyFits(body, carriesVideo = false, context?, limit?)` 新增可选 `limit`，拒绝文案引用生效上限，不传时逐字节等于旧行为。`adapter.ts` 的 `bodyLimit` 改为 `carriesVideo ? MAX_VIDEO_MESSAGE_BODY_BYTES : maxRequestBodyBytesFor(<该模型的注册表行>, process.env)`，并把这个 `bodyLimit` **显式传给两处** `assertRequestBodyFits`——此前这两处各自又算一遍上限，模型档位根本到不了守卫。注册表行按 id 从 `model-catalog.ts` 取，而不是直接用线上 `/v1/models` 的条目：线上目录只报能力、从不报字节额度。
  - **改法（env）**：`DSH_KIMI_CODE_MAX_BODY_BYTES` 仍是**全局强制覆盖、优先级最高**；空串、非有限、`0`、负数一律回落到**该模型的默认值**而不是关闭守卫（合法值会 floor，前后空格容忍）。视频档 `MAX_VIDEO_MESSAGE_BODY_BYTES`（64 MiB）不受影响。
  - **测试**：新增 `test/kimi-code-body-limit-per-model.test.ts`（16 例）——六个条目的 `maxRequestBodyBytes` 逐一切值（8 MiB ×4 / 2 MiB ×2）、8 MiB 对两种 1M 正文密度都留有余量、resolver 的三级优先级（env 双向覆盖、模型行、未知 id 回落 2 MiB、小数 floor、空白容忍）、非法值（`''`、纯空白、`abc`、`0`、`-1`、`-2097152`、`NaN`、`huge`）回落到模型默认值而不关守卫、端到端 3.5 MB 在 `k3.1-pro` 上**能发出**（fetch 调用 1 次）而在 `k3-256k` 上被拒（fetch 0 次、文案含 `2097152`、码为 `CONTEXT_WINDOW_EXCEEDED`）、4.5 MB 能发、8.5 MB 被拒且文案含 `8388608`、env 强制把 1M 档按回 2 MiB、env 拼错仍拒、13 MB 视频照旧走 64 MiB 档、以及 `assertRequestBodyFits(body)` 无参调用仍按 2 MiB 抛错。另修正两处**依赖旧的全局 2 MB**的既有用例（**没有删任何断言**）：`kimi-code-capacity.test.ts` 的「2.1 MB 请求本地即拒」与 `kimi-code-adapter.test.ts` 的「不做没做过的省略」改跑 `k3-256k`——那两处的体积仍在该档 2 MB 之上，测的行为（本地拒绝、码、文案、fetch 零调用）一条未减。
  - **验证**：`npm run typecheck` 三工程 0 错误（退出码 0）；`npx vitest run test/kimi-code**` 34 文件 / 512 例全绿；全量 `npm test` 282 文件通过 / 2 skipped、4649 passed / 8 skipped / 0 failed；`npm run build` 通过。
  - **文档**：README 的 Kimi Code 小节把「请求体超 2 MB 本地即拒绝」改写成「按模型分档：1M 档 8 MiB / 256K 档 2 MiB」，写明 8 MiB 是待实测上界与该口径的推导、env 仍为全局覆盖且非法值回落，「上下文窗口」段落与错误处理总表里的 2 MB 措辞同步更新，并注明 `DSH_KIMI_CODE_BYTES_PER_TOKEN` 的折算基准**刻意仍是不随模型变动的 2 MiB**。
  - **已知边界**：`DSH_KIMI_CODE_BYTES_PER_TOKEN` 的窗口折算仍以那个与模型无关的 2 MiB（设了 env 则取 env）为基准，不跟随按模型档位——它是可选的提前压缩开关而不是守卫，本次刻意不动；不想提前压缩时不设该变量即可（默认就是不设）。

## 0.38.0 - 2026-10-24
- **[kimi-code] 新增 K3.1 Pro 系列（与其它模型同一 OpenAI 兼容 chat completions）、只支持思考的档位、以及缓存写入这个计费项**
  - **现象**：`k3.1-pro` / `k3.1-pro-highspeed` 不在模型目录、设置卡与能力表里；「默认思考档位」永远列着 `low` / `high` / `max` 与「关闭思考」，而 K3.1 Pro 根本关不掉（服务端 400）；缓存区块只有命中率、命中 / 新处理 / 输出 tokens 与请求数，**写入**这个独立计费项一个数字都没有，看不出 5m / 1h 两档各写了多少。
  - **模型目录**：两条新条目按官方型号表写入（`k3.1-pro` 默认 256K、可覆盖到 1M；`k3.1-pro-highspeed` 1M），含 `thinkingType: 'only'`、`defaultReasoningEffort: 'max'` 与 `quotaMultiplier: null`（官方未公布相对倍率，卡片显示「未公布」而不是猜成 1×）。**协议不新增分支**：本线路对全部模型只走 OpenAI 兼容 chat completions（与官方 agent 的 `type = "kimi"` 一致），因此 K3.1 Pro 的请求照常发往 `/v1/chat/completions`，视频输入按型号表声明可用。
  - **thinking-only**：`types.ts` 增 `thinkingTypeFor` / `defaultReasoningEffortFor` / `coerceThinkingEffort`，`reasoningEffortsFor` 对 `only` 行剔除 `none`；`adapter.ts` 在构建 body 之前加一道闸门（THE THINKING GATE）：被禁的 `none` 抬到模型默认档并通过 `recordThinkingCoercion` 记录（`KIMI_CODE_THINKING_COERCED` 警告），而不是让整轮失败。
  - **缓存写入**：总量读 `usage.prompt_tokens_details.cache_write_tokens`（chat）与 `cache_creation_input_tokens`（Anthropic），5m / 1h 分档读 `Msh-Usage-Cache-Write-Tokens-5m/-1h` 响应头；`KimiCodeCacheStatsDto` 的 `cacheWriteTokens` / `cacheWrite5mTokens` / `cacheWrite1hTokens` 由 `routes.ts` 填真值（原 `cacheWriteTokensNote: 'always-zero-on-this-route'` 占位删除）。chat wire 的新处理量改为 `total − cached − written`（三者互斥），Anthropic 的 `input_tokens` 仍不减——它本身不含缓存。
  - **改法（客户端）**：新增 `src/client/kimi-code/labels.ts`——`wireLabel`、`effortLadder`（读模型声明的档位，`thinkingType === 'only'` 时剔除 `none`）、`canDisableThinking`、`effortOptions`（取已勾选模型的并集；「关闭思考」是开关不是档位，任一勾选模型允许它就保留），两张卡片都从这里取标签。档位下拉改由 `effortOptions` 驱动；存着的档位若所有勾选模型都不接受，仍保留该选项并标注「当前勾选的模型不接受」。只支持思考的模型在档位旁给一句说明（含模型名与 400），能力表新增「只支持思考」标记与脚注。缓存区块新增一行 `缓存写入 = 总量 · 5 分钟档 · 1 小时档`，**0 也照实显示**（空白会被读成「没有测量」）。
  - **改法（三语）**：`kimi-code/locales.ts`（zh + en）与 `locales-ru/kimi-code.ts` 同步新增 `capThinkingOnly` / `capEfforts` / `capThinkingOnlyFootnote` / `effortThinkingOnlyNote` / `effortNotOffered` / `quotaUnknown` / `cacheWrite` / `cacheWrite5m` / `cacheWrite1h` / `cacheWriteHint` / `unknownMetric`，并按官方口径重写 `cacheTtlHint`、`cacheTtlDefault`、`defaultReasoningEffortHint`；俄语包键集由 `Record<KimiCodeLocaleKey, string>` 在编译期强制，缺一个键 `tsc` 就红。
  - **测试**：新增 `test/kimi-code-k31.test.ts`（17 例：两条条目的全部字段、thinking-only 语义、双值 wire 与视频按声明保留、卡片契约字段）、`test/kimi-code-k31-card-ui.test.tsx`（8 例）、`test/kimi-code-effort-ladder.test.ts`（6 例）与 `test/kimi-code-cache-write.test.ts`（9 例：chat wire 的 usage 三分解、Anthropic 不减、响应头分档、以及 thinking 闸门在 chat / Anthropic 两条 wire 上的行为）；`test/kimi-code-capability-ui.test.tsx` 补「未公布倍率」与「只支持思考 + 400 脚注」两例。
  - **验证**：`npm run typecheck` 三工程 0 错误；全量 `npm test` 281 文件通过 / 2 skipped，4633 passed / 8 skipped / 0 failed（删掉的用例全部只属于已撤除的 Responses 分支）。
  - **文档**：README 的线路总览把 Kimi 的协议列改为「OpenAI 兼容 Chat Completions（可选 Anthropic Messages）」，模型目录由四款改为六款，补缓存写入那一行、倍率表里的两个「未公布」，并明确「本线路对全部模型使用 OpenAI 兼容 chat completions（与官方 agent 的 `type = "kimi"` 一致）」、视频清单加入 `k3.1-pro`，以及设置步骤里「默认思考档位跟随模型声明」。

## 0.37.0 - 2026-10-23
- **[progress-updates] 进展更新补上「开局」与「收尾」两条硬要求**
  - **现象**：任务开始和结束都没有进展条目，整场只在被催到的时候冒出两三条；面板看着像「只有出结论才有动静」。
  - **根因**：整条链路只折叠模型显式调用 `progress_update` 的事件（`projection.apply` 对其它名字的 `tool/call`、`tool/ptc-dispatch` 原样返回），没有任何从工具活动自动推导的路径；而模型侧唯一的正向纠偏是「8 轮催促」，它在 `tools/post-execute` 上从 0 数到 8 才响，结构上不可能在 t=0 触发；收尾时模型输出的是最终答复正文而不是工具调用，`post-execute` 不触发，于是也没有收口那一条。实测本会话日志：三条进展分别紧跟三次催促（seq 86→94、160→168、252→260），首条出现在第 8 轮之后，`turn/end`（seq 347）之前的 87 个事件里一条都没有。
  - **改法**：`prompt.ts` 的引导词把「开局（第一批工具调用之前）」与「收尾（最终答复之前）」提成两条硬要求，原来的「任务早期」条目降级为「计划真的变了才补」；`tool.ts` 的工具描述在首句后同步一句书挡要求——描述是模型每次调用都会读到、离调用最近的一段文本。催促阈值不动默认值（仍是 8，`NUDGE_THRESHOLD` 是测试守着的冻结契约），本机在 profile 配置里设成 4。
  - **验证**：`npm run typecheck` 三工程 0 错误；全量 `npm test` 277 文件 / 4586 passed / 8 skipped / 0 failed（工具描述的子串断言一条没改）；`npm run build` 通过，`lib/index.js` 里能搜到新文案。
  - **留档**：结构层面的锚点（`agent/pre-step` 做开局、`agent/turn-stopping` + `steer` 做收尾）这次刻意没做，纯文本仍是软约束，模型可以不照做。
- **[progress-updates] 提示词整段转英文，并新增「输出语言」设置（auto / 中文 / English）**
  - **现象**：进展更新的系统提示词是中文的，而工具描述本来就是英文——同一件事两套语言；用户也无法指定进展本身用哪种语言写。
  - **改法（提示词）**：`prompt.ts` 的 `PROGRESS_GUIDANCE` 整段换成英文，与工具描述统一措辞。新增 `ProgressUpdateLanguage = 'auto' | 'zh' | 'en'` 与 `PROGRESS_LANGUAGE_DIRECTIVES`：把「标题与正文用哪种语言写」做成一句追加在引导词末尾的指令——`auto` 跟随对话语言（日、俄等其它语言自动跟随），`zh`/`en` 明确压过对话语言。**「指令用英文」与「输出用中文」是两件互不影响的事**，这正是把语言单独拆成一个开关的原因。
  - **改法（设置）**：宿主 `Config` 新增 `progressUpdatesLanguage`（`z.union([z.const('auto'), z.const('zh'), z.const('en')])` + `default('auto')` + `volatile()`，与另两个字段同一套：保存即生效、不重挂插件行）；`resolveProgressUpdatesSettings` 用白名单校验，配置里写了个不认识的字符串等于没写（退回 auto），而不是把它原样拼进提示词。设置页从三行变四行，第三行是原生 `<select>`（`data-dsh-part="settings-language"`），三个选项就是 schema 的三个取值；中/英/俄三份字典同时补齐（俄语里语言名用 Китайский，因为 `russian-locale.test.tsx` 明令俄语包里不许出现 CJK）。
  - **测试**：`progress-updates-apply` 新增「语言指令追加在引导词末尾」（含活引用就地换值，单实例守卫下读一次卸一次）与「未知取值退回 auto」；`live-ref-and-route` 补 schema 默认值；`progress-updates-client` 新增「下拉写的是 progressUpdatesLanguage，选项就是三个取值」，行数断言 3→4，控件禁用态补一条；中文断言同步换成英文。9 个进展更新测试文件 150 例全绿。
  - **验证**：`npm run typecheck` 三工程 0 错误；全量 `npm test` 277 文件 / 4590 passed / 8 skipped / 0 failed；`npm run build` 通过。
- **[opendesign] 额度卡终于有进度条了：吃的是控制台同源的 Design Plan 窗口（5 小时 / 7 天），不是钱包余额**
  - **现象**：OpenDesign 线路的卡与设置页只有金额（「可用余额 $1.50」），没有任何百分比进度条；而 OpenDesign 控制台的计费卡明明画着「Design Plan · 5 小时额度 剩余 90%」「7 天额度 剩余 81%」两条带重置倒计时的进度条。
  - **根因（两层）**：一是**读错了面**。插件一直只读 `/billing/summary` 与 `/wallet/balance`——前者给套餐档位与「还剩多少 credits」，后者给钱包余额，**两者都没有「这一期一共给了多少」**，所以「已用/总量」这个分母根本不存在，代码里那句「本卡不发明一个总数去除」是对的。二是**真源在另一个端点**：从控制台 SPA 的 bundle 反查出 `GET {amr}/workspaces/{workspaceId}/billing/coding-plan-usage`（带 `x-vela-workspace-id`），返回 `{ tier, eligible, windows: [{ policyId, durationSeconds, remainingCredits, limitCredits, resetsAt }] }`；控制台自己的过滤逻辑是 `durationSeconds === 604800`（7 天）加 go 档的 `18000`（5 小时），百分比就是 `remainingCredits / limitCredits`。该路径实测存在（未鉴权 401；此前猜的 `/billing/windows`、`/billing/coding-plan`、`/billing/preflight` 全是 404），工作区 id 来自 `GET {amr}/workspaces`。
  - **改法（宿主）**：新增 `fetchWorkspaceId()` 与 `fetchCodingPlanUsage()`（绝不 throw，非 200 把 `HTTP <status>: <code|message>` 作为数据返回，`coding_plan_configuration_unavailable` 原样透传；窗口解析严格——`policyId` 非空、`durationSeconds` 正整数、`limitCredits > 0`、两个金额都是整数字符串、`resetsAt` 为 null 或可解析 ISO，**不合格的窗口丢弃而不是补**）。`/usage` 变成三路并行（钱包 / 账单 / 额度窗口），工作区 id **每个请求只解析一次**并复用（失败也复用、不重试，两个账号实测只发 1 次 `/workspaces`，避免每个账号各撞一次同一个 401）。DTO 新增 `OpenDesignCodingPlanDto` 与 `OpenDesignUsageAccountDto.codingPlan`（失败也带 `error`，因为「空列表」与「这条线路没有窗口」是两句话）。看板缩放器把这批窗口变成 `line-card` 的普通 `quota.windows`：`usedPercent = (limit − remaining)/limit`、`windowMinutes = durationSeconds/60`、`label` 留空让卡片自己按分钟说「5 小时 / 7 天」，`credits` 继续只放钱包余额。
  - **改法（界面）**：设置页每个窗口一行——名称 + 「已用 x% · 剩余 y%」+ `role="progressbar"` 进度条 + 「{时间} 重置」；读不到或该工作区未配置时只写一句弱化说明，绝不画 0% 的假条。输入框徽标在有窗口时显示最窄窗口的「剩余 90%」并带一条细进度条，tooltip 列出所有窗口；没有窗口则逐字退回原来的 `$余额`（其他线路的徽标 DOM 有专门用例守着，一个节点都没变）。看板卡复用既有窗口行，自动得到「5 小时 / 7 天」两行、两条 meter、百分比与倒计时。
  - **一次被推翻的口径（留档）**：中途曾按「累计消耗占比 = 已消耗 ÷（已消耗 + 剩余）」做过一版，用户指出套餐本身有独立额度后废弃——那条式的分母会随充值漂移，且与「本期用了多少」不是同一件事。全部改动已回退，最终口径只有一套：窗口的 `limit − remaining`。
  - **测试**：`test/opendesign-routes.test.ts` 31 例（workspace 解析的数组/包装/无 id/401、窗口读取的两窗口与坏窗口丢弃、拒绝码作为数据、每请求只解析一次工作区、钱包在额度读取失败时不丢）、`test/widget-board-lines.test.ts` 57 例（两窗口 → 300/10080 分钟、已用 10/19%、`resetsAt` 毫秒、`label` 为空、钱包仍在；读不到时 windows 为空且原因进 error）、`test/opendesign-section.test.tsx` 17 例与 `test/composer-quota-badge.test.tsx` 10 例（每窗口一条 bar 与 aria 值、失败/未配置不画条、徽标有窗口显示剩余%、无窗口退回余额且零新节点）。
  - **验证（含实机结论）**：`npm run typecheck` 三工程 0 错误；全量 `npm test` 277 文件通过 / 2 skipped、4578 passed / 8 skipped / 0 failed；`npm run build` 通过。
    **实机 2026-10-22（真实 Go 账号，三次重启逐步定位）**：① 首版拿 `/workspaces` 列表找不到 id → 改成「先 `/workspaces/current` 再列表兜底」，实机确认 `activeWorkspaceId` 能解析；② 解析通了以后 coding-plan 端点回 `HTTP 401: unauthenticated`；③ 按序轮试三种凭据形状（`Bearer vela_ctrl_…` / `Bearer sk-amr-…` / `x-api-key: sk-amr-…`）**全部 401**。
    **结论**：该端点只认控制台浏览器会话，插件持有的 key 一律不放行；官方 CLI 能读到同样窗口是用它自己的 `vela login` 会话。因此设置页把这种情况与「工作区未配置」分开，显示「额度窗口仅在 OpenDesign 控制台可见」；看板卡只写一句原因、不画 0% 假条。读取路径保留（上游哪天放开 key 或换到有会话能力的调用方即自动生效），失败时的 error 会带尝试记录，便于日后一眼判断。
- **[proxy] 代理不再劫持回环与本机网关，Linux 也能自动发现系统代理；代理卡文案改成“全部供应线路”**
  - **现象**：把某条线路的 baseURL 指向本机网关（例如本地转发在 `http://127.0.0.1:9090`）时，请求会被塞进系统代理——`ProxyAgent` 只认一个 `dispatcher`，既不看 `NO_PROXY` 也不对回环地址做豁免，而本机代理工具（Clash/Mihomo）通常用 fake-ip DNS 拒掉或转回自己，于是出现“直接 curl 通、插件一路 400 / ECONNREFUSED”。同一处还有第二个洞：`auto` 模式在 Linux 上完全不探测，`detectSystemProxy` 只有 win32（注册表）与 darwin（`scutil`）两个分支，Linux 用户桌面配了系统代理也永远读到 `null`，只能靠环境变量。
  - **改法（旁路）**：`createFetch` 解析出活动代理后先过一遍旁路判定——`isLoopbackHostname`（整个 `127.0.0.0/8`、`::1`、`localhost`、`*.localhost`）无条件直连；再按标准语义匹配 `NO_PROXY`/`no_proxy`（`*`、精确主机、域名后缀、`host:port`，不支持 CIDR）。列表与代理同源读取：进程环境变量优先、其次 `$DSH_HOME/.env`，`ProxyManager.getNoProxyList()` 与系统代理共用 5 秒 TTL，读取抛错一律当作“没有列表”——不会反向把代理从所有线路上摘掉。旁路命中走 `baseFetch`，与“没有代理”是同一条路径，流式、超时与诊断包裹都不受影响。
  - **改法（Linux）**：`detectSystemProxy` 新增 `platform === 'linux'` 分支，`parseLinuxSystemProxy` 读 GNOME `gsettings` 的 `org.gnome.system.proxy mode|https|http|socks`，优先 https → http → socks，输出 `http://` 或 `socks5://`；PAC（`auto`）与关闭（`none`）返回 `null` 并继续回落环境变量，对既有平台零变化。第三个参数是读取器测试缝，缺省才是真正的 `gsettings`。
  - **改法（文案）**：`proxyModeHint` 与 `proxyDirectHint` 三份语言包（中/英/俄）改成“本插件的全部供应线路”，并写明登录、令牌续期、模型目录与配额读取同样经过这条代理；README 的代理段落同步补上按平台的探测方式、旁路规则与 `NO_PROXY` 语义。旧文案只说“GPT 与 Antigravity（Gemini）共用”，在 12 条线路的时代早已不成立。
  - **测试**：`test/proxy-manager.test.ts` 新增 22 例（42 例全绿）——回环无论列表怎么写都直连；`*`/后缀/精确主机/`host:port`/带 scheme 与路径的条目；无法解析的目标不旁路；`ProxyManager` 在代理生效时把回环与 `NO_PROXY` 主机交给 `baseFetch`（含 `Request` 入参）；未列名主机仍走代理；TTL 缓存与抛错读取器；GNOME 解析（https 优先、socks 回落、`auto`/`none`/缺端口/IPv6 括号）；`detectSystemProxy` 的 linux 分支与环境变量回落。
  - **验证**：`npm run typecheck` 三工程 0 错误；`npx vitest run test/proxy-manager.test.ts` 42/42；全量 `npm test` 277 文件通过 / 2 skipped，4557 passed / 8 skipped / 0 failed；`npm run build` 通过。
- **[board] 组件看板上一张卡看一条线路：`line-flip`，一条线路一张会翻面的卡**
  - **形态**：看板插件在宿主上发布 cordis 服务 `widgetBoard`（apiVersion 3）。本插件在 `apply` 顶部无条件接线，经 `ctx.inject(['widgetBoard'])` 注册一个组件目录（`widgets/`，随包发布）、一个数据源（`line-card`）与三个能力（`line-refresh` / `line-account-switch` / `line-account-strategy`）。看板缺席时整段是 no-op；注册失败只 warn，绝不影响插件装载；卸载时一次 `handle.dispose()` 全撤。
  - **一张卡一条线路**：`widgets/line-flip` 在 `props.line` 里写线路 id（`codex`、`claude`、`kimi-code`、`minimax-code`、`antigravity`、`command-code`、`glm-coding-plan`、`step-code`、`qoder`、`cline-pass`、`opendesign`），`line-card` 就照着它读那一条线路：正面是额度窗口的已用百分比、进度条与重置倒计时，背面是这条线路的号池、当前账号与三档轮换 chip。刷新、切号、改策略都走能力（`widget.action` 拿不到返回值），并用能力返回值重画。同一份组件摆多张就是多条线路，加一条线路只需在 `src/index.ts` 的 `lines.pools` 里加一行。
  - **单位**：各线路在 wire 上的时间表示并不统一（codex 是 Unix **秒**，antigravity / cline-pass 是 ISO 字符串，其余是**毫秒**），换算在 `src/host/widget-board/line-quota.ts` 的每线 normalizer 里各做一次，卡片数据一律毫秒，且不按数量级猜单位。
  - **命名**：看板 manifest 的 `source`/`capabilities` 只接受 `[a-z][a-z0-9.-]{1,39}(?::…)?`，带 scope 的包名进不去，所以注册用的 provider 取 `dsh-chatgpt-subscription`，与 manifest 逐字相同才能解析；`test/widget-board.test.ts` 现在照着真实注册结果，逐条比对 `widgets/*/widget.json` 的 `source` 与 `capabilities`。
  - **数据源与能力都不声明 permission**：它们只读本机线路自己的 `GET /status`、只写本插件持有的号池文档，不跑命令、不访问组件指定的主机，没有需要人批准的东西。
  - **测试**：`test/widget-board.test.ts`（11 例）只测仍然存在的边界——组件目录注册（provider 名、apiVersion 透传、id 语法）、看板缺席是 no-op、注册失败只 warn、卸载时 dispose（含迟到的注册被退回）、无 capabilities 的看板只注册数据源、没有线路注册表时不注册任何东西，以及 manifest 与注册 id 的逐字对齐。
  - **验证**：`npm run typecheck` 三个工程 0 错误；`npx vitest run test/widget-board.test.ts test/widget-board-lines.test.ts` 42 例全绿（11 + 31）；全量 `npx vitest run` 277 文件通过 / 2 skipped，4519 passed / 8 skipped / 0 failed。

## 0.36.2 - 2026-10-22
- **[claude] 设置卡不再拿一枚已死的 access token 请求上游：status / 额度 / 测试连接 / 目录刷新统一走号池续期，托管账号闲置一夜后不再诱导用户重新登录（#66）**
  - **现象**：Claude 订阅的 access token 只有约 8 小时寿命。卡片上的「令牌到期」、额度读取与「测试连接」在托管（managed）账号闲置一夜后全部出错——到期时间显示为过去时间、额度区报错、连接测试失败，看起来像「登录每天失效」，用户于是每天重新登录一次；而重登只是把到期时间刷成新的 8 小时，第二天照旧。
  - **根因**：续期只发生在模型请求路径（`adapter` → `pool.getEffectiveAccount()` → `freshAccount()`，由 `claudeNeedsRefresh()` 在到期前 5 分钟内触发）。`/claude/api` 的 `status`、`quota`、`connection/test`、`catalog/refresh` 则直接用 `activeAccount()` 从号池读出的**存储值**请求上游，从不续期：卡片永远只看到「最后一枚被存下来的 access token」，8 小时后必然过期。相邻的 Kimi Code 线路早有 `effectiveCredentials()` 解决此事，Claude 线路缺这一段。
  - **改法**：`registerClaudeRoutes()` 新增与 Kimi 同形的 `effectiveCredentials(target)` —— 无 pool 或无 `target.id` 时返回存储凭据，否则经 `pool.getFreshCredential(target.id, fetchFn)` 续期，续期失败时回落存储凭据（卡片仍能渲染账号列表，真实原因由那次请求报告）。四条卡片路径统一改用它；`status` 先续期、再读额度、再构建响应，所以 `accounts[].expiresAt`（读自号池行，续期会写回）就是续期后的新值。`readStatus()` 增加可选第二参，让额度读取、catalog 加载与 `accounts[]` 描述同一枚已消费的凭据。
  - **不变量**：adopted（Claude Code 快照）仍然永不刷新——号池对 adopted 恒不续期、并在发网络请求前就拒绝，正好落进上面的回落分支，卡片只展示快照自身的 `authStatus`；只有续期被上游**拒绝**（`refreshFailureStatus` 仅对 `ClaudeUnauthorizedError` 写入）时，账号行才显示「需重新登录」，临时网络失败不会把账号标死。单飞由号池内核 `freshAccount()` 负责，同一枚 refresh token 不会被花两次，路由层没有另做互斥。
  - **测试**：`test/claude-routes.test.ts` 新增 `describe('credential renewal on the card paths')`（6 例，注入假 refresh seam 与记录 `Authorization` 的 fetch double，全程无网络）——`GET /status` 恰好续期 1 次且池内 `expiresAt` 变未来、不写 `authStatus`、usage 请求带新 bearer、`accounts[].expiresAt` 与池内一致、`quotaError: null`；`POST /quota` 同理；`connection/test` 与 `catalog/refresh` 分别以新 bearer 请求 `/v1/messages` 与 `/v1/models`；过期 adopted 快照刷新 0 次且仍渲染 `authStatus='expired'`；卡片与模型请求并发、两次卡片轮询并发都只续期一次。反向验证：把 `routes.ts` 退回基线后 6 条中 5 条失败（adopted 那条按设计通过）。
  - **验证**：`npm run typecheck` 三个工程 0 错误；全量 `npm test` 275 文件通过 / 1 跳过，4477 passed / 7 skipped / 0 failed；`npm run build` 通过。
  - **已知边界**：卡片路径的续期与模型请求共用同一续期入口，因此一次续期失败（例如离线）会让下一次状态轮询再次尝试续期；这与模型请求路径的既有行为一致，未在路由层另加冷却。
## 0.36.1 - 2026-10-22
- **[cline-pass] 额度不再只在手动刷新时动：状态读取按 TTL 在答背后刷新，设置卡与输入框徽标 60 秒自动更新**
  - **现象**：Cline Pass 设置页打开后额度数字就定住了——同一次会话里消耗掉的部分，要重新打开页面或点一次「刷新额度」才会反映；输入框旁的额度徽标同样停在首次读到的数字。
  - **根因**：两层各缺一半。宿主侧 `GET /cline-pass/api/status` 只答 `store.usage()` 的内存快照，只有显式 `POST /usage` 才真正向上游读（模块注释还写着「读取不触发上游调用」）；客户端侧设置页只在挂载时读一次 status，而共享徽标虽然自带 60 秒轮询，cline 这一行的 `readStatus` 却把 `refresh` 参数丢掉了，点击于是退化成又一次廉价 GET。
  - **改法（宿主）**：新增 `CLINE_PASS_QUOTA_TTL_MS`（5 分钟）与 `usageStale()`（`fetchedAt <= 0` 同样算过期）；`GET /status` 先答缓存，快照缺失或过期时用 `QuotaRefresh` 在答背后起一轮刷新，并把 `quotaRefreshing` 放进状态 DTO，让客户端知道该立刻补读；扇出逻辑抽成 `refreshUsage()`，显式 `POST /usage` 与后台刷新共用同一份实现，同源校验、400 文案、凭据零外泄全部保持不变。单飞由 `start()` 的 `pending` 保证：N 次轮询只扇出一轮。另给路由选项加了 `quotaTtlMs` 测试缝。
  - **改法（客户端）**：`ClinePassApi.status(refresh)` 分流——`false` 走 `GET /status`，`true` 走 `POST /usage` 并只取其中的 status 半边；设置页补上 60 秒可见轮询 + `visibilitychange` + `createQuotaFollowUp`（读到 `quotaRefreshing: true` 就 1.5 秒后补读，最多 3 次）；轮询是静默的——失败既不刷红字也不清掉用户正在看的红字，半输入的草稿由既有两道闸保护；徽标把 `refresh` 转发出去，点击才真正强制刷新。
  - **测试**：新增 `test/cline-pass-quota-poll.test.ts`（9 例）与 `test/cline-pass-quota-poll.test.tsx`（10 例）——冷缓存即排刷新并回 `quotaRefreshing`、新鲜快照 0 次上游调用、假 Date 拨过 TTL 后缓存照答而背后替换、2 账号 3 次轮询只扇出 2 次、显式动作立即刷新且 400/403 原样、徽标点击走 POST /usage、隐藏标签页不读、轮询失败静默、卸载清理定时器与监听。
  - **验证**：`npm run typecheck` 三工程 0 错误；`npm test` 274 文件 / 4470 例通过（1 条 `minimax-code-video-history` 的 Windows `rename EPERM` 抖动，单跑 22/22 通过，与本改动无关）；`npm run build` 通过。
  - **已知边界**：`QuotaRefresh.run()` 不与正在跑的 `start()` 合流，所以「手动刷新正好撞上后台刷新」这一步仍会多扇出一轮；两轮写入形状相同、后写的 `setUsage` 生效，代价是一次多余上游请求。真正合流要给共享 helper 加 `wait`，会牵动另外六条线路，本次不做，代码里按此写明。
## 0.36.0 - 2026-10-22
- **[client] 修复俄语语言包与 `@linxin666/dsh-i18n` 等已安装语言包冲突导致插件客户端激活失败崩溃的问题**
  - **现象**：Web 界面启动失败，提示 `web boot: 1 entry did not activate`，`@eddyskywalker/dsh-chatgpt-subscription: failed`。
  - **根因**：环境中其它插件若先于本插件注册了 `'ru'` 语言，`ctx.locale.addLanguage` 会直接抛出 `Error: locale "ru" is already registered`；未被捕获的错误导致 Cordis 插件生命周期被标记为 FAILED，从而阻断了整个客户端加载。
  - **改法**：在 `installRussianLocale` 中使用 `try-catch` 保护 `addLanguage` 与 `register` 调用，发生冲突时平滑捕获并返回 no-op disposer，继续注册本插件的各个 provider 命名空间字典；并在 `installLineLocale` 增加对 `locale` 对象的空值安全防御。
  - **验证**：新增冲突用例（`addLanguage` 抛错且某个命名空间 `register` 抛错时，安装不抛错、其余命名空间仍注册）；三工程 `tsc` 0 错误；全量 vitest 4452 passed / 7 skipped / 0 failed；`npm run build` 通过。
- **[opendesign] 套餐档位与额度改读 `/billing/summary`——订阅后不再显示 `free`，额度打开设置页即自动读取**
  - **现象**：已订阅 Go 的账号，账号行仍显示 `free`；「钱包余额」区打开时永远停在「尚未读取余额」，必须手动点刷新才出现一个美元数字，看不到套餐、周期与 credits。
  - **根因**：档位抄的是设备授权应答里的 `user.plan`，登录后永不更新，而上游对已订阅账号也返回 `"free"`（本机实测）；额度只读 `GET /wallet/balance`，且只在显式刷新时读、只存在进程内存。真正的档位与额度在控制 Key 可读的 `GET /billing/summary` 里：`membershipTier`（go/plus/pro/max）、订阅状态、本周期、订阅/充值/合计 credits 及美元、今日与累计消耗。
  - **改法**：`/usage` 并行读钱包与账单摘要，钱包被拒时用账单总额兜底，两个面各自失败不互相掩盖；账单档位覆盖登录快照，读一次就纠正账号行。设置页打开时自动读一次（仅当号池里有浏览器授权账号；粘贴的 API Key 没有控制 Key，不发请求）。「套餐与额度」区块移到账号卡下方，展示档位、状态、本周期、三类 credits 与美元、今日/累计消耗、计费请求数。仍然不画百分比条：摘要只说剩余，不说配额上限，卡片不臆造分母。
  - **验证**：三工程 `tsc` 0 错误；全量 vitest 4451 passed / 7 skipped / 0 failed；`npm run build` 通过；用真实控制 Key 请求 `/billing/summary` 返回 `go` / `active` / 15000 credits（$1.50），经 `/usage` 后 status 的 `plan` 由 `free` 变为 `go`。
- **[client] 新增俄语语言包（`ru`）：插件自己的设置界面可以选择俄语，未翻译的键回落到英文**
  - **背景**：`@deepseek-ai/dsh-client-locale` 的字典注册有两种形态——整本双语 `register(ns, { zh, en })`（内置两种语言都必须给全），以及给语言包用的单语言 `register(ns, locale, dict)`；语言本身由 `addLanguage({ id, label, fallback })` 加进目录。俄语走第二条路，**不是**给每个命名空间加第三列。
  - **改法**：新增 `src/client/locales-ru/`——13 份字典（每条线路一份，共 1440 个键，键集与 `zh`/`en` 逐一对应）+ `account-pool.ts`（12 条线路共用的账号卡片文案）+ `index.ts` 的 `installRussianLocale(ctx)`：先 `addLanguage({ id: 'ru', label: 'Русский', fallback: 'en' })`，再按命名空间逐个 `register(ns, 'ru', dict)`，每个注册各持一个 disposer。客户端入口 `apply` 调用一次。
  - **回落语义**：声明的 `fallback` 是 `en`，所以本包漏掉的键读作英文而不是键名；宿主自身的界面只有 `zh`/`en`，因此「插件俄语 + 宿主英文」是预期形态，DSH 本体要俄语是另一个语言包的事。
  - **旧宿主兼容**：`addLanguage` 是语言包那半边契约才有的接口。没有它的宿主/测试替身直接跳过整个包（此时语言根本不可选，字典也就无从取用），而不是让客户端插件在缺一个 seam 的服务上崩掉。
  - **测试**：新增 `test/russian-locale.test.tsx`（41 例）——13 个命名空间 × 三条断言（键集与 `zh`/`en` 完全一致、每个 `{placeholder}` 逐字保留、值里没有中日韩字符且不是整份照抄英文），另外钉住 `installRussianLocale` 注册一次语言 + 每条线路一次字典（disposer 数量 = 13 + 1），以及同一张 Claude 卡在 `ru` 下渲染俄语且不回落到 `zh`。
  - **验证**：`npm run typecheck` 0 错误；`npm run build` 通过；全量 `npx vitest run` 4436 passed / 4 failed——同样是与本改动无关的 4 条 `Intl` 用例（俄语默认 locale 下 `1,200` → `1 200`、日期变俄文），在改动前就红。
- **[client] 除 ChatGPT 外，所有供应商详情页在英文界面下仍是中文——卡片直接渲染自己的 `zh` 字典，从不问本地化服务**
  - **现象**：设置 › 订阅服务里点开 Claude（以及 Antigravity / Command Code / Kimi Code / MiniMax Code / GLM / Ollama / Step Code / Cline Pass / Qoder / OpenDesign），整页文案都是中文，即使界面语言是 English；只有 ChatGPT 那张卡是英文。每个命名空间的 `dictionaries` 里 `en` 早就齐全，且键集与 `zh` 完全一致，缺的从来不是翻译。
  - **根因**：12 处 `const t = zh`（`claude/ClaudeSection.tsx`、`claude/useClaudeSection.ts`、`antigravity`、`command-code`、`glm-coding-plan`、`kimi-code` 两处、`ollama`、`cline-pass`、`step-code`、`qoder`、`opendesign`）把字典对象在渲染时直接捕获；`ctx.locale` 一次都没被读过。ChatGPT 卡片能用英文，只因为它渲染的是 hub 注入的 `t` 座位。
  - **改法**：新增 `src/client/common/line-locale.ts`——`installLineLocale(ctx.locale)` 在客户端入口调用一次；`useLineDict(ns, zh)` 返回该命名空间的**字典形状视图**：属性访问不变（`t.signIn`）、键集与回退字典一致，但每个值在渲染时经 `ctx.locale.bind(ns)` 读取，并订阅 locale revision，所以切换语言会重渲染当前卡片而无需重挂载。没有 locale 服务时（单测裸挂卡片、只提供 `register`/`bind` 的旧宿主）退回回退字典，即改动前行为。
  - **顺带修掉的冻结**：模块级捕获 `zh` 的四处表（Kimi 的思考档位、cline-pass 与 opendesign 的服务端错误前缀、GLM 的区域名、`qoderModelRowHint`）改为使用渲染期解析出的字典，否则这几行会一直说中文。
  - **验证**：新增 `test/line-locale.test.tsx`（4 例）——同一张 Claude 卡在 `en` 下渲染英文、在 `zh` 下渲染中文、切换语言不重挂载即可换文案，并钉住 zh/en 键集一致这条前提；`npm run typecheck` 0 错误；`npm run build` 通过；全量 `npx vitest run` 4395 passed / 4 failed，与改动前（`git stash` 对照）完全相同的 4 条——它们断言英文 `Intl` 格式（`1,200`、`12:03`），在俄语默认 locale 的机器上必然失败，与本改动无关。

## 0.35.0 - 2026-10-21
- **【BREAKING】移除 WorkBuddy（CodeBuddy 订阅）线路及其全部残留**
  - 该线路的上游已经失效，因此整条移除，而不是藏在开关后面：`src/host/workbuddy/`（15 文件）、`src/client/workbuddy/`（5 文件）、`src/shared/workbuddy-contracts.ts`、21 个专属测试与夹具、7 个一次性实况探针、其专属文档，以及它在共享词汇表里的那几项（`CONTROLLED_PROVIDERS`、能力表、请求诊断的 provider/route/wire 三处、hub 卡片与品牌图标、composer 配额槽位）一并删除；`src/index.ts` 里 85 处注册全部摘除。
  - **用户可见的影响**：provider id `workbuddy` 与路由 id `workbuddy-subscription` 不再存在——设置页那张卡片、模型选择器里它的模型、`/workbuddy/api/*` 路由都随之消失。其余 12 条线路的行为没有任何变化；`~/.dsh/storages` 下 7 个 `workbuddy-*.json(.dpapi)` 已成惰性文件，可以自行删除，引用了 `workbuddy-subscription` 的外部配置（例如 LLM Verifier 的 provider/model）需要改指向其它线路。
  - **顺带移除的死管道**：账号摘要 DTO 的 `modelCooldowns` 及其客户端渲染、5 条只服务它的 CSS 与 `modelCooldown` 标签键——它唯一的生产者就是被删的号池，删完只剩读端，那段 UI 永远不会显示。
  - **没有跟着一起死的覆盖**：11 处「借这条线路当载体测共享实现」的用例被移植到幸存线路（缓存记账与上下文超限 → step-code，输出预留与图片预算与偏好 seam 与请求诊断 → glm-coding-plan，旧快照缺字段兼容 → kimi-code），只有真正随线路消失的机制（双区目录、`code 6004` 按账号×模型停用、签到、atrest 密钥、CodeBuddy 账号采纳）才整条删除。
  - **验证**：三工程 `tsc` 0 错误；全量测试 4352 用例通过、0 失败；`npm run build` 通过且 `lib/index.js` 与 `lib/client.js` 内 0 处命中；重启宿主后 `GET /workbuddy/api/status` 返回 404 而 `/claude/api/status` 与 `/glm-coding-plan/api/status` 仍是 200，hub overview 只剩 12 条线路。
- **【hub】订阅服务标题行右侧新增一枚「检测更新 / 更新插件」图标按钮——安静、四种结局各自说得清，本地链接安装与没有 pluginManager 的宿主降级为「只给命令」**
  - **现象**：这个插件的用户在设置页里看不到自己装的是哪个版本，也不知道有没有新版；升级只能靠自己去 npm 搜一遍再敲命令。手动更新又有一个坑：从源码 checkout 用 `link:`/`file:` 装上的人，一旦让工具「一键更新」，pnpm 会把链接覆盖成一份 registry 副本，作者的编辑目录当场变成一份旧包。
  - **改法（位置与形态：标题行右侧的一枚图标按钮）**：控件挂在 [ProviderHubSection.tsx](../src/client/ProviderHubSection.tsx) 的 overview 分支里——`<header class="dsh-hub-head">` 用 `space-between` 把 `<h2>` 放左、[UpdateCheck.tsx](../src/client/hub/UpdateCheck.tsx) 放右，`HubOverview` 只剩它原本那行 `<p class="dsh-hub-hint">`。按钮本体是一枚 28×28 的环形刷新图标（16×16 内联 SVG，`stroke="currentColor"`、1.5 描边）：透明底、无描边、圆角 8px，常态只是三级色图标，hover 才出现 `--dsw-alias-interactive-bg-hover` 并转主文字色，`:focus-visible` 是 2px 描边焦点环；检测/安装中图标按 `@keyframes dsh-hub-update-spin` 旋转并置 disabled；「有新版本且可一键装」时在图标右上角点一个 6px 的 `--dsw-alias-button-info-fill` 圆点，而不是把按钮撑长。状态文字 11px、右对齐，排在图标**之前**（DOM 顺序），命令（本地链接等只能用命令的情形）落在 header 行下方单独一行。样式全部追加进既有的 [hub-styles.ts](../src/client/hub/hub-styles.ts) 那一个 CSS 字符串——`test/client-style-ownership.test.ts` 枚举的是安装器而不是表，新增一张表会牵动它；颜色一律 `var(--dsw-alias-*, 兜底)`，深浅色不分支。
  - **改法（只在点击时取数）**：组件挂载时**不**发任何请求。设置页打开照旧只花那次 overview 请求，registry 只在对应用户动作时被问一次；`test/client-style-ownership` 与 `client-registration` 里的假 fetch 因此不需要多一条分支。
  - **改法（四种结局由 DTO 唯一决定）**：[update-contracts.ts](../src/shared/update-contracts.ts) 的 `UpdateCheckDto` 用 `{ current, latest, updateAvailable, installKind, canApply, reason?, command, checkedAt }` 把四种结局压成可判定的事实：`latest` 有值且 `updateAvailable:false` = 已最新；`updateAvailable:true` 且 `canApply:true` = 一键可装（按钮变「更新到 vX」）；`updateAvailable:true` 且 `canApply:false` + `reason` = 只能手动（附可选中命令）；`latest:null` + `reason:'registry-unreachable'` = 检测失败。`current:null`（读不到自己的 manifest）单独成一种显示，绝不写「已最新」——那是对一个没读到的版本下结论。
  - **改法（当前版本：有界向上查找）**：[update-check.ts](../src/host/update-check.ts) 的 `readOwnManifest()` 从 `fileURLToPath(import.meta.url)` 起点逐级向上，最多 6 层，只接受 `name` 等于本包名的 `package.json`。**不用**固定的 `../package.json`：bundle 后这个模块在 `<root>/lib/index.js`、源码运行时在 `<root>/src/host/update-check.ts`，同一个相对路径指向两个不同文件。
  - **改法（安装形态：先问插件管理器，再退回路径）**：`pluginManager.listBundles()` 的 `source` 是 pnpm 真正会接受的那个 spec（`dependencySpec()` 会把 `link:`/`file:` 转成绝对路径但**保留协议前缀**），所以它是权威答案；取不到时才退回路径启发式——root `realpath` 后按**整段**切分看有没有 `node_modules` 段（子串匹配会让 `node_modules-backup` 蒙混过关）。**与任务书的一处偏差**：任务书写的是「用 `listPlugins()` 按 spec 前缀判定」，但宿主 `PluginInventoryEntry` 只有 `entryId`/`moduleName`/`enabled`/`fiberPhase`/`meta`，**没有 spec 字段**；带 spec 的是 `listBundles()` 的 `BundleInfo.source`，故按后者实现。
  - **改法（最新版本与超时）**：向 `https://registry.npmjs.org/@eddyskywalker/dsh-chatgpt-subscription/latest` 取 `version`，**必须走注入的 proxyFetch**（本部署开 127.0.0.1:7890，裸 `fetch` 连不上），超时 8s（`AbortSignal.timeout`）；拒绝连接、代理不答、超时、HTML 错误页、缺 `version` 一律映射成 `reason:'registry-unreachable'` 的 200，**不是 500**——一次离线不该把整个插件报成坏的。比较用自写的 `compareVersions()`（不引依赖）：主/次/修订三元组，prerelease 小于同号正式版，数字标识符小于字母标识符，解析不了返回 `null` 并因此**不**报有新版本。
  - **改法（一键更新：先同源、再两道守卫、spec 服务端写死）**：`POST /update/apply` 先 `isSameOriginMutation`（不过就 403 `csrf-rejected`），然后按与检测**同一顺序**守卫：本地链接 → 409 `development-install`；无 `pluginManager` → 409 `plugin-manager-missing`；都过才 `installBundle('@eddyskywalker/dsh-chatgpt-subscription@latest', { enabled: true, requestId })`。这个 spec 是模块常量 `UPDATE_INSTALL_SPEC`，请求体一个字都不读，所以任何同源 POST 都无法选择要装进 profile 的包或版本。安装失败（`application: 'failed' | 'cancelled'`）把 pnpm 自己的 diagnostic 原样带回成 502 `install-failed`，不吞。成功返回 `{ installed, restartRequired, removedFirst }`：`restartRequired` **由安装结果自己的 `application` 推导**（`applied` → false，其余 → true），不再写死——HMR profile 下宿主会当场重载被替换的 bundle，那时没有任何东西需要重启；`removedFirst` 说清这次是否走了下面那条「先移除再安装」的路。
  - **改法（HMR 宿主上的一键更新：先 remove 再 install，失败回滚）**：宿主的 `installBundle` 开头有一道硬拒——`if (this.ownerContext.get('hmr') !== undefined && known !== undefined && Object.hasOwn(before, known)) throw new ManagementFailure('already-installed')`，也就是 HMR profile 里**不允许覆盖安装**。于是「一键更新」在开着 HMR 的宿主上原本只有一个结局：502 + 让用户自己去设置页。DSH 官方插件管理界面处理「更新」走的正是**先 `removeBundle(packageName)` 再安装**（`packages/client/ui-plugin-manager/src/client/manager-store.ts` 的 `update:` 动作），本插件的 apply 按同一条路实现并加失败回滚，状态机四步：① 先直接 `installBundle(UPDATE_INSTALL_SPEC)`——非 HMR 宿主在这一步就成功，**不发生任何移除**，工作副本连一瞬都不会消失；② 只有它抛错或返回 `error.code === 'already-installed'` 时才进入官方路径 `removeBundle('@eddyskywalker/dsh-chatgpt-subscription')` → 再次安装；③ `removeBundle` 抛错、返回 `stop-profile`（宿主要求先停 profile）或 `changed:false`（报了移除但 profile 文件没变）时**不再安装**——此时盘上还留着可用的旧版，再装一次只会被同样拒绝——返回可辨的失败（`stop-profile` 单独成码，文案让人先停宿主、再 `dsh plugin add …@latest`，或去「设置 › 插件」）；④ 移除后的安装失败时立刻回滚 `installBundle('@eddyskywalker/dsh-chatgpt-subscription@<当前版本>')`，版本来自服务端自己 `readOwnManifest()` 读到的 manifest（**读不到就跳过回滚而不是猜一个**），回滚结果 `restored` / `failed` / `skipped` 随失败一起回到 `error.rollback`，`restored` 还带 `restoredVersion`；回滚失败时 message 写明**插件可能已不可用**并给出钉在版本上的手动恢复命令。两条安装 spec 与回滚 spec 全部由服务端写死或由服务端读到的版本拼出，请求体仍然一个字都不读；POST 仍然先过 `isSameOriginMutation`。
  - **改法（四种结局的文案各有各的说法）**：`UpdateCheck.tsx` 的成功文案按两个事实分支——是否还需要重启、是否走了移除路径（`已安装 v0.35.0，当前已生效，无需重启` / `已移除旧版并安装 v0.35.0，重启宿主后生效` 等四种，zh/en 两本字典各加 4 个键）；失败文案把服务端给的原因原样接在后面（另有 3 个新键：已恢复 / 回滚失败 / 回滚跳过），并在前面说清回滚结果：`更新失败，已恢复 v0.34.0`，或 `更新失败，且旧版本也没能重新装回来——插件可能已不可用`（此时同一行里带着 `dsh plugin add …@0.34.0` 这条手动恢复命令，回滚被跳过时另有一套「无法自动恢复」的措辞）。仍然是同一行 11px 红字，仍然不用弹窗。
  - **一处有意的省略**：`waitForInstall(requestId)` 没有在 `installBundle` 之后再调一次。它的用途是「远端响应丢了再取一次结果」，而这条路由就在宿主进程内调用，`installBundle` 本身 resolve 的就是结算后的结果；宿主的 `installs` map 在调用 settle 前就把条目删了，那一次调用**必然**返回 `null`，只会在测试里多需要一个桩。
  - **验证**：`npx tsc -b --pretty false` **exit 0**；`npx tsc -p test/tsconfig.json --pretty false` **exit 0**；`npx vitest run test/update-check.test.ts test/hub-update-ui.test.tsx test/hub-overview-ui.test.tsx test/hub-overview-routing.test.ts test/client-registration.test.ts test/client-style-ownership.test.ts` → **6 文件 / 75 条全过**（`update-check` 28 条，其中新增 12 条状态机用例；`hub-update-ui` 22 条，含图标形态的 aria-label／旋转类／强调圆点／状态与命令位置）；全量 `npx vitest run` → **271 文件通过 / 1 文件整文件跳过（`token-store-linux`，平台跳过）/ 4402 passed / 7 skipped / 0 失败**（4379 → 4395 → 4402：先是机制八条加两套新增，图标形态又补了 7 条 UI 用例）；`npm run build` 通过。新增的宿主用例全部用注入的假 fetch 与假 pluginManager，**不打真网络**：无 pluginManager 时 check 仍报两版、apply 409；`link:` 时 check 带 `canApply:false` 且 apply 409 `development-install`、安装零次；registry 抛错 → `registry-unreachable` 而非 500；正常配对（0.34.0 vs 0.99.0）`updateAvailable:true` 且确实装的是常量 spec；跨域 POST 403 且安装零次。另有一条把**真实的** `registerRoutes` 前缀表与这两条 exact 路由一起挂上去，钉住「exact 先于 prefix」这条依赖——前缀处理器对非 POST 一律 405，若匹配顺序反了，这两条路由在生产里就是死的而所有单测仍会绿。UI 用例覆盖四种结局的文案、图标的 `aria-label` 随状态变化、忙碌时 disabled 且带旋转类、可一键装时出现强调圆点、状态文字与命令各自的位置、错误原地红字，以及「挂载时零请求」。布局另有三条结构断言：图标永远是 `.dsh-hub-update-row` 的最后一个子元素、命令永远在 `.dsh-hub-update` 里位于该行之下、`.dsh-hub-head` 的最后一个子元素是控件。本轮新增的宿主用例把四条状态机结局逐条钉住：直接安装成功（`removedFirst:false`、`removeBundle` **零调用**）；首次 `already-installed` → 移除 → 再装（`removedFirst:true`，且 `restartRequired` 随 `application` 在 `applied`/`restart-required` 之间变）；移除后的安装失败 → 回滚 spec 逐字是 `@eddyskywalker/dsh-chatgpt-subscription@0.34.0`，带回 `rollback:'restored'`、`restoredVersion` 与 pnpm 原文；回滚也失败 → `rollback:'failed'`、两条 diagnostic 都在、message 里含 `dsh plugin add …@0.34.0`；`stop-profile`（返回与抛出各一例）→ 409 且第二次安装零调用；旧宿主没有 `removeBundle` → 行为与本轮之前逐字一致；另有一条把开发链接放到「有 removeBundle 的 manager」上，证明安装与移除都是零次。UI 侧新增 4 条：live 成功（无需重启）、移除路径成功（写明移除过）、回滚成功（红字 `更新失败，已恢复 v0.34.0` + 原因）、回滚失败（红字写明可能已不可用 + 手动恢复命令全文）。

## 0.34.0 - 2026-10-21
- **[Kimi Code] 长会话撞 2 MB 请求体上限整轮失败——现在撞墙交给压缩恢复，窗口折算降为可选**
  - **现象**：中文长会话在 K3 线上整轮失败，报 `Kimi Code rejected the request before sending: the serialized body is 2107355 bytes, above the 2097152-byte limit this route enforces. Composition: images 0 bytes, tool schemas 2531 bytes, conversation text and system prompt 2104824 bytes`。图片 0 字节，也就是说这**不是读图问题**，上一版的「丢最旧的图」回收路径在这里丢无可丢，只能报错并建议压缩——而用户真正要做的是让这一轮活下来。
  - **根因一（错误码不对，宿主接不上自愈）**：[mapper.ts](../src/host/kimi-code/mapper.ts) 的 `assertRequestBodyFits` 抛的是 `PROVIDER_ERROR`，而 DSH 的溢出恢复**只对 `CONTEXT_WINDOW_EXCEEDED` 生效**（`compaction-basic` 的 `agent/request-error` 监听器按该码强制压缩本轮历史、再重试同一步，重试上限默认 1 次）。于是唯一还能靠压缩救回来的场景——正文太大、图已丢完——恰好是唯一不会被救的那个。本线路服务端真返回 400 溢出的路径（`classifyKimiFailure`）早就用对了这个码，只有本地守卫没接上。
  - **根因二（两个上限量不同的东西）**：DSH 用 adapter 申报的 `context.contextWindow` 算压缩阈值（`resolveCompactSpec`：`thresholdRatio` 默认 0.8、`headroomTokens` 默认 65536，本线路不申报 `defaultMaxTokens` 故无输出预留，即 `min(floor(0.8W), W − 65536)`），这是 **token** 口径；网关的 2 MB 是 **字节** 口径。而 DSH 的 token 计量是固定密度（`@deepseek-ai/dsh-token-meter` 的 `CHARS_PER_TOKEN = 4`，按 `text.length / 4` 计价，**看不见中日韩字符占 3 字节**）。所以「一个计量 token 占多少字节」= 4 × 每字符字节数：纯 ASCII 约 4、中英混合约 8、密集中文约 12。`kimi-for-coding` 申报 1M、阈值 85 万计量 token，而 2 MB 中文正文只有约 17.5 万计量 token——**压缩永远不会先触发**，字节墙先到。
  - **根因三（网关原文没被认出来）**：`total message size 5943865 exceeds limit 2097152` 匹配不上 `common/context-overflow.ts` 里任何一条超限措辞，所以请求即便漏过本地守卫、由服务端拒绝，同样落进 `PROVIDER_ERROR`。
  - **改法（兜底，本次的主修复）**：`assertRequestBodyFits` 的错误码从 `PROVIDER_ERROR` 改为 `CONTEXT_OVERFLOW_CODE`，文案与 `BodyFitContext` 一字未动；`classifyKimiFailure` 增加 `isKimiBodySizeRefusal`（认 `total message size … exceed(s) … limit`）归入同一码，message 明说是**字节上限**而不是 token 窗口。判定函数刻意写在 Kimi 自己的分类器里——共享的 `isContextOverflow` 被其它八条线路共用，把一句话加进去会连带改写别人的失败语义。
  - **改法（窗口折算，默认关）**：[types.ts](../src/host/kimi-code/types.ts) 新增 `wireBytesPerToken(env)`、`byteDerivedTokenCap(env)` 与 `effectiveContextWindow(tokenWindow, env)`；[adapter.ts](../src/host/kimi-code/adapter.ts) 的 `contextWindowFor` 仍是「申报值与内部预算的唯一入口」，但**默认原样发布目录值或用户覆盖值**：2 MB 墙已经由恢复码接管，用户显式覆盖（例如把 `k3` 覆盖成 1,048,576）不该被插件悄悄压小——这条是本轮返工的核心，最初把 clamp 设成默认是错的。设 `DSH_KIMI_CODE_BYTES_PER_TOKEN` 才启用折算，申报值 = `min(声明值, floor(2MB / d))`：`d=4` → 524288、`5` → 419430、`8` → 262144、`12` → 174762。
  - **为什么是这组数**：DSH 的 token 计量是固定密度（`@deepseek-ai/dsh-token-meter` 的 `CHARS_PER_TOKEN = 4`，按 `text.length / 4` 计价，**看不见中文占 3 字节**），所以「字节 / 计量 token」= 4 × 每字符字节数：纯 ASCII 约 4、中英混合约 8、密集中文约 12；2 MB 墙换算成计量 token 分别是 524288 / 262144 / 174763。压力阈值是 `min(floor(0.8 × 窗口), 窗口 − 65536)`（`compaction-basic/src/config.ts` 的 `resolveCompactSpec`，`thresholdRatio` 默认 0.8、`headroomTokens` 默认 65536，本线路不申报 `defaultMaxTokens` 故无输出预留）。选哪个 `d` 就是选「让哪一类会话在墙前压缩」。
  - **旋钮语义（与守卫不同）**：该变量是**可选的提前压缩开关**，不是安全守卫——不设、空串、非正、非法一律等于**不启用**（真正的安全网是恢复码，它永远在）；`DSH_KIMI_CODE_MAX_BODY_BYTES` 仍按旧约定（typo 回落默认值而不是关掉守卫）。
  - **默认行为的代价（写成事实）**：不折算时，`k3`@1M 的压力阈值 `min(838860, 983040)` = 838860 计量 token，而字节墙只有 174763（中文）/ 262144（混合）/ 524288（ASCII）——**阈值永远够不到**，所以长会话走的是「撞墙 → 自动压缩 → 重试同一步」。想让压缩发生在墙前就开折算。设置卡片仍按用户配置值显示窗口（客户端展示层，未改动）。
  - **佐证**：官方 `kimi-cli` 走的是同一条「预算前置」路线——`src/kimi_cli/soul/compaction.py::should_auto_compact` 只在「达窗口 85%」或「剩余不足 50K token」时压缩，**从不特殊处理 2097152**；它的 CHANGELOG 还记过一次同类缺陷（工具结果 token 没算进压缩触发 → 压缩不触发 → 直接 400），与本次的「计量口径没算字节」是同一类错误。
  - **测试**：新增 `test/kimi-code-capacity.test.ts`（29 例），分三段钉住：`window folding is opt-in`（**默认无 env 时 `k3` 的 1M 覆盖与 `kimi-for-coding` 的 1M 都原样发布**、4/5/8/12 各自的 min 语义、非法值当未设、`min` 不会把 256K 放大）；`what each density setting protects, when folding is on`（把三种密度的撞墙点 524288 / 262144 / 174763、压力阈值 `floor(min(0.8W, W − 65536))` 与各档的护住范围写成断言，并**明写默认不折算时三种密度都先撞墙、这不是缺陷而是恢复码接管**）；以及「2.1 MB 正文在发请求前就以 `CONTEXT_WINDOW_EXCEEDED` 被拒」的端到端用例（`fetch` 零调用）；另有「2.1 MB 正文在发请求前就以 `CONTEXT_WINDOW_EXCEEDED` 被拒」的端到端用例（`fetch` 零调用）、`k3`/`k3-256k` clamp 前后相等、以及网关原文归类与「无关 400 仍是 `PROVIDER_ERROR`」的用例。`test/kimi-code-adapter.test.ts`、`test/kimi-code-k3.test.ts`、`test/kimi-code-body-fit.test.ts`、`test/dynamic-output-reservation.test.ts` 按新语义更新。
  - **验证**：`npm run typecheck` 0 错误；`npx vitest run test/kimi-code test/dynamic-output-reservation` **30 文件 / 475 条全过**；全量 `npm test` **290 文件通过 / 4751 条通过 / 0 失败**（7 skipped 为仓库既有平台跳过：`token-store-linux` 等）。
- **[qoder] 模型选择里 Qoder 整条线路消失、「全不选」等于「全选」、重启后先出现一大堆用不上的模型——三件事都出在「哪些模型算可用」这一条链上**
  - **现象一（最严重）**：重启宿主后，模型快捷选择栏里**根本没有 Qoder 这个供应商**；要打开一次设置页才会出现。
  - **现象二**：设置卡片上的「全不选」点下去与「全选」效果完全相同；计数行还字面显示「已选 {selected} / 2」（占位符没被替换）。
  - **现象三**：进设置页先看到 15 个模型，其中大部分是当前套餐根本没有的，必须点一次「刷新目录」才缩到自己账号真实的 2 个。
  - **真因一（白名单词汇表错配）**：[adapter.ts](../src/host/qoder/adapter.ts) 的 `listModels` 拿用户白名单去收敛随包兜底表，而两者**不是同一套 id**——白名单是实时目录的 `display_name` 去空白（`DeepSeek-Flash`），兜底表照录 pi-provider 的静态表（`DeepSeek-V4-Flash`）。冷启动时进程里没有实时目录，收敛结果必然是空数组，`listModels` 返回 0 个模型，DSH 于是把整个 provider 分组过滤掉。实测：白名单 `['DeepSeek-Flash']` + 兜底表 → 0 个模型。
  - **真因二（三态缺失）**：`enabledModelIds` 只有「缺省或空数组 = 不过滤」一种读法，而旧版 `defaultQoderModelSettings()` 的出厂值**恰好就是 `[]`**。于是「全不选」提交的 `[]` 被读成「不过滤」，同时也意味着**每一个老用户的落盘文件里都写着 `[]`**——直接改语义会让他们升级后一个模型都不剩。
  - **真因三（快照读写不互逆）**：目录快照的写入侧存上游原始条目（`{ key, display_name, context_config }`），读取侧却用只认 `{ chat: [...] }` 的 `parseQoderModelListing` 去解析它，**任何快照都解析成空数组**并被当作「没有可用快照」丢掉。那份 `qoder-global-catalog.json` 一直都在、内容也是对的，却从来没有被成功读回来过一次——所谓「打开设置页就恢复」，真相是「等了一次真实的上游刷新」。
  - **真因四（刷新不发事件）**：目录刷新成功后没有发 `llm/adapters-updated`，所以即使真实目录已经到手，模型选择器的快照也不会重读，停在空分组上。
  - **改法（三态）**：`enabledModelIds` 改成 `string[] | null`——`null` = 不过滤（出厂）、`[]` = 用户明确全关、非空 = 白名单。存储、适配器过滤、状态下发、hub 概览、客户端五处同步；`ModelChecklist` 的「全不选」不再在自己已是 0 时禁用（全关是合法终态）。
  - **改法（迁移）**：新增 `selectionVersion` 迁移标记。无标记 + `[]` → 按旧版出厂值迁移成 `null` 并落盘；有标记 + `[]` → 尊重用户真实的全关。幂等，且 register 后端的 schema 缺省刻意写成 `0`（旧 `update()` 写的是 `?? []`，那个后端同样会留下无标记的 `[]`）。
  - **改法（收敛口径）**：新增 `convergeQoderSelection(stored, live, catalog)`——**收敛只在实时目录上做**，兜底表阶段不按白名单筛（它是能力占位，且与白名单不是同一套词汇）；`[]` 在两种阶段下都生效。`listModels`、状态面勾选标记、hub 概览三处读同一个函数。
  - **改法（预热与事件）**：新增 `persistedQoderModelRecord` / `parsePersistedQoderModelEntries` 这一对互为反函数的序列化器（顺带修掉 `is_reasoning` 按 `reasoningEfforts.length > 0` 写、会把 toggle 形态推理模型抹成不推理的问题）；启动时 `void warmQoderCatalogOnStartup(...)` 非阻塞预热，先读磁盘快照回填、再让上游刷新跑在背后；`refreshCatalog` 改为返回「目录有没有真的换掉」，只有变了才 `ctx.emit('llm/adapters-updated')`。
  - **改法（自动取目录）**：`GET /status` 在应答背后自动触发一次目录刷新（复用 `QuotaRefresh`，用 `force: false` 让 30 分钟 TTL 与 in-flight 去重生效）；客户端首屏拿到 `catalogRefreshing` 就静默补拉一次，最多一次，不设 busy、不弹错。「刷新目录」按钮保留为强制出口。
  - **验证**：`npm run typecheck` 0 错误；全量 `npx vitest run` **282 文件 / 4626 passed / 7 skipped**；`npm run build` 通过。冷启动回归用例**验证过先红后绿**（把规则改回旧实现时它报 `expected 0 to be greater than 0`）；快照读写不对称用真实文件对拍过（旧解析器 0 条 / 新解析器 2 条）；三态迁移用真实落盘文件跑过完整往返（迁移 → 幂等 → 全关不被翻回 → 全选回到 `null`）。

- **[qoder] 模型行只有名字：窗口、是否收图、思考档位、输出预算现在逐行写在勾选行下面**
  - **现象**：Qoder 卡的模型清单每一行只有一个模型名，用户勾选时看不出这个模型能收多长的上下文、收不收图、有几档思考——与同一屏里的 OpenDesign 卡形成反差（那边一行写全）。
  - **真因**：不是 host 没数据。[useQoderSection](../src/client/qoder/useQoderSection.ts) 拿到的 `QoderModelOption` 里 `contextWindow` / `supportsImages` / `reasoningEfforts` / `defaultMaxTokens` 都在（能力字段一律来自目录端点，随包兜底表也有逐模型事实），而是 [QoderSection.tsx](../src/client/qoder/QoderSection.tsx) 当时**刻意不把 hint 传给 ModelChecklist**——那次的需求是「模型行下面不需要介绍文字」，被误读成了「不要任何能力行」。
  - **改法**：新增 `qoderModelRowHint()`，由 DTO 字段生成一行**数据**（`1M · text+image · 档位 low/high · 输出 131k`）并传给共享 ModelChecklist；散文式介绍仍然不进这一行。目录不给档位的模型写「无档位」而不是留空或套默认三档。共用新增的 `formatTokenCount()`（百万位保留两位、千位取整），二进制窗口不再渲染成 `1048576` 或 `131.1k`。
  - **顺带修掉一个真 bug**：落盘快照的写入侧只写了 `is_reasoning`，没写 `thinking_config`，而回读侧的档位只从 `thinking_config.enabled.efforts` 取——于是**重启后所有推理模型都变成「无档位」**（模型是真推理模型，档位在磁盘上被丢了；重启前一切正常，所以只在冷启动那一眼看得出来）。现在写入侧按上游 effort 形态把梯子写回去（toggle 形态写 `enabled: {}`，不可关闭的写不带 `disabled`），读写仍是同一个 `readQoderThinkingConfig`，互为反函数。
  - **验证**：`test/qoder-ui.test.tsx` 新增一例，钉住三行不同能力的摘要（单模态两档 / 多模态两档 / 无档位）与用户覆盖窗口按覆盖值显示；`test/qoder-model-catalog.test.ts` 新增两例，用生产写入侧 → 生产读取侧往返，断言梯子、可关闭性、图片与窗口都不丢（老快照缺字段时仍是原来的兜底，不炸）；全量 typecheck 与 vitest 通过。

- **[opendesign] 新增第十三条订阅线路：OpenDesign（open-design.ai 订阅，浏览器设备授权 + API Key）**
  - **协议面**：OpenAI Chat Completions 流式对话，网关 `https://amr-link.open-design.ai/v1`，`Authorization: Bearer` 鉴权。网关主机与 `/v1` 拼写转录自官方 Cloud 控制台的 quick-setup 包（它给 DeepSeek Harness 推荐的正是 Chat Completions），四个协议端点均经未认证探测确认（401 包络符合各自协议）。
  - **登录一：浏览器设备授权（主路径）**。按官方 `vela login` 的公开 HTTP 契约重写：`POST /api/v1/cli/device-authorizations`（`{host, profile, cliVersion}`，**实测** 201 返回 deviceId / userCode / deviceSecret / activationUrl / pollIntervalSeconds），用户在浏览器确认后 `POST …/{deviceId}/token` 轮询取回 `vela_ctrl_…` 控制 Key + `sk-amr-…` 运行时 Key + 账号身份（字段名据上游 issue #8870；pending 帧的 null 形状也是实测的）。判定凭证「到位」看**字段在不在**，不看 status 字符串；取消过的流程绝不因迟到的确认而落号；宿主自身不打开浏览器（`test/login-opens-browser-once.test.ts` 钉住）。
  - **登录二：粘贴 API Key（回退）**。控制台（工作区 → API Keys）签发，仅用于对话。`OPENDESIGN_API_KEY` 环境变量可投射首个账号；Key 测试读免费的目录端点，不花额度。
  - **模型目录**：随包 37 个聊天模型（id、显示名、美元单价逐字转录自官方公开价目接口 `/api/v1/public/model-prices`），登录成功或添加 Key 后自动同步一次实时目录（`GET /v1/models`），同步条目持久化进设置文档，重启无需网络；目录真的变了才发 `llm/adapters-updated`。官方不公布各模型上下文窗口，默认 128k，卡片可按模型覆盖。
  - **每模型能力（窗口 / 输出上限 / 是否收图 / 推理档位）**：原先一律 128k + 固定三档，现在随包表按模型带上真实取值——转录自本仓库已核对的同族模型表（command-code 官方注册表、cline-pass、Claude、Antigravity；冲突以 cline-pass 为准，注册表的 `off` 译成 DSH 的 `none`）。**浏览器授权账号还会读 AMR 控制面目录**（`GET /api/v1/models`，`metadata.contextWindowTokens`，`public_model_*` id 按字母数字归一），把上游真实窗口写回；用户覆盖值 > 实时目录 > 随包表 > 默认。`minimax-m3.1-flash`、`muse-wonder` 无同族表可核对，保留默认并在计划文档列名，不猜。
  - **额度（钱包余额）**：只有浏览器授权账号带控制 Key，故只有它们能读 `GET /api/v1/wallet/balance`（`balanceUsd` 字符串）；余额显示在账号行与输入框胶囊（胶囊只显示主账号，$0 才转红）。上游只给当前余额、没有可对照的总额，所以**不画百分比额度条**；钱包 401/403 按上游语义（OPEND-3553）只作「读不到」显示，绝不标记账号、绝不影响对话。粘贴 Key 的账号没有控制 Key，卡片会说明并指向控制台。
  - **验证**：`npm run typecheck` 0 错误；新增 7 个 opendesign 套件（设备流 / 路由 / 适配器 / 映射 / 目录 / 契约 / UI）并给 `login-opens-browser-once` 与既有计数断言（TAB_IDS、卡片名、开关数、槽位 order 46）各追加一项；全量 `npx vitest run` 与 `npm run build` 通过。**未用真实订阅联调**：设备授权的创建/轮询响应是实测的，批准后的帧未观察到（据 #8870 推断且以字段存在为准），对话链路未与真实 Key 联调——清单见 `docs/opendesign-line-plan.md` §5。

## 0.33.0 - 2026-10-20
- **[qoder] 看板上的 Qoder 卡片用的是字母 Q，不是官方标志——现在换成官方那张 412×412 应用图标**
  - **现象**：设置页订阅列表里其余线路都是自家标志，只有 Qoder 是一个灰底字母方块。
  - **真因**：[brand-icons.tsx](../src/client/hub/brand-icons.tsx) 里那条注释给出的理由是「官方 favicon 是一枚 73 KB 的复合字形，体量不适合内联」。那个 73 KB 确实存在——但 `https://qoder.com/favIcon.svg` 现在返回的是**整站 HTML**（73,379 字节，HTML 长度不是图标大小），页面真正挂的图标是 `<link rel="icon" type="image/png">` 指向的一张 alicdn PNG。于是「太大所以不做」这个判断建立在一次看错的抓取上。
  - **改法**：`ProviderBrand` 新增 `image` 形态（data URI + `fit`），`BrandTile` 在它有值时画 `<img>` 并铺满底砖；Qoder 用官方 412×412 PNG（4,990 字节，sha256 `2276f0f8…26f3d`，2026-10-21 抓取 HTTP 200），base64 后 6.6 KB。旧注释连同 monogram 一起删掉，换成带 URL / 抓取时间 / 字节数 / 校验和的出处。
  - **验证**：`npm run typecheck` 0 错误；`test/hub-overview-ui.test.tsx` 新增一例断言 Qoder 卡渲染 data URI 且不再出现 `dsh-hub-brand-mono`；全量 `npx vitest run` **280 文件 / 4572 passed / 7 skipped**。
- **[qoder] 新增第十二条订阅线路：Qoder（全球区 qoder.com / 中国站 qoder.com.cn）**
  - **协议面**：Qoder 自有的 COSY 签名对话协议（`POST {base}/algo/api/v2/service/pro/sse/agent_chat_generation`）——AES-128-CBC 加密的 UserInfo + RSA-1024 包裹的会话密钥 + canonical MD5 签名、自定义 Base64 alphabet + 三段交换的 body codec、外层信封包 inner JSON 的明文 SSE。全部算法按 Liki4/qodercli2api 的全合成 frozen fixtures（qodercli v1.1.34 互操作基线）**逐字节锁定**（`test/fixtures/qoder/` vendored，`test/qoder-cosy.test.ts` 8 例），并与 simonsmh/pi-provider-qoder 的 live 验证实现互相印证。
  - **登录三路径**：浏览器设备流（仅全球区，challenge/verifier 轮询，不开本地回调端口，host 不自行开浏览器——`test/login-opens-browser-once.test.ts` 钉住）、手动粘贴 PAT（`jobToken/exchange` 兑换，PAT 本体留在 host 加密存储里供过期重兑换）、adopt 只读导入本机 qodercli 登录态（`~/.qoder/.auth/user`，AES 解密由 fixture 锁定；**区域不猜，是对两区 userinfo 各探一次探出来的**）。
  - **账号模型**：多账号号池，凭据**会过期、可刷新**（提前 1 小时，逐字上游文档；PAT 来源重兑换、其余走 refresh_token 轮换），两区账号可同池共存（区域是凭据的属性）。
  - **模型与额度**：目录实时发现（COSY 签名的 `/algo/api/v2/model/list`）+ 随包能力兜底表；COSY 版本每日跟随官方 CLI release feed（落后会拿到缩减目录）；能力一律来自目录字段（`max_input_tokens` 那个陈旧地板不信）。额度卡片读 `/api/v2/quota/usage`（**非公开个人端点**，失败绝不影响模型请求），三只桶（个人/加购/组织包）分开画绝对量；订阅无公开单价，整页只有 token 与 Credits 数字，没有金额。
  - **验证**：`npm run typecheck` 0 错误；新增 9 个 qoder 套件；全量测试与 build 通过。**未用真实账号联调**（mock + frozen fixtures 验收），联调清单见 `docs/qoder-line-plan.md` §9。
- **[kimi-code] K3 跑到一半突然整轮失败，红条上只有一个 `terminated` 配 `UNKNOWN`——现在它是可重试的 `TRANSPORT`**
  - **现象**：`k3` 的长回答（截图那次已经执行 27 次思考、调用 30 次工具）偶发中断，界面是「本轮运行失败 terminated」，右侧徽标 `UNKNOWN`；手动重发一次立刻恢复。
  - **真因**：连接在响应体中途被掐断时 undici 抛的是裸 `TypeError: terminated`——它自身不带任何错误码，真原因（ECONNRESET、对端关闭、body timeout）只挂在 `.cause` 上。[adapter.ts](../src/host/kimi-code/adapter.ts) 的读流循环只改写 mapper 已经定性的 in-band 错误，其余原样 `throw error`，于是这个裸值一路漏到 harness：`normalizeLlmFailure` 对它只能归一成 `UNKNOWN`，而 `UNKNOWN` 不在本线路的 `retryableCodes`（RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT）里——一次断连就把整轮判死，连一次自动重试都没有，同时还把 `.cause` 丢掉，报告里连发生过什么都说不出来。
  - **对照**：同仓库 codex 线路早为同一形状写过 `streamFailure()`（[responses-client.ts](../src/host/responses-client.ts)），claude 线路有 `outputStarted ? PROVIDER_ERROR : TRANSPORT` 的分支；kimi 是唯一照旧写法留下的那条。
  - **改法**：新增 `streamFailure()`（[adapter.ts](../src/host/kimi-code/adapter.ts)），把逃出读循环的非 `LlmError` 值改判成 `TRANSPORT`，并把 `.cause` 链拼进消息（`Kimi Code stream failed: terminated: read ECONNRESET`）；调用方取消仍是 `ABORTED`，本线路自己定性的 `LlmError` 原样通过。`assertStreamComplete` 那条同类形状——连接干净结束、但始终没等到终止事件——同步从 `PROVIDER_ERROR` 改成 `TRANSPORT`（[mapper.ts](../src/host/kimi-code/mapper.ts)），两种「说到一半没了」都交给 harness 的退避重试（最多 3 次，1.5s–15s）。
  - **为什么已经出字也重试**：失败的那次 attempt 由 DSH 记成 `assistant/attempt`——不进行模型历史、也不作为正文渲染（宿主 `turn-process.ts` 的 `visibleAssistantEvent` 对 attempt 恒为不可见），工具调用要等流结束才执行，所以重试既不会让模型看到重复内容，也不会重跑工具；用户看到的只是已流出的那段字被重试的那一次顶替，比整轮作废划算。
  - **验证**：`npx vitest run test/kimi-code-adapter.test.ts test/kimi-code-stream-idle.test.ts test/kimi-code-mapper.test.ts` **90 passed**（新增 3 条断流用例；把 `throw streamFailure(...)` 临时改回 `throw error` 时，断流用例当场复现裸 `TypeError: terminated`，证明用例咬得住）；`npm run typecheck` 0 错误；全量 `npx vitest run` **270 文件 / 4491 passed / 7 skipped**。
- **[minimax-code] `/video` 不再是「先选档位、再往输入框塞一段模板」：命令行有了图标，档位搬进面板，面板也终于不再把整页压暗**
  - **现象**：斜杠菜单里 `/video` 是**唯一一行没有图标**的，混在「压缩 / 权限 / 模型 / 导出」里明显没对齐；点它先弹一个只有「常用档位 + 自定义…」的小列表，选中任何一档都会把一整段 `用 minimax_generate_video 生成视频：prompt=（在这里写画面描述）…` 灌进输入框，用户还得回到那段话里找该改哪一处；而「自定义…」打开的面板盖着一层半透明遮罩，整页对话被压暗，参数又是 9 个同权重字段竖着排下来。
  - **改法（[video-command.ts](../src/client/minimax-code/video-command.ts)）**：`popupSelect` 换成 `action`——命令只做一件事：打开面板。图标走宿主的 `CommandContribution.icon`（[`video-command-icon.tsx`](../src/client/minimax-code/video-command-icon.tsx)，按 `IconProps` 的 `{ size, className }` 同形自绘，因为 `dsh-client-ui-primitives` 的 `lib` 是宿主装配产物、插件装不到）。**宿主侧限制**：`ui-commands` 的 `matchEnter` 只在裸命令时把一行交给客户端贡献（`if (!bare) return undefined`），所以「`/video` 后面直接写描述」做不到；改为**打开时把输入框里已有的文字当成画面描述带进来**（`composerDraftOf` 读 `InputState.draft`，并剥掉可能残留的前导命令 token）。
  - **改法（[VideoFormDialog.tsx](../src/client/minimax-code/VideoFormDialog.tsx) / [styles.ts](../src/client/minimax-code/styles.ts)）**：去掉遮罩，面板变成阴影浮起的居中浮层（`margin:auto` 保住「内容太高仍可滚动」），点浮层外仍然关闭；版面按「先说画面、再说参数」重排——描述占最大位，下面一排**档位胶囊**，再一行模型/时长/分辨率，比例按联动规则锁死或可选，水印与参考媒体收进「更多参数」。
  - **参考媒体**（新增 [video-media-input.ts](../src/client/minimax-code/video-media-input.ts) 与 [video-media-dropzone.tsx](../src/client/minimax-code/video-media-dropzone.tsx)）：四排纯文本框换成四个媒体块，**浏览 / 拖拽 / 粘贴**三入口合一，路径显示成可移除的标签。桌面端靠 `__DSH_HOST_PATHS__.pathFor` 把 `File` 还原成真实绝对路径；拿不到路径时如实提示而不是编一条。`file://` 地址还原成本机路径；`http(s)` 链接里**只有 `cdn.hailuoai.com` 被接受**（宿主 `assertMinimaxCdnUrl` 实测只读这一个主机），其余公网地址当场拒绝——否则会变成计费之后才被服务端打回。CDN 参考视频读不到时长，所以每出现一条就长出一行「它的时长」，填了才进请求（宿主 `MINIMAX_VIDEO_REFERENCE_DURATION_REQUIRED`）。
  - **两处回调**：① 档位胶囊原本会折成两行（三个全名并排塞不进 600px），改成`grid-auto-flow:column` 等宽一行，胶囊上只留 `H3 · 4秒` 这类短标签，分辨率与比例挂在 `title`/`aria-label` 上仍然查得到；② 每个媒体块补了一行**手填入口**——路径与 `@工作区文件` 都收（`stripReferencePrefix` 去掉那个前缀，因为工具参数要的是普通路径），回车即添加。
  - **版面再调整**：面板从 `600px` 加宽到 `880px` 并改成两栏（左栏只放**画面描述**，右栏放档位、参数与参考媒体，≤720px 时折回一栏）；拖拽区与输入行**合并为同一个框**——已收下的标签在上、输入行贴底，整块都是放置目标；输入框里的 `@` 现在会弹出**真实工作区候选**（新增 [video-workspace.ts](../src/client/minimax-code/video-workspace.ts) 包住宿主 `remote.workspaceFiles.list`：`@` 后的目录片段决定列哪一层，选中文件即入列、选中目录则继续下钻，`Tab` 取第一项、`Esc` 先收候选再关面板）；宿主没有这条远端时自动退化为纯手填，不报错。
  - **两栏落地后的三处修正**：① 描述框的 `width:100%` 加上左右内边距把它**顶出了栏宽**，文字一路压到右栏的「档位」标签上——补 `box-sizing:border-box`，两栏间距同时从 16px 放到 28px；② 展开「更多参数」后左栏只剩一小块输入框、下半截全空——描述框改为跟随右栏一起长（`flex:1` 一路传到 textarea，上限 520px）；③ 左栏标题行的「已带入输入框里的文字」提示与右栏列头贴在一起，允许换行并在挤不下时省略。
  - **验证**：`npm run typecheck` 0 错误；全量 `npx vitest run` **270 文件 / 4488 passed / 7 skipped**（新增 `test/minimax-code-video-media-input.test.ts`，扩写命令与面板两个套件）；`npm run build` 通过。

## 0.32.0 - 2026-10-20
- **[cline-pass] 凭据后端读不出来时不再吞掉 `CLINE_PASS_API_KEY`：环境变量与密钥环是两条独立来源**
  - **现象**：在**没有 Secret Service 的 Linux 环境**（裸 CI runner 最典型）里，`cline-pass` 的账号列表是空的，即使显式导出了 `CLINE_PASS_API_KEY`——于是「随包内置的密钥改用环境变量注入」这条文档化的用法在这些环境里**静默失效**。
  - **真因**：`account-pool.ts` 的 `legacyAccount` 投影第一行就是 `await store.read()`。读取平台加密后端在 Linux 上要有个解锁的 keyring；没有就**抛错**，而这一抛把后面那句 `ambientCredentials()`（读环境变量）一起带走了——**两个本来互不相干的来源被串成了一条链**。Windows 有 DPAPI、macOS 有 Keychain，所以本机从未暴露，只有 CI 红。
  - **改法**：`store.read().catch(() => null)`——密钥环答不上来就当作「没有已存凭据」，环境变量照常投影。**不是妥协**：环境变量本来就不需要密钥环可读，它从来没有依赖过存储。
  - **验证**：`test/cline-pass-plugin.test.ts` 新增一例把 `store.read` 打桩成 reject 并断言环境变量投影仍然生效（**5 passed**）；同线路另外 2 个套件（`account-refresh` / `routes`）一并回归通过。
- **[cline-pass] 高级设置与整站版式对齐：输入框终于有主题样式，六行数值与三行开关各归其位**
  - **现象**：设置页「高级设置」里的六个输入框是**浏览器原生外观**（白色实心框 + 粗边框），与旁边 `.dsha-select` 的深色圆角控件格格不入；原因是 [styles.ts](../src/client/cline-pass/styles.ts) 用了 `.dsha-input` 这个类名，而**全站样式表从未定义过它**——其他线路的输入框都自带各自的 `-control input` 规则，本线路抄了类名没抄规则。
  - **错位**：原布局用一张双列 Grid（`.dshcp-field`）把所有控件塞在右半屏，而 `<select>` 被 `.dsha-select` 的 `max-width:220px` 卡住，于是**输入框顶到最右、下拉框缩在中间**；「在模型选择器中列出网关目录的额外模型」的复选框被 Grid 推到距左 240px 处，与下方「注册 `cline_pass_*` 管理工具」那个贴右的复选框**不在同一条竖线**上。
  - **说明串了行**：`t.pinSpellingHint`（「网关可能在两次请求间切换管线…」）被写在整张 Grid **下方**，视觉上成了「列出网关目录额外模型」的副标题，而它真正的 `t.exposeCatalogHint` 根本没渲染。
  - **改法**：① 补上 `.dsha-input` 的主题样式（`--dsw-alias-bg-layer-2` 底、`0.5px` 边框、`7px` 圆角、`focus-visible` 描边），与 `.dsha-select` 同一套 token；② 六个数值行改用共享 `.dsha-row`（左标签右控件），右侧统一 `240px` 定宽（`.dshcp-adv-control`），数值与地址分别用等宽字体（`.dshcp-adv-num` 右对齐 / `.dshcp-adv-mono`）；③ 三行开关改用共享 `.dsha-pref-row`（左侧粗体标题 + 灰字说明、右侧 `.dshcp-check` 复选框），三枚复选框在右侧对齐；④ 每句提示归位到它自己那一行的标题下，并补回漏掉的 `t.exposeCatalogHint`。
  - **验证**：`npm run typecheck` 0 错误；`test/cline-pass-section.test.tsx` **12 passed**（新增一例断言 6 行 `.dsha-row` + 3 行 `.dsha-pref-row` 且每行副标题与自己的标题配对）；`npm run build` 通过。
- **[进展更新] 面板正文终于能画代码块、公式与 mermaid：不再把源码原样摊在读者面前**
  - **现象**：进展正文走的是本插件自己的 `MarkdownLite` 渲染器（平台那个 `MarkdownText` 的 lib 是浏览器构建，顶层 `import css from X.module.css` 会让任何 Node/vitest 导入方直接失败），而它只认段落、列表、GFM 表格、行内代码、粗体与标题——于是正文里只要出现围栏代码块或公式，**源码就逐字显示出来**。
  - **改法（[markdown-lite.tsx](../src/client/progress-updates/markdown-lite.tsx)）**：加围栏代码块（按 CommonMark 的闭合规则，**未闭合的围栏吞掉剩余全文**，所以流式输出永远不会漏出反引号）与 KaTeX 公式（行内 `$..$` / `\(..\)`、块级 `$$..$$` / `\[..\]`）。KaTeX 的 HTML 经 `DOMParser` 映射成 React 元素，**不走 `dangerouslySetInnerHTML`**，渲染器「无注入」的性质得以保持；美元符号的判定照抄平台语法守卫，因此「prices $5 to $10」仍然是散文。
  - **改法（[renderer.ts](../src/client/mermaid/renderer.ts)）**：语法关键字表从 10 种扩到 mermaid 11 能识别的 **47 种**（journey、quadrantChart、C4Context、sankey-beta 等此前**根本看不见**）；并且旧代码只匹配**行首**关键字，于是非常常见的 `%%{init}%%`、注释与 frontmatter 前言会把一张本来合法的图判死——新增 `stripMermaidPreamble` 在匹配前剥掉它们。横幅语言标签改读文档化的 `[data-code-block-banner]` 钩子，而不是 `firstElementChild`（后者的 `textContent` 是语言名加复制按钮文案）。
  - **一个容易踩空的点**：平台对 mermaid 围栏**不会**打印 "mermaid"（高亮器没有 mermaid 语法，`CodeToolbar` 回落到 `codeBlock.title` 占位符）。所以那个标签对特定语言是**否决票**、对 mermaid 是**显式放行**，而占位符的含义是「没有标签」，此时由关键字表说了算。
  - **依赖**：`katex` 进 `dependencies`（`^0.18.7`，平台基线钉的同一个版本）；它的 CSS 与字体仍来自宿主页面，所以 bundle 只是变大，不会多打包一份样式表。
  - **验证**：`npm run typecheck` 0 错误；新增 [`test/markdown-lite.test.tsx`](../test/markdown-lite.test.tsx) 与扩写的 [`test/mermaid-renderer.test.ts`](../test/mermaid-renderer.test.ts)；全量 `npm test` **268 文件 / 4452 passed / 7 skipped**。
- **[antigravity] 上游 5xx 与「根本没连上」不再判本轮死刑：按可重试码上报，交给宿主的退避重试**
  - **现象与真因**：个别轮次直接失败并显示 `Antigravity API error (500): No response`（徽标 `PROVIDER_ERROR`），手动重发立刻能过。上游那次 500 确实是瞬时抖动，但**这条线路把它归成了终局错误码**：`adapter.ts` 里非 429 的非 2xx 一律抛 `PROVIDER_ERROR`，而这条线路的 `providerRetryPolicy()` 返回 `undefined`，宿主因此套用默认策略，默认可重试码只有 `EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT` —— `PROVIDER_ERROR` 不在其中，`llm-retry` 一次都不会退避重试，直接把这一轮判死。
  - **还有一个会撒谎的状态码**：`fetch` 在**每个**端点上都抛错（DNS / TLS / 连接被重置）时根本没有 `response` 对象，而旧代码用 `response?.status ?? 500` 补了一个 **500**，于是"根本没连上"和"上游真的回了 500"在界面上长得一模一样。
  - **改法**：① 所有端点都没拿到 HTTP 响应 → `TRANSPORT`（带 `cause`），不再伪造 500；② `status >= 500` → `SERVER`；③ 400 / 401 / 403 / 404 仍是 `PROVIDER_ERROR` 终局，429 的两条既有判决不变。瞬时故障从此由宿主的 5 次退避重试（500ms 起、上限 10s）接管，真正被拒的请求仍然当场失败。
  - **验证**：`npm run typecheck` 0 错误；`npm test` **268 文件 / 4429 passed / 7 skipped**。`test/antigravity-adapter.test.ts` 新增 1 例（全端点 `fetch` 拒绝 → `TRANSPORT`），503 那条断言的 code 由 `PROVIDER_ERROR` 改为 `SERVER`，其"端点优先级"的本意不变。
- **[cline-pass] 新增第 10 条订阅线路：Cline Pass（WorkOS OAuth 登录 + 上游渠道钉住）**
  - **范围**：把 MIT 许可的 [`dsh-cline-pass`](https://github.com/yhshzh/dsh-cline-pass) 的功能按本仓库的线路规范兼容移植为独立线路 `cline-pass`，复用共享内核（`AccountPoolCore`、并发闸、空闲看门狗、请求图片预算、`claimProviderRoute`、账号卡片 / 模型清单 / 上下文编辑器 / composer 胶囊），**不改动任何既有线路的行为**。
  - **登录**：Cline 账号走 **WorkOS 设备码 OAuth**（与官方 CLI 的 `cline` / `cline-pass` 同一条链），浏览器确认后账号自动入池；access token 以 `Bearer workos:<token>` 发送，到期前自动 refresh，轮换后的 refresh token 先落盘再使用；`invalid_grant` 标记账号失效并要求重新登录，网络/5xx 不误登出。静态 API Key 保留为兼容回退。端点、client id 与 `workos:` 前缀转录自 Cline 官方开源仓库（`sdk/packages/core/src/auth/cline.ts`、`auth/provider-auth-registry.ts`、`sdk/packages/shared/src/runtime/cline-environment.ts`，commit `ca7402c`，2026-10-20）。
  - **能力**：OpenAI Chat Completions 流式（文本 / reasoning / 工具调用 / 图片）；多账号（OAuth）或 API Key 顺序 / 轮询 / 粘性调度、429 冷却、401/403 失效标记与换号；**上游渠道探测 / 逐渠道校验 / 钉住 / 排除**，`strict` 与 `preferred` 两种模式，首个 token 前故障转移；两种管线写法默认都写（`provider.*` 与 `providerOptions.gateway.*`），并以响应回读的实际渠道判定钉住是否被采纳；官方目录（`recommended-models` + models.dev + 上游网关）刷新；按账号读取 5 小时 / 周 / 月额度；进程内请求历史（含失败尝试链与 token 用量）；8 个 `cline_pass_*` 管理工具默认不注册，卡片内可开启（重启生效）。
  - **注册点**：`src/index.ts`（线路工厂 / 路由 / hub 摘要 / dispose / 导出尾部）、`CONTROLLED_PROVIDERS`、`DIAGNOSTIC_PROVIDERS`、`hub/providers.tsx`、`hub/brand-icons.tsx`、`client/index.tsx`（locale / 样式 / 胶囊 order 44），以及既有计数断言各追加一项。
  - **传输**：对"请求尚未发出"的 TLS/connect 失败自动重试 2 次，并在最终错误里说明"未到达网关、钉住未生效"；实测本机到 `api.cline.bot` 的 Node TLS 握手会间歇失败（同一时刻 curl 正常、IPv6 不可达），这与上游钉住无关。流中段断流不重试，避免重复计费。
  - **安全**：OAuth access / refresh token 与 API Key 只进平台加密凭据库（DPAPI / Keychain / Secret Service），响应与日志均不出现原文；登录流程 DTO 逐字段投影；所有写路由同源校验；错误信息最多回显上游一行原因。
  - **文档与品牌**：新增 [`docs/cline-pass-line-plan.md`](docs/cline-pass-line-plan.md)（每个常量的出处、决策、**未验证清单**）；README 增加线路章节与路由表；协议证据矩阵增加一行；hub 卡片改用 Cline 官方标记（`assets/branding/logos/cline-icon-white.svg` + 官方 app icon 的 `#343B42` 底砖），不再用字母占位。
  - **验证**：`npm run typecheck` 0 错误；全量 `npx vitest run` **267 文件 / 4390 passed**（在 upstream 0.31.0 之上新增 8 个测试文件、68 例）；`npm run build` 与 `npm pack --dry-run` 通过，`lib/types/host/cline-pass/*` 已进包。

## 0.31.0 - 2026-10-20
- **[minimax-code] 视频生成现在能带素材、选比例：首/尾帧、参考图/视频/音频、任意比例与 AIGC 水印**
  - **为什么能带素材**：上游那套媒体工具走的**不是**平台 API Key，而是**订阅网关** —— 和我们 Messages 线路同一个 origin、同一把订阅令牌、四个请求头。所以生成视频不需要额外配 Key。
  - **最容易错的地方**：**参数名 ≠ 发给服务端的字段名**。`inputImagePath` 上线是 `input_image`、`referenceImagePaths` 是 `reference_images` —— 照参数名直接发，全部会失败。映射在媒体准备层里写明。
  - **比例是联动的，不是照抄**：给了首/尾帧 → 服务端**强制** `adaptive`（用户给的值会被改写）；有参考媒体 → 缺省 `adaptive`；纯文本 → 缺省 `16:9`，且**`adaptive` 会被本地拒绝**（纯文本没有可自适应的对象，发出去只是白花一次计费的请求）。
  - **两处刻意偏离上游**：① H3 家族缺省分辨率是 `2K`——但**只在 `2K` 属于该模型合法集时才下发**（H3-Max 实测只收 `480P`/`768P`，照抄会让每个省略分辨率的 H3-Max 调用都变成「必然被拒的计费提交」）；② 参考视频的时长**本地文件自己从容器读**（`mvhd` box），**不引入 ffmpeg 依赖**、也不要求用户填——只有公网 URL 才需要，因为服务端不下载它、算不出长度。
  - **重复提交会被拒**：生成是**计费的**，而模型可能在一轮里调两次同一个工具。同一会话同一轮里的**同一份 body** 只发一次（请求**发出前**就记下，所以失败的那次也不会被重发成第二次扣费）。**但没有会话标识时这个防护不启用**——键会退化成「只有 body」，两个不同的生成会被误判成重复，**误杀比漏杀更糟**。
  - **文件上传**：本地素材走我们**已经实测跑通**的那条通道（预签名 PUT → `cdn_url`），并带上上游实测的 `category`。第三方公网 URL **本地就拒绝**——实测两个能取到正确 MP4 字节的独立主机，服务端一律拒绝（原话 `video_info.url could not be used as a media source`）。
  - **验证**：全部用 mock 单测（本轮**没有跑真实生成**）。上游契约逐行比对自 `MiniMax-AI/minimax-code` 的 `tool-defs.ts` / `submit-video-generation.ts` / `file-transfer.ts`。
- **[minimax-code] 视频工具终于有了用户能碰到的入口：`/video` 命令 + 设置页的默认参数与生成历史**
  - **之前只能用自然语言触发**，模型自己决定调不调；而参数并不显然（比例会被改写、每个模型的时长与分辨率合法集不同）。
  - **`/video`**：斜杠菜单里列出**实测合法**的预设档，再加一行「自定义…」打开完整表单（提示词/模型/比例/时长/分辨率/首帧/末帧/参考图/参考视频与时长/参考音频/水印）。**只填进输入框、不直接发送** —— 用户得先看见联动把它的参数改成了什么。
  - **只在 minimax-code 线路上出现**：斜杠菜单的可见性判据读会话的 `modelSelection` 投影（宿主自己就是这么读当前模型的），别的线路上**菜单里根本没有这一行**；工具本身还有一道 provider 门禁。
  - **参数联动在表单层就处理完**：给了首帧 → 比例选择器**消失**，只显示强制值和理由；纯文本 → `adaptive` 根本不在选项里；换了模型 → 时长与分辨率收窄到该模型的实测合法集。
  - **设置页**新增两格：**默认参数**（存浏览器，纯 UI 起手值）与**生成历史**（存宿主，因为写它的是工具执行；沿用仓库惯例走平台加密后端，**只存路径与数字、不存视频内容**）。
  - **两处「源码里有、产品里没有」的修复**：`remote.workspaceFiles` 是独立服务名不是 `remote` 的属性（照属性读会被 Cordis 的属性守卫抛错 → 每次读视频都失败）；`documentPreviews` 由宿主 `reflect.provide` 且**晚于本插件激活**（照 `apply` 瞬间抓一次 → 侧边栏预览视频从来不会生效）。
- **[进展更新] 面板记录改为从会话日志投影折叠：重开对话、刷新页面、宿主重启之后历史还在**
  - **现象**：右侧栏「进展更新」面板的记录**完全没有持久化** —— 进展只活在一个进程内的环形缓冲里（[`store.ts`](../src/host/progress-updates/store.ts) 的 `MAX_UPDATES = 50`），[`index.ts`](../src/host/progress-updates/index.ts) 按会话分桶存进一个 `Map`，卸载时 `stores.clear()`。重开对话、刷新页面、宿主重启，面板就空了。
  - **数据其实一直在**：`progress_update` 的每次调用都是一条会话事件，早已被 DSH 持久化。注意它有**两种形状**：原生调用落 `tool/call`（`arguments` 是模型吐出的 JSON 原文），而 PTC 模式（模型只看得见 `run_code`，把 `progress_update` 当子调用发出去）落 `tool/ptc-dispatch`（`arguments` 是**已解析的对象**，且那一条 `tool/call` 的 `name` 是 `run_code`）。丢的只是"从日志里把它读回来"这一步。
  - **改法（新增 [`projection.ts`](../src/host/progress-updates/projection.ts)）**：登记一个会话投影单元，把日志里的 `progress_update` 折叠成一条条进展，**日志成为唯一真源**。`apply` 认**两种**形状（`tool/call` + `tool/ptc-dispatch`，都要求 `name === 'progress_update'`），各按自己的参数形状取 `{ title, message }`，`at` 取事件时刻；其余任何情况（两种都不是、不是这个工具、参数不是合法 JSON / 不是对象、`message` 不是字符串、缺 `seq`/`time`）**一律返回同一个 state 引用且绝不抛错** —— 这是日志重放路径，抛一次就毁掉整条折叠链。
  - **折叠语义变了就 +1**：`stateVersion` 因此是 **2**。缓存按 `(sessionId, key, ver, seq, val)` 落盘，而上一版按"只认 `tool/call`"的语义已经写进了一份 `{ver:1, seq:…, val:{updates:[]}}` 的空数组；版本不升的话它会被当成有效 checkpoint 续用，面板会一直空着。
  - **id 用 seq，还带上会话 id**：`pu-<seq>-<sessionId>`。时间戳会随重放时的时钟漂移，seq 不会，同一段日志重放两次得到逐字相同的 id（客户端 `sameList` 按 id 比较，面板也拿 id 当 React key）。后缀解决另一半问题 —— 读值要合并整棵委派树，而 seq 在每个会话里都从 0 开始，只带 seq 会让根会话与子会话的第一条进展撞 id。
  - **改法（[`index.ts`](../src/host/progress-updates/index.ts) 的 `updatesOf`）**：**先投影、后内存**。投影路径用 `sessions.get(id)` 拿到会话对象，再用 `sessionProjections.stateOf(session, 'progressUpdates')`（没有就退 `snapshot` 的 wire 切面）读值；**整棵委派树共用一份进展**的语义照旧保留 —— 沿 `header.parentSession` 把 `sessions.list()` 里活跃的子孙找回来（深度上限 16，与 `nudge.ts` 的 lineage 走法同一个数），按 `at` 升序合并后仍按 `MAX_UPDATES` 截断。会话/投影服务缺席、会话还没 attach、投影登记被拒 —— 都**安静回退**到内存 `Map`，行为与今天完全一致。
  - **内存 `Map` 没有删**：它同时承担催促计数（`roundsSinceUpdate`/`nudges`）与降级路径；HTTP 路由、催促逻辑、工具注册、提示词分节一个字没动，客户端取数通道也仍是原来的 2 秒轮询。
  - **兼容性**：`@deepseek-ai/dsh-session-projection` **不在** peerDependencies 里，运行时**不 import** 它 —— 投影定义按结构化类型自己声明（同 `nudge.ts` 的 `NudgeSessionLookup` / `TurnBoundaryLookup`），服务只经 `ctx.get('sessionProjections')` 读取，缺席就降级。`zod` 因此进 `dependencies`（`4.4.3`，与 DSH 侧一致）：它在 `lib/index.js` 里保持为一条裸的 `import { z } from "zod"`，由包的 `dependencies` 在安装时解析（tsdown 默认把 `dependencies` 里的包外部化，不会被内联进 bundle）。`package-lock.json` 同步声明了这条依赖（CI 跑的是 `npm ci`）—— 只动了这两行，没有整份重生成：那份锁文件本来就停在 0.26.1 且带着两条早已不在 `package.json` 里的 devDependencies，顺手重写会把它一并对齐，超出这次改动的范围。
  - **验证**：`npm run typecheck` 0 错误；`npm test` **4079 passed / 7 skipped**；`npm run build` 通过。除单测外还拿**真实会话日志**重放过一遍：解压 `session.v4.jsonl.zstd`（509 个 zstd 帧）后确认 `tool/call` 全是 `run_code`、`progress_update` 全在 `tool/ptc-dispatch` 里，按新 `apply` 重放折出 10 条，与对话流里看到的进展行一一对上。新增两份测试 30 例：[`test/progress-updates-projection.test.ts`](../test/progress-updates-projection.test.ts)（折叠字段、无关事件返回同一引用、坏 JSON / 缺字段不抛错、`MAX_UPDATES` 截断、重放 id 稳定、schema 与合并）与 [`test/progress-updates-projection-source.test.ts`](../test/progress-updates-projection-source.test.ts)（投影优先、委派树合并、无投影服务时照常挂载并走内存、会话未 attach 时回退、登记被拒时降级）。

## 0.30.0 - 2026-10-20
- **[minimax-code] 请求的模型与实际回答的模型不一致时，这一轮立刻失败——而不是替用户按最贵档付费**
  - **现象**：这条路由**不拒绝**它路由不了的模型 id。2026-10-20 实测：乱写串与空串都回 HTTP 200，实际由 `MiniMax-M3` 代答；同一个乱写 id 带 `reasoningEffort:'none'` 重发，回答的 M3 真的少了 thinking 块——是**真替换**，不是把名字写回去的壳。
  - **为什么要紧**：我们的模型目录是硬编码的（`/v1/models` 对订阅流量是 503 `direct_route_not_configured`，那是路由裁决不是路径拼错）。若 MiniMax 下架了 M2.7 而用户仍选着它，请求**不会报错**，会被 M3 代跑——用户以为在用便宜模型，实际按最贵档计费（我们自己的实测：M3 的 max 档思考量约 3 倍、延迟约 4 倍）。**这是钱包问题，不是可用性问题**，而且**没有错误报文可依**。
  - **改法**：[mapper.ts](../src/host/minimax-code/mapper.ts) 读流头的 `message_start.message.model`（此前只取 usage 与 stop_reason）；[adapter.ts](../src/host/minimax-code/adapter.ts) 把它与**真正上线的那串 id** 比对（从即将发送的请求体读回，不是目录解析名），不一致则抛 `MODEL_SUBSTITUTED`。
  - **判定点与代价**：判定在 `processMinimaxStreamLine` 之后、**任何 `yield` 之前**——`message_start` 是流的第一个事件，排在所有 `content_block_start` 之前，所以**没有任何内容块送达调用方**，无需回收、不会有重试重复输出。新码**不在** `retryableCodes` 里：重发同一 body 只会再被替换一次，并按替身计费。
  - **验证**：`npm run typecheck` 0 错误；全量 **250 passed | 1 skipped（251 文件）、4050 passed | 7 skipped、0 failed**；`npm run build` 通过。新增 5 条守卫（一致 / 不一致且零内容块 / 无 model 字段 / 大小写双向 / mapper 层单测）。
- **[minimax-code] 每日签到锁定在它开始的那一个账号上：池行被重绑就重新认，attempt 中途换号就拒绝**
  - **现象**：签到读面板用 A 的 `realUserID`、领取用 B 的凭据是可能的——网关把 `accessToken` 与 `realUserID` 当两个独立入参，彼此没有绑定校验，而 `realUserID` 是按池行缓存的。
  - **两个真实窗口**：① 状态文件钉着 A、池里那一行已被换成 B；② 401 强制续期后 `renewCredential` 返回**另一个账号**的凭据，重试即以别人的账号领取。
  - **两者性质不同，处理也不同**：① **重绑是合法的状态变化**——一行 = 插件替用户管理的一个账号，跟着走才是对的，所以**用当前凭据重新解析身份、重新钉住、照常签到**（老状态文件也会在第一次运行时自愈）；② **attempt 中途的漂移与 401 续期换号必须硬拒绝**（`MinimaxCodeCheckinAccountMismatchError`），不自愈。
  - **记一个容易骗人的地方**：`native:<region>:<recordKey>` 里的 `recordKey` 是**记录槽位**键，**不是账号 id**——用户在桌面端把另一个账号签进同一槽位时它不变。所以它只是「尽力而为的护栏」，这条线账号的**权威标识**是从身份接口解析出来的 `realUserID`。
  - **验证**：签到相关 5 套件 **113 passed**；两次**变异验证**（关掉钉校验 → 两条用例红；关掉漂移守卫 → 漂移用例红），均已还原。
- **[minimax-code] 额度耗尽改按上游数字码判定，措辞表留作兜底；并纠正我们文档里的过度声称**
  - **改法**：[adapter.ts](../src/host/minimax-code/adapter.ts) 的 `statusCodeIn` 读三处信封（`base_resp.status_code` → `errorCode` → **顶层 `code`**），命中上游的 `2056`/`2067` 即判账号级额度耗尽；403 与 429 两个入口读**同一个**谓词、汇进**同一个**判决，形状天然一致。**2013 明确排除**（通用「参数非法」码，本仓库在 reset-card 与 Files API 上另有语义）。
  - **实测订正**：Messages 路由的错误信封**没有 `base_resp`**——400 是 `{type,error{type,message}}`（无任何数字字段），401 是 `{code,message}`。所以这条路由上**当前真正 operative 的仍是措辞表**，数字码臂是**跨信封的前向兼容臂**。README 里那段把它写成首要判据的话已改正。
  - **验证**：新增 8 条（数字码 / 措辞 / 两者同形 / 2013 不判 / 顶层 401 不判 / 流内继承），邻近 6 套件 133 passed。
- **[minimax-code] 令牌时长从「约 24 小时」纠正为「约 1 小时」，设置卡改用分钟显示**
  - **现象**：卡片上写着访问令牌约 24 小时有效，而实测是**一小时**（`types.ts`）——一句用户会读到的错话；余量又以「小时」报，一小时寿命的令牌因此看不出 Host 何时会续期。
  - **改法**：`remainingHours` → `remainingMinutes`，单位改分钟（恒定一位小数，不足一分钟视为已过期），中英文案同步改为「约 1 小时」。
- **[minimax-code] 能力说明与上游差分归档：七处过期表述 + 活体探针 + 差分文档**
  - **代码早于文档**：Files API 早就实现了（上传 / 12 小时 TTL / 账号隔离 / 去重缓存），视频也早已声明，而 `model-catalog.ts` 的三处注释与 README 仍在描述实现之前的世界——这会让人误判这条线路的能力边界，包括下一次做差分分析的人。
  - **新产物**：`scripts/probe-minimax-capabilities.probe.ts`（16 个 case 的活体探针）与 `docs/minimax-code-probe-capabilities.md`（原始证据），以及 `docs/minimax-code-upstream-delta-v2.md`（本轮上游差分、明确否掉的项、待办）。
  - **顺带量出**：服务侧 `max_tokens` 真阈值是 **524288**（128000 / 512000 都接受，999999999 回 400）——我们写的 128000 是保守值（与上游兜底表一致），**数值未改**；并确认那条 400 文案**不会**误触发上下文超限检测，不存在「压缩→重试→再压缩」的死循环。
- **[Codex 搜索] 读出活体搜索真正的答案字段，并给代理一个连接超时**
  - **现象**：活体 `/alpha/search` 的回答在顶层 `output` 字段，而 `readContent` 只看 `content` / `output_text` / `summary`——于是每次真实搜索都**没有答案正文**，工具只报一串来源，读起来像「搜索能用，只是没搜到东西」。
  - **代理**：undici 默认 10s 连接超时覆盖的是到**源站**的 TLS 握手而非到代理的那一跳；实测某条到 chatgpt.com 的慢路由仅握手就 1.2s–18s、请求整体 31s，默认值把本该几秒后成功的请求杀掉，而且是以一句不点名的 `fetch failed` 杀掉。代理 agent 改为 60s 连接超时，并用 undici 真正接受的 options 对象形式传入（第二个位置参数会被静默丢弃）。
## 0.29.0 - 2026-10-19
- **[Antigravity] 429 不再被当成「配额耗尽」：裸 429 不冷却账号、不换账号，也不再把上游原因藏起来**
  - **现象**：账号配额还很充足（实测 Gemini 5h 桶剩余 95.95%、周桶剩余 84.67%，Claude/GPT 100%），插件却报「账号配额已耗尽」，并把该账号的 Gemini 配额族冷却 15 分钟；此后每次重试都被账号池直接挡下，连一次网络请求都不发。
  - **根因一（端点链）**：[adapter.ts](../src/host/antigravity/adapter.ts) 与 [image-tool.ts](../src/host/antigravity/image-tool.ts) 的端点候选循环只在 ok/400/404 时中断，主端点失败后会落到兜底端点。实测 `https://daily-cloudcode-pa.googleapis.com` 对 Antigravity 请求稳定 200，而 `https://cloudcode-pa.googleapis.com` 对**每一个** Antigravity 请求都回 429 `{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}`——没有 details、没有 Retry-After。这个 429 于是成了「被上报的那一次失败」。
  - **根因二（裸 429 被当成了配额结论）**：该 429 正文里没有任何重置时间，`retryDelayMs()` 返回 undefined，旧代码回落到写死的 15 分钟冷却并把它记成「配额已用尽」。**配额结论需要证据**：裸 429 只说明上游拒绝了这一次请求，不说明这个账号的 Gemini 或 Claude/GPT 额度用完了。
  - **改法一（端点链）**：429 立即结束本次尝试的端点链——一个端点给出的配额结论不会因为换端点而变好，而兜底端点对每个 Antigravity 账号都回 429。**被上报的是第一个应答端点的结果**，除非后面的端点成功（ok）或回答 400/404（这两条中断条件原样保留）；所以「主端点 5xx + 兜底端点 429」现在报的是那个 5xx，而不是兜底端点的 429。
  - **改法二（裸 429 不等于配额耗尽）**：429 给出了重置时间（quotaResetTimeStamp / quotaResetDelay / RetryInfo.retryDelay / Retry-After）时行为完全不变：按上游给的时长 `markFamilyCooldown(account.id, family, statedWaitMs, '429 Rate Limit')`、有下一个账号就换账号、最终报 `LlmError(..., 'RATE_LIMIT', { status: 429 })`。**没有重置时间的裸 429 不再冷却账号、不再换账号**，改为可重试且与账号无关的 `LlmError(..., 'SERVER', { status: 429 })`——`SERVER` 在 DSH 默认重试集合内，也是本仓库「上游说不、但不是账号的错」的既有措辞（见 `src/host/kimi-code/adapter.ts` 的 upstreamOverload）。文案直说「上游返回 429 但未给出重置时间，因此按瞬时限流处理，不视为账号配额耗尽」，并附上截断后的上游原始响应。图片工具同理：`ANTIGRAVITY_IMAGE_RATE_LIMITED` 保留，但裸 429 不再调用 `markFamilyCooldown`，文案也不再宣称配额已用尽。
  - **改法三（上游原话随冷却一起留存）**：[account-pool.ts](../src/host/antigravity/account-pool.ts) 的 `markFamilyCooldown()` 多一个可选的 `detail`，冷却条目把它和 `until`/`reason` 放在一起——**上游的原话跟着它自己造成的冷却一起走**：[adapter.ts](../src/host/antigravity/adapter.ts) 与 [image-tool.ts](../src/host/antigravity/image-tool.ts) 在为配额型 429 记冷却时，把截断后的上游响应体作为 `detail` 一起写进去。`getEffectiveAccountFor` 保留「哪一族在冷却、最短还要几分钟」的措辞，**「上游返回：」后面引的是最先解除的那条冷却所带的 detail**（与那个「最短预计 N 分钟」指的是同一条，两者不会各说各话）；**没有任何 detail 时整句都不加**——共享内核抛出的那句「全部 N 个 Antigravity 账号均处于配额限制或冷却中」说的是**号池状态**而不是上游，它只作为 cause 链留在错误里，绝不会被贴上「上游返回」的标签。
  - **验证**：`npm run typecheck` 0 错误；全量 **247 passed | 1 skipped（248 文件）、4016 passed | 7 skipped、0 failed**。新增 7 条回归守卫（adapter 4 条、image-tool 1 条、account-pool 2 条），并给既有的图片 429 用例加了两条断言（「429 只问一次」「上游原话随冷却一起写」）；**变异验证**：把这 3 个源码文件回退到改前版本后 6 处变红；再把「上游返回：」改回引号池状态那句话、或让 adapter 不再把上游响应体交给冷却，account-pool 与 adapter 的 3 条当场变红，恢复后全绿。
- **[账号池] 冷却剩余时间改成秒级实时倒计时**
  - **现象**：账号卡片上的「冷却中（剩 5 分）」是一个**静止的数字**——它在页面绘制那一刻算一次就再也不动了。5 分钟的冷却，用户会看着「剩 5 分」整整 5 分钟。同一行里的「重置冷却」按钮点掉之后，徽章还在（它跟号池状态不是一回事）。
  - **改法一（实时倒计时）**：[AccountPoolSection.tsx](../src/client/common/AccountPoolSection.tsx) 里 `now` 从渲染时取的 `Date.now()` 变成 React state，由一个 1 Hz 的定时器推进。**定时器只在真有东西在冷却时才跑**（`counting` 开关），没有冷却的设置页不会为此每秒唤醒一次标签页；卸载时清理。徽章显示真实剩余时间：整分钟用原措辞，分钟+秒用新模板，不足一分钟**只显示秒**——「剩 1 分」撑最后 59 秒是假的。冷却结束，徽章**自己消失**，不用等下一次刷新。
  - **改法二（重置冷却真的清干净）**：号池的 `clearCooldown` 清掉的是该账号的**冷却标记本身**（`cooldownUntil` 与 `cooldownReason` 一起写回 `undefined`），而不是只回一句「已重置」。留着标记等于报告了一次没有发生的重置。
  - **验证**：`npm run typecheck` 0 错误；全量 **247 passed | 1 skipped（248 文件）、4009 passed | 7 skipped、0 failed**；`npm run build` 通过。新增 2 条回归守卫（逐秒倒计时并到点自行消失、共享标签纪律扩展到新键）。
- **[进展更新] 默认开启，并补上「宿主服务晚到」时丢失的右侧栏入口**
  - **现象一（多数用户）**：「进展更新」的开关默认是**关**的。没手动开过的用户装上插件后：`progress_update` 工具的 `execute` 一直返回 `displayed: false`，系统提示词里没有引导节，8 轮催促也不触发——功能整套静默不工作，而设置页里那个开关是唯一线索（截图里它是关的）。
  - **现象二（部分用户）**：右侧栏 guide 里那一格「进展更新」**整格不出现**。页签类型是在本插件 `apply` 的那一刻同步向 `ctx.get('sidebarRightTabs')` 读的；宿主 `ui-sidebar-right` 若比本插件晚上线，那次读回来的是 `undefined`，注册被整段跳过——面板注册齐全但右侧栏空着，用户根本找不到入口（`test/progress-updates-client.test.tsx` 里那条「guide 入口缺失」的回归守卫就是为这个写的）。
  - **改法一（默认开启）**：[src/index.ts](../src/index.ts) 的 `progressUpdates` 由 `default(false)` 改为 `default(true)`；[src/host/progress-updates/index.ts](../src/host/progress-updates/index.ts) 的 `resolveProgressUpdatesSettings` 判定由 `enabled === true` 改为 `enabled !== false`（**缺省即开启**，只有显式写 `false` 才关）；[settings-section.tsx](../src/client/progress-updates/settings-section.tsx) 的开关展示同步按「缺省即开启」——宿主还没答上来时显示为**开**而不是关。关掉的能力没有丢：设置页写 `false` 立刻生效（字段是 `volatile()`，不重挂插件行）。
  - **改法二（晚到的服务自动补注册）**：[src/client/progress-updates/index.ts](../src/client/progress-updates/index.ts) 里，服务在位时仍**就地注册**（同步，行为不变）；服务缺席但上下文支持 `ctx.inject` 时，改用 `ctx.inject(['sidebarRightTabs'], ...)` **等它上线时补注册**页签类型与 guide 入口。取服务时先试 scope 的属性读（scope 的 inject 名单里有它，合法）、失败再退回 `ctx.get()`——本插件自己的静态 `inject` 没有这个服务名，直接读属性会被 Cordis 拒绝。设置表单 `configForms` 晚到时同样按需重取，设置页不再永久停在只读态。
  - **没有踩的坑**：`ctx.inject` 在 Cordis 里会新建一个 fiber，服务永不上线时它就一直等着，**不影响**本插件其余部分的挂载；因此没有把 `sidebarRightTabs` 写进本插件的静态 `inject` 名单（那会让整个插件在没装 `ui-sidebar-right` 的部署上挂不上）。
  - **验证**：`npm run typecheck` 0 错误（`tsc -b --force` + `tsc -p test/tsconfig.json`）；全量 **247 passed | 1 skipped（248 文件）、4006 passed | 7 skipped、0 failed**；`npm run build` 通过。新增/更新 5 条回归守卫，并做**变异验证**：临时回退这 4 个源码文件后，其中 5 条全部变红（默认开启 3 条、侧栏服务晚到 1 条、设置服务晚到 1 条），恢复后全绿。

## 0.28.0 - 2026-10-19
- **[MiniMax Code] 模型目录跟上正式版：`MiniMax-M3.1-Flash` 取代 `MiniMax-M3.1-Flash-Preview`，并给存量用户留了一条迁移路**
  - **上游改名了**：MiniMax 于 2026-10-19 发布正式版 `MiniMax-M3.1-Flash`（官方 Model Invocation 页的 Supported Models 表已不再带 `-Preview` 后缀，1,000,000 上下文）。我们随包的硬编码目录里那条 `MiniMax-M3.1-Flash-Preview` 已经不是上游当前的名字。
  - **先实测，再改目录**：用本机设备码凭据打国区订阅端点 `https://agent.minimax.cn/mavis/api/v1/llm/v1/messages`，三个 id 各发一次真实请求，全部 **HTTP 200** 且服务回显同名——`MiniMax-M3.1-Flash`（新）、`MiniMax-M3.1-Flash-Preview`（旧，仍未被下线）、`MiniMax-M3`（对照）。正式版另测两项能力：`output_config.effort` 真生效（同一 prompt 下 `low` 289 思考 token / `max` 412），内联图片块被接受并正常作答（多模态可用）。
  - **改法一（目录换名）**：[model-catalog.ts](../src/host/minimax-code/model-catalog.ts) 第四条改为 `MiniMax-M3.1-Flash`（显示名 `MiniMax M3.1 Flash`）。**1M 上下文取自官方 Model Invocation 页**，思考强制开启 / effort 可调 / 收图三项为 2026-10-19 实测；**输出上限 128k 与 4 附件这两个数是沿用 Preview 条目的**（官方只公布上下文，不公布输出上限与每模型附件数），注释里写明未重测。
  - **改法二（存量勾选不再被丢掉 —— 本轮真正的坑）**：`resolveMinimaxCodeEnabledModelIds` 会把目录里没有的 id 全部过滤掉。别的用户 `enabledModelIds` 里存着 `MiniMax-M3.1-Flash-Preview`，换名后这一条被丢掉；**如果他只勾了这一个模型，升级后模型选择器会一个都不剩**。因此目录加了一张**单向改名映射**（旧 id → 新 id），并让它在四个地方生效：查目录条目、`isMinimaxCodeModelId`、存量勾选解析（去重后不重复列）、以及**按旧 id 存过的上下文窗口覆盖**继续生效。默认勾选「未编辑过」的判定也改在解析之后做，所以用旧拼写写下的完整默认列表仍按「随目录增长」处理。
  - **改法三（线上的 id 不动）**：改名只发生在**查找**层，**发上线路的 model 字段仍按调用方给的那个 id 走**。已有会话记录里的 id 因此原样保留，它带着的 thinking 签名回放作用域（route/model/authOwner）不会因为换名而失配——把 wire 也改掉会让在途会话的回放校验对不上。
  - **文档同步**：README 里「四款模型」与「思考形态三态」两条（后者原本还在写早已不用的 `thinking` 对象，已改为 `output_config`）、视频占位提示文案、`types.ts` 的过期注释、[subagent-model-authorization.ts](../src/host/subagent-model-authorization.ts) 的示例路由串、5 个测试文件里的模型 id 全部改为正式版；[docs/minimax-code-gap-plan.md](docs/minimax-code-gap-plan.md) 补记改名事实并说明其中引用的官方原文保持不动。
  - **验证**：`npm run typecheck` 0 错误；全量 **247 passed | 1 skipped（248 文件）、3997 passed | 7 skipped、0 failed**（新增 `test/minimax-code-model-rename.test.ts` 9 例，钉住「目录只列新 id」「旧 id 仍解析到同一条目」「存量勾选不丢」「两种拼写不重复列」「旧 id 的窗口覆盖继续生效」「卡片按新 id 显示为已勾选」）。

## 0.27.2 - 2026-10-18
- **[进展更新] 正文补上 GFM 表格，对话流与侧栏面板改用同一个渲染器**
  - **现象**：模型在进展正文里写 GFM 表格（`| 题 | 难度 |` + `| --- | --- |`）时，面板把整块表格**原样**显示成一堆竖线；同时对话流里的主形态（`progress-row.tsx`）正文是纯文本 `<p>{message}</p>`，连 `**粗体**` 都不解析——同一份进展在侧栏渲染过、在对话流里是原文，两处观感对不上。
  - **改法一（`markdown-lite.tsx`）**：补 GFM 表格块。识别用**两行前瞻**（本行含 `|` 且下一行是分隔行 `| :--- | ---: |`）：孤立的竖线不会被误判成表格；支持 `:---` / `:---:` / `---:` 三种对齐、单元格内 `\|` 转义、数据行短于表头时补空格子。渲染成真实 `<table>/<thead>/<tbody>/<th>/<td>`，对齐落在 `text-align` 上，窄屏外包一层 `overflow-x:auto`。仍然**零依赖**、不经 `dangerouslySetInnerHTML`。
  - **改法二（`progress-row.tsx`）**：正文改用同一个 `MarkdownLite`，并去掉外层 `white-space: pre-wrap`（换行该由块级元素决定，而不是靠保留原文换行）。两处观感自此一致。
  - **改法三（提示词与工具描述）**：`prompt.ts` 的正文写法与 `tool.ts` 的 `message` 参数描述都补了一句「有几行数据要对照时用 GFM 管道符表格」，让模型知道表格现在真的会被渲染出来。
  - **仍然不做**：图片、链接、原始 HTML、脚注、围栏代码块——要么需要安全过滤，要么不属于「进展汇报」这个场景。
  - **验证**：`npm run typecheck` 0 错误；全量 **246 passed | 1 skipped（247 文件）、3988 passed | 7 skipped、0 failed**；`npm run build` 通过，`lib/client.js` 里已含 `md-table`/`md-th`/`md-td` 标记。新增 3 条回归（面板表格 / 孤立竖线不误判 / 对话流也渲染），并做变异验证：把表格识别分支关掉，其中两条立刻变红（2 failed），恢复后 31 passed。

## 0.27.1 - 2026-10-18
- **仅版本号变更**：`package.json` 由 0.27.0 提到 0.27.1，源码零改动（`git diff v0.27.0 v0.27.1` 只有一行版本号）。
  - **补记原因**：0.27.1 当天已发布到 npm（2026-10-18T04:31:48Z），但发版时漏打了 git tag、也没在 CHANGELOG 留记录，导致版本线在 git 侧断了一格。事后**只在本机补了 `v0.27.1` 标签**（指向 `f75bc78`），**未推送**——推上去会让 CI 去发布一个已存在的版本而失败。

## 0.27.0 - 2026-10-18
- **【进展更新】agent 在多步任务中主动汇报，对话流里一行一条，右侧栏可回看**
  - **是什么**：新增 in-tree 子模块 `src/host/progress-updates/` + `src/client/progress-updates/`，复刻 Kimi Code 的「进展更新」。agent 通过一个**不结束回合**的工具 `progress_update(title?, message)` 主动汇报，对话流里渲染成一行（状态点 + 标题 + 状态词，正文点开看），右侧栏有一个总览面板。
  - **宿主侧**：工具注册始终进行（工具清单不能在会话中途变化），开关关闭时 `execute` 返回 `{displayed:false}` 而不是抛错；系统提示词用 `systemPrompt.section({ text: () => enabled ? … : '' })` 的**函数形式**，所以设置改了立刻生效、不需要新开会话；`tools/post-execute` 上做 8 轮催促——**按会话维度计数**（subagent 沿 `header.parentSession` 归并到顶层祖先，整棵委派树共用一个计数器，修正了「主 agent 与子 agent 各记一份、谁都没到阈值」的既有瑕疵）、**按模型步去重**（读 `sessionProjections` 的 `turnBoundary.lastStepStartSeq`，一次并行发多个工具只算一轮），达到阈值注入一条 `additionalContexts` 提醒。
  - **可选服务一律走 `ctx.get()`**：`tools` / `systemPrompt` / `webServer` / `sessions` / `sessionProjections` 全部在**调用时**读取，缺任何一个只退化成更弱的实现（不注册工具 / 无提示词 / 无路由 / 按工具结果计数），**不抛错、不降级整个插件**。`inject` 数组没有新增任何一项。
  - **取数通道**：`GET /api/dsh-progress-updates/updates?session=<id>` → `{ updates: ProgressUpdate[] }`，带 `cache-control: no-store`，loopback 信任栅栏（socket + Host 头 + `sec-fetch-site`）。浏览器半边是独立运行时，拿不到宿主进程的任何对象，所以只能走同源 HTTP —— 轮询客户端在 `src/client/progress-updates/host-source.ts`，无订阅者时不发任何请求。
  - **设置**：并入本插件已有的 `Config`，两个字段 `progressUpdates`（默认 false）与 `progressUpdatesNudgeThreshold`（默认 8，1–50），都是 `volatile()`，改完即时生效。设置页是**独立一格**（`settings.section`，id `progress-updates`，order 150），不与订阅服务那格（`subscription-hub`，45）合并。
  - **右侧栏入口**：`sidebarRightTabs.register` 声明页面型页签，并带一个 `guide` 条目与自绘的 36×36 彩色标记——页签类型只是声明，**guide 条目才是用户看得见、点得到的入口**。
  - **正文渲染**：`markdown-lite.tsx`（零依赖）渲染段落、无序/有序列表、行内代码、粗体与最多三级标题；段落、列表、行内标记都是真实元素，不经 `dangerouslySetInnerHTML`，因此没有注入面。平台 `MarkdownText` 是第一选择但被排除（见提交信息：它的 lib 顶层静态 import `.module.css`，Node 的 ESM 加载器先于任何 vite 插件与 alias 生效）。
  - **验证**：`npm run typecheck` 0 错误；全量 **3985 passed | 7 skipped**；`npm run build` 通过。四条回归守卫各自做过变异测试（不插值 / 展开改回单选 / 正文改回纯文本 / 去掉 guide 条目，各自都会让对应用例变红）。

- **[推理塌缩守卫] 熔断器默认关闭：功能与实现全部保留，只把「默认接电」改成「部署显式接电」**
  - **现状**：本线的「熔断器」即推理塌缩守卫（`src/host/reasoning-collapse-guard/index.ts`），它订阅 `llm/stream` 瀑布，在「n-gram 重复度」与「语义复现」双信号连续命中时切断本轮流并排一条续跑。该守卫已无需在生产轮次里生效。
  - **改法（只动接线，不动实现）**：`src/index.ts` 的 `reasoningCollapseGuard` 配置默认值由 `{}` 改为 `false`（`Config` 与 `apply()` 的注释同步改写）。默认配置下 `if (pluginConfig.reasoningCollapseGuard !== false)` 直接跳过，守卫的 `ctx.effect` 注册、`llm/stream` 订阅、per-turn 熔断簿记与续跑排队**全部不装配**，运行时零开销、零副作用。
  - **保留下来的**：`installReasoningCollapseGuard` 导出、全部调参与 fail-loud 校验（`resolveOptions`、`threshold`/`semantic*`/`maxBreaksPerTurn` 等）、`test/reasoning-collapse-guard.test.ts`（80 例）与 `test/reasoning-collapse-guard-registry.test.ts`（注册表读取边界）**一律未动**；部署要重新启用只需在插件配置里写 `"reasoningCollapseGuard": {}`（用出厂默认）或写入调参对象，`false` 保持关闭。
  - **新增回归**：`test/circuit-breaker-default.test.ts`（3 例）钉住两半——`Config({}).reasoningCollapseGuard === false`、写入对象/ `false` 仍被原样接受、`installReasoningCollapseGuard` 仍可导入且无事件总线时返回 `undefined` 而不抛错。
  - **验证**：`npm run typecheck` 0 错误；全量 **233 passed | 1 skipped（234 文件）、3821 passed | 7 skipped、0 failed**；**承重已双向检查**——把默认值临时改回 `{}`，新用例立即 1 failed，恢复后全绿。
  - **升级提示**：默认安装的 Host 升级后不再有任何塌缩熔断与随之的续跑；此前依赖「死循环自动刹车」的部署需在插件配置里显式写回 `"reasoningCollapseGuard": {}`。运行中的 Host 需重启（或重载该插件条目）才会加载新 bundle。
  - **文档（“将来需要时再开”的落点）**：README 新增独立章节 **「推理塌缩守卫（熔断，默认关闭）」**——两个信号各测什么、双信号连续命中才切断且只排一条续跑、关闭后哪四样东西不再发生（不注册 `llm/stream` 订阅 / 不建每回合熔断簿记 / 不排续跑 / 零运行时开销）、以及**将来重新开启的具体做法**（`cordis.patch.yml` 里写 `reasoningCollapseGuard: {}` 或调参对象，取值表：缺省=`false` 关闭、`{}`=出厂默认开启、对象=调参、`false`=显式关闭），并记下守卫与 `noAnswerResume` 在 `llm/stream` 外层的共用边界（重新开守卫前需复查）；「子代理模型授权」的配置项表下补一条指向该章节的说明；守卫源码头部与 §Config 注释同步标注默认关闭。

- **[Web 抓取] 选择退回 DSH 自带 provider 后再无触发点自愈：整条抓取线路静默失效（本机实证）**
  - **现象**：本机 `web_fetch` 对任何域名都报 `URL hostname "…" resolves to a non-public IP address`（`WEB_BLOCKED_URL`），而设置页显示搜索来源已是「ChatGPT（代理隧道）」、自定义代理 `http://127.0.0.1:7890` 可用。
  - **本机实证**：`GET /api/dsh-chatgpt-subscription/status` 读到 `preferences.searchProvider = "codex"`、`activeProxy = "http://127.0.0.1:7890"`，而 `switcher = { state: "applied", configuredSearchProvider: "deepseek-official", configuredFetchProvider: "http" }` —— `web` 条目仍是 DSH 默认值。报错文案同时指认服务方：对 IP 字面量 `127.0.0.1` 得到的是内置 provider 的措辞（`resolves to a non-public IP address`，见 `web-fetch-http/src/network.ts`），本插件对字面量用的是 `is not a public IP address`（`fetch-address-policy.ts`）。
  - **根因（两处，都是「没人再问一次」）**：① `applyWebProviders` 可能在 `preferences.hydrate()` 落盘之前就跑完，此时读到的默认值（`dsh` + 无代理）算出的目标恰好等于 `web` 条目自带默认值，`applySelection` 的 `configured && applied` 提前返回、写 `state='applied'`，一个字节都没写，之后同样没有事件再触发；② 即使选择写进去了，它只存在于 loader 条目的运行期 config，后续一次组合把该 config 改回默认值时，同样没有任何事件通知本插件。
  - **改法**：`applyWebProviders` 先 `await preferences.hydrate()` 再读 `preferences.status()`（不再采信调用方传入的旧快照）；新增 `src/host/web-provider-reconciler.ts`，每 30s 做一次干对账——无漂移时 `select()` 直接返回、不重启任何条目，有漂移才把选择写回，并在插件 disposer 里停表。
  - **验证**：`npm run typecheck` 0 错误；`npm run build` 通过；全量 **232 passed | 1 skipped（233 文件）、3818 passed | 7 skipped、0 failed**（基线 3813，新增 5 例：对账定时器 4 例 + 条目 config 被外部改写后自愈 1 例）。**运行时双向验证**：修复前 `web_fetch` 全部被拒；用插件接口把搜索来源切到 `dsh` 再切回 `codex` 触发一次真实应用后，`configuredFetchProvider` 变为 `codex-subscription`，`example.com` / npm registry / `deepseek.com/harness` 均 200，`web_search` 正常返回来源。
  - **升级提示**：运行中的 Host 需重启（或重载该插件条目）才会加载新 bundle；重启前若仍被拒抓，可在设置页把「搜索来源」切到 DSH 默认再切回 ChatGPT 手动触发一次。

## 0.26.0 - 2026-10-17

- **[MiniMax Code] 无答案轮次现在会自动续跑跑完（社区 PR #61），并把「续跑预算」真正做成有界**
  - **问题**：0.24.7 之后，模型把整轮花在思考上、只回 thinking 块就 `end_turn` 的轮次不再静默停住，而是**明确报错**——诚实，但这一轮仍然没跑完。harness 没有「模型啥也没干就停了」这个失败模式的表示，所以报完错这一轮就结束了，没有任何东西接着往下做。PR #61 新增 host 侧钩子监听 `llm/stream` 瀑布，认出这条失败后 steer 一句续跑提示，让这一轮跑完。**关键约束（PR 已论证且经复核）**：steer 必须在 Agent 空闲时发——`Agent.steer` 往 inbox 里 splice 并调 `wakeDriver`，而 `wakeDriver` 只在 `phase.kind === 'idle'` 时开新回合；回合还在 running 时发，什么都不 latch，消息会一直躺在 inbox 里没人读。因此这里等 `whenIdle()`。失败靠 `mapper.ts` 导出的 `NO_ANSWER_PHRASE` 识别，不抄句子。配置：`"noAnswerResume": { "maxResumes": 2, "text": "..." }`，`"noAnswerResume": false` 关闭。
  - **合并后另行修复的两个缺陷（在发版前发现，若直接发布会让默认安装的用户被无限烧请求）**：① **`maxResumes` 实际不封顶**——`settle()` 从生成器的 `finally` 调用，而 `finally` 在**正常结束、被放弃、抛错**三种退出上都会跑；流被放弃时根本没见到 finish chunk，`answerless` 一定是 false，只要此前吐过正文 `answered` 就是 true，于是那句 `if (answered) consecutive = 0` 把计数清零。生产上有两条常规路径会踩到：用户按停止（harness `for await` + `throwIfAborted`），以及**推理塌缩守卫**——它在 `llm/stream` 上先注册，因此处在 Cordis 瀑布的**外层**，`return` 时不给 finish chunk。实测 `maxResumes: 2` 却续跑了 6 次。改法：只有**读到底**的流才结算，被放弃或抛错的流什么都不能证明，既不消耗预算也不清零、且不写日志。② **计数不是「连续」，日志在说谎**——只有「答出来了」的轮次才清零，于是 `aborted finish` / `max-tokens` / `TIMEOUT` / 其他 `PROVIDER_ERROR` 都不会打断连击：三段**不相邻**的无答案轮照样打出 `gave up after 2 answerless turns in a row`，预算被花掉一次之后该功能在本会话余下时间里静默失效。改法：**任何**正常结束且非无答案的轮次都清零连击，让标识符、注释与日志三者一致。
  - **另外三处加固**：③ 每会话状态在 `agent/disposed` 时清理（照搬塌缩守卫的做法），不再为进程生命周期内每个会话常驻一条；④ 插件销毁后排队中的续跑不再 steer，且一个会话同时只持有一条排队续跑（同一轮重试 settle 两次不会投递两次）；⑤ `isVisible` 改为 `trim()`，与产出方 `hasVisibleOutput` 完全一致，避免消费方与产出方对「这一轮算不算答了」产生分歧。
  - **验证**：`npm run typecheck` 0 错误；`test/no-answer-resume.test.ts` **22 passed**（贡献者的 15 例 + 7 例回归：`iterator.return()` 放弃、中途抛错、`TIMEOUT` 轮次、销毁时有续跑在排队、空闲前两次 settle）；`test/reasoning-collapse-guard.test.ts` 80 passed；全量 **231 passed | 1 skipped（232 文件）、3809 passed | 7 skipped、0 failed**。**承重已双向检查**：把源码还原到合并提交后重跑，新增用例 **7 failed | 15 passed**，失败项正是上述缺陷，恢复后重新全绿。
  - **复核结论（对照真实 harness 源码逐条核对）**：`llm/stream` 瀑布签名、`{ global: true }` 为真实的 `EventOptions` 字段、`GenerateOptions.sessionId`/`purpose`、`StreamChunk` 的 finish/delta 形状、`Agent.steer`+`whenIdle` 语义（空闲 steer 会开新回合、忙碌 steer 会 latch 并被 live driver 认领、只有 `cancel()` 才丢弃）、`ctx.get('agents')` 是**合法的免 inject 读取**而 `ctx.agents` 会抛——全部为真；`NO_ANSWER_PHRASE` 只有一个产出方，不存在跨线路误判。
  - **未做**：真正的「不让它发生」仍要靠请求侧降档（effort 从 max 降到 xhigh/high），那是部署配置、不在本仓；本版只让**已经发生**的轮次跑完。子代理会话同样会被续跑（`purpose` 为 undefined 且自带 sessionId），若日后需要只对主线生效，应以 `request.provider` 收窄，留作后续。
## 0.25.1 - 2026-10-17

- **[Harness & 调度预设] 适配 DSH 0.2.1-rc.1 / 0.2.1-rc.2，并修复调度模式在 0.2.1 下报 `unknown prompt variable "{{cwd}}"` 的启动失败**
  - **调度预设（`dispatch`）移除未注册的 `{{cwd}}` 变量**：DSH 0.2.1 引入独立的 `@deepseek-ai/dsh-working-directory` 服务（通过 `working-directory` section 注入工作目录提示），不再向 `ctx.systemPrompt` 注册 `cwd` 模板变量（仅保留 `provider` 与 `model`），导致 `dispatch` 预设在组装系统提示词时直接报错 `unknown prompt variable "{{cwd}}" in section "deployment:persona-prefix"; registered variables: provider, model`。本次从 `presets/dispatch/agent.cordis.yml` 与 `src/host/agent-preset.ts` 的 `persona.config.prefix` 中移除重复的 `Your working directory is {{cwd}}.`，并新增 `resolveDispatchPreset()` 在检测到 `@deepseek-ai/dsh-working-directory`（`>=0.2.1`）时自动剥离 `persona.config.suffix`，而在 `0.1.7–0.2.0` 及 `≤0.1.6` 上完整保留 `suffix: 'Your working directory is {{cwd}}.'`。
  - **适配 0.2.1-rc.2 的 `Volatile` 搜索配置（`SearchProviderSwitcher`）**：`dsh-v0.2.1-rc.2` 将 `@deepseek-ai/dsh-web` 的 `searchProvider` / `fetchProvider` 配置改为 `z.string().volatile()`，运行时 `fiber.config.searchProvider` 为暴露 `.get()` 的 `Volatile` 包装器而非裸字符串。`src/host/search-provider-switcher.ts` 新增 `runningProviderValue()` 同时兼容裸字符串（`≤0.2.1-rc.1`）与 `Volatile<string>`（`>=0.2.1-rc.2`），避免在 `>=0.2.1-rc.2` 下切换搜索源时误判热更新未生效而触发多余的 fiber 强制重启。
  - **依赖基线与 Claude 快照对齐**：15 个 `@deepseek-ai/dsh-*` 的 `peerDependencies` 与 `devDependencies` 同步升级至 `^0.2.1-rc.1`（覆盖 `0.2.1-rc.1`、`0.2.1-rc.2` 及 `0.2.1` 正式版），`@deepseek-ai/cordis` 升级至 `^4.0.6`；Claude 模型目录顺序与测试基线同步对齐本地 Harness 的 `@earendil-works/pi-ai@1.1.0`（17 条快照）。
  - **验证**：`npx tsc -b --force`、测试树 `tsc`、干净 `npm run build`、`npm ci --dry-run`、`npm pack --dry-run`（523 文件）均 0 错误通过；全量 **230 passed | 1 skipped（231 文件）、3787 passed | 7 skipped、0 failed**。

## 0.25.0 - 2026-10-17

- **[Harness] 支持 DSH 0.2.1-alpha.5，并接入新版可用的请求元数据能力**
  - **依赖与启动兼容**：15 个 `@deepseek-ai/dsh-*` peer range 都明确加入 `0.2.1-alpha.5`，dev 基线使用精确版本，避免安装时静默落到刚发布的 `0.2.1-rc.1`。Cordis / loader / schemastery 使用与 alpha.5 peer 约束兼容的稳定补丁版，消除了根包 alpha 与间接稳定插件之间的真实 peer 冲突；`package-lock.json`、`pnpm-lock.yaml` 和 `pnpm-workspace.yaml` 已同步。
  - **WebServer 与流超时**：`webServer.port` 在新版变为可空，Codex 本地图片地址改为优先使用新版 `getOrigin()`，旧版保留原 loopback / wildcard 构造，未绑定服务则明确报错。上游 idle watchdog 已能在传输忽略 abort 时结束等待；插件清理路径同步改为 detached drain，不再因 `await iterator.return()` 把已经超时的流重新挂死。
  - **推理档位**：新版把 `reasoning.efforts` 定义为从低到高，会话标题等辅助调用直接选择第一项。Kimi live 乱序、MiniMax M3.1 的本地 `default`（省略后上游默认为 `max`）和 Codex live 档位现在都在 adapter 边界规范，设置页展示顺序与普通请求默认档不变，辅助调用能取得真正的最低档。
  - **图片与工具视图**：Kimi / Step / MiniMax / Antigravity 新增 `imageRequestTarget()`，返回与真实 mapper 一致的缩放目标，供新版 CUA 等调用方使用；小图保留原尺寸和字节。共享与 Antigravity 目标同时补回旧 attachment store 必需的 `maxPixels`。Claude 的缩放取决于整次请求图片数，未伪造单图实现。Codex / Antigravity 图片工具视图还会读取新版惰性 `args`，在 preparing 阶段即可显示正在生成的 prompt，旧 `argsRaw` 形状继续兼容。
  - **PTC 与旧代际**：新版 `run_code` 要求 `workingDirectory` 并用 `agent.ctx` 管理状态；实际受影响的是测试夹具而非生产授权逻辑，四个子代理授权用例已按新契约补齐并全部恢复。`llm-compat` 同时补齐旧类型没有的 `toolHistory`、`deferLoading` 与 tool-update 块，GLM 的现有拒绝行为不变。Claude OAuth 测试不再假设 `freePort + 1` 一定可绑定，以匹配 Windows 动态单端口保留；生产 OAuth 代码未改。
  - **验证**：新基线强制 typecheck、干净 build、`npm ci --dry-run`、`npm pack --dry-run`（523 文件）均通过，全量 **230 passed | 1 skipped（231 文件）、3785 passed | 7 skipped、0 failed**。`0.2.0-rc.2` clean room 为 **3784 passed | 8 skipped、0 failed**；`0.1.5-rc.3` clean room 为 **3780 passed | 8 skipped**，仅已有记录的无 `dsh-ptc-runtime` PTC 文件无法加载，其他 229 个文件全部通过。
  - **未采用 / 未验证**：`conversation.input.model.label` 需要另一套新旧双轨额度 UI 设计，第一方 `AccountNoticeStack` 不是通用插件通知服务，本轮没有强行迁移九条额度徽标；`ConfigureCall` 在插件内没有 auxiliary 调用点，`toolUpdate`、nested PTC `presentationMeta` 和官方图片 factory 留待独立评估。`0.2.1-rc.1` 无对应源码标签，不在本轮已验证范围；未做真实账号网络调用或 CUA / 新槽位的交互验证。

## 0.24.7 - 2026-10-16
- **[MiniMax Code] M3.1 在 `effort: max` 下偶尔把一整轮花在思考上就 `end_turn`：只有 thinking 块、没有正文也没有工具调用，harness 把「无工具调用的 stop」当成正常完成，整轮无报错地停住（issue #57）**
  - **现象**：MiniMax Code 线路偶发**整轮无预警停住**——界面不报错、不重试、不弹提示，回复停在半句话上（如 `...Let me read lines 130-160 of the upstream preset.`）。
  - **根因（会话存档实证，非推断）**：M3.1 在 `effort: 'max'` 下有时把整轮都花在思考上，然后带 `stop_reason: end_turn` 收尾，**只回一个 thinking 块**。mapper 把它如实映射成 `{ kind: 'stop' }`（这一步没错），但 harness 的 `agent-loop` 对「没有工具调用的 stop」无条件返回 `{ kind: 'completed' }`（`packages/core/agent-loop/src/agent.ts`），于是整轮就这么结束、调用方零感知。**责任层在 turn-end 映射，不在适配器**：本机 24 个会话存档里该线路 20 个 completed 轮次中有 **4 个**是这种形状，全部 `effort: 'max'`，每一轮的下一句用户输入都是「继续」。存档里的 `message.source.replayState.blocks` 保存了未改写的原生块，四例均为 `["thinking"]`——即上游本来就没发正文，不是适配器吞了内容，也不是流被掐断（`state.done` 为真，`assertStreamComplete` 放行是正确的）。
  - **改法**：`finishReasonFor` 在 `stop` 之前新增判据——**既没有可见正文、也没有工具调用**时返回 `{ kind: 'error', failure: { code: 'PROVIDER_ERROR' } }`，形状照 `antigravity/mapper.ts` 里 `OTHER` 的既有写法。判据**不能复用 `state.hasContent`**：该标志由 `thinking_delta` 一起置位（文本/思考增量共用一个分支），「只有推理」在它眼里也是「有内容」，这正是此前一直没能接上判据的原因。失败信息里同时带上这一轮是被哪个事件收尾的（`message_stop` / `stop-reason` / `stream-end`，内部辅助函数、不对外导出），以后报到这个错可直接看出流是怎么结束的。
  - **验证**：`npm run typecheck` 0 错误；全量 **226 passed | 1 skipped（227 文件）、3765 passed | 7 skipped、0 failed**。新增一张表驱动的**终止线形回归网**（9 种线形 + 1 条 `max_tokens` 独立用例）：只有 thinking 增量 / thinking 仅在 `content_block_start` / 空流 / 空 text 块 / 纯空白 text → `error`；reasoning→text、只有 text → `stop`；只有工具调用、reasoning+工具调用 → `tool-calls`；`max_tokens` 截断 → `max-tokens`，**无健康线形被误伤**。矩阵中每一例都同时断言 `assertStreamComplete` 不抛——判据关于**内容**，与流是否被截断无关。**承重已双向检查（负对照）**：移掉 `finishReasonFor` 里那段判据，矩阵中 5 条 `error` 用例立刻变红、4 条健康线形仍绿。
  - **升级提示**：这是**明确报错**而不是自动重试——`PROVIDER_ERROR` 不在本线重试集合里（`adapter.ts` 只有 `RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`）。升级后遇到这种轮次会看到一条失败的轮次，而不是静默停住；要让该轮自动跑完仍需另做续跑注入（未包含在本次改动内）。
- **[Claude] 续期请求要了授权里没有的 `org:create_api_key`：每次 access token 到期都被判 `invalid_scope`，账号被标成过期，只能重新登录**
  - **现象**：Claude 线路大约每个 token 周期（约 8 小时，或隔夜后第一次使用）就报 `Claude rejected the sign-in: The requested scope is invalid, unknown, or malformed.. Sign in again.`，必须重新登录；其他线路没有这个问题。
  - **根因（会话存档实证，非推断）**：authorize 请求的是 `OAUTH_SCOPES`（含 `org:create_api_key`），授权服务器对订阅账号**静默剥掉**这一项而不让登录失败（落盘凭据的 `scopes` 只有 5 个 `user:*`），续期却把整组 `OAUTH_SCOPES` 原样发回。RFC 6749 §6 规定续期不得请求原授权以外的 scope，服务器回 `invalid_scope`；它在 `FINAL_GRANT_CODES` 里 → `ClaudeUnauthorizedError` → 号池 `refreshFailureStatus` 标 `expired` 并移出轮换。本机会话存档在 10-14 至 10-16 间出现 4 次上述原文报错，间隔 11–13 小时。对照：官方 Claude Code 续期只发 5 个 claude.ai scope，参考实现 pi-mono 续期不带 scope——只有本插件多要了一项。
  - **改法**：新增 `refreshScopeFor`，续期只回发凭据自己记录的已授权 scope（去空白、去重、保序）；凭据没有记录时回退到新常量 `OAUTH_REFRESH_FALLBACK_SCOPES`（与官方客户端一致，不含 `org:create_api_key`）。`ensureAccessToken` 与号池 `refreshClaudeCredential` 两个调用点都传入 `credentials.scopes`。authorize 请求保持不变。
  - **验证**：`npm run typecheck`、`npm run build` 0 错误；全量 **226 passed | 1 skipped（227 文件）、3753 passed | 9 skipped、0 failed**（新增 4 例；多出的 2 个 skipped 是本机缺 pi-ai 参考快照的 `claude-model-catalog` 保真断言，与本改动无关）。新用例的假 token 端点按 RFC 6749 §6 拒绝越权 scope，号池用例走真实 refresh hook（不经测试 seam）。**承重已双向检查（负对照）**：把续期 body 还原为 `scope: OAUTH_SCOPES`，3 条新用例失败，其中两条抛出的正是线上那句 `The requested scope is invalid, unknown, or malformed.. Sign in again.`。
  - **升级提示**：升级前已被这个问题标成"需要重新登录"的账号，升级后仍需重新登录一次来清除标记；之后续期正常。

## 0.24.5 - 2026-10-16
- **[推理塌缩守卫] Agent 先于守卫创建时注册表两条读取路径同时失效：熔断生效但续写从未排队，回合被截断后静默结束**
  - **现象**：对话在思考中途**没有任何报错地突然结束**，界面上什么都不显示。
  - **触发条件（判别实验实测，非推断）**：Agent 注册表由**兄弟 fiber** `@deepseek-ai/dsh-agent` 提供，插件 `inject` 未声明 `agents`，Cordis 对未声明的服务属性读取**直接抛** `cannot get property "agents" without inject`。守卫有两条读取路径（`ctx.agents` 属性、`agent/created` 映射表），而**当 Agent 在守卫装载之前就已创建**时——插件 HMR 重载、或激活晚于会话建立，本 profile 的 `hmr` 是启用的——映射表为空，属性读取又抛异常，**两条路同时断**：`resolveAgent` 返回 `undefined`，`breakOff` 在**第一行** `if (agent === undefined) return` 就返回，**熔断（`return` 截断流）已发生，而 `cancel` 与 `steer` 都没发生**。截断的流没有 finish chunk，harness 的 `assembler.finish` 把「没有 finish」默认为 `{kind:'stop'}`，`agent-loop` 因此**当成正常说完**（既不报错也不重试），从用户视角就是「无预兆、无反馈地停了」。
  - **为什么之前没被发现**：守卫自己的测试假 ctx **直接给 `agents` 属性**，声明与否都能过；且**另一条时序是好的**——判别实验证实，Agent 在守卫装载**之后**才创建时，`agent/created` 映射表正常兜住（原代码 `cancels=1, steers=1`）。所以故障只在「先建 Agent、后装守卫」这个窗口出现，正是插件一旦重载就必然落入的那一个。
  - **改法（`reasoning-collapse-guard/index.ts`，一处修复全线路受益）**：读注册表改为**先走 `ctx.get('agents')`**（直读服务存储，无需 `inject` 声明，因此不受时序影响），属性读取保留为回退，另加服务形状校验 `asRegistry`。**没有采用给 `inject` 加 `agents`**——那会让插件在**不提供该服务**的宿主上永不激活（本仓库明令「旧代际是要求而非回退」），而 `ctx.get` 在服务缺失时返回 `undefined`，由属性回退与 `agent/created` 映射表兜住，两个方向都不牺牲。
  - **验证**：`npx tsc -b --force` 与测试树 tsc 均 0 错误；全量 **226 passed | 1 skipped（227 文件）、3745 passed | 7 skipped、0 failed**。新增 `test/reasoning-collapse-guard-registry.test.ts` 以**真实 Cordis 边界**建模（`agents` 属性按 Cordis 语义抛错、`ctx.get` 作答）：断言熔断同时**真的 cancel + steer 各一次**。**承重已双向检查（负对照）**：在「先建 Agent、后装守卫」时序下，还原 `ctx.get` 那一路立刻复现 `cancels=0, steers=0` 并使新用例失败；恢复后重新全绿。
  - **附（两处经实测否证的判断，故未改动）**：① 社区 PR 称 `z.union([z.object({}), z.const(false)])` 会 strip 掉 `maxBreaksPerTurn`/`cooldownMs`；以本机 schemastery 3.18.4 实测这些键**被完整保留**（`{"maxBreaksPerTurn":5,"cooldownMs":1000}`），`Config` 无需改动。② 曾怀疑 `preparedCall.stream()` 会绕过 `llm/stream` 瀑布使守卫失位；实测 `prepareCall.stream` 内部同样走该瀑布，**不成立**。
  - **未解决的**：用户报告 MiniMax 静默、而同期另一条线路的 deepseek 能正常 steer，本机全部可读会话存档（8 个）中**未出现任何守卫熔断痕迹**（`interrupted` 与续写 notice 均为 0），因此该差异**尚无证据定性**；本次修的是「时序窗口下熔断不留续写且完全静默」这条已复现的缺陷，不等同于已解释该差异。

## 0.24.4 - 2026-10-15
- **[Kimi Code] 额度倍率与缓存时长档位写进设置页说明：倍率此前只在官方英文 description 里隐含提及，缓存档位说明则完全没给选择依据**
  - **现象**：模型能力表里 `k3` 的说明是官方表格的英文原文，倍率只隐含在 "consumes about twice the quota of k3-256k" 一句里；`kimi-for-coding-highspeed` 的 3× 与 `kimi-for-coding` 的 1× 则一个字都没有。官方模型表实际声明的是 k3 = 2×、k3-256k = 1×、kimi-for-coding = 1×、highspeed = 3×，而**设置页从头到尾没有出现过这组数字**。缓存时长那一栏只说了「1h 写入更贵」，没给任何选择依据——用户无从判断该选哪个档。
  - **改法（结构化接入，非改文案）**：`KimiCodeModelOption` 新增 `quotaMultiplier: number | null`，由 `buildModelOptions` 从**静态注册表**填充（实时目录不发布倍率，因此是唯一来源），能力表「说明」列首行渲染为「额度倍率 2x」并进入悬停 facts。**注册表没有该 id 时填 `null` 而不是默认 1×** —— 把未知模型显示成 1× 会在一个专门用来说明「谁更费额度」的页面上低报一个 2×/3× 模型。顺带复用了一直定义却全项目无人使用的 `quotaCost` 文案键（与 `speedRegular`/`speedHighspeed` 同批预留）。
  - **缓存说明改写**：`cacheTtlHint`（中英双份）补齐两点——1h 写入**约为 5m 的两倍价**、留空时**实测有效期约 5–30 分钟**，并给出判据：回合间隔通常短于约 30 分钟就留空或选 5 分钟，调度／等子代理这类长空闲会话选 1 小时。
  - **验证**：`npm run typecheck` 与 `npm run build` 均 0 错误；全量 **225 passed | 1 skipped（226 文件）、3743 passed | 7 skipped、0 failed**（基线 3739，新增 4 例：倍率渲染、悬停 facts、未知 id 不渲染、DTO 四模型逐值 + 未知 id 为 null）。**承重已双向检查**：把 `client.ts` 的填充单独还原为硬编码 `1`，2 条新用例立刻失败（`expected { k3: 1, … } to deeply equal { k3: 2, … }`）。

## 0.24.3 - 2026-10-15
- **[Linux 凭据存储] 账号池撞上 secret-tool 的 8192 字节 stdin 上限：第 3 个账号添加后凭据写入成功、池写入失败，账号在 UI 闪现后消失（issue #54）**
  - **现象**：Linux（gnome-keyring）下添加第 3 个账号后账号区闪现即消失——凭据条目（7934B）惊险通过，但池条目（约 8960B）≥ 8192 被 `SecretServiceCredentialStore.save` 拒绝，`status.accounts`（池）永远少一个。该上限对齐的是 libsecret `secret-tool` 的 stdin 固定缓冲（超限静默截断仍 exit 0），且对**所有线路**（antigravity / claude / command-code / glm-coding-plan / kimi-code / minimax-code / ollama / step-code 的池与凭据调用点）一视同仁，账号一多都会撞。
  - **改法（`credential-store-secret-service.ts`，一处修复全线路受益）**：载荷 ≥ 8192 字节时改为**分片存储**——UTF-8 载荷 base64 后按 7000 字符切片写入独立 shard 条目（account 属性为 `<account>#<gen>#<i>`，Secret Service 属性精确匹配所以互不串扰），主条目最后写入作为**提交点**，内容为信封 `{ __dshChunked: { gen, chunks, bytes } }`；读取时按信封重组并校验解码字节数，损坏即报 `payload is too large` 同款 invalid 错误而非静默截断。小于上限的载荷保持单条目原格式，存量数据零迁移。shard 用随机代际（gen）标签：中断的 save 不触碰旧信封与旧分片，新代际要么整体提交要么回滚清理；提交成功后清理上一代分片（含分片→单条目的收缩场景）。`clear()` 改为先 lookup 探测：既拿到待清理的分片代际，也绕开 Ubuntu libsecret-tools 0.20.4 对不存在条目 `clear` 段错误的坑。分片数上限 128（约 650 KiB）防畸形信封。
  - **验证**：`npm run typecheck` 0 错误；全量 **225 passed | 1 skipped（226 文件）、3739 passed | 7 skipped、0 failed**。新增/更新 12 条 store 用例：分片往返（断言每片 stdin < 8192、重组后逐字节等于原载荷、载荷不出现在命令行参数）、缺失/篡改分片报 invalid、畸形信封拒绝、换代清理、收缩清理、clear 连带清分片、shard 写失败时主条目零触碰。launch 计数测试同步更新（save 多一次探测启动，这是分代清理的信息来源）。

## 0.24.2 - 2026-10-14
- **[三条登录线路] 回调端口探测窗口按「100 端口一块」的否证前提定宽，导致整段保留区把探测窗口吃穿：Windows 实测连续 277 个端口不可用，而窗口只有 128（command-code 只有 10）**
  - **现象**：本机全量 `npx vitest run` 稳定复现 **7 failed / 3711 passed**，全部集中在 `test/antigravity-callback-port.test.ts`（5 条）与 `test/login-open-browser-seams.test.ts`（2 条），报 `No usable local port for the Antigravity sign-in callback (tried 128 ports from 51121 on localhost)`，另有一条直接 `listen EACCES: permission denied ::1:51121`。
  - **根因（实测否证既有注释）**：`port-constants.ts` 写着「Windows 排除区最多 100 端口一块，128 覆盖任何一块」——本机实测从默认端口 51121 起**连续 277 个端口不可用**（51121-51397，`netsh` 表印证），窗口在排除区内部就耗尽，必然抛错。除静态表外还有一批**散落的单端口 EACCES**（51512/51580/51620/51840…）根本不在 `netsh` 表里，属 Hyper-V/HNS 动态保留，且会在**百毫秒尺度上出现与释放**。三个取值（`antigravity` 128、`claude` 128、`command-code` **10**）建立在同一个被否定之前提上。
  - **失效形态三条各不相同**：`antigravity` 抛错、`claude` 返回 `null` → `beginLogin` 把用户**静默推进手动粘贴流程**（机器上明明有数百个空闲端口就在保留区后面）、`command-code` 抛错且**没有手动流程可退**，窄窗口等于登录直接死掉。
  - **改法**：三条线路的窗口统一为 **1024**（≈实测最宽区的 3.7 倍；终点 52144 / 54716 / 6983 均远低于 65535，command-code 另有断言确保不越入 49152+ 的 OS 动态端口区）并重写被否证的注释，把 277 宽实测、失效形态与 ~0.35ms/次探测的最坏代价一并记入。`resolveCallbackPort` / `findAvailablePort` 各补一个**可选**注入式 `probe` seam（`claude` 本就已有同形参数），使「窗口契约」与「机器事实」解耦；生产默认值仍是真绑定，调用点逐字未变。`claude` 的 `probed.length <= CALLBACK_PORT_ATTEMPTS` 收紧为 `===`，`command-code` 测试里硬编码的 `5959 + 10` 改为常量推导（两侧区间断言保留，上界仍被断言）。
  - **command-code 的 10 为什么加宽（而非保持）**：「matches the official CLI」约束的是**起点**（5959 保留且仍先试，有测试钉死字面量），不是宽度；端口经 callback URL 交给 studio，5960+ 本就是「非 CLI 端口」，加宽不引入新的端口类别；决定性是失败形态——这条线路没有手动流程可退，窗口耗尽即登录失败。
  - **测试为什么不碰真实 socket**：曾出现「用真实 socket 拼一段连续占用区」的写法在同一棵树上**时过时不过**（40 轮 3 轮失败，且 3 次全部停在 build 期就是 EACCES 的端口上，自持有端口一次都没变）——动态保留区会在测试运行途中解禁。新用例因此**全部注入 probe**，零真实 socket、零 skip，与机器排布无关。
  - **验证**：`npm run typecheck` 0 错误；全量 **225 passed | 1 skipped（226 文件）、3732 passed | 7 skipped、0 failed**（基线 7 failed）；承重文件连跑 20 次全绿；`login-open-browser-seams.test.ts` **未改测试**，靠生产修复自然通过且真的走到了 abort 分支。承重已双向检查：常量单独还原为 128/10 时 5 条立刻失败（`expected 128 to be greater than 277`、`expected null to be 53969`、`expected 'manual' to be 'loopback'`、`No free local port … (tried 10 ports from 5959)`）。
- **[Kimi Code] 上游瞬时过载不再被当成账号限流：一次 `The engine is currently overloaded` 曾把唯一账号冷却 15 分钟，重试期间连一次网络请求都发不出去**
  - **现象**：现场会话 `session-70d30e6b`（2026-10-14 20:29）一个回合以 `全部 1 个 Kimi Code 账号均处于配额限制或冷却中 (429)。最短预计在 15 分钟后解除冷却。` 失败。账号登录正常、订阅正常、额度正常，用户点一次「继续」后自行恢复。三次重试的间隔为 3.2s / 6.1s，**等于纯退避时间、零网络耗时**——请求根本没发出去。
  - **根因（两处叠加）**：① `classifyKimiFailure` 只在正文命中 `exceeded_current_quota_error` / `insufficient balance` 等额度文案时才判为额度类，`The engine is currently overloaded, please try again later.` 一条都不匹配，于是落进 429 兜底分支得到 `RATE_LIMIT`；② adapter 的 HTTP 分支与 in-band 分支的冷却判据都是**裸状态码 `response.status === 429`**，与错误码无关，所以分类改对也拦不住冷却。过载因此被写进 `cooldownUntil`（无 `Retry-After` 时套用 `POOL_COOLDOWN_MS = 15 分钟`）并**落盘**，号池随即用 `isEligible` 把唯一账号判掉，`allUnavailableError` 拼出上面那句话。单账号号池没有第二个账号可轮转 = 一次过载直接锁死整条线路。
  - **这与全仓约定相悖**：`glm-coding-plan/mapper-openai.ts` 早已把 `OVERLOADED` 映射为非账号级的 `SERVER`，注释写明「把过载混进 RATE_LIMIT 会让号池按限流去冷却账号，而过载根本不是某个账号的错」；`claude` 线同样按 kind 分类、不冷却过载。本线路缺这道区分是偏离，不是取舍。
  - **改法**：新增 `UPSTREAM_OVERLOAD_PATTERNS` 按**正文**识别过载（`engine is (currently )?overloaded` / `upstream model provider is temporarily unavailable` 等，刻意保留限定语，避免吞掉将来可能出现的「本账号请求量过载」类真限流），`KimiFailureClassification` 新增 `upstreamOverload` 字段把「归属」显式带出来——`code` 只有一个、说不了「可重试」与「不属于任何账号」这两件事，`accountScoped` 只回答「能不能换号」而不回答「要不要冷却」。过载返回 `SERVER`（仍在 `retryableCodes` 内，退避重试行为不变；用 `RATE_LIMIT` 会让 UI 读出「你的账号被限流了」这个错误结论）；HTTP 分支与 in-band 分支**都**加 `!failure.upstreamOverload` 排除，两条路行为一致。
  - **验证**：`npm run typecheck` 0 错误；`test/kimi-code-adapter.test.ts` 41 例 + `test/kimi-code-account-pool.test.ts` 22 例共 63 例全绿；全量 **3732 passed | 7 skipped、0 failed**。承重已双向检查：把 `adapter.ts` 单独还原后，3 条新用例立刻失败（`expected 'RATE_LIMIT' to be 'SERVER'` 等，含「账号留在轮转里且真的重发了请求」「in-band 与 HTTP 结论一致」两条端到端断言）。

## 0.24.1 - 2026-10-14
- **[调度模式 & 子代理授权守卫] 插件端机制级修复模型调用 `list_subagent_models` 后仍疯狂翻找本地文件定义的问题，并全面优化预设提示词（现场会话 `session-01724ca8`）**
  - **现象**：主模型在启动阶段已调用 `list_subagent_models`，但因无参调用 `list_subagent_models({})` 只返回 provider 摘要，或看到上游工具描述写着 `"Catalog membership is advisory"` / `"Child LLM selection is optional..."`，不敢直接采信返回值，紧接着连续 9 个回合在工作区 grep `subagentModelAuthorization`、读取源码、递归扫描 `~/.dsh`（触发 120s 命令超时）并翻看 `settings.json` / `cordis.patch.yml` 以寻找「真正的允许清单定义」。
  - **插件端机制级修复（`src/host/subagent-model-authorization.ts`，零修改上游 DSH）**：
    1. **`tools/post-execute` 输出增强（`enrichListSubagentModelsOutput`）**：当会话开启子代理模型授权守卫且允许清单生效时，拦截成功的 `list_subagent_models` 调用（含 PTC `run_code` 内调用），在原始输出末尾直接附上本会话全部已授权的 `{ provider, model }` 拆解对（`- <provider>/<model> -> provider: "<provider>", model: "<model>"`），使模型哪怕只调一次无参 `list_subagent_models({})` 也能一步拿到完整授权路由与精确传参字段。
    2. **`system-prompt/assemble` 工具描述原位重写（`rewriteAuthorizedPromptAssembly`）**：当会话受允许清单管控时，在系统提示组装阶段原位改写 PTC 模式的 `tools:sdk` section 与 Native 模式的 `assembly.tools` 中 `list_subagent_models` 的 `"Catalog membership is advisory..."` 及 `subagent` 的 `"Child LLM selection is optional..."` 误导描述，直接替换为本会话的强制显式选模型要求与已授权路由清单，从源头消除工具 schema 与守卫规则的冲突。
  - **预设提示词全面优化并统一为英文（`src/host/agent-preset.ts` 与 `presets/dispatch/agent.cordis.yml` 逐字节同步）**：
    1. **全英文统一与执行主线对齐**：将 `persona.config.prefix` 与 `plan-mode.config.section` 统一为高信噪比英文指令（与 DSH 工具签名及运行时系统提示词语言保持一致）；在顶部新增 `[Execution Pipeline]` 速查流水线，并将 `## R0.5 · Compatibility Gate` 调整至 `## R0 · Complexity Triage` 之前，使阅读顺序与实际执行顺序完全一致。
    2. **消除 `G4` 与 `R2` 的张力**：在 `R-G` 的 `G4` 中明确补注本会话允许的子代理模型路由由 `list_subagent_models` 直接提供而非仓库文件，防止模型把「查仓库事实」泛化到搜本地允许清单。
    3. **重写 `R2 · Model Routing`**：明确允许清单的唯一真源是 `list_subagent_models`（无参调用末尾已直接附上完整 `provider/model` 拆解清单），直接采信其输出而无需去翻本地配置文件或工作区代码交叉核对（避免硬性禁读文件影响正常的配置/源码任务），移除诱发 grep 的内部符号名 `subagentModelAuthorization`，并新增 Anti-Pattern 第 16 条。
    4. **精简重写 `plan-mode.config.section`**：消除了原本与 `R-G` 大段重复的冗余段落，收敛为与 `R0 / R-G / R2` 紧密衔接的英文四段式规则（`[Plan Mode]`、`[Read-Only Exploration & Clarification Interview]`、`[Plan Completeness]`、`[Plan Approval]`），并在只读探查段同步指明直接使用 `list_subagent_models` 返回的路由。

## 0.24.0 - 2026-10-14
- **[Antigravity] 新增 Gemini 4 Argon（`gemini-4-argon`）并同步官方 2.23.0 客户端版本标识（2026-10-14 线上实测）**
  - **版本门控（User-Agent）**：实测确认 `/v1internal:fetchAvailableModels` 对 `User-Agent` 版本存在门控——旧 `2.8.0` (`cl=963137146`) 仅下发 26 个模型且默认模型停留在 `gemini-3.8-flash-high`；升级为官方最新客户端 `2.23.0` (`cl=998057262`) 后服务端下发 29 个模型（新增 `gemini-4-argon-low` / `-medium` / `-high`），并将 `defaultAgentModelId` 切至 `gemini-4-argon-medium`。同步更新 `DEFAULT_ANTIGRAVITY_VERSION = '2.23.0'` 与 `DEFAULT_ANTIGRAVITY_CL = '998057262'`。
  - **模型与路由**：在可选目录首位新增 `gemini-4-argon`（`Gemini 4 Argon`，上下文 `1048576`，最大输出 `65536`，支持文本与图片输入及 `low` / `medium` / `high` 三档思考）；线上实测不存在裸 `gemini-4-argon` 或 `gemini-4-argon-tiered`（均返回 404），路由按档位映射至 `gemini-4-argon-low` / `gemini-4-argon-medium` / `gemini-4-argon-high`（默认 `gemini-4-argon-medium`，`off` 走 `gemini-4-argon-low` 并在 `thinkingConfig` 中设 `includeThoughts: false`）。
  - **思考配置**：`mapper.ts` 的 `isGemini3` 扩展为 `isGemini3Or4`（`/^gemini-[34][.-]/`），覆盖 Gemini 4 系列运行时。
- **[调度模式] 与 Agent Teams 改为刻意互斥：检测到就停，不再「换一套词汇接着干」（现场问题：开了智能体团队后这套调度就不好使）**
  - **现象**：组合了 `@deepseek-ai/dsh-experimental-agent-team-profile` 的部署里，调度模式「派得出去、回访不了」——`list_agents` 看不到 `subagent` 的孩子，`send_message` 只认成员名，`interrupt_agent` 同理。复审、返工、追问三条通道同时失灵。
  - **根因（两层）**：① **时机**——`TeamRoster.tryMembership` 对任何「无 `parentSession`、且不是 subagent descriptor」的 Agent 直接判为 `lead`，不需要先有 teammate，于是 team 工具从会话第一轮就装在 Lead 上，顶替掉内置的 `send_message`/`list_agents`/`interrupt_agent`——**还没派发就已经失去协调工具**。② **组合非法**——team 的 scoped 注册与内置同名工具按「近的层遮蔽远的层」解析，而 `dispatch` 正是那组旧定义的持有者（0.1.7+ 由本插件在运行时注册里挂载四行，preset 每一代独立 `createScope`，与宿主组合里被 patch 置 `disabled` 的那四行不是同一批实例）。上游文档对此写得很直接：`tool-agent-team`「当同名的旧全局 subagent 工具必须继续可用时，请不要选择……想同时使用两者的组合必须禁用旧定义」。
  - **原设计为什么不够**：R0.5 原本做的是「侦测协作模式 → 按模式换协调词汇」（原 R-T）。它在有 teammate 时让模型改用成员词汇继续编排，但遮蔽由 scope 链决定、persona 改不回注册表，于是「适配」只能改行为、改不了「哪些工具被顶替」这个事实。更糟的是它把失败**藏**起来了：roster 里查不到孩子 ≠ 孩子没了，模型会误判成子代理丢失并重复派发。第三，teammate 结构上拿不到 per-task 路由（`SpawnTeammateRequest` 无 model 字段，构造 `startContinuable` 时整段省略 `agentOptions`），组队等于自愿放弃 R2。
  - **改法**：persona 的 R0.5 由「协作模式侦测」改写为**兼容性闸门**（每个新会话判一次，早于 R0 分诊）：两个 team 工具都不存在 → 写一行「编排可用：subagent」后照常编排；任一存在 → 本会话**不可编排**，按顺序只做三件：一句话说明不兼容 → 一次 `ask_user_question` 给出三条出路（关掉 bundle 重启并新建会话 / 换 preset / 本次直接做）→ 用户答复前不分诊、不规划、不派发、不动文件。**原 R-T 整段删除**，teammate 词汇（`team_task_*`、`target: <成员名>`、`wait_agent()`）在两份 persona 里不再出现；R8 的 teammate 专属条款与反模式 11/12 一并重写为「停在闸门处把选择交给用户」。
  - **边界不变的部分**：模型路由守卫不动。`spawn_teammate` 仍是 `subagentModelInheritTools` 的 inherit 成员（成员一律继承 Lead 路由，守卫校验它实际继承到的那条）；README 新增一条建议——用调度模式时可把它从该列表去掉，误用即硬拒。插件默认值不改，因为那是全局设置、会波及不用调度模式的会话。
  - **解除互斥的上游条件（尚未落地）**：① `agent-team/src/roster.ts` 构造 `startContinuable` 的 request 处补上 `agentOptions`，给 `SpawnTeammateRequest` 与工具 schema 加路由字段、创建前接 `assertAllowedModelSelection`；② 把 team 工具的安装条件从「是 team 成员」收紧为「**有 teammate**」——后者能直接消掉「Lead 第一轮就被顶替」。只做 ① 不够。
  - **验证**：`npm run typecheck` 0 错误；`test/agent-preset.test.ts` 29 例全绿（新增「检测到不兼容就停、不适配」的用例，同时断言两份副本里 R-T / `team_task_*` / `wait_agent()` / 「说明你是子代理或 teammate」等降级措辞**一个都不剩**）；全量 `npm test` **223 passed | 1 skipped（224 文件）、3706 passed | 7 skipped | 1 failed**——唯一失败是 `test/claude-oauth.test.ts` 的「占用端口时报告真实绑定的那个端口」，单跑该文件 43/43 通过。本轮三次全量里出现过两个**不同**的环境敏感用例偶发（本次是端口占用，上一轮是 `antigravity-token-store` 的真实 DPAPI 写入），二者都只依赖真实 OS 资源、与本次 diff 无交集；此前一次全量基线为 3708 passed | 0 failed，差的 2 例来自被合并掉的 teammate 词汇用例。
- **[调度模式] 新增规则段 R-W「回合边界」，一次修掉三处现场问题：占位长命令等待、目标续跑打断等待、需要拍板时用文字停下**
  - **问题 1（等待 = 自己造一个）**：派出子代理后，模型会去跑一条长时间命令挂着等（`sleep`、轮询、`watch`）。子代理完成的通知本来就是自带的，这条命令换回来的信息量是零，却实打实烧掉上下文与预算，还把用户晾在一段沉默里。
  - **问题 2（目标把等待从中间劈开）**：部分模型在任务开头主动创建目标。目标一旦激活，DSH 会自动续跑把主代理叫醒，而子代理何时返回不由它控制——于是主代理在半路被续跑打断，重新分诊、重新检查「还差什么」，一次干净的等待被拆成两段，附带每次续跑都要重载整段历史。
  - **问题 3（该问的不问，该停的用文字停）**：收到子代理全部内容后需要用户决策时，模型用一段文字结尾就停下，等用户自己把那段话翻译成一次输入。提问本是代理的工具，不该转嫁给用户。
  - **修法**：新增编号规则段 `R-W · 回合边界（等待 / 目标 / 提问）`，三件事放在一起是因为它们都落在回合边界上。① 等待：默认结束本轮回复、一个工具都不调，由完成通知唤醒；禁止 `sleep`/轮询/`watch` 等占位长命令；确实被阻塞时才用 `job_output({ wait: true })` 有界地等一次（teammate 模式对应 `wait_agent()`），并在停下前说清「派出去了谁、在等什么、拿到证据要做什么」。② 目标：除非用户明确要求，不调用 `create_goal` / `/goal`，任务清单一律落 `todo_write`（R7 同步改了措辞）。③ 提问：一切「我停在这里是因为缺一个决定」的停点都用 `ask_user_question` 递出去，含选项、推荐答案与自定义输入口子；例外只有 plan mode 的计划审批（走 `exit_plan_mode`）与任务完成后的收尾。
  - **交叉引用**：反模式列表新增第 13–15 条，逐条对应上面三件事；`R-G` 的 G3 补一句「同一条要求覆盖访谈之外的每一个停点」；【角色识别】把 `R-W` 列入面向调度者、对子代理/teammate 不生效的规则清单。
  - **两份副本**：persona 在 `src/host/agent-preset.ts`（0.1.7+ 运行时注册的声明）与 `presets/dispatch/agent.cordis.yml`（0.1.6 及以前的文件同步）里各存一份，`test/agent-preset.test.ts` 逐字节校验二者一致，因此本次两处同步修改；测试新增 1 例（30 例），文档同步更新 `presets/dispatch/README.md` 与根 `README.md`。
  - **验证**：`npm run typecheck` 0 错误；`npm test` **223 passed | 1 skipped（224 文件）、3708 passed | 7 skipped | 0 failed**；`test/agent-preset.test.ts` 由 29 例增至 30 例（新增 1 例断言 R-W 的三条规则与反模式 13–15）。首次全量运行时 `test/antigravity-token-store.test.ts` 的真实 DPAPI 用例在并行下失败 1 次，单跑该文件（8/8）与第二次全量均全绿，属既有的偶发；本次 diff 只涉及 preset 文本、文档与该一个测试文件，与凭据存储无交集。
- **[Antigravity] 模型目录与路由对齐线上 `fetchAvailableModels`（2026-10-12 快照）**
  - **目录**：删除已下线的 Claude Opus 4.6 / Sonnet 4.6（目录里 Claude 只剩 5.5）；Gemini 3.7 Flash 改用目录中真实存在的 `-low/-medium/-high`，不再走未列出的 `gemini-3.7-flash-tiered`；修正 Gemini 3.5 Flash 错位一档（官方 “(Low)” 是 `extra-low`，选 low 原先拿到的是 Medium）；新增 Gemini 3.5 Flash Lite、Gemini 3.1 Flash Lite；目录过滤掉 `tab_*` 编辑器补全模型。
  - **生图模型下架**：`gemini-3.1-flash-image` 的产出是图片，而 Harness 只接受纯文本的助手输出（dsh-llm `ImageBlock` 注释），聊天线路只能丢掉图片；应改为图片生成工具承载。
  - **不再静默跨模型降级**：每次请求只发用户所选模型对应的一个运行时 ID。原先 404/429 会悄悄换到 `off` 档或别的模型（3.8 → 3.7 → 3.6、3.1 Pro High → Low），用户拿到的并不是自己选的模型。
  - **429 按配额族冷却**：Gemini 与 “Claude and GPT” 是分开计量的配额，一族耗尽不再让该账号另一族一起停用 15 分钟；冷却时长优先读 Google 错误体里的 `quotaResetTimeStamp` / `quotaResetDelay` / `RetryInfo.retryDelay`，最后才用 `Retry-After`。
  - **Gemini 2.5 思考预算按模型收敛**：Flash/Lite 上限 24576（原先 high 发 32768），Pro 下限 128 且不能关闭。
  - **异常结束原因不再当作正常结束**：`SAFETY`、`RECITATION`、`PROHIBITED_CONTENT`、`MALFORMED_FUNCTION_CALL` 等，以及 `promptFeedback.blockReason`（提示被拦截），都改为 error finish 并附上上游 `finishMessage`；原先会以空回复结束本轮。
- **[Antigravity] 新增生图工具 `antigravity_image_generate`（同 Codex 生图工具的形态）**
  - 走已登录的 Antigravity 账号池调用 `gemini-3.1-flash-image`，参数 `prompt`（必填）与可选 `aspectRatio`；返回图片存为附件、渲染为图片块，嵌套调用时以 notice 注入下一轮请求。客户端复用 Codex 的生图卡片。
  - 计入 Gemini 配额族：429 只冷却该账号的 Gemini 配额并换下一个账号；Antigravity 线路关闭时工具拒绝执行。
  - 返回图片在入库前校验媒体类型白名单、base64、大小上限与文件头魔数，`thought: true` 的草稿图被跳过；无图时把 `finishReason` 与模型文字一并报出。
- **[Antigravity] Claude 工具调用使用 `VALIDATED` 模式**：带工具且未显式指定 `toolChoice`（或为 `auto`）的 Claude 请求发送 `functionCallingConfig.mode: VALIDATED`，显式 none/any 不变；Gemini 不受影响。若服务端以 400 拒绝该模式，同一模型去掉 `toolConfig` 重试一次，并在本进程内不再发送（协议回退，不换模型）。
- **[Antigravity] 上下文/输出上限改为优先读 `fetchAvailableModels`**：目录条目解析 `maxTokens`（或 `inputTokenLimit`）与 `maxOutputTokens`（或 `outputTokenLimit`），兼容 int64 字符串；一个可选模型对应多个运行时 ID 时取最小值，目录缺失时回落内置表；用户覆盖值仍然优先，设置页「默认上下文」随之一致。
  - **诚实声明**：生图请求的 `requestType: 'image_gen'`、Claude 对 `VALIDATED` 的接受情况、目录上限字段名，均来自社区客户端与公开文档，**没有**用真实账号抓包或实测；三处都留了回退（生图失败如实报错、VALIDATED 被拒自动回退、字段缺失回落内置表）。

## 0.23.0 - 2026-10-13
- **[Ollama] 思考档位从「猜白名单」改为「读模型自己声明的事实」，并接通设置页的默认档位（用户报障：ollama 线路缺少模型思考档位选择器）**
  - **问题（三层各缺一环，不是 UI 漏做）**：本插件其余每条线路都在 `adapter.resolveModel()` 里返回 `reasoning: { efforts, defaultEffort }`，Harness 的模型选择器只在拿到它时才渲染档位下拉——Ollama 是唯一不返回的线路，所以下拉根本不出现。而 Harness 侧的行为不是「静默忽略」而是硬拒绝：`resolveCallWithInfo` 在 `reasoning === undefined` 且调用方传了 `reasoningEffort` 时抛 `UNSUPPORTED_REASONING_EFFORT`。同时设置页的 `defaultReasoningEffort` 是一个**写进去就没人读的死字段**——`token-store.ts` 读写完备，但 `/settings` 路由只处理 `enabled`，卡片没有下拉，`OllamaWebStatus` 里也没有这个字段。
  - **第一处：档位阶梯改为由模型元数据驱动**。`POST /api/show` 返回的顶层 `thinking: { values, default }` 是该模型**唯一一处**自述其 `think` 接受值的来源（官方 thinking.mdx 逐字）。新增 `fetchModelThinking()` 读取它，`reasoningEffortsForModel()` 据此构建阶梯；原有的 `gpt-oss` / `deepseek-r1` / `qwq` / `qwen3` 四个前缀白名单**降级为回退**——只在元数据读不到时使用，无 `declared` 时行为逐字不变。于是白名单之外的家族（如 `glm-4.6:cloud` 若声明 `['low','high']`）也能拿到自己的正确阶梯。
  - **第二处（本轮最关键的缺陷，验收阶段抓出并退回返工）**：档位集合与 wire 取值曾由**两张不同的表**产生——集合走 `reasoningEffortsForModel`，取值走 `thinkForModel`——于是对声明 `values: [true]` 的模型（支持思考、**不允许关闭**），集合仍无条件给出「关闭思考」位置，选中后发出 `reasoning_effort: 'none'`，而官方文档明写 `"none"` 请求 `false`：**等于对一个明确声明不接受 `false` 的模型发了 `false`**。同源漏洞是混合声明 `['low','high',false]` 被判成 `levels` 后 `false` 被字符串分支静默丢弃，该位置**选了什么也不发**。修法不是加特例，而是让正反两向由**同一张表** `{ value, id, name }` 导出：`true` → 开启思考、`false` → 关闭思考、字符串原样保留拼写与声明顺序。`values:[true]` 因此不再提供关闭位，`['low','high',false]` 则三项齐全且各自发出正确的 wire 值。
  - **第三处：接通设置页默认档位**。`OllamaWebStatus` 增加 `defaultReasoningEffort`，`/settings` 与 `/models` 两个分支接受并校验它（只收 `null` 或四档词表，越界返回 400；校验前置到写入之前，避免带多个字段的请求被半应用），客户端新增 `setDefaultReasoningEffort()` 与一个下拉框，`null` 是「不指定」这一可撤销的真实取值而非缺省。
  - **降级纪律**：探测的每一种失败形态（无凭据 / 网络错 / 401 / 500 / 代理 HTML / 结构不符 / 空 values）都返回 `undefined` 且**绝不抛错**——读不到元数据只是「少一个阶梯」，不能让设置页或聊天链路出错。请求侧同理：目标模型表达不出的档位**只丢档位、不丢回合**。探测按 modelId 记忆化（仅成功才缓存，并发合并为一次），且在 `requestStream` 内**惰性**发起——无条件探测会读空 `test/stream-activity-idle.test.ts` 手工喂的心跳流，该用例会变红（此约束写在 `adapter.ts` 注释里）。
  - **验证**：`npm run typecheck` 0 错误；全量 `npm test` 220 passed | 1 skipped（221 文件）、**3670 passed | 7 skipped | 0 failed**。新增 `test/ollama-thinking.test.ts`（24 例，覆盖 `[true]` 无关闭位、两种布尔声明顺序、混合声明三位置各自的 wire 值、8 种探测失败形态、记忆化与并发合并、`:cloud` 后缀命中）与路由/卡片各 7 例。既有 20 例中 19 例一字未改；1 例按新语义重新锚定（`drops an unexpressible stored level...`：原断言 `reasoning_effort === 'auto'`，那正是「把 high 强扭成 true」的旧特例，改为 `toBeUndefined()`——新值更严格，用例主张不变）。
  - **独立验证**：调度者另写一次性用例断言最强不变量——「每一个被提供的档位都能反查回一个声明过的 wire 值」，7/7 通过后删除。
  - **诚实声明**：全部证据来自官方文档与桩测，**没有**对真实 Ollama Cloud 账号实测过各模型的 `/api/show` 返回；「档位会正确出现」是由文档加 444 例桩测推出的结论，不是眼见为实。

- **[GLM（ZCode 账号）] 删除客户端签名层（Client Signing V4），并把四条外部证据补进 README 已知限制**
  - **问题**：签名层以「实现了但默认关闭 + 能力门控」的形态长期留在生产路径上——`signing.ts`、契约里的能力位、`DSH_GLM_*` 开关一应俱全，README 也照此写着「默认关、需要显式打开」。它本身是 C 级证据（社区经验 / 架构推断，无实测），按本仓库规则 C 级「不得进入默认路径」；而这一次连一份**能证明自己有用**的证据都没有。
  - **后果**：一个逆向来的签名算法（移植自 MIT 的 `zcode-signer.ts`）留在仓库里、留在能力清单里、留在环境变量表里，此后每一轮改动都要再回答一次「这个开关要不要动」。唯一有实测记录的项目做过 A/B 对照，**带签名与不带签名的响应归一化后完全一致**（都是 429/1113）；官方那个本可当作开关信号的 feature gate 端点 `/api/v1/agent/configs` **根本不校验凭据**，两类凭据拿到逐字相同的响应，答不了「签名是否启用」。README 里那句「默认关、需要显式打开」还会让读者以为存在一个可开启的官方机制。
  - **修法**：**整层删除**——生产路径上不再有任何签名接线、能力门控或环境变量入口，能力清单里的对应条目一并去掉。**没被证明的那一半照记不误**：服务端是否真会因为缺签名返回签名错误，至今从未被观察到；这不是「已验证不需要签名」，而是「从未验证过」，两者的区别不因为实现被删掉而消失。
  - **文档**：四条有外部证据的事实补进 README 的「已知限制」，逐字引用并注明来源与证据等级：① 签名层**已删除**及其依据（实测 A/B 归一化一致 + 官方 gate 不校验凭据）；② 资源包 / 充值余额与套餐额度**互不消耗**，资源包的入口是通用面 `/api/paas/v4` + 开放平台 API Key，本线路不接（官方配置页 zcode.z.ai/cn/docs/configuration 逐字）；③ 免费体验额度的**逐模型构成**（GLM-5.3 300 万 token / 日、GLM-5.3-Flash 500 万 token / 日）与**时限**（仅限 5 天、过期不再补发，官方配置页逐字）；④ 本线路**直连** `api.z.ai/api/anthropic`，而官方客户端在 fetch 层把它重写到 `/api/v1/ultra*` 托管网关（官方开源仓库逐字），因此记为观察项而非缺陷。
  - **测试**：删除 `test/glm-coding-plan-signing.test.ts`（原 514 行）；不新增用例——被删掉的是一整条能力，生产面随之消失，没有留下需要新覆盖的分支。
  - **验证：`npm run typecheck` 0 错误；全量 `npm test` 219 passed | 1 skipped（220 文件）、3632 passed | 7 skipped | 0 failed。** 改动前基线为 221 passed | 1 skipped（221 文件）、3653 passed | 7 skipped（3660）：减少的 21 例与 1 个文件正是被删掉的 `test/glm-coding-plan-signing.test.ts`（21 例 / 514 行），其余用例计数未变。

## 0.22.0 - 2026-10-12
- **[共享号池] 「全部账号不可用」不再伪造 429 与 15 分钟冷却（issue #53）**
  - **问题（伪造 429 与 15 分钟）**：共享号池的 `allUnavailableError` 不看「为什么都不可用」，一律返回 `RATE_LIMIT` + `status 429`，文案里的分钟数取自「最短冷却」；当没有任何账号在冷却时 `shortest` 是 `Infinity`，于是落到**硬编码的 `15`**。用户被告知等待一个从未开始、也永远不会结束的窗口，而唯一有效的处置（重新登录）一个字都没提。另外 `retryAfterMs` 把 `Retry-After` 封顶在 10 分钟，所以这条路径上**物理上不可能**出现 15 分钟的真实冷却。
  - **修法**：先问「池里还有没有任何凭据可用的账号」——没有则以 `AUTH` + `status 401` 报「全部 N 个账号均需要重新登录」，不再提冷却；有冷却才按 429 报告，且分钟数在**没有实测重置时刻时是 `null`**（而不是编一个数），`allUnavailableMessage` 钩子签名随之改为 `number | null`，antigravity / glm-coding-plan / step-code 三处覆写同步跟上，并新增可选的 `allAuthFailedMessage` 钩子供线路自定措辞。**刻意排除**「只是这次请求把自己能试的账号试完了」：tried-set 是重试循环的簿记，那些凭据完全可用，不能因此让用户去重新登录。
  - **测试**：号池 3 例（全部凭据失效必须报 AUTH，且文案里不得出现 `429` / `15 分钟`；试完 tried-set 仍报 RATE_LIMIT；钩子拿到的 `waitMinutes` 在没有冷却时不被调用、有真实冷却时是实测分钟数）。两处既有断言把旧行为写成了期望（`claude-account-pool` 把「全部账号凭据失效」钉成 `RATE_LIMIT`），按其真实意图（路由拒绝、且不得触发 refresh）改为 `AUTH`。
  - **变异验证**：把 `allUnavailableError` 的 AUTH 分支短路后，4 条用例（含 2 条新增）以真实的 `RATE_LIMIT` / `429` 失败。恢复后全绿。
  - **验证：`npx tsc -b --force` 0 错误；全量 `npx vitest run` 220 passed | 1 skipped（221 文件）、3653 passed | 7 skipped | 0 failed。**
- **[Step Code] 新增「Step Code（Step Plan 订阅）」线路：StepFun 国区 / 国际区订阅与开放平台 API Key 接入，含套餐额度与缓存用量卡片**
  - **能力来源**：StepFun 官方开源的 Step-Code 客户端。四个凭据 profile（`step_plan` / `step_plan_oversea` / `platform_cn` / `platform_oversea`）**与官方 `STEP_LOGIN_PROFILE_IDS` 逐字相同，一个不多一个不少**；区域（`cn` = stepfun.com，`intl` = stepfun.ai）是**凭据的属性而不是请求的属性**，由 profile 唯一决定，所以设置页不给自由输入——区域交叉的凭据会被上游直接拒绝。同一个号池里可以同时持有两区账号且互不串用。
  - **四条登录入口互不替代**：云端轮询的浏览器授权（**不开本地回调端口**，流程跑在 host 上，卡片每 2 秒轮询）、手工粘贴 Platform API Key、只读导入本机 `~/.stepcode/auth.json`（**只读，绝不改写 stepcode 的任何文件**），以及仅用于读额度的开发者中心凭据。前三条的导入**失败永不阻断**：契约把失败拆成四个 reason（没文件 / 读坏了 / 形状不认识 / 里面不是 Step 的登录态），卡片据此给出四个不同的下一步，一律回落浏览器登录或手工粘贴。
  - **能力不从模型名推断**：模型目录**完全靠运行时发现**，随包表**刻意为空**。每行的一句话描述、是否收图片、接受哪些思考档位、上下文窗口全部来自上游目录字段，拿不到证据时按兜底值显示而不是猜。档位在本地先收敛到**模型真实梯子**（`reasoning_effort_support_list`）再发出去，所以设置里列出 DSH 的完整档位词汇也不会给只认两档的模型发错档。
  - **⚠️ 额度接口是非公开接口，这是本线路唯一的合规与稳定性风险点**：先用开放平台**账号密码**换取 `Oasis-Token`，再用它读 Dashboard。上游随时可以改形状、改鉴权或直接关掉。处置是把它隔离成**一个只读、失败永不阻断**的面：额度读不出来时卡片照旧渲染，模型请求一个字节都不受影响。卡片上如实写出「非公开接口」这行字，不把尽力而为的读数包装成有 SLA 的承诺。
  - **两代套餐分别渲染，不揉成一份「看起来一样」的进度条**：老式账号只有 5 小时 / 周窗口（有已用百分比），新式账号只有 Credit 月池（总额 / 剩余的绝对量）。判定**按载荷形状**（老式窗口字段 vs `credit_buckets`）而不是只信 `plan_family`；两端都认不出来时只显示「认不出」，**一个进度条都不画**——画出来的是上游从没说过存在的东西。折算成百分比同样被拒绝：Credit 桶的分母要自己选，而新式套餐里不同桶的地位并不等价（订阅额度与充值额度不是一回事），折出来的是编的。
  - **缓存区只有 token 维度，不出现任何金额**：Step 服务端是自动前缀缓存，客户端没有「写入」这个动作，所以**写侧恒为 0 并被显式标注**（`always-zero-on-this-route`）而不是画一条永远是 0 的条；官方模型表里四个 cost 键全是 0（单价未文档化），所以整页只展示 token 与命中率，**不展示任何金额**——拿 0 当单价算出「省了 0 元」是正确但无用，拿编的费率算出「省了 N 元」是撒谎。「在请求里发送缓存参数」做成**默认关闭**的能力位，因为官方对 Step 端点默认也不发该字段。
  - **凭据边界**：api_key、`Oasis-Token` 与账号密码**一律不出现在任何 DTO 里**。手工粘贴与账号密码登录的请求体正因如此**刻意不在冻结契约里声明**（它必然带凭据，由 host 侧自行解析）；卡片只显示「有没有凭据、从哪来、大概什么时候过期、上次读它出了什么问题」，而这三条秘密只在点击提交那一刻随请求体过一趟 host，随即被清空——不写本地存储、不进 URL、不写日志，也没有任何接口能把它们读回来。
  - **接入方式（全部是追加）**：hub 描述符追加在 `ollama` 之后、输入框胶囊槽位 `step-code-quota` 取 **order 43**（接在 `glm-coding-plan-quota` 的 42 之后顺延）、新增 `dsh-step-code` 命名空间与一张自有样式表。**既有线路的卡片顺序与槽位号一个字符都没有动**——给已上线的线路重排位置没有收益，只有风险。
  - **测试**：新增 `test/step-code-ui.test.tsx`（5 例，jsdom，全程 mock fetch 且**只在本线路 `/step-code/api` 前缀下应答**，越界请求当场抛错）覆盖卡片渲染账号区 / 额度区 / 模型清单、`quota` 为 null 不崩且不画 0%、`windowed` 与 `credit` 两种额度分别渲染、缓存区不出现任何金额且写侧显式声明恒零。既有测试只**追加条目**：`client-registration` 的注入次数、胶囊注册表、`TAB_IDS`、卡片名与开关数；`hub-overview-ui` 的 summary 与卡片顺序；`client-style-ownership` 的 SHEETS 表。
  - **实机验证（本轮用真实账号补齐，分档如实列出）**：
    - **live 验证通过**：浏览器授权开流/轮询；**账号密码换 `Oasis-Token`**（`RegisterDevice` → `SignInByPassword`）；用该 token 读 `QueryStepPlanRateLimit` 与 `GetStepPlanStatus`（真实返回套餐 `Plus`、`plan_family=2`、Credit 桶总额与剩余）；模型目录字段与档位回落按实测载荷对齐。
    - **仅 mock 验收**：模型面真实对话请求、手工粘贴 Platform API Key 的完整会话、`adopt` 四种失败分支、额度卡片的渲染本身。
  - **上线后修的两处硬伤（都是「HTTP 200/401 却读不出东西」，错误措辞会把根因指向错误的字段）**：
    - **`oasis-appid` 填成了 `oasis-platform` 的值 `web`**，服务端据此查应用配置，直接 `500 app configuration is missing`。正确值是应用 id **`10300`**（响应里 `registry.appId` 会回显，可复核）。该错误当时出现在**两条**路径上（设备注册与额度读取），第一轮只修了前者、漏了后者，导致额度卡片继续报同一个错——**同一常量在多处使用时，修完必须全仓 grep 一遍**。
    - **`SignInByPassword` 的 cookie 里没带匿名 token**，服务端找不到登录会话，一律 `401 token is missing` / `token is illegal`。实测对照：cookie 带 **`access...refresh` 无空格成对形式**→ 200 并返回 token；只带 access 或只带 refresh → 401；两段之间**多一个空格** → `token is malformed: could not base64 decode header`。这三个 401 的措辞各不相同却同因，代码注释已记录完整对照表。

## 0.21.0 - 2026-10-12
- **[Ollama] 修复添加 Key 后「订阅服务」整页空白；补齐线路启停开关；「全不选」与勾选状态实时同步到模型选择器**
  - **问题 1（整页空白）**：`/ollama/api/accounts` 的 `add` 分支独自返回 `{ id }`，其余动作都返回完整 status。客户端把动作回包直接当作渲染状态，`status.models` 为 `undefined` 时渲染期 `TypeError` 把设置页整棵 React 子树打崩。修法：add 与其他动作一样回落到统一的完整 status 应答；客户端渲染路径对残缺 status 一律降级为空区块（`status?.models ?? []`），任何残缺载荷永不再崩页。
  - **问题 2（缺开关）**：总览卡片里 Ollama 是唯一没有启停开关的线路（`canToggle: false` 硬编码）。适配器其实早已读取 `enabled` 旗标，缺的只是接线：新增 `POST /ollama/api/settings { enabled }`（与其余线路同形同义），hub 描述符接上开关，总览聚合回报真实旗标而非恒 `true`。
  - **问题 3（「全不选」弹回全选）**：`enabledModelIds` 的「空数组 = 不过滤」语义使「全不选」写入 `[]` 后被读回成全选，长清单永远无法收窄。改为三态：`null` = 不过滤（全部，含日后新同步的模型）、数组 = 显式选择（`[]` = 全不选）。设置文件写入 `version: 2` 标记；旧文件的空数组只能解释为「未动过的默认」，读回 `null`，存量用户行为不变。手动勾满整张清单时客户端归一化回 `null`，「全部」继续跟随目录而非冻结在凑巧完整的那一刻。
  - **问题 4（取消勾选后选择器仍显示）**：Ollama 是唯一不在设置变更后发 `llm/adapters-updated` 的线路，模型选择器只能等别的线路碰巧发事件才刷新。`/models` 与 `/settings` 的实际写入现在都发该事件，与其余线路逐字对齐。
  - **测试**：路由层 8 例新增（add/delete 应答必须是完整 status、全不选持久化为 `[]`、`null` 恢复不过滤、version-2 前后文件各自读法、开关往返、只读不发事件）；适配器层按三态改写 3 例；客户端层 3 例（残缺动作回包不崩页、全不选后全部不勾且计数 0/2、勾满归一化为 `null`）。反向验证：撤掉客户端加固后「残缺回包」用例以原样 `TypeError: Cannot read properties of undefined (reading 'length')` 失败，恢复后全绿。
  - **验证：`npm run typecheck` 0 错误；全量 `npm test` 215 passed | 1 skipped（216 文件）、3494 passed | 7 skipped | 0 failed。**

## 0.20.0 - 2026-10-12
- **[MiniMax Code] 新增「限额重置卡」：查看可用卡与近 30 天流水，选卡确认后重置套餐限额**
  - **能力来源**：MiniMax 官方桌面端 v3.1.1（2026-10-04）起提供「限额重置」——订阅用户可在用量页查看可用重置卡与近 30 天获得/使用记录，**选择一张卡并确认后**重置对应限额。本插件复刻它，接同一组上游接口。
  - **上游事实（用真实账号实测确证，非推测）**：`GET /backend/account/reset_card/list`（可用卡）、`GET /backend/account/reset_card/flows`（流水）、`POST /backend/account/reset_card/use`（消费）。主机是插件**已在用**的 `api.minimax.cn` / `api.minimaxi.com`（即 `QUOTA_HOST_CANDIDATES`），认证是**现有**的 `Authorization: Bearer`。不需要新主机、不需要签名头、不需要新认证方式。
  - **三处踩过的坑，都写进了实现**：
    - **`flows` 必带 `create_time`**（起始毫秒，取 30 天前），否则上游返回 `2013 invalid params`。这不是可选参数，是硬要求。
    - **消费成功靠原样回传卡上的 `source_type` + `out_biz_no`，绝不自己生成 request id。** 服务端以 `out_biz_no` 去重；自造一个 id 等于递给服务端一个它没记录过的键，第二次点击就会**真的多消费一张卡**——正是本线路契约警告的那种伤害。
    - **`outcome` 必须原样透传，不能塌缩成布尔值。** 六个值里 `REPLAYED` / `LOCK_BUSY` / `RETRYABLE_FAIL` 三个的含义是「可能已消费，请用**同一张卡**确认」，界面必须据此劝用户重试同一张卡而非换卡。官方客户端也是这么处理的。
  - **幂等键不出浏览器**：`POST /reset-cards/use` 只接受 `{ cardId }`。host 侧先读一次面板，从**自己刚读到**的那份数据里查出该卡的 `source_type`/`out_biz_no` 再调上游——浏览器无法指定幂等键，也就无法消费一张它没读过的卡。同源检查照旧。
  - **不确定态不刷新列表**：`LOCK_BUSY` / `RETRYABLE_FAIL` 之后**故意不重读面板、不刷新用量**，否则会把那一行「让用户用同一张卡重试」的提示直接从屏幕上刷掉。已决的四个 outcome 才刷新。
  - **测试**：host 20 例 + 客户端 15 例，全部 mock fetch，**没有任何一次真实 `/use` 调用**。host 侧六组变异（删 `create_time`、自造 request id、不容忍 flows 失败、放行任意 outcome、只试首个主机、路由信任浏览器传来的 `out_biz_no`）各自被对应用例捕获；客户端侧四组变异（改错不确定态文案、删二次确认守卫、按钮不禁用、去掉使用后刷新）同样如期变红，恢复后全绿。
  - **复审时独立重做变异**：只把 `out_biz_no` 换成自造值（一处改动），4 个用例立刻失败——含「重试必须用同一张卡」这条安全关键用例；恢复后 20/20。
  - **验证：`npx tsc -b --force` 0 错误；`npx tsc -p test/tsconfig.json` 0 错误；全量 `npx vitest run` 215 passed | 1 skipped（216 文件）、3483 passed | 7 skipped | 0 failed。**
  - **诚实声明：没有跑过真实消费。** 全部 `/use` 路径都是 mock 验收——真实消费会消耗用户真实的重置卡，本轮刻意不做。`list`/`flows` 的响应形状是用真实账号只读实测过的。
  - **遗留项（既有问题，非本次引入）**：`QUOTA_HOST_CANDIDATES.global` 只有一个候选 `api.minimax.io`，而该主机对国区凭据返回 401。国际区账号的可用主机仍未实测——这与本线路既有的配额读取是同一个未解问题。

- **[八条线路] 空闲超时把「没有可展示内容」误判成「连接已死」，长时间思考或上游持续心跳时整轮被判 TIMEOUT**
  - **问题（issue #52）**：流式线路的空闲看门狗只对「解析器 yield 出的 `StreamChunk`」复位。Codex 线路的 `wrapStreamWithWatchdog` 包在 `parseResponsesStream()` 外面，于是两类完全正常的流量会被判成 5 分钟静默：① 上游持续发 `response.in_progress` 这类状态帧——它们走完 mapper 后**不产出任何 chunk**；② reasoning summary 超过 12000 字符展示上限被截断后继续发送摘要——`visibleReasoningDelta()` 返回空文本，且不够 768 字符的 flush 水位。同一条误判存在于其余七条自建流的线路（antigravity / claude / command-code / minimax / glm / kimi / ollama），共八条。
  - **修法：把计时判据从「展示层产出」下沉到「传输层收到数据」。** 共享 seam `wrapStreamWithWatchdog` 新增可选第二参数 `StreamActivity`（`pulse()`），内部接 `@deepseek-ai/dsh-timeout` 的 `idleWatchdog.pulse()`——它只在 `next()` 挂起期间重新计时，正是「读操作在等、字节在到」这个场景。因为 TypeScript 里参数更少的函数可以赋值给参数更多的签名，历史单参调用点继续编译通过，七条线路因此各自独立接线、互不阻塞。每条线路在**两处**上报：`reader.read()` 返回非空字节时一次，每个完整 SSE 帧一次。第二处刻意放在 `data:` 过滤**之前**，所以 `: ping` / `: keep-alive` 这类纯注释心跳（Codex 解析器原本在 `data === ''` 处整个丢掉）同样算活动。**摘要上限与展示缓冲逐字未动**：截断只影响展示，不再影响活动判定，也没有生成任何假的界面文字。
  - **Codex 线路另加可配置超时**：插件 Config 新增 `codexStreamIdleTimeoutMs`，默认仍是 300000，`min(1)` 且上限 `MAX_TIMER_DELAY_MS`——**0 不是关闭开关**，这条线是截止时间不是功能开关。该常量与 `pulse()` 在 `@deepseek-ai/dsh-timeout` 里自 0.1.2-alpha.5 起就存在（已核对该 tag 的源码），所以没有新增跨代兼容 seam。
  - **测试**：新增 5 个文件、7 条线路各一例，全部不 mock `idle-watchdog`（要观察的正是它本身不肯触发）。每条线路的用例都是同一个实验：假响应体连续发送纯注释心跳帧、撑过数倍于空闲窗口的时间且**期间不产生任何可展示 chunk**，最后正常收尾——修复后必须正常完成，修复前必然 `stream idle timeout`。另各配一条反向用例：真正一个字节都不发时仍然抛 `TIMEOUT`，证明反向用例不是空转。摘要截断那一条显式断言 block-end 的 reasoning 仍含 `Reasoning summary truncated` 且长度 < 12100，排除「靠去掉上限过关」这条路。
  - **变异验证（复审时独立重做）**：只把共享 seam 里 `pulse` 的实现置空（一处改动，不动任何线路），7 条线路的 12 条用例**全部**以真实 TIMEOUT 失败，反向静默用例仍通过；恢复后全绿。子代理另各自做过一次「注释掉本线路 `activity?.pulse()`」的变异，结论一致。
  - **验证：`npx tsc -b --force` 0 错误；`npx tsc -p test/tsconfig.json` 0 错误；全量 `npx vitest run` 213 passed | 1 skipped（214 文件）、3448 passed | 7 skipped | 0 failed。** 本轮未复现历史记录里的 Windows host 端口保留类失败。
  - **诚实声明：本轮全部为 mock SSE 验收，没有真实 ChatGPT 订阅账号参与。** 心跳形态只实测了 SSE 注释帧；「合法但被 mapper 丢弃的 `data:` 状态帧」由代码路径推断同样会 pulse（pulse 挂在每一帧上），但未单独构造该形态实测。issue 里并列出现的 `NGHTTP2_INTERNAL_ERROR` 属于 HTTP/2 传输层异常，本报告不声称本次改动能解决它。


## 0.19.1 - 2026-10-11
- **[GLM（ZCode 账号）] 账号管理一行的三个按钮排不下，第三个被挤到下一行**
  - **问题**：「账号管理（已登录 N 个账号）」与右侧按钮区共用一行（`.dsha-grouphead` 是 `justify-content:space-between`），而按钮容器带 `flex-wrap:wrap`。标题占掉宽度后，三个按钮（添加国区账号 / 添加国际区账号 / 导入本机 ZCode 登录态）里第三个必然折行。Claude 也只有两个按钮，所以这条线路是**唯一**有三个的，问题也只在它身上显形。
  - **修法：按「同类操作聚在一起」重排，而不是去调共享样式。** 两个「添加账号」留在标题行，第三个下移到下面的「登录授权」区。理由是它本来就是**另一条登录路径**——浏览器授权与读本机已有登录态是同一件事的两种做法，放在同一个区才读得出「怎么登录」；位置取状态提示之后、手工粘贴之前，既不打断「流程状态 → 结果」的阅读顺序，又与同为免浏览器路径的手工粘贴相邻。导入结果的提示一并跟着移，否则用户点了按钮却在远处看到结果。
  - **一处必要的连带改动**：登录区原先整块包在 `login !== null` 的判断里。按钮移进来后会跟着这个判断一起消失——host 一次流程状态都不报时，用户就再也点不到「导入本机 ZCode 登录态」。因此把判断收窄到只包住状态块，标题、导入按钮、导入结果、手工粘贴四样常驻。真实 host 永远会报 `login`（`routes.ts` 的 `loginStatusOf(null)` 返回 `idle`，且每次 `/status` 都带上它），所以**线上画面不变**，这个改动只是堵掉「入口会消失」这个洞。
  - **测试**：改写原先断言「三个按钮都在标题行」的那条用例——它验的正是被推翻的布局。新护栏断言标题行**恰好两个**按钮，且导入按钮落在登录区内。护栏做过变异验证：把第三个按钮塞回标题行，该用例立刻失败。另新增一条断言导入结果与按钮同区、可当场关闭。
  - **验证：`npm run typecheck` 0 错误；全量 `npm test` 208 passed | 1 skipped（209 文件）、3430 passed | 7 skipped | 0 failed。**

## 0.19.0 - 2026-10-11
- **[GLM（ZCode 账号）] 新增第九条 Provider 线路：用 ZCode 账号 OAuth 登录 GLM Coding Plan，国区与国际区两套部署各自独立**
  - **问题：GLM Coding Plan 此前只能以「粘贴 API Key」的形态接入，而公开的 OpenAI 兼容面根本不生效套餐额度。** 官方文档的 Common mistakes 段写明走通用面 `/api/paas/v4` 会变成按量计费——用户明明买了订阅，却在一条声称提供 GLM 的线路上看着余额被扣。要拿到真正吃套餐额度的端点，必须先有 Coding Plan Key，而 Key 又只能由 ZCode **账号**授权换出来。
  - **修法：新增 `glm-coding-plan` Provider，把「账号授权」接到 DSH 上。** 浏览器里由用户用自己的 ZCode 账号完成授权，插件只做两件事：按 ZCode 自己的 CLI OAuth 控制面开一次流（`POST https://zcode.z.ai/api/v1/oauth/cli/init`），再按上游给的节奏轮询（`GET .../oauth/cli/poll/{flow_id}`），两个请求共用同一个本地 `randomBytes(32)` 生成的 Bearer pollToken——它只是把一次开流与它的轮询绑在一起，**不是登录凭据**、不落盘。拿到 OAuth access_token 之后跑兑换链，换出 `{apiKeyId}.{secretKey}` 形式的 Coding Plan Key，最后只打**套餐专用**端点。凭据落盘前先用配额接口验一次活：账号没有套餐就在**登录阶段**报错，而不是等到某次对话里以一个莫名其妙的 429 暴露出来。**本线路不做 API Key 粘贴**——账号授权产出的就是同一种凭据，下游完全共用。
  - **两区不是同一个部署，连鉴权形状都不一样，这是实现里唯一容易写错的地方。** 国区：业务面 `https://bigmodel.cn`、模型面 `https://open.bigmodel.cn`，并且**跳过 `/api/auth/z/login`**——直接拿 OAuth access_token 当**裸 `Authorization`**（不加 `Bearer`）打 `/api/biz/*`。国际区：业务面与模型面同为 `https://api.z.ai`，先 `POST /api/auth/z/login` 换业务 JWT，之后 `/api/biz/*` 带 `Bearer <业务 JWT>`。推论是**业务 JWT 的自动重取（提前 120 秒 + 0~60 秒抖动防尖峰）只服务国际区**，国区连这一层都没有。同一个号池可以同时持有两区账号且互不串用。本仓库历史里那句「国区没有浏览器登录」是错的，本线路删除了它——国区**有**浏览器登录，只是入口是 `bigmodel.cn/login?appId=zcode`、参数名与国际区不同。
  - **落地方式：复活历史 `zhipu` 线路的骨架，但只取 hunk，没有整条 cherry-pick。** `7e40fce` 提供了 23 文件 / +6284 行的完整骨架（adapter / client / mapper / model-catalog / routes / token-store / account-pool / contracts + 卡片 + 测试），省掉约六千行重写。但那套代码随后被 `7eb3ee2`「Revert GLM」整个撤掉、`fb07c2e` 又用 Claude 订阅线路顶替了它的位置，所以今天的 master 上既没有那个目录，也没有它依赖的 `ZhipuSection`。`9ad8a53`（12 文件 / +1599 行）里的 `oauth.ts` 是一份**自包含**的 716 行实现，值得按 hunk 取；但它同批次的 `routes.ts` / `contracts.ts` / `types.ts` / `index.ts` / `ZhipuSection.tsx` / `locales.ts` / `styles.ts` / `test/zhipu-ui.test.tsx` **全部假定骨架仍在原处**——旧目录名 `zhipu`、旧契约形状、旧的文件级样式约定，以及旧注册点的代码上下文。整条 cherry-pick 会把已退役的装配方式一并复活，并直接覆盖 `src/index.ts` 这个八条线路共用的热点文件。**结论：自包含的实现按 hunk 取，依赖旧树形状的一律按今天的架构重写**（这也是新线路改名 `glm-coding-plan`、目录落到 `src/host/glm-coding-plan/` 的原因）。
  - **三处历史事实被官方 `zcode-builtin.json`（revision 31）纠正，纠正前的值都属于「看起来合理、但会算错账」。**
    - **输出上限**：此前是「历史转录的 docs.z.ai 通用参数表 131072」与「未验证的兜底 32768」。现按官方规则逐模型取值——GLM-5.3 家族与 GLM-5.2 是 **128000**、GLM-5-Turbo 是 **64000**，而 128000 正是**官方客户端自己在 Coding Plan 面上发的那个数**。两个来源不一致时按本仓库「取小值」的规则取 128000：高报会被网关拒（1214），低报只是提前压缩一段对话。GLM-5-Turbo 与 GLM-5.3 同代却差一倍，本身就是「输出上限不得按家族名推」的一条硬证据。
    - **`supportsImages` 全部为 `true`**：官方基础 `modelRules` 对 GLM-5.3 / GLM-5.2 / GLM-5-Turbo 写的都是 false，是两条 `modelMatch: ".*"` 的**站点规则**把本线路这两个 Coding Plan 基址（`api.z.ai/api/anthropic` 与 `open.bigmodel.cn/api/anthropic`）的 `supportsImage` 打开成 true。因此这条能力读作「**经本线路这两个端点时**收不收图」，而不是「模型本身多模态」——照抄基础规则会让四个模型全部退化成纯文本。
    - **套餐归属此前写反了**：曾断言「`GLM-5.2` / `GLM-5-Turbo` 是 Start Plan 独有，Coding Plan 请求它们会拿到 1311」。官方规则集里四个 `account:*-coding-plan` provider 启用的是**同样四个** id，而 `account:*-start-plan` 缺的才是 **`GLM-5.3`**。写反的代价是把两个确实在套餐里的模型判成未订阅，用户连试都不能试。留着这份对照是为了让复审记住一条结论：**套餐归属是账号的属性，不是模型的属性**——同一个 id 在不同 provider 规则下启用的集合是不同的，而「从模型 id 反推账号套餐」这条路是走不通的。
  - **两个协议面必须共用同一张错误判读表，第一版并没有，于是 `NO_PERMISSION` 被判成了鉴权失败。** Anthropic 面（`mapper-anthropic.ts` 的 `classifyGlmUpstreamError`）先查正文里的业务码，只在没有业务码时让状态行兜底；OpenAI 面（`mapper-openai.ts` 的 `classifyGlmOpenAiFailure`）最初**先看状态行**，而 `NO_PERMISSION`(1220) 的文档状态**就是 403**。后果不是分类难看，而是**行为错了**：号池的鉴权出口用的就是 `AUTH`，于是这个账号被送去重新登录，而重新登录根本解决不了「套餐没开这个 API」——用户看到的是「明明套餐在，却一直要重新登录」，且每次重登都必然再失败一次。现在两面按同一条规则走：**业务码说了算，状态行只在业务码不认识时兜底**（非鉴权业务码集合由冻结的错误码表直接推导，不另抄一份）。
  - **裸 429 的兜底也必须两面一致，而且默认方向不能是「重试」。** 冻结的错误码表里 429 共七条，只有两条可重试（1302 频率限制、1305 瞬时过载），其余五条全是额度类（1113 无余额 / 1308 具名窗口用尽 / 1309 套餐失效 / 1310 周月额度用尽 / 1311 模型不在套餐）。所以正文没给业务码的裸 429 **判不可重试**；`Retry-After` 仍然读取并下发（界面上「N 秒后再试」比「未知错误」有用得多），但它不改变判定。赌它是限流然后进入自动退避重试，赌错的后果是在一个已经用尽的窗口上反复失败、还多烧一次额度。号池侧的冷却另走一条：判据是**状态码 429** 而不是错误码，否则「窗口已用尽」永远走不到冷却那一步，而那恰恰是最需要冷却的场景。
  - **测试**：本线路 11 个测试文件共 **413 例**——契约 49 / OAuth 63 / Anthropic 映射 50 / OpenAI 映射 53 / adopt 41 / client（目录与配额）47 / UI 34 / adapter 21 / 签名 21 / 路由 30 / 浏览器注入口 4。另有回归：`test/client-style-ownership.test.ts` 那份手工维护的 `SHEETS` 列表补上本线路的样式表——该表的用途逐字写着「本插件注入的每一张 sheet 都带归属标记」，而这张表由 `src/client/index.tsx` 无条件安装，漏掉它就等于不再覆盖那张表；测试不依赖真实凭据或网络。
  - **验证：`npm run typecheck` 0 错误；全量 `npm test` 208 passed | 1 skipped（209 文件）、3428 passed | 7 skipped | 0 failed。**
  - **诚实声明：本线路没有实机账号，全部为 mock 验收。** 开发与验收环境不具备真实的 ZCode 账号，因此**没有任何一条上游行为经过 live 验证**。仍未验证的项已在 README「已知限制」里逐条写明：① 上游**没有 refresh_token 交换接口**，`access_token` 过期只能重新登录（业务 JWT 可自动重取，且只服务国际区）；② 客户端签名层（Client Signing V4）**默认关闭**——唯一有实测记录的 A/B 对照显示带签名与不带签名的响应完全一致（都是 429/1113），但「服务端会因缺签名而拒绝」这件事**从未被观察到**，所以这是「默认关」而不是「已验证不需要签名」；③ **国区兑换链未验证**（证据是三个社区实现的逆向实现，等级 B，三者都以国际区为主），国区配额该打 `bigmodel.cn` 还是官方文档里那句「亦可用 `open.bigmodel.cn`」同样没有实测；④ `poll_interval_sec` 的实际下发值、桌面回调中转里的握手标识是否轮换、周度 / 月度窗口长度（按词义取 7 天 / 30 天）。为此兑换链的每一个端点都做了 `DSH_GLM_*` 环境变量覆盖——上游一次变更让整条链失效时，回滚是改一个环境变量，而不是发一个版本。
  - **登录成功后卡片仍说「尚未开始登录」，而且「取消登录」出现在没有流程的时候——两处都不是显示瑕疵，是状态机在谎报。**
    - **终态被清空**：`GET /login/status` 原先在流程不再 pending 时执行 `latestLogin = null`，于是「登录成功」这个事实在**下一次读**就被丢掉，卡片拿到 `idle`，用户刚完成授权却看到「尚未开始登录」。`POST /login/manual`（手工粘贴）同样在成功后立刻清掉，现象一模一样。现在终态**保留到下一次开流或用户取消**——不给 TTL、也不做「读到一次就清」：卡片在流程结束前后会读好几次（2 秒一次的 `/login/status` 与它带出来的 `/status` 交错完成），「读一次」实际是「谁先到谁拿走」，必然漏；而 TTL 只是把同一个竞态换成另一个竞态。用用户动作当生命周期边界，没有时钟、没有后台任务，也不破坏「只有这一条 GET 推进状态机」的既有约定（新增断言：终态之后再读不会再打上游）。顺带修了同一条路由的应答形状——`/login/manual` 原先回的是登录**流程**状态，而路由表与客户端都按整份 `GlmStatusDto` 用，模型区与账号区会随即空掉。
    - **取消按钮的位置与可见性**：「取消登录」原先被放在「手工粘贴授权码」那一行里，和「提交授权码」并排。它撤销的是**这一次浏览器授权流程**，属于流程控制，放在粘贴行里既位置错、也让人以为它只影响粘贴。现在移入登录流程区，且**只在 pending 时渲染**——没有进行中的流程时根本没有可取消的东西。
    - **手工粘贴在登录完成后仍占大块版面**：它必须保留（浏览器回调被拦时这是唯一出路，这条理由成立），但改成**折叠**而不是条件渲染：pending / error 自动展开（这两个阶段它真的能生效），idle / complete 自动收起，用户随时可点开。条件渲染在 idle 时连入口都没有，而折叠保留了「一次点击就能拿到」这个出路。
    - **「尚无配额数据」是一条真 bug，不在拉取环节**：自动拉取本来就有（无快照时 `GET /status` 会 await 一次）。问题是 `quotaError` 在状态装配处被**写死成 `null`**，而配额读取的失败是以返回值呈现、不抛异常的，于是那句面向用户的原因被整个丢掉，用户分不清「上游还没给这把 Key 开配额」「这把 Key 读不了配额（免费额度账号恰恰如此）」和「根本没试过」。现在两类失败都如实下发。
  - **「没有 Coding Plan 就不能登录」是错的，会把新用户挡在门外。**
    - 原实现把「验活探不到付费套餐」当作**硬拒**。但官方文档逐字写明：新用户连接 BigModel 账号后**自动获得体验套餐**，首次使用起 5 天内每天 800 万 token；闲时任务则是订阅用户在算力富余时段**免费完成、不消耗套餐额度**。也就是说**「没有付费套餐」不等于「没有额度」**，而硬拒挡掉的恰恰是最需要免费额度的新用户。
    - 现在把「验活失败」拆成**两个业务码族**：`BAD_CREDENTIAL_REASONS`（1000/1001/1003，鉴权族）仍然失败——Key 是坏的；套餐族（1113/1220/1309/1310/1311）**放行**并标为免费体验额度；两者都判不出来时落在 `unknown`，**同样放行**。理由是代价不对称：额度耗尽时上游会回 429，那是**可恢复**的；误拒一个有效账号**不可恢复**——用户再也登不进这条线路，且无从自查。卡片如实显示当前是付费套餐还是免费体验额度，**不把免费额度伪装成付费套餐**。
    - 代价必须写明：上游若对无套餐账号也回裸 401/403 而不给业务码，那么「凭据无效」与「没有付费套餐」在响应层面**不可区分**，此时 `unknown` 放行意味着**无效凭据可能进池**，其表现是请求期 401 而非登录期报错。这一层没有实机样本，属未验证。
  - **测试会真的弹出系统浏览器，而且生产路径会开两个授权页——后者是仓库里早就修过的毛病又犯了一次。**
    - **测试泄漏**：`routes.ts` 调 `beginWebLogin` 时**根本没有 `openBrowser` 透传口**，于是缺省走平台实现 `spawn('cmd'|'open'|'xdg-open')`，跑测试时真的拉起浏览器。修法是先给装配层加一栏纯增量的可选项作为注入口，再在测试装配里统一注入空函数（一次盖住全部 12 处用例），并加 `vi.mock('node:child_process')` 的护栏断言 `spawn` 调用数为 0。护栏**先写后修**，所以泄漏是被真实复现过的（`expected [ 'cmd' ] to deeply equal []`），另有一条正向对照用例证明这条护栏不是空断言。
    - **生产双开**：卡片自己会 `window.open` 授权页，而 host 侧又会 `spawn` 一次，于是**每次登录弹出两个一模一样的页面**。这正是 `test/login-opens-browser-once.test.ts` 当初为 Claude 与 Command Code 修掉的同一个问题，GLM 又犯了一次。现在照兄弟线路的形状改成「**host 恒定不开、卡片开**」，注入口降级为可选覆盖，并把 GLM 纳入那条既有护栏。
    - **顺带收口两处同款隐患**（纯增量、生产行为零变化）：`kimi-code` 的 `/login` 分支同样没有透传 `openBrowser`，形状与 GLM 缺陷完全一样；`antigravity` 的 `loginAndSave` 则是**硬编码**开浏览器，连注入口都没有。两处都补上了注入口，并用**反向对照**测试钉住「不注入时照样 spawn」，证明生产行为未变。
  - **本轮明确不做**：全仓级 `test/setup` 兜底（对三个浏览器命令做「记而不执行 + 断言 0 次」）——它会打死三处**刻意**断言 spawn 被调用过的正向对照用例，需要先设计逃生口；且它一次影响全部 209 个测试文件，评估结论已记录，留待单独决定。
  - **本轮明确不做**：Agent 行为层映射（ZCode 的 `/mode plan|build|edit|yolo|guarded`、工具契约、`~/.zcode/AGENTS.md` 生态复用）——本轮只做线路层；也不改动 command-code 里已有的 GLM 模型行（那是它们各自上游的模型，与本线路无关），不绕过套餐限制，也不把公开 API 能力自动等同于订阅网关能力。

## 0.18.0 - 2026-10-11

- **[MiniMax Code] 额度耗尽后不换号，而且把「限流」判成了「欠费」**
  - **这条线路是唯一一条有号池却完全没有号池行为的线路。** 全包共 6 条线路（codex / claude / kimi-code / command-code / ollama / antigravity）都在非 2xx 的 429 上 `markCooldown` 并 `hasAnotherAvailableAccount(tried) → continue`；MiniMax 的 `src/host/minimax-code/` 全目录**零次** `markCooldown` 调用，`getEffectiveCredential(undefined, …)` 的 `excludeIds` 恒为空。于是某一个账号的 Token Plan 跑光之后，**后面每一个请求都继续由它来服务**——号池选它、被拒、再选它，没有任何一处在学习「它已经被拒过」。
  - **结果是用户看不到换号，只看到额度耗尽。** 冷却机制本身是好的（`isEligible` 是纯时间比较，到期自动恢复），问题只在于从不写入。
  - **识别层把普通限流判成了终局欠费。** 旧表里 `/exceeded/i` / `/quota/i` / `/balance/i` 是**裸词**，于是 `{"errorCode":1002,"errorReason":"rate_limit_exceeded"}` 这种最标准的限流信封被判成 `PROVIDER_ERROR` / `retryable:false` ——**本该由 DSH 有界退避重试的请求直接硬失败**。现在收紧为短语并补上本服务实际使用的中文措辞（余额/额度/配额 不足|耗尽|用尽、请充值、欠费、超出额度），且刻意**不**收录裸的「限制」「上限」，因为「请求超过频率限制」是标准限流句，必须继续保持可重试。
  - **`summarizeFailureBody` 不认 `base_resp.status_msg`。** 那正是本线路在配额、Files API、签到三处都在解析的信封，用户此前会被展示一整个原始 JSON，而它唯一的内容就是那句话。
  - **现在与兄弟线路同形**：新增 `accountScoped` 分类字段（沿用 kimi-code 的字段名与语义），429 冷却后在同一轮内换号重试；轮换循环按轮重建凭据、超大媒体上传与请求体，因此重放出来的请求绝不会指向另一个账号上传的文件 id（`uploadOversizedMedia` 把 access token 与 account key 一起交给 Files API，这是本线路独有的真实耦合）。
  - **403 形态的额度耗尽一并处理，且不与凭据类 403 混淆。** 判别顺序是「先跑额度表、再落到凭据分支」，并且**状态码是外层条件**——任何 401 无论 body 写什么都进不了冷却分支，否则一个坏 token 会把整个号池走一遍。凭据提示语改为按**分类**挂载，额度耗尽的 403 不会再顺带甩一句 `sha256:…` 去怪那枚刚续期过的 token。
  - **额度型 403 不再白花一次强制续期。** 这是上一版行为里最贵的一处：`renewCredential` 对「窗口已耗尽」毫无帮助，而对原生账号（凭据就是桌面端自己的 `auth.json`，池内 adopted never destroyed）那次续期会**把一对新令牌写回用户的桌面端文件**。现在有号池且 body 命中额度表时直接交给号池分支。**无号池路径刻意不跳过**：那里续期推进的是插件自己的凭据文件，且最终抛出的 detail 来自重放后的响应，跳过会改掉用户看到的文案。
  - **401/403 不写 `markAuthFailed`，而且这是有证据的结论。** 适配器永远不会分类一个没先续期过的 401/403；能走到号池分支的必然是刚轮换出来的新令牌仍被拒。而「凭据不可用」早有两条更可靠的写入路径（`refreshFailureStatus` 在令牌端点最终拒绝时写 `authStatus`，`authRejectedReason` 另有免写入的排除）。在请求阶段补写反而制造**不可自愈的假阳性**：续期成功时新令牌对已经写进桌面端 `auth.json`，于是 `healStaleAuthFailures` 的四个条件一个都不满足——一次瞬时 403 会把正在使用的桌面账号**永久**标成「需要重新登录」，理由还是错的。现状已用测试钉住。
  - 测试：新增 `test/minimax-code-429-cooldown.test.ts`（28 例），核心断言是「**一次** `adapter.stream()` 调用内，第一个账号 429 额度耗尽 → 第二个账号给出答案」，即 `['Bearer at-1', 'Bearer at-2']` 的鉴权顺序 + 调用方拿到 `text-delta` 而非异常。另覆盖：额度型 403 换号且 `tokenCalls === 0`、凭据型 401/403 **不冷却不轮换**（含单账号池与双账号池）、400/5xx 不轮换、原生桌面账号不被标记也不被冷却、in-band 429 只冷却、无号池路径逐字不变、以及「额度判决不会因为 body 被读两次而退化成凭据判决」。承重已用变异测试验证（禁用新门 → 2 红；去掉 body 复用 → 4 红，报错正是 `expected 'INVALID_CREDENTIAL' to be 'PROVIDER_ERROR'`）。
  - 验证：`npm run typecheck` 0 错误；全量 `npm test` **3013 passed / 7 skipped, 0 failed**（较 0.17.1 的 2985 增 28 例，基线 2994 增 19 例）。未改共享内核、UI、DTO、路由。
  - **未一并处理的**：① 无号池的额度型 403 仍会多花一次续期（上一段说明的取舍）；② in-band（流式事件）的账号级 429 只能冷却、不能换号——响应体已经开着读了一半，结构上换不了，这是 6 条线路的共同限制，不是本线路独有。
## 0.17.1 - 2026-10-10

- **[Kimi Code] 请求体超限时，「还有图可丢吗」的判定与计量脱节，兜底一次都没跑（[#51](https://github.com/Aa728848/dsh-chatgpt-subscription/issues/51)）**
  - **`requestHasSendableImage()` 只扫消息顶层，不递归 `tool-result`。** 同文件的另外三个兄弟函数全部递归——`collectImageRefs`、`collectRequestImagePayloads`（其注释明写 *RECURSION IS NOT OPTIONAL*）、`replaceOldestRequestImages`。于是对「图片全部来自工具结果」的请求，计量数得出 N 张图，判定恒返回 `false`。
  - **后果不是「丢错图」，而是「一张都没丢」。** `kimi-code/adapter.ts` 的 body-fit 循环从 `attempt = 0` 起算，第一轮就短路，直接 `assertRequestBodyFits` 抛 `PROVIDER_ERROR`，唯一的丢图入口从未执行；`MAX_BODY_FIT_ATTEMPTS = 64` 形同虚设。报告方的现场只超限 **1494 字节**，丢一张约 150 KB 的图即可解决。混合会话同样中招：顶层图被丢光后，tool-result 里剩下的图一张不动，然后报错说「会先丢最旧的图」。
  - **报错文案同时说了反话。** `oversizedBodyMessage` 的 remedy 按字节构成判定（`imageBytes >= otherBytes`），于是文案写着 “Older images are omitted first”，而实际一张都没丢。讽刺的是同文件的 `requestBodyBreakdown` 走的是全递归的 `walkJson`——**报错里的图片字节数看得见那些图，决定要不要继续丢图的门禁看不见。**
  - **修复：把判定改成计量的定义式复用。** `requestHasSendableImage(options, images)` 现在就是 `requestImagePayloadLengths(options, images).length > 0`。手写第五遍递归也能修好这一例，但那条路保留了「同一条递归规则被抄多遍、下次再漏一遍」的结构性风险；复用定义让两者**按构造**不可能再分叉。
  - **顺带统一了同一路径上的第二处口径错配（独立缺陷）。** `dropOldestImagesUntilFits` 里 `requestImagePayloadLengths(baseline, resolved)` 带 images 映射，`countOmitted` 里两次调用**不带**，`replaceOldestRequestImages` 的跳过判断也**不带**。三处只在 `unavailable`（读不出来的图）上分叉：不带映射时它回落 `base64Length(attachment.bytes)` 被当作「有载荷」，于是 `alreadyDropped` 虚高、`slice` 提前掏空、`additional` 算成 0，循环空转到 64 轮才抛错。现在三处统一传入同一个 `images`，`replaceOldestRequestImages` 新增可选形参。**只改计数端是不够的**：替换端若不同步改，`lengths[N]` 与「第 N 个可替换块」仍然错位。
  - **附带效果**：`unavailable` 图现在会被判定为「不是可发送的图」，这类请求因此**立即 fail fast**，而不是白白重建 65 次几 MB 的请求体。
  - 测试：`test/kimi-code-body-fit.test.ts` 新增 5 例——不变量（嵌套图、**丢图之前**判定必须与计量一致）、超限请求丢一张即可恢复、顶层图仍被看见（防修复被推到反方向）、`unavailable` 图不算作可丢（防过度递归）、替换名额必须花在真正带字节的图上。**承重已验证**：`git stash push -- src/host/common/request-images.ts src/host/kimi-code/adapter.ts` 后实测 **2 failed**（`expected false to be true`、``expected ['shot'] to deeply equal ['broken']``），还原后全过。
  - 既有两条断言（`:143` 顶层图 `true`、`:153` 丢图后 `false`）**逐字未改仍然成立**——它们此前就与修复后的实现同值，只是从未覆盖真正出问题的那个状态。
  - 验证：`tsc -b --pretty false` 与 `tsc -p test/tsconfig.json` 均 0 错误；全量 `npm test` **2961 passed / 7 skipped, 0 failed**（较基线增 5 例）。
  - **未一并处理的**（与 0.13.2 记下的同一批）：claude / command-code / antigravity 三条线路的计量与替换仍只扫顶层，工具结果里的图对它们的图片预算系统性失明；它们没有布尔门，不会本地抛错，表现为静默超预算后被上游 413/400 拒绝。codex 干净（在构造后的 input 上测量），minimax-code 干净（复用共享递归实现）。

- **[Kimi Code] 四条线路的图片预算让工具结果里的图「隐形」，以及字节上限缺出口 —— 补完 [#51](https://github.com/Aa728848/dsh-chatgpt-subscription/issues/51) 的遗留项**
  - **状态 A 换了一条路存活。** 310590b 关掉的是「`tool-result` 里的图对门禁不可见」那一个实例；但 `dropOldestImagesUntilFits` 在「剩余图片总字节 < 超限缺口」时算出 `additional = 0` 并**原样返回**，调用方无法区分「成功了」与「没进展」，于是下一轮重建出**完全相同**的 body，空转到 `attempt > 64` 才抛出——期间连续构建 65 次几 MB 的请求体。实测可达：图片 1.6 MB + 文本 1.5 MB + schema 0.7 MB = 3.8 MB，缺口 1.7 MB > 图片 1.6 MB。
  - **无进展检测。** 该函数改为返回 `{ options, dropped }`，`dropped === 0` 时立即停止并带着上下文抛错，不再消耗 attempt 预算重建一个不可能改变的请求。
  - **报错文案从两态改为三态。** 判据从「字节构成猜测」换成「循环实际做了什么」：①**有图可丢但丢了也补不上缺口** → 明确说明剩下的图比缺口小，省略全部也装不下（不再声称「Older images are omitted first」）；②**图已全部省略仍超限** → 报出已省略的张数；③**本来就没有图** → 直接排除删图这个无效动作。`BodyFitContext` 是可选第三参，**不传时逐字沿用原文案**，现有 14 条断言一条未改仍通过。
  - **kimi-code 的字节上限补上环境变量出口**，`DSH_KIMI_CODE_MAX_BODY_BYTES` / `DSH_KIMI_CODE_MAX_IMAGE_BYTES`，与 MiniMax / Codex 两条线对齐（resolver 逐字同构：trim → 空串回落 → 非正有限数回落 → floor）。**视频上限不加出口**：三条线对称（minimax 同样是裸常量、codex 无视频），且一个变量管两档会让按 2 MB 场景设的值顺手压垮 64 MiB 视频档。共享常量 `common/request-images.ts` 的值与默认参数**未动**——那 8 处无参调用仍依赖它。
  - **claude / command-code / antigravity 三条线路的工具结果图片重新进入预算。** 三条各自持有私有副本（预算数字不同、缩放策略不同、attachment seam 不同），实测**不能**合并到共享实现：合并会同时替换三条线路的度量口径、缩放策略与取消语义，且有两处行为变化**不会让任何现有用例变红**（用例都不传 images 映射，走 `images === undefined` 分支）——那是最危险的一类。因此逐条把度量和替换改为递归，**零测试期望值变化**。
  - 顺带记录一处**刻意保留**的不一致：claude 的 `countRequestImages`（claude/mapper.ts:885-894）早已递归，而同文件的 `collectRequestImageBytes` 此前不递归——这正是本 bug 的**第五次**复制。统一它会让 `requestImageEdgeLimit` 不再把 `unavailable` 的图计入，而现有测试钉住了「刻意过度计数」的语义（低上限永远不会导致拒绝），故不动。
  - 测试：新增 `test/tool-result-image-budget.test.ts`（13 例，`describe.each` 覆盖三条线路的「计量」「替换名额顺序」「装得下时不动」）、`test/kimi-code-body-limits.test.ts`（6 例，出口生效 / 非法值回落矩阵 / 默认值即 2,097,152 与 1,500,000）、`test/kimi-code-body-fit.test.ts` +4 例（三态文案各一条 + 不传参数时逐字不变）；`test/kimi-code-adapter.test.ts` +1 例（适配器级「无进展即停止」，此前 `KimiCodeAdapter` 的 `options.attachments` 在测试中**从未被注入过**，那段 body-fit 循环零端到端覆盖）。`buildAdapter` 因此新增 `fetchFn` / `attachments` 两个可选参数。
  - **承重已验证**：`git stash push -- ` 七个源文件后实测 **18 failed**（三态文案 3、无进展 1、三线路递归 9、环境出口 5），还原后全过。
  - 验证：`npm run typecheck` 0 错误；全量 `npm test` **2985 passed / 7 skipped, 0 failed**（较 310590b 的 2961 增 24 例）；`npm run build` 干净。
  - **未一并处理的**：`/compact` 的 “could not produce a useful summary” 与真实原因不符。已复核——真实原因**已经落盘**在 `compaction/end.error`，宿主 `ManualCompactionError` 自己也带着 `message` 与 `cause`，是 `command-compact` **既不读 session 也不渲染自己的 error.message**。本插件的 `inject` 里没有 `commands` / `compaction` / `sessions`，也无法重名注册 `compact`（宿主 registry 硬拒）。这是 deepseek-harness 的修复点，不在本仓库能力范围内。

## 0.17.0 - 2026-10-09

- **[Antigravity] 缓存卡片改为只报「整段未命中」并给出它之前的空闲时长**
  - **原来的口径把最有用的信息盖掉了。** 卡片报的是「相比上一次请求，三段前缀里哪一段变了」，而每次发新消息都必然改变 `contents`，于是它**每一次都显示「对话内容变化」**——既报了唯一注定要变的那一项，又把真正花钱的那件事藏了起来。这个口径是我上一版写的，属于设计失误。
  - **现在只在整段未命中时发布归因**（`cachedContentTokenCount === 0`，即整个前缀被重算）。部分命中是对话增长的正常状态，每次新回合都必然带入服务端没见过的 token，`freshTokens > 0` 本身不代表任何东西，因此不再上报。
  - **归因改为「先暂存、后发布」**：请求发出前算出的变化只暂存（`pendingBySession`），等响应报回用量后才决定要不要发布。改动的代价是否为零，只有响应的用量能回答。
  - **新增空闲时长**：记录每个会话上一次**发出请求**的时刻，未命中时一并报出间隔。服务端的缓存按空闲时间过期（实测在 76 秒仍命中、183 秒整段失效），而客户端无法读取那个阈值——这是唯一能在本地观测到它的读数。首次请求没有可比较的前值，因此不填该字段（填 0 会被读成「立刻返回」）。
  - **契约与 UI 同步**：`AntigravityCacheStatsDto.lastDriftCause` → `lastMiss: { cause, idleMs?, at }`；卡片显示「最近一次整段未命中」+「未命中前空闲」，时长按 3m 3s / 45s 这样的人类单位渲染；中英文案与段落说明一并重写。
  - 测试：缓存统计 19 → 22 例（新增「命中时不报」「未命中时发布归因」「记录空闲时长」「首次请求不填空闲」），卡片渲染新增 1 例（全部命中时**不出现**任何未命中行，防止退回「每次都有话说」）。既有断言中 3 处依赖旧口径的已按新契约更新。
  - 验证：`npm run typecheck` 0 错误；全量 `npm test` **2956 passed / 7 skipped, 0 failed**（较基线增 4 例）。

- **[Antigravity] 让 Gemini 路线的请求前缀保持逐字节稳定，并给这条线路补上缓存观测**
  - **Antigravity 用的是 Google 服务端隐式缓存，客户端没有任何开关可拨。** 二进制里 `cachedContents` / `ContextCacheConfig` / `ttl` 这些字段确实存在，但都属于它链进来的官方 Go SDK，不是它的调用面：它实际只 POST `/v1internal:streamGenerateContent`，那层消息里不含任何缓存控制字段。所以唯一能提高命中率的手段，就是**不修改**请求前缀——前缀一旦在某个位置被改写，从该位置往后全部失效。
  - **Gemini 路线一直在把每个 SSE text delta 回放成独立 part。** 这条修复此前只做给了 Claude（见 `docs/antigravity-claude-cache-audit.md`：385 个 delta 回放成 385 个 part，命中率因此掉到 68.84%），Gemini 走的是同一份 delta 却漏了。现在抽出纯函数 `mergeAdjacentTextParts`，两条路线各自调用；Claude 专属的 thinking/signature 配对逻辑原地保留，只对 Claude 生效。合并只针对「仅含 `text` 一个键」的相邻 part，带 signature、`thought: true`、`functionCall` 的边界一律不跨越。
  - **图片预算原本按存储字节度量，而缩放发生在预算之后**，导致一组图在缩放有机会生效之前就已经超限、最旧的图照样被替换成占位文本——图片数量仍然变化，前缀照旧被改写，缩放等于没接上。现在 `requestImageBytes` 度量的是**实际要发送的尺寸**（有缩放目标时取 `min(存储字节, 目标上限)`），这是 `host/common/request-images.ts` 已记录过的同一个陷阱。预算仍保持 Antigravity 自己的 12MB，**没有**借用 Kimi 的 1.5MB。
  - **这条线路此前完全不可观测**：`request-diagnostics` 的指纹是进程内临时 HMAC、不落盘，而且只看顶层 `tools/system/messages`，看不到 Antigravity 嵌套的 `request.contents/systemInstruction/tools`。新增的 `cache-stats.ts` 按会话记录命中率，并对三段前缀各取一个稳定指纹，把冷却归因到 `contents` / `systemInstruction` / `tools` / `session-id` / `none`。哈希走键排序后的稳定序列化，否则两个结构相同、键序不同的请求会被报成假漂移。统计纯内存、按 `sessionId + accountId` 分作用域、256 作用域 LRU。
  - **已知局限写进了文件头，而不是留在报告里**：前缀快照按 session 分区、token 总计按 session+account 分区，两者作用域不同，所以**会话中途 429 换号会被报成 `'none'`**——读者不能据此读成「客户端什么都没变」。账号是否真的分区服务端缓存始终是 **INFERRED, not measured**，也正因如此没有把 `account` 提升成漂移原因：在假设未验证前把它写进契约，等于把假设当事实陈述。`'session-id'` 那个枚举同理，文案用「会话标识变化」而不承诺缓存语义。
  - **账号调度缺省改为 sticky**，且只改缺省：`parseAntigravityPoolData` 会把缺失值补成 `'sequential'` 并写回池文件，所以那里的解析器也必须一起改，否则 `routes.ts` 的回退分支是死代码。**已存盘的显式选择继续生效**，不为存量用户做迁移——这条改动的前提（账号=缓存命名空间）尚未验证，不适合在未证实收益的情况下改变既有行为。共享 core `host/common/account-pool.ts` 的策略语义未动，其他线路不受影响。
  - 设置页新增缓存卡片（命中率、累计 cached/fresh、最近一次漂移原因），中英文案齐备；未测得用量时显示为空而不是画一个 0% 的假仪表。
  - 验证：`npm run typecheck` 0 错误；全量 `npm test` **2952 passed / 7 skipped, 0 failed**。新用例在改动前的实现上实测 **12 failed**（用 `git stash` 单独暂存 `mapper.ts` 复现），改后全过。
  - **本次没有证明命中率提升**：Google 的隐式缓存是服务端的，本机无法做 A/B，`readImageRequest` 的真实缩放产物在测试里全是 mock。改动依据是「前缀逐字节稳定」这一机制，与 68.84% 那次的成因同构，但没有可报的线上数字。

## 0.15.0 - 2026-10-09

- **[思维保护] 推理坍缩守卫补上第二条独立信号：改写型死循环**
  - **原守卫对「换个说法反复说同一件事」是瞎的。** 唯一率信号只看得见**逐字**重复；一段把同一结论用不同措辞重述的流实测只有 0.48，而阈值是 0.85，于是一路跑到输出上限也没人拦。这不是理论问题——归档样本 `paraphrased-loop-reasoning.txt` 就是这种形态。
  - **第二条信号量的是「复述」而非「新颖」。** 把窗口切成句子，逐句与至少 `semanticLag` 句之前的内容做 3-gram Jaccard 相似度并取最大值。**枚举式推理也会重复，但它是相邻重复**——每一项借用上一项的句式；复述信号**忽略相邻性**，这正是区分两者的关键，所以健康的枚举流不会被误伤。
  - **两条路径，低门槛那条在每一步都更严。** 高门槛路径（原规则，未改动）要求唯一率 ≥ 0.85 且复述 ≥ 0.35；低门槛路径（新）允许唯一率低到 0.6，代价是复述门槛抬到 0.45、**外加一道高路径不需要的新颖度上限**（不同句比例 ≤ 0.47），且需要更多次确认（5 次 vs 3 次）。**用更弱的证据换更多、更长的确认。**
  - **确认是连续窗口计数，不是单窗口触发。** 两个信号必须在同一窗口同时过线，且连续 `semanticConfirmations` 次才动手；只有一方过线、或只有单个异常窗口，一律**只记日志不动作**。断流后连击归零，下一次尝试不会继承它没挣到的确认数。
  - **近失也留痕。** 单信号命中有专门的 alone 日志（每种每轮只报一次，避免数百行刷屏），连击在够数前断掉也有 cleared 日志——否则两段短连击在日志里与一段长连击长得一模一样，确认数事后无从推理。
  - 测试：守卫测试 **39 → 80 例**（源文件 480 → 948 行），新增归档样本 fixture 与真实的改写型坍缩样本。
  - 验证：全量 `npm test` 2886 passed / 7 skipped；守卫专项 80 例全通过。

## 0.14.0 - 2026-10-08

- **[Claude] 支持 Claude Haiku 5.5（`claude-haiku-5-5`），并把申报的客户端版本抬到 2.1.293**
  - **能力表新增一行**（`src/host/claude/model-catalog.ts`）：官方 2026-10-07 发布，1M 上下文 / 128K 输出 / 支持图片，档位 `low`–`max`。**固定 id，没有日期后缀也没有别名**，所以不像 4.5 那样成对出现。
  - **每个字段来自官方文档，不是从模型名推的**：这一行与邻居在三个字段上直接冲突——`claude-haiku-4-5` 是 `budget`、可关思考、支持 temperature，5.5 三条全反（自适应思考、档位控制深度、拒绝非默认采样参数）。能力表的地基就是「名字不决定任何字段」，照抄邻居就是这条地基要防的那种错。
  - **不能用 `budget`**：官方迁移指南写明手动预算形式 `{type:"enabled",budget_tokens:N}` 在 5.5 上是 400。照抄 4.5 那一行会发出模型直接拒绝的请求。
  - **也不进 `mid-convo` 分支**：官方默认档位是 `medium`，而 `mid-convo` 在调用方未指定档位时会强制 `effort: high`——等于每次请求都替用户多花一档、多付一档的钱。这与 Opus 5.5 是同一个坑、同一份理由，因此 Haiku 5.5 同样靠 `bindsThinkingToPrefix` 拿到 `block_binding`，而**不**接受强制 effort。测试里钉死 mid-convo 白名单的那条断言也没有收录它。
  - **`canDisableThinking: true`——本表第一个为真的本地新增行**：官方明确 `thinking:{type:"disabled"}` 在 `low`/`medium`/`high` 被接受、在 `xhigh`/`max` 是 400。这条不对称能安全记成一个布尔值，靠的是本线路**发这个 form 的时机**：只有调用方明确要求关闭思考时才发，且此时**不申报任何档位**，请求因此跑在官方默认 `medium` 上——落在被接受的一侧；想用 `xhigh`/`max` 的人一定开着思考，走的是 adaptive form。反过来把「xhigh 以上 400」读成「不能关闭」才是错的——那会把低档位本来可用的开关一起拿走。
  - **与号池相关的一条用户可见后果**：官方写明 Haiku 5.5 的思考块只在产出它的账号（或其关联账号）里有效，换账号回放会被**静默丢弃**——请求成功，模型看不到那段推理。多账号轮换因此表现为「同一段对话里答案质量忽高忽低」而**不报错**。这一条记在能力表的行注释与 README 里，因为它是号池的行为，不是模型的性质。
  - **申报版本 2.1.285 → 2.1.293**：Haiku 5.5 首发于 Claude Code 2.1.293，而 `types.ts` 早就写着「默认版本必须 ≥ 首次提供每个模型的那个发行版」。这不是假设：加这一行时 npm 的 `stable` 标签**仍停在 2.1.285**（插件当时申报的值），`latest` 已经是 2.1.293——不抬版本的结果是照常广告一个每次请求都会被 `claude_code_version_too_old` 拒掉的模型，而本地预检看不出来。该行**没有** `minCliVersion`：没见过上游真的拒它，就不臆造门槛数字（Sonnet 5.5 也是这么处理的）。版本锁另加一条断言，把「≥ 2.1.293」写进测试而不只写进注释。
  - **保真锁同步跟着加**：本机参照目录（pi-ai 0.87.1）里没有这个模型，所以它进 `LOCALLY_CURATED_MODEL_IDS`，并在 `test/claude-model-catalog.test.ts` 里逐字段断言官方文档的值；该文件的三处说明文字（「今天两行」「快照之外还差几行」「两行的理由」）一并改成三行，否则文档会比锁先过期。
  - **新装默认勾选里的 Haiku 槽位换成 5.5**：默认列表每族只放一个当前代模型，所以 `claude-haiku-4-5` 被 `claude-haiku-5-5` 顶掉，长度不变。这是安装期的明确决策而不是静默追加：「未编辑过默认列表」按成员比对，老用户存的旧默认仍按原样生效，不会被这次改动悄悄改写。
  - 验证：`npm run typecheck` 0 错误；`test/claude-model-catalog.test.ts` **26 passed / 0 failed**（本机装有参照目录，15 行转录保真断言与「快照之外恰为这两行」都真的跑了，不是 skip）、`test/claude-mapper.test.ts` 91、`test/claude-adapter.test.ts` 43、`test/claude-routes.test.ts` 21、`test/claude-token-store.test.ts` 45、`test/provider-output-reservation.test.ts` 181 全通过；全量 `npm test` **2826 passed / 11 failed / 7 skipped**，11 个失败全部是 `test/claude-oauth.test.ts` 的 `No bindable loopback port in the probe range.`——本机 bind `127.0.0.1` 直接 `EACCES`（已单独探测确认），与本次改动无关。
- **[Codex] 在 ChatGPT 卡片里导入本机 Codex CLI 的登录（可选）**
  - **重复登录是纯粹的摩擦**：已经在官方 CLI 登录过的用户，登录的正是这个 Provider 服务的那份订阅，却还要再走一次完整的 OAuth。新增 `POST /adopt`，让它点一次就少一整轮登录。
  - **导入得到的是快照，本插件永不再刷新它**：ChatGPT 的 refresh token 会轮换，而 CLI 会在**原地刷新自己的文件**——两个进程刷同一份授权会互相作废，输的一方握着服务端已经作废的令牌，结果是用户**被本插件的好意踢出 Codex CLI**。进程内的单飞解决不了，因为竞态在**进程之间**：两个进程唯一共享的就是那个文件，而按只读规则本插件不能写它。因此快照只在 CLI 还为它作保时可用，**过期是收编这件事的一部分而不是缺陷**。
  - **只读是结构性的，不是承诺**：`codex-adopt.ts` 只按名字从 `node:fs/promises` 导入 `readFile` 与 `stat`，加一次写操作必须先改这行 import（而 import 是评审第一眼看的地方）；测试断言一次读取前后凭据文件的**字节、大小与 mtime 完全不变**。
  - **存在性与内容是两个函数**：`codexCliCredentialPresence()` 只 `stat`，开机即可跑；`readCodexCliCredentials()` 只在你点了导入之后才调用。合成一个「顺手先读一下以防万一」的启动路径，正是会把 opt-in 变成装饰的那种做法。
  - **每条线路只在自己的页面里回答自己的问题**：一开始把这三处做成了总览页上一次跨线路的统一只读扫描（一条统一扫描路由加一个扫描模块），结果那一块替 Claude Code 与 MiniMax Code 回答了它们自己已经回答过的问题，只能挂一句「该供应商在自己的设置页里已有导入入口，请到那里导入」——而用户就在离那一页一步之遥的地方。现在没有跨线路扫描了：Codex CLI 的答案由 `GET /status` 上的 `codexCliSignInAvailable` 给出，Claude 与 MiniMax 继续用各自的既有读取器与各自的导入入口。**「文件在哪」只有一份答案，因为只有各自的读取器拥有它。**
  - **宿主顺带报出它 stat 过的那个路径**：`GET /status` 多带一个 `codexCliSignInPath`（`codexCliCredentialPaths()` 的唯一候选，纯函数、不碰文件系统），有了它「没找到」才可追问「你到底找哪儿了」。**卡片本身不显示它**——卡片上除了按钮不加文字，本条只保证答案在接口上随时可取。
  - **「已检测到」不等于可用**：判断可用必须读取文件，那正是 opt-in 之后才做的事。未识别的形状（文件不存在、不是 JSON、`auth_mode` 不是 `chatgpt`、`tokens` 不是对象、缺 access/refresh token、access token 不是带可用 `exp` 的 JWT）一律给出 `undefined` 而不是异常，卡片报「格式无法识别」；邮箱与套餐来自 id token 自己的声明，没有就不填。`exp` 由秒换算成毫秒——错向时是静默的，而错向另一边会让一枚凭据看起来几个世纪都不过期。
  - **不猜 Kimi Code**：本机 Kimi Code 的凭据文件没有区域 / `oauthHost` / `baseUrl`，插件宁可拒绝也不猜，因此该行不出现，而不是显示成一个「装上就能收编」的承诺。
  - **卡片与号池共同钉住「只借 access token」**：`codexNeedsRefresh` 对 adopted 凭据**恒答否**，刷新钩子本身也直接拒绝（双重挡住是为了让将来漏掉前者的调用者大声失败，而不是悄悄花掉一枚不属于本插件的授权）；过期即退出调度且**不产生任何写入**，摘要标 `removable: false`，删除只能走显式的 `removeImportedAccount`。池文件往返保存该标记，于是重启后也不会把快照当成自持凭据。
  - **导入只是多一行**：不触碰当前存储的登录态；去重键 `accountId ?? email` 让同一账号重复导入时**原地更新**而不是产生重复账号。
  - 客户端只多一个按钮，且只在 **ChatGPT 卡片**里：账号池卡片头部那行「登录」**旁边**的「导入本机 Codex CLI 登录」，用共享卡片的 `renderLoginActions` 插槽，和 Claude 页面那个收编按钮同一套布局——登录保留主按钮样式，导入是次要的那个。这个按钮**不受检测结果影响，永远都在**：一个会自己消失的按钮回答不了「我本机到底登录了没有」，而没有登录时点它也并非无声无息，宿主会回一句明说缘由的错误，并显示在该卡片已有的错误条里。**卡片上不添加任何说明文字**：按钮已经说明了自己的动作，而「有没有」「找到了吗」「去哪儿找的」三段散文正是用户要求移除的「无关文字」（Claude 页面上同样的三段一并移除）。
  - **导入必须能撤销，而撤销的形状由路由决定**：`/adopt/disable` 刻意不接受 `accountId`（池对 adopted 行的删除拒绝是一条**安全**规则，逐条撤销的入口一旦能抵达自持登录就会打破它），于是撤销做成了 ChatGPT 账号池卡片下方的一个**池级**按钮「停止导入全部本机登录」，文案与提示都写明「全部」。导入行被标为 `removable: false`，共享卡片据此隐去 Delete；没有这个按钮时导入就是**单向门**，只能手改 pool 文件才能收回——一个只进不出的功能不算做完。
  - 路由：`POST /adopt`（body `{source:'codex'}`，未知来源返回一句指向真正拥有它的供应商的话，而不是静默无操作）、`POST /adopt/disable`；`GET /status` 另带 `codexCliSignInAvailable` 与 `codexCliSignInPath`。
  - 测试：新增 `test/codex-adopt.test.ts`（19 例）与 `test/codex-local-signin-ui.test.tsx`（6 例），并扩充 `test/codex-account-pool.test.ts`（27 例）与 `test/routes.test.ts`（10 例）。
  - 验证：`npm run typecheck` 与 `npm run build` 均 0 错误；`test/client-registration.test.ts` **16 passed / 0 failed**、`test/codex-import-undo-ui.test.tsx` 6、`test/codex-local-signin-ui.test.tsx` 6、`test/routes.test.ts` 10、`test/codex-account-pool.test.ts` 27、`test/codex-adopt.test.ts` 19 全通过；全量 `npm test` **2823 passed / 11 failed / 7 skipped**，11 个失败全部是 `test/claude-oauth.test.ts` 的 `No bindable loopback port in the probe range.`，在**未改动的工作树上同样复现**，与本功能无关。

## 0.13.2 - 2026-10-08

- **[Kimi Code] 读图请求按「实际发送体积」计量，超限时回收而非直接拒绝**
  - **报错 `Kimi Code rejected the request before sending: the serialized body is N bytes, above the 2097152-byte limit` 的根因是三处计量缺陷叠加，2 MB 网关上限本身没有问题**（那是 Kimi 文档里的真实限制，见其错误参考 `total message size N exceeds limit 2097152`）。
  - **图片按「存储原始字节」计量，但发出去的是「缩放后的请求版本」。** `resolveRequestImages` 会把长边超过 1024px 的图缩到 `REQUEST_IMAGE_VERSION_MAX_BYTES`（256 KiB，与官方 CLI 的 `read_byte_budget` 同量级）后再内联，而预算是拿 `attachment.bytes` 算的。一张 5 MB 截图因此被记成 ~6.7 MB base64，判定超预算 5 MB 被丢弃——可它真正上线时只有 ~350 KB，四张都装得下。官方 CLI 的做法是「送达模型前自动降采样并重新编码，避免供应商因图片过大而报错」，语义相同：**量的必须是送出去的那个版本**。现在先解析、再按解析后的真实 base64 长度计量。
  - **工具结果里的图片从未被计入预算。** `collectRequestImageBytes` 只遍历顶层 block，不递归 `tool-result`，而 `toolResultBlocks` 是会发送那里的图的。重度使用 `read_image` 的会话——也就是这个报错的典型场景——恰好系统性地少算了自己最占地方的图片。计数器现在与 `collectImageRefs` 一致地递归。
  - **超限时只会拒绝，不会回收。** `assertRequestBodyFits` 量完超限就抛 `PROVIDER_ERROR`，而此时再丢一张图很可能就装得下了。现在改为：量真实请求体 → 按需丢最旧的图 → 重新构造 → 直到塞进上限，一张不多丢。已经装得下的请求只序列化一次，字节级不变。丢无可丢时才报错，文本与工具 schema 不会被静默丢弃。
  - **报错区分「图太多」和「文本太多」。** 旧文案一律让用户去压缩会话，于是图片占主导的用户会被引向错误的 remedy。现在报出构成（`images N bytes, tool schemas N bytes, conversation text and system prompt N bytes`），并按主导项给处方：图主导提示少带图，文本主导才提示压缩会话。
  - 测试：新增 `test/kimi-code-body-fit.test.ts`（8 例），逐条锁住上述行为。
  - 验证：`tsc -b --pretty false` 与 `tsc -p test/tsconfig.json` 均 0 错误；全量 `vitest run` 2784 passed / 7 skipped。
  - **未一并处理的**：command-code / claude / antigravity 三条线路各有自己的本地实现，同样存在「按存储字节计量」与「工具结果图片漏算」两个缺陷，但各自预算数字不同，需逐条评估而非照搬。

- **[Codex] 请求级图片总量上限，以及请求路径失败的 cause 链（[#50](https://github.com/Aa728848/dsh-chatgpt-subscription/issues/50)）**
  - **codex 此前是全插件唯一没有请求级图片总量约束的线路。** 历史里的每张图片每轮都会被重新内联，请求体随读图数量单调增长；超过传输层能接受的体积后整轮失败。报告方的现场日志：≤4 MB 稳过、4~5 MB 掉到 3/10；合成复现里 ≥4 MB 全挂（`ERR_HTTP2_STREAM_ERROR: NGHTTP2_ENHANCE_YOUR_CALM`），≤3 MB 全过。这是**概率关系**而非硬阈值——报告者自己也标明了这一点，所以修的是「无上限」，不是「阈值是多少」。
  - 现在按**最旧优先**把超出预算的图片替换为明确的占位文本。**预算在构造好的请求体上执行**，而不是在 `options.messages` 上：图片有两种到达方式，粘贴附件是 `{ type: 'image', attachment }` 块，而工具读取的本地图片是 `![](/describe-image/raw/sha256:…)` 链接、由 `mapUserText` 在构造时才取回并内联；消息块级方案看不到第二种，且共享的 `offloadOldestRequestImages` 也不递归 `tool-result`。在构造后测量是唯一能覆盖全部形态的位置。
  - 预算是**这条线路自己的 2 MiB**，不是照搬：Kimi 的 1.5 MB 按它自己的 2 MB 请求上限定，用在这里会静默删掉本端点能接受的图片；MiniMax 的 16 MB 按 64 MB 请求体定，这里没有那个上限。`DSH_CODEX_MAX_IMAGE_BYTES` 可覆盖，非法值回落到默认而不是让守卫静默失效。
  - **只约束图片部分**：纯文本本身就超出传输层体积的请求仍会被拒绝，图片预算不解决那个问题。
  - `request()` 的 catch 补上 `errorChain()`：此前任何传输层失败都报成同一句 `Codex could not be reached.`，而 DSH 只持久化 `{message, code}`，于是 `NGHTTP2_ENHANCE_YOUR_CALM`、`ECONNRESET`、`UND_ERR_SOCKET` 在界面与日志里无法区分——正是这条让上面的体积问题无法自助定位。现在与 `streamFailure` 的既有做法一致。
  - 测试：新增 `test/codex-image-budget.test.ts`（10 例）。**承重已验证**：撤掉 offload 调用后 40 张图 ~10.7 MB 直接上线并失败；还原成信息量低的报错后 cause 断言失败。
  - 验证：`tsc -b --force` 与 `tsc -p test/tsconfig.json` 均 0 错误；全量 `vitest run` 2776 passed / 7 skipped；`npm run build` 干净。

- **[设置 / UI] 「订阅服务」改为总览卡片 + 逐线路下钻，配额进度移入账号卡片**
  - 概览页替换原横向 TAB 条：每张卡片给出该线路的账号数、连接状态、已启用模型数与启停开关（Ollama 无开关，恒为启用），点卡片进入该线路设置，返回条回到总览。
  - **每个账号的配额进度条画在它自己的账号卡片里。** 此前页面级进度条在轮询/粘性策略下会显示 A 账号的数字，而实际在服务的是 B——同一页面上两个数字互相矛盾。页面级区块只保留没有「按账号进度条」可放的事实。
  - **未测量的额度不再画成 0%。** 缺失与 NaN 一律视为「未测量」并丢弃该窗口：antigravity 此前把未测量的 bucket 强转成 0，而 0 剩余 = 100% 已用，于是服务端从未测量的额度被显示成「已用尽」。
  - 重置倒计时统一为相对时间（分钟/小时/天），同一列不再混用「近处相对、远处日期」两种口径。
  - 删除凭据储存方式的行与提示（那是实现细节，不是用户设置），删除与账号卡片重复的页面级分组/桶进度行与三条冗余连接行。
  - composer 徽标的前缀词「额度」随语言切换（此前各线路写死中文）。
  - 总览卡片的 `N/M 模型` 由各线路**已经持有的目录**回答（打开设置页不触发任何目录抓取）；从未同步过目录的线路报「未知」而不是 0。

- **[重构] 设置页与 host 装配去重（除上面列出的两处外无行为变更）**
  - 10 份内联 `fetchApi` → `common/line-api.ts` 工厂。工厂取的是十份的并集，顺带修掉两个真缺陷：ChatGPT 路由的 `{code, message}` 错误此前被印成 `[object Object]`；`{ok:false, error}` 不带 `value` 键时会被当成正常载荷。
  - 6 支 ComposerQuota → `common/ComposerQuotaBadge.tsx`。回调改走 ref：此前调用方写内联箭头会让 60 秒轮询在每次渲染时重启。ChatGPT 那支结构不同（无点击刷新、类名前缀不同、受 quickQuota 偏好门控），保持独立。
  - 6 份格式化助手与 6 份 context-window 块 → `common/format.ts`、`common/ContextWindowEditor.tsx`。合并时发现 antigravity 的 `formatCapacity` 缺 1K 下限，会把 0 渲染成 `0K`。
  - `src/index.ts` 的 7 段 claim-route 三元组 → `host/common/provider-route.ts`（171 → 42 行）。Ollama 是唯一不监听 `llm/adapters-updated` 的线路，该差异以 `watch: false` 显式保留，而不是被模板抹平。
  - 各线路 locale 命名空间的 `any` 全部类型化；badge 注册的 inject 工厂集中为一处（未做成组件表：那需要按 harness 的 composed-props 内部类型书写，等于新增版本敏感接缝）。
  - claude / minimax 两个巨型 Section 拆为「hook（状态与动作）+ 组件（纯渲染）」两层，hook 返回 `{ state, derived, actions }` 命名形状。
  - 故意保留的重复及原因（Codex 的 `formatDate` 收**秒**、两份 `formatPercent` 舍入不同、一处未被测试覆盖的 antigravity `title` 变化）记在 `docs/settings-hub-redesign.md` §6.3。

- **[MiniMax Code] Files API：超内联上限的媒体改走上传与 mm_file 引用**
  - 新增 `src/host/minimax-code/files-api.ts`。这是让大视频可发送的唯一路径——内联 base64 涨 4/3，
    50 MB 视频编码后约 67 MB，会超出 64 MB 请求体上限。
  - **每项事实均为实测**，因为官方客户端的 `files_api_upload_endpoint` 只是相对路径，照抄会 404：
    - 端点是 `/messages` 的**兄弟** `/mavis/api/v1/llm/v1/files/upload`。挂在 `/messages` 下面会得到
      503 `direct_route_not_configured`，挂到 host 上会得到 404 HTML——两者都不像「路径差一段」。
    - **只发 `Authorization`，不发本线路其它请求都带的 `X-Msh-*` 身份头**。带上去时服务回答
      `{"file":null,…"invalid params"}`，与「表单字段名写错」逐字节相同（我扫了 8 个字段名加空表单，
      全部同一句）。去掉身份头后同样的表单立刻成功。
    - 表单 `purpose` 在前、`file` 在后；取值 `image_understanding` / `video_understanding`。
    - 响应 `file.file_id`，但**失败时 HTTP 是 200**，必须同时检查 `base_resp.status_code === 0`，
      否则会把字面量 `"null"` 当 id 发上线。
    - 引用形态 `mm_file://<id>`，裸 id 会被拒为「非 http(s)」。
  - 四个生命周期职责：TTL 取 12 小时并在过期后重传；缓存 key 含账号，**id 绝不跨账号复用**
    （未验证是否跨账号可读，按不可读处理）；删除因**服务端没有 delete 路由**而做不到，改为靠内容哈希
    去重控制上传量；失败降级为「媒体保持内联、请求继续」，不让优化失败拖垮整轮。
  - 触发点在两个体积 offload 之后，且只上传超过内联上限的媒体。
  - `503 direct_route_not_configured` 单独归类为 `route-not-configured`，与「表单被拒」区分：
    前者是账号没开该路由、重试无用，后者是请求本身的问题。
  - 端到端验证：真实上传取得 `file_id`，以 `mm_file://` 引用发送，messages 返回 200。
  - 测试：新增 `test/minimax-files-api.test.ts`（17 例），其中三例锁定本轮踩过的坑
    （路径是兄弟而非子路径、只发 bearer、非 JSON body 要如实报告而非谎称「无理由拒绝」）。
  - 实测细节与仍未解决的问题记录在 `docs/minimax-files-api-handoff.md`。
  - 验证：`tsc -b --force` 与 `tsc -p test/tsconfig.json` 通过；`vitest run` 2555 passed / 7 skipped；
    `npm run build` 通过。

- **[MiniMax Code] 支持视频输入；把视频子系统提取为两条线路共享**
  - **视频能力（N6）**：M3 与 M3.1 现在声明并支持视频输入，此前只有文档记载、路由没有实现。
    块形状与 base64 取向**均为实测**，未沿用 Kimi 线的猜测：
    - 端点接受 `{ type: 'video', source: { type: 'base64', media_type, data } }`，并会解码后跑 ffprobe 校验；
    - **裸 base64** 正确；`data:` URL 会在第 4 字节被拒（MiniMax 与 Kimi 的取向**相反**）；
    - `video_url`、把视频当 image、document 块三种形状均被明确拒绝；
    - 无可读字节、或模型不支持时，降级为解释性占位文本而不是静默丢弃。
    内联预算 `MAX_REQUEST_VIDEO_BYTES = 16 MB`（base64 涨 4/3，文档的 50 MB 会超出 64 MB 请求体上限）；
    更长的视频需要 Files API，见交接文档。
  - **共享化**：视频的块类型、模态表增强、遍历、字节预算与 base64 编码，从 Kimi 线的 mapper 提取到
    `src/host/common/video.ts` 与 `src/host/common/video-request.ts`。
    必须共享的原因：`ModelModalityMap` / `ContentBlockMap` 的模块增强是全局的，
    两条线路各写一份就是对同一个 `video` 键的重复声明。**wire 形状仍各线自有**——
    两条端点的 base64 取向相反，不能共用编码。
  - **能力表更新**：M3 / M3.1 的 `inputModalities` 加入 `'video'`。
    该字段是 DSH 能力管道（提示准入、模型选择器、子代理委派）会据以行动的声明，
    因此只有在线路真的能编码时才列入。
  - **测试**：新增 `test/video-shared.test.ts`（7 例）覆盖共享层，
    其中一例专门锁定「裸 base64、不加 data URL 前缀」这条与 Kimi 相反的约定；
    更新 minimax review-fixes 的视频用例（此前断言「永不声明 video」，现改为「只在支持它的模型上声明」）。
  - **N4 Files API 未实现**：已写交接文档 `docs/minimax-files-api-handoff.md`，
    记录实测事实、实现清单、四个必须自建的生命周期职责，以及「不该做的事」
    （其中「把 maxAttachments 当内联上限」是本轮已被实测推翻的错误）。
  - **验证**：`tsc -b --force` 与 `tsc -p test/tsconfig.json` 通过；
    `vitest run` 2538 passed / 7 skipped；`npm run build` 通过。

- **[MiniMax Code] 按官方文档更正 thinking 控制字段**
  - **背景**：与官方开源客户端 `MiniMax-AI/minimax-code`（`56221c1`）对照后，逐项核对 MiniMax 官方文档
    `platform.minimax.io/docs/guides/text-generation.md`，发现 thinking 控制字段的形状与文档不符。
  - **thinking 字段更正**（经实测确认）：
    - 文档明确 **Thinking is on by default and needs no configuration**。原实现发送的
      `thinking: {type:'enabled', effort}` 是**从未被文档支持的推断字段**——这也解释了为什么它
      一直「生效」：思考之所以出现是因为模型默认就在思考，与该字段是否被读取无关。
      现**完全不再发送 `thinking` 对象**。
    - 文档的协议对照表规定 Anthropic 兼容面的思考深度字段是**顶层 `output_config.effort`**，
      而非 thinking 对象内部。原实现把 `effort` 放错了层级，服务端不会读取。
    - 文档的 effort 取值只有 `low` / `medium` / `high` / `xhigh` / `max`，且**省略即 max**。
      原实现的 `'default'` 是本地占位值，现不会到达 wire；调用方未指定时整个 `output_config` 字段不出现。
    - 实测确认：用一个需要真实推理的题目，`low` 约 1.1–1.3K 输出 / 11–14s，`max` 4000 输出触顶 /
      51–62s，约 3 倍思考量、4 倍延迟，字段确实被读取。（用简单题目测会得到「无差异」的**假阴性**——
      任何档位下思考量都相同。）
  - **实测纠正一处误判**：曾按「`maxAttachments` 只声明、无人执行」为它新增按数量截断，随后用已登录账号
    实测发现 **M3 带 4/5/8/9/10/12/20/48 张内联图全部返回 200**，订阅端点对内联图片**没有数量上限**。
    该字段来自模型的 **Files API 能力块**（`max_attachments_count`），描述的是**上传路径**，
    而本线路从不走上传——与 `filesApiDocumented` 描述的是同一件事。**按数量截断只会白白丢掉服务
    免费接受的图片，已回退**；字段文档改写为「Files API 的数字，本线路不上传」。
    教训：「声明了却无人执行」不总是 bug，先要确认那个声明描述的是不是自己走的路径。
  - **补齐缺失的请求形状测试**：此前 `thinkingFieldFor` / `body.thinking` / `output_config` 在整个
    测试树中**零命中**——现有的 thinking 回放用例只检查**响应侧**，所以请求体字段写错永远不会被发现，
    这正是该推断字段能长期存活的原因。新增 7 例锁定：任何模型任何档位都不发送 `thinking` 键、
    effort 落在顶层、省略时字段不存在、非法档位不落到 wire。
  - **验证**：`tsc -b --force` 与 `tsc -p test/tsconfig.json` 通过；`vitest run` 2529 passed / 7 skipped；
    `npm run build` 通过。
  - **留待决策 / 实测**：
    - 官方文档规定**省略 effort 即为 max**，而 `max` 档在 4000 输出上限下就已触顶。这意味着
      **未指定档位的请求默认跑在最贵档位**。这是文档定义的行为而非缺陷，但是否把默认降到 `high`
      值得作为产品决策复核。
    - 实测确认 **M3 可以关闭思考**（`effort:'none'` 生效），**M3.1 忽略它并继续思考**，与官方文档一致，
      因此现有的 `toggle` / `forced-effort` 划分保持不变。
    - M3 上下文 512K（本线路，抄自订阅 `config.yaml`）vs 1M（平台文档）口径不同，需约 4 MB 提示才能
      验证，**未获授权前不烧额度**，保持原样。
- **[Kimi Code] 对齐官方客户端的 K 系列模型能力，修复两处正确性缺陷与一处并发归因错误**
  - **背景**：与官方开源客户端 `MoonshotAI/kimi-code`（`21406fb`）逐文件对照后的 11 项差距，分四批落地。
  - **正确性**：
    - tool-call id 原本只做 `slice(0, 64)`——共享 64 字符前缀的两个 id 会被截成同一个，**后续工具结果配错到错误的调用**；且不净化字符，`.` `:` 空格可能让服务端拒绝整个请求。现改为「净化 + 截断 + 碰撞递增后缀」，后缀同样受 64 上限约束。请求侧与流式侧共享同一个 normalizer，保证同一调用在两侧得到同一 id。
    - reasoning 字段名原本硬编码 `reasoning_content`。Kimi 用该名，但新版 vLLM 已改名为 `reasoning` 且请求侧**只认**新名（vllm#38488）——回写旧名会静默丢失每个历史 assistant 轮次的思考链，并触发 "thinking is enabled but reasoning_content is missing"。现按对端实际用过的键回写（覆盖 `reasoning_content` / `reasoning_details` / `reasoning`）。
  - **并发**：前缀稳定性追踪与缓存统计原本是进程级单例，DSH 多会话 / subagent 并行时会互相覆盖，归因指向**另一个会话**的变更——这类错误比没有归因更糟，因为用户会相信它。现按 `sessionId`（漂移）与 `sessionId + accountId`（缓存统计，账号池下每个账号在服务端各有一份缓存）分桶，并有 256 会话 LRU 上限。状态接口新增 `?sessionId=` 参数。
  - **服务端声明驱动**：新增 `supports_thinking_type` 三态（`only` 剔除 `none`、`no` 返回空）、`limit.input` 独立输入上限（prompt 用 `min(window, cap)` 夹，输出仍用完整窗口）、`supports_tool_use`（与「不支持消息级工具」区分开）、`status` 退役模型过滤。设置卡片相应展示「输入上限」「不支持工具」。
  - **成本可见性**：新增缓存过期提示——空闲超过所选 TTL 且上下文足够大时提示下一轮将重新处理的 token 数。判定沿用官方的「缺数据即跳过」原则，宁漏报不误报。`cacheWriteTokens` 保留字段并标注该线路恒为 0。
  - **验证**：`tsc -b --force` 与 `tsc -p test/tsconfig.json` 通过；`vitest run` 2522 passed / 7 skipped（新增 45 例）；`npm run build`、`npm pack --dry-run` 通过。
  - **未做**：Moonshot 开放平台（API Key）线路——它是唯一能触达 `kimi-k*` 真实 K 系列 id 的路径，按决定暂缓。

- **[Kimi Code] 图片超预算时按需缩放而非丢弃，稳定提示缓存前缀**
  - **现象**：一次 UI 走查连续贴入 10 张 1440×1000 截图时，`cacheReadTokens` 四次断崖式下跌（100,864 → 16,384 等），合计约 13.3 万 token 被迫按未命中全价重算。
  - **根本原因**：Kimi 网关对单次请求的**整个消息体**限制 2 MB（官方报错 `total message size N exceeds limit 2097152`），图片 base64 与对话文本、工具 Schema、System Prompt 共享该额度。插件的 `MAX_REQUEST_IMAGE_BYTES`（1.5 MB）超出后，`offloadOldestRequestImages` 从最旧的图开始丢弃。**丢弃张数随每张新图递增，而每次变化都会重写保留前缀，于是下一轮缓存再次失效**——第 4、6、8、10 张图各触发一次，四次全部落在图片注入之后。
  - **修复方案**：
    - `resolveRequestImages` 对长边超过 1024 px 的图片调用 Harness 的 `attachments.readImageRequest` 派生缩小版本（目标 256 KiB 原始字节，约 350 KiB base64，四张可落入 1.5 MB 预算），已在限额内的图片保持原字节不变。存储的原图与会话历史均不作修改。
    - **为何按长边而非累加字节判定**：`readImageRequest` 的 `variantId` 由附件与目标内容寻址，同一张图在每一轮得到同一个 target，字节恒定；若改按累加量动态调整 target，每新增一张图都会改写全部旧图字节，反而造成更频繁的缓存击穿。
    - **降级容错**：派生版本仍超边长时优雅降级为 `[image unavailable]` 占位文本；派生失败同样降级；用户主动取消（Abort）正常透传。
    - `offloadOldestRequestImages` 的丢弃逻辑保留为总量兜底，仅在原图大到缩放也装不下时触发。
  - **测试与验证**：新增 11 项回归测试（长边/竖图缩放、已在限额内逐字节原样发送、十张 QA 图不再触发丢弃、派生超限与失败降级、取消透传）；`npm run typecheck`、`npm test`（2467 passed / 7 skipped）与 `npm run build` 全部通过。
  - **已知限制**：十张 1440×1000 截图缩放后仍超出 1.5 MB 预算，需缩到 1000 px 宽以内（四张以内）方可全量保留；本改动的作用是使省略数量不再随新增图片递增，从而不再反复击穿缓存。

- **[Antigravity] Claude 工具 Schema 兼容降级处理（[#39](https://github.com/Aa728848/dsh-chatgpt-subscription/issues/39)）**
  - **背景与现象**：Claude 对出站工具的 JSON Schema 要求较严苛，包含复杂联合类型时容易报错。
  - **解决方案**：
    - **Schema 折叠降级**：仅针对 Claude 目标，在出站边界折叠 `anyOf` / `oneOf` / `allOf` 与类型联合；优先保留可填写的对象形状，将原始备选形式与约束摘要放入字段描述（Description）中。
    - **枚举合并**：同类型枚举合并时保留空字符串重置值。
    - **覆盖范围**：覆盖调度参数、权限枚举、引用引用（$ref）、数组、根级联合、可空类型及单分支结构。
    - **隔离保障**：此改动为网关兼容降级，不修改原始工具 Schema；Gemini 保持原转换路径；工具端仍严格校验实际参数。
  - **验证**：通过离线序列化请求验证，全量测试通过（2456 passed / 7 skipped）。

- **[通用配置] 网页抓取 Provider 选择与响应上限可配置（[#40](https://github.com/Aa728848/dsh-chatgpt-subscription/issues/40)）**
  - **新增配置项（插件 Config）**：
    - `fetchProvider`: 可选 `auto | plugin | dsh`（默认 `auto` 保持既有行为）。`dsh` 显式优先于代理检测和 Codex 搜索选择；`plugin` 则独立启用插件自身抓取。
    - `fetchMaxBodyChars`: 抓取正文最大字符数（默认 100,000，须为正安全整数）。
    - `fetchMaxResponseBytes`: 最大响应字节数（默认 2,097,152，即 2 MB，须为正安全整数）。
  - **界面与日志**：插件状态接口、设置页及切换日志展示当前配置与上限（日志中自动脱敏代理凭据）；README 补充配置重载说明。
  - **注意事项**：DSH 抓取模式不使用插件设置的上限；工具层另有固定输出限制。测试已固定离线 DNS，不再依赖本机透明代理。

- **[Claude] 修复多图会话因单张宽图导致后续所有轮次永久卡死 400**
  - **报错信息**：`messages.N.content.M.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels`
  - **根本原因**：
    - **Anthropic 接口限制**：单张图片最长边上限为 8000 px；但当单次请求图片**超过 20 张**时，每张图片的最长边不得超过 **2000 px**。
    - **存图与累积**：DSH 归一化存图规则为总像素 2048×2048、最长边 8192，导致常见并排对比截图（如 2904×1272）被原样落盘存储。会话历史不断累加图片，一旦总数 >20 且存在宽图，整轮请求即报 400，且后续轮次及派生（fork）会话均无法自行恢复。
  - **修复方案**：
    - **动态上限决策**：`resolveRequestImages` 预先统计请求包含的图片总数（含重复附件及 `tool-result` 嵌套图片），超过 20 张时将最长边阈值收敛至 2000 px，否则为 8000 px。
    - **精准按需压缩**：仅对超限图片调用 Harness 的 `attachments.readImageRequest` 派生缩小版本；未超限图片保持原字节不变，确保提示缓存（Prompt Cache）前缀稳定。存储的原图及会话历史均不作修改。
    - **降级容错**：若无法获取缩小版本或派生结果依然超限，优雅降级为可见的 `[image unavailable]` 占位文本，避免整轮对话崩溃；用户主动取消（Abort）正常透传。
    - **老版本兼容**：兼容 peer 范围内 0.1.2-alpha.5 起各代 Harness（兼容旧版 `maxPixels` 与新版宽高目标参数，按未取整宽高比计算像素预算）。
  - **测试与验证**：新增 7 项边缘限制回归测试，并通过 34 张真实历史图片（含 3 张 2904×1272 截图）离线回放验证，超限图成功缩至 2000×876，其余 31 张原样发送。

- **[通用机制] 插件内上下文预算自愈恢复机制（400/422 重试）**
  - **适用范围**：Kimi Code、MiniMax Code、Command Code、Claude。
  - **工作机制**：
    - 当模型请求返回 HTTP 400 / 422 且明确报告了自洽的窗口、输入及输出 token 计数时，若当前输入仍能容纳且上游输出预留与实际发送上限一致，插件会自动保留全部完整消息与工具定义，**仅下调输出上限并自动重试一次**（预留 1024 tokens 余量，且至少保留 1024 输出 tokens）。
    - 普通生成请求与压缩摘要请求共用此恢复链路，无需修改 DSH 核心代码，亦不截断历史消息。
  - **边界保障**：显式 `thinking budget` 不满足时不强行重试；鉴权失败、限流、请求体超限、模糊计数及流式错误均维持原样报错。Kimi / MiniMax 的输入估算补齐了推理文本与工具调用参数计算。

- **[设置 / UI] 修复设置页「订阅服务」整页样式丢失（仅标签栏有样式，正文裸奔）**
  - **根本原因**：客户端插件系统的样式归属记账机制存在副作用。当其他模块 Materialize 时，会扫描并认领页面内所有未打标（`style:not([data-plugin])`）的 `<style>` 标签。当那个模块被重载或销毁时，会调用 `removeOwnedStyles` 批量删掉名下标签。本插件原先注入的 7 张独立样式表未打上 `data-plugin` 属性，导致被其他插件误认领并随之被删除，仅留存了聊天区的 `.../main` 样式表。
  - **修复方案**：
    - 新增 `src/client/common/plugin-style.ts` 中的统一安装器 `installPluginStyle(name, css, legacyId?)`。
    - 统一按 `data-plugin-css` 定位，创建或命中时均强制打上本插件的 `data-plugin` 归属标记；CSS 变更时直接更新 `textContent`，`disposer` 设为空操作以将样式表托管给文档生命周期。
    - 自动就地接管旧 bundle 残留在 DOM 中的未打标样式元素，杜绝重复注入和误删。
  - **验证**：新增 `test/client-style-ownership.test.ts` 5 项测试，断言 DOM 中无遗留未标记样式表，且模拟重载清理后能完整恢复。

- **[Ollama] 修复「同步模型列表」报 `Unexpected end of JSON input`（[#36](https://github.com/Aa728848/dsh-chatgpt-subscription/issues/36)）**
  - **根本原因**：
    - 并非 Ollama Cloud 端点或 Token 鉴权问题，而是插件自身的 `/ollama/api` 路由处理器未加全局 `try/catch` 保护。
    - 当底层设置落盘失败抛错时，DSH 内置 Web Server 会返回一个完全没有 Body 的空 HTTP 400 响应（`res.writeHead(400); res.end()`）。前端卡片直接调用 `response.json()` 解析空响应体，触发原生语法解析异常，掩盖了真实的报错原因。
  - **修复方案**：
    - **服务端兜底**：路由处理器全量增加 `try/catch`，统一采用 `{ ok: false, error }` 规范封包返回，并补齐 404 兜底与独立保护。
    - **精细化错误诊断**：新增 `fetchCatalog()`，区分 `auth`（401/403，提供 API Key 链接）、`upstream`（上游其他状态码）、`unreachable`（DNS/TLS/超时）、`malformed`（代理返回 HTML 等非 JSON 格式）；细化区分“未配置 Key”与“所有 Key 均在冷却中”。
    - **客户端安全解析**：前端改用先读文本再解析的策略，遇空响应体或非 JSON 格式时清晰展示 HTTP 状态码与 Content-Type，杜绝原生异常弹窗。
  - **验证**：新增 12 条路由回归测试（包含写入中断断言）及 8 条客户端解析测试，测试全部通过。

- **[通用机制] 上下文超限错误归一化映射以支持 Harness 自动压缩**
  - **改进内容**：
    - 将 MiniMax、Kimi、Codex、Claude、Command Code 与 Antigravity 接入的 HTTP/SSE 上下文超限错误标准归一化为 `CONTEXT_WINDOW_EXCEEDED`。
    - 使得支持溢出自愈的 Harness 能顺利触发会话压缩与历史修剪，而非直接以 Provider 普通错误中断对话。
    - 鉴权、限流、配额不足及输出长度上限等错误保持独立归类；Command Code OpenAI 协议及 Antigravity 流内错误帧不再被静默忽略。

- **[Claude / Command Code] 修复登录时弹出两个一模一样授权页的问题（[#33](https://github.com/Aa728848/dsh-chatgpt-subscription/pull/33)）**
  - **根本原因**：
    - 授权窗口被前端与后端各触发了一次：前端设置卡片在 `/login` 返回后调用 `window.open(authUrl)`；而主机端 `/login` 路由在调用 `beginLogin` 时未显式传入 `openBrowser` 参数，触发了默认逻辑，在宿主机上通过系统命令（`cmd /c start` / `open` / `xdg-open`）再次拉起了浏览器。
  - **修复方案**：
    - 统一采用“仅在前端卡片打开”的交互范式，保留用户界面所在终端的 `window.open`（支持远程访问 GUI），主机端默认将 `openBrowser` 置为空操作，彻底消除双重拉起。
    - 经全线路审计：Antigravity、Codex 均已是单开，本次修复完善了 Claude 与 Command Code 两条线路。

- **[Codex] 修复响应流异常中断被误判为 `UNKNOWN` 导致拒绝重试（[#32](https://github.com/Aa728848/dsh-chatgpt-subscription/issues/32)）**
  - **根本原因**：
    - 底层 Undici 连接在流消费阶段异常断开时抛出无 Code 的 `TypeError: terminated`（真实原因挂载在 `.cause`，如 `ECONNRESET`）。
    - 错误经过适配器边界时被默认归一化为 `code: "UNKNOWN"`，而 Codex 线路声明的可重试集合不包含 `UNKNOWN`，导致 `dsh-llm-retry` 放弃重试，一次网络微小中断即导致整轮任务失败。
  - **修复方案**：
    - 在 `ResponsesClient.stream()` 消费阶段补齐 `catch` 并由 `streamFailure()` 归类：非取消错误一律归类为 `TRANSPORT`，并将完整 Cause 链路提取至 Message（如 `Codex stream failed: terminated: read ECONNRESET`），成功命中可重试策略。
    - 即使流已产生部分 Chunk 也依然按可重试处理（由 DSH 将半截输出结算为已丢弃的 Attempt，重试会重新开启完整尝试，工具调用只在流正常结束时执行，安全无副作用）。
  - **验证**：新增 4 项流异常分类测试，断言 Undici 中断错误能正确识别为 `TRANSPORT` 并触发重试策略。

- **[Antigravity] 修复 Claude 普通文本回放碎片化导致触碰缓存上限**
  - **改进内容**：
    - 修复此前将每个 SSE 文本 Delta 都回放为独立内容块的问题。
    - 回放时仅合并相邻的纯文本 Part，保留签名、工具调用及其他元数据边界（Gemini 逻辑保持不变）。
    - 消除因数百个碎文本块触碰 Claude 20-position 缓存回看限制的问题，优化多轮对话缓存复用率。

- **[Antigravity] 修复 Claude 多轮对话报 `thinking.signature: Field required`**
  - **改进内容**：在请求回放时，自动将连续的思考分片与独立签名合并为结构完整的 Thinking Part；自动剔除缺少签名的残缺分片及跨模型残留 Reasoning，保留正常正文与工具调用。

- **[Antigravity] 新增 Claude Opus 5.5 / Sonnet 5.5 模型支持**
  - **改进内容**：
    - 对齐 `fetchAvailableModels` 实时目录，新增对应 `-low` / `-medium` / `-high` 推理档位路由。
    - 默认上下文窗口与输出上限沿用反重力 Claude 规范（1M / 64K）。用户可在设置中自主勾选启用。

- **[协议复核] 多线路 Provider 报文格式与并发闸门校准**
  - **改进内容**：
    - 校准 Command Code Responses 的真实事件标识、块索引与多模态报文；
    - 规范 Ollama 原生图片/工具参数传递、附件降级机制及工具历史格式；
    - 增强 MiniMax 原生回放的来源隔离与顺序保护；
    - 优化并发闸门控制逻辑，正确处理动态降限、正小数配额与取消竞争；Codex 改用请求本地释放句柄，不再由普通 429 误推断全局并发上限。

- **[思维保护] 修复思维坍塌保护（Reasoning Collapse Guard）构造非法消息导致会话损坏**
  - **问题现象**：触发推理坍塌守卫后，会话卡死且 DSH 提示「是否修复插件根因」。
  - **根本原因**：
    - 守卫构建续跑消息时使用了手写字面量对象 `{ role: 'user', content: [...] }`，缺少 `id` 与 `source` 属性。
    - DSH 在 `session.append` 时进行严格校验，抛出 `lacks an identified message` 及 `has invalid source` 异常，导致会话状态损坏并中断。
  - **修复方案**：改用官方 `createUserMessage()` 工厂函数，并附带本插件专用的 `dsh-chatgpt-subscription` source kind、`form: 'notice'` 标记与摘要信息，确保在全代际 DSH 运行环境中均完全合规。
  - **测试**：新增集成用例，将守卫输出的消息送入真实 `adoptSessionEvent` 校验通过。

- **[压缩策略] 修复输出上限作为固定预留导致自动压缩失效（[#30](https://github.com/Aa728848/dsh-chatgpt-subscription/issues/30) / [#31](https://github.com/Aa728848/dsh-chatgpt-subscription/issues/31)）**
  - **改进内容**：
    - Kimi / MiniMax 不再将动态预算上报为固定的 `defaultMaxTokens`，改为在发送阶段动态计算并对齐上限，避免压缩器误扣固定额度。
    - 其余五条线路对齐 DSH 默认压缩策略，安全过滤过大的默认预留值，解决 Command Code（Kimi-K2.6、Grok 4.5/4.6）因预留过大导致无法触发压缩的问题。

- **[Codex] 对齐官方客户端默认参数：优化 Verbosity 并默认省略推理摘要以节省额度**
  - **背景与取证**：
    - 与官方 Codex CLI 随包模型表（`codex-rs/models-manager/models.json`）及真实会话报文严格核对：官方每个模型均声明 `default_reasoning_summary: "none"`、`default_verbosity: "low"`、`support_verbosity: true`。
  - **问题分析与修复**：
    - **额度浪费修复**：此前未配置时插件发送 `{ summary: 'auto' }`，而推理摘要属于计费输出内容，导致用户每轮对话都在产生额外计费。现修复为：未配置或选“无”时**完全省略 `summary` 字段**（对齐官方 `skip_serializing_if = "Option::is_none"`）；显式选择 `auto` / `concise` / `detailed` 时如实发送。
    - **详细度对齐**：此前未配置时不发送 `text` 字段，服务端会套用默认的 `medium`，导致生成文本比官方更啰嗦。现未配置时按目录默认发送 `low`。
    - **模型能力感知**：新增 `codexCatalogEntryById()`，仅对明确声明支持 `supportsOutputVerbosity` 的模型发送 `text.verbosity` 字段，避免向未知模型注入非法字段。
  - **测试**：新增 5 项官方契约回归测试，锁定默认参数与字段省略逻辑。

- **[Command Code] 同步官方 92 个新模型目录，补齐思考等级与多模态输入**
  - **根本原因**：
    - 插件内置能力表滞后（仅包含 74 个旧模型），而官方 CLI 注册表及实时 `/provider/v1/models` 端点已扩充至 92 个模型。适配器对未知模型采取保守回退策略（纯文本且无思考等级），导致 16 个真实在服模型丢失了图片输入和思考档位选择（如用户反馈的 `deepseek/deepseek-v4.1-flash-fast`，以及 `gpt-6-sol`、`claude-sonnet-5-5`、`xai/grok-4.7`、`z-ai/glm-5.3-flashx` 等）。
  - **修复方案**：
    - **重构能力目录**：完整同步官方注册表（覆盖 85 个实际服务模型），精确补齐上下文窗口、maxTokens 与思考档位；
    - **规范化思考关闭（off -> none）**：读取端将官方注册表的 `off` 映射为 DSH 标准的 `none`；向底层发包时彻底移除 `reasoning` 字段（该线路上游通过省略字段表示关闭思考）；
    - **防止 cross-model 400 报错**：设置页提供全局默认档位，但不同模型支持的档位不同；适配器发包前动态校验模型支持档位，若全局默认档位不被当前模型支持，自动回退到该模型自身的默认档位，杜绝上游拒绝。
  - **测试与验证**：新增实时模型覆盖与 `none` 字段省略断言，全量测试通过。

- **[Codex] 修复对话每轮报 400：移除上游拒收的 `max_output_tokens` 字段（[#29](https://github.com/Aa728848/dsh-chatgpt-subscription/issues/29)）**
  - **根本原因**：
    - 插件在请求未指定 `maxTokens` 时会自动补上模型上限并发送 `max_output_tokens` 字段。然而订阅版 Responses 对话端点会直接拒绝该字段（返回 `400 Unsupported parameter: max_output_tokens`）。
    - 经查阅官方 Codex CLI 源码（`ResponsesApiRequest`），官方客户端在对话时**从不发送**此字段；发它是插件早期的冗余实现。
  - **修复方案**：
    - 在 `buildResponsesPayload()` 中彻底删除 `max_output_tokens` 写入，生成长度交由服务端默认行为决定（与官方 CLI 一致）。
    - 适配器内部仍正常上报 `defaultMaxTokens` 供 DSH 本地用于计算压缩窗口预算（不出进程）。
  - **测试**：重写契约测试，断言对话报文绝不携带 `max_output_tokens` 字段。
  > ⚠️ **历史说明**：更早版本中“修复声明了输出上限却从不发送”的条目已被推翻，确认对话端点不可发送该字段。

- **[Codex] 修复模型选择器在部分套餐（如 Prolite）下显示为空的问题**
  - **根本原因**：
    - 接入实时模型目录后，插件将订阅接口返回的模型与用户勾选的可见模型取交集。
    - 部分订阅套餐（如 Prolite）的 `GET /backend-api/codex/models` 仅返回了代码审查相关的 slug（如 `codex-auto-review`），交集计算后导致列表为空。实际上该账号具备普通对话模型的可用权限。
  - **修复方案**：
    - 订阅目录依然作为可用模型的权威参考；但当交集为空时，**优雅回退至插件内置的模型表**，并按用户勾选进行过滤，确保模型选择器永不意外变空。
  - **测试**：覆盖空目录场景与有效目录场景的边界测试。

- **[MiniMax] 修复请求体 2 MB 本地虚假拦截与图片预算过小问题**
  - **问题现象**：会话进行到约 2 MB 时，插件在本地直接抛错拦截（`request was not sent: the serialized body is ... above the 2097152-byte ceiling`），请求根本未发出。
  - **根本原因**：
    - 插件原实现错误复用了 Kimi 线路的 `MAX_MESSAGE_BODY_BYTES`（2 MB）。2 MB 是 Kimi 网关自身的硬性限制，而 MiniMax 的 Anthropic 兼容端点支持数十 MB 的请求体。
    - MiniMax 允许单张图片 10 MB 原始数据，2 MB 的整包限制会导致单张合法图片即触发本地误拦截。
    - 类似地，图片预算原先也错误借用了 Kimi 的 1.5 MB 预算，导致合法图片被静默替换成了占位文本。
  - **修复方案**：
    - **独立上限**：将请求体上限调整为 MiniMax 自有的 `DEFAULT_MAX_MESSAGE_BODY_BYTES`（64 MB），并支持环境变量 `DSH_MINIMAX_CODE_MAX_BODY_BYTES` 自定义覆盖；
    - **放宽图片预算**：将单图预算调整为本线路自有的 `DEFAULT_MAX_REQUEST_IMAGE_BYTES`（16 MB），装得下 10 MB 单图并留足余量，支持 `DSH_MINIMAX_CODE_MAX_IMAGE_BYTES` 覆盖；
    - **横向审计**：对全仓库 7 条线路的请求体和图片预算进行了严格审计，明确各线路均根据对应网关的真实属性独立定义，避免不合理的跨线路继承。
  - **测试**：新增 7 项映射层测试，验证 >2 MB 真实请求体正常通过，失控请求依然被拦截。

- **[Claude / Kimi] 提示缓存时长（TTL）支持自定义配置（5 分钟 / 1 小时）**
  - **Claude 线路**：
    - 官方 Claude Code 订阅用户在额度内支持 **1 小时** 提示缓存 TTL（超出后降为 5 分钟）。此前插件仅发送默认 5 分钟的 `{ type: 'ephemeral' }`，未能享受到官方的 4 倍缓存窗口。
    - 现默认按订阅身份发送 `ttl: '1h'`，并同步附加授权 Beta 头 `extended-cache-ttl-2025-04-11`。设置页支持切换“跟随官方 / 1 小时 / 5 分钟”。
  - **Kimi Code 线路**：
    - 对齐官方文档，OpenAI 兼容协议支持 `prompt_cache_options`，Anthropic 兼容协议支持顶层 `cache_control`；默认未配置时不发送任何缓存字段。
  - **测试**：新增 11 条缓存 TTL 单元测试，覆盖不同协议与档位校验。

- **[Codex] 跟进上游第三方接入规范（Beta 头、统一 Originator、实时目录与多轮续传）**
  - **补齐 Beta 标头**：出站请求统一携带 `openai-beta: responses=experimental`；
  - **统一 Originator**：收敛各端点的 Originator 标识为单一的 `CODEX_ORIGINATOR`（统一为 `opencode`），避免登录与不同端点识别产生割裂；
  - **实时模型目录**：接入 `GET /backend-api/codex/models` 动态加载，支持 15 分钟单飞缓存与本地磁盘快照持久化，新模型发布无需频繁更新插件代码；未知模型保守回落，不臆造虚假能力；
  - **多轮提示续传**：支持发送 `prompt_cache_key` 并回传响应头 `x-codex-turn-state`，提升服务端前缀缓存命中与多轮对话续接效率；本地维护 LRU 缓存避免内存无界增长。
  - **测试**：新增 19 条测试，覆盖 Wire 标头、Originator 一致性、实时目录与状态回传。

- **[号池架构] 修复所有订阅线路共享号池的读-改-写竞态**
  - **根本原因**：此前各线路对号池的读写未实现跨异步操作的严格锁保护，当多并发请求触发 Token 刷新或设置更新时，后提交的事务容易覆盖先提交的新 Token、账号及冷却状态。
  - **重构要点**：
    - **严格原子事务**：账号增删、备注、主账号切换、冷却标记等操作均在统一锁内完成“读最新 -> 改 -> 写”闭环；
    - **非阻塞整池单飞**：令牌刷新采用按账号/凭据代际的独立单飞控制，网络 I/O 在锁外执行，避免死锁；
    - **条件写保护**：凭据写回严格比对发起时的版本代际，过时刷新结果直接丢弃，杜绝复活已删除账号或覆盖新登录凭据；
    - **落盘验证与记账解耦**：关键 Token 落盘后立即读回校验；最近使用时间等非关键记账失败不阻塞正常请求。
  - **测试**：新增并发冲突回归测试（`test/account-pool-concurrency.test.ts`）。

- **[Claude] 线路健壮性审计修复（综合 8 项）**
  - **账号重新登录写错存储**：修复“按账号重新登录”后将新凭据写入旧单账号文件而非号池行、导致死循环提示重新登录的问题；
  - **刷新令牌解析失败重发**：修复 HTTP 200 但响应体解析异常时重复重试消费型 Refresh Token 导致凭据失效的问题；
  - **登录轮询停滞**：修复卡片在轮询到 `exchanging` 瞬态时提前停止轮询的 Bug；
  - **空文本块防御**：对于纯图片的工具调用结果，自动填充 `(see attached image)` 占位文本，避免因空文本块被 API 拒绝；
  - **孤立代理项字符清洗**：工具输出按字节截断时若在 Emoji 中间断开，`JSON.stringify` 会产生未配对的代理项字符（`\uD83D`）；现统一清洗孤立代理项与 NUL 字符；
  - **403 权限错误误判**：上游返回无权限（如模型未包含在订阅中）时归类为 `PROVIDER_ERROR`，不再错误地将正常账号标记为失效踢出号池；
  - **模型目录分页**：请求模型列表时发送 `limit=1000`，避免默认每页 20 条导致可用模型截断；
  - **结束状态规范化**：`refusal` / `sensitive` 明确映射为错误，`model_context_window_exceeded` 映射为截断（`max-tokens`），杜绝误触发工具调用。

- **[Claude] 修复输出速度（TPS）与首字延迟（TTFT）统计虚高的问题**
  - **根本原因**：
    - DSH 统计 TPS 时将全部思考 Token 计入输出，且计算区间为“首个非空 Delta 到结束”。
    - 插件此前将全部 `thinking_delta` 缓冲到思考块结束才一次性发出，导致思考耗时被完全忽略，首字时钟直到回答阶段才开始计时，统计出的 TPS 达到正常值的 10 倍以上（如显示 1100 tok/s，实际仅 85 tok/s），且思考阶段界面无字白屏。
  - **修复方案**：
    - 思考块开始时即发出 `block-start`，每个 `thinking_delta` 到达时立即发出 `reasoning-delta`，实时流式更新；
    - 思考 Token 统计改用服务端下发的真实 `thinking_tokens` 计数，不再依赖“字符数/4”的粗暴估算。
  - **测试**：新增流式事件逐项断言，实测思考期间流式正常输出。

- **[Claude] 修复新账号使用 Claude Opus 5.5 提示词前缀变化后持续 400 报错**
  - **根本原因**：官方自 2026-08-31 起对 Opus 5.5 等模型强制执行思考前缀校验；一旦系统提示词、工具列表发生变动，必须在请求中显式携带 `block_binding: { prefix_mismatch_behavior: 'drop_block' }`，否则直接报 400。
  - **修复方案**：能力表中标记 `bindsThinkingToPrefix`，在 Adaptive 分支中为该类模型自动携带 `block_binding` 并附带 `anthropic-beta: thinking-binding-controls-2026-08-01` 授权标头。

- **[Claude] 支持 Claude Sonnet 5.5（`claude-sonnet-5-5`）**
  - **修复要点**：
    - 补齐本地能力表策展条目（1M 上下文、128K 输出上限、支持图片、不可关闭思考）；
    - 自动根据模型特征附加 `block_binding` 及相关 Beta 鉴权标头；
    - 申报默认 CLI 版本提升至 `2.1.285`（满足官方 >= 2.1.284 门槛）。

- **[Codex] 新增模型 GPT-6.1 Sol（`gpt-6.1-sol`）**
  - **模型规格**：1,050,000 上下文窗口、128,000 输出上限、支持图文输入；
  - **配置对齐**：归入 `gpt-6` 族 profile，默认思考档位 `medium`，支持 `low` 至 `max`（不支持 `none` / `minimal`）；默认加入可见模型列表。

- **[模型目录] 修复清空缓存后在途请求回写旧数据的竞态**
  - **修复方案**：为 `kimi-code` / `command-code` 模型目录缓存引入 `catalogCacheEpoch` 递增机制。清空缓存时递增 Epoch，在途的异步拉取请求若 Epoch 失配则放弃写入快照与恢复缓存，杜绝旧数据覆盖新状态。

- **[DSH 兼容] 跟进 DeepSeek Harness 0.2.0-rc.2**
  - 更新全部 `@deepseek-ai/dsh-*` 依赖的 peerDependencies 范围（追加 `|| ^0.2.0-rc.2`），更新基线并重新生成 package-lock.json；通过新旧基线多环境回归测试，无破坏性行为改动。

- **[MiniMax] 修复并发刷新导致的令牌失效与每小时频繁掉线**
  - **根本原因**：
    - Access Token 有效期仅 1 小时，续期窗口定在到期前 60 秒内。号池内部缺少并发单飞控制，用量轮询与模型请求容易在同一秒内同时触发刷新。
    - 输掉竞态的调用者收到 `invalid_grant`，导致错误地将正常账号标记为 `authStatus: expired` 永久失效，并在卡片上报“需要重新登录”。
  - **修复方案**：
    - **提前 5 分钟续期**：将刷新前置至到期前 5 分钟（`PRE_EXPIRY_REFRESH_MS`），避开临界失效窗口；
    - **全进程单飞锁**：引入以账号身份为键的单飞刷新注册表，所有并发调用共享同一次刷新事务；
    - **磁盘状态优先**：收到刷新失败时先重新读取磁盘凭据，若已由其他进程或单飞成功刷新，直接采纳新状态，不写入墓碑；
    - **账号行自我修复**：`healStaleAuthFailures` 在读取号池时自动比对并清除历史残留的错误失效标记；
    - **补齐重新登录按钮**：修复设置卡片上重新登录按钮在满足条件时未正确渲染的问题。
  - **测试**：新增 13 条抗并发争用测试（`test/minimax-code-token-contention.test.ts`）。

- **[思维保护] 新增推理坍缩守卫（Reasoning Collapse Guard）：死循环自动熔断与恢复**
  - **背景与现象**：长推理流可能退化为死循环重复短语（如 `Let me call. Go. Calling. Go.`），既不调用工具也不产出结论，一路消耗完上限（实测单会话烧掉 128,000 output tokens）。
  - **工作机制**：
    - **滑动窗口打分**：基于尾部字符的 n-gram 唯一率打分，坍缩流（重复度极高）得分高达 0.98，正常深思通常 <= 0.28，阈值设为 0.85，可在 1.5 KB 处迅速灵敏检测并中断；
    - **多级自愈恢复**：中断后在原会话中创建一条携带系统 Notice 形式的恢复消息，分三级恢复（首次静默续跑 -> 二次提示不要重蹈覆辙 -> 三次终止本轮退出）；
    - **安全无侵入**：接入 Harness 的 `llm/stream` waterfall 接缝（兼容 0.1.2-alpha.5 至最新版本），不改动请求上下文，不修改最大 Token 预算，默认开启且支持配置关闭。
  - **测试**：新增 29 条专项回归测试，通过真实归档坍缩样本与健康思考样本验证。

- **[MiniMax] 新增每日自动签到功能**
  - **功能简介**：自动领取官方桌面端“每日签到”积分（七日循环递增 400~2000 分）。
  - **技术实现**：
    - 完全复用本线路现有的 OAuth 凭据，对齐官方开源 CLI（`MiniMax-AI/minimax-code`）的签到网关与加密签名逻辑；
    - 国内区（`agent.minimaxi.com`）与国际区（`agent.minimax.io`）双区均支持；
    - 设置页增加“每日签到”卡片（支持开关、今日状态展示、连签天数统计与“立即签到”手动补签）；
    - 进程内定时调度，启动即签，每 10 分钟补检，幂等防重；状态落盘于 `minimax-code-checkin.json`。
  - **测试**：新增 22 项测试，覆盖双区端点、签名头算法比对、401 自动续签及跨天重置。

- **[DSH 兼容] 跟进 DeepSeek Harness 0.2.0-rc.1**
  - 更新 peerDependencies 基线，验证全量核心包源码与插槽契约兼容性；重新生成锁文件。

- **[MiniMax] 接入官方客户端用量与配额查询端点**
  - **端点对齐**：对齐官方 CLI 源码，接入 `/v1/api/openplatform/coding_plan/remains` 端点，自动探测并记忆国内/国际区网关；
  - **配额双窗口展示**：解析并独立展示 5 小时滚动窗口与每周窗口的剩余百分比、重置倒计时与使用量；
  - **诚实诊断与状态反馈**：若当前登录凭据受限于平台鉴权策略无法拉取用量，卡片如实提示“请在控制台或官方应用中查看”，杜绝模糊的“暂无数据”或错误归因。
  - **性能与防护**：状态接口轮询仅读取内存缓存，绝不在轮询时阻塞发网，避免卡顿；失败状态记忆 10~30 分钟。
  - **测试**：新增 17 条配额映射与缓存策略测试。

- **[MiniMax] 补齐与兄弟线路对等的号池与模型管理功能**
  - **供应商全局总开关**：关闭时立刻清空对外暴露的模型，彻底停用流量；
  - **模型自主勾选**：支持在设置网格中勾选/全选/取消特定模型，决定对话页可见列表；
  - **上下文窗口自定义覆盖**：每个已启用模型均可自定义容量（如 1M / 512K），支持一键恢复默认；
  - **默认思考深度配置**：支持设置全局默认思考等级，自动兼容模型固有支持范围；
  - **多账号池与桌面态导入**：支持多账号轮询/顺序耗尽调度；支持一键从本地 MiniMax Code 客户端只读导入凭据（桌面账号标记不可删除，续期自动原子回写）。

- **[MiniMax] 新增 MiniMax Code 编程订阅线路（PR #23 审计修复）**
  - **核心特性**：注册 `minimax-code` Provider，支持只读复用 MiniMax Code 桌面端凭据或通过 RFC 8628 设备码登录，请求走 Anthropic Messages 协议与 Bearer 鉴权。
  - **合并审计修复（10 项重要缺陷）**：
    - **① 消除 UI 文案串味**：解除错误的 `t` 函数全局注入，恢复独立的 i18n 字典，杜绝显示为字面键名或出现“使用 ChatGPT 登录”的错误文案；
    - **② 保护官方客户端登录态**：登出操作仅清除插件自有凭据，桌面端凭据标记为 `native: true` 禁止从插件侧撤销注销，防止误踢用户官方客户端；
    - **③ 规范路由挂载前缀**：纠正路由前缀为 `/minimax-code/api`，消除与其他线路的冲突；
    - **④ 修复 401 无法自愈**：遇到 401 时主动触发一次强制令牌续期并重试，自愈后恢复通信；
    - **⑤ 国际区凭据完整支持**：探测全部区域目录，并严格按凭据真实记录的区域决定 Host 端点；
    - **⑥ 消除明文备份凭据泄露隐患**：移除写回时复制出的 `.dsh-bak` 明文文件，改用纯原子重命名；
    - **⑦ 诊断信息安全脱敏**：将此前泄露真实 Token 前缀的报错改为输出 SHA-256 指纹截断；
    - **⑧ 修正虚假的多模态声明**：移除尚未具备解析器的 `video` 输入声明，仅声明实际支持的 `text` / `image`；
    - **⑨ 修复输出上限收敛空跑**：修复上下文夹取时未正确估算输入 Token 导致跳过收敛的缺陷；
    - **⑩ 优化性能**：移除无配额线路空转的 60 秒定时轮询，凭据读取操作合并为单次完成。
  - **测试**：新增 15 项审计回归测试，全量验证通过。

- **[团队协作] 适配 DSH Agent Teams：自适应协作与权限继承**
  - **根本原因**：Agent Teams bundle 在会话作用域内重载了同名的协调工具，顶替了内置的 `tool-subagent-control`，导致子代理回访异常；且 `spawn_teammate` 创建时不携带路由参数。
  - **修复方案**：
    - 将 `spawn_teammate` 纳入 `DEFAULT_SUBAGENT_INHERIT_TOOLS` 继承模式，继承 Lead 路由，防止被授权守卫硬性拒绝；
    - 优化 Preset 提示词，新增 R0.5 协作模式侦测及 R-T Teammate 协作规范，使模型能自适应普通子代理模式与 Agent Teams 协作模式。
  - **测试**：测试断言两种预设形态完全一致，继承权限判定准确。

- **[设置 / UI] 修复客户端样式表在 Fiber 热重载时偶发丢失**
  - **根本原因**：ChatGPT 样式表在卸载时执行 `element.remove()`，而在 Cordis Fiber 重启（如修改配置、HMR）时，新 Fiber 先运行看到旧标签返回空 Disposer，旧 Fiber 随后异步将标签从 DOM 彻底移除，导致样式表永久丢失。
  - **修复方案**：改为主样式表托管模式：标签归全局文档所有，存在则就地更新 `textContent`，Disposer 置为空操作，并在热更新时即时刷新 CSS 规则。

- **[Claude] 修复回复包含内容时 100% 失败报错（`must be losslessly JSON-serializable`）**
  - **问题现象**：每当模型输出文字、思考或工具调用时，整轮对话必定崩溃报错，提示 `Assistant stream chunk must be losslessly JSON-serializable`。
  - **根本原因**：
    - DSH 在会话日志落盘前会对流式 Chunk 进行严格无损 JSON 校验，遇到 `undefined`、非法数字、数组空洞等直接拒收整块消息。
    - 插件在 `mapper.ts` 中将文本块和工具调用的占位显式写为了 `state.replayBlocks[index] = undefined`，或解析参数失败时带入 `undefined`。
  - **修复方案**：
    - 将占位值从 `undefined` 修正为标准 JSON 合法值 `null`；
    - 新增 `jsonSafeValue()` 过滤管道，递归清洗非有限数字、-0、未定义字段及循环引用；
    - 类型系统收紧，将 `replayBlocks` 类型改为 `(Record<string, unknown> | null)[]`，在编译期杜绝 `undefined` 赋值。
  - **验证**：通过真实失败日志回放验证，7 种曾被拦截的流式形态全量测试通过。

- **[调度预设] 修复调度模式 R8 兜底状态卡死、不派发子代理的问题**
  - **根本原因**：
    - 调度模式在触发 R8 兜底（由主模型亲自执行）后，模型容易在对话历史中自我强化这一结论，导致即使当前任务已顺利结束，下一个新任务依然拒绝派发子代理。
  - **修复方案**：
    - **作用域限定**：明确 R8 兜底仅为**单任务级别**，绝非会话级状态；
    - **明确解除与恢复条件**：新任务开始时强制回到 R0 重新分诊，不得沿用兜底假定；触发条件收紧为“同一任务重派两次依然失败”；
    - **针对性解法**：对子代理上限超限（等待结算）和模型白名单拦截（显式指定模型）提供明确的修条件路径。
  - **验证**：Preset 与代码声明通过逐字节一致性校验及反模式拦截断言。

- **[Claude] 修复提示缓存命中率为 0（每次请求均全额计费）**
  - **根本原因**：Anthropic 提示缓存需要请求中携带 `cache_control` 断点，此前适配器虽然实现了标记能力但默认置为 `false`，导致从不发出断点，服务端无法命中缓存。
  - **修复方案**：
    - **默认开启缓存**：改为 Opt-out 机制，默认开启缓存；
    - **精准标记核心断点**：在符合 4 个断点上限的前提下，固定标记三处最关键的位置：System 块末尾、**最后一条 User 消息的最后一个块**（多轮历史复用核心）、最后一个工具定义；
    - **规范标记时机**：在合并连续消息之后进行最终标记，保证断点位置稳定，前缀无动态漂移。
  - **验证**：独立断言请求体断点分布，验证多轮历史复用断点正确生成。

- **[Claude] 修复 Claude Opus 5.5 因上报版本过旧被拒（`claude_code_version_too_old`）**
  - **报错信息**：`Claude Code 2.1.251 does not support this model; version 2.1.280 or newer is required.`
  - **根本原因**：插件向服务端硬编码申报的版本号为 `2.1.251`，而 Opus 5.5 要求客户端版本 >= `2.1.280`。
  - **修复方案**：
    - 申报版本更新为真实已发布的 `2.1.283`（后续推进至 2.1.285）；
    - 能力表引入 `minCliVersion` 门槛字段，发请求前在本地进行预检拦截，版本不满足时给出清晰的可操作提示，不再盲目向服务端发包；
    - 新增自动化测试守卫，确保全表所有模型的版本门槛均严格 <= 当前默认申报版本。

- **[Kimi] 修复设置卡片定期误报 `rejected the stored credential (401)`**
  - **根本原因**：
    - Access Token 有效期仅 900 秒（15 分钟），而前端卡片查询用量时直接携带了号池中已过期的 Access Token，导致上游返回 401 并被误判为“凭据被拒绝”；
    - 单账号镜像文件与号池同时刷新同一枚单次有效的 Refresh Token，引发跨路径轮换冲突，造成账号被误标为失效。
  - **修复方案**：
    - **号池接入实时凭据获取**：卡片用量查询改走号池的 `getFreshCredential()`，在临期前自动续期；
    - **401 强制刷新自愈**：收到 401 时主动发起一次强制续期并重试，只有二次 401 才判定为失效；
    - **解除镜像刷新耦合**：模型目录加载改用号池的活跃凭据，不再触碰单凭据镜像文件，消除竞态。
  - **测试**：新增 9 项凭据自愈与目录加载解耦测试。

- **[Claude] 移除「合规告知 + 确认门禁」限制**
  - **背景与改动**：
    - 彻底移除设置卡片顶部的显式确认告知框、`/claude/api/consent` 路由及主机侧 403 门禁，路由改为无条件自动注册；
    - 兼容用户磁盘已有的 `consent` 历史配置字段，不影响旧配置正常读取；
    - 保持条款风险的客观陈述，使用户开箱即用体验更加顺畅。

- **[Claude] 新增模型 Claude Opus 5.5（`claude-opus-5-5`）**
  - **规格说明**：1M 上下文、128K 输出上限、支持图片输入、思考档位支持 `low` 至 `max`；
  - **特性适配**：
    - 官方不支持关闭思考（显式关闭或设置 budget 均报 400），能力表标记为不可关闭思考；
    - 默认思考档位为 `medium`（避免被静默提升为 `high` 造成额外额度开销）。

- **[架构演进] Claude (订阅) 线路正式上线，替代原 GLM 线路**
  - **变更概述**：移除 `zhipu-coding-plan` Provider，新增 `claude-subscription` Provider，支持以 Claude Pro / Max 订阅的 OAuth 登录态直连 Anthropic Messages 接口（无需 API Key、不按量计费）；设置页相应标签替换为 Claude。
  - **核心架构实现**：
    - **OAuth 认证与安全**：对齐 Claude Code 官方身份块，采用独立随机生成的 PKCE Verifier 与 State，规避敏感参数泄露风险；
    - **思考模式分级处理**：严格支持 `mid-convo`（携带前缀绑定）、`adaptive`、`budget` 及 `none` 四类思考形态；
    - **多轮会话回放**：保留带签名的思考块（Thinking Signature）原样回放，剔除无签名残缺块，保障多轮工具调用稳定；
    - **账号管理与号池**：以稳定的内部 ID 作为路由键，支持多账号轮询与自动重试；支持只读收编本机 Claude Code 的已有登录凭据（快照模式，永不跨进程抢刷）；
    - **额度与用量监控**：双轨兼容已用百分比与统一限流响应头换算，卡片清晰展示用量进度与重置倒计时。

- **[DSH 兼容] 修复启动时报 `fiber state 5` 导致 web 模块未激活警告（[#18](https://github.com/Aa728848/dsh-chatgpt-subscription/issues/18)）**
  - **根本原因**：在具备透明代理/系统代理的环境下，插件在注册 Provider 后立即同步修改了 `web` 配置，导致 `web` 模块触发热重载（卸载中状态，即 Fiber State 5），与宿主 profile 合成审计产生启动时序竞态。
  - **修复方案**：将首次 Provider 状态同步推迟一个宏任务（`setTimeout(applyWebProviders, 0)`），确保其落在宿主审计之后，消除误报警告。

- **[DSH 兼容] 支持 DeepSeek Harness 0.2.0-rc.2 / 0.1.7-rc.2**
  - 对齐多项 Harness 核心组件更新，平滑兼容会话中途变更工具声明、模型选择器硬门槛校验及依赖生态演进。

- **[发布规范] 修复 npm `latest` 发布标签锁定问题**
  - 修正 `package.json` 中固定的 `publishConfig.tag`，确保稳定版本发布时默认进入 `latest` 分发通道，预发布版本显式通过 `--tag alpha` 发布。

- **[测试套件] 修复 Windows 环境下 DPAPI 超时与测试假失败**
  - 将 `vitest.config.ts` 的单测超时时间从 15s 放宽至 60s，并将最大并行 Worker 数限制为 4，彻底解决因子进程高并发争用导致的超时及跨用例 Mock 污染问题，实现全量测试稳定通过。

- **[模型配置] 模型上下文窗口跟随启用开关，并支持单行/批量恢复默认**
  - **按需展示**：上下文窗口配置仅展示当前已勾选启用的模型，未勾选时不产生冗余输入框；
  - **覆盖全量模型**：ChatGPT 标签页放开全部目录模型的上下文覆盖能力；
  - **恢复默认支持**：支持传入 `null` 删除特定模型的覆盖配置以恢复目录默认值；设置页提供单行“恢复默认”及全页“全部恢复默认”便捷操作。

## 0.8.0-alpha.0 - 2026-09-23

- **[发布说明] 0.8.0-alpha.0 预发布**：0.8.0 正式版定稿前作为预发布分发，仅发布至 npm `alpha` 标签，不影响 `latest` 默认安装。

- **[Codex] 新增模型 GPT-6 Sol 与 GPT-6 Luna（`gpt-6-sol`、`gpt-6-luna`）**
  - **规格支持**：支持文本 + 图片输入，默认思考档位 `medium`，订阅侧上下文上限 872K；
  - **族群 Profile 重构**：将 Astra 专属配置泛化为 `gpt-6` 族群共享 Profile，统一处理思考档位（收敛 `none` / `minimal` 至 `low`）；
  - **配置与输出上限**：默认有效上下文提至 384K，输出上限按模型区分（GPT-6 系列提至 128,000，老模型维持 32,768）。

- **[DSH 兼容] 深度适配 DeepSeek Harness 0.1.7-alpha.1（三处破坏性重写）**
  - **会话消息模型适配**：0.1.7 将工具结果改为一等的 `role: "tool"` 消息。新增 `llm-compat.ts` 作为双向兼容垫片，出站前自动归一化，既有 5 条线路的 Mapper 逻辑无缝保持兼容；
  - **设置 API 重构**：0.1.7 废弃 `settings.register`，改为从插件配置动态生成表单。新增 `file-preferences.ts` 支持将设置落盘至独立文件，并无缝自动迁移老用户的 `settings.yaml` 配置；
  - **Agent Preset 运行时注册**：适配 0.1.7 改用包声明行的机制，动态注册 `dispatch` 编排预设，避免老版本加载崩溃。

- **[社区 PR 合并与优化] 合并 PR #12、#14、#15 并修补潜在缺陷**
  - **#12**：macOS 钥匙串在载荷包含本地化字符时安全解码十六进制字节；
  - **#14**：偏好设置 Store 在无 `register` 环境下优雅回退至文件持久化并从文件水合，解决重启后模型开关重置的问题；
  - **#15**：合并多项通用功能优化与稳定性增强。

- **[Kimi Code] 优化模型选择器打开卡顿问题（从 800+ ms 降至 0 ms）**
  - **根本原因**：`loadProviderModels()` 在读取 30 分钟目录缓存之前调用了 `ensureAccessToken()`，而在 Windows 下读取 DPAPI 需要频繁 `spawn("powershell.exe")`。选择器构建时遍历每个模型调用，导致重复启动子进程阻塞主线程。
  - **修复方案**：将 Token 获取逻辑后置至缓存未命中的真实请求分支，命中内存缓存时直接零延迟返回。

- **[调度预设] 修复 0.1.6 环境下 Dispatch 预设挂载失败**
  - 兼容 Harness 0.1.6 对 Workflow 引擎的包名变更（`@deepseek-ai/dsh-workflow-ptc`），补齐多级 Node 依赖寻址。

- **[ChatGPT] 修复对话中执行网页搜索报凭据缺失的问题**
  - 拆分“号池取号”与“服务取凭据”逻辑，确保未被选入模型对话轮换的活跃账号依然能为 `codex-search` 提供合法的只读凭据。

## 0.5.0 - 2026-09-20

- **[号池架构] 全面支持多账号管理与轮换调度（覆盖全部四条线路）**
  - **共享号池内核（`account-pool.ts`）**：引入系统安全存储（DPAPI / Keychain / Secret Service），支持顺序耗尽（Sequential Drain）、轮询调度（Round-Robin）与粘性会话（Sticky Session）三种策略，提供 429 智能冷却与自动接力；
  - **多供应商覆盖**：将 Antigravity 的号池能力推广至 ChatGPT、Command Code 与 Kimi Code；
  - **容错增强**：最后使用时间记账等非关键写失败改为 Best-effort，杜绝因本地记账异常阻断正常取号。

## 0.3.9 - 2026-09-19

- **[多模态] 修复工具结果内嵌图像无法传递给模型的问题（PR #7）**
  - **根本原因**：三条线路此前仅检查消息顶层 Content，导致截图类工具结果内部嵌套的图像块在模型侧全部丢失，模型无法感知图片并容易产生幻觉。
  - **修复方案**：
    - 递归遍历 `tool-result` 中的图像附件；
    - Anthropic 协议支持块数组回传原生图片；OpenAI 协议在连续 Tool 消息段末追加包含 `image_url` 的 User 消息；Gemini 协议通过 `inlineData` 混合并入；
    - 读取失败时优雅降级为明确的 `[image unavailable: ...]` 占位文本。
- **[Antigravity / Kimi] 提示词优化与工具 Schema $ref 展开**：在系统提示词后置注入进度规则；递归内联工具参数的本地 `$ref` 引用。
- **[供应商管理] 支持自由停用供应商与清空模型列表（Issue #8）**：增加“启用此供应商”总开关，支持彻底清空模型以隐藏 Provider，不再挤占界面空间。
- **[Antigravity] 多账号池与双重调度策略上线**：支持管理多个 Google 账号，支持顺序耗尽与基于 LRU 的轮询调度，支持 429 自动冷却换号。

## 0.3.6 - 2026-09-17

- **[调度预设] 随包分发 Dispatch Agent Preset**：内置基于 PTC 模式的复杂任务编排预设（复杂度分诊、任务拆解与子代理指派）；子代理委派强制显式指定 Provider + Model。
- **[网络与代理] 修复透明代理（Fake-IP）环境下 `web_fetch` 失败问题**：
  - 自动识别并接管 Fake-IP（`198.18.0.0/15`）解析，由插件抓取 Provider 自行经由代理发送请求，避免被内置地址过滤硬性拦截；
  - 引入地址安全策略（`fetch-address-policy.ts`），防范私网穿透风险。
- **[多模态] Kimi Code 打通端到端视频输入**：支持视频媒体附件识别与解析，并在超限时采用最旧优先降级策略。
- **[Antigravity] 修复用户上传图片静默丢弃问题（Issue #5）**：正确将图片附件接入 Gemini `inlineData` 报文，杜绝模型回答“未收到图片”；引入 12 MiB 单次请求图片体积上限保护。
- **[Harness 兼容] 开发与测试基线升级至 DSH 0.1.5-rc.2**，重排模型能力展示表格。

## 0.2.15 - 2026-09-11

- 移除对 `@deepseek-ai/dsh-llm` 的冲突模块类型增强；
- 移除 Mapper 中不可达的 `file` 块处理；
- 移除未启用的智能体团队混合模型规则；
- 修复 Antigravity 新账号开通在候选端点全部失败时静默返回成功的缺陷；
- 修复登出时在途配额请求可能回写旧缓存的竞态问题。

## 0.2.14 - 2026-09-10

- 优化 Antigravity 配额自动刷新机制，对齐官方 2.8.0 规范；
- 完善代理探测逻辑，支持 `.env` 兜底识别。

## 0.2.13 - 2026-09-10

- 优化 Antigravity 开通与配额接口，增强网络容错与多平台适配。

## 0.2.12 - 2026-09-10

- Antigravity 登录对齐官方 2.8.0 User-Agent 格式，新增免费层资格校验与开通 LRO 轮询；
- 状态接口按 2 分钟 TTL 自动拉取配额，支持并发去重；
- 依赖版本区间扩展支持 DSH `^0.1.3` 至 `^0.1.5`。

## 0.2.10 - 2026-09-06

- 修复 Antigravity 模型元数据校验失败导致 Provider 整体消失的问题（安全兜底 `defaultEffort`，解决 `gemini-3.1-pro` 触发异常导致选择器丢失的问题，Issue #4）。

## 0.2.9 - 2026-09-06

- 修复在官方 DSH 0.1.2-rc.1 上启动因缺少 `CallId` 导出抛出语法错误的问题（采用 `toToolCallId` 动态兼容垫片，Issue #4）；
- 修复搜索与抓取来源切换在重载时未能正确生效的问题；
- Codex 订阅新增 `gpt-6-astra` 模型，支持 `low` 至 `max` 思考档位；提供独立上下文容量设置。

## 0.1.28 - 2026-08-28

- 新增支持 1.5x 倍速快速模式（Fast Mode / Priority Service Tier），请求注入 `service_tier: 'priority'`；
- 修复偏好设置更新白名单校验，持久化保存快速模式开关。

## 0.1.21 - 2026-08-22

- 适配 DSH `0.1.1-rc.2` 的新循环机制，适配器显式实现 `prepareCall`；
- 全量提升依赖版本至 `^0.1.1-rc.2`，增强无 BOM 的 UTF-8 编码与完整性检查。

## 0.1.20 - 2026-08-22

- 新增独立的子代理全局设置页，支持配置模型、思考深度与上下文预算；
- 支持限制子代理最大嵌套深度（0–3）与并发活动数量；
- 新增 GPT-5.6 系列有效上下文窗口配置（默认 272K，最高 1M）。

## 0.1.12 - 2026-08-20

- 适配 DSH `0.1.0-rc.8`，升级依赖生态与客户端插槽声明。
