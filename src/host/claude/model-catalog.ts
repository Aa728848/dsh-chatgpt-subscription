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
 * TWO KINDS OF ROW ARE NOT FULLY TRANSCRIBED, and they are different things.
 * Do not collapse them.
 *
 * 1. `claude-sonnet-5-5` and `claude-haiku-5-5` — the snapshot this table
 *    was copied from has no entry for either, so each whole row is CURATED:
 *    every value below comes from the vendor's own documentation and no
 *    snapshot field can check it. The mirror list in the test is
 *    `LOCALLY_CURATED_MODEL_IDS`.
 *
 * 2. `claude-opus-5-5` — a NEWER snapshot (pi-ai >= 0.87.1) does carry it, so
 *    the row sits in the snapshot's own position and EVERY field is checked
 *    against that snapshot. Exactly one field is not: `thinkingMode`, recorded
 *    in the test as `SNAPSHOT_AGREES_BUT_CURATED_WINS`. The snapshot would
 *    classify it 'mid-convo', whose form forces `output_config.effort = 'high'`
 *    when the caller names none, while the vendor documents this model's
 *    default effort as MEDIUM. Transcribing it would silently outrank the user
 *    and think — and bill — harder than asked, so the documented 'adaptive'
 *    stands. The test asserts the row still disagrees with the snapshot, so a
 *    future snapshot that agrees fails loudly and retires the entry.
 *
 * 3. `claude-haiku-5-5` (released 2026-10-07) is the second fully curated
 *    row, and the first one whose documented `canDisableThinking` is TRUE. That
 *    flag is not a free choice here and the row's own comment records why the
 *    documented answer is safe to send: `thinking: { type: 'disabled' }` is
 *    accepted at `low`/`medium`/`high` and is a 400 at `xhigh`/`max`, and this
 *    line only sends that form when the caller asked for thinking OFF, in which
 *    case it names no effort at all and the server's own default (`medium`) is
 *    what the request runs at. Its documented default effort is MEDIUM, so it is
 *    'adaptive' rather than 'mid-convo' for exactly the reason Opus 5.5 is —
 *    'mid-convo' would force `high` — and it runs the preserved-thinking prefix
 *    check, so `bindsThinkingToPrefix` is set even though the form is adaptive.
 *
 * All three must be changed together with the mirror list in the test. An
 * invented row that mimics the format of a checked one is worse than a missing
 * row: it is unverifiable and it looks verified. So each row is marked at the
 * row itself, the test asserts the id is on the curated list, and the test
 * asserts the curated list is exactly the ids the snapshot lacks — which keeps
 * the lock narrow instead of merely weaker.
 *
 * `claude-sonnet-5-5`'s fields come from the vendor's own published
 * documentation for the model (the model overview page plus the extended-thinking
 * effort page), NOT from the snapshot, and they are the values a person read off
 * those pages. That is a
 * weaker source than the snapshot and it is labelled as such: nothing here
 * proves the account is entitled to the model, and the server's own
 * `GET /v1/models` still outranks it.
 *
 * Two of that row's fields are the ones worth recording a WHY for, because both
 * look like mistakes against their neighbours:
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
 *    rule. A newer snapshot DOES flag this row `supportsMidConvoEffort` and
 *    would therefore classify it 'mid-convo' — which is exactly why this is the
 *    one declared exception rather than a transcription: 'mid-convo'
 *    additionally forces `output_config = { effort: 'high' }` when the caller
 *    names no effort. That forced high is correct for the rows whose documented
 *    default effort is high, and wrong for this one; this model's
 *    documented default effort is `medium`. Labelling it 'mid-convo' would
 *    silently override the vendor's own default and make every request think —
 *    and cost — harder than the user asked for.
 *
 * A future reader who notices the shared `supportsTemperature: false` and
 * "fixes" item 2 to 'mid-convo' has reintroduced exactly that bug.
 *
 * One more field on `claude-opus-5-5` comes from neither source: its
 * `minCliVersion` floor is the number upstream itself states when it refuses
 * the model (`claude_code_version_too_old`, "version 2.1.280 or newer is
 * required"). That
 * is a stronger witness than a documentation page — the server said it — and it
 * is recorded here so a claim below it is refused locally, before the request is
 * sent, instead of as an upstream 400 that names neither the model nor the number
 * the user has to reach.
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
  /**
   * Lowest reported client version upstream serves this model to, when known.
   *
   * ABSENT MEANS "NO KNOWN FLOOR", WHICH IS NOT THE SAME AS "NO FLOOR". Upstream
   * enforces a minimum reported client version per model and answers a claim
   * below it with HTTP 400 / `claude_code_version_too_old`
   * ({@link ERROR_CODE_CLIENT_VERSION_TOO_OLD} in types.ts, whose doc comment
   * states the invariant that ties this field to `CLAUDE_CLI_VERSION`). Most
   * rows here predate any reason to record a number, and a floor that is guessed
   * is worse than one that is absent in both directions: too low and the request
   * still reaches the server and is refused there, too high and this line
   * refuses a model the user could actually call. So the field is set ONLY where
   * a floor has been observed, and a reader must never read its absence as
   * evidence that a model accepts any client version.
   *
   * The value is a dotted numeric version compared by
   * `compareDottedVersions` / `meetsDottedVersionFloor` in types.ts.
   */
  minCliVersion?: string
  /**
   * Whether the vendor documents this model as running the preserved-thinking
   * PREFIX CHECK (today: Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5). On accounts
   * created on or after 2026-08-31 a replayed thinking block whose prefix (system, tools,
   * earlier messages) changed is then a 400 on every retry, unless the request
   * sets `block_binding.prefix_mismatch_behavior: 'drop_block'`. DSH edits that
   * prefix in normal use (compaction, a changed tool list, image offload), so
   * the adaptive form adds the binding for these models; 'mid-convo' always
   * sends it. Absent means not documented as checking.
   */
  bindsThinkingToPrefix?: boolean
}

