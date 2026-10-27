/**
 * Qoder mapper 的测试：RemoteChatAsk 信封的装配，与信封 SSE 的解析。
 *
 * 钉的是这条线路不同于任何兄弟线路的地方：
 *
 *   1. 信封字段集与取值（agent_id 常量、session_type 'qodercli'、version '3'、
 *      system 同时进顶层字段与领头消息）；
 *   2. 思考控制只在推理模型上发出，档位先收敛到模型真实梯子；
 *   3. 响应是**信封 SSE**：外层 data:{body: "<inner json>"}，inner 才是 OpenAI chunk；
 *      [DONE] 两种形态都结束，event:finish 是权威终止；
 *   4. usage 口径：prompt_tokens 含 cached_tokens，DSH 互斥计数所以减回去。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_QODER_WIRE_REQUEST_OPTIONS,
  assertQoderStreamComplete,
  buildQoderChatRequest,
  classifyQoderFailure,
  closeQoderStream,
  createQoderStreamState,
  parseQoderUsage,
  processQoderStreamLine,
  qoderWireToolCallId,
  resolveQoderThinking,
  type QoderWireRequestOptions,
} from '../src/host/qoder/mapper.ts'
import type { GenerateOptions } from '../src/host/common/llm-compat.ts'

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'qoder',
    model: 'Lite',
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
    ...overrides,
  } as GenerateOptions
}

const CTX = { modelKey: 'lite', entry: undefined, cosyVersion: '1.1.72' } as const

describe('buildQoderChatRequest', () => {
  it('信封字段集与 frozen fixture 的形状一致', () => {
    const body = buildQoderChatRequest(
      options({ system: 'be helpful' }),
      undefined as never,
      DEFAULT_QODER_WIRE_REQUEST_OPTIONS,
      CTX,
    )
    expect(body.agent_id).toBe('agent_common')
    expect(body.session_type).toBe('qodercli')
    expect(body.version).toBe('3')
    expect(body.stream).toBe(true)
    expect(body.is_reply).toBe(true)
    expect(body.is_retry).toBe(false)
    expect(body.source).toBe(1)
    expect(body.task_id).toBe('common')
    expect(body.chat_task).toBe('FREE_INPUT')
    expect(body.custom_model).toBeNull()
    // system 两处都填（官方 CLI 的形状；服务端实测忽略顶层字段，消息里那条才生效）。
    expect(body.system).toBe('be helpful')
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages[0]).toEqual({ role: 'system', content: 'be helpful' })
    expect(messages[1]).toEqual({ role: 'user', content: '你好' })
    // model_config 还原成上游形状。
    expect(body.model_config).toMatchObject({ key: 'lite', format: 'openai', source: 'system', enable: true })
    // request_id 每次唯一（上游对重复值报 code 103）。
    const again = buildQoderChatRequest(options(), undefined as never, DEFAULT_QODER_WIRE_REQUEST_OPTIONS, CTX)
    expect(body.request_id).not.toBe(again.request_id)
  })

  it('assistant 有 tool_calls 但没文本时 content 置占位空格（上游会丢 content:null 的消息）', () => {
    const body = buildQoderChatRequest(
      options({
        messages: [
          { role: 'user', content: [{ type: 'text', text: '查一下' }] },
          {
            role: 'assistant',
            content: [{ type: 'tool-call', id: 'call_1', name: 'search', arguments: '{"q":"x"}' }],
          } as never,
          {
            role: 'user',
            content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: '结果' }] }],
            source: { kind: 'tool', callId: 'call_1' },
          },
        ],
      }),
      undefined as never,
      DEFAULT_QODER_WIRE_REQUEST_OPTIONS,
      CTX,
    )
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: ' ',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
    })
    expect(messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '结果' })
  })

  it('tool_call id 收窄到 ^[a-zA-Z0-9_-]{1,64}$', () => {
    expect(qoderWireToolCallId('call_abc-123_XYZ')).toBe('call_abc-123_XYZ')
    expect(qoderWireToolCallId('call|with:chars.生')).toBe('call-with-chars')
    expect(qoderWireToolCallId('x'.repeat(80))).toHaveLength(64)
  })

  it('参数：max_tokens 永远在；temperature 只在调用方给的时候发', () => {
    const withTemp = buildQoderChatRequest(
      options({ temperature: 0.5, maxTokens: 1000 }),
      undefined as never,
      DEFAULT_QODER_WIRE_REQUEST_OPTIONS,
      CTX,
    )
    expect(withTemp.parameters).toEqual({ max_tokens: 1000, temperature: 0.5 })
    const plain = buildQoderChatRequest(options(), undefined as never, DEFAULT_QODER_WIRE_REQUEST_OPTIONS, CTX)
    expect(plain.parameters).toEqual({ max_tokens: 131072 })
  })
})

describe('resolveQoderThinking', () => {
  const effortModel: QoderWireRequestOptions = { reasoning: true, reasoningEfforts: ['low', 'high'], thinkingDisableable: true }
  const toggleModel: QoderWireRequestOptions = { reasoning: true, reasoningEfforts: [], thinkingDisableable: true }
  const plainModel: QoderWireRequestOptions = { reasoning: false, reasoningEfforts: [] }

  it('非推理模型一个思考字段都不发', () => {
    expect(resolveQoderThinking('high', plainModel)).toBeUndefined()
    expect(resolveQoderThinking(undefined, plainModel)).toBeUndefined()
  })

  it('没选档位时显式关思考（不默认让它想）', () => {
    expect(resolveQoderThinking(undefined, effortModel)).toEqual({ enable_thinking: false })
  })

  it('effort 形态：收敛到模型真实梯子后才发 reasoning_effort', () => {
    // medium 不在 [low, high] 上：平手向上取到 high。
    expect(resolveQoderThinking('medium', effortModel)).toEqual({ enable_thinking: true, reasoning_effort: 'high' })
    expect(resolveQoderThinking('low', effortModel)).toEqual({ enable_thinking: true, reasoning_effort: 'low' })
  })

  it('toggle 形态：只发开关，不发 effort 值', () => {
    expect(resolveQoderThinking('high', toggleModel)).toEqual({ enable_thinking: true })
    expect(resolveQoderThinking('none', toggleModel)).toEqual({ enable_thinking: false })
  })
})

// ---------------------------------------------------------------------------
// 信封 SSE 解析
// ---------------------------------------------------------------------------

/** 包一帧信封。 */
function envelope(inner: unknown, statusCodeValue = 200): string {
  return 'data:' + JSON.stringify({
    headers: { 'Content-Type': ['application/json'] },
    body: typeof inner === 'string' ? inner : JSON.stringify(inner),
    statusCodeValue,
    statusCode: 'OK',
  })
}

