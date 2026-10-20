# MiniMax 视频工具可行性报告

> **调查方式**：只读。上游源码经 `raw.githubusercontent.com` 读取，未 clone；未向任何 MiniMax 端点发出活请求。
> **标注约定**：**[事实]** = 上游源码 / README 原文可追溯；**[推断]** = 本文判断，未经运行时验证。

---

## 1. 结论先行

**能做，而且第一档就成立：我们的 `mcode-public` 订阅令牌可以直接调视频能力，不需要平台 API Key。**

MiniMax Code 桌面客户端内置的整套媒体工具（含视频生成与视频理解）走的是**订阅网关**，不是平台 API。它使用与我们完全相同的 bearer 令牌、相同的 OAuth scope/audience、相同的 host。这一点在源码里是闭合的，不是靠猜。

### 三档判定

| 档位 | 判定 | 依据 |
| --- | --- | --- |
| **① 用现有订阅令牌直接做** | ✅ **成立** | 媒体工具端点为 `{agent.minimax.cn}/mavis/api/v1/mcp/*`，认证仅 `Authorization: Bearer <订阅 access token>`，令牌 scope `agent.default` / audience `agent-backend`，与本仓库线路持有的是同一种凭证 |
| ② 需要用户额外提供平台 API Key | ⚠️ **不必要**（但第二条独立路径） | 公开 MCP（`MiniMax-MCP` / `MiniMax-Coding-Plan-MCP`）走 `api.minimax.io` + `MINIMAX_API_KEY`，那是**平台按量计费 Key**，与订阅无关 |
| ③ 上游也没有可用路径 | ❌ **不成立** | 上游 18 个 Matrix MCP 工具全部可用，视频生成/理解俱全 |

**一句话**：订阅令牌打的是 Matrix 媒体网关（`/mavis/api/v1/mcp/`），平台 Key 打的是 `api.minimax.*` 的 `/v1/*`。两条路都通，但它们**不是同一条路**——我们手上已有的令牌走的是第一条。

---

## 2. 上游怎么做的

### 2.1 端点：从代理路径重写到本地网关路径

上游工具定义里写的是**代理路径**（archon-server 的 `/matrix/api/v1/mcp/`），桌面客户端发出去之前会把它重写成**本地网关路径**：

**[事实]** `packages/agent-tools/src/desktop/matrix-client.ts`
```
15: const MATRIX_PROXY_PREFIX = '/matrix/api/v1/mcp/';
16: const LOCAL_GATEWAY_PREFIX = '/mavis/api/v1/mcp/';
...
226: export function toLocalGatewayPath(pathname: string): string {
227:   if (pathname.startsWith(MATRIX_PROXY_PREFIX)) {
228:     return `${LOCAL_GATEWAY_PREFIX}${pathname.slice(MATRIX_PROXY_PREFIX.length)}`;
230:   if (pathname.startsWith(LOCAL_GATEWAY_PREFIX)) return pathname;
```

**[事实]** `postJson()` 在发出前无条件经过该重写（`matrix-client.ts:94`），最终 URL 为 `${baseUrl}/mavis/api/v1/mcp/<tool>`。

### 2.2 Host：与我们的 Messages 线路同一个 origin

**[事实]** `packages/agent-tools/src/desktop/matrix-env.ts`
```
18:   prod: 'https://agent.minimax.cn',     // cn
24:   prod: 'https://agent.minimax.io',     // en
28: const LEGACY_MANAGED_MATRIX_BASE_URLS = new Set(['https://agent.minimaxi.com']);
```

对应本仓库 `src/host/minimax-code/types.ts:54-63` 的 `REGION_HOSTS` —— **同一个 host**。`agent.minimaxi.com` 也在这两条线的历史别名里（本仓库 `checkin-gateway.ts:63`），说明 cn 区有三个可用 origin。

### 2.3 认证：就是订阅 bearer 令牌

**[事实]** `matrix-client.ts:198-212` 的 `buildHeaders()` 只产出一个凭据头：
```
204: 'User-Agent': MATRIX_USER_AGENT,   // 'MiniMaxAgent'
205: Authorization: `Bearer ${token}`,
```

**[事实]** token 来源二选一（`matrix-client.ts:73`）：`explicitAccessToken`（仅非 managed base URL 才读 `MATRIX_TOKEN`，见 `matrix-env.ts:40`），否则走 managed-login 的 `authContext.accessToken`——即**订阅登录态令牌**。managed origin 下没有任何 API Key 分支。

