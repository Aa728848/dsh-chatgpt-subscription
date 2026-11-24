import fs from 'node:fs/promises'
import path from 'node:path'
import { dshHomeDir } from '../../common/home.ts'
import type { ClaudeApiCacheTtl, ClaudeApiClientVersionDto, ClaudeApiClientVersionSource } from '../../../shared/claude-api-contracts.ts'
import { CLAUDE_CODE_CCH_SEED } from './claude-code-cch.ts'

/** A version may be used for first-party traffic only together with its capture-verified seed. */
export interface ClaudeCodeVersionProfile {
  readonly version: string
  readonly seed: bigint
}

export type ClaudeCodeLine = 'claude' | 'claude-api'
export const CLAUDE_CODE_LINES: readonly ClaudeCodeLine[] = ['claude', 'claude-api']
export const CLAUDE_CODE_DEFAULT_CLI_VERSION = '2.1.330'
export const CLAUDE_CODE_VERSION_PROFILES: readonly ClaudeCodeVersionProfile[] = Object.freeze([
  { version: CLAUDE_CODE_DEFAULT_CLI_VERSION, seed: CLAUDE_CODE_CCH_SEED },
])
export const CLAUDE_CODE_NPM_LATEST_URL = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest'
export const CLAUDE_CODE_CLIENT_VERSION_REFRESH_MS = 24 * 60 * 60_000
export const CLAUDE_CODE_CLIENT_VERSION_TIMEOUT_MS = 10_000
export const CLAUDE_CODE_SUBSCRIPTION_CLI_VERSION_ENV = 'DSH_CLAUDE_CLI_VERSION'
export const CLAUDE_CODE_API_CLI_VERSION_ENV = 'DSH_CLAUDE_API_CLI_VERSION'
export const CLAUDE_CODE_CCH_SEED_ENV = 'DSH_CLAUDE_CCH_SEED'

export interface PersistedClaudeCodeClientVersion {
  version: string
  fetchedAt: number
}
export type PersistedClaudeApiClientVersion = PersistedClaudeCodeClientVersion

export interface ClaudeCodeVersionSelection extends ClaudeApiClientVersionDto {
  readonly seed: bigint
}

export interface ClaudeCodeVersionOptions {
  fetchFn?: typeof fetch
  filePath?: string
  now?: () => number
  env?: Readonly<Record<string, string | undefined>>
  refreshMs?: number
  timeoutMs?: number
  /** Test or vendor update seam. Production uses the shipped verified profiles. */
  profiles?: readonly ClaudeCodeVersionProfile[]
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const SEED_PATTERN = /^(?:0x)?[0-9a-f]{1,16}$/i
const MIN_TTL_MS = 5 * 60_000
const HOUR_TTL_MS = 60 * 60_000

export function isClaudeCodeCliVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION_PATTERN.test(value)
}
export const isClaudeApiCliVersion = isClaudeCodeCliVersion

export function claudeCodeClientVersionPath(): string {
  return path.join(dshHomeDir(), 'storages', 'claude-api-client-version.json')
}
export const claudeApiClientVersionPath = claudeCodeClientVersionPath

export function serializeClaudeCodeClientVersion(record: PersistedClaudeCodeClientVersion): string {
  return JSON.stringify({ version: record.version, fetchedAt: record.fetchedAt }, null, 2) + '\n'
}
export const serializeClaudeApiClientVersion = serializeClaudeCodeClientVersion

export function parseClaudeCodeClientVersion(value: unknown): PersistedClaudeCodeClientVersion | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!isClaudeCodeCliVersion(record.version)) return null
  const fetchedAt = typeof record.fetchedAt === 'number' && Number.isFinite(record.fetchedAt) ? record.fetchedAt : 0
  return { version: record.version, fetchedAt }
}
export const parseClaudeApiClientVersion = parseClaudeCodeClientVersion

let sharedVersionPin: string | null = null

/** Compatibility seam for the subscription line's existing in-process pin. */
export function setClaudeCodeVersionPin(value: string | null): void {
  const normalized = (value ?? '').trim()
  sharedVersionPin = normalized === '' ? null : normalized
}

