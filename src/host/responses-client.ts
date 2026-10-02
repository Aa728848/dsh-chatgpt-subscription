import { createHash } from 'node:crypto'
import { toToolCallId } from './common/brand-compat.ts'

import {
  LlmError,
  ProviderRequestId,
  type FinishReason,
  type GenerateOptions,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { CODEX_RESPONSES_URL } from '../compat.ts'
import { resolveCodexFallbackModel } from '../shared/model-catalog.ts'
import { wrapStreamWithWatchdog } from './common/idle-watchdog.ts'
import { chatGPTConcurrency, type CodexAccountPool } from './codex-account-pool.ts'
import { OAuthService } from './oauth-service.ts'
import { buildResponsesPayload, hiddenSandboxControlToolNames, type LocalRawImageOptions } from './responses-mapper.ts'
import { normalizeGenerateOptions } from './common/llm-compat.ts'
import { CODEX_TURN_STATE_HEADER, authOwnerKey, codexHeaders, retryAfterMs, stableSessionId } from './wire-auth.ts'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { CodexOutputVerbosity, CodexReasoningSummary } from '../shared/contracts.ts'

type FetchLike = typeof fetch
const MAX_VISIBLE_REASONING_CHARS = 12_000
/** Cooldown a rotated account takes when the provider states no retry delay. */
const DEFAULT_POOL_COOLDOWN_MS = 15 * 60_000
const REASONING_DELTA_FLUSH_CHARS = 768
const REASONING_TRUNCATED_NOTICE = '\n\n[Reasoning summary truncated to keep the DSH web UI responsive.]'
/** Cap on live turns whose routing state is remembered at once. */
const MAX_TRACKED_TURN_STATES = 200

/** Routing state for one turn, plus the auth owner allowed to replay it. */
interface TurnStateEntry {
  value: string
  owner: string
}

export interface ResponsesClientOptions {
  fetchFn?: FetchLike
  localRawImages?: LocalRawImageOptions
  onGenerationFinished?: () => void
  outputVerbosity?: () => CodexOutputVerbosity | null
  fastMode?: () => boolean
  reasoningSummary?: () => CodexReasoningSummary | null
  /** Account pool to rotate over; without one the single stored credential is used. */
  accountPool?: CodexAccountPool
}

export class ResponsesClient {
  private readonly fetchFn: FetchLike
  private readonly onGenerationFinished: () => void
  private readonly outputVerbosity: () => CodexOutputVerbosity | null
  private readonly fastMode: () => boolean
  private readonly reasoningSummary: () => CodexReasoningSummary | null
  private readonly accountPool: CodexAccountPool | null
  /**
   * Opaque backend turn state, keyed by conversation session id.
   *
   * The Codex backend hands `x-codex-turn-state` back on each response and
   * expects it on the next request of the SAME turn, which lets it resume the
   * turn instead of re-ingesting the whole history.
   *
   * It is a client/server contract with a one-turn scope: the official client
   * creates a fresh per-turn session and warns that replaying the token across
   * turns breaks routing. The value is also account-scoped, so each entry
   * records the auth owner that minted it and is discarded when the signer
   * changes. It is only ever an optimization, so a miss costs a full resend and
   * never correctness.
   */
  private readonly turnStates = new Map<string, TurnStateEntry>()
  constructor(
    private readonly oauth: OAuthService,
    private readonly attachments: Pick<AttachmentStore, 'readImage'> & Partial<Pick<AttachmentStore, 'imageLimits'>>,
    options: ResponsesClientOptions = {},
  ) {
    this.fetchFn = options.fetchFn ?? fetch
    this.localRawImages = options.localRawImages ?? {}
    this.onGenerationFinished = options.onGenerationFinished ?? (() => undefined)
    this.outputVerbosity = options.outputVerbosity ?? (() => null)
    this.fastMode = options.fastMode ?? (() => false)
    this.reasoningSummary = options.reasoningSummary ?? (() => null)
    this.accountPool = options.accountPool ?? null
  }

  private readonly localRawImages: LocalRawImageOptions

  async *stream(rawOptions: GenerateOptions): AsyncIterable<StreamChunk> {
    const options = normalizeGenerateOptions(rawOptions)
    const hiddenSandboxControls = hiddenSandboxControlToolNames(options)
    const sessionId = stableSessionId(options.sessionId)
    // One model call is one turn for routing purposes: it is the unit that gets a
    // routing token back and the unit that may retry. The tool loop issues one
    // call per step, which is exactly the granularity this header is scoped to.
    const turnKey = turnKeyFor(sessionId, options)
    let currentModel = options.model
    let attemptOptions = options
    let response: Response | undefined

    while (true) {
      const payload = await buildResponsesPayload(
        attemptOptions,
        this.attachments,
        this.localRawImages,
        this.outputVerbosity(),
        this.fastMode(),
        this.reasoningSummary(),
        // Stable per conversation, so the backend can reuse the prompt prefix
        // across turns instead of re-reading the whole history.
        promptCacheKeyFor(sessionId),
      )
      try {
        response = await this.send(payload, sessionId, turnKey, options.signal)
        break
      } catch (error) {
        if (error instanceof LlmError && (error.code === 'NOT_FOUND' || (error as unknown as { status?: number }).status === 404)) {
          const fallback = resolveCodexFallbackModel(currentModel)
          if (fallback && fallback.id !== currentModel) {
            currentModel = fallback.id
            attemptOptions = { ...attemptOptions, model: fallback.id }
            continue
          }
        }
        throw error
      }
    }

    try {
      yield* wrapStreamWithWatchdog(
        (watchdogSignal) => parseResponsesStream(response!, watchdogSignal, hiddenSandboxControls),
        options.signal,
        300_000,
        'LLM_STREAM_IDLE_TIMEOUT',
        'Codex',
      )
    } finally {
      // The turn's routing state deliberately survives here: the next step of a
      // tool loop is the same turn and has to replay it. A new user turn computes a
      // new key, and the bound below keeps the map from growing without limit.
      // The stream is over, so this request no longer occupies the account. The
      // release belongs to THIS request: a sibling turn on the same account keeps
      // its own slot until its own stream ends.
      this.takePendingRelease(turnKey)?.()
      this.onGenerationFinished()
    }
  }

  private async send(
    payload: Record<string, unknown>,
    sessionId: string,
    turnKey: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    if (this.accountPool !== null) return this.sendWithPool(payload, sessionId, turnKey, signal)
    let credentials = await this.oauth.credentials()
    let response = await this.request(payload, credentials, sessionId, turnKey, signal)
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined)
      credentials = await this.oauth.credentials(true)
      response = await this.request(payload, credentials, sessionId, turnKey, signal)
    }
    if (!response.ok) throw await responseError(response)
    this.rememberTurnState(response, turnKey, credentials)
    return response
  }

  /**
   * Record the routing state a response carried, for this turn's next request.
   *
   * A response that carries none clears any stored value: a backend that stops
   * sending the header has stopped honouring it, and replaying a stale value
   * would be guessing. An empty header is treated the same as absent.
   */
  private rememberTurnState(
    response: Response,
    turnKey: string,
    credentials: Awaited<ReturnType<OAuthService['credentials']>>,
  ): void {
    const next = response.headers.get(CODEX_TURN_STATE_HEADER)?.trim()
    if (next === undefined || next === '') this.turnStates.delete(turnKey)
    else this.storeTurnState(turnKey, next, credentials)
  }

  /**
   * Bounded store: a long-lived host serves many sessions and turns, and nothing
   * here ever signals that either ended, so the map is capped and evicts the
   * oldest entry. The value is an optimization, so a miss only costs a resend.
   */
  private storeTurnState(
    turnKey: string,
    value: string,
    credentials: Awaited<ReturnType<OAuthService['credentials']>>,
  ): void {
    // Re-inserting an existing key must refresh its age, so delete before set.
    this.turnStates.delete(turnKey)
    this.turnStates.set(turnKey, { value, owner: authOwnerKey(credentials) })
    while (this.turnStates.size > MAX_TRACKED_TURN_STATES) {
      const oldest = this.turnStates.keys().next()
      if (oldest.done === true) break
      this.turnStates.delete(oldest.value)
    }
  }

  /**
   * Routing state this turn may replay, or undefined.
   *
   * A token minted by a different auth owner is dropped rather than sent: the
   * value is account-scoped, and sending it to another account is at best a
   * routing hint for the wrong machine and at worst a replay of state that
   * account never issued. Dropping it only costs a full resend.
   */
  private turnStateFor(
    turnKey: string,
    credentials: Awaited<ReturnType<OAuthService['credentials']>>,
  ): string | undefined {
    const entry = this.turnStates.get(turnKey)
    if (entry === undefined) return undefined
    if (entry.owner !== authOwnerKey(credentials)) {
      this.turnStates.delete(turnKey)
      return undefined
    }
    return entry.value
  }

  /**
   * Send one payload with account rotation.
   *
   * The pool picks the account — skipping cooling, quota-exhausted and failed
   * ones — and has already refreshed a token that was about to expire. A 429
   * cools that account down and retries the identical payload on the next
   * eligible account; a 401 forces exactly one refresh, and an account whose
   * refresh is rejected leaves the rotation instead of invalidating the others.
   * The payload is account-independent, so it is never rebuilt between attempts.
   */
  /** What one pool attempt produced, including the account that served it. */
  private async sendWithPool(
    payload: Record<string, unknown>,
    sessionId: string,
    turnKey: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const pool = this.accountPool!
    const tried = new Set<string>()
    while (true) {
      const { account, credentials } = await pool.getEffectiveAccount(tried, this.fetchFn)
      tried.add(account.id)
      // One slot per in-flight request on this account. A subagent fan-out is what
      // reaches a plan's concurrency bound, so the cap is held here, before the
      // request goes out, and released when the turn ends rather than when the
      // headers arrive: a stream still running is still work the account is doing.
      const release = await chatGPTConcurrency().acquire(account.id, signal)
      let held = true
      const free = (): void => {
        if (!held) return
        held = false
        release()
      }
      try {
        let response = await this.request(payload, credentials, sessionId, turnKey, signal)
        if (response.status === 401) {
          await response.body?.cancel().catch(() => undefined)
          try {
            const refreshed = await pool.refreshAccountNow(account.id)
            response = await this.request(payload, refreshed, sessionId, turnKey, signal)
          } catch (error) {
            await pool.markAuthFailed(
              account.id,
              error instanceof Error ? error.message : 'ChatGPT sign-in expired.',
            ).catch(() => undefined)
            free()
            if (await pool.hasAnotherAvailableAccount(tried)) continue
            throw new LlmError('ChatGPT sign-in has expired. Sign in again.', 'AUTH', { status: 401, cause: error })
          }
        }
        if (response.status === 429) {
          const after = retryAfterMs(response.headers)
          await response.body?.cancel().catch(() => undefined)
          // A 429 taken while other of our requests are still running on this
          // account is evidence about its concurrency, not only about its quota,
          // so the cap drops to what actually succeeded here. A lone request
          // being rate limited teaches nothing about concurrency, so that case
          // leaves the cap untouched.
          if (chatGPTConcurrency().inFlight(account.id) > 1) {
            chatGPTConcurrency().setLimit(account.id, chatGPTConcurrency().inFlight(account.id) - 1)
          }
          await pool.markCooldown(account.id, after ?? DEFAULT_POOL_COOLDOWN_MS, 'Codex 429').catch(() => undefined)
          free()
          if (await pool.hasAnotherAvailableAccount(tried)) continue
          throw new LlmError('Codex rate limit reached.', 'RATE_LIMIT', {
            status: 429,
            ...(after === undefined ? {} : { providerRetryAfterMs: after }),
          })
        }
        if (!response.ok) {
          const error = await responseError(response)
          free()
          throw error
        }
        this.rememberTurnState(response, turnKey, credentials)
        // The body is still streaming, so the slot stays held; the turn releases
        // it once this stream ends.
        this.pendingReleases.set(turnKey, free)
        return response
      } catch (error) {
        free()
        throw error
      }
    }
  }

  /**
   * Concurrency slot held by each streaming request, keyed by turn.
   *
   * Keyed rather than a single list on purpose: two turns can run against the
   * same account at once, and the first one to end must release only its own
   * slot. A list would hand the departing turn every outstanding release.
   */
  private readonly pendingReleases = new Map<string, () => void>()

  /** Take this turn's pending release, if it still holds one. */
  private takePendingRelease(turnKey: string): (() => void) | undefined {
    const release = this.pendingReleases.get(turnKey)
    this.pendingReleases.delete(turnKey)
    return release
  }

  private async request(
    payload: Record<string, unknown>,
    credentials: Awaited<ReturnType<OAuthService['credentials']>>,
    sessionId: string,
    turnKey: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    try {
      return await this.fetchFn(CODEX_RESPONSES_URL, {
        method: 'POST',
        headers: {
          ...codexHeaders(credentials, sessionId, { turnState: this.turnStateFor(turnKey, credentials) }),
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify(payload),
        signal,
      })
    } catch (cause) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      throw new LlmError('Codex could not be reached.', 'NETWORK', { cause })
    }
  }
}

