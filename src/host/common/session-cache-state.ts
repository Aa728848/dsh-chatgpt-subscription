/**
 * Generic bounded, durable session state for cache diagnostics and sticky media.
 * One provider owns one document; records remain keyed by session inside it.
 */
import fs from 'node:fs'
import path from 'node:path'

export interface SessionCacheRecordShape {
  readonly updatedAt: number
}

export interface CommonSessionCacheStateOptions<T extends SessionCacheRecordShape> {
  readonly filePath: string
  readonly maxEntries?: number
  readonly allowWrite?: boolean
  readonly normalizeRecord: (value: unknown) => T | undefined
}

export class CommonSessionCacheStateStore<T extends SessionCacheRecordShape> {
  private document: { version: 1; sessions: Record<string, T> } | undefined
  private pending: ReturnType<typeof setTimeout> | undefined
  private readonly filePath: string
  private readonly maxEntries: number
  private readonly allowWrite: boolean
  private readonly normalizeRecord: (value: unknown) => T | undefined
  private static writeSequence = 0

  constructor(options: CommonSessionCacheStateOptions<T>) {
    this.filePath = options.filePath
    this.maxEntries = options.maxEntries ?? 64
    this.allowWrite = options.allowWrite ?? true
    this.normalizeRecord = options.normalizeRecord
  }

  read(sessionId?: string): T | undefined {
    const sessions = this.load().sessions
    const named = sessionId?.trim()
    if (named !== undefined && named !== '') return sessions[named]
    let newest: T | undefined
    for (const record of Object.values(sessions)) {
      if (newest === undefined || record.updatedAt > newest.updatedAt) newest = record
    }
    return newest
  }

  write(sessionId: string, record: T): void {
    const key = sessionId.trim()
    if (key === '') return
    const document = this.load()
    document.sessions[key] = record
    const entries = Object.entries(document.sessions)
    if (entries.length > this.maxEntries) {
      entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      document.sessions = Object.fromEntries(entries.slice(0, this.maxEntries))
    }
    this.schedule()
  }

  /** Update an existing record; absence is not created implicitly. */
  update(sessionId: string, update: (record: T) => T): boolean {
    const key = sessionId.trim()
    if (key === '') return false
    const document = this.load()
    const existing = document.sessions[key]
    if (existing === undefined) return false
    const next = update(existing)
    if (next === existing) return true
    document.sessions[key] = next
    this.schedule()
    return true
  }

  flush(): void {
    this.cancelPending()
    if (this.document !== undefined) this.persist(this.document)
  }

  private load(): { version: 1; sessions: Record<string, T> } {
    if (this.document !== undefined) return this.document
    const sessions: Record<string, T> = {}
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const rawSessions = (parsed as { sessions?: unknown }).sessions
        if (typeof rawSessions === 'object' && rawSessions !== null && !Array.isArray(rawSessions)) {
          for (const [key, entry] of Object.entries(rawSessions)) {
            const record = this.normalizeRecord(entry)
            if (record !== undefined) sessions[key] = record
          }
        }
      }
    } catch {
      // Missing/corrupt diagnostic state reads as empty and never fails a turn.
    }
    this.document = { version: 1, sessions }
    return this.document
  }

  private schedule(): void {
    if (!this.allowWrite || this.pending !== undefined) return
    this.pending = setTimeout(() => {
      this.pending = undefined
      if (this.document !== undefined) this.persist(this.document)
    }, 250)
    ;(this.pending as unknown as { unref?: () => void }).unref?.()
  }

  private cancelPending(): void {
    if (this.pending === undefined) return
    clearTimeout(this.pending)
    this.pending = undefined
  }

  private persist(document: { version: 1; sessions: Record<string, T> }): void {
    if (!this.allowWrite) return
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const temporary = this.filePath + '.' + process.pid + '.' + (++CommonSessionCacheStateStore.writeSequence) + '.tmp'
      fs.writeFileSync(temporary, JSON.stringify(document), 'utf8')
      fs.renameSync(temporary, this.filePath)
    } catch {
      // Best-effort diagnostics only.
    }
  }
}
