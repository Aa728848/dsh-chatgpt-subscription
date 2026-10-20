/**
 * The MiniMax Code video tools: understanding and generation.
 *
 * Both ride the Matrix media gateway (./matrix-client.ts), which sits beside the
 * Messages route on the same agent host. Neither of them sends video to the
 * model as a content block: the Anthropic Messages wire this line speaks has no
 * video part (./modalities.ts records the same conclusion for the prompt path),
 * so understanding is a SERVER-SIDE call that answers with text, and generation
 * is a two-step async task that produces a file.
 *
 * THE ROUTE GATE. Both tools refuse unless the session is routed to
 * `minimax-code`. The reason is not a modality declaration - generation needs
 * none - but the credential: the bearer both tools present is this line's
 * subscription token read from this line's pool. A session served by another
 * provider has no such credential, so the call would 401 in a way the user
 * cannot act on. Refusing here, with the model to switch to, is the same
 * contract `kimi_attach_video` states for its own route.
 *
 * @module dsh-chatgpt-subscription/minimax-code/video-tool
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertPublicFetchTarget, lookupHostAddresses } from '../fetch-address-policy.ts'
import { MINIMAX_CODE_PROVIDER_ID } from '../../shared/minimax-code-contracts.ts'
import {
  MATRIX_TOOL_GET_UPLOAD_URL,
  MATRIX_TOOL_QUERY_VIDEO,
  MATRIX_TOOL_SUBMIT_VIDEO,
  MATRIX_TOOL_VIDEOS_UNDERSTAND,
  MatrixToolError,
  callMatrixTool,
  matrixPayloadField,
} from './matrix-client.ts'
import { IsoBmffDurationError, readIsoBmffDurationSeconds } from './iso-bmff-duration.ts'
import {
  attemptedVideoSubmissionFor,
  assertGenerationMediaLimits,
  isPreciseSubmissionKey,
  recordVideoSubmissionAttempt,
  videoSubmissionKey,
} from './video-submit-rules.ts'
import {
  MediaStoreError,
  MAX_GENERATED_VIDEO_BYTES,
  resolveMediaStoreTarget,
  writeGeneratedVideo,
  type MediaStoreExec,
} from './media-store.ts'
import { recordMinimaxVideoGeneration } from './video-history.ts'
import { PROVIDER_NAME, maxMessageBodyBytes } from './types.ts'

export const MINIMAX_UNDERSTAND_VIDEO_TOOL_NAME = 'minimax_understand_video'
export const MINIMAX_GENERATE_VIDEO_TOOL_NAME = 'minimax_generate_video'

/** Default prompt used when the caller asks no specific question. */
export const DEFAULT_UNDERSTAND_PROMPT = '描述这个视频的内容'

/**
 * Largest local file the INLINE (base64) understanding path will send.
 *
 * A MEASURED CONSTRAINT, not a taste. `videos_understand` reads a local clip
 * only through `video_info[].data`, which is base64 (docs/
 * minimax-video-generation-probe.md §3.2, U3: the only one of the three source
 * forms that answered `results[0].success: true`). Base64 grows the bytes by
 * 4/3 on the wire, and this line's request body is capped at
 * {@link maxMessageBodyBytes} (./types.ts, 64 MB by default), so a 40 MB clip
 * encodes to ~53 MB and still fits. A larger file would leave the caller with
 * an opaque "body too large" from the transport instead of an answer, which is
 * why it is refused here, before the bytes become a request.
 */
export const MAX_INLINE_VIDEO_BYTES = 40 * 1024 * 1024

/**
 * The effective inline ceiling for one deployment.
 *
 * Two limits apply at once: the fixed {@link MAX_INLINE_VIDEO_BYTES}, and the
 * body budget `maxMessageBodyBytes()` — which a deployment can pin lower with
 * `DSH_MINIMAX_CODE_MAX_BODY_BYTES`. The base64 form costs 4 bytes per 3 bytes
 * of video, so the body budget converts to 3/4 of itself; a further 1/8 is
 * reserved for the JSON envelope around the payload.
 *
 * @param bodyLimit - the request-body ceiling; defaults to this line's own.
 * @returns the largest raw video size that can be sent inline.
 */
export function inlineVideoByteBudget(bodyLimit: number = maxMessageBodyBytes()): number {
  const encoded = Math.floor((bodyLimit / 4) * 3 * (7 / 8))
  return Math.max(0, Math.min(MAX_INLINE_VIDEO_BYTES, encoded))
}

/**
 * Largest local file the UPLOAD (presigned PUT) understanding path will send.
 *
 * 200 MiB, which is deliberately the SAME number as
 * {@link MAX_GENERATED_VIDEO_BYTES} — the ceiling the download side puts on a
 * generated clip. The two directions are held to one value on purpose: a file
 * this route can push into the bucket is also a file it can pull back out, so
 * neither limit can leave the other holding a video that moves one way and not
 * the other.
 *
 * Upstream's own ceiling is `MATRIX_MAX_UPLOAD_BYTES` = 500 MiB
 * (packages/agent-tools/src/desktop/matrix-media-client.ts:14), so the service
 * is not what binds here — this process' memory is.
 *
 * WHY AN UPLOAD CAP AT ALL, given that these bytes never enter the request
 * body: they still pass THROUGH this process. {@link uploadLocalVideo} is
 * handed a `Uint8Array` of the entire file and `get_upload_url` is asked for
 * a target sized from it, so with no cap a 2 GB clip would be read into RAM and
 * PUT as one object. That is why the check lives in {@link readLocalVideo},
 * against `stats.size`, before a single byte is read — see the note there.
 */
export const MAX_UPLOAD_VIDEO_BYTES = 200 * 1024 * 1024

/**
 * How a local file reaches the service.
 *
 * `inline` is the default because it needs no upload step at all. `upload`
 * exists because base64 stops scaling at {@link MAX_INLINE_VIDEO_BYTES}; both
 * its field names (§5) and its end-to-end read-back are measured — see
 * {@link uploadLocalVideo} for what that does and does not cover.
 */
export const MINIMAX_VIDEO_TRANSPORTS = ['inline', 'upload'] as const
export type MinimaxVideoTransport = (typeof MINIMAX_VIDEO_TRANSPORTS)[number]

/**
 * Models the generation tool accepts, in the order the picker shows them.
 *
 * THREE, AND ALL THREE ARE MEASURED. `MiniMax-H3-Max` was missing from this
 * list; it is not an inference, because the service named it in its own duration
 * rule (docs/minimax-video-free-checks.md section 2.1, verbatim):
 *
 * > use 4-15 seconds for MiniMax-H3, 5-15 seconds for MiniMax-H3-Max, or 6/10
 * > seconds for Hailuo 2.3
 *
 * That sentence is also what proves `MiniMax-Hailuo-2.3` is recognised: asked
 * for a bad duration, the service answered with a rule about THAT model, so its
 * id had already passed the model check (section 3).
 */
export const MINIMAX_VIDEO_MODELS = ['MiniMax-H3', 'MiniMax-H3-Max', 'MiniMax-Hailuo-2.3'] as const

export type MinimaxVideoModel = (typeof MINIMAX_VIDEO_MODELS)[number]
/** Model used when the caller names none. */
export const DEFAULT_MINIMAX_VIDEO_MODEL: MinimaxVideoModel = 'MiniMax-H3'

/**
 * Every resolution spelling ANY model accepts: a UNION, never a legal set.
 *
 * THIS LIST IS NOT ANY MODEL'S LEGAL RESOLUTION SET, AND MUST NOT BE USED AS
 * ONE. MEASURED, and the measurement contradicts the intuitive reading
 * (docs/minimax-video-model-rules.md section 5): the three models' sets are
 * pairwise different and none of them is the union.
 *
 * | model                | accepts                     | only this model has |
 * | -------------------- | --------------------------- | ------------------- |
 * | `MiniMax-H3`         | `768P`, `2K`               | `2K`                |
 * | `MiniMax-H3-Max`     | `480P`, `768P`             | `480P`              |
 * | `MiniMax-Hailuo-2.3` | `768P`, `1080P`            | `1080P`             |
 *
 * So every member of this list is illegal for at least one model: `2K` is
 * refused by H3-Max and by Hailuo, `1080P` by H3 and by H3-Max, `480P` by H3
 * and by Hailuo. The one place this list is legitimately used is the tool
 * parameter schema, which can advertise only ONE `enum` for a field whose real
 * rule is per model; the per-model enforcement that has to follow it lives in
 * {@link assertVideoResolution}, driven by {@link MINIMAX_VIDEO_MODEL_RULES}.
 */
export const MINIMAX_VIDEO_RESOLUTION_UNION = ['480P', '768P', '1080P', '2K'] as const
export type MinimaxVideoResolution = (typeof MINIMAX_VIDEO_RESOLUTION_UNION)[number]

/**
 * Shortest clip ANY model accepts, in seconds.
 *
 * The union of the per-model windows, for a caller that needs the widest answer.
 * It is NOT what enforcement uses: a Hailuo clip of 7 s sits inside 4-15 and must
 * still be refused, because that model accepts only 6 or 10.
 */
export const MINIMAX_VIDEO_MIN_DURATION_SECONDS = 4
/** Longest clip ANY model accepts, in seconds. See {@link MINIMAX_VIDEO_MIN_DURATION_SECONDS}. */
export const MINIMAX_VIDEO_MAX_DURATION_SECONDS = 15

/** How one model bounds `duration`: an inclusive interval, or a closed set. */
export type MinimaxVideoDurationRule =
  | { readonly kind: 'range'; readonly min: number; readonly max: number }
  | { readonly kind: 'values'; readonly values: readonly number[] }

/** One model's accepted `duration` and `resolution`, with where each came from. */
export interface MinimaxVideoModelRule {
  readonly model: MinimaxVideoModel
  /** The `duration` window. MEASURED for all three (sections 2.1, 2.2 and 3). */
  readonly duration: MinimaxVideoDurationRule
  /** The spellings this model accepts, exactly as they must be sent (case-sensitive). */
  readonly resolutions: readonly MinimaxVideoResolution[]
  /**
   * Where {@link resolutions} came from.
   *
   * `measured` - the service's own refusal sentence named the values.
   * `documented` - upstream documentation states them; no probe confirmed them.
   * `inferred` - no evidence at all for THIS model; copied from the model the
   * comment names, and it may be wrong.
   */
  readonly resolutionSource: 'measured' | 'documented' | 'inferred'
}

/**
 * The per-model table, and the ONE place the service's real rules live.
 *
 * The old shape - one 4-15 window and one resolution list shared by every model
 * - is wrong in three measured ways: H3-Max starts at 5, Hailuo accepts only 6
 * or 10, and H3 refuses `1080P` outright.
 */
export const MINIMAX_VIDEO_MODEL_RULES: readonly MinimaxVideoModelRule[] = [
  {
    model: 'MiniMax-H3',
    // MEASURED, verbatim: "duration MiniMax-H3 requires duration from 4 through
    // 15 seconds" (section 2.1).
    duration: { kind: 'range', min: 4, max: 15 },
    // MEASURED, verbatim: "model resolution for MiniMax-H3 must be 768P or 2K"
    // (section 2.3). `720p` and `4K` were refused with that same sentence, so
    // the match is CASE-SENSITIVE and 1080P is not in this model's set.
    resolutions: ['768P', '2K'],
    resolutionSource: 'measured',
  },
  {
    model: 'MiniMax-H3-Max',
    // MEASURED, verbatim: "5-15 seconds for MiniMax-H3-Max" (section 2.1), and
    // re-confirmed from the other direction by "duration MiniMax-H3-Max requires
    // duration from 5 through 15 seconds" when 4 was sent (section 2.2).
    duration: { kind: 'range', min: 5, max: 15 },
    // MEASURED, verbatim: "model resolution for MiniMax-H3-Max must be 480P or
    // 768P; choose MiniMax-H3 for recommended quality, MiniMax-H3-Max for fast
    // generation, or ..." (docs/minimax-video-model-rules.md section 2.1).
    //
    // THIS ROW IS A CORRECTION. The previous value was 768P/2K, INFERRED from
    // H3 on the assumption that the Max variant shares the family's validator.
    // The measurement overturned it: H3-Max is one STEP DOWN from H3 (480P/768P
    // vs 768P/2K) and does not accept 2K at all, which is the opposite of what
    // "Max" suggests. Sending 2K here produced a request the service always
    // refuses.
    resolutions: ['480P', '768P'],
    resolutionSource: 'measured',
  },
  {
    model: 'MiniMax-Hailuo-2.3',
    // MEASURED, verbatim: "duration MiniMax-Hailuo-2.3 requires duration 6 or
    // 10" (section 3). A CLOSED SET rather than a window: 7 s is refused.
    duration: { kind: 'values', values: [6, 10] },
    // MEASURED, verbatim: "model resolution for MiniMax-Hailuo-2.3 must be 768P
    // or 1080P; choose MiniMax-H3 for recommended quality, ..." (docs/
    // minimax-video-model-rules.md section 1). The probe reached that check by
    // sending a duration the model accepts (6) with an illegal resolution, so
    // the sentence is the service's own answer rather than upstream prose -
    // which is why this row is no longer 'documented'.
    resolutions: ['768P', '1080P'],
    resolutionSource: 'measured',
  },
]

/** The rule for one model id, or undefined when this build has none. */
export function videoModelRule(model: string): MinimaxVideoModelRule | undefined {
  return MINIMAX_VIDEO_MODEL_RULES.find(rule => rule.model === model)
}

/**
 * Narrow a caller-supplied model id to one this build knows.
 *
 * The parameter schema already lists exactly these three, so a value outside the
 * set is a caller bypassing its own schema rather than a new upstream model. It
 * is refused with the legal ids instead of being forwarded, because a model this
 * build has no rule for cannot have its duration and resolution checked - and the
 * service bills a submit before it refuses those.
 *
 * @param value - the caller's `model` argument, already trimmed.
 * @returns the matching model id.
 * @throws HarnessError `MINIMAX_VIDEO_MODEL_INVALID` listing the accepted ids.
 */
export function assertVideoModel(value: string): MinimaxVideoModel {
  const match = MINIMAX_VIDEO_MODELS.find(known => known === value)
  if (match === undefined) {
    throw new HarnessError(
      'model must be one of ' + MINIMAX_VIDEO_MODELS.map(known => '"' + known + '"').join(', ')
      + ', got ' + JSON.stringify(value) + '. Only these models have measured duration and resolution rules on '
      + 'this route, and an unchecked submit is billed before the service refuses it.',
      'MINIMAX_VIDEO_MODEL_INVALID',
    )
  }
  return match
}

/** Render one duration rule the way the error messages need it. */
function describeDurationRule(rule: MinimaxVideoDurationRule): string {
  return rule.kind === 'range'
    ? rule.min + ' to ' + rule.max + ' seconds'
    : rule.values.join(' or ') + ' seconds'
}

/**
 * A short provenance note, appended where the value may not be measured.
 *
 * THIS CURRENTLY RETURNS AN EMPTY STRING FOR EVERY MODEL, and that is the
 * intended state rather than a leftover: all three rows in
 * {@link MINIMAX_VIDEO_MODEL_RULES} are `measured` now
 * (docs/minimax-video-model-rules.md section 5), so there is nothing left to
 * caveat. The function is KEPT DELIBERATELY, because the thing it exists for is
 * the next model added to the table: a row that is `inferred` or `documented`
 * has to say so in the refusal the caller reads, and deleting this now would
 * mean re-deriving that requirement the next time a row is a guess. It is
 * reachable code (called by {@link assertVideoResolution}), not a dead branch -
 * only its `measured` arm is exercised today.
 */
function resolutionProvenanceNote(rule: MinimaxVideoModelRule): string {
  if (rule.resolutionSource === 'measured') return ''
  return rule.resolutionSource === 'inferred'
    ? ' NOTE: this model resolution set is INFERRED from the neighbouring model rather than measured, so it may be stricter upstream.'
    : ' NOTE: this model resolution set comes from upstream documentation, not from a probe.'
}

/**
 * The meta shape the client reads, field for field.
 *
 * docs/minimax-video-design-spec.md section 5 fixes these names: the client
 * narrows `ToolResultNode.meta` to this interface, and a rename here is a
 * silently blank card there. The `value` a tool returns is deliberately NOT
 * persisted by the harness, so this is the only channel.
 */