/**
 * Prompt cache key for one conversation.
 *
 * The backend keys its prefix cache on this string, so it must be stable for a
 * conversation and distinct between conversations — otherwise one session would
 * be served another session's cached prefix. The session id is already a hashed
 * opaque string, so it is reused directly rather than hashed again.
 */
function promptCacheKeyFor(sessionId: string): string {
  return sessionId
}

/**
 * Position of this model call within its conversation.
 *
 * The harness passes no turn id, and one cannot be derived from message text
 * without guessing, so the call's own position in the request is the turn
 * identity. It is stable across the retries and model fallbacks of one call
 * (the same history is resent) and differs for the next step of a tool loop
 * (the history grew), which is exactly the scope the routing header has.
 */
/**
 * Routing scope for one request.
 *
 * The header is scoped to a turn, and a turn is a user turn plus however many
 * model calls its tool loop takes. Nothing in the request says which user turn
 * this is, so the identity is derived from the conversation the call sends: the
 * session, and the last user message that opens the turn. Every step of one tool
 * loop ends on the same trailing user message, so every step of a turn shares a
 * key and can replay the same routing state; the next user turn brings a new
 * trailing message and therefore a new key.
 *
 * The digest covers the opening message only. Including the whole history would
 * make each step its own key, which is exactly the case the header forbids.
 */
