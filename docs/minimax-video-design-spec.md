# MiniMax 视频能力：设计与实现规格（已锁定）

> 两个子任务（host / client）**都以此为准**。契约已固定，不要各自发明。

## 一、承载机制（已核实，勿改）

视频路径等结构化事实走 **`output.presentationMeta`**：
- `packages/core/tools/src/presentation.ts:276`：「`output.presentationMeta`（persisted with the session log）」；
- 它落到持久化的 `tool/result` 事件的 `data.meta`，客户端侧是 `ToolResultNode.meta?: unknown`（`packages/client/ui-conversation/src/client/contract/records.ts:180`）。

**注意**：`value`（工具的结构化返回值）被明确排除在持久化事件之外（`packages/core/tools/src/index.ts:576`「deliberately omitted from durable events」）——所以**不要**指望客户端能读到 `value`，只能用 `presentationMeta`。

**统一的 meta 形状**（host 与 client 共用，字段名逐字一致）：
```ts
export interface MinimaxVideoPresentationMeta {
  /** 工作区相对路径（客户端用 cwd 解析成绝对路径） */
  readonly videoPath: string
  readonly mediaType: string
  readonly bytes: number
  readonly model: string
  readonly durationSeconds?: number
  /** 上游任务 id，便于排查与续查 */
  readonly taskId: string
}
```

## 二、工具契约（工具名、参数、结果都固定）

### 1. `minimax_understand_video`
- 参数：`source`（绝对本地路径 或 http(s) URL，必填）、`prompt`（可选，默认「描述这个视频的内容」）
- 行为：本地文件 → 通过 Matrix 媒体上传通道换成临时公开 URL → 调 `videos_understand`；http(s) URL → 原样透传
- 端点：`POST {agentBase}/mavis/api/v1/mcp/videos_understand`
- 结果：`{ source, mediaType, bytes, analysis }`，`analysis` 是模型的文字回答（放进 `render` 给模型看）
- 同步、无产物、不落盘

### 2. `minimax_generate_video`
- 参数：`prompt`（必填）、`model`（可选，`MiniMax-H3` | `MiniMax-Hailuo-2.3`，默认 `MiniMax-H3`）、`resolution`（可选，如 `768P`/`2K`）、`durationSeconds`（可选）
- 行为：**两段式**——先 `submit_video_generation` 拿 `task_id`，再轮询 `query_video_generation` 直到 succeeded，然后**立刻下载** `video_url`（H3 签名 URL 只有约 9 小时），落盘到会话工作区
- 端点：`POST {agentBase}/mavis/api/v1/mcp/submit_video_generation` 与 `.../query_video_generation`
- 产物：写到**会话工作区**（不是插件私有目录，也不是附件服务）
- 结果：`presentationMeta` 带上节的 `MinimaxVideoPresentationMeta`

## 三、Matrix 媒体客户端（host 侧新建）

**已实测**（2026-10-20，探针 `scripts/probe-minimax-matrix-gateway.probe.ts`）：
```
POST https://agent.minimax.cn/mavis/api/v1/mcp/get_voice_list
headers=[accept,authorization,content-type,user-agent]  body="{}"
→ http=200  base_resp.status_code=0  status_msg="success"
```
**只需要两个头**：`Authorization: Bearer <订阅 access token>` + `Content-Type: application/json`。
**不需要**：`yy`/`x-timestamp`/`x-signature`（那是签到面 `/minimax-cloud/api/v1/*` 的东西）、`user_id`/`biz_id`/`request_sk`、任何 query string。

**host 映射（重要，别搞混）**：cn → `https://agent.minimax.cn`；global → `https://agent.minimax.io`。
**`agent.minimaxi.com` 是签到面的主机，不是 Matrix 面的**（上游 `matrix-env.ts:28` 明写它是 LEGACY）。

上游源码依据：
- `packages/agent-tools/src/desktop/matrix-client.ts:15-16, 203-207, 226-230`
- `packages/agent-tools/src/desktop/matrix-env.ts:18, 24`
- `packages/agent-tools/src/cloud/matrix-tools/tool-defs.ts:571-590`（18 个工具的完整路径表）、`:604-626`（超时表）

## 四、错误分类（沿用本线路既有的判决形状）

Matrix 响应有两种失败：
- **业务失败**：HTTP 200 但 `base_resp.status_code !== 0` → 终局、不重试（服务已经拒绝了这个请求）；
- **请求失败**：HTTP 非 2xx → 按状态码分（401/403 = 凭据问题；429 = 背压；5xx = 可重试；4xx 其余 = 终局）。

