/**
 * Persisted, non-secret capability conclusions shared by both Claude lines.
 * Scope is endpoint+model for API keys and account+model for subscriptions.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { dshHomeDir } from '../../common/home.ts'

export const CLAUDE_CAPABILITY_MEMORY_TTL_MS = 7 * 24 * 60 * 60_000
export const CLAUDE_CAPABILITY_MEMORY_MAX_KEYS = 500
export const CLAUDE_API_CAPABILITY_MEMORY_TTL_MS = CLAUDE_CAPABILITY_MEMORY_TTL_MS
export const CLAUDE_API_CAPABILITY_MEMORY_MAX_KEYS = CLAUDE_CAPABILITY_MEMORY_MAX_KEYS

export type ClaudeFastModeConclusion = 'unsupported' | 'beta'
export type ClaudeApiFastModeConclusion = ClaudeFastModeConclusion
interface StoredField<T> { value: T; expiresAt: number }

export interface ClaudeCapabilityRecord {
  compaction?: StoredField<'unsupported'>
  fastMode?: StoredField<ClaudeFastModeConclusion>
  systemRole?: StoredField<'unsupported'>
  thinkingTokenCount?: StoredField<'unsupported'>
}
export type ClaudeApiCapabilityRecord = ClaudeCapabilityRecord

export interface ClaudeCapabilityFacts {
  compactionUnsupported: boolean
  fastMode: ClaudeFastModeConclusion | undefined
  systemRoleUnsupported: boolean
  thinkingTokenCountUnsupported: boolean
}
export type ClaudeApiCapabilityFacts = ClaudeCapabilityFacts

export function claudeCapabilityMemoryPath(line: 'claude' | 'claude-api' = 'claude-api'): string {
  return path.join(dshHomeDir(), 'storages', line === 'claude' ? 'claude-subscription-capability-memory.json' : 'claude-api-capability-memory.json')
}
export function claudeApiCapabilityMemoryPath(): string { return claudeCapabilityMemoryPath('claude-api') }

function capabilityKey(scope: string, model: string): string { return scope + '\n' + model }
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function isField<T>(value: unknown, allowed: readonly T[]): value is StoredField<T> {
  return isRecord(value) && allowed.includes(value.value as T)
    && typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt)
}

export function serializeClaudeCapabilityMemory(records: Readonly<Record<string, ClaudeCapabilityRecord>>): string {
  return JSON.stringify({ version: 1, records }, null, 2) + '\n'
}
export const serializeClaudeApiCapabilityMemory = serializeClaudeCapabilityMemory

export function parseClaudeCapabilityMemory(value: unknown): Record<string, ClaudeCapabilityRecord> {
  const result: Record<string, ClaudeCapabilityRecord> = {}
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.records)) return result
  for (const [key, raw] of Object.entries(value.records)) {
    if (!isRecord(raw)) continue
    const record: ClaudeCapabilityRecord = {}
    if (isField(raw.compaction, ['unsupported'] as const)) record.compaction = raw.compaction
    if (isField(raw.fastMode, ['unsupported', 'beta'] as const)) record.fastMode = raw.fastMode
    if (isField(raw.systemRole, ['unsupported'] as const)) record.systemRole = raw.systemRole
    if (isField(raw.thinkingTokenCount, ['unsupported'] as const)) record.thinkingTokenCount = raw.thinkingTokenCount
    if (record.compaction !== undefined || record.fastMode !== undefined || record.systemRole !== undefined || record.thinkingTokenCount !== undefined) result[key] = record
  }
  return result
}
export const parseClaudeApiCapabilityMemory = parseClaudeCapabilityMemory

export class ClaudeCapabilityMemory {
  private readonly filePath: string
  private readonly now: () => number
  private records = new Map<string, ClaudeCapabilityRecord>()
  private warmed: Promise<void> | null = null
  private writeSequence = 0

  constructor(filePath: string = claudeCapabilityMemoryPath(), now: () => number = Date.now) {
    this.filePath = filePath
    this.now = now
  }

  path(): string { return this.filePath }

  warm(): Promise<void> {
    this.warmed ??= (async () => {
      try { this.records = new Map(Object.entries(parseClaudeCapabilityMemory(JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown))) }
      catch { this.records = new Map() }
    })()
    return this.warmed
  }

  get(scope: string, model: string): ClaudeCapabilityFacts {
    const key = capabilityKey(scope, model)
    const record = this.records.get(key)
    if (record === undefined) return { compactionUnsupported: false, fastMode: undefined, systemRoleUnsupported: false, thinkingTokenCountUnsupported: false }
    this.pruneRecord(record, this.now())
    if (Object.keys(record).length === 0) this.records.delete(key)
    return {
      compactionUnsupported: record.compaction !== undefined,
      fastMode: record.fastMode?.value,
      systemRoleUnsupported: record.systemRole !== undefined,
      thinkingTokenCountUnsupported: record.thinkingTokenCount !== undefined,
    }
  }

  async setCompactionUnsupported(scope: string, model: string): Promise<void> {
    await this.set(scope, model, 'compaction', 'unsupported')
  }
  async setFastMode(scope: string, model: string, value: ClaudeFastModeConclusion): Promise<void> {
    await this.set(scope, model, 'fastMode', value)
  }
  async setSystemRoleUnsupported(scope: string, model: string): Promise<void> {
    await this.set(scope, model, 'systemRole', 'unsupported')
  }
  async setThinkingTokenCountUnsupported(scope: string, model: string): Promise<void> {
    await this.set(scope, model, 'thinkingTokenCount', 'unsupported')
  }

  private async set<K extends keyof ClaudeCapabilityRecord>(
    scope: string, model: string, field: K, value: NonNullable<ClaudeCapabilityRecord[K]>['value'],
  ): Promise<void> {
    await this.warm()
    const key = capabilityKey(scope, model)
    const record = this.records.get(key) ?? {}
    const stored = { value, expiresAt: this.now() + CLAUDE_CAPABILITY_MEMORY_TTL_MS } as NonNullable<ClaudeCapabilityRecord[K]>
    record[field] = stored
    this.records.set(key, record)
    await this.persist()
  }

  private pruneRecord(record: ClaudeCapabilityRecord, now: number): void {
    for (const field of ['compaction', 'fastMode', 'systemRole', 'thinkingTokenCount'] as const) {
      const stored = record[field]
      if (stored !== undefined && stored.expiresAt <= now) delete record[field]
    }
  }

  private prune(): void {
    const now = this.now()
    for (const [key, record] of this.records) {
      this.pruneRecord(record, now)
      if (Object.keys(record).length === 0) this.records.delete(key)
    }
    if (this.records.size <= CLAUDE_CAPABILITY_MEMORY_MAX_KEYS) return
    const oldest = [...this.records.keys()].slice(0, this.records.size - CLAUDE_CAPABILITY_MEMORY_MAX_KEYS)
    for (const key of oldest) this.records.delete(key)
  }

  private async persist(): Promise<void> {
    this.prune()
    const records: Record<string, ClaudeCapabilityRecord> = {}
    for (const [key, record] of this.records) records[key] = record
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    this.writeSequence += 1
    const temporary = this.filePath + '.tmp.' + process.pid + '.' + this.writeSequence
    try {
      await fs.writeFile(temporary, serializeClaudeCapabilityMemory(records), { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temporary, this.filePath)
    } finally {
      await fs.unlink(temporary).catch(() => undefined)
    }
  }
}

export { ClaudeCapabilityMemory as ClaudeApiCapabilityMemory }
