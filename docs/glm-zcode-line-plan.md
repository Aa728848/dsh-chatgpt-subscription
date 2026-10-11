# GLM（ZCode 账号）线路实施计划

- **目标线路**: `glm-coding-plan` / 显示名「GLM（ZCode 账号）」
- **起点**: 本文件产出时 `master` @ `4e8bf1d`（0.18.0），工作区干净，未改动任何文件
- **基线**: `npm run typecheck` 0 错误；`npm test` 3013 passed / 7 skipped / 0 failed
- **状态**: 设计已收敛，**待评审后开工**。本文是实施计划，不代表能力已实现或线上验证通过。

---

## 1. 目标、成功标准与非目标

### 目标

新增第九条订阅线路，把 GLM Coding Plan（Z.ai / BigModel 两区）按**账号授权**而非粘贴 API Key 接入 DSH，并对齐其余八条线路的工程深度。

### 成功标准

- 用户可用 **ZCode 账号 OAuth 登录**（国区 → bigmodel.cn，国际区 → chat.z.ai），无需手工铸造 Key。
- 可选**一键 adopt** 本机已登录的 ZCode 客户端登录态，免二次登录。
- 两个区域（`cn` = open.bigmodel.cn / bigmodel.cn，`intl` = api.z.ai / chat.z.ai）各自独立账号、独立凭据、互不串用。
- **双协议按模型能力路由**：目录逐模型声明走 Anthropic 面还是 OpenAI 兼容面，未知模型不猜协议。
- 逐模型能力表（图片 / 思考档位 / 可否关闭思考），**不从模型名推断**。
- 设置页形态与其余线路一致：hub 卡片进入 → 账号池 + 配额条 + 模型勾选（图标 + 描述）。
- `docs/provider-protocol-test-matrix.md` 增加一行；README 线路总览表从「7 条」更新。

### 非目标

- **不做 Agent 行为层映射**（ZCode 的 `/mode plan|build|edit|yolo|guarded`、工具契约、`~/.zcode/AGENTS.md` 生态复用）——本轮只做线路层。
- 不改动 command-code / workbuddy 里已有的 GLM 模型行（那是它们各自上游的模型，与本线路无关）。
- 不绕过套餐限制，不把公开 API 能力自动等同于订阅网关能力。
- 不重建 DSH 已有的子 Agent、授权与路由审计。
- 不实现 `refresh_token` 交换（**上游没有这个接口**，见 3.6）。

---

## 2. 证据分级

沿用 `docs/plan-provider-agent-optimizations.md` 的等级定义：

| 等级 | 定义 | 实施规则 |
|---|---|---|
| **A** | 上游契约或本地源码可证明 | 直接实现，加回归测试 |
| **B** | 社区逆向实测验证过的行为 | 实现 + 能力门控，先验证端点再启用 |
| **C** | 社区经验或架构推断，无实测 | **实现但默认不启用**，做对照实验 |

本文每条上游事实都标注等级与来源。**C 级不得进入默认路径。**

---

## 3. 关键上游事实

### 3.1 登录（OAuth）

