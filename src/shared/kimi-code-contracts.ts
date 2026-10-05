/**
 * Wire contracts between the Kimi Code host routes and the browser settings
 * card. Everything here is public: no credential ever crosses this boundary.
 *
 * Kimi Code (https://www.kimi.com/code) is a Moonshot AI coding subscription,
 * distinct from the pay-as-you-go Moonshot Open Platform: its credentials come
 * from an OAuth device flow against auth.kimi.com and its inference lives at
 * https://api.kimi.com/coding/v1.
 */

import type { AccountRotationStrategy, PoolAccountSummaryDto } from './account-pool-contracts.ts'

/** Region a Kimi Code account belongs to; decides which hosts the client uses. */
export type KimiCodeRegion = 'mainland-cn' | 'global'

/**
 * Request/response dialect used for the model calls.
 *
 * The official Kimi Code CLI configures its managed provider as `type = "kimi"`,
 * an OpenAI-compatible chat-completions client, so that is the default here.
 * The Anthropic Messages dialect is offered too because the service documents
 * `https://api.kimi.com/coding/` as an Anthropic-compatible base URL for
 * third-party tools, and some models behave better with a thinking budget.
 */
export type KimiCodeWire = 'openai' | 'anthropic'

/**
 * Thinking level a Kimi Code model accepts.
 *
 * Kimi Code maps a tool's effort onto exactly three K3 levels plus a thinking-off
 * switch. The documented mapping is authoritative and deliberately narrower than
 * the generic level set other providers use:
 *
 * - `low`   <- `low` / `minimum` / `light`
 * - `high`  <- `high` / `medium`
 * - `max`   <- `ultra` / `max` / `xhigh`
 * - `none`  -> thinking disabled (`thinking.type = "disabled"`)
 *
 * Anything else the client sends is rejected by the service with HTTP 400, so
 * no other level is ever put on the wire.
 */
export type KimiCodeReasoningEffort = 'low' | 'high' | 'max' | 'none'

/**
 * Prompt-cache TTL the Kimi subscription accepts.
 *
 * The two wires spell the request differently (`prompt_cache_options` on the
 * OpenAI one, a TOP-LEVEL `cache_control` on the Anthropic one), but the tier
 * names are the same. `null` in the settings means "send neither", which is
 * the service's own default behaviour.
 */
export type KimiCodeCacheTtl = '5m' | '1h'

/**
 * How the service says a model handles thinking, when it says so at all.
 *
 * The three-state declaration is strictly more informative than a boolean:
 * `only` distinguishes "always reasons" from "no reasoning support", which
 * a single boolean cannot express, and the two demand opposite treatment —
 * the first must not be offered a `none` effort, the second must be offered
 * nothing at all.
 */
export type KimiCodeThinkingType = 'only' | 'no' | 'both'

/** Every level, in escalating order; the settings card renders exactly these. */
export const KIMI_CODE_REASONING_EFFORTS: readonly KimiCodeReasoningEffort[] =
  ['low', 'high', 'max', 'none']

/** One model offered by the Kimi Code coding endpoint. */
export interface KimiCodeModelOption {
  id: string
  name: string
  /** Enabled models are the ones DSH offers in the conversation model picker. */
  enabled: boolean
  /** Context window the catalog reports for this model. */
  defaultContextWindow: number
  /** Effective context window: the override when one is saved, else the default. */
  contextWindow: number
  /**
   * Largest prompt the endpoint accepts, when the service states a cap below
   * the context window.
   *
   * A model can have a 1M window and a lower input limit. The window still
   * bounds the completion budget, but a prompt sized against it overshoots into
   * a rejected request instead of a compaction, so the two are reported
   * separately.
   */
  maxInputTokens?: number
  /**
   * Ceiling for the prompt of one turn.
   *
   * The smaller of the effective window and {@link maxInputTokens}; always a
   * number, so a caller never has to decide which of the two applies.
   */
  promptBudget: number
  /** Maximum output tokens this route requests when a caller omits one. */
  defaultMaxTokens: number
  /** Thinking levels this model accepts; absent for a model that cannot reason. */
  reasoningEfforts?: string[]
  /** Thinking level used when the conversation does not pick one. */
  defaultReasoningEffort?: string
  /** Request/response dialect the adapter uses on the wire. */
  wire: KimiCodeWire
  /** Human description from the official model table. */
  description: string | null
  /** Whether the model accepts video input as well as images. */
  supportsVideo: boolean
  /**
   * Whether the model accepts message-level tool declarations
   * (`messages[].tools`), Kimi's `dynamically_loaded_tools` capability.
   *
   * The card shows it because it is the one K3 feature that changes how a
   * client should be shaped rather than what it may send: a session that
   * progressively discloses tools keeps its top-level list stable, which is
   * what protects the prefix cache.
   */
  supportsDynamicTools: boolean
  /**
   * Whether the model accepts tool declarations at all.
   *
   * Wider than {@link supportsDynamicTools}, which asks only about message-level
   * declarations: a model may take tools at the top level and not per message.
   * The card shows both because a false here is the one that breaks every
   * coding session on the model.
   */
  supportsToolUse: boolean
  /** Subscription tier the model needs, when it is not open to every member. */
  minimumPlan: string | null
}

