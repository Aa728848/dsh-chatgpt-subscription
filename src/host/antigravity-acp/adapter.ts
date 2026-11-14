/**
 * The Antigravity (ACP) LLM adapter: one DSH model call, translated into one ACP
 * turn on the official `agy` process.
 *
 * The shape of a turn
 * -------------------
 * A DSH generation that needs no tool is a single `stream()` call: prompt the
 * agent, forward its text, finish. A generation that needs a tool spans *two*
 * `stream()` calls, and the second one must not start a new agent turn - the
 * agent is still sitting inside the first, waiting on the MCP request it made.
 * This class therefore keeps a *live turn* per DSH session: the ACP session, the
 * bridge, and how much history that turn has already been told about.
 *
 * A turn that ends without a tool round does not lose its ACP session: it is
 * parked *dormant* together with the process it runs on, and the next user
 * message on the same DSH session is sent as an increment on that same
 * conversation. That is worth more than the prefill it saves. A session created
 * per message hands a thinking model a hundred-message transcript and hopes it
 * picks out the newest line; the observed failure was a model re-running the
 * conversation's *first* request when the user wrote "go with option A".
 *
 * Reuse is never assumed. The prefix the agent was told about must still match
 * the harness's history (the history module's fingerprint), the tool catalogue
 * the bridge exposed must be unchanged, and a different model or effort is
 * applied with `session/set_config_option` on the same conversation. A
 * compaction, an edited turn, a new tool set, a dead process, or a refused
 * reconfiguration all fall back to a fresh session fed the complete history - and
 * that replay ends with a history boundary marker, so it is read as a transcript
 * rather than as a task list.
 *
 * Where the tool calls come from
 * ------------------------------
 * The bridge (see `mcp-bridge.ts`) parks the agent's MCP `tools/call` and this
 * adapter surfaces it as an ordinary DSH tool call. The harness executes it with
 * its own permissions and records the result; the next generation hands that
 * result back here, which answers the parked request. The agent then continues
 * inside the *same* ACP prompt.
 *
 * @module dsh-chatgpt-subscription/host/antigravity-acp/adapter
 */

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
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { localizedProviderName, t } from '../common/i18n/index.ts'
import { toToolCallId } from '../common/brand-compat.ts'
import {
  normalizeGenerateOptions,
  type ContentBlock,
  type GenerateOptions,
  type ToolResultBlock,
} from '../common/llm-compat.ts'
import { STREAM_IDLE_TIMEOUT_CODE, STREAM_IDLE_TIMEOUT_MS, wrapStreamWithWatchdog } from '../common/idle-watchdog.ts'
import {
  NO_RESOLVED_IMAGES,
  imageBlockToInline,
  resolveRequestImages,
  type AttachmentImageReader,
  type ResolvedRequestImages,
} from '../common/request-images.ts'
import type {
  AntigravityAcpModelDto,
  AntigravityAcpNativeToolPolicy,
  AntigravityAcpUsageDto,
} from '../../shared/antigravity-acp-contracts.ts'
import { AcpClient, AcpError, type AcpClientHandlers } from './acp-client.ts'
import {
  BRIDGE_SERVER_NAME,
  McpBridge,
  type BridgeDescriptor,
  type ToolCallImage,
  type ToolCallOutcome,
} from './mcp-bridge.ts'
import { acpError } from './errors.ts'
import {
  ACP_MAX_INLINE_IMAGE_BYTES,
  buildPrompt,
  canContinue,
  fingerprintMessages,
  fingerprintTools,
  type AcpPromptBlock,
} from './history.ts'
import type { AntigravityAcpSettings, AntigravityAcpSettingsStore } from './settings.ts'
import {
  AUTH_REQUIRED_MESSAGE,
  ACP_AUTH_REQUIRED_CODE,
  PROVIDER_ID,
  PROVIDER_NAME,
  findModel,
  toModelInfo,
  toResolvedModelInfo,
} from './types.ts'

/** Retry policy: transport faults are worth another attempt; a refusal or an auth wall is not. */
const RETRY_POLICY = resolveRetryPolicy({
  mode: 'normal',
  maxRetries: 2,
  // The line's own codes are the retry choices now: a dropped agent process is
  // exactly what another attempt fixes, while a refusal, an auth wall or a
  // missing binary is not. TRANSPORT stays for anything raised before this
  // classification runs.
  retryableCodes: ['ACP_DISCONNECTED', 'ACP_RPC_ERROR', 'TRANSPORT', 'SERVER', 'TIMEOUT', 'STREAM_CLOSED'],
  backoff: { initialDelayMs: 1_500, maxDelayMs: 15_000, jitterRatio: 0.2 },
}, 'dsh-chatgpt-subscription.antigravity-acp.retry')

/**
 * First-output budget.
 *
 * The agent may think for minutes before its first byte: the live probe on a
 * thinking model showed the prompt accepted and then silence, and this repository
 * already carries the same lesson on its Kimi line. 240 s is the value the
 * previous Antigravity line measured as safe for a thinking model.
 */
export const ACP_FIRST_OUTPUT_TIMEOUT_MS = 240_000

/** Idle budget between protocol messages once the agent has started answering. */
export const ACP_STREAM_IDLE_TIMEOUT_MS = STREAM_IDLE_TIMEOUT_MS

/** How many finished processes stay warm for the next turn. */
export const DEFAULT_IDLE_PROCESS_LIMIT = 2

/** How long a warm process may sit unused. */
export const DEFAULT_IDLE_PROCESS_TIMEOUT_MS = 300_000

/** How many turns may be in flight at once before this line refuses rather than queueing forever. */
export const DEFAULT_MAX_ACTIVE_TURNS = 4

/**
 * How many ACP sessions one agent process may open before it is recycled.
 *
 * Every turn that cannot be continued on an existing conversation creates a fresh
 * ACP session, so a warm process that is reused indefinitely accumulates sessions
 * and whatever the agent keeps beside each of them - including conversations whose
 * process outlived their parked session. The reference implementation caps this at
 * 100 and recycles; the same number is used here so the two behave alike under a
 * long session.
 */
export const DEFAULT_MAX_SESSIONS_PER_PROCESS = 100

/**
 * How many finished ACP sessions stay parked, ready for the next user message.
 *
 * A parked session pins the agent process it runs on, and that process is not
 * small (244 MB in the reference report). Two is the number of conversations a
 * person is realistically switching between; beyond that the parked session is
 * recycled and its process goes back to the idle pool, which keeps the spawn
 * cheap even when the conversation is not.
 */
export const DEFAULT_DORMANT_SESSION_LIMIT = 2

/** How long one parked session stays ready before its process is recycled. */
export const DEFAULT_DORMANT_SESSION_TIMEOUT_MS = 300_000

/** Where the executable comes from. */
export interface AcpLaunch {
  /** Absolute path of the executable. */
  command: string
  /** Arguments that select ACP stdio mode (`acp` plus any flags). */
  args: string[]
  /** Version string when the resolver could read one. */
  version?: string
}

