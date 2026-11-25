import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '../../../src/host/common/llm-compat.ts'
import { buildOpenCodeGoChatRequest, assertOpenCodeGoStreamComplete, createOpenCodeGoChatStreamState, openCodeGoPlanFromBillingSource, processOpenCodeGoStreamLine } from '../../../src/host/providers/opencode-go/mapper.ts'
import { classifyOpenCodeGoFailure } from '../../../src/host/providers/opencode-go/adapter.ts'
import { opencodeGoSessionId } from '../../../src/host/providers/opencode-go/types.ts'
import { credential, modelEntry, settings, sse } from './helpers.ts'

describe('OpenCode Go request and stream mapping', () => {
  it('maps system text, tools, tool results and reasoning effort', () => {
    const body = buildOpenCodeGoChatRequest({
      provider: 'opencode-go', model: 'deepseek-v4.1-flash', system: 'Be precise',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'call' }] },
        { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'probe', arguments: '{}' }], source: { kind: 'tool' } as never },
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'done' }] }] },
      ],
      tools: [{ name: 'probe', description: 'probe', parameters: { type: 'object', $schema: 'remove-me', properties: {} } }],
      reasoningEffort: 'high', maxTokens: 123,
    } as never, new Map(), modelEntry(), settings({ defaultReasoningEffort: 'low' }))
    expect(body.model).toBe('deepseek-v4.1-flash')
    expect(body.reasoning_effort).toBe('high')
    expect(body.max_tokens).toBe(123)
    expect(body.stream_options).toEqual({ include_usage: true })
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages[0]).toEqual({ role: 'system', content: 'Be precise' })
    expect(messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'done' })
    expect(JSON.stringify(body.tools)).not.toContain('$schema')
  })

  it('streams text, reasoning, tool calls and OpenCode billing metadata', async () => {
    const state = createOpenCodeGoChatStreamState()
    const response = sse([
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'think', content: 'O' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'K', tool_calls: [{ index: 0, id: 'call_1', function: { name: 'probe', arguments: '{"value":' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ok"}' } }] }, finish_reason: 'tool_calls' }] }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 }, opencode: { billing_source: 'go-plus' } } }),
    ])
    expect(response.body).not.toBeNull()
    const chunks = []
    for (const line of (await response.text()).split('\n')) chunks.push(...processOpenCodeGoStreamLine(line, state))
    expect(chunks.some(chunk => chunk.type === 'reasoning-delta' && chunk.text === 'think')).toBe(true)
    expect(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'K')).toBe(true)
    const finish = chunks.find((chunk): chunk is Extract<StreamChunk, { type: 'finish' }> => chunk.type === 'finish')
    expect(finish?.reason).toEqual({ kind: 'tool-calls' })
    expect(finish?.replayState).toMatchObject({ response: { provider: 'opencode-go', billingSource: 'go-plus' } })
    expect(state.tools.get('index:0')?.arguments).toBe('{"value":"ok"}')
    expect(openCodeGoPlanFromBillingSource(state.billingSource)).toBe('Go Plus')
  })

  it('omits tool declarations when an aggregated model declares no tool support', () => {
    const body = buildOpenCodeGoChatRequest({ provider: 'opencode-go', model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], tools: [{ name: 'probe', description: 'probe', parameters: { type: 'object' } }] } as never, new Map(), modelEntry({ supportsTools: false }), settings())
    expect(body.tools).toBeUndefined()
    expect(body.tool_choice).toBeUndefined()
  })

  it('rejects malformed JSON and early stream termination', () => {
    expect(() => processOpenCodeGoStreamLine('data: {bad json}', createOpenCodeGoChatStreamState())).toThrow(/malformed/)
    expect(() => assertOpenCodeGoStreamComplete(createOpenCodeGoChatStreamState())).toThrow(/terminal event/)
  })

  it('keeps sessions stable per account and isolates different accounts', () => {
    const first = opencodeGoSessionId('session-1', 'acc_1')
    expect(opencodeGoSessionId('session-1', 'acc_1')).toBe(first)
    expect(opencodeGoSessionId('session-1', 'acc_2')).not.toBe(first)
    expect(opencodeGoSessionId('session-2', 'acc_1')).not.toBe(first)
    expect(first).toMatch(/^ses_dsh_/)
  })

  it('classifies auth, permission, quota and server failures distinctly', () => {
    expect(classifyOpenCodeGoFailure(401, 'bad key').code).toBe('INVALID_CREDENTIAL')
    expect(classifyOpenCodeGoFailure(403, 'region').code).toBe('PROVIDER_ERROR')
    expect(classifyOpenCodeGoFailure(429, 'limited').code).toBe('RATE_LIMIT')
    expect(classifyOpenCodeGoFailure(503, 'down').code).toBe('SERVER')
  })
})
