import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { CredentialStore } from '../token-store.ts'
import { WindowsDpapiCredentialStore } from '../token-store-windows.ts'
import { MacKeychainCredentialStore } from '../token-store-macos.ts'
import { SecretServiceCredentialStore } from '../credential-store-secret-service.ts'
import { dshHomeDir } from '../common/home.ts'
import type { ClinePassPinMode } from '../../shared/cline-pass-contracts.ts'
import {
  DEFAULT_BASE_URL,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  MAX_GATEWAY_HAS,
  MAX_GATEWAY_HAS_LENGTH,
  PROVIDER_ID,
  capGatewayHas,
  defaultGatewayHas,
  defaultPin,
  type ClinePassPinSettings,
} from './types.ts'

/**
 * One stored Cline Pass API key.
 *
 * The gateway authenticates with a static key rather than the rotating OAuth
 * pair most lines in this plugin store, so there is no refresh token and nothing
 * expires. The key is host-only and never crosses to a browser; the settings
 * card renders the alias and the account row, never this value.
 */
interface ClinePassCredentialBase {
  /** User-chosen label so several accounts are distinguishable. */
  alias?: string
  /** Unix milliseconds the credential was added to the pool. */
  addedAt?: number
  /** Per-account gateway override; empty means the line's own base URL. */
  baseURL?: string
}

/**
 * A static API key, the shape the standalone `dsh-cline-pass` plugin used.
 *
 * Kept as a fallback: the official clients now sign in with WorkOS OAuth, but
 * existing users may still hold a key, and a key has no refresh lifecycle.
 */
export interface ClinePassApiKeyCredentials extends ClinePassCredentialBase {
  /** Absent on records written before the OAuth path existed. */
  kind?: 'api-key'
  /** Host-only bearer key. */
  apiKey: string
}

/**
 * One Cline account signed in through WorkOS device authorization.
 *
 * `access` is the raw WorkOS access token; the wire bearer is
 * `workos:<access>` (Cline's own clients add that prefix). `refresh` rotates on
 * every refresh, so it is persisted before the new access token is used.
 */
export interface ClinePassOAuthCredentials extends ClinePassCredentialBase {
  kind: 'oauth'
  access: string
  refresh: string
  /** Unix milliseconds the access token expires. */
  expires: number
  /** Cline's stable user id, when the token registration returned one. */
  accountId?: string
  email?: string
  name?: string
  metadata?: Record<string, unknown>
}

export type ClinePassCredentials = ClinePassOAuthCredentials | ClinePassApiKeyCredentials

/** Cline's own clients send OAuth access tokens with this prefix. */
export const CLINE_WORKOS_TOKEN_PREFIX = 'workos:'

/** Whether one credential is an OAuth session rather than a static key. */
export function isOAuthCredentials(credentials: ClinePassCredentials): credentials is ClinePassOAuthCredentials {
  return credentials.kind === 'oauth' || 'access' in credentials
}

/** The `Authorization: Bearer` value for one credential. */
export function bearerFor(credentials: ClinePassCredentials): string {
  if (!isOAuthCredentials(credentials)) return credentials.apiKey
  // The stored token is normally bare; a record written by another tool may
  // already carry the prefix, and doubling it is a 401 with no useful message.
  return credentials.access.toLowerCase().startsWith(CLINE_WORKOS_TOKEN_PREFIX)
    ? credentials.access
    : `${CLINE_WORKOS_TOKEN_PREFIX}${credentials.access}`
}

/** Stable identity two credentials share when they are the same Cline account. */
export function credentialsIdentity(credentials: ClinePassCredentials): string {
  if (isOAuthCredentials(credentials)) {
    if (credentials.accountId !== undefined && credentials.accountId !== '') return `oauth:${credentials.accountId}`
    if (credentials.email !== undefined && credentials.email !== '') return `email:${credentials.email.toLowerCase()}`
    return `refresh:${createHash('sha256').update(credentials.refresh).digest('hex')}`
  }
  return `key:${createHash('sha256').update(credentials.apiKey).digest('hex')}`
}

