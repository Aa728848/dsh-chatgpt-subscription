# minimax-code 线路：能力边界活体探针（2026-10-20）

- **探针**：`scripts/probe-minimax-capabilities.probe.ts`
- **跑法**：`npx vitest run --config vitest.probe.config.ts probe-minimax-capabilities`
- **端点**：`https://agent.minimax.cn/mavis/api/v1/llm/v1/messages`（region=cn）
- **凭据**：`MinimaxCodeAccountPool.getFreshCredential()`（插件自己的号池；原生 `~/.minimax` 已不在本机）
- **请求体**：全部来自真实的 `buildMinimaxRequest`，除非某条 case 的存在意义就是「mapper 造不出来的形状」（空 body、畸形 JSON、故意错的 bearer），那种 case 在自己的证据行里写明 `HAND-BUILT`。

> **一句话结论**：这条线路**根本不回「模型不存在」这种报文**——不认识的模型 id 会被静默换成 M3 正常出流（HTTP 200）。
> 所以「按错误报文做模型下架自动摘除」**做不到**；能用的信号只有**流头里的 `message_start.message.model` 与请求 id 不一致**。
> 另外，Messages 端点的错误信封**没有 `base_resp`**，数字码 `2013` 只以文本形式嵌在 `error.message` 里。

---

## 〇、额度纪律与事实来源

| 约束 | 本探针怎么守的 |
| :- | :- |
| 不烧额度 | 提示词只有一句 `Reply with the single word ok.`；输出上限多为 32；**凡是被接受的请求，读几个字节就 abort**，不留它生成完 |
| 不遍历模型 | 只发指名的 id；号池目录硬编码，遍历一遍才是真正烧额度的形状 |
| 不测 512K 大请求 | `max_tokens: 512000` 只为问「**请求是否被接受**」，接受即中止，绝不等它吐 512K |
| 不打印机密 | 输出里没有 token / 邮箱 / 账号 id / 用户 id；正文一律过清洗：邮箱→`<address>`、UUID→`<id>`、JWT→`<token>`、≥32 位不透明串→`<redacted:32>`。`request_id` 实际就是被这条规则替掉的 |

---

## 一、每条 case 的原始证据

「被服务的模型」是流头 `message_start.message.model`；**它和请求的 model 是否一致，是本次探针最重要的一个观测量**（见第二节）。

| # | 请求形状（与 mapper 默认的差异） | HTTP | 被服务的模型 | 报文 / 字段 | 结论 |
| :- | :- | :-: | :- | :- | :- |
| Q4-a | M3，max_tokens=32，`thinking:{adaptive}`+`output_config:{effort:max}`（**完全不改**） | 200 | `MiniMax-M3` | SSE；块 `thinking`+`text` | 账号健康 |
| Q4-b | M3.1-Flash，同上不改 | 200 | `MiniMax-M3.1-Flash` | SSE；块 `thinking`+`text` | 账号健康 |
| Q1-a | 只换 id：`MiniMax-M2.5` | 200 | `MiniMax-M2.5` | SSE；块 `thinking` | **M2.5 是真模型**（models.dev 目录里有），只是我们没收录；端点照服务 |
| Q1-b | 只换 id：`modelless-probe-id-zzz`（不存在的串） | 200 | **`MiniMax-M3`** | SSE；块 `text` | **静默替换成 M3** |
| Q1-c | 只换 id：`MiniMax-M1`（真实老模型） | 200 | `MiniMax-M1` | SSE；块 `thinking`+`text` | 真老模型照服务 |
| Q1-d | 只换 id：`MiniMax-M3.1-Flash-Preview`（我们已淘汰的拼写） | 200 | `MiniMax-M3.1-Flash-Preview` | SSE；块 `thinking`+`text` | 旧拼写仍可用 |
| Q1-e | `model=""` | 200 | **`MiniMax-M3`** | SSE；块 `text` | 空 model 也被替换成 M3 |
| Q1-f | 不存在的 id + 显式关思考（`reasoningEffort:'none'`） | 200 | **`MiniMax-M3`** | SSE；块 **只有 `text`（无 thinking）** | 替换后的 M3 **按本次请求的形状**回答 → 确实是替换，不是「M3 只是默认标签」 |
| Q1-g | 不存在的 id + `max_tokens=512000` | 200 | **`MiniMax-M3`** | SSE；块 `text` | 替换后仍按 512K 校验通过 |
| Q2-a | `max_tokens=0` | **200** | `MiniMax-M3` | SSE 正常出流 | **0 不是非法参数**，端点接受 |
| Q2-b | `max_tokens=999999999` | **400** | — | 见下方字段清单（`(2013)`） | 唯一一条真正的「参数非法」 |
| Q2-c | 手搓 body `{}` | **400** | — | `{"type":"error","error":{"type":"invalid_request_error","message":"invalid params"}}` | 无数字码 |
| Q2-d | 手搓畸形 JSON `{"model":` | **400** | — | 同上，与 Q2-c **逐字节相同** | 无数字码 |
| Q2-e | 换掉 bearer（字面量假 token，body 不变） | **401** | — | `{"code":401,"message":"auth failed"}` | **唯一带顶层数字 `code` 的信封** |
| Q3-a | `max_tokens=128000` | 200 | `MiniMax-M3` | SSE；立即 abort | 接受 |
| Q3-b | `max_tokens=512000` | 200 | `MiniMax-M3` | SSE；立即 abort | 接受 |

