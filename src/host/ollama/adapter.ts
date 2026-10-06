import { outputReservation } from '../common/output-reservation.ts'
import {
  LlmAdapter,
  LlmError,
  resolveRetryPolicy,
  type GenerateOptions as HarnessGenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type PreparedAdapterCall,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  normalizeGenerateOptions,
  type GenerateOptions,
  type Message,
  type ToolResultBlock,
} from '../common/llm-compat.ts'
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  FALLBACK_MODELS,
  POOL_COOLDOWN_MS,
  PROVIDER_ID,
  PROVIDER_NAME,
  contextWindowFor,
  floorForcedThinkingTokens,
  ollamaModelSupportsImage,
  thinkForModel,
  wireForModel,
  type OllamaCatalogModel,
} from './types.ts'
import { FileCredentialStore, FileModelSettingsStore, type OllamaCredentials } from './token-store.ts'
import { OllamaAccountPool } from './account-pool.ts'
import { loadCatalog, startChat, type OllamaChatMessage, type OllamaRequest } from './client.ts'
import { applyEvent, closeStream, createStreamState } from './mapper.ts'
import {
  STREAM_IDLE_TIMEOUT_CODE,
  STREAM_IDLE_TIMEOUT_MS,
  wrapStreamWithWatchdog,
} from '../common/idle-watchdog.ts'
import { retryAfterMs } from '../wire-auth.ts'

/**
 * Retry policy for the `ollama` route.
 *
 * A 5xx from a shared inference service says nothing about this key, so it is
 * classified as `SERVER` and given the same bounded backoff the other lines use.
 * Deliberately outside the set: `INVALID_CREDENTIAL` (a rejected key fails
 * identically every time, and the pool rotates past it instead) and `ABORTED`.
 */
const RETRY_POLICY = resolveRetryPolicy({
  mode: 'normal',
  maxRetries: 3,
  retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
  backoff: { initialDelayMs: 1_500, maxDelayMs: 15_000, jitterRatio: 0.2 },
}, 'dsh-chatgpt-subscription.ollama.retry')

export interface OllamaAdapterOptions {
  fetchFn?: typeof fetch
  /** Test seam; production reads `/api/tags` with the active account's key. */
  loadCatalog?: (fetchFn: typeof fetch, credentials: OllamaCredentials) => Promise<OllamaCatalogModel[]>
  /**
   * Attachment store used to read image bytes for the request.
   *
   * DSH delivers an image as a durable reference, not as bytes, so a route that
   * declares image input has to resolve those references before building the
   * body. Without it the image is dropped and the turn silently becomes
   * text-only while the model picker still advertises image support.
   */
  attachments?: Pick<AttachmentStore, 'readImage'>
}

export class OllamaAdapter extends LlmAdapter {
  /**
   * Rotation pool, or null for the single stored key.
   *
   * Only the plugin entry installs it, because the entry owns the storage; an
   * adapter built without one must keep reading the one credential file rather
   * than minting pool state that would outlive the process.
   */
  private readonly accountPool: OllamaAccountPool | null

