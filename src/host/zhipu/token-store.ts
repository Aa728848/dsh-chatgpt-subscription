import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import z from '@deepseek-ai/schemastery'
import type { ZhipuReasoningEffort, ZhipuRegion } from '../../shared/zhipu-contracts.ts'
import { ZHIPU_REASONING_EFFORTS } from '../../shared/zhipu-contracts.ts'
import { apiBaseForRegion, PROVIDER_ID } from './types.ts'
import { DEFAULT_VISIBLE_MODEL_IDS } from './model-catalog.ts'
import type { CredentialStore } from '../token-store.ts'
import { hasRegister, resolveSettingsNamespace, type SettingsScope } from '../common/settings-compat.ts'
import { mergeContextWindowOverrides, type ContextWindowOverridePatch } from '../common/context-window-overrides.ts'
import { WindowsDpapiCredentialStore } from '../token-store-windows.ts'
import { MacKeychainCredentialStore } from '../token-store-macos.ts'
import { SecretServiceCredentialStore } from '../credential-store-secret-service.ts'
import { dshHomeDir } from '../antigravity/token-store.ts'

export const ZHIPU_PREFERENCES_NAMESPACE = 'dsh-zhipu'

export type { ZhipuReasoningEffort, ZhipuRegion }

/** Runtime membership test for one stored effort value. */
function isReasoningEffort(value: unknown): value is ZhipuReasoningEffort {
  return typeof value === 'string' && (ZHIPU_REASONING_EFFORTS as readonly string[]).includes(value)
}

/**
 * One stored GLM Coding Plan credential.
 *
 * A Coding Plan credential is a long-lived console API key with nothing to
 * refresh and nothing to expire, so there is no token pair here. The key is
 * bound to one deployment: the same key is rejected by the other host, so the
 * region travels with the credential rather than with the process.
 */
export interface ZhipuCredentials {
  /** Console API key. Host-only; never sent to a browser. */
  apiKey: string
  /** Deployment the key was issued by. */
  region: ZhipuRegion
  /** Chat base URL this credential's region resolves to. */
  apiBase: string
  /** Display name the provider reports for the key, when it reports one. */
  keyName?: string
  /** Plan name/level the subscription service reports, when it reports one. */
  planLabel?: string
  planLevel?: string
  /** Unix milliseconds the key was saved. */
  authenticatedAt?: number
}

export interface ZhipuCatalogModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoningEfforts?: string[]
  supportsImage?: boolean
  canDisableThinking?: boolean
  regions?: ZhipuRegion[]
  description?: string
}

export interface ZhipuModelSettings {
  enabled?: boolean
  enabledModelIds: string[]
  catalogModels: ZhipuCatalogModel[]
  contextWindowOverrides: Record<string, number>
  defaultReasoningEffort: ZhipuReasoningEffort | null
  /** Account pinned in the card; null means the pool's own strategy decides. */
  selectedAccountId: string | null
}

export interface ZhipuPreferenceStore {
  status(): ZhipuModelSettings
  update(patch: {
    enabled?: boolean
    enabledModelIds?: string[]
    /** `null` deletes one override and falls back to the catalog default. */
    contextWindowOverrides?: ContextWindowOverridePatch
    defaultReasoningEffort?: ZhipuReasoningEffort | null
    selectedAccountId?: string | null
  }): Promise<ZhipuModelSettings>
}

const DEFAULT_ENABLED_MODEL_IDS = [...DEFAULT_VISIBLE_MODEL_IDS]

function defaultSettings(): ZhipuModelSettings {
  return {
    enabled: true,
    enabledModelIds: [...DEFAULT_ENABLED_MODEL_IDS],
    catalogModels: [],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
    selectedAccountId: null,
  }
}

/**
 * Bind the model selection to the DSH settings document when the harness still
 * offers one, and to the JSON file beside it otherwise: a harness without the
 * register seam (0.1.7, and a headless test) reads that file back on boot.
 */
