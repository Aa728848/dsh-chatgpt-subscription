import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  WorkBuddyAccountPool,
  parseWorkBuddyPoolData,
  workBuddyPoolPath,
} from '../src/host/workbuddy/account-pool.ts'
import { WorkBuddyAdapter } from '../src/host/workbuddy/adapter.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  workBuddyAccountId,
  type WorkBuddyCredentials,
} from '../src/host/workbuddy/token-store.ts'
import { clearCachedCatalog, clearCachedQuota } from '../src/host/workbuddy/client.ts'
import type { WorkBuddyModelEntry } from '../src/host/workbuddy/model-catalog.ts'

const temporaryDirs: string[] = []

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

const CATALOG: WorkBuddyModelEntry[] = [
  {
    id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxContextWindow: 1_000_000, maxTokens: 48_000,
    regions: ['cn', 'intl'], supportsImage: true, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high',
    canDisableThinking: true, description: '',
  },
]

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
    const store = new FileCredentialStore(dir)
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
    const store = new FileCredentialStore(dir)
    const { pool } = makePool(store)
    const accounts = await pool.syncDesktopAccounts()
    // One account, not one per snapshot file.
    expect(accounts).toHaveLength(1)
  })

  it('is idempotent when the directory is rescanned', async () => {
    const dir = await makeAuthDir({ 'workbuddy-desktop.info': desktopFile({ uid: 'u1' }) })
    const store = new FileCredentialStore(dir)
    const { pool } = makePool(store)
    await pool.syncDesktopAccounts()
    const second = await pool.syncDesktopAccounts()
    expect(second).toHaveLength(1)
  })

  it('refuses to delete a desktop account but deletes a managed one', async () => {
    const dir = await makeAuthDir({ 'workbuddy-desktop.info': desktopFile({ uid: 'u1' }) })
    const store = new FileCredentialStore(dir)
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
    const store = new FileCredentialStore(dir)
    const { pool } = makePool(store, {
      selection: () => ({ selectedAccountId: null, hiddenAccountIds: ['cn:u1'] }),
    })
    await pool.syncDesktopAccounts()
    // Hidden means "out of rotation", never "removed from disk".
    expect(await fs.readFile(path.join(dir, 'workbuddy-desktop.info'), 'utf8')).toContain('at-u1')
    await expect(pool.getEffectiveAccount()).rejects.toThrow(LlmError)
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
    const store = new FileCredentialStore(dir)
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
    const store = new FileCredentialStore(dir)
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
    const store = new FileCredentialStore(dir)
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
    const store = new FileCredentialStore(dir)
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

describe('WorkBuddy adapter rotation', () => {
  const options = (): GenerateOptions => ({
    provider: 'workbuddy-subscription',
    model: 'glm-5.3',
    messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
  }) as unknown as GenerateOptions

  function makeAdapter(store: FileCredentialStore, fetchFn: typeof fetch, pool?: WorkBuddyAccountPool): WorkBuddyAdapter {
    return new WorkBuddyAdapter(
      store,
      new FileModelSettingsStore(path.join(os.tmpdir(), `wb-pool-models-${Date.now()}-${Math.random()}.json`)),
      undefined,
      {
        fetchFn,
        loadCatalog: async () => CATALOG,
        ...(pool === undefined ? {} : { accountPool: pool }),
      },
    )
  }

  it('retries the same body on another account when the first is rate limited', async () => {
    const dir = await makeAuthDir({})
    const store = new FileCredentialStore(dir)
    const { pool } = makePool(store, { selection: () => ({ selectedAccountId: 'cn:u1', hiddenAccountIds: [] }) })
    await pool.addAccount({
      accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 3_600_000, region: 'cn',
      domain: 'copilot.tencent.com', backend: 'https://copilot.tencent.com', uid: 'u1',
      sourceFile: '', sourceMtimeMs: 0, source: 'managed',
    })
    await pool.addAccount({
      accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: Date.now() + 3_600_000, region: 'cn',
      domain: 'copilot.tencent.com', backend: 'https://copilot.tencent.com', uid: 'u2',
      sourceFile: '', sourceMtimeMs: 0, source: 'managed',
    })

    const tokens: string[] = []
    const fetchFn = (async (_url: string, init: any) => {
      tokens.push(String(init.headers.authorization))
      if (tokens.length === 1) {
        return new Response(JSON.stringify({ code: 6004, msg: 'usage exceeded' }), { status: 429 })
      }
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200 })
    }) as unknown as typeof fetch

    const adapter = makeAdapter(store, fetchFn, pool)
    const chunks: any[] = []
    for await (const chunk of adapter.stream(options())) chunks.push(chunk)

    // The limited account rotates out and the same turn still completes.
    expect(tokens).toEqual(['Bearer at-1', 'Bearer at-2'])
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')).toBe('ok')
    const accounts = await pool.listAccounts()
    expect(accounts.find((account) => account.id === 'cn:u1')?.cooldownUntil).toBeGreaterThan(Date.now())
  })

  it('marks a rejected credential for re-login and rotates to the other account', async () => {
    const dir = await makeAuthDir({})
    const store = new FileCredentialStore(dir)
    const { pool } = makePool(store, { selection: () => ({ selectedAccountId: 'cn:u1', hiddenAccountIds: [] }) })
    for (const n of [1, 2]) {
      await pool.addAccount({
        accessToken: `at-${n}`, refreshToken: `rt-${n}`, expiresAt: Date.now() + 3_600_000, region: 'cn',
        domain: 'copilot.tencent.com', backend: 'https://copilot.tencent.com', uid: `u${n}`,
        sourceFile: '', sourceMtimeMs: 0, source: 'managed',
      })
    }

    let calls = 0
    const fetchFn = (async () => {
      calls += 1
      if (calls === 1) return new Response('unauthorized', { status: 401 })
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200 })
    }) as unknown as typeof fetch

    const adapter = makeAdapter(store, fetchFn, pool)
    for await (const _chunk of adapter.stream(options())) { /* drain */ }

    const accounts = await pool.listAccounts()
    // The dead account is kept (signing in again restores it) but not routed to.
    expect(accounts.find((account) => account.id === 'cn:u1')?.authStatus).toBe('expired')
  })

  it('writes a rotated desktop token back to the IDE file so the IDE is not signed out', async () => {
    const dir = await makeAuthDir({ 'workbuddy-desktop.info': desktopFile({ uid: 'u1', expiresAt: Date.now() - 1000 }) })
    const store = new FileCredentialStore(dir)
    const { pool } = makePool(store)
    await pool.syncDesktopAccounts()

    const fetchFn = (async (url: string) => {
      if (String(url).includes('/v2/plugin/auth/token/refresh')) {
        return new Response(JSON.stringify({ code: 0, data: { accessToken: 'rotated-at', refreshToken: 'rotated-rt', expiresIn: 3600 } }), { status: 200 })
      }
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200 })
    }) as unknown as typeof fetch

    const adapter = makeAdapter(store, fetchFn, pool)
    for await (const _chunk of adapter.stream(options())) { /* drain */ }

    const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'workbuddy-desktop.info'), 'utf8'))
    expect(onDisk.auth.accessToken).toBe('rotated-at')
    expect(onDisk.auth.refreshToken).toBe('rotated-rt')
  })
})
