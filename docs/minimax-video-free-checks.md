# MiniMax Code 视频链路：零成本验证探针实测

**方法**：真实探针 `scripts/probe-minimax-video-free-checks.probe.ts`，对 `https://agent.minimax.cn/mavis/api/v1/mcp/<tool>` 与 `https://api.minimax.cn/v1/api/openplatform/coding_plan/remains` 发真实请求。

**成本模型**：本文件**没有发出任何一次会建任务的请求**。整个设计的支点是那条已实测的服务端行为 —— **参数校验发生在创建任务之前**：`POST submit_video_generation` 带 `{}` 返回 HTTP 400「invalid request: model is required」，**响应里没有 `task_id`，没有建任务，没有计费**。因此「一个必定被校验拒绝的请求」是免费的，而**拒绝的原话本身就是规格书**。

**保密**：令牌 / 邮箱 / 账号 id / realUserID 一律不出现；URL 只报**形状**（scheme / host / 段数 / 扩展名 / query 键名），不报值。

跑法：

```powershell
npx vitest run --config vitest.probe.config.ts probe-minimax-video-free-checks
```

完整运行约 **5 分钟**（其中 A5 的 5 MiB 上传约 86 s，E2 静默控制窗口 60 s）。

---

## 0. 四个必答问题

| # | 问题 | 确定答案 |
| :- | :- | :- |
| **A** | 配额接口里有没有 video 资源桶 | **没有**。`model_remains` 只有 **1 行**，名为 `general`。文档里没有任何 video / hailuo 类名字的桶，因此**那次真实生成的额度消耗无法从这里读出** |
| **B** | duration / resolution / ratio 的合法值 | duration：`MiniMax-H3` **4–15**、`MiniMax-H3-Max` **5–15**、`MiniMax-Hailuo-2.3` **只能是 6 或 10**；resolution：`MiniMax-H3` **`768P` 或 `2K`**（大小写敏感，`720p` 被拒）；ratio：**未测出**（见 §2.4） |
| **C** | `MiniMax-Hailuo-2.3` 是否被接受 | **被接受**。同一套非法 duration 下，它报的是**关于它自己 duration 规则的话**，说明 model 字段先通过了校验 |
| **D** | 公网 http(s) URL 能不能被理解 | **不能**。三个候选全部 `results[0].success=false`，原话是 `video_info.url could not be used as a media source`，并再次把调用者推向 `get_upload_url` / `data` 两条路 |

**守卫生效**：本次运行创建的任务数 = **0**。13 次矩阵调用、3 次配额读取，每次响应都做了整份文档递归的 `task_id`/`taskId` 搜索，**全部缺席**。

---

## 1. A —— 配额接口里有没有 video 资源桶

### 1.1 原始响应（逐字）

```
read: http=200 host=api.minimax.cn base_resp=0 "success" rows=1
document keys: [model_remains,base_resp]
per-row field names:
  [start_time, end_time, remains_time,
   current_interval_total_count, current_interval_usage_count, model_name,
   current_weekly_total_count, current_weekly_usage_count,
   weekly_start_time, weekly_end_time, weekly_remains_time,
   current_interval_status, current_interval_remaining_percent,
   current_weekly_status, current_weekly_remaining_percent]
EVERY row, in document order (1):
  [0] general :: interval 0/0 left%=99 status=1 | weekly 0/0 left%=79 status=1
non-general rows: (none - general is the only row in the document)
```

`general` 行的全部 15 个字段：

```
start_time=1792479014771  end_time=1792497014771  remains_time=16578639
current_interval_total_count=0  current_interval_usage_count=0
model_name="general"
current_weekly_total_count=0  current_weekly_usage_count=0
weekly_start_time=1792406929936  weekly_end_time=1793011729936  weekly_remains_time=531293804
current_interval_status=1  current_interval_remaining_percent=99
current_weekly_status=1      current_weekly_remaining_percent=79
```

### 1.2 结论

