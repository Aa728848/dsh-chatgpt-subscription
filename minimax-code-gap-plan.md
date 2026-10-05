# minimax-code 线路：差异与改进计划（v2 · 已查官方文档）

- **上游**：`MiniMax-AI/minimax-code` @ `56221c1`　**我们**：`src/host/minimax-code/`
- **官方文档**：`platform.minimax.io/docs/guides/text-generation.md`、`/docs/guides/text-m3-function-call.md`

> **v2 修订说明**：v1 里 N2/N5/N7 三条结论有误，本版按官方文档更正，并作废两条基于 pi-ai 通用代码的错误推断。

---

## 〇、一条贯穿全文的因果

官方文档 **Thinking** 一节第一句：

> Thinking is **on by default and needs no configuration**.

**这条解释了一个关键现象**：我们发 `thinking: {type:'enabled'}`，思考照样生效。
那不是因为字段对，而是**模型默认就在思考**——我们那个字段很可能从一开始就被**忽略**了，
因此永远不会被证伪。这就是它能存活至今的原因。

---

## 一、N7′　thinking 字段整体错位（**已确定，官方文档）

### 文档原文

Anthropic 兼容协议的表格（text-generation.md）：

| 协议 | 思考深度字段 | 思考内容返回位置 |
| :- | :- | :- |
| Anthropic-compatible | **`output_config.effort`** | `thinking` content block |
| OpenAI-compatible | `reasoning_effort` | `reasoning_content` 字段 |

官方 curl 示例的请求体里**只有** `model` / `max_tokens` / `output_config` / `messages`，**没有 `thinking` 对象**。
effort 取值：

> `effort` accepts `low`, `medium`, `high`, `xhigh`, and `max`. … When omitted, the default is `max`.

### 与我们实现的逐项对照

| 我们发的东西 | 文档规定 | 判定 |
|---|---|---|
| `thinking: {type:'enabled'}` | 未文档化；默认已开，无需配置 | ❌ **多余未文档化字段** |
| `thinking: {type:'enabled', effort}` | effort 属顶层 `output_config` | ❌ **位置错误** |
| effort 值含 `'default'` | 只有 low/medium/high/xhigh/max | ❌ **非法值**（应为「省略即 max」） |
| always-on 模型不发任何字段 | 与文档一致 | ✅ **正确** |

### 改法

