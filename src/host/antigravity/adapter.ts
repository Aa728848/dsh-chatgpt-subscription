import { CONTEXT_OVERFLOW_CODE, isHttpContextOverflow } from '../common/context-overflow.ts'
import { outputReservation } from '../common/output-reservation.ts'
import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  errorChain,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type PreparedAdapterCall,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  MODELS,
  PROVIDER_ID,
  PROVIDER_NAME,
  ROUTING,
  STREAM_IDLE_TIMEOUT_CODE,
  STREAM_IDLE_TIMEOUT_MS,
  TOOL_CALLING_MODE,
  type AntigravityModelDef,
} from './types.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  type AntigravityCatalogModel,
  type AntigravityPreferenceStore,
} from './token-store.ts'
import { ensureApiKey } from './oauth.ts'
import { antigravityHeaders, endpointCandidates } from './client.ts'
import { catalogMaxOutputFor, effectiveModelLimits } from './catalog-limits.ts'
import {
  buildRequest,
  closeStream,
  createStreamState,
  offloadOldestRequestImages,
  processStreamLine,
  requestImageTarget,
  resolveRequestImages,
  type AttachmentImageReader,
} from './mapper.ts'
import { normalizeGenerateOptions } from '../common/llm-compat.ts'
import { wrapStreamWithWatchdog, type StreamActivity } from '../common/idle-watchdog.ts'
import { recordCacheRequest, recordCacheUsage } from './cache-stats.ts'

export function resolveDefaultReasoningEffort(
  efforts: readonly string[],
  configuredEffort?: string | null,
): ReasoningEffortId | undefined {
  if (configuredEffort && efforts.includes(configuredEffort)) {
    return ReasoningEffortId(configuredEffort)
  }
  if (efforts.includes('medium')) {
    return ReasoningEffortId('medium')
  }
  if (efforts.includes('low')) {
    return ReasoningEffortId('low')
  }
  if (efforts.length > 0) {
    return ReasoningEffortId(efforts[0])
  }
  return undefined
}

import { AccountPoolStore, quotaFamilyForModel } from './account-pool.ts'

/** How much of an upstream error body is quoted back to the user. */
const MAX_UPSTREAM_BODY_CHARS = 500

/**
 * The upstream error body, short enough to read in a notice.
 *
 * A 429 body is small when the service states a reset time in it and can be an
 * arbitrary blob when it does not, so the excerpt is what a notice carries.
 */
export function upstreamBodyExcerpt(body: string): string {
  const text = body.trim()
  return text.length > MAX_UPSTREAM_BODY_CHARS ? `${text.slice(0, MAX_UPSTREAM_BODY_CHARS)}…` : text
}

/**
 * Milliseconds in one duration string: protobuf JSON (`"12.5s"`) or Go form
 * (`"1h2m3.5s"`, `"373.8ms"`). Undefined when the string is neither.
 */
export function parseDurationMs(value: string): number | undefined {
  const text = value.trim()
  if (!/^(?:\d+(?:\.\d+)?(?:h|ms|m|s|us|µs|ns))+$/.test(text)) return undefined
  const unitMs: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000, ms: 1, us: 0.001, µs: 0.001, ns: 0.000001 }
  let total = 0
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s|us|µs|ns)/g)) {
    total += Number(match[1]) * unitMs[match[2]!]!
  }
  return Number.isFinite(total) ? total : undefined
}

/**
 * How long one 429 says to wait, or undefined when it does not say.
 *
 * Google states the reset in the error body rather than in `Retry-After`:
 * `ErrorInfo.metadata.quotaResetTimeStamp` (an instant) and `quotaResetDelay`
 * (a Go duration) for a spent allowance, `RetryInfo.retryDelay` for a short
 * rate limit. Reading only the header made every Antigravity 429 fall back to
 * the flat 15 minutes, whether the allowance reset in two seconds or in five
 * hours. The most specific statement wins; the header is the last resort.
 */
