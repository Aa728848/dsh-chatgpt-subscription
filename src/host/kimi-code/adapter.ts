import { fetchWithContextBudgetRecovery } from '../common/context-budget-fetch.ts'
import { CONTEXT_OVERFLOW_CODE, isHttpContextOverflow } from '../common/context-overflow.ts'
import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  errorChain,
  resolveRetryPolicy,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type PreparedAdapterCall,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  DEFAULT_CONTEXT_WINDOW,
  FALLBACK_MODELS,
  PROVIDER_ID,
  PROVIDER_NAME,
  STREAM_IDLE_TIMEOUT_CODE,
  STREAM_IDLE_TIMEOUT_MS,
  clampOutputToContext,
  codingBaseUrl,
  coerceThinkingEffort,
  effectiveContextWindow,
  maxOutputTokensFor,
  maxRequestBodyBytesFor,
  maxRequestImageBytes,
  reasoningEffortsFor,
} from './types.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  resolveRegion,
  type KimiCodeCatalogModel,
  type KimiCodeCredentials,
  type KimiCodePreferenceStore,
} from './token-store.ts'
import { kimiCodeModelDef } from './model-catalog.ts'
import { markSessionActive } from './cache-hint.ts'
import {
  buildModelOptions,
  clearCachedCatalog,
  dynamicToolsForEntry,
  inputModalitiesForEntry,
  maxInputTokensForEntry,
  loadProviderModels,
  parseTimestamp,
  modelRequestHeaders,
  defaultReasoningEffortForEntry,
  reasoningEffortsForEntry,
  wireForCatalogEntry,
} from './client.ts'
import {
  applyCacheWriteTiers,
  assertRequestBodyFits,
  assertStreamComplete,
  buildRequest,
  closeStream,
  createStreamState,
  estimatedInputTokens,
  mapReasoningEffort,
  MAX_REQUEST_VIDEO_BYTES,
  offloadOldestRequestVideos,
  processAnthropicStreamLine,
  processOpenAIStreamLine,
  recordThinkingCoercion,
  requestHasVideo,
  resolveRequestImages,
  resolveRequestVideos,
  type AttachmentImageReader,
  type AttachmentVideoReader,
  type BodyFitContext,
  type KimiCodeInBandStreamError,
  type KimiCodeStreamState,
  type RequestMediaOptions,
} from './mapper.ts'
import {
  createMediaFilesUploader,
  type KimiMediaFilesUploader,
} from './media-files.ts'
import {
  imagesToOffloadCount,
  offloadOldestRequestImages,
  replaceOldestRequestImages,
  requestHasSendableImage,
  requestImagePayloadLengths,
  requestImageTarget,
  MAX_MESSAGE_BODY_BYTES,
  MAX_REQUEST_IMAGE_BYTES,
  MAX_VIDEO_MESSAGE_BODY_BYTES,
  type ResolvedRequestImages,
} from '../common/request-images.ts';
// The declaring module, the same way {@link ResolvedRequestImages} comes from its
// own: mapper.ts re-exports both, but importing a type from where it is declared
// keeps the two media kinds symmetric and the dependency one hop shorter.
import type { ResolvedRequestVideos } from '../common/video-request.ts'
import { orderReasoningEfforts } from '../common/reasoning-efforts.ts'

/**
 * Rebuild attempts allowed while shrinking a request into its body ceiling.
 *
 * Each attempt drops at least one image, so the loop is bounded by the number of
 * images the request carries; this cap only exists so a future change that fails
 * to make progress fails fast instead of spinning.
 */
const MAX_BODY_FIT_ATTEMPTS = 64

/**
 * Drop the fewest oldest images that free at least `excessBytes`.
 *
 * `current` is the options the over-large body was built from, and `resolved`
 * supplies the post-scaling payload length of each occurrence, so the arithmetic
 * is made of the bytes the wire actually carries rather than of stored sizes.
 *
 * REPORTS PROGRESS through the returned count, because zero is a real outcome
 * rather than the absence of one: when the images still attached weigh less than
 * the overflow, every one of them together cannot close the gap. That case used to
 * return `current` unchanged, which the caller could not distinguish from
 * having dropped everything droppable, so it rebuilt the identical multi-megabyte
 * body until the attempt cap fired.
 */
function dropOldestImagesUntilFits(
  current: NormalizedGenerateOptions,
  resolved: ResolvedRequestImages,
  excessBytes: number,
  baseline: NormalizedGenerateOptions,
): { options: NormalizedGenerateOptions; dropped: number } {
  const lengths = requestImagePayloadLengths(baseline, resolved)
  const alreadyDropped = countOmitted(current, baseline, resolved)
  const remaining = lengths.slice(alreadyDropped)
  // How many more oldest occurrences free the excess, counting only what the
  // current request still carries.
  const additional = imagesToOffloadCount(remaining, excessBytes)
  if (additional === 0) return { options: current, dropped: 0 }
  // The same resolution as `lengths`: index N names the Nth occurrence that
  // actually carries bytes, which is the only reading that keeps the count and
  // the replacement addressing the same images.
  return { options: replaceOldestRequestImages(current, additional, resolved), dropped: additional }
}

/**
 * How many image occurrences `current` has already had replaced, versus `baseline`.
 *
 * Measured with the same resolution the drop loop measures with. Without it an
 * image that resolved to `unavailable` counts as payload-bearing here but not in
 * `lengths`, so `alreadyDropped` overshoots and `slice` quietly discards images
 * the request still has to give back.
 */
function countOmitted(
  current: NormalizedGenerateOptions,
  baseline: NormalizedGenerateOptions,
  resolved: ResolvedRequestImages,
): number {
  const before = requestImagePayloadLengths(baseline, resolved).length
  const after = requestImagePayloadLengths(current, resolved).length
  return Math.max(0, before - after)
}
import { normalizeGenerateOptions, type GenerateOptions as NormalizedGenerateOptions } from '../common/llm-compat.ts'
import { wrapStreamWithWatchdog, type StreamActivity } from '../common/idle-watchdog.ts'
import {
  inBandAnthropicStatus,
  reclassifyInBandError,
  reclassifyInBandResponsesError,
} from '../common/stream-error.ts'
import { KimiCodeAccountPool } from './account-pool.ts'
import { ensureAccessToken, KimiCodeUnauthorizedError } from './oauth.ts'
import { retryAfterMs } from '../wire-auth.ts'
import type { KimiCodeRegion, KimiCodeWire } from '../../shared/kimi-code-contracts.ts'

/**
 * Transient-failure retry policy for the `kimi-code` route.
 *
 * Kimi Code fronts the model providers, so a call can fail with a 502/503/504
 * while the subscription and the credential stay perfectly usable. The service
 * publishes exactly this case, and the body is usually
 * `{"error":{"message":"Upstream model provider is temporarily unavailable.
 * Please try again in a moment.","type":"server_error"}}` — which is precisely a
 * message telling the client to try again.
 *
 * The retryable set is therefore:
 *
 * - `SERVER` — any 5xx, including that upstream-unavailable 502, and the
 *   overloaded 429 (`UPSTREAM_OVERLOAD_PATTERNS`). Overload shares the 429
 *   status with real back-pressure but not its meaning: it describes the state
 *   of the upstream engine, which every account behind this endpoint shares, so
 *   it is filed as the server condition it is and the pool is left alone;
 * - `RATE_LIMIT` — a 429 that is genuine back-pressure ("too many requests"),
 *   which the documentation describes as transient and which does belong to the
 *   account that hit it, so rotation on it still earns its keep;
 * - `TRANSPORT` — a connection that failed to carry the response: none at all,
 *   a body severed mid-stream (`streamFailure`), or a stream that ended without
 *   its terminal event (`assertStreamComplete`);
 * - `TIMEOUT` — a stalled stream, handled by the idle watchdog.
 *
 * Deliberately outside the set:
 *
 * - `INVALID_CREDENTIAL` — a rejected access token fails identically on every
 *   attempt;
 * - `PROVIDER_ERROR` — a 400, a 401 that is really a plan-entitlement refusal,
 *   or a 403 quota limit. Retrying a quota that resets in hours against the
 *   SAME account only burns requests and delays the message the user needs to
 *   see, so none of it is retried; a 403 limit still rotates to another account
 *   when the pool holds one, which is a routing decision rather than a retry;
 * - `ABORTED` — the caller already cancelled.
 *
 * The DSH normal defaults would apply anyway; stating the values here pins them
 * so this route never retries less than the rest of the plugin.
 */
export const KIMI_CODE_RETRY_POLICY_CONFIG: {
  mode: 'normal'
  maxRetries: number
  retryableCodes: string[]
  backoff: { initialDelayMs: number; maxDelayMs: number; jitterRatio: number }
} = {
  mode: 'normal',
  maxRetries: 3,
  retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
  backoff: { initialDelayMs: 1_500, maxDelayMs: 15_000, jitterRatio: 0.2 },
}

const RETRY_POLICY = resolveRetryPolicy(KIMI_CODE_RETRY_POLICY_CONFIG, 'dsh-chatgpt-subscription.kimi-code.retry')

/** Configured effort when the model supports it, else the adapter's preference order. */
export function resolveDefaultReasoningEffort(
  efforts: readonly string[],
  configuredEffort?: string | null,
): ReasoningEffortId | undefined {
  if (configuredEffort && efforts.includes(configuredEffort)) {
    return ReasoningEffortId(configuredEffort)
  }
  return undefined
}

