# Qoder（订阅）线路 · 实施计划

> 状态：**实施完成，待真实账号联调**。目标是把 Qoder 订阅接入本插件，成为第 12 条订阅线路。
> 调研来源（全部是公开材料）：Qoder 官方文档（docs.qoder.com / docs.qoder.cn）、
> 开源实现 `simonsmh/pi-provider-qoder`（TypeScript，live 验证过 Global/CN 两端）与
> `Liki4/qodercli2api`（Go，含 qodercli v1.1.34 的全合成 frozen fixtures 与两份协议文档）。
> 铁律：**不干扰其它 11 条线路**；共享内核一律复用，既有文件的改动只有追加。

---

## 1. 线路身份

| 项 | 取值 |
| --- | --- |
| Provider ID | `qoder` |
| 显示名 | `Qoder（订阅）` |
| 路由前缀 | `/qoder/api` |
| 协议面 | Qoder 自有：`POST {base}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`（COSY 签名 + 自定义 body codec + 信封 SSE） |
| 登录 | 浏览器设备流（**仅全球区**，不开本地回调端口）+ 手动粘贴 PAT（两区）+ adopt 本机 qodercli 登录态（两区） |
| 账号模型 | 多账号号池（复用 `AccountPoolCore`）；凭据**会过期、可刷新**（与 step-code 的静态凭据不同） |
| 额度 | `GET {openapi}/api/v2/quota/usage`（Bearer job token；非公开的个人端点，见 §10 风险） |
| 模型目录 | 实时 `GET {base}/algo/api/v2/model/list?Encode=1`（COSY 签名的 GET）+ 进程内 TTL + 磁盘快照 + 随包能力兜底表 |

### 区域矩阵（pi-provider-qoder `src/region.ts` 逐字）

| 区域 | 推理 base | OpenAPI | center | 管理页 | 设备流 |
| --- | --- | --- | --- | --- | --- |
| `global` | `https://api3.qoder.sh` | `https://openapi.qoder.sh` | `https://center.qoder.sh` | `https://qoder.com` | 支持 |
| `cn` | `https://gateway.qoder.com.cn` | `https://openapi.qoder.com.cn` | `https://gateway.qoder.com.cn` | `https://qoder.com.cn` | **不支持**（仅 PAT） |

区域是**凭据的属性**（与 step-code 的 profile 同理）：两区端点互不通用，一个池可混有两区账号。

### 端点矩阵

| 用途 | 方法 | 路径 | 证据 |
| --- | --- | --- | --- |
| 对话 | POST | `{base}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1` | qodercli2api `docs/inference-protocol.md` §1（frozen fixture `infer-user-no-org.json` 锁定 URL 逐字） |
| 模型列表 | GET | `{base}/algo/api/v2/model/list?Encode=1`（COSY 签名，无 body） | pi-provider `src/region.ts` `getQoderModelListURL` |
| PAT 兑换 | POST | `{openapi}/api/v1/jobToken/exchange`，体 `{"personal_token":"<pt-...>","machine_id":"<本机 UUID>"}` | docs.qoder.com/cli/authentication + qodercli2api `docs/oauth.md` §3（官方 CLI 1.1.74 的 `getMachineIdentityRequestFields` 给 exchange/refresh 补既有 machine_id；pi-provider `src/auth/pat.ts` 的旧形状被服务端容忍但少一个官方字段） |
| 用户信息 | GET | `{openapi}/api/v1/userinfo`（Bearer job token） | pi-provider `src/auth/pat.ts` `fetchUserInfo` |
| 额度 | GET | `{openapi}/api/v2/quota/usage`（Bearer job token） | pi-provider `src/auth/usage.ts`（live 验证）；**非公开个人端点** |
| 刷新 | POST | `{center}/algo/api/v3/user/refresh_token`，体 `{"refreshToken"}`，头 `Authorization: Bearer <access>` | pi-provider `src/auth/oauth.ts` `refreshQoderTokenForMode`（live 验证） |
| 设备授权页 | GET | `https://qoder.com/device/selectAccounts?challenge=…&challenge_method=S256&machine_id=…&nonce=…&client_id=e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb` | qodercli2api `docs/oauth.md` §2（client_id 为官方 CLI 的固定值） |
| 设备轮询 | GET | `{openapi}/api/v1/deviceToken/poll?nonce=…&verifier=…&challenge_method=S256`；404=pending | qodercli2api `docs/oauth.md` §2 + pi-provider `src/auth/login.ts` |

