# 多账号管理（号池）推广设计：ChatGPT / Command Code / Kimi Code

> 状态：**已实施（P0–P4 全部落地，0.4.0）**
> 依据：Antigravity 线路已实现账号管理 + 号池（`src/host/antigravity/account-pool.ts`、`src/client/antigravity/AntigravitySection.tsx`），本设计把同类型能力推广到其余三条线路，并顺带统一四个 Tab 的设置页 UI。
>
> 实施结果（与本文档的差异说明）：
> - 共享内核落在 `src/host/common/account-pool.ts`（+ `src/host/common/home.ts`），四个线路各有一个薄封装：`src/host/codex-account-pool.ts`、`src/host/command-code/account-pool.ts`、`src/host/kimi-code/account-pool.ts`，Antigravity 的 `AccountPoolStore` 改为复用内核并保留原 API 与池文件格式。
> - 共享界面组件落在 `src/client/common/AccountPoolSection.tsx` + `account-pool-labels.ts` + `styles.ts`，四个 Tab 全部使用它（Antigravity Tab 原手写 JSX 已删除，见 `test/antigravity-section-pool.test.tsx` 锁定）。
> - 独立审查（后台子代理）复核后的处置：`refreshFailureStatus` 与配额分键被确认为达成；"测试把真实用户目录写坏"一条经复现判定为误报——vitest 每个测试文件独立进程（探针实验证：文件 A 清掉 `DSH_HOME` 后，文件 B 仍拿到自己的 `dsh-test-home-*`），真实池文件的 mtime 变化来自 live 应用每次 Antigravity 请求回写 `lastUsedAt`；仍按纵深防御加固了 setup 与哨兵测试。
> - 相对原设计新增两点：刷新失败「标记该账号并换号」（内核 `refreshFailureStatus` 钩子，避免失效账号把整轮请求卡死），以及 Command Code / Kimi 的配额快照按账号分键（切换账号不串显）。
> - 会话粘性以第三种策略 `sticky` 实现（保持当前账号直到被限流），未引入 session→account 映射。

## 1. 背景与目标

设置 →「订阅服务」页现有 4 个 Tab：ChatGPT（codex-chatgpt）、Antigravity、Command Code、Kimi Code。
其中只有 Antigravity 支持：多账号登录、主账号/当前账号标记、顺序耗尽/轮询两种调度策略、429 冷却与自动切号、账号别名/删除/清冷却。

目标：

1. 另外三条线路支持同构的账号管理与号池能力（多账号、调度策略、429 自动轮换、单账号退出）。
2. Host 侧沉淀一份可复用的泛型号池核，而不是把 393 行的 `account-pool.ts` 复制三遍。
3. Client 侧四个 Tab 视觉与交互统一（目前 ChatGPT Tab 还是旧的 `dsh-codex-*` 样式，其余三个是 `dsha-*` 分组卡片样式）。
4. 不破坏现有单账号用户的凭据与习惯（只读迁移、旧凭据自动成为主账号）。

非目标（本期不做）：账号凭据的导入/导出、跨设备同步、账号级并发上限、配额感知的智能路由（列为后续增强）。

## 2. 现状盘点

| 维度 | ChatGPT (codex) | Antigravity | Command Code | Kimi Code |
|---|---|---|---|---|
| 凭据类型 | OAuth 三元组 + accountId/planType | OAuth access/refresh + projectId | 静态 API Key | OAuth access/refresh + region/hosts |
| 凭据存储 | `createPlatformTokenStore`（DPAPI/Keychain/Linux 文件） | 加密后端 + 旧 JSON 迁移 | 同左 | 同左 |
| 多账号 | ❌ 单账号 | ✅ `AccountPoolStore` | ❌ | ❌ |
| 登录方式 | 浏览器 OAuth + SSE 事件（固定回调端口 1455，全局单流程锁） | 浏览器 OAuth（轮询状态） | 浏览器回调收 Key / 手贴 Key | 设备码轮询（verification URI + user code） |
| 令牌刷新 | `OAuthService.credentials()` 到期自动刷新，refresh token 轮换写回 | `getEffectiveAccount` 内刷新并写回池 | 无刷新 | `ensureAccessToken` 刷新 |
| 401 行为 | 强制刷新一次，刷新失败清空整个凭据 | 抛错 | 抛 INVALID_CREDENTIAL | 记录 refreshToken 全局拒绝标记 |
| 429 行为 | 抛 RATE_LIMIT 给 DSH 重试 | 冷却该账号 + 轮换下一账号 | 抛 RATE_LIMIT | 分类后抛错（配额型/套餐型） |
| 状态路由 | `GET /api/dsh-chatgpt-subscription/status`（信封式，含同源校验） | `GET /antigravity/api/status`（含 accounts/strategy） | `GET /command-code/api/status`（同源校验） | `GET /kimi-code/api/status`（同源校验） |
| 设置页 UI | `dsh-codex-*` 旧样式（Section/InfoRow） | `dsha-*` 账号池卡片 + 分组 | `dsha-*` 单账号分组 | `dsha-*` 单账号分组 |