### 2.4 那个 `agent-backend` lease 到底是什么（回答你的核心疑问）

**关键结论：lease 令牌不是"从订阅令牌换来的另一种令牌"，它就是订阅 access token 本身，换了个进程边界递过去。**

**[事实]** `packages/mcode-tools-host/src/lease-broker.ts:208` —— broker 拿到 lease 的唯一动作是向桌面会话要一个 access token：
```
208: return await session.getAccessToken(minValidityMs);
```
随后原样包装成 lease（`lease-broker.ts:133-137`）：`accessToken` / `audience: AUTH_LEASE_AUDIENCE` / `scopes: AUTH_LEASE_SCOPES`。

**[事实]** `packages/oauth-lease-protocol/src/contracts.ts`
```
4: export const AUTH_LEASE_AUDIENCE = 'agent-backend' as const;
5: export const AUTH_LEASE_SCOPES = ['agent.default'] as const;
```

**[事实]** 这两个值与本仓库 `src/host/minimax-code/types.ts:41-43` **逐字相同**：
```
41: export const MINIMAX_CODE_SCOPE = 'agent.default'
43: export const MINIMAX_CODE_AUDIENCE = 'agent-backend'
```

**含义 [推断]**：lease 是一个**传输层机制**（Windows named pipe / Unix socket，见 `oauth-lease-protocol/src/endpoints.ts` 的 `mcode-auth-lease-<sha256(dataDir)[:16]>` 与 `mcode-auth-lease-v1.cap` capability 文件），作用是让独立子进程 `mcode-tools` 不必碰用户的 `auth.json`。它**不是**一次权限升级，也没有独立签发链路——scope/audience 与订阅令牌完全一致，所以**媒体工具令牌与 Messages 令牌是同一把钥匙**。这排除了"需要额外换一个更高权限令牌"的可能。

### 2.5 调用形状：视频生成是异步的，理解是同步的

**[事实]** `packages/agent-tools/src/cloud/matrix-tools/tool-defs.ts:571-590` —— 18 个工具的路径表（节选视频相关）：

| 工具 | 网关路径（重写后） |
| --- | --- |
| `submit_video_generation` | `/mavis/api/v1/mcp/submit_video_generation` |
| `query_video_generation` | `/mavis/api/v1/mcp/query_video_generation` |
| `gen_videos` | `/mavis/api/v1/mcp/gen_videos` |
| `batch_text_to_video` | `/mavis/api/v1/mcp/batch_text_to_video` |
| `batch_image_to_video` | `/mavis/api/v1/mcp/batch_image_to_video` |
| `videos_understand` | `/mavis/api/v1/mcp/videos_understand` |
| `transcribe_audio` | `/mavis/api/v1/mcp/listen_audio` ← **注意名字不一致** |

**[事实]** 异步契约（`tool-defs.ts:199-215` 的 `submit_video_generation` 描述 + `:319-335` 的 `query_video_generation`）：

- `submit_video_generation` —— *"Submit exactly one asynchronous video task and return `task_id` immediately."* 请求体：`{ model, prompt, duration, resolution, ratio, input_image, last_frame_image, reference_images[], reference_videos[], reference_audios[], reference_type, aigc_watermark }`。
- `query_video_generation` —— *"Query one previously submitted video task once… Returns queued/running/failed/cancelled without writing a file. When status is `succeeded`, downloads `video_url` immediately… because MiniMax-H3 signed URLs are valid for only about 9 hours."* 请求体仅 `{ task_id, model }`。
- 模型枚举只有两个：`MiniMax-H3`（H3.0）与 `MiniMax-Hailuo-2.3`（H2.3），见 `tool-defs.ts:195`。
- H3 关键参数：duration **4–15 秒**（整数）、resolution `768P`|`2K`、ratio 六选一或 `adaptive`；H3 **原生带同步音频**（`tool-defs.ts:209`）。
- 幂等：同一 session+turn 内相同请求体重复 submit 会被本地拦截（`submit-video-generation.ts` 的 `attemptedVideoSubmissions`），因为每次 submit 都是**计费**的。

**[事实]** 超时（`tool-defs.ts:604-626`）：生成类 **600 000 ms (10 min)**，理解/查询类 **120 000 ms (2 min)**。

