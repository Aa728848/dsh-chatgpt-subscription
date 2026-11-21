/** Public host/client contract for the Claude API line. No API key and no device id cross this boundary. */
export const CLAUDE_API_PROVIDER_ID = 'claude-api'
export const CLAUDE_API_PROVIDER_NAME = 'Claude API'
export const CLAUDE_API_ROUTE_PREFIX = '/claude-api/api'
/** Official endpoint; the user may point the line at a compatible gateway instead. */
export const CLAUDE_API_DEFAULT_BASE_URL = 'https://api.anthropic.com'

export type ClaudeApiReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const CLAUDE_API_REASONING_EFFORTS: readonly ClaudeApiReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max']
export function isClaudeApiReasoningEffort(value: unknown): value is ClaudeApiReasoningEffort {
  return typeof value === 'string' && (CLAUDE_API_REASONING_EFFORTS as readonly string[]).includes(value)
}

/** Prompt-cache tier. '5m' sends a marker without a ttl field, which is what the official client does. */
export type ClaudeApiCacheTtl = '5m' | '1h'
export const CLAUDE_API_CACHE_TTLS: readonly ClaudeApiCacheTtl[] = ['5m', '1h']
export function isClaudeApiCacheTtl(value: unknown): value is ClaudeApiCacheTtl {
  return value === '5m' || value === '1h'
}

/**
 * Where the reported Claude Code version came from.
 * env: operator pin; npm: fetched by this process; cached: last fetched result on disk; default: shipped value.
 */
export type ClaudeApiClientVersionSource = 'env' | 'npm' | 'cached' | 'default'
export interface ClaudeApiClientVersionDto {
  value: string
  source: ClaudeApiClientVersionSource
  /** When the value was fetched from npm; null for env and default. */
  fetchedAt: number | null
  /** The newer version waiting for the line to go idle; null when none is pending. */
  pending: string | null
}

export interface ClaudeApiModelDto {
  id: string
  name: string
  hint: string
  enabled: boolean
  contextWindow: number
  defaultContextWindow: number
  maxOutputTokens: number
  reasoningEfforts: readonly ClaudeApiReasoningEffort[]
  supportsImages: boolean
  supportsFastMode: boolean
  supportsServerCompaction: boolean
}

export interface ClaudeApiCatalogDto {
  state: 'idle' | 'ready' | 'stale' | 'error'
  fetchedAt: number | null
  error: string | null
}

export interface ClaudeApiStatusDto {
  providerId: typeof CLAUDE_API_PROVIDER_ID
  enabled: boolean
  authenticated: boolean
  storagePath: string
  baseUrl: string
  defaultBaseUrl: string
  models: readonly ClaudeApiModelDto[]
  contextWindowOverrides: Readonly<Record<string, number>>
  defaultReasoningEffort: ClaudeApiReasoningEffort | null
  cacheTtl: ClaudeApiCacheTtl
  fastMode: boolean
  serverCompaction: boolean
  clientVersion: ClaudeApiClientVersionDto
  catalog: ClaudeApiCatalogDto
  serving: boolean
  conflict: string | null
}

export interface ClaudeApiSettingsUpdateDto {
  enabled?: boolean
  /** null restores the default endpoint. */
  baseUrl?: string | null
  /** An empty array is an explicit all-off selection; null is not accepted by a patch. */
  enabledModelIds?: string[]
  contextWindowOverrides?: Record<string, number | null>
  defaultReasoningEffort?: ClaudeApiReasoningEffort | null
  cacheTtl?: ClaudeApiCacheTtl
  fastMode?: boolean
  serverCompaction?: boolean
}

export interface ClaudeApiConnectionDto {
  connected: boolean
  latencyMs: number
  checkedAt: number
  modelCount: number
  error?: string
}

export type ClaudeApiBaseUrlError = 'empty' | 'invalid' | 'scheme' | 'credentials' | 'query'
export type ClaudeApiBaseUrlResult = { ok: true; value: string } | { ok: false; reason: ClaudeApiBaseUrlError }

/**
 * Normalize a user-entered endpoint to an origin plus optional path prefix.
 *
 * Both https and http are accepted (a user decision: plain-http LAN gateways are allowed).
 * A trailing slash and a trailing /v1 are dropped because every request path this line
 * sends already starts with /v1. Embedded credentials, a query string and a fragment are refused.
 */
export function normalizeClaudeApiBaseUrl(input: unknown): ClaudeApiBaseUrlResult {
  if (typeof input !== 'string' || input.trim() === '') return { ok: false, reason: 'empty' }
  let url: URL
  try { url = new URL(input.trim()) } catch { return { ok: false, reason: 'invalid' } }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'scheme' }
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' }
  if (url.search !== '' || url.hash !== '') return { ok: false, reason: 'query' }
  let pathname = url.pathname.replace(/\/+$/, '')
  if (/\/v1$/i.test(pathname)) pathname = pathname.slice(0, -3).replace(/\/+$/, '')
  return { ok: true, value: url.origin + pathname }
}
