import type { RelayOneQuotaDto } from '../../../shared/relayone-contracts.ts'

export function relayOneQuotaAmount(value: number | null, quotaPerUnit: number | null): string | null {
  if (value === null) return null
  if (quotaPerUnit === null || quotaPerUnit <= 0) return String(value)
  const usd = value / quotaPerUnit
  const digits = Math.abs(usd) >= 100 ? 2 : Math.abs(usd) >= 1 ? 3 : 4
  return '$' + usd.toFixed(digits)
}
export function relayOneQuotaIsUnlimited(quota: RelayOneQuotaDto): boolean {
  // The reader only stores a null balance on a successful unlimited-key snapshot.
  return quota.state === 'unlimited' || (quota.state === 'stale' && quota.fetchedAt !== null && quota.totalAvailable === null)
}
export function relayOneQuotaText(quota: RelayOneQuotaDto): string | null {
  if (relayOneQuotaIsUnlimited(quota)) return '∞'
  if (quota.state !== 'ready' && quota.state !== 'stale') return null
  if (quota.totalAvailable === null) return null
  if (quota.remainingPercent !== null) return Math.round(quota.remainingPercent) + '%'
  return relayOneQuotaAmount(quota.totalAvailable, quota.quotaPerUnit)
}
export function relayOneQuotaAccountText(quota: RelayOneQuotaDto): string | null {
  const text = relayOneQuotaText(quota)
  if (text === null) return null
  if (relayOneQuotaIsUnlimited(quota)) return text
  const amount = relayOneQuotaAmount(quota.totalAvailable, quota.quotaPerUnit)
  return amount !== null && amount !== text ? text + ' · ' + amount : text
}