| 问题 | 答案 |
| :- | :- |
| 有没有 video 桶 | **没有**。整份 `model_remains` 只有一行，名字是 `general` |
| 那次真实生成（4 s / 768P 纯黑 / task_id 15 位数字）能不能从某个桶读出来 | **不能**，因为不存在第二个桶 |
| `parseTokenPlanQuota` 有没有漏读我们不知道的桶 | **没有**。它就取到了文档里唯一的那一行；「其它（video, …）是独立资源」这句注释描述的是**设计意图**，但**这份响应里并不存在这样的行** |
| 这个接口能不能用来定价一次视频生成 | **不能**。它给的是**百分比 + 窗口时间戳的快照**，`*_total_count` 与 `*_usage_count` 恒为 `0`，所以 `used`/`total` 解析为 `undefined`，只剩百分比 |

窗口长度可以从时间戳直接算出：`end_time - start_time = 18 000 000 ms = 5 小时`；`weekly_end_time - weekly_start_time = 604 800 000 ms = 7 天`。

### 1.3 产品读数器与原始行的对照

```
parseTokenPlanQuota -> label="Token Plan" usedPercent=1 resetsAtMs=present
  window interval: remainingPercent=99 usedPercent=1  used=undefined total=undefined
  window weekly:   remainingPercent=79 usedPercent=21 used=undefined total=undefined
the general row it chose reads: interval 0/0 left%=99 status=1 | weekly 0/0 left%=79 status=1
rows the reader does NOT surface: (none - general is the only row)
```

**读数器与原始行完全一致**，且没有漏掉任何桶。只取 `general` 在这里**不丢信息**，因为文档里就只有 `general`。

### 1.4 关于 `general` 百分比从 62 变成 99 的如实说明

上一份报告（`docs/minimax-video-generation-probe.md` §6）记录的 `general` 是 **interval 62% / weekly 79%**；本次运行为 **interval 99%（首读 100%）/ weekly 79%**。

**这不代表额度返还，也不代表本次探针动了它。** 依据是本次专门加的**静默控制窗口（E2）**：

```
===== STEP E2: control - is the bucket moving while this probe sends nothing? =====
waiting 60s with NO request of any kind, then reading again
read: http=200 host=api.minimax.cn base_resp=0 "success" rows=1
  general: unchanged during the quiet window
```

即：**在完全静默的 60 秒里桶没有动**。再结合 `interval` 是 5 小时窗口、两份记录相隔很久，interval 的回升最可能是**窗口重置**，而不是任何人「用回」了额度。

> **仍然如实保留**：某次运行的前半段观察到过一次 `interval 100% → 99`。E2 证明它在**静止时不动**，但**不能排除**是这一轮的请求所致，也**不能排除**是桌面端等其它客户端在同时段活动。本次没能把这两者分开，**不做断言**。

**因此，关于「一次真实视频生成消耗多少额度」这个问题，本报告的答案是：这个接口读不出来，而且它里面根本不存在一个能看到视频消耗的桶。**

---

## 2. B —— 参数的合法范围（服务端原话）

每个 case 都带 `model` + `prompt`（否则只会看到 `model is required`），并且**只带一个**非法值。**每个 case 都断言过响应里没有 `task_id`。**

全部 case 的 HTTP 状态都是 **200**，业务错误码在**顶层 `code: 400`**，而 `base_resp.status_code` 仍然是 **0**。

### 2.1 duration 越界（B1 / B2）

请求：`{"model":"MiniMax-H3","prompt":"…","duration":3}` 与 `duration:16`

```
{"code":400,"message":"duration MiniMax-H3 requires duration from 4 through 15 seconds;
 use 4-15 seconds for MiniMax-H3, 5-15 seconds for MiniMax-H3-Max, or 6/10 seconds for Hailuo 2.3",
 "base_resp":{"status_code":0,"status_msg":"success"}}
```

### 2.2 duration 为 0（B3）

```
{"code":400,"message":"duration is required for MiniMax-H3; choose an integer duration from 4 through 15 seconds", …}
```

