# 模型线路特化与 Agent 优化实施计划

## 1. 目标与范围

以审计基线 fd501cb 为起点，覆盖 ChatGPT/Codex、Claude、Antigravity、Kimi Code、MiniMax Code、Command Code、WorkBuddy、Ollama 八条线路。优先修复协议正确性，再优化模型状态回放、缓存、传输及多 Agent 调度。

本文件是实施计划，不代表能力已实现或线上验证通过。本轮审计未发送账号探测请求。实施前重新核对最新源码，避免重复建设。

成功标准：

- 能力声明与实际请求一致，不静默丢失图片、system 或原生回放状态。
- 账号轮换、模型切换、取消、重试、压缩和 fork 不导致状态串用。
- 用缓存读写、延迟、请求大小、工具成功率和实际成本衡量收益。
- 保留现有权限、凭据保护与宿主版本兼容性。

非目标：不整体替换 adapter；不绕过套餐限制；不把公开 API 能力自动等同于订阅网关能力；不重建 DSH 已有子 Agent、授权和路由审计；Ollama Local 属于独立扩展。

## 2. 证据与实施约束

| 等级 | 定义 | 实施规则 |
| --- | --- | --- |
| A：本地确认 | 源码可证明的行为或缺口 | 先增加回归测试，再修复 |
| B：上游契约 | 官方支持，但当前线路未验证 | 能力门控，先验证端点 |
| C：候选优化 | 社区经验或架构推断 | 做对照实验，不默认启用 |

能力键采用“线路 × 协议/端点 × 模型 × 认证方式”，记录 supported / unsupported / unknown、证据来源、上游版本、最后验证时间及回退策略。unknown 不等于 supported。

涉及宿主接口或版本兼容边界时，执行前加载 dsh-harness-upgrade skill，遵循其双基线验证方案；支持范围以实施时包声明为准。不得为了新功能移除旧宿主兼容路径。

线上探测另行确认账号、允许模型、请求数和费用/额度预算；默认使用 mocks 与脱敏 fixtures。不得记录原始凭据、完整用户提示、签名或隐藏状态。

## 3. 工作包与依赖

| ID | 优先级 | 工作包 | 归属与依赖 |
| --- | --- | --- | --- |
| W0 | P0 | 协议测试与能力基线 | 插件；无前置 |
| W1 | P0 | Codex turn-state 生命周期与账号隔离 | 插件及必要宿主接口；W0 |
| W2 | P0 | Ollama 图片/system 投影一致性 | 插件；W0 |
| W3 | P0/P1 | Command Code 三协议目录路由 | 插件；W0 |
| W4 | P0 验证 / P1 实现 | MiniMax thinking 回放 | 插件及授权探测；W0 |
| W5 | P1 | usage 与缓存诊断 | 插件；W0，可与 W1–W4 并行 |
| W6 | P1 | 多 Agent 并发槽、错误分类、预算 | 插件及 DSH；依赖身份与指标约定 |
| W7 | P1 | Codex WebSocket 与增量续接 | 插件及生命周期接口；W1、W5 |
| W8 | P2 | 分线路工具加载、压缩、缓存参数 | 插件及 DSH；能力验证、W5 |
| W9 | P2 | 文件式多模态与 Ollama Local | 插件；W2、独立范围确认 |

优先级不代表已证明线上故障发生。W4 必须先验证，不能直接发送猜测的 unsigned thinking 格式。

## 4. 第一阶段：正确性与协议基线

### W0：建立基线

- 记录实施起点 Git revision、工作区已有修改和上游参考版本。
- 八条线路分别建立文本、工具循环、reasoning、usage、取消与错误的最小脱敏样例。
- 明确保留 Claude 现有缓存断点/block binding、Kimi preserved thinking/动态工具、Antigravity 签名回放。
- 复用已有测试与探针，联网探针不进入默认单元测试。

验收：能力矩阵与测试清单可审阅；浮动上游资料有抓取日期或固定 commit；已实现能力不重复列缺口。

### W1：Codex turn-state 生命周期

