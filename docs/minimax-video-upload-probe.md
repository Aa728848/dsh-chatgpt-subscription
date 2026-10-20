# MiniMax Code 视频上传链路：实测报告（get_upload_url → PUT → cdn_url → videos_understand）

**方法**：真实探针 `scripts/probe-minimax-video-upload.probe.ts`，对 `https://agent.minimax.cn/mavis/api/v1/mcp/<tool>` 发真实请求，并真的把一个文件 PUT 进 OSS。
**计费**：上传**恰好一次**、理解**恰好一次**（用户已授权）。失败不重试。
**不生成视频**：上传对象是内嵌的 1586 字节合成 MP4（64×64 / 10 fps / 1 秒 / 纯黑），不花生成额度。
**保密**：令牌 / 邮箱 / 账号 id / realUserID 一律不出现；URL 只报**形状**（scheme / host / 段数 / 扩展名 / query 键名），不报值。

跑法：

```powershell
npx vitest run --config vitest.probe.config.ts probe-minimax-video-upload
```

---

## 0. 结论速览

| # | 问题 | 实测答案 |
| :- | :- | :- |
| 1 | `get_upload_url` 返回什么 | HTTP **200**，`code:0`，`base_resp.status_code:0`。字段：`put_url` / `cdn_url` / `oss_key` / `content_type` / `expires_in`(=600) / `error`(="") |
| 2 | PUT 成功是 200 还是 204 | **HTTP 200**，响应体为空（0 字节），带 `etag` 与 `x-oss-request-id` |
| 3 | `cdn_url` 是什么形状 | host = **`cdn.hailuoai.com`**，**4 段**，ext = `.mp4`，**无 query**（`queryKeys=[]`） |
| 4 | `videos_understand` 能否读 `cdn_url` | **能**。HTTP 200，**`results[0].success = true`**，`error = ""`，`source` 回显 cdn_url |
| 5 | 若失败，服务端原话 | **未触发**——本次成功，没有 `success:false` 可记 |
| 6 | 判定 | **链路成立**（附 §6 的 fidelity 保留——`success:true` 不等于描述忠于画面） |

> **一句话**：上一轮 U2 失败的那个形状（`oss-cn-shanghai.aliyuncs.com` + OSS 签名 query）和这条链路引用的形状（`cdn.hailuoai.com` + **无 query**）**不是同一个东西**。后者**实测可用**。

---

## 1. 方法与纪律

三步各只做一次，模块级守卫让第二次不可能发生（不是「记得别跑两次」，是跑不了）：

- 第 1 步 `POST .../get_upload_url`，body = `{"filename":"probe.mp4","mime_type":"video/mp4","size_bytes":1586}`
- 第 2 步 `PUT put_url`，`content-type` 用 broker 回显的那个（`video/mp4`），body 是 1586 字节
- 第 3 步 `POST .../videos_understand`，body = `{"video_info":[{"url":"<cdn_url>","prompt":"描述这个视频"}]}`

第 3 步的 body 形状**就是 `src/host/minimax-code/video-tool.ts` 上传路径发的那一个**（`media = { url: cdnUrl, prompt }`，再包进 `video_info[0]`）。

**额外加的一步（免费）**：第 2b 步用**无鉴权 GET** 回读 `cdn_url`。这一步不在原始要求里，但它是必要的——它把「对象根本没进桶 / 不公开」和「对象在、服务端仍不肯读」两种失败分开。没有它，第 3 步失败时无法归因。

**上传对象**：内嵌常量，运行时会打印 box 布局自证是合法 ISO BMFF：

```
clip bytes=1586 head16=000000206674797069736f6d00000200 box@4="ftyp"
boxes: ftyp@0=32 moov@32=822 free@854=8 mdat@862=724
```

---

## 2. 第 1 步：`get_upload_url`

