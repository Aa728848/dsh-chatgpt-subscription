# Step Code（Step Plan 订阅）线路 · 实施计划

> 状态：**规划完成，待逐波实施**。目标是把 StepFun 的 Step Plan 订阅接入本插件，成为第 9 条（现为第 10 条）订阅线路，功能与既有线路尽量一致。
> 调研来源：官方 Step-Code 源码（本地克隆 `C:\\Users\\A\\Documents\\ChatGPT\\_ref-stepcode`，只读参照）、Step 开放平台公开文档、以及本仓库既有的 glm-coding-plan 线路（作为接缝模板）。
> 铁律：**不干扰其它 9 条线路**；能用共用协议/共用内核的地方复用，不复制、不改既有线路的外部契约。

---

## 1. 线路身份

| 项 | 取值 |
| --- | --- |
| Provider ID | `step-code` |
| 显示名 | `Step Code（Step Plan 订阅）` |
| 路由前缀 | `/step-code/api` |
| 协议面 | **OpenAI Chat Completions**（`{base}/chat/completions`） |
| 登录 | 云端轮询式浏览器授权（**不开本地回调端口**）+ 导入本机 stepcode 登录态 + 手动粘贴 Platform API Key |
| 账号模型 | 多账号号池（复用 `src/host/common/account-pool.ts` 的 `AccountPoolCore`） |
| 额度 | 开发者中心 Dashboard 接口（Oasis-Token），自动登录优先、手动粘贴兜底 |
| 模型目录 | 实时 `GET {base}/models` + 进程内 TTL 缓存 + 磁盘快照，随包目录仅作能力兜底 |

### 端点矩阵（官方源码 `packages/coding-agent/src/step/onboarding.ts:26-79` 与 `docs/step-integration.md:81-86`）

| profile | 凭据 | 模型 base | 授权/开发者中心 | 说明 |
| --- | --- | --- | --- | --- |
| `step_plan` | 浏览器授权 | `https://api.stepfun.com/step_plan` | `https://platform.stepfun.com` | 国区 Step Plan，消耗订阅 Credit |
| `step_plan_oversea` | 浏览器授权 | `https://api.stepfun.ai/step_plan` | `https://platform.stepfun.ai` | 国际区 Step Plan |
| `platform_cn` | API Key | `https://api.stepfun.com/v1` | `https://platform.stepfun.com/interface-key` | 按量计费 |
| `platform_oversea` | API Key | `https://api.stepfun.ai/v1` | `https://platform.stepfun.ai/interface-key` | 按量计费 |

区域由**凭据里记录的 profile** 唯一决定；`api.stepfun.ai` 与 `api.stepfun.com` 互不通用（国际区凭据打国区端点会被拒）。

---

## 2. 登录协议（照抄官方语义，不发明）

云端轮询三步：`init` → 浏览器人工确认 → `poll`。

- `POST {authBase}/api/stdhttp/v1/cli-login/init`
  - 头：`Authorization: Bearer <poll_token>`（64 位 hex，每次登录新生成，**只进 header，绝不进 URL/日志/磁盘**），`content-type: application/json`，`redirect: error`，`credentials: omit`，**不带 cookie**。
  - 体：`{ profile, origin, client: { name, version, platform } }`。
  - 响应：`flow_id`（`^[A-Za-z0-9._-]{1,128}$`，公开标识，可以打印）、`poll_interval_sec`（≥1，客户端 clamp 到 ≤60）、`expires_at`（硬截止）。
  - 业务错误信封：2xx 但 `status` 字段非 0 视为失败，取 `desc` 去控制字符截断 240 字符。
- 授权页 URL **客户端自己拼**：`{authBase}/cli-login-remote?flow_id=<flow_id>`（忽略服务端可能返回的 authorize_url）。
- `GET {authBase}/api/stdhttp/v1/cli-login/poll/{flow_id}`，头同上。
  - `state=pending` 继续；`state=ready` 取 `credential.api_key`（+ 可选 `uid`，长度 ≤64 且 `^[\w.@:-]+$` 否则丢弃）；`state=failed` 只有字面 `denied` 归为「用户拒绝」，其余归为「未知失败」；其它 state 是协议错误。
- 重试策略：`protocol` 错误不重试；`transport` 重试；`http` 仅 `408 / 429 / ≥500` 重试。单请求超时 15s，外层登录总超时默认 10 分钟。
- 凭据形态：`{ type: 'oauth', access: <api_key>, refresh: '<静态哨兵>', expires: Number.MAX_SAFE_INTEGER, profile, uid? }`。
  - **这条线路的凭据不会过期，也没有刷新链**——token store 与号池必须按「静态凭据」处理，不得尝试刷新，也不得因为 `expires` 是 MAX_SAFE_INTEGER 而误判为异常。

