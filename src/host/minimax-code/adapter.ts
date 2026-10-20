/**
 * The DSH adapter for the MiniMax Code subscription.
 *
 * It follows the shape every other line in this package uses — claim the provider
 * id, list the hardcoded directory, resolve one model, stream one request — with
 * two differences that belong to this line alone:
 *
 * 1. the credential is the desktop app's own \`auth.json\`, read and renewed through
 *    ./oauth.ts under the read-only-first discipline; and
 * 2. there is no account pool. Pooling exists to rotate several signed-in accounts
 *    against one subscription; here there is exactly one credential, shared with an
 *    application the user is also running, and inventing a second one would mean
 *    racing that application for a rotation neither of them needs.
 */

import { fetchWithContextBudgetRecovery } from '../common/context-budget-fetch.ts'
import { CONTEXT_OVERFLOW_CODE, isHttpContextOverflow } from '../common/context-overflow.ts'
import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
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
  PROVIDER_ID,
  PROVIDER_NAME,
  STREAM_IDLE_TIMEOUT_CODE,
  STREAM_IDLE_TIMEOUT_MS,
  computeMinimaxAuthOwner,
  messagesUrl,
  redactToken,
} from './types.ts'
import {
  MINIMAX_CODE_MODELS,
  contextWindowForModel,
  isThinkingDisabledEffort,
  minimaxCodeModelDef,
  resolveMinimaxCodeEnabledModelIds,
} from './model-catalog.ts'
import type { MinimaxCodeReasoningEffort } from '../../shared/minimax-code-contracts.ts'
import {
  MinimaxCodeCredentialStore,
  MinimaxCodeModelSettingsStore,
  type MinimaxCodeCredentials,
  type MinimaxCodeModelSettings,
  type MinimaxCodePreferenceStore,
} from './token-store.ts'
import {
  MinimaxCodeUnauthorizedError,
  ensureAccessToken,
} from './oauth.ts'
import { modelRequestHeaders, summarizeFailureBody } from './client.ts'
import { inBandAnthropicStatus, reclassifyInBandError } from '../common/stream-error.ts'
import {
  assertRequestBodyFits,
  assertStreamComplete,
  buildMinimaxRequest,
  clampOutputToContext,
  closeMinimaxStream,
  createStreamState,
  estimatedInputTokens,
  maxOutputTokensFor,
  floorForcedThinkingTokens,
  maxRequestImageBytes,
  MAX_REQUEST_VIDEO_BYTES,
  offloadOldestRequestImages,
  offloadOldestRequestVideos,
  processMinimaxStreamLine,
  resolveRequestVideos,
  type AttachmentVideoReader,
  resolveRequestImages,
  type AttachmentImageReader,
  type ResolvedRequestImages,
  type ResolvedRequestVideos,
} from './mapper.ts'
import { agentBaseUrl } from './types.ts'
import { fileRef, uploadMediaFile } from './files-api.ts'
import type { MinimaxCodeAccountPool } from './account-pool.ts'
import { normalizeGenerateOptions, type GenerateOptions as NormalizedGenerateOptions } from '../common/llm-compat.ts'
import { wrapStreamWithWatchdog, type StreamActivity } from '../common/idle-watchdog.ts'
import { orderReasoningEfforts } from '../common/reasoning-efforts.ts'
import { requestImageTargetOrOriginal } from '../common/request-images.ts'
import { retryAfterMs } from '../wire-auth.ts'

/**
 * Transient-failure retry policy for the minimax-code route.
 *
 * The subscription fronts the model providers, so a call can fail with a 502/503
 * while the subscription and the credential stay perfectly usable. The retryable
 * set is therefore SERVER (any 5xx), RATE_LIMIT (genuine back-pressure), TRANSPORT
 * (a connection that produced no response) and TIMEOUT (a stalled stream, handled
 * by the idle watchdog).
 *
 * Deliberately outside the set: INVALID_CREDENTIAL (a rejected token fails
 * identically every time), PROVIDER_ERROR (a 400 or a plan refusal), and ABORTED
 * (the caller already cancelled).
 */
