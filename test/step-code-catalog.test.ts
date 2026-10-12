/**
 * T1 契约测试：Step Code（Step Plan 订阅）线路的**模型目录**（URL 归一化 / 目录解析 /
 * 能力回落 / 未声明行 / 目录装配）。
 *
 * 全部离线：只喂本地构造的上游载荷，**不发任何网络请求**，也不需要任何凭据。
 * 凭据一次都没出现——目录面与凭据面正交，这是本线路的边界要求。
 *
 * 每条 `it` 的标题就是被断言的那条事实本身，脱离本文件也能读懂「上游要求的是什么」。
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONTEXT_WINDOW,
  MODEL_DEFAULTS,
  USABLE_MODEL_TYPES,
} from '../src/host/step-code/types.ts'
import {
  DEFAULT_VISIBLE_MODEL_IDS,
  STEP_CODE_MODEL_CATALOG,
  STEP_CODE_MODEL_IDS,
  type StepCodeModelEntry,
  catalogModelOptions,
  catalogSize,
  catalogTotal,
  normalizeStepCodeApiBaseUrl,
  parseStepCodeModelListing,
  resolveStepCodeModel,
  stepCodeChatCompletionsUrl,
  stepCodeModelsDetailBaseUrl,
  stepCodeModelsUrl,
  undeclaredStepCodeModelEntry,
} from '../src/host/step-code/model-catalog.ts'

/** 国区 Step Plan 的模型面 base（profile 表里逐字的那一条）。 */
const CN_BASE = 'https://api.stepfun.com/step_plan'
/** 国际区 Step Plan 的模型面 base。 */
const INTL_BASE = 'https://api.stepfun.ai/step_plan'

// ---------------------------------------------------------------------------
// URL 归一化
// ---------------------------------------------------------------------------

