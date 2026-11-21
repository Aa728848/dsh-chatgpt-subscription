import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { CredentialStore } from '../token-store.ts'
import { WindowsDpapiCredentialStore } from '../token-store-windows.ts'
import { MacKeychainCredentialStore } from '../token-store-macos.ts'
import { SecretServiceCredentialStore } from '../credential-store-secret-service.ts'
import { dshHomeDir } from '../common/home.ts'
import { mergeContextWindowOverrides, type ContextWindowOverridePatch } from '../common/context-window-overrides.ts'
import {
  CLAUDE_API_DEFAULT_BASE_URL,
  isClaudeApiCacheTtl,
  isClaudeApiReasoningEffort,
  normalizeClaudeApiBaseUrl,
  type ClaudeApiCacheTtl,
  type ClaudeApiReasoningEffort,
} from '../../shared/claude-api-contracts.ts'
import { PROVIDER_ID, PROVIDER_NAME } from './types.ts'

export interface ClaudeApiCredentials {
  apiKey: string
  authenticatedAt: number
}

export interface ClaudeApiSettings {
  enabled: boolean
  /** Normalized endpoint; always a valid http(s) origin with an optional path prefix. */
  baseUrl: string
  /** null = every currently listed model; [] = explicitly none. */
  enabledModelIds: string[] | null
  contextWindowOverrides: Record<string, number>
  defaultReasoningEffort: ClaudeApiReasoningEffort | null
  cacheTtl: ClaudeApiCacheTtl
  fastMode: boolean
  serverCompaction: boolean
  /** 64 hex chars, generated once per install; '' until ensureDeviceId ran. Never sent to the client. */
  deviceId: string
}

export interface ClaudeApiSettingsPatch {
  enabled?: boolean
  /** null restores the default endpoint. A value must already be normalized by the caller. */
  baseUrl?: string | null
  enabledModelIds?: string[]
  contextWindowOverrides?: ContextWindowOverridePatch
  defaultReasoningEffort?: ClaudeApiReasoningEffort | null
  cacheTtl?: ClaudeApiCacheTtl
  fastMode?: boolean
  serverCompaction?: boolean
}

const DEVICE_ID_PATTERN = /^[0-9a-f]{64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseClaudeApiCredentials(value: unknown): ClaudeApiCredentials {
  if (!isRecord(value)) throw new Error(PROVIDER_NAME + ' credential payload is invalid.')
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : ''
  if (apiKey === '') throw new Error(PROVIDER_NAME + ' credential contains no API key.')
  return {
    apiKey,
    authenticatedAt: typeof value.authenticatedAt === 'number' && Number.isFinite(value.authenticatedAt)
      ? value.authenticatedAt : Date.now(),
  }
}

export function claudeApiCredentialPath(): string {
  return path.join(dshHomeDir(), 'storages', 'claude-api-credentials.json')
}
export function claudeApiSettingsPath(): string {
  return path.join(dshHomeDir(), 'storages', 'claude-api-settings.json')
}
/** Scope of everything cached per credential: the key AND the endpoint it is used against. */
export function claudeApiCredentialFingerprint(credentials: ClaudeApiCredentials, baseUrl: string): string {
  return createHash('sha256').update(credentials.apiKey).update('\n').update(baseUrl).digest('hex')
}
function credentialAccount(filePath: string): string {
  return createHash('sha256').update(path.resolve(filePath)).digest('hex')
}
function createCredentialBackend(filePath: string): CredentialStore<ClaudeApiCredentials> {
  if (process.platform === 'win32') return new WindowsDpapiCredentialStore(filePath + '.dpapi', parseClaudeApiCredentials)
  if (process.platform === 'darwin') return new MacKeychainCredentialStore(PROVIDER_ID, credentialAccount(filePath), parseClaudeApiCredentials)
  if (process.platform === 'linux') return new SecretServiceCredentialStore(PROVIDER_ID, credentialAccount(filePath), parseClaudeApiCredentials)
  throw new Error(PROVIDER_NAME + ' credential storage is unsupported on this platform.')
}

const operations = new Map<string, Promise<void>>()
function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(key)
  const result = (operations.get(resolved) ?? Promise.resolve()).then(operation)
  const settled = result.then(() => undefined, () => undefined)
  operations.set(resolved, settled)
  void settled.then(() => { if (operations.get(resolved) === settled) operations.delete(resolved) })
  return result
}

