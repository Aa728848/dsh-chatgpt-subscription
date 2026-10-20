# MiniMax Code Matrix 视频工具：实测报告

**方法**：真实探针 `scripts/probe-minimax-video-generation.probe.ts`，对 `https://agent.minimax.cn/mavis/api/v1/mcp/<tool>` 发真实请求。
**计费**：真实提交生成**恰好一次**（用户已授权订阅额度）。失败不重试。
**保密**：令牌 / 邮箱 / 账号 id / realUserID 一律不出现；URL 只报**形状**（scheme / host / 段数 / 扩展名 / query 键名），不报值。

跑法：

```powershell
# 免费：只做第 1 步四个形状探针，不提交
npx vitest run --config vitest.probe.config.ts probe-minimax-video-generation

# 零成本复测一个已经花过钱的任务（不重新提交）
$env:DSH_PROBE_VIDEO_TASK='<task id>'
npx vitest run --config vitest.probe.config.ts probe-minimax-video-generation

# 花钱：买一次真实生成，必须显式打开
$env:DSH_PROBE_VIDEO_SUBMIT='1'
npx vitest run --config vitest.probe.config.ts probe-minimax-video-generation
```

---

## 0. 六个必答问题

| # | 问题 | 确定答案 |
| :- | :- | :- |
| 1 | `videos_understand` 的 body 形状 | `{"video_info":[{"url":"<http(s) URL>","prompt":"..."}]}` 或 `{"file":"<绝对路径>"}` 或 `{"data":"<base64>"}`。**键名不是 `file_url`**。文本在 `results[0].description` |
| 2 | `submit_video_generation` 必填字段与合法值 | 必填 **`model`** 与 **`prompt`**。`duration:4`、`resolution:"768P"` 被接受；`ratio` 未传，服务端自动定为 `16:9` |
| 3 | `query_video_generation` 的字段位置与终态拼写 | 全部在**顶层**：`status` / `video_url` / `duration`。终态就是 **`succeeded`**（不是 `success`） |
| 4 | `get_upload_url` 存在吗 | **存在**。返回 `put_url` / `cdn_url` / `oss_key` / `content_type` / `expires_in` |
| 5 | 真实生成跑通了吗 | **跑通**。`video/mp4`、**12 865 字节**、`ftyp`@4 → 合法 ISO BMFF；内容是纯黑 4 秒 |
| 6 | 花了多少额度 | **无法从这个接口读出**。`general` 桶前后两次读**完全没变**（interval 62% / weekly 79%）。见 §6 |

---

## 1. 第 1 步：四个免费形状探针

请求头恒定为实测通过的四个：`authorization: Bearer <token>`、`content-type: application/json`、`user-agent: MiniMaxAgent`、`accept: application/json`。无 query。

### F1 · `videos_understand` with `{}`

| 项 | 值 |
| :- | :- |
| HTTP | **400** |
| 顶层字段 | `code`, `message` |
| `base_resp` | **不存在** |
| 顶层 `code` | `400` |

服务端原话：

```
Missing required field 'video_info'. Use: {"video_info": [{"file": "/path/to/video.mp4", "prompt": "..."}]}
or {"video_info": [{"url": "https://...", "prompt": "..."}]}.
Do NOT use 'video_list', 'videos', 'tasks', or 'videos_info'.
File paths must be absolute (e.g. /Users/...), NOT file:// URIs.
```

**判定：端点存在，形状已被服务端逐字写明。** 这条错误消息本身就是规格书。

### F2 · `submit_video_generation` with `{}`

| 项 | 值 |
| :- | :- |
| HTTP | **400** |
| 顶层字段 | `code`, `message` |
| `base_resp` | **不存在** |
| 是否建了任务 | **没有**（响应无 `task_id`） |

服务端原话：

```
invalid request: model is required
```

**判定：端点存在；`model` 是最先被检查的必填字段。`{}` 不会建任务、不计费**——这一点在真实提交之前就已确认。

### F3 · `query_video_generation` 打一个不存在的 task

| 项 | 值 |
| :- | :- |
| HTTP | **200** |
| 顶层字段 | `code`, `message`, `base_resp` |
| 顶层 `code` | **`404`** |
| `base_resp.status_code` | **`0`**（"success"） |

服务端原话：

```json
{"code":404,"message":"video task was not found or does not belong to the current caller","base_resp":{"status_code":0,"status_msg":"success"}}
```

> **⚠️ 这条是本次最重要的发现。** 业务错误放在**顶层 `code`**，而 `base_resp.status_code` 仍然是 `0`。`src/host/minimax-code/matrix-client.ts` 的 `callMatrixTool()` 只读 `base_resp.status_code`，因此会把这个 404 当**成功**返回，上层拿到一个没有 `status` 的 body，`taskStatusOf()` 读出 `''`，轮询会一直转到 10 分钟超时才报错。**必须同时检查顶层 `code`。**

