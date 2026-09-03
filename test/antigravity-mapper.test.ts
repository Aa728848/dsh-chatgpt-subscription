import { describe, expect, it } from 'vitest'
import {
  buildRequest,
  convertTools,
  createStreamState,
  processStreamLine,
  stripMetaSchema,
} from '../src/host/antigravity/mapper.ts'
import {
  ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION,
  ANTIGRAVITY_SYSTEM_INSTRUCTION,
  MODELS,
} from '../src/host/antigravity/types.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

describe('Antigravity Mapper', () => {
  const testModel = MODELS.find((m) => m.id === 'gemini-3.7-flash')!

  it('strips json schema meta keywords correctly', () => {
    const rawSchema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        query: { type: 'string', $comment: 'search query' },
      },
    }
    const stripped = stripMetaSchema(rawSchema) as Record<string, unknown>
    expect(stripped.$schema).toBeUndefined()
    expect((stripped.properties as Record<string, unknown>).query).toEqual({ type: 'string' })
  })

  it('builds request with system instructions and converted tools', () => {
    const options: GenerateOptions = {
      provider: 'antigravity',
      model: 'gemini-3.7-flash',
      system: 'Custom developer instructions',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Hello AI' }] },
      ],
      tools: [
        {
          name: 'get_weather',
          description: 'Get current weather',
          parameters: {
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            properties: { city: { type: 'string' } },
          },
        },
      ],
    } as unknown as GenerateOptions

    const request = buildRequest(options, testModel, 'test-project-123', 'gemini-3.7-flash-tiered', 'high')
    expect(request.project).toBe('test-project-123')
    expect(request.model).toBe('gemini-3.7-flash-tiered')

    const reqData = request.request as Record<string, unknown>
    const sysInst = reqData.systemInstruction as { parts: Array<{ text: string }> }
    expect(sysInst.parts.some((p) => p.text.includes(ANTIGRAVITY_SYSTEM_INSTRUCTION))).toBe(true)
    expect(sysInst.parts.some((p) => p.text.includes(ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION))).toBe(true)
    expect(sysInst.parts.some((p) => p.text.includes('Custom developer instructions'))).toBe(true)

    const tools = reqData.tools as Array<{ functionDeclarations: Array<{ name: string }> }>
    expect(tools[0].functionDeclarations[0].name).toBe('get_weather')
  })

  it('parses SSE text, thinking reasoning, and tool calls', () => {
    const state = createStreamState()

    // 1. 思考链数据块
    const line1 = 'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"Let me think."}]}}]}'
    const chunks1 = processStreamLine(line1, state)
    expect(chunks1).toContainEqual({ type: 'block-start', index: 0, blockType: 'reasoning' })
    expect(chunks1).toContainEqual({ type: 'reasoning-delta', index: 0, text: 'Let me think.' })

    // 2. 正式文本回答
    const line2 = 'data: {"candidates":[{"content":{"parts":[{"text":"Here is the answer."}]}}]}'
    const chunks2 = processStreamLine(line2, state)
    expect(chunks2).toContainEqual({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Let me think.' } })
    expect(chunks2).toContainEqual({ type: 'block-start', index: 1, blockType: 'text' })
    expect(chunks2).toContainEqual({ type: 'text-delta', index: 1, text: 'Here is the answer.' })

    // 3. 函数调用
    const line3 = 'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"search","args":{"q":"weather"}}}]}}]}'
    const chunks3 = processStreamLine(line3, state)
    expect(chunks3).toContainEqual({ type: 'block-end', index: 1, block: { type: 'text', text: 'Here is the answer.' } })
    expect(chunks3).toContainEqual({ type: 'block-start', index: 2, blockType: 'tool-call' })
    expect(chunks3.some((c) => c.type === 'tool-call-delta')).toBe(true)

    // 4. 完成与用量
    const line4 = 'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":20}}'
    const chunks4 = processStreamLine(line4, state)
    expect(chunks4).toContainEqual({ type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } })
    expect(chunks4.some((c) => c.type === 'finish')).toBe(true)
  })

  it('preserves thought_signature for tool-call in assistant message or uses skip fallback', () => {
    // 场景 A: 包含没有签名的 tool-call，自动填充 skip_thought_signature_validator
    const optionsWithoutSig: GenerateOptions = {
      provider: 'antigravity',
      model: 'gemini-3.7-flash',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              id: 'call-1',
              name: 'default_api:run_code',
              arguments: '{"code":"print(1)"}',
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              content: [{ type: 'text', text: '1' }],
            },
          ],
        },
      ],
    } as unknown as GenerateOptions

    const reqA = buildRequest(optionsWithoutSig, testModel, 'test-proj', 'gemini-3.7-flash-tiered', 'high')
    const contentsA = (reqA.request as Record<string, unknown>).contents as Array<any>
    const assistantPartA = contentsA[0].parts[0]
    expect(assistantPartA.functionCall.name).toBe('default_api:run_code')
    expect(assistantPartA.thought_signature).toBe('skip_thought_signature_validator')

    // 场景 B: 携带真实签名的 tool-call，优先原样保留
    const optionsWithSig: GenerateOptions = {
      provider: 'antigravity',
      model: 'gemini-3.7-flash',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              id: 'call-2',
              name: 'default_api:run_code',
              arguments: '{"code":"print(2)"}',
              thought_signature: 'real_google_sig_123',
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-2',
              content: [{ type: 'text', text: '2' }],
            },
          ],
        },
      ],
    } as unknown as GenerateOptions

    const reqB = buildRequest(optionsWithSig, testModel, 'test-proj', 'gemini-3.7-flash-tiered', 'high')
    const contentsB = (reqB.request as Record<string, unknown>).contents as Array<any>
    const assistantPartB = contentsB[0].parts[0]
    expect(assistantPartB.functionCall.name).toBe('default_api:run_code')
    expect(assistantPartB.thought_signature).toBe('real_google_sig_123')
  })
})
