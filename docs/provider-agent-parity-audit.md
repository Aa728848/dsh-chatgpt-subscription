# 多线路与官方 Agent 能力 / 性能对照审计

## 范围与证据规则

本轮排除已完成专项修复的 `codex-chatgpt`、`kimi-code`、`minimax-code`，检查其余订阅线路及共享调用点。目标不是把公开 API 的全部功能套到订阅网关，而是找出**同一 wire、同一模型、同一认证方式**下有证据的行为差异。

证据分为：

- **A：当前实现可证明**——源码或共享内核契约足以证明缺陷；可用离线测试修复。
- **B：官方契约**——官方源码、官方文档或官方随包数据明确给出行为；未做真实账号请求时不声称线上实测通过。
- **C：候选差异**——只有社区转录、另一套 API 或架构推断；不默认改行为。

所有修复均只使用 mocks / fixtures。本文不给出未经 live A/B 验证的延迟、命中率或额度节省数字。

## 官方 Agent / 基线是否存在

| 线路 | 官方 Agent 或客户端 | 本轮可用基线 | 结论 |
| --- | --- | --- | --- |
| Claude | Claude Code | [Claude Code 网关协议](https://code.claude.com/docs/en/llm-gateway-protocol.md)、[Mid-conversation system messages](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages)、[Effort](https://platform.claude.com/docs/en/build-with-claude/effort)、[Vision](https://platform.claude.com/docs/en/build-with-claude/vision) | 有官方文档化行为；CLI 当前以原生二进制分发，未声称逐行读取其源码 |
| Antigravity | Google Antigravity | [官方文档](https://antigravity.google/docs/agent.md)、官方 SDK | 官方 Agent 走 GAOS Interactions API；本线路走 Code Assist `streamGenerateContent`，两者不能直接逐项等同 |
| GLM Coding Plan | ZCode | [zai-org/ZCode](https://github.com/zai-org/ZCode)、`zcode-builtin.json` revision 43、业务码表 | 有同端点的官方源码级基线 |
| Command Code | Command Code CLI | 官方 `command-code@1.88.2` bundle 内嵌注册表与 `toWireSystem`；公开 `/provider/v1/models` | 有官方随包数据；公开实时目录只决定当前可用模型，不含完整能力字段 |
| Step Code | Step Code | [stepfun-ai/Step-Code](https://github.com/stepfun-ai/Step-Code)、StepFun API 文档 | 有官方源码；真实对话请求仍未做账号联调 |
| Cline Pass | Cline | [cline/cline @ ca7402c](https://github.com/cline/cline/tree/ca7402c5abced42da9c7c50500b7a9bae82cb6fa)、官方 recommended-models | 有官方源码级请求与空回复处理基线 |
| Qoder | Qoder CLI / Agent SDK | [官方 CLI 文档](https://docs.qoder.com/cli/installation)、本仓 frozen fixtures | 官方协议资料不完整；账号亲和另由本代码自身设计约束证明 |
| OpenDesign | OpenDesign / AMR runtime | [nexu-io/open-design](https://github.com/nexu-io/open-design)、`openai-chat-token-params.ts` | 官方 DSH 集成方向与本线路不同；只采用可明确对应的官方网关参数规则 |
| WorkBuddy | CodeBuddy / WorkBuddy | 官方产品存在；本线订阅 API 无公开官方契约 | 不与不可读的官方协议做猜测性对齐，只修共享内核已证明的问题 |
| Ollama | 无单一对应的官方 Agent | Ollama 官方 API 文档 | 不在本轮“官方 Agent 对照”范围 |

## 本轮实施的修复

### 1. 图片预算按实际上线字节计量

涉及 Claude、Antigravity、Qoder、Step Code、WorkBuddy。旧调用先 offload、后 resolve，预算无法使用最终请求版本的 payload；现在统一为：

`normalize → resolveRequestImages → offloadOldestRequestImages(同一 resolved map)`。

测量与替换使用同一 map；不可用或已转成文字占位的图片不再占图片字节预算。各线路原有预算数字不因其它线路而改写。

### 2. Claude

- 表外 id 按官方“未识别模型按当前模型处理”的规则继承当前模型模板，而不是无图、无思考、200K / 32768 的保守 stub。
- 官方支持名单及未知当前模型只在官方允许的位置保留历史 `role:'system'`：它必须紧跟 user，且是末条或后接 assistant。DSH 的首条系统提示、后接 user 的 system 和其它违规位置折回顶层 `system`；不支持模型保留折叠兜底。合法 system 消息不与相邻 turn 合并，首位身份块保持独立。
- 模型发现使用 `redirect:'manual'`、3 秒超时，3xx 明确失败，只保留 id 含 `claude` / `anthropic` 的条目。
- 单图 5 MiB base64 防线与整请求 8 MiB 图片预算分离；超限优先通过现有 request-version 机制缩小，仍无法满足时给出可见 oversized 文本。官方 Vision 页面同时存在平台相关的 5 MB 与 10 MB 描述，本轮保留已批准的保守 5 MiB 防线，不把它描述成所有平台统一上限。

### 3. GLM / ZCode

- Anthropic 面从顶层 `reasoning_effort` 改为官方 `output_config.effort`。
- GLM-5.2 / GLM-5-Turbo 仅在显式 `none` / `disabled` 时发送 `thinking.type:'disabled'`；GLM-5.3 家族仍不发送该关闭形态。
- system 使用 text block 数组，在 system 末块与最新非 system 消息的最后一个可缓存块放置 ephemeral 断点；文字内容拼回后与旧形状一致。
- 补齐官方业务码分类，包括可重试的 1303 / 1312 与一组终局额度码；裸 429 / 未知 429 的保守兜底不变。
- OpenAI mapper 当前不可达，未改其请求行为，只修正文档与注释中的过时描述。

### 4. Command Code

- 以 `command-code@1.88.2` 官方内嵌注册表完整刷新 106 条能力记录，并用随包脱敏 fixture 做逐字段 parity。
- OpenAI / Responses 面在调用方与官方注册表都没有输出 cap 时省略对应字段；Anthropic Messages 必须携带 `max_tokens`，无声明时使用官方 CLI 的 64000 兜底。
- 不再用手写跨供应商观测表冒充官方输出上限；host 默认输出元数据只从官方声明的 cap 产生。
- Anthropic system 按官方 `toWireSystem` 使用 block 数组与 ephemeral 断点；OpenAI 面未添加无证据的缓存字段。
- 保留未编辑默认选择的迁移：目录刷新后，老用户未手改的清单不会把新增模型隐藏。

### 5. Cline Pass / OpenDesign

- 两条线路使用各自官方规则的 `max_completion_tokens`：Cline 的 `gpt-?[5-9]` / `o[134]` 边界规则与 OpenDesign 的开头锚定 `gpt-5` / o1 / o3 / o4 规则保持不同，未合并成更宽的猜测。
- OpenDesign 仅对官方定义的“拒收 `max_tokens`、要求 `max_completion_tokens`”400 文案做一次字段降级重试；其它 400 不重放。
- Cline 对真正零内容、零工具且正常 stop 的空轮次做最多 3 次总尝试，间隔 250ms 且可取消；内容证明前缓冲，重试不泄漏空块或重复文本，usage 聚合。最坏情况会多两个请求与 500ms 等待。
- 两者使用共享上下文溢出检测，并保留旧有的精确 `too many tokens` 兼容词面；QUOTA / AUTH / 429 优先级不变。

### 6. Step Code / Qoder / 共享请求闸门

- Step 仅发送调用方或目录真实声明的 `max_tokens`；无 cap 时省略，保留 `max_tokens` 拼写。窗口派生值不再经 host `defaultMaxTokens` 间接回到 wire。
- Qoder `session_id` 稳定段使用当前账号 uid + 模型；uid 缺失保持旧兜底。
- Qoder 的真实生成 POST 路径进入共享并发闸门；目录、配额、userinfo 与凭据兑换不进入。

## 明确留作后续或不改的项目

| 项目 | 原因 |
| --- | --- |
| Claude context_management、通用 400 自愈、per-message effort、按请求用途分 TTL | 需要独立状态生命周期、请求身份或更多同 wire 证据 |
| GLM 签名 thinking 回放 | 需要真实多轮样本与 replayState 设计，不在本轮猜测性扩展 |
| Antigravity GAOS 内置工具、resume、服务端压缩、音视频与额外 effort | 属于 Interactions API，不是本线路 Code Assist wire 的已证实能力 |
| Antigravity 1024px 之外的图片策略、非字符串 enum 改写 | 需要线上样本验证，不以猜测替代现有行为 |
| Cline / OpenDesign 随包目录数量与 OpenDesign 扩展价格维度 | 需另做完整能力与价格数据刷新，不与协议修复混杂 |
| WorkBuddy 模型级冷却持久化 | 属独立可靠性/schema 工作；没有公开官方订阅 API 基线 |
| Step 24h 缓存保留、Qoder 第三方输出上限常量 | 分别是新增能力和证据不足，不改 |
| 各线路共享 1.5 MiB 等图片预算数字 | 没有各网关上限证据时不凭其它线路数字改数 |

## 验证口径

每个模块以定向 Vitest 与类型检查自验，协调者再审查 diff、处理复核发现的回归，并在所有并行修改稳定后运行全量测试、typecheck、build 与 `git diff --check`。独立终审发现的 Claude system 放置、Cline cacheWrite 聚合、Antigravity 死代码覆盖和 README 旧计数均已修复后复验。

最终验收：`npm run typecheck` 0 错误；全量 Vitest **354 files passed / 2 skipped，6515 tests passed / 9 skipped**，exit 0；`npm run build` 通过；`git diff --check` 通过。真实账号、线上缓存命中、实际额度消耗与性能 A/B 均未验证。