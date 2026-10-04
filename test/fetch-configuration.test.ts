import { describe, expect, it } from 'vitest'
import { resolveFetchConfiguration } from '../src/host/fetch-configuration.ts'
import { Config } from '../src/index.ts'

describe('fetch configuration', () => {
  it('preserves historical defaults', () => {
    expect(resolveFetchConfiguration({})).toEqual({ fetchProvider: 'auto', fetchMaxBodyChars: 100_000, fetchMaxResponseBytes: 2_097_152 })
    expect(Config({})).toMatchObject(resolveFetchConfiguration({}))
  })
  it('accepts independent selection and larger positive limits', () => {
    const config = { fetchProvider: 'dsh' as const, fetchMaxBodyChars: 1_000_000, fetchMaxResponseBytes: 4_194_304 }
    expect(resolveFetchConfiguration(config)).toEqual(config)
    expect(Config(config)).toMatchObject(config)
  })
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid limits %s', value => {
    expect(() => resolveFetchConfiguration({ fetchMaxBodyChars: value })).toThrow(/positive safe integer/)
    expect(() => resolveFetchConfiguration({ fetchMaxResponseBytes: value })).toThrow(/positive safe integer/)
  })
  it('rejects unknown selection rather than silently taking over', () => {
    expect(() => resolveFetchConfiguration({ fetchProvider: 'other' as never })).toThrow(/fetchProvider/)
  })
})
