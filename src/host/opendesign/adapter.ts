/**
 * The OpenDesign LLM adapter: an OpenAI-compatible `chat/completions` stream
 * with per-account rotation and pre-first-token account failover.
 *
 * Transport and mapping live in `client.ts` / `mapper.ts`. This module owns the
 * request loop: which account, and when an attempt is abandoned. There is no
 * channel layer: the gateway chooses the upstream, and a request proves nothing
 * beyond the account that served it.
 *
 * @module dsh-chatgpt-subscription/opendesign-adapter
 */
import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  resolveRetryPolicy,
  type GenerateOptions as HarnessGenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type PreparedAdapterCall,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { setTimeout as sleep } from 'node:timers/promises'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { normalizeGenerateOptions, type GenerateOptions } from '../common/llm-compat.ts'
import { DEFAULT_EFFORTS, POOL_COOLDOWN_MS, PROVIDER_ID, PROVIDER_NAME } from './types.ts'
import { resolveModelInfo } from './catalog.ts'
import { openDesignVisibleModelIds } from './line.ts'
import {
  buildOpenDesignBody,
  parseServerSentEvents,
  streamErrorCode,
  translate,
} from './mapper.ts'
import { openChatStream, firstMessage } from './client.ts'
import type { OpenDesignModelSettings, OpenDesignModelSettingsStore } from './token-store.ts'
import { bearerFor, type OpenDesignCredentials } from './token-store.ts'
import type { OpenDesignAccountPool, OpenDesignPoolAccount } from './account-pool.ts'
import { outputReservation } from '../common/output-reservation.ts'
import {
  STREAM_IDLE_TIMEOUT_CODE,
  wrapStreamWithWatchdog,
  type StreamActivity,
} from '../common/idle-watchdog.ts'
import { ConcurrencyGate } from '../common/concurrency-gate.ts'
import { resolveRequestImages, NO_RESOLVED_IMAGES, type AttachmentImageReader } from '../common/request-images.ts'

/**
 * Retry policy for the `opendesign` route.
 *
 * A 5xx from the gateway says nothing about this key, so it is classified as
 * `SERVER` and given the same bounded backoff the other lines use. Deliberately
 * outside the set: `AUTH` and `QUOTA` (the pool rotates past those) and
 * `ABORTED`.
 */
const RETRY_POLICY = resolveRetryPolicy({
  mode: 'normal',
  maxRetries: 3,
  retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
  backoff: { initialDelayMs: 1_500, maxDelayMs: 15_000, jitterRatio: 0.2 },
}, 'dsh-chatgpt-subscription.opendesign.retry')

/** How long one attempt may wait for response headers before it is abandoned. */
const ATTEMPT_TIMEOUT_MS = 180_000

/**
 * Retries for a failure that happened BEFORE the request was sent.
 *
 * A TLS handshake to the gateway can fail intermittently on a network path
 * where curl succeeds. Retrying is safe because no HTTP request reached the
 * server. Errors after headers, or ambiguously mid-request, are never retried
 * here.
 */
const TRANSPORT_RETRIES = 2
const TRANSPORT_RETRY_BASE_MS = 400

/**
 * Fallback effort ladder for a model no source describes.
 *
 * Per-model ladders come from the shipped table (transcribed from this
 * repository's sibling registries) and from the live catalog; this trio is only
 * what a model with no data at all is offered. The wire carries the id string,
 * so an over-offered level is ignored rather than refused by most gateways —
 * but the ladder still prefers published data for anything the tables know.
 */
export const REASONING_EFFORT_IDS = DEFAULT_EFFORTS

export interface OpenDesignAdapterOptions {
  /** Proxy-aware fetch for live chat streams. */
  fetchFn: typeof fetch
  /** Durable attachment service, for request images. */
  attachments?: AttachmentImageReader
  /** The account pool this adapter rotates over. */
  accountPool: OpenDesignAccountPool
}

interface PickedAccount {
  account: OpenDesignPoolAccount
  credentials: OpenDesignCredentials
}

export class OpenDesignAdapter extends LlmAdapter {
  private readonly gate = new ConcurrencyGate()

