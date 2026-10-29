/**
 * OpenDesign wire mapping: request construction, tool-call message grouping,
 * SSE translation, usage accounting and error classification.
 */
import { describe, expect, it } from 'vitest'
import {
  buildOpenDesignBody,
  mapFinishReason,
  mapUsage,
  parseServerSentEvents,
  serializeMessages,
  streamErrorCode,
  translate,
  type OpenDesignWireBody,
} from '../src/host/opendesign/mapper.ts'
import { NO_RESOLVED_IMAGES } from '../src/host/common/request-images.ts'
import type { GenerateOptions } from '../src/host/common/llm-compat.ts'

function options(partial: Partial<GenerateOptions>): GenerateOptions {
  return { model: 'gpt-6-luna', messages: [], ...partial } as GenerateOptions
}

async function* framesOf(payloads: Array<unknown | '[DONE]'>): AsyncGenerator<unknown | '[DONE]'> {
  for (const payload of payloads) yield payload
}

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('buildOpenDesignBody', () => {
  it('builds a streaming chat-completions body with tools and effort', () => {
    const body = buildOpenDesignBody(
      options({
        system: 'be brief',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] as never,
        tools: [{ name: 'run', description: 'run it', parameters: { type: 'object' } }] as never,
        reasoningEffort: 'high' as never,
      }),
      { maxTokens: 64_000 },
      NO_RESOLVED_IMAGES,
    ) as OpenDesignWireBody
    expect(body.model).toBe('gpt-6-luna')
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.max_tokens).toBe(64_000)
    expect(body.reasoning_effort).toBe('high')
    expect(body.messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ])
    expect(body.tools).toHaveLength(1)
  })

  it('omits the knobs the caller never set', () => {
    const body = buildOpenDesignBody(options({}), { maxTokens: 0 }, NO_RESOLVED_IMAGES)
    expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('max_tokens')
    expect(body).not.toHaveProperty('reasoning_effort')
  })
})

describe('serializeMessages', () => {
  it('keeps every tool answer immediately behind its tool_calls message', () => {
    const wire = serializeMessages([
      { role: 'assistant', content: [
        { type: 'text', text: 'calling' },
        { type: 'tool-call', id: 'c1', name: 'run', arguments: '{}' },
        { type: 'tool-call', id: 'c2', name: 'read', arguments: '{}' },
      ] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'one' }] }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'two' }] }] },
      { role: 'user', content: [{ type: 'text', text: 'next question' }] },
    ] as never, NO_RESOLVED_IMAGES)
    expect(wire.map((message) => message.role)).toEqual(['assistant', 'tool', 'tool', 'user'])
    const assistant = wire[0]!
    expect((assistant.tool_calls ?? []).map((call) => call.id)).toEqual(['c1', 'c2'])
    expect(wire[1]).toMatchObject({ role: 'tool', tool_call_id: 'c1' })
    expect(wire[2]).toMatchObject({ role: 'tool', tool_call_id: 'c2' })
  })

  it('turns a developer message into the system spelling every gateway accepts', () => {
    const wire = serializeMessages([
      { role: 'developer', content: [{ type: 'text', text: 'rules' }] },
    ] as never, NO_RESOLVED_IMAGES)
    expect(wire[0]).toEqual({ role: 'system', content: 'rules' })
  })
})

