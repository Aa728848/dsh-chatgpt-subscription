/**
 * Wire mapping for the Anthropic Messages API behind a SUBSCRIPTION credential.
 *
 * WHAT THIS MODULE OWNS. Everything between DSH's GenerateOptions and the bytes
 * of POST <API_BASE><MESSAGES_PATH>: the request body, and the SSE state machine
 * that turns Anthropic's line-oriented event stream back into DSH StreamChunks.
 * It holds no credential, performs no I/O, and never touches the network - the
 * adapter owns transport and it owns the line splitting. Every function here is
 * pure with respect to the wire: same options in, same body out.
 *
 * The module doc of the sibling model-catalog.ts is the authority for the
 * per-model facts used below, and every claim marked TRANSCRIBED below was read
 * out of that catalog's transcription of a locally installed reference
 * implementation rather than recalled. Claims marked CHOICE are this module's
 * own judgement and are flagged as such so a reviewer can disagree with one
 * without having to re-derive the whole file.
 *
 * ---------------------------------------------------------------------------
 * 1. THE SYSTEM ARRAY IS TWO BLOCKS AND THE FIRST ONE IS NOT OPTIONAL
 * ---------------------------------------------------------------------------
 *
 * On the subscription route the system prompt is an ARRAY of text blocks whose
 * FIRST entry must be the Claude Code identity line verbatim. This is not
 * cosmetic and not a preference: a subscription request without that identity
 * block is rejected, and the failure is a whole-turn failure rather than a
 * degraded answer. It is therefore emitted unconditionally - even when the
 * caller states no system prompt at all - and the caller's own prompt, when
 * there is one, becomes the SECOND block. See CLAUDE_CODE_IDENTITY_TEXT.
 *
 * A role: 'system' entry in options.messages is FOLDED into that same second
 * block rather than being sent as a message: the Messages wire has no system
 * role, so a system message that reached messages[] would either be rejected or
 * silently reinterpreted. The fold is order-stable (header first, then history
 * order) because the system array is the head of the prefix the server caches.
 *
 * ---------------------------------------------------------------------------
 * 2. THINKING - FOUR CASES, DISPATCHED IN THE CATALOG'S ORDER
 * ---------------------------------------------------------------------------
 *
 * claudeThinkingMode(model) decides the form, and the order of the guards is
 * the whole point:
 *
 *   mid-convo -> { type: 'adaptive', display: 'summarized',
 *                  block_binding: { prefix_mismatch_behavior: 'drop_block' } }
 *                PLUS output_config = { effort }. This case outranks
 *                everything, including a caller asking for thinking off: the
 *                block_binding exists so a prefix mismatch is dropped instead of
 *                surfacing as a persistent 400, and suppressing it is exactly
 *                how that 400 comes back.
 *   adaptive  -> { type: 'adaptive', display: 'summarized' }, plus
 *                output_config = { effort } when an effort was named. The budget
 *                form is rejected by these models.
 *   budget    -> { type: 'enabled', budget_tokens: <clamped>, display:
 *                'summarized' }.
 *   none      -> NO thinking field at all.
 *
 * Thinking OFF is a separate decision layered on top: when the caller asked for
 * it and claudeModelCanDisableThinking(model) is true, { type: 'disabled' } is
 * sent; when that predicate is false the disable request is NOT sent (the model
 * forbids it) and the model's own form is used instead - a model that always
 * thinks cannot be talked out of it, and the only honest request left is the
 * normal one. CHOICE: nothing above the predicate is this module's invention,
 * but "fall back to the model's own form" is, because the catalog only states
 * that the disable request must not be sent.
 *
 * ---------------------------------------------------------------------------
 * 3. THE BUDGET ARITHMETIC IS TRANSCRIBED, NOT RE-DERIVED
 * ---------------------------------------------------------------------------
 *
 * RULE 4 of model-catalog.ts carries the reference arithmetic with line cites.
 * adjustMaxTokensForThinking, thinkingBudgetForLevel, clampReasoning and
 * clampThinkingBudgetToAnswerRoom below reproduce it statement for statement.
 * Two traps that transcription exists to prevent:
 *
 *   1. an UNDEFINED caller cap must not be coerced to 0. Under the helper's own
 *      branch Math.min(0 + budget, modelMax) makes the thinking budget the
 *      entire response ceiling and leaves no room for an answer;
 *   2. the value passed in as baseMax is the ALREADY-RESOLVED cap
 *      (buildBaseOptions resolves options.maxTokens ?? model.maxTokens before
 *      calling the helper), so feeding an unresolved value in changes which
 *      branch runs. resolveMaxTokens below is what resolves it, and the builder
 *      passes the result - never options.maxTokens directly.
 *
 * The one deviation from the transcription is that the reference's
 * thinkingBudgetForLevel can yield undefined for a level its table does not
 * name; the reference never hits that (its level always comes from the model's
 * own ladder) while a caller here could. Every use below either substitutes the
 * middle level or treats the result as "no thinking field", and never does
 * arithmetic with undefined.
 *
 * ---------------------------------------------------------------------------
 * 4. TOOL NAMES ARE CASE-NORMALIZED, AND MAPPED BACK
 * ---------------------------------------------------------------------------
 *
 * A subscription token is served Claude Code's own tool vocabulary, and the
 * reference case-normalizes the tool names it sends to that vocabulary. So a
 * tool offered as 'bash' or 'WEBSEARCH' goes out as 'Bash' / 'WebSearch', and a
 * returned canonical name is mapped BACK to the caller's spelling, because DSH
 * dispatches on the name it declared. A name the vocabulary does not know is
 * sent unchanged: inventing a spelling for an unknown tool would rename a tool
 * the harness can no longer dispatch.
 *
 * The back-map is per request and case-insensitive, which is only sound while
 * it is unambiguous. Two offered tools that would collapse onto one wire name
 * (or onto one case-insensitive wire name) disable normalization for that
 * request entirely and send the real names, so the model's reply can never be
 * attributed to the wrong tool.
 *
 * ---------------------------------------------------------------------------
 * 5. THINKING BLOCKS ARE REPLAYED VERBATIM OR NOT AT ALL
 * ---------------------------------------------------------------------------
 *
 * A replayed thinking block must carry the signature the model produced beside
 * it: a signed block without its signature is a 400, and dropping signed
 * thinking blocks breaks multi-turn tool use under extended thinking because
 * the assistant turn that made a tool call loses the reasoning the server
 * expects to see again. redacted_thinking blocks are replayed too - they are
 * opaque to us, which is precisely why only the payload that came off the wire
 * can be sent back. A thinking block with NO signature cannot be replayed at
 * all and is dropped rather than sent unsigned.
 *
 * For that to be possible across turns, the text and the signature are carried
 * through the turn: each emitted reasoning block gets a matching entry in the
 * finish chunk's replayState envelope, and the request builder reads it back on
 * the next turn. CHOICE: the envelope shape is DSH's (the harness's
 * ReplayEnvelope), but that this line needs one at all is a consequence of the
 * rule above rather than something the catalog states.
 *
 * ---------------------------------------------------------------------------
 * 6. THE STREAM IS LINE-ORIENTED, NOT data:-ONLY
 * ---------------------------------------------------------------------------
 *
 * Anthropic sends 'event: <name>' and 'data: <json>' as separate lines, and the
 * primitive below is fed ONE line at a time. It deliberately ignores the
 * 'event:' line and dispatches on the payload's own 'type' field instead: the
 * two must agree, and if they ever disagree the JSON is the copy that carries
 * everything else. Unknown event types are ignored rather than rejected - a
 * beta this plugin does not know about must not fail a working turn - while an
 * 'error' event THROWS, because a severed reply flushed as a clean stop is a
 * wrong answer rather than a visible failure.
 *
 * Reasoning deltas are BUFFERED and emitted as one block at content_block_stop
 * (CHOICE, see emitPendingThinking): the signature that decides whether the
 * block may be replayed at all arrives at the END of the block, so a signed
 * block cannot be recognized before then, and a reasoning block that cannot be
 * replayed is not content the caller should be told it received.
 */

