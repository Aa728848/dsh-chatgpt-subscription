# Changelog

## Unreleased

（暂无内容）

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