> `0` 被当作**缺失**处理（"is required"），而不是「超出范围」。这对我们实现有意义：**`0` 与 `undefined` 在服务端是同一类错误**，不要靠传 `0` 表达「让服务端决定」。

### 2.3 resolution 非法（B4 / B5）

请求：`"resolution":"4K"` 与 `"resolution":"720p"`（小写）

```
{"code":400,"message":"model resolution for MiniMax-H3 must be 768P or 2K;
 choose MiniMax-H3 for recommended quality, MiniMax-H3-Max for fast generation,
 or MiniMax-Hailuo-2.3 for the lower-cost option", …}
```

（服务端原话里这两个值带反引号，本文档为可读性去掉了。）

两条消息**逐字相同**，所以：**`720p` 与 `4K` 一样非法，resolution 的匹配是大小写敏感的。** `768P`/`2K` 必须按大写 `P`/`K` 发送。

### 2.4 ratio —— **未测出，如实保留**

请求：`{"model":"MiniMax-H3","prompt":"…","ratio":"5:4"}` / `"ratio":"adaptive"`

两者返回的都是 **duration 的必填报错**：

```
{"code":400,"message":"duration is required for MiniMax-H3; choose an integer duration from 4 through 15 seconds", …}
```

**这不是 ratio 的答案。** 校验器是**顺序执行且短路**的，实测顺序是：

```
model  →  duration  →  resolution  →  ratio
```

B6/B7 没带 duration，所以在 duration 这一步就被拒了，**ratio 那一行根本没被执行到**。

**为什么不用「带上合法 duration/resolution」再问一次**：

一个能走到 ratio 校验的请求体，必须同时具备**合法的 model、合法的 duration、合法的 resolution**。如果 ratio 恰好**不被校验**，这个请求就会**真的创建任务并计费**。也就是说：**ratio 的合法性无法用零成本的问题问出来。** 一个留在「未测」的格子，比一次没人要求的生成便宜得多。

---

## 3. C —— `MiniMax-Hailuo-2.3` 是否被接受

对照组：B1（`MiniMax-H3` + `duration:3`）。候选：`MiniMax-Hailuo-2.3` + **同一个** `duration:3`。

| 组 | 服务端原话 |
| :- | :- |
| 对照 `MiniMax-H3` | `duration MiniMax-H3 requires duration from 4 through 15 seconds; use 4-15 seconds for MiniMax-H3, 5-15 seconds for MiniMax-H3-Max, or 6/10 seconds for Hailuo 2.3` |
| 候选 `MiniMax-Hailuo-2.3` | `duration MiniMax-Hailuo-2.3 requires duration 6 or 10; use 4-15 seconds for MiniMax-H3, 5-15 seconds for MiniMax-H3-Max, or 6/10 seconds for Hailuo 2.3` |

**判定：`MiniMax-Hailuo-2.3` 被接受。**

理由不是「它没报错」，而是**它报的是关于它自己的 duration 规则**：服务端已经认出这个模型，并把它自己的规则句子发回来了。若模型不被接受，报错会指向 model 字段（`{}` 那次已经证明了 model 是最先被检查的字段）。

**顺带确定的三模型 duration 表**（来自服务端自己的一段话，两个 case 互相印证）：

| 模型 | 合法 duration | 合法 resolution |
| :- | :- | :- |
| `MiniMax-H3` | 4–15 秒 | `768P` / `2K` |
| `MiniMax-H3-Max` | 5–15 秒 | 未单独测（同一套 resolution 校验） |
| `MiniMax-Hailuo-2.3` | **只能是 6 或 10** | 未测 |

> **对我们实现的直接影响**：`MiniMax-Hailuo-2.3` 的 duration **不是区间**，是两个离散值。任何「4–15 的滑块」在切到 2.3 时都会产出**必被拒**的请求。

---

## 4. A5 —— inline `data` 的大小门限（补充 case）

### 4.1 为什么加这一项

上游客户端（`packages/agent-tools/src/desktop/matrix-media-client.ts`）有：

