import { describe, expect, it } from 'vitest'
import { inject } from '../src/index.ts'

/**
 * The reasoning-collapse guard finds the Agent it must cancel and resume by
 * reading `ctx.agents` — a plain service property, not a `ctx.get` lookup.
 *
 * Cordis only places a service on the plugin context when the plugin declares
 * it in `inject`. Without that entry the property is `undefined` at runtime,
 * `resolveAgent` finds nothing, and `breakOff` returns at its first line: the
 * runaway is cut and NO resume is queued. The turn then ends with nothing in
 * the transcript saying why, which reads to the user as a conversation that
 * simply stopped mid-answer.
 *
 * The guard's own unit tests hand their fake context an `agents` property
 * directly, so they pass whether or not this declaration exists — only the
 * runtime wiring can regress. Hence this assertion on the export itself.
 */
describe('plugin service injection', () => {
  it('declares agents, the service the reasoning-collapse guard reads', () => {
    expect(inject).toContain('agents')
  })

  it('keeps declaring the services the plugin already consumed', () => {
    for (const service of ['webServer', 'llm', 'attachments', 'tools', 'settings', 'loader']) {
      expect(inject).toContain(service)
    }
  })
})
