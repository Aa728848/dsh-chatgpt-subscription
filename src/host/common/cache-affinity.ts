/** Provider-neutral warm-account preference with a quota safety floor. */

export interface AffinityQuotaWindow {
  readonly usedFraction?: number
  readonly usedPercent?: number | null
}

export interface AffinityQuota {
  readonly windows: readonly AffinityQuotaWindow[]
}

export const DEFAULT_AFFINITY_QUOTA_FLOOR_SHARE = 0.2

function clampShare(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** Tightest measured window; unknown remains null rather than pretending full/empty. */
export function remainingQuotaShare(quota: AffinityQuota | null | undefined): number | null {
  if (quota === null || quota === undefined || quota.windows.length === 0) return null
  let tightest: number | null = null
  for (const window of quota.windows) {
    const used = typeof window.usedFraction === 'number'
      ? window.usedFraction
      : typeof window.usedPercent === 'number'
        ? window.usedPercent / 100
        : undefined
    if (used === undefined || !Number.isFinite(used)) continue
    const remaining = clampShare(1 - used)
    tightest = tightest === null ? remaining : Math.min(tightest, remaining)
  }
  return tightest
}

export interface AffinityCandidate {
  readonly id: string
  readonly warm: boolean
}

export interface AffinityOrderInput {
  readonly candidates: readonly AffinityCandidate[]
  readonly remainingShareById?: Readonly<Record<string, number | null | undefined>>
  readonly floorShare?: number
}

/** Warm and sufficiently-funded accounts first; no preference is an empty list. */
export function orderAffinityCandidates(input: AffinityOrderInput): string[] {
  const floor = input.floorShare ?? DEFAULT_AFFINITY_QUOTA_FLOOR_SHARE
  const measured: Array<{ id: string; share: number }> = []
  const unmeasured: string[] = []
  for (const candidate of input.candidates) {
    if (!candidate.warm) continue
    const share = input.remainingShareById?.[candidate.id]
    if (share === null || share === undefined || !Number.isFinite(share)) {
      unmeasured.push(candidate.id)
      continue
    }
    if (share < floor) continue
    measured.push({ id: candidate.id, share })
  }
  measured.sort((left, right) => right.share - left.share)
  return [...measured.map(entry => entry.id), ...unmeasured]
}