```ts
export const MATRIX_INLINE_LIMIT_BYTES = 600 * 1024;      // 600 KiB
export const MATRIX_MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MiB
```

配上 `if (!forceRemoteUrl && stats.size <= MATRIX_INLINE_LIMIT_BYTES)` 的判定，**600 KiB 是上游「什么时候改走上传」的自定策略，不是服务端拒绝线**。而**我们**允许 inline 到 40 MB —— 这个数字来自我们自己的 transport 上限，**从未对服务端验证过**。探针 U3 只送过 12 865 字节。

### 4.2 做法

用 `videos_understand` 的 `{ video_info: [{ data: <base64>, prompt: "描述这个视频" }] }`，逐档加大：**约 1 MiB / 5 MiB / 20 MiB 原始字节**（base64 后 1.4 M / 7.0 M / 28.0 M 字符）。每档**只发一次，失败不重试**。

用的是**合成字节**：`ftypisom` 盒子头 + `0x11` 填充 —— **不是**可解码视频。

### 4.3 原始结果

| 档位 | 原始 | base64 | HTTP | `code` | `base_resp` | `results[0].success` | `source` | 耗时 |
| :- | :- | :- | :- | :- | :- | :- | :- | :- |
| R1 | 1 048 576 B | 1 398 104 | **200** | **0** | **0** | **true** | `inline:1048576B` | 27.5 s |
| R2 | 5 242 880 B | 6 990 508 | **200** | **0** | **0** | **true** | `inline:5242880B` | 86.5 s |
| R3 | 20 971 520 B | 27 962 028 | — | — | — | — | — | **传输超时（120 s 内无响应）** |

**三档都没有 `task_id`**（understand 本就不该建任务，已逐档断言）。

### 4.4 这是本次最重要的发现：`success: true` 不证明字节被解码

送进去的是 `0x11` 填充的合成字节，任何解码器都不可能从里面读出画面。但服务端返回了：

| 档位 | `success` | `description`（原话节选） |
| :- | :- | :- |
| 1 MiB | **true** | 「这是一段非常清晰的**极近距离特写（微距）视频**，主角是一只灰黑相间的**虎斑猫**…」 |
| 5 MiB | **true** | 「这段视频展示了一个**紫红色洋葱**在**纯白色背景**下**匀速旋转**的画面…」 |
| 20 MiB（另一次运行中成功过一次） | **true** | 「…一个人在**狭窄巷道中狂奔**的场景…」；**同一次运行的另一份返回**却是「您似乎没有上传或附上任何视频」 |

多次返回**几段互不相同、具体到毛发纹理的描述**，全部来自**同一类合成字节**。它们在物理上不可能都是真的。

**结论（必须写进实现的假设里）**：

1. **`results[0].success === true` 不是「视频被看到」的证据。** 它是「这次调用被受理」的证据。
2. `source` 里的 `inline:<N>` 回显**是可靠的字节计数**——服务端确实收到了 N 字节。但「收到」不等于「解码」。
3. 一个**退化输入**（畸形/不可解码的媒体）**不会**让调用失败，它会得到一段**看似合理但凭空生成**的文字。**对我们自己的组件，这是比报错更危险的失败模式**：用户会拿到一段自信的、与内容无关的描述。
4. 因此 `video-tool.ts` 的 `analysisOf()` **不能只看 `results[i].success`**，还必须能识别「模型自述没看到视频」这类句子（本次探针已内置该识别，见 `observedVideoEvidence()`）。

### 4.5 大小门限本身的答案

| 问题 | 答案 |
| :- | :- |
| 服务端会不会因 inline 太大而拒绝 | **在 5 MiB 原始字节（约 7 MiB base64）以内，没有看到任何大小拒绝** |
| 20 MiB 那一档呢 | **没测出拒绝，也没测出接受**：它在 120 s 内**没有响应**（传输超时）。另一次运行里同一档位曾在 84 s 内返回 200 |
| 所以上限在哪 | **仍未确定**。已知的是：**拒绝不是我们观察到的现象，超时才是** |
| 「600 KiB」是服务端上限吗 | **不是**。它是上游客户端的**自选策略**。服务端在 5 MiB 时照收不误 |