---

## 2. 认证与凭据

### 三种凭据来源

1. **浏览器设备流**（全球区）：PKCE 风格 challenge/verifier（verifier 43-128 字符、challenge =
   base64url_nopad(SHA256(verifier))、nonce=UUID、machine_id=36 字符 UUID）→ 浏览器打开授权页 →
   host 轮询 `deviceToken/poll`（404=pending，1-2 秒间隔，总超时=min(服务端截止, 本地 10 分钟)）。
   响应 `{token, user_id, refresh_token, expires_at?|expires_in?}`。
2. **PAT 粘贴**（两区）：用户在 qoder.com/account/integrations（CN 同路径）生成 `pt-...` →
   `jobToken/exchange`（体带 `personal_token` 与既有 `machine_id`）换短期 job token（`jt-...`）。
   **PAT 本体留在凭据里（host-only）**，过期后按 pi-provider 的做法用 PAT 重新兑换。
   **区域不靠用户选对**：`pt-` 串不自述区域，而卡片的选择器默认停在全球区，中国站的 PAT 拿去
   全球区端点只会得到一句不带 `rawMessage` 的 400 `BadRequest`。所以兑换按「首选区 → 另一区」
   依次尝试，**只在明确的 token 被拒状态**（400/401/403/404）换区；429、5xx 与网络错误如实上抛
   （瞬时故障换区重发只会打两次上游）。命中的区域写进凭据，刷新走同一函数因此也会自我纠正。
   判据是实测的响应差异：带 `personal_token` 的 400 没有 `rawMessage`（服务端读完了 token 才拒），
   缺字段/拼错字段名/空体/form 编码的 400 才有 `rawMessage`（形状级拒绝）。
3. **adopt 本机 qodercli 登录态**（只读）：`~/.qoder/.auth/machine_id`（36 字符 UUID）+
   `~/.qoder/.auth/user`（strict padded Base64 信封，AES-128-CBC，key=IV=machine_id 前 16 个字符的
   原始 UTF-8 字节，PKCS#7）。格式逐字见 qodercli2api `docs/oauth.md` §4，且其 frozen fixture
   `credential.json` 提供 byte-exact 已知答案向量（本仓库 `test/qoder-adopt.test.ts` 用它锁定）。
   明文 JSON（`{` 开头）同样接受（官方加载兼容行为）。**只读，绝不写入或删除 `~/.qoder` 的任何文件。**

### 刷新语义（与 step-code 的关键差异）

Qoder 的 job/device token **会过期**（`expires_at` 或 `expires_in`；pi-provider 注释里 expires_in 以**毫秒**计）。
号池钩子因此是活的：

- `expiresAt`：凭据自述的过期时刻（缺省 = 兑换时刻 + 24h，pi-provider 同一兜底）；
- `needsRefresh`：`expiresAt - 3600_000 < now`（提前 1 小时，逐字 qodercli2api `docs/oauth.md` §3）；
- `refresh`：PAT 来源 → 用存下的 PAT 重兑换；其余 → `refresh_token` 走 center 刷新端点；
  刷新响应里 token 轮换时整体替换。
- `refreshFailureStatus`：401/403 → `'expired'`（这个账号必须重登），其余 → undefined（瞬时故障不判死）。

---

## 3. COSY 签名与请求 codec（协议核心）

逐字来源：qodercli2api `docs/inference-protocol.md` §1-§5 + frozen fixtures `runtime-fields.json` /
`infer-user-no-org.json`，与 pi-provider `src/cosy.ts`（live 验证）互相印证。两处**有分歧时以
frozen fixture 为准**（它有 byte-exact 期望值），pi-provider 的额外头作为「被服务端容忍的超集」记录在案。

### 3.1 runtime auth fields（每请求生成一次）

1. RNG 16 bytes `R`，逐字节反转 `U[i]=R[15-i]`，再 `U[6]=(U[6]&0x0f)|0x40`、`U[8]=(U[8]&0x3f)|0x80`；
   runtime AES key `K` = lowercase `hex(U)[:16]` 的 16 个 ASCII 字符（**不做 hex decode**）。
