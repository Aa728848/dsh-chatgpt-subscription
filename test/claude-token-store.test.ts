/**
 * Tests for the Claude subscription credential and model-settings store.
 *
 * WHAT THIS FILE PROVES.
 *
 * 1. Identity: one account saving a SECOND, rotated refresh token updates the
 *    record it already has instead of adding a second one — the ghost-account
 *    failure the two-layer design exists to remove — and the alias set is only
 *    ever grown.
 * 2. The one case that does NOT merge. A credential stating neither a uuid nor
 *    an address is recognised by `seed:<sha256(refresh token)>`, which a re-login
 *    changes, so it IS stored as a second record. The test asserts that
 *    honestly rather than pretending otherwise: this is the documented limitation
 *    the settings card has to resolve with a manual merge.
 * 3. Storage: the encrypted backend is the only place a token ends up, the
 *    plaintext file is a migration source that survives a failed verification,
 *    and writes are serialised per path.
 * 4. Settings persist, `null` drops a context-window override, and the register
 *    seam is used when the harness offers one.
 * 5. A settings document written by an EARLIER build — one still carrying a key
 *    this build no longer knows, as every user who acknowledged an older
 *    release's notice has on disk — is read successfully, with every field it
 *    does have preserved. Both settings readers are asserted, because a
 *    persisted document reaches the store through whichever one the harness
 *    gives it.
 *
 * WHAT THIS FILE DOES NOT DO: it never claims a platform's cryptography works.
 * Everything above runs against an in-memory backend, so nothing here is
 * evidence about DPAPI, the Keychain or the Secret Service. The only assertions
 * that touch a real backend are the ones that also run against the platform's
 * own store; they are marked as such below.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_PREFERENCES_NAMESPACE,
  CREDENTIAL_DOCUMENT_VERSION,
  FileCredentialStore,
  FileModelSettingsStore,
  createInternalId,
  credentialPath,
  defaultClaudeSettings,
  identityKeysFor,
  isClaudeAccountId,
  isSubscriptionCredential,
  mergeIdentityKeys,
  modelSettingsPath,
  parseClaudeCredentialDocument,
  parseClaudeCredentials,
  parseClaudeModelSettings,
  registerClaudePreferenceStore,
  type ClaudeAccountRecord,
  type ClaudeCredentialDocument,
  type ClaudeCredentials,
} from '../src/host/claude/token-store.ts'
import { DEFAULT_VISIBLE_MODEL_IDS } from '../src/host/claude/model-catalog.ts'
import type { CredentialStore } from '../src/host/token-store.ts'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function legacyPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-claude-store-'))
  directories.push(directory)
  return join(directory, 'claude-credentials.json')
}

async function settingsFilePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-claude-settings-'))
  directories.push(directory)
  return join(directory, 'claude-models.json')
}

/** A valid credential with every optional field overridable. */
function credential(overrides: Partial<ClaudeCredentials> = {}): ClaudeCredentials {
  return {
    accessToken: 'access-token-secret',
    refreshToken: 'refresh-token-secret',
    expiresAt: 2_000_000_000_000,
    scopes: ['user:profile', 'user:inference'],
    ...overrides,
  }
}

/** A credential stating a uuid, i.e. one that CAN be recognised after a re-login. */
function identifiedCredential(refreshToken: string, overrides: Partial<ClaudeCredentials> = {}): ClaudeCredentials {
  return credential({
    refreshToken,
    account: { uuid: '0f8fad5b-d9cb-469f-a165-70867728950e' },
    ...overrides,
  })
}

/** A credential stating NOTHING about its account: the seed-only case. */
function seedOnlyCredential(refreshToken: string): ClaudeCredentials {
  return credential({ refreshToken })
}

function seedOf(refreshToken: string): string {
  return createHash('sha256').update(refreshToken.trim()).digest('hex').slice(0, 16)
}

function memoryBackend(initial: ClaudeCredentialDocument | null = null): CredentialStore<ClaudeCredentialDocument> {
  let value = initial
  return {
    load: vi.fn(async () => structuredClone(value)),
    save: vi.fn(async (next: ClaudeCredentialDocument) => { value = structuredClone(next) }),
    clear: vi.fn(async () => { value = null }),
  }
}

