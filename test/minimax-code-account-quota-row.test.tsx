// @vitest-environment jsdom
/**
 * The MiniMax Code card draws each account's own quota inside that account's row,
 * and stops drawing progress bars at the page level.
 *
 * Quota follows the account: the host reports each account's newest snapshot on
 * its summary, so the row is the only place a bar can be truthful. What the
 * page-level block keeps is the facts that have no per-account bar to live in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MinimaxCodeSection } from '../src/client/minimax-code/MinimaxCodeSection.tsx'
import { zh } from '../src/client/minimax-code/locales.ts'

const FETCHED_AT = Date.parse('2030-06-15T12:00:00Z')

/** One account as the host reports it, carrying its own snapshot. */
const READ_ACCOUNT = {
  id: 'acc_a',
  alias: 'read@example.com',
  isPrimary: true,
  removable: true,
  quota: {
    fetchedAt: FETCHED_AT,
    windows: [
      { label: '5 hours', usedPercent: 25, windowDurationMins: 300, resetsAt: FETCHED_AT + 3_600_000 },
      { label: 'Weekly', usedPercent: 80, windowDurationMins: 10_080, resetsAt: null },
    ],
  },
}

const UNREAD_ACCOUNT = { id: 'acc_b', alias: 'unread@example.com', isPrimary: false, removable: true }

function statusPayload() {
  return {
    enabled: true,
    authenticated: true,
    account: { id: 'acc_a', label: 'read@example.com', generation: 1, expiresAtMs: FETCHED_AT },
    region: 'cn',
    storage: { kind: 'file', path: '/tmp/c.json' },
    models: [],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
    serving: true,
    conflict: null,
    ownedByPlugin: true,
    // Two page-level windows: before the change these drew two more bars.
    quota: {
      label: 'Token Plan',
      usedPercent: 25,
      windows: [
        { key: 'interval', remainingPercent: 75, usedPercent: 25, used: 250, total: 1000, resetsAtMs: FETCHED_AT + 3_600_000 },
        { key: 'weekly', remainingPercent: 80, usedPercent: 20, used: 1000, total: 5000 },
      ],
      fetchedAtMs: FETCHED_AT,
    },
  }
}

describe('MiniMax Code account rows carry the quota bars', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/accounts')) {
        return Response.json({ ok: true, value: {
          accounts: [READ_ACCOUNT, UNREAD_ACCOUNT],
          activeAccountId: 'acc_a',
          rotationStrategy: 'sequential',
          poolInstalled: true,
        } })
      }
      return Response.json({ ok: true, value: statusPayload() })
    }) as typeof fetch
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    globalThis.fetch = originalFetch
  })

  it('draws one bar per window inside the account that has a snapshot', async () => {
    await act(async () => root.render(createElement(MinimaxCodeSection, {})))

    const cards = [...container.querySelectorAll('.dsha-account-card')]
    expect(cards).toHaveLength(2)

    const readCard = cards[0]!
    const bars = [...readCard.querySelectorAll('[role="progressbar"]')]
    expect(bars).toHaveLength(2)
    expect(bars.map((bar) => bar.getAttribute('aria-valuenow'))).toEqual(['25', '80'])
    expect(readCard.textContent).toContain('5 hours')
    expect(readCard.textContent).toContain('Weekly')
    expect(readCard.querySelector('.dsha-account-quota-head')?.textContent).toContain(zh.accountQuota)

    // The account nobody read says so, rather than showing an empty bar.
    expect(cards[1]!.querySelectorAll('[role="progressbar"]')).toHaveLength(0)
    expect(cards[1]!.textContent).toContain(zh.quotaNone)

    // Every bar on the page lives in an account row: the page-level block kept
    // the facts and lost the progress bars, which used to describe whichever
    // account happened to be active when the snapshot was read.
    const pageBars = [...container.querySelectorAll('.dsha-group [role="progressbar"]')]
    expect(pageBars).toHaveLength(2)
    for (const bar of pageBars) expect(bar.closest('.dsha-account-card')).not.toBeNull()

    // The note saying which account the page's facts describe stays.
    expect(container.textContent).toContain(zh.quotaFactsScope)
  })
})
