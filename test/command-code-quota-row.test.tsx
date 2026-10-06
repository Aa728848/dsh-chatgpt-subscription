// @vitest-environment jsdom
/**
 * The Command Code tab draws quota inside each account row.
 *
 * Quota follows the account: rotation decides which key spends the next
 * request, so the page-level block may no longer draw a per-window progress bar
 * — it could only ever describe whichever key was active when the snapshot was
 * read. The bar moved into the account card; the page-level block keeps the
 * facts that have no per-account bar to live in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { CommandCodeSection } from '../src/client/command-code/CommandCodeSection.tsx'
import { accountPoolZh } from '../src/client/common/account-pool-labels.ts'
import { zh } from '../src/client/command-code/locales.ts'
import type { CommandCodeWebStatus } from '../src/shared/command-code-contracts.ts'

const NOW = Date.now()

function statusPayload(): CommandCodeWebStatus {
  return {
    enabled: true,
    authenticated: true,
    hasCredentials: true,
    storagePath: '/home/me/command-code-credentials.json',
    apiEnv: 'prod',
    account: {
      userId: 'u1',
      userName: 'me',
      email: 'me@example.com',
      organizationName: null,
      keyName: 'main key',
      planLabel: 'GOAT',
      planId: 'individual-goat',
      authenticatedAt: NOW - 60_000,
    },
    quota: {
      account: {
        userId: 'u1',
        userName: 'me',
        email: 'me@example.com',
        organizationName: null,
        keyName: 'main key',
        planLabel: 'GOAT',
        planId: 'individual-goat',
        authenticatedAt: NOW - 60_000,
      },
      creditBalance: '120',
      unlimited: false,
      planId: 'individual-goat',
      planName: 'GOAT',
      planMonthlyCredits: 500,
      subscriptionStatus: 'active',
      periodEndsAt: null,
      meters: [
        // A meter that states a share is progress, and progress moved into the
        // account card; one that states none is a fact and stays here.
        { id: 'spend', label: 'Spend control', usedFraction: 0.5, remainingFraction: 0.5, used: '50', limit: '100', resetsAt: null, description: 'Bounded allowance' },
        { id: 'topup', label: 'Top-up pool', usedFraction: null, remainingFraction: null, used: null, limit: '20', resetsAt: null, description: 'Purchased credits' },
      ],
      windows: [{ id: 'w1', label: '5 小时', usedPercent: 40, windowDurationMins: 300, resetsAt: null }],
      fetchedAt: NOW,
      sources: ['whoami'],
    },
    lastFetchedAt: NOW,
    models: [],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
    accounts: [
      {
        id: 'acc_1',
        alias: '主力密钥',
        isPrimary: true,
        keyName: 'laptop-1',
        quota: {
          fetchedAt: NOW,
          windows: [{ label: '5 小时', usedPercent: 40, windowDurationMins: 300, resetsAt: null }],
        },
      },
      { id: 'acc_2', alias: '备用密钥', isPrimary: false, keyName: 'laptop-2' },
    ],
    activeAccountId: 'acc_1',
    rotationStrategy: 'sequential',
    serving: true,
    conflict: null,
  }
}

let originalFetch: typeof globalThis.fetch
let originalActEnvironment: boolean | undefined
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

async function render(): Promise<void> {
  globalThis.fetch = vi.fn(async () => Response.json({ ok: true, value: statusPayload() })) as typeof fetch
  await act(async () => root.render(createElement(CommandCodeSection, {})))
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

describe('Command Code quota rendering', () => {
  it('draws each account its own bar inside the account row', async () => {
    await render()

    const rows = container.querySelectorAll<HTMLElement>('.dsha-account-quota-row')
    expect(rows).toHaveLength(1)
    const bar = rows[0]!.querySelector<HTMLElement>('[role="progressbar"]')
    expect(bar?.getAttribute('aria-valuenow')).toBe('40')
    expect(rows[0]!.textContent).toContain('5 小时')
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
    expect(section.textContent).toContain('120')
    expect(section.textContent).toContain('Top-up pool')
    expect(section.textContent).toContain('Purchased credits')
    // The meter that states a share is progress, and progress lives in the row.
    expect(section.textContent).not.toContain('Spend control')
    expect(section.textContent).toContain(accountPoolZh.quotaFactsScope)
  })
})
