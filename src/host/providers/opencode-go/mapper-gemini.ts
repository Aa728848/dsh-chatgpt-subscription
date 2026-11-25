import type { GenerateOptions, StreamChunk, TokenUsage } from '../../common/llm-compat.ts'
import { LlmError } from '../../common/llm-compat.ts'
import type { ResolvedRequestImages } from '../../common/request-images.ts'
import type { StreamActivity } from '../../common/idle-watchdog.ts'
import { stripMetaSchema } from '../../common/tool-schema.ts'
import { toToolCallId } from '../../common/brand-compat.ts'
import { relayOneArgsText, relayOneInstructionText, relayOneLeadingInstructionEndIndex, relayOneSafeJson, relayOneSystemText, relayOneTextOf, relayOneToolResult } from '../relayone/mapper-shared.ts'
import { formatMidConversationSystemReminder } from '../../common/llm-compat.ts'
import type { OpenCodeGoModelEntry } from './model-catalog.ts'
import type { OpenCodeGoSettings } from './token-store.ts'
import { isOpenCodeGoRecord, openCodeGoFinishMetadata, openCodeGoImageParts, openCodeGoNumber, openCodeGoString, readOpenCodeGoUsageMetadata, type OpenCodeGoUsageMetadata } from './native-shared.ts'

export function buildOpenCodeGoGeminiRequest(options: GenerateOptions, images: ResolvedRequestImages, entry: OpenCodeGoModelEntry, _settings: OpenCodeGoSettings): Record<string, unknown> {
  const contents: Record<string, unknown>[] = []
  const knownCalls = new Map<string, string>()
  for (let index = relayOneLeadingInstructionEndIndex(options.messages); index < options.messages.length; index += 1) {
    const message = options.messages[index]!
    if (message.role === 'system' || message.role === 'developer') {
      const text = relayOneInstructionText(message)
      if (text !== '') contents.push({ role: 'user', parts: [{ text: formatMidConversationSystemReminder(text) }] })
      continue
    }
    const parts: Record<string, unknown>[] = []
    const result = relayOneToolResult(message)
    if (result !== undefined) {
      const callId = String(result.toolCallId)
      const output = relayOneTextOf(result.content)
      if (knownCalls.has(callId)) {
        const parsed = relayOneSafeJson(output)
        parts.push({ functionResponse: { name: knownCalls.get(callId), response: isOpenCodeGoRecord(parsed) ? parsed : { result: output } } })
      } else parts.push({ text: 'Tool result for unavailable call ' + callId + ':\n' + output })
    } else {
      const text = relayOneTextOf(message.content.filter(block => block.type === 'text' || (block.type === 'reasoning' && message.role !== 'assistant')))
      if (text !== '') parts.push({ text })
    }
    for (const image of openCodeGoImageParts(message.content, images, entry.supportsImages)) {
      if ('unavailable' in image) parts.push({ text: image.unavailable })
      else parts.push({ inline_data: { mime_type: image.mediaType, data: image.data } })
    }
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type !== 'tool-call') continue
        const id = String(block.id)
        knownCalls.set(id, block.name)
        const args = relayOneSafeJson(relayOneArgsText(block.arguments))
        parts.push({ functionCall: { name: block.name, args: isOpenCodeGoRecord(args) ? args : {} } })
      }
    }
    if (parts.length > 0) contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts })
  }
  const declarations = entry.supportsTools ? (options.tools ?? []).map(tool => ({ name: tool.name, description: tool.description, parameters: stripMetaSchema(tool.parameters) })) : []
  const system = relayOneSystemText(options)
  return {
    contents,
    ...(system === '' ? {} : { systemInstruction: { parts: [{ text: system }] } }),
    ...(declarations.length > 0 ? { tools: [{ functionDeclarations: declarations }], toolConfig: { functionCallingConfig: { mode: 'AUTO' } } } : {}),
    generationConfig: {
      ...(options.maxTokens === undefined ? {} : { maxOutputTokens: options.maxTokens }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.stop !== undefined && options.stop.length > 0 ? { stopSequences: options.stop } : {}),
    },
  }
}

