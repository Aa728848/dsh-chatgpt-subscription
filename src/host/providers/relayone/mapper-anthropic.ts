import type { GenerateOptions, Message, OutboundContentBlock, StreamChunk, TokenUsage } from '../../common/llm-compat.ts'
import { LlmError } from '../../common/llm-compat.ts'
import { toToolCallId } from '../../common/brand-compat.ts'
import { stripMetaSchema } from '../../common/tool-schema.ts'
import type { ResolvedRequestImages } from '../../common/request-images.ts'
import { relayOneClaudeAdaptiveThinking, type RelayOneModelEntry } from './model-catalog.ts'
import type { RelayOneSettings } from './token-store.ts'
import {
  isRelayOneRecord,
  relayOneArgsText,
  relayOneEffort,
  relayOneImageParts,
  relayOneNumber,
  relayOneReplayBlocks,
  relayOneSafeJson,
  relayOneString,
  relayOneSystemText,
  relayOneTextOf,
  relayOneToolResult,
  relayOneValidArguments,
} from './mapper-shared.ts'

function pushMessage(messages: Record<string, unknown>[], role: 'user' | 'assistant', content: Record<string, unknown>[]): void {
  if (content.length === 0) return
  const previous = messages[messages.length - 1]
  if (previous?.role === role && Array.isArray(previous.content)) {
    previous.content = [...previous.content, ...content]
    return
  }
  messages.push({ role, content })
}
function assistantContent(message: Message): Record<string, unknown>[] {
  const replay = relayOneReplayBlocks(message)
  if (replay !== null) return replay.filter((block): block is Record<string, unknown> => block !== null)
  const content: Record<string, unknown>[] = []
  for (const block of message.content) {
    if (block.type === 'text' && block.text !== '') content.push({ type: 'text', text: block.text })
    if (block.type === 'tool-call') {
      const args = relayOneSafeJson(relayOneArgsText(block.arguments))
      content.push({ type: 'tool_use', id: String(block.id), name: block.name, input: isRelayOneRecord(args) ? args : {} })
    }
  }
  return content
}

/** Anthropic Messages request, including signed thinking replay when this line produced it. */
export function buildRelayOneAnthropicRequest(
  options: GenerateOptions,
  images: ResolvedRequestImages,
  entry: RelayOneModelEntry,
  settings: RelayOneSettings,
): Record<string, unknown> {
  const messages: Record<string, unknown>[] = []
  const knownCalls = new Set<string>()
  for (const message of options.messages) {
    if (message.role === 'system' || message.role === 'developer') continue
    if (message.role === 'assistant') {
      const content = assistantContent(message)
      for (const block of content) if (block.type === 'tool_use' && typeof block.id === 'string') knownCalls.add(block.id)
      pushMessage(messages, 'assistant', content)
      continue
    }
    const toolResult = relayOneToolResult(message)
    const content: Record<string, unknown>[] = []
    if (toolResult !== undefined) {
      const callId = String(toolResult.toolCallId)
      const output = relayOneTextOf(toolResult.content)
      if (knownCalls.has(callId)) {
        content.push({ type: 'tool_result', tool_use_id: callId, content: output, ...(toolResult.isError === true ? { is_error: true } : {}) })
      } else content.push({ type: 'text', text: 'Tool result for unavailable call ' + callId + ':\n' + output })
    } else {
      const text = relayOneTextOf(message.content.filter(block => block.type === 'text' || block.type === 'reasoning'))
      if (text !== '') content.push({ type: 'text', text })
    }
    for (const image of relayOneImageParts(message.content, images, entry.supportsImages)) {
      if ('unavailable' in image) content.push({ type: 'text', text: image.unavailable })
      else content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } })
    }
    pushMessage(messages, 'user', content)
  }
  const tools = (options.tools ?? []).map(tool => ({
    name: tool.name, description: tool.description, input_schema: stripMetaSchema(tool.parameters),
  }))
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
  // Opus 5.5 and Haiku 5.5 default to medium, unlike many other models. Omitting
  // output_config when no supported effort was selected preserves each vendor default.
  const outputConfig = adaptive !== undefined && effort !== undefined && effort !== 'none' ? { effort } : undefined
  const allowTemperature = !enabled && (adaptive?.allowsTemperatureWhenOff ?? true)
  const system = relayOneSystemText(options)
  return {
    model: options.model,
    messages,
    stream: true,
    max_tokens: maxTokens,
    ...(system === '' ? {} : { system }),
    ...(tools.length > 0 ? { tools, tool_choice: { type: 'auto' } } : {}),
    ...(thinking === undefined ? {} : { thinking }),
    ...(outputConfig === undefined ? {} : { output_config: outputConfig }),
    ...(options.temperature === undefined || !allowTemperature ? {} : { temperature: options.temperature }),
    ...(options.stop !== undefined && options.stop.length > 0 ? { stop_sequences: options.stop } : {}),
  }
}

