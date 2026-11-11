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
    antigravityFirstOutputTimeoutMs: 240000  # antigravity 首个 chunk 之前的等待预算（思考期；chunk 之间仍按 120s）
    progressUpdates: true                 # 启用 progress_update 进展汇报（热生效）
    progressUpdatesNudgeThreshold: 8      # 连续多少步工具调用未汇报时温和提醒（1–50，热生效）
    progressUpdatesLanguage: auto         # auto | zh | en | ru（热生效）
    planModePipeline: true                # 启用调度模式 enter_plan_mode / leave_plan_mode（热生效）
    dispatchExecutionGuard: true          # 启用调度执行守卫与 Mandate v2 账本守卫（热生效）
    toolRunawayGuard: true                # 工具重复调用分级提醒；Kimi 保留强停（热生效）
    mediaTools: true                      # 注册五个图片/视频工具（重载插件或重启后生效）
    cacheWarmup: true                     # 受控线路的大结果 ref:// 预览（热生效）
    cacheWarmupRetrieval: true            # 受控线路的导航检索大纲投影（热生效）
    cacheWaitWarmup: true                 # 默认 Kimi 的等待续热；其他线路需显式策略（热生效）
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
| `antigravityFirstOutputTimeoutMs` | 正整数（ms） | `240000` | 重载插件 | antigravity 线路「首个 chunk 之前」的空闲预算（思考期）；chunk 之间仍按共享 120s 判死，设为 `120000` 即回到单窗口 |
| `progressUpdates` | `boolean` | `true` | **热生效（volatile）** | 是否启用 `progress_update` 工具与提示引导 |
| `progressUpdatesNudgeThreshold` | `1..50` 整数 | `8` | **热生效（volatile）** | 连续未汇报工具步数的提醒阈值 |
| `progressUpdatesLanguage` | `'auto' \| 'zh' \| 'en' \| 'ru'` | `'auto'` | **热生效（volatile）** | 进展汇报输出语言 |
| `planModePipeline` | `boolean` | `true` | **热生效（volatile）** | 是否在 `dispatch` 预设下开放 `enter_plan_mode` / `leave_plan_mode` |
| `dispatchExecutionGuard` | `boolean` | `true` | **热生效（volatile）** | 执行期拦截子代理越权调用主控专用工具、拦截空 `sleep` 及校验 Mandate v2 账本 |
| `teamPolicyCacheGuard` | `boolean` | `true` | **热生效（volatile）** | 把内置 Agent Teams 的 `team:policy` 段从 system prompt 摘掉，改为开关切换时以尾部用户消息投递一次，避免中途开团队协作刷掉整段前缀缓存 |
| `toolRunawayGuard` | `boolean` | `true` | **热生效（volatile）** | 各线路重复工具调用分级提醒；只有 Kimi 保留第 12 次强停，MiniMax 保留自己的官方失控规则 |
| `mediaTools` | `boolean` | `true` | **重载插件 / 重启** | 统一注册 Codex/Antigravity 生图、Kimi 视频挂载、MiniMax 视频生成与理解；`false` 时五个工具均不进入 schema，MiniMax 仍叠加自己的线路开关；Kimi 既有会话在工具表变化后重建一次前缀缓存 |
| `cacheWarmup` | `boolean` | `true` | **热生效（volatile）** | 受控线路的命令/日志大结果 `ref://` 预览与 `cache_warmup_result` 补读 |
| `cacheWarmupProviders` | `string[]` | 全部 controlled providers | **热生效（volatile）** | 允许产生新预览的线路；`[]` 关闭所有新投影，已有 ref 不受影响 |
| `cacheWarmupRetrieval` | `boolean` | `true` | **热生效（volatile）** | 受控线路明确导航意图下的文件/网页检索结果大纲投影 |
| `cacheWaitWarmup` | `boolean` | `true` | **热生效（volatile）** | 默认用于 Kimi 的等待期缓存保活；其他线路需 TTL 与显式策略 |
| `promptCacheOverrides` | `Record<string, object>` | `{}` | **重载插件** | 覆盖线路缓存 TTL、账号作用域、冷启动、亲和、续热与提示；未知证据默认关闭 |

#### `promptCacheOverrides` 示例

```yaml
promptCacheOverrides:
  step-code:
    scope: account       # 只有确认上游按账号隔离缓存时才这样声明
    affinity: true
    coldStart: warm      # warm 必须同时给出实测 ttlMs；in-flight 不需要 TTL
    ttlMs: 300000
    waitWarmup: false    # 不因有 TTL 就自动产生额外模型请求
```

`mode: none` 会强制关闭该线路的全部缓存优化；`affinity` 需要 `scope: account`；`coldStart: warm`、`waitWarmup`、`hint` 都要求正整数 `ttlMs`。未知字段、非法数值和矛盾组合会在启动时报错，而不是静默开启。

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

在 **设置 → 订阅服务 → ChatGPT → 网络代理** 配置的代理会作用于**全部 13 条供应线路**的对话生成、OAuth 兑换与续期、模型目录同步、额度查询，以及插件接管的搜索与网页抓取，修改后即时生效：

