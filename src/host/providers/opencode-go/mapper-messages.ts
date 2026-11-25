import type { GenerateOptions, Message } from '../../common/llm-compat.ts'
import { formatMidConversationSystemReminder } from '../../common/llm-compat.ts'
import { stripMetaSchema } from '../../common/tool-schema.ts'
import type { ResolvedRequestImages } from '../../common/request-images.ts'
import { closeRelayOneAnthropicStream, createRelayOneAnthropicStreamState, feedRelayOneAnthropicPayload, assertRelayOneAnthropicStreamComplete } from '../relayone/mapper-anthropic.ts'
import { relayOneClaudeAdaptiveThinking } from '../relayone/model-catalog.ts'
import { relayOneArgsText, relayOneEffort, relayOneInstructionText, relayOneLeadingInstructionEndIndex, relayOneSafeJson, relayOneSystemText, relayOneTextOf, relayOneToolResult } from '../relayone/mapper-shared.ts'
import type { OpenCodeGoModelEntry } from './model-catalog.ts'
import type { OpenCodeGoSettings } from './token-store.ts'
import { isOpenCodeGoRecord, openCodeGoFinishMetadata, openCodeGoImageParts, openCodeGoProtocolError, openCodeGoReplayBlocks, readOpenCodeGoUsageMetadata, type OpenCodeGoLineDriver, type OpenCodeGoUsageMetadata } from './native-shared.ts'

function pushMessage(messages: Record<string, unknown>[], role: 'user' | 'assistant', content: Record<string, unknown>[]): void {
  if (content.length === 0) return
  const previous = messages[messages.length - 1]
  if (previous?.role === role && Array.isArray(previous.content)) { previous.content = [...previous.content, ...content]; return }
  messages.push({ role, content })
}

function assistantContent(message: Message): Record<string, unknown>[] {
  const replay = openCodeGoReplayBlocks(message)
  if (replay !== null) return replay.filter((block): block is Record<string, unknown> => block !== null)
  const content: Record<string, unknown>[] = []
  for (const block of message.content) {
    if (block.type === 'text' && block.text !== '') content.push({ type: 'text', text: block.text })
    if (block.type === 'tool-call') {
      const args = relayOneSafeJson(relayOneArgsText(block.arguments))
      content.push({ type: 'tool_use', id: String(block.id), name: block.name, input: isOpenCodeGoRecord(args) ? args : {} })
    }
  }
  return content
}

