# 订阅服务设置页重塑：最终方案

> 状态：已确认的决策基线。任何后续会话改设置页前，先读本文件。
> 决策来源：2026-10-06 与用户的四轮确认（Logo=复用 claude-style 品牌 SVG；数据=新增 host 聚合路由；范围=Hub 重绘+全部 8 个 Section 模型列表；导航=替换式+顶部返回条）。

## 1. 信息架构

```
设置 › 订阅服务（settings.section: subscription-hub）
├── 概览层 HubOverview          ← 开屏页，QQ邮箱式供应商卡片列表
└── 二级层 ProviderDetail       ← 替换式钻取，顶部返回条 + 现有 Section 原样挂载
```

- **概览层只承载两个交互**：卡片上的启用开关（toggle）、点击卡片钻取二级页。其余一切（账号、配额、模型、代理……）都在二级页。
- **TAB 条（`dsh-hub-tabs`）整体删除**，由 drill-in 导航替代。二级页不套 TAB，一次只挂载一个供应商 Section（与现状一致：各 Section 在 mount 时自取 status）。
- **导航状态机**：`{ view: 'overview' } | { view: 'detail', id: HubProviderId }`，持久化到 `sessionStorage['dsh-chatgpt-subscription:hub-view']`——刷新/重开设置页直达上次供应商；会话结束自然归零。失败兜底：存储值非法或该供应商已下线时回 overview。

### 概览卡片（QQ邮箱语言）

```
┌──────────────────────────────────────────────────────┐
│ [logo]  ChatGPT                         [switch]  ›  │
│         3 个账号 · 8 个模型已启用                      │
├──────────────────────────────────────────────────────┤
│ [logo]  Ollama                                    ›  │  ← 无开关（无 enabled 概念）
│         2 个 API Key                                  │
└──────────────────────────────────────────────────────┘
```

- 卡片 = 一整行 `<button>` 语义的可点击区，开关是行内独立按钮（`e.stopPropagation()`，不触发钻取）。
- 注释行（annotation）只讲两件事：**账号数**、**启用状态**；有模型计数数据时追加 `N 个模型已启用`。未启用供应商整卡降透明度（`opacity .55`），注释行显示「已停用」。
- 账号数为 0 显示「暂无账号，点击进入添加」——空态即引导，与 QQ邮箱「添加账号」语义一致。

## 2. 数据层：host 聚合路由

新增只读端点，挂在既有 ChatGPT 前缀下（GET 无需 same-origin 校验；其余方法一律 405）：

```
GET /api/dsh-chatgpt-subscription/hub/overview
→ ApiEnvelope<HubOverviewDto>
```

`src/client/hub/brand-svg.ts` 之外，**路由优先级有一条硬约束**：`src/host/routes.ts` 以 `kind: 'prefix'` 挂在 `/api/dsh-chatgpt-subscription` 上，并对该前缀下所有非 POST 请求回 405。harness 的 `ctx.webServer` 匹配顺序是「先 exact 表、再最长前缀」，所以同前缀的 exact GET 能正常命中；这条依赖由 `test/hub-overview-routing.test.ts` 用**真实的两个注册**钉住（它同时断言 `/status` 仍 200、`/preferences/update` 的 GET 仍 405、前缀外仍落回退）。

```ts
// src/shared/hub-contracts.ts
export interface HubProviderSummaryDto {
  /** 客户端 descriptor 的键，如 'chatgpt' | 'kimi-code' | 'ollama'。 */
  id: string
  /** LLM 路由 id，如 'codex-chatgpt'、'workbuddy-subscription'。 */
  providerId: string
  /** 是否有「启用供应商」开关；Ollama 为 false。 */
  canToggle: boolean
  enabled: boolean
  accountCount: number
  /** 有 routable 账号即为 true；accountCount 的语义化别名，供卡片排序/置灰。 */
  authenticated: boolean
  /** 已启用模型数；无法本地确定时为 null（卡片不显示该项）。 */
  enabledModelCount: number | null
  totalModelCount: number | null
}
export interface HubOverviewDto { providers: HubProviderSummaryDto[] }
```

装配方式：`src/host/hub-overview.ts` 导出

