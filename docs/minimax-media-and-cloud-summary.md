# MiniMax 视频工具 / 侧边栏播放 / 云端功能：调查结论

- **调查方式**：只读（上游源码经 raw.githubusercontent 读取，未 clone；未向 MiniMax 发活请求）+ 宿主检出 C:\\Users\\A\\Documents\\deepseek-harness\\ 的直接核查。
- **配套报告**：[`minimax-video-tools-feasibility.md`](./minimax-video-tools-feasibility.md)（视频工具）、[`minimax-video-playback-feasibility.md`](./minimax-video-playback-feasibility.md)（侧边栏播放）、[`minimax-cloud-capabilities-survey.md`](./minimax-cloud-capabilities-survey.md)（云端功能）。

> **三句话结论**：
> ① **视频工具能做**——上游那 18 个媒体工具走的**不是**平台 API Key，而是**订阅网关** `{agent}/mavis/api/v1/mcp/*`，认证只有 `Bearer <订阅 access token>`，**与我们 Messages 线路同一 origin、同一把令牌**。
> ② **侧边栏播放也能做，且不用改宿主**——宿主侧边栏预览是**按后缀注册、外部实现优先**的机制（`priority:'extension'` 排在 builtin 之前），mp4 被列进「无渲染器」名单只表示**没人认领**。我们插件加一个 client 依赖即可注册自己的 video 渲染器。
> ③ **已实测证实（2026-10-20）**：`POST https://agent.minimax.cn/mavis/api/v1/mcp/get_voice_list` 携带**仅** `Authorization: Bearer` + `Content-Type: application/json`（外加 `User-Agent`/`accept`）即返回 **HTTP 200**、`base_resp.status_code = 0`、`status_msg: "success"`、327 条音色。**不需要签名头、不需要身份头、不需要 query string、不需要平台 API Key。**

---

## 一、核心发现：上游的媒体工具走的是订阅网关，不是平台 API

这是整件事最反直觉、也最重要的一点。**公开的 `MiniMax-MCP` 用 `MINIMAX_API_KEY` + `api.minimax.io`（平台按量计费），但上游官方客户端自己内置的那 18 个媒体工具走的是完全不同的第二条路。**

| | 公开 MCP | **上游客户端内置（我们要走的）** |
| :- | :- | :- |
| host | `api.minimax.io` / `api.minimaxi.com` | **`agent.minimax.cn` / `agent.minimax.io`**（与我们 Messages 线路同一 origin） |
| 路径 | 平台 `/v1/*` | **`/mavis/api/v1/mcp/<tool>`** |
| 认证 | 平台 API Key | **`Authorization: Bearer <订阅 access token>`** |
| 计费 | 按量计费 | 订阅套餐 |

**[事实]** 路径重写（`packages/agent-tools/src/desktop/matrix-client.ts:15-16, 226-230`）：
```ts
const MATRIX_PROXY_PREFIX = '/matrix/api/v1/mcp/';
const LOCAL_GATEWAY_PREFIX = '/mavis/api/v1/mcp/';
export function toLocalGatewayPath(pathname: string): string {
  if (pathname.startsWith(MATRIX_PROXY_PREFIX)) {
    return `${LOCAL_GATEWAY_PREFIX}${pathname.slice(MATRIX_PROXY_PREFIX.length)}`;
  }
```

**[事实]** 认证只有一个头（`matrix-client.ts:203-207`）：
```ts
'User-Agent': MATRIX_USER_AGENT,   // 'MiniMaxAgent'
Authorization: `Bearer ${token}`,
```
managed origin 下**没有**任何 API Key 分支。

**[事实]** 18 个工具的完整路径表（`packages/agent-tools/src/cloud/matrix-tools/tool-defs.ts:571-590`）包含：
`web_search` / `images_understand` / `image_synthesize` / `images_search_and_download` / `image_reverse_search` / `submit_video_generation` / `query_video_generation` / `gen_videos` / `batch_text_to_video` / `batch_image_to_video` / `get_voice_list` / `batch_text_to_audio` / `batch_text_to_music` / `synthesize_speech` / `batch_synthesize_speech` / `audios_understand` / `videos_understand` / `listen_audio`（= `transcribe_audio`）。

### 关于那个 `agent-backend` lease：它不是「换来的更高权限令牌」

**[事实]** `packages/mcode-tools-host/src/lease-broker.ts:208` 的唯一动作是 `session.getAccessToken(minValidityMs)`——**把同一把订阅 access token 原样包进 lease 结构**，通过 named pipe 递给独立的 `mcode-tools` 子进程。
audience/scope 常量 `agent-backend` / `agent.default`（`packages/oauth-lease-protocol/src/contracts.ts:4-5`）与我们 `types.ts:41-43` **逐字相同**。
**它是 IPC 传输机制，不是权限升级**——这就排除了「需要额外换取更高权限令牌」的可能。