### 三种凭据来源（用户已确认全要）

1. **浏览器授权**（主路径）：上面三步，国区/国际区在登录时选。
2. **导入本机 stepcode 登录态**（adopt，只读）：`~/.stepcode/auth.json`（`0600`），兼容旧路径 `~/.stepcode/agent/auth.json`、`~/.stepcode/legacy-auth.json` 与旧形状 `{ apiKey, profile, uid }`。**只看文件是否存在、只在用户显式点导入时读取、绝不写入或删除 stepcode 的任何文件**——与 Claude / Codex / GLM 的 adopt 语义一致。注意这是**快照**，Step 的 api_key 不过期，但用户在 Step 侧撤销后快照即失效。
3. **手动粘贴 Platform API Key**（按量计费）：对应 `platform_cn / platform_oversea` 两个 profile，base 不带 `/step_plan`。

---

## 3. 模型目录与能力

上游 `GET {base}/models`（`{base}` = 归一化后的 route 前缀 + `/v1`）：

- `id` 必填；`model_type` 存在时只保留 `大语言模型` 与 `路由模型`（全部条目都不带该字段时不过滤，向后兼容）；
- `max_input_tokens` → 上下文窗口；`enable_reason` → 思考支持；`enable_vision_input` → 图片输入；`reasoning_effort_support_list` → 思考档位映射（未列出的档位映射为「不支持」，含 `off`）；
- 逐模型详情 `GET {origin}/v1/models/{id}`（**注意是域名根的 `/v1`，`/step_plan/v1/models/{id}` 会 404**），用于补齐档位；
- 端点不报输出上限：`maxTokens` 默认等于上下文窗口；
- 目录完全靠运行时发现，**随包目录只放「能力兜底表」**，不当作权威列表；取不到目录时选择器变宽而不是消失（与 codex 线路同一原则）。

base URL 归一化：循环剥掉尾部 `/v1/messages`、`/messages`、`/v1`（可重复剥离），再统一补 `/v1`；这样 `STEP_BASE_URL` 这类历史写法不会把版本段发两次——**照抄官方 `normalizeStepApiBaseUrl` 的幂等语义**。

---

## 4. 缓存设计（本次重点，用户明确要求参照 stepcode 的模型适配设计）

### 4.1 事实

- Step 服务端是**自动前缀缓存**：前缀 ≥256 token 即可命中，LRU 淘汰，**没有任何缓存参数**，官方文档给出的命中判据是 `usage.cached_tokens > 0`（**顶层字段**）。
- 官方 Step-Code **对 Step 端点不发任何缓存参数**：`prompt_cache_key` 的发出条件硬绑 `baseUrl.includes('api.openai.com')`，会话亲和头由 `compat.sendSessionAffinityHeaders` 控制且对 Step 为 `false`，`cache_control` 只在 Anthropic 格式下发出。所以「官方支持缓存参数」≠「会对 Step 发」。
- `prompt_cache_retention: "24h"` 在官方文档里没有对应说明，属于未文档化字段，默认不能发。
- Step 模型在官方表里 cost 全 0，因此**缓存诊断只剩 token 维度**，没有金额维度。

### 4.2 移植决定

1. **请求侧默认不发任何缓存参数**——与官方一致，也对未文档化字段零风险。按用户选择，做成**可按线路打开的能力位**（默认关），等真实账号实测端点接受度后再决定是否默认打开；能力位打开后发 `prompt_cache_key`（= 会话 id，按码点截断 64 字符）与可选会话亲和头。
2. **响应侧必须解析顶层 `cached_tokens` → `cacheReadTokens`**。
   - ⚠ **这是与现有实现的真实差异，不能想当然**：本仓库的诊断层 (`src/host/common/request-diagnostics.ts:406-414`) 的读侧优先级是 `input_tokens_details.cached_tokens` → `cache_read_input_tokens` → `cache_read_tokens`，**不含顶层 `cached_tokens`**；而 Step 官方文档只展示顶层 `cached_tokens`。因此本线路的 mapper 必须自己做完整解析（含顶层字段），并在 `input` 里扣除 cacheRead/cacheWrite 保证互斥。写侧在这条线路上**恒为 0**，卡片要显式声明 `cacheWriteTokensNote: 'always-zero-on-this-route'`（沿用 kimi 线路的既有做法）。