export interface MinimaxVideoPresentationMeta {
  /** Workspace-relative path; the client resolves it against `cwd`. */
  readonly videoPath: string
  readonly mediaType: string
  readonly bytes: number
  readonly model: string
  readonly durationSeconds?: number
  /** Upstream task id, for diagnosis and follow-up. */
  readonly taskId: string
}

/** Base backoff for a transient Matrix failure, matching the adapter's policy. */
export const DEFAULT_RETRY_BACKOFF_MS = 1_500

/** How often the generation task is polled. */
export const VIDEO_POLL_INTERVAL_MS = 4_000
/**
 * Total wall-clock budget for one generation.
 *
 * Matches the upstream submit timeout (600 s). Past it the task is very likely
 * stuck rather than slow, and the user is better served by an answer than by a
 * request that outlives every other thing in the turn.
 */
export const VIDEO_GENERATION_BUDGET_MS = 600_000

/** The slice of the account pool these tools use. */
export interface MinimaxVideoCredentialSource {
  getFreshCredential(accountId?: string, fetchFn?: typeof fetch): Promise<{ accessToken: string; region: 'cn' | 'global' }>
}

/** A partial Matrix credential, as the tools need it. */
export interface MinimaxVideoCredential {
  readonly accessToken: string
  readonly region: 'cn' | 'global'
}

/** Options for both video tools. */
export interface MinimaxVideoToolOptions {
  /** Injected fetch; tests supply a mock so no request ever leaves the process. */
  readonly fetchFn?: typeof fetch
  /** Credential source (the line's account pool). */
  readonly pool: MinimaxVideoCredentialSource
  /** Poll interval, injected so a test does not sleep for real. */
  readonly pollIntervalMs?: number
  /** Generation budget, injected for the same reason. */
  readonly generationBudgetMs?: number
  /**
   * Base backoff between retries of a transient Matrix failure.
   *
   * Injected so a test does not spend the real 1.5 s the adapter's policy uses;
   * production leaves it at {@link DEFAULT_RETRY_BACKOFF_MS}.
   */
  readonly retryBackoffMs?: number
  /** Clock, injected so a test can pin the generated file name. */
  readonly now?: () => number
}

type FetchLike = typeof fetch

function humanBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + ' KB' : (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

/** Sleep that settles immediately when the caller cancels. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new HarnessError('the video operation was cancelled', 'MINIMAX_VIDEO_ABORTED'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new HarnessError('the video operation was cancelled', 'MINIMAX_VIDEO_ABORTED'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * The provider this session is routed to, and the model on it.
 *
 * Read through the same two seams `kimi_attach_video` uses: the live session's
 * request header first, the agent's own options second. Both are read
 * defensively because a tool is also executed by tooling that composes no
 * agent.
 */
export function routedProvider(exec: { readonly agent?: unknown }): { provider?: string; model?: string } {
  const agent = exec.agent as {
    session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined }
    options?: { provider?: string; model?: string }
  } | undefined
  const header = agent?.session?.requestHeader?.()?.config
  return {
    provider: header?.provider ?? agent?.options?.provider,
    model: header?.model ?? agent?.options?.model,
  }
}

/**
 * Refuse unless this session is served by the MiniMax Code line.
 *
 * @param exec - the tool execution.
 * @param what - the operation being refused, for the message.
 * @throws HarnessError naming the model to switch to.
 */
export function assertMinimaxRoute(exec: { readonly agent?: unknown }, what: string): void {
  const { provider } = routedProvider(exec)
  if (provider === undefined) {
    throw new HarnessError(
      'cannot ' + what + ': the current model route could not be resolved, and this tool only runs on the '
      + MINIMAX_CODE_PROVIDER_ID + ' provider because it presents that subscription credential. '
      + 'Select a ' + MINIMAX_CODE_PROVIDER_ID + ' model (for example MiniMax-M3) and retry.',
      'MINIMAX_VIDEO_ROUTE_UNRESOLVED',
    )
  }
  if (provider !== MINIMAX_CODE_PROVIDER_ID) {
    throw new HarnessError(
      'cannot ' + what + ': it is only wired for the ' + MINIMAX_CODE_PROVIDER_ID + ' provider, and this '
      + 'session is routed to "' + provider + '". Switch this session to a ' + MINIMAX_CODE_PROVIDER_ID
      + ' model (for example MiniMax-M3, or MiniMax-M3.1-Flash) and retry.',
      'MINIMAX_VIDEO_WRONG_PROVIDER',
    )
  }
}

/**
 * Prove the `durationSeconds` argument is legal FOR THE MODEL the caller picked.
 *
 * The window is not a property of the endpoint, it is a property of the model,
 * and the service said so itself (docs/minimax-video-free-checks.md section 2.1,
 * verbatim):
 *
 * > use 4-15 seconds for MiniMax-H3, 5-15 seconds for MiniMax-H3-Max, or 6/10
 * > seconds for Hailuo 2.3
 *
 * So a single 4-15 check is wrong in both directions: it lets 7 s through to
 * Hailuo (which accepts only 6 or 10) and it refuses 4 s on H3-Max (which
 * accepts 5-15). Both are refusals the service makes AFTER billing the submit,
 * which is why they are caught here for free instead.
 *
 * `0` IS NOT AN OUT-OF-RANGE VALUE. The service treats it as ABSENT - asked for
 * `duration: 0` it answers "duration is required for MiniMax-H3" (section 2.2) -
 * so it is reported as a missing argument rather than as a number outside the
 * window, and the caller is told the model's legal values rather than a range
 * that would not have applied anyway.
 *
 * @param value - the caller's argument, in seconds.
 * @param model - the model id the submit names, which selects the rule.
 * @returns the same value, proven legal for that model.
 * @throws HarnessError naming THAT model's accepted values.
 */
export function assertVideoDuration(value: unknown, model: MinimaxVideoModel): number {
  const rule = videoModelRule(model)?.duration ?? { kind: 'range', min: MINIMAX_VIDEO_MIN_DURATION_SECONDS, max: MINIMAX_VIDEO_MAX_DURATION_SECONDS }
  const allowed = describeDurationRule(rule)
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new HarnessError(
      'durationSeconds must be a whole number of seconds, got ' + JSON.stringify(value) + '. '
      + model + ' accepts ' + allowed + '.',
      'MINIMAX_VIDEO_DURATION_INVALID',
    )
  }
  if (value === 0) {
    // MEASURED equivalence: the service reports 0 as a MISSING duration, not as
    // an out-of-range one, so the two get the same treatment here.
    throw new HarnessError(
      'durationSeconds must be specified: ' + model + ' requires a duration, and 0 is treated as absent '
      + 'by the service (it answers "duration is required"). ' + model + ' accepts ' + allowed + '.',
      'MINIMAX_VIDEO_DURATION_REQUIRED',
    )
  }
  const legal = rule.kind === 'range'
    ? value >= rule.min && value <= rule.max
    : rule.values.includes(value)
  if (!legal) {
    throw new HarnessError(
      'durationSeconds must be ' + allowed + ' for ' + model + ', got ' + String(value) + '.',
      'MINIMAX_VIDEO_DURATION_OUT_OF_RANGE',
    )
  }
  return value
}

/**
 * Prove the `resolution` argument is one THIS MODEL accepts, spelled exactly.
 *
 * The service validates the value against the model, and its sentence names the
 * model AND its own pair. All three are MEASURED, verbatim
 * (docs/minimax-video-model-rules.md sections 1 and 2.1, plus
 * docs/minimax-video-free-checks.md section 2.3 for H3):
 *
 * > model resolution for `MiniMax-H3` must be `768P` or `2K`
 * > model resolution for `MiniMax-H3-Max` must be `480P` or `768P`
 * > model resolution for `MiniMax-Hailuo-2.3` must be `768P` or `1080P`
 *
 * Three measured consequences:
 *
 * 1. `1080P` is a real resolution in general and ILLEGAL for H3, so the check
 *    cannot be "is it in the union" - it has to be "is it in THIS model's set".
 * 2. The sets are PAIRWISE DIFFERENT and none of them is the union: `2K` is
 *    H3's alone, `480P` is H3-Max's alone, `1080P` is Hailuo's alone. Nothing
 *    in this function may fall back to {@link MINIMAX_VIDEO_RESOLUTION_UNION}
 *    for a model that has a row.
 * 3. The match is CASE-SENSITIVE. `720p` and `4K` came back with the identical
 *    sentence, so a lowercase spelling is refused exactly like an invented one.
 *    The value is trimmed but NOT case-folded, and `'768p'` must stay refused.
 *
 * @param value - the caller's argument.
 * @param model - the model id the submit names, which selects the set.
 * @returns the matched member, exactly as it will be sent.
 * @throws HarnessError listing THAT model's accepted spellings.
 */
export function assertVideoResolution(value: unknown, model: MinimaxVideoModel): MinimaxVideoResolution {
  const rule = videoModelRule(model)
  // The fallback is the UNION, and it is a deliberate last resort rather than a
  // rule: this branch only runs for a model id this build has no row for, which
  // assertVideoModel has already refused by the time the tool executes. It is
  // spelled out here instead of throwing so the validator stays total.
  const allowed: readonly MinimaxVideoResolution[] = rule?.resolutions ?? MINIMAX_VIDEO_RESOLUTION_UNION
  const listed = allowed.map(entry => '"' + entry + '"').join(', ')
  const note = rule === undefined ? '' : resolutionProvenanceNote(rule)
  const candidate = typeof value === 'string' ? value.trim() : ''
  // Exact, case-sensitive comparison: '768p' is not '768P'.
  const match = allowed.find(entry => entry === candidate)
  if (match === undefined) {
    throw new HarnessError(
      'resolution must be one of ' + listed + ' for ' + model + ', got ' + JSON.stringify(value) + '.'
      + ' The match is case-sensitive, so "' + candidate + '" is not accepted unless it is spelled exactly'
      + ' as one of those values.' + note,
      'MINIMAX_VIDEO_RESOLUTION_INVALID',
    )
  }
  return match
}

/* ------------------------------------------------------------------------- *
 * The submit-side rules: ratio/resolution linkage, media limits, and the
 * one-submit-per-turn guard
 * ------------------------------------------------------------------------- */

/**
 * Every `ratio` spelling the service accepts, in upstream's own order.
 *
 * COPIED FROM UPSTREAM'S SCHEMA (docs/minimax-video-extended-spec.md section 1),
 * including `adaptive`. `adaptive` is listed even though a caller should rarely
 * type it, because the LINKAGE below produces it: on the H3 family a keyframe
 * submit OVERWRITES whatever ratio was given with `adaptive`, and a reference
 * submit defaults to it.
 */
export const MINIMAX_VIDEO_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'] as const
export type MinimaxVideoRatio = (typeof MINIMAX_VIDEO_RATIOS)[number]

/** The ratio the H3 linkage sends for a text-only submit (upstream: `ratio ?? '16:9'`). */
export const MINIMAX_H3_TEXT_DEFAULT_RATIO: MinimaxVideoRatio = '16:9'

/** The ratio the H3 linkage FORCES when a first and/or last frame is present. */
export const MINIMAX_KEYFRAME_RATIO: MinimaxVideoRatio = 'adaptive'

/** The ratio the H3 linkage falls back to when reference media is present. */
export const MINIMAX_REFERENCE_DEFAULT_RATIO: MinimaxVideoRatio = 'adaptive'

/**
 * The resolution the H3 linkage sends when the caller names none.
 *
 * UPSTREAM'S DEFAULT (`input.resolution ?? '2K'`), applied only where it is a
 * LEGAL value for that model - see {@link resolveVideoSubmissionResolution} for
 * the one row where the literal rule and the measured table disagree.
 */
export const MINIMAX_H3_DEFAULT_RESOLUTION: MinimaxVideoResolution = '2K'

/**
 * Whether this model belongs to the H3 family, which is what the ratio and
 * resolution linkage is written for.
 *
 * THE SAME PREDICATE UPSTREAM USES (`isH3VideoModel`), and the same one that
 * decides reference-media support: H3 and H3-Max take the reference collections
 * and the linkage defaults, Hailuo-2.3 takes neither.
 *
 * @param model - a model id.
 * @returns true for `MiniMax-H3` and `MiniMax-H3-Max`.
 */
export function isH3VideoModel(model: string): boolean {
  return model === 'MiniMax-H3' || model === 'MiniMax-H3-Max'
}

/**
 * Prove the `ratio` argument is one of the spellings the service knows.
 *
 * ONLY THE SPELLING IS CHECKED HERE. Which ratio is finally sent is decided by
 * {@link resolveVideoSubmissionRatio}, because on the H3 family the caller's
 * choice is often replaced (a keyframe submit is forced to `adaptive`) and on
 * Hailuo it is passed through untouched. Refusing an invented spelling here means
 * the linkage never has to reason about a value the service would reject anyway,
 * and it costs no request.
 *
 * @param value - the caller's argument.
 * @returns the matched spelling, exactly as the schema lists it.
 * @throws HarnessError `MINIMAX_VIDEO_RATIO_INVALID` listing every spelling.
 */
export function assertVideoRatio(value: unknown): MinimaxVideoRatio {
  const candidate = typeof value === 'string' ? value.trim() : ''
  const match = MINIMAX_VIDEO_RATIOS.find(entry => entry === candidate)
  if (match === undefined) {
    throw new HarnessError(
      'ratio must be one of ' + MINIMAX_VIDEO_RATIOS.map(entry => '"' + entry + '"').join(', ')
      + ', got ' + JSON.stringify(value) + '. The match is case-sensitive. '
      + 'On MiniMax-H3 and MiniMax-H3-Max it is usually better to omit it: a first/last frame is forced to '
      + '"adaptive", reference media defaults to "adaptive", and a text-only submit defaults to "16:9".',
      'MINIMAX_VIDEO_RATIO_INVALID',
    )
  }
  return match
}

/** Everything the ratio rule branches on. */
export interface MinimaxVideoRatioDecision {
  /** The model the submit names; only the H3 family gets a default. */
  readonly model: MinimaxVideoModel
  /** The caller's ratio, already proven to be a known spelling. */
  readonly ratio?: MinimaxVideoRatio
  /** True when `inputImagePath` and/or `lastFrameImagePath` is present. */
  readonly hasKeyframes: boolean
  /** True when at least one reference image, video or audio is present. */
  readonly hasReferences: boolean
}

/**
 * Decide the ratio that is actually SENT, or undefined when none is.
 *
 * COPIED FROM UPSTREAM (`submit-video-generation.ts:77-86`), branch for branch:
 *
 * ```ts
 * const effectiveRatio = isH3VideoModel(model)
 *   ? hasKeyframes ? 'adaptive'
 *     : hasReferences ? (ratio ?? 'adaptive')
 *     : (ratio ?? '16:9')
 *   : ratio
 * ```
 *
 * ONE REFUSAL IS ADDED ON TOP, and it comes from upstream's own description
 * ("cannot use adaptive"): `adaptive` means "adapt to the input frame", so a
 * TEXT-ONLY submit has nothing to adapt to. Sending it anyway would spend a
 * billed request learning what upstream already states, so it is refused here,
 * for every model - a text-only adaptive request is meaningless whichever model
 * reads it. On the H3 family the refusal is also unavoidable rather than
 * pedantic: the text-only branch would otherwise have replaced it with `16:9`
 * silently, and a caller who asked for `adaptive` and got `16:9` was never told.
 *
 * @param input - the model, the caller's ratio, and what the call carries.
 * @returns the ratio to send, or undefined to send no `ratio` field at all.
 * @throws HarnessError `MINIMAX_VIDEO_RATIO_ADAPTIVE_UNSUPPORTED` for a
 *   text-only adaptive call.
 */
export function resolveVideoSubmissionRatio(input: MinimaxVideoRatioDecision): MinimaxVideoRatio | undefined {
  const { model, ratio, hasKeyframes, hasReferences } = input
  if (!hasKeyframes && !hasReferences && ratio === 'adaptive') {
    throw new HarnessError(
      'ratio "adaptive" cannot be used for a text-only submit: there is no first frame, last frame or '
      + 'reference media for the service to adapt the aspect ratio to. Nothing was submitted. Give a concrete '
      + 'ratio instead (' + MINIMAX_VIDEO_RATIOS.filter(entry => entry !== 'adaptive')
        .map(entry => '"' + entry + '"').join(', ')
      + '), or omit ratio entirely - a text-only H3 submit then defaults to "16:9".',
      'MINIMAX_VIDEO_RATIO_ADAPTIVE_UNSUPPORTED',
    )
  }
  if (!isH3VideoModel(model)) return ratio
  if (hasKeyframes) return MINIMAX_KEYFRAME_RATIO
  if (hasReferences) return ratio ?? MINIMAX_REFERENCE_DEFAULT_RATIO
  return ratio ?? MINIMAX_H3_TEXT_DEFAULT_RATIO
}

