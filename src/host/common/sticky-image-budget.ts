/** Durable dropped-image identities for a provider's sticky budget. */
import path from 'node:path'
import { dshHomeDir } from './home.ts'
import { CommonSessionCacheStateStore } from './session-cache-state.ts'

interface StickyImageRecord {
  updatedAt: number
  budgetDropped: string[]
}

function normalizeRecord(value: unknown): StickyImageRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const updatedAt = record.updatedAt
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return undefined
  const keys = Array.isArray(record.budgetDropped)
    ? record.budgetDropped.filter((key): key is string => typeof key === 'string' && key !== '').slice(0, 512)
    : []
  return { updatedAt, budgetDropped: [...new Set(keys)] }
}

function persistenceEnabled(): boolean {
  return process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test'
}

export class StickyImageBudgetStore {
  private readonly store: CommonSessionCacheStateStore<StickyImageRecord>

  constructor(provider: string, filePath?: string) {
    const target = filePath ?? path.join(dshHomeDir(), 'storages', `dsh-chatgpt-subscription-${provider}-cache.json`)
    this.store = new CommonSessionCacheStateStore<StickyImageRecord>({
      filePath: target,
      allowWrite: filePath !== undefined || persistenceEnabled(),
      normalizeRecord,
    })
  }

  /** Identities already omitted in this session, including before a restart. */
  priorDroppedKeys(sessionId?: string): ReadonlySet<string> {
    if (sessionId === undefined || sessionId.trim() === '') return new Set()
    return new Set(this.store.read(sessionId)?.budgetDropped ?? [])
  }

  /** Persist the complete set, not just the newest omissions. */
  record(sessionId: string | undefined, keys: ReadonlySet<string>): void {
    if (sessionId === undefined || sessionId.trim() === '') return
    this.store.write(sessionId, { updatedAt: Date.now(), budgetDropped: [...keys].slice(0, 512) })
  }

  flush(): void { this.store.flush() }
}
