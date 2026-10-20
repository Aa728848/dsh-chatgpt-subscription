import type {
  AccountPoolStatusDto,
  AccountRotationStrategy,
  PoolAccountSummaryDto,
} from './account-pool-contracts.ts'

/**
 * Wire contracts for the Cline Pass line's settings API.
 *
 * The line is API-key based: there is no OAuth flow, no token expiry, and no
 * per-account identity beyond the key and the alias a user gives it. What the
 * card does render beyond the shared account facts is the routing observation
 * this plugin makes about each model (pipeline, discovered channels, per-channel
 * verdicts) and the per-model pin the user stores. None of it is a credential.
 */

export const CLINE_PASS_PROVIDER_ID = 'cline-pass'
export const CLINE_PASS_PROVIDER_NAME = 'Cline Pass'
export const CLINE_PASS_ROUTE_PREFIX = '/cline-pass/api'

/** Authentication UI surface for this line: a pasted static key. */
export type ClinePassPinMode = 'strict' | 'preferred'

/** One channel availability verdict, as the card renders it. */
export interface ClinePassChannelVerdictDto {
  upstream: string
  /** `ok` answered, `limited` refused with a rate limit, `bad` refused the pin,
   * `auth` rejected the key, `not-adopted` answered from another channel,
   * `unknown` could not be judged. */
  status: 'ok' | 'limited' | 'bad' | 'auth' | 'not-adopted' | 'unknown'
  ms: number
  note: string
  /** Unix milliseconds the verdict was recorded. */
  checkedAt: number
}

/** One model as the card renders it: published facts plus live observations. */
export interface ClinePassModelDto {
  id: string
  name: string
  contextWindow: number
  /** The published/default window, before the user's override. */
  defaultContextWindow: number
  maxTokens: number
  reasoning: boolean
  input: string[]
  /** Whether the route advertises this model to the picker. */
  enabled: boolean
  /** `direct` (OpenRouter spelling) or `planner` (Vercel AI Gateway), once probed. */
  pipeline: string
  pinnable: boolean
  /** Ordered pin as stored, primary first. Empty means automatic routing. */
  pinned: string[]
  excluded: string[]
  pinMode: ClinePassPinMode
  sort: string
  /** Discovered channels, highest confidence first. */
  upstreams: string[]
  upstreamStatus: ClinePassChannelVerdictDto[]
  lastProvider: string
  lastMs: number
  probedAt: number
  validatedAt: number
  /** Stored context-window override, absent when the published window applies. */
  contextWindowOverride?: number
}

/** One account's official quota windows, read from Cline Pass itself. */
export interface ClinePassUsageWindowDto {
  /** Gateway spelling: `five_hour`, `weekly`, `monthly`. */
  type: string
  label: string
  percentUsed: number
  /** ISO instant the window resets, as the gateway sent it; empty when absent. */
  resetsAt: string
}

/** One account's latest quota reading. */
export interface ClinePassUsageAccountDto {
  accountId: string
  alias: string
  ok: boolean
  windows: ClinePassUsageWindowDto[]
  error: string
  fetchedAt: number
}

/** Latest quota snapshot, one entry per enabled account. Never a live call. */
export interface ClinePassUsageDto {
  accounts: ClinePassUsageAccountDto[]
  fetchedAt: number
}

/** One pooled key as the shared account card renders it. Never carries the key. */
export type ClinePassAccountSummaryDto = PoolAccountSummaryDto

export interface ClinePassPoolStatusDto {
  accounts: ClinePassAccountSummaryDto[]
  activeAccountId?: string
  rotationStrategy: AccountRotationStrategy
}

