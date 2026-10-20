# minimax-code 线路：上游差分与重新基线（2026-10-20）

- **我们**：`src/host/minimax-code/`
- **对照基线**：`56221c1`（2026-10-04）　**上游 HEAD**：`c21e88e`（2026-10-19），区间 23 个提交
- **本轮状态**：三条 P0/P1 已改完并验证；另有四条上游做法已记录、尚未实现

> **一句话结论**：上游这一轮最值钱的不是新功能，而是**三处「我们以为的」和「实际测到的」不一样**——
> ① 推理回传的**通道**由请求里的 `thinking` 对象决定，我们的 M3 请求从不带它，于是 M3 的推理被当成答案文本回传；
> ② MiniMax 的超限文案我们认不出，真超限时压缩恢复不触发；
> ③ 我们 effort 词表里那个自造的 `default` 档上游根本没有，而它恰好掩盖了「省略即最贵档」。

---

## 〇、上游是哪三份材料（别混成一份）

| 材料 | 是什么 | 本轮用途 |
| :- | :- | :- |
| `MiniMax-AI/minimax-code`（开源 CLI，npm `@minimax-ai/code`） | 官方客户端的源码 | 请求体形状、模型表、错误分类、压缩策略 |
| 同上仓库的**发布包 CHANGELOG** | 面向用户的行为变更 | git diff 里看不出来的运行时行为（413 恢复、流内超限、思考预算耗尽重试） |
| **models.dev 快照** | **真正的目录同步源** | 模型表与档位的第一手事实 |

第三份是这轮的关键。上游 `packages/shared/src/models-dev.ts` 写着：

```ts
const MODELS_DEV_BASE_URLS = {
  cn: 'https://filecdn.minimax.chat/public/models-dev',
  en: 'https://models.dev',
}
export const MODELS_DEV_CATALOG_SOURCE_URL = `${MODELS_DEV_BASE_URLS.en}/api.json`
```

而模型表自己的注释说得很直白：

> `// Shared first-run catalog; an existing remote snapshot remains authoritative.`

——**仓库里那份只是首启兜底，远端快照才是权威**。我们线路的模型目录此前是照抄「兜底表 + 订阅端点自己的 config.yaml」，
这轮把**快照**也拉下来对了账。

### models.dev 快照的 MiniMax 段（2026-10-20 拉取，4.4 MB）

| 模型 | `reasoning_options` | `limit` | `cost.tiers` |
| :- | :- | :- | :- |
| MiniMax-M3 | `[{"type":"toggle"}]` | context **1048576** / output **512000** | 一条 `type: context, size: 512000` 的**加价档**，外加 `context_over_200k` 加价 |
| M2.7 / M2.7-highspeed / M2.1 / M2 / M2.5 / M2.5-highspeed | `[]` | 204800 / 131072 | — |
| **MiniMax-M3.1-Flash** | **不在快照里** | — | — |

两条直接结论：

1. **整份快照里没有任何模型带 `default` 档**；harness 自己的档位词表
   （`off|minimal|low|medium|high|xhigh|max`，`packages/llm/llm-pi-ai/src/catalog.ts` 的 `THINKING_LEVEL_GATE`）也没有。
   我们那个 `default` 是**本地自造**的。
2. **上下文开大要加价**（>200K 加倍，512K 档再翻一倍）——这与上游兜底表给 1M 打的
   `contextWindowOptionHints: { "1000000": "higher_usage" }` 是一回事。
   M3.1 不在快照里，所以它那条「默认 512K + 1M 可选」只能从兜底表与 M3 的同类结构推。

### 上游 23 个提交的定性

**协议级 5 个**：`c21e88e`（M3.1 去掉 `-Preview`、成为托管默认模型）、`7682398`（修 `minimax_api` 路径上
`--effort` 被整段删除）、`1852771`（单请求图片上限 20）、`5b4e0a4`（错误分类新增 `request_too_large`/`context_overflow`）、
`c460f08`（删掉「超限后强制压缩再重发」，只留「超限不重试」；修压缩后 session id 丢失）。
**配置级 1 个**：`a79348f`（`contextManagement.compactionTriggerAt`）。其余 17 个是 runtime/UI/发版/文档级。

