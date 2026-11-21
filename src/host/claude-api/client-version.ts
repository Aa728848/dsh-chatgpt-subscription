import fs from 'node:fs/promises'
import path from 'node:path'
import { dshHomeDir } from '../common/home.ts'
import type { ClaudeApiClientVersionDto, ClaudeApiClientVersionSource, ClaudeApiCacheTtl } from '../../shared/claude-api-contracts.ts'
import {
  CLAUDE_API_CLI_VERSION_ENV,
  CLAUDE_API_CLIENT_VERSION_REFRESH_MS,
  CLAUDE_API_CLIENT_VERSION_TIMEOUT_MS,
  CLAUDE_API_DEFAULT_CLI_VERSION,
  CLAUDE_API_NPM_LATEST_URL,
} from './types.ts'

/**
 * The Claude Code version this line reports, following the latest release on npm.
 *
 * ORDER: operator pin (env) -> value fetched by this process -> last fetched value on disk
 * -> shipped default. A request never waits for the network: the resolver answers from
 * memory and refreshes behind the scenes, and an unreachable registry leaves the last
 * fetched value in force (a user requirement).
 *
 * WHY THE VALUE IS GLOBAL AND DEFERRED. Every session reports the same version at any
 * moment. A newer fetched version is adopted only when the whole line has been idle
 * longer than the remembered prompt-cache TTL, so a version change never lands inside a
 * live cache window; until then it is reported as pending. Adoption rewrites the first
 * system block (the billing header) and the User-Agent, costing each running conversation
 * one prompt-cache miss; on models with preserved thinking the earlier thinking blocks
 * fail the prefix check and block_binding's drop_block mode drops them, reported in
 * input_transformations. An env pin applies immediately and is never deferred.
 */
export interface PersistedClaudeApiClientVersion {
  version: string
  fetchedAt: number
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/

const MIN_TTL_MS = 5 * 60_000
const HOUR_TTL_MS = 60 * 60_000

/** Only plain release versions are accepted; a prerelease or a malformed value is "not fetched". */
export function isClaudeApiCliVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION_PATTERN.test(value)
}

export function claudeApiClientVersionPath(): string {
  return path.join(dshHomeDir(), 'storages', 'claude-api-client-version.json')
}

/** Writer half of the persisted record. */
export function serializeClaudeApiClientVersion(record: PersistedClaudeApiClientVersion): string {
  return JSON.stringify({ version: record.version, fetchedAt: record.fetchedAt }, null, 2) + '\n'
}

/** Reader half: the inverse of serializeClaudeApiClientVersion after JSON.parse. */
export function parseClaudeApiClientVersion(value: unknown): PersistedClaudeApiClientVersion | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!isClaudeApiCliVersion(record.version)) return null
  const fetchedAt = typeof record.fetchedAt === 'number' && Number.isFinite(record.fetchedAt) ? record.fetchedAt : 0
  return { version: record.version, fetchedAt }
}

export interface ClaudeApiClientVersionOptions {
  fetchFn?: typeof fetch
  filePath?: string
  now?: () => number
  env?: Readonly<Record<string, string | undefined>>
  refreshMs?: number
  timeoutMs?: number
}

export class ClaudeApiClientVersionResolver {
  private readonly fetchFn: typeof fetch
  private readonly filePath: string
  private readonly now: () => number
  private readonly env: Readonly<Record<string, string | undefined>>
  private readonly refreshMs: number
  private readonly timeoutMs: number
  private fetched: PersistedClaudeApiClientVersion | null = null
  private cached: PersistedClaudeApiClientVersion | null = null
  private warmed: Promise<void> | null = null
  private inflight: Promise<void> | null = null
  private lastAttemptAt: number | null = null
  private active: { value: string; source: ClaudeApiClientVersionSource; fetchedAt: number | null } | null = null
  private lastActivityAt: number | null = null
  private rememberedTtlMs: number = MIN_TTL_MS

  constructor(options: ClaudeApiClientVersionOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch
    this.filePath = options.filePath ?? claudeApiClientVersionPath()
    this.now = options.now ?? Date.now
    this.env = options.env ?? process.env
    this.refreshMs = options.refreshMs ?? CLAUDE_API_CLIENT_VERSION_REFRESH_MS
    this.timeoutMs = options.timeoutMs ?? CLAUDE_API_CLIENT_VERSION_TIMEOUT_MS
  }