/** The catalog view this adapter advertises. */
export interface AcpCatalogView {
  models: AntigravityAcpModelDto[]
  /** True when this is a rehydrated snapshot rather than a live read. */
  synced: boolean
}

/** Options this adapter is constructed with. */
export interface AntigravityAcpAdapterOptions {
  /** This line's own preferences. */
  settings: AntigravityAcpSettingsStore
  /** Resolve the executable; rejects with a user-readable message when none is usable. */
  resolveLaunch(): Promise<AcpLaunch>
  /** Read the live catalogue, or undefined while the line cannot reach the agent. */
  loadCatalog(options?: { signal?: AbortSignal }): Promise<AcpCatalogView | undefined>
  /** Durable image reader for prompt images. */
  attachments?: AttachmentImageReader
  /** Working directory each ACP session is created in. */
  cwd?(): string
  /** Test seam: construct the protocol client for one process. */
  spawnClient?(launch: AcpLaunch, cwd: string, handlers: AcpClientHandlers): AcpClient
  /** Idle warm processes to keep for the next turn. */
  idleProcessLimit?: number
  /** How long one warm process may sit idle. */
  idleProcessTimeoutMs?: number
  /** Turns allowed in flight at once. */
  maxActiveTurns?: number
  /** ACP sessions one warm process may open before it is recycled. */
  maxSessionsPerProcess?: number
  /** Finished ACP sessions kept ready for the next user message. */
  dormantSessionLimit?: number
  /** How long one parked session may sit unused. */
  dormantSessionTimeoutMs?: number
  /** Clock seam. */
  now?(): number
}

/** One in-flight ACP prompt, kept alive across the tool round trip. */
interface LiveTurn {
  dshSessionId: string
  client: AcpClient
  bridge: McpBridge
  acpSessionId: string
  /** How many leading DSH messages this prompt already covers. */
  covered: number
  /** Digest of that covered range. */
  fingerprint: string
  model: string
  effort: string | undefined
  queue: UpdateQueue
  /** Settlement of the `session/prompt` request. */
  settled: { stopReason?: string; usage?: TokenUsage; error?: Error } | undefined
  /** Bridge calls already surfaced to the harness, by call id. */
  surfaced: Set<string>
  /** Native tool calls already reported to the user, by call id. */
  notedNative: Set<string>
  /** Decided at turn start: report native tool use, or fail the turn at the first one. */
  nativeToolPolicy: AntigravityAcpNativeToolPolicy
  startedAt: number
  /** Set once the turn has emitted a tool call and is waiting for the harness. */
  awaitingHarness: boolean
  /** ACP sessions this client has opened so far, carried into the idle pool. */
  sessionsUsed: number
  /** Digest of the tool catalogue this turn's bridge exposes. */
  tools: string
  /**
   * Whether this turn may leave its session parked for the next one.
   *
   * False for auxiliary requests. A session-title or compaction call runs on the
   * same DSH session id but carries a history of its own; parking it would replace
   * the real conversation with a transcript nobody is talking to.
   */
  parkable: boolean
}

/**
 * One finished ACP session, kept alive between the harness's generations.
 *
 * Parked rather than released: the conversation inside the agent is the whole
 * point. The process is held with it because ACP binds a session to a connection,
 * and the bridge is held because its endpoint is what the agent's own tool list
 * points at.
 */
interface DormantTurn {
  dshSessionId: string
  client: AcpClient
  bridge: McpBridge
  acpSessionId: string
  /** How many leading DSH messages the agent already knows about. */
  covered: number
  /** Digest of that covered range, as it was when the agent was told. */
  fingerprint: string
  /** Digest of the tool catalogue the session was created with. */
  tools: string
  model: string
  effort: string | undefined
  sessionsUsed: number
  /** Idle timer that recycles the process. */
  timer: ReturnType<typeof setTimeout> | undefined
}

/** The parts of a turn that outlive it, for handing the process back. */
interface ReleasableTurn {
  client: AcpClient
  bridge: McpBridge
  queue?: UpdateQueue
  sessionsUsed?: number
}

/** A tiny async queue of ACP updates with wake-on-push semantics. */
class UpdateQueue {
  private readonly items: Record<string, unknown>[] = []
  private waiter: (() => void) | undefined
  private closed = false

  push(update: Record<string, unknown>): void {
    if (this.closed) return
    this.items.push(update)
    this.wake()
  }

  close(): void {
    this.closed = true
    this.wake()
  }

  take(): Record<string, unknown> | undefined {
    return this.items.shift()
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (this.items.length > 0 || this.closed) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const done = (): void => {
        this.waiter = undefined
        signal?.removeEventListener('abort', done)
        resolve()
      }
      this.waiter = done
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  private wake(): void {
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.()
  }
}

/** The adapter itself. */
export class AntigravityAcpAdapter extends LlmAdapter {
  private readonly live = new Map<string, LiveTurn>()
  /** Finished sessions, keyed by DSH session, waiting for the next user message. */
  private readonly dormant = new Map<string, DormantTurn>()
  private readonly idle: Array<{ client: AcpClient; timer: ReturnType<typeof setTimeout>; sessions: number }> = []
  private activeTurns = 0
  private lastUsage: AntigravityAcpUsageDto | undefined
  /**
   * Context occupancy reported by `usage_update`, when the server sends it.
   *
   * Kept apart from {@link lastUsage} on purpose: occupancy is how full the
   * context window is, not how many tokens a turn billed, and collapsing the two
   * is how a card ends up showing a fabricated cost.
   */
  private lastOccupancy: { used: number; size: number; at: number } | undefined

  constructor(private readonly options: AntigravityAcpAdapterOptions) {
    super()
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: localizedProviderName(provider, PROVIDER_NAME) }
  }

  providerRetryPolicy(): ResolvedRetryPolicy {
    return RETRY_POLICY
  }

  /** Token counts of the last completed turn, for the status card. */
  usage(): AntigravityAcpUsageDto | undefined {
    return this.lastUsage
  }

  /** Context occupancy of the live turn, when the server reported it. */
  occupancy(): { used: number; size: number; at: number } | undefined {
    return this.lastOccupancy
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const view = await this.options.loadCatalog().catch(() => undefined)
    const settings = await this.options.settings.read()
    if (!settings.enabled) return []
    return this.visibleModels(view?.models ?? [], settings).map((model) => toModelInfo(provider, model))
  }

  async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const view = await this.options.loadCatalog({ signal }).catch(() => undefined)
    return toResolvedModelInfo(provider, findModel(view?.models ?? [], model))
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  stream(options: HarnessGenerateOptions): AsyncIterable<StreamChunk> {
    return wrapStreamWithWatchdog(
      (watchdogSignal, activity) => this.runAsIterable(options, watchdogSignal, activity),
      options.signal,
      ACP_STREAM_IDLE_TIMEOUT_MS,
      STREAM_IDLE_TIMEOUT_CODE,
      PROVIDER_NAME,
      ACP_FIRST_OUTPUT_TIMEOUT_MS,
    )
  }