| 项 | 值 |
| :- | :- |
| HTTP | **200** |
| 耗时 / 体积 | 312 ms / 794 字节 |
| 顶层字段 | `code`, `message`, `put_url`, `cdn_url`, `oss_key`, `content_type`, `expires_in`, `error`, `base_resp` |
| 顶层 `code` | `0` |
| `base_resp.status_code` | `0` |
| `content_type` | **`"video/mp4"`** |
| `expires_in` | `600`（秒） |
| `error` | `""` |

响应形状（值已换成形状）：

| 字段 | 形状 |
| :- | :- |
| `put_url` | scheme=https，host=**`minimax-public-cdn.oss-cn-wulanchabu.aliyuncs.com`**，**1 段**，ext=`mp4`，pathChars=83，queryKeys=`[x-oss-additional-headers, x-oss-credential, x-oss-date, x-oss-expires, x-oss-signature, x-oss-signature-version]` → **OSS V4 预签名 PUT** |
| `cdn_url` | scheme=https，host=**`cdn.hailuoai.com`**，**4 段**，ext=`mp4`，pathChars=56，**queryKeys=`[]`（无 query）** |
| `oss_key` | `cdn-yingshi-ai-com/mcp/<user-id>/general/<ts>_<hash>.mp4` |

**与 F4（空 body）的差别**：F4 时 `content_type` 回的是 `"image/png"`，扩展名是 `.bin`；这次声明了 `video/mp4` 就回 `video/mp4`，扩展名是 `.mp4`。说明 `content_type` 与扩展名是**对请求的回显**，不是校验结果。

---

## 3. 第 2 步：PUT（唯一一次真实写入）

| 项 | 值 |
| :- | :- |
| HTTP | **200**（**不是 204**） |
| 耗时 | 281 ms |
| 响应体 | **0 字节**（`bodyBytes=0`），`content-type` 响应头为 `(none)` |
| `etag` | 存在 |
| `x-oss-request-id` | 存在 |
| 判定 | **对象真的写进了桶** |

> 判定成功必须看 HTTP 状态：`ok`（200/2xx）即为成功。响应体为空是正常的，OSS 的 PUT 不回 body。

### 2b. 回读 `cdn_url`（无鉴权 GET，免费）

| 项 | 值 |
| :- | :- |
| HTTP | **200** |
| `content-type` | `video/mp4` |
| `content-length` | `1586` |
| 实际字节 | `1586` |
| 头 16 字节 | `000000206674797069736f6d00000200` |
| 与上传字节比对 | **完全相同**（`matches-upload=true`） |

**这一步的意义**：`cdn.hailuoai.com` 上的这个对象**公网可读、内容就是我们的、无需任何凭据**。第 3 步若失败，原因就只可能在服务端读取端，而不在桶里。

---

## 4. 第 3 步：`videos_understand`（唯一一次可能计费的调用）

请求：

```json
{"video_info":[{"url":"<cdn_url>","prompt":"描述这个视频"}]}
```

| 项 | 值 |
| :- | :- |
| HTTP | **200** |
| 耗时 / 体积 | 9389 ms / 1040 字节 |
| 顶层字段 | `code`, `message`, `results`, `base_resp` |
| 顶层 `code` | `0` |
| `base_resp.status_code` | `0` |
| `results[0]` 字段 | `success`, `description`, `error`, `source` |
| **`results[0].success`** | **`true`** |
| `results[0].error` | `""` |
| `results[0].source` | **回显 `cdn_url` 本身**（形状同 §2） |

完整响应（脱敏后，逐字来自 transcript）：

```json
{"code":0,"message":"ok","results":[{"success":true,
 "description":"这段视频记录了一场舞台才艺选拔或杂技表演的精彩片段：…",
 "error":"","source":"<cdn.hailuoai.com 的 URL 形状>"}],
 "base_resp":{"status_code":0,"status_msg":"success"}}
```

**`source` 字段是关键旁证**：inline 路径（上一轮 U3）回显的是 `"inline:12865B"`；这一轮回显的是 `cdn_url` 本身。说明服务端确实把这条 URL 当作**外部引用源**处理并取到了，而不是走了内联路径。