  constructor(
    private readonly store = new FileCredentialStore(),
    private readonly modelSettings = new FileModelSettingsStore(),
    private readonly options: OllamaAdapterOptions = {},
    accountPool?: OllamaAccountPool,
  ) {
    super()
    this.accountPool = accountPool ?? null
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

  private settings() {
    return this.modelSettings.read()
  }

  /**
   * Catalog for the picker: the live `/api/tags` listing when a key can reach it,
   * the shipped fallback otherwise, narrowed by the user's enabled selection.
   *
   * Ollama's model set moves quickly, so a stale local table would be the wrong
   * default; the fallback exists only so the line is usable before the first
   * successful sync.
   */
  private async catalog(): Promise<OllamaCatalogModel[]> {
    const load = this.options.loadCatalog ?? loadCatalog
    const fetchFn = this.options.fetchFn ?? fetch
    const credentials = await this.anyCredentials()
    if (credentials !== null) {
      const live = await load(fetchFn, credentials).catch(() => [])
      if (live.length > 0) {
        // Persist the sync so a later offline start still sees the last good list.
        await this.modelSettings.storeCatalog(live).catch(() => undefined)
        return live
      }
    }
    const cached = this.modelSettings.status().catalogModels
    if (cached.length > 0) return cached
    return [...FALLBACK_MODELS]
  }

  /** Any usable key, for the catalog call; the pool decides real routing later. */
  private async anyCredentials(): Promise<OllamaCredentials | null> {
    if (this.accountPool !== null) {
      const effective = await this.accountPool.getEffectiveCredential(new Set(), this.options.fetchFn ?? fetch)
        .catch(() => null)
      return effective?.credentials ?? null
    }
    return this.store.read().catch(() => null)
  }

  async listModels(provider?: string): Promise<readonly LlmModelInfo[]> {
    const prov = provider || PROVIDER_ID
    const settings = await this.settings()
    if (settings.enabled === false) return []
    const catalog = await this.catalog()
    const enabled = new Set(settings.enabledModelIds)
    // An empty selection means "whatever the catalog returned", which is what a
    // user sees before narrowing it; a non-empty one is an explicit filter.
    const available = settings.enabledModelIds.length === 0
      ? catalog
      : catalog.filter((model) => enabled.has(model.id))
    return available.map((model) => ({
      provider: prov,
      id: model.id,
      name: model.name ?? model.id,
      inputModalities: ollamaModelSupportsImage(model.id) ? ['text', 'image'] : ['text'],
    }))
  }

  async resolveModel(provider: string, modelId: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted) throw new LlmError('Ollama model resolution aborted', 'ABORTED')
    const catalog = await this.catalog()
    const entry = catalog.find((model) => model.id === modelId)
    return {
      provider,
      id: modelId,
      name: entry?.name ?? modelId,
      inputModalities: ollamaModelSupportsImage(modelId) ? ['text', 'image'] : ['text'],
      context: { contextWindow: contextWindowFor(entry) },
      // Ollama does not publish a per-model output ceiling, so this is a request
      // level default rather than a claim about the model.
      ...outputReservation(contextWindowFor(entry), DEFAULT_MAX_OUTPUT_TOKENS),
    }
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  async *stream(options: HarnessGenerateOptions): AsyncIterable<StreamChunk> {
    yield* wrapStreamWithWatchdog(
      (watchdogSignal) => this.requestStream(options, watchdogSignal),
      options.signal,
      STREAM_IDLE_TIMEOUT_MS,
      STREAM_IDLE_TIMEOUT_CODE,
      PROVIDER_NAME,
    )
  }

  private async *requestStream(rawOptions: HarnessGenerateOptions, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    const fetchFn = this.options.fetchFn ?? fetch
    const options = normalizeGenerateOptions(rawOptions)
    const wire = wireForModel(options.model)
    const request = await toOllamaRequest(options, this.options.attachments, signal)

    // Account rotation. The payload is key-independent, so it is built once and
    // replayed unchanged while another key can still serve it: a rate-limited or
    // rejected key ends its part of the turn, not the turn.
    const pool = this.accountPool
    const tried = new Set<string>()
    let lastStatus: number | undefined
    let lastDetail = ''
    let accountId: string | undefined
    /**
     * Set the moment ANY chunk reaches the caller, and never cleared.
     *
     * Deliberately broader than "some text arrived": a block start or a tool
     * call the caller has already seen is exactly as visible as the text, so the
     * conservative reading is the one that cannot be wrong. It also survives the
     * pool rotation below, because output an account produced before failing is
     * still output.
     */
    let outputStarted = false
    /**
     * The code a transient in-band failure becomes, or null for this attempt.
     *
     * Assigned per failure rather than accumulated, so a later attempt that
     * failed for a reason of its own is never judged by an earlier one's wording.
     */
    let lastInBandCode: InBandTransientCode | null = null

    for (;;) {
      let credentials: OllamaCredentials
      if (pool === null) {
        const stored = await this.store.read()
        if (stored === null) {
          throw new LlmError(
            `No ${PROVIDER_NAME} API key configured. Add one from Settings > ${PROVIDER_NAME} (create a key at https://ollama.com/settings/keys).`,
            'MISSING_CREDENTIAL',
          )
        }
        credentials = stored
      } else {
        const effective = await pool.getEffectiveCredential(tried, fetchFn)
        accountId = effective.account.id
        tried.add(accountId)
        credentials = effective.credentials
      }

      const call = startChat(fetchFn, credentials, wire, { ...request, signal })
      const state = createStreamState()
      let opened = false
      let openedStatus: number | undefined
      void call.status.then((value) => {
        opened = true
        openedStatus = value
      })

      // Collected here and recorded only once the turn completes, so a stream
      // that dies part-way does not leave a half-turn counted against the key.
      let spent: { inputTokens: number; outputTokens: number } | null = null

      let failed = false
      for await (const event of call.events) {
        if (event.type === 'error') {
          lastStatus = openedStatus
          lastDetail = event.message
          // A failure the service put INSIDE a successful response is the one
          // case the status rule below reads as the caller's fault, because the
          // response really was a 200. Its wording is re-read here, where the
          // turn is still able to start over - and only here, because this is the
          // only layer that knows whether anything has reached the caller. A
          // non-2xx already carries a status and keeps the verdict that status
          // gave it; the body it was sent with is not a second opinion about it.
          const inBand = openedStatus !== undefined && openedStatus >= 200 && openedStatus < 300
          lastInBandCode = outputStarted || !inBand ? null : inBandTransientCode(event.message)
          failed = true
          break
        }
        if (event.type === 'usage') {
          spent = event.usage
          continue
        }
        if (event.type === 'text' || event.type === 'thinking' || event.type === 'tool_call') {
          for (const chunk of applyEvent(state, event)) {
            outputStarted = true
            yield chunk
          }
          continue
        }
      }
      // A completed turn, including one that legitimately ended on a tool call.
      if (!failed) {
        // Close whatever the stream left open before the turn ends, so a model
        // cut off mid-sentence still yields the text that did arrive.
        for (const chunk of closeStream(state)) {
          outputStarted = true
          yield chunk
        }
        // Counted against the key that actually served the turn, after it
        // completed, and best-effort: a lost count must never fail a reply.
        if (pool !== null && accountId !== undefined && spent !== null) {
          await pool.recordUsage(accountId, spent.inputTokens, spent.outputTokens)
        }
        return
      }

      if (pool === null || accountId === undefined) break
      // Only a status that names this account is a verdict about this account.
      // Anything else is about the request and the same key would fail again.
      if (lastStatus === 401 || lastStatus === 403) {
        await pool.markAuthFailed(
          accountId,
          `${PROVIDER_NAME} rejected the API key (${lastStatus}).`,
          'invalid',
        ).catch(() => undefined)
        if (await pool.hasAnotherAvailableAccount(tried)) continue
        break
      }
      if (lastStatus === 429) {
        await pool.markCooldown(accountId, POOL_COOLDOWN_MS, `${PROVIDER_NAME} 429`).catch(() => undefined)
        if (await pool.hasAnotherAvailableAccount(tried)) continue
        break
      }
      break
    }

    const status = lastStatus
    if (status === 401 || status === 403) {
      throw new LlmError(
        `${PROVIDER_NAME} rejected the API key (${status}). Replace it from Settings > ${PROVIDER_NAME}.${lastDetail ? ` ${lastDetail}` : ''}`,
        'INVALID_CREDENTIAL',
        { status },
      )
    }
    if (status === 429) {
      throw new LlmError(
        `${PROVIDER_NAME} rate limit or plan quota reached (429). Add another key, or wait for the cooldown shown in Settings > ${PROVIDER_NAME}.${lastDetail ? ` ${lastDetail}` : ''}`,
        'RATE_LIMIT',
        { status: 429 },
      )
    }
    // A transient failure the service reported inside its own 200 would end the
    // turn on the one try that matters, because the status rule reads a 200 as a
    // caller's mistake - the same overload sent as a 529 is retried today, and the
    // in-band copy of it is not. Only the code changes: the message stays this
    // adapter's own and still names what Ollama said, and no `status` is attached,
    // because the response really was a 200.
    //
    // The pool chain above is deliberately NOT consulted for it. That chain keys
    // on 401, 403 and 429, all of them statements about an account; naming one of
    // them from a message would put a key on cooldown for a condition nothing
    // evidenced, and would rotate onto a second key that fails identically. The
    // transient verdict is left to the harness retry policy instead, which replays
    // the same request without inventing anything about this account.
    throw new LlmError(
      `${PROVIDER_NAME} request failed${status === undefined ? '' : ` (${status})`}.${lastDetail}`,
      lastInBandCode ?? (status !== undefined && status >= 500 ? 'SERVER' : 'INVALID_REQUEST'),
      status === undefined ? {} : { status },
    )
  }
}

/** The only two verdicts an in-band Ollama failure can be retyped as. */
type InBandTransientCode = 'RATE_LIMIT' | 'SERVER'

/**
 * The DSH code an in-band Ollama failure becomes, or null when the message names
 * nothing transient.
 *
 * Ollama reports a failure inside a 200 as `{"error": "<message>"}` - one string,
 * no type - so the shared helper's Anthropic table cannot apply and there is no
 * status to name either. The wording is the whole signal, which is the same
 * message heuristic the Codex line already reads on `response.failed` in
 * `responses-client.ts` (generalized for the Responses vocabulary by
 * `inBandResponsesCode` in `common/stream-error.ts`); it is kept local here
 * because these are Ollama's own phrasings, not a vocabulary lines share.
 *
 * Every phrase below names a condition Ollama reports that clears on its own: a
 * model still being pulled into memory, a runner that would not start, a server
 * with no slot for this request, an overloaded or throttled front door. That is
 * what makes a retry worth taking - the request did not change, so a later one
 * is genuinely a different bet.
 *
 * Deliberately narrow, because the cost of guessing is paid by the user in
 * backoff. A refusal the wording does not name is usually the service objecting
 * to the caller's message, and retrying repeats it verbatim: three identical
 * requests ending in the same verdict, with the real fault unreported. Falling
 * back to some invented status instead would be worse on both counts, filing an
 * unrecognized refusal as a retryable server error and inviting the pool chain
 * to cool an account down for something nothing observed.
 */
function inBandTransientCode(message: string): InBandTransientCode | null {
  const text = message.toLowerCase()
  if (IN_BAND_RATE_LIMIT.some((phrase) => text.includes(phrase))) return 'RATE_LIMIT'
  if (IN_BAND_SERVER.some((phrase) => text.includes(phrase))) return 'SERVER'
  return null
}

/**
 * Throttling wording, read first because it is the narrower of the two verdicts.
 *
 * The same conditions this line already types RATE_LIMIT for when they arrive as
 * a 429; a gateway that reports one inside the stream is describing the same
 * state, and the harness backoff that 429 earns is what the turn should get.
 */
const IN_BAND_RATE_LIMIT: readonly string[] = [
  'rate limit',
  'rate-limit',
  'rate_limit',
  'too many requests',
  'quota',
]

/**
 * Server-side conditions, in no particular order.
 *
 * The model-loading and runner wording covers the two failures Ollama raises while
 * it is still getting ready to serve - the request was well formed and the
 * service was not ready for it - and the rest is what its front door says when it
 * is saturated.
 */
const IN_BAND_SERVER: readonly string[] = [
  'overload',
  'server busy',
  'model is loading',
  'loading model',
  "couldn't load",
  'could not load',
  'unable to load',
  'failed to load',
  'runner',
  'service unavailable',
  'internal server error',
]

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function attachmentLabel(block: Record<string, unknown>): string | undefined {
  const attachment = isRecord(block.attachment) ? block.attachment : undefined
  return asString(attachment?.name) || asString(attachment?.attachmentId)
}

function unavailableImageText(block: Record<string, unknown>): string {
  const label = attachmentLabel(block)
  const subject = label ? `${label} could not be read` : 'the image could not be read'
  return `[image unavailable: ${subject}; ask the user to attach it again if the image is needed]`
}

function abortException(signal?: AbortSignal): Error {
  if (signal?.reason !== undefined) {
    return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason))
  }
  return new DOMException('The operation was aborted', 'AbortError')
}