3. **缓存用量卡片**：token 维度展示缓存读入量、命中率与「本机统计」，**不虚构金额**。
4. **缓存浪费诊断**（missed tokens / 空闲间隔 / 是否换模型）：以本线路内部的 `cache-stats` 语义实现（对比上一轮请求、噪声地板 1024 token、上下文合法变化不计、换模型计入）。**放在本线路内，不去改公共模块**。

---

## 5. 额度卡片

- 数据源（开发者中心，第三方已实现的公开形态）：
  - `POST https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit`
  - `POST .../GetStepPlanStatus`
  - 鉴权：`Cookie: Oasis-Token=<token>; Oasis-Webid=<device_id>` + `oasis-appid / oasis-platform` 头；`Oasis-Webid` 必须与该 token 的 `device_id` claim 一致，否则服务端报「token is embezzled」。
  - 响应同时覆盖两代套餐：老式 5 小时/周窗口（`five_hour_usage_left_rate` / `weekly_usage_left_rate` + reset 时间）与现行 Credit 月池（`plan_family=2` + `plan_credit_rate_limit.{subscription_credit_left_rate, topup_credit_left_rate, credit_buckets[]}`）。**按载荷形状判定，不单信 `plan_family`**。
- 凭据（用户选择「两者都要」）：
  - **优先自动登录**：`GET platform.stepfun.com` 取 `INGRESSCOOKIE` → `POST .../PassportService/RegisterDevice`（匿名 token） → `POST .../SignInByPassword`（账号密码换 Oasis-Token）。
  - **失败时提示手动粘贴** Oasis-Token（从浏览器开发者工具复制）。
  - 凭据仅存本机、**绝不发给前端**；不写日志；与其他线路的凭据隔离存储。
- ⚠ 这是**非公开接口 + 账号密码过手**，属于本线路唯一的合规/稳定性风险点，必须在 README 与设置页明示。额度失败（含上游改版）不得影响模型请求。

---

## 6. 逐文件改动清单

### 6.1 新增（本线路自带，互不干扰）

```
src/shared/step-code-contracts.ts          Provider id/名/路由前缀、区域 profile、额度窗口 DTO、设置 DTO、状态 DTO（凭据一律不跨界）
src/host/step-code/types.ts                线路常量、错误码、档位词汇、路径
src/host/step-code/model-catalog.ts        随包能力兜底表 + 目录归一化 + 档位映射
src/host/step-code/client.ts               上游 I/O：目录 / 额度（devcenter）/ 账号密码换 Token / 连接测试（含 TTL 缓存与 in-flight 去重）
src/host/step-code/oauth.ts                云端轮询登录状态机（init/poll、poll_token、超时与重试）+ 手动粘贴兜底
src/host/step-code/adopt.ts                只读导入 ~/.stepcode/auth.json（含旧路径与旧形状）
src/host/step-code/token-store.ts          凭据存储（DPAPI / Keychain / SecretService，复用既有平台存储层）+ 模型设置 + 偏好注册
src/host/step-code/account-pool.ts         号池薄封装（复用 AccountPoolCore），静态凭据不刷新
src/host/step-code/mapper.ts               OpenAI Chat Completions 请求/流映射（含顶层 cached_tokens 解析、cacheWrite 恒零声明）
src/host/step-code/cache-stats.ts          本线路缓存浪费诊断（tokens / 空闲间隔 / 换模型）
src/host/step-code/adapter.ts              LlmAdapter：listModels / resolveModel / prepareCall / stream / catalog / credentialFor
src/host/step-code/routes.ts               /step-code/api 全套子路由
src/client/step-code/StepCodeSection.tsx   设置卡片（渲染）
src/client/step-code/useStepCodeSection.ts 卡片行为（状态/副作用/动作）
src/client/step-code/StepCodeComposerQuota.tsx 输入框额度胶囊
src/client/step-code/api.ts                路由表声明（与 host 侧手写镜像互锁）
src/client/step-code/locales.ts            zh/en 文案
src/client/step-code/styles.ts             本卡独有样式
test/step-code-*.test.ts(x)                适配器/路由/客户端/映射/契约/UI/缓存/登录 等
```

### 6.2 既有文件的**追加式**注册点（必须改，且只增行、不改既有行为）

