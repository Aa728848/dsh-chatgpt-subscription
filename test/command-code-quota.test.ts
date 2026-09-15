import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearCachedQuota,
  extractCreditsBalanceForTest,
  parseMeters,
  parseSubscriptionPeriodEnd,
  parseSubscriptionStatus,
  parsePlanId,
} from '../src/host/command-code/client.ts'
import { commandCodePlanLabel, resolveCommandCodePlan } from '../src/host/command-code/plans.ts'

/**
 * The shapes below were captured verbatim from the live service on a signed-in
 * GOAT account. They are the regression fixtures for the two bugs this file
 * locks down: the credit card printed `meter-1`/`meter-2` because the window
 * keys carry no display string, and the plan row was blank because the service
 * reports only the machine id `individual-goat`.
 */
const CREDITS = {
  credits: {
    belowThreshold: false,
    creditThreshold: 0,
    monthlyCredits: 58.11872479,
    purchasedCredits: 0,
    freeCredits: 0,
  },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: { used: 1.526840679, cap: 14, exceeded: false, resetAt: 1789468650752 },
    weekly: { used: 11.88127521, cap: 35, exceeded: false, resetAt: 1789901115029 },
  },
}

const SUBSCRIPTIONS = {
  success: true,
  data: {
    id: 'sub_1UFAiaDSZgxV3MJKV9jgjh2c',
    status: 'active',
    userId: 'bbba4ac7-cdce-41b7-bcf3-bbae0603cd1f',
    orgId: null,
    planId: 'individual-goat',
    cancelAtPeriodEnd: false,
    currentPeriodStart: '2026-09-13T10:32:32.000Z',
    currentPeriodEnd: '2026-10-13T10:32:32.000Z',
  },
}

const USAGE = {
  totalCount: 3561,
  totalCost: 11.775409694999995,
  totalTokens: 873670438,
  periodBasis: 'billing-period',
}

afterEach(() => {
  clearCachedQuota()
  vi.restoreAllMocks()
})

describe('Command Code plan ids', () => {
  it('names every plan the CLI names', () => {
    expect(commandCodePlanLabel('individual-goat')).toBe('GOAT')
    expect(commandCodePlanLabel('individual-go')).toBe('Go')
    expect(commandCodePlanLabel('individual-pro')).toBe('Pro')
    expect(commandCodePlanLabel('individual-max')).toBe('Max')
    expect(commandCodePlanLabel('individual-ultra')).toBe('Ultra')
    expect(commandCodePlanLabel('individual-provider')).toBe('Provider')
    expect(commandCodePlanLabel('teams-pro')).toBe('Teams Pro')
  })

  it('matches the longest id first so a shared prefix cannot steal a plan', () => {
    // `individual-pro` is a prefix of both of these.
    expect(resolveCommandCodePlan('individual-provider')?.name).toBe('Provider')
    expect(resolveCommandCodePlan('individual-pro-v1')?.name).toBe('Pro')
    expect(resolveCommandCodePlan('individual-pro-v1')?.monthlyCredits).toBe(80)
    expect(resolveCommandCodePlan('individual-pro')?.monthlyCredits).toBe(30)
  })

  it('normalizes separators and case the way the service varies them', () => {
    expect(commandCodePlanLabel('individual_goat')).toBe('GOAT')
    expect(commandCodePlanLabel('INDIVIDUAL-GOAT')).toBe('GOAT')
  })

  it('shows an unknown id rather than hiding it, and answers null for nothing', () => {
    expect(commandCodePlanLabel('individual-future')).toBe('individual-future')
    expect(commandCodePlanLabel(null)).toBeNull()
    expect(commandCodePlanLabel(undefined)).toBeNull()
    expect(commandCodePlanLabel('  ')).toBeNull()
  })

  it('reads the plan id out of the subscription payload', () => {
    expect(parsePlanId([SUBSCRIPTIONS, CREDITS])).toBe('individual-goat')
    expect(parsePlanId([CREDITS])).toBeNull()
  })

  it('reads the subscription status and its period end', () => {
    expect(parseSubscriptionStatus(SUBSCRIPTIONS)).toBe('active')
    expect(parseSubscriptionPeriodEnd(SUBSCRIPTIONS)).toBe(Date.parse('2026-10-13T10:32:32.000Z'))
    expect(parseSubscriptionStatus(CREDITS)).toBeNull()
    expect(parseSubscriptionPeriodEnd(CREDITS)).toBeNull()
  })
})