describe('模型面 URL 归一化', () => {
  it('三种写法加一种残留重复后缀，全部收敛到同一个路由前缀', () => {
    // 官方 Step 接受带版本的操作 URL、/messages 操作、以及 /v1 父路径三种写法；
    // 某个中间版本产出的文件里还可能已经有 /v1/v1/messages。
    expect(normalizeStepCodeApiBaseUrl(CN_BASE)).toBe(CN_BASE)
    expect(normalizeStepCodeApiBaseUrl(CN_BASE + '/v1')).toBe(CN_BASE)
    expect(normalizeStepCodeApiBaseUrl(CN_BASE + '/v1/messages')).toBe(CN_BASE)
    expect(normalizeStepCodeApiBaseUrl(CN_BASE + '/v1/v1/messages')).toBe(CN_BASE)
  })

  it('幂等：对它自己的输出再调用一次结果不变（官方用它修存量配置文件）', () => {
    for (const input of [
      CN_BASE,
      CN_BASE + '/v1',
      CN_BASE + '/v1/messages',
      CN_BASE + '/v1/v1/messages',
      INTL_BASE + '/v1',
    ]) {
      const once = normalizeStepCodeApiBaseUrl(input)
      expect(normalizeStepCodeApiBaseUrl(once)).toBe(once)
    }
  })

  it('剥的是尾部段，不是路径里的任何一段：国际化前缀不被吃掉', () => {
    expect(normalizeStepCodeApiBaseUrl(INTL_BASE)).toBe(INTL_BASE)
    expect(normalizeStepCodeApiBaseUrl('https://api.stepfun.ai/v1')).toBe('https://api.stepfun.ai')
  })

  it('解析不了的输入原样返回，好让正常的校验去报它的问题', () => {
    expect(normalizeStepCodeApiBaseUrl('这不是一个 URL')).toBe('这不是一个 URL')
    expect(normalizeStepCodeApiBaseUrl('')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 派生 URL
// ---------------------------------------------------------------------------

describe('派生 URL', () => {
  it('chat completions 是 {归一化 base}/v1/chat/completions（四条 profile 共这一个方言）', () => {
    expect(stepCodeChatCompletionsUrl(CN_BASE)).toBe(
      'https://api.stepfun.com/step_plan/v1/chat/completions',
    )
    expect(stepCodeChatCompletionsUrl(INTL_BASE)).toBe(
      'https://api.stepfun.ai/step_plan/v1/chat/completions',
    )
  })

  it('模型列表是 {归一化 base}/v1/models', () => {
    expect(stepCodeModelsUrl(CN_BASE)).toBe('https://api.stepfun.com/step_plan/v1/models')
    expect(stepCodeModelsUrl(INTL_BASE)).toBe('https://api.stepfun.ai/step_plan/v1/models')
  })

  it('逐模型详情在域名根的 /v1，不是 {base}/v1 —— 带子路径的那个变体会 404', () => {
    expect(stepCodeModelsDetailBaseUrl(CN_BASE)).toBe('https://api.stepfun.com/v1')
    expect(stepCodeModelsDetailBaseUrl(INTL_BASE)).toBe('https://api.stepfun.ai/v1')
    // 反直觉之处必须钉死：它与列表的 base 不是同一个。
    expect(stepCodeModelsDetailBaseUrl(CN_BASE)).not.toBe(stepCodeModelsUrl(CN_BASE).replace('/models', ''))
    expect(stepCodeModelsDetailBaseUrl(CN_BASE)).not.toContain('/step_plan')
  })

  it('传入环境变量里那种未归一化的原始写法也拼得对', () => {
    // 归一化器只承诺剥掉官方那三种尾部段（/v1/messages、/messages、/v1），
    // 所以这里只喂这三种，不拿一个它没承诺的形状去要求它。
    expect(stepCodeChatCompletionsUrl(CN_BASE + '/v1')).toBe(
      'https://api.stepfun.com/step_plan/v1/chat/completions',
    )
    expect(stepCodeChatCompletionsUrl(CN_BASE + '/v1/messages')).toBe(
      'https://api.stepfun.com/step_plan/v1/chat/completions',
    )
    expect(stepCodeModelsUrl(CN_BASE + '/v1/messages')).toBe(
      'https://api.stepfun.com/step_plan/v1/models',
    )
    expect(stepCodeModelsUrl('https://api.stepfun.com/v1')).toBe(
      'https://api.stepfun.com/v1/models',
    )
  })
})

// ---------------------------------------------------------------------------
// 目录解析
// ---------------------------------------------------------------------------

describe('上游目录解析', () => {
  it('吃 { data: [...] }（OpenAI 形状）与裸数组两种形状', () => {
    const wrapped = parseStepCodeModelListing({ data: [{ id: 'step-1' }, { id: 'step-2' }] })
    expect(wrapped.map((entry) => entry.id)).toEqual(['step-1', 'step-2'])
    const bare = parseStepCodeModelListing([{ id: 'step-1' }, { id: 'step-2' }])
    expect(bare.map((entry) => entry.id)).toEqual(['step-1', 'step-2'])
  })

  it('无 id 的条目被跳过：留着只是让用户点一个必然失败的东西', () => {
    const entries = parseStepCodeModelListing({
      data: [{ id: 'step-1' }, { name: '没有 id 的行' }, { id: '   ' }, { id: 'step-2' }],
    })
    expect(entries.map((entry) => entry.id)).toEqual(['step-1', 'step-2'])
  })

  it('model_type 存在时只保留大语言模型与路由模型，TTS 之类一律滤掉', () => {
    const entries = parseStepCodeModelListing({
      data: [
        { id: 'm-llm', model_type: '大语言模型' },
        { id: 'm-router', model_type: '路由模型' },
        { id: 'm-tts', model_type: 'TTS' },
        { id: 'm-asr', model_type: 'ASR' },
        { id: 'm-image', model_type: '文生图' },
      ],
    })
    expect(entries.map((entry) => entry.id)).toEqual(['m-llm', 'm-router'])
    expect([...USABLE_MODEL_TYPES]).toEqual(['大语言模型', '路由模型'])
  })

  it('整张表都没有 model_type 时不过滤（未公开扩展字段，向后兼容）', () => {
    // 逐条判据会把一个「少报 model_type 的部署」砍成半个目录，
    // 而目录空掉表现为用户看不到任何模型 —— 所以判据是整张表。
    const entries = parseStepCodeModelListing({
      data: [{ id: 'm-a' }, { id: 'm-tts', name: '语音合成' }, { id: 'm-b' }],
    })
    expect(entries.map((entry) => entry.id)).toEqual(['m-a', 'm-tts', 'm-b'])
  })

  it('解析不出任何东西时是空数组，不是 undefined', () => {
    expect(parseStepCodeModelListing(null)).toEqual([])
    expect(parseStepCodeModelListing(undefined)).toEqual([])
    expect(parseStepCodeModelListing({})).toEqual([])
    expect(parseStepCodeModelListing('nope')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 能力回落
// ---------------------------------------------------------------------------

describe('能力回落：端点说了算，缺了就走兜底', () => {
  it('max_input_tokens 缺失时上下文窗口是 DEFAULT_CONTEXT_WINDOW = 256000', () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(256000)
    const [entry] = parseStepCodeModelListing({ data: [{ id: 'm-1' }] })
    expect(entry?.defaultContextWindow).toBe(256000)
    expect(entry?.defaultMaxTokens).toBe(256000)
  })

  it('端点报了 max_input_tokens 就用它，端点不报输出上限时默认等于上下文窗口', () => {
    const [entry] = parseStepCodeModelListing({ data: [{ id: 'm-1', max_input_tokens: 128000 }] })
    expect(entry?.defaultContextWindow).toBe(128000)
    expect(entry?.defaultMaxTokens).toBe(128000)
    expect(MODEL_DEFAULTS.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  it('enable_reason=false 时即使给了档位列表也不产出档位：端点自述不推理比残留列表权威', () => {
    const [entry] = parseStepCodeModelListing({
      data: [{
        id: 'm-1',
        enable_reason: false,
        reasoning_effort_support_list: ['low', 'high'],
      }],
    })
    expect(entry?.reasoningEfforts).toEqual([])
  })

  it('档位列表里认不出的档位被丢弃而不是猜（上游加了新档位时不该发一个模型可能拒绝的值）', () => {
    const [entry] = parseStepCodeModelListing({
      data: [{
        id: 'm-1',
        reasoning_effort_support_list: ['high', 'turbo', 'low', 'ultra'],
      }],
    })
    expect(entry?.reasoningEfforts).toEqual(['low', 'high'])
  })

  it('关闭值 off 在列表里就意味着「思考可关闭」，它本身不是一个档位', () => {
    const [entry] = parseStepCodeModelListing({
      data: [{ id: 'm-1', reasoning_effort_support_list: ['off', 'low', 'high'] }],
    })
    expect(entry?.reasoningEfforts).toEqual(['low', 'high'])
    expect(entry?.thinkingDisableable).toBe(true)
  })

  it('enable_vision_input 决定 supportsImages，端点没说就只认 text', () => {
    const entries = parseStepCodeModelListing({
      data: [
        { id: 'm-vision', enable_vision_input: true },
        { id: 'm-text', enable_vision_input: false },
        { id: 'm-silent' },
      ],
    })
    expect(entries.map((entry) => [entry.id, entry.supportsImages])).toEqual([
      ['m-vision', true],
      ['m-text', false],
      ['m-silent', false],
    ])
  })

  it('任何字段缺失都不让整张目录失败：它全是未公开扩展字段', () => {
    const entries = parseStepCodeModelListing({
      data: [
        { id: 'm-1' },
        { id: 'm-2', max_input_tokens: '不是数字', enable_reason: 'true' },
        { id: 'm-3', max_input_tokens: 0 },
      ],
    })
    expect(entries).toHaveLength(3)
    for (const entry of entries) {
      expect(entry.defaultContextWindow).toBe(DEFAULT_CONTEXT_WINDOW)
    }
  })
})

// ---------------------------------------------------------------------------
// 未声明模型行
// ---------------------------------------------------------------------------

describe('未声明模型行', () => {
  it('查不到时返回一行未声明条目，而不是 undefined：调用方只需处理一种东西', () => {
    const entry = resolveStepCodeModel('不存在的模型')
    expect(entry).toBeDefined()
    expect(entry.id).toBe('不存在的模型')
    expect(entry.description).toBeNull()
  })

  it('未声明行不主张任何能力：空档位、不认图、上下文窗口走兜底', () => {
    const entry = undeclaredStepCodeModelEntry('m-unknown')
    expect(entry.reasoningEfforts).toEqual([])
    expect(entry.supportsImages).toBe(false)
    expect(entry.defaultContextWindow).toBe(DEFAULT_CONTEXT_WINDOW)
    // 目录没声明「恒定开启」，那就永远不发关闭值。
    expect(entry.thinkingDisableable).toBe(true)
  })

  it('未声明行覆盖全部四条 profile，且默认可见——调用它是合法的，未知的只是能力', () => {
    const entry = resolveStepCodeModel('不存在的模型')
    expect([...entry.profiles]).toEqual([
      'step_plan',
      'step_plan_oversea',
      'platform_cn',
      'platform_oversea',
    ])
    expect(catalogModelOptions([entry]).every((option) => option.enabled)).toBe(true)
  })

  it('目录里有这个 id 时返回目录声明的能力，而不是未声明行', () => {
    const catalog = parseStepCodeModelListing({
      data: [{ id: 'm-1', enable_vision_input: true, reasoning_effort_support_list: ['low'] }],
    })
    const entry = resolveStepCodeModel('m-1', catalog)
    expect(entry.supportsImages).toBe(true)
    expect([...entry.reasoningEfforts]).toEqual(['low'])
  })
})

// ---------------------------------------------------------------------------
// 目录 + 用户设置 → 设置面下发
// ---------------------------------------------------------------------------

describe('目录装配成设置面模型行', () => {
  const CATALOG: StepCodeModelEntry[] = parseStepCodeModelListing({
    data: [{ id: 'm-a' }, { id: 'm-b' }, { id: 'm-c' }],
  })

  it('enabledModelIds 缺省或空数组时全部可见（目录是登录后才发现的，没登录时只有一个空数组）', () => {
    expect(CATALOG.map((entry) => entry.id)).toEqual(['m-a', 'm-b', 'm-c'])
    expect(catalogModelOptions(CATALOG).every((option) => option.enabled)).toBe(true)
    expect(catalogModelOptions(CATALOG, {}).every((option) => option.enabled)).toBe(true)
    expect(catalogModelOptions(CATALOG, { enabledModelIds: [] }).every((option) => option.enabled))
      .toBe(true)
  })

  it('enabledModelIds 非空时只勾选列出的那些（含只有一项）', () => {
    const selected = catalogModelOptions(CATALOG, { enabledModelIds: ['m-a', 'm-c'] })
    expect(selected.map((option) => [option.id, option.enabled])).toEqual([
      ['m-a', true],
      ['m-b', false],
      ['m-c', true],
    ])
    const onlyOne = catalogModelOptions(CATALOG, { enabledModelIds: ['m-b'] })
    expect(onlyOne.filter((option) => option.enabled).map((option) => option.id)).toEqual(['m-b'])
  })

  it('上下文窗口覆盖生效，未给覆盖值时用目录声明值', () => {
    const rows = catalogModelOptions(CATALOG, { contextWindowOverrides: { 'm-a': 64000 } })
    const a = rows.find((option) => option.id === 'm-a')
    expect(a?.contextWindow).toBe(64000)
    // 目录声明值仍保留在 defaultContextWindow 上，覆盖不等于改声明。
    expect(a?.defaultContextWindow).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(a?.maxInputTokens).toBe(DEFAULT_CONTEXT_WINDOW)
    const b = rows.find((option) => option.id === 'm-b')
    expect(b?.contextWindow).toBe(b?.defaultContextWindow)
  })

  it('hint 由能力生成而不是手写，所以文案不可能与能力表漂移', () => {
    const [entry] = parseStepCodeModelListing({
      data: [{ id: 'm-1', enable_reason: true, reasoning_effort_support_list: ['low', 'high'] }],
    })
    expect(entry?.hint).toContain('档位 low/high')
    expect(entry?.hint).toContain('上下文 ' + DEFAULT_CONTEXT_WINDOW)
    expect(undeclaredStepCodeModelEntry('m-x').hint.startsWith('未声明模型')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 随包目录与计数
// ---------------------------------------------------------------------------

describe('随包目录与计数', () => {
  it('随包目录刻意为空：官方 STEP_MODELS 就是空的，目录完全靠运行时发现', () => {
    expect([...STEP_CODE_MODEL_CATALOG]).toEqual([])
    expect([...STEP_CODE_MODEL_IDS]).toEqual([])
    expect([...DEFAULT_VISIBLE_MODEL_IDS]).toEqual([])
  })

  it('空目录的 catalogSize / catalogTotal 都是 0', () => {
    expect(catalogSize([])).toBe(0)
    expect(catalogTotal([])).toBe(0)
    expect(catalogSize()).toBe(0)
    expect(catalogTotal()).toBe(0)
  })

  it('两个名字指向同一份逻辑：对同一输入给同一结果', () => {
    const catalog = parseStepCodeModelListing({ data: [{ id: 'm-a' }, { id: 'm-b' }] })
    expect(catalogSize(catalog)).toBe(2)
    expect(catalogTotal(catalog)).toBe(catalogSize(catalog))
    expect(catalogTotal(catalog)).toBe(2)
  })
})