function parseSeed(value: string | undefined): bigint | null {
  const normalized = (value ?? '').trim()
  if (!SEED_PATTERN.test(normalized)) return null
  try {
    const parsed = BigInt(normalized.startsWith('0x') || normalized.startsWith('0X') ? normalized : '0x' + normalized)
    return parsed >= 0n && parsed <= 0xffffffffffffffffn ? parsed : null
  } catch {
    return null
  }
}

interface Candidate {
  value: string
  source: ClaudeApiClientVersionSource
  fetchedAt: number | null
  seed: bigint
}
interface LineActivity {
  lastActivityAt: number
  rememberedTtlMs: number
}

export class ClaudeCodeVersionConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClaudeCodeVersionConfigurationError'
  }
}

/**
 * One process-wide reported version for both Claude lines.
 *
 * Registry reads never block a request. Unknown versions are deliberately not
 * candidates: without their version-bound cch seed they cannot be signed.
 */
export class ClaudeCodeVersionResolver {
  private readonly fetchFn: typeof fetch
  private readonly filePath: string
  private readonly now: () => number
  private readonly env: Readonly<Record<string, string | undefined>>
  private readonly refreshMs: number
  private readonly timeoutMs: number
  private readonly profiles: ReadonlyMap<string, bigint>
  private fetched: PersistedClaudeCodeClientVersion | null = null
  private cached: PersistedClaudeCodeClientVersion | null = null
  private warmed: Promise<void> | null = null
  private inflight: Promise<void> | null = null
  private lastAttemptAt: number | null = null
  private active: Candidate | null = null
  private readonly activity: Record<ClaudeCodeLine, LineActivity | undefined> = { claude: undefined, 'claude-api': undefined }

  constructor(options: ClaudeCodeVersionOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch
    this.filePath = options.filePath ?? claudeCodeClientVersionPath()
    this.now = options.now ?? Date.now
    this.env = options.env ?? process.env
    this.refreshMs = options.refreshMs ?? CLAUDE_CODE_CLIENT_VERSION_REFRESH_MS
    this.timeoutMs = options.timeoutMs ?? CLAUDE_CODE_CLIENT_VERSION_TIMEOUT_MS
    this.profiles = new Map((options.profiles ?? CLAUDE_CODE_VERSION_PROFILES).map(profile => [profile.version, profile.seed]))
  }

  /** Public DTO: no bigint crosses the host/client JSON boundary. */
  current(): ClaudeApiClientVersionDto {
    const selection = this.currentProfile()
    return { value: selection.value, source: selection.source, fetchedAt: selection.fetchedAt, pending: selection.pending }
  }

  /** Internal request selection, including the seed needed at the serialization seam. */
  currentProfile(): ClaudeCodeVersionSelection {
    const pinned = this.pinnedCandidate()
    if (pinned !== null) return { ...pinned, pending: null }
    const candidate = this.candidate()
    if (this.active === null) {
      this.active = candidate
      return { ...candidate, pending: null }
    }
    if (candidate.value !== this.active.value) {
      if (this.allLinesIdle()) {
        this.active = candidate
        for (const line of CLAUDE_CODE_LINES) {
          const activity = this.activity[line]
          if (activity !== undefined) activity.rememberedTtlMs = MIN_TTL_MS
        }
        return { ...candidate, pending: null }
      }
      return { ...this.active, pending: candidate.value }
    }
    return { ...this.active, pending: null }
  }

  /** Record one request. The optional line keeps the original API-only call shape compatible. */
  noteActivity(ttl: ClaudeApiCacheTtl, line: ClaudeCodeLine = 'claude-api'): void {
    const previous = this.activity[line]
    const ttlMs = ttl === '1h' ? HOUR_TTL_MS : MIN_TTL_MS
    this.activity[line] = {
      lastActivityAt: this.now(),
      rememberedTtlMs: Math.max(previous?.rememberedTtlMs ?? MIN_TTL_MS, ttlMs),
    }
  }

  warm(): Promise<void> {
    this.warmed ??= (async () => {
      try { this.cached = parseClaudeCodeClientVersion(JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown) }
      catch { this.cached = null }
    })()
    return this.warmed
  }

