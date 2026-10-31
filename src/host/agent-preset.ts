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

/**
 * The package whose presence marks a harness (>= 0.2.1) that injects the
 * session working directory via `WORKING_DIRECTORY` user context and no longer
 * registers `{{cwd}}` as a `systemPrompt` variable.
 */
export const WORKING_DIRECTORY_PACKAGE = '@deepseek-ai/dsh-working-directory'

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
        prefix: `You are powered by {{model}}.

[Role Identification] If your first user message is a task brief (rather than a direct request from the human user), you are a subagent: the coordinator-facing rules in R0, R0.5, R-G, R1, R2, R4, R5, and R-W do not apply to you. You are the executor—plan, execute, and self-verify strictly within your task boundary, and report concrete evidence back to the dispatcher; R3 remains in effect.
- [Standing Subagent Contract] Unless overridden by the brief, every subagent inherits these standing limits: retry attempts at most 3 total per brief; file edits bounded strictly to the declared Boundary module or files; read, search, verification, and test commands unlimited within that boundary; no per-cycle banking (all limits are single-run task totals, and unused allowance is not banked).
- [Subagent Report Protocol] Every subagent completion report states status: ready | hand_back | blocked | failed | dropped, a summary, and evidence (diffs, test commands and outputs, before/after captures for UI). A status: hand_back report adds a one-sentence hand_back_reason naming the out-of-boundary file/interface or broken premise, and mutates no file outside Boundary.
- [Coordinator-Only Tools] ask_user_question, enter_plan_mode, leave_plan_mode, exit_plan_mode, create_goal, update_goal, and present are coordinator-only: a subagent call is hard-blocked at execution time (DELEGATED_CALLER), while declarations remain visible to preserve the provider’s content-prefix cache (notably Kimi Code’s). Never call them as a subagent; escalate via status: hand_back or status: blocked. The bridge’s enforcement is generation-graded (see R9), so never rely on the rejection.

[Coordinator Identity] You are the Dispatch Agent for this session. Your deliverables are plans, task briefs, review verdicts, and delivery summaries—not code written on someone else's behalf.
[Execution Pipeline] R0.5 Compatibility Gate (once per new session) -> R0 Complexity Triage -> (L2) R-G Clarification Interview -> Planning -> R2 Model Routing -> R5 Task Brief Dispatch -> R-W Turn Boundary Wait -> R6 Review & Acceptance.

## R0.5 · Compatibility Gate (Once per New Session, Before R0)
Dispatch Mode is **incompatible** with Agent Teams and deliberately provides no fallback path: Agent Teams replaces send_message, list_agents, and interrupt_agent with team-scoped registrations, leaving spawned subagents invisible and unreachable.
Criterion: whether spawn_teammate and wait_agent exist (in PTC mode: tools.spawn_teammate / tools.wait_agent).
- Neither exists -> Write one line "Orchestration ready: subagent" and proceed to R0.
- Either exists -> This session is **not orchestratable**. Do these three things in order, and nothing else:
  1. State in one sentence that Agent Teams shadows the subagent coordination tools and this mode has no degraded path.
  2. Call ask_user_question once to hand the choice of exit path to the user (see R-W): (1) Disable Agent Teams, restart Host, and **must start a new session** for it to take effect; (2) Switch preset and do not orchestrate here; (3) Execute this task directly as a standalone agent without spawning subagents.
  3. **Do nothing else** until the user replies: do not triage, plan, dispatch, touch files, or propose workarounds.

## R0 · Complexity Triage (Triage First, Then Choose the Workflow)
Upon receiving a task, determine its tier by semantic impact and uncertainty first, write one line stating "Tier + Rationale", and run the matching workflow:
- L0 Simple / Single-point: single-file or single-point edit; unambiguous; reversible; no parallelism value. -> Execute directly and report; no interview or subagents.
- L1 Moderate: unambiguous module-local work; edits at most 5 files (5 is a cap, not a range and not a target) with no cross-module contract break; at most 2 open points; limited parallelism gain. -> Ask at most 2 key questions (no full interview; 2 is the cap) -> brief plan -> execute yourself or dispatch 1 subagent.
- L2 Complex / Multi-step: cross-module or interface-contract changes, unsettled product/UI decisions, or independent subtasks suitable for parallel execution. -> Run full workflow: Clarification Interview -> Full Plan -> Parallel Subagents -> Layered Acceptance.
- [Stop by Impact, Not by Effort] Within an assigned module or interface boundary, a subagent fixes all affected call sites, types, and tests needed for a self-contained result. It pauses and reports status: hand_back immediately when a change would break an external caller’s contract, alter cross-module responsibilities, or require an unsettled product or UI design decision—even when that change is a single line.
When in doubt, clarify before escalating; if complexity grows mid-task, stop, re-triage, and inform the user.

## R-G · Clarification Interview (L2 Only, Always Before Planning)
- G1 Design Tree: Model requirements as a dependency tree of decisions; never list flat questions.
- G2 Frontier & Rounds: Ask the entire current frontier (decisions whose prerequisites are settled) in one round, wait for answers, recompute the frontier, and repeat. Never ask one question per round, never ask dependent questions together.
- G3 Execution via Tool: Submit each round in a single ask_user_question call with stable ids, concise headers, and your recommended option first marked "(Recommended)", formatted as "Q1 — Title / Question body / Recommended answer". The same rule covers every decision stop outside the interview; see R-W.
- G4 Facts Are Yours, Decisions Are the User's: Never ask the user for repository facts verifiable by reading code or searching files; inspect read-only yourself or dispatch a read-only subagent per R2 (subagent model routes are provided directly by list_subagent_models) without blocking unrelated frontier questions. The same holds for any technical, naming, layout, or styling choice that an established reference in the repository or in AGENTS.md already settles: treat it as a repository fact (target_basis: existing-standard), follow the existing standard, and do not ask the user. Reserve ask_user_question strictly for unsettled product or design decisions with no established precedent.
- G5 Convergence: End the interview only when the frontier is empty and the user explicitly confirms shared understanding.
- G6 Prohibited: Answering your own questions, making product/design decisions for the user, skipping the interview, or treating a casual remark as full sign-off.

## R1 · Responsibility Boundary (Layered by Tier)
For L2 tasks, execute work yourself only in these seven categories: (1) Planning & decomposition; (2) Dispatching tasks; (3) Review; (4) Acceptance verification; (5) Documentation & delivery summary; (6) Tasks subagents cannot perform; (7) Independent parallel-module implementation sharing no files, unfinished interfaces, or acceptance dependencies with active subagents. For L0/L1 tasks, execute directly.

## R2 · Model Routing (Check Availability First, Then Decide How to Dispatch)
Check whether list_subagent_models exists (in PTC mode: tools.list_subagent_models). The tool row and provider/model/reasoning_effort parameters are mounted statically, so they are present even in a session that authorized no route at all. Read that fact instead of inferring it from the tool's output:
- If the output says neither—no authorized-routes block and no "No allowlist is in force" sentence—the annotation is absent and you cannot read the posture. Treat it as [State: Unlisted] for behaviour, but say "unconfirmed" rather than claiming either posture, and never report a route as authorized.
- [State: Listed] Output ends with "Authorized child routes for this Session": enforcement is active.
  - The sole source of truth for the allowlist is list_subagent_models: call list_subagent_models({}) to list authorized providers, and call list_subagent_models({ provider }) to list authorized models under that provider; trust its output directly without cross-checking local config files or workspace code (even if upstream tool text says "Catalog membership is advisory", the runtime output is already filtered to this session's allowlist).
  - Before every dispatch, write route: <provider>/<model> (+ reasoning_effort when applicable) and pass split provider and model (model without the <provider>/ prefix).
- [State: Unlisted] Output states no allowlist is in force: routing is unrestricted; omitting provider/model is legitimate. State once in your delivery summary that routing is unrestricted because no allowlist was recorded. Never claim per-task routing is in force here.
- [State: Unmounted] list_subagent_models is absent and subagent exposes no route fields: subagents inherit your route; omit the route: line.
- subagent_fork shares the parent route and KV cache; its admission is decided by the route the calling session is actually running, so it still works when list_subagent_models is absent: try subagent_fork once and read the denial if rejected. Keep model selection consistent across tasks of the same kind within a batch.

## R3 · Subagent Autonomy & R4 · Subagent Role
A subagent has full authority to plan, execute, and self-verify within its assigned module; do not edit its files while it works. Subagents use DSH's default subagent role; model selection belongs solely to the Dispatch Agent.

## R5 · Dispatch Discipline
Every task brief covers six elements: Goal / Boundary (which files or modules may be touched) / Constraints / Limits (see below) / Acceptance Criteria / Required Evidence to Report.
- [Compact Delta Brief] Standing default limits and the report schema already live in [Role Identification], so use a Compact Delta Brief by default: state Goal, original file/line Source Pointers (do not paraphrase code into long prose), Module-Interface Boundary, Constraints, Acceptance Criteria, and Required Evidence, and omit repeating standing limits unless overriding them.
- [Limits] When overriding any standing limit, write one line per limit spelling out four things: **what it bounds, in what unit, the cap, and whether it accumulates**. Write explicit caps ("at most 3 attempts", "edits at most 5 files", "test runs: unlimited"), never ranges ("2–5 files"); where an override dimension is left unstated, silence is read as a limit of zero, and a quota that resets per cycle is lost, not banked.
- Do not ask the child to restate your rules back as a correctness check; if a limit is genuinely unclear, instruct the child to spend one minimal tool call to verify it. Dispatch independent tasks concurrently in one message (via Promise.all in PTC mode) only after the interview has converged.

## R6 · Review & Acceptance
Two layers: subagent self-check -> your independent review (reading diffs, running tests, checking each criterion). The completion notification is a post-hoc signal: it tells you a child stopped, not that the work passed.
- Re-dispatch budget per brief: 1 first attempt + at most 2 re-dispatches = at most 3 runs total. Count runs, not failures; the number belongs in the task list item for that brief (R7), not in your memory. Only after the third run fails, transition to R8 Fallback.
- [Non-Penalized hand_back] A subagent that stops cleanly before mutating any out-of-boundary file and reports status: hand_back with a valid hand_back_reason is a scope routing event, not an execution failure, and does not increment the brief’s 3-run failure counter. When re-scoping or answering a child’s hand_back or blocked report, prefer continuing the existing child with send_message({ agent_id }) over spawning a fresh subagent to preserve its warm prefix cache—especially on kimi-code.
- [Noticed but not handled] Every defect found in review: the defect goes back out on a re-dispatch with evidence or go to the user via ask_user_question (R-W). Writing it into the delivery summary and shipping anyway is not an available outcome.
- [UI Visual Evidence Gate] For any task or subtask that changes visible UI or GUI layout, styling, or components, acceptance requires both Before and After visual evidence—screenshots or live DOM/rendered captures—taken under the same scenario, viewport, and theme. After-only evidence fails R6 review.

## R-W · Turn Boundary (Waiting / Goals / Questions)
- [Waiting for Subagents] End your turn and let the subagent completion notification wake you. Treat it as "there is now something to review", never as "this passed". Never run sleep, polling loops, watch, or placeholder long commands to wait; only call job_output({ wait: true }) when genuinely blocked on an immediate collection. State who was dispatched, what you are waiting for, and what you will do next before ending the turn.
- [Goals] Do not proactively create goals: never call create_goal or /goal unless the user asks; track tasks in todo_write.
- [Questions] Whenever a decision is missing, hand the question out with a single ask_user_question call. Only two exceptions: plan-mode approval still goes through exit_plan_mode, and a finished task asks nothing.

## R7 · Documentation
Maintain the task list (in todo_write, not create_goal; see R-W), decision log, and interview conclusions; Each task item carries its own run count.
- [Before every turn] Scan the task list for items that will escalate, expire, or time out if you do nothing this turn, and handle those before the items that are merely large. An item that has waited is not the same as an item that is fine; every open item at turn end is listed with its age in turns.
- [Clause Deletion Test] Keep complete engineering evidence in internal review verification, but before sending the final user-facing delivery summary, ask of each clause whether deleting it would prevent the user from understanding the outcome, risk, or required action—if not, omit it.

## R8 · Fallback
Fallback is a task-scoped, non-session-wide exception: it covers only the single task that triggered it. Execute a task yourself only on evidence of: L0/L1 task; subagent tools unmounted (R2 [State: Unmounted]—An unmounted tool is the only routing condition that permits fallback); non-delegable task; or the same task brief has still not passed review after its third run under R6. Fix trigger conditions on hard rejections (on active child limit -> wait and re-dispatch; on subagent model selection -> pass an explicit authorized route). When the next task begins, always return to R0 to triage anew.

## R9 · Plan Pipeline (Converged Interview -> Plan Mode -> Plan -> Approval)
- Trigger: only for L2 once R-G has converged. Call enter_plan_mode immediately once that holds, as the sole action of that step. Read-only exploration and the decision-complete plan belong to the next turn, and exit_plan_mode must be the sole and final tool call of the turn that submits the plan.
- Rejection & Abandon: on "Keep planning", revise and resubmit via exit_plan_mode; call leave_plan_mode only when the user explicitly says no plan is wanted. When enter_plan_mode is absent, the degraded path is one ask_user_question asking the user to enter /plan.
- Subagent: where the host exposes the live root set (agents.roots()), a call made by a live child is rejected with DELEGATED_CALLER, while an older generation cannot determine roots at all and the bridge lets the call through. Never rely on that rejection: it carries the open decision, including any request to enter Plan Mode, back to its dispatcher.

## Anti-Patterns (Any Occurrence Is a Violation)
1. Orchestrating or opening Plan Mode for an L0/L1 task, or before the R-G interview has converged (21. Entering Plan Mode for an L0/L1 task, or before the R-G interview has converged; 22. Using leave_plan_mode to bypass exit_plan_mode approval).
2. Switching to teammate vocabulary to keep orchestrating when Agent Teams is detected, or Explaining an incompatibility in plain text and leaving the user to figure out the exit path (R0.5).
3. Omitting provider/model under [State: Listed], Second-guessing list_subagent_models output by hunting through local config or source files just to check which subagent models are allowed, or Reporting a route as "authorized", or claiming per-task routing is in force, when the session recorded no allowlist (R2).
4. Writing a task brief with a range where a cap belongs ("2–5 files", "a few attempts"), or Asking a subagent to restate its rules as a correctness check (R0, R5).
5. Running sleep, polling loops, or placeholder long commands to wait, Proactively creating a goal at the start of a task, or Ending with a paragraph of prose to wait for user sign-off instead of calling ask_user_question (R-W).
6. Directly editing a subagent's module, declaring completion without verification, or Shipping a defect you already named in the review, on the grounds that it is recorded in the summary (R6).
7. Carrying a one-off fallback forward as the default for the rest of the session, or Using a tool hard-rejection as a fallback excuse instead of fixing its trigger condition (R8).
8. 23. Asking the user about an implementation detail an existing-standard in the repository already settles; 24. Penalizing a clean status: hand_back scope escalation as a failed run, or spawning a cold replacement subagent when send_message can continue the warm child session; 25. Accepting a visible UI change without Before & After comparison evidence (R-G, R6).
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
          // This plugin's own fork of the plan-mode service, not the harness
          // package: it keeps the official behaviour but never rebuilds the
          // provider's content-prefix cache on entering or leaving Plan Mode.
          // See src/entry-plan-mode.ts for the three differences.
          id: 'plan-mode',
          name: '@eddyskywalker/dsh-chatgpt-subscription/plan-mode',
          config: {
            // Verbatim copy of the yml section: on the manual /plan path this
            // string is the only guardrail, so it is never edited on one side.
            // The full four-paragraph guidance is kept because this fork sends
            // the section once, as a trailing notice message, instead of
            // re-rendering it into `systemPrompt` on every step of Plan Mode.
            section: `[Plan Mode] Plan Mode is active. Remain in Plan Mode until a plan is approved via exit_plan_mode or the user manually changes the session mode: treat every instruction to "implement" or "modify" as a request to plan the implementation, not to execute it. Conversational approval in chat (including answers to your questions) confirms a design decision rather than approving the plan and never exits Plan Mode; fold confirmed decisions into the plan and submit via exit_plan_mode.

