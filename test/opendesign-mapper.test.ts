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