describe('translate', () => {
  it('streams text, reasoning and tool calls, then closes blocks at [DONE]', async () => {
    const chunks = await collect(translate(framesOf([
      { choices: [{ delta: { reasoning_content: 'thinking ' } }] },
      { choices: [{ delta: { content: 'hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'run', arguments: '{"a":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
      '[DONE]',
    ])))
    const types = chunks.map((chunk) => (chunk as { type: string }).type)
    expect(types).toContain('reasoning-delta')
    expect(types.filter((type) => type === 'text-delta')).toHaveLength(2)
    expect(types).toContain('tool-call-delta')
    const ends = chunks.filter((chunk) => (chunk as { type: string }).type === 'block-end') as Array<{ block: { type: string; text: string; name?: string } }>
    const toolEnd = ends.find((end) => end.block.type === 'tool-call')!
    expect(toolEnd.block.name).toBe('run')
    expect((toolEnd.block as unknown as { arguments: string }).arguments).toBe('{"a":1}')
    const usage = chunks.find((chunk) => (chunk as { type: string }).type === 'usage') as { usage: { totalTokens?: number } }
    expect(usage.usage.totalTokens).toBe(14)
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } }
    expect(finish.type).toBe('finish')
    expect(finish.reason.kind).toBe('tool-calls')
  })

  it('a 200 body carrying an error object fails the attempt', async () => {
    await expect(collect(translate(framesOf([
      { error: { code: 'invalid_api_key', message: 'api key not found' } },
    ])))).rejects.toThrow(/api key not found/)
  })

  it('an empty completion is an EMPTY_RESPONSE finish, not a silent answer', async () => {
    const chunks = await collect(translate(framesOf([
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      '[DONE]',
    ])))
    const finish = chunks[chunks.length - 1] as { reason: { kind: string; failure?: { code?: string } } }
    expect(finish.reason.kind).toBe('error')
    expect(finish.reason.failure?.code).toBe('EMPTY_RESPONSE')
  })
})

describe('mapUsage', () => {
  it('keeps cached tokens out of the input count', () => {
    expect(mapUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 5 },
    })).toEqual({ inputTokens: 60, outputTokens: 20, totalTokens: 120, cacheReadTokens: 40, reasoningTokens: 5 })
  })
})

describe('mapFinishReason', () => {
  it('maps the OpenAI vocabulary', () => {
    expect(mapFinishReason('stop').reason.kind).toBe('stop')
    expect(mapFinishReason('tool_calls').reason.kind).toBe('tool-calls')
    expect(mapFinishReason('length').reason.kind).toBe('max-tokens')
  })
})

describe('streamErrorCode', () => {
  it('classifies the refusal the account must rotate past', () => {
    // Credits, not windows: OpenDesign meters in dollars.
    expect(streamErrorCode('insufficient credits', undefined)).toBe('QUOTA')
    expect(streamErrorCode('balance exhausted', undefined)).toBe('QUOTA')
    expect(streamErrorCode('payment required', 402)).toBe('QUOTA')
    expect(streamErrorCode('api key not found', 401)).toBe('AUTH')
    expect(streamErrorCode('missing_api_key', undefined)).toBe('AUTH')
    expect(streamErrorCode('slow down', 429)).toBe('RATE_LIMIT')
    expect(streamErrorCode('boom', 500)).toBe('SERVER')
    expect(streamErrorCode('nope', 400)).toBe('INVALID_REQUEST')
  })

  it('a passing mention of a plan is not a spent balance', () => {
    expect(streamErrorCode('plan lookup failed, retry later', 500)).toBe('SERVER')
  })
})

describe('parseServerSentEvents', () => {
  it('reads data frames and stops at [DONE]', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(': keep-alive\n\ndata: {"a":1}\n\ndata: [DONE]\n\ndata: {"b":2}\n\n'))
        controller.close()
      },
    })
    const frames: unknown[] = []
    for await (const frame of parseServerSentEvents(body)) frames.push(frame)
    expect(frames).toEqual([{ a: 1 }, '[DONE]'])
  })
})

/**
 * The parser contract belongs to the parser, not to this line's tolerance.
 *
 * A body that ends without `[DONE]` is reported by THROWING `STREAM_CLOSED`;
 * whether such an ending was a complete answer is decided in `translate`, which
 * is the only place that has the frames (`finish_reason`). Swallowing the
 * signal here silently widened the parser for every caller, including the ones
 * that only want frames and never see a finish reason.
 */
describe('parseServerSentEvents at a clean end of stream', () => {
  it('still raises STREAM_CLOSED when [DONE] never arrives', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"a":1}\n\n'))
        controller.close()
      },
    })
    const frames: unknown[] = []
    let caught: { code?: string; message?: string } = {}
    try {
      for await (const frame of parseServerSentEvents(body)) frames.push(frame)
    } catch (error) {
      caught = error as { code?: string; message?: string }
    }
    // The frames that did arrive are still delivered before the failure.
    expect(frames).toEqual([{ a: 1 }])
    expect(caught.code).toBe('STREAM_CLOSED')
  })
})

