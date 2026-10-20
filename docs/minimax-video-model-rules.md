# MiniMax Code 视频链路：模型参数规则实测（第二轮零成本探针）

**方法**：真实探针 `scripts/probe-minimax-video-model-rules.probe.ts`，对 `https://agent.minimax.cn/mavis/api/v1/mcp/<tool>` 发真实请求。

**前置事实（已实测，来自 `docs/minimax-video-free-checks.md`）**：`submit_video_generation` 的参数校验**顺序执行且短路**，实测顺序是

```
model  →  duration  →  resolution  →  ratio
```

且**任何一项不合法就在建任务之前被拒**（响应里没有 `task_id` → 不计费）。

**所以零成本提问的方法就是**：把要测的那一项**故意留非法**，把它**前面**的每一项都填**合法**。服务端会走到那一项、然后把它自己的合法值原话告诉我们。**全程零成本。**

**保密**：令牌 / 邮箱 / 账号 id / realUserID 一律不出现；URL 只报**形状**（scheme / host / 段数 / 扩展名 / query 键名），不报值。落盘 transcript 已做过正则自查（邮箱 / JWT / UUID / 带签名的 URL / `u<18位数字>` 账号 id：**全部 0 命中**）。

跑法：

```powershell
npx vitest run --config vitest.probe.config.ts probe-minimax-video-model-rules
```

单次运行约 **2–5 分钟**，全部耗时都在 D 段那一次 20 MiB 上传上（4 次 submit 合计不到 1 秒）。

---

## 0. 四件待测事项：确定答案

| # | 问题 | 确定答案 |
| :- | :- | :- |
| **A** | `MiniMax-Hailuo-2.3` 的 resolution 合法值 | **`768P` 或 `1080P`**（服务端原话，见 §1） |
| **B** | `MiniMax-H3-Max` 的 resolution 合法值 + duration 下限复核 | resolution **`480P` 或 `768P`**；duration **下限确实是 5**（`duration:4` 被拒，原话 `requires duration from 5 through 15 seconds`） |
| **C** | `ratio` 的合法值 | **无法零成本测出** —— 且这次**测出了原因**：`prompt` 排在 `ratio` **之前**（见 §3） |
| **D** | 20 MiB inline 是超时还是拒绝 | **服务端能吃**。300 s 预算下返回 **HTTP 200 / `code:0` / `success:true` / `source:"inline:20971520B"`**，耗时 **127.6 s**。**从来没有出现过体积拒绝。** 但同一档位在 300 s 下也**超时过两次**（见 §4.4） |

**守卫结果：本次运行创建的任务数 = 0。**

---

## 1. A —— `MiniMax-Hailuo-2.3` 的 resolution

**请求**（`duration:6` 是它两个合法值之一，所以**唯一非法的是 resolution**）：

```json
{"model":"MiniMax-Hailuo-2.3","duration":6,"resolution":"4K","prompt":"一张纯黑画面"}
```

**响应**：HTTP **200**，顶层 `code: 400`，`base_resp.status_code: 0`，日志断言 **`TASK_ID CHECK: absent`**。

```json
{"code":400,
 "message":"model resolution for `MiniMax-Hailuo-2.3` must be `768P` or `1080P`; choose MiniMax-H3 for recommended quality, MiniMax-H3-Max for fast generation, or MiniMax-Hailuo-2.3 for the lower-cost option",
 "base_resp":{"status_code":0,"status_msg":"success"}}
```

**判定**：报错指向 **resolution**（探针输出的 `refusal names: [model,resolution]`）。这说明 **model 与 duration 都通过了校验**，句子里的 `768P` / `1080P` 就是它的合法集合。

> **一个必须当心的坑**：这句话的后半段是 `...fast gene**ratio**n...`。用**无词边界**的 `/ratio/` 去判断「报错提到了 ratio」，会把这条**关于 resolution 的**报错误判成**关于 ratio 的**报错。本探针第一轮就真的踩了这个坑（A 与 B1 都打印成 `names [model,resolution,ratio]`），已改为按词边界匹配后复跑。**这是「看起来合理的错误答案」的典型样本，记在这里。**

---

## 2. B —— `MiniMax-H3-Max` 的 resolution 与 duration 下限

### 2.1 B1：resolution

**请求**（`duration:5` 是文档里的下限，先让它合法）：

```json
{"model":"MiniMax-H3-Max","duration":5,"resolution":"4K","prompt":"一张纯黑画面"}
```

```json
{"code":400,
 "message":"model resolution for `MiniMax-H3-Max` must be `480P` or `768P`; choose MiniMax-H3 for recommended quality, MiniMax-H3-Max for fast generation, or MiniMax-Hailuo-2.3 for the lower-cost option",
 "base_resp":{"status_code":0,"status_msg":"success"}}
```