---

## 二、Q1「模型已下架 / 不存在」到底回什么

### 结论：**没有这种报文**。测不到，因为它不产生。

四种「不该能调」的 id，没有一种换来非 2xx：

- 真模型但不在我们目录里（M2.5、M1）→ **200，且由它自己回答**；
- 我们已淘汰的旧拼写（M3.1-Flash-Preview）→ **200，且由它自己回答**；
- 纯乱写的串、空串 → **200，由 M3 回答**。

也就是说这条线路对模型 id 的策略是「**有路由就路由，没有路由就落到默认模型**」，而不是「拒绝」。这和 `/v1/models` 那条 `503 direct_route_not_configured` 是两回事：模型目录确实不可查，但**不可查 ≠ 不存在的 id 会被拒**。

### 那「下架自动摘除」还能不能做？能，但判据不是错误报文

唯一能区分「这个 id 没有被路由」的观测量是流头里的被服务模型：

| 观测量 | 含义 |
| :- | :- |
| `message_start.message.model` **== 请求的 model** | 这个 id **有路由**（不论它在不在我们的目录里） |
| `message_start.message.model` **!= 请求的 model** | 这个 id **没有路由**，请求被默认模型（本机为 M3）代跑 |

Q1-f 是这条判据的锚点：同一个不存在的 id，改带「关思考」后，回答的 M3 **真的没有思考块**——说明被服务的是「按本次请求参数运行的 M3」，而不是一个只把名字写回去的壳。

**代价与风险，必须先说清楚：**

1. 判据要发**一次真实请求**才能拿到，一次「摘除巡检」就是一轮 N 个模型 × 一次请求。这正是本文件开头拒绝的遍历形状。
2. 目前 n=3 个不存在的 id 全部落到 **M3**。这可能是「账号档位默认模型」，也可能是「cn 区域默认模型」——**没有换号/换 region 验证过**，别把它当成全局常量写死。
3. 反过来的风险更值得警惕：**「请求被替换成别的模型」不一定是坏事**。用户写了一个我们没收录但上游确实存在的 id（比如 M2.5），也会走到这条路上——但那不是「下架」。
4. 所以「自动摘除」按这条判据实现时，**只能用于「我们自己目录里列出来、但用户报错」的复核**，不能反过来当成「目录同步器」。

### 报文能不能被可靠识别为「这个模型调不了」？

**不能**。因为这种报文不存在。若硬按错误报文做判定，只会得到一个永远不触发的分支。

---

## 三、Q2 错误信封里数字状态码的位置

### 完整字段清单（**后续实现的唯一依据**）

这条端点上实测到 **两种互不相干的错误信封**，没有一个含 `base_resp`：

**信封 A —— 请求被拒（HTTP 400，`application/json; charset=utf-8`）**

```
$                      : object{type, error, request_id}   ← request_id 只在参数类错误上出现
type                   : string  = "error"
error                  : object{type, message}
error.type             : string  = "invalid_request_error"
error.message          : string  = "invalid params, model[MiniMax-M3] does not support max tokens > 524288 (2013)"
request_id             : string  = <redacted:32>          ← 32 位不透明串，与本探针的清洗规则撞上，已替掉
```

同信封的**短形态**（body `{}` 与畸形 JSON 都是这一份，逐字节相同）：

```
$                      : object{type, error}
type                   : string  = "error"
error.type             : string  = "invalid_request_error"
error.message          : string  = "invalid params"
```

**信封 B —— 认证被拒（HTTP 401）**

```
$                      : object{code, message}
code                   : number  = 401        ← 顶层数字码，本端点唯一一个
message                : string  = "auth failed"
```

（注：`types.ts` 记录的 `x-api-key` 写法回的是 `{"code":401,"message":"token is required"}`；同样是信封 B，只有 `message` 措辞不同。）

