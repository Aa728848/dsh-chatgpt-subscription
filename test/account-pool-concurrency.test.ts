import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  AccountPoolCore,
  type AccountPoolHooks,
  type PoolAccountInput,
  type PoolData,
} from '../src/host/common/account-pool.ts'
import type { PoolAccountSummaryDto } from '../src/shared/account-pool-contracts.ts'

class FinalRefreshError extends Error {}

interface ToyCredentials {
  access: string
  refresh: string
  expiresAt: number
  email: string
  accountId?: string
}

interface ToyAccount {
  id: string
  alias: string
  credentials: ToyCredentials
  addedAt: number
  lastUsedAt?: number
  isPrimary?: boolean
  cooldownUntil?: number
  cooldownReason?: string
  authStatus?: 'ok' | 'expired' | 'invalid'
  authFailedReason?: string
  email?: string
}

class MemoryBackend {
  public data: unknown = null
  public onSave?: (data: unknown) => Promise<void> | void
  public onLoad?: () => Promise<void> | void
  public failSave = false
  public failSavePredicate?: (data: unknown) => boolean

  async load() {
    await this.onLoad?.()
    return this.data === null ? null : JSON.parse(JSON.stringify(this.data))
  }

  async save(data: unknown) {
    if (this.failSave || this.failSavePredicate?.(data)) {
      throw new Error('MemoryBackend save failed')
    }
    await this.onSave?.(data)
    this.data = JSON.parse(JSON.stringify(data))
  }

  async clear() {
    this.data = null
  }
}

function createDeferred<T = void>() {
  let resolve!: (value?: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res as (value?: T | PromiseLike<T>) => void
    reject = rej
  })
  return { promise, resolve, reject }
}

function parseCredentials(value: unknown): ToyCredentials {
  if (typeof value !== 'object' || value === null) throw new Error('invalid credential payload')
  const record = value as Record<string, unknown>
  if (typeof record.access !== 'string' || typeof record.refresh !== 'string') {
    throw new Error('invalid credential tokens')
  }
  return {
    access: record.access,
    refresh: record.refresh,
    expiresAt: typeof record.expiresAt === 'number' ? record.expiresAt : 0,
    email: typeof record.email === 'string' ? record.email : '',
    ...(typeof record.accountId === 'string' ? { accountId: record.accountId } : {}),
  }
}

function parsePoolData(value: unknown): PoolData<ToyAccount> {
  if (typeof value !== 'object' || value === null) throw new Error('invalid pool payload')
  const record = value as Record<string, unknown>
  const accounts: ToyAccount[] = []
  for (const item of Array.isArray(record.accounts) ? record.accounts : []) {
    if (typeof item !== 'object' || item === null) continue
    const raw = item as Record<string, unknown>
    if (typeof raw.id !== 'string') continue
    const credentials = parseCredentials(raw.credentials)
    accounts.push({
      id: raw.id,
      alias: typeof raw.alias === 'string' ? raw.alias : '账号',
      credentials,
      addedAt: typeof raw.addedAt === 'number' ? raw.addedAt : Date.now(),
      email: typeof raw.email === 'string' ? raw.email : credentials.email,
      ...(typeof raw.lastUsedAt === 'number' ? { lastUsedAt: raw.lastUsedAt } : {}),
      ...(raw.isPrimary === true ? { isPrimary: true } : {}),
      ...(typeof raw.cooldownUntil === 'number' ? { cooldownUntil: raw.cooldownUntil } : {}),
      ...(typeof raw.cooldownReason === 'string' ? { cooldownReason: raw.cooldownReason } : {}),
      ...(raw.authStatus === 'expired' || raw.authStatus === 'invalid' ? { authStatus: raw.authStatus } : {}),
      ...(typeof raw.authFailedReason === 'string' ? { authFailedReason: raw.authFailedReason } : {}),
    })
  }
  return {
    version: 1,
    ...(typeof record.activeAccountId === 'string' ? { activeAccountId: record.activeAccountId } : {}),
    rotationStrategy: record.rotationStrategy === 'round-robin' || record.rotationStrategy === 'sticky'
      ? record.rotationStrategy
      : 'sequential',
    accounts,
  }
}