### 视频生成是异步的，且产物 URL 会过期

| 工具 | 形状 | 超时 |
| :- | :- | :- |
| `submit_video_generation` | 返回 `task_id` | 600s |
| `query_video_generation` | 轮询；succeeded 时**立刻下载** | 120s |
| `videos_understand` | **同步**、batch≤5、**不落产物** | 120s |

**[事实]** H3 签名 URL 有效期约 9 小时，生成成功后必须马上下载。
**[事实]** 模型二选一：`MiniMax-H3`（新、支持 768P/2K、**原生生成同步音频**）或 `MiniMax-Hailuo-2.3`（只接受一张参考图）。

### 一个命名陷阱

「**Matrix MCP**」这个名字有误导性——它是**名叫 MCP 的 REST 代理**，不走标准 Model Context Protocol。
**所以我们不需要实现 MCP 客户端**，只需 REST 调用 `POST /mavis/api/v1/mcp/<tool>`。

---

## 二、侧边栏播放：缺口不在宿主，在我们插件

### 三个环节的现状

| 环节 | 现状 | 归属 |
| :- | :- | :- |
| A 视频字节进来 | **完整已有** | 我们插件（kimi-code 的 `kimi_attach_video`） |
| B 视频产出 | **没有** | MiniMax 服务端 + 我们（第一节给了接口） |
| C UI 播放 | **没有** | **我们插件可以自己补**（见下） |

### 关键机制：侧边栏预览是「按后缀注册、外部实现优先」

**[事实]** `packages/client/ui-sidebar-documentpreview/src/client/document/registry.ts:9-28` 定义 `DocumentPreviewDefinition`（含 `extensions`、`binaryExtensions`、`priority`、`loading`、`title`），
同文件 `:36-49` 的排序规则：
```ts
rank: definition.priority === 'builtin' ? 0 : 1,
```
**外部实现（`extension`）排在产品实现（`builtin`）之前。**

**[事实]** `unviewable.ts:10-12` 把 `mp4/mov/avi/mkv/webm/flv/wmv/m4v` 列进「无渲染器」名单——但该文件自己的注释（`:1-8`）写明：

> A suffix belongs here only when its bytes are never readable text … **any renderer registration for a suffix takes precedence** because the owner consults this list only when no implementation matches.

**所以「mp4 在 unviewable 名单里」= 「没人实现」，不是「被禁止」。**

### 我们能不能注册？——能，而且不用改宿主

**[事实]** 服务由宿主 provide（`packages/client/ui-sidebar-documentpreview/src/client/index.ts:91` 的 `ctx.reflect.provide('documentPreviews', previews)`），
而**外部插件通过 `inject` 声明依赖是标准 Cordis 用法**——宿主自己的测试就写着 `{ inject: ['slots', 'locale', 'documentPreviews'], apply }`（`tests/code-registration.client.spec.tsx:15`）。

