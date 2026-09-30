import { createHash, randomUUID } from 'node:crypto'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { CODEX_OPENAI_BETA, CODEX_ORIGINATOR, PLUGIN_VERSION } from '../compat.ts'
import type { StoredOAuthCredentials } from './token-store.ts'

/**
 * Turn-state header the Codex backend hands back on a responses response.
 *
 * The official CLI reads it and echoes it on the next request of the same
 * conversation; the backend uses it to resume instead of re-ingesting the
 * whole history. It is opaque, short-lived and account-scoped, so it is
 * threaded through rather than computed (see `responses-client.ts`).
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
