# MiniMax Code 云端功能调查报告：能力清单 + 可移植性评估

> **调查方式**：只读。上游源码经 `raw.githubusercontent.com` 读取，**未 clone**；**未向任何 MiniMax 端点发出活请求**。
> **标注约定**：**[事实]** = 上游源码原文可追溯（附文件:行号）；**[推断]** = 本文判断，未经运行时验证。
> **上游基线**：`MiniMax-AI/minimax-code` `main`，根 `package.json` v0.6.5，TUI 能力目标 0.6.3（`package.json:3`、`docs/open-source-status.md:3,9`）。
> **本轮只新增了本文件。** 未修改 `src/`、未改测试、未 commit、未发活请求。（`git status` 里另外几个改动与新增文件来自并行子任务，非本调查产物。）

---

## 0. 一句话结论

**「云端」= 一个 host + 一个前缀 + 一套签名头。** 上游所有真·云能力都走同一个公开网关（CN `https://agent.minimaxi.com` / EN `https://agent.minimax.io`），带同一个 `Bearer` 订阅令牌，和三个可复算的头 `yy` / `x-timestamp` / `x-signature`。我们仓库的 `src/host/minimax-code/checkin-gateway.ts:240-284` 已经把这段签名实现**逐字节等价**地实现了——这是整份报告里最值钱的一条：**移植云端能力不需要新的认证机制，只需要新的路径和响应解析。**

反过来说：**画布 / miniapp / channel / ACP / mcode-tools 都不是云能力**，它们是宿主侧运行时设施，对「订阅令牌还能拿什么」这个问题没有帮助。

---

## 1. 总表

| # | 能力 | 用户价值（一句话） | 上游端点（host + path） | 认证 | 我们能否移植 | 成本 | 证据 |
| :-: | :- | :- | :- | :- | :- | :- | :- |
| 1 | **媒体工具（17 个 + web_search）** | 让 Agent 会生成图/视频、念稿、听音、看图看视频 | `{agent}/mavis/api/v1/mcp/<tool>`（源码写 `/matrix/api/v1/mcp/<tool>`，发出前重写） | 订阅 Bearer | ✅ **能，第一档** | 中 | `agent-tools/src/cloud/matrix-tools/tool-defs.ts:571-590`；`agent-tools/src/desktop/matrix-client.ts:15-16,226-232` |
| 2 | **托管连接器** | 一次授权后把 Slack/Notion 之类第三方服务变成 Agent 工具 | `{agent}/minimax-cloud/api/v1/connectors/connected-tools/list`、`/tools/call` | 订阅 Bearer（必需） | ✅ 能，但要先有用户已在云端连接的服务 | 中低 | `plugin-system/app/cloud-client.ts:9,89,113` |
| 3 | **官方插件市场** | 浏览/一键装官方插件（含 Skill、MCP、App、Hook） | `{agent}/minimax-cloud/api/v1/marketplace/plugins`、`/plugins/{name}/{install,uninstall,enable,disable}`、`/plugins/{name}/versions/{v}/download-authorization` | 浏览 optional，安装/下载 required | ⚠️ **半能**：市场数据可读，但插件跑不起来（见 §3.3） | 高 | `plugin-system/plugin/runtime/registry-client.ts:26,65,79,89,99,108,119,134` |
| 4 | **搜索** | 联网查实时信息 | `{agent}/matrix/api/v1/mcp/web_search`（= 媒体工具面第 18 个） | 订阅 Bearer | ✅ 能 | 低 | `agent-tools/src/cloud/matrix-tools/tools/web-search.ts:34-41`；`agent-tools/src/shared/web-search.ts:4-23` |
| 5 | **反馈工单** | 在客户端里直接提 bug/建议，可附诊断包 | `{agent}/minimax-cloud/api/v1/feedback/ticket` | 订阅 Bearer（必需） | ✅ 能 | 低 | `tui/src/runtime/feedback/ticket.ts:16-23` |
| 6 | **提示词配置包** | 客户端按账号拉取服务端下发的提示词/配置（加密 + ETag） | `{agent}/minimax-cloud/api/v1/desktop/p-config` | 订阅 Bearer（必需） | ❌ 不建议（见 §3.4） | — | `local-runtime-v2/src/service/prompt-config/prompt-config-cloud-client.ts:21` |
| 7 | **签到**（已有） | 每日领积分 | `{agent}/minimax-cloud/api/v1/signin/status`、`/claim` | 订阅 Bearer | ✅ **已做** | — | 上游 `tui/src/checkin/http-gateway.ts:17-18`；我方 `checkin-gateway.ts:30-32` |
| 8 | **ACP** | 让 Zed/Neovim 等外部编辑器把 mcode 当 Agent 后端 | **无端点**（stdio NDJSON，JSON-RPC over `@agentclientprotocol/sdk`） | 无（本地进程） | ❌ 与 DSH 定位冲突 | — | `tui/src/acp/stdio.ts:16-30`；`docs/architecture.md:3-5` |
| 9 | **画布** | Desktop 窗口里把文件/图片摆成可标注的画板 | **无端点**（本地 SQLite + 工作区文件） | 无 | ❌ 无关 | — | `local-runtime-v2/src/service/canvas/contracts.ts:43-50,179-197`；`infra/db/schema/canvas.ts` |
| 10 | **miniapp** | 插件可以启动一个本地 Node 进程，渲染一个 UI 页 | **无端点**（本地子进程 + 端口注册） | 无 | ❌ 无关 | — | `local-runtime-v2/src/service/miniapp/contracts.ts:126-137`；`shared/src/miniapp-surface.ts:4-14` |
| 11 | **channel** | 把会话接到 Slack/飞书之类频道，回复自动投递 | **无端点**（宿主投递适配器接口） | 无 | ❌ 无关 | — | `local-runtime-v2/src/service/channel-system/contracts.ts:9-33`；`shared/src/channel-context.ts` |
| 12 | **mcode-tools 宿主** | 把一个独立 CLI 产物嵌进来，通过本地 lease broker 借令牌 | **无端点**（本地 unix socket / 命名管道） | 本地 capability 文件握手 | ❌ 无关（但**其 lease 设计值得抄**） | — | `mcode-tools-host/README.md:3-14`；`oauth-lease-protocol/src/endpoints.ts:6-8` |
| 13 | **更新** | 客户端自更新到新版本 | npm registry + `https://algeng-ali-shanghai-agent-02.oss-cn-shanghai.aliyuncs.com/minimax-dialogue/data/env/.npm-global/mcode` | 无（公开） | ❌ 无关 | — | `tui/src/update/service.ts:29-30,346-359` |
| 14 | **遥测/诊断** | 匿名上报使用事件与性能指标（默认全关） | `https://data.hailuoai.com/meerkat-reporter/api/report?project=MiniMaxAgent`（CN）/ `https://data.hailuo.ai/...`（Global） | 诊断通道用账号令牌 | ❌ 无关 | — | `docs/telemetry.md:77-80,86,90` |