| 事实 | 值 | 等级 | 来源 |
|---|---|---|---|
| 开流 | `POST https://zcode.z.ai/api/v1/oauth/cli/init`，头 `Authorization: Bearer <pollToken>`，体 `{"provider":"zai" 或 "bigmodel"}` | A | `apps/zcode-cli/packages/adapters/src/auth/cli-oauth.ts:88,98` |
| pollToken | `randomBytes(32).toString('hex')` | A | 同上 :116 |
| 开流响应 | `{flow_id, authorize_url, expires_at, poll_interval_sec}` | A | 同上 :138,172 |
| 轮询 | `GET .../api/v1/oauth/cli/poll/{flow_id}`，同一 Bearer；间隔 `max(1000ms, poll_interval_sec*1000)` | A | 同上 :106-115 |
| 总超时 | `min(now + 5min, expires_at*1000)` | A | `bootstrap/src/auth-login.ts:41` |
| ready 载荷 | `{status:"ready", token, user:{user_id,email,name,avatar}, zai 或 bigmodel:{access_token, refresh_token}}` | A | `cli-oauth.ts:203-238` |
| 错误语义 | 4xx（除 408/429）、信封 `code !== 0`、未知 status 视为**致命**；5xx / 网络错误 / 畸形 200 按 pending 重试 | B | TriDefender `pollOnce` 注释 |
| 国区授权入口 | `https://bigmodel.cn/login`，`appId = "zcode"` | A | `bigmodelProviderConfig.ts:19-20,24` |
| 国际区授权入口 | `https://chat.z.ai/api/oauth/authorize`，`client_id = "client_P8X5CMWmlaRO9gyO-KSqtg"` | A | `zaiProviderConfig.ts:21,26` |
| 桌面回调中转 | `https://zcode.z.ai/app/oauth/login?redirect=zcode://oauth/callback&app_version=<ver>` | A | `configUtils.ts:5,34-40` |
| 有无 PKCE | **无**（两个 adapter 的授权参数只有 redirect / appId / state） | A | `bigmodelProviderAdapter.ts:108-118` |

> **关键更正**：本项目历史（`9ad8a53`）认为「国区没有浏览器登录」。官方源码证明**国区有**，只是走的入口不同。老代码里那句「The China console has no browser sign-in」必须在移植时删掉。

### 3.2 登录态 → 可用凭据（兑换链）

三个独立项目（`TriDefender/zcode-api`、`Sakuralaaa/z-code-2api`、CLIProxyAPI 插件生态）**同构实现**了同一条链路：

```
OAuth access_token
  -> POST https://api.z.ai/api/auth/z/login  {token}                   => biz token
  -> GET  {host}/api/biz/customer/getCustomerInfo                      => 默认机构 orgId / 默认项目 projectId
  -> GET/POST {host}/api/biz/v1/organization/{org}/projects/{proj}/api_keys  => 找或建一把 Key
  -> GET  .../api_keys/copy/{apiKeyId}                                  => secretKey
  -> 拼成 {apiKey}.{secretKey}                                          => Coding Plan API Key
```

逐字证据：`resolver.ts` 的 `const ZAI_API_KEY_NAME = "zcode-api-key"`；`types.ts` 的 `return $``{cred.apiKey}.${BT}}`{cred.secret}`；`z-code-2api/app/oauth.py` 末行 `return f"{api_key}.{secret_key}"`。

**等级 B**（逆向实测，非官方契约）。**本线路用自己的 Key 名**（如 `dsh-glm-coding-plan`），不使用 `zcode-api-key`，以免轮换或删除官方客户端已建的 Key。

### 3.3 模型面（双协议）

| 面 | 国区 | 国际区 | 等级 | 来源 |
|---|---|---|---|---|
| OpenAI 兼容（Coding Plan 专用） | `https://open.bigmodel.cn/api/coding/paas/v4` | `https://api.z.ai/api/coding/paas/v4` | A | `zcode.z.ai/en/docs/qa` 第 6 条原文 |
| Anthropic 兼容 | `https://open.bigmodel.cn/api/anthropic` | `https://api.z.ai/api/anthropic` | A | 同上 |
| 通用 OpenAI（**不用**，套餐额度不生效） | `/api/paas/v4` | — | A | 同上「Common mistakes」段 |

**认证头**：Anthropic 兼容网关**同时读 `x-api-key` 和 `Authorization: Bearer`**，同值。官方源码注释逐字：`apps/zcode-cli/packages/adapters/src/model/model-execution.ts:425-437`「Anthropic 兼容网关会同时读取 x-api-key 和 Bearer Authorization」。

> 官方开源版自己用的是**托管网关**（`official-coding-plan-gateway.ts` 静态映射到 `zcode.z.ai/api/v1/ultra/anthropic/v1/messages`（国区）/ `/api/v1/ultra-zai/anthropic/v1/messages`（国际区））。该通道**有状态**（`off-peak-request-auth.ts` 要求每 attempt 向 owner 重解 `X-Coding-Plan-Api-Key`），本轮**不使用**。

