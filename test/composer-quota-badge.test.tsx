// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { ComposerQuotaBadge, quotaLevel, type ComposerQuotaFacts } from '../src/client/common/ComposerQuotaBadge.tsx'
import { selectOpenDesignFacts } from '../src/client/opendesign/OpenDesignComposerQuota.tsx'
import { zh } from '../src/client/opendesign/locales.ts'
import type { OpenDesignCodingPlanDto, OpenDesignWebStatus } from '../src/shared/opendesign-contracts.ts'

interface Status { authenticated: boolean; left: number }

const facts = (status: Status | null): ComposerQuotaFacts | null => status === null
  ? null
  : { text: `${status.left}%`, tooltip: `left ${status.left}%`, level: quotaLevel(status.left) }

function directory(provider: string | undefined) {
  const state = { current: { provider, model: 'm' }, models: [] }
  return { subscribe: () => () => undefined, getSnapshot: () => state }
}

describe('ComposerQuotaBadge', () => {
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

  function mount(props: Partial<Parameters<typeof ComposerQuotaBadge<Status>>[0]> = {}) {
    const readStatus = vi.fn(async () => ({ authenticated: true, left: 42 }))
    const render = (overrides: Record<string, unknown> = {}) => root.render(createElement(ComposerQuotaBadge<Status>, {
      directory: directory('line-a') as never,
      loadModelDirectory: () => undefined,
      providerId: 'line-a',
      readStatus,
      selectFacts: facts,
      label: 'Quota',
      ...props,
      ...overrides,
    } as never))
    return { readStatus, render }
  }

  it('shows the line its own number, under the label it was given', async () => {
    const { render } = mount()
    await act(async () => render())
    expect(container.querySelector('.dsha-composer-quota-val')?.textContent).toBe('42%')
    expect(container.querySelector('.dsha-composer-quota-label')?.textContent).toBe('Quota')
    expect(container.querySelector('.dsha-composer-quota')?.getAttribute('data-level')).toBe('normal')
  })

  it('is inert — and silent — while the conversation is on another provider', async () => {
    const { readStatus, render } = mount({ directory: directory('line-b') as never })
    await act(async () => render())
    expect(container.querySelector('.dsha-composer-quota')).toBeNull()
    expect(readStatus).not.toHaveBeenCalled()
  })

  it('hides itself for a signed-out line', async () => {
    const { render } = mount({ readStatus: async () => ({ authenticated: false, left: 42 }) })
    await act(async () => render())
    expect(container.querySelector('.dsha-composer-quota')).toBeNull()
  })

  it('asks for the forced read on a click, and the plain one otherwise', async () => {
    const { readStatus, render } = mount()
    await act(async () => render())
    expect(readStatus).toHaveBeenLastCalledWith(false)
    await act(async () => container.querySelector('.dsha-composer-quota')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(readStatus).toHaveBeenLastCalledWith(true)
  })

  it('draws the remaining share as a mini meter beside the number', async () => {
    const { render } = mount()
    await act(async () => render({
      selectFacts: (status: Status | null): ComposerQuotaFacts | null => status === null
        ? null
        : { text: `${status.left}%`, tooltip: 'left 42%', level: 'normal', percent: 37.5 },
    }))
    const meter = container.querySelector<HTMLElement>('.dsha-composer-quota-meter')
    expect(meter).not.toBeNull()
    // The number and the tooltip already say it, so the bar is decorative.
    expect(meter!.getAttribute('aria-hidden')).toBe('true')
    expect(meter!.querySelector<HTMLElement>('.dsha-composer-quota-meter-fill')!.style.width).toBe('37.5%')
  })

  it('adds no meter node for a line that reports a number without a share', async () => {
    const { render } = mount({ selectFacts: facts })
    await act(async () => render())
    expect(container.querySelector('.dsha-composer-quota-meter')).toBeNull()
    // Other lines keep the markup they had, byte for byte: label, then number.
    const badge = container.querySelector<HTMLElement>('.dsha-composer-quota')!
    expect([...badge.children].map((child) => child.className))
      .toEqual(['dsha-composer-quota-label', 'dsha-composer-quota-val'])
  })

  it('does not restart its poll when the caller re-renders with fresh callbacks', async () => {
    // The copies took these callbacks as effect dependencies, so a caller that
    // wrote them inline refetched on every render — once a second, in a card
    // that re-renders on model-directory churn.
    const { readStatus, render } = mount()
    await act(async () => render())
    expect(readStatus).toHaveBeenCalledTimes(1)
    await act(async () => render({ readStatus: async () => ({ authenticated: true, left: 7 }) }))
    await act(async () => render({ readStatus: async () => ({ authenticated: true, left: 8 }) }))
    expect(readStatus).toHaveBeenCalledTimes(1)
  })
})

describe('OpenDesignComposerQuota facts', () => {
  const FETCHED_AT = Date.parse('2026-10-22T01:06:22.615Z')
  const READ_AT = zh.usageReadAt.replace('{time}', new Date(FETCHED_AT).toLocaleTimeString())

  /**
   * Only the three fields the picker reads are built, and the cast says so: a
   * full status DTO would bury the two rules this describe pins.
   */
  function statusWith(codingPlan: OpenDesignCodingPlanDto | undefined): OpenDesignWebStatus {
    return {
      authenticated: true,
      pool: { accounts: [], rotationStrategy: 'sequential' },
      usage: {
        accounts: [{
          accountId: 'a3',
          alias: 'Dev',
          ok: true,
          balanceUsd: '1.5000',
          updatedAt: null,
          error: '',
          fetchedAt: FETCHED_AT,
          codingPlan,
        }],
        fetchedAt: FETCHED_AT,
      },
    } as unknown as OpenDesignWebStatus
  }

  it('shows the narrowest Design Plan window as the remaining share, and lists the rest', () => {
    const facts = selectOpenDesignFacts(statusWith({
      tier: 'go',
      error: '',
      // Deliberately widest first: the picker has to find the narrowest itself.
      windows: [
        { policyId: 'seven-day', durationSeconds: 604_800, limitCredits: '1000', remainingCredits: '810', resetsAt: null },
        { policyId: 'five-hour', durationSeconds: 18_000, limitCredits: '1000', remainingCredits: '900', resetsAt: null },
      ],
    }))
    expect(facts).not.toBeNull()
    expect(facts!.text).toBe(zh.usageWindowRemaining.replace('{remaining}', '90'))
    expect(facts!.percent).toBe(90)
    const fiveHours = `${zh.usageWindowHours.replace('{count}', '5')} ${zh.usageWindowRemaining.replace('{remaining}', '90')}`
    const sevenDays = `${zh.usageWindowDays.replace('{count}', '7')} ${zh.usageWindowRemaining.replace('{remaining}', '81')}`
    expect(facts!.tooltip).toContain(fiveHours)
    expect(facts!.tooltip).toContain(sevenDays)
    // Narrowest first, so the list reads in the order the badge prioritizes.
    expect(facts!.tooltip.indexOf(fiveHours)).toBeLessThan(facts!.tooltip.indexOf(sevenDays))
    expect(facts!.tooltip).toContain(READ_AT)
  })

  it('falls back to the wallet balance, with no share to draw, when no window is stated', () => {
    const facts = selectOpenDesignFacts(statusWith({ tier: 'go', error: '', windows: [] }))
    expect(facts).not.toBeNull()
    expect(facts!.text).toBe('$1.5000')
    expect(facts!.tooltip).toBe(`Dev · ${READ_AT}`)
    // Nothing to meter: the key is absent rather than zero, so this line renders
    // the same markup as every other one.
    expect('percent' in facts!).toBe(false)
  })

  it('treats a failed window read as no window at all', () => {
    const facts = selectOpenDesignFacts(statusWith({
      tier: 'go',
      error: 'HTTP 502',
      windows: [{ policyId: 'five-hour', durationSeconds: 18_000, limitCredits: '1000', remainingCredits: '900', resetsAt: null }],
    }))
    expect(facts!.text).toBe('$1.5000')
    expect('percent' in facts!).toBe(false)
  })
})
