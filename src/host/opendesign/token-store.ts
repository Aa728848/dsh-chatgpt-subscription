import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { CredentialStore } from '../token-store.ts'
import { WindowsDpapiCredentialStore } from '../token-store-windows.ts'
import { MacKeychainCredentialStore } from '../token-store-macos.ts'
import { SecretServiceCredentialStore } from '../credential-store-secret-service.ts'
import { dshHomeDir } from '../common/home.ts'
import {
  DEFAULT_BASE_URL,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  PROVIDER_ID,
} from './types.ts'

/**
 * Shared non-secret display facts of one credential.
 */
interface OpenDesignCredentialBase {
  /** User-chosen label so several accounts are distinguishable. */
  alias?: string
  /** Unix milliseconds the credential was added to the pool. */
  addedAt?: number
  /** Per-account gateway override; empty means the line's own base URL. */
  baseURL?: string
}

/**
 * One stored OpenDesign API key.
 *
 * The gateway authenticates with a static key, so there is no refresh token and
 * nothing expires. The key is host-only and never crosses to a browser; the
 * settings card renders the alias and the account row, never this value.
 */
export interface OpenDesignApiKeyCredentials extends OpenDesignCredentialBase {
  /** Present on every record this line writes; absent records predate the marker. */
  kind?: 'api-key'
  /** Host-only bearer key, created in the OpenDesign Cloud console. */
  apiKey: string
}

/**
 * One account signed in through browser device authorization.
 *
 * The approval issues a pair (upstream issue nexu-io/open-design#8870): a
 * `vela_ctrl_…` control key that reads the control plane (wallet balance and
 * friends) and an `sk-amr-…` runtime key that serves the link gateway. Neither
 * carries a published expiry, so there is no refresh lifecycle here — a revoked
 * key is replaced by signing in again, not refreshed.
 */
export interface OpenDesignOAuthCredentials extends OpenDesignCredentialBase {
  kind: 'oauth'
  /** Control-plane bearer (`vela_ctrl_…`): wallet reads, never chat. */
  controlKey: string
  /** Link-gateway bearer (`sk-amr-…`): chat and the live catalog. */
  runtimeKey: string
  /** The account's identity as the approval returned it. */
  user?: { id?: string; email?: string; name?: string; plan?: string }
}

export type OpenDesignCredentials = OpenDesignApiKeyCredentials | OpenDesignOAuthCredentials

/** Whether one credential is a device-flow session rather than a pasted key. */
export function isOpenDesignOAuthCredentials(credentials: OpenDesignCredentials): credentials is OpenDesignOAuthCredentials {
  return credentials.kind === 'oauth'
}

/** The chat bearer (`Authorization` value) for one credential. */
export function bearerFor(credentials: OpenDesignCredentials): string {
  return isOpenDesignOAuthCredentials(credentials) ? credentials.runtimeKey : credentials.apiKey
}

/** The control-plane bearer for one credential, when it has one. */
export function controlKeyFor(credentials: OpenDesignCredentials): string | undefined {
  return isOpenDesignOAuthCredentials(credentials) ? credentials.controlKey : undefined
}

/**
 * Stable identity of one key.
 *
 * The console hands the user a bare key and the gateway answers no profile for
 * it, so the key's own digest is the only identity available. It is never
 * written anywhere: it exists to tell two pasted keys apart inside the pool
 * document, and it is not a credential and cannot be used as one.
 */
export function credentialsIdentity(credentials: OpenDesignCredentials): string {
  if (isOpenDesignOAuthCredentials(credentials)) {
    if (credentials.user?.id !== undefined && credentials.user.id !== '') return `amr-user:${credentials.user.id}`
    if (credentials.user?.email !== undefined && credentials.user.email !== '') return `amr-email:${credentials.user.email.toLowerCase()}`
    return `ctrl:${createHash('sha256').update(credentials.controlKey).digest('hex')}`
  }
  return `key:${createHash('sha256').update(credentials.apiKey).digest('hex')}`
}

/** The user-facing label for one credential, when it states one. */
export function credentialsLabel(credentials: OpenDesignCredentials): string | undefined {
  if (isOpenDesignOAuthCredentials(credentials)) {
    return credentials.user?.name?.trim() || credentials.user?.email?.trim() || undefined
  }
  return credentials.alias?.trim() || undefined
}

