# WorkBuddy 上游加固：把实测结论留在代码旁边

> 状态：已落地。本文记录 `src/host/workbuddy/` 上四项与上游打交道的能力工作——加密信封、出站身份、关闭思考的档位、输出上限实测表——以及它们各自的诚实边界。
> 相关：`docs/per-account-quota.md`（配额归属账号）、`docs/design-multi-account-pool.md`（号池设计）。
> 读法：每条结论后面跟着它来自哪一行代码；代码改了要同步改这里，反之亦然。写不出 `path:line` 的句子不该留在本文里。

## 1. 为什么

这几件事有一个共同点：**结论来自上游行为，而代码只记录了结论**。下一位维护者若只看代码，会看到一堆「凭什么是这个常量」的问题——`WBEF1` 为什么要出现在 AAD 里、`CLI/2.63.2 CodeBuddy/2.63.2` 为什么是字面量而不是拼出来的、`none` 为什么不在模型声明的档位梯子里。它们分别对应：与客户端二进制的字节契约、与网关的指纹契约、与档位词表的语义差。

把「测过什么、没测过什么」写下来，比把这些常量再解释一遍更重要——本文每节都有一条**未验证**，那一条才是下一次动手前该先补的东西。

## 2. 契约

### 2.1 `$wbEncrypted` 信封（`src/host/workbuddy/atrest.ts`）

桌面客户端自 2026-09-24 起把 token 存成信封而不是明文（`atrest.ts:4-9`）：`auth.accessToken` / `auth.refreshToken` 变成 `{"$wbEncrypted": 1, "envelope": base64}`。照旧读法会把信封**文本本身**当成 bearer token 发出去，于是每个请求都 401。字段名是常量 `ENVELOPE_KEY = '$wbEncrypted'`（`atrest.ts:36`）。

**密钥派生与 keyId。** 保护密钥（protector key）是 32 字节；`deriveKeyId(key) = sha256(key).hex.slice(0, 16)`（`atrest.ts:88-90`），也就是 64 bit 的十六进制前缀，同时充当信封里的 `keyId` 与 keyblob 槽位里的 `protectorKeyId`。`keyId` 不是元数据：它被写进 AAD 本身（`atrest.ts:82`），所以换一个 key 就换一段 AAD，GCM 必然验签失败。

**AAD 的字节布局（必须与客户端逐字节一致）。** `associatedData()`（`atrest.ts:74-85`）按顺序拼：

```
"WB-AAD\0"         7 字节 ASCII（末尾是 NUL）        atrest.ts:77
0x01                1 字节                          atrest.ts:78
LP(fileMagic)       u32 大端长度 + "WBEF1"/"WBEV1"  atrest.ts:79, 60-65
LP("sym-v1")        方案标记，同上                    atrest.ts:80, 50
u32(suite)          suite 号，大端                   atrest.ts:81, 67-71
LP(keyId)           keyId 的 ASCII                  atrest.ts:82
framingCode,0x00,0x00  三字节尾                     atrest.ts:83
```

`LP` 是 `lengthPrefixed()`：4 字节大端长度前缀 + UTF-8 正文（`atrest.ts:60-65`）。**前缀是 7 字节**：`"WB-AAD"` 之后还有一个 NUL，与源实现 `b"WB-AAD\0"` 一致；代码里写作 `'WB-AAD\u0000'`（`atrest.ts:77`），运行时 `Buffer.from(...).length === 7`。

> 这里原先有一处**源码缺陷**，值得记下来：文件头和这一行曾各自带一个**字面 NUL 字节**（而不是转义序列），于是 `sed`/编辑器把它显示成空格，读代码的人会以为只有 6 个字节、不含 NUL——照着「修正」就把 AAD 改短一个字节，真实客户端的信封会全部验签失败。两个字节都已改成 `\u0000` 转义，行为不变（仍是 7 字节，`test/workbuddy-atrest-identity.test.ts` 的往返用例照旧通过）。

**两种 framing。** `FRAMING` 里 `file: {magic:'WBEF1', code:1}`、`field: {magic:'WBEV1', code:2}`（`atrest.ts:39-42`）。keyblob 里被封装的 master key 走 `WBEF1/1`，`.info` 里被封装的字段走 `WBEV1/2`，**同一把保护密钥开两种**。magic 与 framing code 都在 AAD 里，因此把一个 field 信封当 file 信封解会直接验签失败，而不是解出错数据。suite 同理：`envelope.suite` 会覆盖 `DEFAULT_SUITE = 1`（`atrest.ts:47, 137`）并进入 AAD，所以串改 suite 也是验签失败。

