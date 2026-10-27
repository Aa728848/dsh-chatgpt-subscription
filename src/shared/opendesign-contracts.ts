import type {
  AccountPoolStatusDto,
  AccountRotationStrategy,
  PoolAccountSummaryDto,
} from './account-pool-contracts.ts'

/**
 * Wire contracts for the OpenDesign line's settings API.
 *
 * OpenDesign (open-design.ai, nexu-io/open-design) sells subscription plans whose
 * model credits third-party tools spend through the "OpenDesign API": a static
 * API key created in the Cloud console, sent as `Authorization: Bearer` to the
 * link gateway. The gateway speaks the OpenAI Chat Completions protocol — the
 * console's own quick-setup recommends exactly that format for DeepSeek Harness.
 *
 * Two sign-in paths share the pool:
 *
 * - **Browser device authorization** (the official `vela login` flow,
 *   reimplemented over the public AMR API): the host creates a device
 *   authorization, the user approves it in the Cloud console, and the poll
 *   returns a `vela_ctrl_…` control key, an `sk-amr-…` runtime key, and the
 *   account's identity. The runtime key serves chat; the control key reads the
 *   wallet balance. Neither expires (no expiry is published or observed).
 * - **A pasted API key** created in the console — the path the pricing FAQ
 *   documents for Codex / Claude Code / DSH. Chat only: the gateway answers a
 *   bare key with no profile fields, and the console's wallet surface refuses it.
 */

export const OPENDESIGN_PROVIDER_ID = 'opendesign'
export const OPENDESIGN_PROVIDER_NAME = 'OpenDesign'
export const OPENDESIGN_ROUTE_PREFIX = '/opendesign/api'

/**
 * Where a user creates and revokes a key: the Cloud console's workspace area.
 * The console is a SPA; the keys screen is the workspace's API-keys view, so the
 * card links to the workspace root and says "API Keys" in words.
 */
export const OPENDESIGN_CONSOLE_URL = 'https://open-design.ai/cloud'

/** One published price, as the card renders it (USD per 1M tokens). */
export interface OpenDesignModelPricingDto {
  input: number
  output: number
}

/** One model as the card renders it: published facts plus the user's overrides. */
export interface OpenDesignModelDto {
  id: string
  name: string
  /** One-line capability summary built on the host for ModelChecklist. */
  hint?: string
  contextWindow: number
  /** The published/default window, before the user's override. */
  defaultContextWindow: number
  maxTokens: number
  reasoning: boolean
  input: string[]
  /**
   * Whether the card's checklist row is checked, which is also what the picker
   * does with the model.
   *
   * Two rules, because the two states are different questions:
   *
   * - `served !== false` (the plan serves it, or nothing was measured yet): the
   *   user's tick list minus the hidden list, exactly as before.
   * - `served === false`: the tick IS the force switch. Such a row reads as
   *   checked exactly when it is in `forceVisibleModels`, because the card marks
   *   it "not in this plan, tick to force it" — a row that said "checked" while
   *   the adapter refused to advertise it would contradict itself.
   */
  enabled: boolean
  /**
   * Whether the plan's last successful catalog scan listed this model.
   *
   * Always `true` before the first sync: with nothing measured, nothing is
   * filtered. `false` means the plan does not serve the model, so the adapter
   * stops advertising it — the card keeps rendering it so the user can still
   * choose, which is what {@link forcedVisible} records.
   */
  served?: boolean
  /** Whether the user force-shows this model even though the plan omits it. */
  forcedVisible?: boolean
  /** The model's published price, when the public price list carries one. */
  pricing?: OpenDesignModelPricingDto
  /** Stored context-window override, absent when the default applies. */
  contextWindowOverride?: number
}

/** One pooled account as the shared card renders it. Never carries a secret. */
export interface OpenDesignAccountSummaryDto extends PoolAccountSummaryDto {
  /** How this account signed in; absent on a legacy row. */
  authKind?: 'oauth' | 'api-key'
  /** The plan the upstream named for this account at sign-in (OAuth only). */
  plan?: string
}

/** State of the device-authorization sign-in flow, as the card renders it. */
export interface OpenDesignLoginFlowDto {
  id: string
  status: 'idle' | 'pending' | 'complete' | 'failed' | 'cancelled'
  /** Short code the user confirms at the activation URL. */
  userCode: string
  /** The console's activation page, opened by the card itself. */
  verificationUri: string
  /** Unix milliseconds the device authorization expires. */
  expiresAt: number
  /** Seconds between polls, as the service asked. */
  intervalSeconds: number
  error: string
  /** Account label once the flow completes. */
  accountAlias: string
}

/**
 * One account's plan and credit state, as `/billing/summary` states it.
 *
 * This is where the paid tier actually lives. The device-authorization user
 * object carries a `plan` field too, but it answers `free` for a subscribed
 * account and never updates after sign-in, so it is a profile flag and not the
 * tier. Credits keep the service's own spelling; USD figures are the readable
 * companions the service ships beside them.
 */
export interface OpenDesignBillingDto {
  /** Paid tier: `go`, `plus`, `pro` or `max` as the service names it. */
  plan: string
  /** `active`, `trialing`, `canceled`, … as served. */
  status: string
  entitlementStatus: string
  billingInterval: string
  periodStart: string | null
  periodEnd: string | null
  subscriptionCredits: string | null
  rechargeCredits: string | null
  totalAvailableCredits: string | null
  subscriptionCreditsUsd: string | null
  rechargeCreditsUsd: string | null
  totalAvailableCreditsUsd: string | null
  totalConsumedUsd: string | null
  todayConsumedUsd: string | null
  usageCount: number | null
  updatedAt: string | null
}