### 3.4 配额与用量

| 事实 | 值 | 等级 | 来源 |
|---|---|---|---|
| 端点 | `GET {host}/api/monitor/usage/quota/limit` | A | `docs/bigmodel-coding-plan-usage-quota.md` |
| 认证 | `authorization: <id>.<secret>` **裸 Key，不可加 Bearer**（加了会鉴权失败） | A | 同上逐字 |
| 窗口键 | `unit` 3 = 5 小时、5 = 月度、6 = 周度 | A | `packages/dsh-usage/src/core/adapters.ts:249` |
| 行类型 | `TOKENS_LIMIT`（token 套餐）、`CREDIT_LIMIT`（额度套餐，比例 = `currentValue`/`usage`）；`TIME_LIMIT` 是 MCP 请求上限，**不是套餐窗口** | A | 同上 :240-304 |
| 套餐名 | `data.level`（lite / pro / max） | A | 同上 :300 |
| 区域 host | `https://api.z.ai` 或 `https://bigmodel.cn`（国区亦可用 open.bigmodel.cn） | A | 同文档 |

> 本仓库**已有一份可直接复用的解析实现**：`packages/dsh-usage/src/core/adapters.ts:260-304` 的 `glmPlan()`（在 dsh-web 仓库里，只读参考，不复制）。解析语义照它对齐即可，包括「未知 unit 不下发、不发明窗口」这条。

### 3.5 业务错误码

`9ad8a53` 的 `types.ts` 已转录一张完整表（1001/1000/1003/1113/1211-1214/1220/1261/1301/1302/1305/1308/1309/1310/1311），并注明「HTTP 状态保持通用，正文才说明真实条件，所以分类不能停在状态行」。**直接复活这张表**。

### 3.6 token 生命周期（两个坏消息）

- **没有 refresh**。官方 `oauthService.ts:972-975` 对刷新直接抛「OAuth 暂未提供 refresh token 交换接口，请重新登录」；BigModel 与 Zai 两个 adapter 都**没有实现** `refreshToken()`。三份材料里唯一声称能刷新的（vibe-coding-labs，基于 3.0.1）是**臆测**，其自己的文档第 6.2 节就写着 `refresh_token: null`。
- **业务 JWT 可以刷新**：`POST api.z.ai/api/auth/z/login` 返回 `expires_in`，官方按「提前 120 秒 + 0~60 秒抖动」重取（`zai-business-token-cache.ts:64-73`）。这一层我们要自己做，否则 access_token 一过期就只能重新登录。

### 3.7 凭据落盘（adopt 用）

| 事实 | 值 | 等级 | 来源 |
|---|---|---|---|
| 路径 | `~/.zcode/v2/credentials.json`（`ZCODE_DATA_BASE_DIR` 可覆盖） | A | `shared-credentials.ts` |
| 结构 | 单层 JSON，值为字符串 | A | 同上 :15-24 |
| 键名 | `oauth:active_provider`、`oauth:{bigmodel 或 zai}:{access_token,refresh_token,user_info}`、`zcodejwttoken` | A | 同上 |
| 加密 | `enc:v1:` + base64url(iv).base64url(tag).base64url(cipher)，AES-256-GCM，iv 12B，tag 16B | A | `credential-cipher.ts:4-9` |
| 密钥 | `sha256(ZCODE_CREDENTIAL_SECRET 或 "zcode-credential-fallback:{platform}:{homedir}:{username}")` | A | 同上 :78-104 |
| 写入 | 文件锁 + 原子私有写，POSIX 0600 | A | `shared-credentials.ts` |

> **无 secret 时也能解密** —— 密钥可由 platform + homedir + username 推导，所以普通用户的 adopt 可行。

---

## 4. 决策记录（澄清访谈结论）

