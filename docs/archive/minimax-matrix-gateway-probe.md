# MiniMax Matrix 媒体网关探针报告

> **调查方式**：**活的**，一次执行、两个只读请求。探针 = `scripts/probe-minimax-matrix-gateway.probe.ts`。
> **被测工具**：`get_voice_list`（无输入、无文件 I/O、无生成、不落产物）。**没有**打过任何生成类端点。
> **凭据来源**：插件自己的号池（`MinimaxCodeAccountPool.getCredentialAccount()`），不是裸 store。
> **保密**：access token / refresh token / 邮箱 / 账号 id / realUserID **全部未出现在本文件任何一行**。见第 8 节。

---

## 1. 结论先行

**成立。Matrix 媒体网关接受我们的订阅 bearer 令牌，而且不需要那组路由头。**

| 判定项 | 结果 | 依据 |
| --- | --- | --- |
| HTTP 状态码 | **200**（两次都是） | 第 3 节 |
| `base_resp.status_code` | **0**（两次都是） | 第 3 节 |
| 业务报文 | 完整成功报文：327 条音色 + `status_msg: "success"` | 第 3 节 |
| 不带路由头（`user_id`/`biz_id`/`request_sk`）、无 query | **照样成功** | A 组 / R1-bare |
| 带路由头与 query 词汇 | **一样成功，报文无差别** | C 组 / R2-routed |

按任务书给的三档判定：

| 档位 | 本次是否命中 |
| --- | --- |
| ✅ **成立**（2xx 且 `base_resp.status_code === 0`） | **命中** |
| ⚠️ 需要额外头（2xx 但业务码非 0） | 未命中 |
| ❌ 被拒（401 / 403 / 1004） | 未命中 |

**直接回答两个问题：**

1. **Matrix 媒体面接受我们的订阅 bearer 吗？** **接受。** HTTP 200，`base_resp.status_code = 0`，返回完整成功报文。
2. **接受的话需要哪几个头？** **只需要两个**：`Authorization: Bearer <token>` 和 `Content-Type: application/json`。`User-Agent` 带了 `MiniMaxAgent`（与上游一致），但本次没有把它单独抽掉验证，所以它是否**必需**未被证伪——不过 `managed-routing.ts` 说明 prod 客户端就发这个值，照抄没有成本。**不需要**签名头、**不需要** `user_id`/`biz_id`、**不需要**任何 query 参数。

**一句话**：`docs/minimax-video-tools-feasibility.md` 第 7 节列的那条「唯一实质风险点」——「Matrix 网关对 bearer 的运行时接受度未验证」——**已经排除**。上游代码怎么写的，服务端此刻就怎么答。

---

## 2. 探针怎么打的

### 2.1 请求形状（照抄上游 `matrix-client.ts`）

```
POST {agentBase}/mavis/api/v1/mcp/get_voice_list
Authorization: Bearer <订阅 access token>
User-Agent: MiniMaxAgent
Content-Type: application/json
Accept: application/json

{}
```

- `{agentBase}` 由**凭据自己的 region** 决定（`agentBaseUrl(region)`），不是写死 cn。
- 路径是 `/mavis/api/v1/mcp/`，即上游把 `/matrix/api/v1/mcp/` 重写之后的**本地网关前缀**（`matrix-client.ts:15-16, 226-230`）。

### 2.2 两个 case 的唯一变量

| case | 路由词汇 | 目的 |
| --- | --- | --- |
| **R1-bare** = **A 组** | 无。只有 bearer + UA + JSON，**无 query string** | 上游 prod 原形是否够用（主测试） |
| **R2-routed** = **C 组** | 带。query 用本仓库签到线**已实测**的词汇（`checkin-gateway.ts:206-222`）：`device_platform` / `biz_id` / `app_id` / `version_code` / `is_desktop` / `desktop_version` / `unix` / `timezone_offset` / `sys_language` / `lang` / `device_id` / `os_name` / `browser_name` / `client`，外加 `user_id: <realUserID>`；header 另加 `user_id` 与 `biz_id` | 缺了它会不会被拒 |

`realUserID` 从签到调度器缓存的 `~/.dsh/storages/minimax-code-checkin.json` 取（免费），取不到才回落到 `fetchAccountIdentity()`。

### 2.3 与 A / B / C / D 组合表的对应关系

