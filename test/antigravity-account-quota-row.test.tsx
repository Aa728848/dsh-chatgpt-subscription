// @vitest-environment jsdom
/**
 * The Antigravity card draws each account's own quota inside that account's row,
 * and stops drawing progress bars at the page level.
 *
 * The host publishes the cached snapshot on the primary row only (this line has
 * no per-account read path), so that is the row these assertions look at.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { AntigravitySection } from '../src/client/antigravity/AntigravitySection.tsx'
import { zh } from '../src/client/antigravity/locales.ts'

const FETCHED_AT = Date.parse('2030-06-15T12:00:00Z')

const PRIMARY = {
  id: 'acc_1',
  alias: '主力账号',
  email: 'primary@example.com',
  projectId: 'proj-1',
  isPrimary: true,
  quota: {
    fetchedAt: FETCHED_AT,
    windows: [
      { label: '5 hours', usedPercent: 15, windowDurationMins: null, resetsAt: FETCHED_AT + 6 * 3_600_000 },
      { label: 'Weekly', usedPercent: 90, windowDurationMins: null, resetsAt: null },
    ],
  },
}

const SECOND = { id: 'acc_2', alias: '备用账号', email: 'second@example.com', projectId: 'proj-2', isPrimary: false }

function statusPayload(primaryQuota: typeof PRIMARY.quota = PRIMARY.quota) {
  return {
    authenticated: true,
    enabled: true,
    accounts: [{ ...PRIMARY, quota: primaryQuota }, SECOND],
    activeAccountId: 'acc_1',
    rotationStrategy: 'sticky',
    storagePath: 'C:\\Users\\A\\.dsh\\storages\\antigravity-pool.json.dpapi',
    contextWindowOverrides: {},
    models: [],
    // Four page-level buckets: before the change these drew bars, and the third
    // one states no fraction at all. The fourth states a real 0.
    quota: {
      fetchedAt: FETCHED_AT,
      groups: [{
        displayName: 'Gemini Models',
        description: 'Pro and Flash',
        buckets: [
          { bucketId: 'gemini-5h', displayName: 'Bucket A', remainingFraction: 0.5, resetTime: '2030-06-15T18:00:00Z' },
          { bucketId: 'gemini-weekly', displayName: 'Bucket B', remainingFraction: 0.2 },
          // Explicitly null (what today's host publishes) and a key that is
          // missing altogether (an older host): the same statement, both must
          // render as a dash.
          { bucketId: 'gemini-unmeasured', displayName: 'Bucket C', remainingFraction: null, resetTime: '2030-06-16T00:00:00Z' },
          { bucketId: 'gemini-absent', displayName: 'Bucket E', resetTime: '2030-06-16T06:00:00Z' },
          { bucketId: 'gemini-exhausted', displayName: 'Bucket D', remainingFraction: 0 },
        ],
      }],
    },
  }
}

describe('Antigravity account rows carry the quota bars', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    globalThis.fetch = vi.fn(async () => Response.json({ ok: true, value: statusPayload() })) as typeof fetch
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    globalThis.fetch = originalFetch
  })

  it('draws one bar per window on the primary row, and none for the serving row', async () => {
    await act(async () => root.render(createElement(AntigravitySection, {})))

    const cards = [...container.querySelectorAll('.dsha-account-card')]
    expect(cards).toHaveLength(2)
    const bars = [...cards[0]!.querySelectorAll('[role="progressbar"]')]
    expect(bars).toHaveLength(2)
    expect(bars.map((bar) => bar.getAttribute('aria-valuenow'))).toEqual(['15', '90'])
    expect(cards[0]!.textContent).toContain('5 hours')
    expect(cards[0]!.querySelector('.dsha-account-quota-head')?.textContent).toContain(zh.accountQuota)
    expect(cards[1]!.querySelectorAll('[role="progressbar"]')).toHaveLength(0)

    // Every bar on the page lives in an account row.
    const pageBars = [...container.querySelectorAll('.dsha-group [role="progressbar"]')]
    expect(pageBars).toHaveLength(2)
    for (const bar of pageBars) expect(bar.closest('.dsha-account-card')).not.toBeNull()

    // The page-level block keeps the note saying which account its facts describe.
    expect(container.textContent).toContain(zh.quotaFactsScope)
  })

  it('still says a measured exhausted window is used up', async () => {
    // The counterpart of the dash above: a real 100% reading must keep rendering
    // as exhausted, or the unmeasured-is-not-zero fix would have gone too far.
    const quota = {
      fetchedAt: FETCHED_AT,
      windows: [{ label: '5 hours', usedPercent: 100, windowDurationMins: null, resetsAt: null }],
    }
    globalThis.fetch = vi.fn(async () => Response.json({ ok: true, value: statusPayload(quota) })) as typeof fetch
    await act(async () => root.render(createElement(AntigravitySection, {})))

    const card = container.querySelector('.dsha-account-card')!
    expect(card.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('100')
    expect(card.textContent).toContain(zh.quotaExhausted)
  })
})