**[事实]** `videos_understand` 是同步批处理：最多 5 个本地视频一次送进 mcp-server 的 Gemini 后端，返回文本描述，**不落盘任何产物**（`tools/videos-understand.ts` 文件头注释原文）。

### 2.6 产物形态：远程 URL → 本地文件

**[事实]** `tools/query-video-generation.ts:59-74`：`status === 'succeeded'` 时取 `response.video_url`，立即 `downloadOutputFile(...)` 写入调用方指定的 workspace 相对路径。成功响应缺 `video_url` 会被当成错误（`:61-71`）。

**[事实]** 输入侧对称：本地文件经 `POST /mavis/api/v1/mcp/get_upload_url` 换预签名 PUT（`matrix-media-client.ts:22`），**≤600 KB 直接内联 base64 不走上传**（`MATRIX_INLINE_LIMIT_BYTES`，`matrix-media-client.ts:19`），上限 500 MB（`:20`）。

### 2.7 对照：公开 MCP 走的是另一条路（平台 Key）

**[事实]** `MiniMax-AI/MiniMax-MCP` README 第 49-52 行与 `MiniMax-AI/MiniMax-Coding-Plan-MCP` README 第 47-50 行，两张表**逐字相同**：

| 环境变量 | Global | Mainland |
| --- | --- | --- |
| `MINIMAX_API_KEY` | platform user-center 的 interface-key | 同上（`platform.minimaxi.com`） |
| `MINIMAX_API_HOST` | `https://api.minimax.io` | `https://api.minimaxi.com` |
| `MINIMAX_MCP_BASE_PATH` | 本地输出目录 | — |
| `MINIMAX_API_RESOURCE_MODE` | `url`（默认）/ `local` | — |

**[事实]** README 第 78-80 行明确 *"The API key needs to match the host"*。

**注意**：这两个 README 都指向 `platform.*` 的 **interface-key**（按量计费平台 Key），**不是**订阅令牌。**[推断]** 把 `mcode-public` 的 access token 塞进 `MINIMAX_API_KEY` 打 `api.minimax.*` 不会成立——本仓库已经实测过同类结论：`src/host/minimax-code/types.ts:69-73` 记录，订阅令牌打平台路由 `/v1/token_plan/remains` 一律返回 `base_resp.status_code: 1004`（"Please carry the API secret key"）。

---

## 3. 我们要缺什么

差距比预想的小得多。**认证和令牌这一层，我们什么都不缺。**

| # | 差距项 | 现状 | 成本 |
| --- | --- | --- | --- |
| 1 | **端点 / host** | ✅ 已有。`agent.minimax.cn` 就在 `types.ts:54-63` | **零** |
| 2 | **认证（bearer）** | ✅ 已有。`client.ts:65-74` 的 `authorization: Bearer` 规则可直接复用 | **零** |
| 3 | **订阅令牌 / 刷新 / 账号池** | ✅ 已有。`oauth.ts` + `token-store.ts` + `account-pool.ts` | **零** |
| 4 | **平台 API Key** | ❌ 没有，且**本方案不需要** | 不需要 |
| 5 | **媒体上行通道** | ⚠️ 部分。`files-api.ts` 是 `/files/upload` + `mm_file://`，**不是** Matrix 的 `get_upload_url` + 预签名 PUT | **中**：需新增一个预签名上传客户端 |
| 6 | **产物落盘（视频字节）** | ⚠️ 部分。`video-store.ts` 能存，但 key 前缀是 `kimi-code-videos`，且无「从 URL 下载大文件到 store」的路由 | **低-中**：泛化 store + 加 downloader |
| 7 | **DSH 侧工具注册** | ✅ 机制已有。`index.ts:1156` `ctx.tools.register(createKimiVideoTool(...))` | **低**：照抄该模式 |
| 8 | **异步任务状态机** | ❌ 没有。需 task_id 持久化 + 轮询 + 去重（防重复计费） | **中**：这是主要工程量 |
| 9 | **H3/Hailuo 参数校验** | ❌ 没有。duration 4-15、ratio 枚举、参考素材上限（图 1-9 / 视频 1-3 / 音频 1-3、合计 ≤12） | **中**：规则多但确定性高 |
| 10 | **计费可见性** | ❌ 没有。每次 submit 都花钱，用户需要事前确认 | **低-中**：需在产品层明确 |

