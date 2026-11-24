import {
  CLAUDE_CODE_FINGERPRINT_SALT,
  CLAUDE_CODE_STAINLESS_HEADERS,
  claudeCodeBillingBlock,
  claudeCodeFingerprint,
  claudeCodeFirstPartyBetas,
  claudeCodeMetadataUserId,
  claudeCodeSessionUuid,
  type ClaudeCodeFirstPartyContext,
} from '../_claude-shared/claude-code-first-party.ts'
import {
  CLAUDE_API_PROVIDER_ID,
  CLAUDE_API_PROVIDER_NAME,
} from '../../../shared/claude-api-contracts.ts'

export const PROVIDER_ID = CLAUDE_API_PROVIDER_ID
export const PROVIDER_NAME = CLAUDE_API_PROVIDER_NAME

/**
 * Wire constants of the official Claude Code client as an API-key user sends them.
 *
 * SOURCE for every value in this file unless stated otherwise: a local capture of
 * @anthropic-ai/claude-code@2.1.330 pointed at a loopback port with an API key
 * (structural copy in test/fixtures/claude-api/request-2.1.330.json), cross-checked
 * against the 2026-03-31 source snapshot (services/api/client.ts, constants/system.ts,
 * utils/fingerprint.ts, services/api/claude.ts getAPIMetadata). See docs/claude-api-line-plan.md.
 */
export const CLAUDE_API_MESSAGES_PATH = '/v1/messages?beta=true'
export const CLAUDE_API_COUNT_TOKENS_PATH = '/v1/messages/count_tokens?beta=true'
export const CLAUDE_API_MODELS_PATH = '/v1/models'
export const CLAUDE_API_ANTHROPIC_VERSION = '2023-06-01'

/** Shipped fallback. npm updates are adopted only when a verified cch seed exists (client-version.ts). */
export const CLAUDE_API_DEFAULT_CLI_VERSION = '2.1.330'
/** Operator pin, mirroring DSH_CLAUDE_CLI_VERSION of the subscription line. */
export const CLAUDE_API_CLI_VERSION_ENV = 'DSH_CLAUDE_API_CLI_VERSION'
/** npm registry document whose version field is the latest published client. */
export const CLAUDE_API_NPM_LATEST_URL = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest'
export const CLAUDE_API_CLIENT_VERSION_REFRESH_MS = 24 * 60 * 60_000
export const CLAUDE_API_CLIENT_VERSION_TIMEOUT_MS = 10_000

/** Interactive entrypoint. UNVERIFIED BY CAPTURE: the capture ran print mode (sdk-cli); cli comes from the source snapshot and was accepted live. */
export const CLAUDE_API_ENTRYPOINT = 'cli'
/** Identity line of the interactive client (constants/system.ts DEFAULT_PREFIX). */
export const CLAUDE_API_IDENTITY_TEXT = "You are Claude Code, Anthropic's official CLI for Claude."
export const CLAUDE_API_BILLING_HEADER_PREFIX = 'x-anthropic-billing-header'
/** utils/fingerprint.ts FINGERPRINT_SALT; re-verified against the 2.1.330 capture (9e1). */
export const CLAUDE_API_FINGERPRINT_SALT = CLAUDE_CODE_FINGERPRINT_SALT

/** Stainless SDK headers exactly as captured. They do NOT follow the npm version; see the plan's limitations. */
export const CLAUDE_API_STAINLESS_HEADERS = CLAUDE_CODE_STAINLESS_HEADERS

/** First-party API-key betas in capture order; model-specific order comes from the shared helper. */
export const CLAUDE_API_BASE_BETAS: readonly string[] = Object.freeze(claudeCodeFirstPartyBetas({ auth: 'api-key' }))
/** Licenses thinking.block_binding. Without it the gateway strips the field and upstream rejects it. */
export const CLAUDE_API_BETA_THINKING_BINDING = 'thinking-binding-controls-2026-08-01'
/** Licenses the compaction parameter and every later request that carries a signed compaction block. */
export const CLAUDE_API_BETA_COMPACT = 'compact-2026-09-04'
/** Licenses a tool defined by value inside tool_addition, and tool_changes on a compaction block. */
export const CLAUDE_API_BETA_INLINE_TOOLS = 'inline-tools-2026-09-15'
/** Licenses clear_at on a role:system message. */
export const CLAUDE_API_BETA_CLEAR_AT = 'mid-conversation-system-clear-at-2026-08-21'
/** Required for speed on models whose fast mode is still beta. */
export const CLAUDE_API_BETA_FAST_MODE = 'fast-mode-2026-02-01'

export const CLAUDE_API_CATALOG_TTL_MS = 5 * 60_000
export const CLAUDE_API_MAX_REQUEST_IMAGE_BYTES = 32 * 1024 * 1024

/** Message source kinds rendered as turn-scoped system messages (clear_at). A user decision; see the plan. */
export const CLAUDE_API_TURN_SCOPED_SOURCE_KINDS: readonly string[] = Object.freeze(['progress-updates-nudge', 'kimi-repeat-breaker'])

/** Remove a credential echoed by an upstream error before truncating its public detail. */
export function claudeApiSafeDetail(value: unknown, apiKey?: string, limit = 1000): string {
  const text = value instanceof Error ? value.message : String(value)
  return (apiKey !== undefined && apiKey !== '' ? text.replaceAll(apiKey, '[REDACTED]') : text).slice(0, limit)
}

/** Join a normalized base URL with one of the path constants above. */
export function claudeApiUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, '') + path
}

/** User-Agent of the interactive client for one version. */
export function claudeApiUserAgent(version: string): string {
  return 'claude-cli/' + version + ' (external, ' + CLAUDE_API_ENTRYPOINT + ')'
}

/**
 * Three-hex attribution fingerprint: SHA256(salt + text[4] + text[7] + text[20] + version)[:3],
 * with '0' standing in for a missing character. The text is the user's OWN first prompt text,
 * not a reminder block placed in front of it (verified against the capture).
 */
export function claudeApiFingerprint(firstUserText: string, version: string): string {
  return claudeCodeFingerprint(firstUserText, version)
}

/** Text of the first system block. It carries no cache marker. */
export function claudeApiBillingBlock(
  version: string,
  firstUserText: string,
  context: ClaudeCodeFirstPartyContext,
): string {
  return claudeCodeBillingBlock(version, CLAUDE_API_ENTRYPOINT, firstUserText, context)
}

/** Deterministic UUID-shaped id for one DSH session, stable across retries and restarts. */
export function claudeApiSessionUuid(sessionId: string): string {
  return claudeCodeSessionUuid(sessionId, 'dsh-claude-api-session:')
}

/** metadata.user_id in the JSON form current clients send. account_uuid is empty for API-key users. */
export function claudeApiMetadataUserId(deviceId: string, sessionUuid: string): string {
  return claudeCodeMetadataUserId(deviceId, '', sessionUuid)
}