**判定**：报错指向 resolution（`names [model,resolution]`）→ **model 与 `duration:5` 都合法**，且它的 resolution 集合是 `480P` / `768P`。

> **`MiniMax-H3-Max` 不提供 `2K`。** 它比 `MiniMax-H3` **低一档**（`480P`/`768P` vs `768P`/`2K`）。这与它自己的宣传定位（"fast generation"）一致，但和「H3-Max 是 H3 的增强版」这个直觉**相反**。

### 2.2 B2：duration 下限复核

**请求**（不带 resolution，让 duration 成为唯一被判定的字段）：

```json
{"model":"MiniMax-H3-Max","duration":4,"prompt":"一张纯黑画面"}
```

```json
{"code":400,
 "message":"duration MiniMax-H3-Max requires duration from 5 through 15 seconds; use 4-15 seconds for MiniMax-H3, 5-15 seconds for MiniMax-H3-Max, or 6/10 seconds for Hailuo 2.3",
 "base_resp":{"status_code":0,"status_msg":"success"}}
```

**判定**：`duration:4` **被拒**，报错只提 duration（`names [duration]`）。**下限 5 由服务端自己的句子确认**，而不是靠推断。

---

## 3. C —— `ratio`：**零成本测不出**，而且这次测出了**为什么**

### 3.1 办法与它的两条分支

能走到 ratio 校验的请求体，必须同时具备**合法的 model、合法的 duration、合法的 resolution**。这样一个体距离「真的建任务」只有一步——**除非**它还有**另一处必定被拒**的地方。

这次用的是 **`prompt` 缺失**：

```json
{"model":"MiniMax-H3","duration":4,"resolution":"768P","ratio":"5:4"}
```

（注意：**没有 `prompt`**，所以这个体**不可能被受理**。唯一未知的是**哪一个报错先来**。）

- 若报错关于 **ratio** → 服务端已经走到 ratio，我们白拿到了合法值；
- 若报错关于 **prompt** → **prompt 排在 ratio 之前**，ratio 根本没被执行到 → **到此为止**。

### 3.2 结果

```json
{"code":400,
 "message":"prompt is required; describe the video to generate",
 "base_resp":{"status_code":0,"status_msg":"success"}}
```

探针输出：`names [prompt]`、`TASK_ID CHECK: absent`。

**判定：走了第二条分支。**

```
VERDICT: PROMPT PRECEDES RATIO - the refusal is about the missing prompt, so ratio was never
reached. Ratio is therefore NOT measurable at zero cost, and this file stops here.
```

### 3.3 这为什么是**结论**而不是**失败**

这次实测把校验顺序从

```
model → duration → resolution → ratio        （上一轮的推断）
```

推进到

```
model → duration → resolution → prompt → ratio（本轮实测）
```

**`prompt` 被夹在 `resolution` 和 `ratio` 之间。** 于是：

- 想走到 ratio，就**必须带一个合法 prompt**；
- 但一个「合法 model + 合法 duration + 合法 resolution + 合法 prompt + 未知 ratio」的体，**如果 ratio 恰好不被校验，它就会真的建任务并计费**。

**没有第三处可以留非法。** 因此「ratio 的合法值」在**零成本前提下的确定结论是：测不出来**。

> **本探针严格遵守了这条纪律**：得到 prompt 报错后**立即停止**，**没有**为了让 ratio 显形而补上合法 prompt 再发一次。那一次请求就是会计费的那一次。

---

## 4. D —— 20 MiB inline：**能吃**，不是被拒

### 4.1 为什么要重测

上一份报告把 20 MiB 记成「**传输超时，未测出拒绝也未测出接受**」。这个记录是**诚实的**，但它描述的其实是**我们自己的预算**，不是服务端的门限：同档位在另一次运行里曾在 84 s 内返回过 200。

所以这次把预算从 **120 s 提到 300 s**，并明确区分三种结局：**接受 / 明确拒绝 / 仍然超时**。

### 4.2 一次成功的原始响应（本轮第 3 次运行）

**请求**：`videos_understand`，`video_info:[{ data: <20 MiB 合成字节的 base64>, prompt:"描述这个视频" }]`
（合成字节 = `ftypisom` 盒子头 + `0x11` 填充；**原始 20 971 520 B → base64 27 962 028 字符**。）

```
http=200 content-type="application/json; charset=utf-8" ms=127596 bodyBytes=1045
top-level code: 0 base_resp: status_code=0 status_msg="success"
TASK_ID CHECK: absent - no task was created, nothing billed
results[0].success=true source="inline:20971520B"
```

服务端原话（`description` 节选）：

> 这是一个非常可爱且有趣的短视频。……**主要对象**：视频的主角是一只毛茸茸的白色大狗（从外貌看很像一只萨摩耶），它正乖巧地坐在汽车的驾驶座上。……这只狗的视线完全被雨刷器吸引住了，它的头部随着雨刷器摆动的节奏，极其同步地左右来回转动……