/**
 * One window of the Design Plan, as the coding-plan endpoint states it.
 *
 * Amounts are integer credit STRINGS (`remainingCredits` / `limitCredits`), the
 * service's own spelling: the card derives a used share from the two, so both
 * have to survive the trip verbatim. `durationSeconds` is what names the window
 * — 18000 is the 5-hour one, 604800 the 7-day one — and the wording for those
 * belongs to the card, not to this contract.
 */
export interface OpenDesignCodingPlanWindowDto {
  /** The window's own policy id, as served. */
  policyId: string
  /** Nominal window length in SECONDS. */
  durationSeconds: number
  /** Credits the window still has (integer string). */
  remainingCredits: string
  /** Credits the window is granted (integer string, always positive). */
  limitCredits: string
  /** ISO instant the window reopens, when the service stated one. */
  resetsAt: string | null
}

/**
 * One account's Design Plan allowance: the real, bounded windows.
 *
 * `error` is the honest half of this contract. The endpoint is unknown to a
 * control-key Bearer (the console calls it with a browser session), so a read
 * can legitimately fail; when it does, `tier` is null, `windows` is empty and
 * `error` says why. Nothing here is ever backfilled with a zero: an empty window
 * list means "nobody measured a window", never "0 % used".
 */
export interface OpenDesignCodingPlanDto {
  /** Paid tier of the workspace: `go` / `plus` / `pro` / `max`, else null. */
  tier: string | null
  /** The windows that survived validation; empty when none could be read. */
  windows: OpenDesignCodingPlanWindowDto[]
  /** Why the plan could not be read; the empty string when it was. */
  error: string
}

/** One account's latest wallet + billing reading (OAuth accounts only). */
export interface OpenDesignUsageAccountDto {
  accountId: string
  alias: string
  ok: boolean
  /**
   * Current wallet balance in USD, exactly as the service strings it. Null when
   * unread or unreadable — a failed read is not a zero balance. When the wallet
   * read fails but the billing summary succeeds, this carries the summary's own
   * total-available figure so the card still states what is left.
   */
  balanceUsd: string | null
  /** ISO instant the service stamped on the reading, when it sent one. */
  updatedAt: string | null
  error: string
  fetchedAt: number
  /** Plan + credits, absent when the billing read failed or named no tier. */
  billing?: OpenDesignBillingDto
  /**
   * The Design Plan's 5-hour / 7-day windows, or the reason there are none.
   *
   * Present whenever the account carried a control key, including on failure —
   * that is the point: a card has to be able to say "the plan could not be read"
   * instead of drawing an empty frame. It never makes the reading itself fail: a
   * coding-plan refusal says nothing about the wallet beside it.
   */
  codingPlan?: OpenDesignCodingPlanDto
}

/** Latest wallet snapshot, one entry per account read. Never a live call. */
export interface OpenDesignUsageDto {
  accounts: OpenDesignUsageAccountDto[]
  fetchedAt: number
}

export interface OpenDesignPoolStatusDto {
  accounts: OpenDesignAccountSummaryDto[]
  activeAccountId?: string
  rotationStrategy: AccountRotationStrategy
}

/** The line-level knobs the advanced block edits. */
export interface OpenDesignSettingsDto {
  baseURL: string
  defaultContextWindow: number
  defaultMaxTokens: number
  maxConcurrentRequests: number
  streamIdleTimeoutMs: number
}

/** A settings patch; only the keys present change. */
export interface OpenDesignSettingsUpdateDto {
  enabled?: boolean
  baseURL?: string
  defaultContextWindow?: number
  defaultMaxTokens?: number
  maxConcurrentRequests?: number
  streamIdleTimeoutMs?: number
}

/** Everything the settings card renders for the OpenDesign tab. */
export interface OpenDesignWebStatus {
  /** Whether the line serves its route and appears in the picker at all. */
  enabled: boolean
  providerId: string
  baseURL: string
  /** Whether this plugin currently owns the route. */
  serving: boolean
  /** Why another adapter owns the route, or null while this plugin owns it. */
  conflict: string | null
  /** Whether at least one account can currently serve a request. */
  usable: boolean
  /** Alias of `usable`, named for the shared composer/badge contract. */
  authenticated: boolean
  pool: OpenDesignPoolStatusDto
  models: OpenDesignModelDto[]
  /** Distinct from an empty catalog: 'never synced' and 'synced, empty' differ. */
  catalogSynced: boolean
  catalogCount: number
  /** Latest wallet readings, one per account read; null before the first read. */
  usage: OpenDesignUsageDto | null
  /** Latest device-authorization flow in this process, or null when none ran. */
  login: OpenDesignLoginFlowDto | null
  settings: OpenDesignSettingsDto
}

/** Outcome of checking one API key against the gateway's catalog endpoint. */
export interface OpenDesignAuthResult {
  ok: boolean
  authorized: boolean
  ms: number
  error: string
  /** How many models the key may list; the proof that it works. */
  modelCount: number
}

/** Actions the accounts endpoint accepts. */
export type OpenDesignAccountAction =
  | 'add'
  | 'test'
  | 'set-primary'
  | 'set-alias'
  | 'delete'
  | 'clear-cooldown'
  | 'strategy'

/** Re-export so the line's consumers read one module. */
export type { AccountPoolStatusDto }
