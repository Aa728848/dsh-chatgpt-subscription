import {
  CODEX_USAGE_URL,
  QUOTA_CACHE_MS,
  QUOTA_MIN_UPSTREAM_INTERVAL_MS,
} from '../compat.ts'
import type {
  ConnectionTestDto,
  PublicErrorDto,
  QuotaBucketDto,
  QuotaUsageDto,
  QuotaStatusDto,
  QuotaWindowDto,
} from '../shared/contracts.ts'
import { OAuthService } from './oauth-service.ts'
import { codexHeaders, retryAfterMs } from './wire-auth.ts'
import type { StoredOAuthCredentials } from './token-store.ts'

type FetchLike = typeof fetch

interface CacheEntry {
  usage: QuotaUsageDto
  fetchedAt: number
  accountKey: string
}

const EMPTY_USAGE: QuotaUsageDto = {
  buckets: [],
  credits: null,
  individualLimit: null,
  spendControlReached: null,
  resetCredits: null,
}

export interface UsageServiceOptions {
  fetchFn?: FetchLike
  now?: () => number
}

export class UsageService {
  private readonly fetchFn: FetchLike
  private readonly now: () => number
  private cache: CacheEntry | null = null
  private lastUpstreamAt = 0
  private blockedUntil = 0
  private invalidated = false
  private inFlight: Promise<QuotaStatusDto> | null = null

  constructor(private readonly oauth: OAuthService, options: UsageServiceOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch
    this.now = options.now ?? Date.now
  }

  async status(authenticated: boolean, force = false): Promise<QuotaStatusDto> {
    if (!authenticated) return { state: 'signed-out', ...EMPTY_USAGE, fetchedAt: null, stale: false }
    const now = this.now()
    let credentials: StoredOAuthCredentials
    try {
      credentials = await this.oauth.credentials()
    } catch {
      return this.failure({ code: 'quota-failed', message: 'ChatGPT credentials could not be refreshed.' })
    }
    const accountKey = identityKey(credentials)
    if (this.cache !== null && this.cache.accountKey !== accountKey) this.clear()
    if (!force && !this.invalidated && this.cache !== null && now - this.cache.fetchedAt < QUOTA_CACHE_MS) {
      return this.fromCache(false)
    }
    if (this.cache !== null && now - this.lastUpstreamAt < QUOTA_MIN_UPSTREAM_INTERVAL_MS) {
      return this.fromCache(this.invalidated || now - this.cache.fetchedAt >= QUOTA_CACHE_MS)
    }
    if (now < this.blockedUntil) {
      return this.failure({ code: 'rate-limited', message: 'Quota refresh is temporarily rate limited.' })
    }
    if (this.inFlight !== null) return this.inFlight
    this.inFlight = this.refreshUpstream(credentials, accountKey).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  invalidate(): void {
    this.invalidated = true
  }

  clear(): void {
    this.cache = null
    this.blockedUntil = 0
    this.invalidated = false
  }

  async testConnection(): Promise<ConnectionTestDto> {
    const started = this.now()
    const result = await this.status(true, true)
    if (result.state === 'error' || result.error !== undefined) {
      throw new UsageServiceError(result.error ?? { code: 'connection-failed', message: 'Codex connection test failed.' })
    }
    return { connected: true, latencyMs: Math.max(0, this.now() - started), checkedAt: Math.floor(this.now() / 1000) }
  }

  private async refreshUpstream(initialCredentials: StoredOAuthCredentials, initialAccountKey: string): Promise<QuotaStatusDto> {
    this.lastUpstreamAt = this.now()
    try {
      let credentials = initialCredentials
      let accountKey = initialAccountKey
      let response = await this.fetch(credentials)
      if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined)
        credentials = await this.oauth.credentials(true)
        accountKey = identityKey(credentials)
        response = await this.fetch(credentials)
      }
      if (response.status === 429) {
        const delay = retryAfterMs(response.headers) ?? QUOTA_MIN_UPSTREAM_INTERVAL_MS
        this.blockedUntil = this.now() + Math.max(QUOTA_MIN_UPSTREAM_INTERVAL_MS, delay)
        await response.body?.cancel().catch(() => undefined)
        return this.failure({ code: 'rate-limited', message: 'Quota refresh was rate limited. Existing data was kept.' })
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        return this.failure({ code: 'quota-failed', message: `Quota request failed (${response.status}).` })
      }
      const data = await response.json() as unknown
      const usage = parseCodexUsage(data)
      this.cache = { usage, fetchedAt: this.now(), accountKey }
      this.invalidated = false
      return this.fromCache(false)
    } catch (error) {
      const publicError = error instanceof UsageServiceError
        ? error.publicError
        : { code: 'quota-failed' as const, message: 'Quota information could not be refreshed.' }
      return this.failure(publicError)
    }
  }

  private fetch(credentials: Awaited<ReturnType<OAuthService['credentials']>>): Promise<Response> {
    return this.fetchFn(CODEX_USAGE_URL, {
      headers: { ...codexHeaders(credentials), accept: 'application/json' },
    })
  }

  private fromCache(stale: boolean, error?: PublicErrorDto): QuotaStatusDto {
    if (this.cache === null) return {
      state: error ? 'error' : 'empty',
      ...EMPTY_USAGE,
      fetchedAt: null,
      stale,
      ...(error ? { error } : {}),
    }
    return {
      state: error ? 'stale' : this.cache.usage.buckets.length > 0 ? 'ready' : 'empty',
      ...structuredClone(this.cache.usage),
      fetchedAt: Math.floor(this.cache.fetchedAt / 1000),
      stale,
      ...(error ? { error } : {}),
    }
  }

  private failure(error: PublicErrorDto): QuotaStatusDto {
    return this.fromCache(this.cache !== null, error)
  }
}

