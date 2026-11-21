import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '../src/host/common/llm-compat.ts'
import {
  assertClaudeApiStreamComplete,
  closeClaudeApiStream,
  createClaudeApiStreamState,
  processClaudeApiLine,
  type ClaudeApiStreamState,
} from '../src/host/claude-api/stream.ts'

function run(events: unknown[]): { chunks: StreamChunk[]; state: ClaudeApiStreamState } {
  const state = createClaudeApiStreamState()
  const chunks = events.flatMap(event => processClaudeApiLine('data: ' + JSON.stringify(event), state))
  return { chunks, state }
}
const start = (usage?: unknown) => ({ type: 'message_start', message: { usage: usage ?? { input_tokens: 10, output_tokens: 0 } } })
const blockStart = (index: number, contentBlock: unknown) => ({ type: 'content_block_start', index, content_block: contentBlock })
const delta = (index: number, value: unknown) => ({ type: 'content_block_delta', index, delta: value })
const blockStop = (index: number) => ({ type: 'content_block_stop', index })
const messageDelta = (stopReason: string, usage?: unknown) => ({ type: 'message_delta', delta: { stop_reason: stopReason }, ...(usage !== undefined ? { usage } : {}) })
const messageStop = { type: 'message_stop' }

function finishOf(chunks: StreamChunk[]) {
  const chunk = chunks.find(item => item.type === 'finish')
  if (chunk === undefined || chunk.type !== 'finish') throw new Error('no finish chunk')
  return chunk
}
function usageOf(chunks: StreamChunk[]) {
  const chunk = chunks.find(item => item.type === 'usage')
  if (chunk === undefined || chunk.type !== 'usage') throw new Error('no usage chunk')
  return chunk.usage
}
const replayOf = (chunks: StreamChunk[]) => (finishOf(chunks).replayState as unknown as { blocks: Array<Record<string, unknown> | null> }).blocks