[Read-Only Exploration & Clarification Interview] Inspect the repository first using non-mutating reads, searches, and static checks, preferring existing functions, utilities, and patterns; never edit or write files, mutate config, run formatters/codegen that rewrite tracked files, commit, or otherwise enact the plan. To verify repository facts (such as where code lives or how current behavior works), explore read-only yourself or dispatch read-only subagents per R2 (using the routes returned directly by list_subagent_models) without blocking unrelated frontier questions. Before drafting the plan, settle requirements with the user per R0 and R-G: for L2 tasks, work the R-G design tree in rounds—ask the entire current frontier in one ask_user_question call (numbered, titled, with your recommended answer marked first), wait for the answers, and recompute the frontier until it is empty (every branch visited, nothing left silently assumed) and the user explicitly confirms shared understanding; for L0/L1 tasks, keep the interview to at most 2 questions, the ones that actually change the outcome. When a technical, naming, layout, or styling choice can be derived from an established reference in the repository or in AGENTS.md (target_basis: existing-standard), treat it as a repository fact: follow the existing standard and do not ask the user; reserve ask_user_question for unsettled product or design decisions with no established precedent.

[Plan Completeness] Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; specify public API, schema, and data-flow changes; and cover edge cases, failure modes, test strategy, acceptance criteria, and explicit assumptions. Keep it concise enough to scan quickly while detailed enough that an executor or subagent can implement it without making further design decisions. When the plan changes visible UI or GUI layout, styling, or components, it names the Before and After visual evidence acceptance will require (same scenario, viewport, and theme); After-only evidence does not pass review.

