/** Last request activity used by cache-expiry hints and wait-time keepalive. */
import path from 'node:path'
import { dshHomeDir } from './home.ts'
import { CommonSessionCacheStateStore } from './session-cache-state.ts'

export interface PromptCacheActivity {
  readonly lastActiveAt: number
  readonly totalTokens: number
}

interface ActivityRecord extends PromptCacheActivity {
  readonly updatedAt: number
}

function normalizeRecord(value: unknown): ActivityRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const lastActiveAt = record.lastActiveAt
  const updatedAt = record.updatedAt
  if (typeof lastActiveAt !== 'number' || !Number.isFinite(lastActiveAt)) return undefined
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return undefined
  const totalTokens = typeof record.totalTokens === 'number' && Number.isFinite(record.totalTokens)
    ? Math.max(0, Math.floor(record.totalTokens))
    : 0
  return { lastActiveAt, totalTokens, updatedAt }
}

function persistenceEnabled(): boolean {
  return process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test'
}

export class PromptCacheActivityStore {
  private readonly store: CommonSessionCacheStateStore<ActivityRecord>

  constructor(provider: string, filePath?: string) {
    const target = filePath ?? path.join(dshHomeDir(), 'storages', `dsh-chatgpt-subscription-${provider}-activity.json`)
    this.store = new CommonSessionCacheStateStore<ActivityRecord>({
      filePath: target,
      allowWrite: filePath !== undefined || persistenceEnabled(),
      normalizeRecord,
    })
  }

  read(sessionId?: string): PromptCacheActivity | undefined {
    const record = this.store.read(sessionId)
    return record === undefined ? undefined : { lastActiveAt: record.lastActiveAt, totalTokens: record.totalTokens }
  }

  record(sessionId: string | undefined, totalTokens: number, at: number = Date.now()): void {
    if (sessionId === undefined || sessionId.trim() === '') return
    this.store.write(sessionId, {
      lastActiveAt: at,
      totalTokens: Number.isFinite(totalTokens) ? Math.max(0, Math.floor(totalTokens)) : 0,
      updatedAt: at,
    })
  }

  flush(): void { this.store.flush() }
}

const SHARED_ACTIVITY_STORES = new Map<string, PromptCacheActivityStore>()

/** One live store per provider; tests can still construct isolated instances by path. */
export function promptCacheActivityStore(provider: string): PromptCacheActivityStore {
  let store = SHARED_ACTIVITY_STORES.get(provider)
  if (store === undefined) {
    store = new PromptCacheActivityStore(provider)
    SHARED_ACTIVITY_STORES.set(provider, store)
  }
  return store
}
