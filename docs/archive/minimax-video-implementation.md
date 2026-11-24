# MiniMax 视频能力：实现完成记录（2026-10-20）

- **规格**：[`minimax-video-design-spec.md`](./minimax-video-design-spec.md)（实现前锁定）
- **调查**：[`minimax-media-and-cloud-summary.md`](./minimax-media-and-cloud-summary.md)（三块能力的全景与可移植性）
- **探针证据**：[`minimax-matrix-gateway-probe.md`](./minimax-matrix-gateway-probe.md)
- **验证**：`npm run typecheck` 0 错误；`npx vitest run` **256 files / 4161 passed / 0 失败**（1 skipped）；`npm run build` 0 错误

---

## 〇、这一轮做成了什么

| 能力 | 状态 | 位置 |
| :- | :- | :- |
| **Matrix 媒体客户端** | ✅ | `src/host/minimax-code/matrix-client.ts` |
| **视频理解工具** `minimax_understand_video` | ✅ | `src/host/minimax-code/video-tool.ts` |
| **视频生成工具** `minimax_generate_video` | ✅ | 同上 |
| **工作区落盘** | ✅ | `src/host/minimax-code/media-store.ts` |
| **对话流工具卡片** | ✅ | `src/client/minimax-code/MinimaxVideoToolView.tsx` |
| **侧边栏视频渲染器** | ✅ | `src/client/minimax-code/MinimaxVideoDocumentBody.tsx` |

**没有跑真实生成**（用户决定）：全部用 mock fetch 验证。

---

## 一、Matrix 媒体面：实测确认的那条路

上游那 18 个媒体工具走的**不是**平台 API Key（`MINIMAX_API_KEY` + `api.minimax.io`），而是**订阅网关**：

```
POST {agentBase}/mavis/api/v1/mcp/<tool>
headers: accept / authorization / content-type / user-agent   ← 只有这四个
body:    {…}
```

**实测**（探针，2026-10-20）：`get_voice_list` → HTTP 200、`base_resp.status_code=0`、`status_msg="success"`、327 条音色。

| 头 | 需要吗 |
| :- | :- |
| `Authorization: Bearer <订阅 access token>` | **要** |
| `Content-Type: application/json` | **要** |
| `User-Agent: MiniMaxAgent` | 大概率要（**[推断]**，未单独抽掉验证） |
| `yy`/`x-timestamp`/`x-signature` | **不要**（那是签到面 `/minimax-cloud/api/v1/*` 的） |
| `user_id`/`biz_id`/`request_sk`、query string | **不要** |

**host 映射**：cn → `agent.minimax.cn`，global → `agent.minimax.io`。`agent.minimaxi.com` 是**签到面**的主机（上游 `matrix-env.ts:28` 明写它是 Matrix 的 LEGACY），别混。

---

## 二、承载机制：为什么走 `presentationMeta`

视频路径等结构化事实必须让客户端读得到，而工具的 `value` **被明确排除在持久化事件之外**（`packages/core/tools/src/index.ts:576`「deliberately omitted from durable events」）。

可用的通道是 **`output.presentationMeta`**——它随会话日志持久化（`packages/core/tools/src/presentation.ts:276`），落到客户端的 `ToolResultNode.meta`。

host 与 client 各有一份形状（`MinimaxVideoPresentationMeta`），**字段名逐字一致**：
`videoPath`（工作区相对路径）/ `mediaType` / `bytes` / `model` / `durationSeconds?` / `taskId`。
host 那份是**从共享 interface 构造**的（不是手抄两遍），client 那份由测试的赋值断言钉住。

---

## 三、工作区根目录：不需要降级方案

侧边栏文档预览**只认工作区文件**，所以生成的视频必须落在工作区。根目录的取法照抄宿主自己给 `run_code` 取 cwd 的做法（`packages/core/tools/src/index.ts:949-956`）：

1. `ctx.get('workingDirectory')?.ensure(agent, exec.signal)`；
2. 回退 `agent.session?.header?.cwd`（`packages/core/session/src/types.ts:106`）；
3. 两者皆无 → **明确失败**（`MINIMAX_VIDEO_NO_WORKSPACE`），并给出两条补救。

**刻意没有**静默回退到插件私有目录——那会报告一个用户打不开的「成功」。

---

## 四、客户端设计：与既有生图卡片同族

参照物是**同一个仓库里已经存在**的 `src/client/CodexImageToolView.tsx` + `.dsh-codex-image-tool*` 系列。**照抄它的解剖结构**，只把「图片格」换成「16:9 视频台」：

```
┌─ 发丝线卡片（radius 8）
│  ●  标题（13px / weight 500）        摘要（12px tertiary，ellipsis）
│  ┌─ 视频台：16:9，深色 letterbox，发丝线
│  │  <video controls preload="metadata">
│  └─
│  路径片（11px 等宽 chip）      时长  体积（11px tertiary，tabular-nums）
└─
```

**两个界面共用 `VideoStage` 一处定义**（`video-media.tsx`）——对话流卡片约 520px、侧边栏全尺寸，差一倍，但**观众看到的是同一个东西的两个尺寸**。

### 遵守的规则（逐条自查）