  constructor(
    private readonly modelSettings: OpenDesignModelSettingsStore,
    private readonly options: OpenDesignAdapterOptions,
  ) {
    super()
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

  private get accountPool(): OpenDesignAccountPool {
    return this.options.accountPool
  }

  private settings(): Promise<OpenDesignModelSettings> {
    return this.modelSettings.read()
  }

  /*
   * There is deliberately no visibility rule here: the ids the picker is offered
   * come from `openDesignVisibleModelIds` in ./line.ts, shared with the status
   * route and the hub card. A private copy is what let the hub card count models
   * the picker refused to show, so this adapter reads the one implementation
   * instead of keeping a second with the same intent.
   */

  /** One model's resolved descriptor, from the shipped table plus live data. */
  private async modelInfo(modelId: string): Promise<ReturnType<typeof resolveModelInfo>> {
    const settings = await this.settings()
    return resolveModelInfo(modelId, {
      synced: settings.catalogModels,
      ...(settings.contextWindowOverrides[modelId] === undefined ? {} : { contextWindowOverride: settings.contextWindowOverrides[modelId] }),
      defaultContextWindow: settings.defaultContextWindow,
      defaultMaxTokens: settings.defaultMaxTokens,
    })
  }

  async listModels(provider?: string): Promise<readonly LlmModelInfo[]> {
    const prov = provider || PROVIDER_ID
    const settings = await this.settings()
    if (settings.enabled === false) return []
    const ids = openDesignVisibleModelIds(settings)
    return await Promise.all(ids.map(async (id) => {
      const info = await this.modelInfo(id)
      return {
        provider: prov,
        id,
        name: info.displayName,
        inputModalities: info.input as LlmModelInfo['inputModalities'],
      }
    }))
  }

  async resolveModel(provider: string, modelId: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted) throw new LlmError('OpenDesign model resolution aborted', 'ABORTED')
    const info = await this.modelInfo(modelId)
    return {
      provider,
      id: modelId,
      name: info.displayName,
      inputModalities: info.input as LlmResolvedModelInfo['inputModalities'],
      context: { contextWindow: info.contextWindow },
      ...outputReservation(info.contextWindow, info.maxTokens),
      ...(info.reasoning && info.efforts.length > 0
        ? {
            reasoning: {
              efforts: info.efforts.map((effort) => ({ id: ReasoningEffortId(effort), name: effort })),
              ...(info.defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(info.defaultEffort) }),
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

  async *stream(options: HarnessGenerateOptions): AsyncIterable<StreamChunk> {
    const settings = await this.settings()
    yield* wrapStreamWithWatchdog(
      (watchdogSignal, activity) => this.requestStream(options, settings, watchdogSignal, activity),
      options.signal,
      settings.streamIdleTimeoutMs,
      STREAM_IDLE_TIMEOUT_CODE,
      PROVIDER_NAME,
    )
  }

  /** The message the pool's empty state should raise, in this line's words. */
  private noAccountError(cause: unknown): LlmError {
    const detail = cause instanceof Error ? cause.message : String(cause)
    return new LlmError(
      `${PROVIDER_NAME} has no usable account: ${detail} Add an API key from the OpenDesign Cloud console in Settings > Subscription.`,
      'AUTH',
      { cause },
    )
  }

  private async *requestStream(
    rawOptions: HarnessGenerateOptions,
    settings: OpenDesignModelSettings,
    signal: AbortSignal,
    activity?: StreamActivity,
  ): AsyncGenerator<StreamChunk> {
    if (settings.enabled === false) {
      throw new LlmError(`${PROVIDER_NAME} is disabled in Settings > Subscription. Enable the line there, then retry.`, 'INVALID_REQUEST')
    }
    const options: GenerateOptions = normalizeGenerateOptions(rawOptions)
    const images = await resolveRequestImages(
      options,
      this.options.attachments as AttachmentImageReader | undefined,
      signal,
    ).catch((error) => {
      if (signal.aborted) throw new LlmError('OpenDesign request aborted by caller', 'ABORTED', { cause: error })
      return NO_RESOLVED_IMAGES
    })
    const info = await this.modelInfo(options.model)
    const body = buildOpenDesignBody(options, { maxTokens: info.maxTokens }, images)
    const refused = new Set<string>()
    let lastError: LlmError | null = null

    for (;;) {
      let picked: PickedAccount
      try {
        picked = await this.accountPool.getEffectiveCredential(refused, this.options.fetchFn)
      } catch (error) {
        throw lastError ?? this.noAccountError(error)
      }
      const { account, credentials } = picked
      const baseURL = credentials.baseURL?.trim() || settings.baseURL
      const apiKey = bearerFor(credentials)
      const consumer = new AbortController()
      const upstream = AbortSignal.any([signal, consumer.signal])
      let release: () => void = () => undefined
      try {
        this.gate.setLimit(account.id, settings.maxConcurrentRequests)
        release = await this.gate.acquire(account.id, upstream)
      } catch (error) {
        if (signal.aborted) throw new LlmError('OpenDesign request aborted by caller', 'ABORTED', { cause: error })
        throw error
      }
      try {
        let response: Response | undefined
        let transportError: unknown
        for (let transportTry = 0; transportTry <= TRANSPORT_RETRIES; transportTry += 1) {
          try {
            response = await openChatStream({
              fetchFn: this.options.fetchFn,
              baseURL,
              apiKey,
              body,
              signal: withAttemptTimeout(upstream),
            })
            break
          } catch (error) {
            if (signal.aborted) throw new LlmError('OpenDesign request aborted by caller', 'ABORTED', { cause: error })
            transportError = error
            // Only a failure that happened before the request was sent is safe
            // to replay. A mid-request reset might already have been served.
            if (transportTry < TRANSPORT_RETRIES && isPreConnectionFailure(error)) {
              try {
                await sleep(TRANSPORT_RETRY_BASE_MS * (transportTry + 1), undefined, { signal: upstream })
              } catch (waitError) {
                if (signal.aborted) throw new LlmError('OpenDesign request aborted by caller', 'ABORTED', { cause: waitError })
                throw waitError
              }
              continue
            }
            break
          }
        }
        if (response === undefined) {
          const note = errorChain(transportError)
          lastError = new LlmError(
            `${note} The request never reached the gateway: ${baseURL} failed during TLS/connect. Check the network or proxy.`,
            'TRANSPORT',
            { cause: transportError },
          )
          // A dead network path says nothing about the account; trying the next
          // key would burn the same path. Surface the failure instead.
          break
        }
        if (!response.ok) {
          const raw = await response.text().catch(() => '')
          let detail = raw.slice(0, 400)
          try {
            const parsed: unknown = JSON.parse(raw)
            detail = firstMessage(parsed) || detail
          } catch { /* keep the raw text */ }
          const code = streamErrorCode(detail, response.status)
          lastError = new LlmError(`${detail || `HTTP ${response.status}`} [model=${options.model}]`, code, { status: response.status })
          // An account-level refusal is worth another ACCOUNT: that is the whole
          // point of a pool, and with one account the next pass simply finds
          // nothing left and this error is raised unchanged.
          if (code === 'AUTH' || code === 'QUOTA') {
            refused.add(account.id)
            await this.standDown(account.id, code, detail)
            continue
          }
          break
        }
        if (response.body === null) {
          lastError = new LlmError('gateway returned no response body', 'EMPTY_RESPONSE', { status: response.status })
          break
        }
        const responseBody = tapChunks(response.body, () => activity?.pulse())
        const iterator = translate(parseServerSentEvents(responseBody))[Symbol.asyncIterator]()
        let yielded = false
        try {
          for (;;) {
            const next = await iterator.next()
            if (next.done === true) break
            yielded = true
            yield next.value
          }
        } catch (error) {
          if (signal.aborted) throw new LlmError('OpenDesign request aborted by caller', 'ABORTED', { cause: error })
          const note = error instanceof LlmError ? error.message : errorChain(error)
          const code = error instanceof LlmError ? error.code : 'TRANSPORT'
          // Content already reached the caller: this is the answer's failure,
          // and no retry can un-deliver it. Before any content, an account-level
          // refusal moves to the next account.
          if (yielded) {
            throw error instanceof LlmError ? error : new LlmError(note, 'TRANSPORT', { cause: error })
          }
          if (code === 'AUTH' || code === 'QUOTA') {
            refused.add(account.id)
            await this.standDown(account.id, code, note)
            lastError = error instanceof LlmError ? error : new LlmError(note, 'TRANSPORT', { cause: error })
            continue
          }
          lastError = error instanceof LlmError ? error : new LlmError(note, 'TRANSPORT', { cause: error })
          break
        } finally {
          consumer.abort('OpenDesign stream consumer stopped')
          void iterator.return?.(undefined).catch(() => undefined)
        }
        void this.accountPool.recordModel(account.id, options.model)
        return
      } finally {
        release()
      }
    }
    throw lastError ?? new LlmError(`no account could serve the request [model=${options.model}]`, 'UPSTREAM')
  }

  /** Park an account that refused a request, for the reason it refused. */
  private async standDown(accountId: string, code: string, detail: string): Promise<void> {
    if (code === 'AUTH') {
      await this.accountPool.markAuthFailed(accountId, `${PROVIDER_NAME} rejected this API key. Replace it from the account card. ${detail.slice(0, 160)}`, 'invalid').catch(() => undefined)
      return
    }
    await this.accountPool.markCooldown(accountId, POOL_COOLDOWN_MS, `${PROVIDER_NAME} credits exhausted`).catch(() => undefined)
  }
}

/** A caller signal combined with the attempt's header deadline. */
function withAttemptTimeout(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)])
}

/**
 * Whether a transport failure happened before any request was sent.
 *
 * Deliberately narrow: `other side closed`/`ECONNRESET` can happen after the
 * body was accepted, and replaying those is not safe. These are the handshake
 * and connect failures only.
 */
function isPreConnectionFailure(error: unknown): boolean {
  const text = errorChain(error)
  return /Client network socket disconnected before secure TLS connection|Connect Timeout Error|UND_ERR_CONNECT_TIMEOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)
}

/** Password-style redaction is not needed here; the chain is transport-only. */
function errorChain(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause
    return cause === undefined ? error.message : `${error.message}: ${errorChain(cause)}`
  }
  return String(error)
}

/**
 * Report transport activity without disturbing the stream.
 *
 * A keep-alive comment or an early frame reaches this before it reaches the SSE
 * parser, so the watchdog's clock resets on the gateway's first sign of life
 * rather than on the caller's first content.
 */
function tapChunks(body: ReadableStream<Uint8Array>, onChunk: () => void): ReadableStream<Uint8Array> {
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      onChunk()
      controller.enqueue(chunk)
    },
  }))
}
