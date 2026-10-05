# Kimi Code CLI 开源仓库分析 vs 我们的 kimi code 线路

- **上游**: `MoonshotAI/kimi-code` @ `21406fb` (Apache-2.0)，已克隆到 `kimi-code-upstream/`
- **我们**: `dsh-chatgpt-subscription` 插件的 `src/host/kimi-code/` 线路
- **日期**: 2026-09-30 上游快照

---

## 一、结论先行

我们的 kimi code 线路在**订阅线路的工程深度上明显超过上游的官方 CLI 实现**：模型目录带套餐分层、配额倍率、前缀稳定性追踪、缓存命中率、权益拒绝分类、诚实 UA、按 region 隔离的凭据池 —— 这些上游要么没有，要么做得更浅。

但存在 **3 个 P0 级功能缺口**，其中一个是根本性的：

> **我们完全没有 Moonshot 开放平台（API Key）线路，因此够不到任何 `kimi-k*` 系列的真实模型 id。**
> 上游把「K 系列模型」拆成两条完全不同的产品线，我们只实现了其中一条。

---

## 二、上游是怎么支持 K 系列的

上游的模型身份来自**三条互不相同的线路**，这是理解一切差异的关键：

| 线路 | 认证 | Base URL | 模型 id 形态 | 上游是否支持 |
|---|---|---|---|---|
| **① Kimi Code 订阅** | OAuth device flow（RFC 8628） | `api.kimi.com/coding/v1` / `api.kimi.ai/coding/v1` | 不透明别名：`kimi-for-coding`、`k3`、`k3-256k`、`kimi-for-coding-highspeed` | ✅ |
| **② Moonshot 开放平台** | API Key | `api.moonshot.cn/v1` / `api.moonshot.ai/v1` | **真实 K 系列 id**：`kimi-k2`、`kimi-k2-5`、`kimi-k2-thinking` …，按前缀 `kimi-k` 过滤 | ✅ |
| **③ 托管端点 API Key** | 分发密钥 | `api.kimi.com/coding/v1` | 同 ① | ✅ |

**证据**：`packages/oauth/src/open-platform.ts:22-37`

```ts
export const OPEN_PLATFORMS: readonly OpenPlatformDefinition[] = [
  { id: 'moonshot-cn', baseUrl: 'https://api.moonshot.cn/v1',
    consoleUrl: 'https://platform.kimi.com', allowedPrefixes: ['kimi-k'] },
  { id: 'moonshot-ai', baseUrl: 'https://api.moonshot.ai/v1',
    consoleUrl: 'https://platform.kimi.ai', allowedPrefixes: ['kimi-k'] },
];
```

而订阅线路上，官方 SDK 的 `KimiForCodingProvider` **只接受一个模型**（`packages/node-sdk/src/kimi-code-model-provider.ts:43,69-74`）：

```ts
this.model = options.model ?? 'kimi-for-coding';
resolveProviderConfig(model) { if (model !== this.model) throw ... }
```

**推论**：上游之所以看起来"支持很多 K 模型"，是因为它把 `kimi-k2`/`kimi-k2-5` 这些 id 放在了**开放平台**上，而不是订阅端点上。订阅端点的 K3/K2.8 Preview 只是 `kimi-for-coding` 这一个别名背后原地升级的模型。

### 2.1 官方模型表（订阅线路）

我们抄录的 4 个 id 与上游一致（上游 `apps/kimi-code/test/tui/controllers/survey-controller.test.ts:834` 出现 `k3-256k`，`apps/kimi-code/test/tui/utils/refresh-providers.test.ts:82` 出现 `kimi-code/kimi-for-coding`）。

### 2.2 元数据模型：上游更宽

上游 `/models` 解析出的结构（`packages/oauth/src/managed-kimi-code.ts:33-46`）：

```ts
interface ManagedKimiCodeModelInfo {
  id; contextLength; supportsReasoning; supportsImageIn; supportsVideoIn;
  supportsToolUse?; supportsDynamicTools?;
  supportsThinkingType?: 'only' | 'no' | 'both';   // ← 三态声明
  supportEfforts?; defaultEffort?; displayName?; protocol?;
}
```

合并进配置时的服务端归属字段（`model-alias-merge.ts:4-15`）：

```
provider, model, maxContextSize, capabilities, displayName,
protocol, betaApi, adaptiveThinking, supportEfforts, defaultEffort
```

### 2.3 思考/推理

- 编码：`reasoning_effort` + `thinking: { type: 'disabled' | 'enabled', budget_tokens, effort, keep }`
- `adaptiveThinking` 模型级开关
- **方言自适应**（`packages/kosong/src/providers/reasoning-key.ts`）：入站接受 `reasoning_content` / `reasoning_details` / `reasoning` 三种键，出站**回写对端实际说过的那个键**

