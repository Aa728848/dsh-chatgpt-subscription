# 调度模式（dispatch）

基于 **Code Mode** 的调度 Agent：本预设自己注册的工具保持原生可调（schema 不变），
预设清单以外的一切（MCP 服务端工具、profile 级插件工具、按 agent 注册的工具集）不进入模型
上下文，只能在 `code_run` 程序里用 `code_tools_search` 现查现调。改变的是**身份与流程纪律**。

> 内核的 `ptc` 呈现方式只把 `run_code` 交给模型、其余名字一律硬拒，`standard` 又完全没有程序
> 传输；「原生工具 + 程序」这个组合在内核里表达不出来，所以本预设自带一行 `code-mode`
> （`@eddyskywalker/dsh-chatgpt-subscription/codemode`）。代次上不可用原生 executor 时，
> `resolveDispatchPreset` 会自动退回 PTC 呈现（见 `src/host/agent-preset.ts`）。

> **缓存前提**：Code Mode 的说明段是**恒定文本**（不含任何遮蔽计数或 namespace 清单），
> 加上既有的 `ptc-sdk-cache-guard`，kimi-code / minimax-code 的前缀缓存不因 MCP 增删而失效。

## 运行骨架

```
分诊(Triage) → 澄清访谈(Grill) → 计划模式(Plan Mode) → 规划(Plan) → 审批(Approve) → 派发(Dispatch) → 审查(Review) → 验收(Accept) → 文档(Docs)
     │              │                    │
     │              │                    └─ R9：只读探索与 decision-complete 计划都在计划模式内写，exit_plan_mode 是唯一审批出口
     │              └─ 仅 L2 强制；L1 轻量；L0 跳过
     └─ R0：判定 L0 / L1 / L2，决定后面阶段是否展开
```

- **L0 简单/单点** — 不派子代理、不访谈，主代理直接做完。
- **L1 中等** — 最多 1–2 个关键问题 → 简短规划 → 主代理执行或派 1 个子代理。
- **L2 复杂/多步** — 必须访谈 → 完整规划审批 → 按耦合度与并行收益选执行拓扑（`Lead-Core` 主干直执 / `Hybrid` 主干自持+边缘外包 / `Fan-out` 多子代理并行） → 严格验收。

## 规则速览

| 编号 | 内容 |
|---|---|
| R0 | 先分诊，按复杂度决定是否展开重治理流程；绝不为 L0/L1 开启完整访谈或计划模式 |
| R0.5 | 兼容性闸门（每个新会话一次）：判据**只有** `spawn_teammate` 是否在场——在场才说明跑的是旧代 team 运行时（它顶替协调工具），此时停下交用户决策；现行 team 只加共享任务板，与调度并行 |
| R-G | L2 规划前必须做澄清访谈：设计树 / 前沿 / 轮次，每题给推荐答案，事实自己查、决策交用户，前沿为空且用户确认后才进入规划 |
| R1 | L2 执行拓扑按「耦合度 × 并行收益」三选一：`Lead-Core`（紧耦合跨模块由主代理连续直执）、`Hybrid`（主代理先冻结公共契约再并行外包下游）、`Fan-out`（3+ 正交子任务并行编排）；单次生图、改提示词和重试由当前代理直接调用工具，只有独立多方案或更复杂创意任务才委派 |
| R2 | 允许清单唯一真源是 `list_subagent_models`（`{}` → `{ provider }`）；派发必须显式给出拆开的 `provider` 与 `model`，直接采信工具返回值，无需去翻本地配置或代码核对 |
| R3 | 子代理对自己的模块拥有规划/执行/自检自治权 |
| R4 | 子代理使用 DSH 默认子代理角色；选模型的权力只在主代理 |
| R5 | 任务书含目标/边界/约束/验收标准/证据；独立任务并行派发 |
| R6 | 子代理自检 → 主代理复审；验收落到证据；不通过就带证据重新派发，同一任务书最多两次 |
| R7 | 主代理维护任务清单、决策记录与访谈结论 |
| R8 | 兜底需说明原因；**任务级、非会话级**——只覆盖触发它的那一个任务，下一个任务按 R0 重新分诊并恢复派发 |
| R-W | 回合边界纪律：等待靠完成通知而非 sleep/轮询；不主动建目标（清单走 `todo_write`）；需要拍板一律用提问工具 |
| R9 | 计划模式管线：仅 L2 且 R-G 已收敛（前沿为空 + 用户明确确认）时立刻 `enter_plan_mode`；进入这一步只完成进入，下一步才做只读探索并在计划模式内写出 decision-complete 计划，`exit_plan_mode` 是该轮唯一且最后的调用；打回（Keep planning）= 按反馈修订后再呈交，放弃计划须用户明确表示并带 reason 调 `leave_plan_mode`（它不是审批出口）；旧代或开关关闭时降级为用一次 `ask_user_question` 请用户输入 `/plan` |