**不要**新造一套分类——复用 `src/host/minimax-code/adapter.ts` 里既有的形状（`code`/`retryable`/`accountScoped`/`message`）。

## 五、客户端设计（已按 frontend-design + DSH 规范定稿）

**视觉方向**：这一块是「代码代理的媒体工具」，出现在一段密集的技术对话里。观众是盯着 agent 干活的人。
**唯一要显眼的东西是视频本身**，周围全部安静。

### 令牌（不新增任何颜色/字体/尺寸）
| 用途 | 取值 |
| :- | :- |
| 文字主/次/三级 | `--dsw-alias-label-primary` / `-secondary` / `-tertiary` |
| 发丝线 | `0.5px solid var(--dsw-alias-border-l2)` |
| 卡片底 | `var(--dsw-alias-bg-layer-2)` |
| 状态点（进行中/失败） | `var(--dsw-alias-button-info-fill,#397ee8)` / `var(--dsw-alias-label-danger,#d94b4b)` |
| 焦点环 | `outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:2px` |

- **字重上限 500**（DSH `dsh-client-ui-ux` 明文：feature CSS 里不要用 600+ 强调，用字号或墨色区分）。
- 字号只用既有刻度：**11px**（路径/元数据，等宽）、**12px**（次要说明）、**13px**（标题与正文）。
- 等宽字体沿用项目既有写法：`ui-monospace,SFMono-Regular,Consolas,monospace`。
- 圆角：卡片 8px、小片 4–6px、胶囊 999px；**凡是全圆/胶囊半径都要同时写 `corner-shape:round`**（DSH `web-styling.md:24`）。
- 中性边框一律 0.5px；虚线 affordance 保持 1px。

### 布局：沿用同仓库的「生图工具卡片」解剖结构

参照物是**同一个仓库里已经存在**的 `src/client/CodexImageToolView.tsx` + `.dsh-codex-image-tool*` 系列样式（`src/client/styles.ts:87-96`）。**照抄它的结构**，只把「图片格」换成「视频台」：

```
┌─ 发丝线卡片（radius 8，max-width 520）
│  ●  标题（13px，weight 500）      摘要（12px tertiary，ellipsis）
│  ┌─ 视频台：16:9，letterbox，发丝线，radius 8
│  │  <video controls preload="metadata">
│  └─
│  路径片（11px 等宽，chip）   时长 · 体积（11px tertiary）
└─
```

- **视频台是唯一会动的东西**。它有 16:9 的固定比例（`aspect-ratio:16/9` + `object-fit:contain` + 深色底），所以两个尺寸（对话流内联 / 侧边栏全尺寸）**看起来是同一个东西**，只是大小不同。
- 加载中：与图片卡一致，用**虚线占位块**（`0.5px dashed` + tertiary 文字），**不要**转圈、不要 loading 文案（DSH 规则：没有上下文需要就不要 loading 文字）。
- 失败：占位块保留，文字换成 danger 色，**不要**把整个卡片换成错误条（DSH 规则：失败的操作要保留数据可见）。

### 两个界面，同一套处理
1. **对话流工具卡片**：`tool.call.toolview` 按工具名 keyed 注册（照抄 `src/client/index.tsx:214-230` 的两处 Codex/Antigravity 注册）。
2. **侧边栏视频渲染器**：注册一个 `documentPreviews` 定义，**`priority: 'extension'`**（外部实现优先于内置），并把组件注册进 `sidebar.right.tab.document` 的 keyed 槽。
   - 定义形状照抄宿主 `packages/client/ui-sidebar-documentpreview/src/client/image/index.ts:26-36`；
   - 组件注册形状照抄同文件 `:48-53`。
   - 宿主按后缀注册、外部实现优先（`document/registry.ts:43`），mp4 在 `unviewable.ts` 名单里只表示「没人认领」——所以**我们注册了就会赢**。

## 六、明确的边界
- **不跑真实生成**：本轮只用合成数据 / mock fetch 验证，不向 MiniMax 打任何生成类端点（那要花钱）。
- **不改宿主**：DSH 检出只读，一行都不改。
- **不动别人的改动**：工作树里 `src/host/progress-updates/projection.ts` 与其测试是别的会话在改的，**不许碰**。
- 不 git commit。
