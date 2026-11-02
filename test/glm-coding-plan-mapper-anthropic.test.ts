/**
 * W3a：GLM（ZCode 账号）线路 Anthropic Messages 面映射的离线测试。
 *
 * 全部离线：不发任何请求、不读任何凭据、不依赖网络。SSE 载荷是手写的脱敏 fixture，
 * 形状照 Anthropic Messages 公开协议写，本线路网关的具体发包形状属于未验证项（见
 * `src/host/glm-coding-plan/mapper-anthropic.ts` 文件头）。
 */
import { describe, expect, it } from 'vitest'
import type { GenerateOptions, Message, StreamChunk } from '../src/host/common/llm-compat.ts'
import {
  GLM_ANTHROPIC_VERSION,
  UNSUPPORTED_OPTION_CODE,
  assertGlmStreamComplete,
  buildGlmAnthropicRequest,
  classifyGlmUpstreamError,
  closeGlmAnthropicStream,
  createGlmAnthropicStreamState,
  glmAnthropicHeaders,
  glmAnthropicMarkCacheBreakpoint,
  glmAnthropicUrl,
  glmEffortForLadder,
  glmStreamHasContent,
  glmThinkingControl,
  glmUpstreamError,
  processGlmAnthropicStreamLine,
} from '../src/host/glm-coding-plan/mapper-anthropic.ts'
import { ERROR_CODE, GLM_CODING_EFFORTS } from '../src/host/glm-coding-plan/types.ts'
import { CONTEXT_OVERFLOW_CODE } from '../src/host/common/context-overflow.ts'

/** 线路级词汇表（`types.ts` 重导出共享契约那一份，这里不另写字面量）。 */
const LADDER = [...GLM_CODING_EFFORTS]

/** `convergeGlmEffort` 内部的跨表排名，用来断言「没有越档升高」。 */
const RANK: Readonly<Record<string, number>> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
}

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'glm-coding-plan',
    model: 'glm-5.3',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '你好' }] } as Message,
    ],
    ...overrides,
  } as GenerateOptions
}

/** 一行 SSE：`data:` 前缀 + JSON 载荷。 */
function line(payload: Record<string, unknown>): string {
  return 'data: ' + JSON.stringify(payload)
}

/** 把一串事件喂进状态，返回全程的 DSH 块。 */
function run(lines: readonly string[]): StreamChunk[] {
  const state = createGlmAnthropicStreamState()
  const chunks = lines.flatMap((entry) => processGlmAnthropicStreamLine(entry, state))
  expect(() => assertGlmStreamComplete(state)).not.toThrow()
  return chunks
}

describe('端点', () => {
  it('国际区打在 api.z.ai 的 Anthropic 兼容面前缀下', () => {
    expect(glmAnthropicUrl('intl')).toBe('https://api.z.ai/api/anthropic/v1/messages')
  })

  it('国区打在 open.bigmodel.cn 的同一前缀下', () => {
    expect(glmAnthropicUrl('cn')).toBe('https://open.bigmodel.cn/api/anthropic/v1/messages')
  })

  it('DSH_GLM_*_API_HOST 覆盖生效，且尾部斜杠被去掉', () => {
    expect(glmAnthropicUrl('cn', { DSH_GLM_CN_API_HOST: 'https://proxy.example/base/' }))
      .toBe('https://proxy.example/base/api/anthropic/v1/messages')
  })
})

describe('认证头是双头且同值', () => {
  const key = 'id-abc.secret-xyz'

  it('同时带 x-api-key 与 Authorization: Bearer，且是同一个值', () => {
    // 官方源码逐字：Anthropic 兼容网关会同时读取 x-api-key 和 Bearer Authorization
    // （model/model-execution.ts:425-437）。少一个就是 401 AUTH_MISSING(1001)。
    const headers = glmAnthropicHeaders(key)
    expect(headers['x-api-key']).toBe(key)
    expect(headers.authorization).toBe('Bearer ' + key)
    expect(headers.authorization).toBe('Bearer ' + headers['x-api-key'])
  })

  it('带协议版本头与流式 accept', () => {
    const headers = glmAnthropicHeaders(key)
    expect(headers['anthropic-version']).toBe(GLM_ANTHROPIC_VERSION)
    expect(headers.accept).toBe('text/event-stream')
    expect(headers['content-type']).toBe('application/json')
  })

  it('extra 不能把双头拆开或改值', () => {
    const headers = glmAnthropicHeaders(key, { 'x-api-key': 'other', authorization: 'Bearer other' })
    expect(headers['x-api-key']).toBe(key)
    expect(headers.authorization).toBe('Bearer ' + key)
  })

  it('空凭据直接抛 AUTH，而不是发出一个注定 401 的请求', () => {
    expect(() => glmAnthropicHeaders('   ')).toThrowError()
    try {
      glmAnthropicHeaders('')
      expect.unreachable('空凭据必须抛错')
    } catch (error) {
      expect((error as { code: string }).code).toBe('AUTH')
    }
  })
})

