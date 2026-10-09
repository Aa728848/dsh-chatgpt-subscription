# Changelog

## Unreleased

## 0.15.0 - 2026-10-09

- **[WorkBuddy] 补上网关「在服务但从不公布」的模型，并按厂商归拢模型列表**
  - **根因是一处反直觉的实测事实：`/v3/config` 不是服务全集。** 国际区实测，`gpt-6-sol`、`gpt-6-luna`、`gemini-3.8-flash` 三个 id 都能正常返回 200 的流式补全，却**完全不在目录里**（该接口只公布 `gpt-6-astra` 一个 GPT-6 成员）。判据只有一条——直接问：`code 11102`「service info not found」是没有这个模型，`code 11133`「provider rejected params」是模型存在、只是参数被拒。**`11133` 不能当存在性证据**：`max_tokens` 给得太小会把目录里的正常模型也波及进来（`gpt-5.5`、`gpt-5.4` 都会落到这一类）。
  - **只加进内置表等于加了个看不见的模型。** 联网时实时目录会**整体替换**内置表，所以这三个 id 单列一份实测表（`UNPUBLISHED_MODELS`），并在**实时目录解析**与**快照反序列化**两处合并进去；已公布的条目永远优先，合并只填目录没提到的 id。国际区因此从 22 个变 25 个。
  - **哪些字段是量出来的、哪些是继承的，界线写在代码里。** 存在性、思考档位、图片支持是**打接口测出来的**（`gpt-6-sol` 精确接受 `low`/`medium`/`high`/`xhigh`/`max`、拒绝 `minimal`，与 `gpt-6-astra` 公布的档位表一致；两者都接受 1×1 PNG）。上下文窗口、输出上限、`canDisableThinking` 则是**继承同族已公布的兄弟模型**（`gpt-6-astra` / `gemini-3.5-flash`）并就地标注——网关对这些 id 不公布任何信息，而 `max_tokens` 也不受窗口约束（连 `gpt-6-astra` 自己都接受远超其公布上限的值），从请求侧无法反推。三者仍可在设置页逐模型覆盖。
  - **同一份现场实读还修正了国际区三处数值**：`glm-5.3-flash` 国际区也开始服务（此前标为仅国区）；`glm-5.3` / `glm-5.2` 国际区输出上限是 48000、`kimi-k2.8-preview` 是 32000。**一条表同时覆盖两区时取小值**：高报会让请求被网关拒绝，低报只是提前压缩，且仍可覆盖。
  - **国区同步**：新增 `hy4-preview-f`、`space-bunny`，`hy4-preview-x` 已下线。
  - **模型列表按厂商分组，不再让网关的排列顺序决定观感。** 网关给 `/v3/config` 的顺序是交错厂商的：一行 DeepSeek、一行 GPT-6-Astra、两行混元、一行 Kimi、再三行 GPT——八个 OpenAI 模型在设置页里从不挨在一起。现在按厂商族分组，族内**新代在前**。
  - **组内排序按版本号比较，而不是照抄目录序。** 这是被实测逼出来的：只做分组时「在服务但不公布」的模型因为追加在已公布列表之后，`gpt-6-sol` 会渲染到 `gpt-5.4` **下面**——最新的沉底。改成比较 id 里的数字段后归位，且数字按**数值**比（`gpt-6.10` 在 `gpt-6.6` 之前），同版本保持目录序（`-flash` 仍领着 `-flash-sg`），读不出版本的 id（`primary-model` 这类别名）保持原位而不瞎猜。
  - **分组放在 host 而不是设置页。** `modelsForRegion` 同样是请求路径解析模型的入口，在那儿排一次，picker 与 adapter 不可能出现两套顺序；客户端一行未改。
  - 厂商归属有个坑：`hy3` / `hy4-preview` / `hunyuan-chat` 是腾讯混元的三种写法，必须归到同一组；没有任何规则命中的 id **自成一族**，而不是被扫进一个共享的 `other` 桶。
  - 测试：新增分组与排序断言（族必须连续、组内新代在前、数值比较、同版本保持目录序），并扩充三个既有目录测试。
  - 验证：`npm run typecheck` 0 错误；全量 `npm test` **2886 passed / 7 skipped**。另加两个一次性探针（`scripts/probe-workbuddy-catalog.probe.ts` 拉实时目录做差异、`scripts/probe-workbuddy-unlisted.probe.ts` 给目录外的 id 测档位/图片/输出上限），本条的每一项数值都是它们的输出。

- **[思维保护] 推理坍缩守卫补上第二条独立信号：改写型死循环**
  - **原守卫对「换个说法反复说同一件事」是瞎的。** 唯一率信号只看得见**逐字**重复；一段把同一结论用不同措辞重述的流实测只有 0.48，而阈值是 0.85，于是一路跑到输出上限也没人拦。这不是理论问题——归档样本 `paraphrased-loop-reasoning.txt` 就是这种形态。
  - **第二条信号量的是「复述」而非「新颖」。** 把窗口切成句子，逐句与至少 `semanticLag` 句之前的内容做 3-gram Jaccard 相似度并取最大值。**枚举式推理也会重复，但它是相邻重复**——每一项借用上一项的句式；复述信号**忽略相邻性**，这正是区分两者的关键，所以健康的枚举流不会被误伤。
  - **两条路径，低门槛那条在每一步都更严。** 高门槛路径（原规则，未改动）要求唯一率 ≥ 0.85 且复述 ≥ 0.35；低门槛路径（新）允许唯一率低到 0.6，代价是复述门槛抬到 0.45、**外加一道高路径不需要的新颖度上限**（不同句比例 ≤ 0.47），且需要更多次确认（5 次 vs 3 次）。**用更弱的证据换更多、更长的确认。**
  - **确认是连续窗口计数，不是单窗口触发。** 两个信号必须在同一窗口同时过线，且连续 `semanticConfirmations` 次才动手；只有一方过线、或只有单个异常窗口，一律**只记日志不动作**。断流后连击归零，下一次尝试不会继承它没挣到的确认数。
  - **近失也留痕。** 单信号命中有专门的 alone 日志（每种每轮只报一次，避免数百行刷屏），连击在够数前断掉也有 cleared 日志——否则两段短连击在日志里与一段长连击长得一模一样，确认数事后无从推理。
  - 测试：守卫测试 **39 → 80 例**（源文件 480 → 948 行），新增归档样本 fixture 与真实的改写型坍缩样本。
  - 验证：全量 `npm test` 2886 passed / 7 skipped；守卫专项 80 例全通过。

## 0.14.0 - 2026-10-08

- **[Claude] 支持 Claude Haiku 5.5（`claude-haiku-5-5`），并把申报的客户端版本抬到 2.1.293**
  - **能力表新增一行**（`src/host/claude/model-catalog.ts`）：官方 2026-10-07 发布，1M 上下文 / 128K 输出 / 支持图片，档位 `low`–`max`。**固定 id，没有日期后缀也没有别名**，所以不像 4.5 那样成对出现。
  - **每个字段来自官方文档，不是从模型名推的**：这一行与邻居在三个字段上直接冲突——`claude-haiku-4-5` 是 `budget`、可关思考、支持 temperature，5.5 三条全反（自适应思考、档位控制深度、拒绝非默认采样参数）。能力表的地基就是「名字不决定任何字段」，照抄邻居就是这条地基要防的那种错。
  - **不能用 `budget`**：官方迁移指南写明手动预算形式 `{type:"enabled",budget_tokens:N}` 在 5.5 上是 400。照抄 4.5 那一行会发出模型直接拒绝的请求。
  - **也不进 `mid-convo` 分支**：官方默认档位是 `medium`，而 `mid-convo` 在调用方未指定档位时会强制 `effort: high`——等于每次请求都替用户多花一档、多付一档的钱。这与 Opus 5.5 是同一个坑、同一份理由，因此 Haiku 5.5 同样靠 `bindsThinkingToPrefix` 拿到 `block_binding`，而**不**接受强制 effort。测试里钉死 mid-convo 白名单的那条断言也没有收录它。
  - **`canDisableThinking: true`——本表第一个为真的本地新增行**：官方明确 `thinking:{type:"disabled"}` 在 `low`/`medium`/`high` 被接受、在 `xhigh`/`max` 是 400。这条不对称能安全记成一个布尔值，靠的是本线路**发这个 form 的时机**：只有调用方明确要求关闭思考时才发，且此时**不申报任何档位**，请求因此跑在官方默认 `medium` 上——落在被接受的一侧；想用 `xhigh`/`max` 的人一定开着思考，走的是 adaptive form。反过来把「xhigh 以上 400」读成「不能关闭」才是错的——那会把低档位本来可用的开关一起拿走。
  - **与号池相关的一条用户可见后果**：官方写明 Haiku 5.5 的思考块只在产出它的账号（或其关联账号）里有效，换账号回放会被**静默丢弃**——请求成功，模型看不到那段推理。多账号轮换因此表现为「同一段对话里答案质量忽高忽低」而**不报错**。这一条记在能力表的行注释与 README 里，因为它是号池的行为，不是模型的性质。
  - **申报版本 2.1.285 → 2.1.293**：Haiku 5.5 首发于 Claude Code 2.1.293，而 `types.ts` 早就写着「默认版本必须 ≥ 首次提供每个模型的那个发行版」。这不是假设：加这一行时 npm 的 `stable` 标签**仍停在 2.1.285**（插件当时申报的值），`latest` 已经是 2.1.293——不抬版本的结果是照常广告一个每次请求都会被 `claude_code_version_too_old` 拒掉的模型，而本地预检看不出来。该行**没有** `minCliVersion`：没见过上游真的拒它，就不臆造门槛数字（Sonnet 5.5 也是这么处理的）。版本锁另加一条断言，把「≥ 2.1.293」写进测试而不只写进注释。
  - **保真锁同步跟着加**：本机参照目录（pi-ai 0.87.1）里没有这个模型，所以它进 `LOCALLY_CURATED_MODEL_IDS`，并在 `test/claude-model-catalog.test.ts` 里逐字段断言官方文档的值；该文件的三处说明文字（「今天两行」「快照之外还差几行」「两行的理由」）一并改成三行，否则文档会比锁先过期。
  - **新装默认勾选里的 Haiku 槽位换成 5.5**：默认列表每族只放一个当前代模型，所以 `claude-haiku-4-5` 被 `claude-haiku-5-5` 顶掉，长度不变。这是安装期的明确决策而不是静默追加：「未编辑过默认列表」按成员比对，老用户存的旧默认仍按原样生效，不会被这次改动悄悄改写。
  - 验证：`npm run typecheck` 0 错误；`test/claude-model-catalog.test.ts` **26 passed / 0 failed**（本机装有参照目录，15 行转录保真断言与「快照之外恰为这两行」都真的跑了，不是 skip）、`test/claude-mapper.test.ts` 91、`test/claude-adapter.test.ts` 43、`test/claude-routes.test.ts` 21、`test/claude-token-store.test.ts` 45、`test/provider-output-reservation.test.ts` 181 全通过；全量 `npm test` **2826 passed / 11 failed / 7 skipped**，11 个失败全部是 `test/claude-oauth.test.ts` 的 `No bindable loopback port in the probe range.`——本机 bind `127.0.0.1` 直接 `EACCES`（已单独探测确认），与本次改动无关。
