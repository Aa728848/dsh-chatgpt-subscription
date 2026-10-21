/**
 * T1 契约测试：Step Code（Step Plan 订阅）线路的**共享契约**（线路身份 / profile / 档位词汇 /
 * 缓存常量 / 凭据边界）。
 *
 * 全部离线：不碰网络、不需要任何凭据、不读用户目录（`test/setup/isolated-home.ts`
 * 已把 `DSH_HOME` 指到私有临时目录）。
 *
 * 每条 `it` 的标题就是被断言的那条事实本身，脱离本文件也能读懂「上游 / 契约要求的是什么」。
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { StepCodeProfile, StepCodeRegion } from '../src/shared/step-code-contracts.ts'
import {
  STEP_CODE_CACHE_READ_FIELD_ORDER,
  STEP_CODE_CACHE_REQUEST_PARAMS_DEFAULT,
  STEP_CODE_CACHE_WRITE_NOTE,
  STEP_CODE_PRICING_STATUS,
  STEP_CODE_PROFILES,
  STEP_CODE_PROMPT_CACHE_KEY_MAX_LENGTH,
  STEP_CODE_PROVIDER_ID,
  STEP_CODE_PROVIDER_NAME,
  STEP_CODE_REASONING_EFFORTS,
  STEP_CODE_ROUTE_PREFIX,
  isStepCodeProfile,
  isStepCodeReasoningEffort,
  isStepCodeRegion,
  stepCodeRegionOf,
} from '../src/shared/step-code-contracts.ts'
import {
  PROFILE_HOSTS,
  PROVIDER_ID,
  PROVIDER_NAME,
  STEP_CODE_EFFORTS,
} from '../src/host/step-code/types.ts'

// ---------------------------------------------------------------------------
// 线路身份
// ---------------------------------------------------------------------------

describe('Step Code 线路身份', () => {
  it('provider id 是 step-code，与官方客户端的 step 不同名', () => {
    expect(STEP_CODE_PROVIDER_ID).toBe('step-code')
  })

  it('显示名固定为「Step Code（Step Plan 订阅）」', () => {
    expect(STEP_CODE_PROVIDER_NAME).toBe('Step Code（Step Plan 订阅）')
  })

  it('host 侧只做 re-export，不得自己另写一份字面量', () => {
    expect(PROVIDER_ID).toBe(STEP_CODE_PROVIDER_ID)
    expect(PROVIDER_NAME).toBe(STEP_CODE_PROVIDER_NAME)
  })

  it('路由前缀是 /step-code/api：不挂到 Codex 那条线路的 /api/dsh-chatgpt-subscription 下面', () => {
    expect(STEP_CODE_ROUTE_PREFIX).toBe('/step-code/api')
    expect(STEP_CODE_ROUTE_PREFIX.startsWith('/api/dsh-chatgpt-subscription')).toBe(false)
  })

  it('与仓库里已存在的每一条线路 id 都不相同', () => {
    // 既有线路的注册 id，逐条列出（新建一条线路时这里必须同步补一行）。
    const existing = [
      'codex-chatgpt',
      'command-code',
      'claude-subscription',
      'kimi-code',
      'antigravity',
      'ollama',
      'minimax-code',
      'glm-coding-plan',
    ]
    for (const other of existing) expect(STEP_CODE_PROVIDER_ID).not.toBe(other)
    // 线路的短名也不能撞：注册 id 撞车会让适配器抢占同一条 Provider 路由。
    for (const short of ['claude', 'step', 'stepfun']) {
      expect(STEP_CODE_PROVIDER_ID).not.toBe(short)
    }
  })
})

// ---------------------------------------------------------------------------
// 四条 profile
// ---------------------------------------------------------------------------

describe('四条凭据 profile', () => {
  it('取值与官方 STEP_LOGIN_PROFILE_IDS 逐字相同，一个不多一个不少', () => {
    expect([...STEP_CODE_PROFILES]).toEqual([
      'step_plan',
      'step_plan_oversea',
      'platform_cn',
      'platform_oversea',
    ])
  })

  it('区域由 profile 唯一决定：.com 国区、.ai 国际区', () => {
    const cn: StepCodeProfile[] = ['step_plan', 'platform_cn']
    const intl: StepCodeProfile[] = ['step_plan_oversea', 'platform_oversea']
    for (const profile of cn) expect(stepCodeRegionOf(profile)).toBe('cn')
    for (const profile of intl) expect(stepCodeRegionOf(profile)).toBe('intl')
    // 逐字照抄官方 onboarding.ts 的域名归属，不靠名字猜。
    for (const profile of cn) expect(new URL(PROFILE_HOSTS[profile].api).hostname.endsWith('.com')).toBe(true)
    for (const profile of intl) expect(new URL(PROFILE_HOSTS[profile].api).hostname.endsWith('.ai')).toBe(true)
  })

  it('四张 profile 表都在，且模型面 base 一条自带一个', () => {
    const cover: Record<StepCodeProfile, boolean> = {
      step_plan: PROFILE_HOSTS.step_plan !== undefined,
      step_plan_oversea: PROFILE_HOSTS.step_plan_oversea !== undefined,
      platform_cn: PROFILE_HOSTS.platform_cn !== undefined,
      platform_oversea: PROFILE_HOSTS.platform_oversea !== undefined,
    }
    expect(Object.values(cover)).toEqual([true, true, true, true])
    // 加一条区域时不得静默继承另一条的端点：四条 base 互不相同。
    const bases = STEP_CODE_PROFILES.map((profile) => PROFILE_HOSTS[profile].api)
    expect(new Set(bases).size).toBe(bases.length)
  })

  it('profile 守卫只认这四条自由输入', () => {
    for (const profile of STEP_CODE_PROFILES) expect(isStepCodeProfile(profile)).toBe(true)
    expect(isStepCodeProfile('step_plan_cn')).toBe(false)
    expect(isStepCodeProfile('STEP_PLAN')).toBe(false)
    expect(isStepCodeProfile('')).toBe(false)
    expect(isStepCodeProfile(undefined)).toBe(false)
    expect(isStepCodeProfile(null)).toBe(false)
    expect(isStepCodeProfile(3)).toBe(false)
  })

  it('区域守卫只认 cn 与 intl', () => {
    const regions: StepCodeRegion[] = ['cn', 'intl']
    for (const region of regions) expect(isStepCodeRegion(region)).toBe(true)
    expect(isStepCodeRegion('global')).toBe(false)
    expect(isStepCodeRegion('CN')).toBe(false)
    expect(isStepCodeRegion('')).toBe(false)
    expect(isStepCodeRegion(undefined)).toBe(false)
    expect(isStepCodeRegion(null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 档位词汇
// ---------------------------------------------------------------------------

describe('思考档位词汇表', () => {
  it('线路级词汇表就是 DSH 的完整六档，从低到高', () => {
    expect([...STEP_CODE_REASONING_EFFORTS]).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
  })

  it('host 侧用同一份数组，不另建一份', () => {
    expect(STEP_CODE_EFFORTS).toBe(STEP_CODE_REASONING_EFFORTS)
  })

  it('守卫认表内每一项', () => {
    for (const effort of STEP_CODE_REASONING_EFFORTS) expect(isStepCodeReasoningEffort(effort)).toBe(true)
  })

  it('守卫不认关闭值与非法值：关闭是模型自己的属性，不在线路词汇表里', () => {
    expect(isStepCodeReasoningEffort('off')).toBe(false)
    expect(isStepCodeReasoningEffort('none')).toBe(false)
    expect(isStepCodeReasoningEffort('')).toBe(false)
    expect(isStepCodeReasoningEffort(123)).toBe(false)
    expect(isStepCodeReasoningEffort(undefined)).toBe(false)
    expect(isStepCodeReasoningEffort(null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------

describe('缓存常量（官方对 Step 端点一个缓存参数都不发）', () => {
  it('请求侧缓存参数出厂即关：官方 prompt_cache_key 硬绑 api.openai.com', () => {
    expect(STEP_CODE_CACHE_REQUEST_PARAMS_DEFAULT).toBe(false)
  })

  it('prompt_cache_key 长度上限是 64 个码点', () => {
    expect(STEP_CODE_PROMPT_CACHE_KEY_MAX_LENGTH).toBe(64)
  })

  it('缓存读入量的解析优先级按这个顺序', () => {
    expect([...STEP_CODE_CACHE_READ_FIELD_ORDER]).toEqual([
      'prompt_tokens_details.cached_tokens',
      'cache_read_input_tokens',
      'cached_tokens',
      'prompt_cache_hit_tokens',
    ])
  })

  it('★ 优先级链里必须含顶层 cached_tokens：Step 官方文档只给这个字段，命中判据就是它 > 0', () => {
    // 本线路区别于仓库现行诊断层的关键点，所以单独一条断言点名它：
    // 只把它当别人的兜底，上游真的只报这个字段时卡片就会显示「没命中」。
    expect(STEP_CODE_CACHE_READ_FIELD_ORDER).toContain('cached_tokens')
    // 而且它要落在这条链上（index 2，紧跟 OpenAI 与 Anthropic 两条规范字段之后）。
    expect(STEP_CODE_CACHE_READ_FIELD_ORDER.indexOf('cached_tokens')).toBe(2)
  })

  it('缓存写入量在本线路恒为 0，卡片据此显式声明而不是留一个看起来像 bug 的 0', () => {
    expect(STEP_CODE_CACHE_WRITE_NOTE).toBe('always-zero-on-this-route')
  })

  it('官方单价表全为 0，因此用量卡片只剩 token 维度、不展示金额', () => {
    expect(STEP_CODE_PRICING_STATUS).toBe('undocumented-zero')
  })
})

// ---------------------------------------------------------------------------
// 边界：任何凭据都不越过 host / client 这条线
// ---------------------------------------------------------------------------

describe('契约边界不传凭据', () => {
  const contractsSource = readFileSync(
    new URL('../src/shared/step-code-contracts.ts', import.meta.url),
    'utf8',
  )
  // 去掉注释后再扫：注释里出现 api_key / Oasis-Token 是在解释「为什么不过边界」，不算字段。
  const codeOnly = contractsSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')

  /**
   * 凭据字段名的判据：这些名字一旦作为 DTO 属性出现，就意味着凭据被下发给了客户端。
   * 任务书点名的那几个（`access` / `api_key` / `apiKey` / `secret`）连同同族的
   * `password` / `token` 一起收在这条正则里。
   */
  const CREDENTIAL_FIELD = /^[ \t]*(access|apiKey|api_key|secret|password|token)\??:/

  it('扫描器本身抓得住真凭据名（阳性对照，防止它退化成空转）', () => {
    const planted = [
      'export interface X {',
      '  access: string',
      '  apiKey?: string',
      '  oasisToken: string',
      '  model: string',
      '}',
    ].join('\n')
    const caught = planted
      .split('\n')
      .filter((line) => CREDENTIAL_FIELD.test(line))
      .map((line) => (CREDENTIAL_FIELD.exec(line)?.[1]) ?? '')
    expect(caught).toEqual(['access', 'apiKey'])
    // oasisToken 不在任务书点名的那批里，但它同样是被这条边界禁止的；
    // 所以这条扫描器另有一支更宽的正则把 `*token` 也兜住。
    const wider = /^[ \t]*(access\w*|api_?key|\w*secret\w*|password|\w*token\w*)\??:/i
    expect(wider.test('  oasisToken: string')).toBe(true)
    expect(wider.test('  model: string')).toBe(false)
  })

  it('共享契约里没有任何凭据形状的 DTO 属性（0 命中）', () => {
    const offenders = codeOnly
      .split('\n')
      .filter((line) => CREDENTIAL_FIELD.test(line))
      .map((line) => line.trim())
    expect(offenders).toEqual([])
  })

  /**
   * 两个已知的安全名，逐个说明为什么不是凭据。
   *
   * 宽正则用 `\w*token\w*` 兜住 `oasisToken` 这类同族名字，代价是
   * `defaultMaxTokens` / `maxInputTokens` 也会落进同一支——它们单位是 token 个数，
   * 值是一个整数。白名单写死在这里而不是放宽正则：放宽就等于把 `apiKey` 一起放过。
   */
  const SAFE_FIELD_NAMES = new Set([
    'defaultMaxTokens', // 输出上限，单位是 token 个数，值是一个整数
    'maxInputTokens', // 目录报的 max_input_tokens，同上
    // 缓存用量 DTO（StepCodeCacheStatsDto）：三个都是 token **个数**，不是凭据。
    // 它们命中宽正则是因为名字里带 token，而这三项恰恰是本线路最想被看见的数字——
    // 一个「读入多少、未命中多少」的统计，与「用哪个 token 通过鉴权」毫无关系。
    'cacheReadTokens',
    'missedInputTokens',
    'cacheWriteTokens',
  ])
  const WIDE_CREDENTIAL_FIELD =
    /^[ \t]*(access\w*|api_?key|\w*secret\w*|password|\w*token\w*)\??:/i

  it('更宽的一支也一样：任何以 token / access / secret 结尾的字段名都不过边界', () => {
    const offenders = codeOnly
      .split('\n')
      .filter((line) => WIDE_CREDENTIAL_FIELD.test(line))
      .map((line) => (WIDE_CREDENTIAL_FIELD.exec(line)?.[1]) ?? '')
      .filter((name) => !SAFE_FIELD_NAMES.has(name))
    expect(offenders).toEqual([])
  })

  it('白名单名字确实在用（否则白名单会变成免检的死条目）', () => {
    const declared = codeOnly
      .split('\n')
      .filter((line) => WIDE_CREDENTIAL_FIELD.test(line))
      .map((line) => (WIDE_CREDENTIAL_FIELD.exec(line)?.[1]) ?? '')
    for (const name of SAFE_FIELD_NAMES) expect(declared).toContain(name)
  })

  it('凭据的字面名（api_key / Oasis-Token）连注释之外都不出现', () => {
    expect(codeOnly).not.toMatch(/api_key/)
    expect(codeOnly).not.toMatch(/Oasis-Token/i)
    expect(codeOnly).not.toMatch(/access/i)
  })

  it('额度凭据只以「状态」过边界：DTO 只给有没有、从哪来、什么时候过期、读它出了什么问题', () => {
    expect(codeOnly).toMatch(/interface StepCodeQuotaCredentialStatusDto/)
    const status = contractsSource.slice(
      contractsSource.indexOf('export interface StepCodeQuotaCredentialStatusDto'),
    )
    expect(status).toMatch(/hasCredential: boolean/)
    expect(status).toMatch(/source: 'auto' \| 'manual' \| null/)
  })
})