/**
 * What one failed response means for the retry policy.
 *
 * The service overloads a single status for unrelated problems — a 401 covers
 * both "your token is bad" and "your plan does not include k3", and a 429
 * covers both ordinary back-pressure and a spent quota that must not be
 * retried. The body text is what separates them, so the classification reads
 * it rather than trusting the status alone.
 */
export interface KimiFailureClassification {
  /** DSH error code; decides whether the route retries. */
  code: string
  /** Message shown to the user, with the provider's own text appended. */
  message: string
  /** True only when the failure is worth retrying. */
  retryable: boolean
  /**
   * 本次失败是不是上游引擎过载（正文命中 `UPSTREAM_OVERLOAD_PATTERNS`）。
   *
   * 单列成一个字段，是因为「过载」这条信息号池需要、而 code 本身已经不够用了：
   * 过载要可重试（harness 的退避重试正是为它准备的），所以它必须留在
   * retryable 集合里；但过载不是任何账号的错，所以它绝不能被当成账号级限流
   * 写进冷却。code 只有一个，说不了这两件事；`accountScoped` 也只回答「能不能
   * 换号」，不回答「要不要冷却」——真正限流时答案是「能换号、也要冷却」，
   * 过载时是「不必换号、更不必冷却」。两条路都可重试却必须分开处理，所以这里
   * 把归属显式带出来，而不是让调用方拿状态码去猜：同一个 429 状态码同时承载
   * 这两种含义，而这正是本缺陷的成因。
   */
  upstreamOverload: boolean
  /**
   * True when the refusal belongs to THIS account alone, so another pooled
   * account may still serve the same request.
   *
   * A spent usage window is the case that matters, and this service reports it
   * as a 403 — neither a bad credential nor retryable back-pressure, so nothing
   * in the code or the message says "rotate". Asking the same account again
   * cannot help; taking it out of rotation until its window resets lets the next
   * account answer, and each account in the pool carries its own quota.
   *
   * False for every verdict that belongs to the request or to the plan: an
   * entitlement refusal, a malformed body, ordinary overload. Rotating on one of
   * those would spend every account in the pool to learn the same answer from
   * each of them.
   */
  accountScoped: boolean
}

/** Body text the service uses for a plan entitlement refusal (status 401). */
const ENTITLEMENT_PATTERNS = [
  /does not have access to/i,
  /supports only .* up to .* context/i,
  /model id does not exist/i,
  /recognized as other/i,
  /currently plan supports only/i,
]

/**
 * 正文里说明「上游引擎过载」的措辞，与上面两组按**归属**分界，而不是按严重程度。
 *
 * - `ENTITLEMENT_PATTERNS` 说的是套餐：换号、换时间都不会变，是请求/套餐的属性；
 * - `QUOTA_EXHAUSTED_PATTERNS` 说的是这个账号自己的余额/额度：别人可能还好，
 *   但这个账号在窗口重置前一定起不来；
 * - 本组说的是**上游引擎的繁忙**：这是所有账号共用的同一台引擎，谁来问都是这句
 *   话，本地没有任何动作能改变它。
 *
 * 第三组必须单独识别，因为它和真正的限流共用同一个 429 状态码，却不共享结论。
 * 服务端用 429 表达「引擎过载」时，本线路此前把它归进 RATE_LIMIT，号池随即按
 * 限流语义给**唯一那个账号**写 15 分钟冷却（`POOL_COOLDOWN_MS`），之后同一
 * 会话的每一次重试都被 `isEligible` 直接挡在门外——重试根本没发出网络请求，
 * 3 次退避（3.2s/6.1s，纯本地耗时）打在一个登录正常、额度正常的账号上，最后以
 * 「全部 1 个 Kimi Code 账号均处于配额限制或冷却中 (429)。最短预计在 15 分钟后
 * 解除冷却。」收场。真正被限流的服务端状态不该有账号级的副作用。
 *
 * 这里只按正文判定，绝不按状态码判定：同一个 429 既可能是过载也可能是真限流，
 * 唯一能区分的证据就是服务自己写下的那句话。措辞取自本线路文档与实际响应，
 * 刻意保留 "the engine is …" 的限定，避免把任何提到 "overload" 的正文一律
 * 吞掉——将来若出现「本账号请求量过载」这类真限流措辞，它不该落进这一组。
 */
const UPSTREAM_OVERLOAD_PATTERNS = [
  /\bengine is (currently )?overloaded\b/i,
  /\bservers? (?:is|are) (?:currently )?overloaded\b/i,
  /\bservice is (?:currently )?overloaded\b/i,
  /\bupstream model provider is temporarily unavailable\b/i,
  /\bcurrently overloaded\b/i,
]

/** Body text the service uses for a 429 that must NOT be retried. */
const QUOTA_EXHAUSTED_PATTERNS = [
  /exceeded_current_quota_error/i,
  /exceeded your current (token )?quota/i,
  /check your account balance/i,
  /insufficient balance/i,
  /recharge your account/i,
  /please recharge/i,
  /account (is )?in arrears/i,
]

/** Body text the service uses for an account limit (status 403). */
const ACCOUNT_LIMIT_PATTERNS = [
  /reached your .*usage limit/i,
  /reached your concurrent request limit/i,
  /usage limit for this billing cycle/i,
]

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text))
}

/**
 * Cache scope for the single stored credential.
 *
 * The user id the sign-in reported is the only stable identity that file has, and
 * the constant covers a credential stored before any id was recorded — or one
 * whose sign-in never answered with one. It must stay constant for an account:
 * a scope that drifted would re-upload every clip on the next turn, while a scope
 * shared between two accounts would hand one account's file id to another.
 */
const LEGACY_ACCOUNT_SCOPE = 'legacy'

function legacyAccountScope(credentials: KimiCodeCredentials): string {
  const userId = credentials.userId?.trim()
  return userId === undefined || userId === '' ? LEGACY_ACCOUNT_SCOPE : userId
}

/** Whether one rejection is a cancellation rather than a failure to report. */
function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}

/** Short, single-line excerpt of one error body, safe to show a user. */
export function summarizeFailureBody(raw: string): string {
  const text = raw.replace(/[\r\n\t]+/g, ' ').trim()
  if (text === '') return ''
  // The service nests its real message under `error`; unwrap it so the user
  // reads the sentence rather than a JSON envelope.
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>
      const error = record.error
      if (typeof error === 'string') return error.slice(0, 400)
      if (typeof error === 'object' && error !== null) {
        const nested = error as Record<string, unknown>
        const message = nested.message ?? nested.error_description ?? nested.type
        if (typeof message === 'string') return message.slice(0, 400)
      }
      if (typeof record.message === 'string') return record.message.slice(0, 400)
    }
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return text.slice(0, 400)
}

/**
 * Whether one failure detail is the gateway refusing a body for its SIZE.
 *
 * The managed gateway answers an oversized request with
 * `total message size 5943865 exceeds limit 2097152` and no status beyond 400:
 * the figures are bytes, and the wording matches nothing the shared overflow
 * detector looks for. It is recognized HERE rather than in
 * `common/context-overflow.ts` on purpose — that detector is shared by every
 * route in this plugin, so a Kimi-specific sentence added there would
 * reclassify other lines' failures on wording they never send.
 */
export function isKimiBodySizeRefusal(detail: string): boolean {
  return /\btotal message size\b[^;]{0,64}?\bexceed(?:s|ed)?\b[^;]{0,64}?\blimit\b/i.test(detail)
}

/**
 * The sentence the service answers with when a cited hosted file is GONE.
 *
 * Measured on this line: a chat body that cites `ms://<id>` for a file the
 * store no longer holds is refused with HTTP 404 and exactly this text. It is
 * checked as a case-insensitive substring rather than as an exact body so a JSON
 * wrapper (`{"error":{"message":"The requested resource was not found"}}`) and a
 * trailing hash match too.
 *
 * DELIBERATELY NARROW, because 404 also means "no such model" and "no such
 * route" on this endpoint, and neither of those is fixed by resending the same
 * conversation with inline media. Only this sentence, on a request that really
 * cited a reference, opens the one inline retry.
 */
const MISSING_RESOURCE_PATTERN = /\bthe requested resource was not found\b/i

/** Whether one 404 body is the service refusing a cited file rather than the model. */
export function isMissingResourceBody(bodyText: string): boolean {
  return MISSING_RESOURCE_PATTERN.test(bodyText)
}

/** One readable media occurrence this request intends to upload. */
export interface PlannedMediaReference {
  /** Durable attachment id the block cites; the key the mapper looks it up by. */
  readonly attachmentId: string
  /** Which wire field cites it afterwards. */
  readonly kind: 'image' | 'video'
  /** Media type the upload states as its purpose-carrying type. */
  readonly mediaType: string
  /** Decoded bytes, ready to upload. */
  readonly data: Uint8Array
}

/**
 * Body length assumed for one reference while the request is measured.
 *
 * The body is measured BEFORE anything is uploaded, so the real id does not
 * exist yet. 68 characters is longer than an id the uploaded-file route is
 * documented to mint, and it is deliberately on the long side: a measurement
 * that over-estimates sends nothing it cannot fit, while one that
 * under-estimates would discover the overflow only after the upload was already
 * paid for.
 */
const PLANNED_MEDIA_REFERENCE = 'ms://' + '0'.repeat(64)