describe('思考档位跨两套词汇表收敛', () => {
  it('词汇表内的三档原样通过', () => {
    for (const effort of LADDER) {
      expect(glmEffortForLadder(LADDER, effort)).toBe(effort)
    }
  })

  it('越档反例：minimal 收敛到 low，绝不被抬成 high', () => {
    // 本仓库记录过的 bug：只排 low/high/max 时 minimal 属于「未识别」，
    // 未识别一律落中档，于是 minimal 被发成 high——想得更久还多计费。
    expect(glmEffortForLadder(LADDER, 'minimal')).toBe('low')
    expect(glmEffortForLadder(LADDER, 'minimal')).not.toBe('high')
  })

  it('none 在不支持关闭思考的模型上收敛到最低档（GLM-5.3 家族）', () => {
    // 官方规则集里 .*glm-5\.3.* 的 reasoningLevel.values 是 ["low","high","max"]，
    // 没有 disabled——所以这一族收到 none 时只能收敛到 low，不能变成「关闭」。
    expect(glmEffortForLadder(LADDER, 'none')).toBe('low')
    expect(RANK[glmEffortForLadder(LADDER, 'none')!]).toBeLessThanOrEqual(RANK['low']!)
  })

  it('medium / xhigh 落在平手向上取整的那一档，且不越过梯子顶端', () => {
    expect(glmEffortForLadder(LADDER, 'medium')).toBe('high')
    expect(glmEffortForLadder(LADDER, 'xhigh')).toBe('max')
    for (const effort of ['medium', 'xhigh', 'ultra']) {
      const converged = glmEffortForLadder(LADDER, effort)!
      expect(LADDER).toContain(converged)
      expect(RANK[converged]!).toBeLessThanOrEqual(RANK['max']!)
    }
  })

  it('未识别的档位落中档，且不低于 low', () => {
    expect(glmEffortForLadder(LADDER, 'ultra')).toBe('high')
    expect(RANK[glmEffortForLadder(LADDER, 'ultra')!]).toBeGreaterThanOrEqual(RANK['low']!)
  })

  it('收敛只能落在模型真实梯子上：两档模型把 xhigh 收到 high', () => {
    const twoStep = ['low', 'high']
    expect(glmEffortForLadder(twoStep, 'xhigh')).toBe('high')
    expect(glmEffortForLadder(twoStep, 'max')).toBe('high')
    expect(glmEffortForLadder(twoStep, 'minimal')).toBe('low')
  })

  it('梯子为空 → 不发档位字段（而不是发一个模型不认的值）', () => {
    expect(glmEffortForLadder([], 'minimal')).toBeNull()
    expect(glmEffortForLadder([], 'high')).toBeNull()
  })

  it('调用方没指定档位 → 不发档位字段，交给服务端默认', () => {
    expect(glmEffortForLadder(LADDER, null)).toBeNull()
    expect(glmEffortForLadder(LADDER, undefined)).toBeNull()
  })

  it('思考控制在不支持关闭思考的模型上恒开，档位走 output_config.effort', () => {
    // 官方 .*glm-5\.3.* 的 map 逐字：
    //   {"thinking":{"type":"enabled"},"output_config":{"effort": reasoningLevel}}
    const control = glmThinkingControl(LADDER, 'minimal')
    expect(control.thinking).toBe(true)
    expect(control.fields.thinking).toEqual({ type: 'enabled' })
    expect(control.fields.output_config).toEqual({ effort: 'low' })
    // 顶层 reasoning_effort 不再出现：官方全仓零命中。
    expect(control.fields.reasoning_effort).toBeUndefined()
    expect(JSON.stringify(control.fields)).not.toContain('disabled')
  })

  it('sendReasoningEffort=false 时只留 thinking，不发档位', () => {
    const control = glmThinkingControl(LADDER, 'high', false)
    expect(control.fields.output_config).toBeUndefined()
    expect(control.fields.reasoning_effort).toBeUndefined()
    expect(control.fields.thinking).toEqual({ type: 'enabled' })
  })

  it('梯子为空的模型既没有思考控制也不发档位', () => {
    const control = glmThinkingControl([], 'high')
    expect(control.thinking).toBe(false)
    expect(control.fields).toEqual({})
  })
})

