import type { AccountRotationStrategy, PoolAccountSummaryDto } from './account-pool-contracts.ts'

export interface SanitizedAccountDto {
  email: string | null
  planType: string | null
  accountIdSuffix: string | null
  tokenExpiresAt: number
}

export type CredentialStorageKind =
  | 'windows-dpapi'
  | 'macos-keychain'
  | 'linux-file'
  | 'memory'

export interface CredentialStorageDto {
  kind: CredentialStorageKind
  encrypted: boolean
  available: boolean
}

export interface PluginStatusDto {
  authenticated: boolean
  account: SanitizedAccountDto | null
  storage: CredentialStorageDto
  login: {
    active: boolean
    loginId: string | null
    expiresAt: number | null
  }
  quota: QuotaStatusDto
  /**
   * Whether a quota refresh is running behind this answer.
   *
   * The card renders the snapshot it already had instead of waiting on the
   * upstream request; when this is true the client asks again shortly so the
   * refreshed snapshot reaches the UI.
   */
  quotaRefreshing?: boolean
  preferences: SubscriptionPreferencesDto
  /** Signed-in accounts; empty or absent when no pool is installed. */
  accounts?: PoolAccountSummaryDto[]
  /** Account the next request would use. */
  activeAccountId?: string
  rotationStrategy?: AccountRotationStrategy
  detectedProxy?: string | null
  activeProxy?: string | null
  error?: PublicErrorDto
}

export type OAuthStatusDto = Omit<PluginStatusDto, 'quota' | 'preferences'>

export type SearchProviderPreference = 'dsh' | 'codex'
export type CodexOutputVerbosity = 'low' | 'medium' | 'high'
export type CodexReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none'

/** Persisted context window overrides, keyed by Codex model id. A model absent here uses its catalog default. */
export type CodexContextWindowOverridesDto = Record<string, number>

/** An override patch: a number sets one, `null` clears it back to the catalog default. */
export type CodexContextWindowOverridesUpdateDto = Record<string, number | null>

export type ProxyMode = 'auto' | 'custom' | 'direct'

export interface SubscriptionPreferencesDto {
  enabled?: boolean
  quickQuotaVisible: boolean
  fastMode: boolean
  outputVerbosity: CodexOutputVerbosity | null
  reasoningSummary: CodexReasoningSummary | null
  visibleModelIds: string[]
  searchProvider: SearchProviderPreference
  contextWindowOverrides: CodexContextWindowOverridesDto
  proxyMode: ProxyMode
  customProxyUrl: string | null
  writable: boolean
}

export interface SubscriptionPreferencesUpdateDto {
  enabled?: boolean
  quickQuotaVisible?: boolean
  fastMode?: boolean
  outputVerbosity?: CodexOutputVerbosity | null
  reasoningSummary?: CodexReasoningSummary | null
  visibleModelIds?: string[]
  searchProvider?: SearchProviderPreference
  contextWindowOverrides?: CodexContextWindowOverridesUpdateDto
  proxyMode?: ProxyMode
  customProxyUrl?: string | null
}

export interface QuotaWindowDto {
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}

export interface QuotaBucketDto {
  id: string
  name: string
  planType: string | null
  primary: QuotaWindowDto | null
  secondary: QuotaWindowDto | null
  windows: QuotaWindowDto[]
}

export interface QuotaCreditDto {
  hasCredits: boolean
  unlimited: boolean
  balance: string | null
}

export interface QuotaIndividualLimitDto {
  limit: string | null
  used: string | null
  remainingPercent: number | null
  resetsAt: number | null
}

export interface QuotaResetCreditsDto {
  availableCount: number
  /** Earliest expiration among currently available reset credits, as Unix seconds. */
  expiresAt: number | null
}

export interface QuotaUsageDto {
  buckets: QuotaBucketDto[]
  credits: QuotaCreditDto | null
  individualLimit: QuotaIndividualLimitDto | null
  spendControlReached: boolean | null
  resetCredits: QuotaResetCreditsDto | null
}

export interface QuotaStatusDto {
  state: 'signed-out' | 'empty' | 'ready' | 'stale' | 'error'
  buckets: QuotaBucketDto[]
  credits: QuotaCreditDto | null
  individualLimit: QuotaIndividualLimitDto | null
  spendControlReached: boolean | null
  resetCredits: QuotaResetCreditsDto | null
  fetchedAt: number | null
  stale: boolean
  error?: PublicErrorDto
}

export interface ConnectionTestDto {
  connected: true
  latencyMs: number
  checkedAt: number
}

export interface LoginStartDto {
  loginId: string
  authUrl: string
  expiresAt: number
}

export type LoginEventDto =
  | { type: 'pending'; loginId: string }
  | { type: 'completed'; loginId: string }
  | { type: 'cancelled'; loginId: string }
  | { type: 'failed'; loginId: string; error: PublicErrorDto }

/** One child that ran on a route the governing allowlist did not authorize. */
export interface SubagentRouteViolationDto {
  childId: string
  parentId: string | null
  provider: string | null
  label: string | null
  routeProvider: string | null
  routeModel: string | null
  /** Whether the child's route equals its parent's current route. */
  sameAsParent: boolean
}

/** Advisory audit of child routes for one parent session. */
export interface SubagentRouteAuditDto {
  sessionId: string
  /** Exact authorized routes the audit compared against. */
  allowedModels: { provider: string; model: string }[]
  violations: SubagentRouteViolationDto[]
}

export interface PublicErrorDto {
  code:
    | 'bad-request'
    | 'csrf-rejected'
    | 'login-active'
    | 'login-cancelled'
    | 'login-expired'
    | 'oauth-callback-invalid'
    | 'oauth-token-exchange-failed'
    | 'not-authenticated'
    | 'refresh-failed'
    | 'storage-failed'
    | 'connection-failed'
    | 'quota-failed'
    | 'preference-failed'
    | 'rate-limited'
    | 'route-audit-failed'
    | 'internal'
  message: string
}

export type ApiEnvelope<T> =
  | { ok: true; value: T }
  | { ok: false; error: PublicErrorDto }