一个影响读法的事实：区间内 `third_party/pi-mono/packages/ai/src` **零改动**——
方言解析与请求构造层没变，所有协议改动都发生在上游自己的 payload 后处理层。

---

## 一、P0-1（已修）　我们认不出 MiniMax 的超限文案

### 证据

上游 `packages/shared/src/llm-error-classifier.ts:166-172` 写死了 MiniMax 的原话：

> MiniMax reports it as `invalid params, context window exceeds limit (2013)`, so the bare 2013 code
> (a generic invalid-params code) is not used.

把我们的 `src/host/common/context-overflow.ts` 的正则**原样复制出来实跑**：

| 报文 | 改前 | 上游 |
| :- | :-: | :-: |
| `invalid params, context window exceeds limit (2013)` | ❌ false | ✅ true |
| `context window exceeds limit` | ❌ false | ✅ true |
| `maximum context length is 200000 tokens` | ❌ false | ✅ true |
| `prompt is too long` | ❌ false | ✅ true |
| `context_length_exceeded` | ✅ true | ✅ true |

**差一个字母**：我们的 `exceeded` 分支要求 `exceeded`，MiniMax 说的是 `exceeds`。

### 后果

`classifyMinimaxFailure` 只有 `isHttpContextOverflow` 命中才给 `CONTEXT_WINDOW_EXCEEDED`。
认不出 → 落到普通 400 分支 → **DSH 拿不到压缩信号，会话卡死，用户只能手动 `/new`**。

### 已改

- 补 `context window exceeds limit`、`maximum context length`（带条件）、`prompt is too long`、`input is too long`；
- **读字段的位置也补了**：MiniMax 把同一个判定放在两个信封里（`errorReason` / `base_resp.status_msg`），
  检测器原来只读 `code`/`type`/`message`/`error`，所以就算正文认得出来也会漏；
- **刻意不匹配裸 2013**：我们自己把 2013 用在重置卡片（`reset-card.ts:71`）和 Files API 上传两处别的语义上；
- 「in bytes」不算超限：`prompt is too long in bytes` 是字节上限，压缩不回答它——
  这条是现有测试 `test/context-overflow.test.ts` 里**刻意**的反例，改宽时它当场拦住了我。

---

## 二、P0-2（已修）　M3 的推理走错了通道——这是本轮最重要的一条

### 实测（`scripts/probe-minimax-thinking-channels.probe.ts`，2026-10-20，同一模型同一提示）

| 请求 | 响应块 | 推理落在哪 |
| :- | :- | :- |
| **M3，不带 `thinking` 对象**（=我们改造前的形状） | `content_block.type = "text"` | **答案文本里**（"We need to find the expected number of…" 直接当正文回传） |
| **M3，带 `thinking:{type:'adaptive'}`** | `content_block.type = "thinking"` | **思考块**（`delta.thinking`） |
| **M3.1，不带 `thinking` 对象** | `content_block.type = "thinking"` | **思考块** |

三条结论：

1. **`thinking` 对象决定推理回传的通道**，不是装饰。官方文档说「思考默认开启、无需配置」、深度字段是顶层
   `output_config.effort`——这都���错，但当年被读成了「请求永远不带 `thinking` 键」。
2. **M3.1（强制思考）不需要这个对象**，它两种请求形态下都走思考通道——这正是上游 managed 路径
   （`local-turn-payload-transform.ts:443-460`）对 FORCED_ON 删掉 `thinking` 键、对 SWITCHABLE 保留它的原因。
3. **`output_config.effort` 管的是深度，不管通道**：两者可以并存。

### 影响

改造前，**M3 的每一轮回答都以一大段自问自答开头**（推理被当正文），而且
- harness 永远看不到 reasoning 块；
- 「逐字回放 thinking block」这条 Interleaved Thinking 要求**无事可做**；
- 推理正文计入输出预算。

### 已改

