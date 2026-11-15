/**
 * The Antigravity (ACP) subagent backend.
 *
 * A subagent here is a *whole agent*, not a model call: it gets the ACP server's
 * own tools, its own session and its own working directory. That is the honest
 * shape of the protocol - ACP has no tool-less or raw-model mode - and it is why
 * this backend advertises no start-time capabilities it cannot honour.
 *
 * The asymmetry against the main-model line is deliberate and documented in
 * `docs/antigravity-acp-line-plan.md`: as a subagent there is no DSH agent loop
 * in the child to execute a bridge's tool calls, so the child runs the official
 * agent's tools. As a main model the same agent's tool calls are routed back to
 * DSH through the MCP bridge, where the harness's permissions apply.
 *
 * ## Why the seam below is declared locally
 *
 * This package supports harness generations from 0.1.2-alpha.5 onward, and the
 * `@deepseek-ai/dsh-subagent` package does not exist on all of them. Importing
 * it - even as a type - would make the bundle unresolvable on those generations,
 * and adding it to `peerDependencies` would make `npm install` fail there. The
 * four method shapes this backend implements are therefore declared here and
 * probed at runtime, the same way the settings and credential seams are.
 *
 * @module dsh-chatgpt-subscription/host/antigravity-acp/subagent
 */

import type { Context } from '@deepseek-ai/cordis'
import { LlmError } from '../common/llm-compat.ts'
import type { ContentBlock } from '../common/llm-compat.ts'
import { AcpClient, type AcpClientHandlers } from './acp-client.ts'
import type { AcpLaunch } from './adapter.ts'
import { acpError } from './errors.ts'
import type { AntigravityAcpSettingsStore } from './settings.ts'

/** Provider name this line registers under. */
export const SUBAGENT_PROVIDER_NAME = 'antigravity-acp'

/** Budget for one subagent run's single prompt. */
export const SUBAGENT_PROMPT_TIMEOUT_MS = 30 * 60_000

/**
 * How many delegated runs may be in flight at once.
 *
 * The same number the main-model half allows (`DEFAULT_MAX_ACTIVE_TURNS` in
 * `adapter.ts`), applied to this backend's own runs. Delegation used to be
 * unbounded: every run spawns a whole official agent (244 MB in the reference
 * report), and nothing stopped a burst of subagents from doing it all at once
 * while the line's own switch was still on. Kept as a separate budget rather than
 * shared with the main-model turns so a burst of delegation cannot lock the user
 * out of their own conversation.
 */
export const DEFAULT_MAX_ACTIVE_RUNS = 4

/** Why one subagent run ended, in the seam's vocabulary. */
export type AntigravitySubagentStopReason = 'completed' | 'max-tokens' | 'refusal' | 'aborted' | 'error'

/** One run's terminal result, in the seam's vocabulary. */
export interface AntigravitySubagentResult {
  output: readonly ContentBlock[]
  diagnostic?: string
  stopReason: AntigravitySubagentStopReason
}

/** One run handle, in the seam's vocabulary. */
export interface AntigravitySubagentRun {
  id: unknown
  result: Promise<AntigravitySubagentResult>
  dispose(): Promise<void>
}

/**
 * The agent options this backend can honour.
 *
 * ACP can select a model and a thinking level on a session and nothing else: it
 * has no temperature, no stop sequence and no output-token cap. `maxTokens` is
 * therefore read and dropped rather than refused - refusing it would make every
 * caller that passes a cap fail for a bound the protocol cannot express.
 */
export interface AntigravitySubagentAgentOptions {
  /** Model id to select on the child's ACP session. */
  readonly model?: string
  /** Thinking level to apply, when the server publishes one for that model. */
  readonly reasoningEffort?: string
  /** Dropped: ACP has no output-token cap. */
  readonly maxTokens?: number
}

/** The part of `SubagentStartRequest` this backend reads. */
export interface AntigravitySubagentStartRequest {
  readonly cwd: string
  readonly prompt: readonly ContentBlock[]
  /** Host-requested model and effort, when the caller selected them. */
  readonly agentOptions?: AntigravitySubagentAgentOptions
  readonly signal?: AbortSignal
}

/** The part of `SubagentProvider` this backend implements. */
export interface AntigravitySubagentProvider {
  readonly name: string
  readonly capabilities: {
    readonly agentOptions: boolean
    readonly agentPreset: boolean
    readonly outputSchema: boolean
    readonly depthLimit: boolean
  }
  readonly inheritsParentContext: boolean
  start(request: AntigravitySubagentStartRequest): Promise<AntigravitySubagentRun>
}

