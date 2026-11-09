import { beforeEach, describe, expect, it } from 'vitest'
import type { GenerateOptions, Message } from '../src/host/common/llm-compat.ts'
import {
  buildAnthropicRequest,
  buildOpenAIRequest,
  clampToolCallId,
  closeStream,
  createStreamState,
  isSideChannelTitleRequest,
  mapReasoningEffort,
  orderStaticPrefixMessages,
  prefixFingerprints,
  processAnthropicStreamLine,
  normalizeKimiToolSchema,
  processOpenAIStreamLine,
  promptCacheKey,
  buildRequest,
  getLastDriftCause,
  resetCacheStats,
  thinkingBudgetFor,
} from '../src/host/kimi-code/mapper.ts'

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    model: 'k3',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Hello there' }] } as Message,
    ],
    ...overrides,
  } as GenerateOptions
}

/** One user turn carrying a durable video occurrence. */
function videoMessage(attachmentId: string): Message {
  return {
    role: 'user',
    content: [{
      type: 'video',
      attachment: { attachmentId, mediaType: 'video/mp4', bytes: 4, name: attachmentId },
    }],
  } as unknown as Message
}

/** One user turn carrying a durable image occurrence. */
function imageMessage(attachmentId: string): Message {
  return {
    role: 'user',
    content: [{
      type: 'image',
      attachment: { attachmentId, mediaType: 'image/png', bytes: 1, name: attachmentId },
    }],
  } as unknown as Message
}

/** One tool result, as the harness records it. */
function toolResultMessage(toolCallId: string, text: string): Message {
  return {
    role: 'user',
    source: { kind: 'tool', callId: toolCallId } as never,
    content: [{
      type: 'tool-result',
      toolCallId,
      content: [{ type: 'text', text }],
    }],
  } as unknown as Message
}

describe('mapReasoningEffort', () => {
  it('maps the documented third-party effort vocabulary onto the three K3 levels', () => {
    // The service documents this mapping verbatim and answers anything outside
    // it with HTTP 400, so every accepted spelling must land on a real level.
    expect(mapReasoningEffort('low')).toBe('low')
    expect(mapReasoningEffort('minimum')).toBe('low')
    expect(mapReasoningEffort('light')).toBe('low')
    expect(mapReasoningEffort('high')).toBe('high')
    expect(mapReasoningEffort('medium')).toBe('high')
    expect(mapReasoningEffort('max')).toBe('max')
    expect(mapReasoningEffort('xhigh')).toBe('max')
    expect(mapReasoningEffort('ultra')).toBe('max')
  })

  it('maps every thinking-off spelling onto the disabled encoding', () => {
    expect(mapReasoningEffort('none')).toBe('none')
    expect(mapReasoningEffort('off')).toBe('none')
    expect(mapReasoningEffort('disabled')).toBe('none')
  })

  it('drops an unknown level rather than sending a value the service rejects', () => {
    expect(mapReasoningEffort('turbo')).toBeUndefined()
    expect(mapReasoningEffort(undefined)).toBeUndefined()
    expect(mapReasoningEffort('')).toBeUndefined()
  })
})