describe('processQoderStreamLine（信封 SSE）', () => {
  it('content / reasoning / tool_calls / usage / finish 全链路', () => {
    const state = createQoderStreamState()
    const out: unknown[] = []
    for (const chunk of processQoderStreamLine(envelope({ choices: [{ delta: { reasoning_content: '想一想' } }] }), state)) out.push(chunk)
    for (const chunk of processQoderStreamLine(envelope({ choices: [{ delta: { content: '答' } }] }), state)) out.push(chunk)
    for (const chunk of processQoderStreamLine(envelope({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"p"' } }] } }],
    }), state)) out.push(chunk)
    for (const chunk of processQoderStreamLine(envelope({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"/a"}' } }] } }],
    }), state)) out.push(chunk)
    for (const chunk of processQoderStreamLine(envelope({
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 40 },
      },
    }), state)) out.push(chunk)
    // [DONE] 的信封形态结束。
    for (const chunk of processQoderStreamLine(envelope('[DONE]'), state)) out.push(chunk)

    const types = out.map((chunk) => (chunk as { type: string }).type)
    expect(types).toContain('reasoning-delta')
    expect(types).toContain('text-delta')
    expect(types).toContain('tool-call-delta')
    const usage = out.find((chunk) => (chunk as { type: string }).type === 'usage') as {
      usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number }
    }
    // prompt 100 含缓存读入 40：互斥计数后输入是 60。
    expect(usage.usage).toMatchObject({ inputTokens: 60, outputTokens: 20, cacheReadTokens: 40 })
    const finish = out.find((chunk) => (chunk as { type: string }).type === 'finish') as { reason: { kind: string } }
    expect(finish.reason.kind).toBe('tool-calls')
    expect(state.done).toBe(true)
    assertQoderStreamComplete(state)
  })

  it('裸 data:[DONE] 与 event:finish 同样结束', () => {
    const a = createQoderStreamState()
    processQoderStreamLine(envelope({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }), a)
    const chunks = processQoderStreamLine('data:[DONE]', a)
    expect(a.done).toBe(true)
    expect(chunks.some((chunk) => chunk.type === 'finish')).toBe(true)

    const b = createQoderStreamState()
    processQoderStreamLine(envelope({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }), b)
    processQoderStreamLine('event:finish', b)
    expect(b.done).toBe(true)
    assertQoderStreamComplete(b)
  })

  it('statusCodeValue != 200 的错误信封按状态分类抛出', () => {
    const state = createQoderStreamState()
    expect(() => processQoderStreamLine(envelope('{"message":"Login expired","code":"105"}', 401), state))
      .toThrowError(/rejected the credential/)
    try {
      processQoderStreamLine(envelope('{"message":"Login expired","code":"105"}', 401), createQoderStreamState())
    } catch (error) {
      expect((error as { code?: string }).code).toBe('AUTH')
    }
  })

  it('内层 error 对象也上浮为错误', () => {
    const state = createQoderStreamState()
    expect(() => processQoderStreamLine(envelope({ error: { message: 'boom' } }), state))
      .toThrowError(/boom/)
  })

  it('没有终止事件的流是被截断的回复', () => {
    const state = createQoderStreamState()
    processQoderStreamLine(envelope({ choices: [{ delta: { content: '半句' } }] }), state)
    expect(() => assertQoderStreamComplete(state)).toThrowError(/terminal event/)
    // closeQoderStream 在截断时仍然能收尾（finish 以 stop 落地）。
    const chunks = closeQoderStream(state)
    expect(chunks.some((chunk) => chunk.type === 'finish')).toBe(true)
  })
})