export const MINIMAX_CODE_RETRY_POLICY_CONFIG: {
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

const RETRY_POLICY = resolveRetryPolicy(
  MINIMAX_CODE_RETRY_POLICY_CONFIG,
  'dsh-chatgpt-subscription.minimax-code.retry',
)

/** What one failed response means for the retry policy. */
export interface MinimaxFailureClassification {
  /** DSH error code; decides whether the route retries. */
  code: string
  /** Message shown to the user, with the service's own text appended. */
  message: string
  /** True only when the failure is worth retrying. */
  retryable: boolean
  /**
   * Whether the verdict is about the ACCOUNT that made the request.
   *
   * False for every failure that belongs to the request or to the plan: ordinary
   * back-pressure, an overload, a malformed body. True only for a Token Plan window
   * this account has spent, which stays spent — so cooling it is what lets the NEXT
   * request land on an account that can answer, and cooling a plan-scoped refusal
   * would take a whole pool offline over one request. Same rule and same field name
   * as the sibling lines' `accountScoped` (kimi-code/adapter.ts:246).
   */
  accountScoped: boolean
}

/**
 * Cooldown one rate-limited account takes when the service states no delay.
 *
 * The length every sibling line defaults to (command-code:243, kimi-code:476,
 * ollama/types.ts:115, responses-client.ts:28), so a deployment reading these rows
 * across lines sees one number rather than four.
 */
const POOL_COOLDOWN_MS = 15 * 60_000

/**
 * Fallback cooldown for an account whose Token Plan window is spent.
 *
 * The 15 minutes a plain 429 gets would put the account back into rotation several
 * times inside the very window that just refused it, which is the same reason
 * kimi-code gives for its own ACCOUNT_LIMIT_COOLDOWN_MS (kimi-code/adapter.ts:478-485).
 * The Token Plan reports a 5-hour interval window and a weekly one, so each length is
 * used for the window it actually describes.
 */
const QUOTA_WINDOW_COOLDOWN_MS = 5 * 60 * 60_000

/**
 * A weekly window is not an interval window: cooling five hours would spend a request
 * every five hours to learn an answer that changes at most once a week.
 */
const WEEKLY_WINDOW_COOLDOWN_MS = 7 * 24 * 60 * 60_000

/** Body text naming the weekly window rather than the interval one. */
const WEEKLY_QUOTA_WINDOW_PATTERN = /weekly|周(?:额度|配额|重置|窗口)|每周/iu

/**
 * The cooldown one exhausted account takes, read from the body that named the verdict.
 *
 * Deliberately never a Retry-After. That header is back-pressure arithmetic — come
 * back in N seconds — and a spent plan window does not become unspent by waiting N
 * seconds. kimi-code/adapter.ts:840-845 states the same reasoning for its own exhausted
 * balance, and two lines must not disagree about a rule this shared.
 */
function quotaCooldownMs(bodyText: string): number {
  return WEEKLY_QUOTA_WINDOW_PATTERN.test(bodyText) ? WEEKLY_WINDOW_COOLDOWN_MS : QUOTA_WINDOW_COOLDOWN_MS
}

/**
 * Body text the service uses for an account-level refusal that retrying cannot fix.
 *
 * The status alone cannot separate these from ordinary back-pressure, so the body
 * is read rather than trusted: a 429 whose text names a spent balance is a verdict,
 * and retrying it only delays the message the user needs to see.
 *
 * Matched against the RAW body, not the one field summarizeFailureBody unwraps.
 * That extractor picks a single key, and the two envelopes this line documents put
 * the verdict in different places — `errorReason` on one, `base_resp.status_msg` on
 * the other — so a body whose chosen field says "rate limit" while its sibling says
 * 额度不足 must still be read as the quota verdict it is. Same reasoning, same raw-text
 * match, as the sibling line's plan-scope test (kimi-code/adapter.ts:838).
 */
const QUOTA_EXHAUSTED_PATTERNS = [
  // English, as this service and the gateways in front of it word it. Every entry
  // is a PHRASE, never a bare noun: the previous table tested /quota/i, /balance/i
  // and /exceeded/i on their own, which is how `errorReason: "rate_limit_exceeded"`
  // — ordinary back-pressure, retryable, same on every account — was filed as a
  // terminal quota verdict and handed to the user with no retry left to spend.
  /insufficient\s+(?:balance|quota|credit|funds)/i,
  /(?:balance|credit)\s+(?:is\s+)?(?:exhausted|depleted|insufficient|not\s+enough)/i,
  /quota\s+(?:is\s+)?(?:exhausted|depleted|used\s*up|run\s*out)/i,
  /exceeded\s+(?:your\s+)?(?:current\s+)?(?:quota|balance|credit|token|usage)/i,
  /exceeded_current_quota_error/i,
  /account\s+balance/i,
  /arrears/i,
  /recharge/i,
  // Chinese. MiniMax is a domestic service and answers in its own language, so a
  // pure-English table never fired on the very envelopes this line documents:
  // `base_resp.status_msg` and `errorCode`/`errorReason` (client.ts:15, types.ts:22).
  // 额度不足、余额不足、配额不足、额度已耗尽、余额已用尽、用户额度已用完
  /(?:余额|额度|配额)[^，。；;]{0,4}?(?:不足|不够|耗尽|用尽|用完|已用光)/u,
  // 请充值、需立即充值、充值后重试 — a call to action no rate limit ever issues.
  /(?:请|需|需要|立即|尽快)[^，。；;]{0,4}?(?:充值|续费|购买套餐|购买额度)/u,
  // 欠费、已欠费 — billing, never back-pressure.
  /欠费/u,
  // 超出额度 / 超过配额. Deliberately NOT 限制 or 上限 on their own: 请求超过频率限制
  // is the standard Chinese rate-limit sentence and has to stay retryable.
  /(?:超出|超过)[^，。；;]{0,6}?(?:额度|配额|余额)/u,
]

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text))
}

/**
 * Whether this refusal is a spent window rather than a refused credential.
 *
 * The same raw-body match classifyMinimaxFailure performs, hoisted into its own name
 * because it now answers a second question too, and one the status alone cannot: is
 * renewing this credential worth attempting at all (see the recovery loop in this
 * adapter). A verdict the pool acts on and a verdict the user is shown have to be the
 * SAME verdict, so both read this one predicate against the same table rather than
 * keeping two copies of the condition that could drift apart.
 *
 * The status is inside on purpose. 403 is the only status a spent window arrives as,
 * and that outer test is what keeps a 401 the credential however its body happens to
 * read — on this route the service answers code 401 with the same sentence both
 * when no credential was sent and when one was refused, so reading quota wording
 * into it would send a working token off to be renewed.
 */
function isSpentWindow403(status: number, bodyText: string): boolean {
  return status === 403 && matchesAny(bodyText, QUOTA_EXHAUSTED_PATTERNS)
}

/**
 * The verdict a spent Token Plan window gets, whichever status carries it.
 *
 * One classification for both statuses on purpose. The condition is the same and so
 * is the remedy — this account's own window is gone until it resets — so a caller
 * that branched on the status would have to duplicate this sentence, and the two
 * copies would drift. Which status the service happened to use stays visible to the
 * user through the LlmError it is thrown with.
 */
function quotaExhaustedFailure(detail: string): MinimaxFailureClassification {
  return {
    code: 'PROVIDER_ERROR',
    retryable: false,
    accountScoped: true,
    message: PROVIDER_NAME + ' reports the account quota is exhausted: '
      + (detail === '' ? 'no remaining quota' : detail)
      + '. Top up or wait for the window to reset.',
  }
}

/**
 * Classify one non-2xx response for the retry policy.
 *
 * A 401 on this route is the one failure with an unambiguous remedy, and it is the
 * one the credentials rule exists for: the service answers
 * \`{"code":401,"message":"token is required"}\` both when no credential was sent
 * and when the one that was sent is no longer accepted, so the message names the
 * sign-in path instead of asking the user to guess.
 */
