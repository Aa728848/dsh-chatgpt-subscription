import { describe, expect, it } from 'vitest'
import { defaultAntigravityAcpSettings, parseAntigravityAcpSettings } from '../../../src/host/providers/antigravity-acp/settings.ts'
import { zh } from '../../../src/client/providers/antigravity-acp/locales.ts'

describe('antigravity-acp default state', () => {
  it('defaults to enabled: true', () => {
    expect(defaultAntigravityAcpSettings().enabled).toBe(true)
  })

  it('preserves an explicit stored false', () => {
    expect(parseAntigravityAcpSettings({ enabled: false }).enabled).toBe(false)
  })

  it('treats a corrupt enabled flag as off', () => {
    expect(parseAntigravityAcpSettings({ enabled: 'yes' }).enabled).toBe(false)
  })

  it('carries a compliance notice key in client locales', () => {
    expect(Object.keys(zh).some((key) => /compliance|terms|risk/i.test(key))).toBe(true)
  })
})
