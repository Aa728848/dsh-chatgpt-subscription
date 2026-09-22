import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { SettingsProvider, SettingsScope } from '@deepseek-ai/dsh-settings'
import * as SettingsModule from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type { CommandCodeApiEnv, CommandCodeReasoningEffort } from '../../shared/command-code-contracts.ts'
import { COMMAND_CODE_REASONING_EFFORTS } from '../../shared/command-code-contracts.ts'
import { FALLBACK_MODELS, PROVIDER_ID, resolveApiEnv } from './types.ts'
import type { CredentialStore } from '../token-store.ts'
import { WindowsDpapiCredentialStore } from '../token-store-windows.ts'
import { MacKeychainCredentialStore } from '../token-store-macos.ts'
import { SecretServiceCredentialStore } from '../credential-store-secret-service.ts'
import { dshHomeDir } from '../antigravity/token-store.ts'

export const COMMAND_CODE_PREFERENCES_NAMESPACE = 'dsh-command-code'

export type { CommandCodeReasoningEffort }

/** Runtime membership test for one stored effort value. */
function isReasoningEffort(value: unknown): value is CommandCodeReasoningEffort {
  return typeof value === 'string' && (COMMAND_CODE_REASONING_EFFORTS as readonly string[]).includes(value)
}

/**
 * One stored Command Code credential.
 *
 * The provider API authenticates with a bearer API key rather than the rotating
 * OAuth pair the other routes in this plugin store, so there is no refresh
 * token and nothing expires. The browser sign-in returns the same key a user
 * can paste by hand, which is why both paths converge on this shape.
 */
export interface CommandCodeCredentials {
  /** Bearer key issued by Command Code Studio. Host-only; never sent to a browser. */
  apiKey: string
  userId?: string
  userName?: string
  email?: string
  keyName?: string
  organizationName?: string
  planLabel?: string
  planId?: string
  /** Unix milliseconds the key was obtained. */
  authenticatedAt?: number
  /** Which API deployment the key belongs to. */
  apiEnv?: CommandCodeApiEnv
}

export interface CommandCodeCatalogModel {
  id: string
  name?: string
  contextWindow?: number
}

export interface CommandCodeModelSettings {
  enabled?: boolean
  enabledModelIds: string[]
  catalogModels: CommandCodeCatalogModel[]
  contextWindowOverrides: Record<string, number>
  defaultReasoningEffort: CommandCodeReasoningEffort | null
}

export interface CommandCodePreferenceStore {
  status(): CommandCodeModelSettings
  update(patch: {
    enabled?: boolean
    enabledModelIds?: string[]
    contextWindowOverrides?: Record<string, number>
    defaultReasoningEffort?: CommandCodeReasoningEffort | null
  }): Promise<CommandCodeModelSettings>
}

const DEFAULT_ENABLED_MODEL_IDS = FALLBACK_MODELS.map((model) => model.id)

/**
 * Bind the model selection to the DSH settings document, which is what the
 * settings service can persist durably; the JSON file beside it remains the
 * store used when the plugin runs without a settings provider (headless tests).
 */
