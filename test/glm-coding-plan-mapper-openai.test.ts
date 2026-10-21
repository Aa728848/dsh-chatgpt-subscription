/**
 * W3b 的离线测试：GLM（ZCode 账号）线路的 OpenAI 兼容面映射。
 *
 * 全部离线——不碰网络、不需要真实凭据、不读 ~/.zcode。凭据只用脱敏字面量
 * id.secret（那是兑换链产出的形状，不是任何一把真 Key）。
 */

import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '../src/host/common/llm-compat.ts'
import type { GlmModelOption } from '../src/shared/glm-coding-plan-contracts.ts'
import { PLUGIN_MESSAGE_SOURCE_KIND } from '../src/host/common/llm-compat.ts'
import {
  CHAT_COMPLETIONS_SEGMENT,
  MAX_REQUEST_IMAGE_BYTES,
  MODELS_SEGMENT,
  UNDECLARED_MODEL_ROUTE,
  UNSUPPORTED_OPTION_CODE,
  assertStreamComplete,
  buildChatRequest,
  chatCompletionsUrl,
  classifyGlmOpenAiFailure,
  closeStream,
  createStreamState,
  glmOpenAiHeaders,
  modelsUrl,
  offloadOldestRequestImages,
  processStreamLine,
  readGlmErrorCode,
  stripMetaSchema,
  type GlmOpenAiModelRoute,
} from '../src/host/glm-coding-plan/mapper-openai.ts'
import {
  CHAT_PATH_OPENAI,
  DEFAULT_MAX_TOKENS,
  ERROR_CODE,
  convergeGlmEffort,
} from '../src/host/glm-coding-plan/types.ts'

/** GLM-5.3 那一档：三个思考档位、收图。 */
const FULL_ROUTE: GlmOpenAiModelRoute = {
  reasoningEfforts: ['low', 'high', 'max'],
  supportsImages: true,
  defaultMaxTokens: 16_384,
}

/** 历史草案记录过的反例之一：glm-5.2 只有两个档位。 */
const TWO_STEP_ROUTE: GlmOpenAiModelRoute = {
  reasoningEfforts: ['low', 'high'],
  supportsImages: false,
}

function userMessage(content: unknown[]): Message {
  return {
    id: 'm1',
    role: 'user',
    content,
    source: { kind: 'user' },
  } as unknown as Message
}

function systemMessage(text: string): Message {
  // harness 的 MessageSourceMap 早已没有兜底的 plugin kind，本包自己声明了一个；
  // 一条 system 贡献不声明任何形态。
  return {
    id: 'm0',
    role: 'system',
    content: [{ type: 'text', text }],
    source: { kind: PLUGIN_MESSAGE_SOURCE_KIND },
  } as unknown as Message
}

function toolResultMessage(toolCallId: string, text: string): Message {
  return {
    id: 'm2',
    role: 'user',
    content: [{ type: 'tool-result', toolCallId, content: [{ type: 'text', text }] }],
    source: { kind: 'tool', callId: toolCallId },
  } as unknown as Message
}

function baseOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'glm-coding-plan',
    model: 'glm-5.3',
    messages: [userMessage([{ type: 'text', text: 'hello' }])],
    ...overrides,
  } as GenerateOptions
}

function messagesOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return body.messages as Array<Record<string, unknown>>
}

function sse(payload: unknown): string {
  return 'data: ' + (typeof payload === 'string' ? payload : JSON.stringify(payload))
}

/** 跑完整条流，返回终局块序列。 */
function runStream(lines: string[]): StreamChunk[] {
  const state = createStreamState()
  const out: StreamChunk[] = []
  for (const line of lines) out.push(...processStreamLine(line, state))
  out.push(...closeStream(state))
  return out
}

// ---------------------------------------------------------------------------

