import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { CredentialStore } from '../token-store.ts'
import { WindowsDpapiCredentialStore } from '../token-store-windows.ts'
import { MacKeychainCredentialStore } from '../token-store-macos.ts'
import { SecretServiceCredentialStore } from '../credential-store-secret-service.ts'
import {
  FileCredentialStore,
  credentialPath as singleCredentialPath,
  dshHomeDir,
  parseAntigravityCredentials,
  type AntigravityCredentials,
} from './token-store.ts'
import { refreshAntigravityToken } from './oauth.ts'
import type {
  AccountRotationStrategy,
  AntigravityAccountSummaryDto,
} from '../../shared/antigravity-contracts.ts'

export interface AntigravityPoolAccount {
  id: string
  alias: string
  email?: string
  projectId?: string
  planLabel?: string
  credentials: AntigravityCredentials
  addedAt: number
  lastUsedAt?: number
  cooldownUntil?: number
  cooldownReason?: string
  isPrimary?: boolean
}

export interface AntigravityPoolData {
  version: 1
  activeAccountId?: string
  rotationStrategy: AccountRotationStrategy
  accounts: AntigravityPoolAccount[]
}

export function poolPath(): string {
  return path.join(dshHomeDir(), 'storages', 'antigravity-pool.json')
}

export function parseAntigravityPoolData(value: unknown): AntigravityPoolData {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Antigravity pool payload is invalid')
  }
  const record = value as Record<string, unknown>
  const strategy: AccountRotationStrategy =
    record.rotationStrategy === 'round-robin' ? 'round-robin' : 'sequential'
  const activeAccountId = typeof record.activeAccountId === 'string' ? record.activeAccountId : undefined
  const rawAccounts = Array.isArray(record.accounts) ? record.accounts : []
  const accounts: AntigravityPoolAccount[] = []

  for (const item of rawAccounts) {
    if (typeof item !== 'object' || item === null) continue
    const r = item as Record<string, unknown>
    if (typeof r.id !== 'string') continue
    const credentials = parseAntigravityCredentials(r.credentials)
    const acc: AntigravityPoolAccount = {
      id: r.id,
      alias: typeof r.alias === 'string' ? r.alias : (credentials.email || '账号'),
      credentials,
      addedAt: typeof r.addedAt === 'number' ? r.addedAt : Date.now(),
      isPrimary: r.isPrimary === true,
    }
    if (typeof r.email === 'string') acc.email = r.email
    else if (credentials.email) acc.email = credentials.email
    if (typeof r.projectId === 'string') acc.projectId = r.projectId
    else if (credentials.projectId) acc.projectId = credentials.projectId
    if (typeof r.planLabel === 'string') acc.planLabel = r.planLabel
    if (typeof r.lastUsedAt === 'number') acc.lastUsedAt = r.lastUsedAt
    if (typeof r.cooldownUntil === 'number') acc.cooldownUntil = r.cooldownUntil
    if (typeof r.cooldownReason === 'string') acc.cooldownReason = r.cooldownReason
    accounts.push(acc)
  }

  const res: AntigravityPoolData = {
    version: 1,
    rotationStrategy: strategy,
    accounts,
  }
  if (activeAccountId) res.activeAccountId = activeAccountId
  return res
}

function poolCredentialAccount(filePath: string): string {
  return createHash('sha256').update(path.resolve(filePath)).digest('hex')
}

function createPoolCredentialBackend(filePath: string): CredentialStore<AntigravityPoolData> {
  if (process.platform === 'win32') {
    return new WindowsDpapiCredentialStore(`${filePath}.dpapi`, parseAntigravityPoolData)
  }
  if (process.platform === 'darwin') {
    return new MacKeychainCredentialStore('dsh-antigravity-pool', poolCredentialAccount(filePath), parseAntigravityPoolData)
  }
  if (process.platform === 'linux') {
    return new SecretServiceCredentialStore('dsh-antigravity-pool', poolCredentialAccount(filePath), parseAntigravityPoolData)
  }
  throw new Error('Antigravity pool encrypted storage requires Windows, macOS, or Linux.')
}

const poolOperations = new Map<string, Promise<void>>()

export class AccountPoolStore {
  constructor(
    private readonly filePath = poolPath(),
    private readonly backend: CredentialStore<AntigravityPoolData> = createPoolCredentialBackend(filePath),
    private readonly legacyStore = new FileCredentialStore(),
  ) {}

