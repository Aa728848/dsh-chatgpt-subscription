import { describe, expect, it } from 'vitest'
import {
  buildClaudeCodeSystemBlocks,
  ClaudeCodeFirstPartyTracker,
  claudeCodeBillingBlock,
  claudeCodeFirstPartyBetas,
  claudeCodeFirstPartyHeaders,
  claudeCodeMetadataUserId,
  mergeClaudeCodeBetas,
} from '../../../src/host/providers/_claude-shared/claude-code-first-party.ts'

const context = {
  sessionUuid: '00000000-0000-4000-8000-000000000001',
  promptUuid: '00000000-0000-4000-8000-000000000002',
  requestUuid: '00000000-0000-4000-8000-000000000003',
  promptIndex: 0,
  turnIndex: 1,
}

describe('Claude Code first-party protocol', () => {
  it('emits the five captured headers', () => {
    expect(claudeCodeFirstPartyHeaders(context)).toEqual({
      'x-claude-1p-request-class': 'main',
      'x-claude-code-prompt-id': context.promptUuid,
      'x-claude-code-request-class': 'main',
      'x-claude-code-sandy-plover': '[]',
      'x-client-request-id': context.requestUuid,
    })
  })

  it('builds a billing block with the cch placeholder and stable retry context', () => {
    const text = claudeCodeBillingBlock('2.1.330', 'cli', 'Reply with exactly: OK', context)
    expect(text).toBe('x-anthropic-billing-header: cc_version=2.1.330.9e1; cc_entrypoint=cli; cch=00000; cc_prompt_id=' + context.promptUuid + '; cc_turn_origin=sdk; cc_prompt_index=0; cc_turn_index=1;')
  })

  it('matches the captured API-key and OAuth Opus beta order', () => {
    expect(claudeCodeFirstPartyBetas({ auth: 'api-key', model: 'claude-opus-5-5' })).toEqual([
      'claude-code-20250219', 'interleaved-thinking-2025-05-14', 'context-management-2025-06-27',
      'prompt-caching-scope-2026-01-05', 'per-turn-control-2026-07-01', 'mid-conversation-tool-changes-2026-07-01',
      'thinking-token-count-2026-05-13', 'advanced-tool-use-2025-11-20', 'mid-conversation-system-clear-at-2026-08-21',
      'effort-2025-11-24', 'thinking-binding-controls-2026-08-01', 'cache-diagnosis-2026-04-07',
    ])
    const oauth = claudeCodeFirstPartyBetas({ auth: 'oauth', model: 'claude-opus-5-5', cacheTtl: '1h' })
    expect(oauth).toHaveLength(15)
    expect(oauth.slice(0, 2)).toEqual(['claude-code-20250219', 'oauth-2025-04-20'])
    expect(oauth).toContain('tool-provenance-2026-10-26')
    expect(mergeClaudeCodeBetas(oauth, ['effort-2025-11-24', 'compact-2026-09-04'])).toEqual([...oauth, 'compact-2026-09-04'])
  })

  it('matches the captured OAuth Haiku order and can forget thinking-token-count', () => {
    const betas = claudeCodeFirstPartyBetas({ auth: 'oauth', model: 'claude-haiku-5-5', cacheTtl: '1h', thinkingTokenCount: false })
    expect(betas[0]).toBe('oauth-2025-04-20')
    expect(betas.indexOf('claude-code-20250219')).toBeGreaterThan(3)
    expect(betas).not.toContain('thinking-token-count-2026-05-13')
    expect(betas).not.toContain('mid-conversation-system-clear-at-2026-08-21')
  })

  it('builds billing, identity, global static and dynamic blocks without fake content', () => {
    const blocks = buildClaudeCodeSystemBlocks({
      version: '2.1.330', entrypoint: 'cli', firstUserText: 'Reply with exactly: OK', context,
      identityText: 'identity', staticText: 'static', dynamicText: 'dynamic', cacheTtl: '1h',
    })
    expect(blocks).toHaveLength(4)
    expect(blocks[0]?.cache_control).toBeUndefined()
    expect(blocks[1]?.cache_control).toBeUndefined()
    expect(blocks[2]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h', scope: 'global' })
    expect(blocks[3]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(claudeCodeMetadataUserId('device', 'account', context.sessionUuid)).toBe('{"device_id":"device","account_uuid":"account","session_id":"' + context.sessionUuid + '"}')
  })

  it('increments prompt indexes per adapter call and bounds session state', () => {
    const tracker = new ClaudeCodeFirstPartyTracker(2)
    const first = tracker.begin('session-a', 'a')
    const retry = first
    expect(retry).toBe(first)
    expect(tracker.begin('session-a', 'a').promptIndex).toBe(1)
    tracker.begin('session-b', 'b')
    tracker.begin('session-c', 'c')
    expect(tracker.begin('session-a', 'a').promptIndex).toBe(0)
    expect(first.promptUuid).not.toBe(tracker.begin('session-a', 'a').promptUuid)
  })
})
