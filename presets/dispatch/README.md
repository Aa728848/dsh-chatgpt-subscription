# 调度模式（dispatch）

基于内置 `ptc` preset 的调度 Agent。工具面与 PTC 模式完全一致（`run_code` 呈现），
改变的是**身份与流程纪律**。

## 运行骨架

```
分诊(Triage) → 澄清访谈(Grill) → 规划(Plan) → 派发(Dispatch) → 审查(Review) → 验收(Accept) → 文档(Docs)
     │              │
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

## 刻意不配置的项

- `tool-subagent.config.agentOptions` — 硬绑 `provider`/`model` 会架空 R2。
- `tool-subagent.config.persona` — 会给所有子代理强行打同一角色，违反 R4。
