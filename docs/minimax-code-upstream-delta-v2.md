# minimax-code 线路：第二轮上游差分（2026-10-20）

- **我们**：`src/host/minimax-code/`
- **上游**：`MiniMax-AI/minimax-code`（MIT 开源）　**npm**：`@minimax-ai/code@0.6.12`（2026-10-15）
- **上一轮**：[minimax-code-upstream-delta.md](./minimax-code-upstream-delta.md)（上游基线 `c21e88e` / 2026-10-19）
- **本轮新增产物**：[minimax-code-probe-capabilities.md](./minimax-code-probe-capabilities.md) + `scripts/probe-minimax-capabilities.probe.ts`

> **一句话结论**：这一轮上游**没有能直接抄的新功能**；真正值钱的是**一次探针把我们一直当作前提的两件事测穿了**——
> ① 端点**不拒绝**它路由不了的模型 id（静默换成默认模型正常出流），所以「模型下架」在这条路由上**不产生错误报文**；
> ② Messages 路由的错误信封**没有 `base_resp`**，所以「按数字码判额度」在这条路由上**不会开火**。
> 两条都把「照抄上游」改成了「按实测重做」，其中 ① 直接推出一个**钱包级别**的改动：请求 M2.7 却被 M3 代跑。

---

## 〇、上游这一轮是什么

| 材料 | 是什么 | 本轮用途 |
| :- | :- | :- |
| `MiniMax-AI/minimax-code` @ `c21e88e`+ | 官方客户端源码 | 模型表、错误分类、签到契约 |
| npm `@minimax-ai/code@0.6.12` | 发布包 | **GitHub Releases 只到 v0.6.5，npm 领先发行页**——差分要以 npm 包为准 |
| `packages/config/src/minimax-model-catalog.ts` | 上游的模型表兜底 | 文件 API 能力块（见第三节） |
| `packages/config/src/model-availability.ts` | 路线感知的模型可用性闸门 | 见第五节 |
| `packages/shared/src/llm-error-classifier.ts`（49 KB） | 上游的错误分类器 | 数字码判定、TPM/过载/用量限额码 |
| `packages/tui/src/checkin/http-gateway.ts` | 上游的签到网关 | 账号键断言（见第六节） |

上一轮已做掉的（thinking 通道、超限文案、effort 档位、Files API 路径）**不重复**。

---

## 一、探针测穿的第一个前提：端点不拒绝它路由不了的 id

### 实测（`scripts/probe-minimax-capabilities.probe.ts`，2026-10-20，cn 区，账号池取凭据）

| 请求 model | HTTP | `message_start.message.model`（谁在回答） |
| :- | :-: | :- |
| `MiniMax-M2.5`（真模型，我们没收录） | 200 | `MiniMax-M2.5` |
| `MiniMax-M1`（真老模型） | 200 | `MiniMax-M1` |
| `MiniMax-M3.1-Flash-Preview`（已淘汰的拼写） | 200 | 它自己 |
| `modelless-probe-id-zzz`（乱写） | **200** | **`MiniMax-M3`** |
| `""`（空串） | **200** | **`MiniMax-M3`** |

「替换」是真的，不是标签：同一个乱写 id 带 `reasoningEffort:'none'` 再发一次，回答的 M3 **真的少了 thinking 块**——被服务的是「按本次请求参数运行的 M3」。

### 后果

这条线路的模型目录是**硬编码**的（`/v1/models` 对订阅流量是 503 `direct_route_not_configured`，这是路由裁决不是路径拼错）。若 MiniMax 下架了 M2.7 而用户仍选着它，
请求**不会报错**，会被 M3 代跑：用户以为在用便宜模型，实际按最贵档计费（我们自己的实测：M3 的 max 档思考量约 3 倍、延迟约 4 倍）。

**所以「按错误报文做下架自动摘除」这条路不存在**——那种报文压根不产生。任何基于 404/"model not found" 的设计在这条路由上都是一个永远不触发的分支。

