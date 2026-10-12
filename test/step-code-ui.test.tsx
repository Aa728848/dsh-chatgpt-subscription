// @vitest-environment jsdom
/**
 * Step Code（Step Plan 订阅）设置卡片。
 *
 * 覆盖的是本线路在 UI 上必须成立的四件事，每一件都在别的线路里不成立：
 *
 *   1. 卡片能从自己的 `/step-code/api` 读口渲染出账号区、额度区与模型清单；
 *   2. `quota` 为 null（没登录 / 没读到）时不崩，且说「暂无配额数据」而不是画 0%；
 *   3. 两代套餐**分别**渲染：老式窗口画百分比进度条，Credit 桶画绝对量——
 *      把两者揉成一条「看起来一样」的条，等于画出上游从没说过存在的东西；
 *   4. 缓存区**只有 token 维度**：官方单价全为 0，所以整页不出现任何金额，
 *      而写侧恒为 0 必须被显式声明（`always-zero-on-this-route`）而不是画一条 0 的条。
 *
 * 全程 mock fetch，且**只在本线路自己的前缀下应答**：越界的请求直接抛错，
 * 免得「卡片碰巧问错了地方」被一份通用的假答案悄悄盖住。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  STEP_CODE_CACHE_READ_FIELD_ORDER,
  STEP_CODE_CACHE_WRITE_NOTE,
  STEP_CODE_PROVIDER_ID,
  STEP_CODE_ROUTE_PREFIX,
  type StepCodeAccountSummaryDto,
  type StepCodeCacheStatsDto,
  type StepCodeModelOption,
  type StepCodeQuotaSnapshotDto,
  type StepCodeStatusDto,
} from '../src/shared/step-code-contracts.ts'
import { StepCodeSection } from '../src/client/step-code/StepCodeSection.tsx'
import { zh } from '../src/client/step-code/locales.ts'

const PREFIX = STEP_CODE_ROUTE_PREFIX

const DAY = 24 * 3_600_000

/** 一个池内账号。区域是凭据的属性，所以与 profile 一起给出。 */
function account(overrides: Partial<StepCodeAccountSummaryDto> = {}): StepCodeAccountSummaryDto {
  return {
    id: 'cn:primary',
    alias: 'me@stepfun.com',
    isPrimary: true,
    profile: 'step_plan',
    region: 'cn',
    accountName: '控制台显示名',
    ...overrides,
  }
}

/** host 由运行时发现的目录给出的模型行；hint 由 host 生成，客户端一个字都不改写。 */
function model(id: string, overrides: Partial<StepCodeModelOption> = {}): StepCodeModelOption {
  return {
    id,
    name: id,
    hint: '思考档位 low / high · 上下文 200K',
    enabled: false,
    defaultContextWindow: 200_000,
    contextWindow: 200_000,
    defaultMaxTokens: 200_000,
    reasoningEfforts: ['low', 'high'],
    thinkingDisableable: true,
    supportsImages: false,
    maxInputTokens: 200_000,
    profiles: ['step_plan'],
    description: null,
    ...overrides,
  }
}

/** 老式窗口套餐的快照。 */
function windowedQuota(overrides: Partial<StepCodeQuotaSnapshotDto> = {}): StepCodeQuotaSnapshotDto {
  return {
    kind: 'windowed',
    planName: 'Step Plan Pro',
    planFamily: 1,
    windows: [
      { key: 'five-hour', usedPercent: 42, resetsAt: Date.now() + 2 * 3_600_000 },
      // 上游没给有界额度时 usedPercent 为 null：「不知道」与「一点没花」必须长得不一样。
      { key: 'weekly', usedPercent: null, resetsAt: null },
    ],
    creditBuckets: [],
    renewsAt: Date.now() + 30 * DAY,
    fetchedAt: Date.now(),
    sources: ['/api/user/quota'],
    region: 'cn',
    ...overrides,
  }
}

/** 新式 Credit 月池的快照。 */
function creditQuota(overrides: Partial<StepCodeQuotaSnapshotDto> = {}): StepCodeQuotaSnapshotDto {
  return {
    kind: 'credit',
    planName: 'Step Plan Credit',
    planFamily: 2,
    windows: [],
    creditBuckets: [
      { total: 1_000_000, remaining: 250_000, expiresAt: Date.now() + 20 * DAY, resetsAt: Date.now() + 20 * DAY },
    ],
    renewsAt: Date.now() + 30 * DAY,
    fetchedAt: Date.now(),
    sources: ['/api/user/credit'],
    region: 'cn',
    ...overrides,
  }
}

