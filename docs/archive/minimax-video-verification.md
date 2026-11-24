# MiniMax 视频能力：实测验证结论（2026-10-20 收口）

- **探针**：`scripts/probe-minimax-video-generation.probe.ts`（901 行）、`scripts/probe-minimax-matrix-gateway.probe.ts`（534 行）
- **原始证据**：[`minimax-video-generation-probe.md`](./minimax-video-generation-probe.md)、[`minimax-matrix-gateway-probe.md`](./minimax-matrix-gateway-probe.md)
- **实现**：[`minimax-video-implementation.md`](./minimax-video-implementation.md)、[`minimax-video-design-spec.md`](./minimax-video-design-spec.md)
- **最终验证**：`npm run typecheck` 0（三段：host+test、test、**scripts**）· `npx vitest run` **256 files / 4224 passed / 0 失败**（1 skipped / 7 skipped）· `npm run build` 0

---

## 〇、这一轮从「假设」到「事实」

| 项 | 状态 | 证据 |
| :- | :- | :- |
| Matrix 媒体面接受订阅 bearer | **事实** | `get_voice_list` → 200、`base_resp.status_code=0`、327 条音色 |
| 真实视频生成跑通 | **事实** | `video/mp4`、12 865 字节、`ftyp`@4 → 合法 ISO BMFF |
| 生成的时长与延迟 | **事实** | `created_at`→`updated_at` **163 秒** |
| 签名 URL 有效期 | **事实：约 24 小时** | `Expires - updated_at` = 86 460 s（**上游文档说 9 小时，与实测不符**） |
| 视频理解的可用媒体键 | **事实：`data`** | `file_url`→false、`url`（签名 URL）→false、**`data`（base64）→true** |
| 上传契约字段名 | **事实** | 请求 `filename`/`mime_type`/`size_bytes`；响应 `put_url`/`cdn_url`/`oss_key`/`expires_in:600` |
| 终态拼写 | **事实：`succeeded`** | 状态序列 `running` → `succeeded` |
| 额度消耗 | **读不出来** | `general` 桶前后 62%/79% 完全不变；接口只有百分比、无 video 桶。**不能据此说免费** |

---

## 一、探针揪出的 7 处缺陷（全部已修，全部有变异验证）

| # | 缺陷 | 危害 | 修法 |
| :- | :- | :- | :- |
| 1 | `videos_understand` 发 `file_url` | 服务端**明说不是合法键**；实测 `success:false` | 改用 `data`（base64，**唯一实测跑通**） |
| 2 | 只判 `base_resp.status_code` | **顶层 `code:404` 藏在 200 里** → 轮询空转到 10 分钟超时 | 同时收集两处非零码（且**故意不下探** `data`/`result`） |
| 3 | submit 走重试 | **重复计费**（上游契约：submit 失败即终局且计费） | submit 单次调用；query 保持可重试（只读不计费） |
| 4 | 两个侧栏包缺 peer/dev 声明 | 宿主校验脚本判不一致 | 按既有 6 个逐字写法补齐 + 装进 node_modules |
| 5 | 上传字段名全猜 | `file_name`/`content_type`/`file_size` 全错 | 改真字段名；**删掉整套「猜字段名」分支** |
| 6 | 结果读取从不看 `success` | 失败被当成「空描述」 | 读 `results[0].success`，false 即明确失败 |
| 7 | 终态认 `success`（猜的） | — | 只认实测的 `succeeded` |

### 一并查清的两件事

- **`output_file_path` 是客户端本地参数**，不发往服务端（上游请求体就是 `{ task_id, model }`）——我们原本就对，已在注释写明。
- **模型 id `MiniMax-H3`/`MiniMax-Hailuo-2.3`** 与上游常量逐字相同——我们原本就对。

---

## 二、还剩的未验证项（如实列出）