```ts
export interface HubSummarySource {
  id: string
  providerId: string
  canToggle: boolean
  /** 该线路自己的读法；id/providerId/canToggle 由装配层补齐，read 不重复声明。 */
  read(): Promise<Omit<HubProviderSummaryDto, 'id' | 'providerId' | 'canToggle'>>
}
export function registerHubOverviewRoutes(ctx: Context, sources: readonly HubSummarySource[]): () => void
```

`index.ts` 的大 effect 里各线路的 store/pool/preferences 均在作用域内，逐一构造 source：

| id | enabled 来源 | accountCount 来源 | 模型计数 |
|---|---|---|---|
| chatgpt | `preferences.status().enabled !== false` | `codexAccountPool.listAccounts()` | `visibleModelIds.length` / `CODEX_MODEL_CATALOG.length` |
| antigravity / command-code / kimi-code / minimax-code / workbuddy / claude | `preferences.status().enabled !== false` | 各自 `accountPool.listAccounts()` | `enabledModelIds.length` / null（目录需联网，不取） |
| ollama | canToggle=false, enabled=true | `ollamaAccountPool.listAccounts()` | null / null |

单条线路 read 失败不拖垮整表：`Promise.allSettled` 后失败线路以 `accountCount: 0, enabledModelCount: null` 降级返回，并附 `error: true` 让卡片显示「状态读取失败」。全部本地读（preferences 内存快照 + pool 文件），无上游调用。

**开关变更不走聚合路由**：概览卡片的 toggle 直接调各线路既有端点（`POST {prefix}/settings {enabled}`；ChatGPT 用 `/preferences/update`），成功后用返回的 status 就地更新该卡，再后台刷新一次 overview 对齐账号/模型计数。这样 host 侧聚合层保持纯只读，没有第二份 mutation 逻辑。

## 3. 客户端结构

```
src/client/
├── ProviderHubSection.tsx        ← 重写：导航状态机 + 返回条，不再持 TAB（~110 行）
├── hub/
│   ├── providers.tsx             ← 8 条 descriptor：id/name/setEnabled/renderDetail + 各线路 POST 端点
│   ├── HubOverview.tsx           ← 概览页：拉 overview、卡片（含内联 ProviderCard）、乐观 toggle、骨架/错误态
│   ├── brand-icons.tsx           ← HubProviderId 联合类型、PROVIDER_BRANDS、BrandMark/BrandTile、modelBrandMark 规则
│   ├── brand-svg.ts              ← 生成物：9 个品牌 mark 的内联 SVG（viewBox 已按实测裁剪）
│   └── hub-styles.ts             ← 概览/返回条/开关样式（installHubStyles）
└── common/
    ├── ModelChecklist.tsx        ← 共享模型列表（claude-style 行语言）
    └── model-checklist-styles.ts ← 其样式（installModelChecklistStyles）
```

> 卡片没有独立文件：`HubProviderCard` 与 `HubOverview` 同文件，因为它只服务这一个页面、且共享后者的乐观更新状态；单独拆文件反而要把它需要的 4 个回调逐层透传。

### 3.1 ProviderHubSection（重写后）

```tsx
type HubView = { view: 'overview' } | { view: 'detail'; id: HubProviderId }

export function ProviderHubSection({ t, onModelChange, ...runtime }: Props) {
  const [state, setState] = useState<HubView>(() => readStoredView())   // sessionStorage，非法值回落 overview
  if (state.view === 'overview') return <HubOverview t={t} onOpen={open} />
  const descriptor = HUB_PROVIDERS.find((provider) => provider.id === state.id)!  // 由 open() 保证存在
  return (
    <div className="dsh-hub-detail">
      <nav className="dsh-hub-backbar">
        <button className="dsh-hub-back" onClick={back}>{`← ${t('hubBack')}`}</button>
        <span className="dsh-hub-backbar-name">{descriptor.name}</span>
      </nav>
      {descriptor.renderDetail({ t, onModelChange, runtime })}
    </div>
  )
}
```

要点：详情页不再渲染自己的页级标题——ChatGPT Section 的 `#dsh-codex-title` 由 `.dsh-hub-detail .dsha-page > header .dsh-codex-title{display:none}` 隐藏（返回条承担定位），其余 7 个 Section 本来就没有页级 `<h2>`，不做结构化删除。`renderDetail` 收 `runtime`（`PropsRuntime<'settings.section'>`，含 `close`）并透传给 Section，否则 ChatGPT Section 的 props 类型不完整。