---

## 5. 与上一轮 U2 失败的对照——**这是本报告最重要的一节**

| 维度 | U2（上一轮，失败） | W1（本次，成功） |
| :- | :- | :- |
| 键 | `url` | `url`（**相同**） |
| host | `algeng-video-infer.oss-cn-shanghai.aliyuncs.com` | **`cdn.hailuoai.com`** |
| query | `Expires`, `OSSAccessKeyId`, `Signature`（OSS V1 签名） | **无 query** |
| 来源 | 生成任务的 `video_url` | 上传链路的 `cdn_url` |
| `results[0].success` | **false** | **true** |

**结论**：先前「签名 OSS URL 喂不进 `url` 键」的观察**成立但不可外推**——它描述的是那一个 host、那一种签名形状。上传链路引用的是**另一个 host、无 query 的公共 CDN 地址**，而**那个形状能用**。

> 不要把这条读成「`url` 键对任意公网 URL 都可用」。本次只测了 `cdn.hailuoai.com` 这一个来源、这一个对象。§8 如实保留这一点。

---

## 6. ⚠️ fidelity 保留：`success:true` 不等于「描述忠于画面」

探针返回 `success:true`，但**必须同时记下这个矛盾**：

| 项 | 事实 |
| :- | :- |
| 上传的画面 | 64×64、10 fps、1 秒、**纯黑**（内嵌前用 ffmpeg 解码验证：灰度 min=0 max=2，全部像素 0–2） |
| 返回的描述 | 一场**舞台杂技/钢管舞表演**——男评委、酒红色运动服女子、镜头切换、评委点头…… |
| 二者关系 | **描述不可能来自这些像素** |

所以准确的表述是**两个独立结论**：

1. **传输链路成立** —— broker → PUT → `cdn_url` 公网可读 → `url` 键被接受 → `success:true` + `source` 回显 cdn_url。这是**此前从未验证过的一环，现在实测跑通**。
2. **`success:true` 不证明描述忠于画面** —— 它证明的是「这个引用被成功取到并消费了」。对一段纯黑、几乎无信息的视频，模型会产生与画面无关的描述。这是**模型侧行为**，与传输缺陷是两回事，不能混为一谈。

**为什么这条必须写进报告而不是脚注**：如果只报「链路成立」，下游会把「上传路径可用」读成「上传路径产出的描述可信」，而后者本次**没有**得到验证。真实的、内容丰富的视频会不会得到忠实的描述，这份探针**回答不了**（见 §8）。

探针已把这个保留**固化进代码**：`success:true` 分支会单独打印一段 `fidelity, reported separately from the link`，并在 `source`、描述原文旁要求读者「READ THAT AGAINST THE CLIP」。

---

## 7. 对现有实现的影响（**本次不改 `src/`**）

> 本节只陈述实测事实指向哪里。

| # | 位置 | 现状 | 实测结论 |
| :- | :- | :- | :- |
| 1 | `video-tool.ts` `uploadLocalVideo()` 注释 | 标着 **「UNVERIFIED end to end」** | **该标签可以摘掉**：链路已实测跑通 |
| 2 | 同上，读 `put_url` / `cdn_url` | 读的就是这两个字段 | **与实测一致** |
| 3 | 同上，PUT 的 `content-type` | 取 broker 回的 `content_type`，缺省回退本地 mime | **与实测一致**（本次 broker 回了 `video/mp4`，PUT 被接受） |
| 4 | 同上，PUT 成功判定 | `put.ok` | **正确**：成功是 **200**，用 `=== 200` 或 `=== 204` 硬比较反而会漏 |
| 5 | 同上，把 `cdn_url` 填进 `video_info[0].url` | 是这么做的 | **与实测一致** |
| 6 | `video-tool.ts` 工具描述 | `transport:"upload"` 标注 **UNVERIFIED 且 opt-in** | 链路已可摘掉 UNVERIFIED；**但是否从 opt-in 改为「超限自动回退」，见下方 caution** |