describe('buildOpenAIRequest', () => {
  it('sends reasoning_effort for a selected level', () => {
    const body = buildOpenAIRequest(options({ reasoningEffort: 'max' as never }))
    expect(body.reasoning_effort).toBe('max')
    // Preserved Thinking is on by default, so the thinking object rides along.
    expect(body.thinking).toEqual({ type: 'enabled', effort: 'max', keep: 'all' })
  })

  it('encodes thinking off as the disabled thinking block', () => {
    const body = buildOpenAIRequest(options({ reasoningEffort: 'none' as never }))
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('never sends a temperature, which the service fixes per model', () => {
    const body = buildOpenAIRequest(options({ temperature: 0.2 }))
    expect(body.temperature).toBeUndefined()
  })

  it('uses max_completion_tokens rather than the legacy field', () => {
    const body = buildOpenAIRequest(options())
    expect(body.max_completion_tokens).toBeTypeOf('number')
    expect(body.max_tokens).toBeUndefined()
  })

  it('enables streaming with usage so the quota accounting is complete', () => {
    const body = buildOpenAIRequest(options())
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('replays reasoning_content on an assistant turn that also calls a tool, omitting empty content', () => {
    // The service answers 400 "thinking is enabled but reasoning_content is
    // missing in assistant tool call message" without this field.
    // When text is empty, the content field is omitted per official Kimi provider conventions.
    const body = buildOpenAIRequest(options({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] } as Message,
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'I should read the file first.' },
            { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a"}' },
          ],
        } as Message,
      ],
    }))
    const assistant = (body.messages as Array<Record<string, unknown>>).find((entry) => entry.role === 'assistant')
    expect(assistant?.reasoning_content).toBe('I should read the file first.')
    expect(Array.isArray(assistant?.tool_calls)).toBe(true)
    expect(assistant).not.toHaveProperty('content')
  })

  it('preserves an assistant turn that has only reasoning content', () => {
    const body = buildOpenAIRequest(options({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'think' }] } as Message,
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'pondering deeply' },
          ],
        } as Message,
      ],
    }))
    const assistant = (body.messages as Array<Record<string, unknown>>).find((entry) => entry.role === 'assistant')
    expect(assistant).toBeDefined()
    expect(assistant?.reasoning_content).toBe('pondering deeply')
    expect(assistant?.content).toBe('')
  })

  it('replays reasoning_content on a plain assistant turn too', () => {
    // Preserved Thinking (the official default) requires the field on every
    // assistant message that lacks it, not only on tool-call turns.
    const body = buildOpenAIRequest(options({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] } as Message,
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'thinking' },
            { type: 'text', text: 'answer' },
          ],
        } as Message,
      ],
    }))
    const assistant = (body.messages as Array<Record<string, unknown>>).find((entry) => entry.role === 'assistant')
    expect(assistant?.reasoning_content).toBe('thinking')
    expect(assistant?.content).toBe('answer')
  })

  it('carries a stable prompt cache key that identifies the conversation', () => {
    const sessionId = 'sess-stable-key'
    const first = buildOpenAIRequest(options({ sessionId: sessionId as never }))
    const second = buildOpenAIRequest(options({ sessionId: sessionId as never }))
    expect(first.prompt_cache_key).toBeTruthy()
    expect(first.prompt_cache_key).toBe(second.prompt_cache_key)
    // A different conversation must not reuse the key.
    const other = buildOpenAIRequest(options({ sessionId: 'sess-other' as never }))
    expect(other.prompt_cache_key).not.toBe(first.prompt_cache_key)
  })

  it('keeps the cache key constant when compaction rewrites the first user message', () => {
    // The whole point of keying on the session (never message content): a
    // compaction that replaces the opening user turn must not re-route the
    // session onto a cold cache entry.
    const sessionId = 'sess-compaction'
    const before = buildOpenAIRequest(options({
      sessionId: sessionId as never,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Original opening request' }] } as Message],
    }))
    const after = buildOpenAIRequest(options({
      sessionId: sessionId as never,
      messages: [{ role: 'user', content: [{ type: 'text', text: '<compacted-summary>...checkpoint...</compacted-summary>' }] } as Message],
    }))
    expect(after.prompt_cache_key).toBe(before.prompt_cache_key)
  })

  it('declares tools in the OpenAI function shape', () => {
    const body = buildOpenAIRequest(options({
      tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } }] as never,
    }))
    expect(body.tool_choice).toBe('auto')
    expect(body.tools).toEqual([{
      type: 'function',
      function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } },
    }])
  })

  it('preserves the provider extras on a tool call', () => {
    // Kimi's gateway routes on the extras the provider attached to the call,
    // so they travel back out with it.
    const body = buildOpenAIRequest(options({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] } as Message,
        {
          role: 'assistant',
          content: [{
            type: 'tool-call',
            id: 'call_1',
            name: 'read',
            arguments: '{"path":"a"}',
            extras: { cache_control: { type: 'ephemeral' } },
          }],
        } as unknown as Message,
      ],
    }))
    const assistant = (body.messages as Array<Record<string, unknown>>).find((entry) => entry.role === 'assistant')
    const calls = assistant?.tool_calls as Array<Record<string, unknown>>
    expect(calls[0]?.extras).toEqual({ cache_control: { type: 'ephemeral' } })
  })

  it('leaves a tool call without extras exactly as it was', () => {
    const body = buildOpenAIRequest(options({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] } as Message,
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'call_1', name: 'read', arguments: '{}' }],
        } as unknown as Message,
      ],
    }))
    const assistant = (body.messages as Array<Record<string, unknown>>).find((entry) => entry.role === 'assistant')
    const calls = assistant?.tool_calls as Array<Record<string, unknown>>
    expect(calls[0]).not.toHaveProperty('extras')
  })

  it('answers a parallel tool call in the order the assistant declared it', () => {
    // The service reads the tool messages as the answers to the tool_calls
    // that precede them, so a result that arrived late must still be sent in
    // the declared order.
    const body = buildOpenAIRequest(options({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] } as Message,
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', id: 'call_a', name: 'read', arguments: '{}' },
            { type: 'tool-call', id: 'call_b', name: 'read', arguments: '{}' },
          ],
        } as unknown as Message,
        toolResultMessage('call_b', 'second result'),
        toolResultMessage('call_a', 'first result'),
      ],
    }))
    const wire = body.messages as Array<Record<string, unknown>>
    const answered = wire.filter((entry) => entry.role === 'tool')
    expect(answered.map((entry) => entry.tool_call_id)).toEqual(['call_a', 'call_b'])
    expect(answered.map((entry) => entry.content)).toEqual(['first result', 'second result'])
  })

  it('keeps a result that answers no declared call behind the answered ones', () => {
    const body = buildOpenAIRequest(options({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] } as Message,
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', id: 'call_a', name: 'read', arguments: '{}' },
            { type: 'tool-call', id: 'call_b', name: 'read', arguments: '{}' },
          ],
        } as unknown as Message,
        toolResultMessage('call_b', 'second result'),
        toolResultMessage('call_unknown', 'stray result'),
        toolResultMessage('call_a', 'first result'),
      ],
    }))
    const wire = body.messages as Array<Record<string, unknown>>
    const answered = wire.filter((entry) => entry.role === 'tool')
    // The declared calls are answered in the order they were declared; the
    // stray one answers no declared call and keeps its relative order behind
    // them.
    expect(answered.map((entry) => entry.tool_call_id)).toEqual(['call_a', 'call_b', 'call_unknown'])
  })

  it('normalizes tool schema with $defs, $ref and property type inference', () => {
    const rawSchema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $defs: {
        Color: { enum: ['red', 'blue'] },
      },
      type: 'object',
      properties: {
        color: { $ref: '#/$defs/Color' },
      },
    }
    const normalized = normalizeKimiToolSchema(rawSchema)
    expect(normalized).toEqual({
      type: 'object',
      properties: {
        color: {
          enum: ['red', 'blue'],
          type: 'string',
        },
      },
    })
    expect(normalized.$defs).toBeUndefined()
    expect(normalized.$schema).toBeUndefined()
  })
})