### 3.2 共享 ModelChecklist（claude-style 行语言）

从 claude-style 模型选择器提炼的四件套：**品牌 lockup（行首）→ 模型名（500 字重）→ 单行描述（三级色，11px）→ 右侧选中态**，行高 32px、圆角 6px、hover 底色。行尾的选中态是圆点：选中为实心对勾，未选中为空心圈——比裸 checkbox 更贴近选择器语言，又保留多选语义。

```tsx
export interface ModelChecklistItem { id: string; name: string; hint?: string; enabled: boolean }
export interface ModelChecklistLabels {
  selectAll: string
  clearAll: string
  /** `{count}`/`{total}` 占位；缺省时不显示计数前缀。 */
  countTemplate?: string
  /** 列表自身 aria-label；Section 已有标题时省略。 */
  list?: string
}
export function ModelChecklist(props: {
  items: ModelChecklistItem[]
  busy: boolean
  onToggle(id: string, enabled: boolean): void
  onToggleAll(enabled: boolean): void
  labels: ModelChecklistLabels
}): JSX.Element
```

- 头部一行：计数 + `全选`/`全不选` 两个文字按钮（替代原先两个块级按钮）；两个按钮在「已经是该状态」时各自禁用（全选在全部启用时禁用，反之亦然）。
- 每行是 `<button role="checkbox" aria-checked>`，整行可点。
- 品牌解析在组件内部调 `modelBrandMark(id)`（`brand-icons.tsx`），按序正则命中 gpt/codex→openai、claude、kimi、minimax、gemini、qwen、deepseek、grok；无命中不渲染图标——宁可没有，不可错配（claude-style `brand.js` 的既定原则）。`test/model-checklist.test.tsx` 用一条 `some-unknown-model` 钉住这条。
- `busy` 时行与头部按钮全部禁用（提交中不接受第二次点击）。

**替换范围（8 个 Section 全部完成）**：
- `CodexSubscriptionSection.tsx`：hint = `formatCapacity(contextWindow) + t('tokens')`。
- `kimi-code`：hint = wire / 视频 / 动态工具 / 计划能力 join ` · `。
- `antigravity` / `workbuddy` / `command-code` / `claude`：hint 分别为上下文窗口、能力事实（窗口·图像·推理档）、wire 标签、`modelFacts().slice(1)`。
- `minimax-code`：hint = thinking 标签 + 描述（保留其「无模型」空态分支与自有字典）。
- `ollama`：沿用「空集合 = 全部启用」的既有语义，`isModelEnabled()` 映射为 `enabled`。
- 各 Section 原来的「全选/全不选」按钮块已删除，逻辑并入组件头部。

### 3.3 样式

- 新样式全部走 `installPluginStyle('hub', …)` / `installPluginStyle('model-checklist', …)`，不新增裸 `<style>`（`plugin-style.ts` 的所有权教训）。
- 颜色只用 DSH token（`--dsw-alias-*`）+ 本插件既有 `--dsha-*` 派生变量；暗色主题靠 token 自动适配，不写 `[data-ds-dark-theme]` 分支，除非实测有对比度问题。
- 开关：44×24 轨道、圆点滑动、`color-mix` 的品牌中性蓝，不用第三方开关库。

## 4. 品牌图标

`src/client/hub/brand-svg.ts` 是从 claude-style 的 `combine/*.svg` 生成的**内联字符串表**（mark 组 `.dsh-combine-mark-color` 的内容 + 实测裁剪后的 viewBox），`brand-icons.tsx` 只做映射与呈现，不再解析 SVG。

| 供应商 | mark 来源 | 卡面呈现 |
|---|---|---|
| ChatGPT | `combine/openai.svg` | 结形 mark，`#10A37F` |
| Claude | `brand/claude-mark.svg` | 方形 mark，`#D97757` |
| Kimi Code | `combine/kimi.svg` | `#1F1F1F` |
| MiniMax Code | `combine/minimax.svg`（含渐变 `<defs>`，id 已加 `dsh-hub-` 前缀防冲突） | 品牌色 |
| WorkBuddy | `combine/tencent.svg`（CodeBuddy 是腾讯产品） | 腾讯蓝 |
| Antigravity | `combine/gemini.svg`（Google 系） | Gemini 蓝 |
| Command Code | 无官方资产：单字标 `>_` | `#7C6AEF` |
| Ollama | 无官方资产：单字标 `O` | `#3B3B3B` |

