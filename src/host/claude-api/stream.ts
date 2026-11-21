/**
 * SSE state machine for the claude-api line: one Anthropic Messages event line in,
 * DSH StreamChunks out. Mirrors relayone/mapper-anthropic.ts (read, not imported)
 * with the claude-api additions:
 *
 * - a content_block_start of type "compaction" arrives WHOLE (no deltas): its content
 *   is emitted as text and exposed as state.compaction for the adapter to store;
 * - thinking blocks with empty text but a signature are kept for replay; unsigned
 *   thinking is not replayable and gets a null replay slot;
 * - server_tool_use and its result blocks are kept for replay verbatim without
 *   emitting DSH blocks (the harness must not dispatch a server-side call locally);
 * - usage is read from message_start / message_delta and, when usage.iterations is
 *   present, summed over the iterations (top-level counts are 0 on a compaction
 *   response);
 * - stop_reason "compaction" finishes normally; a stream without message_stop is an
 *   error (assertClaudeApiStreamComplete), never a success.
 */

import { LlmError, type OutboundContentBlock, type StreamChunk, type TokenUsage } from '../common/llm-compat.ts'
import { toToolCallId } from '../common/brand-compat.ts'

type Block = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
function asCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
function safeJson(text: string): unknown {
  try { return JSON.parse(text) as unknown } catch { return undefined }
}
function validArguments(text: string): boolean {
  return isRecord(safeJson(text === '' ? '{}' : text))
}

interface OpenText { index: number; text: string }
interface PendingTool { index: number; id: string; name: string; arguments: string }
interface PendingThinking { index: number; kind: 'thinking' | 'redacted_thinking'; text: string; signature: string; data: string }
interface PendingServerTool { replay: Block; arguments: string }

/** The whole-block compaction event the adapter stores and later replays. */
export interface ClaudeApiCompactionEvent { content: string; signature: string; toolChanges?: unknown }

export interface ClaudeApiStreamState {
  blocks: OutboundContentBlock[]
  openText: Map<number, OpenText>
  tools: Map<number, PendingTool>
  thinking: Map<number, PendingThinking>
  serverTools: Map<number, PendingServerTool>
  /** One slot per DSH block (reserved at open) plus replay-only wire blocks in wire order. */
  replayBlocks: (Block | null)[]
  compaction: ClaudeApiCompactionEvent | null
  sawMessageStart: boolean
  sawMessageStop: boolean
  finishReason: string | null
  stopExplanation: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  speed?: 'standard' | 'fast'
  serviceTier?: string
  inferenceGeo?: string
  sawUsage: boolean
  sawIterations: boolean
  finished: boolean
  hasToolCall: boolean
}

export function createClaudeApiStreamState(): ClaudeApiStreamState {
  return {
    blocks: [], openText: new Map(), tools: new Map(), thinking: new Map(), serverTools: new Map(),
    replayBlocks: [], compaction: null,
    sawMessageStart: false, sawMessageStop: false, finishReason: null, stopExplanation: null,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    sawUsage: false, sawIterations: false, finished: false, hasToolCall: false,
  }
}

function closeText(state: ClaudeApiStreamState, contentIndex: number): StreamChunk[] {
  const open = state.openText.get(contentIndex)
  if (open === undefined) return []
  state.openText.delete(contentIndex)
  state.blocks[open.index] = { type: 'text', text: open.text }
  state.replayBlocks[open.index] = { type: 'text', text: open.text }
  return [{ type: 'block-end', index: open.index, block: { type: 'text', text: open.text } }]
}

function closeTool(state: ClaudeApiStreamState, contentIndex: number): StreamChunk[] {
  const tool = state.tools.get(contentIndex)
  if (tool === undefined) return []
  state.tools.delete(contentIndex)
  if (!validArguments(tool.arguments) || tool.name === '') {
    throw new LlmError('Claude API returned invalid JSON arguments for tool ' + (tool.name || '(unnamed)') + '.', 'INVALID_TOOL_ARGUMENTS')
  }
  const args = tool.arguments || '{}'
  const parsed = safeJson(args)
  state.blocks[tool.index] = { type: 'tool-call', id: toToolCallId(tool.id), name: tool.name, arguments: args }
  state.replayBlocks[tool.index] = { type: 'tool_use', id: tool.id, name: tool.name, input: isRecord(parsed) ? parsed : {} }
  state.hasToolCall = true
  return [{ type: 'block-end', index: tool.index, block: { type: 'tool-call', id: toToolCallId(tool.id), name: tool.name, arguments: args } }]
}