/**
 * ...and here is where that signal is absorbed: the input side of `translate`,
 * for that code only. A body that closed after a terminal `finish_reason` is a
 * completed answer; one that never stated a finish reason is still truncation.
 */
describe('translate over a body that never wrote [DONE]', () => {
  function bodyOf(frames: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frames))
        controller.close()
      },
    })
  }

  it('closes a body that ended after a finish_reason', async () => {
    const chunks = await collect(translate(parseServerSentEvents(bodyOf(
      'data: {"choices":[{"delta":{"content":"done"}}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n',
    ))))
    const types = chunks.map((chunk) => (chunk as { type: string }).type)
    expect(types).toContain('block-end')
    expect(types).toContain('usage')
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } }
    expect(finish.type).toBe('finish')
    expect(finish.reason.kind).toBe('stop')
  })

  it('still fails a body that ended without a finish_reason', async () => {
    let caught: { code?: string; message?: string } = {}
    try {
      await collect(translate(parseServerSentEvents(bodyOf(
        'data: {"choices":[{"delta":{"content":"half an ans"}}]}\n\n',
      ))))
    } catch (error) {
      caught = error as { code?: string; message?: string }
    }
    expect(caught.code).toBe('STREAM_CLOSED')
  })

  it('passes a failure that is not the missing sentinel through untouched', async () => {
    async function* failing(): AsyncGenerator<unknown> {
      yield { choices: [{ delta: { content: 'half' } }] }
      throw Object.assign(new Error('gateway exploded'), { code: 'SERVER' })
    }
    let caught: { code?: string; message?: string } = {}
    try {
      await collect(translate(failing()))
    } catch (error) {
      caught = error as { code?: string; message?: string }
    }
    expect(caught.code).toBe('SERVER')
    expect(caught.message).toContain('gateway exploded')
  })
})

describe('buildOpenDesignBody reasoning effort for DeepSeek', () => {
  it('translates the none effort into thinking:disabled and drops reasoning_effort', () => {
    const body = buildOpenDesignBody(
      options({ model: 'deepseek-v4.1-flash', reasoningEffort: 'none' as never }),
      { maxTokens: 0 },
      NO_RESOLVED_IMAGES,
    ) as OpenDesignWireBody
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(body.model).toBe('deepseek-v4.1-flash')
  })

  it('leaves non-DeepSeek models on the effort string they always sent', () => {
    const body = buildOpenDesignBody(
      options({ model: 'gpt-6-luna', reasoningEffort: 'none' as never }),
      { maxTokens: 0 },
      NO_RESOLVED_IMAGES,
    ) as OpenDesignWireBody
    expect(body.reasoning_effort).toBe('none')
    expect(body).not.toHaveProperty('thinking')
  })

  it('leaves every other DeepSeek effort untouched', () => {
    const high = buildOpenDesignBody(
      options({ model: 'deepseek-v4.1-flash', reasoningEffort: 'high' as never }),
      { maxTokens: 0 },
      NO_RESOLVED_IMAGES,
    ) as OpenDesignWireBody
    expect(high.reasoning_effort).toBe('high')
    expect(high).not.toHaveProperty('thinking')
    const unset = buildOpenDesignBody(
      options({ model: 'deepseek-v4.1-flash' }),
      { maxTokens: 0 },
      NO_RESOLVED_IMAGES,
    ) as OpenDesignWireBody
    expect(unset).not.toHaveProperty('thinking')
    expect(unset).not.toHaveProperty('reasoning_effort')
  })
})

