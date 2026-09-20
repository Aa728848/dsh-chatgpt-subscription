import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { SettingsProvider, SettingsScope } from '@deepseek-ai/dsh-settings'
import * as SettingsModule from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type { WorkBuddyReasoningEffort, WorkBuddyRegion } from '../../shared/workbuddy-contracts.ts'
import { WORKBUDDY_REASONING_EFFORTS } from '../../shared/workbuddy-contracts.ts'
import { dshHomeDir } from '../antigravity/token-store.ts'
import { DEFAULT_VISIBLE_MODEL_IDS } from './model-catalog.ts'
import type { CredentialStore } from '../token-store.ts'
import { WindowsDpapiCredentialStore } from '../token-store-windows.ts'
import { MacKeychainCredentialStore } from '../token-store-macos.ts'
import { SecretServiceCredentialStore } from '../credential-store-secret-service.ts'
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
  /** Which store owns the secret; only managed credentials may be deleted. */
  source: 'desktop' | 'managed'
}

export interface WorkBuddyModelSettings {
  enabled?: boolean
  enabledModelIds: string[]
  contextWindowOverrides: Record<string, number>
  defaultReasoningEffort: WorkBuddyReasoningEffort | null
  /** Stable account key selected by the user; null keeps automatic selection. */
  selectedAccountId: string | null
  /** Desktop accounts hidden from this plugin without deleting CodeBuddy files. */
  hiddenAccountIds: string[]
}

export interface WorkBuddyPreferenceStore {
  status(): WorkBuddyModelSettings
  update(patch: {
    enabled?: boolean
    enabledModelIds?: string[]
    contextWindowOverrides?: Record<string, number>
    defaultReasoningEffort?: WorkBuddyReasoningEffort | null
    selectedAccountId?: string | null
    hiddenAccountIds?: string[]
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
        selectedAccountId: null,
        hiddenAccountIds: [],
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
    selectedAccountId: z.union([z.string(), z.const(null)]).default(null),
    hiddenAccountIds: z.array(z.string()).default([]),
  })) as SettingsScope<{
    enabled: boolean
    enabledModelIds: string[]
    contextWindowOverrides: Record<string, number>
    defaultReasoningEffort: WorkBuddyReasoningEffort | null
    selectedAccountId: string | null
    hiddenAccountIds: string[]
  }>

  return {
    status: () => {
      const value = scope.get()
      return {
        enabled: value.enabled !== false,
        enabledModelIds: value.enabledModelIds,
        contextWindowOverrides: value.contextWindowOverrides,
        defaultReasoningEffort: value.defaultReasoningEffort,
        selectedAccountId: value.selectedAccountId,
        hiddenAccountIds: value.hiddenAccountIds,
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
        selectedAccountId: patch.selectedAccountId !== undefined
          ? patch.selectedAccountId
          : current.selectedAccountId,
        hiddenAccountIds: patch.hiddenAccountIds ?? current.hiddenAccountIds,
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

/** Encrypted account pool for credentials added through this plugin. */
export function managedCredentialsPath(): string {
  return path.join(dshHomeDir(), 'storages', 'workbuddy-accounts.json')
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
    source: 'desktop',
  }
}

/** Whether a credential is at or near expiry; refreshed a minute early. */
export function isExpired(credentials: WorkBuddyCredentials, now = Date.now()): boolean {
  if (!Number.isFinite(credentials.expiresAt) || credentials.expiresAt <= 0) return false
  return now >= credentials.expiresAt - 60_000
}

/**
 * Stable public key for selecting an account without exposing a token or tying
 * the preference to a timestamped snapshot filename.
 */
export function workBuddyAccountId(credentials: Pick<WorkBuddyCredentials, 'region' | 'uid' | 'uin' | 'nickname' | 'domain'>): string {
  const identity = credentials.uid || credentials.uin || credentials.nickname || credentials.domain
  return `${credentials.region}:${identity}`
}

/** Strict parser for credentials owned by the plugin's encrypted pool. */
export function parseManagedCredentials(value: unknown): WorkBuddyCredentials[] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.accounts)) {
    throw new Error('WorkBuddy managed credential pool is invalid')
  }
  return value.accounts.map((item) => {
    if (!isRecord(item)) throw new Error('WorkBuddy managed account is invalid')
    const accessToken = readString(item, 'accessToken')
    if (accessToken === undefined) throw new Error('WorkBuddy managed account has no access token')
    const domain = readString(item, 'domain') ?? DEFAULT_DOMAIN
    const expiresAt = typeof item.expiresAt === 'number' && Number.isFinite(item.expiresAt) ? item.expiresAt : 0
    return {
      accessToken,
      refreshToken: readString(item, 'refreshToken') ?? '',
      expiresAt,
      region: regionForDomain(domain),
      domain,
      backend: backendForDomain(domain),
      uid: readString(item, 'uid'),
      nickname: readString(item, 'nickname'),
      uin: readString(item, 'uin'),
      accountType: readString(item, 'accountType'),
      enterpriseId: readString(item, 'enterpriseId'),
      sourceFile: '',
      sourceMtimeMs: 0,
      source: 'managed',
    }
  })
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

