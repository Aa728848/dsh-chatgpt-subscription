/**
 * Per-model capabilities for the Claude subscription line.
 *
 * TRANSCRIPTION NOTICE — read this before trusting any row below.
 *
 * This table is a transcription of a snapshot catalog that ships inside a
 * locally installed reference implementation
 * (`@earendil-works/pi-ai`, `dist/providers/data/anthropic.json`, key
 * `anthropic-messages`). It is therefore **not proof that the server accepts
 * these models**, not proof of the context window or output cap it grants this
 * account, and not proof that any of them is entitled on the signed-in plan. It
 * is a starting point that is at least *read* rather than guessed, and nothing
 * more.
 *
 * The authority is the server's own `GET /v1/models`, read through this
 * account's credential. Where that listing speaks, it wins over every row here.
 *
 * Two kinds of row live in this file, and the difference is load-bearing:
 * transcribed rows, whose authority is the snapshot and which the fidelity lock
 * in `test/claude-model-catalog.test.ts` checks field by field, and LOCALLY
 * CURATED rows the snapshot predates, whose authority is the vendor's own
 * published documentation instead. The curated ids are named in the
 * "LOCAL ADDITIONS" section at the end of this notice; a row that is in neither
 * set is a mistake, not a third category, and the test fails on one.
 *
 * Nothing in this file is inferred from a model's name. Image support and the
 * thinking form are per-model facts that the family name does not decide:
 * `claude-sonnet-4-5` and `claude-sonnet-4-6` share a family and disagree on
 * the thinking form, and `claude-opus-4-6` accepts a temperature its immediate
 * successor `claude-opus-4-7` refuses.
 *
 * ---------------------------------------------------------------------------
 * The mapping rules, each derived from the reference's own code
 * ---------------------------------------------------------------------------
 *
 * **thinkingMode** — FOUR cases, and the order of the guards is the whole point.
 * Source: `dist/api/anthropic-messages.js` lines 842-874, evaluated in this
 * order:
 *
 * 1. `compat.supportsMidConvoEffort === true` (lines 842-849) -> `'mid-convo'`.
 *    This branch is checked FIRST and it is unconditional: it applies even when
 *    the caller asked for thinking off. It sends `{ type: 'adaptive', display,
 *    block_binding: { prefix_mismatch_behavior: 'drop_block' } }` AND
 *    `output_config = { effort: 'high' }`. The reference's own comment states
 *    why the block_binding is not optional: "Managed effort models always use
 *    adaptive thinking so prefix mismatches can be dropped instead of surfacing
 *    as persistent 400 responses."
 * 2. else `compat.forceAdaptiveThinking === true` (line 855) -> `'adaptive'`,
 *    sending `{ type: 'adaptive', display }` (+ `output_config.effort` when the
 *    caller named an effort). The budget form is rejected by these models.
 * 3. else `reasoning === true` (line 863) -> `'budget'`, sending
 *    `{ type: 'enabled', budget_tokens: ..., display }` — the branch the
 *    reference comments "Budget-based thinking for older models".
 * 4. else -> `'none'`, no thinking field at all.
 *
 * Both guards are strict `=== true` comparisons, so an absent flag means the
 * weaker behaviour. Collapsing cases 1 and 2 into one value loses a real wire
 * requirement: `block_binding` and `output_config` would not be sent, and the
 * reference documents that omission as producing persistent 400s.
 *
 * **supportsTemperature** — `compat.supportsTemperature ?? true`, i.e. absent
 * means supported.
 * Source: `dist/api/anthropic-messages.js` line 126
 * (`supportsTemperature: model.compat?.supportsTemperature ?? true`), consumed at
 * line 831 where a temperature is only attached when the flag is true. Three
 * entries declare `false`; the other eleven are silent and therefore true.
 *
 * **reasoningEfforts** — the ladder a model exposes, derived in two steps, both
 * from the reference's own code rather than from the raw map.
 *
 * 1. Which levels a model *has*: `dist/models.js` lines 550-562
 *    (`getSupportedThinkingLevels`). A model with `reasoning !== true` has no
 *    ladder at all. Otherwise the fixed order
 *    `['off','minimal','low','medium','high','xhigh','max']` is filtered, and the
 *    two conditions are the ones that matter:
 *    - a level mapped to `null` is REMOVED (`mapped === null -> false`), which is
 *      how `off: null` states "this model cannot be told to stop thinking";
 *    - `xhigh` and `max` exist only when the map literally names them
 *      (`mapped !== undefined`) — silence means the level is not offered.
 *    Every other level defaults to available. The map is an *exclusion* list for
 *    the middle rungs and an *inclusion* list for the top two, which is why a
 *    model with no map at all still has `minimal` through `high`.
 *
 * 2. What each level is called on the wire: `dist/api/anthropic-messages.js`
 *    lines 638-653 (`mapThinkingLevelToEffort`). A string in the map is sent
 *    verbatim; `minimal` and `low` both collapse to `low`, `medium` to
 *    `medium`, `high` to `high`, and anything else to `high`.
 *
 * The ladder stored below is the de-duplicated wire vocabulary in that order, and
 * its distinct values are exactly the levels worth exposing: offering two rungs
 * that both send `high` would advertise a distinction the model cannot make.
 * `off` is NOT in the ladder — it is carried separately as
 * {@link ClaudeModelEntry.canDisableThinking}, because "stop thinking" is the
 * absence of a thinking block rather than an effort level, and `off: null`
 * forbids it outright (line 871 only sends `{ type: 'disabled' }` when
 * `thinkingLevelMap.off !== null`).
 *
 * The de-duplication is the one deliberate departure from the raw reference map,
 * and it is applied uniformly to every row: no entry is special-cased.
 *
 * ---------------------------------------------------------------------------
 * RULE 4 — the budget form's clamp, carried here for the mapper chunk
 * ---------------------------------------------------------------------------
 *
 * This table decides WHICH form a model takes; it does not send anything. The
 * arithmetic below is recorded here because the budget branch is the one that
 * can silently produce a wrong request, and the chunk that builds the body must
 * reproduce it rather than re-derive it.
 *
 * `adjustMaxTokensForThinking` and `clampMaxTokensToContext` are called at
 * `dist/api/anthropic-messages.js` lines 676-685 and are **not defined** in that
 * file — they are imported from `./simple-options.js` (line 14). Their exact
 * arithmetic, transcribed from `dist/api/simple-options.js`:
 *
 * ```text
 * CONTEXT_SAFETY_TOKENS = 4096                                    // line 2
 * MIN_MAX_TOKENS        = 1                                       // line 3
 * MIN_ANSWER_TOKENS     = 1024                                    // line 37
 * DEFAULT_THINKING_BUDGETS = { minimal: 1024, low: 2048,
 *                              medium: 8192, high: 16384 }         // lines 38-43
 *
 * clampReasoning(effort)                                          // lines 44-46
 *   = (effort === 'xhigh' || effort === 'max') ? 'high' : effort
 *
 * thinkingBudgetForLevel(level, customBudgets)                    // lines 47-51
 *   = { ...DEFAULT_THINKING_BUDGETS, ...customBudgets }[clampReasoning(level)]
 *
 * clampThinkingBudgetToAnswerRoom(budget, ceiling)                // lines 52-55
 *   = Math.min(budget, Math.max(0, ceiling - MIN_ANSWER_TOKENS))
 *
 * adjustMaxTokensForThinking(baseMaxTokens, modelMaxTokens,
 *                            reasoningLevel, customBudgets)       // lines 56-65
 *   let thinkingBudget = thinkingBudgetForLevel(reasoningLevel, customBudgets)
 *   const maxTokens = baseMaxTokens === undefined
 *     ? modelMaxTokens
 *     : Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens)
 *   if (maxTokens <= thinkingBudget)
 *     thinkingBudget = clampThinkingBudgetToAnswerRoom(thinkingBudget, maxTokens)
 *   return { maxTokens, thinkingBudget }
 *
 * clampMaxTokensToContext(model, context, maxTokens)               // lines 4-9
 *   = model.contextWindow <= 0
 *       ? Math.max(MIN_MAX_TOKENS, maxTokens)
 *       : Math.min(maxTokens, Math.max(MIN_MAX_TOKENS,
 *           model.contextWindow - estimateContextTokens(context).tokens
 *             - CONTEXT_SAFETY_TOKENS))
 * ```
 *
 * The caller side (`dist/api/anthropic-messages.js` lines 676-685) then sends
 *
 * ```text
 * const adjusted = adjustMaxTokensForThinking(base.maxTokens, model.maxTokens,
 *     options.reasoning, options.thinkingBudgets);
 * const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);
 * ... thinkingBudgetTokens: Math.min(adjusted.thinkingBudget,
 *                                    Math.max(0, maxTokens - 1024))
 * ```
 *
 * Two traps the mapper must not walk into:
 *
 * 1. `base.maxTokens` is already resolved — `buildBaseOptions`
 *    (`simple-options.js` line 17) does
 *    `clampMaxTokensToContext(model, context, options?.maxTokens ?? model.maxTokens)`.
 *    Feeding an unresolved `options.maxTokens` into the helper changes which
 *    argument is `undefined` and therefore which cap wins.
 * 2. An undefined output cap must NOT be coerced to 0 first. The reference
 *    comments this on `simple-options.js` line 57 — "Undefined means no explicit
 *    caller cap. Use the model cap and fit thinking inside it." — and on
 *    `anthropic-messages.js` lines 676-677 — "Do not coerce to 0 here, or the
 *    thinking budget would become the entire max_tokens value." Under the
 *    helper's own branch, a 0 base cap yields `Math.min(0 + budget, modelMax)`,
 *    i.e. the thinking budget becomes the whole response ceiling and no room is
 *    left for an answer.
 *
 * ---------------------------------------------------------------------------
 * LOCAL ADDITIONS — the rows the reference snapshot predates
 * ---------------------------------------------------------------------------
 *
 * `claude-opus-5-5` is the only such row today. The mirror list in the test is
 * `LOCALLY_CURATED_MODEL_IDS`; the two must be changed together.
 *
 * It is CURATED rather than transcribed because the snapshot this table copies
 * has no entry for it, and the one thing a transcription table must never do is
 * invent a row and let it read as if it had been read from somewhere. An
 * invented row that mimics the format of a checked one is worse than a missing
 * row: it is unverifiable and it looks verified. So the row below is marked at
 * the row itself, the test asserts the id is on the curated list, and the test
 * asserts the curated list is exactly the ids the snapshot lacks — which keeps
 * the lock narrow instead of merely weaker.
 *
 * Its fields come from the vendor's own published documentation for the model
 * (the model overview page plus the extended-thinking effort page), NOT from the
 * snapshot, and they are the values a person read off those pages. That is a
 * weaker source than the snapshot and it is labelled as such: nothing here
 * proves the account is entitled to the model, and the server's own
 * `GET /v1/models` still outranks it.
 *
 * Two of its fields are the ones worth recording a WHY for, because both look
 * like mistakes against their neighbours:
 *
 * 1. `canDisableThinking: false`. The vendor documents that thinking cannot be
 *    turned off on this model at all: sending `thinking: { type: 'disabled' }`
 *    is a 400 `invalid_request_error`, and so is the manual budget form
 *    `{ type: 'enabled', budget_tokens: N }`. Only an omitted `thinking` field
 *    or `{ type: 'adaptive' }` is accepted. The snapshot's own rule for this
 *    flag is `thinkingLevelMap.off !== null` — an explicit `off: null` — so a
 *    reading of "no map means nothing forbids it" would set this true and
 *    produce a request the model rejects.
 * 2. `thinkingMode: 'adaptive'`, NOT `'mid-convo'`. The two are easy to confuse
 *    here because every model in this line that refuses a temperature is also,
 *    so far, a managed-effort model. That is a coincidence of `compat`, not a
 *    rule: this row carries no `supportsMidConvoEffort` flag, and 'mid-convo'
 *    additionally forces `output_config = { effort: 'high' }` when the caller
 *    names no effort. That forced high is correct for the rows that DO carry the
 *    flag, because the vendor makes `high` their default effort; this model's
 *    documented default effort is `medium`. Labelling it 'mid-convo' would
 *    silently override the vendor's own default and make every request think —
 *    and cost — harder than the user asked for.
 *
 * A future reader who notices the shared `supportsTemperature: false` and
 * "fixes" item 2 to 'mid-convo' has reintroduced exactly that bug.
 */