/** One quota window reported for the signed-in account. */
export interface KimiCodeUsageWindow {
  id: string
  label: string
  /** Used fraction in [0, 1]. */
  usedFraction: number
  /** Convenience integer for the card and badge. */
  usedPercent: number
  /** Nominal window length in minutes, when the service states one. */
  windowDurationMins: number | null
  /** Unix milliseconds the window resets, when reported. */
  resetsAt: number | null
  /** Allowance as the service reports it (request counts), when reported. */
  limit: string | null
  used: string | null
  remaining: string | null
}

/** Pay-as-you-go wallet the account can fall back on once a window is spent. */
export interface KimiCodeExtraUsage {
  /** Remaining wallet balance in the currency's minor unit. */
  balanceCents: number | null
  totalCents: number | null
  monthlyChargeLimitEnabled: boolean
  monthlyChargeLimitCents: number | null
  monthlyUsedCents: number | null
  currency: string | null
}

/** Account identity, resolved from the token and the usage response. */
export interface KimiCodeAccount {
  userId: string | null
  nickname: string | null
  email: string | null
  /** Subscription tier display name, for example Moderato. */
  planName: string | null
  /** Machine tier level when the service reports one. */
  planLevel: string | null
  region: KimiCodeRegion | null
  authenticatedAt: number | null
}

/** One point-in-time quota snapshot for the signed-in Kimi Code account. */
export interface KimiCodeAccountQuota {
  account: KimiCodeAccount
  /** Subscription tier display name, when the service reports one. */
  planName: string | null
  /** Every quota window the account currently has. */
  windows: KimiCodeUsageWindow[]
  /** Pay-as-you-go booster wallet, when the account has one. */
  extraUsage: KimiCodeExtraUsage | null
  /** Unix milliseconds this snapshot was fetched. */
  fetchedAt: number
  /** Endpoint paths that answered, kept for diagnostics in the card. */
  sources: string[]
}

/** Everything the settings card and the composer badge render. */
export interface KimiCodeWebStatus {
  enabled?: boolean
  authenticated: boolean
  hasCredentials: boolean
  storagePath: string
  region: KimiCodeRegion
  oauthHost: string
  codingBaseUrl: string
  account: KimiCodeAccount | null
  quota: KimiCodeAccountQuota | null
  lastFetchedAt: number | null
  /**
   * Whether a quota refresh is running behind this answer.
   *
   * The card renders the snapshot it already had instead of waiting on the
   * upstream request; when this is true the client asks again shortly so the
   * refreshed snapshot reaches the UI.
   */
  quotaRefreshing?: boolean
  /** When true the stored refresh token was rejected and sign-in is required. */
  credentialsRejected: boolean
  /**
   * Why the quota could not be read, when the last attempt failed.
   *
   * Reported beside the snapshot rather than in place of it: a transient
   * failure should explain itself without hiding the account that is signed in.
   */
  quotaError?: string | null
  /** Rolling prefix-cache effectiveness for this process, when requests ran. */
  cache: KimiCodeCacheStatsDto | null
  /**
   * Warning that this conversation's prompt cache has expired, when it has and
   * the context is large enough for reprocessing to be worth mentioning.
   */
  cacheHint?: KimiCodeCacheHintDto | null
  /** Whether Preserved Thinking is currently requested on the wire. */
  preserveThinking: boolean
  models: KimiCodeModelOption[]
  contextWindowOverrides: Record<string, number>
  defaultReasoningEffort: KimiCodeReasoningEffort | null
  /**
   * Prompt-cache tier this line asks for. `null` means "send no cache field",
   * which is Kimi's own default behaviour.
   */
  cacheTtl: KimiCodeCacheTtl | null
  /** Signed-in accounts; empty or absent when no pool is installed. */
  accounts?: KimiCodeAccountSummaryDto[]
  /** Account the next request would use. */
  activeAccountId?: string
  rotationStrategy?: AccountRotationStrategy
  /** Region used for the next login flow. */
  loginRegion: KimiCodeRegion
  /** Route the plugin currently serves; false when another plugin owns it. */
  serving: boolean
  /** Diagnostic when the route is owned by a different adapter family. */
  conflict: string | null
}