describe('parseQoderUsage', () => {
  it('缓存读入按字段优先级链读取（details.cached_tokens → 顶层 cached_tokens → prompt_cache_hit_tokens）', () => {
    expect(parseQoderUsage({
      prompt_tokens: 100,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 5 },
    })).toMatchObject({ inputTokens: 65, cacheReadTokens: 30, cacheWriteTokens: 5 })
    expect(parseQoderUsage({ prompt_tokens: 100, completion_tokens: 10, cached_tokens: 70 }))
      .toMatchObject({ inputTokens: 30, cacheReadTokens: 70 })
    expect(parseQoderUsage({ prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 50 }))
      .toMatchObject({ inputTokens: 50, cacheReadTokens: 50 })
    // 都没报：0 表示「上游没报」，不是「一定没命中」。
    expect(parseQoderUsage({ prompt_tokens: 100, completion_tokens: 10 }))
      .toMatchObject({ inputTokens: 100, cacheReadTokens: 0 })
    expect(parseQoderUsage('nope')).toBeUndefined()
  })
})

describe('classifyQoderFailure', () => {
  it('401/403 → AUTH；429 → RATE_LIMIT；5xx → SERVER；业务码 103/105 各归各位', () => {
    expect(classifyQoderFailure(401, '').code).toBe('AUTH')
    expect(classifyQoderFailure(403, '').code).toBe('AUTH')
    expect(classifyQoderFailure(429, '').code).toBe('RATE_LIMIT')
    expect(classifyQoderFailure(500, '').code).toBe('SERVER')
    expect(classifyQoderFailure(404, '').code).toBe('NOT_FOUND')
    // code 105（Login expired）即便包在 200 态文案里也归 AUTH。
    expect(classifyQoderFailure(400, '{"code":"105","message":"Login expired"}').code).toBe('AUTH')
    // code 103（重复 request_id）不是可安全自动重试的状态。
    expect(classifyQoderFailure(400, '{"code":"103"}').code).toBe('PROVIDER_ERROR')
  })

  it('上游排队（403 + RESOURCE_LIMIT）归 SERVER：凭据是好的，别说成「API 密钥无效」', () => {
    const detail = JSON.stringify({
      code: 10605,
      subCode: 'RESOURCE_LIMIT',
      modelKey: 'dfmodel',
      queueCount: 3239,
      retryAfterSeconds: 30,
      serviceAvailable: false,
    })
    const failure = classifyQoderFailure(403, detail)
    expect(failure.code).toBe('SERVER')
    expect(failure.message).toContain('排队')
    expect(failure.message).toContain('3239')
    expect(failure.message).toContain('不需要重新登录')
    // 上游给了等待秒数，就照它说（交给 harness 的重试策略）。
    expect(failure.failure.providerRetryAfterMs).toBe(30_000)
  })

  it('额度用尽（403 + code 112 / pricingUrl）归 QUOTA：与排队是两条不同的路', () => {
    const failure = classifyQoderFailure(403, JSON.stringify({
      code: 112,
      message: 'quota exceeded',
      pricingUrl: 'https://qoder.com/pricing?client=qoder',
    }))
    expect(failure.code).toBe('QUOTA')
    expect(failure.message).toContain('额度已用尽')
    expect(failure.message).toContain('https://qoder.com/pricing?client=qoder')
  })

  it('认不出原因的 403 仍然是 AUTH（保守：凭据被拒是上游最常见的那一种）', () => {
    expect(classifyQoderFailure(403, '{"message":"forbidden"}').code).toBe('AUTH')
  })

  it('429 的含义不被排队事实改写，除非上游点名 RESOURCE_LIMIT', () => {
    // 弱信号（只有排队人数）：429 仍然是「这个账号被限流」，号池照旧冷却与轮转。
    expect(classifyQoderFailure(429, JSON.stringify({ queueCount: 12 })).code).toBe('RATE_LIMIT')
    // 点了名：上游说的是「没容量」，不是「这个账号被限流」。
    expect(classifyQoderFailure(429, JSON.stringify({ subCode: 'RESOURCE_LIMIT' })).code).toBe('SERVER')
  })
})

