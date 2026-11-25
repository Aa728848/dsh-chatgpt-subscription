import type { GenerateOptions, Message, StreamChunk } from '../../common/llm-compat.ts'
import type { StreamActivity } from '../../common/idle-watchdog.ts'
import type { ResolvedRequestImages } from '../../common/request-images.ts'
import { stripMetaSchema } from '../../common/tool-schema.ts'
import { parseResponsesStream } from '../codex-chatgpt/responses-client.ts'
import { relayOneArgsText, relayOneEffort, relayOneInstructionText, relayOneLeadingInstructionEndIndex, relayOneReplayOutputItems, relayOneSystemText, relayOneTextOf, relayOneToolResult } from '../relayone/mapper-shared.ts'
import type { OpenCodeGoModelEntry } from './model-catalog.ts'
import type { OpenCodeGoSettings } from './token-store.ts'
import { isOpenCodeGoRecord, openCodeGoFinishMetadata, openCodeGoImageParts, openCodeGoProtocolError, openCodeGoString, readOpenCodeGoUsageMetadata, type OpenCodeGoUsageMetadata } from './native-shared.ts'

function responseContent(message: Message, images: ResolvedRequestImages, accepted: boolean): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = []
  const textType = message.role === 'assistant' ? 'output_text' : 'input_text'
  const text = message.content.filter(block => block.type === 'text' || (block.type === 'reasoning' && message.role !== 'assistant')).map(block => block.type === 'text' || block.type === 'reasoning' ? block.text : '').join('')
  if (text !== '') parts.push({ type: textType, text })
  for (const image of openCodeGoImageParts(message.content, images, accepted)) {
    if ('unavailable' in image) parts.push({ type: 'input_text', text: image.unavailable })
    else parts.push({ type: 'input_image', image_url: 'data:' + image.mediaType + ';base64,' + image.data })
  }
  return parts
}

export function buildOpenCodeGoResponsesRequest(options: GenerateOptions, images: ResolvedRequestImages, entry: OpenCodeGoModelEntry, settings: OpenCodeGoSettings): Record<string, unknown> {
  const input: Record<string, unknown>[] = []
  const knownCalls = new Set<string>()
  for (let index = relayOneLeadingInstructionEndIndex(options.messages); index < options.messages.length; index += 1) {
    const message = options.messages[index]!
    if (message.role === 'system' || message.role === 'developer') {
      const text = relayOneInstructionText(message)
      if (text !== '') input.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] })
      continue
    }
    const result = relayOneToolResult(message)
    if (result !== undefined) {
      const callId = String(result.toolCallId)
      const output = relayOneTextOf(result.content)
      if (knownCalls.has(callId)) input.push({ type: 'function_call_output', call_id: callId, output })
      else input.push({ role: 'user', content: [{ type: 'input_text', text: 'Tool result for unavailable call ' + callId + ':\n' + output }] })
      continue
    }
    const replay = message.role === 'assistant' ? relayOneReplayOutputItems(message) : null
    const content = responseContent(message, images, entry.supportsImages)
    if (replay !== null) {
      const hasReplayText = replay.some(item => item.type === 'message' && Array.isArray(item.content) && item.content.some(part => {
        if (!isOpenCodeGoRecord(part)) return false
        const text = part.type === 'output_text' ? openCodeGoString(part.text) : part.type === 'refusal' ? openCodeGoString(part.refusal) : undefined
        return text !== undefined && text.trim() !== ''
      }))
      if (!hasReplayText && content.length > 0) {
        const firstCall = replay.findIndex(item => item.type === 'function_call')
        replay.splice(firstCall === -1 ? replay.length : firstCall, 0, { role: 'assistant', content })
      }
      input.push(...replay)
      for (const item of replay) if (item.type === 'function_call' && typeof item.call_id === 'string') knownCalls.add(item.call_id)
    } else if (content.length > 0) input.push({ role: message.role, content })
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type !== 'tool-call') continue
        const callId = String(block.id)
        if (knownCalls.has(callId)) continue
        knownCalls.add(callId)
        input.push({ type: 'function_call', call_id: callId, name: block.name, arguments: relayOneArgsText(block.arguments) })
      }
    }
  }
  const tools = entry.supportsTools ? (options.tools ?? []).map(tool => ({ type: 'function', name: tool.name, description: tool.description, strict: false, parameters: stripMetaSchema(tool.parameters) })) : []
  const effort = relayOneEffort(options, settings.defaultReasoningEffort, entry.reasoningEfforts)
  const system = relayOneSystemText(options)
  return {
    model: options.model, input, stream: true,
    ...(system === '' ? {} : { instructions: system }),
    ...(tools.length > 0 ? { tools, tool_choice: 'auto', parallel_tool_calls: true } : {}),
    ...(options.maxTokens === undefined ? {} : { max_output_tokens: options.maxTokens }),
    ...(effort === undefined ? {} : { reasoning: { effort } }),
  }
}

async function readResponsesMetadata(response: Response): Promise<OpenCodeGoUsageMetadata | null> {
  const text = await response.text()
  let metadata: OpenCodeGoUsageMetadata | null = null
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    try {
      const event = JSON.parse(line.slice(5).trim()) as { type?: string; response?: { usage?: unknown } }
      if (event.type !== 'response.completed' && event.type !== 'response.incomplete') continue
      const next = readOpenCodeGoUsageMetadata(event.response?.usage)
      if (next !== null) metadata = next
    } catch { /* The primary parser owns malformed-event errors. */ }
  }
  return metadata
}

export async function* streamOpenCodeGoResponses(response: Response, signal: AbortSignal, activity?: StreamActivity, onMetadata?: (metadata: OpenCodeGoUsageMetadata | null) => void): AsyncIterable<StreamChunk> {
  const pendingMetadata = readResponsesMetadata(response.clone()).catch(() => null)
  let metadata: OpenCodeGoUsageMetadata | null = null
  try {
    for await (const chunk of parseResponsesStream(response, signal, undefined, activity)) {
      if (chunk.type === 'finish') {
        metadata = await pendingMetadata
        onMetadata?.(metadata)
      }
      yield openCodeGoFinishMetadata([chunk], 'responses', metadata)[0]!
    }
  } catch (error) {
    throw openCodeGoProtocolError(error)
  } finally {
    await pendingMetadata
    await response.body?.cancel().catch(() => undefined)
  }
}