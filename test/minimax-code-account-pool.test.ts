import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  MinimaxCodeAccountPool,
  createMinimaxCodeAccountsHandler,
  minimaxCodePoolIdentity,
  minimaxCodePoolPath,
  minimaxCodePoolStatus,
  parseMinimaxCodePoolData,
  type MinimaxCodeAccountSummaryDto,
} from '../src/host/minimax-code/account-pool.ts'
import {
  MinimaxCodeCredentialStore,
  pluginCredentialPath,
  type MinimaxCodeCredentials,
} from '../src/host/minimax-code/token-store.ts'
import {
  MinimaxCodeUnauthorizedError,
  ensureAccessToken,
  isRefreshTokenRejected,
  resetRefreshRejections,
} from '../src/host/minimax-code/oauth.ts'

/**
 * Temp roots this file points the two credential directories at.
 *
 * They are cleaned up by naming the files written here and then removing the
 * (now empty) directories deepest-first: a recursive delete walks through a
 * junction and destroys its target, so it is not used here even for a tree this
 * test created.
 */
let dshHome = ''
let minimaxHome = ''

beforeEach(async () => {
  resetRefreshRejections()
  dshHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-minimax-home-'))
  // An EMPTY MiniMax home: no test may read the developer's real ~/.minimax.
  minimaxHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-minimax-native-'))
  process.env.DSH_HOME = dshHome
  process.env.MINIMAX_HOME = minimaxHome
})

afterEach(async () => {
  resetRefreshRejections()
  delete process.env.DSH_HOME
  delete process.env.MINIMAX_HOME
  vi.restoreAllMocks()
  const files = [
    pluginCredentialPath(),
    path.join(minimaxHome, 'auth', 'prod', 'cn', 'mcode-public', 'auth.json'),
    path.join(minimaxHome, 'auth', 'prod', 'cn', 'mcode-public', 'auth-state.json'),
    path.join(minimaxHome, 'auth', 'prod', 'global', 'mcode-public', 'auth.json'),
    path.join(minimaxHome, 'auth', 'prod', 'global', 'mcode-public', 'auth-state.json'),
  ]
  for (const file of files) await fs.rm(file, { force: true }).catch(() => undefined)
  const directories = [
    path.join(minimaxHome, 'auth', 'prod', 'cn', 'mcode-public'),
    path.join(minimaxHome, 'auth', 'prod', 'global', 'mcode-public'),
    path.join(minimaxHome, 'auth', 'prod', 'cn'),
    path.join(minimaxHome, 'auth', 'prod', 'global'),
    path.join(minimaxHome, 'auth', 'prod'),
    path.join(minimaxHome, 'auth'),
    minimaxHome,
    path.join(dshHome, 'storages'),
    dshHome,
  ]
  // rmdir refuses a non-empty directory, which is the point: anything left
  // behind is deliberate and visible rather than silently swept away.
  for (const directory of directories) await fs.rmdir(directory).catch(() => undefined)
})

/** Mirrors the platform pool backends: JSON, and the parse hook applied on read. */
class PoolBackend {
  private data: unknown = null
  private readonly parse: (value: unknown) => unknown
  constructor(parse: (value: unknown) => unknown) {
    this.parse = parse
  }
  async load() { return this.data === null ? null : this.parse(JSON.parse(JSON.stringify(this.data))) }
  async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

/** Build an unsigned JWT-shaped access token carrying the claims under test. */
function jwtToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return 'header.' + encode(claims) + '.signature'
}

function credential(n: number, overrides: Partial<MinimaxCodeCredentials> = {}): MinimaxCodeCredentials {
  return {
    accessToken: jwtToken({ email: 'user' + n + '@example.com', plan: 'Coding Pro' }),
    refreshToken: 'rt-' + n,
    tokenType: 'Bearer',
    clientId: 'mcode-public',
    scopes: ['agent.default'],
    audience: 'agent-backend',
    expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
    generation: 1,
    loginEpoch: 'signin-' + n,
    buildEnv: 'prod',
    region: 'cn',
    recordKey: null,
    source: 'file',
    ...overrides,
  }
}

