import { describe, expect, it } from 'vitest'
import { LINE_DEFINITIONS } from '../src/host/widget-board/line-registry.ts'

/** The Antigravity (ACP) status route answer, as the host builds it. */
const ANTIGRAVITY_ACP_STATUS = {
  ok: true,
  value: {
    binary: { kind: 'local-cli', path: 'C:/Users/example/.gemini/bin/agy.exe', version: '1.5.3' },
    auth: { authenticated: true, method: 'oauth-personal', tier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' } },
    models: [
      { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', efforts: ['low', 'medium', 'high'], contextWindow: 1048576 },
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high'] },
    ],
    enabledModelIds: null,
    defaultReasoningEffort: null,
    permissionPolicy: 'reject',
    catalogSynced: true,
    usage: { inputTokens: 9084, outputTokens: 34, cacheReadTokens: 0, at: 1792658466348 },
  },
}

describe('Antigravity (ACP) widget-board line', () => {
  it('is registered with its own status and refresh routes', () => {
    const definition = LINE_DEFINITIONS.find((entry) => entry.id === 'antigravity-acp')
    expect(definition).toBeDefined()
    expect(definition?.statusPath).toBe('/antigravity-acp/api/status')
    expect(definition?.refreshPath).toBe('/antigravity-acp/api/refresh')
  })

  it('reports the plan tier and no quota at all', () => {
    const definition = LINE_DEFINITIONS.find((entry) => entry.id === 'antigravity-acp')!
    const facts = definition.normalize(ANTIGRAVITY_ACP_STATUS.value)
    // The official ACP server publishes no remaining quota. A card that drew a
    // percentage here would be inventing the single most misleading number on
    // the board, so `quota` stays null and the tier is what the card states.
    expect(facts.quota).toBeNull()
    expect(facts.planLabel).toBe('Google AI Ultra')
    expect(facts.signedIn).toBe(true)
    expect(facts.error).toBeNull()
  })

  it('reports a signed-out line without inventing a plan', () => {
    const definition = LINE_DEFINITIONS.find((entry) => entry.id === 'antigravity-acp')!
    const facts = definition.normalize({
      binary: { kind: 'missing', error: 'No usable Antigravity CLI (agy) was found.' },
      auth: { authenticated: false },
      models: [],
      enabledModelIds: null,
      defaultReasoningEffort: null,
      permissionPolicy: 'reject',
      catalogSynced: false,
    })
    expect(facts.quota).toBeNull()
    expect(facts.planLabel).toBeNull()
    expect(facts.signedIn).toBe(false)
    expect(facts.error).toContain('No usable Antigravity CLI')
  })
})
