import { describe, expect, it } from 'vitest'

/**
 * The canary for test isolation.
 *
 * Every storage path in this plugin falls back to `$DSH_HOME`, so a test file
 * that loses the isolated home writes the developer's real credentials. This
 * file asserts the setup is still in force; if a fixture ever clears the
 * variable for good, this fails instead of the real profile being overwritten.
 */
describe('test isolation', () => {
  it('runs every test file against a private DSH_HOME', () => {
    const home = process.env.DSH_HOME
    expect(typeof home).toBe('string')
    expect(home).not.toBe('')
    expect(home).toContain('dsh-test-home-')
  })
})