### 落地：应答模型核验（`MODEL_SUBSTITUTED`）

唯一可用的信号是流头的 `message_start.message.model`，而**我们的 mapper 此前根本没读它**（只取 usage 与 stop_reason）。

| 位置 | 改动 |
| :- | :- |
| `mapper.ts:1068` / `:1302-1307` | `MinimaxStreamState.answeredModel?: string`；`message_start` 里多读一行 `message.model`，**只读不判**，字段缺失就留 undefined |
| `adapter.ts:1149` | `wireModel` 从**即将发送的请求体**读回（`built.model`），不是目录里解析出来的名字——目录改名只改 lookup，**上线的那串 id 是调用方给的** |
| `adapter.ts:1386-1394` | `verifyAnsweredModel()`：应答 id 与上线 id 大小写不敏感不等 → 抛 `MODEL_SUBSTITUTED` |
| `adapter.ts:1421` / `:1437` | 判定点在 `processMinimaxStreamLine` 之后、**任何 `yield` 之前**。`message_start` 是流的第一个事件，排在所有 `content_block_start` 之前 → **没有任何内容块送达调用方**，无需回收、不会有重试重复输出 |
| 重试 | 新码**不在** `retryableCodes: ['RATE_LIMIT','SERVER','TIMEOUT','TRANSPORT']` → harness 不重试。重发同一 body 只会再被替换一次，并按替身计费 |

两个「不判决」的情形是刻意的：流头没有 model、或请求体没有 model → 都不算替换。**为一个无法核验的轮次把会话打挂，比漏判更糟。**

---

## 二、探针测穿的第二个前提：Messages 路由的错误信封没有 `base_resp`

### 实测到的两种信封（互不相干）

| 状态 | 完整字段 |
| :- | :- |
| 400 | `{"type":"error","error":{"type":"invalid_request_error","message":"invalid params, model[MiniMax-M3] does not support max tokens > 524288 (2013)"}}`——**没有任何数字字段**；`request_id` 只在参数类错误上出现 |
| 401 | `{"code":401,"message":"auth failed"}`——**顶层 `code` 是这条路由唯一的数字字段** |

`2013` 只以**文本**形式嵌在 `error.message` 的括号里，且是通用「参数非法」码（超限的 `max_tokens`、空 body、畸形 JSON 全归它）。本仓库在 `reset-card` 与 Files API 上另有语义，**绝不拿它当额度判决**。

`base_resp.status_code` 那个信封属于这条线路的**别的**路由：配额 `coding_plan/remains`、Files API、`reset-card`。

### 后果与修正

上游 `llm-error-classifier.ts` 用 `LLM_USAGE_LIMIT_UPSTREAM_STATUS_CODES = [2056, 2067]` 判额度耗尽——**在 Messages 路由上这个臂不会开火**。
它仍然值得留：一句中文没有码、一个裸码没有句子，两个臂要同时在；而且哪天服务在 Messages 路由上带出这些码，它立刻生效。

| 位置 | 改动 |
| :- | :- |
| `adapter.ts:299-304` | `statusCodeIn` 读三个字段：`base_resp.status_code` → `errorCode` → **顶层 `code`**（最后这个是这条路由唯一真有的数字字段） |
| `adapter.ts:334-336` | `namesSpentWindow = 数字码臂 ‖ 措辞表`；403（`:361`）与 429（`:431`）两个入口读**同一个**谓词，汇进**同一个** `quotaExhaustedFailure`（`:368`）→ 判决天然同形 |
| 流内路径 | in-band 体是 `{error: …}`，`namesUsageLimitStatusCode` 多读一层 → 自动继承，无重复实现 |
| README | **改正过度声称**：那段原本把数字码臂写成这条线路失败分类的首要判据，现已改成「跨信封的前向兼容臂；在 Messages 路由上当前不会开火，operative 的仍是措辞表」并附上两种信封的实测形状 |

---

## 三、上游模型表里的文件 API 能力块（`minimax-model-catalog.ts`）

