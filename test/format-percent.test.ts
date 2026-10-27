/**
 * Percentages on the quota cards.
 *
 * The cards mostly show a REMAINDER, and `100 - used` is where binary floating
 * point leaks: `100 - 8.04` is `91.96000000000001`. Interpolating the difference
 * therefore printed a long decimal for roughly a third of all two-decimal used
 * shares, which is why the bug read as "sometimes". These cases pin the rule:
 * round the result, at most two decimals, no trailing zeros.
 */
import { describe, expect, it } from 'vitest'
import { formatPercent } from '../src/client/common/format.ts'

describe('formatPercent', () => {
  it('turns the remainder of a two-decimal share into the number a person reads', () => {
    expect(formatPercent(100 - 8.04)).toBe('91.96')
    expect(formatPercent(100 - 8.21)).toBe('91.79')
    expect(formatPercent(100 - 88.55)).toBe('11.45')
  })

  it('keeps a value that is already short exactly as it is', () => {
    expect(formatPercent(42)).toBe('42')
    expect(formatPercent(66.42)).toBe('66.42')
    expect(formatPercent(0.07)).toBe('0.07')
    expect(formatPercent(0)).toBe('0')
  })

  it('never prints more decimals than asked for, and drops trailing zeros', () => {
    expect(formatPercent(33.57999999999999)).toBe('33.58')
    expect(formatPercent(1 / 3)).toBe('0.33')
    expect(formatPercent(1 / 3, 0)).toBe('0')
    expect(formatPercent(91.96000000000001, 1)).toBe('92')
    // A round trip through a negative zero must not print "-0".
    expect(formatPercent(-0.001)).toBe('0')
  })

  it('reports an unusable number as zero rather than as NaN', () => {
    expect(formatPercent(Number.NaN)).toBe('0')
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe('0')
  })
})