import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from './types.ts'

/** One model's shipped capability entry. */
export interface ClaudeModelEntry {
  /** Exact model id to put on the wire. */
  id: string
  /** Display name. Transcribed from the reference, including its "(latest)" suffix. */
  name: string
  /** Context window DSH assumes before the server's own listing contradicts it. */
  contextWindow: number
  /** Output cap requested when the caller omits one. */
  maxTokens: number
  /** Whether the model accepts image input. */
  supportsImage: boolean
  /** Whether a `temperature` may be sent at all. */
  supportsTemperature: boolean
  /**
   * Which thinking form this model needs.
   *
   * - `mid-convo` — the model is managed under mid-conversation effort. The
   *   request MUST send `{ type: 'adaptive', block_binding: { prefix_mismatch_behavior:
   *   'drop_block' } }` plus `output_config.effort`; the reference's own comment
   *   says why: "Managed effort models always use adaptive thinking so prefix
   *   mismatches can be dropped instead of surfacing as persistent 400
   *   responses." This is the strictest case and it is checked FIRST.
   * - `adaptive` — the model decides when and how much to think; the request
   *   sends `{ type: 'adaptive' }` and names an effort separately. The
   *   budget form is rejected.
   * - `budget` — the older form: `{ type: 'enabled', budget_tokens }`.
   * - `none` — the model does not reason, so no thinking field is sent.
   */
  thinkingMode: 'mid-convo' | 'adaptive' | 'budget' | 'none'
  /**
   * Thinking levels this model exposes, in escalating order.
   *
   * These are the *wire* effort values, already collapsed by the reference's own
   * mapper, so a caller picks one of these and it is sent unchanged. Empty means
   * the model exposes no selectable level.
   */
  reasoningEfforts: readonly string[]
  /**
   * Whether thinking can be turned off.
   *
   * False means the model states `off: null` (or has no map and no reasoning
   * at all): sending `{ type: 'disabled' }` is not a supported request.
   */
  canDisableThinking: boolean
}

