import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { CredentialStore } from '../token-store.ts'
import { WindowsDpapiCredentialStore } from '../token-store-windows.ts'
import { MacKeychainCredentialStore } from '../token-store-macos.ts'
import { SecretServiceCredentialStore } from '../credential-store-secret-service.ts'
import { dshHomeDir } from '../common/home.ts'
import { t } from '../common/i18n/index.ts'
import { mergeContextWindowOverrides, type ContextWindowOverridePatch } from '../common/context-window-overrides.ts'
import type {
  QianwenCacheTtl,
  QianwenImageDetail,
  QianwenReasoningEffort,
} from '../../shared/qianwen-token-plan-contracts.ts'
import {
  isQianwenCacheTtl,
  isQianwenImageDetail,
  isQianwenReasoningEffort,
} from '../../shared/qianwen-token-plan-contracts.ts'
import { PROVIDER_ID, QIANWEN_MAX_PIXELS, QIANWEN_MIN_PIXELS } from './types.ts'

export interface QianwenCredentials {
  apiKey: string
  authenticatedAt: number
}

export interface QianwenSettings {
  enabled: boolean
  enabledModelIds: string[] | null
  selectionVersion: number
  contextWindowOverrides: Record<string, number>
  defaultReasoningEffort: QianwenReasoningEffort | null
  cacheEnabled: boolean
  cacheTtl: QianwenCacheTtl
  thinkingSummary: boolean
  imageDetail: QianwenImageDetail
  maxPixels: number | null
}

