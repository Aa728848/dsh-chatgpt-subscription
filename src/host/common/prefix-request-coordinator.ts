/**
 * Bounded coordination for requests that share an upstream prefix cache.
 * A missing warm TTL still permits in-flight de-duplication, but never claims
 * that a completed request left the service warm.
 */

export interface PrefixRequestLease {
  readonly leader: boolean
  release(): void
  markWarm(): void
}

const NOOP_LEASE: PrefixRequestLease = Object.freeze({
  leader: false,
  release: () => undefined,
  markWarm: () => undefined,
})

interface LeaderEntry {
  readonly promise: Promise<void>
  readonly startedAt: number
  readonly release: () => void
}

export interface PrefixRequestCoordinatorOptions {
  readonly waitMs?: number
  readonly maxGroups?: number
  readonly now?: () => number
}

export class PrefixRequestCoordinator {
  private readonly leaders = new Map<string, LeaderEntry>()
  private readonly bursts = new Map<string, LeaderEntry>()
  private readonly mainHeaders = new Map<string, LeaderEntry>()
  private readonly warm = new Map<string, number>()
  private readonly waitMs: number
  private readonly maxGroups: number
  private readonly now: () => number

  constructor(options: PrefixRequestCoordinatorOptions = {}) {
    this.waitMs = options.waitMs ?? 2_500
    this.maxGroups = options.maxGroups ?? 256
    this.now = options.now ?? Date.now
  }

  /** Join or lead one cold prefix group. */
  async acquire(groupKey: string | undefined, signal: AbortSignal, warmTtlMs?: number): Promise<PrefixRequestLease> {
    if (groupKey === undefined || groupKey === '') return NOOP_LEASE
    if (warmTtlMs !== undefined && this.isWarm(groupKey, warmTtlMs)) return NOOP_LEASE
    const existing = this.leaders.get(groupKey)
    if (existing !== undefined && this.now() - existing.startedAt < this.waitMs) {
      await this.race(existing.promise, signal)
      return NOOP_LEASE
    }
    if (existing !== undefined) existing.release()
    return this.open(this.leaders, groupKey, warmTtlMs)
  }

  /** Serialize first-turn bursts on one account/model without a warm cache claim. */
  async acquireBurst(key: string, signal: AbortSignal): Promise<PrefixRequestLease> {
    if (key === '') return NOOP_LEASE
    while (true) {
      const existing = this.bursts.get(key)
      if (existing === undefined) break
      await this.race(existing.promise, signal)
      if (signal.aborted) return NOOP_LEASE
      if (this.bursts.get(key) === existing) existing.release()
    }
    return this.open(this.bursts, key)
  }

  /** A main request owns the prefill slot until its response headers arrive. */
  registerMainSession(sessionId: string): PrefixRequestLease {
    if (sessionId.trim() === '') return NOOP_LEASE
    const key = sessionId.trim()
    this.mainHeaders.get(key)?.release()
    return this.open(this.mainHeaders, key)
  }

  /** An auxiliary title request waits briefly for the main request's headers. */
  async waitForMainSession(sessionId: string, signal: AbortSignal): Promise<void> {
    const existing = this.mainHeaders.get(sessionId.trim())
    if (existing !== undefined) await this.race(existing.promise, signal)
  }

  isWarm(groupKey: string, ttlMs: number, at: number = this.now()): boolean {
    const warmedAt = this.warm.get(groupKey)
    return warmedAt !== undefined && Number.isFinite(ttlMs) && ttlMs > 0 && at - warmedAt < ttlMs
  }

  /** Release every waiter and clear all process-local evidence. */
  reset(): void {
    for (const store of [this.leaders, this.bursts, this.mainHeaders]) {
      for (const entry of [...store.values()]) entry.release()
      store.clear()
    }
    this.warm.clear()
  }

  private open(store: Map<string, LeaderEntry>, key: string, warmTtlMs?: number): PrefixRequestLease {
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    let settled = false
    const release = (): void => {
      if (settled) return
      settled = true
      resolve()
      if (store.get(key) === entry) store.delete(key)
    }
    const entry: LeaderEntry = { promise, startedAt: this.now(), release }
    store.set(key, entry)
    return {
      leader: true,
      release,
      markWarm: () => {
        if (warmTtlMs === undefined || !Number.isFinite(warmTtlMs) || warmTtlMs <= 0) return
        this.warm.delete(key)
        this.warm.set(key, this.now())
        while (this.warm.size > this.maxGroups) {
          const oldest = this.warm.keys().next()
          if (oldest.done !== true) this.warm.delete(oldest.value)
        }
      },
    }
  }

  /** Wait for a leader, the bounded budget, or caller cancellation; clean every listener. */
  private async race(leader: Promise<void>, signal: AbortSignal): Promise<void> {
    const cleanups: Array<() => void> = []
    const budget = new Promise<void>(resolve => {
      const timer = setTimeout(resolve, this.waitMs)
      timer.unref?.()
      cleanups.push(() => clearTimeout(timer))
    })
    const aborted = new Promise<void>(resolve => {
      if (signal.aborted) {
        resolve()
        return
      }
      const onAbort = (): void => resolve()
      signal.addEventListener('abort', onAbort, { once: true })
      cleanups.push(() => signal.removeEventListener('abort', onAbort))
    })
    await Promise.race([leader, budget, aborted]).finally(() => {
      for (const cleanup of cleanups) cleanup()
    })
  }
}

/** Cheap structural gate for auxiliary calls; provider-specific legacy probes may extend it. */
export function isAuxiliaryRequest(options: { readonly purpose?: unknown }): boolean {
  return options.purpose !== undefined
}

/** Coordinate one fetch through response headers, releasing on every outcome. */
export async function fetchWithPrefixCoordination(
  fetchFn: typeof fetch,
  coordinator: PrefixRequestCoordinator,
  groupKey: string | undefined,
  warmTtlMs: number | undefined,
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const signal = init?.signal
  if (signal == null) {
    const controller = new AbortController()
    const lease = await coordinator.acquire(groupKey, controller.signal, warmTtlMs)
    try {
      const response = await fetchFn(input, init)
      if (response.ok) lease.markWarm()
      return response
    } finally {
      lease.release()
    }
  }
  const lease = await coordinator.acquire(groupKey, signal, warmTtlMs)
  try {
    const response = await fetchFn(input, init)
    if (response.ok) lease.markWarm()
    return response
  } finally {
    lease.release()
  }
}