### 逐个回答提问

| 问题 | 实测答案 |
| :- | :- |
| 响应体里**有没有** `base_resp.status_code`？ | **没有。** Messages 端点的任何一条错误都没有 `base_resp`。那个信封只属于配额（`coding_plan/remains`）、Files API、reset-card 那几条**别的**路由（`types.ts:72`、`files-api.ts:17`、`reset-card.ts:76`） |
| 那数字码在哪？ | `2013` **只以文本形式嵌在 `error.message` 的括号里**（`...(2013)"`），是**文案的一部分，不是字段** |
| 401 的数字码在哪？ | 顶层 `code: 401`，纯数字，可直接读 |
| 能不能按数字码判定？ | **在 Messages 端点上不能**：没有承载数字码的字段，只能正则抓 `error.message` 里的 `(\d{3,6})` |

### 对「2056/2067 数字码判定」这条支线的直接影响

1. **前提不成立**：如果那条支线假定 Messages 端点会回 `base_resp.status_code`，它永远不会命中——该字段在这条路由上不存在。
2. 即便改成抓文案里的括号数字，**`2013` 也帮不上忙**：它是**通用「参数非法」码**，本次 `max_tokens` 超限、空 body、畸形 JSON 全都归它。仓库里 `context-overflow.ts:16` 已经因为同一个理由明确拒绝「用裸 2013 当判据」，这次实测从另一端证实了那个决定。
3. 所以 2056/2067 若真实存在，只能出现在**别的路由**（配额 / Files / reset-card）的信封里，或者以**别的措辞**出现在 `error.message` 中——**本次没有观测到任何一个 2056/2067**，这条列为「未测到」，不猜。

---

## 四、Q3 M3 的 `max_tokens` 上限到底是 128000 还是 512000

### 结论：两个都接受；**真正的硬上限是 524288**，由端点在拒绝报文里自报。

| 请求 | HTTP | 证据 |
| :- | :-: | :- |
| `max_tokens=128000` | **200** | 接受（读到第一个字节后 abort） |
| `max_tokens=512000` | **200** | 接受（读到第一个字节后 abort） |
| `max_tokens=999999999` | **400** | `invalid params, model[MiniMax-M3] does not support max tokens > 524288 (2013)` |

三条合起来是一个**夹逼**：`512000` 在界内、`999999999` 在界外，而端点自己把界写成了 `524288`（= 512 × 1024）。所以：

- 我们目录里的 **128000 不是错的，是保守的**；
- models.dev 的 **512000 也不是上限**，是「能过」的一个值；
- **524288 才是端点判定的阈值**，且这是本次唯一一次端点主动说出自己的数字。

### 「请求被接受」≠「上限就是它」

必须写清楚的三件事：

1. 本次只证明了 **`524288` 及以下是合法请求**，没有证明模型能**生成** 524288 个 token（那要真的跑满，属于烧额度，本次拒绝做）；
2. `max_tokens: 512000` 配一句极短提示词就被接受了——说明端点**不会**替你检查「输入 + 输出是否超出上下文」。它只校验 `max_tokens` 这个数字本身。
3. 因此把目录里的 `maxTokens` 从 128000 抬到 524288 是**可接受的请求**，但**不是**一个已验证的输出能力承诺。这条留给目录维护者决定，本探针只给事实。

---

## 五、Q4 当前订阅账号实际可用的模型（账号健康度）

只报告本次**实际用到**的模型，不做遍历：

| 模型 | 结果 |
| :- | :- |
| `MiniMax-M3` | **200**，正常 SSE（块 `thinking`+`text`） |
| `MiniMax-M3.1-Flash` | **200**，正常 SSE（块 `thinking`+`text`） |

顺带观测到（**不是**可用性结论，只是「端点没有把它拒掉」）：

| id | 结果 |
| :- | :- |
| `MiniMax-M2.5` | 200，由 **M2.5 自己**回答（块只有 `thinking`，32 token 上限下没轮到正文） |
| `MiniMax-M1` | 200，由 M1 自己回答 |
| `MiniMax-M3.1-Flash-Preview` | 200，由它自己回答 |

**这三条不能读成「这些模型可用」**：它们只说明端点愿意为这些 id 路由。是否在你的档位内、是否计费、是否稳定，本次一概没测。

---

## 六、没测出来的，以及为什么