export class UsageServiceError extends Error {
  constructor(readonly publicError: PublicErrorDto) {
    super(publicError.message)
  }
}

export function mapCodexUsage(value: unknown): QuotaBucketDto[] {
  return parseCodexUsage(value).buckets
}

export function parseCodexUsage(value: unknown): QuotaUsageDto {
  const data = record(value)
  if (data === null) return structuredClone(EMPTY_USAGE)
  const planType = typeof data.plan_type === 'string' ? data.plan_type : null
  const buckets: QuotaBucketDto[] = []
  const usedIds = new Set<string>()
  addBucket(buckets, usedIds, 'codex', 'Codex', planType, data.rate_limit)
  addBucket(buckets, usedIds, 'code-review', 'Code review', planType, data.code_review_rate_limit)
  const additional = Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : []
  for (const [index, value] of additional.entries()) {
    const limit = record(value)
    if (limit === null) continue
    const idSource = text(limit.limit_name) ?? text(limit.metered_feature) ?? `additional-${index + 1}`
    const id = uniqueId(slug(idSource), usedIds)
    const name = readableLimitName(text(limit.limit_name) ?? text(limit.metered_feature) ?? idSource)
    addBucket(buckets, usedIds, id, name, planType, limit.rate_limit)
  }
  return {
    buckets,
    credits: mapCredits(data.credits),
    individualLimit: mapIndividualLimit(record(data.spend_control)?.individual_limit),
    spendControlReached: boolean(record(data.spend_control)?.reached),
    resetCredits: mapResetCredits(data.rate_limit_reset_credits),
  }
}

function addBucket(
  result: QuotaBucketDto[],
  usedIds: Set<string>,
  id: string,
  name: string,
  planType: string | null,
  value: unknown,
): void {
  const source = record(value)
  if (source === null) return
  const primary = mapWindow(source.primary_window)
  const secondary = mapWindow(source.secondary_window)
  if (primary === null && secondary === null) return
  result.push({ id, name, planType, primary, secondary, windows: [primary, secondary].filter(isWindow) })
  usedIds.add(id)
}

function mapWindow(value: unknown): QuotaWindowDto | null {
  const data = record(value)
  if (data === null) return null
  const used = numeric(data.used_percent)
  if (used === undefined) return null
  const seconds = numeric(data.limit_window_seconds)
  const reset = numeric(data.reset_at)
  return {
    usedPercent: Math.min(100, Math.max(0, used)),
    windowDurationMins: seconds !== undefined && seconds > 0 ? seconds / 60 : null,
    resetsAt: reset !== undefined && reset > 0 ? reset : null,
  }
}

function mapCredits(value: unknown): QuotaUsageDto['credits'] {
  const data = record(value)
  if (data === null) return null
  const hasCredits = boolean(data.has_credits)
  const unlimited = boolean(data.unlimited)
  const balance = decimalText(data.balance)
  if (hasCredits === null && unlimited === null && balance === null) return null
  return {
    hasCredits: hasCredits ?? (balance !== null || unlimited === true),
    unlimited: unlimited ?? false,
    balance,
  }
}

function mapIndividualLimit(value: unknown): QuotaUsageDto['individualLimit'] {
  const data = record(value)
  if (data === null) return null
  const remaining = numeric(data.remaining_percent)
  const reset = numeric(data.reset_at)
  const limit = decimalText(data.limit)
  const used = decimalText(data.used)
  if (remaining === undefined && reset === undefined && limit === null && used === null) return null
  return {
    limit,
    used,
    remainingPercent: remaining !== undefined ? Math.min(100, Math.max(0, remaining)) : null,
    resetsAt: reset !== undefined && reset > 0 ? reset : null,
  }
}

function mapResetCredits(value: unknown): QuotaUsageDto['resetCredits'] {
  const data = record(value)
  if (data === null) return null
  const available = numeric(data.available_count)
  if (available === undefined) return null
  return { availableCount: Math.max(0, Math.floor(available)) }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function boolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function numeric(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function decimalText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed !== '' ? trimmed : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function slug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
  return normalized || 'additional'
}

function uniqueId(base: string, usedIds: Set<string>): string {
  let candidate = base
  let suffix = 2
  while (usedIds.has(candidate)) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  return candidate
}

function readableLimitName(value: string): string {
  return value
    .replace(/^codex[_-]/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, match => match.toUpperCase()) || 'Additional limit'
}

function isWindow(value: QuotaWindowDto | null): value is QuotaWindowDto {
  return value !== null
}

function identityKey(credentials: StoredOAuthCredentials): string {
  return credentials.accountId ?? credentials.email ?? credentials.planType ?? 'signed-in'
}
