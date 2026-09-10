# Changelog

## 0.2.14 - 2026-09-10

- 移除失效的「子代理最大嵌套深度 / 子代理上下文预算」设置：这两个偏好键在 DSH 侧没有任何消费方（全仓库无引用），插件自身也只有写、没有读，保存了也不生效。它们源于 2026-08-28 的 `5b08e2e`——那次提交迁移到 DSH 原生子代理模型路由，删除了 `subagent-context-adapter` / `subagent-policy` / `SubagentSettingsSection`，但把这两个控件和偏好键留了下来。相关 DTO 字段、schema、路由校验、界面控件、6 条未引用文案与失效单测一并移除；子代理模型与思考深度改用 DSH 自身的“Subagent”设置卡片，最大嵌套深度由 preset 中 `tool-subagent` 的 `maxDepth` 决定，README 同步更正。

## 0.2.13 - 2026-09-10

- 回退 Codex 与 Antigravity 模型上新增的 `systemPromptUpdate: 'in-history'` 声明：Responses 线路把系统提示词放在顶层 `instructions`，Antigravity 把它放在固定的 `systemInstruction` 加一条 user turn，两条路由都无法把"历史中最后一条 system 消息"当作完整系统提示词。声明该能力会让 DSH 在提示词变化时改为追加 system 节点并保留旧节点，而两个 mapper 会把新旧提示词一并发出。Codex mapper 同时改为只取最新一条非空 system 消息，避免将来重新声明时再次拼接过期提示词。
- 移除 `src/compat.ts` 对 `@deepseek-ai/dsh-llm` 的 `ContentBlockMap.file` / `LlmResolvedModelInfo.systemPromptUpdate` 模块增强：本地 DSH（`packages/llm/llm`，0.1.5-rc.1）已经声明 `'file': FileBlock`，与增强中的 `Record<string, unknown>` 冲突（TS2717），对着本地依赖编译会直接失败。
- 移除两个 mapper 中不可达的 `file` 内容块处理：DSH 内核在进入适配器之前已把文件块投影为 `fileHandleText`（`dsh-llm` 的 `projectFilesToText`），适配器永远收不到 `file` 块；原实现读取的 `byteSize` / `savedPath` 在真实 `FileAttachmentRef` 中也不存在（真实字段是 `bytes`）。
- 移除只完成一半的「智能体团队混合模型规则」（`teamModelRules`）：该功能当时只有偏好存储、路由白名单校验、匹配函数和 64 条中英文案，没有任何地方据此选择子代理模型（DSH 内核对子代理模型走 `subagent/model-selection-policy`），因此连同 DTO、schema、路由处理、单测与未引用文案一并移除，等 DSH 提供介入点后再实现。
- 修复 Antigravity 新账号开通在全部端点失败时静默返回成功：`onboardUser` 现在会在候选端点循环结束后抛出最后一次失败，而不是让调用方误以为已开通。
- 修复登出竞态：`clearCachedQuota()` 增加 epoch 标记，登出时仍在途的配额请求不再回写 `cachedQuota`，也不再为已登出账号写入模型目录；in-flight 槽位改为按持有者清理，避免"清理后重新拉取"丢失新的在途请求。
- `/antigravity/api/status` 改用导出的 `ANTIGRAVITY_QUOTA_CACHE_TTL_MS`，不再内联 120000。
- 移除 Antigravity 设置页与输入框配额胶囊里重复的 `POST /quota`：Host 在 `/status` 中已经会刷新过期缓存，客户端再发一次会让单次挂载产生 2–4 次上游配额请求；配额空态改为明确提示（新增 `quotaEmpty` / `googleValidation` 文案，不再硬编码中文）。
- `parseEnvProxy` 新增 `envFile` 注入点：`$DSH_HOME/.env` 兜底代理探测现在有测试覆盖（含 `export` 前缀、引号、注释、空值、环境变量优先），既有"无代理返回 null"的断言也不再依赖运行机器上是否真的存在 `~/.dsh/.env`。
- Antigravity User-Agent 恢复按真实平台填写 `os_type` / `arch`（仍可用 `DSH_ANTIGRAVITY_OS` / `DSH_ANTIGRAVITY_ARCH` 覆盖），不再默认冒充 darwin/arm64。
- 移除未被引用的 `SANDBOX_ENDPOINT` 并修正端点注释；DSH 依赖区间末项由 `^0.1.5` 改为 `^0.1.5-rc.1`（`^0.1.5` 不匹配本地实际依赖 0.1.5-rc.1），并同步了长期滞后的 `package-lock.json` 根信息。

## 0.2.12 - 2026-09-10

- Antigravity 登录与开通：对齐官方 2.8.0 User-Agent 格式并支持环境变量覆盖，新增 `loadCodeAssist` 详情解析、免费层资格校验与 Google 账号安全验证链接提取，以及新账号的 `onboardUser` LRO 轮询开通。
- Antigravity 配额：`/status` 按 2 分钟 TTL 自动拉取配额，`/quota` 支持强制刷新并在并发调用间去重；Web 设置页与输入框配额胶囊自动获取配额，不再需要手动刷新。
- 代理：`auto` 模式在进程环境之外新增 `$DSH_HOME/.env` 兜底探测。
- 依赖：`@deepseek-ai/*` peer/dev 版本区间扩展到 `^0.1.3` / `^0.1.4` / `^0.1.5`。

## 0.2.10 - 2026-09-06