/** One credential as MiniMax Code's own auth.json yields it. */
function nativeCredential(overrides: Partial<MinimaxCodeCredentials> = {}): MinimaxCodeCredentials {
  return credential(9, {
    source: 'minimax-native',
    recordKey: 'record-key-hash',
    loginEpoch: '',
    refreshToken: 'rt-native',
    ...overrides,
  })
}

/** Write the plugin's own single-credential file, the pre-pool store. */
async function writePluginCredential(value: MinimaxCodeCredentials): Promise<void> {
  const file = pluginCredentialPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8')
}

/** Write one region's native auth.json, in the desktop app's own shape. */
async function writeNativeCredential(region: 'cn' | 'global', value: {
  accessToken?: string
  refreshToken?: string
  expiresAtMs?: number
  recordKey?: string
} = {}): Promise<string> {
  const dir = path.join(minimaxHome, 'auth', 'prod', region, 'mcode-public')
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, 'auth.json')
  await fs.writeFile(file, JSON.stringify({
    schemaVersion: 1,
    records: {
      [value.recordKey ?? 'record-key-hash']: {
        clientId: 'mcode-public',
        accessToken: value.accessToken ?? 'at-native',
        refreshToken: value.refreshToken ?? 'rt-native',
        expiresAtMs: value.expiresAtMs ?? Date.now() + 3_600_000,
        region,
      },
    },
  }), 'utf8')
  return file
}

/**
 * Await the plugin's own single-credential mirror reaching an expected refresh
 * token.
 *
 * The mirror is written fire-and-forget: a bookkeeping write must never fail the
 * request that triggered it, so the file is polled instead of assumed written.
 */
async function waitForMirror(refreshToken: string): Promise<MinimaxCodeCredentials> {
  let seen: MinimaxCodeCredentials | null = null
  await vi.waitFor(async () => {
    seen = JSON.parse(await fs.readFile(pluginCredentialPath(), 'utf8')) as MinimaxCodeCredentials
    expect(seen.refreshToken).toBe(refreshToken)
  })
  return seen!
}

function harness(region: 'cn' | 'global' = 'cn') {
  const store = new MinimaxCodeCredentialStore(region)
  const poolBackend = new PoolBackend(parseMinimaxCodePoolData)
  const pool = new MinimaxCodeAccountPool({ store, backend: poolBackend as never })
  return { pool, store, poolBackend }
}

describe('parseMinimaxCodePoolData', () => {
  it('rejects a payload that is not a pool document', () => {
    expect(() => parseMinimaxCodePoolData(null)).toThrow(/invalid/)
    expect(() => parseMinimaxCodePoolData([])).toThrow(/invalid/)
    expect(() => parseMinimaxCodePoolData('nope')).toThrow(/invalid/)
  })

  it('round-trips a native account without relabelling it as plugin-owned', () => {
    const parsed = parseMinimaxCodePoolData({
      version: 1,
      rotationStrategy: 'sticky',
      activeAccountId: 'a1',
      accounts: [{
        id: 'a1',
        alias: 'Desktop',
        addedAt: 5,
        isPrimary: true,
        region: 'global',
        source: 'minimax-native',
        credentials: {
          accessToken: 'at', refreshToken: 'rt', expiresAtMs: 1,
          region: 'global', source: 'minimax-native', recordKey: 'rk', buildEnv: 'prod',
        },
      }],
    })
    expect(parsed.rotationStrategy).toBe('sticky')
    expect(parsed.activeAccountId).toBe('a1')
    expect(parsed.accounts).toHaveLength(1)
    const account = parsed.accounts[0]!
    expect(account.region).toBe('global')
    expect(account.source).toBe('minimax-native')
    // Both survive: losing either would make a rotation land in the plugin's file
    // and offer a delete that must never be offered.
    expect(account.credentials.source).toBe('minimax-native')
    expect(account.credentials.recordKey).toBe('rk')
    expect(account.credentials.buildEnv).toBe('prod')
  })

  it('drops a row whose credential cannot serve a request', () => {
    const parsed = parseMinimaxCodePoolData({
      accounts: [{ id: 'broken', credentials: { refreshToken: 'rt' } }, 'not-an-object'],
    })
    expect(parsed.accounts).toEqual([])
  })
})