  path(): string {
    if (process.platform === 'win32') return `${this.filePath}.dpapi`
    const kind = process.platform === 'darwin' ? 'Keychain' : 'Secret Service'
    return `${kind}: dsh-antigravity-pool/${poolCredentialAccount(this.filePath)}`
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(this.filePath)
    const result = (poolOperations.get(key) || Promise.resolve()).then(operation)
    const settled = result.then(() => undefined, () => undefined)
    poolOperations.set(key, settled)
    void settled.then(() => {
      if (poolOperations.get(key) === settled) poolOperations.delete(key)
    })
    return result
  }

  private async saveVerified(data: AntigravityPoolData): Promise<void> {
    const normalized = parseAntigravityPoolData(data)
    await this.backend.save(normalized)
    const restored = await this.backend.load()
    if (!isDeepStrictEqual(restored, normalized)) {
      throw new Error('Antigravity pool encrypted verification failed')
    }
  }

  read(): Promise<AntigravityPoolData> {
    return this.serialize(async () => {
      let current: AntigravityPoolData | null = null
      try {
        current = await this.backend.load()
      } catch {
        // Corrupt file recovery
      }

      if (current !== null && Array.isArray(current.accounts) && current.accounts.length > 0) {
        return current
      }

      // Surface the pre-existing single credential as the primary account. This
      // read stays side-effect free on purpose: every caller that changes the
      // pool writes it back immediately afterwards, so persisting the migration
      // here only bought one extra encrypted round trip and made a getter write
      // to disk.
      try {
        const legacy = await this.legacyStore.read()
        if (legacy && (legacy.access || legacy.access_token || legacy.refresh || legacy.refresh_token)) {
          const defaultAccount: AntigravityPoolAccount = {
            id: 'acc_primary',
            alias: legacy.email || '主账号',
            email: legacy.email,
            projectId: legacy.projectId,
            credentials: legacy,
            addedAt: Date.now(),
            isPrimary: true,
          }
          return {
            version: 1,
            activeAccountId: 'acc_primary',
            rotationStrategy: current?.rotationStrategy || 'sequential',
            accounts: [defaultAccount],
          }
        }
      } catch {
        // ignore migration failures
      }

      return current || {
        version: 1,
        rotationStrategy: 'sequential',
        accounts: [],
      }
    })
  }

  write(data: AntigravityPoolData): Promise<void> {
    return this.serialize(() => this.saveVerified(parseAntigravityPoolData(data)))
  }

  async listAccounts(): Promise<AntigravityAccountSummaryDto[]> {
    const data = await this.read()
    const now = Date.now()
    return data.accounts.map((acc) => {
      const expires = acc.credentials.expires || acc.credentials.expires_at
      return {
        id: acc.id,
        alias: acc.alias,
        email: acc.email,
        projectId: acc.projectId,
        planLabel: acc.planLabel,
        isPrimary: acc.isPrimary === true,
        lastUsedAt: acc.lastUsedAt,
        cooldownUntil: acc.cooldownUntil && acc.cooldownUntil > now ? acc.cooldownUntil : undefined,
        cooldownReason: acc.cooldownUntil && acc.cooldownUntil > now ? acc.cooldownReason : undefined,
        expiresAt: expires,
      }
    })
  }

  async addAccount(credentials: AntigravityCredentials, alias?: string): Promise<AntigravityPoolAccount> {
    const data = await this.read()
    const email = credentials.email
    const existingIndex = email ? data.accounts.findIndex((a) => a.email === email) : -1
    const id = existingIndex >= 0 ? data.accounts[existingIndex]!.id : `acc_${randomBytes(6).toString('hex')}`
    const isPrimary = data.accounts.length === 0 || (existingIndex >= 0 && data.accounts[existingIndex]!.isPrimary)

    const account: AntigravityPoolAccount = {
      id,
      alias: alias?.trim() || email || `账号 ${data.accounts.length + 1}`,
      email,
      projectId: credentials.projectId,
      credentials,
      addedAt: Date.now(),
      isPrimary: !!isPrimary,
    }

    if (existingIndex >= 0) {
      data.accounts[existingIndex] = {
        ...data.accounts[existingIndex]!,
        ...account,
        isPrimary: data.accounts[existingIndex]!.isPrimary,
      }
    } else {
      data.accounts.push(account)
    }

    if (!data.activeAccountId || account.isPrimary) {
      data.activeAccountId = account.id
    }

    await this.write(data)
    // Also keep legacy store synced for backward compatibility
    if (account.isPrimary) {
      void this.legacyStore.write(credentials).catch(() => undefined)
    }
    return account
  }

  async setPrimary(accountId: string): Promise<void> {
    const data = await this.read()
    for (const a of data.accounts) {
      a.isPrimary = a.id === accountId
    }
    const primary = data.accounts.find((a) => a.isPrimary)
    if (primary) {
      data.activeAccountId = primary.id
      void this.legacyStore.write(primary.credentials).catch(() => undefined)
    }
    await this.write(data)
  }