function status(overrides: Partial<StepCodeStatusDto> = {}): StepCodeStatusDto {
  return {
    enabled: true,
    authenticated: true,
    hasCredentials: true,
    providerId: STEP_CODE_PROVIDER_ID,
    storagePath: 'DPAPI: /tmp/step-code-credentials.json.dpapi',
    profile: 'step_plan',
    account: account(),
    quota: windowedQuota(),
    lastFetchedAt: Date.now(),
    quotaError: null,
    models: [
      model('step-3.5-flash', { enabled: true }),
      model('step-3.5-pro', { enabled: true, supportsImages: true }),
      model('step-2-mini'),
    ],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
    login: { status: 'idle' },
    accounts: [account()],
    activeAccountId: 'cn:primary',
    rotationStrategy: 'sequential',
    cacheRequestParams: false,
    serving: true,
    conflict: null,
    ...overrides,
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null
let realFetch: typeof fetch | undefined

/** 挂载卡片；只在本线路前缀下应答，越界请求当场抛错。 */
async function mountSection(payload: StepCodeStatusDto): Promise<{
  node: HTMLDivElement
  calls: Array<{ url: string; method: string }>
}> {
  realFetch ??= globalThis.fetch
  const calls: Array<{ url: string; method: string }> = []
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET' })
    if (!url.startsWith(PREFIX)) throw new Error(`unexpected request outside ${PREFIX}: ${url}`)
    return Response.json({ ok: true, value: payload })
  }) as typeof fetch
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(StepCodeSection, {})))
  return { node: container, calls }
}

/** 按组标题取出本线路的某个区块（卡片是一串 .dsha-group）。 */
function groupOf(node: HTMLElement, heading: string): HTMLElement {
  return [...node.querySelectorAll<HTMLElement>('.dsha-group')]
    .find((group) => group.querySelector('.dsha-grouphead')?.textContent?.includes(heading))!
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  await act(async () => {
    try {
      root?.unmount()
    } catch {
      // 已经卸载过。
    }
  })
  root = null
  container?.remove()
  container = null
  if (realFetch !== undefined) globalThis.fetch = realFetch
  realFetch = undefined
})

