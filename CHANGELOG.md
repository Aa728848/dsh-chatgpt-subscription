# Changelog

## Unreleased

- **GLM 线路支持浏览器登录（ZCode 的「编程套餐」授权），不再只能手填 API Key**。此前这条线路只有「粘贴 Key」一条添加路径，而 Kimi Code 有设备码登录；原因是智谱 / Z.ai 官方只对第三方开放 API Key。现在按社区已落地的做法复刻 ZCode 自己的第一方授权：在 `chat.z.ai` 完成授权 → 用 code 换短期 OAuth token → 业务接口在该账号上**创建或复用一把 Coding Plan Key** → 用订阅侧模型目录验证后入库。
  - **落盘形态不变**：铸造出来的就是普通 `id.secret` Coding Plan Key，因此验证（先读一次订阅侧模型目录，不通过不落盘）、多账号号池、额度卡片、适配器全部沿用既有路径——本线路没有第二种凭据形态，也没有第二套刷新逻辑（该 Key 不过期）。这正是这条路径能在本插件里成立的原因，也是它与 Kimi 设备码登录的结构差异：Kimi 拿到的是需要刷新的 access/refresh token，这里拿到的是一把长期 Key。
  - **新增 `src/host/zhipu/oauth.ts`**：回环回调（`127.0.0.1:54548/callback`）、authorization code 交换、按平台 `code`/`success` 信封解包（token 端点 `code 0`、业务端点 `code 200` 两种约定都接受，因为只看 HTTP 200 会把拒绝读成成功）、默认组织/项目解析、同名 Key find-or-create、以及始终经 `/copy` 读取 secret（列表会把 secret 打码，创建响应里的内联 secret 在不同账号状态下不可靠）。
  - **端口回退不是可有可无**：控制台的 redirect URI 来自授权请求本身而非预先注册，所以首选端口不可用只是重试。实测本机 `54548` 位于 Windows 保留端口段、绑定报 **`EACCES`**（不是常见的 `EADDRINUSE`）——只处理后者会让登录在这类机器上直接失败，两者都回退到临时端口。
  - **浏览器连不上本机也能登录**：卡片在 `pending` 期间始终展示授权地址，并提供输入框接受**完整回调地址或裸 code**（`extractAuthorizationCode` 按 URL 解析判定，避免把整条 URL 当成 code 提交后拿到一个无从解释的 400）。这与 Kimi 的设备码在无浏览器环境下的可恢复性对齐。
  - **不碰别人的 Key**：铸造的 Key 名为 `dsh-chatgpt-subscription`（非 ZCode 自己的 `zcode-api-key`），同名则复用，**从不删除账号上的任何 Key**，重复登录是幂等的。
  - **只支持国际区**：国区控制台没有对应的公开授权，`POST /zhipu/api/login` 对 `region: cn` 明确拒绝并提示改用手填 Key——而不是让卡片停在一个永远不会完成的流程上。
  - **第一方私有契约按可回滚处理**：端点与 client id 收在 `src/host/zhipu/types.ts` 的 `ZAI_OAUTH` 里集中评审，且逐个可用 `DSH_ZAI_OAUTH_*` 环境变量覆盖。
  - 路由新增 `POST /login`、`GET /login/status`、`POST /login/code`、`POST /login/cancel`（均同源校验；`login` 可用 `oauthEnabled` 部署级关闭）。卡片上「添加账号」改为触发浏览器登录，手填 Key 保留为回退路径与国区唯一路径；中英文案同步。
  - **验证**：`npm run typecheck` 与 `npm run build` 均 0 错误；`npx vitest run` **97 个文件通过 / 1 跳过，1280 条通过 / 7 跳过、0 失败**（较本次改动前的 1256 条 +24：`test/zhipu-oauth.test.ts` 新增 22 条、`test/zhipu-ui.test.tsx` 新增 2 条）。`zhipu-oauth` 覆盖：授权 URL 构造（含「不发 PKCE」这一与官方请求一致的必要条件）、code 提取的两种形态、完整铸造序列与顺序、同名 Key 复用不产生第二个 Key、信封拒绝文案透出、无组织/项目与读不到 secret 的具名失败、粘贴 code 完成登录并落盘为国际区凭据、失败时**不落任何凭据**、首选端口不可用时改用临时端口、**真实回环回调**（含伪造 state 被拒且不终止尝试）、以及四条路由的同源/国区/无进行中流程等分支；`zhipu-ui` 覆盖待授权态下授权地址与粘贴框的渲染。测试用可注入的 `endpoints` + `port: 0` 全程离线，不依赖真实 Z.ai 账号或 54548 端口。

- **支持 DSH 0.1.7-rc.1**（本机 harness 仓库与 `dsh --version` 都已是它，npm 上 `next` 也是它）。这一版**不需要任何行为改动**——alpha.1 桥接过的会话消息模型与设置 API 在 rc.1 一字未改，`dsh-llm`、`dsh-settings`、`dsh-web`、`dsh-attachment`、`dsh-timeout`、`dsh-host-webserver` 与四个 client 包在该窗口内**只有版本号变化**（窗口本身 318 个提交 / 911 个文件，绝大多数与本插件无关）。动作落在基线、一处契约漂移和依赖清单上。
  - **dev 基线升到 `0.1.7-rc.1`，peer 范围加入 `^0.1.7-rc.1`**。需要说清的是：这个 peer 子句是**为可读性**，不是解封——`^0.1.7-alpha.1` 本来就覆盖 `0.1.7-rc.1`（同一个 `0.1.7` 元组，预发布比较器在元组内匹配），已用 `semver.satisfies` 对全部 dsh peer 逐条验证。rc.1 新增的**启动期 peer 兼容性预检**（`packages/boot/app-boot/src/plugin-compatibility.ts`：不满足即把该行 `disabled` 并写 stderr，读不到 peer 元数据也一律拒绝）对本插件因此是**空集**。
  - **`tool.call.toolview` 的入参从单一 `block` 变成三态联合**（`packages/client/ui-tool/.../contract/slots.ts` 的 `ToolCallPhaseProps`：`preparing` / `start` / `result`），`RunningToolCall` 相应拆成 `PreparingToolCall`（**根本没有 `argsRaw`**）与 `StartedToolCall`。`ToolCallTree` 对**每个阶段**都调用已注册的 keyed 视图，所以图片卡确实会拿到 `preparing` 的 block；`CodexImageToolView` 原先直接读 `block.argsRaw`，在 `preparing` 上读的是不存在的属性。**这不是用户可见的故障**（读到 `undefined` 后照常渲染「正在生成图片」，只是少了提示词摘要），属接缝处的契约漂移；现改为只在声明了该字段的分支读取（`dispatchedArgsRaw`，用 `'argsRaw' in block` 判定），旧代走的正是原来那条分支，**由构造保证而非版本判断**。
  - **顺带记录一个类型盲点**：`slots.d.ts` 从 `@deepseek-ai/dsh-client-ui-chat/client` 引入这些块类型，而该包**既没有安装、也不是 `dsh-client-ui-tool` 声明的依赖**（那个包连 `dependencies` 字段都没有）；两个 tsconfig 都开着 `skipLibCheck`，于是这些类型退化成 `any`，`tsc` 对 `block` 的形状既查不出错、也证明不了对。上面关于 `tool.call.toolview` 的结论**全部来自读 harness 源码，不是来自类型**。把 `dsh-client-ui-chat` 加成 devDependency 能让这一面真正被检查，但那是一个需要随世代维护的新依赖，留作维护者决定。
  - **vendor 只涨版本、不动源码**：cordis 4.0.3 → 4.0.4、schemastery 3.18.3 → 3.18.4，`vendor/cordis/src` 与 `vendor/schemastery/src` 在该窗口的 diff 为**空**，清单里只是把内部范围从 `workspace:^` 收紧成 `workspace:~`。alpha.1 记录过的 `Fiber.update()` 陷阱（4.0.2→4.0.3）没有新变化，`search-provider-switcher.ts` 里 `entry.fiber?.await()` 的等待依然正确。`dsh-tools` 新增可选的 `projectContent` 钩子，纯加法，未采用。`package-lock.json` 里跟着动的 cordis 4.0.4 / loader 1.0.5 / group 1.0.4 / include 1.0.9 / cosmokit 1.8.5 / schemastery 3.18.4 是 rc.1 各包收紧 peer 后的必然结果，源码行为不受影响。
  - **pnpm 清单同步**：`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 由 `0.1.7-alpha.1` 换成 `0.1.7-rc.1`（vendor 行把旧版本作为备选保留），并补上 rc.1 所需的 cordis 4.0.4 / loader 1.0.5 / cosmokit 1.8.5 / schemastery 3.18.4 / group 1.0.4 / include 1.0.9；`pnpm-lock.yaml` 用 pnpm 11.24.0 重新生成，`lockfileVersion` 仍是 `'9.0'`，供应链策略校验通过、`--frozen-lockfile` 退出码 0。CI 走的是 `npm ci`，这两个文件只影响用 pnpm 安装的人。
  - **验证**：`npm run typecheck`（先删掉两个 `.tsbuildinfo` 并以 `tsc -b --force` 强制全量，避免增量空跑被误判为通过）与 `npm run build` 均 **0 错误**；`npx vitest run` **96 个文件通过 / 1 跳过（97），1256 条通过 / 7 跳过、0 失败**。对照 alpha.1 基线（1250 条通过、95 个文件通过 / 1 跳过）**除新增用例外逐项一致**，确认 rc.1 未引入回归。`npm ci --dry-run` 同步，`npm pack --dry-run` 完好（282 个文件）。旧代回测在独立干净目录按 `^0.1.5-rc.1` 装出完整闭包（实得 0.1.5-rc.3）：`tsc -b` **0 错误**，`npx vitest run` **1253 条通过 / 0 条失败**；唯一无法加载的仍是 `test/subagent-model-authorization-ptc.test.ts`（它的 3 条在 rc.1 上通过，0.1.5 闭包里没有 `@deepseek-ai/dsh-ptc-runtime`）。新增 `test/codex-image-tool-view.test.tsx` 6 条，按字面写出各阶段的线形状（preparing / start / rc.1 之前的 running / 结果 / 出错 / 非 JSON 参数），**两代都通过**。该文件锁定的是**行为而不是「修复」**——原实现在 preparing 上产出完全相同的结果，因此它区分不出改动前后，这一点如实记下。

- **新增第五条线路：GLM（智谱 / Z.ai Coding Plan）**，Provider id 为 `zhipu-coding-plan`，与另外四条线路功能对齐（多账号号池、模型勾选、逐模型能力表、上下文窗口覆盖、默认思考深度、额度卡片与输入框右侧胶囊）。该 id 特意与用户常用的自定义 `zai` / `zhipu` OpenAI 兼容条目分开，安装本插件不会覆盖或隐藏原有自定义 API。
  - **两个部署、两套控制台，区域是凭据属性**：国际区 `https://api.z.ai`、国区 `https://open.bigmodel.cn`，两边的 Key **互不通用**。添加 Key 时显式选择区域，账号卡片逐条标注，模型请求走该账号自己的 host；凭据里的 base URL 由区域推导而不是采信落盘值，手改文件也无法把 Key 指向别的主机。
  - **订阅接口不是开放平台接口**：Coding Plan 的模型面是 `{base}/api/coding/paas/v4`（不是通用付费的 `/api/paas/v4`），添加 Key 时先用它读一次该部署自己的模型目录做验证，未通过就不落盘——这是这个产品最常见的一次配错，错误文案直接告出「Key 大概该来自哪个控制台」。整次登录只花一次上游读（验证用的目录被缓存）。
  - **额度取自订阅自己的监控接口**，且鉴权方式与模型接口**不同**：`/api/monitor/usage/quota/limit`（5 小时 + 每周 + 月度 MCP 工具调用）与 `/api/biz/subscription/list`（套餐名）用**不带 `Bearer` 前缀的裸 Key**——实测带前缀判 401、裸 Key 通过——而模型接口用文档记载的 `Bearer`。两条 header 各自成函数，并各有测试锁定。窗口按上游的 `unit`/`number` 换算成分钟后再命名（`unit 3 × number 5` → 5 小时，`unit 6 × number 1` → 每周），同时兼容 `TOKENS_LIMIT` 与新版 `CREDIT_LIMIT` 两种拼写，避免卡片对活账号报「无额度」。
  - **模型能力逐模型查表**（`src/host/zhipu/model-catalog.ts`，转录自订阅侧模型注册表与官方文档）：图片支持、思考档位、能否关闭思考都是逐模型事实，**不能按族名推断**——`glm-5.3-flash` 接受图片而 `glm-5.3` 不接受；`glm-5.3` 有三档而 `glm-5.2` 只有两档；`glm-4.7` / `glm-4.5-air` 这类 toggle 模型根本不收 `reasoning_effort`。运行时以订阅侧 `GET /models` 为准，但它只覆盖上下文窗口，能力字段不被这份列表改写（列表声明窗口，不声明能力）。
  - **思考档位先收敛再发出**：上游对 GLM-5.x 只接受 `low` / `high` / `max`，其余取值**直接报错**而非被忽略；DSH 的档位词表更宽，因此每个取值都收敛到该模型自己的档位表后才发出。收敛的**排序覆盖两套词表**——这一点是实测出来的缺陷：只按上游三档排序时，`minimal`（比 `low` 更省）会被当成未知值弹到中间档，用户选最省的一档反而换来 `high`，既违背意图又更费额度；修好后 `minimal`→`low`、`medium`→`high`、`xhigh`→`max`。关闭思考的值一律不发：GLM-5.3 / GLM-5.3-FLASH / GLM-4.7 把 `thinking.type: "disabled"` 判为错误，省略即它们的 `enabled` 默认。另外不发 `stream_options`（文档未记载该字段，且上游的流式文档显示 usage 无需它也会到达），避免为无收益的字段冒 400 的风险。
  - **瞬时失败按 `code` 分类重试**（`src/host/zhipu/adapter.ts`）：上游 5xx / `code 1230` / `code 1234` / 服务过载归为可重试，走与兄弟线路一致的有界退避（最多 3 次、1.5s 起步、15s 上限、0.2 抖动）并遵守上游 `Retry-After`。**401/403 与 `code 1000` / `1003` / `1001`（Key 失效）、`1311`（套餐不含该模型）、`1309`（套餐已过期）明确不重试**——它们与「额度窗口用尽」（`1308` / `1310`）共用 429 状态码，但处理方式完全相反，因此分类读响应正文的 `code` 而不只看状态码。
  - **号池复用共享内核**：走 `AccountPoolCore` 与同一张设置卡片，因此具备顺序耗尽 / 轮询调度 / 粘性会话、429 冷却换号、账号级失效（保留账号、重新添加即恢复）、设为主账号、备注与清除冷却。账号 id 是 **Key 摘要 + 区域**，别名只显示「区域 + Key 后四位」；明文 Key 既不进 id、别名，也不进任何响应（测试断言 `/accounts/add` 与 `/status` 的响应体不含 Key 本身）。号池文档逐条容错解析：**单条损坏的账号被丢弃而不是让整份文档读失败**——池读取抛错会把「已登录」报成「未登录」，一条坏行就会让整条线路下线。
  - **验证**：`npm run typecheck` 与 `tsc -p test/tsconfig.json` 均 0 错误；`npm test` **93 个文件通过 / 1 跳过，1213 条通过 / 7 跳过、0 失败**（连续多轮复跑稳定）。新增 3 个测试文件共 **67 条**：`test/zhipu-adapter.test.ts`（38 条）锁定逐模型能力与未知模型回落、上游列表窗口合并而能力不被改写、两种鉴权 header、额度窗口与 `CREDIT_LIMIT` 兼容、两套词表的档位收敛、请求构造（始终流式、不发 `stream_options`、不发关闭思考、未声明的档位不发）、`reasoning_content` 流式映射与截断流拒绝、以及读 `code` 的重试/不重试分类（含 `providerRetryAfterMs`）；`test/zhipu-routes.test.ts`（18 条）锁定添加 Key 先验证后落盘且失败不写入、跨源拒绝、额度窗口与失败原因随状态返回、设置读写与 `null` 恢复默认、连接探测走对话面而非列表、启用集合三态，以及号池的去重 / 同 Key 跨区不冲突 / 冷却 / 失效保留 / 池前单凭据投影；`test/zhipu-ui.test.tsx`（11 条）锁定卡片渲染账号区域与套餐、逐窗口进度与重置倒计时、无额度空态、区域选择器、逐模型能力 tooltip、胶囊取**最紧窗口**并按剩余量分级、容量解析与格式化、以及两份词表键集合一致。`test/client-registration.test.ts` 同步扩展为六个标签页与第六条 `conversation.input.right` 注册。

- **修掉测试套件长期存在的不稳定（并发下的假失败与跨用例串扰）**。此前 `npm test` 在默认并发下几乎每轮都失败 4–6 条，早先被当作「既有偶发」放过；实测后确认是真实缺陷，且**失败会污染下一个用例**。
  - **根因**：套件里有多条用例真的去 spawn `powershell.exe` 跑 Windows DPAPI 凭据存储（`token-store-windows` 一个文件就有 6 次），而 `testTimeout` 定在 15s——隔离测量最慢的一条要 **12.3–14.3s**（自身波动就有 2s），余量不到 3s。默认 worker 数按核心数取 15，子进程相互争抢（这里瓶颈是子进程吞吐而非 CPU），于是稳定超时。
  - **超时的伤害不止那一条用例**：超时后仍在飞的请求不会被取消，它们会落进**下一个用例**的 fetch mock，把那个用例也判失败。实测抓到的调用序列是「配额那一组各出现两次 + 前一个用例遗留的 4 次 `streamGenerateContent`」，在断言上就表现为 `expected to be called 4 times, but got 8 times`。这正是「检查一下是不是问题」值得做的原因——它看起来像随机抖动，实际是一条会扩散的失败。
  - **修法**：`vitest.config.ts` 的 `testTimeout` 由 15s 提到 **60s**（约为实测最慢值的 4 倍：健康运行绝不会触发，仍能抓住真正卡死的用例），并把 `maxWorkers` 限到 **4** 作为第二道保险。**成本为零**：这些用例受子进程延迟而非 CPU 约束，4 个 worker 实测 ~51s，15 个 worker ~54s。
  - **验证**：`npm test` **连续 5 轮、每轮 1213 条全通过**；为确认主因，另在**默认 15 worker** 下只改超时复跑 **11 轮**，同样全通过——说明超时余量是主因，worker 上限是针对「外部负载（CI、同机并行任务）重新引入超时、而超时又会串扰邻居」这一放大路径的兜底。修复前：15 worker 下 4–5 条失败、4 worker 下 1/3 概率失败；修复后 0 条。