describe('buildAnthropicRequest', () => {
  it('encodes the depth as a top-level output_config.effort, as the official Kimi protocol does', () => {
    // The official `kimiAnthropicProtocol` sends `thinking: { type: 'enabled' }`
    // plus a top-level `output_config: { effort }`; there is no budget_tokens
    // form on this protocol.
    const body = buildAnthropicRequest(options({ reasoningEffort: 'high' as never }))
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.output_config).toEqual({ effort: 'high' })
  })

  it('sends a disabled thinking block for the none level and no effort at all', () => {
    const body = buildAnthropicRequest(options({ reasoningEffort: 'none' as never }))
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.output_config).toBeUndefined()
  })

  it('enables thinking by default, because the Kimi models reason by default', () => {
    const body = buildAnthropicRequest(options())
    expect(body.thinking).toEqual({ type: 'enabled' })
    // No level was chosen, so there is no effort to report.
    expect(body.output_config).toBeUndefined()
  })

  it('asks for the context-management beta and the clear-thinking edit', () => {
    const body = buildAnthropicRequest(options())
    expect(body.betas).toEqual(['context-management-2025-06-27'])
    expect(body.context_management).toEqual({
      edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
    })
  })

  it('omits the clear-thinking edit when preserved thinking is off', () => {
    const body = buildAnthropicRequest(options(), undefined, {}, false)
    expect(body.context_management).toBeUndefined()
    expect(body.thinking).toEqual({ type: 'enabled' })
  })

  it('drops temperature while thinking is on, which the wire forbids', () => {
    const body = buildAnthropicRequest(options({ reasoningEffort: 'high' as never, temperature: 0.5 }))
    expect(body.temperature).toBeUndefined()
  })

  it('sends the system prompt as a cacheable block array', () => {
    const body = buildAnthropicRequest(options({ system: 'You are Kimi.' }))
    expect(body.system).toEqual([
      { type: 'text', text: 'You are Kimi.', cache_control: { type: 'ephemeral' } },
    ])
  })

  it('marks the last tool as the cache breakpoint', () => {
    const body = buildAnthropicRequest(options({
      tools: [
        { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } },
        { name: 'write', description: 'Write a file', parameters: { type: 'object', properties: {} } },
      ] as never,
    }))
    const tools = body.tools as Array<Record<string, unknown>>
    expect(tools[0]?.cache_control).toBeUndefined()
    expect(tools[1]?.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('marks the last block of the last message as the cache breakpoint', () => {
    const body = buildAnthropicRequest(options({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'first' }] } as Message,
        { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } as Message,
      ],
    }))
    const messages = body.messages as Array<Record<string, unknown>>
    const content = messages[messages.length - 1]?.content as Array<Record<string, unknown>>
    expect(content[content.length - 1]?.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('replays the thinking block on an assistant turn', () => {
    // Kimi streams thinking without a signature yet rejects a tool-call turn
    // whose thinking is gone, so the block must survive the round trip.
    const body = buildAnthropicRequest(options({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] } as Message,
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'I should read the file first.' },
            { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a"}' },
          ],
        } as Message,
        // The call is answered: an unanswered tool_use is an orphan the mapper
        // drops, and this test is about the reasoning block surviving with it.
        { role: 'tool', source: { kind: 'tool', callId: 'call_1' }, content: [
          { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'file' }] },
        ] } as unknown as Message,
      ],
    }))
    const messages = body.messages as Array<Record<string, unknown>>
    const assistant = messages.find((entry) => entry.role === 'assistant')
    const content = assistant?.content as Array<Record<string, unknown>>
    expect(content[0]).toEqual({ type: 'thinking', thinking: 'I should read the file first.' })
    expect(content[1]?.type).toBe('tool_use')
  })

  it('carries a provider signature through when one arrived', () => {
    const body = buildAnthropicRequest(options({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] } as Message,
        {
          role: 'assistant',
          content: [{ type: 'reasoning', text: 'signed thinking', signature: 'sig-1' }],
        } as unknown as Message,
      ],
    }))
    const messages = body.messages as Array<Record<string, unknown>>
    const assistant = messages.find((entry) => entry.role === 'assistant')
    const content = assistant?.content as Array<Record<string, unknown>>
    expect(content[0]).toEqual({ type: 'thinking', thinking: 'signed thinking', signature: 'sig-1' })
  })

  it('sends a video as a native Anthropic video block', () => {
    const body = buildAnthropicRequest(
      options({ messages: [videoMessage('v1')] }),
      undefined,
      {
        videos: new Map([['v1', { kind: 'inline' as const, mediaType: 'video/mp4', data: 'AA' }]]),
        videoAccepted: true,
      },
    )
    const messages = body.messages as Array<Record<string, unknown>>
    const content = messages[0]?.content as Array<Record<string, unknown>>
    expect(content[0]).toEqual({
      type: 'video',
      source: { type: 'base64', media_type: 'video/mp4', data: 'AA' },
    })
  })

  it('cites a hosted video reference instead of inlining the bytes', () => {
    const body = buildAnthropicRequest(
      options({ messages: [videoMessage('v1')] }),
      undefined,
      { videoReferences: new Map([['v1', 'ms://v1']]), videoAccepted: true },
    )
    const messages = body.messages as Array<Record<string, unknown>>
    const content = messages[0]?.content as Array<Record<string, unknown>>
    expect(content[0]).toEqual({ type: 'video', source: { type: 'url', url: 'ms://v1' } })
  })

  it('cites a hosted image reference instead of inlining the bytes', () => {
    const body = buildAnthropicRequest(
      options({ messages: [imageMessage('a1')] }),
      undefined,
      { imageReferences: new Map([['a1', 'ms://a1']]) },
    )
    const messages = body.messages as Array<Record<string, unknown>>
    const content = messages[0]?.content as Array<Record<string, unknown>>
    expect(content[0]).toMatchObject({ type: 'image', source: { type: 'url', url: 'ms://a1' } })
  })

  it('degrades a video the selected model cannot take into plain text', () => {
    const body = buildAnthropicRequest(
      options({ messages: [videoMessage('v1')] }),
      undefined,
      {
        videos: new Map([['v1', { kind: 'inline' as const, mediaType: 'video/mp4', data: 'AA' }]]),
        videoAccepted: false,
      },
    )
    const messages = body.messages as Array<Record<string, unknown>>
    const content = messages[0]?.content as Array<Record<string, unknown>>
    expect(content[0]?.type).toBe('text')
    expect(String(content[0]?.text)).toContain('does not accept video input')
  })
})

