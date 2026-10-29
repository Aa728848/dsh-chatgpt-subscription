/**
 * Wire contracts between the WorkBuddy host routes and the browser settings
 * card. Everything here is public: no credential ever crosses this boundary.
 */

import type { AccountPoolStatusDto, PoolAccountSummaryDto } from './account-pool-contracts.ts'
import type { PoolStorageDto } from './contracts.ts'

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
 * Local quota guardrails, as the settings card edits them.
 *
 * The host owns the enforcement; this is the wire shape. `0` means OFF for every
 * field, and all-off is the default, so an untouched install behaves exactly as
 * before the guardrails existed.
 */
export interface WorkBuddyGuardrailsDto {
  /** Stop serving an account whose remaining credits are below this. */
  reserveCredits: number
  /** Stop serving an account for the rest of the local day at this many tokens. */
  dailyTokens: number
  /** Stop serving one model for the rest of the local day at this many tokens. */
  modelDailyTokens: number
}

/** Client families this line can present to the gateway. */
export type WorkBuddyOutboundProduct = 'cli' | 'workbuddy' | 'vscode'

/**
 * Stored preference for which client family requests present.
 *
 * `auto` assigns one product per account and keeps it for that account's whole
 * life; every other value pins it line-wide. The shipped default (`cli`) is the
 * identity this line has always sent.
 */
export type WorkBuddyOutboundSetting = 'auto' | WorkBuddyOutboundProduct

/**
 * Consumption multiplier of one model, per region.
 *
 * The subscription publishes a \`credits\` string per model in its own
 * \`/v3/config\` catalog — \`x0.79 credits\`, \`x6.67\` — which is the relative rate at
 * which that model consumes the package allowance. The official CodeBuddy
 * client renders it as \`6.67x\` beside the model in its picker; this route
 * carries the same fact to the settings card, so a model's cost is visible at
 * the moment it is chosen rather than only on the bill.
 *
 * Keyed by region because the two backends do not always agree: measured
 * 2026-10-09, \`deepseek-v4.1-flash\` is \`0.11\` on cn against \`0.00\` on intl. A
 * region the catalog did not name for this model is absent rather than guessed,
 * and a model whose publisher declares no usable rate (\`default-model\` ships an
 * empty string) carries no entry at all.
 *
 * Values are the bare numeric form (\`'0.79'\`), never the wire spelling: the
 * label and the \`x\` suffix belong to whichever surface renders it.
 */
export type WorkBuddyModelCredits = Partial<Record<WorkBuddyRegion, string>>

/**
 * Parse one gateway \`credits\` string into the bare multiplier it names.
 *
 * Measured shapes: \`x6.67\` (intl), \`x0.79 credits\` (cn), and \`''\` for a model
 * whose publisher declares no rate. \`x0.00\` is deliberately kept — it is a real
 * declaration ("this model does not consume allowance"), not a missing value,
 * so it must not be confused with the empty string that means nothing is known.
 *
 * The return is \`null\` rather than \`0\` for anything unparseable, so a caller can
 * tell "no rate published" from "a rate of zero".
 */
export function parseWorkBuddyCreditMultiplier(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const stripped = raw.replace(/\s*credits\s*$/i, '').trim().replace(/^[x×]/i, '').trim()
  if (stripped === '') return null
  const value = Number(stripped)
  if (!Number.isFinite(value) || value < 0) return null
  return stripped
}

/**
 * Reasoning levels this route can name.
 *
 * Deliberately the widest set any model declares, so a saved default is not
 * discarded merely because the model that suggested it is no longer selected.
 * The settings card renders the subset the account's models actually declare.
 */