import {
  LlmError,
  type ContentBlock,
  type FinishReason,
  type GenerateOptions,
  type Message,
  type StreamChunk,
  type TokenUsage,
} from '../common/llm-compat.ts'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { toToolCallId } from '../common/brand-compat.ts'
import {
  claudeModelCanDisableThinking,
  claudeModelSupportsTemperature,
  claudeThinkingMode,
  maxOutputTokensFor,
} from './model-catalog.ts'
import { PROVIDER_ID } from './types.ts'

// ---------------------------------------------------------------------------
// Shape helpers
//
// Every parse here is defensive by construction: payloads come off the wire and
// this line supports several harness generations, so a shape that is not what
// was documented degrades to 'not stated' rather than throwing somewhere the
// caller cannot see it.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** Strip a NUL that would truncate the string inside a JSON encoder. */
function sanitizeText(text: string): string {
  return text.replace(/\0/g, '')
}

/**
 * Whether one failure is a cancellation rather than a real read failure.
 *
 * The check is structural rather than instanceof Error: DSH's own LlmError is
 * not the only abort-shaped value a caller produces, and a misjudged abort
 * would be converted into a model-visible placeholder, turning a cancelled read
 * into a wrong answer instead of a cancelled turn.
 */
function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true
  if (typeof error !== 'object' || error === null) return false
  return (error as { name?: unknown }).name === 'AbortError'
}

// ---------------------------------------------------------------------------
// Thinking: effort, budget, and the four-case form
// ---------------------------------------------------------------------------

/**
 * The Claude Code identity block's exact text.
 *
 * MUST be system[0] on every subscription request (see the module doc). It is a
 * single literal rather than a template so a test can compare it byte for byte.
 */
export const CLAUDE_CODE_IDENTITY_TEXT = "You are Claude Code, Anthropic's official CLI for Claude."

/** Answer room the budget clamp always leaves below the response ceiling. */
export const MIN_ANSWER_TOKENS = 1024

/**
 * Thinking budget one level asks for, before any clamp.
 *
 * TRANSCRIBED from simple-options.js lines 38-43. The values are the
 * reference's, not a preference: a different table would silently change how
 * much of the response ceiling a level spends.
 */
export const DEFAULT_THINKING_BUDGETS: Readonly<Record<string, number>> = Object.freeze({
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
})

/**
 * Level used when a caller names none, or names one the table does not know.
 *
 * CHOICE. The reference always has a level because the adapter picks one off
 * the model's own ladder; this mapper has to answer for a caller that named
 * nothing or named a level from another provider's vocabulary. The middle of
 * the table is the least surprising answer and, unlike 'high', it cannot turn a
 * modest request into one whose budget eats the whole ceiling.
 */
export const DEFAULT_THINKING_LEVEL = 'medium'

/** Caller-supplied overrides for {@link DEFAULT_THINKING_BUDGETS}. */
export type ThinkingBudgets = Readonly<Record<string, number | undefined>>

/**
 * Collapse an effort onto the levels the budget table names.
 *
 * TRANSCRIBED from simple-options.js lines 44-46: xhigh and max are the two
 * rungs the table has no entry for, and both resolve to high rather than to a
 * budget invented here.
 */
export function clampReasoning(effort: string | undefined | null): string | undefined {
  if (effort === undefined || effort === null) return undefined
  const normalized = String(effort).trim().toLowerCase()
  if (normalized === '') return undefined
  return normalized === 'xhigh' || normalized === 'max' ? 'high' : normalized
}

/**
 * Budget one level asks for, with the caller's overrides applied.
 *
 * TRANSCRIBED from simple-options.js lines 47-51. An unknown level yields
 * undefined - the reference's spread-and-index does the same - and every caller
 * below answers for that case explicitly instead of doing arithmetic with it.
 */
export function thinkingBudgetForLevel(
  level: string | undefined | null,
  customBudgets?: ThinkingBudgets,
): number | undefined {
  const table: Record<string, number | undefined> = { ...DEFAULT_THINKING_BUDGETS, ...(customBudgets ?? {}) }
  const key = clampReasoning(level)
  if (key === undefined) return undefined
  const budget = table[key]
  return typeof budget === 'number' && Number.isFinite(budget) ? budget : undefined
}

/**
 * Shrink a budget until an answer still fits under the ceiling.
 *
 * TRANSCRIBED from simple-options.js lines 52-55, and reused verbatim as the
 * wire clamp below, which the catalog writes out inline as exactly this
 * expression.
 */
export function clampThinkingBudgetToAnswerRoom(budget: number, ceiling: number): number {
  return Math.min(budget, Math.max(0, ceiling - MIN_ANSWER_TOKENS))
}

/**
 * Level {@link thinkingBudgetForLevel} should be asked about.
 *
 * A caller who named no level, or named one of the off-tokens, gets the middle
 * level rather than an undefined lookup: the budget table names no 'off' rung,
 * and a request that is going to think needs a budget fitted for it. A level
 * the table does not know at all is passed through so the arithmetic, and not
 * this function, is what reports it as unavailable.
 */
export function thinkingBudgetLevel(effort: string | undefined | null): string {
  const clamped = clampReasoning(effort)
  if (clamped === undefined || THINKING_OFF_EFFORTS.has(clamped)) return DEFAULT_THINKING_LEVEL
  return clamped
}

/**
 * Fit a thinking budget inside a response ceiling.
 *
 * TRANSCRIBED from simple-options.js lines 56-65. Read the two traps in the
 * module doc before changing a branch here:
 *
 * - baseMaxTokens === undefined means NO EXPLICIT CALLER CAP and selects the
 *   model cap; coercing it to 0 would make maxTokens equal the budget and
 *   leaving nothing for an answer;
 * - baseMaxTokens is the ALREADY-RESOLVED cap, so the caller resolves
 *   options.maxTokens ?? model.maxTokens first.
 *
 * The '?? 0' beside the budget is the deviation the module doc describes: the
 * reference would compute NaN for a level its table does not name, and an
 * unknown level is ordinary input here.
 */
export function adjustMaxTokensForThinking(
  baseMaxTokens: number | undefined,
  modelMaxTokens: number,
  reasoningLevel: string | undefined | null,
  customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number | undefined } {
  let thinkingBudget = thinkingBudgetForLevel(reasoningLevel, customBudgets)
  const maxTokens = baseMaxTokens === undefined
    ? modelMaxTokens
    : Math.min(baseMaxTokens + (thinkingBudget ?? 0), modelMaxTokens)
  if (thinkingBudget !== undefined && maxTokens <= thinkingBudget) {
    thinkingBudget = clampThinkingBudgetToAnswerRoom(thinkingBudget, maxTokens)
  }
  return { maxTokens, thinkingBudget }
}

/**
 * The response ceiling one request asks for.
 *
 * options.maxTokens ?? the model's own cap. This is the resolution step the
 * second trap refers to: an undefined caller cap becomes the MODEL cap, never
 * zero, so the thinking branch fits inside a real ceiling.
 */
export function resolveMaxTokens(options: GenerateOptions): number {
  return options.maxTokens ?? maxOutputTokensFor(options.model)
}

/**
 * Effort tokens that mean 'do not think' rather than a rung of the ladder.
 *
 * The same three spellings the sibling Kimi line accepts. Recognizing them here
 * is not a convergence table: nothing is rewritten, and a real level such as
 * 'xhigh' or 'max' passes through untouched.
 */
const THINKING_OFF_EFFORTS = new Set(['none', 'off', 'disabled'])

/** Whether one caller effort means 'thinking off'. */
export function thinkingRequestedOff(effort: string | undefined | null): boolean {
  if (effort === undefined || effort === null) return false
  return THINKING_OFF_EFFORTS.has(String(effort).trim().toLowerCase())
}

/** The thinking and output_config fields one request carries. */
export interface ClaudeThinkingFields {
  thinking?: Record<string, unknown>
  outputConfig?: Record<string, unknown>
}

/**
 * Whether one request will actually think.
 *
 * This is what decides whether the response ceiling is inflated by the level's
 * budget, and getting it wrong in the generous direction is not harmless: a
 * non-thinking model whose ceiling was raised by a budget it never had would
 * ask the server for tokens it cannot produce. mid-convo thinks whatever the
 * caller asked for; the other forms think unless the disable request is going
 * to be sent and the model allows one.
 */
