/**
 * Reasoning-collapse guard.
 *
 * A long reasoning stream can degenerate into repetition: it cycles through a
 * handful of short phrases ("Let me call. Go. Calling. Go.") without emitting a
 * tool call or concluding anything, and runs until the output-token ceiling
 * truncates it. One archived session burned 128,000 output tokens that way and
 * returned an empty answer.
 *
 * The guard scores n-gram uniqueness over a trailing window of reasoning text.
 * Healthy deliberation keeps nearly every n-gram unique and scores near zero; a
 * degenerate stream scores near one. On a hit it stops yielding chunks, so the
 * in-flight request ends, and lets the turn resume on a fresh step.
 *
 * Uniqueness alone only sees verbatim repetition. A stream can restate one
 * conclusion over and over in fresh words, score 0.48 where the threshold is
 * 0.85, and run to the output ceiling untouched. So a second, independent
 * signal scores the same window for recurrence: how strongly each sentence
 * repeats something the model already said at least `semanticLag` sentences
 * earlier. Enumerative reasoning repeats itself too, but adjacently — each item
 * borrows the previous item's frame — and recurrence ignores adjacency, which
 * is what separates the two.
 *
 * Neither signal stops anything on its own. A break needs both over their
 * thresholds in the same window, and then `semanticConfirmations` consecutive
 * such windows: one signal alone, or a single anomalous window, is logged and
 * released. That gradient is the whole design. A guard that cuts a healthy
 * answer is worse than one that lets a runaway finish, because the user sees a
 * turn stop mid-sentence with no explanation, and the fix costs a whole turn.
 *
 * Seam choice: the guard wraps `llm/stream`, not `agent/assistant-stream`.
 * `agent/assistant-stream` is emit-mode — it can observe but cannot stop a
 * stream — and it does not exist before harness 0.1.5, which would make the
 * guard a silent no-op on every generation this plugin supports below that.
 * `llm/stream` is a waterfall whose `(options, next) => AsyncIterable<StreamChunk>`
 * signature is byte-identical from 0.1.2-alpha.5 through 0.2.0-rc.1, and
 * returning early from the listener is what actually ends the stream.
 *
 * The guard subscribes to that waterfall and never reassigns `ctx.llm.stream`.
 * The harness publishes `stream` as a one-argument method that enters the
 * waterfall itself, so a property rewrite carrying a second `next` parameter
 * breaks every caller dispatching it as a method, and misses the prepared
 * call that skips the published method entirely.
 *
 * The guard rewrites nothing and appends nothing to the aborted attempt. Its
 * only model-visible input is the single resume message it queues afterwards,
 * on a fresh turn.
 *
 * Agent identity is read from the request, never remembered globally. The loop
 * stamps every request it builds with its `sessionId`, and `ctx.agents.get`
 * turns that back into the one Agent that owns the stream. Remembering "the
 * newest agent this process saw" instead was wrong twice over: a host runs one
 * Agent per session plus one per subagent, so the newest is usually a different
 * conversation, and `agent/created` fires once per Agent, so an Agent that
 * already existed when the guard installed was never reported at all. Both
 * cases cut the runaway and then resumed nothing, which reads to the user as a
 * conversation that simply stops mid-answer.
 */

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { PLUGIN_MESSAGE_SOURCE_KIND } from '../common/llm-compat.ts'

/**
 * The subset of `llm/stream` options this guard reads.
 *
 * `sessionId` is what binds a stream to the Agent that owns it, and
 * `purpose` tells a conversation call from an auxiliary one (compaction,
 * session title) that owns no turn to resume. Both are plain request fields:
 * the guard adds no generation-bound named import to learn them.
 */
export interface GuardStreamOptions {
  readonly model?: string | undefined
  readonly signal?: AbortSignal | undefined
  /** Stamped by the agent loop on every request it builds. */
  readonly sessionId?: string | undefined
  /** Absent on an ordinary conversation request; set on an auxiliary call. */
  readonly purpose?: string | undefined
}

/** A chunk as it crosses the stream boundary; only the reasoning delta is read. */
export interface GuardChunk {
  readonly type: string
  readonly text?: string | undefined
}

/** Live Agent methods the guard calls. Optional so an older shape stays loadable. */
export interface GuardAgentLike {
  /** The Agent's session identity — the same value the loop stamps on requests. */
  readonly id?: unknown
  cancel?(cause: { kind: 'hook'; reason: string }, options?: { keepInbox?: boolean }): void
  steer?(message: unknown): void
}

/** The `llm/stream` waterfall listener the guard registers. */
export type GuardStreamListener = (
  options: GuardStreamOptions,
  next: () => AsyncIterable<GuardChunk>,
) => AsyncIterable<GuardChunk>

/** The `agent/created` / `agent/disposed` listener the guard registers. */
export type GuardAgentEventListener = (payload: { agent: unknown }) => void

/** Either listener {@link ReasoningCollapseContext.on} accepts. */
export type GuardListener = GuardStreamListener | GuardAgentEventListener

/** Listener options accepted by the harness event bus. */
export interface GuardListenerOptions {
  /** Receive the event regardless of context filter checks. */
  readonly global?: boolean
}

/**
 * The Context surface the guard needs, declared structurally so it loads on
 * every supported harness generation without importing generation-bound types.
 */