/**
 * Seventeen rows: the snapshot's own 15, in the snapshot's own declaration order,
 * followed by the two rows the snapshot still predates (see LOCAL ADDITIONS above).
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
  // TRANSCRIBED row that keeps ONE field from the vendor's documentation. The
  // reference snapshot (pi-ai >= 0.87.1) DOES carry this model, and the
  // fidelity lock checks every field below against it — except `thinkingMode`,
  // the declared exception recorded in SNAPSHOT_AGREES_BUT_CURATED_WINS in the
  // fidelity test. Transcribing that field would force effort=high when the
  // caller names none, outranking this model's documented MEDIUM default. The
  // field's own comment below carries the reasoning.
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
    // OBSERVED, not inferred: this model is refused with
    // claude_code_version_too_old whose text names "version 2.1.280 or newer"
    // as the requirement, so the floor is a number upstream stated rather than a
    // guess about how new a model is. It is the reason CLAUDE_CLI_VERSION had to
    // move off 2.1.251, and the reason the field exists at all: with the floor
    // recorded here, a version that is too low is refused LOCALLY, before the
    // request is sent, instead of as an opaque upstream 400 that names neither
    // the model nor the number the user has to reach.
    //
    // This is the ONLY row in the table carrying a floor. Do not spread the
    // value to its neighbours and do not invent floors for them: see the
    // interface doc comment for why an absent floor is the honest value.
    minCliVersion: '2.1.280',
    // Documented as running the preserved-thinking prefix check. This is what
    // lets it stay 'adaptive' (no forced effort) and still send block_binding.
    bindsThinkingToPrefix: true,
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
  // The snapshot this checkout was transcribed against predates this model, so
  // the fidelity lock checks the rows above and asserts this id is declared as
  // curated; it cannot check the values below the way it checks a transcribed
  // row. Its own assertions are written from the vendor's documentation.
  // -------------------------------------------------------------------------
  {
    id: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    contextWindow: 1000000,
    maxTokens: 128000,
    supportsImage: true,
    // Documented: a non-default temperature, top_p or top_k is a 400.
    supportsTemperature: false,
    // 'mid-convo', and here — unlike Opus 5.5 above — that is the documented
    // choice, for two reasons that both come from the vendor's pages:
    // 1. its documented default effort is HIGH, so the form's forced
    //    `effort: 'high'` when the caller names none IS the model's own default;
    // 2. its thinking blocks are bound to the conversation prefix, and for
    //    accounts created on or after 2026-08-31 a replay after any prefix edit
    //    (system, tools, an earlier message) is a 400 unless the request sets
    //    block_binding.prefix_mismatch_behavior = 'drop_block' — the field this
    //    form sends. DSH folds later system messages into the system prompt, so
    //    that edit is not hypothetical here.
    // The newer reference (pi-ai 0.99.1) flags this model supportsMidConvoEffort,
    // which is the same verdict.
    thinkingMode: 'mid-convo',
    // All five documented effort levels; 'minimal' maps to null in the newer
    // reference, so the ladder starts at 'low'.
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    // Documented: thinking: { type: 'disabled' } is a 400 that points to
    // 'between_tools', and the manual budget form is a 400 too. 'between_tools'
    // is not a form this line sends, so thinking cannot be turned off here.
    canDisableThinking: false,
    // No floor recorded: none has been OBSERVED for this model (see the
    // interface doc comment). It first shipped in Claude Code 2.1.284, and
    // CLAUDE_CLI_VERSION is kept at or above that release instead.
    // Documented prefix-check model; 'mid-convo' already sends the binding.
    bindsThinkingToPrefix: true,
  },
 {
    id: 'claude-haiku-5-5',
    name: 'Claude Haiku 5.5',
    contextWindow: 1000000,
    maxTokens: 128000,
    supportsImage: true,
    // Documented as unsupported, and not merely "incompatible with thinking" as
    // on the opus rows: the migration guide states the request must OMIT
    // temperature, top_p and top_k. A temperature has to be 1 and a top_p has to
    // be 0.99; anything else, a top_p of 1 included, is a 400.
    supportsTemperature: false,
    // 'adaptive' for two independent reasons, and NEITHER of them is 'budget':
    // the manual budget form { type: 'enabled', budget_tokens: N } is a 400 on
    // this model, so the row that inherited 'budget' from claude-haiku-4-5 would
    // send a request the model refuses outright.
    //
    // And NOT 'mid-convo', which is the subtle one. This model's documented
    // default effort is MEDIUM, and 'mid-convo' sends
    // output_config = { effort: <named> ?? 'high' } — it forces high whenever the
    // caller names nothing, so the row would think — and bill — a rung harder
    // than the vendor's own default. Same reasoning, and same deliberate
    // divergence, as claude-opus-5-5 above.
    thinkingMode: 'adaptive',
    // All five documented levels. 'minimal' is not among them: this is the first
    // Haiku model with effort levels at all, and the ladder starts at 'low'.
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    // TRUE, and the only curated row that says so. The vendor documents the
    // asymmetry precisely: thinking: { type: 'disabled' } works at low, medium
    // and high, and is a 400 at xhigh and max.
    //
    // That is safe to encode as a plain true here because of HOW this line sends
    // the form: claudeThinking writes { type: 'disabled' } only when the caller
    // asked for thinking off, and in that case it names NO effort at all — so
    // the request runs at the server's own default (medium), which is inside the
    // documented window. The xhigh/max refusals are only reachable by naming one
    // of those levels, and naming one means thinking is on, which sends the
    // adaptive form instead. So the flag is a documented YES, not an optimistic
    // default: reading "400 above xhigh" as "cannot be disabled" would wrongly
    // take the off switch away from the levels that accept it.
    canDisableThinking: true,
    // No floor recorded: none has been OBSERVED for this model (see the interface
    // doc comment), exactly as for claude-sonnet-5-5. The model first shipped in
    // Claude Code 2.1.293, and CLAUDE_CLI_VERSION is kept at or above that
    // release instead — claiming below it is how the request would be refused.
    // Documented as a prefix-check model ("Changing earlier turns invalidates
    // thinking blocks"), so the adaptive form sends block_binding WITHOUT
    // mid-convo's forced effort — which is the whole reason the row is not
    // mid-convo.
    bindsThinkingToPrefix: true,
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
 * The list tracks ONE current model per family rather than the newest of each,
 * so a slot follows its family's newest release in place instead of growing: the
 * Haiku slot is `claude-haiku-5-5`, which replaced `claude-haiku-4-5` when that
 * model shipped. That is a deliberate swap and not a silent append — a list that
 * offered both generations of every family would be longer than the picker it
 * feeds, and the older Haiku stays one click away in the card.
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
  'claude-haiku-5-5',
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

/** Whether one model runs the documented preserved-thinking prefix check. */
export function claudeModelBindsThinkingToPrefix(modelId: string, catalog?: readonly ClaudeModelEntry[]): boolean {
  return resolveClaudeModel(modelId, catalog ?? CLAUDE_MODELS).bindsThinkingToPrefix === true
}

/** Whether thinking can be turned off for one model. */
export function claudeModelCanDisableThinking(modelId: string, catalog?: readonly ClaudeModelEntry[]): boolean {
  return resolveClaudeModel(modelId, catalog ?? CLAUDE_MODELS).canDisableThinking
}

/**
 * Lowest reported client version upstream serves one model to, when known.
 *
 * `undefined` means "no known floor" — NOT "no floor" — so a caller must treat it
 * as "nothing to check" rather than as "any version is fine". The distinction
 * matters because the caller is a pre-flight refusal: an absent floor must let
 * the request through (refusing it would invent a restriction nobody recorded),
 * while a present floor must block a claim below it.
 *
 * Unlike the other per-model lookups this one does NOT resolve through the
 * conservative stub for an unknown id. The stub describes capabilities this line
 * assumes; a version floor is a fact about the server that this line either has
 * or has not observed, and manufacturing one for an unknown id would refuse a
 * model nobody has evidence against.
 */
export function claudeMinCliVersionFor(modelId: string, catalog?: readonly ClaudeModelEntry[]): string | undefined {
  const rows = catalog ?? CLAUDE_MODELS
  return rows.find((model) => model.id === modelId)?.minCliVersion
}