function unsupportedImageText(model: string, block: Record<string, unknown>): string {
  const label = attachmentLabel(block)
  const subject = label ? `${label}: ` : ''
  return `[image unsupported: ${subject}model ${model} is not known to declare image support; remove the attachment or switch to a vision model]`
}

function combineTextParts(parts: string[]): string {
  let result = ''
  for (const part of parts) {
    if (!part) continue
    if (!result) {
      result = part
    } else if (part.startsWith('[image ') || result.endsWith('\n')) {
      result = result.trimEnd() + '\n\n' + part
    } else {
      result += part
    }
  }
  return result
}

interface ProcessedContent {
  text: string
  images?: string[]
}

async function processMessageContent(
  content: unknown,
  model: string,
  attachments?: Pick<AttachmentStore, 'readImage'>,
  signal?: AbortSignal,
): Promise<ProcessedContent> {
  if (signal?.aborted) throw abortException(signal)
  if (typeof content === 'string') return { text: content }
  if (!Array.isArray(content)) return { text: '' }

  const textParts: string[] = []
  const images: string[] = []

  for (const part of content) {
    if (typeof part === 'string') {
      textParts.push(part)
      continue
    }
    if (!isRecord(part)) continue

    if (part.type === 'text') {
      if (typeof part.text === 'string' && part.text !== '') {
        textParts.push(part.text)
      }
      continue
    }

    if (part.type === 'image') {
      if (!ollamaModelSupportsImage(model)) {
        textParts.push(unsupportedImageText(model, part))
        continue
      }

      const reference = isImageRef(part.attachment)
        ? part.attachment
        : isImageRef(part.source) ? part.source : null

      if (reference !== null) {
        if (!attachments) {
          textParts.push(unavailableImageText(part))
          continue
        }
        try {
          if (signal?.aborted) throw abortException(signal)
          const loaded = await attachments.readImage(reference, signal)
          if (signal?.aborted) throw abortException(signal)
          if (loaded === null) {
            textParts.push(unavailableImageText(part))
          } else {
            images.push(encodeImage(loaded.data, loaded.ref.mediaType))
          }
        } catch (error) {
          if (isAbort(error, signal)) throw error
          textParts.push(unavailableImageText(part))
        }
        continue
      }

      const inline = part.source
      if (isRecord(inline)) {
        const data = inline.data
        if (typeof data === 'string' && data !== '') {
          images.push(encodeImage(data, asMediaType(inline.mediaType)))
          continue
        }
      }
      if (typeof part.image === 'string' && part.image !== '') {
        images.push(part.image)
        continue
      }
      // Malformed image part carrying neither reference nor inline data
      textParts.push(unavailableImageText(part))
      continue
    }
  }

  const text = combineTextParts(textParts)
  return {
    text,
    ...(images.length > 0 ? { images } : {}),
  }
}

