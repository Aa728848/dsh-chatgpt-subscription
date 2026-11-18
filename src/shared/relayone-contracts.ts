/** Public host/client contract for RelayOne. No API key crosses this boundary. */
export const RELAYONE_PROVIDER_ID = 'relayone'
export const RELAYONE_PROVIDER_NAME = 'RelayOne'
export const RELAYONE_ROUTE_PREFIX = '/relayone/api'

export type RelayOneProtocol = 'openai-responses' | 'openai-chat' | 'anthropic'
export type RelayOneModelKind = 'chat' | 'image' | 'video'
export type RelayOneReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const RELAYONE_REASONING_EFFORTS: readonly RelayOneReasoningEffort[] = [
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
]
export function isRelayOneReasoningEffort(value: unknown): value is RelayOneReasoningEffort {
  return typeof value === 'string' && (RELAYONE_REASONING_EFFORTS as readonly string[]).includes(value)
}

export interface RelayOneModelDto {
  id: string
  name: string
  kind: RelayOneModelKind
  hint: string
  enabled: boolean
  groups: readonly string[]
  endpoints: readonly string[]
  protocol: RelayOneProtocol | null
  vendor: string | null
  description: string | null
  contextWindow: number
  defaultContextWindow: number
  maxOutputTokens: number
  reasoningEfforts: readonly RelayOneReasoningEffort[]
  supportsImages: boolean
}

export interface RelayOneCatalogDto {
  state: 'idle' | 'ready' | 'stale' | 'error'
  fetchedAt: number | null
  error: string | null
  groups: readonly string[]
}

export type RelayOneQuotaState = 'idle' | 'ready' | 'unlimited' | 'stale' | 'error'
export interface RelayOneQuotaDto {
  state: RelayOneQuotaState
  totalGranted: number | null
  totalUsed: number | null
  totalAvailable: number | null
  remainingPercent: number | null
  quotaPerUnit: number | null
  expiresAt: number | null
  fetchedAt: number | null
  error: string | null
}

export interface RelayOneStatusDto {
  providerId: typeof RELAYONE_PROVIDER_ID
  enabled: boolean
  authenticated: boolean
  storagePath: string
  models: readonly RelayOneModelDto[]
  mediaModels: readonly RelayOneModelDto[]
  contextWindowOverrides: Readonly<Record<string, number>>
  defaultReasoningEffort: RelayOneReasoningEffort | null
  imageModel: string | null
  videoModel: string | null
  catalog: RelayOneCatalogDto
  quota: RelayOneQuotaDto
  serving: boolean
  conflict: string | null
}

export interface RelayOneSettingsUpdateDto {
  enabled?: boolean
  /** An empty array is an explicit all-off selection; null is not accepted by a patch. */
  enabledModelIds?: string[]
  contextWindowOverrides?: Record<string, number | null>
  defaultReasoningEffort?: RelayOneReasoningEffort | null
  imageModel?: string | null
  videoModel?: string | null
}

export interface RelayOneConnectionDto {
  connected: boolean
  latencyMs: number
  checkedAt: number
  modelCount: number
  groups: readonly string[]
  error?: string
}

export const RELAYONE_IMAGE_TOOL_NAME = 'relayone_generate_image'
export const RELAYONE_VIDEO_TOOL_NAME = 'relayone_generate_video'
