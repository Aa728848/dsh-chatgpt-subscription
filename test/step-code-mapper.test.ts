/**
 * T2 线协议映射守卫测试：Step Code（Step Plan 订阅）线路的 **host 侧线协议映射**
 * （请求体构造 / prompt_cache_key 截断 / 用量解析 / SSE 流解析 / 失败归类）。
 *
 * 全部离线：mapper 是纯函数（自己不做任何 I/O），这里只喂本地构造的
 * `Record<string, unknown>` 与字符串行，**不发任何网络请求**、不需要任何凭据。
 *
 * 每条 `it` 的标题就是被断言的那条事实本身，脱离本文件也能读懂「上游 / 契约要求的是什么」。
 */

import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type {
  FinishReason,
  GenerateOptions,
  Message,
  OutboundContentBlock,
  StreamChunk,
  TokenUsage,
} from '../src/host/common/llm-compat.ts'
import { CONTEXT_OVERFLOW_CODE } from '../src/host/common/context-overflow.ts'
import type { StepCodeModelEntry } from '../src/host/step-code/model-catalog.ts'
import { MODEL_DEFAULTS, PROVIDER_NAME, defaultMaxTokens } from '../src/host/step-code/types.ts'
import {
  STEP_CODE_CACHE_READ_FIELD_ORDER as MAPPER_FIELD_ORDER,
  DEFAULT_STEP_CODE_REQUEST_OPTIONS,
  STEP_CODE_PRICE_PER_MILLION_TOKENS,
  assertStreamComplete,
  buildChatRequest,
  clampStepCodePromptCacheKey,
  classifyStepCodeFailure,
  closeStream,
  createStreamState,
  parseStepCodeUsage,
  processStreamLine,
  readCacheReadTokens,
  resolveStepCodeReasoningEffort,
  stepCodePromptCacheKey,
  stepCodeRequestOptionsFor,
  streamTokenUsage,
  type StepCodeRequestOptions,
} from '../src/host/step-code/mapper.ts'
import {
  STEP_CODE_CACHE_READ_FIELD_ORDER,
  STEP_CODE_CACHE_REQUEST_PARAMS_DEFAULT,
  STEP_CODE_CACHE_WRITE_NOTE,
  STEP_CODE_PRICING_STATUS,
  STEP_CODE_PROMPT_CACHE_KEY_MAX_LENGTH,
  STEP_CODE_REASONING_EFFORTS,
} from '../src/shared/step-code-contracts.ts'

// ---------------------------------------------------------------------------
// 本地构造的输入
// ---------------------------------------------------------------------------

/** `GenerateOptions` 上档位与会话 id 都是品牌化的字符串；测试只需要裸值。 */
const effort = (value: string): NonNullable<GenerateOptions['reasoningEffort']> =>
  value as NonNullable<GenerateOptions['reasoningEffort']>

const session = (value: string): NonNullable<GenerateOptions['sessionId']> =>
  value as NonNullable<GenerateOptions['sessionId']>

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'step-code',
    model: 'step-3',
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] } as Message],
    ...overrides,
  } as GenerateOptions
}

/** 工具参数按两条 SSE 分片下发；分片边界由模型决定，一个 JSON 的引号可以跨片。 */
const ARG_HEAD = '{"pa'
const ARG_TAIL = 'th":"a"}'
const OTHER_ARG_HEAD = '{"q'
const OTHER_ARG_TAIL = '":1}'

