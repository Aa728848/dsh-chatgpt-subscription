/** Shared retry/rotation decision shape; provider wording stays provider-owned. */
export interface ProviderFailureClassification {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  /** Whether another account may serve the same request. */
  readonly accountScoped: boolean
  /** A shared upstream condition must not cool or rotate an account. */
  readonly upstreamOverload?: boolean
}

/** Clamp a measured reset delay without parking an account forever or reopening at once. */
export function cooldownFromReset(input: {
  readonly resetAtMs?: number | null
  readonly now?: number
  readonly fallbackMs: number
  readonly minimumMs?: number
  readonly maximumMs?: number
}): number {
  const now = input.now ?? Date.now()
  const minimum = input.minimumMs ?? 0
  const maximum = input.maximumMs ?? Number.MAX_SAFE_INTEGER
  if (input.resetAtMs === undefined || input.resetAtMs === null || !Number.isFinite(input.resetAtMs)) {
    return Math.min(maximum, Math.max(minimum, input.fallbackMs))
  }
  if (input.resetAtMs <= now) return Math.min(maximum, Math.max(minimum, input.fallbackMs))
  return Math.min(maximum, Math.max(minimum, input.resetAtMs - now))
}

/** Nested refresh loops must not multiply the outer request retry budget. */
export const SINGLE_REFRESH_ATTEMPT = 1
