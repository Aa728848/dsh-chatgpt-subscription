# Antigravity（ACP）线路计划与证据记录

> 状态：**实现完成，自动化门禁全绿，真实上游探针通过；UI Before/After 截图未完成**（见 §6 左未验证清单）。
> 本条线路替代 v0.70.0 移除的旧 `antigravity` 线路，但**不复用其任何代码或凭据**。

## 1. 为什么要换一条路

旧线路把 Antigravity 当作**模型供应商**接：本插件自己实现 Cloud Code Assist 的
`streamGenerateContent` 协议、思考签名重放、缓存对齐，甚至要模仿官方 Go 客户端的
TLS 指纹（见 `docs/antigravity-tls-fingerprint-probe.md`：结论是**做不到**，JA3/JA4
永远与官方不同）。上游一变即崩，这是它在 v0.70.0 被整条删除（47 个文件、约 1.5 万行）的原因。

新线路走 Google **官方**的 Agent Client Protocol：插件只做一次「DSH 调用 → ACP 调用」
的翻译，模型联网、登录、思考签名、提示缓存全部由官方 `agy` 进程负责。

## 2. 证据来源

| 事实 | 来源 | 日期 |
| --- | --- | --- |
| `agy acp` 启动 ACP v1 stdio 服务器；Zed / JetBrains / Android Studio / Xcode 原生支持 | https://antigravity.google/docs/cli/acp/ | 2026-11-12 |
| JetBrains 从 `~/.jetbrains/acp.json` 的 `agent_servers` 读取自定义 agent | https://www.jetbrains.com/help/ai-assistant/acp.html | 2026-11-12 |
| 官方 ACP Registry 条目（六平台归档 URL + sha256，版本 1.5.0） | https://github.com/agentclientprotocol/registry → `antigravity-acp/agent.json` | 2026-11-12 |
| 本机 `agy` 1.5.3；`agy acp --help` 的 flag 面；`agy models` 的目录 | 本机 `%USERPROFILE%\.gemini\bin\agy.exe` 实测 | 2026-11-12 |

## 3. 本机真实探针（非 mock）

| 探针 | 结果 |
| --- | --- |
| `initialize` | 协议 v1；server 自报 `Antigravity ACP Server`；`sessionCapabilities` 含 resume / close / list |
| `session/new` | 返回 `models.availableModels`（带档位 id）与 `configOptions`（`model` / `thought_level` / `mode`）；`_meta.antigravity.tier` = Google AI Ultra |
| `session/set_config_option` | 切模型、切 `thought_level` 均成功回执 |
| `session/prompt` | 真实返回 `stopReason: end_turn` 与 usage（含 `cachedReadTokens`） |
| **带 MCP 桥的工具往返** | 第一段 `finish(tool-calls)` 抛出 `dsh_probe_marker`；把结果喂回第二段后，agent 在**同一条 ACP prompt** 内继续并回答 `MCP_BRIDGE_OK` |
| 适配器单轮（`test/antigravity-acp.probe.test.ts`，需 `ANTIGRAVITY_ACP_PROBE=1`） | 目录 9 个模型；回答 `ACP_OK`；9.8s |

## 4. 架构决定

| 决定 | 理由 |
| --- | --- |
| 单账号，不建号池 | ACP 服务端只持有一套凭据；插件不读不复制，画一个「号池」等于宣称管理一个看不到的东西 |
| 工具经回环 MCP 桥交回 DSH | 主模型形态下必须沿用 DSH 的权限预设与审计；桥只绑 127.0.0.1、每会话新签发 bearer token、校验 Host、拒绝浏览器 Origin |
| 模型 id 归一（去掉档位后缀） | 服务端把同一模型发两遍（`availableModels` 带档位、`configOptions` 不带）；DSH 已有 reasoning effort 选择器，逐档位建模型会让选择器膨胀且语义重复 |
| 不展示额度百分比 | 官方服务端不公布剩余额度；伪造一个百分比是这张卡最不能犯的错 |
| 每轮新建 ACP 会话 + 前缀指纹判定 | 复用 ACP 会话能省一次预填充，但历史一旦被压缩/改写就会与 DSH 不一致；不一致时宁可再生 |

## 4.1 合规与条款风险（重要，先读这一节）

