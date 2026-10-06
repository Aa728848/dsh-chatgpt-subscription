// @vitest-environment jsdom
/**
 * The WorkBuddy tab draws quota inside each account row.
 *
 * Quota follows the account: rotation decides which account spends the next
 * request, so the page-level block may no longer draw a per-meter progress bar
 * — it could only ever describe whichever account was active when the snapshot
 * was read. The bars moved into the account card; the page-level block keeps
 * the facts that have no per-account bar to live in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkBuddySection } from '../src/client/workbuddy/WorkBuddySection.tsx'
import { accountPoolZh } from '../src/client/common/account-pool-labels.ts'
import { zh } from '../src/client/workbuddy/locales.ts'

const NOW = Date.now()

const ACCOUNTS = [
  {
    id: 'cn:u1',
    alias: '主力账号',
    isPrimary: true,
    region: 'cn',
    source: 'managed',
    removable: true,
    hidden: false,
    domain: 'copilot.tencent.com',
    backend: 'https://copilot.tencent.com',
    quota: {
      fetchedAt: NOW,
      windows: [{ label: 'Billing cycle', usedPercent: 40, windowDurationMins: null, resetsAt: null }],
    },
  },
  {
    id: 'cn:u2',
    alias: '备用账号',
    isPrimary: false,
    region: 'cn',
    source: 'managed',
    removable: true,
    hidden: false,
  },
]

function statusPayload(): Record<string, unknown> {
  return {
    authenticated: true,
    hasCredentials: true,
    authDirectory: '/home/me/auth',
    storagePath: '/home/me/models.json',
    managedStoragePath: '/home/me/accounts.json.dpapi',
    account: { id: 'cn:u1', region: 'cn', source: 'managed' },
    quota: {
      account: { id: 'cn:u1', region: 'cn', source: 'managed' },
      packageName: 'Free Plan',
      totalCredits: 1000,
      remainingCredits: 400,
      cycleUsedCredits: 200,
      cycleCredits: 500,
      cycleStartsAt: null,
      cycleEndsAt: null,
      meters: [
        { id: 'cycle', label: 'Billing cycle', usedFraction: 0.4, remainingFraction: 0.6, used: '200', limit: '500', resetsAt: null, description: 'Credits consumed in the current cycle' },
        { id: 'note', label: 'Add-on balance', usedFraction: null, remainingFraction: null, used: null, limit: '20', resetsAt: null, description: 'Separately purchased credits' },
      ],
      fetchedAt: NOW,
      sources: ['billing/meter/get-user-resource'],
    },
    lastFetchedAt: NOW,
    models: [],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
    selectedAccountId: 'cn:u1',
    accounts: ACCOUNTS,
    activeAccountId: 'cn:u1',
    rotationStrategy: 'sequential',
    enabled: true,
    serving: true,
    conflict: null,
    checkin: null,
  }
}

let originalFetch: typeof globalThis.fetch
let originalActEnvironment: boolean | undefined
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

async function render(): Promise<void> {
  globalThis.fetch = vi.fn(async () => Response.json({ ok: true, value: statusPayload() })) as typeof fetch
  await act(async () => root.render(createElement(WorkBuddySection, {})))
}

beforeEach(() => {
  originalFetch = globalThis.fetch
  originalActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  globalThis.fetch = originalFetch
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
  vi.restoreAllMocks()
})

/** The page-level quota group, found by its heading. */
function quotaSection(): HTMLElement {
  const sections = [...container.querySelectorAll<HTMLElement>('section.dsha-group')]
  const section = sections.find((entry) => entry.querySelector('h3')?.textContent === zh.quotaSection)
  if (section === undefined) throw new Error('the quota section was not rendered')
  return section
}

describe('WorkBuddy quota rendering', () => {
  it('draws each account its own bar inside the account row', async () => {
    await render()

    const rows = container.querySelectorAll<HTMLElement>('.dsha-account-quota-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.querySelector<HTMLElement>('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('40')
    expect(rows[0]!.textContent).toContain('Billing cycle')
    // The account that was never read says so, instead of showing 0%.
    expect(container.textContent).toContain(accountPoolZh.quotaNone)
  })

  it('draws no progress bar in the page-level quota block', async () => {
    await render()

    const section = quotaSection()
    expect(section.querySelectorAll('[role="progressbar"]')).toHaveLength(0)
    expect(section.querySelectorAll('.dsha-meter')).toHaveLength(0)
    // Every bar on the page is an account row's.
    expect(container.querySelectorAll('[role="progressbar"]').length)
      .toBe(container.querySelectorAll('.dsha-account-quota-row').length)
  })

  it('keeps the facts that have no per-account bar, and says whose they are', async () => {
    await render()

    const section = quotaSection()
    expect(section.textContent).toContain('Free Plan')
    expect(section.textContent).toContain('400')
    expect(section.textContent).toContain('200 / 500')
    expect(section.textContent).toContain('Add-on balance')
    expect(section.textContent).toContain('Separately purchased credits')
    expect(section.textContent).toContain(accountPoolZh.quotaFactsScope)
  })
})