export function claudeRequestThinks(model: string, effort: string | undefined | null): boolean {
  const mode = claudeThinkingMode(model)
  if (mode === 'none') return false
  if (mode === 'mid-convo') return true
  return !(thinkingRequestedOff(effort) && claudeModelCanDisableThinking(model))
}
/**
 * Dispatch the four thinking cases for one model and effort.
 *
 * The guard order is the catalog's and is load-bearing: mid-convo is checked
 * first and unconditionally, so a caller asking for thinking off on a managed
 * effort model still gets the adaptive form with its block_binding. See the
 * module doc for what each form is and why.
 *
 * @param model - exact model id, resolved through the frozen catalog.
 * @param effort - the caller's raw effort, passed through as-is.
 * @param level - the level whose budget the budget form spends.
 * @param maxTokens - the ALREADY-RESOLVED response ceiling. The budget form
 *   spends part of it, so it is the ceiling and not the budget that this
 *   function is told about.
 */
export function claudeThinking(
  model: string,
  effort: string | undefined,
  level: string,
  maxTokens: number,
  customBudgets?: ThinkingBudgets,
): ClaudeThinkingFields {
  const mode = claudeThinkingMode(model)
  if (mode === 'none') return {}

  const namedEffort = effort !== undefined && effort !== '' && !thinkingRequestedOff(effort) ? effort : undefined
  const off = thinkingRequestedOff(effort)

  // Case 1, and the guard order matters: mid-convo is unconditional. A caller
  // asking for thinking off still gets the adaptive form with its block_binding,
  // because suppressing the block_binding is exactly how the persistent 400 the
  // reference documents comes back.
  if (mode === 'mid-convo') {
    return {
      thinking: {
        type: 'adaptive',
        display: 'summarized',
        block_binding: { prefix_mismatch_behavior: 'drop_block' },
      },
      // The reference's own literal is 'high' and it sends it whether or not the
      // caller named an effort; a named one replaces it.
      outputConfig: { effort: namedEffort ?? 'high' },
    }
  }

  // A caller who asked for thinking off gets the disable request only where the
  // model allows it (cases 2 and 3 below would otherwise always outrank it). On
  // a model that forbids it the model's own form is used instead: 'off: null'
  // means the model always thinks, and the honest request is the normal one.
  if (off && claudeModelCanDisableThinking(model)) return { thinking: { type: 'disabled' } }

  if (mode === 'adaptive') {
    return {
      thinking: { type: 'adaptive', display: 'summarized' },
      ...(namedEffort === undefined ? {} : { outputConfig: { effort: namedEffort } }),
    }
  }

  // Case 3, budget: the older form, and the only one whose size is a number this
  // module chooses. The budget table has no entry for a level it does not name,
  // so the middle level answers instead of the arithmetic turning into NaN.
  const budget = thinkingBudgetForLevel(level, customBudgets)
    ?? thinkingBudgetForLevel(DEFAULT_THINKING_LEVEL, customBudgets)
  if (budget === undefined) return {}
  return {
    thinking: {
      type: 'enabled',
      budget_tokens: clampThinkingBudgetToAnswerRoom(budget, maxTokens),
      display: 'summarized',
    },
  }
}

// ---------------------------------------------------------------------------
// Tool names
// ---------------------------------------------------------------------------

/**
 * Claude Code's canonical tool spellings.
 *
 * TRANSCRIBED from the reference implementation's own tool vocabulary. The
 * order is the reference's; membership is what matters.
 */
export const CLAUDE_CODE_TOOL_NAMES: readonly string[] = Object.freeze([
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Grep',
  'Glob',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'KillShell',
  'NotebookEdit',
  'Skill',
  'Task',
  'TaskOutput',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
])

const CANONICAL_BY_LOWER_NAME = new Map(CLAUDE_CODE_TOOL_NAMES.map((name) => [name.toLowerCase(), name]))

/**
 * The canonical spelling of one tool name, or undefined when it has none.
 *
 * This is the single-name rule: case-insensitive membership, canonical output.
 */
export function canonicalClaudeToolName(name: string): string | undefined {
  return CANONICAL_BY_LOWER_NAME.get(name.trim().toLowerCase())
}

/** The per-request tool-name translation both directions of the wire share. */
export interface ClaudeToolNames {
  /** False when a collision disabled normalization; both maps are then identity. */
  enabled: boolean
  /** Caller spelling -> the name to send. */
  toWire: ReadonlyMap<string, string>
  /** Exact wire name -> caller spelling. */
  byExact: ReadonlyMap<string, string>
  /** Lower-cased wire name -> caller spelling; consulted only after byExact. */
  byLower: ReadonlyMap<string, string>
}

/**
 * Build the translation for one request's offered tools.
 *
 * Collisions disable normalization (see the module doc): the check is on the
 * WIRE name, compared exactly and case-insensitively, because both are ways for
 * one reply to be attributed to the wrong tool. Case-insensitivity is the
 * stricter half and is CHOICE: two tools spelled 'read' and 'Read' send two
 * distinct names and are therefore unambiguous on the request, but a reply of
 * 'READ' could not be attributed, and refusing to guess costs only the
 * canonical spelling.
 */
export function claudeToolNames(tools?: readonly { name: string }[]): ClaudeToolNames {
  const offered = (tools ?? []).map((tool) => tool.name).filter((name) => typeof name === 'string' && name !== '')

  const wireNames = offered.map((name) => canonicalClaudeToolName(name) ?? name)
  const seenExact = new Set<string>()
  const seenLower = new Set<string>()
  let collision = false
  for (const wireName of wireNames) {
    const lower = wireName.toLowerCase()
    if (seenExact.has(wireName) || seenLower.has(lower)) {
      collision = true
      break
    }
    seenExact.add(wireName)
    seenLower.add(lower)
  }

  const toWire = new Map<string, string>()
  const byExact = new Map<string, string>()
  const byLower = new Map<string, string>()
  for (let index = 0; index < offered.length; index++) {
    const name = offered[index] as string
    const wireName = collision ? name : (wireNames[index] as string)
    toWire.set(name, wireName)
    byExact.set(wireName, name)
    if (!byLower.has(wireName.toLowerCase())) byLower.set(wireName.toLowerCase(), name)
  }
  return { enabled: !collision, toWire, byExact, byLower }
}

/** The wire name for one caller tool name under a request's translation. */
export function claudeWireToolName(name: string, names?: ClaudeToolNames): string {
  if (names !== undefined) {
    const mapped = names.toWire.get(name)
    if (mapped !== undefined) return mapped
    return names.enabled ? (canonicalClaudeToolName(name) ?? name) : name
  }
  return canonicalClaudeToolName(name) ?? name
}

/**
 * The caller's tool name for one name the model returned.
 *
 * Exact match first, then case-insensitive: a model that relabels the case of a
 * name it was given is still talking about the tool it was given, while a
 * request that offered two names differing only by case must resolve the exact
 * one. An unknown name is returned unchanged - it is not this layer's job to
 * invent a tool.
 */
export function claudeOriginalToolName(name: string, names?: ClaudeToolNames): string {
  if (names === undefined) return name
  const exact = names.byExact.get(name)
  if (exact !== undefined) return exact
  return names.byLower.get(name.toLowerCase()) ?? name
}

// ---------------------------------------------------------------------------
// Durable request images
// ---------------------------------------------------------------------------

/** Attachment seam this route needs: verified bytes for one durable image. */
export type AttachmentImageReader = Pick<AttachmentStore, 'readImage'>

/** One durable image resolved for an in-flight request, or proven unreadable. */
export type ResolvedRequestImage =
  | { readonly kind: 'inline'; readonly mediaType: string; readonly data: string }
  | { readonly kind: 'unavailable' }

/** Resolved images keyed by durable attachment id; consumed by one request build. */
export type ResolvedRequestImages = ReadonlyMap<string, ResolvedRequestImage>

const NO_RESOLVED_IMAGES: ResolvedRequestImages = new Map()

/**
 * Base64 image payload one request may carry.
 *
 * CHOICE, bounded on both sides. Anthropic's documented request ceiling is
 * 32 MB, and its per-image ceiling is 5 MB of RAW bytes; 5 MB of raw bytes
 * expands to about 6.8 MB of base64, so a bound below that would offload a
 * single image the endpoint would have accepted. 8 MB leaves the conversation
 * text, tool schemas and system prompt room inside the 32 MB envelope while
 * still catching the runaway case locally rather than as a 413.
 */