/** Plain text of a message, however this harness generation shaped it. */
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

function turnKeyFor(sessionId: string, options: { messages: readonly { role: string; content: unknown; source?: { kind?: string } }[] }): string {
  // The harness passes no turn id, and no property of the request identifies a
  // turn reliably: the same user text recurs across turns, a tool result also
  // carries a user role, and the number of tool calls is 0 at the start of every
  // turn. Guessing here is what puts a routing token from one turn into the next,
  // which is the contract violation the header forbids.
  //
  // So the key is per request, not per turn. The cost is a full resend for the
  // rare follow-up inside one turn; the benefit is that no request can ever carry
  // another turn's state. Until the harness supplies a turn id this is the only
  // identity that cannot be wrong.
  const digest = createHash('sha256')
    .update(sessionId)
    .update('\0')
    .update(String(perRequestNonce()))
    .digest('hex')
    .slice(0, 24)
  return `${sessionId}#${digest}`
}

/** A value no two requests in this process share. */
let requestCounter = 0
function perRequestNonce(): number {
  requestCounter += 1
  return requestCounter
}

interface ToolState {
  index: number
  id: string
  itemId?: string
  name: string
  arguments: string
  started: boolean
}

export async function* parseResponsesStream(
  response: Response,
  signal?: AbortSignal,
  hiddenSandboxControls: ReadonlySet<string> = new Set(),
): AsyncIterable<StreamChunk> {
  if (response.body === null) throw new LlmError('Codex returned no response stream.', 'PROVIDER_ERROR')
  const reader = response.body.getReader()
  const abortReader = (): void => { void reader.cancel(signal?.reason).catch(() => undefined) }
  signal?.addEventListener('abort', abortReader, { once: true })
  const decoder = new TextDecoder()
  let buffer = ''
  let nextIndex = 0
  let textIndex: number | null = null
  let reasoningIndex: number | null = null
  let text = ''
  let reasoning = ''
  let pendingReasoningDelta = ''
  let reasoningTruncated = false
  let terminal: FinishReason | null = null
  let usage: TokenUsage | null = null
  let replayOutput: Array<Record<string, unknown>> = []
  const tools = new Map<string, ToolState>()

  const toolFor = (event: Record<string, unknown>, item?: Record<string, unknown>): ToolState => {
    const itemId = string(event.item_id) ?? string(item?.id)
    const outputIndex = number(event.output_index)
    const key = itemId ?? (outputIndex === undefined ? `tool-${tools.size}` : `index-${outputIndex}`)
    let tool = tools.get(key)
    if (tool === undefined) {
      tool = {
        index: nextIndex++,
        id: acceptIdentity(`call_${key}`, item?.call_id ?? event.call_id),
        itemId,
        name: acceptIdentity('', item?.name ?? event.name),
        arguments: '',
        started: false,
      }
      tools.set(key, tool)
    }
    return tool
  }

  /**
   * Adopt the complete answer text when the backend carries it only in terminal
   * events instead of `response.output_text.delta`. Deltas own the text when they
   * arrive: this is a no-op once a text block started, so a normally streamed
   * response never doubles its answer.
   * @param full - the complete text the terminal event carries.
   * @returns the chunks that make it a visible text block, or none.
   */
  const adoptText = (full: string): StreamChunk[] => {
    if (textIndex !== null || full === '') return []
    textIndex = nextIndex++
    text = full
    return [
      { type: 'block-start', index: textIndex, blockType: 'text' },
      { type: 'text-delta', index: textIndex, text: full },
    ]
  }

  const consume = async function* (event: Record<string, unknown>): AsyncIterable<StreamChunk> {
    const type = string(event.type)
    if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      const delta = string(event.delta) ?? ''
      if (textIndex === null) {
        textIndex = nextIndex++
        yield { type: 'block-start', index: textIndex, blockType: 'text' }
      }
      text += delta
      if (delta) yield { type: 'text-delta', index: textIndex, text: delta }
      return
    }
    if (type === 'response.output_text.done') {
      yield* adoptText(string(event.text) ?? '')
      return
    }
    if (type === 'response.content_part.done') {
      const part = record(event.part)
      const partType = string(part?.type)
      if (partType === 'output_text' || partType === 'refusal') {
        yield* adoptText(string(part?.text) ?? '')
      }
      return
    }
    if (type === 'response.reasoning_summary_text.delta') {
      const delta = string(event.delta) ?? ''
      if (reasoningIndex === null) {
        reasoningIndex = nextIndex++
        yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
      }
      const visibleDelta = visibleReasoningDelta(delta, reasoning.length, reasoningTruncated)
      reasoningTruncated ||= visibleDelta.truncated
      if (visibleDelta.text !== '') {
        reasoning += visibleDelta.text
        pendingReasoningDelta += visibleDelta.text
      }
      if (pendingReasoningDelta.length >= REASONING_DELTA_FLUSH_CHARS) {
        yield { type: 'reasoning-delta', index: reasoningIndex, text: pendingReasoningDelta }
        pendingReasoningDelta = ''
      }
      return
    }
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const item = record(event.item)
      if (item !== null && type === 'response.output_item.done') replayOutput.push(structuredClone(item))
      if (string(item?.type) !== 'function_call') {
        if (type === 'response.output_item.done') yield* adoptText(messageItemText(item))
        return
      }
      const tool = toolFor(event, item ?? undefined)
      tool.id = acceptIdentity(tool.id, item?.call_id)
      tool.name = acceptIdentity(tool.name, item?.name)
      const initial = string(item?.arguments) ?? ''
      if (!tool.started) {
        tool.started = true
        yield { type: 'block-start', index: tool.index, blockType: 'tool-call' }
        yield {
          type: 'tool-call-delta',
          index: tool.index,
          id: toToolCallId(tool.id),
          name: tool.name || undefined,
          argumentsDelta: initial,
        }
        tool.arguments = initial
      } else if (type === 'response.output_item.done' && initial !== '') {
        tool.arguments = initial
      }
      return
    }
    if (type === 'response.function_call_arguments.delta') {
      const tool = toolFor(event)
      tool.id = acceptIdentity(tool.id, event.call_id)
      tool.name = acceptIdentity(tool.name, event.name)
      const delta = string(event.delta) ?? ''
      if (!tool.started) {
        tool.started = true
        yield { type: 'block-start', index: tool.index, blockType: 'tool-call' }
      }
      tool.arguments += delta
      yield {
        type: 'tool-call-delta',
        index: tool.index,
        id: toToolCallId(tool.id),
        name: tool.name || undefined,
        argumentsDelta: delta,
      }
      return
    }
    if (type === 'response.function_call_arguments.done') {
      const tool = toolFor(event)
      tool.id = acceptIdentity(tool.id, event.call_id)
      tool.name = acceptIdentity(tool.name, event.name)
      const finalArguments = string(event.arguments)
      if (finalArguments !== undefined) tool.arguments = finalArguments
      return
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      const completed = record(event.response)
      usage = mapUsage(record(completed?.usage))
      const output = completed?.output
      if (Array.isArray(output)) {
        replayOutput = output.filter((item): item is Record<string, unknown> => record(item) !== null)
          .map((item) => structuredClone(item))
        for (const item of output) yield* adoptText(messageItemText(record(item)))
      }
      terminal = type === 'response.incomplete'
        ? { kind: 'max-tokens' }
        : { kind: 'stop' }
      return
    }
    if (type === 'response.failed' || type === 'error') {
      const error = record(event.error) ?? record(record(event.response)?.error)
      const message = string(error?.message) ?? 'Codex generation failed.'
      const rawCode = string(error?.code)?.toLowerCase()
      const isOverload = message.toLowerCase().includes('overload')
        || message.toLowerCase().includes('server error')
        || rawCode === 'server_error'
        || rawCode === 'service_unavailable'
        || rawCode === 'internal_error'
      const isRateLimit = message.toLowerCase().includes('rate limit') || rawCode === 'rate_limit'
      const code = isRateLimit ? 'RATE_LIMIT' : (isOverload ? 'SERVER_ERROR' : (string(error?.code)?.toUpperCase() ?? 'PROVIDER_ERROR'))
      throw new LlmError(message, code)
    }
  }

  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const data = frame.split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data === '' || data === '[DONE]') continue
        let event: unknown
        try {
          event = JSON.parse(data)
        } catch {
          throw new LlmError('Codex returned malformed streaming JSON.', 'PROTOCOL_ERROR')
        }
        const valueRecord = record(event)
        if (valueRecord !== null) yield* consume(valueRecord)
      }
    }
  } finally {
    signal?.removeEventListener('abort', abortReader)
    reader.releaseLock()
  }

  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  if (terminal === null) throw new LlmError('Codex stream ended before a terminal event.', 'PROTOCOL_ERROR')
  if (reasoningIndex !== null) {
    if (pendingReasoningDelta !== '') {
      yield { type: 'reasoning-delta', index: reasoningIndex, text: pendingReasoningDelta }
      pendingReasoningDelta = ''
    }
    yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoning } }
  }
  if (textIndex !== null) {
    yield { type: 'block-end', index: textIndex, block: { type: 'text', text } }
  }
  for (const item of replayOutput) {
    if (item.type === 'function_call'
      && typeof item.name === 'string'
      && hiddenSandboxControls.has(item.name)
      && typeof item.arguments === 'string') {
      item.arguments = stripSandboxControls(item.arguments)
    }
  }
  let validToolCount = 0
  const replayedToolCallIds = new Set(replayOutput.flatMap((item) => (
    item.type === 'function_call' && typeof item.call_id === 'string' ? [item.call_id] : []
  )))
  for (const tool of tools.values()) {
    if (!tool.started) continue
    if (hiddenSandboxControls.has(tool.name)) {
      tool.arguments = stripSandboxControls(tool.arguments)
    }
    if (!isSafeJsonArguments(tool.arguments) || tool.name === '') {
      throw new LlmError(`Codex returned invalid JSON arguments for tool ${tool.name || '(unnamed)'}.`, 'INVALID_TOOL_ARGUMENTS')
    }
    validToolCount++
    if (!replayedToolCallIds.has(tool.id)) {
      replayOutput.push({
        type: 'function_call',
        call_id: tool.id,
        name: tool.name,
        arguments: tool.arguments,
      })
      replayedToolCallIds.add(tool.id)
    }
    yield {
      type: 'block-end',
      index: tool.index,
      block: { type: 'tool-call', id: toToolCallId(tool.id), name: tool.name, arguments: tool.arguments },
    }
  }
  if (usage !== null) yield { type: 'usage', usage }
  yield {
    type: 'finish',
    reason: validToolCount > 0 ? { kind: 'tool-calls' } : terminal,
    replayState: { response: { outputItems: replayOutput } },
  }
}