另外 3 个 mark（grok / deepseek / qwen）不在供应商表里，但留在 `BRAND_MARKS` 中供 `modelBrandMark()` 认模型行——模型列表里出现 Grok/Qwen/DeepSeek 时不至于空着。

统一呈现在 40×40 圆角 tile 上（`--dsh-hub-brand` 变量承载品牌色，底色 `color-mix` 8%，暗色自动跟随 token）。单字标用同色系 700 字重字母。

## 5. 交互细则（与实现一一对应）

- **加载态**：overview 拉取中渲染 8 行骨架（`aria-hidden`），不渲染任何卡片；只有 `summaries === null` 时才走骨架，避免骨架与真卡同时存在。
- **整表失败**：`loadError !== null && summaries === null` 时显示 `role="alert"` 错误条 + `重试` 按钮（复用 `.dsh-codex-errorbar`，与各 Section 的错误条同语言）。
- **单线失败**：卡片注释行显示「状态读取失败」（`dsh-hub-note-danger`），其余卡片正常；开关在该线 `summary === undefined` 时禁用。
- **toggle 乐观更新**：立即翻开关 → 提交该线自己的端点 → 成功后 `void load()` 后台刷新以对齐账号/模型计数；失败则回滚 `enabled` 并把错误文案写进**卡片注释行**（红字），不弹 toast。提交中该卡开关 `disabled`。
- **toggle 与钻取互不阻塞**：开关 `onClick` 里 `stopPropagation()`，卡片主体（`role="button"` + `tabIndex=0`）是唯一钻取入口；卡片自身的 Enter/Space 只在 `event.target === currentTarget` 时触发钻取，所以焦点在开关上时空格只动开关。
- **a11y**：卡片 `aria-label` = 「名称，注释」（`hubCardLabel`）；开关 `role="switch" aria-checked` + 动作语义的 `aria-label`（未启用时读作「启用 X」，启用时读作「停用 X」）。
- **返回条**：`← 订阅服务` 在左，供应商名在右（面包屑末段不可点）。Esc 不绑定（设置页里 Esc 已有全局语义，不抢）。
- **记忆**：`sessionStorage['dsh-chatgpt-subscription:hub-view']` 存 `{ view: 'detail', id }`；非法值或未知供应商回落 overview。`HubOverview` 每次 mount 重拉 overview（账号数可能已在二级页变过）。

## 6. 重构范本与反例

### 6.1 优雅、高效、简洁的范本（保持并推广）

| 范本 | 位置 | 为什么是好范本 |
|---|---|---|
| 样式所有权标记 | `src/client/common/plugin-style.ts` | 20 行注释讲清一个真实的模块系统事故；`data-plugin-css` 幂等安装，stale fiber 的 teardown 永远拿不走样式 |
| 账户池线契约 | `src/shared/account-pool-contracts.ts` | DTO 即文档：每个字段注明语义边界（`removable` 的 absent=deletable），秘密永不越界 |
| 共享账户卡片 | `src/client/common/AccountPoolSection.tsx` | 一个组件 + 两个扩展槽（`renderDetails`/`renderAccountActions`）吃掉 8 个供应商的账户 UI 差异 |
| 线常数隔离 | `src/compat.ts` | 所有逆向得来的 wire 常数集中一处、逐条注释考古原因，review/回滚单点进行 |
| 默认值即空文档 | `src/shared/preferences.ts` | 「absent key = 用目录默认」让恢复默认等于不存储，迁移成本为零 |
| 字段级校验 | `src/host/routes.ts` `readPreferencesUpdate` | 每个字段独立校验、报错带字段名；`PreferenceError` 与 400 映射干净 |

### 6.2 暴力、丑陋、冗长的反例（按收益排序）

> 状态（2026-10-06 结构性重构轮）：1 / 2 / 4 / 5 / 6 / 7 已处理；3 部分处理（格式化与 context-window 编辑器已下沉到 `common/`，Section 的 hook 分层仍待做）。逐项结论见 §6.3。

