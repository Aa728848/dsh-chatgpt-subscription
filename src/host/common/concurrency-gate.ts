/**
 * Per-account concurrency gate.
 *
 * A subscription plan bounds how many model requests one account may have in
 * flight, and several plans fail the moment that is exceeded. A multi-agent run
 * reaches that bound by itself — one root agent plus a fan-out of subagents — so
 * the bound has to be held deliberately instead of discovered by having every
 * account 429 at once.
 *
 * The gate is deliberately generic and per-account: it knows nothing about any
 * provider's plan, because a hard-coded number would be a guess about terms this
 * code cannot see. A route that has learned its real limit passes it in; a route
 * that has not passes nothing and behaves exactly as before.
 *
 * @module dsh-chatgpt-subscription/concurrency-gate
 */

/** One holder's place in the queue. */
interface Waiter {
  resolve: () => void
}

export class ConcurrencyGate {
  private readonly held = new Map<string, number>()
  private readonly queues = new Map<string, Waiter[]>()
  private readonly limits = new Map<string, number>()

  /**
   * Record the concurrency limit for one account.
   *
   * A non-positive or non-finite limit clears the cap, which is the same as
   * never having set one: requests then pass through unbounded rather than
   * being blocked by a value nobody verified.
   */
  setLimit(accountId: string, limit: number): void {
    // Existing holders finish normally after a reduction; new requests wait
    // until occupancy falls below the new limit.
    if (!Number.isFinite(limit) || limit <= 0) {
      this.limits.delete(accountId)
      // Anything already queued for a limit that no longer exists is let go.
      this.drain(accountId)
      return
    }
    this.limits.set(accountId, Math.max(1, Math.floor(limit)))
    this.drain(accountId)
  }

  /** Limit currently in force for one account, or undefined when uncapped. */
  limitFor(accountId: string): number | undefined {
    return this.limits.get(accountId)
  }

  /** Requests currently in flight for one account. */
  inFlight(accountId: string): number {
    return this.held.get(accountId) ?? 0
  }

  /**
   * Take one slot, waiting for it when the account is at its limit.
   *
   * The returned function releases the slot and is safe to call more than once:
   * a double release on an aborted request must not hand a stranger a slot that
   * this holder never had.
   */
  async acquire(accountId: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
    const limit = this.limits.get(accountId)
    const current = this.held.get(accountId) ?? 0
    if (limit === undefined || current < limit) return this.take(accountId)

    await new Promise<void>((resolve, reject) => {
      const queue = this.queues.get(accountId) ?? []
      const waiter: Waiter = { resolve: () => {
        remove()
        resolve()
      } }
      const onAbort = (): void => {
        remove()
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
      }
      const remove = (): void => {
        const index = queue.indexOf(waiter)
        if (index !== -1) queue.splice(index, 1)
        if (queue.length === 0) this.queues.delete(accountId)
        signal?.removeEventListener('abort', onAbort)
      }
      queue.push(waiter)
      this.queues.set(accountId, queue)
      signal?.addEventListener('abort', onAbort, { once: true })
    })

    // drain() already counted this grant. Cancellation can arrive between the
    // grant and this continuation, so return that slot before rejecting.
    const release = this.releaseFn(accountId)
    if (signal?.aborted) {
      release()
      throw signal.reason ?? new DOMException('Aborted', 'AbortError')
    }
    return release
  }

  private take(accountId: string): () => void {
    this.held.set(accountId, (this.held.get(accountId) ?? 0) + 1)
    return this.releaseFn(accountId)
  }

  private releaseFn(accountId: string): () => void {
    let released = false
    return () => {
      // Idempotent: a cancel path and a completion path both call this.
      if (released) return
      released = true
      const next = (this.held.get(accountId) ?? 1) - 1
      if (next <= 0) this.held.delete(accountId)
      else this.held.set(accountId, next)
      this.drain(accountId)
    }
  }

  /** Hand slots to as many waiters as the current limit allows. */
  private drain(accountId: string): void {
    const queue = this.queues.get(accountId)
    if (queue === undefined || queue.length === 0) return
    const limit = this.limits.get(accountId)
    // An uncapped account owes every waiter a slot, and every one of them is a
    // real holder: a waiter released while uncapped still owns its slot, so the
    // count has to rise for it exactly as it does under a cap.
    const room = limit === undefined ? queue.length : limit - (this.held.get(accountId) ?? 0)
    for (let index = 0; index < room && queue.length > 0; index++) {
      const waiter = queue.shift()!
      this.held.set(accountId, (this.held.get(accountId) ?? 0) + 1)
      waiter.resolve()
    }
    if (queue.length === 0) this.queues.delete(accountId)
  }
}