// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { zh } from '../src/client/ollama/locales.ts'
import { accountPoolZh } from '../src/client/common/account-pool-labels.ts'

describe('Ollama locale dictionary', () => {
  it('reuses the shared pool wording so the tab cannot drift from the others', () => {
    // Consistency is the point of this test: a hand-written Ollama card would
    // slowly say different things for the same badge, and the user would read
    // that as a different feature rather than the same one.
    expect(zh.accountPool).toBe(accountPoolZh.accountPool)
    expect(zh.storage).toBe(accountPoolZh.storage)
    expect(zh.strategyRoundRobin).toBe(accountPoolZh.strategyRoundRobin)
    expect(zh.cooldownLeft).toBe(accountPoolZh.cooldownLeft)
  })

  it('overrides only the two labels that would be false for a pasted key', () => {
    // An Ollama key never expires and is not re-signed-in, so the shared wording
    // would state something untrue about this line.
    expect(zh.relogin).not.toBe(accountPoolZh.relogin)
    expect(zh.needsRelogin).not.toBe(accountPoolZh.needsRelogin)
    expect(zh.relogin).toContain('Key')
  })

  it('states the documented service limits rather than hiding them', () => {
    // A user who hits one of these deserves to know it is the service's boundary,
    // not a bug in this line.
    expect(zh.limitNoStateful).not.toBe('')
    expect(zh.limitNoWebSearch).not.toBe('')
    expect(zh.limitNoToolReplay).not.toBe('')
    expect(zh.limitUsage).toContain('API')
  })

  it('explains the two wire surfaces the line speaks', () => {
    expect(zh.wireNote).toContain('/v1')
    expect(zh.wireNote).toContain('/api/chat')
  })

  it('offers a label field, because Ollama names nothing about the account', () => {
    expect(zh.keyAliasLabel).not.toBe('')
    expect(zh.keyAliasHint).not.toBe('')
  })
})