  /** The value in force right now, with where it came from. Synchronous and never throws. */
  current(): ClaudeApiClientVersionDto {
    const pinned = (this.env[CLAUDE_API_CLI_VERSION_ENV] ?? '').trim()
    if (isClaudeApiCliVersion(pinned)) return { value: pinned, source: 'env', fetchedAt: null, pending: null }
    const candidate = this.candidate()
    if (this.active === null) {
      this.active = candidate
      return { ...candidate, pending: null }
    }
    if (candidate.value !== this.active.value) {
      const idle = this.lastActivityAt === null || this.now() - this.lastActivityAt >= this.rememberedTtlMs
      if (idle) {
        this.active = candidate
        this.rememberedTtlMs = MIN_TTL_MS
        return { ...candidate, pending: null }
      }
      return { ...this.active, pending: candidate.value }
    }
    return { ...this.active, pending: null }
  }

  /** The latest known version: fetched by this process, else on disk, else shipped. */
  private candidate(): { value: string; source: ClaudeApiClientVersionSource; fetchedAt: number | null } {
    if (this.fetched !== null) return { value: this.fetched.version, source: 'npm', fetchedAt: this.fetched.fetchedAt }
    if (this.cached !== null) return { value: this.cached.version, source: 'cached', fetchedAt: this.cached.fetchedAt }
    return { value: CLAUDE_API_DEFAULT_CLI_VERSION, source: 'default', fetchedAt: null }
  }

  /** A request of this line is happening now; remember the longest ttl seen since adoption. */
  noteActivity(ttl: ClaudeApiCacheTtl): void {
    this.lastActivityAt = this.now()
    const ms = ttl === '1h' ? HOUR_TTL_MS : MIN_TTL_MS
    if (ms > this.rememberedTtlMs) this.rememberedTtlMs = ms
  }

  /** Load the last fetched value from disk once. A missing or damaged file is simply "nothing cached". */
  warm(): Promise<void> {
    this.warmed ??= (async () => {
      try { this.cached = parseClaudeApiClientVersion(JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown) }
      catch { this.cached = null }
    })()
    return this.warmed
  }

  /**
   * Ask npm for the latest version. Single-flight, rate-limited by refreshMs unless forced,
   * and it never rejects: any failure leaves the previous value in force.
   */
  async refresh(options: { force?: boolean } = {}): Promise<ClaudeApiClientVersionDto> {
    await this.warm()
    const now = this.now()
    if (options.force !== true && this.lastAttemptAt !== null && now - this.lastAttemptAt < this.refreshMs) return this.current()
    this.inflight ??= this.fetchLatest().finally(() => { this.inflight = null })
    await this.inflight
    return this.current()
  }

  /** Warm, refresh in the background, and keep refreshing. Returns the disposer. Never awaited by plugin setup. */
  start(): () => void {
    void this.refresh().catch(() => undefined)
    const timer = setInterval(() => { void this.refresh().catch(() => undefined) }, this.refreshMs)
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) (timer as { unref: () => void }).unref()
    return () => clearInterval(timer)
  }

  private async fetchLatest(): Promise<void> {
    this.lastAttemptAt = this.now()
    try {
      const response = await this.fetchFn(CLAUDE_API_NPM_LATEST_URL, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!response.ok) return
      const payload = await response.json() as unknown
      const version = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>).version : undefined
      if (!isClaudeApiCliVersion(version)) return
      const record: PersistedClaudeApiClientVersion = { version, fetchedAt: this.now() }
      this.fetched = record
      this.cached = record
      await this.persist(record).catch(() => undefined)
    } catch {
      // Unreachable registry, timeout or a non-JSON body: keep the last fetched value.
    }
  }

  private async persist(record: PersistedClaudeApiClientVersion): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const temporary = this.filePath + '.tmp.' + process.pid
    try {
      await fs.writeFile(temporary, serializeClaudeApiClientVersion(record), { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temporary, this.filePath)
    } finally {
      await fs.unlink(temporary).catch(() => undefined)
    }
  }
}