**信封本体。** `base64(JSON{suite, keyId, nonce, authTag, ciphertext})`，AES-256-GCM（`atrest.ts:19, 124-146`）。`parseEnvelope()` 只做拆分，任何缺字段都抛 `AtRestError`（`atrest.ts:118-121`）。`openEnvelope()`（`atrest.ts:149-167`）先比 `keyId`——**在任何 AES 运算之前**就否掉错 key，报错文案直接给出两个 id（`atrest.ts:152-156`）；keyId 缺失时退回用自己派生的那个（`atrest.ts:158`）。GCM 验签失败被刻意折叠成同一句用户可见错误：「这把 key 打不开这个文件」（`atrest.ts:162-166`）——签名失败与用错 key 对用户是同一件事。`isSealedValue()` 同时认对象形态与「整个信封被存成 JSON 字符串」的老形态（`atrest.ts:98-108`）。

**粘贴密钥的两种写法。** `parseKeyText()`（`atrest.ts:188-196`）：

- 64 位十六进制保护密钥，原样 `Buffer.from(raw,'hex')`（正则 `/^[0-9a-f]{64}$/i`，`atrest.ts:177, 191`），允许 `0x` 前缀（`atrest.ts:190`）；
- 44 字符 base64 的 `atRestSecretKey`（正则 `/^[A-Za-z0-9+/]{43}=$/`，`atrest.ts:178`），按**字符串**做 `sha256(raw,'ascii')`（`atrest.ts:192`）——注意是哈希字符串而不是解码 base64，这一步就是保护密钥的派生。

两种写法落在同一个 32 字节值上（`test/workbuddy-atrest-identity.test.ts:81-85` 钉住）。写入路径在 `WorkBuddyAtRestKeyStore.adopt()`（`token-store.ts:361-370`）：解析 → 自检 → 存平台凭据库（DPAPI / Keychain / Secret Service，`token-store.ts:330-335`），返回 `deriveKeyId()` 给界面显示。**自检不过的 key 不会顶掉已经能用的 key**（`token-store.ts:316-320, 361-368`）。读取路径是 `unsealCredentials()`（`token-store.ts:595-617`）：没有 key 就记一条 `missingKey` 并返回 `null`（不是逐文件报错），而进程内的 key 槽是模块级的 `setActiveAtRestKey()` / `activeAtRestKey()`（`atrest.ts:266-281`）。

**keyblob 自检证明了什么。** `verifyKeyAgainstKeyBlob()`（`atrest.ts:246-264`）做两件事：`static-v1` 槽的 `protectorKeyId` 必须等于 `deriveKeyId(key)`（`atrest.ts:252-256`）；该槽的 `wrapped` 必须真的解出 **32 字节** master，且 `deriveKeyId(master)` 等于 keyblob 自己的 `keyId`（`atrest.ts:257-261`）。所以它证明的是「这把 key 是这台机器上这个客户端安装的保护密钥」——一次打错字当场变成错误，而不是变成一串神秘 401。它**不**证明这把 key 能打开某个具体 `.info` 文件（那由每次读取时的 `openEnvelope` 判定），也不在客户端未安装时给出否定结论：找不到 keyblob 时返回 `false`（`atrest.ts:248`），注释写得很明白——那是证据缺失，不是坏 key 的证据（`atrest.ts:242-244`）。找不到可用 `static-v1` 槽时抛错（`atrest.ts:263`）。

**诚实边界。** 这套方案**是从 workbuddy2api-hub 的 `wb_atrest.py`（MIT）转写来的，不是对客户端二进制逆向出来的**（`atrest.ts:11-13`）。含义很具体：测试只证明了「本模块自己封的信封本模块能打开」——`test/workbuddy-atrest-identity.test.ts:34-54` 的 `seal()` 助手直接 import 了本模块的 `deriveKeyId` / `associatedData`（同文件 `:6-15`），所以它与真实客户端是否一致，测试结构上无法回答。转写与客户端二进制**逐字节一致这一点未验证**；要验证只能拿一个真实的 `.info` 去开。上文的 AAD 布局表、`WBEF1/1` 与 `WBEV1/2` 的取值，都只有「转写来源」这一级证据。

### 2.2 出站身份（`src/host/workbuddy/outbound-identity.ts`）