  /** Close every process this adapter owns. */
  async dispose(): Promise<void> {
    for (const entry of [...this.dormant.values()]) await this.closeDormant(entry)
    for (const turn of [...this.live.values()]) {
      if (this.live.get(turn.dshSessionId) === turn) this.live.delete(turn.dshSessionId)
      this.activeTurns = Math.max(0, this.activeTurns - 1)
      turn.queue.close()
      this.cancelTurn(turn)
      await turn.bridge.close().catch(() => undefined)
      await turn.client.dispose().catch(() => undefined)
    }
    this.live.clear()
    // Dormant sessions parked their processes here on the way out; dispose drains
    // the pool last so nothing is left listening after the adapter is gone.
    for (const entry of this.idle.splice(0)) {
      clearTimeout(entry.timer)
      await entry.client.dispose().catch(() => undefined)
    }
  }

  /**
   * Resolve which turn this generation belongs to, then hand back its stream.
   *
   * Setup is `await`ed before the first chunk on purpose: a failure to resolve
   * the executable or create the ACP session must surface as a rejected stream,
   * not as an empty answer.
   */
  private async *runAsIterable(
    options: HarnessGenerateOptions,
    signal: AbortSignal,
    activity: { pulse(): void },
  ): AsyncGenerator<StreamChunk> {
    yield* await this.run(options, signal, activity)
  }

  private async run(
    rawOptions: HarnessGenerateOptions,
    signal: AbortSignal,
    activity: { pulse(): void },
  ): Promise<AsyncGenerator<StreamChunk>> {
    const options = normalizeGenerateOptions(rawOptions)
    // ACP's session/prompt carries content only: there is no temperature and no
    // stop sequence, and those are refused rather than dropped - a caller that
    // asked for one would otherwise believe it took effect.
    //
    // `maxTokens` is the exception: the harness's own auxiliary calls pass one
    // (session titles ask for a small cap, compaction for a headroom cap), and
    // refusing them turned every session title on this line into a failure. The
    // cap is dropped instead, and the drop is recorded on the request so nothing
    // downstream mistakes the answer for a capped one.
    assertNoSamplingControls(options)
    const dshSessionId = String(options.sessionId ?? 'unscoped-session')
    const settings = await this.options.settings.read()
    const images = await resolveRequestImages(options, this.options.attachments, signal)
      .catch((): ResolvedRequestImages => NO_RESOLVED_IMAGES)
    const effort = options.reasoningEffort === undefined
      ? settings.defaultReasoningEffort ?? undefined
      : String(options.reasoningEffort)

    const live = this.live.get(dshSessionId)
    if (live !== undefined && live.model === options.model && live.effort === effort
      && canContinue(options.messages, live.covered, live.fingerprint)) {
      return this.continueTurn(live, options, images, signal, activity)
    }
    if (live !== undefined) await this.closeTurn(live)

    // Auxiliary requests - session titles, compaction - reuse this DSH session id
    // while carrying a history of their own. They must neither consume the parked
    // conversation nor be parked over it, so they go straight to a cold turn.
    const auxiliary = options.purpose !== undefined
    // A session parked by the previous turn is both the cheapest and the most
    // faithful continuation available: the agent already holds this conversation,
    // so only what the harness appended since is sent. It is used only while the
    // two transcripts still agree - see `usableDormant`.
    const dormant = auxiliary ? undefined : this.dormant.get(dshSessionId)
    if (dormant !== undefined) {
      if (this.usableDormant(dormant, options)) {
        const resumed = await this.resumeDormant(dormant, options, settings, effort, images, signal, activity)
        if (resumed !== undefined) return resumed
        // A session that could not be reconfigured or prompted has already been
        // handed back inside `resumeDormant`; the turn falls through to a cold one.
      } else {
        await this.closeDormant(dormant)
      }
    }
    return this.startTurn(dshSessionId, options, settings, images, effort, signal, activity, !auxiliary)
  }

  /** Start a fresh ACP session for one generation and stream its answer. */
  private async startTurn(
    dshSessionId: string,
    options: GenerateOptions,
    settings: AntigravityAcpSettings,
    images: ResolvedRequestImages,
    effort: string | undefined,
    signal: AbortSignal,
    activity: { pulse(): void },
    parkable: boolean,
  ): Promise<AsyncGenerator<StreamChunk>> {
    const limit = this.options.maxActiveTurns ?? DEFAULT_MAX_ACTIVE_TURNS
    if (this.activeTurns >= limit) {
      throw new LlmError(
        `${PROVIDER_NAME} already has ${this.activeTurns} turns in flight; wait for one to finish before starting another.`,
        'RATE_LIMIT',
      )
    }
    this.activeTurns += 1
    const queue = new UpdateQueue()
    const bridge = new McpBridge(options.tools ?? [])
    let client: AcpClient | undefined
    let reusedSessions = 0
    try {
      const launch = await this.options.resolveLaunch()
      // Check out a warm process instead of spawning one per turn. The pool used
      // to be write-only (processes were parked and then expired unused), which
      // made every generation pay a cold start.
      const warm = this.checkoutIdle()
      if (warm !== undefined) {
        client = warm.client
        reusedSessions = warm.sessions
        this.attachHandlers(client, queue, activity)
      } else {
        client = this.spawn(launch, queue, activity)
      }
      const descriptor = await bridge.start()
      const sessionId = await this.openSession(client, options, [descriptor], settings)
      await this.applyModelAndEffort(client, sessionId, options.model, effort)
      const prompt = buildPrompt(options, images, 0)
      // When a bridge is attached the agent must not touch the workspace itself;
      // see BRIDGE_ONLY_INSTRUCTION for why this is said in the prompt rather than
      // enforced by the protocol.
      if ((options.tools ?? []).length > 0) {
        prompt.blocks.unshift({ type: 'text', text: BRIDGE_ONLY_INSTRUCTION })
      }
      const turn: LiveTurn = {
        dshSessionId,
        client,
        bridge,
        acpSessionId: sessionId,
        covered: prompt.coveredMessages,
        fingerprint: prompt.fingerprint,
        model: options.model,
        effort,
        queue,
        settled: undefined,
        surfaced: new Set(),
        notedNative: new Set(),
        nativeToolPolicy: settings.nativeToolPolicy,
        startedAt: this.now(),
        awaitingHarness: false,
        sessionsUsed: reusedSessions + 1,
        tools: fingerprintTools(options.tools),
        parkable,
      }
      this.live.set(dshSessionId, turn)
      void this.sendPrompt(turn, prompt.blocks)
      return this.pump(turn, signal, activity)
    } catch (error) {
      this.activeTurns = Math.max(0, this.activeTurns - 1)
      await bridge.close().catch(() => undefined)
      await client?.dispose().catch(() => undefined)
      throw asLlmError(error)
    }
  }

