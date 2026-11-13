# 项目文档导航（Documentation Index）

欢迎查阅 `@eddyskywalker/dsh-chatgpt-subscription` 文档库。本目录收录了面向普通用户、部署运维人员与代码贡献者的系统化手册，以及各模块在演进过程中的设计规范与协议审计档案。

---

## 一、核心参考手册（推荐优先阅读）

| 文档 | 适用读者 | 核心内容 |
| --- | --- | --- |
| [根 README.md](../README.md) | 所有用户 | 项目简介、13 条供应线路矩阵、核心特性、快速安装与上手指南 |
| [供应线路完整指南（providers.md）](providers.md) | 所有用户 / 运维 | 全部 13 条线路的登录鉴权、本机 CLI 收编规则、模型能力、缓存与额度机制、验证边界及完整 HTTP 路由表 |
| [部署配置与安全参考（configuration.md）](configuration.md) | 运维 / 高级用户 | `cordis.patch.yml` 全量配置项、`poolStorage`（桌面密钥环 vs 无头服务器凭据库）、共享网络代理与 `web_fetch`、全量环境变量及安全不变量 |
| [架构设计与开发指南（architecture.md）](architecture.md) | 贡献者 / 维护者 | 目录与多组件导出结构、`volatile` 设置接线、共享号池内核、Agent 编排与前缀缓存守卫、跨代际 DSH 兼容策略与测试发版规范 |
| [故障排查手册（troubleshooting.md）](troubleshooting.md) | 所有用户 / 运维 | 登录回调/钥匙环报错、路由冲突、401/403/429/5xx 分类、上下文压缩与图片预算、`fake-ip` 代理抓网页、子代理白名单与调度模式排障 |

---

## 二、随包预设与独立专题参考

| 文档 | 说明 |
| --- | --- |
| [调度模式预设说明（`presets/dispatch/README.md`）](../presets/dispatch/README.md) | `dispatch` Agent Preset 的分诊（`R0`）、澄清访谈（`R-G`）、计划模式管线（`R9`）、执行拓扑（`R1`）、Mandate v2 账本协议（`dispatch_ledger`）与前缀缓存预算设计 |
| [Kimi Code 缓存预热与结果引用（cache-warmup.md）](cache-warmup.md) | `src/host/cache-warmup/` 子包的缓存安全不变量、大结果 `ref://` 投影规则、双轨稳态预算与 `cache_warmup_result` 分页补读设计 |
| [运行时控制与设计取舍（provider-runtime-controls.md）](provider-runtime-controls.md) | `DSH_PROVIDER_CONCURRENCY` 并发闸门、`DSH_PROVIDER_DIAGNOSTICS` 安全诊断日志、`DSH_COMMAND_CODE_ZDR` 隐私头及明确不采纳的特性边界决策 |
| [多线路与官方 Agent 能力对照审计（provider-agent-parity-audit.md）](provider-agent-parity-audit.md) | 各供应线路对照官方 CLI / Agent 的协议、缓存断点、思考参数与图片预算一致性审计记录 |
| [协议测试矩阵（provider-protocol-test-matrix.md）](provider-protocol-test-matrix.md) | 跨线路协议映射、流式解析、错误分类与重试策略的离线测试覆盖矩阵 |

---

## 三、架构演进与各线路工程档案（内部设计 / 探针记录）

以下文件为特定功能研发、上游网关活体探测（probe）或线路移植时的原始工程档案，供维护者溯源协议证据与历史决策使用（当前生效的产品行为请以第一节的核心手册为准）：

### 通用架构与 UI 设计档案
- [多账号号池设计稿（design-multi-account-pool.md）](design-multi-account-pool.md)
- [单账号精细额度设计（per-account-quota.md）](per-account-quota.md)
- [订阅服务设置中心重构（settings-hub-redesign.md）](settings-hub-redesign.md)
- [线路 Agent 性能优化方案（plan-provider-agent-optimizations.md）](plan-provider-agent-optimizations.md)
- [Antigravity（ACP）线路计划与证据（antigravity-acp-line-plan.md）](antigravity-acp-line-plan.md)
- [Antigravity / Claude 缓存审计（antigravity-claude-cache-audit.md）](antigravity-claude-cache-audit.md)
- [Code Mode `code_run` 报错审计（codemode-code-run-error-audit.md）](codemode-code-run-error-audit.md)

### 各供应线路接入方案与上游探测档案
- **Kimi Code**：[差距分析](kimi-code-gap-analysis.md) · [缓存与工具差距](kimi-code-cache-tools-gap.md) · [改造方案](kimi-code-change-plan.md)
- **MiniMax Code（模型与网关）**：[差距方案](minimax-code-gap-plan.md) · [上游差异 v1](minimax-code-upstream-delta.md) · [上游差异 v2](minimax-code-upstream-delta-v2.md) · [能力探针报告](minimax-code-probe-capabilities.md) · [Matrix 网关探针](minimax-matrix-gateway-probe.md) · [Files API 交接](minimax-files-api-handoff.md) · [云端能力调研](minimax-cloud-capabilities-survey.md) · [媒体与云端综述](minimax-media-and-cloud-summary.md)
- **MiniMax Code（视频工作流系列）**：[可行性](minimax-video-tools-feasibility.md) · [播放可行性](minimax-video-playback-feasibility.md) · [设计规范](minimax-video-design-spec.md) · [扩展规范](minimax-video-extended-spec.md) · [实现说明](minimax-video-implementation.md) · [模型规则](minimax-video-model-rules.md) · [事实清单](minimax-video-facts.md) · [保真度核查](minimax-video-fidelity.md) · [生成探针](minimax-video-generation-probe.md) · [上传探针](minimax-video-upload-probe.md) · [零成本校验](minimax-video-free-checks.md) · [验收记录](minimax-video-verification.md)
- **GLM Coding Plan**：[ZCode 线路方案（glm-zcode-line-plan.md）](glm-zcode-line-plan.md)
- **Step Code**：[Step Plan 线路方案（step-code-line-plan.md）](step-code-line-plan.md)
- **Cline Pass**：[Cline Pass 线路方案（cline-pass-line-plan.md）](cline-pass-line-plan.md)
- **Qoder**：[Qoder 线路方案（qoder-line-plan.md）](qoder-line-plan.md)
- **OpenDesign**：[OpenDesign 线路方案（opendesign-line-plan.md）](opendesign-line-plan.md)
- **WorkBuddy**：[WorkBuddy 线路方案](workbuddy-line-plan.md) · [上游风控加固记录](workbuddy-upstream-hardening.md)