function closeThinking(state: ClaudeApiStreamState, contentIndex: number): StreamChunk[] {
  const pending = state.thinking.get(contentIndex)
  if (pending === undefined) return []
  state.thinking.delete(contentIndex)
  const text = pending.kind === 'thinking' ? pending.text : ''
  state.blocks[pending.index] = { type: 'reasoning', text }
  // Empty text WITH a signature is replayable (the signature is what the prefix check
  // reads); without a signature the block must not be sent back unsigned.
  state.replayBlocks[pending.index] = pending.kind === 'redacted_thinking'
    ? (pending.data !== '' ? { type: 'redacted_thinking', data: pending.data, ...(pending.signature !== '' ? { signature: pending.signature } : {}) } : null)
    : (pending.signature !== '' ? { type: 'thinking', thinking: pending.text, signature: pending.signature } : null)
  state.reasoningTokens += Math.ceil(text.length / 4)
  return [{ type: 'block-end', index: pending.index, block: { type: 'reasoning', text } }]
}

function flushOpen(state: ClaudeApiStreamState): StreamChunk[] {
  const closers: Array<{ index: number; close: () => StreamChunk[] }> = []
  for (const [key, open] of state.openText) closers.push({ index: open.index, close: () => closeText(state, key) })
  for (const [key, tool] of state.tools) closers.push({ index: tool.index, close: () => closeTool(state, key) })
  for (const [key, pending] of state.thinking) closers.push({ index: pending.index, close: () => closeThinking(state, key) })
  closers.sort((a, b) => a.index - b.index)
  return closers.flatMap(item => item.close())
}

/**
 * Read one usage object. When iterations are present they carry the REAL counts (the
 * top-level fields are 0 on a compaction response), so they are summed and replace the
 * top-level reading; later top-level-only updates are then ignored.
 */
function applyUsage(state: ClaudeApiStreamState, raw: unknown, cumulativeOutput: boolean): void {
  if (!isRecord(raw)) return
  state.sawUsage = true
  if (raw.speed === 'standard' || raw.speed === 'fast') state.speed = raw.speed
  const serviceTier = asString(raw.service_tier)
  if (serviceTier !== undefined && serviceTier !== '') state.serviceTier = serviceTier
  const inferenceGeo = asString(raw.inference_geo)
  if (inferenceGeo !== undefined && inferenceGeo !== '') state.inferenceGeo = inferenceGeo
  const iterations = Array.isArray(raw.iterations) ? raw.iterations.filter(isRecord) : []
  if (iterations.length > 0) {
    state.sawIterations = true
    let input = 0
    let output = 0
    let cacheRead = 0
    let cacheWrite = 0
    let reasoning = 0
    for (const iteration of iterations) {
      input += asCount(iteration.input_tokens) ?? 0
      output += asCount(iteration.output_tokens) ?? 0
      cacheRead += asCount(iteration.cache_read_input_tokens) ?? 0
      cacheWrite += asCount(iteration.cache_creation_input_tokens) ?? 0
      const details = isRecord(iteration.output_tokens_details) ? iteration.output_tokens_details : undefined
      reasoning += asCount(details?.thinking_tokens) ?? 0
    }
    state.inputTokens = input
    state.outputTokens = output
    state.cacheReadTokens = cacheRead
    state.cacheWriteTokens = cacheWrite
    if (reasoning > 0) state.reasoningTokens = reasoning
    return
  }
  if (state.sawIterations) return
  state.inputTokens = asCount(raw.input_tokens) ?? state.inputTokens
  state.cacheReadTokens = asCount(raw.cache_read_input_tokens) ?? state.cacheReadTokens
  state.cacheWriteTokens = asCount(raw.cache_creation_input_tokens) ?? state.cacheWriteTokens
  const output = asCount(raw.output_tokens)
  if (output !== undefined) state.outputTokens = cumulativeOutput ? output : state.outputTokens + output
  const details = isRecord(raw.output_tokens_details) ? raw.output_tokens_details : undefined
  const reasoning = asCount(details?.thinking_tokens)
  if (reasoning !== undefined) state.reasoningTokens = reasoning
}

export type ClaudeApiTokenUsage = TokenUsage & {
  speed?: 'standard' | 'fast'
  service_tier?: string
  inference_geo?: string
}

function tokenUsage(state: ClaudeApiStreamState): ClaudeApiTokenUsage {
  return {
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    ...(state.cacheReadTokens > 0 ? { cacheReadTokens: state.cacheReadTokens } : {}),
    ...(state.cacheWriteTokens > 0 ? { cacheWriteTokens: state.cacheWriteTokens } : {}),
    ...(state.reasoningTokens > 0 ? { reasoningTokens: Math.min(state.reasoningTokens, state.outputTokens) } : {}),
    ...(state.speed === undefined ? {} : { speed: state.speed }),
    ...(state.serviceTier === undefined ? {} : { service_tier: state.serviceTier }),
    ...(state.inferenceGeo === undefined ? {} : { inference_geo: state.inferenceGeo }),
  }
}