/** Everything the settings card renders for the Cline Pass tab. */
export interface ClinePassWebStatus {
  /** Whether the line serves its route and appears in the picker at all. */
  enabled: boolean
  providerId: string
  baseURL: string
  /** Whether this plugin currently owns the route. */
  serving: boolean
  /** Why another adapter owns the route, or null while this plugin owns it. */
  conflict: string | null
  /** Whether the `cline_pass_*` management tools are registered (needs restart). */
  exposeTools: boolean
  /** Whether at least one account can currently serve a request. */
  usable: boolean
  /** Alias of `usable`, named for the shared composer badge's contract. */
  authenticated: boolean
  pool: ClinePassPoolStatusDto
  models: ClinePassModelDto[]
  /** Distinct from an empty catalog: 'never synced' and 'synced, empty' differ. */
  catalogSynced: boolean
  catalogCount: number
  usage: ClinePassUsageDto | null
  historySize: number
  settings: ClinePassSettingsDto
}

/** The line-level knobs the advanced block edits. */
export interface ClinePassSettingsDto {
  baseURL: string
  defaultContextWindow: number
  defaultMaxTokens: number
  maxConcurrentRequests: number
  streamIdleTimeoutMs: number
  historyLimit: number
  exposeCatalog: boolean
  pinSpelling: string
}

/** A settings patch; only the keys present change. */
export interface ClinePassSettingsUpdateDto {
  enabled?: boolean
  baseURL?: string
  defaultContextWindow?: number
  defaultMaxTokens?: number
  maxConcurrentRequests?: number
  streamIdleTimeoutMs?: number
  historyLimit?: number
  exposeCatalog?: boolean
  pinSpelling?: string
  exposeTools?: boolean
}

/** Outcome of probing one model's routing pipeline and channel list. */
export interface ClinePassProbeResultDto {
  ok: boolean
  model: string
  error: string
  ms: number
  pipeline: string
  pinnable: boolean
  canonicalSlug: string
  lastProvider: string
  upstreams: string[]
  availableProviders: string[]
  tier0: string[]
}

/** Outcome of testing every known channel of one model. */
export interface ClinePassValidateResultDto {
  ok: boolean
  model: string
  error: string
  summary: { ok: number; limited: number; bad: number; auth: number; unknown: number }
  upstreams: string[]
  results: { upstream: string; status: string; ms: number; note: string }[]
}

/** One failover attempt, as the test result reports it. */
export interface ClinePassAttemptTraceDto {
  upstream: string
  status: number
  ms: number
  note: string
}

/** Outcome of one small real request sent through a pin. */
export interface ClinePassTestResultDto {
  ok: boolean
  model: string
  error: string
  ms: number
  targets: string[]
  excluded: string[]
  actual: string
  actualName: string
  pipeline: string
  pinnable: boolean
  canonicalSlug: string
  account: string
  content: string
  adopted: boolean
  adherence: string
  plan: string
  warnings: string[]
  trace: ClinePassAttemptTraceDto[]
}

/** One row of the in-process request history. */
export interface ClinePassHistoryRowDto {
  ts: number
  model: string
  provider: string
  canonical: string
  account: string
  ms: number
  ttfb: number
  ttft: number
  stream: boolean
  effort: string
  usageReported: boolean
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    reasoningTokens: number
  }
  error: string
  attempts: string[]
  adherence: string
  warnings: string[]
}

/** Outcome of checking one API key with a single small request. */
export interface ClinePassAuthResult {
  ok: boolean
  authorized: boolean
  ms: number
  error: string
}

/** Actions the accounts endpoint accepts. */
export type ClinePassAccountAction =
  | 'add'
  | 'test'
  | 'set-primary'
  | 'set-alias'
  | 'delete'
  | 'clear-cooldown'
  | 'strategy'

/** Whether a submitted pin mode names one of the two accepted modes. */
export function isClinePassPinMode(value: unknown): value is ClinePassPinMode {
  return value === 'strict' || value === 'preferred'
}

/** Human label for the gateway's quota-window spelling. */
export function clinePassWindowLabel(type: string): string {
  switch (type) {
    case 'five_hour': return '5 小时'
    case 'weekly': return '每周'
    case 'monthly': return '每月'
    default: return type
  }
}