| # | 反例 | 位置 | 问题 | 重构方向 | 结果 |
|---|---|---|---|---|---|
| 1 | 8 个 ComposerQuota 逐字复制 | `src/client/*/*ComposerQuota.tsx` | 两两 diff 仅 ~59 行差异（名字/端点/标签）；改 badge 逻辑要改 8 遍 | 抽 `common/ComposerQuotaBadge.tsx` | ✅ 6 支合并（ChatGPT 那支结构不同，见 §6.3）；每支只剩自己的 facts 选择器 |
| 2 | host 装配 7 段 claim-route 模板 | `src/index.ts` | 每段都是 `let registration/conflict + claimXRoute + watch` 三元组 | 抽 `claimProviderRoute(ctx, {providerId, label, adapter})` | ✅ 见 §6.3 |
| 3 | 巨型 Section 文件 | `MinimaxCodeSection.tsx` 39KB / `WorkBuddySection` 38KB / `ClaudeSection` 37KB / `CodexSubscriptionSection` 37KB | 数据获取、状态机、格式化、渲染四层混在一个函数体 | 下沉格式化到 `common/format.ts`、共享 context-window 编辑器；再拆 `useProviderStatus()` | ◐ 前两项已做；hook 分层待做 |
| 4 | fetchApi 每文件一份 | 10 个文件各自内联同一 `fetchApi` | 错误形状解析（`json.error` string vs object）各写各的 | `common/line-api.ts` 一个 `createLineApi(prefix, label)` | ✅ 10 份 → 1 个工厂（吸收了两处健壮性差异） |
| 5 | locale 命名空间 `any` | `src/client/index.tsx` | 6 个命名空间声明为 `any`，键名漂移编译期不可见 | 各 locales.ts 导出 `LocaleKey` 并填入 `LocaleNamespaceMap` | ✅ 7 个命名空间全部类型化 |
| 6 | quota badge 注册 × 8 | `src/client/index.tsx` | 8 段只差 order/locale/组件的 `slots.inject` | 表驱动注册 | ◐ 重复的 inject 工厂已集中为 `composerBadgeInject`；组件列表仍是 7 处显式 `register`，理由见 §6.3 |
| 7 | ~~TAB 条挂载全部语义~~ | `ProviderHubSection.tsx` | 横向滚动条 + 键盘导航 + scrollIntoView 守卫 | drill-in 替代 | ✅ 已完成（§3.1） |

## 6.3 结构性重构的结论（2026-10-06）

### 已完成

