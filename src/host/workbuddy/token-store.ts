import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { SettingsProvider, SettingsScope } from '@deepseek-ai/dsh-settings'
import * as SettingsModule from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type { WorkBuddyReasoningEffort, WorkBuddyRegion } from '../../shared/workbuddy-contracts.ts'
import { WORKBUDDY_REASONING_EFFORTS } from '../../shared/workbuddy-contracts.ts'
import { dshHomeDir } from '../antigravity/token-store.ts'
import { DEFAULT_VISIBLE_MODEL_IDS } from './model-catalog.ts'
import {
  DEFAULT_DOMAIN,
  backendForDomain,
  isIntlDomain,
  regionForDomain,
} from './types.ts'

export const WORKBUDDY_PREFERENCES_NAMESPACE = 'dsh-workbuddy'

export type { WorkBuddyReasoningEffort }

/** Runtime membership test for one stored effort value. */
function isReasoningEffort(value: unknown): value is WorkBuddyReasoningEffort {
  return typeof value === 'string' && (WORKBUDDY_REASONING_EFFORTS as readonly string[]).includes(value)
}

/**
 * One WorkBuddy credential, parsed from a CodeBuddy desktop `*.info` file.
 *
 * These files are the IDE's own credential store, not this plugin's: the plugin
 * reads them so a user who is already signed in to the IDE needs no second
 * login. A refreshed token is written back so both clients stay valid instead of
 * racing each other with a rotating refresh token.
 */
export interface WorkBuddyCredentials {
  /** Bearer token for the chat and billing APIs. Host-only. */
  accessToken: string
  /** Rotating refresh token. Host-only. */
  refreshToken: string
  /** Unix milliseconds the access token stops being valid. */
  expiresAt: number
  /** Region the account belongs to; decides which backend serves it. */
  region: WorkBuddyRegion
  /** Auth domain recorded in the file, e.g. `copilot.tencent.com`. */
  domain: string
  /** Backend base URL derived from {@link domain}. */
  backend: string
  uid?: string
  nickname?: string
  uin?: string
  accountType?: string
  enterpriseId?: string
  /** Absolute path of the `*.info` file this credential came from. */
  sourceFile: string
  /** File modification time when it was read, so a stale cache is detectable. */
  sourceMtimeMs: number
}

export interface WorkBuddyModelSettings {
  enabled?: boolean
  enabledModelIds: string[]
  contextWindowOverrides: Record<string, number>
  defaultReasoningEffort: WorkBuddyReasoningEffort | null
}

export interface WorkBuddyPreferenceStore {
  status(): WorkBuddyModelSettings
  update(patch: {
    enabled?: boolean
    enabledModelIds?: string[]
    contextWindowOverrides?: Record<string, number>
    defaultReasoningEffort?: WorkBuddyReasoningEffort | null
  }): Promise<WorkBuddyModelSettings>
}

const DEFAULT_ENABLED_MODEL_IDS = [...DEFAULT_VISIBLE_MODEL_IDS]

/**
 * Bind the model selection to the DSH settings document, which is what the
 * settings service persists durably; the JSON file beside it remains the store
 * used when the plugin runs without a settings provider (headless tests).
 */
