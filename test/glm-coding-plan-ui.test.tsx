// @vitest-environment jsdom
/**
 * GLM（ZCode 账号）设置卡片与输入框胶囊。
 *
 * 三条需求方的 UI 硬要求在这里各自可验证：
 *   1. 配额显示额度 —— 账号卡里的进度条（标签 + role=progressbar + 百分比 + 重置倒计时）；
 *   2. 模型选择「图标 + 描述」—— 每行一个品牌标记加一句 host 生成的能力描述；
 *   3. 登录状态机的四种 status 各自渲染出不同的话，而不是同一个空盒子。
 *
 * 全程 mock fetch：卡片只在自己的路由前缀下说话，测试一个网络包都不发。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GLM_CODING_PLAN_PROVIDER_ID,
  GLM_CODING_PLAN_ROUTE_PREFIX,
  type GlmAdoptResultDto,
  type GlmAccountSummaryDto,
  type GlmLoginFlowStatus,
  type GlmModelOption,
  type GlmStatusDto,
} from '../src/shared/glm-coding-plan-contracts.ts'
import { GlmCodingPlanSection } from '../src/client/glm-coding-plan/GlmCodingPlanSection.tsx'
import { GlmCodingPlanComposerQuota, selectBadgeFacts } from '../src/client/glm-coding-plan/GlmCodingPlanComposerQuota.tsx'
import { formatDate } from '../src/client/common/format.ts'
import { adoptReasonText, zh } from '../src/client/glm-coding-plan/locales.ts'
import { GLM_CODING_PLAN_PROVIDER_NAME } from '../src/shared/glm-coding-plan-contracts.ts'
import { HubOverview } from '../src/client/hub/HubOverview.tsx'
import { zh as hubZh } from '../src/client/locales.ts'
import { accountPoolZh } from '../src/client/common/account-pool-labels.ts'

const PREFIX = GLM_CODING_PLAN_ROUTE_PREFIX

const DAY = 24 * 3_600_000

/** 一个已登录的账号行，带一条 5 小时窗口的配额快照。 */
function account(overrides: Record<string, unknown> = {}): GlmAccountSummaryDto {
  return {
    id: 'cn:primary',
    alias: 'user@bigmodel.cn',
    isPrimary: true,
    region: 'cn',
    organizationId: 'org-1',
    quota: {
      fetchedAt: Date.now(),
      // label 传空串：窗口名由共享配额条按 windowDurationMins 本地化，
      // 客户端不硬编码「5 小时」。
      windows: [{ label: '', usedPercent: 42, windowDurationMins: 300, resetsAt: Date.now() + 2 * DAY }],
    },
    ...overrides,
  }
}

/** host 由随包目录给出的模型行；hint 由 host 生成，客户端一个字都不改写。 */
function model(id: string, overrides: Partial<GlmModelOption> = {}): GlmModelOption {
  return {
    id,
    name: id,
    hint: '思考恒定开启（无档位） · 上下文 200K',
    enabled: false,
    defaultContextWindow: 200_000,
    contextWindow: 200_000,
    defaultMaxTokens: 131_072,
    reasoningEfforts: [],
    thinkingDisableable: false,
    wire: 'anthropic',
    supportsImages: false,
    regions: ['cn', 'intl'],
    description: null,
    ...overrides,
  }
}

function status(overrides: Partial<GlmStatusDto> = {}): GlmStatusDto {
  return {
    enabled: true,
    authenticated: true,
    hasCredentials: true,
    providerId: GLM_CODING_PLAN_PROVIDER_ID,
    storagePath: 'DPAPI: /tmp/glm-credentials.json.dpapi',
    region: 'cn',
    account: null,
    quota: {
      planName: 'GLM Coding Plan Pro',
      planLevel: 'pro',
      windows: [{ key: 'five-hour', usedPercent: 42, resetsAt: Date.now() + 2 * DAY }],
      renewsAt: Date.now() + 30 * DAY,
      fetchedAt: Date.now(),
      sources: ['/api/monitor/usage/quota/limit'],
    },
    lastFetchedAt: Date.now(),
    quotaError: null,
    models: [
      model('GLM-5.3', { enabled: true, reasoningEfforts: ['low', 'high', 'max'] }),
      model('GLM-5.3-Flash', { enabled: true, supportsImages: true }),
      model('GLM-5.2'),
    ],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
    login: null,
    accounts: [account()],
    activeAccountId: 'cn:primary',
    rotationStrategy: 'sequential',
    serving: true,
    conflict: null,
    ...overrides,
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null
let realFetch: typeof fetch | undefined

/** 挂载卡片；`respond` 先行拦截某条路由，用来回答 POST 才有区别的那些。 */
async function mountSection(
  payload: GlmStatusDto,
  respond?: (url: string, init?: RequestInit) => Response | undefined,
): Promise<{ node: HTMLDivElement; calls: Array<{ url: string; method: string; body: unknown }> }> {
  realFetch ??= globalThis.fetch
  const calls: Array<{ url: string; method: string; body: unknown }> = []
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    const custom = respond?.(url, init)
    if (custom !== undefined) return custom
    return Response.json({ ok: true, value: payload })
  }) as typeof fetch
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(GlmCodingPlanSection, {})))
  return { node: container, calls }
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  // jsdom 没有 window.open；卡片在开流成功后用它打开授权页。
  vi.stubGlobal('open', vi.fn())
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

