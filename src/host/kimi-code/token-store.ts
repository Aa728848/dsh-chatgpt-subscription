import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { SettingsProvider, SettingsScope } from '@deepseek-ai/dsh-settings'
import * as SettingsModule from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type { KimiCodeReasoningEffort, KimiCodeRegion } from '../../shared/kimi-code-contracts.ts'
import { KIMI_CODE_REASONING_EFFORTS } from '../../shared/kimi-code-contracts.ts'
import type { CredentialStore } from '../token-store.ts'
import { WindowsDpapiCredentialStore } from '../token-store-windows.ts'
import { MacKeychainCredentialStore } from '../token-store-macos.ts'
import { SecretServiceCredentialStore } from '../credential-store-secret-service.ts'
import { dshHomeDir } from '../antigravity/token-store.ts'
import { DEFAULT_OAUTH_HOST, FALLBACK_MODELS, PROVIDER_ID, REGION_HOSTS, codingBaseUrl, oauthHost } from './types.ts'

export const KIMI_CODE_PREFERENCES_NAMESPACE = 'dsh-kimi-code'

export type { KimiCodeReasoningEffort }

/** Runtime membership test for one stored effort value. */
function isReasoningEffort(value: unknown): value is KimiCodeReasoningEffort {
  return typeof value === 'string' && (KIMI_CODE_REASONING_EFFORTS as readonly string[]).includes(value)
}

/**
 * One stored Kimi Code credential.
 *
 * Kimi Code is an OAuth subscription: the bearer pair rotates, so both tokens
 * are kept and the access token is refreshed shortly before it expires. The
 * remaining fields are non-secret account facts the settings card renders
 * without another round trip.
 */
export interface KimiCodeCredentials {
  /** Bearer access token for the coding API. Host-only; never sent to a browser. */
  accessToken: string
  /** Rotating refresh token. Host-only. */
  refreshToken: string
  /** Unix milliseconds the access token stops being valid. */
  expiresAt: number
  /** Lifetime the token endpoint reported, in seconds. */
  expiresIn: number
  scope?: string
  tokenType?: string
  /** Region the credential was issued in; decides which hosts are used. */
  region: KimiCodeRegion
  /** OAuth host the credential came from, so a refresh targets the same one. */
  oauthHost: string
  /** Coding API base URL the credential was issued for, without /v1. */
  baseUrl: string
  userId?: string
  nickname?: string
  email?: string
  planName?: string
  /** Unix milliseconds the credential was obtained. */
  authenticatedAt?: number
}

export interface KimiCodeCatalogModel {
  id: string
  name?: string
  contextWindow?: number
  reasoningEfforts?: string[]
  defaultReasoningEffort?: string
  inputModalities?: Array<'text' | 'image' | 'video'>
  protocol?: 'openai' | 'anthropic'
  /** Whether the model also accepts video input (reported; DSH cannot send it). */
  supportsVideo?: boolean
  /** One-line description from the official model table. */
  description?: string
  /** Subscription tier the model needs, when not every member has it. */
  minimumPlan?: string | null
  /**
   * Whether the model supports dynamically loaded tools.
   *
   * K3 advertises this: extra tool definitions can be injected mid-conversation
   * as a system message carrying a `tools` array, keeping the top-level list
   * small and stable. DSH has no equivalent concept, so this is reported for
   * information rather than acted on.
   */
  supportsDynamicTools?: boolean
}

export interface KimiCodeModelSettings {
  enabled?: boolean
  enabledModelIds: string[]
  catalogModels: KimiCodeCatalogModel[]
  contextWindowOverrides: Record<string, number>
  defaultReasoningEffort: KimiCodeReasoningEffort | null
}

export interface KimiCodePreferenceStore {
  status(): KimiCodeModelSettings
  update(patch: {
    enabled?: boolean
    enabledModelIds?: string[]
    contextWindowOverrides?: Record<string, number>
    defaultReasoningEffort?: KimiCodeReasoningEffort | null
  }): Promise<KimiCodeModelSettings>
}

const DEFAULT_ENABLED_MODEL_IDS = FALLBACK_MODELS.map((model) => model.id)

/**
 * Bind the model selection to the DSH settings document, which is what the
 * settings service can persist durably; the JSON file beside it remains the
 * store used when the plugin runs without a settings provider (headless tests).
 */