export function classifyMinimaxFailure(status: number, bodyText: string): MinimaxFailureClassification {
  const detail = summarizeFailureBody(bodyText)
  if (isHttpContextOverflow(status, bodyText)) {
    return { code: CONTEXT_OVERFLOW_CODE, retryable: false, accountScoped: false, message: `${PROVIDER_NAME} context window exceeded: ${detail}` }
  }

  // A spent window this service reports as a 403 rather than a 429.
  //
  // Read BEFORE the credential branch below, and against the RAW body for the reason
  // QUOTA_EXHAUSTED_PATTERNS documents: on this route the status alone cannot say
  // which of the two a 403 is. A 403 whose text names a spent window is the same
  // account-level quota verdict a 429 carries, and the pool reaction is the same too
  // — cool this account until its window resets so the next account can answer
  // (kimi-code/adapter.ts:853-862 reaches the same place from the other direction).
  //
  // It must come first for the opposite reason as well: every 403 the table does NOT
  // match is a refused credential, and cooling or rotating on those would spend the
  // pool's other accounts one by one presenting a token the service is refusing for
  // a reason a different account cannot fix.
  if (isSpentWindow403(status, bodyText)) {
    return quotaExhaustedFailure(detail)
  }

  if (status === 401 || status === 403) {
    return {
      code: 'INVALID_CREDENTIAL',
      retryable: false,
      // markAuthFailed, not markCooldown, owns this one — see the pool branch in
      // the adapter. It is still this account's verdict and no other's, so the
      // flag is true even though the call that consumes it is a different one.
      accountScoped: true,
      message: PROVIDER_NAME + ' rejected the stored credential (' + status + '). Sign in again in the '
        + 'MiniMax Code app, then reopen this card.'
        + (detail === '' ? '' : ' ' + detail),
    }
  }

  if (status === 429) {
    if (matchesAny(bodyText, QUOTA_EXHAUSTED_PATTERNS)) {
      return quotaExhaustedFailure(detail)
    }
    // Back-pressure: every account behind the same plan would be refused the same
    // way, so this is NOT accountScoped and cooling it would empty the pool.
    return {
      code: 'RATE_LIMIT',
      retryable: true,
      accountScoped: false,
      message: PROVIDER_NAME + ' is rate limited or overloaded (429): '
        + (detail === '' ? 'too many requests' : detail) + '. Retrying with backoff.',
    }
  }

  if (status >= 500) {
    return {
      code: 'SERVER',
      retryable: true,
      accountScoped: false,
      message: PROVIDER_NAME + ' upstream server error (' + status + '): '
        + (detail === '' ? 'the model provider is temporarily unavailable' : detail)
        + '. Retrying with backoff.',
    }
  }

  if (status === 400) {
    return {
      code: 'PROVIDER_ERROR',
      retryable: false,
      accountScoped: false,
      message: PROVIDER_NAME + ' rejected the request (400): '
        + (detail === '' ? 'the request was not accepted' : detail),
    }
  }

  return {
    code: 'PROVIDER_ERROR',
    retryable: false,
    accountScoped: false,
    message: PROVIDER_NAME + ' API error (' + status + '): ' + (detail === '' ? 'No response' : detail),
  }
}

export interface MinimaxCodeAdapterOptions {
  fetchFn?: typeof fetch
  /** Attachment seam: verified bytes for one durable image. */
  attachments?: AttachmentImageReader
  /**
   * Attachment seam: verified bytes for one durable video.
   *
   * Absent means every video resolves to `unavailable` and the model is told the
   * clip is missing, which is the same honest degradation the image seam uses.
   */
  videos?: AttachmentVideoReader
  /**
   * The account pool, when this process installed one.
   *
   * With a pool the adapter rotates between accounts and lets a 429 cool one
   * account down instead of taking the whole line offline; without one it keeps
   * the single-credential behaviour it had before, reading and renewing the one
   * stored credential. Both postures are supported because the pool is optional
   * in a composition (a headless host, a test), and a missing pool must not make
   * the route unusable.
   */
  accountPool?: MinimaxCodeAccountPool
}

/** The reasoning levels one model advertises, from the hardcoded directory. */
function effortsForModel(modelId: string): string[] {
  return [...(minimaxCodeModelDef(modelId)?.reasoningEfforts ?? [])]
}

/** Input modalities one model accepts, defaulting to text when it is unknown. */
function modalitiesForModel(modelId: string): Array<'text' | 'image' | 'video'> {
  return [...(minimaxCodeModelDef(modelId)?.inputModalities ?? ['text'])]
}

/**
 * The level to advertise as this route's default for one model.
 *
 * The order is what makes the setting mean something. The user's global choice
 * wins when the model lists it; when it does not (the global level is `max` and
 * the model only offers `default`), the model's own documented default is used
 * instead — advertising a level the model refuses would make DSH materialize a
 * request the service then rejects. A line-wide "off" is honoured only where the
 * model can actually be switched off: `always-on` models have no way to disable
 * thinking, so the picker must not offer a state the wire cannot express.
 */
function resolveDefaultEffort(
  model: { reasoningEfforts: readonly string[]; defaultReasoningEffort: MinimaxCodeReasoningEffort | null; thinking: string },
  globalEffort: MinimaxCodeReasoningEffort | null | undefined,
): string | undefined {
  const efforts = model.reasoningEfforts
  // No global choice means the caller picked nothing, and DSH already has a
  // first-class spelling for that: a model that advertises no `defaultEffort`.
  // The catalog still decides what goes on the wire - `effortForModel` resolves
  // the model's own default - so nothing is lost by not repeating it here.
  if (globalEffort === null || globalEffort === undefined) return undefined
  if (model.thinking !== 'always-on' && isThinkingDisabledEffort(globalEffort)) return 'none'
  return efforts.includes(globalEffort) ? globalEffort : undefined
}


/**
 * Upload the media this request cannot carry inline, and record the reference.
 *
 * Runs AFTER the offload passes, so anything already dropped for size is gone
 * and is not uploaded on the way out. What survives and still cannot be encoded
 * inline - a clip whose base64 would overrun the 64 MB body - is uploaded and
 * replaced by an `mm_file://` reference.
 *
 * A failed upload is NOT fatal: the media simply stays inline, and the request
 * proceeds. That is deliberate - an upload is an optimization that makes a
 * large request possible, and losing the optimization must not lose the turn.
 * The budget check that follows still refuses a body that genuinely cannot fit,
 * so the failure mode is a clear local error rather than a server 400.
 *
 * @returns the options to build from, with references recorded on the blocks.
/** Whether one content block is a plain object this pass can annotate. */
function isContentBlockRecord(block: unknown): block is Record<string, unknown> {
  return typeof block === 'object' && block !== null && !Array.isArray(block)
}

/** The media type one media block declares, or undefined when it is text. */
function mediaTypeForBlock(block: Record<string, unknown>): string | undefined {
  if (block.type !== 'image' && block.type !== 'video') return undefined
  const source = isContentBlockRecord(block.source) ? block.source : undefined
  const direct = typeof block.mediaType === 'string' ? block.mediaType : undefined
  const fromSource = typeof source?.media_type === 'string' ? source.media_type : undefined
  return direct ?? fromSource
}