describe('错误信封里的失败事实（issue #74）', () => {
  /** 包一帧错误信封（statusCodeValue != 200）。 */
  function errorEnvelope(body: unknown, statusCodeValue: number, extra: Record<string, unknown> = {}): string {
    return 'data:' + JSON.stringify({
      headers: { 'Content-Type': ['application/json'] },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      statusCodeValue,
      statusCode: 'FORBIDDEN',
      ...extra,
    })
  }

  /** 跑一帧并把抛出的错误抓回来（没抛就是 undefined）。 */
  function catchOf(line: string): { code?: string; message?: string } | undefined {
    try {
      processQoderStreamLine(line, createQoderStreamState())
      return undefined
    } catch (error) {
      return error as { code?: string; message?: string }
    }
  }

  it('body 里的排队事实（403）归 SERVER，而不是 AUTH', () => {
    const caught = catchOf(errorEnvelope({
      code: 10605,
      subCode: 'RESOURCE_LIMIT',
      queueCount: 3239,
      retryAfterSeconds: 30,
      serviceAvailable: false,
    }, 403))
    expect(caught?.code).toBe('SERVER')
    expect(caught?.message).toContain('排队')
  })

  it('事实放在信封外层时也照样认出来', () => {
    const caught = catchOf(errorEnvelope({ message: 'resource limit' }, 403, {
      subCode: 'RESOURCE_LIMIT',
      queueCount: 12,
    }))
    expect(caught?.code).toBe('SERVER')
  })

  it('额度用尽（403 + code 112）归 QUOTA', () => {
    const caught = catchOf(errorEnvelope(
      { code: 112, pricingUrl: 'https://qoder.com/pricing' },
      403,
    ))
    expect(caught?.code).toBe('QUOTA')
  })

  it('真的登录失效（401 + code 105）仍然是 AUTH', () => {
    const caught = catchOf(errorEnvelope({ message: 'Login expired', code: '105' }, 401))
    expect(caught?.code).toBe('AUTH')
  })
})