/** Unix milliseconds the credential expires, when it has an expiry. */
export function credentialsExpiresAt(credentials: ClinePassCredentials): number | undefined {
  return isOAuthCredentials(credentials) && credentials.expires > 0 ? credentials.expires : undefined
}

/** The user-facing label for one credential, when it states one. */
export function credentialsLabel(credentials: ClinePassCredentials): string | undefined {
  if (isOAuthCredentials(credentials)) {
    return credentials.name?.trim() || credentials.email?.trim() || undefined
  }
  return credentials.alias?.trim() || undefined
}

/** Decode a JWT's `exp` claim, without trusting anything else in it. */
export function jwtExpiryMs(token: string): number | undefined {
  const payload = token.split('.')[1]
  if (payload === undefined) return undefined
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const parsed: unknown = JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const exp = (parsed as { exp?: unknown }).exp
    return typeof exp === 'number' && exp > 0 ? exp * 1000 : undefined
  } catch {
    return undefined
  }
}

/** One catalog entry, as the last successful scan published it. */
export interface ClinePassCatalogModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  input?: string[]
  efforts?: string[]
  /**
   * Where this row came from. Missing means a legacy row: `cline-pass/*`
   * counts as the official subscription list, anything else as gateway-only.
   */
  origin?: 'official' | 'custom' | 'gateway'
}

/** Whether a catalog row belongs in the compact, built-in + official + added list. */
export function isListedClinePassCatalogModel(model: ClinePassCatalogModel): boolean {
  if (model.origin === 'official' || model.origin === 'custom') return true
  if (model.origin === 'gateway') return false
  return model.id.startsWith('cline-pass/')
}

/** The catalog rows to display/advertise, never the whole gateway search index. */
export function listedClinePassCatalogModels(settings: { catalogModels: ClinePassCatalogModel[] }): ClinePassCatalogModel[] {
  return settings.catalogModels.filter(isListedClinePassCatalogModel)
}

/**
 * Everything this line stores besides credentials.
 *
 * `enabledModelIds === null` is "no filter": every catalogued model, including
 * ones a later scan adds. An array is an explicit selection, and an empty one
 * switches every model off. Modelling "all" as null rather than as an explicit
 * all-ids list means a model the service adds later is not silently hidden by a
 * selection made before it existed.
 */
export interface ClinePassModelSettings {
  enabled: boolean
  baseURL: string
  enabledModelIds: string[] | null
  catalogModels: ClinePassCatalogModel[]
  /** Per-model upstream pin, keyed by model id. */
  pins: Record<string, ClinePassPinSettings>
  /** Models the route must not advertise even though it still knows them. */
  hiddenModels: string[]
  /** Per-model context-window override; absent uses the published window. */
  contextWindowOverrides: Record<string, number>
  defaultContextWindow: number
  defaultMaxTokens: number
  maxConcurrentRequests: number
  streamIdleTimeoutMs: number
  historyLimit: number
  exposeCatalog: boolean
  /** Which pin spellings a request carries: `both` (default) or `detected`. */
  pinSpelling: string
  /** Whether the `cline_pass_*` tools are registered on the next start. */
  exposeTools: boolean
}

export interface ClinePassPreferenceStore {
  status(): ClinePassModelSettings
  read(): Promise<ClinePassModelSettings>
  update(patch: Partial<ClinePassModelSettings>): Promise<ClinePassModelSettings>
}

export function credentialPath(): string {
  return path.join(dshHomeDir(), 'storages', 'cline-pass-credentials.json')
}

export function modelSettingsPath(): string {
  return path.join(dshHomeDir(), 'storages', 'cline-pass-models.json')
}

/** Stable keyring account name for one credential file. */
function credentialAccount(filePath: string): string {
  return createHash('sha256').update(path.resolve(filePath)).digest('hex')
}

function optionalString(record: Record<string, unknown>, key: string, what: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`Cline Pass ${what} field is invalid`)
  return value
}

