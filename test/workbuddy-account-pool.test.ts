import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createUserMessage, LlmError, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { WorkBuddyAdapter } from '../src/host/workbuddy/adapter.ts'
import type { WorkBuddyModelEntry } from '../src/host/workbuddy/model-catalog.ts'
import {
  WORKBUDDY_POOL_PAUSE_MS,
  WORKBUDDY_POOL_PAUSED_CODE,
  WORKBUDDY_RESTRICTION_ESCALATION_WINDOW_MS,
  WorkBuddyAccountPool,
  WorkBuddyPoolPausedError,
  parseWorkBuddyPoolData,
  workBuddyPoolPath,
} from '../src/host/workbuddy/account-pool.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  workBuddyAccountId,
  type WorkBuddyCredentials,
} from '../src/host/workbuddy/token-store.ts'
import { createWorkBuddyStore } from './support/workbuddy-fixtures.ts'
import { clearCachedCatalog, clearCachedQuota } from '../src/host/workbuddy/client.ts'

const temporaryDirs: string[] = []

function createDeferred<T = void>() {
  let resolve!: (value?: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res as (value?: T | PromiseLike<T>) => void
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Build an unsigned JWT-shaped token carrying the claims under test. */
function jwtToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}.signature`
}

afterEach(async () => {
  clearCachedQuota()
  clearCachedCatalog()
  for (const dir of temporaryDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

/** Mirrors the platform backends: JSON on disk, and the parse hook on read. */
class PoolBackend {
  private data: unknown = null
  constructor(private readonly parse: (value: unknown) => unknown) {}
  async load() { return this.data === null ? null : this.parse(JSON.parse(JSON.stringify(this.data))) }
  async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}


/** One credential file in the IDE's own auth directory. */
function desktopFile(options: {
  uid: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  domain?: string
}): unknown {
  return {
    account: { uid: options.uid, nickname: options.uid, uin: `1000000000${options.uid.slice(-1)}`, type: 'personal' },
    auth: {
      accessToken: options.accessToken ?? `at-${options.uid}`,
      refreshToken: options.refreshToken ?? `rt-${options.uid}`,
      expiresAt: options.expiresAt ?? Date.now() + 3_600_000,
      domain: options.domain ?? 'copilot.tencent.com',
    },
  }
}

async function makeAuthDir(files: Record<string, unknown>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-pool-auth-'))
  temporaryDirs.push(dir)
  for (const [name, value] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), JSON.stringify(value), 'utf8')
  }
  return dir
}

function makePool(store: FileCredentialStore, extra: { selection?: () => { selectedAccountId: string | null; hiddenAccountIds: readonly string[] } } = {}) {
  const backend = new PoolBackend(parseWorkBuddyPoolData)
  const pool = new WorkBuddyAccountPool({
    store,
    backend: backend as never,
    ...(extra.selection === undefined ? {} : { selection: extra.selection }),
  })
  return { pool, backend }
}

describe('WorkBuddy pool document parsing', () => {
  it('round-trips accounts and drops rows with no usable credential', () => {
    const parsed = parseWorkBuddyPoolData({
      version: 1,
      rotationStrategy: 'sticky',
      activeAccountId: 'cn:u1',
      accounts: [
        {
          id: 'cn:u1', alias: 'Personal', addedAt: 1, isPrimary: true, source: 'managed',
          credentials: { accessToken: 'at', refreshToken: 'rt', domain: 'copilot.tencent.com', expiresAt: 5 },
        },
        { id: 'cn:empty', alias: 'broken', addedAt: 1, credentials: { accessToken: '' } },
        'not-an-object',
      ],
    })
    expect(parsed.rotationStrategy).toBe('sticky')
    expect(parsed.activeAccountId).toBe('cn:u1')
    // The credential-less row is dropped rather than offered as an account.
    expect(parsed.accounts.map((account) => account.id)).toEqual(['cn:u1'])
    expect(parsed.accounts[0]!.region).toBe('cn')
    expect(parsed.accounts[0]!.credentials.backend).toBe('https://copilot.tencent.com')
  })

  it('rejects a payload that is not a pool document', () => {
    expect(() => parseWorkBuddyPoolData([])).toThrow(/invalid/)
    expect(() => parseWorkBuddyPoolData(null)).toThrow(/invalid/)
  })
})

describe('WorkBuddy pool adoption and identity', () => {
  it('adopts desktop accounts under their public account id', async () => {
    const dir = await makeAuthDir({ 'workbuddy-desktop.info': desktopFile({ uid: 'u1' }) })
    const store = createWorkBuddyStore(dir)
    const { pool } = makePool(store)

    const accounts = await pool.syncDesktopAccounts()
    expect(accounts).toHaveLength(1)
    // The id is the same public key the settings document already stores, so a
    // pinned or hidden account keeps working with no migration.
    expect(accounts[0]!.id).toBe(workBuddyAccountId((await store.read())!))
    expect(accounts[0]!.source).toBe('desktop')
    // A desktop account is the IDE's: the card must not offer to delete it.
    expect(accounts[0]!.removable).toBe(false)
  })

  it('collapses historical snapshots of one account instead of adopting each', async () => {
    const dir = await makeAuthDir({
      'workbuddy-desktop.info': desktopFile({ uid: 'u1' }),
      'workbuddy-desktop-20260101.info': desktopFile({ uid: 'u1', expiresAt: 1 }),
      'workbuddy-desktop-20260102.info': desktopFile({ uid: 'u1', expiresAt: 2 }),
    })
    const store = createWorkBuddyStore(dir)
    const { pool } = makePool(store)
    const accounts = await pool.syncDesktopAccounts()
    // One account, not one per snapshot file.
    expect(accounts).toHaveLength(1)
  })

  it('adopts a login and the IDE file for one account as a single account', async () => {
    // Symptom 1: the same account added by browser login and found by the disk
    // scan must not become two pool rows. The login response states only the
    // display name, so without the token-derived uid the two paths disagree.
    const uuid = 'd5721ab0-4d3a-42b4-ade1-f80f7381e2ca'
    const dir = await makeAuthDir({
      'workbuddy-desktop.info': {
        account: { uid: uuid, nickname: '快跑', uin: '330101607075' },
        auth: { accessToken: jwtToken({ sub: uuid, nickname: '快跑', uin: '330101607075' }), refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, domain: 'copilot.tencent.com' },
      },
    })
    const store = createWorkBuddyStore(dir)
    const { pool } = makePool(store)

    // What the browser-login path persists: a token whose claims carry the uid,
    // plus the display name the response returned. No uid field.
    await pool.addAccount({
      accessToken: jwtToken({ sub: uuid, nickname: '快跑', uin: '330101607075' }),
      refreshToken: 'login-rt',
      expiresAt: Date.now() + 3_600_000,
      region: 'cn',
      domain: 'copilot.tencent.com',
      backend: 'https://copilot.tencent.com',
      uid: undefined,
      nickname: '快跑',
      sourceFile: '',
      sourceMtimeMs: 0,
      source: 'managed',
    } as never)

    const accounts = await pool.syncDesktopAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.id).toBe(`cn:${uuid}`)
  })

  it('labels an account by a fact its owner can recognize, not its uuid', async () => {
    // Symptom 2 was an account displayed as "账号 1" with no real information.
    // A uuid is only marginally better than a position, so a credential that
    // states the Tencent UIN — the number a user can check on their own account
    // page — is labelled with that instead.
    const uuid = 'd5721ab0-4d3a-42b4-ade1-f80f7381e2ca'
    const dir = await makeAuthDir({})
    const store = createWorkBuddyStore(dir)
    const { pool } = makePool(store)

    const added = await pool.addAccount({
      accessToken: jwtToken({ sub: uuid, uin: '330101607075' }),
      refreshToken: 'rt',
      expiresAt: Date.now() + 3_600_000,
      region: 'cn',
      domain: 'copilot.tencent.com',
      backend: 'https://copilot.tencent.com',
      sourceFile: '',
      sourceMtimeMs: 0,
      source: 'managed',
    })

    expect(added.alias).toBe('330101607075')
    expect(added.alias).not.toBe('账号 1')
    expect(added.uin).toBe('330101607075')
    expect(added.id).toBe(`cn:${uuid}`)
  })

  it('collapses two stored rows that the identity heal re-keys onto one account', async () => {
    const uuid = '1fb74d2b-3883-43b2-a3a3-417e04e49531'
    const token = jwtToken({ sub: uuid, preferred_username: 'cchen2422@gmail.com' })
    const parsed = parseWorkBuddyPoolData({
      version: 1,
      activeAccountId: 'intl:cchen2422@gmail.com',
      accounts: [
        {
          id: 'intl:cchen2422@gmail.com', alias: 'cchen2422@gmail.com', addedAt: 1, isPrimary: true, source: 'managed',
          credentials: { accessToken: token, refreshToken: 'rt', domain: 'www.workbuddy.ai', expiresAt: Date.now() + 3_600_000, nickname: 'cchen2422@gmail.com' },
        },
        {
          // The desktop row is the one that carries the UIN, while the managed
          // login row carries the identity — so the merge has to keep both.
          id: `intl:${uuid}`, alias: 'desktop copy', addedAt: 2, source: 'desktop', uin: '450701882909',
          credentials: { accessToken: token, refreshToken: 'rt2', domain: 'www.workbuddy.ai', expiresAt: Date.now() + 3_600_000, uid: uuid, uin: '450701882909' },
        },
      ],
    })
    // One account, and the primary flag plus the stored pointer survive.
    expect(parsed.accounts).toHaveLength(1)
    expect(parsed.accounts[0]!.id).toBe(`intl:${uuid}`)
    expect(parsed.accounts[0]!.isPrimary).toBe(true)
    expect(parsed.activeAccountId).toBe(`intl:${uuid}`)
    // The discarded row was the only one carrying the UIN the card renders, so
    // the merge must not silently drop a display fact the user can recognize.
    expect(parsed.accounts[0]!.uin).toBe('450701882909')
  })

  it('still honors a pin and a hide stored under the pre-fix name-derived key', async () => {
    // An account that only had a nickname was addressable as region:<name>
    // before the fix. Settings written then still name it that way, and the
    // heal must not turn a pinned or hidden account back into an automatic one.
    const uuid = 'd5721ab0-4d3a-42b4-ade1-f80f7381e2ca'
    const token = jwtToken({ sub: uuid, nickname: '快跑' })
    // The file states only the display name; the uid is in the token. That is
    // exactly the account the old code addressed as `cn:快跑`.
    const dir = await makeAuthDir({
      'workbuddy-desktop.info': {
        account: { nickname: '快跑' },
        auth: { accessToken: token, refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, domain: 'copilot.tencent.com' },
      },
    })
    const store = createWorkBuddyStore(dir)

    // Hidden: the old key must still take it out of rotation.
    const hidden = makePool(store, { selection: () => ({ selectedAccountId: null, hiddenAccountIds: ['cn:快跑'] }) })
    await hidden.pool.syncDesktopAccounts()
    await expect(hidden.pool.getEffectiveAccount()).rejects.toThrow(LlmError)

    // Pinned: the old key must still select it ahead of the strategy. The other
    // account is added first so it is the primary one — ignoring the legacy pin
    // would therefore route there, making the assertion discriminating.
    const pinned = makePool(store, { selection: () => ({ selectedAccountId: 'cn:快跑', hiddenAccountIds: [] }) })
    await pinned.pool.addAccount({
      accessToken: token, refreshToken: 'rt2', expiresAt: Date.now() + 3_600_000, region: 'cn',
      domain: 'copilot.tencent.com', backend: 'https://copilot.tencent.com', uid: 'other-user',
      sourceFile: '', sourceMtimeMs: 0, source: 'managed',
    })
    await pinned.pool.syncDesktopAccounts()
    const { account } = await pinned.pool.getEffectiveAccount()
    expect(account.id).toBe(`cn:${uuid}`)
  })

  it('is idempotent when the directory is rescanned', async () => {
    const dir = await makeAuthDir({ 'workbuddy-desktop.info': desktopFile({ uid: 'u1' }) })
    const store = createWorkBuddyStore(dir)
    const { pool } = makePool(store)
    await pool.syncDesktopAccounts()
    const second = await pool.syncDesktopAccounts()
    expect(second).toHaveLength(1)
  })

  it('refuses to delete a desktop account but deletes a managed one', async () => {
    const dir = await makeAuthDir({ 'workbuddy-desktop.info': desktopFile({ uid: 'u1' }) })
    const store = createWorkBuddyStore(dir)
    const { pool } = makePool(store)
    const [desktop] = await pool.syncDesktopAccounts()

    await expect(pool.deleteAccount(desktop!.id)).rejects.toThrow(/隐藏/)

    const managed = await pool.addAccount({
      accessToken: 'at-managed', refreshToken: 'rt-managed', expiresAt: Date.now() + 3_600_000,
      region: 'cn', domain: 'copilot.tencent.com', backend: 'https://copilot.tencent.com',
      uid: 'managed-user', sourceFile: '', sourceMtimeMs: 0, source: 'managed',
    })
    expect(managed.id).toBe('cn:managed-user')
    await pool.deleteAccount(managed.id)
    expect((await pool.listAccounts()).map((account) => account.id)).toEqual([desktop!.id])
  })

  it('never touches the IDE credential file when a desktop account is hidden', async () => {
    const dir = await makeAuthDir({ 'workbuddy-desktop.info': desktopFile({ uid: 'u1' }) })
    const store = createWorkBuddyStore(dir)
    const { pool } = makePool(store, {
      selection: () => ({ selectedAccountId: null, hiddenAccountIds: ['cn:u1'] }),
    })
    await pool.syncDesktopAccounts()
    // Hidden means "out of rotation", never "removed from disk".
    expect(await fs.readFile(path.join(dir, 'workbuddy-desktop.info'), 'utf8')).toContain('at-u1')
    await expect(pool.getEffectiveAccount()).rejects.toThrow(LlmError)
  })

  it('syncDesktopAccounts does not overwrite a concurrent login that landed during desktop discovery', async () => {
    const dir = await makeAuthDir({})
    const store = createWorkBuddyStore(dir)
    const { pool } = makePool(store)

    const uuid = 'd5721ab0-4d3a-42b4-ade1-f80f7381e2ca'
    const desktopCreds: WorkBuddyCredentials = {
      accessToken: jwtToken({ sub: uuid, nickname: 'DesktopUser', uin: '123456789' }),
      refreshToken: 'rt-desktop',
      expiresAt: Date.now() + 3_600_000,
      region: 'cn',
      domain: 'copilot.tencent.com',
      backend: 'https://copilot.tencent.com',
      sourceFile: path.join(dir, 'workbuddy-desktop.info'),
      sourceMtimeMs: 100,
      source: 'desktop',
      nickname: 'DesktopUser',
      uin: '123456789',
    }

    const discoveryStarted = createDeferred()
    const loginCompleted = createDeferred()

    vi.spyOn(store, 'discoverDesktopCredentials').mockImplementation(async () => {
      discoveryStarted.resolve()
      await loginCompleted.promise
      return [desktopCreds]
    })

    const syncPromise = pool.syncDesktopAccounts()
    await discoveryStarted.promise

    // Concurrently, a managed login lands in the pool for the same identity
    const managedLoginCreds: WorkBuddyCredentials = {
      accessToken: jwtToken({ sub: uuid, nickname: 'ManagedUser', uin: '123456789' }),
      refreshToken: 'rt-managed-fresh',
      expiresAt: Date.now() + 3_600_000,
      region: 'cn',
      domain: 'copilot.tencent.com',
      backend: 'https://copilot.tencent.com',
      sourceFile: '',
      sourceMtimeMs: 0,
      source: 'managed',
      nickname: 'ManagedUser',
      uin: '123456789',
    }
    await pool.addAccount(managedLoginCreds)

    const afterLogin = await pool.read()
    expect(afterLogin.accounts).toHaveLength(1)
    expect(afterLogin.accounts[0]?.source).toBe('managed')
    expect(afterLogin.accounts[0]?.credentials.refreshToken).toBe('rt-managed-fresh')

    // Now resume syncDesktopAccounts to enter updatePool
    loginCompleted.resolve()
    const summaries = await syncPromise

    // syncDesktopAccounts insert-only must NOT overwrite the existing managed account
    const finalPool = await pool.read()
    expect(finalPool.accounts).toHaveLength(1)
    expect(finalPool.accounts[0]?.source).toBe('managed')
    expect(finalPool.accounts[0]?.credentials.refreshToken).toBe('rt-managed-fresh')
    expect(finalPool.accounts[0]?.credentials.accessToken).toBe(managedLoginCreds.accessToken)
    expect(summaries[0]?.source).toBe('managed')
  })

  it('updates desktop credential via CAS without overwriting if credentials changed concurrently', async () => {
    const dir = await makeAuthDir({
      'workbuddy-desktop.info': desktopFile({ uid: 'u1', accessToken: 'at-initial', refreshToken: 'rt-initial' }),
    })
    const store = createWorkBuddyStore(dir)
    const { pool } = makePool(store)
    await pool.syncDesktopAccounts()

    const readStarted = createDeferred()
    const updateCompleted = createDeferred()

    vi.spyOn(store, 'readDesktopFile').mockImplementation(async (file) => {
      readStarted.resolve()
      await updateCompleted.promise
      return {
        accessToken: 'at-desktop-live',
        refreshToken: 'rt-desktop-live',
        expiresAt: Date.now() + 3_600_000,
        region: 'cn',
        domain: 'copilot.tencent.com',
        backend: 'https://copilot.tencent.com',
        sourceFile: file,
        sourceMtimeMs: 200,
        source: 'desktop',
      }
    })

    const getCredPromise = pool.getEffectiveCredential()
    await readStarted.promise

    // Concurrently, account credentials in pool were updated
    const concurrentCreds: WorkBuddyCredentials = {
      accessToken: 'at-concurrent-token',
      refreshToken: 'rt-concurrent-token',
      expiresAt: Date.now() + 3_600_000,
      region: 'cn',
      domain: 'copilot.tencent.com',
      backend: 'https://copilot.tencent.com',
      sourceFile: path.join(dir, 'workbuddy-desktop.info'),
      sourceMtimeMs: 150,
      source: 'desktop',
    }
    const poolData = await pool.read()
    await pool.updateAccountCredentials(poolData.accounts[0]!.id, concurrentCreds)

    updateCompleted.resolve()
    const result = await getCredPromise

    // CAS failed, pool row was not overwritten with at-desktop-live
    const current = (await pool.read()).accounts[0]!
    expect(current.credentials.accessToken).toBe('at-concurrent-token')
    expect(result.credentials.accessToken).toBe('at-concurrent-token')
  })

  it('maintains legacyIds index on loadPoolData without needing read()', async () => {
    const dir = await makeAuthDir({})
    const store = createWorkBuddyStore(dir)
    const uuid = 'd5721ab0-4d3a-42b4-ade1-f80f7381e2ca'
    const token = jwtToken({ sub: uuid, nickname: '快跑' })

    const { pool } = makePool(store, {
      selection: () => ({ selectedAccountId: 'cn:快跑', hiddenAccountIds: [] }),
    })

    // Add account directly via updatePool/addAccount without calling read()
    await pool.addAccount({
      accessToken: token, refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, region: 'cn',
      domain: 'copilot.tencent.com', backend: 'https://copilot.tencent.com',
      sourceFile: '', sourceMtimeMs: 0, source: 'managed',
    })

    // Verify selection resolves the legacy alias through loadPoolData
    const { account } = await pool.getEffectiveAccount()
    expect(account.id).toBe(`cn:${uuid}`)
  })
})

describe('WorkBuddy pool scheduling', () => {
  function credential(n: number): WorkBuddyCredentials {
    return {
      accessToken: `at-${n}`, refreshToken: `rt-${n}`, expiresAt: Date.now() + 3_600_000,
      region: 'cn', domain: 'copilot.tencent.com', backend: 'https://copilot.tencent.com',
      uid: `u${n}`, sourceFile: '', sourceMtimeMs: 0, source: 'managed',
    }
  }

  it('honors a pinned account while it is eligible', async () => {
    const dir = await makeAuthDir({})
    const store = createWorkBuddyStore(dir)
    const { pool } = makePool(store, {
      selection: () => ({ selectedAccountId: 'cn:u2', hiddenAccountIds: [] }),
    })
    await pool.addAccount(credential(1))
    await pool.addAccount(credential(2))

    const { account } = await pool.getEffectiveAccount()
    expect(account.id).toBe('cn:u2')
  })

  it('falls back to automatic choice when the pinned account is cooling down', async () => {
    const dir = await makeAuthDir({})
    const store = createWorkBuddyStore(dir)
    const { pool } = makePool(store, {
      selection: () => ({ selectedAccountId: 'cn:u2', hiddenAccountIds: [] }),
    })
    await pool.addAccount(credential(1))
    const pinned = await pool.addAccount(credential(2))
    await pool.markCooldown(pinned.id, 60_000, '429')

    // A pinned account that is limited must not take the line offline.
    const { account } = await pool.getEffectiveAccount()
    expect(account.id).toBe('cn:u1')
  })

  it('rotates to another account after a 429 instead of failing the turn', async () => {
    const dir = await makeAuthDir({})
    const store = createWorkBuddyStore(dir)
    const { pool } = makePool(store)
    await pool.addAccount(credential(1))
    await pool.addAccount(credential(2))

    const tried = new Set<string>()
    const first = await pool.getEffectiveAccount(tried)
    tried.add(first.account.id)
    const second = await pool.getEffectiveAccount(tried)
    expect(second.account.id).not.toBe(first.account.id)
  })

  it('spreads requests over the pool under round-robin', async () => {
    const dir = await makeAuthDir({})
    const store = createWorkBuddyStore(dir)
    const { pool } = makePool(store)
    await pool.addAccount(credential(1))
    await pool.addAccount(credential(2))
    await pool.setStrategy('round-robin')

    const seen: string[] = []
    for (let i = 0; i < 2; i++) {
      const { account } = await pool.getEffectiveAccount()
      seen.push(account.id)
      // getEffectiveAccount records lastUsedAt, so the next pick is the other one.
    }
    expect(new Set(seen).size).toBe(2)
  })
})

describe('WorkBuddy stale auth markers', () => {
  it('clears a marker the IDE file has outlived and adopts the newer token', async () => {
    const dir = await makeAuthDir({
      'workbuddy-desktop.info': desktopFile({ uid: 'u1', accessToken: 'at-refused' }),
    })
    const store = createWorkBuddyStore(dir)
    const { pool } = makePool(store)
    await pool.syncDesktopAccounts()
    const accountId = workBuddyAccountId((await store.read())!)
    await pool.markAuthFailed(accountId, 'rejected the stored credential (401)')

    // The IDE rotates its own token while the row sits parked: the refusal was
    // about the token that was in force then, not about the sign-in.
    await fs.writeFile(
      path.join(dir, 'workbuddy-desktop.info'),
      JSON.stringify(desktopFile({ uid: 'u1', accessToken: 'at-ide-renewed' })),
      'utf8',
    )
    store.invalidate()

    // Asked on the REQUEST path first: a marker that only the card clears would
    // still leave the next turn answering "全部账号都需要重新登录".
    const { credentials } = await pool.getEffectiveAccount()
    expect(credentials.accessToken).toBe('at-ide-renewed')
    expect((await pool.listAccounts())[0]?.authStatus).toBeUndefined()
  })

  it('keeps the marker while the credential in force is still the refused one', async () => {
    const dir = await makeAuthDir({
      'workbuddy-desktop.info': desktopFile({ uid: 'u1', accessToken: 'at-refused' }),
    })
    const store = createWorkBuddyStore(dir)
    const { pool } = makePool(store)
    await pool.syncDesktopAccounts()
    const accountId = workBuddyAccountId((await store.read())!)
    await pool.markAuthFailed(accountId, 'rejected the stored credential (401)')

    // Nothing moved on disk: this one really does need a sign-in.
    expect((await pool.listAccounts())[0]?.authStatus).toBe('expired')
    await expect(pool.getEffectiveAccount()).rejects.toMatchObject({ code: 'AUTH' })
  })
})

describe('WorkBuddy 11140 restrictions and the pool-wide pause', () => {
  function credential(n: number): WorkBuddyCredentials {
    return {
      accessToken: `at-${n}`, refreshToken: `rt-${n}`, expiresAt: Date.now() + 3_600_000,
      region: 'cn', domain: 'copilot.tencent.com', backend: 'https://copilot.tencent.com',
      uid: `u${n}`, sourceFile: '', sourceMtimeMs: 0, source: 'managed',
    }
  }

  /** The rejection a call produces, as a record a test can inspect. */
  async function failureOf(run: Promise<unknown>): Promise<Record<string, unknown>> {
    try {
      await run
    } catch (error) {
      return error as Record<string, unknown>
    }
    throw new Error('expected the call to be refused')
  }

  /** A pool of `count` managed accounts plus the injected store they live on. */
  async function makeAccountedPool(count: number) {
    const dir = await makeAuthDir({})
    const store = createWorkBuddyStore(dir)
    const backend = new PoolBackend(parseWorkBuddyPoolData)
    const pool = new WorkBuddyAccountPool({ store, backend: backend as never })
    for (let n = 1; n <= count; n += 1) await pool.addAccount(credential(n))
    return { pool, backend, store }
  }

  it('takes only the barred account out of rotation and persists the restriction', async () => {
    const { pool, backend } = await makeAccountedPool(3)
    await pool.markAccountRestriction('cn:u1', { code: 11140, message: 'account restricted' })

    const barred = (await pool.listAccounts()).find((account) => account.id === 'cn:u1')
    expect(barred?.restriction).toEqual({ code: 11140, message: 'account restricted' })

    // One barred account is that account's problem: the rest keep serving and the
    // pool is NOT paused.
    expect((await pool.poolState()).paused).toBe(false)
    expect((await pool.getEffectiveAccount()).account.id).toBe('cn:u2')

    // Persisted in the pool document itself, not in this process's memory.
    const stored = await backend.load() as any
    expect(stored.pool.restrictions['cn:u1']).toMatchObject({ code: 11140, message: 'account restricted' })
    expect(typeof stored.pool.restrictions['cn:u1'].observedAt).toBe('number')
  })

  it('pauses the whole pool when a second different account is barred inside the window', async () => {
    const { pool, backend } = await makeAccountedPool(3)
    await pool.markAccountRestriction('cn:u1', { code: 11140 })
    await pool.markAccountRestriction('cn:u2', { code: 11140 })

    const state = await pool.poolState()
    expect(state.paused).toBe(true)
    expect([...(state.restrictedAccountIds ?? [])].sort()).toEqual(['cn:u1', 'cn:u2'])
    expect(state.pauseReason).toContain('11140')
    expect(state.pausedUntil).toBeGreaterThan(Date.now())
    expect(state.pausedUntil! - Date.now()).toBeLessThanOrEqual(WORKBUDDY_POOL_PAUSE_MS)

    // No account is selected at all while the pool is paused — not even the one
    // account that is still healthy.
    const failure = await failureOf(pool.getEffectiveAccount())
    expect(failure).toBeInstanceOf(WorkBuddyPoolPausedError)
    // The pool's own code, never an upstream 429: the remedy is different.
    expect(failure.code).toBe(WORKBUDDY_POOL_PAUSED_CODE)
    expect(failure.status).toBeUndefined()
    expect((await failureOf(pool.getEffectiveCredential())).code).toBe(WORKBUDDY_POOL_PAUSED_CODE)
    expect(await pool.hasAnotherAvailableAccount(new Set(['cn:u1', 'cn:u2']))).toBe(false)
    expect(await pool.hasAnotherAvailableAccountFor(new Set(), 'glm-5.3')).toBe(false)

    // The pause — with the instant it lifts — is in the document too.
    const stored = await backend.load() as any
    expect(stored.pool.pause).toMatchObject({ pausedUntil: state.pausedUntil, pausedSince: state.pausedSince })
  })

  it('does not pause when the same account is refused again', async () => {
    const { pool } = await makeAccountedPool(3)
    await pool.markAccountRestriction('cn:u1', { code: 11140 })
    await pool.markAccountRestriction('cn:u1', { code: 11140, message: 'still restricted' })

    expect((await pool.poolState()).paused).toBe(false)
    expect((await pool.getEffectiveAccount()).account.id).toBe('cn:u2')
  })

  it('does not escalate when the second account is barred outside the window', async () => {
    const { pool } = await makeAccountedPool(3)
    await pool.markAccountRestriction('cn:u1', { code: 11140 })
    vi.useFakeTimers()
    try {
      vi.advanceTimersByTime(WORKBUDDY_RESTRICTION_ESCALATION_WINDOW_MS + 1_000)
      await pool.markAccountRestriction('cn:u2', { code: 11140 })
      // The two refusals are too far apart to describe one event, so the third
      // account still serves instead of the whole line going offline.
      expect((await pool.poolState()).paused).toBe(false)
      expect((await pool.getEffectiveAccount()).account.id).toBe('cn:u3')
    } finally {
      vi.useRealTimers()
    }
  })

  it('resumes by itself when the pause expires, and keeps the barred accounts barred', async () => {
    const { pool } = await makeAccountedPool(3)
    vi.useFakeTimers()
    try {
      await pool.markAccountRestriction('cn:u1', { code: 11140 })
      await pool.markAccountRestriction('cn:u2', { code: 11140 })
      expect((await pool.poolState()).paused).toBe(true)

      vi.advanceTimersByTime(WORKBUDDY_POOL_PAUSE_MS + 1_000)

      const state = await pool.poolState()
      expect(state.paused).toBe(false)
      // The pause lifted on its own; the ACCOUNTS did not: nothing upstream said
      // they may serve again.
      expect((await pool.getEffectiveAccount()).account.id).toBe('cn:u3')
      const accounts = await pool.listAccounts()
      expect(accounts.find((account) => account.id === 'cn:u1')?.restriction).toBeDefined()
      expect([...(state.restrictedAccountIds ?? [])].sort()).toEqual(['cn:u1', 'cn:u2'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores a barred account only when it is signed in again', async () => {
    const { pool } = await makeAccountedPool(3)
    await pool.markAccountRestriction('cn:u1', { code: 11140 })
    expect((await pool.listAccounts()).find((account) => account.id === 'cn:u1')?.restriction).toBeDefined()

    await pool.addAccount(credential(1))

    expect((await pool.listAccounts()).find((account) => account.id === 'cn:u1')?.restriction).toBeUndefined()
    expect((await pool.getEffectiveAccount()).account.id).toBe('cn:u1')
  })

  it('refuses a code that is not an account bar instead of barring an account', async () => {
    const { pool, backend } = await makeAccountedPool(2)
    // 11128 is the channel/request-shape block and 11158 is one model an account
    // is not entitled to. Neither says the ACCOUNT may not serve, so the pool
    // must not record either as a restriction.
    await expect(pool.markAccountRestriction('cn:u1', { code: 11128, message: 'security blocked' }))
      .rejects.toThrow(/11128/)
    await expect(pool.markAccountRestriction('cn:u1', { code: 11158 })).rejects.toThrow(/11158/)

    const state = await pool.poolState()
    expect(state.paused).toBe(false)
    expect(state.restrictedAccountIds ?? []).toEqual([])
    expect((await backend.load() as any).pool).toBeUndefined()
    expect((await pool.getEffectiveAccount()).account.id).toBe('cn:u1')
  })

  it('reports the restriction and the pause to a SECOND pool instance over the same store', async () => {
    const { pool, backend, store } = await makeAccountedPool(3)
    await pool.markAccountRestriction('cn:u1', { code: 11140 })
    await pool.markAccountRestriction('cn:u2', { code: 11140 })

    // A fresh instance shares nothing with the first but the injected store.
    const second = new WorkBuddyAccountPool({ store, backend: backend as never })
    const state = await second.poolState()
    expect(state.paused).toBe(true)
    expect([...(state.restrictedAccountIds ?? [])].sort()).toEqual(['cn:u1', 'cn:u2'])
    expect(state.pausedUntil).toBe((await pool.poolState()).pausedUntil)
    await expect(second.getEffectiveAccount()).rejects.toBeInstanceOf(WorkBuddyPoolPausedError)
    expect((await second.listAccounts()).find((account) => account.id === 'cn:u1')?.restriction)
      .toMatchObject({ code: 11140 })
    // The storage answer travels with the state, so a card can name the store the
    // pause is held in.
    expect(state.storage).toBeDefined()
  })

  it('a second instance keeps a single barred account out of rotation', async () => {
    const { pool, backend, store } = await makeAccountedPool(3)
    await pool.markAccountRestriction('cn:u1', { code: 11140 })

    const second = new WorkBuddyAccountPool({ store, backend: backend as never })
    // Not paused — but the barred account is excluded by the PERSISTED record,
    // which an in-memory-only restriction could not do.
    expect((await second.poolState()).paused).toBe(false)
    expect((await second.getEffectiveAccount()).account.id).toBe('cn:u2')
    expect(await second.hasAnotherAvailableAccount(new Set(['cn:u2', 'cn:u3']))).toBe(false)
  })
})

describe('WorkBuddy pool document compatibility', () => {
  it('loads a document written before the pool-wide state existed', async () => {
    const dir = await makeAuthDir({})
    const store = createWorkBuddyStore(dir)
    // The exact shape the previous version persisted under DPAPI / Keychain:
    // no `pool` key at all.
    const legacy = {
      version: 1,
      rotationStrategy: 'sequential',
      activeAccountId: 'cn:u1',
      accounts: [{
        id: 'cn:u1', alias: 'Legacy', addedAt: 1, isPrimary: true, source: 'managed',
        credentials: {
          accessToken: 'at-1', refreshToken: 'rt-1', domain: 'copilot.tencent.com',
          expiresAt: Date.now() + 3_600_000, uid: 'u1',
        },
      }],
    }
    const backend = new PoolBackend(parseWorkBuddyPoolData)
    await backend.save(legacy)
    const pool = new WorkBuddyAccountPool({ store, backend: backend as never })

    expect((await pool.listAccounts()).map((account) => account.id)).toEqual(['cn:u1'])
    const state = await pool.poolState()
    expect(state.paused).toBe(false)
    expect(state.restrictedAccountIds ?? []).toEqual([])
    // Reading it must not invent pool-wide state, and a normal mutation must not
    // drop the legacy document either.
    expect((await backend.load() as any).pool).toBeUndefined()
    await pool.markCooldown('cn:u1', 60_000, 'pre-existing 429')
    expect(((await backend.load() as any).accounts)).toHaveLength(1)
  })

  it('drops an unreadable pool-wide state instead of losing the accounts', async () => {
    const parsed = parseWorkBuddyPoolData({
      version: 1,
      rotationStrategy: 'sequential',
      pool: { restrictions: { 'cn:u1': { code: 'not-a-number' } }, pause: { pausedUntil: 'later' } },
      accounts: [{
        id: 'cn:u1', alias: 'A', addedAt: 1, isPrimary: true, source: 'managed',
        credentials: { accessToken: 'at', refreshToken: 'rt', domain: 'copilot.tencent.com', expiresAt: 5 },
      }],
    })
    expect(parsed.accounts).toHaveLength(1)
    expect(parsed.pool).toBeUndefined()
  })
})

describe('WorkBuddy adapter over an account pool', () => {
  const CATALOG: WorkBuddyModelEntry[] = [{
    id: 'deepseek-v4.1-flash', name: 'DeepSeek Flash', contextWindow: 300_000, maxContextWindow: 300_000,
    maxTokens: 32_000, regions: ['cn', 'intl'], supportsImage: false, reasoningEfforts: [],
    defaultReasoningEffort: null, canDisableThinking: false, description: '',
  }]
  const SSE_BODY = 'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'

  function options(): GenerateOptions {
    return {
      provider: 'workbuddy-subscription', model: 'deepseek-v4.1-flash',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })],
    }
  }

  function makeAdapter(store: FileCredentialStore, fetchFn: typeof fetch, pool?: WorkBuddyAccountPool): WorkBuddyAdapter {
    return new WorkBuddyAdapter(
      store,
      new FileModelSettingsStore(path.join(os.tmpdir(), `wb-pool-models-${Date.now()}-${Math.random()}.json`)),
      undefined,
      { fetchFn, loadCatalog: async () => CATALOG, ...(pool === undefined ? {} : { accountPool: pool }) },
    )
  }

  it('retries the same body on another account when the first is rate limited', async () => {
    const dir = await makeAuthDir({})
    const store = createWorkBuddyStore(dir)
    const { pool } = makePool(store, { selection: () => ({ selectedAccountId: 'cn:u1', hiddenAccountIds: [] }) })
    for (const n of [1, 2]) await pool.addAccount({
      accessToken: `at-${n}`, refreshToken: `rt-${n}`, expiresAt: Date.now() + 3_600_000, region: 'cn',
      domain: 'copilot.tencent.com', backend: 'https://copilot.tencent.com', uid: `u${n}`,
      sourceFile: '', sourceMtimeMs: 0, source: 'managed',
    })
    const tokens: string[] = []
    const fetchFn = (async (_url: string, init: any) => {
      tokens.push(String(init.headers.authorization))
      return tokens.length === 1
        ? new Response(JSON.stringify({ code: 6004, msg: 'usage exceeded' }), { status: 429 })
        : new Response(SSE_BODY, { status: 200 })
    }) as unknown as typeof fetch
    const chunks: any[] = []
    for await (const chunk of makeAdapter(store, fetchFn, pool).stream(options())) chunks.push(chunk)
    expect(tokens).toEqual(['Bearer at-1', 'Bearer at-2'])
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')).toBe('ok')
    expect((await pool.listAccounts()).find((account) => account.id === 'cn:u1')?.cooldownUntil).toBeGreaterThan(Date.now())
  })

  it('renews a refused token once and finishes the same turn on the renewed credential', async () => {
    const dir = await makeAuthDir({})
    const store = createWorkBuddyStore(dir)
    const { pool } = makePool(store, { selection: () => ({ selectedAccountId: 'cn:u1', hiddenAccountIds: [] }) })
    await pool.addAccount({
      accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 3_600_000, region: 'cn',
      domain: 'copilot.tencent.com', backend: 'https://copilot.tencent.com', uid: 'u1',
      sourceFile: '', sourceMtimeMs: 0, source: 'managed',
    })
    const sent: string[] = []
    const fetchFn = (async (url: string, init: any) => {
      if (String(url).includes('/v2/plugin/auth/token/refresh')) {
        return new Response(JSON.stringify({ code: 0, data: { accessToken: 'at-1-renewed', refreshToken: 'rt-1-renewed', expiresIn: 3600 } }), { status: 200 })
      }
      sent.push(String(init.headers.authorization))
      return sent.length === 1 ? new Response('<html>401</html>', { status: 401 }) : new Response(SSE_BODY, { status: 200 })
    }) as unknown as typeof fetch
    const chunks: any[] = []
    for await (const chunk of makeAdapter(store, fetchFn, pool).stream(options())) chunks.push(chunk)
    expect(sent).toEqual(['Bearer at-1', 'Bearer at-1-renewed'])
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')).toBe('ok')
    expect((await pool.listAccounts()).find((entry) => entry.id === 'cn:u1')?.authStatus).toBeUndefined()
    expect((await pool.read()).accounts[0]!.credentials.accessToken).toBe('at-1-renewed')
  })

  it('marks the account only when the token endpoint also refuses the renewal, then rotates', async () => {
    const dir = await makeAuthDir({})
    const store = createWorkBuddyStore(dir)
    const { pool } = makePool(store, { selection: () => ({ selectedAccountId: 'cn:u1', hiddenAccountIds: [] }) })
    for (const n of [1, 2]) await pool.addAccount({
      accessToken: `at-${n}`, refreshToken: `rt-${n}`, expiresAt: Date.now() + 3_600_000, region: 'cn',
      domain: 'copilot.tencent.com', backend: 'https://copilot.tencent.com', uid: `u${n}`,
      sourceFile: '', sourceMtimeMs: 0, source: 'managed',
    })
    const sent: string[] = []
    const fetchFn = (async (url: string, init: any) => {
      if (String(url).includes('/v2/plugin/auth/token/refresh')) return new Response('{"code":1000,"msg":"invalid_grant"}', { status: 401 })
      sent.push(String(init.headers.authorization))
      return sent.length === 1 ? new Response('unauthorized', { status: 401 }) : new Response(SSE_BODY, { status: 200 })
    }) as unknown as typeof fetch
    for await (const _chunk of makeAdapter(store, fetchFn, pool).stream(options())) { /* drain */ }
    expect(sent).toEqual(['Bearer at-1', 'Bearer at-2'])
    const accounts = await pool.listAccounts()
    expect(accounts.find((entry) => entry.id === 'cn:u1')?.authStatus).toBe('expired')
    expect(accounts.find((entry) => entry.id === 'cn:u2')?.authStatus).toBeUndefined()
  })

  it('leaves the pool untouched when the renewed token is refused too', async () => {
    const dir = await makeAuthDir({})
    const store = createWorkBuddyStore(dir)
    const { pool } = makePool(store, { selection: () => ({ selectedAccountId: 'cn:u1', hiddenAccountIds: [] }) })
    await pool.addAccount({
      accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 3_600_000, region: 'cn',
      domain: 'copilot.tencent.com', backend: 'https://copilot.tencent.com', uid: 'u1',
      sourceFile: '', sourceMtimeMs: 0, source: 'managed',
    })
    let chatCalls = 0
    const fetchFn = (async (url: string) => {
      if (String(url).includes('/v2/plugin/auth/token/refresh')) {
        return new Response(JSON.stringify({ code: 0, data: { accessToken: 'at-1-renewed', expiresIn: 3600 } }), { status: 200 })
      }
      chatCalls += 1
      return new Response('<html>401</html>', { status: 401 })
    }) as unknown as typeof fetch
    let failure: unknown
    try {
      for await (const _chunk of makeAdapter(store, fetchFn, pool).stream(options())) { /* drain */ }
    } catch (error) { failure = error }
    expect(chatCalls).toBe(2)
    expect(failure).toMatchObject({ code: 'PROVIDER_ERROR' })
    expect((await pool.listAccounts())[0]?.authStatus).toBeUndefined()
  })

  it('writes a rotated desktop token back to the IDE file so the IDE is not signed out', async () => {
    const dir = await makeAuthDir({ 'workbuddy-desktop.info': desktopFile({ uid: 'u1', expiresAt: Date.now() - 1000 }) })
    const store = createWorkBuddyStore(dir)
    const { pool } = makePool(store)
    await pool.syncDesktopAccounts()
    const fetchFn = (async (url: string) => {
      if (String(url).includes('/v2/plugin/auth/token/refresh')) {
        return new Response(JSON.stringify({ code: 0, data: { accessToken: 'rotated-at', refreshToken: 'rotated-rt', expiresIn: 3600 } }), { status: 200 })
      }
      return new Response(SSE_BODY, { status: 200 })
    }) as unknown as typeof fetch
    for await (const _chunk of makeAdapter(store, fetchFn, pool).stream(options())) { /* drain */ }
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'workbuddy-desktop.info'), 'utf8'))
    expect(onDisk.auth.accessToken).toBe('rotated-at')
    expect(onDisk.auth.refreshToken).toBe('rotated-rt')
  })
})