证据：本地按 session 保存 turn-state，而官方限定在同一 turn 内并在认证主体变化时清空。入口：[ResponsesClient](../src/host/responses-client.ts#L138-L225)、[wire headers](../src/host/wire-auth.ts#L6-L36)。

实施步骤：

1. 区分 session、用户 turn、工具循环中的模型请求、认证主体四种身份。
2. 确认宿主能否提供可靠 turn 生命周期；必要时增加可选接口及兼容边界，不靠消息文本猜测。
3. 同轮首次收到的状态稳定复用；新 turn、认证主体变化、结束时清理。
4. 账号轮换废弃路由状态；后续连接及增量游标服从相同作用域。
5. 旧宿主无法提供身份时采用经验证的保守降级，不把 session 当 turn。
6. 更新旧语义注释和测试。

验收：同轮工具循环复用、下一用户轮清空、429 换账号隔离、401 刷新区分身份变化、并发 session 隔离、取消/异常/恢复清理均有测试。

### W2：Ollama 投影与能力声明

证据：声明 image，但投影仅提取文本；顶层 options.system 未进入请求。入口：[能力声明](../src/host/ollama/adapter.ts#L138-L157)、[请求投影](../src/host/ollama/adapter.ts#L301-L375)、[流映射](../src/host/ollama/mapper.ts#L34-L38)。

- 按模型及协议声明图片能力，正确传图；不支持时明确报错或可见降级。
- 同时处理顶层 system 与历史 system，定义顺序、避免重复。
- 增加模型级 think 控制、thinking 流事件及必要回放，不统一给所有模型发送 high。
- 本阶段保持 Cloud 定位，不混入 Local 参数。

验收：图文请求包含真实载荷；不支持图片有明确结果；system-only 一次性调用正确；thinking/text/tool 不串块；工具历史保持配对。

### W3：Command Code 三协议路由

证据：本地按 Claude 前缀二分，官方扩展按 supported_endpoints 区分 Messages、Responses、Chat Completions。入口：[路由选择](../src/host/command-code/types.ts#L121-L133)、[适配器](../src/host/command-code/adapter.ts)、[模型目录](../src/host/command-code/model-catalog.ts)。

- 保留目录端点声明，定义多端点优先级；未知模型不猜协议。
- 增加 Responses 映射、流解析和 reasoning 回放；共享纯协议代码，不混入 ChatGPT 订阅专有参数及头。
- 目录失败使用有证据的缓存/回退表，并可见地标记过期状态。
- 三种 wire 分别验证系统角色、reasoning、工具、usage。
- 增加显式 ZDR 选项及 x-cmd-zdr: 1；422 cmd_zdr_no_providers 不可静默降级。
- 区分套餐权限与 token 失效，避免无意义全池轮换。

验收：三协议各一模型、目录变化/失败、未知模型、错误端点、ZDR 拒绝、Responses 多轮回放均有测试。

### W4：MiniMax thinking 回放

证据：本地丢弃 reasoning；官方开放平台强调保留交错思考，但订阅网关载荷待验证。入口：[assistant 转换](../src/host/minimax-code/mapper.ts#L332-L353)、[缓存探针](../scripts/probe-minimax-cache.probe.ts)。

1. 核对各模型原始 thinking block、签名和 metadata。
2. 优先原样保存/回放合法 block，不由显示文本猜测隐藏状态。
3. 经授权比较现状与原生回放；unsigned 格式仅在线路明确接受后支持。
4. 检验跨模型、跨账号、压缩后的回放范围。
5. 同时验证已有缓存断点是否产生读写统计，不重新实现缓存标记。

验收：连续两轮以上工具循环无协议错误；来源与回放结构正确；离线 fixtures 覆盖；不以出现 thinking 文本单独证明任务质量提高。

## 5. 第二阶段：指标、并发与传输

### W5：usage 与缓存诊断

入口：[Codex usage](../src/host/responses-client.ts#L542-L553)、[Kimi 诊断契约](../src/shared/kimi-code-contracts.ts)、[Claude usage](../src/host/claude/mapper.ts#L1803-L1814)。

- Codex 映射 input_tokens_details.cache_write_tokens，普通输入扣除缓存读写，遵循宿主 disjoint 计数。
- 区分字段缺失和真实零值；不推导不存在的服务端统计。
- 记录输入/缓存读/缓存写/输出/reasoning、TTFT、总时长、请求体大小和重试次数。
- 使用局部哈希和结构位置定位前缀变化，不记录原始内容。
- 标记账号、模型、工具变化及压缩事件。
- 订阅额度与 API 标价分开；没有真实价格时不虚构节省金额。

验收：总输入等于普通输入加读写；流 usage 不重复；旧响应兼容；日志无敏感信息。

### W6：多 Agent 并发与预算

复用现有[授权](../src/host/subagent-model-authorization.ts)和[路由审计](../src/host/subagent-route-audit.ts)。

- 按线路/账号提供可配置并发槽，需要时再细分模型；不无依据硬编码套餐并发数。
- 公平队列支持取消、超时、finally 释放，并为主 Agent 保留交互容量。
- 区分并发、短期限流、配额、模型权限、认证失效；按已确认语义选择退避范围。
- 账号亲和是优化而非绝对绑定，换账号正确废弃状态。
- 与 DSH 配合限制整棵 Agent 树的费用/token/时间/深度/并发，不只依赖提示词。
- 独立任务优先干净上下文，依赖历史时才 fork；公共稳定规则在前，角色任务在后。

验收：取消和异常不泄漏槽；并发受控；权限错误不耗尽全池；预算停止可解释；模型授权不被绕过。

### W7：Codex WebSocket

依赖 W1。参考官方连接复用、预热、增量请求和会话级 HTTP 回退。

- 按认证主体和会话管理连接，设置数量上限、空闲回收及结束钩子。
- 仅合法历史增量使用 previous_response_id；配置/工具/压缩改变契约时完整重发。
- 验证订阅握手和 beta 要求，预热为 best-effort。
- 失败熔断并回退 SSE，避免每次请求重复尝试失败连接。
- 已交付工具调用去重，禁止盲重试造成重复副作用。

验收：首 token 前、文本中、工具中、提交结果后断连均可控；取消正确；账号切换不复用；相对 SSE 的成功率不下降，收益有测量证据。

## 6. 第三阶段：线路特化候选

### W8：动态工具、压缩和缓存参数

| 线路 | 候选 | 门槛 |
| --- | --- | --- |
| Codex | 显式断点、prompt_cache_options、configuration_update、追加工具、原生压缩 | 逐模型/订阅端点验证；旧 retention 参数不可全模型套用 |
| Claude | Tool Search、原生 compaction、公共前缀分层 | 保留 block binding 和断点；OAuth 未确认时关闭 |
| Antigravity | 签名来源、大结果引用、模型族能力表 | Gemini API 不等于 Cloud Code；不盲加 cachedContents |
| Kimi | 两种 wire 差异提示、动态工具历史一致性 | 不声称协议等价；不盲补被拒采样参数 |
| MiniMax | 回放与缓存验证产品化 | 先完成 W4，不照搬 Claude 签名要求 |
| Command Code | 缓存透传、模型级 thinking 策略 | 目录驱动，观察 usage，不无条件加旧 beta 头 |
| WorkBuddy | 工具历史配对、错误分类、动态目录 | 社区错误码需核实，不伪造工具成功结果 |
| Ollama | thinking 与能力发现 | Cloud 和 Local 接口分别确认 |

关键限制：

- WorkBuddy 已忽略空 finish_reason，不重复修复，见[现有处理](../src/host/workbuddy/mapper.ts#L619-L624)。
- run_code SDK 说明可能在提示文本而不是原生 tools 内；工具搜索收益必须基于真实载荷测量。
- 为稳定前缀移动 system/developer 指令前，验证指令优先级与权限语义不变。
- 原生压缩需保存合法状态及来源，不等于普通摘要。
- 服务端 Multi-agent 仅独立实验：必须实现 Agent 身份、工具归属、权限、费用和整树取消；DSH 异构多 Agent 保持默认。
- Codex freeform/grammar 补丁工具作为后续 A/B，不突破文件权限和读前写规则。

### W9：多模态与 Local

- Kimi Files API：先验证订阅权限，再设计账号隔离、文件 TTL、删除、取消和恢复，降低重复 base64 传输。
- MiniMax/Antigravity 视频：明确端点及模型载荷后才声明能力；否则明确降级。
- Ollama Local：独立需求和安全审查，设计可信端点、鉴权、发现、keep_alive、上下文和显存并发预算；任意 base URL 不是无风险选项，Local 参数不送 Cloud。

### 复核修正（2026-10-02）

代码审查发现上一轮的实现存在若干协议与状态错误，已修复并补齐回归测试：

- Codex 并发槽从客户端级数组改为按请求持有，一个请求结束不再释放其他请求的槽。
- Codex 路由状态改为每请求一个 key。宿主没有提供 turn id，任何基于消息内容的判据都不可靠（同一用户文本会在多轮重复，工具结果同样占用 user 角色，每轮开头的工具调用数都是 0），因此选择不可能出错的身份，代价是放弃轮内复用。宿主提供 turn id 后可恢复该优化。
- Command Code Responses 请求读取 Chat Completions 的嵌套 `function` 字段，工具名与参数不再丢失。
- Command Code 流式按 `item_id` 关联参数增量为 `call_id`，并为并行工具调用分配互不相同的块索引。
- MiniMax 回放改为累计 `thinking_delta` 与 `signature_delta`，不再只保存通常为空的起始块。
- Ollama 通过附件存储读取真实图片字节，并在插件入口注入该存储。
- 并发闸门在解除上限时正确计入等待者，并拒绝低于当前占用的上限。

两项功能已撤回而非保留未验证实现：

- **WebSocket 传输**：删除 `responses-websocket.ts`。它只有连接管理，没有任何请求收发，也未被生产代码引用；能力矩阵中该线路的 `websocket-transport` 改为 `unsupported`。
- **能力门控**：`capabilities.ts` 保留为证据记录，但不是开关。矩阵中每一条现在都与代码实际行为一致，且文件注释已说明这一点。

### W9 实施结果（2026-10-02）

多模态部分已随 W2 落地：Ollama 图片不再被静默丢弃，system 与图片按两种 wire 正确投影，thinking 独立成块。Kimi 视频工具与 MiniMax 视频降级保持原状，未改动——它们的文件上传接口未经本线路验证，能力矩阵将两条线路的 `native-video` 记为 unsupported/unknown 而非支持。

Ollama Local **未实现**，理由是安全边界而非工作量：`CLOUD_BASE_URL` 是硬编码常量，改为可配置 base URL 会让任意用户输入成为出站请求目标，涉及 SSRF、可信端点校验与凭证外发风险，超出本次优化范围。需要先确定：可信端点白名单策略、是否允许无鉴权的本机访问、Local 与 Cloud 的能力差异如何在设置中呈现。建议作为独立需求单独立项。

## 7. 验证、发布与回滚

### 离线矩阵

- 每种 wire：文本 → 工具调用 → 结果 → 最终回答。
- 回放：原生、缺失、跨模型、跨账号、fork、压缩。
- 多模态：支持/不支持、工具图片、超限、缺失附件。
- 生命周期：取消、恢复、并发、401/403/429/5xx、流截断。
- 缓存：缺失字段、读写同时存在、工具/system 变化、零与未知。
- 兼容：按维护 skill 的双基线方案验证旧宿主降级。

每个工作包执行对应 Vitest 测试、npm run typecheck、npm test、npm run build。包元数据或发布文件变更追加 npm pack --dry-run。生成目录只通过构建更新，不手改，不递归删除清理。

### 授权线上 A/B

固定模型、任务集、提示、工具和账号条件；区分冷/暖缓存，交错运行减少负载偏差。比较 TTFT/总时长分布、缓存读写、请求字节、工具成功率、重试率和真实费用/额度。先形成基线再确定数值门槛，不预设固定收益百分比。

硬门槛：无权限回归、无状态串用、无重复副作用工具执行、无静默内容丢失。性能提升不能以任务成功率下降为代价。

### 发布与回滚

- 正确性修复独立小提交；实验能力独立开关。
- 内部验证 → 单线路灰度 → 扩大模型/账号范围。
- 记录协议版本和开关；连接、缓存、游标可清空重建。
- 未知参数/事件或持续错误回退已验证 wire，不静默降低隐私或权限要求。
- 线上结论回写能力矩阵和脱敏回归样例。

## 8. 推荐提交顺序

1. 协议回归矩阵与能力基线。
2. Codex turn-state 与认证主体隔离。
3. Ollama system/图片修复及 thinking 支持。
4. Command Code 目录驱动三协议路由。
5. MiniMax 回放验证；通过后单独提交实现。
6. 缓存写统计及统一诊断。
7. 账号并发槽与错误分类。
8. Codex WebSocket 与回退。
9. 分线路动态工具、压缩、多模态实验。

宿主接口使用独立配套提交，明确最低支持条件和旧版降级；不要合并成不可回滚的大改动。

## 9. 参考资料

- [Codex：核实的 client 源码版本](https://github.com/openai/codex/blob/ca466061d64f0b44f416135c7fd06aa7af850bbc/codex-rs/core/src/client.rs)
- [OpenAI Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [OpenAI Tool search](https://developers.openai.com/api/docs/guides/tools-tool-search)
- [OpenAI Responses Multi-agent](https://developers.openai.com/api/docs/guides/responses-multi-agent)
- [Gemini CLI](https://github.com/google-gemini/gemini-cli)
- [Google Thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)
- [Google Context caching](https://ai.google.dev/gemini-api/docs/caching)
- [Claude Tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
- [Claude Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)
- [Kimi CLI](https://github.com/MoonshotAI/kimi-cli)
- [Kosong Kimi provider](https://moonshotai.github.io/kosong/kosong/chat_provider/kimi.html)
- [MiniMax Interleaved Thinking](https://www.minimax.io/news/why-is-interleaved-thinking-important-for-m2)
- [Command Code 官方 Pi provider](https://github.com/CommandCodeAI/pi-commandcode-provider)
- [WorkBuddy 社区 gateway：待验证参考](https://github.com/CangShui/workbuddy-gateway)
- [Ollama Thinking](https://github.com/ollama/ollama/blob/main/docs/capabilities/thinking.mdx)
- [Pi](https://github.com/badlogic/pi-mono)
- [OpenCode provider transform](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/provider/transform.ts)