- **WorkBuddy 每日自动签到**（参考 workbuddy2api 的 `daily_checkin.py` 移植并适配到插件进程内）：
  - 新增 `src/host/workbuddy/checkin.ts`：国区账号（含桌面收编与已隐藏账号）在 Host 启动时签到一轮，之后每 10 分钟幂等补检（当日已签零请求）；先查 `checkin-activity-status` 幂等预查再调 `daily-checkin`，活动无权益当天不再重试，失败当天最多自动重试 3 次；token 续期复用凭据存储现有的过期续期+回写机制（桌面账号原子写回 IDE 的 *.info）。国际区账号不参与。（初版曾做「散列分时窗口」，试用后按用户反馈简化为启动即签，窗口配置已移除。）
  - 状态持久化到 `storages/workbuddy-checkin.json`（tmp+rename 原子写），同日重启免费；签到是进程内调度，**DSH 未运行的当天不签到**。
  - 偏好：`dsh-workbuddy` 命名空间与文件存储双轨新增 `checkin: { enabled }`。
  - 路由：`/workbuddy/api/status` 附带签到汇总（今日 x/y、失败数、上次运行时间，聚合无账号标识）；新增 `POST /workbuddy/api/checkin/now` 手动补签（同源校验，忽略窗口与重试上限但仍跳过当日已签账号）；`/settings` 接受 `checkin` 补丁。
  - 设置页新增「每日签到」区块：开关、「今日已签 x/y」总状态与「立即签到」按钮；中英文案。
  - **合并后修复（评审发现）**：
    - **关掉开关后重启仍会签到一次**。偏好 store 在无 register seam 的 harness（0.1.7 的 `SettingsForms`，即当前实际安装的形态）上异步预热，`status()` 在落盘文档读回之前一直返回出厂默认值；而 Host 构造完调度器立刻 tick，于是「已关闭」的账号每次重启都被签一次。`WorkBuddyPreferenceStore` 新增 `ready()`，调度器在每轮开头 await 它（memoize，只等一次）。
    - **活动未开启的账号当天被永久放弃**。原先 `active === false` 记 `done = true`，而 Host 通常在活动开放前启动，这一条就吃掉了当天唯一的机会——补检也救不回来。现在 `inactive` 与 `done` 分开记录，未开启的账号每小时复查一次（`CHECKIN_INACTIVE_RECHECK_MS`），手动补签不受该节流限制。
    - **「今日已签 x/y」把「无签到活动」算成已签**。汇总新增 `skippedToday`，卡片单独显示「无活动 z」，不再把没签到说成签到。
    - **自动 tick 进行中点击「立即签到」被静默吞掉**。原 `tick()` 直接 join 在飞的 promise，手动「忽略开关与重试上限」的语义随之丢失；改为串行队列，手动请求在飞行中的那轮结束后补跑一轮。自动 tick 仍合并（重复的自动轮没有意义）。
    - **`lastRunAt` 未落盘**，重启后卡片立刻显示「尚未运行」；现在随状态文件持久化（`version: 2`，v1 文档仍可读）。
    - **上游字段容错**：签到状态按蛇形/驼峰双拼写读取，并把 `0/1`、`"true"` 一并归一（对齐参考实现的 `normalize_checkin_status`）；`daily-checkin` 返回「已签到」类软失败改判为成功，不再无谓消耗当天重试次数；401 触发一次强制续期重试（`ensureFresh` 只看本地过期时间，服务端提前吊销的 token 原本每次都要烧掉一次尝试）。
  - **验证（合并后复跑）**：`npm run typecheck`、`tsc -p test/tsconfig.json`、`npm run build` 均 0 错误；`npm test` **95 文件通过 / 1 跳过，1250 通过 / 7 跳过、0 失败**（连续复跑一致）。新增 `test/workbuddy-checkin-review-fixes.test.ts`（19 条）逐条锁定上述修复——**该文件在未修复的源码上跑是 18 条里失败 11 条**，确认它真的覆盖这些路径，而不是只描述期望；`test/workbuddy-section-pool.test.tsx` 新增 4 条覆盖设置页区块（汇总含「无活动」、旧 Host 不渲染该区块、开关补丁落盘、手动签走对路由）。
  - **验证**：`npm run typecheck`、`npm run build` 通过；`npm test` 全绿。新增 `test/workbuddy-checkin.test.ts`：首次 tick 即签、之后零请求、开关关闭不动/手动补签强制、国际区跳过、已签不重复请求、无权益当天不重试、失败 3 次封顶且手动可重试、过期 token 先续期再签到并回写桌面文件、多账号全签、同日状态文件去重、状态路由汇总/旧 Host 返回 null、手动路由同源与方法门禁、设置补丁持久化与旧版窗口字段兼容。

- **模型上下文窗口跟随模型开关，并支持恢复默认**（用户报告：「本项目提供的供应商模型是可以开关显示的，但是配置同页面的配置上下文不行，能不能开启什么模型再调整什么模型的上下文，增加支持恢复默认的选项」）。
  - **上下文窗口只列已勾选启用的模型**：五个标签页统一——ChatGPT 页按 `visibleModelIds`，Antigravity / Command Code / Kimi Code / WorkBuddy 按 `model.enabled`；一个都没勾选时显示空态提示。四页新增 `contextDraftsFor(status)` 并让所有播种路径（`/status`、目录刷新、以及**模型开关请求返回后**）都走它，否则刚勾选的模型会渲染成空输入框（此前上下文区与开关无关，草稿总是先于行存在）。
  - **ChatGPT 页放开到全部模型**：原先只有 `CONFIGURABLE_CONTEXT_MODEL_IDS` 里写死的 6 个模型（恰好等于默认可见的 6 个）能配上下文，勾上 5.5 / 5.4 / 5.4 Mini / 5.3 Codex Spark 后没有对应输入框。现在 `CONFIGURABLE_CONTEXT_MODEL_IDS`、`ConfigurableContextModelId`、`isConfigurableContextModelId` 全部删除，改用既有的 `isCodexModelId`：偏好 schema 按 `CODEX_MODEL_CATALOG` 生成、路由接受任意目录模型、`src/host/model-catalog.ts` 去掉「只有那几个模型才读覆盖值」的守卫。可调上限沿用家族规则（GPT-6 系 872K，其余 1M），与 5.6 系列此前的规则一致。
  - **`null` = 恢复默认**：请求体里的 `contextWindowOverrides: { "<模型 id>": null }` 表示删除该覆盖值、退回目录默认。五个 provider 的路由与 store 合并统一改走 `src/host/common/context-window-overrides.ts`——此前散落的 `{ ...current, ...patch }` 合并会把 `null` 静默吞掉（等于没有删除路径），Antigravity 的路由更是原样透传，一旦有 `null` 就会写进 JSON 文档。持久化类型仍是 `Record<string, number>`，`null` 只在归一化阶段存在，不会落到 settings 命名空间或落盘文件里。
  - **存储里区分「没有覆盖」与「覆盖成默认值」**：ChatGPT 偏好 schema 不再给每个键加 `.default()`，`DEFAULT_PREFERENCES.contextWindowOverrides` 变为 `{}`，读取时由 `resolveCodexCatalogEntry(model).contextWindow` 兜底；已实测 schemastery 对缺键保持缺失、对未知键保留。老配置里存过的键与数值一律不动，用户可见数值不变。
  - **每行「恢复默认」+ 每页「全部恢复默认」**：单行按钮在该模型没有覆盖值时禁用；批量按钮先 `window.confirm`，再把该页**所有**已存覆盖值一起清掉——包括已经被取消勾选的模型，避免隐藏的旧覆盖值残留。
  - **改上下文窗口也会刷新适配器目录**：`POST /preferences/update` 原先只在 `visibleModelIds` / `enabled` 变化时发 `llm/adapters-updated`，而上下文窗口属于 harness 缓存的模型信息，改完在活动会话里不生效；现在带上下文窗口的补丁同样会发（另外四页的 adapter 每次请求读设置，无需改动）。
  - **验证**：`npm run typecheck` 与 `npm run build` 通过；`npm test` **90 个文件通过 / 1 跳过，1146 条通过 / 7 跳过、0 失败**。新增 4 个客户端测试文件（`test/antigravity-context-window.test.tsx` 7 条、`test/command-code-context-window.test.tsx` 6 条、`test/workbuddy-context-window.test.tsx` 7 条）锁定「只列已启用模型、刚勾选即有目录默认值、单行与批量恢复都发 `null`」；`test/client-registration.test.ts` 原有 4 条正则用例改为「行数跟随勾选」并新增 3 条（未勾选无行、勾选后出现且带目录默认值、单行/批量恢复的请求体与 `window.confirm`）；`test/routes.test.ts` 改为接受 `gpt-5.4` 覆盖值，并新增未知模型 400、`null` 删除只影响单个键、上下文补丁触发 `llm/adapters-updated` 三类断言；`test/preferences.test.ts` 新增「恢复默认后该键消失」与「任意目录模型都能设覆盖值」；`test/adapter.test.ts` 与四个 provider 的 store / route 用例补齐删除路径。另新增 `test/codex-context-window.test.ts` 做端到端串验：真实路由 + 真实落盘偏好文档 + 真实适配器解析——设覆盖值后 `resolveModel` 与文档同步变化，恢复默认后**文档里该键消失**（而不是存回默认数值），未知模型与越界值仍 400；把路由里的 `null` 分支去掉后该用例立即失败，确认它真的覆盖了这条路径。

## 0.8.0-alpha.0 - 2026-09-23

- **本次先发 alpha 预发布版**：0.8.0 的正式版尚未定稿，因此只发到 `alpha` 标签（`npm i @eddyskywalker/dsh-chatgpt-subscription@alpha`），`latest` 仍指向 0.7.0——不主动指定 `@alpha` 的安装与升级行为不变。以下改动就是这一版 alpha 的内容。

