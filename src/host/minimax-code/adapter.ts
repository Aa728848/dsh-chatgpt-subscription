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
import type {} from '@deepseek-ai/dsh-attachment'
import {
  DEFAULT_CONTEXT_WINDOW,
  PROVIDER_ID,
  PROVIDER_NAME,
  STREAM_IDLE_TIMEOUT_CODE,
  STREAM_IDLE_TIMEOUT_MS,
  messagesUrl,
  redactToken,
} from './types.ts'
import { MINIMAX_CODE_MODELS, minimaxCodeModelDef } from './model-catalog.ts'
import {
  MinimaxCodeCredentialStore,
  type MinimaxCodeCredentials,
} from './token-store.ts'
import {
  MinimaxCodeUnauthorizedError,
  ensureAccessToken,
} from './oauth.ts'
import { modelRequestHeaders, summarizeFailureBody } from './client.ts'
import {
  assertRequestBodyFits,
  assertStreamComplete,
  buildMinimaxRequest,
  clampOutputToContext,
  closeMinimaxStream,
  createStreamState,
  estimatedInputTokens,
  maxOutputTokensFor,
  offloadOldestRequestImages,
  processMinimaxStreamLine,
  resolveRequestImages,
  type AttachmentImageReader,
} from './mapper.ts'
import { normalizeGenerateOptions, type GenerateOptions as NormalizedGenerateOptions } from '../common/llm-compat.ts'
import { wrapStreamWithWatchdog } from '../common/idle-watchdog.ts'
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
}

/**
 * Body text the service uses for an account-level refusal that retrying cannot fix.
 *
 * The status alone cannot separate these from ordinary back-pressure, so the body
 * is read rather than trusted: a 429 whose text names a spent balance is a verdict,
 * and retrying it only delays the message the user needs to see.
 */
const QUOTA_EXHAUSTED_PATTERNS = [
  /insufficient/i,
  /balance/i,
  /quota/i,
  /arrears/i,
  /recharge/i,
  /exceeded/i,
]

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text))
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

  if (status === 401 || status === 403) {
    return {
      code: 'INVALID_CREDENTIAL',
      retryable: false,
      message: PROVIDER_NAME + ' rejected the stored credential (' + status + '). Sign in again in the '
        + 'MiniMax Code app, then reopen this card.'
        + (detail === '' ? '' : ' ' + detail),
    }
  }

  if (status === 429) {
    if (matchesAny(detail, QUOTA_EXHAUSTED_PATTERNS)) {
      return {
        code: 'PROVIDER_ERROR',
        retryable: false,
        message: PROVIDER_NAME + ' reports the account quota is exhausted: '
          + (detail === '' ? 'no remaining quota' : detail)
          + '. Top up or wait for the window to reset.',
      }
    }
    return {
      code: 'RATE_LIMIT',
      retryable: true,
      message: PROVIDER_NAME + ' is rate limited or overloaded (429): '
        + (detail === '' ? 'too many requests' : detail) + '. Retrying with backoff.',
    }
  }

  if (status >= 500) {
    return {
      code: 'SERVER',
      retryable: true,
      message: PROVIDER_NAME + ' upstream server error (' + status + '): '
        + (detail === '' ? 'the model provider is temporarily unavailable' : detail)
        + '. Retrying with backoff.',
    }
  }

  if (status === 400) {
    return {
      code: 'PROVIDER_ERROR',
      retryable: false,
      message: PROVIDER_NAME + ' rejected the request (400): '
        + (detail === '' ? 'the request was not accepted' : detail),
    }
  }

  return {
    code: 'PROVIDER_ERROR',
    retryable: false,
    message: PROVIDER_NAME + ' API error (' + status + '): ' + (detail === '' ? 'No response' : detail),
  }
}

export interface MinimaxCodeAdapterOptions {
  fetchFn?: typeof fetch
  /** Attachment seam: verified bytes for one durable image. */
  attachments?: AttachmentImageReader
}

/** The reasoning levels one model advertises, from the hardcoded directory. */
function effortsForModel(modelId: string): string[] {
  return [...(minimaxCodeModelDef(modelId)?.reasoningEfforts ?? [])]
}

/** Input modalities one model accepts, defaulting to text when it is unknown. */
function modalitiesForModel(modelId: string): Array<'text' | 'image' | 'video'> {
  return [...(minimaxCodeModelDef(modelId)?.inputModalities ?? ['text'])]
}

/** Configured effort when the model lists it, else nothing. */
function resolveDefaultEffort(efforts: readonly string[], configured: string | null | undefined): string | undefined {
  if (configured === null || configured === undefined) return undefined
  return efforts.includes(configured) ? configured : undefined
}

export class MinimaxCodeAdapter extends LlmAdapter {
  // Declared and assigned explicitly rather than as constructor parameter
  // properties: Node's type-stripping loader rejects a parameter property
  // outright, and this package is imported directly by tooling that runs
  // TypeScript as-is.
  private readonly store: MinimaxCodeCredentialStore
  private readonly options: MinimaxCodeAdapterOptions