2. `encrypt_user_info` = AES-128-CBC（key=IV=K 的原始字节，PKCS#7）加密 UserInfo 的**原始 JSON 串**，
   输出 standard padded Base64。UserInfo 字段：`{uid, security_oauth_token, name, aid:"", email}`
   （pi-provider `cosy.ts` 的 UserInfo 形状）。
3. `key` = 用 pinned RSA-1024 SPKI 公钥（PKCS#1 v1.5）加密 `K` 的 Base64。公钥逐字见
   qodercli2api `docs/oauth.md` §5（SHA-256 `a6a4aa46…33e569`，与 pi-provider `cosy.ts` 内嵌值逐字相同）。

### 3.2 请求头（条件 presence，fixture 锁定 18/20/21/22 四种形态）

固定头：`Accept: text/event-stream`、`Authorization: Bearer COSY.{payloadB64}.{sigHex}`、
`Cache-Control: no-cache`、`Connection: keep-alive`、`Content-Type: application/json`、
`Cosy-Business-Product: cli`、`Cosy-Business-Type: agent`、`Cosy-ClientType: 5`、
`Cosy-Data-Policy: agree|disagree`（凭据自述，默认 `disagree`）、`Cosy-Date: <unix 秒>`、
`Cosy-Key: <rsa b64>`、`Cosy-MachineId` / `Cosy-MachineToken`（同一 36 字符 UUID）、
`Cosy-MachineType: 5`、`Cosy-Scene: assistant`、`Cosy-User: <uid>`、`Cosy-Version: <CLI 版本>`、
`Login-Version: v2`。
条件头：`Cosy-Organization-Id`（org 非空才有）、`Cosy-Organization-Tags`（tags 非空才有，逗号连接）、
`X-Model-Key` / `X-Model-Source`（model key 非空才有；source 通常为 `system`）。

**pi-provider 超集**（`Cosy-Machineos` / `Cosy-Clientip` / `Cosy-Bodyhash` / `Cosy-Bodylength` /
`Cosy-Sigpath` / `X-Request-Id`）**不发**：官方 pinned WASM 的头集合里没有它们，fixture 逐字锁定。

### 3.3 COSY Authorization

`payloadB64` = standard padded Base64（固定字段顺序的 JSON：
`{"version":"v1","requestId":<每次 prepare 新 UUID>,"info":<encrypt_user_info>,"cosyVersion":<v>,"ideVersion":""}`）。
签名 = lowercase hex MD5(`payloadB64 LF key LF unixSeconds LF encodedBody LF signedPath`)，
`signedPath` 固定 `/api/v2/service/pro/sse/agent_chat_generation`（不含 `/algo` 前缀与 query）。
`Authorization = "Bearer COSY." + payloadB64 + "." + sigHex`。

已知答案：`infer-user-no-org.json`（sig `5cd66ab642f9eda6aec648ecbff2d8cc`）在 `test/qoder-cosy.test.ts` 锁定。

### 3.4 请求 body codec（可逆、确定性、**不是加密**）

1. raw JSON bytes → standard padded Base64；2. 64 字符 alphabet 逐位置映射到
   `_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!`，`=` → `$`；
3. 外三段交换：`k=floor(len/3)`，输出 `s[len-k:] + s[k:len-k] + s[:k]`。
fixture `infer-user-no-org.json` 的 `body_string`/`body_bytes` 是本线路 codec 的已知答案。

### 3.5 RemoteChatAsk body

字段集逐字取自 fixture 的 `body_raw`：`agent_id:"agent_common"`、`aliyun_user_type:""`、
`business:{begin_at,id,name,product:"cli",stage:"start",type:"agent",version:<CLI 版本>}`、
`chat_context:{}`、`chat_record_id`、`chat_task:"FREE_INPUT"`、`custom_model:null`、`is_reply:true`、
`is_retry:false`、`messages`、`model_config`（目录条目原样）、`parameters:{max_tokens[, temperature,
top_p, enable_thinking, reasoning_effort]}`、`request_id`（每次请求新 UUID；重复会被上游报 code 103）、
`request_set_id`（会话稳定 id，缓存亲和）、`session_id`、`session_type:"qodercli"`、`source:1`、
`stream:true`、`system`（顶层；同时注入 leading role:system 消息——pi-provider 实测顶层字段被服务端
忽略，fixture 显示官方 CLI 两处都填，本线路两处都填）、`task_id:"common"`、`tools`、`version:"3"`。