- **[Codex] 在 ChatGPT 卡片里导入本机 Codex CLI 的登录（可选）**
  - **重复登录是纯粹的摩擦**：已经在官方 CLI 登录过的用户，登录的正是这个 Provider 服务的那份订阅，却还要再走一次完整的 OAuth。新增 `POST /adopt`，让它点一次就少一整轮登录。
  - **导入得到的是快照，本插件永不再刷新它**：ChatGPT 的 refresh token 会轮换，而 CLI 会在**原地刷新自己的文件**——两个进程刷同一份授权会互相作废，输的一方握着服务端已经作废的令牌，结果是用户**被本插件的好意踢出 Codex CLI**。进程内的单飞解决不了，因为竞态在**进程之间**：两个进程唯一共享的就是那个文件，而按只读规则本插件不能写它。因此快照只在 CLI 还为它作保时可用，**过期是收编这件事的一部分而不是缺陷**。
  - **只读是结构性的，不是承诺**：`codex-adopt.ts` 只按名字从 `node:fs/promises` 导入 `readFile` 与 `stat`，加一次写操作必须先改这行 import（而 import 是评审第一眼看的地方）；测试断言一次读取前后凭据文件的**字节、大小与 mtime 完全不变**。
  - **存在性与内容是两个函数**：`codexCliCredentialPresence()` 只 `stat`，开机即可跑；`readCodexCliCredentials()` 只在你点了导入之后才调用。合成一个「顺手先读一下以防万一」的启动路径，正是会把 opt-in 变成装饰的那种做法。
  - **每条线路只在自己的页面里回答自己的问题**：一开始把这三处做成了总览页上一次跨线路的统一只读扫描（一条统一扫描路由加一个扫描模块），结果那一块替 Claude Code 与 MiniMax Code 回答了它们自己已经回答过的问题，只能挂一句「该供应商在自己的设置页里已有导入入口，请到那里导入」——而用户就在离那一页一步之遥的地方。现在没有跨线路扫描了：Codex CLI 的答案由 `GET /status` 上的 `codexCliSignInAvailable` 给出，Claude 与 MiniMax 继续用各自的既有读取器与各自的导入入口。**「文件在哪」只有一份答案，因为只有各自的读取器拥有它。**
  - **宿主顺带报出它 stat 过的那个路径**：`GET /status` 多带一个 `codexCliSignInPath`（`codexCliCredentialPaths()` 的唯一候选，纯函数、不碰文件系统），有了它「没找到」才可追问「你到底找哪儿了」。**卡片本身不显示它**——卡片上除了按钮不加文字，本条只保证答案在接口上随时可取。
  - **「已检测到」不等于可用**：判断可用必须读取文件，那正是 opt-in 之后才做的事。未识别的形状（文件不存在、不是 JSON、`auth_mode` 不是 `chatgpt`、`tokens` 不是对象、缺 access/refresh token、access token 不是带可用 `exp` 的 JWT）一律给出 `undefined` 而不是异常，卡片报「格式无法识别」；邮箱与套餐来自 id token 自己的声明，没有就不填。`exp` 由秒换算成毫秒——错向时是静默的，而错向另一边会让一枚凭据看起来几个世纪都不过期。
  - **不猜 Kimi Code**：本机 Kimi Code 的凭据文件没有区域 / `oauthHost` / `baseUrl`，插件宁可拒绝也不猜，因此该行不出现，而不是显示成一个「装上就能收编」的承诺。
  - **卡片与号池共同钉住「只借 access token」**：`codexNeedsRefresh` 对 adopted 凭据**恒答否**，刷新钩子本身也直接拒绝（双重挡住是为了让将来漏掉前者的调用者大声失败，而不是悄悄花掉一枚不属于本插件的授权）；过期即退出调度且**不产生任何写入**，摘要标 `removable: false`，删除只能走显式的 `removeImportedAccount`。池文件往返保存该标记，于是重启后也不会把快照当成自持凭据。
  - **导入只是多一行**：不触碰当前存储的登录态；去重键 `accountId ?? email` 让同一账号重复导入时**原地更新**而不是产生重复账号。
  - 客户端只多一个按钮，且只在 **ChatGPT 卡片**里：账号池卡片头部那行「登录」**旁边**的「导入本机 Codex CLI 登录」，用共享卡片的 `renderLoginActions` 插槽，和 Claude 页面那个收编按钮同一套布局——登录保留主按钮样式，导入是次要的那个。这个按钮**不受检测结果影响，永远都在**：一个会自己消失的按钮回答不了「我本机到底登录了没有」，而没有登录时点它也并非无声无息，宿主会回一句明说缘由的错误，并显示在该卡片已有的错误条里。**卡片上不添加任何说明文字**：按钮已经说明了自己的动作，而「有没有」「找到了吗」「去哪儿找的」三段散文正是用户要求移除的「无关文字」（Claude 页面上同样的三段一并移除）。
  - **导入必须能撤销，而撤销的形状由路由决定**：`/adopt/disable` 刻意不接受 `accountId`（池对 adopted 行的删除拒绝是一条**安全**规则，逐条撤销的入口一旦能抵达自持登录就会打破它），于是撤销做成了 ChatGPT 账号池卡片下方的一个**池级**按钮「停止导入全部本机登录」，文案与提示都写明「全部」。导入行被标为 `removable: false`，共享卡片据此隐去 Delete；没有这个按钮时导入就是**单向门**，只能手改 pool 文件才能收回——一个只进不出的功能不算做完。
  - 路由：`POST /adopt`（body `{source:'codex'}`，未知来源返回一句指向真正拥有它的供应商的话，而不是静默无操作）、`POST /adopt/disable`；`GET /status` 另带 `codexCliSignInAvailable` 与 `codexCliSignInPath`。
  - 测试：新增 `test/codex-adopt.test.ts`（19 例）与 `test/codex-local-signin-ui.test.tsx`（6 例），并扩充 `test/codex-account-pool.test.ts`（27 例）与 `test/routes.test.ts`（10 例）。
  - 验证：`npm run typecheck` 与 `npm run build` 均 0 错误；`test/client-registration.test.ts` **16 passed / 0 failed**、`test/codex-import-undo-ui.test.tsx` 6、`test/codex-local-signin-ui.test.tsx` 6、`test/routes.test.ts` 10、`test/codex-account-pool.test.ts` 27、`test/codex-adopt.test.ts` 19 全通过；全量 `npm test` **2823 passed / 11 failed / 7 skipped**，11 个失败全部是 `test/claude-oauth.test.ts` 的 `No bindable loopback port in the probe range.`，在**未改动的工作树上同样复现**，与本功能无关。

## 0.13.2 - 2026-10-08

- **[Kimi Code] 读图请求按「实际发送体积」计量，超限时回收而非直接拒绝**
  - **报错 `Kimi Code rejected the request before sending: the serialized body is N bytes, above the 2097152-byte limit` 的根因是三处计量缺陷叠加，2 MB 网关上限本身没有问题**（那是 Kimi 文档里的真实限制，见其错误参考 `total message size N exceeds limit 2097152`）。
  - **图片按「存储原始字节」计量，但发出去的是「缩放后的请求版本」。** `resolveRequestImages` 会把长边超过 1024px 的图缩到 `REQUEST_IMAGE_VERSION_MAX_BYTES`（256 KiB，与官方 CLI 的 `read_byte_budget` 同量级）后再内联，而预算是拿 `attachment.bytes` 算的。一张 5 MB 截图因此被记成 ~6.7 MB base64，判定超预算 5 MB 被丢弃——可它真正上线时只有 ~350 KB，四张都装得下。官方 CLI 的做法是「送达模型前自动降采样并重新编码，避免供应商因图片过大而报错」，语义相同：**量的必须是送出去的那个版本**。现在先解析、再按解析后的真实 base64 长度计量。
  - **工具结果里的图片从未被计入预算。** `collectRequestImageBytes` 只遍历顶层 block，不递归 `tool-result`，而 `toolResultBlocks` 是会发送那里的图的。重度使用 `read_image` 的会话——也就是这个报错的典型场景——恰好系统性地少算了自己最占地方的图片。计数器现在与 `collectImageRefs` 一致地递归。
  - **超限时只会拒绝，不会回收。** `assertRequestBodyFits` 量完超限就抛 `PROVIDER_ERROR`，而此时再丢一张图很可能就装得下了。现在改为：量真实请求体 → 按需丢最旧的图 → 重新构造 → 直到塞进上限，一张不多丢。已经装得下的请求只序列化一次，字节级不变。丢无可丢时才报错，文本与工具 schema 不会被静默丢弃。
  - **报错区分「图太多」和「文本太多」。** 旧文案一律让用户去压缩会话，于是图片占主导的用户会被引向错误的 remedy。现在报出构成（`images N bytes, tool schemas N bytes, conversation text and system prompt N bytes`），并按主导项给处方：图主导提示少带图，文本主导才提示压缩会话。
  - 测试：新增 `test/kimi-code-body-fit.test.ts`（8 例），逐条锁住上述行为。
  - 验证：`tsc -b --pretty false` 与 `tsc -p test/tsconfig.json` 均 0 错误；全量 `vitest run` 2784 passed / 7 skipped。
  - **未一并处理的**：workbuddy / command-code / claude / antigravity 四条线路各有自己的本地实现，同样存在「按存储字节计量」与「工具结果图片漏算」两个缺陷，但各自预算数字不同，需逐条评估而非照搬。

