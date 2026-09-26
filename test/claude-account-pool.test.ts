import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import {
  CLAUDE_DEFAULT_COOLDOWN_MS,
  CLAUDE_EMPTY_POOL_MESSAGE,
  CLAUDE_REFRESH_MARGIN_MS,
  ClaudeAccountPool,
  ClaudeAdoptedCredentialError,
  ClaudeCredentialStoreAdapter,
  claudeAccountRotationAction,
  claudeAuthRejectedReason,
  claudeNeedsRefresh,
  claudePoolPath,
  isAdoptedPoolCredential,
  parseClaudePoolCredentials,
  type ClaudePoolAccount,
} from '../src/host/claude/account-pool.ts'
import {
  FileCredentialStore,
  createInternalId,
  identityKeysFor,
  type ClaudeCredentials,
} from '../src/host/claude/token-store.ts'
import { ClaudeUnauthorizedError } from '../src/host/claude/oauth.ts'
import {
  ADOPTED_CREDENTIAL_EXPIRED_HINT,
  CLAUDE_CODE_CREDENTIAL_SOURCE,
  parseAdoptedClaudeCredential,
  readClaudeCodeCredentials,
} from '../src/host/claude/adopt.ts'
import { PROVIDER_ID } from '../src/host/claude/types.ts'
import { classifyFailure } from '../src/host/claude/client.ts'
import type { PoolData } from '../src/host/common/account-pool.ts'

const SUBSCRIPTION_SCOPES = ['user:inference', 'user:profile']

