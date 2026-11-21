# 部署配置、凭据存储与安全参考

本文档涵盖 `@eddyskywalker/dsh-chatgpt-subscription` 在 DSH Profile 中的配置项、账号池存储后端、网络代理与网页抓取策略、全量环境变量速查以及宿主安全边界。

---

## 目录

1. [Profile 插件配置（`cordis.patch.yml`）](#1-profile-插件配置cordispatchyml)
2. [号池与凭据存储（`poolStorage`）](#2-号池与凭据存储poolstorage)
3. [统一网络代理与网页抓取](#3-统一网络代理与网页抓取)
4. [运行时并发控制与安全诊断](#4-运行时并发控制与安全诊断)
5. [环境变量全量参考](#5-环境变量全量参考)
6. [安全与隐私不变量](#6-安全与隐私不变量)

---

## 1. Profile 插件配置（`cordis.patch.yml`）

安装插件后，DSH Web Profile（默认位于 `$DSH_HOME/profiles/web/cordis.patch.yml`）包含两条加载行：

- `id: dsh-chatgpt-subscription`：核心宿主与全部供应线路入口；
- `id: dsh-chatgpt-subscription-progress-updates`：「进展更新」独立组件入口（可在 Web 插件管理页单独启停）。

> **重要**：Cordis 的 patch 层按 `id` **整体替换**对应条目的 `config` 对象。所有配置字段均声明在核心行 `id: dsh-chatgpt-subscription` 上；修改时请将需要的字段合并在同一 `config:` 块内。

### 配置示例

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: dsh-chatgpt-subscription
  config:
    poolStorage: keyring                  # keyring（桌面默认）| credentials（无桌面环境的服务器推荐）
    fetchProvider: auto                   # auto | plugin | dsh
    fetchMaxBodyChars: 100000             # 插件抓取解码后的最大字符数
    fetchMaxResponseBytes: 2097152        # 插件抓取进入解码前的最大字节数（2 MiB）
    syncAgentPresets: true                # 启动时同步/注册内置 dispatch 预设
    subagentModelAuthorization: true      # 强制校验子代理显式/继承模型白名单
    subagentModelTools: []                # 额外需显式路由校验的自定义委派工具名（默认已含 subagent）
    subagentModelInheritTools:            # 继承父会话路由的委派工具校验列表
      - subagent_fork
      - spawn_teammate
    subagentModelScope: session           # session | preference
    noAnswerResume: {}                    # 开启无答案/无工具空结束自动续跑；设为 false 关闭
    reasoningCollapseGuard: false         # 推理复读塌缩熔断（默认关闭；传 {} 或参数对象开启）
    codexStreamIdleTimeoutMs: 120000      # Codex 流式传输空闲超时毫秒数
    progressUpdates: true                 # 启用 progress_update 进展汇报（热生效）
    progressUpdatesNudgeThreshold: 8      # 连续多少步工具调用未汇报时温和提醒（1–50，热生效）
    progressUpdatesLanguage: auto         # auto | zh | en | ru（热生效）
    planModePipeline: true                # 启用调度模式 enter_plan_mode / leave_plan_mode（热生效）
    dispatchExecutionGuard: true          # 启用调度执行守卫与 Mandate v2 账本守卫（热生效）
    teamPolicyCacheGuard: true            # 摘除 Agent Teams team:policy 系统段并改为尾部投递（热生效）
    timelineCacheGuard: true              # 冻结 Timeline 规划段与任务工具描述，变更改为尾部投递（热生效）
    toolRunawayGuard: true                # 工具重复调用/同族报错/无变化轮询分级提醒；Kimi 保留强停（热生效）
    mediaTools: true                      # 注册六个图片/视频工具（重载插件或重启后生效）
    cacheWarmup: true                     # 受控线路的大结果 ref:// 预览（热生效）
    cacheWarmupRetrieval: true            # 受控线路的导航检索大纲投影（热生效）
    cacheWaitWarmup: true                 # 等待子代理或后台任务期间的续热：Kimi 与 Claude API 1h 档默认启用（热生效）
    cacheAffinity: true                   # 轮换优先选前缀缓存仍热的账号（剩余额度 ≥20%，热生效）
    promptCacheOverrides: {}              # 部署级缓存语义覆盖；修改后重载插件
```

### 字段速查表

| 字段 | 类型 | 默认值 | 生效方式 | 说明 |
| --- | --- | --- | --- | --- |
| `poolStorage` | `'keyring' \| 'credentials'` | `'keyring'` | 重载插件（Web 设置卡切换则即时生效并优先） | 各线路多账号池的存储后端 |
| `fetchProvider` | `'auto' \| 'plugin' \| 'dsh'` | `'auto'` | 重载插件 | `web_fetch` 抓取后端选择策略 |
| `fetchMaxBodyChars` | 正安全整数 | `100000` | 重载插件 | 插件抓取解码后交给工具的最大字符数 |
| `fetchMaxResponseBytes` | 正安全整数 | `2097152` | 重载插件 | 插件抓取解码前截断的响应字节上限 |
| `syncAgentPresets` | `boolean` | `true` | 重启 / 重载 | 是否自动注册或同步内置 `dispatch` Agent Preset |
| `subagentModelAuthorization` | `boolean` | `true` | 重载插件 | 是否启用子代理路由白名单单调守卫 |
| `subagentModelTools` | `string[]` | `[]`（内置含 `subagent`） | 重载插件 | 需要强制成对提供 `{ provider, model }` 的额外委派工具 |
| `subagentModelInheritTools` | `string[]` | `['subagent_fork', 'spawn_teammate']` | 重载插件 | 继承调用者路由的委派工具校验清单；设 `[]` 关闭继承校验 |
| `subagentModelScope` | `'session' \| 'preference'` | `'session'` | 重载插件 | `session` 仅约束记录了策略的会话；`preference` 额外约束旧会话 |
| `noAnswerResume` | `object \| false` | `{}`（开启） | 重载插件 | 模型未输出正文也未调工具即结束时自动补发续跑 |
| `reasoningCollapseGuard` | `GuardOptions \| false` | `false`（关闭） | 重载插件 | 字面 + 语义双信号连续越线时切断退化推理流并续跑 |
| `codexStreamIdleTimeoutMs` | 正整数（ms） | `120000` | 重载插件 | Codex Responses 流式传输活动空闲超时 |
| `progressUpdates` | `boolean` | `true` | **热生效（volatile）** | 是否启用 `progress_update` 工具与提示引导 |
| `progressUpdatesNudgeThreshold` | `1..50` 整数 | `8` | **热生效（volatile）** | 连续未汇报工具步数的提醒阈值 |
| `progressUpdatesLanguage` | `'auto' \| 'zh' \| 'en' \| 'ru'` | `'auto'` | **热生效（volatile）** | 进展汇报输出语言 |
| `planModePipeline` | `boolean` | `true` | **热生效（volatile）** | 是否在 `dispatch` 预设下开放 `enter_plan_mode` / `leave_plan_mode` |
| `dispatchExecutionGuard` | `boolean` | `true` | **热生效（volatile）** | 执行期拦截子代理越权调用主控专用工具、拦截空 `sleep` 及校验 Mandate v2 账本 |
| `teamPolicyCacheGuard` | `boolean` | `true` | **热生效（volatile）** | 把内置 Agent Teams 的 `team:policy` 段从 system prompt 摘掉，改为开关切换时以尾部用户消息投递一次，避免中途开团队协作刷掉整段前缀缓存 |
| `timelineCacheGuard` | `boolean` | `true` | **热生效（volatile）** | 冻结实验性 Timeline 插件的 `timeline:planning` 系统段与 `timeline_tasks` 工具描述，变更改为尾部用户消息投递一次；避免中途改显示语言/写作提示词时刷掉 Kimi/MiniMax 的整段前缀缓存。未安装 Timeline 时静默 |
| `toolRunawayGuard` | `boolean` | `true` | **热生效（volatile）** | 各线路重复工具调用分级提醒；只有 Kimi 保留第 12 次强停，MiniMax 保留自己的官方失控规则 |
| `mediaTools` | `boolean` | `true` | **重载插件 / 重启** | 统一注册 Codex 生图、Kimi 视频挂载、MiniMax 视频生成与理解、RelayOne 生图/编辑与视频生成；`false` 时六个工具均不进入 schema，MiniMax 仍叠加自己的线路开关；Kimi 既有会话在工具表变化后重建一次前缀缓存 |
| `cacheWarmup` | `boolean` | `true` | **热生效（volatile）** | 受控线路的命令/日志大结果 `ref://` 预览与 `cache_warmup_result` 补读 |
| `cacheWarmupProviders` | `string[]` | 全部 controlled providers | **热生效（volatile）** | 允许产生新预览的线路；`[]` 关闭所有新投影，已有 ref 不受影响 |
| `cacheWarmupRetrieval` | `boolean` | `true` | **热生效（volatile）** | 受控线路明确导航意图下的文件/网页检索结果大纲投影 |
| `cacheWaitWarmup` | `boolean` | `true` | **热生效（volatile）** | 等待期缓存保活，子代理与后台任务都算委派：默认用于 Kimi（空闲 20 分钟 / TTL 25 分钟）、Claude 订阅与 Claude API 的 1 小时缓存档（空闲 55 分钟 / TTL 60 分钟，5m 档不做）；其他线路需 TTL 与显式策略 |
| `cacheAffinity` | `boolean` | `true` | **热生效（volatile）** | 轮换时优先选择该前缀缓存仍热且剩余额度 ≥20% 的账号 |
| `promptCacheOverrides` | `Record<string, object>` | `{}` | **重载插件** | 覆盖线路缓存 TTL、账号作用域、冷启动、亲和、续热（`waitWarmup` / `waitJobs`）与提示；未知证据默认关闭 |

#### `promptCacheOverrides` 示例

```yaml
promptCacheOverrides:
  step-code:
    scope: account       # 只有确认上游按账号隔离缓存时才这样声明
    affinity: true
    coldStart: warm      # warm 必须同时给出实测 ttlMs；in-flight 不需要 TTL
    ttlMs: 300000
    waitWarmup: false    # 不因有 TTL 就自动产生额外模型请求
    waitJobs: false      # 后台任务是否也算委派；仅在 waitWarmup 开启时有意义
```

`mode: none` 会强制关闭该线路的全部缓存优化；`affinity` 需要 `scope: account`；`coldStart: warm`、`waitWarmup`、`hint` 都要求正整数 `ttlMs`。未知字段、非法数值和矛盾组合会在启动时报错，而不是静默开启。

**`waitJobs`（布尔，默认 `false`）**：等待续热是否把**运行中的后台任务**也算作委派，而不只是子代理。只在 `waitWarmup` 开启时有意义；只写 `waitWarmup: false` 关掉续热时不必同时改它。内置只有 `kimi-code`、`claude`（订阅，路由 id `claude-subscription`）与 `claude-api` 为 `true`，其余线路一律 `false`，行为与之前完全一致。任务证据来自宿主写进所有者会话的 `job/registered` / `job/settled` 事件；不发这两个事件的旧世代宿主上该开关自然失效。决策点对**所有线路**统一为 `ttlMs - 5 分钟`（导出纯函数 `cacheWaitDecisionMs(ttlMs)`，余量常量 `CACHE_WAIT_MARGIN_MS`）：Kimi 的 25 分钟 TTL 得到 20 分钟，Claude API 的 1 小时档得到 55 分钟。TTL ≤ 5 分钟时余量放不下，该线路**没有续热**：不排定时器、不产生请求，每进程每线路只告警一次；策略校验不变，这样的部署照常启动。

**两条 Claude 线路的档位门**：`cacheWaitWarmup` 现在也管 Claude 订阅与 Claude API，但只在 **1 小时缓存档**生效（订阅线路的「跟随官方」留空即 1h）。适配器把每个主轮次实际写入的缓存寿命记进活动存储，控制器发现记录寿命与策略 `ttlMs`（3_600_000）不一致时对该会话不排定时器、不续热；5 分钟档因此从不产生续热请求。空闲时钟从请求**发出**时算起，流结束只补用量。订阅卡片另有默认关闭的 cache-keepalive：开启且实际为 1h 时，决策点先按上一响应的 request-id 调用 cache_touch，固定原账号；拒绝、404 或网络失败都在同次决策回退到原 steer 续热，5m 和 API 线路不使用 touch。

**策略 id 与路由 id**：Claude 订阅线路自身代码按 `claude` 读策略，宿主路由 id 则是 `claude-subscription`。等待控制器按路由 id 解析，因此策略表带一份别名（`claude-subscription` → `claude`），两个 id 解析到同一份事实；活动记录按路由 id 写入。

#### `reasoningCollapseGuard` 可选调参字段

当将 `reasoningCollapseGuard` 设为对象以开启熔断时，支持覆盖以下参数：

| 子字段 | 默认值 | 说明 |
| --- | --- | --- |
| `threshold` | `0.85` | 尾部窗口字面 n-gram 重复度阈值 |
| `windowChars` | `4096` | 每次参与评分的尾部推理字符数 |
| `semanticThreshold` | `0.35` | 跨句语义复现度阈值 |
| `semanticConfirmations` | `3` | 字面与语义信号需同时连续命中的窗口数 |
| `maxBreaksPerTurn` | `3` | 单回合最大熔断次数 |
| `cooldownMs` | `30000` | 两次熔断之间的最小冷却间隔（毫秒） |
| `includeModels` | `[]` | 仅监控指定模型 ID；空数组表示监控全部模型 |

---

## 2. 号池与凭据存储（`poolStorage`）

### 两种号池后端对比

| 模式 | 存储介质 | 静态加密 | 适用环境 |
| --- | --- | --- | --- |
| `keyring`（默认） | Windows：CurrentUser DPAPI（`*.dpapi`）<br>macOS：登录钥匙串（Keychain）<br>Linux：Secret Service（`libsecret` / `secret-tool`） | **是** | 个人桌面工作站（Windows / macOS / 带解锁桌面钥匙环的 Linux） |
| `credentials` | `$DSH_HOME/.credentials.yaml`（经 DSH `dsh-credentials-local` 管理，键格式 `dsh-chatgpt-subscription/pool-<sha256>`） | **否**（POSIX 强制 `0600`，Windows 依赖用户目录 ACL） | **无头 Linux 服务器**、容器、SSH 远程部署（无需安装 `gnome-keyring`） |

**设计约束**：
- **不设 `auto` 自动切换**：避免钥匙环锁定时静默切换到另一处存储，造成用户误以为“已登录账号全部丢失”；
- **不做跨存储自动搬迁**：在「设置 → 订阅服务 → ChatGPT → 账号存储位置」切换后端后立刻写入 `<dshHome>/storages/dsh-chatgpt-subscription-pool-storage.json` 并即时重解析全部号池，原后端中的账号原封不动保留在原处，切回即可恢复；
- **单凭据文件清理位置**（若卸载前未点击注销需手工清理）：
  - Windows：`%DSH_HOME%\storages\`（默认 `%USERPROFILE%\.dsh\storages\`）下的 `dsh-chatgpt-subscription\oauth.dpapi` 及各线路 `*.dpapi`；
  - macOS：登录钥匙串条目（如 `security delete-generic-password -s dsh-chatgpt-subscription -a oauth`）；
  - Linux：`$DSH_HOME/storages/`（默认 `~/.dsh/storages/`）下的 `0600` 凭据文件或 Secret Service 对应条目。

---

## 3. 统一网络代理与网页抓取

### 统一代理（全线路共享）

代理设置**按线路隔离**：在 **设置 → 订阅服务 → 某条线路** 卡片里的「网络代理」只作用于该线路的对话生成、OAuth 兑换与续期、模型目录同步与额度查询，修改后即时生效。每条线路三选一（未设置时按「系统代理」处理）：

- **系统代理（自动检测）**：Windows 读取注册表 `ProxyEnable` / `ProxyServer`；macOS 读取 `scutil --proxy`；Linux 读取 GNOME `gsettings`（不支持 PAC 脚本）；若均未命中，自动回退读取进程环境变量或 `$DSH_HOME/.env` 中的 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`；
- **自定义代理**：显式指定代理 URL；
- **直连**：不经过 HTTP 代理（适合无代理环境或纯虚拟网卡 TUN 全局接管场景）；
- **自动绕行规则**：回环地址（`127.0.0.0/8`、`::1`、`localhost`）以及 `NO_PROXY` / `no_proxy` 匹配的主机始终直连。旁路列表**全局共用一份**，每条线路卡片都能查看和编辑：逗号或空格分隔，保存时统一为逗号分隔并去重，存在插件偏好文档里，5 秒内生效；它与进程环境优先、其次 `$DSH_HOME/.env` 的部署级列表**合并生效、互不覆盖**。任一来源读取失败只丢弃该来源，不会把代理从所有线路上摘掉。
- **不属于任何线路的插件请求**（web 抓取接管、搜索、更新检查、Codex 图片工具）跟随 **ChatGPT 线路**的代理设置；Kimi / MiniMax 的视频工具跟随各自线路。
- **Antigravity（ACP）不提供代理设置**：该线路的协议与网络由官方 `agy` CLI 自己管理，插件无法为它单独指定代理，卡片上会说明这一点。
- **从旧版本升级**：原来那份全局代理设置会**一次性复制到全部 14 条线路**，升级后行为不变；此后每条线路各自独立。

### 搜索后端与 `web_fetch` 抓取接管

- **搜索来源**：可在 DSH 默认搜索与 **ChatGPT 订阅 Codex 搜索**之间即时切换。
- **为什么需要插件接管 `web_fetch`**：Clash / Mihomo 等代理客户端常开启 `fake-ip` DNS（将域名解析为 `198.18.0.0/15` 保留网段），而 DSH 内置 `web_fetch` 只认进程环境变量代理且会先做本地 DNS 解析与公网 IP 固定（DNS pinning），遇到 `fake-ip` 会直接报错 `WEB_BLOCKED_URL (resolves to a non-public IP address)`。
- **`fetchProvider` 三种模式**：
  - `auto`（默认）：检测到可用代理或启用了 Codex 搜索时，自动由本插件接管 `web_fetch`（将域名交由代理远端解析，放行 `198.18.0.0/15` fake-ip，同时继续拦截直接指向回环/私网的 SSRF 目标）；无代理时保留 DSH 内置抓取；
  - `plugin`：始终由本插件抓取；
  - `dsh`：始终保留 DSH 原生抓取，插件绝不接管。
- **体积边界说明**：`fetchMaxResponseBytes` 是在响应读入内存后、解码前截断的上限（非流式断连阈值），且 DSH 工具层自身仍有独立的结果长度裁剪预算。

---

## 4. 运行时并发控制与安全诊断

无需改动代码的运维级环境变量控制（修改后需重启 DSH）：

### 每凭据生成并发闸门（`DSH_PROVIDER_CONCURRENCY`）

限制同一凭据指纹在途的模型生成 POST 请求数（认证、续期、目录与额度查询永远绕行闸门，不被排队阻塞）：

```powershell
# PowerShell 示例
$env:DSH_PROVIDER_CONCURRENCY = '{"default":2,"codex-chatgpt":1,"ollama":2,"queueTimeoutMs":120000}'
```

- 支持键：`default`、`queueTimeoutMs`，以及任意线路键：`codex-chatgpt`、`claude`、`kimi-code`、`minimax-code`、`command-code`、`ollama`、`glm-coding-plan`、`step-code`、`cline-pass`、`qoder`、`opendesign`、`workbuddy-subscription`、`antigravity-acp`、`qianwen-token-plan`、`relayone`、`claude-api`。
- `0` 或缺省表示不限制；非法 JSON 或未知字段会在启动时直接报错拒绝（fail-closed）。

### 脱敏请求诊断日志（`DSH_PROVIDER_DIAGNOSTICS`）

设置 `DSH_PROVIDER_DIAGNOSTICS=1` 后，宿主日志会输出带 `[provider-diagnostics]` 标签的结构化耗时（`firstByteMs`，不含并发闸门排队时间）与标准 token 统计。日志严格不含任何原始凭据、提示词正文、会话 ID、完整 URL 或上游不可信报错正文。

---

## 5. 环境变量全量参考

环境变量可设置在启动 `dsh` 的 Shell 环境中，部分代理类变量亦支持写入 `$DSH_HOME/.env`。

### 全局与通用

| 变量名 | 说明 |
| --- | --- |
| `DSH_HOME` | DSH 数据根目录（默认 `~/.dsh`），决定凭据、偏好与缓存存储位置 |
| `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` | 系统代理未检出时的回退代理地址（亦读取 `$DSH_HOME/.env`） |
| `NO_PROXY` / `no_proxy` | 强制直连的域名或 `host:port` 列表（亦读取 `$DSH_HOME/.env`） |
| `DSH_PROVIDER_CONCURRENCY` | 每凭据模型生成请求并发上限 JSON 配置 |
| `DSH_PROVIDER_DIAGNOSTICS` | 设为 `1` 开启脱敏 `[provider-diagnostics]` 请求指标日志 |
| `DSH_CHATGPT_SUBSCRIPTION_RELAY_PROBE` | 调试用中继探针开关（配合 `DSH_CHATGPT_SUBSCRIPTION_RELAY_PROBE_FILE` 指定日志路径） |

### 各线路专用环境变量

| 线路 | 变量名 | 说明 |
| --- | --- | --- |
| **Codex** | `CODEX_HOME` | 本机 Codex CLI 配置目录（默认 `~/.codex`，用于探测 `auth.json`） |
| | `DSH_CODEX_MAX_IMAGE_BYTES` | 单次请求图片负载字节上限（默认 `2097152`，即 2 MiB） |
| | `DSH_CODEX_REMOTE_COMPACTION` | 默认开启 Codex remote-v2 原生压缩；设为 `0` 恢复 DSH 压缩与工具结果剪裁 |
| **Claude** | `CLAUDE_CONFIG_DIR` | 本机 Claude Code 配置目录（默认 `~/.claude`） |
| | `DSH_CLAUDE_CLI_VERSION` | 覆盖两条 Claude 线路共享的客户端版本；与 API 专用别名同时设置时必须一致。未知版本需同时给 `DSH_CLAUDE_CCH_SEED` |
| | `DSH_CLAUDE_OAUTH_AUTHORIZE_URL` | 覆盖 Claude OAuth 授权入口 URL |
| **Kimi Code** | `DSH_KIMI_CODE_OAUTH_HOST` / `KIMI_CODE_OAUTH_HOST` | 覆盖 OAuth 主机（国际区设为 `https://auth.kimi.ai`） |
| | `DSH_KIMI_CODE_BASE_URL` / `KIMI_CODE_BASE_URL` | 覆盖模型接口基址（国际区设为 `https://api.kimi.ai/coding`） |
| | `DSH_KIMI_CODE_MAX_BODY_BYTES` | 强制覆盖单次请求序列化字节上限（最高优先级） |
| | `DSH_KIMI_CODE_MAX_IMAGE_BYTES` | 覆盖粘性图片高水位预算（默认 20 MiB，低水位自动取其 50%） |
| | `DSH_KIMI_CODE_BYTES_PER_TOKEN` | 可选提前压缩窗口折算系数（如 ASCII 取 `4`、混合 `8`、中文 `12`） |
| | `DSH_KIMI_CODE_PRESERVE_THINKING` | 设为 `0` 关闭历史思考内容保留 |
| | `DSH_KIMI_CODE_CACHE_WAIT_WARMUP` | 设为 `1` 允许主代理在等待子代理或后台任务时做轻量续热：Kimi 空闲满 20 分钟，Claude 订阅与 Claude API 的 1 小时档空闲满 55 分钟；`0` 关闭全部线路 |
| | `DSH_KIMI_CODE_CACHE_AFFINITY` | 覆盖多账号轮换时的前缀缓存亲和选号开关（`1` / `0`） |
| | `DSH_KIMI_CODE_TOOL_UPDATE` | 控制动态工具更新策略 |
| | `KIMI_CODE_CUSTOM_HEADERS` | 追加换行分隔的 `Name: Value` 自定义最低优先级请求头 |
| | `KIMI_CODE_REPEAT_BREAKER` | 控制 Kimi 四段式重复工具连击刹车开关 |
| **MiniMax Code** | `DSH_MINIMAX_CODE_QUOTA_ATTRIBUTION` | 设为 `1` 允许额度查询携带官方客户端标识头以读取用量条 |
| | `DSH_MINIMAX_CODE_MAX_BODY_BYTES` | 覆盖单次请求体字节上限（默认 64 MB） |
| | `DSH_MINIMAX_CODE_MAX_IMAGE_BYTES` | 覆盖单次请求图片负载上限（默认 16 MB） |
| | `DSH_MINIMAX_CODE_BASE_URL` / `_ACCOUNT_HOST` / `_QUOTA_HOST` | 覆盖模型、账户或配额主机地址 |
| **Command Code** | `DSH_COMMAND_CODE_ZDR` / `CMD_ZDR` | 设为 `1` 强制发送 `x-cmd-zdr: 1` 零数据保留头（无可用渠道时闭锁报错） |
| | `DSH_COMMAND_CODE_ENV` / `DSH_COMMAND_CODE_ENDPOINT` | 切换 API 环境或覆盖端点地址 |
| **GLM** | `ZCODE_DATA_BASE_DIR` | 覆盖本机 ZCode 数据目录（默认 `~/.zcode`） |
| | `DSH_GLM_CN_BUSINESS_HOST` / `DSH_GLM_INTL_BUSINESS_HOST` | 覆盖国区 / 国际区业务与配额主机 |
| | `DSH_GLM_CN_API_HOST` / `DSH_GLM_INTL_API_HOST` | 覆盖国区 / 国际区模型面主机 |
| | `DSH_GLM_CN_AUTHORIZE_URL` / `DSH_GLM_INTL_AUTHORIZE_URL` | 覆盖两区浏览器授权地址 |
| | `DSH_GLM_CN_APP_ID` / `DSH_GLM_CLIENT_ID` / `DSH_GLM_KEY_NAME` | 覆盖 OAuth 应用标识与自动创建的 Key 名称 |
| | `DSH_GLM_OAUTH_API_BASE` / `DSH_GLM_OAUTH_WEB_BASE` | 覆盖 ZCode OAuth 控制面基址 |
| **Step Code** | `STEPCODE_AUTH_PATH` / `STEPCODE_LEGACY_AUTH_PATH` | 显式指定本机 `stepcode` 客户端 `auth.json` 或旧登录态路径 |
| | `STEPCODE_CONFIG_DIR` / `STEP_CODING_AGENT_DIR` | 覆盖本机 `stepcode` 配置目录或 Agent 根目录 |
| **Cline Pass** | `CLINE_PASS_API_KEY` | 号池为空时自动投射为首要账号的静态 API Key（不落盘） |
| **Qoder** | `QODER_CLI_AUTH_PATH` / `QODER_CLI_MACHINE_ID_PATH` | 显式指定本机 `qodercli` 凭据文件或 `machine_id` 路径 |
| **OpenDesign** | `OPENDESIGN_API_KEY` | 号池为空时自动投射为首要账号的静态 API Key（不落盘） |
| **WorkBuddy** | `CODEBUDDY_AUTH_DIR` / `WORKBUDDY_CONFIG_DIR` / `CODEBUDDY_CONFIG_DIR` | 覆盖本机 CodeBuddy / WorkBuddy 桌面端凭据与密钥目录 |
| **Antigravity (ACP)** | `DSH_ANTIGRAVITY_ACP_BIN` | 显式覆盖官方 `agy` / `agy_acp_server` 可执行文件路径 |
| **Claude API** | `DSH_CLAUDE_API_CLI_VERSION` | 两条 Claude 线路共享版本的兼容别名；与订阅变量冲突会报错。仅自动采用已有 cch 种子的 npm 版本，双方均超过各自缓存 TTL 后切换 |
| | `DSH_CLAUDE_CCH_SEED` | 与未知版本的显式 pin 成对提供 cch 种子（64 位 hex）；没有种子的 pin 不会发出可能错误的签名 |

---

## 6. 安全与隐私不变量

1. **凭据只留宿主（Host-Only）**：所有线路的 `access_token`、`refresh_token`、API Key、PKCE `code_verifier`、设备密钥及业务 JWT 只存在于宿主内存与本地凭据存储中，**绝不下发给 Web 浏览器、绝不写入 `settings.yaml`、绝不打印到日志**。诊断消息提及令牌时只输出不可逆指纹（`sha256:.../len:...`）。
2. **同源变更校验（Same-Origin POST）**：全部修改状态的宿主 HTTP 路由强制要求同源 JSON `POST` 并联合校验 `Origin` 与 `Host` 请求头，防御跨站请求伪造（CSRF）。
3. **本机凭据只读隔离**：所有 `adopt`（导入本机 CLI / 桌面端登录态）模块在点击导入前仅做 `stat` 探测，导入后从不创建、修改或删除第三方客户端文件，也不跨进程抢刷单次轮换令牌。
4. **多模态本地文件获取仅限回环**：工具结果中的本地图片链接（`/describe-image/raw/...`）与工作区视频仅通过受控的回环/宿主附件通道读取，拒绝任意外部私网探测。
5. **写入后回读校验与原子替换**：凭据与偏好落盘均采用临时文件原子替换或加密后立刻回读校验，校验不通过立即抛错，绝不破坏既有有效凭据。

## RelayOne

RelayOne 在设置卡粘贴单个 API Key。保存后自动读取该 Key 当前分组可用的模型；无需手工填写分组或协议。可配置对话模型勾选、上下文窗口覆盖、默认推理等级、默认生图/视频模型和独立代理。

`mediaTools: false` 会同时关闭 RelayOne 生图与视频工具；线路自身的启用开关在执行时仍会再次检查。目录快照只用于同一 Key 的冷启动，不会跨 Key 复用。

## Claude API

Claude API 在设置卡粘贴单个 API Key；端点默认官方地址，可改为任意 http/https origin。可配置对话模型勾选（未设置跟随目录、显式空选为全不启用）、上下文窗口覆盖、默认推理等级、缓存时长 5m/1h、快速模式、服务端压缩开关与独立代理。

客户端版本由两条 Claude 线路共享。后台仍读取 npm latest，但只有代码已登记对应 cch 种子的版本才进入候选；未知版本继续使用最后的已验证组合。两条线路各自最近一次活动都超过其记住的缓存 TTL 后才切换，活跃线路会阻止另一线路单独升级。`DSH_CLAUDE_CLI_VERSION` / `DSH_CLAUDE_API_CLI_VERSION` 是同一 pin 的兼容别名，冲突时明确报错；未知 pin 需成对设置 `DSH_CLAUDE_CCH_SEED`。压缩块、版本缓存与模型能力记忆（`claude-api-capability-memory.json`，端点+模型为键、7 天过期）位于 `$DSH_HOME/storages`，属主可读写；服务端压缩对任何路由到本线路的压缩请求生效（含其他线路改派），上游拒绝时同调用退回客户端压缩。