### F4 · `get_upload_url` with `{}`

| 项 | 值 |
| :- | :- |
| HTTP | **200** |
| 顶层字段 | `code`, `message`, `put_url`, `cdn_url`, `oss_key`, `content_type`, `expires_in`, `error`, `base_resp` |
| 顶层 `code` | `0` |
| `base_resp.status_code` | `0` |

响应形状（值已按纪律换成形状）：

| 字段 | 形状 |
| :- | :- |
| `put_url` | `https://minimax-public-cdn.oss-cn-wulanchabu.aliyuncs.com/...`，query 键 = `x-oss-credential`, `x-oss-date`, `x-oss-expires`, `x-oss-signature`, `x-oss-signature-version`（OSS V4 预签名 PUT） |
| `cdn_url` | `https://cdn.hailuoai.com/mcp/<user-id>/general/<ts>_<hash>.bin`，**无 query** |
| `oss_key` | `cdn-yingshi-ai-com/mcp/<user-id>/general/<ts>_<hash>.bin` |
| `content_type` | `"image/png"` ← 空 body 时的默认值 |
| `expires_in` | `600`（秒） |
| `error` | `""` |

**判定：端点存在。** 而且它**在 body 为空时也会分配 URL**（不校验 `filename`/`mime_type`/`size_bytes`，缺省填 `image/png`）。上传路径的三个字段名见 §5。

---

## 2. 第 2 步：真实生成（唯一一次计费调用）

### 提交

```json
{"model":"MiniMax-H3","prompt":"一张纯黑画面","duration":4,"resolution":"768P"}
```

| 项 | 值 |
| :- | :- |
| HTTP | **200** |
| 顶层 `code` | `0` |
| `base_resp.status_code` | `0` |
| `task_id` | 15 位数字串 |

**`model` 与 `prompt` 是仅有的两个必填项；`duration` / `resolution` 可选且被接受。`ratio` 不传也可以——服务端自己补成 `16:9`。**

### 轮询

间隔 5 s。观察到的状态序列：`running` → `succeeded`（`created_at` → `updated_at` 相差 **163 秒**）。

中间态（`running`）的完整响应：

```json
{"code":0,"message":"ok","task_id":"...","model":"MiniMax-H3","status":"running",
 "resolution":"768P","duration":4,"ratio":"16:9",
 "created_at":...,"updated_at":...,"base_resp":{"status_code":0,"status_msg":"success"}}
```

终态（`succeeded`）的完整响应——**这就是父代理要解析的文档**：

```json
{"code":0,"message":"ok",
 "task_id":"...","model":"MiniMax-H3",
 "status":"succeeded",
 "video_url":"https://algeng-video-infer.oss-cn-shanghai.aliyuncs.com/.../output_aigc.mp4?Expires=...&OSSAccessKeyId=...&Signature=...",
 "resolution":"768P","duration":4,"ratio":"16:9",
 "created_at":...,"updated_at":...,
 "total_seconds":4,"output_seconds":4,
 "base_resp":{"status_code":0,"status_msg":"success"}}
```

| 问题 | 答案 |
| :- | :- |
| `status` 在哪 | 顶层 `status`，字符串 |
| 终态拼写 | **`succeeded`**（`running` 是过程态）。未见 `success` |
| `video_url` 在哪 | 顶层 `video_url`，**只在 `succeeded` 时出现**，`running` 时该键不存在 |
| `duration` 在哪 | 顶层 `duration`（数字，**秒**）。另有 `total_seconds` / `output_seconds` |
| 签名 URL 形状 | OSS V1 签名：query 键 = `Expires`, `OSSAccessKeyId`, `Signature`；host = `algeng-video-infer.oss-cn-shanghai.aliyuncs.com`；扩展名 `.mp4` |

**签名有效期**：`Expires` 减 `updated_at` = **86 460 s ≈ 24.0 小时**。上游文档说"约 9 小时"，**实测是约 24 小时**。这是上游文档与实测不一致的一处，按实测记。

---

## 3. 第 3 步：产物落地与媒体理解

### 3.1 下载

| 项 | 值 |
| :- | :- |
| Range GET（前 1 MB） | HTTP **200**（不是 206），`content-length: 12865`，`accept-ranges: bytes`，**无 `content-range`** |
| 说明 | 文件只有 12 865 B，小于请求的 1 MB，服务端返回整个对象 |
| 完整下载 | HTTP 200，`content-type: video/mp4`，**12 865 字节** |
| 落盘位置 | `%TEMP%\minimax-video-probe-<random>\generated.mp4`（**不在插件源码目录**） |
| 文件头 16 字节 | `00000020 66747970 69736f6d 00000200` |
| 判定 | 偏移 4 起是 `ftyp`，brand `isom` → **合法 ISO BMFF / MP4** |

