import { describe, expect, it, vi } from 'vitest'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions as HarnessGenerateOptions } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { OAuthService } from '../src/host/oauth-service.ts'
import { ResponsesClient, parseResponsesStream } from '../src/host/responses-client.ts'
import { buildResponsesPayload } from '../src/host/responses-mapper.ts'
import { MemoryTokenStore } from '../src/host/token-store.ts'
import { reasoningEffortsForModel, resolveCodexFallbackModel } from '../src/shared/model-catalog.ts'
import {
  PLUGIN_MESSAGE_SOURCE_KIND,
  normalizeGenerateOptions,
} from '../src/host/common/llm-compat.ts'
import type { GenerateOptions, StreamChunk } from '../src/host/common/llm-compat.ts'

/**
 * Reproduction for "Astra does not react after a background subagent finishes".
 *
 * The Codex/Responses route is the only route in this deployment whose text is
 * assembled exclusively from streaming deltas. These cases pin both halves:
 * the runtime settlement notice DOES reach the wire, and an answer that the
 * backend delivers through its terminal events must still become visible text
 * instead of a silently empty assistant message.
 */

const NOTICE = 'Background subagent session-child-1 finished and will do no further work unless you send it more.\nIts closing message:\nAll done.'

describe('Codex route: settlement notice reaches the wire', () => {
  it('maps a subagent-settled notice and the replayed reasoning/function_call items into input', async () => {
    const options = {
      provider: 'codex-chatgpt',
      model: 'gpt-6-astra',
      messages: [
        { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'delegate this' }] },
        {
          id: 'm2',
          role: 'assistant',
          source: {
            kind: 'model',
            provider: 'codex-chatgpt',
            model: 'gpt-6-astra',
            replayState: {
              response: {
                outputItems: [
                  { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc-1' },
                  { type: 'function_call', call_id: 'call_1', name: 'subagent', arguments: '{"prompt":"x"}' },
                ],
              },
            },
          },
          content: [{ type: 'tool-call', id: 'call_1', name: 'subagent', arguments: '{"prompt":"x"}' }],
        },
        {
          id: 'm3',
          role: 'user',
          source: { kind: 'tool', callId: 'call_1' },
          content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'started background subagent session-child-1' }] }],
        },
        {
          id: 'm4',
          role: 'user',
          source: { kind: 'subagent-settled', form: 'notice', summary: 'child settled', senderSessionId: 'session-child-1' },
          content: [{ type: 'text', text: NOTICE }],
        },
      ],
    } as unknown as GenerateOptions

    const payload = await buildResponsesPayload(options, unusedAttachments())
    const serialized = JSON.stringify(payload.input)
    expect(serialized).toContain('Background subagent session-child-1 finished')
    expect(payload.input).toContainEqual({ type: 'reasoning', id: 'rs_1', encrypted_content: 'enc-1' })
    expect(payload.input).toContainEqual({ type: 'function_call', call_id: 'call_1', name: 'subagent', arguments: '{"prompt":"x"}' })
    const last = payload.input.at(-1) as { role?: string; content?: unknown }
    expect(last.role).toBe('user')
    expect(JSON.stringify(last.content)).toContain('Background subagent session-child-1 finished')
  })

  it('maps the tool-role result and the plugin notice the 0.1.7 harness delivers instead', async () => {
    // Harness 0.1.7 delivers the tool result as a first-class `role: 'tool'`
    // message and marks plugin-injected content with this package's own source
    // kind. The adapter normalizes that at the boundary, so the mapper must
    // reach the same wire items as the legacy shape above.
    const options = normalizeGenerateOptions({
      provider: 'codex-chatgpt',
      model: 'gpt-6-astra',
      messages: [
        createUserMessage({ content: [{ type: 'text', text: 'delegate this' }], source: { kind: 'user' } }),
        createAssistantMessage({
          content: [{ type: 'tool-call', id: ToolCallId('call_1'), name: 'subagent', arguments: '{"prompt":"x"}' }],
          source: {
            provider: 'codex-chatgpt',
            model: 'gpt-6-astra',
            replayState: {
              response: {
                outputItems: [
                  { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc-1' },
                  { type: 'function_call', call_id: 'call_1', name: 'subagent', arguments: '{"prompt":"x"}' },
                ],
              },
            },
          },
        }),
        createToolResultMessage({
          callId: ToolCallId('call_1'),
          content: [{ type: 'text', text: 'started background subagent session-child-1' }],
          isError: false,
        }),
        createUserMessage({
          content: [{ type: 'text', text: NOTICE }],
          source: { kind: PLUGIN_MESSAGE_SOURCE_KIND, form: 'notice', summary: 'child settled' },
        }),
      ],
    })

    const payload = await buildResponsesPayload(options, unusedAttachments())
    expect(payload.input).toContainEqual({ type: 'reasoning', id: 'rs_1', encrypted_content: 'enc-1' })
    expect(payload.input).toContainEqual({ type: 'function_call', call_id: 'call_1', name: 'subagent', arguments: '{"prompt":"x"}' })
    expect(payload.input).toContainEqual({
      type: 'function_call_output', call_id: 'call_1', output: 'started background subagent session-child-1',
    })
    const last = payload.input.at(-1) as { role?: string; content?: unknown }
    expect(last.role).toBe('user')
    expect(JSON.stringify(last.content)).toContain('Background subagent session-child-1 finished')
  })
})

