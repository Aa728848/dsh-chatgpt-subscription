import { extractSystemText, formatMidConversationSystemReminder, LlmError, type ContentBlock, type GenerateOptions, type Message, type OutboundContentBlock, type StreamChunk, type TokenUsage } from '../../common/llm-compat.ts'
import { toToolCallId } from '../../common/brand-compat.ts'
import { stripMetaSchema } from '../../common/tool-schema.ts'
import { attachmentLabel, imageBlockToInline, offloadOldestRequestImages, unavailableImageText, type ResolvedRequestImages } from '../../common/request-images.ts'
import { OPENCODE_GO_MAX_REQUEST_IMAGE_BYTES } from './types.ts'
import { isOpenCodeGoReasoningEffort } from '../../../shared/opencode-go-contracts.ts'
import type { OpenCodeGoModelEntry } from './model-catalog.ts'
import type { OpenCodeGoSettings } from './token-store.ts'

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }
function numberValue(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined }
function argsText(value: unknown): string { if (typeof value === 'string') return value; try { return JSON.stringify(value ?? {}) } catch { return '{}' } }
function safeJson(value: string): unknown { try { return JSON.parse(value) as unknown } catch { return undefined } }
function validArguments(value: string): boolean { return isRecord(safeJson(value === '' ? '{}' : value)) }

