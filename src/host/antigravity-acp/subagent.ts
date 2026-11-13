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
import type { ContentBlock } from '../common/llm-compat.ts'
import { AcpClient, type AcpClientHandlers } from './acp-client.ts'
import type { AcpLaunch } from './adapter.ts'
import type { AntigravityAcpSettingsStore } from './settings.ts'

/** Provider name this line registers under. */
export const SUBAGENT_PROVIDER_NAME = 'antigravity-acp'

/** Budget for one subagent run's single prompt. */
export const SUBAGENT_PROMPT_TIMEOUT_MS = 30 * 60_000

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

/** The part of `SubagentStartRequest` this backend reads. */
export interface AntigravitySubagentStartRequest {
  readonly cwd: string
  readonly prompt: readonly ContentBlock[]
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
  return {
    name: SUBAGENT_PROVIDER_NAME,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    inheritsParentContext: false,
    async start(request): Promise<AntigravitySubagentRun> {
      const launch = await options.resolveLaunch()
      const settings = await options.settings.read()
      const task = promptText(request.prompt)
      let settled = false
      const running = startRun(launch, request.cwd, task, settings.permissionPolicy, options, request.signal)
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
    },
  }
}

function startRun(
  launch: AcpLaunch,
  cwd: string,
  task: string,
  permissionPolicy: 'reject' | 'allow',
  options: AntigravityAcpSubagentOptions,
  signal: AbortSignal | undefined,
): { client: AcpClient; result: Promise<AntigravitySubagentResult>; settle(result: AntigravitySubagentResult): void; output(): readonly ContentBlock[] } {
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