/** Base64 length of a block's inline payload, or its stored size, or undefined. */
function encodedLengthForBlock(
  block: Record<string, unknown>,
  resolved: ResolvedRequestImages | ResolvedRequestVideos | undefined,
): number | undefined {
  const inline = typeof block.data === 'string' ? block.data : undefined
  if (inline !== undefined && inline !== '') return inline.length
  const attachment = isContentBlockRecord(block.attachment) ? block.attachment : undefined
  const bytes = typeof attachment?.bytes === 'number' ? attachment.bytes : undefined
  return bytes === undefined ? undefined : Math.ceil(bytes / 3) * 4
}

/** The base64 payload of a block, read from storage when it is not inline. */
function encodedForBlock(
  block: Record<string, unknown>,
  resolved: ResolvedRequestImages | ResolvedRequestVideos | undefined,
): string {
  const inline = typeof block.data === 'string' ? block.data : undefined
  if (inline !== undefined && inline !== '') return inline
  const attachment = isContentBlockRecord(block.attachment) ? block.attachment : undefined
  const id = typeof attachment?.attachmentId === 'string' ? attachment.attachmentId : undefined
  if (id === undefined || resolved === undefined) return ''
  const entry = (resolved as ReadonlyMap<string, { kind: string; data?: string }>).get(id)
  return entry?.kind === 'inline' && entry.data !== undefined ? entry.data : ''
}

/**
 * Upload the media this request cannot carry inline, and record the reference.
 *
 * Runs AFTER the offload passes, so anything already dropped for size is gone
 * and is not uploaded on the way out. What survives and still cannot be encoded
 * inline - a clip whose base64 would overrun the 64 MB body - is uploaded and
 * replaced by an `mm_file://` reference.
 *
 * A failed upload is NOT fatal: the media simply stays inline and the request
 * proceeds. An upload is what makes a large request possible, so losing it must
 * not lose the turn. The budget check that follows still refuses a body that
 * genuinely cannot fit, turning the failure into a clear local error rather than
 * a server 400.
 */
async function uploadOversizedMedia(
  options: NormalizedGenerateOptions,
  images: ResolvedRequestImages,
  videos: ResolvedRequestVideos | undefined,
  credentials: MinimaxCodeCredentials,
  accountKey: string | undefined,
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<NormalizedGenerateOptions> {
  if (accountKey === undefined) return options
  // The Files API hangs off the MESSAGES path, not the host, so the base must
  // be the messages URL this adapter is about to post to. Deriving it from the
  // host asks /files/upload, which answers an HTML 404 page instead of the
  // API's own error.
  const baseUrl = messagesUrl(credentials.region)
  const inlineCeiling = Math.min(maxRequestImageBytes(), MAX_REQUEST_VIDEO_BYTES)
  const uploads: Array<Promise<{ block: Record<string, unknown>; ref: string } | undefined>> = []

  const collect = (
    content: unknown,
    resolved: ResolvedRequestImages | ResolvedRequestVideos | undefined,
  ): void => {
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (!isContentBlockRecord(block)) continue
      const mediaType = mediaTypeForBlock(block)
      if (mediaType === undefined) continue
      const bytes = encodedLengthForBlock(block, resolved)
      // Below the inline ceiling the media is cheaper to send as bytes than to
      // upload, so it is left alone.
      if (bytes !== undefined && bytes <= inlineCeiling) continue
      uploads.push(
        uploadMediaFile(
          {
            accessToken: credentials.accessToken,
            baseUrl,
            base64: encodedForBlock(block, resolved),
            bytes: bytes ?? 0,
            mediaType,
            ...(signal === undefined ? {} : { signal }),
          },
          accountKey,
          { fetchFn },
        ).then((fileId) =>
          fileId === undefined ? undefined : { block, ref: fileRef(fileId) },
        ).catch(() => undefined),
      )
    }
  }

  for (const message of options.messages) {
    collect(message.content, images)
    collect(message.content, videos)
  }

  const settled = (await Promise.all(uploads)).filter((entry): entry is { block: Record<string, unknown>; ref: string } => entry !== undefined)
  if (settled.length === 0) return options

  const byBlock = new Map<unknown, string>()
  for (const entry of settled) byBlock.set(entry.block, entry.ref)
  return {
    ...options,
    messages: options.messages.map((message) => {
      if (!Array.isArray(message.content)) return message
      let changed = false
      const content = message.content.map((block) => {
        const ref = byBlock.get(block)
        if (ref === undefined) return block
        changed = true
        return { ...block, uploadedRef: ref }
      })
      return changed ? { ...message, content } : message
    }),
  }
}

export class MinimaxCodeAdapter extends LlmAdapter {
  // Declared and assigned explicitly rather than as constructor parameter
  // properties: Node's type-stripping loader rejects a parameter property
  // outright, and this package is imported directly by tooling that runs
  // TypeScript as-is.
  private readonly store: MinimaxCodeCredentialStore
  /**
   * The JSON file fallback for the model selection.
   *
   * Every sibling line has one, and it is not dead weight even where a settings
   * service exists: it is what a later run on a harness that dropped the register
   * seam reads back.
   */
  private readonly modelSettings: MinimaxCodeModelSettingsStore
  /**
   * Registered model settings, when the harness still offers the register seam.
   *
   * Optional because the adapter is also constructed by tooling and tests that
   * have no settings service; {@link settings} then reads the file directly, so
   * both shapes answer the same three questions.
   */
  private readonly preferences: MinimaxCodePreferenceStore | undefined
  private readonly options: MinimaxCodeAdapterOptions

  constructor(
    store: MinimaxCodeCredentialStore = new MinimaxCodeCredentialStore(),
    options: MinimaxCodeAdapterOptions = {},
    modelSettings: MinimaxCodeModelSettingsStore = new MinimaxCodeModelSettingsStore(),
    preferences?: MinimaxCodePreferenceStore,
  ) {
    super()
    this.store = store
    this.options = options
    this.modelSettings = modelSettings
    this.preferences = preferences
  }