| # | 决策 | 取值 | 理由 |
|---|---|---|---|
| D1 | provider id / 显示名 | `glm-coding-plan` / 「GLM（ZCode 账号）」 | 与用户自己的 `zai`/`zhipu` 兼容路由区分；不与已退役的 `zhipu-coding-plan` 混淆；不与 command-code/workbuddy 里已有的 GLM 模型行冲突 |
| D2 | 登录形态 | **浏览器 OAuth 账号授权 + adopt**，不做 API Key 粘贴 | 用户明确要求账号登录；两者产出同一种凭据，下游共用 |
| D3 | 上游协议 | **双协议**，目录逐模型声明 | 用户选择；未知模型不猜协议（沿用 command-code 的 `supported_endpoints` 思路） |
| D4 | Wire B 认证 | **OAuth 换出 `id.secret` 的 Coding Plan Key**，再打 `/api/anthropic` | 三个成熟桥接实现一致；凭据可复用（配额接口本来就用同一把裸 Key）；access_token 过期不影响模型调用。**修正**了首轮「直用 access_token」的选择 |
| D5 | 签名层 | **实现 Client Signing V4，默认关闭，能力门控** | 唯一有实测记录的项目做了 A/B 对照：带签名与不带签名响应**完全一致**（都是 429/1113），从未观察到服务端因缺签名而拒绝。属 C 级证据，不得进默认路径 |
| D6 | adopt 范围 | **解密 credentials.json 的 access_token + zcodejwttoken，走同一套兑换** | 与 `codex-adopt.ts` / `claude/adopt.ts` 既有先例一致：只读不写、先探测存在性、失败可回落浏览器登录 |
| D7 | 特化范围 | **仅线路层** | 用户选择；Agent 行为层（权限模式/工具/生态配置）超出本轮 |
| D8 | 落地方式 | **复活 `7e40fce` 的 zhipu 骨架 + 补今天缺的八项** | 省约 6000 行重写。**只挑 `9ad8a53` 的 oauth/contracts/routes/Section hunk，不整条 cherry-pick**（那条提交混进了大量 workbuddy/checkin 改动，共 +4338/-779） |
| D9 | 实机验证 | **无账号，全部照官方源码 + 文档 + mock 验收** | 无 live 验证能力，所有未验证项必须在文档中显式标注，不得当作已验证事实 |

---

## 5. 工作包与依赖

### 5.1 依赖图

```
W0 契约冻结 --+-- W1 OAuth 登录 + 兑换
              +-- W2 adopt
              +-- W3a 协议 A 线（Anthropic）mapper
              +-- W3b 协议 B 线（OpenAI 兼容）mapper
              +-- W4 签名层（默认关闭）
                        |
              W5 client + 目录 + 配额 --+
              W7 客户端 UI ------------+
                                       +-- W6 adapter + routes + 注册 + hub
                                                        |
                                                     W8 验收 + 文档
```

### 5.2 工作包清单

| ID | 优先级 | 工作包 | 交付物 | 依赖 | 可并行 |
|---|---|---|---|---|---|
| **W0** | P0 | 契约与常量冻结 | `src/shared/glm-coding-plan-contracts.ts`、`src/host/glm-coding-plan/types.ts` | — | 单独先做 |
| **W1** | P0 | OAuth 登录 + 兑换链 | `oauth.ts`（cli/init + poll + 状态机 + 手工粘贴兜底）、`exchange.ts`、`biz-token-cache.ts` | W0 | 是 |
| **W2** | P0 | adopt | `adopt.ts`（只读 + credential-cipher 解密） | W0 | 是 |
| **W3a** | P0 | 协议 A 线映射 | `mapper-anthropic.ts` | W0 | 是 |
| **W3b** | P0 | 协议 B 线映射 | `mapper-openai.ts` | W0 | 是 |
| **W4** | P2 | 签名层（门控） | `signing.ts`（移植 MIT 的 zcode-signer.ts） | W0 | 是 |
| **W5** | P0 | 上游 I/O + 目录 + 配额 | `client.ts`、`model-catalog.ts` | W0,W3 | 是 |
| **W6** | P0 | 装配与注册 | `adapter.ts`、`routes.ts`、`token-store.ts`、`account-pool.ts`、`src/index.ts` 注册点 | W1-W5 | 串行 |
| **W7** | P0 | 客户端 UI | `client/glm-coding-plan/*`、`hub/providers.tsx` 卡片、`hub/brand-icons.tsx` | W0 | 是 |
| **W8** | P0 | 测试与文档 | `test/glm-coding-plan-*.test.ts`、README、CHANGELOG、`docs/provider-protocol-test-matrix.md` | 全部 | 收尾 |