/**
 * Decide the resolution that is actually SENT, or undefined when none is.
 *
 * TWO VALUES, AND THEY ARE NOT THE SAME VALUE - which is the whole point of the
 * split with {@link assertVideoResolution}:
 *
 * - The CALLER's resolution is proven by `assertVideoResolution`, against the
 * measured set for the model in {@link MINIMAX_VIDEO_MODEL_RULES}. That check runs
 * first, outside this function, and is untouched by it.
 * - The value SENT is what this function returns. For the H3 family it is
 * `resolution ?? '2K'` (upstream's "defaults to 2K when omitted"); for Hailuo it
 * is whatever the caller gave, with NO default, because upstream sets none for
 * that model. THIS IS THE BEHAVIOUR CHANGE: an H3 submit that names no resolution
 * used to send no `resolution` field at all, and now sends `2K`.
 *
 * THE ONE PLACE THIS DELIBERATELY DIVERGES FROM A LITERAL COPY, and the reason is
 * MEASURED rather than stylistic: `MiniMax-H3-Max` is part of the H3 family, so
 * the literal rule would make 2K its default - and 2K is exactly the spelling its
 * measured set does NOT contain ("model resolution for MiniMax-H3-Max must be
 * 480P or 768P", docs/minimax-video-model-rules.md section 2.1). Defaulting it to
 * 2K would turn every H3-Max call that omits `resolution` into a billed submit
 * the service always refuses. So the default is applied only where it is a legal
 * member of THAT model's set; where it is not, no resolution is sent and the
 * service keeps its own default - H3-Max's behaviour is unchanged on purpose.
 *
 * @param model - the model the submit names.
 * @param resolution - the caller's value, already proven legal for that model.
 * @returns the resolution to send, or undefined to send no `resolution` field.
 */
export function resolveVideoSubmissionResolution(
  model: MinimaxVideoModel,
  resolution: MinimaxVideoResolution | undefined,
): MinimaxVideoResolution | undefined {
  if (!isH3VideoModel(model)) return resolution
  if (resolution !== undefined) return resolution
  const legal = videoModelRule(model)?.resolutions ?? MINIMAX_VIDEO_RESOLUTION_UNION
  return legal.includes(MINIMAX_H3_DEFAULT_RESOLUTION) ? MINIMAX_H3_DEFAULT_RESOLUTION : undefined
}
/** Resolve the bearer these tools present, from the line's own pool. */
async function acquireCredential(
  pool: MinimaxVideoCredentialSource,
  fetchFn: FetchLike,
): Promise<MinimaxVideoCredential> {
  // The pool is the only source with a live session on this machine: the native
  // ~/.minimax directory no longer exists, so reading the bare credential store
  // would come back empty and every call would fail to authenticate.
  const credentials = await pool.getFreshCredential(undefined, fetchFn)
  return { accessToken: credentials.accessToken, region: credentials.region }
}

/**
 * One Matrix call under the line's own transient-failure policy.
 *
 * A single network hiccup must not abandon a generation the user has already
 * paid for, so a RETRYABLE verdict is retried a bounded number of times with
 * the same backoff family the adapter uses. A terminal verdict is never
 * retried: asking the service the same refused question again only spends
 * another request.
 */
async function callWithRetry(
  options: Parameters<typeof callMatrixTool>[0] & { readonly attempts?: number },
  sleepFn: (ms: number) => Promise<void>,
  backoffMs: number,
): Promise<Awaited<ReturnType<typeof callMatrixTool>>> {
  const attempts = options.attempts ?? 3
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await callMatrixTool(options)
    } catch (error) {
      lastError = error
      if (options.signal?.aborted === true) throw error
      const retryable = error instanceof MatrixToolError ? error.classification.retryable : false
      if (!retryable || attempt === attempts - 1) throw error
      await sleepFn(backoffMs * (attempt + 1))
    }
  }
  throw lastError
}

/**
 * Submit one billed generation. EXACTLY ONE attempt, always.
 *
 * This is deliberately NOT `callWithRetry`, and the reason is money. Upstream's
 * `submit_video_generation` description states the contract:
 *
 * > A submit attempt is terminal for that exact request in the current turn. If
 * > submit returns any error, timeout, or HTTP failure, report it without
 * > inferring that a task…
 *
 * *and* `query_video_generation`'s description states the opposite rule:
 *
 * > This read-only call does not create another charge.
 *
 * So a failed submit is already terminal — re-sending the same body does not
 * resume the generation this turn started, it starts ANOTHER one, and generation
 * is billed. A retry loop here would turn one transient 503 into two charges and
 * still throw, which is strictly worse than throwing once.
 *
 * @param options - the same options {@link callMatrixTool} takes.
 * @returns the parsed submit envelope, whose `task_id` the caller then polls.
 * @throws whatever the single attempt threw, unretried and unwrapped.
 */
async function submitVideoOnce(
  options: Parameters<typeof callMatrixTool>[0],
): Promise<Awaited<ReturnType<typeof callMatrixTool>>> {
  return callMatrixTool(options)
}

/** The agent host for one region, for resolving a relative upload URL. */
function agentHostFor(region: 'cn' | 'global'): string {
  return region === 'cn' ? 'https://agent.minimax.cn' : 'https://agent.minimax.io'
}

/** First of the candidate keys that holds a non-empty string. */
function firstStringField(body: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = matrixPayloadField(body, key)
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/**
 * Prove one URL is a public destination before anything connects to it.
 *
 * The generation response's own video_url is upstream data, not a caller
 * argument, and that is exactly why the gate matters: a service - or anything
 * that has compromised its response - that answered with http://127.0.0.1/...
 * would otherwise turn this tool into a reader of the user's own machine.
 */
export async function assertPublicUrl(url: URL, what: string): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HarnessError(
      what + ' must be an http or https URL, got "' + url.protocol + '"',
      'MINIMAX_VIDEO_URL_INVALID',
    )
  }
  const addresses = await lookupHostAddresses(url.hostname).catch(() => [] as readonly string[])
  try {
    assertPublicFetchTarget(url.hostname, addresses)
  } catch (error) {
    throw new HarnessError(
      'refusing to fetch ' + what + ': ' + (error instanceof Error ? error.message : String(error)),
      'MINIMAX_VIDEO_BLOCKED_URL',
    )
  }
}

/** The one CDN host measured to work through the `url` key (upload probe section 4). */
export const MINIMAX_CDN_HOST = 'cdn.hailuoai.com'

/**
 * The agent hosts whose own addresses the service also accepts.
 *
 * MEASURED for the CDN host only (docs/minimax-video-upload-probe.md section 4:
 * `get_upload_url` answered `cdn_url` on `cdn.hailuoai.com` and citing that
 * address answered `success: true`). The `agent.minimax.` forms are accepted
 * because they are MiniMax's own origin hosts - the same family this line already
 * talks to - and refusing them would break a source the service would take. This
 * half is NOT probe-confirmed; it is the service's own-family host, accepted on
 * that basis alone.
 */
export const MINIMAX_CDN_HOST_SUFFIXES: readonly string[] = ['agent.minimax.']

/**
 * Refuse a `url` source that is not a MiniMax-hosted address.
 *
 * THE MEASURED REASON. Two of three third-party URLs were confirmed fetchable
 * from this machine - HTTP 206, `video/mp4`, `ftypmp42` - and the service still
 * answered `results[0].success: false` with `video_info.url could not be used as
 * a media source` for all three (docs/minimax-video-free-checks.md sections 5.2
 * and 5.3). The key is syntactically legal; the service simply will not go and
 * fetch a third party's address. Only its own CDN is measured to work.
 *
 * So a third-party address is refused locally, before the request, with the
 * remedy (send the local file) instead of a remote refusal that reads like a
 * transient problem.
 *
 * The exempt hosts are exactly the ones this route's own upload path produces,
 * so `transport: "upload"` never trips this check.
 *
 * `what` NAMES THE ARGUMENT, and that is not decoration: the generation submit
 * carries a whole set of media arguments (a first frame, a last frame, up to
 * nine reference images, three reference videos, three reference audios), so a
 * refusal that said only "the URL" would leave the caller hunting for which of
 * thirteen arguments it was.
 *
 * @param url - the parsed caller URL.
 * @param what - the argument being refused, named in the message.
 * @throws HarnessError `MINIMAX_VIDEO_URL_NOT_MINIMAX_CDN` for anything else.
 */
export function assertMinimaxCdnUrl(url: URL, what: string = 'the video URL'): void {
  const host = url.hostname.toLowerCase()
  const allowed = host === MINIMAX_CDN_HOST || MINIMAX_CDN_HOST_SUFFIXES.some(suffix => host.startsWith(suffix))
  if (allowed) return
  throw new HarnessError(
    'refusing ' + what + ': the URL ' + JSON.stringify(url.origin) + ' is not a MiniMax CDN address, because "'
    + host + '" is not one. '
    + 'The url field only works for MiniMax\'s own media: ' + MINIMAX_CDN_HOST + ' (what this route\'s upload '
    + 'path cites) or an ' + MINIMAX_CDN_HOST_SUFFIXES[0] + ' host. A third-party public URL is refused by the '
    + 'service itself - MEASURED, verbatim: "video_info.url could not be used as a media source" - and two of '
    + 'the three addresses that produced that sentence were confirmed fetchable by ordinary clients, so this is '
    + 'not a network problem on this side. Nothing was sent. Pass the absolute local path of the file '
    + 'instead: this route uploads a local file through get_upload_url and cites the cdn_url it gets back, '
    + 'which is exactly the host shape this check exempts - that is the supported way to have the service '
    + 'read media it does not already host.',
    'MINIMAX_VIDEO_URL_NOT_MINIMAX_CDN',
  )
}

/** One downloaded media file. */
interface DownloadedMedia {
  readonly data: Uint8Array
  readonly mediaType: string
}

/**
 * Download one video, behind the deployment's proxy-aware fetch AND the
 * address policy.
 */
async function downloadVideo(
  url: string,
  fetchFn: FetchLike,
  signal: AbortSignal | undefined,
  what: string,
): Promise<DownloadedMedia> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new HarnessError(what + ' is not a valid URL: ' + url, 'MINIMAX_VIDEO_URL_INVALID')
  }
  await assertPublicUrl(parsed, what)
  const response = await fetchFn(parsed.toString(), {
    redirect: 'error',
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new HarnessError(what + ' download failed (HTTP ' + response.status + ')', 'MINIMAX_VIDEO_DOWNLOAD_FAILED')
  }
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_GENERATED_VIDEO_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new HarnessError(
      what + ' is ' + humanBytes(declared) + ', above the ' + humanBytes(MAX_GENERATED_VIDEO_BYTES) + ' limit this route stores',
      'MINIMAX_VIDEO_TOO_LARGE',
    )
  }
  const data = new Uint8Array(await response.arrayBuffer())
  const headerType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  const mediaType = headerType.startsWith('video/') ? headerType : 'video/mp4'
  return { data, mediaType }
}

/** Media type for one path, or undefined when the container is not one this route sends. */
function mediaTypeForExtension(filePath: string): string | undefined {
  const map: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mpeg': 'video/mpeg',
    '.mpg': 'video/mpg',
  }
  return map[path.extname(filePath).toLowerCase()]
}

/** How many leading bytes the container sniff reads. Enough for every magic below. */
export const VIDEO_CONTAINER_SNIFF_BYTES = 32

/** The video container one file's first bytes declare. */
export type VideoContainerKind = 'iso-bmff' | 'matroska' | 'avi' | 'mpeg-ps'

/**
 * Identify the video container from the first bytes of a file.
 *
 * WHY THIS EXISTS AT ALL. The service answers `results[0].success: true` for
 * bytes no decoder could ever read: 1 MiB of `0x11` filler came back with a
 * confident, invented description of a tabby cat, and a 5 MiB sample with a
 * "purple onion rotating on white" (docs/minimax-video-free-checks.md section
 * 4.4). So a file that is NOT a video does not fail loudly upstream - it comes
 * back as a fabricated answer the user will believe was about their clip. The
 * cheapest place to stop that is here, on this machine, before the bytes leave.
 *
 * The four magic numbers are the ones the extensions this route accepts map to:
 *
 * | container            | leading bytes                                      |
 * | -------------------- | -------------------------------------------------- |
 * | ISO BMFF (mp4/mov)   | offset 4 is ASCII `ftyp`                            |
 * | Matroska / WebM      | `1A 45 DF A3`                                       |
 * | AVI (RIFF)           | `RIFF` at 0 and `AVI ` at 8                        |
 * | MPEG program stream  | `00 00 01 BA` (pack) or `00 00 01 B3` (video seq)   |
 *
 * @param head - the first {@link VIDEO_CONTAINER_SNIFF_BYTES} bytes (or fewer).
 * @returns the container, or undefined when the bytes are none of them.
 */
export function sniffVideoContainer(head: Uint8Array): VideoContainerKind | undefined {
  const ascii = (offset: number, length: number): string =>
    String.fromCharCode(...Array.from(head.subarray(offset, offset + length)))
  const startsWith = (signature: readonly number[]): boolean =>
    signature.every((byte, index) => head[index] === byte)

  if (head.length >= 8 && ascii(4, 4) === 'ftyp') return 'iso-bmff'
  if (startsWith([0x1a, 0x45, 0xdf, 0xa3])) return 'matroska'
  if (head.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'AVI ') return 'avi'
  if (startsWith([0x00, 0x00, 0x01, 0xba]) || startsWith([0x00, 0x00, 0x01, 0xb3])) return 'mpeg-ps'
  return undefined
}

/**
 * Read the first {@link VIDEO_CONTAINER_SNIFF_BYTES} bytes of one file.
 *
 * DELIBERATELY NOT `fs.readFile`. The whole point of the sniff is to run before
 * a file is trusted; doing it by reading the entire file first would pull an
 * arbitrary (up to the transport cap) file into memory purely to decide not to
 * use it - the same out-of-memory shape {@link readLocalVideo}'s size check
 * exists to avoid, reintroduced one layer down.
 *
 * @param filePath - the file to peek at.
 * @returns the leading bytes, at most {@link VIDEO_CONTAINER_SNIFF_BYTES}.
 */
