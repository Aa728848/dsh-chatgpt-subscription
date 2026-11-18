import type { RelayOneQuotaDto } from '../../shared/relayone-contracts.ts'
import { relayOneCredentialFingerprint, type RelayOneCredentialStore } from './token-store.ts'
import { RELAYONE_ORIGIN, relayOneHeaders, relayOneSafeDetail } from './types.ts'

export const RELAYONE_TOKEN_USAGE_URL = RELAYONE_ORIGIN + '/api/usage/token'
export const RELAYONE_STATUS_URL = RELAYONE_ORIGIN + '/api/status'
export const RELAYONE_QUOTA_TTL_MS = 60_000

export function idleRelayOneQuota(): RelayOneQuotaDto {
  return {
    state: 'idle', totalGranted: null, totalUsed: null, totalAvailable: null,
    remainingPercent: null, quotaPerUnit: null, expiresAt: null, fetchedAt: null, error: null,
  }
}
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
function percentage(available: number | null, granted: number | null): number | null {
  if (available === null || granted === null || granted <= 0) return null
  return Math.max(0, Math.min(100, available / granted * 100))
}

export interface RelayOneQuotaOptions {
  fetchFn?: typeof fetch
  ttlMs?: number
  now?: () => number
}

/** Credential-scoped New API token quota with a 60-second single-flight cache. */
export class RelayOneQuotaReader {
  private readonly fetchFn: typeof fetch
  private readonly ttlMs: number
  private readonly now: () => number
  private value = idleRelayOneQuota()
  private scope: string | null = null
  private refreshing: Promise<void> | null = null
  private epoch = 0

  constructor(private readonly store: RelayOneCredentialStore, options: RelayOneQuotaOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch
    this.ttlMs = options.ttlMs ?? RELAYONE_QUOTA_TTL_MS
    this.now = options.now ?? Date.now
  }
  snapshot(): RelayOneQuotaDto { return this.value }
  reset(): void {
    this.epoch += 1
    this.scope = null
    this.value = idleRelayOneQuota()
    this.refreshing = null
  }
  startRefresh(force = false): void { void this.refresh(force).catch(() => undefined) }

  async refresh(force = false): Promise<void> {
    const credentials = await this.store.read().catch(() => null)
    if (credentials === null) { this.reset(); return }
    const nextScope = relayOneCredentialFingerprint(credentials)
    if (this.scope !== null && this.scope !== nextScope) {
      this.epoch += 1
      this.value = idleRelayOneQuota()
      this.refreshing = null
    }
    this.scope = nextScope
    const epoch = this.epoch
    if (!force && this.value.fetchedAt !== null && this.now() - this.value.fetchedAt < this.ttlMs) return
    if (this.refreshing !== null) return this.refreshing
    const pending = (async () => {
      try {
        const [usageResponse, statusResponse] = await Promise.all([
          this.fetchFn(RELAYONE_TOKEN_USAGE_URL, { headers: relayOneHeaders(credentials.apiKey, false) }),
          this.fetchFn(RELAYONE_STATUS_URL, { headers: { accept: 'application/json', 'user-agent': 'dsh-chatgpt-subscription' } }),
        ])
        if (!usageResponse.ok) throw new Error('RelayOne token usage query failed (' + usageResponse.status + ').')
        const usage = await usageResponse.json() as unknown
        const root = record(usage)
        const data = record(root?.data)
        if (root?.code === false || root?.success === false || data === null) {
          throw new Error(typeof root?.message === 'string' ? root.message : 'RelayOne token usage payload is invalid.')
        }
        const granted = finite(data.total_granted)
        const used = finite(data.total_used)
        const tokenAvailable = finite(data.total_available)
        const unlimitedToken = data.unlimited_quota === true
        if (tokenAvailable === null && !unlimitedToken) throw new Error('RelayOne token usage omitted total_available.')
        const userAvailable = finite(record(data.user_quota)?.total_available)
        const unlimited = unlimitedToken && userAvailable === null
        const available = unlimited ? null : unlimitedToken
          ? userAvailable
          : Math.min(tokenAvailable ?? Number.POSITIVE_INFINITY, userAvailable ?? Number.POSITIVE_INFINITY)
        if (available !== null && !Number.isFinite(available)) throw new Error('RelayOne returned no finite effective quota.')
        let quotaPerUnit: number | null = null
        if (statusResponse.ok) {
          const status = await statusResponse.json().catch(() => undefined) as unknown
          const candidate = finite(record(record(status)?.data)?.quota_per_unit)
          quotaPerUnit = candidate !== null && candidate > 0 ? candidate : null
        } else await statusResponse.body?.cancel().catch(() => undefined)
        if (epoch !== this.epoch || this.scope !== nextScope) return
        this.value = {
          state: unlimited ? 'unlimited' : 'ready',
          totalGranted: granted,
          totalUsed: used,
          totalAvailable: available,
          remainingPercent: unlimitedToken ? null : percentage(available, granted),
          quotaPerUnit,
          expiresAt: finite(data.expires_at) !== null && finite(data.expires_at)! > 0 ? finite(data.expires_at)! * 1000 : null,
          fetchedAt: this.now(),
          error: null,
        }
      } catch (error) {
        if (epoch !== this.epoch || this.scope !== nextScope) return
        this.value = {
          ...this.value,
          state: this.value.fetchedAt === null ? 'error' : 'stale',
          error: relayOneSafeDetail(error, credentials.apiKey),
        }
      }
    })()
    const wrapped = pending.finally(() => { if (this.refreshing === wrapped) this.refreshing = null })
    this.refreshing = wrapped
    return wrapped
  }
}
