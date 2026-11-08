/** Shared cache and caller-aware singleflight for provider-hosted media uploads. */

export type MaybePromise<T> = T | Promise<T>

export interface HostedMediaCache<T> {
  get(key: string): MaybePromise<T | undefined>
  set(key: string, value: T): MaybePromise<void>
  delete(key: string): MaybePromise<boolean>
  clear(): MaybePromise<void>
  readonly size?: number
}

/** Default bounded LRU; providers with durable caches can supply their own adapter. */
export class MemoryHostedMediaCache<T> implements HostedMediaCache<T> {
  private readonly entries = new Map<string, T>()

  constructor(private readonly maxEntries = 256) {}

  get size(): number { return this.entries.size }

  get(key: string): T | undefined {
    const value = this.entries.get(key)
    if (value === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  set(key: string, value: T): void {
    this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done !== true) this.entries.delete(oldest.value)
    }
  }

  delete(key: string): boolean { return this.entries.delete(key) }
  clear(): void { this.entries.clear() }
}

interface UploadFlight<T> {
  readonly promise: Promise<T>
  readonly controller: AbortController
  waiters: number
}

export interface HostedMediaUploadCoordinatorOptions<T> {
  readonly cache?: HostedMediaCache<T>
  readonly maxCacheEntries?: number
}

export class HostedMediaUploadCoordinator<T> {
  private readonly cache: HostedMediaCache<T>
  private readonly flights = new Map<string, UploadFlight<T>>()

  constructor(options: HostedMediaUploadCoordinatorOptions<T> = {}) {
    this.cache = options.cache ?? new MemoryHostedMediaCache<T>(options.maxCacheEntries)
  }

  get size(): number { return this.cache.size ?? 0 }

  /** Upload once per key; one caller aborts only its own wait. */
  async upload(
    key: string,
    callerSignal: AbortSignal | undefined,
    start: (controller: AbortController) => Promise<T>,
  ): Promise<T> {
    if (callerSignal?.aborted === true) throw abortWithReason(callerSignal)
    const cached = await this.cache.get(key)
    if (cached !== undefined) return cached

    let flight = this.flights.get(key)
    if (flight === undefined) {
      const controller = new AbortController()
      const promise = start(controller).then(async value => {
        await this.cache.set(key, value)
        return value
      })
      flight = { promise, controller, waiters: 0 }
      this.flights.set(key, flight)
      void promise.catch(() => undefined)
      void promise.finally(() => {
        if (this.flights.get(key) === flight) this.flights.delete(key)
      }).catch(() => undefined)
    }
    return this.join(flight, callerSignal)
  }

  forget(key: string): MaybePromise<boolean> { return this.cache.delete(key) }
  clear(): MaybePromise<void> { return this.cache.clear() }

  private async join(
    flight: UploadFlight<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    if (signal?.aborted === true) throw abortWithReason(signal)
    flight.waiters += 1
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      flight.waiters -= 1
      if (flight.waiters <= 0) {
        for (const [key, candidate] of this.flights) {
          if (candidate === flight) this.flights.delete(key)
        }
        flight.controller.abort()
      }
    }

    if (signal === undefined) {
      try { return await flight.promise } finally { release() }
    }

    let detach: (() => void) | undefined
    const cancelled = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => reject(abortWithReason(signal))
      detach = () => signal.removeEventListener('abort', onAbort)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([flight.promise, cancelled])
    } finally {
      detach?.()
      release()
    }
  }
}

function abortWithReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  const error = new Error('the media upload was aborted')
  error.name = 'AbortError'
  return error
}
