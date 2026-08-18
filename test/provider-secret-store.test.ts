import { describe, expect, it } from 'vitest'
import { PlatformProviderSecretStore, createProviderCredentialRef } from '../src/host/provider-secret-store.ts'
import { MemoryTokenStore } from '../src/host/token-store.ts'

describe('PlatformProviderSecretStore', () => {
  it('stores provider payloads behind opaque provider-scoped references', async () => {
    const tokenStore = new MemoryTokenStore()
    const store = new PlatformProviderSecretStore(tokenStore)
    const ref = createProviderCredentialRef('claude', 'account@example.com')
    const value = { type: 'oauth', providerId: 'claude', access: 'secret-access', refresh: 'secret-refresh' }

    expect(ref).toMatch(new RegExp('^provider-secret://dsh-subscriptions/claude/[a-f0-9]{64}$'))
    expect(ref).not.toContain('account@example.com')
    await store.write(ref, value)
    expect(await store.read(ref)).toEqual(value)

    const bundle = await tokenStore.load()
    expect(bundle?.accessToken).toBe('provider-secret-bundle')
    expect(bundle?.providerSecrets?.[ref]).toEqual(value)

    await store.delete(ref)
    expect(await store.read(ref)).toBeNull()
  })

  it('keeps valid provider namespaces isolated in one protected bundle', async () => {
    const tokenStore = new MemoryTokenStore()
    const store = new PlatformProviderSecretStore(tokenStore)
    const claude = createProviderCredentialRef('claude', 'a')
    const grok = createProviderCredentialRef('grok', 'b')
    await store.write(claude, { type: 'oauth', providerId: 'claude', access: 'claude' })
    await store.write(grok, { type: 'oauth', providerId: 'grok', access: 'grok' })
    await store.delete(claude)
    expect(await store.read(claude)).toBeNull()
    expect(await store.read(grok)).toEqual({ type: 'oauth', providerId: 'grok', access: 'grok' })
  })

  it('rejects malformed refs, provider mismatches, and API-key envelopes', async () => {
    const store = new PlatformProviderSecretStore(new MemoryTokenStore())
    const ref = createProviderCredentialRef('cursor', 'account')
    await expect(store.write(ref, { type: 'oauth', providerId: 'grok', access: 'secret' })).rejects.toThrow(/mismatch/)
    await expect(store.write(ref, { type: 'api_key', providerId: 'cursor', access: 'secret' })).rejects.toThrow(/OAuth/)
    await expect(store.read('provider-secret://dsh-subscriptions/../../secret')).rejects.toThrow(/Invalid/)
    expect(() => createProviderCredentialRef('unknown', 'account')).toThrow(/Unsupported/)
  })
})

describe('provider token parsing', () => {
  it('accepts namespaced provider secrets without weakening required bundle fields', async () => {
    const tokenStore = new MemoryTokenStore()
    const ref = createProviderCredentialRef('cursor', 'account')
    const value = { type: 'oauth', providerId: 'cursor', access: 'cursor-token' }
    await tokenStore.save({
      accessToken: 'provider-secret-bundle',
      refreshToken: 'provider-secret-bundle',
      expiresAt: Number.MAX_SAFE_INTEGER,
      providerSecrets: { [ref]: value },
    })
    const store = new PlatformProviderSecretStore(tokenStore)
    expect(await store.read(ref)).toEqual(value)
  })
})