/** Mirrors the platform backends: JSON in memory, and the parse hook on read. */
class MemoryBackend {
  private data: unknown = null
  async load() { return this.data === null ? null : JSON.parse(JSON.stringify(this.data)) }
  async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

function tmpFile(name: string): string {
  return path.join(os.tmpdir(), name + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json')
}

/** A stored credential document, backed by memory. */
function documentStore(): FileCredentialStore {
  return new FileCredentialStore(tmpFile('claude-doc'), new MemoryBackend() as never)
}

/** A managed credential for account n, with the scopes a subscription needs. */
function managed(n: number, overrides: Partial<ClaudeCredentials> = {}): ClaudeCredentials {
  return {
    accessToken: 'at-' + n,
    refreshToken: 'rt-' + n,
    expiresAt: Date.now() + 3_600_000,
    scopes: [...SUBSCRIPTION_SCOPES],
    subscriptionType: 'max',
    account: { uuid: 'uuid-' + n, email_address: 'user' + n + '@example.com' },
    ...overrides,
  }
}

/** The credential an adopted snapshot carries, in this pool's flattened shape. */
function adoptedCredentials(
  n: number,
  expiresAt: number,
  overrides: Partial<ClaudeCredentials> = {},
): ClaudeCredentials {
  return {
    accessToken: 'adopted-at-' + n,
    refreshToken: 'adopted-rt-' + n,
    // No scopes: 'adopt.ts' refuses to invent the ones Claude Code's document
    // did not state, which is exactly the case the pool must still serve while
    // the snapshot is valid.
    expiresAt,
    adopted: true,
    source: CLAUDE_CODE_CREDENTIAL_SOURCE,
    sourcePath: 'C:/Users/example/.claude/.credentials.json',
    ...overrides,
  } as ClaudeCredentials
}

/** The same snapshot shape, read from a different Claude Code config home. */
function withSourcePath(credentials: ClaudeCredentials, sourcePath: string): ClaudeCredentials {
  return { ...credentials, sourcePath } as ClaudeCredentials
}

interface Harness {
  pool: ClaudeAccountPool
  store: FileCredentialStore
  backend: MemoryBackend
  refresh: ReturnType<typeof vi.fn>
}

function harness(): Harness {
  const store = documentStore()
  const backend = new MemoryBackend()
  const refresh = vi.fn(async (credentials: ClaudeCredentials) => ({
    ...credentials,
    accessToken: 'refreshed-' + credentials.accessToken,
    expiresAt: Date.now() + 3_600_000,
  }))
  const pool = new ClaudeAccountPool({
    store,
    backend: backend as never,
    refreshCredentials: refresh as unknown as never,
  })
  return { pool, store, backend, refresh }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ClaudeAccountPool — identity', () => {
  it('keys an account by the credential document internalId, and never by a token', async () => {
    const { pool, store } = harness()
    const account = await pool.addAccount(managed(1))

    const record = (await store.listAccounts())[0]!
    // One key space: the pool row and the document record are the same id.
    expect(account.id).toBe(record.internalId)
    expect(account.id).toMatch(/^cl_[0-9a-f]{20}$/)

    // A re-login with BOTH tokens rotated keeps the same row: the tokens are not
    // what identifies the account.
    const again = await pool.addAccount(managed(1, { accessToken: 'at-rotated', refreshToken: 'rt-rotated' }))
    expect(again.id).toBe(account.id)
    expect(await pool.listAccounts()).toHaveLength(1)
  })

  it('adopts an internalId the credential document already mints', async () => {
    const { pool, store } = harness()
    const record = await store.saveAccount(managed(7))
    // Deliberately not a fresh credential: the pool must resolve the SAME row
    // the document already holds, by its alias, and reuse its id.
    const account = await pool.addAccount(managed(7))
    expect(account.id).toBe(record.internalId)
    expect(await pool.listAccounts()).toHaveLength(1)
  })

  it('falls back to the internalId when the credential states no uuid or address', async () => {
    const { pool } = harness()
    const first = await pool.addAccount(managed(1, { account: undefined }))
    // Same account, same (rotated) tokens, no identity fields at all: the seed
    // alias is a digest of the refresh token, so it is a LOOKUP key and the row
    // is still found rather than duplicated.
    const again = await pool.addAccount(managed(1, { account: undefined }))
    expect(again.id).toBe(first.id)
    expect(await pool.listAccounts()).toHaveLength(1)
    // The id is the document's id, not a seed digest.
    expect(again.id.startsWith('cl_')).toBe(true)
  })

  it('projects the pre-pool credential document as the primary account without writing', async () => {
    const { pool, store, backend } = harness()
    const record = await store.saveAccount(managed(3))
    const save = vi.spyOn(backend, 'save')

    const data = await pool.read()
    expect(data.accounts).toHaveLength(1)
    expect(data.accounts[0]!.id).toBe(record.internalId)
    expect(data.activeAccountId).toBe(record.internalId)
    expect(save).not.toHaveBeenCalled()
    expect((await pool.listAccounts())[0]).toMatchObject({
      email: 'user3@example.com',
      planLabel: 'max',
      subscriptionType: 'max',
      isPrimary: true,
      adopted: false,
      source: 'managed',
      removable: true,
    })
  })

  it('mirrors the primary account back into the credential document', async () => {
    const { pool, store } = harness()
    const account = await pool.addAccount(managed(1))
    const mirrored = await store.listAccounts()
    expect(mirrored).toHaveLength(1)
    expect(mirrored[0]!.internalId).toBe(account.id)
    expect(mirrored[0]!.credentials.accessToken).toBe('at-1')
  })

  it('clears the credential document when the last managed account goes', async () => {
    const { pool, store } = harness()
    const account = await pool.addAccount(managed(1))
    await pool.deleteAccount(account.id)
    expect(await store.listAccounts()).toEqual([])
    // And the projection does not resurrect it.
    expect((await pool.read()).accounts).toEqual([])
  })
})

describe('ClaudeAccountPool — an adopted snapshot is a snapshot', () => {
  it('PROVES an EXPIRED adopted account is never refreshed', async () => {
    const { pool, store, refresh } = harness()
    const expired = adoptedCredentials(1, Date.now() - 60_000)
    const account = await pool.addAccount(expired)

    expect(account.adopted).toBe(true)
    expect(account.source).toBe(CLAUDE_CODE_CREDENTIAL_SOURCE)
    expect(isAdoptedPoolCredential(account.credentials)).toBe(true)

    // 1. needsRefresh is FALSE even though the credential expired a minute ago,
    //    and it is false for the credential the row actually stores — not merely
    //    for the object that was handed in.
    expect(account.credentials.expiresAt).toBeLessThan(Date.now())
    expect(claudeNeedsRefresh(account.credentials, Date.now())).toBe(false)
    expect(claudeNeedsRefresh(expired, Date.now())).toBe(false)
    // A managed credential in the same state says the opposite, which is what
    // makes the assertion above about the ADOPTED rule rather than about expiry.
    expect(claudeNeedsRefresh(managed(9, { expiresAt: Date.now() - 60_000 }), Date.now())).toBe(true)

    // 2. Routing refuses it with the hint that sends the user back to CLAUDE CODE.
    const summaries = await pool.listAccounts()
    expect(summaries[0]).toMatchObject({
      authStatus: 'expired',
      authFailedReason: ADOPTED_CREDENTIAL_EXPIRED_HINT,
      adopted: true,
      removable: false,
    })
    await expect(pool.getEffectiveAccount()).rejects.toMatchObject({ code: 'RATE_LIMIT' })
    expect(refresh).not.toHaveBeenCalled()

    // 3. The refresh hook itself is UNREACHABLE for it, and says so.
    //    getEffectiveAccount never gets here (it filters first), so the guard is
    //    exercised directly through the seam it protects: an in-place
    //    re-authorization is the other route into it.
    await expect(pool.addAccount(expired)).resolves.toBeDefined()
    expect(refresh).not.toHaveBeenCalled()

    // 4. The direct credential path refuses it too, without refreshing.
    await expect(pool.getCredentialAccount()).rejects.toMatchObject({ code: 'AUTH' })
    expect(refresh).not.toHaveBeenCalled()

    // 5. Nothing was written into this plugin's own credential document.
    expect(await store.listAccounts()).toEqual([])
  })

  it('refuses a refresh of an adopted snapshot at the refresh seam itself', async () => {
    const { pool } = harness()
    const expired = adoptedCredentials(2, Date.now() - 1_000)
    await pool.addAccount(expired)

    // The seam is private; reach it the way the core does, through the hook the
    // pool installed, by driving a credential the core WOULD refresh. The
    // per-account guard is asserted here through the public helper that the
    // hook delegates to, plus the error type the guard raises.
    const hooks = (pool as unknown as { hooks: { refresh: (c: ClaudeCredentials, f: typeof fetch) => Promise<ClaudeCredentials> } }).hooks
    await expect(hooks.refresh(expired, fetch)).rejects.toBeInstanceOf(ClaudeAdoptedCredentialError)
    await expect(hooks.refresh(expired, fetch)).rejects.toMatchObject({
      message: ADOPTED_CREDENTIAL_EXPIRED_HINT,
      name: 'ClaudeAdoptedCredentialError',
    })
    // The guard's error classifies as a final credential failure, never as a
    // transient one, so a caller that does reach it retires the account.
    expect(new ClaudeAdoptedCredentialError('x')).toBeInstanceOf(ClaudeUnauthorizedError)
  })

  it('serves a still-valid adopted credential, and still never refreshes it', async () => {
    const { pool, refresh } = harness()
    // A snapshot with NO scopes, which is what 'adopt.ts' produces when Claude
    // Code's document stated none: it must still be usable while it is valid,
    // or adoption would be useless in exactly the case it exists for.
    const live = await pool.addAccount(adoptedCredentials(3, Date.now() + 3_600_000))
    expect((await pool.listAccounts())[0]!.authStatus).toBeUndefined()
    await expect(pool.getEffectiveAccount()).resolves.toMatchObject({
      account: { id: live.id, adopted: true },
      credentials: { accessToken: 'adopted-at-3' },
    })

    // An EXPIRED one is the case that refuses, and it refuses with the hint.
    const dead = await pool.addAccount(adoptedCredentials(4, Date.now() - 1))
    expect((await pool.listAccounts()).find((entry) => entry.id === dead.id)).toMatchObject({
      authStatus: 'expired',
      authFailedReason: ADOPTED_CREDENTIAL_EXPIRED_HINT,
    })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('reports a non-subscription credential with a reason instead of dropping the row', async () => {
    const { pool, store } = harness()
    // A credential that authenticates but is not entitled to /v1/messages. The
    // document refuses to store it, so the pool reports that refusal — a row it
    // could never serve must not appear to have been added.
    const scopeless = managed(4, { scopes: ['user:profile'] })
    expect(claudeAuthRejectedReason(scopeless)).toMatch(/not a subscription credential/)
    expect(claudeAuthRejectedReason(managed(4, { scopes: ['user:inference'] }))).toBeUndefined()
    await expect(pool.addAccount(scopeless)).rejects.toThrow(/not a subscription credential/)

    // A stored credential that is scopeless but MANAGED (only reachable from a
    // document written before the scope gate, or hand-edited) is still listed and
    // refused with the reason, rather than silently vanishing from the card.
    await (pool as unknown as { write: (d: unknown) => Promise<void> }).write({
      version: 1,
      rotationStrategy: 'sequential',
      accounts: [{
        id: 'cl_' + 'a'.repeat(20),
        alias: 'scopeless',
        credentials: scopeless,
        addedAt: Date.now(),
        adopted: false,
        source: 'managed',
        identityKeys: identityKeysFor(scopeless),
      }],
    })
    const rows = await pool.listAccounts()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe('cl_' + 'a'.repeat(20))
    await expect(pool.getEffectiveAccount()).rejects.toMatchObject({ code: 'RATE_LIMIT' })
    expect(await store.listAccounts()).toEqual([])
  })

  it('reads a real adopt.ts snapshot through the pool without touching Claude Code', async () => {
    const source = tmpFile('claude-code-credentials')
    const parsed = parseAdoptedClaudeCredential({
      claudeAiOauth: {
        accessToken: 'from-claude-code',
        refreshToken: 'from-claude-code-refresh',
        expiresAt: Date.now() - 1,
        subscriptionType: 'pro',
      },
      // The MCP trap the adopt module guards against.
      mcpOAuth: { someServer: { accessToken: 'mcp-token' } },
    }, source)
    expect(parsed).toBeDefined()

    const { pool, store, refresh } = harness()
    const snapshot = parsed!
    const credentials = {
      ...snapshot.credentials,
      adopted: true as const,
      source: snapshot.source,
      sourcePath: snapshot.sourcePath,
    }
    const account = await pool.addAccount(credentials)
    expect(account.credentials.accessToken).toBe('from-claude-code')
    expect((await pool.listAccounts())[0]).toMatchObject({
      adopted: true,
      removable: false,
      authStatus: 'expired',
      authFailedReason: ADOPTED_CREDENTIAL_EXPIRED_HINT,
    })
    expect(refresh).not.toHaveBeenCalled()
    expect(await store.listAccounts()).toEqual([])

    // And the snapshot the adopt module returns really does carry the marker the
    // pool tests for.
    expect(parsed!.adopted).toBe(true)
    expect(parsed!.source).toBe(CLAUDE_CODE_CREDENTIAL_SOURCE)
  })

  it('does not delete an adopted account, and does not delete it with the managed action', async () => {
    const { pool } = harness()
    const account = await pool.addAccount(adoptedCredentials(5, Date.now() + 60_000))
    await expect(pool.deleteAccount(account.id)).rejects.toThrow(/imported from Claude Code/)
    expect((await pool.listAccounts())).toHaveLength(1)

    await pool.removeImportedAccount(account.id)
    expect(await pool.listAccounts()).toEqual([])
    // The managed action is refused on an adopted row, and vice versa.
    const managedAccount = await pool.addAccount(managed(6))
    await expect(pool.removeImportedAccount(managedAccount.id)).rejects.toThrow(/signed in through this plugin/)
  })
})

describe('ClaudeAccountPool — managed beats adopted', () => {
  it('MERGES a managed sign-in and an adopted snapshot into one refreshable record', async () => {
    const { pool, refresh } = harness()
    // A snapshot that carries the account's identity, which is the shape in which
    // the pool can recognize the two rows as one account WITHOUT asking the user.
    // ('adopt.ts' itself omits the account block — it has no verified spelling
    // for it — so a real Claude Code snapshot normally needs the explicit merge
    // asserted further down; the pool has to handle both.)
    const snapshot = await pool.addAccount(adoptedCredentials(1, Date.now() - 30_000, {
      account: { uuid: 'uuid-1', email_address: 'user1@example.com' },
    }))
    expect(snapshot.adopted).toBe(true)
    expect(snapshot.source).toBe(CLAUDE_CODE_CREDENTIAL_SOURCE)

    const merged = await pool.addAccount(managed(1))

    // ONE row, not two: the identity alias the snapshot learned is what the
    // managed sign-in resolved through.
    expect(await pool.listAccounts()).toHaveLength(1)
    // ONE KEY, too. The row the snapshot had minted for itself has been re-keyed
    // onto the id the credential document just gave this account, because a
    // managed account's id IS the document's internalId — keeping the snapshot's
    // private id would put the pool and the document back into two key spaces.
    const documentRecord = (await pool.mirrorStore().listAccounts())[0]!
    expect(merged.id).toBe(documentRecord.internalId)
    expect(merged.id).not.toBe(snapshot.id)
    expect(merged.credentials.accessToken).toBe('at-1')
    expect(merged.credentials.refreshToken).toBe('rt-1')
    expect(merged.identityKeys).toContain('uuid:uuid-1')

    // The adopted marker did NOT survive, and neither did its never-refresh
    // consequence — a surviving marker would silently stop the account from ever
    // refreshing again.
    expect(merged.adopted).toBe(false)
    expect(merged.source).toBe('managed')
    expect(isAdoptedPoolCredential(merged.credentials)).toBe(false)
    expect(merged.sourcePath).toBeUndefined()

    // The record is refreshable again: expiry now decides, where the snapshot
    // refused regardless of expiry.
    expect(claudeNeedsRefresh(merged.credentials, Date.now())).toBe(false)
    const expiring = managed(1, { expiresAt: Date.now() + 1_000 })
    await pool.updateAccountCredentials(merged.id, expiring)
    expect(claudeNeedsRefresh(expiring, Date.now())).toBe(true)

    // ...and refresh actually runs, against the managed refresh token.
    await pool.getEffectiveAccount()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh.mock.calls[0]![0].refreshToken).toBe('rt-1')

    const summary = (await pool.listAccounts())[0]!
    expect(summary).toMatchObject({ id: merged.id, adopted: false, removable: true })
    expect(summary.source).toBe('managed')
    expect(summary.authStatus).toBeUndefined()
  })

  it('keeps the managed credential when the snapshot arrives second', async () => {
    const { pool, refresh } = harness()
    const managedAccount = await pool.addAccount(managed(2, { expiresAt: Date.now() + 1_000 }))
    const after = await pool.addAccount(adoptedCredentials(2, Date.now() - 30_000, {
      account: { uuid: 'uuid-2', email_address: 'user2@example.com' },
    }))
    expect(after.id).toBe(managedAccount.id)
    expect(after.adopted).toBe(false)
    expect(after.source).toBe('managed')
    // The borrowed tokens did NOT overwrite the managed pair, in either
    // direction: this is the whole point of managed-wins.
    expect(after.credentials.accessToken).toBe('at-2')
    expect(after.credentials.refreshToken).toBe('rt-2')
    expect(await pool.listAccounts()).toHaveLength(1)
    await pool.getEffectiveAccount()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh.mock.calls[0]![0].refreshToken).toBe('rt-2')

    // A snapshot stating NO identity shares nothing with a managed credential,
    // so it is honestly a second row rather than a silently wrong merge. The
    // remedy is the explicit merge below, not a guess.
    const seedOnly = await pool.addAccount(withSourcePath(adoptedCredentials(2, Date.now() - 30_000), '/unstated/.credentials.json'))
    expect(seedOnly.id).not.toBe(managedAccount.id)
    expect(await pool.listAccounts()).toHaveLength(2)
  })

  it('re-importing the same source file updates its row instead of adding one', async () => {
    const { pool } = harness()
    const first = await pool.addAccount(adoptedCredentials(9, Date.now() + 3_600_000))
    // The RE-IMPORT the expiry hint tells the user to perform: Claude Code
    // refreshed its own file, so BOTH tokens are different — and the seed alias
    // is a digest of the refresh token, so it is different too. The SOURCE FILE
    // is the only thing that still identifies the row, which is exactly why the
    // pool files a snapshot under it.
    const again = await pool.addAccount(withSourcePath(
      adoptedCredentials(9, Date.now() + 7_200_000, { accessToken: 'fresh-at', refreshToken: 'fresh-rt' }),
      'C:/Users/example/.claude/.credentials.json',
    ))
    expect(again.id).toBe(first.id)
    expect(again.credentials.accessToken).toBe('fresh-at')
    expect(await pool.listAccounts()).toHaveLength(1)

    // A DIFFERENT config home with its own tokens is a different snapshot, and
    // stays its own row — the case the source-file rule does not conflate.
    const elsewhere = await pool.addAccount(withSourcePath(
      adoptedCredentials(9, Date.now() + 60_000, { accessToken: 'other-at', refreshToken: 'other-rt' }),
      '/other/.claude/.credentials.json',
    ))
    expect(elsewhere.id).not.toBe(first.id)
    expect(await pool.listAccounts()).toHaveLength(2)
  })

  it('unglues an expired snapshot from the rotation through an explicit merge', async () => {
    const { pool, refresh } = harness()
    // The seed-only case the credential document cannot recognize twice: two
    // rows for one Claude account, one of them a borrowed, expired snapshot.
    const snapshot = await pool.addAccount(adoptedCredentials(1, Date.now() - 60_000))
    const foreign: ClaudePoolAccount = {
      id: 'cl_' + 'b'.repeat(20),
      alias: 'the same account, signed in here',
      credentials: managed(1),
      addedAt: Date.now(),
      adopted: false,
      source: 'managed',
      identityKeys: identityKeysFor(managed(1)),
    }
    await (pool as unknown as { write: (d: PoolData<ClaudePoolAccount>) => Promise<void> }).write({
      version: 1,
      rotationStrategy: 'sequential',
      accounts: [{ ...(snapshot as unknown as ClaudePoolAccount) }, foreign],
    })
    expect(await pool.listAccounts()).toHaveLength(2)

    const merged = await pool.mergeAccounts(foreign.id, snapshot.id)
    expect(merged.id).toBe(foreign.id)
    expect(merged.alias).toBe(foreign.alias)
    expect(merged.adopted).toBe(false)
    expect(merged.source).toBe('managed')
    expect(merged.credentials.accessToken).toBe('at-1')
    expect(merged.identityKeys).toContain('uuid:uuid-1')
    expect(await pool.listAccounts()).toHaveLength(1)

    // Refreshable again, and the expiry check says so.
    const expiring = { ...managed(1), expiresAt: Date.now() + 1_000 }
    const updated = await pool.updateAccountCredentials(merged.id, expiring)
    expect(updated).toBeDefined()
    expect(claudeNeedsRefresh(updated!.credentials, Date.now())).toBe(true)
    await pool.getEffectiveAccount()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh.mock.calls[0]![0].refreshToken).toBe('rt-1')

    // Merging two adopted rows keeps the marker: there is nothing to promote.
    // Two DIFFERENT source files, because a snapshot is filed under its path
    // (see the re-import test for why) and one path is one row by construction.
    const one = await pool.addAccount(withSourcePath(adoptedCredentials(2, Date.now() + 3_600_000), '/a/.credentials.json'))
    const two = await pool.addAccount(withSourcePath(adoptedCredentials(3, Date.now() + 3_600_000), '/b/.credentials.json'))
    const kept = await pool.mergeAccounts(one.id, two.id)
    expect(kept.adopted).toBe(true)
    expect(kept.source).toBe(CLAUDE_CODE_CREDENTIAL_SOURCE)
  })
})