/**
 * Which occurrences of one request would be uploaded, if any.
 *
 * Nothing is uploaded here and no network is touched: this only decides WHICH
 * readable occurrences the reference path would cover, so the body-fit guard can
 * measure the body that will actually be sent instead of measuring an inline
 * body the reference path would never produce.
 *
 * An occurrence is eligible when all four hold, and each exclusion is load
 * bearing:
 *
 * - the wire is OpenAI-compatible — the Anthropic surface documents no hosted
 *   media and must upload nothing at all;
 * - the selected model declares the matching modality — sending a purpose the
 *   model cannot read uploads bytes nobody will look at;
 * - the occurrence resolved to `inline`, i.e. its bytes were actually read —
 *   an unreadable media has nothing to upload and keeps its placeholder;
 * - the occurrence cites a durable attachment, because only that is what a
 *   reference can be keyed by.
 */
export function planMediaReferences(input: {
  wire: KimiCodeWire
  imageAccepted: boolean
  videoAccepted: boolean
  images: ResolvedRequestImages
  videos: ResolvedRequestVideos
}): PlannedMediaReference[] {
  if (input.wire !== 'openai') return []
  const planned: PlannedMediaReference[] = []
  const collect = (
    resolved: ResolvedRequestImages | ResolvedRequestVideos,
    kind: 'image' | 'video',
  ): void => {
    for (const [attachmentId, occurrence] of resolved) {
      if (occurrence.kind !== 'inline') continue
      const data = Buffer.from(occurrence.data, 'base64')
      if (data.byteLength === 0) continue
      planned.push({ attachmentId, kind, mediaType: occurrence.mediaType, data })
    }
  }
  if (input.imageAccepted) collect(input.images, 'image')
  if (input.videoAccepted) collect(input.videos, 'video')
  return planned
}

/**
 * Attachment ids one built request STILL sends as media occurrences.
 *
 * Two stages can take an occurrence away, and both run before a reference could
 * be cited:
 *
 * - the image/video budget pass replaces the oldest occurrences with a text
 *   placeholder, and
 * - the body-fit loop replaces more of them when the real serialized body is over
 *   the ceiling.
 *
 * An occurrence either stage removed is no longer part of the request, so
 * uploading it would pay for bytes nobody reads and mint a reference nothing
 * cites. The upload set is therefore read off the FINAL build rather than off
 * what was merely readable when the request was planned.
 *
 * Tool results nest their own content, and a `read_image` result carries its
 * pixels there, so the traversal recurses exactly the way the budget does.
 */
export function mediaAttachmentIdsIn(options: NormalizedGenerateOptions): Set<string> {
  const ids = new Set<string>()
  const visit = (content: unknown): void => {
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      const record = block as Record<string, unknown>
      if (record.type === 'tool-result') {
        visit(record.content)
        continue
      }
      if (record.type !== 'image' && record.type !== 'video') continue
      const attachment = typeof record.attachment === 'object' && record.attachment !== null
        ? record.attachment as Record<string, unknown>
        : undefined
      const id = attachment?.attachmentId
      if (typeof id === 'string' && id !== '') ids.add(id)
    }
  }
  for (const message of options.messages) visit(message.content)
  return ids
}

/**
 * The placeholder reference maps one planned set measures the body with.
 *
 * Returned separately for images and videos because the mapper keys them by
 * field, not by kind.
 */
export function plannedReferenceMaps(planned: readonly PlannedMediaReference[]): {
  imageReferences: Map<string, string>
  videoReferences: Map<string, string>
} {
  const imageReferences = new Map<string, string>()
  const videoReferences = new Map<string, string>()
  for (const item of planned) {
    const target = item.kind === 'image' ? imageReferences : videoReferences
    target.set(item.attachmentId, PLANNED_MEDIA_REFERENCE)
  }
  return { imageReferences, videoReferences }
}

/**
 * Classify one non-2xx response for the retry policy.
 *
 * @param status - HTTP status the service answered with.
 * @param bodyText - raw response body, used to separate overloaded statuses.
 */
export function classifyKimiFailure(status: number, bodyText: string): KimiFailureClassification {
  const detail = summarizeFailureBody(bodyText)
  if (isHttpContextOverflow(status, bodyText)) {
    return { code: CONTEXT_OVERFLOW_CODE, retryable: false, accountScoped: false, upstreamOverload: false, message: `${PROVIDER_NAME} context window exceeded: ${detail}` }
  }

  if (status === 400 && isKimiBodySizeRefusal(detail)) {
    // The byte ceiling and the token window need the same recovery even though
    // they quote different numbers: DSH's answer to CONTEXT_WINDOW_EXCEEDED is to
    // compact the conversation, which is exactly what shrinks a body. Filed as
    // PROVIDER_ERROR this read as a dead end, so a session that merely grew too
    // large ended its turn instead of compacting and retrying. The message says
    // bytes, because a byte refusal is what happened.
    return {
      code: CONTEXT_OVERFLOW_CODE,
      retryable: false,
      accountScoped: false,
      upstreamOverload: false,
      message: `${PROVIDER_NAME} rejected the request body (400): it is larger than the number of bytes this endpoint accepts, which is a byte ceiling rather than the model's token window.${detail === '' ? '' : ` ${detail}.`} Compact the conversation or start a new session.`,
    }
  }

  if (status === 402) {
    // "We're unable to verify your membership benefits at this time." The docs
    // describe it as usually temporary and recommend waiting and retrying.
    return {
      code: 'SERVER',
      retryable: true,
      accountScoped: false,
      upstreamOverload: false,
      message: `${PROVIDER_NAME} could not verify the subscription tier (402). Retrying; if it persists, confirm the membership is active.${detail ? ` ${detail}` : ''}`,
    }
  }

  if (status === 401 || status === 403) {
    if (matchesAny(detail, ENTITLEMENT_PATTERNS)) {
      // The credential is fine; the plan is the problem. Re-authenticating
      // cannot help, and retrying cannot either.
      return {
        code: 'PROVIDER_ERROR',
        retryable: false,
        // A plan refusal is the same plan on every account of the pool, and it
        // is fixed by an upgrade rather than by a different account.
        accountScoped: false,
        upstreamOverload: false,
        message: `${PROVIDER_NAME} refused this request for the current plan: ${detail || 'the requested model or context is not included'}. Switch to a model the plan includes, lower the context-window override, or upgrade the subscription.`,
      }
    }
    if (status === 403) {
      // Every 403 on this route is an account-level refusal, so the code is the
      // same either way; the matched-limit test only selects which sentence the
      // user reads. The previous form branched to one value and read as though
      // the two cases were meant to differ.
      // Every 403 here is an account-level refusal, so the sentence shown is the
      // only thing that varies; the code is the same either way.
      const limitReached = matchesAny(detail, ACCOUNT_LIMIT_PATTERNS)
      return {
        code: 'PROVIDER_ERROR',
        retryable: false,
        // A spent window is this account's own quota. The 403 carries neither a
        // dead credential nor a signal worth retrying against the same account,
        // which is exactly why rotation has to be told about it separately: the
        // pool's remaining accounts each carry a window of their own.
        accountScoped: true,
        upstreamOverload: false,
        message: `${PROVIDER_NAME} blocked the request on an account limit (403): ${detail || (limitReached ? 'the account limit was reached' : 'the account refused the request')}. The quota refreshes on its own schedule — check the Kimi Code card in Settings for the reset time.`,
      }
    }
    return {
      code: 'INVALID_CREDENTIAL',
      retryable: false,
      accountScoped: false,
      upstreamOverload: false,
      message: `${PROVIDER_NAME} rejected the stored credential (401). Sign in again from Settings > Kimi Code.${detail ? ` ${detail}` : ''}`,
    }
  }

  if (status === 429) {
    if (matchesAny(detail, QUOTA_EXHAUSTED_PATTERNS)) {
      // A spent quota is not back-pressure: the same request cannot succeed
      // until the account is topped up, so it must not be retried.
      return {
        code: 'PROVIDER_ERROR',
        retryable: false,
        // Balance, not back-pressure: this account's own, and it stays spent.
        accountScoped: true,
        upstreamOverload: false,
        message: `${PROVIDER_NAME} reports the account quota is exhausted: ${detail || 'no remaining quota'}. Top up or wait for the window to reset.`,
      }
    }
    // 正文点名上游引擎过载时，状态码仍是 429，但它描述的根本不是本账号：
    // 所有账号共用同一台引擎，本地任何动作都改变不了它。这条必须在上面那条
    // 额度判断之后、回到 RATE_LIMIT 之前，因为「余额见底」比「引擎繁忙」
    // 更具体——两句话同时出现时，账号自己的问题才是更需要被告知的那个。
    if (matchesAny(detail, UPSTREAM_OVERLOAD_PATTERNS)) {
      return {
        // 用 SERVER 而不是 RATE_LIMIT：两码都在 KIMI_CODE_RETRY_POLICY_CONFIG 的
        // retryableCodes 里，退避重试行为完全一致；但 SERVER 在全仓是「服务端故障」
        // 的规范码（5xx 分支、以及 GLM 把 OVERLOADED 映射到的都是它），RATE_LIMIT
        // 在 UI 与号池文案里的含义是「这个账号被限流了」，用过载去借它会让用户在
        // 界面上读到一个关于自己账号的错误结论。
        code: 'SERVER',
        // 过载是典型的瞬时故障，退避后重试正是为它准备的。
        retryable: true,
        // 换号也救不了：下一台引擎一样忙。所以轮转没有任何意义。
        accountScoped: false,
        upstreamOverload: true,
        message: `${PROVIDER_NAME} upstream engine is overloaded (429): ${detail || 'the engine is currently overloaded'}. This is a temporary upstream condition shared by every account, so no account is taken out of rotation; retrying with backoff.`,
      }
    }
    return {
      code: 'RATE_LIMIT',
      retryable: true,
      // Ordinary back-pressure says nothing about this account in particular,
      // and the shared 429 cooldown below already rotates on it.
      accountScoped: false,
      upstreamOverload: false,
      message: `${PROVIDER_NAME} is rate limited (429): ${detail || 'too many requests'}. Retrying with backoff.`,
    }
  }

  if (status >= 500) {
    // The upstream model provider is temporarily unavailable. Neither the
    // request nor the credential is at fault, so it is retried under the
    // bounded policy above instead of failing the turn outright.
    return {
      code: 'SERVER',
      retryable: true,
      accountScoped: false,
      // A 5xx is the same upstream condition this line reports for an overloaded
      // 429, so the flag agrees with the code rather than contradicting it.
      upstreamOverload: matchesAny(detail, UPSTREAM_OVERLOAD_PATTERNS),
      message: `${PROVIDER_NAME} upstream server error (${status}): ${detail || 'the model provider is temporarily unavailable'}. Retrying with backoff.`,
    }
  }

  if (status === 400) {
    return {
      code: 'PROVIDER_ERROR',
      retryable: false,
      accountScoped: false,
      upstreamOverload: false,
      message: `${PROVIDER_NAME} rejected the request (400): ${detail || 'the request was not accepted'}`,
    }
  }

  return {
    code: 'PROVIDER_ERROR',
    retryable: false,
    accountScoped: false,
    upstreamOverload: false,
    message: `${PROVIDER_NAME} API error (${status}): ${detail || 'No response'}`,
  }
}