### 3.2 `videos_understand` 的三种传法（全部免费）

| 编号 | body | HTTP | `results[0].success` | 说明 |
| :- | :- | :- | :- | :- |
| **U1** | `{"video_info":[{"file_url":"<签名URL>","prompt":"..."}]}` | 200 | **false** | **这就是 `video-tool.ts` 今天的写法——错的** |
| **U2** | `{"video_info":[{"url":"<同一个签名URL>","prompt":"..."}]}` | 200 | **false** | 键名对了，但这个 URL 仍然读不了 |
| **U3** | `{"video_info":[{"data":"<base64 整片>","prompt":"..."}]}` | 200 | **true** | **成功，返回中文描述** |

U1 的服务端原话（注意 `base_resp.status_code` 仍是 0）：

```json
{"code":0,"message":"ok","results":[{"success":false,"description":"",
 "error":"video_info could not be read or decoded; download the resource in your local or sandbox workspace first, then call matrix_get_upload_url with filename, mime_type and size_bytes; PUT the local file to the returned put_url using the returned content_type, then use the returned `cdn_url` after the upload succeeds; if the file is unavailable, ask the user to provide the file; for a small file (up to 600KiB), call matrix_upload_to_cdn with base64-encoded file contents in `data` and its name in `filename`; alternatively, supply base64-encoded file contents in this tool's `data`",
 "source":""}],"base_resp":{"status_code":0,"status_msg":"success"}}
```

U2 的原话只把 `video_info` 换成 `video_info.url`：

```
video_info.url could not be used as a media source; download the resource in your local or sandbox
workspace first, then call matrix_get_upload_url ...
```

U3 的原话：

```json
{"code":0,"message":"ok","results":[{"success":true,
 "description":"这段视频全程为**纯黑屏**画面，没有任何可见的图像、动作、文字或视觉内容。",
 "error":"","source":"inline:12865B"}],"base_resp":{"status_code":0,"status_msg":"success"}}
```

**四个结论**：

1. **`file_url` 不是合法键**（F1 的报错早就说了，U1 确认了代价是 HTTP 200 + 静默失败）。
2. **`url` 这个键合法，但"签名 OSS URL"喂不进去**——服务端读不了它（U2）。这不代表任意公网 URL 都不行，只代表**这条签名 URL 不行**；探针没有用第二个公网 URL 再试，这个边界如实保留。
3. **`data`（base64 内联）是唯一被验证能读通的路径**，`source` 回显 `inline:12865B`。服务端自己说上限 600 KiB。
4. **成功/失败不在 HTTP 状态、也不在 `base_resp` 里，只在 `results[i].success` 里。** 文本在 `results[i].description`，错误在 `results[i].error`。

---

## 4. 对现有实现的直接影响

> 本节只陈述实测事实指向哪里。**本次任务不改 `src/`**——`video-tool.ts` 与 `matrix-client.ts` 正由另一人修改。

| # | 位置 | 现状 | 实测要求 |
| :- | :- | :- | :- |
| 1 | `matrix-client.ts` `callMatrixTool()` | 只读 `base_resp.status_code` | 还必须读**顶层 `code`**：F3 证明 404 会以 `code:404` + `base_resp.status_code:0` 到达 |
| 2 | `video-tool.ts` `analysisOf()` | 找 `content`/`description`/`analysis`/`text`/`result_text`，以及 `videos`/`video_info` 数组 | 真正的文本在 `results[i].description`，且必须同时检查 `results[i].success` |
| 3 | `video-tool.ts` 理解请求体 | `{video_info:[{file_url, prompt}]}` | 键是 `url` / `file` / `data`；**`file_url` 不被接受** |
| 4 | `video-tool.ts` `uploadLocalVideo()` | 从 `upload_url`/`presigned_url`/`url` 里猜，猜不到就抛 `MINIMAX_VIDEO_UPLOAD_SHAPE_UNVERIFIED` | 字段名已确定：**`put_url`（PUT 目标）/ `cdn_url`（对外可引用）/ `expires_in`**。请求体字段是 `filename`、`mime_type`、`size_bytes`（服务端原话），**不是**现在发的 `file_name`/`content_type`/`file_size` |
| 5 | `video-tool.ts` `taskStatusOf()` | 接受 `succeeded`/`success` | 实测只有 `succeeded`；`success` 是无害的多余分支 |
| 6 | 提交体 | 只发 `model`/`prompt`/`resolution`/`duration` | **实测足够**；`ratio` 可省，服务端补 `16:9` |