describe('GLM 设置卡片', () => {
  it('一个 status 读口渲染出账号区、模型区与配额区', async () => {
    const { node } = await mountSection(status())
    // 账号区（共享账号池卡片）+ 每个账号自己的配额进度条。
    expect(node.querySelector('.dsha-account-card')).not.toBeNull()
    expect(node.querySelectorAll('.dsha-account-card')).toHaveLength(1)
    // 配额区：套餐名与档位在页面上，各窗口的进度在账号卡里。
    const groups = [...node.querySelectorAll('.dsha-group')]
    const quotaGroup = groups.find((group) => group.textContent?.includes(zh.quotaSection))!
    expect(quotaGroup.textContent).toContain('GLM Coding Plan Pro')
    expect(quotaGroup.textContent).toContain('pro')
    // 模型区：目录里的每一行都在。
    expect(node.querySelectorAll('.dsh-mcl-option')).toHaveLength(3)
  })

  it('额度类型如实显示：付费套餐 / 免费体验额度 / 未判定三句话，且免费额度不被渲染成套餐', async () => {
    // 有付费套餐：说「付费套餐」。
    const paid = await mountSection(status({ allowance: 'plan' }))
    expect(paid.node.textContent).toContain(zh.quotaAllowancePlan)

    // 免费体验额度：说「免费体验额度」，而且**不得**出现套餐名或档位——
    // 把免费额度画成套餐就是谎报，而这条正是本次改动要避免的。
    const trial = await mountSection(status({
      allowance: 'free-trial',
      quota: null,
    }))
    expect(trial.node.textContent).toContain(zh.quotaAllowanceFreeTrial)
    expect(trial.node.textContent).not.toContain('GLM Coding Plan Pro')

    // 读不出来就说读不出来，不默认成付费套餐。
    const unknown = await mountSection(status({ allowance: 'unknown', quota: null }))
    expect(unknown.node.textContent).toContain(zh.quotaAllowanceUnknown)
    expect(unknown.node.textContent).not.toContain(zh.quotaAllowancePlan)
  })

  it('详情页不画线路总开关（它只在 hub 卡片上），但区域选择必须留着', async () => {
    const { node } = await mountSection(status())
    // 线路开关唯一的座位是 hub 卡片：详情页再画一个只会与那里的状态不同步。
    // 模型勾选用的是 role=checkbox 的行，不是 input[type=checkbox]，所以这里能这么断言。
    expect(node.querySelector('input[type="checkbox"]')).toBeNull()
    expect(node.textContent).not.toContain('启用此线路')
    // 区域不能跟着一起删：两个登录按钮各自固定一区，导入与粘贴要知道往哪一区发。
    expect(node.querySelector('select[aria-label="' + zh.region + '"]')).not.toBeNull()
  })

  it('配额画成「标签 + 进度条 + 百分比 + N 天后重置」，窗口名不硬编码', async () => {
    const { node } = await mountSection(status())
    const row = node.querySelector('.dsha-account-quota-row')!
    expect(row).not.toBeNull()
    // 标签：共享组件按 windowDurationMins 本地化，这里用同一套 Intl 复算一次。
    const name = row.querySelector('.dsha-account-quota-name')?.textContent ?? ''
    expect(name).toBe(new Intl.NumberFormat(undefined, { style: 'unit', unit: 'hour', unitDisplay: 'long' }).format(5))
    expect(name).not.toBe('5 小时')
    // 进度条 + 百分比。
    const bar = row.querySelector('[role="progressbar"]')!
    expect(bar.getAttribute('aria-valuenow')).toBe('42')
    expect(bar.getAttribute('aria-valuemax')).toBe('100')
    expect(row.textContent).toContain('42%')
    // 重置时间是一个倒计时，不是一个空横线。
    const reset = row.querySelector('.dsha-account-quota-meta')?.textContent ?? ''
    expect(reset).not.toBe('—')
    expect(reset.length).toBeGreaterThan(0)
    // 「已用尽」是共享组件在 >=100% 时替掉百分比的那句话。
    const exhausted = await mountSection(status({
      accounts: [account({ quota: { fetchedAt: Date.now(), windows: [{ label: '', usedPercent: 100, windowDurationMins: 43_200, resetsAt: null }] } })],
    }))
    expect(exhausted.node.querySelector('.dsha-account-quota-row')?.textContent).toContain(accountPoolZh.quotaExhausted)
  })

  it('模型行给出品牌图标 + 模型名 + host 生成的一句话描述 + 行尾勾', async () => {
    const payload = status()
    const { node } = await mountSection(payload)
    const row = node.querySelector<HTMLElement>('.dsh-mcl-option[title="GLM-5.3"]')!
    expect(row).not.toBeNull()
    // 图标：modelBrandMark('GLM-5.3') 命中本线路的品牌标记（不是别人的）。
    const mark = row.querySelector('svg')
    expect(mark).not.toBeNull()
    // 标记是智谱官方 logo.svg 里那个方形标记：三条 currentColor path，第一条的起点
    // M16.5376 认出是本线路而不是别人的。它曾是一块 <text>GLM</text> 字标——那是本地
    // 自选的占位图形；换成官方标记后 svg 的 textContent 恒为空，所以改为按图形本身
    // 断言，判别力比原来查字符串更强（别人的标记不会恰好是这三条 path）。
    expect(mark?.querySelectorAll('path')).toHaveLength(3)
    expect(mark?.querySelector('path')?.getAttribute('d')).toMatch(/^M16\.5376 /)
    // 名称与描述：描述逐字取契约里的 hint，客户端不改写。
    expect(row.querySelector('.dsh-mcl-name')?.textContent).toBe(payload.models[0]!.name)
    expect(row.querySelector('.dsh-mcl-hint')?.textContent).toBe(payload.models[0]!.hint)
    // 行尾勾是 aria-checkbox 的一部分。
    expect(row.getAttribute('role')).toBe('checkbox')
    expect(row.getAttribute('aria-checked')).toBe('true')
    expect(row.querySelector('.dsh-mcl-check')?.innerHTML).not.toBe('')
    // 表头的 {count}/{total}。
    expect(node.querySelector('.dsh-mcl-count')?.textContent).toBe('2/3')
  })

  it('勾选模型通过 settings 路由提交，勾选状态由 host 回的整份状态决定', async () => {
    const { node, calls } = await mountSection(status())
    await act(async () => node.querySelector<HTMLButtonElement>('.dsh-mcl-option[title="GLM-5.2"]')?.click())
    const commit = calls.find((call) => call.url === `${PREFIX}/settings` && call.method === 'POST')
    expect(commit?.body).toEqual({ enabledModelIds: ['GLM-5.3', 'GLM-5.3-Flash', 'GLM-5.2'] })
  })

  it('全选 / 全不选也走同一条 settings 路由', async () => {
    const { node, calls } = await mountSection(status())
    const clear = [...node.querySelectorAll<HTMLButtonElement>('.dsh-mcl-action')]
      .find((button) => button.textContent === zh.unselectAll)!
    await act(async () => clear.click())
    expect(calls.find((call) => call.url === `${PREFIX}/settings`)?.body).toEqual({ enabledModelIds: [] })
    const select = [...node.querySelectorAll<HTMLButtonElement>('.dsh-mcl-action')]
      .find((button) => button.textContent === zh.selectAll)!
    await act(async () => select.click())
    const posts = calls.filter((call) => call.url === `${PREFIX}/settings`)
    expect(posts[posts.length - 1]?.body).toEqual({ enabledModelIds: ['GLM-5.3', 'GLM-5.3-Flash', 'GLM-5.2'] })
  })

  it('账号管理标题行就是全部登录入口：一个「添加账号」+「导入本机登录态」，下面直接是账号列表', async () => {
    const { node } = await mountSection(status())
    // 标题行 = 带着 .dsha-account-add-actions 的那个 .dsha-grouphead（页面上还有别的 grouphead）。
    const head = [...node.querySelectorAll('.dsha-grouphead')]
      .find((entry) => entry.querySelector('.dsha-account-add-actions'))
    expect(head).toBeDefined()
    const actions = [...head!.querySelectorAll<HTMLButtonElement>('button.dsha-btn')]
    // 两条登录路径都在标题行里，与 Claude 卡同款：浏览器授权的主按钮，加上免去一次登录的
    // 「导入本机登录态」。区域不再是两个按钮——它由上面那张卡的 select 决定，主按钮按当前区域发起。
    expect(actions.map((button) => button.textContent)).toEqual([zh.addAccount, zh.adopt])
    // 护栏：仍然只允许两个。第三个数一多，.dsha-account-add-actions 的 flex-wrap 就把它挤到下一行
    // （需求方的实测反馈），而手工粘贴兜底因此留在下面的兜底入口行，不进标题行。
    expect(actions).toHaveLength(2)

    // 独立的「登录授权」区整块没有了：idle 时页面上只剩标题行、账号列表与一行兜底入口。
    // 这条 status 的 login 是 null：入口不依赖某一次流程状态，所以两条路径都点得到。
    expect(node.textContent).not.toContain('登录授权')
    expect(actions.map((button) => button.disabled)).toEqual([false, false])
    // 兜底入口行在、且不在标题行里。
    const paste = node.querySelector<HTMLButtonElement>('.dshglm-paste button[aria-expanded]')
    expect(paste).not.toBeNull()
    expect(paste!.closest('.dsha-grouphead')).toBeNull()
  })

  it('连接测试把 host 的 GlmConnectionDto 说成人话', async () => {
    const { node, calls } = await mountSection(status(), (url) =>
      url === `${PREFIX}/connection/test`
        ? Response.json({ ok: true, value: { connected: true, latencyMs: 123, account: null, model: 'GLM-5.3', checkedAt: Date.now() } })
        : undefined)
    await act(async () => [...node.querySelectorAll<HTMLButtonElement>('.dsha-btn')]
      .find((button) => button.textContent === zh.testConnection)?.click())
    expect(calls.some((call) => call.url === `${PREFIX}/connection/test` && call.method === 'POST')).toBe(true)
    expect(node.textContent).toContain(zh.testSuccess)
    expect(node.textContent).toContain('123')
    expect(node.textContent).toContain('GLM-5.3')
  })
})