### 5.3 并发批次

- **批次 1**：W0（冻结契约，必须先落地，其余全部依赖它）
- **批次 2**：W1、W2、W3a、W3b、W4 —— 五个相互独立，只读 W0 契约
- **批次 3**：W5、W7 —— 并行
- **批次 4**：W6 —— 集成串行（唯一改动 `src/index.ts` 的工作包，避免冲突）
- **批次 5**：W8 —— 验收

> 每批最多同时开 3 个子代理，避免 active child limit 与热点文件冲突。

---

## 6. 交付物清单（文件级）

### 6.1 新增

```
src/shared/glm-coding-plan-contracts.ts        # DTO + 常量；host/client 只依赖它，互不 import
src/host/glm-coding-plan/
  types.ts          # PROVIDER_ID/NAME、两区 host、路径、超时、业务错误码表、档位词汇表
  oauth.ts          # cli/init + poll + LoginFlow 状态机 + 手工粘贴兜底
  adopt.ts          # 只读 adopt（按名导入 readFile/stat，不引整个 fs 命名空间）
  exchange.ts       # access_token -> biz token -> org/project -> api_keys -> copy -> id.secret
  biz-token-cache.ts# 业务 JWT 缓存（提前 120s + 抖动重建）
  signing.ts        # Client Signing V4（默认关闭）
  client.ts         # 模型目录、配额窗口、订阅列表、User-Agent
  model-catalog.ts  # 逐模型能力表（图片/档位/可否关思考/协议归属）
  mapper-anthropic.ts
  mapper-openai.ts
  token-store.ts    # 凭据/模型设置/偏好（DPAPI/Keychain/SecretService 三平台）
  account-pool.ts   # 走共享 AccountPoolCore
  adapter.ts        # LlmAdapter 实现，按模型路由双协议
  routes.ts         # /glm-coding-plan/api 全套
src/client/glm-coding-plan/
  GlmCodingPlanSection.tsx
  GlmCodingPlanComposerQuota.tsx
  locales.ts        # NS + zh/en
  styles.ts         # 只声明本卡独有样式
test/glm-coding-plan-*.test.ts
```

### 6.2 必须改动的既有文件（注册点）

| 文件 | 位置 | 改动 |
|---|---|---|
| `src/index.ts` | :58-69 | 加 import |
| | :231-236 | 建 store / pool / modelSettings / preferences |
| | :344-345 | **把新线 id 加进 CONTROLLED_PROVIDERS**（`src/host/common/model-request-control.ts:5`） |
| | :412-423 | new Adapter + claimProviderRoute |
| | :448-459 | register...Routes |
| | :754-770 | **hub overview 汇总源** |
| | :907-908 | dispose |
| | :1052-1210 | 对外 re-export |
| `src/client/hub/providers.tsx` | :75-128 | 加 hub 卡片 descriptor |
| `src/client/hub/brand-icons.tsx` | — | 加 GLM 品牌图标 + HubProviderId 联合类型 |
| `src/client/index.tsx` | :29-31 / 55-56 / 91-95 / 158-161 | import / locale 类型声明 / 注册 / 胶囊 slot |
| `src/host/common/model-request-control.ts` | :5 | CONTROLLED_PROVIDERS 加 id |
| `README.md` | :17-24 / 28 / 30-39 | 目录锚点、线路总览（**7 条 → 8 条**）、新线路一节 |
| `CHANGELOG.md` | Unreleased | 中文条目 + 验证计数 |
| `docs/provider-protocol-test-matrix.md` | 表格 | 加一行 |
| `test/client-registration.test.ts` | :302 / 305-313 | **逐条断言**（当前断言 7 个 conversation.input.right、1 个 settings.section） |