  /**
   * The current model selection.
   *
   * Synchronous on the register seam (the scope reads from memory) and a single
   * file read otherwise. The loop over models that consults it runs on every
   * model-picker query, so this is deliberately not memoized: a cached snapshot
   * would keep serving a model the user disabled in the card until the process
   * restarted, which is the complaint this whole settings surface exists to fix.
   */
  private settings(): Promise<MinimaxCodeModelSettings> {
    return this.preferences ? Promise.resolve(this.preferences.status()) : this.modelSettings.read()
  }

  /**
   * The credential one request should present, and the pool account behind it.
   *
   * With a pool, the pool picks the account (rotation, cooldown, stickiness) and
   * owns the refresh, so this must not read the single-credential file: that file
   * mirrors one pooled account, and presenting it would silently pin every request
   * to whichever account was mirrored last.
   *
   * Without a pool the previous behaviour is kept exactly, including the
   * read-only-first refresh policy.
   */
  private async acquireCredential(
    fetchFn: typeof fetch,
    signal: AbortSignal | undefined,
    /**
     * Accounts this same request has already been refused by.
     *
     * The rotation loop passes the set it has accumulated so the pool cannot hand
     * back an account this turn already failed on. It is ignored without a pool,
     * where there is nothing to rotate between: the one stored credential is read
     * and prepared exactly as before.
     */
    excludeAccountIds?: ReadonlySet<string>,
  ): Promise<{ credentials: MinimaxCodeCredentials; accountId: string | undefined }> {
    const pool = this.options.accountPool
    if (pool !== undefined) {
      const effective = await pool.getEffectiveCredential(excludeAccountIds, fetchFn)
      return { credentials: effective.credentials, accountId: effective.account.id }
    }
    return { credentials: await ensureAccessToken(this.store, { fetchFn, signal }), accountId: undefined }
  }

  /**
   * Renew the credential the service just refused.
   *
   * With a pool, the account that failed is the one renewed, so the rotation lands
   * on that account's own record instead of the single-credential file; without a
   * pool the store's own forced refresh is what ran before the pool existed.
   */
  private async renewCredential(
    accountId: string | undefined,
    fetchFn: typeof fetch,
    signal: AbortSignal | undefined,
    refused: string,
  ): Promise<MinimaxCodeCredentials> {
    const pool = this.options.accountPool
    if (pool !== undefined) {
      if (accountId === undefined) {
        throw new Error('the refused credential does not belong to a pooled account ' + redactToken(refused))
      }
      return await pool.renewCredential(accountId, fetchFn)
    }
    return await ensureAccessToken(this.store, { fetchFn, signal, force: true })
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
    return requestImageTargetOrOriginal(image)
  }

  /**
   * The hardcoded directory, narrowed to what the user enabled it to serve.
   *
   * Nothing is fetched: the listing route is unavailable on this endpoint, so a
   * "live catalog" would be a request that can only ever fail.
   *
   * The line-wide switch is honoured before the selection is even resolved, so
   * turning the card's switch off exposes no model at all — including the ones
   * the user left ticked, which is what "off" has to mean if it is to mean
   * anything.
   */
  async listModels(provider?: string): Promise<readonly LlmModelInfo[]> {
    const prov = provider || PROVIDER_ID
    const settings = await this.settings()
    if (settings.enabled === false) return []
    const enabled = new Set(resolveMinimaxCodeEnabledModelIds(settings.enabledModelIds, true))
    return MINIMAX_CODE_MODELS
      .filter((model) => enabled.has(model.id))
      .map((model) => ({
        provider: prov,
        id: model.id,
        name: model.name,
        inputModalities: [...model.inputModalities],
      }))
  }

