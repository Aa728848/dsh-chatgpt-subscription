import { toToolCallId } from '../common/brand-compat.ts'
import type { OutboundContentBlock, StreamChunk } from '../common/llm-compat.ts'
import type { OllamaStreamEvent, OllamaToolCall } from './client.ts'

/**
 * Translate Ollama's stream events into DSH's block protocol.
 *
 * DSH wants a block opened, filled with deltas, then closed with the assembled
 * content. Ollama's surface streams text and tool calls as two interleaved
 * kinds of delta with no block framing of its own, so this state machine owns
 * the framing: one text block at a time, and one block per tool call that is
 * closed only once its arguments are complete.
 *
 * Closing a tool call late is the point. An arguments string arrives in pieces,
 * and a block closed on the first piece would hand the agent a truncated tool
 * invocation - which fails as a JSON parse error inside the model loop rather
 * than as anything that names the real cause.
 */
export interface OllamaStreamState {
  /** Index the next opened block takes. */
  nextBlockIndex: number
  /** The open text block, or null when the stream is on a tool call. */
  textBlock: { index: number; text: string } | null
  /** The open reasoning block, closed when the answer starts or a tool is called. */
  thinkingBlock: { index: number; text: string } | null
  /** Call id -> the call being accumulated, with the block it will close. */
  toolCalls: Map<string, { call: OllamaToolCall; blockIndex: number }>
  /** True once any content has been produced. */
  hasContent: boolean
}

export function createStreamState(): OllamaStreamState {
  return { nextBlockIndex: 0, textBlock: null, thinkingBlock: null, toolCalls: new Map(), hasContent: false }
}

/** Fold one event into chunks, opening and closing blocks as the stream needs. */
export function applyEvent(state: OllamaStreamState, event: OllamaStreamEvent): StreamChunk[] {
  if (event.type === 'text') return applyText(state, event.text)
  if (event.type === 'thinking') return applyThinking(state, event.text)
  if (event.type === 'tool_call') return applyToolCall(state, event.call)
  return []
}

/**
 * Fold a thinking delta into its own block.
 *
 * The trace and the answer interleave, so a text delta or a tool call closes
 * the reasoning block: two open blocks at once would hand the caller chunks in
 * an order the stream never produced.
 */
function applyThinking(state: OllamaStreamState, text: string): StreamChunk[] {
  state.hasContent = true
  if (state.thinkingBlock === null) {
    // A trace that starts after the answer began still has to close the text
    // block it interrupted.
    const out = closeText(state)
    const index = state.nextBlockIndex
    state.nextBlockIndex += 1
    state.thinkingBlock = { index, text }
    return [...out, { type: 'block-start', index, blockType: 'reasoning' }, { type: 'reasoning-delta', index, text }]
  }
  state.thinkingBlock.text += text
  return [{ type: 'reasoning-delta', index: state.thinkingBlock.index, text }]
}

function closeThinking(state: OllamaStreamState): StreamChunk[] {
  const block = state.thinkingBlock
  if (block === null) return []
  state.thinkingBlock = null
  return [{ type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }]
}

function applyText(state: OllamaStreamState, text: string): StreamChunk[] {
  state.hasContent = true
  // The answer never shares a block with the trace.
  const closed = closeThinking(state)
  if (state.textBlock === null) {
    closed.push({ type: 'block-start', index: state.nextBlockIndex, blockType: 'text' })
    const index = state.nextBlockIndex
    state.nextBlockIndex += 1
    state.textBlock = { index, text }
    closed.push({ type: 'text-delta', index, text })
    return closed
  }
  state.textBlock.text += text
  return [...closed, { type: 'text-delta', index: state.textBlock.index, text }]
}

function applyToolCall(state: OllamaStreamState, call: OllamaToolCall): StreamChunk[] {
  state.hasContent = true
  const out: StreamChunk[] = []
  // A text block open when a tool call arrives has to close first: the two
  // cannot interleave inside one block, and leaving it open would strand it.
  out.push(...closeThinking(state))
  out.push(...closeText(state))
  const index = state.nextBlockIndex
  state.nextBlockIndex += 1
  out.push({ type: 'block-start', index, blockType: 'tool-call' })
  state.toolCalls.set(call.id, { call, blockIndex: index })
  out.push({
    type: 'tool-call-delta',
    index,
    id: toToolCallId(call.id),
    name: call.name,
    // The call is already complete by the time the client emits it, so the whole
    // argument string arrives as one delta rather than being chunked by token.
    argumentsDelta: call.arguments === '' ? '{}' : call.arguments,
  })
  // Deliberately NOT closed here. A model can emit several tool calls in one
  // turn, and Ollama streams them as separate events; closing on the first would
  // settle it before the others existed. They all close together in
  // closeStream, and closeStream is what decides the turn ended on tool-calls.
  return out
}

function closeText(state: OllamaStreamState): StreamChunk[] {
  if (state.textBlock === null) return []
  const { index, text } = state.textBlock
  state.textBlock = null
  return [{ type: 'block-end', index, block: { type: 'text', text } }]
}

function closeToolCalls(state: OllamaStreamState): StreamChunk[] {
  const out: StreamChunk[] = []
  for (const entry of [...state.toolCalls.values()]) {
    const { call, blockIndex } = entry
    const block: OutboundContentBlock = {
      type: 'tool-call',
      id: toToolCallId(call.id),
      name: call.name,
      // An empty argument object is the honest value for a call the model ended
      // without naming any; '{}' is what the tool dispatcher can parse.
      arguments: call.arguments === '' ? '{}' : call.arguments,
    }
    out.push({ type: 'block-end', index: blockIndex, block })
  }
  state.toolCalls.clear()
  return out
}

/**
 * Close the turn.
 *
 * A stream that ends while a text block is still open is a real possibility - the
 * model can be cut off mid-sentence - so the block is closed with what arrived
 * rather than dropped, and the text the user sees is the text that streamed.
 */
export function closeStream(state: OllamaStreamState): StreamChunk[] {
  // Read this BEFORE closeToolCalls, which empties the map.
  const sawToolCall = state.toolCalls.size > 0
  const out: StreamChunk[] = [...closeThinking(state), ...closeText(state), ...closeToolCalls(state)]
  // A turn that asked for a tool ends on 'tool-calls', not 'stop'. Reporting stop
  // there would tell the agent loop the model is finished and cut the turn short
  // before the tool ever ran.
  out.push({ type: 'finish', reason: sawToolCall ? { kind: 'tool-calls' } : { kind: 'stop' } })
  return out
}