| 文件 | 改什么 | 影响面 |
| --- | --- | --- |
| `src/index.ts` | imports、store/号池构造、adapter+claim+routes、hub 汇总条目、dispose、底部 export 段 | 仅新增块，位置在既有线路之间 |
| `src/client/hub/providers.tsx` | 在 `HUB_PROVIDERS` 追加一条 descriptor | 仅新增条目 |
| `src/client/hub/brand-icons.tsx` | `HubProviderId` 联合 + 品牌标记 | 仅新增 |
| `src/client/index.tsx` | import、locale 注册、样式安装、`conversation.input.right` 槽（**order 号顺延，不得重排既有号**） | 仅新增 |
| `src/host/common/model-request-control.ts` | `CONTROLLED_PROVIDERS` 追加 id | 让本线路受并发闸门管辖；对既有线路零行为变化 |
| `src/host/common/request-diagnostics.ts` | `DIAGNOSTIC_PROVIDERS` 追加 id | 让本线路进诊断日志；同上 |
| `README.md` / `CHANGELOG.md` / `docs/provider-protocol-test-matrix.md` | 线路总览表加行、新章节、Unreleased 条目 | 文档 |
| 既有测试里的「线路数量/顺序」断言 | 卡片顺序数组、槽位数组、轮询数组各追加一项 | 这些断言按设计要随线路数更新（glm 线路当初同样处理） |

> ⚠️ **需要你确认的两点**：
> 1. 你选了「每条新线路自带实现，完全不碰公共模块」。上面两个 `common/` 文件属于**框架要求的注册点**（不登记就等于静默失去并发闸门与诊断日志），我按「只追加一个 id、不改任何逻辑」处理。如果你连这个也不接受，请明说——代价是本线路拿不到并发限流与 `[provider-diagnostics]` 日志。
> 2. 既有测试里的数量/顺序断言必须跟着改，否则测试会红。这与「不干扰其它线路」不冲突（不改任何线路的运行行为），但确实动了它们的测试文件。

### 6.3 明确**不改**

`package.json`、`cordis.patch.yml`、`presets/`、`src/compat.ts`、`src/shared/preferences.ts`、`src/client/locales.ts`、`src/host/common/*` 的其它任何一行、既有线路的任何 host/client 实现。

---

## 7. 对既有线路的回归保证

1. 所有新增代码落在 `src/{shared,host,client}/step-code*`，既有线路的目录零改动。
2. 既有文件的改动只有「追加一行/一个块」，且逐条在评审时对照 diff 确认无删除、无重排。
3. 交付前必须全绿：`npm run typecheck`、`npm test`（含既有 200+ 测试文件）、`npm run build`、`npm pack --dry-run`。
4. 单测不得依赖真实凭据或网络；adopt 路径必须在测试里做 home 隔离（照 `test/setup/isolated-home.ts` 的既有做法，为 `~/.stepcode` 加隔离）。

---

## 8. 实施波次（分工与模型路由）

> 路由：`minimax-code/MiniMax-M3.1-Flash-Preview`（本会话允许清单内唯一可选路由），全部同批同型。

- **波次 1 · 契约与地基**（1 个子代理）：`shared/step-code-contracts.ts`、`host/step-code/types.ts`、`host/step-code/model-catalog.ts`、`host/step-code/token-store.ts`（含偏好注册）。产出被冻结的 DTO 与常量，供后续波次引用。
- **波次 2 · 三条并行**（3 个子代理，文件互不重叠）：
  - A：`host/step-code/{client,oauth,adopt,account-pool}.ts` —— 传输、登录、导入、号池。
  - B：`host/step-code/{mapper,cache-stats}.ts` —— 协议映射与缓存诊断。
  - C：`client/step-code/*` —— 卡片、hook、胶囊、文案、样式、路由表（按波次 1 冻结的 DTO 写）。
- **波次 3 · 集成**（1 个子代理）：`host/step-code/{adapter,routes}.ts` + `src/index.ts` 接入 + 两个 common 注册点。依赖波次 2 的 A/B。
- **波次 4 · UI 接入与文档**（1 个子代理）：`hub/providers.tsx`、`brand-icons.tsx`、`client/index.tsx` 槽位、既有测试的数量/顺序断言、README/CHANGELOG/协议矩阵。
- **波次 5 · 验收**（我方）：typecheck + 全量测试 + build + 逐条对照验收标准，并抽查 diff 是否只增不改。

每波次任务书均含：目标 / 边界（可动文件白名单）/ 约束 / 验收标准 / 必须回报的证据。子代理自检 → 我方复审，不通过带证据重派。

---

## 9. 验收标准