### 需要特别注意的两个坑

**坑一：`types.ts:181-217` 的 64 MB body 限制不适用于媒体工具。** 媒体工具是 JSON + URL/短 base64（≤600 KB 内联），走的是另一条 HTTP 面，不经过 Messages 的 body guard。

**坑二：`files-api.ts:19-24` 记录的那个反直觉事实仍然成立但**不适用**。** `/files/upload` 会因为 `X-Msh-*` 头而返回 2013；但 Matrix 网关是**另一条路径**，它的上游客户端发的头是 `User-Agent: MiniMaxAgent` + `Authorization` + `Content-Type`（`matrix-client.ts:204-206`），**没有** X-Msh。**[推断]** 因此不要把 files-api 的"裸 bearer"结论机械外推到 Matrix 网关——两者的头部容忍度需要各自验证。

---

## 4. 本地先例：kimi-code 的 video-tool.ts 做到了哪一步

**它做的是「视频输入（理解）」，不是「视频生成」。** 这是最重要的一条先例，因为它把"视频怎么进 DSH 会话"这条路彻底打通了。

| 能力 | kimi-code 现状 | 位置 |
| --- | --- | --- |
| 从本地绝对路径读视频 | ✅ 含 `isFile` / 大小 / 容器校验 | `video-tool.ts:89-115` |
| 从 http(s) URL 拉视频 | ✅ 含 **SSRF 防护**（`assertPublicFetchTarget`） | `video-tool.ts:124-168` |
| 落到本地 store | ✅ `saveVideo()` → `VideoAttachmentRef` | `video-tool.ts:235-247` |
| 注入会话 | ✅ **`exec.deferContext(createUserMessage(...))`**，插件来源的 user message 携带 `{ type: 'video', attachment }` | `video-tool.ts:253-263` |
| 路由能力闸门 | ✅ 非 kimi-code 线路直接拒绝；模型不声明 `video` 输入也拒绝 | `video-tool.ts:54-82` |
| 工具 schema 形状 | ✅ `defineTool({ name, parameters, output.schema, render, execute })` | `video-tool.ts:170-272` |
| **视频生成** | ❌ **完全没有** | — |
| **异步任务轮询** | ❌ 没有 | — |

### 可直接复用的部分

1. **工具注册范式** —— `src/index.ts:1156` 那一行是模板，`ctx.tools.register(...)` + 返回 dispose。
2. **`VideoAttachmentRef` 与 `saveVideo`** —— `video-store.ts:115`、`:231` `readVideoBytes()`。**注意**：目录常量 `videoStoreDir()` 硬编码为 `storages/kimi-code-videos`（`video-store.ts:39-40`），要复用得先参数化（这是**唯一**一处需要改动的共享设施）。
3. **`exec.deferContext(createUserMessage(...))` 注入模式** —— 生成出来的视频要"让模型/用户看到"，走同一条路即可。
4. **`assertVideoCapableRoute` 的闸门思路** —— 生成工具不需要它（生成不依赖模型输入模态），但**辅助产物回灌**那一步需要。
5. **共享视频词汇** —— `common/video.ts:26-36` 的 `VIDEO_MEDIA_TYPES`、`:51-67` 的 `VideoAttachmentRef`/`VideoBlock`、`:82-89` 的 base64/data-URL 工具。

### 不能直接复用的部分

- `MAX_VIDEO_FILE_BYTES = 30 MB`（`video-store.ts:33`）对生成产物可能偏小，H3 的 2K/15s 输出需要实测。
- kimi 的工具是**单一同步动作**；MiniMax 的 `submit`/`query` 是**双动作 + 跨轮次状态**，DSH 侧需要新的会话态存储（task_id 与 session 的绑定）。

---

## 5. 一条最小可行路径

**建议：先做「视频理解」，两段式落地；「视频生成」放第二步。**

### 理由

`videos_understand` 是**同步、单次调用、不产生计费型长任务、无产物落盘**的一条（`tools/videos-understand.ts` 头注释：batch-only、no artifact files downloaded）。它把从 0 到 1 的所有基础设施（端点、认证、上传、错误分类）都用一遍，但**不需要**任务状态机和轮询。