/** Validate one stored credential: an OAuth session or a static API key. */
export function parseClinePassCredentials(value: unknown): ClinePassCredentials {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Cline Pass credential payload is invalid')
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

  const access = record.access
  const refresh = record.refresh
  if (typeof access === 'string' && access.trim() !== '' && typeof refresh === 'string' && refresh.trim() !== '') {
    const rawExpires = record.expires
    const parsedExpires = typeof rawExpires === 'number' && Number.isFinite(rawExpires) && rawExpires > 0 ? rawExpires : 0
    const credentials: ClinePassOAuthCredentials = {
      kind: 'oauth',
      access: access.trim(),
      refresh: refresh.trim(),
      expires: parsedExpires > 0 ? parsedExpires : (jwtExpiryMs(access.trim()) ?? 0),
      ...common,
    }
    const accountId = optionalString(record, 'accountId', 'credential')
    if (accountId !== undefined) credentials.accountId = accountId
    const email = optionalString(record, 'email', 'credential')
    if (email !== undefined) credentials.email = email
    const name = optionalString(record, 'name', 'credential')
    if (name !== undefined) credentials.name = name
    if (typeof record.metadata === 'object' && record.metadata !== null && !Array.isArray(record.metadata)) {
      credentials.metadata = record.metadata as Record<string, unknown>
    }
    return credentials
  }

  const apiKey = record.apiKey
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error('Cline Pass credential is missing its API key')
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
function createCredentialBackend(filePath: string): CredentialStore<ClinePassCredentials> {
  if (process.platform === 'win32') {
    return new WindowsDpapiCredentialStore(`${filePath}.dpapi`, parseClinePassCredentials)
  }
  if (process.platform === 'darwin') {
    return new MacKeychainCredentialStore(PROVIDER_ID, credentialAccount(filePath), parseClinePassCredentials)
  }
  if (process.platform === 'linux') {
    return new SecretServiceCredentialStore(PROVIDER_ID, credentialAccount(filePath), parseClinePassCredentials)
  }
  throw new Error('Cline Pass credential storage requires Windows, macOS, or Linux.')
}

/** Encrypted credential store for the single-key (pre-pool) configuration. */
export class FileCredentialStore {
  constructor(
    private readonly filePath = credentialPath(),
    private readonly backend: CredentialStore<ClinePassCredentials> = createCredentialBackend(filePath),
  ) {}

  path(): string {
    return this.filePath
  }

  async read(): Promise<ClinePassCredentials | null> {
    return this.backend.load()
  }

  async write(credentials: ClinePassCredentials): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await this.backend.save(credentials)
  }

  async clear(): Promise<void> {
    await this.backend.clear()
  }
}

/** One pin as stored, validated; a malformed row falls back to the default. */
function readPin(value: unknown, model: string): ClinePassPinSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return defaultPin(model)
  const record = value as Record<string, unknown>
  return {
    upstreams: Array.isArray(record.upstreams)
      ? record.upstreams.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      : [],
    exclude: Array.isArray(record.exclude)
      ? record.exclude.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      : [],
    pinMode: record.pinMode === 'preferred' ? 'preferred' : 'strict',
    sort: typeof record.sort === 'string' ? record.sort : '',
    // Legacy pins predate `has`: inherit the model's measured default. An
    // explicitly saved empty array stays empty, so clearing it is respected.
    has: Array.isArray(record.has)
      ? capGatewayHas(record.has.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim()))
      : defaultGatewayHas(model),
  }
}

function readPins(value: unknown): Record<string, ClinePassPinSettings> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const pins: Record<string, ClinePassPinSettings> = {}
  for (const [model, pin] of Object.entries(value as Record<string, unknown>)) {
    if (typeof model !== 'string' || model.length === 0) continue
    pins[model] = readPin(pin, model)
  }
  return pins
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