describe('登录状态机', () => {
  const cases: Array<{ name: string; login: GlmLoginFlowStatus; expect: (node: HTMLDivElement) => void }> = [
    {
      // host 的 flow 是进程内变量，重启 host 后回到 idle，而这一档用的默认 status 里号池
      // 已经有一个账号（authenticated: true）。这时卡片必须说「已有 N 个账号可用」，
      // 不能再自称「尚未开始登录」——那与卡片正上方的账号区自相矛盾。
      name: 'idle（号池已有账号）',
      login: { status: 'idle', region: 'cn' },
      expect: (node) => {
        // 「登录授权」那个小标题随独立登录区一起去掉了；idle 那一行现在住在兜底入口行里。
        expect(node.textContent).not.toContain('登录授权')
        expect(node.querySelector('.dshglm-paste-note')?.textContent)
          .toContain(zh.loginHaveAccounts.replace('{count}', '1'))
        expect(node.textContent).toContain(zh.loginHaveAccounts.replace('{count}', '1'))
        expect(node.textContent).not.toContain(zh.loginIdle)
        // idle 不该凭空给出一个授权链接。
        expect(node.querySelector('a[href]')).toBeNull()
      },
    },
    {
      name: 'pending',
      login: {
        status: 'pending',
        region: 'intl',
        authorizeUrl: 'https://chat.z.ai/api/oauth/authorize?client_id=x',
        pollIntervalSec: 3,
        startedAt: Date.now(),
        expiresAt: Date.now() + 300_000,
        progress: '等待浏览器授权',
      },
      expect: (node) => {
        expect(node.textContent).toContain(zh.loginPending)
        // 授权页可点，且地址就是 host 下发的那个。
        const link = node.querySelector<HTMLAnchorElement>('.dshglm-flow a.dsha-btn')!
        expect(link.getAttribute('href')).toBe('https://chat.z.ai/api/oauth/authorize?client_id=x')
        expect(node.querySelector('.dshglm-flow-url')?.textContent)
          .toBe('https://chat.z.ai/api/oauth/authorize?client_id=x')
        // 进度与轮询间隔都在页面上。
        expect(node.textContent).toContain('等待浏览器授权')
        expect(node.textContent).toContain(zh.pollEvery.replace('{seconds}', '3'))
        expect(node.textContent).toContain(zh.progress)
      },
    },
    {
      name: 'complete',
      login: { status: 'complete', region: 'cn', email: 'user@bigmodel.cn', completedAt: Date.now() },
      expect: (node) => {
        expect(node.textContent).toContain(zh.loginComplete)
        expect(node.textContent).toContain('user@bigmodel.cn')
        // 完成之后不再催一个授权链接。
        expect(node.querySelector('.dshglm-flow-url')).toBeNull()
      },
    },
    {
      name: 'error',
      login: { status: 'error', region: 'cn', error: 'flow_not_found', retryable: false },
      expect: (node) => {
        expect(node.textContent).toContain(zh.loginError)
        expect(node.textContent).toContain('flow_not_found')
        // 不可重试的失败给的是「重试也没用」那一句，而不是相反的那句。
        expect(node.textContent).toContain(zh.loginNotRetryable)
        expect(node.textContent).not.toContain(zh.loginRetryable)
      },
    },
    {
      name: 'error + retryable',
      login: { status: 'error', region: 'cn', error: 'network', retryable: true },
      expect: (node) => {
        expect(node.textContent).toContain(zh.loginRetryable)
      },
    },
  ]

  it.each(cases)(`渲染 status=$name 各自不同的话`, async ({ login, expect: check }) => {
    const { node } = await mountSection(status({ login }))
    check(node)
  })

  it('idle 且号池真的空着时，才说「尚未开始登录」', async () => {
    // 三态的另一半：号池里一个账号都没有，idle 才真的是「尚未开始登录」。
    const { node } = await mountSection(status({
      login: { status: 'idle', region: 'cn' },
      accounts: [],
      authenticated: false,
      hasCredentials: false,
    }))
    expect(node.textContent).toContain(zh.loginIdle)
    // 另一条路会渲染成「号池里已有 0 个账号可用」——那是在谎报。
    expect(node.textContent).not.toContain(zh.loginHaveAccounts.replace('{count}', '0'))
  })

  it('complete 时显示成功（含完成时间），且不再出现「尚未开始登录」', async () => {
    const completedAt = Date.now() - 60_000
    const { node } = await mountSection(status({
      login: { status: 'complete', region: 'intl', email: 'a@example.com', completedAt },
    }))
    expect(node.textContent).toContain(zh.loginComplete)
    // 成功这件事必须占住版面：host 保留这条终态直到下一次开流，用户随时能回来看它。
    expect(node.textContent).not.toContain(zh.loginIdle)
    // 完成时刻是「成功」唯一的时间证据（账号池那几行会被下一次登录刷新）。
    expect(node.textContent).toContain(zh.loginCompletedAt.replace('{time}', formatDate(completedAt)))
  })

  it('账号之后被删掉时不谎报「已加入号池」', async () => {
    // host 把 complete 保留到下一次开流，所以这条横幅会在账号被删之后仍然显示。
    const { node } = await mountSection(status({
      login: { status: 'complete', region: 'intl', email: 'a@example.com', completedAt: Date.now() },
      accounts: [],
      authenticated: false,
      hasCredentials: false,
    }))
    expect(node.textContent).not.toContain(zh.loginComplete)
    expect(node.textContent).toContain(zh.loginCompleteNoAccount)
  })
  it('「取消登录」是流程控制：只在 pending 时出现，且不在粘贴行里', async () => {
    const cancelOf = (root: HTMLElement): HTMLButtonElement | undefined =>
      [...root.querySelectorAll<HTMLButtonElement>('.dsha-btn')]
        .find((button) => button.textContent === zh.cancelLogin)

    // 没有进行中的流程时就没有可取消的东西：idle / complete / error 都不该给这个按钮。
    for (const login of [
      { status: 'idle', region: 'cn' },
      { status: 'complete', region: 'cn', email: 'a@example.com', completedAt: Date.now() },
      { status: 'error', region: 'cn', error: 'flow_not_found', retryable: false },
    ] as GlmLoginFlowStatus[]) {
      const idleish = await mountSection(status({ login }))
      expect(cancelOf(idleish.node)).toBeUndefined()
      idleish.node.remove()
    }

    const { node, calls } = await mountSection(status({
      login: { status: 'pending', region: 'intl', authorizeUrl: 'https://chat.z.ai/api/oauth/authorize' },
    }))
    const cancel = cancelOf(node)!
    expect(cancel).toBeDefined()
    // 位置：与流程状态同级（流程块内），**不在**手工粘贴那一行里——
    // 放在粘贴行里会让人以为它只影响粘贴。
    expect(cancel.closest('.dshglm-flow')).not.toBeNull()
    expect(cancel.closest('.dshglm-paste')).toBeNull()
    expect(cancel.closest('.dshglm-paste-row')).toBeNull()
    await act(async () => cancel.click())
    expect(calls.some((call) => call.url === `${PREFIX}/login/cancel` && call.method === 'POST')).toBe(true)
  })

  it('没有进行中的流程时手工粘贴兜底收起，但随时可以展开（功能不删）', async () => {
    const { node } = await mountSection(status({ login: { status: 'idle', region: 'cn' } }))
    const toggle = node.querySelector<HTMLButtonElement>('.dshglm-paste button[aria-expanded]')!
    expect(toggle).not.toBeNull()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // 收起时它不占版面：整个输入区都不在 DOM 里。
    expect(node.querySelector('.dshglm-paste input')).toBeNull()

    // 收起的唯一代价是一次点击：回调被拦时用户仍然拿得到那个唯一的出路。
    await act(async () => toggle.click())
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(node.querySelector('.dshglm-paste input')).not.toBeNull()
    // 展开一次之后可以再收起。
    await act(async () => toggle.click())
    expect(node.querySelector('.dshglm-paste input')).toBeNull()
  })

  it('登录失败时兜底同样自动展开（那时它是用户唯一还能做的事）', async () => {
    const { node } = await mountSection(status({
      login: { status: 'error', region: 'cn', error: 'flow_not_found', retryable: false },
    }))
    expect(node.querySelector<HTMLButtonElement>('.dshglm-paste button[aria-expanded]')?.getAttribute('aria-expanded'))
      .toBe('true')
    expect(node.querySelector('.dshglm-paste input')).not.toBeNull()
  })
  it('pending 时仍然渲染手工粘贴兜底，回车即提交', async () => {
    const { node, calls } = await mountSection(status({
      login: { status: 'pending', region: 'intl', authorizeUrl: 'https://chat.z.ai/api/oauth/authorize' },
    }))
    // 区域选择器决定粘贴码落在哪一区（两个登录按钮各自固定区域，不用它）。
    const region = node.querySelector<HTMLSelectElement>('select[aria-label="' + zh.region + '"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(region, 'intl')
      region.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const input = node.querySelector<HTMLInputElement>('.dshglm-paste input')!
    expect(input).not.toBeNull()
    expect(input.getAttribute('aria-label')).toBe(zh.manualPasteSection)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'code=abc123')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(calls.find((call) => call.url === `${PREFIX}/login/manual` && call.method === 'POST')?.body)
      .toEqual({ region: 'intl', code: 'code=abc123' })
  })
})