describe('MinimaxCodeAccountPool', () => {
  it('projects the pre-pool credential as the primary account without writing', async () => {
    await writePluginCredential(credential(1))
    const { pool, poolBackend } = harness()
    const save = vi.spyOn(poolBackend, 'save')

    const data = await pool.read()
    expect(save).not.toHaveBeenCalled()
    expect(data.accounts).toHaveLength(1)
    expect(data.accounts[0]!.id).toBe('acc_primary')
    expect(data.activeAccountId).toBe('acc_primary')
    expect((await pool.listAccounts())[0]).toMatchObject({
      email: 'user1@example.com',
      planLabel: 'Coding Pro',
      region: 'cn',
      source: 'file',
      removable: true,
      isPrimary: true,
    })
  })

  it('adds, promotes, aliases, re-strategises and deletes accounts', async () => {
    const { pool } = harness()
    const first = await pool.addAccount(credential(1))
    const second = await pool.addAccount(credential(2))
    expect(first.isPrimary).toBe(true)
    expect(second.isPrimary).toBe(false)
    expect((await pool.listAccounts()).map((entry) => entry.alias)).toEqual([
      'user1@example.com', 'user2@example.com',
    ])
    expect((await pool.listAccounts())[0]!.planLabel).toBe('Coding Pro')

    await pool.setPrimary(second.id)
    expect((await pool.read()).activeAccountId).toBe(second.id)
    await pool.setAlias(second.id, '  备用号  ')
    expect((await pool.listAccounts()).find((entry) => entry.id === second.id)!.alias).toBe('备用号')
    await pool.setStrategy('round-robin')
    expect((await pool.read()).rotationStrategy).toBe('round-robin')

    await pool.deleteAccount(first.id)
    const left = await pool.listAccounts()
    expect(left.map((entry) => entry.id)).toEqual([second.id])
    expect(left[0]!.isPrimary).toBe(true)
  })

  it('dedupes by identity rather than by a rotating token', async () => {
    const { pool } = harness()
    const first = await pool.addAccount(credential(1))
    // The same sign-in with a rotated pair keeps its slot.
    const again = await pool.addAccount(credential(1, { accessToken: 'at-new', refreshToken: 'rt-rotated' }))
    expect(again.id).toBe(first.id)
    expect(again.credentials.refreshToken).toBe('rt-rotated')
    expect(await pool.listAccounts()).toHaveLength(1)
    // A second, distinct sign-in is its own account.
    await pool.addAccount(credential(2))
    expect(await pool.listAccounts()).toHaveLength(2)
  })

  it('keys a native credential on its desktop record slot, not on its tokens', () => {
    const native = nativeCredential()
    expect(minimaxCodePoolIdentity(native)).toBe('native:cn:record-key-hash')
    // A rotation changes both tokens and keeps the identity.
    expect(minimaxCodePoolIdentity({ ...native, accessToken: 'a2', refreshToken: 'r2' }))
      .toBe('native:cn:record-key-hash')
    // A credential that states nothing stable has no key at all, so it is added
    // rather than merged into an unrelated row.
    expect(minimaxCodePoolIdentity(credential(1, { loginEpoch: '' }))).toBeUndefined()
    // Two sign-ins are two accounts, each with its own refresh chain.
    expect(minimaxCodePoolIdentity(credential(1))).toBe('signin:cn:signin-1')
  })

  it('marks the desktop-owned account removable:false and refuses to delete it', async () => {
    const { pool } = harness()
    const native = await pool.addAccount(nativeCredential())
    const managed = await pool.addAccount(credential(1))

    const summaries = await pool.listAccounts()
    const nativeSummary = summaries.find((entry) => entry.id === native.id)!
    expect(nativeSummary.removable).toBe(false)
    expect(nativeSummary.source).toBe('minimax-native')
    expect(summaries.find((entry) => entry.id === managed.id)!.removable).toBe(true)

    await expect(pool.deleteAccount(native.id)).rejects.toThrow(/不能删除/)
    expect(await pool.listAccounts()).toHaveLength(2)
  })

  it('refreshes a native account in its own region and writes the rotation back to the app file', async () => {
    const authFile = await writeNativeCredential('global')
    const { pool, store } = harness('global')
    const live = await store.read()
    expect(live?.source).toBe('minimax-native')
    const account = await pool.addAccount(nativeCredential({
      ...live!,
      expiresAtMs: Date.now() + 1_000,
    }))

    const tokenFetch = vi.fn(async (_input: RequestInfo | URL) => Response.json({
      access_token: 'at-refreshed', refresh_token: 'rt-refreshed', expires_in: 3_600, token_type: 'Bearer',
    }))
    const { credentials } = await pool.getEffectiveCredential(undefined, tokenFetch as unknown as typeof fetch)

    expect(tokenFetch).toHaveBeenCalledTimes(1)
    // A global account must never be refreshed through the cn property.
    expect(String(tokenFetch.mock.calls[0]![0])).toContain('account.minimax.io')
    expect(credentials.accessToken).toBe('at-refreshed')
    expect(credentials.region).toBe('global')
    // The pool remembers the rotation, and the desktop app's own file received it
    // in place — with its schema and record key intact.
    const stored = (await pool.read()).accounts.find((entry) => entry.id === account.id)!
    expect(stored.credentials.refreshToken).toBe('rt-refreshed')
    expect(stored.region).toBe('global')
    const document = JSON.parse(await fs.readFile(authFile, 'utf8')) as {
      schemaVersion: number
      records: Record<string, { refreshToken: string }>
    }
    expect(document.schemaVersion).toBe(1)
    expect(document.records['record-key-hash']!.refreshToken).toBe('rt-refreshed')
  })

  it('refreshes a plugin-owned account without touching the desktop app directory', async () => {
    const { pool } = harness()
    const account = await pool.addAccount(credential(1, { expiresAtMs: Date.now() + 1_000 }))

    const tokenFetch = vi.fn(async (_input: RequestInfo | URL) => Response.json({
      access_token: 'at-r', refresh_token: 'rt-r', expires_in: 3_600, token_type: 'Bearer',
    }))
    await pool.getEffectiveCredential(undefined, tokenFetch as unknown as typeof fetch)

    expect(String(tokenFetch.mock.calls[0]![0])).toContain('account.minimax.cn')
    expect((await pool.read()).accounts.find((entry) => entry.id === account.id)!.credentials.refreshToken)
      .toBe('rt-r')
    // Nothing was written under the app's auth directory: no file exists there.
    await expect(fs.readdir(path.join(minimaxHome, 'auth'))).rejects.toThrow()
    // The rotated pair did reach the plugin's own mirror file. The mirror write is
    // fire-and-forget by design (a bookkeeping write must never fail a request),
    // so the file is awaited rather than assumed to be there already.
    const mirrored = await waitForMirror('rt-r')
    expect(mirrored.refreshToken).toBe('rt-r')
  })

  it('marks an account expired when the service rejects its refresh, without deleting it', async () => {
    const { pool } = harness()
    const account = await pool.addAccount(credential(1, { expiresAtMs: Date.now() + 1_000 }))
    const tokenFetch = vi.fn(async () => Response.json({ error: 'invalid_grant' }, { status: 400 }))

    await expect(pool.getEffectiveCredential(undefined, tokenFetch as unknown as typeof fetch))
      .rejects.toBeInstanceOf(MinimaxCodeUnauthorizedError)

    const marked = (await pool.listAccounts()).find((entry) => entry.id === account.id)
    expect(marked).toBeDefined()
    expect(marked?.authStatus).toBe('expired')
    expect(marked?.removable).toBe(true)
  })

  it('stops routing to an account whose refresh token the token layer recorded as rejected', async () => {
    const { pool } = harness()
    const rejected = await pool.addAccount(credential(1, { refreshToken: 'rt-dead' }))
    const healthy = await pool.addAccount(credential(2))
    await pool.setPrimary(rejected.id)

    // The token layer records the rejection, exactly as a refresh would.
    const offending = new MinimaxCodeCredentialStore('cn')
    vi.spyOn(offending, 'read').mockResolvedValue(credential(1, { refreshToken: 'rt-dead' }))
    vi.spyOn(offending, 'write').mockResolvedValue(undefined)
    await ensureAccessToken(offending, {
      fetchFn: (async () => Response.json({ error: 'invalid_grant' }, { status: 400 })) as unknown as typeof fetch,
      force: true,
    }).catch(() => undefined)
    expect(isRefreshTokenRejected('rt-dead')).toBe(true)

    const effective = await pool.getEffectiveCredential()
    expect(effective.account.id).toBe(healthy.id)
    // The account stays listed: signing in again is what restores it.
    expect(await pool.listAccounts()).toHaveLength(2)
    expect((await pool.listAccounts()).find((entry) => entry.id === rejected.id)).toBeDefined()
  })

  it('reports the pool slice and the sign-in wording', async () => {
    const status = await minimaxCodePoolStatus(undefined)
    expect(status).toEqual({ accounts: [], rotationStrategy: 'sequential', poolInstalled: false })
    const { pool } = harness()
    await expect(pool.getEffectiveCredential()).rejects.toThrow(/Not signed in to MiniMax Code/)
    const installed = await minimaxCodePoolStatus(pool)
    expect(installed.poolInstalled).toBe(true)
    expect(installed.rotationStrategy).toBe('sequential')
  })

  it('adopts the desktop sign-in as an account and updates it in place on re-adopt', async () => {
    await writeNativeCredential('cn')
    const { pool, store } = harness()
    const adopted = await pool.adoptNativeAccount()
    expect(adopted.source).toBe('minimax-native')
    expect((await pool.listAccounts())[0]!.removable).toBe(false)

    // The first adopt mirrors its primary back through the store, fire-and-forget.
    // Draining that write through the store's own serialization queue before the
    // file is changed is what keeps a stale mirror write from landing on top of the
    // rotation and making this test flaky.
    await pool.mirrorStore().read()
    await writeNativeCredential('cn', { refreshToken: 'rt-rotated', accessToken: 'at-rotated' })
    const again = await pool.adoptNativeAccount()
    expect(again.id).toBe(adopted.id)
    expect(again.credentials.refreshToken).toBe('rt-rotated')
    expect(await pool.listAccounts()).toHaveLength(1)

    // Drain the pool's fire-and-forget primary mirror before deleting the app's
    // file: the write is queued on that very path, and a write already in flight
    // would atomically recreate `auth.json` after the removal and make this test
    // hang on a race rather than on behaviour.
    await store.read()
    // Once the app's file is gone there is nothing of its kind to adopt, and the
    // plugin's own mirror is not mistaken for it.
    await fs.rm(path.join(minimaxHome, 'auth', 'prod', 'cn', 'mcode-public', 'auth.json'), { force: true })
    await expect(pool.adoptNativeAccount()).rejects.toThrow(/桌面端/)
  })
})

