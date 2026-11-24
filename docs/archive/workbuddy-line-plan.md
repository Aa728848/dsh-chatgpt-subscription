# WorkBuddy（CodeBuddy 订阅）线路恢复计划与证据

> 状态：实现完成，进入全量与 live 分层验收。历史删除提交为 `2d125f40`，恢复来源为 `2d125f40^`。当前工作基于 master `481633f`。
> 原则：restore-then-adapt，不整笔 revert；保留旧协议难点，改接当前共享内核。其它线路不改行为，共享注册点只追加。

## 1. 已确认范围

- Provider/route 仍为 `workbuddy-subscription` 与 `/workbuddy/api/*`，旧 DPAPI / Keychain / Secret Service 路径与既有账号数据不变。
- 完整恢复双区、浏览器 OAuth、桌面登录态采纳、自管账号池、模型目录与快照、配额/credits、签到、护栏、设置 UI、composer、文档、探针和测试。
- 纳入国内 Claude Anthropic Messages；不新增 ck_/pt_ 静态 API Key。
- 首个 11140 停用账号；30 分钟内第二个不同账号也受限时整池暂停 30 分钟。暂停只阻止新的模型轮换，不阻止状态/配额辅助读取。
- live 由用户明确授权：每个已有区域至多 1 次目录和 1 次普通聊天，国内 Claude 至多 1 次 Messages 聊天；11128 只允许既定的一次搬移重试，总上游请求最多 8 次，不运行签到或其它状态修改。

## 2. 上游证据

| 事实 | 证据 |
| --- | --- |
| 桌面 5.9.3 / CLI 2.165.0、X-Agent/X-Stainless、10085 | `magpie-community/plugins@1e7122e1` `packages/workbuddy/index.mjs` L63-109、L344-380 |
| systemAsUser、被拒提示记忆与一次重试 | 同文件 L782-840、L916-977、L2641-2649；`systemasuser.test.mjs` |
| 国区 Claude Messages、signed/unsigned thinking、effort | 同文件 L132-157 及 `README.md` L89-123 |
| 11140 账号限制 | 同文件 L2770-2780；`workbuddy2api-hub@1ea7f61e` `wb_proxy.py` L14253-14333 |
| 会话头与官方客户端身份 | `workbuddy2api-hub@1ea7f61e` `wb_identity.py` L1-90 |
| 历史 at-rest、目录、6004、出站身份 | `2d125f40^:docs/workbuddy-upstream-hardening.md` 及旧 WorkBuddy 源码/测试 |

这些是非官方逆向证据，不是官方稳定 API 承诺。静态常量都带 source URL/commit；未验证项不伪装成实测。

## 3. 实施波次

1. **契约冻结**：恢复 shared contracts、types、catalog、token-store/at-rest/identity/guardrails/outbound；线路私有 modelCooldown/restriction/pool state，复用共享 PoolStorageDto；Messages 路由函数统一为 `workBuddyModelRoute`。
2. **账号与协议**：AccountPoolCore 当前存储接线；11140/暂停写入同一 pool 文档；11128 systemAsUser；401 单双路径一次续期重放；Chat 与国内 Claude Messages 映射。
3. **客户端**：共享 AccountPoolSection / ModelChecklist / ContextWindowEditor / ComposerQuotaBadge / useLineDict；中英俄字典、整池/限制/模型冷却显示。
4. **注册**：host adapter/store/pool/checkin/routes、hub、widget board、CONTROLLED_PROVIDERS、诊断、能力证据、client locale/style/composer order 47，全部末尾追加。
5. **文档与验收**：恢复 7 个探针和本文件；类型检查、focused/full tests、build、pack、运行中路由检查及最小 live。

## 4. 关键修正（不是简单恢复）

- `modelFetch` 使用 `workbuddy-subscription`，不恢复旧短名 `workbuddy`，避免运行时 undefined。
- 旧默认 `cli` 迁移到 `workbuddy`，schema marker 默认旧版本；File 与 register 两种设置后端共用幂等迁移并各有测试。
- Messages 后续只有 output_tokens 的帧不重复扣缓存；uncached input 与 cache read/write 分开。
- 401 按 accountId 重读同账号凭证，成功续期后 continue 重放；增加 FileCredentialStore.renew 以支持未过期但被拒的 token。
- 11140 接口返回 Promise 且 Adapter await 后才轮换；11128/11158 不得写入账号限制。
- pool pause/composer 在 quota 缺失时仍显示暂停，而不是普通 unknown。

## 5. 验证记录

- 恢复前基线：typecheck 0；全量 **5166 passed / 9 skipped / 0 failed**。
- Wave 1：77 focused tests；Wave 2A：79；Wave 2B：147；Wave 2C：102；routes：68；注册相关：119；恢复的历史用例全部加入。
- 强制三工程 typecheck 0；全量 **5587 passed / 9 skipped / 0 failed**（较基线新增 421 条）；`npm run build`、`npm ci --dry-run` 通过；`npm pack --dry-run --ignore-scripts --json` 为 832 个文件，含完整 WorkBuddy 声明与两份 bundle 标记。
- 用户选择不重启当前 Host，因此运行中 GUI 仍是旧 bundle，`/workbuddy/api/status` 未接入前状态已核实为 404；**live probe 未执行**。11140 不主动诱发。

## 6. 风险 / 未验证

- 上游 WAF 和风控会持续变化，systemAsUser 与身份常量只能代表所引 commit 时的解决办法，不保证永久有效。
- at-rest 加密封装仍主要是 workbuddy2api-hub 的转写证据；没有拿真实 sealed `.info` 做独立二进制一致性验证。
- 目录 fallback 是历史实测表，实时目录仍须以 `/v3/config` 为准；冷启动白名单不过滤 fallback。
- 显式选择 `cli` 仍被保留，但当前上游会以 10085 拒绝；这是用户选择而不是默认推荐。
- 11140 不主动测试，live 只验证正常调用与 11128 的自然结果；暂停策略由离线持久化测试证明。