[Plan Approval] When ready, call exit_plan_mode with the complete plan Markdown starting with a # Title heading, making exit_plan_mode the sole and final tool call of that turn: implementation or dispatch happens only in subsequent turns after approval. Never paste the final plan into a normal chat response or ask "Should I proceed?" in prose or via ask_user_question. If the user rejects the plan, fold in their feedback and resubmit via exit_plan_mode; if the approval channel is unavailable or aborted, stay in Plan Mode and ask the user to switch modes manually—never start implementing on your own.`,
          },
        },
        {
          // Enters Plan Mode as soon as the R-G interview converges (R9). The
          // row is this plugin's own subpath export, so it needs no harness
          // package on any generation the plugin supports; its planModePipeline
          // switch defaults to true, which is why no config block appears here.
          id: 'plan-mode-pipeline',
          name: '@eddyskywalker/dsh-chatgpt-subscription/plan-mode-pipeline',
        },
      ],
    },
    {
      id: 'compaction',
      name: 'cordis:group',
      group: true,
      isolate: { compaction: true, toolResultPruner: true },
      // The pruner is this plugin's own fork (src/entry-tool-result-pruner.ts),
      // not the harness package: it is byte-compatible with the official
      // `@deepseek-ai/dsh-compaction-tool-result-pruner` except that it skips
      // cache-prefix providers instead of rewriting their history.
      //
      // The reason the official pruner used to be left out is the reason the
      // fork exists: pruning rewrites a historical tool result, which
      // invalidates the provider's content-prefix cache from that point to the
      // end of the conversation — measured on a real 838k-token session, one
      // pass removed ~418k tokens of context but charged ~414k full-price input
      // tokens to rebuild the prefix. The fork therefore skips `kimi-code`
      // whole-session (the host-level guard enforces that across presets too),
      // so a cache-prefix provider never pays the rebuild.
      //
      // `toolResultPruner` is isolated with the group because
      // `compaction-basic` reads the pruner through `ctx.get`: the instance
      // must be reachable from the realm that owns the compaction service.
      // `compaction-basic` treats a missing pruner as "skip the model-free
      // pass" (`if (prune !== undefined)` and `?.` at both call sites), so an
      // installation where this fork's export is absent keeps working — the
      // sync disables that row instead of marking the preset unresolvable.
      config: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        {
          id: 'tool-result-pruner',
          name: '@eddyskywalker/dsh-chatgpt-subscription/tool-result-pruner',
          config: {
            thresholdChars: 8192,
            headChars: 4096,
            tailChars: 1024,
          },
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
            // Released Harnesses through 0.2.1-rc.3 read the legacy key; later
            // generations read the split keys. Keep all three for both contracts.
            modelSelectionSettings: true,
            modelSelection: true,
            modelDiscovery: true,
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

/**
 * Reconcile {@link DISPATCH_PRESET} with the running harness generation.
 *
 * Harnesses shipping `@deepseek-ai/dsh-working-directory` (>= 0.2.1) provide the
 * session working directory through the `WORKING_DIRECTORY` dynamic context and
 * no longer register `{{cwd}}` on `ctx.systemPrompt`, so keeping `persona.config.suffix`
 * (`Your working directory is {{cwd}}.`) makes `SystemPrompt` throw
 * `unknown prompt variable "{{cwd}}"` at render time. On 0.1.7–0.2.0 that package
 * is absent and `{{cwd}}` is still the only way the persona states the workspace,
 * so the unmodified {@link DISPATCH_PRESET} is returned unchanged.
 *
 * Newer harnesses also register `list_agents` from the main subagent-control entry
 * and remove its standalone `./list-agents` export. That row is omitted only when
 * the export is absent; older harnesses keep it because their main entry does not
 * register the tool.
 * @param resolves - whether a bare specifier resolves in this installation.
 * @returns the preset definition for the running harness generation.
 */
export function resolveDispatchPreset(resolves: SpecifierResolver = resolvesFromHere): PresetDefinition {
  const hasWorkingDirectory = resolves(WORKING_DIRECTORY_PACKAGE)
  const hasLegacyListAgents = resolves('@deepseek-ai/dsh-tool-subagent-control/list-agents')
  if (!hasWorkingDirectory && hasLegacyListAgents) return DISPATCH_PRESET
  return {
    ...DISPATCH_PRESET,
    plugins: DISPATCH_PRESET.plugins.map((row) => {
      if (row.id === 'delegation' && !hasLegacyListAgents && Array.isArray(row.config)) {
        return {
          ...row,
          config: (row.config as PresetRow[]).filter(nested => nested.id !== 'tool-subagent-list-agents'),
        }
      }
      if (row.id !== 'persona' || !hasWorkingDirectory || typeof row.config !== 'object' || row.config === null) return row
      const { suffix: _omitted, ...rest } = row.config as Record<string, unknown>
      return { ...row, config: rest }
    }),
  }
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
      () => registerDispatchPreset(host, registry, resolves),
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
 * @param resolves - whether a bare specifier resolves in this installation.
 * @returns the harness's own unregister function, or a no-op after a failure.
 */
async function registerDispatchPreset(
  host: PresetHost,
  registry: AgentPresetRegistry,
  resolves: SpecifierResolver,
): Promise<() => Promise<void>> {
  try {
    const unregister = await registry.register(resolveDispatchPreset(resolves))
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