describe('claude-api stream', () => {
  it('streams text and finishes with usage and replay', () => {
    const { chunks } = run([
      start(), blockStart(0, { type: 'text', text: '' }),
      delta(0, { type: 'text_delta', text: 'Hel' }), delta(0, { type: 'text_delta', text: 'lo' }),
      blockStop(0), messageDelta('end_turn', { output_tokens: 5 }), messageStop,
    ])
    expect(chunks.map(chunk => chunk.type)).toEqual(['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish'])
    expect(finishOf(chunks).reason).toEqual({ kind: 'stop' })
    expect(replayOf(chunks)).toEqual([{ type: 'text', text: 'Hello' }])
    expect(usageOf(chunks)).toEqual({ inputTokens: 10, outputTokens: 5 })
  })

  it('assembles a tool call from streamed JSON fragments', () => {
    const { chunks } = run([
      start(), blockStart(0, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }),
      delta(0, { type: 'input_json_delta', partial_json: '{"comm' }), delta(0, { type: 'input_json_delta', partial_json: 'and":"ls"}' }),
      blockStop(0), messageDelta('tool_use', { output_tokens: 7 }), messageStop,
    ])
    const end = chunks.find(chunk => chunk.type === 'block-end')
    if (end === undefined || end.type !== 'block-end') throw new Error('no block-end')
    expect(end.block).toEqual({ type: 'tool-call', id: 'toolu_1', name: 'Bash', arguments: '{"command":"ls"}' })
    expect(chunks.some(chunk => chunk.type === 'tool-call-delta')).toBe(true)
    expect(finishOf(chunks).reason).toEqual({ kind: 'tool-calls' })
    expect(replayOf(chunks)).toEqual([{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }])
  })

  it('streams thinking deltas and keeps the signed block for replay', () => {
    const { chunks } = run([
      start(), blockStart(0, { type: 'thinking', thinking: '' }),
      delta(0, { type: 'thinking_delta', thinking: 'reason' }), delta(0, { type: 'signature_delta', signature: 'sig' }),
      blockStop(0), blockStart(1, { type: 'text', text: 'a' }), blockStop(1),
      messageDelta('end_turn'), messageStop,
    ])
    const reasoningDelta = chunks.find(chunk => chunk.type === 'reasoning-delta')
    expect(reasoningDelta).toEqual({ type: 'reasoning-delta', index: 0, text: 'reason' })
    expect(replayOf(chunks)[0]).toEqual({ type: 'thinking', thinking: 'reason', signature: 'sig' })
  })

  it('keeps empty thinking with a signature for replay and drops unsigned thinking', () => {
    const signed = run([start(), blockStart(0, { type: 'thinking' }), delta(0, { type: 'signature_delta', signature: 'sig' }), blockStop(0), messageDelta('end_turn'), messageStop])
    expect(replayOf(signed.chunks)[0]).toEqual({ type: 'thinking', thinking: '', signature: 'sig' })
    const unsigned = run([start(), blockStart(0, { type: 'thinking' }), delta(0, { type: 'thinking_delta', thinking: 'x' }), blockStop(0), messageDelta('end_turn'), messageStop])
    expect(replayOf(unsigned.chunks)[0]).toBeNull()
  })

  it('keeps server_tool_use and its result for replay without emitting DSH blocks', () => {
    const resultBlock = { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', title: 't', url: 'u', encrypted_content: 'e' }] }
    const { chunks } = run([
      start(), blockStart(0, { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} }),
      delta(0, { type: 'input_json_delta', partial_json: '{"query":"x"}' }), blockStop(0),
      blockStart(1, resultBlock), blockStop(1), messageDelta('end_turn'), messageStop,
    ])
    expect(chunks.map(chunk => chunk.type)).toEqual(['usage', 'finish'])
    expect(replayOf(chunks)).toEqual([
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'x' } },
      resultBlock,
    ])
  })

  it('handles the whole-block compaction event, sums usage.iterations and finishes normally', () => {
    const { chunks, state } = run([
      start({ input_tokens: 0, output_tokens: 0, iterations: [
        { type: 'compaction', input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 },
        { type: 'compaction', input_tokens: 200, output_tokens: 80 },
      ] }),
      blockStart(0, { type: 'compaction', content: 'SUMMARY', signature: 'csig', tool_changes: [] }),
      messageDelta('compaction', { output_tokens: 0 }), messageStop,
    ])
    expect(chunks.map(chunk => chunk.type)).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
    expect(state.compaction).toEqual({ content: 'SUMMARY', signature: 'csig', toolChanges: [] })
    expect(finishOf(chunks).reason).toEqual({ kind: 'stop' })
    expect(usageOf(chunks)).toEqual({ inputTokens: 300, outputTokens: 130, cacheReadTokens: 10 })
    expect(replayOf(chunks)).toEqual([{ type: 'compaction', content: 'SUMMARY', signature: 'csig', tool_changes: [] }])
  })

  it('treats a stream without message_stop as an error, never a success', () => {
    const state = createClaudeApiStreamState()
    processClaudeApiLine('data: ' + JSON.stringify(start()), state)
    processClaudeApiLine('data: ' + JSON.stringify(blockStart(0, { type: 'text', text: 'partial' })), state)
    const flushed = closeClaudeApiStream(state)
    expect(flushed.some(chunk => chunk.type === 'finish')).toBe(true)
    expect(() => assertClaudeApiStreamComplete(state)).toThrow(/message_stop/)
    const complete = run([start(), blockStart(0, { type: 'text', text: 'ok' }), blockStop(0), messageDelta('end_turn'), messageStop])
    expect(() => assertClaudeApiStreamComplete(complete.state)).not.toThrow()
  })

  it('finishes max_tokens when the summary could not be written', () => {
    const { chunks, state } = run([start(), blockStart(0, { type: 'compaction', content: '', signature: '' }), messageDelta('max_tokens'), messageStop])
    expect(finishOf(chunks).reason).toEqual({ kind: 'max-tokens' })
    expect(state.compaction?.content).toBe('')
  })

  it('throws on an error event and on malformed JSON', () => {
    expect(() => run([start(), { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])).toThrow(/Overloaded/)
    const state = createClaudeApiStreamState()
    expect(() => processClaudeApiLine('data: {bad', state)).toThrow(/malformed/)
  })

  it('throws on invalid tool arguments at block stop', () => {
    expect(() => run([
      start(), blockStart(0, { type: 'tool_use', id: 't', name: 'Bash', input: {} }),
      delta(0, { type: 'input_json_delta', partial_json: '{bad' }), blockStop(0),
    ])).toThrow(/invalid JSON arguments/)
  })

  it('ignores event lines, comments, blank lines and [DONE]', () => {
    const state = createClaudeApiStreamState()
    for (const line of ['event: content_block_delta', ': keep-alive', '', 'data: [DONE]', 'data:']) {
      expect(processClaudeApiLine(line, state)).toEqual([])
    }
  })

  it('reads cumulative output usage from message_delta', () => {
    const { chunks } = run([start({ input_tokens: 3, output_tokens: 1 }), messageDelta('end_turn', { output_tokens: 9 }), messageStop])
    expect(usageOf(chunks)).toEqual({ inputTokens: 3, outputTokens: 9 })
  })
})