同一个后端上有三种客户端身份。**这一行的默认身份是 CLI**，因为它是唯一在本线路上被实测接受的（`outbound-identity.ts:3-8`）：`CodeBuddyIDE` 会被 `/v3/config` 以 400 `code 12403`（"check ua"）拒掉，国际站 chat 端点直接 401。

**三种身份，以及常量是谁量的。** `OUTBOUND_PRODUCTS = ['cli','workbuddy','vscode']`（`outbound-identity.ts:41`，展示顺序），默认 `'cli'`（`outbound-identity.ts:44`）：

| product | UA | 额外头 | 证据等级 |
|---|---|---|---|
| `cli` | `CLI/2.63.2 CodeBuddy/2.63.2`（常量 `CLI_UA`，`outbound-identity.ts:88`） | 无（`outbound-identity.ts:178-179`） | 本线路实测：chat、`/v3/config`、计费在两区都接受（`outbound-identity.ts:85-87`） |
| `workbuddy` | `WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0`（intl）/ `WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1`（cn）（`outbound-identity.ts:74-77`） | `X-Agent-Intent: craft`、`X-Agent-Purpose: conversation`、`X-Agent-Type: main`、`X-IDE-Name/Type: WorkBuddy`、`X-IDE-Version`、`X-Private-Data`、`X-Machine-ID`、`X-Root-Request-ID`、trace 组（`outbound-identity.ts:142-157`） | **兄弟项目 mitmproxy 抓包** |
| `vscode` | `VSCode/1.119.0 WorkBuddy/4.9.29177644`（`outbound-identity.ts:78-80`） | `X-IDE-Name/Type: VSCode`、`X-IDE-Version`、`X-Product-Version`、`X-Env-ID: production`、`X-Machine-ID`、`X-Root-Request-ID`（`outbound-identity.ts:164-175`） | **兄弟项目 mitmproxy 抓包** |

抓包的归属写在文件头（`outbound-identity.ts:10-19`）：workbuddy2api-hub 的 `wb_identity.py`，**2026-10-16 用 mitmproxy 对国际版桌面客户端 5.8.4 实测**（`CLI/2.161.0` 出现在桌面 UA 里，也是那次抓包的一部分）。这些版本号是**常量而非探测值**：上游只校验它们的**存在与合理**，真正会被拒的是过期的那个（`outbound-identity.ts:71-73`）。cn 那一组 `5.5.6 / 2.137.1` 同样来自抓包，但**本线路没有单独复测 cn 的桌面身份——未验证**。

**为什么 `cli` 与旧头字节一致。** 三重保证：UA 是字面量而不是拼出来的（`outbound-identity.ts:82-88`）；`cli` 分支的 `headers()` 返回 `{}`，一个覆盖都不贡献（`outbound-identity.ts:178-179`）；调用点 `workBuddyHeaders()` 在没给 `channel.product` 时默认 `'cli'`（`client.ts:170-173`），身份块又在 base 头**之后**展开（`client.ts:174-190`）。另有测试钉住「零覆盖」：`outboundIdentity('cli','intl','uid-1').headers({...})` 必须等于 `{}`（`test/workbuddy-atrest-identity.test.ts:176-180`）。所以「从不碰这个偏好」的安装发出的头与加这个功能之前逐字节相同——这条是默认值不回归的**结构性**保证，不是回归测试断言出来的。

顺带一个容易看漏的细节：desktop 身份写入 `X-IDE-Name: 'WorkBuddy'`（`outbound-identity.ts:146`），而 base 头写的是 `x-ide-name: 'CodeBuddyIDE'`（`client.ts:183`，常量见 `types.ts:86`）。两者只差大小写，身份块展开在后，所以是后者覆盖前者；实际落到 HTTP 报文上的取值由 `fetch` 的头规范化决定，**线上取值未验证**。

**`auto` 保证了什么。** `resolveOutboundProduct()`（`outbound-identity.ts:61-69`）对账号键做 `sha256`，取 `digest[0] % 3` 选身份。它保证的是两件事：**同一账号终身同一个客户端**（键稳定 → 摘要稳定 → 身份稳定，这是设备指纹唯一能接受的性质，`outbound-identity.ts:54-59`），以及**一个号池整体会散到多种客户端上**（`test/workbuddy-atrest-identity.test.ts:191-196` 断言 6 个 uid 至少散出两种）。它**不**保证均匀分布（一个字节取模）。