export function buildOpenCodeGoMessagesRequest(options: GenerateOptions, images: ResolvedRequestImages, entry: OpenCodeGoModelEntry, settings: OpenCodeGoSettings): Record<string, unknown> {
  const messages: Record<string, unknown>[] = []
  const knownCalls = new Set<string>()
  for (let index = relayOneLeadingInstructionEndIndex(options.messages); index < options.messages.length; index += 1) {
    const message = options.messages[index]!
    if (message.role === 'system' || message.role === 'developer') {
      const text = relayOneInstructionText(message)
      if (text !== '') pushMessage(messages, 'user', [{ type: 'text', text: formatMidConversationSystemReminder(text) }])
      continue
    }
    if (message.role === 'assistant') {
      const content = assistantContent(message)
      for (const block of content) if (block.type === 'tool_use' && typeof block.id === 'string') knownCalls.add(block.id)
      pushMessage(messages, 'assistant', content)
      continue
    }
    const result = relayOneToolResult(message)
    const content: Record<string, unknown>[] = []
    if (result !== undefined) {
      const callId = String(result.toolCallId)
      const output = relayOneTextOf(result.content)
      if (knownCalls.has(callId)) content.push({ type: 'tool_result', tool_use_id: callId, content: output, ...(result.isError === true ? { is_error: true } : {}) })
      else content.push({ type: 'text', text: 'Tool result for unavailable call ' + callId + ':\n' + output })
    } else {
      const text = relayOneTextOf(message.content.filter(block => block.type === 'text' || block.type === 'reasoning'))
      if (text !== '') content.push({ type: 'text', text })
    }
    for (const image of openCodeGoImageParts(message.content, images, entry.supportsImages)) {
      if ('unavailable' in image) content.push({ type: 'text', text: image.unavailable })
      else content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } })
    }
    pushMessage(messages, 'user', content)
  }
  const tools = entry.supportsTools ? (options.tools ?? []).map(tool => ({ name: tool.name, description: tool.description, input_schema: stripMetaSchema(tool.parameters) })) : []
  const adaptive = relayOneClaudeAdaptiveThinking(entry.id)
  const effort = relayOneEffort(options, settings.defaultReasoningEffort, adaptive?.efforts ?? entry.reasoningEfforts)
  const enabled = effort !== 'none' && (effort !== undefined || adaptive?.enabledByDefault === true)
  const budgets: Record<string, number> = { minimal: 2048, low: 4096, medium: 8192, high: 16_384, xhigh: 24_576, max: 32_768 }
  const budget = adaptive === undefined && enabled && effort !== undefined ? budgets[effort] ?? 8192 : 0
  const baseMax = options.maxTokens ?? Math.min(entry.maxOutputTokens, 16_384)
  const maxTokens = Math.max(1024, Math.min(entry.maxOutputTokens, budget > 0 ? Math.max(baseMax, budget + 4096) : baseMax))
  const thinking = adaptive !== undefined
    ? effort === 'none' ? { type: 'disabled' } : enabled ? { type: 'adaptive', display: 'summarized' } : undefined
    : budget > 0 && maxTokens > budget ? { type: 'enabled', budget_tokens: budget } : undefined
  const outputConfig = adaptive !== undefined && effort !== undefined && effort !== 'none' ? { effort } : undefined
  const allowTemperature = !enabled && (adaptive?.allowsTemperatureWhenOff ?? true)
  const system = relayOneSystemText(options)
  return {
    model: options.model, messages, stream: true, max_tokens: maxTokens,
    ...(system === '' ? {} : { system }),
    ...(tools.length > 0 ? { tools, tool_choice: { type: 'auto' } } : {}),
    ...(thinking === undefined ? {} : { thinking }),
    ...(outputConfig === undefined ? {} : { output_config: outputConfig }),
    ...(options.temperature === undefined || !allowTemperature ? {} : { temperature: options.temperature }),
    ...(options.stop !== undefined && options.stop.length > 0 ? { stop_sequences: options.stop } : {}),
  }
}

export function createOpenCodeGoMessagesDriver(): OpenCodeGoLineDriver {
  const state = createRelayOneAnthropicStreamState()
  let metadata: OpenCodeGoUsageMetadata | null = null
  const observe = (event: unknown): void => {
    if (!isOpenCodeGoRecord(event)) return
    const usage = event.type === 'message_start' && isOpenCodeGoRecord(event.message) ? event.message.usage : event.type === 'message_delta' ? event.usage : undefined
    const next = readOpenCodeGoUsageMetadata(usage)
    if (next !== null) metadata = { billingSource: next.billingSource ?? metadata?.billingSource ?? null, allowance: next.allowance ?? metadata?.allowance ?? null }
  }
  const map = (chunks: ReturnType<typeof feedRelayOneAnthropicPayload>) => openCodeGoFinishMetadata(chunks, 'messages', metadata)
  return {
    finished: () => state.finished,
    allowance: () => metadata?.allowance ?? null,
    billingSource: () => metadata?.billingSource ?? null,
    process: line => {
      try {
        const trimmed = line.trim()
        if (state.finished || trimmed === '' || trimmed.startsWith(':') || trimmed.startsWith('event:')) return []
        if (!trimmed.startsWith('data:')) return []
        const data = trimmed.slice(5).trim()
        if (data === '' || data === '[DONE]') return []
        const event = JSON.parse(data) as unknown
        observe(event)
        return map(feedRelayOneAnthropicPayload(state, event))
      } catch (error) { throw openCodeGoProtocolError(error) }
    },
    assertComplete: () => { try { assertRelayOneAnthropicStreamComplete(state) } catch (error) { throw openCodeGoProtocolError(error) } },
    close: () => map(closeRelayOneAnthropicStream(state)),
  }
}