上游兜底表给 M3 与 M3.1-Flash 挂了一块能力：

```ts
support_files_api: true, files_api_upload_endpoint: '/v1/files/upload',
max_image_bytes_inline: 10_485_760, max_video_bytes_inline: 52_428_800,
max_request_body_bytes: 67_108_864, max_attachments_count: 4
```

| 数字 | 我们 | 对齐情况 |
| :- | :- | :- |
| 单图 10 MB | 10 MiB | ✅ |
| 单视频 50 MB | 50 MiB | ✅ |
| 请求体 64 MB | 64 MB | ✅ |
| `max_attachments_count` | M3 **9** / M3.1 **4** | ⚠️ 上游对两者都写 4 |

### `maxAttachments` 的 9 vs 4：留待裁定，**不改**

- 这个数字描述的是**上传路径**的附件上限，不是内联上限（内联实测 4/5/8/9/10/12/20/48 张图全部 200）。
- 我们写 9 继承自更早的快照；上游当前写 4。**本线路的上传路径一次只上传一个文件**（超内联上限的媒体逐个上传并改写成 `mm_file://<file_id>`），所以 4 在常态下不会咬人——只有一次请求带 ≥5 个文件引用时才会。
- 裁定需要**对上传路径**的探针，不是再读一遍文档。数值保持 9，并在 `model-catalog.ts` 的 M3 条目里留了 PENDING 注释。

---

## 四、`max_tokens`：我们写的 128000 是保守值，服务侧真阈值是 524288

| max_tokens | 实测 |
| :- | :- |
| 0 | **200 接受**（0 **不是**非法参数） |
| 128000 | 200 接受 |
| 512000 | 200 接受（models.dev 写的那个数） |
| 999999999 | **400** `invalid params, model[MiniMax-M3] does not support max tokens > 524288 (2013)` |

夹逼得服务侧上限 **524288**。我们目录里的 `maxTokens: 128_000` 不是错，是**保守**（上游自己的兜底表也写 128000）。

**「被接受」≠「能生成到那么多」**：探针只验了请求是否被接受，读到首字节即 abort（刻意不跑满）。
是否放宽到 524288 是**产品决策**（更长的输出 = 更贵的账单），本轮**不改数值**，只把实测阈值写进目录注释。

顺带确认了一件要紧事：那条 400 文案**不会**误触发我们的上下文超限检测（逐条比对 `src/host/common/context-overflow.ts` 的 8 条正则）——所以**不存在**「压缩→重试→再压缩」的死循环。

---

## 五、上游的路线感知模型可用性闸门：设计可借鉴，**本轮不落地**

`packages/config/src/model-availability.ts` 的原则：

> owns the one answer to "may this route call this model", so the local model list, the save entry and the Turn execution gate cannot disagree and let a locally-known model reach a backend that retired it.

上游还有 `ModelCallRoute`（`managed_token_plan` / `minimax_api_key` / `custom_provider` / `configured_provider`）与两种可读错误（`MODEL_NOT_AVAILABLE_FOR_ROUTE` / `DEFAULT_MODEL_NOT_AVAILABLE_FOR_ROUTE`）。

**本轮不落地，原因见第一节**：这条路由**不会**告诉我们模型被下架了——它默默换一个模型继续服务。所以「下架后从选择器里摘掉」在这条路由上**没有可实现的触发源**：
唯一信号是「应答 id ≠ 请求 id」，而拿到它要发一次真请求，做成巡检就是一轮 N 个模型 × 一次请求，正是探针明确拒绝烧额度的形状。

**已经用另一种方式拿到了同一个保护**：应答模型核验让每一次被替换的请求**立刻失败**并说清「请求 X、实际 Y」，而不是让用户付完最贵档的账才发现。
若将来 MiniMax 给出真正的下架报文，这条闸门可以再补上——**接口留着的形状不需要现在就造**。

---

## 六、签到：上游的账号键断言 → 我们的「宽窄两半」