/** What the backend needs from the line. */
export interface AntigravityAcpSubagentOptions {
  /** Resolve the executable. */
  resolveLaunch(): Promise<AcpLaunch>
  /** This line's preferences (permission policy and default effort). */
  settings: AntigravityAcpSettingsStore
  /** Delegated runs allowed in flight at once. */
  maxActiveRuns?: number
  /** Test seam. */
  spawnClient?(launch: AcpLaunch, cwd: string, handlers: AcpClientHandlers): AcpClient
}

/** A settle handle plus the text the child has produced so far. */
interface RunningSubagent {
  client: AcpClient
  output(): readonly ContentBlock[]
  settle(result: AntigravitySubagentResult): void
}

/**
 * Register the backend when the host offers a `subagents` service.
 *
 * A host without that service is not a failure: this line's main-model half works
 * on every supported generation, and the subagent half simply does not exist
 * there. The disposer is returned so plugin unload removes the backend.
 *
 * @param ctx - Plugin context.
 * @param options - The line's executable resolver and preferences.
 * @returns Disposer, or undefined when this host has no subagent service.
 */
export function registerAntigravityAcpSubagent(
  ctx: Context,
  options: AntigravityAcpSubagentOptions,
): (() => void) | undefined {
  const service = (ctx as unknown as { get?(name: string): unknown }).get?.('subagents') as
    | { registerProvider?(provider: AntigravitySubagentProvider): () => void }
    | undefined
  if (typeof service?.registerProvider !== 'function') return undefined
  try {
    return service.registerProvider(createProvider(options))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    ctx.logger?.warn?.(
      '[dsh-chatgpt-subscription] could not register the ' + SUBAGENT_PROVIDER_NAME + ' subagent backend: ' + detail,
    )
    return undefined
  }
}

/**
 * Build the provider described above.
 *
 * @param options - The line's executable resolver and preferences.
 * @returns A provider with no start-time capabilities: it accepts a task and a
 * working directory, and that is all.
 */
export function createProvider(options: AntigravityAcpSubagentOptions): AntigravitySubagentProvider {
  // One budget per registered provider: every run is a whole agent process, and a
  // burst of delegation must be bounded the way the main-model turns are.
  const cap = options.maxActiveRuns ?? DEFAULT_MAX_ACTIVE_RUNS
  let active = 0
  return {
    name: SUBAGENT_PROVIDER_NAME,
    // `agentOptions` is advertised because the model and the thinking level *are*
    // expressible (one `session/set_config_option` each). The host refuses to let a
    // caller select a model or a preset on a backend that does not claim it, which
    // is why delegation used to run on whatever model the agent defaulted to.
    capabilities: { agentOptions: true, agentPreset: false, outputSchema: false, depthLimit: false },
    inheritsParentContext: false,
    async start(request): Promise<AntigravitySubagentRun> {
      // The registry outlives the switch: a provider is registered once, while
      // `enabled` is a setting the user can flip at any time and the host offers no
      // per-start gate of its own. Without this check a switched-off line would
      // still spawn the official agent for every delegated task.
      const settings = await options.settings.read()
      if (!settings.enabled) {
        throw new LlmError(
          'The Antigravity (ACP) line is switched off. Enable it in the subscription overview before delegating to it.',
          'ACP_DISABLED',
        )
      }
      if (active >= cap) {
        throw acpError('ACP_SESSION_LIMIT', `${active} delegated runs are already in flight (limit ${cap}).`)
      }
      active += 1
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        active = Math.max(0, active - 1)
      }
      try {
        const launch = await options.resolveLaunch()
        const task = promptText(request.prompt)
        let settled = false
        const running = startRun(launch, request.cwd, task, settings.permissionPolicy, options, request)
        // The run's own settlement is the normal exit; a dispose without settle is
        // the cancellation path, and both must hand the budget back exactly once.
        void running.result.then(release, release)
        return {
          id: SUBAGENT_PROVIDER_NAME,
          result: running.result,
          dispose: async () => {
            if (settled) return
            settled = true
            running.settle({ output: running.output(), stopReason: 'aborted' })
            await running.client.dispose().catch(() => undefined)
          },
        }
      } catch (error) {
        release()
        throw error
      }
    },
  }
}