/**
 * Fifteen rows: the snapshot's own 14, in the snapshot's own declaration order,
 * followed by the curated row the snapshot predates (see LOCAL ADDITIONS above).
 *
 * The order matters and is not cosmetic. The test asserts the snapshot's ids
 * appear in the table as a SUBSEQUENCE, so a curated row may be appended or
 * placed anywhere that leaves the transcribed rows in their relative order —
 * but the snapshot's order is the one a reader can diff against, so the
 * transcribed rows keep it and a curated row is appended rather than dropped
 * into the middle of them.
 *
 * `claude-haiku-4-5` and `claude-sonnet-4-5` are the dated aliases that
 * track the newest build; each has a pinned sibling below it. Offering both is
 * intentional: the alias follows an upstream upgrade without a config change,
 * while the pinned id is what a caller repeats when it must not move.
 *
 * Quoting is deliberately inconsistent below, because the `name` field is
 * transcribed rather than formatted: the snapshot quotes two of these names —
 * `'Claude Opus 4.5'` and `'Claude Sonnet 4.5'` — to distinguish them from
 * their `(latest)` aliases, and leaves every other name bare. Formatting the
 * table `name` to match this repository's style is therefore not free: it
 * breaks the fidelity lock on those two rows. A curated row has no snapshot
 * name to match, so it follows the majority and is left bare.
 *
 * `claude-fable-5` carries an `allowedFallbackModels` list in the reference
 * (Opus 4.8 and Opus 5). That is a server-side routing hint for the
 * `server-side-fallback` beta, outside this table's scope, and no later chunk
 * in this line may read it from here — it is not transcribed.
 */
