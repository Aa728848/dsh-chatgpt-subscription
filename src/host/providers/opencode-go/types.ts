import { createHash, randomUUID } from 'node:crypto'
import { OPENCODE_GO_PROVIDER_ID, OPENCODE_GO_PROVIDER_NAME } from '../../../shared/opencode-go-contracts.ts'

export const PROVIDER_ID = OPENCODE_GO_PROVIDER_ID
export const PROVIDER_NAME = OPENCODE_GO_PROVIDER_NAME

export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/inference/go'
export const OPENCODE_GO_CHAT_URL = OPENCODE_GO_BASE_URL + '/openai/v1/chat/completions'
export const OPENCODE_GO_MODELS_URL = OPENCODE_GO_BASE_URL + '/v1/models'
export const OPENCODE_GO_USAGE_URL = OPENCODE_GO_BASE_URL + '/v1/usage'
export const OPENCODE_GO_USER_AGENT = 'dsh-opencode-go/1.0.0'
export const OPENCODE_GO_COOLDOWN_MS = 60_000
export const OPENCODE_GO_MAX_REQUEST_IMAGE_BYTES = 12 * 1024 * 1024

export interface OpenCodeGoCredentials {
  apiKey: string
  authenticatedAt: number
}

export function opencodeGoHeaders(credentials: OpenCodeGoCredentials, sessionId?: string): Record<string, string> {
  return {
    authorization: 'Bearer ' + credentials.apiKey,
    'content-type': 'application/json',
    'user-agent': OPENCODE_GO_USER_AGENT,
    ...(sessionId === undefined ? {} : { 'x-opencode-session': sessionId }),
  }
}

/** Stable per DSH conversation and account; a missing host id falls back to one random request id. */
export function opencodeGoSessionId(sessionId: string | undefined, accountId: string): string {
  const source = sessionId === undefined || sessionId.trim() === '' ? randomUUID() : sessionId
  const digest = createHash('sha256').update(accountId).update('\0').update(source).digest('hex').slice(0, 32)
  return 'ses_dsh_' + digest
}