describe('minimaxCodePoolPath', () => {
  it('lives under the harness home, not the desktop app directory', () => {
    const poolPath = minimaxCodePoolPath()
    expect(poolPath.endsWith(path.join('storages', 'minimax-code-pool.json'))).toBe(true)
    expect(poolPath.startsWith(dshHome)).toBe(true)
  })
})

describe('the /accounts route', () => {
  it('drives the account actions and refuses a cross-origin mutation', async () => {
    const { pool } = harness()
    await pool.addAccount(credential(1))
    const second = await pool.addAccount(credential(2))
    const handler = createMinimaxCodeAccountsHandler(pool)

    const status = fakeExchange()
    await handler(fakeRequest({ url: '/minimax-code/api/accounts' }), status.response)
    const value = status.captured.body as {
      value: { accounts: MinimaxCodeAccountSummaryDto[]; poolInstalled: boolean }
    }
    expect(value.value.accounts).toHaveLength(2)
    expect(value.value.poolInstalled).toBe(true)

    const promote = fakeExchange()
    await handler(
      fakeRequest({
        url: '/minimax-code/api/accounts',
        method: 'POST',
        body: { action: 'set-primary', accountId: second.id },
      }),
      promote.response,
    )
    expect(promote.captured.status).toBe(200)
    expect((promote.captured.body as { value: { activeAccountId?: string } }).value.activeAccountId)
      .toBe(second.id)

    const strategy = fakeExchange()
    await handler(
      fakeRequest({
        url: '/minimax-code/api/accounts',
        method: 'POST',
        body: { action: 'strategy', strategy: 'sticky' },
      }),
      strategy.response,
    )
    expect((strategy.captured.body as { value: { rotationStrategy: string } }).value.rotationStrategy)
      .toBe('sticky')

    const crossOrigin = fakeExchange()
    await handler(
      fakeRequest({
        url: '/minimax-code/api/accounts',
        method: 'POST',
        headers: { origin: 'https://evil.example' },
        body: { action: 'delete', accountId: second.id },
      }),
      crossOrigin.response,
    )
    expect(crossOrigin.captured.status).toBe(403)
    expect(await pool.listAccounts()).toHaveLength(2)

    // No response ever carries a credential.
    expect(JSON.stringify(crossOrigin.captured.body)).not.toContain('rt-2')
    expect(JSON.stringify(status.captured.body)).not.toContain('rt-1')
  })

  it('answers an unknown action and a missing pool without touching credentials', async () => {
    const { pool } = harness()
    const handler = createMinimaxCodeAccountsHandler(pool)
    const unknown = fakeExchange()
    await handler(
      fakeRequest({ url: '/minimax-code/api/accounts', method: 'POST', body: { action: 'nope' } }),
      unknown.response,
    )
    expect(unknown.captured.status).toBe(400)

    const none = createMinimaxCodeAccountsHandler(undefined)
    const read = fakeExchange()
    await none(fakeRequest({ url: '/minimax-code/api/accounts' }), read.response)
    expect((read.captured.body as { value: { poolInstalled: boolean } }).value.poolInstalled).toBe(false)
    const mutation = fakeExchange()
    await none(
      fakeRequest({
        url: '/minimax-code/api/accounts',
        method: 'POST',
        body: { action: 'strategy', strategy: 'sticky' },
      }),
      mutation.response,
    )
    expect(mutation.captured.status).toBe(400)
  })
})