describe('Codex route: assembling the answer text', () => {
  it('renders text delivered as response.output_text.delta (baseline)', async () => {
    const chunks = await collect(parseResponsesStream(sse([
      { type: 'response.output_text.delta', delta: 'subagent is done.' },
      { type: 'response.completed', response: { status: 'completed' } },
    ])))
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'subagent is done.' })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('renders an answer delivered only through the terminal events, never as a delta', async () => {
    const answer = 'Background subagent finished; nothing further is needed.'
    const chunks = await collect(parseResponsesStream(sse([
      { type: 'response.output_text.done', output_index: 0, text: answer },
      { type: 'response.content_part.done', output_index: 0, part: { type: 'output_text', text: answer } },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: answer }] },
      },
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [{ type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: answer }] }],
        },
      },
    ])))

    const visible = chunks
      .filter((chunk): chunk is Extract<StreamChunk, { type: 'block-end' }> => chunk.type === 'block-end')
      .map((chunk) => (chunk.block.type === 'text' ? chunk.block.text : undefined))
      .filter((text): text is string => text !== undefined)
    expect(visible).toContain(answer)
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: answer })
  })
})

describe('Codex route: Sol and Astra share one content path', () => {
  it.each(['gpt-5.6-sol', 'gpt-6-astra'])(
    'makes the same non-delta answer visible for %s',
    async (model) => {
      const store = new MemoryTokenStore()
      await store.save({
        accessToken: 'tok',
        refreshToken: 'refresh',
        accountId: 'acct',
        expiresAt: Date.now() + 3_600_000,
      })
      const oauth = new OAuthService(store, { fetchFn: vi.fn() as unknown as typeof fetch })
      const answer = 'subagent finished.'
      const responseFetch = vi.fn(async (_url: unknown, _init?: RequestInit) => sse([
        { type: 'response.output_text.done', output_index: 0, text: answer },
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [{ type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: answer }] }],
          },
        },
      ]))
      const client = new ResponsesClient(
        oauth,
        { readImage: async () => { throw new Error('unused') } },
        { fetchFn: responseFetch as unknown as typeof fetch },
      )
      // `stream` is the adapter boundary: it takes the harness request and
      // normalizes it before any mapper sees it.
      const chunks = await collect(client.stream({
        provider: 'codex-chatgpt', model, messages: [], sessionId: 'session-a',
      } as unknown as HarnessGenerateOptions))
      expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: answer })
      const sentInit = responseFetch.mock.calls[0]?.[1]
      const sent = JSON.parse(String(sentInit?.body)) as Record<string, unknown>
      expect(sent.model).toBe(model)
      oauth.dispose()
    },
  )
})

describe('Codex route: the GPT-6 family has no graceful degradation where Sol does', () => {
  it('resolves a fallback model for Sol but none for any GPT-6 model', () => {
    expect(resolveCodexFallbackModel('gpt-5.6-sol')?.id).toBe('gpt-5.6-terra')
    expect(resolveCodexFallbackModel('gpt-6-astra')).toBeUndefined()
    expect(resolveCodexFallbackModel('gpt-6-sol')).toBeUndefined()
    expect(resolveCodexFallbackModel('gpt-6-luna')).toBeUndefined()
  })

  it('offers Sol the none/minimal tiers the GPT-6 family cannot take', () => {
    expect(reasoningEffortsForModel('gpt-5.6-sol')).toContain('none')
    for (const model of ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']) {
      expect(reasoningEffortsForModel(model)).not.toContain('none')
      expect(reasoningEffortsForModel(model)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    }
  })
})

function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const result: StreamChunk[] = []
  for await (const chunk of iterable) result.push(chunk)
  return result
}

function unusedAttachments(): { readImage: (ref: never) => Promise<{ ref: never; data: Uint8Array }> } {
  return { readImage: async (ref) => ({ ref, data: new Uint8Array([1, 2, 3]) }) }
}
