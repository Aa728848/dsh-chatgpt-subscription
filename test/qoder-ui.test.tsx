// @vitest-environment jsdom
/**
 * Qoder（订阅）设置卡片。
 *
 * 覆盖的是本线路在 UI 上必须成立的五件事，每一件都在别的线路里不成立：
 *
 *   1. 卡片能从自己的 /qoder/api 读口渲染出账号区、额度区与模型清单；
 *   2. 区域选择：全球区的账号区标题行有浏览器登录按钮，中国站**没有**（它没有设备流）；
 *   3. quota 为 null（没登录 / 没读到）时不崩，且说「还没有读到额度」而不是画 0%；
 *   4. 额度桶画**绝对量**（剩余/总额 + 单位），绝不画成一条「看起来一样」的进度条；
 *   5. 缓存区**只有 token 维度**：整页不出现任何金额，没样本就是占位符而不是 0%。
 *
 * 全程 mock fetch，且**只在本线路自己的前缀下应答**：越界的请求直接抛错。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  QODER_PROVIDER_ID,
  QODER_ROUTE_PREFIX,
  type QoderAccountSummaryDto,
  type QoderModelOption,
  type QoderQuotaSnapshotDto,
  type QoderStatusDto,
} from '../src/shared/qoder-contracts.ts'
import { QoderSection } from '../src/client/qoder/QoderSection.tsx'
import { zh } from '../src/client/qoder/locales.ts'

const PREFIX = QODER_ROUTE_PREFIX

/** 一个池内账号。区域是凭据的属性。 */
function account(overrides: Partial<QoderAccountSummaryDto> = {}): QoderAccountSummaryDto {
  return {
    id: 'global:u-1',
    alias: 'me@qoder.com',
    isPrimary: true,
    region: 'global',
    origin: 'device',
    accountName: 'Qoder User',
    ...overrides,
  }
}

/** host 由运行时发现的目录给出的模型行；hint 由 host 生成，客户端一个字都不改写。 */
function model(id: string, overrides: Partial<QoderModelOption> = {}): QoderModelOption {
  return {
    id,
    name: id,
    hint: '',
    enabled: false,
    defaultContextWindow: 1_000_000,
    contextWindow: 1_000_000,
    defaultMaxTokens: 131_072,
    reasoningEfforts: ['low', 'high'],
    thinkingDisableable: true,
    supportsImages: false,
    regions: ['global'],
    description: null,
    ...overrides,
  }
}

/** 三桶齐备的快照。 */
function quota(overrides: Partial<QoderQuotaSnapshotDto> = {}): QoderQuotaSnapshotDto {
  return {
    buckets: [
      { kind: 'personal', total: 1500, used: 300, remaining: 1200, unit: 'Credits' },
      { kind: 'add-on', total: 500, used: null, remaining: 500, unit: 'Credits' },
    ],
    expiresAt: Date.now() + 20 * 24 * 3_600_000,
    fetchedAt: Date.now(),
    region: 'global',
    ...overrides,
  }
}

function status(overrides: Partial<QoderStatusDto> = {}): QoderStatusDto {
  return {
    enabled: true,
    authenticated: true,
    hasCredentials: true,
    providerId: QODER_PROVIDER_ID,
    storagePath: 'DPAPI: /tmp/qoder-credentials.json.dpapi',
    region: 'global',
    account: account(),
    quota: quota(),
    lastFetchedAt: Date.now(),
    quotaError: null,
    models: [
      model('Lite', { enabled: true }),
      model('Ultimate', { enabled: true, supportsImages: true }),
      model('Efficient'),
    ],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
    login: { status: 'idle' },
    accounts: [account()],
    activeAccountId: 'global:u-1',
    rotationStrategy: 'sequential',
    serving: true,
    conflict: null,
    ...overrides,
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null
let realFetch: typeof fetch | undefined

/** 挂载卡片；只在本线路前缀下应答，越界请求当场抛错。 */
async function mountSection(payload: QoderStatusDto): Promise<{
  node: HTMLDivElement
  calls: Array<{ url: string; method: string }>
}> {
  realFetch ??= globalThis.fetch
  const calls: Array<{ url: string; method: string }> = []
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET' })
    if (!url.startsWith(PREFIX)) throw new Error('unexpected request outside ' + PREFIX + ': ' + url)
    return Response.json({ ok: true, value: payload })
  }) as typeof fetch
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(QoderSection, {})))
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