键要注意：身份选择的键是 `accountId ?? credentials.uid ?? ''`（`adapter.ts:396`），而 `deriveMachineId()` 的键是 `credentials.uid ?? ''`（`client.ts:173` 传入，实现在 `outbound-identity.ts:99-103`）。两者**不是同一个键**：前者在有号池时是行 id，后者恒为 uid。因此「同一账号」是否始终映射到同一身份，取决于该账号的行 id 是否稳定——换一个键就会换一个身份，这是 `auto` 稳定性唯一的前提条件。

`X-Machine-ID` 是每账号稳定的伪设备号：`md5("machine:" + uid)` 重塑成 UUID 形状（`outbound-identity.ts:99-103`，uid 为空时用 `anonymous`）。注释点明为什么不能用进程级 id——那会让号池里每个账号都自称同一台机器（`outbound-identity.ts:94-98`）。trace 组（`X-Trace-ID` / `traceparent` / `b3` 等）每次请求新造（`outbound-identity.ts:110-121`）。

**明确的非主张：身份不改变配额。** 订阅额度是**账号 × 模型**在 **24 小时窗口**上计的，429 `code 6004`（`outbound-identity.ts:26-29`）。换身份不能凭空多出额度；它能给每个账号一个稳定、可信的客户端，仅此而已。身份被网关**接受**与否是另一件事：`workbuddy` 与 `vscode` 是 opt-in 尝试，本线路**从未实测它们能过**——未验证。

### 2.3 `reasoning_effort: "none"`（`model-catalog.ts` + `mapper.ts`）

`none` 的来源是`canDisableThinking`，不是档位梯子。网关在 `/v3/config` 的 `reasoning` 块里给这个布尔（`client.ts:420`），目录把它作为独立字段存在条目上（`model-catalog.ts:104`）。`none` 本身是实测得到的拼写：它是把思维链**关掉**的那个值，兄弟网关在自己便宜的调用上就这么发（`src/shared/workbuddy-contracts.ts:80-88`）——本线路未单独复测该语义，**未验证**。

**规则：解析出来的梯子必须一字不差等于网关声明的，展示层访问器才加这一档。** 两个层次分得很干净：

- 解析层（`client.ts:373-383`）只用网关给的东西：有 `supportedEfforts` 就照抄；只给一个 `effort` 时按 `WORKBUDDY_STANDARD_EFFORTS`（`low/high/max`，`workbuddy-contracts.ts:105-106`）展开；`none` **永远不进梯子**（`client.ts:377-380`）。测试钉住：网关声明 `['low','high']`，存下来就必须是 `['low','high']`，同时 `canDisableThinking` 为 `true`（`test/workbuddy-thinking-off-reset.test.ts:55-73`）。
- 展示层访问器（`model-catalog.ts:1035-1042`）`workBuddyReasoningEfforts()` 是**唯一**把这条事实变成一个可选档位的地方：`canDisableThinking && ladder 非空` 时把 `none` 前置，否则原样返回。梯子为空（纯文本模型）时什么都不加——没有东西可关（`test/workbuddy-thinking-off-reset.test.ts:50-52`）。

消费方三处，全部走展示层：`adapter.ts:212`（`resolveModel` 喂 DSH 的档位表）、`adapter.ts:285`（`effortFor` 的候选过滤）、`routes.ts:159`（设置卡片）。`effortFor()`（`adapter.ts:281-294`）按「调用方显式 → 用户默认 → 网关默认」取第一个**在展示梯子里**的值；模型不接受的档位被丢弃而不是发出去，因为上游对不支持的档位回 `code 11150`（`adapter.ts:278-279`）。选定后由 `adapter.ts:252-255` 塞进 `GenerateOptions.reasoningEffort`，最终落地为请求体的 `reasoning_effort`（`mapper.ts:695`）；值为 `'none'` 时同样原样发出（`test/workbuddy-thinking-off-reset.test.ts:75-78`）。

`none` 不是任何梯子的一档，这一点在收敛函数里也是可观察的：`convergeWorkBuddyEffort('none', ['low','high','max'])` 得到 `'low'`，即把它当作「不认识的档位」收敛到最近的一级，而不是返回一个虚构的 `none` 层级（`workbuddy-contracts.ts:122-131`，`test/workbuddy-thinking-off-reset.test.ts:80-86`）。

### 2.4 配额重置时刻（`readRateLimitReset`，`src/host/workbuddy/adapter.ts`）