interface OpenText { index: number; text: string }
interface PendingTool { index: number; id: string; name: string; arguments: string }
interface PendingThinking { index: number; kind: 'thinking' | 'redacted_thinking'; text: string; signature: string; data: string }
export interface RelayOneAnthropicStreamState {
  blocks: OutboundContentBlock[]
  openText: Map<number, OpenText>
  tools: Map<number, PendingTool>
  thinking: Map<number, PendingThinking>
  replayBlocks: (Record<string, unknown> | null)[]
  sawMessageStart: boolean
  sawMessageStop: boolean
  finishReason: string | null
  stopExplanation: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  sawUsage: boolean
  finished: boolean
  hasToolCall: boolean
}
export function createRelayOneAnthropicStreamState(): RelayOneAnthropicStreamState {
  return {
    blocks: [], openText: new Map(), tools: new Map(), thinking: new Map(), replayBlocks: [],
    sawMessageStart: false, sawMessageStop: false, finishReason: null, stopExplanation: null,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    sawUsage: false, finished: false, hasToolCall: false,
  }
}
function closeAnthropicText(state: RelayOneAnthropicStreamState, contentIndex: number): StreamChunk[] {
  const open = state.openText.get(contentIndex)
  if (open === undefined) return []
  state.openText.delete(contentIndex)
  state.blocks[open.index] = { type: 'text', text: open.text }
  state.replayBlocks[open.index] = { type: 'text', text: open.text }
  return [{ type: 'block-end', index: open.index, block: { type: 'text', text: open.text } }]
}
function closeAnthropicTool(state: RelayOneAnthropicStreamState, contentIndex: number): StreamChunk[] {
  const tool = state.tools.get(contentIndex)
  if (tool === undefined) return []
  state.tools.delete(contentIndex)
  if (!relayOneValidArguments(tool.arguments) || tool.name === '') {
    throw new LlmError('RelayOne returned invalid JSON arguments for tool ' + (tool.name || '(unnamed)') + '.', 'INVALID_TOOL_ARGUMENTS')
  }
  const args = tool.arguments || '{}'
  const parsed = relayOneSafeJson(args)
  state.blocks[tool.index] = { type: 'tool-call', id: toToolCallId(tool.id), name: tool.name, arguments: args }
  state.replayBlocks[tool.index] = { type: 'tool_use', id: tool.id, name: tool.name, input: isRelayOneRecord(parsed) ? parsed : {} }
  state.hasToolCall = true
  return [{ type: 'block-end', index: tool.index, block: { type: 'tool-call', id: toToolCallId(tool.id), name: tool.name, arguments: args } }]
}
function closeAnthropicThinking(state: RelayOneAnthropicStreamState, contentIndex: number): StreamChunk[] {
  const thinking = state.thinking.get(contentIndex)
  if (thinking === undefined) return []
  state.thinking.delete(contentIndex)
  const text = thinking.kind === 'thinking' ? thinking.text : ''
  state.blocks[thinking.index] = { type: 'reasoning', text }
  state.replayBlocks[thinking.index] = thinking.kind === 'redacted_thinking'
    ? { type: 'redacted_thinking', data: thinking.data, ...(thinking.signature ? { signature: thinking.signature } : {}) }
    : { type: 'thinking', thinking: thinking.text, ...(thinking.signature ? { signature: thinking.signature } : {}) }
  state.reasoningTokens += Math.ceil(text.length / 4)
  return [{ type: 'block-end', index: thinking.index, block: { type: 'reasoning', text } }]
}
function flushAnthropic(state: RelayOneAnthropicStreamState): StreamChunk[] {
  const closers: Array<{ index: number; close: () => StreamChunk[] }> = []
  for (const [key, open] of state.openText) closers.push({ index: open.index, close: () => closeAnthropicText(state, key) })
  for (const [key, tool] of state.tools) closers.push({ index: tool.index, close: () => closeAnthropicTool(state, key) })
  for (const [key, thinking] of state.thinking) closers.push({ index: thinking.index, close: () => closeAnthropicThinking(state, key) })
  closers.sort((a, b) => a.index - b.index)
  return closers.flatMap(item => item.close())
}
function applyAnthropicUsage(state: RelayOneAnthropicStreamState, raw: unknown, cumulativeOutput: boolean): void {
  if (!isRelayOneRecord(raw)) return
  state.sawUsage = true
  state.inputTokens = relayOneNumber(raw.input_tokens) ?? state.inputTokens
  state.cacheReadTokens = relayOneNumber(raw.cache_read_input_tokens) ?? state.cacheReadTokens
  state.cacheWriteTokens = relayOneNumber(raw.cache_creation_input_tokens) ?? state.cacheWriteTokens
  const output = relayOneNumber(raw.output_tokens)
  if (output !== undefined) state.outputTokens = cumulativeOutput ? output : state.outputTokens + output
  const details = isRelayOneRecord(raw.output_tokens_details) ? raw.output_tokens_details : undefined
  const reasoning = relayOneNumber(details?.thinking_tokens)
  if (reasoning !== undefined) state.reasoningTokens = reasoning
}
function anthropicUsage(state: RelayOneAnthropicStreamState): TokenUsage {
  return {
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    ...(state.cacheReadTokens > 0 ? { cacheReadTokens: state.cacheReadTokens } : {}),
    ...(state.cacheWriteTokens > 0 ? { cacheWriteTokens: state.cacheWriteTokens } : {}),
    ...(state.reasoningTokens > 0 ? { reasoningTokens: Math.min(state.reasoningTokens, state.outputTokens) } : {}),
  }
}
export function closeRelayOneAnthropicStream(state: RelayOneAnthropicStreamState): StreamChunk[] {
  if (state.finished) return []
  state.finished = true
  const out = flushAnthropic(state)
  if (state.sawUsage) out.push({ type: 'usage', usage: anthropicUsage(state) })
  const reason = state.finishReason === 'max_tokens' || state.finishReason === 'model_context_window_exceeded'
    ? { kind: 'max-tokens' as const }
    : state.finishReason === 'refusal' || state.finishReason === 'sensitive'
      ? { kind: 'error' as const, failure: { message: state.stopExplanation ?? 'RelayOne Claude declined to respond.', code: 'PROVIDER_ERROR' } }
      : state.hasToolCall || state.finishReason === 'tool_use' ? { kind: 'tool-calls' as const } : { kind: 'stop' as const }
  out.push({
    type: 'finish', reason,
    replayState: { response: { provider: 'relayone', protocol: 'anthropic' }, blocks: Array.from(state.replayBlocks, block => block ?? null) },
  })
  return out
}
export function assertRelayOneAnthropicStreamComplete(state: RelayOneAnthropicStreamState): void {
  if (!state.sawMessageStop) throw new LlmError('RelayOne Anthropic stream ended before message_stop.', 'PROTOCOL_ERROR')
}
export function feedRelayOneAnthropicPayload(state: RelayOneAnthropicStreamState, event: unknown): StreamChunk[] {
  if (state.finished || !isRelayOneRecord(event)) return []
  const type = relayOneString(event.type)
  if (type === 'error') {
    const error = isRelayOneRecord(event.error) ? event.error : event
    throw new LlmError(relayOneString(error.message) ?? 'RelayOne Anthropic stream failed.', 'PROVIDER_ERROR')
  }
  if (type === 'message_start') {
    state.sawMessageStart = true
    const message = isRelayOneRecord(event.message) ? event.message : undefined
    applyAnthropicUsage(state, message?.usage, false)
    return []
  }
  if (type === 'content_block_start') {
    const contentIndex = relayOneNumber(event.index) ?? -1
    const block = isRelayOneRecord(event.content_block) ? event.content_block : {}
    const kind = relayOneString(block.type)
    if (kind === 'text') {
      const index = state.blocks.length
      const seed = relayOneString(block.text) ?? ''
      state.blocks.push({ type: 'text', text: '' })
      state.openText.set(contentIndex, { index, text: seed })
      return [
        { type: 'block-start', index, blockType: 'text' },
        ...(seed ? [{ type: 'text-delta', index, text: seed } as StreamChunk] : []),
      ]
    }
    if (kind === 'tool_use') {
      const index = state.blocks.length
      const id = relayOneString(block.id) ?? 'tool_' + contentIndex
      const name = relayOneString(block.name) ?? ''
      const input = isRelayOneRecord(block.input) ? block.input : {}
      const seed = Object.keys(input).length > 0 ? JSON.stringify(input) : ''
      state.blocks.push({ type: 'tool-call', id: toToolCallId(id), name, arguments: '' })
      state.tools.set(contentIndex, { index, id, name, arguments: seed })
      return [
        { type: 'block-start', index, blockType: 'tool-call' },
        { type: 'tool-call-delta', index, id: toToolCallId(id), name: name || undefined, argumentsDelta: seed },
      ]
    }
    if (kind === 'thinking' || kind === 'redacted_thinking') {
      const index = state.blocks.length
      const seed = kind === 'thinking' ? relayOneString(block.thinking) ?? '' : ''
      state.blocks.push({ type: 'reasoning', text: '' })
      state.thinking.set(contentIndex, {
        index, kind, text: seed, signature: relayOneString(block.signature) ?? '', data: relayOneString(block.data) ?? '',
      })
      return [
        { type: 'block-start', index, blockType: 'reasoning' },
        ...(seed ? [{ type: 'reasoning-delta', index, text: seed } as StreamChunk] : []),
      ]
    }
    return []
  }
  if (type === 'content_block_delta') {
    const contentIndex = relayOneNumber(event.index) ?? -1
    const delta = isRelayOneRecord(event.delta) ? event.delta : {}
    const kind = relayOneString(delta.type)
    if (kind === 'text_delta') {
      const open = state.openText.get(contentIndex)
      const text = relayOneString(delta.text) ?? ''
      if (open === undefined || text === '') return []
      open.text += text
      return [{ type: 'text-delta', index: open.index, text }]
    }
    if (kind === 'input_json_delta') {
      const tool = state.tools.get(contentIndex)
      const part = relayOneString(delta.partial_json) ?? ''
      if (tool === undefined || part === '') return []
      tool.arguments += part
      return [{ type: 'tool-call-delta', index: tool.index, id: toToolCallId(tool.id), name: tool.name || undefined, argumentsDelta: part }]
    }
    if (kind === 'thinking_delta') {
      const thinking = state.thinking.get(contentIndex)
      const text = relayOneString(delta.thinking) ?? ''
      if (thinking === undefined || text === '') return []
      thinking.text += text
      return [{ type: 'reasoning-delta', index: thinking.index, text }]
    }
    if (kind === 'signature_delta') {
      const thinking = state.thinking.get(contentIndex)
      if (thinking !== undefined) thinking.signature += relayOneString(delta.signature) ?? ''
    }
    return []
  }
  if (type === 'content_block_stop') {
    const contentIndex = relayOneNumber(event.index) ?? -1
    if (state.openText.has(contentIndex)) return closeAnthropicText(state, contentIndex)
    if (state.tools.has(contentIndex)) return closeAnthropicTool(state, contentIndex)
    if (state.thinking.has(contentIndex)) return closeAnthropicThinking(state, contentIndex)
    return []
  }
  if (type === 'message_delta') {
    const delta = isRelayOneRecord(event.delta) ? event.delta : {}
    state.finishReason = relayOneString(delta.stop_reason) ?? state.finishReason
    state.stopExplanation = relayOneString(isRelayOneRecord(delta.stop_details) ? delta.stop_details.explanation : undefined) ?? state.stopExplanation
    applyAnthropicUsage(state, event.usage, true)
    return []
  }
  if (type === 'message_stop') {
    state.sawMessageStop = true
    return closeRelayOneAnthropicStream(state)
  }
  return []
}
export function processRelayOneAnthropicLine(line: string, state: RelayOneAnthropicStreamState): StreamChunk[] {
  const trimmed = line.trim()
  if (state.finished || trimmed === '' || trimmed.startsWith(':') || trimmed.startsWith('event:')) return []
  if (!trimmed.startsWith('data:')) return []
  const data = trimmed.slice(5).trim()
  if (data === '' || data === '[DONE]') return []
  const parsed = relayOneSafeJson(data)
  if (!isRelayOneRecord(parsed)) throw new LlmError('RelayOne returned malformed Anthropic streaming JSON.', 'PROTOCOL_ERROR')
  return feedRelayOneAnthropicPayload(state, parsed)
}
