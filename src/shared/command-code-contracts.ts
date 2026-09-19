/**
 * Wire contracts between the Command Code host routes and the browser settings
 * card. Everything here is public: no credential ever crosses this boundary.
 */

/** Deployment of the Command Code API a credential was issued against. */
export type CommandCodeApiEnv = 'prod' | 'staging' | 'local'

/**
 * Reasoning levels the provider registry can expose. The exact set is per
 * model — `minimal` is the cheapest budget, `xhigh` sits between `high` and
 * `max`, and most models declare only a subset.
 */
export type CommandCodeReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Every level, in escalating order; the settings card renders exactly these. */
export const COMMAND_CODE_REASONING_EFFORTS: readonly CommandCodeReasoningEffort[] =
  ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** One model offered by the Command Code provider API. */
export interface CommandCodeModelOption {
  id: string
  name: string
  /** Enabled models are the ones DSH offers in the conversation model picker. */
  enabled: boolean
  /** Context window the live catalog reports for this model. */
  defaultContextWindow: number
  /** Effective context window: the override when one is saved, else the default. */
  contextWindow: number
  /** Maximum output tokens this route requests when a caller omits one. */
  defaultMaxTokens: number
  /** Reasoning levels this route exposes; absent for non-reasoning models. */
  reasoningEfforts?: string[]
  /** Reasoning dialect the adapter uses on the wire. */
  wire: CommandCodeWire
}

/** Request/response dialect a model id is served over. */
export type CommandCodeWire = 'openai' | 'anthropic'

/** One credit / spend meter reported by the billing service. */
export interface CommandCodeMeter {
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

/** Windowed request/token allowance reported by the usage service. */
export interface CommandCodeUsageWindow {
  id: string
  label: string
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}

/** Account identity returned by `/alpha/whoami`. */
export interface CommandCodeAccount {
  userId: string | null
  userName: string | null
  email: string | null
  organizationName: string | null
  keyName: string | null
  planLabel: string | null
  planId: string | null
  authenticatedAt: number | null
}

/** One point-in-time quota snapshot for the signed-in Command Code account. */
export interface CommandCodeAccountQuota {
  account: CommandCodeAccount
  /** Credit balance in the provider's own unit, when reported. */
  creditBalance: string | null
  /** True when the plan bills against an unlimited allowance. */
  unlimited: boolean
  /** Machine id the service reports, e.g. `individual-goat`. */
  planId: string | null
  /** Display name for {@link planId}, e.g. `GOAT`. */
  planName: string | null
  /** Monthly credits the plan grants, when the id is recognized. */
  planMonthlyCredits: number | null
  /** Subscription state the service reports, e.g. `active`. */
  subscriptionStatus: string | null
  /** End of the current billing period, as Unix milliseconds. */
  periodEndsAt: number | null
  meters: CommandCodeMeter[]
  windows: CommandCodeUsageWindow[]
  /** Raw service payloads, kept for diagnostics in the settings card. */
  fetchedAt: number
  sources: string[]
}

/** Everything the settings card and the composer badge render. */
export interface CommandCodeWebStatus {
  enabled?: boolean
  authenticated: boolean
  hasCredentials: boolean
  storagePath: string
  apiEnv: CommandCodeApiEnv
  account: CommandCodeAccount | null
  quota: CommandCodeAccountQuota | null
  lastFetchedAt: number | null
  models: CommandCodeModelOption[]
  contextWindowOverrides: Record<string, number>
  defaultReasoningEffort: CommandCodeReasoningEffort | null
  /** Route the plugin currently serves; false when another plugin owns it. */
  serving: boolean
  /** Diagnostic when the route is owned by a different adapter family. */
  conflict: string | null
}

/** Patch accepted by the models/settings routes. */
export interface CommandCodeSettingsUpdateDto {
  enabled?: boolean
  enabledModelIds?: string[]
  contextWindowOverrides?: Record<string, number>
  defaultReasoningEffort?: CommandCodeReasoningEffort | null
}

/** Result of a manual API-key submission or a compatibility probe. */
export interface CommandCodeConnectionDto {
  connected: boolean
  account: CommandCodeAccount | null
  checkedAt: number
}
