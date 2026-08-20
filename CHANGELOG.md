# Changelog

## Unreleased

- 设置页新增内置子代理模型与思考深度选择，新启动的 spawn/fork 子代理可统一路由到指定的 ChatGPT 订阅模型和 reasoning effort；可选深度随模型能力联动。
- 设置页新增 GPT-5.6 Sol / Terra / Luna 有效上下文窗口配置：默认 272K，可选最高 1M，并动态影响 DSH 的模型解析、压缩阈值与溢出判断。

## 0.1.12 - 2026-08-20

- 适配 DSH `0.1.0-rc.8`：peerDependencies / devDependencies 中全部 DSH 包范围从 `^0.1.0-rc.6` 提升至 `^0.1.0-rc.8`，并重新生成 package-lock.json。已在本机 rc.8 依赖集上验证：typecheck、55 项测试与 tsdown 构建全部通过，插件代码无需改动。
- 移除已无引用的 `@deepseek-ai/dsh-agent` peer 依赖（子代理报告去重兼容模块已于 0.1.11 移除）。
- 新增 `@deepseek-ai/dsh-client-connection` peer 依赖（客户端 `ContentBlock` 类型来源，符合 rc.8 客户端包 peer 声明惯例）。
- 说明：rc.8 中 `@deepseek-ai/dsh-client-ui-slots` 不再是 DSH 运行时依赖图成员（仅保留为各客户端包的 devDependency），插件继续将其声明为 peer 依赖以保证安装时解析（`^0.1.0-rc.6` 联网安装时解析到 rc.8；本地锁文件因离线环境暂固定 rc.7，API 与 rc.8 用法一致）。

