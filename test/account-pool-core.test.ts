import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  AccountPoolCore,
  DEFAULT_MAX_POOL_ACCOUNTS,
  POOL_REFRESH_MARGIN_MS,
  type AccountPoolHooks,
} from '../src/host/common/account-pool.ts'
import type { PoolAccountSummaryDto } from '../src/shared/account-pool-contracts.ts'

class FinalRefreshError extends Error {}

interface ToyCredentials {
  access: string
  refresh: string
  expiresAt: number
  email: string
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
  private data: unknown = null
  async load() { return this.data === null ? null : JSON.parse(JSON.stringify(this.data)) }
  async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
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
  }
}

function parsePoolData(value: unknown): { version: 1; activeAccountId?: string; rotationStrategy: 'sequential' | 'round-robin' | 'sticky'; accounts: ToyAccount[] } {
  if (typeof value !== 'object' || value === null) throw new Error('invalid pool payload')
  const record = value as Record<string, unknown>
  const accounts: ToyAccount[] = []
  for (const item of Array.isArray(record.accounts) ? record.accounts : []) {
    if (typeof item !== 'object' || item === null) continue
    const raw = item as Record<string, unknown>
    if (typeof raw.id !== 'string') continue
    accounts.push({
      id: raw.id,
      alias: typeof raw.alias === 'string' ? raw.alias : '账号',
      credentials: parseCredentials(raw.credentials),
      addedAt: typeof raw.addedAt === 'number' ? raw.addedAt : Date.now(),
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

function makeCredential(n: number, expiresInMs = 3600_000): ToyCredentials {
  return { access: `access-${n}`, refresh: `refresh-${n}`, expiresAt: Date.now() + expiresInMs, email: `acc${n}@example.com` }
}

describe('AccountPoolCore', () => {
  let backend: MemoryBackend
  let refreshCalls: ToyCredentials[]
  let mirrored: Array<ToyCredentials | null>
  let legacy: ToyAccount | null

  const build = (
    overrides: Partial<AccountPoolHooks<ToyCredentials, ToyAccount, PoolAccountSummaryDto>> = {},
  ) => new AccountPoolCore<ToyCredentials, ToyAccount, PoolAccountSummaryDto>({
    providerId: 'toy',
    displayName: 'Toy',
    poolFile: '/tmp/toy-pool.json',
    keychainService: 'dsh-toy-pool',
    parsePoolData,
    createAccount: ({ id, alias, credentials, addedAt, isPrimary }) => ({
      id,
      alias,
      credentials,
      addedAt,
      isPrimary,
      email: credentials.email,
    }),
    dedupeKey: (credentials) => credentials.email || undefined,
    defaultAlias: (credentials, position) => credentials.email || `账号 ${position}`,
    expiresAt: (credentials) => credentials.expiresAt,
    extendSummary: (account, base) => ({ ...base, email: account.email ?? account.credentials.email }),
    refresh: async (credentials) => {
      refreshCalls.push(credentials)
      return { ...credentials, access: `refreshed-${credentials.access}`, expiresAt: Date.now() + 3600_000 }
    },
    legacyAccount: async () => legacy,
    mirrorPrimary: async (credentials) => { mirrored.push(credentials) },
    backend: backend as never,
    ...overrides,
  })

  beforeEach(() => {
    backend = new MemoryBackend()
    refreshCalls = []
    mirrored = []
    legacy = null
  })

  it('projects the pre-pool single credential as primary without writing on read', async () => {
    legacy = {
      id: 'acc_primary',
      alias: '主账号',
      credentials: makeCredential(1),
      addedAt: Date.now(),
      isPrimary: true,
    }
    const save = vi.spyOn(backend, 'save')
    const pool = build()
    const data = await pool.read()
    expect(data.accounts).toHaveLength(1)
    expect(data.accounts[0]!.isPrimary).toBe(true)
    expect(data.activeAccountId).toBe('acc_primary')
    expect(save).not.toHaveBeenCalled()
    const summaries = await pool.listAccounts()
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.email).toBe('acc1@example.com')
  })

  it('adds accounts, dedupes by identity and promotes the first one', async () => {
    const pool = build()
    const first = await pool.addAccount(makeCredential(1))
    const second = await pool.addAccount(makeCredential(2), '备用')
    expect(first.isPrimary).toBe(true)
    expect(second.isPrimary).toBe(false)
    expect(mirrored[0]?.email).toBe('acc1@example.com')

    // Same upstream identity replaces the record in place, keeping id and primary flag.
    const replaced = await pool.addAccount(makeCredential(2), '备用号')
    expect(replaced.id).toBe(second.id)
    expect(replaced.isPrimary).toBe(false)
    const data = await pool.read()
    expect(data.accounts).toHaveLength(2)
    expect(data.accounts[1]!.alias).toBe('备用号')
  })

  it('refuses more accounts than the pool limit allows', async () => {
    const pool = build({ maxAccounts: 2 })
    await pool.addAccount(makeCredential(1))
    await pool.addAccount(makeCredential(2))
    await expect(pool.addAccount(makeCredential(3))).rejects.toThrow(/最多支持 2 个账号/)
    expect(DEFAULT_MAX_POOL_ACCOUNTS).toBe(20)
  })

  it('sequential prefers the primary, fails over on cooldown, round-robin uses the LRU account', async () => {
    const pool = build()
    const a1 = await pool.addAccount(makeCredential(1), '账号1')
    const a2 = await pool.addAccount(makeCredential(2), '账号2')
    await pool.setPrimary(a1.id)

    expect((await pool.getEffectiveAccount()).account.id).toBe(a1.id)

    await pool.markCooldown(a1.id, 600_000, '429 Rate Limit')
    expect((await pool.getEffectiveAccount()).account.id).toBe(a2.id)
    // The 429 was clamped to at least the minimum cooldown.
    const cooling = (await pool.listAccounts()).find((account) => account.id === a1.id)
    expect(cooling?.cooldownUntil).toBeGreaterThan(Date.now())
    expect(cooling?.cooldownReason).toBe('429 Rate Limit')

    await pool.clearCooldown(a1.id)
    await pool.setStrategy('round-robin')
    expect((await pool.getEffectiveAccount()).account.id).toBe(a1.id)
  })

  it('sticky keeps the account that served the previous request', async () => {
    const pool = build()
    const a1 = await pool.addAccount(makeCredential(1), '账号1')
    const a2 = await pool.addAccount(makeCredential(2), '账号2')
    await pool.setPrimary(a2.id)
    await pool.setStrategy('sticky')

    // a2 is primary, so it wins the first pick and becomes active.
    expect((await pool.getEffectiveAccount()).account.id).toBe(a2.id)
    // Cooldown the primary: sticky falls through to the other eligible account.
    await pool.markCooldown(a2.id, 600_000, '429')
    expect((await pool.getEffectiveAccount()).account.id).toBe(a1.id)
    // Once the primary is eligible again, sticky still keeps the active account:
    // that is what protects an upstream prefix cache across one conversation.
    await pool.clearCooldown(a2.id)
    expect((await pool.getEffectiveAccount()).account.id).toBe(a1.id)
    // Promoting another account changes which one sticky holds on to.
    await pool.setPrimary(a2.id)
    await pool.setStrategy('sequential')
    expect((await pool.getEffectiveAccount()).account.id).toBe(a2.id)
  })

  it('raises a RATE_LIMIT error naming the provider when every account is cooling down', async () => {
    const pool = build()
    const a1 = await pool.addAccount(makeCredential(1), '账号1')
    await pool.markCooldown(a1.id, 600_000, 'Quota Exhausted')
    const failure = await pool.getEffectiveAccount().then(
      () => undefined,
      (error: unknown) => error as { code?: string; failure?: { status?: number }; message: string },
    )
    expect(failure?.code).toBe('RATE_LIMIT')
    expect(failure?.failure?.status).toBe(429)
    expect(failure?.message).toMatch(/全部 1 个 Toy 账号均处于配额限制或冷却中/)
  })

  it('keeps a failed account in the pool but out of rotation, and restores it on sign-in', async () => {
    const pool = build()
    const a1 = await pool.addAccount(makeCredential(1), '账号1')
    const a2 = await pool.addAccount(makeCredential(2), '账号2')
    await pool.setPrimary(a1.id)

    await pool.markAuthFailed(a1.id, 'Refresh token rejected')
    let accounts = await pool.listAccounts()
    const failed = accounts.find((account) => account.id === a1.id)
    expect(failed?.authStatus).toBe('expired')
    expect(failed?.authFailedReason).toBe('Refresh token rejected')
    expect((await pool.getEffectiveAccount()).account.id).toBe(a2.id)

    // Signing in again clears the failure; the cooldown marker is untouched.
    const restored = await pool.addAccount(makeCredential(1))
    expect(restored.id).toBe(a1.id)
    accounts = await pool.listAccounts()
    expect(accounts.find((account) => account.id === a1.id)?.authStatus).toBeUndefined()
  })

  it('refreshes an expiring credential and writes it back into the pool', async () => {
    const pool = build()
    await pool.addAccount(makeCredential(1, 10_000), '账号1')
    const { credentials } = await pool.getEffectiveAccount()
    expect(credentials.access).toBe('refreshed-access-1')
    expect(refreshCalls).toHaveLength(1)
    const stored = (await pool.read()).accounts[0]!
    expect(stored.credentials.access).toBe('refreshed-access-1')
    // The primary mirror follows the refreshed credential.
    expect(mirrored.at(-1)?.access).toBe('refreshed-access-1')
    expect(POOL_REFRESH_MARGIN_MS).toBe(60_000)
  })

  it('marks an account whose refresh is final and serves the request from another one', async () => {
    const pool = build({
      // The provider classifies a rejected refresh token; the core owns the marking.
      refreshFailureStatus: (error) => (error instanceof FinalRefreshError ? 'expired' : undefined),
      refresh: async () => { throw new FinalRefreshError('refresh token rejected') },
    })
    const dead = await pool.addAccount(makeCredential(1, 0), '账号1')
    const healthy = await pool.addAccount(makeCredential(2), '账号2')
    await pool.setPrimary(dead.id)

    const { account } = await pool.getEffectiveAccount()
    expect(account.id).toBe(healthy.id)
    // The failed account is kept and marked, not deleted.
    const marked = (await pool.listAccounts()).find((entry) => entry.id === dead.id)
    expect(marked).toMatchObject({ authStatus: 'expired', authFailedReason: 'refresh token rejected' })
  })

  it('still hands out a credential when only the bookkeeping write fails', async () => {
    const pool = build()
    const account = await pool.addAccount(makeCredential(1), '账号1')
    // The pool file becomes unwritable: a locked replace, a wedged helper.
    const failing = new MemoryBackend()
    vi.spyOn(failing, 'load').mockImplementation(async () => JSON.parse(JSON.stringify(await backend.load())))
    vi.spyOn(failing, 'save').mockRejectedValue(new Error('DPAPI credential write failed'))
    const degraded = build({ backend: failing as never })

    const effective = await degraded.getEffectiveAccount()
    expect(effective.account.id).toBe(account.id)
    expect(effective.credentials.access).toBe('access-1')

    // Writes that express a user's intent stay strict: a silently dropped
    // cooldown would put a rate-limited account straight back into rotation.
    await expect(degraded.markCooldown(account.id, 60_000, '429')).rejects.toThrow()
  })

  it('reports a provider description of where credentials live', () => {
    const pool = build()
    expect(pool.path()).toMatch(/toy-pool\.json/)
  })

  it('deletes an account, promoting the next one and clearing the mirror when empty', async () => {
    const pool = build()
    const a1 = await pool.addAccount(makeCredential(1), '账号1')
    const a2 = await pool.addAccount(makeCredential(2), '账号2')
    await pool.setPrimary(a1.id)
    await pool.deleteAccount(a1.id)
    const accounts = await pool.listAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.id).toBe(a2.id)
    expect(accounts[0]!.isPrimary).toBe(true)
    await pool.deleteAccount(a2.id)
    expect(await pool.listAccounts()).toHaveLength(0)
    expect(mirrored.at(-1)).toBeNull()
  })
})