  /**
   * One model's resolved metadata, read through the current selection.
   *
   * The effective context window is the override when one is saved, and the
   * wire output cap is sized against that same number in requestStream. It is
   * deliberately not exposed as a fixed defaultMaxTokens reservation here.
   */
  async resolveModel(provider: string, modelId: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted === true) throw new LlmError('MiniMax Code model resolution aborted', 'ABORTED')
    const settings = await this.settings()
    const entry = minimaxCodeModelDef(modelId)
    // `default` is not a strength level: it is the absence of one, and
    // ranking it above `max` made DSH's picker present it as the strongest
    // thinking level. A model that offers no `defaultEffort` already says
    // "the caller picked nothing", which is the same thing.
    //
    // Since the re-baseline it is not a level at all: the vocabulary has no
    // such member (the upstream models.dev snapshot names none, and neither
    // does the harness's own ladder), so the strength table below is the whole
    // list of levels this line can put on the wire.
    const efforts = orderReasoningEfforts(effortsForModel(modelId), ['low', 'medium', 'high', 'xhigh', 'max'])
    const contextWindow = contextWindowForModel(modelId, settings.contextWindowOverrides)
    const defaultEffort = entry === undefined
      ? undefined
      : resolveDefaultEffort(entry, settings.defaultReasoningEffort)
    return {
      provider,
      id: modelId,
      name: entry?.name ?? modelId,
      inputModalities: modalitiesForModel(modelId),
      context: { contextWindow },
      // Do not materialize the wire ceiling as a fixed DSH output reservation:
      // on M2.7 it leaves too little budget for compaction. requestStream applies
      // the dynamic cap instead, while preserving explicit caller maxTokens - the
      // one exception being a model whose thinking cannot be turned off, where a
      // cap below the forced-thinking floor returns an empty answer and
      // floorForcedThinkingTokens raises it (see the mapper).
      ...(efforts.length === 0
        ? {}
        : {
            reasoning: {
              efforts: efforts.map((effort) => ({ id: ReasoningEffortId(effort), name: effort })),
              ...(defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultEffort) }),
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

  /**
   * One request, with the line's default reasoning effort materialized.
   *
   * A caller that states an effort is passed through untouched: DSH materializes
   * {@link resolveModel}'s default into the options for a picker-driven turn, so
   * a value arriving here is a deliberate choice and must not be replaced. Only
   * an unstated one is filled in, and only when the user actually configured a
   * global level — the shipped default is "say nothing", because the model has
   * its own and restating it in every body is a chance to disagree with it.
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const settings = await this.settings()
    const configured = settings.defaultReasoningEffort
    const effort = options.reasoningEffort ?? (configured === null ? undefined : configured)
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
    const settings = await this.settings()
    const entry = minimaxCodeModelDef(options.model)
    // The same reader the card and resolveModel use, so an overridden window is
    // the one the request is actually sized against. Reading the catalog here
    // would make the override a display-only setting: the user would see a larger
    // window on the card while every request kept being clamped to the old one.
    const contextWindow = contextWindowForModel(options.model, settings.contextWindowOverrides)

    // DSH delivers pasted images as durable references because this route declares
    // image input; the bytes are resolved once here and reused for the one request
    // below. The oldest images are dropped first when the request would exceed the
    // route's own image budget.
    //
    // The budget is passed in rather than inherited. The mechanism is Kimi's
    // (measure, drop oldest-first, leave durable history alone) and that is
    // shared on purpose, but Kimi's 1.5 MB NUMBER is sized for Kimi's 2 MB
    // request limit; over here it replaced a single ordinary 10 MB MiniMax image
    // with a placeholder and said nothing. See maxRequestImageBytes in ./types.ts.
    // The byte budget is the only attachment ceiling this route applies. The
    // catalog also carries a per-model attachment count, but a live probe
    // against the subscription endpoint served 48 inline images on M3 without
    // complaint, so that number describes the FILES API (which this line does not
    // implement) rather than the inline path. Enforcing it here would drop
    // images the service accepts for free. See maxAttachments in ./model-catalog.
    // Video has its own, much larger budget and its own offload pass, run
    // before the image one: a single clip dwarfs the whole image allowance, and
    // dropping clips and images in the same pass would make which one survived
    // depend on the order of two unrelated ceilings.
    const requestOptions = offloadOldestRequestVideos(
      offloadOldestRequestImages(normalizeGenerateOptions(options), maxRequestImageBytes()),
      MAX_REQUEST_VIDEO_BYTES,
    ) as NormalizedGenerateOptions
    const [images, videos] = await Promise.all([
      resolveRequestImages(requestOptions, this.options.attachments, signal),
      resolveRequestVideos(requestOptions, this.options.videos, signal),
    ])

    // The cap tracks the window so a long reasoning turn is not cut off by a fixed
    // ceiling, and is reduced when the caller's prompt is large enough that prompt
    // plus output would not fit. Passing the estimate is what makes the clamp do
    // anything at all: without it the call is a no-op that always returns the
    // requested cap, and the service rejects the request instead of it being clamped
    // here.
    // A caller may ask for a cap smaller than this line's forced thinking needs -
    // the session-title call asks for one short line - which returns an empty text
    // block and a max-tokens finish. Raise that cap before clamping so the caller
    // gets an answer; a caller stating a larger cap is passed through untouched.
    //
    // Computed once, above the rotation: it is a function of the model, the
    // request and the window only, so no account can change the answer and
    // recomputing it per round would buy nothing.
    const flooredMax = floorForcedThinkingTokens(options.model, requestOptions.maxTokens)
    const requestedMax = flooredMax ?? maxOutputTokensFor(options.model, contextWindow)
    const effectiveMax = clampOutputToContext(requestedMax, contextWindow, estimatedInputTokens(requestOptions))

    // Account rotation, the same shape every sibling line already has
    // (command-code:421/426, kimi-code:767): one round per account that gets to
    // try this request.
    //
    // `tried` is what makes the loop terminate. The pool must not hand back an
    // account that has already been refused during THIS request, or a rate-limited
    // account would simply be selected again and the loop would spin on a verdict
    // it already has. It is also what `hasAnotherAvailableAccount` is asked
    // against at the bottom: "is there an account left that this turn has not
    // already burned", not "is the pool non-empty".
    const tried = new Set<string>()
    //
    // The pool account the answer came from, and the credential and auth owner
    // that go with it. Hoisted ABOVE the loop because everything after the rotation
    // has to name the account that produced the answer, not merely that some
    // account did: `authOwner` is carried into the stream state, and the refusal
    // below redacts that account's own token.
    let credentials: MinimaxCodeCredentials
    let authOwner: string
    // The pool account this request is being served by, when there is a pool. It
    // is what makes the 401 recovery below renew the account that actually failed
    // rather than whatever the single-credential file happens to hold. Absent means
    // the single-credential line, which has no account to cool and must behave
    // exactly as it did before any pool existed.
    let accountId: string | undefined
    let response: Response
    //
    // Hoisted beside them because BOTH account-level failure paths below need it —
    // the non-2xx response and the in-band error event — and the second is inside
    // the streaming loop, far from any request setup.
    const pool = this.options.accountPool

    while (true) {
      try {
        // Every round asks for a DIFFERENT account: the accounts this request has
        // already tried are handed to the pool as the exclusion set, so the
        // selection cannot return one this turn has already been refused by.
        // Without a pool this is the one stored credential, read and renewed
        // exactly as it always was.
        const selection = await this.acquireCredential(fetchFn, signal, pool === undefined ? undefined : tried)
        credentials = selection.credentials
        accountId = selection.accountId
      } catch (error) {
        if (error instanceof MinimaxCodeUnauthorizedError) {
          throw new LlmError(error.message, 'INVALID_CREDENTIAL', { cause: error })
        }
        throw new LlmError(
          PROVIDER_NAME + ' credential could not be prepared: '
          + (error instanceof Error ? error.message : String(error)),
          'MISSING_CREDENTIAL',
          { cause: error },
        )
      }
      if (accountId !== undefined) tried.add(accountId)

      authOwner = computeMinimaxAuthOwner(credentials, accountId)

      // Media that cannot be encoded inline is uploaded and referenced instead.
      // Runs after the account is selected, because a file id minted by one pooled
      // account is not assumed readable by another.
      //
      // Repeated per round for exactly that reason. uploadOversizedMedia hands
      // THIS account's access token and account key to the Files API
      // (see the upload call inside it), so a round replayed against a second
      // account must re-derive the uploads with that second account's own
      // credential: a body still pointing at the first account's file ids would
      // ask the new account to read files it cannot see. It is a pure function of
      // a requestOptions it does not mutate, so re-running it per round costs
      // nothing beyond the transfer itself.
      const withUploads = await uploadOversizedMedia(
        requestOptions,
        images,
        videos,
        credentials,
        accountId,
        this.options.fetchFn ?? fetch,
        signal,
      )

      const buildBodyForOwner = (owner: string): string => {
        const built = buildMinimaxRequest(
          { ...withUploads, maxTokens: effectiveMax },
          images,
          {
            cacheControl: true,
            videos,
            videoAccepted: minimaxCodeModelDef(options.model)?.inputModalities.includes('video') === true,
            authOwner: owner,
            route: PROVIDER_ID,
          },
        )
        return assertRequestBodyFits(built)
      }

      let body = buildBodyForOwner(authOwner)

      // The 401 recovery. Deliberately its own loop, and deliberately NOT the
      // rotation above — the two answer different questions and must never share a
      // counter.
      //
      // This one asks "is the credential I just presented stale?", and the answer is
      // fixed for THIS account: renewing it and replaying the same body is the
      // whole remedy. Rotation asks "is there a different account left?", and the
      // answer is about the pool. Sharing a counter would make a 401 that survives
      // its own renewal silently turn into a new account on the next pass, so an
      // account whose refresh is genuinely broken would walk the pool instead of
      // reporting why it cannot sign in — and, worse, a rotation would consume the
      // single retry budget a stale token is entitled to.
      //
      // At most one recovery attempt, per account. A 401 has two possible causes
      // that the status alone cannot separate: the stored token is stale in a way the
      // local clock did not see (a token revoked in the MiniMax Code app, a clock
      // skew, a rotation the app performed), or the credential genuinely needs a new
      // sign-in. So the first 401 forces exactly one refresh and retries the same
      // body once — the `force` option exists for this and is otherwise never used
      // on this line. If the retry is also rejected, the failure is final and
      // reported to the user.
      //
      // `attempt` is scoped to this round, so a round that follows a rotation gets
      // its own single recovery for the account it is now serving.
      //
      // The refused response's body, captured rather than discarded. Two places in
      // this round need this exact text and a Response body is a one-shot stream:
      // the gate below must know whether a 403 names a spent window (only the body
      // says), and the non-ok branch below classifies the very same text into the
      // verdict the user is shown. Read twice, the second read comes back EMPTY —
      // and an empty body is not a shorter verdict, it is a DIFFERENT one, because
      // the classifier then falls through to its empty-body defaults. So the text is
      // taken once, kept here, and handed down.
      let refusedBody: string | undefined
      for (let attempt = 0; ; attempt += 1) {
        try {
          response = await fetchWithContextBudgetRecovery(fetchFn)(messagesUrl(credentials.region), {
            method: 'POST',
            headers: modelRequestHeaders(credentials.accessToken),
            body,
            signal,
          })
        } catch (error) {
          if (signal.aborted) throw new LlmError('MiniMax Code request aborted', 'ABORTED', { cause: error })
          throw new LlmError(
            PROVIDER_NAME + ' request failed: ' + (error instanceof Error ? error.message : String(error)),
            'TRANSPORT',
            { cause: error },
          )
        }

        // This attempt's response is a different body from the previous attempt's,
        // so whatever the previous one said says nothing about this one.
        refusedBody = undefined

        if (response.ok) break
        if (attempt > 0 || (response.status !== 401 && response.status !== 403)) break

        // Drain the refused response so the connection is reusable, then renew.
        // The account is NOT changed here: renewCredential renews precisely the one
        // that was refused, which is what keeps this a same-account recovery.
        //
        // The drained text is kept instead of thrown away: it is the same body the
        // non-ok branch below has to classify, and a body that has already been read
        // cannot be read again (see `refusedBody` above).
        refusedBody = await response.text().catch(() => '')

        // A 403 whose OWN body names a spent window is not a stale token, and the one
        // remedy this loop has — renew and replay the same body — cannot touch a
        // window that stays spent until it resets. Renewing it spent real things:
        //
        //  · a native account's renewal writes the new pair straight back into the
        //    desktop app's own auth.json (account-pool.ts:456-468), so a quota verdict
        //    was overwriting the user's own sign-in for nothing;
        //  · every such 403 bought a full token round trip before the rotation below
        //    could take over, once per account, on every turn that meets a window.
        //
        // So the verdict is read HERE, before the renewal it does not deserve, and the
        // response falls through to the branch below — where the cooldown and the
        // rotation already exist — rather than being reimplemented here.
        //
        // Gated on the pool deliberately. Without one there is no second account to
        // reach, and the single-credential line keeps the posture it has always had:
        // one forced renewal on ANY 401 or 403, one replay, one classified throw, and
        // the stored credential left exactly where the line itself put it.
        //
        // The 403 lives inside isSpentWindow403 and that is the reason no 401 can be
        // diverted here however its body reads — on this route a 401 IS the
        // credential, full stop.
        if (pool !== undefined && accountId !== undefined && isSpentWindow403(response.status, refusedBody)) break

        const refused = credentials.accessToken
        try {
          credentials = await this.renewCredential(accountId, fetchFn, signal, refused)
          authOwner = computeMinimaxAuthOwner(credentials, accountId)
          body = buildBodyForOwner(authOwner)
        } catch (error) {
          // The refresh itself failed: that verdict is the one to report, because it
          // names why the credential can no longer be renewed.
          if (error instanceof MinimaxCodeUnauthorizedError) {
            throw new LlmError(error.message, 'INVALID_CREDENTIAL', { cause: error })
          }
          throw new LlmError(
            PROVIDER_NAME + ' credential could not be renewed after the service refused '
            + redactToken(refused) + ': ' + (error instanceof Error ? error.message : String(error)),
            'INVALID_CREDENTIAL',
            { cause: error },
          )
        }
      }

      // The account served this turn. Everything from here on — the body this
      // response carried, the auth owner in the stream state, the token named in
      // the refusal below — belongs to it, so the rotation stops here rather than
      // re-issuing the request against somebody else.
      if (response.ok) break

      // `refusedBody` is this response's own body when the gate above read it to
      // classify a 403, and undefined otherwise — in which case this is that body's
      // first and only read. Either way the verdict below is read off the REAL body;
      // it can never see an already-drained ''.
      const detail = (refusedBody ?? await response.text().catch(() => '')).slice(0, 2_000)
      const failure = classifyMinimaxFailure(response.status, detail)
      const after = response.status === 429 ? retryAfterMs(response.headers) : undefined
      // The pool reaction every sibling line already gives this response. Without
      // it the line never cooled anything and never rotated, so once one account's
      // Token Plan ran out EVERY later request kept being served by that same
      // account — the pool existed, selected it each time, and had no way to learn
      // it had been refused.
      //
      // A 429 always names an account here, and a 403 does whenever its body said
      // the window is spent; a 400 or a 5xx is about the request (or about every
      // account behind this plan at once), and cooling on those would empty the
      // pool over one bad turn.
      if (pool !== undefined && accountId !== undefined) {
        // Whether this verdict is a SPENT WINDOW, as against every other verdict
        // that is also this account's own.
        //
        // accountScoped cannot answer that by itself: the 401/403 credential branch
        // sets it too (see classifyMinimaxFailure), and cooling or rotating on THAT
        // is how one unusable token walks the whole pool. What separates the two is
        // the code the classifier chose - a spent window is PROVIDER_ERROR, a refused
        // credential is INVALID_CREDENTIAL - the same distinction the sibling line
        // draws from the same field (kimi-code/adapter.ts:848-862).
        const spentWindow = failure.accountScoped && failure.code !== 'INVALID_CREDENTIAL'
        // The status is the OUTER test, so no 401 can reach this branch however its
        // body reads: on this route a 401 means the credential, full stop.
        if (response.status === 429 || (response.status === 403 && spentWindow)) {
          await pool.markCooldown(
            accountId,
            // A spent window is this account's own and stays spent, so it takes the
            // window's length; plain back-pressure is the Retry-After the service
            // itself stated, and the shared 15-minute default when it states none.
            failure.accountScoped ? quotaCooldownMs(detail) : after ?? POOL_COOLDOWN_MS,
            PROVIDER_NAME + (response.status === 429 ? ' 429' : ' 403'),
          ).catch(() => undefined)
          // The refusal ends THIS account's part of the turn, not the turn: another
          // account can still serve the very same request, and the loop above rebuilds
          // everything that is per-account (credential, uploads, body) for it. This
          // is the step that makes a pooled line behave like its seven siblings —
          // before it, a spent window ended the request outright and the user was
          // shown the first account's refusal even though the pool had an account
          // left that could answer. When no other account is available the verdict
          // falls through unchanged, so the last refusal is still what the user is
          // shown.
          if (await pool.hasAnotherAvailableAccount(tried)) continue
        }
      }
      // The rejected credential is named only in redacted form, and only when one
      // was rejected: the refresh path has already been asked to renew it (see
      // above), so this is the service's final verdict rather than a stale token
      // being re-presented. Keyed off the classification rather than the status, so
      // the 403 that names a spent window does not go on to blame the token it was
      // just refused for.
      const hint = failure.code === 'INVALID_CREDENTIAL'
        ? ' (credential ' + redactToken(credentials.accessToken) + ')'
        : ''
      throw new LlmError(failure.message + hint, failure.code, {
        status: response.status,
        ...(after === undefined ? {} : { providerRetryAfterMs: after }),
      })
    }

    if (response.body === null) {
      throw new LlmError(PROVIDER_NAME + ' returned an empty response body', 'PROVIDER_ERROR')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const state = createStreamState({
      model: options.model,
      authOwner,
      route: PROVIDER_ID,
      provider: PROVIDER_ID,
    })
    let buffer = ''
    /**
     * Set the moment ANY chunk reaches the caller, and never cleared.
     *
     * Deliberately broader than "a content delta or a tool block": a retry would
     * duplicate a block-start the caller has already seen just as surely, so the
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
            // One pulse per complete frame; `lines` holds only frames already closed
            // by a newline, and a pure comment frame (": ping", ": keep-alive") is
            // exactly the case the display-layer timer used to misread as silence.
            activity?.pulse()
            for (const chunk of processMinimaxStreamLine(line, state)) {
              outputStarted = true
              yield chunk
            }
            if (state.finished) return
          }
        }

        buffer += decoder.decode()
        if (buffer.trim() !== '') {
          for (const line of buffer.split('\n')) {
            for (const chunk of processMinimaxStreamLine(line, state)) {
              outputStarted = true
              yield chunk
            }
          }
        }
        if (state.finished) return

        // A connection that ends without a terminal event is a truncated stream, not
        // a completed answer.
        assertStreamComplete(state)
        for (const chunk of closeMinimaxStream(state)) {
          outputStarted = true
          yield chunk
        }
      } catch (error) {
        // A verdict the mapper already typed (a truncated stream, an in-band error
        // event) is passed through - except an in-band error event that arrived
        // before anything reached the caller, which is classified through this
        // line's OWN failure classifier so every rule the HTTP path owns still
        // owns it. After the first chunk the mapper's verdict stands: a retry
        // would repeat output the user has already seen.
        // PROVIDER_ERROR alone is eligible: a CONTEXT OVERFLOW the mapper typed
        // here is the harness's compaction signal, and rewriting it into a
        // retryable SERVER would discard that recovery while the request keeps
        // failing identically. The code the mapper chose decides this, not the
        // type the wire happened to carry.
        if (error instanceof LlmError && !outputStarted && error.code === 'PROVIDER_ERROR' && state.streamError !== undefined) {
          const reclassified = reclassifyInBandError(error, state.streamError, classifyMinimaxFailure)
          // Reclassification and the pool reaction are separate because they answer
          // different questions about the same classification: the code decides
          // whether the harness retries, accountScoped decides whether a retry is
          // worth taking anywhere else. The mapper can supply only the first, which
          // is why the wire object is recorded there and read here.
          //
          // The body is the one a non-2xx response would have carried, so a limit
          // cannot mean one thing as a status and another as an event. The request
          // itself is NOT re-issued — its body is open and part-read — so cooling
          // the account is the whole of what can be done here, and it is what makes
          // the harness retry land on an account that can answer.
          if (pool !== undefined && accountId !== undefined) {
            const inBandBody = JSON.stringify({ error: state.streamError })
            const status = inBandAnthropicStatus(state.streamError)
            // A type this vocabulary does not name classifies to nothing, so there
            // is no verdict to weigh against the pool and nothing is cooled.
            if (status === 429) {
              const failure = classifyMinimaxFailure(status, inBandBody)
              await pool.markCooldown(
                accountId,
                // No Retry-After exists here: there is no 429 response left to read
                // one from, and a delay stated on the 200 belongs to a different
                // message. Same rule the HTTP branch reads, same fields.
                failure.accountScoped ? quotaCooldownMs(inBandBody) : POOL_COOLDOWN_MS,
                PROVIDER_NAME + ' in-stream 429',
              ).catch(() => undefined)
            }
          }
          throw reclassified
        }
        throw error
      }
    } finally {
      void reader.cancel().catch(() => undefined)
    }
  }
}

export { PROVIDER_ID, MinimaxCodeCredentialStore }
export { maxOutputTokensFor, clampOutputToContext }