---

## 7. UI 验收基线

**约束来自需求方原话：入口方式、配额显示额度、模型选择用「图标 + 描述」。这三条全部由现有共享组件覆盖，本轮不新建 UI 组件。**

| 要求 | 组件 | 位置 | 验收点 |
|---|---|---|---|
| 进入入口（卡片：图标 + 「N 个账号 / M/N 个模型可用」+ 开关 + chevron） | HUB_PROVIDERS descriptor + BrandMark | `src/client/hub/providers.tsx:75-128` | 卡片出现在「订阅服务」列表，开关 POST `/glm-coding-plan/api/settings`，点进详情页 |
| 模型选择（图标 + 名称 + 一句话描述 + 行尾勾） | ModelChecklist | `src/client/common/ModelChecklist.tsx:48-84` | 每行 modelBrandMark(id) 图标、name、hint、role="checkbox" 行尾勾；表头 `{count}/{total}` + 全选/全不选 |
| 配额显示额度（标签 + 进度条 + 百分比 + 重置时间） | AccountPoolSection + AccountQuota | `common/AccountPoolSection.tsx:90`、`common/account-quota.tsx:105-151` | 每窗口一行：5h/week/month 标签、role="progressbar"、百分比（>=100 显示「已用尽」）、N 天后重置 |
| 多区域登录入口 | AccountPoolSection.renderLoginActions | 同上 :29 | WorkBuddy 已有两区先例，GLM 同样两区，复用该扩展点 |

**模型能力表文案要求**（对齐 MiniMax/WorkBuddy 的做法）：每行 hint 说明「思考是否恒定开启 / 无档位」「可关闭 / 强制开启（可选档位）」「接受 text, image」「上下文窗口」。**能力不得从模型名推断** —— 历史草案已明确记录 `glm-5.3-flash` 收图而 `glm-5.3` 不收、`glm-5.2` 两个档位而 `glm-5.3` 三个。

---

## 8. 验收标准

### 8.1 每条工作包

- `npm run typecheck` 0 错误
- `npm test` 全绿，且**计数不低于基线 3013 passed / 7 skipped / 0 failed**
- 新增行为必须有对应测试文件，命名 `test/glm-coding-plan-<concern>.test.ts`
- 测试**不得**要求真实凭据或网络（沿用 mocks + 脱敏 fixtures）

### 8.2 线路级

- OAuth 全流程可用 mock 走通：开流 → 轮询 pending → ready → 兑换 → 落盘前校验
- 轮询错误语义正确：4xx 致命 / 5xx 与畸形 200 按 pending 重试 / 超时精确到 expires_at
- 两区凭据互不串用：一个池可同时持有国区与国际区账号
- 兑换失败（账号无建 Key 权限、团队版）有可操作报错，不静默
- 配额接口用**裸 Key**（回归测试断言无 Bearer 前缀）
- Anthropic 面发**双头**（x-api-key + Authorization: Bearer，同值）
- 签名层默认关闭：断言默认路径**不产生** X-Client-* 头
- `test/package-integrity.test.ts` / `client-registration.test.ts` / `client-style-ownership.test.ts` 全部更新并通过

### 8.3 文档级

- README 线路总览、「7 条」数字、目录锚点同步
- CHANGELOG 写「问题 → 后果 → 修法 → 测试 → 验证」并附精确计数
- `docs/provider-protocol-test-matrix.md` 加行，并标注本线路的验证等级（**无账号，仅 mock**）

---

## 9. 风险与未验证项

