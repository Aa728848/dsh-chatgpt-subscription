/**
 * Wire contracts between the WorkBuddy host routes and the browser settings
 * card. Everything here is public: no credential ever crosses this boundary.
 */

import type { AccountPoolStatusDto, PoolAccountSummaryDto } from './account-pool-contracts.ts'

/**
 * Which deployment region an account belongs to.
 *
 * The two regions are separate backends serving overlapping-but-different model
 * catalogs, and a model asked of the wrong region answers 400 `code 11102`
 * ("service info not found") rather than failing over. The region is therefore
 * a property of the credential, not of the request.
 */
export type WorkBuddyRegion = 'cn' | 'intl'

/**
 * Reasoning levels this route can name.
 *
 * Deliberately the widest set any model declares, so a saved default is not
 * discarded merely because the model that suggested it is no longer selected.
 * The settings card renders the subset the account's models actually declare.
 */
export type WorkBuddyReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Every level this route can name, in escalating order (the card's sort key). */
export const WORKBUDDY_REASONING_EFFORTS: readonly WorkBuddyReasoningEffort[] =
  ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Ladder of a WorkBuddy model that leaves the level choice to the gateway.
 *
 * `/v3/config` publishes a model's ladder in two shapes: an explicit
 * `supportedEfforts` list, or a lone `{ effort }` field that names only the
 * DEFAULT. Conflating them was a real bug — the lone field first became a
 * one-entry ladder, which rejected an explicit `low`; widening it to every
 * level this route can name then advertised `minimal`/`xhigh` on a model that
 * has three. Measured against the live gateway, such a model accepts exactly
 * `low`/`high`/`max` — the same three `glm-5.3-flash` and
 * `kimi-k2.8-preview` declare explicitly — and every other value is routed
 * into the nearest of them rather than honoured as a level of its own.
 */
export const WORKBUDDY_STANDARD_EFFORTS: readonly WorkBuddyReasoningEffort[] =
  ['low', 'high', 'max']

/**
 * Snap a level onto the nearest rung a model's ladder actually exposes.
 *
 * The gateway names a default from a wider vocabulary than the ladder it
 * publishes for the same model: an effort-only entry (minimax-m3, kimi-k3,
 * `glm-5.3` in the cn region) reports `effort: 'medium'` while exposing only
 * `low`/`high`/`max`. Letting that value through is not cosmetic — a default
 * outside the ladder is discarded by the level-resolution step, the request
 * then carries no `reasoning_effort`, and the model returns an EMPTY
 * `reasoning_content` (measured on minimax-m3: 0 characters across three
 * samples, versus 282-659 with the field). Ties resolve upward, which is the
 * mapping the sibling Kimi line documents for `medium`. A ladder that names
 * no level (a text-only model) yields nothing to converge to.
 */
export function convergeWorkBuddyEffort(
  effort: string,
  ladder: readonly string[],
): WorkBuddyReasoningEffort | null {
  if (ladder.length === 0) return null
  const rank = (value: string): number => {
    const index = WORKBUDDY_REASONING_EFFORTS.indexOf(value.trim().toLowerCase() as WorkBuddyReasoningEffort)
    // An unrecognised level is placed at the middle rung rather than at an
    // extreme, so it can never silently pick the cheapest or the most costly.
    return index === -1 ? WORKBUDDY_REASONING_EFFORTS.indexOf('high') : index
  }
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
  return best as WorkBuddyReasoningEffort
}

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

/**
 * Daily check-in preference for the CN-region billing activity.
 *
 * The activity is CN-only: the international deployment answers no check-in
 * surface, so the scheduler skips those accounts outright. There is no window
 * to configure: the first tick after the host starts is the daily run.
 */
export interface WorkBuddyCheckinSettings {
  /** Whether the in-process scheduler signs eligible accounts in. */
  enabled: boolean
}

/**
 * Aggregate check-in state the settings card renders.
 *
 * Deliberately account-less: the card shows one line ("checked in x/y today"),
 * not a per-account breakdown, so no account identity crosses here either.
 */
export interface WorkBuddyCheckinSummary {
  enabled: boolean
  /** CN-region accounts eligible for the check-in activity. */
  totalAccounts: number
  /** Accounts confirmed signed in today (already signed, or signed by a run). */
  doneToday: number
  /**
   * Accounts whose activity reported no entitlement today.
   *
   * Kept apart from {@link doneToday} because "the activity is inactive" is not
   * "you are checked in": counting them together let the card claim a sign-in
   * that never happened.
   */
  skippedToday: number
  /** Accounts that exhausted today's retry cap without signing in. */
  failedToday: number
  /** Unix milliseconds the scheduler last ran, automatic or manual. */
  lastRunAt: number | null
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

/** One WorkBuddy account as the shared pool card renders it. Never carries a token. */
export interface WorkBuddyAccountSummaryDto extends PoolAccountSummaryDto {
  region: WorkBuddyRegion
  /** Which store owns the credential; only managed accounts may be deleted. */
  source: 'desktop' | 'managed'
  /** Whether the card may offer Delete for this account. */
  removable: boolean
  nickname?: string
  /** Tencent UIN, masked by the card rather than shown in full. */
  uin?: string
  /** IDE file a desktop account was adopted from. */
  sourceFile?: string
  /** Auth domain recorded in the credential, e.g. `copilot.tencent.com`. */
  domain?: string
  /** Backend base URL the account's region resolves to. */
  backend?: string
  /** Account kind the client reports, e.g. `personal`. */
  accountType?: string
  /**
   * Whether the plugin currently routes to this account.
   *
   * Distinct from the pool's `activeAccountId`: a hidden account keeps its
   * place in the pool but is not offered for routing while hidden.
   */
  hidden?: boolean
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
export interface WorkBuddyWebStatus extends Partial<AccountPoolStatusDto> {
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
  /** Pool summaries the shared account card renders; empty without a pool. */
  accounts?: WorkBuddyAccountSummaryDto[]
  /** Aggregate daily check-in state; absent when the host predates check-in. */
  checkin?: WorkBuddyCheckinSummary | null
}

/** Patch accepted by the models/settings route. */
export interface WorkBuddySettingsUpdateDto {
  enabled?: boolean
  enabledModelIds?: string[]
  /** A number sets an override for that model; `null` restores the catalog default. */
  contextWindowOverrides?: Record<string, number | null>
  defaultReasoningEffort?: WorkBuddyReasoningEffort | null
  selectedAccountId?: string | null
  /** Partial check-in update; omitted fields keep their stored value. */
  checkin?: Partial<WorkBuddyCheckinSettings>
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