/** Numeric reset the service may ship as a field rather than in prose. */
const RESET_FIELD_PATTERN = /"?reset[A-Za-z_]*"?\s*[:=]\s*"?(\d{9,16})"?/i

/** ISO instant quoted in prose, trusted only when it names its own zone. */
const RESET_INSTANT_PATTERN = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/

/** The window a billing-cycle refusal names; nothing shorter describes it. */
const BILLING_CYCLE_PATTERN = /usage limit for this billing cycle/i

/**
 * How long one account stays out of rotation after it reports a spent limit.
 *
 * The reset instant is read from the body whenever the service states one — as a
 * numeric field, or as an instant carrying its own zone — and the length of the
 * window the service names is used otherwise. The zone is required for that
 * instant because an unqualified one is ambiguous, and a cooldown computed from
 * the wrong zone is either hours too long or already over; where the body is
 * ambiguous the window length is the honest answer.
 *
 * Both ends of the range are load-bearing. A reset instant barely in the future
 * would otherwise read as no cooldown at all and put the account straight back
 * into rotation to be refused again; and a reset instant already in the past
 * (a stale cache, a clock skew) falls back to the window length above rather
 * than to no cooldown at all.
 */
export function accountLimitCooldownMs(bodyText: string, now: number = Date.now()): number {
  const field = bodyText.match(RESET_FIELD_PATTERN)
  const instant = bodyText.match(RESET_INSTANT_PATTERN)
  const resetsAt = field !== null
    ? parseTimestamp(Number(field[1]))
    : instant !== null
      ? Date.parse(instant[0].replace(' ', 'T'))
      : null
  if (resetsAt !== null && Number.isFinite(resetsAt) && resetsAt > now) {
    return Math.min(Math.max(resetsAt - now, POOL_COOLDOWN_MS), MAX_ACCOUNT_LIMIT_COOLDOWN_MS)
  }
  return BILLING_CYCLE_PATTERN.test(bodyText)
    ? BILLING_CYCLE_COOLDOWN_MS
    : ACCOUNT_LIMIT_COOLDOWN_MS
}

export interface KimiCodeAdapterOptions {
  fetchFn?: typeof fetch
  attachments?: AttachmentImageReader
  /**
   * Video reader seam.
   *
   * DSH's attachment service stores images only, so a deployment that produces
   * video references injects the reader here. Absent, video occurrences degrade
   * to an explicit text placeholder rather than silently vanishing.
   */
  videos?: AttachmentVideoReader
  /** Live catalog loader seam; defaults to the managed `/models` call. */
  loadCatalog?: () => Promise<KimiCodeCatalogModel[]>
  /**
   * Hosted-file uploader seam.
   *
   * Production builds one through {@link createMediaFilesUploader} with THIS
   * adapter's transport, so an upload and the chat request that cites it travel
   * the same fetchFn — a test or a deployment that swaps the transport must not
   * be bypassed by a module-level singleton holding its own.
   *
   * The cache is the point of the seam being shared across requests: one
   * instance lives for the adapter's lifetime, so the same clip is uploaded once
   * per account rather than once per turn.
   */
  mediaFiles?: KimiMediaFilesUploader
}

/**
 * Cooldown one rate-limited account takes when the provider states no delay.
 *
 * 只在**真正的**限流上使用：上游引擎过载走 SERVER，既不落这条窗口，也不消耗轮转
 * 名额。它是 15 分钟而不是服务自己说的时长，正是因为拿不准——拿不准的那次猜测
 * 落在一个只有单个账号的号池上，代价是整个号池在 15 分钟里彻底不可用。
 */
const POOL_COOLDOWN_MS = 15 * 60_000

/**
 * Fallback cooldown for an account whose usage window is spent.
 *
 * The service states the reset time only sometimes, so the fallback is the
 * window's own length. The 15 minutes a 429 gets would put the account back
 * into rotation four times inside the very window that just refused it.
 */
const ACCOUNT_LIMIT_COOLDOWN_MS = 5 * 60 * 60_000

/**
 * A billing cycle is not a window: a 5-hour cooldown would spend a request every
 * five hours to learn an answer that changes at most once a month.
 */
const BILLING_CYCLE_COOLDOWN_MS = 30 * 24 * 60 * 60_000

/** Ceiling, so a malformed reset time cannot park an account for years. */
const MAX_ACCOUNT_LIMIT_COOLDOWN_MS = BILLING_CYCLE_COOLDOWN_MS

/**
 * Longest edge of the request version this route asks the attachment store for.
 *
 * Kimi's own CLI downscales an oversized image to a 2000 px long edge by default,
 * so a screenshot its client would send at 2000 px must not be handed to this
 * route at the shared 1024 px ceiling: that kept a screenshot the model could
 * read at 2000 px legible-sized only by dropping and re-reading it. The
 * encoded-byte target is deliberately NOT raised with it — 256 KiB per request
 * version still fits four images inside the shared 1.5 MB budget — and an image
 * already inside this edge is still sent as stored, so small images, references
 * without dimensions and the body-fit ceiling all behave exactly as before.
 */
export const KIMI_CODE_REQUEST_IMAGE_MAX_EDGE = 2000

export class KimiCodeAdapter extends LlmAdapter {
  /**
   * Rotation pool, or null for the single stored credential.
   *
   * Only the plugin entry installs one, because it owns the pool's storage; an
   * adapter built without one must keep working off the one credential file and
   * must not create pool state of its own.
   */
  private readonly accountPool: KimiCodeAccountPool | null

  constructor(
    private readonly store = new FileCredentialStore(),
    private readonly modelSettings = new FileModelSettingsStore(),
    private readonly preferences?: KimiCodePreferenceStore,
    private readonly options: KimiCodeAdapterOptions = {},
    accountPool?: KimiCodeAccountPool,
  ) {
    super()
    this.accountPool = accountPool ?? null
  }

  /**
   * The uploader this adapter cites files through, built on first use.
   *
   * Built lazily for two reasons: a turn with no media pays nothing, and a test
   * that stubs the global transport before the first request still reaches the
   * default uploader, because the transport is read at construction rather than
   * at module load.
   *
   * Deliberately NOT {@link kimiMediaFiles}, the module-level singleton: that one
   * captured the global `fetch` when this module was imported, so an adapter
   * given its own transport would upload through a different one than it chats
   * through — the one thing this route must not do, since the reference it gets
   * back is only meaningful to the endpoint the chat request goes to.
   */
  private mediaUploader: KimiMediaFilesUploader | undefined

  /** The shared uploader, created on first use with THIS adapter's transport. */
  private mediaFiles(): KimiMediaFilesUploader {
    if (this.mediaUploader === undefined) {
      this.mediaUploader = this.options.mediaFiles
        ?? createMediaFilesUploader(this.options.fetchFn === undefined ? {} : { fetchFn: this.options.fetchFn })
    }
    return this.mediaUploader
  }