function textOf(content: unknown): string {
  if (typeof content === 'string') return content.replace(/\0/g, '')
  if (!Array.isArray(content)) return ''
  return content.map(block => {
    if (!isRecord(block)) return ''
    if ((block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string') return block.text.replace(/\0/g, '')
    if (block.type === 'tool-result') return textOf(block.content)
    if (block.type === 'image') return '[image: ' + (attachmentLabel(block) ?? 'attached image') + ']'
    return ''
  }).filter(Boolean).join('\n')
}

function toolResult(message: Message): ContentBlock & { type: 'tool-result' } | undefined { return message.content.find((block): block is ContentBlock & { type: 'tool-result' } => block.type === 'tool-result') }
function instructionText(message: Message): string {
  const filtered = message.content.filter(block => block.type !== 'tool-addition' && block.type !== 'tool-removal')
  if (message.role === 'system') {
    const text = extractSystemText(filtered, value => value.replace(/\0/g, ''))
    if (text !== '') return text
  }
  return textOf(filtered).trim()
}
function leadingInstructionEndIndex(messages: readonly Message[]): number {
  let end = 0
  while (end < messages.length && (messages[end]?.role === 'system' || messages[end]?.role === 'developer')) end += 1
  return end
}
function systemText(options: GenerateOptions): string {
  const parts = [typeof options.system === 'string' ? options.system.trim() : '']
  for (let index = 0; index < leadingInstructionEndIndex(options.messages); index += 1) {
    const text = instructionText(options.messages[index]!)
    if (text !== '') parts.push(text)
  }
  return parts.filter(Boolean).join('\n\n')
}
function imageParts(content: readonly ContentBlock[], images: ResolvedRequestImages, accepted: boolean): Array<{ mediaType: string; data: string } | { unavailable: string }> {
  const result: Array<{ mediaType: string; data: string } | { unavailable: string }> = []
  for (const block of content) {
    if (block.type !== 'image') continue
    if (!accepted) { result.push({ unavailable: '[image omitted: the selected OpenCode Go model does not declare image input]' }); continue }
    const inline = imageBlockToInline(block as unknown as Record<string, unknown>, images)
    result.push(inline ?? { unavailable: unavailableImageText(block as unknown as Record<string, unknown>) })
  }
  return result
}
function chatContent(message: Message, images: ResolvedRequestImages, accepted: boolean): string | Record<string, unknown>[] {
  const text = message.content.filter(block => block.type === 'text' || (block.type === 'reasoning' && message.role !== 'assistant')).map(block => block.type === 'text' || block.type === 'reasoning' ? block.text : '').join('')
  const parts = imageParts(message.content, images, accepted)
  if (parts.length === 0) return text
  const out: Record<string, unknown>[] = []
  if (text !== '') out.push({ type: 'text', text })
  for (const image of parts) {
    if ('unavailable' in image) out.push({ type: 'text', text: image.unavailable })
    else out.push({ type: 'image_url', image_url: { url: 'data:' + image.mediaType + ';base64,' + image.data } })
  }
  return out
}
function reasoningEffort(options: GenerateOptions, settings: OpenCodeGoSettings, entry: OpenCodeGoModelEntry): string | undefined {
  const requested = typeof options.reasoningEffort === 'string' && options.reasoningEffort.trim() !== '' ? options.reasoningEffort.trim() : settings.defaultReasoningEffort
  return isOpenCodeGoReasoningEffort(requested) && entry.reasoningEfforts.includes(requested) ? requested : undefined
}

export function offloadOldestOpenCodeGoRequestImages(options: GenerateOptions, images: ResolvedRequestImages): GenerateOptions {
  return offloadOldestRequestImages(options, OPENCODE_GO_MAX_REQUEST_IMAGE_BYTES, images)
}

export function buildOpenCodeGoChatRequest(options: GenerateOptions, images: ResolvedRequestImages, entry: OpenCodeGoModelEntry, settings: OpenCodeGoSettings): Record<string, unknown> {
  const messages: Record<string, unknown>[] = []
  const system = systemText(options)
  if (system !== '') messages.push({ role: 'system', content: system })
  const knownCalls = new Set<string>()
  for (let index = leadingInstructionEndIndex(options.messages); index < options.messages.length; index += 1) {
    const message = options.messages[index]!
    if (message.role === 'system' || message.role === 'developer') {
      const text = instructionText(message)
      if (text !== '') messages.push({ role: 'user', content: formatMidConversationSystemReminder(text) })
      continue
    }
    const result = toolResult(message)
    if (result !== undefined) {
      const callId = String(result.toolCallId)
      const output = textOf(result.content)
      if (knownCalls.has(callId)) messages.push({ role: 'tool', tool_call_id: callId, content: output })
      else messages.push({ role: 'user', content: 'Tool result for unavailable call ' + callId + ':\n' + output })
      continue
    }
    if (message.role === 'assistant') {
      const toolCalls = message.content.filter(block => block.type === 'tool-call').map(block => {
        if (block.type !== 'tool-call') throw new Error('unreachable')
        const id = String(block.id)
        knownCalls.add(id)
        return { id, type: 'function', function: { name: block.name, arguments: argsText(block.arguments) } }
      })
      const content = chatContent(message, images, false)
      if (content !== '' || toolCalls.length > 0) messages.push({ role: 'assistant', content, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) })
      continue
    }
    messages.push({ role: 'user', content: chatContent(message, images, entry.supportsImages) })
  }
  const tools = entry.supportsTools ? (options.tools ?? []).map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: stripMetaSchema(tool.parameters) } })) : []
  const effort = reasoningEffort(options, settings, entry)
  return {
    model: options.model, messages, stream: true, stream_options: { include_usage: true },
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {}),
    ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    ...(effort === undefined ? {} : { reasoning_effort: effort }),
  }
}