## 回合边界（R-W）

`R-W` 管三件都落在回合边界上的事：

- **等待靠通知，不靠命令** — 派完子代理后默认结束本轮回复，由完成通知唤醒主代理；
  禁止 `sleep`、轮询循环和任何只为占位存在的长命令。确实被阻塞时才用
  `job_output({ wait: true })` 有界地等一次。
- **不主动建目标** — 除非用户明确要求，否则不调用 `create_goal` / `/goal`，任务清单一律走
  `todo_write`。原因是机制性的：目标激活后 DSH 会自动续跑唤醒主代理，而子代理何时返回不由它
  控制，等待会被从中间劈开，还要为每次续跑重载整段历史。
- **需要拍板就用提问工具** — 凡是「我停在这里是因为缺一个决定」的停点（收到子代理结果要选下一步、
  验收不过要定返工范围、前提被推翻要改计划）都用 `ask_user_question` 递出去，而不是用一段文字结尾
  然后等用户回话。例外是 plan mode 的计划审批（走 `exit_plan_mode`）与任务完成后的收尾。

## 依赖的设置

**DSH 设置 → 子代理 → 允许 Agent 为 Subagent 选择模型** 必须开启，并至少勾选一个模型
（即右上角开关打开 + 清单里勾选）。这是 R2 生效的运行时前提：`tool-subagent` 的
`modelSelection: true` 会采样该设置并在运行时把子代理路由限制在勾选清单内。
未开启时没有 Session allowlist；DSH 0.2.2 仍可能把显式选择限制为父路由，不能把它
理解为任意路由均可用。

> **`modelSelection` 必须与 `modelDiscovery` 成对写入 preset 行。** harness 0.2.1-rc.1 把旧的
> `modelSelectionSettings` 拆成两个键：`modelSelection` 才暴露 `provider`/`model` 参数，
> `modelDiscovery` 才注册 `list_subagent_models`，两者默认都是 false，且不再互相隐含。
> 漏掉任一个都会让本模式变成哑的：守卫（默认开）要求显式路由，而工具不接受路由参数、
> 也没有发现工具可查——两条路一起堵死，模型连清单都拿不到。

被拒绝时，理由里会直接列出授权路由，并提示调用 `list_subagent_models` 查看各模型的能力与
推理强度——该工具由 `modelDiscovery: true` 注册，且其可见范围恰好被限制在你勾选的
清单内。为消除上游工具自带英文说明（`"Catalog membership is advisory"`、`"Child LLM selection is optional..."`）与需要两步调用的盲区，本插件在运行时做了双重机制级增强：① 通过 `system-prompt/assemble` 原位重写 `list_subagent_models` 与 `subagent` 的工具描述（覆盖 PTC `tools:sdk` 与 Native 工具定义），直接写明强制显式路由与本会话允许清单；② 通过 `tools/post-execute` 在每次 `list_subagent_models` 返回末尾直接附上本会话全部已授权的 `{ provider, model }` 拆解对。R2 与 `plan-mode` 提示词也同步写明 `list_subagent_models` 是允许清单的**唯一真源**，直接采信其输出即可，无需仅为了确认哪些子代理模型可用去翻本地配置或代码（Anti-Pattern 16）。


## 已知边界

