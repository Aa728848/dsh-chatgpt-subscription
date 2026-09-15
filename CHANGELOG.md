# Changelog

## Unreleased

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