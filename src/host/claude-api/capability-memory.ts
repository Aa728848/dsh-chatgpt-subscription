/**
 * Persisted runtime conclusions about a model on an endpoint for the claude-api line.
 * Upstream refusals teach the adapter four independent facts - the model cannot take
 * server compaction, the model cannot take the speed parameter, the model needs the
 * fast-mode beta for speed, or the model rejects the system role inside messages - and
 * each is remembered for CLAUDE_API_CAPABILITY_MEMORY_TTL_MS
 * so a restart does not re-pay the refused request. The key is endpoint + model, never the
 * API key: these are public capability facts, nothing secret is stored. The file is
 * owner-only (0600), written atomically, bounded to 500 keys, and expired fields are
 * dropped on every write. A missing or damaged file is simply "nothing remembered".
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { dshHomeDir } from '../common/home.ts'

export const CLAUDE_API_CAPABILITY_MEMORY_TTL_MS = 7 * 24 * 60 * 60_000
export const CLAUDE_API_CAPABILITY_MEMORY_MAX_KEYS = 500

export type ClaudeApiFastModeConclusion = 'unsupported' | 'beta'

interface StoredField<T> { value: T; expiresAt: number }
export interface ClaudeApiCapabilityRecord {
  compaction?: StoredField<'unsupported'>
  fastMode?: StoredField<ClaudeApiFastModeConclusion>
  systemRole?: StoredField<'unsupported'>
}
export interface ClaudeApiCapabilityFacts {
  compactionUnsupported: boolean
  fastMode: ClaudeApiFastModeConclusion | undefined
  systemRoleUnsupported: boolean
}

export function claudeApiCapabilityMemoryPath(): string {
  return path.join(dshHomeDir(), 'storages', 'claude-api-capability-memory.json')
}

function capabilityKey(baseUrl: string, model: string): string {
  return baseUrl + '\n' + model
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function isField<T>(value: unknown, allowed: readonly T[]): value is StoredField<T> {
  return isRecord(value) && allowed.includes(value.value as T)
    && typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt)
}

/** Writer half: the on-disk document for one key->record table. */
export function serializeClaudeApiCapabilityMemory(records: Readonly<Record<string, ClaudeApiCapabilityRecord>>): string {
  return JSON.stringify({ version: 1, records }, null, 2) + '\n'
}

/** Reader half: the inverse of serializeClaudeApiCapabilityMemory after JSON.parse. */
export function parseClaudeApiCapabilityMemory(value: unknown): Record<string, ClaudeApiCapabilityRecord> {
  const result: Record<string, ClaudeApiCapabilityRecord> = {}
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.records)) return result
  for (const [key, raw] of Object.entries(value.records)) {
    if (!isRecord(raw)) continue
    const record: ClaudeApiCapabilityRecord = {}
    if (isField(raw.compaction, ['unsupported'] as const)) record.compaction = raw.compaction
    if (isField(raw.fastMode, ['unsupported', 'beta'] as const)) record.fastMode = raw.fastMode
    if (isField(raw.systemRole, ['unsupported'] as const)) record.systemRole = raw.systemRole
    if (record.compaction !== undefined || record.fastMode !== undefined || record.systemRole !== undefined) result[key] = record
  }
  return result
}

export class ClaudeApiCapabilityMemory {
  private readonly filePath: string
  private readonly now: () => number
  private records = new Map<string, ClaudeApiCapabilityRecord>()
  private warmed: Promise<void> | null = null
  private writeSequence = 0

  constructor(filePath: string = claudeApiCapabilityMemoryPath(), now: () => number = Date.now) {
    this.filePath = filePath
    this.now = now
  }

  path(): string { return this.filePath }

  /** Load the persisted table once. A missing or damaged file is simply "nothing remembered". */
  warm(): Promise<void> {
    this.warmed ??= (async () => {
      try {
        this.records = new Map(Object.entries(parseClaudeApiCapabilityMemory(JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown)))
      } catch {
        this.records = new Map()
      }
    })()
    return this.warmed
  }

  /** Synchronous, from memory; expired fields are ignored and dropped. */
  get(baseUrl: string, model: string): ClaudeApiCapabilityFacts {
    const key = capabilityKey(baseUrl, model)
    const record = this.records.get(key)
    if (record === undefined) return { compactionUnsupported: false, fastMode: undefined, systemRoleUnsupported: false }
    const now = this.now()
    if (record.compaction !== undefined && record.compaction.expiresAt <= now) delete record.compaction
    if (record.fastMode !== undefined && record.fastMode.expiresAt <= now) delete record.fastMode
    if (record.systemRole !== undefined && record.systemRole.expiresAt <= now) delete record.systemRole
    if (record.compaction === undefined && record.fastMode === undefined && record.systemRole === undefined) this.records.delete(key)
    return { compactionUnsupported: record.compaction !== undefined, fastMode: record.fastMode?.value, systemRoleUnsupported: record.systemRole !== undefined }
  }

  async setCompactionUnsupported(baseUrl: string, model: string): Promise<void> {
    await this.warm()
    const key = capabilityKey(baseUrl, model)
    const record = this.records.get(key) ?? {}
    record.compaction = { value: 'unsupported', expiresAt: this.now() + CLAUDE_API_CAPABILITY_MEMORY_TTL_MS }
    this.records.set(key, record)
    await this.persist()
  }

  async setFastMode(baseUrl: string, model: string, value: ClaudeApiFastModeConclusion): Promise<void> {
    await this.warm()
    const key = capabilityKey(baseUrl, model)
    const record = this.records.get(key) ?? {}
    record.fastMode = { value, expiresAt: this.now() + CLAUDE_API_CAPABILITY_MEMORY_TTL_MS }
    this.records.set(key, record)
    await this.persist()
  }

  async setSystemRoleUnsupported(baseUrl: string, model: string): Promise<void> {
    await this.warm()
    const key = capabilityKey(baseUrl, model)
    const record = this.records.get(key) ?? {}
    record.systemRole = { value: 'unsupported', expiresAt: this.now() + CLAUDE_API_CAPABILITY_MEMORY_TTL_MS }
    this.records.set(key, record)
    await this.persist()
  }

  private prune(): void {
    const now = this.now()
    for (const [key, record] of this.records) {
      if (record.compaction !== undefined && record.compaction.expiresAt <= now) delete record.compaction
      if (record.fastMode !== undefined && record.fastMode.expiresAt <= now) delete record.fastMode
      if (record.systemRole !== undefined && record.systemRole.expiresAt <= now) delete record.systemRole
      if (record.compaction === undefined && record.fastMode === undefined && record.systemRole === undefined) this.records.delete(key)
    }
    if (this.records.size <= CLAUDE_API_CAPABILITY_MEMORY_MAX_KEYS) return
    const oldest = [...this.records.keys()].slice(0, this.records.size - CLAUDE_API_CAPABILITY_MEMORY_MAX_KEYS)
    for (const key of oldest) this.records.delete(key)
  }

  private async persist(): Promise<void> {
    this.prune()
    const records: Record<string, ClaudeApiCapabilityRecord> = {}
    for (const [key, record] of this.records) records[key] = record
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    this.writeSequence += 1
    const temporary = this.filePath + '.tmp.' + process.pid + '.' + this.writeSequence
    try {
      await fs.writeFile(temporary, serializeClaudeApiCapabilityMemory(records), { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temporary, this.filePath)
    } finally {
      await fs.unlink(temporary).catch(() => undefined)
    }
  }
}