export interface ReasoningCollapseContext {
  on?: (
    event: 'llm/stream' | 'agent/created' | 'agent/disposed',
    listener: GuardListener,
    options?: GuardListenerOptions,
  ) => unknown
  logger?: { warn(message: string): void } | undefined
  /**
   * The harness Agent registry, read once so a guard installed after an Agent
   * was created can still resolve it. A host without the service degrades to
   * the `agent/created` map rather than failing this plugin's load.
   */
  readonly agents?: { get(id: unknown): unknown } | undefined
}

/** Configuration for {@link installReasoningCollapseGuard}. */
export interface GuardOptions {
  /** Trailing reasoning characters scored per request (default 4096). */
  windowChars?: number
  /** Characters required before a score is computed (default 1500). */
  minWindowChars?: number
  /** Collapse score at or above which the stream is stopped (default 0.85). */
  threshold?: number
  /** N-gram size for both halves of the score (default 8). */
  ngramSize?: number
  /** Stops per turn before the guard stops resuming (default 3). */
  maxBreaksPerTurn?: number
  /** Minimum milliseconds between two stops (default 30000). */
  cooldownMs?: number
  /** Model ids to watch; empty watches every model. */
  includeModels?: string[]
  /**
   * Recurrence score at or above which the semantic signal is considered to
   * hold (default 0.35).
   *
   * Measured on the trailing window: the three healthy fixtures peak at 0.19,
   * 0.17 and 0.17 across every streaming prefix, while a paraphrased loop and
   * the verbatim loop score 0.75 and 0.99. 0.35 sits near the geometric mean
   * of that gap, roughly 1.8x above the worst healthy prefix.
   */
  semanticThreshold?: number
  /**
   * Sentences a claim must be separated from to count as recurrence
   * (default 6).
   *
   * Zero would make healthy enumeration look degenerate: item N of a list
   * legitimately shares most of its wording with item N-1. Requiring the
   * earlier sentence to be at least this far back keeps the measurement on
   * "the model said this before" rather than "the model is still on this point".
   */
  semanticLag?: number
  /**
   * Characters required before the semantic signal is scored (default 360).
   *
   * Deliberately its own floor, well below `minWindowChars`: a real trace
   * emitted 16 steps of which only one crossed 1500 characters, so the
   * literal signal saw a single step of a whole turn. The two floors are
   * separate knobs because they answer different questions — the literal one
   * is about how much text a duplicate needs to be visible in, the semantic
   * one about how much text a recurrence needs to be measurable in.
   */
  semanticMinChars?: number
  /** Sentences required before recurrence is scored (default 8). */
  semanticMinSentences?: number
  /**
   * Consecutive windows in which both signals must hold before a break
   * (default 3).
   *
   * Counted independently of the per-turn break budget, which bounds how often
   * the guard may act, not how sure it must be. A stream delivers a scoring
   * window every few dozen characters, so three confirmations cost a few
   * hundred wasted tokens against a runaway measured in the tens of thousands.
   */
  semanticConfirmations?: number
  /**
   * Lowest literal score the low-literal path will act on (default 0.6).
   *
   * A paraphrased loop sits far below `threshold` — measured at 0.676 for a
   * model restating twelve conclusions in fresh words, against 0.85 for
   * verbatim repetition. So a strong semantic signal has to be allowed to
   * carry a decision the literal signal cannot make on its own.
   *
   * The floor exists because a low score is not the same as a high one: 0.6 is
   * evidence that something is repeating, 0.2 is a short trace that has not
   * repeated long enough to say anything. Measured healthy literal peaks at
   * 0.276, so 0.6 keeps a 2.2x margin over every healthy prefix.
   */
  semanticLiteralFloor?: number
  /**
   * Semantic score the low-literal path demands (default 0.45).
   *
   * Strictly greater than `semanticThreshold`, and validated as such. The literal
   * evidence on this path is weaker by construction, so the semantic evidence
   * has to be stronger: 0.45 against a measured healthy peak of 0.194 is a
   * 2.3x margin, while a paraphrase loop measures 0.77.
   */
  semanticStrictThreshold?: number
  /**
   * Most of a window's sentences may be distinct and still be eligible for the
   * low-literal path (default 0.47).
   *
   * This is the dimension that separates a model circling from a model
   * listing. Both reuse a frame heavily and both score high on recurrence, but
   * a list writes a sentence that has never been written before on every line
   * — measured at 1.000 distinct, against 0.42 for a paraphrase loop and 0.075
   * for a verbatim one. Recurrence says the wording comes back; this says
   * whether anything at all was new.
   */
  semanticDistinctCeiling?: number
  /**
   * Consecutive windows the low-literal path needs (default 5).
   *
   * Strictly greater than `semanticConfirmations`, and validated as such. The path is
   * acting on weaker evidence, so it also waits longer before it acts.
   */
  semanticStrictConfirmations?: number
  /** Injectable clock, so the cooldown is testable without a timer. */
  now?: () => number
}

/** Fully defaulted, validated options. */
export interface ResolvedGuardOptions {
  windowChars: number
  minWindowChars: number
  threshold: number
  ngramSize: number
  maxBreaksPerTurn: number
  cooldownMs: number
  includeModels: string[]
  semanticThreshold: number
  semanticLag: number
  semanticMinChars: number
  semanticMinSentences: number
  semanticConfirmations: number
  semanticLiteralFloor: number
  semanticStrictThreshold: number
  semanticDistinctCeiling: number
  semanticStrictConfirmations: number
  now: () => number
}