describe('端点与认证头', () => {
  it('两区都打 Coding Plan 专用面，绝不是通用开放平台面 /api/paas/v4', () => {
    expect(CHAT_PATH_OPENAI).toBe('/api/coding/paas/v4')
    expect(chatCompletionsUrl('intl')).toBe('https://api.z.ai/api/coding/paas/v4/chat/completions')
    expect(chatCompletionsUrl('cn')).toBe('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions')
    expect(modelsUrl('intl')).toBe('https://api.z.ai/api/coding/paas/v4/models')
    expect(modelsUrl('cn')).toBe('https://open.bigmodel.cn/api/coding/paas/v4/models')
    // 发错前缀不会报错，只会让套餐额度不生效（计划 §3.3），所以逐条钉死。
    for (const url of [chatCompletionsUrl('intl'), modelsUrl('cn')]) {
      expect(url).not.toContain('/api/paas/v4')
    }
  })

  it('路径分段只接在 CHAT_PATH_OPENAI 之后，不在别处另写一份', () => {
    expect(CHAT_COMPLETIONS_SEGMENT).toBe('/chat/completions')
    expect(MODELS_SEGMENT).toBe('/models')
    expect(chatCompletionsUrl('intl').endsWith(CHAT_PATH_OPENAI + CHAT_COMPLETIONS_SEGMENT)).toBe(true)
    expect(modelsUrl('cn').endsWith(CHAT_PATH_OPENAI + MODELS_SEGMENT)).toBe(true)
  })

  it('认证头是 Authorization: Bearer {id}.{secret}', () => {
    const headers = glmOpenAiHeaders('fake-id.fake-secret')
    expect(headers.authorization).toBe('Bearer fake-id.fake-secret')
    expect(headers['content-type']).toBe('application/json')
  })

  it('本面不发 x-api-key —— 双头是 Anthropic 面的性质', () => {
    const headers = glmOpenAiHeaders('fake-id.fake-secret')
    expect(headers).not.toHaveProperty('x-api-key')
    expect(Object.keys(headers).some((key) => key.toLowerCase() === 'x-api-key')).toBe(false)
  })
})