export function retryDelayMs(headers: Headers, body: string, now = Date.now()): number | undefined {
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { parsed = undefined }
  const root = Array.isArray(parsed) ? parsed[0] : parsed
  const error = typeof root === 'object' && root !== null ? (root as { error?: unknown }).error : undefined
  const details = typeof error === 'object' && error !== null && Array.isArray((error as { details?: unknown }).details)
    ? (error as { details: unknown[] }).details
    : []

  let resetAt: number | undefined
  let resetDelay: number | undefined
  let retryDelay: number | undefined
  for (const detail of details) {
    if (typeof detail !== 'object' || detail === null) continue
    const record = detail as Record<string, unknown>
    const metadata = typeof record.metadata === 'object' && record.metadata !== null
      ? record.metadata as Record<string, unknown>
      : undefined
    if (typeof metadata?.quotaResetTimeStamp === 'string') {
      const at = Date.parse(metadata.quotaResetTimeStamp)
      if (Number.isFinite(at)) resetAt = at
    }
    if (typeof metadata?.quotaResetDelay === 'string') resetDelay = parseDurationMs(metadata.quotaResetDelay)
    if (typeof record.retryDelay === 'string') retryDelay = parseDurationMs(record.retryDelay)
  }
  if (resetAt !== undefined && resetAt > now) return resetAt - now
  if (resetDelay !== undefined && resetDelay > 0) return resetDelay
  if (retryDelay !== undefined && retryDelay > 0) return retryDelay

  const header = headers.get('retry-after')
  const seconds = header ? Number(header) : NaN
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
}

/**
 * Land one stream chunk's usage on its session's cache totals.
 *
 * The adapter is the only place that still knows the request's session and the
 * account that served it by the time the terminal chunk arrives: usage is
 * emitted from the mapper's stream state, which carries neither. Chunks of every
 * other type pass through untouched, and the mapper is left alone.
 *
 * The mapper counts cached and fresh prompt tokens separately
 * (`cacheReadTokens` / `inputTokens`), which is exactly the split these totals
 * are built from, so the numbers here are the ones the harness already reported.
 */
function recordUsageChunk(chunk: StreamChunk, sessionId?: string, accountId?: string): void {
  if (chunk.type !== 'usage') return
  recordCacheUsage({
    cachedTokens: chunk.usage.cacheReadTokens ?? 0,
    freshTokens: chunk.usage.inputTokens ?? 0,
  }, sessionId, accountId)
}

/**
 * A 400 that names the tool-calling mode. Matched narrowly so an unrelated
 * validation error is reported as itself rather than retried.
 */
const VALIDATED_REJECTION = /VALIDATED|function_?calling_?config|tool_?config|tool_choice/i

/**
 * The same request body without its `toolConfig`, when that config asked for
 * VALIDATED; undefined when it did not (nothing to fall back from).
 */
export function withoutValidatedToolConfig(body: string): string | undefined {
  let parsed: { request?: { toolConfig?: { functionCallingConfig?: { mode?: unknown } } } }
  try { parsed = JSON.parse(body) } catch { return undefined }
  if (parsed.request?.toolConfig?.functionCallingConfig?.mode !== TOOL_CALLING_MODE.validated) return undefined
  delete parsed.request.toolConfig
  return JSON.stringify(parsed)
}

/**
 * The failure a stream that died mid-body is reported as.
 *
 * Everything above the response body is already typed: a connection that never
 * produced a response raises TRANSPORT, a non-2xx raises its status verdict, and
 * the mapper raises its own protocol or provider one. The body itself was the
 * gap: a connection that ends before the response does arrives as undici's bare
 * `TypeError: terminated`, which carries no code of its own, so the harness
 * normalizes it to UNKNOWN — and UNKNOWN is not a code DSH retries, so one
 * severed connection ended the long answer the user was reading with no second
 * attempt at all. The real reason (ECONNRESET, a socket closed by the far side,
 * a body timeout) sat on `.cause`, which the harness drops before the failure is
 * persisted, so the report could not even say what had happened.
 *
 * So the transport is named here and its cause chain is kept in the message, and
 * only what the route already typed is left alone: an `LlmError` is this line's
 * own verdict (an in-band provider error, a stream truncated before its terminal
 * frame), and a caller abort is a cancellation rather than a fault.
 *
 * The code is TRANSPORT even once chunks have been yielded. DSH settles a failed
 * attempt as a discarded `assistant/attempt` and starts a fresh one on retry, and
 * a tool call only runs after its stream finishes, so retrying can neither
 * repeat committed output nor re-run a tool.
 */