describe('Command Code credit windows', () => {
  it('labels the 5-hour and weekly windows instead of numbering them', () => {
    const meters = parseMeters(CREDITS)
    const ids = meters.map((meter) => meter.id)
    // The bug: these used to come back as `meter-1` / `meter-2`.
    expect(ids).not.toContain('meter-1')
    expect(ids).not.toContain('meter-2')
    expect(ids).toContain('fiveHour')
    expect(ids).toContain('weekly')

    const fiveHour = meters.find((meter) => meter.id === 'fiveHour')!
    expect(fiveHour.label).toBe('5-hour')
    expect(fiveHour.used).toBe('1.53')
    expect(fiveHour.limit).toBe('14')
    expect(fiveHour.remainingFraction).toBeCloseTo(1 - 1.526840679 / 14, 6)
    // Unix milliseconds must survive as-is rather than being treated as seconds.
    expect(fiveHour.resetsAt).toBe(1789468650752)
    expect(new Date(fiveHour.resetsAt!).getFullYear()).toBe(2026)

    const weekly = meters.find((meter) => meter.id === 'weekly')!
    expect(weekly.label).toBe('Weekly')
    expect(weekly.used).toBe('11.88')
    expect(weekly.limit).toBe('35')
    expect(weekly.resetsAt).toBe(1789901115029)
  })

  it('lists the shortest window first regardless of payload key order', () => {
    const reversed = { windowLimits: { ...CREDITS.windowLimits, weekly: CREDITS.windowLimits.weekly, fiveHour: CREDITS.windowLimits.fiveHour } }
    const order = parseMeters(reversed).filter((meter) => meter.remainingFraction !== null).map((meter) => meter.id)
    expect(order).toEqual(['fiveHour', 'weekly'])
  })

  it('reads the credit pools and sums them into one balance', () => {
    expect(extractCreditsBalanceForTest(CREDITS)).toBe('58.12')
    const meters = parseMeters(CREDITS)
    expect(meters.find((meter) => meter.id === 'monthly-credits')?.limit).toBe('58.12')
    // A zero pool is still reported, so the card can say "0" rather than nothing.
    expect(meters.find((meter) => meter.id === 'purchased-credits')?.limit).toBe('0')
    expect(meters.find((meter) => meter.id === 'free-credits')?.limit).toBe('0')
  })

  it('sums a payload that reports only some pools', () => {
    expect(extractCreditsBalanceForTest({ credits: { monthlyCredits: 5, purchasedCredits: 2.5 } })).toBe('7.50')
    expect(extractCreditsBalanceForTest({ credits: { freeCredits: 3 } })).toBe('3')
    expect(extractCreditsBalanceForTest({ credits: {} })).toBeNull()
  })

  it('keeps working for a payload that reports a flat balance', () => {
    expect(extractCreditsBalanceForTest({ creditBalance: 12.5 })).toBe('12.50')
    const meters = parseMeters({ creditBalance: 12.5 })
    expect(meters).toHaveLength(1)
    expect(meters[0]).toMatchObject({ id: 'credits', limit: '12.50' })
  })

  it('reports an unnamed allowance under a descriptive label, never meter-N', () => {
    // A bare numeric allowance is still real, so it must not be hidden — but the
    // label has to say what the number is, which `meter-1` never did.
    const meters = parseMeters({ quota: { used: 1, cap: 2 } })
    expect(meters).toHaveLength(1)
    expect(meters[0]!.label).toBe('Extra allowance')
    expect(meters[0]!.id).not.toMatch(/^meter-\d+$/)
    expect(meters[0]!.remainingFraction).toBeCloseTo(0.5)
  })

  it('ignores the usage summary, which carries no bounded allowance', () => {
    expect(parseMeters(USAGE)).toEqual([])
  })
})