export function registerKimiCodePreferenceStore(
  settings?: SettingsProvider,
  fallbackStore = new FileModelSettingsStore(),
): KimiCodePreferenceStore {
  if (!settings) {
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
    ? ((SettingsModule as unknown as Record<string, Function>).settingsNamespace)(KIMI_CODE_PREFERENCES_NAMESPACE)
    : KIMI_CODE_PREFERENCES_NAMESPACE) as unknown

  const scope = (settings.register as Function).call(settings, ns, z.object({
    enabled: z.boolean().default(true),
    enabledModelIds: z.array(z.string()).default([...DEFAULT_ENABLED_MODEL_IDS]),
    contextWindowOverrides: z.dict(z.number()).default({}),
    defaultReasoningEffort: z
      .union([
        ...KIMI_CODE_REASONING_EFFORTS.map((effort) => z.const(effort)),
        z.const(null),
      ])
      .default(null),
  })) as SettingsScope<{
    enabled: boolean
    enabledModelIds: string[]
    contextWindowOverrides: Record<string, number>
    defaultReasoningEffort: KimiCodeReasoningEffort | null
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
  return path.join(dshHomeDir(), 'storages', 'kimi-code-credentials.json')
}

export function modelSettingsPath(): string {
  return path.join(dshHomeDir(), 'storages', 'kimi-code-models.json')
}

/** File the install channel uses to pin a region before the first login. */
export function regionMarkerPath(): string {
  return path.join(dshHomeDir(), 'kimi-code-region')
}

/**
 * Stable per-installation device id the managed service expects.
 *
 * The official client writes this once and reuses it; it is not a secret, only
 * an identity marker, so it lives beside the other plugin state.
 */
export function deviceIdPath(): string {
  return path.join(dshHomeDir(), 'storages', 'kimi-code-device-id')
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('Kimi Code credential payload is invalid')
  return value
}

function isRegion(value: unknown): value is KimiCodeRegion {
  return value === 'mainland-cn' || value === 'global'
}

export function parseKimiCodeCredentials(value: unknown): KimiCodeCredentials {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Kimi Code credential payload is invalid')
  }
  const record = value as Record<string, unknown>
  const accessToken = record.accessToken
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new Error('Kimi Code credential is missing its access token')
  }
  const refreshToken = record.refreshToken
  if (typeof refreshToken !== 'string' || refreshToken === '') {
    throw new Error('Kimi Code credential is missing its refresh token')
  }
  const expiresAt = record.expiresAt
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    throw new Error('Kimi Code credential expiry is invalid')
  }
  const region = isRegion(record.region) ? record.region : 'mainland-cn'
  const credentials: KimiCodeCredentials = {
    accessToken,
    refreshToken,
    expiresAt,
    expiresIn: typeof record.expiresIn === 'number' && Number.isFinite(record.expiresIn) ? record.expiresIn : 0,
    region,
    // A stored host wins only when it looks like an absolute origin, so a
    // corrupted file cannot redirect a refresh at an attacker-chosen host.
    oauthHost: safeHost(optionalString(record, 'oauthHost')) ?? oauthHost(region),
    baseUrl: safeHost(optionalString(record, 'baseUrl')) ?? codingBaseUrl(region),
  }
  for (const key of ['scope', 'tokenType', 'userId', 'nickname', 'email', 'planName'] as const) {
    const parsed = optionalString(record, key)
    if (parsed !== undefined) credentials[key] = parsed
  }
  const authenticatedAt = record.authenticatedAt
  if (authenticatedAt !== undefined) {
    if (typeof authenticatedAt !== 'number' || !Number.isFinite(authenticatedAt)) {
      throw new Error('Kimi Code credential timestamp is invalid')
    }
    credentials.authenticatedAt = authenticatedAt
  }
  return credentials
}

/** Accept a stored absolute https origin, or nothing at all. */
function safeHost(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'https:') return undefined
    return trimmed.replace(/\/+$/, '')
  } catch {
    return undefined
  }
}

function credentialAccount(filePath: string): string {
  return createHash('sha256').update(path.resolve(filePath)).digest('hex')
}

function createCredentialBackend(filePath: string): CredentialStore<KimiCodeCredentials> {
  if (process.platform === 'win32') {
    return new WindowsDpapiCredentialStore(`${filePath}.dpapi`, parseKimiCodeCredentials)
  }
  if (process.platform === 'darwin') {
    return new MacKeychainCredentialStore(PROVIDER_ID, credentialAccount(filePath), parseKimiCodeCredentials)
  }
  if (process.platform === 'linux') {
    return new SecretServiceCredentialStore(PROVIDER_ID, credentialAccount(filePath), parseKimiCodeCredentials)
  }
  throw new Error('Kimi Code credential storage requires Windows, macOS, or Linux.')
}