describe('Step Code 设置卡片', () => {
  it('一个 /status 读口渲染出账号区、额度区与模型清单，且只在自己的前缀下说话', async () => {
    const { node, calls } = await mountSection(status())

    // 账号区：共享账号池卡片。
    expect(node.querySelector('.dsha-account-card')).not.toBeNull()
    expect(node.querySelectorAll('.dsha-account-card')).toHaveLength(1)
    // 账号自己的凭据属性也画出来了：区域是凭据的属性，不是请求的属性。
    expect(node.textContent).toContain(zh.regionCn)
    expect(node.textContent).toContain('控制台显示名')

    // 额度区：套餐名、套餐形态与本线路的每个窗口行。
    const quotaGroup = groupOf(node, zh.quotaSection)
    expect(quotaGroup.textContent).toContain('Step Plan Pro')
    expect(quotaGroup.textContent).toContain(zh.quotaKindWindowed)

    // 模型区：目录里的每一行都在。
    expect(node.querySelectorAll('.dsh-mcl-option')).toHaveLength(3)

    // 一个网络包都不许发到本线路的前缀之外。
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((call) => call.url.startsWith(PREFIX))).toBe(true)
  })

  it('账号区与 Claude / GLM 同一形态：登录入口全在标题行，下面没有独立的「登录授权」区', async () => {
    const { node } = await mountSection(status())
    // 标题行 = 带着 .dsha-account-add-actions 的那个 .dsha-grouphead（页面上还有别的 grouphead）。
    const head = [...node.querySelectorAll<HTMLElement>('.dsha-grouphead')]
      .find((entry) => entry.querySelector('.dsha-account-add-actions'))!
    expect(head).toBeDefined()
    const actions = [...head.querySelectorAll<HTMLButtonElement>('button.dsha-btn')]
    // 两条登录路径并排在标题行：浏览器授权 + 免去一次登录的导入本机登录态。
    expect(actions.map((button) => button.textContent)).toEqual([zh.addAccount, zh.adopt])
    // 护栏：第三个按钮会被 .dsha-account-add-actions 的 flex-wrap 挤到下一行（需求方实测反馈），
    // 所以手工粘贴兜底留在下面的兜底入口行，不进标题行。
    expect(actions).toHaveLength(2)

    // 「登录授权」那个小标题整块没有了；idle 那一行住在兜底入口行里。
    expect(node.textContent).not.toContain('登录授权')
    const paste = node.querySelector<HTMLButtonElement>('.dshsc-paste button[aria-expanded]')
    expect(paste).not.toBeNull()
    expect(paste!.closest('.dsha-grouphead')).toBeNull()
  })

  it('quota 为 null 不崩，且说「暂无配额数据」而不是画一条 0% 的条', async () => {
    // 没登录没额度是本线路最常见的状态（旧 host 还没发这个字段也算）。
    const { node } = await mountSection(status({ quota: null }))

    // 整棵子树照常渲染：崩溃点会在这里表现为容器为空。
    expect(node.querySelector('.dsha-page')).not.toBeNull()
    expect(node.querySelectorAll('.dsh-mcl-option')).toHaveLength(3)

    const quotaGroup = groupOf(node, zh.quotaSection)
    expect(quotaGroup.textContent).toContain(zh.quotaEmpty)
    // 「没数据」不得被渲染成「用完了」。
    expect(quotaGroup.querySelector('[role="progressbar"]')).toBeNull()
    expect(quotaGroup.textContent).not.toContain('0%')
  })

  it('两代套餐各画各的：老式窗口画百分比，Credit 桶画绝对量', async () => {
    const windowed = await mountSection(status({ quota: windowedQuota() }))
    const windowedQuotaGroup = groupOf(windowed.node, zh.quotaSection)
    expect(windowedQuotaGroup.textContent).toContain(zh.quotaKindWindowed)
    const windowBar = windowedQuotaGroup.querySelector('[role="progressbar"]')
    expect(windowBar?.getAttribute('aria-valuenow')).toBe('42')
    // 没给百分比的窗口说「上游没给已用百分比」，不是 0%。
    expect(windowedQuotaGroup.textContent).toContain(zh.quotaUsedUnknown)
    // 老式套餐没有桶，绝不画桶那一套。
    expect(windowedQuotaGroup.textContent).not.toContain(zh.quotaBucketRemaining)
    await act(async () => root!.unmount())
    root = null
    container?.remove()
    container = null

    const credit = await mountSection(status({ quota: creditQuota() }))
    const creditQuotaGroup = groupOf(credit.node, zh.quotaSection)
    expect(creditQuotaGroup.textContent).toContain(zh.quotaKindCredit)
    expect(creditQuotaGroup.textContent).toContain(zh.quotaWindowCredit)
    expect(creditQuotaGroup.textContent).toContain(zh.quotaBucketRemaining)
    expect(creditQuotaGroup.querySelector('.dshsc-bucket')).not.toBeNull()
    // 桶是绝对量：把它折成一个百分比需要自选分母，那折出来的是编的。
    expect(creditQuotaGroup.querySelector('[role="progressbar"]')).toBeNull()
    expect(creditQuotaGroup.textContent).not.toContain('25%')
  })

  it('缓存区只有 token 维度：不出现任何金额，写侧显式声明恒为 0', async () => {
    const cacheStats: StepCodeCacheStatsDto = {
      cacheReadTokens: 600,
      missedInputTokens: 400,
      // 本线路恒为 0：这不是「这次恰好没写缓存」，是线路事实。
      cacheWriteTokens: 0,
      requests: 3,
    }
    const { node } = await mountSection(status({ cacheStats }))
    const cacheGroup = groupOf(node, zh.cacheSection)
    const text = cacheGroup.textContent ?? ''

    // 读侧：token 维度与命中率，还有 host 那一侧优先级的逐字披露。
    expect(text).toContain(zh.cacheReadTokens)
    expect(text).toContain(zh.cacheMissedTokens)
    expect(text).toContain('600')
    expect(text).toContain('400')
    expect(text).toContain('60%')
    expect(text).toContain(STEP_CODE_CACHE_READ_FIELD_ORDER.join(' → '))

    // 写侧：标出线路事实，且显式带上那个常量本身，而不是画一条永远是 0 的条。
    expect(text).toContain(zh.cacheWriteNote)
    expect(text).toContain(zh.cacheWriteNoteValue)
    expect(text).toContain(STEP_CODE_CACHE_WRITE_NOTE)
    expect(text).toContain(zh.cacheWriteNoteHint)

    // 单价未文档化（官方模型表里四个 cost 键全是 0），所以这一块**没有任何金额**。
    // 币种符号、元、USD/CNY/RMB 一个都不许出现——拿 0 当单价算出「省了 0 元」是
    // 正确但无用，拿编的费率算出「省了 N 元」是撒谎。
    expect(text).not.toMatch(/[¥￥$€]|\b(?:USD|CNY|RMB)\b|元/)
    expect(text).toContain(zh.cachePricingNote)
  })

  it('认不出套餐形状时只说「认不出」，一个进度条都不画', async () => {
    const { node } = await mountSection(status({
      quota: windowedQuota({ kind: 'unknown', windows: [], creditBuckets: [], planName: null }),
    }))
    const quotaGroup = groupOf(node, zh.quotaSection)
    expect(quotaGroup.textContent).toContain(zh.quotaKindUnknown)
    expect(quotaGroup.querySelector('[role="progressbar"]')).toBeNull()
  })
})
