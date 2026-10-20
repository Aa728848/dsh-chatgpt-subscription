# 视频生成扩展：首/尾帧、参考媒体、非 16:9 比例（契约已锁定）

> 契约来源：上游 `MiniMax-AI/minimax-code` 的 `tool-defs.ts`（schema）、`tools/submit-video-generation.ts`（实现）、`file-transfer.ts`（载荷形状）、`desktop/matrix-media-client.ts`（上传体）。
> **本规格已锁定，实现者照它做，不要自行改字段名。**

---

## 〇、最容易踩错的一件事：**参数名 ≠ 发给服务端的字段名**

| 工具参数（模型看到的） | 发给服务端 |
| :- | :- |
| `input_image_path` | **`input_image`** |
| `last_frame_image_path` | **`last_frame_image`** |
| `reference_image_paths` | **`reference_images`** |
| `reference_video_paths` | **`reference_videos`** |
| `reference_audio_paths` | **`reference_audios`** |
| `reference_type` | `reference_type`（同名） |
| `model` / `prompt` / `duration` / `resolution` / `ratio` / `aigc_watermark` | 同名 |

**媒体载荷形状**：`{ url, mime_type }`；参考视频额外带 `duration_seconds`。

## 一、工具参数（在现有 `minimax_generate_video` 上新增）

| 参数 | 类型 | 说明 |
| :- | :- | :- |
| `inputImagePath` | string? | 首帧**或**尾帧图（由 `referenceType` 决定其含义）。公网 URL 或**工作区相对路径** |
| `lastFrameImagePath` | string? | 末帧图，**仅首+尾帧模式** |
| `referenceType` | `'first_frame' \| 'last_frame' \| 'subject'`? | 省略时按 `inputImagePath` 存在与否默认 `first_frame` |
| `referenceImagePaths` | string[]? | 1–9 张参考图（**仅 H3**） |
| `referenceVideoPaths` | string[]? | 1–3 个参考视频（**仅 H3**） |
| `referenceVideoDurationSeconds` | number[]? | **与参考视频同序的平行数组**，每个 2–15 秒 |
| `referenceAudioPaths` | string[]? | 1–3 个参考音频（**仅 H3**） |
| `ratio` | `'21:9'\|'16:9'\|'4:3'\|'1:1'\|'3:4'\|'9:16'\|'adaptive'`? | 见第三节的联动规则 |
| `aigcWatermark` | boolean? | H3 的 AIGC 水印开关，默认 false（上游默认） |

**命名**：沿用我们仓库既有的 camelCase 工具参数风格（`prompt`/`model`/`resolution`/`durationSeconds` 都是 camelCase），所以上面用 `inputImagePath` 这种形式。

## 二、媒体准备流程（已有能力复用）

1. **本地文件** → 用我们**已验证**的上传通道：
   - `get_upload_url` 的 body 必须是 **`{ filename, mime_type, size_bytes, category: 'user_file_upload_tmp' }`（**上游实测就是这个形状**——`category` 是**新增**字段，我们当前的实现没发它）；
   - `PUT put_url` ← 字节，`Content-Type` 用 broker 回显的 `content_type`；
   - 引用时用 `cdn_url`（**不是** `put_url`）——只有 `cdn.hailuoai.com` 无 query 的地址被实测证明能被 `url` 键读；
   - **永远走远端 URL，不内联**（上游用 `forceRemoteUrl: true`，因为这些是给生成任务用的输入）。
2. **公网 http(s) URL** → 上游**原样透传**（不下载不上传）。但**只有 MiniMax 自己的 CDN 地址能被服务端读**（实测：第三方公网 URL 一律被拒，原话 `video_info.url could not be used as a media source`）。
   - 所以我们**本地就要拒绝**非 `cdn.hailuoai.com` 的公网 URL（新错误码 `MINIMAX_VIDEO_URL_NOT_MINIMAX_CDN`——注意这个码**已存在**，是 understand 用的；generate 侧复用它，消息要指明是哪个参数）。
3. **扩展名与体积上限**（抄上游实测值）：
   - 图：`.jpg .jpeg .png .webp .heic .heif`（**Hailuo-2.3 只允许 `.jpg .png .webp`**），≤ **30 MiB**；
   - 视频：`.mp4 .mov`，≤ **50 MiB**；
   - 音频：`.wav .mp3`，≤ **15 MiB**。

## 三、`ratio` 的联动规则（**必须照抄上游的算法**）

上游 `submit-video-generation.ts:77-86`：
```ts
const effectiveRatio = isH3VideoModel(input.model)
  ? hasKeyframes ? 'adaptive'
    : hasReferences ? (input.ratio ?? 'adaptive')
    : (input.ratio ?? '16:9')
  : input.ratio
const effectiveResolution = isH3VideoModel(input.model)
  ? (input.resolution ?? '2K')
  : input.resolution
```

读法：
- **H3**：
  - 有首/尾帧 → **强制 `adaptive`**（用户给的 ratio 被忽略）；
  - 有参考媒体 → `ratio ?? 'adaptive'`；
  - 纯文本 → `ratio ?? '16:9'`；