/** 一条 Chat Completions 的 SSE 行，带 `data:` 前缀与 JSON 载荷。 */
const frame = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }], ...extra })}`

/** 从流里取出某一种 delta 的文本，按出现顺序。窄化全部走 StreamChunk 的判别式，不靠断言。 */
function deltaTexts(chunks: StreamChunk[], kind: 'text-delta' | 'reasoning-delta'): string[] {
  return chunks.flatMap((chunk) => (chunk.type === kind ? [chunk.text] : []))
}

function blockStarts(chunks: StreamChunk[]): Array<{ index: number; blockType: string }> {
  return chunks.flatMap((chunk) =>
    chunk.type === 'block-start' ? [{ index: chunk.index, blockType: chunk.blockType }] : [])
}

function blockEnds(chunks: StreamChunk[]): OutboundContentBlock[] {
  return chunks.flatMap((chunk) => (chunk.type === 'block-end' ? [chunk.block] : [])) as OutboundContentBlock[]
}

function finishReasonOf(chunks: StreamChunk[]): FinishReason | undefined {
  const chunk = chunks.find((c) => c.type === 'finish')
  return chunk?.type === 'finish' ? chunk.reason : undefined
}

function usageOf(chunks: StreamChunk[]): TokenUsage | undefined {
  const chunk = chunks.find((c) => c.type === 'usage')
  return chunk?.type === 'usage' ? chunk.usage : undefined
}

/** 目录里一行真实模型的事实（字段齐，不留空位，免得断言测的是省略而不是能力）。 */
const CATALOG_ENTRY: StepCodeModelEntry = {
  id: 'step-3',
  name: 'Step 3',
  hint: '',
  profiles: ['step_plan'],
  reasoningEfforts: ['low', 'high'],
  thinkingDisableable: true,
  supportsImages: true,
  defaultContextWindow: 256_000,
  defaultMaxTokens: 32_768,
  description: null,
}

// ---------------------------------------------------------------------------
// 1. 请求体构造
// ---------------------------------------------------------------------------

describe('Step Code 请求体：输出上限与流式标志', () => {
  it('输出上限字段是 max_tokens，且绝不出现 OpenAI o 系列的 max_completion_tokens', () => {
    const payload = buildChatRequest(options({ maxTokens: 4096 }))

    expect(payload.max_tokens).toBe(4096)
    // Step 的 Chat Completions 文档只定义 max_tokens；官方客户端按检测到的
    // compat.maxTokensField 选字段，本线路把文档里那一个写死，不做每请求检测。
    expect(payload).not.toHaveProperty('max_completion_tokens')
  })

  it('调用方不给输出上限时，取这条线的兜底规则：没有上报输出上限就等于输入窗口', () => {
    // 端点不报 max-output，所以线路的规则是「等于上下文窗口」，不是一个独立字面量。
    expect(buildChatRequest(options()).max_tokens).toBe(defaultMaxTokens())
    expect(defaultMaxTokens()).toBe(MODEL_DEFAULTS.contextWindow)
  })

  it('always stream:true 且 stream_options.include_usage:true —— 缓存读入量只出现在终止帧上', () => {
    const payload = buildChatRequest(options())

    expect(payload.stream).toBe(true)
    expect(payload.stream_options).toEqual({ include_usage: true })
  })

  it('没有系统提示时不凭空造一条 system 消息（Step 的前置 system 不是强制的）', () => {
    const payload = buildChatRequest(options())
    const messages = payload.messages as Array<Record<string, unknown>>

    expect(messages.map((message) => message.role)).toEqual(['user'])
  })
})

describe('Step Code 请求体：缓存参数默认全关', () => {
  it('★ 默认一个缓存参数都不发：prompt_cache_key / prompt_cache_retention / cache_control 三者全都不存在', () => {
    const payload = buildChatRequest(options({ sessionId: session('sess-default') }))

    expect(payload).not.toHaveProperty('prompt_cache_key')
    expect(payload).not.toHaveProperty('prompt_cache_retention')
    // cache_control 只在 Anthropic 那条线上存在；这条线上任何一层都不许出现它。
    expect(payload).not.toHaveProperty('cache_control')
    // 整份请求体序列化之后仍然找不到任何 cache 字样：三个已知字段名都被排除之后，
    // 这一条是「不是换个字段名偷偷发了」的兜底。
    expect(JSON.stringify(payload)).not.toMatch(/cache/i)
  })

  it('出厂状态就是关：官方客户端对 Step 端点一个缓存参数都不发', () => {
    // 官方的 prompt_cache_key 硬绑 baseUrl.includes('api.openai.com')，
    // 会话亲和头对 Step 是关的，cache_control 只在 Anthropic 格式下发出。
    expect(DEFAULT_STEP_CODE_REQUEST_OPTIONS.cacheRequestParams).toBe(false)
    expect(STEP_CODE_CACHE_REQUEST_PARAMS_DEFAULT).toBe(false)
  })

  it('显式写 cacheRequestParams:false 与整个省略是同一件事', () => {
    const off = buildChatRequest(options({ sessionId: session('sess-off') }), undefined, { cacheRequestParams: false })

    expect(off).not.toHaveProperty('prompt_cache_key')
    expect(stepCodePromptCacheKey(options({ sessionId: session('sess-off') }), { cacheRequestParams: false }))
      .toBeUndefined()
  })

  it('打开 cacheRequestParams 后出现 prompt_cache_key 且等于会话 id，仍不发 retention 与 cache_control', () => {
    const payload = buildChatRequest(
      options({ sessionId: session('sess-cache') }),
      undefined,
      { cacheRequestParams: true },
    )

    expect(payload.prompt_cache_key).toBe('sess-cache')
    // 打开的只是这一个字段：retention(24h) 是未文档化字段，cache_control 是别的线上才有的。
    expect(payload).not.toHaveProperty('prompt_cache_retention')
    expect(payload).not.toHaveProperty('cache_control')
  })

  it('打开了能力位但没有会话 id 时依然一个缓存字段都不发（没有可key 的东西就不编一个）', () => {
    const payload = buildChatRequest(options(), undefined, { cacheRequestParams: true })

    expect(payload).not.toHaveProperty('prompt_cache_key')
  })
})

describe('Step Code 请求体：思考档位只走模型真实梯子', () => {
  it('合法档位下发 reasoning_effort', () => {
    const payload = buildChatRequest(
      options({ reasoningEffort: effort('high') }),
      undefined,
      { reasoningEfforts: ['low', 'high'] },
    )

    expect(payload.reasoning_effort).toBe('high')
  })

  it('★ 模型真实梯子为空时一个字段都不发，即使调用方点名了一个档位', () => {
    // 空梯子是该模型「不接受 reasoning_effort」的声明，不是「忘了填」。
    const payload = buildChatRequest(
      options({ reasoningEffort: effort('high') }),
      undefined,
      { reasoningEfforts: [] },
    )

    expect(payload).not.toHaveProperty('reasoning_effort')
  })

  it('梯子外的档位先收敛到梯子上最近的一档：DSH 六档词汇下绝不发模型不认的值', () => {
    // 官方 reasoning_effort_support_list 是逐模型声明的，未列出的档位映射为「不支持」，
    // 所以发一个梯子外的值不是「偏好」而是一次必然失败的请求。
    expect(resolveStepCodeReasoningEffort('max', ['low', 'high'])).toBe('high')
    expect(resolveStepCodeReasoningEffort('minimal', ['low', 'high'])).toBe('low')
    expect(buildChatRequest(
      options({ reasoningEffort: effort('max') }),
      undefined,
      { reasoningEfforts: ['low', 'high'] },
    ).reasoning_effort).toBe('high')
  })

  it('档位请求缺位或空白时不发字段（不是发一个空档位）', () => {
    expect(resolveStepCodeReasoningEffort(undefined, ['low', 'high'])).toBeUndefined()
    expect(resolveStepCodeReasoningEffort('   ', ['low', 'high'])).toBeUndefined()
    // 非字符串的档位不是档位。
    expect(resolveStepCodeReasoningEffort(42, ['low', 'high'])).toBeUndefined()
    expect(buildChatRequest(options({ reasoningEffort: effort('high') })))
      .not.toHaveProperty('reasoning_effort')
  })

  it('打开缓存能力位不会顺手把档位也打开：两个能力位彼此独立', () => {
    const payload = buildChatRequest(
      options({ sessionId: session('sess-x'), reasoningEffort: effort('high') }),
      undefined,
      { cacheRequestParams: true },
    )

    expect(payload.prompt_cache_key).toBe('sess-x')
    expect(payload).not.toHaveProperty('reasoning_effort')
  })

  it('线路级六档词汇与 host 侧是同一份数组（不另抄一份）', () => {
    expect([...STEP_CODE_REASONING_EFFORTS]).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  })
})

describe('stepCodeRequestOptionsFor：目录事实逐字段复制，能力位留给调用方', () => {
  it('已知模型：images、输出上限、档位梯子都取自那一行目录', () => {
    expect(stepCodeRequestOptionsFor(CATALOG_ENTRY)).toEqual({
      supportsImages: true,
      defaultMaxTokens: 32_768,
      reasoningEfforts: ['low', 'high'],
    })
  })

  it('★ cacheRequestParams 不来自目录：它是每部署的能力位，缺省时连键都不出现', () => {
    const options_ = stepCodeRequestOptionsFor(CATALOG_ENTRY)

    expect(Object.keys(options_)).not.toContain('cacheRequestParams')
  })

  it('调用方只能覆盖它拥有的两件事：缓存能力位与输出上限', () => {
    expect(stepCodeRequestOptionsFor(CATALOG_ENTRY, { cacheRequestParams: true, defaultMaxTokens: 64 }))
      .toEqual({
        supportsImages: true,
        defaultMaxTokens: 64,
        reasoningEfforts: ['low', 'high'],
        cacheRequestParams: true,
      })
  })

  it('未知模型落成未声明行：images 关、梯子空、输出上限取线路兜底', () => {
    // 「从不下发端点没声明的字段」因此是默认路径而不是特例。
    expect(stepCodeRequestOptionsFor(undefined)).toEqual({
      supportsImages: false,
      defaultMaxTokens: defaultMaxTokens(),
      reasoningEfforts: [],
    })
  })
})

// ---------------------------------------------------------------------------
// 2. clampStepCodePromptCacheKey：按码点截断
// ---------------------------------------------------------------------------

describe('prompt_cache_key 的长度上限按码点算，不按 UTF-16 单元算', () => {
  it('纯 ASCII 超长串截到 64 个字符', () => {
    const clamped = clampStepCodePromptCacheKey('a'.repeat(200))

    expect(clamped).toBe('a'.repeat(64))
    expect(clamped?.length).toBe(64)
  })

  it('★ emoji 串截出 64 个码点、128 个 UTF-16 单元：绝不在代理对中间下刀', () => {
    // 按 UTF-16 单元截会得到 32 个 emoji（64 个单元），并且可能落在一个代理对的
    // 正中间——那时线上是一个**半个**代理对，网关会拒。
    const clamped = clampStepCodePromptCacheKey('🚀'.repeat(200)) ?? ''

    expect([...clamped].length).toBe(64)
    expect(clamped.length).toBe(128)
    expect(clamped).toBe('🚀'.repeat(64))
  })

  it('★ 中英/表情混合串同样是码点计数：UTF-16 长度大于 64，且没有半个代理对', () => {
    const clamped = clampStepCodePromptCacheKey('中🚀'.repeat(100)) ?? ''

    expect([...clamped].length).toBe(64)
    // 中(1) + 🚀(2) = 每组 3 个单元；64 个码点 = 32 组 = 96 个单元。
    expect(clamped.length).toBe(96)
    expect(clamped).toBe('中🚀'.repeat(32))
  })

  it('BMP 内的中日韩字符：码点数与 UTF-16 长度恰好都是 64（所以要靠 emoji 那条证明是按码点截的）', () => {
    const clamped = clampStepCodePromptCacheKey('会话'.repeat(200)) ?? ''

    expect([...clamped].length).toBe(64)
    expect(clamped.length).toBe(64)
  })

  it('上限之内原样返回，undefined 原样返回 undefined', () => {
    expect(clampStepCodePromptCacheKey(undefined)).toBeUndefined()
    expect(clampStepCodePromptCacheKey('sess-1')).toBe('sess-1')
    expect(clampStepCodePromptCacheKey('a'.repeat(64))).toBe('a'.repeat(64))
  })

  it('空白串没有可 key 的东西：返回 undefined 而不是发一个空字符串', () => {
    expect(clampStepCodePromptCacheKey('   ')).toBeUndefined()
    // 前后空白先剥掉，避免同一会话因为两端多一个空格而落到两个 key 上。
    expect(clampStepCodePromptCacheKey('  sess-padded  ')).toBe('sess-padded')
  })

  it('上限常量就是共享契约里那一个 64 个码点', () => {
    expect(STEP_CODE_PROMPT_CACHE_KEY_MAX_LENGTH).toBe(64)
  })
})

// ---------------------------------------------------------------------------
// 3. 用量解析
// ---------------------------------------------------------------------------

describe('缓存读入量的五级解析链', () => {
  it('第一级：OpenAI 规范的 prompt_tokens_details.cached_tokens 同时压过其余三条', () => {
    const usage = {
      prompt_tokens_details: { cached_tokens: 111 },
      cache_read_input_tokens: 222,
      cached_tokens: 333,
      prompt_cache_hit_tokens: 444,
    }

    expect(readCacheReadTokens(usage)).toBe(111)
  })

  it('第二级：Anthropic 规范的 cache_read_input_tokens 压过顶层与 DeepSeek 命名', () => {
    const usage = { cache_read_input_tokens: 222, cached_tokens: 333, prompt_cache_hit_tokens: 444 }

    expect(readCacheReadTokens(usage)).toBe(222)
  })

  it('★ 第三级：顶层 cached_tokens 是 Step 官方文档唯一给出的字段，命中判据就是它 > 0', () => {
    // 本线路区别于仓库现行诊断层（common/request-diagnostics.ts 那一支没有这一级）的关键点：
    // 只把它当别人的兜底，上游真的只报这个字段时卡片就会显示「没命中」。
    const usage = { cached_tokens: 333, prompt_cache_hit_tokens: 444 }

    expect(readCacheReadTokens(usage)).toBe(333)
  })

  it('第四级：DeepSeek 一族的 prompt_cache_hit_tokens 是链尾兜底', () => {
    expect(readCacheReadTokens({ prompt_cache_hit_tokens: 444 })).toBe(444)
  })

  it('第五级是 0：一条都没报时返回 0，含义是「上游没报」而不是「一定没命中」', () => {
    expect(readCacheReadTokens({})).toBe(0)
    expect(readCacheReadTokens({ prompt_tokens_details: {} })).toBe(0)
    // 一个不是计数的值不能被当成计数。
    expect(readCacheReadTokens({ cached_tokens: '333' })).toBe(0)
    expect(readCacheReadTokens({ cached_tokens: -1 })).toBe(0)
  })

  it('★ mapper 走的就是共享契约里那一份数组，不是自己抄的第二份', () => {
    expect(MAPPER_FIELD_ORDER).toBe(STEP_CODE_CACHE_READ_FIELD_ORDER)
    expect([...MAPPER_FIELD_ORDER]).toEqual([
      'prompt_tokens_details.cached_tokens',
      'cache_read_input_tokens',
      'cached_tokens',
      'prompt_cache_hit_tokens',
    ])
  })
})

describe('parseStepCodeUsage：归一化成互斥的 DSH 计数', () => {
  it('input 与两个缓存桶互斥：input = max(0, prompt_tokens - cacheRead - cacheWrite)', () => {
    const usage = parseStepCodeUsage({ prompt_tokens: 1000, completion_tokens: 50, cached_tokens: 400 })

    expect(usage).toEqual({
      promptTokens: 1000,
      inputTokens: 600,
      outputTokens: 50,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    })
  })

  it('缓存读入量大于 prompt 总额时不产生负数（互斥计数不能倒挂）', () => {
    expect(parseStepCodeUsage({ prompt_tokens: 100, cached_tokens: 500 })?.inputTokens).toBe(0)
  })

  it('★ 缓存写入量在本线路是 0：自动前缀缓存没有客户端可写的那个动作', () => {
    // 本线路端点发的 usage 里只有缓存读，没有写入；所以每一条真实形状的帧都是 0。
    for (const raw of [
      { prompt_tokens: 1000, completion_tokens: 50, cached_tokens: 400 },
      { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 400 } },
      { prompt_tokens: 1000, cache_read_input_tokens: 400 },
      { prompt_tokens: 1000 },
    ]) {
      expect(parseStepCodeUsage(raw)?.cacheWriteTokens).toBe(0)
    }
    expect(STEP_CODE_CACHE_WRITE_NOTE).toBe('always-zero-on-this-route')
  })

  it('completion_tokens_details.reasoning_tokens 缺失时按 0 计', () => {
    expect(parseStepCodeUsage({ completion_tokens: 50 })?.reasoningTokens).toBe(0)
    expect(parseStepCodeUsage({ completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 20 } }))
      .toMatchObject({ outputTokens: 50, reasoningTokens: 20 })
  })

  it('completion_tokens 已经含 reasoning，不做二次扣减', () => {
    const usage = parseStepCodeUsage({
      completion_tokens: 50,
      completion_tokens_details: { reasoning_tokens: 20 },
    })

    expect(usage?.outputTokens).toBe(50)
    expect(usage?.inputTokens).toBe(0)
  })

  it('★ 金额维度不存在：官方单价表全为 0，用量对象里连 cost 这个键都没有', () => {
    expect(STEP_CODE_PRICE_PER_MILLION_TOKENS).toBe(0)
    expect(STEP_CODE_PRICE_PER_MILLION_TOKENS).toBe(MODEL_DEFAULTS.cost.input)
    expect(MODEL_DEFAULTS.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    expect(STEP_CODE_PRICING_STATUS).toBe('undocumented-zero')
    expect(parseStepCodeUsage({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }))
      .not.toHaveProperty('cost')
  })

  it('不是用量形状的东西返回 undefined，不把别的东西编造成用量', () => {
    expect(parseStepCodeUsage(undefined)).toBeUndefined()
    expect(parseStepCodeUsage('usage')).toBeUndefined()
    expect(parseStepCodeUsage([{ prompt_tokens: 10 }])).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 4. 流解析
// ---------------------------------------------------------------------------

describe('Step Code SSE 流：思考与正文是两个独立的块', () => {
  it('delta.reasoning_content 走思考块，delta.content 走文本块，两者不混在一个块里', () => {
    const state = createStreamState()
    const out = [
      ...processStreamLine(frame({ role: 'assistant', content: '' }), state),
      ...processStreamLine(frame({ reasoning_content: '先想一下' }), state),
      ...processStreamLine(frame({ content: '再作答' }), state),
    ]

    expect(blockStarts(out)).toEqual([
      { index: 0, blockType: 'reasoning' },
      { index: 1, blockType: 'text' },
    ])
    expect(deltaTexts(out, 'reasoning-delta')).toEqual(['先想一下'])
    expect(deltaTexts(out, 'text-delta')).toEqual(['再作答'])
  })

  it('★ delta.reasoning（前置网关用的新拼写）同样被认成思考块', () => {
    // 只认 reasoning_content 的话，一个换个字段名的网关会让思考模型静默变成没有思考块。
    const state = createStreamState()
    const out = processStreamLine(frame({ reasoning: '换了个字段名' }), state)

    expect(blockStarts(out)).toEqual([{ index: 0, blockType: 'reasoning' }])
    expect(deltaTexts(out, 'reasoning-delta')).toEqual(['换了个字段名'])
    expect(deltaTexts(out, 'text-delta')).toEqual([])
  })

  it('两个字段名同时出现时以 reasoning_content 为准（Step 自己的拼写优先）', () => {
    const state = createStreamState()
    const out = processStreamLine(frame({ reasoning_content: 'a', reasoning: 'b' }), state)

    expect(deltaTexts(out, 'reasoning-delta')).toEqual(['a'])
  })
})

describe('Step Code SSE 流：tool_calls 分片聚合', () => {
  it('★ function.arguments 跨多行拼接之后才是一份合法 JSON', () => {
    const state = createStreamState()
    const out = [
      ...processStreamLine(frame({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '' } }] }), state),
      ...processStreamLine(frame({ tool_calls: [{ index: 0, function: { arguments: ARG_HEAD } }] }), state),
      ...processStreamLine(frame({ tool_calls: [{ index: 0, function: { arguments: ARG_TAIL } }] }), state),
    ]
    const done = processStreamLine('data: [DONE]', state)
    const blocks = [...blockEnds(out), ...blockEnds(done)]
    const argumentsText = blocks.map((block) => (block.type === 'tool-call' ? block.arguments : '')).join('')

    // 参数原样保留：parse/序列化一个来回会改写大数、转义与键序，而执行侧是按字符串比对的。
    expect(argumentsText).toBe('{"path":"a"}')
    expect(JSON.parse(argumentsText)).toEqual({ path: 'a' })
    expect(blocks.map((block) => (block.type === 'tool-call' ? block.name : '')).join('')).toBe('read_file')
  })

  it('index 相同的分片归同一个调用，index 不同的分成两个调用（且按 index 顺序收尾）', () => {
    const state = createStreamState()
    const out = [
      ...processStreamLine(frame({ tool_calls: [
        { index: 0, id: 'call_a', function: { name: 'read_file', arguments: ARG_HEAD } },
        { index: 1, id: 'call_b', function: { name: 'list_dir', arguments: OTHER_ARG_HEAD } },
      ] }), state),
      // 第二个分片故意逆序到达：wire 上的顺序不是到达顺序，收尾要按 index 排。
      ...processStreamLine(frame({ tool_calls: [
        { index: 1, function: { arguments: OTHER_ARG_TAIL } },
        { index: 0, function: { arguments: ARG_TAIL } },
      ] }), state),
    ]
    const blocks = [...blockEnds(out), ...blockEnds(processStreamLine('data: [DONE]', state))]

    expect(blocks).toHaveLength(2)
    expect(blocks.map((block) => (block.type === 'tool-call' ? block.name : ''))).toEqual(['read_file', 'list_dir'])
    expect(blocks.map((block) => (block.type === 'tool-call' ? block.arguments : '')))
      .toEqual(['{"path":"a"}', '{"q":1}'])
  })

  it('无参数的工具调用也必须在第一片就把名字发出去，并按 tool-calls 收尾', () => {
    // 否则 hasToolCall 永远是 false，回合被当成普通 stop，runner 根本不会去执行它。
    const state = createStreamState()
    const out = processStreamLine(
      frame({ tool_calls: [{ index: 0, id: 'call_9', function: { name: 'list_files', arguments: '' } }] }),
      state,
    )

    expect(out).toContainEqual(expect.objectContaining({ type: 'tool-call-delta', name: 'list_files' }))
    expect(state.hasToolCall).toBe(true)
    const done = processStreamLine('data: [DONE]', state)
    expect(finishReasonOf(done)).toEqual({ kind: 'tool-calls' })
    expect(blockEnds(done).map((block) => (block.type === 'tool-call' ? block.arguments : ''))).toEqual(['{}'])
  })
})

describe('Step Code SSE 流：空帧、心跳帧与 [DONE]', () => {
  it('★ 空帧与心跳帧都不产出内容块，也不会把流当成结束', () => {
    const state = createStreamState()

    expect(processStreamLine(': keep-alive comment', state)).toEqual([])
    expect(processStreamLine('data: ', state)).toEqual([])
    expect(processStreamLine('data: {"choices":[]}', state)).toEqual([])
    expect(state.blocks).toEqual([])
    expect(state.done).toBe(false)
    expect(state.finished).toBe(false)
  })

  it('[DONE] 收尾：状态置位、终止块落地，且再收一次是空操作', () => {
    const state = createStreamState()
    const done = processStreamLine('data: [DONE]', state)

    expect(state.done).toBe(true)
    expect(finishReasonOf(done)).toEqual({ kind: 'stop' })
    expect(closeStream(state)).toEqual([])
  })

  it('非 JSON 的行不得抛出未捕获异常：心跳与半截行一律当成无内容帧', () => {
    const state = createStreamState()

    expect(processStreamLine('data: {not json', state)).toEqual([])
    expect(processStreamLine('data: null', state)).toEqual([])
    expect(processStreamLine('data: [1,2]', state)).toEqual([])
    expect(processStreamLine('', state)).toEqual([])
    expect(state.blocks).toEqual([])
  })

  it('帧里带 error 对象时抛 LlmError，而不是把被切断的回复当成干净结束', () => {
    const state = createStreamState()

    expect(() => processStreamLine('data: {"error":{"message":"upstream vendor failed"}}', state))
      .toThrow(LlmError)
  })
})

describe('Step Code SSE 流：用量与终止顺序', () => {
  it('★ 用量帧先于终止 finish 落地：DSH 在 finish 上结算，迟到的用量不会被记上', () => {
    const state = createStreamState()
    processStreamLine(frame({ content: 'ok' }), state)
    processStreamLine(frame({}, {
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        cached_tokens: 400,
        completion_tokens_details: { reasoning_tokens: 20 },
      },
    }), state)

    const flushed = closeStream(state)
    expect(flushed.map((chunk) => chunk.type)).toEqual(['usage', 'finish'])
    // DSH 的计数是互斥的：1000 总额扣掉 400 缓存读 = 600 未缓存输入。
    expect(usageOf(flushed)).toEqual({
      inputTokens: 600,
      outputTokens: 50,
      cacheReadTokens: 400,
      reasoningTokens: 20,
    })
  })

  it('缓存字段为 0 时不写这个键（用量对象不带一个看起来像 bug 的 0）', () => {
    expect(streamTokenUsage(createStreamState())).toEqual({ inputTokens: 0, outputTokens: 0 })

    const state = createStreamState()
    processStreamLine(frame({}, {
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 5 },
    }), state)
    const usage = usageOf(closeStream(state))

    expect(usage).not.toHaveProperty('cacheWriteTokens')
    expect(usage).not.toHaveProperty('cacheReadTokens')
  })

  it('length 归 max-tokens、工具调用归 tool-calls，其余归 stop', () => {
    const lengthState = createStreamState()
    processStreamLine(frame({}, { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }), lengthState)
    expect(finishReasonOf(closeStream(lengthState))).toEqual({ kind: 'max-tokens' })

    const toolState = createStreamState()
    processStreamLine(
      frame({ tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{}' } }] }),
      toolState,
    )
    // [DONE] 本身就把终止块刷出来了，所以 finish 从这一次调用里读。
    expect(finishReasonOf(processStreamLine('data: [DONE]', toolState))).toEqual({ kind: 'tool-calls' })
  })

  it('★ 中途断开的流不是一次完成的回答：只有终止事件之后 assertStreamComplete 才放行', () => {
    const truncated = createStreamState()
    processStreamLine(frame({ content: '半句' }), truncated)

    expect(() => assertStreamComplete(truncated)).toThrow(LlmError)

    const settled = createStreamState()
    processStreamLine(frame({}, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }), settled)

    expect(() => assertStreamComplete(settled)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 5. 失败归类
// ---------------------------------------------------------------------------

describe('classifyStepCodeFailure：失败落进 harness 的共享词汇', () => {
  it('429 归可重试类 RATE_LIMIT', () => {
    expect(classifyStepCodeFailure(429, '').code).toBe('RATE_LIMIT')
  })

  it('401 / 403 归凭据类 AUTH：号池据此要求重新登录，不进重试集合', () => {
    expect(classifyStepCodeFailure(401, '').code).toBe('AUTH')
    expect(classifyStepCodeFailure(403, '').code).toBe('AUTH')
  })

  it('5xx 归服务端类 SERVER', () => {
    expect(classifyStepCodeFailure(500, '').code).toBe('SERVER')
    expect(classifyStepCodeFailure(503, '').code).toBe('SERVER')
  })

  it('★ 上下文超限被重新归类成 CONTEXT_OVERFLOW_CODE，harness 才能压缩后重试', () => {
    expect(classifyStepCodeFailure(400, 'context_length_exceeded').code).toBe(CONTEXT_OVERFLOW_CODE)
    expect(
      classifyStepCodeFailure(400, 'prompt is too long: 300000 tokens > 256000 maximum').code,
    ).toBe(CONTEXT_OVERFLOW_CODE)
    expect(
      classifyStepCodeFailure(422, 'maximum context length is 256000, requested 300000').code,
    ).toBe(CONTEXT_OVERFLOW_CODE)
  })

  it('上下文超限的判据只在请求被拒的状态上生效：5xx 上的同样措辞仍然是服务端故障', () => {
    expect(classifyStepCodeFailure(500, 'context_length_exceeded').code).toBe('SERVER')
  })

  it('404 是 NOT_FOUND（端点不认这个模型或路由），不是 SERVER', () => {
    expect(classifyStepCodeFailure(404, '').code).toBe('NOT_FOUND')
  })

  it('其余状态落到 PROVIDER_ERROR，状态码透传给错误对象', () => {
    const failure = classifyStepCodeFailure(418, 'teapot')

    expect(failure.code).toBe('PROVIDER_ERROR')
    expect(failure.message).toContain(PROVIDER_NAME)
    // LlmError 把可序列化的上游事实放在 .failure 上，而不是散在消息里。
    expect(failure.failure.status).toBe(418)
  })

  it('错误详情只回引前 600 个字符（失败正文里可能夹带整个请求）', () => {
    const failure = classifyStepCodeFailure(400, 'x'.repeat(5000))

    expect(failure.message.length).toBeLessThan(700)
  })
})