/**
 * How well Kimi's automatic prefix cache is working for this process.
 *
 * Reported because the cache is invisible otherwise: it is content-hash based
 * with no marker to set, so the read ratio is the only evidence a session is
 * actually reusing its prefix.
 */
export interface KimiCodeCacheStatsDto {
  requests: number
  cachedTokens: number
  freshTokens: number
  outputTokens: number
  /** Cached / (cached + fresh); null until a request reports usage. */
  hitRatio: number | null
  /**
   * Why the most recent request's prefix broke, when it did.
   *
   * Surfaces the diagnostic half of the hit ratio: `'stable'` means the prefix
   * should have held (so a miss implicates content below the head or the
   * service), while the other values name the input that invalidated the cache.
   */
  lastDrift?: 'first-request' | 'stable' | 'system-prompt' | 'tools' | 'cache-key' | 'cold-key'
  /**
   * Always 0 on this route: the endpoint writes cache entries without counting
   * them, so there is no write cost to track.
   *
   * Reported rather than dropped so the shape stays aligned with the sibling
   * providers that DO report writes, and so a route that starts counting them
   * needs no contract change.
   */
  cacheWriteTokensNote?: 'always-zero-on-this-route'
}

/**
 * A warning that the conversation's prompt cache has expired.
 *
 * Kimi's cache is content-hash based with no marker to set, so a client that
 * says nothing leaves the user paying a full reprocessing pass with no idea
 * why the next turn was slow. Absent means "nothing to say" — which is most
 * of the time, since the hint needs an idle period AND a context large enough
 * for reprocessing to matter.
 */
export interface KimiCodeCacheHintDto {
  /** How long the conversation has been idle, epoch ms. */
  idleMs: number
  /** Context that will be reprocessed on the next turn. */
  totalTokens: number
}

/** Patch accepted by the models/settings routes. */
export interface KimiCodeSettingsUpdateDto {
  enabled?: boolean
  enabledModelIds?: string[]
  /** A number sets an override for that model; `null` restores the catalog default. */
  contextWindowOverrides?: Record<string, number | null>
  defaultReasoningEffort?: KimiCodeReasoningEffort | null
  /** `null` clears the tier, returning to "send no cache field". */
  cacheTtl?: KimiCodeCacheTtl | null
}

/** One pooled Kimi Code account as the settings card renders it; never carries a token. */
export interface KimiCodeAccountSummaryDto extends PoolAccountSummaryDto {
  nickname?: string
  userId?: string
  planName?: string
  /** Region the credential was issued in; a pool may hold several. */
  region?: KimiCodeRegion
}

/** Live state of the device-code login flow the card polls. */
export interface KimiCodeLoginFlowStatus {
  status: 'idle' | 'pending' | 'complete' | 'error'
  /** Page the user must open, including the pre-filled user code. */
  verificationUriComplete?: string
  verificationUri?: string
  userCode?: string
  startedAt?: number
  completedAt?: number
  /** Unix milliseconds the device code stops being valid. */
  expiresAt?: number
  progress?: string
  error?: string
}

/** Result of an explicit connection test. */
export interface KimiCodeConnectionDto {
  connected: boolean
  latencyMs: number
  account: KimiCodeAccount | null
}
