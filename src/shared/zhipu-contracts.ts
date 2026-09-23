/**
 * Wire contracts between the Zhipu (GLM Coding Plan) host routes and the
 * browser settings card. Everything here is public: no credential ever crosses
 * this boundary, only the non-secret facts the card renders.
 */

import type { AccountPoolStatusDto, PoolAccountSummaryDto } from './account-pool-contracts.ts'

/**
 * Which deployment an account belongs to.
 *
 * The two deployments are separate hosts with separate console-issued keys, and
 * a key minted on one is rejected by the other. The region is therefore a
 * property of the credential, not of the request.
 */
export type ZhipuRegion = 'cn' | 'intl'

/**
 * Reasoning levels this route can put on the wire.
 *
 * Deliberately the narrow set the Coding Plan accepts. Upstream documents
 * exactly these three for the GLM-5.x family and answers an error for anything
 * else, so the card offers only them and any other value a caller names is
 * converged onto the nearest rung before the request is built.
 */
export type ZhipuReasoningEffort = 'low' | 'high' | 'max'

/** Every level this route can name, in escalating order (the card's sort key). */
export const ZHIPU_REASONING_EFFORTS: readonly ZhipuReasoningEffort[] = ['low', 'high', 'max']

/**
 * Snap a level onto the nearest rung a model's ladder actually exposes.
 *
 * DSH's reasoning vocabulary is wider than this provider's: `minimal`,
 * `medium` and `xhigh` all exist on other routes. Sending one verbatim is not a
 * cosmetic problem here — upstream rejects an unsupported level outright — so
 * every value is placed on the model's own ladder before the request is built.
 * Ties resolve upward, matching the convergence the sibling provider lines use.
 * A model with no ladder (one that takes no `reasoning_effort`) yields nothing.
 *
 * Ranking covers both vocabularies, because ranking only this provider's three
 * rungs would misplace the ones below `low`: they mean *less* work, not more,
 * and reading `minimal` as unrecognised would snap it to the middle — sending
 * `high`, making the model think harder than the user asked and billing for it.
 */
const EFFORT_RANKS: Record<string, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
}

/** Rank of an unrecognised level: the middle rung, never an extreme. */
const UNKNOWN_EFFORT_RANK = EFFORT_RANKS.high!

export function convergeZhipuEffort(
  effort: string,
  ladder: readonly string[],
): ZhipuReasoningEffort | null {
  if (ladder.length === 0) return null
  const rank = (value: string): number =>
    EFFORT_RANKS[value.trim().toLowerCase()] ?? UNKNOWN_EFFORT_RANK
  const target = rank(effort)
  let best = ladder[0]!
  for (const candidate of ladder) {
    const distance = Math.abs(rank(candidate) - target)
    const bestDistance = Math.abs(rank(best) - target)
    if (distance < bestDistance || (distance === bestDistance && rank(candidate) > rank(best))) {
      best = candidate
    }
  }
  // The ladder is the model's own declaration, so a hit is always a nameable
  // level; the cast only records what the caller's data already guarantees.
  return best as ZhipuReasoningEffort
}

/** One model offered by the GLM Coding Plan. */
export interface ZhipuModelOption {
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
  /** Reasoning levels this model exposes; empty for a model that takes none. */
  reasoningEfforts: string[]
  /** Whether the model accepts image input on this route. */
  supportsImage: boolean
  /** Deployments that serve this model; the account's own region must be listed. */
  regions: ZhipuRegion[]
  /** One-line description shown beside the model in the settings card. */
  description?: string
}

/** One allowance window the monitor service reports. */
export interface ZhipuQuotaWindow {
  id: string
  label: string
  /** Used fraction in [0, 1] when the service reports a bounded allowance. */
  usedFraction: number | null
  /** Remaining fraction in [0, 1], when the service reports one. */
  remainingFraction: number | null
  /** Consumed amount as the service reports it, e.g. `12,500,000`. */
  used: string | null
  /** Window allowance as the service reports it. */
  limit: string | null
  /** Unix milliseconds the window resets, when reported. */
  resetsAt: number | null
  /** Length of the window in minutes, when the service names one. */
  windowMinutes: number | null
  description: string | null
}