describe('adopt 入口', () => {
  const reasons = [
    'no-credentials-file',
    'secret-unavailable',
    'decrypt-failed',
    'token-expired',
    'exchange-failed',
    'not-a-zcode-login',
  ] as const

  /** 点 adopt 按钮，并让 host 回指定的 adopt 结果。 */
  async function runAdopt(result: GlmAdoptResultDto) {
    const harness = await mountSection(status({ accounts: [], authenticated: false, hasCredentials: false }), (url, init) =>
      url === `${PREFIX}/adopt` && init?.method === 'POST'
        ? Response.json({ ok: true, value: result })
        : undefined)
    // 导入入口在账号管理的标题行里（与「添加账号」并排），因此按那一条取按钮。
    const head = [...harness.node.querySelectorAll('.dsha-grouphead')]
      .find((entry) => entry.querySelector('.dsha-account-add-actions'))!
    const button = [...head.querySelectorAll<HTMLButtonElement>('button.dsha-btn')]
      .find((entry) => entry.textContent === zh.adopt)!
    await act(async () => button.click())
    return harness.node
  }

  it('成功时说出采用的区域', async () => {
    const node = await runAdopt({ attempted: true, adopted: true, region: 'intl' })
    expect(node.textContent).toContain(zh.adoptAdopted.replace('{region}', zh.regionIntl))
  })

  it.each(reasons)('失败 reason=%s 给出属于自己的那一句，并提示可回落浏览器登录', async (reason) => {
    const node = await runAdopt({ attempted: reason !== 'no-credentials-file', adopted: false, reason })
    expect(node.textContent).toContain(adoptReasonText(reason, zh))
    expect(node.textContent).toContain(zh.adoptFallback)
  })

  it('导入结果落在账号区正文里（不在标题行里），且可当场关掉', async () => {
    const adopted = zh.adoptAdopted.replace('{region}', zh.regionCn)
    const node = await runAdopt({ attempted: true, adopted: true, region: 'cn' })
    const row = [...node.querySelectorAll<HTMLElement>('.dsha-row')]
      .find((entry) => entry.textContent?.includes(adopted))
    expect(row).toBeDefined()
    // 按钮在标题行里，结果行是账号区正文里紧挨着它的那一行：一行 space-between 的标题行
    // 放不下第二段文字，所以结果不能跟着按钮一起进标题行；但它仍在**同一个账号区**里，
    // 点了按钮不会在远处看到结果。
    expect(row!.closest('.dsha-group')).not.toBeNull()
    expect(row!.closest('.dsha-grouphead')).toBeNull()

    // 「知道了」当场清掉它，不留在版面上。
    const dismiss = [...row!.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === zh.dismiss)!
    expect(dismiss).toBeDefined()
    await act(async () => dismiss.click())
    expect(node.textContent).not.toContain(adopted)
  })

  it('每个 reason 说的是不同的话（不是同一个兜底串）', () => {
    const sentences = reasons.map((reason) => adoptReasonText(reason, zh))
    expect(new Set(sentences).size).toBe(reasons.length)
  })
})

