import { createHash, randomUUID } from 'node:crypto'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { CODEX_ORIGINATOR, PLUGIN_VERSION } from '../compat.ts'
import type { StoredOAuthCredentials } from './token-store.ts'

export function codexHeaders(credentials: StoredOAuthCredentials, sessionId?: string): Record<string, string> {
  const dshAgent = attributionHeaders()['user-agent'] ?? 'dsh/unknown'
  return {
    authorization: `Bearer ${credentials.accessToken}`,
    ...(credentials.accountId ? { 'chatgpt-account-id': credentials.accountId } : {}),
    originator: CODEX_ORIGINATOR,
    'user-agent': `dsh-chatgpt-subscription/${PLUGIN_VERSION} (${dshAgent})`,
    ...(sessionId ? { 'session-id': sessionId } : {}),
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
