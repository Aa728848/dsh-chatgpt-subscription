// @vitest-environment jsdom
/**
 * Where the Claude line draws quota progress.
 *
 * Quota follows the ACCOUNT, so the bars belong to the account rows and the
 * page-level block keeps only facts that have no per-account bar to live in.
 * This file pins that split at the DOM level, because it is exactly the kind of
 * change a later edit reverts by accident: a bar drawn once at page level looks
 * fine in a screenshot and is wrong for every account but the active one.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PoolAccountQuotaDto } from '../src/shared/account-pool-contracts.ts'
import type { ClaudeWebStatus } from '../src/shared/claude-contracts.ts'
import { ClaudeSection } from '../src/client/claude/ClaudeSection.tsx'
import { zh } from '../src/client/claude/locales.ts'
import { accountPoolZh } from '../src/client/common/account-pool-labels.ts'

const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT

/** The reading the active account's row must draw. */
const ACCOUNT_QUOTA: PoolAccountQuotaDto = {
  windows: [{ label: '5-hour', usedPercent: 42, windowDurationMins: 300, resetsAt: Date.now() + 3_600_000 }],
  fetchedAt: Date.now(),
}

function status(overrides: Partial<ClaudeWebStatus> = {}): ClaudeWebStatus {
  return {
    enabled: true,
    authenticated: true,
    hasCredentials: true,
    storagePath: 'DPAPI: /tmp/claude-credentials.json.dpapi',
    serving: true,
    conflict: null,
    claudeCodeSignInAvailable: false,
    claudeCodePaths: [],
    account: { email: 'user@example.com', subscriptionType: 'max' },
    quota: {
      windows: [
        {
          id: 'five_hour', label: '5-hour', windowMinutes: 300,
          usedFraction: 0.2, usedPercent: 20, remainingPercent: 80,
          resetsAt: new Date(Date.now() + 3_600_000).toISOString(), source: 'usage',
        },
      ],
      extraUsage: {
        id: 'extra_usage', label: '', usedPercent: 17.5, remainingPercent: 82.5,
        limit: 20, used: 3.5, enabled: true,
      },
      fetchedAt: Date.now(),
      observedAt: Date.now(),
      status: null,
      representativeClaim: null,
    },
    lastFetchedAt: Date.now(),
    quotaError: null,
    models: [],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
    cacheTtl: null,
    selectedAccountId: null,
    accounts: [
      {
        id: 'cl_a', alias: 'user@example.com', isPrimary: true, email: 'user@example.com',
        subscriptionType: 'max', source: 'managed', adopted: false, quota: ACCOUNT_QUOTA,
      },
      {
        id: 'cl_b', alias: 'second@example.com', isPrimary: false, email: 'second@example.com',
        subscriptionType: 'pro', source: 'managed', adopted: false,
      },
    ],
    activeAccountId: 'cl_a',
    rotationStrategy: 'sequential',
    ...overrides,
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null
let realFetch: typeof fetch | undefined

async function mount(payload: ClaudeWebStatus): Promise<HTMLDivElement> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  realFetch ??= globalThis.fetch
  globalThis.fetch = vi.fn(async () => Response.json({ ok: true, value: payload })) as unknown as typeof fetch
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(ClaudeSection, {})))
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

describe('claude quota, drawn in the account rows', () => {
  it('draws the bar for the account that has a reading, and says so for one that does not', async () => {
    const node = await mount(status())
    const cards = [...node.querySelectorAll<HTMLElement>('.dsha-account-card')]
    expect(cards).toHaveLength(2)

    const withQuota = cards.find((card) => card.querySelector('.dsha-account-title')?.textContent === 'user@example.com')!
    const without = cards.find((card) => card.querySelector('.dsha-account-title')?.textContent === 'second@example.com')!

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

    // No window bars and no page-level progress at all: the only reading left
    // in this block is the extra-usage fact, which has no per-account bar.
    expect(block.querySelectorAll('.dsha-meter')).toHaveLength(0)
    expect(block.querySelectorAll('[role="progressbar"]')).toHaveLength(0)
    expect(block.querySelectorAll('.dsha-meter-wrap')).toHaveLength(1)
    expect(block.textContent).toContain(zh.extraUsage)
    expect(block.textContent).toContain(zh.updatedAt.replace('{time}', ''))

    // And the note explains that these facts belong to the current account only.
    expect(node.textContent).toContain(zh.quotaFactsScope)
  })
})
