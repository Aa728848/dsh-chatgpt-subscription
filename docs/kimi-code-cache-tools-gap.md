# Kimi Code 线路：缓存与工具设计的缺漏分析

配套：[总缺口分析](kimi-code-gap-analysis.md)。本文只谈**缓存**与**工具**两条线。

---

## 〇、先分清责任边界

上游 `kimi-code` 是**完整 agent**，拥有工具注册/选择/裁剪/压缩/缓存全栈。
我们是 **DSH 里的 provider 插件**，工具注册与压缩由 harness 拥有
（`packages/mcp/mcp-client`、`packages/compaction/compaction-tool-result-pruner`、`packages/llm/llm-pi-ai`）。

所以「上游有、我们没有」里有一部分**不是我们的缺口**。下面每条都标注了归属。

---

## 一、缓存

### 1.1 我们已经做到的（部分超过上游）

| 能力 | 位置 | 评价 |
|---|---|---|
| 双线缓存字段 | [mapper.ts:687-700](../src/host/kimi-code/mapper.ts#L687-L700) | ✅ 深度。OpenAI 线 `prompt_cache_options:{mode:'implicit',ttl}`，Anthropic 线**顶层** `cache_control`。注释写明「message 内的 cache_control 会被服务端忽略」——踩过坑的细节 |
| `prompt_cache_key` 纯从 sessionId 派生 | [mapper.ts:1494-1499](../src/host/kimi-code/mapper.ts#L1494-L1499) | ✅ 深度。注释解释了为何不能用首条用户消息：压缩会改写它，整个会话被静默路由到冷条目 |
| 前缀稳定性指纹 + 漂移归因 | [mapper.ts:2170-2190](../src/host/kimi-code/mapper.ts#L2170-L2190) | ✅ 7 种 `PrefixDriftCause`。注释甚至注明对应上游的 `systemPromptHash`/`toolsHash` 遥测 |
| 动态工具位置稳定 | [mapper.ts:1284-1297](../src/host/kimi-code/mapper.ts#L1284-L1297) | ✅ `flushSlots` 追加而非提升，保持缓存前缀 |
| 系统提示纯序稳定折叠 | [mapper.ts:851-857](../src/host/kimi-code/mapper.ts#L851-L857) | ✅ |
| `cacheReadTokens` 上报 | [mapper.ts:2260](../src/host/kimi-code/mapper.ts#L2260) | ✅ DSH `common/request-diagnostics.ts:62` 消费 |
| 命中率统计 | [mapper.ts:2246](../src/host/kimi-code/mapper.ts#L2246) | ✅ 上游只有 hint 提示，没有统计面板 |

### 1.2 缓存缺口

#### 🔴 C1　前缀稳定性追踪是**进程级单例**，并发下必然归因错误

三处模块级可变状态：

- [`lastPrefixSnapshot` — mapper.ts:2143](../src/host/kimi-code/mapper.ts#L2143)
- [`lastDriftCause` — mapper.ts:2193](../src/host/kimi-code/mapper.ts#L2193)
- [`cacheStats` — mapper.ts:2225](../src/host/kimi-code/mapper.ts#L2225)

`trackPrefixStability()` 写全局快照，[routes.ts:230-232](../src/host/kimi-code/routes.ts#L230-L232) 读全局漂移原因。

**DSH 是多会话 + subagent 并行的。** A 会话写完快照，B 会话覆盖后，A 读到的漂移归因是 B 的；
`getLastDriftCause()` 返回的可能是完全不相关的另一个会话的值。
这个功能在单会话下是对的，在真实多会话下**产出的是噪音**——比没有更糟，因为人会去信它。

**修法**：状态按 `sessionId` 建 Map，或直接挂到已有的 `KimiCodeStreamState`（它本来就是 per-request 的）。

#### 🔴 C2　缓存统计跨账号混合

`cacheStats` 全局累加。账号池下不同 region / 不同套餐账号的命中率混成一个数，
配额展示也无法归因到具体账号。对比：`getCachedQuotaFor(accountId)` 是**按账号**取的，
缓存统计却没有跟上这个粒度。

#### 🟠 C3　**没有缓存过期提示**（上游有，我们完全没有）

上游 [`evaluateCacheHint` — cache-hint.ts:27-38](kimi-code-upstream/apps/kimi-code/src/tui/utils/cache-hint.ts#L27-L38)：

```ts
const rule = config.config[modelId];
if (rule === undefined) return { kind: 'skip' };
const idleMs = input.now - lastActiveAt;
if (idleMs <= rule.cache_duration * 1000) return { kind: 'skip' };
if (totalTokens < rule.min_tokens_to_hint) return { kind: 'skip' };
return { kind: 'hint', idleSeconds, totalTokens };
```

规则来自**远端可调配置** `estimated_cache_duration`，per-model `{min_tokens_to_hint, cache_duration}`
（[cache-hint-config.ts:11-22](kimi-code-upstream/apps/kimi-code/src/utils/cache-hint-config.ts#L11-L22)，1 天持久缓存）。

**触发语义**：空闲超过缓存 TTL **且** 上下文大到重新处理才划算 → 告诉用户
「你的缓存已经过期，下一轮要重新处理 N 个 token」。

设计原则值得直接抄：**每个缺数据分支都 skip**——宁漏报不误报。

**我们的现状**：设了 TTL、发了 cache key，但**从不在缓存过期时告诉用户**。
用户在一个 500K 上下文的会话上空闲 10 分钟，会在毫无提示的情况下
付出一整轮重新处理的代价，而我们手里明明有 `lastActiveAt` 和上下文 token 数可以判断。

#### 🟠 C4　没有远端调优配置通道

上游有 `client-configs.ts`（POST `{name}` 取配置，1 天本地持久化 + `peek` 同步读缓存）。
我们所有阈值都是硬编码常量——Kimi 改了 TTL 策略或我们算错 `min_tokens_to_hint`，都得等发版。

#### 🟡 C5　`cacheWriteTokens` 恒为 0

[mapper.ts:2221](../src/host/kimi-code/mapper.ts#L2221) 注释自己写了 "always 0 on this route"，
但字段仍被统计和上报，容易让人误以为在追踪写入成本。建议要么删掉，要么在 UI 上明确标注不适用。

---

## 二、工具

### 2.1 我们已经做到的

| 能力 | 位置 | 评价 |
|---|---|---|
| `normalizeKimiToolSchema` | [mapper.ts:1013-1025](../src/host/kimi-code/mapper.ts#L1013-L1025) | ✅ **比上游深**。剥 `$schema`、**递归内联 `$defs`/`definitions`/`$ref`**、给 enum/const 补 type，带环检测 |
| 动态工具完整闭环 | [mapper.ts:1070-1136](../src/host/kimi-code/mapper.ts#L1070-L1136) | ✅ Symbol + 字符串双通道，`rehydrateMessageTools` 让声明**跨 JSON 往返存活** |
| 声明位置稳定 | 同上 + flushSlots | ✅ 缓存友好 |
| `clampToolCallId` 出入向对称 | 12 处调用点 | ✅ 无不对称 bug |
| 降级诚实 | [mapper.ts:1265-1269](../src/host/kimi-code/mapper.ts#L1265-L1269) | ✅ 动态工具被丢弃时插入明确 notice，而不是静默 |
| 并行工具调用 | [mapper.ts:1373-1380](../src/host/kimi-code/mapper.ts#L1373-L1380) | ✅ 连续 `role:"tool"` |
| stop 序列预检 | [mapper.ts:112-113](../src/host/kimi-code/mapper.ts#L112-L113) | ✅ 5 条 / 32 字节上限，**发之前裁剪**而非发出去吃 400 |

### 2.2 工具缺口

#### 🔴 T1　tool-call id **只截断，不去重、不净化字符**（双 bug）

[`clampToolCallId` — mapper.ts:97-99](../src/host/kimi-code/mapper.ts#L97-L99)：

```ts
export function clampToolCallId(id: string): string {
  return id.length <= 64 ? id : id.slice(0, 64)
}
```

**问题 A：截断会造出碰撞。** 两个 id 共享 64 字符前缀时被截成**同一个 id**，
后续工具结果会配到错误的调用上。两条成熟解法都在现成代码里：

- 上游 [`makeUniqueToolCallId` — tool-call-id.ts:105-119](kimi-code-upstream/packages/kosong/src/providers/tool-call-id.ts#L105-L119)：用 `_2` / `_3` 后缀递增去重，配 `usedIds` Set
- pi-ai 自己的 `createMistralToolCallIdNormalizer`（mistral-conversations.js:103-121）：`attempt` 循环 + `reverseMap` 双向映射，冲突则换种子哈希

**问题 B：不净化字符。** 我们把 DSH 产生的 id **原样透传**。对比两处现成实现：

- pi-ai 的 Anthropic normalizer：`id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)`
- 上游：`TOOL_CALL_ID_SAFE_CHARS = /[^a-zA-Z0-9_-]/g`（tool-call-id.ts:9）

若 DSH 侧 id 含 `.` `:` 空格，服务端可能拒绝整个请求，或 tool 结果匹配不上。

> **这是本次分析里最值得立刻修的一条**：两个 bug 都在同一个 3 行函数里，
> 而正确模式在**同一个 node_modules 和同一个上游仓库里各有一份现成实现**可以直接抄。

#### 🟠 T2　没有 tool 名去重　`归属待确认`

上游有 `toolDedupe`（`packages/agent-core-v2/src/agent/toolDedupe`）。
MCP 场景下两个 server 暴露同名工具 → 我们会发出重复声明，模型可能选错。

**但这条是否算缺口取决于 DSH core 有没有兜住**——需要单独查 `llm-pi-ai` 与 harness 的工具层。

#### 🟠 T3　没有工具 schema 预算与渐进裁剪

我们只在 `estimatedInputTokens` 里**统计**工具 schema 字符
（[mapper.ts:1230-1234](../src/host/kimi-code/mapper.ts#L1230-L1234)），超标不裁、只用于预算计算。
上游有 `toolSelect` / `toolActivation` / `toolPolicy` 做渐进披露。

我们有动态工具这个**机制**，但没有**何时该用**的策略——
即「工具 schema 涨到 N 字节就把一部分降级成 message-level 声明」这条规则不存在。

#### ✅ T4　`mergeConsecutiveUserMessages`——**这条不是缺口，别去补**

上游 [merge-user-messages.ts:13-16](kimi-code-upstream/packages/kosong/src/providers/merge-user-messages.ts#L13-L16) 明说：

> the projector deliberately preserves message structure for **lenient providers (OpenAI/Kimi)**
> that accept — and read more clearly — distinct turns, while strict providers normalize for
> their own protocol here.

只在 Anthropic / Gemini 那种 strict provider 的转换边界跑。
我们在 OpenAI 兼容线上，连续 user turn 是**合法且更清晰**的。补它反而会降低可读性。

---

## 三、修复优先级

| 序 | 项 | 工作量 | 理由 |
|---|---|---|---|
| 1 | **T1** tool-call id 净化 + 碰撞去重 | ~30 行 | 唯一会导致**工具结果配错**的 correctness bug；正确实现在 pi-ai 和上游各有一份可抄 |
| 2 | **C1** 前缀稳定性状态改为 per-session | ~40 行 | 当前并发下产出噪音，比没有更糟（人会信它） |
| 3 | **C3** 缓存过期提示 | ~60 行 | 用户可感知的成本事件；上游设计原则（宁漏不误）可直接照搬 |
| 4 | **C2** 缓存统计按账号 | ~20 行 | 复用已有的 `getCachedQuotaFor(accountId)` 粒度 |
| 5 | T2 / T3 | 待查 DSH core 后再定 | 可能已被 harness 兜住 |
| 6 | C4 / C5 | 小 | C5 建议直接删字段 |