describe('thinkingBudgetFor', () => {
  it('keeps the budget below max_tokens with room for the answer', () => {
    expect(thinkingBudgetFor('max', 32_768)).toBe(16_384)
    // A budget that cannot leave room for the answer is dropped rather than
    // sent invalid, because Anthropic requires it to stay below max_tokens.
    expect(thinkingBudgetFor('max', 2_000)).toBeUndefined()
  })

  it('has no budget when thinking is off', () => {
    expect(thinkingBudgetFor('none', 32_768)).toBeUndefined()
    expect(thinkingBudgetFor(undefined, 32_768)).toBeUndefined()
  })
})

describe('clampToolCallId', () => {
  it('caps an id at the 64 characters the service accepts', () => {
    const long = 'x'.repeat(80)
    expect(clampToolCallId(long)).toHaveLength(64)
    expect(clampToolCallId('short')).toBe('short')
  })
})

describe('promptCacheKey', () => {
  it('returns nothing for a conversation with no user turn and no sessionId', () => {
    expect(promptCacheKey({ model: 'k3', messages: [] } as unknown as GenerateOptions)).toBeUndefined()
  })

  it('prioritizes sessionId when present to maintain sticky routing', () => {
    expect(promptCacheKey({ model: 'k3', sessionId: 'sess-abc-123' as never, messages: [] } as unknown as GenerateOptions)).toBe('dsh-sess-abc-123')
    expect(promptCacheKey({
      model: 'k3',
      sessionId: 'sess-abc-123' as never,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] } as Message],
    } as unknown as GenerateOptions)).toBe('dsh-sess-abc-123')
  })

  it('never derives the key from message content, so a rewritten first message cannot drift it', () => {
    // Without a sessionId there is no key at all — a content-derived fallback
    // would change the moment compaction edits that message, silently re-routing
    // the conversation onto a cold cache entry.
    expect(promptCacheKey({
      model: 'k3',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] } as Message],
    } as unknown as GenerateOptions)).toBeUndefined()
    expect(promptCacheKey({
      model: 'k3',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'A completely different opening' }] } as Message],
    } as unknown as GenerateOptions)).toBeUndefined()
  })

  it('trims a sessionId with surrounding whitespace to the same key', () => {
    expect(promptCacheKey({ model: 'k3', sessionId: '  sess-padded  ' as never, messages: [] } as unknown as GenerateOptions)).toBe('dsh-sess-padded')
  })
})