---

## 2. 「云端」到底是什么——本节是最重要的产出

### 2.1 三个判据

一个上游能力算不算「MiniMax 云服务」，看三条同时成立：

1. **有没有网络端点**，且该端点的主机是 MiniMax 运营的域；
2. **认证是不是订阅令牌**（`Bearer <accessToken>` + `realUserID`），而不是平台 `MINIMAX_API_KEY`；
3. **服务端是不是真的做了事**（生成、检索、搜索、存目录），而不是只做 UI 编排。

### 2.2 判定结果

**真·云服务（5 类 + 1 个工具面）** —— 全部落在同一个 host、同一个前缀或 `.mcp` 面：

```text
{agent.minimaxi.com | agent.minimax.io}
├── /minimax-cloud/api/v1/signin/{status,claim}          签到           [已有]
├── /minimax-cloud/api/v1/marketplace/plugins[/{name}]   官方插件市场   [缺]
├── /minimax-cloud/api/v1/plugins/...                    市场安装/授权   [缺]
├── /minimax-cloud/api/v1/connectors/...                 托管连接器     [缺]
├── /minimax-cloud/api/v1/desktop/p-config               提示词配置包   [缺]
├── /minimax-cloud/api/v1/feedback/ticket                反馈工单       [缺]
└── /matrix/api/v1/mcp/<18 tools>                        媒体 + 搜索    [缺]
```

**宿主本地功能（不是云）** —— 都**没有**上述三类端点，全部是本地进程 / 本地 DB / 适配器接口：

- **canvas**：本地 SQLite 表（`infra/db/schema/canvas.ts`）+ 工作区文件引用，`CanvasService` 只有 `read/prepareFiles/apply/deleteSession`，没有任何 `fetch`。**[事实]** `canvas/contracts.ts:186-197`
- **miniapp**：`lifecycle: 'on-demand'` 的本地 Node 子进程，有 `preferredPort`、`port-registry`、`nodeDigest` 校验。**[事实]** `miniapp/contracts.ts:126-137`、`miniapp/initialize.ts:30-40`
- **channel-system**：只有 `ChannelFinalReplyDelivery` / `ChannelTypingDelivery` 两个接口，投递实现由产品侧注入。**[事实]** `channel-system/contracts.ts:9-33`
- **ACP**：stdio 上的 NDJSON，把 TUI 的 runtime port 暴露成 Agent Client Protocol。**[事实]** `tui/src/acp/stdio.ts:16-30`
- **mcode-tools**：本地 lease broker（unix socket `mcode-auth-lease-v1.sock` / 命名管道 `\\.\pipe\mcode-auth-lease-<sha16>`）。**[事实]** `oauth-lease-protocol/src/endpoints.ts:6-8,20-38`
- **updates**：npm registry + 阿里云 OSS 公开桶。**[事实]** `tui/src/update/service.ts:29-30`

**边界情况（要说清）**：

- **miniapp 会间接用到云**：它的子进程可以通过 `MiniAppHostConnectorPolicy` 拿到连接器工具的句柄（`miniapp/contracts.ts:1-3,21,64-73`）。但**它本身不是云能力**，它是「云能力的本地消费者」。这层区分很重要——移植连接器之后，miniapp 才有意义；反过来不成立。
- **插件会间接用到云**：官方插件的 `apps` 段只存一个 Connector `provider` 字符串（`docs/plugins/package-format-v1.md:57-59`）。也就是说，**插件市场的 App 类插件本质是连接器的 UI 外壳**。这解释了为什么 §3.3 里市场和连接器必须一起看。