messages 是 OpenAI 形状：`content` 为 string 或 parts 数组（`image_url` 用 data: URL）、
assistant 带 `tool_calls`、tool 结果走 `role:"tool"` + `tool_call_id`（图片结果跟在后面的
`role:"user"` 消息里，照 pi-provider transform.ts）；assistant 无文本但有 tool_calls 时 content 置
`" "`（上游会丢掉 content:null 的 assistant 消息，逐字 pi-provider 注释）。tool_call id 收窄到
`^[a-zA-Z0-9_-]{1,64}$`（线上重写，映射不回内部）。

思考控制（pi-provider `stream.ts`，来源 `@qoder-ai/qodercli`）：`parameters.enable_thinking`（bool）+
`parameters.reasoning_effort`（`"none"|"low"|"medium"|"high"|"xhigh"|"max"`）——仅当目录条目的
`thinking_config.enabled.efforts` 存在时才发 effort；未选档位或收敛到关 → `enable_thinking:false`。

### 3.6 响应：明文 SSE 信封

`data:{"headers":{…},"body":"<inner JSON string>","statusCodeValue":200}`；`body` 再解析一次得到
OpenAI `chat.completion.chunk`（`content` / `reasoning_content` / 流式 `tool_calls` / `finish_reason` /
`usage`）。`[DONE]` 有两种形态：裸 `data:[DONE]` 与信封 `body:"[DONE]"`，都结束读取；
`event:finish` 帧带耗时统计（权威终止事件）。`statusCodeValue != 200` 是错误信封。
（逐字 qodercli2api §7 + pi-provider `stream.ts`。）

usage 口径：Qoder 的 `prompt_tokens` **含** `prompt_tokens_details.cached_tokens`（OpenAI 语义），
DSH 计数互斥，所以 `input = prompt - cacheRead - cacheWrite`（pi-provider 同一减法）。
`usage.credits` / `billable` 是 Qoder 的计费字段，**不进 DSH 的 TokenUsage**（没有对应格子；
记入诊断日志，不虚构金额——订阅单价未公开）。

### 3.7 失败分类：上游的「排队」与「额度用尽」都不是认证失败

失败有两种送达方式，**第二种不经过 `!response.ok` 那一支**：

1. HTTP 非 2xx（body 直接是错误 JSON）；
2. **HTTP 200 + SSE 错误信封**（`statusCodeValue: 403`）——「排队中」走的是这一条。
   它因此**不会**调用 `markAuthFailed`（账号不会被误判成「要重新登录」），但它同样要
   分类对：分错就是 DSH 的通用文案「API 密钥无效」（`message.failure.auth`）。

上游在失败里报的事实（字段名逐字）：

| 字段 | 含义 |
| --- | --- |
| `code` | 业务码（码链：HTTP 403 → 10605） |
| `subCode` | `RESOURCE_LIMIT` = 上游资源不足 / 排队 |
| `queueCount` | 排队人数 |
| `retryAfterSeconds` | 上游建议的等待秒数 |
| `serviceAvailable` | 上游当下的服务可用性 |
| `isQueued` | 这次请求是否被排队 |
| `modelKey` | 被排队的模型（上游的 key，不是 DSH 的公开 id） |
| `pricingUrl` / `upgradeUrl` | 额度用尽时的购买 / 升级页 |

分类口径（`classifyQoderFailure` 与 `classifyQoderEnvelopeFailure` 共用一份事实扫描）：

- **排队 / 资源不足**（`RESOURCE_LIMIT`、`10605`，或 403 配容量信号）→ `SERVER`。
  它描述的是上游容量：换账号与重新登录都救不了，退避重试才有意义（与 kimi-code 的
  「引擎过载」同一判断）。上游给了 `retryAfterSeconds` 就照它说（`providerRetryAfterMs`）。
- **额度用尽**（业务码 `112`，或 403 配 `isQuotaExceeded` / `pricingUrl`）→ `QUOTA`。
  DSH 用这个码显示「当前请求的额度已用尽」。
- **登录失效**（401，或业务码 `105` Login expired）→ `AUTH`。
- 认不出原因的 403 仍然归 `AUTH`（凭据被拒是上游最常见的那一种），但上面两条必须先判掉：
  把一次排队说成「API 密钥无效」会让人去重建一把根本没坏的令牌。