/**
 * Project DSH's request shape onto Ollama's, per surface.
 * Consumes the canonical Message vocabulary produced by normalizeGenerateOptions.
 */
export async function toOllamaRequest(
  options: GenerateOptions,
  attachments?: Pick<AttachmentStore, 'readImage'>,
  signal?: AbortSignal,
): Promise<Omit<OllamaRequest, 'signal'>> {
  if (signal?.aborted) throw abortException(signal)
  const messages: OllamaChatMessage[] = []
  const trimmedSystem = typeof options.system === 'string' && options.system.trim() !== ''
    ? options.system.trim()
    : undefined

  // A one-shot caller may pass its system prompt outside the history.
  if (trimmedSystem !== undefined) {
    messages.push({ role: 'system', content: trimmedSystem })
  }

  for (let index = 0; index < options.messages.length; index++) {
    const message = options.messages[index]!

    // Deduplicate only a leading message whose text duplicates options.system;
    // nonleading repeated instructions in conversation context are preserved.
    if (index === 0 && trimmedSystem !== undefined && (message.role === 'system' || message.role === 'developer')) {
      const leadingText = textOf(message.content).trim()
      if (leadingText === trimmedSystem) continue
    }

    // Canonical vocabulary: verify tool provenance or content blocks before role: 'tool' conversion
    const isToolResult = message.source?.kind === 'tool' || (
      Array.isArray(message.content) &&
      message.content.some((b) => (b as { type?: string }).type === 'tool-result')
    )
    if (isToolResult && Array.isArray(message.content)) {
      const toolResultBlocks = message.content.filter(
        (b): b is ToolResultBlock => (b as { type?: string }).type === 'tool-result'
      )
      if (toolResultBlocks.length > 0) {
        for (const block of toolResultBlocks) {
          const toolCallId = String(
            block.toolCallId ??
            (isRecord(message.source) ? message.source.callId : '') ??
            ''
          )
          const processed = await processMessageContent(block.content, options.model, attachments, signal)
          messages.push({
            role: 'tool',
            content: processed.text,
            ...(toolCallId !== '' ? { toolCallId } : {}),
            ...(processed.images ? { images: processed.images } : {}),
          })
        }
        continue
      }
    }

    const toolCalls = assistantToolCalls(message.content)
    if (toolCalls.length > 0) {
      messages.push({ role: 'assistant', content: textOf(message.content), toolCalls })
      continue
    }
    if (message.role === 'assistant') {
      messages.push({ role: 'assistant', content: textOf(message.content) })
      continue
    }

    if (message.role === 'system' || message.role === 'developer') {
      const text = textOf(message.content).trim()
      if (text !== '') {
        messages.push({ role: 'system', content: text })
      }
      continue
    }

    const processed = await processMessageContent(message.content, options.model, attachments, signal)
    messages.push({
      role: 'user',
      content: processed.text,
      ...(processed.images ? { images: processed.images } : {}),
    })
  }

  const request: Omit<OllamaRequest, 'signal'> = { model: options.model, messages }
  // A caller may ask for a cap smaller than this model's forced thinking needs -
  // DSH's session-title call asks for one short line - which returns an empty
  // text block and a length finish. Raise that cap; a caller stating a larger one
  // is passed through untouched, and an absent cap stays DEFAULT_MAX_OUTPUT_TOKENS,
  // which nothing is short of.
  const flooredMax = floorForcedThinkingTokens(options.model, options.maxTokens)
  if (flooredMax !== undefined) request.maxOutputTokens = flooredMax
  if (options.temperature !== undefined) request.temperature = options.temperature

  const think = thinkForModel(options.model, options.reasoningEffort)
  if (think !== undefined) request.think = think

  const tools = options.tools
  if (Array.isArray(tools) && tools.length > 0) {
    request.tools = tools.map((tool) => ({
      name: tool.name,
      ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    }))
  }
  return request
}