**对我们的 40 MB inline 上限意味着什么**：本次**没有找到调小它的实测依据**，但也**没有验证它可用**——因为**超时**先于**拒绝**出现，而超时是**我们自己的**选择。真要支持大文件，需要解决的是**能等多久**，而不是**服务端收不收**。

---

## 5. D —— 公网 http(s) URL 能不能被理解

### 5.1 三个候选，先测「本机能不能取到字节」

| 编号 | URL 形状 | 本机可达性 | `content-type` | 首 12 字节 |
| :- | :- | :- | :- | :- |
| D1 | `scheme=https host=www.w3schools.com pathSegments=2 ext=mp4 queryKeys=[]` | **可达**，http=206 | `video/mp4` | `0000001c667479706d703432`（`ftypmp42`） |
| D2 | `scheme=https host=interactive-examples.mdn.mozilla.net pathSegments=3 ext=mp4 queryKeys=[]` | **可达**，http=206 | `video/mp4` | `00000020667479706d703432`（`ftypmp42`） |
| D3 | `scheme=https host=commondatastorage.googleapis.com pathSegments=3 ext=mp4 queryKeys=[]` | **不可达**，http=**403** | `application/xml` | `<?xml version` |

### 5.2 服务端的回答

三档全部：HTTP **200**、顶层 `code: 0`、`base_resp.status_code: 0`、`results[0].success: false`、`description: ""`。原话：

```
video_info.url could not be used as a media source; download the resource in your local or
sandbox workspace first, then call matrix_get_upload_url with filename, mime_type and
size_bytes; PUT the local file to the returned put_url using the returned content_type, then
use the returned cdn_url after the upload succeeds; if the file is unavailable, ask the user
to provide the file; for a small file (up to 600KiB), call matrix_upload_to_cdn with
base64-encoded file contents in data and its name in filename; alternatively, supply
base64-encoded file contents in this tool's data
```

三条消息**逐字相同**，`source` 字段回显了被拒的那个 URL 的**形状**。

### 5.3 判定：区分「服务端拒绝」与「我们取不到字节」

| 编号 | 本机有字节？ | 服务端成功？ | 该记成什么 |
| :- | :- | :- | :- |
| D1 | **有**（`video/mp4`，`ftyp` 头正确） | **否** | **服务端拒绝**——这是一个真事实：公网 URL 不被接受 |
| D2 | **有**（同上） | **否** | **服务端拒绝**——第二个独立主机，同样结论 |
| D3 | **没有**（403，返回的是 XML 错误页不是视频） | 否 | **我们取不到字节**——**这一档不构成对服务端的证据** |

**D 的结论**：`video_info[].url` 这个键**语法合法**（键名对了，服务端没有报键名错误），但服务端**不会去取一个第三方公网 URL**。它只认「它自己取得到的东西」——也就是它自己 CDN 上的 `cdn_url`，或者内联 `data`。

这**修正**了上一份报告里保留的那条未验证项（「U2 只测了签名 OSS URL，不代表任意公网 URL 都不行」）：**现在测了三个公网 URL，其中两个本机确认可取到正确 MP4 字节，服务端仍然一律拒绝。** 方向的结论已经成立。

> 仍然保留的边界：本次没有测「`get_upload_url` → PUT → `cdn_url` → `videos_understand`」这条链路本身。服务端反复推荐的正是这条路，而它**是否真的能读通**，本探针没有验证，也不声称。

---

## 6. 对现有实现的直接影响

> 本节只陈述实测事实指向哪里。**本次任务不改 `src/`。**

