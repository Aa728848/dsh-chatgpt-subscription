/**
 * Public host/client contract for the Qwen Token Plan line.
 *
 * No API key, encrypted thinking payload, or request body crosses this boundary.
 * Upstream facts are sourced from the official Qianwen documentation recorded in
 * docs/qianwen-token-plan-line-plan.md.
 */

export const QIANWEN_TOKEN_PLAN_PROVIDER_ID = 'qianwen-token-plan'
export const QIANWEN_TOKEN_PLAN_PROVIDER_NAME = 'Qwen Token Plan（千问）'
export const QIANWEN_TOKEN_PLAN_ROUTE_PREFIX = '/qianwen-token-plan/api'

export type QianwenReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const QIANWEN_REASONING_EFFORTS: readonly QianwenReasoningEffort[] = [
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
]
export function isQianwenReasoningEffort(value: unknown): value is QianwenReasoningEffort {
  return typeof value === 'string' && (QIANWEN_REASONING_EFFORTS as readonly string[]).includes(value)
}

export type QianwenCacheTtl = '5m' | '1h'
export const QIANWEN_CACHE_TTLS: readonly QianwenCacheTtl[] = ['5m', '1h']
export function isQianwenCacheTtl(value: unknown): value is QianwenCacheTtl {
  return value === '5m' || value === '1h'
}

export type QianwenImageDetail = 'low' | 'auto' | 'high'
export const QIANWEN_IMAGE_DETAILS: readonly QianwenImageDetail[] = ['low', 'auto', 'high']
export function isQianwenImageDetail(value: unknown): value is QianwenImageDetail {
  return value === 'low' || value === 'auto' || value === 'high'
}

export interface QianwenModelOption {
  id: string
  name: string
  availability: 'personal-and-team' | 'team-only'
  automaticRouting: boolean
  hint: string
  enabled: boolean
  defaultContextWindow: number
  contextWindow: number
  defaultMaxTokens: number
  maxOutputTokens: number
  reasoningEfforts: readonly QianwenReasoningEffort[]
  thinkingDisableable: boolean
  supportsImages: boolean
  supportsVideo: boolean
  supportsExplicitCache: boolean
  supportsCoTSummary: boolean
  description: string | null
}

export interface QianwenSettingsUpdateDto {
  enabled?: boolean
  /** A stored empty array is an explicit all-off selection. */
  enabledModelIds?: string[]
  /** Null removes one override and restores the catalog default. */
  contextWindowOverrides?: Record<string, number | null>
  /** Null omits the wire field and uses the upstream default. */
  defaultReasoningEffort?: QianwenReasoningEffort | null
  cacheEnabled?: boolean
  cacheTtl?: QianwenCacheTtl
  thinkingSummary?: boolean
  imageDetail?: QianwenImageDetail
  maxPixels?: number | null
}

export interface QianwenCacheStatsDto {
  requests: number
  missedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
  outputTokens: number
  reasoningTokens: number
  encryptedReplays: number
  missingEncryptedContent: number
}

export interface QianwenStatusDto {
  providerId: typeof QIANWEN_TOKEN_PLAN_PROVIDER_ID
  enabled: boolean
  authenticated: boolean
  hasCredentials: boolean
  storagePath: string
  models: QianwenModelOption[]
  contextWindowOverrides: Record<string, number>
  defaultReasoningEffort: QianwenReasoningEffort | null
  cacheEnabled: boolean
  cacheTtl: QianwenCacheTtl
  thinkingSummary: boolean
  imageDetail: QianwenImageDetail
  maxPixels: number | null
  cacheStats?: QianwenCacheStatsDto
  cacheHint?: { idleMs: number; totalTokens: number }
  serving: boolean
  conflict: string | null
}

export interface QianwenConnectionDto {
  connected: boolean
  latencyMs: number
  model: string | null
  checkedAt: number
  error?: string
}