```ts
export const KNOWN_REASONING_KEYS = ['reasoning_content','reasoning_details','reasoning'];
export class ReasoningKeyDialect {
  observe(source) { const f = extractReasoning(source, this._explicitKey);
    if (f) this._detected = f.key; return f?.value; }        // 记住方言
  outboundKey() { return this._explicitKey ?? this._detected ?? DEFAULT_REASONING_KEY; }  // 用对方方言回写
}
```

注释明确指出：`vllm-project/vllm#38488` 让新版 vLLM 的**请求侧只认 `reasoning`**。

### 2.4 其它上游能力

- 托管 `/tools` 调度：`POST {base}/tools` {method, params}，如 `chat_title` 生成会话标题（`oauth/src/managed-tools.ts:33-62`）
- 服务端工具 `moonshotSearch` / `moonshotFetch`（`managed-kimi-code.ts:175-179`）
- 视频走**月之暗面文件服务**：`files.create` → `VideoURLPart`（`kosong/src/providers/kimi-files.ts:41-75`），不内联
- `limit.input` 与 context **分开记账**：`max_input_tokens` 供压缩判断，全窗口供补全预算（`kosong/src/catalog.ts:319-327,347`）
- 导入时丢弃 `status: deprecated | alpha`（`kosong/src/catalog.ts:116-129`）
- models.dev 形态的目录导入 + 运行时刷新 + 用户 `overrides` 合并

---

## 三、我们这条线路的现状

### 已经做到（对齐或超过上游）

| 能力 | 位置 | 备注 |
|---|---|---|
| OAuth client id | `types.ts:33` | `17e5f671-…` **与上游 constants.ts:20 完全一致** |
| Device flow 端点 | `types.ts:39-43` | `/api/oauth/device_authorization`、`/api/oauth/token`、`urn:ietf:params:oauth:grant-type:device_code` 一致 |
| 刷新阈值 | `types.ts:86-87` | `max(300s, expires_in*0.5)` 一致 |
| `X-Msh-*` 身份头 | `types.ts:69-78` | 7 个头全对齐，且**拒绝冒充官方 CLI**（`client.ts:137-147` 有明确论证） |
| 双协议线路 | `types.ts:153,165` | `/v1/messages?beta=true` + `/v1/chat/completions`（对应上游 `betaApi`） |
| 4 个模型 + 套餐分层 | `model-catalog.ts:73-145` | minimumPlan / contextPlan / quotaMultiplier，**上游没有** |
| 实时 `/v1/models` 刷新 | `client.ts:225-267,388` | 30 分钟 TTL、按 region 持久化、`supports_dynamic_tools` 三态覆盖 |
| 配额 | `client.ts:691-800` | 5h / 7d / month 多窗口 + 钱包 + 定点金额，**上游更浅** |
| 权益拒绝分类 | `adapter.ts:147-232` | 区分「令牌坏了」和「套餐不含该模型」 |
| region 隔离账号池 | `account-pool.ts` | 每账号自带 region/host |
| 前缀稳定性追踪 | `mapper.ts:2137-2201` | 漂移原因归因，**上游没有** |
| 缓存统计 | `mapper.ts:2212-2252` | 命中率，**上游没有** |
| 视频 | `video-store.ts` `video-tool.ts` | 本地 sha256 内容寻址存储 + data URL |

---

## 四、缺口清单

### 🔴 P0-1：没有开放平台 / API Key 线路 —— 够不到 `kimi-k*` 系列

**上游**：`open-platform.ts` + `refreshProviderModels.ts:585-591`（托管端点 API Key）+ `custom-registry.ts`
**我们**：`grep KIMI_API_KEY|KIMI_CODE_API_KEY|apiKey` 在 `src/` 下**零命中**。

后果：我们只能发 4 个 id。K2 / K2.5 / 任何未来的 `kimi-k*` id，**物理上不可达**。这也是「对 K 系列模型的支持」这个问题上最大的缺口 —— 不是少几个模型，是少一整条产品线。

补法：新增 `kimi-platform` provider，复用现有 mapper（两条线都是 OpenAI 兼容 dialect），只需换 base URL + 认证头 + `allowedPrefixes: ['kimi-k']` 过滤。成本低，收益大。

### 🔴 P0-2：reasoning 键方言没有回写

**上游**：`reasoning-key.ts:67-88` 记住对端方言并用同一键回写
**我们**：`mapper.ts:1866` 读 `delta.reasoning_content ?? delta.reasoning`（✅ 读了），但 `mapper.ts:1416`

```ts
if (thinkingOn) entry.reasoning_content = reasoning   // 永远写死 reasoning_content
```

三个具体问题：
1. 若端点已迁到 `reasoning`（新版 vLLM 请求侧只认这个），我们回写的 `reasoning_content` 被**静默丢弃** → 思考历史断链
2. 我们不读 `reasoning_details`（OpenRouter 方言）
3. `mapper.ts:1409-1415` 的注释说明 preserved thinking 依赖 `reasoning_content` 存在才不报 *"thinking is enabled but reasoning_content is missing"* —— 方言错配时这个不变量会直接被打破