顺带说：本仓库 **MiniMax 线路目前根本没有视频输入工具**——`index.ts:1156` 只给 kimi-code 注册了。而 `src/host/minimax-code/modalities.ts:32` 的 `unsupported-wire` 文案已经明说：Anthropic Messages 协议没有 video content part，MiniMax 的视频输入是 **OpenAI 面**的能力。**`videos_understand` 恰好补上这个洞**——它让 MiniMax 线路第一次能"看懂视频"，而不必等 Messages 协议支持 video block。

### 最小一步（M1，视频理解）

1. 在 `src/host/minimax-code/` 新增 `matrix-client.ts`：bearer-only（复用 `modelRequestHeaders` 的授权思路），打 `{agentBase}/mavis/api/v1/mcp/`。
2. 新增 `media-upload.ts`：`get_upload_url` → 预签名 PUT；≤600 KB 直接内联 base64。
3. 新增 `video-understand-tool.ts`：复用 kimi 的路径/URL 两种入参 + SSRF 闸门，转成 `video_info: [{ file_url, prompt }]`。
4. `index.ts` 注册，仅在 minimax-code 线路路由时可用。

**成本**：约 1 个新模块 + 1 个工具，**无新依赖**，无协议变更。
**风险**：低。唯一未验证项是 Matrix 网关对该 bearer 的接受度（见第 7 节）。

### 第二步（M2，视频生成）

在 M1 的客户端上加 `submit_video_generation` / `query_video_generation` + task 状态表 + 去重键。

**成本**：中。主要复杂度在 (a) 会话级 task 持久化、(b) 防重复计费、(c) 产物落盘的 store 泛化。
**风险**：中-高。
- **计费不透明**：每次 submit 真实扣额度，用户没有事前确认界面就会误伤。
- **9 小时签名 URL**（`tool-defs.ts:322`）：必须在 succeeded 当下立刻下载，不能"先返回 URL 稍后处理"。
- **10 分钟超时**：DSH 工具调用需要能撑住，或改为 submit 后立即返回、由后续轮次 query。

---

## 6. 不能做的事

| 否掉的选项 | 原因 |
| --- | --- |
| **用订阅令牌打 `api.minimax.*/v1/video_generation`** | 平台路由要平台 API secret。同类已实测：订阅令牌打平台路由返回 `status_code: 1004`（`types.ts:69-73`）。**[推断]** 视频端点同族，不应期待不同结果 |
| **把 `mcode-public` token 塞进 `MINIMAX_API_KEY` 给公开 MCP 用** | 公开 MCP 要的是 platform interface-key，且 README 第 78-80 行要求 key 与 host 匹配。这条路走错了会得到 "invalid api key"，而失败原因会被误读成"订阅不能用" |
| **在 Messages 请求体里塞 video content block 来实现"视频理解"** | `modalities.ts:32`：Anthropic Messages 协议没有 video content part，`/messages` 路线做不到。必须走 `/mavis/api/v1/mcp/videos_understand` |
| **伪造 `yy`/`x-timestamp`/`x-signature` 第一方归因头去调媒体接口** | `types.ts:115-131` 与 `QUOTA_CLIENT_ATTRIBUTION = false` 的既定立场：这是伪装成官方客户端，产品政策上已明确拒绝（上游自己也注明这些是"tag a request as coming from a first-party MiniMax client"）。**且**媒体网关的上游客户端根本没发这三个头（`matrix-client.ts:204-206`），发了也没有收益 |
| **复用 `files-api.ts` 的 `/files/upload` + `mm_file://` 作为媒体工具入参** | 上游明确拒绝这类入参：`tool-defs.ts:213` 原文 *"The agent Tool intentionally does not expose `mm_file://` or data URI inputs"*。媒体工具要的是公网 URL 或预签名上传后的 URL |
| **直接同步等待视频生成完成** | 上游把它设计成异步双工具是有原因的：生成可达数分钟，`MATRIX_GEN_TIMEOUT_MS = 600_000`。同步包装会把一次长任务变成一次可能超时的工具调用 |

---

## 7. 没能查清的地方

诚实列出，不要当成已知：

1. **Matrix 网关对 bearer 的运行时接受度未验证。** 本报告**全程只读**，没有向 `agent.minimax.cn` 发过任何请求。上游代码证明它**应该**接受订阅令牌，但"代码这么写"与"服务端此刻这么答"是两件事。**这是整个结论唯一的实质风险点**，且只需一次 `POST /mavis/api/v1/mcp/get_voice_list`（最便宜、无副作用）就能证伪或证实。