export const MAX_REQUEST_IMAGE_BYTES = 8 * 1024 * 1024

const OMITTED_IMAGE_TEXT =
  '[image omitted to keep the request within its size limit; older images are omitted first. '
  + 'If this image is still needed, read its file again when a path is available; otherwise ask the user to attach it again.]'

/** Media types this wire accepts as inline base64. Transcribed from the API docs. */
const SUPPORTED_IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

function attachmentOf(block: Record<string, unknown>): ImageAttachmentRef | undefined {
  const attachment = block.attachment
  if (!isRecord(attachment)) return undefined
  return typeof attachment.attachmentId === 'string' ? attachment as unknown as ImageAttachmentRef : undefined
}

function attachmentLabel(block: Record<string, unknown>): string | undefined {
  const attachment = isRecord(block.attachment) ? block.attachment : undefined
  return asString(attachment?.name) || asString(attachment?.attachmentId)
}

function collectImageRefs(content: unknown, refs: Map<string, ImageAttachmentRef>): void {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'image') {
      const attachment = attachmentOf(block)
      if (attachment) refs.set(attachment.attachmentId, attachment)
      continue
    }
    // Tool results nest their own content, and a screenshot or a read_image
    // result carries its pixels there. Stopping at the top level made every
    // tool-produced image unresolvable before it could reach the wire.
    if (block.type === 'tool-result') collectImageRefs(block.content, refs)
  }
}

function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

function requestImageBytes(block: Record<string, unknown>): number | undefined {
  const attachment = attachmentOf(block)
  if (attachment) return base64Length(attachment.bytes)
  const inline = asString(block.data) || asString(block.base64)
  return inline ? inline.length : undefined
}

function collectRequestImageBytes(content: unknown, lengths: number[]): void {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'image') continue
    const bytes = requestImageBytes(block)
    if (bytes !== undefined) lengths.push(bytes)
  }
}

/**
 * Replace the oldest inline images with a text placeholder once one request
 * would carry more than {@link MAX_REQUEST_IMAGE_BYTES} of base64 image data.
 * Durable history is untouched; only the request about to be sent changes, and
 * the placeholder names the omission so the model asks for the picture again
 * instead of answering about a blank.
 */
export function offloadOldestRequestImages(options: GenerateOptions): GenerateOptions {
  const lengths: number[] = []
  for (const message of options.messages) collectRequestImageBytes(message.content, lengths)
  const excess = lengths.reduce((sum, bytes) => sum + bytes, 0) - MAX_REQUEST_IMAGE_BYTES
  if (excess <= 0) return options

  let omitted = 0
  let freed = 0
  for (const bytes of lengths) {
    if (freed >= excess) break
    freed += bytes
    omitted += 1
  }

  const remaining = { count: omitted }
  const messages = options.messages.map((message) => {
    if (remaining.count === 0 || !Array.isArray(message.content)) return message
    let replaced = false
    const content = message.content.map((block) => {
      if (remaining.count === 0 || !isRecord(block) || block.type !== 'image') return block
      if (requestImageBytes(block) === undefined) return block
      remaining.count -= 1
      replaced = true
      return { type: 'text', text: OMITTED_IMAGE_TEXT } as ContentBlock
    })
    return replaced ? { ...message, content } : message
  })
  return { ...options, messages }
}

/**
 * Read every durable { type: 'image', attachment } block one request carries.
 * An unreadable image resolves to 'unavailable' rather than disappearing, so
 * the model is told the picture is missing instead of answering about a blank.
 */
export async function resolveRequestImages(
  options: GenerateOptions,
  attachments: AttachmentImageReader | undefined,
  signal?: AbortSignal,
): Promise<ResolvedRequestImages> {
  const refs = new Map<string, ImageAttachmentRef>()
  for (const message of options.messages) collectImageRefs(message.content, refs)
  if (refs.size === 0) return NO_RESOLVED_IMAGES

  const resolved = new Map<string, ResolvedRequestImage>()
  await Promise.all([...refs].map(async ([attachmentId, ref]) => {
    if (!attachments) {
      resolved.set(attachmentId, { kind: 'unavailable' })
      return
    }
    try {
      const stored = await attachments.readImage(ref, signal)
      resolved.set(attachmentId, {
        kind: 'inline',
        mediaType: stored.ref.mediaType,
        data: Buffer.from(stored.data).toString('base64'),
      })
    } catch (error) {
      if (isAbort(error, signal)) throw error
      resolved.set(attachmentId, { kind: 'unavailable' })
    }
  }))
  return resolved
}

interface InlineImage {
  mediaType: string
  data: string
}

/**
 * Resolve one image block to its bytes, or undefined when it has none.
 *
 * The media type falls back to image/png only for the inline paths; an
 * attachment-backed block takes its media type from the verified reference
 * rather than from the block, because the block is caller-supplied while the
 * reference was written by the attachment service.
 */
function imageBlockToInline(block: Record<string, unknown>, images: ResolvedRequestImages): InlineImage | undefined {
  let data = asString(block.data) || asString(block.base64)
  const source = isRecord(block.source) ? block.source : undefined
  if (!data && source) data = asString(source.data) || asString(source.base64)
  let mediaType =
    asString(block.mimeType)
    || asString(block.mediaType)
    || (source ? asString(source.mimeType) || asString(source.mediaType) : undefined)
    || 'image/png'

  if (data?.startsWith('data:')) {
    const matched = data.match(/^data:([^;,]+);base64,(.*)$/s)
    if (matched) {
      mediaType = matched[1] || mediaType
      data = matched[2] || ''
    }
  }
  if (data) return { mediaType, data }

  const attachment = attachmentOf(block)
  const resolved = attachment ? images.get(attachment.attachmentId) : undefined
  return resolved?.kind === 'inline' ? { mediaType: resolved.mediaType, data: resolved.data } : undefined
}

function unavailableImageText(block: Record<string, unknown>): string {
  const label = attachmentLabel(block)
  const subject = label ? label + ' could not be read' : 'the image could not be read'
  return '[image unavailable: ' + subject + '; ask the user to attach it again if the image is needed]'
}

function unsupportedImageText(block: Record<string, unknown>, mediaType: string): string {
  const label = attachmentLabel(block)
  const subject = label ? label + ' uses' : 'the image uses'
  return '[image omitted: ' + subject + ' ' + mediaType
    + ', which this endpoint does not accept inline; supported types are image/png, image/jpeg, image/gif and image/webp.]'
}

/** One inline image block for the wire, or the placeholder that replaces it. */
function imageBlockFor(block: Record<string, unknown>, images: ResolvedRequestImages): Record<string, unknown> {
  const inline = imageBlockToInline(block, images)
  if (inline === undefined) return { type: 'text', text: unavailableImageText(block) }
  if (!SUPPORTED_IMAGE_MEDIA_TYPES.has(inline.mediaType)) {
    return { type: 'text', text: unsupportedImageText(block, inline.mediaType) }
  }
  return { type: 'image', source: { type: 'base64', media_type: inline.mediaType, data: inline.data } }
}

// ---------------------------------------------------------------------------
// Message projection
// ---------------------------------------------------------------------------

type AnthropicBlock = Record<string, unknown>

function textOf(content: unknown): string {
  if (typeof content === 'string') return sanitizeText(content)
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(sanitizeText(block.text))
    else if (block.type === 'tool-result') parts.push(textOf(block.content))
  }
  return parts.join('')
}

function nonSystemMessages(options: GenerateOptions): Message[] {
  return options.messages.filter((message) => message.role !== 'system')
}

// ---------------------------------------------------------------------------
// Thinking-block replay
// ---------------------------------------------------------------------------

/**
 * The verbatim wire block one assistant message's reasoning block replays as.
 *
 * Reads two carriers, in this order: the stream's own replay envelope (what the
 * server sent, stored per block), then the block itself. The envelope wins
 * because it is the byte-for-byte original - a payload re-encoded from the DSH
 * block could differ in key order or in fields this layer does not model, and
 * the signature is validated against the payload it was issued for.
 */