describe('请求 body 形状', () => {
  it('不含上游不认的字段：thinking.type 与 stream_options', () => {
    const body = buildChatRequest(
      baseOptions({
        reasoningEffort: 'high' as never,
        tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } }],
      }),
      undefined,
      FULL_ROUTE,
    )
    expect(body.stream).toBe(true)
    expect(body).not.toHaveProperty('stream_options')
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('thinking.type')
    // 逐键核对，防止将来多写一个上游不认的字段进来。
    expect(Object.keys(body).sort()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'reasoning_effort',
      'stream',
      'tool_choice',
      'tools',
    ])
  })

  it('即使调用方要求关闭思考，也不发任何关闭字段', () => {
    const body = buildChatRequest(baseOptions({ reasoningEffort: 'low' as never }), undefined, FULL_ROUTE)
    expect(JSON.stringify(body)).not.toContain('disabled')
    expect(JSON.stringify(body)).not.toContain('thinking')
  })

  it('模型 id 原样透传，不在本层伪造或改写', () => {
    const body = buildChatRequest(baseOptions({ model: 'glm-5.2-air' }), undefined, TWO_STEP_ROUTE)
    expect(body.model).toBe('glm-5.2-air')
  })

  it('输出上限取调用方的值，其次目录声明，最后才是兜底常量', () => {
    expect(buildChatRequest(baseOptions({ maxTokens: 512 }), undefined, FULL_ROUTE).max_tokens).toBe(512)
    expect(buildChatRequest(baseOptions(), undefined, FULL_ROUTE).max_tokens).toBe(16_384)
    expect(buildChatRequest(baseOptions(), undefined, TWO_STEP_ROUTE).max_tokens).toBe(DEFAULT_MAX_TOKENS)
    expect(buildChatRequest(baseOptions()).max_tokens).toBe(DEFAULT_MAX_TOKENS)
  })

  it('system 轮收成开头一条，没有提示词就整条省略', () => {
    const bare = buildChatRequest(baseOptions())
    expect(messagesOf(bare)).toEqual([{ role: 'user', content: 'hello' }])

    const folded = buildChatRequest(baseOptions({
      system: '顶层提示词',
      messages: [systemMessage('历史提示词'), userMessage([{ type: 'text', text: 'hi' }])],
    }))
    expect(messagesOf(folded)[0]).toEqual({ role: 'system', content: '顶层提示词\n\n历史提示词' })
    expect(messagesOf(folded).filter((m) => m.role === 'system')).toHaveLength(1)
  })

  it('用户纯文本走字符串形式', () => {
    const body = buildChatRequest(baseOptions(), undefined, FULL_ROUTE)
    expect(messagesOf(body)[0]).toEqual({ role: 'user', content: 'hello' })
  })

  it('工具 schema 去掉 $schema；工具历史折叠与 deferLoading 抛不支持', () => {
    const body = buildChatRequest(baseOptions({
      tools: [{
        name: 'read_file',
        description: 'Read a file',
        parameters: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { path: { type: 'string' } } },
      }],
    }), undefined, FULL_ROUTE)
    const tools = body.tools as Array<Record<string, any>>
    expect(tools).toHaveLength(1)
    expect(tools[0]!.function.name).toBe('read_file')
    expect(tools[0]!.function.parameters.$schema).toBeUndefined()
    expect(tools[0]!.function.parameters.properties.path).toEqual({ type: 'string' })
    expect(body.tool_choice).toBe('auto')

    // 会话折叠的工具历史需要一套「中途增删工具」的协议，本面没有。
    const folded = () => buildChatRequest(baseOptions({ toolHistory: { tools: [], updates: [] } }))
    expect(folded).toThrow(LlmError)
    try {
      folded()
    } catch (error) {
      expect((error as LlmError).code).toBe(UNSUPPORTED_OPTION_CODE)
      expect((error as LlmError).code).toBe('UNSUPPORTED_OPTION')
    }

    // deferLoading 是 Anthropic 面的术语。
    const deferred = () => buildChatRequest(baseOptions({
      tools: [{ deferLoading: true, name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }],
    }), undefined, FULL_ROUTE)
    expect(deferred).toThrow(LlmError)
    try {
      deferred()
    } catch (error) {
      expect((error as LlmError).code).toBe(UNSUPPORTED_OPTION_CODE)
    }
  })

  it('不支持的选项报 harness 的通用码 UNSUPPORTED_OPTION，不自造线路前缀', () => {
    // harness 自己的 provider 就用这个串（llm-pi-ai 的 adapter），本线路的 Anthropic 面
    // （mapper-anthropic.ts）也用同一个串。装配层要判断「这个面做不到这件事」时，
    // 只该有一个词要认，而不是先问是哪个面。
    expect(UNSUPPORTED_OPTION_CODE).toBe('UNSUPPORTED_OPTION')
  })

  it('stripMetaSchema 对非对象输入给出空 object schema', () => {
    expect(stripMetaSchema('nope')).toEqual({ type: 'object', properties: {} })
    expect(stripMetaSchema({ $schema: 'x', type: 'object' })).toEqual({ type: 'object' })
  })
  it('冻结契约里的 GlmModelOption 可以整行直接传进来（字段名与类型都对得上）', () => {
    // W6 的适配器要能把目录行原样交给 mapper，所以这里用真实类型钉住这条兼容关系，
    // 免得日后目录字段改名时只有编译期才发现。
    const option: GlmModelOption = {
      id: 'glm-5.3',
      name: 'GLM-5.3',
      hint: '思考恒定开启，可选三档',
      enabled: true,
      defaultContextWindow: 128_000,
      contextWindow: 128_000,
      defaultMaxTokens: 16_384,
      reasoningEfforts: ['low', 'high', 'max'],
      thinkingDisableable: false,
      wire: 'openai',
      supportsImages: true,
      regions: ['cn', 'intl'],
      description: null,
    }
    const route: GlmOpenAiModelRoute = option
    const body = buildChatRequest(baseOptions({ reasoningEffort: 'minimal' as never }), undefined, route)
    expect(body.reasoning_effort).toBe('low')
    expect(body.max_tokens).toBe(16_384)
  })
})