export const DEFAULT_GUARD_OPTIONS: ResolvedGuardOptions = {
  windowChars: 4096,
  minWindowChars: 1500,
  threshold: 0.85,
  ngramSize: 8,
  maxBreaksPerTurn: 3,
  cooldownMs: 30000,
  includeModels: [],
  semanticThreshold: 0.35,
  semanticLag: 6,
  semanticMinChars: 360,
  semanticMinSentences: 8,
  semanticConfirmations: 3,
  semanticLiteralFloor: 0.6,
  semanticStrictThreshold: 0.45,
  semanticDistinctCeiling: 0.47,
  semanticStrictConfirmations: 5,
  now: () => Date.now(),
}

function pruneUndefined(options: GuardOptions): Partial<ResolvedGuardOptions> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) result[key] = value
  }
  return result as Partial<ResolvedGuardOptions>
}

/**
 * Validate caller options fail-loud and fill in defaults. A threshold outside
 * (0,1), a minimum above the window, or a non-positive budget throws rather
 * than falling back to a value nobody chose.
 */
export function resolveGuardOptions(options: GuardOptions = {}): ResolvedGuardOptions {
  const resolved: ResolvedGuardOptions = { ...DEFAULT_GUARD_OPTIONS, ...pruneUndefined(options) }
  if (!Number.isInteger(resolved.windowChars) || resolved.windowChars < 1) {
    throw new Error(`reasoning-collapse-guard: invalid windowChars ${String(resolved.windowChars)} — must be an integer >= 1`)
  }
  if (!Number.isInteger(resolved.ngramSize) || resolved.ngramSize < 2) {
    throw new Error(`reasoning-collapse-guard: invalid ngramSize ${String(resolved.ngramSize)} — must be an integer >= 2`)
  }
  if (!Number.isInteger(resolved.minWindowChars) || resolved.minWindowChars < 1) {
    throw new Error(`reasoning-collapse-guard: invalid minWindowChars ${String(resolved.minWindowChars)} — must be an integer >= 1`)
  }
  if (resolved.minWindowChars > resolved.windowChars) {
    throw new Error(`reasoning-collapse-guard: invalid minWindowChars ${resolved.minWindowChars} — must not exceed windowChars ${resolved.windowChars}`)
  }
  if (resolved.windowChars < resolved.ngramSize) {
    throw new Error(`reasoning-collapse-guard: windowChars ${resolved.windowChars} is smaller than ngramSize ${resolved.ngramSize}`)
  }
  if (!Number.isFinite(resolved.threshold) || resolved.threshold <= 0 || resolved.threshold >= 1) {
    throw new Error(`reasoning-collapse-guard: invalid threshold ${String(resolved.threshold)} — must be strictly between 0 and 1`)
  }
  if (!Number.isInteger(resolved.maxBreaksPerTurn) || resolved.maxBreaksPerTurn < 1) {
    throw new Error(`reasoning-collapse-guard: invalid maxBreaksPerTurn ${String(resolved.maxBreaksPerTurn)} — must be an integer >= 1`)
  }
  if (!Number.isInteger(resolved.cooldownMs) || resolved.cooldownMs < 0) {
    throw new Error(`reasoning-collapse-guard: invalid cooldownMs ${String(resolved.cooldownMs)} — must be an integer >= 0`)
  }
  if (!Number.isFinite(resolved.semanticThreshold) || resolved.semanticThreshold <= 0 || resolved.semanticThreshold >= 1) {
    throw new Error(`reasoning-collapse-guard: invalid semanticThreshold ${String(resolved.semanticThreshold)} — must be strictly between 0 and 1`)
  }
  if (!Number.isInteger(resolved.semanticLag) || resolved.semanticLag < 1) {
    throw new Error(`reasoning-collapse-guard: invalid semanticLag ${String(resolved.semanticLag)} — must be an integer >= 1`)
  }
  if (!Number.isInteger(resolved.semanticMinChars) || resolved.semanticMinChars < 1) {
    throw new Error(`reasoning-collapse-guard: invalid semanticMinChars ${String(resolved.semanticMinChars)} — must be an integer >= 1`)
  }
  if (resolved.semanticMinChars > resolved.windowChars) {
    throw new Error(`reasoning-collapse-guard: invalid semanticMinChars ${resolved.semanticMinChars} — must not exceed windowChars ${resolved.windowChars}`)
  }
  if (!Number.isInteger(resolved.semanticMinSentences) || resolved.semanticMinSentences < 2) {
    throw new Error(`reasoning-collapse-guard: invalid semanticMinSentences ${String(resolved.semanticMinSentences)} — must be an integer >= 2`)
  }
  if (!Number.isInteger(resolved.semanticConfirmations) || resolved.semanticConfirmations < 1) {
    throw new Error(`reasoning-collapse-guard: invalid semanticConfirmations ${String(resolved.semanticConfirmations)} — must be an integer >= 1`)
  }
  if (!Number.isFinite(resolved.semanticLiteralFloor) || resolved.semanticLiteralFloor <= 0 || resolved.semanticLiteralFloor >= 1) {
    throw new Error(`reasoning-collapse-guard: invalid semanticLiteralFloor ${String(resolved.semanticLiteralFloor)} — must be strictly between 0 and 1`)
  }

  if (!Number.isFinite(resolved.semanticStrictThreshold) || resolved.semanticStrictThreshold <= 0 || resolved.semanticStrictThreshold >= 1) {
    throw new Error(`reasoning-collapse-guard: invalid semanticStrictThreshold ${String(resolved.semanticStrictThreshold)} — must be strictly between 0 and 1`)
  }
  // The gradient is derived rather than validated. Refusing a configuration
  // would be wrong here, because the natural way to switch a path off is to
  // move the other path's threshold past it, and that is exactly the case
  // where the low path must follow rather than fail: raising
  // `semanticThreshold` past `semanticStrictThreshold` means the caller wants
  // no semantic detection at all, not a second route to it.
  if (!Number.isFinite(resolved.semanticDistinctCeiling) || resolved.semanticDistinctCeiling <= 0 || resolved.semanticDistinctCeiling >= 1) {
    throw new Error(`reasoning-collapse-guard: invalid semanticDistinctCeiling ${String(resolved.semanticDistinctCeiling)} — must be strictly between 0 and 1`)
  }
  if (!Number.isInteger(resolved.semanticStrictConfirmations) || resolved.semanticStrictConfirmations < 1) {
    throw new Error(`reasoning-collapse-guard: invalid semanticStrictConfirmations ${String(resolved.semanticStrictConfirmations)} — must be an integer >= 1`)
  }

  if (!Array.isArray(resolved.includeModels) || resolved.includeModels.some(entry => typeof entry !== 'string')) {
    throw new Error('reasoning-collapse-guard: includeModels must be an array of strings')
  }
  if (typeof resolved.now !== 'function') {
    throw new Error('reasoning-collapse-guard: now must be a function')
  }
  // Every step of the low-literal path is at least as strict as the high one,
  // and stays that way under any configuration: it cannot demand less semantic
  // evidence, and it cannot be given a shorter fuse than the path above it.
  // The floor is clamped the same way, for the same reason — a caller who
  // lowers `threshold` below it would otherwise be rejected for configuring a
  // threshold they never named. Clamping empties the band, which leaves the
  // low path inert rather than wrong.
  resolved.semanticStrictThreshold = Math.max(resolved.semanticStrictThreshold, resolved.semanticThreshold)
  resolved.semanticStrictConfirmations = Math.max(resolved.semanticStrictConfirmations, resolved.semanticConfirmations + 1)
  resolved.semanticLiteralFloor = Math.min(resolved.semanticLiteralFloor, resolved.threshold)
  return resolved
}