function replayedThinkingBlock(message: Message, index: number, block: Record<string, unknown>): AnthropicBlock | undefined {
  const replay = replayBlockFor(message, index)
  const type = asString(replay?.type) === 'redacted_thinking' ? 'redacted_thinking' : 'thinking'
  const signature = asString(replay?.signature) || asString(block.signature)

  if (type === 'redacted_thinking') {
    const data = asString(replay?.data) || asString(block.data) || asString(block.redacted_data)
    // A redacted block carries no readable text at all, so the payload IS the
    // block. Without it there is nothing to replay.
    if (data === undefined) return undefined
    return { type: 'redacted_thinking', data, ...(signature === undefined ? {} : { signature }) }
  }

  const thinking = asString(replay?.thinking) || asString(block.text) || ''
  // A thinking block without its signature cannot be replayed and must not be
  // sent unsigned: the server rejects it, and the turn then fails for a reason
  // nothing in the request explains.
  if (signature === undefined) return undefined
  return { type: 'thinking', thinking, signature }
}

/** The replay envelope entry emitted for one block, when the message carries one. */
function replayBlockFor(message: Message, index: number): Record<string, unknown> | undefined {
  const source = message.source
  if (source === undefined || source.kind !== 'model') return undefined
  const state = source.replayState
  if (!isRecord(state)) return undefined
  if (Array.isArray(state.blocks)) {
    const entry = state.blocks[index]
    return isRecord(entry) ? entry : undefined
  }
  const response = isRecord(state.response) ? state.response : undefined
  const blocks = response !== undefined && Array.isArray(response.blocks) ? response.blocks : undefined
  const entry = blocks === undefined ? undefined : blocks[index]
  return isRecord(entry) ? entry : undefined
}

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

/**
 * Concatenated system-prompt text, or undefined when the caller stated none.
 *
 * Cache-stability invariant: the system array is the head of the prefix the
 * server caches, so this must be a pure, order-stable fold of its inputs - the
 * one-shot header first, then message text in history order, never re-sorted
 * and never decorated with per-turn metadata. Any value that changes
 * turn-over-turn belongs in a trailing user message, not here, because one
 * changed byte at the head invalidates the whole cached prefix.
 */
export function leadingSystemText(options: GenerateOptions): string | undefined {
  const parts: string[] = []
  if (typeof options.system === 'string' && options.system.trim() !== '') parts.push(options.system)
  for (const message of options.messages) {
    if (message.role !== 'system') continue
    const text = textOf(message.content)
    if (text !== '') parts.push(text)
  }
  return parts.length === 0 ? undefined : parts.join('\n\n')
}

/**
 * The system array for one request: identity first, always.
 *
 * The identity block is not conditional on anything (see the module doc). The
 * optional ephemeral cache marker is opt-in and goes on the LAST block, which
 * is the Anthropic-recommended shape: a breakpoint at the end of the prompt
 * caches everything above it, so marking the user block also covers the
 * identity block, while marking the identity block alone would cache nothing
 * that changes.
 */
export function buildClaudeSystemBlocks(
  options: GenerateOptions,
  systemCacheControl: boolean = false,
): AnthropicBlock[] {
  const blocks: AnthropicBlock[] = [{ type: 'text', text: CLAUDE_CODE_IDENTITY_TEXT }]
  const userText = leadingSystemText(options)
  if (userText !== undefined) blocks.push({ type: 'text', text: userText })
  if (systemCacheControl) {
    const last = blocks[blocks.length - 1] as AnthropicBlock
    last.cache_control = { type: 'ephemeral' }
  }
  return blocks
}

/** One tool definition in the wire shape. */
function wireTool(tool: { name: string; description?: string; parameters?: unknown }, names: ClaudeToolNames): AnthropicBlock {
  const schema: Record<string, unknown> = isRecord(tool.parameters)
    ? { ...tool.parameters }
    : { type: 'object', properties: {} }
  // A JSON-Schema meta keyword the Messages API neither needs nor accepts as a
  // schema property of its own.
  delete schema.$schema
  return {
    name: claudeWireToolName(tool.name, names),
    description: tool.description ?? '',
    input_schema: schema,
  }
}

/** One user-role turn's blocks. */
function claudeUserContent(message: Message, images: ResolvedRequestImages): AnthropicBlock[] {
  const blocks: AnthropicBlock[] = []
  if (!Array.isArray(message.content)) return blocks
  // Harness 0.1.7 shape: the message IS the tool result, and its content is the
  // result blocks rather than a carrier block. The call id lives on the message.
  if (isFlattenedToolMessage(message)) {
    const record = message as unknown as Record<string, unknown>
    const callId = typeof record.toolCallId === 'string' ? record.toolCallId : ''
    blocks.push(toolResultBlockFor(callId, message.content, record.isError === true, images))
    return blocks
  }
  for (const block of message.content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = sanitizeText(block.text)
      if (text !== '') blocks.push({ type: 'text', text })
      continue
    }
    if (block.type === 'image') {
      blocks.push(imageBlockFor(block, images))
      continue
    }
    if (block.type === 'tool-result') {
      blocks.push(toolResultBlock(block, images))
    }
  }
  return blocks
}

/** Whether one message is the flattened 0.1.7 tool result (see isToolResultMessage). */
function isFlattenedToolMessage(message: Message): boolean {
  if ((message as { role?: unknown }).role !== 'tool') return false
  return !message.content.some((block) => isRecord(block) && block.type === 'tool-result')
}

/**
 * One tool_result block.
 *
 * Anthropic requires a tool result to live in a USER message (there is no tool
 * role on this wire), which is the one structural difference from the
 * OpenAI-dialect lines. The content stays a plain string while the result holds
 * only text - the block-array form is taken only once pixels are present, so an
 * ordinary result keeps the byte-identical shape it had before.
 */
function toolResultBlock(block: Record<string, unknown>, images: ResolvedRequestImages): AnthropicBlock {
  return toolResultBlockFor(
    typeof block.toolCallId === 'string' ? block.toolCallId : '',
    block.content,
    block.isError === true,
    images,
  )
}

/** One tool_result block from a call id, its result blocks, and its outcome. */
function toolResultBlockFor(
  toolUseId: string,
  resultBlocks: unknown,
  isError: boolean,
  images: ResolvedRequestImages,
): AnthropicBlock {
  const rich = toolResultContent(resultBlocks, images)
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: rich ?? toolResultText(resultBlocks),
    ...(isError ? { is_error: true } : {}),
  }
}

function toolResultText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map((block) => {
      if (!isRecord(block)) return ''
      if (block.type === 'text' && typeof block.text === 'string') return sanitizeText(block.text)
      if (block.type === 'tool-result') return toolResultText(block.content)
      if (block.type === 'image') {
        const label = attachmentLabel(block)
        return label ? '[image: ' + label + ']' : '[image]'
      }
      return ''
    })
    .join('')
}

/**
 * The block-array form of one tool result, or undefined when it holds no image.
 * Returning undefined is what keeps a text-only result a plain string on the
 * wire.
 */
function toolResultContent(blocks: unknown, images: ResolvedRequestImages): AnthropicBlock[] | undefined {
  if (!Array.isArray(blocks)) return undefined
  const out: AnthropicBlock[] = []
  let hasImage = false
  for (const block of blocks) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: sanitizeText(block.text) })
      continue
    }
    if (block.type === 'image') {
      hasImage = true
      out.push(imageBlockFor(block, images))
      continue
    }
    if (block.type === 'tool-result') {
      const nested = toolResultContent(block.content, images)
      if (nested !== undefined) {
        hasImage = true
        out.push(...nested)
      }
    }
  }
  if (!hasImage) return undefined
  // Anthropic requires at least one block; keep the shape conservative.
  if (out[0]?.type !== 'text') out.unshift({ type: 'text', text: '' })
  return out
}