export class ClaudeApiCredentialStore {
  private readonly backend: CredentialStore<ClaudeApiCredentials>
  constructor(private readonly filePath: string = claudeApiCredentialPath(), backend?: CredentialStore<ClaudeApiCredentials>) {
    this.backend = backend ?? createCredentialBackend(filePath)
  }
  path(): string {
    if (process.platform === 'win32') return this.filePath + '.dpapi'
    return (process.platform === 'darwin' ? 'Keychain: ' : 'Secret Service: ') + PROVIDER_ID + '/' + credentialAccount(this.filePath)
  }
  read(): Promise<ClaudeApiCredentials | null> {
    return serialize(this.filePath, () => this.backend.load())
  }
  write(credentials: ClaudeApiCredentials): Promise<void> {
    return serialize(this.filePath, async () => {
      const normalized = parseClaudeApiCredentials(credentials)
      await this.backend.save(normalized)
      const restored = await this.backend.load()
      if (!isDeepStrictEqual(restored, normalized)) throw new Error(PROVIDER_NAME + ' encrypted credential write verification failed.')
    })
  }
  delete(): Promise<void> {
    return serialize(this.filePath, () => this.backend.clear())
  }
}

export function defaultClaudeApiSettings(): ClaudeApiSettings {
  return {
    enabled: true,
    baseUrl: CLAUDE_API_DEFAULT_BASE_URL,
    enabledModelIds: null,
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
    cacheTtl: '5m',
    fastMode: false,
    serverCompaction: true,
    deviceId: '',
  }
}

export function parseClaudeApiSettings(value: unknown): ClaudeApiSettings {
  const fallback = defaultClaudeApiSettings()
  if (!isRecord(value)) return fallback
  const overrides: Record<string, number> = {}
  if (isRecord(value.contextWindowOverrides)) {
    for (const [id, raw] of Object.entries(value.contextWindowOverrides)) {
      if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 && raw <= 10_000_000) overrides[id] = raw
    }
  }
  const baseUrl = normalizeClaudeApiBaseUrl(value.baseUrl)
  return {
    enabled: value.enabled !== false,
    baseUrl: baseUrl.ok ? baseUrl.value : fallback.baseUrl,
    enabledModelIds: Array.isArray(value.enabledModelIds)
      ? [...new Set(value.enabledModelIds.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map(id => id.trim()))]
      : null,
    contextWindowOverrides: overrides,
    defaultReasoningEffort: isClaudeApiReasoningEffort(value.defaultReasoningEffort) ? value.defaultReasoningEffort : null,
    cacheTtl: isClaudeApiCacheTtl(value.cacheTtl) ? value.cacheTtl : fallback.cacheTtl,
    fastMode: value.fastMode === true,
    serverCompaction: value.serverCompaction !== false,
    deviceId: typeof value.deviceId === 'string' && DEVICE_ID_PATTERN.test(value.deviceId) ? value.deviceId : '',
  }
}

export function mergeClaudeApiSettings(current: ClaudeApiSettings, patch: ClaudeApiSettingsPatch): ClaudeApiSettings {
  return parseClaudeApiSettings({
    ...current,
    ...patch,
    baseUrl: patch.baseUrl === undefined ? current.baseUrl : patch.baseUrl === null ? CLAUDE_API_DEFAULT_BASE_URL : patch.baseUrl,
    contextWindowOverrides: patch.contextWindowOverrides === undefined
      ? current.contextWindowOverrides
      : mergeContextWindowOverrides(current.contextWindowOverrides, patch.contextWindowOverrides),
    enabledModelIds: patch.enabledModelIds === undefined ? current.enabledModelIds : patch.enabledModelIds,
    defaultReasoningEffort: patch.defaultReasoningEffort === undefined ? current.defaultReasoningEffort : patch.defaultReasoningEffort,
    // The device id is install state, never a patchable preference.
    deviceId: current.deviceId,
  })
}

let writeSequence = 0
export class ClaudeApiSettingsStore {
  constructor(private readonly filePath: string = claudeApiSettingsPath()) {}
  path(): string { return this.filePath }
  async read(): Promise<ClaudeApiSettings> {
    try { return parseClaudeApiSettings(JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown) }
    catch { return defaultClaudeApiSettings() }
  }
  async write(settings: ClaudeApiSettings): Promise<void> {
    const normalized = parseClaudeApiSettings(settings)
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    writeSequence += 1
    const temporary = this.filePath + '.tmp.' + process.pid + '.' + writeSequence
    try {
      await fs.writeFile(temporary, JSON.stringify(normalized, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temporary, this.filePath)
      const restored = parseClaudeApiSettings(JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown)
      if (!isDeepStrictEqual(restored, normalized)) throw new Error(PROVIDER_NAME + ' settings write verification failed.')
    } finally {
      await fs.unlink(temporary).catch(() => undefined)
    }
  }
  async update(patch: ClaudeApiSettingsPatch): Promise<ClaudeApiSettings> {
    return serialize(this.filePath, async () => {
      const next = mergeClaudeApiSettings(await this.read(), patch)
      await this.write(next)
      return next
    })
  }
  /** The persisted device id, generated on first use. Stable for the life of the install. */
  async ensureDeviceId(): Promise<string> {
    return serialize(this.filePath, async () => {
      const current = await this.read()
      if (current.deviceId !== '') return current.deviceId
      const deviceId = randomBytes(32).toString('hex')
      await this.write({ ...current, deviceId })
      return deviceId
    })
  }
}