describe('serializeMessages developer tool changes', () => {
  it('renders an addition and a removal as explicit system notices beside the text', () => {
    const wire = serializeMessages([
      { role: 'developer', content: [{ type: 'text', text: 'rules' }] },
      { role: 'developer', content: [{ type: 'tool-addition', toolName: 'run' }] },
      { role: 'developer', content: [{ type: 'tool-removal', toolName: 'read' }] },
    ] as never, NO_RESOLVED_IMAGES)
    expect(wire).toHaveLength(3)
    expect(wire[0]).toEqual({ role: 'system', content: 'rules' })
    expect(wire[1]!.role).toBe('system')
    expect(String(wire[1]!.content)).toContain('"run"')
    expect(String(wire[1]!.content)).toMatch(/now available/i)
    expect(wire[2]!.role).toBe('system')
    expect(String(wire[2]!.content)).toContain('"read"')
    expect(String(wire[2]!.content)).toContain('no longer available')
  })

  it('never emits an empty system message for a tool-only developer message', () => {
    const wire = serializeMessages([
      { role: 'developer', content: [{ type: 'tool-addition', toolName: 'a' }, { type: 'tool-addition', toolName: 'b' }] },
    ] as never, NO_RESOLVED_IMAGES)
    expect(wire).toHaveLength(1)
    expect(wire[0]!.role).toBe('system')
    expect(String(wire[0]!.content)).toContain('"a"')
    expect(String(wire[0]!.content)).toContain('"b"')
    for (const message of wire) expect(message.content).not.toBe('')
  })

  it('keeps the text of a message that carries both text and a tool change', () => {
    const wire = serializeMessages([
      { role: 'developer', content: [{ type: 'text', text: 'note' }, { type: 'tool-addition', toolName: 'run' }] },
    ] as never, NO_RESOLVED_IMAGES)
    expect(wire.map((message) => message.role)).toEqual(['system', 'system'])
    expect(wire[0]!.content).toBe('note')
    expect(String(wire[1]!.content)).toContain('"run"')
  })
})

describe('serializeMessages orphan tool results', () => {
  function caughtOf(run: () => unknown): { code?: string; message?: string } {
    try {
      run()
    } catch (error) {
      return error as { code?: string; message?: string }
    }
    return {}
  }

  it('refuses a tool result with no pending call, naming the id', () => {
    const caught = caughtOf(() => serializeMessages([
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'orphan_9', content: [{ type: 'text', text: 'x' }] }] },
    ] as never, NO_RESOLVED_IMAGES))
    expect(caught.code).toBe('INVALID_REQUEST')
    expect(String(caught.message)).toContain('orphan_9')
  })

  it('refuses a second answer to the same call id', () => {
    const caught = caughtOf(() => serializeMessages([
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'run', arguments: '{}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'one' }] }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'two' }] }] },
    ] as never, NO_RESOLVED_IMAGES))
    expect(caught.code).toBe('INVALID_REQUEST')
    expect(String(caught.message)).toContain('c1')
  })
})

describe('serializeMessages empty user turns', () => {
  it('keeps a user message with neither text nor image out of the wire', () => {
    const wire = serializeMessages([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'user', content: [] },
      { role: 'user', content: [{ type: 'text', text: '' }] },
    ] as never, NO_RESOLVED_IMAGES)
    expect(wire).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('still sends a pure tool-result message as the tool answer', () => {
    const wire = serializeMessages([
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'run', arguments: '{}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'out' }] }] },
    ] as never, NO_RESOLVED_IMAGES)
    expect(wire.map((message) => message.role)).toEqual(['assistant', 'tool'])
    expect(wire[1]).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: 'out' })
  })
})

describe('translate without the [DONE] sentinel', () => {
  it('closes a stream that ended after a finish_reason', async () => {
    const chunks = await collect(translate(framesOf([
      { choices: [{ delta: { content: 'done' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
    ])))
    const types = chunks.map((chunk) => (chunk as { type: string }).type)
    expect(types).toContain('block-end')
    expect(types).toContain('usage')
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } }
    expect(finish.type).toBe('finish')
    expect(finish.reason.kind).toBe('stop')
  })

  it('still fails a truncated stream that never stated a finish_reason', async () => {
    let caught: { code?: string; message?: string } = {}
    try {
      await collect(translate(framesOf([
        { choices: [{ delta: { content: 'half an ans' } }] },
      ])))
    } catch (error) {
      caught = error as { code?: string; message?: string }
    }
    expect(caught.code).toBe('STREAM_CLOSED')
  })

  it('still fails the attempt on an error frame', async () => {
    await expect(collect(translate(framesOf([
      { error: { code: 'invalid_api_key', message: 'api key not found' } },
    ])))).rejects.toThrow(/api key not found/)
  })
})
