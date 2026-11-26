<div align="center">

# DSH Subscription Hub

**面向 DeepSeek Harness 的多平台订阅接入与运行时增强插件。**

[![npm version](https://img.shields.io/npm/v/@eddyskywalker/dsh-chatgpt-subscription?style=flat&label=version)](https://www.npmjs.com/package/@eddyskywalker/dsh-chatgpt-subscription)
[![npm downloads](https://img.shields.io/npm/dm/@eddyskywalker/dsh-chatgpt-subscription?style=flat&label=downloads)](https://www.npmjs.com/package/@eddyskywalker/dsh-chatgpt-subscription)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat)](LICENSE)

</div>

## 支持线路

在 **设置 → 订阅服务** 中统一管理以下线路的启停、账号池、模型勾选与网络代理：

| 线路 | Provider ID | 登录方式 |
| --- | --- | --- |
| ChatGPT / Codex | `codex-chatgpt` | 浏览器登录 / 设备码 / 导入 Codex CLI、CPA / sub2api 文件 |
| Claude 订阅 | `claude-subscription` | 浏览器授权 / 导入 Claude Code |
| Claude API | `claude-api` | API Key |
| Kimi Code | `kimi-code` | 设备码授权 / API Key |
| MiniMax Code | `minimax-code` | 设备码授权 / 复用桌面端登录 |
| GLM Coding Plan | `glm-coding-plan` | 浏览器授权 / 导入 ZCode |
| Step Code | `step-code` | 浏览器授权 / API Key / 导入 StepCode |
| Command Code | `command-code` | 浏览器授权 / API Key |
| Cline Pass | `cline-pass` | 设备码授权 / API Key |
| Qoder | `qoder` | 浏览器授权 / PAT / 导入 Qoder CLI |
| OpenDesign | `opendesign` | 浏览器授权 / API Key |
| WorkBuddy | `workbuddy-subscription` | 浏览器授权 / 复用桌面端登录 |
| Qwen Token Plan | `qianwen-token-plan` | API Key |
| RelayOne | `relayone` | API Key |
| Ollama Cloud | `ollama` | API Key |
| Google Antigravity | `antigravity-acp` | 复用本机官方 `agy` 登录态 |
| AWS Quick | `aws-quick` | 复用本机 Quick Desktop 登录态 |
| OpenCode Go | `opencode-go` | OpenCode Console API Key |

> 部分订阅线路与非公开接口（如 `claude-subscription`、`antigravity-acp`、`aws-quick`、`workbuddy-subscription`、`qoder`）可能涉及第三方服务条款限制或上游协议变更，详见[供应线路指南](docs/providers.md)。

## 主要能力

- **多账号池与独立代理**：支持顺序耗尽、轮流、固定当前三种轮换策略，遇到限流自动冷却切换；每条线路可单独配置系统代理、自定义代理或直连。
- **跨平台凭据存储**：默认使用系统加密密钥环（Windows DPAPI / macOS Keychain / Linux Secret Service），无桌面环境的服务器可切换为 DSH 凭据库。
- **扩展工具与界面**：内置生图/视频工具、进展更新面板、Mermaid 图表渲染、额度看板卡片，以及随包提供的 `dispatch` 调度预设。
- **三语支持**：设置页与宿主提示完整支持简体中文、English、Русский。

## 安装

需要 Node.js ≥ 22.19 与 `@deepseek-ai/dsh` `0.1.2-alpha.5` – `0.2.2-rc.3`。

```sh
dsh plugin --profile web add @eddyskywalker/dsh-chatgpt-subscription
```

也可在 DSH Web 侧边栏的 **Plugins** 页面直接搜索并安装 `@eddyskywalker/dsh-chatgpt-subscription`。安装预发布版请追加 `@alpha`。

本地源码调试：

```sh
git clone https://github.com/Aa728848/dsh-chatgpt-subscription.git
cd dsh-chatgpt-subscription
npm install && npm run build
dsh plugin --profile web add "link:/absolute/path/to/dsh-chatgpt-subscription"
```

## 快速开始

1. 启动或重启 `dsh web`，进入 **设置 → 订阅服务**。
2. 选择需要使用的线路，完成登录、导入本机登录或粘贴 API Key（无桌面 Linux 服务器请先将账号存储位置切换为 **DSH 凭据库**）。
3. 勾选可用模型并点击 **测试连接**。
4. 返回对话页，在模型选择器中切换使用。

## 文档

| 文档 | 说明 |
| --- | --- |
| [供应线路指南](docs/providers.md) | 各线路登录方式、能力边界、额度机制与合规说明 |
| [配置与安全参考](docs/configuration.md) | `cordis.patch.yml` 配置项、代理、存储后端与环境变量 |
| [架构与开发指南](docs/architecture.md) | 目录结构、开发命令、跨版本兼容与发布流程 |
| [故障排查](docs/troubleshooting.md) | 登录、密钥环、代理、限流与压缩等常见问题 |
| [调度预设说明](presets/dispatch/README.md) | 内置 `dispatch` 编排预设的使用与规则 |
| [更新日志](docs/CHANGELOG.md) | 版本历史 |

## 许可

[MIT](LICENSE)