  /** Continue the live turn after the harness executed its tools. */
  private continueTurn(
    turn: LiveTurn,
    options: GenerateOptions,
    images: ResolvedRequestImages,
    signal: AbortSignal,
    activity: { pulse(): void },
  ): AsyncGenerator<StreamChunk> {
    const results = collectToolResults(options.messages.slice(turn.covered), images)
    for (const callId of [...turn.surfaced]) {
      const outcome = results.get(callId)
      turn.bridge.settle(callId, outcome === undefined
        ? { text: 'The harness did not return a result for this tool call.', isError: true }
        : outcome)
      turn.surfaced.delete(callId)
    }
    turn.awaitingHarness = false
    turn.covered = options.messages.length
    turn.fingerprint = fingerprintMessages(options.messages, 0, options.messages.length)
    return this.pump(turn, signal, activity)
  }

  /** Drain one turn's updates, yielding harness chunks as they arrive. */
  private async *pump(
    turn: LiveTurn,
    signal: AbortSignal,
    activity: { pulse(): void },
  ): AsyncGenerator<StreamChunk> {
    let textIndex: number | undefined
    let text = ''
    let reasoningIndex: number | undefined
    let reasoning = ''
    let nextIndex = 0
    let finished = false
    let yieldedUsage = false

    const closeBlocks = function* (): Generator<StreamChunk> {
      if (textIndex !== undefined) {
        yield { type: 'block-end', index: textIndex, block: { type: 'text', text } }
        textIndex = undefined
      }
      if (reasoningIndex !== undefined) {
        yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoning } }
        reasoningIndex = undefined
      }
    }

    try {
      for (;;) {
        if (signal.aborted) throw abortError()
        const update = turn.queue.take()
        if (update !== undefined) {
          activity.pulse()
          const type = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : ''
          if (type === 'process_exit') {
            const detail = asRecord(update.detail)
            throw acpError(
              'ACP_DISCONNECTED',
              `(code ${String(detail?.code ?? 'null')}, signal ${String(detail?.signal ?? 'none')}).`,
            )
          }
          if (type === 'usage_update') {
            // The ACP schema defines `usage_update` as CONTEXT OCCUPANCY
            // (`used` / `size`), not as a billable token count, and the live server
            // this line was written against does not send it at all. It is recorded
            // as an occupancy reading when it appears and never converted into a
            // token count that was not measured.
            const occupancy = readOccupancy(update)
            if (occupancy !== undefined) this.lastOccupancy = { ...occupancy, at: this.now() }
            continue
          }
          if (type === 'agent_message_chunk' || type === 'agent_thought_chunk') {
            const chunk = readChunkText(update)
            if (chunk !== '') {
              if (type === 'agent_message_chunk') {
                if (reasoningIndex !== undefined) {
                  yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoning } }
                  reasoningIndex = undefined
                  reasoning = ''
                }
                if (textIndex === undefined) {
                  textIndex = nextIndex
                  nextIndex += 1
                  yield { type: 'block-start', index: textIndex, blockType: 'text' }
                }
                text += chunk
                yield { type: 'text-delta', index: textIndex, text: chunk }
              } else {
                if (reasoningIndex === undefined) {
                  reasoningIndex = nextIndex
                  nextIndex += 1
                  yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
                }
                reasoning += chunk
                yield { type: 'reasoning-delta', index: reasoningIndex, text: chunk }
              }
            }
            continue
          }
          // A tool_call that does NOT name our bridge is the agent acting on its
          // own: it modifies the workspace through the official process, outside
          // DSH's permission presets, sandbox policy and durable tool records.
          //
          // ACP cannot unload those tools, so the client has two honest options and
          // this line offers both (see `nativeToolPolicy`). The strict one fails
          // the turn the moment one is reported. The default one records the call
          // in the transcript and lets the turn continue, because a cancelled turn
          // is what made a working multi-step task look like an empty answer: the
          // model reaches for `run_command`, the client refuses, and the agent has
          // nothing left to say.
          if (type === 'tool_call' || type === 'tool_call_update') {
            const native = readNativeToolCall(update)
            if (native !== undefined) {
              if (turn.nativeToolPolicy === 'cancel') {
                throw acpError('ACP_NATIVE_TOOLS_UNSUPPORTED', `Tool: ${native.name}.`)
              }
              // One note per call: an update reports the same call's progress, and
              // repeating the sentence for every status change would drown the
              // answer it is attached to.
              if (type === 'tool_call' && !turn.notedNative.has(native.callId)) {
                turn.notedNative.add(native.callId)
                const note = nativeToolNote(native, readNativeToolArguments(update))
                if (textIndex === undefined) {
                  textIndex = nextIndex
                  nextIndex += 1
                  yield { type: 'block-start', index: textIndex, blockType: 'text' }
                }
                text += note
                yield { type: 'text-delta', index: textIndex, text: note }
              }
            }
          }
          continue
        }

        const parked = turn.bridge.takeParked()
        if (parked.length > 0) {
          for (const call of parked) {
            turn.surfaced.add(call.callId)
            const id = toToolCallId(call.callId)
            const index = nextIndex
            nextIndex += 1
            yield { type: 'block-start', index, blockType: 'tool-call' }
            yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: call.argumentsText }
            yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: call.argumentsText } }
          }
          turn.awaitingHarness = true
          yield* closeBlocks()
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          finished = true
          break
        }

        const settled = turn.settled
        if (settled !== undefined) {
          if (settled.error !== undefined) throw asLlmError(settled.error)
          if (settled.usage !== undefined && !yieldedUsage) {
            yieldedUsage = true
            yield { type: 'usage', usage: settled.usage }
          }
          yield* closeBlocks()
          const reason = settleReason(settled.stopReason)
          if (reason.kind === 'error') throw new LlmError(reason.failure.message, 'SERVER')
          yield {
            type: 'finish',
            reason: reason.kind === 'aborted'
              ? { kind: 'aborted', failure: reason.failure }
              : { kind: reason.kind },
          }
          finished = true
          break
        }

        await Promise.race([
          turn.queue.wait(signal),
          turn.bridge.waitForWork(signal),
          delay(200),
        ])
      }
    } finally {
      if (!finished) {
        // The caller stopped consuming mid turn - a cancel, a failed stream, a dead
        // process. The prompt may still be running inside the agent, so it is
        // cancelled before the process is handed back: an abandoned prompt is what
        // the next turn would otherwise race.
        await this.closeTurn(turn)
      } else if (!turn.awaitingHarness && this.live.get(turn.dshSessionId) === turn) {
        // A turn that ended without a tool round is complete. Its ACP session is
        // parked instead of dropped, so the next user message is an increment on
        // the conversation the agent already has. A tool round keeps it live.
        this.live.delete(turn.dshSessionId)
        this.activeTurns = Math.max(0, this.activeTurns - 1)
        if (turn.parkable) await this.park(turn)
        else await this.release(turn)
      }
    }
  }

  /**
   * Answer one `session/request_permission`.
   *
   * Two different requests arrive here and they do not deserve the same answer.
   * A request for a call the agent makes on the bridge is the agent asking to run
   * a DSH tool; the bridge already hands that call to the harness, which applies
   * its own permission presets, so refusing it here would deny the very route
   * this line exists to provide. A request for the agent's own tool is answered
   * by `permissionPolicy`, because nothing downstream of it is governed by DSH.
   *
   * @param params - The request payload, including the tool call it is about.
   * @returns The option id to select, or undefined to answer `cancelled`.
   */
  private async answerPermission(params: Record<string, unknown>): Promise<string | undefined> {
    const options = readPermissionOptions(params)
    const answer = (): string | undefined =>
      options.find((option) => option.kind === 'allow_once')?.optionId
        ?? options.find((option) => option.kind === 'allow_always')?.optionId
    const toolCall = asRecord(params.toolCall)
    const name = typeof toolCall?.name === 'string' ? toolCall.name : ''
    // A bridge call is a DSH tool call wearing an MCP name: the harness applies its
    // own permission preset to it after the bridge hands it over, so answering
    // "cancelled" here would refuse the route instead of governing it. The name is
    // what decides; a request that does not name its tool keeps the strict answer.
    if (name.startsWith(`mcp_${BRIDGE_SERVER_NAME}_`)) return answer()
    const settings = await this.options.settings.read()
    return settings.permissionPolicy === 'allow' ? answer() : undefined
  }

  private spawn(
    launch: AcpLaunch,
    queue: UpdateQueue,
    activity: { pulse(): void },
  ): AcpClient {
    const handlers: AcpClientHandlers = {
      onSessionUpdate: (_sessionId, update) => {
        queue.push(update)
        activity.pulse()
      },
      onPermissionRequest: async (_sessionId, params) => this.answerPermission(params),
      onExit: (detail) => {
        queue.push({
          sessionUpdate: 'process_exit',
          detail: { code: detail.code ?? null, signal: detail.signal ?? null },
        })
      },
      onActivity: () => activity.pulse(),
    }
    const cwd = this.cwd()
    if (this.options.spawnClient !== undefined) return this.options.spawnClient(launch, cwd, handlers)
    return new AcpClient({ command: launch.command, args: launch.args, cwd }, handlers)
  }

  private cwd(): string {
    return this.options.cwd?.() ?? process.cwd()
  }

  private async openSession(
    client: AcpClient,
    options: GenerateOptions,
    mcpServers: BridgeDescriptor[],
    settings: AntigravityAcpSettings,
  ): Promise<string> {
    void settings
    const init = asRecord(await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'dsh-chatgpt-subscription', version: '1.0.0' },
    }, options.signal))
    const authMethods = Array.isArray(init?.authMethods)
      ? init.authMethods
        .map((entry) => String((entry as Record<string, unknown>).id ?? ''))
        .filter((id) => id !== '')
      : []
    const create = async (): Promise<string> => {
      const result = asRecord(await client.request('session/new', { cwd: this.cwd(), mcpServers }, options.signal))
      const sessionId = typeof result?.sessionId === 'string' ? result.sessionId : undefined
      if (sessionId === undefined) throw new LlmError('Antigravity ACP did not return a session id.', 'INVALID_RESPONSE')
      return sessionId
    }
    try {
      return await create()
    } catch (error) {
      if (!needsAuth(error, authMethods)) throw error
      // The agent answers `Authentication required` when it holds no credentials.
      // `authenticate` hands the sign-in to the official process, which is the
      // only thing that ever sees a token.
      await client.request('authenticate', { methodId: preferAuthMethod(authMethods) }, options.signal)
      return create()
    }
  }

  private async applyConfig(client: AcpClient, sessionId: string, configId: string, value: string): Promise<Record<string, unknown> | undefined> {
    try {
      return asRecord(await client.request('session/set_config_option', { sessionId, configId, value }))
    } catch (error) {
      throw new LlmError(
        `Antigravity ACP rejected ${configId} "${value}": ${error instanceof Error ? error.message : String(error)}`,
        'UNSUPPORTED_OPTION',
      )
    }
  }

  /**
   * Select the model, then the thinking level, falling back to the model variant
   * the server publishes for a level the current model does not list.
   *
   * `thought_level` is scoped to the model the session already has selected, so
   * it is applied after the model. The previous order set the level first and
   * replaced the model after it, which kept the level of the model the session
   * started on. Some models publish a level as a model variant instead of a
   * thinking level (`gemini-4-hydrogen-xhigh`): selecting that variant is what
   * makes the server accept the fourth level.
   *
   * @param client - The connection running this turn.
   * @param sessionId - The ACP session the turn belongs to.
   * @param model - The model the caller asked for.
   * @param effort - The requested thinking level, when the caller or settings named one.
   */
  private async applyModelAndEffort(
    client: AcpClient,
    sessionId: string,
    model: string,
    effort: string | undefined,
  ): Promise<void> {
    const afterModel = await this.applyConfig(client, sessionId, 'model', model)
    if (effort === undefined) return
    const levels = configOptionValues(afterModel, 'thought_level')
    // No options in the answer means the server said nothing about the ladder;
    // the level is still sent, because the old server accepted it that way.
    if (levels === undefined || levels.includes(effort)) {
      await this.applyConfigQuietly(client, sessionId, 'thought_level', effort)
      return
    }
    // A level the model does not list as an option but does publish as a variant
    // is selected as that variant; one it publishes nowhere stays unapplied.
    await this.applyConfigQuietly(client, sessionId, 'model', `${model}-${effort}`)
  }

  private async applyConfigQuietly(client: AcpClient, sessionId: string, configId: string, value: string): Promise<void> {
    // A thinking level the account does not publish for this model is dropped
    // rather than failing the turn: the caller's level is a preference, and the
    // agent has its own default to fall back to.
    await client.request('session/set_config_option', { sessionId, configId, value }).catch(() => undefined)
  }

  private async sendPrompt(turn: LiveTurn, blocks: AcpPromptBlock[]): Promise<void> {
    const startedAt = this.now()
    try {
      const result = asRecord(await turn.client.request('session/prompt', {
        sessionId: turn.acpSessionId,
        prompt: blocks,
      }))
      const usage = asRecord(result?.usage)
      turn.settled = {
        stopReason: typeof result?.stopReason === 'string' ? result.stopReason : 'end_turn',
        ...(usage === undefined ? {} : { usage: readUsage(usage) }),
      }
      if (usage !== undefined) {
        const read = readUsage(usage)
        if (read !== undefined) {
          this.lastUsage = { ...read, at: this.now(), durationMs: this.now() - startedAt }
        }
      }
    } catch (error) {
      turn.settled = { error: asError(error) }
    } finally {
      turn.queue.push({ sessionUpdate: 'prompt_settled' })
    }
  }

  /**
   * Abandon one live turn.
   *
   * The turn cannot be resumed by the harness any more, so its prompt is cancelled
   * and its process is handed back to the pool. Disposing the process instead -
   * what this used to do - made every cancellation pay a fresh spawn and the
   * agent's own start-up wait on the next message.
   */
  private async closeTurn(turn: LiveTurn): Promise<void> {
    if (this.live.get(turn.dshSessionId) === turn) this.live.delete(turn.dshSessionId)
    this.activeTurns = Math.max(0, this.activeTurns - 1)
    turn.queue.close()
    this.cancelTurn(turn)
    await this.release(turn)
  }

  /**
   * Ask the agent to stop the prompt this turn left running.
   *
   * `session/cancel` is an ACP notification, not a request, so it is written
   * without waiting for an answer: a prompt that already settled ignores it, and a
   * client that waited would hang on a server that never replies.
   */
  private cancelTurn(turn: LiveTurn): void {
    if (!turn.client.alive) return
    turn.client.notify('session/cancel', { sessionId: turn.acpSessionId })
  }

  /**
   * Whether the parked session is still a prefix of the history about to be sent.
   *
   * Three questions, and every one of them must answer yes: the process is alive,
   * the bridge still exposes the tool catalogue the agent listed (the bridge
   * publishes no change feed, so a different set cannot reach a resumed session),
   * and the harness history still begins with exactly what the agent was told.
   *
   * @param entry - The parked session.
   * @param options - The generation about to run.
   */
  private usableDormant(entry: DormantTurn, options: GenerateOptions): boolean {
    if (!entry.client.alive) return false
    if (entry.tools !== fingerprintTools(options.tools)) return false
    return canContinue(options.messages, entry.covered, entry.fingerprint)
  }

  /**
   * Continue a parked session with only what the harness added since.
   *
   * @param entry - The parked session to reuse.
   * @param options - The generation about to run.
   * @param settings - This line's own preferences, read for the native-tool policy.
   * @param effort - The thinking level this generation asked for.
   * @param images - Images resolved for this request.
   * @param signal - Caller cancellation.
   * @param activity - Watchdog pulse.
   * @returns the stream, or undefined when the session could not be reused. On
   * that path the process has already been handed back, so the caller starts a
   * cold turn rather than failing the generation.
   */
  private async resumeDormant(
    entry: DormantTurn,
    options: GenerateOptions,
    settings: AntigravityAcpSettings,
    effort: string | undefined,
    images: ResolvedRequestImages,
    signal: AbortSignal,
    activity: { pulse(): void },
  ): Promise<AsyncGenerator<StreamChunk> | undefined> {
    const limit = this.options.maxActiveTurns ?? DEFAULT_MAX_ACTIVE_TURNS
    if (this.activeTurns >= limit) return undefined
    this.dormant.delete(entry.dshSessionId)
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    const queue = new UpdateQueue()
    try {
      // A model is a config option of the conversation, not a property of the
      // process: switching it here keeps the transcript the agent already has
      // (verified against agy: carbon -> hydrogen -> carbon still answers a number
      // it was told earlier in the conversation).
      if (entry.model !== options.model || entry.effort !== effort) {
        await this.applyModelAndEffort(entry.client, entry.acpSessionId, options.model, effort)
      }
      this.attachHandlers(entry.client, queue, activity)
      const prompt = buildPrompt(options, images, entry.covered)
      const turn: LiveTurn = {
        dshSessionId: entry.dshSessionId,
        client: entry.client,
        bridge: entry.bridge,
        acpSessionId: entry.acpSessionId,
        covered: prompt.coveredMessages,
        fingerprint: prompt.fingerprint,
        model: options.model,
        effort,
        queue,
        settled: undefined,
        surfaced: new Set(),
        notedNative: new Set(),
        nativeToolPolicy: settings.nativeToolPolicy,
        startedAt: this.now(),
        awaitingHarness: false,
        sessionsUsed: entry.sessionsUsed,
        tools: entry.tools,
        parkable: true,
      }
      this.live.set(turn.dshSessionId, turn)
      this.activeTurns += 1
      void this.sendPrompt(turn, prompt.blocks)
      return this.pump(turn, signal, activity)
    } catch {
      queue.close()
      await this.release({ client: entry.client, bridge: entry.bridge, sessionsUsed: entry.sessionsUsed })
      return undefined
    }
  }

  /**
   * Keep a finished turn's session ready for the next user message.
   *
   * The bridge stays open on purpose: its endpoint is what the parked session's
   * tool list points at, and closing it would leave the agent calling a port
   * nobody answers.
   */
  private async park(turn: LiveTurn): Promise<void> {
    turn.queue.close()
    const limit = this.options.dormantSessionLimit ?? DEFAULT_DORMANT_SESSION_LIMIT
    if (limit <= 0 || !turn.client.alive) {
      await this.release(turn)
      return
    }
    const previous = this.dormant.get(turn.dshSessionId)
    if (previous !== undefined) await this.closeDormant(previous)
    const entry: DormantTurn = {
      dshSessionId: turn.dshSessionId,
      client: turn.client,
      bridge: turn.bridge,
      acpSessionId: turn.acpSessionId,
      covered: turn.covered,
      fingerprint: turn.fingerprint,
      tools: turn.tools,
      model: turn.model,
      effort: turn.effort,
      sessionsUsed: turn.sessionsUsed,
      timer: undefined,
    }
    const timer = setTimeout(() => {
      void this.closeDormant(entry)
    }, this.options.dormantSessionTimeoutMs ?? DEFAULT_DORMANT_SESSION_TIMEOUT_MS)
    timer.unref?.()
    entry.timer = timer
    this.dormant.set(turn.dshSessionId, entry)
    // Oldest first: the map keeps insertion order, and the conversation nobody is
    // in any more is the one worth giving up.
    while (this.dormant.size > limit) {
      const oldest = this.dormant.values().next().value
      if (oldest === undefined) break
      await this.closeDormant(oldest)
    }
  }

  /**
   * Drop a parked session and hand its process back to the pool.
   *
   * The conversation itself is abandoned rather than closed with `session/close`:
   * not every agent version this line supports answers that request, and a request
   * that never settles would occupy one of the client's protocol slots for the
   * life of the process. The next turn opens a fresh conversation on the same warm
   * process.
   */
  private async closeDormant(entry: DormantTurn): Promise<void> {
    if (this.dormant.get(entry.dshSessionId) === entry) this.dormant.delete(entry.dshSessionId)
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    await this.release({ client: entry.client, bridge: entry.bridge, sessionsUsed: entry.sessionsUsed })
  }

  /**
   * Take one warm process out of the pool.
   *
   * A process that has opened its session budget is disposed here rather than
   * handed back: the cap exists so a long-lived process does not accumulate
   * agent-side session state forever.
   *
   * @returns the client and the sessions it already opened, or undefined.
   */
  private checkoutIdle(): { client: AcpClient; sessions: number } | undefined {
    const cap = this.options.maxSessionsPerProcess ?? DEFAULT_MAX_SESSIONS_PER_PROCESS
    while (this.idle.length > 0) {
      const entry = this.idle.shift()
      if (entry === undefined) return undefined
      clearTimeout(entry.timer)
      if (!entry.client.alive || entry.sessions >= cap) {
        void entry.client.dispose().catch(() => undefined)
        continue
      }
      return { client: entry.client, sessions: entry.sessions }
    }
    return undefined
  }

  /** Re-install per-turn handlers on a reused client. */
  private attachHandlers(
    client: AcpClient,
    queue: UpdateQueue,
    activity: { pulse(): void },
  ): void {
    client.rebind({
      onSessionUpdate: (_sessionId, update) => {
        queue.push(update)
        activity.pulse()
      },
      onPermissionRequest: async (_sessionId, params) => this.answerPermission(params),
      onExit: (detail) => {
        queue.push({ sessionUpdate: 'process_exit', detail: { code: detail.code ?? null, signal: detail.signal ?? null } })
      },
      onActivity: () => activity.pulse(),
    })
  }

  /** Hand one turn's process back to the idle pool, disposing it when it is spent. */
  private async release(turn: ReleasableTurn): Promise<void> {
    turn.queue?.close()
    await turn.bridge.close().catch(() => undefined)
    const limit = this.options.idleProcessLimit ?? DEFAULT_IDLE_PROCESS_LIMIT
    const cap = this.options.maxSessionsPerProcess ?? DEFAULT_MAX_SESSIONS_PER_PROCESS
    const sessionsUsed = turn.sessionsUsed ?? 1
    if (limit <= 0 || !turn.client.alive || sessionsUsed >= cap) {
      await turn.client.dispose().catch(() => undefined)
      return
    }
    const client = turn.client
    const timer = setTimeout(() => {
      const index = this.idle.findIndex((entry) => entry.client === client)
      if (index >= 0) this.idle.splice(index, 1)
      void client.dispose().catch(() => undefined)
    }, this.options.idleProcessTimeoutMs ?? DEFAULT_IDLE_PROCESS_TIMEOUT_MS)
    timer.unref?.()
    this.idle.push({ client, timer, sessions: sessionsUsed })
    while (this.idle.length > limit) {
      const oldest = this.idle.shift()
      if (oldest === undefined) break
      clearTimeout(oldest.timer)
      await oldest.client.dispose().catch(() => undefined)
    }
  }

  private visibleModels(
    models: readonly AntigravityAcpModelDto[],
    settings: AntigravityAcpSettings,
  ): AntigravityAcpModelDto[] {
    const enabled = settings.enabledModelIds
    if (enabled === null) return [...models]
    const allowed = new Set(enabled)
    return models.filter((model) => allowed.has(model.id))
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}