export function registerWorkBuddyPreferenceStore(
  settings?: SettingsProvider,
  fallbackStore = new FileModelSettingsStore(),
): WorkBuddyPreferenceStore {
  if (!settings) {
    return {
      status: () => ({
        enabled: true,
        enabledModelIds: [...DEFAULT_ENABLED_MODEL_IDS],
        contextWindowOverrides: {},
        defaultReasoningEffort: null,
      }),
      update: async (patch) => fallbackStore.updateSettings(patch),
    }
  }

  const ns = ((SettingsModule as unknown as Record<string, unknown>).settingsNamespace
    ? ((SettingsModule as unknown as Record<string, Function>).settingsNamespace)(WORKBUDDY_PREFERENCES_NAMESPACE)
    : WORKBUDDY_PREFERENCES_NAMESPACE) as unknown

  const scope = (settings.register as Function).call(settings, ns, z.object({
    enabled: z.boolean().default(true),
    enabledModelIds: z.array(z.string()).default([...DEFAULT_ENABLED_MODEL_IDS]),
    contextWindowOverrides: z.dict(z.number()).default({}),
    defaultReasoningEffort: z
      .union([
        ...WORKBUDDY_REASONING_EFFORTS.map((effort) => z.const(effort)),
        z.const(null),
      ])
      .default(null),
  })) as SettingsScope<{
    enabled: boolean
    enabledModelIds: string[]
    contextWindowOverrides: Record<string, number>
    defaultReasoningEffort: WorkBuddyReasoningEffort | null
  }>

  return {
    status: () => {
      const value = scope.get()
      return {
        enabled: value.enabled !== false,
        enabledModelIds: value.enabledModelIds,
        contextWindowOverrides: value.contextWindowOverrides,
        defaultReasoningEffort: value.defaultReasoningEffort,
      }
    },
    update: async (patch) => {
      const current = scope.get()
      const normalized = {
        enabled: patch.enabled !== undefined ? patch.enabled : (current.enabled !== false),
        enabledModelIds: patch.enabledModelIds ?? current.enabledModelIds,
        contextWindowOverrides: patch.contextWindowOverrides
          ? { ...current.contextWindowOverrides, ...patch.contextWindowOverrides }
          : current.contextWindowOverrides,
        defaultReasoningEffort: patch.defaultReasoningEffort !== undefined
          ? patch.defaultReasoningEffort
          : current.defaultReasoningEffort,
      }
      await scope.update(normalized)
      void fallbackStore.updateSettings(patch).catch(() => undefined)
      return normalized
    },
  }
}

/**
 * Credential directory the CodeBuddy desktop client writes to.
 *
 * `CODEBUDDY_AUTH_DIR` overrides it, matching the environment variable the
 * official tooling honours, which is also what makes the scan testable without
 * touching a real profile.
 */
export function codeBuddyAuthDir(): string {
  const override = process.env.CODEBUDDY_AUTH_DIR?.trim()
  if (override) return override
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA?.trim() || path.join(home, 'AppData', 'Local')
    return path.join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth')
  }
  const xdg = process.env.XDG_DATA_HOME?.trim() || path.join(home, '.local', 'share')
  return path.join(xdg, 'CodeBuddyExtension', 'Data', 'Public', 'auth')
}

/** Plugin settings file, used when no settings service is present. */
export function modelSettingsPath(): string {
  return path.join(dshHomeDir(), 'storages', 'workbuddy-models.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Parse one CodeBuddy `*.info` payload.
 *
 * Only the fields this plugin needs are read; the file also carries the IDE's
 * own account bookkeeping, which is deliberately left untouched. A file without
 * a usable access token is rejected rather than half-accepted, so the scanner
 * can move on to the next candidate.
 */
export function parseCredentialFile(value: unknown, sourceFile: string, sourceMtimeMs = 0): WorkBuddyCredentials {
  if (!isRecord(value)) throw new Error('WorkBuddy credential file is not an object')
  const auth = isRecord(value.auth) ? value.auth : undefined
  if (auth === undefined) throw new Error('WorkBuddy credential file has no auth block')

  const accessToken = readString(auth, 'accessToken')
  if (accessToken === undefined) throw new Error('WorkBuddy credential file has no access token')

  const account = isRecord(value.account) ? value.account : {}
  const domain = readString(auth, 'domain') ?? DEFAULT_DOMAIN
  const expiresAtRaw = auth.expiresAt
  const expiresAt = typeof expiresAtRaw === 'number' && Number.isFinite(expiresAtRaw) ? expiresAtRaw : 0

  return {
    accessToken,
    refreshToken: readString(auth, 'refreshToken') ?? '',
    expiresAt,
    region: regionForDomain(domain),
    domain,
    backend: backendForDomain(domain),
    uid: readString(account, 'uid'),
    nickname: readString(account, 'nickname'),
    uin: readString(account, 'uin'),
    accountType: readString(account, 'type'),
    enterpriseId: readString(account, 'enterpriseId'),
    sourceFile,
    sourceMtimeMs,
  }
}

/** Whether a credential is at or near expiry; refreshed a minute early. */
export function isExpired(credentials: WorkBuddyCredentials, now = Date.now()): boolean {
  if (!Number.isFinite(credentials.expiresAt) || credentials.expiresAt <= 0) return false
  return now >= credentials.expiresAt - 60_000
}

/**
 * Candidate ordering for the scanned credential files.
 *
 * A user's auth directory accumulates timestamped snapshots beside the live
 * file, and the live one is not always the newest. Preference order is: the
 * plain `workbuddy-desktop.info` / `codebuddy-desktop.info` files first, then
 * the newest `expiresAt` among the timestamped snapshots. Picking purely by
 * mtime selected a stale snapshot during development, so the token's own
 * expiry is what decides.
 */
function isCanonicalFile(name: string): boolean {
  return /^(workbuddy|codebuddy)-desktop(-\w+)?\.info$/i.test(name)
}

/**
 * Scan the CodeBuddy auth directory for usable credentials.
 *
 * Every `*.info` file is considered; unreadable or malformed ones are skipped
 * rather than failing the whole scan, because the directory routinely holds
 * expired snapshots next to the live credential.
 */
export async function scanCredentials(dir = codeBuddyAuthDir()): Promise<WorkBuddyCredentials[]> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error(`WorkBuddy credential directory could not be read: ${dir}`)
  }

  const found: WorkBuddyCredentials[] = []
  for (const name of names) {
    if (!name.endsWith('.info')) continue
    const file = path.join(dir, name)
    try {
      const stats = await fs.stat(file)
      if (!stats.isFile()) continue
      const raw = await fs.readFile(file, 'utf8')
      found.push(parseCredentialFile(JSON.parse(raw) as unknown, file, stats.mtimeMs))
    } catch {
      // A malformed or concurrently-rewritten snapshot is skipped; the live
      // file is still picked up by its own iteration.
      continue
    }
  }

  return found.sort((a, b) => {
    const aCanonical = isCanonicalFile(path.basename(a.sourceFile)) ? 1 : 0
    const bCanonical = isCanonicalFile(path.basename(b.sourceFile)) ? 1 : 0
    if (aCanonical !== bCanonical) return bCanonical - aCanonical
    return b.expiresAt - a.expiresAt
  })
}