export const CLAUDE_MODELS: readonly ClaudeModelEntry[] = Object.freeze([
  {
    id: 'claude-fable-5',
    name: 'Claude Fable 5',
    contextWindow: 1000000,
    maxTokens: 128000,
    supportsImage: true,
    supportsTemperature: true,
    thinkingMode: 'adaptive',
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    canDisableThinking: false,
  },
  {
    id: 'claude-fable-5-1',
    name: 'Claude Fable 5.1',
    contextWindow: 1000000,
    maxTokens: 128000,
    supportsImage: true,
    supportsTemperature: true,
    thinkingMode: 'mid-convo',
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    canDisableThinking: false,
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5 (latest)',
    contextWindow: 200000,
    maxTokens: 64000,
    supportsImage: true,
    supportsTemperature: true,
    thinkingMode: 'budget',
    reasoningEfforts: ['low', 'medium', 'high'],
    canDisableThinking: true,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    contextWindow: 200000,
    maxTokens: 64000,
    supportsImage: true,
    supportsTemperature: true,
    thinkingMode: 'budget',
    reasoningEfforts: ['low', 'medium', 'high'],
    canDisableThinking: true,
  },
  {
    id: 'claude-opus-4-5',
    name: 'Claude Opus 4.5 (latest)',
    contextWindow: 200000,
    maxTokens: 64000,
    supportsImage: true,
    supportsTemperature: true,
    thinkingMode: 'budget',
    reasoningEfforts: ['low', 'medium', 'high'],
    canDisableThinking: true,
  },
  {
    id: 'claude-opus-4-5-20251101',
    name: 'Claude Opus 4.5',
    contextWindow: 200000,
    maxTokens: 64000,
    supportsImage: true,
    supportsTemperature: true,
    thinkingMode: 'budget',
    reasoningEfforts: ['low', 'medium', 'high'],
    canDisableThinking: true,
  },
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    contextWindow: 1000000,
    maxTokens: 128000,
    supportsImage: true,
    supportsTemperature: true,
    thinkingMode: 'adaptive',
    reasoningEfforts: ['low', 'medium', 'high', 'max'],
    canDisableThinking: true,
  },
  {
    id: 'claude-opus-4-7',
    name: 'Claude Opus 4.7',
    contextWindow: 1000000,
    maxTokens: 128000,
    supportsImage: true,
    supportsTemperature: false,
    thinkingMode: 'adaptive',
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    canDisableThinking: true,
  },
  {
    id: 'claude-opus-4-8',
    name: 'Claude Opus 4.8',
    contextWindow: 1000000,
    maxTokens: 128000,
    supportsImage: true,
    supportsTemperature: false,
    thinkingMode: 'adaptive',
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    canDisableThinking: true,
  },
  {
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    contextWindow: 1000000,
    maxTokens: 128000,
    supportsImage: true,
    supportsTemperature: false,
    thinkingMode: 'mid-convo',
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    canDisableThinking: false,
  },
  {
    id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5 (latest)',
    contextWindow: 1000000,
    maxTokens: 64000,
    supportsImage: true,
    supportsTemperature: true,
    thinkingMode: 'budget',
    reasoningEfforts: ['low', 'medium', 'high'],
    canDisableThinking: true,
  },
  {
    id: 'claude-sonnet-4-5-20250929',
    name: 'Claude Sonnet 4.5',
    contextWindow: 1000000,
    maxTokens: 64000,
    supportsImage: true,
    supportsTemperature: true,
    thinkingMode: 'budget',
    reasoningEfforts: ['low', 'medium', 'high'],
    canDisableThinking: true,
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    contextWindow: 1000000,
    maxTokens: 128000,
    supportsImage: true,
    supportsTemperature: true,
    thinkingMode: 'adaptive',
    reasoningEfforts: ['low', 'medium', 'high', 'max'],
    canDisableThinking: true,
  },
  {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    contextWindow: 1000000,
    maxTokens: 128000,
    supportsImage: true,
    supportsTemperature: true,
    thinkingMode: 'adaptive',
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    canDisableThinking: true,
  },
  // -------------------------------------------------------------------------
  // LOCALLY CURATED — not from the reference snapshot. See LOCAL ADDITIONS in
  // the module doc comment, and LOCALLY_CURATED_MODEL_IDS in the fidelity test.
  // The snapshot predates this model, so the fidelity lock checks the 14 rows
  // above and asserts this id is declared as curated; it cannot check the
  // values below the way it checks a transcribed row.
  // -------------------------------------------------------------------------
  {
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    contextWindow: 1000000,
    maxTokens: 128000,
    supportsImage: true,
    // Documented as unsupported: temperature is incompatible with extended
    // thinking on this model, which is always on (same generation as the
    // opus-4-7 / opus-4-8 / opus-5 rows above, which also refuse it).
    supportsTemperature: false,
    // 'adaptive', NOT 'mid-convo' — and the difference is not cosmetic.
    // 'mid-convo' sends output_config = { effort: <named effort> ?? 'high' },
    // i.e. it FORCES high when the caller names nothing. That is right for the
    // two mid-convo rows above because the vendor documents high as their
    // default effort. This model's documented default effort is MEDIUM, so
    // 'mid-convo' here would silently outrank the model's own default and make
    // every request think — and bill — harder than the user asked for.
    // 'adaptive' sends { type: 'adaptive' }, which is the form the vendor names
    // as equivalent to omitting the field entirely.
    thinkingMode: 'adaptive',
    // All five documented effort levels, which is the full ladder this table
    // stores for any model that offers them.
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    // Thinking is ALWAYS ON for this model: the vendor documents that a request
    // sending thinking: { type: 'disabled' } — or the manual budget form
    // thinking: { type: 'enabled', budget_tokens: N } — is a 400
    // invalid_request_error, and that the only accepted forms are an omitted
    // thinking field or thinking: { type: 'adaptive' }. So "can this model be
    // told to stop thinking" is documented NO, not unknown.
    canDisableThinking: false,
  },
] as const) as readonly ClaudeModelEntry[]