/**
 * `1 - uniqueNgrams / totalNgrams` over the window.
 *
 * Scored over the whole window: a degenerate stream repeats within its own
 * trailing characters, so scoring part of the window would dilute the signal.
 * @param window - trailing reasoning characters.
 * @param n - n-gram size.
 * @returns collapse score in [0,1]; 0 means every n-gram is unique.
 */
export function collapseScore(window: string, n: number): number {
  if (window.length < n) return 0
  const grams = new Set<string>()
  let total = 0
  for (let i = 0; i + n <= window.length; i++) {
    grams.add(window.slice(i, i + n))
    total++
  }
  if (total === 0) return 0
  return 1 - grams.size / total
}
/**
 * Split reasoning text into sentences, for mixed CJK and Latin streams.
 *
 * A Chinese full stop ends a sentence whatever follows it. An ASCII `.!?` only
 * ends one when whitespace or the end of the text follows, because the same
 * characters carry out decimals, file names and version numbers
 * (`selectors.test.ts:745`, `3.14`) that must not become sentence
 * edges. Whitespace runs collapse and case folds, so a difference in spacing
 * or capitalisation cannot read as a difference in wording.
 *
 * @param text - reasoning text, typically one trailing window.
 * @returns non-empty normalized sentences, in order.
 */
export function splitSentences(text: string): string[] {
  const parts: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    const next = text[i + 1]
    const cjk = CJK_TERMINATORS.has(char)
    const latin = LATIN_TERMINATORS.has(char) && (next === undefined || TRAILING_SPACE.test(next))
    if (!cjk && !latin) continue
    parts.push(text.slice(start, i + 1))
    start = i + 1
  }
  parts.push(text.slice(start))
  const sentences: string[] = []
  for (const part of parts) {
    const normalized = part.replace(WHITESPACE_RUN, ' ').trim().toLowerCase()
    if (normalized.length > 0) sentences.push(normalized)
  }
  return sentences
}

/** The three Chinese sentence terminators, which need no trailing space. */
const CJK_TERMINATORS: ReadonlySet<string> = new Set(['\u3002', '\uff01', '\uff1f'])
/** The three ASCII terminators, which only close a sentence before whitespace. */
const LATIN_TERMINATORS: ReadonlySet<string> = new Set(['.', '!', '?'])
const TRAILING_SPACE = /\s/
const WHITESPACE_RUN = /\s+/g

/** Character n-grams of one normalized sentence, as a set. */
function sentenceGrams(sentence: string): Set<string> {
  const grams = new Set<string>()
  for (let i = 0; i + SEMANTIC_NGRAM_SIZE <= sentence.length; i++) {
    grams.add(sentence.slice(i, i + SEMANTIC_NGRAM_SIZE))
  }
  return grams
}

function gramJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const gram of a) {
    if (b.has(gram)) shared++
  }
  return shared / (a.size + b.size - shared)
}