| # | 项 | 状态 |
| :- | :- | :- |
| 1 | **上传链路全通** | ✅ **成立** —— [`minimax-video-upload-probe.md`](./minimax-video-upload-probe.md)：`get_upload_url` → `PUT`（200 + etag）→ 回读 `cdn_url` 逐字节相同 → `videos_understand` 的 `results[0].success = true` |
| 2 | **宿主 `maxFileBytes`** | ✅ **32MB**（`packages/api/workspace-files/src/index.ts:188`，可配）。客户端已按 `workspace-file/too-large` **区分「太大」与「没了」**，文案带上限值，对策是「用系统播放器打开」（与宿主的 `open` recourse 一致） |
| 3 | **第三方公网 URL** 能否被理解 | ❌ **不能**（实测：两个本机确认可取到正确 MP4 字节的独立主机，服务端一律拒绝，原话 `video_info.url could not be used as a media source`）。**只有 MiniMax 自己的 CDN 地址可用**——我们上传出的 `cdn.hailuoai.com` 地址实测 `success:true`。客户端现已本地拒绝非 MiniMax CDN 的 URL |
| 4 | **真实额度消耗** | ❌ **从这个接口读不出来**——配额文档的 `model_remains` **只有 `general` 一行**（实测），**没有 video 桶**。不是解析没读，是**桶不存在**。`client.ts` 那条「其它含 video 等独立资源」的旧注释已按事实改正 |
| 5 | `duration` 合法区间 / `resolution` 枚举 | ✅ **实测**（服务端逐字原话）：**H3 4–15**、**H3-Max 5–15**、**Hailuo-2.3 只能 6 或 10**（离散值）；resolution **大小写敏感**，H3 只收 `768P`/`2K`、Hailuo 收 `768P`/`1080P`。**H3-Max 的 resolution 是推断**（照抄 H3，代码标 `inferred`，错误消息自动附注） |
| 6 | `MiniMax-Hailuo-2.3` 是否被接受 | ✅ **被接受**（它报的是关于**自己**的 duration 规则，说明 model 字段先通过校验）。且 **`MiniMax-H3-Max` 也是真实存在的模型**——我们原来的枚举漏了它，现已补上 |
| 7 | **服务端 inline data 的真门限** | ✅ **服务端能吃 20 MiB**（`source:"inline:20971520B"`，字节数准确）——**从未出现体积拒绝**。但同尺寸**耗时 127.6 s 且不稳定**（另两次 300 s 超时）→ 真正的约束是**「等不等得到」**，不是「收不收」。上游的 `600 * 1024` 确认是**它自己的客户端策略阈值**，不是服务端限制。**所以我们 40MB 的 inline 上限不该用「服务端收不收」来定，而该用「我们愿意等多久」** |
| 8 | `failed`/`cancelled` 终态形状 | ❌ **不验**（造失败 = 再花钱，且只在服务端真报错时走） |
| 9 | **真视频的描述准不准** | ✅ **准**（[`minimax-video-fidelity.md`](./minimax-video-fidelity.md)）：CC0 `flower.mp4` 经上传链路理解，描述**逐条吻合画面**（物种级/时间性/细节级全中），**编造词 0 个**。**核心价值主张成立** |

> **未验的代价已经降到最低**：剩下的 3–7 项**全部零成本**（发非法参数看服务端的原话、读配额文档的每一行、发几档不同大小的 inline）。
> 唯一需要花钱的 8（造一个失败任务）我们**明确不验**。

---

## 三、上传链路：成立，以及一条必须一起读的保留

**链路成立**（[`minimax-video-upload-probe.md`](./minimax-video-upload-probe.md)）：

```
get_upload_url → 200, put_url(OSS 预签名) + cdn_url(cdn.hailuoai.com, 4 段, 无 query), expires_in=600
PUT          → 200 + etag（对象真写进桶了；注意成功是 200 不是 204）
回读 cdn_url → 字节与上传逐字节相同（公网可读）
videos_understand → results[0].success = true, source 回显 cdn_url
```

**上一轮 U2 失败的「签名 OSS URL」和这条链路的「`cdn.hailuoai.com` 无 query 地址」是两个不同的 host、两种形状**——不能互相外推成「`url` 键不行」。

### ⚠️ `success:true` ≠ 「描述忠于画面」

**同一段 64×64 纯黑视频，两次独立运行给出的描述不同**（一次「舞台杂技表演」、一次「全程纯黑屏」）。

所以 `success:true` 只证明**「这个引用被成功取到并消费」**，不证明描述忠于画面。**这是模型侧行为，与传输缺陷是两回事。**

这条保留已固化进探针代码（`success:true` 分支单独打印 fidelity 段）与工具描述——因为在自动路径下用户不会预期这点，容易读成「模型胡说」。

---

## 四、⚠️ 最重要的一条：`success: true` **不证明字节被解码**

协调者亲自复验：送 **1 MiB 的 `0x11` 填充字节**（任何解码器都读不出画面）→

```
source = inline:1048576B
description = 这是一段典型的短视频平台（如抖音）上的对口型/情绪表达类视频…
```

