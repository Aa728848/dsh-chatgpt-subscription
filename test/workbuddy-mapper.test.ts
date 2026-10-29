import { describe, expect, it } from 'vitest'
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { GenerateOptions, Message } from '../src/host/common/llm-compat.ts'
import { PLUGIN_MESSAGE_SOURCE_KIND, normalizeGenerateOptions } from '../src/host/common/llm-compat.ts'
import {
  IMPLICIT_SYSTEM_PROMPT,
  MAX_REQUEST_IMAGE_BYTES,
  assertStreamComplete,
  buildChatRequest,
  closeStream,
  createStreamState,
  offloadOldestRequestImages,
  processStreamLine,
  resolveRequestImages,
  stripMetaSchema,
} from '../src/host/workbuddy/mapper.ts'
import { LlmError } from '@deepseek-ai/dsh-llm'

function userMessage(content: any[]): Message {
  return { id: 'm1', role: 'user', content, source: { kind: 'user' } } as unknown as Message
}

function systemMessage(text: string): Message {
  // The harness MessageSourceMap has no catch-all `plugin` kind any more; this
  // package declares its own, and a system contribution declares no form.
  return { id: 'm0', role: 'system', content: [{ type: 'text', text }], source: { kind: PLUGIN_MESSAGE_SOURCE_KIND } } as unknown as Message
}

function baseOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'workbuddy',
    model: 'glm-5.3',
    messages: [userMessage([{ type: 'text', text: 'hello' }])],
    ...overrides,
  } as GenerateOptions
}