describe('思考档位收敛（含越档反例）', () => {
  it('梯子内的取值原样发出', () => {
    for (const effort of ['low', 'high', 'max']) {
      const body = buildChatRequest(baseOptions({ reasoningEffort: effort as never }), undefined, FULL_ROUTE)
      expect(body.reasoning_effort).toBe(effort)
    }
  })

  it('未指定档位就不发这个字段', () => {
    expect(buildChatRequest(baseOptions(), undefined, FULL_ROUTE).reasoning_effort).toBeUndefined()
  })

  it('越档反例：minimal 必须落到 low，绝不能被误升成 high', () => {
    // 这就是只排 low/high/max 三档时踩过的坑：minimal 属于「未识别」，
    // 而未识别一律落在中档，于是被发成 high —— 模型想得比用户要求的长得多，
    // 更慢而且多计费。
    const body = buildChatRequest(baseOptions({ reasoningEffort: 'minimal' as never }), undefined, FULL_ROUTE)
    expect(body.reasoning_effort).toBe('low')
    expect(body.reasoning_effort).not.toBe('high')
    expect(convergeGlmEffort('minimal', ['low', 'high', 'max'])).toBe('low')
  })

  it('越档反例：none 也不得被抬到中档', () => {
    const body = buildChatRequest(baseOptions({ reasoningEffort: 'none' as never }), undefined, FULL_ROUTE)
    expect(body.reasoning_effort).toBe('low')
  })

  it('medium / xhigh 在两档模型上落到最近的一档', () => {
    expect(buildChatRequest(baseOptions({ reasoningEffort: 'medium' as never }), undefined, TWO_STEP_ROUTE).reasoning_effort)
      .toBe('high')
    expect(buildChatRequest(baseOptions({ reasoningEffort: 'xhigh' as never }), undefined, TWO_STEP_ROUTE).reasoning_effort)
      .toBe('high')
  })

  it('梯子为空的模型不发 reasoning_effort，而不是发一个它不认的值', () => {
    expect(buildChatRequest(baseOptions({ reasoningEffort: 'high' as never })).reasoning_effort).toBeUndefined()
    expect(UNDECLARED_MODEL_ROUTE.reasoningEfforts).toEqual([])
    const empty = buildChatRequest(
      baseOptions({ reasoningEffort: 'high' as never }),
      undefined,
      { reasoningEfforts: [], supportsImages: true },
    )
    expect(empty.reasoning_effort).toBeUndefined()
  })

  it('大小写与空白归一化后照样收敛', () => {
    expect(buildChatRequest(baseOptions({ reasoningEffort: ' HIGH ' as never }), undefined, FULL_ROUTE).reasoning_effort)
      .toBe('high')
  })
})

describe('思考回放', () => {
  it('reasoning_content 变成一个 reasoning block，与文本块分开', () => {
    const chunks = runStream([
      sse({ choices: [{ delta: { reasoning_content: '先看目录' } }] }),
      sse({ choices: [{ delta: { content: '答案' } }] }),
      sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      sse('[DONE]'),
    ])
    const starts = chunks.filter((c) => c.type === 'block-start')
    expect(starts.map((c) => (c as any).blockType)).toEqual(['reasoning', 'text'])

    const ends = chunks.filter((c) => c.type === 'block-end')
    expect(ends[0]!.block).toEqual({ type: 'reasoning', text: '先看目录' })
    expect(ends[1]!.block).toEqual({ type: 'text', text: '答案' })

    expect(chunks.filter((c) => c.type === 'reasoning-delta')).toHaveLength(1)
    expect(chunks.filter((c) => c.type === 'text-delta')).toHaveLength(1)
  })

  it('多段 reasoning_content 累积进同一个 block', () => {
    const chunks = runStream([
      sse({ choices: [{ delta: { reasoning_content: '一' } }] }),
      sse({ choices: [{ delta: { reasoning_content: '二' } }] }),
      sse('[DONE]'),
    ])
    expect(chunks.filter((c) => c.type === 'block-start')).toHaveLength(1)
    expect(chunks.filter((c) => c.type === 'reasoning-delta')).toHaveLength(2)
    const end = chunks.find((c) => c.type === 'block-end')!
    expect(end.block).toEqual({ type: 'reasoning', text: '一二' })
  })

  it('请求侧不回放 reasoning 块（端点不收没有签名的思考块）', () => {
    const body = buildChatRequest(baseOptions({
      messages: [
        userMessage([{ type: 'text', text: 'hi' }]),
        {
          id: 'm3',
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '上一轮的思考' },
            { type: 'text', text: '上一轮的答案' },
          ],
          source: { kind: 'assistant' },
        } as unknown as Message,
      ],
    }), undefined, FULL_ROUTE)
    const assistant = messagesOf(body).find((m) => m.role === 'assistant')!
    expect(assistant.content).toBe('上一轮的答案')
    expect(JSON.stringify(body)).not.toContain('上一轮的思考')
  })
})