**与 Agent Teams 的关系按代划分**：Agent Teams 的**旧代**运行时自己拥有队友创建与消息通道
（注册 `spawn_teammate`，并用 team 作用域注册顶替 `send_message` / `list_agents` / `interrupt_agent`），
派发出来的子代理对它不可见、也联系不上——这一代与调度模式互斥，本模式不提供降级路径：
persona 的 R0.5 会停下并用 `ask_user_question` 把三条出路交给用户（关掉 team 后重启并新建会话 / 换 preset / 本次直接做）。

**现行**运行时（harness 0.2.2 起）已改为共享子代理语义：它只注册共享任务板
`team_task_create` / `team_task_list` / `team_task_get` / `team_task_update` 和一段自己的 policy，
消息与名册全部复用本模式挂载的 `list_agents` / `send_message` / `wait_agent` / `interrupt_agent`
（它自己的 policy 就写着"任务归属人是 `list_agents` 的 agent id、要人动手就 `send_message`"）。
因此调度模式与它**并行运行**：任务板只是可选的共同记账，绝不替代 R1 拓扑、R2 路由、R5 任务书、
R6 验收与 R-W 等待；R0.5 只靠 `spawn_teammate` 判代，**不能**用 `wait_agent` / `send_message` /
`list_agents` / `interrupt_agent` 判——这些工具是本模式自己挂的，在场不能证明任何 team 状态。

开关打开时两套记账的分工是固定的：`dispatch_ledger` 仍是派发权威、R5 任务书仍是任务契约；团队任务板
只用来公开跨代理的依赖（`blocked_by`）与写作用域，一条 brief 对应一条 task，由拿到它的子代理自己
claim/complete。任务 ready 不等于开工，也不许用 `reassign` 把任务挪走以绕开 R6 验收。R0.5 在缺席判据
下会先写一行 `Orchestration ready: subagent`，把当前模式打在第一行。

**缓存侧的两个注意点**：Code Mode 下 `team_task_*` 属于全局层工具，只存在于 `code_run` 程序清单里（旧代回退 PTC 时则在冻结的 `tools:sdk` 里常驻可见）——无论哪种呈现，在清单里存在都不等于开关已打开，要以在 `code_run` 内调用 `team_task_list` 能否调通为准。反过来，开关本身会让 `team:policy` 段从空串变成整段文本，
system prompt 因此改写一次；这与计划模式当初刻意用"尾部用户消息"规避的是同一类重建，只是这段文本
由 harness 拥有。建议在**首个回合之前**决定 team 开关：开会话时就是目标状态则零成本，中途切换付一次前缀重建。
插件默认开启的 `teamPolicyCacheGuard` 让这唯一一次重建也消失：守卫把 `team:policy` 段从装配里
摘掉并捕获原文，切开关时改用尾部用户消息投递一次，关闭时补一条撤销通知——与计划模式同一套做法。

本进程内 spawn 的子代理**继承父代理的 preset 组成**（同一套工具、同一套提示词段落）。
因此子代理读到的是同一份 persona；文件开头的【角色识别】段落要求它据「首条消息是否为任务书」
自判身份，从而不套用面向调度者的 R0/R-G/R1/R2/R4/R5。若需要真正的子代理专属提示词，
需要在 DSH 侧扩展（`tool-subagent` 的 `persona` 只能整段覆盖，不适用于此）。

**计划模式管线的工具作用域 = preset 行**：`enter_plan_mode` / `leave_plan_mode` 由
`plan-mode-pipeline` 这一行在 `planning` 隔离组内注册（与 `plan-mode` 同一个 realm，排在其后），
所以它们只属于挂载了本 preset 的会话。换用其它 preset 的会话拿不到这两个工具，R9 在那里也无从执行。

**子代理不进入计划模式**：子代理由本会话 spawn，因此继承同一份 preset 组成，`enter_plan_mode` /
`leave_plan_mode` 在它的工具列表里**是可见的**——可见不等于可用。桥接能拦到哪一步取决于 harness 代际：

- **新代（能判定存活根）**——`agents` 服务在场且 `agents.roots()` 可用时，存活子代理的调用会以
  `DELEGATED_CALLER` 被拒（这是该错误码唯一的抛出点）；