/** One credit / token / tool-call meter the monitor service reports. */
export interface ZhipuMeter {
  id: string
  label: string
  usedFraction: number | null
  remainingFraction: number | null
  used: string | null
  limit: string | null
  resetsAt: number | null
  description: string | null
}

/** Account identity as the settings card renders it. Never carries the key. */
export interface ZhipuAccount {
  /** Stable, non-secret selection key derived from region + key digest. */
  id: string
  /** Last four characters of the key, so a user can tell two keys apart. */
  keyHint: string
  email: string | null
  planLabel: string | null
  region: ZhipuRegion
  /** Chat base URL this account's region resolves to. */
  apiBase: string
  /** Unix milliseconds the key was saved. */
  authenticatedAt: number | null
}

/** One Zhipu account as the shared pool card renders it. Never carries a key. */
export interface ZhipuAccountSummaryDto extends PoolAccountSummaryDto {
  region: ZhipuRegion
  /** Last four characters of the key. */
  keyHint?: string
  /** Chat base URL the account's region resolves to. */
  apiBase?: string
}

/** One point-in-time quota snapshot for the selected account. */
export interface ZhipuAccountQuota {
  account: ZhipuAccount
  /** Plan name the subscription service reports, e.g. `GLM Coding Pro`. */
  planName: string | null
  /** Machine plan level, e.g. `pro` / `lite` / `max`. */
  planLevel: string | null
  /** Unix milliseconds the plan renews, when reported. */
  renewsAt: number | null
  meters: ZhipuMeter[]
  windows: ZhipuQuotaWindow[]
  /** When this snapshot was read. */
  fetchedAt: number
  /** Monitor routes that answered, for diagnostics in the settings card. */
  sources: string[]
}

/** Everything the settings card and the composer badge render. */
export interface ZhipuWebStatus extends Partial<AccountPoolStatusDto> {
  enabled?: boolean
  authenticated: boolean
  hasCredentials: boolean
  /** Storage description for the plugin's encrypted credential store. */
  storagePath: string
  account: ZhipuAccount | null
  quota: ZhipuAccountQuota | null
  lastFetchedAt: number | null
  models: ZhipuModelOption[]
  contextWindowOverrides: Record<string, number>
  defaultReasoningEffort: ZhipuReasoningEffort | null
  /** Account selected for model discovery and all requests; null means automatic. */
  selectedAccountId: string | null
  /** Route the plugin currently serves; false when another plugin owns it. */
  serving: boolean
  /** Diagnostic when the route is owned by a different adapter family. */
  conflict: string | null
  /** Diagnostic when the monitor endpoints refused the last read. */
  quotaError: string | null
}

/**
 * Live state of the browser sign-in flow the card polls.
 *
 * The browser is not something the card controls, so — exactly like the Kimi
 * device-code flow — the attempt runs on the host and the card follows it here.
 * `authUrl` is always rendered, even when the host also opened a browser, so a
 * failed launch is recoverable by hand.
 */
export interface ZhipuLoginFlowStatus {
  status: 'idle' | 'pending' | 'complete' | 'error'
  /** Authorization page the browser must open for this attempt. */
  authUrl?: string
  /** Deployment the sign-in targets; this flow mints international keys only. */
  region?: ZhipuRegion
  startedAt?: number
  completedAt?: number
  /** Human-readable stage, for the pending state. */
  progress?: string
  /** Email the account reported, once the flow completes. */
  email?: string
  /** Why the attempt failed: a denominator error, or the verification verdict. */
  error?: string
}

/** Patch accepted by the models/settings route. */
export interface ZhipuSettingsUpdateDto {
  enabled?: boolean
  enabledModelIds?: string[]
  /** A number sets an override for that model; `null` restores the catalog default. */
  contextWindowOverrides?: Record<string, number | null>
  defaultReasoningEffort?: ZhipuReasoningEffort | null
  selectedAccountId?: string | null
}

/** Result of a connection test against the upstream chat endpoint. */
export interface ZhipuConnectionDto {
  connected: boolean
  account: ZhipuAccount | null
  /** Round-trip time of the probe request. */
  latencyMs: number
  /** Model the probe asked for. */
  model: string
  checkedAt: number
}