- 修复 Antigravity 模型元数据校验失败导致 Provider 整体消失的问题：在 `resolveModel` 中清洗并安全兜底 `defaultEffort`，确保透传给 DSH 内核的 `defaultEffort` 必定存在于当前模型的 `efforts` 清单内；解决 `gemini-3.1-pro` 等模型（仅支持 `low` / `high`）因默认回退 `medium` 触发 `@deepseek-ai/dsh-llm` 的 `INVALID_MODEL_REASONING` 校验异常导致 Provider 从模型选择列表中消失的问题（Issue #4）。

## 0.2.9 - 2026-09-06

- 修复在官方 DSH 0.1.2-rc.1 / dsh-llm 0.1.2-rc.1 上加载失败问题：移除 Antigravity 模块中对 `CallId` 的静态具名导入，统一采用 `toToolCallId` 兼容垫片，动态兼容 `ToolCallId` 与 `CallId`；解决启动（boot）阶段因缺失 `CallId` 导出抛出 SyntaxError 导致插件整树无法加载的问题（Issue #4）。
- 修复搜索与抓取来源切换未生效：正确更新 Loader 配置，并在 DSH web 服务重载时重新注册后端、保留默认来源；解决启用插件抓取后仍由 DSH 内置 fetch 拦截 TUN/Fake-IP 地址的问题。
- 修复 Antigravity 工具调用：原样回传 Google 工具 ID，兼容旧会话保存的原始 ID；转换工具参数 Schema，过滤 `propertyNames` 等不支持字段并处理嵌套结构。
- 修复 Gemini 3.7 / 3.8 的旧 `off` / `none` 思考配置，使用最低支持档位 `LOW` 并关闭思考摘要；400 请求错误直接保留原始详情，不再被模型降级错误覆盖。
- Codex 订阅供应商新增 `gpt-6-astra`（6 Astra），支持文本、图片、工具调用和 `low` 至 `max` 思考档位，默认 `medium`；旧会话的 `none` / `minimal` 转为 `low`。
- 新增 Astra 上下文设置：默认 272K，订阅侧最高 872K，界面与服务端统一校验；保留已有模型选择与上下文配置。

## 0.1.28 - 2026-08-28

- 新增支持 1.5x 倍速快速模式（Fast Mode / Priority Service Tier）：在设置页「增强功能」中提供开关，开启后向 Codex 后端请求自动注入 `service_tier: 'priority'`，以约 2x–2.5x 额度消耗换取约 1.5 倍的 Token 生成速度。
- 修复偏好设置更新白名单校验，支持持久化保存 `fastMode` 配置。

## 0.1.21 - 2026-08-22

- 修复 DSH 更新到 `0.1.1-rc.2` 后“本轮运行失败：registration.adapter.prepareCall is not a function”：新代理循环经 `ctx.llm.prepareCall()` 冻结每次调用，适配器必须实现 `prepareCall`；CodexChatGptAdapter 现显式绑定同一次解析的模型元数据与流分发（`PreparedAdapterCall`）。
- 将全部 `@deepseek-ai/*` peerDependencies 与 devDependencies 版本统一从 `^0.1.1-rc.1` 提升至 `^0.1.1-rc.2`，并重新生成 package-lock.json。
- 增强文件完整性与编码防御：确保 `package.json` 及全部工程文件均为无 BOM 的 UTF-8 编码，新增 `test/package-integrity.test.ts` 自动化防范 UTF-8 BOM 引入与依赖一致性。已在本机 rc.2 依赖集上验证：typecheck、69 项测试与 tsdown 构建全部通过。

## 0.1.20 - 2026-08-22

- 新增独立的“子代理”设置页；模型、思考深度和上下文预算改为所有 DSH 内置子代理的全局设置，不再要求父 Agent 使用 Codex 模型。
- 新增全局 0–3 最大嵌套深度和每个父 Agent 子树的活动子代理数量上限；新委派即时受限，现有运行不被中断。
- 子代理设置扩展为 DSH 全部已接入 Provider/模型；思考深度使用所选模型的真实 reasoning effort 目录，上下文在选定模型后展开并作为子 Agent 的有效压缩预算。
- 设置页新增 GPT-5.6 Sol / Terra / Luna 有效上下文窗口配置：默认 272K，可选最高 1M，并动态影响 DSH 的模型解析、压缩阈值与溢出判断。

## 0.1.12 - 2026-08-20

- 适配 DSH `0.1.0-rc.8`：peerDependencies / devDependencies 中全部 DSH 包范围从 `^0.1.0-rc.6` 提升至 `^0.1.0-rc.8`，并重新生成 package-lock.json。已在本机 rc.8 依赖集上验证：typecheck、55 项测试与 tsdown 构建全部通过，插件代码无需改动。
- 移除已无引用的 `@deepseek-ai/dsh-agent` peer 依赖（子代理报告去重兼容模块已于 0.1.11 移除）。
- 新增 `@deepseek-ai/dsh-client-connection` peer 依赖（客户端 `ContentBlock` 类型来源，符合 rc.8 客户端包 peer 声明惯例）。
- 说明：rc.8 中 `@deepseek-ai/dsh-client-ui-slots` 不再是 DSH 运行时依赖图成员（仅保留为各客户端包的 devDependency），插件继续将其声明为 peer 依赖以保证安装时解析（`^0.1.0-rc.6` 联网安装时解析到 rc.8；本地锁文件因离线环境暂固定 rc.7，API 与 rc.8 用法一致）。