/** Every id the fallback table knows, in declaration order. */
export const CLAUDE_MODEL_IDS: readonly string[] = CLAUDE_MODELS.map((model) => model.id)

/**
 * The shipped table in the shape the adapter reads before a live listing answers.
 *
 * Identical to {@link CLAUDE_MODELS}: the table is already the full snapshot, and
 * hiding an entry from the fallback would leave the user no way to reach a model
 * the account may well be entitled to. The live `GET /v1/models` narrows it.
 */
export const FALLBACK_MODELS: readonly ClaudeModelEntry[] = CLAUDE_MODELS

/**
 * Models the picker offers on a fresh install.
 *
 * `claude-opus-5-5` leads: it is the newest flagship in the table, and a fresh
 * install that has to find the best model in the model card is a worse first
 * run than one that starts on it.
 *
 * Deliberately short. The table holds both the moving alias and its pinned twin
 * for two families, so a fresh picker that leads with every row is harder to use
 * than one that leads with the general-purpose ids. The rest stay selectable
 * from the model card and are one click away.
 *
 * This list is the SHIPPED DEFAULT, and edits to it are a deliberate onboarding
 * decision rather than a no-op: a stored list that still equals the shipped
 * default counts as "never edited", and the routes and adapter read it that way
 * (see `resolveEnabledModelIds`), treating an untouched default as "the user
 * cannot have meant to hide a model the catalog added later" and falling back to
 * everything the account can call. Changing this list therefore changes what a
 * fresh install — and every install still sitting on the unedited default —
 * ends up with, not just the checkbox a new user sees ticked.
 */
