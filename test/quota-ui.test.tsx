// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { formatReset, QuotaBar, windowLabel } from '../src/client/CodexSubscriptionSection.tsx'
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
})