/** One assistant-role turn's blocks. */
function claudeAssistantContent(message: Message, names: ClaudeToolNames): AnthropicBlock[] {
  const blocks: AnthropicBlock[] = []
  if (!Array.isArray(message.content)) return blocks
  for (let index = 0; index < message.content.length; index++) {
    const block = message.content[index] as unknown
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = sanitizeText(block.text)
      if (text !== '') blocks.push({ type: 'text', text })
      continue
    }
    if (block.type === 'tool-call' && typeof block.name === 'string') {
      const parsed = safeJsonParse(toolCallArguments(block.arguments))
      blocks.push({
        type: 'tool_use',
        id: typeof block.id === 'string' && block.id !== '' ? block.id : 'toolu_' + blocks.length,
        name: claudeWireToolName(block.name, names),
        // The wire wants the parsed object, not the JSON string DSH carries.
        input: isRecord(parsed) ? parsed : {},
      })
      continue
    }
    if (block.type === 'reasoning') {
      const replay = replayedThinkingBlock(message, index, block)
      if (replay !== undefined) blocks.push(replay)
    }
  }
  return blocks
}

function toolCallArguments(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (raw === undefined || raw === null) return '{}'
  try {
    return JSON.stringify(raw)
  } catch {
    return '{}'
  }
}

/** Whether one message is a tool result rather than an ordinary user turn. */
function isToolResultMessage(message: Message): boolean {
  // A hand-built one-shot request may carry messages without provenance; a
  // tool-result block in the content is the other signal, and either is enough.
  if (message.source?.kind === 'tool') return true
  if (!Array.isArray(message.content)) return false
  if (message.content.some((block) => isRecord(block) && block.type === 'tool-result')) return true
  // Harness 0.1.7 flattened tool results into a first-class role:'tool' message
  // whose content is the RESULT BLOCKS THEMSELVES, with the call identity on the
  // message rather than inside a carrier block. Reading only the pre-0.1.7
  // spelling turned such a message into a plain user turn: its text reached the
  // wire without a tool_result at all, and the tool_use it answers was left
  // dangling - a request the model rejects.
  return (message as { role?: unknown }).role === 'tool'
}

/**
 * Merge neighbouring same-role turns.
 *
 * DSH history can hold two user messages in a row (an injected context notice
 * followed by the real turn) and a tool result is itself a user-role message,
 * so parallel tool calls emit several consecutive user turns; the Messages wire
 * wants one user turn per run, and folding in order keeps every tool_result
 * ahead of the text that follows it.
 */
function mergeClaudeMessages(entries: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }>): Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> {
  const merged: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> = []
  for (const entry of entries) {
    if (entry.content.length === 0) continue
    const last = merged[merged.length - 1]
    if (last !== undefined && last.role === entry.role) {
      last.content = [...last.content, ...entry.content]
      continue
    }
    merged.push({ role: entry.role, content: [...entry.content] })
  }
  return merged
}

/** Options this builder reads beyond GenerateOptions. */
export interface ClaudeRequestOptions {
  /**
   * Put an ephemeral cache breakpoint on the last system block. Default false,
   * so the marker is opt-in.
   */
  systemCacheControl?: boolean
  /**
   * Tool-name translation to use. Pass the same value to createStreamState so
   * the response side maps back through the identical table.
   */
  toolNames?: ClaudeToolNames
  /** Caller overrides for the thinking budget table. */
  thinkingBudgets?: ThinkingBudgets
}

/**
 * Build one Messages request body.
 *
 * Field order in the returned object is irrelevant to the server and is kept
 * readable only.
 *
 * @param options - request options carrying the normalized conversation.
 * @param images - images read for this request by resolveRequestImages.
 * @param request - cache and translation options.
 */
export function buildClaudeRequestBody(
  options: GenerateOptions,
  images: ResolvedRequestImages = NO_RESOLVED_IMAGES,
  request: ClaudeRequestOptions = {},
): Record<string, unknown> {
  const names = request.toolNames ?? claudeToolNames(options.tools)
  const effort = options.reasoningEffort === undefined || options.reasoningEffort === null
    ? undefined
    : String(options.reasoningEffort)

  const modelMax = maxOutputTokensFor(options.model)
  // The ALREADY-RESOLVED cap. Passing options.maxTokens straight through would
  // change which branch of adjustMaxTokensForThinking runs (see the module doc).
  const baseMax = resolveMaxTokens(options)
  const level = thinkingBudgetLevel(effort)
  // The ceiling is inflated to fit the thinking budget ONLY for a request that
  // will actually think: a request that is not thinking must ask for exactly the
  // cap it was given.
  const maxTokens = claudeRequestThinks(options.model, effort)
    ? adjustMaxTokensForThinking(baseMax, modelMax, level, request.thinkingBudgets).maxTokens
    : baseMax
  const { thinking, outputConfig } = claudeThinking(options.model, effort, level, maxTokens, request.thinkingBudgets)

  const entries: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> = []
  for (const message of nonSystemMessages(options)) {
    if (isToolResultMessage(message)) {
      entries.push({ role: 'user', content: claudeUserContent(message, images) })
      continue
    }
    entries.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.role === 'assistant'
        ? claudeAssistantContent(message, names)
        : claudeUserContent(message, images),
    })
  }

  // A temperature alongside enabled thinking is an upstream error, so it is
  // sent only when the model accepts one AND thinking is not enabled.
  const thinkingEnabled = thinking !== undefined && thinking.type !== 'disabled'
  const temperatureAllowed = claudeModelSupportsTemperature(options.model) && !thinkingEnabled

  return {
    model: options.model,
    max_tokens: maxTokens,
    stream: true,
    system: buildClaudeSystemBlocks(options, request.systemCacheControl === true),
    messages: mergeClaudeMessages(entries),
    ...(options.tools !== undefined && options.tools.length > 0
      ? { tools: options.tools.map((tool) => wireTool(tool, names)) }
      : {}),
    ...(thinking === undefined ? {} : { thinking }),
    ...(outputConfig === undefined ? {} : { output_config: outputConfig }),
    ...(temperatureAllowed && options.temperature !== undefined ? { temperature: options.temperature } : {}),
    // Stop sequences are not part of the required body this chunk was specified
    // with, but GenerateOptions carries them and the wire accepts them; sending
    // them costs nothing and dropping them would silently ignore a caller's
    // request to stop.
    ...(options.stop !== undefined && options.stop.length > 0 ? { stop_sequences: [...options.stop] } : {}),
  }
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/** One tool_use block accumulating across input_json_delta fragments. */
interface PendingToolCall {
  /** Index of the DSH block this call occupies. */
  index: number
  /** Wire id, kept beside the DSH-block id so a replay is byte-exact. */
  id: string
  /** The name the CALLER declared, which is what DSH dispatches on. */
  name: string
  /** The name the WIRE carried, which is what a replay must send back. */
  wireName: string
  /** Concatenated partial_json fragments, verbatim. */
  arguments: string
}

/** One text block currently receiving deltas. */
interface OpenTextBlock {
  index: number
  text: string
}

/**
 * One thinking or redacted_thinking block held until the block closes.
 *
 * Buffered rather than streamed because the signature that decides whether the
 * block can ever be replayed arrives at the END of the block (see the module
 * doc), and because a redacted block's payload must not be paraphrased into
 * visible reasoning text.
 */
interface PendingThinking {
  index: number
  kind: 'thinking' | 'redacted_thinking'
  text: string
  signature: string
  data: string
}

/** Accumulated state of one Anthropic SSE stream. */
export interface ClaudeStreamState {
  /** Emitted blocks by DSH index; a slot exists from the moment its block opens. */
  blocks: ContentBlock[]
  /** Anthropic content index -> the DSH index of the open text block. */
  openText: Map<number, OpenTextBlock>
  /** Anthropic content index -> the accumulating tool call. */
  toolCalls: Map<number, PendingToolCall>
  /** Anthropic content index -> a buffered thinking block. */
  pending: Map<number, PendingThinking>
  /** Anthropic content index -> the wire block that produced the emitted block. */
  replayBlocks: unknown[]
  /** Tool-name translation the response side maps back through. */
  toolNames: ClaudeToolNames | undefined
  sawMessageStart: boolean
  sawMessageStop: boolean
  hasContent: boolean
  hasToolCall: boolean
  /** Anthropic stop_reason, verbatim. */
  finishReason: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  sawUsage: boolean
  finished: boolean
}

/**
 * Fresh stream state.
 *
 * @param toolNames - the SAME ClaudeToolNames the request was built with, so a
 * returned canonical tool name maps back to the spelling the caller declared.
 * Omitted means names pass through unchanged.
 */
