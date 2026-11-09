/**
 * One guided retry after a Kimi tool-argument stream enters a runaway shape.
 *
 * The failed attempt is already settled before `agent/request-error` runs. The
 * recovery notice is appended AFTER it, so the next same-step deriveMessages()
 * sees the instruction without changing the system prompt or tool declarations.
 * `agent.steer()` is deliberately not used: it targets a later step boundary.
 */

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { PLUGIN_MESSAGE_SOURCE_KIND } from '../common/llm-compat.ts'
import {
  TOOL_ARGUMENT_BYTES_EXCEEDED_CODE,
  TOOL_ARGUMENT_REPEATED_KEY_CODE,
  isKimiToolArgumentGuardCode,
} from './tool-argument-guard.ts'

const MAX_RECOVERY_STEPS = 256

type RecoveryAction = { kind: 'retry' } | undefined
type RecoveryNext = () => Promise<RecoveryAction> | RecoveryAction

interface AgentLike {
  readonly id?: unknown
  readonly session?: {
    readonly id?: unknown
    append?(type: 'user/message', message: unknown, options: { surfaceOp: 'append' }): unknown
  }
}

interface RequestErrorLike {
  readonly agent?: unknown
  readonly turn?: unknown
  readonly step?: unknown
  readonly provider?: unknown
  readonly failure?: { readonly code?: unknown }
  readonly signal?: { readonly aborted?: unknown }
}

export interface RecoveryContext {
  on?(event: string, listener: (...args: never[]) => unknown): (() => void) | undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** The model-facing recovery instruction; raw tool arguments never enter it. */
export function createKimiToolArgumentRecoveryMessage(code: string): unknown {
  const repeated = code === TOOL_ARGUMENT_REPEATED_KEY_CODE
  const body = repeated
    ? 'The previous tool call was stopped because its JSON arguments contained a runaway repeated-key family. '
      + 'Do not resume, reuse, or repair that payload. If you still need a tool, make one fresh call with minimal valid JSON '
      + 'and only the exact property names in its schema. For ask_user_question, use only questions, id, question, header, '
      + 'options, label, description, and multi_select as applicable. Property names are case-sensitive and must not carry '
      + 'surrounding whitespace, documentation annotations, or appended underscores. A minimal choices call is '
      + '{"questions":[{"id":"choice","question":"Which choice?","options":[{"label":"A"}]}]}. '
      + 'If no tool call is necessary, continue with the evidence already available or explain the blocker in text.'
    : 'The previous tool call was stopped because its arguments exceeded the route byte budget. Do not resend the same payload. '
      + 'If the existing evidence is sufficient, finish in text. Otherwise make one fresh call with the smallest sufficient arguments; '
      + 'for a large file or program, use a legal smaller/chunked approach instead of repeating the oversized content.'
  return createUserMessage({
    content: [{ type: 'text', text: body }],
    source: {
      kind: PLUGIN_MESSAGE_SOURCE_KIND,
      form: 'notice',
      summary: boundContextSummary(repeated
        ? 'Runaway tool arguments: retry once with fresh minimal JSON.'
        : 'Oversized tool arguments: retry once with a smaller payload.'),
    },
  })
}

/** Install the one-per-step request recovery hook. */
export function installKimiToolArgumentRecovery(ctx: RecoveryContext): () => void {
  const attempted = new Set<string>()

  const clearAgent = (raw: unknown): void => {
    const agent = raw as AgentLike | undefined
    const sessionId = text(agent?.session?.id) ?? text(agent?.id)
    if (sessionId === undefined) return
    const prefix = sessionId + ':'
    for (const key of [...attempted]) if (key.startsWith(prefix)) attempted.delete(key)
  }

  const disposeRequestError = ctx.on?.('agent/request-error', (async (
    payload: RequestErrorLike,
    next: RecoveryNext,
  ): Promise<RecoveryAction> => {
    const code = payload.failure?.code
    if (payload.provider !== 'kimi-code' || !isKimiToolArgumentGuardCode(code)) return await next()
    if (payload.signal?.aborted === true) return await next()
    const agent = payload.agent as AgentLike | undefined
    const sessionId = text(agent?.session?.id) ?? text(agent?.id)
    const turn = number(payload.turn)
    const step = number(payload.step)
    const session = agent?.session
    const append = session?.append
    if (sessionId === undefined || turn === undefined || step === undefined || session === undefined || append === undefined) return await next()
    const key = `${sessionId}:${turn}:${step}`
    if (attempted.has(key)) return await next()

    const message = createKimiToolArgumentRecoveryMessage(code)
    // Own the first recovery only after the model-visible instruction commits.
    // A failed append remains terminal and does not consume the step's budget.
    // Keep next() outside this catch: a downstream failure must not be invoked twice.
    try {
      append.call(session, 'user/message', message, { surfaceOp: 'append' })
    } catch {
      return await next()
    }
    attempted.add(key)
    while (attempted.size > MAX_RECOVERY_STEPS) {
      const oldest = attempted.keys().next()
      if (oldest.done !== true) attempted.delete(oldest.value)
    }
    return { kind: 'retry' }
  }) as never)

  const disposeDisposed = ctx.on?.('agent/disposed', ((payload: { agent?: unknown }) => {
    clearAgent(payload?.agent)
  }) as never)

  return () => {
    disposeRequestError?.()
    disposeDisposed?.()
    attempted.clear()
  }
}