/**
 * How strongly a window keeps returning to sentences it already stated.
 *
 * Each sentence is compared against every sentence at least `lag` positions earlier
 * and keeps the best match; the score is the mean of those best matches. The
 * comparison is normalized (Jaccard), so two sentences match on shared wording
 * rather than on shared length, and character n-grams are used rather than words
 * because no tokenizer is available here, and none would survive a CJK/Latin
 * mix without segmenting Chinese first.
 *
 * Two properties matter more than the exact number. The score saturates — a
 * twelve-sentence loop and a four-hundred-sentence one both approach one — so
 * it does not drift with length the way a mean pairwise similarity does, and
 * it does not reward a long answer merely for containing more pairs. And the
 * lag is what makes it safe to ship: healthy enumeration reuses its framing
 * from the sentence immediately before, which this metric cannot see.
 *
 * @param window - trailing reasoning characters.
 * @param lag - sentences a claim must be separated from to count as recurrence.
 * @returns recurrence score in [0,1]; 0 means nothing recurs, or too little text to tell.
 */
export function semanticRecurrence(window: string, lag: number): number {
  return sentenceRecurrence(splitSentences(window), lag)
}

/** {@link semanticRecurrence} over sentences the caller has already split. */
function sentenceRecurrence(sentences: readonly string[], lag: number): number {
  const grams = sentences.map(sentenceGrams)
  if (grams.length <= lag) return 0
  let total = 0
  let counted = 0
  for (let i = lag; i < grams.length; i++) {
    const current = grams[i]!
    let best = 0
    for (let j = 0; j <= i - lag; j++) {
      const earlier = grams[j]!
      // Jaccard cannot exceed the smaller set over the larger, so a pair that
      // cannot beat the running best is never intersected.
      const ceiling = Math.min(current.size, earlier.size) / Math.max(current.size, earlier.size)
      if (ceiling <= best) continue
      const similarity = gramJaccard(current, earlier)
      if (similarity > best) best = similarity
    }
    total += best
    counted++
  }
  return counted === 0 ? 0 : total / counted
}

/** Character n-gram size both halves of the semantic signal are built on. */
const SEMANTIC_NGRAM_SIZE = 3

/**
 * The share of a window's sentences that have never been said before.
 *
 * Recurrence cannot tell a model that is circling from a model that is
 * listing, because a list reuses its frame as heavily as a loop does and
 * scores just as high. The difference is that a list writes a new sentence on
 * every line. Measured over a trailing window: 0.075 for the verbatim loop,
 * 0.42 for a paraphrase loop, 1.000 for every healthy fixture and for every
 * list shape tried.
 *
 * Equality is exact and on the normalized sentence, which is what keeps the
 * lists out. Two rows differing only by a row number are 0.86 similar by
 * `semanticRecurrence` and 1.000 distinct here, and that gap is the whole point: the
 * fuzzy measure asks whether the wording came back, this one asks whether
 * anything was new.
 *
 * @param window - trailing reasoning characters.
 * @returns distinct share in (0,1]; 1 when every sentence is unique.
 */
export function distinctSentenceRatio(window: string): number {
  return distinctRatioOf(splitSentences(window))
}

/** {@link distinctSentenceRatio} over sentences the caller already split. */
function distinctRatioOf(sentences: readonly string[]): number {
  if (sentences.length < 2) return 1
  return new Set(sentences).size / sentences.length
}

export const RESUME_HINT =
  'Your previous reasoning became repetitive and was stopped before it finished. '
  + 'Resume from what you already established instead of restarting the analysis, '
  + 'and keep the rest of this response short.'

/** The second resume message, used once a resume has also collapsed. */
export const RESUME_HINT_STRICT =
  'Your reasoning has now repeated across two attempts. Do not re-derive the '
  + 'analysis a third time. Either state the conclusion you already reached, or '
  + 'make the single next tool call that moves the task forward. Keep this '
  + 'response to a few sentences.'

/** Per-agent breaker bookkeeping, carried across the attempts of one turn. */
interface BreakerState {
  breaksThisTurn: number
  /** `-1` until the first stop, so a fresh budget is never inside its own cooldown. */
  lastBreakAt: number
  exhausted: boolean
  resuming: boolean
  /**
   * Consecutive windows in which both signals cleared the high-literal bar,
   * cleared whenever a window disagrees and whenever a break is taken.
   *
   * This is the guard's confidence, and it is deliberately not the break
   * budget: that one bounds how often the guard may act in a turn, this one
   * bounds how sure it has to be before it acts at all. The low-literal path
   * keeps its own count because it clears on different evidence and has to
   * wait longer on it.
   */
  dualStreak: number
  /** Consecutive windows clearing the stricter low-literal bar. */
  lowStreak: number
  /** Whether each lone-signal observation has already been reported this turn. */
  notedLiteralOnly: boolean
  notedSemanticOnly: boolean
}

function createBreakerState(): BreakerState {
  return {
    breaksThisTurn: 0,
    lastBreakAt: -Infinity,
    exhausted: false,
    resuming: false,
    dualStreak: 0,
    lowStreak: 0,
    notedLiteralOnly: false,
    notedSemanticOnly: false,
  }
}

/**
 * The resume message the guard queues onto the kept inbox.
 *
 * It is built with the harness message factory and carries this package's own
 * source kind, because the harness rejects a message that is not fully
 * identified: a steer payload with no `id` is refused by
 * `assertMessageEventShape` (`session event … lacks an identified message`)
 * and one with no `source` by the same check (`… has invalid source`). Either
 * refusal is thrown from `session.append` at the very moment the guard's
 * microtask steers — after the abort has already been taken — so the failure
 * surfaced as a repairable-splice violation, the attempt was already cancelled,
 * and the turn ended with the user told nothing.
 *
 * `createUserMessage` is available on every supported generation, and the
 * `dsh-chatgpt-subscription` kind is this package's own entry in the
 * merge-extensible `MessageSourceMap`, so the resume carries real provenance
 * instead of impersonating a human turn.
 */
