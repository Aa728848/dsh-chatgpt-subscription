import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { ADVISOR_SYSTEM_PROMPT } from './prompt.ts'
import type { AdvisorResult, AdvisorRoute, AdvisorTokenUsage } from '../../../shared/advisor-contracts.ts'
import type { AdvisorTranscriptProjection } from './transcript.ts'

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap { advisor: true }
}

export interface AdvisorLlm {
  stream(options: GenerateOptions<'advisor'>): AsyncIterable<StreamChunk>
  resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<{
    contextWindow?: number
    maxTokens?: number
    inputModalities?: readonly string[]
  }>
}

function usageOf(usage: TokenUsage | undefined): AdvisorTokenUsage | undefined {
  if (usage === undefined) return undefined
  return {
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens,
  }
}

function retryable(error: unknown): boolean {
  const value = error as { code?: unknown; status?: unknown } | undefined
  return value?.status === 429 || (typeof value?.status === 'number' && value.status >= 500)
    || typeof value?.code === 'string' && /NETWORK|SERVER|RATE|TIMEOUT|UNAVAILABLE/i.test(value.code)
}

function detailOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 300)
}

export async function requestAdvisor(options: {
  llm: AdvisorLlm
  route: AdvisorRoute
  transcript: AdvisorTranscriptProjection
  maxTokens: number
  timeoutMs: number
  maxRetries: number
  sessionId: GenerateOptions['sessionId']
  question: string
  signal: AbortSignal
}): Promise<AdvisorResult> {
  if (options.signal.aborted) return { status: 'cancelled', advice: '', advisor: options.route, detail: 'Advisor consultation was cancelled.' }
  const controller = new AbortController()
  let timedOut = false
  const abort = () => controller.abort(options.signal.reason)
  options.signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => { timedOut = true; controller.abort(new Error('Advisor deadline exceeded')) }, options.timeoutMs)
  let usage: TokenUsage | undefined
  try {
    for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
      const deltas: string[] = []
      const blocks: string[] = []
      let finishKind: string | undefined
      try {
        const gaps = [
          options.transcript.omittedMessages > 0 ? `${options.transcript.omittedMessages} middle messages were omitted to fit the advisor context window.` : '',
          options.transcript.orphanedToolCalls > 0 ? `${options.transcript.orphanedToolCalls} tool results fell outside that window; their calls carry an explicit placeholder.` : '',
        ].filter(Boolean)
        const system = [ADVISOR_SYSTEM_PROMPT, `The main agent requests this review focus:\n${options.question}`, options.transcript.sourceSystem, ...gaps]
          .filter(Boolean).join('\n\n')
        const stream = options.llm.stream({
          provider: options.route.provider, model: options.route.model,
          reasoningEffort: options.route.reasoningEffort as GenerateOptions['reasoningEffort'],
          system, messages: options.transcript.messages, tools: [], maxTokens: options.maxTokens,
          signal: controller.signal, sessionId: options.sessionId, purpose: 'advisor',
        })
        for await (const chunk of stream) {
          if (chunk.type === 'text-delta') deltas.push(chunk.text)
          else if (chunk.type === 'block-end' && chunk.block.type === 'text') blocks.push(chunk.block.text)
          else if (chunk.type === 'usage') usage = chunk.usage
          else if (chunk.type === 'finish') {
            finishKind = chunk.reason.kind
            if (chunk.reason.kind === 'error') throw Object.assign(new Error(chunk.reason.failure.message), chunk.reason.failure)
            if (chunk.reason.kind === 'aborted') throw Object.assign(new Error(chunk.reason.failure.message), chunk.reason.failure)
          }
        }
        const advice = (deltas.length > 0 ? deltas.join('') : blocks.join('\n')).trim()
        // An empty answer is a real outcome, not a transport failure: it is reported
        // as a declined review so the main agent keeps its own judgment instead of
        // treating an unreadable advisor as an error to retry.
        return {
          status: advice === '' ? 'declined' : finishKind === 'max-tokens' ? 'truncated' : 'ok',
          advice,
          advisor: options.route, usage: usageOf(usage), omittedMessages: options.transcript.omittedMessages,
        }
      } catch (error) {
        if (controller.signal.aborted) break
        if (attempt >= options.maxRetries || !retryable(error)) {
          return { status: 'unavailable', advice: '', advisor: options.route, detail: detailOf(error) }
        }
      }
    }
    return {
      status: options.signal.aborted ? 'cancelled' : 'unavailable', advice: '', advisor: options.route,
      detail: options.signal.aborted ? 'Advisor consultation was cancelled.' : timedOut ? 'Advisor consultation exceeded its deadline.' : 'Advisor consultation was cancelled.',
    }
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', abort)
  }
}
