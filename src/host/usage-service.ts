import {
  CODEX_USAGE_URL,
  QUOTA_CACHE_MS,
  QUOTA_MIN_UPSTREAM_INTERVAL_MS,
} from '../compat.ts'
import type {
  ConnectionTestDto,
  PublicErrorDto,
  QuotaBucketDto,
  QuotaStatusDto,
  QuotaWindowDto,
} from '../shared/contracts.ts'
import { OAuthService } from './oauth-service.ts'
import { codexHeaders, retryAfterMs } from './wire-auth.ts'
import type { StoredOAuthCredentials } from './token-store.ts'

type FetchLike = typeof fetch

interface CacheEntry {
  buckets: QuotaBucketDto[]
  fetchedAt: number
  accountKey: string
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
    if (!authenticated) return { state: 'signed-out', buckets: [], fetchedAt: null, stale: false }
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
      const buckets = mapCodexUsage(data)
      this.cache = { buckets, fetchedAt: this.now(), accountKey }
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
    if (this.cache === null) return { state: error ? 'error' : 'empty', buckets: [], fetchedAt: null, stale, ...(error ? { error } : {}) }
    return {
      state: error ? 'stale' : this.cache.buckets.length > 0 ? 'ready' : 'empty',
      buckets: structuredClone(this.cache.buckets),
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
  const data = record(value)
  if (data === null) return []
  const planType = typeof data.plan_type === 'string' ? data.plan_type : null
  const result: QuotaBucketDto[] = []
  addBucket(result, 'codex', 'Codex', planType, data.rate_limit)
  addBucket(result, 'code-review', 'Code review', planType, data.code_review_rate_limit)
  return result
}

function addBucket(
  result: QuotaBucketDto[],
  id: QuotaBucketDto['id'],
  name: string,
  planType: string | null,
  value: unknown,
): void {
  const source = record(value)
  if (source === null) return
  const primary = mapWindow(source.primary_window)
  const secondary = mapWindow(source.secondary_window)
  if (primary === null && secondary === null) return
  result.push({ id, name, planType, primary, secondary })
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

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function numeric(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function identityKey(credentials: StoredOAuthCredentials): string {
  return credentials.accountId ?? credentials.email ?? credentials.planType ?? 'signed-in'
}
