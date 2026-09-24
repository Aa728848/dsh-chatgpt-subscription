export interface AntigravityModelBucket {
  bucketId: string
  displayName: string
  window?: string
  resetTime?: string
  description?: string
  remainingFraction: number
}

export interface AntigravityQuotaGroup {
  displayName: string
  description?: string
  buckets: AntigravityModelBucket[]
}

export interface AntigravityModelOption {
  id: string
  name: string
  enabled: boolean
  defaultContextWindow: number
  contextWindow?: number
  description?: string
  quotaSummary?: string
  remainingFraction?: number
  reasoningEfforts?: string[]
}

export interface AntigravityAccountQuota {
  projectId?: string
  endpoint?: string
  planLabel?: string
  productTier?: { id?: string; name?: string; description?: string }
  paidTier?: { id?: string; name?: string; description?: string }
  groups: AntigravityQuotaGroup[]
  groupDescription?: string
  models: Array<{ modelId: string; displayName?: string; description?: string }>
  catalogModels: Array<{ id: string; name?: string; description?: string }>
  defaultAgentModelId?: string
  fetchedAt: number
}

import type { AccountRotationStrategy, PoolAccountSummaryDto } from './account-pool-contracts.ts'

export type { AccountRotationStrategy }

/** One pooled Antigravity account as the settings card renders it. */
export interface AntigravityAccountSummaryDto extends PoolAccountSummaryDto {
  projectId?: string
  planLabel?: string
}

export interface AntigravityWebStatus {
  enabled?: boolean
  authenticated: boolean
  email?: string
  projectId?: string
  planLabel?: string
  hasCredentials: boolean
  storagePath: string
  lastFetchedAt?: number
  /**
   * Whether a quota refresh is running behind this answer.
   *
   * The card renders the snapshot it already had instead of waiting on the
   * upstream request; when this is true the client asks again shortly so the
   * refreshed snapshot reaches the UI.
   */
  quotaRefreshing?: boolean
  quota?: AntigravityAccountQuota
  models: AntigravityModelOption[]
  contextWindowOverrides: Record<string, number>
  defaultReasoningEffort?: 'low' | 'medium' | 'high' | null
  accounts?: AntigravityAccountSummaryDto[]
  activeAccountId?: string
  rotationStrategy?: AccountRotationStrategy
}

export interface AntigravitySettingsUpdateDto {
  enabled?: boolean
  enabledModelIds?: string[]
  /** A number sets an override for that model; `null` restores the catalog default. */
  contextWindowOverrides?: Record<string, number | null>
  defaultReasoningEffort?: 'low' | 'medium' | 'high' | null
}