- `thinkingFieldFor()`：switchable 模型发 `{type:'adaptive'}`（关时 `{type:'disabled'}`），
  always-on 与 forced-on 不发；
- 端到端复验（`scripts/probe-minimax-new-shape.probe.ts`，用**新的 mapper 真实产出**的请求体）：

| 请求 | 响应块 | 结果 |
| :- | :- | :- |
| M3 默认 `thinking:{adaptive}` + `effort:max` | `thinking`，343 段 | ✅ |
| M3 `effort:low` | `thinking`，**137** 段 | ✅ 档位在同通道内可见生效（343 → 137） |
| M3 关 `thinking:{disabled}` | `text`，无思考块 | ✅ |
| M3.1 `effort:max` | `thinking` | ✅ |

---

## 三、P0-3（已改）　去掉自造的 `default` 档，默认显式 max

### 为什么

- models.dev 快照里**任何 MiniMax 模型都没有** `default` 档；harness 自己的词表也没有；
- 我们那个 `default` 是「调用方没选」的本地拼写，而**它从不上线**——官方文档说省略 effort 即 max；
- 于是「没选 = 最贵档」这件事对用户完全不可见，而模型卡片上还挂着一个永远选不中的假档位；
- 更糟的是 `effortForModel` 会把用户请求的 `low` **夹回** `default`，再由 `outputConfigFor` 丢掉 →
  **M3 的每一轮都在最贵档跑**。

10-05 那次实测（提交 `5a7774c` 的信息：`on M3 with HTTP 200`）显示 M3 接受档位，
low 与 max 差约 **3 倍思考量、4 倍延迟**（low 1103 tok / 10.7s，max 撞 4000 上限 / 50.7s）。

### 已改

- 词表 `MinimaxCodeReasoningEffort` = `low|medium|high|xhigh|max`，**`default` 移除**；
- M3 与 M3.1 都拿到五档，**默认档 = `max`**（明写，不再靠「省略」）；
- M2.7 / M2.7-highspeed **不给任何档位**（`reasoningEfforts: []`、`defaultReasoningEffort: null`）——
  恒定思考的模型不该挂一个假梯度；
- 未知档位（"turbo"）回落到模型默认档，而不是原样上线；
- 存量迁移：老版本存过的 `default` 读回来是 **null（=各模型自己的默认档）**，不会让设置文档变得不可读。

---

## 四、P1（已改）　M3.1 上下文重新基线：512K 默认 + 1M 可选

| | 改前 | 改后 | 依据 |
| :- | :- | :- | :- |
| M3.1 默认窗口 | 1,000,000 | **512,000**（1M 为可选） | 上游兜底表：`limit.context = 512000`，1M 在 `contextWindowOptions` 里并带 `higher_usage` hint；models.dev 的定价档显示上下文开大要加价（>200K 加倍、512K 档再翻倍） |
| M3 默认窗口 | 512,000（1M 可选） | 不变 | 同上，与 M3 对齐 |

我们 10-19 的实测只证明了 **1M 能用**，没证明它**是默认或免费**。现在两件事分开了：
能力仍在（用户可在设置卡里把窗口抬到 1M），默认按权益走。

> **未做**：设置卡目前不提示「1M 更费额度」。上游用 `higher_usage` hint 标了出来，值得跟进（见第六节）。

---

## 五、另外确认的两处「我们本来就对」

| 点 | 我们 | 上游 |
| :- | :- | :- |
| Files API 路径 | `/mavis/api/v1/llm/v1/files/upload` | 由 base URL 推导（剥 `/anthropic` 后缀 + `/v1/files/upload`）→ **推导结果一致** ✅ |
| Files API 细节 | `mm_file://`、TTL 43200s、purpose 两个取值 | 完全一致 ✅ |

所以我们拿到的 `50115 direct_route_not_configured` 是**路由裁决，不是路径拼错**——这条不用再查了。

---

## 六、上游发布包里另外四条值得借鉴的（**尚未实现**）

来源：npm 包 `@minimax-ai/code` 的 `CHANGELOG.md`（0.6.6 – 0.6.12），这些是 git diff 里看不出来的运行时行为。