| 规则 | 依据 | 落实 |
| :- | :- | :- |
| 复用既有 token，不新增颜色 | DSH `dsh-client-ui-ux` / `web-styling.md:18` | 只用 `--dsw-alias-*`；新 CSS 里除 token 只出现 3 个 fallback（`#397ee8`/`#d94b4b`/`#000`） |
| **字重上限 500** | DSH `dsh-client-ui-ux`（feature CSS 不用 600+） | 新 CSS 里只有一处 `font-weight:500`；既有的 `.dsh-codex-image-title`（600）一行未动 |
| 字号只用既有刻度 | 同上（13px 是行/详情字号） | 11 / 12 / 13 三档 |
| 发丝线 0.5px | `web-styling.md:29` | 卡片、路径片、分隔一律 0.5px |
| 圆角配 `corner-shape:round` | `web-styling.md:24` | 8px / 6px / 50% 三档全部配对 |
| 焦点可见 | `web-styling.md:23` | 路径片 `:focus-visible` 2px 环 |
| 不用转圈、不用 loading 文案 | DSH 加载态规则 | 虚线占位块（与图片卡一致） |
| 失败保留数据可见 | DSH 反馈面规则 | 失败时占位块**保留**，只把文字换成 danger 色 |
| 中文错误最多两句、结尾无句号 | DSH `dsh-client-ui-ux` | locales 里的中文文案遵此 |
| 对象 URL 必须撤销 | — | 生命周期集中在 `useObjectUrl` 一处（建/换/撤） |

### 侧边栏渲染器：为什么不用改宿主

宿主的文档预览是**按后缀注册、外部实现优先**（`document/registry.ts:43`：`rank = priority === 'builtin' ? 0 : 1`）。
mp4 虽在 `unviewable.ts` 的「无渲染器」名单里，但该文件自己的注释说：

> any renderer registration for a suffix takes precedence because the owner consults this list only when no implementation matches.

**即「没人认领」，不是「被禁止」。** 我们注册 `priority:'extension'` 的实现即赢。
宿主**一行代码都不用改**。

---

## 五、诚实标注的未验证项

| # | 项 | 现状处理 |
| :- | :- | :- |
| 1 | **`get_upload_url` 的响应字段名** | 没有任何源码依据。**宽容提取** `upload_url`/`presigned_url`/`url`；一个都没有就抛 `MINIMAX_VIDEO_UPLOAD_SHAPE_UNVERIFIED`，并列出实际见到的 key 名、提示「传 http(s) URL 可跳过这一步，现在就能用」。**绝不把 undefined 当 URL 送上去**，也不把由此产生的业务拒绝伪装成「视频有问题」 |
| 2 | `videos_understand` 的文字在哪个字段 | 宽容提取 `content`/`description`/`analysis`/`text`/`videos[0].*`；无匹配时明确失败 |
| 3 | `query_video_generation` 的 `status` 拼写 | `succeeded`/`success` 都认 |
| 4 | **`cwd` 缺省** | 降级为**原样返回工作区相对路径**（仍是该会话地址空间里的合法路径，`readBytes` 与 `openFile` 都能用，只是不再声称是绝对的）。有测试钉住 |
| 5 | **视频整文件读取受宿主 `maxFileBytes` 限制** | 超限落到 `workspace-file/too-large`，卡片显示 `videoUnreadable` 占位。**没有**做分片——`<video>` 需要可 seek 的完整 Blob，分片拼不回来 |
| 6 | `sidebar.right.tab.document` 的槽 owner 形状 | 本实现按平台同形自己合并（该包不是编译期依赖）。**这是唯一一处版本敏感接缝**，宿主若改这个槽需要跟着改 |
| 7 | 上游矩阵媒体面是否对 `videos_understand`/`submit_video_generation` 同样放行 | 只实测了 `get_voice_list`。共享同一前缀、同一 bearer、同一 `base_resp` 信封，**大概率**成立，但那是 [推断] |

---

## 六、明确否掉的

| 项 | 原因 |
| :- | :- |
| 用 `MINIMAX_API_KEY` 打公开 MCP | 要的是平台 interface-key，与订阅无关；订阅这条路已实测可用且免费 |
| 在 Messages 请求里塞 video block | Anthropic Messages 协议没有 video content part |
| 复用 `files-api.ts` 的 `mm_file://` 作媒体入参 | 上游 `tool-defs.ts:213` 明确拒绝 |
| 伪造 `yy`/`x-signature` 归因头 | 归因政策已拒；且 Matrix 面根本不要 |
| 把视频存进附件服务 | 侧边栏只预览**工作区文件**；且附件服务的图片通道是 `ImageMediaType` 四值联合 |
| 分片读视频 | `<video>` 需要可 seek 的完整 Blob |

---

## 七、下一步

1. **要真正验证生成链路，需要跑一次真实生成**（花钱）——用户本轮选择不跑。
2. `get_upload_url` 的字段名（#1）需要一次上传探针才能坐实；在此之前「本地文件 → 上传 → 理解」这条路走不通，但「http(s) URL → 理解」已经可用。
3. 计费关系：网关用 credits（能区分 `code 402`），但**与订阅套餐的扣费关系上游无任何说明**。本仓库的 `client.ts:587-588` 注释记载订阅套餐有独立的 `video` 资源桶，但两者的换算没有依据。
4. 云端其余能力（插件市场 / 托管连接器 / `web_search`）——见 `minimax-cloud-capabilities-survey.md` 的排序。托管连接器**必须先探针**（账号里连接器清单为空则价值归零）。
