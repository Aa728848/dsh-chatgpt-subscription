import { createHash, randomUUID } from 'node:crypto'
import type { Message } from '../../common/llm-compat.ts'

/** First real user text used by cc_version's fingerprint; reminders and tool results do not count. */
export function claudeCodeFirstUserText(messages: readonly Message[]): string {
  for (const message of messages) {
    if (message.role !== 'user' || message.source?.kind === 'tool') continue
    if (message.content.some(block => block.type === 'tool-result')) continue
    for (const block of message.content) {
      if (block.type !== 'text' || typeof block.text !== 'string') continue
      const text = block.text.replace(/\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
      if (text.trimStart().startsWith('<system-reminder>')) continue
      if (text !== '') return text
    }
  }
  return ''
}

export const CLAUDE_CODE_BILLING_HEADER_PREFIX = 'x-anthropic-billing-header'
export const CLAUDE_CODE_FINGERPRINT_SALT = '59cf53e54c78'
export const CLAUDE_CODE_BETA_THINKING_TOKEN_COUNT = 'thinking-token-count-2026-05-13'
export const CLAUDE_CODE_BETA_CACHE_KEEPALIVE = 'cache-keepalive-2026-09-03'
export const CLAUDE_CODE_BETA_EXTENDED_CACHE_TTL = 'extended-cache-ttl-2025-04-11'
export const CLAUDE_CODE_BETA_CLEAR_AT = 'mid-conversation-system-clear-at-2026-08-21'
export const CLAUDE_CODE_BETA_FAST_MODE = 'fast-mode-2026-02-01'

/** Stainless headers captured from Claude Code 2.1.330; independent of the reported client version. */
export const CLAUDE_CODE_STAINLESS_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'x-stainless-arch': 'x64',
  'x-stainless-lang': 'js',
  'x-stainless-os': 'Windows',
  'x-stainless-package-version': '0.128.0',
  'x-stainless-retry-count': '0',
  'x-stainless-runtime': 'node',
  'x-stainless-runtime-version': 'v26.12.1',
  'x-stainless-timeout': '600',
})

const NON_HAIKU_BETAS = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'per-turn-control-2026-07-01',
  'mid-conversation-tool-changes-2026-07-01',
  'tool-provenance-2026-10-26',
  CLAUDE_CODE_BETA_THINKING_TOKEN_COUNT,
  'advanced-tool-use-2025-11-20',
  CLAUDE_CODE_BETA_CLEAR_AT,
  'effort-2025-11-24',
  'thinking-binding-controls-2026-08-01',
  CLAUDE_CODE_BETA_EXTENDED_CACHE_TTL,
  'cache-diagnosis-2026-04-07',
] as const

const HAIKU_BETAS = [
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'claude-code-20250219',
  'per-turn-control-2026-07-01',
  'mid-conversation-tool-changes-2026-07-01',
  'tool-provenance-2026-10-26',
  CLAUDE_CODE_BETA_THINKING_TOKEN_COUNT,
  'advanced-tool-use-2025-11-20',
  'effort-2025-11-24',
  'thinking-binding-controls-2026-08-01',
  CLAUDE_CODE_BETA_EXTENDED_CACHE_TTL,
  'cache-diagnosis-2026-04-07',
] as const

export interface ClaudeCodeBetaOptions {
  auth: 'api-key' | 'oauth'
  model?: string
  cacheTtl?: '5m' | '1h'
  thinkingTokenCount?: boolean
}

/**
 * Capture-backed first-party order. The Haiku order comes from the OAuth Haiku
 * capture; API-key Haiku uses the same order with the three OAuth-only values removed.
 */
export function claudeCodeFirstPartyBetas(options: ClaudeCodeBetaOptions): string[] {
  const haiku = options.model?.toLowerCase().includes('haiku') === true
  let betas: string[] = [...(haiku ? HAIKU_BETAS : NON_HAIKU_BETAS)]
  if (options.auth === 'api-key') {
    betas = betas.filter(beta => !['oauth-2025-04-20', 'tool-provenance-2026-10-26', CLAUDE_CODE_BETA_EXTENDED_CACHE_TTL].includes(beta))
  } else if (options.cacheTtl === '5m') {
    betas = betas.filter(beta => beta !== CLAUDE_CODE_BETA_EXTENDED_CACHE_TTL)
  }
  if (options.thinkingTokenCount === false) betas = betas.filter(beta => beta !== CLAUDE_CODE_BETA_THINKING_TOKEN_COUNT)
  return betas
}

/** Stable first-seen order, with no duplicate beta emitted by body-derived additions. */
export function mergeClaudeCodeBetas(...groups: readonly (readonly string[])[]): string[] {
  return [...new Set(groups.flatMap(group => group).filter(beta => beta !== ''))]
}