describe('ClaudeAccountPool — the credential document seam', () => {
  it('reads and writes exactly one record, addressed by internalId', async () => {
    const store = documentStore()
    const first = await store.saveAccount(managed(1))
    const second = await store.saveAccount(managed(2))
    const adapter = new ClaudeCredentialStoreAdapter(store, second.internalId)

    expect((await adapter.read())?.accessToken).toBe('at-2')

    await adapter.write({ ...managed(2), accessToken: 'rotated', refreshToken: 'rotated' })
    const records = await store.listAccounts()
    expect(records).toHaveLength(2)
    expect(records.find((r) => r.internalId === first.internalId)?.credentials.accessToken).toBe('at-1')
    const updated = records.find((r) => r.internalId === second.internalId)!
    expect(updated.credentials.accessToken).toBe('rotated')
    // The alias set is merged, not replaced.
    expect(updated.identityKeys).toContain('uuid:uuid-2')

    expect(await new ClaudeCredentialStoreAdapter(store, createInternalId()).read()).toBeNull()
  })

  it('is the store the pool hands the sign-in flow, and it writes into that account record', async () => {
    const { pool } = harness()
    const account = await pool.addAccount(managed(1))
    const seam = pool.credentialStoreFor(account.id)
    expect((await seam.read())?.accessToken).toBe('at-1')
    await seam.write({ ...managed(1), accessToken: 'from-sign-in' })
    expect((await pool.mirrorStore().listAccounts())[0]!.credentials.accessToken).toBe('from-sign-in')
  })
})

