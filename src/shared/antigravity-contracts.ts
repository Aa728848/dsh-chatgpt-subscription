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

export interface AntigravityWebStatus {
  authenticated: boolean
  email?: string
  projectId?: string
  planLabel?: string
  hasCredentials: boolean
  storagePath: string
  lastFetchedAt?: number
  quota?: AntigravityAccountQuota
  models: AntigravityModelOption[]
  contextWindowOverrides: Record<string, number>
  defaultReasoningEffort?: 'low' | 'medium' | 'high' | null
}

export interface AntigravitySettingsUpdateDto {
  enabledModelIds?: string[]
  contextWindowOverrides?: Record<string, number>
  defaultReasoningEffort?: 'low' | 'medium' | 'high' | null
}
