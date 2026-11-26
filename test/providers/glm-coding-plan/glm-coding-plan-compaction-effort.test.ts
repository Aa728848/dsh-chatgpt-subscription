import { describe, expect, it } from 'vitest'
import { GlmCodingPlanAdapter } from '../../../src/host/providers/glm-coding-plan/adapter.ts'
import { credentialsFromCliLogin } from '../../../src/host/providers/glm-coding-plan/token-store.ts'
import type { GlmCodingPlanCredentials, GlmCodingPlanModelSettings } from '../../../src/host/providers/glm-coding-plan/token-store.ts'
import type { GlmCliCredentials } from '../../../src/host/providers/glm-coding-plan/oauth.ts'

/**
 * An auxiliary request (a compaction summary) must carry the session's own
 * reasoning level, not the settings default: the effort is part of the request
 * the upstream prefix-caches against, so a different level re-reads the whole
 * conversation cold.
 */
function frame(value: unknown): string {
  return 'data: ' + JSON.stringify(value) + '\n\n'
}
const ANTHROPIC_OK =
  frame({ type: 'message_start', message: { usage: { input_tokens: 4 } } })
  + frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  + frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })
  + frame({ type: 'content_block_stop', index: 0 })
  + frame({ type: 'message_stop' })

function credentials(): GlmCodingPlanCredentials {
  const session: GlmCliCredentials = {
    region: 'intl', accessToken: 'at', refreshToken: null, zcodeToken: null,
    userId: 'u1', email: 'a@example.com', displayName: null, hasAvatar: false,
    authenticatedAt: 1_700_000_000_000,
  }
  return credentialsFromCliLogin(session, {
    region: 'intl', codingPlanKey: 'ak_1.sk_1', apiKeyId: 'ak_1', secretKey: 'sk_1',
    keyName: 'dsh', keyCreated: false, organizationId: 'org_1', projectId: 'proj_1',
    accountName: null, bizToken: 'biz.jwt', bizTokenExpiresAt: Date.now() + 3_600_000, planLevel: 'pro',
  })
}

function settings(): GlmCodingPlanModelSettings {
  return {
    enabled: true, enabledModelIds: ['GLM-5.3'], contextWindowOverrides: {},
    defaultReasoningEffort: 'max', selectedAccountId: null,
  }
}

async function collect(adapter: GlmCodingPlanAdapter, overrides: Record<string, unknown>): Promise<void> {
  const request = { provider: 'glm-coding-plan', model: 'GLM-5.3', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], ...overrides }
  for await (const _chunk of adapter.stream(request as never)) void _chunk
}

function buildAdapter(bodies: Array<Record<string, unknown>>): GlmCodingPlanAdapter {
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response(ANTHROPIC_OK, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  return new GlmCodingPlanAdapter(
    { read: async () => credentials() } as never,
    { read: async () => settings() } as never,
    undefined,
    { fetchFn },
  )
}

describe('GLM auxiliary request effort', () => {
  it('sends a compaction at the session main-turn effort, not the settings default', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const adapter = buildAdapter(bodies)
    await collect(adapter, { sessionId: 'sess-a', reasoningEffort: 'high' })
    await collect(adapter, { sessionId: 'sess-a', purpose: 'compaction' })
    expect((bodies[0]!.output_config as { effort?: string }).effort).toBe('high')
    expect((bodies[1]!.output_config as { effort?: string }).effort).toBe('high')
  })
})