function makeCredential(n: number, expiresInMs = 3600_000, overrides: Partial<ToyCredentials> = {}): ToyCredentials {
  return {
    access: `access-${n}`,
    refresh: `refresh-${n}`,
    expiresAt: Date.now() + expiresInMs,
    email: `acc${n}@example.com`,
    ...overrides,
  }
}

let poolFileCounter = 0
function getNextPoolFile(): string {
  poolFileCounter += 1
  return `/tmp/concurrency-test-pool-${Date.now()}-${poolFileCounter}-${randomBytes(4).toString('hex')}.json`
}

function createHooks(
  backend: MemoryBackend,
  poolFile: string,
  overrides: Partial<AccountPoolHooks<ToyCredentials, ToyAccount, PoolAccountSummaryDto>> = {},
): AccountPoolHooks<ToyCredentials, ToyAccount, PoolAccountSummaryDto> {
  return {
    providerId: 'toy',
    displayName: 'Toy',
    poolFile,
    keychainService: 'dsh-toy-pool',
    parsePoolData,
    createAccount: ({ id, alias, credentials, addedAt, isPrimary }: PoolAccountInput<ToyCredentials, ToyAccount>) => ({
      id,
      alias,
      credentials,
      addedAt,
      isPrimary,
      email: credentials.email,
    }),
    dedupeKey: (credentials) => credentials.email || undefined,
    accountId: (credentials) => credentials.accountId || undefined,
    defaultAlias: (credentials, position) => credentials.email || `账号 ${position}`,
    expiresAt: (credentials) => credentials.expiresAt,
    backend: backend as never,
    refresh: async (credentials) => ({
      ...credentials,
      access: `refreshed-${credentials.access}`,
      expiresAt: Date.now() + 3600_000,
    }),
    refreshFailureStatus: (error) => (error instanceof FinalRefreshError ? 'expired' : undefined),
    liveCredentialsFor: async () => null,
    mirrorPrimary: async () => {},
    legacyAccount: async () => null,
    ...overrides,
  }
}

class TestableAccountPool extends AccountPoolCore<ToyCredentials, ToyAccount, PoolAccountSummaryDto> {
  public testUpdatePool<T>(
    mutate: (data: PoolData<ToyAccount>) => T | Promise<T>,
    afterCommit?: (data: PoolData<ToyAccount>, result: T) => Promise<void>,
  ): Promise<T> {
    return this.updatePool(mutate, afterCommit)
  }

  public testAddAccountToPool(data: PoolData<ToyAccount>, credentials: ToyCredentials, alias?: string): ToyAccount {
    return this.addAccountToPool(data, credentials, alias)
  }

  public testDeleteAccountFromPool(data: PoolData<ToyAccount>, accountId: string): void {
    this.deleteAccountFromPool(data, accountId)
  }
}

class CustomProviderAccountPool extends AccountPoolCore<ToyCredentials, ToyAccount, PoolAccountSummaryDto> {
  public addCalls = 0
  public deleteCalls = 0

  protected override addAccountToPool(
    data: PoolData<ToyAccount>,
    credentials: ToyCredentials,
    alias?: string,
  ): ToyAccount {
    if (credentials.email.endsWith('@forbidden.com')) {
      throw new Error('Forbidden provider domain')
    }
    const acc = super.addAccountToPool(data, credentials, alias)
    this.addCalls += 1
    return acc
  }

  protected override deleteAccountFromPool(data: PoolData<ToyAccount>, accountId: string): void {
    const target = data.accounts.find((a) => a.id === accountId)
    if (target?.alias === 'locked') {
      throw new Error('Cannot delete locked account')
    }
    super.deleteAccountFromPool(data, accountId)
    this.deleteCalls += 1
  }
}

