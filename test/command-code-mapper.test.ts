import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { GenerateOptions, StreamChunk } from '../src/host/common/llm-compat.ts'
import { PLUGIN_MESSAGE_SOURCE_KIND, normalizeGenerateOptions } from '../src/host/common/llm-compat.ts'
import {
  assertStreamComplete,
  buildAnthropicRequest,
  buildOpenAIRequest,
  buildRequest,
  closeStream,
  createStreamState,
  offloadOldestRequestImages,
  processAnthropicStreamLine,
  processOpenAIStreamLine,
  stripMetaSchema,
  thinkingBudgetFor,
} from '../src/host/command-code/mapper.ts'

/** One SSE frame, encoded the way a real provider sends it. */
function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}`
}

function options(overrides: Record<string, unknown> = {}): GenerateOptions {
  return {
    provider: 'command-code',
    model: 'deepseek/deepseek-v4.1-flash',
    messages: [
      // The harness MessageSourceMap has no catch-all `plugin` kind any more;
      // this package declares its own, and this contribution declares no form.
      { role: 'system', source: { kind: PLUGIN_MESSAGE_SOURCE_KIND }, content: [{ type: 'text', text: 'You are DSH.' }] },
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] },
    ],
    ...overrides,
  } as unknown as GenerateOptions
}

describe('Command Code request mapping', () => {
  it('builds an OpenAI chat-completions body with tools, stop, and reasoning effort', () => {
    const body = buildOpenAIRequest(options({
      reasoningEffort: 'max' as never,
      maxTokens: 4096,
      temperature: 0.2,
      stop: ['\n\n'],
      tools: [{ name: 'run_code', description: 'run', parameters: { $schema: 'x', type: 'object', properties: {} } }],
    }) as unknown as GenerateOptions)

    expect(body.model).toBe('deepseek/deepseek-v4.1-flash')
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.max_tokens).toBe(4096)
    expect(body.max_completion_tokens).toBeUndefined()
    expect(body.reasoning_effort).toBe('max')
    expect(body.temperature).toBe(0.2)
    expect(body.stop).toEqual(['\n\n'])
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are DSH.' },
      { role: 'user', content: 'hello' },
    ])
    expect((body.tools as Array<Record<string, unknown>>)[0]).toEqual({
      type: 'function',
      function: { name: 'run_code', description: 'run', parameters: { type: 'object', properties: {} } },
    })
    expect(body.tool_choice).toBe('auto')
  })

  it('uses max_completion_tokens for GPT-5 family models', () => {
    const body = buildOpenAIRequest(options({ model: 'gpt-5.6-sol' }) as unknown as GenerateOptions)
    expect(body.max_completion_tokens).toBe(128_000)
    expect(body.max_tokens).toBeUndefined()
  })

  it('projects tool results and assistant tool calls onto the OpenAI wire', () => {
    const body = buildOpenAIRequest(options({
      messages: [
        { role: 'assistant', source: { kind: 'model', provider: 'command-code', model: 'm' }, content: [
          { type: 'reasoning', text: 'thinking' },
          { type: 'text', text: 'let me look' },
          { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' },
        ] },
        { role: 'user', source: { kind: 'tool', callId: 'call_1' }, content: [
          { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'contents' }] },
        ] },
      ],
    }) as unknown as GenerateOptions)

    expect(body.messages).toEqual([
      { role: 'assistant', content: 'let me look', tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
      ] },
      { role: 'tool', tool_call_id: 'call_1', content: 'contents' },
    ])
  })

  it('builds an Anthropic messages body with a top-level system prompt', () => {
    const body = buildAnthropicRequest(options({
      model: 'claude-sonnet-4-6',
      temperature: 0.4,
      maxTokens: 8192,
      tools: [{ name: 'run_code', description: 'run', parameters: { type: 'object', properties: {} } }],
    }) as unknown as GenerateOptions)

    expect(body.model).toBe('claude-sonnet-4-6')
    expect(body.system).toBe('You are DSH.')
    expect(body.max_tokens).toBe(8192)
    expect(body.temperature).toBe(0.4)
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }])
    expect((body.tools as Array<Record<string, unknown>>)[0]).toEqual({
      name: 'run_code',
      description: 'run',
      input_schema: { type: 'object', properties: {} },
    })
    expect(body.thinking).toBeUndefined()
  })

  it('maps Anthropic tool results and tool calls onto content blocks and merges same-role turns', () => {
    const body = buildAnthropicRequest(options({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'assistant', source: { kind: 'model', provider: 'command-code', model: 'm' }, content: [{ type: 'tool-call', id: 'toolu_1', name: 'read_file', arguments: '{"path":"a"}' }] },
        { role: 'user', source: { kind: 'tool', callId: 'toolu_1' }, content: [
          { type: 'tool-result', toolCallId: 'toolu_1', content: [{ type: 'text', text: 'contents' }] },
        ] },
        { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'and now?' }] },
      ],
    }) as unknown as GenerateOptions)

    expect(body.messages).toEqual([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a' } }] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'contents' },
        { type: 'text', text: 'and now?' },
      ] },
    ])
  })

  it('projects a 0.1.7 tool-role result message identically on both wires', () => {
    // The harness now delivers the result as its own `role: 'tool'` message and
    // the adapter normalizes it; both generations must reach this same body.
    const messages = normalizeGenerateOptions({
      provider: 'command-code',
      model: 'deepseek/deepseek-v4.1-flash',
      messages: [
        createAssistantMessage({
          content: [{ type: 'tool-call', id: ToolCallId('call_1'), name: 'read_file', arguments: '{"path":"a"}' }],
          source: { provider: 'command-code', model: 'deepseek/deepseek-v4.1-flash' },
        }),
        createToolResultMessage({
          callId: ToolCallId('call_1'),
          content: [{ type: 'text', text: 'contents' }],
          isError: false,
        }),
      ],
    }).messages

    const openai = buildOpenAIRequest({ provider: 'command-code', model: 'deepseek/deepseek-v4.1-flash', messages }) as unknown as GenerateOptions
    expect(openai.messages).toEqual([
      { role: 'assistant', content: '', tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
      ] },
      { role: 'tool', tool_call_id: 'call_1', content: 'contents' },
    ])

    const anthropic = buildAnthropicRequest({ provider: 'command-code', model: 'claude-sonnet-4-6', messages }) as unknown as GenerateOptions
    expect(anthropic.messages).toEqual([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'contents' }] },
    ])
  })

  it('enables thinking only when the budget fits under max_tokens', () => {
    expect(thinkingBudgetFor('high', 8192)).toBe(7168)
    expect(thinkingBudgetFor('high', 2048)).toBe(1024)
    expect(thinkingBudgetFor('high', 1500)).toBeUndefined()
    expect(thinkingBudgetFor('max', 64_000)).toBe(32_768)
    expect(thinkingBudgetFor(undefined, 64_000)).toBeUndefined()

    const withThinking = buildAnthropicRequest(options({
      model: 'claude-sonnet-4-6',
      reasoningEffort: 'high' as never,
      maxTokens: 8192,
      temperature: 0.9,
    }) as unknown as GenerateOptions)
    expect(withThinking.thinking).toEqual({ type: 'enabled', budget_tokens: 7168 })
    // Thinking and an explicit temperature are mutually exclusive on this wire.
    expect(withThinking.temperature).toBeUndefined()
  })

  it('routes each model to the endpoint its format requires', () => {
    const openai = buildRequest(options(), 'openai')
    const anthropic = buildRequest(options({ model: 'claude-sonnet-4-6' }) as unknown as GenerateOptions, 'anthropic')
    expect(openai.messages).toBeDefined()
    expect(openai.system).toBeUndefined()
    expect(anthropic.system).toBe('You are DSH.')
    expect(anthropic.messages).toBeDefined()
  })

  it('drops only the $schema keyword from a tool schema', () => {
    expect(stripMetaSchema({ $schema: 'x', type: 'object', required: ['a'] })).toEqual({ type: 'object', required: ['a'] })
  })
})

describe('Command Code image projection', () => {
  const imageOptions = {
    provider: 'command-code',
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', source: { kind: 'user' }, content: [
      { type: 'text', text: 'look' },
      { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 100 } },
    ] }],
  } as unknown as GenerateOptions

  it('inlines resolved images as data URLs on the OpenAI wire', () => {
    const images = new Map([['att-1', { kind: 'inline' as const, mediaType: 'image/png', data: 'AAAA' }]])
    const body = buildOpenAIRequest(imageOptions, images)
    expect(body.messages).toEqual([{ role: 'user', content: [
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ] }])
  })

  it('inlines resolved images as base64 source blocks on the Anthropic wire', () => {
    const images = new Map([['att-1', { kind: 'inline' as const, mediaType: 'image/webp', data: 'BBBB' }]])
    const body = buildAnthropicRequest(imageOptions, images)
    expect(body.messages).toEqual([{ role: 'user', content: [
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'BBBB' } },
    ] }])
  })

  it('names an unreadable image instead of dropping it', () => {
    const images = new Map([['att-1', { kind: 'unavailable' as const }]])
    const body = buildAnthropicRequest(imageOptions, images)
    const blocks = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content
    expect(blocks[1]!.type).toBe('text')
    expect(String(blocks[1]!.text)).toContain('image unavailable')
  })

  it('offloads the oldest images once a request exceeds the byte budget', () => {
    const heavy = {
      provider: 'command-code',
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: 'a', bytes: 9 * 1024 * 1024 } }] },
        { role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: 'b', bytes: 9 * 1024 * 1024 } }] },
      ],
    } as unknown as GenerateOptions
    const offloaded = offloadOldestRequestImages(heavy)
    expect(offloaded).not.toBe(heavy)
    const first = offloaded.messages[0]!.content[0] as unknown as { type: string; text?: string }
    expect(first.type).toBe('text')
    expect(String(first.text)).toContain('image omitted')
    // Only enough oldest images are dropped to fit the budget; the byte estimate
    // comes from the durable references, so message 1 keeps its image block.
    expect((offloaded.messages[1]!.content[0] as unknown as { type: string }).type).toBe('image')
    expect(offloadOldestRequestImages(options({ messages: [
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: 'a', bytes: 10 } }] },
    ] }))).toBeDefined()
  })
})

describe('Command Code OpenAI stream decoding', () => {
  it('decodes reasoning, text, a tool call, usage, and the terminal finish', () => {
    const state = createStreamState('openai')
    const lines = [
      frame({ choices: [{ delta: { reasoning_content: 'let me think' } }] }),
      frame({ choices: [{ delta: { content: 'Hello' } }] }),
      frame({ choices: [{ delta: { content: ' world' } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'run_code', arguments: '{"code":' } }] } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"1"}' } }] } }] }),
      frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      frame({ choices: [], usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 40 },
        completion_tokens_details: { reasoning_tokens: 5 },
      } }),
      'data: [DONE]',
    ]
    const chunks: StreamChunk[] = []
    for (const line of lines) for (const chunk of processOpenAIStreamLine(line, state)) chunks.push(chunk)

    expect(chunks.filter((chunk) => chunk.type === 'block-start')).toHaveLength(3)
    expect(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => (chunk as { text: string }).text).join('')).toBe('Hello world')
    expect(chunks.filter((chunk) => chunk.type === 'reasoning-delta')).toHaveLength(1)
    const toolEnd = chunks.find((chunk) => chunk.type === 'block-end' && (chunk as { block: { type: string } }).block.type === 'tool-call') as { block: { arguments: string; name: string } }
    expect(toolEnd).toBeDefined()
    expect(toolEnd.block.arguments).toBe('{"code":"1"}')
    expect(toolEnd.block.name).toBe('run_code')
    const usage = chunks.find((chunk) => chunk.type === 'usage') as unknown as { usage: Record<string, number> }
    expect(usage.usage).toEqual({ inputTokens: 60, outputTokens: 20, cacheReadTokens: 40, reasoningTokens: 5 })
    expect(chunks[chunks.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(state.done).toBe(true)
  })

  it('stops emitting once the stream has finished', () => {
    const state = createStreamState('openai')
    processOpenAIStreamLine(frame({ choices: [{ delta: { content: 'a' }, finish_reason: 'stop' }] }), state)
    expect(state.finished).toBe(false)
    const terminal = processOpenAIStreamLine('data: [DONE]', state)
    expect(terminal[terminal.length - 1]!.type).toBe('finish')
    expect(processOpenAIStreamLine(frame({ choices: [{ delta: { content: 'late' } }] }), state)).toEqual([])
  })

  it('refuses to treat a truncated stream as complete, then flushes it', () => {
    const state = createStreamState('openai')
    processOpenAIStreamLine(frame({ choices: [{ delta: { content: 'partial' } }] }), state)
    expect(() => assertStreamComplete(state)).toThrow(/terminal event/)
    const flushed = closeStream(state)
    expect(flushed[flushed.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })
})

describe('Command Code Anthropic stream decoding', () => {
  it('decodes text, thinking, a tool use, and usage', () => {
    const state = createStreamState('anthropic')
    const lines = [
      frame({ type: 'message_start', message: { usage: { input_tokens: 30, cache_read_input_tokens: 10, output_tokens: 1 } } }),
      frame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
      frame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }),
      frame({ type: 'content_block_stop', index: 0 }),
      frame({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
      frame({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer' } }),
      frame({ type: 'content_block_stop', index: 1 }),
      frame({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'run_code' } }),
      frame({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"code":' } }),
      frame({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"1"}' } }),
      frame({ type: 'content_block_stop', index: 2 }),
      frame({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } }),
      frame({ type: 'message_stop' }),
    ]
    const chunks: StreamChunk[] = []
    for (const line of lines) for (const chunk of processAnthropicStreamLine(line, state)) chunks.push(chunk)

    expect(chunks.filter((chunk) => chunk.type === 'block-start')).toHaveLength(3)
    expect(chunks.filter((chunk) => chunk.type === 'text-delta')).toHaveLength(1)
    expect(chunks.filter((chunk) => chunk.type === 'reasoning-delta')).toHaveLength(1)
    const args = chunks
      .filter((chunk) => chunk.type === 'tool-call-delta')
      .map((chunk) => (chunk as { argumentsDelta: string }).argumentsDelta)
      .join('')
    expect(args).toBe('{"code":"1"}')
    const toolEnd = chunks.find((chunk) => chunk.type === 'block-end' && (chunk as { block: { type: string } }).block.type === 'tool-call') as { block: { arguments: string; name: string } }
    expect(toolEnd.block.arguments).toBe('{"code":"1"}')
    expect(toolEnd.block.name).toBe('run_code')
    const usage = chunks.find((chunk) => chunk.type === 'usage') as unknown as { usage: Record<string, number> }
    expect(usage.usage).toEqual({ inputTokens: 30, outputTokens: 42, cacheReadTokens: 10 })
    expect(chunks[chunks.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('ignores non-data lines and surfaces a provider error event', () => {
    const state = createStreamState('anthropic')
    expect(processAnthropicStreamLine('event: message_start', state)).toEqual([])
    expect(processAnthropicStreamLine('', state)).toEqual([])
    expect(processAnthropicStreamLine('data: nonsense', state)).toEqual([])
    expect(() => processAnthropicStreamLine(frame({ type: 'error', error: { message: 'boom' } }), state)).toThrow(/boom/)
  })

  it('maps a length stop reason to max-tokens', () => {
    const state = createStreamState('anthropic')
    expect(processAnthropicStreamLine(frame({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }), state)).toEqual([])
    const terminal = processAnthropicStreamLine(frame({ type: 'message_stop' }), state)
    expect(terminal[terminal.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('ends a plain text block that stopped without a following content block', () => {
    const state = createStreamState('anthropic')
    processAnthropicStreamLine(frame({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }), state)
    const deltas = processAnthropicStreamLine(frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }), state)
    expect(deltas).toContainEqual({ type: 'text-delta', index: 0, text: 'hi' })
    const stopped = processAnthropicStreamLine(frame({ type: 'content_block_stop', index: 0 }), state)
    expect(stopped).toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } })
  })
})