- **老代（判不了根）**——`agents` 缺失，或有 `agents` 但 `roots` 不是函数时，桥接只判存活、判不了根
  就**放行**，子代理的调用会真的切换它自己的计划模式。

所以**不要依赖这道拒绝**：子代理无论如何都不得自行进入计划模式、也不得提交计划，必须把未决决定
——包括「要不要进入计划模式」这个请求——带回调度者，由调度者走 R9；persona 的 R9 段末有一条同名条款
钉住这件事。任务书里不要要求子代理「进入计划模式」，它是执行者，只按任务书干活并回报证据。

**旧代 harness 或开关关闭时降级**：工具列表里没有 `enter_plan_mode`（插件不支持该行的旧代 harness，
或 `planModePipeline` 开关关闭导致该行不注册工具）时，退化路径是用一次 `ask_user_question` 请用户手动
输入 `/plan`，然后按已配置的 `plan-mode` section 继续；不得把计划直接贴在普通回复里代替审批。

## 缓存成本与两处压缩

Kimi 线路按请求内容前缀命中缓存：**同一会话内 system 段或工具列表一变，整个前缀缓存归零**
（见根 `README.md`）。「进入计划模式」这一步两样都会变——`plan-mode` 的 section 换新，
`exit_plan_mode` 第一次进入工具表——所以这一次重建**无法避免**，换任何写法都躲不掉。

能压的只有**重建之后每一步都还要重发的字节**。于是做了两处压缩：

| 位置 | 改前 | 改后 | 性质 |
|---|---|---|---|
| `agent.cordis.yml` 的 `plan-mode` section | 2627 字符（约 660 tokens），每步渲染 | 完整四段指引（约 3199 字符），**一次性投递** | **末尾追加**，不破坏前缀 |
| `enter_plan_mode` / `leave_plan_mode` 工具描述 | 772 / 424 字符 | ≤ 380 / ≤ 220 字符 | 常驻（随每一步的工具表重发） |
| `enter_plan_mode` 的返回文本 | 约 400 字符 | ≤ 1400 字符 | **末尾追加**，不破坏前缀 |

- **section 不再压成一句话**：本插件 fork 了 harness 的 plan-mode 服务，section **不再渲染进
  `systemPrompt`**，而是作为一条**尾部用户消息**在进入计划模式时投一次（`src/entry-plan-mode.ts`）。
  末尾追加不破坏已发前缀，所以这份完整指引只付一次输入费，之后每一步都还在历史里。
- **为什么仍然保留完整四段**：它同时是**用户手动 `/plan` 那条路径上唯一的护栏**（那条路没有工具返回
  兜底），所以五条规则原样保留——留在计划模式直到经 `exit_plan_mode` 提交计划；「去实现」
  按「去规划」处理；对话里的确认只是一个设计决定，不是批准计划；只读探索（不改文件、不跑会重写
  已跟踪文件的命令）；批准前不实施。
- **section 的长度不再是每步成本**：既然它只在进入时投一次，它的体积就不再是「计划模式期间每一步
  都重发」的常驻字节，因此**不再有 ≤360 之类的每步预算**；它占用的是 preset 行本身的体积，与
  persona 的 18500 字符预算无关。契约测试盯住的是 persona 前缀的预算，不是 section 的。
- **详细指引搬进工具返回**：只读探索的完整版（不改文件、不跑会重写工作区文件的命令）、decision-complete
  计划清单、`exit_plan_mode` 是该轮唯一且最后的调用、被打回则按反馈修订后再呈交、批准前不实施
  不派发，都写在 `enter_plan_mode` 的返回里。工具结果是末尾追加，不改变已发前缀，所以这份详细
  指引只付一次，进入之后的每一步都还能看到它。
- **工具描述只留判定条件**：能不能调用（仅调度模式、仅 L2 且 R-G 已收敛、本步只完成进入、L0/L1
  或访谈未收敛时不得调用）留在描述里，其余交给 persona 的 R9——persona 反正常驻，搬过去不增加
  新的常驻成本。

## Dispatch Ledger 与 Mandate 协议

