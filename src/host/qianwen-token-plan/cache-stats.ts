import type { QianwenCacheStatsDto } from '../../shared/qianwen-token-plan-contracts.ts'

export interface QianwenCacheUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
  reasoningTokens: number
  encryptedReplays: number
  missingEncryptedContent: number
}

const zero = (): QianwenCacheStatsDto => ({
  requests: 0,
  missedInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  encryptedReplays: 0,
  missingEncryptedContent: 0,
})
let totals = zero()
const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

export function recordQianwenCacheUsage(usage: QianwenCacheUsage): void {
  totals = {
    requests: totals.requests + 1,
    missedInputTokens: totals.missedInputTokens + count(usage.inputTokens),
    cacheReadTokens: totals.cacheReadTokens + count(usage.cacheReadTokens),
    cacheWriteTokens: totals.cacheWriteTokens + count(usage.cacheWriteTokens),
    cacheWrite5mTokens: totals.cacheWrite5mTokens + count(usage.cacheWrite5mTokens),
    cacheWrite1hTokens: totals.cacheWrite1hTokens + count(usage.cacheWrite1hTokens),
    outputTokens: totals.outputTokens + count(usage.outputTokens),
    reasoningTokens: totals.reasoningTokens + count(usage.reasoningTokens),
    encryptedReplays: totals.encryptedReplays + count(usage.encryptedReplays),
    missingEncryptedContent: totals.missingEncryptedContent + count(usage.missingEncryptedContent),
  }
}
export function readQianwenCacheStats(): QianwenCacheStatsDto | undefined {
  return totals.requests === 0 ? undefined : { ...totals }
}
export function resetQianwenCacheStats(): void { totals = zero() }
export function qianwenPromptTokens(usage: Pick<QianwenCacheUsage, 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number {
  return count(usage.inputTokens) + count(usage.cacheReadTokens) + count(usage.cacheWriteTokens)
}