上游在 `getSigninPanel` 与 `claimSignin` 之间用 `assertExpectedAccount` 断言两次调用是同一个账号；401 时强制刷新一次再重试。
我们的对应实现（`checkin.ts` / `checkin-gateway.ts`）**没有**直接照抄，而是分成两半，因为这两种「账号变了」的性质完全不同：

| 半边 | 场景 | 判据 | 处理 |
| :- | :- | :- | :- |
| **宽** | 池里那行被**重绑**到另一个账号（用户/adopt 流程改主意） | 缓存条目对着手里的凭据校验 | **重新解析身份、重新钉住、照常签到**——一行 = 插件替用户管理的一个账号，跟着走才是对的 |
| **窄** | **一次 attempt 中途**凭据漂了；401 续期返回了另一个账号 | 本次 attempt 的钉 vs 当前凭据 | **硬拒绝**（`MinimaxCodeCheckinAccountMismatchError`），不自愈 |

两半的分工写在了 `checkin.ts:196-225`（窄）与 `checkin.ts:358-381`（宽），互相指向。

顺带记下一个容易骗人的地方：`native:<region>:<recordKey>` 里的 `recordKey` 是**记录槽位**键，**不是账号 id**——用户在桌面端把另一个账号签进同一个槽位时，这个键不变。所以它是「尽力而为的护栏」，
这条线账号的**权威标识**是从身份接口解析出来的 `realUserID`（`checkin-gateway.ts:96-125` 的文档已写清）。

---

## 七、我们自己那几处过期的事实性表述（本轮修正）

这轮开始前先做了一次实现盘点，发现**代码早于文档**：Files API 早就实现了（`files-api.ts` 401 行：12 小时 TTL、账号隔离、去重缓存），视频也早已声明，
但注释与 README 还在描述实现之前的世界——包括一句**用户会读到的错话**（令牌「约 24 小时」，实测是 **1 小时**）。

| # | 位置 | 改前 | 事实 |
| :- | :- | :- | :- |
| 1 | `model-catalog.ts`（inputModalities 注释） | 「a longer clip needs the Files API, which this line does not implement」 | 本线路实现了上传（`{messagesBase}/files/upload` + `mm_file://<file_id>`） |
| 2 | `model-catalog.ts`（maxAttachments 注释） | 「this line uploads nothing」 | 同上 |
| 3 | `model-catalog.ts`（`filesApiDocumented` 注释） | 「implements no upload, TTL, account isolation or deletion」 | upload/TTL/账号隔离/去重缓存**都在**；唯一真的缺的是**删除**——服务端没有 list/delete 路由（`GET /files` 回 503），过期只能本地推断 |
| 4 | `model-catalog.ts`（maxAttachments 注释） | 9 的理由建立在「我们不上传」上 | 前提已不成立；9 vs 4 列为待裁定（第三节） |
| 5 | `README.md` | 「视频不在能力声明里」 | 视频**已在**声明里；读取器是宿主注入的 `AttachmentVideoReader`，宿主不给时映射器才退化成说明文本（4 种 reason） |
| 6 | `README.md` | 错误分类写成三类（5xx/429/无响应） | 实际是 8 级判决，含上下文超限、凭据失效、账号级额度耗尽（5h/7d 冷却）、401 强制续期 |
| 7 | `locales.ts` + `MinimaxCodeSection.tsx` | 「访问令牌约 24 小时有效」 | 实测 **1 小时**；显示单位改为**分钟**（`remainingHours` → `remainingMinutes`） |

第 7 条是唯一用户可见的一处；第 1–6 条是文档债，但它们会让人**误判这条线路的能力边界**——包括下一次做差分分析的人。

---

## 八、明确否掉的（免得以后重复讨论）