export type WorkBuddyReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * Every level this route can name, in escalating order (the card's sort key).
 *
 * `none` is the one level that is not a rung of any ladder: it is the measured
 * spelling that turns the reasoning trace OFF upstream (`reasoning_effort:
 * "none"`, the value the sibling gateway sends on its own cheap calls). It is
 * only ever offered on a model the catalog marks `canDisableThinking`, so it
 * sorts below everything and is never used to converge a level onto a ladder.
 */
export const WORKBUDDY_REASONING_EFFORTS: readonly WorkBuddyReasoningEffort[] =
  ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

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
  /**
   * Consumption multiplier per region, as the gateway declares it.
   *
   * Absent when nothing usable was published for this model — an unreachable
   * gateway served by the shipped fallback for a model it does not rate, or an
   * account whose region is not among the keys. The card must then show no
   * multiplier rather than a placeholder: a guessed rate on a spend figure is
   * worse than a missing one.
   */
  credits?: WorkBuddyModelCredits
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
  /**
   * Models this account is parked on, as the line's pool knows them.
   *
   * Line-private on purpose: the shared `PoolAccountSummaryDto` carries no
   * per-model cooldown, because a model park is a fact about THIS gateway's
   * account × model metering and nothing else. Widening the shared DTO would
   * make every other line answer a field it never fills; this extension keeps
   * the fact where it belongs and still reaches the routes and the card.
   */
  modelCooldowns?: WorkBuddyModelCooldownDto[]
  /**
   * Account-scoped refusal the gateway reported, when it reported one.
   *
   * Distinct from both cooldowns above: a cooldown lifts on its own and parks
   * one model or one account for a while, while a restriction says the account
   * itself may not be served at all and the pool must stop selecting it.
   */
  restriction?: WorkBuddyAccountRestrictionDto
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
  /**
   * Whether a quota refresh is running behind this answer.
   *
   * The card renders the snapshot it already had instead of waiting on the
   * upstream request; when this is true the client asks again shortly so the
   * refreshed snapshot reaches the UI.
   */
  quotaRefreshing?: boolean
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
  /** Which client identity chat requests present. */
  outboundIdentity?: WorkBuddyOutboundSetting
  /** Local quota guardrails currently armed (all zero when off). */
  guardrails?: WorkBuddyGuardrailsDto
  /**
   * Whether this process holds the key that opens `$wbEncrypted` credentials.
   *
   * False with {@link sealedAccounts} above zero is the actionable state: the
   * desktop client has sealed its tokens and nothing can read them yet.
   */
  atRestKeySet?: boolean
  /** Sealed desktop credential files the last scan met. */
  sealedAccounts?: number
  /** Why the last sealed file refused to open, when one did. */
  sealedAccountsError?: string | null
  /**
   * Whole-pool state: pause, restricted accounts, and where the pool is kept.
   *
   * Absent means the host predates pool persistence, which is not the same as
   * "not paused" — a card must render nothing rather than "running".
   */
  pool?: WorkBuddyPoolStateDto
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
  /** Which client identity chat requests present. */
  outboundIdentity?: WorkBuddyOutboundSetting
  /** Partial guardrail update; omitted fields keep their stored value. */
  guardrails?: Partial<WorkBuddyGuardrailsDto>
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

/**
 * Gateway code for an account the subscription itself refuses to serve.
 *
 * Distinct from every code the host names elsewhere: `11102` is one model the
 * region does not serve and `6004` is a usage window, while this one bars the
 * ACCOUNT — the pool must stop selecting it rather than park one model on it.
 *
 * PROVENANCE — read from upstream source, not inferred:
 *
 * - `magpie-community/plugins` @ `1e7122e1`, `packages/workbuddy/index.mjs`
 *   L2770-2780 defines the code as the gateway's restricted-account signal
 *   (`RESTRICTED_CODE = 11140`) together with the wording a restricted account
 *   is answered with — the account is barred from being served, not one model
 *   parked.
 * - `ardeyouxipianyi/workbuddy2api-hub` @ `1ea7f61e`, `wb_proxy.py`
 *   L14253-14333 handles the same code, so the classification (account-scoped
 *   rather than model-scoped) is corroborated by two independent clients rather
 *   than by a single reading.
 *
 * Still open, and stated as open: the exact `msg` text and the reset instant a
 * LIVE gateway attaches to the code are a measurement this wave does not make.
 * Treat `11140` as "account barred" — do not parse its message for a duration.
 */
export const WORKBUDDY_RESTRICTED_ACCOUNT_CODE = 11140 as const

/**
 * One model an account is parked on, inside the account's own eligibility.
 *
 * The account can still serve every model NOT named here, which is why this is
 * a list on the account rather than a second account-level cooldown: a card
 * that only drew `cooldownUntil` would report the account as available while
 * the one model the request wants is the one that is refused.
 */
export interface WorkBuddyModelCooldownDto {
  /** Model id in the vocabulary of the catalog the pool routed with. */
  model: string
  /** Unix milliseconds the park lifts; a past value is already lifted. */
  cooldownUntil: number
}

/** An account-scoped refusal, as the settings card reports it. */
export interface WorkBuddyAccountRestrictionDto {
  /**
   * Gateway code. {@link WORKBUDDY_RESTRICTED_ACCOUNT_CODE} is the one that
   * bars the account itself; `11158` is the same shape for a single model an
   * account has no entitlement for.
   */
  code: number
  /** Upstream `msg` when one came with the code. Never a credential. */
  message?: string
  /** Unix milliseconds the refusal lifts, when the gateway names one. */
  until?: number
}

/**
 * Whole-pool state the settings card and the composer badge read.
 *
 * A pause is a decision about the POOL — nothing is routable right now — and no
 * per-account field can express it. Drawing "3 accounts available" while the
 * pool is stopped for one restricted account is exactly the lie this exists to
 * prevent, so the pause is reported on its own and the card renders it first.
 */
export interface WorkBuddyPoolStateDto {
  /** Whether new requests are refused right now. */
  paused: boolean
  /** Why the pool is paused, when it is. Composed by the host, never a token. */
  pauseReason?: string
  /** Unix milliseconds the pause began. */
  pausedSince?: number
  /**
   * Unix milliseconds the pause lifts on its own. Absent means it does not lift
   * without the user (every account restricted, or a manual pause).
   */
  pausedUntil?: number
  /** Account ids currently barred by a {@link WorkBuddyAccountRestrictionDto}. */
  restrictedAccountIds?: string[]
  /**
   * Which backend holds the pool document, and whether it encrypts it at rest.
   *
   * Deliberately the SHARED `PoolStorageDto` (`src/shared/contracts.ts`), not a
   * line-private copy. The account-pool storage choice is one deployment fact —
   * `mode: 'keyring' | 'credentials'` resolved to `backend: 'keyring' |
   * 'credentials' | 'dpapi' | 'keychain'`, with `encrypted` and an
   * `unavailable` reason code — and every line's card has to answer it the same
   * way. A line-private shape would let a card name a store the host is not
   * actually using, which is the one thing this field exists to prevent.
   *
   * Absent means the host predates pool persistence — not "unencrypted".
   */
  storage?: PoolStorageDto
}

/**
 * The parks of one account that have not lifted yet.
 *
 * `now` is a parameter rather than a hidden `Date.now()` so one render walks a
 * consistent instant. An expired park is dropped rather than reported: a card
 * that lists a park that already lifted tells the user an eligible account is
 * unavailable.
 */
export function liveWorkBuddyModelCooldowns(
  cooldowns: readonly WorkBuddyModelCooldownDto[] | undefined,
  now: number,
): WorkBuddyModelCooldownDto[] {
  return (cooldowns ?? []).filter((entry) => entry.cooldownUntil > now)
}

/**
 * Which wire protocol one model is served on.
 *
 * The subscription speaks two. OpenAI chat completions serves its own models;
 * Anthropic's Messages shape serves the Claude models of the CHINA deployment,
 * beside them on the same host. Everything downstream — routes, adapter,
 * mapper — picks its path and its reasoning field from here, never from a model
 * name spelled out again, so the two vocabularies cannot drift apart.
 */
export type WorkBuddyModelProtocol = 'chat-completions' | 'anthropic-messages'

/**
 * Regions that answer `/v1/messages`.
 *
 * Measured on 2026-10-24: only the China deployment (`copilot.tencent.com`)
 * serves Messages. The international deployment answers "404 Route Not Found"
 * to `/v1/messages`, `/v2/messages` and `/v1/messages?beta=true` whatever
 * the model, so a Claude model there stays on chat completions.
 *
 * Source: `magpie-community/plugins@1e7122e1`, `packages/workbuddy/index.mjs`
 * L132-157 (`apiMessages` = `<endpoint>/v1`, `nativeOf`, and the 404 note).
 */
export const WORKBUDDY_MESSAGES_REGIONS: readonly WorkBuddyRegion[] = ['cn']

/**
 * How each protocol accepts a reasoning level.
 *
 * This difference is why a Claude model is not merely a path change: chat
 * completions takes a `reasoning_effort` field, while Anthropic's shape asks
 * for thinking (`thinking.type: adaptive` plus `output_config.effort`). The
 * upstream client measured the chat endpoint answering the same at every level,
 * which is the other half of the same fact.
 *
 * Source: same file, L134-139.
 */
export const WORKBUDDY_PROTOCOL_REASONING: Readonly<
  Record<WorkBuddyModelProtocol, 'chat-effort' | 'anthropic-thinking'>
> = {
  'chat-completions': 'chat-effort',
  'anthropic-messages': 'anthropic-thinking',
}

/** One model's route on one region, frozen for the mapper wave to consume. */
export interface WorkBuddyModelRouteDto {
  /** Model id, in whichever vocabulary the caller resolved it. */
  model: string
  region: WorkBuddyRegion
  protocol: WorkBuddyModelProtocol
  /** Reasoning field this protocol honours (see {@link WORKBUDDY_PROTOCOL_REASONING}). */
  reasoning: 'chat-effort' | 'anthropic-thinking'
}

/** Whether a model id is Anthropic's own, which is what Messages routability keys on. */
export function isWorkBuddyClaudeModel(model: string): boolean {
  return /^claude-/i.test(model.trim())
}

/**
 * Route one model on one region.
 *
 * The rule is the upstream client's own (`nativeOf`): a Claude model on a
 * deployment that serves Messages goes to Messages; everything else — and every
 * model on the international deployment — stays on chat completions. Total and
 * pure, so the mapper wave never has to ask the network which path a model takes
 * or re-derive the rule privately.
 */
export function workBuddyModelRoute(
  model: string,
  region: WorkBuddyRegion,
): WorkBuddyModelRouteDto {
  const protocol: WorkBuddyModelProtocol = isWorkBuddyClaudeModel(model)
    && WORKBUDDY_MESSAGES_REGIONS.includes(region)
    ? 'anthropic-messages'
    : 'chat-completions'
  return { model, region, protocol, reasoning: WORKBUDDY_PROTOCOL_REASONING[protocol] }
}