function streamFailure(error: unknown, signal: AbortSignal): LlmError {
  if (error instanceof LlmError) return error
  if (signal.aborted) return new LlmError('Antigravity stream aborted', 'ABORTED', { cause: error })
  const chain = errorChain(error).trim()
  const detail = chain === '' ? 'the response stream ended unexpectedly' : chain.slice(0, 500)
  return new LlmError(`Antigravity stream failed: ${detail}`, 'TRANSPORT', { cause: error })
}

export class AntigravityAdapter extends LlmAdapter {
  private readonly accountPool: AccountPoolStore
  /**
   * Set once the service refuses `functionCallingConfig.mode: VALIDATED`; from
   * then on Claude requests leave the mode unset (AUTO) for this process.
   */
  private validatedToolCallingRejected = false

  constructor(
    private readonly store = new FileCredentialStore(),
    private readonly modelSettings = new FileModelSettingsStore(),
    private readonly preferences?: AntigravityPreferenceStore,
    private readonly options: { fetchFn?: typeof fetch; attachments?: AttachmentImageReader } = {},
    accountPool?: AccountPoolStore,
  ) {
    super()
    this.accountPool = accountPool ?? new AccountPoolStore(undefined, undefined, store)
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: PROVIDER_NAME }
  }

  providerRetryPolicy(): undefined {
    return undefined
  }

  imageRequestPricing(_provider?: string, _model?: string): undefined {
    return undefined
  }

  imageRequestTarget(_provider: string, _model: string, image: ImageAttachmentRef) {
    return requestImageTarget(image) ?? { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  async listModels(provider?: string): Promise<readonly LlmModelInfo[]> {
    const prov = provider || PROVIDER_ID
    const settings = this.preferences ? this.preferences.status() : await this.modelSettings.read()
    if (settings.enabled === false) return []
    const enabledSet = new Set(settings.enabledModelIds)
    const available = MODELS.filter((m) => enabledSet.has(m.id))
    const overrides = settings.contextWindowOverrides || {}

    return available.map((model) => {
      const limits = effectiveModelLimits(model, settings.catalogModels)
      return {
        provider: prov,
        id: model.id,
        name: model.name,
        inputModalities: model.inputModalities,
        context: { contextWindow: overrides[model.id] || limits.contextWindow },
        ...outputReservation(overrides[model.id] || limits.contextWindow, limits.maxTokens),
        ...(model.reasoningEfforts ? { reasoningEfforts: model.reasoningEfforts } : {}),
      }
    })
  }

  async resolveModel(provider: string, modelId: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted) throw new LlmError('antigravity model resolution aborted', 'ABORTED')
    const model = MODELS.find((m) => m.id === modelId) || {
      id: modelId,
      name: modelId,
      inputModalities: ['text', 'image'] as Array<'text' | 'image'>,
      contextWindow: 128000,
      maxTokens: 65536,
    }

    const settings = this.preferences ? this.preferences.status() : await this.modelSettings.read()
    const overrides = settings.contextWindowOverrides || {}

    const efforts = model.reasoningEfforts || ['low', 'medium', 'high']
    const defaultEffortId = resolveDefaultReasoningEffort(efforts, settings.defaultReasoningEffort)
    const limits = effectiveModelLimits(model, settings.catalogModels)

    return {
      provider,
      id: model.id,
      name: model.name,
      inputModalities: model.inputModalities,
      context: { contextWindow: overrides[model.id] || limits.contextWindow },
      ...outputReservation(overrides[model.id] || limits.contextWindow, limits.maxTokens),
      // No `systemPromptUpdate: 'in-history'`: this route transports the system
      // prompt out of band (a fixed `systemInstruction` plus a user turn), so it
      // cannot read a later system message as the effective prompt.
      ...(model.reasoningEfforts
        ? {
            reasoning: {
              efforts: efforts.map((effort) => ({
                id: ReasoningEffortId(effort),
                name: effort,
              })),
              ...(defaultEffortId ? { defaultEffort: defaultEffortId } : {}),
            },
          }
        : {}),
    }
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const model = MODELS.find((m) => m.id === options.model) || {
      id: options.model,
      name: options.model,
      inputModalities: ['text', 'image'] as Array<'text' | 'image'>,
      contextWindow: 128000,
      maxTokens: 65536,
    }

    const settings = this.preferences ? this.preferences.status() : await this.modelSettings.read()
    const effectiveEffort = options.reasoningEffort || settings.defaultReasoningEffort || undefined
    const effectiveOptions: GenerateOptions = effectiveEffort
      ? { ...options, reasoningEffort: effectiveEffort as any }
      : options
    const catalog = settings.catalogModels
    const maxTokens = options.maxTokens ?? effectiveModelLimits(model, catalog).maxTokens

    yield* wrapStreamWithWatchdog(
      (watchdogSignal, activity) => this.requestStream({ ...effectiveOptions, maxTokens }, model, watchdogSignal, activity, catalog),
      options.signal,
      STREAM_IDLE_TIMEOUT_MS,
      STREAM_IDLE_TIMEOUT_CODE,
      'Antigravity',
    )
  }

  private async *requestStream(
    options: GenerateOptions,
    model: AntigravityModelDef,
    signal: AbortSignal,
    activity?: StreamActivity,
    catalog?: readonly AntigravityCatalogModel[],
  ): AsyncIterable<StreamChunk> {
    const fetchFn = this.options.fetchFn ?? fetch
    const effort = String(options.reasoningEffort || 'medium').toLowerCase()
    const routing = ROUTING[model.id]
    // Exactly one runtime id: a request is never retried on a different model
    // than the one the user picked (see AntigravityRoutingEntry).
    const runtimeModel = routing?.routing[effort] || routing?.defaultRequestId || model.id
    const family = quotaFamilyForModel(model.id)
    const runtimeMaxOutput = catalogMaxOutputFor(runtimeModel, catalog)

    const requestOptions = offloadOldestRequestImages(normalizeGenerateOptions(options))
    const images = await resolveRequestImages(requestOptions, this.options.attachments, signal)

    let recoveredMissingThinkingSignature = false
    let recoveredValidatedToolCalling = false
    const triedAccountIds = new Set<string>()
    let response: Response | undefined
    // The last connection-level rejection. Kept so a failure where no endpoint
    // ever answered is reported as the transport failure it is, instead of a
    // 500 no endpoint sent.
    let transportError: unknown
    // The session this request belongs to, and the pooled account the successful
    // attempt was served by. Both are read back when the stream reports usage:
    // the tokens describe a cache those two identify, and the cache is the
    // account's own, so a number without them attributes nothing.
    let statsSessionId: string | undefined = options.sessionId === undefined ? undefined : String(options.sessionId)
    let statsAccountId: string | undefined

    while (true) {
      let eff: { account: { id: string }; token: string; projectId?: string }
      try {
        eff = await this.accountPool.getEffectiveAccountFor(family, triedAccountIds, fetchFn)
      } catch (poolErr) {
        const poolData = await this.accountPool.read().catch(() => null)
        if (!poolData || poolData.accounts.length === 0) {
          const { token, projectId: defaultProj } = await ensureApiKey(this.store, fetchFn)
          eff = { account: { id: 'legacy' }, token, projectId: defaultProj }
        } else {
          throw poolErr
        }
      }

      const { account, token, projectId: defaultProj } = eff
      const projectId = defaultProj || 'antigravity-default'
      triedAccountIds.add(account.id)

      const body = JSON.stringify(buildRequest(requestOptions, model, projectId, runtimeModel, effort, images, {
        claudeValidatedToolCalling: !this.validatedToolCallingRejected,
        ...(runtimeMaxOutput === undefined ? {} : { maxOutputTokens: runtimeMaxOutput }),
      }))
      // Fingerprinted before the request goes out, so the attribution describes
      // the prefix the service actually sees. A retry through the loop below
      // re-records the same body, which reports no drift — by design.
      recordCacheRequest(body, requestOptions.sessionId)
      statsSessionId = requestOptions.sessionId === undefined ? undefined : String(requestOptions.sessionId)
      statsAccountId = account.id
      const headers = {
        ...antigravityHeaders(token),
        ...(model.id.startsWith('claude-') ? { 'anthropic-beta': 'interleaved-thinking-2025-05-14' } : {}),
      }

      // The response this attempt reports. The FIRST endpoint that answers owns
      // it: a later endpoint replaces it only when it serves the request (ok)
      // or answers 400/404, and a later 429 never replaces it.
      let firstResponse: Response | undefined
      for (const endpoint of endpointCandidates()) {
        try {
          let sentBody = body
          response = await fetchFn(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
            method: 'POST',
            headers,
            body,
            signal,
          })
          if (response.status === 400 && runtimeModel.startsWith('claude-') && !recoveredMissingThinkingSignature) {
            const diagnostic = await response.clone().text().catch(() => '')
            // Match the nested Anthropic diagnostic, not arbitrary validation errors.
            if (/messages\.\d+\.content\.\d+\.thinking\.signature: Field required/.test(diagnostic)) {
              const clean = JSON.parse(body)
              let changed = false
              clean.request.contents = clean.request.contents.map((content: { role: string; parts: Record<string, unknown>[] }) => {
                if (content.role !== 'model') return content
                const parts = content.parts.flatMap(part => {
                  if (part.thought === true) { changed = true; return [] }
                  const copy = { ...part }
                  for (const key of ['thoughtSignature', 'thought_signature', 'thinkingSignature', 'textSignature']) {
                    if (key in copy) { delete copy[key]; changed = true }
                  }
                  if (!copy.functionCall && !copy.functionResponse && !copy.inlineData && !copy.text) return []
                  return [copy]
                })
                return { ...content, parts }
              }).filter((content: { parts: unknown[] }) => content.parts.length > 0)
              if (changed) {
                recoveredMissingThinkingSignature = true
                sentBody = JSON.stringify(clean)
                response = await fetchFn(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
                  method: 'POST', headers, body: sentBody, signal,
                })
              }
            }
          }
          if (response.status === 400 && !recoveredValidatedToolCalling) {
            const plain = withoutValidatedToolConfig(sentBody)
            const diagnostic = plain === undefined ? '' : await response.clone().text().catch(() => '')
            if (plain !== undefined && VALIDATED_REJECTION.test(diagnostic)) {
              // A protocol fallback on the same model, not a model switch: the
              // request goes out again exactly as before minus the tool-calling
              // mode the service refused, and no later request sends it again.
              recoveredValidatedToolCalling = true
              this.validatedToolCallingRejected = true
              sentBody = plain
              response = await fetchFn(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
                method: 'POST', headers, body: sentBody, signal,
              })
            }
          }
          if (firstResponse === undefined) firstResponse = response
          if (response.ok || response.status === 400) break
          if (response.status === 404) break
          if (response.status === 429) {
            // A quota verdict from one endpoint is not improved by asking a
            // different one, and the prod endpoint answers every Antigravity
            // request with a permanent bare 429 that says nothing about this
            // account's allowance. The chain ends here, and the first
            // endpoint's outcome is what gets reported.
            response = firstResponse
            break
          }
          // Any other status (a 5xx): the next endpoint may still serve the
          // request, but the reported outcome stays the first endpoint's.
          response = firstResponse
        } catch (err) {
          if (signal.aborted) throw new LlmError('Antigravity request aborted', 'ABORTED', { cause: err })
          transportError = err
        }
      }

      if (response && response.status === 429) {
        const errorBody = await response.clone().text().catch(() => '')
        const statedWaitMs = retryDelayMs(response.headers, errorBody)
        if (statedWaitMs !== undefined) {
          // A 429 that states when the allowance resets IS a verdict about this
          // account: only this family's allowance is spent, and the account
          // keeps serving the other. The upstream body travels with the
          // cooldown, so the next attempt can say WHY the upstream refused.
          this.accountPool.markFamilyCooldown(
            account.id, family, statedWaitMs, '429 Rate Limit', upstreamBodyExcerpt(errorBody),
          )

          const hasNext = await this.accountPool.hasAnotherAvailableAccountFor(family, triedAccountIds)
          if (hasNext) {
            continue
          }
        }
        // A 429 that states no reset time is NOT a verdict: the prod endpoint
        // answers every Antigravity request with a bare 429, so a bare 429
        // carries no information about this account's Gemini or Claude / GPT
        // allowance. A quota verdict needs evidence, so nothing is cooled and
        // no other account is tried; the failure is reported as the transient
        // rate limit it is.
      }

      break
    }

    if (!response || !response.ok) {
      const errText = await response?.text().catch(() => '') ?? ''
      if (response === undefined) {
        // No endpoint ever answered: every fetch rejected, so there is no HTTP
        // status to report and nothing here says this request was refused. A
        // connection-level failure is exactly what the harness retries.
        const detail = transportError instanceof Error
          ? transportError.message
          : transportError === undefined ? '' : String(transportError)
        throw new LlmError(
          `Antigravity request failed before any endpoint answered: ${detail || 'No response'}`,
          'TRANSPORT',
          transportError === undefined ? {} : { cause: transportError },
        )
      }
      const status = response.status
      if (status === 429) {
        // A 429 that states a reset time is a spent allowance: the verdict is
        // the account's, and the wait the service named is the real one.
        if (retryDelayMs(response.headers, errText) !== undefined) {
          throw new LlmError(
            `Antigravity 账号配额已耗尽或请求受限 (429 RESOURCE_EXHAUSTED)。请在插件设置页查看配额剩余百分比及重置倒计时。原始响应: ${errText || 'No response'}`,
            'RATE_LIMIT',
            { status: 429 },
          )
        }
        // A bare 429 says nothing about this account's allowance - the prod
        // endpoint answers every Antigravity request with one - so it is
        // reported as the transient rate limit it is, and it costs the account
        // nothing: no cooldown, no rotation to another account.
        throw new LlmError(
          `Antigravity 上游返回 429 (RESOURCE_EXHAUSTED) 但未给出重置时间，因此按瞬时限流处理，不视为账号配额耗尽，也不会冷却该账号。原始响应: ${upstreamBodyExcerpt(errText) || 'No response'}`,
          'SERVER',
          { status: 429 },
        )
      }
      if (status >= 500) {
        // A 5xx says nothing about this request or this credential: it is a
        // transient server-side failure, so it is reported under the code the
        // harness retries instead of ending the turn. Reporting it as a
        // terminal provider error was the reason a bare upstream 500 killed a
        // turn that a plain resend satisfied.
        throw new LlmError(`Antigravity upstream server error (${status}): ${errText || 'No response'}`, 'SERVER', {
          status,
        })
      }
      throw new LlmError(`Antigravity API error (${status}): ${errText || 'No response'}`, isHttpContextOverflow(status, errText) ? CONTEXT_OVERFLOW_CODE : 'PROVIDER_ERROR', {
        status,
      })
    }

    if (!response.body) throw new LlmError('Antigravity returned empty response body', 'PROVIDER_ERROR')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const state = createStreamState()
    let buffer = ''

    try {
      while (true) {
        const read = await reader.read().catch((error: unknown) => {
          // A body that dies mid-stream arrives as undici's bare
          // `TypeError: terminated`, which carries no code of its own: the
          // harness normalizes it to UNKNOWN, and UNKNOWN is not a code DSH
          // retries. Name the transport here instead, with the cause chain kept
          // in the message (see {@link streamFailure}).
          throw streamFailure(error, signal)
        })
        const { done, value } = read
        if (done) break
        // Transport received bytes, whether or not a parser turns them into a
        // visible chunk: a heartbeat frame is proof the connection is alive.
        if (value !== undefined && value.byteLength > 0) activity?.pulse()
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          // One complete frame arrived. A ': ping' comment yields no chunk at
          // all and must still re-time the watchdog.
          activity?.pulse()
          const chunks = processStreamLine(trimmed, state)
          for (const chunk of chunks) {
            recordUsageChunk(chunk, statsSessionId, statsAccountId)
            yield chunk
          }
          if (state.finished) return
        }
      }

      buffer += decoder.decode()
      if (buffer.trim()) {
        const chunks = processStreamLine(buffer.trim(), state)
        for (const chunk of chunks) {
          recordUsageChunk(chunk, statsSessionId, statsAccountId)
          yield chunk
        }
      }

      for (const chunk of closeStream(state)) {
        recordUsageChunk(chunk, statsSessionId, statsAccountId)
        yield chunk
      }
    } finally {
      void reader.cancel().catch(() => undefined)
    }
  }
}