export const DEFAULT_VISIBLE_MODEL_IDS: readonly string[] = [
  'claude-opus-5-5',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-opus-4-5',
]

const BY_ID = new Map(CLAUDE_MODELS.map((model) => [model.id, model]))

/**
 * Look one model up, or receive a stub that claims nothing.
 *
 * An unknown id is treated conservatively rather than optimistically, and the
 * reasoning is asymmetric: a wrong "supports images" claim sends image bytes to
 * an endpoint that rejects the whole request, while a wrong "no images" claim
 * only makes DSH show a placeholder the user can correct. The same asymmetry
 * picks the weakest thinking form and the smaller default window — a window that
 * overstates what the server grants is the error that fails hard.
 *
 * The id and name are echoed back unchanged so nothing is hidden from the user.
 */
export function resolveClaudeModel(modelId: string, catalog: readonly ClaudeModelEntry[] = CLAUDE_MODELS): ClaudeModelEntry {
  const known = catalog.find((model) => model.id === modelId)
  if (known !== undefined) return known
  return {
    id: modelId,
    name: modelId,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    supportsImage: false,
    supportsTemperature: true,
    // No evidence the id reasons. Claiming a thinking form would be a guess, and
    // the empty ladder already means no thinking field reaches the wire; 'none'
    // is the label that says so instead of naming a form nothing supports.
    thinkingMode: 'none',
    reasoningEfforts: [],
    // Nothing to disable: this stub does not assert that the model thinks.
    canDisableThinking: false,
  }
}

