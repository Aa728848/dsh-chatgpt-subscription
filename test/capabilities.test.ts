import { describe, expect, it } from 'vitest'
import { capabilityOf, capabilityTable, maySend } from '../src/host/common/capabilities.ts'

const ROUTES = Object.keys(capabilityTable())

describe('provider capability matrix', () => {
  it('covers every route this plugin ships', () => {
    expect(ROUTES.sort()).toEqual([
      'antigravity',
      'claude',
      'codex-chatgpt',
      'command-code',
      'kimi-code',
      'minimax-code',
      'ollama',
      'workbuddy',
    ])
  })

  it('never lets an unverified feature onto the wire', () => {
    for (const route of ROUTES) {
      for (const capability of Object.keys(capabilityTable()[route] ?? {}) as Array<keyof ReturnType<typeof capabilityTable>[string]>) {
        const state = capabilityOf(route, capability as never)
        // The gate is deliberately strict: only an exercised capability may be
        // sent, so adding a promising entry cannot silently turn a field on.
        expect(maySend(route, capability as never)).toBe(state === 'supported')
      }
    }
  })

  it('treats an unrecorded route or feature as unknown rather than absent', () => {
    expect(capabilityOf('a-route-nobody-declared', 'tool-search')).toBe('unknown')
    // A recorded entry keeps its own verdict: unknown is only the fallback for
    // something nobody wrote down.
    expect(capabilityOf('ollama', 'server-side-compaction')).toBe('unsupported')
    expect(maySend('a-route-nobody-declared', 'tool-search')).toBe(false)
  })

  it('keeps the unverified Codex features off by default', () => {
    // These are real Responses API features; this route fronts a subscription
    // endpoint that has not been shown to accept them.
    expect(maySend('codex-chatgpt', 'tool-search')).toBe(false)
    expect(maySend('codex-chatgpt', 'server-side-compaction')).toBe(false)
    expect(maySend('codex-chatgpt', 'multi-agent-server')).toBe(false)
  })
})