| 项 | 共享模块 | 关键取舍 |
|---|---|---|
| fetchApi ×10 | [`common/line-api.ts`](../src/client/common/line-api.ts) | 工厂取的是**十份的并集**：既读 `error` 为字符串（兄弟线路的形状）也读 `{code,message}`（ChatGPT 路由的形状，旧代码会印出 `[object Object]`），并保留 workbuddy 那份对**空响应体/非 JSON** 的容忍（那正是「客户端比 host 新」的表现）。另修掉一个真缺陷：`{ok:false,error}` 没有 `value` 键时不再被当成正常载荷。 |
| 7 段 claim-route | [`host/common/provider-route.ts`](../src/host/common/provider-route.ts) | 适配器类型从 `ctx.llm.registerAdapter` 推导（不引入具体适配器类）；两处真实差异被**显式化**而非抹平——Ollama 从不监听 `llm/adapters-updated`（`watch: false`），以及无事件接缝的旧 harness 仍要能拿到路由。冲突串与两条日志原文保持不变。 |
| 6 支 ComposerQuota | [`common/ComposerQuotaBadge.tsx`](../src/client/common/ComposerQuotaBadge.tsx) | 只合并骨架，**facts 选择器留在各线路**——那才是值得读的部分。回调走 ref 而非依赖：六个调用方现在都传内联箭头，回调若进依赖数组就会让 60 秒轮询每次渲染重启（旧副本各自以稳定的 prop 渲染，因此没有暴露过这个约束；ref 让共享组件的调用形态不再依赖调用方的小心，测试钉住的是新形态）。ChatGPT 那支**故意不合并**：它用 `dsh-codex-composer-quota` 类名（自带样式）、没有 `-label`/`-val` 子元素、没有 `title`（只有 aria-label）、**没有点击刷新**、且受 `quickQuotaVisible` 偏好门控并用自己的字典键——合并等于把共享组件改成五个开关的配置器，比留一份 60 行的独立实现更难读。 |
| locale `any` ×7 | 各 `locales.ts` 的 `XxxLocaleKey` | 5 条线路其实早已导出该类型，只是 `LocaleNamespaceMap` 没接上；antigravity 补上后全部类型化。 |
| badge 注册 ×7 | `composerBadgeInject`（`src/client/index.tsx`） | 逐字重复的 8 行 seat 工厂集中为一处，7 段注册由 7 行 ×7 压到 4 行 ×7。**没有**做成组件表，且这次是实测结论而非推测：`ctx.slots.register` 既对 slot key 又对 locale 命名空间泛型、且是重载函数，组件 props 由两者组合而成；异构表会抹掉「这一行的 locale 与 component 的对应关系」，而一个保留该对应关系的泛型 helper 会在**自身函数体内**因命名空间参数尚未实例化而重载解析失败（两种写法都试过）。两条路都会以对 harness 内部 composed-props 类型的 cast 收场，即新增版本敏感接缝（AGENTS.md 红线）。 |
| 目录计数 | `catalogTotal`（[`host/common/catalog-snapshot.ts`](../src/host/common/catalog-snapshot.ts)） | 概览卡片的 `N/M 模型` 由各线路**已经持有的目录**回答：Antigravity/Command Code/Kimi Code/Ollama 读模型设置里持久化的那份，Claude/WorkBuddy/MiniMax Code 读内存缓存，ChatGPT 用静态目录。**空目录报 null 而不是 0**——「还没同步」与「没有模型」是两句不同的话，前者不该显示成后者。 |
| 格式化 ×6 + context-window ×6 + `contextDraftsFor` ×6 | [`common/format.ts`](../src/client/common/format.ts)、[`common/ContextWindowEditor.tsx`](../src/client/common/ContextWindowEditor.tsx) | 编辑器保留全部 `dsha-context-*` 类名、逐行 `aria-label` 与禁用语义（6 个 `*-context-window` 测试即安全网）；`inputLabel`/`meta`/`metaClassName` 之所以可选，是因为确实有线路不带 aria-label、不显示有效窗口、或用自己的类前缀。合并时发现 antigravity 的 `formatCapacity` **并非逐字相同**——它缺了 1K 下限，会把 0 渲染成 `0K`；统一取其余五份的行为。 |
| `useStore` ×2 | [`common/use-store.ts`](../src/client/common/use-store.ts) | 两处逐字相同。先前只把它留在徽标组件里，等于「搬迁」而非去重；现在两个使用者从同一个模块引入。 |
| 死字段 | `AntigravityModelOption` | `remainingFraction` / `quotaSummary` 无写者无读者，直接删除。 |

### 故意没有合并的重复（连同原因）

- **ChatGPT 的 `formatDate`**：它收的是**秒**并按量级启发式乘 1000（`> 10^10` 视为已是毫秒），调用方传的正是秒（`connection.checkedAt`、`quota.fetchedAt`）；共享版收毫秒，直接替换会让这些时间戳差 1000 倍。留在原处。
- **`formatPercent` 两份**：Section 那份接受 `number|null|undefined` 且保留 1 位小数，composer 那份只接受 `number` 且 0 位小数；合并必然改变其中一个界面的可见舍入，因此保持两份而不是挑一个「赢家」。
- **一处无测试覆盖的 DOM 变化**：统一后 antigravity 的模型名 span 也带上了 `title={id}`（其余五行本来就有）。这是本次抽取中唯一未被测试钉住的属性变化；若不需要，去掉即可。

### Section 分层（⑥）

巨型 Section 按「状态/动作 → hook，JSX → 组件」拆开，三个最大的都做了：

| Section | 视图（拆分前 → 拆分后） | 新 hook | hook 形状 |
|---|---|---|---|
| claude | 34.4KB → 20.2KB（911 → 478 行） | `useClaudeSection.ts` 20.8KB | `{ state, derived, actions }` |
| minimax-code | 36.1KB → 18.8KB（915 → 429 行） | `useMinimaxCodeSection.ts` 23.6KB | 同上（并顺带把 `poolAction` 的 `action: string` 收紧成实际传入的联合类型） |
| workbuddy | 34.2KB → 16.6KB | `useWorkBuddySection.ts` 25.2KB | 同上 |

