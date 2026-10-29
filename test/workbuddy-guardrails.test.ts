import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_GUARDRAILS,
  WorkBuddyUsageLedger,
  evaluateGuardrails,
  guardrailsArmed,
  localDayKey,
  normalizeGuardrails,
} from '../src/host/workbuddy/guardrails.ts'

const temporaryDirs: string[] = []

afterEach(async () => {
  for (const dir of temporaryDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

async function ledgerFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-guardrails-'))
  temporaryDirs.push(dir)
  return path.join(dir, 'usage.json')
}

describe('guardrail settings', () => {
  it('treats anything unusable as off', () => {
    expect(normalizeGuardrails(undefined)).toEqual(DEFAULT_GUARDRAILS)
    expect(normalizeGuardrails({ dailyTokens: -5, reserveCredits: 'x', modelDailyTokens: 1.9 }))
      .toEqual({ reserveCredits: 0, dailyTokens: 0, modelDailyTokens: 1 })
    expect(guardrailsArmed(DEFAULT_GUARDRAILS)).toBe(false)
    expect(guardrailsArmed({ ...DEFAULT_GUARDRAILS, dailyTokens: 1 })).toBe(true)
  })

  it('names days by the local calendar, not UTC', () => {
    const noon = new Date(2026, 9, 18, 12, 0, 0).getTime()
    expect(localDayKey(noon)).toBe('2026-10-18')
    expect(localDayKey(noon + 12 * 3_600_000)).toBe('2026-10-19')
  })
})

describe('usage ledger', () => {
  it('adds up per account and per model, and ignores non-positive input', async () => {
    const ledger = new WorkBuddyUsageLedger(await ledgerFile())
    await ledger.load()
    await ledger.record('a', 'glm-5.3', 100)
    await ledger.record('a', 'glm-5.3', 50)
    await ledger.record('a', 'kimi-k3', 25)
    await ledger.record('a', 'kimi-k3', 0)
    await ledger.record('a', 'kimi-k3', Number.NaN)
    expect(ledger.tokensToday('a')).toBe(175)
    expect(ledger.modelTokensToday('a', 'glm-5.3')).toBe(150)
    expect(ledger.modelTokensToday('a', 'kimi-k3')).toBe(25)
    expect(ledger.tokensToday('b')).toBe(0)
  })

  it('survives a restart', async () => {
    const file = await ledgerFile()
    const first = new WorkBuddyUsageLedger(file)
    await first.load()
    await first.record('a', 'glm-5.3', 400)

    const second = new WorkBuddyUsageLedger(file)
    await second.load()
    expect(second.tokensToday('a')).toBe(400)
    expect(second.modelTokensToday('a', 'glm-5.3')).toBe(400)
  })

  it('starts a fresh day when the local date changes', async () => {
    const file = await ledgerFile()
    let now = new Date(2026, 9, 18, 23, 0, 0).getTime()
    const ledger = new WorkBuddyUsageLedger(file, () => now)
    await ledger.load()
    await ledger.record('a', 'glm-5.3', 400)
    expect(ledger.tokensToday('a')).toBe(400)
    now += 2 * 3_600_000 // past local midnight
    expect(ledger.tokensToday('a')).toBe(0)
    expect(ledger.modelTokensToday('a', 'glm-5.3')).toBe(0)
  })
})

describe('guardrail verdicts', () => {
  const armed = { reserveCredits: 5, dailyTokens: 1_000, modelDailyTokens: 500 }

  it('allows a request nothing has reached', () => {
    expect(evaluateGuardrails({
      guardrails: armed, tokensToday: 10, modelTokensToday: 10, remainingCredits: 100,
    })).toEqual({ allowed: true })
  })

  it('refuses an account reserved for a credit floor, but only when the balance is known', () => {
    expect(evaluateGuardrails({
      guardrails: armed, tokensToday: 0, modelTokensToday: 0, remainingCredits: 4,
    })).toMatchObject({ allowed: false, reason: 'reserve-credits' })
    // Never read is not zero: an unmeasured balance must not refuse service.
    expect(evaluateGuardrails({
      guardrails: armed, tokensToday: 0, modelTokensToday: 0, remainingCredits: undefined,
    })).toEqual({ allowed: true })
    expect(evaluateGuardrails({
      guardrails: armed, tokensToday: 0, modelTokensToday: 0, remainingCredits: null,
    })).toEqual({ allowed: true })
  })

  it('refuses the whole account at the daily token cap', () => {
    expect(evaluateGuardrails({
      guardrails: armed, tokensToday: 1_000, modelTokensToday: 0, remainingCredits: 100,
    })).toMatchObject({ allowed: false, reason: 'daily-tokens' })
  })

  it('refuses one model at the per-model cap while the account stays usable', () => {
    expect(evaluateGuardrails({
      guardrails: armed, tokensToday: 600, modelTokensToday: 500, remainingCredits: 100,
    })).toMatchObject({ allowed: false, reason: 'model-daily-tokens' })
    expect(evaluateGuardrails({
      guardrails: armed, tokensToday: 600, modelTokensToday: 0, remainingCredits: 100,
    })).toEqual({ allowed: true })
  })

  it('does nothing when every guardrail is off', () => {
    expect(evaluateGuardrails({
      guardrails: DEFAULT_GUARDRAILS, tokensToday: 9_999_999, modelTokensToday: 9_999_999, remainingCredits: 0,
    })).toEqual({ allowed: true })
  })
})