describe('WorkBuddy request mapping', () => {
  it('always streams, because the endpoint rejects a non-streaming request', () => {
    const body = buildChatRequest(baseOptions())
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('injects a leading system message when the caller supplied none', () => {
    // The international backend answers 400 code 11128 when the first message
    // is not a system turn, so this must never be omitted.
    const body = buildChatRequest(baseOptions())
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages[0]).toEqual({ role: 'system', content: IMPLICIT_SYSTEM_PROMPT })
  })

  it('folds every system contribution into the single leading message', () => {
    const body = buildChatRequest(baseOptions({
      system: 'top-level prompt',
      messages: [systemMessage('in-history prompt'), userMessage([{ type: 'text', text: 'hi' }])],
    }))
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages[0]).toEqual({ role: 'system', content: 'top-level prompt\n\nin-history prompt' })
    // No system message may appear anywhere else: the wire reads only the first.
    expect(messages.filter((m) => m.role === 'system')).toHaveLength(1)
  })

  it('sends user text as a plain string when the turn carries no image', () => {
    const body = buildChatRequest(baseOptions())
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages[1]).toEqual({ role: 'user', content: 'hello' })
  })

  it('maps reasoning effort onto the wire field and omits it when unset', () => {
    expect(buildChatRequest(baseOptions()).reasoning_effort).toBeUndefined()
    const withEffort = buildChatRequest(baseOptions({ reasoningEffort: 'high' as any }))
    expect(withEffort.reasoning_effort).toBe('high')
  })

  it('passes tools through with the meta-schema keywords stripped', () => {
    const body = buildChatRequest(baseOptions({
      tools: [{
        name: 'read_file',
        description: 'Read a file',
        parameters: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { path: { type: 'string' } } },
      }],
    }))
    const tools = body.tools as Array<Record<string, any>>
    expect(tools).toHaveLength(1)
    expect(tools[0]!.function.name).toBe('read_file')
    expect(tools[0]!.function.parameters.$schema).toBeUndefined()
    expect(tools[0]!.function.parameters.properties.path).toEqual({ type: 'string' })
    expect(body.tool_choice).toBe('auto')
  })

  it('groups parallel tool results and appends their images on one user message', () => {
    const toolResult = (callId: string, blocks: any[]): Message => ({
      id: `t-${callId}`,
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, content: blocks }],
      source: { kind: 'tool', callId },
    } as unknown as Message)
    const body = buildChatRequest(baseOptions({
      messages: [
        userMessage([{ type: 'text', text: 'go' }]),
        toolResult('call_1', [{ type: 'text', text: 'first' }]),
        toolResult('call_2', [{ type: 'text', text: 'second' }]),
      ],
    }))
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages.filter((m) => m.role === 'tool')).toHaveLength(2)
    // No `user` message may be wedged between the two tool results.
    const roles = messages.map((m) => m.role)
    expect(roles).toEqual(['system', 'user', 'tool', 'tool'])
  })

  it('names a tool-result image rather than dropping it silently', () => {
    const body = buildChatRequest(baseOptions({
      messages: [{
        id: 't1',
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'image', attachment: { attachmentId: 'a1', name: 'shot.png' } }] }],
        source: { kind: 'tool', callId: 'call_1' },
      } as unknown as Message],
    }))
    const messages = body.messages as Array<Record<string, unknown>>
    const tool = messages.find((m) => m.role === 'tool')!
    expect(String(tool.content)).toContain('[image: shot.png]')
  })

  it('groups the parallel results a 0.1.7 harness delivers as tool-role messages the same way', () => {
    // The harness now sends one `role: 'tool'` message per result; the adapter
    // normalizes each into the user-role tool result this mapper reads.
    const messages = normalizeGenerateOptions({
      provider: 'workbuddy',
      model: 'glm-5.3',
      messages: [
        createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }),
        createToolResultMessage({ callId: ToolCallId('call_1'), content: [{ type: 'text', text: 'first' }], isError: false }),
        createToolResultMessage({ callId: ToolCallId('call_2'), content: [{ type: 'text', text: 'second' }], isError: false }),
      ],
    }).messages

    const body = buildChatRequest(baseOptions({ messages }))
    const wire = body.messages as Array<Record<string, unknown>>
    expect(wire.map((m) => m.role)).toEqual(['system', 'user', 'tool', 'tool'])
    expect(wire.filter((m) => m.role === 'tool')).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: 'first' },
      { role: 'tool', tool_call_id: 'call_2', content: 'second' },
    ])
  })

  it('drops an assistant turn that carries neither text nor tool calls', () => {
    const body = buildChatRequest(baseOptions({
      messages: [
        userMessage([{ type: 'text', text: 'hi' }]),
        { id: 'a1', role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }], source: { kind: 'model', provider: 'workbuddy', model: 'glm-5.3' } } as unknown as Message,
      ],
    }))
    const messages = body.messages as Array<Record<string, unknown>>
    // A replayed reasoning block is not accepted by the wire, and an empty
    // assistant turn would be a malformed message.
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(0)
  })

  it('keeps an assistant tool call with its arguments as raw JSON', () => {
    const body = buildChatRequest(baseOptions({
      messages: [
        userMessage([{ type: 'text', text: 'hi' }]),
        {
          id: 'a1',
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' }],
          source: { kind: 'model', provider: 'workbuddy', model: 'glm-5.3' },
        } as unknown as Message,
      ],
    }))
    const messages = body.messages as Array<Record<string, any>>
    const assistant = messages.find((m) => m.role === 'assistant')!
    expect(assistant.tool_calls[0].function).toEqual({ name: 'read_file', arguments: '{"path":"a.txt"}' })
  })

  it('strips only $schema and preserves an unknown schema verbatim', () => {
    expect(stripMetaSchema(undefined)).toEqual({ type: 'object', properties: {} })
    expect(stripMetaSchema({ $schema: 'x', type: 'object', required: ['a'] }))
      .toEqual({ type: 'object', required: ['a'] })
  })

  it('requests the model-specific output cap when the caller omits one', () => {
    const body = buildChatRequest(baseOptions({ model: 'gpt-6-astra' }))
    // From the gateway catalog: GPT-6-Astra declares a 128000 output cap.
    expect(body.max_tokens).toBe(128_000)
  })
})