  constructor(
    store: MinimaxCodeCredentialStore = new MinimaxCodeCredentialStore(),
    options: MinimaxCodeAdapterOptions = {},
  ) {
    super()
    this.store = store
    this.options = options
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

  /**
   * The hardcoded directory, narrowed to the ids the subscription serves.
   *
   * Nothing is fetched: the listing route is unavailable on this endpoint, so a
   * "live catalog" would be a request that can only ever fail.
   */
  async listModels(provider?: string): Promise<readonly LlmModelInfo[]> {
    const prov = provider || PROVIDER_ID
    return MINIMAX_CODE_MODELS.map((model) => ({
      provider: prov,
      id: model.id,
      name: model.name,
      inputModalities: [...model.inputModalities],
    }))
  }

  async resolveModel(provider: string, modelId: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted === true) throw new LlmError('MiniMax Code model resolution aborted', 'ABORTED')
    const entry = minimaxCodeModelDef(modelId)
    const efforts = effortsForModel(modelId)
    const defaultEffort = resolveDefaultEffort(efforts, entry?.defaultReasoningEffort)
    return {
      provider,
      id: modelId,
      name: entry?.name ?? modelId,
      inputModalities: modalitiesForModel(modelId),
      context: { contextWindow: entry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: maxOutputTokensFor(modelId),
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

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return wrapStreamWithWatchdog(
      (watchdogSignal) => this.requestStream(options, watchdogSignal),
      options.signal,
      STREAM_IDLE_TIMEOUT_MS,
      STREAM_IDLE_TIMEOUT_CODE,
      PROVIDER_NAME,
    )
  }

  private async *requestStream(options: GenerateOptions, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    const fetchFn = this.options.fetchFn ?? fetch
    const entry = minimaxCodeModelDef(options.model)
    const contextWindow = entry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW

    // DSH delivers pasted images as durable references because this route declares
    // image input; the bytes are resolved once here and reused for the one request
    // below. The oldest images are dropped first when the request would exceed the
    // route's own image budget.
    const requestOptions = offloadOldestRequestImages(normalizeGenerateOptions(options)) as NormalizedGenerateOptions
    const images = await resolveRequestImages(requestOptions, this.options.attachments, signal)

    // The cap tracks the window so a long reasoning turn is not cut off by a fixed
    // ceiling, and is reduced when the caller's prompt is large enough that prompt
    // plus output would not fit. Passing the estimate is what makes the clamp do
    // anything at all: without it the call is a no-op that always returns the
    // requested cap, and the service rejects the request instead of it being clamped
    // here.
    const requestedMax = requestOptions.maxTokens ?? maxOutputTokensFor(options.model, contextWindow)
    const built = buildMinimaxRequest(
      { ...requestOptions, maxTokens: clampOutputToContext(requestedMax, contextWindow, estimatedInputTokens(requestOptions)) },
      images,
    )
    const body = assertRequestBodyFits(built)

    let credentials: MinimaxCodeCredentials
    try {
      credentials = await ensureAccessToken(this.store, { fetchFn, signal })
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

    let response: Response
    // At most one recovery attempt. A 401 has two possible causes that the status
    // alone cannot separate: the stored token is stale in a way the local clock did
    // not see (a token revoked in the MiniMax Code app, a clock skew, a rotation the
    // app performed), or the credential genuinely needs a new sign-in. So the first
    // 401 forces exactly one refresh and retries the same body once — the
    // `force` option exists for this and is otherwise never used on this line. If
    // the retry is also rejected, the failure is final and reported to the user.
    for (let attempt = 0; ; attempt += 1) {
      try {
        response = await fetchFn(messagesUrl(credentials.region), {
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

      if (response.ok) break
      if (attempt > 0 || (response.status !== 401 && response.status !== 403)) break

      // Drain the refused response so the connection is reusable, then renew.
      await response.text().catch(() => '')
      const refused = credentials.accessToken
      try {
        credentials = await ensureAccessToken(this.store, { fetchFn, signal, force: true })
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

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 2_000)
      const failure = classifyMinimaxFailure(response.status, detail)
      const after = response.status === 429 ? retryAfterMs(response.headers) : undefined
      // The rejected credential is named only in redacted form. The refresh path
      // has already been asked to renew it (see above), so this is the service's
      // final verdict rather than a stale token being re-presented.
      const hint = response.status === 401 || response.status === 403
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
    const state = createStreamState()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          for (const chunk of processMinimaxStreamLine(line, state)) yield chunk
          if (state.finished) return
        }
      }

      buffer += decoder.decode()
      if (buffer.trim() !== '') {
        for (const line of buffer.split('\n')) {
          for (const chunk of processMinimaxStreamLine(line, state)) yield chunk
        }
      }
      if (state.finished) return

      // A connection that ends without a terminal event is a truncated stream, not
      // a completed answer.
      assertStreamComplete(state)
      for (const chunk of closeMinimaxStream(state)) yield chunk
    } finally {
      void reader.cancel().catch(() => undefined)
    }
  }
}

export { PROVIDER_ID, MinimaxCodeCredentialStore }
export { maxOutputTokensFor, clampOutputToContext }