我们插件的 client 依赖是 `package.json` 里的 `dsh.client.inject` 包名列表（当前 6 个）：
```json
"client": { "inject": [
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-settings",
  "@deepseek-ai/dsh-client-ui-model-selection",
  "@deepseek-ai/dsh-client-ui-conversation",
  "@deepseek-ai/dsh-client-ui-tool"
] }
```
目标包的包名是 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`（已发布，0.2.1-rc.2，**有 `./client` 导出**）。**加一个依赖 + 注册一个渲染器即可。**

### 渲染器可以直接照抄 image 那套

**[事实]** `packages/client/ui-sidebar-documentpreview/src/client/image/index.ts:45` 是注册样板，`image/ImageBody.tsx:70-82` 是 Blob 生命周期（`createObjectURL` → `<img>` → `revokeObjectURL`，`loading:'bytes-complete'` 取整份字节）。
**把 `<img>` 换成 `<video controls>` 就是视频渲染器**，而且用整份字节（不走 Range）绕开下述限制。

### 宿主文件路由的三个限制（做之前要知道）

**[事实]** `packages/api/session-controller/src/media-references.ts` 接受任意**绝对路径**，用 `mime.lookup()` 定 Content-Type（`:30`），模块注释明说「Paths and MIME types do not restrict access」，测试已覆盖 `['mp4','video/mp4']`（`:98`）。
**所以「字节怎么到浏览器」不是问题。** 但：
1. **上限 20MB**（借的是图片的 `maxImageBytes`，`:69`）；
2. **完全不支持 Range/206**（整份读入后返回）→ 大视频无法 seek；
3. CSP sandbox + `no-store`。

用 `bytes-complete` 模式一次读整份，1 和 2 都不构成阻塞（只是不能 seek、大文件受限）。

### 关于「DSH 附件服务只存图片」

**[事实]** 这句话**仍然成立**（`attachment/src/types.ts:8` 的 `ImageMediaType` 四值联合是硬墙），
**但「附件服务」≠「文件服务」**——前者是会话附件（只存图片），后者是 `/api/file` 任意文件路由（能给浏览器发 mp4）。这是本调查最容易走偏的地方。

---

## 三、我们已有的两个先例（都能直接抄）

| 先例 | 位置 | 抄什么 |
| :- | :- | :- |
| **工具自带视图** | `src/client/index.tsx:214-230`（两处 `tool.call.toolview`）+ `src/client/CodexImageToolView.tsx` | 「工具产出媒体 → 插件自带卡片渲染」的完整范式；用 `loadImage` 拿会话授权的 URL |
| **视频落盘** | `src/host/kimi-code/video-tool.ts` + `video-store.ts` | DSH 没有视频块，所以自建 store（`~/.dsh/storages/kimi-code-videos`，id = 字节 sha256，幂等），再用 `createUserMessage` 注入自定义块 |

**[事实]** kimi 的 video-tool **没有**解决「产物落地 → UI 呈现」：输出 schema 只有 `source/mediaType/bytes/attachmentId`（`:190-200`，**没有路径没有 URL**），render 只返回一行文字（`:201-207`），与 video 有关的 slots 注册为 **0**。
它解决的是「怎么送进模型」，不是「怎么给人看」。**落盘层可以抄，呈现层不行。**

**[事实]** `kimi_attach_video` 有 provider 硬门禁（`video-tool.ts:65-70`：`provider !== 'kimi-code'` 直接抛错）——我们这条线要用得另写一个门禁不同的工具。

---

## 四、还缺什么（要做的话）

| # | 缺什么 | 成本 |
| :- | :- | :- |
| 1 | **Matrix 媒体客户端**（`POST /mavis/api/v1/mcp/<tool>` + bearer + 路由头） | 小——我们已有 host/region/token/refresh/号池 |
| 2 | **Matrix 预签名上传客户端**（`get_upload_url` + `PUT`，≤600KB 可内联） | 中——**注意这不是** `files-api.ts` 的 `mm_file://`，上游 `tool-defs.ts:213` 明确拒绝用它作入参 |
| 3 | **异步 task 状态机**（提交 → 轮询 → 立刻下载，URL 9h 过期） | 中——且要防重复计费 |
| 4 | **H3 参数校验**（首/尾帧、多模态参考 1-9 图 / 1-3 视频 / 1-3 音频，总计 ≤12） | 中 |
| 5 | **视频渲染器**（client 侧注册 documentPreviews video） | 小——照抄 image 渲染器 |
| 6 | **产物落盘 + 呈现**（存到 workspace/自定义 store；toolview 或文件链接） | 小——kimi 的 store 层可抄 |
| 7 | `video-store.ts:39-40` 的目录常量硬编码 | 需参数化 |

---

## 五、建议的顺序

### 第 0 步（✅ 已完成）：探针证实 Matrix 网关接受我们的 bearer

一次 `POST /mavis/api/v1/mcp/get_voice_list`（无输入、无生成、不落产物、最便宜）即可证实或证伪。
**这是整个结论唯一的实质风险点**：上游代码证明它*应该*接受，但「代码这么写」与「服务端此刻这么答」是两件事。

**实测结果（已通过）**：

```
[probe] endpoint=https://agent.minimax.cn/mavis/api/v1/mcp/get_voice_list region=cn
[probe]   headers=[accept,authorization,content-type,user-agent] body="{}"
[probe]   http=200 content-type="application/json; charset=utf-8" ms=298 bodyBytes=21954
[probe]   numeric fields: code=0, base_resp.status_code=0
[probe]   base_resp: status_code=0 status_msg="success"
[probe]     available_voices: array[327]
```

**只需要两个头**：`Authorization: Bearer <订阅 access token>` + `Content-Type: application/json`。

| 头 | 需要吗 | 证据 |
| :- | :- | :- |
| `Authorization: Bearer` | **要** | 不带即 401 |
| `Content-Type: application/json` | **要** | — |
| `User-Agent: MiniMaxAgent` | 大概率要（**[推断]**，未单独抽掉验证） | 上游 prod 就发这个值 |
| `yy`/`x-timestamp`/`x-signature` | **不要** | A 组不带即成功 |
| `user_id`/`biz_id`/`request_sk` | **不要** | C 组带了与 A 组无差别 |
| query string | **不要** | A 组无 query 即成功 |

