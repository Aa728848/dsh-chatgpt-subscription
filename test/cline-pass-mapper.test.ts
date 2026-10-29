import { describe, expect, it } from 'vitest'
import { LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  buildClinePassBody,
  mapFinishReason,
  mapUsage,
  parseServerSentEvents,
  reasoningOf,
  serializeMessages,
  streamErrorCode,
  translate,
  type ClinePassWireBody,
} from '../src/host/cline-pass/mapper.ts'
import type { ContentBlock, GenerateOptions, Message } from '../src/host/common/llm-compat.ts'

function messagesOf(...messages: Message[]): GenerateOptions['messages'] {
  return messages
}

describe('Cline Pass request serialization', () => {
  it('maps developer to system and preserves tool-call groups', () => {
    const messages = messagesOf(
      { role: 'developer', content: [{ type: 'text', text: 'notice' }] },
      { role: 'user', content: [{ type: 'text', text: 'read it' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'reading' },
          { type: 'tool-call', id: ToolCallId('call_1'), name: 'read_file', arguments: '{"path":"a"}' },
        ],
      },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'body' }] }] },
      { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
    )
    expect(serializeMessages(messages, new Map())).toEqual([
      { role: 'system', content: 'notice' },
      { role: 'user', content: 'read it' },
      {
        role: 'assistant',
        content: 'reading',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'body' },
      { role: 'user', content: 'thanks' },
    ])
  })

  it('keeps a parallel tool group contiguous, deferring a message that would split it', () => {
    const messages = messagesOf(
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', id: ToolCallId('a'), name: 't1', arguments: '{}' },
          { type: 'tool-call', id: ToolCallId('b'), name: 't2', arguments: '{}' },
        ],
      },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'a', content: [{ type: 'text', text: 'A' }] }] },
      { role: 'user', content: [{ type: 'text', text: 'interrupting notice' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'b', content: [{ type: 'text', text: 'B' }] }] },
    )
    const wire = serializeMessages(messages, new Map())
    expect(wire.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user'])
    expect(wire[4]?.content).toBe('interrupting notice')
  })

  it('turns an image block into an OpenAI image part, and an unreadable one into text', () => {
    const images = new Map([['att_1', { kind: 'inline' as const, mediaType: 'image/png', data: 'AAAA' }]])
    const messages = messagesOf(
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', attachment: { attachmentId: 'att_1' } } as unknown as ContentBlock,
          { type: 'image', attachment: { attachmentId: 'att_missing' } } as unknown as ContentBlock,
        ],
      },
    )
    const wire = serializeMessages(messages, images)
    expect(wire[0]?.content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      expect.objectContaining({ type: 'text' }),
    ])
  })

  it('builds a streaming body with tools and the configured output budget', () => {
    const options = {
      provider: 'cline-pass',
      model: 'cline-pass/glm-5.3',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }],
      stream: true,
    } as unknown as GenerateOptions
    const body: ClinePassWireBody = buildClinePassBody(options, { maxTokens: 64_000 }, new Map())
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.max_tokens).toBe(64_000)
    expect(body.tools).toEqual([{ type: 'function', function: { name: 'read', description: 'Read', parameters: { type: 'object' } } }])
  })
})

async function* frames(...values: unknown[]): AsyncGenerator<unknown | '[DONE]'> {
  for (const value of values) yield value as unknown | '[DONE]'
}

describe('Cline Pass stream translation', () => {
  it('translates reasoning, text, a tool call, usage and finish', async () => {
    const chunks = []
    for await (const chunk of translate(frames(
      { choices: [{ delta: { reasoning_content: 'think' } }] },
      { choices: [{ delta: { content: 'hello' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"a"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }, finish_reason: 'tool_calls' }] },
      { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      '[DONE]',
    ))) chunks.push(chunk)
    expect(chunks.filter((chunk) => chunk.type === 'block-start').map((chunk) => (chunk as { blockType: string }).blockType))
      .toEqual(['reasoning', 'text', 'tool-call'])
    expect(chunks.find((chunk) => chunk.type === 'text-delta')).toMatchObject({ text: 'hello' })
    expect(chunks.filter((chunk) => chunk.type === 'tool-call-delta').map((chunk) => (chunk as { argumentsDelta: string }).argumentsDelta))
      .toEqual(['{"a"', ':1}'])
    expect(chunks.find((chunk) => chunk.type === 'block-end' && (chunk as { block: { type: string } }).block.type === 'tool-call'))
      .toMatchObject({ block: { type: 'tool-call', name: 'read', arguments: '{"a":1}' } })
    expect(chunks.find((chunk) => chunk.type === 'usage')).toMatchObject({ usage: { inputTokens: 10, outputTokens: 5 } })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('reports a content-free completion as an empty-response failure', async () => {
    const chunks = []
    for await (const chunk of translate(frames({ choices: [{ delta: {} }] }, '[DONE]'))) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE' } } })
  })

  it('reports a reasoning-only completion with NO_ANSWER_PHRASE so no-answer-resume can continue the turn', async () => {
    const chunks = []
    for await (const chunk of translate(frames(
      { choices: [{ delta: { reasoning_content: 'thinking only' }, finish_reason: 'stop' }] },
      '[DONE]',
    ))) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          code: 'PROVIDER_ERROR',
          message: expect.stringContaining('ended the turn without an answer or a tool call'),
        },
      },
    })
  })

  it('rejects a 200 body that is actually an error payload', async () => {
    const generator = translate(frames({ error: { message: 'no available providers' } }))
    await expect(generator.next()).rejects.toThrow('no available providers')
  })

  it('accepts both reasoning spellings', () => {
    expect(reasoningOf({ reasoning: 'a' })).toBe('a')
    expect(reasoningOf({ reasoning_content: 'b' })).toBe('b')
    expect(reasoningOf({ reasoning_details: [{ text: 'c' }, { text: 'd' }] })).toBe('cd')
  })

  it('subtracts cache reads out of the disjoint input count', () => {
    expect(mapUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } }))
      .toEqual({ inputTokens: 60, outputTokens: 20, totalTokens: 120, cacheReadTokens: 40 })
  })

  it('maps finish reasons and error codes to the harness vocabulary', () => {
    expect(mapFinishReason('length')).toMatchObject({ reason: { kind: 'max-tokens' } })
    expect(mapFinishReason('stop')).toMatchObject({ reason: { kind: 'stop' } })
    expect(streamErrorCode('invalid api key', 401)).toBe('AUTH')
    expect(streamErrorCode('weekly plan quota exhausted', 429)).toBe('QUOTA')
    expect(streamErrorCode('too many requests', 429)).toBe('RATE_LIMIT')
    expect(streamErrorCode('bad request', 400)).toBe('INVALID_REQUEST')
  })
})