describe('usage 顺序', () => {
  it('usage 排在 finish 之前', () => {
    const chunks = runStream([
      sse({ choices: [{ delta: { content: '答' } }] }),
      sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      sse({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 7 } }),
      sse('[DONE]'),
    ])
    const types = chunks.map((c) => c.type)
    expect(types.indexOf('usage')).toBeGreaterThan(-1)
    expect(types.indexOf('usage')).toBeLessThan(types.indexOf('finish'))
  })

  it('末帧同时带 usage 与 finish_reason 时，usage 仍然先入账并先发出', () => {
    const chunks = runStream([
      sse({ choices: [{ delta: { content: '答' } }] }),
      sse({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 2 } },
      }),
      sse('[DONE]'),
    ])
    const types = chunks.map((c) => c.type)
    expect(types.indexOf('usage')).toBeLessThan(types.indexOf('finish'))
    const usage = chunks.find((c) => c.type === 'usage')!
    expect(usage.usage).toEqual({ inputTokens: 12, outputTokens: 3, reasoningTokens: 2 })
  })

  it('缓存 token 从聚合的 prompt 数里减出来，两侧计数互斥', () => {
    const chunks = runStream([
      sse({
        choices: [{ delta: { content: 'x' } }],
        usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens: 5 },
      }),
      sse('[DONE]'),
    ])
    const usage = chunks.find((c) => c.type === 'usage')!
    expect(usage.usage).toEqual({ inputTokens: 60, outputTokens: 5, cacheReadTokens: 40 })
  })

  it('上游没给 usage 时不发 usage 块，也不编一个 0 出来', () => {
    const chunks = runStream([sse({ choices: [{ delta: { content: 'x' } }] }), sse('[DONE]')])
    expect(chunks.some((c) => c.type === 'usage')).toBe(false)
    expect(chunks[chunks.length - 1]!.type).toBe('finish')
  })
})

describe('工具调用与参数', () => {
  const ARG_PIECE_1 = '{"path":'
  const ARG_PIECE_2 = '"a\\u4e2d\\u6587.txt",'
  const ARG_PIECE_3 = '"n":1.10}'
  const EXPECTED_ARGS = ARG_PIECE_1 + ARG_PIECE_2 + ARG_PIECE_3

  it('工具参数按原始 JSON 字符串原样累加，一字不改', () => {
    const chunks = runStream([
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: ARG_PIECE_1 } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ARG_PIECE_2 } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ARG_PIECE_3 } }] } }] }),
      sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      sse('[DONE]'),
    ])
    const ends = chunks.filter((c) => c.type === 'block-end')
    expect(ends).toHaveLength(1)
    // 逐字节等于模型分片拼起来的原文：转义没被解、小数尾零没被抹、键序没被重排。
    expect((ends[0]!.block as any).arguments).toBe(EXPECTED_ARGS)
    expect(ends[0]!.block).toEqual({ type: 'tool-call', id: 'call_1', name: 'read_file', arguments: EXPECTED_ARGS })
  })

  it('分片拼接后的参数是一个合法 JSON，说明没有丢字符', () => {
    const chunks = runStream([
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{"a":' } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '[1,2]}' } }] } }] }),
      sse('[DONE]'),
    ])
    const end = chunks.find((c) => c.type === 'block-end')!
    expect(JSON.parse((end.block as any).arguments)).toEqual({ a: [1, 2] })
  })

  it('无参工具从开场那一帧起就算一次工具调用，收尾是 tool-calls', () => {
    const chunks = runStream([
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'list_dir' } }] } }] }),
      sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      sse('[DONE]'),
    ])
    expect(chunks.some((c) => c.type === 'block-start')).toBe(true)
    expect(chunks[chunks.length - 1]).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    const end = chunks.find((c) => c.type === 'block-end')!
    expect((end.block as any).arguments).toBe('{}')
  })

  it('并行工具调用按线上序号分别成块', () => {
    const chunks = runStream([
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'f', arguments: '{}' } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'g', arguments: '{}' } }] } }] }),
      sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      sse('[DONE]'),
    ])
    const ends = chunks.filter((c) => c.type === 'block-end')
    expect(ends.map((e) => (e.block as any).name)).toEqual(['f', 'g'])
  })

  it('回放的 assistant 工具调用保持参数字符串不变', () => {
    const raw = '{"path":"x\\u4e2d.txt"}'
    const body = buildChatRequest(baseOptions({
      messages: [
        userMessage([{ type: 'text', text: 'go' }]),
        {
          id: 'm3',
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'call_9', name: 'read_file', arguments: raw }],
          source: { kind: 'assistant' },
        } as unknown as Message,
      ],
    }), undefined, FULL_ROUTE)
    const assistant = messagesOf(body).find((m) => m.role === 'assistant')!
    const calls = assistant.tool_calls as Array<Record<string, any>>
    expect(calls[0].function.arguments).toBe(raw)
    expect(calls[0].id).toBe('call_9')
  })

  it('工具结果消息带 tool_call_id，且不与 user 消息交错', () => {
    const body = buildChatRequest(baseOptions({
      messages: [
        userMessage([{ type: 'text', text: 'go' }]),
        toolResultMessage('call_9', '文件内容'),
        toolResultMessage('call_10', '另一份'),
      ],
    }), undefined, FULL_ROUTE)
    const wire = messagesOf(body)
    expect(wire.map((m) => m.role)).toEqual(['user', 'tool', 'tool'])
    expect(wire[1]).toEqual({ role: 'tool', tool_call_id: 'call_9', content: '文件内容' })
    expect(wire[2]).toEqual({ role: 'tool', tool_call_id: 'call_10', content: '另一份' })
  })
})