| 项 | 状态 | 原因 |
| :- | :- | :- |
| 2056 / 2067 这两个数字码 | **没测到** | 两次探针、16 条 case 里一次都没出现。Messages 端点连数字字段都没有，不猜它长什么样 |
| 「模型被下架」的报文形状 | **测不出来，因为它不产生** | 4 种不可服务的 id 全部 200。这是结论，不是失败 |
| 被替换时落到的具体是「账号默认」还是「区域默认」 | **没测** | 需要换号或换 region（global）才能分开；本机号池只有 cn，换 region 要另一次登录 |
| 模型真能生成到 524288 输出 | **没测，且刻意不测** | 要跑满才是证据，那是真正烧额度的形状；用户明确禁止 |
| 额度用尽时的报文 | **没测** | 不能为了看报文去耗额度；额度是账号状态，不是可复现的实验条件 |
| 其它模型（M2.7 / M2.7-highspeed）的真实路由 | **没测** | 与本次四个问题无关，遍历即烧额度 |

---

## 七、复现

```powershell
npx vitest run --config vitest.probe.config.ts probe-minimax-capabilities
```

脚本每次跑完会打一张 summary 表（id / http / served / codes / fields / verdict），本文第一节就是它的直接输出。
`PROBE_MINIMAX_*` 环境变量**没有**用到：本探针的每个 case 都要求形状精确，可配置的旋钮只会让「这条证据对应哪次请求」变模糊。
---

## 八、附录：脚本的一次完整真实输出（节选，原文照贴）

**节选原则**：只省略了与其它 case 逐字重复的 §changed/request§ 行与成功流里重复的 §early event types§，其余**原样**。表里 §<redacted:32>§ 是脚本的清洗产物，原文那一段是本线路的 §request_id§。

