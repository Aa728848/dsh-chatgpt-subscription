/**
 * W5 的离线测试：GLM（ZCode 账号）线路的模型目录与上游 I/O（目录拉取 / 配额 / 订阅）。
 *
 * 全部离线——不碰网络、不需要真实凭据、不读 `/.zcode。凭据只用脱敏字面量
 * `id.secret`（那是兑换链产出的形状，不是任何一把真 Key）。
 *
 * 覆盖验收标准里的几条硬断言：
 *
 * - 配额请求头是**裸 Key**，没有 `Bearer` 前缀（计划 §3.4 / §8.2）；
 * - 未知 `unit` 一律丢弃、不发明窗口；
 * - `TIME_LIMIT`（MCP 请求上限）不是套餐窗口；
 * - `TOKENS_LIMIT` 与 `CREDIT_LIMIT` 的比例来源不同；
 * - 信封 `success !== true` 时不解析；
 * - 缓存 TTL 行为。
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { GlmRegion } from '../src/shared/glm-coding-plan-contracts.ts'
import {
  DEFAULT_VISIBLE_MODEL_IDS,
  GLM_MODEL_CATALOG,
  GLM_START_PLAN_EXCLUDED_MODEL_IDS,
  GLM_VISION_BRIDGED_BY_PLAN_FACE,
  catalogModelOptions,
  catalogSize,
  describeGlmModel,
  glmModelSupportsImages,
  glmModelWire,
  glmReasoningEfforts,
  isGlmModelId,
  listModelIds,
  modelsForRegion,
  resolveGlmModel,
  undeclaredGlmModelEntry,
} from '../src/host/glm-coding-plan/model-catalog.ts'
import {
  clearCachedCatalog,
  clearCachedQuota,
  fetchCatalog,
  fetchGlmQuota,
  getCachedCatalog,
  getCachedQuota,
  getCachedQuotaFor,
  glmAnthropicProbeHeaders,
  glmOpenAiProbeHeaders,
  isGlmPlanLevel,
  loadCatalog,
  parseCatalogListing,
  parseQuotaLimits,
  parseQuotaSnapshot,
  parseSubscriptionPlan,
  quotaRequestHeaders,
  quotaUrl,
  subscriptionUrl,
} from '../src/host/glm-coding-plan/client.ts'
import {
  CHAT_PATH_ANTHROPIC,
  CHAT_PATH_OPENAI,
  QUOTA_CACHE_TTL_MS,
  QUOTA_PATH,
  QUOTA_ROW_TYPE,
  QUOTA_UNIT_WINDOW,
  SUBSCRIPTION_PATH,
  apiBaseForRegion,
  businessHost,
} from '../src/host/glm-coding-plan/types.ts'

/** 兑换链产出的凭据形状（脱敏字面量，不是任何一把真 Key）。 */
const KEY = 'id-0000.secret-0000'

// ---------------------------------------------------------------------------
// 目录：结构完整性
// ---------------------------------------------------------------------------