探针按上游 prod 原形（A 组）先行，A 通过后仍跑了 C 组做对照。**B 组没有实现**，理由写在下面。

| 组 | 形状 | 本次是否执行 | 结果 |
| --- | --- | --- | --- |
| **A** | `Bearer` + `User-Agent: MiniMaxAgent` + `Content-Type`，无 query、无签名头、无身份头 | ✅ 已跑 | **HTTP 200 / `base_resp.status_code=0`** |
| **B** | A + `yy`/`x-timestamp`/`x-signature`（签到面那套签名） | ❌ **未跑，且有意不实现** | — |
| **C** | A + 身份头（`user_id`/`biz_id`）与签到线 query 词汇 | ✅ 已跑 | **HTTP 200 / `base_resp.status_code=0`**（与 A 无差别） |
| **D** | 不是形状，是**分类**：404/405 说明路径或方法错，不是鉴权结论 | ✅ 已写进 `classify()` | 本次未触发 |

**B 组为什么不做**：A 组已经通过，B 只在「A 失败且失败原因是鉴权」时才有意义——而那个前提从未成立。更关键的是，你补充的 `managed-routing.ts` 证据说明 prod 下路由头解析为 `{}`，所以 A 不只是「最小形状」，它就是 prod 客户端**发出的全部形状**；B 在这个证据下是一条永远走不到的分支，而未被执行过的分支代码正是探针最该避免的东西。如果 A 哪天开始报鉴权失败，B 就是下一个该建的东西——它需要的那个 salt 在 `checkin-gateway.ts` 里，是模块私有的，为了一个从没被要求过的分支把它抄过来并不值得。

**C 组为什么留着**：A 通过之后 C 严格来说不必要，本次也因此花了 2 个请求而不是 1 个（如实记录）。留着它是为了让「路由头不要紧」成为**实测**结论而不是**推断**结论，并且它是 A 万一退化时唯一还能暴露隐藏要求的那一组。代价是一个无副作用的只读请求。

**D 组的意义**：把「路径/方法错」和「令牌被拒」分开。这两者指向完全不同的下一步，把它们混在一起，就是让「我们调错了 URL」被记成「我们的订阅不被接受」。本次 A 组是 200，D 未触发。

**没有测 `request_sk`。** 上游会发，但它的格式不在已读过的任何材料里，凭空造一个值会把「未实测的参数」塞进那个本该隔离变量的请求——在两次请求的预算内，由畸形 `request_sk` 导致的拒绝，和由路由头本身导致的拒绝**无法区分**。这是本探针的已知局限，记在第 6 节。

---

## 3. 原始证据（清洗后）

### 3.1 R1-bare（**A 组**）—— 不带任何路由头、不带 query

| 项 | 值 |
| --- | --- |
| 请求头（键名） | `accept`, `authorization`, `content-type`, `user-agent` |
| query | 无 |
| body | `{}` |
| **HTTP** | **200** |
| `base_resp.status_code` | **0** |
| `base_resp.status_msg` | `"success"` |
| 判定 | `ACCEPTED: 2xx and base_resp.status_code=0` |

### 3.2 R2-routed（**C 组**）—— 带签到线的路由词汇

| 项 | 值 |
| --- | --- |
| 请求头（键名） | `accept`, `authorization`, `biz_id`, `content-type`, `user-agent`, `user_id` |
| query 键 | 见 2.2 的 14 个键（`user_id` 已带入真实值） |
| body | `{}` |
| **HTTP** | **200** |
| `base_resp.status_code` | **0** |
| `base_resp.status_msg` | `"success"` |
| 判定 | `ACCEPTED: 2xx and base_resp.status_code=0` |

### 3.3 成功报文的结构（两次相同）

```
$                          : object{code, message, available_voices, total, base_resp}
$.available_voices         : array[327]
$.available_voices[n]      : object{voice_id, voice_name}      // n = 0..326
$.available_voices[n].voice_id   : string   // 例："German_SweetLady"
$.available_voices[n].voice_name : string   // 例："Sweet Lady"
$.total                    : number = 327
$.base_resp                : object{status_code, status_msg}
$.base_resp.status_code    : number = 0
$.base_resp.status_msg     : string = "success"
```