/**
 * The instruction prepended to every prompt while a bridge is attached.
 *
 * ACP gives the agent its own tools, and a native `write_file` would modify the
 * workspace without passing through this harness at all - no permission prompt,
 * no sandbox policy, no durable tool-result record. The bridge cannot unload
 * them, so the only defence that costs nothing is to say so: the agent is told
 * that its own filesystem and terminal tools are unavailable for this turn and
 * that every action must go through the provided tool.
 *
 * This is a protocol-level guardrail, not an OS sandbox: an agent that ignores
 * it can still act. The adapter detects that case separately (see
 * `assertNoNativeTool`) and cancels the turn rather than letting it continue.
 */
export const BRIDGE_ONLY_INSTRUCTION = [
  'This turn runs inside an external coding harness.',
  'Your own file-editing, file-writing and shell tools are NOT available and will not be executed by the client.',
  'For every file read, file change, command or other action, call one of the provided tools instead.',
  'If no provided tool covers what you need, stop and say so rather than acting directly.',
].join(' ')

/**
 * Tool results keyed by the call id they answer, from the newly appended messages.
 *
 * A result is not always text. `read_image` and a screenshot tool answer with an
 * image block, and keeping only the text half of that handed the agent an empty
 * string - a successful call it could not tell from a tool that returned
 * nothing. Image blocks are therefore resolved and carried back as MCP `image`
 * content; the byte budget is the same one the prompt uses, because both paths
 * end up inline in the agent's context.
 *
 * @param messages - The messages appended since the turn last handed work over.
 * @param images - Images resolved for this request, keyed by attachment id.
 * @returns One outcome per answered call id.
 */