describe('请求体投影', () => {
  it('模型 id 逐字下发，映射层不得替换', () => {
    // 两区模型 id 不一致（计划 R8）；目录给了什么就发什么。
    const body = buildGlmAnthropicRequest(options({ model: 'glm-5.3-flash' }), { ladder: LADDER })
    expect(body.model).toBe('glm-5.3-flash')
    const unknown = buildGlmAnthropicRequest(options({ model: 'glm-9.9-experimental' }), { ladder: LADDER })
    expect(unknown.model).toBe('glm-9.9-experimental')
  })

  it('要流式响应，否则端点回的是一次性 JSON', () => {
    expect(buildGlmAnthropicRequest(options(), { ladder: LADDER })).toMatchObject({ stream: true })
  })

  it('档位以收敛后的值进 output_config，且不发顶层 reasoning_effort', () => {
    const body = buildGlmAnthropicRequest(
      options({ reasoningEffort: 'minimal' as never }),
      { ladder: LADDER },
    )
    expect(body.output_config).toEqual({ effort: 'low' })
    expect(body.reasoning_effort).toBeUndefined()
    expect(body.thinking).toEqual({ type: 'enabled' })
  })

  it('工具声明走 input_schema', () => {
    const body = buildGlmAnthropicRequest(options({
      tools: [{ name: 'read', description: '读文件', parameters: { type: 'object', properties: {} } }],
    }), { ladder: LADDER })
    const tools = body.tools as Array<Record<string, unknown>>
    expect(tools[0]).toMatchObject({ name: 'read', description: '读文件' })
    expect(tools[0]!.input_schema).toMatchObject({ type: 'object' })
  })

  it('思考开启时指定 temperature 抛 UNSUPPORTED_OPTION，不静默丢掉', () => {
    try {
      buildGlmAnthropicRequest(options({ temperature: 0.3 }), { ladder: LADDER })
      expect.unreachable('思考开启时 temperature 必须被拒绝')
    } catch (error) {
      expect((error as { code: string }).code).toBe(UNSUPPORTED_OPTION_CODE)
    }
  })

  it('该模型不接受思考档位时 temperature 照常下发', () => {
    const body = buildGlmAnthropicRequest(options({ temperature: 0.3 }), { ladder: [] })
    expect(body.temperature).toBe(0.3)
    expect(body.thinking).toBeUndefined()
  })

  it('声明 deferLoading 的工具抛 UNSUPPORTED_OPTION', () => {
    try {
      buildGlmAnthropicRequest(options({
        tools: [{ name: 'grep', description: 'd', parameters: {}, deferLoading: true }],
      }), { ladder: LADDER })
      expect.unreachable('deferLoading 必须被拒绝')
    } catch (error) {
      expect((error as { code: string }).code).toBe(UNSUPPORTED_OPTION_CODE)
    }
  })

  it('历史里的会话中途增减工具抛 UNSUPPORTED_OPTION', () => {
    for (const block of [{ type: 'tool-addition', toolName: 'grep' }, { type: 'tool-removal', toolName: 'grep' }]) {
      try {
        buildGlmAnthropicRequest(
          options({ messages: [{ role: 'user', content: [block] } as unknown as Message] }),
          { ladder: LADDER },
        )
        expect.unreachable('会话中途增减工具必须被拒绝')
      } catch (error) {
        expect((error as { code: string }).code).toBe(UNSUPPORTED_OPTION_CODE)
      }
    }
  })

  it('工具结果被投影成 user 轮的 tool_result', () => {
    const body = buildGlmAnthropicRequest(options({
      messages: [
        { role: 'assistant', content: [{ type: 'tool-call', id: 'toolu_1', name: 'read', arguments: '{"p":"a"}' }] } as Message,
        {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'toolu_1', content: [{ type: 'text', text: 'ok' }] }],
          source: { kind: 'tool' },
        } as unknown as Message,
      ],
    }), { ladder: LADDER })
    const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
    expect(messages[0]!.content[0]).toMatchObject({ type: 'tool_use', id: 'toolu_1', name: 'read', input: { p: 'a' } })
    expect(messages[1]).toMatchObject({ role: 'user' })
    expect(messages[1]!.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' })
  })
})