describe('Qoder 设置卡片', () => {
  it('一个 /status 读口渲染出账号区、额度区与模型清单，且只在自己的前缀下说话', async () => {
    const { node, calls } = await mountSection(status())

    // 账号区：共享账号池卡片；账号的区域与显示名画出来了。
    expect(node.querySelector('.dsha-account-card')).not.toBeNull()
    expect(node.textContent).toContain(zh.regionGlobal)
    expect(node.textContent).toContain('Qoder User')

    // 额度区：个人桶与加购桶各一行，绝对量与单位。
    const quotaGroup = groupOf(node, zh.quotaSection)
    expect(quotaGroup.textContent).toContain(zh.quotaBucketPersonal)
    expect(quotaGroup.textContent).toContain(zh.quotaBucketAddOn)
    expect(quotaGroup.textContent).toContain('Credits')

    // 模型区：目录里的每一行都在。
    expect(node.querySelectorAll('.dsh-mcl-option')).toHaveLength(3)

    // 一个网络包都不许发到本线路的前缀之外。
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((call) => call.url.startsWith(PREFIX))).toBe(true)
  })

  it('账号区标题行最多两个按钮：浏览器登录（仅全球区）+ 导入', async () => {
    const { node } = await mountSection(status())
    const head = [...node.querySelectorAll<HTMLElement>('.dsha-grouphead')]
      .find((entry) => entry.querySelector('.dsha-account-add-actions'))!
    expect(head).toBeDefined()
    const actions = [...head.querySelectorAll<HTMLButtonElement>('button.dsha-btn')]
    expect(actions.map((button) => button.textContent)).toEqual([zh.addAccount, zh.adopt])
    // 护栏：第三个按钮会被挤到下一行，所以 PAT 粘贴留在下面的兜底入口行。
    expect(actions).toHaveLength(2)
    // idle 时不渲染登录流程块（临时内容不占版面）。
    expect(node.querySelector('.dshq-flow')).toBeNull()
    const paste = node.querySelector<HTMLButtonElement>('.dshq-paste button[aria-expanded]')
    expect(paste).not.toBeNull()
    expect(paste!.closest('.dsha-grouphead')).toBeNull()
  })

  it('中国站没有浏览器登录按钮（它没有设备流），只剩导入', async () => {
    // 账号与「下一次登录」都在中国站。
    const { node } = await mountSection(status({
      region: 'cn',
      account: account({ region: 'cn' }),
      accounts: [account({ region: 'cn' })],
    }))
    const head = [...node.querySelectorAll<HTMLElement>('.dsha-grouphead')]
      .find((entry) => entry.querySelector('.dsha-account-add-actions'))!
    const actions = [...head.querySelectorAll<HTMLButtonElement>('button.dsha-btn')]
    expect(actions.map((button) => button.textContent)).toEqual([zh.adopt])
  })

  it('quota 为 null 不崩，且说「还没有读到额度」而不是画 0%', async () => {
    const { node } = await mountSection(status({ quota: null }))
    expect(node.querySelector('.dsha-page')).not.toBeNull()
    expect(node.querySelectorAll('.dsh-mcl-option')).toHaveLength(3)
    const quotaGroup = groupOf(node, zh.quotaSection)
    expect(quotaGroup.textContent).toContain(zh.quotaEmpty)
    // 「没数据」不得被渲染成「用完了」。
    expect(quotaGroup.textContent).not.toContain('0%')
    expect(quotaGroup.querySelector('[role="progressbar"]')).toBeNull()
  })

  it('额度桶画绝对量而不是进度条：剩余/总额 + 单位；used 缺失时不画百分比', async () => {
    const { node } = await mountSection(status({ quota: quota() }))
    const quotaGroup = groupOf(node, zh.quotaSection)
    // 个人桶：1200 / 1500 Credits，已用 20%。
    expect(quotaGroup.textContent).toContain('1,200')
    expect(quotaGroup.textContent).toContain('1,500')
    expect(quotaGroup.textContent).toContain('20%')
    // 加购桶的 used 缺失：那一行没有百分比。
    const rows = [...quotaGroup.querySelectorAll<HTMLElement>('.dshq-quota-row')]
    const addOnRow = rows.find((row) => row.textContent?.includes(zh.quotaBucketAddOn))!
    expect(addOnRow.textContent).not.toContain('%')
    // 没有任何 progressbar：桶是绝对量，折成百分比需要发明一个分母。
    expect(quotaGroup.querySelector('[role="progressbar"]')).toBeNull()
  })

  it('缓存区只有 token 维度：不出现任何金额，没样本就是占位符', async () => {
    const withStats = await mountSection(status({
      cacheStats: { cacheReadTokens: 600, missedInputTokens: 400, cacheWriteTokens: 0, requests: 3 },
    }))
    const cacheGroup = groupOf(withStats.node, zh.cacheSection)
    const text = cacheGroup.textContent ?? ''
    expect(text).toContain(zh.cacheReadTokens)
    expect(text).toContain('600')
    expect(text).toContain('400')
    expect(text).toContain('60%')
    // 整页没有金额：订阅没有公开的 token 单价，$ 符号一个都不该出现。
    expect(text).not.toContain('$')
    await act(async () => root!.unmount())
    root = null
    container?.remove()
    container = null

    const noStats = await mountSection(status())
    const emptyGroup = groupOf(noStats.node, zh.cacheSection)
    expect(emptyGroup.textContent).toContain(zh.cacheEmpty)
    expect(emptyGroup.textContent).not.toContain('0%')
  })
})