- **[Codex] 请求级图片总量上限，以及请求路径失败的 cause 链（[#50](https://github.com/Aa728848/dsh-chatgpt-subscription/issues/50)）**
  - **codex 此前是全插件唯一没有请求级图片总量约束的线路。** 历史里的每张图片每轮都会被重新内联，请求体随读图数量单调增长；超过传输层能接受的体积后整轮失败。报告方的现场日志：≤4 MB 稳过、4~5 MB 掉到 3/10；合成复现里 ≥4 MB 全挂（`ERR_HTTP2_STREAM_ERROR: NGHTTP2_ENHANCE_YOUR_CALM`），≤3 MB 全过。这是**概率关系**而非硬阈值——报告者自己也标明了这一点，所以修的是「无上限」，不是「阈值是多少」。
  - 现在按**最旧优先**把超出预算的图片替换为明确的占位文本。**预算在构造好的请求体上执行**，而不是在 `options.messages` 上：图片有两种到达方式，粘贴附件是 `{ type: 'image', attachment }` 块，而工具读取的本地图片是 `![](/describe-image/raw/sha256:…)` 链接、由 `mapUserText` 在构造时才取回并内联；消息块级方案看不到第二种，且共享的 `offloadOldestRequestImages` 也不递归 `tool-result`。在构造后测量是唯一能覆盖全部形态的位置。
  - 预算是**这条线路自己的 2 MiB**，不是照搬：Kimi 的 1.5 MB 按它自己的 2 MB 请求上限定，用在这里会静默删掉本端点能接受的图片；MiniMax 的 16 MB 按 64 MB 请求体定，这里没有那个上限。`DSH_CODEX_MAX_IMAGE_BYTES` 可覆盖，非法值回落到默认而不是让守卫静默失效。
  - **只约束图片部分**：纯文本本身就超出传输层体积的请求仍会被拒绝，图片预算不解决那个问题。
  - `request()` 的 catch 补上 `errorChain()`：此前任何传输层失败都报成同一句 `Codex could not be reached.`，而 DSH 只持久化 `{message, code}`，于是 `NGHTTP2_ENHANCE_YOUR_CALM`、`ECONNRESET`、`UND_ERR_SOCKET` 在界面与日志里无法区分——正是这条让上面的体积问题无法自助定位。现在与 `streamFailure` 的既有做法一致。
  - 测试：新增 `test/codex-image-budget.test.ts`（10 例）。**承重已验证**：撤掉 offload 调用后 40 张图 ~10.7 MB 直接上线并失败；还原成信息量低的报错后 cause 断言失败。
  - 验证：`tsc -b --force` 与 `tsc -p test/tsconfig.json` 均 0 错误；全量 `vitest run` 2776 passed / 7 skipped；`npm run build` 干净。

- **[设置 / UI] 「订阅服务」改为总览卡片 + 逐线路下钻，配额进度移入账号卡片**
  - 概览页替换原横向 TAB 条：每张卡片给出该线路的账号数、连接状态、已启用模型数与启停开关（Ollama 无开关，恒为启用），点卡片进入该线路设置，返回条回到总览。
  - **每个账号的配额进度条画在它自己的账号卡片里。** 此前页面级进度条在轮询/粘性策略下会显示 A 账号的数字，而实际在服务的是 B——同一页面上两个数字互相矛盾。页面级区块只保留没有「按账号进度条」可放的事实。
  - **未测量的额度不再画成 0%。** 缺失与 NaN 一律视为「未测量」并丢弃该窗口：antigravity 此前把未测量的 bucket 强转成 0，而 0 剩余 = 100% 已用，于是服务端从未测量的额度被显示成「已用尽」。
  - 重置倒计时统一为相对时间（分钟/小时/天），同一列不再混用「近处相对、远处日期」两种口径。
  - 删除凭据储存方式的行与提示（那是实现细节，不是用户设置），删除与账号卡片重复的页面级分组/桶进度行与三条冗余连接行。
  - composer 徽标的前缀词「额度」随语言切换（此前各线路写死中文）。
  - 总览卡片的 `N/M 模型` 由各线路**已经持有的目录**回答（打开设置页不触发任何目录抓取）；从未同步过目录的线路报「未知」而不是 0。

- **[重构] 设置页与 host 装配去重（除上面列出的两处外无行为变更）**
  - 10 份内联 `fetchApi` → `common/line-api.ts` 工厂。工厂取的是十份的并集，顺带修掉两个真缺陷：ChatGPT 路由的 `{code, message}` 错误此前被印成 `[object Object]`；`{ok:false, error}` 不带 `value` 键时会被当成正常载荷。
  - 6 支 ComposerQuota → `common/ComposerQuotaBadge.tsx`。回调改走 ref：此前调用方写内联箭头会让 60 秒轮询在每次渲染时重启。ChatGPT 那支结构不同（无点击刷新、类名前缀不同、受 quickQuota 偏好门控），保持独立。
  - 6 份格式化助手与 6 份 context-window 块 → `common/format.ts`、`common/ContextWindowEditor.tsx`。合并时发现 antigravity 的 `formatCapacity` 缺 1K 下限，会把 0 渲染成 `0K`。
  - `src/index.ts` 的 7 段 claim-route 三元组 → `host/common/provider-route.ts`（171 → 42 行）。Ollama 是唯一不监听 `llm/adapters-updated` 的线路，该差异以 `watch: false` 显式保留，而不是被模板抹平。
  - 各线路 locale 命名空间的 `any` 全部类型化；badge 注册的 inject 工厂集中为一处（未做成组件表：那需要按 harness 的 composed-props 内部类型书写，等于新增版本敏感接缝）。
  - claude / minimax / workbuddy 三个巨型 Section 拆为「hook（状态与动作）+ 组件（纯渲染）」两层，hook 返回 `{ state, derived, actions }` 命名形状。
  - 故意保留的重复及原因（Codex 的 `formatDate` 收**秒**、两份 `formatPercent` 舍入不同、一处未被测试覆盖的 antigravity `title` 变化）记在 `docs/settings-hub-redesign.md` §6.3。

- **[MiniMax Code] Files API：超内联上限的媒体改走上传与 mm_file 引用**
  - 新增 `src/host/minimax-code/files-api.ts`。这是让大视频可发送的唯一路径——内联 base64 涨 4/3，
    50 MB 视频编码后约 67 MB，会超出 64 MB 请求体上限。
  - **每项事实均为实测**，因为官方客户端的 `files_api_upload_endpoint` 只是相对路径，照抄会 404：
    - 端点是 `/messages` 的**兄弟** `/mavis/api/v1/llm/v1/files/upload`。挂在 `/messages` 下面会得到
      503 `direct_route_not_configured`，挂到 host 上会得到 404 HTML——两者都不像「路径差一段」。
    - **只发 `Authorization`，不发本线路其它请求都带的 `X-Msh-*` 身份头**。带上去时服务回答
      `{"file":null,…"invalid params"}`，与「表单字段名写错」逐字节相同（我扫了 8 个字段名加空表单，
      全部同一句）。去掉身份头后同样的表单立刻成功。
    - 表单 `purpose` 在前、`file` 在后；取值 `image_understanding` / `video_understanding`。
    - 响应 `file.file_id`，但**失败时 HTTP 是 200**，必须同时检查 `base_resp.status_code === 0`，
      否则会把字面量 `"null"` 当 id 发上线。
    - 引用形态 `mm_file://<id>`，裸 id 会被拒为「非 http(s)」。
  - 四个生命周期职责：TTL 取 12 小时并在过期后重传；缓存 key 含账号，**id 绝不跨账号复用**
    （未验证是否跨账号可读，按不可读处理）；删除因**服务端没有 delete 路由**而做不到，改为靠内容哈希
    去重控制上传量；失败降级为「媒体保持内联、请求继续」，不让优化失败拖垮整轮。
  - 触发点在两个体积 offload 之后，且只上传超过内联上限的媒体。
  - `503 direct_route_not_configured` 单独归类为 `route-not-configured`，与「表单被拒」区分：
    前者是账号没开该路由、重试无用，后者是请求本身的问题。
  - 端到端验证：真实上传取得 `file_id`，以 `mm_file://` 引用发送，messages 返回 200。
  - 测试：新增 `test/minimax-files-api.test.ts`（17 例），其中三例锁定本轮踩过的坑
    （路径是兄弟而非子路径、只发 bearer、非 JSON body 要如实报告而非谎称「无理由拒绝」）。
  - 实测细节与仍未解决的问题记录在 `docs/minimax-files-api-handoff.md`。
  - 验证：`tsc -b --force` 与 `tsc -p test/tsconfig.json` 通过；`vitest run` 2555 passed / 7 skipped；
    `npm run build` 通过。


- **[MiniMax Code] 支持视频输入；把视频子系统提取为两条线路共享**
  - **视频能力（N6）**：M3 与 M3.1 现在声明并支持视频输入，此前只有文档记载、路由没有实现。
    块形状与 base64 取向**均为实测**，未沿用 Kimi 线的猜测：
    - 端点接受 `{ type: 'video', source: { type: 'base64', media_type, data } }`，并会解码后跑 ffprobe 校验；
    - **裸 base64** 正确；`data:` URL 会在第 4 字节被拒（MiniMax 与 Kimi 的取向**相反**）；
    - `video_url`、把视频当 image、document 块三种形状均被明确拒绝；
    - 无可读字节、或模型不支持时，降级为解释性占位文本而不是静默丢弃。
    内联预算 `MAX_REQUEST_VIDEO_BYTES = 16 MB`（base64 涨 4/3，文档的 50 MB 会超出 64 MB 请求体上限）；
    更长的视频需要 Files API，见交接文档。
  - **共享化**：视频的块类型、模态表增强、遍历、字节预算与 base64 编码，从 Kimi 线的 mapper 提取到
    `src/host/common/video.ts` 与 `src/host/common/video-request.ts`。
    必须共享的原因：`ModelModalityMap` / `ContentBlockMap` 的模块增强是全局的，
    两条线路各写一份就是对同一个 `video` 键的重复声明。**wire 形状仍各线自有**——
    两条端点的 base64 取向相反，不能共用编码。
  - **能力表更新**：M3 / M3.1 的 `inputModalities` 加入 `'video'`。
    该字段是 DSH 能力管道（提示准入、模型选择器、子代理委派）会据以行动的声明，
    因此只有在线路真的能编码时才列入。
  - **测试**：新增 `test/video-shared.test.ts`（7 例）覆盖共享层，
    其中一例专门锁定「裸 base64、不加 data URL 前缀」这条与 Kimi 相反的约定；
    更新 minimax review-fixes 的视频用例（此前断言「永不声明 video」，现改为「只在支持它的模型上声明」）。
  - **N4 Files API 未实现**：已写交接文档 `docs/minimax-files-api-handoff.md`，
    记录实测事实、实现清单、四个必须自建的生命周期职责，以及「不该做的事」
    （其中「把 maxAttachments 当内联上限」是本轮已被实测推翻的错误）。
  - **验证**：`tsc -b --force` 与 `tsc -p test/tsconfig.json` 通过；
    `vitest run` 2538 passed / 7 skipped；`npm run build` 通过。

- **[MiniMax Code] 按官方文档更正 thinking 控制字段**
  - **背景**：与官方开源客户端 `MiniMax-AI/minimax-code`（`56221c1`）对照后，逐项核对 MiniMax 官方文档
    `platform.minimax.io/docs/guides/text-generation.md`，发现 thinking 控制字段的形状与文档不符。
  - **thinking 字段更正**（经实测确认）：
    - 文档明确 **Thinking is on by default and needs no configuration**。原实现发送的
      `thinking: {type:'enabled', effort}` 是**从未被文档支持的推断字段**——这也解释了为什么它
      一直「生效」：思考之所以出现是因为模型默认就在思考，与该字段是否被读取无关。
      现**完全不再发送 `thinking` 对象**。
    - 文档的协议对照表规定 Anthropic 兼容面的思考深度字段是**顶层 `output_config.effort`**，
      而非 thinking 对象内部。原实现把 `effort` 放错了层级，服务端不会读取。
    - 文档的 effort 取值只有 `low` / `medium` / `high` / `xhigh` / `max`，且**省略即 max**。
      原实现的 `'default'` 是本地占位值，现不会到达 wire；调用方未指定时整个 `output_config` 字段不出现。
    - 实测确认：用一个需要真实推理的题目，`low` 约 1.1–1.3K 输出 / 11–14s，`max` 4000 输出触顶 /
      51–62s，约 3 倍思考量、4 倍延迟，字段确实被读取。（用简单题目测会得到「无差异」的**假阴性**——
      任何档位下思考量都相同。）
  - **实测纠正一处误判**：曾按「`maxAttachments` 只声明、无人执行」为它新增按数量截断，随后用已登录账号
    实测发现 **M3 带 4/5/8/9/10/12/20/48 张内联图全部返回 200**，订阅端点对内联图片**没有数量上限**。
    该字段来自模型的 **Files API 能力块**（`max_attachments_count`），描述的是**上传路径**，
    而本线路从不走上传——与 `filesApiDocumented` 描述的是同一件事。**按数量截断只会白白丢掉服务
    免费接受的图片，已回退**；字段文档改写为「Files API 的数字，本线路不上传」。
    教训：「声明了却无人执行」不总是 bug，先要确认那个声明描述的是不是自己走的路径。
  - **补齐缺失的请求形状测试**：此前 `thinkingFieldFor` / `body.thinking` / `output_config` 在整个
    测试树中**零命中**——现有的 thinking 回放用例只检查**响应侧**，所以请求体字段写错永远不会被发现，
    这正是该推断字段能长期存活的原因。新增 7 例锁定：任何模型任何档位都不发送 `thinking` 键、
    effort 落在顶层、省略时字段不存在、非法档位不落到 wire。
  - **验证**：`tsc -b --force` 与 `tsc -p test/tsconfig.json` 通过；`vitest run` 2529 passed / 7 skipped；
    `npm run build` 通过。
  - **留待决策 / 实测**：
    - 官方文档规定**省略 effort 即为 max**，而 `max` 档在 4000 输出上限下就已触顶。这意味着
      **未指定档位的请求默认跑在最贵档位**。这是文档定义的行为而非缺陷，但是否把默认降到 `high`
      值得作为产品决策复核。
    - 实测确认 **M3 可以关闭思考**（`effort:'none'` 生效），**M3.1 忽略它并继续思考**，与官方文档一致，
      因此现有的 `toggle` / `forced-effort` 划分保持不变。
    - M3 上下文 512K（本线路，抄自订阅 `config.yaml`）vs 1M（平台文档）口径不同，需约 4 MB 提示才能
      验证，**未获授权前不烧额度**，保持原样。
- **[Kimi Code] 对齐官方客户端的 K 系列模型能力，修复两处正确性缺陷与一处并发归因错误**
  - **背景**：与官方开源客户端 `MoonshotAI/kimi-code`（`21406fb`）逐文件对照后的 11 项差距，分四批落地。
  - **正确性**：
    - tool-call id 原本只做 `slice(0, 64)`——共享 64 字符前缀的两个 id 会被截成同一个，**后续工具结果配错到错误的调用**；且不净化字符，`.` `:` 空格可能让服务端拒绝整个请求。现改为「净化 + 截断 + 碰撞递增后缀」，后缀同样受 64 上限约束。请求侧与流式侧共享同一个 normalizer，保证同一调用在两侧得到同一 id。
    - reasoning 字段名原本硬编码 `reasoning_content`。Kimi 用该名，但新版 vLLM 已改名为 `reasoning` 且请求侧**只认**新名（vllm#38488）——回写旧名会静默丢失每个历史 assistant 轮次的思考链，并触发 "thinking is enabled but reasoning_content is missing"。现按对端实际用过的键回写（覆盖 `reasoning_content` / `reasoning_details` / `reasoning`）。
  - **并发**：前缀稳定性追踪与缓存统计原本是进程级单例，DSH 多会话 / subagent 并行时会互相覆盖，归因指向**另一个会话**的变更——这类错误比没有归因更糟，因为用户会相信它。现按 `sessionId`（漂移）与 `sessionId + accountId`（缓存统计，账号池下每个账号在服务端各有一份缓存）分桶，并有 256 会话 LRU 上限。状态接口新增 `?sessionId=` 参数。
  - **服务端声明驱动**：新增 `supports_thinking_type` 三态（`only` 剔除 `none`、`no` 返回空）、`limit.input` 独立输入上限（prompt 用 `min(window, cap)` 夹，输出仍用完整窗口）、`supports_tool_use`（与「不支持消息级工具」区分开）、`status` 退役模型过滤。设置卡片相应展示「输入上限」「不支持工具」。
  - **成本可见性**：新增缓存过期提示——空闲超过所选 TTL 且上下文足够大时提示下一轮将重新处理的 token 数。判定沿用官方的「缺数据即跳过」原则，宁漏报不误报。`cacheWriteTokens` 保留字段并标注该线路恒为 0。
  - **验证**：`tsc -b --force` 与 `tsc -p test/tsconfig.json` 通过；`vitest run` 2522 passed / 7 skipped（新增 45 例）；`npm run build`、`npm pack --dry-run` 通过。
  - **未做**：Moonshot 开放平台（API Key）线路——它是唯一能触达 `kimi-k*` 真实 K 系列 id 的路径，按决定暂缓。

- **[Kimi Code] 图片超预算时按需缩放而非丢弃，稳定提示缓存前缀**
  - **现象**：一次 UI 走查连续贴入 10 张 1440×1000 截图时，`cacheReadTokens` 四次断崖式下跌（100,864 → 16,384 等），合计约 13.3 万 token 被迫按未命中全价重算。
  - **根本原因**：Kimi 网关对单次请求的**整个消息体**限制 2 MB（官方报错 `total message size N exceeds limit 2097152`），图片 base64 与对话文本、工具 Schema、System Prompt 共享该额度。插件的 `MAX_REQUEST_IMAGE_BYTES`（1.5 MB）超出后，`offloadOldestRequestImages` 从最旧的图开始丢弃。**丢弃张数随每张新图递增，而每次变化都会重写保留前缀，于是下一轮缓存再次失效**——第 4、6、8、10 张图各触发一次，四次全部落在图片注入之后。
  - **修复方案**：
    - `resolveRequestImages` 对长边超过 1024 px 的图片调用 Harness 的 `attachments.readImageRequest` 派生缩小版本（目标 256 KiB 原始字节，约 350 KiB base64，四张可落入 1.5 MB 预算），已在限额内的图片保持原字节不变。存储的原图与会话历史均不作修改。
    - **为何按长边而非累加字节判定**：`readImageRequest` 的 `variantId` 由附件与目标内容寻址，同一张图在每一轮得到同一个 target，字节恒定；若改按累加量动态调整 target，每新增一张图都会改写全部旧图字节，反而造成更频繁的缓存击穿。
    - **降级容错**：派生版本仍超边长时优雅降级为 `[image unavailable]` 占位文本；派生失败同样降级；用户主动取消（Abort）正常透传。
    - `offloadOldestRequestImages` 的丢弃逻辑保留为总量兜底，仅在原图大到缩放也装不下时触发。
  - **测试与验证**：新增 11 项回归测试（长边/竖图缩放、已在限额内逐字节原样发送、十张 QA 图不再触发丢弃、派生超限与失败降级、取消透传）；`npm run typecheck`、`npm test`（2467 passed / 7 skipped）与 `npm run build` 全部通过。
  - **已知限制**：十张 1440×1000 截图缩放后仍超出 1.5 MB 预算，需缩到 1000 px 宽以内（四张以内）方可全量保留；本改动的作用是使省略数量不再随新增图片递增，从而不再反复击穿缓存。

- **[Antigravity] Claude 工具 Schema 兼容降级处理（[#39](https://github.com/Aa728848/dsh-chatgpt-subscription/issues/39)）**
  - **背景与现象**：Claude 对出站工具的 JSON Schema 要求较严苛，包含复杂联合类型时容易报错。
  - **解决方案**：
    - **Schema 折叠降级**：仅针对 Claude 目标，在出站边界折叠 `anyOf` / `oneOf` / `allOf` 与类型联合；优先保留可填写的对象形状，将原始备选形式与约束摘要放入字段描述（Description）中。
    - **枚举合并**：同类型枚举合并时保留空字符串重置值。
    - **覆盖范围**：覆盖调度参数、权限枚举、引用引用（$ref）、数组、根级联合、可空类型及单分支结构。
    - **隔离保障**：此改动为网关兼容降级，不修改原始工具 Schema；Gemini 保持原转换路径；工具端仍严格校验实际参数。
  - **验证**：通过离线序列化请求验证，全量测试通过（2456 passed / 7 skipped）。

- **[通用配置] 网页抓取 Provider 选择与响应上限可配置（[#40](https://github.com/Aa728848/dsh-chatgpt-subscription/issues/40)）**
  - **新增配置项（插件 Config）**：
    - `fetchProvider`: 可选 `auto | plugin | dsh`（默认 `auto` 保持既有行为）。`dsh` 显式优先于代理检测和 Codex 搜索选择；`plugin` 则独立启用插件自身抓取。
    - `fetchMaxBodyChars`: 抓取正文最大字符数（默认 100,000，须为正安全整数）。
    - `fetchMaxResponseBytes`: 最大响应字节数（默认 2,097,152，即 2 MB，须为正安全整数）。
  - **界面与日志**：插件状态接口、设置页及切换日志展示当前配置与上限（日志中自动脱敏代理凭据）；README 补充配置重载说明。
  - **注意事项**：DSH 抓取模式不使用插件设置的上限；工具层另有固定输出限制。测试已固定离线 DNS，不再依赖本机透明代理。

- **[Claude] 修复多图会话因单张宽图导致后续所有轮次永久卡死 400**
  - **报错信息**：`messages.N.content.M.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels`
  - **根本原因**：
    - **Anthropic 接口限制**：单张图片最长边上限为 8000 px；但当单次请求图片**超过 20 张**时，每张图片的最长边不得超过 **2000 px**。
    - **存图与累积**：DSH 归一化存图规则为总像素 2048×2048、最长边 8192，导致常见并排对比截图（如 2904×1272）被原样落盘存储。会话历史不断累加图片，一旦总数 >20 且存在宽图，整轮请求即报 400，且后续轮次及派生（fork）会话均无法自行恢复。
  - **修复方案**：
    - **动态上限决策**：`resolveRequestImages` 预先统计请求包含的图片总数（含重复附件及 `tool-result` 嵌套图片），超过 20 张时将最长边阈值收敛至 2000 px，否则为 8000 px。
    - **精准按需压缩**：仅对超限图片调用 Harness 的 `attachments.readImageRequest` 派生缩小版本；未超限图片保持原字节不变，确保提示缓存（Prompt Cache）前缀稳定。存储的原图及会话历史均不作修改。
    - **降级容错**：若无法获取缩小版本或派生结果依然超限，优雅降级为可见的 `[image unavailable]` 占位文本，避免整轮对话崩溃；用户主动取消（Abort）正常透传。
    - **老版本兼容**：兼容 peer 范围内 0.1.2-alpha.5 起各代 Harness（兼容旧版 `maxPixels` 与新版宽高目标参数，按未取整宽高比计算像素预算）。
  - **测试与验证**：新增 7 项边缘限制回归测试，并通过 34 张真实历史图片（含 3 张 2904×1272 截图）离线回放验证，超限图成功缩至 2000×876，其余 31 张原样发送。

- **[通用机制] 插件内上下文预算自愈恢复机制（400/422 重试）**
  - **适用范围**：Kimi Code、MiniMax Code、Command Code、Claude、WorkBuddy。
  - **工作机制**：
    - 当模型请求返回 HTTP 400 / 422 且明确报告了自洽的窗口、输入及输出 token 计数时，若当前输入仍能容纳且上游输出预留与实际发送上限一致，插件会自动保留全部完整消息与工具定义，**仅下调输出上限并自动重试一次**（预留 1024 tokens 余量，且至少保留 1024 输出 tokens）。
    - 普通生成请求与压缩摘要请求共用此恢复链路，无需修改 DSH 核心代码，亦不截断历史消息。
  - **边界保障**：显式 `thinking budget` 不满足时不强行重试；鉴权失败、限流、请求体超限、模糊计数及流式错误均维持原样报错。Kimi / MiniMax 的输入估算补齐了推理文本与工具调用参数计算。

- **[设置 / UI] 修复设置页「订阅服务」整页样式丢失（仅标签栏有样式，正文裸奔）**
  - **根本原因**：客户端插件系统的样式归属记账机制存在副作用。当其他模块 Materialize 时，会扫描并认领页面内所有未打标（`style:not([data-plugin])`）的 `<style>` 标签。当那个模块被重载或销毁时，会调用 `removeOwnedStyles` 批量删掉名下标签。本插件原先注入的 7 张独立样式表未打上 `data-plugin` 属性，导致被其他插件误认领并随之被删除，仅留存了聊天区的 `.../main` 样式表。
  - **修复方案**：
    - 新增 `src/client/common/plugin-style.ts` 中的统一安装器 `installPluginStyle(name, css, legacyId?)`。
    - 统一按 `data-plugin-css` 定位，创建或命中时均强制打上本插件的 `data-plugin` 归属标记；CSS 变更时直接更新 `textContent`，`disposer` 设为空操作以将样式表托管给文档生命周期。
    - 自动就地接管旧 bundle 残留在 DOM 中的未打标样式元素，杜绝重复注入和误删。
  - **验证**：新增 `test/client-style-ownership.test.ts` 5 项测试，断言 DOM 中无遗留未标记样式表，且模拟重载清理后能完整恢复。

- **[Ollama] 修复「同步模型列表」报 `Unexpected end of JSON input`（[#36](https://github.com/Aa728848/dsh-chatgpt-subscription/issues/36)）**
  - **根本原因**：
    - 并非 Ollama Cloud 端点或 Token 鉴权问题，而是插件自身的 `/ollama/api` 路由处理器未加全局 `try/catch` 保护。
    - 当底层设置落盘失败抛错时，DSH 内置 Web Server 会返回一个完全没有 Body 的空 HTTP 400 响应（`res.writeHead(400); res.end()`）。前端卡片直接调用 `response.json()` 解析空响应体，触发原生语法解析异常，掩盖了真实的报错原因。
  - **修复方案**：
    - **服务端兜底**：路由处理器全量增加 `try/catch`，统一采用 `{ ok: false, error }` 规范封包返回，并补齐 404 兜底与独立保护。
    - **精细化错误诊断**：新增 `fetchCatalog()`，区分 `auth`（401/403，提供 API Key 链接）、`upstream`（上游其他状态码）、`unreachable`（DNS/TLS/超时）、`malformed`（代理返回 HTML 等非 JSON 格式）；细化区分“未配置 Key”与“所有 Key 均在冷却中”。
    - **客户端安全解析**：前端改用先读文本再解析的策略，遇空响应体或非 JSON 格式时清晰展示 HTTP 状态码与 Content-Type，杜绝原生异常弹窗。
  - **验证**：新增 12 条路由回归测试（包含写入中断断言）及 8 条客户端解析测试，测试全部通过。

- **[通用机制] 上下文超限错误归一化映射以支持 Harness 自动压缩**
  - **改进内容**：
    - 将 MiniMax、Kimi、Codex、Claude、Command Code、WorkBuddy 与 Antigravity 接入的 HTTP/SSE 上下文超限错误标准归一化为 `CONTEXT_WINDOW_EXCEEDED`。
    - 使得支持溢出自愈的 Harness 能顺利触发会话压缩与历史修剪，而非直接以 Provider 普通错误中断对话。
    - 鉴权、限流、配额不足及输出长度上限等错误保持独立归类；Command Code OpenAI 协议及 Antigravity 流内错误帧不再被静默忽略。

- **[Claude / Command Code] 修复登录时弹出两个一模一样授权页的问题（[#33](https://github.com/Aa728848/dsh-chatgpt-subscription/pull/33)）**
  - **根本原因**：
    - 授权窗口被前端与后端各触发了一次：前端设置卡片在 `/login` 返回后调用 `window.open(authUrl)`；而主机端 `/login` 路由在调用 `beginLogin` 时未显式传入 `openBrowser` 参数，触发了默认逻辑，在宿主机上通过系统命令（`cmd /c start` / `open` / `xdg-open`）再次拉起了浏览器。
  - **修复方案**：
    - 统一采用“仅在前端卡片打开”的交互范式，保留用户界面所在终端的 `window.open`（支持远程访问 GUI），主机端默认将 `openBrowser` 置为空操作，彻底消除双重拉起。
    - 经全线路审计：Antigravity、WorkBuddy、Codex 均已是单开，本次修复完善了 Claude 与 Command Code 两条线路。

- **[Codex] 修复响应流异常中断被误判为 `UNKNOWN` 导致拒绝重试（[#32](https://github.com/Aa728848/dsh-chatgpt-subscription/issues/32)）**
  - **根本原因**：
    - 底层 Undici 连接在流消费阶段异常断开时抛出无 Code 的 `TypeError: terminated`（真实原因挂载在 `.cause`，如 `ECONNRESET`）。
    - 错误经过适配器边界时被默认归一化为 `code: "UNKNOWN"`，而 Codex 线路声明的可重试集合不包含 `UNKNOWN`，导致 `dsh-llm-retry` 放弃重试，一次网络微小中断即导致整轮任务失败。
  - **修复方案**：
    - 在 `ResponsesClient.stream()` 消费阶段补齐 `catch` 并由 `streamFailure()` 归类：非取消错误一律归类为 `TRANSPORT`，并将完整 Cause 链路提取至 Message（如 `Codex stream failed: terminated: read ECONNRESET`），成功命中可重试策略。
    - 即使流已产生部分 Chunk 也依然按可重试处理（由 DSH 将半截输出结算为已丢弃的 Attempt，重试会重新开启完整尝试，工具调用只在流正常结束时执行，安全无副作用）。
  - **验证**：新增 4 项流异常分类测试，断言 Undici 中断错误能正确识别为 `TRANSPORT` 并触发重试策略。

- **[Antigravity] 修复 Claude 普通文本回放碎片化导致触碰缓存上限**
  - **改进内容**：
    - 修复此前将每个 SSE 文本 Delta 都回放为独立内容块的问题。
    - 回放时仅合并相邻的纯文本 Part，保留签名、工具调用及其他元数据边界（Gemini 逻辑保持不变）。
    - 消除因数百个碎文本块触碰 Claude 20-position 缓存回看限制的问题，优化多轮对话缓存复用率。

- **[Antigravity] 修复 Claude 多轮对话报 `thinking.signature: Field required`**
  - **改进内容**：在请求回放时，自动将连续的思考分片与独立签名合并为结构完整的 Thinking Part；自动剔除缺少签名的残缺分片及跨模型残留 Reasoning，保留正常正文与工具调用。

- **[Antigravity] 新增 Claude Opus 5.5 / Sonnet 5.5 模型支持**
  - **改进内容**：
    - 对齐 `fetchAvailableModels` 实时目录，新增对应 `-low` / `-medium` / `-high` 推理档位路由。
    - 默认上下文窗口与输出上限沿用反重力 Claude 规范（1M / 64K）。用户可在设置中自主勾选启用。

- **[协议复核] 多线路 Provider 报文格式与并发闸门校准**
  - **改进内容**：
    - 校准 Command Code Responses 的真实事件标识、块索引与多模态报文；
    - 规范 Ollama 原生图片/工具参数传递、附件降级机制及工具历史格式；
    - 增强 MiniMax 原生回放的来源隔离与顺序保护；
    - 优化并发闸门控制逻辑，正确处理动态降限、正小数配额与取消竞争；Codex 改用请求本地释放句柄，不再由普通 429 误推断全局并发上限。

- **[思维保护] 修复思维坍塌保护（Reasoning Collapse Guard）构造非法消息导致会话损坏**
  - **问题现象**：触发推理坍塌守卫后，会话卡死且 DSH 提示「是否修复插件根因」。
  - **根本原因**：
    - 守卫构建续跑消息时使用了手写字面量对象 `{ role: 'user', content: [...] }`，缺少 `id` 与 `source` 属性。
    - DSH 在 `session.append` 时进行严格校验，抛出 `lacks an identified message` 及 `has invalid source` 异常，导致会话状态损坏并中断。
  - **修复方案**：改用官方 `createUserMessage()` 工厂函数，并附带本插件专用的 `dsh-chatgpt-subscription` source kind、`form: 'notice'` 标记与摘要信息，确保在全代际 DSH 运行环境中均完全合规。
  - **测试**：新增集成用例，将守卫输出的消息送入真实 `adoptSessionEvent` 校验通过。

- **[压缩策略] 修复输出上限作为固定预留导致自动压缩失效（[#30](https://github.com/Aa728848/dsh-chatgpt-subscription/issues/30) / [#31](https://github.com/Aa728848/dsh-chatgpt-subscription/issues/31)）**
  - **改进内容**：
    - Kimi / MiniMax 不再将动态预算上报为固定的 `defaultMaxTokens`，改为在发送阶段动态计算并对齐上限，避免压缩器误扣固定额度。
    - 其余六条线路对齐 DSH 默认压缩策略，安全过滤过大的默认预留值，解决 Command Code（Kimi-K2.6、Grok 4.5/4.6）及 WorkBuddy（deepseek-v3-2-volc）因预留过大导致无法触发压缩的问题。

- **[Codex] 对齐官方客户端默认参数：优化 Verbosity 并默认省略推理摘要以节省额度**
  - **背景与取证**：
    - 与官方 Codex CLI 随包模型表（`codex-rs/models-manager/models.json`）及真实会话报文严格核对：官方每个模型均声明 `default_reasoning_summary: "none"`、`default_verbosity: "low"`、`support_verbosity: true`。
  - **问题分析与修复**：
    - **额度浪费修复**：此前未配置时插件发送 `{ summary: 'auto' }`，而推理摘要属于计费输出内容，导致用户每轮对话都在产生额外计费。现修复为：未配置或选“无”时**完全省略 `summary` 字段**（对齐官方 `skip_serializing_if = "Option::is_none"`）；显式选择 `auto` / `concise` / `detailed` 时如实发送。
    - **详细度对齐**：此前未配置时不发送 `text` 字段，服务端会套用默认的 `medium`，导致生成文本比官方更啰嗦。现未配置时按目录默认发送 `low`。
    - **模型能力感知**：新增 `codexCatalogEntryById()`，仅对明确声明支持 `supportsOutputVerbosity` 的模型发送 `text.verbosity` 字段，避免向未知模型注入非法字段。
  - **测试**：新增 5 项官方契约回归测试，锁定默认参数与字段省略逻辑。

- **[Command Code] 同步官方 92 个新模型目录，补齐思考等级与多模态输入**
  - **根本原因**：
    - 插件内置能力表滞后（仅包含 74 个旧模型），而官方 CLI 注册表及实时 `/provider/v1/models` 端点已扩充至 92 个模型。适配器对未知模型采取保守回退策略（纯文本且无思考等级），导致 16 个真实在服模型丢失了图片输入和思考档位选择（如用户反馈的 `deepseek/deepseek-v4.1-flash-fast`，以及 `gpt-6-sol`、`claude-sonnet-5-5`、`xai/grok-4.7`、`z-ai/glm-5.3-flashx` 等）。
  - **修复方案**：
    - **重构能力目录**：完整同步官方注册表（覆盖 85 个实际服务模型），精确补齐上下文窗口、maxTokens 与思考档位；
    - **规范化思考关闭（off -> none）**：读取端将官方注册表的 `off` 映射为 DSH 标准的 `none`；向底层发包时彻底移除 `reasoning` 字段（该线路上游通过省略字段表示关闭思考）；
    - **防止 cross-model 400 报错**：设置页提供全局默认档位，但不同模型支持的档位不同；适配器发包前动态校验模型支持档位，若全局默认档位不被当前模型支持，自动回退到该模型自身的默认档位，杜绝上游拒绝。
  - **测试与验证**：新增实时模型覆盖与 `none` 字段省略断言，全量测试通过。

- **[Codex] 修复对话每轮报 400：移除上游拒收的 `max_output_tokens` 字段（[#29](https://github.com/Aa728848/dsh-chatgpt-subscription/issues/29)）**
  - **根本原因**：
    - 插件在请求未指定 `maxTokens` 时会自动补上模型上限并发送 `max_output_tokens` 字段。然而订阅版 Responses 对话端点会直接拒绝该字段（返回 `400 Unsupported parameter: max_output_tokens`）。
    - 经查阅官方 Codex CLI 源码（`ResponsesApiRequest`），官方客户端在对话时**从不发送**此字段；发它是插件早期的冗余实现。
  - **修复方案**：
    - 在 `buildResponsesPayload()` 中彻底删除 `max_output_tokens` 写入，生成长度交由服务端默认行为决定（与官方 CLI 一致）。
    - 适配器内部仍正常上报 `defaultMaxTokens` 供 DSH 本地用于计算压缩窗口预算（不出进程）。
  - **测试**：重写契约测试，断言对话报文绝不携带 `max_output_tokens` 字段。
  > ⚠️ **历史说明**：更早版本中“修复声明了输出上限却从不发送”的条目已被推翻，确认对话端点不可发送该字段。

- **[Codex] 修复模型选择器在部分套餐（如 Prolite）下显示为空的问题**
  - **根本原因**：
    - 接入实时模型目录后，插件将订阅接口返回的模型与用户勾选的可见模型取交集。
    - 部分订阅套餐（如 Prolite）的 `GET /backend-api/codex/models` 仅返回了代码审查相关的 slug（如 `codex-auto-review`），交集计算后导致列表为空。实际上该账号具备普通对话模型的可用权限。
  - **修复方案**：
    - 订阅目录依然作为可用模型的权威参考；但当交集为空时，**优雅回退至插件内置的模型表**，并按用户勾选进行过滤，确保模型选择器永不意外变空。
  - **测试**：覆盖空目录场景与有效目录场景的边界测试。

- **[MiniMax] 修复请求体 2 MB 本地虚假拦截与图片预算过小问题**
  - **问题现象**：会话进行到约 2 MB 时，插件在本地直接抛错拦截（`request was not sent: the serialized body is ... above the 2097152-byte ceiling`），请求根本未发出。
  - **根本原因**：
    - 插件原实现错误复用了 Kimi 线路的 `MAX_MESSAGE_BODY_BYTES`（2 MB）。2 MB 是 Kimi 网关自身的硬性限制，而 MiniMax 的 Anthropic 兼容端点支持数十 MB 的请求体。
    - MiniMax 允许单张图片 10 MB 原始数据，2 MB 的整包限制会导致单张合法图片即触发本地误拦截。
    - 类似地，图片预算原先也错误借用了 Kimi 的 1.5 MB 预算，导致合法图片被静默替换成了占位文本。
  - **修复方案**：
    - **独立上限**：将请求体上限调整为 MiniMax 自有的 `DEFAULT_MAX_MESSAGE_BODY_BYTES`（64 MB），并支持环境变量 `DSH_MINIMAX_CODE_MAX_BODY_BYTES` 自定义覆盖；
    - **放宽图片预算**：将单图预算调整为本线路自有的 `DEFAULT_MAX_REQUEST_IMAGE_BYTES`（16 MB），装得下 10 MB 单图并留足余量，支持 `DSH_MINIMAX_CODE_MAX_IMAGE_BYTES` 覆盖；
    - **横向审计**：对全仓库 7 条线路的请求体和图片预算进行了严格审计，明确各线路均根据对应网关的真实属性独立定义，避免不合理的跨线路继承。
  - **测试**：新增 7 项映射层测试，验证 >2 MB 真实请求体正常通过，失控请求依然被拦截。

- **[Claude / Kimi] 提示缓存时长（TTL）支持自定义配置（5 分钟 / 1 小时）**
  - **Claude 线路**：
    - 官方 Claude Code 订阅用户在额度内支持 **1 小时** 提示缓存 TTL（超出后降为 5 分钟）。此前插件仅发送默认 5 分钟的 `{ type: 'ephemeral' }`，未能享受到官方的 4 倍缓存窗口。
    - 现默认按订阅身份发送 `ttl: '1h'`，并同步附加授权 Beta 头 `extended-cache-ttl-2025-04-11`。设置页支持切换“跟随官方 / 1 小时 / 5 分钟”。
  - **Kimi Code 线路**：
    - 对齐官方文档，OpenAI 兼容协议支持 `prompt_cache_options`，Anthropic 兼容协议支持顶层 `cache_control`；默认未配置时不发送任何缓存字段。
  - **测试**：新增 11 条缓存 TTL 单元测试，覆盖不同协议与档位校验。

- **[Codex] 跟进上游第三方接入规范（Beta 头、统一 Originator、实时目录与多轮续传）**
  - **补齐 Beta 标头**：出站请求统一携带 `openai-beta: responses=experimental`；
  - **统一 Originator**：收敛各端点的 Originator 标识为单一的 `CODEX_ORIGINATOR`（统一为 `opencode`），避免登录与不同端点识别产生割裂；
  - **实时模型目录**：接入 `GET /backend-api/codex/models` 动态加载，支持 15 分钟单飞缓存与本地磁盘快照持久化，新模型发布无需频繁更新插件代码；未知模型保守回落，不臆造虚假能力；
  - **多轮提示续传**：支持发送 `prompt_cache_key` 并回传响应头 `x-codex-turn-state`，提升服务端前缀缓存命中与多轮对话续接效率；本地维护 LRU 缓存避免内存无界增长。
  - **测试**：新增 19 条测试，覆盖 Wire 标头、Originator 一致性、实时目录与状态回传。

- **[号池架构] 修复所有订阅线路共享号池的读-改-写竞态**
  - **根本原因**：此前各线路对号池的读写未实现跨异步操作的严格锁保护，当多并发请求触发 Token 刷新或设置更新时，后提交的事务容易覆盖先提交的新 Token、账号及冷却状态。
  - **重构要点**：
    - **严格原子事务**：账号增删、备注、主账号切换、冷却标记等操作均在统一锁内完成“读最新 -> 改 -> 写”闭环；
    - **非阻塞整池单飞**：令牌刷新采用按账号/凭据代际的独立单飞控制，网络 I/O 在锁外执行，避免死锁；
    - **条件写保护**：凭据写回严格比对发起时的版本代际，过时刷新结果直接丢弃，杜绝复活已删除账号或覆盖新登录凭据；
    - **落盘验证与记账解耦**：关键 Token 落盘后立即读回校验；最近使用时间等非关键记账失败不阻塞正常请求。
  - **测试**：新增并发冲突回归测试（`test/account-pool-concurrency.test.ts`）。

- **[Claude] 线路健壮性审计修复（综合 8 项）**
  - **账号重新登录写错存储**：修复“按账号重新登录”后将新凭据写入旧单账号文件而非号池行、导致死循环提示重新登录的问题；
  - **刷新令牌解析失败重发**：修复 HTTP 200 但响应体解析异常时重复重试消费型 Refresh Token 导致凭据失效的问题；
  - **登录轮询停滞**：修复卡片在轮询到 `exchanging` 瞬态时提前停止轮询的 Bug；
  - **空文本块防御**：对于纯图片的工具调用结果，自动填充 `(see attached image)` 占位文本，避免因空文本块被 API 拒绝；
  - **孤立代理项字符清洗**：工具输出按字节截断时若在 Emoji 中间断开，`JSON.stringify` 会产生未配对的代理项字符（`\uD83D`）；现统一清洗孤立代理项与 NUL 字符；
  - **403 权限错误误判**：上游返回无权限（如模型未包含在订阅中）时归类为 `PROVIDER_ERROR`，不再错误地将正常账号标记为失效踢出号池；
  - **模型目录分页**：请求模型列表时发送 `limit=1000`，避免默认每页 20 条导致可用模型截断；
  - **结束状态规范化**：`refusal` / `sensitive` 明确映射为错误，`model_context_window_exceeded` 映射为截断（`max-tokens`），杜绝误触发工具调用。

- **[Claude] 修复输出速度（TPS）与首字延迟（TTFT）统计虚高的问题**
  - **根本原因**：
    - DSH 统计 TPS 时将全部思考 Token 计入输出，且计算区间为“首个非空 Delta 到结束”。
    - 插件此前将全部 `thinking_delta` 缓冲到思考块结束才一次性发出，导致思考耗时被完全忽略，首字时钟直到回答阶段才开始计时，统计出的 TPS 达到正常值的 10 倍以上（如显示 1100 tok/s，实际仅 85 tok/s），且思考阶段界面无字白屏。
  - **修复方案**：
    - 思考块开始时即发出 `block-start`，每个 `thinking_delta` 到达时立即发出 `reasoning-delta`，实时流式更新；
    - 思考 Token 统计改用服务端下发的真实 `thinking_tokens` 计数，不再依赖“字符数/4”的粗暴估算。
  - **测试**：新增流式事件逐项断言，实测思考期间流式正常输出。

- **[Claude] 修复新账号使用 Claude Opus 5.5 提示词前缀变化后持续 400 报错**
  - **根本原因**：官方自 2026-08-31 起对 Opus 5.5 等模型强制执行思考前缀校验；一旦系统提示词、工具列表发生变动，必须在请求中显式携带 `block_binding: { prefix_mismatch_behavior: 'drop_block' }`，否则直接报 400。
  - **修复方案**：能力表中标记 `bindsThinkingToPrefix`，在 Adaptive 分支中为该类模型自动携带 `block_binding` 并附带 `anthropic-beta: thinking-binding-controls-2026-08-01` 授权标头。

- **[Claude] 支持 Claude Sonnet 5.5（`claude-sonnet-5-5`）**
  - **修复要点**：
    - 补齐本地能力表策展条目（1M 上下文、128K 输出上限、支持图片、不可关闭思考）；
    - 自动根据模型特征附加 `block_binding` 及相关 Beta 鉴权标头；
    - 申报默认 CLI 版本提升至 `2.1.285`（满足官方 >= 2.1.284 门槛）。

- **[Codex] 新增模型 GPT-6.1 Sol（`gpt-6.1-sol`）**
  - **模型规格**：1,050,000 上下文窗口、128,000 输出上限、支持图文输入；
  - **配置对齐**：归入 `gpt-6` 族 profile，默认思考档位 `medium`，支持 `low` 至 `max`（不支持 `none` / `minimal`）；默认加入可见模型列表。

- **[模型目录] 修复清空缓存后在途请求回写旧数据的竞态**
  - **修复方案**：为 `kimi-code` / `command-code` / `workbuddy` 模型目录缓存引入 `catalogCacheEpoch` 递增机制。清空缓存时递增 Epoch，在途的异步拉取请求若 Epoch 失配则放弃写入快照与恢复缓存，杜绝旧数据覆盖新状态。

- **[DSH 兼容] 跟进 DeepSeek Harness 0.2.0-rc.2**
  - 更新全部 `@deepseek-ai/dsh-*` 依赖的 peerDependencies 范围（追加 `|| ^0.2.0-rc.2`），更新基线并重新生成 package-lock.json；通过新旧基线多环境回归测试，无破坏性行为改动。

- **[MiniMax] 修复并发刷新导致的令牌失效与每小时频繁掉线**
  - **根本原因**：
    - Access Token 有效期仅 1 小时，续期窗口定在到期前 60 秒内。号池内部缺少并发单飞控制，用量轮询与模型请求容易在同一秒内同时触发刷新。
    - 输掉竞态的调用者收到 `invalid_grant`，导致错误地将正常账号标记为 `authStatus: expired` 永久失效，并在卡片上报“需要重新登录”。
  - **修复方案**：
    - **提前 5 分钟续期**：将刷新前置至到期前 5 分钟（`PRE_EXPIRY_REFRESH_MS`），避开临界失效窗口；
    - **全进程单飞锁**：引入以账号身份为键的单飞刷新注册表，所有并发调用共享同一次刷新事务；
    - **磁盘状态优先**：收到刷新失败时先重新读取磁盘凭据，若已由其他进程或单飞成功刷新，直接采纳新状态，不写入墓碑；
    - **账号行自我修复**：`healStaleAuthFailures` 在读取号池时自动比对并清除历史残留的错误失效标记；
    - **补齐重新登录按钮**：修复设置卡片上重新登录按钮在满足条件时未正确渲染的问题。
  - **测试**：新增 13 条抗并发争用测试（`test/minimax-code-token-contention.test.ts`）。

- **[思维保护] 新增推理坍缩守卫（Reasoning Collapse Guard）：死循环自动熔断与恢复**
  - **背景与现象**：长推理流可能退化为死循环重复短语（如 `Let me call. Go. Calling. Go.`），既不调用工具也不产出结论，一路消耗完上限（实测单会话烧掉 128,000 output tokens）。
  - **工作机制**：
    - **滑动窗口打分**：基于尾部字符的 n-gram 唯一率打分，坍缩流（重复度极高）得分高达 0.98，正常深思通常 <= 0.28，阈值设为 0.85，可在 1.5 KB 处迅速灵敏检测并中断；
    - **多级自愈恢复**：中断后在原会话中创建一条携带系统 Notice 形式的恢复消息，分三级恢复（首次静默续跑 -> 二次提示不要重蹈覆辙 -> 三次终止本轮退出）；
    - **安全无侵入**：接入 Harness 的 `llm/stream` waterfall 接缝（兼容 0.1.2-alpha.5 至最新版本），不改动请求上下文，不修改最大 Token 预算，默认开启且支持配置关闭。
  - **测试**：新增 29 条专项回归测试，通过真实归档坍缩样本与健康思考样本验证。

- **[MiniMax] 新增每日自动签到功能**
  - **功能简介**：自动领取官方桌面端“每日签到”积分（七日循环递增 400~2000 分）。
  - **技术实现**：
    - 完全复用本线路现有的 OAuth 凭据，对齐官方开源 CLI（`MiniMax-AI/minimax-code`）的签到网关与加密签名逻辑；
    - 国内区（`agent.minimaxi.com`）与国际区（`agent.minimax.io`）双区均支持；
    - 设置页增加“每日签到”卡片（支持开关、今日状态展示、连签天数统计与“立即签到”手动补签）；
    - 进程内定时调度，启动即签，每 10 分钟补检，幂等防重；状态落盘于 `minimax-code-checkin.json`。
  - **测试**：新增 22 项测试，覆盖双区端点、签名头算法比对、401 自动续签及跨天重置。

- **[DSH 兼容] 跟进 DeepSeek Harness 0.2.0-rc.1**
  - 更新 peerDependencies 基线，验证全量核心包源码与插槽契约兼容性；重新生成锁文件。

- **[MiniMax] 接入官方客户端用量与配额查询端点**
  - **端点对齐**：对齐官方 CLI 源码，接入 `/v1/api/openplatform/coding_plan/remains` 端点，自动探测并记忆国内/国际区网关；
  - **配额双窗口展示**：解析并独立展示 5 小时滚动窗口与每周窗口的剩余百分比、重置倒计时与使用量；
  - **诚实诊断与状态反馈**：若当前登录凭据受限于平台鉴权策略无法拉取用量，卡片如实提示“请在控制台或官方应用中查看”，杜绝模糊的“暂无数据”或错误归因。
  - **性能与防护**：状态接口轮询仅读取内存缓存，绝不在轮询时阻塞发网，避免卡顿；失败状态记忆 10~30 分钟。
  - **测试**：新增 17 条配额映射与缓存策略测试。

- **[MiniMax] 补齐与兄弟线路对等的号池与模型管理功能**
  - **供应商全局总开关**：关闭时立刻清空对外暴露的模型，彻底停用流量；
  - **模型自主勾选**：支持在设置网格中勾选/全选/取消特定模型，决定对话页可见列表；
  - **上下文窗口自定义覆盖**：每个已启用模型均可自定义容量（如 1M / 512K），支持一键恢复默认；
  - **默认思考深度配置**：支持设置全局默认思考等级，自动兼容模型固有支持范围；
  - **多账号池与桌面态导入**：支持多账号轮询/顺序耗尽调度；支持一键从本地 MiniMax Code 客户端只读导入凭据（桌面账号标记不可删除，续期自动原子回写）。

- **[MiniMax] 新增 MiniMax Code 编程订阅线路（PR #23 审计修复）**
  - **核心特性**：注册 `minimax-code` Provider，支持只读复用 MiniMax Code 桌面端凭据或通过 RFC 8628 设备码登录，请求走 Anthropic Messages 协议与 Bearer 鉴权。
  - **合并审计修复（10 项重要缺陷）**：
    - **① 消除 UI 文案串味**：解除错误的 `t` 函数全局注入，恢复独立的 i18n 字典，杜绝显示为字面键名或出现“使用 ChatGPT 登录”的错误文案；
    - **② 保护官方客户端登录态**：登出操作仅清除插件自有凭据，桌面端凭据标记为 `native: true` 禁止从插件侧撤销注销，防止误踢用户官方客户端；
    - **③ 规范路由挂载前缀**：纠正路由前缀为 `/minimax-code/api`，消除与其他线路的冲突；
    - **④ 修复 401 无法自愈**：遇到 401 时主动触发一次强制令牌续期并重试，自愈后恢复通信；
    - **⑤ 国际区凭据完整支持**：探测全部区域目录，并严格按凭据真实记录的区域决定 Host 端点；
    - **⑥ 消除明文备份凭据泄露隐患**：移除写回时复制出的 `.dsh-bak` 明文文件，改用纯原子重命名；
    - **⑦ 诊断信息安全脱敏**：将此前泄露真实 Token 前缀的报错改为输出 SHA-256 指纹截断；
    - **⑧ 修正虚假的多模态声明**：移除尚未具备解析器的 `video` 输入声明，仅声明实际支持的 `text` / `image`；
    - **⑨ 修复输出上限收敛空跑**：修复上下文夹取时未正确估算输入 Token 导致跳过收敛的缺陷；
    - **⑩ 优化性能**：移除无配额线路空转的 60 秒定时轮询，凭据读取操作合并为单次完成。
  - **测试**：新增 15 项审计回归测试，全量验证通过。

- **[团队协作] 适配 DSH Agent Teams：自适应协作与权限继承**
  - **根本原因**：Agent Teams bundle 在会话作用域内重载了同名的协调工具，顶替了内置的 `tool-subagent-control`，导致子代理回访异常；且 `spawn_teammate` 创建时不携带路由参数。
  - **修复方案**：
    - 将 `spawn_teammate` 纳入 `DEFAULT_SUBAGENT_INHERIT_TOOLS` 继承模式，继承 Lead 路由，防止被授权守卫硬性拒绝；
    - 优化 Preset 提示词，新增 R0.5 协作模式侦测及 R-T Teammate 协作规范，使模型能自适应普通子代理模式与 Agent Teams 协作模式。
  - **测试**：测试断言两种预设形态完全一致，继承权限判定准确。

- **[设置 / UI] 修复客户端样式表在 Fiber 热重载时偶发丢失**
  - **根本原因**：ChatGPT 样式表在卸载时执行 `element.remove()`，而在 Cordis Fiber 重启（如修改配置、HMR）时，新 Fiber 先运行看到旧标签返回空 Disposer，旧 Fiber 随后异步将标签从 DOM 彻底移除，导致样式表永久丢失。
  - **修复方案**：改为主样式表托管模式：标签归全局文档所有，存在则就地更新 `textContent`，Disposer 置为空操作，并在热更新时即时刷新 CSS 规则。

- **[Claude] 修复回复包含内容时 100% 失败报错（`must be losslessly JSON-serializable`）**
  - **问题现象**：每当模型输出文字、思考或工具调用时，整轮对话必定崩溃报错，提示 `Assistant stream chunk must be losslessly JSON-serializable`。
  - **根本原因**：
    - DSH 在会话日志落盘前会对流式 Chunk 进行严格无损 JSON 校验，遇到 `undefined`、非法数字、数组空洞等直接拒收整块消息。
    - 插件在 `mapper.ts` 中将文本块和工具调用的占位显式写为了 `state.replayBlocks[index] = undefined`，或解析参数失败时带入 `undefined`。
  - **修复方案**：
    - 将占位值从 `undefined` 修正为标准 JSON 合法值 `null`；
    - 新增 `jsonSafeValue()` 过滤管道，递归清洗非有限数字、-0、未定义字段及循环引用；
    - 类型系统收紧，将 `replayBlocks` 类型改为 `(Record<string, unknown> | null)[]`，在编译期杜绝 `undefined` 赋值。
  - **验证**：通过真实失败日志回放验证，7 种曾被拦截的流式形态全量测试通过。

- **[调度预设] 修复调度模式 R8 兜底状态卡死、不派发子代理的问题**
  - **根本原因**：
    - 调度模式在触发 R8 兜底（由主模型亲自执行）后，模型容易在对话历史中自我强化这一结论，导致即使当前任务已顺利结束，下一个新任务依然拒绝派发子代理。
  - **修复方案**：
    - **作用域限定**：明确 R8 兜底仅为**单任务级别**，绝非会话级状态；
    - **明确解除与恢复条件**：新任务开始时强制回到 R0 重新分诊，不得沿用兜底假定；触发条件收紧为“同一任务重派两次依然失败”；
    - **针对性解法**：对子代理上限超限（等待结算）和模型白名单拦截（显式指定模型）提供明确的修条件路径。
  - **验证**：Preset 与代码声明通过逐字节一致性校验及反模式拦截断言。

- **[Claude] 修复提示缓存命中率为 0（每次请求均全额计费）**
  - **根本原因**：Anthropic 提示缓存需要请求中携带 `cache_control` 断点，此前适配器虽然实现了标记能力但默认置为 `false`，导致从不发出断点，服务端无法命中缓存。
  - **修复方案**：
    - **默认开启缓存**：改为 Opt-out 机制，默认开启缓存；
    - **精准标记核心断点**：在符合 4 个断点上限的前提下，固定标记三处最关键的位置：System 块末尾、**最后一条 User 消息的最后一个块**（多轮历史复用核心）、最后一个工具定义；
    - **规范标记时机**：在合并连续消息之后进行最终标记，保证断点位置稳定，前缀无动态漂移。
  - **验证**：独立断言请求体断点分布，验证多轮历史复用断点正确生成。

- **[Claude] 修复 Claude Opus 5.5 因上报版本过旧被拒（`claude_code_version_too_old`）**
  - **报错信息**：`Claude Code 2.1.251 does not support this model; version 2.1.280 or newer is required.`
  - **根本原因**：插件向服务端硬编码申报的版本号为 `2.1.251`，而 Opus 5.5 要求客户端版本 >= `2.1.280`。
  - **修复方案**：
    - 申报版本更新为真实已发布的 `2.1.283`（后续推进至 2.1.285）；
    - 能力表引入 `minCliVersion` 门槛字段，发请求前在本地进行预检拦截，版本不满足时给出清晰的可操作提示，不再盲目向服务端发包；
    - 新增自动化测试守卫，确保全表所有模型的版本门槛均严格 <= 当前默认申报版本。

- **[Kimi] 修复设置卡片定期误报 `rejected the stored credential (401)`**
  - **根本原因**：
    - Access Token 有效期仅 900 秒（15 分钟），而前端卡片查询用量时直接携带了号池中已过期的 Access Token，导致上游返回 401 并被误判为“凭据被拒绝”；
    - 单账号镜像文件与号池同时刷新同一枚单次有效的 Refresh Token，引发跨路径轮换冲突，造成账号被误标为失效。
  - **修复方案**：
    - **号池接入实时凭据获取**：卡片用量查询改走号池的 `getFreshCredential()`，在临期前自动续期；
    - **401 强制刷新自愈**：收到 401 时主动发起一次强制续期并重试，只有二次 401 才判定为失效；
    - **解除镜像刷新耦合**：模型目录加载改用号池的活跃凭据，不再触碰单凭据镜像文件，消除竞态。
  - **测试**：新增 9 项凭据自愈与目录加载解耦测试。

- **[Claude] 移除「合规告知 + 确认门禁」限制**
  - **背景与改动**：
    - 彻底移除设置卡片顶部的显式确认告知框、`/claude/api/consent` 路由及主机侧 403 门禁，路由改为无条件自动注册；
    - 兼容用户磁盘已有的 `consent` 历史配置字段，不影响旧配置正常读取；
    - 保持条款风险的客观陈述，使用户开箱即用体验更加顺畅。

- **[Claude] 新增模型 Claude Opus 5.5（`claude-opus-5-5`）**
  - **规格说明**：1M 上下文、128K 输出上限、支持图片输入、思考档位支持 `low` 至 `max`；
  - **特性适配**：
    - 官方不支持关闭思考（显式关闭或设置 budget 均报 400），能力表标记为不可关闭思考；
    - 默认思考档位为 `medium`（避免被静默提升为 `high` 造成额外额度开销）。

- **[架构演进] Claude (订阅) 线路正式上线，替代原 GLM 线路**
  - **变更概述**：移除 `zhipu-coding-plan` Provider，新增 `claude-subscription` Provider，支持以 Claude Pro / Max 订阅的 OAuth 登录态直连 Anthropic Messages 接口（无需 API Key、不按量计费）；设置页相应标签替换为 Claude。
  - **核心架构实现**：
    - **OAuth 认证与安全**：对齐 Claude Code 官方身份块，采用独立随机生成的 PKCE Verifier 与 State，规避敏感参数泄露风险；
    - **思考模式分级处理**：严格支持 `mid-convo`（携带前缀绑定）、`adaptive`、`budget` 及 `none` 四类思考形态；
    - **多轮会话回放**：保留带签名的思考块（Thinking Signature）原样回放，剔除无签名残缺块，保障多轮工具调用稳定；
    - **账号管理与号池**：以稳定的内部 ID 作为路由键，支持多账号轮询与自动重试；支持只读收编本机 Claude Code 的已有登录凭据（快照模式，永不跨进程抢刷）；
    - **额度与用量监控**：双轨兼容已用百分比与统一限流响应头换算，卡片清晰展示用量进度与重置倒计时。

- **[DSH 兼容] 修复启动时报 `fiber state 5` 导致 web 模块未激活警告（[#18](https://github.com/Aa728848/dsh-chatgpt-subscription/issues/18)）**
  - **根本原因**：在具备透明代理/系统代理的环境下，插件在注册 Provider 后立即同步修改了 `web` 配置，导致 `web` 模块触发热重载（卸载中状态，即 Fiber State 5），与宿主 profile 合成审计产生启动时序竞态。
  - **修复方案**：将首次 Provider 状态同步推迟一个宏任务（`setTimeout(applyWebProviders, 0)`），确保其落在宿主审计之后，消除误报警告。

- **[DSH 兼容] 支持 DeepSeek Harness 0.2.0-rc.2 / 0.1.7-rc.2**
  - 对齐多项 Harness 核心组件更新，平滑兼容会话中途变更工具声明、模型选择器硬门槛校验及依赖生态演进。

- **[发布规范] 修复 npm `latest` 发布标签锁定问题**
  - 修正 `package.json` 中固定的 `publishConfig.tag`，确保稳定版本发布时默认进入 `latest` 分发通道，预发布版本显式通过 `--tag alpha` 发布。

- **[测试套件] 修复 Windows 环境下 DPAPI 超时与测试假失败**
  - 将 `vitest.config.ts` 的单测超时时间从 15s 放宽至 60s，并将最大并行 Worker 数限制为 4，彻底解决因子进程高并发争用导致的超时及跨用例 Mock 污染问题，实现全量测试稳定通过。

- **[WorkBuddy] 每日自动签到功能与健壮性提升**
  - **核心功能**：国区账号在宿主启动时自动签到，运行期每 10 分钟幂等补检；状态持久化于 `storages/workbuddy-checkin.json`，设置页支持开关与手动补签；
  - **评审优化**：
    - 修复偏好 Store 异步加载导致已关闭签到的账号在重启时被误签的问题；
    - 修复活动未开放账号被当天永久跳过的问题，增加每小时重试节流；
    - 细化签到状态，区分“无活动”与“已签到”；手动补签请求改为串行队列，保证执行语义；
    - 增强上游字段兼容性（蛇形/驼峰容错、软失败重试豁免、401 强制续期）。

- **[模型配置] 模型上下文窗口跟随启用开关，并支持单行/批量恢复默认**
  - **按需展示**：上下文窗口配置仅展示当前已勾选启用的模型，未勾选时不产生冗余输入框；
  - **覆盖全量模型**：ChatGPT 标签页放开全部目录模型的上下文覆盖能力；
  - **恢复默认支持**：支持传入 `null` 删除特定模型的覆盖配置以恢复目录默认值；设置页提供单行“恢复默认”及全页“全部恢复默认”便捷操作。

## 0.8.0-alpha.0 - 2026-09-23

- **[发布说明] 0.8.0-alpha.0 预发布**：0.8.0 正式版定稿前作为预发布分发，仅发布至 npm `alpha` 标签，不影响 `latest` 默认安装。

- **[Codex] 新增模型 GPT-6 Sol 与 GPT-6 Luna（`gpt-6-sol`、`gpt-6-luna`）**
  - **规格支持**：支持文本 + 图片输入，默认思考档位 `medium`，订阅侧上下文上限 872K；
  - **族群 Profile 重构**：将 Astra 专属配置泛化为 `gpt-6` 族群共享 Profile，统一处理思考档位（收敛 `none` / `minimal` 至 `low`）；
  - **配置与输出上限**：默认有效上下文提至 384K，输出上限按模型区分（GPT-6 系列提至 128,000，老模型维持 32,768）。

- **[DSH 兼容] 深度适配 DeepSeek Harness 0.1.7-alpha.1（三处破坏性重写）**
  - **会话消息模型适配**：0.1.7 将工具结果改为一等的 `role: "tool"` 消息。新增 `llm-compat.ts` 作为双向兼容垫片，出站前自动归一化，既有 5 条线路的 Mapper 逻辑无缝保持兼容；
  - **设置 API 重构**：0.1.7 废弃 `settings.register`，改为从插件配置动态生成表单。新增 `file-preferences.ts` 支持将设置落盘至独立文件，并无缝自动迁移老用户的 `settings.yaml` 配置；
  - **Agent Preset 运行时注册**：适配 0.1.7 改用包声明行的机制，动态注册 `dispatch` 编排预设，避免老版本加载崩溃。

- **[社区 PR 合并与优化] 合并 PR #12、#14、#15 并修补潜在缺陷**
  - **#12**：macOS 钥匙串在载荷包含本地化字符时安全解码十六进制字节；
  - **#14**：偏好设置 Store 在无 `register` 环境下优雅回退至文件持久化并从文件水合，解决重启后模型开关重置的问题；
  - **#15**：合并多项通用功能优化与稳定性增强。

- **[WorkBuddy] 修复多账号去重缺陷与昵称冒充身份问题**
  - **根本原因**：OAuth 授权响应缺少明确账号身份时退化使用昵称作为 ID，导致桌面端扫盘获取的 UUID 账号与网页登录账号产生重复。
  - **修复方案**：统一采用 `intl:<用户全局ID>` 规范账号身份，建立身份别名映射，消除重复账号现象。

- **[Kimi Code] 优化模型选择器打开卡顿问题（从 800+ ms 降至 0 ms）**
  - **根本原因**：`loadProviderModels()` 在读取 30 分钟目录缓存之前调用了 `ensureAccessToken()`，而在 Windows 下读取 DPAPI 需要频繁 `spawn("powershell.exe")`。选择器构建时遍历每个模型调用，导致重复启动子进程阻塞主线程。
  - **修复方案**：将 Token 获取逻辑后置至缓存未命中的真实请求分支，命中内存缓存时直接零延迟返回。

- **[调度预设] 修复 0.1.6 环境下 Dispatch 预设挂载失败**
  - 兼容 Harness 0.1.6 对 Workflow 引擎的包名变更（`@deepseek-ai/dsh-workflow-ptc`），补齐多级 Node 依赖寻址。

- **[ChatGPT] 修复对话中执行网页搜索报凭据缺失的问题**
  - 拆分“号池取号”与“服务取凭据”逻辑，确保未被选入模型对话轮换的活跃账号依然能为 `codex-search` 提供合法的只读凭据。

- **[WorkBuddy] 正式上线腾讯 WorkBuddy / CodeBuddy 订阅线路**
  - 注册 `workbuddy-subscription` 独立 Provider；
  - 支持直接扫描复用 CodeBuddy 桌面端登录态，或通过官方浏览器授权绑定多账号；
  - 桌面账号支持隐藏/恢复保护，支持多账号安全隔离存储与调度。

## 0.5.0 - 2026-09-20

- **[号池架构] 全面支持多账号管理与轮换调度（覆盖全部四条线路）**
  - **共享号池内核（`account-pool.ts`）**：引入系统安全存储（DPAPI / Keychain / Secret Service），支持顺序耗尽（Sequential Drain）、轮询调度（Round-Robin）与粘性会话（Sticky Session）三种策略，提供 429 智能冷却与自动接力；
  - **多供应商覆盖**：将 Antigravity 的号池能力推广至 ChatGPT、Command Code 与 Kimi Code；
  - **容错增强**：最后使用时间记账等非关键写失败改为 Best-effort，杜绝因本地记账异常阻断正常取号。

## 0.3.9 - 2026-09-19

- **[多模态] 修复工具结果内嵌图像无法传递给模型的问题（PR #7）**
  - **根本原因**：三条线路此前仅检查消息顶层 Content，导致截图类工具结果内部嵌套的图像块在模型侧全部丢失，模型无法感知图片并容易产生幻觉。
  - **修复方案**：
    - 递归遍历 `tool-result` 中的图像附件；
    - Anthropic 协议支持块数组回传原生图片；OpenAI 协议在连续 Tool 消息段末追加包含 `image_url` 的 User 消息；Gemini 协议通过 `inlineData` 混合并入；
    - 读取失败时优雅降级为明确的 `[image unavailable: ...]` 占位文本。
- **[Antigravity / Kimi] 提示词优化与工具 Schema $ref 展开**：在系统提示词后置注入进度规则；递归内联工具参数的本地 `$ref` 引用。
- **[供应商管理] 支持自由停用供应商与清空模型列表（Issue #8）**：增加“启用此供应商”总开关，支持彻底清空模型以隐藏 Provider，不再挤占界面空间。
- **[Antigravity] 多账号池与双重调度策略上线**：支持管理多个 Google 账号，支持顺序耗尽与基于 LRU 的轮询调度，支持 429 自动冷却换号。

## 0.3.6 - 2026-09-17

- **[调度预设] 随包分发 Dispatch Agent Preset**：内置基于 PTC 模式的复杂任务编排预设（复杂度分诊、任务拆解与子代理指派）；子代理委派强制显式指定 Provider + Model。
- **[网络与代理] 修复透明代理（Fake-IP）环境下 `web_fetch` 失败问题**：
  - 自动识别并接管 Fake-IP（`198.18.0.0/15`）解析，由插件抓取 Provider 自行经由代理发送请求，避免被内置地址过滤硬性拦截；
  - 引入地址安全策略（`fetch-address-policy.ts`），防范私网穿透风险。
- **[多模态] Kimi Code 打通端到端视频输入**：支持视频媒体附件识别与解析，并在超限时采用最旧优先降级策略。
- **[Antigravity] 修复用户上传图片静默丢弃问题（Issue #5）**：正确将图片附件接入 Gemini `inlineData` 报文，杜绝模型回答“未收到图片”；引入 12 MiB 单次请求图片体积上限保护。
- **[Harness 兼容] 开发与测试基线升级至 DSH 0.1.5-rc.2**，重排模型能力展示表格。

## 0.2.15 - 2026-09-11

- 移除对 `@deepseek-ai/dsh-llm` 的冲突模块类型增强；
- 移除 Mapper 中不可达的 `file` 块处理；
- 移除未启用的智能体团队混合模型规则；
- 修复 Antigravity 新账号开通在候选端点全部失败时静默返回成功的缺陷；
- 修复登出时在途配额请求可能回写旧缓存的竞态问题。

## 0.2.14 - 2026-09-10

- 优化 Antigravity 配额自动刷新机制，对齐官方 2.8.0 规范；
- 完善代理探测逻辑，支持 `.env` 兜底识别。

## 0.2.13 - 2026-09-10

- 优化 Antigravity 开通与配额接口，增强网络容错与多平台适配。

## 0.2.12 - 2026-09-10

- Antigravity 登录对齐官方 2.8.0 User-Agent 格式，新增免费层资格校验与开通 LRO 轮询；
- 状态接口按 2 分钟 TTL 自动拉取配额，支持并发去重；
- 依赖版本区间扩展支持 DSH `^0.1.3` 至 `^0.1.5`。

## 0.2.10 - 2026-09-06

- 修复 Antigravity 模型元数据校验失败导致 Provider 整体消失的问题（安全兜底 `defaultEffort`，解决 `gemini-3.1-pro` 触发异常导致选择器丢失的问题，Issue #4）。

## 0.2.9 - 2026-09-06

- 修复在官方 DSH 0.1.2-rc.1 上启动因缺少 `CallId` 导出抛出语法错误的问题（采用 `toToolCallId` 动态兼容垫片，Issue #4）；
- 修复搜索与抓取来源切换在重载时未能正确生效的问题；
- Codex 订阅新增 `gpt-6-astra` 模型，支持 `low` 至 `max` 思考档位；提供独立上下文容量设置。

## 0.1.28 - 2026-08-28

- 新增支持 1.5x 倍速快速模式（Fast Mode / Priority Service Tier），请求注入 `service_tier: 'priority'`；
- 修复偏好设置更新白名单校验，持久化保存快速模式开关。

## 0.1.21 - 2026-08-22

- 适配 DSH `0.1.1-rc.2` 的新循环机制，适配器显式实现 `prepareCall`；
- 全量提升依赖版本至 `^0.1.1-rc.2`，增强无 BOM 的 UTF-8 编码与完整性检查。

## 0.1.20 - 2026-08-22

- 新增独立的子代理全局设置页，支持配置模型、思考深度与上下文预算；
- 支持限制子代理最大嵌套深度（0–3）与并发活动数量；
- 新增 GPT-5.6 系列有效上下文窗口配置（默认 272K，最高 1M）。

## 0.1.12 - 2026-08-20

- 适配 DSH `0.1.0-rc.8`，升级依赖生态与客户端插槽声明。
