import { describe, expect, it, vi } from 'vitest'
import {
  buildRequest,
  closeStream,
  convertTools,
  createStreamState,
  MAX_REQUEST_IMAGE_BYTES,
  offloadOldestRequestImages,
  processStreamLine,
  resolveRequestImages,
  stripMetaSchema,
} from '../src/host/antigravity/mapper.ts'
import {
  ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION,
  ANTIGRAVITY_PROGRESS_INSTRUCTION,
  ANTIGRAVITY_SYSTEM_INSTRUCTION,
  MODELS,
} from '../src/host/antigravity/types.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

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
    expect(sysInst.parts.some((p) => p.text.includes(ANTIGRAVITY_PROGRESS_INSTRUCTION))).toBe(true)
    expect(sysInst.parts.some((p) => p.text.includes('Custom developer instructions'))).toBe(true)
    // The progress rule must come after the caller system prompt so it is the
    // most recent instruction the model sees.
    expect(sysInst.parts.findIndex((p) => p.text.includes(ANTIGRAVITY_PROGRESS_INSTRUCTION)))
      .toBeGreaterThan(sysInst.parts.findIndex((p) => p.text.includes('Custom developer instructions')))

    const tools = reqData.tools as Array<{ functionDeclarations: Array<{ name: string }> }>
    expect(tools[0].functionDeclarations[0].name).toBe('get_weather')

    const genConfig = reqData.generationConfig as Record<string, unknown>
    expect(genConfig.thinkingConfig).toEqual({
      thinkingLevel: 'HIGH',
      includeThoughts: true,
    })
  })

  it('injects progress and tool execution rule when tools are present, omits when absent', () => {
    const withoutTools = {
      provider: 'antigravity',
      model: 'gemini-3.7-flash',
      messages: [],
    } as unknown as GenerateOptions
    const reqWithoutTools = buildRequest(withoutTools, testModel, 'test-project', 'gemini-3.7-flash')
    const sysWithoutTools = (reqWithoutTools.request as Record<string, unknown>).systemInstruction as { parts: Array<{ text: string }> }
    expect(sysWithoutTools.parts.some((p) => p.text.includes(ANTIGRAVITY_PROGRESS_INSTRUCTION))).toBe(false)

    const withTools = {
      provider: 'antigravity',
      model: 'gemini-3.7-flash',
      tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }],
      messages: [],
    } as unknown as GenerateOptions
    const reqWithTools = buildRequest(withTools, testModel, 'test-project', 'gemini-3.7-flash')
    const sysWithTools = (reqWithTools.request as Record<string, unknown>).systemInstruction as { parts: Array<{ text: string }> }
    expect(sysWithTools.parts.some((p) => p.text.includes(ANTIGRAVITY_PROGRESS_INSTRUCTION))).toBe(true)
  })

  it('configures thinkingConfig correctly across Gemini 3.x and Gemini 2.5 models', () => {
    const options: GenerateOptions = {
      provider: 'antigravity',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as unknown as GenerateOptions

    // Gemini 3.8 Flash (medium effort)
    const m38 = MODELS.find((m) => m.id === 'gemini-3.8-flash')!
    const req38 = buildRequest(options, m38, 'p1', 'gemini-3.8-flash-tiered', 'medium')
    expect((req38.request as Record<string, unknown>).generationConfig).toMatchObject({
      thinkingConfig: { thinkingLevel: 'MEDIUM', includeThoughts: true },
    })

    // Gemini 3.6 Flash (low effort) - 档位在模型名中，思考配置只补 includeThoughts
    const m36 = MODELS.find((m) => m.id === 'gemini-3.6-flash')!
    const req36 = buildRequest(options, m36, 'p1', 'gemini-3.6-flash-low', 'low')
    expect((req36.request as Record<string, unknown>).generationConfig).toMatchObject({
      thinkingConfig: { includeThoughts: true },
    })

    // Gemini 3.7 Flash (off / none)
    const m37 = MODELS.find((m) => m.id === 'gemini-3.7-flash')!
    const req37Off = buildRequest(options, m37, 'p1', 'gemini-3.7-flash-tiered', 'off')
    expect((req37Off.request as Record<string, unknown>).generationConfig).toMatchObject({
      thinkingConfig: { thinkingLevel: 'LOW', includeThoughts: false },
    })

    // Gemini 2.5 Pro (high effort)
    const m25p = MODELS.find((m) => m.id === 'gemini-2.5-pro')!
    const req25p = buildRequest(options, m25p, 'p1', 'gemini-2.5-pro', 'high')
    expect((req25p.request as Record<string, unknown>).generationConfig).toMatchObject({
      thinkingConfig: { thinkingBudget: 32768, includeThoughts: true },
    })

    // Gemini 2.5 Flash (off effort)
    const m25f = MODELS.find((m) => m.id === 'gemini-2.5-flash')!
    const req25f = buildRequest(options, m25f, 'p1', 'gemini-2.5-flash', 'off')
    expect((req25f.request as Record<string, unknown>).generationConfig).toMatchObject({
      thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
    })
  })

  it.each(['gemini-3.8-flash', 'gemini-3.7-flash'])('uses supported thinking levels for %s, including legacy efforts', (modelId) => {
    const model = MODELS.find((entry) => entry.id === modelId)!
    const options = { provider: 'antigravity', model: modelId, messages: [] } as GenerateOptions
    const efforts = [
      ['off', 'LOW', false], ['none', 'LOW', false], ['minimal', 'LOW', true],
      ['low', 'LOW', true], ['medium', 'MEDIUM', true], ['high', 'HIGH', true], ['xhigh', 'HIGH', true],
    ] as const
    for (const [effort, thinkingLevel, includeThoughts] of efforts) {
      const request = buildRequest(options, model, 'project', `${modelId}-tiered`, effort)
      expect((request.request as any).generationConfig.thinkingConfig).toEqual({ thinkingLevel, includeThoughts })
    }
  })

  it('requests thought summaries for thinking gemini runtimes only', () => {
    const options = {
      provider: 'antigravity',
      model: 'gemini-3.8-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello AI' }] }],
    } as unknown as GenerateOptions

    // tiered 运行时：思考档位来自 effort，同时必须请求返回思考内容
    const tiered = buildRequest(options, testModel, 'p', 'gemini-3.7-flash-tiered', 'high')
    expect((tiered.request as Record<string, unknown>).generationConfig).toMatchObject({
      thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true },
    })

    // 档位后缀运行时：档位在模型名里，只补 includeThoughts
    const suffixed = buildRequest(options, testModel, 'p', 'gemini-3.6-flash-high', 'medium')
    expect((suffixed.request as Record<string, unknown>).generationConfig).toMatchObject({
      thinkingConfig: { includeThoughts: true },
    })

    // 非思考运行时不携带 thinkingConfig
    for (const runtime of ['claude-sonnet-4-6', 'gpt-oss-120b-medium']) {
      const request = buildRequest(options, testModel, 'p', runtime, 'high')
      expect((request.request as Record<string, unknown>).generationConfig).not.toHaveProperty('thinkingConfig')
    }
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
    const chunks4 = [...processStreamLine(line4, state), ...closeStream(state)]
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
    expect(assistantPartA.functionCall.id).toBe('call-1')
    expect(contentsA[1].parts[0].functionResponse.id).toBe('call-1')
    expect(assistantPartA.thoughtSignature).toBe('skip_thought_signature_validator')

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
    expect(assistantPartB.functionCall.id).toBe('call-2')
    expect(contentsB[1].parts[0].functionResponse.id).toBe('call-2')
    expect(assistantPartB.thoughtSignature).toBe('real_google_sig_123')
  })