- **非 H3**（Hailuo-2.3）：`ratio` 原样传（不设默认）。
- **H3 的 resolution 缺省是 `2K`**（我们当前**不传** → 要改成传 2K；Hailuo 不设默认）。

**注意**：`adaptive` **不能**用于纯文本模式（上游描述："cannot use adaptive"）——所以纯文本时若用户给了 `adaptive`，要**明确拒绝**而不是发出去。

## 四、参考视频的时长数组（**不需要解码器**）

上游有 `readIsoBmffDurationSeconds`（`tools/../iso-bmff-duration.ts`）——**自己读 MP4 的 `mvhd` box 算时长**，不依赖 ffmpeg。

上游规则（`prepareReferenceVideoCollection`）：
- **公网 URL** → **必须**由调用方给时长（服务端不下载，算不出来）→ 缺了就报错；
- **本地文件** → 上游**自己读容器**算时长。

**我们的做法**：
1. 实现一个**最小的 ISO BMFF 时长读取器**（读 `moov/mvhd`：version 0 → 32 位 timescale/duration，version 1 → 64 位）；**不引入 ffmpeg 依赖**。
2. **本地参考视频**：自动读出时长，**不需要**用户给 `referenceVideoDurationSeconds`；
3. **公网参考视频**：仍然**必须**用户给时长（与上游同）；
4. 用户若给了时长但我们也能读出来 → **以读出的为准**还是以用户给的为准？**以用户给的为准**（用户可能故意截取片段），但**若两者都存在且差得离谱**（比如差 >1 秒）→ **明确报错**并说出两个值（避免用户以为用了 5 秒而实际传了 12 秒）。

## 五、重复提交防护（上游有，抄）

上游维护一个 `attemptedVideoSubmissions: Set<string>`，键是 `sessionId:turnId:stableStringify(归一化后的输入)`，命中就**直接返回**「重复提交」而不发请求。

**为什么重要**：生成是**计费的**，而模型在同一轮里可能重复调同一个工具。

我们要做的：
- 进程内维护一个 `Set<string>`（键含会话 id + 轮次 + 归一化参数）；
- 命中 → **不发送**，返回一个明确的「这一轮已经提交过同样的生成任务」结果（**并把 task_id 一并带回去**，若上一次成功过的话——上游不这么做，但带回去对模型更有用）。
- 键里的「归一化参数」= **最终发给服务端的 body**（这样 ratio 被联动改写后也算同一份）。

## 六、参数量与上限（抄上游实测）

| 集合 | 数量 | 仅限 |
| :- | :- | :- |
| 参考图 | 1–9 | **仅 H3** |
| 参考视频 | 1–3 | **仅 H3** |
| 参考音频 | 1–3 | **仅 H3** |
| 参考媒体**总计** | ≤ **12**（图+视频+音频） | 仅 H3 |

**超限要本地拒绝**（不发送），错误消息要指名是哪个集合、超了几个。

## 七、Hailuo-2.3 的限制

上游描述：Hailuo-2.3 支持 `first_frame` 或 legacy `subject`，**不支持** `last_frame`、**不支持**参考集合。
→ 我们本地要拒绝「Hailuo + 参考媒体」和「Hailuo + last_frame」，错误消息要指名。

## 八、测试要求

1. **字段名映射**：断言发出去的 body 用的是 `input_image` / `last_frame_image` / `reference_images` / `reference_videos` / `reference_audios`，**不是**参数名；
2. **ratio 联动**：H3 + 首帧 → body 的 ratio 是 `adaptive`（即使用户给了 16:9）；H3 纯文本 → `16:9`（用户没给时）；H3 纯文本 + 用户给 `adaptive` → **本地拒绝**；Hailuo → 原样传；
3. **H3 resolution 缺省 → body 里是 `2K`**；Hailuo → 不带 resolution；
4. **集合上限**：9 张图 / 3 个视频 / 3 个音频 / 总计 12 → 各有一条超限用例，断言**不发请求**；
5. **Hailuo 限制**：Hailuo + 参考图 / + last_frame → 拒绝且不发请求；
6. **时长**：本地 mp4 → 读出时长（构造一个带 `mvhd` 的最小 mp4 断言读出的秒数）；公网 URL 没给时长 → 拒绝；
7. **扩展名/体积**：非白名单扩展名、超体积 → 拒绝且不发请求；
8. **重复提交**：同一轮同一参数第二次调用 → **不发请求**，结果里带第一次的 task_id；
9. **上传体**：断言 `get_upload_url` 的 body 含 `category: 'user_file_upload_tmp'`。

## 九、边界

- 只能改 `src/host/minimax-code/video-tool.ts`、可新增 `src/host/minimax-code/iso-bmff-duration.ts`、以及该工具的测试文件。
- **不许碰**：其它 minimax-code 文件、`src/client/**`、`scripts/probe-*`、`docs/**`、`src/index.ts`、`src/host/progress-updates/**`。
- **不发任何真实请求**（本轮只做静态实现与单测）。
- 不 git commit。

## 十、报告
- 改前 → 改后 + 文件:行号；
- 逐条对应上面哪一节；
- **哪些是抄上游、哪些是我们自己的决定**（明确区分）；
- 新增测试的用例名；
- typecheck / vitest 摘要。