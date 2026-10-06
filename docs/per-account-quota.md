# 配额归属账号：进度画进账号行

> 状态：已实现。改动前先读本文，尤其是 §4 的边界——它们决定了「为什么某个账号没有进度条」。
> 相关：`docs/design-multi-account-pool.md`（号池设计）、`docs/settings-hub-redesign.md`（设置页概览/钻取）。

## 1. 为什么

配额是**账号的属性**，不是线路的属性。号池按调度策略决定下一个请求由哪个账号承担，所以线路级的那一份 `quota` 只描述了「读取它的那一刻恰好活跃的账号」：

- 轮询/粘性策略下，页面级配额区块显示的可能是 A 账号的数字，而正在服务的是 B；
- 账号切换后旧数字仍留在页面上，看起来像新账号的（antigravity 的路由里为此专门写了注释并 `clearCachedQuota()`）；
- 多账号用户最需要的信息——「哪个号快用完了」——根本无法表达。

因此：**每个账号的进度条画在它自己的账号卡片里**，页面级区块只保留没有「按账号进度条」可放的事实。

## 2. 契约

`src/shared/account-pool-contracts.ts`：

```ts
interface PoolAccountSummaryDto {
  // …
  /** 该账号最新一次被读到的配额快照；缺失 = 从未读过（≠ 未消耗）。 */
  quota?: PoolAccountQuotaDto
}

interface PoolAccountQuotaDto {
  windows: PoolAccountQuotaWindowDto[]
  /** 读取时刻（Unix 毫秒），不是被服务出去的时刻。 */
  fetchedAt: number
}

interface PoolAccountQuotaWindowDto {
  label: string                    // 线路自己的窗口名，可为 ''（由长度命名）
  usedPercent: number              // 0-100
  windowDurationMins?: number | null
  resetsAt?: number | null         // Unix 毫秒
}
```

`src/host/common/account-quota.ts` 是唯一的归一化入口：

- `quotaWindow(label, usedPercent, {windowDurationMins, resetsAt})`：**`usedPercent` 没被测到时返回 null**。null 不是 0——「未测量」和「没消耗」是两句不同的话，进度条只能画后者。
- `poolQuota(fetchedAt, windows)`：没有读取时刻就不是快照，返回 undefined。
- `quotaResetMs(value)`：秒/毫秒按量级区分（10^10 秒已是 2286 年）。

挂载点是共享池核既有的 `hooks.extendSummary(account, summary, now)`（`src/host/common/account-pool.ts`）——每条线路一处，不需要动任何路由。

## 3. 各线路的发布来源

| 线路 | 快照来源 | 按账号键 | 说明 |
|---|---|---|---|
| chatgpt | `UsageService` 的 per-account Map（本就存在，供池子跳过耗尽账号） | **号池行 id**（`snapshotKeyFor`；无池时回退 `identityKey(credentials)` = accountId ?? email ?? planType） | 新增 `snapshotFor(accountId, credentials)` 只读访问器 + `codexAccountQuota()` 纯映射（含 `primary`/`secondary` 回退，与配额卡片一致）；`OAuthService.credentialSelection` 把凭据连同它所属的行一起交回 |
| claude | `claude/client.ts` 的有界 Map | **号池行 id**（`fetchAccountQuota({accountId})`；无池时回退 token 尾 8 位） | 单槽 → 有界 Map（按 `observedAt` 淘汰：只靠响应头保持新鲜的快照没有 `fetchedAt`）；`getCachedQuota(credentials?)` 语义不变，池化读取走 `cachedQuotaForPool(accountId, credentials)` |
| kimi-code | `kimi-code/client.ts` 的单槽缓存（原带 `quotaAccountId`） | 账号 id（`''` = 单凭据读取） | 单槽 → 有界 Map；`getCachedQuotaFor(id)` 现在回答「该账号自己的那份」而不是「最后一次写入的那份」 |
| command-code | `command-code/client.ts` 的单槽缓存（原带 `accountId`） | 账号 id（`''` = 未具名调用方） | 单槽 → 有界 Map；`getCachedQuota()` = 最新、`getCachedQuotaFor(id)` = 该账号、`getCachedQuotaFor(null)` = 最新（保持池化前语义） |
| workbuddy | `workbuddy/client.ts` 的单槽缓存 | `snapshot.account.id` | 单槽 → 有界 Map；routes 的状态读取改为按键取「被选中账号」的那份，不再因为一份槽装不下别的账号而 `clearCachedQuota()` 丢掉所有兄弟快照 |
| minimax-code | `minimax-code/client.ts` 的**全局**槽（原本完全没有账号键） | 读取时归属到的账号 id | 单槽 → 有界 Map；`getQuotaReadTarget()` 按池核自己的「无 id」规则（active → primary → first）确定这次无凭据读取属于谁，再经 `getFreshCredential(id)` 取凭据，单飞刷新与写回仍留在池核内 |
| antigravity | `antigravity/client.ts` 的全局槽 | 无（见 §4.2） | 只挂到 primary 行 |
| ollama | 无配额（`ollama-contracts.ts` 明确说明：只有消耗，没有额度） | — | 已有按 key 的 token 消耗显示，本次不动 |