| # | 风险 | 影响 | 处置 |
|---|---|---|---|
| R1 | **无实机账号** | 所有上游行为未经 live 验证 | 全部未验证项标注等级；不谎称已验证；探针不进默认单测 |
| R2 | **签名层 C 级证据** | 唯一实测显示带签名与不带签名响应一致，从未观察到缺签名被拒 | 默认关闭 + 能力门控；CLIENT_VERSION 提到 >=3.15.1；握手 origin 用 api.z.ai（有实测记录证明 /api/paas/* 在 zcode.z.ai 上 404） |
| R3 | **没有 refresh_token** | access_token 过期只能重新登录 | 业务 JWT 层自建缓存（提前 120s + 抖动）；access_token 过期时给可操作报错 |
| R4 | **兑换链是逆向的（B 级）** | 上游可能变更 api_keys 路径或字段 | 端点全部做成可覆盖（沿用历史 DSH_ZAI_* 环境变量约定） |
| R5 | **国区兑换链未验证** | 三个同构实现均以国际区为主 | 国区单独标未验证；失败时明确提示而非静默 |
| R6 | **凭据解密依赖用户环境** | 设了 ZCODE_CREDENTIAL_SECRET 的用户 adopt 会失败 | adopt 失败回落浏览器登录，不阻断 |
| R7 | **可抄代码的许可证** | ShanWuYinShe/dsh-plugins 是 MIT（可抄）；bacnh85/pi-extensions、TriDefender/zcode-api 是 null | 只从 MIT 仓库复制代码；null 的只读协议、照协议重写 |
| R8 | **两区模型 id 不一致** | 历史草案记录 intl 多了 glm-5.3-flash 等 | 目录按区域过滤；一条表覆盖两区时**取小值** |
| R9 | src/index.ts 是热点文件 | 多工作包并行会冲突 | W6 单独串行，其余工作包不碰它 |

### 明确未验证（写进代码注释，供后续复审）

- poll_interval_sec 服务端实际下发值（只见最小 1 秒校验，无实测样本）
- 握手路径里的 c1f3a7e2 是否会轮换
- 国区 id.secret 兑换是否与国际区同构
- data.token（ZCode JWT）的完整 payload 字段
- 服务端是否真的因缺签名返回 VERIFY_SIGNATURE_INVALID（**从未被观察到**）

---

## 10. 参考来源

**官方**
- zai-org/ZCode（Apache-2.0）— apps/zcode-cli/packages/adapters/src/auth/*、.../model/*
- https://zcode.z.ai/cn/docs/configuration、https://zcode.z.ai/en/docs/qa
- docs/bigmodel-coding-plan-usage-quota.md（配额接口裸 Key 逐字）

**社区（协议参考）**
- TriDefender/zcode-api — 兑换链最完整（license=null，**只读协议**）
- Sakuralaaa/z-code-2api — 同构 Python 实现（AGPL-3.0，**不可复制**）
- hj01857655/ZCode — 唯一有签名实测记录（含 A/B 对照）
- rensumo/cpa-plugin-zcode — MIT（Go，仅覆盖「现成 Key 打 /api/anthropic」）

**可复制代码**
- ShanWuYinShe/dsh-plugins -> packages/dsh-any-connect/src/zcode-signer.ts（**MIT**，219 行，零依赖，已是 DSH 插件内 TS 文件）+ test/zcode-signer.test.ts

**本仓库历史**
- 7e40fce feat(zhipu): add the GLM Coding Plan provider line（23 文件 / 6284 行，复活基座）
- 9ad8a53 GLM（oauth.ts 716 行，**只挑 hunk**）
- 7eb3ee2 Revert "GLM"、fb07c2e feat: replace the GLM line with a Claude subscription line

**本项目既有模板**
- src/host/kimi-code/（14 文件骨架）、src/host/workbuddy/（两区账户池先例）、src/host/claude/adopt.ts（只读 adopt 先例）
- docs/plan-provider-agent-optimizations.md（证据分级）、docs/kimi-code-gap-analysis.md（文档形式）