describe('no pool path deletes a native credential file', () => {
  it('never removes the desktop app auth.json, even when every deletable account goes', async () => {
    const authFile = await writeNativeCredential('cn')
    const { pool, store } = harness()
    const live = await store.read()
    const adopted = await pool.addAccount(live!)
    const managed = await pool.addAccount(credential(1))
    expect((await pool.listAccounts()).find((entry) => entry.id === adopted.id)!.removable).toBe(false)

    // Every deletion-shaped path the pool exposes.
    await expect(pool.deleteAccount(adopted.id)).rejects.toThrow(/不能删除/)
    await pool.mirrorStore().delete()
    await pool.mirrorStore().write(credential(1))
    await pool.deleteAccount(managed.id)
    for (const account of await pool.listAccounts()) {
      if (account.removable === false) continue
      await pool.deleteAccount(account.id).catch(() => undefined)
    }

    const stillThere = await fs.readFile(authFile, 'utf8')
    expect(JSON.parse(stillThere).records['record-key-hash'].refreshToken).toBe('rt-native')
    // And the store still reports the app's session as in force.
    expect(await store.read()).not.toBeNull()
  })
})

interface FakeResponse { status: number; body: unknown }

function fakeExchange(): { response: ServerResponse; captured: FakeResponse } {
  const captured: FakeResponse = { status: 0, body: undefined }
  const response = {
    writeHead(status: number) { captured.status = status },
    end(raw?: string) { captured.body = raw === undefined ? undefined : JSON.parse(raw) },
  } as unknown as ServerResponse
  return { response, captured }
}

function fakeRequest(input: {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: unknown
}): IncomingMessage {
  const listeners = new Map<string, Array<(value?: unknown) => void>>()
  const request = {
    url: input.url,
    method: input.method ?? 'GET',
    headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', ...input.headers },
    on(event: string, listener: (value?: unknown) => void) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return request
    },
    destroy() {},
  } as unknown as IncomingMessage
  if (input.method === 'POST') {
    queueMicrotask(() => {
      if (input.body !== undefined) {
        listeners.get('data')?.forEach((listener) => listener(Buffer.from(JSON.stringify(input.body))))
      }
      listeners.get('end')?.forEach((listener) => listener())
    })
  }
  return request
}
