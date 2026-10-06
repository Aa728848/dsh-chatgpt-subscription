// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { AccountQuota, formatQuotaPercent, formatQuotaReset, formatQuotaSnapshot, quotaWindowLabel } from '../src/client/common/account-quota.tsx'
import { accountPoolEn, accountPoolZh } from '../src/client/common/account-pool-labels.ts'
import type { PoolAccountQuotaDto } from '../src/shared/account-pool-contracts.ts'

describe('account quota formatting', () => {
  it('formats a share without inventing precision', () => {
    expect(formatQuotaPercent(42)).toBe('42%')
    expect(formatQuotaPercent(42.55)).toBe('42.6%')
    expect(formatQuotaPercent(Number.NaN)).toBe('0%')
  })

  it('names an unlabeled window from its length, and a nameless one generically', () => {
    expect(quotaWindowLabel({ label: '5 小时', usedPercent: 1 }, accountPoolZh)).toBe('5 小时')
    expect(quotaWindowLabel({ label: '', usedPercent: 1, windowDurationMins: 300 }, accountPoolZh)).toContain('5')
    expect(quotaWindowLabel({ label: '', usedPercent: 1, windowDurationMins: 10_080 }, accountPoolZh)).toContain('7')
    expect(quotaWindowLabel({ label: '', usedPercent: 1, windowDurationMins: null }, accountPoolZh)).toBe(accountPoolZh.quotaWindow)
  })

  it('dates a snapshot that is not from today, so "12:03" cannot mean yesterday', () => {
    const now = Date.parse('2030-06-15T12:00:00Z')
    const today = formatQuotaSnapshot(now - 3_600_000, now)
    const yesterday = formatQuotaSnapshot(now - 26 * 3_600_000, now)
    expect(yesterday.length).toBeGreaterThan(today.length)
    expect(yesterday).toMatch(/6\/1[34]|1[34]\/6|06\/1[34]|6月1[34]/)
  })

  it('states every reset as a distance, the way the page quota block does', () => {
    const now = Date.parse('2030-06-15T00:00:00Z')
    const relative = (value: number, unit: Intl.RelativeTimeFormatUnit): string =>
      new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(value, unit)
    // Minutes in the last stretch, hours for a short window, days for a long one
    // — the same reading the page block gives, never an absolute date.
    expect(formatQuotaReset(now + 12 * 60_000, now)).toBe(relative(12, 'minute'))
    expect(formatQuotaReset(now + 90 * 60_000, now)).toBe(relative(2, 'hour'))
    expect(formatQuotaReset(now + 72 * 3_600_000, now)).toBe(relative(3, 'day'))
    expect(formatQuotaReset(now + 7 * 86_400_000, now)).toBe(relative(7, 'day'))
    // A window that already reopened, or that never stated one, shows a dash.
    expect(formatQuotaReset(now - 1000, now)).toBe('—')
    expect(formatQuotaReset(null, now)).toBe('—')
  })
})

describe('AccountQuota', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  async function render(props: { quota: PoolAccountQuotaDto | undefined; showEmpty: boolean; labels?: typeof accountPoolZh }) {
    await act(async () => root.render(createElement(AccountQuota, {
      quota: props.quota,
      showEmpty: props.showEmpty,
      labels: props.labels ?? accountPoolZh,
      now: Date.parse('2030-06-15T00:00:00Z'),
    })))
  }

  const quota: PoolAccountQuotaDto = {
    fetchedAt: Date.parse('2030-06-15T00:00:00Z'),
    windows: [
      { label: '', usedPercent: 42, windowDurationMins: 300, resetsAt: Date.parse('2030-06-15T01:00:00Z') },
      { label: 'Weekly', usedPercent: 100, windowDurationMins: 10_080, resetsAt: null },
    ],
  }

  it('draws one labeled bar per window, with the spent one called out', async () => {
    await render({ quota, showEmpty: true })
    const rows = [...container.querySelectorAll('.dsha-account-quota-row')]
    expect(rows).toHaveLength(2)
    expect(rows[0]!.querySelector('.dsha-account-quota-name')?.textContent).toContain('5')
    expect(rows[0]!.querySelector('.dsha-account-quota-value')?.textContent).toBe('42%')
    expect(rows[1]!.querySelector('.dsha-account-quota-value')?.textContent).toBe(accountPoolZh.quotaExhausted)
    // The bar carries its own reading for a screen reader.
    const bar = rows[0]!.querySelector('[role="progressbar"]')!
    expect(bar.getAttribute('aria-valuenow')).toBe('42')
    expect(bar.getAttribute('aria-label')).toContain(accountPoolZh.quotaUsed)
    expect((bar.querySelector('.dsha-account-quota-fill') as HTMLElement).style.width).toBe('42%')
    // The warning thresholds match the page-level bars: 100% is the danger level.
    expect(rows[1]!.getAttribute('data-level')).toBe('danger')
    expect(rows[0]!.getAttribute('data-level')).toBe('normal')
  })

  it('says when the snapshot was read', async () => {
    await render({ quota, showEmpty: true })
    expect(container.querySelector('.dsha-account-quota-head em')?.textContent).toContain('快照')
  })

  it('says an account was never read, but only when the host asked it to', async () => {
    await render({ quota: undefined, showEmpty: true })
    expect(container.querySelector('.dsha-account-quota-empty')?.textContent).toBe(accountPoolZh.quotaNone)
    await render({ quota: undefined, showEmpty: false })
    expect(container.querySelector('.dsha-account-quota')).toBeNull()
  })

  it('says a read that stated no window produced nothing to show', async () => {
    await render({ quota: { windows: [], fetchedAt: Date.now() }, showEmpty: true })
    expect(container.querySelector('.dsha-account-quota-empty')?.textContent).toBe(accountPoolZh.quotaNone)
    expect(container.querySelectorAll('.dsha-account-quota-row')).toHaveLength(0)
  })

  it('carries the English labels too, so the shared card stays bilingual', async () => {
    await render({ quota: { windows: [], fetchedAt: 0 }, showEmpty: true, labels: accountPoolEn })
    expect(container.querySelector('.dsha-account-quota-empty')?.textContent).toBe(accountPoolEn.quotaNone)
  })
})
