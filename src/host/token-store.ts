import type { CredentialStorageDto } from '../shared/contracts.ts'

export interface StoredOAuthCredentials {
  accessToken: string
  refreshToken: string
  idToken?: string
  expiresAt: number
  accountId?: string
  email?: string
  planType?: string
}

export interface CredentialStore<T> {
  load(): Promise<T | null>
  save(value: T): Promise<void>
  clear(): Promise<void>
}

export interface TokenStore extends CredentialStore<StoredOAuthCredentials> {
  readonly storage: Omit<CredentialStorageDto, 'available'>
}

/** Test seam and non-persistent development store. Never used by apply(). */
export class MemoryTokenStore implements TokenStore {
  readonly storage = { kind: 'memory', encrypted: false } as const
  private value: StoredOAuthCredentials | null = null

  async load(): Promise<StoredOAuthCredentials | null> {
    return this.value === null ? null : structuredClone(this.value)
  }

  async save(value: StoredOAuthCredentials): Promise<void> {
    this.value = structuredClone(value)
  }

  async clear(): Promise<void> {
    this.value = null
  }
}

export function parseStoredCredentials(value: unknown): StoredOAuthCredentials {
  if (typeof value !== 'object' || value === null) throw new Error('credential bundle is not an object')
  const record = value as Record<string, unknown>
  if (typeof record.accessToken !== 'string' || record.accessToken === '') throw new Error('access token is missing')
  if (typeof record.refreshToken !== 'string' || record.refreshToken === '') throw new Error('refresh token is missing')
  if (typeof record.expiresAt !== 'number' || !Number.isFinite(record.expiresAt)) throw new Error('expiry is invalid')
  const optional = (key: string): string | undefined => {
    const candidate = record[key]
    if (candidate === undefined) return undefined
    if (typeof candidate !== 'string') throw new Error(`${key} is invalid`)
    return candidate
  }
  return {
    accessToken: record.accessToken,
    refreshToken: record.refreshToken,
    expiresAt: record.expiresAt,
    idToken: optional('idToken'),
    accountId: optional('accountId'),
    email: optional('email'),
    planType: optional('planType'),
  }
}
