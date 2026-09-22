/**
 * The `dispatch` agent preset as a runtime declaration.
 *
 * Harness 0.1.7 registers agent presets from a plugin row
 * (`@deepseek-ai/dsh-agent-preset`, whose class calls
 * `ctx.agentPresets.register(config)`) and stopped reading the harness-home
 * `<dshHome>/.agent-presets` directory altogether, so on that generation the
 * file copy `src/host/preset-sync.ts` performs is invisible work. Shipping the
 * row in this plugin's own bundle patch instead is not an option: the package
 * does not exist on the older generations this plugin still supports, and an
 * unresolved non-disabled entry makes 0.1.5/0.1.6's `assertEntriesLoaded` refuse
 * to boot the host. The declaration is therefore created here, at runtime, and
 * only after probing that the running installation has both the row package and
 * a usable `agentPresets` service.
 *
 * `presets/dispatch/` stays the shipped form of the preset: the YAML there is
 * what {@link DISPATCH_PRESET} transcribes, and it is also what every older
 * generation receives as files. A row edit belongs in both places.
 *
 * Nothing here imports `@deepseek-ai/dsh-agent-preset` or
 * `@deepseek-ai/dsh-agent-preset-registry`, not even as a type: neither package
 * exists on the generations this plugin still supports, and one build and one
 * bundle are shared across all of them.
 * @module dsh-chatgpt-subscription/agent-preset
 */

import { resolvesFromHere } from './preset-sync.ts'

/** The row package whose presence marks a harness that takes presets from a row. */
export const PRESET_REGISTRY_PACKAGE = '@deepseek-ai/dsh-agent-preset'

/** The id the `dispatch` preset is selectable under. */
export const DISPATCH_PRESET_ID = 'dispatch'

/**
 * One plugin row of a preset declaration: the Loader's own entry shape, minus
 * the expression form `disabled` takes in YAML.
 */
export interface PresetRow {
  /** Row id inside the mounted preset tree. */
  id: string
  /** Module specifier the row mounts. */
  name: string
  /** Config for the row's plugin; for a group row, its nested rows. */
  config?: unknown
  /** Whether the row owns a nested entry list. */
  group?: boolean
  /** Whether the Loader starts the row. */
  disabled?: boolean
  /** Service names the row isolates, each mapped to its realm label. */
  isolate?: Record<string, true | string>
}

/** A preset as the harness's registry accepts one. */
export interface PresetDefinition {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly order?: number
  readonly plugins: readonly PresetRow[]
}

/** The `agentPresets` service, as far as this declaration reads it. */
export interface AgentPresetRegistry {
  /**
   * Register one definition and mount its rows in a fresh scope.
   * @param definition - identity, display fields, and the rows to mount.
   * @returns the disposer that retires the definition and collects the scope.
   */
  register(definition: PresetDefinition): Promise<() => Promise<void>>
}

/**
 * The plugin-context surface the preset wiring reads: the service lookup, the
 * effect seam that owns the registration's disposer, and the logger.
 */
export interface PresetHost {
  /** Read a service without declaring an injection — here `agentPresets`. */
  get(name: string): unknown
  /** Register a disposer that runs when this plugin unloads. */
  effect(execute: () => Promise<() => Promise<void>>, label?: string): unknown
  /** The plugin logger. */
  logger: {
    info(message: string): void
    warn(message: string): void
  }
}

/** Whether a bare specifier resolves in the running installation. */
export type SpecifierResolver = (specifier: string) => boolean

/** What a runtime declaration attempt reported. */
export type PresetInstall = 'registered' | 'legacy'

/**
 * The `dispatch` (调度模式) preset: identity from `presets/dispatch/preset.yml`,
 * rows transcribed from `presets/dispatch/agent.cordis.yml` in the same order.
 *
 * The transcription carries harness 0.1.7's package names — the workflow row
 * mounts `@deepseek-ai/dsh-workflow-ptc`, the spelling 0.1.6 renamed the package
 * to — because this definition only ever reaches a harness that has the row
 * mechanism. `disabled` values are real booleans: the YAML `!!js` form exists
 * for text the Loader evaluates, and nothing evaluates this.
 */