describe('错误码分类', () => {
  it('从正文里读出平台的数字业务码', () => {
    expect(readGlmErrorCode('{"code":1302,"msg":"rate limited"}')).toBe(1302)
    expect(readGlmErrorCode('{"error":{"code":1214,"message":"bad"}}')).toBe(1214)
    expect(readGlmErrorCode('{"msg":"no code here"}')).toBeNull()
  })

  it('鉴权类一律是 AUTH：号池的鉴权出口用的就是它', () => {
    // src/host/common/account-pool.ts 的鉴权失败出口全部用 'AUTH'
    // （:635 / :710 / :715 / :749 / :839 / :845），W6 复用那份共享池，
    // 所以这就是「这个账号要重登」的判断键。换个同义码号池就认不出来了。
    expect(classifyGlmOpenAiFailure(401, '').code).toBe('AUTH')
    expect(classifyGlmOpenAiFailure(403, '').code).toBe('AUTH')
    for (const code of [ERROR_CODE.AUTH_MISSING, ERROR_CODE.AUTH_INVALID, ERROR_CODE.AUTH_EXPIRED]) {
      expect(classifyGlmOpenAiFailure(401, '{"code":' + code + '}').code).toBe('AUTH')
    }
  })

  it('套餐失效与单模型不在套餐内不是瞬时故障', () => {
    expect(classifyGlmOpenAiFailure(429, '{"code":' + ERROR_CODE.PLAN_EXPIRED + '}').code).toBe('PROVIDER_ERROR')
    expect(classifyGlmOpenAiFailure(429, '{"code":' + ERROR_CODE.MODEL_NOT_IN_PLAN + '}').code).toBe('PROVIDER_ERROR')
  })

  it('频率限制报 RATE_LIMIT，过载报 SERVER —— 两者都可重试但原因不同', () => {
    // 限流是「退避后可能成功」的限流；过载是服务端状况，不是限流。
    // 把过载混进 RATE_LIMIT 会让号池按限流去冷却账号，而过载根本不是某个账号的错。
    expect(classifyGlmOpenAiFailure(429, '{"code":' + ERROR_CODE.RATE_LIMITED + '}').code).toBe('RATE_LIMIT')
    expect(classifyGlmOpenAiFailure(429, '{"code":' + ERROR_CODE.OVERLOADED + '}').code).toBe('SERVER')
    expect(classifyGlmOpenAiFailure(429, '{"code":' + ERROR_CODE.OVERLOADED + '}').code).not.toBe('RATE_LIMIT')
  })

  it('额度类（NO_BALANCE / USAGE_LIMIT / PLAN_LIMIT）报 QUOTA，且不在可重试集合里', () => {
    const QUOTA_CODES = [ERROR_CODE.NO_BALANCE, ERROR_CODE.USAGE_LIMIT, ERROR_CODE.PLAN_LIMIT]
    for (const code of QUOTA_CODES) {
      expect(classifyGlmOpenAiFailure(429, '{"code":' + code + '}').code).toBe('QUOTA')
    }

    // 冻结 ERROR_CODE 表要求额度类**不可重试**：正文带着重置时刻，立即重试只会
    // 在已用尽的窗口上继续失败并多烧一次额度。这个性质由「QUOTA 不在下面这份
    // 可重试集合里」自动成立，所以把它钉死，而不是靠某处记得别重试。
    // 取值来自各线路 adapter 的 retryableCodes（minimax-code / kimi-code /
    // command-code 都是这一份）。
    const RETRYABLE_CODES = ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']
    expect(RETRYABLE_CODES).not.toContain('QUOTA')
    for (const code of QUOTA_CODES) {
      const emitted = classifyGlmOpenAiFailure(429, '{"code":' + code + '}').code
      expect(RETRYABLE_CODES).not.toContain(emitted)
    }
  })

  it('未知模型报 NOT_FOUND，调用方式不对仍报通用码', () => {
    // 未知模型 id 就是「这个资源不存在」，与其余线路的 404 同一个说法。
    expect(classifyGlmOpenAiFailure(400, '{"code":' + ERROR_CODE.UNKNOWN_MODEL + '}').code).toBe('NOT_FOUND')
    // 「该模型不提供这个调用方式」不同：模型是在的，缺的是这个入口，
    // 所以不是「找不到」，提示应指向目录里的协议声明。
    expect(classifyGlmOpenAiFailure(400, '{"code":' + ERROR_CODE.WRONG_METHOD + '}').code).toBe('PROVIDER_ERROR')
  })

  it('参数被拒报 INVALID_ARGS：不是 provider 故障，是本地请求构造有问题', () => {
    expect(classifyGlmOpenAiFailure(400, '{"code":' + ERROR_CODE.INVALID_PARAM + '}').code).toBe('INVALID_ARGS')
    expect(classifyGlmOpenAiFailure(400, '{"code":' + ERROR_CODE.MISSING_PARAM + '}').code).toBe('INVALID_ARGS')
    // 账号权限不足与内容过滤是账号/输入侧条件，保持通用码。
    expect(classifyGlmOpenAiFailure(403, '{"code":' + ERROR_CODE.NO_PERMISSION + '}').code).toBe('PROVIDER_ERROR')
    expect(classifyGlmOpenAiFailure(400, '{"code":' + ERROR_CODE.CONTENT_FILTERED + '}').code).toBe('PROVIDER_ERROR')
  })

  it('提示词超窗归到 harness 的上下文溢出码，便于压缩恢复', () => {
    expect(classifyGlmOpenAiFailure(400, '{"code":' + ERROR_CODE.PROMPT_TOO_LONG + '}').code)
      .toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('5xx 是 SERVER，其余是 PROVIDER_ERROR', () => {
    expect(classifyGlmOpenAiFailure(503, '').code).toBe('SERVER')
    expect(classifyGlmOpenAiFailure(400, 'bad request').code).toBe('PROVIDER_ERROR')
  })

  it('retry-after 被读成 providerRetryAfterMs（与裸 429 判成什么码无关）', () => {
    // 这条只管「响应头被读到并下发」这一件事。两者曾经被绑在同一处断言里，
    // 于是改码必须连带改这条断言，而那正是掩盖行为变更的入口。
    // LlmError 把这些可序列化事实挂在 .failure 上，供重试策略读取。
    const limited = classifyGlmOpenAiFailure(
      429,
      '{"code":' + ERROR_CODE.RATE_LIMITED + '}',
      new Headers({ 'retry-after': '30' }),
    )
    expect(limited.failure.providerRetryAfterMs).toBe(30_000)
    // 同一个头在裸 429 上照样读得到：它是真实存在的响应头，上游常拿它当重置提示，
    // 界面上「N 秒后再试」比「未知错误」有用得多。它不改变本次的不可重试判定。
    const bare = classifyGlmOpenAiFailure(429, '', new Headers({ 'retry-after': '30' }))
    expect(bare.failure.providerRetryAfterMs).toBe(30_000)
    // 没有这个头时就没有这个字段，不编一个默认值出来。
    expect(classifyGlmOpenAiFailure(429, '{"code":' + ERROR_CODE.RATE_LIMITED + '}').failure.providerRetryAfterMs)
      .toBeUndefined()
  })

  it('裸 429（正文无业务码）不可重试：先验 5:2 偏向额度类', () => {
    // 冻结 ERROR_CODE 表里 429 共 7 条，只有 2 条可重试（RATE_LIMITED 1302 /
    // OVERLOADED 1305），其余 5 条全是额度类。所以缺业务码时默认不可重试：
    // 把真实原因报给用户，而不是赌它是限流后进入退避重试——赌错会在已用尽的窗口上
    // 反复失败并多烧额度。与 Anthropic 面（mapper-anthropic.ts）一致。
    const bare = classifyGlmOpenAiFailure(429, '')
    expect(bare.code).toBe('PROVIDER_ERROR')
    expect(bare.code).not.toBe('RATE_LIMIT')
    const RETRYABLE_CODES = ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']
    expect(RETRYABLE_CODES).not.toContain(bare.code)

    // 带了业务码就不一样：1302 是真正的限流，1305 是真正的过载，两者都可重试。
    expect(classifyGlmOpenAiFailure(429, '{"code":' + ERROR_CODE.RATE_LIMITED + '}').code).toBe('RATE_LIMIT')
    expect(classifyGlmOpenAiFailure(429, '{"code":' + ERROR_CODE.OVERLOADED + '}').code).toBe('SERVER')
  })

  it('流内错误帧不会当成干净收尾，且带上业务码', () => {
    const state = createStreamState()
    processStreamLine(sse({ choices: [{ delta: { content: '半句' } }] }), state)
    const feed = () => processStreamLine(sse({ error: { code: 1302, message: '限流' } }), state)
    expect(feed).toThrow(LlmError)
    try {
      feed()
    } catch (error) {
      expect((error as LlmError).message).toContain('1302')
      expect((error as LlmError).message).toContain('限流')
    }
  })
})

describe('收尾与截断', () => {
  it('有 [DONE] 的流是完整的', () => {
    const state = createStreamState()
    processStreamLine(sse({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }), state)
    processStreamLine(sse('[DONE]'), state)
    expect(() => assertStreamComplete(state)).not.toThrow()
  })

  it('没有终局事件的流是截断，必须报错而不是当成答完', () => {
    const state = createStreamState()
    processStreamLine(sse({ choices: [{ delta: { content: '半句' } }] }), state)
    expect(() => assertStreamComplete(state)).toThrow(LlmError)
  })

  it('finish_reason: length 结算成 max-tokens', () => {
    const chunks = runStream([
      sse({ choices: [{ delta: { content: 'x' } }] }),
      sse({ choices: [{ delta: {}, finish_reason: 'length' }] }),
      sse('[DONE]'),
    ])
    expect(chunks[chunks.length - 1]).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('终局块只发一次，重复 closeStream 是空操作', () => {
    const state = createStreamState()
    processStreamLine(sse({ choices: [{ delta: { content: 'x' } }] }), state)
    const first = closeStream(state)
    expect(first.some((c) => c.type === 'finish')).toBe(true)
    expect(closeStream(state)).toEqual([])
  })
})

describe('图片预算', () => {
  it('没超预算时原样返回同一个对象', () => {
    const options = baseOptions({ messages: [userMessage([{ type: 'text', text: 'hi' }])] })
    expect(offloadOldestRequestImages(options)).toBe(options)
  })

  it('超预算时换成占位文本而不是丢掉整条消息', () => {
    const big = 'A'.repeat(MAX_REQUEST_IMAGE_BYTES + 10)
    const options = baseOptions({
      messages: [userMessage([
        { type: 'image', data: big, mimeType: 'image/png' },
        { type: 'text', text: '看看这张' },
      ])],
    })
    const replaced = offloadOldestRequestImages(options)
    const content = replaced.messages[0]!.content as any[]
    expect(content[0]).toEqual({ type: 'text', text: expect.stringContaining('image omitted') })
    expect(content[1]).toEqual({ type: 'text', text: '看看这张' })
    // 持久历史不动，只改即将发出的那一份请求。
    expect((options.messages[0]!.content as any[])[0]).toHaveProperty('data')
  })

  it('目录声明不收图的模型，请求里不会出现 image_url', () => {
    const options = baseOptions({
      messages: [userMessage([
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'text', text: '这张' },
      ])],
    })
    const body = buildChatRequest(options, undefined, TWO_STEP_ROUTE)
    expect(JSON.stringify(body)).not.toContain('image_url')
    expect(JSON.stringify(body)).toContain('image unavailable')
  })
})