export interface QianwenSettingsPatch {
  enabled?: boolean
  enabledModelIds?: string[]
  contextWindowOverrides?: ContextWindowOverridePatch
  defaultReasoningEffort?: QianwenReasoningEffort | null
  cacheEnabled?: boolean
  cacheTtl?: QianwenCacheTtl
  thinkingSummary?: boolean
  imageDetail?: QianwenImageDetail
  maxPixels?: number | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseQianwenCredentials(value: unknown): QianwenCredentials {
  if (!isRecord(value)) throw new Error(t('sc.credentialPayloadInvalid', { provider: 'Qwen Token Plan' }))
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : ''
  if (apiKey === '') throw new Error(t('sc.credentialNoApiKey', { provider: 'Qwen Token Plan' }))
  const authenticatedAt = typeof value.authenticatedAt === 'number' && Number.isFinite(value.authenticatedAt)
    ? value.authenticatedAt
    : Date.now()
  return { apiKey, authenticatedAt }
}

export function credentialPath(): string {
  return path.join(dshHomeDir(), 'storages', 'qianwen-token-plan-credentials.json')
}
export function modelSettingsPath(): string {
  return path.join(dshHomeDir(), 'storages', 'qianwen-token-plan-settings.json')
}
function credentialAccount(filePath: string): string {
  return createHash('sha256').update(path.resolve(filePath)).digest('hex')
}
function createCredentialBackend(filePath: string): CredentialStore<QianwenCredentials> {
  if (process.platform === 'win32') return new WindowsDpapiCredentialStore(filePath + '.dpapi', parseQianwenCredentials)
  if (process.platform === 'darwin') return new MacKeychainCredentialStore(PROVIDER_ID, credentialAccount(filePath), parseQianwenCredentials)
  if (process.platform === 'linux') return new SecretServiceCredentialStore(PROVIDER_ID, credentialAccount(filePath), parseQianwenCredentials)
  throw new Error(t('sc.storeUnsupportedPlatform', { label: 'Qwen Token Plan' }))
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

export class QianwenCredentialStore {
  private readonly filePath: string
  private readonly backend: CredentialStore<QianwenCredentials>
  constructor(filePath: string = credentialPath(), backend?: CredentialStore<QianwenCredentials>) {
    this.filePath = filePath
    this.backend = backend ?? createCredentialBackend(filePath)
  }
  path(): string {
    if (process.platform === 'win32') return this.filePath + '.dpapi'
    return (process.platform === 'darwin' ? 'Keychain: ' : 'Secret Service: ') + PROVIDER_ID + '/' + credentialAccount(this.filePath)
  }
  read(): Promise<QianwenCredentials | null> {
    return serialize(this.filePath, () => this.backend.load())
  }
  write(credentials: QianwenCredentials): Promise<void> {
    return serialize(this.filePath, async () => {
      const normalized = parseQianwenCredentials(credentials)
      await this.backend.save(normalized)
      const restored = await this.backend.load()
      if (!isDeepStrictEqual(restored, normalized)) throw new Error(t('sc.encryptedWriteVerifyFailed', { provider: 'Qwen Token Plan' }))
    })
  }
  delete(): Promise<void> {
    return serialize(this.filePath, () => this.backend.clear())
  }
}

export const QIANWEN_SELECTION_VERSION = 2
const V1_DEFAULT_IDS = ['qwen4-max', 'qwen4-max-preview', 'qwen4.0-max-preview']
const sameIds = (left: readonly string[] | null, right: readonly string[]): boolean => left !== null && left.length === right.length && left.every(id => right.includes(id))

export function defaultQianwenSettings(): QianwenSettings {
  return {
    enabled: true,
    enabledModelIds: null,
    selectionVersion: QIANWEN_SELECTION_VERSION,
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
    cacheEnabled: true,
    cacheTtl: '5m',
    thinkingSummary: true,
    imageDetail: 'auto',
    maxPixels: null,
  }
}

function validPixels(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= QIANWEN_MIN_PIXELS && value <= QIANWEN_MAX_PIXELS ? value : null
}

export function parseQianwenSettings(value: unknown): QianwenSettings {
  const fallback = defaultQianwenSettings()
  if (!isRecord(value)) return fallback
  const overrides: Record<string, number> = {}
  if (isRecord(value.contextWindowOverrides)) {
    for (const [id, raw] of Object.entries(value.contextWindowOverrides)) {
      if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) overrides[id] = raw
    }
  }
  const parsedIds = Array.isArray(value.enabledModelIds)
    ? [...new Set(value.enabledModelIds.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map(id => id.trim()))]
    : null
  const uneditedV1 = value.selectionVersion !== QIANWEN_SELECTION_VERSION
    && (value.enabledModelIds === undefined || sameIds(parsedIds, V1_DEFAULT_IDS))
  return {
    enabled: value.enabled !== false,
    enabledModelIds: uneditedV1 ? null : parsedIds,
    selectionVersion: QIANWEN_SELECTION_VERSION,
    contextWindowOverrides: overrides,
    defaultReasoningEffort: isQianwenReasoningEffort(value.defaultReasoningEffort) ? value.defaultReasoningEffort : null,
    cacheEnabled: value.cacheEnabled !== false,
    cacheTtl: isQianwenCacheTtl(value.cacheTtl) ? value.cacheTtl : '5m',
    thinkingSummary: value.thinkingSummary !== false,
    imageDetail: isQianwenImageDetail(value.imageDetail) ? value.imageDetail : 'auto',
    maxPixels: value.maxPixels === null ? null : validPixels(value.maxPixels),
  }
}

export function mergeQianwenSettings(current: QianwenSettings, patch: QianwenSettingsPatch): QianwenSettings {
  return parseQianwenSettings({
    ...current,
    ...patch,
    contextWindowOverrides: patch.contextWindowOverrides === undefined
      ? current.contextWindowOverrides
      : mergeContextWindowOverrides(current.contextWindowOverrides, patch.contextWindowOverrides),
    enabledModelIds: patch.enabledModelIds === undefined ? current.enabledModelIds : patch.enabledModelIds,
    selectionVersion: QIANWEN_SELECTION_VERSION,
    defaultReasoningEffort: patch.defaultReasoningEffort === undefined ? current.defaultReasoningEffort : patch.defaultReasoningEffort,
    maxPixels: patch.maxPixels === undefined ? current.maxPixels : patch.maxPixels,
  })
}

let writeSequence = 0
export class QianwenSettingsStore {
  private readonly filePath: string
  private migration: Promise<void> | undefined
  constructor(filePath: string = modelSettingsPath()) { this.filePath = filePath }
  path(): string { return this.filePath }
  async read(): Promise<QianwenSettings> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown
      const parsed = parseQianwenSettings(raw)
      if (isRecord(raw) && raw.selectionVersion !== QIANWEN_SELECTION_VERSION) {
        // Persist the marker once; a migration write failure never discards the readable settings.
        this.migration ??= this.write(parsed).catch(() => undefined)
        await this.migration
      }
      return parsed
    } catch { return defaultQianwenSettings() }
  }
  async write(settings: QianwenSettings): Promise<void> {
    const normalized = parseQianwenSettings(settings)
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    writeSequence += 1
    const temporary = this.filePath + '.tmp.' + process.pid + '.' + writeSequence
    try {
      await fs.writeFile(temporary, JSON.stringify(normalized, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temporary, this.filePath)
      const restored = parseQianwenSettings(JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown)
      if (!isDeepStrictEqual(restored, normalized)) throw new Error(t('sc.modelSettingsWriteFailed', { provider: 'Qwen Token Plan' }))
    } finally {
      await fs.unlink(temporary).catch(() => undefined)
    }
  }
  updateSettings(patch: QianwenSettingsPatch): Promise<QianwenSettings> {
    return serialize(this.filePath, async () => {
      const next = mergeQianwenSettings(await this.read(), patch)
      await this.write(next)
      return next
    })
  }
}