**与上游源码完全吻合**：`managedBackendRoutingHeaders()` 在 prod 返回 `{}`、`postJson()` 不带 query——A 组一个路由参数都没带照样拿到完整报文。**代码怎么写，服务端就怎么答。**

原始证据：[`minimax-matrix-gateway-probe.md`](./minimax-matrix-gateway-probe.md)。

### 第 1 步：**先做「视频理解」**（`，videos_understand`）

- **同步**、单调用、**不落产物**、不产生长计费任务；
- 正好补上一个真实的洞：**我们这条 MiniMax 线目前完全没有视频输入工具**（`src/index.ts` 只给 kimi-code 注册了 `kimi_attach_video`），
- 而 `modalities.ts:32` 已说明 Anthropic Messages 协议**没有 video content part**——所以视频进模型**只能**走 `videos_understand`；
- 顺带把 Matrix 客户端、路由头、错误分类这三块基础设施建起来，生成工具直接复用。

### 第 2 步：视频生成（异步链路）+ 侧边栏渲染

生成链路更重（上传 → 提交 → 轮询 → 9 小时内下载 → 落盘），且**要花钱**；渲染器本身很轻。
**两者一起做才有用户价值**（生成出来却看不到，等于没做）。

### 明确否掉的

| 项 | 原因 |
| :- | :- |
| 用 `MINIMAX_API_KEY` 打公开 MCP | 要的是**平台 interface-key**，与订阅无关；而且我们已有更省的路 |
| 订阅令牌打 `api.minimax.*/v1/video_generation` | 同类端点实测回 `status_code:1004`（需平台 Key），见 `types.ts:69-73` |
| 在 Messages 请求里塞 video block | 协议没有 video part |
| 复用 `files-api.ts` 的 `mm_file://` 作媒体入参 | 上游 `tool-defs.ts:213` 明确拒绝 |
| 伪造 `yy`/`x-signature` 归因头 | 归因政策已拒；且上游媒体网关**根本没发**这三个头 |
| 扫全部工具路径 | 一次注册一个，不需要扫 |

---

## 六、没能证实的（不糊）

1. ~~**Matrix 网关对 bearer 的运行时接受度**~~ —— **已实测证实**（见第 0 步）。仍存的残余：只测了 `get_voice_list` 一个工具、cn 一个区域；`videos_understand` / `submit_video_generation` 共享同一前缀、同一 bearer、同一 `base_resp` 信封，**大概率**同样成立，但那是 [推断]。
2. **计费模型**——网关用 credits（能区分 `code 402 Insufficient credits`），但**与订阅套餐的扣费关系上游无任何说明**。做生成前必须实测或问用户。
3. **`gen_videos`/`batch_*` 三代接口并存的原因**——`tool-defs.ts:340-342` 只说是「pre-submit 时代的同步接口」，是否真同步阻塞未验证。
4. **`transcribe_audio` → `/mcp/listen_audio` 命名不一致**是否有意，未查。
5. **`agent-tools/src/cloud/` 目录列表**撞 GitHub API 限流，该目录下的其他内容未逐一确认。
6. **宿主若只接受一条改动**该改哪条——我推荐「内置一个 video 文档预览器 + 从 `unviewable.ts` 删掉 mp4」（对所有插件有利），但这属于**上游仓库**的决定，不是我们这个插件能单方面解决的。

---

## 七、云端功能（另见 `minimax-cloud-capabilities-survey.md`）

上游 `docs/open-source-status.md` 声明包含：
"MiniMax OAuth and Token Plan, BYOK, accounts, quota views, the official **plugin marketplace**, **managed connectors**, **search**, **mcode-tools**, **updates**, **feedback**, and bounded diagnostic clients."

**我们已覆盖的**：OAuth/Token Plan（登录、刷新、号池）、accounts（号池 + 桌面端凭据复用）、quota views（额度卡 + 重置卡 + 签到）、search（?）、mcode-tools（**未验证**）。
**我们没有的**：plugin marketplace、managed connectors、updates、feedback、以及**平台 API 那一整套媒体工具**（但媒体工具已有订阅路线，见第一节）。

**判定「云端」这个前缀的关键**：上游的画布 / miniapp / channel 那些服务（`packages/local-runtime-v2/src/service/{canvas,miniapp,channel-system}/`）**是上游客户端自己的本地功能，不是 MiniMax 云服务**——
真正的云端服务是那些挂在 `agent.minimax.{cn,io}` / `minimax-cloud` 前缀下的端点。这一区分决定了「云端功能」里有多少是**我们能通过订阅令牌复用的**（Media 工具、web_search、可能还有 marketplace），
有多少是**上游客户端的私有 UI 能力**（canvas/miniapp/channel——那部分对我们没有移植价值，宿主侧已有自己的实现）。

详见专篇报告。