// Login, quota requests, and adapter streams share migration ordering.
const credentialOperations = new Map<string, Promise<void>>()

/** Encrypted credential store; the plaintext JSON is only a migration source. */
export class FileCredentialStore {
  constructor(
    private readonly filePath = credentialPath(),
    private readonly backend: CredentialStore<KimiCodeCredentials> = createCredentialBackend(filePath),
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
        throw new Error('Kimi Code legacy credential removal failed')
      }
    }
  }

  private async saveVerified(credentials: KimiCodeCredentials): Promise<void> {
    await this.backend.save(credentials)
    const restored = await this.backend.load()
    if (!isDeepStrictEqual(restored, credentials)) {
      throw new Error('Kimi Code encrypted credential verification failed')
    }
    await this.removeLegacy()
  }

  read(): Promise<KimiCodeCredentials | null> {
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
        throw new Error('Kimi Code legacy credential read failed')
      }
      let credentials: KimiCodeCredentials
      try {
        credentials = parseKimiCodeCredentials(JSON.parse(legacy) as unknown)
      } catch {
        throw new Error('Kimi Code legacy credential payload is invalid')
      }
      await this.saveVerified(credentials)
      return credentials
    })
  }

  write(credentials: KimiCodeCredentials): Promise<void> {
    return this.serialize(() => this.saveVerified(parseKimiCodeCredentials(credentials)))
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

  async read(): Promise<KimiCodeModelSettings> {
    try {
      const content = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(content) as unknown
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>
        const enabledModelIds = Array.isArray(record.enabledModelIds)
          ? record.enabledModelIds.filter((id): id is string => typeof id === 'string')
          : [...DEFAULT_ENABLED_MODEL_IDS]
        const catalogModels = Array.isArray(record.catalogModels)
          ? (record.catalogModels as KimiCodeCatalogModel[])
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

  async write(settings: KimiCodeModelSettings): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp.${Date.now()}`
    await fs.writeFile(tmp, JSON.stringify(settings, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
  }

  async updateSettings(patch: {
    enabled?: boolean
    enabledModelIds?: string[]
    contextWindowOverrides?: Record<string, number>
    defaultReasoningEffort?: KimiCodeReasoningEffort | null
  }): Promise<KimiCodeModelSettings> {
    const current = await this.read()
    const next: KimiCodeModelSettings = {
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
    catalogModels: KimiCodeCatalogModel[],
    options?: { enabledModelIds?: string[] },
  ): Promise<KimiCodeModelSettings> {
    const current = await this.read()
    const next: KimiCodeModelSettings = {
      ...current,
      enabledModelIds: options?.enabledModelIds ?? current.enabledModelIds,
      catalogModels,
    }
    await this.write(next)
    return next
  }
}

/**
 * Resolve the region this installation belongs to.
 *
 * Read locally, never probed: an environment pin wins, then the marker file the
 * install channel may have written, then the default. A region only selects
 * hosts, so an unknown marker is ignored rather than fatal.
 */
export async function resolveRegion(env: NodeJS.ProcessEnv = process.env): Promise<KimiCodeRegion> {
  const pinned = (env.DSH_KIMI_CODE_OAUTH_HOST || env.KIMI_CODE_OAUTH_HOST || env.KIMI_CODE_BASE_URL || '').trim()
  if (pinned !== '') {
    for (const [region, hosts] of Object.entries(REGION_HOSTS) as Array<[KimiCodeRegion, { oauth: string; coding: string }]>) {
      if (pinned.startsWith(hosts.oauth) || pinned.startsWith(hosts.coding)) return region
    }
    // An unrecognized host is still served by the mainland endpoints unless it
    // is explicitly one of the global properties.
    return pinned.includes('.ai') ? 'global' : 'mainland-cn'
  }
  try {
    const marker = (await fs.readFile(regionMarkerPath(), 'utf8')).trim()
    if (isRegion(marker)) return marker
  } catch {
    // No marker: fall through to the default.
  }
  return 'mainland-cn'
}

/** Remember a region choice so a later status call reports the same one. */
export async function persistRegion(region: KimiCodeRegion): Promise<void> {
  try {
    const file = regionMarkerPath()
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, region, 'utf8')
  } catch {
    // A marker is an optimization; failing to write it must not fail a login.
  }
}

export { DEFAULT_OAUTH_HOST }