**`base_resp` 这个信封在媒体网关上确实存在**，而且装的就是 `0`。这一点不是推断——`fieldsOf()` 把路径逐条打出来了。上游 `cloud/matrix-tools/client.ts` 的 `matrixBusinessFailure` 按业务码分类，与这个信封吻合。

### 3.4 汇总行（探针自己打的最后一行）

```
[probe] accepted cases: 2/2
```

---

## 4. 判读：路由头到底要不要

**不要。** 两次请求的差别是**零**：同样的 200，同样的 `status_code: 0`，同样的 `status_msg: "success"`，同样的 327 条音色。

由此可以确定的三件事：

1. **认证只要 bearer。** `user_id` / `biz_id` / `request_sk` 不是认证的一部分——R1-bare 一个都没带，报文完整。
2. **路由头是可选归因，不是准入条件。** 上游把 `routingHeadersGetter` 标成可选（`matrix-client.ts:37-38, 113-116`），服务端的行为与这个标注一致。
3. **签到线那套 query 词汇不是 Matrix 网关的要求。** 它是 `signin/*` 与 `user/info` 这两个面的协议词汇，带过来既不加分也不减分。

### 4.1 与上游「prod 不加路由头」那条证据的交叉验证

`packages/agent-tools/src/desktop/managed-routing.ts` 的 `managedBackendRoutingHeaders()` 在 `buildEnv` 不是 `dev`/`test`/`staging` 时直接返回 `{}`，`matrix-client.ts:87-101` 的 `postJson()` 拼 URL 也不带 query string。也就是说 **prod 客户端的 Matrix 请求里根本没有路由词汇**。

本次实测与这条**完全吻合**：A 组一个路由参数都没带，服务端照样回了完整报文。代码怎么写、服务端怎么答，两边对上了。这也反过来解释了 C 组为什么毫无差别——那些键在 prod 的 Matrix 面上本来就是不存在的。

### 4.2 两个面要分清楚

| 面 | host | 认证形状 | 签名头 |
| --- | --- | --- | --- |
| **Matrix 媒体面** `/mavis/api/v1/mcp/<tool>` | `agent.minimax.cn` / `agent.minimax.io` | `Authorization: Bearer` + `User-Agent: MiniMaxAgent` | **不需要** |
| 签到面 `/minimax-cloud/api/v1/*` | `agent.minimaxi.com` / `agent.minimax.io` | `Authorization: Bearer` + `yy`/`x-timestamp`/`x-signature` + query 词汇 | **需要** |

签到面那套签名（`checkin-gateway.ts:240-284`）**不是** Matrix 面要的。两者 host 也不同：`.minimaxi.com` 是 Matrix 的 **LEGACY** 主机（`matrix-env.ts:28`），不是它的常规入口。

**对实现的意义**：`docs/minimax-video-tools-feasibility.md` 第 5 节 M1 的第 1 步（新增 `matrix-client.ts`，bearer-only）可以照原样做，不需要为了「让服务端认」而去伪造 `user_id`/`request_sk`，也不需要碰 `yy`/`x-timestamp`/`x-signature` 那组第一方归因头——那条产品政策上的拒绝（`types.ts:115-131`）现在**没有技术代价**。

### 4.3 User-Agent

A 组用的是 `MiniMaxAgent`（Matrix 面）。没有试 `MiniMaxCode` 对照——**没有必要**：A 组已经 200，UA 在本次是一个没有被证伪的变量，不存在「A 失败才试对照」的触发条件。

---

## 5. 本次捕获的缺口（如实）

跑探针时我把 stdout 用 `tail -n 160` 截了尾，而 327 条音色的结构转储本身就把这 160 行占满了，于是**日志的头部被我自己截掉了**。下面三行没能落进证据里：

| 缺的行 | 影响 |
| --- | --- |
| `endpoint=... region=...` | 端点与区域。**可推定**：号池 4 条身份行全部 `region="cn"`（见 `minimax-code-checkin.json` 的 `identities`），`agentBaseUrl('cn')` = `https://agent.minimax.cn`，且无 `DSH_MINIMAX_CODE_BASE_URL` 覆盖。**[推定]** |
| `realUserID: <resolved:len=18> source=...` | 缓存里有 4 条 cn 身份行、`realUserID` 长度均为 18，且均未 pin `accountIdentity`，探针按账号 id 回落到其中之一。**[推定]**：R2 的 `user_id` 带了真实值（长度 18），不是占位 `0` |
| 顶层 `code` / `message` 的**取值** | 路径已确认存在，值未记录。**不影响判定**：判定依据是 `base_resp.status_code`，它已被完整读到 |

