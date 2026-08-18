import { createHash } from 'node:crypto'
import type { TokenStore } from './token-store.ts'

/**
 * Provider-neutral secret storage backed by the existing platform credential
 * store. One encrypted/private bundle contains namespaced provider payloads;
 * only opaque references are persisted in the public account-pool state.
 */
export interface ProviderSecretStore {
  read(ref: string): Promise<unknown | null>
  write(ref: string, value: unknown): Promise<string>
  delete(ref: string): Promise<void>
}

interface SecretBundle {
  schema: 1
  values: Record<string, unknown>
}

const BUNDLE_MARKER_ACCESS = 'provider-secret-bundle'
const BUNDLE_MARKER_REFRESH = 'provider-secret-bundle'

const PROVIDER_IDS = new Set(['claude', 'grok', 'cursor', 'antigravity'])
const REF_PATTERN = /^provider-secret:\/\/dsh-subscriptions\/([a-z][a-z0-9-]{0,31})\/([a-f0-9]{64})$/

export function createProviderCredentialRef(providerId: string, accountId: string): string {
  assertProviderId(providerId)
  if (accountId.length === 0) throw new Error('Provider account ID is required')
  const digest = createHash('sha256').update(`${providerId}:${accountId}`).digest('hex')
  return `provider-secret://dsh-subscriptions/${providerId}/${digest}`
}

function assertProviderId(providerId: string): void {
  if (!PROVIDER_IDS.has(providerId)) throw new Error(`Unsupported subscription provider: ${providerId}`)
}

function assertCredentialRef(ref: string): { providerId: string } {
  const match = REF_PATTERN.exec(ref)
  if (!match) throw new Error('Invalid provider credential reference')
  assertProviderId(match[1])
  return { providerId: match[1] }
}

function assertCredentialEnvelope(ref: string, value: unknown): void {
  const { providerId } = assertCredentialRef(ref)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Provider credential must be an object envelope')
  }
  const envelope = value as Record<string, unknown>
  if (envelope.providerId !== providerId) throw new Error('Provider credential reference/envelope mismatch')
  const type = envelope.type
  if (type !== 'oauth' && type !== 'official_session' && type !== 'official_cli_session') {
    throw new Error('Subscription provider credentials must use OAuth or an official-session envelope')
  }
  if (type === 'oauth' && (typeof envelope.access !== 'string' || envelope.access.length === 0)) {
    throw new Error('OAuth provider credential access token is required')
  }
}

export class PlatformProviderSecretStore implements ProviderSecretStore {
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly store: TokenStore) {}

  async read(ref: string): Promise<unknown | null> {
    assertCredentialRef(ref)
    const bundle = await this.loadBundle()
    return Object.hasOwn(bundle.values, ref) ? structuredClone(bundle.values[ref]) : null
  }

  async write(ref: string, value: unknown): Promise<string> {
    assertCredentialEnvelope(ref, value)
    await this.exclusive(async () => {
      const bundle = await this.loadBundle()
      bundle.values[ref] = structuredClone(value)
      await this.store.save({
        accessToken: BUNDLE_MARKER_ACCESS,
        refreshToken: BUNDLE_MARKER_REFRESH,
        expiresAt: Number.MAX_SAFE_INTEGER,
        providerSecrets: bundle.values,
      })
    })
    return ref
  }

  async delete(ref: string): Promise<void> {
    assertCredentialRef(ref)
    await this.exclusive(async () => {
      const bundle = await this.loadBundle()
      if (!Object.hasOwn(bundle.values, ref)) return
      delete bundle.values[ref]
      if (Object.keys(bundle.values).length === 0) {
        await this.store.clear()
        return
      }
      await this.store.save({
        accessToken: BUNDLE_MARKER_ACCESS,
        refreshToken: BUNDLE_MARKER_REFRESH,
        expiresAt: Number.MAX_SAFE_INTEGER,
        providerSecrets: bundle.values,
      })
    })
  }

  private async loadBundle(): Promise<SecretBundle> {
    const stored = await this.store.load()
    const values = stored?.providerSecrets
    return {
      schema: 1,
      values: values && typeof values === 'object' && !Array.isArray(values)
        ? structuredClone(values)
        : {},
    }
  }

  private async exclusive(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation, operation)
    this.queue = next.catch(() => undefined)
    return next
  }
}
