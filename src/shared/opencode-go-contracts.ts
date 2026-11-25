import type { AccountRotationStrategy, PoolAccountQuotaDto, PoolAccountSummaryDto } from './account-pool-contracts.ts'

/** Public settings contracts for the OpenCode Go subscription line. No secrets cross this module. */
export const OPENCODE_GO_PROVIDER_ID = 'opencode-go'
export const OPENCODE_GO_PROVIDER_NAME = 'OpenCode Go（订阅）'
export const OPENCODE_GO_ROUTE_PREFIX = '/opencode-go/api'
export const OPENCODE_GO_CONSOLE_URL = 'https://opencode.ai/console'

export const OPENCODE_GO_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type OpenCodeGoReasoningEffort = typeof OPENCODE_GO_REASONING_EFFORTS[number]
export function isOpenCodeGoReasoningEffort(value: unknown): value is OpenCodeGoReasoningEffort {
  return typeof value === 'string' && (OPENCODE_GO_REASONING_EFFORTS as readonly string[]).includes(value)
}

export type OpenCodeGoQuotaWindowKey = 'rolling' | 'weekly' | 'monthly'
export interface OpenCodeGoQuotaWindowDto {
  key: OpenCodeGoQuotaWindowKey
  usedPercent: number
  resetsAt: number | null
}

export interface OpenCodeGoQuotaSnapshotDto {
  windows: OpenCodeGoQuotaWindowDto[]
  planName: string | null
  fetchedAt: number
}

export interface OpenCodeGoModelOption {
  id: string
  name: string
  hint: string
  enabled: boolean
  defaultContextWindow: number
  contextWindow: number
  defaultMaxTokens: number
  reasoningEfforts: readonly OpenCodeGoReasoningEffort[]
  supportsTools: boolean
  supportsImages: boolean
  description: string | null
  canonicalId: string | null
  training: boolean | null
  zdr: boolean | null
  limitedRegions: boolean | null
}

export interface OpenCodeGoAccountSummaryDto extends PoolAccountSummaryDto {
  authKind: 'api-key'
  planName?: string
  region?: string
}

export interface OpenCodeGoConnectionDto {
  connected: boolean
  latencyMs: number
  model: string | null
  checkedAt: number
  error?: string
}

export interface OpenCodeGoWebStatus {
  enabled: boolean
  providerId: string
  serving: boolean
  conflict: string | null
  authenticated: boolean
  accounts: OpenCodeGoAccountSummaryDto[]
  activeAccountId?: string
  rotationStrategy: AccountRotationStrategy
  selectedAccountId: string | null
  models: OpenCodeGoModelOption[]
  contextWindowOverrides: Record<string, number>
  defaultReasoningEffort: OpenCodeGoReasoningEffort | null
  catalogSynced: boolean
  catalogCount: number
  quotaError: string | null
  connection: OpenCodeGoConnectionDto | null
}

export interface OpenCodeGoSettingsUpdateDto {
  enabled?: boolean
  enabledModelIds?: string[]
  contextWindowOverrides?: Record<string, number | null>
  defaultReasoningEffort?: OpenCodeGoReasoningEffort | null
  selectedAccountId?: string | null
}

export type { AccountRotationStrategy, PoolAccountQuotaDto }
