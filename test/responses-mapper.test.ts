import { describe, expect, it } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { buildResponsesPayload } from '../src/host/responses-mapper.ts'

describe('Responses payload mapping', () => {
  it('maps system, images, tool calls and tool results without provider URLs', async () => {
    const options = {
      provider: 'codex-chatgpt', model: 'gpt-5.6-sol', system: 'Be precise.',
      reasoningEffort: 'high',
      tools: [{ name: 'read_file', description: 'Read one file', parameters: { type: 'object' } }],
      messages: [
        { id: 'm1', role: 'user', source: { kind: 'user' }, content: [
          { type: 'text', text: 'Inspect this' },
          { type: 'image', attachment: { attachmentId: 'img1', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } },
        ] },
        { id: 'm2', role: 'assistant', source: { kind: 'model', provider: 'codex-chatgpt', model: 'gpt-5.6-sol' }, content: [
          { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' },
        ] },
        { id: 'm3', role: 'user', source: { kind: 'tool', callId: 'call_1' }, content: [
          { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'done' }] },
        ] },
      ],
    } as unknown as GenerateOptions
    const payload = await buildResponsesPayload(options, {
      readImage: async (ref) => ({ ref, data: new Uint8Array([1, 2, 3]) }),
    })
    expect(payload.instructions).toBe('Be precise.')
    expect(payload.input).toContainEqual({
      role: 'user',
      content: [
        { type: 'input_text', text: 'Inspect this' },
        { type: 'input_image', image_url: 'data:image/png;base64,AQID' },
      ],
    })
    expect(payload.input).toContainEqual({ type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' })
    expect(payload.input).toContainEqual({ type: 'function_call_output', call_id: 'call_1', output: 'done' })
    expect(payload).toMatchObject({ stream: true, store: false, tool_choice: 'auto', reasoning: { effort: 'high', summary: 'auto' } })
  })
})
