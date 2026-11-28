import type { GenerateOptions, Message, OutboundContentBlock, StreamChunk, TokenUsage } from '../../common/llm-compat.ts'
import { LlmError, formatMidConversationSystemReminder } from '../../common/llm-compat.ts'
import { toToolCallId } from '../../common/brand-compat.ts'
import { stripMetaSchema } from '../../common/tool-schema.ts'
import type { ResolvedRequestImages } from '../../common/request-images.ts'
import { appendGptEngineeringGuidance } from '../../common/gpt-engineering-guidance.ts'
import { isRelayOneOpenAIModel, type RelayOneModelEntry } from './model-catalog.ts'
import type { RelayOneSettings } from './token-store.ts'
import { latestRelayOneCompaction } from './remote-compaction.ts'
import {
  isRelayOneRecord,
  relayOneArgsText,
  relayOneEffort,
  relayOneImageParts,
  relayOneInstructionText,
  relayOneLeadingInstructionEndIndex,
  relayOneNumber,
  relayOneReplayOutputItems,
  relayOneSafeJson,
  relayOneString,
  relayOneSystemText,
  relayOneTextOf,
  relayOneToolResult,
  relayOneValidArguments,
} from './mapper-shared.ts'

const RELAYONE_GPT_TOOL_BATCH_GUIDANCE = 'After a batch of related tool results gives you a meaningful finding or completes a stage, send one short, user-visible assistant text update before the next batch of tool calls, then continue working in the same turn. Say what the results established, not just what you intend to do. Put the update in assistant text, not hidden reasoning or a tool argument. Skip routine batches with nothing new to report, and do not repeat an update already delivered through progress_update. Leave the full recap for the final answer.'

function relayOneGptGuidance(base: string, options: GenerateOptions, entry: RelayOneModelEntry): string {
  if (!/^gpt-/i.test(entry.id) || !options.tools?.length) return base
  return appendGptEngineeringGuidance(base, options.tools) + '\n\n' + RELAYONE_GPT_TOOL_BATCH_GUIDANCE
}

function relayOneGptSystemText(options: GenerateOptions, entry: RelayOneModelEntry): string {
  return relayOneGptGuidance(relayOneSystemText(options), options, entry)
}

// GPT 6.2+ places top-level instructions AFTER the cacheable input, even on hits.
// https://developers.openai.com/api/docs/guides/prompt-caching#how-prefix-matching-works
function usesCacheableDeveloperPrefix(id: string): boolean {
  const version = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/i.exec(id)
  const major = Number(version?.[1])
  return major > 6 || (major === 6 && Number(version?.[2] ?? 0) >= 2)
}

function relayOneResponsesInstructions(options: GenerateOptions, entry: RelayOneModelEntry): { base: string; current: string; leadingEnd: number; developerInInstructions: boolean } {
  const leadingEnd = relayOneLeadingInstructionEndIndex(options.messages)
  if (!usesCacheableDeveloperPrefix(entry.id)) {
    return { base: '', current: relayOneGptSystemText(options, entry), leadingEnd, developerInInstructions: false }
  }
  const base = [options.system?.trim() ?? '']
  for (let index = 0; index < leadingEnd; index += 1) {
    const text = relayOneInstructionText(options.messages[index]!)
    if (text !== '') base.push(text)
  }
  const current: string[] = []
  for (let index = leadingEnd; index < options.messages.length; index += 1) {
    const message = options.messages[index]!
    if (message.role !== 'developer') continue
    const text = relayOneInstructionText(message)
    if (text !== '') current.push(text)
  }
  return {
    base: relayOneGptGuidance(base.filter(Boolean).join('\n\n'), options, entry),
    current: current.join('\n\n'),
    leadingEnd,
    developerInInstructions: true,
  }
}

