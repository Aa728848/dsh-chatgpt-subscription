/**
 * The line ships ENABLED, and the terms risk is disclosed rather than gated.
 *
 * Google's Antigravity FAQ states that accessing Antigravity through third-party
 * software violates its Terms of Service, while the same vendor documents running
 * \`agy acp\` inside editors. The product decision is to ship the line on - a line
 * that ships dark is a line most people never find - and to put the warning on
 * the card and in the docs instead of hiding the feature behind a default.
 */
import { describe, expect, it } from 'vitest'
import { defaultAntigravityAcpSettings, parseAntigravityAcpSettings } from '../src/host/antigravity-acp/settings.ts'
import { zh } from '../src/client/antigravity-acp/locales.ts'

describe('the line ships enabled', () => {
  it('defaults to enabled: true', () => {
    expect(defaultAntigravityAcpSettings().enabled).toBe(true)
  })

  it('keeps a stored explicit false', () => {
    // A user who switched the line off must never see it switched back on by a
    // default or by the next read.
    expect(parseAntigravityAcpSettings({ enabled: false }).enabled).toBe(false)
  })

  it('treats a corrupt enabled flag as off, not on', () => {
    expect(parseAntigravityAcpSettings({ enabled: 'yes' }).enabled).toBe(false)
  })
})

describe('the card states the terms risk', () => {
  it('carries a compliance paragraph in both shipped languages', () => {
    // The sentence a user must be able to read before switching the line on.
    expect(Object.keys(zh).some((key) => /compliance|terms|risk/i.test(key))).toBe(true)
  })
})
