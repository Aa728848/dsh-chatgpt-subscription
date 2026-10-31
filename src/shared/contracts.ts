import type { AccountRotationStrategy, PoolAccountSummaryDto } from './account-pool-contracts.ts'
import type { CompactionRouteTarget } from './compaction-route.ts'

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
    /**
     * The device code of the sign-in in progress, when that is what is running.
     *
     * Carried on the status so a card reloaded mid-flow can still show the code
     * the user has to type: losing it would strand a sign-in that is still
     * waiting upstream. Absent for the browser flow and when nothing is running.
     */
    device?: DeviceLoginDto | null
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

/** One exact `provider/model` route a subagent may be pointed at. */
export interface SubagentModelRouteDto {
  provider: string
  model: string
}

/**
 * Authorized child routes per main agent model, keyed by the main model's
 * `provider/model`.
 *
 * The key is the MAIN agent's route, not the child's: a deployment that wants a
 * GPT main agent to delegate to one set of models and a DeepSeek main agent to
 * delegate to another stores one entry per main route. A session whose main
 * route matches no entry falls back to `subagentDefaultModels`.
 */
export type SubagentModelsByMainModelDto = Record<string, SubagentModelRouteDto[]>

/**
 * An override patch for {@link SubagentModelsByMainModelDto}: an array replaces
 * that key's routes, `null` (or an empty array) clears the key entirely.
 */
export type SubagentModelsByMainModelUpdateDto = Record<string, SubagentModelRouteDto[] | null>

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
  /**
   * Where an automatic compaction summary is computed. `null` keeps the
   * conversation's own model, which is what every deployment does until an
   * operator opts in: the summary then costs that line's quota.
   */
  compactionRoute?: CompactionRouteTarget | null
  /** Routes used when the Session's main model matches no `subagentModelsByMainModel` entry. */
  subagentDefaultModels?: SubagentModelRouteDto[]
  /** Authorized child routes per main agent model, keyed by `provider/model`. */
  subagentModelsByMainModel?: SubagentModelsByMainModelDto
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
  /** Set a target, or `null` to route compaction back to the conversation's model. */
  compactionRoute?: CompactionRouteTarget | null
  /** Replace the fallback route list wholesale. */
  subagentDefaultModels?: SubagentModelRouteDto[]
  /** Merge per-main-model routes; `null` (or `[]`) clears one key. */
  subagentModelsByMainModel?: SubagentModelsByMainModelUpdateDto
}

/** One model a compaction target may be pointed at. */
export interface CompactionCandidateModelDto {
  id: string
  name: string
  /** Declared input types; empty when the route discloses none. */
  modalities: string[]
}

/** One provider route, with the models it currently offers. */
export interface CompactionCandidateProviderDto {
  id: string
  name: string
  models: CompactionCandidateModelDto[]
}

/** Every route a compaction target may be chosen from. */
export interface CompactionCandidatesDto {
  providers: CompactionCandidateProviderDto[]
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

/**
 * A device-code sign-in the user is completing on another machine.
 *
 * The card needs the code, the page to type it on and a countdown, nothing else:
 * the grant's own identifiers (`device_auth_id`) and the PKCE verifier stay on
 * the host, because they are the parts that can redeem the sign-in.
 */
export interface DeviceLoginDto {
  userCode: string
  verificationUrl: string
  /** Grant deadline, Unix **seconds** (the unit the status DTO uses). */
  expiresAt: number
  /**
   * The host's clock when this answer was built, Unix **seconds**.
   *
   * The countdown is `expiresAt - now`, measured with the browser's own elapsed
   * time. Comparing `expiresAt` against the browser's wall clock instead would
   * render a wrong countdown whenever the two clocks disagree — the normal case
   * for this feature, whose whole reason to exist is a remote host.
   */
  now: number
}

/** What starting a device-code sign-in answers: the flow id plus the panel's data. */
export interface DeviceLoginStartDto extends DeviceLoginDto {
  loginId: string
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