function usage(raw: unknown): TokenUsage | null {
  if (!isOpenCodeGoRecord(raw)) return null
  const prompt = openCodeGoNumber(raw.promptTokenCount) ?? 0
  const cached = openCodeGoNumber(raw.cachedContentTokenCount)
  const candidates = openCodeGoNumber(raw.candidatesTokenCount) ?? 0
  const reasoning = openCodeGoNumber(raw.thoughtsTokenCount)
  return {
    inputTokens: Math.max(0, prompt - (cached ?? 0)), outputTokens: candidates + (reasoning ?? 0),
    ...(cached === undefined ? {} : { cacheReadTokens: cached }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

interface GeminiState {
  chunks: StreamChunk[]
  index: number
  toolCalls: number
  candidates: number
  finishReason?: string
  metadata: OpenCodeGoUsageMetadata | null
  tokenUsage: TokenUsage | null
}
function createGeminiState(): GeminiState { return { chunks: [], index: 0, toolCalls: 0, candidates: 0, metadata: null, tokenUsage: null } }

function consumeGeminiPayload(state: GeminiState, payload: unknown): void {
  if (!isOpenCodeGoRecord(payload)) throw new LlmError('OpenCode Go returned an invalid Gemini response.', 'PROTOCOL_ERROR')
  if (isOpenCodeGoRecord(payload.error)) throw new LlmError(openCodeGoString(payload.error.message) ?? 'OpenCode Go Gemini request failed.', 'PROVIDER_ERROR')
  const metadata = readOpenCodeGoUsageMetadata(payload.usageMetadata)
  if (metadata !== null) state.metadata = metadata
  state.tokenUsage = usage(payload.usageMetadata) ?? state.tokenUsage
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : []
  state.candidates += candidates.length
  for (const candidate of candidates) {
    if (!isOpenCodeGoRecord(candidate)) continue
    state.finishReason = openCodeGoString(candidate.finishReason) ?? state.finishReason
    const content = isOpenCodeGoRecord(candidate.content) ? candidate.content : {}
    const parts = Array.isArray(content.parts) ? content.parts : []
    for (const part of parts) {
      if (!isOpenCodeGoRecord(part)) continue
      const text = openCodeGoString(part.text)
      if (text !== undefined && text !== '') {
        const reasoning = part.thought === true
        state.chunks.push({ type: 'block-start', index: state.index, blockType: reasoning ? 'reasoning' : 'text' })
        state.chunks.push({ type: reasoning ? 'reasoning-delta' : 'text-delta', index: state.index, text } as StreamChunk)
        state.chunks.push({ type: 'block-end', index: state.index, block: { type: reasoning ? 'reasoning' : 'text', text } })
        state.index += 1
      }
      const call = isOpenCodeGoRecord(part.functionCall) ? part.functionCall : undefined
      if (call !== undefined) {
        const name = openCodeGoString(call.name) ?? ''
        const id = openCodeGoString(call.id) ?? 'call_' + state.index
        const args = JSON.stringify(isOpenCodeGoRecord(call.args) ? call.args : {})
        if (name === '') throw new LlmError('OpenCode Go returned an unnamed Gemini function call.', 'INVALID_TOOL_ARGUMENTS')
        state.chunks.push({ type: 'block-start', index: state.index, blockType: 'tool-call' })
        state.chunks.push({ type: 'tool-call-delta', index: state.index, id: toToolCallId(id), name, argumentsDelta: args })
        state.chunks.push({ type: 'block-end', index: state.index, block: { type: 'tool-call', id: toToolCallId(id), name, arguments: args } })
        state.index += 1
        state.toolCalls += 1
      }
    }
  }
}

function finishGemini(state: GeminiState): StreamChunk[] {
  if (state.candidates === 0) throw new LlmError('OpenCode Go Gemini returned no candidates.', 'PROVIDER_ERROR')
  const chunks = [...state.chunks]
  if (state.tokenUsage !== null) chunks.push({ type: 'usage', usage: state.tokenUsage })
  const reason = state.finishReason === 'MAX_TOKENS' ? { kind: 'max-tokens' as const }
    : state.finishReason !== undefined && state.finishReason !== 'STOP' ? { kind: 'error' as const, failure: { message: 'OpenCode Go Gemini stopped with ' + state.finishReason + '.', code: 'PROVIDER_ERROR' } }
      : state.toolCalls > 0 ? { kind: 'tool-calls' as const } : { kind: 'stop' as const }
  return openCodeGoFinishMetadata([...chunks, { type: 'finish', reason, replayState: { response: {} } }], 'generate-content', state.metadata)
}

export async function readOpenCodeGoGeminiResponse(response: Response): Promise<{ chunks: StreamChunk[]; metadata: OpenCodeGoUsageMetadata | null }> {
  const state = createGeminiState()
  consumeGeminiPayload(state, await response.json() as unknown)
  return { chunks: finishGemini(state), metadata: state.metadata }
}

export async function* streamOpenCodeGoGeminiResponse(response: Response, signal: AbortSignal, activity?: StreamActivity, onMetadata?: (metadata: OpenCodeGoUsageMetadata | null) => void): AsyncIterable<StreamChunk> {
  if (response.body === null) throw new LlmError('OpenCode Go returned an empty Gemini response body.', 'PROTOCOL_ERROR')
  const state = createGeminiState()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const consumeLine = function* (line: string): Generator<StreamChunk> {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith(':') || trimmed.startsWith('event:')) return
    activity?.pulse()
    if (!trimmed.startsWith('data:')) return
    const data = trimmed.slice(5).trim()
    if (data === '' || data === '[DONE]') return
    let payload: unknown
    try { payload = JSON.parse(data) } catch { throw new LlmError('OpenCode Go returned malformed Gemini streaming JSON.', 'PROTOCOL_ERROR') }
    const before = state.chunks.length
    consumeGeminiPayload(state, payload)
    onMetadata?.(state.metadata)
    yield* state.chunks.splice(before)
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      if (value !== undefined && value.byteLength > 0) activity?.pulse()
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) yield* consumeLine(line)
    }
    buffer += decoder.decode()
    if (buffer.trim() !== '') for (const line of buffer.split('\n')) yield* consumeLine(line)
    onMetadata?.(state.metadata)
    yield* finishGemini(state)
  } finally {
    void reader.cancel().catch(() => undefined)
  }
}