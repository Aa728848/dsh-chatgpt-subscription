# 插件侧改动计划：Kimi Code 线路

范围：`dsh-chatgpt-subscription` 的 `src/host/kimi-code/` + `src/shared/kimi-code-contracts.ts` + `src/client/kimi-code/`。
依据：[总缺口分析](kimi-code-gap-analysis.md)、[缓存与工具缺漏](kimi-code-cache-tools-gap.md)。

验证基线：`npm run typecheck` + `npm test`。每个 Phase 独立可交付、可回滚。

---

## Phase 0 — 正确性 bug（先做，两条都影响结果正确性）　**✅ 已完成**

验证：`tsc -b --force` + `tsc -p test/tsconfig.json` 绿；`npx vitest run` **2483 passed / 7 skipped**；`npm run build` 绿。
新增 `test/kimi-code-phase0-ids.test.ts`（16 例）。

### 0.1　T1　tool-call id 净化 + 碰撞去重

**文件**：`src/host/kimi-code/mapper.ts:90-99`

现状只有截断。两个缺陷：截断可造出碰撞（两个 id 共享 64 字符前缀 → 工具结果配错）；不净化字符（`.` `:` 空格可能被服务端拒绝）。

**改法**：把 `clampToolCallId(id)` 升级为**每次请求内**的 normalizer，签名保持单参但内部走一个按会话生命周期的映射表。

1. 净化：`id.replace(/[^a-zA-Z0-9_-]/g, "_")`
2. 长度：`slice(0, 64)`
3. 去重：碰撞时用 `_2` / `_3` 后缀递增（参考上游 `makeUniqueToolCallId`）

**关键约束**：映射必须是 **request 内共享**的，不能每次调用重建。
目前 12 个调用点散布在 `buildOpenAIRequest` / `buildAnthropicRequest` / `processOpenAIStreamLine` / `processAnthropicStreamLine`，
是**纯函数**调用。两种落法：

- **A（推荐）**：normalizer 实例挂到已有的 `KimiCodeStreamState`（per-request），请求侧新建、流式侧复用
- **B**：模块级 `WeakMap` 按 `options` 对象键控——但 `buildRequest` 每次都新建 options，WeakMap 失效，不可行

走 A。`createStreamState(wire)` 已是 per-request 载体，扩一个字段即可。
请求侧需要把该 normalizer 从 state 传进 `buildOpenAIRequest` / `buildAnthropicRequest`（现在只传 `media`）。

**测试**：`test/kimi-code-mapper.test.ts` 加三例
- 70 字符 id 截断后仍 ≤64
- 两个共享 64 前缀的长 id → 结果不同
- 含 `:` / 空格 / 中文 的 id → 输出只含 `[A-Za-z0-9_-]`
- 同一 id 在请求与回程两侧得到**相同**结果（对称性回归）

---

### 0.2　P0-2　reasoning 键方言回写

**文件**：`src/host/kimi-code/mapper.ts:1866`（读）、`1416`（写）

现状：读 `reasoning_content ?? reasoning`，写**永远** `reasoning_content`。
上游用 `ReasoningKeyDialect` 记住对端实际说过的键并用同一键回写。

**改法**：加一个 `ReasoningKeyDialect` 等价物（参照 `reasoning-key.ts:67-88` 的语义），
入站观察三种键 `reasoning_content` / `reasoning_details` / `reasoning`，出站回写观察到的那个，默认 `reasoning_content`。
挂到 `KimiCodeStreamState`（与 0.1 的 normalizer 同一个载体）。