```text
[probe] endpoint=https://agent.minimax.cn/mavis/api/v1/llm/v1/messages region=cn
[probe] ---- Q1-unknown-modelless-probe-id-zzz (Q1)
[probe]   changed: nothing but the model id: an id this subscription does not serve
[probe]   request: model="modelless-probe-id-zzz" max_tokens=32 stream=true messages=1 bytes=198
[probe]   http=200 content-type="text/event-stream; charset=utf-8" ms=2000
[probe]   ACCEPTED; abandoned after 895 chars (reachedEnd=true)
[probe]   served-model="MiniMax-M3" blockTypes=["text"] textChars=2 events=["message_start","ping","content_block_start","content_block_delta","content_block_stop","message_delta","message_stop"]
[probe] ---- Q1-unknown-thinking-off (Q1)
[probe]   changed: the unknown id from above WITH an explicit thinking-off effort, which M3 honours
[probe]   request: model="modelless-probe-id-zzz" max_tokens=32 stream=true messages=1 bytes=198
[probe]   http=200 content-type="text/event-stream; charset=utf-8" ms=1823
[probe]   ACCEPTED; abandoned after 895 chars (reachedEnd=true)
[probe]   served-model="MiniMax-M3" blockTypes=["text"] textChars=2 events=["message_start","ping","content_block_start","content_block_delta","content_block_stop","message_delta","message_stop"]
[probe] ---- Q2-max-tokens-absurd (Q2)
[probe]   changed: maxTokens=999999999 passed to the mapper with a one-line prompt
[probe]   request: model="MiniMax-M3" max_tokens=999999999 stream=true thinking={"type":"adaptive"} output_config={"effort":"max"} messages=1 bytes=257
[probe]   http=400 content-type="application/json; charset=utf-8" ms=146 bodyBytes=200
[probe]   body raw: {"type":"error","error":{"type":"invalid_request_error","message":"invalid params, model[MiniMax-M3] does not support max tokens \u003e 524288 (2013)"},"request_id":"<redacted:32>"}
[probe]   numeric fields: (none) | codes only in wording: (2013)
[probe]     $: object{type,error,request_id}
[probe]     type: string = "error"
[probe]     error: object{type,message}
[probe]     error.type: string = "invalid_request_error"
[probe]     error.message: string = "invalid params, model[MiniMax-M3] does not support max tokens > 524288 (2013)"
[probe]     request_id: string = "<redacted:32>"
[probe] ---- Q2-empty-object (Q2)
[probe]   request: raw="{}" bytes=2
[probe]   http=400 content-type="application/json; charset=utf-8" ms=100 bodyBytes=84
[probe]   body raw: {"type":"error","error":{"type":"invalid_request_error","message":"invalid params"}}
[probe]   numeric fields: (none) | codes only in wording: (none)
[probe] ---- Q2-malformed-json (Q2)
[probe]   request: raw="{\"model\":" bytes=9
[probe]   http=400 content-type="application/json; charset=utf-8" ms=108 bodyBytes=84
[probe]   body raw: {"type":"error","error":{"type":"invalid_request_error","message":"invalid params"}}
[probe]   numeric fields: (none) | codes only in wording: (none)
[probe] ---- Q2-wrong-bearer (Q2)
[probe]   http=401 content-type="application/json; charset=utf-8" ms=70 bodyBytes=36
[probe]   body raw: {"code":401,"message":"auth failed"}
[probe]   numeric fields: code=401 | codes only in wording: (none)
[probe]     $: object{code,message}
[probe]     code: number = 401
[probe]     message: string = "auth failed"
[probe] ===== summary =====
[probe] Q4-control-M3 | http=200 | served=MiniMax-M3 | codes=(none) | fields=message_start,ping,content_block_start,content_block_delta,content_block_stop,message_delta,message_stop | verdict=accepted; blocks=thinking+text
[probe] Q4-control-M3.1-Flash | http=200 | served=MiniMax-M3.1-Flash | codes=(none) | fields=message_start,ping,content_block_start,content_block_delta,content_block_stop,message_delta,message_stop | verdict=accepted; blocks=thinking+text
[probe] Q1-unknown-MiniMax-M2.5 | http=200 | served=MiniMax-M2.5 | codes=(none) | fields=message_start,ping,content_block_start,content_block_delta,content_block_stop,message_delta,message_stop | verdict=accepted; blocks=thinking
[probe] Q1-unknown-modelless-probe-id-zzz | http=200 | served=MiniMax-M3 | codes=(none) | fields=message_start,ping,content_block_start,content_block_delta,content_block_stop,message_delta,message_stop | verdict=accepted; blocks=text
[probe] Q1-retired-MiniMax-M1 | http=200 | served=MiniMax-M1 | codes=(none) | fields=message_start,ping,content_block_start,content_block_delta,content_block_stop,message_delta,message_stop | verdict=accepted; blocks=thinking+text
[probe] Q1-retired-MiniMax-M3.1-Flash-Preview | http=200 | served=MiniMax-M3.1-Flash-Preview | codes=(none) | fields=message_start,ping,content_block_start,content_block_delta,content_block_stop,message_delta,message_stop | verdict=accepted; blocks=thinking+text
[probe] Q1-empty-model | http=200 | served=MiniMax-M3 | codes=(none) | fields=message_start,ping,content_block_start,content_block_delta,content_block_stop,message_delta,message_stop | verdict=accepted; blocks=text
[probe] Q1-unknown-thinking-off | http=200 | served=MiniMax-M3 | codes=(none) | fields=message_start,ping,content_block_start,content_block_delta,content_block_stop,message_delta,message_stop | verdict=accepted; blocks=text
[probe] Q1-unknown-large-cap | http=200 | served=MiniMax-M3 | codes=(none) | fields=message_start,ping,content_block_start,content_block_delta,content_block_stop,message_delta,message_stop | verdict=accepted; blocks=text
[probe] Q2-max-tokens-zero | http=200 | served=MiniMax-M3 | codes=(none) | fields=message_start,ping,content_block_start,content_block_delta,content_block_stop,message_delta,message_stop | verdict=accepted; blocks=thinking+text
[probe] Q2-max-tokens-absurd | http=400 | served=- | codes=(none) wording=(2013) | fields=$ type error error.type error.message request_id | verdict={"type":"error","error":{"type":"invalid_request_error","message":"invalid params, model[MiniMax-M3] does not support max tokens \u003e 524288 (2013)"},"request...
[probe] Q2-empty-object | http=400 | served=- | codes=(none) wording=(none) | fields=$ type error error.type error.message | verdict={"type":"error","error":{"type":"invalid_request_error","message":"invalid params"}}
[probe] Q2-malformed-json | http=400 | served=- | codes=(none) wording=(none) | fields=$ type error error.type error.message | verdict={"type":"error","error":{"type":"invalid_request_error","message":"invalid params"}}
[probe] Q2-wrong-bearer | http=401 | served=- | codes=code=401 wording=(none) | fields=$ code message | verdict={"code":401,"message":"auth failed"}
[probe] Q3-max-tokens-128000 | http=200 | served=MiniMax-M3 | codes=(none) | fields=message_start,ping,content_block_start,content_block_delta,content_block_stop,message_delta,message_stop | verdict=accepted; blocks=thinking+text
[probe] Q3-max-tokens-512000 | http=200 | served=MiniMax-M3 | codes=(none) | fields=message_start,ping,content_block_start,content_block_delta,content_block_stop,message_delta,message_stop | verdict=accepted; blocks=thinking+text

 ✓ scripts/probe-minimax-capabilities.probe.ts (1 test) 22632ms
   Test Files  1 passed (1)
        Tests  1 passed (1)
```