/** Deterministic UUID-shaped session id, namespaced per line. */
export function claudeCodeSessionUuid(sessionId: string, namespace = 'dsh-claude-session:'): string {
  const hex = createHash('sha256').update(namespace + sessionId).digest('hex')
  const variant = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16)
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-4' + hex.slice(13, 16) + '-' + variant + hex.slice(17, 20) + '-' + hex.slice(20, 32)
}

export interface ClaudeCodeFirstPartyContext {
  readonly sessionUuid: string
  readonly promptUuid: string
  readonly requestUuid: string
  readonly promptIndex: number
  readonly turnIndex: number
}

interface PromptState { promptIndex: number }

/** Bounded per-session prompt sequence. One adapter call is one prompt; retries reuse its context. */
export class ClaudeCodeFirstPartyTracker {
  private readonly sessions = new Map<string, PromptState>()
  constructor(private readonly cap = 256) {}

  begin(sessionUuid: string, sessionKey: string = sessionUuid): ClaudeCodeFirstPartyContext {
    const previous = this.sessions.get(sessionKey)
    const promptIndex = previous === undefined ? 0 : previous.promptIndex + 1
    this.sessions.delete(sessionKey)
    this.sessions.set(sessionKey, { promptIndex })
    while (this.sessions.size > this.cap) {
      const oldest = this.sessions.keys().next().value
      if (oldest === undefined) break
      this.sessions.delete(oldest)
    }
    return {
      sessionUuid,
      promptUuid: randomUUID(),
      requestUuid: randomUUID(),
      promptIndex,
      turnIndex: 1,
    }
  }
}

export function claudeCodeFirstPartyHeaders(context: ClaudeCodeFirstPartyContext): Record<string, string> {
  return {
    'x-claude-1p-request-class': 'main',
    'x-claude-code-prompt-id': context.promptUuid,
    'x-claude-code-request-class': 'main',
    'x-claude-code-sandy-plover': '[]',
    'x-client-request-id': context.requestUuid,
  }
}

/** Three-hex suffix of cc_version, including the user's own first text. */
export function claudeCodeFingerprint(firstUserText: string, version: string): string {
  const chars = [4, 7, 20].map(index => firstUserText[index] ?? '0').join('')
  return createHash('sha256').update(CLAUDE_CODE_FINGERPRINT_SALT + chars + version).digest('hex').slice(0, 3)
}

export function claudeCodeBillingBlock(
  version: string,
  entrypoint: string,
  firstUserText: string,
  context: ClaudeCodeFirstPartyContext,
): string {
  return CLAUDE_CODE_BILLING_HEADER_PREFIX + ': cc_version=' + version + '.' + claudeCodeFingerprint(firstUserText, version)
    + '; cc_entrypoint=' + entrypoint + '; cch=00000; cc_prompt_id=' + context.promptUuid
    + '; cc_turn_origin=sdk; cc_prompt_index=' + context.promptIndex + '; cc_turn_index=' + context.turnIndex + ';'
}

export function claudeCodeMetadataUserId(deviceId: string, accountUuid: string, sessionUuid: string): string {
  return JSON.stringify({ device_id: deviceId, account_uuid: accountUuid, session_id: sessionUuid })
}

export interface ClaudeCodeSystemBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral'; ttl?: '1h'; scope?: 'global' }
}

export interface ClaudeCodeSystemOptions {
  version: string
  entrypoint: string
  firstUserText: string
  context: ClaudeCodeFirstPartyContext
  identityText: string
  staticText?: string
  dynamicText?: string
  cacheTtl: '5m' | '1h'
}

/** First-party ordering without inventing prompt content the host does not have. */
export function buildClaudeCodeSystemBlocks(options: ClaudeCodeSystemOptions): ClaudeCodeSystemBlock[] {
  const marker = options.cacheTtl === '1h' ? { type: 'ephemeral' as const, ttl: '1h' as const } : { type: 'ephemeral' as const }
  const blocks: ClaudeCodeSystemBlock[] = [
    { type: 'text', text: claudeCodeBillingBlock(options.version, options.entrypoint, options.firstUserText, options.context) },
    { type: 'text', text: options.identityText },
  ]
  const staticText = options.staticText?.trim() ?? ''
  const dynamicText = options.dynamicText?.trim() ?? ''
  if (staticText !== '') blocks.push({ type: 'text', text: options.staticText as string, cache_control: { ...marker, scope: 'global' } })
  if (dynamicText !== '') blocks.push({ type: 'text', text: options.dynamicText as string, cache_control: { ...marker } })
  return blocks
}
