# 架构设计与开发维护指南

本文档面向参与 `@eddyskywalker/dsh-chatgpt-subscription` 二次开发、新增供应线路、跟进 DSH Harness 版本升级及发布维护的贡献者。

---

## 目录

1. [目录结构与包导出边界](#1-目录结构与包导出边界)
2. [同包多组件与 `volatile` 配置接线](#2-同包多组件与-volatile-配置接线)
3. [共享内核（Shared Kernel）](#3-共享内核shared-kernel)
4. [Agent 编排、缓存守卫与流可靠性](#4-agent-编排缓存守卫与流可靠性)
5. [客户端扩展与三语国际化（i18n）](#5-客户端扩展与三语国际化i18n)
6. [跨代际 DSH Harness 兼容策略](#6-跨代际-dsh-harness-兼容策略)
7. [开发、验证与发版流程](#7-开发验证与发版流程)

---

## 1. 目录结构与包导出边界

```text
.
├── src/
│   ├── index.ts                     # 核心宿主入口（13 条线路接线、工具注册、全局守卫）
│   ├── entry-progress-updates.ts    # 子入口：./progress-updates（进展汇报独立组件）
│   ├── entry-plan-mode-pipeline.ts  # 子入口：./plan-mode-pipeline（enter/leave_plan_mode）
│   ├── entry-plan-mode.ts           # 子入口：./plan-mode（尾部一次性投递的计划模式服务）
│   ├── entry-tool-result-pruner.ts  # 子入口：./tool-result-pruner（缓存感知的工具结果修剪器）
│   ├── compat.ts                    # 跨层常量与插件版本标识
│   ├── host/                        # Node.js 宿主侧实现
│   │   ├── common/                  # 共享内核（号池、存储、快照、代理、超时、i18n 等）
│   │   ├── antigravity/             # Antigravity 线路
│   │   ├── claude/                  # Claude 订阅线路
│   │   ├── cline-pass/              # Cline Pass 线路
│   │   ├── command-code/            # Command Code 线路
│   │   ├── glm-coding-plan/         # GLM（ZCode 账号）线路
│   │   ├── kimi-code/               # Kimi Code 线路
│   │   ├── minimax-code/            # MiniMax Code 线路（含视频工作流与运行时增强）
│   │   ├── ollama/                  # Ollama Cloud 线路
│   │   ├── opendesign/              # OpenDesign 线路
│   │   ├── qoder/                   # Qoder 线路
│   │   ├── step-code/               # Step Code 线路
│   │   ├── workbuddy/               # WorkBuddy 线路
│   │   ├── cache-warmup/            # Kimi 大结果投影与 ref:// 补读子包
│   │   ├── dispatch-ledger/         # 调度模式 Mandate v2 账本与血缘守卫
│   │   ├── progress-updates/        # progress_update 宿主服务与存储
│   │   ├── compaction-route/        # 上下文压缩独立模型路由
│   │   ├── no-answer-resume/        # 空轮次自动续跑
│   │   ├── reasoning-collapse-guard/# 双信号推理塌缩熔断器
│   │   └── widget-board/            # dsh-widget-board 看板数据源与能力
│   ├── client/                      # Web 浏览器侧实现（React + CSS-in-TS + Slots）
│   │   ├── index.tsx                # 浏览器端总入口（打包为 lib/client.js）
│   │   ├── hub/                     # 订阅服务总览页与一键更新检查
│   │   ├── common/                  # 共享号池卡片、模型勾选表、语言镜像与样式
│   │   ├── locales-ru/              # 俄语语言包（15 个命名空间）
│   │   ├── mermaid/                 # 对话流 Mermaid 图表监听与安全渲染
│   │   └── <line>/                  # 各线路独立设置页、API 封装与输入框额度胶囊
│   └── shared/                      # Host 与 Client 共享的无副作用纯类型与 DTO 契约
├── presets/dispatch/                # 随包分发的「调度模式」Agent Preset
├── widgets/line-flip/               # 随包分发的「线路额度」双面翻转看板组件
├── locale/progress-updates/         # 进展更新组件元数据多语言包（zh / en / ru）
├── bin/antigravity-login.mjs        # Antigravity 命令行登录辅助脚本
├── test/                            # Vitest 单元与集成测试套件（严禁依赖外网或真实凭据）
└── docs/                            # 参考手册与各模块设计/协议审计档案
```

### 包导出（`package.json#exports`）

| 子路径 | 构建产物 / 目标 | 用途 |
| --- | --- | --- |
| `.` | `lib/index.js` | 核心宿主插件入口 |
| `./client` | `lib/client.js` | Web 界面插件包（通过 `window.__ModuleLoader__` 注入） |
| `./progress-updates` | `lib/progress-updates.js` | `cordis.patch.yml` 第二加载行（可在插件管理页独立开关） |
| `./plan-mode-pipeline` | `lib/plan-mode-pipeline.js` | 调度模式 `planning` 组挂载的 `enter_plan_mode` / `leave_plan_mode` |
| `./plan-mode` | `lib/plan-mode.js` | 保护前缀缓存的计划模式指引尾部投递版 |
| `./tool-result-pruner` | `lib/tool-result-pruner.js` | 自动跳过前缀缓存计费线路的工具结果修剪器 |
| `./presets/*` | `presets/*` | 随包 Agent Preset 静态资源 |

---

## 2. 同包多组件与 `volatile` 配置接线

为什么 `progressUpdates`、`planModePipeline`、`dispatchExecutionGuard`、`cacheWarmup` 等设置字段全部声明在核心入口 `src/index.ts` 的 `Config` 上，而不是各自拆到子入口？

- DSH Profile 的 `cordis.patch.yml` 按条目 `id` **整行覆盖** `config`；若把既有用户已经写进核心行的字段迁移到子行，旧 patch 会将子行配置抹回默认值，造成「面板显示开启、实际未生效」的配置撕裂。
- 这些字段在 Schemastery schema 中标记了 `.volatile()`：宿主设置面板保存时直接更新内存中的活引用（`Volatile<T>`），核心入口通过 `attachProgressSettings` / `attachPlanModePipelineSettings` 将读取闭包移交给子入口，**无需重挂任何插件行，下一步模型调用即刻生效**。
- `mediaTools` 同样留在核心 Config，并标记为 `volatile` 以允许共享设置表单保存；apply 只在注册时读取一次，不订阅活引用：它控制 Codex/Antigravity 生图、Kimi 视频挂载、MiniMax 视频生成与理解这五个工具的注册。工具 schema 是 Kimi 前缀缓存的稳定输入，因此只在插件重载或重启时改变工具表，不使用执行期拒绝或动态 `{ when }` 冒充关闭。默认 `true` 保持旧部署的工具表不变；实际切换后，既有 Kimi 会话会有一次可诊断的 `tools` 前缀重建，随后保持稳定。

---

## 3. 共享内核（Shared Kernel）

新增或修改供应线路时，应优先复用 `src/host/common/` 与 `src/client/common/` 的共享设施，禁止复制粘贴造轮子：

- **统一多账号池（`account-pool.ts` + `pool-storage.ts`）**：提供 `sequential`（顺序耗尽）、`round-robin`（轮询）、`sticky`（粘性固定）三种轮转策略、429 冷却计时、401 失效标记、主账号指定与备注；支持 `keyring` 与 `credentials` 双存储后端。账号主键必须使用**不可变内部 ID / 记录槽标识**，严禁用会轮换的 `refresh_token` 或其哈希做主键。
- **路由归属声明（`provider-route.ts`）**：通过 `claimProviderRoute` 安全调用 `ctx.llm.registerAdapter`，遇到 `DUPLICATE_ADAPTER`（如与其他插件撞 Provider ID）时平滑降级为卡片冲突提示，并在占用解除后自动接管，绝不导致整个插件挂载崩溃。
- **目录快照持久化（`catalog-snapshot.ts`）**：将实时拉取的上游模型清单快照落盘到 `<DSH_HOME>/storages/`，重启后零网络等待即可渲染模型选择器。
- **双阶段流式空闲看门狗（`idle-watchdog.ts`）**：默认 120 秒阈值（严格小于底层 `undici` HTTP/2 的 300 秒断连阈值；Ollama 本地算力场景例外设为 300 秒），并在**收到响应头时脉冲重置一次**，从而将「慢首包预填充」与「流中途卡死」解耦，卡死后立即进入有界重试。
- **上下文溢出与输出预留（`context-overflow.ts` + `output-reservation.ts`）**：统一识别各网关的 token 超限报错并转为 `CONTEXT_WINDOW_EXCEEDED` 交由宿主压缩恢复；对「输入能放下但输入 + 输出预留超限」的 HTTP 400/422 自动下调单次输出上限重试一次。
- **实际载荷图片预算（`request-images.ts`）**：遵循 `normalize → resolveRequestImages → offloadOldestRequestImages` 顺序，按实际上线 base64 体积计量并按最旧优先替换为明确文字占位，但每条线路保留各自经实测验证的字节上限。
- **缓存策略与请求协调（`prompt-cache-policy.ts` + `prefix-request-coordinator.ts`）**：线路显式声明 TTL、账号作用域与可用机制；冷启动协调支持 in-flight-only，未知 TTL 不得宣称 warm。亲和、续热与提示都受策略门控。
- **共享运行时护栏（`tool-runaway.ts` + `cache-warmup/`）**：规范工具调用键、分级提醒与 `ref://` 结果预览不再绑死 Kimi；Kimi 强停、MiniMax 官方失控信号与各线路协议文案仍由自己的 profile 保留。
- **媒体与诊断复用（`hosted-media.ts` + `session-cache-state.ts`）**：上传缓存/调用方感知单飞、粘性图片身份与活动记录使用共享内核；Kimi/MiniMax 的上传协议、TTL 和持久化格式不互相覆盖。

---

## 4. Agent 编排、缓存守卫与流可靠性

本仓库不仅提供模型接入，还针对长程编码任务与前缀缓存计费模型（尤其是 Kimi Code、MiniMax Code、Claude）构建了完整的运行时护栏：

1. **调度模式（`dispatch` Preset + `dispatch_ledger`）**
   - 详见 [presets/dispatch/README.md](../presets/dispatch/README.md)。
   - 通过 `R0` 分诊（L0 直做 / L1 轻量 / L2 完整治理）、`R-G` 澄清访谈、`R9` 计划模式管线、`R1` 拓扑选择（`Lead-Core` / `Hybrid` / `Fan-out`）、`R2` 显式子代理模型路由与 `R6` 证据验收组织复杂工程任务。
   - **呈现方式是 Code Mode**：预设自己注册的工具保持原生可调，预设清单以外的一切（MCP 服务端、profile 级插件工具、按 agent 注册的工具集）不进入模型上下文，只能在 `code_run` 程序里用 `code_tools_list` / `code_tools_search` / `code_tools_describe` 现查现调；模型直呼被遮蔽的名字会在派发前被拒绝并给出发现指引。遮蔽与拒绝发生在 per-scope `ToolExecutor`（`ctx.tools.setExecutor()`，0.2.2+）里，程序内子调用整批委托给内核原生 executor，因此策略、审批与 post-execute 管线一个不少。解析不到 `@deepseek-ai/dsh-tool-executor-native` 的代次自动退回 PTC 呈现。详见 `src/host/codemode/` 与 `src/entry-codemode.ts`。
   - `dispatch_ledger` 在根工具注册面上静态注册，通过尾部工具返回按需提供 Mandate v2 协议与可复制头部骨架，配合 `ctx.tools.guard()` 防重、验血缘与防越权，**全程零工具声明面变动、零前缀缓存漂移**。
   - 与 Agent Teams 的关系：现行运行时只追加共享任务板 `team_task_*` 并复用 `list_agents` / `send_message` / `wait_agent`，与调度模式并行运行；旧代运行时（注册 `spawn_teammate` 并顶替协调工具）已在 harness 0.2.1-rc.2 整体移除，因此调度模式以该代为下限，persona 不再按代检测（原 `R0.5` 闸门已删除）。开关打开时分工固定：`dispatch_ledger` 仍是派发权威、R5 任务书仍是任务契约，任务板只公开跨代理依赖与写作用域（一条 brief 一条 task，由子代理 claim/complete，ready 不等于开工，不得用 `reassign` 绕开 R6）。

2. **子代理模型授权守卫（`subagent-model-authorization.ts` + 客户端增强卡片）**
   - 修补 DSH 默认允许省略 `provider`/`model` 静默继承主模型绕过白名单的缺口：记录了白名单的会话调用 `subagent` 时必须成对显式传入合法 `{ provider, model }`（连 PTC `run_code` 内通过 SDK 发起的调用一并拦截）；调用 `subagent_fork` 等继承类工具时则校验父会话当前实际路由是否在白名单内（或对当前主模型显式开启了允许同路由 `subagent_fork` 自继承）。
   - 客户端在插件设置页提供支持「全局默认 + 按主代理模型分别绑定白名单与 `subagent_fork` 自继承开关」的增强子代理设置卡，并在运行时重写误导性英文工具描述、在 `list_subagent_models` 输出末尾直接附加拆解好的 `{ provider, model }` 列表。

3. **前缀缓存零漂移守卫群**
   - `plan-mode-cache-guard.ts`：摘除 `exit_plan_mode` 的动态 `when` 准入并将计划模式提示词改为进入时作为尾部用户消息一次性投递，避免进出计划模式重刷整个系统前缀与工具表。
   - `ptc-sdk-cache-guard.ts`：冻结前缀敏感线路在 PTC 模式下的 `tools:sdk` 声明段。
   - Code Mode 的说明段本身是**恒定文本**（`src/host/codemode/rules.ts` 的 `buildCodemodeSectionText`：不含遮蔽计数、不含 namespace 清单），所以挂载或卸载 MCP 服务端不会改写系统提示；请求面只剩「本预设工具 + `code_run`」，`toolsHash` 也不再随 MCP 变动。
   - `tool-result-pruner-guard.ts` & `entry-tool-result-pruner.ts`：在 `kimi-code` 与 `minimax-code` 上默认跳过历史工具结果中部修剪（改写历史工具结果会导致后续数十万 token 前缀缓存全部失效重建，得不偿失）。
   - `compaction-route/`：在 `llm/stream` 瀑布层识别 `purpose: 'compaction'` 请求，支持把上下文摘要改派给更轻量/便宜的模型，具备视频安全回退、图片占位替换与完整摘要缓冲保护。
   - 与内置 Agent Teams 的交叉点：`tools:sdk` 冻结取**未过滤**定义（`when` 门控的工具也在内），故 `team_task_*` 在 Kimi/MiniMax 的 SDK 中常驻可见——可见不等于可调用，判断可调用性要看调用结果；开关切换本身会让 `team:policy` 段从空串变成文本、改写 system prompt 一次，属于计划模式那类重建，但这段文本由 harness 拥有。
   - `team-policy-cache-guard.ts`（默认开启，`teamPolicyCacheGuard`）：把上面那处重建也压平——装配时摘掉 `team:policy` 段并捕获它当时的正文，开关打开后在 `agent/pre-step` 以尾部用户消息投递一次，关闭时补一条撤销通知；投递的是官方当次原文，不落本包副本，harness 改措辞不会过期。

---

## 5. 客户端扩展与三语国际化（i18n）

客户端入口 `src/client/index.tsx` 挂载以下界面能力：

- **订阅服务总览中心（`settings.section: subscription-hub`）**：聚合全部 13 条线路的状态开关、账号池管理、模型勾选、上下文窗口覆盖、思考档位、缓存诊断，以及一键 npm 版本检查与升级（自动识别并保护 `link:` 本地开发目录不被覆盖）。
- **输入框额度胶囊（`conversation.input.right`）**：按当前会话选中的模型自动展示对应线路最紧迫窗口的剩余额度或余额。
- **多媒体工具视图与命令**：`codex_image_generate`、`antigravity_image_generate` 生图预览卡，`minimax_generate_video` 视频卡片、右侧栏文档预览器及 `/video` 斜杠命令参数表单。
- **进展更新面板**与 **Mermaid 图表观察器**（自动将代码块安全渲染为交互图表）。
- **全栈三语国际化（`zh` / `en` / `ru`）**：
  - 客户端共 15 个强类型 `LocaleNamespaceMap` 命名空间；
  - 客户端通过 `installHostLocaleMirror` 将当前激活语言同步至宿主 `POST /api/dsh-chatgpt-subscription/i18n/locale`，使宿主侧的 `providerInfo()` 显示名、号池报错、登录引导与限流文案同步支持中文、英文与俄文（`en.ts` 与 `ru.ts` 由 TypeScript 编译期强制对齐 `zh.ts` 的全部键集合）。

---

## 6. 跨代际 DSH Harness 兼容策略

**单一代码库同时兼容 `@deepseek-ai/dsh*` 从 `0.1.2-alpha.5` 到 `0.2.2-rc.2` 的全部代际**（详见 `package.json` 的 `peerDependencies`）。核心兼容边界包括：

1. **消息与工具结果模型（0.1.7 分界）**：`<= 0.1.6` 将工具结果放在 user 消息的 `tool-result` 内容块中；`>= 0.1.7` 改为独立 `role: 'tool'` 消息（且 `toolCallId` 可能位于顶层、`source.callId` 或内部块上）。所有适配器统一经 `llm-compat` 归一化，严禁假设单一形态。
2. **偏好设置持久化（0.1.7 分界）**：`<= 0.1.6` 使用 `settings.register`；`>= 0.1.7` 改用插件自持 `<dshHome>/storages/*` 原子 JSON 存储并在首次启动时无感迁移旧配置。
3. **Agent Preset 分发（0.1.6 / 0.1.7 分界）**：`>= 0.1.7` 通过 `@deepseek-ai/dsh-agent-preset` 的 `agentPresets.register()` 运行时注册；`<= 0.1.6` 同步至 `<dshHome>/.agent-presets/` 并按运行环境自动探测重写 `@deepseek-ai/dsh-workflow-worker-thread` 与 `@deepseek-ai/dsh-workflow-ptc`。
4. **子代理配置拆分（0.2.1-rc.1 分界）**：`modelSelectionSettings` 拆分为 `modelSelection` + `modelDiscovery`，预设与守卫运行时动态探测工具参数定义以保持双向兼容；0.2.2 无 Session allowlist 时官方仍可能把显式选择限为父路由，提示词不得再称其为完全不受限。
5. **客户端远程文件与图片解析**：同时兼容 `uiConversation.imageUrl` / `conversation.resolveImage`，以及 `workspaceFiles.readBytes(id, path, {})` / `workspaceFiles.readAll`。
6. **PTC executor 拆分（0.2.2 分界）**：`resolveDispatchPreset` 探测到 `@deepseek-ai/dsh-tool-executor-ptc` 时直接挂载官方 executor；旧代保留 `@deepseek-ai/dsh-agent-tool-presentation` 的 `{ mode: 'ptc' }` 兼容行。

> 涉及跨代际兼容接缝的修改前，请先阅读仓库内 `.dsh/skills/dsh-harness-upgrade/SKILL.md`；新增供应线路前，请遵循 `.dsh/skills/add-subscription-line/SKILL.md` 的冻结契约与检查清单。

---

## 7. 开发、验证与发版流程

### 常用命令

```sh
# 1. 类型检查（覆盖 host / client / test / scripts）
npm run typecheck

# 升级 harness 或改动共享类型后，务必使用 --force 绕过增量 tsbuildinfo 缓存做全量重编检查：
npx tsc -b --force && npx tsc -p test/tsconfig.json --noEmit && npx tsc -p scripts/tsconfig.json --noEmit

# 2. 运行全量离线测试套件（Vitest）
npm test

# 3. 构建 ESM 宿主产物与浏览器 CJS bundle
npm run build

# 4. 校验 npm 发布包内容清单与体积
npm pack --dry-run
```

### 测试与构建注意事项

- **离线可重复测试**：所有单元测试（`test/*.test.ts`）均基于本地 mock 与脱敏真实 fixture，绝不依赖真实账号凭据或公网连接；浏览器 DOM 测试在文件顶部声明 `// @vitest-environment jsdom`。
- **并发与超时配置**：`vitest.config.ts` 将 `maxWorkers` 设为 `4`、`testTimeout` 设为 `60s`，因为 Windows DPAPI 存储用例会真实拉起 `powershell.exe` 子进程，盲目调高并发或压低超时会导致跨用例假阳性失败。
- **严禁 UTF-8 BOM**：`test/package-integrity.test.ts` 会扫描 `package.json`、源码与核心文档，确保不含 UTF-8 BOM 字节头，且校验 `devDependencies` 中的 `@deepseek-ai/*` 版本落在 `peerDependencies` 声明范围内。
- **发版前清理陈旧产物**：`tsc -b` 与 `tsdown` 默认增量输出到 `lib/`，已删除源码遗留的 `.d.ts` 可能会残留在 `lib/` 中。正式发布前请遵循 `.dsh/skills/release-plugin/SKILL.md` 执行干净构建核对，严禁对可能含目录联接（junction/symlink）的树执行盲目递归删除。