export function registerZhipuPreferenceStore(
  settings?: unknown,
  fallbackStore = new FileModelSettingsStore(),
): ZhipuPreferenceStore {
  if (!hasRegister(settings)) {
    // With no settings namespace to persist in, the JSON file beside the
    // credentials is the store. It is read once here, so a selection saved by an
    // earlier run is still the selection on the next boot.
    let snapshot: ZhipuModelSettings = defaultSettings()
    void fallbackStore.read().then((stored) => { snapshot = stored }).catch(() => undefined)
    return {
      status: () => snapshot,
      update: async (patch) => {
        snapshot = await fallbackStore.updateSettings(patch)
        return snapshot
      },
    }
  }

  const scope = settings.register(resolveSettingsNamespace(ZHIPU_PREFERENCES_NAMESPACE), z.object({
    enabled: z.boolean().default(true),
    enabledModelIds: z.array(z.string()).default([...DEFAULT_ENABLED_MODEL_IDS]),
    contextWindowOverrides: z.dict(z.number()).default({}),
    defaultReasoningEffort: z
      .union([
        ...ZHIPU_REASONING_EFFORTS.map((effort) => z.const(effort)),
        z.const(null),
      ])
      .default(null),
    selectedAccountId: z.union([z.string(), z.const(null)]).default(null),
  })) as SettingsScope<{
    enabled: boolean
    enabledModelIds: string[]
    contextWindowOverrides: Record<string, number>
    defaultReasoningEffort: ZhipuReasoningEffort | null
    selectedAccountId: string | null
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
        selectedAccountId: value.selectedAccountId ?? null,
      }
    },
    update: async (patch) => {
      const current = scope.get()
      const normalized = {
        enabled: patch.enabled !== undefined ? patch.enabled : (current.enabled !== false),
        enabledModelIds: patch.enabledModelIds ?? current.enabledModelIds,
        contextWindowOverrides: patch.contextWindowOverrides
          ? mergeContextWindowOverrides(current.contextWindowOverrides, patch.contextWindowOverrides)
          : current.contextWindowOverrides,
        defaultReasoningEffort: patch.defaultReasoningEffort !== undefined
          ? patch.defaultReasoningEffort
          : current.defaultReasoningEffort,
        selectedAccountId: patch.selectedAccountId !== undefined
          ? patch.selectedAccountId
          : (current.selectedAccountId ?? null),
      }
      await scope.update(normalized)
      void fallbackStore.updateSettings(patch).catch(() => undefined)
      return { ...normalized, catalogModels: [] }
    },
  }
}

export function credentialPath(): string {
  return path.join(dshHomeDir(), 'storages', 'zhipu-credentials.json')
}

export function modelSettingsPath(): string {
  return path.join(dshHomeDir(), 'storages', 'zhipu-models.json')
}

/**
 * Stable, non-secret identity of one key.
 *
 * The key itself is never written into a file name or an alias; a digest of it
 * plus the region is what distinguishes two keys of the same account, and the
 * region is part of the identity because the same key text cannot be valid on
 * both deployments at once.
 */
export function zhipuAccountKey(credentials: Pick<ZhipuCredentials, 'apiKey' | 'region'>): string {
  return `${credentials.region}:${createHash('sha256').update(credentials.apiKey).digest('hex').slice(0, 16)}`
}

/** Last four characters of a key, the most a card may show. */
export function zhipuKeyHint(apiKey: string): string {
  const trimmed = apiKey.trim()
  return trimmed.length <= 4 ? '••••' : `••••${trimmed.slice(-4)}`
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('GLM Coding Plan credential payload is invalid')
  return value
}

export function parseZhipuCredentials(value: unknown): ZhipuCredentials {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('GLM Coding Plan credential payload is invalid')
  }
  const record = value as Record<string, unknown>
  const apiKey = record.apiKey
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error('GLM Coding Plan credential is missing its API key')
  }
  const region = record.region === 'cn' ? 'cn' : 'intl'
  const credentials: ZhipuCredentials = {
    apiKey: apiKey.trim(),
    region,
    // The base URL is derived from the region rather than trusted from a file,
    // so a stale or hand-edited value can never point the key at the wrong host.
    apiBase: apiBaseFor(region),
  }
  for (const key of ['keyName', 'planLabel', 'planLevel'] as const) {
    const parsed = optionalString(record, key)
    if (parsed !== undefined) credentials[key] = parsed
  }
  const authenticatedAt = record.authenticatedAt
  if (authenticatedAt !== undefined) {
    if (typeof authenticatedAt !== 'number' || !Number.isFinite(authenticatedAt)) {
      throw new Error('GLM Coding Plan credential timestamp is invalid')
    }
    credentials.authenticatedAt = authenticatedAt
  }
  return credentials
}

function apiBaseFor(region: ZhipuRegion): string {
  return apiBaseForRegion(region)
}

function credentialAccount(filePath: string): string {
  return createHash('sha256').update(path.resolve(filePath)).digest('hex')
}