export function createStreamState(toolNames?: ClaudeToolNames): ClaudeStreamState {
  return {
    blocks: [],
    openText: new Map(),
    toolCalls: new Map(),
    pending: new Map(),
    replayBlocks: [],
    toolNames,
    sawMessageStart: false,
    sawMessageStop: false,
    hasContent: false,
    hasToolCall: false,
    finishReason: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    sawUsage: false,
    finished: false,
  }
}

/**
 * Thinking tokens implied by one block's text.
 *
 * An ESTIMATE, not a measurement: the wire reports an aggregate output_tokens
 * and never splits out the reasoning portion, so the alternative is reporting
 * nothing at all. The usual ~4 characters per token heuristic is used and the
 * result is labelled as an estimate rather than presented as a count.
 */
function estimateReasoningTokens(text: string): number {
  if (text === '') return 0
  return Math.ceil(text.length / 4)
}

function closeTextBlock(state: ClaudeStreamState, contentIndex: number): StreamChunk[] {
  const open = state.openText.get(contentIndex)
  if (open === undefined) return []
  state.openText.delete(contentIndex)
  const block: ContentBlock = { type: 'text', text: open.text }
  state.blocks[open.index] = block
  // The text was streamed as it arrived, so it is already what the caller saw.
  state.replayBlocks[open.index] = undefined
  state.hasContent = true
  return [{ type: 'block-end', index: open.index, block }]
}

function openTextAt(state: ClaudeStreamState, contentIndex: number): { chunks: StreamChunk[]; block: OpenTextBlock } {
  const existing = state.openText.get(contentIndex)
  if (existing !== undefined) return { chunks: [], block: existing }
  const index = state.blocks.length
  state.blocks.push({ type: 'text', text: '' })
  const block: OpenTextBlock = { index, text: '' }
  state.openText.set(contentIndex, block)
  return { chunks: [{ type: 'block-start', index, blockType: 'text' }], block }
}

/**
 * Close one tool call: concatenate, then PARSE ONCE.
 *
 * The fragments are concatenated verbatim as they arrive (so the caller sees
 * exactly the bytes the model produced), and the assembled string is parsed
 * exactly here. A parse failure does not kill the stream: the raw text is
 * carried through as the call's arguments, where DSH's own dispatch turns an
 * unparseable argument string into an error tool result. Replacing it with '{}'
 * instead would silently turn a malformed call into a no-argument call, which
 * is a wrong answer rather than a visible failure.
 */
function closeToolCall(state: ClaudeStreamState, contentIndex: number): StreamChunk[] {
  const pending = state.toolCalls.get(contentIndex)
  if (pending === undefined) return []
  state.toolCalls.delete(contentIndex)
  const parsed = safeJsonParse(pending.arguments)
  // The PARSED object is what the wire carries and what is replayed later; the
  // RAW text is what the caller sees in the block's arguments field, which is
  // GenerateOptions' documented shape for a tool call. Re-serializing a
  // successfully parsed object here instead would hand the caller bytes the
  // model never produced.
  const block: ContentBlock = {
    type: 'tool-call',
    id: toToolCallId(pending.id),
    name: pending.name,
    arguments: pending.arguments === '' ? '{}' : pending.arguments,
  }
  state.blocks[pending.index] = block
  // The replayed tool_use carries the ORIGINAL wire id and the ORIGINAL wire
  // name: the caller's spelling came from a translation that exists only while
  // that tool is offered, so a replay routed through the caller's name would
  // rename the call whenever the tool is not offered on the replaying request.
  state.replayBlocks[pending.index] = {
    type: 'tool_use',
    id: pending.id,
    name: pending.wireName,
    input: parsed,
  }
  state.hasToolCall = true
  state.hasContent = true
  return [{ type: 'block-end', index: pending.index, block }]
}

/**
 * Emit one buffered thinking block.
 *
 * A signed block is emitted as DSH reasoning and replayed verbatim afterwards.
 * An unsigned one is emitted WITHOUT a replay entry: it is still shown to the
 * caller (the model did think, and hiding it would misreport the turn) but it
 * cannot be sent back, and the request builder drops it on the next turn.
 */
function emitPendingThinking(state: ClaudeStreamState, contentIndex: number): StreamChunk[] {
  const pending = state.pending.get(contentIndex)
  if (pending === undefined) return []
  state.pending.delete(contentIndex)
  const text = pending.kind === 'thinking' ? pending.text : ''
  const block: ContentBlock = { type: 'reasoning', text }
  state.blocks[pending.index] = block
  state.replayBlocks[pending.index] = pending.kind === 'redacted_thinking'
    ? {
        type: 'redacted_thinking',
        data: pending.data,
        ...(pending.signature === '' ? {} : { signature: pending.signature }),
      }
    : {
        type: 'thinking',
        thinking: pending.text,
        ...(pending.signature === '' ? {} : { signature: pending.signature }),
      }
  state.reasoningTokens += estimateReasoningTokens(text)
  const out: StreamChunk[] = [{ type: 'block-start', index: pending.index, blockType: 'reasoning' }]
  if (text !== '') out.push({ type: 'reasoning-delta', index: pending.index, text })
  out.push({ type: 'block-end', index: pending.index, block })
  return out
}

/** Flush every still-open block, in DSH index order. */
function flushOpenBlocks(state: ClaudeStreamState): StreamChunk[] {
  const closers: Array<{ index: number; close: () => StreamChunk[] }> = []
  for (const [contentIndex, open] of state.openText) {
    closers.push({ index: open.index, close: () => closeTextBlock(state, contentIndex) })
  }
  for (const [contentIndex, pending] of state.toolCalls) {
    closers.push({ index: pending.index, close: () => closeToolCall(state, contentIndex) })
  }
  for (const [contentIndex, pending] of state.pending) {
    closers.push({ index: pending.index, close: () => emitPendingThinking(state, contentIndex) })
  }
  closers.sort((left, right) => left.index - right.index)
  const out: StreamChunk[] = []
  for (const closer of closers) out.push(...closer.close())
  return out
}

/**
 * Map Anthropic's usage counters onto DSH's.
 *
 * The counts are DISJOINT in the same way DSH documents: input_tokens EXCLUDES
 * the cache counters, which arrive separately as cache_read_input_tokens and
 * cache_creation_input_tokens. Nothing is summed into inputTokens here - doing
 * so would double-count every cached turn - and the three are simply reported
 * side by side, which is also why cacheWriteTokens is mapped even though the
 * brief only named the read side: dropping a number the wire sent would make
 * the billed-input total unaccountable.
 */
function tokenUsage(state: ClaudeStreamState): TokenUsage {
  return {
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    ...(state.cacheReadTokens > 0 ? { cacheReadTokens: state.cacheReadTokens } : {}),
    ...(state.cacheWriteTokens > 0 ? { cacheWriteTokens: state.cacheWriteTokens } : {}),
    ...(state.reasoningTokens > 0 ? { reasoningTokens: state.reasoningTokens } : {}),
  }
}

function finishReasonFor(state: ClaudeStreamState): FinishReason {
  const reason = state.finishReason ?? ''
  // max-tokens outranks tool-calls on purpose: the assembler drops tool calls
  // from a truncated response, and it can only do that if it is told.
  if (reason === 'max_tokens') return { kind: 'max-tokens' }
  if (state.hasToolCall || reason === 'tool_use') return { kind: 'tool-calls' }
  return { kind: 'stop' }
}

/**
 * Flush every open block, then emit usage and the terminal finish.
 *
 * Idempotent: message_stop already closes the stream, so the adapter's own call
 * after the body ends is a no-op rather than a duplicate finish. This function
 * deliberately does NOT judge whether the stream was complete - that is
 * assertStreamComplete's job, kept separate so the flush and the verdict can be
 * reasoned about independently.
 */
export function closeStream(state: ClaudeStreamState): StreamChunk[] {
  if (state.finished) return []
  state.finished = true
  const out = flushOpenBlocks(state)
  if (state.sawUsage) out.push({ type: 'usage', usage: tokenUsage(state) })
  out.push({
    type: 'finish',
    reason: finishReasonFor(state),
    replayState: { response: { provider: PROVIDER_ID }, blocks: state.replayBlocks },
  })
  return out
}