24 小时额度耗尽时，上游回 429 / `code 6004`，**重置墙钟只写在消息里，从不放在响应头**（`adapter.ts:720-724`）。只看状态码就会丢掉「这个账号还要多久」这个唯一的信息，号池于是把一次 24 小时的限制按 5 分钟默认冷却处理，然后反复撞同一堵墙（`adapter.ts:725`；默认值 `POOL_COOLDOWN_MS = 5 * 60 * 1000`，`adapter.ts:102`）。

**两种 realm 措辞。** 实测两种（`adapter.ts:720-724`）：

- intl：`… resets at 2026-09-20 10:50:48 UTC+8`
- cn：`… 将在 2026-10-09 14:44:59 UTC+8 重置`

识别靠 `RESET_STAMP_RE`（`adapter.ts:714`）：`(?:resets? at|reset at|将在)` + `YYYY-MM-DD` + 空格或 `T` + `HH:MM:SS`。两种措辞各有一个测试（`test/workbuddy-thinking-off-reset.test.ts:92-102`）。

**UTC 偏移的处理。** `RESET_TZ_RE = /UTC([+-])(\d{1,2})(?::?(\d{2}))?/`（`adapter.ts:715`）在**整段消息**里找偏移（不要求紧跟时间戳），解析成 `offsetMs`（`adapter.ts:740-747`），再按「墙钟在该偏移下读数 → UTC 瞬时 = UTC 读数 − 偏移」换算（`adapter.ts:749-751`）。**没有 `UTC±h` 标记时按 UTC 处理**（`offsetMs` 保持 0，`adapter.ts:729-730` 说明这也是兄弟实现读法）。测试同时钉住「带偏移」与「裸 UTC」两种（`test/workbuddy-thinking-off-reset.test.ts:92-105`）。

**为什么丢弃过去/离谱的瞬时。** `adapter.ts:753-757`：`delay <= 0` 表示窗口已经抬起来了（过去的瞬时不是未来），`delay > MAX_RESET_HORIZON_MS`（7 天，`adapter.ts:712`）说明这是解析残渣而不是一个 24 小时额度。两种都返回 `undefined`，调用方保留自己的默认冷却。这是刻意的宽松方向：跑在失败路径上的解析器宁可给不出答案，也不该抛错（`adapter.ts:727-731`）。测试覆盖过去瞬时、无时间戳、7 年后这三种（`test/workbuddy-thinking-off-reset.test.ts:104-109`）。

**结构化 `Retry-After` 仍然优先。** 判定在 `classifyFailure()`：`(headers ? retryAfterMs(headers) : undefined) ?? readRateLimitReset(detail)`（`adapter.ts:586`，注释 `adapter.ts:584-585`）。测试 `test/workbuddy-thinking-off-reset.test.ts:122-126`：头说 30 秒、体说 2 小时 50 分，结果必须是 `30_000`。要注意两者**上界不同**：头路径的 `retryAfterMs()` 把结果压在 10 分钟（`src/host/wire-auth.ts:71, 74`），而体路径的上界是 7 天——一个 24 小时窗口本来就该由体给出，头的 10 分钟只是防呆。

解出来的时长流向号池（`adapter.ts:448-463`）：大于 `POOL_COOLDOWN_MS` 视为**长窗口**，只停用该账号的**这一个模型**（`markModelCooldown`），账号继续服务目录里其它模型；短的才按账号冷却。注释点明这正是「读头不读体会把 24 小时限制停成 5 分钟」的修复（`adapter.ts:444-447`）。整条链路的端到端测试见 `test/workbuddy-thinking-off-reset.test.ts:111-120`。

### 2.5 输出上限：测过，能力已移除

实测（2026-10-18，`deepseek-v4.1-flash`，intl 免费）：请求 `max_tokens=32768` 收到 `completion_tokens=32768` 且 `finish_reason="length"`，属「我们自己的预算用尽」，因此真实上限 **≥ 32768**；目录宣称的 128000 只是**未证实**，不是错的。把 128000 测到底需要一次约 16 分钟、13 万 token 的生成，判断价值不足，所以主动探针与 `OUTPUT_CLAMPS` 接缝**已整体删除**：`maxOutputTokensFor()` 回到直接采用目录值，仓库里不再有这张空表和那 550 行脚本。

判据留在这里备用：若将来出现「答案莫名截断」，先看 `finish_reason`——`length` 且 `completion_tokens` **严格小于**本次申请的 `max_tokens`，那就是上游的静默钳制；等于申请值则是我们自己的预算用尽。这条歧义正是当初 claim+1 探针存在的理由，也是它性价比不高的原因。