describe('GLM 目录逐模型能力表', () => {
  it('每一行的 region 与 wire 合法、hint 非空', () => {
    expect(GLM_MODEL_CATALOG.length).toBeGreaterThan(0)
    for (const entry of GLM_MODEL_CATALOG) {
      expect(entry.id).not.toBe('')
      expect(entry.name).not.toBe('')
      expect(entry.regions.length).toBeGreaterThan(0)
      for (const region of entry.regions) {
        expect(region === 'cn' || region === 'intl').toBe(true)
      }
      // 未声明行是「上游目录里有、本表没转录过」的 id，随包发布的行不允许留空。
      expect(entry.wire === 'anthropic' || entry.wire === 'openai').toBe(true)
      expect(entry.defaultContextWindow).toBeGreaterThan(0)
      expect(entry.defaultMaxTokens).toBeGreaterThan(0)
      expect(entry.defaultMaxTokens).toBeLessThanOrEqual(entry.defaultContextWindow)
      expect(catalogModelOptions([entry])[0]?.hint ?? '').not.toBe('')
    }
  })

  it('hint 由能力行生成，因此写不出与能力表矛盾的话', () => {
    const flash = GLM_MODEL_CATALOG.find((entry) => entry.id === 'GLM-5.3-Flash')
    const flag = GLM_MODEL_CATALOG.find((entry) => entry.id === 'GLM-5.3')
    expect(flash).toBeDefined()
    expect(flag).toBeDefined()
    expect(flag!.hint ?? describeGlmModel(flag!)).toContain('思考恒开')
    // 两行都收图：Coding Plan 面上的视觉是**站点规则**桥接出来的（见
    // GLM_VISION_BRIDGED_BY_PLAN_FACE），不是基础 modelRules 那一层的差异，所以不能在这里
    // 写回计划 §7 那个反例——那是基础规则的事，在本线路的端点上被覆盖掉了。
    expect(flash!.hint ?? describeGlmModel(flash!)).toContain('image')
    expect(flag!.hint ?? describeGlmModel(flag!)).toContain('image')
    expect(flag!.hint ?? describeGlmModel(flag!)).toContain('档位 low/high/max')
  })

  it('梯子逐模型不同，且空数组只落在「不发思考控制字段」那一行', () => {
    expect(glmReasoningEfforts('GLM-5.3')).toEqual(['low', 'high', 'max'])
    // 反例：glm-5.2 两个档位。
    expect(glmReasoningEfforts('GLM-5.2')).toEqual(['high', 'max'])
    // GLM-5-Turbo 不收档位 → 空数组（有意语义：两个 mapper 一个字段都不发）。
    expect(glmReasoningEfforts('GLM-5-Turbo')).toEqual([])
  })

  it('四个模型全是 Coding Plan 模型；缺的反而是 Start Plan 不含 GLM-5.3', () => {
    // 证据：zcode-builtin.json revision 31 的 builtinProviderModelRules 给
    // account:{zai,bigmodel}-{individual,team}-coding-plan 逐条启用这四个 id。
    const ids = GLM_MODEL_CATALOG.map((entry) => entry.id)
    for (const id of ['GLM-5.3', 'GLM-5.3-Flash', 'GLM-5.2', 'GLM-5-Turbo']) {
      expect(ids).toContain(id)
    }
    expect([...GLM_START_PLAN_EXCLUDED_MODEL_IDS]).toEqual(['GLM-5.3'])
    // 套餐归属是**账号**的属性：同一个 id 在 Start Plan 规则下没被启用，
    // 但那不代表它是「Start Plan 独有」——GLM-5.2 / GLM-5-Turbo 同时在 Coding Plan 里。
    expect(GLM_START_PLAN_EXCLUDED_MODEL_IDS).not.toContain('GLM-5.2')
    expect(GLM_START_PLAN_EXCLUDED_MODEL_IDS).not.toContain('GLM-5-Turbo')
  })

  it('视觉能力随端点桥接：两区 Coding Plan 的 Anthropic 基址上全部收图', () => {
    // providerSiteRules 里两条 modelMatch 为 '.*' 的站点规则按 baseUrlMatch 打开 supportsImage，
    // 而这两个地址正是 CHAT_PATH_ANTHROPIC 拼在 apiBaseForRegion() 之后的基址。
    expect([...GLM_VISION_BRIDGED_BY_PLAN_FACE]).toEqual([
      'https://api.z.ai/api/anthropic',
      'https://open.bigmodel.cn/api/anthropic',
    ])
    for (const entry of GLM_MODEL_CATALOG) {
      expect(glmModelSupportsImages(entry.id)).toBe(true)
    }
  })

  it('导出面：listModelIds / catalogSize / 默认勾选', () => {
    expect(listModelIds()).toEqual(GLM_MODEL_CATALOG.map((entry) => entry.id))
    expect(catalogSize()).toBe(GLM_MODEL_CATALOG.length)
    expect([...DEFAULT_VISIBLE_MODEL_IDS]).toEqual(listModelIds())
  })
})

// ---------------------------------------------------------------------------
// 目录：按区域过滤
// ---------------------------------------------------------------------------