- **新增 GPT-6 Sol / Luna（`gpt-6-sol`、`gpt-6-luna`）**：这两个模型随 [2026-09-22 的 GPT-6 Sol / Luna 发布](https://community.openai.com/t/announcing-gpt-6-sol-and-gpt-6-luna/1399925) 进入 Codex 模型目录，与 `gpt-6-astra` 同属 GPT-6 系列。
  - **能力按本机真实目录核对，不按族名猜**：三条 GPT-6 条目都支持文本 + 图片输入、默认思考档位 `medium`、订阅侧上下文上限 872K（`~/.codex/models_cache.json`，`client_version` 0.155.0，`fetched_at` 2026-09-23；`gpt-6-sol` 的 `supported_reasoning_levels` 多一个 `ultra`，与 Astra 一样属于客户端的子代理编排，仍不作为 Responses 思考参数暴露）。`gpt-6-luna` 没有 `ultra`。
  - **把「Astra 专属」的硬编码改成「GPT-6 系列」**：目录条目的 `reasoningProfile` 由 `'gpt-6-astra'` 改为 `'gpt-6'`，`GPT_6_ASTRA_MAX_CONTEXT_WINDOW` → `GPT_6_MAX_CONTEXT_WINDOW`、`GPT_6_ASTRA_REASONING_EFFORTS` → `GPT_6_REASONING_EFFORTS`，`contextWindowLimitForModel` 与 `reasoningEffortsForModel` 改为按 profile 判定而不是按模型 id 比较。上一版为新模型加能力时要逐处补 `|| model === 'gpt-6-xxx'`，这次三个模型共用一条规则。
  - **`none` / `minimal` 的收敛也随族生效**：该规则此前只对 `gpt-6-astra` 生效（`responses-mapper` 里的 `options.model === 'gpt-6-astra'` 判断），新增的 Sol / Luna 会漏掉；现在提取为 `codexWireReasoningEffort()` 放在目录旁，按 profile 判定，GPT-6 三个模型行为一致，GPT-5.6 / 5.5 等仍原样透传 `none`。
  - **两个模型默认可见、上下文可配置**：加入 `DEFAULT_VISIBLE_CODEX_MODEL_IDS` 与 `CONFIGURABLE_CONTEXT_MODEL_IDS`，偏好 DTO / 默认值 / host schema / 路由校验同步，因此设置卡里多出两行上下文窗口输入框，新装即勾选；**已有配置的模型勾选与上下文值一律不动**（schema 只是为新键补默认值）。
  - **GPT-6 默认有效上下文提到 384K**：目录条目与 `DEFAULT_PREFERENCES` 一并从 272K 改为 `GPT_6_DEFAULT_CONTEXT_WINDOW = 384_000`（上限仍是 872K，未触及 Codex 目录里 `effective_context_window_percent: 95` 的折算问题）；仅 GPT-6 三条变动，GPT-5.6 系列保持 272K。**已有配置里存过的值不会被改写**——schema 只在新键缺失时补默认值。
  - **输出上限改为按模型区分**：`src/host/model-catalog.ts` 原先对所有模型写死 `defaultMaxTokens: 32_768`，现改为 `codexModelMaxTokens()` 读取目录条目的 `maxTokens`；**仅 GPT-6 系列（6 Astra / 6 Sol / 6 Luna）提到 128,000**，更早的模型（5.6 系列、5.5、5.4、5.4 Mini、5.3 Codex Spark）维持 32,768，因此这次改动不会放宽老模型的单次输出。128K 取自官方对 GPT-6 三个模型的 `128,000 max output tokens` 标注。该字段的语义已在 harness `dsh-llm` 里核实（`lib/types/types.d.ts`：「Adapter-configured per-request output cap materialized when callers omit one」，`resolveCallWithInfo` 在 `config.maxTokens === void 0` 时补入）；Responses 报文自身不发输出长度参数（`responses-mapper` / `responses-client` 内 `max_output_tokens` 命中数为 0，全仓库只有 `codex-search.ts` 给搜索请求写死 4096）。
  - **验证**：`npm run typecheck` 与 `npm run build` 通过（typecheck 需按 lockfile 安装——本机 `node_modules` 里 schemastery 3.18.2 与 lockfile 的 3.18.3 不一致时，`src/host/preferences.ts`、`src/index.ts` 会报两处与本改动无关的 `Volatile` 默认值错误，`npm ci` 后即消失），`npx vitest run` **85 个文件通过 / 1 跳过，1105 条通过 / 7 跳过、0 失败**。新增 6 条断言：适配器对三个 GPT-6 模型逐一校验能力、384K 默认上下文、128K 输出上限与 872K 覆盖，并同时锁定 GPT-5.6 系列与 `gpt-5.3-codex-spark` 仍为 32,768；`gpt-6-sol` / `gpt-6-luna` 的思考档位表与「无降级模型」；映射器对三个 GPT-6 模型统一收敛 `none`/`minimal`，以及 `gpt-5.6-sol` / `gpt-5.5` 的 `none` 不被误伤。

- **支持 DSH 0.1.7-alpha.1**（本机 harness 仓库已到该版本；本机 npm 上 `@deepseek-ai/dsh` 的 `alpha` 也是它）。0.1.7 有**三处破坏性重写**，同一份代码仍要覆盖 0.1.2-alpha.5 以来的各代，因此全部按「双形态」适配，peer 范围相应加入 `^0.1.7-alpha.1`，dev 基线升到 `0.1.7-alpha.1`。
  - **会话消息模型**：0.1.7 把工具结果从「`role:"user"` 消息里的 `tool-result` 内容块」改成**一等 `role:"tool"` 消息**（`toolCallId`/`isError` 直接挂在消息上），`ToolResultBlock` 从 `ContentBlockMap` 删除，`GenerateOptions.messages` 由 `Message[]` 放宽为 `RequestMessage[]`，`MessageSourceMap` 的兜底 `plugin` 种类也被移除。新增 `src/host/common/llm-compat.ts` 作为唯一边界：它给出 mapper 读的规范词汇（`Message`/`ContentBlock` 由 harness 自己的块类型加回本包的 `tool-result` 块推出；`OutboundContentBlock` 是本包回传的那部分），并把 `role:"tool"` 消息重新包成 mapper 认得的「带一个 `tool-result` 块的用户消息」，连 `source.kind === 'tool'` 的出处一并保留。**5 条线路只在各自的请求边界调一次** `normalizeGenerateOptions()`（`responses-client` 的 `stream()` 与四个 provider adapter 的 `offloadOldestRequest*` 之前），5 个 mapper 的逻辑一行未改——这正是旧版仍然逐字可用的原因。
  - **设置 API**：0.1.7 删除了 `settings.register`/`SettingsProvider`/`SettingsScope`，改成从插件 `Config` 的 `.volatile()` 字段投影出表单、写 profile patch（`packages/settings/settings` 在 0.1.7 只剩 `SettingsForms`）。新增 `src/host/common/settings-compat.ts`（本地结构化类型 + `hasRegister` 守卫 + `settingsNamespace` 探测）与 `src/host/common/file-preferences.ts`（`<DSH_HOME>/storages/dsh-chatgpt-subscription-preferences.json`：同步快照、一次性水合、schemastery 校验、临时文件 + rename 原子写、`watch` 通知）。**有 `register` 的一代走原路（行为未变），没有的一代把偏好落到插件自有文件而不是内存**，因此 0.1.7 上设置不会随重启丢失。**并为老用户做一次性迁移**（`src/host/common/legacy-preferences.ts`）：新文件缺失、或只有默认值时，读 `$DSH_HOME/settings.yaml` 以及 harness 迁移后留下的 `settings.yaml.imported` 里本插件的段，用同一份 schema 校验后写进新文件；已存在且带真实值的文件绝不被覆盖。旧文档只按文本解析（本包不引入 YAML 依赖），只认自己那一段的四种形状——标量、一层嵌套 map（`contextWindowOverrides`）、块序列（`visibleModelIds`）、行内数组——读不懂的字段直接忽略。已用本机真实 `settings.yaml` 实测：8 个字段（含嵌套 map、块序列、带副密码的引号代理 URL）全部读全。
  - **agent preset**：0.1.7 不再读取 `~/.dsh/.agent-presets`（改为 bundle 里的 `@deepseek-ai/dsh-agent-preset` 声明行）。**不能把声明行静态写进本包的 bundle patch**：`assertEntriesLoaded` 会让「无 fiber 且未 disabled」的条目直接把 DSH 启动判为失败，而 `@deepseek-ai/dsh-agent-preset` 在 ≤0.1.6 上不存在——那会让多数用户开不了机。因此改为运行时注册：新增 `src/host/agent-preset.ts`，在 `@deepseek-ai/dsh-agent-preset` 可解析且 `agentPresets` 服务在场时按 `preset.yml` + `agent.cordis.yml` 注册 `dispatch`（19 行逐字转录，`!!js` 平台判断落成真布尔值；已用解析后的 YAML 做过 deepEqual，并按 `entryListProblem` 校验），注册失败只记日志、绝不外抛；旧代仍走原有的 harness-home 拷贝。
  - **消息出处**：`MessageSourceMap` 没有兜底 `plugin` 种类了，插件改为声明自己的种类（`declare module '@deepseek-ai/dsh-llm'` 里的 `dsh-chatgpt-subscription`），图片工具与视频工具注入的 notice 消息同步改用该 kind。
  - **另修的连带问题**：`@deepseek-ai/dsh-code-runtime` 在 0.1.7 改名为 `dsh-ptc-runtime`（测试随之改名与改用 `ctx.ptcRuntime`）；客户端工具视图对 `tool-result` 块的判比在 0.1.7 类型里已不成立，改为本地联合类型（运行时两种形态都能认）；`refreshSearchProviderSelection` 一侧补上 `await entry.fiber?.await()`——cordis 4.0.3 的 `Fiber.update()` 不再返回 promise，原来的 `await` 变成空操作，选完搜索提供方后 `ctx.web` 会有一小段空窗。
  - **验证**：`0.1.7-alpha.1` 基线上 `npm run typecheck` 与 `npm run build` 通过，`npx vitest run` 86 个文件 1099 条通过（1 个文件 7 条为既有的平台跳过）。旧代回测在**独立干净目录**里按 `^0.1.5-rc.1` 装出完整依赖闭包（实得 0.1.5-rc.3）：`tsc -b`——即用户实际安装的 host + client 运行时代码——**0 错误**，`npx vitest run` 1096 条通过、**0 条失败**；唯一无法加载的文件是 `test/subagent-model-authorization-ptc.test.ts`，它静态导入 0.1.7 才有的 `@deepseek-ai/dsh-ptc-runtime`，属测试夹具绑定最新一代，运行时代码不受影响。
- **合并社区 PR #15、#12、#14，并修掉评审发现的问题**：
  - **#12（macOS 钥匙串十六进制载荷）**：与版本无关的独立修复，`security find-generic-password -w` 在载荷含本地化字符时输出十六进制字节，解码后仍走原有 JSON 路径；断言与 macOS 回环测试保留。
  - **#14（settings 缺 `register` 时优雅回退）**：四个线路的 provider store 守卫保留（它们的回退本就落到各自的 `FileModelSettingsStore`）；但**主偏好 store 的「内存回退」被替换为文件落盘**（见上），并让 provider store 的回退**从文件水合**——此前回退的 `status()` 恒返回默认值，0.1.7 上「保存过的模型开关每次启动都像被重置」。
  - **#15（客户端 inject 补 `sessions`/`remote`/`remote.session`）**：**报告的根因不成立**。用真实 cordis 4.0.3 在「兄弟 fiber」布局下实测（两种调用方式各两次）：`ModelDirectoryResolver` 的方法调用会被影子上下文指回**服务自己的** fiber，`this.ctx.remote.session` 因此从不由调用方的 inject 决定，调用方只声明 `modelDirectories` 也能通过；0.1.5-rc.2 与 0.1.7 的 `service.ts`/`reflect.ts` 在这点上逐字相同（一方插件 `ui-model-selection` 自己也是只声明 `['commandUi','modelDirectories']` 就叫它）。保留下来的这三项声明不产生副作用（都是客户端本就存在的服务），与 `ui-plan`/`ui-open-in-app` 等一方插件的写法一致，但**它并不是那个 `cannot get property remote.session without inject` 的修复**；按报告者的复现，真正起作用的是激活时序。

- **修 WorkBuddy 的两个账号身份缺陷**（用户报告：①「workbuddy 授权登录和自动扫盘获得的账户如果都是同一个，会出现 2 个账户」；②「添加账号出现的账号会显示账号 1，没正确获取信息」）。两个症状同一根因：**账号 id 曾经把「显示名」当成身份**。
  - **根因（实测）**：浏览器授权的 token 响应只给 `auth` 块（accessToken / refreshToken / domain），**不含账号身份**；`workBuddyAccountId` 的取值链是 `uid → uin → nickname → domain`，于是同一次登录里 uid 缺失就退化成昵称，产出的 id 是 `intl:<邮箱>`。而 CodeBuddy 桌面端自己写的 `*.info` 文件在 `account.uid` 里带着 uuid，同一账号扫盘得到 `intl:<uuid>`。**两条路径为同一个账号算出两个 id**，号池按 id 去重，就落成两行、`/accounts` 两个条目、设置卡片两张卡——这正是「会出现 2 个账户」。同理，响应里连昵称都没有时（实测签名/类型字段在部分账号下为空）只剩昵称兜底，于是落成位置标签 `账号 1`。
  - **identity 从凭据自己解析**（新增 `src/host/workbuddy/identity.ts`）：access token 是 Keycloak JWT，两个区的 `sub` 都是账号稳定 uid（已用本机真实国区/国际区 token 解码确认），`nickname`/`preferred_username`/`name` 提供显示名，`uin` 提供腾讯 UIN。解析在**唯一入口**统一做：`parseCredentialFile`（扫盘与桌面文件重读）、`parseManagedCredentials`、`ManagedCredentialStore.list/add/delete`、号池 `addAccount` 与 `parseWorkBuddyPoolData`。**不校验签名**是有意的：claims 只用来区分账号，token 仍由网关逐次校验，读不出 claim 的 opaque token 原样保留（新增单测锁定）。
  - **昵称不再是取值链的第一级**：改为 `uid → uin → nickname → domain`，且关键是**顺序 + 先定 uid**——`withResolvedIdentity` 在派生任何 id 之前先由 token 的 sub把关：真实登录与桌面文件因此都走 uid 分支、结果一致（原来昵称排在 uid 之前，正是两条路径算出两个 id 的原因）。昵称保留在 domain 之前而不是删掉，是为了让「token 完全读不出 claim」的两个同区账号不会一起塌到共享的 deployment key 上；旧记录不会失去地址——被误存为 uid 的显示名会被换成真 uid（旧值保留为 nickname），无法识别的行则维持原 id 不变（`hasStableIdentity` 守卫）。
  - **登录完成前先定身份**：`beginWebLogin` 在写盘**之前**调 `fetchAccountIdentity`（新增端点 `/v2/plugin/account`，即官方客户端读账号的同一个口，实测两区均返回 uid / nickname / uin / enterpriseId），并用 token claims 兜底；账号接口读不到**不阻塞登录**（新增单测锁定）。这样卡片回填的 `accountId` 与凭据库、号池算出的 id 是同一条，不再出现「先按名字存、事后才发现要按 uuid 存」。
  - **存量数据一次性收敛**：号池解析把 re-key 后指向同一账号的两行合并（插件托管行优先，`isPrimary`、`addedAt`、`lastUsedAt`、冷却与失效状态、以及只存在于被丢弃行的 `uin`/`sourceFile` 展示字段都并入胜者），并把 `activeAccountId` 指向新 id。设置里的 `selectedAccountId`/`hiddenAccountIds` 若写于修复前（旧取值链的 `region:<nickname>`），通过 `workBuddyAccountIdAliases`（枚举旧链可能产出的全部 key）继续匹配，因此**已固定的账号不会退回自动选号、已隐藏的账号也不会重新进入轮换**。
  - **别名优先于 uuid**：默认别名为 `nickname → uin → uid → 账号 N`。uuid 放在 UIN 之后，因为 UIN 是用户能在自己账号页核对的数字；位置标签只剩「凭据完全没有任何身份信息」时才可能出现（即症状②最后一次兜底）。
  - 新增 18 条回归测试：identity 模块 8 条（两区 claim 形状、opaque/畸形 token 不抛错、空字符串不算身份、token 纠正被误存为 uid 的显示名、无改动时返回原对象）、store 2 条（登录凭据与桌面文件归并为同一 id、按显示名存下的托管行能恢复真 uid）、号池 4 条（登录 + 扫盘不产生第二个账号、默认别名取可识别身份而非 `账号 1`、两行 re-key 后合并且保留 UIN、旧 key 的 pin/hide 仍生效）、登录流程 2 条 + 改写 1 条（用 token 而非显示名定身份、账号接口不可达仍能完成登录、原有用例补断言持久化的凭据 id 与扫盘一致）、路由 2 条（登录保存的 id 与扫盘一致、旧 key 隐藏的账号仍报 `hidden`）。**其中 11 条已在修复前的 HEAD（`77491c7`）上实测必失败**：`expected '账号 1' to be '330101607075'`（症状②）、两处 `expected [ 2 rows ] to have a length of 1`（症状①）、`expected 'cn:copilot.tencent.com' to be 'cn:d5721ab0-…'`，另有一条把「忽略旧 key 的 pin/hide」变异回去也立即失败（变异测试确认断言有效）。identity 模块的 8 条在基线无法运行（该文件为新增），故未计入这 11 条。修复后 1036 条全绿（82 个文件通过 / 1 跳过），`npm run typecheck` 与 `npm run build` 均通过。
- **修「模型选择器打开要等好几秒，且第二次打开一样慢」**：`kimi-code` 的 `loadProviderModels()` 把 `ensureAccessToken()` 放在 30 分钟目录缓存的判断**之前**，而取 token 要读凭据存储——Windows 上那是一次经由 `spawn("powershell.exe")` 的 DPAPI 解密。DSH 在构建模型选择器的目录时会对**每个 Provider 的每个模型**调一次 `resolveModel`，本线路的 `resolveModel` 每次都会调 `catalog()`，于是**一个模型一次进程启动**。实测（Windows / Node 24）：裸启动 `powershell.exe` 约 190–200 ms，4 个模型的目录解析 808 ms，第二次构建仍是 835 ms——缓存从未生效。修复后同一测量为 3 ms、0 次启动。
  - **`loadProviderModels()` 的缓存检查提前到取 token 之前**，token-free 的调用按 `region` 匹配（`region` 因此单独记进缓存条目，不再只存在于 `${region}:${token尾8位}` 这个合成 key 里）。不同区域不会互相命中；显式传了 `accessToken` 的调用方仍按 token 精确匹配，因为换账号可能看到不同清单。
  - **`UsageService.status()` 同样把 60 秒快照的判断提前到 `oauth.credentials()` 之前**：设置卡片每 60 秒轮询 `/status`（外加 `visibilitychange`），此前每次轮询都要先读一次凭据，因此**每次轮询一次进程启动**，与快照是否新鲜无关。快照本就按账号分键，且账号切换会 `clear()`，所以提前返回不会报出别的账号的用量；取到凭据后发现账号变了的那条判断保留。
  - **修正上述配额缓存提前返回引入的一次账号串号**：那条早退发生在「取到凭据后比对账号」这道守卫**之前**，于是 60 秒窗口内切换账号时，卡片会把**上一个账号**的用量当成当前账号的用量报出来（实测：切换后仍返回旧账号的 10%，真实值应是 99%）。根因是守护这份缓存所需的账号身份**只能从凭据里得到**，而要省掉的正是这次凭据读取——「零凭据读取」与「账号正确」在带号池时天然冲突。现在改为比较一个**零成本的内存身份修订号**：号池把它作为公开方法暴露（与本进程的凭据写入计数相加），任何可能改变「由哪个账号作答」的写入——登录、删除、设为主账号、轮换、刷新——都会推进它；缓存只在修订号与写入快照时一致时才命中，因此不命中就回落到原有的账号比对（那是唯一能确认真实账号身份的地方）。登出的 `usage.clear()` 保留；ChatGPT 的 `/accounts` 账号动作本就没有清缓存（这正是本缺陷的成因），现在的正确性不再依赖它。修订号取不到网络与磁盘，Windows 上 DPAPI 读取的优化因此完整保留（空闲轮询仍是 0 次进程启动）。
  - 新增 2 条回归测试：号池端到端 1 条（切换主账号后卡片立即报新账号的 99%，按请求实际携带的 `chatgpt-account-id` 判定归属，因此断言的是「哪个账号的配额」而非请求次数）、配额服务 1 条（登出后 60 秒窗口内不再返回登出前的快照）。两条都在修复前必失败（已实测：`expected 10 to be 99` / `expected 1 to be greater than 1`）。
  - 新增 9 条回归测试：目录 6 条（热缓存零凭据读取、多模型解析只读一次、`force` 仍重新拉取、跨区域不互相命中、带 token 的调用方仍能命中、无 store 返回空）、配额 3 条（热快照零凭据读取、过期后仍重新读取、未登录不返回缓存快照）。用例断言的是**凭据读取次数**而非墙钟时间，因此锁定的是调用顺序本身。

- **修「0.1.6 上 dispatch 预设挂载失败」**：harness 0.1.6 把 workflow 引擎的包名从 `@deepseek-ai/dsh-workflow-worker-thread` 改成 `@deepseek-ai/dsh-workflow-ptc`，preset-sync 靠探测当前安装能解析哪个拼写来改写预设行；但探测根只看 profile 目录、cwd 与插件自身目录，而标准装法下 harness 是全局 npm 安装、插件在 profile 的 pnpm 树里，Node 从插件位置解析不到 harness 嵌套的 `node_modules`——两个拼写都"解析不到"时按设计不改写，旧名字原样同步进 `~/.dsh/.agent-presets`，预设挂载即报 `names a plugin that cannot be resolved`。0.1.5 上无需改写，故障完全隐形。`candidatePackageRoots` 新增 harness CLI 入口脚本（`process.argv[1]`，经 realpath 解 bin shim 与相对路径）所在目录作为候选根：它必然位于 harness 安装树内，向上走即达 harness 自带包。改写仍是双向的，0.1.5 行为不变（旧名可解析故保留）。新增 2 条用例：入口脚本旁的 harness 包可达、入口缺失或悬空不抛错。
- **修复 ChatGPT 线路的网页搜索不可用**（实机 sighting：对话里执行「网页搜索」直接报 `Error: ChatGPT subscription credentials are required for Codex search.`，连本仓库自己的检索也一起失败）：
  - **根因是「取号」与「取凭据」两件事被合并成了一条路径**。ChatGPT 号池为了在 429 之前就跳过已用尽的账号，会在按账号缓存到「Codex 窗口已用尽」时把该账号移出轮换（`account-pool-core.getEffectiveAccount` → `isEligible`）。而 OAuth 服务的 `credentials()` 过去**只有这一条路径**，于是 `codex-search` / `codex-fetch` / `codex-images` 和配额卡片全都拿不到凭据。实测确认：窗口打满时 `oauth.credentials()` 抛 `LlmError(RATE_LIMIT)`，而**同一个 token 直接打 `/alpha/search` 却能正常返回结果**——搜索并不计入 Codex 限流窗口，被挡住的只是调度，不是凭据。
  - **区分「调度问题」与「凭据问题」**：号池内核新增 `getCredentialAccount()`，只按凭据本身是否可用（`authStatus`、被拒绝的 refresh token）判断，**忽略冷却与本次请求的 tried 集合**；OAuth 服务新增 `credentials(force, { purpose: 'tool' | 'request' })`，`'tool'` 走前者，且只刷新它选中的那个账号（不会为了取凭据而轮换会话账号，也不写 `lastUsedAt` / `activeAccountId`）。模型请求仍走原有严格路径，配额门控不受影响。
  - **刷新后的轮换令牌必须落盘**：tool 路径若在临近过期时刷新，会把新凭据写回号池并镜像主账号——否则池里留下的就是上游已作废的 refresh token。
  - **报错不再误导**：搜索的凭据失败现在按原因分流——配额/限流是 `WEB_PROVIDER_RATE_LIMITED`，文案为「Codex search is rate limited」并带上底层原因；需要重新登录才是 `WEB_PROVIDER_CREDENTIAL_MISSING`。图片工具的凭据错误同样附带底层原因。此前一律说「credentials are required」，把「额度用尽」指向了「去登录」。
  - **配额卡片自身也被这条路径挡住**：窗口打满后卡片显示「ChatGPT credentials could not be refreshed」并停在上次快照——最该解释额度耗尽的界面反而最先失效。`UsageService` 的所有凭据读取改为 tool 用途后，卡片能继续展示真实用量。
  - 新增 15 条回归测试：号池内核 7 条（冷却中仍可取凭据、忽略 tried 集合、固定账号生效、已失效凭据仍拒绝、不移动会话轮换、刷新并落盘、空池提示）、号池 + OAuth 端到端 2 条（打满窗口下 tool 可取凭据且配额卡片仍 `ready`、「tool 不轮换会话账号」）、搜索提供方 5 条（以 tool 用途取凭据、401 重试、限流/登录/存储三类失败的正确 code 与文案）、配额服务 1 条。全部用真实号池接线而非 mock，因此锁定的是调用链本身。
- **新增 WorkBuddy 线路**（`workbuddy-subscription` Provider），接入腾讯 WorkBuddy / CodeBuddy 订阅，成为本插件的第五条线路。该 ID 与用户自定义 OpenAI 兼容 Provider 常用的 `workbuddy` 分开，因此二者可同时安装和选择。既可直接复用 CodeBuddy 桌面端登录态，也可按国区/国际区通过官方浏览器授权添加账号；后者存入 Windows DPAPI / macOS Keychain / Linux Secret Service。插件托管账号可删除，桌面账号只能隐藏/恢复且绝不删除原凭据文件。
  - **凭据来源**：扫描桌面端的 `*.info` 凭据文件（`CODEBUDDY_AUTH_DIR` 可覆盖，与官方工具链一致）。目录里通常混着当前凭据与若干带时间戳的历史快照，选取顺序是**规范文件名优先，其余按 token 剩余有效期取最长**——只按 mtime 选会选到过期快照（开发过程中确实选到过）。扫描失败的单个文件被跳过而不是让整次扫描失败；`/status` 每次都重扫，避免缓存掩盖刚登录的凭据。
  - **续期回写**：token 临近过期时调 `/v2/plugin/auth/token/refresh`，并把新 token **原子写回原文件**（只改 `auth` 块，保留桌面端自己的字段），以免桌面端掉线。同进程并发调用**共用一次刷新**——refresh token 会轮换，两次并发刷新会互相作废。写回失败不影响本次请求。
  - **两条上游硬约束**（实测）：该端点是 OpenAI 兼容的 `POST /v2/chat/completions`，但**只支持流式**（`stream:false` → 400 `code 11101`），且**首条消息必须是 system**（国际区否则 400 `code 11128`）。请求构造器因此始终发 `stream:true`，并在调用方没给系统提示时补一条中性提示，手搓的一次性请求也不会踩到这条规则。
  - **区域是凭据属性**：`*.workbuddy.ai` / `*.codebuddy.ai` 走国际区 `https://www.<apex>`，其余走国区 `https://copilot.tencent.com`。设置页按**国区 / 国际区**分组账号，历史快照按账号去重；所选账号持久化，并统一控制模型目录、额度、连接测试和实际对话。两区模型清单不同，把模型发到不服务它的区会返回 400 `code 11102`，所以模型选择器**按当前账号区域过滤**。
  - **模型目录取自网关的 `/v3/config`**（官方 CLI 启动时读的就是它），而不是靠模型名猜测：每个模型的真实上下文上限、输出上限、是否接受图片、可用思考档位都由它给出，并带 30 分钟缓存与手动刷新。`/v1/models` 在这条线路上是 404，所以内置表只作为离线兜底。
  - **内置兜底表是从真实 `/v3/config` 转录的，不是手写猜测**。早期手写版本按厂商宣传页推断，两个方向都错了——`glm-5.3` 与 `kimi-k3` 实际都是 1M，而非 200K/256K。目录同时区分**默认服务长度**与**模型上限**（如 `deepseek-v4.1-flash` 默认 300K、最大 1M）；本线路不发显式长度参数，因此 DSH 的压缩与溢出判断按默认服务长度计算，不会越过后端实际接受的窗口。
  - **逐模型实测了目录的可用性**：国际区 21/21 可调用，国区 29 个里有 7 个（`glm-5.0`、`glm-4.7`、`glm-4.6`、`glm-4.6v`、`kimi-k2-thinking`、`hy4-preview-x`、`minimax-m2.5`）由网关列出却返回 400 `code 11102`——网关会列出**当前套餐无权调用**的模型。这些条目被保留（门控是按账号而非按模型，付费套餐可能可用），且默认勾选集合已排除它们；`11102` 的失败文案同时说明「区域不支持」与「套餐不包含」两种情况，因为两者的处理方式相同（换模型）。四个默认勾选模型（`glm-5.3` / `deepseek-v4.1-flash` / `hy4-preview` / `kimi-k2.6`）已在两个区都验证可调用。
  - **档位别名按区解析不同**（`fast-model` 在国际区是独立模型、在国区落到 `deepseek-v4.1-flash`），因此别名条目只在其真实生效的区上声明，不做跨区共享。
  - **实机测试中发现并修复两个真实缺陷**（以 `deepseek-v4.1-flash` 为样本，两个区各 26 项断言全绿）：
    - **思考档位没有回落到模型目录的默认值**：上游在请求不带 `reasoning_effort` 时返回**空的 `reasoning_content`**（实测同一提示：不带字段 0 字符，带字段 130–215 字符），而 `stream()` 此前只回落到用户的全局偏好、不看模型自己的目录默认值，于是 `deepseek-v4.1-flash`（目录默认 `high`）的思考被静默丢弃。现在回落顺序是「调用方显式指定 → 用户配置 → 目录为该模型声明的默认档」，与官方 CLI 行为一致。
    - **把目录里的单个 `effort` 字段误当成完整档位表**：网关有两种写法，`{supportedEfforts:[...], defaultEffort:'x'}` 是显式档位表，而 `{effort:'x'}` 只是**默认值**。此前把后者读成「只有 x 可用」，导致调用方显式传的 `low`/`max` 被判为不支持而被静默替换成默认档。实测 `deepseek-v4.1-flash` 这类模型接受 `low`/`high`/`max` 三档，其余取值由上游收敛到最近的档位，因此这类模型拿到的是这三档而非全量档位表，同时保留 `effort` 作为默认值；显式声明的档位表仍然原样采信（跨区合并时显式表优先于推断表）。
  - 顺带把测试环境的隔离补齐：测试只隔离了 `DSH_HOME`，而 WorkBuddy 读的是 CodeBuddy 桌面端的凭据目录，因此默认构造的 store 会扫到开发者真实登录的账号；现在测试同样把 `CODEBUDDY_AUTH_DIR` 指向私有空目录。
  - **思考档位逐模型**取目录声明值，并优先使用目录给出的默认档（与官方 CLI 一致）；用户配置的档位若不在该模型集合内会被忽略而不是发出去（上游对不支持的档位返回 `code 11150`）。
  - **失败分类**：上游 5xx 与 `code 11134` → `SERVER`（有界退避，最多 3 次，1.5s 起步、15s 上限、0.2 抖动）；额度耗尽（429 / `code 6004` / `code 14003`，6004 的正文带重置时刻）→ `RATE_LIMIT` 并遵守 `Retry-After`；401/403、跨区模型（11102）、不可用图片（11133/11135）、历史形状错误（11128）都不重试，并给出可操作提示。
  - **流中断即失败**：上游必然以 `finish_reason` 或 `data: [DONE]` 结束，两者都缺失说明连接中途断开，此时抛错而不是把半截文本当成完整回答。
  - 额度来自 `/billing/meter/get-user-resource`（套餐名、本周期已用/上限、剩余额度、重置时间）。设置页为「设置 → 订阅服务 → WorkBuddy」标签页，对话输入框右侧有额度胶囊；卡片列出目录中所有可用账号并标明区域，`UIN` 脱敏显示。
  - **请求身份统一使用 CLI UA**（`CLI/2.63.2 CodeBuddy/2.63.2`）：实测 `CodeBuddyIDE` 被 `/v3/config` 以 400 `code 12403` 拒绝，国际区对话端点也直接返回 401，因此不做按端点切换。
  - 路由挂在 `/workbuddy/api`（`status` / `accounts` / `accounts/login` / `accounts/login/status` / `accounts/action` / `rescan` / `quota` / `models` / `settings` / `catalog/refresh` / `connection/test`），修改状态的路由同样只接受同源 JSON POST。
  - **与另外四条线路对齐：接入共享号池内核**。此前 WorkBuddy 只有「单账号 + 手动选择」，没有调度策略、429 冷却换号与账号级失效恢复，是五条线路里唯一没走 `AccountPoolCore`（`src/host/common/account-pool.ts`）的一条。现在它与其他线路共用同一套内核与同一张设置卡片（`src/client/common/AccountPoolSection.tsx`）：顺序耗尽 / 轮询调度 / 粘性会话三种策略、429 按 `Retry-After` 冷却并自动换号、401/403 把该账号标记为需重新登录并换号（账号保留，重新登录即恢复）、每账号 `lastUsedAt` 与冷却倒计时、账号备注、设为主账号、清除冷却、重新登录。
    - **桌面账号是「别人家的账号」**：从 CodeBuddy 桌面端扫描到的凭据会加入号池参与调度，但它们归 IDE 所有。为此号池拒绝删除桌面账号（`deleteAccount` 直接报错），卡片只在 `removable !== false` 时才渲染删除按钮，桌面账号改为「隐藏 / 恢复」——隐藏只影响本插件的调度，绝不改动 IDE 的凭据文件（有测试锁定文件仍含原 token）。
    - **桌面账号续期必须回写 IDE 文件**：refresh token 会轮换，若只写进插件的加密存储，IDE 手里就只剩一个已被用掉的 token，用户会被桌面端登出。因此桌面账号刷新后先原子写回其 `*.info` 再入库；同时避免二次刷新（`getEffectiveAccount` 已刷过就不再刷，否则两次兑换会互相作废）。
    - **账号 id 与既有设置保持一致**：号池新增 `accountId` 钩子，WorkBuddy 用它返回 `${region}:${identity}` 这个既有公开键，而不是内核默认生成的随机 `acc_xxx`。这样老用户已存下的 `selectedAccountId` / `hiddenAccountIds` 无需迁移即可继续生效。
    - 卡片新增两个可选插槽：`renderLoginActions`（WorkBuddy 需要国区/国际区两个登录入口，单按钮表达不了）与 `renderAccountActions`（桌面账号的隐藏/恢复）；`PoolAccountSummaryDto` 新增可选 `removable`（缺省即可删除）。两者对另外四条线路完全向后兼容——既有号池测试全部保持通过。
    - 新增 `test/workbuddy-account-pool.test.ts`（14 条）与卡片/路由回归：身份与快照去重、桌面账号不可删除、隐藏不动文件、固定账号与冷却回退、轮询调度、429 换号、401 标记失效并换号、桌面 token 回写；共享卡片新增 2 条锁定「非本插件账号不出现删除按钮」。
  - **设置页界面与另外四条线路对齐**：接入共享号池内核只统一了数据，卡片本身仍是本线路自己手搓的那套——手写的「本机凭据」账号列表排在共享卡片**前面**，随后还跟一个独立的「账号」分组堆身份字段，分组顺序、标题文案、按钮样式都与四条兄弟线路不一致。现在收敛为与四条线路**逐字一致**的分组序列（账号管理 → 连接 → 模型 → 增强功能 → 上下文窗口 → 用量与额度），标题用共享的「账号管理」，登录入口用共享的 `dsha-btn-primary`；身份信息（UIN、账号类型、区域、认证域名、凭据文件）改由共享卡片的 `renderDetails` 逐账号渲染，独立的「账号」分组整体删除，空态/路由不可达提示也移入卡片（不再与共享空态文案重复）；号池摘要 DTO 因此新增 `domain` / `backend` / `accountType` 三个可选字段。
  - **对话页模型选择器只显示模型名**：`listModels` 不再下发 `description`——五条线路里只有它带描述，DSH 的共享模型选择器会因此给这一路多渲染一行「能力说明」。设置页的模型胶囊同步只显示名称（上下文窗口 / 图片 / 思考档位改挂 `title` 提示），与四条兄弟线路的胶囊完全一致。
  - **思考档位下拉跟随模型**：设置页此前固定渲染全部 6 档，即使当前账号的模型一个都不支持。现在选项由该账号模型**实际声明的档位**并集推导（仅部分模型支持的档位会标注，如 `High (2/5)`），没有任何模型声明档位时给出说明而不是空列表；已保存但当前无模型支持的档位会被保留并标注，不会在打开页面时被静默改写。
  - **修正「全部返回 200 即等于全部支持」的误判**：`/v3/config` 对多数模型只报单个 `effort` 默认值（如 `deepseek-v4.1-flash` 的 `{"effort":"high"}`），此前据此推断成完整 6 档，于是 DSH 模型选择器里出现了该模型并不具备的 `minimal`/`xhigh`。逐档实测确认这类模型接受的就是 `low`/`high`/`max`——与网关为 `glm-5.3-flash`、`kimi-k2.8-preview` **显式声明**的档位完全一致，其余取值由上游收敛到最近的档位而非作为独立档位生效——因此内置兜底表与解析逻辑同步收敛为这三档（`WORKBUDDY_STANDARD_EFFORTS`）。**收紧档位后又修掉它带出的一个反向缺陷**：目录给的**默认档**也可能落在档位表之外——`minimax-m3`、`kimi-k3`、国区 `glm-5.3` 等 12 个条目都报 `medium` 却只有三档。这种「默认档不在表内」的值会被档位解析判为不支持而丢弃，于是请求不带 `reasoning_effort`，上游返回**空的 `reasoning_content`**（实测 `minimax-m3`：不带字段三次全为 0 字符，带 `medium` 为 282–659 字符）。现在默认档会收敛到表内最近的档位（`convergeWorkBuddyEffort`，平局向上取，与 kimi-code 线路 `medium`→`high` 的既有映射一致），并在 `resolveWorkBuddyModel` 这个唯一读取口统一归一化，离线兜底表同样覆盖。
  - **合并前代码审查发现并修复的问题**（同源校验、缓存与凭据续期一致性、流式解码）：`/quota` 的 POST 与其它写路由一样校验同源；`/connection/test` 与 `/catalog/refresh` 先 `ensureFresh` 续期过期 token，不再对有效账号误报 401；`loadConfigCatalog` 不再把另一区域的缓存快照当成当前区域的结果（那会让模型选择器整个空掉，而不是回落到内置表）；续期回写保留原凭据文件的权限位并清理临时文件；流式请求不再附加 300s 墙钟超时（空闲超时由共享看门狗负责，长回答不会被掐断）；无参工具调用同样置 `hasToolCall` 并在首个 delta 带上工具名，否则整轮会被当成普通 stop、工具永不执行；流中错误帧抛错而不是当成干净的停止；路由销毁时终止未完成的浏览器登录轮询。每条修复都有对应回归测试。
- 新增 **157 条单测**：`test/workbuddy-mapper.test.ts`（28 条：system-first 注入与折叠、并行工具结果分组、图片预算按最旧省略、读不出的图片降级为可见文本、SSE 文本/思考/工具调用解码、usage 缓存 token 拆分、`[DONE]` 终止与截断流拒绝）、`test/workbuddy-adapter.test.ts`（30 条：错误分类、区域过滤、目录能力声明、流式端到端、续期后重发、截断流、重试策略取值，以及**思考档位回落到目录默认值**与**显式档位不被覆盖**两条回归）、`test/workbuddy-routes.test.ts`（43 条：`/v3/config` 解析、请求头身份、续期合并、billing 解析与多套餐求和、状态与同源校验、跨源拒绝、方法/子路径兜底、**响应不含 token**，以及**单个 `effort` 字段不等于完整档位表**的回归）、`test/workbuddy-store.test.ts`（28 条：区域推断、凭据解析与选取顺序、扫描容错、续期回写与并发共用、设置存储、目录窗口与能力断言）、`test/workbuddy-oauth.test.ts`（4 条：state 握手、pending 哨兵 11217、凭据解析与托管入库）、`test/workbuddy-ui.test.tsx`（8 条：容量解析与格式化、UIN 脱敏、凭据路径只显文件名、额度胶囊选取与告警分级）。
- 已用真实订阅凭据对**源码与构建产物**分别验证，并在真实 DSH 中装载运行：`/workbuddy/api/status` 在 `dsh web` 下返回 21 个国际区模型、`serving=true` 无路由冲突、真实额度，且响应不含任何 token 字段；把插件注册进 DSH 真实的 `LlmRuntime` 后，`listModels` / `prepareCall` / `stream` 与助手消息组装全部走通；`deepseek-v4.1-flash` 的文本、图片理解（两张不同颜色图片给出不同答案）、工具调用与工具结果回传、12.6k token 长提示、多轮记忆，在两个区共 52 项断言全绿。

## 0.5.0 - 2026-09-20

- **四条线路全部支持多账号与号池调度**（把 Antigravity 已有的账号管理推广到 ChatGPT / Command Code / Kimi Code，落实设计文档 `docs/design-multi-account-pool.md` 的 P0–P4）：
  - **共享号池内核** `src/host/common/account-pool.ts`：加密存储（Windows DPAPI / macOS Keychain / Linux Secret Service）、按文件串行化的读改写、旧版单凭据的零副作用投影、顺序耗尽 / 轮询调度 / 粘性会话三种策略、429 冷却、账号级认证失效状态、刷新失败自动换号。Antigravity 线路改为复用该内核（`AccountPoolStore` 保留原 API 与池文件格式），四条线路的池规则从此只有一处实现。
  - **ChatGPT 号池**（`storages/codex-pool.json`）：按 `chatgpt_account_id` 去重；单账号 OAuth 升级为多账号，`ResponsesClient` 在建立响应前轮换账号，429 冷却换号、401 强制刷新一次后把该账号标记为需重新登录（不再清空整个凭据库）、刷新令牌轮换按账号单飞写入，避免并发重复兑换。
  - **Command Code 号池**（`storages/command-code-pool.json`）：API Key 永久有效故无刷新；按 user id + key name 去重；401/403 标记该 Key 失效并换号，429 冷却换号；浏览器登录与手工粘贴 Key 两条路径都写入池。
  - **Kimi Code 号池**（`storages/kimi-code-pool.json`）：按账号刷新（刷新令牌轮换写回池），凭据自带 region / oauthHost / baseUrl，因此**跨区域账号可混池**且每次请求都用该账号自己的主机与区域。
  - **429 语义按线路区分**：Kimi 的「套餐不含此模型」型 429 属请求属性，既不冷却也不换号——否则一次这样的请求会把整个号池打成冷却；真正的限流/额度型 429 才冷却并接力下一账号。Command Code / ChatGPT 的 429 一律视为账号配额。
  - **账号级失效而非删除**：刷新令牌被拒绝时该账号进入 `expired` 状态并退出轮换，但保留别名与排序；界面提供「重新登录」原地复活（清标记 + 重走登录流程），不再靠"删除再添加"。
  - **ChatGPT 配额感知路由**：已缓存的 Codex 窗口若已用尽且未到重置时间，该账号在发请求前就被跳过，而不是每次都用一次 429 重新发现；用量快照按账号分键存放，切换账号不会串显别人的配额。
  - **排序策略与粘性会话**：新增 `sticky`（保持当前账号直到其被限流），对上游前缀缓存更友好；顺序耗尽与轮询语义保持与 Antigravity 一致。
  - **设置页 UI 统一**：抽出共享账号卡片 `src/client/common/AccountPoolSection.tsx`（主账号 / 当前使用 / 冷却倒计时 / 需重新登录徽章、设备码面板与粘贴 Key 作为插槽），**四个 Tab 全部改用它渲染账号管理**（Antigravity 原本自己手写的那份 JSX 已删除，其项目/邮箱/到期/上次调用行改由 `renderDetails` 提供），并共用同一套 `dsha-*` 分组样式；ChatGPT Tab 顺带从旧的 `dsh-codex-*` 样式换到同一套设计系统，账号管理、连接、模型、增强、上下文窗口、配额的分组顺序四路由一致。
  - **Antigravity 顺带对齐**：调度策略补上 `sticky`（原只有顺序耗尽/轮询），账号动作后清空配额缓存，避免切换账号后显示上一个账号的用量。
  - **测试隔离加固**（代码审查发现的可疑点，经复现判定为误报，但仍加固）：共享 setup 现在**每个测试前重新断言** `DSH_HOME`，两个视频用例改为"恢复原值"而不是 `delete process.env.DSH_HOME`，并新增 `test/isolated-home.test.ts` 作为哨兵。真实用户目录在全程未被测试写入（原报告把 live 应用自身每次 Antigravity 请求都会回写池文件 `lastUsedAt` 的现象误判为测试泄漏）。
  - 三个线路的 `en` 字典补上 `: Record<keyof typeof zh, string>`，漏译从此在 `tsc` 阶段就被拦住。
  - **向后兼容**：老用户升级后池文件不存在时，读路径把原有单凭据投影为主账号（`acc_primary`），界面显示「已登录 1 个账号」，无需重新授权、无需迁移脚本。
- **修「取号记账写失败被误报成凭据不可用」**（实机 sighting：ChatGPT 卡片显示 "ChatGPT credentials could not be refreshed."，但账号已登录、令牌 6.5 天后才到期、按 60 秒刷新余量根本不需要刷新）：
  - 根因：`getEffectiveAccount` 选中账号后会把 `lastUsedAt`/`activeAccountId` 写回池文件，这是**记账**；该写入一旦失败（DPAPI 助手进程卡住、目标文件被占用导致 replace 失败等），异常一路冒泡到 `usage-service` 64-67 行的通用 catch，被换成"凭据无法刷新"——于是凭据明明可用，配额卡片却报错且只显示上次快照。用真实池内容在干净进程里复现可证数据与逻辑本身无误（`write=ok`、`getEffectiveAccount=ok`），故障来自运行进程内的那一次写入。
  - 记账写入改为 best-effort（失败不再阻断取号）；**表达用户意图的写入仍然严格失败**：新增/删除账号、设主账号、冷却、标记失效照旧抛出，避免"冷却没写成功却把限流账号放回轮换"。
  - 同一条提示现在带上底层原因（如 `(DPAPI credential write failed)`），不再是无信息文案。
  - 新增 2 条测试：内核"记账写失败仍能取到凭据、冷却写入仍报错"，配额服务"错误文案包含底层原因"。
  - 新增 54 条测试：`account-pool-core`（11）、`account-pool-section`（9）、`codex-account-pool`（12，含 429/401 轮换与并发刷新单飞）、`command-code-account-pool`（8，含路由动作与单 Key 回退）、`kimi-code-account-pool`（11，含跨区域、套餐型 429 不冷却、刷新失败换号）、`antigravity-section-pool`（3，锁定 Antigravity Tab 已改用共享卡片），外加 `isolated-home` 哨兵 1 条。

## 0.3.9 - 2026-09-19

- **修复工具结果内嵌图像到不了模型**（command-code / antigravity / kimi-code 三条线路，合入 PR #7）：三条线路的 mapper 此前都以「只看消息顶层 content」为前提，因此带图的工具结果（截图类工具、`read_image`）在模型侧全部失明——收集阶段看不到 `tool-result` 内部的图像块，压平阶段又把整条工具结果降级成 `[image: 名字]` 文本，像素从来没有上车的机会。更危险的是模型不知道自己瞎了，会凭空编造图片内容作答。用户在聊天框直接粘贴的顶层图片不受影响，这正是问题看起来像「模型不支持视觉」的原因。
  - 三个 `collectImageRefs` 改为递归进入 `tool-result` 的嵌套 content（`continue` 式，不对块顺序做假设）；DSH 本体 `dsh-llm` 的对应函数同样递归，此处属实现遗漏。
  - **command-code 的 Anthropic 路径**：`tool_result.content` 在带图时改为块数组（原生 `text` + `image.base64`），无图时仍返回纯字符串，逐字节不变。
  - **command-code / kimi-code 的 OpenAI 路径**：`role: "tool"` 消息装不下图像，因此扫描**整段连续 tool 消息**收集全部图像，在段末统一追加**一条** `role: "user"` 消息挂 `image_url`。不逐条插入是硬约束：parallel tool calls 会产生连续的 tool 段，把 user 消息插进段中间会被严格上游拒绝（`tool_calls` 未被连续应答）。kimi 变体的 `declarationSlots` 语义逐语句保持等价，无 slot 漂移。
  - **antigravity（Gemini）**：`functionResponse` 装不下图像，图像以 `inlineData` part 追加到同一条 user content 的 parts 数组（Gemini 允许同一 content 混合二者）；无图时 parts 数组与改前完全一致。
  - 图像读不到（附件缺失或 media type 不支持）时降级为明确的 `[image unavailable: …]` 文本块，绝不静默丢弃。
  - 行为不变性：11 类无图场景 × 5 条 wire 共 55 份请求体与改前**逐字节一致**（差分验证 0 处差异），只有真正带图的结果才改变行为。
  - 新增 `test/tool-result-images.test.ts`（16 条，映射层）与 `test/tool-result-images-wire.test.ts`（4 条，从桩传输读回实际发出的请求体）；两者在未修复源码上分别有 9 条与 2 条失败，可证明其有效性。
  - 已知限制：`offloadOldestRequestImages` 的字节统计仍未递归 `tool-result`（`collectRequestImageBytes` 只扫顶层）。这是有意保持的最小改动——若只让统计递归而替换逻辑仍只处理顶层块，会造成「计数按递归、替换按顶层」的新不一致。后果是工具结果内嵌图像的 base64 体积不计入 `MAX_REQUEST_IMAGE_BYTES` 预算，极端情况下可能发出偏大的请求；修复方向是让统计与替换同时递归，作为独立改动处理。
- **优化 Antigravity 提示词与工具进度输出**：在系统提示词后置注入进度规则，引导模型在调用工具前输出简要进展；过滤冗余格式与前导思考文本。
- **优化 Kimi Code 工具 Schema 兼容性**：递归解析并内联工具参数中的本地 `$ref` 引用，避免上游网关因引用定义不存在而报错。
- **支持自由停用供应商与清空模型列表**（修复 Issue #8 中反馈的供应商强制常驻与选择器受挤占问题）：
  - 四大供应商（ChatGPT、Antigravity、Command Code、Kimi Code）均增加「启用此供应商」总开关；当关闭供应商或全部取消勾选模型时，Adapter 返回空列表，DSH 会话模型选择器将完全隐藏该供应商，不再遮蔽或挤占原生 DeepSeek 及其他第三方供应商模型。
  - 彻底移除前端与后端中「最少保留一个模型」的硬编码拦截，支持全选与全不选自由切换。
  - 修复 Command Code 和 Kimi Code 适配器在已选模型为空时误回退到全量展示（导致 30+ 款模型意外暴露）的严重缺陷。
  - Antigravity 路线注册增加柔性容错与路由冲突监听，避免与其他 Antigravity 插件（如 `dsh-agy-link`）共存时引发崩溃。
- **Antigravity 多账号池与轮询/接力调度**（落实 Issue #8 中建议 3）：
  - 支持绑定并管理多个 Google Antigravity 账号，账号池数据通过系统底层安全存储加密隔离（Windows DPAPI / macOS Keychain / Linux Secret Service），首次使用自动平滑迁移旧版单凭据为主账号，零破坏、免重新授权。
  - **双重调度策略**：
    - **顺序耗尽 (Sequential Drain)**：优先使用主账号；遇 429 限流或额度耗尽时自动进入冷却，并在同一次生成请求中无缝接力切换至下一个健康账号，不中断对话；
    - **轮询调度 (Round-Robin)**：基于 LRU（最久未使用）跨账号循环分摊调用，均衡多个账号的配额消耗。
  - **429 智能冷却与自动接力**：检测到上游 429 配额耗尽时，自动为该账号挂起冷却倒计时（优先解析 Retry-After 头，默认 15 分钟），立即自动重试下一个账号。
  - **界面风格严谨统一且无 emoji**：完全遵从当前设计系统提供多账号卡片列表、主账号标识、当前活跃态、冷却倒计时徽章、设为主账号、手动重置冷却与注销操作。
  - **修测试写坏真实凭据**：账号池默认落在 `$DSH_HOME/storages/antigravity-pool.json`，而多个 Antigravity 测试文件会构造使用默认路径的池，并在并行 worker 里互相覆盖同一个文件——一次 `npm test` 就能把开发者本机的真实账号覆盖成 `{"access":"test-token"}`，随后刷新报 `Missing Antigravity refresh token`。现在由 `test/setup/isolated-home.ts` 为每个测试文件分配私有 `$DSH_HOME`，测试全程不接触真实主目录（已在真机上按文件长度与 mtime 校验零改动）。
  - **读取不再有副作用**：`AccountPoolStore.read()` 原先在从旧版单凭据迁移时顺手落盘，而所有改动池的调用者紧接着都会自己写回，等于白做一次加密往返；一个 getter 悄悄重写加密存储，正是上面那类事故能发生的条件。迁移现在只体现在返回值里，由随后的显式写入落盘，并新增断言锁定该性质。
  - 登录流程因此多了一次加密池写入，`test/antigravity-proxy.test.ts` 的等待预算相应从默认 1s 调整为有界的 10s（实测约 2s 完成，仍能对真正卡死的流程报错）。

## 0.3.6 - 2026-09-17

- **修 preset 在部分 harness 上被判 broken**（有人反馈「装了却选不到」）：dispatch preset 有一行挂载 `@deepseek-ai/dsh-tool-present`，而该包从 harness 0.1.5-alpha.2 才发布，更早的安装上这一行无法解析——roster 会把整个 preset 判为 `broken`，而 broken 的 preset 既不可选也不可复制（文件其实已经同步进 `<dshHome>/.agent-presets/`，失败发生在挂载判定那一层）。现在同步时按当前安装调和：行里的包名对当前安装不提供的，就给该行补一个 `disabled: true`（roster 会跳过 disabled 行；harness 升级到提供该包的版本后，下次启动自动恢复启用）。候选写成显式清单（目前只有 `dsh-tool-present` 一项），而不是「凡是解析不到的行都禁用」——解析器整体失灵时那样会把 preset 掏空，故障比它修掉的更隐蔽。新增 5 条用例，拿真实 preset 跑四种包集，按 roster 自己的规则断言没有挂不上的行。
- **peer 下限抬到 `^0.1.2-alpha.5`**：0.1.1-rc.2 既没有 preset 需要的 `present` 工具，`agent-tool-presentation` 的 `mode` 枚举那时也还写作 `code`（0.1.2-rc.1 起才是 `ptc`），preset 在那里同样挂不上。当初把 0.1.1-rc.2 圈进范围的 `@deepseek-ai/dsh-client-runtime` 已在 0.1.2 停发，抬下限不损失真实支持。
- `presets/dispatch/agent.cordis.yml` 补上缺失的结尾换行——`.editorconfig` 要求 `insert_final_newline`，它是仓库里唯一违反该约定的文件。
- **修生成图片不显示**：`CodexImageToolView` 通过 `conversation.resolveImage` 取图，而该服务在 harness 0.1.2 就改名成了 `uiConversation.imageUrl`，此后所有版本的生成图片都渲染不出来（代码里是 `as unknown as` 强转，编译期查不出来）。现在按可用性依次取 `uiConversation.imageUrl`、`conversation.resolveImage`，都不可用时返回失败的 Promise，卡片显示既有的「图片加载失败」文案。
- **兼容 harness 0.1.6 的改名**：DSH 0.1.6 把 workflow 引擎的包名从 `@deepseek-ai/dsh-workflow-worker-thread` 改成 `@deepseek-ai/dsh-workflow-ptc`，而 preset 行名指向不存在的包会让整个 preset 被判为 broken、既不可选也不可复制。`src/host/preset-sync.ts` 现在在同步时探测当前安装能解析哪个名字（`import.meta.resolve`）：旧名仍在就保留，否则把行里的包名改写成新名；两个都不能解析时不改写（改名只会掩盖试过哪个）。同一份 preset 因此在 0.1.5 与 0.1.6 上都能挂载。新增 `reconcilePackageNames` / `resolvesFromHere` / `rewritePresetFile` 与 9 条用例，覆盖「改写后的目标树仍然幂等」「安装换代后改回来」「只处理 `.yml` / `.yaml`」。
- **开发与测试基线移到 harness 0.1.5-rc.2**（npm 上 `@deepseek-ai/dsh` 的 `latest`，也就是用户实际在跑的版本）：此前 `package-lock.json` 把整棵依赖树钉在 0.1.1-rc.2，测试从来没跑在用户运行的版本上——「生成图片不显示」这条就是这样漏掉的。重新生成锁文件后 dsh 全家族（27 个包）落在 0.1.5-rc.2，`peerDependencies` 相应补上 `^0.1.6-alpha.1`。peer 与 dev 从此分工明确：peer 声明支持的世代，dev 只声明构建与测试所对的那一版。
  - 客户端类型换到 0.1.2 之后的新家：`@deepseek-ai/dsh-client-runtime` 自 0.1.2 起不再发布。`ClientContext` 改从 `@deepseek-ai/cordis` 取，`ctx.slots` 的声明改由 `@deepseek-ai/dsh-client-ui-renderer/client` 提供（新增该依赖），`SnapshotStore` 改为在 `src/client/store.ts` 声明共用结构（只用 `getSnapshot` / `subscribe` 两个成员），`package.json` 的 peer、dev 与 `dsh.client.inject` 移除该包。客户端产物仍然只 `require` `react` / `react/jsx-runtime`。
  - 测试跟随三处 API 改名：`mode: 'code'` → `'ptc'`（`ToolRuntime` 的装配枚举）、`CallId` → `ToolCallId`（现由 `@deepseek-ai/dsh-llm/brand` 导出）、`settingsNamespace()` → 直接用 `PREFERENCES_NAMESPACE`（该函数已从 `@deepseek-ai/dsh-settings` 移除）。
- `test/package-integrity.test.ts` 的不变量由「peer 与 dev 逐字相同」改为「dev 的每一段范围都必须出现在对应 peer 的范围里」。原写法要求两处完全一致，而 peer 现在要覆盖两个世代、dev 只能对其中一个编译，subset 才是这条检查真正要表达的事。
- 修 README 里与实际不符的说明：`maxDepth` 默认值（0.1.5 及以前取 preset 行、默认 3；0.1.6 起取 `subagent` 服务设置、默认 1）、不存在的「DSH 插件市场」安装路径、Subagent 卡片的位置，以及构建与测试所对的基线版本。

- **调度模式 Agent Preset 随包分发**：新增 `presets/dispatch/`（基于 PTC 模式的编排 preset：R0 复杂度分诊 → L2 任务的澄清访谈 → 规划 → 派发 → 审查 → 验收；子代理必须显式指定模型且落在「子代理」设置白名单内；选择不可用时按 DSH 默认行为降级）与 `src/host/preset-sync.ts`。DSH 只能从配置根、内置 `agent-presets` 包的 `presets/`、以及 `<dshHome>/.agent-presets` 发现 preset，插件包无法自行注册根目录，因此采用「包内随附 + 启动时同步到 home」的方式（与 `@linxin666/dsh-liangshen` 同一机制）。同步幂等、只处理本包自己的 id、绝不触碰用户手写的 preset，失败只记 warn 不阻断插件加载；新增 `config.syncAgentPresets`（默认 `true`）可关闭。包根通过向上查找最近的 `package.json` 定位，兼容 `src/` 与打包后的 `lib/` 两种布局（写死 `../presets/` 在两种布局下会解析到不同目录）；复制逐条目实现，规避 Node 22 + Windows 上 `fs.cpSync` 遇到非 ASCII 路径直接崩进程的问题（nodejs/node#54476）。新增 `test/preset-sync.test.ts`（8 条）覆盖首次同步、幂等跳过、内容变更重写与多余文件清理、不触碰非本插件目录、retire 与保留、源目录缺失。`package.json` 的 `files` 增加 `presets`、`exports` 增加 `./presets/*`，`npm pack --dry-run` 确认三个 preset 文件随包发布。

- **子代理必须写明模型**：授权守卫不再只拒绝「写明且不在白名单内」的路由，而是要求带有允许列表的会话里每次委派都成对给出 `provider` + `model`。此前不写路由的调用会让子代理继承父级模型（设置卡白名单形同虚设，子代理总是跑在主模型上）；现在缺省与只写一半都会被拒绝，拒绝理由里给出全部已授权路由并提示先用 `list_subagent_models` 查询。只读取公开接口（`ctx.tools.guard` + 会话日志 + 设置文档），不修改 DSH 本体。
- 授权相关拒绝文案拆分为「未指定路由」「只指定一半」「路由不在列表内」三种，`delegationDenialReason` 不再回退到父级 `options` 判定继承路由；新增/改写 `test/subagent-model-authorization.test.ts` 用例覆盖这三种拒绝，以及未记录策略与非托管工具名保持放行。
- 确认 `run_code`（代码模式）无法绕过该守卫：程序里通过 SDK 调用的 `tools["subagent"]` 走的是同一套 `prepare → guard → dispatch` 调度流水线，守卫在调度入口拦截，拒绝理由以 `ToolCallError` 抛回程序。新增 `test/subagent-model-authorization-ptc.test.ts`（3 条）用真实 `ToolRuntime`（code 模式）+ 假 `CodeRuntime` 驱动绑定函数，覆盖「已授权放行 / 缺省拒绝 / 越权拒绝」；这是实测而非假设（先看 DSH 源码确认嵌套子调用确实复用同一调度器，再用用例锁定行为）。

- 新增 Kimi Code（Kimi For Coding 订阅）线路：注册 `kimi-code` Provider，把 Moonshot 的 Kimi Code 订阅作为本插件第四条线路接入 DSH。Kimi Code 与 Moonshot 开放平台（pay-as-you-go）是**两套互不通用的系统**：订阅走 `https://api.kimi.com/coding/v1`、凭据来自 `auth.kimi.com` 的 OAuth；开放平台的 key 与 base URL 在订阅端会被判为 `401 Invalid Authentication`，插件据此把两者严格分开。
- OAuth 采用 RFC 8628 设备码流程（`src/host/kimi-code/oauth.ts`），复刻官方 CLI 的协议细节：`POST /api/oauth/device_authorization` 只带 `client_id`（公共客户端，**无 client secret、无 PKCE、无 scope**），`POST /api/oauth/token` 轮询用 `grant_type=urn:ietf:params:oauth:grant-type:device_code`；令牌响应字段（`access_token` / `refresh_token` / `expires_in` / `scope` / `token_type`）与官方实现逐字段对应。`slow_down` 按 RFC 把轮询间隔永久 `+5s`；`authorization_pending` 继续等待；`expired_token` **不当作失败**，而是像官方 CLI 一样重新申请设备码（用户授权慢了仍能登入）；`access_denied` 单独分类。设置卡展示用户码、一次性链接与到期时间，可复制用户码、可取消。
- 令牌自动续期：阈值取 `max(300s, expires_in × 0.5)`（与官方一致），同一进程内并发调用**共用一次刷新请求**（避免订阅侧并发轮换同一 refresh token）；被拒的 refresh token 记入进程级 tombstone 并进入 5 分钟冷却，之后直接提示重新登录而不是反复打扰服务端。
- **重试语义按错误类别区分**（`src/host/kimi-code/adapter.ts` 的 `classifyKimiFailure`），这是本线路的关键设计：服务把多种含义压进同一个状态码，因此分类读取响应正文而不只看状态码。
  - **会重试**：任意 5xx（含截图里那条 `502 {"error":{"message":"Upstream model provider is temporarily unavailable. Please try again in a moment.","type":"server_error"}}`——上游模型供应商瞬时故障，与账号、模型、凭据都无关）；真正的 429 背压（`We're receiving too many requests`、`The engine is currently overloaded`）；连接层失败（`TRANSPORT`）；流停滞（`TIMEOUT`，由 idle watchdog 触发）。策略固定为 `maxRetries: 3`、`retryableCodes: ['RATE_LIMIT','SERVER','TIMEOUT','TRANSPORT']`、1.5s 起步、15s 上限、0.2 抖动，并**honor `Retry-After`**（作为 `providerRetryAfterMs` 随错误上抛，由 DSH 重试策略原样等待）。402（`unable to verify your membership benefits`）被官方描述为「通常是暂时问题」，同样归类为可重试。
  - **不重试**：401 里其实是**套餐权限**被拒的情况（`does not have access to k3`、`supports only … up to … context`、`model id does not exist`）——与真正凭据失效分开，前者提示换模型/降上下文/升级套餐，后者才提示重新登录；403 的各类账号额度上限（5 小时 / 7 天 / 月度共享池 / 并发上限），提示等待重置或加油包；**配额耗尽型的 429**（`exceeded_current_quota_error`、`insufficient balance`、`please recharge` 等）——这与背压型 429 是两回事，重试只会白白消耗请求并推迟用户该看到的提示；以及 400 请求格式错误。
- K3 系列行为按其官方文档精确实现（`src/host/kimi-code/mapper.ts`）：
  - **思考档位只发 `low` / `high` / `max`**，其余输入被收敛映射（`ultra`/`max`/`xhigh`→`max`、`high`/`medium`→`high`、`low`/`minimum`/`light`→`low`、`none`→`thinking:{type:'disabled'}`），未知档位**不发送**而不是发出去吃 400；Anthropic 线路映射为 `thinking` 预算（low 2048 / high 8192 / max 16384），预算放不下时不启用。
  - **当思考开启时，带工具调用的 assistant 消息必须回传 `reasoning_content`**，否则服务返回 400 `thinking is enabled but reasoning_content is missing in assistant tool call message`。本线路因此**保留 reasoning 块**（同插件的其他线路是丢弃的，因为那些上游要求签名），无工具调用的普通回复则不回传。
  - **不发送 `temperature`**：采样参数按模型固定（1.0 / 0.95 / n=1），服务对显式值直接报错而非钳制，因此调用方的 temperature 被有意丢弃；输出上限统一用 `max_completion_tokens`（旧字段会被服务归一化掉）。
  - 工具调用 id 截断到服务要求的 **64 字符**上限。
  - 发送 `prompt_cache_key`（由首轮用户消息推导的稳定会话标识），让续接的会话能命中前缀缓存；模型或思考档位切换会使缓存失效。
- 模型目录为官方四款订阅模型（`src/host/kimi-code/model-catalog.ts`）：`k3`（1M 上下文，需 Allegretto+；Moderato 上限 256K，故默认按 **256K** 计算以免会话悄悄超出后被 401 拒绝，可用上下文覆盖升到 1M）、`k3-256k`（固定 256K、无视频输入）、`kimi-for-coding`（K2.8 Preview，各套餐均 1M，默认档位 max）、`kimi-for-coding-highspeed`（约 6× 输出速度、3× 额度消耗，需 Allegretto+）。运行时仍以 `GET /v1/models` 为准（含每模型 `context_length`、`think_efforts`、`supports_image_in`），30 分钟缓存、可手动刷新、离线回落内置表。
- 额度卡片读取 `GET /v1/usages`：5 小时 / 7 天 / 月度（会员共享池）/ 月度（Kimi Code 池）四个窗口各自显示百分比与重置时间——把两个月度池**分开标注**，因为共享池耗尽时即使 Code 池还有余额也会被拒；加油包（booster wallet）按服务的定点数换算（1e-6 分，正数不足 1 分记 1 分；`priceInCents` 已是分，不再二次换算）。同时容忍社区记录到的另一种 `usage` + `limits[]` 形状，且从 `used`/`limit` 推导比例，避免服务换形状时卡片直接空白。账号资料取自 `/me`，失败只降级为「已登录但无资料」而不影响额度。
- OAuth 凭据只存 Host：Windows CurrentUser DPAPI、macOS 登录钥匙串、Linux Secret Service（与 Antigravity / Command Code 同一存储栈），明文 JSON 仅作迁移来源；存储的 oauth/API 主机需为绝对 https 源，防止被篡改的凭据文件把刷新请求指向他处。
- 新增 `/kimi-code/api` 设置路由（status / login / login/status / login/cancel / logout / quota / models / settings / catalog/refresh / connection/test），改状态的操作只接受同源 JSON POST；设置页新增「Kimi Code」卡片，对话输入框新增该线路的额度胶囊（最短窗口优先，余额兜底）。
- 修复 Kimi Code 已登录后账号显示为 `—`、以及刷新用量与实际状态不符的问题，根因是三个独立缺陷：
  - **账号资料接口不存在**。此前 `fetchUserInfo` 会去请求 `/coding/v1/me`，而该端点在订阅侧并未提供，非 2xx 时静默返回 null，于是卡片永远是空白。Kimi 的 access/refresh token 本身是 **JWT**，账号身份（`user_id` 优先、`sub` 兜底、`email` 小写化）就在其 payload 里——现在从 token 解码得到账号并在登录时落盘（刷新时也会补齐旧凭据缺失的声明），卡片不再依赖任何网络调用即可显示已登录身份；套餐名仍以 `/usages` 返回的 `user_level_name` 为准并写回凭据。
  - **测试连接按钮没有任何反馈**。`/connection/test` 的处理函数**缺少 return**，响应永远不会结束（按钮点了没反应）；而且探测目标正是那个不存在的资料接口。现在改为以真实的 `/usages` 调用作为探测（200 即证明凭据可用，同时顺带刷新额度卡片），并在卡片上显示结论与延迟。
  - **刷新用量会把失败吞掉**。`/quota` 与 `/status` 都用 `.catch(() => null)` 包住上游错误，于是上游 401/403/5xx 时接口照样返回 200 空数据——这正是「刷新不正常」的观感：按钮看似成功、面板依旧为空。现在显式刷新会把真实原因以 502 + 文案返回，背景刷新则通过新的 `quotaError` 字段随状态一起展示，既说明原因又不隐藏已登录账号；对 `/usages` 的 401 也改为抛出类型化的未授权错误（此前是普通 Error），使「凭据失效」与「服务瞬时故障」在测试连接里能被区分。
- 修复 Kimi Code 套餐一直显示为空，并补齐模型能力展示（新增 `test/kimi-code-plan.test.ts`，19 条）：
  - **套餐名的来源是 `/me`，而它被我上一轮误删了**。Kimi **在 2026 年 9 月把 `user_level_name` 从 `/usages` 里移除**，因此 `/usages` 不再返回套餐名——而该字段正是我当时唯一的来源。现在恢复调用 `GET /coding/v1/me`（仅用 OAuth 访问令牌，不导入粘贴的套餐 key；4 秒超时、失败只降级不影响卡片），并保留 `/usages` 作为回退；两者都拿不到时再读凭据里缓存的套餐名。
  - 新增**会员等级代码映射表**：`LEVEL_STANDARD`/`LEVEL_MODERATO` → Moderato、`LEVEL_INTERMEDIATE` → Allegretto、`LEVEL_ADVANCED` → Allegro、`LEVEL_PREMIUM` → Vivace（旧代码 `LEVEL_FREE`/`LEVEL_BASIC` → Adagio、`LEVEL_ANDANTE` → Andante 也一并支持）。此前若服务只发机器代码，卡片会显示原始枚举；现在映射为 Kimi 定价页使用的名称。昵称同样从 `/me` 读取。
  - **修复 `buildModelOptions` 丢弃目录能力的问题**：`supportsVideo` 与 `minimumPlan` 此前被硬编码为 `false`/`null`，`description` 恒为 `null`——即实时目录与静态注册表已知的信息被直接丢掉。现在按「实时目录 > 静态注册表」取值，视频输入标记与描述都能正确显示。
- 关于截图里两个特殊能力的说明（已核对官方文档与实测资料，并据此决定是否接入）：
  - **视频输入**：`k3` 与 `kimi-for-coding` 确实支持视频，`k3-256k` **只支持图片**。但 **DSH 的模态词汇表只有 `text` 与 `image` 两项**（`ModelModalityMap`），没有 video——若谎报支持视频，DSH 会把无法投递的字节交给该线路。因此**不将其声明为可发送模态**，只在模型提示与能力行中如实标注，避免误导。
  - **`dynamically_loaded_tools`**：这是 K3 的独有能力，允许在会话中途以「不含 content 的 `system` 消息 + `tools` 数组」注入额外工具定义，从而让顶层工具列表保持小而稳定（`system`/`tools` 属于缓存前缀，改动会使整个前缀缓存失效）。DSH 没有对应概念，本插件也无法从适配器层注入消息，因此**仅作展示说明**，不实现——这也解释了为什么官方把工具集稳定性作为优化建议。
- 依据官方文档与实测数据补齐 K3 系列的能力、参数与优化（新增 `test/kimi-code-k3.test.ts`，31 条）：
  - **保留思考 (Preserved Thinking) 默认开启**。官方 CLI 的默认是 `[thinking] keep = "all"`，即服务会跨轮保留推理内容——其错误参考里要求「每个缺 `reasoning_content` 的 assistant 消息都要补上」正以此为前提。此前我们只在**带工具调用**时回传 `reasoning_content`，普通文本轮次不带，这既与官方 `keep=all` 的约定不符，也在长会话里丢失了多轮推理的连贯性。现在思考开启时（含未显式指定档位，因为模型默认就推理）**每条 assistant 消息都写该字段**，无推理时写空串（服务要求的正是空值而非省略）；思考关闭则完全不写。可用 `DSH_KIMI_CODE_PRESERVE_THINKING=0` 关闭，卡片会显示当前状态。
  - **输出上限改为跟随上下文窗口**（`maxOutputTokensFor(modelId, contextWindow)`）。`reasoning_content` 计入输出，而此前固定 32768 的上限会把 `max` 档的长思考**中途截断**并返回 `length`；官方客户端是按窗口封顶（并夹到 窗口 − prompt）——这正是官方文档所说「官方 kimi-code 行为」的 `computeCompletionBudgetCap`。现在按窗口封顶并保留 4096 余量，同时不低于模型声明的下限，避免小窗口把答案饿死。
  - **新增请求前夹取**（`clampOutputToContext` + `estimatedInputTokens`）：调用方若已知 prompt 规模，`max_tokens` 会被下调到 prompt + 输出可容纳；prompt 规模未知时**不做猜测**——猜小会截断推理、猜大被直接拒绝，只有服务知道真实大小。
  - **请求体超过 2 MB 时本地拒绝**（`assertRequestBodyFits`）。这是该端点最常被触发的 400（`total message size N exceeds limit 2097152`），官方文案不给出路；现在按真实序列化体积判断并直接提示「压缩会话/开新会话、检查大工具结果与图片」，既给出可操作建议也省掉一次注定失败的往返。
  - **stop 序列按服务的硬上限裁剪**：最多 5 条、每条不超过 32 字节。超长的序列**整条丢弃而不是截断**——截断后的停止串会在错误位置终止生成，静默改变答案是比不停止更糟的结果。
  - **新增缓存与 K3 调优卡片**：滚动统计命中/新处理的 prompt tokens、输出 tokens 与**缓存命中率**。Kimi 的缓存按内容哈希自动命中、无需也无法手动声明（实测 `prompt_cache_key` 与 Anthropic `cache_control` 标记均被忽略），所以读缓存比例是唯一能证明缓存真的生效的证据；卡片同时说明「同一会话内系统提示与工具列表一旦变化会使整个前缀缓存失效，应保持工具集合稳定、把新增内容追加在末尾」。
  - 澄清并锁定一个此前的错误假设：`prompt_cache_key` 在订阅端**完全是 no-op**（实测：设与不设、相同与不同 key 均命中同一缓存）。我们仍发送它（与官方 CLI 行为一致且无害），但代码注释已改为如实说明，不再声称它能提高命中率。
- 新增 `test/kimi-code-identity.test.ts`（15 条：JWT 解码、`user_id` 优先于 `sub`、邮箱归一化、不透明 token 回退、账号解析与套餐来源、刷新补全身份、连接测试的成功/401/5xx 三分支）与 `test/kimi-code-routes.test.ts`（8 条：无额度时仍显示账号、status 携带 `quotaError`、显式刷新的成功与失败、连接测试的结论与延迟、未登录拒绝、目录与启用集合）。
- 新增 79 条单测：`test/kimi-code-oauth.test.ts`（设备码请求只带 client_id、区域主机切换、`expires_in`/`interval` 缺省回落、刷新对 502/429 的重试与对 401/invalid_grant 的立即失败、刷新阈值下限、并发共用刷新、被拒令牌不再重试）、`test/kimi-code-mapper.test.ts`（档位映射全表、未知档位不发送、temperature 被丢弃、`reasoning_content` 仅在带工具调用时回传、cache key 稳定、两条线路的请求形状与流式解码、usage 与工具增量拼接）、`test/kimi-code-adapter.test.ts`（重试策略取值、上文那类 502 判定为可重试、配额型 429 不重试、403 额度与 401 权限/凭据的区分、`Retry-After` 透传、目录与上下文覆盖）、`test/kimi-code-quota.test.ts`（四窗口标签与重置时间、字符串比例、越界钳制、两种响应形状、定点数换算、套餐名解析、模型目录能力）。
- 在 `README` 增补 Kimi Code 线路说明与故障排查条目，并更新客户端注册用例以覆盖新增的设置区块与额度胶囊。

- 修复 Command Code 额度卡片显示 `meter-1` / `meter-2` 的问题：`/alpha/billing/credits` 的窗口是按名字键控的（`windowLimits.fiveHour` / `weekly`），记录本身**只有数字没有名称字段**，此前的通用扫描找不到可用的 id/label，只能回退到序号占位。现在按名字读取该区块并套用官方 CLI 同款标签（`5-hour` / `Weekly`，另支持 `daily` / `monthly`），排序固定为最短窗口在前；`credits.monthlyCredits` / `purchasedCredits` / `freeCredits` 三笔余额也各自成条。通用扫描保留为兜底，并改为按对象身份跳过已读记录，避免同一份数据被重复上报。
- 修复 Command Code 套餐名称为空的问题：服务只在订阅（或账单）里给出机器 id（`individual-goat`），`/alpha/whoami` 完全不提套餐，因此卡片一直是空白。新增 `src/host/command-code/plans.ts`，转录官方 CLI 的套餐表（Go / GOAT / Pro / Pro / Provider / Max / Ultra / Teams Pro 及各自月度额度），按**最长前缀**匹配——`individual-pro` 同时是 `individual-pro-v1` 与 `individual-provider` 的前缀，按最短匹配会把 Provider 误判成 Pro；同时按服务实际大小写与 `_`/`-` 混用做归一化，未识别的 id 原样显示而不是隐藏。
- 额度卡片同时补齐订阅状态与续费日期（`active` / `trialing` / `past_due` 等）与套餐月度额度；余额解析此前查 `credits` 只会命中外层对象而返回 null（这也是余额一直空白的原因），现按三个池求和。
- 修正无名称的额度条目不再被静默丢弃：仍会展示，但改用可读标签（`Extra allowance`）与说明，而不是此前既不可读、又可能掩盖真实额度的 `meter-N`。
- 新增 `test/command-code-quota.test.ts`（13 条），fixture 为**从真实账号抓取的原样响应**：套餐名解析（含最长前缀与归一化）、订阅状态与周期、5 小时/周窗口的标签与毫秒级 resetAt 保真、窗口排序、三个余额池求和、无名称额度标签，以及 usage/summary 不产生伪额度。
- 修复 Command Code 线路按“厂商/模型名前缀”猜测模型能力的错误做法：模型是否支持图片输入、支持哪些思考深度，都改由官方 CLI 自带的模型能力表（`src/host/command-code/model-catalog.ts`）逐模型查表决定，未知模型回落到纯文本。此前的前缀启发式把 **DeepSeek V4.1 Flash 这类真正的视觉模型判成了纯文本**，导致设置页不声明图片能力、DSH 不会把粘贴的图片交给该线路。同类错误还有多处：`moonshotai/Kimi-K3`、`xai/grok-4.5`、`xai/grok-4.6`、`MiniMaxAI/MiniMax-M3`、`Qwen/Qwen3.8-*` 都被误判为纯文本；而 `deepseek/deepseek-v4-flash`、`deepseek/deepseek-v4-pro`、`zai-org/GLM-5.3` 才是纯文本——同一个厂商内部两种都有（`z-ai/glm-5.3-flash` 支持图片，`zai-org/GLM-5.3` 不支持），前缀判断无法区分。
- 思考深度同样改为查表：此前用 `['low','high','max']` / `['minimal','low','medium','high']` 等族级猜测覆盖所有模型，现在逐模型取注册表声明的集合（例如 `claude-*` 是 `low,medium,high,xhigh,max`，`gpt-5.4-mini` 是 `low,medium,high`，`deepseek/deepseek-v4-pro` 是 `high,max`，`claude-haiku-4-5` 与多数 Kimi/Qwen 模型没有思考档位）。
- 因此新增 `xhigh` 与 `minimal` 两个思考档位：`CommandCodeReasoningEffort` 联合类型、设置卡下拉、路由校验与偏好 schema 一并放开；Anthropic 线路的 `xhigh` 映射为 24576 thinking 预算（介于 `high` 16384 与 `max` 32768 之间），`minimal` 为 1024。
- 修复输出上限被误降到族级默认值的问题：注册表只为 5 个条目声明了 `maxTokens`，此前其余模型一律落到 32768。现在未声明的模型按多 provider 一致的 `limit.output` 补齐（Claude/GPT 系列 64K–128K、DeepSeek 384K、Kimi K3 131072、Grok 500K 等），注册表声明值优先。
- 新增 12 条用例锁定上述行为：逐模型模态（含 `deepseek-v4.1-flash` 支持图片、`deepseek-v4-flash` 不支持、GLM 同厂商正反例、Kimi/Grok/MiniMax/Qwen 视觉模型）、未知模型回落纯文本、逐模型思考档位（含空档位与 `xhigh`）、输出上限三级优先级，以及适配器对视觉模型发送内联图片的端到端路径。
- 新增 Command Code Provider（`command-code`），把 Command Code 的 Provider API 作为本插件的第三条线路接入 DSH：Anthropic 格式模型走 `https://api.commandcode.ai/provider/v1/messages`，其余（开源模型与 GPT 系列）走 `.../chat/completions`，两条线路各自把 DSH 的消息 / 工具 / 图片 / 流式协议映射到对应线上格式。模型 id 决定线路（`claude-*` 为 Anthropic），因为该 API 会拒绝把模型发到格式不符的端点。
- 浏览器登录复刻官方 CLI 的回环回调契约：本机 `127.0.0.1:5959` 起一次性回调服务器（端口占用时顺延，最多 10 个），打开 `https://commandcode.ai/studio/auth/cli?callback=…&state=…&mode=redirect`，Studio 页面以跨域 POST 回传 `{apiKey,state,userId,userName,keyName}`。因此回调端点实现了 CORS 预检（含 Chrome 的 `Access-Control-Allow-Private-Network`）、10 KB 体积上限、`state` 校验、授权拒绝（`access_denied`）路径，以及成功后 303 跳转到 `/callback/complete` 的人工可读页面。另提供“手动填写 API Key”入口作为无浏览器环境的兜底；两条路径都先用 `/alpha/whoami` 验证再落盘。
- 新增 `/command-code/api` 设置路由（status / login / login/status / login/apikey / logout / quota / models / settings / catalog/refresh / connection/test），修改状态的操作只接受同源 JSON POST。
- 设置页新增「Command Code」卡片：账号与密钥信息、连接状态与路由归属、模型勾选（含该模型走的线路）、默认思考深度、逐模型上下文窗口覆盖、额度与用量；对话输入框新增 `command-code` 线路的额度胶囊。
- 模型目录取自公开的 `/provider/v1/models`（含每个模型的 `context_length`），30 分钟缓存、可手动刷新；离线时回落到内置目录。上下文窗口默认取目录值，可逐模型覆盖（用于 DSH 的压缩与溢出判断）。
- 额度来自 `/alpha/billing/credits`、`/alpha/billing/subscriptions`、`/alpha/usage/summary` 与 `/alpha/whoami`：各线路独立容错（一条失败不影响其余），解析器按“带 limit/used/百分比的对象”通用识别而不绑定某个具体响应 schema，识别不出时给出空态而不是伪造 0%。
- Command Code 凭据（API Key）与 Antigravity 一样只存 Host：Windows 使用 CurrentUser DPAPI（`$DSH_HOME/storages/command-code-credentials.json.dpapi`），macOS 使用登录钥匙串，Linux 使用 Secret Service；明文 JSON 仅作为迁移来源，读取后加密回写并删除。凭据不会进入浏览器、`settings.yaml` 或日志。
- `command-code` 路由可能已被其他适配器占用（例如内置 `llm-pi-ai` 用同一端点声明过同名 Provider），而 DSH 的 `registerAdapter` 对重复路由是 all-or-nothing 并抛 `DUPLICATE_ADAPTER`。插件因此把注册做成“可用即接管”：冲突时不让插件加载失败，只在设置页显示路由归属与冲突原因，并监听 `llm/adapters-updated`——原占用方释放该路由后自动接管，无需重启。
- 新增 Kimi 系列的两项「能力补齐」（`src/host/kimi-code/modalities.ts`）：
  - **视频输入真正可用**，不再只是提示文字。DSH 的 `ModelModalityMap` 只有 `text` / `image`，但它是**可合并扩展的接口**，因此本插件用 TypeScript 模块增强把它扩成 `text` / `image` / `video`（`ContentBlockMap` 同理新增 `video` 块）——**没有改动 DSH 任何一行代码**，增强只存在于本插件的编译单元里。此前 `k3` / `kimi-for-coding` 的视频能力只能在设置卡里显示为说明文字；现在它是真实模态：`resolveModel` 会声明 video，适配器会把 `{ type: 'video', attachment }` 映射成服务文档的 `{ type: 'video_url', video_url: { url: 'data:video/mp4;base64,…' } }`（`api.kimi.com/coding` 的 OpenAI 线路）。
  - 视频与图片**各有独立预算**：图片仍是文档的 2 MB 上限，视频按自己的 48 MiB base64 预算按「最旧优先」省略（一个视频片段就远超整段对话的图片额度，共用一个预算会让图片永远发不出去）；请求体校验也据此只在**确实携带视频**时才放宽到 64 MiB，纯文本/图片请求仍按 2 MB 本地拦截。
  - **不臆造未记录的字段**：`k3-256k` 只接受图片，选中它时视频会降级为明确的文字说明（提示改用 k3/kimi-for-coding）；不在文档容器白名单内的格式（白名单来自官方 vision guide：mp4/mpeg/mov/avi/x-flv/mpg/webm/wmv/3gpp）同样降级并说明；而 **Anthropic Messages 线路没有文档化的视频内容块**，因此走该线路时视频一律降级为文字而不是猜一个字段名发出去。
  - `dynamically_loaded_tools` 按官方线格式实现：K3 接受**消息级工具声明**（`messages[].tools`），即可在会话中途以「无 `content` 字段的 `system` 消息」注入完整工具定义（`{ name, description, parameters }` 三元组，服务拒绝只给工具名）。这正是**保护前缀缓存**的手段——官方文档明确把「保持顶层 `tools` 字节稳定」列为该特性目的之一（顶层工具变化、或中途修改/删除已发出的声明都会使缓存从该点起失效，而在末尾追加不影响缓存前缀）。本插件提供 `withMessageTools()` 在 system 消息上挂声明，映射器按历史顺序输出；声明按请求重发（服务端不保留），且仅在模型声明该能力时发送，否则降级为一条说明消息而不是发出必然 400 的请求。
  - 能力判定统一走「实时 `/v1/models` > 内置注册表」：listing 的 `supports_video_in` / `supports_dynamic_tools` 直接采信，离线回落内置表（`k3` / `k3-256k` 具备动态工具加载，`kimi-for-coding` 系列不具备）。设置卡把两项能力显示在模型旁。
  - 修复动态工具声明**位置被提升**的问题：首版把历史里所有 `messages[].tools` 声明收集后统一发在请求最前面，但 Kimi 的缓存是**前缀匹配**——把声明放到它首次发出位置之前会重写缓存前缀并使已缓存对话失效，恰好破坏该特性存在的唯一理由。现在每条声明按其在历史中的真实位置插入（`flushSlots` 按「非 system 消息数」定位并交错输出），因此**末尾追加**仍是缓存安全的追加，而中途新增的声明不会前移。
- 修复 `isAbort` 用 `instanceof Error` 判定取消的缺陷：DSH 的 `LlmError` **不是 Error 子类**，所以在真实调用链上取消会被误判为「读取失败」并降级成模型可见的占位文本——把用户主动取消变成了一个错误答案。改为按 `name === 'AbortError'` 结构化判定，并保留 `signal.aborted` 短路。
- 声明所在 system 消息**同时带有文本**时不再静默丢弃：服务的动态工具 schema 没有 `content` 字段，两者无法合成一条消息，因此现在保留文本（另发一条），并把声明替换为明确的说明消息，而不是让工具无声消失。
- **按官方 CLI 的能力表逐模型修正两项能力**（依据 `managed:kimi-code` 托管模型表里每个模型的 `capabilities` 列表）：`k3` = image_in + video_in + dynamically_loaded_tools；`k3-256k` = image_in + **dynamically_loaded_tools**（无 video）；`kimi-for-coding` = image_in + video_in + **dynamically_loaded_tools**；`kimi-for-coding-highspeed` = image_in + video_in（**无** dynamically_loaded_tools）。修正了先前把 `dynamically_loaded_tools` 当成「K3 独有」的推导错误——官方线文档只提 K3 是因为它描述的是 K3 的请求 schema，而 CLI 自己的能力表把它也标给了 K2.8 Preview。
- 修正能力判定与官方表格的一致性（已对照 https://www.kimi.com/code/docs/en/kimi-code/models.html 逐项核对）：`k3` 与 `kimi-for-coding` 为「Image, video」、`k3-256k` 为「Image only」，与内置表一致；`kimi-for-coding-highspeed` 官方标为 K2.7 Code HighSpeed，「Thinking: ON」且无可选档位，故其固有档位仍按官方标注为 `high`。
- 按第二轮审计修正视频入口的几处问题：
  - **`.mkv` 能存不能发**：入口白名单收 `.mkv`（存为 `video/x-matroska`）而 mapper 的 `isVideoMediaType` 不含它，导致用户挂载 mkv 会收到「Attached video ✅」，模型却只拿到 `unsupported-container` 占位文本。现在入口**只接受 mapper 真能发出的容器**（即 `KIMI_VIDEO_MEDIA_TYPES`），mkv 在入口即被拒绝并说明——入口承诺与线上行为从此是同一件事。
  - **`e2e` 注释的覆盖声称超出实际**：该测试直调 `buildOpenAIRequest`，从不经过 DSH 真实管道。注释已改为如实说明「覆盖请求映射阶段 + 安装版运行时的内容助手」，并明确列出**未**覆盖的部分（会话持久化 / compaction / transcript），要求装机实测。过程中还发现一个值得记录的事实：本仓库**安装版 `@deepseek-ai/dsh-llm` 是 0.1.1-rc.2**（根 barrel 只导出 `contentHasImage` / `projectImagesForTextModel`，**完全没有** file 投影），而工作区 checkout 是 0.1.5-rc.1——两者不是同一份代码，断言已改为针对实际运行的那份。
  - **视频存储新增回收**：内容寻址让重复挂载免费，但此前没有任何清理，目录只会增长。现在写入时按 mtime 做 LRU 回收（预算 512 MB，best-effort、失败不影响挂载），并顺带清理崩溃写入残留的 `.tmp.*` 文件。
  - 顺带修掉两处小瑕疵：`video-tool.ts` 自己写的 DNS `lookup` 改为复用 `fetch-address-policy.ts` 已有的 `lookupHostAddresses`（避免语义漂移）；`index.ts` 中 `disposeVideoTool()` 的缩进与相邻一致。
- **视频输入打通了入口**：此前只有一条没有生产者的 mapper 路径（能力表也只能标注「无上传入口」）。现在新增两件东西，让视频端到端可达：
  - `kimi_attach_video` 工具（`src/host/kimi-code/video-tool.ts`）：接受**本地绝对路径**或 **http(s) 链接**，把视频字节交给插件的视频存储，再以 `exec.deferContext()` 注入一条 plugin 来源的 user 消息（与本插件已有的图片工具同一机制，**不需要改动 DSH**）。可选 `question` 参数让模型在同一轮就视频作答。
  - 视频本地存储（`src/host/kimi-code/video-store.ts`）：DSH 的附件服务只存图片，因此本线路自带存储。标识取字节 sha256（重复挂载同一文件幂等），读取时**重新校验摘要**，被篡改或截断的对象会被拒绝而不是当成原文件发出去。
  - **尺寸上限取官方依据**：官方视频集成把本地文件编码为 `data:video/...;base64,...` 并限制该载荷约 **50 MB**（且明确说这是其客户端上限、非 Kimi API 上限），VS Code 端文件选择器限 **20 MB**。前者描述的是「这个 wire 上模型接受什么」，故上限设为略低于它的 **30 MB 原始字节**（base64 增长 4/3，所以编码后正好落在 40 MB，留在 50 MB 之下）。
  - **两个安全/正确性闸门**：URL 来源在发起请求**之前**套用与搜索抓取 provider 相同的公网地址策略（否则该工具会成为一个 SSRF 原语——测试里有一条专门证明策略缺失时用例会失败）；且只有当**当前会话路由到 `kimi-code` 且所选模型声明了 video** 时才允许挂载，否则明确拒绝并给出补救（换 k3 / kimi-for-coding），绝不会把别的适配器没有处理分支的块注入进去。
  - 能力表脚注相应改为「视频需先用 kimi_attach_video 挂载；直接粘贴仍只支持图片」。
  - 新增 `test/kimi-code-video-tool.test.ts`（17 条：容器识别、内容寻址与幂等、超限/空文件/类型拒绝、摘要失配与文件缺失、相对路径/未知扩展名/非视频模型/错误 provider 的拒绝、私网 URL 拒绝且**不发出请求**）与 `test/kimi-code-video-e2e.test.ts`（3 条：从落盘文件解析出字节并确认线上是真实 base64 内容、字节缺失时降级为可读文本、无视频请求不受影响）。
- **修复审查发现的问题**（视频与动态工具）：
  - **live 目录现在真的能关掉能力**：`parseCatalogModel` 原先把 `supports_dynamic_tools === true` 之外的一切都当作「字段缺席」，于是服务端显式返回 `false` 时会回退到内置表、照样显示支持——与 `model-catalog.ts` 注释里「live 列表权威、包括可以关掉」的承诺自相矛盾。现按三态解析（`true` / `false` / 缺席），显式 `false` 穿透回退。
  - **卡片与请求路径统一到一个解析入口** `dynamicToolsForEntry()`：此前卡片会回退内置表而请求路径 (`entry?.supportsDynamicTools === true`) 不会，导致在线但 `/models` 未返回该字段时 **UI 显示支持、实际请求却降级为「模型不支持」**，且行为随网络状态翻转；离线反而正常。现在两处共用同一函数。
  - **声明不再随持久化丢失**：`withMessageTools` 原先把声明只挂在 `Symbol` 上且 `enumerable: false`，而 DSH 会话历史经 JSON 持久化必然丢掉符号键——会话恢复后声明会静默消失，模型会「以为自己有工具但请求里没有」。现在同时写入一个普通字符串键 `kimiCodeMessageTools`（可被 JSON 序列化，但仍非枚举，兄弟线路照样看不见），并新增 `rehydrateMessageTools()` 供恢复后重新挂上符号。
  - **不再重复发送 system 文本**：`leadingSystemText` 折叠所有 system 文本到请求开头，而声明槽位又会在原位置重发一次，同一段文本出现两遍（浪费 token，且第二次位置可能扰动本想保护的缓存前缀）。现在 `leadingSystemText` 跳过带声明的消息，文本只在声明位置出现一次。
  - **Anthropic 线路不再静默吞掉声明**：该协议不支持消息级声明，原本直接丢弃且无任何提示，模型可能调用从未声明的工具。现在把未发送数量写进 `system` 提示。
  - **请求体守卫不再二次序列化、也不再被用户文本欺骗**：原先用 `JSON.stringify(body).includes('"video_url"')` 判断是否带视频——body 可达数十 MB 却被序列化两次，且用户消息里只要出现该字面量就会把 2 MB 守卫放宽到 64 MB。现由调用方显式传 `carriesVideo`（复用已有的 `requestHasVideo`）。
  - **不再超前宣称视频能力**：模型确实接受视频，但本插件与 DSH 的附件服务都没有视频生产者/读取者（`videos` 读取器从未在 `src/index.ts` 注入），实际永远走 `unreadable` 占位。能力表因此把标签标为「视频*」并加脚注说明当前版本没有上传入口、不会发出视频内容块，避免 UI 承诺与实际可达路径不符。
  - 清理 `classifyKimiFailure` 中 `isLimit ? 'PROVIDER_ERROR' : 'PROVIDER_ERROR'` 的死三元（两分支同值，读起来像意图未实现）。
  - **修复上一轮修复引入的回归**：`leadingSystemText` 是两条 wire 共用的，跳过声明载体后，只有 OpenAI 路径会在载体原位置重发文本；Anthropic 路径因此**整段丢失载体文本**（只剩工具数量提示），恰好违反 `declarationSlots` 注释里「丢掉 system 文本会静默改变模型收到的信息」这条原则。现在 Anthropic 路径会把载体文本拼回 `system`（排在 notice 之前），并加了 2 条回归用例——其中顺序断言特意先 `>= 0` 再比较，否则文本缺失时 `indexOf` 返回 -1 会让断言**空过**。
  - 顺手清理审查指出的三处小瑕疵：`classifyKimiFailure` 中删掉三元后遗留的未引用 `isLimit`（改为真正参与文案选择的 `limitReached`）；`client.ts` 里错位堆在 `dynamicToolsForEntry` 上方的「Input modalities」注释归位；`withMessageTools` 的注释原先一边说「非枚举所以其他读者看不到」一边字符串键副本是 `enumerable: true`，改为明确写清两个副本可见性不同及其原因。
  - `assertRequestBodyFits` 现在**返回**它序列化出的 body，供适配器直接复用：此前带视频时同一个数十 MB 的 body 会被 `JSON.stringify` 两次。
  - 新增 `test/kimi-code-review-fixes.test.ts`逐条钉住上述缺陷：显式 `false` 生效、三态回退边界、文本只出现一次、Anthropic 提示、守卫不被文本欺骗、声明经 JSON 往返后仍可发送；`test/kimi-code-capability-ui.test.tsx` 增加脚注相关 1 条。

- **重排模型能力展示**：此前把能力说明当成长句塞在模型名那一列，把名称列撑开、右侧描述错位。现改为独立的四列表格（模型 / 多模态 / 动态工具 / 说明）：能力只显示短标签（视频 / 仅图片 / 动态工具 / —），逐模型的协议、默认思考档位与所需套餐移入悬停提示；表格自身不再附带任何解释段落。表格抽成可测组件 `KimiModelCapabilities`（`src/client/kimi-code/KimiModelCapabilities.tsx`），新增 `test/kimi-code-capability-ui.test.tsx`（5 条）钉住列数、每模型一行、长句不得进入单元格、悬停内容，以及说明为空时不渲染 `null`。该表也**不再依赖 `description` 是否存在**——实时目录条目缺描述时整个表格（含能力）仍渲染。
- 澄清并测试这两项能力的**跨模型隔离**：机制本身有三重隔离——符号载体**不可枚举**（其他线路的序列化器看不到它）、映射器只在 `messageTools === true` 时输出、且声明只存在于 Kimi 的 OpenAI 线路映射中。新增 `test/kimi-code-capability-isolation.test.ts`（6 条）：Command Code 各模型仍不含 video（证明模块增强是**纯类型、不产生运行时值**）、Kimi 四个模型 id 的 video 与 dynamically_loaded_tools 与官方能力表**逐项**一致（并断言两者并非同一集合：HighSpeed 有 video 却无动态工具）、视频块不会出现在兄弟线路的请求体里、同一段历史里的声明也不会被兄弟线路带出去。
- 另记录一个**证据取舍**：公共 `models.dev` 目录虽声明了 `dynamically_loaded_tools` 字段，但 Moonshot 自家四个条目均未标注，故本插件**不采信该目录**，改以官方 CLI 托管模型表的 `capabilities` 为准；运行时仍以实时 `/v1/models` 的 `supports_dynamic_tools` / `supports_video_in` 覆盖内置表。
- 新增 `test/kimi-code-declaration-position.test.ts`（7 条回归用例）：声明按历史位置交错（含前后两条声明之间有对话的情形）、末尾追加落在队尾且前缀不变、首条声明仍在队首、文本与声明同处一条消息时保留文本并给出说明、以及取消检测在「非 Error 的 AbortError 对象」与「signal 已 abort」两条真实路径上都向上抛出、而真正的读取失败仍降级。这 7 条在把两个缺陷临时改回后**确有 3 条失败**（位置 2 条 + 取消 1 条），确认它们是真的回归用例而非同义反复。
- 新增 `test/kimi-code-capabilities.test.ts`（24 条）：模态词表与容器白名单、视频解析与缺字节/无 reader 的降级、最旧优先省略、两种模型能力下的线级视频形状、Anthropic 线路绝不发未记录字段、消息级工具声明的符号载体（不污染 `Object.keys`）、`content` 字段不得出现、能力缺失时的降级、历史顺序保持、以及请求体预算（纯文本仍按 2 MB 拒绝、带视频才放宽）。另有 3 条既有断言随行为变更更新（`inputModalities` 现含 `video`）。
- 新增 80 条单测：`test/command-code-mapper.test.ts`（两条线路的请求映射、图片内联与超限省略、OpenAI/Anthropic 流式解码、工具调用增量拼接、usage 与 finish reason、截断流拒绝）、`test/command-code-oauth.test.ts`（回环回调服务器：CORS 预检、表单/JSON 回调、state 校验、拒绝路径、303 跳转、宽限期发布）、`test/command-code-routes.test.ts`（账户/额度/目录解析、模型选项与启用集合、设置路由与同源校验）、`test/command-code-adapter.test.ts`（目录、上下文覆盖、两条线路的端到端流式与工具往返、缺凭据/401/429/截断的错误分类）、`test/command-code-store.test.ts`（凭据校验、模型设置文件、设置卡与胶囊的纯函数）、`test/command-code-plugin.test.ts`（插件装配、路由接管与释放后自动接管）。
- 修复开启系统代理的机器上 `web_fetch` 必然失败的问题：DSH 内置抓取 provider 在连接前解析、校验并固定目标地址，而代理工具（Clash/Mihomo 等）的 fake-ip DNS 会把域名解析成 `198.18.0.0/15` 里的保留地址（实测 `api.github.com` → `198.18.0.17`），于是每次调用都以 `WEB_BLOCKED_URL`（`resolves to a non-public IP address`）结束——代理根本没被用上。DSH 只在进程环境变量里读到代理时才走代理，看不到系统代理。现在只要插件配置了可用代理（系统代理自动检测或自定义代理），`web_fetch` 就改用本插件的抓取 provider：由代理解析源站，与 DSH 对“走代理的请求”采用的语义一致；未配置代理时仍由内置 provider 抓取，其解析与固定策略不变。
- 抓取 provider 新增地址策略 `src/host/fetch-address-policy.ts`，保留内置 provider 安全边界中不需要 DNS 的那一半：URL 里写明的 IP 字面量只有全球可路由单播才放行（loopback、私网、链路本地、CGNAT、多播、保留地址、IPv6 转换与隧道前缀一律拒绝）；域名用本机解析器检查一次，落在私网（含 `localhost`、`127.0.0.1.nip.io` 这类）一律拒绝；只有代理的 fake-ip 答案被接受，本机解析不出的域名交给代理处理。与内置 provider 的差别是不再固定（pin）连接地址——fake-ip 环境下这一步无法成立，已在 README 的安全边界中写明。
- 代理偏好在运行时变化（例如系统代理 ↔ 直连）会重新选择抓取后端；选择 ChatGPT 搜索来源时同时切换搜索与抓取的行为保持不变。
- `ProxyManager` 新增系统代理探测的观察点（`onSystemProxyDetected`）：只在「从未知变为已知代理」时通知——探测失败与「本机没有代理」都读作 `null`，因此不会因为一次 `reg query` / `scutil` 抖动就把已经可用的路由拆掉。插件据此在代理迟于 DSH 出现时自动重新选择抓取后端，否则内置 provider 会一直占到进程结束。
- 新增 `test/fetch-address-policy.test.ts`（地址分类、fake-ip 识别、私网解析拒绝、解析失败放行），并扩充 `test/codex-fetch.test.ts`、`test/search-provider-switcher.test.ts`、`test/web-provider-lifecycle.test.ts` 覆盖抓取 provider 的拒绝路径与后端切换。
- 修复 Antigravity 线路静默丢弃用户上传图片的问题（issue #5）：本插件把 `gemini-*` / `claude-*` 都声明为支持图片输入，DSH 因此不把图片投影成文本，而是以 `{ type: 'image', attachment }` 的形式原样交给适配器；但 `mapper.ts` 只认内联 `data` / `base64` / `source.*`，`contentToUserParts()` 又用 `if (img) parts.push(img)` 静默跳过，于是发给 Google 的 `streamGenerateContent` 请求里只剩下文本，模型只能回答「没有收到图片」。现在 `AntigravityAdapter` 接入 `ctx.attachments`，在组装请求前把附件解析为 Gemini `inlineData`（媒体类型取自已校验的附件引用），同一附件在多条消息中只读取一次。
- 读不出字节的图片不再静默消失：降级为 `[image unavailable: …]` 文本让模型能说明图片没读到；取消（AbortSignal）仍向上抛出，不会变成模型可见的文本。工具结果中的图片同样以 `[image: 名称]` 保留，与 Codex 线路一致。
- 新增 8 条 `test/antigravity-mapper.test.ts` 用例（内联映射、跨消息去重、读取失败降级、无附件服务降级、取消传播、旧内联格式、工具结果图片标记，以及不传解析结果时默认参数仍不静默丢弃）与 3 条 `test/antigravity-adapter.test.ts` 端到端用例：`gemini-3.8-flash` 与 `claude-opus-4-6` 各断言一次真实请求体中的 `inlineData`（两个 provider 共用同一 mapper），另一条用 429 逼出候选链，断言每个 runtime model 候选都带着图片、且附件只读一次。新增 `test/antigravity-image-wire.test.ts` 做线级验证：不 mock `fetch`，改为在 127.0.0.1 上起回环服务器并把 `DSH_ANTIGRAVITY_ENDPOINT` 指向它，读取真正离开进程的请求体，断言 `contents[0].parts` 是 `[text, inlineData]`。把这三组用例跑在回退后的修复前源码上，共 12 条失败（其中线级用例显示 socket 上只剩文本），因此它们是货真价实的回归用例。再新增 `test/antigravity-image-bundle.test.ts`：issue 是在 npm 安装版上发现的，所以这条用例直接 import 打包产物 `lib/index.js`（而不是 `src`）跑同一段线级断言，证明用户装到的那个 bundle 里同样带着修复；`lib/` 是提交进仓库的生成物，源码改动后忘记 `npm run build` 时它会失败。工具结果里的图片仍只记名不内联——DSH 自己的多 provider 适配器（`llm-pi-ai`）对工具结果里的非文本块是直接丢掉的，记名已经比参照实现保留得更多，而 `functionResponse.parts` 是否被该端点接受在本地无从验证，故按「不臆造线上行为」处理，并在代码里写明理由。
- 新增单次请求的图片体积上限（`MAX_REQUEST_IMAGE_BYTES`，12 MiB base64）：修复后本线路会把历史里的图片全部内联，图片多的会话会让请求体持续膨胀直到被 Google 的 20 MB 体积上限拒绝，而最先被牺牲的恰是模型最不需要的旧图。现在超过预算时按 DSH 的顺序（最旧优先）把图片替换为上游同款占位文案，`test/antigravity-mapper.test.ts` 与 `test/antigravity-adapter.test.ts` 各有一条用例覆盖（被省略的图片不会被读取，最新一张仍以 `inlineData` 发出，且不改动持久历史）。该逻辑在插件内实现而非调用 DSH 的 `offloadRequestImagesWithPolicy`：本插件支持的 DSH 区间里这个符号的形态发生了不兼容变化（`OFFLOADED_IMAGE_TEXT` 常量 → `offloadedImageText()` 函数；`offloadRequestImages()` 在 0.1.5-rc.1 被移除；`placeholder` 由可选变必填），绑定任一形态都会重演 issue #4 那种"在某个受支持版本上直接加载失败"。
- 修正 `test/subagent-model-authorization.test.ts` 的守卫类型：Host 工具注册表登记的是单参数 `ToolGuard`（`@deepseek-ai/dsh-tools`），测试却按插件内部的三参数 `DelegationGuard` 别名调用，导致 `npm run typecheck` 长期以 TS2554 失败。模拟注册表改为按真实契约取类型后，仓库自带的 `npm run typecheck` 恢复通过。

## 0.2.15 - 2026-09-11

- 新增子代理模型授权守卫：DSH 的「Subagent」允许列表（`subagent-model-selection`）原本只在模型**显式**填写 `provider`/`model` 时生效，而委派调用不填路由时子代理会继承父级模型——于是 DeepSeek 会话里的子代理仍会在未授权模型上运行。插件现在在 Host 工具注册表上注册一个单调守卫（`ctx.tools.guard`），当调用会话（或最近的、记录了策略的祖先会话）带有允许列表时，任何生效路由不在此列表内的委派都会在子代理启动前被拒绝，拒绝理由里带上全部已授权路由，模型据此重试即可选中合规模型。
- 该守卫只在会话确实记录了允许列表时介入（与 DSH 委派工具的会话快照语义一致），不会改变未启用该设置的会话；`subagentModelScope: 'preference'` 可让当前设置卡允许列表也约束未记录策略的会话（含恢复的旧会话）。
- 只读取公开接口：会话日志事件 `subagent/model-selection-policy`、父会话谱系、Host 设置文档与 `ctx.tools.guard`，不修改 DSH 本体。
- 新增配置项：`subagentModelAuthorization`（默认 `true`）、`subagentModelTools`（默认 `['subagent']`）、`subagentModelScope`（默认 `session`，可选 `preference`）。
- 新增 14 条单测覆盖策略解析、谱系继承、设置读取、显式/继承路由的拒绝与放行、作用域切换以及守卫安装路径（含注册与释放）。
## 0.2.14 - 2026-09-10

- 移除失效的「子代理最大嵌套深度 / 子代理上下文预算」设置：这两个偏好键在 DSH 侧没有任何消费方（全仓库无引用），插件自身也只有写、没有读，保存了也不生效。它们源于 2026-08-28 的 `5b08e2e`——那次提交迁移到 DSH 原生子代理模型路由，删除了 `subagent-context-adapter` / `subagent-policy` / `SubagentSettingsSection`，但把这两个控件和偏好键留了下来。相关 DTO 字段、schema、路由校验、界面控件、6 条未引用文案与失效单测一并移除；子代理模型与思考深度改用 DSH 自身的“Subagent”设置卡片，最大嵌套深度由 preset 中 `tool-subagent` 的 `maxDepth` 决定，README 同步更正。

## 0.2.13 - 2026-09-10

- 回退 Codex 与 Antigravity 模型上新增的 `systemPromptUpdate: 'in-history'` 声明：Responses 线路把系统提示词放在顶层 `instructions`，Antigravity 把它放在固定的 `systemInstruction` 加一条 user turn，两条路由都无法把"历史中最后一条 system 消息"当作完整系统提示词。声明该能力会让 DSH 在提示词变化时改为追加 system 节点并保留旧节点，而两个 mapper 会把新旧提示词一并发出。Codex mapper 同时改为只取最新一条非空 system 消息，避免将来重新声明时再次拼接过期提示词。
- 移除 `src/compat.ts` 对 `@deepseek-ai/dsh-llm` 的 `ContentBlockMap.file` / `LlmResolvedModelInfo.systemPromptUpdate` 模块增强：本地 DSH（`packages/llm/llm`，0.1.5-rc.1）已经声明 `'file': FileBlock`，与增强中的 `Record<string, unknown>` 冲突（TS2717），对着本地依赖编译会直接失败。
- 移除两个 mapper 中不可达的 `file` 内容块处理：DSH 内核在进入适配器之前已把文件块投影为 `fileHandleText`（`dsh-llm` 的 `projectFilesToText`），适配器永远收不到 `file` 块；原实现读取的 `byteSize` / `savedPath` 在真实 `FileAttachmentRef` 中也不存在（真实字段是 `bytes`）。
- 移除只完成一半的「智能体团队混合模型规则」（`teamModelRules`）：该功能当时只有偏好存储、路由白名单校验、匹配函数和 64 条中英文案，没有任何地方据此选择子代理模型（DSH 内核对子代理模型走 `subagent/model-selection-policy`），因此连同 DTO、schema、路由处理、单测与未引用文案一并移除，等 DSH 提供介入点后再实现。
- 修复 Antigravity 新账号开通在全部端点失败时静默返回成功：`onboardUser` 现在会在候选端点循环结束后抛出最后一次失败，而不是让调用方误以为已开通。
- 修复登出竞态：`clearCachedQuota()` 增加 epoch 标记，登出时仍在途的配额请求不再回写 `cachedQuota`，也不再为已登出账号写入模型目录；in-flight 槽位改为按持有者清理，避免"清理后重新拉取"丢失新的在途请求。
- `/antigravity/api/status` 改用导出的 `ANTIGRAVITY_QUOTA_CACHE_TTL_MS`，不再内联 120000。
- 移除 Antigravity 设置页与输入框配额胶囊里重复的 `POST /quota`：Host 在 `/status` 中已经会刷新过期缓存，客户端再发一次会让单次挂载产生 2–4 次上游配额请求；配额空态改为明确提示（新增 `quotaEmpty` / `googleValidation` 文案，不再硬编码中文）。
- `parseEnvProxy` 新增 `envFile` 注入点：`$DSH_HOME/.env` 兜底代理探测现在有测试覆盖（含 `export` 前缀、引号、注释、空值、环境变量优先），既有"无代理返回 null"的断言也不再依赖运行机器上是否真的存在 `~/.dsh/.env`。
- Antigravity User-Agent 恢复按真实平台填写 `os_type` / `arch`（仍可用 `DSH_ANTIGRAVITY_OS` / `DSH_ANTIGRAVITY_ARCH` 覆盖），不再默认冒充 darwin/arm64。
- 移除未被引用的 `SANDBOX_ENDPOINT` 并修正端点注释；DSH 依赖区间末项由 `^0.1.5` 改为 `^0.1.5-rc.1`（`^0.1.5` 不匹配本地实际依赖 0.1.5-rc.1），并同步了长期滞后的 `package-lock.json` 根信息。

## 0.2.12 - 2026-09-10

- Antigravity 登录与开通：对齐官方 2.8.0 User-Agent 格式并支持环境变量覆盖，新增 `loadCodeAssist` 详情解析、免费层资格校验与 Google 账号安全验证链接提取，以及新账号的 `onboardUser` LRO 轮询开通。
- Antigravity 配额：`/status` 按 2 分钟 TTL 自动拉取配额，`/quota` 支持强制刷新并在并发调用间去重；Web 设置页与输入框配额胶囊自动获取配额，不再需要手动刷新。
- 代理：`auto` 模式在进程环境之外新增 `$DSH_HOME/.env` 兜底探测。
- 依赖：`@deepseek-ai/*` peer/dev 版本区间扩展到 `^0.1.3` / `^0.1.4` / `^0.1.5`。

## 0.2.10 - 2026-09-06

- 修复 Antigravity 模型元数据校验失败导致 Provider 整体消失的问题：在 `resolveModel` 中清洗并安全兜底 `defaultEffort`，确保透传给 DSH 内核的 `defaultEffort` 必定存在于当前模型的 `efforts` 清单内；解决 `gemini-3.1-pro` 等模型（仅支持 `low` / `high`）因默认回退 `medium` 触发 `@deepseek-ai/dsh-llm` 的 `INVALID_MODEL_REASONING` 校验异常导致 Provider 从模型选择列表中消失的问题（Issue #4）。

## 0.2.9 - 2026-09-06

- 修复在官方 DSH 0.1.2-rc.1 / dsh-llm 0.1.2-rc.1 上加载失败问题：移除 Antigravity 模块中对 `CallId` 的静态具名导入，统一采用 `toToolCallId` 兼容垫片，动态兼容 `ToolCallId` 与 `CallId`；解决启动（boot）阶段因缺失 `CallId` 导出抛出 SyntaxError 导致插件整树无法加载的问题（Issue #4）。
- 修复搜索与抓取来源切换未生效：正确更新 Loader 配置，并在 DSH web 服务重载时重新注册后端、保留默认来源；解决启用插件抓取后仍由 DSH 内置 fetch 拦截 TUN/Fake-IP 地址的问题。
- 修复 Antigravity 工具调用：原样回传 Google 工具 ID，兼容旧会话保存的原始 ID；转换工具参数 Schema，过滤 `propertyNames` 等不支持字段并处理嵌套结构。
- 修复 Gemini 3.7 / 3.8 的旧 `off` / `none` 思考配置，使用最低支持档位 `LOW` 并关闭思考摘要；400 请求错误直接保留原始详情，不再被模型降级错误覆盖。
- Codex 订阅供应商新增 `gpt-6-astra`（6 Astra），支持文本、图片、工具调用和 `low` 至 `max` 思考档位，默认 `medium`；旧会话的 `none` / `minimal` 转为 `low`。
- 新增 Astra 上下文设置：默认 272K，订阅侧最高 872K，界面与服务端统一校验；保留已有模型选择与上下文配置。

## 0.1.28 - 2026-08-28

- 新增支持 1.5x 倍速快速模式（Fast Mode / Priority Service Tier）：在设置页「增强功能」中提供开关，开启后向 Codex 后端请求自动注入 `service_tier: 'priority'`，以约 2x–2.5x 额度消耗换取约 1.5 倍的 Token 生成速度。
- 修复偏好设置更新白名单校验，支持持久化保存 `fastMode` 配置。

## 0.1.21 - 2026-08-22

- 修复 DSH 更新到 `0.1.1-rc.2` 后“本轮运行失败：registration.adapter.prepareCall is not a function”：新代理循环经 `ctx.llm.prepareCall()` 冻结每次调用，适配器必须实现 `prepareCall`；CodexChatGptAdapter 现显式绑定同一次解析的模型元数据与流分发（`PreparedAdapterCall`）。
- 将全部 `@deepseek-ai/*` peerDependencies 与 devDependencies 版本统一从 `^0.1.1-rc.1` 提升至 `^0.1.1-rc.2`，并重新生成 package-lock.json。
- 增强文件完整性与编码防御：确保 `package.json` 及全部工程文件均为无 BOM 的 UTF-8 编码，新增 `test/package-integrity.test.ts` 自动化防范 UTF-8 BOM 引入与依赖一致性。已在本机 rc.2 依赖集上验证：typecheck、69 项测试与 tsdown 构建全部通过。

## 0.1.20 - 2026-08-22

- 新增独立的“子代理”设置页；模型、思考深度和上下文预算改为所有 DSH 内置子代理的全局设置，不再要求父 Agent 使用 Codex 模型。
- 新增全局 0–3 最大嵌套深度和每个父 Agent 子树的活动子代理数量上限；新委派即时受限，现有运行不被中断。
- 子代理设置扩展为 DSH 全部已接入 Provider/模型；思考深度使用所选模型的真实 reasoning effort 目录，上下文在选定模型后展开并作为子 Agent 的有效压缩预算。
- 设置页新增 GPT-5.6 Sol / Terra / Luna 有效上下文窗口配置：默认 272K，可选最高 1M，并动态影响 DSH 的模型解析、压缩阈值与溢出判断。

## 0.1.12 - 2026-08-20

- 适配 DSH `0.1.0-rc.8`：peerDependencies / devDependencies 中全部 DSH 包范围从 `^0.1.0-rc.6` 提升至 `^0.1.0-rc.8`，并重新生成 package-lock.json。已在本机 rc.8 依赖集上验证：typecheck、55 项测试与 tsdown 构建全部通过，插件代码无需改动。
- 移除已无引用的 `@deepseek-ai/dsh-agent` peer 依赖（子代理报告去重兼容模块已于 0.1.11 移除）。
- 新增 `@deepseek-ai/dsh-client-connection` peer 依赖（客户端 `ContentBlock` 类型来源，符合 rc.8 客户端包 peer 声明惯例）。
- 说明：rc.8 中 `@deepseek-ai/dsh-client-ui-slots` 不再是 DSH 运行时依赖图成员（仅保留为各客户端包的 devDependency），插件继续将其声明为 peer 依赖以保证安装时解析（`^0.1.0-rc.6` 联网安装时解析到 rc.8；本地锁文件因离线环境暂固定 rc.7，API 与 rc.8 用法一致）。