  async setAlias(accountId: string, alias: string): Promise<void> {
    const data = await this.read()
    const target = data.accounts.find((a) => a.id === accountId)
    if (target && alias.trim()) {
      target.alias = alias.trim()
      await this.write(data)
    }
  }

  async deleteAccount(accountId: string): Promise<void> {
    const data = await this.read()
    const wasPrimary = data.accounts.find((a) => a.id === accountId)?.isPrimary
    data.accounts = data.accounts.filter((a) => a.id !== accountId)
    if (wasPrimary && data.accounts.length > 0) {
      data.accounts[0]!.isPrimary = true
      void this.legacyStore.write(data.accounts[0]!.credentials).catch(() => undefined)
    } else if (data.accounts.length === 0) {
      void this.legacyStore.delete().catch(() => undefined)
    }
    if (data.activeAccountId === accountId) {
      data.activeAccountId = data.accounts.find((a) => a.isPrimary)?.id ?? data.accounts[0]?.id
    }
    await this.write(data)
  }

  async setStrategy(strategy: AccountRotationStrategy): Promise<void> {
    const data = await this.read()
    data.rotationStrategy = strategy
    await this.write(data)
  }

  async markCooldown(accountId: string, durationMs: number, reason: string): Promise<void> {
    const data = await this.read()
    const target = data.accounts.find((a) => a.id === accountId)
    if (target) {
      target.cooldownUntil = Date.now() + Math.max(10_000, durationMs)
      target.cooldownReason = reason
      await this.write(data)
    }
  }

  async clearCooldown(accountId: string): Promise<void> {
    const data = await this.read()
    const target = data.accounts.find((a) => a.id === accountId)
    if (target) {
      target.cooldownUntil = undefined
      target.cooldownReason = undefined
      await this.write(data)
    }
  }

  async hasAnotherAvailableAccount(triedAccountIds: ReadonlySet<string>): Promise<boolean> {
    const data = await this.read()
    const now = Date.now()
    return data.accounts.some(
      (a) => !triedAccountIds.has(a.id) && (!a.cooldownUntil || a.cooldownUntil <= now),
    )
  }

  async getEffectiveAccount(
    excludeIds?: ReadonlySet<string>,
    fetchFn: typeof fetch = fetch,
  ): Promise<{ account: AntigravityPoolAccount; token: string; projectId?: string }> {
    const data = await this.read()
    if (data.accounts.length === 0) {
      throw new Error('未登录 Antigravity 账号，请在「设置 → Antigravity」中添加并登录账号。')
    }

    const now = Date.now()
    const eligible = data.accounts.filter(
      (a) => (!excludeIds || !excludeIds.has(a.id)) && (!a.cooldownUntil || a.cooldownUntil <= now),
    )

    if (eligible.length === 0) {
      let shortest = Infinity
      for (const a of data.accounts) {
        if (a.cooldownUntil && a.cooldownUntil > now) {
          shortest = Math.min(shortest, a.cooldownUntil - now)
        }
      }
      const waitMins = Number.isFinite(shortest) ? Math.ceil(shortest / 60000) : 15
      throw new LlmError(
        `全部 ${data.accounts.length} 个 Antigravity 账号均处于配额限制或冷却中 (429)。最短预计在 ${waitMins} 分钟后解除冷却。`,
        'RATE_LIMIT',
        { status: 429 },
      )
    }

    let selected: AntigravityPoolAccount
    if (data.rotationStrategy === 'round-robin') {
      // Sort by least recently used
      selected = [...eligible].sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0))[0]!
    } else {
      // Sequential: prefer primary account first, then first available
      selected = eligible.find((a) => a.isPrimary) || eligible[0]!
    }

    // Refresh token if needed
    const creds = selected.credentials
    const expires = creds.expires || creds.expires_at || 0
    let token = creds.access || creds.access_token

    if (!token || expires <= now + 60_000) {
      const refreshed = await refreshAntigravityToken(creds, fetchFn)
      selected.credentials = refreshed
      selected.projectId = refreshed.projectId || selected.projectId
      // Write back refreshed credentials
      const idx = data.accounts.findIndex((a) => a.id === selected.id)
      if (idx >= 0) data.accounts[idx] = selected
      if (selected.isPrimary) {
        void this.legacyStore.write(refreshed).catch(() => undefined)
      }
    }

    selected.lastUsedAt = now
    data.activeAccountId = selected.id
    await this.write(data)

    return {
      account: selected,
      token: (selected.credentials.access || selected.credentials.access_token)!,
      projectId: selected.projectId || selected.credentials.projectId,
    }
  }
}
