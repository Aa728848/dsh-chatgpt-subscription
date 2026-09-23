// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ZhipuAccountSummaryDto, ZhipuWebStatus } from '../src/shared/zhipu-contracts.ts'
import { ZhipuSection, formatCapacity, parsePositiveCapacity } from '../src/client/zhipu/ZhipuSection.tsx'
import { selectBadgeFacts } from '../src/client/zhipu/ZhipuComposerQuota.tsx'
import { en, zh } from '../src/client/zhipu/locales.ts'
import { accountPoolZh } from '../src/client/common/account-pool-labels.ts'

const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT

/** A signed-in status carrying one 5-hour window and one tool meter. */
function status(overrides: Partial<ZhipuWebStatus> = {}): ZhipuWebStatus {
  return {
    authenticated: true,
    hasCredentials: true,
    storagePath: 'DPAPI: /tmp/zhipu-credentials.json.dpapi',
    account: {
      id: 'intl:abcd',
      keyHint: '••••1234',
      email: null,
      planLabel: 'GLM Coding Pro',
      region: 'intl',
      apiBase: 'https://api.z.ai',
      authenticatedAt: Date.now(),
    },
    quota: {
      account: {
        id: 'intl:abcd',
        keyHint: '••••1234',
        email: null,
        planLabel: 'GLM Coding Pro',
        region: 'intl',
        apiBase: 'https://api.z.ai',
        authenticatedAt: null,
      },
      planName: 'GLM Coding Pro',
      planLevel: 'pro',
      renewsAt: null,
      meters: [
        { id: 'tokens-3-5', label: '5 小时额度', usedFraction: 0.405, remainingFraction: 0.595, used: '12500000', limit: '40000000', resetsAt: Date.now() + 3_600_000, description: null },
        { id: 'tools-month', label: 'MCP 工具调用（月度）', usedFraction: 0.123, remainingFraction: 0.877, used: '123', limit: '1000', resetsAt: null, description: null },
      ],
      windows: [
        { id: 'tokens-3-5', label: '5 小时额度', usedFraction: 0.405, remainingFraction: 0.595, used: '12500000', limit: '40000000', resetsAt: Date.now() + 3_600_000, windowMinutes: 300, description: null },
      ],
      fetchedAt: Date.now(),
      sources: ['monitor/usage/quota/limit'],
    },
    lastFetchedAt: Date.now(),
    models: [
      {
        id: 'glm-5.3', name: 'GLM-5.3', enabled: true, defaultContextWindow: 1_000_000, contextWindow: 1_000_000,
        defaultMaxTokens: 131_072, reasoningEfforts: ['low', 'high', 'max'], supportsImage: false, regions: ['intl', 'cn'],
      },
      {
        id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', enabled: true, defaultContextWindow: 1_000_000, contextWindow: 1_000_000,
        defaultMaxTokens: 131_072, reasoningEfforts: ['low', 'high', 'max'], supportsImage: true, regions: ['intl', 'cn'],
      },
    ],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
    selectedAccountId: null,
    serving: true,
    conflict: null,
    quotaError: null,
    accounts: [
      {
        id: 'intl:abcd', alias: '国际区 ••••1234', isPrimary: true, region: 'intl', keyHint: '••••1234',
        apiBase: 'https://api.z.ai', planLabel: 'GLM Coding Pro', email: '国际区 ••••1234',
      } as ZhipuAccountSummaryDto,
    ],
    activeAccountId: 'intl:abcd',
    rotationStrategy: 'sequential',
    ...overrides,
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null

async function mountSection(payload: ZhipuWebStatus): Promise<HTMLDivElement> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const originalFetch = globalThis.fetch
  globalThis.fetch = vi.fn(async () => Response.json({ ok: true, value: payload })) as typeof fetch
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(ZhipuSection, {})))
  globalThis.fetch = originalFetch
  return container
}

afterEach(async () => {
  if (root !== null) await act(async () => root!.unmount())
  root = null
  container?.remove()
  container = null
  globalThis.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
  vi.restoreAllMocks()
})

