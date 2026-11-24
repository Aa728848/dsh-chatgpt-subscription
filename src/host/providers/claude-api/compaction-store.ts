/**
 * Persistence for server-compaction blocks of the claude-api line. A block is keyed by
 * the SHA-256 of its TRIMMED content, so a checkpoint summary that was edited by even
 * one character is not found and the request falls back to the text form. The file is
 * owner-only (0600), capped at 200 entries and 30 days, and written atomically.
 *
 * The writer/reader pair (serializeClaudeApiCompactionBlocks / parseClaudeApiCompactionBlocks)
 * is the whole persistence contract and is tested as a pair through the production writer.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { dshHomeDir } from '../../common/home.ts'

/** One stored compaction block, exactly as the wire sent it plus provenance. */
export interface StoredBlock {
  content: string
  signature: string
  toolChanges?: unknown
  model: string
  createdAt: number
  /** Credential fingerprint + endpoint this block was produced against; absent on legacy entries. */
  scope?: string
}

export const CLAUDE_API_COMPACTION_MAX_ENTRIES = 200
export const CLAUDE_API_COMPACTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export function claudeApiCompactionBlocksPath(): string {
  return path.join(dshHomeDir(), 'storages', 'claude-api-compaction-blocks.json')
}

/** The storage key of one summary: SHA-256 of the trimmed content, hex. */
export function compactionBlockKey(summary: string): string {
  return createHash('sha256').update(summary.trim()).digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Writer half: the on-disk document for one key->block table. */
export function serializeClaudeApiCompactionBlocks(blocks: Readonly<Record<string, StoredBlock>>): string {
  return JSON.stringify({ version: 1, blocks }, null, 2) + '\n'
}

/**
 * Reader half: the inverse of serializeClaudeApiCompactionBlocks after JSON.parse.
 * Damaged entries are dropped, and an entry whose key does not match its content is
 * dropped too (the key IS the integrity check).
 */
export function parseClaudeApiCompactionBlocks(value: unknown): Record<string, StoredBlock> {
  const result: Record<string, StoredBlock> = {}
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.blocks)) return result
  for (const [key, raw] of Object.entries(value.blocks)) {
    if (!/^[0-9a-f]{64}$/.test(key) || !isRecord(raw)) continue
    const content = asString(raw.content)
    const signature = asString(raw.signature)
    const model = asString(raw.model)
    const createdAt = typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : undefined
    if (content === undefined || signature === undefined || model === undefined || createdAt === undefined) continue
    if (compactionBlockKey(content) !== key) continue
    const scope = asString(raw.scope)
    result[key] = {
      content, signature, model, createdAt,
      ...(raw.toolChanges !== undefined ? { toolChanges: raw.toolChanges } : {}),
      ...(scope !== undefined ? { scope } : {}),
    }
  }
  return result
}

export class ClaudeApiCompactionStore {
  private readonly filePath: string
  private readonly now: () => number
  private blocks = new Map<string, StoredBlock>()
  private warmed: Promise<void> | null = null
  private writeSequence = 0

  constructor(filePath: string = claudeApiCompactionBlocksPath(), now: () => number = Date.now) {
    this.filePath = filePath
    this.now = now
  }

  path(): string { return this.filePath }

  /** Load the persisted table once. A missing or damaged file is simply "nothing stored". */
  warm(): Promise<void> {
    this.warmed ??= (async () => {
      try {
        const parsed = parseClaudeApiCompactionBlocks(JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown)
        this.blocks = new Map(Object.entries(parsed))
      } catch {
        this.blocks = new Map()
      }
    })()
    return this.warmed
  }

  /**
   * Synchronous, from memory: the adapter warms the store at startup. A block is returned
   * only for the SAME scope (credential fingerprint + endpoint) it was stored under;
   * entries without a scope are never found. The model is deliberately not part of the
   * match: upstream accepts a block on another model that supports compaction.
   */
  lookup(summary: string, scope: string): StoredBlock | undefined {
    const block = this.blocks.get(compactionBlockKey(summary))
    return block !== undefined && block.scope === scope ? block : undefined
  }

  async remember(block: { content: string; signature: string; toolChanges?: unknown; model: string; scope: string }): Promise<void> {
    await this.warm()
    this.blocks.set(compactionBlockKey(block.content), {
      content: block.content,
      signature: block.signature,
      model: block.model,
      createdAt: this.now(),
      scope: block.scope,
      ...(block.toolChanges !== undefined ? { toolChanges: block.toolChanges } : {}),
    })
    this.prune()
    await this.persist()
  }

  /** Removes only the entry of this scope; another scope's block survives. */
  async forget(summary: string, scope: string): Promise<void> {
    await this.warm()
    const key = compactionBlockKey(summary)
    const block = this.blocks.get(key)
    if (block === undefined || block.scope !== scope) return
    this.blocks.delete(key)
    await this.persist()
  }

  private prune(): void {
    const cutoff = this.now() - CLAUDE_API_COMPACTION_MAX_AGE_MS
    for (const [key, block] of this.blocks) if (block.createdAt < cutoff) this.blocks.delete(key)
    if (this.blocks.size <= CLAUDE_API_COMPACTION_MAX_ENTRIES) return
    const oldest = [...this.blocks.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)
    for (const [key] of oldest.slice(0, this.blocks.size - CLAUDE_API_COMPACTION_MAX_ENTRIES)) this.blocks.delete(key)
  }

  private async persist(): Promise<void> {
    const record: Record<string, StoredBlock> = {}
    for (const [key, block] of this.blocks) record[key] = block
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    this.writeSequence += 1
    const temporary = this.filePath + '.tmp.' + process.pid + '.' + this.writeSequence
    try {
      await fs.writeFile(temporary, serializeClaudeApiCompactionBlocks(record), { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temporary, this.filePath)
    } finally {
      await fs.unlink(temporary).catch(() => undefined)
    }
  }
}