| 项 | 为什么不适用 |
| :- | :- |
| **用 models.dev 自动刷新目录** | 实测拉了 `models.dev/api.json`：它描述的是**公开 API / 开源权重**模型（`minimax/minimax-m3` = 262K 上下文、纯文本、$0.23/$0.96），**不是订阅路由**。接上去会**降级**我们目录的精度 |
| **上游的远程目录快照** | 属 `isManagedRuntime()` 专属的 C 端能力，开源独立版同样硬编码首屏目录。**上游硬编码是对的，不是我们的债** |
| 上游「单请求图片 ≤ 20 张」 | 自定策略常量，非端点限制；我们实测 48 张内联图全 200 |
| 上游 `reasoningSummary: "auto"` | pi-ai 的 display 路径，minimax 不走 |
| 上游 `contextManagement.compactionTriggerAt` | 压缩由 **DSH 宿主**决定，不是 provider 插件 |
| 把 `max_tokens` 抬到 524288 | 是产品决策（更贵的账单），不是技术债 |
| 「模型下架自动摘除」 | 见第五节：没有可实现的触发源 |

---

## 九、本轮改动清单与验证

| 文件 | 改了什么 |
| :- | :- |
| `src/host/minimax-code/adapter.ts` | 数字码臂（`base_resp.status_code` → `errorCode` → 顶层 `code`）+ 措辞兜底，两个入口共用一个谓词；`MODEL_SUBSTITUTED` 判定与 `verifyAnsweredModel()` |
| `src/host/minimax-code/mapper.ts` | 捕获 `message_start.message.model`（只读不判） |
| `src/host/minimax-code/checkin.ts` / `checkin-gateway.ts` | 签到账号一致性：宽半自愈重钉、窄半硬拒绝；`checkinAccountIdentity` 与「recordKey 是槽位键不是账号 id」的文档 |
| `src/host/minimax-code/model-catalog.ts` | 3 处过期注释改正 + 实测阈值 524288 + 「下架不产生错误报文」 |
| `src/client/minimax-code/locales.ts` / `MinimaxCodeSection.tsx` | 令牌时长 24 小时 → 1 小时，显示单位改分钟 |
| `README.md` | 视频段、失败分类段重写；数字码臂定位改正 |
| `scripts/probe-minimax-capabilities.probe.ts` + `docs/minimax-code-probe-capabilities.md` | 16 个 case 的活体探针与原始证据 |
| 新测试 | `minimax-code-usage-limit-code`（8）、`minimax-code-served-model`（5）、`minimax-code-error-envelope-code`（2）、`minimax-code-checkin` 增 4 条 |

**验证**：`npm run typecheck` exit 0；`npx vitest run` **250 files / 0 失败**（1 skipped）；`npm run build` exit 0。
（基线是 249 files、1 失败——那个失败是仓库里未跟踪的联网活体探针 `test/tmp-live-search.test.ts`，缺 ChatGPT 登录态，与本轮无关。）

---

## 十、待办

1. **`maxAttachments` 9 vs 4** —— 需要一次**对上传路径**的探针（≥5 个文件引用时会发生什么）。
2. **设置卡提示「1M 更费额度」** —— 上游用 `contextWindowOptionHints: { "1000000": "higher_usage" }` 表达，我们还没有对应呈现（上一轮遗留）。
3. **上游发布包那四条**（413 恢复 / 流内超限 / 思考预算耗尽重试 / requestMedia 编码预算）—— 上一轮已记录，仍未实现。
4. **`max_tokens` 是否放宽到 524288** —— 产品决策，需要用户拍板账单影响。
5. **上游的 TPM 限流 / 529 过载 / 确定性拒绝三类判决** —— 上游 `llm-error-classifier.ts` 有，我们的分类器还没有；本轮未做，因为这条路由上还没见过它们的报文。
6. **MiniMax 原生媒体工具**（图像/视频生成、TTS、ASR）—— 上游客户端内置，但公开的 `MiniMax-MCP` / `MiniMax-Coding-Plan-MCP` 都用**平台 API Key**（`MINIMAX_API_KEY` + `api.minimax.io`），**不是订阅令牌**。我们的订阅令牌能否调用，**需要探针**，不能凭上游有这功能就假设我们有。