## 3. 边界

1. **加密方案只有「转写」这一级证据。** 见 §2.1 末段：`atrest.ts` 是照 `wb_atrest.py` 转写的，不是逆向二进制；测试与实现同源，无法自证与客户端一致。AAD 的 `WB-AAD\0` 前缀是**7 字节**（末尾 NUL），头注释与代码（`atrest.ts:17` 与 `:77`）现在一致，都写作 `\u0000` 转义——此前两处各带一个字面 NUL，读起来像 6 字节，改动任一侧前先用真实 `.info` 验证。
2. **keyblob 自检是「这把 key 属于这台机器」，不是「这把 key 能开这个文件」。** 后者由每次读取时的 GCM 验签回答（`atrest.ts:160-166`），且没有 keyblob 时自检返回 `false` 而非失败（`atrest.ts:248`）。
3. **身份是客户端指纹，不是额度来源。** 配额按「账号 × 模型 × 24 小时」计（`outbound-identity.ts:26-29`），换身份不能造出额度；`workbuddy` / `vscode` 被网关接受与否本线路未实测（未验证）。
4. **`none` 只出现在展示层。** 解析出来的梯子必须等于网关声明（`client.ts:377-380`）；把 `none` 写进目录条目会让「publisher 声明的档位」变成谎话，也会让收敛函数多出一个虚构层级。
5. **重置时刻来自消息文本，且带上下界。** 过去瞬时与超过 7 天的瞬时都被丢弃（`adapter.ts:753-757`）；解析不出来时调用方保留默认冷却，不抛错。

## 4. 已知未完成

- ~~`reasoning_content` 回填~~ —— **已实测并删除（2026-10-18）**。`scripts/probe-workbuddy-assumptions.probe.ts` 把「assistant 带 tool_calls、无推理文本」的同一段历史分别**带与不带** `reasoning_content: ""`，对**国际版与国内版两套后端**各发一次：四次全部 200。回复里的 reasoning 长度两边都大幅波动（带字段 0/31/0/34，不带 7/45/18/31），所以这个字段既非必需、也不是影响项。既然不是必需的，就不往线上请求里塞自造字段——`backfillReasoningContent` 及其两个私有谓词已删除，`test/workbuddy-message-shape.test.ts` 改成钉住「绝不凭空添加该字段」并把这次测量写进了测试注释。
- **prompt 模式降级未实现**：全仓 `promptMode` / `prompt-mode` 零命中，本线路没有「上游不支持某能力时退化为提示词实现」的路径，这一项**未实现**。
- **按模型冷却只活在内存里**：`markModelCooldown` 写的是 `private readonly modelCooldowns` 这个 `Map`（`account-pool.ts:333, 605-615`），读取侧 `getEffectiveCredential` 会按模型排除被停的账号（`account-pool.ts:568-574`），但没有任何序列化路径，所以 host 重启后所有模型级冷却都会丢失（账号级 `cooldownUntil` 有持久化，模型级没有）。
- **「成长任务」在本线路不存在**：`src/host/workbuddy/` 内 `成长` / `growth` 零命中，没有任何相关代码或契约，属于尚未开始的能力。
- **国际站的每日活动未验证**：日签调度写死为 CN 专属（`checkin.ts:2-11`、`workbuddy-contracts.ts:179-189`：国际部署不暴露签到接口，那些账号直接跳过），国际站是否存在等价活动**未验证**。

## 5. 测试

- `test/workbuddy-atrest-identity.test.ts`：信封开启/明文旁路/keyId 先于 GCM 否决/两种粘贴写法/keyblob 自检通过与否（`:63-105`）；密封凭据的解析、无 key 时跳过、装 key 后开启（`:107-137`）；`cli` 零覆盖、desktop 抓包头、`auto` 稳定且分散、未知偏好归一到默认、机器 id 形状（`:175-209`）。
- `test/workbuddy-thinking-off-reset.test.ts`：`none` 只在允许关思考的模型上出现、解析梯子保真、`none` 原样发出、两种重置措辞、UTC 偏移与裸 UTC、过去/离谱瞬时被丢弃、结构化 `Retry-After` 优先（`:44-127`）。
- `test/workbuddy-model-cooldown.test.ts`：停一个模型不影响同账号其它模型、被停模型改由另一个账号服务（`:55-70`）。