/** Tool calls an assistant turn carries, read from its content blocks. */
function assistantToolCalls(content: unknown): { id: string; name: string; arguments: string }[] {
  if (!Array.isArray(content)) return []
  const calls: { id: string; name: string; arguments: string }[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const fields = block as Record<string, unknown>
    if (fields.type !== 'tool-call') continue
    const id = fields.id
    const name = fields.name
    if (typeof id !== 'string' || typeof name !== 'string') continue
    calls.push({
      id,
      name,
      arguments: typeof fields.arguments === 'string' ? fields.arguments : JSON.stringify(fields.arguments ?? {}),
    })
  }
  return calls
}

function isImageRef(value: unknown): value is ImageAttachmentRef {
  return typeof value === 'object' && value !== null && typeof (value as { attachmentId?: unknown }).attachmentId === 'string'
}

function asMediaType(value: unknown): string {
  return typeof value === 'string' && value !== '' ? value : 'image/png'
}

/**
 * The base64 payload Ollama wants, with or without a data URL prefix.
 *
 * The native surface takes the bare payload; a `data:` URL is accepted by both
 * surfaces once, so one encoding serves either and avoids a route-specific
 * guess about what a given model accepts.
 */
function encodeImage(data: Uint8Array | string, mediaType: string): string {
  const base64 = typeof data === 'string' ? data : Buffer.from(data).toString('base64')
  return base64.startsWith('data:') ? base64 : `data:${mediaType};base64,${base64}`
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (typeof part === 'object' && part !== null) {
          const text = (part as Record<string, unknown>).text
          if (typeof text === 'string') return text
        }
        return ''
      })
      .join('')
  }
  return ''
}
