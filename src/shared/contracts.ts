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

export interface FetchConfigurationDto {
  fetchProvider: 'auto' | 'plugin' | 'dsh'
  fetchMaxBodyChars: number
  fetchMaxResponseBytes: number
}

export interface PluginStatusDto {
  fetchConfiguration?: FetchConfigurationDto
  switcher?: {
    state: 'idle' | 'applying' | 'applied' | 'missing' | 'failed'
    configuredSearchProvider: string | null
    configuredFetchProvider: string | null
  } | null
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
  /**
   * Whether a local Codex CLI sign-in exists to import.
   *
   * Presence only, answered by a stat: the settings card has to offer the import
   * BEFORE the user agrees to it, and a startup path that read the file "just in
   * case" would make that agreement decorative. Validity is answered by the adopt
   * route itself, after opt-in.
   */
  codexCliSignInAvailable?: boolean
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

/**
 * A local sign-in this plugin knows how to adopt.
 *
 * Presence only, for every id: the scanner stats candidates and reads no token, so
 * a user who never opts in never has a credential's contents touched. Whether the
 * file holds something USABLE is not answered here and must not be inferred from
 * 'detected' — that is what the adopt route is for.
 */
export type LocalLoginSourceId = 'codex' | 'claude-code' | 'minimax-code'

export interface LocalLoginSourceDto {
  id: LocalLoginSourceId
  /** True when a usable local sign-in was found. Presence only; no token was read. */
  detected: boolean
  /** Candidate paths consulted, in priority order. */
  paths: string[]
  /** 'adopt' = this plugin can import it in one click; 'settings-only' = the provider already owns its own control. */
  importMode: 'adopt' | 'settings-only'
  /** Human-facing provider name. Keep it a plain name; the client owns all translated copy. */
  providerLabel: string
}

export interface LocalLoginScanDto {
  sources: LocalLoginSourceDto[]
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