function createCredentialBackend(filePath: string): CredentialStore<ZhipuCredentials> {
  if (process.platform === 'win32') {
    return new WindowsDpapiCredentialStore(`${filePath}.dpapi`, parseZhipuCredentials)
  }
  if (process.platform === 'darwin') {
    return new MacKeychainCredentialStore(PROVIDER_ID, credentialAccount(filePath), parseZhipuCredentials)
  }
  if (process.platform === 'linux') {
    return new SecretServiceCredentialStore(PROVIDER_ID, credentialAccount(filePath), parseZhipuCredentials)
  }
  throw new Error('GLM Coding Plan credential storage requires Windows, macOS, or Linux.')
}

// Key verification, quota requests, and adapter streams share migration ordering.
const credentialOperations = new Map<string, Promise<void>>()

/** Encrypted credential store; the plaintext JSON is only a migration source. */
export class FileCredentialStore {
  constructor(
    private readonly filePath = credentialPath(),
    private readonly backend: CredentialStore<ZhipuCredentials> = createCredentialBackend(filePath),
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
        throw new Error('GLM Coding Plan legacy credential removal failed')
      }
    }
  }

  private async saveVerified(credentials: ZhipuCredentials): Promise<void> {
    await this.backend.save(credentials)
    const restored = await this.backend.load()
    if (!isDeepStrictEqual(restored, credentials)) {
      throw new Error('GLM Coding Plan encrypted credential verification failed')
    }
    await this.removeLegacy()
  }

  read(): Promise<ZhipuCredentials | null> {
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
        throw new Error('GLM Coding Plan legacy credential read failed')
      }
      let credentials: ZhipuCredentials
      try {
        credentials = parseZhipuCredentials(JSON.parse(legacy) as unknown)
      } catch {
        throw new Error('GLM Coding Plan legacy credential payload is invalid')
      }
      await this.saveVerified(credentials)
      return credentials
    })
  }

  write(credentials: ZhipuCredentials): Promise<void> {
    return this.serialize(() => this.saveVerified(parseZhipuCredentials(credentials)))
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

  async read(): Promise<ZhipuModelSettings> {
    try {
      const content = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(content) as unknown
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>
        const enabledModelIds = Array.isArray(record.enabledModelIds)
          ? record.enabledModelIds.filter((id): id is string => typeof id === 'string')
          : [...DEFAULT_ENABLED_MODEL_IDS]
        const catalogModels = Array.isArray(record.catalogModels)
          ? (record.catalogModels as ZhipuCatalogModel[])
          : []
        const contextWindowOverrides =
          typeof record.contextWindowOverrides === 'object' && record.contextWindowOverrides !== null
            ? (record.contextWindowOverrides as Record<string, number>)
            : {}
        const defaultReasoningEffort = isReasoningEffort(record.defaultReasoningEffort)
          ? record.defaultReasoningEffort
          : null
        const selectedAccountId = typeof record.selectedAccountId === 'string' ? record.selectedAccountId : null
        const enabled = record.enabled !== false
        return { enabled, enabledModelIds, catalogModels, contextWindowOverrides, defaultReasoningEffort, selectedAccountId }
      }
    } catch {
      // A missing or unreadable settings file falls back to the shipped defaults.
    }
    return defaultSettings()
  }

  async write(settings: ZhipuModelSettings): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp.${Date.now()}`
    await fs.writeFile(tmp, JSON.stringify(settings, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
  }

  async updateSettings(patch: {
    enabled?: boolean
    enabledModelIds?: string[]
    /** `null` deletes one override and falls back to the catalog default. */
    contextWindowOverrides?: ContextWindowOverridePatch
    defaultReasoningEffort?: ZhipuReasoningEffort | null
    selectedAccountId?: string | null
  }): Promise<ZhipuModelSettings> {
    const current = await this.read()
    const next: ZhipuModelSettings = {
      ...current,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.enabledModelIds !== undefined ? { enabledModelIds: patch.enabledModelIds } : {}),
      ...(patch.contextWindowOverrides !== undefined
        ? { contextWindowOverrides: mergeContextWindowOverrides(current.contextWindowOverrides, patch.contextWindowOverrides) }
        : {}),
      ...(patch.defaultReasoningEffort !== undefined
        ? { defaultReasoningEffort: patch.defaultReasoningEffort }
        : {}),
      ...(patch.selectedAccountId !== undefined ? { selectedAccountId: patch.selectedAccountId } : {}),
    }
    await this.write(next)
    return next
  }

  async setCatalogModels(
    catalogModels: ZhipuCatalogModel[],
    options?: { enabledModelIds?: string[] },
  ): Promise<ZhipuModelSettings> {
    const current = await this.read()
    const next: ZhipuModelSettings = {
      ...current,
      enabledModelIds: options?.enabledModelIds ?? current.enabledModelIds,
      catalogModels,
    }
    await this.write(next)
    return next
  }
}