function responseMessageContent(
  message: Message,
  images: ResolvedRequestImages,
  accepted: boolean,
): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = []
  const textType = message.role === 'assistant' ? 'output_text' : 'input_text'
  const text = message.content.filter(block => block.type === 'text' || (block.type === 'reasoning' && message.role !== 'assistant'))
    .map(block => block.type === 'text' || block.type === 'reasoning' ? block.text : '').join('')
  if (text !== '') parts.push({ type: textType, text })
  for (const image of relayOneImageParts(message.content, images, accepted)) {
    if ('unavailable' in image) parts.push({ type: 'input_text', text: image.unavailable })
    else parts.push({ type: 'input_image', image_url: 'data:' + image.mediaType + ';base64,' + image.data })
  }
  return parts
}

/** Standard OpenAI Responses request; no Codex subscription-only headers or Lite items. */
export function buildRelayOneResponsesRequest(
  options: GenerateOptions,
  images: ResolvedRequestImages,
  entry: RelayOneModelEntry,
  settings: RelayOneSettings,
  compactionScope?: string,
): Record<string, unknown> {
  const input: Record<string, unknown>[] = []
  const knownCalls = new Set<string>()
  const nativeCompaction = compactionScope === undefined
    ? null : latestRelayOneCompaction(options.messages, options.model, compactionScope)
  const { base, current, leadingEnd, developerInInstructions } = relayOneResponsesInstructions(options, entry)
  if (base !== '') input.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: base }] })
  for (let index = leadingEnd; index < options.messages.length; index += 1) {
    const message = options.messages[index]!
    // The encrypted checkpoint replaces earlier wire input only; DSH keeps the
    // original transcript for display, editing, key changes, and local fallback.
    if (nativeCompaction !== null && index < nativeCompaction.index && message.role !== 'developer') continue
    if (message.role === 'developer' && developerInInstructions) continue
    if (message.role === 'system' || message.role === 'developer') {
      const text = relayOneInstructionText(message)
      if (text !== '') input.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] })
      continue
    }
    const toolResult = relayOneToolResult(message)
    if (toolResult !== undefined) {
      const callId = String(toolResult.toolCallId)
      const output = relayOneTextOf(toolResult.content)
      if (knownCalls.has(callId)) input.push({ type: 'function_call_output', call_id: callId, output })
      else input.push({ role: 'user', content: [{ type: 'input_text', text: 'Tool result for unavailable call ' + callId + ':\n' + output }] })
      continue
    }
    const replay = message.role === 'assistant'
      ? relayOneReplayOutputItems(message)?.filter(item => item.type !== 'compaction'
        || (nativeCompaction !== null && index === nativeCompaction.index)) ?? null
      : null
    const content = responseMessageContent(message, images, entry.supportsImages)
    const hasReplayText = replay?.some(item => item.type === 'message' && Array.isArray(item.content) && item.content.some(part => {
      if (!isRelayOneRecord(part)) return false
      const text = part.type === 'output_text' ? relayOneString(part.text)
        : part.type === 'refusal' ? relayOneString(part.refusal) : undefined
      return Boolean(text?.trim())
    }))
    if (replay !== null) {
      // Some gateways stream visible text but send only function calls in the
      // completed output. Keep the observed text without duplicating native items.
      const firstCall = replay.findIndex(item => item.type === 'function_call')
      if (!hasReplayText && content.length > 0) {
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
  const tools = (options.tools ?? []).map(tool => ({
    type: 'function', name: tool.name, description: tool.description, strict: false,
    parameters: stripMetaSchema(tool.parameters),
  }))
  const effort = relayOneEffort(options, settings.defaultReasoningEffort, entry.reasoningEfforts)
  return {
    model: options.model,
    stream: true,
    ...(current === '' ? {} : { instructions: current }),
    input,
    ...(tools.length > 0 ? { tools, tool_choice: 'auto', parallel_tool_calls: true } : {}),
    ...(options.maxTokens === undefined ? {} : { max_output_tokens: options.maxTokens }),
    ...(effort === undefined ? {} : { reasoning: { effort } }),
    store: false,
  }
}

function chatContent(
  message: Message,
  images: ResolvedRequestImages,
  accepted: boolean,
): string | Record<string, unknown>[] {
  const text = message.content.filter(block => block.type === 'text' || (block.type === 'reasoning' && message.role !== 'assistant'))
    .map(block => block.type === 'text' || block.type === 'reasoning' ? block.text : '').join('')
  const imageParts = relayOneImageParts(message.content, images, accepted)
  if (imageParts.length === 0) return text
  const parts: Record<string, unknown>[] = []
  if (text !== '') parts.push({ type: 'text', text })
  for (const image of imageParts) {
    if ('unavailable' in image) parts.push({ type: 'text', text: image.unavailable })
    else parts.push({ type: 'image_url', image_url: { url: 'data:' + image.mediaType + ';base64,' + image.data } })
  }
  return parts
}

function relayOneChatUsesMaxCompletionTokens(entry: RelayOneModelEntry): boolean {
  const normalized = entry.id.toLowerCase()
  const model = normalized.slice(normalized.lastIndexOf('/') + 1)
  // Kimi and Qwen document the newer field. MiniMax, GLM, Step, DeepSeek,
  // Gemini and Claude's OpenAI-compatible face document `max_tokens`.
  return isRelayOneOpenAIModel(entry.id, entry.vendor) || model.startsWith('kimi-') || model.startsWith('qwen')
}

export function buildRelayOneChatRequest(
  options: GenerateOptions,
  images: ResolvedRequestImages,
  entry: RelayOneModelEntry,
  settings: RelayOneSettings,
): Record<string, unknown> {
  const messages: Record<string, unknown>[] = []
  const system = relayOneGptSystemText(options, entry)
  if (system !== '') messages.push({ role: 'system', content: system })
  const leadingEnd = relayOneLeadingInstructionEndIndex(options.messages)
  const knownCalls = new Set<string>()
  for (let index = leadingEnd; index < options.messages.length; index += 1) {
    const message = options.messages[index]!
    if (message.role === 'system' || message.role === 'developer') {
      const text = relayOneInstructionText(message)
      if (text !== '') messages.push({ role: 'user', content: formatMidConversationSystemReminder(text) })
      continue
    }
    const toolResult = relayOneToolResult(message)
    if (toolResult !== undefined) {
      const callId = String(toolResult.toolCallId)
      const output = relayOneTextOf(toolResult.content)
      if (knownCalls.has(callId)) messages.push({ role: 'tool', tool_call_id: callId, content: output })
      else messages.push({ role: 'user', content: 'Tool result for unavailable call ' + callId + ':\n' + output })
      continue
    }
    if (message.role === 'assistant') {
      const toolCalls = message.content.filter(block => block.type === 'tool-call').map(block => {
        if (block.type !== 'tool-call') throw new Error('unreachable')
        const id = String(block.id)
        knownCalls.add(id)
        return { id, type: 'function', function: { name: block.name, arguments: relayOneArgsText(block.arguments) } }
      })
      const content = chatContent(message, images, false)
      if (content !== '' || toolCalls.length > 0) messages.push({ role: 'assistant', content, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) })
      continue
    }
    messages.push({ role: 'user', content: chatContent(message, images, entry.supportsImages) })
  }
  const tools = (options.tools ?? []).map(tool => ({
    type: 'function', function: { name: tool.name, description: tool.description, parameters: stripMetaSchema(tool.parameters) },
  }))
  const effort = relayOneEffort(options, settings.defaultReasoningEffort, entry.reasoningEfforts)
  const normalized = entry.id.toLowerCase()
  const model = normalized.slice(normalized.lastIndexOf('/') + 1)
  const glm = model.startsWith('glm-')
  const deepSeekThinkingOff = effort === 'none' && model.startsWith('deepseek')
  return {
    model: options.model,
    messages,
    stream: true,
    // GLM's Chat contract rejects stream_options; other declared vendors accept it.
    ...(glm ? {} : { stream_options: { include_usage: true } }),
    ...(options.maxTokens === undefined ? {} : relayOneChatUsesMaxCompletionTokens(entry)
      ? { max_completion_tokens: options.maxTokens } : { max_tokens: options.maxTokens }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {}),
    ...(tools.length > 0 ? { tools, tool_choice: 'auto', ...(glm ? {} : { parallel_tool_calls: true }) } : {}),
    ...(effort === undefined || deepSeekThinkingOff ? {} : { reasoning_effort: effort }),
    ...(deepSeekThinkingOff ? { thinking: { type: 'disabled' } } : {}),
  }
}