/** Context window this route assumes for one model, before any override. */
export function defaultContextWindowFor(modelId: string, catalog?: readonly ClaudeModelEntry[]): number {
  return resolveClaudeModel(modelId, catalog ?? CLAUDE_MODELS).contextWindow
}

/** Output cap one request asks for when the caller omits one. */
export function maxOutputTokensFor(modelId: string, catalog?: readonly ClaudeModelEntry[]): number {
  return resolveClaudeModel(modelId, catalog ?? CLAUDE_MODELS).maxTokens
}

/**
 * Thinking levels one model exposes, as a COPY.
 *
 * A copy rather than the table's own array: callers converge a configured effort
 * onto the ladder and a few of them sort or mutate what they are handed, and a
 * mutation that escaped into the frozen table would silently change every later
 * request in the process.
 */
export function claudeReasoningEfforts(modelId: string, catalog?: readonly ClaudeModelEntry[]): string[] {
  return [...resolveClaudeModel(modelId, catalog ?? CLAUDE_MODELS).reasoningEfforts]
}

/** Whether one model accepts image input. */
export function claudeModelSupportsImage(modelId: string, catalog?: readonly ClaudeModelEntry[]): boolean {
  return resolveClaudeModel(modelId, catalog ?? CLAUDE_MODELS).supportsImage
}

/** Which thinking form one model needs. */
export function claudeThinkingMode(modelId: string, catalog?: readonly ClaudeModelEntry[]): ClaudeModelEntry['thinkingMode'] {
  return resolveClaudeModel(modelId, catalog ?? CLAUDE_MODELS).thinkingMode
}

/** Whether one model accepts a temperature. */
export function claudeModelSupportsTemperature(modelId: string, catalog?: readonly ClaudeModelEntry[]): boolean {
  return resolveClaudeModel(modelId, catalog ?? CLAUDE_MODELS).supportsTemperature
}

/** Whether thinking can be turned off for one model. */
export function claudeModelCanDisableThinking(modelId: string, catalog?: readonly ClaudeModelEntry[]): boolean {
  return resolveClaudeModel(modelId, catalog ?? CLAUDE_MODELS).canDisableThinking
}