### 2.3 为什么这个区分对结论关键

我们这条线路是 **DSH 插件**，不是 Desktop 客户端。宿主侧 UI 能力（画布/miniapp/channel）在我们的形态里**没有对应位置**——DSH 有自己的 widget 看板、自己的 channel 机制、自己的子进程管理。抄过来是重复造轮子，而且抄的是别人的轮子形状。

反过来，**云端 REST 是纯协议**，跟宿主形态无关，只要有令牌和签名就能用。这就是为什么 §1 的「能不能移植」几乎是按「是不是云」自动分档的。

---

## 3. 逐项详述

### 3.1 媒体工具 / 云端工具（`AGENT_BUILTIN_MCP_TOOL_IDS` 那批）

**[事实] 工具清单**（`packages/config/src/agent-capabilities.ts:23-41` 共 **17** 个，加上 feature-owned 的 `web_search` 共 **18** 个 —— 与 `matrix-tools/index.ts:2` 的注释 "all 18 RuntimeTools" 闭合）：

| 分组 | 工具 id | 路径（`tool-defs.ts:571-590`） |
| :- | :- | :- |
| 图像理解/生成 | `images_understand` / `image_synthesize` / `images_search_and_download` / `image_reverse_search` | `/matrix/api/v1/mcp/{images_understand,image_synthesize,images_search_and_download,image_reverse_search}` |
| 视频生成 | `submit_video_generation` / `query_video_generation` / `gen_videos` / `batch_text_to_video` / `batch_image_to_video` | `/matrix/api/v1/mcp/...` |
| 音频 | `get_voice_list` / `batch_text_to_audio` / `batch_text_to_music` / `synthesize_speech` / `batch_synthesize_speech` | `/matrix/api/v1/mcp/...` |
| 理解 | `audios_understand` / `videos_understand` / `transcribe_audio`（**路径名是 `listen_audio`**，注意不一致） | `/matrix/api/v1/mcp/{audios_understand,videos_understand,listen_audio}` |
| 搜索 | `web_search` | `/matrix/api/v1/mcp/web_search` |

**[事实] 调用形状**：

- 全部 `POST`，body 就是工具输入的 typebox 结构，`Content-Type: application/json`。
- 响应信封是 `base_resp.status_code`（0 = 成功），payload 其余字段直接透传。**[事实]** `matrix-tools/client.ts:86-102`
- 生成类超时 10 分钟，非生成类 2 分钟。**[事实]** `tool-defs.ts:604-626`
- 错误码 **402 = 额度不足**，且上游明确要求模型「不要重试」。**[事实]** `matrix-tools/client.ts:245-248`
- 文件类工具（图/音/视频输入）走两步：先 `POST /mavis/api/v1/mcp/get_upload_url` 拿签名 URL，再 `PUT` 字节上去。**[事实]** `desktop/matrix-media-client.ts:16`

**[推断] 可移植性：第一档，成本中。** 认证我们已经有了，缺的是 17 个工具的 body schema（`tool-defs.ts` 627 行，可直接翻译成 DSH 的工具声明）。**视频那一块已有独立子任务在深挖**（见 `docs/minimax-video-tools-feasibility.md`），本报告只给全景与端点归属。

**注意一个上游自己也踩过的坑**：`MATRIX_TOOL_PATHS` 写的是代理路径 `/matrix/api/v1/mcp/`，但**真正发出去之前必须重写成 `/mavis/api/v1/mcp/`**，否则 404。**[事实]** `desktop/matrix-client.ts:226-232` 的 `toLocalGatewayPath()` 就是干这个的，且它对不认识的路径直接 `throw`。我们如果照抄路径表，必须同时照抄这个重写。

### 3.2 托管连接器（managed connectors）

**[事实] 它连的是什么**：不是固定的服务清单，是**用户自己在其 MiniMax 账号里已连接的服务**。客户端每次提问前调一次 `POST /minimax-cloud/api/v1/connectors/connected-tools/list` 拿「当前账号可用的工具清单」，每个工具带 `provider`、`provider_tool_name`、`runtime_tool_name`、`input_schema_json`。**[事实]** `plugin-system/app/cloud-client.ts:83-103,143-162`

**[事实] 调用形状**：`POST /minimax-cloud/api/v1/connectors/tools/call`，body 是
`{ provider, provider_tool_name, runtime_tool_name, arguments_json /* 注意是字符串 */, session_id, turn_id, tool_call_id, request_id, trace_id }`。**[事实]** `cloud-client.ts:105-140`

**[事实] 两个超时差得很悬殊**：工具发现 5 秒（注释明说是为了让「发消息不显得卡住」，且失败是 fail-open），工具调用 10 分钟。**[事实]** `cloud-client.ts:13-14`

