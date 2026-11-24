# MiniMax Code 视频能力：已验证事实底座（2026-10-28）

> 这份文档是**事实清单**，不含建议。每条都有出处（探针文档 / 上游源码路径:行号）。
> 目的是让下一个读代码或做差分的人**不必重跑探针**。

---

## 一、Matrix 媒体网关（订阅路线）

| 事实 | 值 | 出处 |
| :- | :- | :- |
| 端点 | `{agentBase}/mavis/api/v1/mcp/<tool>` | 上游 `matrix-client.ts:226-230` |
| host | cn `agent.minimax.cn` / en `agent.minimax.io` | 上游 `matrix-env.ts:18,24` |
| **`agent.minimaxi.com`** | **签到面的主机**（Matrix 的 LEGACY） | 上游 `matrix-env.ts:28` |
| 认证 | `Authorization: Bearer <订阅 access token>` | 实测 |
| 需要的头 | **只有** accept / authorization / content-type / user-agent | 实测 |
| **不要**的头 | `yy`/`x-timestamp`/`x-signature`（签到面的）、`user_id`/`biz_id`/`request_sk`、任何 query | 实测 |
| User-Agent | `MiniMaxAgent` | 上游 |
| 上传路径的上限 | 上游 `MATRIX_MAX_UPLOAD_BYTES = 500 MiB`；**客户端策略** inline 阈值 `600 KiB`（**不是服务端限制**） | 上游 `matrix-media-client.ts:13-14` |

## 二、成功判定（**最容易踩错的一条**）

| 事实 | 说明 |
| :- | :- |
| **成功 = 顶层 `code` 为 0 且 `base_resp.status_code` 为 0** | 两者**可以互相矛盾**：业务错误放在顶层 `code`，而 `base_resp.status_code` 仍是 `0`。上游 `client.ts:140-158` |
| 实测样例 | `{"code":404,"message":"video task was not found…","base_resp":{"status_code":0,"status_msg":"success"}}` |
| 只读 `base_resp` 的后果 | 把 404 当成功 → 轮询空转到 10 分钟超时 |
| **`results[0].success` 不证明字节被解码** | 送 1 MiB 的 `0x11` 填充字节 → `success:true` + 编造描述（「短视频平台上的对口型…」）。**正确归因是「画面里没有可读内容 → 模型编造」，不是「模型一律编造」**——真视频的描述实测是准的 |
| `source: inline:<N>` | **可靠的字节计数**（服务端确实收到 N 字节），可用于交叉核对 |

## 三、`videos_understand`

| 事实 | 值 |
| :- | :- |
| 合法的媒体键 | `file`（**绝对路径**，指服务端自己的机器）/ `url` / `data`（base64） |
| **`file_url` 不是合法键** | 服务端在 `{}` 时自己写明 |
| 媒体键的错误信息 | `Missing required field 'video_info'. Use: {"video_info":[{"file":"/path/to/video.mp4","prompt":"..."}]} or {"video_info":[{"url":"https://...","prompt":"..."}]}. Do NOT use 'video_list', 'videos', 'tasks', or 'videos_info'. File paths must be absolute, NOT file:// URIs.` |
| 成功判据 | **只在 `results[i].success`**（不在 HTTP 状态、也不在 `base_resp`） |
| 文字位置 | `results[0].description` |
| `results[0].source` | inline 路径是 `inline:<N>`；URL 路径**回显那个 URL** |
| **哪些 `url` 键能用** | **只有 MiniMax 自己的 CDN**（`cdn.hailuoai.com`，无 query）。第三方公网 URL 一律被拒（原话 `video_info.url could not be used as a media source`），**即使本机确认能取到正确 MP4 字节** |
| 签名的 OSS URL | **不能用**（另一个 host，带签名 query） |

## 四、`get_upload_url` / 上传

| 事实 | 值 |
| :- | :- |
| 请求体 | `{ filename, mime_type, size_bytes }` |
| 响应 | `put_url`（OSS-V4 预签名 PUT）、`cdn_url`（**要引用的地址**）、`oss_key`、`content_type`（**回显**请求的）、`expires_in: 600` |
| 顶层字段全集 | `[code, message, put_url, cdn_url, oss_key, content_type, expires_in, error, base_resp]` |
| **PUT 成功是 HTTP 200**（不是 204），body 0 字节，带 `etag` 与 `x-oss-request-id` |
| `cdn_url` 公网可读 | 实测回读，字节与上传**逐字节相同** |

## 五、`submit_video_generation` / `query_video_generation`

| 事实 | 值 |
| :- | :- |
| 必填 | **`model`**（最先被检查）**与 `prompt`** |
| `{}` 的行为 | HTTP 400「invalid request: model is required」，**不建任务、不计费** |
| 请求体（实测成功） | `{ model, prompt, duration: 4, resolution: "768P" }` |
| `ratio` | 可省，服务端补 `16:9` |
| 三个模型的 duration | **H3 4–15**、**H3-Max 5–15**、**Hailuo-2.3 只能 6 或 10**（离散值）——**全部实测** |
| `duration: 0` | 被当**缺失**（不是超范围） |
| resolution | **按模型**、**大小写敏感**、**三个集合互不相同**：H3 = `768P`/`2K`、**H3-Max = `480P`/`768P`**（比 H3 **低一档**）、Hailuo-2.3 = `768P`/`1080P`——**全部实测** |
| H3-Max 的 resolution | ✅ **实测** = `480P`/`768P`（**低于 H3 一档**，与「H3-Max 是增强版」的直觉相反） |
| query 请求体 | `{ task_id, model }` |
| `output_file_path` | **客户端本地参数**，不发往服务端 |
| 终态 | **`succeeded`**（`success` 不是） |
| 状态序列 | `running` → `succeeded`；`running` 时**没有** `video_url` 键 |
| 实测延迟 | `created_at`→`updated_at` 约 **163 秒** |
| 成功响应另带 | `total_seconds` / `output_seconds` |
| task_id 形状 | 15 位数字串 |
| 签名 URL 有效期 | **约 24 小时**（`Expires - updated_at` = 86 460 s）——**不是上游文档说的 9 小时** |