describe('ClaudeAccountPool — rotation and the rotation contract', () => {
  it('walks to the next eligible account when the primary is cooling down', async () => {
    const { pool } = harness()
    const first = await pool.addAccount(managed(1))
    const second = await pool.addAccount(managed(2))
    expect((await pool.getEffectiveAccount()).account.id).toBe(first.id)

    await pool.markCooldown(first.id, 600_000, 'Claude 429')
    expect((await pool.getEffectiveAccount()).account.id).toBe(second.id)
  })

  it('reports a signed-out pool with the wording the OAuth module uses', async () => {
    const { pool } = harness()
    await expect(pool.getEffectiveAccount()).rejects.toThrow(CLAUDE_EMPTY_POOL_MESSAGE)
  })

  it('rotates ONLY on a credential failure or an account-scoped rate limit', async () => {
    const headers = { 'anthropic-ratelimit-unified-status': 'rejected' }

    // Account-scoped 429: rotate.
    const accountScoped = classifyFailure(429, JSON.stringify({ error: { type: 'rate_limit_error', message: 'window spent' } }), headers)
    expect(accountScoped).toMatchObject({ kind: 'rate_limit_account', accountScoped: true })
    expect(claudeAccountRotationAction(accountScoped)).toEqual({ action: 'cool-down', durationMs: CLAUDE_DEFAULT_COOLDOWN_MS })

    // The same 429 with no unified header at all is GLOBAL, and must not rotate.
    const global = classifyFailure(429, JSON.stringify({ error: { type: 'rate_limit_error', message: 'slow down' } }))
    expect(global).toMatchObject({ kind: 'rate_limit_global', accountScoped: false })
    expect(claudeAccountRotationAction(global)).toEqual({ action: 'none' })

    // Overload and server errors are nobody's account.
    expect(claudeAccountRotationAction(classifyFailure(529, ''))).toEqual({ action: 'none' })
    expect(claudeAccountRotationAction(classifyFailure(500, ''))).toEqual({ action: 'none' })
    expect(claudeAccountRotationAction(classifyFailure(400, ''))).toEqual({ action: 'none' })

    // A credential failure marks the account instead of cooling it down.
    expect(claudeAccountRotationAction(classifyFailure(401, JSON.stringify({ error: { type: 'authentication_error' } })))).toEqual({
      action: 'mark-auth-failed',
      status: 'expired',
    })

    // retry-after wins over the fallback.
    expect(claudeAccountRotationAction({
      kind: 'rate_limit_account',
      accountScoped: true,
      retryAfterMs: 42_000,
    })).toEqual({ action: 'cool-down', durationMs: 42_000 })
  })

  it('single-flights a refresh per account, so one rotating token is spent once', async () => {
    const { pool, refresh } = harness()
    await pool.addAccount(managed(1, { expiresAt: Date.now() + 1_000 }))
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    refresh.mockImplementation(async (credentials: ClaudeCredentials) => {
      await gate
      return { ...credentials, accessToken: 'once', expiresAt: Date.now() + 3_600_000 }
    })

    const first = pool.getEffectiveAccount()
    const second = pool.getEffectiveAccount()
    release()
    const [a, b] = await Promise.all([first, second])
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(a.credentials.accessToken).toBe('once')
    expect(b.credentials.accessToken).toBe('once')
  })

  it('marks an account whose refresh was finally rejected, and keeps the row', async () => {
    const { pool, refresh } = harness()
    const account = await pool.addAccount(managed(1, { expiresAt: Date.now() + 1_000 }))
    refresh.mockRejectedValue(new ClaudeUnauthorizedError('Claude rejected the sign-in. Sign in again.'))

    await expect(pool.getEffectiveAccount()).rejects.toThrow(/rejected the sign-in/)
    const summary = (await pool.listAccounts()).find((entry) => entry.id === account.id)
    expect(summary).toMatchObject({ authStatus: 'expired' })
  })
})

