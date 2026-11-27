/**
 * Per-model capabilities for the Claude subscription line.
 */

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
  /**
   * max_tokens the official Claude Code sends when nothing overrides it (its
   * per-model `max_output_tokens.default`); `maxTokens` stays the upper limit.
   * Absent means the official fallback of 32,000, capped at `maxTokens`.
   */
  defaultMaxTokens?: number
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
  /** Subscription fast-mode support; absent falls back to the captured capability map. */
  fastMode?: 'ga' | 'beta' | null
  /** Official context_management clear_thinking support. Adaptive rows default true. */
  contextEditing?: boolean
  /** Runtime or binary override for in-place system messages. */
  midConversationSystem?: boolean
}

/**
 * Eighteen rows: the snapshot's own seventeen, plus Fable 5.2 from official
 * catalog 5102 (see LOCAL ADDITIONS above).
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
    defaultMaxTokens: 64000,
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
    defaultMaxTokens: 64000,
    supportsImage: true,
    supportsTemperature: true,
    thinkingMode: 'mid-convo',
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    canDisableThinking: false,
  },
  // Official model catalog 5102. The default effort is MEDIUM, so adaptive
  // preserves the vendor default; per_turn_effort still gets prefix binding.
  {
    id: 'claude-fable-5-2',
    name: 'Claude Fable 5.2',
    contextWindow: 1000000,
    maxTokens: 128000,
    defaultMaxTokens: 128000,
    supportsImage: true,
    supportsTemperature: false,
    thinkingMode: 'adaptive',
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    canDisableThinking: false,
    bindsThinkingToPrefix: true,
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5 (latest)',
    contextWindow: 200000,
    maxTokens: 64000,
    defaultMaxTokens: 32000,
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
    defaultMaxTokens: 32000,
    supportsImage: true,
    supportsTemperature: true,
    thinkingMode: 'budget',
    reasoningEfforts: ['low', 'medium', 'high'],
    canDisableThinking: true,
  },
  // TRANSCRIBED row that keeps TWO fields from the vendor's documentation
  // (`thinkingMode` and `canDisableThinking`, recorded in
  // SNAPSHOT_AGREES_BUT_CURATED_WINS in the fidelity test). The reference
  // snapshot (pi-ai >= 1.1.0) carries this model in this position, and every
  // other field below is checked against it.
  {
    id: 'claude-haiku-5-5',
    name: 'Claude Haiku 5.5',
    contextWindow: 1000000,
    maxTokens: 128000,
    defaultMaxTokens: 128000,
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
    // divergence, as claude-opus-5-5 below.
    thinkingMode: 'adaptive',
    // All five documented levels. 'minimal' is not among them: this is the first
    // Haiku model with effort levels at all, and the ladder starts at 'low'.
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    // TRUE, and the only curated divergence on this flag. The vendor documents the
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
  {
    id: 'claude-opus-4-5',
    name: 'Claude Opus 4.5 (latest)',
    contextWindow: 200000,
    maxTokens: 64000,
    defaultMaxTokens: 32000,
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
    defaultMaxTokens: 32000,
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
    defaultMaxTokens: 64000,
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
    defaultMaxTokens: 64000,
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
    defaultMaxTokens: 64000,
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
    defaultMaxTokens: 64000,
    supportsImage: true,
    supportsTemperature: false,
    thinkingMode: 'mid-convo',
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    // Accepted at high or below; the disabled path leaves effort unset.
    canDisableThinking: true,
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
    defaultMaxTokens: 128000,
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
  // Sonnet 4.5 has a 200k standard window; this adapter does not request the 1M beta.
  {
    id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5 (latest)',
    contextWindow: 200000,
    maxTokens: 64000,
    defaultMaxTokens: 32000,
    supportsImage: true,
    supportsTemperature: true,
    thinkingMode: 'budget',
    reasoningEfforts: ['low', 'medium', 'high'],
    canDisableThinking: true,
  },
  {
    id: 'claude-sonnet-4-5-20250929',
    name: 'Claude Sonnet 4.5',
    contextWindow: 200000,
    maxTokens: 64000,
    defaultMaxTokens: 32000,
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
    defaultMaxTokens: 32000,
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
    defaultMaxTokens: 64000,
    supportsImage: true,
    supportsTemperature: true,
    thinkingMode: 'adaptive',
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    canDisableThinking: true,
  },
  // TRANSCRIBED row (carried in the reference snapshot from pi-ai >= 1.1.0),
  // whose snapshot fields agree with the vendor's documentation on every
  // transcribed column.
  {
    id: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    contextWindow: 1000000,
    maxTokens: 128000,
    defaultMaxTokens: 128000,
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
    // The newer reference (pi-ai >= 0.99.1) flags this model supportsMidConvoEffort,
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
 * The capability shape an id this line has never heard of inherits.
 */