function managedCredentialAccount(filePath: string): string {
  return createHash('sha256').update(path.resolve(filePath)).digest('hex')
}

function createManagedCredentialBackend(filePath: string): CredentialStore<{ version: 1; accounts: WorkBuddyCredentials[] }> {
  const parse = (value: unknown) => ({ version: 1 as const, accounts: parseManagedCredentials(value) })
  if (process.platform === 'win32') return new WindowsDpapiCredentialStore(`${filePath}.dpapi`, parse)
  if (process.platform === 'darwin') return new MacKeychainCredentialStore('dsh-workbuddy-accounts', managedCredentialAccount(filePath), parse)
  if (process.platform === 'linux') return new SecretServiceCredentialStore('dsh-workbuddy-accounts', managedCredentialAccount(filePath), parse)
  throw new Error('WorkBuddy encrypted account storage requires Windows, macOS, or Linux.')
}

const managedOperations = new Map<string, Promise<void>>()

/** Encrypted credentials added through the WorkBuddy settings page. */
export class ManagedCredentialStore {
  constructor(
    private readonly filePath = managedCredentialsPath(),
    private readonly backend: CredentialStore<{ version: 1; accounts: WorkBuddyCredentials[] }> = createManagedCredentialBackend(filePath),
  ) {}

  path(): string {
    if (process.platform === 'win32') return `${this.filePath}.dpapi`
    const kind = process.platform === 'darwin' ? 'Keychain' : 'Secret Service'
    return `${kind}: dsh-workbuddy-accounts/${managedCredentialAccount(this.filePath)}`
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(this.filePath)
    const result = (managedOperations.get(key) || Promise.resolve()).then(operation)
    const settled = result.then(() => undefined, () => undefined)
    managedOperations.set(key, settled)
    void settled.then(() => {
      if (managedOperations.get(key) === settled) managedOperations.delete(key)
    })
    return result
  }

  async list(): Promise<WorkBuddyCredentials[]> {
    return this.serialize(async () => (await this.backend.load())?.accounts ?? [])
  }

  async add(credentials: WorkBuddyCredentials): Promise<void> {
    return this.serialize(async () => {
      const current = (await this.backend.load())?.accounts ?? []
      const normalized: WorkBuddyCredentials = { ...credentials, source: 'managed', sourceFile: '', sourceMtimeMs: 0 }
      const id = workBuddyAccountId(normalized)
      const accounts = [...current.filter((candidate) => workBuddyAccountId(candidate) !== id), normalized]
      const payload = { version: 1 as const, accounts }
      await this.backend.save(payload)
      const restored = await this.backend.load()
      if (!isDeepStrictEqual(restored, payload)) throw new Error('WorkBuddy encrypted account verification failed')
    })
  }

  async update(credentials: WorkBuddyCredentials): Promise<void> {
    return this.add(credentials)
  }

  async delete(accountId: string): Promise<boolean> {
    return this.serialize(async () => {
      const current = (await this.backend.load())?.accounts ?? []
      const accounts = current.filter((candidate) => workBuddyAccountId(candidate) !== accountId)
      if (accounts.length === current.length) return false
      if (accounts.length === 0) await this.backend.clear()
      else await this.backend.save({ version: 1, accounts })
      return true
    })
  }
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
  /** Serializes refresh/write-back per account; different accounts never share a token. */
  private readonly refreshInFlight = new Map<string, Promise<WorkBuddyCredentials>>()

  constructor(
    private readonly dir = codeBuddyAuthDir(),
    /** How long a scan result is reused before the directory is re-read. */
    private readonly cacheTtlMs = 15_000,
    private readonly managed = new ManagedCredentialStore(),
  ) {}

  /** Directory this store scans. */
  directory(): string {
    return this.dir
  }

  /** Human-readable storage description for the settings card. */
  path(): string {
    return this.dir
  }

  managedPath(): string {
    return this.managed.path()
  }

  /** Read the selected credential, or the best visible candidate in automatic mode. */
  async read(options: { force?: boolean; accountId?: string | null; hiddenAccountIds?: readonly string[] } = {}): Promise<WorkBuddyCredentials | null> {
    const requested = options.accountId ?? null
    const hidden = new Set(options.hiddenAccountIds ?? [])
    const cachedMatches = this.cached !== null
      && !hidden.has(workBuddyAccountId(this.cached))
      && (requested === null || workBuddyAccountId(this.cached) === requested)
    const fresh = cachedMatches
      && !options.force
      && Date.now() - this.scannedAt < this.cacheTtlMs
      && await this.isStillCurrent(this.cached!)
    if (fresh) return this.cached

    const candidates = await this.list()
    this.scannedAt = Date.now()
    this.cached = requested === null
      ? (candidates.find((candidate) => !hidden.has(workBuddyAccountId(candidate))) ?? null)
      : (hidden.has(requested) ? null : candidates.find((candidate) => workBuddyAccountId(candidate) === requested) ?? null)
    return this.cached
  }