**有界 Map** 与 `UsageService.rememberSnapshot` 同一策略：上限 20，淘汰最旧的一条（chatgpt/claude 之外的线路按 `fetchedAt`，claude 按 `observedAt`）。

## 4. 边界（为什么某个账号没有进度条）

1. **只发布已经读到的快照，不新增任何上游请求。** 打开设置页不会为 N 个账号发 N 次请求（各线路 TTL 60–300 秒，多账号时很容易触发限流）。从未被读过的账号显示「尚无配额数据」——这句话是准确的，且与「未消耗」不同。测试直接对 `listAccounts()` 前后的 fetch 计数断言为 0。
2. **antigravity 的快照只属于 primary。** 它的配额读的是 legacy 单凭据文件，而池子只把 primary 镜像进去；轮询/粘性下活跃账号可能是别的号。所以快照挂在 primary 行上（它真正的主人），其余行不编造。
3. **workbuddy 的配额跟随被选中账号**（`settings.selectedAccountId`），与轮询活跃账号可能不同——快照按它自己的账号 id 归属，不做二次推断。其「计费周期」窗口只在没有 `cycle` meter 时才发布：该线路已把周期计数做成 `cycle` meter，否则同一份额度会画成两根条。meter 既无 `usedFraction` 也无 `remainingFraction` 时**丢弃**，不写 0。
4. **chatgpt 与 claude 的快照按号池行 id 归属**，不按凭据推导出的身份。两个理由：token 每次刷新都会轮换（claude 曾以 token 尾 8 位为键，于是每次刷新后该行短暂显示「尚无配额数据」，死键还会把兄弟账号的活条目挤出 20 条上限），而 chatgpt 的 `accountId ?? email ?? planType` 对两个都不带这些字段的账号会退化成同一个键——两行于是显示对方的数字。行 id 是唯一同时**跨刷新稳定**且**跨账号唯一**的身份。无池的组合仍回退到凭据身份（`identityKey` / token 尾）：此时进程里只有一个账号，不存在串号问题。`OAuthService.credentialSelection` 提供「凭据 + 它所属的行」，`UsageService` 在 401 重试后会重算键——续期可能落到另一个账号，读数属于真正作答的那个。
5. **无按需刷新按钮。** 每行加「刷新」意味着 host 要为 7 条线路新增按账号读取路径（其中 chatgpt/antigravity 目前没有账号参数化的读法）。这是明确的后续项，不是遗漏。
6. 快照的**读取时刻**总会显示；跨天的快照会带上日期，避免「12:03」被读成刚刚。
7. 各线路的 `clearCachedQuota()` 调用点（保存密钥、账号动作、登出、切换选中账号）保持原样：有了按账号查询后它们对正确性已非必需，但收窄失效策略超出本次范围。一个测试钉住了关键的一半：为某账号读状态不会毁掉兄弟账号的快照。

### 4.1 两个「未测量被写成 0」的解析器

同一类隐患在两条线路上各出现一次，处置不同：

- **antigravity（已修）**：`client.ts` 曾把缺失/非数值的 `remainingFraction` 强转成 `0`，而 0 剩余 = 100% 已用，于是服务端根本没测量的 bucket 被画成「已用尽」。现在 DTO 字段是 `number | null`，未测量即 null：映射层不发布该窗口（页面级已无逐 bucket 行，见下），composer 徽标改为在同类里跳过未测量的 bucket 取下一个已测量的、全组都未测量则显示 `—`。真实上报的 `0` 在四处都仍然照画（含 `已用尽` 与 `aria-valuenow="100"`），有反例测试钉住。既有测试只钉了「有值时的 clamp」，没有钉「缺失→0」，所以未改动它们。
- **command-code（核实为非问题）**：`parseUsageWindows` 里 `normalizePercent(percent) ?? 0` 的 `?? 0` 是**不可达分支**——`asNumber` 只接受有限数，`normalizePercent` 对有限数总是返回被 clamp 的值；而未声明百分比的记录在第 514 行直接 `continue`，根本不会生成窗口。因此该线路不会伪造 0% 窗口，无需改动。

## 5. 客户端渲染