1. `npm run typecheck`、`npm test`、`npm run build`、`npm pack --dry-run` 全部通过。
2. 设置页出现第 10 张卡片，可开关；关掉后模型选择器里该线路的模型消失，其它线路不受影响。
3. 三种凭据来源各自可走通（浏览器授权用真账号联调；导入与粘贴用夹具覆盖）。
4. 模型目录：登录后能从 `/step_plan/v1/models` 拉到模型并按 `model_type` 过滤；能力（窗口/图片/思考档位）按端点字段回落正确；拉不到时选择器不为空。
5. 一次真实对话跑通（含工具调用），响应侧 `cacheRead` 与上游 `cached_tokens` 对得上，`cacheWrite` 恒 0 且卡片如实标注。
6. 额度卡片能显示 Step Plan 的窗口/积分与套餐名；额度接口失败不影响模型请求，且失败有明确文案。
7. 既有 9 条线路的测试全绿，且其实现文件 diff 为**零改动**。
8. README 注明 Step 线路的能力、限制、以及额度接口为非公开接口的风险；CHANGELOG 有 Unreleased 条目。

---

## 10. 风险与未知项

| # | 风险/未知 | 处理 |
| --- | --- | --- |
| 1 | 额度接口是非公开 devcenter 接口 + 需要账号密码或浏览器 Token | 明示风险；自动登录失败时给手动粘贴兜底；额度失败不影响模型请求 |
| 2 | `/v1/models` 的 `model_type`、`max_input_tokens`、`enable_reason`、`enable_vision_input`、`reasoning_effort_support_list` 均不在官方 model 对象文档内（未公开扩展字段） | 全部按「可能缺失」处理并有默认回落 |
| 3 | Step 是否接受 `prompt_cache_key` / 会话亲和头未知 | 默认不发，做成能力开关，实测后再定 |
| 4 | `usage.prompt_tokens_details` 在 Step 上是否出现未知 | 解析链覆盖顶层 `cached_tokens`，两条路都能拿到 |
| 5 | 账号密码登录依赖设备指纹（`Oasis-Webid` 与 token 的 `device_id` 必须一致） | 实现时从 token JWT 解出 `device_id` 再回填头；失败即降级到手动粘贴 |
| 6 | 国区/国际区凭据互不通用 | 区域由凭据里的 profile 唯一决定，跨区使用直接报错而不是静默失败 |

---

## 11. 决策记录（访谈结论）

| 决策 | 用户选择 | 依据 |
| --- | --- | --- |
| 线路身份 | `step-code` / 「Step Code（Step Plan 订阅）」/ 单线路内含国区+国际区 | 推荐项 |
| 账号能力 | 浏览器授权 + 导入本机 stepcode 登录态 + 手动粘贴 Platform API Key + 多账号号池 | 全选 |
| 缓存 | 用量口径（cacheRead/cacheWrite 解析、计费、卡片展示）+ 请求侧能力开关 | 选前两项；未选「缓存浪费诊断」为交付项，但按第 4.2 条 4 实现于线路内部 |
| 额度 | 实现 devcenter 额度接口；自动登录优先，失败提示手动粘贴 | 第二轮补充 |
| 交付范围 | host + client + 测试 + 文档全套，**先不发布** | 推荐项 |
| 联调 | 用户有账号，可按说明自行登录验证 | 推荐项 |
| 共用边界 | 每条新线路自带实现，**完全不碰公共模块** | 见第 6.2 节的两个例外待确认 |

---

## 12. 实施备注（实施过程中验证过的事实，供后续波次直接引用）

1. **`enabledModelIds` 的语义**：本仓库使用的 schemastery 会把缺省的 `z.array(z.string())` 归一化成 `[]`（实测 `z.object({ ids: z.array(z.string()) })({})` → `{"ids":[]}`），
   因此**不能**用「缺省 = 不过滤」的三态。统一规则：**缺省或空数组 = 不过滤（全部模型可用）；非空 = 显式选择**。
   `StepCodeStatusDto.enabledModelIds` 只在非空时下发。
2. **槽位号顺延**：`conversation.input.right` 现有 order 35–42（codex→glm）。本线路取 **43**，**不得重排既有号**
   （既有注释已写明理由：重排会让已上线线路的槽位位置无谓变化）。
3. **基线**：改动前全仓 `npm run typecheck` 退出码 0；`npm test` = 215 个文件通过 / 1 跳过，3494 tests passed / 7 skipped。
   任何后续改动都必须回到这个基线之上（既有测试只允许按「线路数量/顺序」追加断言）。
4. **命名冲突检查**：`src/` 下当前对 `step-code|StepCode|stepcode` 的引用为 **0 处**，线路 id 与目录名均无冲突。