**这是本条线路唯一真正的风险来源，而且它不是技术风险。**

| 事实 | 出处 | 含义 |
| --- | --- | --- |
| 「使用第三方软件、工具或服务访问 Antigravity 违反我们的服务条款……可能导致账号被暂停或终止」 | 官方 FAQ `https://antigravity.google/docs/faq` → *Why can't I use third-party software (such as Claude Code, OpenClaw, or OpenCode) with my Antigravity login?*（2026-11-12 抓取） | 直接把「把 Antigravity 接进第三方应用」这一用法指向条款禁止面 |
| 「把 agy 包装进第三方编码 Agent 或应用、或自动化账号轮换，在消费者套餐下不受支持」 | 同上 → *Can I use Antigravity CLI headless mode in third-party coding agents or automate account switching?* | 连 headless 包装都被点名；本线路走的正是包装 `agy acp` 的形态 |
| Google 公开提供 ACP 文档，指导把 `agy acp` 注册进 Zed / JetBrains / Android Studio / Xcode | `https://antigravity.google/docs/cli/acp`、`/docs/ide/extensions/acp` | 同一家厂商又鼓励「编辑器以子进程方式运行 agy acp」，与上面两段存在解释空间 |
| Registry 条目标注 `license: proprietary`、`license_url: https://antigravity.google/terms` | `agentclientprotocol/registry` → `antigravity-acp/agent.json` | 二进制不随本包分发；下载与使用受 Google 条款约束 |

**本插件已采取的降低风险措施**（能降低风险，**不能消除**）：

1. **默认关闭**：`enabled: false`，必须由使用者显式打开。
2. **单账号**：不做账号池、不做账号轮换——这正是 FAQ 点名「不受支持」的行为之一。
3. **不碰凭据**：不读取、不复制、不保存任何 Google token；登录完全由官方进程完成。
4. **不伪装身份**：不修改 `agy` 的 User-Agent、不逆向协议、不做 TLS 指纹伪装（旧线路做过，且已证明做不到）。
5. **不随包分发二进制**：只从 `dl.google.com` 按固定 sha256 下载。

**使用者需要自己判断的**：这条线路落在「官方公开支持的编辑器 ACP 接入」与「第三方应用包装 agy」之间的灰区。若所在组织要求零争议，**请改用 Gemini Enterprise 或 Google AI Studio API Key**（Google 官方指引中推荐的第三方 agent 接入方式）。

## 5. 验证记录

| 门禁 | 结果 |
| --- | --- |
| `npx tsc -b --pretty false` | 通过 |
| `npx tsc -p test/tsconfig.json --pretty false` | 通过 |
| `npx tsc -p scripts/tsconfig.json --pretty false` | 通过 |
| `npx vitest run` | **376 文件通过 / 3 跳过；6768 例通过 / 10 跳过 / 0 失败** |
| `npm run build` | 通过（lib/index.js 4.55 MB） |
| `npm pack --dry-run` | 980 文件 / 4.3 MB；**不含任何 Google 二进制** |
| 反向对照（3 处） | ① 把 `catalog.ts` 的嵌套读取改回错误版本 → `antigravity-acp-catalog-read.test.ts` 变红；② 关掉原生工具守卫 → `antigravity-acp-native-tool.test.ts` 变红（promise resolved 而非 reject）；③ 关掉进程复用 → `antigravity-acp-pool.test.ts` 变红（3 次 spawn vs 1 次）。三处恢复后均转绿 |


## 6. 同类 ACP 实现对照：差异与我们的缺漏

对照对象（均为 2026-11 实际拉取源码/文档，非道听途说）：

| 项目 | 形态 | 与我们最相关的做法 |
| --- | --- | --- |
| `dannndouglas/dsh-antigravity-acp` 0.3.5 | DSH **主模型 provider** + 回环 MCP 桥 | 与我们的架构几乎同构：`LlmAdapter → ACP v1/stdio → agy_acp_server`，工具经 MCP 桥交回 DSH。本文档多处引用它的实测记录 |
| `@forge-ide/agy-acp` 0.1.1 | 通用 ACP 适配器 | 用官方 `@agentclientprotocol/sdk` 包 `agy` 的 headless stream-json，**不**接管工具；面向 Zed/JetBrains 等编辑器 |
| `google-antigravity-acp` 2.0.1 | 通用 ACP 服务器 | 同上，JSON-RPC over stdio 包 headless NDJSON |
| 官方 ACP Registry `antigravity-acp` 1.5.0 | 官方二进制分发 | 我们下载它的 `agy_acp_server`，并固定六个平台的 sha256 |

