# 设计：把「查不到」变成模型看得见的失败信号（空检索结果熔断）

> 状态：**待实施**
> 依据：本机 DSH 归档的 `session-9764f957` / `seq1626` 事故。已落地的 `reasoning-collapse-guard`（`src/host/reasoning-collapse-guard/index.ts`）只把 128,000 token 的损失压到约 1,500 字符，属兜底；本文处理真正的诱因。
> 与既有 guard 的关系：`reasoning-collapse-guard` 是**兜底**（解码层退化后的止损），本方案是**根治**（消除诱发退化的输入条件）。两者可独立实施，同时保留。

## 1. 事故与根因链

坍缩本身不是原因，是结果。完整链条（本机归档实测）：

| 环节 | 实测事实 |
|---|---|
| 前置 | `seq1528`–`seq1617`：**连续 11 次**工具调用检索同一个符号（`scopeManager` 的初始化位置） |
| 关键 | 这 11 次的 `tool/result` **全部 `isError: false`** —— 工具层每次都「成功」 |
| 但语义 | 返回的是 `AllScopes` 引用、CK2/HOI4 的命中、最后 `"reg": []` —— **全都不是要找的东西** |
| 后果 | 模型收不到任何红灯，只能继续搜；连续 11 次决策震荡（`Actually` × 8、`simpler` × 6） |
| 终局 | 进入无工具调用的纯思考空转，坍缩成 `Let me call. / Go. / Calling.` 循环，烧掉 128,000 output tokens |

**一句话根因**：空检索结果被报成成功，模型失去了「这条路走不通」的信号，于是把「找不到」误读成「还没找对」，一直找下去。

这与 deepseek-harness discussion #3819（reasoning/action 解耦导致的无限循环）是**同一个机制**：工具永远成功 → 没有失败反馈 → 模型在错误路径上持续加码。

## 2. 目标与非目标

目标：

1. 检索类工具**零命中时对模型可见地失败**，让模型拿到红灯。
2. 不改任何工具的正常语义：有结果就是有结果。
3. 跨全部支持世代可用（0.1.2-alpha.5 ~ 0.2.0-rc.1）。
4. 可关闭、可调、可按工具范围限定。

非目标：

- 不判断「模型找得对不对」——只判断「有没有命中」，语义正确性仍是模型的事。
- 不改 harness 核心包。
- 不改写工具返回内容（只在零命中这一种情况下追加结构化说明）。
## 3. 接缝选择（已逐 tag 核实）

| 接缝 | 跨世代签名 | 判定 |
|---|---|---|
| `tools/execute` | `(exec, next) => Promise<ToolExecutionResult>` | ✅ **采用**。8 个 tag 逐字节相同 |
| `tools/post-execute` | `(exec, result, next) => Promise<PostToolDecision>` | ✅ 可作二段 |
| `llm/stream` | 已用于 reasoning guard | ❌ 层次不对（流已发生） |
| `agent/assistant-stream` | 0.1.5 之前不存在 | ❌ 排除 |

`ToolExecutionResult` 是判别联合（`packages/core/tools/src/index.ts:572-596`）：

```ts
export interface ToolExecutionSuccess {
  readonly isError: false
  readonly value: JsonValue
  readonly content: ContentBlock[]
}
export interface ToolExecutionFailure {
  readonly isError: true
  readonly error: ToolFailure
  readonly content: ContentBlock[]
}
export type ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure
```

**`isError: true` 是一个合法可构造的结果**——这意味着「把空检索报成失败」不需要任何 harness 改动，纯插件侧即可完成。这是本方案可实现性的关键。

## 4. 实施

### 4.1 新增 `src/host/search-signal-guard.ts`

沿用本仓库既有风格：Context 接口**结构化声明**、不 import 世代绑定类型、接缝缺失时安装返回 `undefined` 而非让插件装载失败（与 `relay-probe.ts`、`reasoning-collapse-guard` 一致）。

```ts
export interface SearchSignalContext {
  tools?: {
    execute?: (
      exec: { name: string },
      next: () => Promise<GuardToolResult>,
    ) => Promise<GuardToolResult>
  } | undefined
  logger?: { warn(message: string): void } | undefined
}

export interface GuardToolResult {
  readonly isError: boolean
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>
}
```

### 4.2 判定「零命中」

不猜测工具语义，只认**三种可判定的空形态**，逐条保守：

| 形态 | 例子 | 判定 |
|---|---|---|
| 解析后是空数组 | `[]` | 判定为空 |
| 解析后是空对象 | `{}` | 判定为空 |
| 对象里全部值都是空结构 | `{"reg": [], "def": []}` | 判定为空 |
| 纯文本且 trim 后为空 | `""` | 判定为空 |
| 文本里含否定词 | `"not our ref"`、`"NO MATCH"` | **不判定**（太脆，误杀风险高） |

**关键取舍**：宁可漏判，不可误判。文本层的否定词检测明确**不做**——那是启发式，误杀一次正常检索的代价（模型收到假红灯）远高于漏判一次。

```ts
export function isEmptyResult(raw: string): boolean {
  const trimmed = raw.trim()
  if (trimmed === '') return true
  let parsed: unknown
  try { parsed = JSON.parse(trimmed) } catch { return false }  // 非 JSON 文本一律不判定
  return isEmptyStructure(parsed)
}
```

`isEmptyStructure` 递归：空数组 / 空对象为真；普通对象当且仅当**所有**值都为空结构；字符串、数字、布尔一律为假。
### 4.3 改造结果