describe('Antigravity image attachments', () => {
  const model = MODELS.find((m) => m.id === 'gemini-3.8-flash')!
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const BASE64 = Buffer.from(PNG_BYTES).toString('base64')
  const REF = {
    attachmentId: 'sha256:0123456789abcdef',
    mediaType: 'image/png',
    bytes: PNG_BYTES.length,
    width: 1,
    height: 1,
    name: 'shot.png',
  } as unknown as ImageAttachmentRef

  function requestWith(blocks: unknown[]): GenerateOptions {
    return {
      provider: 'antigravity',
      model: 'gemini-3.8-flash',
      messages: [{ role: 'user', content: blocks }],
    } as unknown as GenerateOptions
  }

  function readerReturning(data: Uint8Array) {
    return { readImage: vi.fn(async (_ref: ImageAttachmentRef, _signal?: AbortSignal) => ({ ref: REF, data })) }
  }

  function requestParts(options: GenerateOptions, images: Awaited<ReturnType<typeof resolveRequestImages>>) {
    const request = buildRequest(options, model, 'test-proj', model.id, 'medium', images)
    const contents = (request.request as Record<string, unknown>).contents as Array<{ parts: Array<any> }>
    return contents.flatMap((entry) => entry.parts)
  }

  it('sends a durable DSH attachment block as Gemini inlineData', async () => {
    const attachments = readerReturning(PNG_BYTES)
    const options = requestWith([{ type: 'text', text: 'what is in this image?' }, { type: 'image', attachment: REF }])

    const parts = requestParts(options, await resolveRequestImages(options, attachments))

    expect(parts).toEqual([
      { text: 'what is in this image?' },
      { inlineData: { mimeType: 'image/png', data: BASE64 } },
    ])
    expect(attachments.readImage).toHaveBeenCalledTimes(1)
    expect(attachments.readImage.mock.calls[0]?.[0]).toBe(REF)
  })

  it('reads a shared attachment once across messages', async () => {
    const attachments = readerReturning(PNG_BYTES)
    const options = {
      provider: 'antigravity',
      model: 'gemini-3.8-flash',
      messages: [
        { role: 'user', content: [{ type: 'image', attachment: REF }] },
        { role: 'user', content: [{ type: 'text', text: 'and now?' }, { type: 'image', attachment: REF }] },
      ],
    } as unknown as GenerateOptions

    const parts = requestParts(options, await resolveRequestImages(options, attachments))

    expect(attachments.readImage).toHaveBeenCalledTimes(1)
    expect(parts.filter((part) => 'inlineData' in part)).toHaveLength(2)
  })

  it('keeps an unreadable image visible as text instead of dropping it', async () => {
    const attachments = { readImage: vi.fn(async () => { throw new Error('attachment store unavailable') }) }
    const options = requestWith([{ type: 'text', text: 'look' }, { type: 'image', attachment: REF }])

    const parts = requestParts(options, await resolveRequestImages(options, attachments))

    expect(parts.some((part) => 'inlineData' in part)).toBe(false)
    expect(parts[1]).toEqual({
      text: '[image unavailable: shot.png could not be read; ask the user to attach it again if the image is needed]',
    })
  })

  it('reports an image the host cannot resolve without any attachment service', async () => {
    const options = requestWith([{ type: 'image', attachment: REF }])

    const parts = requestParts(options, await resolveRequestImages(options, undefined))

    expect(parts).toEqual([{
      text: '[image unavailable: shot.png could not be read; ask the user to attach it again if the image is needed]',
    }])
  })

  it('propagates cancellation instead of reporting it as model text', async () => {
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    const attachments = { readImage: vi.fn(async () => { throw abort }) }
    const options = requestWith([{ type: 'image', attachment: REF }])

    await expect(resolveRequestImages(options, attachments)).rejects.toBe(abort)
  })

  it('still maps legacy inline image blocks and leaves the attachment store untouched', async () => {
    const attachments = readerReturning(PNG_BYTES)
    const options = requestWith([{ type: 'image', mediaType: 'image/png', data: BASE64 }])

    const parts = requestParts(options, await resolveRequestImages(options, attachments))

    expect(parts).toEqual([{ inlineData: { mimeType: 'image/png', data: BASE64 } }])
    expect(attachments.readImage).not.toHaveBeenCalled()
  })

  it('leaves a request that already fits the inline image budget untouched', () => {
    const options = requestWith([{ type: 'text', text: 'look' }, { type: 'image', attachment: REF }])

    expect(offloadOldestRequestImages(options)).toBe(options)
    expect(MAX_REQUEST_IMAGE_BYTES).toBeGreaterThan(REF.bytes)
  })

  it('omits the oldest images once one request would exceed the inline image budget', async () => {
    // 6 MiB of raw bytes is 8 MiB of base64, so three of them are 24 MiB against
    // a 12 MiB budget: the two oldest go, the newest stays.
    const raw = 6 * 1024 * 1024
    const sized = (id: string) => ({
      attachmentId: id, mediaType: 'image/png', bytes: raw, width: 1, height: 1,
    } as unknown as ImageAttachmentRef)
    const oldest = sized('sha256:oldest')
    const middle = sized('sha256:middle')
    const newest = sized('sha256:newest')
    const options = {
      provider: 'antigravity',
      model: 'gemini-3.8-flash',
      messages: [
        { role: 'user', content: [{ type: 'image', attachment: oldest }] },
        { role: 'user', content: [{ type: 'image', attachment: middle }] },
        { role: 'user', content: [{ type: 'text', text: 'and this one?' }, { type: 'image', attachment: newest }] },
      ],
    } as unknown as GenerateOptions
    const attachments = { readImage: vi.fn(async (value: ImageAttachmentRef) => ({ ref: value, data: PNG_BYTES })) }

    const bounded = offloadOldestRequestImages(options)
    const parts = requestParts(bounded, await resolveRequestImages(bounded, attachments))

    expect(parts.filter((part) => 'inlineData' in part)).toHaveLength(1)
    expect(parts.filter((part) => typeof part.text === 'string' && part.text.includes('image omitted'))).toHaveLength(2)
    // The omitted images are never read, and durable history keeps its blocks.
    expect(attachments.readImage).toHaveBeenCalledTimes(1)
    expect(attachments.readImage.mock.calls[0]?.[0]).toBe(newest)
    expect(options.messages[0]?.content[0]).toEqual({ type: 'image', attachment: oldest })
  })

  it('marks an unresolved attachment image even when no resolution was supplied', () => {
    const options = requestWith([{ type: 'text', text: 'look' }, { type: 'image', attachment: REF }])

    // The default argument keeps direct buildRequest callers honest: a block the
    // mapper cannot turn into bytes still reaches the model as visible text.
    const request = buildRequest(options, model, 'test-proj', model.id, 'medium')
    const contents = (request.request as Record<string, unknown>).contents as Array<{ parts: Array<any> }>
    expect(contents[0].parts).toEqual([
      { text: 'look' },
      { text: '[image unavailable: shot.png could not be read; ask the user to attach it again if the image is needed]' },
    ])
  })

  it('names an image returned inside a tool result', () => {
    const options = requestWith([{
      type: 'tool-result',
      toolCallId: 'call-1',
      content: [{ type: 'image', attachment: REF }],
    }])

    const request = buildRequest(options, model, 'test-proj', model.id, 'medium')
    const contents = (request.request as Record<string, unknown>).contents as Array<{ parts: Array<any> }>
    expect(contents[0].parts[0].functionResponse.response).toEqual({ output: '[image: shot.png]' })
  })
})
})

