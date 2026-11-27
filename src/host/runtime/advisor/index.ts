import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { isSameOriginMutation } from '../../common/same-origin.ts'
import { CONSULT_ADVISOR_TOOL_NAME, ADVISOR_STATE_PATH, type AdvisorResult, type AdvisorRoute, type AdvisorStateDto } from '../../../shared/advisor-contracts.ts'
import { ADVISOR_TOOL_DESCRIPTION } from './prompt.ts'

const ADVISOR_OUTPUT = {
  schema: { type: 'json' },
  render: (_args: unknown, value: JsonValue): ContentBlock[] => {
    const result = value as unknown as AdvisorResult
    if (result.status !== 'ok' && result.status !== 'truncated') return [{ type: 'text', text: result.detail ?? `Advisor ${result.status}` }]
    const usage = result.usage === undefined ? '' : `\nUsage: ${result.usage.inputTokens ?? 0} input, ${result.usage.outputTokens ?? 0} output tokens.`
    const truncated = result.status === 'truncated' ? '\n[Advisor output was truncated at its token limit.]' : ''
    const route = result.advisor === undefined ? '' : `\nAdvisor: ${result.advisor.provider}/${result.advisor.model}`
    return [{ type: 'text', text: `${result.advice}${truncated}${route}${usage}` }]
  },
} as const
import { AdvisorSelectionStore, type AdvisorDefaults } from './selection-store.ts'
import { projectAdvisorTranscript } from './transcript.ts'
import { requestAdvisor, type AdvisorLlm } from './request.ts'

interface AdvisorAgent {
  id?: unknown
  session?: { id?: unknown; deriveMessages?: () => Parameters<typeof projectAdvisorTranscript>[0] }
}

export interface AdvisorHostConfig {
  advisorEnabled?: unknown
  advisorProvider?: unknown
  advisorModel?: unknown
  advisorReasoningEffort?: unknown
  advisorMaxTokens?: unknown
  advisorTimeoutMs?: unknown
  advisorMaxRetries?: unknown
  advisorContextTokenBudget?: unknown
}

function value<T>(input: unknown, fallback: T): T {
  const resolved = typeof input === 'object' && input !== null && 'get' in input && typeof (input as { get?: unknown }).get === 'function'
    ? (input as { get: () => unknown }).get() : input
  return (resolved ?? fallback) as T
}

function routeOf(config: AdvisorHostConfig): AdvisorRoute | null {
  const provider = value(config.advisorProvider, '').trim()
  const model = value(config.advisorModel, '').trim()
  if (provider === '' || model === '') return null
  const reasoningEffort = value(config.advisorReasoningEffort, 'auto').trim()
  return { provider, model, ...(reasoningEffort === '' || reasoningEffort === 'auto' ? {} : { reasoningEffort }) }
}

export class AdvisorService {
  constructor(readonly selections: AdvisorSelectionStore, private readonly llm: AdvisorLlm) {}
  async consult(args: { question: string; focus?: string }, agentInput: unknown, signal: AbortSignal): Promise<AdvisorResult> {
    const agent = agentInput as AdvisorAgent | undefined
    const sessionId = String(agent?.session?.id ?? agent?.id ?? '')
    if (sessionId === '' || typeof agent?.session?.deriveMessages !== 'function') {
      return { status: 'unavailable', advice: '', detail: 'Advisor requires an active agent session.' }
    }
    const state = await this.selections.state(sessionId)
    if (!state.enabled) return { status: 'disabled', advice: '', detail: 'Advisor is disabled for this conversation.' }
    if (state.selection === null) return { status: 'unconfigured', advice: '', detail: 'Choose an advisor model in the conversation model menu first.' }
    const info = await this.llm.resolveModelInfo?.(state.selection.provider, state.selection.model, signal).catch(() => undefined)
    const maxTokens = info?.maxTokens === undefined ? state.limits.maxTokens : Math.min(state.limits.maxTokens, info.maxTokens)
    const contextTokenBudget = info?.contextWindow === undefined ? state.limits.contextTokenBudget : Math.min(state.limits.contextTokenBudget, info.contextWindow)
    const transcript = projectAdvisorTranscript(agent.session.deriveMessages(), {
      contextTokenBudget, maxTokens, includeImages: info?.inputModalities?.includes('image') ?? true,
    })
    const question = `Review focus: ${args.focus ?? 'other'}\nQuestion: ${args.question}`
    return requestAdvisor({
      llm: this.llm, route: state.selection, transcript, question,
      maxTokens, timeoutMs: state.limits.timeoutMs, maxRetries: state.limits.maxRetries,
      sessionId: sessionId as GenerateOptions['sessionId'], signal,
    })
  }
}