  async refresh(options: { force?: boolean } = {}): Promise<ClaudeApiClientVersionDto> {
    await this.warm()
    const now = this.now()
    if (options.force !== true && this.lastAttemptAt !== null && now - this.lastAttemptAt < this.refreshMs) return this.current()
    this.inflight ??= this.fetchLatest().finally(() => { this.inflight = null })
    await this.inflight
    return this.current()
  }

  start(): () => void {
    void this.refresh().catch(() => undefined)
    const timer = setInterval(() => { void this.refresh().catch(() => undefined) }, this.refreshMs)
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) (timer as { unref: () => void }).unref()
    return () => clearInterval(timer)
  }

  private knownSeed(version: string): bigint | undefined {
    return this.profiles.get(version)
  }

  private pinnedCandidate(): Candidate | null {
    const subscription = (this.env[CLAUDE_CODE_SUBSCRIPTION_CLI_VERSION_ENV] ?? '').trim()
    const api = (this.env[CLAUDE_CODE_API_CLI_VERSION_ENV] ?? '').trim()
    if (subscription !== '' && api !== '' && subscription !== api) {
      throw new ClaudeCodeVersionConfigurationError('DSH_CLAUDE_CLI_VERSION and DSH_CLAUDE_API_CLI_VERSION must match because both Claude lines share one client version.')
    }
    const value = sharedVersionPin ?? (subscription !== '' ? subscription : api)
    if (value === null || value === '') return null
    if (!isClaudeCodeCliVersion(value)) throw new ClaudeCodeVersionConfigurationError('The Claude Code client version pin must be a plain x.y.z release.')
    const known = this.knownSeed(value)
    if (known !== undefined) return { value, source: 'env', fetchedAt: null, seed: known }
    const seed = parseSeed(this.env[CLAUDE_CODE_CCH_SEED_ENV])
    if (seed === null) {
      throw new ClaudeCodeVersionConfigurationError('The pinned Claude Code version has no verified cch seed. Use a registered version or set DSH_CLAUDE_CCH_SEED together with the version pin.')
    }
    return { value, source: 'env', fetchedAt: null, seed }
  }

  private candidate(): Candidate {
    const record = this.fetched ?? this.cached
    if (record !== null) {
      const seed = this.knownSeed(record.version)
      if (seed !== undefined) return {
        value: record.version,
        source: this.fetched !== null ? 'npm' : 'cached',
        fetchedAt: record.fetchedAt,
        seed,
      }
    }
    const seed = this.knownSeed(CLAUDE_CODE_DEFAULT_CLI_VERSION) ?? CLAUDE_CODE_CCH_SEED
    return { value: CLAUDE_CODE_DEFAULT_CLI_VERSION, source: 'default', fetchedAt: null, seed }
  }

  private allLinesIdle(): boolean {
    const now = this.now()
    return CLAUDE_CODE_LINES.every(line => {
      const activity = this.activity[line]
      return activity === undefined || now - activity.lastActivityAt >= activity.rememberedTtlMs
    })
  }

  private async fetchLatest(): Promise<void> {
    this.lastAttemptAt = this.now()
    try {
      const response = await this.fetchFn(CLAUDE_CODE_NPM_LATEST_URL, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!response.ok) return
      const payload = await response.json() as unknown
      const version = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>).version : undefined
      if (!isClaudeCodeCliVersion(version) || this.knownSeed(version) === undefined) return
      const record: PersistedClaudeCodeClientVersion = { version, fetchedAt: this.now() }
      this.fetched = record
      this.cached = record
      await this.persist(record).catch(() => undefined)
    } catch {
      // Registry and storage failures leave the last verified value in force.
    }
  }

  private async persist(record: PersistedClaudeCodeClientVersion): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const temporary = this.filePath + '.tmp.' + process.pid
    try {
      await fs.writeFile(temporary, serializeClaudeCodeClientVersion(record), { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temporary, this.filePath)
    } finally {
      await fs.unlink(temporary).catch(() => undefined)
    }
  }
}

export { ClaudeCodeVersionResolver as ClaudeApiClientVersionResolver }
export type ClaudeApiClientVersionOptions = ClaudeCodeVersionOptions