/**
 * Credential store backed by the CodeBuddy desktop client's own auth files.
 *
 * The plugin does not own these files, so there is nothing to encrypt here: the
 * secret is the IDE's, already on disk, and the only write this store performs
 * is an atomic write-back of a refreshed token so the IDE does not lose its
 * session. Tokens are never sent to a browser.
 */
export class FileCredentialStore {
  private cached: WorkBuddyCredentials | null = null
  private scannedAt = 0
  /** Serializes refresh/write-back so two concurrent calls cannot interleave. */
  private refreshInFlight: Promise<WorkBuddyCredentials> | null = null

  constructor(
    private readonly dir = codeBuddyAuthDir(),
    /** How long a scan result is reused before the directory is re-read. */
    private readonly cacheTtlMs = 15_000,
  ) {}

  /** Directory this store scans. */
  directory(): string {
    return this.dir
  }

  /** Human-readable storage description for the settings card. */
  path(): string {
    return this.dir
  }

  /** Read the preferred credential, or `null` when none is usable. */
  async read(options: { force?: boolean } = {}): Promise<WorkBuddyCredentials | null> {
    const fresh = this.cached !== null
      && !options.force
      && Date.now() - this.scannedAt < this.cacheTtlMs
      && await this.isStillCurrent(this.cached)
    if (fresh) return this.cached

    const candidates = await scanCredentials(this.dir)
    this.scannedAt = Date.now()
    this.cached = candidates[0] ?? null
    return this.cached
  }

  /** Whether a cached credential's source file is unchanged on disk. */
  private async isStillCurrent(credentials: WorkBuddyCredentials): Promise<boolean> {
    try {
      const stats = await fs.stat(credentials.sourceFile)
      return stats.mtimeMs === credentials.sourceMtimeMs
    } catch {
      return false
    }
  }

  /** All usable credentials, best candidate first; the card lists them. */
  async list(): Promise<WorkBuddyCredentials[]> {
    return scanCredentials(this.dir)
  }

  /** Forget the cached scan; the next read re-reads the directory. */
  invalidate(): void {
    this.cached = null
    this.scannedAt = 0
  }