describe('AccountPoolCore Concurrency and Transactions', () => {
  it('1. concurrent addAccount across two instances sharing the same poolFile does not lose accounts and maintains a single primary', async () => {
    const poolFile = getNextPoolFile()
    const backend = new MemoryBackend()
    const poolA = new AccountPoolCore(createHooks(backend, poolFile))
    const poolB = new AccountPoolCore(createHooks(backend, poolFile))

    await Promise.all([
      poolA.addAccount(makeCredential(1), 'Account A1'),
      poolB.addAccount(makeCredential(2), 'Account B1'),
      poolA.addAccount(makeCredential(3), 'Account A2'),
      poolB.addAccount(makeCredential(4), 'Account B2'),
    ])

    const dataA = await poolA.read()
    const dataB = await poolB.read()
    expect(dataA.accounts).toHaveLength(4)
    expect(dataB.accounts).toHaveLength(4)

    const emails = dataA.accounts.map((a) => a.credentials.email).sort()
    expect(emails).toEqual([
      'acc1@example.com',
      'acc2@example.com',
      'acc3@example.com',
      'acc4@example.com',
    ])

    const primariesA = dataA.accounts.filter((a) => a.isPrimary)
    const primariesB = dataB.accounts.filter((a) => a.isPrimary)
    expect(primariesA).toHaveLength(1)
    expect(primariesB).toHaveLength(1)
    expect(dataA.activeAccountId).toBe(primariesA[0]!.id)
    expect(dataB.activeAccountId).toBe(primariesA[0]!.id)
  })

  it('2. concurrent alias, cooldown, strategy, primary, and credential updates do not overwrite each other', async () => {
    const poolFile = getNextPoolFile()
    const backend = new MemoryBackend()
    const pool = new AccountPoolCore(createHooks(backend, poolFile))
    const a1 = await pool.addAccount(makeCredential(1), 'Original 1')
    const a2 = await pool.addAccount(makeCredential(2), 'Original 2')

    const updatedCreds1 = { ...a1.credentials, access: 'new-token-1' }

    await Promise.all([
      pool.setAlias(a1.id, 'Renamed 1'),
      pool.markCooldown(a1.id, 60_000, '429 Rate Limit'),
      pool.setStrategy('round-robin'),
      pool.setPrimary(a2.id),
      pool.updateAccountCredentials(a1.id, updatedCreds1, a1.credentials),
    ])

    const data = await pool.read()
    const acc1 = data.accounts.find((a) => a.id === a1.id)!
    const acc2 = data.accounts.find((a) => a.id === a2.id)!

    expect(acc1.alias).toBe('Renamed 1')
    expect(acc1.cooldownReason).toBe('429 Rate Limit')
    expect(acc1.cooldownUntil).toBeGreaterThan(Date.now())
    expect(data.rotationStrategy).toBe('round-robin')
    expect(acc2.isPrimary).toBe(true)
    expect(acc1.isPrimary ?? false).toBe(false)
    expect(data.activeAccountId).toBe(a2.id)
    expect(acc1.credentials.access).toBe('new-token-1')
  })

  it('3. interleaved refreshes for different accounts preserve both rotated tokens', async () => {
    const poolFile = getNextPoolFile()
    const backend = new MemoryBackend()

    const startedA = createDeferred()
    const startedB = createDeferred()
    const releaseA = createDeferred()
    const releaseB = createDeferred()

    const hooksA = createHooks(backend, poolFile, {
      refresh: async (creds) => {
        if (creds.email === 'acc1@example.com') {
          startedA.resolve()
          await releaseA.promise
          return { ...creds, access: 'refreshed-access-1', expiresAt: Date.now() + 3600_000 }
        }
        if (creds.email === 'acc2@example.com') {
          startedB.resolve()
          await releaseB.promise
          return { ...creds, access: 'refreshed-access-2', expiresAt: Date.now() + 3600_000 }
        }
        return creds
      },
    })
    const hooksB = createHooks(backend, poolFile, {
      refresh: hooksA.refresh,
    })

    const poolA = new AccountPoolCore(hooksA)
    const poolB = new AccountPoolCore(hooksB)

    const a1 = await poolA.addAccount(makeCredential(1, 0), 'A1')
    const a2 = await poolB.addAccount(makeCredential(2, 0), 'A2')

    const promiseA = poolA.getFreshCredential(a1.id)
    const promiseB = poolB.getFreshCredential(a2.id)

    await startedA.promise
    await startedB.promise

    // Release B first, verifying B commits to the pool while A is suspended
    releaseB.resolve()
    const resB = await promiseB

    // Release A next, verifying A does not overwrite B's committed credentials
    releaseA.resolve()
    const resA = await promiseA

    expect(resA.access).toBe('refreshed-access-1')
    expect(resB.access).toBe('refreshed-access-2')

    const data = await poolA.read()
    const stored1 = data.accounts.find((a) => a.id === a1.id)!
    const stored2 = data.accounts.find((a) => a.id === a2.id)!

    expect(stored1.credentials.access).toBe('refreshed-access-1')
    expect(stored2.credentials.access).toBe('refreshed-access-2')
  })

  it('4. concurrent routing, tool, and forced renewal for the same expired account triggers hooks.refresh exactly once', async () => {
    const poolFile = getNextPoolFile()
    const backend = new MemoryBackend()
    let refreshCalls = 0
    const refreshStarted = createDeferred()
    const releaseRefresh = createDeferred()

    const pool = new AccountPoolCore(
      createHooks(backend, poolFile, {
        refresh: async (creds) => {
          refreshCalls += 1
          refreshStarted.resolve()
          await releaseRefresh.promise
          return { ...creds, access: 'single-flight-refreshed', expiresAt: Date.now() + 3600_000 }
        },
      }),
    )

    const a1 = await pool.addAccount(makeCredential(1, 0), 'Expiring Account')

    const pRouting = pool.getEffectiveAccount()
    const pTool = pool.getCredentialAccount()
    const pRenew = pool.renewCredential(a1.id)

    await refreshStarted.promise
    releaseRefresh.resolve()

    const [resRouting, resTool, resRenew] = await Promise.all([pRouting, pTool, pRenew])

    expect(refreshCalls).toBe(1)
    expect(resRouting.credentials.access).toBe('single-flight-refreshed')
    expect(resTool.credentials.access).toBe('single-flight-refreshed')
    expect(resRenew.access).toBe('single-flight-refreshed')
  })

  it('5. deleting an account during refresh does not resurrect it and getEffectiveAccount fails over to another eligible account', async () => {
    const poolFile = getNextPoolFile()
    const backend = new MemoryBackend()
    const refreshStarted = createDeferred()
    const releaseRefresh = createDeferred()

    const pool = new AccountPoolCore(
      createHooks(backend, poolFile, {
        refresh: async (creds) => {
          if (creds.email === 'acc1@example.com') {
            refreshStarted.resolve()
            await releaseRefresh.promise
            return { ...creds, access: 'refreshed-access-1', expiresAt: Date.now() + 3600_000 }
          }
          return creds
        },
      }),
    )

    const a1 = await pool.addAccount(makeCredential(1, 0), 'Account 1')
    const a2 = await pool.addAccount(makeCredential(2, 3600_000), 'Account 2')
    await pool.setPrimary(a1.id)

    const routingPromise = pool.getEffectiveAccount()

    await refreshStarted.promise

    // Delete a1 while its refresh is in flight
    await pool.deleteAccount(a1.id)

    const midData = await pool.read()
    expect(midData.accounts.map((a) => a.id)).toEqual([a2.id])

    // Allow a1's refresh to settle
    releaseRefresh.resolve()

    const result = await routingPromise
    expect(result.account.id).toBe(a2.id)

    const finalData = await pool.read()
    expect(finalData.accounts).toHaveLength(1)
    expect(finalData.accounts[0]!.id).toBe(a2.id)
  })

  it('6. re-login during refresh neither overwrites new pool credentials nor returns the stale refresh result', async () => {
    const poolFile = getNextPoolFile()
    const backend = new MemoryBackend()
    const refreshStarted = createDeferred()
    const releaseRefresh = createDeferred()

    const pool = new AccountPoolCore(
      createHooks(backend, poolFile, {
        refresh: async (creds) => {
          refreshStarted.resolve()
          await releaseRefresh.promise
          return { ...creds, access: 'stale-refresh-access', expiresAt: Date.now() + 3600_000 }
        },
      }),
    )

    const initialCreds = makeCredential(1, 0)
    const a1 = await pool.addAccount(initialCreds, 'Account 1')

    const freshPromise = pool.getFreshCredential(a1.id)

    await refreshStarted.promise

    // User re-authenticates with new tokens while refresh is in flight
    const reLoginCreds = {
      ...initialCreds,
      access: 'new-login-access',
      refresh: 'new-login-refresh',
      expiresAt: Date.now() + 7200_000,
    }
    await pool.addAccount(reLoginCreds)

    // Old refresh finishes
    releaseRefresh.resolve()

    const returnedCred = await freshPromise

    // Returned credentials match the re-authenticated credentials
    expect(returnedCred.access).toBe('new-login-access')

    // Stored credentials on disk are not overwritten by stale refresh
    const data = await pool.read()
    const stored = data.accounts.find((a) => a.id === a1.id)!
    expect(stored.credentials.access).toBe('new-login-access')
    expect(stored.credentials.refresh).toBe('new-login-refresh')
  })

  it('7. final failure of an older refresh does not mark a re-authenticated account as invalid', async () => {
    const poolFile = getNextPoolFile()
    const backend = new MemoryBackend()
    const refreshStarted = createDeferred()
    const releaseRefresh = createDeferred()

    const pool = new AccountPoolCore(
      createHooks(backend, poolFile, {
        refreshFailureStatus: (err) => (err instanceof FinalRefreshError ? 'expired' : undefined),
        refresh: async () => {
          refreshStarted.resolve()
          await releaseRefresh.promise
          throw new FinalRefreshError('token revoked')
        },
      }),
    )

    const initialCreds = makeCredential(1, 0)
    const a1 = await pool.addAccount(initialCreds, 'Account 1')

    const freshPromise = pool.getFreshCredential(a1.id)

    await refreshStarted.promise

    // Re-login before the failing refresh settles
    const reLoginCreds = {
      ...initialCreds,
      access: 're-login-token',
      refresh: 're-login-refresh',
      expiresAt: Date.now() + 3600_000,
    }
    await pool.addAccount(reLoginCreds)

    // Old refresh rejects with final error
    releaseRefresh.resolve()

    const cred = await freshPromise
    expect(cred.access).toBe('re-login-token')

    const data = await pool.read()
    const stored = data.accounts.find((a) => a.id === a1.id)!
    expect(stored.authStatus).toBeUndefined()
    expect(stored.authFailedReason).toBeUndefined()
    expect(stored.credentials.access).toBe('re-login-token')
  })

  it('8. flight is cleared after refresh failure allowing retry, and transient failure does not disable account', async () => {
    const poolFile = getNextPoolFile()
    const backend = new MemoryBackend()
    let shouldFail = true
    let attempts = 0

    const pool = new AccountPoolCore(
      createHooks(backend, poolFile, {
        refreshFailureStatus: () => undefined,
        refresh: async (creds) => {
          attempts += 1
          if (shouldFail) {
            throw new Error('Transient 503 Service Unavailable')
          }
          return { ...creds, access: 'recovered-access', expiresAt: Date.now() + 3600_000 }
        },
      }),
    )

    const a1 = await pool.addAccount(makeCredential(1, 0), 'Account 1')

    // First call fails
    await expect(pool.getFreshCredential(a1.id)).rejects.toThrow('Transient 503 Service Unavailable')
    expect(attempts).toBe(1)

    // Verify account is not disabled in pool
    const dataMid = await pool.read()
    const storedMid = dataMid.accounts.find((a) => a.id === a1.id)!
    expect(storedMid.authStatus).toBeUndefined()

    // Flight has been cleared: second call retries and succeeds
    shouldFail = false
    const recovered = await pool.getFreshCredential(a1.id)
    expect(attempts).toBe(2)
    expect(recovered.access).toBe('recovered-access')

    const dataFinal = await pool.read()
    const storedFinal = dataFinal.accounts.find((a) => a.id === a1.id)!
    expect(storedFinal.credentials.access).toBe('recovered-access')
  })

  it('9. token persistence is strict (getFreshCredential throws on backend.save failure), while bookkeeping failure does not block serving', async () => {
    const poolFile = getNextPoolFile()
    const backend = new MemoryBackend()

    const pool = new AccountPoolCore(
      createHooks(backend, poolFile, {
        refresh: async (creds) => ({
          ...creds,
          access: 'new-refreshed-token',
          expiresAt: Date.now() + 3600_000,
        }),
      }),
    )

    const a1 = await pool.addAccount(makeCredential(1, 0), 'Expiring Account')

    // 9A: When saving the rotated token fails, getFreshCredential strictly throws
    backend.failSave = true
    await expect(pool.getFreshCredential(a1.id)).rejects.toThrow('MemoryBackend save failed')
    backend.failSave = false

    // 9B: For an already-fresh account, getEffectiveAccount bookkeeping write failure does not block serving
    const a2 = await pool.addAccount(makeCredential(2, 3600_000), 'Fresh Account')
    await pool.setPrimary(a2.id)

    backend.failSave = true
    const effective = await pool.getEffectiveAccount()
    expect(effective.account.id).toBe(a2.id)
    expect(effective.credentials.access).toBe(a2.credentials.access)

    // In contrast, explicit user actions like markCooldown fail strictly under save failure
    await expect(pool.markCooldown(a2.id, 60_000, '429')).rejects.toThrow('MemoryBackend save failed')
  })

  it('10. mirrorPrimary runs in commit order so a slow older mirror cannot overwrite newer primary credentials, and identity revision is shared across instances', async () => {
    const poolFile = getNextPoolFile()
    const backend = new MemoryBackend()

    const mirroredHistory: Array<string | null> = []
    let slowMirrorBarrier: ReturnType<typeof createDeferred> | null = null

    const poolA = new AccountPoolCore(
      createHooks(backend, poolFile, {
        mirrorPrimary: async (creds) => {
          if (slowMirrorBarrier) {
            await slowMirrorBarrier.promise
          }
          mirroredHistory.push(creds?.access ?? null)
        },
      }),
    )
    const poolB = new AccountPoolCore(
      createHooks(backend, poolFile, {
        mirrorPrimary: poolA['hooks'].mirrorPrimary,
      }),
    )

    const a1 = await poolA.addAccount(makeCredential(1), 'Account 1')
    const a2 = await poolB.addAccount(makeCredential(2), 'Account 2')
    const a3 = await poolA.addAccount(makeCredential(3), 'Account 3')

    // Initial state: a1 is primary
    mirroredHistory.length = 0

    // 10A: Commit ordering prevents slow mirror from overwriting newer primary
    // Transition 1: a1 -> a2 (triggers mirrorPrimary with access-2)
    // Transition 2: a2 -> a3 (triggers mirrorPrimary with access-3)
    slowMirrorBarrier = createDeferred()

    const p1 = poolA.setPrimary(a2.id)
    const p2 = poolB.setPrimary(a3.id)

    expect(mirroredHistory).toHaveLength(0)

    slowMirrorBarrier.resolve()
    slowMirrorBarrier = null

    await Promise.all([p1, p2])

    expect(mirroredHistory).toEqual([a2.credentials.access, a3.credentials.access])
    expect(mirroredHistory.at(-1)).toBe(a3.credentials.access)

    // 10B: Identity revision is shared across instances for the same poolFile
    const revA0 = poolA.currentIdentityRevision()
    const revB0 = poolB.currentIdentityRevision()
    expect(revA0).toBe(revB0)

    await poolA.setAlias(a1.id, 'Brand New Alias')

    const revA1 = poolA.currentIdentityRevision()
    const revB1 = poolB.currentIdentityRevision()
    expect(revA1).toBe(revA0 + 1)
    expect(revB1).toBe(revA1)
  })

  it('11. an explicitly empty pool does not resurrect deleted accounts via legacyAccount projection', async () => {
    const poolFile = getNextPoolFile()
    const backend = new MemoryBackend()
    let legacyStore: ToyCredentials | null = makeCredential(1)

    const pool = new AccountPoolCore(
      createHooks(backend, poolFile, {
        legacyAccount: async () => {
          if (!legacyStore) return null
          return {
            id: 'acc_primary',
            alias: 'Legacy Primary',
            credentials: legacyStore,
            addedAt: Date.now(),
            isPrimary: true,
          }
        },
        mirrorPrimary: async (creds) => {
          legacyStore = creds
        },
      }),
    )

    // Initially uninitialized pool file projects legacy account
    const init = await pool.read()
    expect(init.accounts).toHaveLength(1)
    expect(init.accounts[0]!.id).toBe('acc_primary')

    // Adding account commits it to the pool
    const added = await pool.addAccount(legacyStore)
    expect(added.id).toBe('acc_primary')

    // Deleting the account commits the empty pool and awaits mirrorPrimary(null)
    await pool.deleteAccount('acc_primary')

    // Legacy store was cleared in-lock by mirrorPrimary(null)
    expect(legacyStore).toBeNull()

    // Subsequent read on the explicitly empty pool does not resurrect the deleted account
    const afterDelete = await pool.read()
    expect(afterDelete.accounts).toHaveLength(0)

    const summaries = await pool.listAccounts()
    expect(summaries).toHaveLength(0)
  })

  describe('Kernel APIs and Subclass Hooks', () => {
    it('updateAccountCredentials supports conditional write via expected parameter', async () => {
      const poolFile = getNextPoolFile()
      const backend = new MemoryBackend()
      const pool = new AccountPoolCore(createHooks(backend, poolFile))

      const cred1 = makeCredential(1)
      const acc = await pool.addAccount(cred1, 'Account 1')

      // Case A: expected matches current credentials -> update succeeds
      const credUpdated = { ...cred1, access: 'access-1-v2' }
      const res1 = await pool.updateAccountCredentials(acc.id, credUpdated, cred1)
      expect(res1?.credentials.access).toBe('access-1-v2')

      const data1 = await pool.read()
      expect(data1.accounts[0]!.credentials.access).toBe('access-1-v2')

      // Case B: expected is stale (mismatches current credentials) -> write skipped, returns current
      const staleCred = cred1
      const res2 = await pool.updateAccountCredentials(acc.id, { ...cred1, access: 'access-1-stale' }, staleCred)
      expect(res2?.credentials.access).toBe('access-1-v2')

      const data2 = await pool.read()
      expect(data2.accounts[0]!.credentials.access).toBe('access-1-v2')

      // Case C: non-existent account -> returns undefined
      const res3 = await pool.updateAccountCredentials('non_existent', credUpdated)
      expect(res3).toBeUndefined()
    })

    it('subclass can override addAccountToPool and deleteAccountFromPool', async () => {
      const poolFile = getNextPoolFile()
      const backend = new MemoryBackend()
      const pool = new CustomProviderAccountPool(createHooks(backend, poolFile))

      // addAccountToPool override refuses forbidden domain
      await expect(
        pool.addAccount(makeCredential(1, 3600_000, { email: 'user@forbidden.com' })),
      ).rejects.toThrow('Forbidden provider domain')
      expect(pool.addCalls).toBe(0)

      // addAccountToPool override allows valid domain
      const acc1 = await pool.addAccount(makeCredential(2), 'Normal')
      expect(pool.addCalls).toBe(1)

      const accLocked = await pool.addAccount(makeCredential(3), 'locked')
      expect(pool.addCalls).toBe(2)

      // deleteAccountFromPool override refuses locked account
      await expect(pool.deleteAccount(accLocked.id)).rejects.toThrow('Cannot delete locked account')
      expect(pool.deleteCalls).toBe(0)

      // deleteAccountFromPool override allows normal account
      await pool.deleteAccount(acc1.id)
      expect(pool.deleteCalls).toBe(1)
    })

    it('updatePool executes in-lock transactions with afterCommit callback and public read/write work', async () => {
      const poolFile = getNextPoolFile()
      const backend = new MemoryBackend()
      const pool = new TestableAccountPool(createHooks(backend, poolFile))

      let afterCommitExecuted = false
      let committedAccountsCount = 0

      const result = await pool.testUpdatePool(
        (data) => {
          pool.testAddAccountToPool(data, makeCredential(1), 'Account In Mutate')
          return 'mutate-ok'
        },
        async (data, res) => {
          afterCommitExecuted = true
          committedAccountsCount = data.accounts.length
          expect(res).toBe('mutate-ok')
        },
      )

      expect(result).toBe('mutate-ok')
      expect(afterCommitExecuted).toBe(true)
      expect(committedAccountsCount).toBe(1)

      // Public read and write methods remain operational
      const readData = await pool.read()
      expect(readData.accounts).toHaveLength(1)

      readData.accounts[0]!.alias = 'Updated Via Write'
      await pool.write(readData)

      const reReadData = await pool.read()
      expect(reReadData.accounts[0]!.alias).toBe('Updated Via Write')
    })
  })
})