/** The storages directory the process is pointed at, so the file names can be asserted literally. */
function expectedStoragesPath(file: string): string {
  const home = (process.env.DSH_HOME ?? '').trim()
  if (home === '') throw new Error('the shared test setup must pin DSH_HOME')
  return join(home, 'storages', file)
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe('claude credential parsing', () => {
  it('refuses a credential that lacks user:inference instead of accepting it silently', () => {
    // The refusal is the point: such a token authenticates but is not entitled to
    // the routes this provider exists to serve.
    expect(() => parseClaudeCredentials(credential({ scopes: ['user:profile'] })))
      .toThrow(/user:inference/)
    expect(isSubscriptionCredential({ scopes: ['user:profile'] })).toBe(false)
    expect(isSubscriptionCredential({ scopes: ['user:profile', 'user:inference'] })).toBe(true)
    expect(isSubscriptionCredential({})).toBe(false)
  })

  it('refuses a credential that states no scopes at all, and says why', () => {
    expect(() => parseClaudeCredentials({
      accessToken: 'a', refreshToken: 'r', expiresAt: 1,
    })).toThrow(/scopes/)
  })

  it('accepts the RFC 6749 space-delimited scope string as well as the array', () => {
    const parsed = parseClaudeCredentials(credential({ scopes: 'oauth user:profile user:inference' as unknown as string[] }))
    expect(parsed.scopes).toEqual(['oauth', 'user:profile', 'user:inference'])
  })

  it('rejects every wrong shape rather than guessing one', () => {
    expect(() => parseClaudeCredentials(null)).toThrow(/payload is invalid/)
    expect(() => parseClaudeCredentials([])).toThrow(/payload is invalid/)
    expect(() => parseClaudeCredentials('token')).toThrow(/payload is invalid/)
    expect(() => parseClaudeCredentials({ refreshToken: 'r', expiresAt: 1, scopes: ['user:inference'] }))
      .toThrow(/access token/)
    expect(() => parseClaudeCredentials({ accessToken: 'a', expiresAt: 1, scopes: ['user:inference'] }))
      .toThrow(/refresh token/)
    expect(() => parseClaudeCredentials({ accessToken: 'a', refreshToken: 'r', scopes: ['user:inference'] }))
      .toThrow(/expiry is invalid/)
    expect(() => parseClaudeCredentials(credential({ expiresAt: Number.NaN }))).toThrow(/expiry is invalid/)
    expect(() => parseClaudeCredentials({ ...credential(), scopes: 7 })).toThrow(/scopes are invalid/)
    expect(() => parseClaudeCredentials({ ...credential(), scopes: [7] })).toThrow(/scopes are invalid/)
  })

  it('rebuilds the value it returns, so a caller key never reaches the stored document', () => {
    // An undefined-valued key would vanish across JSON and make the encrypted
    // write fail its own read-back comparison; rebuilding is what prevents that.
    const parsed = parseClaudeCredentials({ ...credential(), junk: undefined, another: 'dropped' })
    expect(Object.keys(parsed).sort()).toEqual(['accessToken', 'expiresAt', 'refreshToken', 'scopes'])
    expect('junk' in parsed).toBe(false)
  })

  it('trims tokens and keeps the reported account facts', () => {
    const parsed = parseClaudeCredentials({
      accessToken: '  a  ',
      refreshToken: '\tr\n',
      expiresAt: 5,
      scopes: ['user:inference', ' '],
      subscriptionType: 'max',
      account: { uuid: 'u-1', email_address: 'User@Example.com' },
    })
    expect(parsed).toEqual({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: 5,
      scopes: ['user:inference'],
      subscriptionType: 'max',
      account: { uuid: 'u-1', email_address: 'User@Example.com' },
    })
  })
})

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe('claude account identity', () => {
  it('mints an internal id of the documented shape, different on every call', () => {
    const first = createInternalId()
    expect(first).toMatch(/^cl_[0-9a-f]{20}$/)
    expect(isClaudeAccountId(first)).toBe(true)
    expect(isClaudeAccountId('account-1')).toBe(false)
    expect(createInternalId()).not.toBe(first)
  })

  it('derives uuid and email aliases, lower-cased', () => {
    expect(identityKeysFor({
      refreshToken: 'r',
      account: { uuid: 'ABC-DEF', email_address: 'User@Example.com' },
    })).toEqual(['uuid:abc-def', 'email:user@example.com'])
  })

  it('reads the emailAddress spelling too, so a missed field cannot create a ghost account', () => {
    expect(identityKeysFor({ refreshToken: 'r', account: { emailAddress: 'User@Example.com' } }))
      .toEqual(['email:user@example.com'])
    // An empty wire value must fall through to the alias spelling, not swallow it.
    expect(identityKeysFor({ refreshToken: 'r', account: { email_address: '', emailAddress: 'x@y.z' } }))
      .toEqual(['email:x@y.z'])
  })

  it('falls back to a token seed ONLY when nothing else names the account', () => {
    expect(identityKeysFor({ refreshToken: 'refresh-token-secret' }))
      .toEqual(['seed:' + seedOf('refresh-token-secret')])
    // With a uuid present the seed is not emitted: it would change on every
    // refresh and add noise to a set that already has real identity.
    expect(identityKeysFor({ refreshToken: 'r', account: { uuid: 'u' } })).toEqual(['uuid:u'])
    // The seed is a digest of the TRIMMED token, so a pasted newline is not a
    // second credential.
    expect(identityKeysFor({ refreshToken: '  same  ' })).toEqual(identityKeysFor({ refreshToken: 'same' }))
  })

  it('merges alias sets by union, keeping the existing order and dropping duplicates', () => {
    expect(mergeIdentityKeys(['uuid:u', 'email:a@b'], ['email:a@b', 'seed:x']))
      .toEqual(['uuid:u', 'email:a@b', 'seed:x'])
    expect(mergeIdentityKeys([], ['uuid:u'])).toEqual(['uuid:u'])
    // Nothing is ever removed, which is what makes the set append-only.
    expect(mergeIdentityKeys(['seed:old'], ['seed:new'])).toEqual(['seed:old', 'seed:new'])
  })
})

// ---------------------------------------------------------------------------
// The credential document: identity resolution end to end
// ---------------------------------------------------------------------------

describe('claude credential document / identity resolution', () => {
  it('MERGES one account across two DIFFERENT refresh tokens that share a uuid', async () => {
    const path = await legacyPath()
    const backend = memoryBackend()
    const store = new FileCredentialStore(path, backend)

    const first = await store.saveAccount(identifiedCredential('refresh-token-one'))
    const second = await store.saveAccount(identifiedCredential('refresh-token-two'))

    // One record, same immutable id, and the newer token is the one stored.
    expect(second.internalId).toBe(first.internalId)
    expect(second.credentials.refreshToken).toBe('refresh-token-two')
    expect(await store.listAccounts()).toHaveLength(1)
    expect((await store.listAccounts())[0]?.internalId).toBe(first.internalId)
  })

  it('MERGES a re-login that states only the address, matching case-insensitively and keeping the uuid alias', async () => {
    const path = await legacyPath()
    const store = new FileCredentialStore(path, memoryBackend())

    const first = await store.saveAccount(credential({
      refreshToken: 'token-one',
      account: { uuid: 'ABC', email_address: 'User@Example.com' },
    }))
    const second = await store.saveAccount(credential({
      refreshToken: 'token-two',
      account: { email_address: 'USER@example.com' },
    }))

    expect(second.internalId).toBe(first.internalId)
    // Append-only in both directions: the uuid alias the older token stated is
    // still there, and the address the newer one stated joined it once.
    expect(second.identityKeys).toEqual(['uuid:abc', 'email:user@example.com'])
    expect(await store.listAccounts()).toHaveLength(1)
  })

  it('DOES NOT merge a seed-only re-login, and this is the documented limitation', async () => {
    const path = await legacyPath()
    const store = new FileCredentialStore(path, memoryBackend())

    const first = await store.saveAccount(seedOnlyCredential('token-one'))
    const second = await store.saveAccount(seedOnlyCredential('token-two'))

    // Honest assertion: the same account signing in again is NOT recognised,
    // because the only alias available is a digest of the token that changed.
    expect(second.internalId).not.toBe(first.internalId)
    expect(await store.listAccounts()).toHaveLength(2)
    expect(first.identityKeys).toEqual(['seed:' + seedOf('token-one')])
    expect(second.identityKeys).toEqual(['seed:' + seedOf('token-two')])
  })

  it('folds a seed-only re-login onto the record the card names, without dropping the old seed', async () => {
    const path = await legacyPath()
    const store = new FileCredentialStore(path, memoryBackend())

    const first = await store.saveAccount(seedOnlyCredential('token-one'))
    const merged = await store.saveAccount(seedOnlyCredential('token-two'), { internalId: first.internalId })

    // This is the manual merge the card offers; the store only executes it.
    expect(merged.internalId).toBe(first.internalId)
    expect(merged.identityKeys).toEqual(['seed:' + seedOf('token-one'), 'seed:' + seedOf('token-two')])
    expect(await store.listAccounts()).toHaveLength(1)
  })

  it('re-saves the same account under one id, minting it only once', async () => {
    const path = await legacyPath()
    const store = new FileCredentialStore(path, memoryBackend())

    const first = await store.saveAccount(seedOnlyCredential('same-token'))
    const second = await store.saveAccount(seedOnlyCredential('same-token'))

    expect(second.internalId).toBe(first.internalId)
    expect(await store.listAccounts()).toHaveLength(1)
  })

  it('opens a record under an explicit id that does not exist yet', async () => {
    const path = await legacyPath()
    const store = new FileCredentialStore(path, memoryBackend())
    const id = createInternalId()

    const saved = await store.saveAccount(seedOnlyCredential('token'), { internalId: id })
    expect(saved.internalId).toBe(id)
    expect((await store.listAccounts())[0]?.internalId).toBe(id)
  })

  it('refuses a blank explicit id instead of minting one behind the caller', async () => {
    const path = await legacyPath()
    const store = new FileCredentialStore(path, memoryBackend())
    await expect(store.saveAccount(seedOnlyCredential('token'), { internalId: '   ' }))
      .rejects.toThrow(/account id is invalid/)
  })

  it('folds a uuid-only sign-in and an address-only sign-in into one record once a save states both', async () => {
    const path = await legacyPath()
    const store = new FileCredentialStore(path, memoryBackend())

    // Neither save shares an alias with the other: one names the account by
    // uuid, the other by address. Two records, and this is stated rather than
    // hidden — see the module comment.
    const byUuid = await store.saveAccount(credential({
      refreshToken: 'token-one',
      account: { uuid: 'ABC' },
    }))
    const byEmail = await store.saveAccount(credential({
      refreshToken: 'token-two',
      account: { email_address: 'User@Example.com' },
    }))
    expect(byEmail.internalId).not.toBe(byUuid.internalId)

    // A save that states BOTH matches the uuid record and carries the address
    // onto it. From here the two are one account however they are named again.
    const both = await store.saveAccount(credential({
      refreshToken: 'token-three',
      account: { uuid: 'ABC', email_address: 'user@example.com' },
    }))
    expect(both.internalId).toBe(byUuid.internalId)
    expect(both.identityKeys).toEqual(['uuid:abc', 'email:user@example.com'])

    const byEmailAgain = await store.saveAccount(credential({
      refreshToken: 'token-four',
      account: { emailAddress: 'USER@example.com' },
    }))
    expect(byEmailAgain.internalId).toBe(byUuid.internalId)
    expect(await store.listAccounts()).toHaveLength(2)
  })

  it('carries through fields it does not itself understand', async () => {
    const path = await legacyPath()
    const backend = memoryBackend({
      version: CREDENTIAL_DOCUMENT_VERSION,
      accounts: [{
        internalId: 'cl_0123456789abcdef0123',
        identityKeys: ['uuid:0f8fad5b-d9cb-469f-a165-70867728950e'],
        credentials: identifiedCredential('token-one'),
        alias: 'work',
      }],
    })
    const store = new FileCredentialStore(path, backend)

    const saved = await store.saveAccount(identifiedCredential('token-two'))
    expect(saved.internalId).toBe('cl_0123456789abcdef0123')
    expect(saved.alias).toBe('work')
  })

  it('drops one unreadable record instead of taking the whole line offline', async () => {
    const path = await legacyPath()
    // Deliberately mistyped: the fixture is a document as it would come off a
    // damaged disk, not one this module would ever have written.
    const backend = memoryBackend({
      version: CREDENTIAL_DOCUMENT_VERSION,
      accounts: [
        { internalId: 'cl_0123456789abcdef0123', identityKeys: ['uuid:u'], credentials: identifiedCredential('t') },
        // Not a subscription credential: refused at parse time.
        { internalId: 'cl_aaaaaaaaaaaaaaaaaaaa', identityKeys: [], credentials: credential({ scopes: ['user:profile'] }) },
        { internalId: 'cl_bbbbbbbbbbbbbbbbbbbb', identityKeys: [], credentials: { nope: true } as unknown as ClaudeCredentials },
        'not an object at all',
        null,
      ],
    } as unknown as ClaudeCredentialDocument)
    const store = new FileCredentialStore(path, backend)

    const accounts = await store.listAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.internalId).toBe('cl_0123456789abcdef0123')
    expect(accounts[0]?.identityKeys).toEqual(['uuid:u'])
  })

  it('keeps the first of two records that share an internal id', async () => {
    const path = await legacyPath()
    const backend = memoryBackend({
      version: CREDENTIAL_DOCUMENT_VERSION,
      accounts: [
        { internalId: 'cl_0123456789abcdef0123', identityKeys: ['uuid:first'], credentials: identifiedCredential('t') },
        { internalId: 'cl_0123456789abcdef0123', identityKeys: ['uuid:second'], credentials: identifiedCredential('t') },
      ],
    })
    const store = new FileCredentialStore(path, backend)
    expect((await store.listAccounts())[0]?.identityKeys).toEqual(['uuid:first'])
  })

  it('deletes exactly one account, by its immutable id', async () => {
    const path = await legacyPath()
    const store = new FileCredentialStore(path, memoryBackend())
    const first = await store.saveAccount(seedOnlyCredential('token-one'))
    const second = await store.saveAccount(seedOnlyCredential('token-two'))

    expect(await store.deleteAccount(first.internalId)).toBe(true)
    const remaining = await store.listAccounts()
    expect(remaining.map((account) => account.internalId)).toEqual([second.internalId])
    // An id nothing matches changes nothing at all.
    expect(await store.deleteAccount(first.internalId)).toBe(false)
    expect(await store.listAccounts()).toHaveLength(1)
  })

  it('clears the secure store when the last account is deleted', async () => {
    const path = await legacyPath()
    const backend = memoryBackend()
    const store = new FileCredentialStore(path, backend)
    const only = await store.saveAccount(seedOnlyCredential('token'))

    expect(await store.deleteAccount(only.internalId)).toBe(true)
    expect(await store.read()).toBeNull()
    expect(backend.clear).toHaveBeenCalledOnce()
  })

  it('serialises concurrent saves, so no account is lost to a read-modify-write race', async () => {
    const path = await legacyPath()
    const store = new FileCredentialStore(path, memoryBackend())

    const saved = await Promise.all([
      store.saveAccount(seedOnlyCredential('token-a')),
      store.saveAccount(seedOnlyCredential('token-b')),
      store.saveAccount(seedOnlyCredential('token-c')),
    ])

    expect(new Set(saved.map((account) => account.internalId)).size).toBe(3)
    expect(await store.listAccounts()).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// Storage: migration, verification, paths
// ---------------------------------------------------------------------------

describe('claude credential storage', () => {
  it('migrates a pre-two-layer plaintext credential into a record with a minted id', async () => {
    const path = await legacyPath()
    await writeFile(path, JSON.stringify(credential()))
    const backend = memoryBackend()
    const store = new FileCredentialStore(path, backend)

    const document = await store.read()
    expect(document?.version).toBe(CREDENTIAL_DOCUMENT_VERSION)
    expect(document?.accounts).toHaveLength(1)
    const record = document?.accounts[0] as ClaudeAccountRecord
    expect(isClaudeAccountId(record.internalId)).toBe(true)
    expect(record.credentials).toEqual(credential())
    // No identity in the payload, so the seed is what recognises it.
    expect(record.identityKeys).toEqual(['seed:' + seedOf('refresh-token-secret')])
    expect(backend.save).toHaveBeenCalledTimes(1)
    // The plaintext is gone only after the encrypted write verified.
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    // A second read is served from the ciphertext and writes nothing again.
    expect((await new FileCredentialStore(path, backend).read())?.accounts[0]?.internalId).toBe(record.internalId)
    expect(backend.save).toHaveBeenCalledTimes(1)
  })

  it('keeps the plaintext when the encrypted write fails or fails to verify', async () => {
    const path = await legacyPath()
    await writeFile(path, JSON.stringify(credential()))
    const backend = memoryBackend()
    vi.mocked(backend.save).mockRejectedValueOnce(new Error('keyring locked'))
    await expect(new FileCredentialStore(path, backend).read()).rejects.toThrow('keyring locked')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(credential())

    vi.mocked(backend.load).mockResolvedValue(null)
    await expect(new FileCredentialStore(path, backend).read()).rejects.toThrow('verification failed')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(credential())
  })

  it('never falls back to plaintext when the secure store is damaged', async () => {
    const path = await legacyPath()
    await writeFile(path, JSON.stringify(credential()))
    const backend = memoryBackend()
    vi.mocked(backend.load).mockRejectedValue(new Error('encrypted payload damaged'))
    await expect(new FileCredentialStore(path, backend).read()).rejects.toThrow('encrypted payload damaged')
    expect(backend.save).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(credential())
  })

  it('rejects an unreadable plaintext without exposing its contents', async () => {
    const path = await legacyPath()
    await writeFile(path, '{"accessToken":"private-token", broken')
    const backend = memoryBackend()
    await expect(new FileCredentialStore(path, backend).read()).rejects.toThrow('legacy credential payload is invalid')
    expect(backend.save).not.toHaveBeenCalled()
    expect(await readFile(path, 'utf8')).toContain('private-token')
  })

  it('refuses to migrate a plaintext credential that is not a subscription credential', async () => {
    const path = await legacyPath()
    await writeFile(path, JSON.stringify(credential({ scopes: ['user:profile'] })))
    const backend = memoryBackend()
    await expect(new FileCredentialStore(path, backend).read()).rejects.toThrow('legacy credential payload is invalid')
    expect(backend.save).not.toHaveBeenCalled()
  })

  it('prefers the encrypted document over a leftover stale plaintext, and removes it', async () => {
    const path = await legacyPath()
    await writeFile(path, JSON.stringify(credential({ accessToken: 'stale' })))
    const backend = memoryBackend({
      version: CREDENTIAL_DOCUMENT_VERSION,
      accounts: [{ internalId: 'cl_0123456789abcdef0123', identityKeys: ['uuid:u'], credentials: identifiedCredential('fresh') }],
    })
    const store = new FileCredentialStore(path, backend)

    expect((await store.read())?.accounts[0]?.credentials.accessToken).toBe('access-token-secret')
    expect(backend.save).not.toHaveBeenCalled()
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('clears the migration source on logout before the secure store', async () => {
    const path = await legacyPath()
    await writeFile(path, JSON.stringify(credential()))
    const store = new FileCredentialStore(path, memoryBackend())
    await store.delete()
    expect(await store.read()).toBeNull()
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports a human-readable location matching the sibling lines', async () => {
    const path = await legacyPath()
    const store = new FileCredentialStore(path, memoryBackend())
    if (process.platform === 'win32') {
      expect(store.path()).toBe(path + '.dpapi')
    } else {
      const kind = process.platform === 'darwin' ? 'Keychain: ' : 'Secret Service: '
      expect(store.path().startsWith(kind + 'claude-subscription/')).toBe(true)
    }
  })

  it('names both storage files as documented', () => {
    expect(credentialPath()).toBe(expectedStoragesPath('claude-credentials.json'))
    expect(modelSettingsPath()).toBe(expectedStoragesPath('claude-models.json'))
    expect(CLAUDE_PREFERENCES_NAMESPACE).toBe('dsh-claude')
  })

  it('round-trips a document through the encrypted backend without leaving the plaintext behind', async () => {
    const path = await legacyPath()
    const backend = memoryBackend()
    const store = new FileCredentialStore(path, backend)

    await store.write({
      version: CREDENTIAL_DOCUMENT_VERSION,
      accounts: [{ internalId: 'cl_0123456789abcdef0123', identityKeys: ['uuid:u'], credentials: identifiedCredential('t') }],
    })
    expect((await new FileCredentialStore(path, backend).read())?.accounts).toHaveLength(1)
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    // The plaintext file is never written on the save path.
    expect(await readdir(join(path, '..'))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('claude model settings', () => {
  it('ships the documented defaults', () => {
    const defaults = defaultClaudeSettings()
    expect(defaults.enabled).toBe(true)
    expect(defaults.enabledModelIds).toEqual([...DEFAULT_VISIBLE_MODEL_IDS])
    expect(defaults.contextWindowOverrides).toEqual({})
    expect(defaults.defaultReasoningEffort).toBeNull()
    expect(defaults.selectedAccountId).toBeNull()
  })

  it('reads a document an earlier build left behind, unknown keys and all', async () => {
    // The exact shape a user who acknowledged a now-removed notice has on disk:
    // the key is unknown to this build, and the document MUST still parse — a
    // reader that rejected it would report "no settings" for a user whose model
    // selection is sitting intact in the same file.
    const legacy = {
      enabled: false,
      enabledModelIds: ['claude-sonnet-5'],
      contextWindowOverrides: { 'claude-opus-5': 500_000 },
      defaultReasoningEffort: 'high',
      selectedAccountId: 'cl_0123456789abcdef0123',
      consent: { accepted: true, acceptedAt: 1_700_000_000_000, version: '1' },
    }

    const parsed = parseClaudeModelSettings(legacy)
    expect(parsed).toEqual({
      enabled: false,
      enabledModelIds: ['claude-sonnet-5'],
      contextWindowOverrides: { 'claude-opus-5': 500_000 },
      defaultReasoningEffort: 'high',
      selectedAccountId: 'cl_0123456789abcdef0123',
    })
    // The unknown key is GONE from the parsed value rather than carried through:
    // the hand-written reader rebuilds each field it knows, so a later save
    // rewrites the document without it.
    expect('consent' in parsed).toBe(false)

    // And the FILE reader, which is a separate entry point to the same parse,
    // behaves identically on the same document.
    const file = await settingsFilePath()
    await writeFile(file, JSON.stringify(legacy), 'utf8')
    expect(await new FileModelSettingsStore(file).read()).toEqual(parsed)
  })

  it('drops an unknown key rather than failing the document that states it', async () => {
    // A single stray key must not cost the user the settings beside it: unknown
    // keys are ignored, and a value of any shape under one is irrelevant.
    expect(parseClaudeModelSettings({ enabled: true, totallyForeign: { nested: [1, 2] } }))
      .toMatchObject({ enabled: true, enabledModelIds: [...DEFAULT_VISIBLE_MODEL_IDS] })
  })

  it('falls back to the defaults for a missing, unparsable or wrong-shaped document', async () => {
    const file = await settingsFilePath()
    const store = new FileModelSettingsStore(file)
    expect(await store.read()).toEqual(defaultClaudeSettings())

    await writeFile(file, '{ half written', 'utf8')
    expect(await store.read()).toEqual(defaultClaudeSettings())

    expect(parseClaudeModelSettings('nonsense')).toEqual(defaultClaudeSettings())
    expect(parseClaudeModelSettings({ enabledModelIds: [1, 'ok', ''], contextWindowOverrides: { a: 'x', b: -1, c: 5 } }))
      .toMatchObject({ enabledModelIds: ['ok'], contextWindowOverrides: { c: 5 } })
  })

  it('round-trips settings atomically, leaving no temporary file behind', async () => {
    const file = await settingsFilePath()
    const store = new FileModelSettingsStore(file)
    expect(store.path()).toBe(file)

    const next = await store.updateSettings({ enabled: false, enabledModelIds: ['claude-opus-5'] })
    expect(next.enabled).toBe(false)
    expect(await new FileModelSettingsStore(file).read()).toEqual(next)
    expect(await readdir(join(file, '..'))).toEqual(['claude-models.json'])
  })

  it('drops a context-window override on a null patch and keeps the rest', async () => {
    const file = await settingsFilePath()
    const store = new FileModelSettingsStore(file)
    await store.updateSettings({ contextWindowOverrides: { 'claude-opus-5': 500_000, 'claude-sonnet-5': 900_000 } })

    const next = await store.updateSettings({ contextWindowOverrides: { 'claude-opus-5': null, 'claude-haiku-4-5': 100_000 } })
    expect(next.contextWindowOverrides).toEqual({ 'claude-sonnet-5': 900_000, 'claude-haiku-4-5': 100_000 })
    // The null never reaches the file: persisted settings stay numeric.
    expect((await store.read()).contextWindowOverrides).toEqual(next.contextWindowOverrides)
  })

  it('serialises concurrent patches instead of losing one to the other', async () => {
    const file = await settingsFilePath()
    const store = new FileModelSettingsStore(file)

    await Promise.all([
      store.updateSettings({ enabledModelIds: ['claude-opus-5'] }),
      store.updateSettings({ selectedAccountId: 'cl_0123456789abcdef0123' }),
      store.updateSettings({ contextWindowOverrides: { 'claude-opus-5': 500_000 } }),
    ])

    const stored = await store.read()
    expect(stored.enabledModelIds).toEqual(['claude-opus-5'])
    expect(stored.selectedAccountId).toBe('cl_0123456789abcdef0123')
    expect(stored.contextWindowOverrides).toEqual({ 'claude-opus-5': 500_000 })
  })
})

describe('registerClaudePreferenceStore', () => {
  it('hydrates every field from the fallback file when the harness has no register seam', async () => {
    const file = await settingsFilePath()
    const fallback = new FileModelSettingsStore(file)
    await fallback.updateSettings({
      enabled: false,
      enabledModelIds: ['claude-sonnet-5'],
      selectedAccountId: 'cl_0123456789abcdef0123',
    })

    const preferences = registerClaudePreferenceStore({}, fallback)
    await vi.waitFor(() => expect(preferences.status()).toMatchObject({
      enabled: false,
      enabledModelIds: ['claude-sonnet-5'],
      selectedAccountId: 'cl_0123456789abcdef0123',
    }))

    const updated = await preferences.update({ contextWindowOverrides: { 'claude-opus-5': 500_000 } })
    expect(updated.contextWindowOverrides).toEqual({ 'claude-opus-5': 500_000 })
    expect(preferences.status().contextWindowOverrides).toEqual({ 'claude-opus-5': 500_000 })
    expect((await fallback.read()).contextWindowOverrides).toEqual({ 'claude-opus-5': 500_000 })
  })

  it('registers the documented namespace and keeps the register path when one exists', async () => {
    const file = await settingsFilePath()
    const fallback = new FileModelSettingsStore(file)
    const namespaces: unknown[] = []
    let value: Record<string, unknown> = { contextWindowOverrides: { 'claude-opus-5': 100_000 } }

    const preferences = registerClaudePreferenceStore({
      register(namespace: unknown, schema: (input: unknown) => Record<string, unknown>) {
        namespaces.push(namespace)
        value = schema(value)
        return {
          get: () => value,
          update: async (patch: object) => { value = schema({ ...value, ...patch }) },
        }
      },
    }, fallback)

    expect(namespaces).toEqual(['dsh-claude'])
    expect(preferences.status()).toMatchObject({
      enabled: true,
      contextWindowOverrides: { 'claude-opus-5': 100_000 },
    })

    const updated = await preferences.update({
      contextWindowOverrides: { 'claude-opus-5': null, 'claude-sonnet-5': 500_000 },
      defaultReasoningEffort: 'high',
    })
    expect(updated.contextWindowOverrides).toEqual({ 'claude-sonnet-5': 500_000 })
    expect(updated.defaultReasoningEffort).toBe('high')
    expect(preferences.status()).toMatchObject({
      contextWindowOverrides: { 'claude-sonnet-5': 500_000 },
      defaultReasoningEffort: 'high',
    })

    // The same patch is mirrored to the file, so a later run on a harness that
    // lost the register seam still finds the selection.
    await vi.waitFor(async () => {
      expect((await fallback.read()).contextWindowOverrides).toEqual({ 'claude-sonnet-5': 500_000 })
    })
  })
})

// ---------------------------------------------------------------------------
// The real platform backend, where there is one to exercise
// ---------------------------------------------------------------------------

describe.skipIf(process.platform !== 'win32')('claude credential storage / Windows DPAPI', () => {
  /**
   * The ONLY test in this file that asserts anything about a real platform's
   * cryptography. It is skipped everywhere but Windows, and it is the reason the
   * module builds its own backend on this platform: a green run elsewhere is
   * evidence about the in-memory backend and nothing more.
   */
  it('keeps bearer tokens out of the plaintext file it migrates from', async () => {
    const path = await legacyPath()
    await writeFile(path, JSON.stringify(credential()))
    const store = new FileCredentialStore(path)

    const document = await store.read()
    expect(document?.accounts[0]?.credentials.refreshToken).toBe('refresh-token-secret')
    expect(await new FileCredentialStore(path).read()).toEqual(document)
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })

    const raw = await readFile(store.path())
    expect(raw.toString('utf8')).not.toContain('refresh-token-secret')
    expect(raw.toString('utf8')).not.toContain('access-token-secret')
    expect(await readdir(join(path, '..'))).toEqual(['claude-credentials.json.dpapi'])

    const saved = await store.saveAccount(identifiedCredential('rotated-token'))
    expect(saved.credentials.refreshToken).toBe('rotated-token')
    expect(await new FileCredentialStore(path).read()).toEqual(await store.read())
  }, 30_000)
})
