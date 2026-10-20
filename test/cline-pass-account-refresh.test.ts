/**
 * OAuth sessions through the shared pool: an expired access token refreshes and
 * is persisted, while a rejected grant marks the account instead of logging in
 * again silently.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { ClinePassAccountPool } from '../src/host/cline-pass/account-pool.ts'
import { FileCredentialStore, type ClinePassCredentials } from '../src/host/cline-pass/token-store.ts'

class MemoryBackend<T> {
  private data: unknown = null
  async load(): Promise<T | null> {
    return this.data === null ? null : JSON.parse(JSON.stringify(this.data)) as T
  }
  async save(data: T): Promise<void> {
    this.data = JSON.parse(JSON.stringify(data))
  }
  async clear(): Promise<void> {
    this.data = null
  }
}

let dir = ''
let pool: ClinePassAccountPool

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cline-pass-refresh-'))
  const store = new FileCredentialStore(path.join(dir, 'credentials.json'), new MemoryBackend<ClinePassCredentials>() as never)
  pool = new ClinePassAccountPool({ store, backend: new MemoryBackend() as never })
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

describe('Cline Pass OAuth refresh', () => {
  it('refreshes an expired session and persists the rotated tokens', async () => {
    const account = await pool.addAccount({
      kind: 'oauth',
      access: 'old-access',
      refresh: 'old-refresh',
      expires: Date.now() - 1_000,
      accountId: 'user-1',
      email: 'user@example.com',
    }, 'user@example.com')
    const fetchFn = vi.fn(async () => Response.json({
      success: true,
      data: {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        userInfo: { email: 'user@example.com', clineUserId: 'user-1' },
      },
    })) as unknown as typeof fetch
    const effective = await pool.getEffectiveCredential(new Set(), fetchFn)
    expect(effective.account.id).toBe(account.id)
    expect(effective.credentials).toMatchObject({ access: 'new-access', refresh: 'new-refresh' })
    const stored = await pool.read()
    expect(stored.accounts[0]?.credentials).toMatchObject({ access: 'new-access', refresh: 'new-refresh' })
    expect(stored.accounts[0]?.authStatus).toBeUndefined()
  })

  it('marks the account invalid when the refresh token is rejected', async () => {
    await pool.addAccount({
      kind: 'oauth',
      access: 'old-access',
      refresh: 'dead-refresh',
      expires: Date.now() - 1_000,
      accountId: 'user-2',
    })
    const fetchFn = vi.fn(async () => Response.json({ success: false, data: { code: 'invalid_grant', message: 'invalid grant' } }, { status: 401 })) as unknown as typeof fetch
    await expect(pool.getEffectiveAccount(new Set(), fetchFn)).rejects.toMatchObject({ code: 'AUTH' })
    const accounts = await pool.listAccounts()
    expect(accounts[0]?.authStatus).toBe('invalid')
    expect(accounts[0]?.authFailedReason).toContain('401')
  })

  it('leaves a static API key alone: no expiry, no refresh call', async () => {
    await pool.addAccount({ apiKey: 'sk-static' })
    const fetchFn = vi.fn(async () => { throw new Error('must not refresh') }) as unknown as typeof fetch
    const effective = await pool.getEffectiveCredential(new Set(), fetchFn)
    expect(effective.credentials).toMatchObject({ apiKey: 'sk-static' })
    expect(fetchFn).not.toHaveBeenCalled()
    expect((await pool.listAccounts())[0]?.expiresAt).toBeUndefined()
  })
})