## 3. GitHub 成熟项目调研

| 项目 | 与本设计的相关性 | 可借鉴点 |
|---|---|---|
| [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | 最贴近：把 Gemini CLI / Antigravity / ChatGPT Codex / Claude Code 订阅包装成 API，多 OAuth 凭据轮询 | 凭据目录多文件管理；每凭据冷却配置（429 冷却秒数可配）；管理面板按账号展示用量 |
| [10/chatgpt-codex-proxy](https://github.com/10/chatgpt-codex-proxy)（[轮换策略文档](https://github.com/10/chatgpt-codex-proxy/blob/main/docs/MULTI_ACCOUNT_ROTATION_STRATEGY.md)） | 直接是 ChatGPT Codex 多账号轮换 | 账号状态机 `active/disabled/expired/banned`；`cooldown_until` + `last_error`；策略 `least_used / round_robin / sticky`；**用上游配额窗口（reset_at 已过则清除 limit_reached）做资格过滤**；preferredID 粘性（流式续连不切号） |
| [tbphp/gpt-load](https://github.com/tbphp/gpt-load)（[调度机制](https://www.gpt-load.com/docs/internals/scheduling)） | 通用 LLM 密钥池调度 | 资格过滤（禁用/冷却/黑名单）→ 加权轮询；**会话亲和**（同一前缀倾向用上次的凭据，利好 prompt cache）；失败换凭据重试直到耗尽 |
| [QuantumNous/new-api](https://github.com/QuantumNous/new-api)（[渠道管理](https://docs.newapi.pro/en/docs/guide/feature-guide/admin/channel)） | 企业级多渠道负载均衡 | 多 Key 模式、自动禁用失败渠道、加权随机 |
| [doxaras/claude-rotate](https://github.com/doxaras/claude-rotate) | Claude 订阅多号轮换 | consume-first（烧干一个再换）；区分**配额型 429（轮换）与突发型 429（退避）**；并发下"羊群安全"——100 个并发请求只触发一次换号决策 |
| [asyncdargen/claude-proxy](https://github.com/asyncdargen/claude-proxy)、[2solarmax/maxpool](https://github.com/2solarmax/maxpool) | Claude 多账号代理 | 优先级轮换、按 rate-limit 剩余感知调度 |

结论：业界收敛的模型是「**资格过滤（状态 + 冷却 + 配额窗口）→ 策略选择（sticky/顺序/轮询/least-used）→ 失败按错误类别冷却或轮换**」。我们的 Antigravity 实现已具备主干（冷却 + 顺序/轮询 + 主账号优先），推广时按上表补齐两件事：**账号级永久状态（认证失效 ≠ 删除）** 与 **429 分类处理（尤其 Kimi 的套餐型 429 不应轮换）**。

## 4. 总体架构决策

### 4.1 共享泛型池核（推荐），而非三份复制

新增 `src/host/common/account-pool.ts`，把 Antigravity 池核抽象为泛型类：

```ts
export interface PoolHooks<TCredentials, TSummary> {
  readonly providerId: string                      // 'codex' | 'command-code' | 'kimi-code'
  readonly storageFileName: string                 // 'codex-pool.json' …
  readonly keychainService: string                 // 'dsh-chatgpt-subscription-pool' …
  parseCredentials(value: unknown): TCredentials
  dedupeKey(credentials: TCredentials): string | undefined   // 去重键：email / accountId / userId
  defaultAlias(credentials: TCredentials, index: number): string
  summarize(account: PoolAccount<TCredentials>, now: number): TSummary
  refresh?(credentials: TCredentials, fetchFn: typeof fetch): Promise<TCredentials>
  expiresAt?(credentials: TCredentials): number | undefined  // 无刷新能力的线路返回 undefined
}

export class AccountPoolCore<TCredentials, TSummary> {
  read(): Promise<PoolData<TCredentials>>
  write(data): Promise<void>
  listAccounts(): Promise<TSummary[]>
  addAccount(credentials, alias?): Promise<PoolAccount<TCredentials>>
  setPrimary / setAlias / deleteAccount / setStrategy
  markCooldown / clearCooldown / markAuthFailed(accountId, reason) / clearAuthFailed
  hasAnotherAvailableAccount(triedIds): Promise<boolean>
  getEffectiveAccount(excludeIds?, fetchFn?): Promise<{ account; credentials }>
}
```

保持不变的核心行为（从 antigravity/account-pool.ts 平移）：

- 按文件路径串行化的 `serialize()` 操作队列（并发安全）；
- 加密后端三平台分发（Windows DPAPI `<file>.dpapi` / macOS Keychain / Linux Secret Service），写后读回校验；
- **只读迁移投影**：池为空且旧单账号凭据存在时，读路径临时投影出 `acc_primary`，首次写操作才落盘；
- 旧单账号存储继续同步主账号凭据（向后兼容旧代码路径与 CLI 登录器）；
- `sequential`（主账号优先 → 顺序耗尽）与 `round-robin`（最久未用优先）两种策略。

各线路新增薄封装，只提供 hooks 与类型：

| 文件 | 职责 |
|---|---|
| `src/host/account-pool-codex.ts` | `StoredOAuthCredentials`；dedupe = `accountId ?? email`；refresh = OAuthService 的单账号刷新（轮换写回池） |
| `src/host/command-code/account-pool.ts` | `CommandCodeCredentials`；dedupe = `userId+keyName ?? sha256(apiKey)`；无 refresh |
| `src/host/kimi-code/account-pool.ts` | `KimiCodeCredentials`；dedupe = `userId ?? email`；refresh = `refreshAccessToken`（保留 region/oauthHost/baseUrl） |

Antigravity **暂不迁移**到泛型核（正在稳定运行，迁移是额外风险），作为 Phase 4 的可选收口项验证泛型抽象的正确性。

### 4.2 账号状态模型（相对 Antigravity 的增强）

```ts
interface PoolAccount<TCredentials> {
  id: string                 // acc_<6字节hex>；迁移账号固定 acc_primary
  alias: string
  credentials: TCredentials
  addedAt: number
  lastUsedAt?: number
  isPrimary?: boolean
  cooldownUntil?: number     // 429 短期冷却（可手动清除）
  cooldownReason?: string
  authStatus?: 'ok' | 'expired' | 'invalid'   // 新增：认证失效态
  authFailedReason?: string
}
```

资格过滤顺序（对齐 codex-proxy / gpt-load 的模型）：

1. `authStatus !== 'ok'` → 不可路由（UI 显示「需重新登录」，**不自动删除**，因为 Codex/Kimi 的 refresh token 失效是可恢复场景，用户重新登录同一账号即原地复活）；
2. `cooldownUntil > now` → 不可路由；
3. 剩余账号按策略选择。

这与现状的差异：Codex 现在刷新失败会**清空整个凭据**（`performRefresh` 里 `store.clear()`），池模式下改为只把该账号标记为 `expired`。

### 4.3 请求路径上的轮换环

三条线路都在「建立响应之前」做账号轮换环（与 Antigravity adapter 一致：流已开始则不切号，换号必重建请求）：

```
tried = Set
loop:
  eff = pool.getEffectiveAccount(tried)   // 含到期刷新 + lastUsedAt 写回
  tried.add(eff.account.id)
  resp = 发请求(eff.credentials)
  if resp.ok → 进入流式解析
  if resp == 429 (配额型):
      pool.markCooldown(id, retryAfter ?? 15min)
      if pool.hasAnotherAvailableAccount(tried) → continue
      break → 抛 RATE_LIMIT（沿用现有文案与 providerRetryAfterMs）
  if resp == 401/403:
      尝试强制刷新一次 → 成功则原地重试该账号一次
      刷新失败 → pool.markAuthFailed(id)；有其他账号 → continue
  else → 按现有分类抛错
```

各线路 429 的差异处理：

- **ChatGPT**：429 一律视为配额型（wham 窗口），冷却 + 轮换。Codex 的 `providerRetryAfterMs` 语义保留——全部账号冷却时抛错并带最短冷却等待时间（沿用 Antigravity 的报错模式）。
- **Command Code**：429 = 套餐/速率上限，冷却 + 轮换；401/403 = Key 失效 → `markAuthFailed`。
- **Kimi Code**：429 需按现有 `classifyKimiFailure` 分类——「套餐不含该模型」类 429 属**请求属性**而非账号配额，**不轮换不冷却**，直接抛错（否则会把所有账号打上错误冷却）；真正的限流型 429 才冷却 + 轮换。Kimi 的 refresh token 拒绝目前是模块级 `Set`，池化后改为按账号 `authStatus` 落盘。

并发安全：多并发流同时选中同一账号是允许的（与 Antigravity 一致，账号级不限制并发）；429 风暴下多个请求会给同一账号重复写冷却，幂等无害（claude-rotate 的"羊群安全"在网关场景才必须，DSH 是单机插件）。

## 5. 数据模型与存储

| 线路 | 池文件（$DSH_HOME/storages/） | Windows | macOS / Linux 服务名 |
|---|---|---|---|
| ChatGPT | `codex-pool.json` | `codex-pool.json.dpapi`（CurrentUser DPAPI） | `dsh-chatgpt-subscription-pool` |
| Command Code | `command-code-pool.json` | `command-code-pool.json.dpapi` | `dsh-command-code-pool` |
| Kimi Code | `kimi-code-pool.json` | `kimi-code-pool.json.dpapi` | `dsh-kimi-code-pool` |

- Keychain/Secret Service 的 account 键沿用 `sha256(resolve(filePath))`，隔离不同 `DSH_HOME`（与现有实现一致）。
- 旧单账号存储（codex 的平台 TokenStore、command-code/kimi-code 的加密凭据）保留为**迁移来源 + 主账号镜像**，行为与 Antigravity 完全相同。
- 凭据只存在于 Host 内存与系统凭据存储；账号列表 DTO 只带元数据（alias/email/plan/expiry/cooldown），不带 token。

## 6. HTTP API 变更

三条线路统一镜像 Antigravity 的路由形状（`{ ok, value, error }` 信封不变）：

| 路由 | 方法 | 说明 |
|---|---|---|
| `/<prefix>/api/status`（codex 为 `/api/dsh-chatgpt-subscription/status`） | GET | 响应新增 `accounts`、`activeAccountId`、`rotationStrategy` 字段 |
| `/<prefix>/api/accounts` | GET / POST | POST body `{ action: 'set-primary' \| 'set-alias' \| 'delete' \| 'strategy' \| 'clear-cooldown' \| 'relogin', ... }` |
| `/<prefix>/api/login`（codex 复用 `/login/start` + SSE） | POST | 登录完成 → `pool.addAccount`（dedupe 键相同则原地更新并保留 isPrimary），**不再覆盖"唯一账号"** |
| `/<prefix>/api/logout` | POST | body 可带 `accountId`：删单个账号；不带 → 删当前活跃账号（与 Antigravity 语义一致）；池空时同步清旧存储 |

安全校验：Command Code / Kimi Code 现有 `isSameOriginMutation` 保留并覆盖新端点；Codex 路由已有同源检查；**顺带给 Antigravity 的 POST 路由补上同源校验**（当前缺失，属于硬化项）。64KB body 上限不变。

`relogin` 动作：对 `authStatus='expired'` 的账号重走登录流程，登录成功按 dedupe 键原地替换凭据并复位状态（Antigravity 目前用"删除再添加"凑合，统一后三条新线路直接支持原地复活）。

## 7. 各线路改造点清单

### 7.1 Command Code（建议第一个做，无刷新逻辑、风险最低）

- `oauth.ts`：`beginWebLogin`/`saveApiKey` 增 `onSave` 回调（对齐 Antigravity），写池而非只写单账号存储。
- `adapter.ts`：`requestStream` 改为账号轮换环（凭据从池取，API Key 无刷新）。
- `client.ts`：`fetchAccountQuota` 用活跃账号 Key；quota 缓存键带 accountId，切主账号后不失效错乱。
- `routes.ts`：加 `/accounts`；`status` 带池字段。
- UI：手贴 Key 的输入框从独立分组移入「账号管理」分组（添加账号的第二种方式）。

### 7.2 Kimi Code

- `account-pool.ts`：refresh 钩子里把 `isRefreshTokenRejected` 的模块级判断改为写 `authStatus`。
- `oauth.ts`：`beginWebLogin` 每次登录允许选 region（现状已有），完成回调入池；设备码流程天然支持连续添加多个账号。
- `adapter.ts`：轮换环 + 429 分类（套餐型不换号）；endpoint 用**所选账号自己的** `baseUrl/oauthHost/region`（凭据内已携带，天然支持跨区账号混池）。
- `client.ts`：`fetchAccountQuota`/`loadProviderModels` 用活跃账号。

### 7.3 ChatGPT / Codex（改造面最大，最后做）

- `oauth-service.ts`：
  - `exchangeCode` 完成 → `pool.addAccount`（dedupe = `chatgpt_account_id`），旧单账号存储同步主账号镜像；
  - `credentials()` 改为 `pool.getEffectiveAccount` 驱动；`performRefresh` 泛化为"刷新指定账号并写回池"，400/401 → `markAuthFailed` 而非清空存储；
  - 登录流程（SSE、1455 回调、全局单流程锁）不变，天然串行添加账号。
- `responses-client.ts`：`send` 包账号轮换环；401 → 刷新重试 → `markAuthFailed` 换号；429 → 冷却换号。`chatgpt-account-id` 头随账号凭据走（`wire-auth.ts` 已支持）。
- `usage-service.ts`：配额查询用活跃账号 token；`/quota/refresh`、`reset-credit` 语义=作用于当前活跃账号。
- `routes.ts`：`/status` 扩展 + `POST /accounts`；`/logout` 带可选 accountId。
- 会话亲和说明：DSH 的 `session-id` 头是按 DSH 会话稳定派生的，与账号无关；轮询策略下同一 DSH 会话可能跨账号——上游 prompt cache 按账号隔离，这是可接受的损耗（gpt-load 用 sticky 缓解，列为后续增强）。流式开始后不切号（与 codex-proxy 的 preferredID 语义一致）。

## 8. UI 统一性方案

### 8.1 抽出共享账号池组件

新增 `src/client/common/AccountPoolSection.tsx`（受控组件），四个 Tab 的「账号管理」分组共用：

```tsx
interface AccountPoolSectionProps<TAccount> {
  accounts: TAccount[]
  activeAccountId?: string
  rotationStrategy: 'sequential' | 'round-robin'
  busy: string | null
  loginLabel: string              // '添加账号'
  loginBusyLabel?: string         // 登录进度文案
  onLogin(): void
  onSetPrimary(id): void
  onDelete(id): void
  onClearCooldown(id): void
  onRelogin?(id): void
  onSetStrategy(s): void
  renderAccountDetails(acc: TAccount): ReactNode   // 各线路特有行：projectId / planType / keyName / region…
  storageNotice: string
  children?: ReactNode            // Command Code 的手贴 Key 框、Kimi 的 region 选择
}
```

视觉元素与截图中的 Antigravity 完全一致：`dsha-account-card`、徽标（`主账号`/`当前使用`/`冷却中（剩 N 分）`/新增 `需重新登录`）、调度策略下拉（≥2 个账号时显示：顺序耗尽 / 轮询调度）、底部凭据存储说明行。

### 8.2 四个 Tab 的统一分组顺序

1. **账号管理**（共享组件；含登录按钮、策略、账号卡片列表、存储说明）
2. **连接**（启用开关、Provider、连接状态）
3. **模型选择**（胶囊多选 + 全选/全不选）
4. **增强功能**（各线路特有：默认思考深度等）
5. **上下文窗口**（按模型覆盖）
6. **用量与配额**

### 8.3 ChatGPT Tab 换皮

CodexSubscriptionSection 从 `dsh-codex-*`（Section/InfoRow 自绘组件）迁到 `dsha-*` 分组卡片，并插入共享账号池分组。Codex 特有分组保留、位置如下：代理设置并入「连接」分组之后；快速配额开关等偏好并入「增强功能」。SSE 登录进度复用现有事件流，呈现在「添加账号」按钮的进度文案上（与 Antigravity 的轮询进度等价）。

### 8.4 文案与本地化

- 池相关文案键（accountPool / addAccount / rotationStrategy / primaryAccount / activeAccount / cooling / clearCooldown / setPrimary / deleteAccount / relogin / noAccounts / storageNotice…）从 `antigravity/locales.ts` 提升为共享字典，四个线路的 locales.ts 各自 re-export/覆盖，保持各 NS 独立注册的现状。
- Antigravity/Command Code/Kimi Code 现状为 zh-only，ChatGPT 有中英双语——共享键同步补齐英文。

## 9. 兼容与迁移

- 老用户升级后：池文件不存在 → 读路径把旧单账号凭据投影为 `acc_primary` 主账号，UI 显示"已登录 1 个账号"，与截图中 Antigravity 的表现一致；首次增删账号时投影落盘。
- 旧版明文 JSON（若还存在）仍按现有 FileCredentialStore 的迁移逻辑先加密再投影。
- 所有 DTO 新字段均为可选，旧版 client 不受影响。

## 10. 安全约束（沿用仓库 AGENTS.md 红线）

- Token 不出 Host：账号列表/状态 DTO 不含 access/refresh token 与 apiKey。
- 三平台加密存储与写后读回校验逐线路复用现有后端类。
- 所有变更型 POST 保持同源校验；不引入端点覆盖配置；日志不打印凭据。
- 池大小设软上限（建议 20），防止误操作/滥用导致的存储膨胀。

## 11. 分期实施计划

| 阶段 | 内容 | 验证 |
|---|---|---|
| P0 | `common/account-pool.ts` 泛型核 + 单测（序列化、迁移投影、冷却、策略、写回校验） | `test/account-pool-core.test.ts` |
| P1 | Command Code 全链路（池 + 路由 + adapter 轮换环 + UI 接入共享组件） | `command-code-account-pool.test.ts`、routes 测试、jsdom UI 测试 |
| P2 | Kimi Code 全链路（含按账号刷新、跨区混池、429 分类不轮换） | 同上 + 刷新轮换写回测试 |
| P3 | Codex 全链路（OAuthService 池化、responses-client 轮换环、usage-service 活跃账号、SSE 登录入池、Tab 换皮） | 现有 oauth-service/responses-client 测试扩展 + 迁移测试 |
| P4（可选） | Antigravity 迁到泛型核；配额感知路由（codex wham 窗口参与资格过滤，对齐 codex-proxy）；会话粘性策略 | 回归全量测试 |

每阶段独立可发布：池功能对单账号用户完全不可见（UI 只有一个账号卡片）。

## 12. 风险与开放问题

1. **Codex refresh token 轮换的并发写**：两个并发流同时刷新同一账号 → 泛型核沿用 `refreshPromise` 去重模式（按账号 id），失败只标 `expired` 不删账号。需要单测覆盖。
2. **配额缓存的账号归属**：三条线路的 quota 缓存目前都是全局单份，池化后必须按 accountId 键控，否则 UI 会展示错账号的配额。
3. **轮询策略打破上游缓存亲和**（见 7.3），MVP 接受；如需缓解再加 `sticky` 策略。
4. **Kimi 套餐型 429 不误轮换**是必要正确性约束，测试必须覆盖。
5. **账号数软上限**、`relogin` 入口的交互细节（ expired 账号卡片上的按钮 vs 重新走"添加账号"）建议在 P1 的 UI 联调中定稿。
6. 术语统一：UI 文案中"号池"一词仅出现在文档/代码注释，用户面文案用「账号管理 / 调度策略」（与现有 Antigravity 文案一致）。
