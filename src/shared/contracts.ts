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

/**
 * The configured account-pool storage choice (`poolStorage`).
 *
 * Two values and no automatic mode: which store holds the account pool is a
 * deployment fact, and inferring it from whatever the host happens to answer is
 * how a pool silently moves between stores. `keyring` is the default because it
 * is what every desktop install already had.
 */
export type PoolStorageMode = 'keyring' | 'credentials'

/**
 * The backend that actually holds the pool document on this host.
 *
 * `keyring` resolves to DPAPI on Windows and the Keychain on macOS, so the card
 * has to name the store a user got rather than the value they picked.
 */
export type PoolStorageBackend = 'keyring' | 'credentials' | 'dpapi' | 'keychain'

/** Which backend stores the account pool, and whether it encrypts the document at rest. */
export interface PoolStorageDto {
  /** The configured value this host was resolved with. */
  mode: PoolStorageMode
  /** The backend in use. */
  backend: PoolStorageBackend
  /** Whether the document is encrypted at rest by this backend. */
  encrypted: boolean
  /**
   * Why the configured backend cannot be used here. Absent means it works.
   *
   * A reason CODE rather than a sentence: the card translates it, and a host
   * sentence travelling through the wire would reach a Russian page in English.
   */
  unavailable?: PoolStorageUnavailableReason
}

/**
 * Why the pool cannot be read or written here.
 *
 * `keyring-unreachable` is a server without a desktop keyring (or with a locked
 * one) — the state this option exists for; `no-credentials-service` is a host
 * older than DSH's credential seam, which cannot honour an explicit
 * `credentials` choice; `store-unreadable` is a store that IS configured and
 * usable but did not answer this time (a keyring that refused, a process that
 * timed out). It exists because that failure used to render as "no accounts",
 * which reads as data loss over a document that is still intact.
 */
export type PoolStorageUnavailableReason = 'keyring-unreachable' | 'no-credentials-service' | 'store-unreadable'

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
   * Where the account pool document actually lives on this host.
   *
   * `storage` above describes the single-credential mirror; this describes the
   * pool, which `poolStorage` may have put in a different store. Absent when the
   * pool is not installed, or while the backend has not been resolved yet.
   */
  poolStorage?: PoolStorageDto
  /**
   * Whether a local Codex CLI sign-in exists to import.
   *
   * Presence only, answered by a stat: the settings card has to offer the import
   * BEFORE the user agrees to it, and a startup path that read the file "just in
   * case" would make that agreement decorative. Validity is answered by the adopt
   * route itself, after opt-in.
   */
  codexCliSignInAvailable?: boolean
  /**
   * The exact file that was consulted to answer `codexCliSignInAvailable`.
   *
   * Presence alone cannot answer "why was nothing found?", so the path travels
   * with the flag. It is a location, never a credential: `codex-adopt.ts`
   * resolves it from CODEX_HOME and the flag is a stat of that one file, so
   * printing it says where the plugin looked without opening anything.
   *
   * One path rather than a list, because this reader defines exactly one
   * candidate — a list here would imply a precedence this provider does not
   * have. A host that does not consult the file simply omits the field.
   */
  codexCliSignInPath?: string
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