export const CLAUDE_CURRENT_MODEL_CAPABILITIES: Omit<ClaudeModelEntry, 'id' | 'name'> = {
  contextWindow: 1_000_000,
  maxTokens: 128_000,
  supportsImage: true,
  supportsTemperature: false,
  thinkingMode: 'adaptive',
  reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  canDisableThinking: false,
  bindsThinkingToPrefix: true,
  fastMode: null,
  contextEditing: true,
  midConversationSystem: true,
}

/** Captured fast-mode capabilities; GA vs beta is an upstream entitlement distinction. */
const CLAUDE_FAST_MODE_CAPABILITIES: Readonly<Record<string, 'ga' | 'beta'>> = Object.freeze({
  'claude-fable-5-2': 'ga',
  'claude-mythos-5-2': 'ga',
  'claude-opus-5-5': 'ga',
  'claude-opus-5': 'beta',
  'claude-opus-4-8': 'beta',
})

/**
 * Look one model up, or receive the current-model template.
 *
 * A known id resolves to its own row. An unknown one resolves to
 * {@link CLAUDE_CURRENT_MODEL_CAPABILITIES} rather than to a claim-nothing
 * stub — see that constant's doc comment for why "claims nothing" is the
 * worse answer for an id the server named but this table has not caught up
 * with.
 */
export function resolveClaudeModel(modelId: string, catalog: readonly ClaudeModelEntry[] = CLAUDE_MODELS): ClaudeModelEntry {
  const known = catalog.find((model) => model.id === modelId)
  const resolved: ClaudeModelEntry = known ?? {
    id: modelId,
    name: modelId,
    ...CLAUDE_CURRENT_MODEL_CAPABILITIES,
    // A copy, so a caller that mutates the ladder cannot reach the template
    // itself (the same reason {@link claudeReasoningEfforts} copies).
    reasoningEfforts: [...CLAUDE_CURRENT_MODEL_CAPABILITIES.reasoningEfforts],
  }
  if (modelId === 'claude-mythos-5') {
    // Binary catalog 2.1.330: no adaptive_thinking, effort, context_management or
    // mid-conversation tool-change capability. Live availability remains unverified.
    return {
      ...resolved,
      // Official default 64K within a 128K limit (binary table 2.1.318).
      defaultMaxTokens: 64_000,
      thinkingMode: 'budget',
      reasoningEfforts: [],
      canDisableThinking: true,
      bindsThinkingToPrefix: false,
      fastMode: null,
      contextEditing: false,
      midConversationSystem: false,
    }
  }
  return resolved
}

/**
 * The models the vendor documents as accepting a MID-CONVERSATION system
 * message — a `{"role": "system"}` entry inside `messages`, at the point in
 * the conversation where the instruction starts to apply.
 *
 * TRANSCRIBED from the vendor's own "Mid-conversation system messages and tool
 * changes" page, whose supported-model list names exactly these eleven models:
 * Claude Fable 5.2, Claude Fable 5.1, Claude Mythos 5.1, Claude Fable 5, Claude Mythos 5, Claude
 * Mythos Preview, Claude Opus 5.5, Claude Opus 4.8, Claude Opus 5, Claude Sonnet
 * 5.5 and Claude Haiku 5.5. No beta header is required for the feature.
 *
 * TWO ABSENCES ARE LOAD-BEARING and are the reason this is a list rather than
 * a family rule:
 *
 * - Claude Sonnet 5 is NOT on it. The vendor says so in as many words: "This
 *   feature is not available on Claude Sonnet 5. Use the top-level `system`
 *   field there instead."
 * - The 4.x rows are not on it either, and neither are the Haiku 4.5 rows.
 *
 * A model that is not on this list keeps the FOLDED behaviour: its historical
 * system messages are concatenated into the top-level `system` field, exactly
 * as before.
 */