/** One catalog entry, as the last successful gateway listing published it. */
export interface OpenDesignCatalogModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  efforts?: string[]
  input?: string[]
}

/**
 * Everything this line stores besides credentials.
 *
 * `enabledModelIds === null` is "no filter": every known model, including ones
 * a later sync adds. An array is an explicit selection, and an empty one
 * switches every model off. Modelling "all" as null rather than as an explicit
 * all-ids list means a model the service adds later is not silently hidden by a
 * selection made before it existed.
 *
 * The synced catalog lives in this same document (`catalogModels`), so a
 * restart rehydrates it from a local read with no network in the path — the
 * picker never has to wait on the gateway to show what was already discovered.
 */
export interface OpenDesignModelSettings {
  enabled: boolean
  baseURL: string
  enabledModelIds: string[] | null
  catalogModels: OpenDesignCatalogModel[]
  /** Models the route must not advertise even though it still knows them. */
  hiddenModels: string[]
  /**
   * The ids the last successful catalog scan really returned; `null` before one.
   *
   * The PLAN, not the line, decides which models are served, and the ids a scan
   * returns ARE that decision — the gateway listing "supplies the ids this key's
   * plan really serves" (see the sync's own comment in routes.ts). Three states,
   * kept apart on purpose:
   *
   * - `null`: no scan has ever succeeded. Nobody measured anything, so nothing is
   *   filtered on this ground and a fresh install advertises the shipped table.
   * - an array: the union of every id the last successful scan returned. An id
   *   outside it is not served by this plan and is not advertised, unless the user
   *   forced it visible ({@link forceVisibleModels}).
   * - `[]` stays an array for the same reason an empty `enabledModelIds` does: a
   *   measurement that returned nothing must not decay into "never measured",
   *   which would silently re-show every model.
   *
   * A failed scan never clears it — the previous measurement stands rather than a
   * network error switching the filter off.
   */
  servedModelIds: string[] | null
  /** Ids the user force-shows even though the plan's last scan did not list them. */
  forceVisibleModels: string[]
  /** Per-model context-window override; absent uses the resolved window. */
  contextWindowOverrides: Record<string, number>
  defaultContextWindow: number
  defaultMaxTokens: number
  maxConcurrentRequests: number
  streamIdleTimeoutMs: number
}

export interface OpenDesignPreferenceStore {
  status(): OpenDesignModelSettings
  read(): Promise<OpenDesignModelSettings>
  update(patch: Partial<OpenDesignModelSettings>): Promise<OpenDesignModelSettings>
}

export function credentialPath(): string {
  return path.join(dshHomeDir(), 'storages', 'opendesign-credentials.json')
}

export function modelSettingsPath(): string {
  return path.join(dshHomeDir(), 'storages', 'opendesign-models.json')
}

/** Stable keyring account name for one credential file. */
function credentialAccount(filePath: string): string {
  return createHash('sha256').update(path.resolve(filePath)).digest('hex')
}

function optionalString(record: Record<string, unknown>, key: string, what: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`OpenDesign ${what} field is invalid`)
  return value
}

/** Validate one stored credential: a device-flow session or a static API key. */
export function parseOpenDesignCredentials(value: unknown): OpenDesignCredentials {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('OpenDesign credential payload is invalid')
  }
  const record = value as Record<string, unknown>
  const alias = optionalString(record, 'alias', 'credential')
  const baseURL = optionalString(record, 'baseURL', 'credential')
  const addedAt = typeof record.addedAt === 'number' && Number.isFinite(record.addedAt) ? record.addedAt : undefined
  const common = {
    ...(alias === undefined ? {} : { alias }),
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(addedAt === undefined ? {} : { addedAt }),
  }

  const controlKey = record.controlKey
  const runtimeKey = record.runtimeKey
  if (typeof controlKey === 'string' && controlKey.trim() !== ''
    && typeof runtimeKey === 'string' && runtimeKey.trim() !== '') {
    // A 200 carrying no credential is not a credential: both halves of the pair
    // must be present, or the record is not a usable session at all.
    const credentials: OpenDesignOAuthCredentials = {
      kind: 'oauth',
      controlKey: controlKey.trim(),
      runtimeKey: runtimeKey.trim(),
      ...common,
    }
    if (typeof record.user === 'object' && record.user !== null && !Array.isArray(record.user)) {
      const user = record.user as Record<string, unknown>
      credentials.user = {
        ...(typeof user.id === 'string' && user.id !== '' ? { id: user.id } : {}),
        ...(typeof user.email === 'string' && user.email !== '' ? { email: user.email } : {}),
        ...(typeof user.name === 'string' && user.name !== '' ? { name: user.name } : {}),
        ...(typeof user.plan === 'string' && user.plan !== '' ? { plan: user.plan } : {}),
      }
    }
    return credentials
  }

  const apiKey = record.apiKey
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error('OpenDesign credential is missing its API key')
  }
  return {
    ...(record.kind === 'api-key' ? { kind: 'api-key' as const } : {}),
    apiKey: apiKey.trim(),
    ...common,
  }
}