function collectToolResults(
  messages: readonly { content: readonly ContentBlock[] }[],
  images: ResolvedRequestImages,
): Map<string, ToolCallOutcome> {
  const results = new Map<string, ToolCallOutcome>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'tool-result') continue
      const result = block as ToolResultBlock
      const text = result.content
        .map((entry) => (entry.type === 'text' ? entry.text : ''))
        .filter((part) => part !== '')
        .join('\n')
      const carried: ToolCallImage[] = []
      let budget = ACP_MAX_INLINE_IMAGE_BYTES
      for (const entry of result.content) {
        if (entry.type !== 'image') continue
        const inline = imageBlockToInline(entry as unknown as Record<string, unknown>, images)
        if (inline === undefined) continue
        const bytes = Math.ceil(inline.data.length * 0.75)
        // Over budget means the picture is described, not silently dropped: the
        // agent has to know something was there and did not fit.
        if (bytes > budget) continue
        budget -= bytes
        carried.push({ mediaType: inline.mediaType, data: inline.data })
      }
      results.set(result.toolCallId, {
        text,
        ...(carried.length === 0 ? {} : { images: carried }),
        isError: result.isError === true,
      })
    }
  }
  return results
}

/**
 * Refuse the sampling controls ACP cannot express.
 *
 * `temperature` and `stop` change what the model produces, so accepting a request
 * that carries one and then ignoring it would answer a different question than
 * the caller asked. `maxTokens` is deliberately not in that set: it bounds an
 * answer the caller still reads in full, and the harness's own auxiliary calls
 * (session titles, compaction) always send one. Refusing it made every title on
 * this line fail; dropping it costs only the bound, and the bound is the one
 * thing ACP genuinely cannot express.
 *
 * @param options - The normalized request.
 */