**[事实] 认证**：`auth: 'required'`，走 `PluginSystemCloudTransport`，即订阅令牌 + 签名头。**[事实]** `cloud-client.ts:90,114`

**[推断] 可移植性：能，成本中低，但价值取决于用户。** 技术上只要两个端点 + 一个 JSON Schema 缓存就能做。**风险**：这是一个「用户在某处已经配好了」的能力，我们不知道国内/海外订阅账号里到底有多少连接器可用；如果多数用户是空清单，做了等于没做。**建议先做只读探针（list 一次，看返回什么）再决定。**

**[事实] 一个设计细节值得抄**：连接器工具名是 `runtime_tool_name` **服务端分配**的，不是客户端拼的；客户端只做 `handle` 包装（`host-connector-system/contracts.ts:21-37` 用一个私有 WeakMap 把 provider/tool 路由藏起来）。这是防止第三方插件伪造内置工具身份的正确做法。

### 3.3 官方插件市场

这一节必须把**两条完全不同的链路**分开讲，否则会得出错误结论。

#### 云端市场（真·云）

**[事实] 端点**（`registry-client.ts`，前缀常量 `CLOUD_BASE = '/minimax-cloud/api/v1'`，:26）：

| 动作 | 方法 + 路径 | auth | 行号 |
| :- | :- | :- | :-: |
| 列出市场插件 | `GET /minimax-cloud/api/v1/marketplace/plugins` | **optional** | :65 |
| 市场插件详情 | `GET /minimax-cloud/api/v1/marketplace/plugins/{name}` | **optional** | :79 |
| 已安装列表 | `GET /minimax-cloud/api/v1/plugins/installed` | required | :89 |
| 已启用列表 | `GET /minimax-cloud/api/v1/plugins/enabled` | required | :99 |
| 全量状态 | `GET /minimax-cloud/api/v1/plugins/full-state` | required | :108 |
| 安装/卸载/启用/停用 | `POST /minimax-cloud/api/v1/plugins/{name}/{install\|uninstall\|enable\|disable}` | required | :119 |
| 下载授权 | `POST /minimax-cloud/api/v1/plugins/{name}/versions/{v}/download-authorization` | required | :134 |

注意 **`auth: 'optional'`**：未登录也能浏览市场（登录只是让 creator 名字等元数据更全）。**[事实]** :67-70

**[事实] 市场清单来源不是 GitHub**：发布链路是 `tools/publish_marketplace.py` → 私有 package bucket（OSS）+ 公开 static bucket（图标）→ **受鉴权的 Publisher Relay** → `PublishPluginCatalog` Kitex RPC → Registry 事务。**[事实]** `docs/plugins/package-format-v1.md:298-323`

**[事实] 包格式（V1）**：ZIP 只允许 `STORE`；`content_digest = sha256-tree-v1:<hex>`（自定义树哈希，第 5 节有完整算法）；`archive_sha256` 是 ZIP 整字节哈希；上限 64 MiB / 2048 entries / 1024 files / 单文件 16 MiB；路径只允许 portable ASCII，禁 symlink/硬链接/设备文件。**[事实]** `package-format-v1.md:171-245`

**[事实] 安装是两段式的**：先 `download-authorization` 拿一个带 `expires_at_ms` 的 `download_url`，再 GET 那 URL。运行时**先验 `archive_sha256` 再验 `content_digest`，两者不能互相替代**。**[事实]** `registry-client.ts:125-156`、`package-format-v1.md:243-245`

#### 社区插件仓库（另一条通道，不是云）

**[事实]** `MiniMax-AI/MiniMax-Code-Plugins` 是 **GitHub 上的 PR 驱动仓库**，不是云端市场：

- 路径约定 `plugins/<github-owner>/<plugin-name>/`，一文件夹 = 一次 PR；
- 包体：`plugin.json`（必填 `$schema` + `name`）+ 可选 `mcp.json` + 可选 `skills/<name>/SKILL.md`；
- `$schema: https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`（**Agent Plugins 1.0 是第三方规范，不是 MiniMax 自有的**）；
- 仓库只有 `npm run check` 的 CI 校验 + 人工 review，**没有 catalog JSON、没有 commit pin**。

证据：`MiniMax-AI/MiniMax-Code-Plugins` 的 `README.md`（"One folder is the release"、"No catalog JSON"）与 `docs/plugin-compatibility.md:19-68`。

**[事实] 而且 mcode 0.4.0+ 换成了 Claude Code 兼容布局**：manifest 搬到 `.claude-plugin/plugin.json`，hooks 内联到 manifest，顶层 `plugin.json` **被忽略且无诊断**。**[事实]** `plugin-compatibility.md:70-127`

#### 我们能不能移植？—— 半能

**[推断] 结论分三层：**

| 层 | 能不能 | 理由 |
| :- | :- | :- |
| 拉市场清单、显示插件信息 | ✅ 能 | 就是两个 GET，甚至可以匿名 |
| 下载并校验包 | ✅ 能 | 算法公开且有 reference vectors（`test-vectors/plugins/content-digest-v1.*`） |
| **让插件真的跑起来** | ❌ **不能** | 见下 |

**跑不起来的三个硬理由（都是 [事实]）：**