- **系统代理（自动检测）**：Windows 读取注册表 `ProxyEnable` / `ProxyServer`；macOS 读取 `scutil --proxy`；Linux 读取 GNOME `gsettings`（不支持 PAC 脚本）；若均未命中，自动回退读取进程环境变量或 `$DSH_HOME/.env` 中的 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`；
- **自定义代理**：显式指定代理 URL；
- **直连**：不经过 HTTP 代理（适合无代理环境或纯虚拟网卡 TUN 全局接管场景）；
- **自动绕行规则**：回环地址（`127.0.0.0/8`、`::1`、`localhost`）以及 `NO_PROXY` / `no_proxy`（进程环境优先，其次 `$DSH_HOME/.env`）匹配的主机始终直连。

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

- 支持键：`default`、`queueTimeoutMs`，以及任意线路键：`codex-chatgpt`、`claude`、`antigravity`、`kimi-code`、`minimax-code`、`command-code`、`ollama`、`glm-coding-plan`、`step-code`、`cline-pass`、`qoder`、`opendesign`、`workbuddy-subscription`。
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
| **Claude** | `CLAUDE_CONFIG_DIR` | 本机 Claude Code 配置目录（默认 `~/.claude`） |
| | `DSH_CLAUDE_CLI_VERSION` | 覆盖向 Anthropic 网关申报的客户端版本号 |
| | `DSH_CLAUDE_OAUTH_AUTHORIZE_URL` | 覆盖 Claude OAuth 授权入口 URL |
| **Antigravity** | `DSH_ANTIGRAVITY_ENDPOINT` | 覆盖 Code Assist 上游端点 |
| | `DSH_ANTIGRAVITY_CALLBACK_PORT` | 指定本地 OAuth 回调监听端口（规避 Windows 保留端口段冲突） |
| | `DSH_ANTIGRAVITY_VERSION` / `_CL` / `_OS` / `_ARCH` / `_USER_AGENT` | 覆盖客户端元数据头字段；`_VERSION`/`_CL` 一旦设置就**钉死**，不再从 Hub 更新清单自动跟随（默认每 6 小时读一次清单取官方当前版本） |
| | `DSH_ANTIGRAVITY_LEGACY_HEADERS` | 恢复旧的身份头（`X-Goog-Api-Client` 与 `Client-Metadata`）；默认为关——官方 `language_server` 不发这两个头，若某账号的资格判定因此异常再打开 |
| **Kimi Code** | `DSH_KIMI_CODE_OAUTH_HOST` / `KIMI_CODE_OAUTH_HOST` | 覆盖 OAuth 主机（国际区设为 `https://auth.kimi.ai`） |
| | `DSH_KIMI_CODE_BASE_URL` / `KIMI_CODE_BASE_URL` | 覆盖模型接口基址（国际区设为 `https://api.kimi.ai/coding`） |
| | `DSH_KIMI_CODE_MAX_BODY_BYTES` | 强制覆盖单次请求序列化字节上限（最高优先级） |
| | `DSH_KIMI_CODE_MAX_IMAGE_BYTES` | 覆盖粘性图片高水位预算（默认 20 MiB，低水位自动取其 50%） |
| | `DSH_KIMI_CODE_BYTES_PER_TOKEN` | 可选提前压缩窗口折算系数（如 ASCII 取 `4`、混合 `8`、中文 `12`） |
| | `DSH_KIMI_CODE_PRESERVE_THINKING` | 设为 `0` 关闭历史思考内容保留 |
| | `DSH_KIMI_CODE_CACHE_WAIT_WARMUP` | 设为 `1` 允许大上下文主代理在等待子代理满 20 分钟时做单次轻量续热 |
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
| **Cline Pass** | `CLINE_PASS_API_KEY` | 号池为空时自动投射为首要账号的静态 API Key（不落盘） |
| **OpenDesign** | `OPENDESIGN_API_KEY` | 号池为空时自动投射为首要账号的静态 API Key（不落盘） |
| **WorkBuddy** | `CODEBUDDY_AUTH_DIR` / `WORKBUDDY_CONFIG_DIR` / `CODEBUDDY_CONFIG_DIR` | 覆盖本机 CodeBuddy / WorkBuddy 桌面端凭据与密钥目录 |

---

## 6. 安全与隐私不变量

1. **凭据只留宿主（Host-Only）**：所有线路的 `access_token`、`refresh_token`、API Key、PKCE `code_verifier`、设备密钥及业务 JWT 只存在于宿主内存与本地凭据存储中，**绝不下发给 Web 浏览器、绝不写入 `settings.yaml`、绝不打印到日志**。诊断消息提及令牌时只输出不可逆指纹（`sha256:.../len:...`）。
2. **同源变更校验（Same-Origin POST）**：全部修改状态的宿主 HTTP 路由强制要求同源 JSON `POST` 并联合校验 `Origin` 与 `Host` 请求头，防御跨站请求伪造（CSRF）。
3. **本机凭据只读隔离**：所有 `adopt`（导入本机 CLI / 桌面端登录态）模块在点击导入前仅做 `stat` 探测，导入后从不创建、修改或删除第三方客户端文件，也不跨进程抢刷单次轮换令牌。
4. **多模态本地文件获取仅限回环**：工具结果中的本地图片链接（`/describe-image/raw/...`）与工作区视频仅通过受控的回环/宿主附件通道读取，拒绝任意外部私网探测。
5. **写入后回读校验与原子替换**：凭据与偏好落盘均采用临时文件原子替换或加密后立刻回读校验，校验不通过立即抛错，绝不破坏既有有效凭据。