export function registerCommandCodePreferenceStore(
  settings?: SettingsProvider,
  fallbackStore = new FileModelSettingsStore(),
): CommandCodePreferenceStore {
  if (!settings || typeof (settings as unknown as Record<string, unknown>).register !== 'function') {
    return {
      status: () => ({
        enabled: true,
        enabledModelIds: [...DEFAULT_ENABLED_MODEL_IDS],
        catalogModels: [],
        contextWindowOverrides: {},
        defaultReasoningEffort: null,
      }),
      update: async (patch) => fallbackStore.updateSettings(patch),
    }
  }

  const ns = ((SettingsModule as unknown as Record<string, unknown>).settingsNamespace
    ? ((SettingsModule as unknown as Record<string, Function>).settingsNamespace)(COMMAND_CODE_PREFERENCES_NAMESPACE)
    : COMMAND_CODE_PREFERENCES_NAMESPACE) as unknown

  const scope = (settings.register as Function).call(settings, ns, z.object({
    enabled: z.boolean().default(true),
    enabledModelIds: z.array(z.string()).default([...DEFAULT_ENABLED_MODEL_IDS]),
    contextWindowOverrides: z.dict(z.number()).default({}),
    defaultReasoningEffort: z
      .union([
        ...COMMAND_CODE_REASONING_EFFORTS.map((effort) => z.const(effort)),
        z.const(null),
      ])
      .default(null),
  })) as SettingsScope<{
    enabled: boolean
    enabledModelIds: string[]
    contextWindowOverrides: Record<string, number>
    defaultReasoningEffort: CommandCodeReasoningEffort | null
  }>

  return {
    status: () => {
      const value = scope.get()
      return {
        enabled: value.enabled !== false,
        enabledModelIds: value.enabledModelIds,
        catalogModels: [],
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
      return { ...normalized, catalogModels: [] }
    },
  }
}

export function credentialPath(): string {
  return path.join(dshHomeDir(), 'storages', 'command-code-credentials.json')
}

export function modelSettingsPath(): string {
  return path.join(dshHomeDir(), 'storages', 'command-code-models.json')
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('Command Code credential payload is invalid')
  return value
}

export function parseCommandCodeCredentials(value: unknown): CommandCodeCredentials {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Command Code credential payload is invalid')
  }
  const record = value as Record<string, unknown>
  const apiKey = record.apiKey
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error('Command Code credential is missing its API key')
  }
  const credentials: CommandCodeCredentials = { apiKey }
  for (const key of ['userId', 'userName', 'email', 'keyName', 'organizationName', 'planLabel', 'planId'] as const) {
    const parsed = optionalString(record, key)
    if (parsed !== undefined) credentials[key] = parsed
  }
  const authenticatedAt = record.authenticatedAt
  if (authenticatedAt !== undefined) {
    if (typeof authenticatedAt !== 'number' || !Number.isFinite(authenticatedAt)) {
      throw new Error('Command Code credential timestamp is invalid')
    }
    credentials.authenticatedAt = authenticatedAt
  }
  const apiEnv = record.apiEnv
  if (apiEnv !== undefined) {
    if (apiEnv !== 'prod' && apiEnv !== 'staging' && apiEnv !== 'local') {
      throw new Error('Command Code credential environment is invalid')
    }
    credentials.apiEnv = apiEnv
  }
  return credentials
}

function credentialAccount(filePath: string): string {
  return createHash('sha256').update(path.resolve(filePath)).digest('hex')
}

function createCredentialBackend(filePath: string): CredentialStore<CommandCodeCredentials> {
  if (process.platform === 'win32') {
    return new WindowsDpapiCredentialStore(`${filePath}.dpapi`, parseCommandCodeCredentials)
  }
  if (process.platform === 'darwin') {
    return new MacKeychainCredentialStore(PROVIDER_ID, credentialAccount(filePath), parseCommandCodeCredentials)
  }
  if (process.platform === 'linux') {
    return new SecretServiceCredentialStore(PROVIDER_ID, credentialAccount(filePath), parseCommandCodeCredentials)
  }
  throw new Error('Command Code credential storage requires Windows, macOS, or Linux.')
}

// Web login, quota requests, and adapter streams share migration ordering.
const credentialOperations = new Map<string, Promise<void>>()

/** Encrypted credential store; the plaintext JSON is only a migration source. */
export class FileCredentialStore {
  constructor(
    private readonly filePath = credentialPath(),
    private readonly backend: CredentialStore<CommandCodeCredentials> = createCredentialBackend(filePath),
  ) {}

  path(): string {
    if (process.platform === 'win32') return `${this.filePath}.dpapi`
    const kind = process.platform === 'darwin' ? 'Keychain' : 'Secret Service'
    return `${kind}: ${PROVIDER_ID}/${credentialAccount(this.filePath)}`
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(this.filePath)
    const result = (credentialOperations.get(key) || Promise.resolve()).then(operation)
    const settled = result.then(() => undefined, () => undefined)
    credentialOperations.set(key, settled)
    void settled.then(() => {
      if (credentialOperations.get(key) === settled) credentialOperations.delete(key)
    })
    return result
  }

  private async removeLegacy(): Promise<void> {
    try {
      await fs.unlink(this.filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('Command Code legacy credential removal failed')
      }
    }
  }