## 六、Token Plan 配额

| 事实 | 值 |
| :- | :- |
| `model_remains` | **只有一行**，`model_name = "general"` |
| **没有 video 桶** | 所以**视频生成的额度消耗从这个接口读不出来**（不是解析没读，是桶不存在） |
| `*_total_count` / `*_usage_count` | **恒为 0** → 接口只给百分比快照 |
| 窗口长度 | interval = **5 小时**（`end_time - start_time` = 18 000 000 ms）、weekly = 7 天 |
| 上游的 inline 门限 | **600 KiB 是客户端策略**，5 MiB 服务端照收不误 |
| **20 MiB inline** | **服务端能吃**（`source:"inline:20971520B"`，耗时 127.6 s），**从未出现体积拒绝**。但同档位在 120 s 与 300 s 预算下**超时过三次** → 真正的约束是**「等不等得到」，且等待时间不可预测**（拉长超时不是解法） |
| `ratio` 的合法值 | **零成本测不出**，且测出了原因：校验顺序实测为 `model → duration → resolution → **prompt** → ratio`，能走到 ratio 的体必须带合法 prompt，而那已距计费只差「ratio 是否被校验」——**没有第三处可以留非法** |

## 七、宿主侧（DSH）

| 事实 | 值 |
| :- | :- |
| 附件服务 | **只存图片**（`ImageMediaType` 四值联合） |
| **但**文件服务 ≠ 附件服务 | `/api/file` 接受任意绝对路径、`mime.lookup()` 定 Content-Type、测试已覆盖 `mp4` |
| 整文件读取上限 | **`maxFileBytes` 默认 32MB**（可配） |
| 超限的失败码 | `workspace-file/too-large` + `details.limit` |
| 宿主对它的对策 | `open`（**不是** retry——重读还是太大） |
| 侧边栏预览 | **按后缀注册、外部实现优先**（`priority:'extension'` 排在 builtin 之前） |
| mp4 在 `unviewable.ts` 里 | 只表示**「没人认领」**，不是「被禁止」 |
| 工具视图 | `tool.call.toolview` 是 **keyed 插槽**，插件可按工具名自带渲染 |
| 工具的结构化输出 | `value` **被排除在持久化事件外**；可用的是 `output.presentationMeta` → 客户端 `block.meta` |
| `dsh.client.inject` | **信息性的**（"informational — loading/prefetch metadata, never apply sequencing"），缺了**不会**让插件加载失败 |

## 七·补、方法论（本轮踩过的坑）

| 坑 | 教训 |
| :- | :- |
| 用**无词边界**的 `/ratio/` 判断「报错提到了 ratio」 | 服务端报错固定结尾是 `…for fast gene`**`ratio`**`n…` → 把「关于 resolution 的报错」误判成「关于 ratio 的」。**这正是「看起来合理的错误答案」的样本**——本轮探针第一轮 A 与 B1 都打印错了 |
| 用**一次运行**的成败下结论 | 20 MiB 那一档：120 s 超时 → 300 s 超时 → 300 s 超时 → 300 s 成功（127.6 s）。**方差必须一起读**，否则会把「等得到」误写成「有门限」 |
| 把**推断**写进代码后当实测 | 我们按 H3 照抄了 H3-Max 的 resolution（标了 `inferred`）——下一轮实测发现它**低一档**（`480P`/`768P`）。**标来源**这个习惯救了它：一眼能看出哪条该被质疑 |
| 探针**不被类型检查** | `scripts/` 原先不在任何 tsconfig 的 include 里 → 接上后立刻暴露 11 个探针自身的类型错误。**探针是证据来源，必须有静态网** |
| **展开 Error 会丢 `message`** | `{...error}` 丢掉非可枚举的 `message`。**但后果不是「假绿」**——实测 Vitest 4.1.11 里 `expect(undefined).not.toContain('x')` 与 `toContain` **同样抛错**（参数校验阶段，`not` 修饰不了它）。所以它让断言**必红、且报错文本完全误导**（读起来像内容不符，实际是参数非法）。**这解释了为什么所有真正检查 message 的用例都绕开了那个 helper** |

---

## 八、我们自己的实现边界

| 事实 | 值 |
| :- | :- |
| inline 上限 | 40 MiB（由 64MB 请求体上限折算）。**服务端能吃 20 MiB**（实测 200 + 字节数准确），但**耗时不可预测**（127.6 s 成功 / 另两次 300 s 超时）→ **这个上限应由「我们愿意等多久」决定，而不是「服务端收不收」** |
| 上传上限 | 200 MiB（与下载侧同值） |
| 生成落盘上限 | 200 MiB |
| 三道解码防线 | 容器嗅探（32 字节）/ 字节数交叉核对 / 「模型自述没看到」 |
| **视频理解的可信度（真视频）** | ✅ **准**。MDN CC0 `flower.mp4`（5.06s / 960×540 / 150 帧 / 0 场景切换）经上传链路送上 `cdn.hailuoai.com` → `success:true`，描述**逐条吻合画面**：「红色小花（类似马齿苋/太阳花）从紧闭的花苞逐渐舒展花瓣、缓缓绽放、露出中心黄色花蕊」——**物种级 + 时间性 + 细节级全中，编造词 0 个** |