### 6.1 我们**比参照项目更严**的地方

| 项 | 参照 `dannndouglas` | 我们 |
| --- | --- | --- |
| 下载完整性 | 文档写明「Registry 不提供校验和，不虚构厂商签名」——即**只做 HTTPS 校验** | 我们**钉死六个平台的 sha256**（来自 Registry 条目），并额外校验 ZIP 路径穿越与解压体积 |
| 桥的准入 | 同样的 bearer/Host/Origin/1 MiB 边界 | 相同（独立实现），另加：MCP 工具名碰撞用 `hash` 归一、单定义 128 KiB 上限 |
| 凭据 | 不读取 | 相同 |

### 6.2 对照时发现的缺漏（均已修复，明细见 §6.3）

1. **原生工具绕过**（最严重）：参照项目检测到 agent 使用自己的工具时**取消并报错**；我们原先只是"忽略这些通知"。**本机实测确认这会发生**：不带桥时 agent 用原生 `write_file` 真的写出了文件 —— 也就是说带桥时它仍可能绕过 DSH 权限直接改工作区。
2. **采样参数被静默忽略**：ACP 的 `session/prompt` 没有 `temperature` / `maxTokens` / `stop`。参照项目显式拒绝；我们原先静默丢弃，而 DSH 的会话标题会传 64 token 上限、压缩会传 headroom 上限。
3. **无单进程会话数上限**：参照项目有 `maxSessionsPerProcess`（默认 100）。
4. **空闲进程池只进不出**（对照时新发现的真 bug）：`release()` 把进程塞进池子并挂定时器，但 `startTurn` 从不取出 —— 等于每轮冷启动，池子只是等着超时销毁。
5. **忽略 `usage_update`**：参照项目明确它是**上下文占用**（`used`/`size`），不是计费 token。
6. **错误码不成体系**：参照项目有 `ACP_*` 码表与 Troubleshooting。
7. **无 doctor / 自检**：参照项目有 probe 命令。
8. **图片输入**：参照项目明确未实现；**我们实现了**（`resolveRequestImages` + 12 MiB 内联预算），这一项我们领先。

### 6.3 上述缺漏的处理结果（全部已修）

| # | 缺漏 | 处理 | 守卫 |
| --- | --- | --- | --- |
| 1 | 原生工具绕过 DSH | 提示层声明 + `nativeToolPolicy` 决定遇到非桥工具时的行为：默认 `allow` 在对话里留一条可见记录并继续本轮，`cancel` 保留旧的 `ACP_NATIVE_TOOLS_UNSUPPORTED` 整轮取消 | `antigravity-acp-native-tool.test.ts`（两种策略各一例，另验证同一调用只记一次） |
| 2 | 采样参数被静默忽略 | `temperature` / `stop` 显式拒绝为 `ACP_UNSUPPORTED_OPTION` 并点名是哪一项；`maxTokens` 改为丢弃上限继续（见 §6.5） | `antigravity-acp-sampling.test.ts`（拒绝两例 + maxTokens 放行 + 无参数对照） |
| 3 | 单进程会话数无上限 | 新增 `maxSessionsPerProcess`（默认 **100**，与参照同值）；达到上限的进程直接销毁而不是回池 | `antigravity-acp-pool.test.ts` |
| 4 | 空闲进程池只进不出（本轮发现的真 bug） | `checkoutIdle()` 取热进程 + `rebind()` 换新一手的 handlers；此前每轮都冷启动 | `antigravity-acp-pool.test.ts`（三次生成只 spawn 一次；关闭复用则 3 次） |
| 5 | 忽略 `usage_update` | 按 schema 只读 `used`/`size` 存为**上下文占用**，与计费 token 分开；经 `/status.occupancy` 暴露并在卡片展示 | `antigravity-acp-routes.test.ts` / 卡片测试 |
| 6 | 错误码不成体系 | 新增 `errors.ts`：13 个 `ACP_*` 码各配可操作文案；适配器全部分类点接入；重试策略改为按这些码选择 | `antigravity-acp-sampling.test.ts`（码表覆盖 + 构造 + 识别） |
| 7 | 无 doctor / 自检 | 新增 `doctor.ts`（binary → protocol → auth → catalog → prompt 逐段）、`POST /antigravity-acp/api/doctor` 与卡片「运行自检」按钮 | `antigravity-acp-doctor.test.ts`（6 例，含断链与早退） |

