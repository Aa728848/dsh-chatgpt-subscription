/**
 * The composer badge's number.
 *
 * The badge shows the share that is LEFT, computed as `100 - used`. That
 * subtraction is where binary floating point shows up (`100 - 8.04` is
 * `91.96000000000001`), so a badge built by string interpolation displayed a
 * long decimal for some readings and looked fine for others. Both the badge and
 * its tooltip must carry the rounded figure, while the level grading keeps
 * using the raw share.
 */
import { describe, expect, it } from 'vitest'
import type { KimiCodeAccount, KimiCodeWebStatus } from '../src/shared/kimi-code-contracts.ts'
import { selectBadgeFacts } from '../src/client/kimi-code/KimiCodeComposerQuota.tsx'

function status(usedPercent: number | null, windows = true): KimiCodeWebStatus {
  // A full status object rather than a cast: the badge reads only `quota`, but a
  // partial fixture silently stops matching the DTO the moment a field is added.
  const account: KimiCodeAccount = {
    userId: 'u_1',
    nickname: 'kimi',
    email: null,
    planName: 'Allegretto',
    planLevel: null,
    region: 'mainland-cn',
    authenticatedAt: null,
  }
  return {
    authenticated: true,
    hasCredentials: true,
    storagePath: '/tmp/kimi.json',
    region: 'mainland-cn',
    oauthHost: 'https://auth.kimi.com',
    codingBaseUrl: 'https://api.kimi.com/coding',
    account,
    lastFetchedAt: Date.now(),
    credentialsRejected: false,
    quotaError: null,
    cache: null,
    preserveThinking: false,
    models: [],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
    loginRegion: 'mainland-cn',
    serving: true,
    conflict: null,
    quota: windows
      ? {
          account,
          planName: 'Allegretto',
          windows: [{
            id: 'limit_5h', label: '5-hour', usedFraction: (usedPercent ?? 0) / 100,
            usedPercent: usedPercent ?? 0, windowDurationMins: 300, resetsAt: Date.now() + 3_600_000,
            limit: null, used: null, remaining: null,
          }],
          extraUsage: null,
          fetchedAt: Date.now(),
          sources: [],
        }
      : {
          account,
          planName: 'Allegretto',
          windows: [],
          extraUsage: {
            balanceCents: 1_250, totalCents: 5_000, monthlyChargeLimitEnabled: false,
            monthlyChargeLimitCents: null, monthlyUsedCents: null, currency: 'CNY',
          },
          fetchedAt: Date.now(),
          sources: [],
        },
  }
}

describe('Kimi composer badge', () => {
  it('rounds the remainder of a share that would otherwise print a long decimal', () => {
    const facts = selectBadgeFacts(status(8.04))!
    expect(facts.text).toBe('91.96%')
    expect(facts.tooltip).toContain('91.96% left')
    expect(facts.tooltip).not.toContain('91.9600')
  })

  it('keeps an ordinary share untouched', () => {
    expect(selectBadgeFacts(status(33.58))!.text).toBe('66.42%')
    expect(selectBadgeFacts(status(100))!.text).toBe('0%')
  })

  it('grades the level from the raw share, not from the rounded text', () => {
    // 4.6% left is still critical even though it prints as "4.6%", and 10%
    // left warns; only a comfortable share is normal.
    expect(selectBadgeFacts(status(95.4))!.level).toBe('danger')
    expect(selectBadgeFacts(status(95.4))!.text).toBe('4.6%')
    expect(selectBadgeFacts(status(90))!.level).toBe('warning')
    expect(selectBadgeFacts(status(70))!.level).toBe('normal')
  })

  it('falls back to the wallet when no window states a share', () => {
    expect(selectBadgeFacts(status(null, false))!.text).toBe('12.50')
  })

  it('draws a dash while nothing is known', () => {
    expect(selectBadgeFacts(null)!.text).toBe('—')
  })
})
