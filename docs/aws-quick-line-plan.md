# AWS Quick 线路实现记录

## 目标与边界

- Provider ID：`aws-quick`。单账号，不使用账号池。
- 使用 Quick Desktop 随附的官方 `quickwork-agent`，独立启动 outpost；不读取正在运行的 Quick 进程令牌。
- 支持 Fast / Balanced / Smart、推理强度、文本与思考增量、会话续用、取消、JWT 刷新和退出。
- Quick 没有公开底层模型 ID，模型选择器使用三个逻辑响应模式；没有可靠剩余配额接口，因此没有配额 DTO、徽章或 widget。
- 支持文本、思考、DSH 图片输入与工具闭环（含 MCP 图片结果）。工具 schema 通过稳定 stdio MCP 发布，调用由 DSH 审批执行，结果从同一 AIDP 连接续传。
- 未安装用户从设置卡进入官方下载页；个人可免费注册且不需要 AWS 账户。首次可在无工具请求时预创建连接器，并完成 Quick 原生批准。

## 已核实的协议来源

| 契约 | 本机安装包中的来源 |
| --- | --- |
| outpost 启动、`--outpost-only`、`--manifest desktop`、固定端口 | `app.asar → dist/main/agent-bridge.js` |
| 实例令牌经 stdin 传入，OUTPOST_TOKEN 不写日志 | `agent-bridge.js → pipeToken/setupProcessHandlers` |
| `POST /auth/profile-login`、`login/profile-login-cancel`、`/auth/logout` | renderer `startup-BoKhYWLI.js` 登录实现 |
| `GET /auth/sncs-session` 与 id_token / ws_host / tenant_url / actor_arn / provider 字段 | `dist/main/nook-auth.js → fetchSncsSession` |
| `/streaming/quickwork-chat-bidirectional-stream` 与 AIDP surface | `dist/main/enterpriseChatSocket.js` |
| `session_connect`、`user_message`、`stop_generation`、`token_refresh` | renderer connection/chat store |
| AIDP 出站 `rawInputEvent`：UTF-8 JSON → Base64 → 二进制 WS | renderer `YOe` |
| AIDP 入站 event-stream `rawOutputEvent` → JSON → Base64 解码 | renderer `QOe` |
| `text_delta` / `thinking_delta` 的 `payload.delta` 与结束事件 | renderer stream event handlers |
| 每条 `user_message` 也必须展开 `Np()` / `Pp()`，携带 `outpostId`、surface、appVersion 与 connector flags | renderer `W_t`；只放在 `session_connect` 会导致 runtime 看不到任何本机工具 |
| `tool_call.arguments.params.arguments` 解包与 `tool_result` 的 `result` / `error` | renderer `MY()` / `fDt()` |
| HTTP `invokeAgent` 与 WS 共享 `workingSessionId` / `outpostId` | `dist/main/nook-auth.js → buildInvokeAgentEnvelope` |
| 图片内联附件的 `type` / `name` / `size` / `mimeType` / data URI | renderer `GU()` 与 `Ea()` |
| 工具轮次使用 `custom_prompt` 约束 Quick 不得用设备 Python 沙盒替代 DSH Shell | renderer `W_t`；Quick 没有按轮次禁用指定内置工具的字段 |
| Quick Desktop 官方下载与个人免 AWS 账户注册 | https://aws.amazon.com/quick/download/ 与 `getting-started-desktop.html` |

官方公开资料：

- 桌面架构、HTTPS/WSS 与 Bedrock Agent Runtime：https://docs.aws.amazon.com/quick/latest/userguide/desktop-security.html
- 响应模式和 thinking effort：https://docs.aws.amazon.com/quick/latest/userguide/using-quick-chat.html
- AWS SDK QuickSight/Quick 命令目录：https://github.com/aws/aws-sdk-js-v3/blob/main/clients/client-quicksight/src/commands/index.ts

SDK 当前列出 327 个命令；Agent/Flow 为管理操作，没有发送聊天或执行 Flow 的公开命令。Quick 的 ACP 支持是 Quick 调用外部 agent 的方向，不能用作 DSH 调用 Quick 的上游接口。

## 安全与持久化