**一处实测订正**：ACP schema 的 `UsageUpdate` 只有 `used`/`size`/`cost`，且本机真实 `agy` 1.5.3 **根本不发** `usage_update`（连了两次真实会话确认，只收到 `agent_message_chunk` 与最终结果里的 usage）。因此第 5 项实现为「有则显示占用、无则不显示」，不伪造，也不把占用当计费。

### 6.5 主模型线路「一轮就结束」的两个根因（issue #108）

真实使用里这条线路只有一轮：默认设置下模型想干活就结束，改成 `permissionPolicy: "allow"` 后又换成另一种失败方式。根因是**两道互相独立的闸门**，而只有第一道受设置控制：

| # | 闸门 | 原实现 | 现在 |
| --- | --- | --- | --- |
| 1 | `session/request_permission` 的应答 | 只有 `permissionPolicy === "allow"` 才回 `allow_once`，否则回 `cancelled`——**桥工具与原生工具一视同仁** | 桥工具（名字带 `mcp_dsh-bridge_` 前缀）恒定放行，因为它交回 DSH 后由 DSH 的权限预设把关；只有原生工具受 `permissionPolicy` 约束 |
| 2 | `session/update` 里出现非桥 `tool_call` | 无条件抛 `ACP_NATIVE_TOOLS_UNSUPPORTED` **取消整轮** | 由 `nativeToolPolicy` 决定：默认 `allow` 在对话里写一条可见记录（工具名 + 参数）并继续，`cancel` 保留整轮取消 |

agy 的事件顺序是 `tool_call` → `session/request_permission` → `tools/call`，所以第二道闸门在原实现里**先于权限请求**触发：即使把设置改成 `allow`，只要模型伸手去用自带工具，这一轮仍然会废。这就是「改了设置只是换一种失败方式」的原因。

顺带解决的两件事：

- **会话标题生成失败**：ACP 没有 `maxTokens`，而 harness 的标题服务固定传 64 token 上限，原实现把带 `maxTokens` 的请求整个拒绝为 `ACP_UNSUPPORTED_OPTION`，于是每个会话的标题生成都稳定报错。现在 `maxTokens` 被丢弃而不是拒绝——它约束的是调用方仍会完整读到的一段回答，丢的只是上限；`temperature` / `stop` 会改变模型**产出什么**，仍然显式拒绝。
- **提示词里的 `BRIDGE_ONLY_INSTRUCTION` 无效**：实测 `_meta.antigravity.systemPrompt.append` 不生效，追加文本进不了上下文（inputTokens 只 +5）。这是 agy 侧的限制，本插件不做补偿，只把它写进「做不到」清单（§6.4）。

### 6.4 参照项目也承认做不到、我们同样做不到的

- **不是 OS 沙箱**：ACP 只能观测与取消，不能阻止官方二进制在通知到达前完成一次原生写盘。参照项目原文："these protocol guardrails are not an OS sandbox"。
- **system 提示无法移除**：官方 agent 自己的系统指令始终存在，ACP 不是 raw model API。
- **无 raw tool_choice / 采样控制**。


## 7. `ACP_*` 错误码表

每个码对应一个可操作的状况，文案在 `src/host/antigravity-acp/errors.ts` 与本表保持一致；适配器的重试策略按这些码选择（`ACP_DISCONNECTED` / `ACP_RPC_ERROR` 可重试，其余不可）。