function createResumeMessage(text: string): unknown {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: PLUGIN_MESSAGE_SOURCE_KIND,
      form: 'notice',
      summary: boundContextSummary('Reasoning collapsed; the attempt was stopped and resumed.'),
    },
  })
}

function appendWindow(current: string, addition: string, limit: number): string {
  const combined = current + addition
  return combined.length > limit ? combined.slice(-limit) : combined
}

/** An Agent's session identity as the plain string a request carries. */
function agentId(raw: unknown): string | undefined {
  const id = (raw as { id?: unknown } | null | undefined)?.id
  return typeof id === 'string' ? id : undefined
}

/**
 * The host's Agent registry, read defensively.
 *
 * A Cordis service that was never injected reads as undefined and a host
 * without the service at all must not fail this plugin's load, so both the
 * property read and the later lookup are guarded.
 */
function agentRegistry(ctx: ReasoningCollapseContext): { get(id: unknown): unknown } | undefined {
  try {
    const registry = ctx.agents
    return typeof registry?.get === 'function' ? registry : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether one request is a conversation call the guard may stop and resume.
 *
 * The loop marks its own requests, but that marker is reached through a named
 * export this plugin cannot assume on every generation it supports, so the
 * guard reads the request's own `purpose` field instead: compaction and
 * session-title calls are one-shot, own no turn to resume, and a truncated one
 * is a hard error rather than a runaway. A generation that predates the field
 * leaves it undefined, which is the pre-existing behaviour.
 */
function conversationCall(request: GuardStreamOptions): boolean {
  return request.purpose === undefined
}

/** Error text for one warn line, without importing a generation-bound helper. */
function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * Install the reasoning-collapse guard on a Context.
 *
 * The guard is inert unless the host exposes the event bus, so a harness
 * without it keeps the built-in behaviour instead of failing this plugin's
 * load.
 *
 * Resuming needs the live Agent for `cancel` and `steer`, and no supported
 * generation hands the agent to `llm/stream`. The request does, though: every
 * request the loop builds carries its `sessionId`, so the guard resolves the
 * owning Agent per request through `ctx.agents.get`, falling back to the map
 * `agent/created` fills. The per-turn break budget stays keyed on the
 * request's own abort signal, which exists for a whole turn.
 *
 * @param ctx - plugin context.
 * @param options - see {@link GuardOptions}; validated fail-loud.
 * @returns a disposer removing every listener, or undefined when the host
 * exposes no event bus.
 */
export function installReasoningCollapseGuard(
  ctx: ReasoningCollapseContext,
  options: GuardOptions = {},
): (() => void) | undefined {
  const resolved = resolveGuardOptions(options)
  if (typeof ctx.on !== 'function') return undefined
  const watched = new Set(resolved.includeModels)
  const breakers = new WeakMap<object, BreakerState>()
  // Session id -> Agent, filled by the lifecycle events. A fallback for a host
  // that exposes no registry, never the primary lookup.
  const known = new Map<string, GuardAgentLike>()

  const releaseCreated = ctx.on('agent/created', (payload: { agent: unknown }) => {
    remember(payload.agent)
  })
  const releaseDisposed = ctx.on('agent/disposed', (payload: { agent: unknown }) => {
    const id = agentId(payload.agent)
    if (id !== undefined) known.delete(id)
  })
  const releaseStream = ctx.on('llm/stream', guardStream, { global: true })

  function remember(raw: unknown): void {
    const agent = raw as GuardAgentLike | null | undefined
    if (agent === undefined || agent === null) return
    const id = agentId(agent)
    if (id !== undefined) known.set(id, agent)
  }

  /**
   * The Agent that owns one guarded request, or undefined when this host
   * cannot name it.
   *
   * The registry is authoritative and is read first: it answers for an Agent
   * created before this guard was installed, which is exactly the Agent an
   * `agent/created` listener can never report. Falling back to the newest
   * Agent this process saw would cancel and resume a different conversation.
   */
  function resolveAgent(sessionId: string | undefined): GuardAgentLike | undefined {
    if (sessionId === undefined) return undefined
    try {
      // Read per break, not once at install: a Cordis context throws when a
      // service is not injected yet, and a plugin may well load before the
      // registry that comes up moments later.
      const registered = agentRegistry(ctx)?.get(sessionId)
      if (registered !== undefined && registered !== null) return registered as GuardAgentLike
    } catch {
      // No registry, or one that refuses the id: the event-filled map answers.
    }
    return known.get(sessionId)
  }

  function breakerFor(key: object): BreakerState {
    let state = breakers.get(key)
    if (state === undefined) {
      state = createBreakerState()
      breakers.set(key, state)
    }
    return state
  }

  function watchedModel(model: string | undefined): boolean {
    if (watched.size === 0) return true
    return model !== undefined && watched.has(model)
  }

  /**
   * Stop the attempt and queue at most one resume for the turn.
   *
   * The resume is queued on a microtask because cancellation may discard
   * steering submitted while a turn is still unwinding; by the time the
   * microtask runs the abort has settled, so the wake lands on a fresh turn that
   * inherits the kept inbox.
   *
   * With no Agent to address, the runaway is still cut — that half is the whole
   * point — and the log says so, because a break that cannot resume is
   * indistinguishable from a broken turn to the user.
   */
  function breakOff(
    state: BreakerState,
    literal: number,
    semantic: number,
    path: 'high-literal' | 'low-literal',
    agent: GuardAgentLike | undefined,
    sessionId: string | undefined,
  ): void {
    state.breaksThisTurn++
    state.lastBreakAt = resolved.now()
    // The streaks belonged to the attempt that just ended. Carrying either
    // over would let the next attempt inherit confirmations it never earned.
    state.dualStreak = 0
    state.lowStreak = 0
    ctx.logger?.warn(
      `reasoning-collapse-guard: stopped degenerate reasoning on the ${path} path after `
      + `${path === 'high-literal' ? resolved.semanticConfirmations : resolved.semanticStrictConfirmations} confirmed windows `
      + `(literal ${literal.toFixed(3)}, semantic ${semantic.toFixed(3)}, `
      + `break ${state.breaksThisTurn}/${resolved.maxBreaksPerTurn}, `
      + `session ${sessionId ?? 'unidentified'}`
      + `${agent === undefined ? ', no agent to resume' : ''})`,
    )
    if (agent === undefined) return
    agent.cancel?.({ kind: 'hook', reason: 'reasoning-collapse-guard' }, { keepInbox: true })
    if (agent.steer === undefined || state.resuming) return
    state.resuming = true
    const text = state.breaksThisTurn >= 2 ? RESUME_HINT_STRICT : RESUME_HINT
    queueMicrotask(() => {
      state.resuming = false
      try {
        agent.steer?.(createResumeMessage(text))
      } catch (error) {
        // The break is already taken; a resume that cannot be built must not
        // vanish into an unhandled rejection on top of it.
        ctx.logger?.warn(`reasoning-collapse-guard: could not queue the resume: ${describeError(error)}`)
      }
    })
  }

  /**
   * Report one signal holding without the other.
   *
   * Reported once per kind per turn, not once per window: a runaway can hold
   * one signal for hundreds of windows, and a line each would bury the report
   * of the one that mattered. This is the diagnostic half of the gradient —
   * the reason a near miss is still diagnosable after the fact.
   */
  function noteLoneSignal(
    state: BreakerState,
    kind: 'literal' | 'semantic',
    literal: number | undefined,
    semantic: number | undefined,
    sessionId: string | undefined,
  ): void {
    if (kind === 'literal' ? state.notedLiteralOnly : state.notedSemanticOnly) return
    if (kind === 'literal') state.notedLiteralOnly = true
    else state.notedSemanticOnly = true
    ctx.logger?.warn(
      `reasoning-collapse-guard: observed the ${kind} signal alone `
      + `(literal ${literal === undefined ? 'not scored' : literal.toFixed(3)}, `
      + `semantic ${semantic === undefined ? 'not scored' : semantic.toFixed(3)}, `
      + `session ${sessionId ?? 'unidentified'}) — the other signal has not agreed, not acting`
    )
  }

  /**
   * Report a run of agreeing windows that ended before it reached the count.
   *
   * Without this, two short runs of agreeing windows look in the log exactly
   * like one long one that simply stopped short, and the confirmation count
   * becomes impossible to reason about after the fact.
   */
  function noteStreakCleared(state: BreakerState, reached: number, sessionId: string | undefined): void {
    ctx.logger?.warn(
      `reasoning-collapse-guard: the signals stopped agreeing after ${reached} `
      + `of ${resolved.semanticConfirmations} windows (session ${sessionId ?? 'unidentified'}) — streak cleared, not acting`
    )
  }

  /** Report the low-literal run that ended before it reached its longer count. */
  function noteLowStreakCleared(reached: number, sessionId: string | undefined): void {
    ctx.logger?.warn(
      `reasoning-collapse-guard: the low-literal bars stopped holding after ${reached} `
      + `of ${resolved.semanticStrictConfirmations} windows (session ${sessionId ?? 'unidentified'}) — streak cleared, not acting`
    )
  }

  /** Report a low-literal window that qualifies but has not been confirmed enough. */
  function notePendingLowConfirmation(
    state: BreakerState,
    literal: number,
    semantic: number,
    distinct: number,
    sessionId: string | undefined,
  ): void {
    ctx.logger?.warn(
      `reasoning-collapse-guard: low-literal bars hold in window ${state.lowStreak}`
      + `/${resolved.semanticStrictConfirmations} (literal ${literal.toFixed(3)} >= ${resolved.semanticLiteralFloor}, `
      + `semantic ${semantic.toFixed(3)} >= ${resolved.semanticStrictThreshold}, `
      + `distinct ${distinct.toFixed(3)} <= ${resolved.semanticDistinctCeiling}, `
      + `session ${sessionId ?? 'unidentified'}) — not acting yet`
    )
  }

  /**
   * Report a window where both signals held but the streak is still short.
   *
   * `semanticConfirmations` is what makes a break a decision rather than a
   * reflex, so each pending confirmation is named, and the log then says how
   * close a stream came to being cut by a guard that did not cut it.
   */
  function notePendingConfirmation(
    state: BreakerState,
    literal: number,
    semantic: number,
    sessionId: string | undefined,
  ): void {
    ctx.logger?.warn(
      `reasoning-collapse-guard: both signals hold in window ${state.dualStreak}`
      + `/${resolved.semanticConfirmations} (literal ${literal.toFixed(3)}, `
      + `semantic ${semantic.toFixed(3)}, session ${sessionId ?? 'unidentified'}) — not acting yet`
    )
  }

  function guardStream(
    request: GuardStreamOptions,
    next: () => AsyncIterable<GuardChunk>,
  ): AsyncIterable<GuardChunk> {
    // The break budget is keyed on the request's own abort signal: it spans a
    // whole turn, so every attempt inside one turn shares a budget and a new
    // turn starts from a clean one. The static instance backs the rare request
    // that carries no signal.
    const key: object = request.signal ?? STATIC_KEY
    const state = breakerFor(key)
    if (state.exhausted || !watchedModel(request.model) || !conversationCall(request)) return next()
    // Resolved once per attempt: the owning Agent is a property of the
    // request, so it cannot change between chunks of one stream.
    const agent = resolveAgent(request.sessionId)

    async function* guarded(): AsyncIterable<GuardChunk> {
      let window = ''
      for await (const chunk of next()) {
        // A new content block closes the previous one. The window resets here so
        // an attempt retried inside the same turn is scored on its own output.
        if (chunk.type === 'block-start') window = ''
        if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
          window = appendWindow(window, chunk.text, resolved.windowChars)
          if (resolved.now() - state.lastBreakAt >= resolved.cooldownMs) {
            // The two signals are floored separately and on purpose. The
            // literal one keeps `minWindowChars` and its exact old condition,
            // so nothing about verbatim detection moves; the semantic one has
            // its own floor because a real trace emitted sixteen steps of which
            // one crossed 1500 characters, and a gate the text almost never
            // reaches is a gate that never fires.
            const literal = window.length >= resolved.minWindowChars
              ? collapseScore(window, resolved.ngramSize)
              : undefined
            const sentences = window.length >= resolved.semanticMinChars
              ? splitSentences(window)
              : []
            const semantic = sentences.length >= resolved.semanticMinSentences
              ? sentenceRecurrence(sentences, resolved.semanticLag)
              : undefined
            const distinct = sentences.length >= resolved.semanticMinSentences
              ? distinctRatioOf(sentences)
              : undefined
            // Both, or neither counts. One signal is evidence, not a verdict.
            //
            // Two paths, and the second is stricter at every step. The high one
            // is the original rule and is unchanged. The low one exists because
            // a paraphrased loop measures 0.676 literally and can never reach
            // 0.85, so without it the only thing the semantic signal does is
            // corroborate a decision the literal signal had already made. It
            // pays for the weaker literal evidence with a higher semantic bar,
            // a novelty bar the high path does not need, and more confirmations:
            // weaker evidence, more of it, and longer.
            const high = literal !== undefined && literal >= resolved.threshold
              && semantic !== undefined && semantic >= resolved.semanticThreshold
            const low = literal !== undefined
              && literal >= resolved.semanticLiteralFloor && literal < resolved.threshold
              && semantic !== undefined && semantic >= resolved.semanticStrictThreshold
              && distinct !== undefined && distinct <= resolved.semanticDistinctCeiling
            // Both streaks are advanced first, and every reset is reported
            // there, because a run can end on a window the other path claims:
            // otherwise a streak silently returns to zero on exactly the
            // window a reader would want to see it happen.
            const reachedHigh = state.dualStreak
            const reachedLow = state.lowStreak
            state.dualStreak = high ? reachedHigh + 1 : 0
            state.lowStreak = low ? reachedLow + 1 : 0
            if (reachedHigh !== 0 && state.dualStreak === 0) noteStreakCleared(state, reachedHigh, request.sessionId)
            if (reachedLow !== 0 && state.lowStreak === 0) noteLowStreakCleared(reachedLow, request.sessionId)
            if (high && state.dualStreak >= resolved.semanticConfirmations) {
              if (state.breaksThisTurn >= resolved.maxBreaksPerTurn) {
                state.exhausted = true
              } else {
                breakOff(state, literal, semantic, 'high-literal', agent, request.sessionId)
                // Returning here is what ends the in-flight stream: the harness
                // never receives a finish chunk for the truncated attempt.
                return
              }
            } else if (low && state.lowStreak >= resolved.semanticStrictConfirmations) {
              if (state.breaksThisTurn >= resolved.maxBreaksPerTurn) {
                state.exhausted = true
              } else {
                breakOff(state, literal, semantic, 'low-literal', agent, request.sessionId)
                return
              }
            } else if (high) {
              notePendingConfirmation(state, literal, semantic, request.sessionId)
            } else if (low) {
              notePendingLowConfirmation(state, literal, semantic, distinct!, request.sessionId)
            } else {
              if (literal !== undefined && literal >= resolved.threshold) {
                noteLoneSignal(state, 'literal', literal, semantic, request.sessionId)
              } else if (semantic !== undefined && semantic >= resolved.semanticThreshold) {
                noteLoneSignal(state, 'semantic', literal, semantic, request.sessionId)
              }
            }
          }
        }
        yield chunk
      }
    }

    return guarded()
  }

  return () => {
    releaseListener(releaseStream)
    releaseListener(releaseCreated)
    releaseListener(releaseDisposed)
    known.clear()
  }
}

/** Shared key for the rare request that carries no abort signal. */
const STATIC_KEY: object = {}

/** Cordis event handles are either a disposer function or a disposable object. */
function releaseListener(handle: unknown): void {
  if (typeof handle === 'function') {
    handle()
    return
  }
  const disposable = handle as { dispose?: () => void } | null | undefined
  disposable?.dispose?.()
}