interface OpenText { index: number; kind: 'text' | 'reasoning'; text: string }
interface PendingTool { index: number; id: string; name: string; arguments: string; started: boolean }
export interface OpenCodeGoChatStreamState {
  blocks: OutboundContentBlock[]
  open: OpenText | null
  tools: Map<string, PendingTool>
  finishReason: string | null
  sawDone: boolean
  sawUsage: boolean
  usage: TokenUsage | null
  billingSource: string | null
  allowance: number | null
  finished: boolean
}
export function createOpenCodeGoChatStreamState(): OpenCodeGoChatStreamState { return { blocks: [], open: null, tools: new Map(), finishReason: null, sawDone: false, sawUsage: false, usage: null, billingSource: null, allowance: null, finished: false } }
function closeChatText(state: OpenCodeGoChatStreamState): StreamChunk[] {
  const open = state.open
  if (open === null) return []
  state.open = null
  const block = open.kind === 'text' ? { type: 'text' as const, text: open.text } : { type: 'reasoning' as const, text: open.text }
  state.blocks[open.index] = block
  return [{ type: 'block-end', index: open.index, block }]
}
function openChatText(state: OpenCodeGoChatStreamState, kind: 'text' | 'reasoning'): StreamChunk[] {
  if (state.open?.kind === kind) return []
  const out = closeChatText(state)
  const index = state.blocks.length
  state.blocks.push({ type: kind, text: '' } as OutboundContentBlock)
  state.open = { index, kind, text: '' }
  out.push({ type: 'block-start', index, blockType: kind })
  return out
}
function appendChatText(state: OpenCodeGoChatStreamState, kind: 'text' | 'reasoning', delta: string): StreamChunk[] {
  if (delta === '') return []
  const out = openChatText(state, kind)
  state.open!.text += delta
  out.push({ type: kind === 'text' ? 'text-delta' : 'reasoning-delta', index: state.open!.index, text: delta } as StreamChunk)
  return out
}
function parseUsage(raw: unknown): TokenUsage | null {
  if (!isRecord(raw)) return null
  const prompt = numberValue(raw.prompt_tokens) ?? 0
  const output = numberValue(raw.completion_tokens) ?? 0
  const details = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : {}
  const metadata = isRecord(raw.opencode) ? raw.opencode : {}
  const billed = isRecord(metadata.tokens) ? metadata.tokens : {}
  const cached = numberValue(details.cached_tokens) ?? numberValue(billed.cache_read)
  const write5m = numberValue(billed.cache_write_5m)
  const write1h = numberValue(billed.cache_write_1h)
  const billedWrite = write5m === undefined && write1h === undefined ? undefined : (write5m ?? 0) + (write1h ?? 0)
  const written = numberValue(details.cache_write_tokens) ?? numberValue(details.cache_creation_input_tokens) ?? billedWrite
  const billedOutput = numberValue(billed.output)
  const reasoning = numberValue(isRecord(raw.completion_tokens_details) ? raw.completion_tokens_details.reasoning_tokens : undefined) ?? numberValue(billed.reasoning)
  const effectiveOutput = billedOutput ?? output
  return {
    inputTokens: numberValue(billed.input) ?? Math.max(0, prompt - (cached ?? 0) - (written ?? 0)),
    outputTokens: effectiveOutput,
    ...(cached === undefined ? {} : { cacheReadTokens: cached }),
    ...(written === undefined ? {} : { cacheWriteTokens: written }),
    ...(reasoning === undefined ? {} : { reasoningTokens: Math.min(reasoning, effectiveOutput) }),
  }
}
function toolKey(raw: Record<string, unknown>, position: number): string { const index = numberValue(raw.index); return index !== undefined ? 'index:' + index : 'id:' + (stringValue(raw.id) ?? position.toString()) }

export function feedOpenCodeGoChatPayload(state: OpenCodeGoChatStreamState, payload: unknown): StreamChunk[] {
  if (state.finished || !isRecord(payload)) return []
  if (isRecord(payload.error)) throw new LlmError(stringValue(payload.error.message) ?? 'OpenCode Go returned an in-band error.', 'PROVIDER_ERROR')
  const usage = parseUsage(payload.usage)
  if (usage !== null) { state.sawUsage = true; state.usage = usage }
  const metadata = isRecord(payload.usage) && isRecord(payload.usage.opencode) ? payload.usage.opencode : null
  if (metadata !== null && typeof metadata.billing_source === 'string') state.billingSource = metadata.billing_source
  const allowance = metadata === null ? undefined : numberValue(metadata.allowance)
  if (allowance !== undefined) state.allowance = allowance
  const choices = Array.isArray(payload.choices) ? payload.choices : []
  const choice = choices.length > 0 && isRecord(choices[0]) ? choices[0] : null
  if (choice === null) return []
  const delta = isRecord(choice.delta) ? choice.delta : isRecord(choice.message) ? choice.message : {}
  let out: StreamChunk[] = []
  const content = stringValue(delta.content)
  if (content !== undefined) out.push(...appendChatText(state, 'text', content))
  const reasoning = stringValue(delta.reasoning_content) ?? stringValue(delta.reasoning)
  if (reasoning !== undefined) out.push(...appendChatText(state, 'reasoning', reasoning))
  if (Array.isArray(delta.tool_calls)) {
    out.push(...closeChatText(state))
    delta.tool_calls.forEach((raw, position) => {
      if (!isRecord(raw)) return
      const key = toolKey(raw, position)
      let tool = state.tools.get(key)
      const fn = isRecord(raw.function) ? raw.function : {}
      if (tool === undefined) {
        tool = { index: state.blocks.length, id: stringValue(raw.id) ?? 'call_' + key, name: stringValue(fn.name) ?? '', arguments: '', started: false }
        state.tools.set(key, tool)
        state.blocks.push({ type: 'tool-call', id: toToolCallId(tool.id), name: tool.name, arguments: '' })
      }
      tool.id = stringValue(raw.id) ?? tool.id
      tool.name = stringValue(fn.name) ?? tool.name
      const args = stringValue(fn.arguments) ?? ''
      if (!tool.started) { tool.started = true; out.push({ type: 'block-start', index: tool.index, blockType: 'tool-call' }) }
      tool.arguments += args
      out.push({ type: 'tool-call-delta', index: tool.index, id: toToolCallId(tool.id), name: tool.name || undefined, argumentsDelta: args })
    })
  }
  const finish = stringValue(choice.finish_reason)
  if (finish !== undefined && finish !== '') state.finishReason = finish
  return out
}