  /**
   * Upload every planned occurrence under ONE account and collect its references.
   *
   * The credential, base URL and scope are the ones the chat request about to be
   * sent will use, which is what makes a reference citable at all: an id minted
   * for another account or another deployment is not assumed to be readable.
   *
   * A failure is contained per occurrence. Uploading is an optimisation — the
   * inline path always works — so a refused, overloaded or unreachable upload
   * endpoint leaves THAT media inline and the turn runs. What is never
   * contained is a cancellation: `signal` aborted, or an AbortError out of the
   * transport, is a turn the caller deliberately stopped, and continuing to send
   * the chat request would answer it anyway.
   *
   * This deliberately touches no account state: a 401/403/404/405/413/5xx or a
   * network failure of the UPLOAD is a fact about the hosted-file endpoint, not
   * a verdict on this account's quota, so it neither cools nor retires the
   * account. The chat request's own classification owns that decision.
   */
  private async uploadPlannedReferences(input: {
    planned: readonly PlannedMediaReference[]
    accessToken: string
    baseUrl: string
    accountScope: string
    signal: AbortSignal
  }): Promise<{
    imageReferences: Map<string, string>
    videoReferences: Map<string, string>
    cited: PlannedMediaReference[]
  }> {
    const uploader = this.mediaFiles()
    const imageReferences = new Map<string, string>()
    const videoReferences = new Map<string, string>()
    const cited: PlannedMediaReference[] = []
    await Promise.all(input.planned.map(async (item) => {
      try {
        const reference = await uploader.upload({
          accessToken: input.accessToken,
          baseUrl: input.baseUrl,
          accountScope: input.accountScope,
          data: item.data,
          mediaType: item.mediaType,
          signal: input.signal,
        })
        const target = item.kind === 'image' ? imageReferences : videoReferences
        target.set(item.attachmentId, reference)
        cited.push(item)
      } catch (error) {
        if (input.signal.aborted || isAbortError(error)) {
          throw new LlmError('Kimi Code media upload aborted', 'ABORTED', { cause: error })
        }
        // Any other failure leaves this media inline; the mapper sends it the
        // way it always did and the turn proceeds.
      }
    }))
    return { imageReferences, videoReferences, cited }
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: PROVIDER_NAME }
  }

  providerRetryPolicy(): ResolvedRetryPolicy {
    return RETRY_POLICY
  }

  imageRequestPricing(): undefined {
    return undefined
  }

  imageRequestTarget(_provider: string, _model: string, image: ImageAttachmentRef) {
    // `edge` is the reuse seam: the shared helper already takes the ceiling, so
    // this route passes its own instead of moving the shared constant every
    // other provider is calibrated against.
    return requestImageTarget(image, KIMI_CODE_REQUEST_IMAGE_MAX_EDGE)
      ?? { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  private settings() {
    return this.preferences ? Promise.resolve(this.preferences.status()) : this.modelSettings.read()
  }

  /**
   * Catalog for the picker: the live managed listing when reachable, the
   * shipped fallback otherwise, narrowed by the user's enabled selection.
   */
  private async catalog(): Promise<KimiCodeCatalogModel[]> {
    const pool = this.accountPool
    const load = this.options.loadCatalog
      ?? (() => loadProviderModels({
        fetchFn: this.options.fetchFn,
        store: this.store,
        // With a pool the single-credential file is only a mirror of one pooled
        // account, and a refresh rotates the refresh token. Reading the mirror
        // here would spend the token the pool is about to present, so the pool
        // is asked instead.
        ...(pool === null
          ? {}
          : { credentialProvider: (_region: KimiCodeRegion) => pool.getFreshCredential(undefined, this.options.fetchFn ?? fetch).then((c) => c.accessToken) }),
      }))
    const live = await load().catch(() => [])
    if (live.length > 0) return live
    return FALLBACK_MODELS.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      inputModalities: [...(kimiCodeModelDef(model.id)?.inputModalities ?? ['text'])],
      supportsVideo: kimiCodeModelDef(model.id)?.inputModalities.includes('video') ?? false,
      supportsDynamicTools: kimiCodeModelDef(model.id)?.supportsDynamicTools === true,
    }))
  }

  /**
   * The single window this line reports AND budgets against.
   *
   * The resolution lives here, in the one place both readers go through, rather
   * than at each call site: `resolveModel` publishes this number to DSH (which
   * computes its compaction threshold from it) and `requestStream` sizes the
   * completion budget with it, so two independent resolutions would let the
   * promise and the budget drift apart.
   *
   * By default the window is published exactly as declared, and a user override
   * is an ordinary declared window: an explicit 1M is the model's advertised
   * capacity as this user chose it, and silently shrinking it would take away
   * the context they asked for. A session that outgrows the byte ceiling is
   * recovered at the wall (CONTEXT_OVERFLOW_CODE), not pre-emptively summarized.
   *
   * A deployment that would rather compact BEFORE the wall sets
   * DSH_KIMI_CODE_BYTES_PER_TOKEN, and then the override is bounded like every
   * other window — see {@link effectiveContextWindow}.
   */
  private contextWindowFor(
    modelId: string,
    entry: KimiCodeCatalogModel | undefined,
    overrides: Record<string, number>,
  ): number {
    const override = overrides[modelId]
    const declared = typeof override === 'number' && Number.isFinite(override) && override > 0
      ? override
      : entry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
    return effectiveContextWindow(declared)
  }

  async listModels(provider?: string): Promise<readonly LlmModelInfo[]> {
    const prov = provider || PROVIDER_ID
    const settings = await this.settings()
    if (settings.enabled === false) return []
    const catalog = await this.catalog()
    const enabled = new Set(settings.enabledModelIds)
    const available = catalog.filter((model) => enabled.has(model.id))

    return available.map((model) => ({
      provider: prov,
      id: model.id,
      name: model.name ?? model.id,
      // Video rides through the real modality channel, so DSH's own capability
      // gates (image admission, read_image, subagent delegation) see exactly
      // what this model accepts instead of a hardcoded guess.
      inputModalities: inputModalitiesForEntry(model.id, catalog),
    }))
  }

  async resolveModel(provider: string, modelId: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted) throw new LlmError('Kimi Code model resolution aborted', 'ABORTED')
    const settings = await this.settings()
    const catalog = await this.catalog()
    const entry = catalog.find((model) => model.id === modelId)
    const efforts = orderReasoningEfforts(reasoningEffortsForEntry(modelId, catalog), ['none', 'low', 'high', 'max'])
    // Resolved through the shared helper rather than reading the entry directly,
    // so a declared default that the three-state thinking rule removed cannot
    // reach the caller as a level the model no longer accepts.
    const entryDefault = defaultReasoningEffortForEntry(modelId, catalog)
    const defaultEffortId = resolveDefaultReasoningEffort(efforts, settings.defaultReasoningEffort)
      ?? (entryDefault === undefined ? undefined : resolveDefaultReasoningEffort(efforts, entryDefault))

    return {
      provider,
      id: modelId,
      name: entry?.name ?? modelId,
      inputModalities: inputModalitiesForEntry(modelId, catalog),
      context: { contextWindow: this.contextWindowFor(modelId, entry, settings.contextWindowOverrides) },
      // Deliberately omit defaultMaxTokens: DSH materializes it into requests
      // and reserves it in compaction. Our window-sized cap is dynamic, not a
      // fixed reservation. requestStream computes it after measuring the prompt;
      // explicit caller caps still win there (including compaction summaries).
      ...(efforts.length === 0
        ? {}
        : {
            reasoning: {
              efforts: efforts.map((effort) => ({ id: ReasoningEffortId(effort), name: effort })),
              ...(defaultEffortId === undefined ? {} : { defaultEffort: defaultEffortId }),
            },
          }),
    }
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const settings = await this.settings()
    const effort = options.reasoningEffort ?? settings.defaultReasoningEffort ?? undefined
    const effectiveOptions: GenerateOptions = effort === undefined || effort === null
      ? options
      : { ...options, reasoningEffort: ReasoningEffortId(String(effort)) }

    yield* wrapStreamWithWatchdog(
      (watchdogSignal, activity) => this.requestStream(effectiveOptions, watchdogSignal, activity),
      options.signal,
      STREAM_IDLE_TIMEOUT_MS,
      STREAM_IDLE_TIMEOUT_CODE,
      PROVIDER_NAME,
    )
  }

  private async *requestStream(
    options: GenerateOptions,
    signal: AbortSignal,
    activity?: StreamActivity,
  ): AsyncGenerator<StreamChunk> {
    const fetchFn = this.options.fetchFn ?? fetch

    const catalog = await this.catalog().catch(() => [])
    const wire: KimiCodeWire = wireForCatalogEntry(options.model, catalog)

    const entry = catalog.find((model) => model.id === options.model)

    // DSH delivers pasted images as durable references because this route
    // declares image input; both wires need bytes, so resolve them once up
    // front and reuse the result for the single request below. Video travels
    // the same path and is dropped oldest-first against its own, far larger
    // budget, because one clip dwarfs the whole image allowance.
    // Resolution runs BEFORE the budget decision so the decision is made on
    // the bytes that will actually be sent. Measuring the stored image — as this
    // route did — reported every scaled screenshot as several megabytes and
    // dropped images that were about to fit in ~256 KiB each.
    const normalized = normalizeGenerateOptions(options)
    // The route's own ceiling, not the shared one: the wire version this request
    // carries has to be the same 2000 px long edge `imageRequestTarget()` reports
    // to screenshot callers, or the declaration and the bytes disagree.
    const images = await resolveRequestImages(
      normalized,
      this.options.attachments,
      signal,
      KIMI_CODE_REQUEST_IMAGE_MAX_EDGE,
    )
    const imageTrimmed = offloadOldestRequestImages(
      normalized,
      maxRequestImageBytes(),
      images,
    )
    // THE THINKING GATE, for every wire.
    //
    // The service answers HTTP 400 for a disabled-thinking request on a model
    // that cannot stop reasoning ("K3.1 Pro does not support disabled thinking
    // mode"), and no wire can express "off" for such a model at all. The
    // caller's real intent is "spend less", not "fail", so the level is lifted
    // to the model's own default and the lift is recorded rather than swallowed.
    // Applied here, before the body is built, so no builder can be reached with a
    // level the service would refuse.
    const gatedEffort = coerceThinkingEffort(
      options.model,
      mapReasoningEffort(options.reasoningEffort === undefined || options.reasoningEffort === null
        ? undefined
        : String(options.reasoningEffort)),
    )
    if (gatedEffort.coercedFrom !== null) {
      recordThinkingCoercion(
        { model: options.model, wire, from: gatedEffort.coercedFrom, to: gatedEffort.effort },
        options.sessionId,
      )
    }
    const videoTrimmed = offloadOldestRequestVideos(imageTrimmed, MAX_REQUEST_VIDEO_BYTES)
    const requestOptions: NormalizedGenerateOptions = gatedEffort.effort === undefined
      ? videoTrimmed
      : { ...videoTrimmed, reasoningEffort: ReasoningEffortId(gatedEffort.effort) }
    const videos = await resolveRequestVideos(requestOptions, this.options.videos, signal)
    const settings = await this.settings()
    const modalities = inputModalitiesForEntry(options.model, catalog)
    /**
     * Everything every attempt shares: the media reads and the capability gates.
     *
     * Account-specific references are merged on top of this per attempt, so the
     * gate is applied once and a reference can never be cited for a modality the
     * model does not declare.
     */
    const baseMedia: RequestMediaOptions = {
      videos,
      videoAccepted: modalities.includes('video'),
      // Same resolver the settings card uses, so UI and wire cannot disagree.
      messageTools: dynamicToolsForEntry(options.model, catalog),
    }
    /**
     * Which readable occurrences the reference path would cover.
     *
     * Decided here so the body-fit guard can measure the body that will actually
     * be sent; nothing is uploaded, and no network is touched, until that guard
     * has accepted the request (see the rotation loop).
     */
    const planned = planMediaReferences({
      wire,
      imageAccepted: modalities.includes('image'),
      videoAccepted: baseMedia.videoAccepted === true,
      images,
      videos,
    })

    const contextWindow = this.contextWindowFor(
      options.model,
      entry,
      settings.contextWindowOverrides,
    )
    // A hand-built request states its own cap; an unstated one tracks the window
    // so long reasoning is not cut off at a fixed ceiling, and either way the
    // cap is reduced when the caller already knows the prompt will not fit.
    // A request carrying video is measured against the larger ceiling, so the
    // caller is told about an oversized body rather than about a limit sized
    // for text alone.
    const requestedMax = options.maxTokens ?? maxOutputTokensFor(options.model, contextWindow)
    // A service-declared input cap is what actually bounds the PROMPT, and the
    // window is what bounds the completion. Clamping only against the window
    // lets a prompt grow past the endpoint's input limit and come back as a
    // rejection rather than as the compaction that would have avoided it, so
    // the two are separated here and the smaller one guards the prompt.
    const inputCap = maxInputTokensForEntry(options.model, catalog)
    const promptLimit = inputCap === undefined ? contextWindow : Math.min(contextWindow, inputCap)
    const boundedOptions: NormalizedGenerateOptions = {
      ...requestOptions,
      maxTokens: clampOutputToContext(requestedMax, promptLimit, estimatedInputTokens(requestOptions)),
    }
    // Greedy body fit. The image budget above is a heuristic that assumes room
    // for the conversation; when a long session leaves none, this measures the
    // REAL body and drops only as many oldest images as it takes to fit, rather
    // than refusing a request the upstream would have accepted after one more
    // omission. It stops as soon as the body fits, so a request that already fit
    // is serialized exactly once and unchanged.
    const carriesVideo = requestHasVideo(requestOptions)
    // The text/image tier is graded by model, and the tier lives on the STATIC
    // registry row: the live /v1/models entry reports capabilities and never this
    // deployment's byte headroom, and a row the listing omits would otherwise
    // fall back to the 2 MB floor for a 1M model. Resolving by id keeps the
    // ceiling right on the live path, the fallback path and an unknown id alike.
    const bodyLimit = carriesVideo
      ? MAX_VIDEO_MESSAGE_BODY_BYTES
      : maxRequestBodyBytesFor(kimiCodeModelDef(entry?.id ?? options.model), process.env)
    /**
     * Run the greedy body-fit loop for ONE set of media references.
     *
     * A function rather than a loop in place because the same loop now serves
     * every build of one request: the pre-upload MEASUREMENT (placeholder
     * references), the real reference build after the upload, and the all-inline
     * rebuild the missing-resource fallback re-sends.
     *
     * Every call restarts from `boundedOptions`. That is load bearing rather than
     * tidy: the inline fallback has to re-fit the inline body from scratch and
     * stay inside the same ceiling instead of inheriting an omission the
     * reference path made to fit a different, much smaller body.
     */
    const buildBodyWithinLimit = (
      media: RequestMediaOptions,
    ): { body: string; options: NormalizedGenerateOptions } => {
      let buildOptions = boundedOptions
      for (let attempt = 0; ; attempt++) {
        const built = buildRequest(buildOptions, wire, images, undefined, media)
        // The guard returns the serialized body it measured, so the multi-megabyte
        // string is built once instead of twice.
        const body = JSON.stringify(built)
        const bytes = Buffer.byteLength(body, 'utf8')
        // The options come back WITH the body because they are what the upload set
        // is read off: an occurrence the loop dropped here is no longer sent, so it
        // must not be uploaded either.
        if (bytes <= bodyLimit) return { body, options: buildOptions }
        // Nothing left to give back: the remainder is conversation text, tool
        // schemas or video, none of which this route may silently discard. The
        // guard then reports the composition so the remedy names the real cause.
        // What the loop DID, which is not what the byte composition suggests. A
        // guard answering from the composition alone promises an omission a
        // stalled loop never performed.
        const context = (): BodyFitContext => ({
          droppedImages: countOmitted(buildOptions, requestOptions, images),
          sendableImagesRemaining: requestImagePayloadLengths(buildOptions, images).length,
          excessBytes: bytes - bodyLimit,
        })
        if (attempt > MAX_BODY_FIT_ATTEMPTS || !requestHasSendableImage(buildOptions, images)) {
          assertRequestBodyFits(built, carriesVideo, context(), bodyLimit)
          throw new Error('unreachable: assertRequestBodyFits returns or throws')
        }
        const drop = dropOldestImagesUntilFits(buildOptions, images, bytes - bodyLimit, requestOptions)
        // Nothing was droppable even though an image is still attached: the images
        // left weigh less than the overflow, so another turn would rebuild the
        // identical body. Stop here instead of spending the attempt budget
        // re-serializing a multi-megabyte request that cannot change.
        if (drop.dropped === 0) {
          assertRequestBodyFits(built, carriesVideo, context(), bodyLimit)
          throw new Error('unreachable: assertRequestBodyFits returns or throws')
        }
        buildOptions = drop.options
      }
    }

    /**
     * The measured build for the reference path, done at most once.
     *
     * Held across rotation attempts because it is account-independent: it decides
     * whether this request can be sent at all, and that answer cannot change
     * because a different account answered.
     *
     * The OPTIONS travel with the body because they, not the plan, name the media
     * this request still carries: see {@link mediaAttachmentIdsIn}.
     */
    let measured: { body: string; options: NormalizedGenerateOptions } | undefined

    const pool = this.accountPool
    const tried = new Set<string>()
    // Hoisted out of the rotation loop so the account that actually served the
    // response is still in scope when the stream closes and files its usage, and
    // when a failure reported inside the stream takes that account out of
    // rotation below.
    let servedByAccountId: string | undefined
    let response: Response | undefined

    // Account rotation. Without a pool this runs exactly once and keeps the
    // original credential preparation and error mapping; with one, an account
    // that is rate limited, out of quota or no longer authenticating steps out
    // of the rotation while another account serves the same payload.
    while (true) {
      let apiCredentials: KimiCodeCredentials
      let accountId: string | undefined
      if (pool === null) {
        try {
          // A token near expiry is rotated here; a rejected refresh token
          // surfaces as an unauthorized error, which is not retried.
          apiCredentials = await ensureAccessToken(this.store, { fetchFn, signal })
        } catch (error) {
          if (error instanceof KimiCodeUnauthorizedError) {
            throw new LlmError(error.message, 'INVALID_CREDENTIAL', { cause: error })
          }
          throw new LlmError(
            `Kimi Code credential could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
            'MISSING_CREDENTIAL',
            { cause: error },
          )
        }
      } else {
        let effective: { account: { id: string }; credentials: KimiCodeCredentials }
        try {
          effective = await pool.getEffectiveCredential(tried, fetchFn)
        } catch (error) {
          // The pool's own verdict (an exhausted rotation) is already typed; a
          // plain error means no account is signed in at all.
          if (error instanceof LlmError) throw error
          throw new LlmError(
            error instanceof Error ? error.message : 'Kimi Code credential could not be prepared.',
            'MISSING_CREDENTIAL',
            { cause: error },
          )
        }
        accountId = effective.account.id
        servedByAccountId = accountId
        tried.add(accountId)
        apiCredentials = effective.credentials
      }

      // Every attempt uses the credential's own region and hosts: one pool may
      // legitimately hold accounts issued in different regions.
      const region = apiCredentials.region ?? await resolveRegion()
      const base = (apiCredentials.baseUrl ?? codingBaseUrl(region)).replace(/\/+$/, '')
      const endpoint = wire === 'anthropic'
        ? `${base}/v1/messages?beta=true`
        : `${base}/v1/chat/completions`
      const headers = await modelRequestHeaders(apiCredentials.accessToken, wire)
      /**
       * Which account's file store this attempt writes to and cites from.
       *
       * A pooled account's own id, because that is the only identity a reference
       * may be cached under; a single stored credential uses the user id its
       * sign-in reported, or a constant when it reported none. The access token is
       * never used, here or anywhere a cache key is built.
       */
      const accountScope = accountId ?? legacyAccountScope(apiCredentials)

      // MEASURED BEFORE ANYTHING IS UPLOADED. Two pressures meet here and both
      // decide the order:
      //
      // - the reference path sends a far smaller body than the inline one, so the
      //   body-fit guard has to measure what will actually be sent. Measuring the
      //   inline body would refuse a request the reference path comfortably fits,
      //   which is the whole reason this route uploads at all.
      // - an upload is a real, billable request, so the ceiling must be checked
      //   before paying for it. Measuring afterwards would upload media for a
      //   request that can never be sent.
      //
      // Placeholder references resolve both: the measured body has the shape and
      // roughly the length of the real one, and nothing here touches the network.
      if (measured === undefined) {
        measured = buildBodyWithinLimit(planned.length === 0
          ? baseMedia
          : { ...baseMedia, ...plannedReferenceMaps(planned) })
      }

      // Only the media the MEASURED build still sends are uploaded.
      //
      // Planning reads every readable occurrence, which is strictly more than the
      // request will carry: the budget passes and the body-fit loop both replace
      // occurrences with a text placeholder when they have to free bytes. Uploading
      // those would buy a reference nothing cites and, for a clip, a real upload of
      // a file the service is never asked to read. The final build is the authority,
      // so the difference between the plan and it is dropped here.
      const stillSent = mediaAttachmentIdsIn(measured.options)
      const uploadable = planned.filter((item) => stillSent.has(item.attachmentId))

      // Uploads run under THIS account's credential, base URL and scope, so the
      // reference the chat body cites belongs to the account that will read it.
      const uploads = uploadable.length === 0
        ? undefined
        : await this.uploadPlannedReferences({
            planned: uploadable,
            accessToken: apiCredentials.accessToken,
            baseUrl: base,
            accountScope,
            signal,
          })
      // Rebuilt from the references that really exist, not from the plan: an
      // occurrence whose upload failed is sent inline while its siblings are
      // cited, so one refused clip does not cost the request its images.
      let body = uploads === undefined
        ? measured.body
        : buildBodyWithinLimit({
            ...baseMedia,
            imageReferences: uploads.imageReferences,
            videoReferences: uploads.videoReferences,
          }).body

      const post = async (payload: string): Promise<Response> => {
        try {
          return await fetchWithContextBudgetRecovery(fetchFn)(endpoint, { method: 'POST', headers, body: payload, signal })
        } catch (error) {
          if (signal.aborted) throw new LlmError('Kimi Code request aborted', 'ABORTED', { cause: error })
          // A connection that never produced a response is a transport failure, not
          // a verdict from the provider: the same request is eligible for the
          // bounded backoff above instead of failing the turn outright.
          throw new LlmError(
            `Kimi Code request failed: ${error instanceof Error ? error.message : String(error)}`,
            'TRANSPORT',
            { cause: error },
          )
        }
      }

      response = await post(body)
      let detail = response.ok ? '' : (await response.text().catch(() => '')).slice(0, 2_000)

      // A CITED FILE THE STORE NO LONGER HOLDS.
      //
      // This is the one 404 a resend can fix, and the conditions are deliberately
      // narrow: the status, the measured sentence, and a request that really cited
      // a reference. A 404 naming an unknown model or a missing route carries
      // neither, and resending it inline would spend a whole turn to learn that.
      //
      // The dead references are dropped from the cache first, so the next turn
      // uploads again instead of replaying an id that is already known to be gone.
      // The re-send is all-inline, on the SAME account, and attempted once: this
      // code path runs once per rotation attempt and falls through to the ordinary
      // classification below rather than looping.
      if (response.status === 404 && uploads !== undefined && uploads.cited.length > 0
        && isMissingResourceBody(detail)) {
        const uploader = this.mediaFiles()
        for (const item of uploads.cited) {
          uploader.forget({ baseUrl: base, accountScope, mediaType: item.mediaType, data: item.data })
        }
        let inline: string | undefined
        try {
          inline = buildBodyWithinLimit(baseMedia).body
        } catch {
          // The inline body cannot fit this ceiling, so the reference path was the
          // only one that could send this request; the 404 is reported as it stands
          // rather than replaced by an overflow the caller cannot act on.
          inline = undefined
        }
        if (inline !== undefined) {
          body = inline
          response = await post(body)
          detail = response.ok ? '' : (await response.text().catch(() => '')).slice(0, 2_000)
        }
      }

      if (response.ok) break

      const failure = classifyKimiFailure(response.status, detail)
      const after = response.status === 429 ? retryAfterMs(response.headers) : undefined

      if (pool !== null && accountId !== undefined) {
        // A plan-scoped 429 is a property of the request, not of the account:
        // rotating cannot help, and cooling every account after one such request
        // would take the whole pool offline.
        const planScoped = response.status === 429 && matchesAny(detail, ENTITLEMENT_PATTERNS)
        // 过载必须在这里显式排除：整条链路的判据历来是 HTTP 状态码，而 429 同时
        // 承载「本账号被限流」和「上游引擎繁忙」两种含义。若不在这一层挡下，
        // classifyKimiFailure 判得再对也没有用——号池会照旧给唯一那个账号写
        // 15 分钟冷却（POOL_COOLDOWN_MS），harness 的每一次退避重试随后都被
        // isEligible 挡在门外，一次网络请求都发不出去。判据取自分类结果的
        // upstreamOverload（正文命中 UPSTREAM_OVERLOAD_PATTERNS），而不是这里
        // 再匹配一次正文：分类是唯一知道这句话含义的地方，号池只消费它的结论。
        // 排除后既不冷却也不轮转，直接把可重试的 SERVER 抛给 harness，让退避
        // 在同一个账号上真的重发请求——过载时换号只会撞上同一台繁忙的引擎。
        if (response.status === 429 && !planScoped && !failure.upstreamOverload) {
          // A spent balance is this account's own and stays spent, so it takes
          // the window's length rather than the retry-after of a back-pressure
          // signal that would have meant nothing here.
          const cooldownMs = failure.accountScoped
            ? accountLimitCooldownMs(detail)
            : after ?? POOL_COOLDOWN_MS
          await pool.markCooldown(accountId, cooldownMs, `${PROVIDER_NAME} 429`).catch(() => undefined)
          if (await pool.hasAnotherAvailableAccount(tried)) continue
        } else if (failure.code === 'INVALID_CREDENTIAL') {
          // A dead refresh token is that account's problem alone: keep the
          // account (signing in again restores it) and take it out of rotation.
          await pool.markAuthFailed(accountId, failure.message).catch(() => undefined)
          if (await pool.hasAnotherAvailableAccount(tried)) continue
        } else if (failure.accountScoped) {
          // A usage window this account has spent, which this service reports as
          // a 403. Neither of the branches above recognizes it — the credential
          // is fine and the request must not be retried against the same account
          // — so before this branch existed a pool of several accounts failed the
          // whole turn on whichever one happened to be first. Cooling this one
          // until its window resets is what lets the next account answer.
          await pool.markCooldown(accountId, accountLimitCooldownMs(detail), `${PROVIDER_NAME} 403`).catch(() => undefined)
          if (await pool.hasAnotherAvailableAccount(tried)) continue
        }
      }

      throw new LlmError(failure.message, failure.code, {
        status: response.status,
        ...(after === undefined ? {} : { providerRetryAfterMs: after }),
      })
    }

    if (response.body === null) throw new LlmError('Kimi Code returned an empty response body', 'PROVIDER_ERROR')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    // The session travels with the turn so usage is filed under the right
    // conversation when the stream closes; the account is passed separately
    // below, once rotation has settled on one.
    const state = createStreamState(wire, requestOptions.sessionId)
    // The per-tier split of the cache write exists ONLY in the response headers
    // (the body states the total), so it is read here — the one place the
    // Response is in hand — and filed with the rest of the usage at close time.
    applyCacheWriteTiers(state, response.headers)
    // Recorded after the turn is built and sent, so the timestamp answers when
    // this conversation last ran — the input the cache-expiry hint needs.
    markSessionActive(requestOptions.sessionId)
    let buffer = ''
    /**
     * Set the moment ANY chunk reaches the caller, and never cleared.
     *
     * Deliberately broader than "text arrived": a block-start the caller has
     * already seen repeats just as badly as text it has already read, so the
     * conservative reading is the one that cannot be wrong. It is what keeps the
     * in-band reclassification below pre-output only.
     */
    let outputStarted = false

    try {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          // Bytes on the wire are the liveness signal: a heartbeat or status frame
          // that produces no displayable chunk still proves the connection is alive,
          // so the timer is reset at the transport layer, not at the parser.
          if (value !== undefined && value.byteLength > 0) activity?.pulse()
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            // One pulse per complete frame; a pure comment frame (": ping",
            // ": keep-alive") is exactly what the display-layer timer misread as silence.
            activity?.pulse()
            for (const chunk of processLine(line, state, wire)) {
              outputStarted = true
              yield chunk
            }
            if (state.finished) return
          }
        }

        buffer += decoder.decode()
        if (buffer.trim() !== '') {
          for (const line of buffer.split('\n')) {
            for (const chunk of processLine(line, state, wire)) {
              outputStarted = true
              yield chunk
            }
          }
        }
        if (state.finished) return

        // A connection that ends without a terminal event is a truncated stream,
        // not a completed answer; the watchdog turns a stalled one into an abort.
        assertStreamComplete(state)
        for (const chunk of closeStream(state, servedByAccountId)) {
          outputStarted = true
          yield chunk
        }
      } catch (error) {
        // A verdict the mapper already typed (a truncated stream, an in-band
        // error event) is passed through — except an in-band error event that
        // arrived before anything reached the caller, which is classified the
        // way this line classifies the response body it is equivalent to: an
        // Anthropic type through {@link classifyKimiFailure} at the status that
        // type stands for, an OpenAI one through the Responses vocabulary the
        // sibling lines read. Either way every rule the HTTP path owns still
        // owns the verdict, so the same overload, the same spent window and the
        // same plan refusal reach the retry policy as they would have as a
        // status. A context overflow is excluded from that, because its code is
        // how the turn is compacted and recovered rather than retried. After the
        // first chunk the mapper's verdict stands: a retry would repeat output
        // the user has already seen.
        const inBand = state.streamError
        if (error instanceof LlmError && !outputStarted && error.code === 'PROVIDER_ERROR'
          && inBand !== undefined) {
          throw await this.inBandStreamFailure(error, inBand, servedByAccountId)
        }
        // Everything else that escaped the read loop came from the transport, not
        // from the provider: see streamFailure.
        throw streamFailure(error, signal)
      }
    } finally {
      void reader.cancel().catch(() => undefined)
    }
  }

  /**
   * What one in-band failure becomes once the pool has been told what the
   * verdict means for it.
   *
   * Reclassification and the pool reaction are separate because they answer
   * different questions about the same classification: the code decides whether
   * the harness retries, `accountScoped` decides whether a retry could land
   * somewhere that can answer. The mapper can supply only the first, which is
   * why the wire object is recorded there and read here.
   *
   * The body is the one a non-2xx response would have carried, so every pattern
   * below reads exactly what the HTTP branch reads and a limit cannot mean one
   * thing as a status and another as an event. The request itself is NOT
   * re-issued: its body is already open and part-read, and the harness retry
   * policy owns the repeat.
   */
  private async inBandStreamFailure(
    thrown: LlmError,
    inBand: KimiCodeInBandStreamError,
    accountId: string | undefined,
  ): Promise<LlmError> {
    const bodyText = JSON.stringify({ error: inBand.error })
    const reclassified = inBand.vocabulary === 'anthropic'
      ? reclassifyInBandError(thrown, inBand.error, classifyKimiFailure)
      : reclassifyInBandResponsesError(thrown, inBand.error, inBand.message, classifyKimiFailure)
    const pool = this.accountPool
    if (pool === null || accountId === undefined) return reclassified

    if (inBand.vocabulary === 'anthropic') {
      const status = inBandAnthropicStatus(inBand.error)
      // A type this vocabulary does not name classifies to nothing, so there is
      // no verdict to weigh against the pool and the mapper's own stands.
      if (status === null) return reclassified
      const failure = classifyKimiFailure(status, bodyText)
      // The same chain the non-2xx branch runs, in the same order: a
      // plan-scoped 429 is a property of the request, so it cools nothing and
      // rotating on it would spend the whole pool to learn the same refusal.
      // Kept whole rather than narrowed to the statuses named today, so a type
      // the table later adds lands in the arm that already owns it.
      const planScoped = status === 429 && matchesAny(bodyText, ENTITLEMENT_PATTERNS)
      // 与 HTTP 分支同一个排除项：in-band 走的是同一套判定，只是投递方式不同。
      // 同一个信号换个投递方式就又冷却一次，等于这条线路只在状态码那条路上修好了。
      if (status === 429 && !planScoped && !failure.upstreamOverload) {
        await this.coolInBandRateLimit(pool, accountId, failure.accountScoped, bodyText)
      } else if (failure.code === 'INVALID_CREDENTIAL') {
        // A credential the stream itself calls dead is that account's problem
        // alone, and signing in again restores it — so mark it, never delete.
        await pool.markAuthFailed(accountId, failure.message).catch(() => undefined)
      } else if (failure.accountScoped) {
        // A window this account has spent: the retry is about to repeat the
        // request, and repeating it against the same spent window fails
        // identically three times over.
        await pool.markCooldown(accountId, accountLimitCooldownMs(bodyText), `${PROVIDER_NAME} in-stream 403`).catch(() => undefined)
      }
      return reclassified
    }

    // This vocabulary names no status at all, so nothing is synthesized to
    // classify against and no arm is invented: the code the vocabulary derived
    // selects it. RATE_LIMIT is the 429 rule below, and SERVER is the 5xx rule,
    // which the HTTP path leaves the pool alone for — an overload is not one
    // account's property to carry.
    //
    // 过载不需要在这里再排除一次，因为本臂的判据是 code 而不是状态码：那条 code
    // 正是 classifyKimiFailure 给同一段正文定的罪，而它现在把过载定成 SERVER，
    // 所以过载根本走不进来。Anthropic 那条臂就不同了 —— 它的判据是自己合成的
    // 状态码（rate_limit_error → 429），不经过分类，所以必须显式排除。两条臂
    // 判据不同，防护的位置也就必须不同。
    if (reclassified.code === 'RATE_LIMIT' && !matchesAny(bodyText, ENTITLEMENT_PATTERNS)) {
      // The same 429 rule, with the scope read off that arm's own classification
      // — which is where the HTTP branch reads `accountScoped` from too, so a
      // spent balance leaves rotation here exactly as it does there.
      await this.coolInBandRateLimit(pool, accountId, classifyKimiFailure(429, bodyText).accountScoped, bodyText)
    }
    return reclassified
  }

  /**
   * Cool the account whose own rate limit the stream reported.
   *
   * The window this route already defaults to, never a Retry-After: there is no
   * 429 response to read one from, and a delay stated on the 200 belongs to a
   * different message. An account-scoped verdict takes its own window instead,
   * because a spent balance is not back-pressure and 15 minutes would put the
   * account back into rotation four times inside the window that refused it.
   */
  private async coolInBandRateLimit(
    pool: KimiCodeAccountPool,
    accountId: string,
    accountScoped: boolean,
    bodyText: string,
  ): Promise<void> {
    const cooldownMs = accountScoped ? accountLimitCooldownMs(bodyText) : POOL_COOLDOWN_MS
    await pool.markCooldown(accountId, cooldownMs, `${PROVIDER_NAME} in-stream 429`).catch(() => undefined)
  }
}

/**
 * The failure a stream that died mid-body is reported as.
 *
 * Everything above the response body is already typed: a connection that never
 * produced a response raises TRANSPORT, a non-2xx raises its classified verdict,
 * and the parser raises its own protocol or provider verdict. The body itself
 * was the gap. A connection that ends before the response does arrives as
 * undici's bare `TypeError: terminated`, which carries no code of its own, so the
 * harness normalizes it to UNKNOWN — and UNKNOWN is not in this route's
 * `retryableCodes`, so one severed connection ended the turn with no second
 * attempt at all. The real reason (ECONNRESET, a socket closed by the far side, a
 * body timeout) sat on `.cause`, which the harness drops before the failure is
 * persisted, so the report could not even say what had happened.
 *
 * So the transport is named here and its cause chain is kept in the message, and
 * only what the route already typed is left alone: an `LlmError` is this line's
 * own verdict, and a caller abort is a cancellation rather than a fault.
 *
 * The code is TRANSPORT even once chunks have been yielded. DSH settles a failed
 * attempt as an `assistant/attempt` — no model history and no rendered answer —
 * and starts a fresh attempt on retry, and a tool call is only executed after its
 * stream finishes, so retrying can neither repeat committed output nor re-run a
 * tool. What the user sees is the live text of the dead attempt replaced by the
 * retried one.
 */
function streamFailure(error: unknown, signal: AbortSignal): LlmError {
  if (error instanceof LlmError) return error
  if (signal.aborted) return new LlmError('Kimi Code stream aborted', 'ABORTED', { cause: error })
  const chain = errorChain(error).trim()
  const detail = chain === '' ? 'the response stream ended unexpectedly' : chain.slice(0, 500)
  return new LlmError(`Kimi Code stream failed: ${detail}`, 'TRANSPORT', { cause: error })
}

function processLine(line: string, state: KimiCodeStreamState, wire: KimiCodeWire): StreamChunk[] {
  return wire === 'anthropic'
    ? processAnthropicStreamLine(line, state)
    : processOpenAIStreamLine(line, state)
}

export { clearCachedCatalog, buildModelOptions, reasoningEffortsFor, PROVIDER_ID }