1. 官方插件的 **App 能力**只存一个 Connector `provider` 字符串，真正的 UI/元数据由 BFF 用 Connector catalog 填充（`package-format-v1.md:57-59,130-131`）。不接连接器，App 类插件是空的。
2. 官方插件的 **Host Binding** 声明的是宿主原生能力（`browser.use@1`、`computer.use@1`），要求 Desktop Host 有对应 Adapter（`docs/plugins/host-bindings.md:37-45,141-147`）。**DSH 没有这些 Adapter。**
3. **miniapp 形态**需要一个本地 Node 子进程 + 端口 + `miniapp` UI 表面（`miniapp/contracts.ts`），这是 Desktop 的窗口模型，DSH 的 widget 看板不是这个模型。

**能落地的子集**：官方插件里的 `skills/` + `mcpServers`（stdio/streamable-http/sse）这两块是**协议无关的**，DSH 完全能加载。**[推断]** 如果要做，正确的做法不是「移植市场」，而是「**做一个只读的市场浏览器 + 只装 skills/mcp 的子集安装器**」。

### 3.4 提示词配置包（p-config）

**[事实]** `GET /minimax-cloud/api/v1/desktop/p-config`，带 ETag，响应是**加密的** prompt bundle（`EncryptedPromptBundle`），上限 1 MiB，30 秒超时。**[事实]** `prompt-config-cloud-client.ts:21-23,63-90`

**[推断] 明确否掉。** 三个理由：①路径里写着 `desktop`，是 Desktop 专属；②响应加密，密钥在客户端内，开源版能不能解密本身就存疑；③它是**厂商替用户决定提示词**的机制，跟我们「插件提供 provider」的定位直接冲突。

### 3.5 搜索（web_search）

**[事实] 走的是 MiniMax 云端搜索，不是第三方**：工具在 `MATRIX_TOOL_PATHS` 里，路径 `/matrix/api/v1/mcp/web_search`（发出前重写成 `/mavis/api/v1/mcp/web_search`），认证是订阅 Bearer。**[事实]** `tool-defs.ts:572`、`tools/web-search.ts:34-41`

**[事实] 输入 schema**：`query` / `count`（默认 10）/ `freshness`（`noLimit|day|week|month|year`）/ `search_type`（`search|videos|places|news|shopping`）。**[事实]** `shared/src/web-search.ts:13-22`

**[事实] 它是 feature-gated 的**：`web_search` **不在** `AGENT_BUILTIN_MCP_TOOL_IDS` 里，由 `features.webSearch` 开关控制 Tool 与 Prompt 一起开。**[事实]** `agent-capabilities.ts:18-23`

**[事实] 它与 mcode-tools 无关**：`docs/tui-capabilities.md:87` 明写 "search is independent of mcode-tools"。

**[推断] 可移植性：能，成本低。** 这是 §1 里**性价比最高**的一项：一个端点、一个 schema、认证已有。**注意**：我们的插件本身已经给模型提供了 DSH 的 `web_search` 工具（如果宿主有），是否要用它替换/并列为一条 MiniMax 通道，是个产品决策。

### 3.6 ACP（Agent Client Protocol）

**[事实]** `serveTuiAcpStdio()` 用 `@agentclientprotocol/sdk` 在 stdio 上开一个 NDJSON 连接，把 TUI 的 runtime port（session/turn/interaction/queue/goal/delegation/fork 共 11 个接口）投影成 ACP agent。**[事实]** `acp/stdio.ts:16-30`、`acp/runtime.ts:15-26`

**[事实] 它是给谁用的**：外部编辑器（Zed 等 ACP 客户端）把 mcode 当 agent 后端。`docs/architecture.md:3` 的架构式把 `TUI / exec / ACP` 并列为三个前端入口。

**[推断] 与我们这条线路没有交集。** 我们是 DSH 的 provider 插件，不是编辑器后端；DSH 自己有 subagent/task 机制。**唯一可借鉴的是 `control-state.ts`（模型/权限模式/思考档位作为 ACP config 项暴露）**——但那是 UI 契约，不是云能力。

### 3.7 更新与反馈

**更新** **[事实]**：`tui/src/update/` 是一个完整的自更新器（`service.ts` 472 行 + `prefix-update.ts` 682 行 + `install-source.ts`）——从 npm registry 装 `@minimax-ai/code` 到 versioned prefix，原子切换 `current` 软链，失败回滚。**[事实]** `update/service.ts:346-359`（`npm install --registry`）、`:210-228`（staging → `versions/<v>`）

**[推断] 无关且不该抄。** 我们的分发渠道是 npm 包 + `dsh plugin add`，宿主负责版本管理。抄一个自带 npm 安装器的自更新器，会和宿主打架。

**反馈** **[事实]**：`POST /minimax-cloud/api/v1/feedback/ticket`（`ticket.ts:22`），载荷包含客户端版本、平台、Node 版本、OS，可选附一个诊断包 `uploadId`；描述里会**先 redact 凭据**再上传，诊断包只传计数不传内容（`feedback/service.ts:124-148`）。**[事实]** 该通道额外要求已登录（`:186-188,217`）。