describe('OpenAI stream parsing', () => {
  const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}`

  it('emits reasoning before text and finishes once', () => {
    const state = createStreamState('openai')
    const chunks = [
      ...processOpenAIStreamLine(frame({ choices: [{ delta: { reasoning_content: 'think' }, finish_reason: null }] }), state),
      ...processOpenAIStreamLine(frame({ choices: [{ delta: { content: 'hi' }, finish_reason: null }] }), state),
      ...processOpenAIStreamLine(frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }), state),
      ...processOpenAIStreamLine('data: [DONE]', state),
    ]
    const kinds = chunks.map((chunk) => chunk.type)
    expect(kinds).toContain('reasoning-delta')
    expect(kinds).toContain('text-delta')
    expect(kinds).toContain('finish')
    // Reasoning must be streamed before the visible answer.
    expect(kinds.indexOf('reasoning-delta')).toBeLessThan(kinds.indexOf('text-delta'))
  })

  it('accumulates tool-call argument fragments across deltas', () => {
    const state = createStreamState('openai')
    processOpenAIStreamLine(frame({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"pa' } }] }, finish_reason: null }],
    }), state)
    processOpenAIStreamLine(frame({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] }, finish_reason: null }],
    }), state)
    const out = processOpenAIStreamLine(frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }), state)
    const block = out.flatMap((chunk) => (chunk.type === 'block-end' ? [chunk.block] : []))
      .find((entry) => entry.type === 'tool-call')
    expect(block).toMatchObject({ type: 'tool-call', name: 'read', arguments: '{"path":"a"}' })
  })

  it('splits a second parallel call that reuses index 0 with a different id', () => {
    const state = createStreamState('openai')
    const chunks = [
      ...processOpenAIStreamLine(frame({
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_00_a', function: { name: 'progress_update', arguments: '{"title":"x"}' } }] }, finish_reason: null }],
      }), state),
      ...processOpenAIStreamLine(frame({
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_01_b', function: { name: 'code_run', arguments: '{"code":"1"}' } }] }, finish_reason: null }],
      }), state),
      ...processOpenAIStreamLine(frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }), state),
    ]
    const tools = chunks.flatMap((chunk) => (chunk.type === 'block-end' ? [chunk.block] : []))
      .filter((entry) => entry.type === 'tool-call')
    expect(tools).toHaveLength(2)
    expect(tools).toMatchObject([
      { type: 'tool-call', id: 'call_00_a', name: 'progress_update', arguments: '{"title":"x"}' },
      { type: 'tool-call', id: 'call_01_b', name: 'code_run', arguments: '{"code":"1"}' },
    ])
    expect(chunks.filter((chunk) => chunk.type === 'block-start' && chunk.blockType === 'tool-call')).toHaveLength(2)
  })

  it('keeps index 0 and index 1 parallel calls in their own blocks', () => {
    const state = createStreamState('openai')
    const chunks = [
      ...processOpenAIStreamLine(frame({
        choices: [{ delta: { tool_calls: [
          { index: 0, id: 'call_a', function: { name: 'read', arguments: '{"pa' } },
          { index: 1, id: 'call_b', function: { name: 'write', arguments: '{"pa' } },
        ] }, finish_reason: null }],
      }), state),
      ...processOpenAIStreamLine(frame({
        choices: [{ delta: { tool_calls: [
          { index: 0, function: { arguments: 'th":"a"}' } },
          { index: 1, function: { arguments: 'th":"b"}' } },
        ] }, finish_reason: null }],
      }), state),
      ...processOpenAIStreamLine(frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }), state),
    ]
    const tools = chunks.flatMap((chunk) => (chunk.type === 'block-end' ? [chunk.block] : []))
      .filter((entry) => entry.type === 'tool-call')
    expect(tools).toHaveLength(2)
    expect(tools).toMatchObject([
      { type: 'tool-call', id: 'call_a', name: 'read', arguments: '{"path":"a"}' },
      { type: 'tool-call', id: 'call_b', name: 'write', arguments: '{"path":"b"}' },
    ])
  })

  it('adopts the first real id for an index that opened without one', () => {
    const state = createStreamState('openai')
    const chunks = [
      ...processOpenAIStreamLine(frame({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'read', arguments: '{"a"' } }] }, finish_reason: null }],
      }), state),
      ...processOpenAIStreamLine(frame({
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_late', function: { arguments: ':1}' } }] }, finish_reason: null }],
      }), state),
      ...processOpenAIStreamLine(frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }), state),
    ]
    const tools = chunks.flatMap((chunk) => (chunk.type === 'block-end' ? [chunk.block] : []))
      .filter((entry) => entry.type === 'tool-call')
    expect(tools).toHaveLength(1)
    expect(tools).toMatchObject([{ type: 'tool-call', id: 'call_late', name: 'read', arguments: '{"a":1}' }])
  })

  it('reads usage including cached tokens, and reports it when the stream closes', () => {
    const state = createStreamState('openai')
    state.finishReason = 'stop'
    processOpenAIStreamLine(frame({
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } },
    }), state)
    const chunks = closeStream(state)
    const usage = chunks.find((chunk) => chunk.type === 'usage')
    expect(usage?.type === 'usage' && usage.usage).toMatchObject({
      inputTokens: 60,
      outputTokens: 20,
      cacheReadTokens: 40,
    })
  })

  it('keeps omitted cache and reasoning fields distinct from explicit zeroes', () => {
    const omitted = createStreamState('openai')
    processOpenAIStreamLine(frame({
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }), omitted)
    expect(omitted).toMatchObject({
      cacheReadReported: false,
      cacheWriteReported: false,
      reasoningReported: false,
    })

    const zero = createStreamState('openai')
    processOpenAIStreamLine(frame({
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    }), zero)
    expect(zero).toMatchObject({
      cacheReadReported: true,
      cacheWriteReported: true,
      reasoningReported: true,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    })
  })

  it('raises a provider error for a mid-stream error frame', () => {
    const state = createStreamState('openai')
    expect(() => processOpenAIStreamLine(
      frame({ error: { message: 'upstream failed', type: 'server_error' } }),
      state,
    )).toThrow(/upstream failed/)
  })

  it('closes on the [DONE] sentinel', () => {
    const state = createStreamState('openai')
    const chunks = processOpenAIStreamLine('data: [DONE]', state)
    expect(state.done).toBe(true)
    expect(chunks.some((chunk) => chunk.type === 'finish')).toBe(true)
  })
})

describe('Anthropic stream parsing', () => {
  it('turns a thinking block into a reasoning delta', () => {
    const state = createStreamState('anthropic')
    processAnthropicStreamLine('data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}', state)
    const chunks = processAnthropicStreamLine('data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}', state)
    expect(chunks.some((chunk) => chunk.type === 'reasoning-delta')).toBe(true)
  })

  it('accumulates a tool_use input across partial_json deltas', () => {
    const state = createStreamState('anthropic')
    const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}`
    processAnthropicStreamLine(frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read' } }), state)
    processAnthropicStreamLine(frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } }), state)
    processAnthropicStreamLine(frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"a"}' } }), state)
    const out = processAnthropicStreamLine(frame({ type: 'content_block_stop', index: 0 }), state)
    const block = out.flatMap((chunk) => (chunk.type === 'block-end' ? [chunk.block] : []))
      .find((entry) => entry.type === 'tool-call')
    expect(block).toMatchObject({ type: 'tool-call', name: 'read', arguments: '{"path":"a"}' })
  })

  it('finishes on message_stop', () => {
    const state = createStreamState('anthropic')
    processAnthropicStreamLine('data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}', state)
    const chunks = processAnthropicStreamLine('data: {"type":"message_stop"}', state)
    expect(chunks.some((chunk) => chunk.type === 'finish')).toBe(true)
  })

  it('preserves Anthropic usage field presence, including explicit zeroes', () => {
    const omitted = createStreamState('anthropic')
    processAnthropicStreamLine('data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}', omitted)
    expect(omitted).toMatchObject({ cacheReadReported: false, cacheWriteReported: false, reasoningReported: false })

    const zero = createStreamState('anthropic')
    processAnthropicStreamLine('data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":0,"reasoning_tokens":0}}}', zero)
    expect(zero).toMatchObject({
      cacheReadReported: true,
      cacheWriteReported: true,
      reasoningReported: true,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    })
  })

  it('ignores a ping keepalive', () => {
    const state = createStreamState('anthropic')
    expect(processAnthropicStreamLine('data: {"type":"ping"}', state)).toEqual([])
  })

  it('reports the stop reason as a tool-call finish', () => {
    const state = createStreamState('anthropic')
    state.done = true
    state.finishReason = 'tool_use'
    const chunks = closeStream(state)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })
})

