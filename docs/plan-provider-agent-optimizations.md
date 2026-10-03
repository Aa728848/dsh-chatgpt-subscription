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

证据：原实现丢弃 reasoning。**2026-10-03 实测确认订阅网关开放交错思考**：M2.7 与 M3.1-Flash-Preview 在 `/mavis/api/v1/llm/v1/messages` 返回 `thinking` 块和 64 字符 `signature_delta`，thinking 原样回传后工具循环第二轮均返回 200；M3 实测默认不返回 thinking 块。另一条实测约束：该网关只接受 Anthropic 标准的 `role: user` + `tool_result`，`role: tool` 会报 `tool call id is empty`（现有 mapper 已使用标准形式，无需修改）。入口：[assistant 转换](../src/host/minimax-code/mapper.ts#L332-L353)、[缓存探针](../scripts/probe-minimax-cache.probe.ts)。

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

### 当前完成度审计（2026-10-03，本轮修复与原计划交付分开核算）

上次“全部完成”的结论撤回。修复协议缺陷不等于 W0–W9 全部验收；删除未接线实现、保守禁用或写入能力清单也不算交付对应优化。下表按原始验收条件，不给无权重依据的百分比。

| 工作包 | 状态 | 已有证据 / 本轮范围 | 未完成的验收项 |
| --- | --- | --- | --- |
| W0 协议与能力基线 | 本次范围已交付 | [八线路测试矩阵](<provider-protocol-test-matrix.md>)、[精确能力门控](<../src/host/common/capabilities.ts>)区分 provider/wire/model/auth 与 offline-contract；Ollama 图片/think 实际接入生产 | 旧 provider-only 表仅库存，不冒充所有模型线上支持；未有证据组合保持 unknown，不适合自动探测消耗用户账号 |
| W1 Codex turn 生命周期 | 保守降级，跨轮复用决定不做 | [客户端](<../src/host/responses-client.ts>)请求本地槽、结束清理与不跨请求复用；普通 429 不推断并发数 | 宿主无可靠回合身份，内容猜测会误复用；无线上端到端验证 |
| W2 Ollama 投影 | 本次范围已交付 | 原生/OpenAI 图片格式、工具参数对象、附件降级、新旧工具结果、system 去重、模型级 think；已连接精确模型/认证/协议证据门控 | 未知新模型保持可见降级，不把通用协议 fixture 当网关实测；未消耗真实额度做 Cloud 实测 |
| W3 Command Code 三协议 | 本次范围已交付 | 三协议 ZDR 头与 fail-closed、显式隐私门控、权限/认证错误分类、目录过期时间和隐私状态 UI 已实现，实际请求测试覆盖 | 原生 encrypted reasoning 回放缺网关样例及来源契约，决定不做；真实套餐/ZDR 保留行为依赖供应商承诺，非本插件可保证 |
| W4 MiniMax 回放 | 线上已实测通过 | 来源隔离、原始块顺序保护、thinking/signature 增量保留；2026-10-03 用真实订阅账号实测：M2.7 与 M3.1-Flash-Preview 返回 thinking 块与签名，原样回传后第二轮均 200 | M3 默认不返回 thinking 块（目录标 toggle，实测默认关闭）；未验证服务端是否校验签名内容，也未做缓存收益结论 |
| W5 usage 与诊断 | 传输层观测已交付，语义关联决定不做 | 八线路可选日志：首字节、总耗时、请求字节、HTTP 状态、端点相关 usage、短期 HMAC 模型/认证/工具/前缀摘要；缓存 0 与缺失分开；日志不含原文 | 字节层不冒充 TTFT（明确 null）；重试仅显式关联时记录，宿主无回合/压缩语义，猜测即伪造；不做费用结论 |
| W6 并发与预算 | 限流已实现，预算决定不做 | [统一控制层](<../src/host/common/model-request-control.ts>)已接八线路生成请求，按凭据限流、FIFO、等待超时、流结束/取消/错误释放；默认关闭且不猜套餐并发数 | 主 Agent 预留槽与整树预算需要宿主可信身份，HTTP 边界猜测即错误限流；刷新后新凭据不保证同账号跨 token/进程总上限 |
| W7 WebSocket | 决定不做 | 未接线连接骨架已删除，生产保持 SSE | 无网关握手/续传证据；重放工具副作用无法保证幂等，收益不足以抵消重复执行风险 |
| W8 分线路优化 | 有证据部分已交付，其余决定不做 | Ollama 模型级控制与门控已接生产；Claude/Kimi/Antigravity 既有缓存/回放/动态工具保留但不计新增交付 | 服务端工具搜索、原生压缩、动态配置、多 Agent 缺订阅端点证据与宿主权限归属，公共 API 契约不能直接套用订阅网关 |
| W9 文件多模态 / Local | 决定不做 | Ollama 图片修复属于 W2；Kimi 既有视频工具不等于 Files API | Files API 无权限/TTL/隔离/删除契约；视频端点载荷未确认；Local 属独立安全范围 |

#### 明确不做项及理由

以下项目经评估后决定不做，而不是等待。以下理由是决策依据，不是待办清单。

| 不做项 | 理由 |
| --- | --- |
| Codex WebSocket 传输与增量续接 | 订阅握手与断点续传无网关证据；工具副作用无法保证幂等时重放会产生重复执行，风险高于 SSE 收益 |
| Codex 完整 turn 连续性复用 | 宿主未提供可信的人类回合身份，按消息内容猜测会误复用状态，保守的请求内隔离更安全 |
| 服务端压缩、工具搜索、动态配置、多 Agent | 公共 API 存在不等于订阅网关接受；且服务端压缩状态归属、工具权限、整树费用与取消无法在本插件内保证 |
| 整树预算与主 Agent 预留槽 | HTTP 边界拿不到可信的 Agent 树身份，做不到正确归属就是错误限流或错误放行 |
| Kimi Files API | 无订阅权限、文件 TTL、账号隔离、删除与恢复的确切契约；当前内联 base64 行为明确可用 |
| MiniMax/Antigravity 原生视频 | 端点与载荷形态未确认，宣称能力即是对用户的错误承诺 |
| Ollama Local | 涉及可信端点、SSRF、鉴权、显存与上下文预算，属独立安全范围，不并入本插件 |
| 线上 A/B 与费用收益结论 | 未获授权使用真实账号额度；无真实价格时虚构节省金额等同错误数据 |

[运行控制与边界](<provider-runtime-controls.md>)记录已实现功能的配置方式；[八线路协议矩阵](<provider-protocol-test-matrix.md>)提供可复跑入口。

#### 扩展实现验证（本次“剩余可做项”）

当前 0.2.0-rc.2 和旧宿主 0.1.5-rc.1 强制源码检查通过，当前测试类型检查通过；构建、打包与 git diff --check 通过。最终全量：当前 **2266 passed / 7 skipped**（145 文件通过），旧版 **2263 passed / 7 skipped**（144 文件通过，明确排除旧版不存在的 PTC runtime 集成文件）。没有未收集的验证任务。GUI 组件测试通过，现有 `http://127.0.0.1:3080/` 未认证请求返回 401；未绕过登录、未启动替代服务器，也不宣称用户页面已经热更新。

#### 前一轮协议修复验证（历史基线，不替代本次结果）

- 本轮只使用离线 fixtures 与 mock 凭据，没有调用真实订阅模型或消耗账号额度。
- 当前宿主 0.2.0-rc.2：`npx tsc -b --force`、测试类型检查通过；最终全量 **2218 passed / 7 skipped**（143 文件通过，1 文件跳过）。
- 旧宿主 0.1.5-rc.1：独立精确依赖树，强制源码类型检查通过；全量 **2215 passed / 7 skipped**（142 文件通过，1 文件跳过），另明确排除仅新宿主拥有的 PTC runtime 集成文件，其 3 项测试仍在当前宿主全量执行。旧版本 registry 没有该包，首次完整运行已实际报告 import failure，而非默默跳过。
- `npm run build`、`npm pack --dry-run --json`、`git diff --check`、主工作区 lockfile dry-run 一致性检查通过。已删除两份过期的 WebSocket 生成声明，最终包清单不再含该模块。
- 附带修复一个可复现的测试时钟缺陷：签到节流测试从真实 23:5x 推进十分钟会跨午夜；改固定中午并新增跨午夜验收，生产签到逻辑未修改。
- 详细基线依赖、首次失败原因与协议参考见[兼容性记录](<../.dsh/skills/dsh-harness-upgrade/references/provider-protocol-review.md>)。
- 不修改宿主实现，不开启未经验证的服务端能力；宿主配套工作和授权验证分别列为未完成，不伪称阻塞已修复的离线协议问题。

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