**[推断] 能移植但价值低。** 这是「给厂商提工单」的通道，我们的插件用户提工单应该提到我们自己的 GitHub，而不是 MiniMax 的工单系统。**明确否掉。**

**遥测** **[事实]**：与 `minimax-cloud` **不同域**——`data.hailuoai.com`（CN）/ `data.hailuo.ai`（Global），路径 `/meerkat-reporter/api/report?project=MiniMaxAgent`，默认**全部关闭**，三条通道（usage events / metrics / diagnostics）各自独立 opt-in。**[事实]** `docs/telemetry.md:3,77-80,86,90`

**[推断] 明确否掉。** 上报到厂商域名的遥测，在我们的插件里没有任何正当性。

### 3.8 mcode-tools 宿主

**[事实] 它是什么**：一个**版本化、哈希锁定的独立 CLI 产物**（`mcode-tools` 0.0.4，从公开 npm 包 `@minimax-ai/code@0.3.11` 抽出），宿主不内联它的代码，只做三件事：①校验资源 manifest（schema v3/v4、SHA-256、拒符号链接）；②起一个 **OAuth lease broker**；③安装 profile 作用域的启动器。**[事实]** `mcode-tools-host/README.md:3-14`、`docs/open-source-status.md:13,22`

**[事实] host 给它什么权限——lease 协议**：

- broker 监听 unix socket `mcode-auth-lease-v1.sock` 或 Windows 命名管道 `\\.\pipe\mcode-auth-lease-<sha256(dataDir).slice(16)>`；**[事实]** `oauth-lease-protocol/src/endpoints.ts:6-8,20-38`
- 客户端需读一个 **capability 文件**（32 字节随机 base64url，`0600`）才能通过握手；**[事实]** `mcode-tools-host/src/lease-broker.ts:46,145,246-266`
- 借出去的令牌是**短命的**：`getAccessToken(minValidityMs)`，audience 固定 `agent-backend`，scopes 固定 `['agent.default']`，且每次请求都校验 `generation`；账号切换/重新登录会 `invalidate()` 掉缓存。**[事实]** `mcode-tools-host/src/contracts.ts:3-9`、`lease-broker.ts:126-143,236-244`
- **refresh token 永不出宿主**：README 明写 "The host remains the only credential-store, Refresh Token, refresh and logout owner"。**[事实]** `mcode-tools-host/README.md:7-10`
- 启动器会主动 **清掉继承来的** `MAVIS_ACCESS_TOKEN` / `MCODE_API_BASE_URL` / `MCODE_AUTH_BASE_URL` / `MCODE_CLIENT_ID` / `MCODE_SCOPE` 等覆盖，防止子进程绕开 broker。**[事实]** `resource.ts:232,275-276`

**[推断] 对我们无关，但有一个念头值得记**：这个 lease 协议解决的是「**给不受信子进程发短期令牌而不泄漏 refresh token**」。我们这条线路目前令牌全在宿主进程内，没有这个需求；但如果将来要跑用户提供的子进程/工具，这套设计是现成的参考。**归为「无关但有借鉴价值」。**

---

## 4. 我们已有的 vs 缺的

对照 `src/host/minimax-code/` 现有 14 个文件：

| 文件 | 管什么 | 与云端能力的关系 |
| :- | :- | :- |
| `types.ts` | 端点常量、region、OAuth 路径、模型/限额常量 | **重叠**：`TOKEN_PLAN_REMAINS_PATH`（:84）、`AGENT_LLM_PREFIX`（:174）、`MESSAGES_PATH`（:176） |
| `oauth.ts` | 设备码 + refresh | 重叠：产出云端 REST 要用的 accessToken |
| `token-store.ts` | 凭据持久化（DPAPI / 0600） | 重叠（前置） |
| `account-pool.ts` | 多账号池 | 重叠（前置） |
| `checkin-gateway.ts` | **签到 + 身份 + 签名构造** | **关键重叠**：`SIGNIN_STATUS_PATH`/`SIGNIN_CLAIM_PATH`/`USER_INFO_PATH` + `createCheckinRequest()` 就是上游 `createPublicGatewayRequest()` 的等价物 |
| `checkin.ts` | 签到业务编排 | 重叠 |
| `reset-card.ts` | 重置卡三端点（`/backend/account/reset_card/*`） | 重叠（唯一一个走 `/backend/` 而非 `/minimax-cloud/` 的） |
| `client.ts` | Messages 端点客户端 | 不重叠（LLM 面） |
| `files-api.ts` | `/mavis/api/v1/llm/v1/files/upload` | **部分重叠**：与媒体工具的 `get_upload_url` 是两条不同的上传路径 |
| `model-catalog.ts` | 硬编码模型表 | 不重叠 |
| `mapper.ts` | Anthropic ↔ 内部格式 | 不重叠 |
| `adapter.ts` | provider 适配 | 不重叠 |
| `modalities.ts` | 视频/图像模态白名单 | 不重叠 |
| `routes.ts` | HTTP 路由 | 不重叠 |