  private async saveVerified(credentials: CommandCodeCredentials): Promise<void> {
    await this.backend.save(credentials)
    const restored = await this.backend.load()
    if (!isDeepStrictEqual(restored, credentials)) {
      throw new Error('Command Code encrypted credential verification failed')
    }
    await this.removeLegacy()
  }

  read(): Promise<CommandCodeCredentials | null> {
    return this.serialize(async () => {
      // A damaged/locked secure store must never fall back to stale plaintext.
      const current = await this.backend.load()
      if (current !== null) {
        await this.removeLegacy()
        return current
      }
      let legacy: string
      try {
        const stats = await fs.lstat(this.filePath)
        if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('Invalid credential file')
        if (process.getuid && stats.uid !== process.getuid()) throw new Error('Invalid credential owner')
        if (process.platform !== 'win32') await fs.chmod(this.filePath, 0o600)
        legacy = await fs.readFile(this.filePath, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw new Error('Command Code legacy credential read failed')
      }
      let credentials: CommandCodeCredentials
      try {
        credentials = parseCommandCodeCredentials(JSON.parse(legacy) as unknown)
      } catch {
        throw new Error('Command Code legacy credential payload is invalid')
      }
      await this.saveVerified(credentials)
      return credentials
    })
  }

  write(credentials: CommandCodeCredentials): Promise<void> {
    return this.serialize(() => this.saveVerified(parseCommandCodeCredentials(credentials)))
  }

  delete(): Promise<void> {
    return this.serialize(async () => {
      // Remove the migration source first so a failed logout cannot resurrect it.
      await this.removeLegacy()
      await this.backend.clear()
    })
  }
}

/** Plain-JSON model settings used when the settings service is unavailable. */
export class FileModelSettingsStore {
  constructor(private readonly filePath = modelSettingsPath()) {}

  path(): string {
    return this.filePath
  }

  async read(): Promise<CommandCodeModelSettings> {
    try {
      const content = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(content) as unknown
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>
        const enabledModelIds = Array.isArray(record.enabledModelIds)
          ? record.enabledModelIds.filter((id): id is string => typeof id === 'string')
          : [...DEFAULT_ENABLED_MODEL_IDS]
        const catalogModels = Array.isArray(record.catalogModels)
          ? (record.catalogModels as CommandCodeCatalogModel[])
          : []
        const contextWindowOverrides =
          typeof record.contextWindowOverrides === 'object' && record.contextWindowOverrides !== null
            ? (record.contextWindowOverrides as Record<string, number>)
            : {}
        const defaultReasoningEffort = isReasoningEffort(record.defaultReasoningEffort)
          ? record.defaultReasoningEffort
          : null
        const enabled = record.enabled !== false
        return { enabled, enabledModelIds, catalogModels, contextWindowOverrides, defaultReasoningEffort }
      }
    } catch {
      // A missing or unreadable settings file falls back to the shipped defaults.
    }
    return {
      enabled: true,
      enabledModelIds: [...DEFAULT_ENABLED_MODEL_IDS],
      catalogModels: [],
      contextWindowOverrides: {},
      defaultReasoningEffort: null,
    }
  }

  async write(settings: CommandCodeModelSettings): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp.${Date.now()}`
    await fs.writeFile(tmp, JSON.stringify(settings, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
  }

  async updateSettings(patch: {
    enabled?: boolean
    enabledModelIds?: string[]
    contextWindowOverrides?: Record<string, number>
    defaultReasoningEffort?: CommandCodeReasoningEffort | null
  }): Promise<CommandCodeModelSettings> {
    const current = await this.read()
    const next: CommandCodeModelSettings = {
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

  async setCatalogModels(
    catalogModels: CommandCodeCatalogModel[],
    options?: { enabledModelIds?: string[] },
  ): Promise<CommandCodeModelSettings> {
    const current = await this.read()
    const next: CommandCodeModelSettings = {
      ...current,
      enabledModelIds: options?.enabledModelIds ?? current.enabledModelIds,
      catalogModels,
    }
    await this.write(next)
    return next
  }
}

/** Environment the credential was last used against; defaults to the current one. */
export function credentialApiEnv(credentials: CommandCodeCredentials | null): CommandCodeApiEnv {
  return credentials?.apiEnv ?? resolveApiEnv()
}