| # | 上游做法 | 对我们意味着什么 | 代价 |
| :- | :- | :- | :- |
| 1 | **413 恢复**：请求因图多/字节多被拒 → 丢掉最旧的图**重发一次**（最新的图永远保留） | 我们对 413 没有专门分支（落到普通 400），也没有这条恢复 | 中 |
| 2 | **流内超限**：网关先回 HTTP 200、再在流里报 `Input is too long` → 不原样重发，直接进压缩恢复 | 我们的流内判定走 `isContextOverflow`，本轮已补 `input is too long`，但「200 之后流内拒绝」的处理要单独看 | 中 |
| 3 | **思考吃光输出预算**：模型在产出正文前就把输出用光 → 丢弃这次回答，用「请更简短地推理」重试，最多 3 次 | 我们目前是把这种轮次**报错**（`8f06318 report a turn that spent itself on reasoning`）；上游改成有界重试 | 中 |
| 4 | **`requestMedia` 编码预算**：图片统一缩到 2000px / base64 ≤ 4.5 MiB；被拒后重发只保留一半的图（`recoveryDivisor`） | 我们有字节预算（16 MB）但没有统一缩放，也没有「重发只留一半」的降级 | 低—中 |

另外，上游给 M3 的图片预算是 **20 张**（其它模型 100），而这是它**自定的策略常量**
（注释自认 "with headroom for gateways that count images differently"），不是端点限制——我们实测 48 张内联图全 200，**不采用**。

---

## 七、明确否掉的（免得以后重复讨论）

| 项 | 为什么不适用 |
| :- | :- |
| `contextManagement.compactionTriggerAt` | 压缩由 **DSH 宿主**决定，不是 provider 插件。若宿主侧将来要暴露，公式取 `provider-budget.ts:50-54`；**不要**取 `settings.ts:25-30` 那个 M3 专判 90%（上游自己两套算法不一致） |
| BYOK / Plugin V1 / TUI / cron | 与这条线路无交集 |
| 图片数上限 20 / `max_attachments_count` | 上游自定策略与客户端预算；我们实测订阅端点无内联图片数量限制 |

---

## 八、我们领先上游的地方（别被带退）

| 点 | 我们 | 上游 |
| :- | :- | :- |
| 模型改名兼容 | `RENAMED_MODEL_IDS` + `resolveMinimaxCodeModelId` | `c21e88e` 直接改目录键，**没有 rename map** |
| Files API 端点推导 | 实测出「剥 `/anthropic` 后缀」「必须去掉 `X-Msh-*` 头」 | 代码里查不到 |
| 图片超龄占位符、只改请求副本不改历史 | 有 | 有（一致） |
| `default` 不上线 | 不需要了（档位表里已无此值） | `!['','on','off','default'].includes(effort)` |

---

## 九、本轮改动清单与验证

**改动**

| 文件 | 改了什么 |
| :- | :- |
| `src/shared/minimax-code-contracts.ts` | 档位类型去掉 `default`；线级词表改为五档 |
| `src/host/minimax-code/model-catalog.ts` | M3/M3.1 拿到五档、默认 `max`；M2.7 系列无档位；M3.1 窗口 512K 默认 + 1M 可选；`effortForModel` 可空 |
| `src/host/minimax-code/mapper.ts` | 新增 `thinkingFieldFor()`；`outputConfigFor()` 改为带真实档位；请求体新增 `thinking` 字段；温度只在思考真正开启时丢弃 |
| `src/host/minimax-code/types.ts` | 路由级档位校验去掉 `default` |
| `src/host/minimax-code/adapter.ts` | 发布的档位阶梯去掉 `default`；无全局选择时发布模型自己的默认档 |
| `src/host/minimax-code/token-store.ts` | 读取时归一化，退役的 `default` 读成 null |
| `src/host/common/context-overflow.ts` | 补 MiniMax 超限文案；补 `errorReason`/`base_resp.status_msg` 字段 |
| `test/minimax-code-request-shape.test.ts` | 按实测重写（这份文件就是请求形状的锁） |
| `test/minimax-code-reasoning.test.ts` / `test/minimax-code-model-rename.test.ts` / `test/context-overflow.test.ts` / `test/minimax-code-settings-integration.test.ts` | 跟随新基线，并新增 MiniMax 超限与退役档位迁移的回归 |
| `scripts/probe-minimax-thinking-channels.probe.ts` / `scripts/probe-minimax-new-shape.probe.ts` | 证据脚本（通道对比 + 端到端复验） |