**服务端照样回 `success: true` 加一段自信的编造描述。** 另一个 5 MiB 样本回了「紫红色洋葱在纯白背景下旋转」。

**所以 `results[0].success` 只表示「这个引用被成功取到并消费」，不表示描述忠于画面。**

### 我们的三道防线（都已落地）

| 防线 | 挡住什么 | 错误码 |
| :- | :- | :- |
| **本地容器嗅探**（stat 之后、`readFile` 之前，只读前 32 字节） | 不是任何已知容器（ISO BMFF / Matroska / AVI / MPEG-PS） | `MINIMAX_VIDEO_NOT_A_CONTAINER`（**零请求**） |
| **字节数交叉核对**（`source: inline:<N>` 的 N vs 我们送的 N） | 字节没完整到达 | `MINIMAX_VIDEO_BYTES_MISMATCH` |
| **识别「模型自述没看到」**（中英双语正则） | 服务端自己说没看到 | `MINIMAX_VIDEO_NOT_DECODED` |

**外加文案诚实化**：工具描述顶部写明「成功只表示视频被取到并消费，**不保证描述准确**」。

---

## 五、两个值得记住的机制事实

**① 顶层 `code` 与 `base_resp.status_code` 可以互相矛盾。** 业务错误放在顶层 `code`，而 `base_resp.status_code` 仍是 `0`（"success"）。
上游的判据是**两者都要为 0 才算成功**（`packages/agent-tools/src/cloud/matrix-tools/client.ts:140-158`）。
我们最初只读后者，于是把 404 当成功——这是本轮最贵的一个教训。

**② `maxMessageBodyBytes()` 在本仓库从未被调用。** 64MB 请求体上限此前是**纸面数值**，没有任何代码实际执行。
现在 base64 内联路径自己在 stat 层拦（`MAX_INLINE_VIDEO_BYTES` 40MB，并按部署可调低的 body 上限折算），
避免大视频撞出一个难懂的传输层 "body too large"。

---

## 四、设计上的两个刻意选择

**① 上传路径是显式 opt-in（`transport: "upload"`），不是自动回退。**
自动回退到一条探针已证明读不了的路径，只是把「撞墙」换个方式发生，用户还多付一次上传。
显式参数让用户自己选，且越界报错**直接指名这个参数**。

**② 视频理解默认走 base64 内联**（`transport: "inline"`）——因为它是**唯一**被实测跑通的形态。
inline 字节预算 = `min(40MB, body 上限的 3/4 × 7/8)`（base64 涨 4/3，再留 1/8 给 JSON 信封）。

---

## 五、探针的纪律（可复用的做法）

- **先免费探形状**：用空 body 打每个端点，服务端的报错**本身就是规格书**（F1 那条报错把 `videos_understand` 的契约逐字写了出来）；
- **提交前先探提交**：用 `{}` 打 `submit_video_generation`（它会因缺 `model` 拒绝 → 不建任务 → 不计费），确认不会误建任务才提交；
- **恰好提交一次**，失败**不重发**（上游契约：失败即终局且计费）；
- **零成本复测**：`DSH_PROBE_VIDEO_TASK=<id>` 复测既有任务；真实提交需显式 `DSH_PROBE_VIDEO_SUBMIT=1`；
- **URL 只报形状**（scheme/host/段数/扩展名/query 键名），不报值；
- **短 ID 的坑**：`realUserID` 与 oss_key 里的账号 id 只有 18 位，**短于 `scrub()` 的 32 位阈值**，模式化清洗抓不到——探针为此单独加了规则。

---

## 六、勘误：两个侧栏新 client 包的 peer 范围曾被高估（2026-10-20 修正）

### 事实