调度模式多了一个只读工具 `dispatch_ledger`：它记下每一次委派的运行（工作项 / 运行 / 幂等键），
用来防重、验所有权、留血缘。它**不派发、也不写账本**——账本是会话日志的**只读折叠视图**（首版没有登记 session projection，折叠直接读会话日志）。

preset 的 persona 为此只加**一行**短引导：首次委派前调用一次 `dispatch_ledger {action:"self"}`，
并按该次结果**尾部**打印的 v2 协议行事。

### 怎么用

1. **首次委派前**调用一次 `dispatch_ledger {action:"self"}`。这次返回的**尾部**就是
   **Mandate v2 协议正文**：字段说明、流程与拒绝码全在里面。
2. **优先照抄 `self` 给出的那一段**：结果里、协议正文之前有一块"复制即可"的头部——
   协调者拿到的是 dispatch 骨架（`policy` 与 `prompt_ref` 已填好，三个 id 每次渲染现造），
   子代理拿到的是**自己那份 mandate 的 report 头**（ids 已经填好，只差 `status`）。
   骨架生成后先用真解析器自检，判不出 `ok` 就不打印，所以它永远是合法头部。
3. 手写也行，但**每个 kind 只带自己的字段**：`dispatch` 带 task/boundary/followup/parent_mandate，
   `report` 只带 status，`steer` 只带 grant。多带一个字段就是"抄错了角色"。
4. 头部里的 `policy` 与 `prompt_ref` **原样抄** `self` 的返回——模型不能自拟：策略块抄错会被
   判成 `MANDATE_POLICY_STALE`，修订号抄错会被判成 `MANDATE_VERSION`。
5. 把用不到的字段写成 `null` 与**不写等价**（schema 本来就 nullable）：`"grant":null` 不再是错误。

`dispatch_ledger {action:"ledger"}` 查账本条目：按当前会话或整棵委派树，可按工作项 / 运行 /
幂等键 / 状态过滤。

### 缓存约束

- **协议正文不进 persona**：正文有 4KB 上下（上限 4096 字符），而 persona 的预算是 18500 字符。
  正文按需通过**尾部工具结果**返回，不进入每步常驻的前缀。
- **`dispatch_ledger` 不是 preset 行**：它在宿主**根**注册面上由 `tools.register` 一次性注册，
  是全局静态工具。（所以 preset 里**不要**再加一行挂它的工具行。）
- **工具声明面只在加载 / 升级时变一次**：新增这个全局静态工具本身会改变一次工具声明面——这是
  已接受的一次性成本。除此之外声明面**不随账本状态、开关或任务状态变化**：工具在宿主装配时
  一次性注册，不懒注册、不带 `when` 准入，因此会话运行期间工具表恒定，Kimi Code 的内容前缀
  缓存不会**因为账本**而反复重建。
- **工具描述是编译期常量**：不随会话变化、不随开关变化、不懒注册。会话中途多一个或少一个工具会
  破坏模型的工具记忆，也会让前缀缓存漂移。
- **守卫只走 `ctx.tools.guard()`**：账本的执行期守卫（防重、验所有权）不改工具声明面。
- **开关复用** `dispatchExecutionGuard`，不新增设置项。

### 拒绝码

协议正文里列出的拒绝码就是守卫真的能抛的那些：头部损坏、kind 不对、命名空间重复、工作项被占、
血缘缺失或指错、策略过期、版本不符、不是你的父 / 不是你的子、扩权越界、你不持有这份 Mandate、
账本满了。拿到拒绝就按协议改：命名空间**永不重用**，换一次运行就要同时换新的 `run_id` 与
`idem`，并把 `parent_mandate` 指到被接替的那一次运行。

kind 违规（多带 / 少带字段）的拒绝文案尾部会**直接列出该方向允许携带的字段集**，照它删或补
字段通常一次就过——这正是子代理以前"逐个字段试错四轮"的那一段。

## 刻意不配置的项

- `tool-subagent.config.agentOptions` — 硬绑 `provider`/`model` 会架空 R2。
- `tool-subagent.config.persona` — 会给所有子代理强行打同一角色，违反 R4。