2. **`agent.modules/mcp` 与 Matrix 工具的关系没完全厘清。** `packages/agent-modules/mcp/` 是一个通用 MCP 连接池（`connection-pool.ts` / `transport/{http,stdio}`），而 Matrix 媒体工具在 `packages/agent-tools/src/cloud/matrix-tools/`，**不是**通过标准 MCP SSE/stdio 连接的——它是直连 REST。所以"Matrix MCP"这个名字有误导性：它是**名叫 MCP 的 REST 代理**，不是 Model Context Protocol。**[推断]** 这意味着我们不需要实现 MCP 客户端，只需实现 REST 调用。

3. **`packages/agent-tools/src/cloud/` 目录列表没取到**（GitHub API 403 rate limit）。该目录下除 `matrix-tools/` 外还有什么（是否有 `cloud/` 独立的 auth 或计费层）**未确认**。我是靠 raw 路径直接命中 `matrix-tools/index.ts` 绕过的。

4. **`gen_videos` / `batch_text_to_video` / `batch_image_to_video` 三代接口并存的原因没查到。** `tool-defs.ts:340-342` 只说"Legacy synchronous video generation tools (pre submit/query async contract)… Kept alongside the async pair — they serve existing callers"。**[推断]** 它们大概率同步阻塞到生成完成。若如此，对 DSH 反而是个更简单的接入点——但**同步阻塞 10 分钟**在工具调用里通常不可接受，且无法防重复计费。**未验证它们是否真的同步阻塞**。

5. **计费模型未查清。** 上游能区分 `code 402 = Insufficient credits`（`cloud/matrix-tools/client.ts` 的 `matrixBusinessFailure`），说明 **Matrix 网关用的是"额度/credits"，不是平台按量计费**。这与订阅套餐的关系（视频生成扣的是哪种额度、一次 submit 扣多少）**上游代码里没有任何说明**。这是做 M2 之前必须问用户 / 实测的事。

6. **`listen_audio` 与 `transcribe_audio` 的命名不一致**已记录（`tool-defs.ts:589` 把 `transcribe_audio` 映射到 `/mcp/listen_audio`），但没去查这个不一致是有意的服务端命名还是历史遗留。

---

## 附：证据索引

| 事实 | 出处 |
| --- | --- |
| 网关路径重写 | `agent-tools/src/desktop/matrix-client.ts:15-16, 226-230` |
| bearer-only 认证 | `agent-tools/src/desktop/matrix-client.ts:198-212` |
| managed host（cn/io） | `agent-tools/src/desktop/matrix-env.ts:18, 24`；`local-runtime/src/matrix/matrix-env.ts` |
| Lease audience/scope | `oauth-lease-protocol/src/contracts.ts:4-5` |
| Lease 源自 session access token | `mcode-tools-host/src/lease-broker.ts:208, 133-137` |
| 本仓库同款 scope/audience | `src/host/minimax-code/types.ts:41-43` |
| 18 个工具路径表 | `agent-tools/src/cloud/matrix-tools/tool-defs.ts:571-590` |
| 异步 submit/query 契约 | `tool-defs.ts:199-215, 319-335` |
| 超时（600s/120s） | `tool-defs.ts:604-626` |
| 产物下载 | `cloud/matrix-tools/tools/query-video-generation.ts:59-74` |
| 视频理解（同步、无产物） | `cloud/matrix-tools/tools/videos-understand.ts` 头注释 |
| 预签名上传 / 600KB 内联 | `agent-tools/src/desktop/matrix-media-client.ts:19-22` |
| 公开 MCP 用平台 Key | `MiniMax-MCP/README.md:49-52`；`MiniMax-Coding-Plan-MCP/README.md:47-50` |
| 订阅令牌打平台路由失败 | `src/host/minimax-code/types.ts:69-73` |
| 本地视频工具先例 | `src/host/kimi-code/video-tool.ts:124-168, 235-263` |
| 工具注册范式 | `src/index.ts:1156` |
| 视频 store | `src/host/kimi-code/video-store.ts:33-40, 115, 231` |
| 共享视频词汇 | `src/host/common/video.ts:26-36, 51-67` |
| Messages 协议无 video part | `src/host/minimax-code/modalities.ts:31-32` |
