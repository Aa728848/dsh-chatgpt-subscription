/**
 * The composer badge must not turn "never measured" into "0% left".
 *
 * The badge picks one bucket to speak for, and the picker used to take a bucket
 * with no `remainingFraction` and multiply null by 100, which rendered `0%` —
 * the same claim as an exhausted allowance. These cases pin the replacement
 * rule: only a measured bucket is shown, the next measured one in the same group
 * is preferred over it, and a group with nothing measured produces no claim at
 * all (the badge then draws its dash).
 */
import { describe, expect, it } from 'vitest'
import { selectQuotaBucketForModel } from '../src/client/antigravity/AntigravityComposerQuota.tsx'
import type { AntigravityQuotaGroup } from '../src/shared/antigravity-contracts.ts'

function groups(buckets: AntigravityQuotaGroup['buckets']): AntigravityQuotaGroup[] {
  return [{ displayName: 'Gemini Models', buckets }]
}

describe('selectQuotaBucketForModel', () => {
  it('speaks for the shortest measured window in the model group', () => {
    const picked = selectQuotaBucketForModel(groups([
      { bucketId: 'weekly', displayName: 'Weekly', remainingFraction: 0.6 },
      { bucketId: '5h', displayName: '5 hours', remainingFraction: 0.35 },
    ]), 'gemini-3.7-flash')
    expect(picked).toMatchObject({ bucketName: '5 hours', remainingPercent: 35 })
  })

  it('skips an unmeasured bucket instead of calling it 0% left', () => {
    const picked = selectQuotaBucketForModel(groups([
      { bucketId: '5h', displayName: '5 hours', remainingFraction: null },
      { bucketId: 'weekly', displayName: 'Weekly', remainingFraction: 0.4 },
    ]), 'gemini-3.7-flash')
    // Not the 5-hour bucket (nobody measured it) and not 0%: the next measured
    // bucket speaks, and the tooltip names it so the number is attributable.
    expect(picked).toMatchObject({ bucketName: 'Weekly', remainingPercent: 40 })
  })

  it('claims nothing when the group has no measured bucket', () => {
    const picked = selectQuotaBucketForModel(groups([
      { bucketId: '5h', displayName: '5 hours', remainingFraction: null },
      { bucketId: 'weekly', displayName: 'Weekly', remainingFraction: null },
    ]), 'gemini-3.7-flash')
    expect(picked).toBeNull()
  })

  it('treats a missing key and a non-finite value as unmeasured too', () => {
    // An older host omits the field, and nothing in the wire guarantees a
    // number: neither may become "0% left".
    const picked = selectQuotaBucketForModel(groups([
      { bucketId: '5h', displayName: '5 hours', remainingFraction: undefined as unknown as number },
      { bucketId: 'nan', displayName: 'Weekly', remainingFraction: Number.NaN },
    ]), 'gemini-3.7-flash')
    expect(picked).toBeNull()
  })

  it('still reports a measured exhausted bucket as 0%', () => {
    const picked = selectQuotaBucketForModel(groups([
      { bucketId: '5h', displayName: '5 hours', remainingFraction: 0 },
    ]), 'gemini-3.7-flash')
    expect(picked).toMatchObject({ bucketName: '5 hours', remainingPercent: 0 })
  })

  it('reads the Claude/GPT allowance for a Claude model', () => {
    const both: AntigravityQuotaGroup[] = [
      { displayName: 'Gemini', buckets: [{ bucketId: 'g', displayName: '5 hours', remainingFraction: 0.9 }] },
      { displayName: 'Claude and GPT', buckets: [{ bucketId: 'c', displayName: '5 hours', remainingFraction: 0.2 }] },
    ]
    expect(selectQuotaBucketForModel(both, 'claude-opus-4-6')).toMatchObject({ groupName: 'Claude and GPT', remainingPercent: 20 })
    expect(selectQuotaBucketForModel(both, 'gemini-3.7-flash')).toMatchObject({ groupName: 'Gemini', remainingPercent: 90 })
  })

  it('answers nothing for an empty snapshot', () => {
    expect(selectQuotaBucketForModel([], 'gemini-3.7-flash')).toBeNull()
    expect(selectQuotaBucketForModel(groups([]), 'gemini-3.7-flash')).toBeNull()
  })
})
