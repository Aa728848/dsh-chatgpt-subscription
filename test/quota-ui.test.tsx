// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { formatReset, QuotaBar, ResetCreditsFact, windowLabel } from '../src/client/CodexSubscriptionSection.tsx'
import { selectQuotaForModel } from '../src/client/quota.ts'
import { zh } from '../src/client/locales.ts'

const t = ((key: keyof typeof zh) => zh[key]) as never

describe('quota UI', () => {
  it.each([
    [32, 'normal'],
    [85, 'warning'],
    [100, 'danger'],
  ])('renders %s%% with semantic progress and the expected threshold', (usedPercent, level) => {
    const html = renderToStaticMarkup(<QuotaBar
      label="5 小时额度"
      window={{ usedPercent, windowDurationMins: 300, resetsAt: null }}
      t={t}
    />)
    expect(html).toContain('role="progressbar"')
    expect(html).toContain(`aria-valuenow="${usedPercent}"`)
    expect(html).toContain(`dsh-codex-meter-${level}`)
    expect(html).toContain(`${100 - usedPercent}% 剩余`)
    if (usedPercent === 100) expect(html).toContain('额度已用尽')
  })

  it('shows reset credit expiry and enables use only when a credit is available', () => {
    const expiresAt = Date.parse('2030-01-01T02:00:00Z') / 1000
    const available = renderToStaticMarkup(<ResetCreditsFact resetCredits={{ availableCount: 1, expiresAt }} busy={null} onUse={async () => undefined} t={t} />)
    expect(available).toContain('到期时间')
    expect(available).toContain('2030')
    expect(available).toContain('使用重置卡')
    expect(available).not.toContain('disabled=""')

    const empty = renderToStaticMarkup(<ResetCreditsFact resetCredits={{ availableCount: 0, expiresAt: null }} busy={null} onUse={async () => undefined} t={t} />)
    expect(empty).toContain('disabled=""')
    expect(empty).toContain('未知')

    const legacy = renderToStaticMarkup(<ResetCreditsFact resetCredits={{ availableCount: 1 } as never} busy={null} onUse={async () => undefined} t={t} />)
    expect(legacy).toContain('未知')
  })

  it('derives window labels and shows absolute plus relative reset time', () => {
    expect(windowLabel(300, t)).toContain('5')
    expect(windowLabel(300, t)).toContain('额度')
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    const reset = formatReset(Date.parse('2030-01-01T02:00:00Z') / 1000)
    expect(reset).toContain('2030')
    expect(reset).toMatch(/[（(].*2.*[）)]/)
    vi.useRealTimers()
  })

  it('selects 5h window when available even if weekly window is more used', () => {
    const quota = {
      state: 'ready' as const,
      stale: false,
      fetchedAt: Date.now(),
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      resetCredits: null,
      buckets: [
        {
          id: 'codex',
          name: 'Codex',
          planType: 'plus',
          primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: null }, // 5h window
          secondary: { usedPercent: 75, windowDurationMins: 10080, resetsAt: null }, // weekly window
          windows: [
            { usedPercent: 10, windowDurationMins: 300, resetsAt: null },
            { usedPercent: 75, windowDurationMins: 10080, resetsAt: null },
          ],
        },
      ],
    }

    const selected = selectQuotaForModel(quota, 'gpt-5.6-sol')
    expect(selected).not.toBeNull()
    expect(selected?.window.windowDurationMins).toBe(300)
    expect(selected?.remainingPercent).toBe(90)
  })

  it('falls back to weekly window if 5h window is not present', () => {
    const quota = {
      state: 'ready' as const,
      stale: false,
      fetchedAt: Date.now(),
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      resetCredits: null,
      buckets: [
        {
          id: 'codex',
          name: 'Codex',
          planType: 'plus',
          primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: null },
          secondary: null,
          windows: [{ usedPercent: 40, windowDurationMins: 10080, resetsAt: null }],
        },
      ],
    }

    const selected = selectQuotaForModel(quota, 'gpt-5.6-sol')
    expect(selected).not.toBeNull()
    expect(selected?.window.windowDurationMins).toBe(10080)
    expect(selected?.remainingPercent).toBe(60)
  })
})