describe('prefix stability tracking', () => {
  it('attributes a system-prompt change to the system-prompt cause', () => {
    const session = { sessionId: 'sess-drift' as never, system: 'You are helpful.' } as never
    buildRequest(options(session), 'openai')
    buildRequest(options({ ...(session as object), system: 'You are a different assistant.' } as never), 'openai')
    expect(getLastDriftCause('sess-drift')).toBe('system-prompt')
  })

  it('reports stable when the prefix-breaking inputs are unchanged', () => {
    const same = { sessionId: 'sess-stable' as never, system: 'constant head' } as never
    buildRequest(options(same), 'openai')
    buildRequest(options(same), 'openai')
    expect(getLastDriftCause('sess-stable')).toBe('stable')
  })

  it('attributes a tool-list change to the tools cause', () => {
    const base = { sessionId: 'sess-tools' as never, system: 'head' }
    buildRequest(options({ ...base, tools: [{ name: 'read', description: 'r', parameters: { type: 'object' } }] } as never), 'openai')
    buildRequest(options({ ...base, tools: [{ name: 'write', description: 'w', parameters: { type: 'object' } }] } as never), 'openai')
    expect(getLastDriftCause('sess-tools')).toBe('tools')
  })

  it('flags a request with no identity as cold-key so a miss is explained', () => {
    buildRequest(options({ system: 'head' } as never), 'openai')
    buildRequest(options({ system: 'head' } as never), 'openai')
    expect(getLastDriftCause()).toBe('cold-key')
  })

  it('starts a new session at first-request rather than blaming the old one', () => {
    // A different session has a different prefix by definition, so the change
    // is a different conversation rather than a cache-key switch inside one.
    buildRequest(options({ sessionId: 'sess-one' as never, system: 'h' } as never), 'openai')
    buildRequest(options({ sessionId: 'sess-two' as never, system: 'h' } as never), 'openai')
    expect(getLastDriftCause('sess-two')).toBe('first-request')
  })

  it('keeps two concurrent sessions from overwriting each other', () => {
    const a = { sessionId: 'sess-a' as never, system: 'head A' } as never
    const b = { sessionId: 'sess-b' as never, system: 'head B' } as never
    // Interleaved, the way parallel subagents arrive. Without per-session
    // scope, A's snapshot would be clobbered by B and the cause below would
    // name a change that happened in the other conversation.
    buildRequest(options(a), 'openai')
    buildRequest(options(b), 'openai')
    buildRequest(options({ ...(a as object) } as never), 'openai')
    expect(getLastDriftCause('sess-a')).toBe('stable')
    expect(getLastDriftCause('sess-b')).toBe('first-request')
  })

  it('reports no cause for a session that has not made a request', () => {
    expect(getLastDriftCause('sess-never-seen')).toBeUndefined()
  })
})