[mapper.ts:579-602](src/host/minimax-code/mapper.ts#L579-L602) 的 `thinkingFieldFor` 拆成两件事：

1. **删掉 `thinking` 对象**（M2.7 已经是这个行为，把它推广到 M3 / M3.1）；
2. 新增顶层 `output_config`：`{ effort }`，effort 取值域改为 `['low','medium','high','xhigh','max']`，
   去掉 `'default'`，**省略时整个字段不出现**（文档：省略即 max，不要显式写 max）。

改完后 [mapper.ts:818](src/host/minimax-code/mapper.ts#L818) 的 `{ thinking }` 换成 `{ output_config }`。
当初把它隔离进 `thinkingFieldFor` 就是为了「被证实时只改一处」——现在正是那一刻。

### 必须先确认的一点

**M3 能否关闭思考？** 文档只对 M3.1 明确：

> Thinking cannot be turned off. Sending `thinking: {"type": "disabled"}` or `effort: "none"` returns `400`
> `model "MiniMax-M3.1-Flash-Preview" requires adaptive thinking`

M3 没说。我们现在给 M3 标了 `thinking: 'toggle'` 并会发 `{type:'disabled'}`（[model-catalog.ts:133](src/host/minimax-code/model-catalog.ts#L133)）。
**M3 与 M3.1 同族，若 M3 同样不可关，我们这个 toggle 就是一个 400 开关。**
文档没写就不能断言，但**这是 N1′ 之外第二个必须实测的项**。

---

## 二、N1　`maxAttachments` 声明了但无人执行（**代码可判定**）

`maxAttachments` 全仓库只出现在 [model-catalog.ts](src/host/minimax-code/model-catalog.ts#L140) 的定义处；
mapper 只按**字节**兜底，**没有按数量截断**。M3 声明 9，贴 12 张图照样发。

**改法**：图片装配处按 `maxAttachments` 截断，复用现成的 `offloadOldestRequestImages`（最旧优先，
与字节预算同一套降级路径）。若不实现就**删字段**——不生效的上限比没有更危险，因为它让人以为有保护。

---

## 三、N2　~~M3.1 默认上下文该改保守档~~（**撤回，我错了**）

官方文档模型表：

| 模型 | 上下文 |
| :- | :- |
| MiniMax-M3.1-Flash-Preview | **1,000,000** |
| MiniMax-M3 | **1,000,000** |
| MiniMax-M2.7 / -highspeed | 204,800 |

所以：

- **M3.1 = 1M：文档支持我们**（我们 `contextWindow: 1_000_000`），v1 说要改成 512K 是**错的**；
- **M3 = 1M：我们写 512K 默认 + 1M 可选**，而文档说 M3 就是 1M —— 但这一条**先不要改**。

**原因**：文档是**平台 API**（`api.minimax.io` + 平台订阅密钥），我们走的是
**MiniMax Code 订阅端点**（`agent.minimax.cn/mavis/...`）。我们的 512K 抄自
`~/.minimax/config.yaml`——那是**这个订阅客户端自己的模型表**，比平台文档更贴近我们这条线路，
很可能反映的是**套餐权益**而非模型能力。

**改法**：先确认订阅侧 `config.yaml` 里 M3 的实际字段，再决定。**不盲改**。

---

## 四、N3　M3 附件上限 9 vs 上游 4（**仍需实测**）

平台文档的 Tool Use & Interleaved Thinking 一页**没有**附件数量限制，图像限制在图像 API 文档里，
覆盖不到订阅端点。**保持开放**，仍是「贴 5/8/10 张图实测」。

---

## 五、新增确证项：Interleaved Thinking（**我们已做对**）

官方 M3 文档：

> M3 natively supports Interleaved Thinking, enabling it to reason between each round of tool interactions. …
> **The key principle is to return the model's full response each time—especially the internal reasoning fields (e.g., thinking or `reasoning_details`).**

我们在 `52afc1e feat: replay minimax thinking blocks verbatim` 已经做到了逐字回放，
`minimax-thinking-replay.test.ts` 有 20+ 用例锁住。**✅ 与官方要求一致，不动。**

注意文档提到思考内容可能出现在 `thinking` **或** `reasoning_details` 两个字段。
我们在 Anthropic 线读的是 `thinking_delta`/`thinking`（[mapper.ts:1168](src/host/minimax-code/mapper.ts#L1168)）。
**若订阅端点改用 `reasoning_details`，我们会读不到**——这与 kimi 那轮的方言问题同源，
值得在实测时一并观察。

---

## 六、最终优先级

| 序 | 项 | 依据 | 可否立即做 |
|---|---|---|---|
| 1 | **N7′** 删 `thinking` 对象，effort 改顶层 `output_config`，去掉 `'default'` | 官方文档 | ✅ |
| 2 | **N1** `maxAttachments` 执行或删字段 | 代码 | ✅ |
| 3 | **N1′** M3 能否关思考 | 文档只覆盖 M3.1 | ⏳ 需账号 |
| 4 | N3 M3 附件上限 | 文档未覆盖 | ⏳ 需账号 |
| 5 | N2 M3 上下文 | 平台文档 vs 订阅 config.yaml 冲突 | ⏳ 需查 config.yaml |
| 6 | N4+N6 Files API + video | 已明确，工作量大 | 另议 |

### 附带必须补的测试

我 grep 过：**当前没有任何测试断言 thinking 请求字段**（`thinkingFieldFor|body.thinking|output_config` 零命中）。
现有 `minimax-thinking-replay.test.ts` 全部测的是**响应侧**回放，
所以请求体写错字段这件事**测试永远发现不了**——这正是它能长期存活的原因。

Phase 1 必须同时加：

- `output_config.effort` 的值域与省略行为（省略时字段不存在，而非写 `'max'`）；
- 请求体**不含** `thinking` 键；
- always-on / toggle / forced-effort 三种模式各自的请求体形状。

---

## 七、v1 的错误记录（保留以免重犯）

| v1 结论 | 错在哪 |
|---|---|
| effort 位置错，应改 `type:'adaptive'` | **位置对、类型错**。文档里根本没有 `adaptive` 这个取值；它是上游配置层词汇（`variants` + `requestPatch` 叠加在 pi-ai 之上），不是线上取值 |
| `type:'enabled'` 是实测过的 | 读错了自己代码的 measured 段。`f4686f1` 提交信息逐字写着「**Inferred**… the `thinking` object's exact shape」 |
| 应补 `budget_tokens` | 文档中不存在此字段（Anthropic 方言通用字段，MiniMax 未采用） |
| M3.1 默认上下文应改 512K | 文档说 M3.1 就是 1M，我们是对的 |
| N5 `reasoningSummary` | 对应 pi-ai 的 `display`，而该路径 minimax 不走，**不适用** |

**共同教训**：三次都是把「别处代码里出现了这个字符串」当成「它会出现在我们这条线路的请求体上」。
查证顺序应该是：官方文档 → 我们自己的实测记录 → 别的实现的同类代码（且必须确认它服务于同一端点）。

## 八、实施结果（Phase 1 已完成）

**N7′ thinking 字段更正** — 已落地：

- `thinkingFieldFor` 已删除，由 `outputConfigFor` 取代；
- 请求体不再出现 `thinking` 键；
- `output_config.effort` 落在顶层，取值域 low/medium/high/xhigh/max；
- 省略时整个 `output_config` 不出现（文档：省略即 max）；
- `index.ts` 的导出同步改名 `minimaxCodeOutputConfig`。

**N1 附件数量上限** — 已落地：

- 新增 `offloadOldestRequestImagesByCount`，与字节预算同样最旧优先；
- adapter 中与 `offloadOldestRequestImages` 串联，两者互不重复丢图；
- 模型未声明上限时**不猜**，原样放行。

**测试缺口** — 已补：新增 `test/minimax-code-request-shape.test.ts`（12 例），
锁定请求体形状与数量截断。这是本条线路**第一次**有测试检查请求字段。

验证：`tsc -b --force` + `tsc -p test/tsconfig.json` 绿；`vitest run` **2534 passed / 7 skipped**；`npm run build` 绿。

### 未做（保持开放）

| 项 | 为什么不做 |
|---|---|
| **N1′** M3 能否关思考 | 官方文档只覆盖 M3.1，M3 未说明。需实测；我们保留了关闭开关 |
| **N3** M3 附件上限 9 vs 4 | 平台文档未覆盖订阅端点的附件数量。需实测 |
| **N2** M3 上下文 512K vs 文档 1M | 两者口径不同（平台 API vs 订阅 config.yaml 权益），**不盲改** |
| N4+N6 Files API / video | 工作量大，另议 |


## 九、实测结果（2026-10-05，用已登录账号跑通三项）

探测脚本走插件自己的 `MinimaxCodeAccountPool` 取凭证、`modelRequestHeaders` 组头、
`messagesUrl` 定端点，请求形状与真实轮次一致。脚本已删除，凭证未打印。
端点：`https://agent.minimax.cn/mavis/api/v1/llm/v1/messages`（region: cn，池内 2 个账号）。

### N1′　M3 能否关闭思考 —— **能，我们的 toggle 是对的**

| 请求 | HTTP | output_tokens |
| :- | :- | :- |
| M3 不带任何字段 | 200 | 29（**思考了**） |
| M3 `output_config.effort='none'` | 200 | 10（**思考关闭**） |
| M3 `thinking:{type:'disabled'}`（旧形状） | 200 | 10（关闭） |
| M3.1 `effort='none'` | 200 | **thinking block 仍在** |

**M3 的关闭开关有效，且 `output_config.effort` 这个新形状比旧的 `thinking` 对象更干净**。
M3.1 忽略 `none` 并继续思考，与官方文档「M3.1 无法关闭思考」一致
（文档说返回 400，订阅端点更宽容，但**行为相同**：仍然思考）。
我们的 `forced-effort` 分支对 `none` 返回 undefined，即不设 effort、走服务端默认，**行为正确**。
**无需改动。**

### N7″　`output_config.effort` 是否真的生效 —— **生效，且差异巨大**

用一个需要真实搜索的题目（数一条单调路径，避开 0,0→3,3 路径上的未知方格）：

| effort | output_tokens | think_chars | 延迟 |
| :- | :- | :- | :- |
| low | 1103 | 3535 | 10.7s |
| low | 1312 | 4033 | 14.3s |
| max | **4000（撞上限）** | 15958 | 50.7s |
| max | **4000（撞上限）** | 16331 | 62.4s |

**约 3 倍思考量、4 倍延迟。字段确实被服务端读取。**

补充一个此前用简单题目测不出信号（输出长度 34~51，无规律）——**简单题在任何档位下思考量都相同**，
所以「无差异」不等于「无效」。

⚠️ **由此发现一个成本事实**：`max` 档在 4000 输出上限下就已经**触顶**。
而官方文档规定**省略 effort 即为 max** —— 也就是说，任何未指定档位的请求都会以最贵档位运行。
我们的 `defaultReasoningEffort: 'default'` 正是省略，因此**当前默认即最贵档**。
这是文档定义的行为（不是 bug），但值得作为一个产品决策复核：是否把默认降到 `high`。

### N3　M3 附件数量上限 —— **没有上限，我上一轮的 N1 改动是错的，已回退**

| 请求 | 结果 |
| :- | :- |
| M3 带 4 / 5 / 8 / 9 / 10 / 12 张图 | 全部 HTTP 200 |
| M3 带 20 张图 | HTTP 200 |
| M3 带 32 张图 | 网络失败（传输抖动，非服务端拒绝——48 张随后成功） |
| M3 带 48 张图 | HTTP 200 |
| M3.1 带 4 / 5 张图 | HTTP 200 |

**订阅端点对内联图片没有数量限制。**

`maxAttachments`（M3 为 9、M3.1 为 4）来自模型的 **Files API 能力块**
（`max_attachments_count`），描述的是**上传路径**，而这条线路**从不走上传**——
它和 `filesApiDocumented` 描述的是同一件事。

因此**上一轮把它当成本线路的限制去执行是错的**：那会丢掉 3~4 张服务免费接受的图片。
已回退 `offloadOldestRequestImagesByCount` 及其调用与测试，
并把字段文档改写为「Files API 的数字，本线路不上传」，与 `filesApiDocumented` 同等待遇。

**这也说明「声明了却没人执行」不总是 bug**——要先确认那个声明描述的是不是自己走的路径。

### N2　M3 上下文 512K vs 文档 1M —— **未测，需要烧大量额度**

要真正回答它，必须发一个接近 1M token 的提示（约 4 MB 文本），这是一次可观的额度消耗与耗时。
在未获明确授权前不做。本轮实测中服务对 4000 输出、48 张图、16K 思考字符均无异议，
说明账号状态健康，但**上下文额度是独立维度，不能由此推断**。

### 本轮最终改动

- **保留**：N7′ thinking 字段更正（已实测确认正确）
- **回退**：N1 附件数量截断（实测证明会丢掉可用图片）
- **新增**：请求形状测试（7 例，锁定 thinking 字段的最终形态）

验证：`tsc -b --force` + `tsc -p test/tsconfig.json` 绿；`vitest run` **2529 passed / 7 skipped**；`npm run build` 绿。