- 事实**逐层扫**（信封外层 + body + body 里的 `error` 对象）：上游把这些字段放在哪一层
  并不确定，只读 body 会把「排队」读成「凭据被拒」。

---

## 4. 模型目录与能力

- 目录完全靠运行时发现（`GET {base}/algo/api/v2/model/list?Encode=1`，COSY GET 无 body）；
  条目字段：`key`、`enable`、`display_name`、`max_input_tokens`（**陈旧的 180K 地板，不可信**）、
  `context_config`（`{name: {token_count, is_default}}`，取最大 token_count 为窗口）、`is_vl`、
  `is_reasoning`、`thinking_config`、`source`（pi-provider `catalog.ts` 逐字段）。
- 公开模型 id = `display_name` 去空白（pi-provider 同一规则）；上行 key 留在条目里供
  `X-Model-Key` / `model_config` 使用。
- 输出上限：目录不报；取 **131072**（pi-provider `MAX_OUTPUT_TOKENS`，依据 Aliyun Model Studio
  文档的 Max Output Length，注释含出处）。
- 上下文窗口兜底 **1_000_000**（global，pi-provider 实测 1M 可过）/ **200_000**（CN 保守值，
  pi-provider `staticCnModels` 同值）。
- 随包能力兜底表照录 pi-provider `staticModels` / `staticCnModels`（出处注释逐条写明），
  未声明行走「不主张任何能力」的那一行。
- COSY 版本必须跟随 Qoder CLI 最新 release（落后会拿到缩减的目录）：`cosy-version` 每日从
  `https://repo.qoder.com/repos/QoderAI/changelog-CLI/releases?per_page=5&page=1` 拉一次，
  磁盘缓存，失败回落随包版本 `1.1.72`（pi-provider `cosy-version.ts` 同一设计、同一兜底值）。

---

## 5. 额度卡片

- 数据源 `GET {openapi}/api/v2/quota/usage`（Bearer job token；**非公开个人端点**，上游随时可改）：
  `{ userQuota?, addOnQuota?, orgResourcePackage?, expiresAt? }`，桶字段
  `{ total|cap, used, remaining, unit }`（org 桶用 `cap`，逐字 pi-provider `auth/usage.ts`）。
- 三个桶**分开渲染**（个人 / 加购 / 组织包），单位照上游原样；缺桶不画；`expiresAt` 是账号周期
  截止（Unix 毫秒）。
- 额度失败（含上游改版）**绝不影响模型请求**；失败原因与快照并列下发，不互相取代。
- 上游另外报两个**账号层面**的事实：`isQuotaExceeded`（额度已用尽）与 `upgradeUrl`
  （升级 / 购买页）。三只桶全是 0 时它们是唯一的线索——插件不认识这两个字段时，卡片显示
  「还有额度」而上游其实已经把请求拒了（见 §3.7）。
- 输入框胶囊：从有 `total>0` 的桶里选已用比例最高的一只，显示剩余百分比；没有可计量的桶就
  **不渲染胶囊**（占位数字比不显示更像坏了——step-code 同一条规则）。
- 单价未公开（Credits 与美元无公开汇率），整页**只显示 token/Credits 数字，不显示金额**。
  pi-provider 的 `$20/1500 Credits` 参考换算是它自己的产品选择，本线路不抄。

---

## 6. 逐文件改动清单

### 6.1 新增（本线路自带）

