import { createHash, randomUUID } from 'node:crypto'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { CODEX_OPENAI_BETA, CODEX_ORIGINATOR, CODEX_UPSTREAM_VERSION, PLUGIN_VERSION } from '../compat.ts'
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
/**
 * Routing hint the Codex backend reads on a responses request.
 *
 * The official client tells the backend which model (and which service tier)
 * the request is for, so the backend can route it without inferring either from
 * the body. It is a responses-only header: the other endpoints of this line
 * carry their own routing and must not present it.
 */
export const CODEX_ROUTING_HINT_HEADER = 'x-codex-routing-hint'
/**
 * Header that puts a responses request on the Responses Lite surface.
 *
 * Lite is a different request shape, not a different endpoint: the tools
 * travel inside the input as an `additional_tools` item instead of a top-level
 * `tools` array, and the backend has to be told which shape it is reading.
 * A request that uses the Lite body without this header is read as a standard
 * one, and a request that sends the header without the Lite body is read as
 * Lite - so the two always travel together.
 */
export const CODEX_RESPONSES_LITE_HEADER = 'x-openai-internal-codex-responses-lite'

/**
 * The routing hint value for one request.
 *
 * The tier is part of the hint only when the request carries one, so the two
 * forms match what the official client sends.
 *
 * @param model - the model the request is for.
 * @param serviceTier - the tier the request asks for, when it asks for one.
 * @returns the header value.
 */
export function codexRoutingHint(model: string, serviceTier?: string): string {
  return serviceTier === undefined || serviceTier === ''
    ? `model=${model}`
    : `model=${model};tier=${serviceTier}`
}

export interface CodexHeaderOptions {
  /** Opaque state from an earlier request in the SAME human turn, if available. */
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
    // Match the official client's identity and upstream version first; retain
    // the plugin version as a suffix so this build remains identifiable.
    'user-agent': `codex_cli_rs/${CODEX_UPSTREAM_VERSION} (${dshAgent}) dsh-chatgpt-subscription/${PLUGIN_VERSION}`,
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