interface OpenText { index: number; kind: 'text' | 'reasoning'; text: string }
interface PendingTool { index: number; id: string; name: string; arguments: string; started: boolean }
export interface RelayOneChatStreamState {
  blocks: OutboundContentBlock[]
  open: OpenText | null
  tools: Map<string, PendingTool>
  finishReason: string | null
  sawDone: boolean
  sawUsage: boolean
  usage: TokenUsage | null
  finished: boolean
}
export function createRelayOneChatStreamState(): RelayOneChatStreamState {
  return { blocks: [], open: null, tools: new Map(), finishReason: null, sawDone: false, sawUsage: false, usage: null, finished: false }
}
function closeChatText(state: RelayOneChatStreamState): StreamChunk[] {
  const open = state.open
  if (open === null) return []
  state.open = null
  const block = open.kind === 'text' ? { type: 'text' as const, text: open.text } : { type: 'reasoning' as const, text: open.text }
  state.blocks[open.index] = block
  return [{ type: 'block-end', index: open.index, block }]
}
function openChatText(state: RelayOneChatStreamState, kind: 'text' | 'reasoning'): StreamChunk[] {
  if (state.open?.kind === kind) return []
  const out = closeChatText(state)
  const index = state.blocks.length
  state.blocks.push({ type: kind, text: '' } as OutboundContentBlock)
  state.open = { index, kind, text: '' }
  out.push({ type: 'block-start', index, blockType: kind })
  return out
}
function appendChatText(state: RelayOneChatStreamState, kind: 'text' | 'reasoning', delta: string): StreamChunk[] {
  if (delta === '') return []
  const out = openChatText(state, kind)
  const open = state.open!
  open.text += delta
  out.push({ type: kind === 'text' ? 'text-delta' : 'reasoning-delta', index: open.index, text: delta } as StreamChunk)
  return out
}
function parseChatUsage(raw: unknown): TokenUsage | null {
  if (!isRelayOneRecord(raw)) return null
  const prompt = relayOneNumber(raw.prompt_tokens) ?? 0
  const output = relayOneNumber(raw.completion_tokens) ?? 0
  const details = isRelayOneRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : {}
  const cached = relayOneNumber(details.cached_tokens)
  const written = relayOneNumber(details.cache_write_tokens) ?? relayOneNumber(details.cache_creation_input_tokens)
  const reasoning = relayOneNumber(isRelayOneRecord(raw.completion_tokens_details) ? raw.completion_tokens_details.reasoning_tokens : undefined)
  return {
    inputTokens: Math.max(0, prompt - (cached ?? 0) - (written ?? 0)), outputTokens: output,
    ...(cached === undefined ? {} : { cacheReadTokens: cached }),
    ...(written === undefined ? {} : { cacheWriteTokens: written }),
    ...(reasoning === undefined ? {} : { reasoningTokens: Math.min(reasoning, output) }),
  }
}
function chatToolKey(raw: Record<string, unknown>, position: number): string {
  const index = relayOneNumber(raw.index)
  if (index !== undefined) return 'index:' + index
  return 'id:' + (relayOneString(raw.id) ?? position.toString())
}
export function feedRelayOneChatPayload(state: RelayOneChatStreamState, payload: unknown): StreamChunk[] {
  if (state.finished || !isRelayOneRecord(payload)) return []
  if (isRelayOneRecord(payload.error)) throw new LlmError(relayOneString(payload.error.message) ?? 'RelayOne returned an in-band error.', 'PROVIDER_ERROR')
  const usage = parseChatUsage(payload.usage)
  if (usage !== null) { state.sawUsage = true; state.usage = usage }
  const choices = Array.isArray(payload.choices) ? payload.choices : []
  const choice = choices.length > 0 && isRelayOneRecord(choices[0]) ? choices[0] : null
  if (choice === null) return []
  const delta = isRelayOneRecord(choice.delta) ? choice.delta : isRelayOneRecord(choice.message) ? choice.message : {}
  let out: StreamChunk[] = []
  const content = relayOneString(delta.content)
  if (content !== undefined) out.push(...appendChatText(state, 'text', content))
  const reasoning = relayOneString(delta.reasoning_content) ?? relayOneString(delta.reasoning)
  if (reasoning !== undefined) out.push(...appendChatText(state, 'reasoning', reasoning))
  if (Array.isArray(delta.tool_calls)) {
    out.push(...closeChatText(state))
    delta.tool_calls.forEach((raw, position) => {
      if (!isRelayOneRecord(raw)) return
      const key = chatToolKey(raw, position)
      let tool = state.tools.get(key)
      const fn = isRelayOneRecord(raw.function) ? raw.function : {}
      if (tool === undefined) {
        tool = {
          index: state.blocks.length,
          id: relayOneString(raw.id) ?? 'call_' + key,
          name: relayOneString(fn.name) ?? '',
          arguments: '', started: false,
        }
        state.tools.set(key, tool)
        state.blocks.push({ type: 'tool-call', id: toToolCallId(tool.id), name: tool.name, arguments: '' })
      }
      tool.id = relayOneString(raw.id) ?? tool.id
      tool.name = relayOneString(fn.name) ?? tool.name
      const args = relayOneString(fn.arguments) ?? ''
      if (!tool.started) {
        tool.started = true
        out.push({ type: 'block-start', index: tool.index, blockType: 'tool-call' })
      }
      tool.arguments += args
      out.push({ type: 'tool-call-delta', index: tool.index, id: toToolCallId(tool.id), name: tool.name || undefined, argumentsDelta: args })
    })
  }
  const finish = relayOneString(choice.finish_reason)
  if (finish !== undefined && finish !== '') state.finishReason = finish
  return out
}
export function closeRelayOneChatStream(state: RelayOneChatStreamState): StreamChunk[] {
  if (state.finished) return []
  state.finished = true
  const out = closeChatText(state)
  let validTools = 0
  for (const tool of state.tools.values()) {
    if (!tool.started) continue
    if (!relayOneValidArguments(tool.arguments) || tool.name === '') {
      throw new LlmError('RelayOne returned invalid JSON arguments for tool ' + (tool.name || '(unnamed)') + '.', 'INVALID_TOOL_ARGUMENTS')
    }
    validTools += 1
    out.push({ type: 'block-end', index: tool.index, block: { type: 'tool-call', id: toToolCallId(tool.id), name: tool.name, arguments: tool.arguments || '{}' } })
  }
  if (state.sawUsage && state.usage !== null) out.push({ type: 'usage', usage: state.usage })
  const reason = state.finishReason === 'length' ? { kind: 'max-tokens' as const }
    : state.finishReason === 'content_filter' ? { kind: 'error' as const, failure: { message: 'RelayOne content filter stopped the response.', code: 'CONTENT_FILTER' } }
      : validTools > 0 || state.finishReason === 'tool_calls' ? { kind: 'tool-calls' as const } : { kind: 'stop' as const }
  out.push({ type: 'finish', reason, replayState: { response: { provider: 'relayone', protocol: 'openai-chat' } } })
  return out
}
export function processRelayOneChatLine(line: string, state: RelayOneChatStreamState): StreamChunk[] {
  const trimmed = line.trim()
  if (state.finished || trimmed === '' || trimmed.startsWith(':') || trimmed.startsWith('event:')) return []
  if (!trimmed.startsWith('data:')) return []
  const data = trimmed.slice(5).trim()
  if (data === '') return []
  if (data === '[DONE]') { state.sawDone = true; return closeRelayOneChatStream(state) }
  const parsed = relayOneSafeJson(data)
  if (!isRelayOneRecord(parsed)) throw new LlmError('RelayOne returned malformed streaming JSON.', 'PROTOCOL_ERROR')
  return feedRelayOneChatPayload(state, parsed)
}
export function assertRelayOneChatStreamComplete(state: RelayOneChatStreamState): void {
  if (!state.sawDone && state.finishReason === null) throw new LlmError('RelayOne chat stream ended before its terminal event.', 'PROTOCOL_ERROR')
}