describe('流式响应：思考 / 文本 / 工具各占各的块', () => {
  const THREE_BLOCKS = [
    line({ type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 0 } } }),
    line({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
    line({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先想一下' } }),
    line({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } }),
    line({ type: 'content_block_stop', index: 0 }),
    line({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
    line({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '答案是 42' } }),
    line({ type: 'content_block_stop', index: 1 }),
    line({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_9', name: 'read' } }),
    line({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } }),
    line({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"a.txt"}' } }),
    line({ type: 'content_block_stop', index: 2 }),
    line({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 21 } }),
    line({ type: 'message_stop' }),
  ]

  it('三个块各占各的下标，思考与正文互不串块', () => {
    const chunks = run(THREE_BLOCKS)
    expect(chunks).toContainEqual({ type: 'block-start', index: 0, blockType: 'reasoning' })
    expect(chunks).toContainEqual({ type: 'block-start', index: 1, blockType: 'text' })
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'block-start', index: 2, blockType: 'tool-call' }))
    expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 0, text: '先想一下' })
    expect(chunks).toContainEqual({ type: 'text-delta', index: 1, text: '答案是 42' })
    // 思考文本没有漏进正文块，正文也没有漏进思考块。
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'reasoning', text: '先想一下' } })
    expect(chunks).toContainEqual({ type: 'block-end', index: 1, block: { type: 'text', text: '答案是 42' } })
  })

  it('工具参数是模型产出的原始 JSON 串', () => {
    const chunks = run(THREE_BLOCKS)
    expect(chunks).toContainEqual(expect.objectContaining({
      type: 'tool-call-delta',
      index: 2,
      argumentsDelta: '{"path":',
    }))
    expect(chunks).toContainEqual(expect.objectContaining({
      type: 'block-end',
      index: 2,
      block: expect.objectContaining({ name: 'read', arguments: '{"path":"a.txt"}' }),
    }))
  })

  it('参数片断逐字拼接：不重排键、不去空白', () => {
    const chunks = run([
      line({ type: 'message_start', message: { usage: {} } }),
      line({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'w' } }),
      line({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"b": 1,' } }),
      line({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '\n "a": 2}' } }),
      line({ type: 'content_block_stop', index: 0 }),
      line({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }),
      line({ type: 'message_stop' }),
    ])
    expect(chunks).toContainEqual(expect.objectContaining({
      type: 'block-end',
      index: 0,
      block: expect.objectContaining({ arguments: '{"b": 1,\n "a": 2}' }),
    }))
  })

  it('解析不了的参数原样交出去，不被替换成 {}', () => {
    const chunks = run([
      line({ type: 'message_start', message: { usage: {} } }),
      line({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'w' } }),
      line({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } }),
      line({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'undefined' } }),
      line({ type: 'content_block_stop', index: 0 }),
      line({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }),
      line({ type: 'message_stop' }),
    ])
    expect(chunks).toContainEqual(expect.objectContaining({
      type: 'block-end',
      index: 0,
      block: expect.objectContaining({ arguments: '{"a":undefined' }),
    }))
  })

  it('thinking_delta 与 reasoning_content 两种思考词汇都进思考块', () => {
    const chunks = run([
      line({ type: 'message_start', message: { usage: {} } }),
      line({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
      line({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '正文' } }),
      line({ type: 'content_block_stop', index: 0 }),
      line({ type: 'content_block_start', index: 1, content_block: { type: 'thinking' } }),
      line({ type: 'content_block_delta', index: 1, delta: { reasoning_content: '想的内容' } }),
      line({ type: 'content_block_stop', index: 1 }),
      line({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }),
      line({ type: 'message_stop' }),
    ])
    expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 1, text: '想的内容' })
    expect(chunks).toContainEqual({ type: 'block-end', index: 1, block: { type: 'reasoning', text: '想的内容' } })
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: '正文' } })
  })

  it('没有对应 thinking 块的 reasoning_content 惰性开块，不并进正文', () => {
    const chunks = run([
      line({ type: 'message_start', message: { usage: {} } }),
      line({ type: 'content_block_delta', index: 0, delta: { reasoning_content: '裸思考' } }),
      line({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '正文' } }),
      line({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }),
      line({ type: 'message_stop' }),
    ])
    expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 0, text: '裸思考' })
    expect(chunks).toContainEqual({ type: 'text-delta', index: 1, text: '正文' })
    expect(chunks).toContainEqual({ type: 'block-end', index: 1, block: { type: 'text', text: '正文' } })
  })

  it('流里有内容', () => {
    const state = createGlmAnthropicStreamState()
    for (const entry of THREE_BLOCKS) processGlmAnthropicStreamLine(entry, state)
    expect(glmStreamHasContent(state)).toBe(true)
  })
})