- 新增 `src/client/common/account-quota.tsx`：`AccountQuota`（标签 + 进度条 + 百分比 + 重置时刻 + 快照时刻）、`formatQuotaPercent`、`formatQuotaReset`（**一律相对时间**：分钟/小时/天，走 `Intl.RelativeTimeFormat`，共享卡片因此天生双语；早前「近处相对、远处日期」的写法已取消，因为同一列里两种口径会读成两件事）、`quotaWindowLabel`（线路标签 → 长度命名 → 兜底名）、`formatQuotaSnapshot`（非当天才显示日期）。
- `AccountPoolSection` 在账号详情之后渲染该组件；`showQuota` 由线路声明「本线路是否有配额概念」，`anyQuota`（任一兄弟账号有快照）决定未读账号是否显示占位句。Ollama 不传 `showQuota`，因此不会长出无意义的占位行。
- 配色与页面级进度条同语言：`data-level` 的 normal/warning(≥80)/danger(≥95)，`role="progressbar"` + `aria-valuenow`，`aria-label` 带「已用」。
- 页面级配额区块（7 条线路）：**去掉进度条**，保留 credits/月消费/额外用量/重置卡/错误/陈旧/更新时间等事实，并加一行共享说明 `quotaFactsScope`（「以下为当前账号的配额事实；每个账号自己的进度显示在它的账号卡片里」）。claude 的逐窗口事实（已用/剩余/重置倒计时/来源）随其进度条一起移入账号行；workbuddy 的非进度 meter 事实保留（并补上了原先没渲染的描述行）。
- 新增共享标签键（`account-pool-labels.ts`，各线路 spread 自动获得）：`accountQuota`、`quotaNone`、`quotaSnapshot`、`quotaResets`、`quotaExhausted`、`quotaWindow`、`quotaUsed`、`quotaFactsScope`、`composerLabel`（composer 徽标的前缀词「额度」，原先各线路写死，现随语言切换）。
- **共享标签不得被线路本地同名键覆盖。** 各线路的 locale 是 `...accountPoolZh` 展开的，线路自己定义同名键会静默胜出，共享卡片于是拿到「本线路的措辞 + 卡片永远不会填的占位符」——minimax 的 `quotaUsed: '已用 {percent}%'` 就是这样进了账号行进度条的 aria-label（读屏念成「…25% 已用 {percent}%」）。已把该本地键改名为 `quotaUsedShare`，并加了 `test/account-quota-labels.test.ts` 跨 7 条线路（含中英）钉住：共享配额键在每个 tab 里都必须等于共享字典的值。workbuddy 不在此列——它的 tab 是中文单语，且共享集是在 section 内 spread 的，本地条目无法覆盖，三处有意的覆盖写在一个六行函数里。
- **标签表必须用对象字面量声明**（ChatGPT 与 MiniMax 两处按 key 手工装配）：漏键会变成编译错误，而不是运行时的 `undefined.replace`。

## 6. 测试

- `test/account-quota.test.ts`：归一化（秒/毫秒、未测量丢弃、无读取时刻即无快照、ChatGPT 的 windows/primary 回退）。
- `test/account-quota-ui.test.tsx`：行渲染、等级、aria、占位句的两种开关、双语标签、快照跨天带日期、重置远近两种形态。
- `test/account-quota-labels.test.ts`：共享配额标签在 7 条线路的中英字典里都存在、且不被本地同名键覆盖（见 §5）。
- `test/account-pool-section.test.tsx`：两个账号各自独立的读数（不是同一个数字画两遍）；占位句只在有配额概念的线路上出现。
- `test/codex-account-pool.test.ts`：端到端——先无快照（不谎报 0），读 A 再读 B 后两行各自显示自己的百分比，第三个从未读过的账号仍为空。
- `test/client-registration.test.ts`：ChatGPT 标签页里进度条在账号行内、页面级区块无进度条且保留事实与范围说明。
- 各线路自己的 host 测试：`claude-quota-accounts`、`kimi-code-quota-accounts`、`command-code-quota-accounts`、`workbuddy-quota-accounts`、`minimax-code-account-quota`、`antigravity-account-quota` —— Map 区分账号、超过 20 条淘汰最旧、`extendSummary` 有/无快照两种情况、未测量窗口被丢弃、列账号不发请求。
- 行 id 语义的两条钉子：`test/claude-quota-accounts.test.ts` 里「token 轮换后同一行仍取到自己的快照（而 token 尾形式取不到）」与「另一行绝不会被答以这条的读数」；`test/codex-account-pool.test.ts` 里「两个 `accountId`/`email`/`planType` 全缺的账号各自保留自己的读数」。
- 各线路的 jsdom 行渲染测试：`claude-quota-ui`、`kimi-code-quota-ui`、`command-code-quota-row`、`workbuddy-quota-row`、`minimax-code-account-quota-row`、`antigravity-account-quota-row`。

## 7. 明确不做

- 不为每个账号在页面打开时拉取配额（见 §4.1）。
- 不新增按账号的配额刷新路由（见 §4.5）。
- 不为配额缓存加 per-account `forget` API：上限 20 的淘汰 + 既有 `clearCachedQuota()` 已覆盖。
- 不让配额进入 hub 概览 DTO：`hub-contracts.ts` 的边界注释仍然成立（概览只报账号数/认证态/模型数）。
- 不动 composer 上的配额徽标（那是对话输入区，不是设置页的配额区块）。