function startRun(
  launch: AcpLaunch,
  cwd: string,
  task: string,
  permissionPolicy: 'reject' | 'allow',
  options: AntigravityAcpSubagentOptions,
  request: AntigravitySubagentStartRequest,
): { client: AcpClient; result: Promise<AntigravitySubagentResult>; settle(result: AntigravitySubagentResult): void; output(): readonly ContentBlock[] } {
  const signal = request.signal
  const model = textField(request.agentOptions?.model)
  const effort = textField(request.agentOptions?.reasoningEffort)
  let settle: (result: AntigravitySubagentResult) => void = () => undefined
  const result = new Promise<AntigravitySubagentResult>((resolve) => {
    settle = resolve
  })
  let text = ''
  const output = (): readonly ContentBlock[] => (text === '' ? [] : [{ type: 'text', text }])
  const handlers: AcpClientHandlers = {
    onSessionUpdate: (_sessionId, update) => {
      if (update.sessionUpdate !== 'agent_message_chunk') return
      const content = update.content
      if (typeof content === 'object' && content !== null) {
        const value = (content as Record<string, unknown>).text
        if (typeof value === 'string') text += value
      }
    },
    onPermissionRequest: async (_sessionId, params) => {
      // The child is a whole agent with its own tools. Its permission policy is
      // the line's, and a rejected request is answered as cancelled - never
      // quietly approved.
      if (permissionPolicy !== 'allow') return undefined
      const raw = params.options
      if (!Array.isArray(raw)) return undefined
      for (const entry of raw) {
        if (typeof entry !== 'object' || entry === null) continue
        const record = entry as Record<string, unknown>
        if (record.kind === 'allow_once' && typeof record.optionId === 'string') return record.optionId
      }
      return undefined
    },
  }
  const client = options.spawnClient !== undefined
    ? options.spawnClient(launch, cwd, handlers)
    : new AcpClient({ command: launch.command, args: launch.args, cwd }, handlers)

  void (async () => {
    let finished = false
    const onAbort = (): void => {
      if (finished) return
      finished = true
      settle({ output: output(), stopReason: 'aborted' })
      void client.dispose().catch(() => undefined)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await client.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'dsh-chatgpt-subscription', version: '1.0.0' },
      })
      const session = asRecord(await client.request('session/new', { cwd, mcpServers: [] }))
      const sessionId = typeof session?.sessionId === 'string' ? session.sessionId : undefined
      if (sessionId === undefined) throw new Error('Antigravity ACP did not return a session id.')
      // The model the caller asked for is applied to this conversation before the
      // prompt: a rejected model fails the run here, because answering on a
      // different model would be an answer to a request nobody made. A thinking
      // level the account does not publish stays a preference and is dropped.
      if (model !== undefined) {
        await client.request('session/set_config_option', { sessionId, configId: 'model', value: model })
      }
      if (effort !== undefined) {
        await client.request('session/set_config_option', { sessionId, configId: 'thought_level', value: effort })
          .catch(() => undefined)
      }
      const answer = asRecord(await withTimeout(client.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: task }],
      }), SUBAGENT_PROMPT_TIMEOUT_MS))
      const stopReason = typeof answer?.stopReason === 'string' ? answer.stopReason : 'end_turn'
      if (!finished) {
        finished = true
        settle({ output: output(), stopReason: mapStopReason(stopReason) })
      }
    } catch (error) {
      if (!finished) {
        finished = true
        const detail = error instanceof Error ? error.message : String(error)
        settle({ output: output(), stopReason: 'error', diagnostic: 'Antigravity ACP subagent failed: ' + detail })
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      await client.dispose().catch(() => undefined)
    }
  })()
  return { client, result, settle, output }
}

/** A non-empty string, or undefined; the host's own values are untrusted input here. */
function textField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Flatten the prompt blocks a caller supplied into the one text the agent gets. */
function promptText(prompt: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of prompt) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

function mapStopReason(value: string | undefined): AntigravitySubagentStopReason {
  switch (value) {
    case 'max_tokens':
      return 'max-tokens'
    case 'refusal':
      return 'refusal'
    case 'cancelled':
      return 'aborted'
    case 'end_turn':
      return 'completed'
    default:
      return 'error'
  }
}

function withTimeout<T>(promise: Promise<T>, budgetMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Antigravity ACP subagent timed out after ' + String(budgetMs) + 'ms.')),
      budgetMs,
    )
    timer.unref?.()
    promise.then((value) => {
      clearTimeout(timer)
      resolve(value)
    }, (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