describe('zhipu settings card', () => {
  it('renders the account, its region, and the plan without ever showing the key', async () => {
    const node = await mountSection(status())
    const text = node.textContent ?? ''
    expect(text).toContain(zh.accountPool)
    expect(text).toContain('••••1234')
    expect(text).toContain(zh.regionIntl)
    expect(text).toContain('GLM Coding Pro')
    // The secret never reaches the DOM.
    expect(text).not.toContain('key-abc')
  })

  it('renders a meter per window and its reset countdown', async () => {
    const node = await mountSection(status())
    const text = node.textContent ?? ''
    expect(text).toContain('5 小时额度')
    expect(text).toContain('60%')
    expect(text).toContain('12500000')
    expect(text).toContain(zh.resetAt)
  })

  it('explains an account that reports no usable allowance', async () => {
    const node = await mountSection(status({
      quota: { ...status().quota!, meters: [], windows: [] },
    }))
    expect(node.textContent).toContain(zh.quotaUnavailable)
  })

  it('reports a quota failure the host attached to the status', async () => {
    const node = await mountSection(status({ quota: null, quotaError: 'quota lookup failed (503)' }))
    expect(node.textContent).toContain('quota lookup failed (503)')
  })

  it('offers the region selector so a key can be pasted for either console', async () => {
    const node = await mountSection(status())
    const options = [...node.querySelectorAll('select option')].map((option) => option.textContent)
    expect(options).toContain(zh.regionIntl)
    expect(options).toContain(zh.regionCn)
  })

  it('renders one checkbox per catalog model with its capability tooltip', async () => {
    const node = await mountSection(status())
    const labels = [...node.querySelectorAll('.dsha-models label')]
    expect(labels.map((label) => label.textContent)).toEqual(['GLM-5.3', 'GLM-5.3-Flash'])
    // The flash model takes images; the flagship does not. The tooltip is where
    // that per-model difference is visible.
    expect(labels[1]!.getAttribute('title')).toContain('image')
    expect(labels[0]!.getAttribute('title')).not.toContain('image')
    expect(labels[0]!.getAttribute('title')).toContain('low/high/max')
  })
})

describe('zhipu composer badge', () => {
  it('shows the tightest window and grades its severity', () => {
    const facts = selectBadgeFacts(status())
    // The 5-hour window (59.5% left) is tighter than the tool meter (87.7%).
    expect(facts?.text).toBe('60%')
    expect(facts?.tooltip).toContain('5 小时额度')
    expect(facts?.level).toBe('normal')

    const tight = selectBadgeFacts(status({
      quota: {
        ...status().quota!,
        windows: [{ ...status().quota!.windows[0]!, remainingFraction: 0.04, usedFraction: 0.96 }],
        meters: [],
      },
    }))
    expect(tight?.level).toBe('danger')
  })

  it('reports unavailable rather than zero when there is no quota', () => {
    expect(selectBadgeFacts(status({ quota: null }))?.text).toBe('—')
    expect(selectBadgeFacts(null)?.text).toBe('—')
  })
})

describe('zhipu card helpers', () => {
  it('parses a capacity a user would actually type', () => {
    expect(parsePositiveCapacity('1M')).toBe(1_000_000)
    expect(parsePositiveCapacity('512k')).toBe(512_000)
    expect(parsePositiveCapacity('200_000')).toBe(200_000)
    expect(parsePositiveCapacity('0')).toBeNull()
    expect(parsePositiveCapacity('lots')).toBeNull()
  })

  it('formats a capacity back into the same vocabulary', () => {
    expect(formatCapacity(1_000_000)).toBe('1M')
    expect(formatCapacity(512_000)).toBe('512K')
    expect(formatCapacity(131_072)).toBe('131072')
  })

  it('carries every shared account-pool label in both dictionaries', () => {
    // The card renders the shared component, so a missing label would surface as
    // a blank control rather than a type error.
    for (const key of Object.keys(accountPoolZh)) {
      expect(zh).toHaveProperty(key)
      expect(en).toHaveProperty(key)
    }
    expect(zh.title).toBe('GLM（智谱 Coding Plan）')
    expect(Object.keys(en)).toEqual(Object.keys(zh))
  })
})
