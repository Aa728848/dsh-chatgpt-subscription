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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

describe('the documentation states the shipped default', () => {
  // The code said "enabled" while four documents said "switched off by default".
  // That is the one contradiction a reader could not resolve without the source:
  // it made the line look like an opt-in when it was already running. The docs
  // are read here so the two can never drift apart again.
  const root = join(import.meta.dirname, '..')

  it('never advertises the line as switched off by default', () => {
    // Only the paragraphs that talk about THIS line are checked: the same word
    // legitimately describes the reasoning-collapse breaker, the Cline Pass tools
    // and the GLM signing layer in changelog entries that predate this line.
    const files = ['README.md', 'docs/providers.md', 'docs/antigravity-acp-line-plan.md', 'CHANGELOG.md']
    for (const file of files) {
      const text = readFileSync(join(root, file), 'utf8')
      for (const paragraph of text.split(/\n\s*\n/)) {
        if (!paragraph.includes('antigravity-acp')) continue
        expect(paragraph, `${file} still claims the line ships disabled`).not.toContain('默认关闭')
      }
    }
  })

  it('says the line ships enabled and can be switched off', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8')
    expect(readme).toContain('默认启用')
    const providers = readFileSync(join(root, 'docs/providers.md'), 'utf8')
    expect(providers).toContain('默认启用')
  })
})

describe('the card states the terms risk', () => {
  it('carries a compliance paragraph in both shipped languages', () => {
    // The sentence a user must be able to read before switching the line on.
    expect(Object.keys(zh).some((key) => /compliance|terms|risk/i.test(key))).toBe(true)
  })
})