describe('usage 在 finish 之前，finish 之后不再有块', () => {
  const STREAM = [
    line({ type: 'message_start', message: { usage: { input_tokens: 30, cache_read_input_tokens: 8 } } }),
    line({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    line({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } }),
    line({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } }),
    line({ type: 'message_stop' }),
  ]

  it('usage 排在 finish 前一行，且 finish 是最后一块', () => {
    const chunks = run(STREAM)
    const usageAt = chunks.findIndex((chunk) => chunk.type === 'usage')
    const finishAt = chunks.findIndex((chunk) => chunk.type === 'finish')
    expect(usageAt).toBeGreaterThan(-1)
    expect(finishAt).toBeGreaterThan(usageAt)
    expect(finishAt).toBe(chunks.length - 1)
  })

  it('三个计数不相交：缓存命中不进 inputTokens', () => {
    const chunks = run(STREAM)
    expect(chunks).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 30, outputTokens: 6, cacheReadTokens: 8 },
    })
  })

  it('finish 之后再喂任何行都不产生块', () => {
    const state = createGlmAnthropicStreamState()
    for (const entry of STREAM) processGlmAnthropicStreamLine(entry, state)
    expect(processGlmAnthropicStreamLine(
      line({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '迟到' } }),
      state,
    )).toEqual([])
    expect(closeGlmAnthropicStream(state)).toEqual([])
  })

  it('没有 usage 就不发 usage 块（零值 usage 是谎报）', () => {
    const chunks = run([
      // message_start 连 usage 对象都没给：这条流从头到尾没有任何计数。
      line({ type: 'message_start', message: { id: 'msg_1', role: 'assistant' } }),
      line({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
      line({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } }),
      line({ type: 'message_stop' }),
    ])
    expect(chunks.some((chunk) => chunk.type === 'usage')).toBe(false)
    expect(chunks.at(-1)?.type).toBe('finish')
  })

  it('流没走到终止事件就断掉时报错，而不是当成一次干净结束', () => {
    const state = createGlmAnthropicStreamState()
    for (const entry of STREAM.slice(0, 3)) processGlmAnthropicStreamLine(entry, state)
    expect(() => assertGlmStreamComplete(state)).toThrowError()
  })

  it('max_tokens 优先于 tool-calls：被截断的回答会被装配器丢掉工具调用', () => {
    const chunks = run([
      line({ type: 'message_start', message: { usage: {} } }),
      line({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'w' } }),
      line({ type: 'content_block_stop', index: 0 }),
      line({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 2 } }),
      line({ type: 'message_stop' }),
    ])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })
})