function readCatalogModels(value: unknown): ClinePassCatalogModel[] {
  if (!Array.isArray(value)) return []
  const models: ClinePassCatalogModel[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (typeof record.id !== 'string' || record.id.length === 0) continue
    const model: ClinePassCatalogModel = { id: record.id }
    if (typeof record.name === 'string' && record.name.length > 0) model.name = record.name
    if (typeof record.contextWindow === 'number' && Number.isSafeInteger(record.contextWindow) && record.contextWindow > 0) model.contextWindow = record.contextWindow
    if (typeof record.maxTokens === 'number' && Number.isSafeInteger(record.maxTokens) && record.maxTokens > 0) model.maxTokens = record.maxTokens
    if (typeof record.reasoning === 'boolean') model.reasoning = record.reasoning
    if (Array.isArray(record.input)) model.input = record.input.filter((item): item is string => typeof item === 'string')
    if (Array.isArray(record.efforts)) model.efforts = record.efforts.filter((item): item is string => typeof item === 'string')
    if (record.origin === 'official' || record.origin === 'custom' || record.origin === 'gateway') model.origin = record.origin
    models.push(model)
  }
  return models
}

function positiveInteger(value: unknown, fallback: number, allowZero = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) return fallback
  return value
}

/**
 * Keep a legacy gateway row the user is demonstrably using.
 *
 * Rows written before `origin` existed carry none, and the compact list hides
 * every unmarked non-`cline-pass/*` row. A row that is enabled, pinned or given
 * a context override is one the user already selected, so hiding it would drop
 * a working model out of the picker on upgrade; those rows become `custom`
 * instead. Everything else stays hidden as a search-index row.
 */
function promoteInUseCatalogRows(
  models: ClinePassCatalogModel[],
  enabledModelIds: string[] | null,
  pins: Record<string, unknown>,
  contextWindowOverrides: Record<string, number>,
): ClinePassCatalogModel[] {
  const inUse = new Set<string>([
    // `null` is "no filter": every catalogued model is enabled, so every legacy
    // gateway row is one the user was using. Treating it as an empty selection
    // left the exact cohort this migration exists for — an `exposeCatalog` user
    // who never touched the checklist — with every row still hidden.
    ...(enabledModelIds === null ? models.map((model) => model.id) : enabledModelIds),
    ...Object.keys(pins),
    ...Object.keys(contextWindowOverrides),
  ])
  if (inUse.size === 0) return models
  return models.map((model) => model.origin !== undefined || model.id.startsWith('cline-pass/') || !inUse.has(model.id)
    ? model
    : { ...model, origin: 'custom' as const })
}

/** Parse one whole settings document. */
export function parseClinePassModelSettings(value: unknown): ClinePassModelSettings {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const enabledModelIds = record.enabledModelIds === null
    ? null
    : Array.isArray(record.enabledModelIds)
      ? record.enabledModelIds.filter((id): id is string => typeof id === 'string')
      : null
  const pins = readPins(record.pins)
  const contextWindowOverrides = readNumberOverrides(record.contextWindowOverrides)
  return {
    enabled: record.enabled !== false,
    baseURL: typeof record.baseURL === 'string' && record.baseURL.trim() !== '' ? record.baseURL.trim() : DEFAULT_BASE_URL,
    enabledModelIds,
    catalogModels: promoteInUseCatalogRows(readCatalogModels(record.catalogModels), enabledModelIds, pins, contextWindowOverrides),
    pins,
    hiddenModels: Array.isArray(record.hiddenModels)
      ? record.hiddenModels.filter((id): id is string => typeof id === 'string')
      : [],
    contextWindowOverrides,
    defaultContextWindow: positiveInteger(record.defaultContextWindow, DEFAULT_CONTEXT_WINDOW),
    defaultMaxTokens: positiveInteger(record.defaultMaxTokens, DEFAULT_MAX_TOKENS),
    maxConcurrentRequests: positiveInteger(record.maxConcurrentRequests, DEFAULT_MAX_CONCURRENT_REQUESTS, true),
    streamIdleTimeoutMs: positiveInteger(record.streamIdleTimeoutMs, DEFAULT_STREAM_IDLE_TIMEOUT_MS),
    historyLimit: positiveInteger(record.historyLimit, DEFAULT_HISTORY_LIMIT),
    exposeCatalog: record.exposeCatalog === true,
    pinSpelling: typeof record.pinSpelling === 'string' && record.pinSpelling.length > 0 ? record.pinSpelling : 'both',
    exposeTools: record.exposeTools === true,
  }
}