规则：**纯搬运**——端点、请求体、请求顺序、`busy` token、effect 依赖数组、轮询节奏、`quiet` 语义、默认值一律不变；导出的符号留在原路径原名（`ClaudeSection`、`MinimaxCodeSection` + `remainingHours` 等，测试可能直接 import）。hook 返回命名形状而不是整个 state 对象。视图里**故意留下**的只有纯展示逻辑（如 claude 的 `modelFacts`、minimax 的 `thinkingLabel`/`remainingHours`）与绑定给它们用的 `t`——`Translate`/`fallbackTranslate` 放在 hook 文件里，两层共享同一个字典标识，这样 effect 依赖数组不用改。

一处**行为等价但值得知道**的差别：`account`/`quota`/`models`/`contextModels`/`overrideCount` 这类派生值现在每次渲染都算（包括 loading 那次渲染），此前在 loading 早退之后才算。全是纯计算，渲染输出不变。

### 重构中发现、按要求未改的问题（供后续决定）

拆分被要求「只搬运、不顺手修」，所以下面这些是**读到了但原样保留**的问题，都是有意的欠账而非遗漏：

- **动作未置 `busy`**：claude 的 `updateEffort` / `updateCacheTtl` / `applyEnabled` 不设 `busy`，因此这些控件在请求飞行中仍可点（共享的 `busy !== null` 禁用闸门对它们不生效）。
- **静默刷新失败会留下过期错误条**：claude 的 `loadStatus(true)`（quiet）失败时既不设也不清 `error`，后台轮询失败会让上一次的错误条一直挂着。
- **部分动作不重播草稿**：claude 的 `stopImporting` / `accountAction` / `setStrategy` / `refreshQuota` / `testConnection` 在 `setStatus` 后不重新播种 `contextDrafts`；今天无害（这些路由不改模型列表），但依赖了「路由恰好不改列表」这一前提。
- **归一化不一致**（workbuddy）：`loadStatus` / `rescan` / `accountAction` / `checkinNow` / `updateCheckin` / `refreshCatalog` / `toggleModel` / `setAllModels` / `resetContextWindow(s)` 走 `normalizeStatus`，而 `refreshQuota` / `saveContextWindow` / `updateEffort` 直接存原始载荷。
- **类型重复**（workbuddy）：hook 里的 `ConnectionPayload` 与 `shared/workbuddy-contracts.ts` 的 `WorkBuddyConnectionDto` 逐字段相同，可以直接换成共享类型。
- 冗余断言：claude 的 `(status?.accounts ?? []) as ClaudeAccountSummaryDto[]`；minimax 的 `poolAction` 收 `action: string`（已顺手收紧为联合类型，属类型层面、无行为变化）。
- 悬空/失实注释（逐一保留原样，除了 `test/account-quota-labels.test.ts` 里那处已随分层修正）：minimax 有一处 `applyEnabled` 的文档注释挂在 `loadPool` 上方；`accountPoolLabelsFor` 的注释提到一个并不存在的 `satisfies`；workbuddy 的 `poolAccounts` 注释还留着「在没有 pool 的 host 上回退到单账号视图」这半句，而该视图并不存在。

### 待做（本轮之后）

- §6.2 反例 6 的组件表：需要 harness 先暴露一个不依赖 composed-props 内部类型的注册入口（本轮已实测两条路线都会以 cast 收场）。
- 上面那张欠账清单；每条都改动可见行为，适合独立一轮、逐条带测试做。
- ChatGPT 的 `CodexSubscriptionSection.tsx`（37KB，本轮未拆，目标只点名 minimax/claude/workbuddy）可按同一模式继续。

## 7. 实施清单（本次设置页重绘）