export const CLAUDE_MID_CONVERSATION_SYSTEM_MESSAGE_MODEL_IDS: readonly string[] = Object.freeze([
  'claude-fable-5-2',
  'claude-fable-5-1',
  'claude-mythos-5-1',
  'claude-fable-5',
  'claude-mythos-preview',
  'claude-opus-5-5',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
])

/**
 * Whether one model keeps a historical `role: "system"` message IN PLACE
 * inside `messages` rather than folding it into the top-level `system`
 * field.
 *
 * The rule has two branches and the SECOND one is the surprising one:
 *
 * 1. A model the vendor documents as supporting mid-conversation system
 *    messages keeps them in place. Folding one into the top-level `system`
 *    field moves it to the HEAD of the request, which changes the cached
 *    prefix from its first byte and invalidates the cache for the system prompt
 *    and every message after it — the exact cost the feature exists to avoid.
 *
 * 2. A model this table has NEVER HEARD OF also keeps them in place, because
 *    an unknown id inherits the current-generation template
 *    ({@link CLAUDE_CURRENT_MODEL_CAPABILITIES}), and every current-generation
 *    model is on the list above. The check is against the SHIPPED table rather
 *    than against a caller's catalog on purpose: the live listing names ids
 *    this table predates, and those ids are exactly the "unknown" case.
 *
 * A model that IS known and is NOT on the list keeps the folded behaviour: the
 * top-level `system` field is the only place its instructions can live.
 */
export function claudeSupportsMidConversationSystemMessages(modelId: string, catalog?: readonly ClaudeModelEntry[]): boolean {
  const entry = resolveClaudeModel(modelId, catalog ?? CLAUDE_MODELS)
  if (entry.midConversationSystem !== undefined) return entry.midConversationSystem
  return CLAUDE_MID_CONVERSATION_SYSTEM_MESSAGE_MODEL_IDS.includes(modelId)
}

/** Context window this route assumes for one model, before any override. */
export function defaultContextWindowFor(modelId: string, catalog?: readonly ClaudeModelEntry[]): number {
  return resolveClaudeModel(modelId, catalog ?? CLAUDE_MODELS).contextWindow
}

/** Output cap one request asks for when the caller omits one. */
export function maxOutputTokensFor(modelId: string, catalog?: readonly ClaudeModelEntry[]): number {
  return resolveClaudeModel(modelId, catalog ?? CLAUDE_MODELS).maxTokens
}

/** The official client's fallback default for a model its table does not describe. */
export const CLAUDE_CODE_FALLBACK_MAX_TOKENS = 32_000

/** max_tokens the official Claude Code sends for this model by default, never above its limit. */
export function defaultMaxTokensFor(modelId: string, catalog?: readonly ClaudeModelEntry[]): number {
  const entry = resolveClaudeModel(modelId, catalog ?? CLAUDE_MODELS)
  return Math.min(entry.defaultMaxTokens ?? CLAUDE_CODE_FALLBACK_MAX_TOKENS, entry.maxTokens)
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

export function claudeFastModeFor(modelId: string, catalog?: readonly ClaudeModelEntry[]): 'ga' | 'beta' | null {
  const entry = resolveClaudeModel(modelId, catalog ?? CLAUDE_MODELS)
  return entry.fastMode ?? CLAUDE_FAST_MODE_CAPABILITIES[modelId] ?? null
}

export function claudeSupportsContextEditing(modelId: string, catalog?: readonly ClaudeModelEntry[]): boolean {
  const entry = resolveClaudeModel(modelId, catalog ?? CLAUDE_MODELS)
  return entry.contextEditing ?? (entry.thinkingMode === 'adaptive' || entry.thinkingMode === 'mid-convo')
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
