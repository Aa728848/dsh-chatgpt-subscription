import type {
  AccountPoolStatusDto,
  AccountRotationStrategy,
  PoolAccountQuotaDto,
  PoolAccountQuotaWindowDto,
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

/**
 * The gateway's anonymous contributor-route label.
 *
 * When Cline routes a model id onto the VMC fallback net, the serving channel
 * reports itself as `openai-compatible-private` and the resolved slug moves
 * under `private/…-contributor`. Answers from it may be used for training and
 * carry no zero-data-retention guarantee, so a pin landing there is a fact the
 * user must see, not a channel like any other.
 */
export const CLINE_PASS_ANONYMOUS_UPSTREAMS: readonly string[] = Object.freeze(['openai-compatible-private'])

/** Whether a channel name or resolved slug names the anonymous contributor route. */
export function isClinePassAnonymousUpstream(name: unknown, canonicalSlug?: unknown): boolean {
  const value = String(name ?? '').toLowerCase()
  if (CLINE_PASS_ANONYMOUS_UPSTREAMS.includes(value)) return true
  const slug = String(canonicalSlug ?? '').toLowerCase()
  return slug.startsWith('private/') || slug.includes('-contributor')
}

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
  /** One-line capability summary built on the host for ModelChecklist. */
  hint?: string
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

/** One pooled account as the shared card renders it. Never carries a secret. */
export interface ClinePassAccountSummaryDto extends PoolAccountSummaryDto {
  /** How this account signed in; absent on a legacy row. */
  authKind?: 'oauth' | 'api-key'
}

/** State of the device-code sign-in flow, as the card renders it. */
export interface ClinePassLoginFlowDto {
  id: string
  status: 'idle' | 'pending' | 'complete' | 'failed' | 'cancelled'
  /** Short code the user enters at `verificationUri`. */
  userCode: string
  verificationUri: string
  /** Unix milliseconds the device code expires. */
  expiresAt: number
  /** Seconds between polls, as WorkOS asked. */
  intervalSeconds: number
  error: string
  /** Account label once the flow completes. */
  accountAlias: string
}

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
  /**
   * Whether a quota refresh is running behind this answer.
   *
   * `usage` above is the cache, not a live read; a client that sees this should
   * read the status again shortly rather than treat the numbers as final.
   */
  quotaRefreshing?: boolean
  historySize: number
  /** Latest device-code flow in this process, or null when none was started. */
  login: ClinePassLoginFlowDto | null
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
  /** First-party DeepSeek fingerprint when the probe's answer carried one. */
  fingerprint: string
  /** Whether the probe's answer was served by the anonymous contributor route. */
  anonymous: boolean
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
  /** First-party DeepSeek fingerprint when the serving answer carried one. */
  fingerprint: string
  /** Whether the serving channel is the anonymous contributor route. */
  anonymous: boolean
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
  /** First-party DeepSeek fingerprint observed on the serving answer, if any. */
  fingerprint: string
  /** Whether the serving channel was the anonymous contributor route. */
  anonymous: boolean
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

/** Window length in minutes for the shared AccountQuota formatter. */
export function clinePassWindowDurationMins(type: string): number | undefined {
  switch (type) {
    case 'five_hour': return 300
    case 'weekly': return 7 * 1440
    case 'monthly': return 30 * 1440
    default: return undefined
  }
}

/**
 * Project one account's Cline Pass usage reading into the shared
 * {@link PoolAccountQuotaDto} shape that AccountPoolSection renders inside the
 * account row. A failed reading returns undefined so the card does not draw
 * fabricated zero bars.
 */
export function clinePassAccountQuota(reading: ClinePassUsageAccountDto | undefined): PoolAccountQuotaDto | undefined {
  if (reading === undefined || !reading.ok) return undefined
  const windows: PoolAccountQuotaWindowDto[] = reading.windows.map((window) => {
    const duration = clinePassWindowDurationMins(window.type)
    const parsedReset = window.resetsAt === '' ? Number.NaN : Date.parse(window.resetsAt)
    const resetsAt = Number.isFinite(parsedReset) && parsedReset > 0 ? parsedReset : null
    return {
      label: window.label || clinePassWindowLabel(window.type),
      usedPercent: window.percentUsed,
      ...(duration === undefined ? {} : { windowDurationMins: duration }),
      resetsAt,
    }
  })
  return {
    fetchedAt: reading.fetchedAt,
    windows,
  }
}
