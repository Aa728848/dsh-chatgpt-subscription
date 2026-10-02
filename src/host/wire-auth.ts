import { createHash, randomUUID } from 'node:crypto'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { CODEX_OPENAI_BETA, CODEX_ORIGINATOR, PLUGIN_VERSION } from '../compat.ts'
import type { StoredOAuthCredentials } from './token-store.ts'

/**
 * Turn-state header the Codex backend hands back on a responses response.
 *
 * The official CLI reads it and echoes it on the SAME TURN's next request — a
 * retry, an incremental append or a continuation — and the backend uses it to
 * resume instead of re-ingesting the whole history.
 *
 * Its scope is exactly one turn. The official client builds a fresh per-turn
 * session and documents that reusing one across turns violates the
 * client/server contract and can cause routing bugs; the token is also
 * account-scoped and is discarded when auth ownership changes. It is opaque,
 * short-lived, and threaded through rather than computed (see
 * `responses-client.ts`).
 */
export const CODEX_TURN_STATE_HEADER = 'x-codex-turn-state'

export interface CodexHeaderOptions {
  /** Opaque state from the previous turn of this conversation, if any. */
  turnState?: string
}

export function codexHeaders(
  credentials: StoredOAuthCredentials,
  sessionId?: string,
  options: CodexHeaderOptions = {},
): Record<string, string> {
  const dshAgent = attributionHeaders()['user-agent'] ?? 'dsh/unknown'
  return {
    authorization: `Bearer ${credentials.accessToken}`,
    ...(credentials.accountId ? { 'chatgpt-account-id': credentials.accountId } : {}),
    // The subscription backend is beta-gated. Requests without this header are
    // not the same surface, and the official CLI has always sent it.
    'openai-beta': CODEX_OPENAI_BETA,
    originator: CODEX_ORIGINATOR,
    'user-agent': `dsh-chatgpt-subscription/${PLUGIN_VERSION} (${dshAgent})`,
    ...(sessionId ? { 'session-id': sessionId } : {}),
    ...(options.turnState ? { [CODEX_TURN_STATE_HEADER]: options.turnState } : {}),
  }
}

/**
 * Opaque local identity of whoever signs a request.
 *
 * Turn state is account-scoped, so the client has to detect when the signer
 * changed without ever putting that fact on the wire. The digest is computed
 * and compared locally: it is not a header, not a credential, and never logged.
 */
export function authOwnerKey(credentials: StoredOAuthCredentials): string {
  return createHash('sha256')
    .update(credentials.accountId ?? '')
    .update('\0')
    .update(credentials.accessToken)
    .digest('hex')
    .slice(0, 32)
}

export function stableSessionId(value: string | undefined): string {
  const source = value === undefined || value === '' ? randomUUID() : value
  return `dsh-${createHash('sha256').update(source).digest('hex').slice(0, 32)}`
}

export function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after')
  if (raw === null) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10 * 60_000)
  const timestamp = Date.parse(raw)
  if (!Number.isFinite(timestamp)) return undefined
  return Math.min(Math.max(0, timestamp - Date.now()), 10 * 60_000)
}
