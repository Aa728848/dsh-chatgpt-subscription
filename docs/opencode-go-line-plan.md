# OpenCode Go 线路设计与证据

## 范围

- Provider id：`opencode-go`。只接入 OpenCode 官方 Go / Go Plus / Go Teams 工作区的个人或服务账号 API Key，不转发 OpenAI、Anthropic 或 Google 的订阅登录态。
- 协议：官方 Console gateway 的 OpenAI Chat Completions。官方声明每种文本模型都可经该 API 调用，网关负责原生协议转换；首版不另写 Responses、Anthropic 或 Gemini 适配器。
- 账号：静态 Key 走共享 `AccountPoolCore`，支持主账号、顺序耗尽、轮询与粘性会话、替换 Key、401 失效和 429 冷却；不会在已有输出后换号。
- 模型：实时目录按账号保存。聊天模型按厂商分组，可整组选中或取消勾选。未开放工具的聊天模型仍可用于对话。上下文、输出、模态、推理档位、训练、ZDR 和地区信息都来自官方目录。
- 额度：`GET /inference/go/v1/usage` 映射 rolling / weekly / monthly 三窗；没有官方套餐字段时不编造 Go / Go Plus 名称，只有响应里的 `opencode.billing_source` 可识别时才记录。

## 官方依据

- Go 文档与第三方客户端要求：https://opencode.ai/docs/console/go/ —— API Key、其他 coding agents、典型编程流量、自有 User-Agent、稳定 `x-opencode-session`。
- Harnesses 与 Base URLs：https://opencode.ai/docs/console/harnesses/ —— Go base URL、四种兼容协议、session header 要求。
- 模型目录：https://opencode.ai/docs/console/api/models/ —— `/inference/go/v1/models` 的目录形状、能力字段与账号过滤。
- 推理与用量：https://opencode.ai/docs/console/api/inference/ —— Chat Completions、流末 usage、`opencode.billing_source` 与 cost。
- 官方 favicon：https://opencode.ai/favicon-96x96-v3.png —— 2026-11-25 获取，536 bytes，SHA-256 `aa34092540de60c889610edfa3c25316e215f12d88af29cfba530d09aee7265c`。

## 实现接缝

- `src/shared/opencode-go-contracts.ts`：仅公开 DTO，不含 Key。
- `src/host/providers/opencode-go/`：账号池、设置、目录快照、官方 client、OpenAI mapper、adapter、同源路由。
- `src/client/providers/opencode-go/`：共享 `AccountPoolSection`、模型清单、上下文编辑器、Kimi 额度壳与 OPENCODE 字母悬停动画。
- `scripts/probes/probe-opencode-go-minimal.probe.ts`：独立真实 API 探针，不注册 Provider。

## 已验证

- 真实公开目录包含 `deepseek-v4.1-flash`，`canonical_id=deepseek/deepseek-v4.1-flash-1017`。
- 真实 Go Key 下，`glm-5.3` 与该 DeepSeek 快照均完成流式文本、工具调用、工具结果续轮、同一会话头和三窗额度读取；成功请求 `cost = 0`。
- 30 项新线路离线测试通过，覆盖 mapper、目录/快照、账号池、adapter、路由与正式 UI；冷却期状态探测、401 换号、多账号并发目录、静态前缀顺序和官方缓存计费字段均有回归覆盖。
- 正式 `OpenCodeGoAdapter` 的真实 DeepSeek 调用已验证：流式 `OK`、`probe_echo` 工具调用、`TOOL_OK` 续轮、稳定会话头与三窗额度；耗时约 25 秒。
- 最终验收：强制 Host/Client/Test/Scripts 类型检查通过；全量 434 个测试文件、7577 项测试通过（另 3 个文件、10 项测试跳过）；构建、`npm ci --dry-run` 与 `npm pack --dry-run` 通过。

## 风险与未验证项

- 同一会话头被接受不等于缓存命中；探针没有宣称缓存命中率。
- DeepSeek 在工作区未允许 Global 时会被官方以 HTTP 400 拒绝，需要用户自己调整 Regions；插件不修改工作区隐私设置。
- `dispatch` 的行为基准未重跑，协议通过不等于 DeepSeek 行为调优效果已复现。
- Go Teams 的 `billing_source` 与套餐显示尚未实测；未观察到时保持通用 OpenCode Go 字标。
- 全宿主实装、全量既有套件、构建与正式 adapter 的真实调用结果以最终验收记录为准。