function assertNoSamplingControls(options: GenerateOptions): void {
  const unsupported: string[] = []
  if (options.temperature !== undefined) unsupported.push('temperature')
  if (options.stop !== undefined && options.stop.length > 0) unsupported.push('stop')
  if (unsupported.length === 0) return
  throw acpError(
    'ACP_UNSUPPORTED_OPTION',
    `Unsupported: ${unsupported.join(', ')}. Antigravity through ACP has no sampling controls; choose a model variant instead of a stop sequence.`,
  )
}

/**
 * Read one `tool_call`/`tool_call_update` as the agent's own tool, or as the bridge.
 *
 * The official server prefixes its MCP tool names with the server name it was
 * given (`mcp_dsh-bridge_<tool>`); everything else is the agent's own tool. What
 * the caller does with that answer depends on `nativeToolPolicy`: this function
 * only classifies, so the two policies share one definition of "native".
 *
 * @param update - One `session/update` payload.
 * @returns The call's id and name when it is a native call; undefined for the bridge.
 */
function readNativeToolCall(update: Record<string, unknown>): { callId: string; name: string } | undefined {
  const name = typeof update.name === 'string' ? update.name : ''
  if (name === '' || name.startsWith(`mcp_${BRIDGE_SERVER_NAME}_`)) return undefined
  const callId = typeof update.toolCallId === 'string' ? update.toolCallId : ''
  return { callId, name }
}