补法：加一个和上游等价的 `ReasoningKeyDialect`（入站观察 + 出站回写），挂在 `KimiCodeStreamState` 上（`mapper.ts:1738` 已有该结构）。

### 🔴 P0-3：`supports_thinking_type` 三态没读

**上游**：`open-platform.ts:71,80-93`

```ts
switch (model.supportsThinkingType) {
  case 'only': ...  // 永远思考，不能关
  case 'no': ...    // 不支持思考
  case 'both': ...  // 可开关
}
// "supports_thinking_type is the full three-state declaration and wins over
//  the legacy supports_reasoning boolean; absent (older servers) falls back."
```

**我们**：`client.ts:233-238` 只读 `think_efforts.valid_efforts` / `default_effort`，`supports_thinking_type` 零命中。

后果：服务端声明「此模型只能思考不能关」或「此模型不思考」时，我们用静态目录的猜测（4 个模型都声明 low/high/max），可能发出服务端拒绝的 effort，或在 always-thinking 模型上提供 `none` 选项触发 400。

补法：`parseCatalogModel` 加一个三态解析，优先级高于静态目录的 `reasoningEfforts`。

---

### 🟠 P1-1：没有独立的 input 上限

**上游**：`kosong/src/catalog.ts:319-327` 把 `limit.input` 单独存成 `max_input_tokens`，注释说明「gpt-5 是 400k 窗口但 272k 输入上限；压缩用输入上限，补全预算用全窗口」
**我们**：`client.ts:230` 只读 `context_length`

后果：K3 若窗口 1M 但输入上限更低，我们会**过度发送**直到服务端 400，而不是提前触发压缩。

### 🟠 P1-2：`supports_tool_use` 没读

**上游**：`open-platform.ts:58-60` 从 `/models` 读，缺省 true
**我们**：`client.ts:225-267` 未读，隐含假设工具永远可用

### 🟠 P1-3：没有 `status` 生命周期过滤

**上游**：`kosong/src/catalog.ts:123` 导入时丢弃 `deprecated` / `alpha`
**我们**：无。下线的别名会继续留在选择器里直到发版

### 🟠 P1-4：视频内联而非上传文件服务

**上游**：`kimi-files.ts:41-75` → `files.create` → `VideoURLPart`（月之暗面 file id）
**我们**：`video-store.ts:33` 本地存储 + `modalities.ts:90` `videoDataUrl` base64 内联，上限 30MB 原始 / 48MB 请求

后果：base64 膨胀 4/3 吃满请求预算（`mapper.ts:245` 的 64MB body 上限）；无法跨轮次引用同一视频；无断点/流式。

---

### 🟡 P2 功能对等

| 缺口 | 上游位置 | 说明 |
|---|---|---|
| 服务端工具 `moonshotSearch` / `moonshotFetch` | `managed-kimi-code.ts:175-179` | 我们只有 DSH 自带 web_search，没有 Kimi 原生服务端检索 |
| `chat_title` 会话标题 | `managed-tools.ts:33-62` | 托管 `/tools` 调度，我们零命中 |
| 自定义 / 第三方 provider 注册表 | `custom-registry.ts` | 私有部署 / Kimi 兼容端点接入 |
| models.dev 形态目录导入 | `kosong/src/catalog.ts`、`kosongConfig/modelsDev.ts` | 我们硬编码 4 个模型 |
| 每模型用户 `overrides` 块 | `provider-catalog.ts:606-622` | 上游允许覆盖 `maxContextSize`/`supportEfforts`/`defaultEffort`/`adaptiveThinking`，并在 `defaultEffort` 不在 `supportEfforts` 时**自动丢弃该默认值**（`:612-619`）—— 这个自洽性检查我们没有 |

---

## 五、建议优先级

1. **P0-1 开放平台线路** —— 补齐真正的 `kimi-k*` K 系列，一次性解决"支持哪些 K 模型"这个问题的根
2. **P0-2 reasoning 键方言回写** —— 成本最低（~40 行），但直接关系长会话思考链不断裂
3. **P0-3 `supports_thinking_type` 三态** —— ~20 行，防止 effort 被服务端拒绝
4. **P1-1 input 上限** —— 影响压缩正确性
5. 其余按需

---

## 六、我们比上游强的地方（别在重构中弄丢）

- 套餐分层（`minimumPlan` / `contextPlan`）与 UI 呈现
- 每模型配额倍率（`quotaMultiplier`）
- 前缀稳定性 / 漂移归因（`mapper.ts:2137`）
- 缓存命中率统计（`mapper.ts:2212`）
- 权益拒绝与令牌失效的**区分**（`adapter.ts:147`）—— 上游只按 401 统一处理
- **拒绝冒充官方 CLI**（`client.ts:137-147` 有完整论证），并用重试策略吸收被降权池的瞬时 429