**验证**

- `npm run typecheck`：绿（host + test）
- `npx vitest run`：**4024 passed / 7 skipped**（248 个文件）
- `npm run build`：绿
- 端到端：见第二节的四行实测表

---

## 十、待办

1. **探针 3/4（贵）** —— 「故意超窗」以确定订阅端点回的是 400 还是 200 + `base_resp`，
   以及 M3.1 的窗口权益到底是 512K 还是 1M。两者都要大提示，**未获授权前不做**。
2. **第六节四条**（413 恢复 / 流内超限 / 思考预算耗尽重试 / requestMedia 预算）—— 按性价比排序，先做 3。
3. **设置卡提示「1M 更费额度」** —— 上游用 `higher_usage` hint 表达，我们还没有对应呈现。
4. **M3 的 output 上限**：models.dev 写 512000，上游兜底表写 128000，我们写 128000 —— 留作待查，不盲改。

---

## 十一、与上游 PR #62 的合并（同一天）

本轮收尾时仓库被快进到了 `4c8f388`（Merge pull request #62 from dustinmoon78/fix/minimax-code-effort-order），
它与我��未提交改动在 `adapter.ts` / `model-catalog.ts` 上撞车（stash pop 冲突）。

**那个 PR 做的是同一件事，但只做了一半**，而且方向与本轮一致：

| | PR #62 | 本轮 |
| :- | :- | :- |
| 强度表去掉 `default` | ✅ | ✅ |
| M3.1 的档位列表去掉 `default` | ✅ | ✅ |
| **M3 的档位列表** | ❌ 仍是 `['default']` | ✅ 五档 |
| **M2.7 系列的档位列表** | ❌ 仍是 `['default']` | ✅ 不给任何档位 |
| **`default` 是否还在类型里** | 还在（`defaultReasoningEffort: 'default'` 仍指向一个不存在的档位） | ✅ 整个移除 |
| 默认档 | 靠「省略即 max」隐式表达 | ✅ 显式 `max` |

它的核心论点与本轮完全一致：**`default` 不是档位，是「调用方没选」**，排在 `max` 之上会让
DSH 的选择器把它显示成最强档（`orderReasoningEfforts` 按强度排序，核心又把 `efforts[0]` 当最弱档读）。
本轮在此之上多做三件事：M3 拿到真档位、M2.7 不再挂假梯度、`default` 从类型里整个消失。

**合并时保留的上游语义**：`resolveDefaultEffort` 在「没有全局选择」时仍返回 `undefined`
（上游的用例 `ranks max as the strongest level, not the absence of one` 钉住了这一点）。
本轮原先改成「发布模型自己的默认档」，已改回——**线上请求完全相同**：
DSH 不发档位 → `effortForModel` 按目录解析出 `max` → 请求仍是 `{effort:'max'}`，
而模型卡片那一侧仍然显示每模型的默认档。改回上游语义是为了不和刚落地的上游决定分道扬镳。

---

## 附：一条运维观察

本轮探针中途发现：这台机器上的**原生 MiniMax Code 凭据目录 `~/.minimax/` 已经不存在**了，
但插件自己的号池（`~/.dsh/storages/minimax-code-pool.json.dpapi`，DPAPI 加密）仍然持有会话，
运行中的 DSH 也在持续刷新它。**这条线路现在靠自己的号池活着**——
探针因此改走 `MinimaxCodeAccountPool.getFreshCredential()` 取凭证，而不是裸的 `MinimaxCodeCredentialStore`。

这不是代码缺陷，但说明「原生凭据可被外部删除」这件事在本插件的生存路径上是常态，
账号池这条后备路径值得保留。