**重叠（3 个真重叠 + 4 个前置）**：签名/网关（`checkin-gateway.ts`）、签到（`checkin.ts`）、重置卡（`reset-card.ts`）；前缀由 `types.ts` 的 region 表 + `account-pool.ts`/`token-store.ts`/`oauth.ts` 提供。

**空白（全部 6 类云能力）**：`src/` 里对 `matrix` / `/mavis/api/v1/mcp` / `connected-tools` / `marketplace` / `feedback` 的引用**只有注释**，没有任何实现（已 grep 确认）。

### 4.1 一条必须注意的坑：CN 有两个 agent 主机

**[事实]** 上游自己在国内用**两个**不同的生产主机：

| 用途 | CN 主机 | EN 主机 | 证据 |
| :- | :- | :- | :- |
| 公开网关（签到/反馈/p-config） | `agent.minimaxi.com` | `agent.minimax.io` | `tui/src/runtime/public-gateway.ts:17,23` |
| Matrix / 插件云 | `agent.minimax.cn` | `agent.minimax.io` | `plugin-system/initialize.ts:222,227`；`matrix-env.ts:18,24` |
| 且 `agent.minimaxi.com` 被标为 Matrix 的 **LEGACY** 主机 | | | `matrix-env.ts:28` |

**[事实]** 我们仓库**已经是这个状态**：`types.ts:57` 用 `agent.minimax.cn` 做 LLM/agent 基址，而 `checkin-gateway.ts:63` 用 `agent.minimaxi.com` 做签到基址。

**[推断]** 移植媒体工具时必须用 **`agent.minimax.cn`**（Matrix 面），移植市场/连接器时也要用 `.cn`（plugin-cloud 面），**只有签到和反馈用 `.minimaxi.com`**。把两者混用会得到一个迷惑的 404 或 "invalid access token"——上游在 `matrix-env.ts:28` 专门把这个坑标了出来。

**[事实] 第二个坑：两套 query 词汇表**。`checkin-gateway.ts:286-292` 的注释明写：身份调用要用 `device_platform=mcode`（不带 `is_desktop`/`desktop_version`），两种拼法混用会被当成 "invalid access token"。云端 REST 用的是 `device_platform=web` + `is_desktop=1`（`public-gateway.ts:48-65`）。

---

## 5. 可移植性排序（按 价值 / 成本）

| 排序 | 能力 | 价值 | 成本 | 比值 | 理由 |
| :-: | :- | :- | :- | :- | :- |
| **1** | **搜索（web_search）** | 中高 | **很低** | ★★★★★ | 一个端点、一个 schema、认证已有。可直接验证（发一次请求就知道通不通）。**先做这个当探针**：它同时验证签名头在我们这条线路上对 `/mavis/api/v1/mcp/` 面是否也有效。 |
| **2** | **媒体工具（先做非视频子集）** | 高 | 中 | ★★★★ | 认证已有，路径重写规则已知，17 个 schema 在 `tool-defs.ts` 里可直接翻译。**先做 `image_synthesize` + `synthesize_speech` + `*_understand` 四个**，把「能生成、能理解」打通；视频那块等子任务的结论。 |
| **3** | **托管连接器** | 不确定（取决于用户是否已连服务） | 中低 | ★★★ | 两个端点，但**必须先探针**：`POST /connectors/connected-tools/list` 对国内/海外账号分别返回什么？如果返回空清单，这项价值归零。注意 5s 超时 + fail-open 的上游设计。 |
| **4** | **官方插件市场（只读浏览器）** | 中 | 中高 | ★★ | 匿名就能拉 catalog（`auth: 'optional'`），做一个「市场里有什么」的展示成本不高。但**装了就完整跑起来是做不到的**（§3.3）。真要做，做「只装 skills + mcpServers 的子集安装器」，别碰 App/Binding/miniapp。 |
| **5** | **反馈工单** | 低 | 低 | ★ | 技术上最容易，但用户该向我们提 issue 而不是 MiniMax。**建议不做。** |
| **6** | **p-config** | 低（且与定位冲突） | 高 | ☆ | 加密载荷 + desktop 专属 + 厂商决定提示词。**否。** |

### 建议的第一步（最小验证）

**[推断]** 在做任何实现之前，先发**一次**只读探针：用现有账号池的令牌，按 `checkin-gateway.ts` 的签名构造，`POST {agent.minimax.cn}/mavis/api/v1/mcp/web_search`，body `{"query":"test","count":1}`。

- 如果 200 → 签名头对 Matrix 面有效，**第 1、2 档全部打开**；
- 如果 401/403 → 签名头只对 `/minimax-cloud/` 面有效，Matrix 面需要额外头（注意上游 Matrix 走的是 `MATRIX_USER_AGENT = 'MiniMaxAgent'`，而公开网关走 `'MiniMaxCode'`——**`matrix-client.ts:10` vs `public-gateway.ts:84`**，这个 User-Agent 差异可能就是关键）。

这个探针能一次性消掉本报告里最大的不确定性。（本轮任务明确要求不发活请求，故未执行。）

---

## 6. 明确否掉的（及理由）

