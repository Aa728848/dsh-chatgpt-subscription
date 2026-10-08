import type { CredentialStorageDto } from '../shared/contracts.ts'

/**
 * The adoption markers, as they hang off a credential this package stores.
 *
 * FLATTENED onto the credential rather than nested under it, for the same reason
 * the Claude line flattens its own: the pool's hooks (needsRefresh, refresh,
 * authRejectedReason) receive the CREDENTIAL and never the account record, so the
 * marker has to be reachable from there, and every other field a pooled row reads
 * already sits at the top level.
 *
 * A borrowed snapshot is never refreshed (the refresh token belongs to the client
 * that wrote the file, and two programs spending it invalidate each other), so the
 * marker is the whole difference between a row this plugin may rotate and a row
 * that is a snapshot until it expires. It is written on EVERY account the pool
 * creates, including the explicit false case, because the core merges a
 * re-authorization as { ...existing, ...created } and an omitted key would leave a
 * stored 'adopted: true' behind.
 */
export interface AdoptedCredentialMarkers {
  /** Literal true on a credential copied out of another application's sign-in. */
  adopted?: true
  /** Which local sign-in it was taken from, e.g. 'codex'. */
  source?: string
  /** The exact file it was read from, so a card can name it. */
  sourcePath?: string
}

export interface StoredOAuthCredentials extends AdoptedCredentialMarkers {
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
  const credentials: StoredOAuthCredentials = {
    accessToken: record.accessToken,
    refreshToken: record.refreshToken,
    expiresAt: record.expiresAt,
    idToken: optional('idToken'),
    accountId: optional('accountId'),
    email: optional('email'),
    planType: optional('planType'),
  }
  // The adoption markers come back with the record, or the marker would be
  // dropped on the first pool write: a row that was never refreshed would come
  // back looking plugin-owned, and would then be handed to a token endpoint that
  // rotates a grant this plugin does not own. 'adopted' is the discriminant, so a
  // partial or stale marker keeps the row managed rather than freezing it.
  if (record.adopted === true) {
    const source = optional('source')
    if (source !== undefined) {
      credentials.adopted = true
      credentials.source = source
      const sourcePath = optional('sourcePath')
      if (sourcePath !== undefined) credentials.sourcePath = sourcePath
    }
  }
  return credentials
}