describe('hub 卡片（进入入口）', () => {
  /** 一条只含 GLM 的 overview 应答：hub 只画注册表里有 id 的卡片。 */
  function mountCard() {
    const calls: Array<{ url: string; body: unknown }> = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
      if (url.includes('/hub/overview')) {
        return Response.json({ ok: true, value: { providers: [{
          id: GLM_CODING_PLAN_PROVIDER_ID,
          providerId: `${GLM_CODING_PLAN_PROVIDER_ID}-provider`,
          canToggle: true,
          enabled: true,
          accountCount: 2,
          authenticated: true,
          enabledModelCount: 3,
          totalModelCount: 4,
        }] } })
      }
      return Response.json({ ok: true, value: {} })
    }) as typeof fetch
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    return { calls }
  }

  it('图标 + 名称 + 「N 个账号 / M/N 个模型可用」+ 开关 + chevron 四件齐全', async () => {
    mountCard()
    await act(async () => root!.render(createElement(HubOverview, {
      t: ((key: keyof typeof hubZh) => hubZh[key]) as never,
      onOpen: vi.fn(),
    } as never)))
    // hub 按注册表渲染每一张卡，overview 只报了 GLM 一条：因此按名字找本卡，
    // 不能用 querySelector('.dsh-hub-card')——那拿到的是排在最前的 ChatGPT。
    const card = [...container!.querySelectorAll<HTMLElement>('.dsh-hub-card')]
      .find((entry) => entry.querySelector('.dsh-hub-card-name')?.textContent === GLM_CODING_PLAN_PROVIDER_NAME)!
    expect(card).not.toBeNull()
    // 图标：本线路的品牌标记——同样按图形断言（理由见上面模型行那条）。
    const tile = card.querySelector('.dsh-hub-brand-tile svg')
    expect(tile?.querySelectorAll('path')).toHaveLength(3)
    expect(tile?.querySelector('path')?.getAttribute('d')).toMatch(/^M16\.5376 /)
    // 名称取契约里的显示名。
    expect(card.querySelector('.dsh-hub-card-name')?.textContent).toBe(GLM_CODING_PLAN_PROVIDER_NAME)
    // 「2 个账号 · 3/4 个模型可用」由 hub 的聚合 overview 给出，卡片不自己数。
    expect(card.querySelector('.dsh-hub-card-note')?.textContent)
      .toBe(`${hubZh.hubAccountCount.replace('{count}', '2')} · ${hubZh.hubModelsEnabledOfTotal.replace('{count}', '3').replace('{total}', '4')}`)
    // 开关 + chevron。
    expect(card.querySelector('[role="switch"]')).not.toBeNull()
    expect(card.querySelector('.dsh-hub-chevron')).not.toBeNull()
  })

  it('开关 POST 到本线路自己的 settings 路由', async () => {
    const { calls } = mountCard()
    await act(async () => root!.render(createElement(HubOverview, {
      t: ((key: keyof typeof hubZh) => hubZh[key]) as never,
      onOpen: vi.fn(),
    } as never)))
    const toggle = [...container!.querySelectorAll<HTMLElement>('.dsh-hub-card')]
      .find((entry) => entry.querySelector('.dsh-hub-card-name')?.textContent === GLM_CODING_PLAN_PROVIDER_NAME)!
      .querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(toggle.disabled).toBe(false)
    await act(async () => toggle.click())
    expect(calls.some((call) => call.url === `${PREFIX}/settings` && JSON.stringify(call.body) === '{"enabled":false}'))
      .toBe(true)
  })
})
describe('输入框胶囊', () => {
  it('取已用比例最高的那个窗口，而不是最小剩余或平均', () => {
    const facts = selectBadgeFacts(status({
      quota: {
        planName: 'GLM Coding Plan Pro',
        planLevel: 'pro',
        windows: [
          { key: 'five-hour', usedPercent: 20, resetsAt: Date.now() + DAY },
          { key: 'weekly', usedPercent: 55, resetsAt: Date.now() + 7 * DAY },
          { key: 'monthly', usedPercent: 92, resetsAt: Date.now() + 30 * DAY },
        ],
        renewsAt: null,
        fetchedAt: Date.now(),
        sources: [],
      },
    }))
    expect(facts?.text).toBe('8%')
    // 共享分级：<=5% danger、<=20% warning；8% 落在 warning 而不是 danger。
    expect(facts?.level).toBe('warning')
    expect(facts?.tooltip).toContain(zh.title)
  })

  it('已用比例相等时取更短的那个窗口（重置更早的才是当下瓶颈）', () => {
    const facts = selectBadgeFacts(status({
      quota: {
        planName: null,
        planLevel: null,
        windows: [
          { key: 'monthly', usedPercent: 60, resetsAt: null },
          { key: 'weekly', usedPercent: 60, resetsAt: null },
          { key: 'five-hour', usedPercent: 60, resetsAt: null },
        ],
        renewsAt: null,
        fetchedAt: Date.now(),
        sources: [],
      },
    }))
    const fiveHours = new Intl.NumberFormat(undefined, { style: 'unit', unit: 'hour', unitDisplay: 'long' }).format(5)
    expect(facts?.text).toBe('40%')
    expect(facts?.tooltip).toContain(fiveHours)
  })

  it('没有快照或没有可测窗口时不出声（返回 null 表示不渲染）', () => {
    expect(selectBadgeFacts(null)).toBeNull()
    expect(selectBadgeFacts(status({ quota: null }))).toBeNull()
    expect(selectBadgeFacts(status({
      quota: {
        planName: null,
        planLevel: null,
        windows: [{ key: 'five-hour', usedPercent: null, resetsAt: null }],
        renewsAt: null,
        fetchedAt: Date.now(),
        sources: [],
      },
    }))).toBeNull()
  })

  it('挂在对话页上时显示的就是那个最紧窗口的剩余', async () => {
    const payload = status({
      quota: {
        planName: 'GLM Coding Plan Pro',
        planLevel: 'pro',
        windows: [
          { key: 'five-hour', usedPercent: 10, resetsAt: Date.now() + DAY },
          { key: 'monthly', usedPercent: 93, resetsAt: Date.now() + 30 * DAY },
        ],
        renewsAt: null,
        fetchedAt: Date.now(),
        sources: [],
      },
    })
    await mountSection(payload)
    container?.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    // 快照必须是**同一个引用**：getSnapshot 每次新建对象会让 useSyncExternalStore
    // 无限重渲染（这正是 shared badge 依赖 store 契约的原因）。
    const snapshot = { current: { provider: GLM_CODING_PLAN_PROVIDER_ID, model: 'GLM-5.3' }, models: [] }
    const directory = {
      subscribe: () => () => undefined,
      getSnapshot: () => snapshot,
    }
    await act(async () => root!.render(createElement(GlmCodingPlanComposerQuota, {
      directory,
      loadModelDirectory: () => undefined,
      t: ((key: keyof typeof zh) => zh[key]) as never,
    } as never)))
    expect(container.querySelector('.dsha-composer-quota-val')?.textContent).toBe('7%')
    expect(container.querySelector('.dsha-composer-quota-label')?.textContent).toBe(zh.composerLabel)
    expect(container.querySelector('.dsha-composer-quota')?.getAttribute('data-level')).toBe('warning')
  })
})