**注意**：[mapper.ts:1409-1415](src/host/kimi-code/mapper.ts#L1409-L1415) 注释说明 preserved thinking 依赖该字段存在才不报
"thinking is enabled but reasoning_content is missing"。方言错配正是打破这个不变量的原因，改完要回归该错误路径。

**测试**：`test/kimi-code-mapper.test.ts`
- 服务端回 `reasoning` → 下一轮回写 `reasoning`
- 服务端回 `reasoning_details` → 能被读出
- 从未观察到 reasoning → 回写仍是 `reasoning_content`（默认不回归）
- 现有 preserved-thinking 用例全部保持绿

---

## Phase 1 — 并发正确性　**✅ 已完成**

验证：`tsc -b --force` + `tsc -p test/tsconfig.json` 绿；`npx vitest run` **2493 passed / 7 skipped**；`npm run build` 绿。
新增 `test/kimi-code-cache-scope.test.ts`（8 例）；`test/kimi-code-mapper.test.ts` 的前缀稳定性用例改为按 session 断言（+3 例）。

**实施偏差（比计划更细）**：
- 漂移归因**只按 session**，不按 account —— `buildRequest` 发生在账号轮换选定**之前**
  （adapter:514 vs :559），此时 accountId 还不存在。这是请求级属性，按 session 才对。
- 缓存统计按 **session + account** —— 账号池会让同一 session 由不同账号服务，
  而每个账号在服务端各有一份缓存。
- 无 sessionId 的请求落进独立空串桶，不混入任何真实 session。
- 三个 Map 都有 256 会话上限（LRU 淘汰），避免进程内无限增长。
- **测试抓到一个实现 bug**：只给 sessionId 不给 accountId 时原实现做精确 key 查表，
  轮换过后所有条目都在 `"<session> <account>"` 键下，查不到任何东西。已改为按前缀汇总。

### 1.1　C1 + C2　缓存状态改为按会话/账号

**文件**：`mapper.ts:2143`（`lastPrefixSnapshot`）、`2193`（`lastDriftCause`）、`2225`（`cacheStats`）、`routes.ts:229-233`

三处模块级 `let` 在 DSH 的多会话 + subagent 并行下会互相覆盖，漂移归因指向别的会话。

**改法**：

| 原 | 新 |
|---|---|
| `lastPrefixSnapshot: PrefixStabilitySnapshot` | `Map<string, PrefixStabilitySnapshot>`，key = `options.sessionId` |
| `lastDriftCause` | `Map<string, PrefixDriftCause>` |
| `cacheStats` | `Map<string, KimiCodeCacheStats>`，key = `sessionId`（必要时复合 `sessionId:accountId`） |

`trackPrefixStability(options)` 处 `options.sessionId` 可用；`recordCacheStats(state)` 在 `closeStream` 内，
需要给 `KimiCodeStreamState` 加 `sessionId` 字段（`createStreamState(wire, sessionId)`）。
`getCacheStats()` / `getLastDriftCause()` 改为接收 sessionId；`routes.ts` 的缓存统计路由增加 sessionId 查询参数。

**必须处理**：sessionId 缺失的请求（`promptCacheKey` 已在这种时候返回 undefined）要有明确落点，
建议归到一个 `__no-session__` 桶并让路由读不到时返回 null，而不是静默混入。

**测试**：`test/kimi-code-mapper.test.ts` 交错两个 sessionId 的请求，断言各自快照独立；
`test/kimi-code-routes.test.ts` 断言按 sessionId 过滤。

---

## Phase 2 — 服务端声明驱动的能力　**✅ 已完成**

验证：`tsc -b --force` + `tsc -p test/tsconfig.json` 绿；`npx vitest run` **2522 passed / 7 skipped**；`npm run build` 绿；`npm pack --dry-run` 绿。
新增 `test/kimi-code-server-declarations.test.ts`（15 例）。

四项都落在 `client.ts` 的 `parseCatalogModel` 与解析后的 resolution helper：
- **P0-3** `supports_thinking_type` 三态 → `reasoningEffortsForEntry` 里 `only` 剔除 `none`、`no` 返回空；
  新增 `defaultReasoningEffortForEntry` 丢弃被三态剔除掉的默认值。
- **P1-1** `limit.input` / `max_input_tokens` → `maxInputTokens`；adapter 用 `min(window, cap)` 夹 prompt，
  **window 仍然管输出**。契约新增 `promptBudget`（永远有数，调用方不必判断）。
- **P1-2** `supports_tool_use` → 新增 `toolUseForEntry`（与 `dynamicToolsForEntry` 区分：
  前者是"完全不支持工具"，后者是"不支持消息级工具"），`supportsDynamicTools` 现在是二者的合取。
- **P1-3** `status: deprecated|alpha|retired` 直接从列表剔除。

**实施偏差**：P1-1 计划里写"需先查 DSH `GenerateOptions`"—— 实际不需要。
DSH 没有独立输入预算字段，但窗口是我们自己从 catalog 解析出来的，
所以在 adapter 里用 `min(window, cap)` 就够了，不碰 DSH 契约。

三项都在 `client.ts:225-267` 的 `parseCatalogModel`，一次改动一起做。

### 2.1　P0-3　`supports_thinking_type` 三态

**最高优先**。上游 `open-platform.ts:71,80-93` 解析 `'only' | 'no' | 'both'`，**优先级高于** `supports_reasoning` 布尔。

- `'only'` → 永远思考，UI 不得提供 off
- `'no'` → 不支持思考
- `'both'` → 可开关

我们只读 `think_efforts.valid_efforts`，对 always-thinking 模型会发出被拒的 effort。

**改法**：`parseCatalogModel` 增加三态解析，结果写进 `KimiCodeCatalogModel`；
当为 `'only'` 时从 `reasoningEfforts` 里剔除 `'none'`/off。
**活 listing 优先于静态目录**（沿用 [model-catalog.ts:56-57](src/host/kimi-code/model-catalog.ts#L56-L57) 已有的三态覆盖约定）。

**测试**：`test/kimi-code-capabilities.test.ts`

### 2.2　P1-1　独立 input 上限

上游 `kosong/src/catalog.ts:319-327` 把 `limit.input` 单独存为 `max_input_tokens`：
压缩用输入上限，补全预算用全窗口。
我们只读 `context_length`，K3 若窗口 1M 但输入上限更低会**过度发送**直到 400。

**改法**：`parseCatalogModel` 读 `limit.input` / `max_input_tokens` → `KimiCodeCatalogModel.maxInputTokens`；
`types.ts:209-214` 的 `maxOutputTokensFor` 与 `clampOutputToContext` 用它参与计算。
需要 DSH 侧确认能否拿到独立输入预算（**先查 `packages/llm/llm-pi-ai` 的 `GenerateOptions`**）。

### 2.3　P1-2 + P1-3　`supports_tool_use` 与 `status` 过滤

- `supports_tool_use` 缺失时默认 true，显式 false 则不声明工具（上游 `open-platform.ts:58-60`）
- `status` 为 `deprecated` / `alpha` 的模型不入列表（上游 `kosong/src/catalog.ts:123`），避免退役别名留在选择器里

**测试**：`test/kimi-code-catalog-cache.test.ts`

---

## Phase 3 — 用户可感知的成本事件　**✅ 已完成**

验证同 Phase 2。新增 `src/host/kimi-code/cache-hint.ts` + `test/kimi-code-cache-hint.test.ts`（14 例）。

### 3.1　C3　缓存过期提示
- 新增 `cache-hint.ts`：`evaluateCacheHint` 照搬上游判定（**每个缺数据分支都 skip**），
  阈值用本地常量（上游是远端配置），按 `KimiCodeCacheTtl` 分别取 5m / 1h 寿命。
- 新增 `markSessionActive`（adapter 每轮调用）提供 idle 基准，Map 有 256 会话 LRU 上限。
- 路由 `cacheHint` 字段 + 设置卡片 `dsha-warn` 横幅（中英文案）。
- 上下文大小取自该会话自己的 `cachedTokens + freshTokens`，不是全局数字。

### 3.2　C5　`cacheWriteTokens`
按原计划**保留字段**，改为在 `KimiCodeCacheStatsDto` 上加 `cacheWriteTokensNote:
'always-zero-on-this-route'`，明确标注不适用——形状与其它 provider 对齐，将来线路能统计写入时不必改契约。

### 3.1　C3　缓存过期提示

**文件**：新增 `src/host/kimi-code/cache-hint.ts` + `routes.ts` 一个读接口 + `src/client/kimi-code/` 提示 UI

**照搬上游 [`evaluateCacheHint`](kimi-code-upstream/apps/kimi-code/src/tui/utils/cache-hint.ts#L27-L38) 的判定**，
但**阈值先用本地常量**（C4 远端配置是独立议题，不在本期）：

- 复用 `types.ts:226-231` 已有的 `KimiCacheTtl`，默认 `'5m'`
- 需要 `lastActiveAt`（会话最后活动）与当前上下文 token 数
- **每个缺数据分支都 skip**——宁漏报不误报，这是上游的核心设计原则

**测试**：`test/kimi-code-cache-hint.test.ts`（新建）

### 3.2　C5　`cacheWriteTokens`

该线路恒为 0（[mapper.ts:2221](src/host/kimi-code/mapper.ts#L2221) 自述）。
二选一：删掉字段，或在 `KimiCodeCacheStatsDto` 上明确标注不适用。倾向后者——
它会随线路能力变化而生效，删掉是倒退。

---

## Phase 4 — 开放平台线路（~~不做~~）

> **决定（用户）：本项不做。** 保留记录以便日后重启，Phase 0-3 不依赖它。

### 4.1　P0-1　`kimi-platform` provider　*（暂缓）*

**依据**：`open-platform.ts:22-37` 定义了两个开放平台（`api.moonshot.cn/v1` / `api.moonshot.ai/v1`），
`allowedPrefixes: ['kimi-k']` 从 `/models` 大列表里筛出 K 系列。

**能复用多少**：`mapper.ts` 的两条 dialect 构建逻辑是通用的，主要差异只有三处——

| 差异 | 处理 |
|---|---|
| base URL | `https://api.moonshot.{cn,ai}/v1` |
| 认证头 | `Authorization: Bearer <api key>`（无 OAuth，无 `X-Msh-*` 身份头） |
| 配额 | 无 `/usages`、无 `/me`；`/models` 仍可用 |

**要新增**：`types.ts` 区域常量（与现有 `REGION_HOSTS` 并列）、一个 API key token store（可参考 `ollama/token-store.ts`）、
模型前缀过滤、设置 UI 区块（可参考 `OllamaSection.tsx`）。

**规模估计**：明显大于 Phase 0-3，建议单独排期，不要塞进同一轮。

---

## 暂缓（需先确认归属）

| 项 | 问题 |
|---|---|
| T2　tool 名去重 | 上游有 `toolDedupe`。**先查 DSH core（`packages/llm/llm-pi-ai`）是否已兜住**——若已兜住则不是我们的缺口 |
| T3　工具 schema 预算裁剪 | 上游有 `toolSelect`/`toolActivation`。我们只有机制没有策略；先确认 DSH core 有没有渐进披露 |
| C4　远端配置通道 | 上游 `client-configs.ts`。等 C3 上线、阈值需要远程调整时再做 |
| P2 服务端工具 / `chat_title` | 属于产品功能而非兼容性修复，另议 |

---

## 排期建议

| Phase | 内容 | 规模 | 依赖 |
|---|---|---|---|
| **0** | T1 + P0-2 | 小（~2 文件） | 无，可立即开工 |
| **1** | C1 + C2 | 中（mapper + routes + contracts） | 需先定 sessionId 传递方式 |
| **2** | P0-3 + P1-1/2/3 | 中（集中在 parseCatalogModel） | P1-1 需先查 DSH `GenerateOptions` |
| **3** | C3 + C5 | 中（新文件 + UI） | 依赖 Phase 1 的 per-session 统计 |
| ~~4~~ | ~~开放平台线路~~ | — | **不做**（用户决定） |

**Phase 0 是投入产出比最高的一段**：两个 bug 都在现有函数里，
正确实现在 pi-ai（`mistral-conversations.js:103-121` 的碰撞循环、
`anthropic-messages.js:926-928` 的净化）和上游（`tool-call-id.ts:105-119`、
`reasoning-key.ts:67-88`）各有一份可直接对照的实现。