/**
 * Assert the stream reached its terminal event.
 *
 * A stream that ended without message_stop is a severed reply, not a completed
 * answer: everything already emitted is a prefix of something the model never
 * finished saying, and flushing it as a clean stop is precisely the failure
 * this check exists to prevent.
 */
export function assertStreamComplete(state: ClaudeStreamState): void {
  if (!state.sawMessageStop) {
    throw new LlmError('Claude stream ended before its terminal event', 'PROVIDER_ERROR')
  }
}

function applyUsage(state: ClaudeStreamState, usage: Record<string, unknown>, cumulativeOutput: boolean): void {
  state.sawUsage = true
  if (usage.input_tokens !== undefined) state.inputTokens = numberOr(usage.input_tokens, state.inputTokens)
  if (usage.cache_creation_input_tokens !== undefined) {
    state.cacheWriteTokens = numberOr(usage.cache_creation_input_tokens, state.cacheWriteTokens)
  }
  if (usage.cache_read_input_tokens !== undefined) {
    state.cacheReadTokens = numberOr(usage.cache_read_input_tokens, state.cacheReadTokens)
  }
  if (usage.output_tokens !== undefined) {
    // message_delta reports a CUMULATIVE count, so it REPLACES rather than adds.
    // Adding it is the bug that inflates a long answer's output tokens into a
    // quadratic number nothing downstream can untangle.
    state.outputTokens = cumulativeOutput
      ? numberOr(usage.output_tokens, state.outputTokens)
      : state.outputTokens + numberOr(usage.output_tokens, 0)
  }
}

/**
 * Feed one SSE line of a Messages response into the state.
 *
 * Emits DSH chunks for the events that carry content and ignores everything
 * else, including the 'event:' line (the payload's own type is authoritative)
 * and any event type this build does not know. An 'error' event THROWS: the
 * reply is over, and continuing to flush it as a clean stop would report a
 * wrong answer as a successful one.
 */
export function processStreamLine(line: string, state: ClaudeStreamState): StreamChunk[] {
  const trimmed = line.trim()
  if (state.finished || trimmed === '') return []
  // SSE comment (a keep-alive) and the event-name line: neither carries JSON.
  if (trimmed.startsWith(':')) return []
  if (trimmed.startsWith('event:')) return []
  if (!trimmed.startsWith('data:')) return []
  const payload = trimmed.slice(5).trim()
  if (payload === '' || payload === '[DONE]') return []

  const event = safeJsonParse(payload)
  if (!isRecord(event)) return []
  const type = asString(event.type)
  const out: StreamChunk[] = []

  if (type === 'message_start') {
    state.sawMessageStart = true
    const message = isRecord(event.message) ? event.message : undefined
    const usage = message !== undefined && isRecord(message.usage) ? message.usage : undefined
    // message_start states an input-side count and a placeholder output count,
    // so the input side is applied and the output side is not treated as
    // cumulative here.
    if (usage !== undefined) applyUsage(state, usage, false)
    const stop = message === undefined ? undefined : asString(message.stop_reason)
    if (stop !== undefined && stop !== '') state.finishReason = stop
    return out
  }

  if (type === 'content_block_start') {
    const contentIndex = numberOr(event.index, -1)
    const block = isRecord(event.content_block) ? event.content_block : {}
    const blockType = asString(block.type)

    if (blockType === 'tool_use') {
      const index = state.blocks.length
      const id = asString(block.id) ?? 'toolu_' + String(index)
      const name = claudeOriginalToolName(asString(block.name) ?? '', state.toolNames)
      // A start block may already carry a complete (or partial) input object.
      // Seeding from it is what keeps a stream whose input never arrives as
      // fragments from assembling '{}'. An EMPTY object seeds nothing: '{}' plus
      // the fragments would be two concatenated JSON documents.
      const seedInput = isRecord(block.input) && Object.keys(block.input).length > 0 ? JSON.stringify(block.input) : ''
      const wireName = asString(block.name) ?? ''
      const pending: PendingToolCall = { index, id, name, wireName, arguments: seedInput }
      state.toolCalls.set(contentIndex, pending)
      state.blocks.push({ type: 'tool-call', id: toToolCallId(id), name, arguments: seedInput })
      state.replayBlocks[index] = undefined
      out.push({ type: 'block-start', index, blockType: 'tool-call' })
      out.push({ type: 'tool-call-delta', index, id: toToolCallId(id), name, argumentsDelta: seedInput })
      return out
    }

    if (blockType === 'thinking' || blockType === 'redacted_thinking') {
      // Never two thinking blocks on one index, but a repeated start would
      // otherwise double-allocate a DSH block that nothing ever closes.
      const existing = state.pending.get(contentIndex)
      if (existing !== undefined) {
        out.push(...emitPendingThinking(state, contentIndex))
      }
      const index = state.blocks.length
      state.blocks.push({ type: 'reasoning', text: '' })
      state.pending.set(contentIndex, {
        index,
        kind: blockType === 'redacted_thinking' ? 'redacted_thinking' : 'thinking',
        text: asString(block.thinking) ?? '',
        signature: asString(block.signature) ?? '',
        data: asString(block.data) ?? '',
      })
      return out
    }

    // Text, and any block type this build does not know, opens a text block:
    // an unknown block's deltas would otherwise be dropped silently, and the
    // delta handler below decides what they actually are.
    out.push(...openTextAt(state, contentIndex).chunks)
    return out
  }

  if (type === 'content_block_delta') {
    const contentIndex = numberOr(event.index, -1)
    const delta = isRecord(event.delta) ? event.delta : {}
    const deltaType = asString(delta.type)

    if (deltaType === 'input_json_delta') {
      const pending = state.toolCalls.get(contentIndex)
      const partial = asString(delta.partial_json) ?? ''
      if (pending !== undefined && partial !== '') {
        // CONCATENATED verbatim; the assembled string is parsed once, at stop.
        pending.arguments += partial
        out.push({
          type: 'tool-call-delta',
          index: pending.index,
          id: toToolCallId(pending.id),
          name: pending.name,
          argumentsDelta: partial,
        })
      }
      return out
    }

    if (deltaType === 'signature_delta') {
      const pending = state.pending.get(contentIndex)
      const signature = asString(delta.signature) ?? ''
      if (pending !== undefined && signature !== '') pending.signature += signature
      return out
    }

    if (deltaType === 'thinking_delta') {
      const pending = state.pending.get(contentIndex)
      const text = asString(delta.thinking) ?? ''
      if (pending !== undefined && text !== '') pending.text += sanitizeText(text)
      return out
    }

    // text_delta, and anything else shaped like one. A text delta can arrive
    // without its content_block_start (a delta-only proxy), and the block it
    // belongs to is opened lazily here rather than dropped.
    const text = asString(delta.text) ?? ''
    if (text === '') return out
    const opened = openTextAt(state, contentIndex)
    out.push(...opened.chunks)
    opened.block.text += sanitizeText(text)
    state.hasContent = true
    out.push({ type: 'text-delta', index: opened.block.index, text: sanitizeText(text) })
    return out
  }

  if (type === 'content_block_stop') {
    const contentIndex = numberOr(event.index, -1)
    if (state.toolCalls.has(contentIndex)) return closeToolCall(state, contentIndex)
    if (state.pending.has(contentIndex)) return emitPendingThinking(state, contentIndex)
    return closeTextBlock(state, contentIndex)
  }

  if (type === 'message_delta') {
    const delta = isRecord(event.delta) ? event.delta : undefined
    const stop = delta === undefined ? undefined : asString(delta.stop_reason)
    if (stop !== undefined && stop !== '') state.finishReason = stop
    const usage = isRecord(event.usage) ? event.usage : undefined
    // Cumulative output count, and the only place the final input-side numbers
    // are restated.
    if (usage !== undefined) applyUsage(state, usage, true)
    return out
  }

  if (type === 'message_stop') {
    state.sawMessageStop = true
    return closeStream(state)
  }

  if (type === 'error') {
    const error = isRecord(event.error) ? event.error : {}
    const message = asString(error.message) ?? 'unknown error'
    const kind = asString(error.type)
    throw new LlmError(
      'Claude stream error' + (kind === undefined ? '' : ' (' + kind + ')') + ': ' + message,
      'PROVIDER_ERROR',
    )
  }

  // ping, and every event type a newer beta may add.
  return out
}