| 码 | 触发条件 | 该做什么 |
| --- | --- | --- |
| `ACP_AUTH_REQUIRED` | 官方进程没有缓存凭据（JSON-RPC `-32000` / "Authentication required"） | 在设置卡点「登录 Google 账号」，或终端执行 `agy acp --login` |
| `ACP_BINARY_UNAVAILABLE` | 找不到可用的 `agy`，或启动失败 | 安装 Antigravity CLI，或在卡片里指定可执行文件路径；本线路也能自动下载官方 ACP server |
| `ACP_DISCONNECTED` | agent 进程在回合中途退出 / 管道断开 | 重试（可自动重试）；持续失败检查 `agy` 版本与日志 |
| `ACP_RPC_ERROR` | JSON-RPC 返回了没有专属处理的错误 | 看错误文案里的原始 message；重试通常可恢复 |
| `ACP_INVALID_PARAMS` | 服务端拒绝请求参数或模型 id（`-32602`） | 换一个服务端公布的模型 id；不要用未公布的档位名 |
| `ACP_METHOD_UNSUPPORTED` | 服务端不实现本客户端调用的方法（`-32601`） | 升级 Antigravity CLI |
| `ACP_NATIVE_TOOLS_UNSUPPORTED` | agent 用了它自己的工具（`write_file` / shell 等），绕过了 DSH 桥，且 `nativeToolPolicy` 为 `cancel` | 默认策略下不会出现；若已切到严格模式又反复遇到，说明该任务需要 DSH 未提供的工具 —— 在卡片里补充工具、换线路，或把策略切回「记录并继续」 |
| `ACP_REFUSAL` | agent 拒绝了该 prompt | 调整请求内容 |
| `ACP_UNKNOWN_STOP` | `stopReason` 不在已知集合内 | 记录该 stopReason 并反馈；本轮按错误处理 |
| `ACP_TOOL_RESULTS_MISSING` | 工具结果与调用对不上（缺失或重复） | 从已保存的历史重试 |
| `ACP_SESSION_LIMIT` | 同时在跑的回合超过 `maxActiveTurns`，或 agent 达到自身的回合请求上限 | 结束/取消一个回合后重试 |
| `ACP_UNSUPPORTED_OPTION` | 请求带了 ACP 表达不了的采样参数（`temperature` / `maxTokens` / `stop`） | 去掉这些参数；用模型档位而非 token 上限控制输出 |
| `ACP_TEARDOWN_FAILED` | 进程清理无法确认 | 重启 DSH profile |

## 8. 左未验证清单（下一个人应先读这里）

1. **UI Before/After 截图对未完成。** After 侧已人工确认：订阅服务总览 13 张卡、Antigravity（ACP）详情页（运行环境 / 登录 / 模型 9 个带档位 / 增强功能 / 用量 / 能力边界）均正常渲染。Before 侧（隐藏新卡片的对照构建）因浏览器自动化在滚动时鼠标事件超时未拍成；仓库的视觉验收门禁因此**未满足**。
2. **未在真实 DSH 会话里跑完整 agent 轮次。** 适配器的真实探针是直接调用 `adapter.stream()`，没有经过 `dsh web` 的 agent loop（那需要一次真实的模型选择与会话）。
3. **子代理形态未做真实委派。** 单测覆盖 start/result/dispose 与 `subagents` 缺失降级，但没有在真实会话里让主代理委派一次。
4. **官方服务端版本漂移。** 本机实测 1.5.3（server 自报 1.5.7），随包固定的是 Registry 的 1.5.0。若上游把 `models.availableModels` 的嵌套再改一次，思考档位会静默变空——`antigravity-acp-catalog-read.test.ts` 是这条的守卫。
5. **第三方模型可见性。** Claude Opus/Sonnet 5.5 与 GPT-OSS 120B 在本机对非 JetBrains 客户端可见；上游若收紧，目录会自动消失，不做写死兜底。
6. **`session/resume` 未使用。** 代码路径存在（history 模块的指纹判定），但当前实现一律新建会话；没有测量过复用能省多少。
7. **doctor 只接到路由与卡片，没做独立 CLI。** 现在是 `POST /antigravity-acp/api/doctor` 与设置卡的「运行自检」按钮；参照项目那种 `dsh-antigravity-acp probe` 的独立 bin 没有做（本插件是单包多入口，新增 bin 要改 `files`/`bin` 与打包校验）。
8. **`usage_update` 的 `cost` 字段未使用。** schema 里 `UsageUpdate` 还有 `cost`，本机实测拿不到该通知，所以没有实现；若将来服务端开始发送，需要先确认它的货币与计量口径再展示，不猜。