命中判定时，把成功结果换成失败结果，并附一句模型能懂的话：

```ts
export const NO_MATCH_TEXT =
  'This search matched nothing. The pattern or symbol you searched for is not present '
  + 'in the searched scope. Do not retry the same search with minor rewording: either '
  + 'broaden to a different location, search for a caller of this symbol instead, or '
  + 'state that the definition you need does not exist here.'

function toNoMatchResult(): GuardToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: NO_MATCH_TEXT }],
  }
}
```

**为什么这样有效**：模型现在拿到的是 `isError: true` + 一条明确指令。它在下面三个动作里选一个（换位置、找调用方、承认不存在），**而不是第四次改写同一个搜索词**。这正是它在事故里缺的那个决策分支。

### 4.4 范围与开关

```ts
export interface SearchSignalOptions {
  /** 明确纳入判定的工具名模式；空 = 只用内置检索词表。 */
  include?: string[]
  /** 排除模式，永远不判定。 */
  exclude?: string[]
  /** 替换内置检索词表。 */
  searchTools?: string[]
}

export const DEFAULT_SEARCH_TOOLS = [
  'read', 'grep', 'glob', 'list', 'find', 'search', 'web_search',
]
```

默认表覆盖 harness 内建的检索类工具。**不在表内的工具完全不受影响**，所以这不是「给所有工具加噪声」。

### 4.5 注册

在 `src/index.ts` 的 `apply()` 中，与 reasoning guard 并列：

```ts
if (pluginConfig.searchSignalGuard !== false) {
  ctx.effect(() => {
    const dispose = installSearchSignalGuard(ctx as unknown as SearchSignalContext, searchOptions)
    if (dispose === undefined) {
      ctx.logger.warn('[dsh-chatgpt-subscription] search-signal guard skipped: no tools/execute seam')
      return () => undefined
    }
    return dispose
  }, 'dsh-chatgpt-subscription: search signal guard')
}
```

配置项 `searchSignalGuard?: SearchSignalOptions | false`，默认 `{}`（启用）。
## 5. 与 reasoning guard 的分工

| | search-signal guard（本方案） | reasoning-collapse guard（已落地） |
|---|---|---|
| 作用层 | 输入侧：让失败可见 | 输出侧：退化后止损 |
| 触发时机 | 工具零命中时 | 推理流坍缩时 |
| 依赖接缝 | `tools/execute`（全世代一致） | `llm/stream`（全世代一致） |
| 事故中的表现 | 本该在第 1 次落空就熔断 | 第 11 次落空后仍烧了 128k token |
| 单独是否够 | 大概率够 | 不够（只止损） |

**保留两者的理由**：本方案覆盖的是「检索落空」这一条已实证的诱因；坍缩还可能由别的路径引起（本次分析未穷尽）。兜底不该因为根治而移除。

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 误杀正常检索（把有结果的判成空） | 只认三种结构化空形态，文本层一律不判；`include`/`exclude` 可按工具收窄 |
| 正常工具返回恰好是 `{}` | 该结果对模型本就无信息，报成 no-match 是**改善**而非损害 |
| 影响非检索工具 | 默认表限定；不在表内完全不受影响 |
| 跨世代签名漂移 | 已逐 tag 核实 8 个世代一致；接缝缺失时静默跳过 |
| 与既有 guard 叠加过激 | 两者接缝不同（tools vs llm），无顺序依赖 |

## 7. 验收

单元测试（`test/search-signal-guard.test.ts`，无需网络、无需 harness 运行时）：

1. 事故那 11 次真实返回值的 fixture：`[]`、`{}`、`{"reg":[]}` 必须判为空；`"AllScopes 引用"` 这类有内容文本必须**不**判定。
2. 三种空形态各一例；反例至少五例（嵌套非空数组、数字 0、布尔 false、含否定词的文本、非 JSON 文本）。
3. 判定成立后 `isError` 翻转为 `true`，且 content 含 `NO_MATCH_TEXT`。
4. `include`/`exclude` 模式生效：表外工具的 `[]` 不被判定。
5. `dispose()` 还原原始 `tools.execute`。
6. 无 `tools/execute` 接缝时安装返回 `undefined`（不抛）。
7. 非法配置 fail-loud（沿用 reasoning guard 的约定）。
8. **回归锁定**：对本插件自有工具（`codex_image_generate`、`present` 等）的 `[]` 返回，必须**不**被改写，防止误伤。

集成验收：

- `npx tsc -b --force --pretty false`
- `npx tsc -p test/tsconfig.json --pretty false`
- `npm run build`
- `npx vitest run`（基线 1746 passed / 7 skipped，仅 6 条既有 Windows Antigravity 回调端口失败）

## 8. 未验证项（如实记录）

- **未在 clean room 实跑旧世代**。`tools/execute` 与 `ToolExecutionResult` 的签名已逐 tag 核实一致，但按本仓库 `.dsh/skills/dsh-harness-upgrade` §4 的要求，发布前仍应补一轮 0.1.5 与 0.1.2 clean room 验证。
- **误判率未量化**。方案基于事故样本 + 保守设计，上线后建议统计实际触发次数与后续是否真换路径，作为调参依据。
- 「否定词文本」明确不做，代价是**部分真实落空仍会漏判**（例如返回 `"no matches found"` 这种文本）。这类漏判由 reasoning guard 兜底。