### 4.3 判定：**服务端能吃 20 MiB inline**

| 判据 | 值 |
| :- | :- |
| HTTP | **200** |
| 顶层 `code` | **0** |
| `base_resp.status_code` | **0** |
| `results[0].success` | **true** |
| `results[0].source` | **`inline:20971520B`** —— 字节数**与服务端收到的完全一致** |
| 耗时 | **127 596 ms** |
| 体积 / 大小类拒绝 | **没有出现，一次都没有** |

**所以「20 MiB 会不会被服务端拒绝」这个问题的答案是：不会（至少在 20 971 520 B 这个尺寸上，没有任何拒绝的证据）。**

> **但成功 ≠ 解码。** 上面那段活灵活现的萨摩耶描述，是从 **`0x11` 填充字节**里"看"出来的。这与上一份报告在 1 MiB / 5 MiB 上观察到的现象**完全一致**：**`success:true` 只证明调用被受理，不证明画面被解码。** 这一条在 20 MiB 档位上再次成立，并且描述**换了一只动物**（之前是虎斑猫 / 紫红色洋葱 / 巷道狂奔）。
>
> **对实现的意义比"能不能收"更大**：一个不可解码的输入不会失败，它会返回**一段自信的、与内容无关的描述**。这是比报错更危险的失败模式。

### 4.4 但它是**不稳定**的：方差在延迟上，不在门限上

这一点必须如实写清楚，否则上面那个 200 会被误读成「20 MiB 稳定可用」。

| 尝试 | 预算 | 结果 |
| :- | :- | :- |
| 上一轮（`docs/minimax-video-free-checks.md` §4.3 R3） | 120 s | **超时** |
| 本轮第 1 次运行 | 300 s | **超时**（`TimeoutError`，300 032 ms） |
| 本轮第 2 次运行 | 300 s | **超时**（`TimeoutError`，300 032 ms） |
| 本轮第 3 次运行 | 300 s | **HTTP 200**（127 596 ms） |

**四次尝试：三次超时、一次成功。**（另有上一份报告记录的"另一次运行 84 s 返回 200"，未计入本表。）

**怎么读这张表**：

- **没有一次是「体积拒绝」。** 所有失败都发生在**客户端**（`TimeoutError: The operation was aborted due to timeout`），`http=0`，**没有 `code`、没有 `base_resp`**——即**服务端根本还没有作答**。
- **300 s 也照样超时过两次。** 所以「把预算拉长」**不是**一个能保证结果的解法，它只是把「一定超时」变成「有时成功」。
- **结论只能写到这一步**：**服务端在 20 MiB 上不存在我们观测到的体积门限；真正的约束是「等不等得到」，而等待时间是不可预测的。**

> **对实现的直接影响**：把 inline 上限定在 20 MiB 附近**不能**用「服务端收不收」当理由，只能用「我们愿意等多久、以及超时后怎么向用户交代」。**一个 127 s 甚至 300 s 才返回的同步调用，在产品上是不可接受的**——这与服务端能力无关。

---

## 5. 三个模型的完整参数规则（全部来自服务端自己的句子）

| 模型 | 合法 duration | 合法 resolution | 出处 |
| :- | :- | :- | :- |
| `MiniMax-H3` | **4–15** 秒 | **`768P` / `2K`** | 上一轮 B1/B2/B4/B5 |
| `MiniMax-H3-Max` | **5–15** 秒 | **`480P` / `768P`** | 本轮 B1 / B2 |
| `MiniMax-Hailuo-2.3` | **只能是 6 或 10** | **`768P` / `1080P`** | 上一轮 C1 + 本轮 A |

**三条必须记住的推论**：

1. **`MiniMax-H3-Max` 的 resolution 比 `MiniMax-H3` 低一档**（`480P`/`768P` vs `768P`/`2K`），**并且不接受 `2K`**。任何"给 H3 的 2K 直接套到 H3-Max"的写法都会产出**必被拒**的请求。
2. **`MiniMax-Hailuo-2.3` 的 duration 不是区间**，是两个离散值 `6` / `10`。任何 4–15 的滑块在切到 2.3 时都会产出**必被拒**的请求。
3. **三个模型的 resolution 集合互不相同，没有一个是全集。** `2K` 只有 H3 有，`1080P` 只有 Hailuo 有，`480P` 只有 H3-Max 有。**必须按模型分别校验，不能用一个全局白名单。**

---

## 6. 对现有实现的直接影响

> 本节只陈述实测事实指向哪里。**本次任务不改 `src/`。**