describe('GLM 目录的区域过滤', () => {
  const catalog = [
    undeclaredGlmModelEntry('GLM-5.3', { region: 'cn' }),
    undeclaredGlmModelEntry('GLM-5.2', { region: 'cn' }),
    undeclaredGlmModelEntry('GLM-5-Turbo', { region: 'intl' }),
  ]

  it('只返回服务该部署的行', () => {
    expect(modelsForRegion('cn', catalog).map((entry) => entry.id)).toEqual(['GLM-5.3', 'GLM-5.2'])
    expect(modelsForRegion('intl', catalog).map((entry) => entry.id)).toEqual(['GLM-5-Turbo'])
  })

  it('随包目录在两区都给出全部行（官方 builtin 配置两区同表）', () => {
    expect(modelsForRegion('cn').map((entry) => entry.id)).toEqual(modelsForRegion('intl').map((entry) => entry.id))
    expect(modelsForRegion('cn').length).toBe(catalogSize())
  })

  it('随包目录返回的都是已声明协议面的行', () => {
    for (const entry of modelsForRegion('intl')) {
      expect(glmModelWire(entry.id)).not.toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// 目录：未声明行与 id 查找
// ---------------------------------------------------------------------------

describe('GLM 目录的未声明行', () => {
  it('未声明行什么都不主张：不猜协议、不发档位、不认图', () => {
    const entry = undeclaredGlmModelEntry('GLM-9.9-experimental', { region: 'intl' })
    expect(entry.wire).toBeNull()
    expect(entry.reasoningEfforts).toEqual([])
    expect(entry.supportsImages).toBe(false)
    expect(entry.thinkingDisableable).toBe(true)
    expect(entry.regions).toEqual(['intl'])
    expect(entry.hint).toContain('未声明模型')
    expect(entry.hint).not.toBe('')
  })

  it('未知 id 解析成未声明行而不是 undefined，调用方只有一条分支要处理', () => {
    expect(resolveGlmModel('GLM-5.9').wire).toBeNull()
    expect(resolveGlmModel('GLM-5.3').wire).toBe('anthropic')
    expect(isGlmModelId('GLM-5.3')).toBe(true)
    expect(isGlmModelId('GLM-9.9-experimental')).toBe(false)
  })

  it('id 查找大小写不敏感（上游 /models 返回哪种拼写没有实测样本）', () => {
    expect(isGlmModelId('glm-5.3')).toBe(true)
    expect(resolveGlmModel('glm-5.3-flash').supportsImages).toBe(true)
    expect(glmModelSupportsImages('GLM-5.3-FLASH')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 请求头：裸 Key vs Bearer
// ---------------------------------------------------------------------------

describe('GLM 上游请求头', () => {
  it('配额头是裸 Key：没有 Bearer 前缀，也没有 x-api-key', () => {
    const headers = quotaRequestHeaders(KEY)
    expect(headers.authorization).toBe(KEY)
    expect(headers.authorization.startsWith('Bearer ')).toBe(false)
    expect(String(headers.authorization)).not.toMatch(/^Bearer/i)
    expect(headers['x-api-key']).toBeUndefined()
  })

  it('模型面反过来用 Bearer（与配额面正好相反，两处不能互相抄）', () => {
    const openai = glmOpenAiProbeHeaders(KEY)
    expect(openai.authorization).toBe('Bearer ' + KEY)
    expect(openai['x-api-key']).toBeUndefined()

    const anthropic = glmAnthropicProbeHeaders(KEY)
    // Anthropic 面是双头（同值）：只发一个会得到 401 AUTH_MISSING(1001)。
    expect(anthropic['x-api-key']).toBe(KEY)
    expect(anthropic.authorization).toBe('Bearer ' + KEY)
  })

  it('空凭据不变成一个注定被拒的请求', () => {
    expect(() => quotaRequestHeaders('   ')).toThrow()
  })

  it('URL：目录走模型面，配额与订阅走业务面', () => {
    expect(quotaUrl('intl', {})).toBe(businessHost('intl', {}) + QUOTA_PATH)
    expect(subscriptionUrl('intl', {})).toBe(businessHost('intl', {}) + SUBSCRIPTION_PATH)
    expect(apiBaseForRegion('intl', {}) + CHAT_PATH_OPENAI + '/models').toBe(
      apiBaseForRegion('intl', {}) + CHAT_PATH_OPENAI + '/models',
    )
    expect(quotaUrl('cn', {})).not.toBe(quotaUrl('intl', {}))
    expect(CHAT_PATH_ANTHROPIC).not.toBe(CHAT_PATH_OPENAI)
  })
})

// ---------------------------------------------------------------------------
// 配额解析
// ---------------------------------------------------------------------------

describe('GLM 配额解析', () => {
  const tokensPayload = {
    success: true,
    data: {
      level: 'pro',
      limits: [
        { type: QUOTA_ROW_TYPE.tokens, unit: 3, percentage: 42, nextResetTime: 1_800_000_000 },
        { type: QUOTA_ROW_TYPE.tokens, unit: 6, percentage: 13 },
      ],
    },
  }

  it('TOKENS_LIMIT 的已用百分比取 percentage', () => {
    const snapshot = parseQuotaSnapshot(tokensPayload, { now: 1_700_000_000_000 })
    expect(snapshot).not.toBeNull()
    expect(snapshot!.planLevel).toBe('pro')
    expect(snapshot!.fetchedAt).toBe(1_700_000_000_000)
    expect(snapshot!.sources).toEqual([QUOTA_PATH])
    const fiveHour = snapshot!.windows.find((window) => window.key === 'five-hour')
    expect(fiveHour?.usedPercent).toBe(42)
    // nextResetTime 是秒级 → 换算成毫秒。
    expect(fiveHour?.resetsAt).toBe(1_800_000_000_000)
    expect(snapshot!.windows.map((window) => window.key)).toEqual(['five-hour', 'weekly'])
  })

  it('未知 unit 一律丢弃，不发明窗口', () => {
    const snapshot = parseQuotaSnapshot({
      success: true,
      data: {
        limits: [
          { type: QUOTA_ROW_TYPE.tokens, unit: 99, percentage: 80 },
          { type: QUOTA_ROW_TYPE.tokens, unit: 3, percentage: 42 },
        ],
      },
    })
    expect(snapshot!.windows.map((window) => window.key)).toEqual(['five-hour'])
    // unit 映射表就是那三个，测试钉住它以免日后有人「顺手」加一个。
    expect(QUOTA_UNIT_WINDOW[3]).toBe('five-hour')
    expect(QUOTA_UNIT_WINDOW[5]).toBe('monthly')
    expect(QUOTA_UNIT_WINDOW[6]).toBe('weekly')
    // 只有 MCP 请求上限时没有窗口 → 整份快照不可解析（照 glmPlan() 的语义）。
    expect(parseQuotaSnapshot({
      success: true,
      data: { limits: [{ type: QUOTA_ROW_TYPE.time, unit: 99, percentage: 5 }] },
    })).toBeNull()
  })

  it('TIME_LIMIT 是 MCP 请求上限，不是套餐窗口，必须跳过', () => {
    const snapshot = parseQuotaSnapshot({
      success: true,
      data: {
        limits: [
          { type: QUOTA_ROW_TYPE.time, unit: 3, percentage: 99, currentValue: 300, usage: 300 },
          { type: QUOTA_ROW_TYPE.tokens, unit: 5, percentage: 7 },
        ],
      },
    })
    expect(snapshot!.windows.map((window) => window.key)).toEqual(['monthly'])
    expect(snapshot!.windows[0]?.usedPercent).toBe(7)
  })

  it('CREDIT_LIMIT 的比例取 currentValue / usage，而不是 percentage', () => {
    const snapshot = parseQuotaSnapshot({
      success: true,
      data: {
        level: 'max',
        limits: [
          // percentage 与精确比例不同：精确比例优先（照 glmPlan() 的 glmCreditPercent）。
          { type: QUOTA_ROW_TYPE.credit, unit: 3, percentage: 10, currentValue: 25, usage: 100 },
          { type: QUOTA_ROW_TYPE.credit, unit: 6, currentValue: 30, usage: 100 },
        ],
      },
    })
    expect(snapshot!.planLevel).toBe('max')
    expect(snapshot!.windows.map((window) => window.key)).toEqual(['five-hour', 'weekly'])
    expect(snapshot!.windows[0]?.usedPercent).toBe(25)
    expect(snapshot!.windows[1]?.usedPercent).toBe(30)
  })

  it('CREDIT_LIMIT 在比例算不出时退回 percentage', () => {
    const snapshot = parseQuotaSnapshot({
      success: true,
      data: {
        limits: [
          { type: QUOTA_ROW_TYPE.credit, unit: 3, percentage: 10, currentValue: 25, usage: 0 },
        ],
      },
    })
    expect(snapshot!.windows[0]?.usedPercent).toBe(10)
  })

  it('算不出比例时是 null（不是 0%）：画成进度条等于谎报用量', () => {
    const snapshot = parseQuotaSnapshot({
      success: true,
      data: { limits: [{ type: QUOTA_ROW_TYPE.tokens, unit: 3 }] },
    })
    expect(snapshot!.windows[0]?.usedPercent).toBeNull()
    expect(snapshot!.windows[0]?.resetsAt).toBeNull()
  })

  it('信封 success !== true 时不解析', () => {
    expect(parseQuotaSnapshot({ success: false, data: { limits: [{ type: QUOTA_ROW_TYPE.tokens, unit: 3, percentage: 1 }] } })).toBeNull()
    expect(parseQuotaSnapshot({ data: { limits: [{ type: QUOTA_ROW_TYPE.tokens, unit: 3, percentage: 1 }] } })).toBeNull()
    expect(parseQuotaSnapshot({ success: true, data: {} })).toBeNull()
    expect(parseQuotaSnapshot(null)).toBeNull()
    expect(parseQuotaSnapshot('not json')).toBeNull()
  })

  it('同一个窗口键只保留第一行', () => {
    const snapshot = parseQuotaSnapshot({
      success: true,
      data: {
        limits: [
          { type: QUOTA_ROW_TYPE.tokens, unit: 3, percentage: 10 },
          { type: QUOTA_ROW_TYPE.credit, unit: 3, currentValue: 90, usage: 100 },
        ],
      },
    })
    expect(snapshot!.windows).toHaveLength(1)
    expect(snapshot!.windows[0]?.usedPercent).toBe(10)
  })

  it('parseQuotaLimits 只搬运，不过滤（过滤发生在快照层）', () => {
    const rows = parseQuotaLimits({
      success: true,
      data: {
        limits: [
          { type: QUOTA_ROW_TYPE.time, unit: 3, percentage: 1 },
          { type: 'SOMETHING_NEW', unit: 4, percentage: 2 },
          { unit: 4, percentage: 3 },
        ],
      },
    })
    expect(rows.map((row) => row.type)).toEqual([QUOTA_ROW_TYPE.time, 'SOMETHING_NEW'])
  })

  it('套餐机器档位可判定（lite / pro / max）', () => {
    expect(isGlmPlanLevel('pro')).toBe(true)
    expect(isGlmPlanLevel('lite')).toBe(true)
    expect(isGlmPlanLevel('max')).toBe(true)
    expect(isGlmPlanLevel('starter')).toBe(false)
    expect(isGlmPlanLevel(null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 订阅列表
// ---------------------------------------------------------------------------

describe('GLM 订阅列表解析', () => {
  it('读出套餐名与续费时刻（秒级时刻换算成毫秒）', () => {
    const plan = parseSubscriptionPlan({
      success: true,
      data: [{ planName: 'Coding Plan Pro', expireTime: 1_800_000_000 }],
    })
    expect(plan.planName).toBe('Coding Plan Pro')
    expect(plan.renewsAt).toBe(1_800_000_000_000)
  })

  it('读不到就返回 null 字段，不影响配额窗口', () => {
    expect(parseSubscriptionPlan({ success: false, data: [] })).toEqual({ planName: null, renewsAt: null })
    expect(parseSubscriptionPlan(null)).toEqual({ planName: null, renewsAt: null })
    const withoutPlan = parseQuotaSnapshot({
      success: true,
      data: { limits: [{ type: QUOTA_ROW_TYPE.tokens, unit: 3, percentage: 5 }] },
    }, { planName: null, renewsAt: null })
    expect(withoutPlan?.planName).toBeNull()
    expect(withoutPlan?.windows).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 离线 fetch 桩
// ---------------------------------------------------------------------------

interface Recorded {
  url: string
  headers: Record<string, string>
}

/** 按 URL 后缀分派的离线 fetch：记录每次请求，返回指定 JSON。 */
function stubFetch(routes: Array<{ match: string; payload?: unknown; status?: number; body?: string }>): {
  fetchFn: typeof fetch
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, headers: { ...((init?.headers ?? {}) as Record<string, string>) } })
    const route = routes.find((candidate) => url.endsWith(candidate.match))
    if (route === undefined) throw new Error('unexpected url: ' + url)
    const status = route.status ?? 200
    const text = route.body ?? JSON.stringify(route.payload ?? {})
    return new Response(text, { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { fetchFn, calls }
}

const QUOTA_RESPONSE = {
  success: true,
  data: {
    level: 'pro',
    limits: [
      { type: QUOTA_ROW_TYPE.tokens, unit: 3, percentage: 42, nextResetTime: 1_800_000_000 },
      { type: QUOTA_ROW_TYPE.tokens, unit: 5, percentage: 8 },
      { type: QUOTA_ROW_TYPE.time, unit: 1, percentage: 3 },
      { type: QUOTA_ROW_TYPE.tokens, unit: 42, percentage: 50 },
    ],
  },
}

const SUBSCRIPTION_RESPONSE = {
  success: true,
  data: [{ planName: 'Coding Plan Pro', expireTime: 1_800_000_000 }],
}

afterEach(() => {
  clearCachedQuota()
  clearCachedCatalog()
})

describe('GLM 配额读取与缓存', () => {
  it('配额请求头在真实调用里也是裸 Key（回归断言）', async () => {
    const { fetchFn, calls } = stubFetch([
      { match: QUOTA_PATH, payload: QUOTA_RESPONSE },
      { match: SUBSCRIPTION_PATH, payload: SUBSCRIPTION_RESPONSE },
    ])
    await fetchGlmQuota('intl', KEY, { fetchFn })
    const quotaCall = calls.find((call) => call.url.endsWith(QUOTA_PATH))
    expect(quotaCall).toBeDefined()
    expect(quotaCall!.headers.authorization).toBe(KEY)
    expect(quotaCall!.headers.authorization.startsWith('Bearer')).toBe(false)
    expect(quotaCall!.url).toBe(businessHost('intl', {}) + QUOTA_PATH)
  })

  it('快照带上套餐名与续费时刻，来源列出两个端点', async () => {
    const { fetchFn } = stubFetch([
      { match: QUOTA_PATH, payload: QUOTA_RESPONSE },
      { match: SUBSCRIPTION_PATH, payload: SUBSCRIPTION_RESPONSE },
    ])
    const read = await fetchGlmQuota('intl', KEY, { fetchFn })
    expect(read.error).toBeNull()
    expect(read.fromCache).toBe(false)
    expect(read.snapshot?.planName).toBe('Coding Plan Pro')
    expect(read.snapshot?.planLevel).toBe('pro')
    expect(read.snapshot?.renewsAt).toBe(1_800_000_000_000)
    expect(read.snapshot?.sources).toEqual([QUOTA_PATH, SUBSCRIPTION_PATH])
    // 窗口：unit 42 被丢弃，TIME_LIMIT 被跳过。
    expect(read.snapshot?.windows.map((window) => window.key)).toEqual(['five-hour', 'monthly'])
  })

  it('TTL 内命中缓存，不再发请求；force 绕过缓存', async () => {
    const { fetchFn, calls } = stubFetch([
      { match: QUOTA_PATH, payload: QUOTA_RESPONSE },
      { match: SUBSCRIPTION_PATH, payload: SUBSCRIPTION_RESPONSE },
    ])
    const first = await fetchGlmQuota('intl', KEY, { fetchFn, accountId: 'acc-1' })
    const quotaCalls = (): number => calls.filter((call) => call.url.endsWith(QUOTA_PATH)).length
    expect(quotaCalls()).toBe(1)

    const second = await fetchGlmQuota('intl', KEY, { fetchFn, accountId: 'acc-1' })
    expect(second.fromCache).toBe(true)
    expect(second.snapshot).toBe(first.snapshot)
    expect(quotaCalls()).toBe(1)

    const forced = await fetchGlmQuota('intl', KEY, { fetchFn, accountId: 'acc-1', force: true })
    expect(forced.fromCache).toBe(false)
    expect(quotaCalls()).toBe(2)
  })

  it('缓存按账号分桶：一个账号的数字不串给另一个', async () => {
    const { fetchFn } = stubFetch([
      { match: QUOTA_PATH, payload: QUOTA_RESPONSE },
      { match: SUBSCRIPTION_PATH, payload: SUBSCRIPTION_RESPONSE },
    ])
    await fetchGlmQuota('intl', KEY, { fetchFn, accountId: 'acc-1' })
    expect(getCachedQuotaFor('acc-1')).not.toBeNull()
    expect(getCachedQuotaFor('acc-2')).toBeNull()
    // 缺省 id 退回「最新一次读」，那是页面级卡片要的语义。
    expect(getCachedQuota()).not.toBeNull()
    expect(getCachedQuota()).toBe(getCachedQuotaFor('acc-1'))

    clearCachedQuota('acc-1')
    expect(getCachedQuotaFor('acc-1')).toBeNull()
    expect(getCachedQuota()).toBeNull()
  })

  it('TTL 用 types.ts 的常量，且缓存的年龄过 TTL 后重新读', async () => {
    expect(QUOTA_CACHE_TTL_MS).toBe(2 * 60 * 1000)
    const { fetchFn, calls } = stubFetch([
      { match: QUOTA_PATH, payload: QUOTA_RESPONSE },
      { match: SUBSCRIPTION_PATH, payload: SUBSCRIPTION_RESPONSE },
    ])
    await fetchGlmQuota('intl', KEY, { fetchFn, accountId: 'acc-ttl' })
    const realNow = Date.now
    try {
      Date.now = () => realNow() + QUOTA_CACHE_TTL_MS + 1
      const read = await fetchGlmQuota('intl', KEY, { fetchFn, accountId: 'acc-ttl' })
      expect(read.fromCache).toBe(false)
      expect(calls.filter((call) => call.url.endsWith(QUOTA_PATH)).length).toBe(2)
    } finally {
      Date.now = realNow
    }
  })

  it('订阅列表读不到时，窗口照样有效（尽力而为）', async () => {
    const { fetchFn } = stubFetch([
      { match: QUOTA_PATH, payload: QUOTA_RESPONSE },
      { match: SUBSCRIPTION_PATH, status: 500, body: 'boom' },
    ])
    const read = await fetchGlmQuota('intl', KEY, { fetchFn })
    expect(read.error).toBeNull()
    expect(read.snapshot?.planName).toBeNull()
    expect(read.snapshot?.renewsAt).toBeNull()
    expect(read.snapshot?.sources).toEqual([QUOTA_PATH])
    expect(read.snapshot?.windows).toHaveLength(2)
  })

  it('空凭据是调用方的 bug：同步抛出，而不是发一次注定被拒的请求', async () => {
    const { fetchFn, calls } = stubFetch([{ match: QUOTA_PATH, payload: QUOTA_RESPONSE }])
    await expect(fetchGlmQuota('intl', '  ', { fetchFn })).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  it('配额请求失败：返回一句原因，不抛异常（卡片的降级契约）', async () => {
    const { fetchFn } = stubFetch([{ match: QUOTA_PATH, status: 401, body: 'unauthorized' }])
    const read = await fetchGlmQuota('intl', KEY, { fetchFn })
    expect(read.snapshot).toBeNull()
    expect(read.error).toContain('401')
    expect(getCachedQuota()).toBeNull()
  })

  it('配额响应不可解析时给出原因，而不是一份空快照', async () => {
    const { fetchFn } = stubFetch([{ match: QUOTA_PATH, body: 'not json' }])
    const read = await fetchGlmQuota('intl', KEY, { fetchFn })
    expect(read.snapshot).toBeNull()
    expect(read.error).not.toBeNull()

    const refused = stubFetch([{ match: QUOTA_PATH, payload: { success: false, data: {} } }])
    const refusedRead = await fetchGlmQuota('intl', KEY, { fetchFn: refused.fetchFn, force: true })
    expect(refusedRead.snapshot).toBeNull()
    expect(refusedRead.error).toContain('success')
  })
})

// ---------------------------------------------------------------------------
// 模型目录拉取
// ---------------------------------------------------------------------------

describe('GLM 模型目录拉取', () => {
  const LISTING = {
    data: [
      { id: 'GLM-5.3', context_window: 1_000_000 },
      { id: 'GLM-5.3-Flash' },
      { id: 'GLM-9.9-experimental', context_window: 512_000 },
    ],
  }

  it('实时列表只补窗口，能力声明仍以随包目录为准', () => {
    const entries = parseCatalogListing(LISTING, 'intl')
    expect(entries.map((entry) => entry.id)).toEqual(['GLM-5.3', 'GLM-5.3-Flash', 'GLM-9.9-experimental'])
    const flag = entries[0]!
    expect(flag.defaultContextWindow).toBe(1_000_000)
    expect(flag.reasoningEfforts).toEqual(['low', 'high', 'max'])
    // 能力取随包目录的值，而随包目录里这个值是 true（站点规则把 Coding Plan 两个 Anthropic
    // 基址上的视觉打开了）。本用例真正要钉的是「实时列表不改动能力」，所以断言的是**目录值**，
    // 不是某个写死的 false——写死 false 会把能力表改成什么样都测不出来。
    expect(flag.supportsImages).toBe(GLM_MODEL_CATALOG.find((entry) => entry.id === 'GLM-5.3')!.supportsImages)
    expect(flag.supportsImages).toBe(true)
    expect(flag.wire).toBe('anthropic')
    // 列表没报窗口 → 保留随包目录的值，而不是变成 undefined。
    expect(entries[1]!.defaultContextWindow).toBe(1_000_000)
  })

  it('目录里没有的 id 进目录时是「未声明模型」', () => {
    const entry = parseCatalogListing(LISTING, 'intl')[2]!
    expect(entry.id).toBe('GLM-9.9-experimental')
    expect(entry.wire).toBeNull()
    expect(entry.reasoningEfforts).toEqual([])
    expect(entry.supportsImages).toBe(false)
    expect(entry.regions).toEqual(['intl'])
    expect(entry.defaultContextWindow).toBe(512_000)
  })

  it('打的是 Coding Plan 专用面的 /models，且用 Bearer', async () => {
    const { fetchFn, calls } = stubFetch([{ match: '/models', payload: LISTING }])
    await fetchCatalog('cn', KEY, { fetchFn })
    const call = calls[0]!
    expect(call.url).toBe(apiBaseForRegion('cn', {}) + CHAT_PATH_OPENAI + '/models')
    expect(call.headers.authorization).toBe('Bearer ' + KEY)
  })

  it('拉不到就回落随包目录，不把模型选择器清空', async () => {
    const failing = async () => { throw new Error('offline') }
    const entries = await loadCatalog('intl', KEY, { fetchFn: failing as typeof fetch })
    expect(entries.map((entry) => entry.id)).toEqual(modelsForRegion('intl').map((entry) => entry.id))
    expect(entries.length).toBe(catalogSize())
    expect(getCachedCatalog('intl')).toEqual([])
  })

  it('读到空列表同样回落随包目录', async () => {
    const { fetchFn } = stubFetch([{ match: '/models', payload: { data: [] } }])
    const entries = await loadCatalog('intl', KEY, { fetchFn })
    expect(entries.length).toBe(catalogSize())
  })

  it('成功读到的目录进入缓存，下一次直接命中', async () => {
    const { fetchFn, calls } = stubFetch([{ match: '/models', payload: LISTING }])
    const first = await loadCatalog('intl', KEY, { fetchFn })
    expect(first.length).toBe(3)
    expect(calls).toHaveLength(1)
    const second = await loadCatalog('intl', KEY, { fetchFn })
    expect(second).toEqual(first)
    expect(calls).toHaveLength(1)
    expect(getCachedCatalog('intl').length).toBe(3)
    // 另一区域的缓存不许顶替（否则调用方的区域过滤会一行不剩）。
    expect(getCachedCatalog('cn')).toEqual([])
    clearCachedCatalog()
    expect(getCachedCatalog('intl')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 装配成设置面的模型行
// ---------------------------------------------------------------------------

describe('GLM 目录装配成设置面模型行', () => {
  it('全选 + 覆盖窗口', () => {
    const options = catalogModelOptions(undefined, { contextWindowOverrides: { 'GLM-5.2': 64_000 } })
    expect(options.every((option) => option.enabled)).toBe(true)
    const glm52 = options.find((option) => option.id === 'GLM-5.2')!
    expect(glm52.contextWindow).toBe(64_000)
    expect(glm52.defaultContextWindow).toBe(1_000_000)
    expect(glm52.hint).not.toBe('')
  })

  it('取消勾选与 null 覆盖（恢复目录默认）', () => {
    const options = catalogModelOptions(undefined, {
      enabledModelIds: ['GLM-5.3'],
      contextWindowOverrides: { 'GLM-5.3': null },
    })
    expect(options.filter((option) => option.enabled).map((option) => option.id)).toEqual(['GLM-5.3'])
    expect(options.find((option) => option.id === 'GLM-5.3')!.contextWindow).toBe(1_000_000)
  })

  it('未声明行默认不勾选，wire 落到封闭联合上，但目录层面仍然是 null（D3 不猜协议）', () => {
    const [option] = catalogModelOptions([undeclaredGlmModelEntry('GLM-9.9-experimental')])
    expect(option!.wire).toBe('anthropic')
    expect(option!.enabled).toBe(false)
    expect(option!.hint).toContain('未声明模型')
    expect(glmModelWire('GLM-9.9-experimental')).toBeNull()
    // 用户显式勾选时才启用——但适配器仍必须先用 glmModelWire 拒绝它。
    const [opted] = catalogModelOptions(
      [undeclaredGlmModelEntry('GLM-9.9-experimental')],
      { enabledModelIds: ['GLM-9.9-experimental'] },
    )
    expect(opted!.enabled).toBe(true)
  })
})

describe('GLM 区域类型', () => {
  it('两区都有可服务的模型', () => {
    for (const region of ['cn', 'intl'] as GlmRegion[]) {
      expect(modelsForRegion(region).length).toBe(catalogSize())
    }
  })
})