### 关于「从 opt-in 改为超限自动回退」

**链路侧已经具备条件**：三步全通，且 2b 回读证明对象确实可公网取回、字节完全一致。

**但建议保留一条独立限制说明**，理由是 §6：本次 `success:true` 伴随一个与画面明显不符的描述。把上传路径变成**自动**回退路径意味着用户不会主动选择它、也不会预期它的行为；一旦它产出的描述不可信，用户看到的是「模型胡说」。因此建议：

- 链路本身：**可以从「未验证」升为「实测跑通」**；
- 自动回退：**可以做**，但应在工具描述/错误信息里保留「上传路径经服务端 CDN 转发，描述质量依赖服务端取回行为」这类说明，而不是当作与 inline 等价。

（以上只是**建议**，本次任务不改代码。）

---

## 8. 未查清 / 明确保留

| # | 未验证项 | 为什么没查 |
| :- | :- | :- |
| 1 | 上传路径对**真实大文件**（>40 MB）是否同样可用 | 本次刻意只传 1586 字节——验的是**链路**不是容量。大文件的上传耗时、预签名过期（600 s）是否够用，**未测** |
| 2 | `success:true` 的描述是否**忠于内容** | 本次素材是纯黑画面，模型产生了无关描述（§6）。要回答这个问题需要一段**内容丰富且已知内容**的视频，本次没有（也不生成，避免花钱） |
| 3 | `url` 键对**任意公网 URL** 是否可用 | 只测了 `cdn.hailuoai.com` 一个来源、一个对象 |
| 4 | 第 3 步**是否计费** | 探针未读额度。`docs/minimax-video-generation-probe.md` §6 已证明那个额度接口对该类消耗**看不出变化**，再读一次也只能得到「没变」，不构成证据 |
| 5 | `get_upload_url` 对文件大小/类型是否**校验** | 本次只发了合法的 `video/mp4` + 1586 字节。F4 已证明空 body 也会分配 URL（默认 `image/png`），但边界值未测 |
| 6 | 预签名 PUT 的 **600 s** 是否真的过期 | 本次 PUT 在签发后数秒内完成，未测过期行为 |

---

## 9. 原始证据与保密自查

探针把每一行日志同时写进 `%TEMP%\minimax-video-upload-probe-transcript.log`（本次 81 行）。

**⚠️ 版本说明（如实记录）**：本次运行的 transcript 来自**加入 fidelity 段落之前**的探针版本，因此第 72 行是 `LINK WORKS - cdn_url is readable under the url key`（没有括号里的 fidelity 提示），也**没有** §6 那段 fidelity 输出。§6 的内容是从**同一次运行的 `results[0].description` 原文**与**内嵌素材的已知内容**对照得出的，不是那次运行的额外日志行。探针文件的当前版本已包含该段落，但**未重跑**——重跑会再写一次 OSS、再花一次理解额度，与「各只做一次」的纪律冲突。

**保密自查**（脚本内已固化为 `scrub()` + `redactUrls()`，逐字沿用既有探针）：

- 令牌：从不打印，只报 `<present:len=60>`。
- 邮箱 / UUID / JWT / 32+ 字符不透明串：`scrub()` 清除。
- **账号 id**：`oss_key` / `cdn_url` 路径里嵌着 `u<18 位数字>`，**短于 32 位阈值**，靠 `scrub()` 的兜底抓不到——已由 `\bu\d{12,}\b → <user-id>` 规则替换。本次 transcript 第 22 行可见 `oss_key` 里已是 `<user-id>`，即该规则生效。
- **URL 值**：`oneLine()` 先经 `redactUrls()`，把任意文本里的 URL 换成形状。签名 URL 的 query 里就是凭据，必须挡。
- **`x-oss-request-id`**：只打印前 6 字符 + `...(truncated)`。
- 落盘文件名：`probe.mp4` / `probe-minimax-video-upload.probe.ts`，不含账号信息。