export function closeClaudeApiStream(state: ClaudeApiStreamState): StreamChunk[] {
  if (state.finished) return []
  state.finished = true
  const out = flushOpen(state)
  if (state.sawUsage) out.push({ type: 'usage', usage: tokenUsage(state) })
  // 'compaction' finishes normally: the summary is the answer of an auxiliary call.
  const reason = state.finishReason === 'max_tokens' || state.finishReason === 'model_context_window_exceeded'
    ? { kind: 'max-tokens' as const }
    : state.finishReason === 'refusal' || state.finishReason === 'sensitive'
      ? { kind: 'error' as const, failure: { message: state.stopExplanation ?? 'Claude API declined to respond.', code: 'PROVIDER_ERROR' } }
      : state.hasToolCall || state.finishReason === 'tool_use' ? { kind: 'tool-calls' as const } : { kind: 'stop' as const }
  out.push({
    type: 'finish', reason,
    replayState: { response: { provider: 'claude-api', protocol: 'anthropic' }, blocks: Array.from(state.replayBlocks, block => block ?? null) },
  })
  return out
}

/** A stream that ends without message_stop is an error, never a success. */
export function assertClaudeApiStreamComplete(state: ClaudeApiStreamState): void {
  if (!state.sawMessageStop) throw new LlmError('Claude API stream ended before message_stop.', 'PROTOCOL_ERROR')
}