**没有重跑。** 任务书给的是「跑一次就据实报告」「只打这 1-2 个只读请求」，本次执行恰好是 2 个。为了补齐一行日志而再打 2 个请求，会让请求数翻倍，而结论不会变——那属于为了报告好看而多打，不属于据实报告。缺口就记在这里。

---

## 6. 局限（不要当成已知）

1. **`User-Agent` 没有被单独抽掉验证。** A 组带了 `MiniMaxAgent`。它是否**必需**未被证伪——只能证明「带上它是可以成功的」。严格说，「只需要 bearer + Content-Type」里 UA 那一条是 [推断]（依据是上游 prod 就发这个值），不是本次实测。要证伪，得再打一个把 UA 换成别值的请求，本次预算内没有做。
2. **C 组是组合式探针，不能定位单个头。** 它同时变了 query 与两个 header。它**成功了**，所以「组合够用」成立；但因为 A 也成功，实际上没有任何一个成员被证明是必要的——这恰好就是结论（都不必要）。若将来 A 失败，这个 case 也无法告诉你是哪一个头救的。
3. **只测了一个工具。** `get_voice_list` 通过，不等于 `videos_understand` 或 `submit_video_generation` 也通过。它们共享同一个网关前缀、同一把 bearer、同一个 `base_resp` 信封，所以**大概率**同样成立，但那是 [推断]。要确认，得各自打一次——而生成类端点要烧额度，不该在探针里做。
4. **只测了一个区域。** 本次是 cn。global（`agent.minimax.io`）没测，本机也没有 global 凭据。
5. **没测额度与计费。** 本次只回答「收不收令牌」，不回答「视频生成扣什么额度」。可行性报告第 7 节第 5 条仍然是未解项。
6. **`request_sk` 未测**（理由见 2.2）。
7. **一次成功不等于稳定。** 这是一次采样，不是 SLA。

---

## 7. 复现

```powershell
npx vitest run --config vitest.probe.config.ts probe-minimax-matrix-gateway
```

无凭据时探针打印一行 `[probe] NO CREDENTIAL - ...` 后正常返回，不抛栈。

**成本**：2 个 `get_voice_list` 请求，无副作用、不落产物、不烧生成额度。**不要**在复现时把它扩成遍历——这个探针存在的意义就是「一次就够」。

---

## 8. 保密

沿用 `scripts/probe-minimax-capabilities.probe.ts` 的 `scrub()`：

| 命中 | 替换为 |
| --- | --- |
| 邮箱 | `<address>` |
| JWT（`eyJ...`） | `<token>` |
| UUID | `<id>` |
| ≥32 位不透明串 | `<redacted:N>` |

**额外一条**，针对本探针：URL 与 query **只打键名，不打值**。理由是 `realUserID` 在本机实测长度为 **18**——短于 `scrub()` 的 32 位阈值，任何基于模式的红线都**抓不到它**。「看着像密钥才清洗」这条规则，恰恰会在最需要它的标识符上失效。所以 R2 的 `user_id` 只报「存在，长度 N」。

本文件不含：access token、refresh token、邮箱、账号 id、realUserID、任何 `authorization` 头的值。

---

## 附：证据索引

| 事实 | 出处 |
| --- | --- |
| 网关路径重写 | `agent-tools/src/desktop/matrix-client.ts:15-16, 226-230` |
| bearer-only 认证 | `agent-tools/src/desktop/matrix-client.ts:198-212` |
| 可选路由头 | `agent-tools/src/desktop/matrix-client.ts:37-38, 113-116` |
| 本仓库同 origin | `src/host/minimax-code/types.ts:54-63` |
| `base_resp` 信封的既有用法 | `src/host/minimax-code/checkin-gateway.ts:447-454` |
| 签到线 query 词汇 | `src/host/minimax-code/checkin-gateway.ts:206-222` |
| 订阅令牌打**平台**路由被拒（1004） | `src/host/minimax-code/types.ts:69-73` |
| 第一方归因头的产品立场 | `src/host/minimax-code/types.ts:115-131` |
| 待验证风险点（本报告关闭） | `docs/minimax-video-tools-feasibility.md` 第 7 节第 1 条 |
