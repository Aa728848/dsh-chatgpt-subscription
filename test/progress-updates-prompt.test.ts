import { describe, expect, it } from 'vitest'
import { progressSectionText } from '../src/host/progress-updates/prompt.ts'

describe('progressSectionText', () => {
  it('takes no switch input, so the system prompt cannot change with the feature flag', () => {
    // The switch used to be read here, which rewrote the prompt section — and
    // with it the cached prefix — every time the user toggled the feature.
    const text = progressSectionText(() => 'zh')
    expect(text()).toBe(text())
    expect(text().length).toBeGreaterThan(0)
  })

  it('still follows the language setting', () => {
    expect(progressSectionText(() => 'zh')()).not.toBe(progressSectionText(() => 'en')())
  })
})