describe('WorkBuddy image handling', () => {
  const attachmentBlock = (id: string, bytes = 1000) => ({
    type: 'image',
    attachment: { attachmentId: id, bytes, mediaType: 'image/png', name: `${id}.png` },
  })

  it('omits the oldest images first once the request exceeds its image budget', () => {
    const perImage = MAX_REQUEST_IMAGE_BYTES / 2
    const options = baseOptions({
      messages: [userMessage([
        attachmentBlock('old', perImage),
        attachmentBlock('middle', perImage),
        attachmentBlock('new', perImage),
      ])],
    })
    const offloaded = offloadOldestRequestImages(options)
    const blocks = offloaded.messages[0]!.content as any[]
    // Three half-budget images need two dropped to fit.
    expect(blocks[0]!.type).toBe('text')
    expect(blocks[1]!.type).toBe('text')
    expect(blocks[2]!.type).toBe('image')
  })

  it('leaves a request within budget untouched', () => {
    const options = baseOptions({ messages: [userMessage([attachmentBlock('a', 1000)])] })
    expect(offloadOldestRequestImages(options)).toBe(options)
  })

  it('renders an unreadable image as visible text instead of dropping it', async () => {
    const options = baseOptions({ messages: [userMessage([attachmentBlock('missing')])] })
    const images = await resolveRequestImages(options, undefined)
    const body = buildChatRequest(options, images)
    const messages = body.messages as Array<Record<string, unknown>>
    expect(String(messages[1]!.content)).toContain('image unavailable')
  })

  it('inlines a readable image as a data URL', async () => {
    const options = baseOptions({ messages: [userMessage([attachmentBlock('a1')])] })
    const reader = {
      readImage: async () => ({ ref: { mediaType: 'image/png' }, data: new Uint8Array([1, 2, 3]) }),
    } as any
    const images = await resolveRequestImages(options, reader)
    const body = buildChatRequest(options, images)
    const content = (body.messages as any[])[1]!.content as any[]
    expect(content[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } })
  })

  it('degrades an unsupported media type to text rather than sending it', async () => {
    const options = baseOptions({ messages: [userMessage([attachmentBlock('a1')])] })
    const reader = {
      readImage: async () => ({ ref: { mediaType: 'image/tiff' }, data: new Uint8Array([1]) }),
    } as any
    const images = await resolveRequestImages(options, reader)
    const body = buildChatRequest(options, images)
    const content = (body.messages as any[])[1]!.content
    expect(typeof content).toBe('string')
    expect(content).toContain('image unavailable')
  })
})