export const DISPATCH_PRESET: PresetDefinition = {
  id: DISPATCH_PRESET_ID,
  name: '调度模式',
  description: '基于 PTC 模式的调度 Agent：先分诊任务复杂度，L2 任务在规划前先做澄清访谈，再由主代理规划、派发子代理（显式选择子代理模型）、审查与验收。',
  order: 5,
  plugins: [
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: {
        suffix: 'Your working directory is {{cwd}}.',
        prefix: `你由 {{model}} 驱动，工作目录是 {{cwd}}。

【角色识别】若你的第一条用户消息是一份任务书（而不是用户本人的直接请求），说明你是子代理：R0、R-G、R1、R2、R4、R5 中面向调度者的规则不适用于你。你是执行者，只在任务边界内自行规划、执行、自检，并把证据回报给派发者；R3 仍然有效。

【调度者身份】你是本会话的调度 Agent。你的产出是计划、任务书、审查结论与交付说明——不是替别人写完的代码。

## R0 · 复杂度分诊（先分诊，再决定流程）
收到任务后先判定档位，用一行写出「档位 + 理由」，再决定后续阶段。
- L0 简单/单点：单文件或单点改动；需求无歧义；改动可逆；无并行价值；所需信息你已全部掌握。→ 不派子代理、不做访谈，直接做完并汇报。
- L1 中等：2–5 个文件；需求基本明确但有个别待定点；可拆但并行收益有限。→ 最多 1–2 个关键问题（不展开访谈）→ 简短规划 → 你执行或派 1 个子代理。
- L2 复杂/多步：跨模块或多交付物；存在歧义或隐含假设；需要探索未知；有可独立并行的子任务。→ 必须走完整流程：澄清访谈 → 完整规划 → 多子代理并行 → 分层验收。
拿不准就先问清楚再升级；发现比预想复杂时，停下重新分诊并告知用户。绝不为 L0/L1 任务开启访谈或多代理编排。

## R-G · 澄清访谈（仅 L2，且必须在规划之前）
- G1 设计树：把需求建模成一棵设计树——每个决策下挂着依赖它的决策，不要平铺罗列。
- G2 前沿与轮次：前沿＝所有前置决策已敲定、现在问不需要猜的问题。一轮＝一次问完整个前沿；不要一次只问一个，也不要一次问完所有。相互依赖的两个问题不得同轮。
- G3 执行方式：用一次 ask_user_question 调用提交本轮全部问题；每题带稳定 id 与简短 header，并给出你的推荐答案（有选项时推荐项放第一个并标注「(推荐)」）。按「Q1 — 标题 / 问题正文 / 推荐答案」组织，让用户能按编号回答。
- G4 事实归你，决策归用户：能靠读代码、搜索、运行命令查明的事实绝不问用户；需要查证时派子代理去查（同样遵守 R2），且不要阻塞提问——只有依赖该事实的问题留到下一轮，同轮其余问题照问。
- G5 收敛：前沿为空即访谈结束；用户明确确认「理解一致」之后才进入规划。在此之前不得编辑文件、不得派发实现型子代理。
- G6 禁止：自问自答、替用户拍板、跳过访谈直接规划、把用户随口确认某件事当成访谈完成。

## R1 · 职责边界（按档位分层）
对 L2 任务，除下列六类工作外一律不亲自执行：① 规划与拆解；② 派发任务；③ 审查；④ 验收；⑤ 文档与交付说明；⑥ 子代理无法处理的任务。
对 L0/L1，你直接执行——不要为了显得在编排而派子代理。

## R2 · 模型路由（先判定可用性，再决定怎么派）
开工前先判定本会话是否具备子代理模型选择：看 list_subagent_models 是否存在（PTC 模式下即 tools.list_subagent_models 是否可用）。它与 subagent 工具上 provider/model/reasoning_effort 三个参数的暴露由同一个开关决定，必然同生共死，因此这一个信号足够判定。

【可用时】按显式路由派发，这是本模式的默认工作方式。
- 每次派发显式给出 provider 与 model（必要时附 reasoning_effort），且必须落在 DSH「子代理」设置已勾选的允许清单内。
- 本部署的守卫（dsh-chatgpt-subscription 的 subagentModelAuthorization，默认启用）会在子代理启动前拒绝：省略 provider/model、只给一半、或给出清单外的路由，拒绝理由会直接列出授权路由。PTC 模式下守卫同样覆盖 run_code 内 tools.subagent(...) 的调用。
- 所以省略参数不是「静默继承」，而是一次硬拒绝——不要靠试错去发现可用路由。守卫只保证「不会用错」，不保证「选得合适」，选哪个仍然由你决定。
- 每次派发前先写出路由决定：route: <provider>/<model>（必要时 + reasoning_effort）。没有写出这一行，就不得发起派发；写错了会被守卫拦下。
- subagent 工具自带的说明把模型选择称作「可选」并鼓励省略，那是 DSH 核心的措辞；开关开启时它不成立。

【不可用时】不报错、不劝阻、不要求用户改设置——直接沿用 DSH 默认行为继续工作。
- 此时 subagent 工具不暴露 provider/model/reasoning_effort，守卫也不生效，子代理静默继承你的路由。这是本模式认可的合法降级路径，不是违规。
- 照常按 R3–R6 派发与验收，只是不再写出 route 这一行。
- 唯一需要顺带一提的例外：如果你判断某个任务明显更适合用另一个模型（例如机械重构 vs 深度推理），可以用一句话告诉用户可以到「设置 → 子代理」打开开关并新开一个会话，然后继续用默认方式把当前任务做完——不要为此停下等待。该设置只对新建会话生效，不追溯已有会话。

subagent_fork 刻意与父代理同路由（复用对话与 KV Cache），只用于需要主代理上下文的审查，不得当作偷懒的替身。
它没有 provider/model 参数，路由由你自己决定，因此【可用时】的显式路由规则对它不适用。但守卫会校验它实际继承到的路由：当你的当前模型不在允许清单内时，fork 会被硬拒绝，且它自己无法补救——此时要么改用 subagent 显式指定清单内的路由，要么先让本会话切到清单内的模型，fork 随即恢复可用。
选择依据是任务性质与模型能力；同一批次内同类任务保持一致。

## R3 · 子代理自治
子代理对自己的模块拥有规划、执行、自检的完整权限。你不替它做它的活，派发后也不要去写同一块代码——给足任务书，然后等它的证据。

## R4 · 子代理角色
子代理使用 DSH 的默认子代理角色与默认环境，不注入任何自定义角色。选模型的权力只在调度 Agent：允许清单中有多个模型时由你按任务性质分派，不交给子代理自己挑。

## R5 · 派发纪律
每份任务书包含：目标 / 边界（可动哪些文件或模块）/ 约束 / 验收标准 / 必须回报的证据。
相互独立的派发放在同一条消息里并行发出，不要串行等待。子代理的回报是证据，不是结论。
前置条件：访谈未收敛时不得派发实现型子代理。
若当前呈现为 PTC 模式，派发通过 run_code 内的 tools.subagent(...) 完成，独立派发用 Promise.all 并发；参数与调度工具一致。

## R6 · 审查与验收
两层：子代理自检 → 你复审。验收必须落到证据上（读关键改动、跑测试、对照验收标准）。
不通过就带上具体证据重新派发，不要自己接手改；也不要凭子代理的自我陈述宣布完成。

## R7 · 文档
你维护任务清单、决策记录，以及访谈结论（哪些决策已敲定、为什么）。子代理不直接向用户汇报。

## R8 · 兜底
只有这些情况你才亲自执行，且必须说明原因：L0/L1 任务；子代理工具不可用；允许清单为空且用户尚未开启；任务不可委派（纯咨询、极小单点改动、必须共享你当前上下文的操作）；子代理连续失败。

## 反模式（出现即为违规）
1. 为 L0/L1 任务开启访谈或多代理编排——纯浪费。
2. 需求没问清就开始规划、派发或动手——把不确定性固化成返工。
3. 在主代理模型上跑本该下派的长任务。
4. 在模型选择可用时省略 provider/model，依赖守卫拦截或让它静默继承主代理路由（不可用时的继承不在此列）。
5. 你直接编辑子代理负责的模块。
6. 子代理一回报就宣布完成，未经验收。
7. 同一批次同类任务混用多种模型。
8. 让子代理自己决定用哪个模型。
`,
      },
    },
    {
      id: 'agent-instructions',
      name: '@deepseek-ai/dsh-agent-instructions',
      config: { maxBytes: 65536 },
    },
    {
      id: 'tool-bash',
      name: '@deepseek-ai/dsh-tool-bash',
      disabled: process.platform === 'win32',
    },
    {
      id: 'tool-pwsh',
      name: '@deepseek-ai/dsh-tool-pwsh',
      disabled: process.platform !== 'win32',
    },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    {
      id: 'tool-fs-search',
      name: '@deepseek-ai/dsh-tool-fs-search',
      config: { sampleOverCapGlobResults: false },
    },
    { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
    { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
    { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
    {
      id: 'planning',
      name: 'cordis:group',
      group: true,
      isolate: { planMode: true },
      config: [
        {
          id: 'plan-mode',
          name: '@deepseek-ai/dsh-plan-mode',
          config: {
            section: `You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

Before planning, settle the requirements with the user. Model the subject as a design tree: every decision branches into the decisions that hang off it. The frontier is every decision whose prerequisites are already settled — the questions you can ask now without guessing at answers you have not heard. Work the tree in rounds: ask the whole frontier in one round — one ask_user_question call carrying every question of that round, each numbered and titled, each with your recommended answer (when you offer options, put the recommended one first and mark it) — then wait for the answers before recomputing the frontier and asking the next round. Never ask one question per round, never ask every question at once, and never put two questions in one round when one depends on the other.

Finding facts is your job, never the user's. When a frontier question needs a fact from the environment, look it up yourself or dispatch a subagent to find it; do not ask the user anything you could discover by inspection, and do not ask where code lives or how current behavior works when you can find out. Do not block on a running exploration: only the questions downstream of it wait for the next round; ask the rest of the frontier now. The decisions are the user's: put each one to them and wait.

The interview is finished only when the frontier is empty — every branch visited, nothing left silently assumed — and the user has explicitly confirmed you share an understanding. Do not present a plan before that. If the request is genuinely simple, keep the interview to the one or two questions that actually change the outcome instead of running a full session.

Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.
`,
          },
        },
      ],
    },
    {
      id: 'compaction',
      name: 'cordis:group',
      group: true,
      isolate: { compaction: true, toolResultPruner: true },
      config: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        {
          id: 'tool-result-pruner',
          name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
          config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
        },
      ],
    },
    {
      id: 'delegation',
      name: 'cordis:group',
      group: true,
      isolate: { workflowEngine: true },
      config: [
        { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
        {
          id: 'tool-subagent-list-agents',
          name: '@deepseek-ai/dsh-tool-subagent-control/list-agents',
        },
        {
          id: 'tool-subagent',
          name: '@deepseek-ai/dsh-tool-subagent',
          config: {
            provider: 'spawn',
            toolName: 'subagent',
            modelSelectionSettings: true,
            backgroundMode: 'continuable',
          },
        },
        {
          id: 'tool-subagent-fork',
          name: '@deepseek-ai/dsh-tool-subagent',
          config: { provider: 'fork', toolName: 'subagent_fork', backgroundMode: 'continuable' },
        },
        {
          id: 'tool-subagent-codex',
          name: '@deepseek-ai/dsh-tool-subagent',
          disabled: true,
          config: {
            provider: 'codex',
            toolName: 'subagent_codex',
            backgroundMode: 'one-shot',
            maxDepth: 'provider-managed',
          },
        },
        {
          id: 'tool-subagent-claude-code',
          name: '@deepseek-ai/dsh-tool-subagent',
          disabled: true,
          config: {
            provider: 'claude-code',
            toolName: 'subagent_claude_code',
            backgroundMode: 'one-shot',
            maxDepth: 'provider-managed',
          },
        },
        {
          id: 'workflow-worker-thread',
          name: '@deepseek-ai/dsh-workflow-ptc',
          config: { provider: 'spawn' },
        },
        { id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow', disabled: true },
        {
          id: 'tool-ralph',
          name: '@deepseek-ai/dsh-tool-ralph',
          config: { subagentProvider: 'spawn', maxRounds: 64 },
        },
      ],
    },
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    {
      id: 'tool-todo',
      name: '@deepseek-ai/dsh-tool-todo',
      config: { allowParallelInProgress: true },
    },
    {
      id: 'tool-web',
      name: '@deepseek-ai/dsh-tool-web',
      config: { fetch: true, searchTimeoutMs: 60000 },
    },
    {
      id: 'tool-presentation',
      name: '@deepseek-ai/dsh-agent-tool-presentation',
      config: { mode: 'ptc' },
    },
    { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
  ],
}

/** The `agentPresets` service, when the host exposes one that can register. */
function presetRegistry(host: PresetHost): AgentPresetRegistry | undefined {
  if (typeof host.get !== 'function') return undefined
  const service = host.get('agentPresets') as Partial<AgentPresetRegistry> | null | undefined
  if (service === null || service === undefined) return undefined
  return typeof service.register === 'function' ? service as AgentPresetRegistry : undefined
}

/**
 * Declare `dispatch` to the running harness, when the harness has the mechanism.
 *
 * Both halves of the probe matter: the row package is what makes a declarative
 * preset possible at all on a given generation, and the service is what a
 * harness shipping that package provides. A generation with either half missing
 * — every release before 0.1.7 — is reported as `'legacy'`, and the caller keeps
 * copying the bundled tree into the discovery root.
 *
 * Registration is asynchronous, so the report describes the decision rather
 * than its outcome: the effect owns the await, a failure is logged there, and
 * neither the probe nor the effect is allowed to throw at the caller.
 * @param host - plugin context: service lookup, effect seam, and logger.
 * @param resolves - whether a bare specifier resolves in this installation.
 * @returns `'registered'` when this call took the preset, `'legacy'` when the
 * caller still has to copy the bundled tree into the discovery root.
 */
export function installDispatchPreset(
  host: PresetHost,
  resolves: SpecifierResolver = resolvesFromHere,
): PresetInstall {
  try {
    if (!resolves(PRESET_REGISTRY_PACKAGE)) return 'legacy'
    const registry = presetRegistry(host)
    if (registry === undefined) {
      // The row package is installed but nothing provides its service: either a
      // composition that drops the registry row, or one that provides it after
      // this plugin's own row. The copy below is the only mechanism left.
      host.logger.warn(`[dsh-chatgpt-subscription] agent preset "${DISPATCH_PRESET_ID}" fell back to the preset root: `
        + `${PRESET_REGISTRY_PACKAGE} is installed but no agentPresets service is available`)
      return 'legacy'
    }
    host.effect(
      () => registerDispatchPreset(host, registry),
      'dsh-chatgpt-subscription: dispatch agent preset',
    )
    return 'registered'
  } catch (error) {
    // Nothing here may escape `apply`: a plugin entry whose body throws has no
    // fiber, which fails the whole harness boot. The file copy stays available.
    host.logger.warn(`[dsh-chatgpt-subscription] agent preset "${DISPATCH_PRESET_ID}" could not be registered: ${messageOf(error)}`)
    return 'legacy'
  }
}

/**
 * Register the definition and hand its disposer back to the effect that owns
 * it.
 * @param host - plugin context, for the logger.
 * @param registry - the service the definition is submitted to.
 * @returns the harness's own unregister function, or a no-op after a failure.
 */
async function registerDispatchPreset(
  host: PresetHost,
  registry: AgentPresetRegistry,
): Promise<() => Promise<void>> {
  try {
    const unregister = await registry.register(DISPATCH_PRESET)
    host.logger.info(`[dsh-chatgpt-subscription] agent preset "${DISPATCH_PRESET_ID}" registered with the running harness`)
    return unregister
  } catch (error) {
    // The registry records a mount failure in its own roster and throws anyway;
    // a rejected effect here would be reported as this plugin's own failure.
    host.logger.warn(`[dsh-chatgpt-subscription] agent preset "${DISPATCH_PRESET_ID}" was not mounted: ${messageOf(error)}`)
    return () => Promise.resolve()
  }
}

/** One thrown value's message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