```
src/shared/qoder-contracts.ts          Provider id/名/路由前缀、区域、额度桶/快照 DTO、设置/状态/登录/连接/adopt DTO
src/host/qoder/types.ts                线路常量、区域端点表、COSY 常量、超时、档位收敛、env 覆盖
src/host/qoder/model-catalog.ts        随包能力兜底表 + 目录归一化 + 档位映射
src/host/qoder/token-store.ts          凭据存储（可刷新）+ 模型设置 + 偏好注册
src/host/qoder/cosy.ts                 COSY 签名（AES/RSA/MD5）+ body codec + machine_id + runtime fields
src/host/qoder/client.ts               上游 I/O：目录 / 额度 / userinfo / PAT 兑换 / 刷新（TTL 缓存 + in-flight 去重 + 磁盘快照）
src/host/qoder/oauth.ts                设备流状态机（authorize/poll）+ PAT 登录 + 凭据装配
src/host/qoder/adopt.ts                只读导入 ~/.qoder/.auth/{machine_id,user}（AES-128-CBC 解密，fixture 锁定）
src/host/qoder/account-pool.ts         号池薄封装（refresh 钩子是活的）
src/host/qoder/mapper.ts               RemoteChatAsk 请求体 + 信封 SSE 解析 + usage + 错误分类
src/host/qoder/adapter.ts              LlmAdapter：listModels / resolveModel / prepareCall / stream
src/host/qoder/routes.ts               /qoder/api 全套子路由
src/client/qoder/QoderSection.tsx      设置卡片（渲染）
src/client/qoder/useQoderSection.ts    卡片行为
src/client/qoder/QoderComposerQuota.tsx 输入框额度胶囊
src/client/qoder/api.ts                路由表（与 host 手写镜像互锁）
src/client/qoder/locales.ts            zh/en 文案
src/client/qoder/styles.ts             本卡独有样式（.dshq- 前缀）
test/qoder-*.test.ts(x)                cosy/codec/mapper/oauth/pat/adopt/catalog/pool/routes/ui/契约守卫
```

### 6.2 既有文件的**追加式**注册点（只增行）

| 文件 | 改什么 |
| --- | --- |
| `src/index.ts` | imports、store/号池构造、adapter+claim+routes、hub 汇总条目、dispose、底部 export 段（全部追加在最后） |
| `src/client/hub/providers.tsx` | `HUB_PROVIDERS` 追加一条（cline-pass 之后） |
| `src/client/hub/brand-icons.tsx` | `HubProviderId` 联合 + `PROVIDER_BRANDS` 追加 `qoder` + 本地标记 |
| `src/client/index.tsx` | import、`LocaleNamespaceMap`、locale.register、style install、`conversation.input.right` 槽 **order 45** |
| `src/host/common/model-request-control.ts` | `CONTROLLED_PROVIDERS` 追加 `'qoder'` |
| `src/host/common/request-diagnostics.ts` | `DIAGNOSTIC_PROVIDERS` 追加 `'qoder'` |
| `test/client-registration.test.ts` | 槽位名列表 + order 数组 + TAB_IDS 各追加一项 |
| `test/hub-overview-ui.test.tsx` | `overviewDto()` 追加 `summary('qoder')` |
| `test/login-opens-browser-once.test.ts` | 追加 Qoder 用例（host 不自行开浏览器） |
| `README.md` / `CHANGELOG.md` / `docs/provider-protocol-test-matrix.md` | 总览表加行、新章节、Unreleased 条目 |

### 6.3 明确**不改**

`package.json`、`cordis.patch.yml`、`presets/`、`src/compat.ts`、`src/shared/preferences.ts`、
`src/client/locales.ts`、`src/host/common/*` 的其它任何一行、既有线路的任何实现。

---

## 7. 实施波次（本次由调度者本人串行执行，用户明确要求不开子代理）

- **波次 1 · 契约与地基（冻结）**：`shared/qoder-contracts.ts`、`host/qoder/{types,model-catalog,token-store}.ts`。
- **波次 2A · 传输与登录**：`cosy.ts`、`client.ts`、`oauth.ts`、`adopt.ts`、`account-pool.ts`。
- **波次 2B · 协议映射**：`mapper.ts`。
- **波次 2C · 客户端**：`client/qoder/*` 六个文件。
- **波次 3 · 集成**：`adapter.ts`、`routes.ts`、`src/index.ts` 接线、两个 common 注册点。
- **波次 4 · UI 接入与文档**：hub/brand/client 槽位、计数断言、README/CHANGELOG/协议矩阵。
- **波次 5 · 测试与验收**：`qoder-*` 套件 + 三个既有测试的追加 + 全量验证。

## 8. 验收标准

1. `npx tsc -b`、`npx tsc -p test/tsconfig.json`、`npx vitest run`、`npm run build`、`npm pack --dry-run` 全绿。
2. 基线对照：改动前 270 文件 4488 测试通过；改动后只增不减（除计数断言的追加）。
3. COSY 签名 / body codec / adopt 解密 / runtime fields 全部有 fixture 级已知答案测试
   （qodercli2api 的四份 frozen fixture）。
4. 设置页出现第 12 张卡片，可开关；登录三路径（设备流/PAT/adopt）各自可走通（设备流与 PAT 用
   mock fetch 覆盖，adopt 用合成 fixture 覆盖）。
