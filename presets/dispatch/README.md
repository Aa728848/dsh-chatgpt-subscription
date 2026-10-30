# 调度模式（dispatch）

基于内置 `ptc` preset 的调度 Agent。工具面与 PTC 模式完全一致（`run_code` 呈现），
改变的是**身份与流程纪律**。

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
- **L2 复杂/多步** — 必须访谈 → 完整规划 → 多子代理并行 → 分层验收。

## 规则速览

| 编号 | 内容 |
|---|---|
| R0 | 先分诊，按复杂度决定是否编排；绝不为 L0/L1 开启访谈或多代理 |
| R0.5 | 兼容性闸门（每个新会话一次）：检测到 Agent Teams 就**停**并把选择交给用户——本模式与 team 不兼容，没有降级路径 |
| R-G | L2 规划前必须做澄清访谈：设计树 / 前沿 / 轮次，每题给推荐答案，事实自己查、决策交用户，前沿为空且用户确认后才进入规划 |
| R1 | 仅 L2：主代理只做规划/派发/审查/验收/文档/兜底 |
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
`modelSelection: true` 会采样该设置并在运行时把子代理路由限制在勾选清单内；
未开启时模型仍可传路由参数，但会直接报错。

> **`modelSelection` 必须与 `modelDiscovery` 成对写入 preset 行。** harness 0.2.1-rc.1 把旧的
> `modelSelectionSettings` 拆成两个键：`modelSelection` 才暴露 `provider`/`model` 参数，
> `modelDiscovery` 才注册 `list_subagent_models`，两者默认都是 false，且不再互相隐含。
> 漏掉任一个都会让本模式变成哑的：守卫（默认开）要求显式路由，而工具不接受路由参数、
> 也没有发现工具可查——两条路一起堵死，模型连清单都拿不到。

被拒绝时，理由里会直接列出授权路由，并提示调用 `list_subagent_models` 查看各模型的能力与
推理强度——该工具由 `modelDiscovery: true` 注册，且其可见范围恰好被限制在你勾选的
清单内。为消除上游工具自带英文说明（`"Catalog membership is advisory"`、`"Child LLM selection is optional..."`）与需要两步调用的盲区，本插件在运行时做了双重机制级增强：① 通过 `system-prompt/assemble` 原位重写 `list_subagent_models` 与 `subagent` 的工具描述（覆盖 PTC `tools:sdk` 与 Native 工具定义），直接写明强制显式路由与本会话允许清单；② 通过 `tools/post-execute` 在每次 `list_subagent_models` 返回末尾直接附上本会话全部已授权的 `{ provider, model }` 拆解对。R2 与 `plan-mode` 提示词也同步写明 `list_subagent_models` 是允许清单的**唯一真源**，直接采信其输出即可，无需仅为了确认哪些子代理模型可用去翻本地配置或代码（Anti-Pattern 16）。


## 已知边界

**与 Agent Teams 不兼容（刻意互斥）**：`@deepseek-ai/dsh-experimental-agent-team-profile`
被组合进会话时，team 的 scoped 注册会顶替 `send_message` / `list_agents` / `interrupt_agent`，
而 `tryMembership` 让 Lead 从第一轮起就是 team 成员——也就是**派发之前**协调工具已经没了。
本模式因此不提供降级路径：persona 的 R0.5 会停下并用 `ask_user_question` 把三条出路交给用户
（关掉 bundle 后重启并新建会话 / 换 preset / 本次直接做）。详见根 `README.md` 的同名小节。

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
| `agent.cordis.yml` 的 `plan-mode` section | 2627 字符（约 660 tokens） | 309 字符（一句话，保留五条护栏） | 计划模式期间**每一步**都渲染 |
| `enter_plan_mode` / `leave_plan_mode` 工具描述 | 772 / 424 字符 | ≤ 380 / ≤ 220 字符 | 常驻（随每一步的工具表重发） |
| `enter_plan_mode` 的返回文本 | 约 400 字符 | ≤ 1400 字符 | **末尾追加**，不破坏前缀 |

- **section 压成一句话**：它同时是**用户手动 `/plan` 那条路径上唯一的护栏**（那条路没有工具返回
  兜底），所以五条规则原样留在句子里——留在计划模式直到经 `exit_plan_mode` 提交计划；「去实现」
  按「去规划」处理；对话里的确认只是一个设计决定，不是批准计划；只读探索（不改文件、不跑会重写
  已跟踪文件的命令）；批准前不实施。
- **只读与「批准前不实施」为什么留在 section 而不是只搬去工具返回**：`enter_plan_mode` 的返回里
  确实有这两条，但那条返回只有模型调用工具时才会出现。而用户手动 `/plan` 是 R9 写明的**显式降级入口**
  （旧代 harness 没有 `enter_plan_mode`，或 `planModePipeline` 开关关闭），那条路上永远没有
  工具返回。只把这两条放在返回里，等于把用户送上一条没有「不许写文件」提示的路。所以 section 保留
  一份压缩副本，长度预算从 ≤220 放宽到 **≤360**：多付约 105 字符（≈26 tokens），且只在计划模式
  期间渲染。
- **详细指引搬进工具返回**：只读探索的完整版（不改文件、不跑会重写工作区文件的命令）、decision-complete
  计划清单、`exit_plan_mode` 是该轮唯一且最后的调用、被打回则按反馈修订后再呈交、批准前不实施
  不派发，都写在 `enter_plan_mode` 的返回里。工具结果是末尾追加，不改变已发前缀，所以这份详细
  指引只付一次，进入之后的每一步都还能看到它。
- **工具描述只留判定条件**：能不能调用（仅调度模式、仅 L2 且 R-G 已收敛、本步只完成进入、L0/L1
  或访谈未收敛时不得调用）留在描述里，其余交给 persona 的 R9——persona 反正常驻，搬过去不增加
  新的常驻成本。

## 刻意不配置的项

- `tool-subagent.config.agentOptions` — 硬绑 `provider`/`model` 会架空 R2。
- `tool-subagent.config.persona` — 会给所有子代理强行打同一角色，违反 R4。