/**
 * The OS credential backend for this platform.
 *
 * Same matrix as every other line here: DPAPI on Windows, Keychain on macOS,
 * Secret Service on Linux. The plaintext JSON file is a migration source only,
 * never the live store.
 */
function createCredentialBackend(filePath: string): CredentialStore<OpenDesignCredentials> {
  if (process.platform === 'win32') {
    return new WindowsDpapiCredentialStore(`${filePath}.dpapi`, parseOpenDesignCredentials)
  }
  if (process.platform === 'darwin') {
    return new MacKeychainCredentialStore(PROVIDER_ID, credentialAccount(filePath), parseOpenDesignCredentials)
  }
  if (process.platform === 'linux') {
    return new SecretServiceCredentialStore(PROVIDER_ID, credentialAccount(filePath), parseOpenDesignCredentials)
  }
  throw new Error('OpenDesign credential storage requires Windows, macOS, or Linux.')
}

/** Encrypted credential store for the single-key (pre-pool) configuration. */
export class FileCredentialStore {
  constructor(
    private readonly filePath = credentialPath(),
    private readonly backend: CredentialStore<OpenDesignCredentials> = createCredentialBackend(filePath),
  ) {}

  path(): string {
    return this.filePath
  }

  async read(): Promise<OpenDesignCredentials | null> {
    return this.backend.load()
  }

  async write(credentials: OpenDesignCredentials): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await this.backend.save(credentials)
  }

  async clear(): Promise<void> {
    await this.backend.clear()
  }
}

function readNumberOverrides(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const overrides: Record<string, number> = {}
  for (const [model, size] of Object.entries(value as Record<string, unknown>)) {
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) continue
    overrides[model] = size
  }
  return overrides
}

function readCatalogModels(value: unknown): OpenDesignCatalogModel[] {
  if (!Array.isArray(value)) return []
  const models: OpenDesignCatalogModel[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (typeof record.id !== 'string' || record.id.length === 0) continue
    const model: OpenDesignCatalogModel = { id: record.id }
    if (typeof record.name === 'string' && record.name.length > 0) model.name = record.name
    if (typeof record.contextWindow === 'number' && Number.isSafeInteger(record.contextWindow) && record.contextWindow > 0) model.contextWindow = record.contextWindow
    if (typeof record.maxTokens === 'number' && Number.isSafeInteger(record.maxTokens) && record.maxTokens > 0) model.maxTokens = record.maxTokens
    if (typeof record.reasoning === 'boolean') model.reasoning = record.reasoning
    if (Array.isArray(record.efforts)) {
      const efforts = record.efforts.filter((item): item is string => typeof item === 'string' && item !== '')
      if (efforts.length > 0) model.efforts = efforts
    }
    if (Array.isArray(record.input)) model.input = record.input.filter((item): item is string => typeof item === 'string')
    models.push(model)
  }
  return models
}

/**
 * One stored id list, normalized: non-empty strings only, deduplicated, and
 * `null` when the value is not a list at all.
 *
 * `null` and `[]` stay distinct here; see the tri-state note on
 * {@link OpenDesignModelSettings.servedModelIds}.
 */
function readIdList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const ids: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const id = entry.trim()
    if (id === '' || ids.includes(id)) continue
    ids.push(id)
  }
  return ids
}

function positiveInteger(value: unknown, fallback: number, allowZero = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) return fallback
  return value
}