5. 既有 11 条线路的实现文件 diff 为零；common 两个文件只有一行追加。
6. README 写明 Qoder 线路的能力、限制、以及额度/COSY 为非公开接口的风险；CHANGELOG 有 Unreleased 条目。

---

## 9. 风险与未验证项（**下一个人先读这里**）

| # | 风险/未知 | 现状与处理 |
| --- | --- | --- |
| 1 | 额度端点 `/api/v2/quota/usage` 是**非公开个人接口** | pi-provider live 验证过；失败不影响模型请求；卡片明示来源 |
| 2 | COSY 签名整套是逆向协议（非官方公开契约） | 用 qodercli2api 的 frozen fixtures 锁 byte-exact；**未用真实账号联调**——需要用户在设置页实测一次对话 |
| 3 | 官方 inference 头集合（18/20/21/22 条件 presence）与 pi-provider 超集有分歧 | 以 frozen fixture 为准（官方 pinned WASM 行为）；pi 的多余头被服务端容忍但官方不发，本线路不发 |
| 4 | 刷新端点有两个记载：`{center}/algo/api/v3/user/refresh_token`（pi，live）与 `{openapi}/api/v1/deviceToken/refresh`（qodercli2api 文档） | 实现 pi 的（live 验证）；另一个记在这里备用 |
| 5 | adopt 文件的完整 UserInfo 字段集（`expire_time`、`organization_tags` 等）没有逐字 schema | 按「可能缺失」逐字段读取；区域用「对两区 userinfo 各探一次」判定，两区都拒 → invalid-credentials |
| 6 | `expires_in` 的单位：pi-provider 注释「observed as 毫秒」，qodercli2api 按秒处理 `expires_in` | 两种都认：数值 > 10^12 按毫秒，否则按秒（量级判别，与 asTimestampMs 同一判据） |
| 7 | CN 区无浏览器设备流（pi-provider `supportsBrowserLogin:false`） | CN 只给 PAT 与 adopt；卡片在选 CN 时不显示浏览器登录按钮 |
| 8 | COSY 版本落后会拿到**缩减的**模型目录 | 每日跟随 repo.qoder.com 的 CLI release feed；失败回落随包版本；目录缓存照旧 |
| 9 | Qoder 模型目录的 `max_input_tokens` 是陈旧的 180K 地板 | 窗口只信 `context_config` 的最大 `token_count`，没有就按区域兜底（global 1M / CN 200K） |
| 10 | `chat_context` 在官方 fixture 里是 `{}`，pi-provider 填了 `extra.modelConfig` | 按 fixture 发 `{}`；若实测模型路由异常再对照 pi 的实现补上 |

---

## 10. 实施备注（验收时的事实记录）

1. **基线对照**：改动前 270 文件 / 4488 测试通过（7 skipped）；改动后 **280 文件 / 4570 测试通过（7 skipped）**。
   新增 10 个 qoder 套件（77 例）+ login-opens-browser-once 追加 1 例；另有 4 例增长来自
   遍历 `CONTROLLED_PROVIDERS` / `DIAGNOSTIC_PROVIDERS` 的既有参数化测试自动多跑一条。
   既有测试的改动只有计数断言的追加（client-registration / hub-overview-ui / login-opens-browser-once）。
2. **typecheck**：`npx tsc -b` 与 `npx tsc -p test/tsconfig.json` 均 0 错误。
3. **build / pack**：`npm run build` 通过；`npm pack --dry-run` 确认 `lib/types/shared/qoder-contracts.d.ts` 入包。
4. **diff 审计**：`src/host/common/` 与 `src/client/common/` 只有追加式改动
   （`CONTROLLED_PROVIDERS` 与 `DIAGNOSTIC_PROVIDERS` 各加一个 id）；`src/index.ts` 只有追加块；
   既有线路的实现文件零改动。
5. **实施中修掉的自伤 bug**（都是写码阶段的，不是设计变更）：
   - 模板字面量写文件把 `\s` 吃成 `s`（model-catalog 的 toQoderModelId）——测试当场咬住；
   - `qoderWireToolCallId` 的测试期望与实现的 trim 语义不一致——对齐实现（trim 首尾连字符）；
   - 胶囊 tooltip 只带绝对量——改成百分比 + 绝对量都带。