describe('the side-channel title request', () => {
  beforeEach(() => {
    resetCacheStats()
  })

  /**
   * The request the harness sends to ask a model for a session title.
   *
   * It runs on this route under the conversation's session id, but it is a
   * DIFFERENT conversation: a different system prompt, and no tools at all.
   *
   * @param sessionId - The conversation whose title is being asked for.
   * @returns The options of that request.
   */
  function titleRequest(sessionId: string): GenerateOptions {
    return options({
      sessionId: sessionId as never,
      system: 'Create a concise title for an AI coding-assistant session',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'Generate the session title from this JSON array of human messages: [{"role":"user","content":"hi"}]' }],
        source: { kind: 'dsh-session-title-llm' },
      } as Message],
    } as never)
  }

  it('recognises the request by the provenance the harness stamps on it', () => {
    expect(isSideChannelTitleRequest(titleRequest('sess-title'))).toBe(true)
  })

  it('recognises the request by the prompt it opens with, even without the stamp', () => {
    const unstamped = options({
      sessionId: 'sess-title' as never,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'Generate the session title from this JSON array of human messages: []' }],
      } as Message],
    } as never)
    expect(isSideChannelTitleRequest(unstamped)).toBe(true)
  })

  it('recognises the request by its tool-less title system prompt', () => {
    const untitled = options({
      sessionId: 'sess-title' as never,
      system: 'Create a concise title for an AI coding-assistant session',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'summarize' }] } as Message],
    } as never)
    expect(isSideChannelTitleRequest(untitled)).toBe(true)
  })

  it('does not mistake the conversation itself for the title request', () => {
    expect(isSideChannelTitleRequest(options({
      sessionId: 'sess-main' as never,
      system: 'You are helpful.',
    } as never))).toBe(false)
    // The same title system prompt WITH tools is the conversation, not the title
    // request: the real conversation always carries the session's tool list.
    expect(isSideChannelTitleRequest(options({
      sessionId: 'sess-main' as never,
      system: 'Create a concise title for an AI coding-assistant session',
      tools: [{ name: 'read', description: 'r', parameters: { type: 'object' } }],
    } as never))).toBe(false)
  })

  it('sends no cache key, so it can never collide with the session it titles', () => {
    expect(promptCacheKey(titleRequest('sess-title'))).toBeUndefined()
    expect(promptCacheKey(options({ sessionId: 'sess-main' as never } as never))).toBe('dsh-sess-main')
  })

  it('keeps prompt_cache_key out of the body it builds', () => {
    expect(buildRequest(titleRequest('sess-title'), 'openai').prompt_cache_key).toBeUndefined()
    expect(buildRequest(options({ sessionId: 'sess-main' as never } as never), 'openai').prompt_cache_key)
      .toBe('dsh-sess-main')
  })

  it('never rewrites the drift attribution of the session it titles', () => {
    const conversation = options({
      sessionId: 'sess-main' as never,
      system: 'the conversation system prompt',
    } as never)
    buildRequest(conversation, 'openai')
    expect(getLastDriftCause('sess-main')).toBe('first-request')
    // The title request carries a different system prompt and no tools. Left
    // alone it would be read as a broken prefix of the conversation.
    buildRequest(titleRequest('sess-main'), 'openai')
    expect(getLastDriftCause('sess-main')).toBe('first-request')
  })

  it('never rewrites the prefix snapshot of the session it titles', () => {
    const conversation = options({
      sessionId: 'sess-main' as never,
      system: 'the conversation system prompt',
    } as never)
    buildRequest(conversation, 'openai')
    buildRequest(titleRequest('sess-main'), 'openai')
    // The next real turn still matches the snapshot the conversation left, so
    // it is reported as stable rather than as a broken prefix.
    buildRequest(conversation, 'openai')
    expect(getLastDriftCause('sess-main')).toBe('stable')
  })
})