function visibleReasoningDelta(
  delta: string,
  currentVisibleChars: number,
  alreadyTruncated: boolean,
): { text: string; truncated: boolean } {
  if (delta === '' || alreadyTruncated) return { text: '', truncated: alreadyTruncated }
  const remaining = MAX_VISIBLE_REASONING_CHARS - currentVisibleChars
  if (remaining <= 0) return { text: REASONING_TRUNCATED_NOTICE, truncated: true }
  if (delta.length <= remaining) return { text: delta, truncated: false }
  return { text: `${delta.slice(0, remaining)}${REASONING_TRUNCATED_NOTICE}`, truncated: true }
}

/**
 * Map one response's usage onto DSH's disjoint accounting.
 *
 * `input_tokens` is the whole input, so cached input has to be subtracted out of
 * it and reported on its own field. Cache WRITES are counted separately from
 * reads and billed separately: leaving a write inside `inputTokens` would make a
 * cold prefix look cheaper than it was and hide the cost of a write. A field the
 * service omits is unknown, not zero, so it is simply not reported.
 */
function mapUsage(value: Record<string, unknown> | null): TokenUsage | null {
  if (value === null) return null
  const totalInput = number(value.input_tokens) ?? 0
  const outputTokens = number(value.output_tokens) ?? 0
  const details = record(value.input_tokens_details)
  const cached = number(details?.cached_tokens) ?? 0
  const written = number(details?.cache_write_tokens) ?? 0
  const reasoning = number(record(value.output_tokens_details)?.reasoning_tokens)
  return {
    inputTokens: Math.max(0, totalInput - cached - written),
    outputTokens,
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(written > 0 ? { cacheWriteTokens: written } : {}),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

function isSafeJsonArguments(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
  } catch {
    return false
  }
}

function stripSandboxControls(value: string): string {
  try {
    const parsed = JSON.parse(value) as unknown
    const parsedRecord = record(parsed)
    if (parsedRecord === null) return value
    let changed = false
    for (const name of ['sandbox_permissions', 'justification']) {
      if (name in parsedRecord) {
        delete parsedRecord[name]
        changed = true
      }
    }
    return changed ? JSON.stringify(parsedRecord) : value
  } catch {
    return value
  }
}

async function responseError(response: Response): Promise<LlmError> {
  const requestId = response.headers.get('x-request-id')
  const detail = (await response.text().catch(() => '')).slice(0, 500)
  const options = {
    status: response.status,
    ...(requestId ? { requestId: ProviderRequestId(requestId) } : {}),
    ...(response.status === 429 ? { providerRetryAfterMs: retryAfterMs(response.headers) } : {}),
  }
  if (response.status === 401) return new LlmError('ChatGPT sign-in has expired. Sign in again.', 'AUTH', options)
  if (response.status === 404) return new LlmError(`Codex model or resource not found (${response.status})${detail ? `: ${detail}` : '.'}`, 'NOT_FOUND', options)
  if (response.status === 429) return new LlmError('Codex rate limit reached.', 'RATE_LIMIT', options)
  if (response.status >= 500) return new LlmError(`Codex service error (${response.status}).`, 'SERVER_ERROR', options)
  return new LlmError(`Codex request failed (${response.status})${detail ? `: ${detail}` : '.'}`, 'PROVIDER_ERROR', options)
}

/**
 * Concatenated assistant text a non-delta `message` output item carries, which
 * the terminal events repeat. Empty for every other item type.
 * @param item - one \`output\` item from a Response.
 * @returns the item's output text, or an empty string.
 */
function messageItemText(item: Record<string, unknown> | null): string {
  if (item === null || string(item.type) !== 'message' || !Array.isArray(item.content)) return ''
  let text = ''
  for (const part of item.content) {
    const value = record(part)
    const kind = string(value?.type)
    if (kind !== 'output_text' && kind !== 'refusal') continue
    text += string(value?.text) ?? ''
  }
  return text
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function number(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function acceptIdentity(current: string, incoming: unknown): string {
  return typeof incoming === 'string' && incoming.length > 0 ? incoming : current
}