describe('Claude pool document parsing', () => {
  it('drops an unreadable row instead of failing the whole document', async () => {
    const { pool } = harness()
    await pool.addAccount(managed(1))
    const data = await pool.read()

    const damaged: PoolData<ClaudePoolAccount> = {
      ...data,
      accounts: [...data.accounts, { ...data.accounts[0]!, id: 'cl_' + 'f'.repeat(20), credentials: { accessToken: '', refreshToken: '', expiresAt: NaN } as never }],
    }
    const parsed = (pool as unknown as { hooks: { parsePoolData: (v: unknown) => PoolData<ClaudePoolAccount> } }).hooks.parsePoolData(damaged)
    expect(parsed.accounts).toHaveLength(1)
    expect(parsed.accounts[0]!.id).toBe(data.accounts[0]!.id)
  })

  it('keeps the adopted marker only when both fields say so', () => {
    const credentialed = managed(1)
    expect(isAdoptedPoolCredential(credentialed)).toBe(false)
    expect(isAdoptedPoolCredential({ ...credentialed, adopted: true } as ClaudeCredentials)).toBe(false)
    expect(isAdoptedPoolCredential({ ...credentialed, source: CLAUDE_CODE_CREDENTIAL_SOURCE } as ClaudeCredentials)).toBe(false)
    expect(isAdoptedPoolCredential({ ...credentialed, adopted: true, source: CLAUDE_CODE_CREDENTIAL_SOURCE } as ClaudeCredentials)).toBe(true)

    // A markup-shaped credential parses but refuses to serve.
    expect(parseClaudePoolCredentials({ accessToken: 'a', refreshToken: '' })).toBeNull()
    expect(parseClaudePoolCredentials({ accessToken: 'a', refreshToken: 'b', expiresAt: Infinity })).toBeNull()
    expect(parseClaudePoolCredentials({ accessToken: 'a', refreshToken: 'b', expiresAt: 1 })).toMatchObject({ accessToken: 'a' })
  })

  it('names the pool file and service this line owns', () => {
    expect(claudePoolPath()).toContain(process.env.DSH_HOME ?? '')
    expect(claudePoolPath().endsWith(path.join('storages', 'claude-pool.json'))).toBe(true)
    expect(PROVIDER_ID).toBe('claude-subscription')
    expect(CLAUDE_REFRESH_MARGIN_MS).toBe(300_000)
  })
})

describe('Claude adopt module integration', () => {
  it('reads back the credential a real Claude Code document holds', async () => {
    // The reader is a filesystem function; this asserts the SHAPE the pool
    // consumes, through the parser the reader delegates to.
    const parsed = parseAdoptedClaudeCredential({
      claudeAiOauth: {
        accessToken: 'at', refreshToken: 'rt', expiresAt: 1, subscriptionType: 'pro',
      },
    }, '/tmp/x')
    expect(parsed!.credentials).toMatchObject({ accessToken: 'at', refreshToken: 'rt' })
    expect(await readClaudeCodeCredentials([path.join(os.tmpdir(), 'does-not-exist-' + Date.now())])).toBeUndefined()
  })
})
