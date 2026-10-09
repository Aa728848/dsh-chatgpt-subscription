import { describe, expect, it, vi } from 'vitest'
import {
  buildRequest,
  closeStream,
  convertTools,
  createStreamState,
  MAX_REQUEST_IMAGE_BYTES,
  offloadOldestRequestImages,
  processStreamLine,
  requestImageTarget,
  resolveRequestImages,
  stripMetaSchema,
} from '../src/host/antigravity/mapper.ts'
import {
  ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION,
  ANTIGRAVITY_PROGRESS_INSTRUCTION,
  ANTIGRAVITY_SYSTEM_INSTRUCTION,
  MODELS,
} from '../src/host/antigravity/types.ts'
import type { GenerateOptions } from '../src/host/common/llm-compat.ts'
import { normalizeGenerateOptions } from '../src/host/common/llm-compat.ts'
import { BlockAssembler, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

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

  it('folds tool schema unions for a claude target only, on the wire buildRequest sends', () => {
    const claudeModel = MODELS.find((m) => m.id === 'claude-opus-5-5')!
    const parameters = {
      type: 'object',
      properties: {
        at: {
          oneOf: [
            { type: 'string' },
            { type: 'object', properties: { cron: { type: 'string' } } },
          ],
        },
      },
    }
    const tools = [
      { name: 'schedule_create', description: 'Create a schedule', parameters },
    ] as unknown as GenerateOptions['tools']
    const declared = (built: ReturnType<typeof convertTools>): unknown =>
      (built![0].functionDeclarations as Array<{ parameters: unknown }>)[0].parameters
    const folded = {
      type: 'object',
      properties: {
        at: {
          type: 'object',
          properties: { cron: { type: 'string' } },
          description: 'Union of accepted forms: string | object {cron}. ' +
            'Send "object {cron}": this gateway validates the declared form only, ' +
            'and the alternatives describe the original tool contract.',
        },
      },
    }

    // Claude routes to Vertex Anthropic, whose input_schema check refuses a
    // composed tool schema outright (#39).
    expect(declared(convertTools(tools, claudeModel.id, 'claude-opus-5-5-medium'))).toEqual(folded)
    // Gemini ignores anyOf, so its declarations keep the composed form.
    expect(declared(convertTools(tools, testModel.id, 'gemini-3.7-flash-tiered'))).toEqual({
      type: 'object',
      properties: { at: { anyOf: parameters.properties.at.oneOf } },
    })

    // The adapter posts buildRequest's body, so the runtime model decides there too.
    const options = {
      provider: 'antigravity', model: claudeModel.id, messages: [], tools,
    } as unknown as GenerateOptions
    const wire = buildRequest(options, claudeModel, 'test-project-123', 'claude-opus-5-5-medium')
    expect(declared((wire.request as Record<string, unknown>).tools as never)).toEqual(folded)
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

  it('pairs a 0.1.7 tool-role result with the assistant tool call that asked for it', () => {
    // The harness delivers the result as its own `role: 'tool'` message; the
    // adapter normalizes it, and the mapper still has to find the call it
    // answers to name the functionResponse and carry the wire id.
    const options = normalizeGenerateOptions({
      provider: 'antigravity',
      model: 'gemini-3.7-flash',
      messages: [
        createAssistantMessage({
          content: [{ type: 'tool-call', id: ToolCallId('call-1'), name: 'default_api:run_code', arguments: '{"code":"print(1)"}' }],
          source: { provider: 'antigravity', model: 'gemini-3.7-flash' },
        }),
        createToolResultMessage({
          callId: ToolCallId('call-1'),
          content: [{ type: 'text', text: '1' }],
          isError: false,
        }),
      ],
    })

    const request = buildRequest(options, testModel, 'test-proj', 'gemini-3.7-flash-tiered', 'high')
    const contents = (request.request as Record<string, unknown>).contents as Array<any>
    expect(contents[0].parts[0].functionCall.id).toBe('call-1')
    expect(contents[0].parts[0].thoughtSignature).toBe('skip_thought_signature_validator')
    expect(contents[1].parts[0].functionResponse).toEqual({
      name: 'default_api:run_code',
      response: { output: '1' },
      id: 'call-1',
    })
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

  /**
   * A scaled request version of {@link REF}. The seam declares readImageRequest,
   * so every reader here must supply one; REF is 1x1 and inside the edge
   * ceiling, so the scaled path is never actually taken in these cases.
   */
  function requestVersion(data: Uint8Array) {
    return vi.fn(async (_ref: ImageAttachmentRef,
      _target: Parameters<AttachmentStore['readImageRequest']>[1]) => ({ attachment: REF,
      variantId: 'variant' as never, data, mediaType: 'image/png' as const, bytes: data.length,
      width: 1, height: 1, depth: 'uchar' as const, space: 'srgb' as const, hasAlpha: false }))
  }

  function readerReturning(data: Uint8Array) {
    return {
      readImage: vi.fn(async (_ref: ImageAttachmentRef, _signal?: AbortSignal) => ({ ref: REF, data })),
      readImageRequest: requestVersion(data),
    }
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
    const attachments = {
      readImage: vi.fn(async () => { throw new Error('attachment store unavailable') }),
      readImageRequest: requestVersion(PNG_BYTES),
    }
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
    const attachments = {
      readImage: vi.fn(async () => { throw abort }),
      readImageRequest: requestVersion(PNG_BYTES),
    }
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
    const attachments = {
      readImage: vi.fn(async (value: ImageAttachmentRef) => ({ ref: value, data: PNG_BYTES })),
      readImageRequest: requestVersion(PNG_BYTES),
    }

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

describe('Antigravity replay part merging', () => {
  const GEMINI = 'gemini-3.8-flash'
  const CLAUDE = 'claude-opus-5-5'
  const line = (value: unknown) => 'data: ' + JSON.stringify(value)

  /**
   * One assistant turn replayed the way production builds it: SSE text deltas
   * through `processStreamLine`, the assembled blocks and their replay state into
   * a message, then the next request built from that message.
   */
  function replayParts(modelId: string, frames: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    const state = createStreamState()
    const assembler = new BlockAssembler()
    for (const part of frames) {
      for (const chunk of processStreamLine(line({ candidates: [{ content: { parts: [part] } }] }), state)) assembler.push(chunk)
    }
    for (const chunk of processStreamLine(line({ candidates: [{ finishReason: 'STOP' }] }), state)) assembler.push(chunk)
    for (const chunk of closeStream(state)) assembler.push(chunk)
    const message = createAssistantMessage({
      content: assembler.blocks(),
      source: { provider: 'antigravity', model: modelId, replayState: assembler.replayState },
    })
    const request = buildRequest(normalizeGenerateOptions({
      provider: 'antigravity', model: modelId, messages: [message],
    }), MODELS.find((entry) => entry.id === modelId)!, 'project', modelId)
    return (request.request as { contents: Array<{ parts: Array<Record<string, unknown>> }> }).contents[0]?.parts ?? []
  }

  it('merges the text fragments of one Gemini answer into a single replay part', () => {
    // A long reply arrives as hundreds of separate SSE text deltas, and each one
    // used to be replayed as its own wire part on every later turn.
    const frames = Array.from({ length: 385 }, (_, index) => ({ text: 'chunk ' + index + ' ' }))
    expect(replayParts(GEMINI, frames)).toEqual([{ text: frames.map((frame) => frame.text).join('') }])
  })

  it('keeps the merged Gemini text identical to the fragments it replaces', () => {
    const frames = Array.from({ length: 40 }, (_, index) => ({ text: 'piece-' + index + ' ' }))
    const text = frames.map((frame) => frame.text).join('')
    // The model must read the same characters either way, so one part carrying
    // the whole answer and forty parts carrying its pieces build the same bytes.
    expect(replayParts(GEMINI, frames)).toEqual(replayParts(GEMINI, [{ text }]))
  })

  it('merges Gemini text around a signed part without moving that boundary', () => {
    const call = { functionCall: { id: 'call-1', name: 'read', args: { path: 'a.ts' } } }
    expect(replayParts(GEMINI, [
      { text: 'a' }, { text: 'b' },
      { text: 'signed', thoughtSignature: 'sig' },
      { text: 'c' }, { text: 'd' },
      call,
      { text: 'e' }, { text: 'f' },
    ])).toEqual([
      { text: 'ab' },
      { text: 'signed', thoughtSignature: 'sig' },
      { text: 'cd' },
      { functionCall: { name: 'read', args: { path: 'a.ts' }, id: 'call-1' } },
      { text: 'ef' },
    ])
  })

  it('never merges Gemini text across a signature-only part', () => {
    expect(replayParts(GEMINI, [{ text: 'a' }, { text: '', thoughtSignature: 's1' }, { text: 'b' }]))
      .toEqual([{ text: 'a' }, { text: '', thoughtSignature: 's1' }, { text: 'b' }])
  })

  it('does not route Gemini through the Claude thinking-signature pairing', () => {
    // Claude joins an unsigned thinking run with a later signature-only part into
    // one signed thinking block. That is Claude's wire contract, not Gemini's:
    // applying it here would move every one of these four boundaries.
    const frames = [
      { thought: true, text: 'Plan ' },
      { thought: true, text: 'carefully.' },
      { text: '', thought_signature: 'native-signature' },
      { text: 'Answer' },
    ]
    expect(replayParts(GEMINI, frames)).toEqual([
      { thought: true, text: 'Plan ' },
      { thought: true, text: 'carefully.' },
      { text: '', thoughtSignature: 'native-signature' },
      { text: 'Answer' },
    ])
    expect(replayParts(CLAUDE, frames)).toEqual([
      { thought: true, text: 'Plan carefully.', thoughtSignature: 'native-signature' },
      { text: 'Answer' },
    ])
  })

  it('keeps the Antigravity budget its own instead of borrowing another route\'s', () => {
    // host/common/request-images.ts holds Kimi's 1.5 MB budget and warns in the
    // same file that importing one route's number into another refuses that
    // other route's own legal images. Antigravity answers to Google's request
    // cap, so its budget stays at 12 MB.
    expect(MAX_REQUEST_IMAGE_BYTES).toBe(12 * 1024 * 1024)
  })
})

describe('Antigravity request image targets', () => {
  const ref = (width: number, height: number) => ({
    attachmentId: 'sha256:target', mediaType: 'image/png', bytes: 500_000, width, height,
  } as unknown as ImageAttachmentRef)

  it('leaves an image inside the edge ceiling untouched', () => {
    expect(requestImageTarget(ref(800, 600))).toBeUndefined()
  })

  it('scales the long edge and keeps the aspect ratio', () => {
    const target = requestImageTarget(ref(2880, 1800))
    expect(target?.width).toBe(1024)
    expect(target?.height).toBe(Math.round(1024 * 1800 / 2880))
  })

  it('scales a portrait image on its height', () => {
    const target = requestImageTarget(ref(900, 3000))
    expect(target?.height).toBe(1024)
    expect(target?.width).toBe(Math.round(1024 * 900 / 3000))
  })

  it('has no target for a reference without usable dimensions', () => {
    expect(requestImageTarget({ attachmentId: 'a', mediaType: 'image/png', bytes: 10 } as unknown as ImageAttachmentRef)).toBeUndefined()
    expect(requestImageTarget(ref(0, 100))).toBeUndefined()
  })

  it('keeps a request of scaled screenshots inside the Antigravity budget', () => {
    // The invariant that makes scaling work: the per-image request target is
    // small enough that a long session stays inside 12 MB without dropping any.
    const perImage = requestImageTarget(ref(2880, 1800))!.maxBytes
    expect(Math.ceil(perImage / 3) * 4 * 20).toBeLessThan(MAX_REQUEST_IMAGE_BYTES)
  })
})

