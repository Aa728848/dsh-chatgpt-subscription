import {
  RELAYONE_PROVIDER_ID,
  RELAYONE_PROVIDER_NAME,
} from '../../shared/relayone-contracts.ts'

export const PROVIDER_ID = RELAYONE_PROVIDER_ID
export const PROVIDER_NAME = RELAYONE_PROVIDER_NAME

/** Site documentation: https://z1rry.cyou/docs#/overview */
export const RELAYONE_ORIGIN = 'https://z1rry.cyou'
export const RELAYONE_BASE_URL = RELAYONE_ORIGIN + '/v1'
export const RELAYONE_MODELS_URL = RELAYONE_BASE_URL + '/models'
export const RELAYONE_PRICING_URL = RELAYONE_ORIGIN + '/api/pricing'
export const RELAYONE_CHAT_URL = RELAYONE_BASE_URL + '/chat/completions'
export const RELAYONE_RESPONSES_URL = RELAYONE_BASE_URL + '/responses'
export const RELAYONE_MESSAGES_URL = RELAYONE_BASE_URL + '/messages'
export const RELAYONE_IMAGES_URL = RELAYONE_BASE_URL + '/images/generations'
export const RELAYONE_IMAGE_EDITS_URL = RELAYONE_BASE_URL + '/images/edits'
export const RELAYONE_VIDEO_URL = RELAYONE_BASE_URL + '/video/generations'
export const RELAYONE_TASKS_URL = RELAYONE_BASE_URL + '/tasks'
export const RELAYONE_DOCS_URL = RELAYONE_ORIGIN + '/docs'
export const RELAYONE_USER_AGENT = 'dsh-chatgpt-subscription (+https://github.com/Aa728848/dsh-chatgpt-subscription)'
export const RELAYONE_CATALOG_TTL_MS = 5 * 60_000
export const RELAYONE_MAX_REQUEST_IMAGE_BYTES = 32 * 1024 * 1024

/** Remove a credential echoed by an upstream error before truncating its public detail. */
export function relayOneSafeDetail(value: unknown, apiKey?: string, limit = 1000): string {
  const text = value instanceof Error ? value.message : String(value)
  return (apiKey ? text.replaceAll(apiKey, '[REDACTED]') : text).slice(0, limit)
}

export function relayOneHeaders(apiKey: string, json = true): Record<string, string> {
  return {
    authorization: 'Bearer ' + apiKey,
    accept: 'application/json',
    ...(json ? { 'content-type': 'application/json' } : {}),
    'user-agent': RELAYONE_USER_AGENT,
  }
}