/** Parse one whole settings document. */
export function parseOpenDesignModelSettings(value: unknown): OpenDesignModelSettings {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const enabledModelIds = record.enabledModelIds === null
    ? null
    : Array.isArray(record.enabledModelIds)
      ? record.enabledModelIds.filter((id): id is string => typeof id === 'string')
      : null
  return {
    enabled: record.enabled !== false,
    baseURL: typeof record.baseURL === 'string' && record.baseURL.trim() !== '' ? record.baseURL.trim() : DEFAULT_BASE_URL,
    enabledModelIds,
    catalogModels: readCatalogModels(record.catalogModels),
    hiddenModels: Array.isArray(record.hiddenModels)
      ? record.hiddenModels.filter((id): id is string => typeof id === 'string')
      : [],
    // A document written before this fact existed states neither field; it reads
    // as "never synced" (null) and "nothing forced" ([]), which is exactly the
    // behaviour it had before, so an upgrade hides no model.
    servedModelIds: readIdList(record.servedModelIds),
    forceVisibleModels: readIdList(record.forceVisibleModels) ?? [],
    contextWindowOverrides: readNumberOverrides(record.contextWindowOverrides),
    defaultContextWindow: positiveInteger(record.defaultContextWindow, DEFAULT_CONTEXT_WINDOW),
    defaultMaxTokens: positiveInteger(record.defaultMaxTokens, DEFAULT_MAX_TOKENS),
    maxConcurrentRequests: positiveInteger(record.maxConcurrentRequests, DEFAULT_MAX_CONCURRENT_REQUESTS, true),
    streamIdleTimeoutMs: positiveInteger(record.streamIdleTimeoutMs, DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  }
}

/** The document a fresh install starts from. */
export function defaultOpenDesignModelSettings(): OpenDesignModelSettings {
  return parseOpenDesignModelSettings({})
}

/**
 * Model and connection settings, bound to a JSON file beside the encrypted
 * credential store.
 *
 * The file is written atomically (temp + rename) so a crash mid-write leaves the
 * previous document intact rather than a truncated one that reads as "reset all
 * settings", and writes are SERIALIZED behind one queue so two read→compute→write
 * cycles can never interleave and erase each other's fields. Reads do not queue:
 * see {@link OpenDesignModelSettingsStore.pending}.
 */
export class OpenDesignModelSettingsStore implements OpenDesignPreferenceStore {
  private cached: OpenDesignModelSettings | null = null
  private loadPromise: Promise<OpenDesignModelSettings> | null = null
  /**
   * Tail of the write queue.
   *
   * Every mutator derives a WHOLE document from the one it read, so two of them in
   * flight at once each erase the other's fields. That is not hypothetical here:
   * the catalog sync is fire-and-forget (`void syncCatalog()` on account add and on
   * a completed sign-in), so it really can land between a selection change's read
   * and its write. Each mutation therefore runs its entire read → compute → write
   * inside one turn of this queue.
   *
   * `read()` stays OUTSIDE the queue on purpose: it is the hot path (every status
   * request, every keystroke-driven checkbox), and waiting behind a write would buy
   * nothing — by the time a queued operation runs, every write queued before it has
   * already landed, so the plain read it performs IS the in-lock read.
   */
  private pending: Promise<unknown> = Promise.resolve()

  constructor(private readonly filePath = modelSettingsPath()) {}

  path(): string {
    return this.filePath
  }

  status(): OpenDesignModelSettings {
    return this.cached ?? defaultOpenDesignModelSettings()
  }

  /**
   * Read the document at activation time, synchronously.
   *
   * Synchronous by contract, so it cannot join the write queue — and it does not
   * need to: it only READS, a rename makes the file either the old or the new
   * document (never a half-written one), and a queued write assigns `cached` after
   * that rename, so a reading taken mid-write is superseded by the write's own.
   */
  readSync(): OpenDesignModelSettings {
    if (this.cached !== null) return this.cached
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      this.cached = parseOpenDesignModelSettings(parsed)
      return this.cached
    } catch {
      this.cached = defaultOpenDesignModelSettings()
      return this.cached
    }
  }

  async read(): Promise<OpenDesignModelSettings> {
    if (this.cached !== null) return this.cached
    if (this.loadPromise !== null) return this.loadPromise
    this.loadPromise = this.load().finally(() => {
      this.loadPromise = null
    })
    return this.loadPromise
  }

  private async load(): Promise<OpenDesignModelSettings> {
    try {
      const content = await fs.readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(content)
      this.cached = parseOpenDesignModelSettings(parsed)
      return this.cached
    } catch {
      // No settings yet, or an unreadable one: the defaults are the honest
      // empty state.
    }
    this.cached = defaultOpenDesignModelSettings()
    return this.cached
  }

  /**
   * Run one operation with exclusive access to the document.
   *
   * The queue's tail never carries a rejection: an operation that throws rejects
   * its OWN caller only, and the tail is flattened to a fulfilled promise right
   * afterwards, so a failed write cannot poison the writes queued behind it.
   */
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation)
    this.pending = result.then(() => undefined, () => undefined)
    return await result
  }

  /** Replace the whole document, queued behind any write already in flight. */
  async write(settings: OpenDesignModelSettings): Promise<OpenDesignModelSettings> {
    return await this.exclusive(() => this.writeUnlocked(settings))
  }

  /**
   * The file half of a write, for callers that ALREADY hold the queue.
   *
   * No public mutator may call another one: awaiting a queued mutator from inside
   * `exclusive` would wait for a queue position behind itself and deadlock. That is
   * why every mutator below composes `read()` with THIS, never with `write()`.
   */
  private async writeUnlocked(settings: OpenDesignModelSettings): Promise<OpenDesignModelSettings> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp.${Date.now()}`
    await fs.writeFile(tmp, JSON.stringify({ version: 1, ...settings }, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
    this.cached = settings
    return settings
  }

  async update(patch: Partial<OpenDesignModelSettings>): Promise<OpenDesignModelSettings> {
    return await this.exclusive(async () => {
      const current = await this.read()
      const next: OpenDesignModelSettings = {
        ...current,
        ...patch,
        // Collections are replaced as a whole rather than merged, so a caller can
        // delete an override by passing the next map.
        contextWindowOverrides: patch.contextWindowOverrides === undefined
          ? current.contextWindowOverrides
          : patch.contextWindowOverrides,
      }
      return await this.writeUnlocked(next)
    })
  }

  /**
   * Record a catalog sync without touching the user's selection.
   *
   * `servedModelIds` is written only when the caller actually measured it: a sync
   * in which every scan failed must leave the previous measurement standing rather
   * than clearing the filter, so `undefined` keeps the stored value while an array
   * (including an empty one) replaces it.
   */
  async storeCatalog(models: OpenDesignCatalogModel[], servedModelIds?: string[] | null): Promise<OpenDesignModelSettings> {
    return await this.exclusive(async () => {
      const current = await this.read()
      return await this.writeUnlocked(servedModelIds === undefined
        ? { ...current, catalogModels: models }
        : { ...current, catalogModels: models, servedModelIds })
    })
  }

  /**
   * Replace the model selection, dropping any forced reveal it excludes.
   *
   * One `read` for both the prune input and the write baseline, so the two cannot
   * disagree: computing the prune outside and then patching would read the document
   * twice, and a forced reveal added in that gap would be recorded and then erased
   * by the second read's snapshot.
   *
   * The prune belongs to the selection rather than to `models/visibility` because
   * the card's only un-tick path is the selection patch: it removes the id from the
   * whitelist and never posts `{visible:false}`, so a forced reveal would otherwise
   * outlive the tick that asked for it. `null` is "no filter" — not a "keep only
   * these" statement — so it prunes nothing.
   */
  async selectModels(ids: string[] | null): Promise<OpenDesignModelSettings> {
    return await this.exclusive(async () => {
      const current = await this.read()
      return await this.writeUnlocked(ids === null
        ? { ...current, enabledModelIds: null }
        : { ...current, enabledModelIds: ids, forceVisibleModels: current.forceVisibleModels.filter((id) => ids.includes(id)) })
    })
  }

  /** Store or clear (null) one model's context-window override. */
  async setContextWindowOverride(model: string, contextWindow: number | null): Promise<OpenDesignModelSettings> {
    return await this.exclusive(async () => {
      const current = await this.read()
      const overrides = { ...current.contextWindowOverrides }
      if (contextWindow === null) delete overrides[model]
      else overrides[model] = contextWindow
      return await this.writeUnlocked({ ...current, contextWindowOverrides: overrides })
    })
  }
}
