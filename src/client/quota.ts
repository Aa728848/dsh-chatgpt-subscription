import type { QuotaBucketDto, QuotaStatusDto, QuotaWindowDto } from '../shared/contracts.ts'

export interface SelectedQuotaWindow {
  bucket: QuotaBucketDto
  window: QuotaWindowDto
  remainingPercent: number
}

export function selectQuotaForModel(quota: QuotaStatusDto | undefined, modelId: string | undefined): SelectedQuotaWindow | null {
  if (quota === undefined || quota.buckets.length === 0) return null
  const model = modelId?.toLowerCase() ?? ''
  const wantsSpark = model.includes('spark')
  const bucket = wantsSpark
    ? quota.buckets.find(candidate => `${candidate.id} ${candidate.name}`.toLowerCase().includes('spark'))
    : quota.buckets.find(candidate => candidate.id === 'codex')
      ?? quota.buckets.find(candidate => candidate.name.toLowerCase() === 'codex')
  if (bucket === undefined) return null
  const windows = quotaWindows(bucket)
  if (windows.length === 0) return null
  // 优先选取 5h 等短周期额度（按 windowDurationMins 升序排序），没有短周期时选取周额度
  const sorted = [...windows].sort((a, b) => {
    const durA = a.windowDurationMins ?? Infinity
    const durB = b.windowDurationMins ?? Infinity
    return durA - durB
  })
  const window = sorted[0]!
  return {
    bucket,
    window,
    remainingPercent: Math.max(0, 100 - window.usedPercent),
  }
}

export function quotaWindows(bucket: QuotaBucketDto): QuotaWindowDto[] {
  if (bucket.windows.length > 0) return bucket.windows
  return [bucket.primary, bucket.secondary].filter((window): window is QuotaWindowDto => window !== null)
}