| # | 位置 | 实测要求 |
| :- | :- | :- |
| 1 | `video-tool.ts` 的参数校验 | 按模型分别校验 resolution：H3 = `768P`/`2K`；H3-Max = `480P`/`768P`；Hailuo-2.3 = `768P`/`1080P`。**大小写敏感**（上一轮已测：`720p` 与 `4K` 报同一句话） |
| 2 | `video-tool.ts` 的 duration 校验 | H3 = 4–15；H3-Max = **5**–15；Hailuo-2.3 = **离散 {6,10}**。`duration:0` 等同缺失（上一轮已测） |
| 3 | 参数校验的顺序 | 若客户端抢先校验，**顺序要与服务端一致**（`model → duration → resolution → prompt → ratio`），否则用户拿到的会是「我们编的」错误信息，而不是服务端真正的第一条规则 |
| 4 | `prompt` 校验 | **`prompt` 在 `resolution` 之后、`ratio` 之前被校验**，且缺失时的原话是 `prompt is required; describe the video to generate`。这一条可以直接当作用户可见文案 |
| 5 | inline 上限 | **20 MiB 服务端能吃**（实测 200 + `inline:20971520B`），**但耗时 127.6 s 且不稳定**（同尺寸另两次 300 s 超时）。上限应当由**我们能等多长**决定，并配一个**明确的超时话术**，而不是由"服务端收不收"决定 |
| 6 | `analysisOf()` 的判定 | **再次确认：`success:true` 不是"视频被看到"的证据。** 20 MiB 的 `0x11` 填充换来了另一段具体到"萨摩耶摇脑袋"的描述。必须能识别模型自述"没有上传/看不到"的句子 |

---

## 7. 未查清 / 明确保留

| # | 未验证项 | 为什么没查 |
| :- | :- | :- |
| 1 | `ratio` 的合法值 | **本轮把原因测实了**：`prompt` 排在 `ratio` 之前。能走到 ratio 的体必须带合法 prompt，而它距离计费只差"ratio 是否被校验"这一件未知的事。**零成本前提下无解** |
| 2 | `ratio` 到底**是否**被校验 | 同上。注意这两件事是**不同**的问题：我们既不知道它的合法值，也不知道它有没有校验 |
| 3 | 20 MiB 以上的尺寸 | 本轮只复测了 20 MiB 这一个点。**没有测 30 / 40 MiB**，因为每次尝试要占 2–5 分钟且可能超时，且 40 MiB 的 base64（约 53 MB）逼近我们自己的 transport 上限 |
| 4 | 20 MiB 为什么时快时慢 | 127.6 s 成功 vs 300 s 超时，**服务端侧的原因没有测**（排队？GPU 冷启动？）。本探针只能报「等待时间不可预测」 |
| 5 | `get_upload_url` → PUT → `cdn_url` → `videos_understand` 全链路 | 属于「上传」，需要真的写对象到 OSS；两轮都未做 |
| 6 | `MiniMax-H3` 的 resolution 是否也接受 `480P`/`1080P` | 上一轮只测了 `4K` 与 `720p`（都被拒）。服务端句子写的是 `must be 768P or 2K`，**按句子读是完整集合**，但**没有逐值验证过** |

---

## 8. 原始证据

探针把每一行日志**即时追加**写入：

```
%TEMP%\minimax-video-model-rules-transcript.log
```

> **修掉的一个实测缺陷**：第一版用的是 `void fs.appendFile(...)`，多个 append 互相竞争，导致**落盘行序错乱**（磁盘上是 C1、A1、B1、D1、B2，而控制台顺序正确）。transcript 是本文引用的产物，顺序不对的文件比没有文件更糟。已改成 **promise 链串行追加**：保留「边跑边写」的崩溃安全性，同时保证顺序。

最终引用的那次运行：**73 行**（其中 63 行非空），`EXIT=0`，耗时 **131.6 s**，**创建任务数 = 0**。

**保密自查**（对落盘文件跑正则，全部 **0 命中**）：

- 令牌：从不打印，只报 `<present:len=60>`。
- 邮箱 / UUID / JWT / 32+ 字符不透明串：`scrub()` 清除。
- 账号 id（`u<18 位数字>`，短于 32 位阈值）：单独规则替换为 `<user-id>`。
- URL：`oneLine()` 先经 `redactUrls()`，任意文本里的 URL 只以**形状**出现。
- 20 MiB 的 base64 **不入日志**：`displayBody` 替换成 `<base64 omitted: 27962028 chars>`。

---

## 9. 两次运行之间的一个不一致，如实记录

本轮 D 段共尝试三次：**只有一次拿到 200**（127.6 s），另两次在 300 s 上超时。

**这意味着：本文 §4.3 的"能吃 20 MiB"是确定的事实（有 200 与 `inline:20971520B` 为证），但"20 MiB 可用"不是。** 前者是服务端能力的结论，后者是产品可用性的结论，**两者不能混为一谈**。本文只声称前者。