export function closeOpenCodeGoStream(state: OpenCodeGoChatStreamState): StreamChunk[] {
  if (state.finished) return []
  state.finished = true
  const out = closeChatText(state)
  let validTools = 0
  for (const tool of state.tools.values()) {
    if (!tool.started) continue
    if (!validArguments(tool.arguments) || tool.name === '') throw new LlmError('OpenCode Go returned invalid JSON arguments for tool ' + (tool.name || '(unnamed)') + '.', 'INVALID_TOOL_ARGUMENTS')
    validTools += 1
    out.push({ type: 'block-end', index: tool.index, block: { type: 'tool-call', id: toToolCallId(tool.id), name: tool.name, arguments: tool.arguments || '{}' } })
  }
  if (state.sawUsage && state.usage !== null) out.push({ type: 'usage', usage: state.usage })
  const reason = state.finishReason === 'length' ? { kind: 'max-tokens' as const }
    : state.finishReason === 'content_filter' ? { kind: 'error' as const, failure: { message: 'OpenCode Go content filter stopped the response.', code: 'CONTENT_FILTER' } }
      : validTools > 0 || state.finishReason === 'tool_calls' ? { kind: 'tool-calls' as const } : { kind: 'stop' as const }
  out.push({ type: 'finish', reason, replayState: { response: { provider: 'opencode-go', protocol: 'openai-chat', ...(state.billingSource === null ? {} : { billingSource: state.billingSource }), ...(state.allowance === null ? {} : { allowance: state.allowance }) } } })
  return out
}

export function processOpenCodeGoStreamLine(line: string, state: OpenCodeGoChatStreamState): StreamChunk[] {
  const trimmed = line.trim()
  if (state.finished || trimmed === '' || trimmed.startsWith(':') || trimmed.startsWith('event:')) return []
  if (!trimmed.startsWith('data:')) return []
  const data = trimmed.slice(5).trim()
  if (data === '') return []
  if (data === '[DONE]') { state.sawDone = true; return closeOpenCodeGoStream(state) }
  const parsed = safeJson(data)
  if (!isRecord(parsed)) throw new LlmError('OpenCode Go returned malformed streaming JSON.', 'PROTOCOL_ERROR')
  return feedOpenCodeGoChatPayload(state, parsed)
}

export function assertOpenCodeGoStreamComplete(state: OpenCodeGoChatStreamState): void {
  if (!state.sawDone && state.finishReason === null) throw new LlmError('OpenCode Go chat stream ended before its terminal event.', 'PROTOCOL_ERROR')
}

export function openCodeGoPlanFromBillingSource(source: string | null): string | undefined {
  if (source === 'go') return 'Go'
  if (source === 'go-plus') return 'Go Plus'
  if (source === 'go-teams') return 'Go Teams'
  return undefined
}