  /** Whether a cached credential's source file is unchanged on disk. */
  private async isStillCurrent(credentials: WorkBuddyCredentials): Promise<boolean> {
    // Managed credentials have no source file; their encrypted pool is updated
    // through this store and invalidates the cache after every add/delete.
    if (credentials.source === 'managed') return true
    try {
      const stats = await fs.stat(credentials.sourceFile)
      return stats.mtimeMs === credentials.sourceMtimeMs
    } catch {
      return false
    }
  }

  /**
   * All distinct usable accounts, best credential first.
   *
   * The desktop directory keeps historical snapshots. They are credentials for
   * the same account, not additional account choices, so only the first (best)
   * candidate for each stable account id is exposed.
   */
  async list(): Promise<WorkBuddyCredentials[]> {
    const distinct = new Map<string, WorkBuddyCredentials>()
    // Plugin-managed credentials win when the same account also appears in the
    // desktop directory: only the plugin-owned copy may be deleted.
    for (const candidate of await this.managed.list()) {
      distinct.set(workBuddyAccountId(candidate), candidate)
    }
    for (const candidate of await scanCredentials(this.dir)) {
      const id = workBuddyAccountId(candidate)
      if (!distinct.has(id)) distinct.set(id, candidate)
    }
    return [...distinct.values()]
  }

  /**
   * Desktop credentials only, best first.
   *
   * The account pool adopts these so the IDE's own sign-ins take part in
   * scheduling. Unlike {@link list} this never mixes in managed accounts:
   * only the desktop set is re-adopted when the IDE changes its directory.
   */
  async discoverDesktopCredentials(): Promise<WorkBuddyCredentials[]> {
    return scanCredentials(this.dir)
  }

  /**
   * Re-read one desktop credential file.
   *
   * A pooled desktop account must serve the IDE's current token rather than
   * the copy taken when it was adopted, because the IDE rotates that token on
   * its own schedule. Returns null when the file is gone or unreadable.
   */
  async readDesktopFile(filePath: string): Promise<WorkBuddyCredentials | null> {
    try {
      const stats = await fs.stat(filePath)
      if (!stats.isFile()) return null
      const raw = await fs.readFile(filePath, 'utf8')
      return parseCredentialFile(JSON.parse(raw) as unknown, filePath, stats.mtimeMs)
    } catch {
      return null
    }
  }

  async addManaged(credentials: WorkBuddyCredentials): Promise<void> {
    await this.managed.add(credentials)
    this.invalidate()
  }

  async deleteManaged(accountId: string): Promise<boolean> {
    const removed = await this.managed.delete(accountId)
    if (removed) this.invalidate()
    return removed
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
    const accountId = workBuddyAccountId(credentials)
    const pending = this.refreshInFlight.get(accountId)
    if (pending !== undefined) return pending
    const operation = (async () => {
      const refreshed = await refresh(credentials)
      if (credentials.source === 'managed') await this.managed.update(refreshed)
      else await this.writeBack(refreshed)
      if (this.cached !== null && workBuddyAccountId(this.cached) === accountId) {
        this.cached = refreshed
        this.scannedAt = Date.now()
      }
      return refreshed
    })()
    this.refreshInFlight.set(accountId, operation)
    try {
      return await operation
    } finally {
      if (this.refreshInFlight.get(accountId) === operation) this.refreshInFlight.delete(accountId)
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
      // The IDE keeps this file private. A temporary created with the process
      // umask and renamed over it would widen its permissions on POSIX, so the
      // original mode is carried over onto the replacement.
      const sourceMode = process.platform === 'win32'
        ? undefined
        : (await fs.stat(credentials.sourceFile)).mode & 0o777
      const tmp = `${credentials.sourceFile}.tmp.${process.pid}`
      try {
        await fs.writeFile(tmp, JSON.stringify(parsed, null, 2), {
          encoding: 'utf8',
          ...(sourceMode === undefined ? {} : { mode: sourceMode }),
        })
        await fs.rename(tmp, credentials.sourceFile)
      } finally {
        // The temporary holds the same tokens, so a failed rename must not
        // leave it behind next to the IDE's file.
        await fs.unlink(tmp).catch(() => undefined)
      }
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
          selectedAccountId: typeof parsed.selectedAccountId === 'string' && parsed.selectedAccountId !== ''
            ? parsed.selectedAccountId
            : null,
          hiddenAccountIds: Array.isArray(parsed.hiddenAccountIds)
            ? parsed.hiddenAccountIds.filter((id): id is string => typeof id === 'string')
            : [],
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
      selectedAccountId: null,
      hiddenAccountIds: [],
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
    selectedAccountId?: string | null
    hiddenAccountIds?: string[]
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
      ...(patch.selectedAccountId !== undefined
        ? { selectedAccountId: patch.selectedAccountId }
        : {}),
      ...(patch.hiddenAccountIds !== undefined
        ? { hiddenAccountIds: patch.hiddenAccountIds }
        : {}),
    }
    await this.write(next)
    return next
  }
}

export { isIntlDomain }