describe('官方对齐：effort 出口与逐模型关思考', () => {
  /** GLM-5.2 在官方规则集里的 reasoningLevel.values：["disabled","high","max"]。 */
  const LADDER_52 = ['high', 'max']

  it('GLM-5.3 家族恒开，档位只出现在 output_config', () => {
    const body = buildGlmAnthropicRequest(
      options({ reasoningEffort: 'high' as never }),
      { ladder: LADDER, thinkingDisableable: false },
    )
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.output_config).toEqual({ effort: 'high' })
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('GLM-5.2 关思考时只发 thinking.type: disabled，不带 output_config', () => {
    // 官方 .*GLM-5\.2.* 的 map：disabled 分支里没有 output_config。
    const body = buildGlmAnthropicRequest(
      options({ reasoningEffort: 'none' as never }),
      { ladder: LADDER_52, thinkingDisableable: true },
    )
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.output_config).toBeUndefined()
  })

  it('GLM-5.2 开思考时发 thinking.type: enabled + output_config.effort', () => {
    const body = buildGlmAnthropicRequest(
      options({ reasoningEffort: 'max' as never }),
      { ladder: LADDER_52, thinkingDisableable: true },
    )
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.output_config).toEqual({ effort: 'max' })
  })

  it('不声明可关的模型收到 none 时不发 disabled（仍收敛到最低档）', () => {
    // 官方 .*glm-5\.3.* 的 map 没有 disabled 分支：发 disabled 会被上游当错误拒。
    const body = buildGlmAnthropicRequest(
      options({ reasoningEffort: 'none' as never }),
      { ladder: LADDER, thinkingDisableable: false },
    )
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.output_config).toEqual({ effort: 'low' })
    expect(JSON.stringify(body)).not.toContain('disabled')
  })

  it('GLM-5-Turbo（无档位梯子）关思考时只发 disabled', () => {
    // 官方 .*GLM-5-Turbo.* 的 reasoningLevel.values 是 ["disabled","enabled"]：开关型。
    const body = buildGlmAnthropicRequest(
      options({ reasoningEffort: 'none' as never }),
      { ladder: [], thinkingDisableable: true },
    )
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.output_config).toBeUndefined()
  })

  it('关思考时 temperature 照常下发（Anthropic 只在思考开启时排斥它）', () => {
    const body = buildGlmAnthropicRequest(
      options({ reasoningEffort: 'none' as never, temperature: 0.3 }),
      { ladder: LADDER_52, thinkingDisableable: true },
    )
    expect(body.temperature).toBe(0.3)
  })

  it('思考开启时 temperature 仍然被拒（互斥关系没被放松）', () => {
    try {
      buildGlmAnthropicRequest(
        options({ reasoningEffort: 'high' as never, temperature: 0.3 }),
        { ladder: LADDER_52, thinkingDisableable: true },
      )
      expect.unreachable('思考开启时 temperature 必须被拒绝')
    } catch (error) {
      expect((error as { code: string }).code).toBe(UNSUPPORTED_OPTION_CODE)
    }
  })
})

