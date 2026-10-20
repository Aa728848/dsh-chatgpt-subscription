import { describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  buildClinePassBody,
  mapFinishReason,
  mapUsage,
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