| # | 位置 | 现状 | 实测要求 |
| :- | :- | :- | :- |
| 1 | `video-tool.ts` 的参数校验 | 可能允许 duration 是 4–15 的任意值、resolution 任意大小写 | `MiniMax-H3` 4–15；`MiniMax-H3-Max` 5–15；**`MiniMax-Hailuo-2.3` 只能是 6 或 10**；resolution 只能是大写 `768P`/`2K`；`duration: 0` 等同缺失 |
| 2 | `video-tool.ts` `analysisOf()` | 依据 `results[i].success` 判定成功 | **`success: true` 不证明字节被解码**。必须同时识别「模型自述没看到视频」的句子，否则会把一段幻觉当成分析结果交给用户 |
| 3 | `video-tool.ts` 理解请求体 | 仍可能发 `file_url`，或依赖 `url` | `file_url` 非法；`url` 语法合法但**服务端不会去取第三方公网 URL**（两个独立主机实测拒绝）。可行路径只剩 `data`（内联）与自家 `cdn_url` |
| 4 | inline 上限（40 MB） | 源自我们自己的 transport 推导 | **没有实测依据支持它，也没有实测依据否定它**。5 MiB 明确可送达；20 MiB 表现为**超时**而非拒绝。若要调，理由应是「我们愿意等多久」，不是「服务端收不收」 |
| 5 | 配额卡片 | 只读 `general` | **正确且无损**：文档里就只有 `general` 一行。视频消耗**在这个接口里根本不存在**，卡片不该、也无法展示它 |
| 6 | 计费/额度展示 | —— | 没有任何可读接口能反映一次视频生成的额度消耗。**不要为此发明数字** |

---

## 7. 未查清 / 明确保留

| # | 未验证项 | 为什么没查 |
| :- | :- | :- |
| 1 | `ratio` 的合法值 | 校验顺序短路（model→duration→resolution→ratio）。问出它的唯一方式是发一个**其余参数全合法**的请求，而那会**真的建任务并计费**。零成本前提下无解 |
| 2 | inline 的**真实**上限 | 20 MiB 表现为**超时**而非拒绝，超时是我们自己的选择。要测出来得把超时拉到分钟级，且仍可能只是「更慢」 |
| 3 | `MiniMax-Hailuo-2.3` 的 `resolution` 合法值 | 只需要一次非法 resolution 的免费请求，但它在 duration 之后才被校验，需要先给一个合法 duration；本次未做 |
| 4 | `get_upload_url` → PUT → `cdn_url` → `videos_understand` 全链路 | 属于「上传」，需要真的写对象到 OSS；本次未做 |
| 5 | 一次真实视频生成消耗多少额度 | 见 §1.2：**这个接口里不存在 video 桶**，读不出来。**不为补表格而建任务** |
| 6 | `interval` 100%→99% 的归因 | E2 证明静止时不动，但无法区分「本轮请求所致」与「其它客户端同期活动」。**不做断言** |

---

## 8. 原始证据去哪找

探针把每一行日志**即时追加**写入（不是结束时一次性写）：

```
%TEMP%\minimax-video-free-checks-transcript.log
```

> 之所以改成逐行追加：本次运行含 60 s 静默窗口与 20 MiB 上传，**被中途杀掉是真实可能**。一次性的末尾写入对一个跑完的运行是正确的，对一个被杀掉的运行则一文不值。

本次最终运行 **281 行**，`EXIT=0`，耗时 **311 s**。

**保密自查**（脚本内已固化为 `scrub()` + `redactUrls()`）：

- 令牌：从不打印，只报 `<present:len=60>`。
- 邮箱 / UUID / JWT / 32+ 字符不透明串：`scrub()` 清除。
- **账号 id**：`u<18 位数字>` 短于 32 位阈值，靠兜底规则抓不到——已单独加规则替换为 `<user-id>`。
- **URL 值**：`oneLine()` 先经 `redactUrls()`，把任意文本里的 URL 换成形状。三个公网 URL 与响应里回显的 `source` 都只以形状出现。
- **20 MiB 的 base64 不入日志**：`callTool()` 的 `displayBody` 把它替换成 `<base64 omitted: N chars>`。
- 落盘文件名：`minimax-video-free-checks-transcript.log`，不含任何账号信息。