1. ✅ `src/shared/hub-contracts.ts`：DTO + `HUB_OVERVIEW_PATH`。
2. ✅ `src/host/hub-overview.ts` + `src/index.ts` 装配 8 个 source（`Promise.allSettled` 降级、GET-only 守卫）。
3. ✅ `src/client/hub/*`：providers / HubOverview（含卡片）/ brand-svg / brand-icons / hub-styles。
4. ✅ 重写 `src/client/ProviderHubSection.tsx`（导航状态机 + 返回条）。
5. ✅ `src/client/common/ModelChecklist.tsx` + 样式，替换全部 8 个 Section 的模型块。
6. ✅ locales：hub 与 model-checklist 相关新键（中英各 14 个）。
7. ✅ 测试（全部通过）：
   - `test/hub-overview.test.ts`：聚合路由（DTO 形状、单源失败降级、并发、GET-only）。
   - `test/hub-overview-routing.test.ts`：**真实两套注册**下的 exact-vs-prefix 优先级与既有路由不受扰。
   - `test/hub-overview-ui.test.tsx`（jsdom）：卡片渲染、注释拼接、toggle 乐观更新与回滚、drill-in、整表失败重试。
   - `test/model-checklist.test.tsx`：行渲染/品牌解析/toggle/全选清空/禁用态。
   - 随 TAB 删除与新行结构更新的既有测试：`client-registration`、`client-styles`、`claude-ui`、`minimax-code-card`、`ollama-section`、`workbuddy-section-pool`、`antigravity/command-code/workbuddy-context-window`。
8. ✅ `npm run typecheck && npm test && npm run build` 全绿（2389 passed / 9 skipped）。
9. ⏳ 浏览器/GUI 实拍核验（亮/暗主题）：客户端半区已随页面加载生效；**host 半区需要一次插件重载**（`/hub/overview` 在旧进程里被 `routes.ts` 的前缀兜底回 405），重载后按 §2 的地址复核一次即可。

## 8. 后续会话清单（结构性重构轮之后）

- ✅ §6.2 反例 1–6 的去重重构：host 装配模板化（②）、ComposerQuota 合并（①）、fetchApi 工厂（③）、locale 类型化（④）、badge inject 去重（⑤）、格式化与 context-window 下沉（⑥ 前半）。逐项结论与**故意没合并**的重复见 §6.3。
- ◐ 巨型 Section 的四层拆分：格式化已下沉到 `common/format.ts`，context-window 块已共享；状态/动作分层已按供应商逐个做（claude 完成，minimax/workbuddy 见 §6.3 表格）。剩余 Section（ChatGPT）可按同一模式继续。
- ✅ 各线路 `totalModelCount` 的本地目录快照：已接上，`catalogTotal` 的「空目录 = 未知而非 0」不变量有测试。
- ⏳ §6.3 末尾列出的四个「重构中发现、未改」问题（未置 `busy`、静默刷新失败留过期错误条、部分动作不重播草稿、冗余断言）——都是小改动，但都会改变可见行为，留给独立一轮做。
- `temp/` 已清空：品牌 SVG 的生成器是一次性脚本（`combine/*.svg` → `brand-svg.ts`），若将来要补新品牌 mark，按同样方法重做并同步实测 viewBox，不要手改 `brand-svg.ts`。
- 发布后：`npm pack` 干净构建比对（AGENTS.md 发布规程）。

## 9. 风险与边界

- **路由优先级（已验证）**：`/hub/overview` 是 exact GET，`routes.ts` 是同前缀的 prefix 兜底；harness 先查 exact 表，故新路由可达。这条依赖写在 `test/hub-overview-routing.test.ts` 里，将来若有人把 overview 改成 prefix、或 harness 改匹配顺序，测试会立刻红。
- **聚合路由的读放大**：8 条线路各读一次 pool 文件，设置页打开一次共 ~8 次小文件 IO；pool 均有缓存/轻量 read，可接受。若实测慢，给 overview 加 5s 内存缓存（跟随各 status 路由的既有缓存节奏）。
- **enabled 语义差异**：ChatGPT 的 `enabled` 与其余线路的 `enabled` 语义一致（隐藏模型+停用路由），但 ChatGPT 走 `preferences/enabled` 而其余走 model-settings 文档——聚合层各自取值，DTO 抹平。
- **Ollama 无开关**：`canToggle=false`，卡片不渲染开关；注释行显示「N 个 API Key」。
- **模型计数只有 ChatGPT 精确**：`totalModelCount` 需要本地目录，其余 7 条为 null（卡片退化为「N 个模型已启用」）；补目录快照是 host 侧工作（见 §8）。
- **harness 兼容**：本方案不触碰任何版本敏感接缝（slots/locale/modelDirectories 用法与现状一致），无需动 `.dsh/skills/dsh-harness-upgrade` 的桥接层。