| 能力 | 否掉理由 |
| :- | :- |
| **ACP** | 它是「把 mcode 当编辑器后端」的进程协议，与我们「给 DSH 提供 provider」的定位正交。DSH 有自己的 subagent/task 体系，不需要再套一层 ACP。 |
| **画布（canvas）** | 纯本地 SQLite + 工作区文件引用，**零云成分**。且它服务的是 Desktop 的窗口模型；DSH 有 widget 看板。 |
| **miniapp** | 本地 Node 子进程 + 端口 + 专用 UI 表面。它是「云端连接器的本地消费者」，自身不是云能力；在没有连接器的情况下更是空壳。 |
| **channel-system** | 只是一组投递适配器**接口**（`deliver` / `typing.start\|end`），实现在产品侧。DSH 有自己的 channel 机制。 |
| **mcode-tools 宿主** | 本地 lease broker + 版本化 CLI 产物，与我们的进程模型无关。**但保留借鉴**：短命令牌 + capability 文件 + 永不出宿主的 refresh token，这套设计值得在我们将来跑不受信子进程时复刻。 |
| **更新（update/）** | 自带 npm 安装器 + versioned prefix 原子切换，会和宿主的插件版本管理打架。 |
| **遥测（telemetry）** | 上报到厂商域名（`data.hailuoai.com`），在我们的插件里没有正当性，且默认全关说明厂商自己也知道这是敏感项。 |
| **反馈工单（feedback）** | 给厂商提工单的通道；我们的用户应该提到我们自己的仓库。 |
| **p-config** | 加密载荷 + `desktop` 专属路径 + 「厂商决定提示词」，与插件定位直接冲突。 |
| **市场里的 App / Host Binding / miniapp 类插件** | 依赖 Desktop 的 Connector catalog、Browser/Computer Adapter、窗口模型，DSH 没有对应实现。**只能装 skills + mcpServers 子集。** |

---

## 7. 待确认 / 不确定项

以下都是 **[推断]**，需要实测才能定：

1. **签名头对 Matrix 面是否有效**（§5 探针）。上游两处实现（`public-gateway.ts:86-88` 与 `cloud-transport.ts:17-18`）用的是同一个盐，但 User-Agent 不同。
2. **`/minimax-cloud/api/v1/` 下还有没有我们没找到的路径**。本报告的清单来自对 `registry-client.ts` / `cloud-client.ts` / `ticket.ts` / `prompt-config-cloud-client.ts` / `http-gateway.ts` 五处的定点阅读，**不是全仓 grep**（GitHub API 限流，无法拿全量文件树）。**[事实]** 这些文件都通过 `PluginSystemCloudTransport` 的 `request({path})` 拼路径，所以还有可能存在其他调用方。
3. **连接器在国内订阅账号下的实际可用清单**（§5 第 3 项的前提）。
4. **媒体工具的 body schema 是否与平台 API 一致**。`tool-defs.ts` 里的是 MCP 工具的输入 schema，服务端可能再做一次转换；照抄 schema 不等于照抄语义。
5. **`CONTENT_DIGEST` 的 `sha256-tree-v1` 算法**：文档给了完整伪码（`package-format-v1.md:206-226`）和 checked-in vectors，**[推断]** 可实现，但只有做插件市场才需要。

---

## 附录：端点全表（一张纸）

| 面 | 主机（CN / EN） | 前缀 | 认证 | User-Agent |
| :- | :- | :- | :- | :- |
| 公开网关 | `agent.minimaxi.com` / `agent.minimax.io` | `/minimax-cloud/api/v1/` | Bearer + `yy`/`x-timestamp`/`x-signature` | `MiniMaxCode` |
| Matrix 媒体 | `agent.minimax.cn` / `agent.minimax.io` | `/mavis/api/v1/mcp/`（源码写 `/matrix/api/v1/mcp/`） | 同上 | `MiniMaxAgent` |
| LLM | `agent.minimax.cn` / `agent.minimax.io` | `/mavis/api/v1/llm/v1/` | 同上（无签名头） | — |
| 账号/重置卡 | `agent.minimax.cn` / `agent.minimax.io` | `/backend/account/` | Bearer | — |
| 遥测 | `data.hailuoai.com` / `data.hailuo.ai` | `/meerkat-reporter/api/report` | 诊断通道用账号令牌 | — |
| 更新 | npm registry + 阿里云 OSS 公开桶 | — | 无 | — |

签名头构造（`public-gateway.ts:78-90`，与 `checkin-gateway.ts:272-283` 逐字节等价）：

```text
yy          = md5( encodeURIComponent(pathname + "?" + search) + "_" + (body ?? "{}") + md5(String(nowMs)) + "ooui" )
x-timestamp = floor(nowMs / 1000)
x-signature = md5( floor(nowMs/1000) + "I*7Cf%WZ#S&%1RlZJ&C2" + (body ?? "") )
```

固定 query：`device_platform=web&biz_id=3&app_id=3001&version_code=22201&is_desktop=1&desktop_version=<ver>&unix=<ms>&timezone_offset=<sec>&sys_language=<lang>&lang=<lang>&device_id=0&os_name=<platform>&browser_name=mcode&user_id=<realUserID>&client=mcode`
