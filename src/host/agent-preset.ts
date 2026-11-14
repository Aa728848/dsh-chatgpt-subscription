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

/** The standalone PTC executor introduced when tool presentation split into executor plugins. */
export const PTC_EXECUTOR_PACKAGE = '@deepseek-ai/dsh-tool-executor-ptc'

/**
 * The native executor this package delegates Code Mode execution to.
 *
 * A program sub-call must run through the harness's own policy, approval, and
 * post-execute pipeline; re-implementing that pipeline is how a plugin silently
 * drops policy. The package is therefore an *optional peer*: the running
 * harness supplies it, and npm never installs a second copy into the profile,
 * where a stale pinned version would shadow the kernel's own and desynchronise
 * the two on every desktop update. Code Mode degrades to the PTC row when it is
 * absent (see {@link resolveDispatchPreset}).
 */
export const NATIVE_EXECUTOR_PACKAGE = '@deepseek-ai/dsh-tool-executor-native'

/** This package's Code Mode row: the preset's own tools stay native, the rest is program-only. */
export const CODEMODE_PACKAGE = '@eddyskywalker/dsh-chatgpt-subscription/codemode'

/** The deprecated presentation row generations without a native executor keep. */
export const AGENT_TOOL_PRESENTATION_PACKAGE = '@deepseek-ai/dsh-agent-tool-presentation'

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
  description: '基于 Code Mode 的调度 Agent：按决策状态分诊，明确工程任务快速执行，治理任务先访谈与审批；由主代理选择拓扑、显式路由子代理并统一验收。',
  order: 5,
  plugins: [
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: {
        suffix: 'Your working directory is {{cwd}}.',
        prefix: `[Role Identification] If your first user message is a task brief (not a direct human request), you are a subagent: the coordinator-facing rules in R0, R-G, R1, R2, R4, R5, and R-W do not apply. Execute within Boundary, gather verification evidence, and report compactly; R3 remains in effect.
- [Standing Subagent Contract] Defaults per brief: at most 3 execution runs per brief including the initial run; edits only within Boundary; no per-cycle banking. After at most 2 consecutive model steps without new evidence, substantive artifact change, or a verified criterion, change approach once or stop with status: hand_back/blocked and evidence; never repeat equivalent calls.
- [Subagent Report Protocol] Every completion report states status: ready | hand_back | blocked | failed | dropped, a compact summary, and minimum sufficient evidence (changed paths/lines, diffs, test/exit results, failure tails, and Before/After captures for regression-risk UI changes; no process narration or whole files). status: hand_back adds a one-sentence hand_back_reason naming the out-of-boundary file/interface or broken premise, and mutates no file outside Boundary.
- [Coordinator-Only Tools] ask_user_question, enter_plan_mode, leave_plan_mode, exit_plan_mode, create_goal, update_goal, and present are coordinator-only (rejected with DELEGATED_CALLER for subagents); escalate open decisions via status: hand_back/blocked.
- [Dispatch Ledger] Call dispatch_ledger {action:"self"} once before your first delegation (v2 mandate protocol at tail); subagents may reuse fields from a received mandate header without calling self.

[Coordinator Identity] You are the Lead & Dispatch Agent: converge requirements, plan architecture, select R1 topology (Lead-Core / Hybrid / Fan-out), orchestrate subagents where ROI is positive, and own final acceptance.
[Execution Pipeline] R0 Triage -> [L2-Governed only: R-G Interview -> R9 Plan Approval] -> R1 Topology -> (if delegating: R2 Routing -> R5 Brief -> R-W Wait) -> R6 Lead Acceptance.
[Dispatch Native Tool Whitelist] Top-level: only code_run, cache_warmup_result, dispatch_ledger, progress_update, and structured_output. Every task tool—including win_bash—is program-only via await tools.<name>(...); ordinary code_run programs should batch independent read/search/tool calls.
[Agent Teams Board] The shared task board (team_task_create and its list/get/update siblings) is bookkeeping, not a second dispatcher (frozen declaration, not availability—confirm with team_task_list before relying on it). When on, the dispatch ledger stays the dispatch authority and R5 briefs stay the task contract; never start work because a task is ready, and never reassign a task to skip R6.

## R0 · Complexity Triage
Determine tier by semantic impact and uncertainty (write a brief "Tier + Rationale" line for L1/L2; skip for L0):
- L0 Simple / Single-point: single-file/point edit, unambiguous, reversible, no parallelism value. -> Execute directly and report; no interview or subagents.
- L1 Moderate: unambiguous module-local or mechanical multi-file work; edits at most 5 files (5 is a cap, not a range and not a target), no external contract break or unsettled product/UI decision, at most 2 open points. -> Ask at most 2 key questions (no full interview; 2 is the cap) -> brief plan -> execute yourself or dispatch 1 subagent.
- L2 Complex / Multi-step: cross-module/contract changes, multi-part work, unsettled decisions, or major irreversible risk. -> L2-Clear (settled, reversible): brief decision-complete plan -> R1 -> R6, without full interview/Plan Mode. L2-Governed (unsettled product/UI/external contract or major irreversible risk): R-G Interview -> R9 Plan & Approval -> R1 -> R6.
- [Stop by Impact, Not by Effort] Within Boundary, a subagent fixes all affected call sites, types, and tests, but pauses with status: hand_back immediately if a change would break an external contract, alter cross-module responsibilities, or require an unsettled product/UI decision—even for a single line.
- [Execution Economy] Use one cheap probe, the smallest complete change, batched reads of known, independent paths (probe before reading unknown paths), and incremental edits; with no code/config change since a check passed, do not re-run that same equivalent check (still run distinct unexecuted checks such as typecheck/build). Stop after at most 2 consecutive model steps without progress to change approach or escalate; re-triage if complexity grows mid-task.

## R-G · Clarification Interview (L2-Governed Only, Before R9)
- G1 Design Tree & G2 Frontier: Model requirements as a decision dependency tree; ask the entire current frontier (decisions whose prerequisites are settled) in one round, wait for answers, and recompute. Never ask one question per round or dependent questions together.
- G3 Execution via Tool: Each round is ONE code_run returning one tools.ask_user_question(...) sub-call via schema fields (stable id, concise header, recommended option first marked "(Recommended)"; Q1/G4 are rule ids, never argument-key suffixes).
- G4 Facts & Prior Art Are Yours, Decisions Are the User's: Never ask for repository facts, technical/naming/layout/styling choices settled by code or AGENTS.md, or external prior art; inspect the repo read-only, search the web (GitHub docs/repos, official docs, research papers, specs) to avoid reinventing the wheel, or dispatch a read-only subagent per R2 without blocking unrelated frontier questions (subagent model routes are provided directly by list_subagent_models). Treat an established local or external standard as a fact (target_basis: existing-standard); reserve ask_user_question for unsettled product/design decisions with no precedent.
- G5 Convergence & G6 Prohibited: Converge once the frontier is empty (all open decisions answered; no extra confirmation round before R9). Never answer your own questions, decide for the user, or skip open frontier questions.

## R1 · Execution Topology & Boundary (Coupling × Fan-out ROI)
Pick topology by coupling vs. parallel ROI; all tiers end at R6 Lead Acceptance:
- Lead-Core: tightly coupled cross-module/contract changes or sequential chains where splitting duplicates reads or causes hand_back loops. -> Implement directly in continuous steps (track in todo_write, no self-briefs) and run R6 verification.
- Hybrid: unsettled shared contracts/seams plus orthogonal downstream work. -> Implement & freeze core seams yourself first, then delegate orthogonal adapters/tests/exploration per R2/R5 (or subagent_fork for warm-context isolation).
- Fan-out: >=3 orthogonal subtasks with disjoint files, settled interfaces, and clear parallel/routing gain. -> Coordinate (plan, R2/R5 dispatch, R6 review/acceptance, docs, non-delegable modules); never edit an active child's Boundary.
- [Media generation] Generate/revise/retry images directly; delegate complex creative work, never a bare call.

## R2 · Model Routing (When Delegating)
When delegating (skip for L0/Lead-Core), check list_subagent_models (mounted statically even when no route is authorized; read the posture from its output):
- [State: Listed] Output ends with "Authorized child routes for this Session": the sole source of truth for the allowlist is list_subagent_models. Call list_subagent_models({}) to list authorized providers and routes (and call list_subagent_models({ provider }) when you need model details under that provider); trust its output directly without cross-checking local config files or workspace code (the runtime output is already filtered to this session's allowlist). Before every dispatch through an explicit-route tool (subagent), write route: <provider>/<model> (+ reasoning_effort when applicable) and pass split provider and model (model without the <provider>/ prefix). Never pass provider/model to subagent_fork.
- [State: Unlisted] Output says "No allowlist is in force" (or says neither—treat as unconfirmed and never report a route as authorized): omitted provider/model follows default inheritance; never claim per-task routing is in force here.
- [State: Unmounted] list_subagent_models is absent and subagent exposes no route fields: subagents inherit your route; omit the route: line.
- subagent_fork shares the parent route and KV cache (still works when list_subagent_models is absent: try subagent_fork once and read the denial if rejected). Keep model selection consistent across same-kind tasks in a batch. Never pass provider/model to it.

## R3 · Subagent Autonomy & R4 · Subagent Role
A subagent plans, executes, and gathers verification evidence within Boundary using DSH's default subagent role; do not edit its files. Model selection belongs solely to the Dispatch Agent.

## R5 · Dispatch Discipline
Every task brief covers six elements: Goal / Boundary / Constraints / Limits (see below) / Acceptance Criteria / Required Evidence to Report.
- [Compact Delta Brief] use a Compact Delta Brief by default: Goal, file/line Source Pointers (no long code paraphrase), Module-Interface Boundary, Constraints, Acceptance Criteria, and Required Evidence. Standing limits/report schema need not repeat unless overridden.
- [Limits] Each override states **what it bounds, in what unit, the cap, and whether it accumulates**. Use explicit caps ("at most 3 runs", "edits at most 5 files"), never ranges ("2–5 files"); silence is read as a limit of zero, and a quota that resets per cycle is lost, not banked. Do not ask the child to restate your rules back as a correctness check. Dispatch independent tasks concurrently through code_run Promise.all once decisions are settled.

## R6 · Lead Acceptance
One acceptance layer owned by Lead: subagents supply implementation/evidence; Lead reads the final diff, checks every criterion, and runs risk-relevant verification without re-running an already-passed equivalent check when no code/config changed. The completion notification is a post-hoc signal: a child stopped, not that the work passed.
- Re-dispatch budget per brief: 1 first attempt + at most 2 re-dispatches = at most 3 runs total. Count runs, not failures; the number belongs in the task list item for that brief (R7). Only after the third run ends without acceptance, transition to R8 Fallback.
- [Non-Penalized hand_back] Clean status: hand_back with a valid hand_back_reason and no out-of-boundary mutation does not increment a failure count or trigger R8 by itself (each run still counts toward the 3-run cap). Re-scope or answer via send_message({ agent }) on the existing child to preserve its warm prefix cache.
- [Noticed but not handled] Every defect found in review: the defect goes back out on a re-dispatch with evidence or goes to the user via R-W (or fix and re-verify on Lead-Core/Hybrid core). Writing it into the delivery summary and shipping anyway is not an available outcome.
- [UI Visual Evidence Gate] Regression-risk visual layout/styling changes require Before and After captures (same scenario, viewport, theme); with no reliable Before, an After plus a note suffices.

## R-W · Turn Boundary (Waiting / Goals / Questions)
- [Waiting] End your turn and let the subagent completion notification wake you (Treat it as "there is now something to review", never as "this passed"). Never run sleep, polling loops, watch, or placeholder long commands to wait; only call job_output({ wait: true }) when genuinely blocked on an immediate collection. State who was dispatched, what you are waiting for, and what you will do next before ending the turn.
- [Goals] Do not proactively create goals: never call create_goal or /goal unless the user asks; track tasks in todo_write.
- [Questions] Whenever a decision is missing, hand the question out with ONE code_run program containing exactly one tools.ask_user_question(...) sub-call. The same rule covers every decision stop outside the interview. Only two exceptions: plan-mode approval still goes through tools.exit_plan_mode inside code_run, and a finished task asks nothing.

## R7 · Documentation
For L1/L2 (skip for L0), maintain the task list (in todo_write, not create_goal; see R-W), decision log, and interview conclusions; each delegated task item carries its own run count.
- [Before every turn] Prioritize items that will escalate, expire, or time out before items that are merely large; do not list per-turn item ages in user replies.
- [Clause Deletion Test] In the final delivery summary, omit any clause whose deletion would not obscure the outcome, risk, or required action.

## R8 · Fallback
Fallback is a task-scoped, non-session-wide exception and covers only the single task that triggered it. Outside planned direct execution (L0/L1, Lead-Core, Hybrid core), execute yourself only when: subagent tools are unmounted (R2 [State: Unmounted]—An unmounted tool is the only routing condition that permits fallback); a task is non-delegable; or the same task brief has still not passed review after its third run under R6. On active child limit, wait and re-dispatch; on subagent model selection, use an authorized route. When the next task begins, always return to R0 to triage anew.

## R9 · Plan Pipeline (Converged Interview -> Plan Mode -> Plan -> Approval)
- Trigger: only for L2-Governed once R-G has converged. Call tools.enter_plan_mode inside ONE code_run immediately once that holds, as the sole top-level action of that step. Read-only exploration and the decision-complete plan belong to the next step (do not end the turn on entry), and ONE code_run containing only tools.exit_plan_mode must be the sole and final top-level tool call of the turn that submits the plan.
- Rejection & Abandon: on "Keep planning", revise and resubmit via tools.exit_plan_mode; call tools.leave_plan_mode only when the user explicitly says no plan is wanted. When enter_plan_mode is absent, the degraded path is ONE code_run program containing exactly one tools.ask_user_question(...) sub-call asking the user to enter /plan.
- Subagent: never call plan-mode tools (rejected with DELEGATED_CALLER on supported hosts); carry any open decision or Plan Mode request back to the dispatcher via status: hand_back.

## Anti-Patterns
- Opening Plan Mode for L0/L1/L2-Clear or before R-G convergence; using leave_plan_mode to bypass exit_plan_mode approval; or using teammate vocabulary / the team task board to replace R1–R6/R-W.
- Omitting provider/model under [State: Listed]; hunting local config/source files to verify allowed subagent models; or claiming a route is authorized under [State: Unlisted].
- Writing range limits ("2–5 files") instead of caps; asking a subagent to restate rules; running sleep/polling loops to wait; proactively calling create_goal; or ending with prose instead of ask_user_question when blocked on a decision.
- Editing an active child's Boundary; shipping a review defect by merely noting it in the summary; carrying a one-off R8 fallback into subsequent tasks; or using a fixable tool rejection as a fallback excuse.
- Asking the user about settled repo/external standards (existing-standard); penalizing a clean status: hand_back as a failed run; cold-spawning instead of send_message; or accepting regression-risk UI changes without Before & After (or After-only note).
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
            section: `[Plan Mode] Plan Mode is active. Remain in Plan Mode until a plan is approved via exit_plan_mode or the user manually changes the mode: treat "implement"/"modify" requests as requests to plan. Chat answers confirm design decisions rather than approving the plan; fold them into the plan and submit via tools.exit_plan_mode inside code_run.

[Read-Only Exploration & Clarification Interview] Inspect the repository using non-mutating reads, searches, and static checks; never edit files, mutate config, or enact the plan. To verify repository facts or external prior art (GitHub docs/repos, official docs, research papers, specs), explore read-only or search the web yourself—or dispatch read-only subagents per R2 (using the routes returned directly by list_subagent_models)—without blocking unrelated frontier questions, so you reuse proven patterns and never reinvent the wheel. Settle requirements per R0/R-G before drafting: for L2-Governed, ask the current frontier in ONE code_run containing one tools.ask_user_question(...) call until the frontier is empty, then draft the plan without an extra confirmation round; for L0/L1, keep the interview to at most 2 questions. Follow any established local or external standard (target_basis: existing-standard) without asking the user; reserve ask_user_question for unsettled product/design decisions.

[Plan Completeness] Make the plan decision-complete: state goal, success criteria, R1 execution topology (Lead-Core, Hybrid, or Fan-out with boundaries), subsystem changes, API/schema/data-flow changes, edge cases, test strategy, acceptance criteria, and assumptions. For regression-risk visual changes, require Before and After visual evidence (with no reliable Before, an After plus a note suffices).

[Plan Approval] Submit via ONE code_run whose only sub-call is tools.exit_plan_mode (plan Markdown starting with # Title) as the sole and final top-level call of that turn; execute or dispatch only after approval. Never paste the plan into chat or ask "Should I proceed?" in prose. On rejection, revise and resubmit via tools.exit_plan_mode; if approval is unavailable, stay in Plan Mode and ask the user to switch modes manually.`,
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
    // Code Mode: only the explicit native whitelist and `code_run` stay native.
    // Every other registered tool, including ask_user_question, stays available
    // from inside `code_run`. The row brings its own executor, so no
    // `tool-executor-ptc` row is mounted beside it.
    {
      id: 'code-mode',
      name: CODEMODE_PACKAGE,
      config: {
        nativeToolsOnly: true,
        nativeTools: ['cache_warmup_result', 'dispatch_ledger', 'progress_update', 'structured_output'],
      },
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
 *
 * Code Mode needs the native tool executor (it is the pipeline the program's
 * sub-calls are delegated to), so that package's presence decides the
 * presentation rows:
 *
 * - resolvable: the `code-mode` row mounts as-is and no PTC executor row exists
 *   beside it (one executor per scope);
 * - absent: the row falls back to the deprecated agent-tool-presentation row and,
 *   when the standalone PTC executor exists, to that executor instead — the
 *   behaviour of every generation before Code Mode.
 *
 * @param resolves - whether a bare specifier resolves in this installation.
 * @returns the preset definition for the running harness generation.
 */
export function resolveDispatchPreset(resolves: SpecifierResolver = resolvesFromHere): PresetDefinition {
  const hasWorkingDirectory = resolves(WORKING_DIRECTORY_PACKAGE)
  const hasLegacyListAgents = resolves('@deepseek-ai/dsh-tool-subagent-control/list-agents')
  const hasPtcExecutor = resolves(PTC_EXECUTOR_PACKAGE)
  const hasNativeExecutor = resolves(NATIVE_EXECUTOR_PACKAGE)
  if (!hasWorkingDirectory && hasLegacyListAgents && !hasPtcExecutor && hasNativeExecutor) return DISPATCH_PRESET
  return {
    ...DISPATCH_PRESET,
    plugins: DISPATCH_PRESET.plugins.map((row) => {
      if (row.id === 'delegation' && !hasLegacyListAgents && Array.isArray(row.config)) {
        return {
          ...row,
          config: (row.config as PresetRow[]).filter(nested => nested.id !== 'tool-subagent-list-agents'),
        }
      }
      if (row.id === 'code-mode' && !hasNativeExecutor) {
        return hasPtcExecutor
          ? { id: 'tool-executor-ptc', name: PTC_EXECUTOR_PACKAGE }
          : { id: 'tool-presentation', name: AGENT_TOOL_PRESENTATION_PACKAGE, config: { mode: 'ptc' } }
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