describe('entropy-sorted static prefix ordering & fingerprinting', () => {
  it('orders leading bootstrap reminders from most static to most dynamic before the user prompt', () => {
    const req = options({
      system: 'You are an AI agent.',
      messages: [
        { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '把本项目的所有issues全部解决' }] } as unknown as Message,
        {
          role: 'user',
          source: { kind: 'agent-instructions' },
          content: [{
            type: 'text',
            text: '<system-reminder>\nThe following workspace instructions may be relevant.\n\nInstructions from: AGENTS.md\nRepo rule\n\nInstructions from: ~/.dsh/AGENTS.md\nGlobal rule\n</system-reminder>',
          }],
        } as unknown as Message,
        {
          role: 'user',
          source: { kind: 'runtime-context' },
          content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\nYou are the root agent. Your name is "lead".' }],
        } as unknown as Message,
        {
          role: 'user',
          source: { kind: 'progress-updates-language' },
          content: [{ type: 'text', text: 'Progress update output language override: Write in Simplified Chinese.' }],
        } as unknown as Message,
        {
          role: 'user',
          source: { kind: 'skill-catalog' },
          content: [{ type: 'text', text: '<system-reminder>\nA skill is a reusable set of task-specific instructions.\n</system-reminder>' }],
        } as unknown as Message,
      ],
    })

    const built = buildOpenAIRequest(req)
    const msgs = built.messages as Array<{ role: string; content: string }>
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'user', 'user', 'user', 'user'])
    expect(msgs[1]!.content).toContain('Progress update output language override:')
    expect(msgs[2]!.content).toContain('The following workspace instructions')
    // Global ~/.dsh/AGENTS.md normalized ahead of workspace AGENTS.md
    expect(msgs[2]!.content.indexOf('~/.dsh/AGENTS.md')).toBeLessThan(msgs[2]!.content.indexOf('Instructions from: AGENTS.md'))
    expect(msgs[3]!.content).toContain('A skill is a reusable set')
    expect(msgs[4]!.content).toContain('Current runtime context.')
    expect(msgs[5]!.content).toBe('把本项目的所有issues全部解决')
  })

  it('produces an identical staticPrefixHash across root session and subagents despite different runtime-context and mandate briefs', () => {
    const sharedBootstrap = [
      {
        role: 'user',
        source: { kind: 'agent-instructions' },
        content: [{ type: 'text', text: '<system-reminder>\nThe following workspace instructions...\n</system-reminder>' }],
      },
      {
        role: 'user',
        source: { kind: 'progress-updates-language' },
        content: [{ type: 'text', text: 'Progress update output language override: Simplified Chinese' }],
      },
      {
        role: 'user',
        source: { kind: 'skill-catalog' },
        content: [{ type: 'text', text: '<system-reminder>\nA skill is a reusable set of task-specific instructions.\n</system-reminder>' }],
      },
    ]

    const rootFp = prefixFingerprints(options({
      system: 'sys',
      messages: [
        { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'root prompt' }] } as unknown as Message,
        ...sharedBootstrap as unknown as Message[],
        { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes...\nYour name is "lead".' }] } as unknown as Message,
      ],
    }))
    const subFp = prefixFingerprints(options({
      system: 'sys',
      messages: [
        { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '```dsh-mandate-v2\n{"brief_id":"b-1"}\n```' }] } as unknown as Message,
        ...sharedBootstrap as unknown as Message[],
        { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes...\nYour name is "scout-stream".' }] } as unknown as Message,
      ],
    }))

    expect(rootFp.staticPrefixHash).toBeDefined()
    expect(rootFp.staticPrefixHash).toBe(subFp.staticPrefixHash)
  })

  it('keeps mid-conversation Updated/Additional instructions anchored at their tail history position and hoists static bootstrap ahead of compact-checkpoint', () => {
    const postCompactMessages = [
      {
        role: 'user',
        source: { kind: 'compact-checkpoint' },
        content: [{ type: 'text', text: 'This is an automatically generated checkpoint condensing an earlier span of the conversation' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'retained assistant turn' }],
      },
      {
        role: 'user',
        source: { kind: 'agent-instructions' },
        content: [{ type: 'text', text: '<system-reminder>\nThe following workspace instructions may be relevant.\n</system-reminder>' }],
      },
      {
        role: 'user',
        source: { kind: 'progress-updates-language' },
        content: [{ type: 'text', text: 'Progress update output language override: Simplified Chinese' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'step 748 reply' }],
      },
      {
        role: 'user',
        source: { kind: 'agent-instructions' },
        content: [{ type: 'text', text: '<system-reminder>\nAdditional instructions from: .debug\\b\\AGENTS.md\n</system-reminder>' }],
      },
    ] as unknown as Message[]

    const ordered = orderStaticPrefixMessages(postCompactMessages)
    expect((ordered[0]!.content[0] as { text: string }).text).toContain('Progress update output language override:')
    expect((ordered[1]!.content[0] as { text: string }).text).toContain('The following workspace instructions')
    expect((ordered[2]!.content[0] as { text: string }).text).toContain('This is an automatically generated checkpoint')
    // The Additional instructions from .debug\b\AGENTS.md stays at the very end!
    expect((ordered[ordered.length - 1]!.content[0] as { text: string }).text).toContain('Additional instructions from: .debug\\b\\AGENTS.md')
  })
})