`@deepseek-ai/dsh-client-ui-sidebar-documentpreview` 与 `@deepseek-ai/dsh-client-ui-sidebar-right` 是本轮新增的两个 client 依赖（见[第一节第 4 条](#一并查清的两件事)）。它们的 peer 范围当初是**照抄既有 6 个 client 包的写法**逐字复制的，于是继承了一段**虚假的低端兼容声明**：

```
^0.1.2-alpha.5 || ^0.1.2-rc.1 || ^0.1.2 || ^0.1.3 || ^0.1.4 || ...
```

但这两个包在 npm 上的**最早发布版本**分别是：

| 包 | 最早版本 | 发布版本数 | 最新 |
| :- | :- | :- | :- |
| `...-ui-sidebar-documentpreview` | **`0.1.5-alpha.2`** | 19 | `0.2.1-rc.2` |
| `...-ui-sidebar-right` | **`0.1.5-alpha.1`** | 20 | `0.2.1-rc.2` |

也就是说前 5 段（`^0.1.2-alpha.5`、`^0.1.2-rc.1`、`^0.1.2`、`^0.1.3`、`^0.1.4`）**对这两个包指向根本不存在的版本**；`0.1.5-alpha.1` 对 documentpreview 也不存在（它从 `alpha.2` 起）。

**功能上无害**（npm 会跳过不存在的版本，去选存在的），但这是**虚假兼容声明**：审计者照这个范围会以为插件支持 0.1.2 时代的宿主，而那两个包那时根本没发布过。

### 修法

只裁低端，其余段逐字不动：

| 包 | 改前（低端 5 段） | 改后（低端 1 段） |
| :- | :- | :- |
| documentpreview | `^0.1.2-alpha.5 || ^0.1.2-rc.1 || ^0.1.2 || ^0.1.3 || ^0.1.4` | **`^0.1.5-alpha.2`** |
| sidebar-right | 同上 | **`^0.1.5-alpha.1`** |

**为什么低端段不能省**：`^0.1.5-alpha.2` 覆盖 `>=0.1.5-alpha.2 <0.2.0`，而下一段 `^0.1.5-rc.1` 只覆盖 `>=0.1.5-rc.1`——**alpha 段落在 rc 之前**，没有这段低端，`0.1.5-alpha.2` 就掉出声明范围了。
**0.2.x 必须靠后面的段**：`^0.1.5-alpha.2` 上界是 `<0.2.0`，`0.2.x` 全部由 `^0.2.0-rc.1 || ^0.2.0-rc.2 || 0.2.1-alpha.5 || ^0.2.1-rc.1` 承担，**一段都不能丢**。

**devDependencies 不动**：两者的 dev 范围都是 `^0.2.1-rc.1`，对两者都真实存在。

### 证据：逐段 `npm view`

对**裁剪后**范围的每一段取基版本执行 `npm view <pkg>@<version> version`，两个包各 10 段，**全部 EXISTS**：

| 段 | documentpreview | sidebar-right |
| :- | :- | :- |
| `^0.1.5-alpha.2` | ✅ `0.1.5-alpha.2` | — |
| `^0.1.5-alpha.1` | ❌ **不存在**（故不作低端） | ✅ `0.1.5-alpha.1` |
| `^0.1.5-rc.1` | ✅ | ✅ |
| `^0.1.6-alpha.1` | ✅ | ✅ |
| `^0.1.7-alpha.1` | ✅ | ✅ |
| `^0.1.7-rc.1` | ✅ | ✅ |
| `^0.1.7-rc.2` | ✅ | ✅ |
| `^0.2.0-rc.1` | ✅ | ✅ |
| `^0.2.0-rc.2` | ✅ | ✅ |
| `0.2.1-alpha.5` | ✅ | ✅ |
| `^0.2.1-rc.1` | ✅ | ✅ |

**裁剪前那 5 段（外加 documentpreview 的 `0.1.5-alpha.1`）对两个包均 MISSING**——这就是本次修正的全部理由。

### 一个注释无处可放的问题

`package.json` **不能承载注释**：它是严格 JSON（RFC 8259 无注释语法），npm 与宿主都按严格 JSON 解析，本仓库 `test/package-integrity.test.ts` 也直接 `JSON.parse` 整份文件。写 `//` 行注释会让解析失败；塞一个 `"//"` 键虽能被容忍，但它不附着在任何一行上、无法指向具体的 peer 条目，只会变成一条无人维护的孤儿字段。

**所以理由写在这里，而不是 `package.json` 里。** 改 `peerDependencies` 时请连同本节一起读。

### 仍然存在、且**刻意未改**的两点

1. **`0.2.1-alpha.1` ~ `0.2.1-alpha.4` 不被任何一段覆盖**（两个包各有这 4 个真实发布版本）。这是**照抄写法带来的既成事实**，14 个 `@deepseek-ai/*` peer 全都只写 `0.2.1-alpha.5`。本轮只修「指向不存在版本」的虚假声明，不顺手扩大任何包的范围——否则就变成在别的包上改语义。
2. **`^0.1.6-alpha.1` 起的 0.1.x 各段在语义上被 `^0.1.5-rc.1` 包含**（后者已是 `>=0.1.5-rc.1 <0.2.0`）。冗余但无害，且是仓库既有风格，保持逐字一致以便和其余 6 个包对照阅读。