- 实例令牌由 `randomBytes(32)` 生成，仅驻内存并写入自己启动的进程 stdin。
- 长期登录凭据由官方 Quick 组件保管；本插件设置文件不含 access/refresh/id token。
- 状态 DTO 不包含 JWT。WebSocket 主机使用严格后缀与端口拒绝规则。
- 设置写入采用临时文件 + rename；模型选择 `null` 与 `[]` 保持三态语义。
- outpost 通过官方组件复用 Quick Desktop 的 `~/.quickwork` 配置与系统凭据库，并在线路卸载时回收；插件不直接读取凭据。
- stdio MCP 条目固定为 DeepSeek Harness（内部 id `dsh-quick`）。自有 `0600` 状态文件携带工具 schema、随机 loopback 地址和临时 Bearer，不含长期凭据；不进入 Web DTO。卸载保留连接器与 schema，仅清除失效的 execution 地址和 Bearer。`tools/call` 只匹配合法的活动 WSS 调用并停放，实际工具由所属 DSH turn 审批执行，真实结果共享给 WSS 与 MCP。Quick 的确认 nonce 不伪造、不写确认文件。
- `finish(tool-calls)` 前解除本轮 watchdog signal，避免其正常清理的 `consumer.abort()` 关闭留用 socket；下一轮重新绑定取消信号。
- Smart high 的工具后长思考使用 10 分钟空闲预算；WebSocket 传输、连接关闭、Quick 上游错误与不可读事件使用明确 `LlmError` 分类，可恢复故障仅进入既有限额重试。

## 验证记录

离线测试覆盖：真实 stdio MCP 请求的 WSS 匹配、停放、结果回传与桥接资源回收、Quick 图片内联附件、MCP 图片结果、不可读图片拒绝、无连接器的批准状态、无工具请求的预初始化、下载与初始化 UI、AIDP 字节级出站包装、真实 Smithy event-stream 入站往返、异常头、租户主机拒绝、停止帧、每条用户消息的 outpost 绑定、relay 参数解包、设置生产读写、文本/思考/结束分块、Quick thread 续用、DSH 工具结果续传、watchdog 正常清理不关闭留用连接、模型清单与无号池/无配额 UI。

## 实机验证（2026-11-21）

- 复用 Quick Desktop 当前 `social` 账号成功，`ws_host` / tenant 发现与区域 `us-east-1` 正常，无需再次浏览器登录。
- 真实 `streamQuickTurn`：Fast + off 返回精确的 `AWS_QUICK_OK`，终态 `stop`，outpost 回收成功。
- 真实 `AwsQuickAdapter`：返回 `AWS_QUICK_ADAPTER_OK`，DSH 分块为 `block-start → text-delta ×2 → block-end → finish`，回收成功。
- Smart + high 取消探针在收到两个事件后触发 abort，客户端停止并回收成功；服务端是否持久标记 cancelled 未单独检查。
- 探针输出不含令牌。以上使用真实 Quick 账号与真实 AIDP，但不是固定离线断言。

## 工具实机验证（2026-11-22）

- `/local/mcp/list` 与 `/local/device-tools` 均看到已启用的 DeepSeek Harness 和 `dsh_quick__dsh_echo`；outpost 日志确认 `putOutpost` 广播成功。
- 修复前，连策略为 `ALWAYS_ALLOW` 的官方 `run_python_outpost_local` 也返回 `Tools not found`，证明问题是整条消息缺少 outpost 上下文，而非 MCP schema 错误。
- 补齐 `user_message` 的 `outpostId` / surface / connector flags 后，官方本机工具真实产生 `tool_call`，目标设备名称正确。
- 真实 `AwsQuickAdapter` 完整通过：Quick 调用 `dsh_echo`，DSH 收到纯 `message` 参数，第二轮复用同一连接（连接计数 1），最终文本包含 `ok:true` 与 `AWS_QUICK_TOOL_OK`，终态 `finish`。
- 工具目录在探针结束后保留为启用状态，只回收自己启动的 outpost；没有移除用户已批准的连接器。
- 图片探针生成无用户数据的 64×64 红色 PNG，经真实 DSH `ImageBlock` 读取与 Quick 内联附件发送；Quick 回答 `Red, square.`，终态 `finish`。
- 全新系统上的实际下载安装和免费注册未自动执行；UI 链接、禁用状态、预初始化和批准状态由离线测试覆盖。

## 仍未验证

- 全新账号的真实下载安装、免费注册、浏览器登录、登录取消与退出完整流程。
- 企业账号及区域发现。
- 长连接自然到期后的 `token_refresh` 和断线重放。
- Quick 更新后 `provider` 是否仍分别为 social / enterprise；legacy gateway 当前明确拒绝。
- 多工具并发、长工具结果截断和 Quick 更新后的工具事件兼容性；单工具闭环已实测。
- DSH Shell 路由实测：模型生成 `gh issue list --state open` 并调用 DSH `win_bash`，没有 `run_python`；同连接返回模拟 issue 后最终文本列出 `#123`，退出码 0。
- 生产 `dispose()` 实测：DeepSeek Harness 仍存在且启用，stdio 配置与工具 schema 保留，execution 字段被移除；探针退出码 0。
- Quick Desktop 重启后的双客户端一致性已实测通过：WSS 登记 1 次、MCP loopback 调用 1 次、DSH 回传 1 次，原始状态 `complete`，最终文本确认 `ok:true / AWS_QUICK_TOOL_OK`，探针退出码 0；连接器保留启用，探针单独回收 broker。