/** The document a fresh install starts from. */
export function defaultClinePassModelSettings(): ClinePassModelSettings {
  return parseClinePassModelSettings({})
}

/**
 * Model and routing settings, bound to a JSON file beside the encrypted
 * credential store.
 *
 * The file is written atomically (temp + rename) so a crash mid-write leaves the
 * previous document intact rather than a truncated one that reads as "reset all
 * settings".
 */
export class ClinePassModelSettingsStore implements ClinePassPreferenceStore {
  private cached: ClinePassModelSettings | null = null
  private loadPromise: Promise<ClinePassModelSettings> | null = null

  constructor(private readonly filePath = modelSettingsPath()) {}

  path(): string {
    return this.filePath
  }

  status(): ClinePassModelSettings {
    return this.cached ?? defaultClinePassModelSettings()
  }

  /**
   * Read the document at activation time, synchronously.
   *
   * The line has to decide whether to register its management tools before
   * `apply()` returns: a tool list snapshotted by a running Session would not
   * see a registration that landed a tick later. The file is small and plain
   * JSON (only credentials are encrypted), so one sync read is the honest
   * trade.
   */
  readSync(): ClinePassModelSettings {
    if (this.cached !== null) return this.cached
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      this.cached = parseClinePassModelSettings(parsed)
      return this.cached
    } catch {
      this.cached = defaultClinePassModelSettings()
      return this.cached
    }
  }

  async read(): Promise<ClinePassModelSettings> {
    if (this.cached !== null) return this.cached
    if (this.loadPromise !== null) return this.loadPromise
    this.loadPromise = this.load().finally(() => {
      this.loadPromise = null
    })
    return this.loadPromise
  }

  private async load(): Promise<ClinePassModelSettings> {
    try {
      const content = await fs.readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(content)
      this.cached = parseClinePassModelSettings(parsed)
      return this.cached
    } catch {
      // No settings yet, or an unreadable one: the defaults are the honest
      // empty state.
    }
    this.cached = defaultClinePassModelSettings()
    return this.cached
  }

  async write(settings: ClinePassModelSettings): Promise<ClinePassModelSettings> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp.${Date.now()}`
    await fs.writeFile(tmp, JSON.stringify({ version: 2, ...settings }, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
    this.cached = settings
    return settings
  }

  async update(patch: Partial<ClinePassModelSettings>): Promise<ClinePassModelSettings> {
    const current = await this.read()
    const next: ClinePassModelSettings = {
      ...current,
      ...patch,
      // Collections are replaced as a whole rather than merged, so a caller can
      // delete a pin or an override by passing the next map.
      pins: patch.pins === undefined ? current.pins : patch.pins,
      contextWindowOverrides: patch.contextWindowOverrides === undefined
        ? current.contextWindowOverrides
        : patch.contextWindowOverrides,
    }
    await this.write(next)
    return next
  }

  /** Record a catalog sync without touching the user's selection or pins. */
  async storeCatalog(models: ClinePassCatalogModel[]): Promise<ClinePassModelSettings> {
    const current = await this.read()
    return await this.write({ ...current, catalogModels: models })
  }

  /** Store one model's pin; an empty pin list returns it to automatic routing. */
  async setPin(model: string, pin: ClinePassPinSettings): Promise<ClinePassModelSettings> {
    const current = await this.read()
    return await this.write({ ...current, pins: { ...current.pins, [model]: pin } })
  }

  /** Drop one model's pin entirely. */
  async clearPin(model: string): Promise<ClinePassModelSettings> {
    const current = await this.read()
    const pins = { ...current.pins }
    delete pins[model]
    return await this.write({ ...current, pins })
  }

  /** Store or clear (null) one model's context-window override. */
  async setContextWindowOverride(model: string, contextWindow: number | null): Promise<ClinePassModelSettings> {
    const current = await this.read()
    const overrides = { ...current.contextWindowOverrides }
    if (contextWindow === null) delete overrides[model]
    else overrides[model] = contextWindow
    return await this.write({ ...current, contextWindowOverrides: overrides })
  }
}
