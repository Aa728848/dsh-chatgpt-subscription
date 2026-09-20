/**
 * Wire contracts between the WorkBuddy host routes and the browser settings
 * card. Everything here is public: no credential ever crosses this boundary.
 */

/**
 * Which deployment region an account belongs to.
 *
 * The two regions are separate backends serving overlapping-but-different model
 * catalogs, and a model asked of the wrong region answers 400 `code 11102`
 * ("service info not found") rather than failing over. The region is therefore
 * a property of the credential, not of the request.
 */
export type WorkBuddyRegion = 'cn' | 'intl'

/** Reasoning levels this route exposes. The upstream accepts the standard ladder. */
export type WorkBuddyReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Every level, in escalating order; the settings card renders exactly these. */
export const WORKBUDDY_REASONING_EFFORTS: readonly WorkBuddyReasoningEffort[] =
  ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** One model offered by the WorkBuddy subscription. */
export interface WorkBuddyModelOption {
  id: string
  name: string
  /** Enabled models are the ones DSH offers in the conversation model picker. */
  enabled: boolean
  /** Context window this route assumes when the caller saves no override. */
  defaultContextWindow: number
  /** Effective context window: the override when one is saved, else the default. */
  contextWindow: number
  /** Maximum output tokens this route requests when a caller omits one. */
  defaultMaxTokens: number
  /** Reasoning levels this route exposes; absent for non-reasoning models. */
  reasoningEfforts?: string[]
  /** Whether the model accepts image input on this route. */
  supportsImage: boolean
  /** Regions that serve this model; the account's own region must be listed. */
  regions: WorkBuddyRegion[]
  /** One-line description shown beside the model in the settings card. */
  description?: string
}

/** One credit allowance reported by the billing service. */
export interface WorkBuddyMeter {
  id: string
  label: string
  /** Used fraction in [0, 1] when the service reports a bounded allowance. */
  usedFraction: number | null
  /** Remaining fraction in [0, 1], when the service reports one. */
  remainingFraction: number | null
  used: string | null
  limit: string | null
  /** Unix milliseconds the meter resets, when reported. */
  resetsAt: number | null
  description: string | null
}

/** Account identity read from the local CodeBuddy credential file. */
export interface WorkBuddyAccount {
  /** Stable, non-secret selection key derived from region + account identity. */
  id: string
  uid: string | null
  nickname: string | null
  /** Tencent UIN, masked by the card rather than sent in full. */
  uin: string | null
  /** Account kind the client reports, e.g. `personal`. */
  accountType: string | null
  /** Enterprise/tenant id when the account is an enterprise one. */
  enterpriseId: string | null
  region: WorkBuddyRegion
  /** Backend base URL this account's region resolves to. */
  backend: string
  /** Auth domain recorded in the credential, e.g. `copilot.tencent.com`. */
  domain: string
  /** Unix milliseconds the access token expires. */
  expiresAt: number | null
  /** File the credential was read from; null for plugin-managed accounts. */
  sourceFile: string | null
  /** Desktop credentials are external; managed credentials belong to this plugin. */
  source: 'desktop' | 'managed'
  /** Managed credentials may be deleted; desktop credentials may only be hidden. */
  removable: boolean
  /** Hidden desktop accounts do not participate in automatic selection. */
  hidden: boolean
}

/** One point-in-time quota snapshot for the signed-in WorkBuddy account. */
export interface WorkBuddyAccountQuota {
  account: WorkBuddyAccount
  /** Package name the billing service reports, e.g. `Free Plan Subscription`. */
  packageName: string | null
  /** Total credits the package grants, as reported. */
  totalCredits: number | null
  /** Credits remaining in the current cycle. */
  remainingCredits: number | null
  /** Credits consumed in the current cycle. */
  cycleUsedCredits: number | null
  /** Cycle allowance, when the service reports a per-cycle cap. */
  cycleCredits: number | null
  /** Start of the current billing cycle, as Unix milliseconds. */
  cycleStartsAt: number | null
  /** End of the current billing cycle, as Unix milliseconds. */
  cycleEndsAt: number | null
  meters: WorkBuddyMeter[]
  /** When this snapshot was read. */
  fetchedAt: number
  /** Billing routes that answered, for diagnostics in the settings card. */
  sources: string[]
}

/** Everything the settings card and the composer badge render. */
export interface WorkBuddyWebStatus {
  enabled?: boolean
  authenticated: boolean
  hasCredentials: boolean
  /** Where credentials are read from; the local CodeBuddy auth directory. */
  authDirectory: string
  /** Storage description for the plugin's own settings file. */
  storagePath: string
  account: WorkBuddyAccount | null
  quota: WorkBuddyAccountQuota | null
  lastFetchedAt: number | null
  models: WorkBuddyModelOption[]
  contextWindowOverrides: Record<string, number>
  defaultReasoningEffort: WorkBuddyReasoningEffort | null
  /** Account selected for model discovery and all requests; null means automatic. */
  selectedAccountId: string | null
  /** Encrypted storage used for accounts added from this plugin. */
  managedStoragePath: string
  /** Route the plugin currently serves; false when another plugin owns it. */
  serving: boolean
  /** Diagnostic when the route is owned by a different adapter family. */
  conflict: string | null
}

/** Patch accepted by the models/settings route. */
export interface WorkBuddySettingsUpdateDto {
  enabled?: boolean
  enabledModelIds?: string[]
  contextWindowOverrides?: Record<string, number>
  defaultReasoningEffort?: WorkBuddyReasoningEffort | null
  selectedAccountId?: string | null
}

/** Result of a connection test against the upstream chat endpoint. */
export interface WorkBuddyConnectionDto {
  connected: boolean
  account: WorkBuddyAccount | null
  /** Round-trip time of the probe request. */
  latencyMs: number
  /** Model the probe asked for. */
  model: string
  checkedAt: number
}