/**
 * The transcript line that records one native tool call.
 *
 * Written into the answer rather than logged, because the user is the one who
 * has to know the action did not pass through DSH. It names the tool and its
 * arguments and nothing else: a note that paraphrased the arguments would be a
 * second, unverified account of what the agent did.
 *
 * @param native - The call being reported.
 * @param args - Its raw argument text, when the update carried one.
 * @returns One sentence, ending in a newline so the model's own text starts fresh.
 */
function nativeToolNote(native: { name: string }, args: string): string {
  const call = args === '' ? native.name : `${native.name} ${args}`
  return t('antigravityAcp.nativeTool', { call })
}

/**
 * The raw argument text one native call was reported with.
 *
 * ACP spells the arguments `rawInput` on `tool_call`, and the live server also
 * sends `title` (a one-line description of the action) rather than a JSON body.
 * Both are read, in that order, and neither is invented: a call reported without
 * either is shown by name alone.
 *
 * @param update - One `session/update` payload.
 * @returns The argument or title text, or an empty string when it carried none.
 */
function readNativeToolArguments(update: Record<string, unknown>): string {
  const raw = update.rawInput
  if (typeof raw === 'string' && raw !== '') return raw
  if (typeof raw === 'object' && raw !== null) {
    try {
      return JSON.stringify(raw)
    } catch {
      return ''
    }
  }
  const title = update.title
  return typeof title === 'string' ? title : ''
}

/**
 * Read one `usage_update` as context occupancy.
 *
 * @param update - One `session/update` payload.
 * @returns `used`/`size` when both are present numbers; undefined otherwise.
 */
function readOccupancy(update: Record<string, unknown>): { used: number; size: number } | undefined {
  const used = numberField(update.used)
  const size = numberField(update.size)
  if (used === undefined || size === undefined || size <= 0) return undefined
  return { used, size }
}

function readChunkText(update: Record<string, unknown>): string {
  const content = update.content
  if (typeof content === 'string') return content
  if (typeof content === 'object' && content !== null) {
    const text = (content as Record<string, unknown>).text
    if (typeof text === 'string') return text
  }
  return ''
}

function readPermissionOptions(params: Record<string, unknown>): Array<{ optionId: string; kind: string }> {
  const raw = params.options
  if (!Array.isArray(raw)) return []
  const options: Array<{ optionId: string; kind: string }> = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (typeof record.optionId !== 'string') continue
    options.push({ optionId: record.optionId, kind: typeof record.kind === 'string' ? record.kind : '' })
  }
  return options
}

function needsAuth(error: unknown, authMethods: readonly string[]): boolean {
  if (error instanceof AcpError && error.code === ACP_AUTH_REQUIRED_CODE) return true
  const message = error instanceof Error ? error.message : String(error)
  return /authentication required/i.test(message) && authMethods.length > 0
}

function preferAuthMethod(authMethods: readonly string[]): string {
  for (const candidate of ['oauth-personal', 'terminal-login', 'oauth-business', 'gemini-api-key', 'agent-platform']) {
    if (authMethods.includes(candidate)) return candidate
  }
  return authMethods[0] ?? 'oauth-personal'
}

function readUsage(raw: Record<string, unknown>): TokenUsage | undefined {
  const input = numberField(raw.inputTokens)
  const output = numberField(raw.outputTokens)
  if (input === undefined || output === undefined) return undefined
  const cached = numberField(raw.cachedReadTokens)
  const thought = numberField(raw.thoughtTokens)
  return {
    inputTokens: input,
    outputTokens: output,
    ...(cached === undefined ? {} : { cacheReadTokens: cached }),
    ...(thought === undefined ? {} : { reasoningTokens: thought }),
    ...(numberField(raw.totalTokens) === undefined ? {} : { totalTokens: numberField(raw.totalTokens) }),
  }
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

type SettleReason =
  | { kind: 'stop' | 'max-tokens' }
  | { kind: 'aborted'; failure: { message: string; code: string } }
  | { kind: 'error'; failure: { message: string; code: string } }

function settleReason(stopReason: string | undefined): SettleReason {
  switch (stopReason) {
    case 'max_tokens':
      return { kind: 'max-tokens' }
    case 'cancelled':
      return { kind: 'aborted', failure: { message: 'Antigravity ACP turn was cancelled.', code: 'ABORTED' } }
    case 'refusal':
      return { kind: 'error', failure: { message: 'The Antigravity agent refused this prompt.', code: 'ACP_REFUSAL' } }
    case 'max_turn_requests':
      return { kind: 'error', failure: { message: 'The Antigravity agent reached its turn request limit.', code: 'ACP_SESSION_LIMIT' } }
    case 'end_turn':
    case undefined:
      return { kind: 'stop' }
    default:
      return {
        kind: 'error',
        failure: { message: `The Antigravity agent stopped for an unrecognised reason: ${stopReason}`, code: 'ACP_UNKNOWN_STOP' },
      }
  }
}

function asLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error
  if (error instanceof AcpError) {
    if (error.code === ACP_AUTH_REQUIRED_CODE) return acpError('ACP_AUTH_REQUIRED')
    // JSON-RPC's own reserved codes: the server understood the shape and said no.
    if (error.code === -32602) return acpError('ACP_INVALID_PARAMS')
    if (error.code === -32601) return acpError('ACP_METHOD_UNSUPPORTED')
    return acpError('ACP_RPC_ERROR', error.message)
  }
  const message = error instanceof Error ? error.message : String(error)
  // A dead pipe, a killed child, or an unreachable executable all land here; the
  // code names the one thing the user can act on (retry vs install).
  if (/ENOENT|not found|cannot find/i.test(message)) return acpError('ACP_BINARY_UNAVAILABLE', message)
  return acpError('ACP_DISCONNECTED', message)
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function abortError(): Error {
  const error = new Error('Antigravity ACP turn was cancelled')
  error.name = 'AbortError'
  return error
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * The values one `session/set_config_option` result lists for a config option.
 *
 * @param result - The response payload, when the server sent one.
 * @param configId - Option id to read, such as `thought_level`.
 * @returns The accepted values, or undefined when the answer carried no options.
 */
function configOptionValues(result: Record<string, unknown> | undefined, configId: string): string[] | undefined {
  const options = result?.configOptions
  if (!Array.isArray(options)) return undefined
  for (const entry of options) {
    const record = asRecord(entry)
    if (record?.id !== configId) continue
    const values = record.options
    if (!Array.isArray(values)) return undefined
    return values.flatMap((option) => {
      const value = asRecord(option)?.value
      return typeof value === 'string' ? [value] : []
    })
  }
  return undefined
}

export { PROVIDER_ID }