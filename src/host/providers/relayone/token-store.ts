import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { CredentialStore } from '../../infra/storage/token-store.ts'
import { WindowsDpapiCredentialStore } from '../../infra/storage/token-store-windows.ts'
import { MacKeychainCredentialStore } from '../../infra/storage/token-store-macos.ts'
import { SecretServiceCredentialStore } from '../../infra/storage/credential-store-secret-service.ts'
import { dshHomeDir } from '../../common/home.ts'
import { mergeContextWindowOverrides, type ContextWindowOverridePatch } from '../../common/context-window-overrides.ts'
import {
  isRelayOneReasoningEffort,
  type RelayOneReasoningEffort,
} from '../../../shared/relayone-contracts.ts'
import { PROVIDER_ID, PROVIDER_NAME } from './types.ts'

export interface RelayOneCredentials {
  apiKey: string
  authenticatedAt: number
}

export interface RelayOneSettings {
  enabled: boolean
  /** null = every currently accessible chat model; [] = explicitly none. */
  enabledModelIds: string[] | null
  contextWindowOverrides: Record<string, number>
  defaultReasoningEffort: RelayOneReasoningEffort | null
  imageModel: string | null
  videoModel: string | null
}

export interface RelayOneSettingsPatch {
  enabled?: boolean
  enabledModelIds?: string[]
  contextWindowOverrides?: ContextWindowOverridePatch
  defaultReasoningEffort?: RelayOneReasoningEffort | null
  imageModel?: string | null
  videoModel?: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseRelayOneCredentials(value: unknown): RelayOneCredentials {
  if (!isRecord(value)) throw new Error('RelayOne credential payload is invalid.')
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : ''
  if (apiKey === '') throw new Error('RelayOne credential contains no API key.')
  return {
    apiKey,
    authenticatedAt: typeof value.authenticatedAt === 'number' && Number.isFinite(value.authenticatedAt)
      ? value.authenticatedAt : Date.now(),
  }
}

export function relayOneCredentialPath(): string {
  return path.join(dshHomeDir(), 'storages', 'relayone-credentials.json')
}
export function relayOneSettingsPath(): string {
  return path.join(dshHomeDir(), 'storages', 'relayone-settings.json')
}
export function relayOneCredentialFingerprint(credentials: RelayOneCredentials): string {
  return createHash('sha256').update(credentials.apiKey).digest('hex')
}
function credentialAccount(filePath: string): string {
  return createHash('sha256').update(path.resolve(filePath)).digest('hex')
}
function createCredentialBackend(filePath: string): CredentialStore<RelayOneCredentials> {
  if (process.platform === 'win32') return new WindowsDpapiCredentialStore(filePath + '.dpapi', parseRelayOneCredentials)
  if (process.platform === 'darwin') return new MacKeychainCredentialStore(PROVIDER_ID, credentialAccount(filePath), parseRelayOneCredentials)
  if (process.platform === 'linux') return new SecretServiceCredentialStore(PROVIDER_ID, credentialAccount(filePath), parseRelayOneCredentials)
  throw new Error('RelayOne credential storage is unsupported on this platform.')
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

export class RelayOneCredentialStore {
  private readonly backend: CredentialStore<RelayOneCredentials>
  constructor(private readonly filePath: string = relayOneCredentialPath(), backend?: CredentialStore<RelayOneCredentials>) {
    this.backend = backend ?? createCredentialBackend(filePath)
  }
  path(): string {
    if (process.platform === 'win32') return this.filePath + '.dpapi'
    return (process.platform === 'darwin' ? 'Keychain: ' : 'Secret Service: ') + PROVIDER_ID + '/' + credentialAccount(this.filePath)
  }
  read(): Promise<RelayOneCredentials | null> {
    return serialize(this.filePath, () => this.backend.load())
  }
  write(credentials: RelayOneCredentials): Promise<void> {
    return serialize(this.filePath, async () => {
      const normalized = parseRelayOneCredentials(credentials)
      await this.backend.save(normalized)
      const restored = await this.backend.load()
      if (!isDeepStrictEqual(restored, normalized)) throw new Error('RelayOne encrypted credential write verification failed.')
    })
  }
  delete(): Promise<void> {
    return serialize(this.filePath, () => this.backend.clear())
  }
}

export function defaultRelayOneSettings(): RelayOneSettings {
  return {
    enabled: true,
    enabledModelIds: null,
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
    imageModel: null,
    videoModel: null,
  }
}

export function parseRelayOneSettings(value: unknown): RelayOneSettings {
  const fallback = defaultRelayOneSettings()
  if (!isRecord(value)) return fallback
  const overrides: Record<string, number> = {}
  if (isRecord(value.contextWindowOverrides)) {
    for (const [id, raw] of Object.entries(value.contextWindowOverrides)) {
      if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 && raw <= 10_000_000) overrides[id] = raw
    }
  }
  return {
    enabled: value.enabled !== false,
    enabledModelIds: Array.isArray(value.enabledModelIds)
      ? [...new Set(value.enabledModelIds.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map(id => id.trim()))]
      : null,
    contextWindowOverrides: overrides,
    defaultReasoningEffort: isRelayOneReasoningEffort(value.defaultReasoningEffort) ? value.defaultReasoningEffort : null,
    imageModel: typeof value.imageModel === 'string' && value.imageModel.trim() !== '' ? value.imageModel.trim() : null,
    videoModel: typeof value.videoModel === 'string' && value.videoModel.trim() !== '' ? value.videoModel.trim() : null,
  }
}

export function mergeRelayOneSettings(current: RelayOneSettings, patch: RelayOneSettingsPatch): RelayOneSettings {
  return parseRelayOneSettings({
    ...current,
    ...patch,
    contextWindowOverrides: patch.contextWindowOverrides === undefined
      ? current.contextWindowOverrides
      : mergeContextWindowOverrides(current.contextWindowOverrides, patch.contextWindowOverrides),
    enabledModelIds: patch.enabledModelIds === undefined ? current.enabledModelIds : patch.enabledModelIds,
    defaultReasoningEffort: patch.defaultReasoningEffort === undefined ? current.defaultReasoningEffort : patch.defaultReasoningEffort,
    imageModel: patch.imageModel === undefined ? current.imageModel : patch.imageModel,
    videoModel: patch.videoModel === undefined ? current.videoModel : patch.videoModel,
  })
}

let writeSequence = 0
export class RelayOneSettingsStore {
  constructor(private readonly filePath: string = relayOneSettingsPath()) {}
  path(): string { return this.filePath }
  async read(): Promise<RelayOneSettings> {
    try { return parseRelayOneSettings(JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown) }
    catch { return defaultRelayOneSettings() }
  }
  async write(settings: RelayOneSettings): Promise<void> {
    const normalized = parseRelayOneSettings(settings)
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    writeSequence += 1
    const temporary = this.filePath + '.tmp.' + process.pid + '.' + writeSequence
    try {
      await fs.writeFile(temporary, JSON.stringify(normalized, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temporary, this.filePath)
      const restored = parseRelayOneSettings(JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown)
      if (!isDeepStrictEqual(restored, normalized)) throw new Error('RelayOne settings write verification failed.')
    } finally {
      await fs.unlink(temporary).catch(() => undefined)
    }
  }
  updateSettings(patch: RelayOneSettingsPatch): Promise<RelayOneSettings> {
    return serialize(this.filePath, async () => {
      const next = mergeRelayOneSettings(await this.read(), patch)
      await this.write(next)
      return next
    })
  }
}