/**
 * The confirmed Cline Pass fixes, one targeted case each.
 *
 * Wire shapes are written as literals on purpose: a shared generation-bound
 * factory would let a passing test say more about the factory than about the
 * bytes this route sends.
 */
describe('Cline Pass DeepSeek thinking switch', () => {
  function wireBody(model: string, reasoningEffort: string): ClinePassWireBody {
    return buildClinePassBody({
      provider: 'cline-pass',
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      stream: true,
      reasoningEffort,
    } as unknown as GenerateOptions, { maxTokens: 1024 }, new Map())
  }

  it('sends thinking disabled and no reasoning_effort for effort none on a DeepSeek model', () => {
    const body = wireBody('cline-pass/deepseek-v4.1-flash-1017', 'none')
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect('reasoning_effort' in body).toBe(false)
  })

  it('leaves a named DeepSeek level, and a non-DeepSeek model, exactly as they were', () => {
    const high = wireBody('cline-pass/deepseek-v4-pro', 'high')
    expect(high.reasoning_effort).toBe('high')
    expect(high.thinking).toBeUndefined()
    const other = wireBody('cline-pass/glm-5.2', 'none')
    expect(other.reasoning_effort).toBe('none')
    expect(other.thinking).toBeUndefined()
  })
})

describe('Cline Pass mid-conversation tool changes', () => {
  it('renders an addition and a removal as system text and never emits an empty system message', () => {
    const wire = serializeMessages(messagesOf(
      { role: 'developer', content: [{ type: 'tool-addition', toolName: 'read_file' }] },
      { role: 'developer', content: [{ type: 'tool-removal', toolName: 'old_search' }] },
      { role: 'developer', content: [{ type: 'text', text: 'plain notice' }] },
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
    ), new Map())
    expect(wire.map((message) => message.role)).toEqual(['system', 'system', 'system', 'user'])
    expect(String(wire[0]?.content)).toContain('read_file')
    expect(String(wire[0]?.content)).toMatch(/now available/)
    expect(String(wire[1]?.content)).toContain('old_search')
    expect(String(wire[1]?.content)).toMatch(/no longer available/)
    // Ordinary developer text is preserved verbatim, and no empty system survives.
    expect(wire[2]).toEqual({ role: 'system', content: 'plain notice' })
    expect(wire.filter((message) => String(message.content).trim() === '')).toEqual([])
  })
})

describe('Cline Pass request-order guards', () => {
  it('never sends a user message with neither text nor an image, and still sends pure tool results', () => {
    const wire = serializeMessages(messagesOf(
      { role: 'user', content: [] },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', id: ToolCallId('call_1'), name: 'read', arguments: '{}' }],
      },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'body' }] }] },
    ), new Map())
    expect(wire.map((message) => message.role)).toEqual(['assistant', 'tool'])
    expect(wire.filter((message) => message.role === 'user')).toEqual([])
  })

  it('refuses an orphan tool result before the request is built, naming the call id', () => {
    const orphanOptions = {
      provider: 'cline-pass',
      model: 'cline-pass/glm-5.3',
      messages: messagesOf(
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_orphan', content: [{ type: 'text', text: 'body' }] }] },
      ),
      stream: true,
    } as unknown as GenerateOptions
    let thrown: unknown
    try {
      buildClinePassBody(orphanOptions, { maxTokens: 1024 }, new Map())
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(LlmError)
    expect((thrown as { code?: string }).code).toBe('INVALID_REQUEST')
    expect((thrown as Error).message).toContain('call_orphan')
  })
})

/** One SSE body, delivered in a single chunk and then closed cleanly. */
function sseBody(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

describe('Cline Pass missing [DONE]', () => {
  it('completes a clean EOF that already carried a finish_reason, keeping block ends, usage and finish', async () => {
    const chunks = []
    for await (const chunk of translate(parseServerSentEvents(sseBody([
      'data: {"choices":[{"delta":{"content":"hello"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":1}}',
      '',
    ].join('\n\n'))))) chunks.push(chunk)
    expect(chunks.filter((chunk) => chunk.type === 'block-end')).toHaveLength(1)
    expect(chunks.find((chunk) => chunk.type === 'usage')).toMatchObject({ usage: { inputTokens: 4, outputTokens: 1 } })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('still rejects a truncated stream that carried content but no finish_reason', async () => {
    await expect((async () => {
      for await (const _chunk of translate(parseServerSentEvents(sseBody([
        'data: {"choices":[{"delta":{"content":"partial"}}]}',
        '',
      ].join('\n\n'))))) { /* drain */ }
    })()).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })
})