export function installAdvisor(ctx: Context, config: AdvisorHostConfig): () => void {
  const store = new AdvisorSelectionStore((): AdvisorDefaults => ({
    enabled: value(config.advisorEnabled, false), selection: routeOf(config),
    maxTokens: value(config.advisorMaxTokens, 4096), timeoutMs: value(config.advisorTimeoutMs, 300000),
    maxRetries: value(config.advisorMaxRetries, 1), contextTokenBudget: value(config.advisorContextTokenBudget, 100000),
  }))
  const service = new AdvisorService(store, ctx.llm)
  const disposeTool = ctx.tools.register(defineTool({
    name: CONSULT_ADVISOR_TOOL_NAME,
    description: ADVISOR_TOOL_DESCRIPTION,
    parameters: {
      question: { type: 'string', required: true, description: 'The specific decision, risk, or completion question for the advisor.' },
      focus: { type: 'string', enum: ['plan', 'stuck', 'direction', 'completion', 'other'] },
    },
    output: ADVISOR_OUTPUT, timeoutMs: 305000, isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic' as const, kind: 'other' as const, title: 'Consult advisor', rawInput: args }),
    presentResult: (_args, result) => ({ card: 'generic' as const, title: 'Advisor review', content: result.content }),
    execute: async (args, exec): Promise<JsonValue> => await service.consult(args, exec.agent, exec.signal) as unknown as JsonValue,
  }))
  const disposeRoute = ctx.webServer?.register({ kind: 'exact', path: ADVISOR_STATE_PATH, handler: createAdvisorStateHandler(store) })
  return () => { disposeRoute?.(); disposeTool() }
}

export function createAdvisorStateHandler(store: AdvisorSelectionStore) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify(body))
    }
    try {
      if (request.method === 'GET') {
        const sessionId = new URL(request.url ?? '/', 'http://dsh.local').searchParams.get('session') ?? ''
        if (sessionId === '') return send(400, { ok: false, error: { code: 'bad-request', message: 'A session query parameter is required.' } })
        return send(200, { ok: true, value: await store.state(sessionId) })
      }
      if (request.method === 'POST') {
        if (!isSameOriginMutation(request)) return send(403, { ok: false, error: { code: 'forbidden', message: 'Cross-origin request refused.' } })
        const body = await readJson(request) as { sessionId?: unknown; enabled?: unknown; selection?: unknown } | null
        if (typeof body?.sessionId !== 'string' || body.sessionId === '') return send(400, { ok: false, error: { code: 'bad-request', message: 'A sessionId is required.' } })
        if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return send(400, { ok: false, error: { code: 'bad-request', message: 'enabled must be boolean.' } })
        const selection = parseRoute(body.selection)
        if (selection === false) return send(400, { ok: false, error: { code: 'bad-request', message: 'selection must be null or a complete route.' } })
        const patch: { enabled?: boolean; selection?: AdvisorRoute | null } = {}
        if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
        if (selection !== undefined) patch.selection = selection
        const value: AdvisorStateDto = await store.update(body.sessionId, patch)
        return send(200, { ok: true, value })
      }
      response.setHeader('allow', 'GET, POST')
      return send(405, { ok: false, error: { code: 'bad-request', message: 'Method not allowed.' } })
    } catch (error) {
      return send(400, { ok: false, error: { code: 'bad-request', message: error instanceof Error ? error.message : String(error) } })
    }
  }
}

function parseRoute(input: unknown): AdvisorRoute | null | undefined | false {
  if (input === undefined || input === null) return input
  if (typeof input !== 'object') return false
  const route = input as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
  if (typeof route.provider !== 'string' || route.provider.trim() === '' || typeof route.model !== 'string' || route.model.trim() === '') return false
  if (route.reasoningEffort !== undefined && typeof route.reasoningEffort !== 'string') return false
  return { provider: route.provider, model: route.model, ...(typeof route.reasoningEffort === 'string' && route.reasoningEffort !== '' ? { reasoningEffort: route.reasoningEffort } : {}) }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 16 * 1024) throw new Error('Request body is too large.')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}