async function readVideoHead(filePath: string): Promise<Uint8Array> {
  const handle = await fs.open(filePath, 'r')
  try {
    const buffer = new Uint8Array(VIDEO_CONTAINER_SNIFF_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, VIDEO_CONTAINER_SNIFF_BYTES, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * Read one local file the caller named, refusing anything that is not a regular file.
 *
 * `limit` is the largest file the CALLER's transport can carry — it differs
 * per transport (see the caller) and it is checked here, against
 * `stats.size`, so an oversized clip is refused AFTER the stat and BEFORE the
 * bytes are read into memory, and long before they become a request. Reading
 * first and comparing `data.byteLength` afterwards would be exactly the
 * out-of-memory path this check exists to prevent, so the two are not
 * interchangeable.
 *
 * THE CONTAINER IS SNIFFED HERE TOO, also before the read, and for a reason that
 * is not cosmetic: see {@link sniffVideoContainer}. A file whose leading bytes
 * are no known video container is refused locally with
 * `MINIMAX_VIDEO_NOT_A_CONTAINER` and NOTHING IS SENT - which is the only way
 * to guarantee the user is never handed a fabricated description of a file that
 * was never a video.
 *
 * `transport` only chooses the wording of the refusal: the same cap has very
 * different reasons on the two paths (4/3 base64 growth against a request-body
 * ceiling inline, whole-file-in-RAM against the upload cap here).
 */
async function readLocalVideo(
  input: string,
  limit: number,
  transport: MinimaxVideoTransport,
): Promise<{ data: Uint8Array; name: string; mediaType: string }> {
  if (!path.isAbsolute(input)) {
    throw new HarnessError(
      'video path must be absolute: ' + input + '. Pass an absolute path, or an http(s) URL.',
      'MINIMAX_VIDEO_PATH_NOT_ABSOLUTE',
    )
  }
  const stats = await fs.stat(input).catch(() => undefined)
  if (stats === undefined) {
    throw new HarnessError('video file not found: ' + input, 'MINIMAX_VIDEO_NOT_FOUND')
  }
  if (!stats.isFile()) {
    throw new HarnessError('video path is not a regular file: ' + input, 'MINIMAX_VIDEO_NOT_A_FILE')
  }
  if (stats.size > limit) {
    // Both sentences state the same three facts the caller needs - the size,
    // the cap, and that nothing left this process - because "too large" with no
    // number reads as an arbitrary refusal.
    throw new HarnessError(
      transport === 'upload'
        ? 'video is ' + humanBytes(stats.size) + ', above the ' + humanBytes(limit) + ' this route can upload. '
          + 'Nothing was uploaded and no request was made. The upload path reads the whole file into memory '
          + 'before it PUTs it, so this ceiling protects this process rather than the service (which accepts '
          + 'more), and it is the same number the download side applies. Send a shorter clip, or pass an '
          + 'http(s) URL the service can fetch itself.'
        : 'video is ' + humanBytes(stats.size) + ', above the ' + humanBytes(limit) + ' this route can send '
          + 'inline. Nothing was uploaded and no request was made. Inline base64 grows the bytes by 4/3 and this '
          + 'line caps a request body at ' + humanBytes(maxMessageBodyBytes()) + '. For a clip this size pass '
          + 'transport: "upload" — that path asks get_upload_url for a presigned PUT target and cites the '
          + 'cdn_url it returns instead of inlining the bytes.',
      'MINIMAX_VIDEO_TOO_LARGE',
    )
  }
  const mediaType = mediaTypeForExtension(input)
  if (mediaType === undefined) {
    throw new HarnessError(
      'unsupported video extension "' + path.extname(input) + '"; supported: .mp4 .m4v .webm .mov .avi .mpeg .mpg',
      'MINIMAX_VIDEO_TYPE_UNSUPPORTED',
    )
  }
  // THE CONTAINER CHECK, and it runs after the stat but BEFORE the file is read
  // into memory. An extension is a claim about a file's name; this is the claim
  // its own bytes make. MEASURED reason it matters: the service decoded nothing
  // at all from 1 MiB of `0x11` filler and still answered `success: true` with a
  // detailed description of a tabby cat (docs/minimax-video-free-checks.md
  // section 4.4). Sending a non-video is therefore not a loud failure - it is a
  // confident fabrication the user will read as an analysis of THEIR file. So a
  // file whose head is no known container is refused here, and the message says
  // plainly that it was NOT sent.
  const container = sniffVideoContainer(await readVideoHead(input))
  if (container === undefined) {
    throw new HarnessError(
      'refusing to send ' + input + ': its first ' + VIDEO_CONTAINER_SNIFF_BYTES + ' bytes are not the header of '
      + 'any known video container (an ISO BMFF "ftyp" box, a Matroska/WebM 1A 45 DF A3 signature, a RIFF "AVI " '
      + 'header, or an MPEG program stream 00 00 01 BA/B3), so this does not look like a video file at all. '
      + 'NOTHING WAS SENT and no request was made, so no description was produced. That matters: upstream answers '
      + 'success with an invented description for bytes it cannot decode, so sending this file would have returned '
      + 'a confident analysis of a video that does not exist. Check the path, or convert the file to mp4/webm/avi/mpeg.',
      'MINIMAX_VIDEO_NOT_A_CONTAINER',
    )
  }
  return { data: await fs.readFile(input), name: path.basename(input), mediaType }
}

/**
 * The `category` every upload body must carry, measured upstream.
 *
 * WHY IT IS A CONSTANT RATHER THAN A LITERAL AT THE CALL SITE. The value is
 * part of upstream's own measured request body
 * (`{ filename, mime_type, size_bytes, category: 'user_file_upload_tmp' }`,
 * docs/minimax-video-extended-spec.md section 2.1). It names the TEMPORARY
 * bucket the object lands in, and it is the same bucket for a video being
 * understood and for a reference image being sent to the generation service -
 * so both paths share the one spelling instead of each carrying its own copy
 * that can drift.
 */
export const MINIMAX_UPLOAD_CATEGORY = 'user_file_upload_tmp'

/**
 * One presigned upload: ask the broker, PUT the bytes, return the URL to cite.
 *
 * THIS IS THE ONE UPLOAD CHANNEL THIS ROUTE HAS, and it is shared deliberately:
 * understanding a local clip (`transport: "upload"`) and preparing every local
 * generation input (first frame, last frame, reference image/video/audio) all
 * go through the code below. The sequence it performs is the one measured end
 * to end, so a second copy of it for the generation side would be a second
 * chance to get `category`, the PUT content type, or `cdn_url`-vs-`put_url`
 * wrong - and the cache-control/`expires_in` shape is one probe result, not two.
 *
 * MEASURED END TO END. docs/minimax-video-upload-probe.md ran this exact
 * sequence live: `get_upload_url` → PUT → an unauthenticated GET of `cdn_url`
 * (bytes identical to what was uploaded) → `videos_understand` citing that
 * `cdn_url` under the `url` key, answering `results[0].success: true` with
 * `source` echoing the cdn_url.
 *
 * - The REQUEST body is `{ filename, mime_type, size_bytes }`. That is not a
 *   convention this file guessed at: the service spelled the three names out
 *   in its own error, quoted verbatim in docs/minimax-video-generation-probe.md
 *   §5 ("call matrix_get_upload_url with filename, mime_type and size_bytes").
 *   The spelling shipped before this was `file_name` / `content_type` /
 *   `file_size`, which is wrong on all three.
 * - The RESPONSE is `put_url` (the OSS-V4 presigned PUT target), `cdn_url`
 *   (the address to cite afterwards), plus `oss_key`, `content_type` and
 *   `expires_in` (600 s). Measured in probe F4 and again in the upload probe.
 * - A SUCCESSFUL PUT IS `HTTP 200`, NOT `204`. OSS answers the write with
 *   an empty body and an `etag` + `x-oss-request-id`, and the probe measured
 *   status 200. The check below is `put.ok` and must stay that way: rewriting
 *   it as `put.status === 204` — the intuitive form for "created, no content"
 *   — would reject every upload this path actually makes.
 * - THE TWO HOSTS ARE NOT THE SAME SHAPE, AND MUST NOT BE EXTRAPOLATED FROM
 *   EACH OTHER. Probe U2 failed `results[0].success: false` on a SIGNED
 *   `oss-cn-shanghai.aliyuncs.com` URL carrying `Expires` / `OSSAccessKeyId`
 *   / `Signature` query parameters. This path cites a different host:
 *   `cdn.hailuoai.com`, four path segments, NO query at all — a plain public
 *   CDN address. That one was measured working; the signed one was not, and
 *   neither result generalises to the other. Nor does this prove the `url`
 *   key works for an ARBITRARY public URL; one host, one object, one run.
 * - FIDELITY IS NOT COVERED BY `success: true`. That flag proves the
 *   reference was fetched and consumed, not that the description matches the
 *   picture. The probe uploaded a 64x64, one-second, uniformly black clip and
 *   got back a description of a stage acrobatics performance — and two
 *   independent runs described the same black frames differently ("a stage
 *   acrobatics performance", then "the whole video is a black screen"). That
 *   is MODEL-SIDE behaviour and a separate matter from a transport defect: a
 *   true `success` here is not evidence the clip was described faithfully.
 *   The tool description says so as well, at the parameter that selects this
 *   path, so the caveat is read by whoever chooses it rather than only by
 *   whoever reads this file.
 *
 * @returns the `cdn_url` to cite in `video_info[0].url`.
 * @throws HarnessError (`MINIMAX_VIDEO_UPLOAD_FAILED`) only when the broker or
 *   the PUT itself fails, naming which of the two it was.
 */
async function uploadLocalVideo(
  credential: MinimaxVideoCredential,
  options: {
    data: Uint8Array
    name: string
    mediaType: string
    fetchFn: FetchLike
    signal?: AbortSignal
    sleepFn: (ms: number) => Promise<void>
    backoffMs: number
  },
): Promise<string> {
  // Retried: reserving a URL is free and re-asking costs one request, unlike a
  // generation submit. See {@link callWithRetry}.
  const granted = await callWithRetry({
    region: credential.region,
    accessToken: credential.accessToken,
    tool: MATRIX_TOOL_GET_UPLOAD_URL,
    body: {
      filename: options.name,
      mime_type: options.mediaType,
      size_bytes: options.data.byteLength,
      // THE FOURTH FIELD, and it was missing until now: upstream's measured
      // upload body carries `category`, naming the temporary bucket the object
      // lands in (docs/minimax-video-extended-spec.md section 2.1). The three
      // names above are the ones the service spelled out in its own error;
      // this one is the one upstream's client actually sends, and leaving it
      // out is what made this body a near-miss rather than the measured shape.
      category: MINIMAX_UPLOAD_CATEGORY,
    },
    fetchFn: options.fetchFn,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }, options.sleepFn, options.backoffMs)

  const putTarget = firstStringField(granted.body, ['put_url'])
  const cdnUrl = firstStringField(granted.body, ['cdn_url'])
  if (putTarget === undefined || cdnUrl === undefined) {
    throw new HarnessError(
      'cannot upload ' + options.name + ': the media gateway answered ' + MATRIX_TOOL_GET_UPLOAD_URL
      + ' without a presigned PUT target and a citable URL. This route reads put_url and cdn_url, and the '
      + 'answer carried [' + Object.keys(granted.body).join(', ') + ']. Nothing was uploaded, so there is '
      + 'nothing to cite and no request that uses the media was made.',
      'MINIMAX_VIDEO_UPLOAD_FAILED',
    )
  }

  // The PUT target is upstream data, so it goes through the same public-address
  // gate as a download: a broker - or anything that has compromised its answer -
  // naming http://127.0.0.1/... must not turn this into a writer to this machine.
  const putUrl = new URL(putTarget, agentHostFor(credential.region))
  await assertPublicUrl(putUrl, 'the upload URL')
  const put = await options.fetchFn(putUrl.toString(), {
    method: 'PUT',
    // The broker echoes the content type it expects back in its own answer;
    // the local file's container is the fallback when it does not.
    headers: { 'content-type': firstStringField(granted.body, ['content_type']) ?? options.mediaType },
    body: options.data,
    redirect: 'error',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (!put.ok) {
    await put.body?.cancel().catch(() => undefined)
    throw new HarnessError(
      'cannot upload ' + options.name + ': the presigned PUT to the address ' + MATRIX_TOOL_GET_UPLOAD_URL
      + ' returned was refused with HTTP ' + put.status + '. Nothing was stored, so there is no cdn_url to '
      + 'cite and no request that uses the media was made.',
      'MINIMAX_VIDEO_UPLOAD_FAILED',
    )
  }
  await put.body?.cancel().catch(() => undefined)
  return cdnUrl
}

/* ------------------------------------------------------------------------- *
 * Generation media: the first/last frame, and the reference collections
 * ------------------------------------------------------------------------- */

/**
 * The tool parameter each service field name belongs to, and where they differ.
 *
 * THIS TABLE IS THE POINT OF THIS SECTION, so it is stated once, here, in the
 * service's own spelling:
 *
 * | tool parameter             | sent as            |
 * | -------------------------- | ------------------ |
 * | inputImagePath             | input_image        |
 * | lastFrameImagePath         | last_frame_image   |
 * | referenceImagePaths        | reference_images   |
 * | referenceVideoPaths        | reference_videos   |
 * | referenceAudioPaths        | reference_audios   |
 *
 * Four of the five differ from their parameter names, which is exactly the kind
 * of mapping that survives right up until someone builds the body by
 * destructuring the arguments. Nothing outside this section spells either
 * column: prepareGenerationMedia returns an object whose keys ARE the right-hand
 * column, so the submit merges it instead of re-deriving a name.
 * (docs/minimax-video-extended-spec.md section 0.)
 */

/** One prepared media argument: the shape the service reads. */
export interface MinimaxMediaPayload {
  /** A cdn.hailuoai.com address - measured to be the only url shape read. */
  readonly url: string
  readonly mime_type: string
}

/** A prepared reference video: a media payload plus the length the service needs. */
export interface MinimaxVideoMediaPayload extends MinimaxMediaPayload {
  /** Seconds, from the container or from the caller. */
  readonly duration_seconds: number
}

/**
 * Largest total number of reference media items (images + videos + audios).
 *
 * COPIED FROM UPSTREAM'S MEASURED LIMITS (spec section 6): 1-9 images, 1-3
 * videos, 1-3 audios, and never more than 12 in total. The per-set ceilings are
 * enforced as well as the total, because the two refuse different mistakes -
 * 9 images plus 3 videos is 12 items and passes both, while 13 images passes
 * neither.
 */
export const MAX_REFERENCE_MEDIA_TOTAL = 12
/** Most reference images one submit may carry. */
export const MAX_REFERENCE_IMAGES = 9
/** Most reference videos one submit may carry. */
export const MAX_REFERENCE_VIDEOS = 3
/** Most reference audios one submit may carry. */
export const MAX_REFERENCE_AUDIOS = 3

/**
 * How far a caller's stated reference-video length may sit from the length this
 * route reads out of the container before the two are treated as a contradiction.
 *
 * A SECOND of slack, because the container reports an exact rational and a
 * caller writing 10 for a 10.033 s clip is not wrong. Beyond that the two
 * describe different clips, and accepting either one silently would mean
 * sending a length the user never saw.
 */
export const MINIMAX_REFERENCE_DURATION_TOLERANCE_SECONDS = 1

/** One media kind's extensions, media types and byte ceiling. */
interface MediaKindRule {
  /** image, video or audio; used in the messages. */
  readonly kind: 'image' | 'video' | 'audio'
  /** Every extension this kind accepts (lower-case, leading dot). */
  readonly extensions: readonly string[]
  /** Extension -> media type, for the same set. */
  readonly mimeTypes: Readonly<Record<string, string>>
  /** Largest local file of this kind, in bytes. */
  readonly maxBytes: number
  /**
   * The narrower extension set one model accepts, when a model narrows it.
   *
   * Hailuo-2.3 takes only .jpg .png .webp images (spec section 2.3). Kept beside
   * the full set rather than replacing it, because the narrowing is a property
   * of THAT model, not of images.
   */
  readonly modelExtensions?: Readonly<Record<string, readonly string[]>>
}

/** Image rule: .jpg .jpeg .png .webp .heic .heif, at most 30 MiB. */
const IMAGE_RULE: MediaKindRule = {
  kind: 'image',
  extensions: ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'],
  mimeTypes: {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
  },
  maxBytes: 30 * 1024 * 1024,
  modelExtensions: { 'MiniMax-Hailuo-2.3': ['.jpg', '.png', '.webp'] },
}

/** Video rule: .mp4 .mov, at most 50 MiB. */
const VIDEO_RULE: MediaKindRule = {
  kind: 'video',
  extensions: ['.mp4', '.mov'],
  mimeTypes: { '.mp4': 'video/mp4', '.mov': 'video/quicktime' },
  maxBytes: 50 * 1024 * 1024,
}

/** Audio rule: .wav .mp3, at most 15 MiB. */
const AUDIO_RULE: MediaKindRule = {
  kind: 'audio',
  extensions: ['.wav', '.mp3'],
  mimeTypes: { '.wav': 'audio/wav', '.mp3': 'audio/mpeg' },
  maxBytes: 15 * 1024 * 1024,
}

/**
 * Everything one media preparation needs.
 *
 * sleepFn and backoffMs are here because the upload channel retries, and a test
 * must not spend the real 1.5 s doing it - the same injection the understanding
 * path already uses.
 */
export interface MinimaxMediaPrepareContext {
  readonly credential: MinimaxVideoCredential
  readonly fetchFn: FetchLike
  readonly sleepFn: (ms: number) => Promise<void>
  readonly backoffMs: number
  readonly signal?: AbortSignal
  /** The model the submit names, which can narrow the legal extension set. */
  readonly model?: MinimaxVideoModel
}

/** The media arguments one generation call may carry, as the caller typed them. */
export interface MinimaxGenerationMediaInput {
  readonly inputImagePath?: string
  readonly lastFrameImagePath?: string
  readonly referenceImagePaths?: readonly string[]
  readonly referenceVideoPaths?: readonly string[]
  readonly referenceVideoDurationSeconds?: readonly number[]
  readonly referenceAudioPaths?: readonly string[]
}

/**
 * The prepared media, keyed by the SERVICE's field names.
 *
 * The two booleans beside them are what the submit's ratio rule branches on;
 * they are reported rather than acted on here, because this layer decides what
 * is sent as media, not what ratio defaults to.
 */
export interface MinimaxGenerationMedia {
  readonly input_image?: MinimaxMediaPayload
  readonly last_frame_image?: MinimaxMediaPayload
  readonly reference_images?: readonly MinimaxMediaPayload[]
  readonly reference_videos?: readonly MinimaxVideoMediaPayload[]
  readonly reference_audios?: readonly MinimaxMediaPayload[]
  /** True when a first and/or last frame image was prepared. */
  readonly hasKeyframes: boolean
  /** True when at least one reference image, video or audio was prepared. */
  readonly hasReferences: boolean
}

/**
 * Whether this model accepts the reference collections at all.
 *
 * Hailuo-2.3 does not (spec section 7): upstream's own description limits it to
 * first_frame and the legacy subject reference type, with no image/video/audio
 * reference sets and no last frame. Both H3 models do.
 *
 * @param model - the model id the submit names.
 * @returns true for the two H3 models.
 */
export function minimaxModelSupportsReferenceMedia(model: string): boolean {
  return model === 'MiniMax-H3' || model === 'MiniMax-H3-Max'
}

/** The extensions one model accepts for one media kind. */
function extensionsFor(rule: MediaKindRule, model: string | undefined): readonly string[] {
  const narrowed = model === undefined ? undefined : rule.modelExtensions?.[model]
  return narrowed ?? rule.extensions
}

/**
 * The part of a caller's argument its extension should be read from.
 *
 * For a URL that is the PATH, not the whole string: a cdn address can carry a
 * query (?x-oss-signature=...), and path.extname('a.mp4?sig=1') is
 * '.mp4?sig=1', which matches nothing.
 */
function extensionSourceOf(pathOrUrl: string): string {
  return /^https?:\/\//i.test(pathOrUrl) ? new URL(pathOrUrl).pathname : pathOrUrl
}

/** The media type for one path or URL, or undefined when its extension is not accepted. */
function mediaTypeForMedia(
  pathOrUrl: string,
  rule: MediaKindRule,
  model: string | undefined,
): string | undefined {
  const extension = path.extname(extensionSourceOf(pathOrUrl)).toLowerCase()
  if (!extensionsFor(rule, model).includes(extension)) return undefined
  return rule.mimeTypes[extension]
}

/** A length rounded the way seconds are reported, without float noise. */
export function normalizeDurationSeconds(seconds: number): number {
  return Math.round(seconds * 1000) / 1000
}

/**
 * Refuse a local media argument whose extension or size this kind does not accept.
 *
 * BOTH REFUSALS NAME THE ARGUMENT, and they have to: one generation call can
 * carry thirteen media arguments, so "unsupported extension" with no argument
 * name is a message the caller cannot act on.
 *
 * @param filePath - the local file the caller named.
 * @param fieldName - the tool argument, for the message.
 * @returns the media type for that extension.
 */
function assertMediaFileAcceptable(
  filePath: string,
  fieldName: string,
  rule: MediaKindRule,
  stats: { readonly size: number },
  model: string | undefined,
): string {
  const accepted = extensionsFor(rule, model)
  const extension = path.extname(filePath).toLowerCase()
  if (!accepted.includes(extension)) {
    throw new HarnessError(
      fieldName + ' must be a ' + rule.kind + ' file with one of these extensions: ' + accepted.join(' ')
      + ', got ' + JSON.stringify(extension === '' ? path.basename(filePath) : extension) + ' for '
      + JSON.stringify(filePath) + '.'
      + (accepted.length < rule.extensions.length
        ? ' This model accepts a NARROWER set than the route does (' + rule.extensions.join(' ') + '), so the '
          + 'extension was refused for the model rather than for the tool.'
        : '')
      + ' Nothing was uploaded and no request was made.',
      'MINIMAX_VIDEO_MEDIA_TYPE_UNSUPPORTED',
    )
  }
  if (stats.size > rule.maxBytes) {
    throw new HarnessError(
      fieldName + ' (' + path.basename(filePath) + ') is ' + humanBytes(stats.size) + ', above the '
      + humanBytes(rule.maxBytes) + ' this route can upload for a ' + rule.kind + '. Nothing was uploaded and no '
      + 'request was made. Send a smaller file, or, where the service accepts one, a MiniMax CDN URL it can '
      + 'fetch itself.',
      'MINIMAX_VIDEO_MEDIA_TOO_LARGE',
    )
  }
  return rule.mimeTypes[extension] as string
}

/**
 * Prepare one media argument: upload a local file, or pass a MiniMax CDN URL
 * through untouched.
 *
 * THE ASYMMETRY IS MEASURED, not a shortcut. A third-party public URL is refused
 * by the service itself - "video_info.url could not be used as a media source" -
 * for addresses ordinary clients could fetch, so the only remote form that works
 * is MiniMax's own CDN, which is exactly what this route's upload returns. Hence:
 *
 * - a local file is READ and uploaded through uploadLocalVideo, and the cdn_url
 *   it returns is what gets cited;
 * - an https://cdn.hailuoai.com/... URL is passed through with no request at all;
 * - anything else http(s) is refused locally (spec section 2.2).
 *
 * IT NEVER INLINES. These are inputs to a generation task, not something to be
 * described, and upstream forces the remote form for exactly that reason
 * (forceRemoteUrl: true, spec section 2.1).
 */
async function prepareMediaInput(
  pathOrUrl: string,
  fieldName: string,
  rule: MediaKindRule,
  context: MinimaxMediaPrepareContext,
  options: {
    /**
     * A check that must run BEFORE the bytes are read and PUT.
     *
     * IT EXISTS FOR ONE REASON: a local reference video's length is read out of
     * the same file, and that read can fail (no moov, corrupt box, a container
     * the service would refuse anyway). Running it first means such a file costs
     * NO upload request, and the failure names the container rather than
     * whatever the upload happened to answer.
     */
    readonly beforeUpload?: (filePath: string) => Promise<void>
  } = {},
): Promise<MinimaxMediaPayload> {
  const source = pathOrUrl.trim()
  if (source === '') {
    throw new HarnessError(
      fieldName + ' is empty. Give an absolute path to a local ' + rule.kind + ' file, or an http(s) URL on '
      + MINIMAX_CDN_HOST + '.',
      'MINIMAX_VIDEO_MEDIA_EMPTY',
    )
  }

  if (/^https?:\/\//i.test(source)) {
    let parsed: URL
    try {
      parsed = new URL(source)
    } catch {
      throw new HarnessError(
        fieldName + ' is not a valid URL: ' + JSON.stringify(source),
        'MINIMAX_VIDEO_URL_INVALID',
      )
    }
    // Named argument, because there may be thirteen of them.
    assertMinimaxCdnUrl(parsed, fieldName)
    await assertPublicUrl(parsed, fieldName)
    const declared = mediaTypeForMedia(parsed.toString(), rule, context.model)
    if (declared === undefined) {
      const accepted = extensionsFor(rule, context.model)
      throw new HarnessError(
        fieldName + ' must point at a file with one of these extensions: ' + accepted.join(' ') + ', got '
        + JSON.stringify(path.extname(parsed.pathname)) + ' for ' + JSON.stringify(source) + '.'
        + (accepted.length < rule.extensions.length
          ? ' This model accepts a NARROWER set than the route does (' + rule.extensions.join(' ') + '), so the '
            + 'extension was refused for the model rather than for the tool.'
          : '')
        + ' The extension is read from the URL path, before any query string. Nothing was sent.',
        'MINIMAX_VIDEO_MEDIA_TYPE_UNSUPPORTED',
      )
    }
    return { url: parsed.toString(), mime_type: declared }
  }

  if (!path.isAbsolute(source)) {
    throw new HarnessError(
      fieldName + ' must be an absolute path or an http(s) URL: ' + JSON.stringify(source) + '. A relative '
      + 'path is resolved against whatever directory the tool happened to run in, which is not necessarily the '
      + 'file the caller meant.',
      'MINIMAX_VIDEO_PATH_NOT_ABSOLUTE',
    )
  }
  const stats = await fs.stat(source).catch(() => undefined)
  if (stats === undefined || !stats.isFile()) {
    throw new HarnessError(
      fieldName + ' is not a file: ' + JSON.stringify(source) + '. Nothing was uploaded and no request was made.',
      'MINIMAX_VIDEO_MEDIA_NOT_FOUND',
    )
  }
  // Extension and size first: both are refusals that must cost no request.
  const mimeType = assertMediaFileAcceptable(source, fieldName, rule, stats, context.model)
  // Then anything else the caller must prove, still before a byte is read.
  if (options.beforeUpload !== undefined) await options.beforeUpload(source)
  const data = await fs.readFile(source)
  const url = await uploadLocalVideo(context.credential, {
    data,
    name: path.basename(source),
    mediaType: mimeType,
    fetchFn: context.fetchFn,
    sleepFn: context.sleepFn,
    backoffMs: context.backoffMs,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  })
  return { url, mime_type: mimeType }
}

/**
 * Prepare an image argument (a first frame, a last frame, or a reference).
 *
 * @param pathOrUrl - absolute local path, or a MiniMax CDN URL.
 * @param fieldName - the tool argument, for every message this can raise.
 * @param context - credential, fetch, retry policy and the model.
 * @returns an object with url and mime_type.
 */
export async function prepareImageInput(
  pathOrUrl: string,
  fieldName: string,
  context: MinimaxMediaPrepareContext,
): Promise<MinimaxMediaPayload> {
  return prepareMediaInput(pathOrUrl, fieldName, IMAGE_RULE, context)
}

/**
 * Prepare an audio argument.
 *
 * @param pathOrUrl - absolute local path, or a MiniMax CDN URL.
 * @param fieldName - the tool argument, for every message this can raise.
 * @param context - credential, fetch, retry policy and the model.
 * @returns an object with url and mime_type.
 */
export async function prepareAudioInput(
  pathOrUrl: string,
  fieldName: string,
  context: MinimaxMediaPrepareContext,
): Promise<MinimaxMediaPayload> {
  return prepareMediaInput(pathOrUrl, fieldName, AUDIO_RULE, context)
}

/**
 * Reconcile the caller's stated reference-video length with the one this route
 * read out of the file.
 *
 * THE CALLER WINS, BUT NOT SILENTLY (spec section 4.4): a caller may deliberately
 * trim a clip and state the trimmed length, so their number is the one sent -
 * but if the container disagrees by more than
 * MINIMAX_REFERENCE_DURATION_TOLERANCE_SECONDS the two are describing different
 * things, and sending either one quietly would mean the user believes a 5 s
 * reference was used while 12 s went out.
 *
 * @param fieldName - the tool argument, for the message.
 * @param measured - seconds read from the container.
 * @param given - the caller's value, when they supplied one.
 * @returns the length to send.
 * @throws HarnessError naming BOTH values when they contradict each other.
 */
export function reconcileReferenceVideoDurationSeconds(
  fieldName: string,
  measured: number,
  given: number | undefined,
): number {
  const fromContainer = normalizeDurationSeconds(measured)
  if (given === undefined) return fromContainer
  if (typeof given !== 'number' || !Number.isFinite(given) || given <= 0) {
    throw new HarnessError(
      fieldName + ' must be a positive number of seconds, got ' + JSON.stringify(given)
      + '. Omit it for a local file - the length is read from the container - and give it only for a URL.',
      'MINIMAX_VIDEO_REFERENCE_DURATION_INVALID',
    )
  }
  if (Math.abs(given - fromContainer) > MINIMAX_REFERENCE_DURATION_TOLERANCE_SECONDS) {
    throw new HarnessError(
      fieldName + ' was given as ' + given + ' s, but the file itself says ' + fromContainer + ' s (an ISO BMFF '
      + 'mvhd duration). Those describe different clips, so neither was sent. Give the length that matches the '
      + 'file, or pass the trimmed file so the two agree. A difference of up to '
      + MINIMAX_REFERENCE_DURATION_TOLERANCE_SECONDS + ' s is treated as rounding and allowed.',
      'MINIMAX_VIDEO_REFERENCE_DURATION_MISMATCH',
    )
  }
  return given
}

/**
 * Prepare a reference video: the media payload PLUS the length it must carry.
 *
 * THE LENGTH COMES FROM TWO PLACES AND THEY ARE NOT INTERCHANGEABLE:
 *
 * - a LOCAL file is read here, out of the container's own moov/mvhd
 *   (readIsoBmffDurationSeconds), so the caller owes nothing;
 * - a REMOTE URL cannot be read - this route does not download a reference to
 *   measure it, and the service does not either - so the caller MUST state it,
 *   and a missing value is refused rather than guessed (spec section 4.2).
 *
 * @param pathOrUrl - absolute local path, or a MiniMax CDN URL.
 * @param fieldName - the tool argument, for every message this can raise.
 * @param durationSeconds - the caller's stated length, when they gave one.
 * @param context - credential, fetch, retry policy and the model.
 * @returns an object with url, mime_type and duration_seconds.
 */
export async function prepareVideoInput(
  pathOrUrl: string,
  fieldName: string,
  durationSeconds: number | undefined,
  context: MinimaxMediaPrepareContext,
): Promise<MinimaxVideoMediaPayload> {
  const source = pathOrUrl.trim()
  const remote = /^https?:\/\//i.test(source)

  /** Read the length out of the container, with this argument named in the refusal. */
  const measure = async (filePath: string): Promise<number> => {
    try {
      return await readIsoBmffDurationSeconds(filePath)
    } catch (error) {
      // The reader's own code travels: it is already the specific one
      // (not ISO BMFF, no mvhd, unreadable mvhd) a caller can act on.
      if (error instanceof IsoBmffDurationError) {
        throw new HarnessError('cannot prepare ' + fieldName + ' (' + filePath + '): ' + error.message, error.code)
      }
      throw error
    }
  }

  if (remote) {
    if (durationSeconds === undefined || durationSeconds === null) {
      throw new HarnessError(
        fieldName + ' is a public URL, so its length cannot be read here: this route does not download a '
        + 'reference clip to measure it, and the service does not either. Add the clip length in seconds beside '
        + 'it, in referenceVideoDurationSeconds, in the same order as referenceVideoPaths. Nothing was submitted.',
        'MINIMAX_VIDEO_REFERENCE_DURATION_REQUIRED',
      )
    }
    return {
      ...await prepareMediaInput(source, fieldName, VIDEO_RULE, context),
      duration_seconds: durationSeconds,
    }
  }

  // MEASURED BEFORE THE UPLOAD, not after: a file whose container states no
  // length is refused here, so it never costs a byte read or an upload request,
  // and the failure names the container instead of whatever the broker said.
  let measured = 0
  const payload = await prepareMediaInput(source, fieldName, VIDEO_RULE, context, {
    beforeUpload: async (filePath) => {
      measured = await measure(filePath)
    },
  })
  return {
    ...payload,
    duration_seconds: reconcileReferenceVideoDurationSeconds(fieldName, measured, durationSeconds),
  }
}

/** Trim a caller's list, dropping blank entries. */
function cleanList(values: readonly string[] | undefined): string[] {
  if (values === undefined) return []
  return values.map(value => value.trim()).filter(value => value !== '')
}

/**
 * Refuse a collection that is over its own limit, naming the set and the excess.
 *
 * THE EXCESS IS A NUMBER, not an adjective. "too many reference images" leaves
 * the caller to work out how many to drop; "3 over the limit of 9" does not.
 *
 * @param fieldName - the tool argument, for the message.
 * @param label - what the set is, in words.
 * @param count - how many were given.
 * @param limit - the ceiling.
 */
function assertCollectionSize(fieldName: string, label: string, count: number, limit: number): void {
  if (count <= limit) return
  throw new HarnessError(
    fieldName + ' carries ' + count + ' ' + label + ', which is ' + (count - limit) + ' over the limit of '
    + limit + '. Nothing was submitted. Remove ' + (count - limit) + ' and retry.',
    'MINIMAX_VIDEO_REFERENCE_LIMIT',
  )
}

/**
 * Prepare every media argument of one generation submit.
 *
 * The ORDER of the refusals is deliberate: the free ones come first. A model
 * that does not accept reference media at all is refused before a single file is
 * read, and the counts are checked before any upload, so an over-limit call
 * costs no request instead of nine uploads and then a refusal.
 *
 * @param input - the media arguments as the caller typed them.
 * @param model - the model the submit names, which constrains what is legal.
 * @param context - credential, fetch, retry policy.
 * @returns the media keyed by the SERVICE's field names, plus the two booleans
 *   the ratio rule branches on.
 * @throws HarnessError for any refusal; nothing is uploaded before the last free
 *   check has passed.
 */
export async function prepareGenerationMedia(
  input: MinimaxGenerationMediaInput,
  model: MinimaxVideoModel,
  context: MinimaxMediaPrepareContext,
): Promise<MinimaxGenerationMedia> {
  const images = cleanList(input.referenceImagePaths)
  const videos = cleanList(input.referenceVideoPaths)
  const audios = cleanList(input.referenceAudioPaths)
  const firstFrame = input.inputImagePath?.trim() ?? ''
  const lastFrame = input.lastFrameImagePath?.trim() ?? ''
  const durations = input.referenceVideoDurationSeconds ?? []
  const hasReferences = images.length > 0 || videos.length > 0 || audios.length > 0

  // THE MODEL GATE, before anything is read: Hailuo-2.3 has neither the
  // reference collections nor a last frame (spec section 7). Both refusals name
  // the argument, because "this model does not support that" is not actionable
  // when thirteen arguments could be the one.
  if (!minimaxModelSupportsReferenceMedia(model)) {
    if (hasReferences) {
      const carried = [
        images.length === 0 ? '' : images.length + ' reference image(s)',
        videos.length === 0 ? '' : videos.length + ' reference video(s)',
        audios.length === 0 ? '' : audios.length + ' reference audio(s)',
      ].filter(part => part !== '').join(', ')
      throw new HarnessError(
        model + ' does not accept reference media, and this call carries ' + carried
        + '. It takes a first frame, or the legacy subject reference type, and nothing else. Nothing was '
        + 'submitted. Remove referenceImagePaths / referenceVideoPaths / referenceAudioPaths, or switch to '
        + 'MiniMax-H3, which accepts them.',
        'MINIMAX_VIDEO_REFERENCES_UNSUPPORTED',
      )
    }
    if (lastFrame !== '') {
      throw new HarnessError(
        model + ' does not accept lastFrameImagePath: it supports first_frame (or the legacy subject reference '
        + 'type) and nothing else, so a last frame cannot be honoured. Nothing was submitted. Drop '
        + 'lastFrameImagePath, or switch to MiniMax-H3 and pass both frames there.',
        'MINIMAX_VIDEO_LAST_FRAME_UNSUPPORTED',
      )
    }
  }

  // THE COUNTS, also before anything is read or uploaded.
  assertCollectionSize('referenceImagePaths', 'reference image(s)', images.length, MAX_REFERENCE_IMAGES)
  assertCollectionSize('referenceVideoPaths', 'reference video(s)', videos.length, MAX_REFERENCE_VIDEOS)
  assertCollectionSize('referenceAudioPaths', 'reference audio(s)', audios.length, MAX_REFERENCE_AUDIOS)
  const total = images.length + videos.length + audios.length
  if (total > MAX_REFERENCE_MEDIA_TOTAL) {
    throw new HarnessError(
      'this call carries ' + total + ' reference media item(s) (' + images.length + ' image(s), ' + videos.length
      + ' video(s), ' + audios.length + ' audio(s)), which is ' + (total - MAX_REFERENCE_MEDIA_TOTAL)
      + ' over the combined limit of ' + MAX_REFERENCE_MEDIA_TOTAL + '. Nothing was submitted. The per-set limits '
      + 'are also enforced (' + MAX_REFERENCE_IMAGES + ' images, ' + MAX_REFERENCE_VIDEOS + ' videos, '
      + MAX_REFERENCE_AUDIOS + ' audios), so a call can pass those and still be over this one.',
      'MINIMAX_VIDEO_REFERENCE_LIMIT',
    )
  }
  // The duration array is POSITIONAL beside the video list (spec section 1), so a
  // length disagreement would pair every item after the first mismatch with the
  // wrong clip.
  if (durations.length !== 0 && durations.length !== videos.length) {
    throw new HarnessError(
      'referenceVideoDurationSeconds has ' + durations.length + ' entr'
      + (durations.length === 1 ? 'y' : 'ies') + ' but referenceVideoPaths has ' + videos.length + ', and the two '
      + 'are matched by POSITION. Nothing was submitted. Give one length per video, in the same order, or omit '
      + 'the array entirely when every video is a local file, whose length is then read from the container.',
      'MINIMAX_VIDEO_REFERENCE_DURATION_INVALID',
    )
  }

  const prepared: {
    input_image?: MinimaxMediaPayload
    last_frame_image?: MinimaxMediaPayload
    reference_images?: MinimaxMediaPayload[]
    reference_videos?: MinimaxVideoMediaPayload[]
    reference_audios?: MinimaxMediaPayload[]
  } = {}

  // The first frame is input_image on the wire, never input_image_path.
  if (firstFrame !== '') {
    prepared.input_image = await prepareImageInput(firstFrame, 'inputImagePath', context)
  }
  if (lastFrame !== '') {
    prepared.last_frame_image = await prepareImageInput(lastFrame, 'lastFrameImagePath', context)
  }
  if (images.length > 0) {
    const list: MinimaxMediaPayload[] = []
    for (const [index, item] of images.entries()) {
      list.push(await prepareImageInput(item, 'referenceImagePaths[' + index + ']', context))
    }
    prepared.reference_images = list
  }
  if (videos.length > 0) {
    const list: MinimaxVideoMediaPayload[] = []
    for (const [index, item] of videos.entries()) {
      list.push(await prepareVideoInput(item, 'referenceVideoPaths[' + index + ']', durations[index], context))
    }
    prepared.reference_videos = list
  }
  if (audios.length > 0) {
    const list: MinimaxMediaPayload[] = []
    for (const [index, item] of audios.entries()) {
      list.push(await prepareAudioInput(item, 'referenceAudioPaths[' + index + ']', context))
    }
    prepared.reference_audios = list
  }

  return {
    ...prepared,
    hasKeyframes: prepared.input_image !== undefined || prepared.last_frame_image !== undefined,
    hasReferences,
  }
}

/**
 * One terminal state the generation task can report.
 *
 * The shape is measured, and every field is at the TOP level of the envelope
 * (docs/minimax-video-generation-probe.md §2):
 *
 * ```json
 * {"code":0,"message":"ok","task_id":"...","model":"MiniMax-H3","status":"succeeded",
 *  "video_url":"https://...","resolution":"768P","duration":4,"ratio":"16:9",
 *  "created_at":...,"updated_at":...,"total_seconds":4,"output_seconds":4}
 * ```
 *
 * `duration` is the clip length in SECONDS; `video_url` appears only once the
 * task settles and is absent while it is `running`; `total_seconds` and
 * `output_seconds` are the service's own accounting and are not read here.
 */
function taskStatusOf(body: Record<string, unknown>): { status: string; videoUrl?: string; duration?: number } {
  const status = matrixPayloadField(body, 'status')
  const videoUrl = matrixPayloadField(body, 'video_url')
  const duration = matrixPayloadField(body, 'duration')
  return {
    status: typeof status === 'string' ? status.trim().toLowerCase() : '',
    ...(typeof videoUrl === 'string' && videoUrl.trim() !== '' ? { videoUrl: videoUrl.trim() } : {}),
    ...(typeof duration === 'number' && Number.isFinite(duration) ? { duration } : {}),
  }
}

/** One `results[]` entry of a videos_understand answer, as measured. */
interface UnderstandResult {
  /** Whether the model actually read the clip. NOT the whole verdict, see below. */
  readonly success: boolean | undefined
  /** The answer; empty when the entry failed. */
  readonly description: string
  /** Why it failed; empty when it did not. */
  readonly error: string
  /**
   * What the service says it consumed: `inline:<N>B` for an inlined clip, or the
   * URL itself for a referenced one.
   *
   * READ AS EVIDENCE, NOT AS DECORATION. On the inline path the `N` is a
   * faithful byte count - a 1 048 576-byte request came back as
   * `inline:1048576B` (docs/minimax-video-free-checks.md section 4.3) - so a
   * count that disagrees with what was sent is positive proof the bytes did not
   * arrive whole, whatever `success` says.
   */
  readonly source: string
}

/**
 * Extract the byte count from an `inline:<N>B` source, or undefined.
 *
 * Only the inline spelling carries a count; a URL source echoes the URL, and a
 * body with no `source` at all carries nothing. Both are "no count", and the
 * caller SKIPS the cross-check rather than failing it.
 *
 * @param source - the measured `results[0].source`.
 * @returns the byte count, or undefined when the source is not `inline:<N>B`.
 */
export function inlineSourceBytes(source: string): number | undefined {
  const match = /^inline:(\d+)B$/i.exec(source.trim())
  return match === null ? undefined : Number(match[1])
}

/**
 * The sentences a model uses to say it never saw a video.
 *
 * MEASURED NEED. Upstream returned "您似乎没有上传或附上任何视频" ("it looks like you
 * did not upload or attach any video") for synthetic bytes that were, in the same
 * run, described as a fleeing man in an alley (docs/minimax-video-free-checks.md
 * section 4.4). That is the SERVICE saying it saw nothing, which is a failure
 * however `success` is set - so it is detected and reported as one.
 *
 * Bilingual because the answer comes back in the language of the PROMPT, and
 * this tool's default prompt is Chinese.
 *
 * This is the probe's regex plus one deliberate addition: `did not (see|upload|attach)`.
 * The probe's original spelled only the contracted `didn't`, so the equally
 * ordinary "I did not see a video" slipped through - a refusal that reads as an
 * answer is the one failure shape this check exists to remove, so the
 * uncontracted form is covered too.
 */
const NO_VIDEO_VIEWED = /没有上传|上传视频|无法看到|没有附上|no video|didn'?t (see|upload|attach)|did not (see|upload|attach)|not (able to|saw)|no (video|content) (was )?(attached|provided)/i

/**
 * Whether this text says the video was never seen.
 *
 * @param text - the description, the error, or both joined.
 * @returns true when the text declares no video was received.
 */
export function declaresNoVideoViewed(text: string): boolean {
  return text !== '' && NO_VIDEO_VIEWED.test(text)
}

/**
 * Read `results[0]` out of one videos_understand answer.
 *
 * WHERE THE VERDICT LIVES. It is not the HTTP status - every measured call,
 * including the three that failed, answered HTTP 200 - and it is not
 * `base_resp.status_code`, which stayed `0` even for the silently failed ones
 * (docs/minimax-video-generation-probe.md §3.2, U1 and U2). It is
 * `results[0].success`, and the text is `results[0].description`, with
 * `results[0].error` carrying the service's own sentence when it is false:
 *
 * ```json
 * {"results":[{"success":true,"description":"这段视频……","error":"","source":"inline:12865B"}]}
 * ```
 *
 * Treating a missing count or an empty description as the only failure — which
 * the previous extraction did — reports U1's refusal as a successful analysis
 * of nothing. So `success` is read first and `undefined` (a body that does not
 * carry the field at all) is deliberately NOT `false`: an older or partial
 * answer is still worth the text it carries, and the caller refuses an empty
 * one anyway.
 *
 * `source` is read here as well, because it is the only BYTE-LEVEL receipt the
 * answer carries - see {@link UnderstandResult.source} and
 * {@link inlineSourceBytes}.
 */
function understandResultOf(body: Record<string, unknown>): UnderstandResult | undefined {
  const results = matrixPayloadField(body, 'results')
  if (!Array.isArray(results) || results.length === 0) return undefined
  const first: unknown = results[0]
  if (typeof first !== 'object' || first === null) return undefined
  const entry = first as Record<string, unknown>
  const textOf = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  return {
    success: typeof entry.success === 'boolean' ? entry.success : undefined,
    description: textOf(entry.description),
    error: textOf(entry.error),
    source: textOf(entry.source),
  }
}

/**
 * Build the video-understanding tool.
 *
 * @param ctx - host context (the route gate needs no service, but the context
 *   is kept for symmetry with the generation tool and for later extensions).
 * @param options - credential source, fetch and the injectable clocks.
 * @returns a registry-ready tool definition.
 */
export function createMinimaxUnderstandVideoTool(ctx: Context, options: MinimaxVideoToolOptions) {
  const fetchFn = options.fetchFn ?? fetch
  const backoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS
  const sleepFn = (ms: number): Promise<void> => sleep(ms)
  void ctx
  return defineTool({
    name: MINIMAX_UNDERSTAND_VIDEO_TOOL_NAME,
    description:
      "Describe or answer questions about a video using MiniMax Code's videos_understand tool. Pass an "
      + 'absolute local path, or an http(s) URL on MiniMax\'s own CDN (cdn.hailuoai.com, as returned by this '
      + "route's upload path); a third-party public URL is refused locally because the service will not fetch "
      + 'it. A local file is READ HERE and sent to the service as base64 inside the request - the one form a '
      + 'live probe proved this endpoint accepts - so nothing is uploaded by default and files up to '
      + Math.round(MAX_INLINE_VIDEO_BYTES / (1024 * 1024)) + ' MB work. The file must really be a video: its '
      + 'first bytes are checked against the mp4/mov, webm, avi and mpeg container headers before anything is '
      + 'sent, and a file that is none of them is refused rather than described. The model reads the clip on '
      + 'the server rather than in this conversation. The answer is text; no file is produced. '
      + 'WHAT A SUCCESS MEANS: only that the video was fetched and consumed - NOT that the description is '
      + 'accurate. MEASURED: bytes no decoder could read (1 MiB of 0x11 filler) came back with success and a '
      + 'confident, invented description, so treat the text as a model answer about the clip, not as a '
      + 'verified account of its contents. This route fails loudly on the two cases it can detect instead: the '
      + "service's own byte count disagreeing with what was sent, and the model saying it never saw a video. "
      + 'Only available on the minimax-code provider.',
    parameters: {
      source: {
        type: 'string',
        required: true,
        description: 'Absolute local file path of the video, or an http(s) URL on MiniMax\'s own CDN '
          + '(cdn.hailuoai.com). A third-party public URL is refused by the service itself - measured sentence: '
          + '"video_info.url could not be used as a media source" - so it is refused here too; download the clip '
          + 'and pass its local path instead.',
      },
      prompt: {
        type: 'string',
        description: 'What to ask about the video. Defaults to a general description request.',
      },
      transport: {
        type: 'string',
        enum: [...MINIMAX_VIDEO_TRANSPORTS],
        description: 'How a LOCAL file reaches the service. "inline" (default) sends the bytes as base64 '
          + 'inside the request itself. "upload" reserves a presigned URL, PUTs the file to it, and cites the '
          + 'cdn_url it returns; that path is measured end to end and is needed above the inline size limit, '
          + 'up to ' + Math.round(MAX_UPLOAD_VIDEO_BYTES / (1024 * 1024)) + ' MB. Both forms are read by the '
          + 'server-side model, and on either one the description it returns can disagree with what the clip '
          + 'actually shows: a successful call means the video was fetched and consumed, NOT that the account '
          + 'of it is accurate. A http(s) URL source ignores this argument.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: { type: 'string', required: true },
          mediaType: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          analysis: { type: 'string', required: true },
        },
      },
      render: (_args, value): ContentBlock[] => {
        const output = value as unknown as { source: string; mediaType: string; bytes: number; analysis: string }
        return [{
          type: 'text',
          text: 'Video ' + output.source + ' (' + output.mediaType + ', ' + humanBytes(output.bytes) + '):'
            + String.fromCharCode(10, 10) + output.analysis,
        }]
      },
    },
    timeoutMs: 5 * 60_000,
    isConcurrencySafe: () => true,
    presentCall: args => ({
      card: 'generic',
      kind: 'other',
      title: 'Understand video',
      rawInput: args,
    }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result.isError ? 'Video understanding failed' : 'Video understood',
      content: result.content,
    }),
    async execute(args, exec) {
      const source = args.source.trim()
      if (source === '') {
        throw new HarnessError('video source cannot be empty', 'MINIMAX_VIDEO_SOURCE_EMPTY')
      }
      // Refused before any byte is read or any request is spent.
      assertMinimaxRoute(exec, 'understand ' + JSON.stringify(source))
      const credential = await acquireCredential(options.pool, fetchFn)
      const prompt = typeof args.prompt === 'string' && args.prompt.trim() !== ''
        ? args.prompt.trim()
        : DEFAULT_UNDERSTAND_PROMPT

      const isUrl = /^https?:\/\//i.test(source)
      /**
       * The media entry the service is sent, and WHY it is this one.
       *
       * The live probe (docs/minimax-video-generation-probe.md §3.2) put the
       * same clip through the endpoint three ways and only one was read:
       *
       * | key sent        | HTTP | results[0].success |
       * | --------------- | ---- | ------------------ |
       * | `file_url`      | 200  | false (not a field) |
       * | `url` (signed) | 200  | false (unreadable)   |
       * | `data` (base64) | 200  | **true**             |
       *
       * So a LOCAL file defaults to `data`: the bytes go in the request body,
       * encoded base64, and no upload step exists between the caller and the
       * answer. `file` (an absolute path) is a legal key per the service's own
       * error message, but the service read that path on ITS machine, so it
       * cannot see a file that only exists here - it is not offered.
       */
      let media: Record<string, unknown>
      let mediaType: string
      let bytes: number
      if (isUrl) {
        // A URL is passed through under `url`, but ONLY a MiniMax CDN address.
        //
        // MEASURED, and this is what closed the earlier open question: three
        // public URLs were tried and two of them were confirmed fetchable from
        // this machine (HTTP 206, `video/mp4`, an `ftypmp42` head), and the
        // service refused every one of them with the same sentence -
        // `video_info.url could not be used as a media source`
        // (docs/minimax-video-free-checks.md section 5). The ONE shape that has
        // ever answered `success: true` through this key is the `cdn_url` this
        // route's own upload returns, on `cdn.hailuoai.com`
        // (docs/minimax-video-upload-probe.md section 4).
        //
        // We cannot know MiniMax's allowlist, but we do know the positive case,
        // so a third-party address is refused HERE instead of spending a request
        // to learn what was already measured. The check is on the host, not on
        // the path or the query, so it costs nothing when the upload path cites
        // its own cdn_url - that host is exactly the one exempted.
        const parsed = new URL(source)
        assertMinimaxCdnUrl(parsed)
        await assertPublicUrl(parsed, 'the video URL')
        media = { url: parsed.toString(), prompt }
        mediaType = mediaTypeForExtension(parsed.pathname) ?? 'video/mp4'
        bytes = 0
      } else {
        const transport: MinimaxVideoTransport = args.transport === 'upload' ? 'upload' : 'inline'
        // One cap per transport, and it belongs to that transport's own reason
        // for having one: inline is bounded by the 4/3 base64 growth against
        // the request-body ceiling, upload by the fact that the whole file is
        // held in memory here. Both are checked after the stat and before the
        // read, inside readLocalVideo.
        const limit = transport === 'inline' ? inlineVideoByteBudget() : MAX_UPLOAD_VIDEO_BYTES
        const local = await readLocalVideo(source, limit, transport)
        mediaType = local.mediaType
        bytes = local.data.byteLength
        if (transport === 'upload') {
          const cdnUrl = await uploadLocalVideo(credential, {
            data: local.data,
            name: local.name,
            mediaType: local.mediaType,
            fetchFn,
            sleepFn,
            backoffMs,
            ...(exec.signal === undefined ? {} : { signal: exec.signal }),
          })
          media = { url: cdnUrl, prompt }
        } else {
          media = { data: Buffer.from(local.data).toString('base64'), prompt }
        }
      }

      const response = await callWithRetry({
        region: credential.region,
        accessToken: credential.accessToken,
        tool: MATRIX_TOOL_VIDEOS_UNDERSTAND,
        // The envelope the service itself spelled out when sent `{}`:
        // `{"video_info": [{"file": "..."} | {"url": "..."} | {"data": "..."}]}`
        // with `prompt` beside the media key. `mime_type` is NOT sent: the
        // probe's successful call carried only `data` and `prompt`.
        body: { video_info: [media] },
        fetchFn,
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
      }, sleepFn, backoffMs)

      const result = understandResultOf(response.body)
      // THE BYTE RECEIPT, checked before the answer is trusted at all.
      //
      // On the inline path `source` echoes `inline:<N>B` and that N is a
      // faithful count of what the service received (a 1 048 576-byte request
      // came back as `inline:1048576B` - docs/minimax-video-free-checks.md
      // section 4.3). So when the count disagrees with what this route sent, the
      // clip did not arrive whole, and a `success: true` beside it describes
      // truncated bytes. That is a failure, reported with both numbers.
      //
      // A source that is NOT `inline:<N>B` - the upload path's cdn_url, or no
      // source at all - carries no count, so the cross-check is SKIPPED rather
      // than failed. Failing it would break the one path that is measured to
      // work.
      const receivedBytes = result === undefined ? undefined : inlineSourceBytes(result.source)
      if (result !== undefined && result.success !== false && receivedBytes !== undefined && receivedBytes !== bytes) {
        throw new HarnessError(
          PROVIDER_NAME + ' received ' + receivedBytes + ' byte(s) of the video but this route sent ' + bytes
          + ' byte(s) (' + JSON.stringify(source) + '). The service reports what it kept in results[0].source '
          + '("' + result.source + '"), so the clip did not arrive whole and any description beside it would '
          + 'describe the truncated bytes, not the file. Nothing was retried.',
          'MINIMAX_VIDEO_BYTES_MISMATCH',
        )
      }
      // FAILURE IS `results[0].success`, and nothing else. An entry that says
      // false read nothing, whatever its description holds, so the service's
      // own sentence travels into the error instead of being rendered as an
      // analysis.
      if (result !== undefined && result.success === false) {
        // Both fields travel into the message: the probe's failing calls put
        // their reason in `error` and left `description` empty, but a body
        // that fills `description` with the complaint instead must not be
        // reported as "no reason given".
        const reason = [result.description, result.error].filter(part => part !== '').join(' ')
        throw new HarnessError(
          PROVIDER_NAME + ' could not read the video ' + JSON.stringify(source) + ' via '
          + MATRIX_TOOL_VIDEOS_UNDERSTAND + ': ' + (reason === '' ? 'no reason given' : reason),
          'MINIMAX_VIDEO_UNDERSTAND_FAILED',
        )
      }
      // THE MODEL SAYING IT SAW NOTHING IS A FAILURE, whatever `success` says.
      //
      // MEASURED, and the worst of the three failure shapes because it LOOKS like
      // an answer: for synthetic bytes the service both invented a description
      // ("a man fleeing through a narrow alley") and, in the same run, answered
      // "您似乎没有上传或附上任何视频" - "it looks like you did not upload or attach
      // any video" (docs/minimax-video-free-checks.md section 4.4). Handing that
      // sentence back as the analysis tells the user the model looked at their
      // file and saw no video, which is a refusal dressed as a result.
      //
      // Both fields are searched because the service has put its complaint in
      // either one, and the answer comes back in the language of the prompt, so
      // both languages are matched.
      const seenText = [result?.description ?? '', result?.error ?? ''].filter(part => part !== '').join(' ')
      if (declaresNoVideoViewed(seenText)) {
        throw new HarnessError(
          PROVIDER_NAME + ' did not see a video in ' + JSON.stringify(source) + '. The service said so itself, in '
          + 'the description it returned: ' + JSON.stringify(seenText.slice(0, 500)) + '. This is reported as a '
          + 'failure rather than as an answer because it is the model stating that no video reached it - upstream '
          + 'returns exactly this sentence when the bytes it was handed could not be read as a video. Check that '
          + 'the file plays, or convert it to mp4/webm/avi/mpeg and retry.',
          'MINIMAX_VIDEO_NOT_DECODED',
        )
      }
      const analysis = result?.description ?? ''
      if (analysis === '') {
        throw new HarnessError(
          PROVIDER_NAME + ' answered ' + MATRIX_TOOL_VIDEOS_UNDERSTAND + ' without a description. Keys present: ['
          + Object.keys(response.body).join(', ') + '].',
          'MINIMAX_VIDEO_EMPTY_ANALYSIS',
        )
      }
      return { source, mediaType, bytes, analysis }
    },
  })
}

/**
 * Build the video-generation tool.
 *
 * @param ctx - host context; the workspace root is resolved through it per call.
 * @param options - credential source, fetch and the injectable clocks.
 * @returns a registry-ready tool definition.
 */

/**
 * The session one tool call belongs to, as far as the execution exposes it.
 *
 * It is part of the submission guard's key: two calls in DIFFERENT sessions are
 * different requests, even with identical arguments, and must both be sent.
 *
 * @param exec - the tool execution.
 * @returns the session id, or undefined when the runtime exposes none.
 */
function submissionSessionId(exec: { readonly agent?: unknown }): string | undefined {
  const agent = exec.agent as {
    id?: unknown
    session?: { id?: unknown }
  } | undefined
  if (agent === undefined) return undefined
  if (typeof agent.id === 'string' && agent.id !== '') return agent.id
  if (typeof agent.session?.id === 'string' && agent.session.id !== '') return agent.session.id
  return undefined
}

/**
 * The turn one tool call belongs to, as far as the execution exposes it.
 *
 * The guard's key is per TURN because a model may legitimately ask for a second
 * generation in a LATER turn of the same session - that is a new intention and
 * must be paid for. The call id stands in when the runtime exposes no turn, which
 * makes the guard slightly weaker (a repeated call in a later turn with the same
 * id would be refused) but never lets a duplicate through.
 *
 * @param exec - the tool execution.
 * @returns the turn identity, or undefined when the runtime exposes none.
 */
function submissionTurnId(exec: { readonly agent?: unknown; readonly rootCallId?: unknown; readonly callId?: unknown }): string | undefined {
  const agent = exec.agent as { turn?: unknown } | undefined
  if (agent !== undefined && typeof agent.turn === 'number') return String(agent.turn)
  if (typeof exec.rootCallId === 'string' && exec.rootCallId !== '') return exec.rootCallId
  if (typeof exec.callId === 'string' && exec.callId !== '') return exec.callId
  return undefined
}

export function createMinimaxGenerateVideoTool(ctx: Context, options: MinimaxVideoToolOptions) {
  const fetchFn = options.fetchFn ?? fetch
  const pollIntervalMs = options.pollIntervalMs ?? VIDEO_POLL_INTERVAL_MS
  const budgetMs = options.generationBudgetMs ?? VIDEO_GENERATION_BUDGET_MS
  const now = options.now ?? ((): number => Date.now())
  const backoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS
  const sleepFn = (ms: number): Promise<void> => sleep(ms)
  return defineTool({
    name: MINIMAX_GENERATE_VIDEO_TOOL_NAME,
    description:
      'Generate a video from a text prompt with MiniMax Code (MiniMax-H3, MiniMax-H3-Max or '
      + 'MiniMax-Hailuo-2.3). The task is submitted, polled until it succeeds, and the finished clip is '
      + "downloaded into this session's workspace so the preview panel can play it. Generation is billed and "
      + 'takes minutes; the call returns once the file exists. A failed submit is NOT re-sent: the attempt is '
      + 'terminal for that request, and generation is billed, so report the error instead of retrying. Only '
      + 'available on the minimax-code provider.'
      // THE LIMITS ARE PER MODEL, because the service said so in its own refusal
      // sentences, and ALL THREE are measured now (docs/minimax-video-model-rules.md
      // section 5): H3 takes 4-15 s and 768P or 2K; H3-Max takes 5-15 s and 480P
      // or 768P; Hailuo takes ONLY 6 or 10 s and 768P or 1080P. A single "4 to 15"
      // here - the earlier wording - was wrong for two of the three models, and
      // the H3-Max resolution row ("by inference") was worse than imprecise: it
      // named 2K, which that model always refuses.
      + ' Supported parameters: prompt, model (MiniMax-H3, MiniMax-H3-Max or MiniMax-Hailuo-2.3), '
      + 'resolution and durationSeconds. durationSeconds must be 4-15 for MiniMax-H3, 5-15 for '
      + 'MiniMax-H3-Max, and exactly 6 or 10 for MiniMax-Hailuo-2.3. resolution must be 768P or 2K for '
      + 'MiniMax-H3, 480P or 768P for MiniMax-H3-Max, and 768P or 1080P for MiniMax-Hailuo-2.3 - each '
      + 'model has its OWN set and the three differ; the spelling is case-sensitive, so "768p" is refused. '
      + 'A generation may also carry INPUT MEDIA, which is what makes it more than a text-to-video call: '
      + 'inputImagePath is the first frame (or the last frame when referenceType says so), '
      + 'lastFrameImagePath adds an ending frame, referenceImagePaths adds up to 9 reference images, '
      + 'referenceVideoPaths up to 3 reference videos and referenceAudioPaths up to 3 reference audio '
      + 'files. Those reference collections exist for MiniMax-H3 only; MiniMax-Hailuo-2.3 takes a first '
      + 'frame but no reference set and no last frame. ratio picks the shape of the clip and is REWRITTEN '
      + 'before it is sent: a frame forces adaptive, reference media default to adaptive, and a text-only '
      + 'generation defaults to 16:9 - so adaptive is not allowed for a text-only generation. '
      + 'aigcWatermark asks for the AIGC watermark (MiniMax-H3). Media paths are local files or URLs on '
      + 'MiniMax own CDN; local files are uploaded before the submit, and a third-party public URL is refused '
      + 'because the service refuses it too. A reference video given as a public URL needs its length in '
      + 'referenceVideoDurationSeconds, in the same order as the videos.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'Text description of the video to generate.',
      },
      model: {
        type: 'string',
        // ALL THREE models the service recognises. MiniMax-H3-Max is not a
        // guess: the service's own duration rule names it (docs/
        // minimax-video-free-checks.md section 2.1).
        enum: [...MINIMAX_VIDEO_MODELS],
        description: 'Video model: MiniMax-H3 (default), MiniMax-H3-Max, or MiniMax-Hailuo-2.3. '
          + 'The model decides which durations and resolutions are legal.',
      },
      resolution: {
        type: 'string',
        // THE UNION, because a schema can advertise only ONE list for a field
        // whose real rule is per model (a per-model enum is not expressible
        // here). It is therefore NOT a legal set: every member of it is illegal
        // for at least one model. The per-model enforcement is
        // assertVideoResolution, and the description states each model's OWN set
        // so the caller is never left to infer the pairs from the union.
        enum: [...MINIMAX_VIDEO_RESOLUTION_UNION],
        description: 'Output resolution. EACH MODEL HAS ITS OWN LEGAL SET, and the three differ: '
          + 'MiniMax-H3: 768P or 2K; MiniMax-H3-Max: 480P or 768P; MiniMax-Hailuo-2.3: 768P or 1080P. '
          + 'This enum is the UNION of those sets, so a spelling listed here can still be refused for '
          + 'the model you picked (2K is MiniMax-H3 only, 480P is MiniMax-H3-Max only, 1080P is '
          + 'MiniMax-Hailuo-2.3 only). Case-sensitive: "768p" is refused. Omit to let the service choose.',
      },
      durationSeconds: {
        type: 'integer',
        // No minimum/maximum here: the tool schema DSL refuses those keys
        // ("parameters.durationSeconds.minimum is not supported by the value
        // schema DSL"), and a single window would be wrong anyway - the limit is
        // per model. Stated in prose and ENFORCED per model in
        // assertVideoDuration before the submit.
        description: 'Clip length in whole seconds: 4-15 for MiniMax-H3, 5-15 for MiniMax-H3-Max, and '
          + 'exactly 6 or 10 for MiniMax-Hailuo-2.3. Must be given when a duration is wanted: 0 is treated '
          + 'as absent by the service. Omit to let the service choose.',
      },
      ratio: {
        type: 'string',
        enum: [...MINIMAX_VIDEO_RATIOS],
        // The seven upstream values, including adaptive. The LINKAGE below decides
        // the value that goes on the wire: a first or last frame forces adaptive,
        // reference media defaults to adaptive, a text-only generation defaults to 16:9.
        description: 'Aspect ratio of the generated clip: 21:9, 16:9, 4:3, 1:1, 3:4, 9:16, or adaptive.'
          + ' The value is REWRITTEN before it is sent: a first or last frame forces adaptive, reference'
          + ' media defaults to adaptive, and a text-only generation defaults to 16:9. adaptive is NOT'
          + ' allowed for a text-only generation.',
      },
      aigcWatermark: {
        type: 'boolean',
        description: 'Ask for the AIGC watermark. MiniMax-H3 only. Leave it out for the default, which is no watermark.',
      },
      inputImagePath: {
        type: 'string',
        description: 'First frame image, or the last frame when referenceType says so. A local file path, or a'
          + ' URL on MiniMax own CDN (cdn.hailuoai.com) - a third-party public URL is refused by the'
          + ' service itself. Local images are uploaded before the submit.',
      },
      lastFrameImagePath: {
        type: 'string',
        description: 'Ending frame image, for the first+last frame mode. MiniMax-H3 only; the service forces'
          + ' the aspect ratio to adaptive when a frame is given.',
      },
      referenceType: {
        type: 'string',
        enum: ['first_frame', 'last_frame', 'subject'],
        description: 'How inputImagePath is read: as the first frame, as the last frame, or as a subject'
          + ' reference. Defaults to first_frame when an image is given.',
      },
      referenceImagePaths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Up to 9 reference images for MiniMax-H3. Local paths are uploaded before the submit.',
      },
      referenceVideoPaths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Up to 3 reference videos for MiniMax-H3 (.mp4 or .mov). A local path has its length read'
          + ' from the file; a public URL needs referenceVideoDurationSeconds, because the service does not'
          + ' download it and cannot know how long it is.',
      },
      referenceVideoDurationSeconds: {
        type: 'array',
        items: { type: 'number' },
        description: 'The length of each reference video in seconds, in the same order as referenceVideoPaths.'
          + ' Needed for a public URL, optional for a local file - a difference of more than one second'
          + ' between your value and the file own length is refused, because a clip sent at the wrong'
          + ' length is not the clip you meant.',
      },
      referenceAudioPaths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Up to 3 reference audio files for MiniMax-H3 (.wav or .mp3). This is guidance for the'
          + ' sound, not a requirement: MiniMax-H3 generates synchronized audio from the prompt on its own.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          videoPath: { type: 'string', required: true },
          mediaType: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          model: { type: 'string', required: true },
          taskId: { type: 'string', required: true },
          durationSeconds: { type: 'number' },
        },
      },
      render: (_args, value): ContentBlock[] => {
        const output = value as unknown as MinimaxVideoPresentationMeta
        return [{
          type: 'text',
          text: 'Generated video written to ' + output.videoPath + ' (' + output.mediaType + ', '
            + humanBytes(output.bytes) + ', ' + output.model + ').',
        }]
      },
      // The ONLY channel the client can read: the harness excludes the value
      // from durable events, so these names are a wire contract with the card.
      //
      // Typed as the JsonValue the projector declares while still being BUILT
      // from MinimaxVideoPresentationMeta, so the field names are checked
      // against the interface the client uses rather than spelled twice.
      presentationMeta: (_args, value): JsonValue => {
        const output = value as unknown as MinimaxVideoPresentationMeta
        const meta: MinimaxVideoPresentationMeta = {
          videoPath: output.videoPath,
          mediaType: output.mediaType,
          bytes: output.bytes,
          model: output.model,
          taskId: output.taskId,
          ...(output.durationSeconds === undefined ? {} : { durationSeconds: output.durationSeconds }),
        }
        return meta as unknown as JsonValue
      },
    },
    // The budget plus the download and the write, with headroom.
    timeoutMs: VIDEO_GENERATION_BUDGET_MS + 120_000,
    isConcurrencySafe: () => true,
    presentCall: args => ({
      card: 'generic',
      kind: 'other',
      title: 'Generate video',
      rawInput: args,
    }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result.isError ? 'Video generation failed' : 'Video generated',
      content: result.content,
    }),
    async execute(args, exec) {
      const prompt = args.prompt.trim()
      if (prompt === '') {
        throw new HarnessError('video prompt cannot be empty', 'MINIMAX_VIDEO_PROMPT_EMPTY')
      }
      assertMinimaxRoute(exec, 'generate a video')
      // Narrowed, not merely defaulted: the duration and resolution checks below
      // are per-model, so an id this build has no rule for cannot be validated -
      // and an unvalidated submit is billed before the service refuses it.
      const model = typeof args.model === 'string' && args.model.trim() !== ''
        ? assertVideoModel(args.model.trim())
        : DEFAULT_MINIMAX_VIDEO_MODEL
      const credential = await acquireCredential(options.pool, fetchFn)

      // Resolved BEFORE the submit: a generation that cannot be stored is a
      // billed generation whose result the user never gets, so a missing
      // workspace is refused while it is still free to refuse.
      let target
      try {
        target = await resolveMediaStoreTarget(
          ctx as unknown as { get(name: string): unknown },
          exec as unknown as MediaStoreExec,
        )
      } catch (error) {
        if (error instanceof MediaStoreError) throw new HarnessError(error.message, error.code)
        throw error
      }

      // Validated BEFORE the submit for one reason: the service refuses a bad
      // resolution or duration AFTER accepting (and billing) the request, and a
      // refusal that costs a generation is worth catching for free here.
      // The media the generation carries, prepared BEFORE the submit.
      //
      // Two things happen here that the plain text-only path never needed: the
      // local files are uploaded to a URL the service can read, and the ratio
      // and resolution that go on the wire are decided by what the media IS.
      const mediaInput: MinimaxGenerationMediaInput = {
        inputImagePath: typeof args.inputImagePath === 'string' ? args.inputImagePath : undefined,
        lastFrameImagePath: typeof args.lastFrameImagePath === 'string' ? args.lastFrameImagePath : undefined,
        referenceImagePaths: Array.isArray(args.referenceImagePaths) ? args.referenceImagePaths : undefined,
        referenceVideoPaths: Array.isArray(args.referenceVideoPaths) ? args.referenceVideoPaths : undefined,
        referenceVideoDurationSeconds: Array.isArray(args.referenceVideoDurationSeconds)
          ? args.referenceVideoDurationSeconds
          : undefined,
        referenceAudioPaths: Array.isArray(args.referenceAudioPaths) ? args.referenceAudioPaths : undefined,
      }
      // The collection limits and the per-model support are checked HERE, before
      // any byte is read and before any request is spent: a submit is billed, and
      // the service answers its refusal AFTER accepting the request.
      assertGenerationMediaLimits(mediaInput, model)
      const media = await prepareGenerationMedia(mediaInput, model, {
        credential,
        fetchFn,
        sleepFn,
        backoffMs,
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        model,
      })

      // The ratio and resolution that go on the wire are DECIDED here, not taken
      // from the caller: a first frame forces adaptive, reference media defaults
      // to adaptive, a text-only generation defaults to 16:9, and the H3 family
      // defaults its resolution to 2K (upstream's own rule, with one deviation
      // this route measured - see resolveVideoSubmissionResolution).
      // The user's duration and resolution are validated HERE, against the model's
      // own rules, and the ORDER is part of the contract: duration before
      // resolution, which is the order the service itself checks them in
      // (model -> duration -> resolution -> prompt -> ratio, measured -
      // docs/minimax-video-model-rules.md section 3.3). A client that checks
      // them out of order reports a rule the service would never have mentioned.
      //
      // `0` is deliberately NOT filtered out: the service treats it as a MISSING
      // duration, and the honest local answer is the same one.
      const submittedDuration = args.durationSeconds === undefined || args.durationSeconds === null
        ? undefined
        : assertVideoDuration(args.durationSeconds, model)
      const submittedResolution = args.resolution === undefined || args.resolution === null
        ? undefined
        : assertVideoResolution(args.resolution, model)

      const requestedRatio = args.ratio === undefined || args.ratio === null
        ? undefined
        : assertVideoRatio(args.ratio)
      const effectiveRatio = resolveVideoSubmissionRatio({
        model,
        ...(requestedRatio === undefined ? {} : { ratio: requestedRatio }),
        hasKeyframes: media.hasKeyframes,
        hasReferences: media.hasReferences,
      })
      const effectiveResolution = resolveVideoSubmissionResolution(model, submittedResolution)

      // The body is assembled LAST, because the guard below keys on the FINAL
      // body - the one that goes on the wire.
      //
      // The media is added under the SERVICE's field names, which are not the
      // argument names: inputImagePath goes on the wire as input_image, and so on
      // (docs/minimax-video-extended-spec.md section 0).
      const submitBody: Record<string, unknown> = { model, prompt }
      if (submittedDuration !== undefined) submitBody.duration = submittedDuration
      if (effectiveResolution !== undefined) submitBody.resolution = effectiveResolution
      if (effectiveRatio !== undefined) submitBody.ratio = effectiveRatio
      if (media.input_image !== undefined) submitBody.input_image = media.input_image
      if (media.last_frame_image !== undefined) submitBody.last_frame_image = media.last_frame_image
      if (media.reference_images !== undefined) submitBody.reference_images = media.reference_images
      if (media.reference_videos !== undefined) submitBody.reference_videos = media.reference_videos
      if (media.reference_audios !== undefined) submitBody.reference_audios = media.reference_audios
      if (args.referenceType !== undefined && args.referenceType !== null) {
        submitBody.reference_type = args.referenceType
      } else if (media.input_image !== undefined) {
        submitBody.reference_type = 'first_frame'
      }
      if (args.aigcWatermark !== undefined && args.aigcWatermark !== null) {
        submitBody.aigc_watermark = args.aigcWatermark
      }

      // ONE SUBMIT PER REQUEST, because a generation is BILLED and a model may
      // call this tool twice in one turn with the same arguments.
      //
      // The key is the FINAL body - the one that goes on the wire - so two calls
      // that differ only in a value the submit rules rewrote (a defaulted ratio,
      // a defaulted resolution) are recognised as the same request, not as two.
      //
      // The attempt is REMEMBERED BEFORE the request goes out, not after it
      // succeeds: the service may have accepted and billed a request whose
      // answer never arrived, and re-sending the same body would be a second
      // charge for one intention.
      const submissionSession = submissionSessionId(exec)
      const submissionTurn = submissionTurnId(exec)
      // The guard only fires when the key identifies one request inside one
      // session turn. Without a session identity it would degrade to the body
      // alone, and two DIFFERENT generations would look like one - so the guard
      // stays off rather than refuse a video the user actually asked for.
      if (isPreciseSubmissionKey(submissionSession, submissionTurn)) {
        const submissionKey = videoSubmissionKey(submissionSession, submissionTurn, submitBody)
        const alreadyAttempted = attemptedVideoSubmissionFor(submissionKey)
        if (alreadyAttempted !== undefined) {
          throw new HarnessError(
            'this generation was already submitted in this turn, and a second attempt would be billed again'
              + (alreadyAttempted === '' ? '.' : ' (task ' + alreadyAttempted + ').'),
            'MINIMAX_VIDEO_ALREADY_SUBMITTED',
          )
        }
        recordVideoSubmissionAttempt(submissionKey)
      }

      // NO RETRY, and that is the fix rather than an omission: a submit attempt
      // NO RETRY, and that is the fix rather than an omission: a submit attempt
      // is terminal for this request and generation is billed, so a second
      // attempt buys a second charge and not a second chance. See
      // {@link submitVideoOnce}. The polls below DO retry — see the loop.
      const submitted = await submitVideoOnce({
        region: credential.region,
        accessToken: credential.accessToken,
        tool: MATRIX_TOOL_SUBMIT_VIDEO,
        body: submitBody,
        fetchFn,
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
      })

      const taskId = firstStringField(submitted.body, ['task_id', 'taskId'])
      if (taskId === undefined) {
        throw new HarnessError(
          PROVIDER_NAME + ' accepted ' + MATRIX_TOOL_SUBMIT_VIDEO + ' but the answer carried no task id, so the '
          + 'generation cannot be polled. Keys present: [' + Object.keys(submitted.body).join(', ') + '].',
          'MINIMAX_VIDEO_NO_TASK_ID',
        )
      }

      const deadline = now() + budgetMs
      let settled: { status: string; videoUrl?: string; duration?: number } | undefined
      for (;;) {
        // Query KEEPS the retry policy, and upstream is explicit about why the
        // asymmetry is deliberate: "This read-only call does not create another
        // charge." A dropped poll costs nothing to repeat, while a dropped
        // submit costs a generation. This body is also exactly what upstream
        // sends (tools/query-video-generation.ts: `{ task_id, model }`) — the
        // schema's required `output_file_path` is a CLIENT-side argument that
        // decides where to save the download and is deliberately NOT a field of
        // the request, so its absence here is correct rather than a missing key.
        const queried = await callWithRetry({
          region: credential.region,
          accessToken: credential.accessToken,
          tool: MATRIX_TOOL_QUERY_VIDEO,
          body: { task_id: taskId, model },
          fetchFn,
          ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        }, sleepFn, backoffMs)
        const state = taskStatusOf(queried.body)
        // MEASURED: the terminal spelling is `succeeded`. The probe watched a
        // real generation go `running` → `succeeded` and never saw `success`,
        // so the `success` branch this used to accept was a guess and is gone:
        // an unrecognised spelling now runs into the budget timeout below,
        // which names the status it kept seeing instead of silently treating a
        // half-known word as a finished task.
        if (state.status === 'succeeded') {
          settled = state
          break
        }
        if (state.status === 'failed' || state.status === 'cancelled' || state.status === 'canceled') {
          const reason = firstStringField(queried.body, ['message', 'status_msg', 'error']) ?? 'no reason given'
          throw new HarnessError(
            PROVIDER_NAME + ' reported the video task ' + taskId + ' as ' + state.status + ': ' + reason,
            'MINIMAX_VIDEO_TASK_FAILED',
          )
        }
        if (now() >= deadline) {
          throw new HarnessError(
            'video task ' + taskId + ' did not finish within ' + Math.round(budgetMs / 1000) + 's (last status "'
            + (state.status === '' ? 'unknown' : state.status) + '"). The task may still complete upstream; '
            + 'its id is ' + taskId + ' if you want to look it up.',
            'MINIMAX_VIDEO_TIMEOUT',
          )
        }
        await sleepFn(pollIntervalMs)
        exec.signal?.throwIfAborted()
      }

      if (settled.videoUrl === undefined) {
        throw new HarnessError(
          'video task ' + taskId + ' succeeded but the answer carried no video_url, so there is nothing to '
          + 'download.',
          'MINIMAX_VIDEO_NO_URL',
        )
      }

      // Downloaded IMMEDIATELY: the video_url is a signed OSS URL, and its
      // lifetime is MEASURED at about 24 hours (probe §2: `Expires` minus
      // `updated_at` = 86 460 s), not the 9 hours upstream's documentation
      // states. Even at the measured figure, a clip downloaded now is worth
      // more than a URL that has to be re-signed later.
      const downloaded = await downloadVideo(settled.videoUrl, fetchFn, exec.signal, 'the generated video')

      let stored
      try {
        stored = await writeGeneratedVideo(target, downloaded.data, {
          taskId,
          mediaType: downloaded.mediaType,
          now: now(),
        })
      } catch (error) {
        if (error instanceof MediaStoreError) throw new HarnessError(error.message, error.code)
        throw error
      }

      // THE HISTORY LEDGER, written HERE and not in the client.
      //
      // The clip is on disk at this point, so the row describes a file that really
      // exists. It is written after the write rather than before it for exactly
      // that reason: a row for a clip that failed to materialize would point the
      // user at nothing.
      //
      // A FAILURE TO RECORD IS NOT A FAILURE TO GENERATE. `recordMinimaxVideoGeneration`
      // never throws: the generation succeeded, the quota is spent and the file is
      // written, so turning a disk-full history file into an error here would tell
      // the user their video failed when it did not. The reason is kept on the
      // store module instead and surfaced by the settings card's history section;
      // the successful result below is returned unchanged either way.
      await recordMinimaxVideoGeneration({
        model,
        videoPath: stored.relativePath,
        bytes: stored.bytes,
        taskId,
        // The ratio the LINKAGE decided, not the one the caller asked for: this row
        // is a description of the clip that exists, and for a keyframe submit the
        // effective ratio is `adaptive` whatever was requested.
        ...(effectiveRatio === undefined ? {} : { ratio: effectiveRatio }),
        ...(settled.duration === undefined ? {} : { durationSeconds: settled.duration }),
      })

      const value: MinimaxVideoPresentationMeta = {
        videoPath: stored.relativePath,
        mediaType: downloaded.mediaType,
        bytes: stored.bytes,
        model,
        taskId,
        ...(settled.duration === undefined ? {} : { durationSeconds: settled.duration }),
      }
      return value
    },
  })
}
