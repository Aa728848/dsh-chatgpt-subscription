import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { PROVIDER_ID } from './types.ts'
import type { CredentialStore } from '../token-store.ts'
import { WindowsDpapiCredentialStore } from '../token-store-windows.ts'
import { MacKeychainCredentialStore } from '../token-store-macos.ts'
import { SecretServiceCredentialStore } from '../credential-store-secret-service.ts'
import { dshHomeDir } from '../common/home.ts'
import type { OllamaCatalogModel } from './types.ts'

/**
 * One stored Ollama credential.
 *
 * Ollama cloud authenticates with a static API key rather than the rotating
 * OAuth pair the other lines in this plugin store, so there is no refresh token
 * and nothing expires: per docs/api/authentication, keys do not expire and are
 * revoked from the account settings page. That is the whole credential, and it
 * is why a pool account here is "a key a user pasted" rather than "a session this
 * plugin established".
 *
 * The key is host-only and never crosses to a browser; a settings card renders
 * the alias and status, never this value.
 */
export interface OllamaCredentials {
  /** Bearer key from https://ollama.com/settings/keys. Host-only. */
  apiKey: string
  /** User-chosen label so several keys are distinguishable. */
  alias?: string
  /** Unix milliseconds the key was added to the pool. */
  addedAt?: number
}

export interface OllamaModelSettings {
  enabled: boolean
  enabledModelIds: string[]
  catalogModels: OllamaCatalogModel[]
  defaultReasoningEffort: string | null
}

export interface OllamaPreferenceStore {
  status(): OllamaModelSettings
  update(patch: {
    enabled?: boolean
    enabledModelIds?: string[]
    defaultReasoningEffort?: string | null
  }): Promise<OllamaModelSettings>
}

export function credentialPath(): string {
  return path.join(dshHomeDir(), 'storages', 'ollama-credentials.json')
}

export function modelSettingsPath(): string {
  return path.join(dshHomeDir(), 'storages', 'ollama-models.json')
}

/** Stable keyring account name for one credential file. */
function credentialAccount(filePath: string): string {
  return createHash('sha256').update(path.resolve(filePath)).digest('hex')
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('Ollama credential payload is invalid')
  return value
}

export function parseOllamaCredentials(value: unknown): OllamaCredentials {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Ollama credential payload is invalid')
  }
  const record = value as Record<string, unknown>
  const apiKey = record.apiKey
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error('Ollama credential is missing its API key')
  }
  const credentials: OllamaCredentials = { apiKey }
  const alias = optionalString(record, 'alias')
  if (alias !== undefined) credentials.alias = alias
  const addedAt = record.addedAt
  if (typeof addedAt === 'number' && Number.isFinite(addedAt)) credentials.addedAt = addedAt
  return credentials
}

/**
 * The OS credential backend for this platform.
 *
 * Same matrix as every other line here: DPAPI on Windows, Keychain on macOS,
 * Secret Service on Linux. The plaintext JSON file is a migration source only,
 * never the live store.
 */
function createCredentialBackend(filePath: string): CredentialStore<OllamaCredentials> {
  if (process.platform === 'win32') {
    return new WindowsDpapiCredentialStore(`${filePath}.dpapi`, parseOllamaCredentials)
  }
  if (process.platform === 'darwin') {
    return new MacKeychainCredentialStore(PROVIDER_ID, credentialAccount(filePath), parseOllamaCredentials)
  }
  if (process.platform === 'linux') {
    return new SecretServiceCredentialStore(PROVIDER_ID, credentialAccount(filePath), parseOllamaCredentials)
  }
  throw new Error('Ollama credential storage requires Windows, macOS, or Linux.')
}

/** Encrypted credential store for the single-key (no pool) configuration. */
export class FileCredentialStore {
  constructor(
    private readonly filePath = credentialPath(),
    private readonly backend: CredentialStore<OllamaCredentials> = createCredentialBackend(filePath),
  ) {}

  path(): string {
    return this.filePath
  }

  async read(): Promise<OllamaCredentials | null> {
    return this.backend.load()
  }

  async write(credentials: OllamaCredentials): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await this.backend.save(credentials)
  }

  async clear(): Promise<void> {
    await this.backend.clear()
  }
}

/**
 * Model settings, bound to the DSH settings document when the harness offers one
 * and to a JSON file beside it otherwise.
 */
export class FileModelSettingsStore implements OllamaPreferenceStore {
  private cached: OllamaModelSettings | null = null
  private loadPromise: Promise<OllamaModelSettings> | null = null

  constructor(private readonly filePath = modelSettingsPath()) {}

  path(): string {
    return this.filePath
  }

  status(): OllamaModelSettings {
    return this.cached ?? { enabled: true, enabledModelIds: [], catalogModels: [], defaultReasoningEffort: null }
  }

  async read(): Promise<OllamaModelSettings> {
    if (this.cached !== null) return this.cached
    if (this.loadPromise !== null) return this.loadPromise
    this.loadPromise = this.load().finally(() => {
      this.loadPromise = null
    })
    return this.loadPromise
  }

  private async load(): Promise<OllamaModelSettings> {
    try {
      const content = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(content) as unknown
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>
        const enabledModels = Array.isArray(record.enabledModelIds)
          ? record.enabledModelIds.filter((id): id is string => typeof id === 'string')
          : []
        const catalogModels = Array.isArray(record.catalogModels)
          ? record.catalogModels.filter((entry): entry is OllamaCatalogModel =>
            typeof entry === 'object' && entry !== null && typeof (entry as OllamaCatalogModel).id === 'string')
          : []
        this.cached = {
          enabled: record.enabled !== false,
          enabledModelIds: enabledModels,
          catalogModels,
          defaultReasoningEffort: typeof record.defaultReasoningEffort === 'string'
            ? record.defaultReasoningEffort
            : null,
        }
        return this.cached
      }
    } catch {
      // No settings yet: the defaults above are the honest empty state.
    }
    this.cached = { enabled: true, enabledModelIds: [], catalogModels: [], defaultReasoningEffort: null }
    return this.cached
  }

  async write(settings: OllamaModelSettings): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp.${Date.now()}`
    await fs.writeFile(tmp, JSON.stringify(settings, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
    this.cached = settings
  }

  async update(patch: {
    enabled?: boolean
    enabledModelIds?: string[]
    defaultReasoningEffort?: string | null
  }): Promise<OllamaModelSettings> {
    const current = await this.read()
    const next: OllamaModelSettings = {
      enabled: patch.enabled ?? current.enabled,
      enabledModelIds: patch.enabledModelIds ?? current.enabledModelIds,
      catalogModels: current.catalogModels,
      defaultReasoningEffort: patch.defaultReasoningEffort === undefined
        ? current.defaultReasoningEffort
        : patch.defaultReasoningEffort,
    }
    await this.write(next)
    return next
  }

  /** Record a catalog sync without touching the user's enabled selection. */
  async storeCatalog(models: OllamaCatalogModel[]): Promise<OllamaModelSettings> {
    const current = await this.read()
    const next: OllamaModelSettings = { ...current, catalogModels: models }
    await this.write(next)
    return next
  }
}