export function feedClaudeApiPayload(state: ClaudeApiStreamState, event: unknown): StreamChunk[] {
  if (state.finished || !isRecord(event)) return []
  const type = asString(event.type)
  if (type === 'error') {
    const error = isRecord(event.error) ? event.error : event
    throw new LlmError(asString(error.message) ?? 'Claude API stream failed.', 'PROVIDER_ERROR')
  }
  if (type === 'message_start') {
    state.sawMessageStart = true
    const message = isRecord(event.message) ? event.message : undefined
    applyUsage(state, message?.usage, false)
    return []
  }
  if (type === 'content_block_start') {
    const contentIndex = asCount(event.index) ?? -1
    const block = isRecord(event.content_block) ? event.content_block : {}
    const kind = asString(block.type)
    if (kind === 'compaction') {
      // The whole block arrives at once: emit its content as text and expose it for the
      // adapter. The replay slot keeps the WIRE block verbatim (content + signature).
      const content = asString(block.content) ?? ''
      const signature = asString(block.signature) ?? ''
      const toolChanges = block.tool_changes
      state.compaction = { content, signature, ...(toolChanges !== undefined ? { toolChanges } : {}) }
      const index = state.blocks.length
      state.blocks.push({ type: 'text', text: content })
      state.replayBlocks.push({ type: 'compaction', content, signature, ...(toolChanges !== undefined ? { tool_changes: toolChanges } : {}) })
      return [
        { type: 'block-start', index, blockType: 'text' },
        ...(content !== '' ? [{ type: 'text-delta', index, text: content } as StreamChunk] : []),
        { type: 'block-end', index, block: { type: 'text', text: content } },
      ]
    }
    if (kind === 'server_tool_use') {
      // Replay-only: no DSH block, so the harness never dispatches a server-side call.
      const input = isRecord(block.input) ? block.input : {}
      const replay: Block = { type: 'server_tool_use', id: asString(block.id) ?? '', name: asString(block.name) ?? '', input }
      state.replayBlocks.push(replay)
      state.serverTools.set(contentIndex, { replay, arguments: Object.keys(input).length > 0 ? JSON.stringify(input) : '' })
      return []
    }
    if (kind !== undefined && kind !== 'tool_result' && /_tool_result$/.test(kind)) {
      // Server tool result blocks arrive whole and are replayed verbatim.
      state.replayBlocks.push(structuredClone(block))
      return []
    }
    if (kind === 'text') {
      const index = state.blocks.length
      const seed = asString(block.text) ?? ''
      state.blocks.push({ type: 'text', text: '' })
      state.replayBlocks.push(null)
      state.openText.set(contentIndex, { index, text: seed })
      return [
        { type: 'block-start', index, blockType: 'text' },
        ...(seed ? [{ type: 'text-delta', index, text: seed } as StreamChunk] : []),
      ]
    }
    if (kind === 'tool_use') {
      const index = state.blocks.length
      const id = asString(block.id) ?? 'tool_' + contentIndex
      const name = asString(block.name) ?? ''
      const input = isRecord(block.input) ? block.input : {}
      const seed = Object.keys(input).length > 0 ? JSON.stringify(input) : ''
      state.blocks.push({ type: 'tool-call', id: toToolCallId(id), name, arguments: '' })
      state.replayBlocks.push(null)
      state.tools.set(contentIndex, { index, id, name, arguments: seed })
      return [
        { type: 'block-start', index, blockType: 'tool-call' },
        { type: 'tool-call-delta', index, id: toToolCallId(id), name: name || undefined, argumentsDelta: seed },
      ]
    }
    if (kind === 'thinking' || kind === 'redacted_thinking') {
      const index = state.blocks.length
      const seed = kind === 'thinking' ? asString(block.thinking) ?? '' : ''
      state.blocks.push({ type: 'reasoning', text: '' })
      state.replayBlocks.push(null)
      state.thinking.set(contentIndex, {
        index, kind, text: seed, signature: asString(block.signature) ?? '', data: asString(block.data) ?? '',
      })
      return [
        { type: 'block-start', index, blockType: 'reasoning' },
        ...(seed ? [{ type: 'reasoning-delta', index, text: seed } as StreamChunk] : []),
      ]
    }
    return []
  }
  if (type === 'content_block_delta') {
    const contentIndex = asCount(event.index) ?? -1
    const delta = isRecord(event.delta) ? event.delta : {}
    const kind = asString(delta.type)
    if (kind === 'text_delta') {
      const open = state.openText.get(contentIndex)
      const text = asString(delta.text) ?? ''
      if (open === undefined || text === '') return []
      open.text += text
      return [{ type: 'text-delta', index: open.index, text }]
    }
    if (kind === 'input_json_delta') {
      const part = asString(delta.partial_json) ?? ''
      if (part === '') return []
      const tool = state.tools.get(contentIndex)
      if (tool !== undefined) {
        tool.arguments += part
        return [{ type: 'tool-call-delta', index: tool.index, id: toToolCallId(tool.id), name: tool.name || undefined, argumentsDelta: part }]
      }
      const server = state.serverTools.get(contentIndex)
      if (server !== undefined) server.arguments += part
      return []
    }
    if (kind === 'thinking_delta') {
      const pending = state.thinking.get(contentIndex)
      const text = asString(delta.thinking) ?? ''
      if (pending === undefined || text === '') return []
      pending.text += text
      return [{ type: 'reasoning-delta', index: pending.index, text }]
    }
    if (kind === 'signature_delta') {
      const pending = state.thinking.get(contentIndex)
      if (pending !== undefined) pending.signature += asString(delta.signature) ?? ''
    }
    return []
  }
  if (type === 'content_block_stop') {
    const contentIndex = asCount(event.index) ?? -1
    if (state.openText.has(contentIndex)) return closeText(state, contentIndex)
    if (state.tools.has(contentIndex)) return closeTool(state, contentIndex)
    if (state.thinking.has(contentIndex)) return closeThinking(state, contentIndex)
    const server = state.serverTools.get(contentIndex)
    if (server !== undefined) {
      state.serverTools.delete(contentIndex)
      if (server.arguments !== '') {
        const parsed = safeJson(server.arguments)
        server.replay.input = isRecord(parsed) ? parsed : {}
      }
    }
    return []
  }
  if (type === 'message_delta') {
    const delta = isRecord(event.delta) ? event.delta : {}
    state.finishReason = asString(delta.stop_reason) ?? state.finishReason
    state.stopExplanation = asString(isRecord(delta.stop_details) ? delta.stop_details.explanation : undefined) ?? state.stopExplanation
    applyUsage(state, event.usage, true)
    return []
  }
  if (type === 'message_stop') {
    state.sawMessageStop = true
    return closeClaudeApiStream(state)
  }
  return []
}

export function processClaudeApiLine(line: string, state: ClaudeApiStreamState): StreamChunk[] {
  const trimmed = line.trim()
  if (state.finished || trimmed === '' || trimmed.startsWith(':') || trimmed.startsWith('event:')) return []
  if (!trimmed.startsWith('data:')) return []
  const data = trimmed.slice(5).trim()
  if (data === '' || data === '[DONE]') return []
  const parsed = safeJson(data)
  if (!isRecord(parsed)) throw new LlmError('Claude API returned malformed Anthropic streaming JSON.', 'PROTOCOL_ERROR')
  return feedClaudeApiPayload(state, parsed)
}