---

## 5. `get_upload_url` 的完整形状（本地文件 → 上传）

服务端在 U1 的报错里把整条流程写死了：

```
download the resource in your local or sandbox workspace first, then call matrix_get_upload_url
with filename, mime_type and size_bytes; PUT the local file to the returned put_url using the
returned content_type, then use the returned `cdn_url` after the upload succeeds;
for a small file (up to 600KiB), call matrix_upload_to_cdn with base64-encoded file contents
in `data` and its name in `filename`; alternatively, supply base64-encoded file contents in
this tool's `data`
```

因此请求体是：

```json
{"filename":"clip.mp4","mime_type":"video/mp4","size_bytes":12345}
```

响应（F4 实测，空 body 版本）：

```json
{"code":0,"message":"ok","put_url":"<预签名 PUT URL>","cdn_url":"<可引用 URL>",
 "oss_key":"...","content_type":"...","expires_in":600,"error":"","base_resp":{...}}
```

> **未验证项（如实保留）**：探针没有真的 PUT 一个文件上去，也没有验证 `cdn_url` 是否真的能被 `videos_understand` 读。F4 只证明了**端点存在、字段名确定、空 body 也会分配 URL**。`content_type` 在空 body 时回 `image/png`，说明它是对请求的回显而非校验结果。

---

## 6. 计费：读不到，且不能据此断言"免费"

额度接口 `GET https://api.minimax.cn/v1/api/openplatform/coding_plan/remains` 前后各读一次：

| 时刻 | 读数 |
| :- | :- |
| 提交前 | `general`: interval used=0/0 left%=62 · weekly used=0/0 left%=79 |
| 生成后 | `general`: interval used=0/0 left%=62 · weekly used=0/0 left%=79 |
| 差值 | **不变** |

响应里**只有 `general` 一个 bucket**，没有 video 专属行；`used=0/0` 说明这个接口给的是**百分比快照**而不是计数。所以：

- **不能**说"这次生成花了 0 额度"——只能说**这个接口看不出变化**。
- **不能**说"视频生成免费"——恰恰相反，上游 `tool-defs.ts` 明确写 submit 是计费的，`attemptedVideoSubmissions` 的幂等拦截就是为此存在。
- 真正的额度消耗可能在**别的口径**（例如 credits，而不是 Token Plan 百分比），本探针没有找到读取它的接口。**这是本次未解决的一项，如实记录。**

---

## 7. 未查清 / 明确保留

| # | 未验证项 | 为什么没查 |
| :- | :- | :- |
| 1 | `videos_understand` 能否读**任意公网 URL** | U2 只测了这条签名 OSS URL（失败）。测第二个公网 URL 需要额外素材，且结论依赖具体 URL，不宜从一个样本外推 |
| 2 | `get_upload_url` → PUT → `cdn_url` → `videos_understand` 全链路 | 需要真的写一个文件到 OSS；属于"上传"而非"读取"，本次未做 |
| 3 | `duration` 的合法区间、`resolution` 的完整枚举、`ratio` 的六个值 | 只测了 `4` / `768P` / 缺省。上游文档说 4–15、`768P|2K`、六选一，**本次未逐值验证** |
| 4 | `MiniMax-Hailuo-2.3` 的响应形状是否与 H3 一致 | 只跑了 H3（最便宜） |
| 5 | 真实额度消耗 | 见 §6 |
| 6 | `failed` / `cancelled` 终态的响应形状 | 要造一次失败，等于再花一次钱；**不为了"补全表格"去花钱** |

---

## 8. 原始证据去哪找

探针把每一行日志同时写进 `%TEMP%\minimax-video-probe-transcript.log`。要复现本报告的任何一行，跑一次探针（免费模式）然后读这个文件即可；本文所有"服务端原话"都逐字来自那里。

**保密自查**（脚本内已固化为 `scrub()` + `redactUrls()`）：

- 令牌：从不打印，只报 `<present:len=60>`。
- 邮箱 / UUID / JWT / 32+ 字符不透明串：`scrub()` 清除。
- **账号 id**：`oss_key` / `cdn_url` 里嵌着 `u<18 位数字>`，**短于 32 位阈值**，靠 `scrub()` 的兜底规则抓不到——已单独加规则替换为 `<user-id>`。这与 `realUserID` 是同一类陷阱（本探针干脆**不解析 realUserID**）。
- **URL 值**：`oneLine()` 先经 `redactUrls()`，把任意文本里的 URL 换成形状。**这是必须的**：签名 URL 的 query 里就是凭据，而 `scrub()` 不会把它当秘密——一个 URL 是由标点与片段组成的普通字符串。
- 落盘文件名：`generated.mp4`，不含任何账号信息。