describe('WorkBuddy stream decoding', () => {
  const frame = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }], ...extra })}`

  it('emits text deltas as a text block', () => {
    const state = createStreamState()
    const out = [
      ...processStreamLine(frame({ role: 'assistant', content: '' }), state),
      ...processStreamLine(frame({ content: 'po' }), state),
      ...processStreamLine(frame({ content: 'ng' }), state),
    ]
    expect(out[0]).toEqual({ type: 'block-start', index: 0, blockType: 'text' })
    expect(out.filter((c) => c.type === 'text-delta').map((c: any) => c.text).join('')).toBe('pong')
  })

  it('emits reasoning_content as its own reasoning block, separate from text', () => {
    const state = createStreamState()
    const out = [
      ...processStreamLine(frame({ reasoning_content: 'let me think' }), state),
      ...processStreamLine(frame({ content: 'answer' }), state),
    ]
    const starts = out.filter((c) => c.type === 'block-start')
    expect(starts).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'block-start', index: 1, blockType: 'text' },
    ])
    expect(out.find((c: any) => c.type === 'reasoning-delta')).toEqual({ type: 'reasoning-delta', index: 0, text: 'let me think' })
  })

  it('assembles tool calls split across deltas', () => {
    const state = createStreamState()
    const out = [
      ...processStreamLine(frame({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '' } }] }), state),
      ...processStreamLine(frame({ tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] }), state),
      ...processStreamLine(frame({ tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] }), state),
      ...processStreamLine(frame({}, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }), state),
    ]
    const end = out.find((c: any) => c.type === 'block-end') as any
    expect(end.block).toMatchObject({ type: 'tool-call', name: 'read_file', arguments: '{"path":"a"}' })
  })
  it('opens a no-argument tool call as a tool use with its name on the first delta', () => {
    const state = createStreamState()
    const out = [
      ...processStreamLine(frame({ tool_calls: [{ index: 0, id: 'call_9', function: { name: 'list_files', arguments: '' } }] }), state),
      ...processStreamLine('data: [DONE]', state),
    ]
    // The name must reach the caller even though no argument ever arrives.
    expect(out.find((c: any) => c.type === 'tool-call-delta')).toMatchObject({ name: 'list_files', argumentsDelta: '' })
    expect(state.hasToolCall).toBe(true)
    // A no-argument tool is still a tool use, not a plain stop: otherwise the
    // runner never executes it.
    expect((out.find((c: any) => c.type === 'finish') as any).reason).toEqual({ kind: 'tool-calls' })
    const end = out.filter((c: any) => c.type === 'block-end').pop() as any
    expect(end.block).toMatchObject({ type: 'tool-call', name: 'list_files', arguments: '{}' })
  })

  it('surfaces a mid-stream error frame instead of flushing a clean stop', () => {
    const state = createStreamState()
    expect(() => processStreamLine('data: {"error":{"message":"upstream vendor failed"}}', state)).toThrow(LlmError)
  })

  it('reads usage with cached tokens subtracted out of the prompt count', () => {
    const state = createStreamState()
    processStreamLine(`data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 400 }, completion_tokens_details: { reasoning_tokens: 20 } },
    })}`, state)
    const chunks = closeStream(state)
    const usage = chunks.find((c: any) => c.type === 'usage') as any
    // DSH counts are disjoint: 1000 total prompt minus 400 cached = 600 uncached.
    expect(usage.usage).toEqual({ inputTokens: 600, outputTokens: 50, cacheReadTokens: 400, reasoningTokens: 20 })
  })

  it('terminates on the [DONE] sentinel and is idempotent', () => {
    const state = createStreamState()
    const first = processStreamLine('data: [DONE]', state)
    expect(first.some((c: any) => c.type === 'finish')).toBe(true)
    expect(state.done).toBe(true)
    expect(closeStream(state)).toEqual([])
  })

  it('reports a length stop as max-tokens and tool use as tool-calls', () => {
    const lengthState = createStreamState()
    processStreamLine(frame({}, { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }), lengthState)
    expect((closeStream(lengthState).find((c: any) => c.type === 'finish') as any).reason).toEqual({ kind: 'max-tokens' })

    // `[DONE]` itself flushes the terminal chunks, so the finish is read from
    // that call rather than from a later `closeStream` (which is a no-op).
    const toolState = createStreamState()
    processStreamLine(frame({ tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{}' } }] }), toolState)
    const done = processStreamLine('data: [DONE]', toolState)
    expect((done.find((c: any) => c.type === 'finish') as any).reason).toEqual({ kind: 'tool-calls' })
  })

  it('rejects a stream that ended without a terminal event', () => {
    // A dropped connection must not present partial text as a finished answer.
    const state = createStreamState()
    processStreamLine(frame({ content: 'partial' }), state)
    expect(() => assertStreamComplete(state)).toThrow(LlmError)
  })

  it('accepts a stream that ended with a finish_reason but no [DONE]', () => {
    const state = createStreamState()
    processStreamLine(frame({}, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }), state)
    expect(() => assertStreamComplete(state)).not.toThrow()
  })

  it('ignores non-data lines and malformed payloads', () => {
    const state = createStreamState()
    expect(processStreamLine(': keep-alive comment', state)).toEqual([])
    expect(processStreamLine('data: {not json', state)).toEqual([])
    expect(processStreamLine('', state)).toEqual([])
  })
})