describe('官方对齐：system 块数组与缓存断点', () => {
  it('system 走块数组，末块带 cache_control: ephemeral', () => {
    const body = buildGlmAnthropicRequest(
      options({
        system: '顶层提示词',
        messages: [
          { role: 'system', content: [{ type: 'text', text: '历史提示词' }] } as Message,
          { role: 'user', content: [{ type: 'text', text: '你好' }] } as Message,
        ],
      }),
      { ladder: LADDER },
    )
    const system = body.system as Array<Record<string, unknown>>
    expect(Array.isArray(system)).toBe(true)
    expect(system).toHaveLength(2)
    expect(system[0]).toEqual({ type: 'text', text: '顶层提示词\n\n' })
    expect(system[1]).toEqual({
      type: 'text',
      text: '历史提示词',
      cache_control: { type: 'ephemeral' },
    })
    // 只换形状不换内容：各块文字拼起来与旧的单字符串逐字相同。
    expect(system.map((block) => String(block.text)).join('')).toBe('顶层提示词\n\n历史提示词')
  })

  it('空 system 贡献不产块，整条字段省略', () => {
    const body = buildGlmAnthropicRequest(
      options({
        system: '   ',
        messages: [
          { role: 'system', content: [{ type: 'text', text: '' }] } as Message,
          { role: 'user', content: [{ type: 'text', text: '你好' }] } as Message,
        ],
      }),
      { ladder: LADDER },
    )
    expect(body.system).toBeUndefined()
  })

  it('最新一条非 system 消息的末块带缓存断点，更早的消息不带', () => {
    const body = buildGlmAnthropicRequest(
      options({
        messages: [
          { role: 'user', content: [{ type: 'text', text: '第一问' }] } as Message,
          { role: 'assistant', content: [{ type: 'text', text: '回答' }] } as Message,
          { role: 'user', content: [{ type: 'text', text: '第二问' }] } as Message,
        ],
      }),
      { ladder: LADDER },
    )
    const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
    expect(messages).toHaveLength(3)
    expect(messages[0]!.content[0]!.cache_control).toBeUndefined()
    expect(messages[1]!.content[0]!.cache_control).toBeUndefined()
    expect(messages[2]!.content[0]!.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('工具结果块是可缓存块，断点落在它上面', () => {
    const body = buildGlmAnthropicRequest(
      options({
        messages: [
          { role: 'assistant', content: [{ type: 'tool-call', id: 'toolu_1', name: 'read', arguments: '{}' }] } as Message,
          {
            role: 'user',
            content: [{ type: 'tool-result', toolCallId: 'toolu_1', content: [{ type: 'text', text: 'ok' }] }],
            source: { kind: 'tool' },
          } as unknown as Message,
        ],
      }),
      { ladder: LADDER },
    )
    const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
    expect(messages[1]!.content[0]!.type).toBe('tool_result')
    expect(messages[1]!.content[0]!.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('空块不带断点，断点前移到最后一个可缓存块', () => {
    const marked = glmAnthropicMarkCacheBreakpoint([
      { type: 'text', text: '有内容' },
      { type: 'text', text: '' },
    ])
    expect(marked[0]!.cache_control).toEqual({ type: 'ephemeral' })
    expect(marked[1]!.cache_control).toBeUndefined()
  })

  it('一个可缓存块都没有时不动内容', () => {
    const marked = glmAnthropicMarkCacheBreakpoint([{ type: 'text', text: '' }])
    expect(marked).toEqual([{ type: 'text', text: '' }])
    expect(marked[0]!.cache_control).toBeUndefined()
  })
})

describe('业务错误码分类（ERROR_CODE 表）', () => {
  it('可重试集合与官方客户端的业务码表一致', () => {
    // 官方（zai-org/ZCode 的 failure-provider-business-codes.ts）把 1302/1303/1305
    // 与两条 500 恢复类判成可恢复，其余业务码一律终局。
    const retryable = new Set([
      'RATE_LIMITED',
      'RATE_LIMIT_TRANSIENT',
      'OVERLOADED',
      'OVERLOADED_BUSINESS',
      'API_CALL_FAILED',
      'API_CALL_ERROR',
      'NETWORK_ERROR',
    ])
    for (const [name, code] of Object.entries(ERROR_CODE)) {
      const verdict = classifyGlmUpstreamError({ status: 429, body: { code, message: name } })
      expect({ name, retryable: verdict.retryable }).toEqual({ name, retryable: retryable.has(name) })
    }
  })

  it('llmCode 与可重试性一致：不可重试的一律不在重试集合里', () => {
    // 宿主按 LlmError.code 判可重试（重试集合见 src/host/glm-coding-plan/adapter.ts），
    // 所以判「不可重试」的码绝不能落在 RATE_LIMIT / SERVER 上。
    const retryableCodes = new Set(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])
    for (const [name, code] of Object.entries(ERROR_CODE)) {
      const verdict = classifyGlmUpstreamError({ status: 429, body: { code, message: name } })
      expect({ name, inRetrySet: retryableCodes.has(verdict.llmCode) }).toEqual({
        name,
        inRetrySet: verdict.retryable,
      })
    }
  })

  it('1303 是可重试的限流', () => {
    const verdict = classifyGlmUpstreamError({ status: 429, body: { code: ERROR_CODE.RATE_LIMIT_TRANSIENT } })
    expect(verdict.llmCode).toBe('RATE_LIMIT')
    expect(verdict.retryable).toBe(true)
  })

  it('1312 是可重试的过载', () => {
    const verdict = classifyGlmUpstreamError({ status: 429, body: { code: ERROR_CODE.OVERLOADED_BUSINESS } })
    expect(verdict.llmCode).toBe('SERVER')
    expect(verdict.retryable).toBe(true)
  })

  it('1304 / 1313 是终局的限流类：不可重试，也不落进重试集合', () => {
    for (const code of [ERROR_CODE.RATE_LIMIT_BLOCKED, ERROR_CODE.FAIR_USE_LIMITED]) {
      const verdict = classifyGlmUpstreamError({ status: 429, body: { code } })
      expect(verdict.retryable).toBe(false)
      expect(verdict.llmCode).not.toBe('RATE_LIMIT')
      expect(verdict.llmCode).not.toBe('SERVER')
    }
  })

  it('1316–1321 是额度类终局，等窗口重置而不是重试', () => {
    for (const code of [
      ERROR_CODE.USAGE_LIMIT_5H,
      ERROR_CODE.USAGE_LIMIT_7D,
      ERROR_CODE.USAGE_LIMIT_5H_SPEND_LIMIT,
      ERROR_CODE.USAGE_LIMIT_7D_SPEND_LIMIT,
      ERROR_CODE.EXTRA_USAGE_UNAVAILABLE_5H,
      ERROR_CODE.EXTRA_USAGE_UNAVAILABLE_7D,
    ]) {
      const verdict = classifyGlmUpstreamError({ status: 429, body: { code } })
      expect(verdict.llmCode).toBe('QUOTA')
      expect(verdict.retryable).toBe(false)
    }
  })

  it('1230 / 1234 是可重试的 500 恢复类', () => {
    for (const code of [ERROR_CODE.API_CALL_ERROR, ERROR_CODE.NETWORK_ERROR]) {
      const verdict = classifyGlmUpstreamError({ status: 500, body: { code } })
      expect(verdict.llmCode).toBe('SERVER')
      expect(verdict.retryable).toBe(true)
    }
  })

  it('401 三条都归 AUTH 且不可重试', () => {
    for (const code of [ERROR_CODE.AUTH_MISSING, ERROR_CODE.AUTH_INVALID, ERROR_CODE.AUTH_EXPIRED]) {
      const verdict = classifyGlmUpstreamError({ status: 401, body: { code } })
      expect(verdict.llmCode).toBe('AUTH')
      expect(verdict.retryable).toBe(false)
    }
  })

  it('额度类 429 归 QUOTA 且不可重试', () => {
    for (const code of [ERROR_CODE.NO_BALANCE, ERROR_CODE.USAGE_LIMIT, ERROR_CODE.PLAN_LIMIT]) {
      const verdict = classifyGlmUpstreamError({ status: 429, body: { code } })
      expect(verdict.llmCode).toBe('QUOTA')
      expect(verdict.retryable).toBe(false)
    }
  })

  it('提示词超窗归上下文溢出码，而不是可重试', () => {
    const verdict = classifyGlmUpstreamError({ status: 400, body: { code: ERROR_CODE.PROMPT_TOO_LONG } })
    expect(verdict.llmCode).toBe(CONTEXT_OVERFLOW_CODE)
    expect(verdict.retryable).toBe(false)
  })

  it('未知模型归 NOT_FOUND（本地目录错，不是上游故障）', () => {
    expect(classifyGlmUpstreamError({ status: 400, body: { code: ERROR_CODE.UNKNOWN_MODEL } }).llmCode).toBe('NOT_FOUND')
  })

  it('认得内层 error.code 形式的信封', () => {
    const verdict = classifyGlmUpstreamError({ status: 429, body: { error: { code: ERROR_CODE.RATE_LIMITED } } })
    expect(verdict.retryable).toBe(true)
    expect(verdict.llmCode).toBe('RATE_LIMIT')
  })

  it('未知 5xx 可重试；未识别的 429 不可重试（大多数 429 是额度类）', () => {
    expect(classifyGlmUpstreamError({ status: 503 }).retryable).toBe(true)
    expect(classifyGlmUpstreamError({ status: 500 }).llmCode).toBe('SERVER')
    const bare429 = classifyGlmUpstreamError({ status: 429, body: { message: 'slow down' } })
    expect(bare429.retryable).toBe(false)
    expect(bare429.businessCode).toBeNull()
  })

  it('401/403 无业务码时归 AUTH', () => {
    expect(classifyGlmUpstreamError({ status: 401 }).llmCode).toBe('AUTH')
    expect(classifyGlmUpstreamError({ status: 403 }).retryable).toBe(false)
  })

  it('glmUpstreamError 产出带稳定 code 与状态码的 LlmError', () => {
    const error = glmUpstreamError({ status: 429, body: { code: ERROR_CODE.USAGE_LIMIT, message: '周度额度已用尽' } })
    expect(error.code).toBe('QUOTA')
    expect(error.message).toContain(String(ERROR_CODE.USAGE_LIMIT))
    expect(error.message).toContain('等窗口重置')
  })

  it('带内 error 事件抛出并带上业务码', () => {
    const state = createGlmAnthropicStreamState()
    processGlmAnthropicStreamLine(line({ type: 'message_start', message: { usage: {} } }), state)
    try {
      processGlmAnthropicStreamLine(
        line({ type: 'error', error: { type: 'rate_limit_error', code: ERROR_CODE.RATE_LIMITED, message: '慢一点' } }),
        state,
      )
      expect.unreachable('带内 error 事件必须抛错')
    } catch (error) {
      expect((error as { code: string }).code).toBe('RATE_LIMIT')
      expect((error as { message: string }).message).toContain('1302')
    }
    expect(state.streamError).toMatchObject({ code: ERROR_CODE.RATE_LIMITED })
  })
})
