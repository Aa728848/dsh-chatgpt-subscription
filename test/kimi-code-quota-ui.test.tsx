// @vitest-environment jsdom
/**
 * Where the Kimi Code line draws quota progress.
 *
 * Quota follows the ACCOUNT, so the bars belong to the account rows and the
 * page-level block keeps only facts that have no per-account bar to live in —
 * here the plan name and the pay-as-you-go wallet. This file pins that split at
 * the DOM level, because it is exactly the change a later edit reverts by
 * accident: a bar drawn once at page level looks fine in a screenshot and is
 * wrong for every account but the active one.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PoolAccountQuotaDto } from '../src/shared/account-pool-contracts.ts'
import type { KimiCodeWebStatus } from '../src/shared/kimi-code-contracts.ts'
import { KimiCodeSection } from '../src/client/kimi-code/KimiCodeSection.tsx'
import { zh } from '../src/client/kimi-code/locales.ts'
import { accountPoolZh } from '../src/client/common/account-pool-labels.ts'

const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT

/** The reading the active account's row must draw. */
const ACCOUNT_QUOTA: PoolAccountQuotaDto = {
  windows: [{ label: '5-hour', usedPercent: 42, windowDurationMins: 300, resetsAt: Date.now() + 3_600_000 }],
  fetchedAt: Date.now(),
}

function status(overrides: Partial<KimiCodeWebStatus> = {}): KimiCodeWebStatus {
  return {
    enabled: true,
    authenticated: true,
    hasCredentials: true,
    storagePath: '/tmp/kimi-code.json',
    region: 'mainland-cn',
    oauthHost: 'https://auth.kimi.com',
    codingBaseUrl: 'https://api.kimi.com/coding',
    account: {
      userId: 'user-1', nickname: 'Kimi 1', email: 'user1@example.com',
      planName: 'GOAT', planLevel: null, region: 'mainland-cn', authenticatedAt: null,
    },
    quota: {
      account: {
        userId: 'user-1', nickname: 'Kimi 1', email: 'user1@example.com',
        planName: 'GOAT', planLevel: null, region: 'mainland-cn', authenticatedAt: null,
      },
      planName: 'GOAT',
      windows: [
        {
          id: 'limit_5h', label: '5-hour', usedFraction: 0.2, usedPercent: 20,
          windowDurationMins: 300, resetsAt: Date.now() + 3_600_000,
          limit: '100', used: '20', remaining: '80',
        },
      ],
      extraUsage: {
        balanceCents: 1_250, totalCents: 5_000, monthlyChargeLimitEnabled: true,
        monthlyChargeLimitCents: 5_000, monthlyUsedCents: null, currency: 'CNY',
      },
      fetchedAt: Date.now(),
      sources: [],
    },
    lastFetchedAt: Date.now(),
    quotaError: null,
    credentialsRejected: false,
    cache: null,
    preserveThinking: false,
    models: [],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
    cacheTtl: null,
    accounts: [
      {
        id: 'acc_a', alias: 'user1@example.com', isPrimary: true, email: 'user1@example.com',
        nickname: 'Kimi 1', planName: 'GOAT', region: 'mainland-cn', quota: ACCOUNT_QUOTA,
      },
      {
        id: 'acc_b', alias: 'user2@example.com', isPrimary: false, email: 'user2@example.com',
        nickname: 'Kimi 2', planName: 'GOAT', region: 'mainland-cn',
      },
    ],
    activeAccountId: 'acc_a',
    rotationStrategy: 'sequential',
    loginRegion: 'mainland-cn',
    serving: true,
    conflict: null,
    ...overrides,
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null
let realFetch: typeof fetch | undefined

async function mount(payload: KimiCodeWebStatus): Promise<HTMLDivElement> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  realFetch ??= globalThis.fetch
  globalThis.fetch = vi.fn(async () => Response.json({ ok: true, value: payload })) as unknown as typeof fetch
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(KimiCodeSection, {})))
  return container
}

beforeEach(() => {
  vi.stubGlobal('open', vi.fn())
})

afterEach(async () => {
  if (root !== null) await act(async () => root!.unmount())
  root = null
  container?.remove()
  container = null
  globalThis.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
  if (realFetch !== undefined) globalThis.fetch = realFetch
  realFetch = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** The page-level quota block, found by its heading rather than by class. */
function quotaBlock(node: HTMLElement): HTMLElement {
  const section = [...node.querySelectorAll('section.dsha-group')]
    .find((candidate) => candidate.querySelector('h3')?.textContent === zh.quotaSection)
  return section as HTMLElement
}

describe('kimi-code quota, drawn in the account rows', () => {
  it('draws the bar for the account that has a reading, and says so for one that does not', async () => {
    const node = await mount(status())
    const cards = [...node.querySelectorAll<HTMLElement>('.dsha-account-card')]
    expect(cards).toHaveLength(2)

    const withQuota = cards.find((card) => card.querySelector('.dsha-account-title')?.textContent === 'user1@example.com')!
    const without = cards.find((card) => card.querySelector('.dsha-account-title')?.textContent === 'user2@example.com')!

    const bar = withQuota.querySelector('[role="progressbar"]')!
    expect(bar.getAttribute('aria-valuenow')).toBe('42')
    expect(bar.getAttribute('aria-label')).toContain(accountPoolZh.quotaUsed)
    expect(withQuota.querySelector('.dsha-account-quota-name')?.textContent).toBe('5-hour')

    // The account nobody has read says exactly that. "Never read" and "nothing
    // used" are different claims, and only one of them is true here.
    expect(without.querySelector('[role="progressbar"]')).toBeNull()
    expect(without.querySelector('.dsha-account-quota-empty')?.textContent).toBe(accountPoolZh.quotaNone)
  })

  it('keeps the page-level facts and stops drawing progress bars there', async () => {
    const node = await mount(status())
    const block = quotaBlock(node)
    expect(block).toBeDefined()

    // The wallet facts stay; the window's own bar does not, because it belongs
    // to an account rather than to the page.
    expect(block.querySelectorAll('.dsha-meter')).toHaveLength(0)
    expect(block.querySelectorAll('[role="progressbar"]')).toHaveLength(0)
    expect(block.textContent).toContain(zh.quotaWallet)
    expect(block.textContent).toContain(zh.quotaPlan)

    // And the note explains that these facts belong to the current account only.
    expect(node.textContent).toContain(zh.quotaFactsScope)
  })
})