  /**
   * Return a credential whose access token is valid, refreshing it first when
   * it is at or near expiry.
   *
   * Concurrent callers share one refresh: the refresh token rotates, so two
   * simultaneous refreshes would invalidate each other.
   */
  async ensureFresh(
    credentials: WorkBuddyCredentials,
    refresh: (current: WorkBuddyCredentials) => Promise<WorkBuddyCredentials>,
  ): Promise<WorkBuddyCredentials> {
    if (!isExpired(credentials)) return credentials
    if (this.refreshInFlight !== null) return this.refreshInFlight
    const operation = (async () => {
      const refreshed = await refresh(credentials)
      await this.writeBack(refreshed)
      this.cached = refreshed
      this.scannedAt = Date.now()
      return refreshed
    })()
    this.refreshInFlight = operation
    try {
      return await operation
    } finally {
      if (this.refreshInFlight === operation) this.refreshInFlight = null
    }
  }

  /**
   * Persist a refreshed token back into the IDE's own credential file.
   *
   * Only the `auth` block is rewritten, and the write is atomic so a crash
   * cannot leave the IDE with a half-written file. A failure here is not fatal
   * to the in-flight request: the refreshed token still works for this process,
   * and the next scan simply finds the older token on disk.
   */
  async writeBack(credentials: WorkBuddyCredentials): Promise<void> {
    try {
      const raw = await fs.readFile(credentials.sourceFile, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (!isRecord(parsed) || !isRecord(parsed.auth)) return
      parsed.auth.accessToken = credentials.accessToken
      if (credentials.refreshToken !== '') parsed.auth.refreshToken = credentials.refreshToken
      parsed.auth.expiresAt = credentials.expiresAt
      parsed.auth.lastRefreshTime = Date.now()
      const tmp = `${credentials.sourceFile}.tmp.${process.pid}`
      await fs.writeFile(tmp, JSON.stringify(parsed, null, 2), 'utf8')
      await fs.rename(tmp, credentials.sourceFile)
      // The write changed the file, so the cached mtime must follow it or the
      // very next read would consider the cache stale and rescan.
      const stats = await fs.stat(credentials.sourceFile)
      credentials.sourceMtimeMs = stats.mtimeMs
    } catch {
      // Best-effort: a read-only or locked profile must not break a call.
    }
  }
}

/** Plain-JSON model settings used when the settings service is unavailable. */
export class FileModelSettingsStore {
  constructor(private readonly filePath = modelSettingsPath()) {}

  path(): string {
    return this.filePath
  }

  async read(): Promise<WorkBuddyModelSettings> {
    try {
      const content = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(content) as unknown
      if (isRecord(parsed)) {
        const enabledModelIds = Array.isArray(parsed.enabledModelIds)
          ? parsed.enabledModelIds.filter((id): id is string => typeof id === 'string')
          : [...DEFAULT_ENABLED_MODEL_IDS]
        const contextWindowOverrides =
          isRecord(parsed.contextWindowOverrides)
            ? Object.fromEntries(
                Object.entries(parsed.contextWindowOverrides)
                  .filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
              )
            : {}
        const defaultReasoningEffort = isReasoningEffort(parsed.defaultReasoningEffort)
          ? parsed.defaultReasoningEffort
          : null
        return {
          enabled: parsed.enabled !== false,
          enabledModelIds,
          contextWindowOverrides,
          defaultReasoningEffort,
        }
      }
    } catch {
      // A missing or unreadable settings file falls back to the shipped defaults.
    }
    return {
      enabled: true,
      enabledModelIds: [...DEFAULT_ENABLED_MODEL_IDS],
      contextWindowOverrides: {},
      defaultReasoningEffort: null,
    }
  }

  async write(settings: WorkBuddyModelSettings): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp.${Date.now()}`
    await fs.writeFile(tmp, JSON.stringify(settings, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
  }

  async updateSettings(patch: {
    enabled?: boolean
    enabledModelIds?: string[]
    contextWindowOverrides?: Record<string, number>
    defaultReasoningEffort?: WorkBuddyReasoningEffort | null
  }): Promise<WorkBuddyModelSettings> {
    const current = await this.read()
    const next: WorkBuddyModelSettings = {
      ...current,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.enabledModelIds !== undefined ? { enabledModelIds: patch.enabledModelIds } : {}),
      ...(patch.contextWindowOverrides !== undefined
        ? { contextWindowOverrides: { ...current.contextWindowOverrides, ...patch.contextWindowOverrides } }
        : {}),
      ...(patch.defaultReasoningEffort !== undefined
        ? { defaultReasoningEffort: patch.defaultReasoningEffort }
        : {}),
    }
    await this.write(next)
    return next
  }
}

export { isIntlDomain }
