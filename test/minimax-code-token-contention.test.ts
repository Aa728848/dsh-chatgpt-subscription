import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  MinimaxCodeCredentialStore,
  credentialNeedsRefresh,
  credentialIsFresh,
  pluginCredentialPath,
  minimaxCodeSameCredentialSession,
  resetMinimaxCodeCredentialReads,
  rotateMinimaxCodeCredential,
  type MinimaxCodeCredentials,
} from '../src/host/minimax-code/token-store.ts'
import {
  MinimaxCodeAccountPool,
  parseMinimaxCodePoolData,
} from '../src/host/minimax-code/account-pool.ts'
import {
  MinimaxCodeUnauthorizedError,
  ensureAccessToken,
  isRefreshTokenRejected,
  resetInFlightRefreshes,
  resetRefreshRejections,
} from '../src/host/minimax-code/oauth.ts'

/**
 * The one-hour sign-out, as a test.
 *
 * The access token this line holds lives ONE HOUR. Before this suite existed the
 * plugin only rotated inside the last sixty seconds of that hour, and two callers
 * reaching that boundary together would each spend the same single-use refresh
 * token: the loser was told \`invalid_grant\`, the plugin recorded a perfectly
 * healthy sign-in as dead, and the card asked the user to sign in again — once an
 * hour, forever.
 *
 * Every case below is one link in that chain, and the fixtures are built so that
 * WALL-CLOCK ORDER DOES NOT MATTER: a rotation that has happened is expressed by
 * the credential on disk, not by who happened to run first.
 */

let dshHome = ''
let minimaxHome = ''

beforeEach(async () => {
  resetRefreshRejections()
  resetInFlightRefreshes()
  resetMinimaxCodeCredentialReads()
  dshHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-minimax-hour-'))
  // An EMPTY MiniMax home: no case may read the developer's real ~/.minimax.
  minimaxHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-minimax-hour-native-'))
  process.env.DSH_HOME = dshHome
  process.env.MINIMAX_HOME = minimaxHome
})

afterEach(async () => {
  resetRefreshRejections()
  resetInFlightRefreshes()
  resetMinimaxCodeCredentialReads()
  delete process.env.DSH_HOME
  delete process.env.MINIMAX_HOME
  vi.restoreAllMocks()
  // Named files, then the directories deepest-first. A recursive delete walks
  // through a junction and destroys its target, so it is not used here.
  await fs.rm(pluginCredentialPath(), { force: true }).catch(() => undefined)
  for (const directory of [path.join(dshHome, 'storages'), dshHome, minimaxHome]) {
    await fs.rmdir(directory).catch(() => undefined)
  }
})

/** A plugin-owned credential, one hour long, exactly as the line issues them. */
function credential(overrides: Partial<MinimaxCodeCredentials> = {}): MinimaxCodeCredentials {
  return {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    tokenType: 'Bearer',
    clientId: 'mcode-public',
    scopes: ['agent.default'],
    audience: 'agent-backend',
    expiresAtMs: Date.now() + 3_600_000,
    generation: 1,
    loginEpoch: 'signin-1',
    buildEnv: 'prod',
    region: 'cn',
    recordKey: null,
    source: 'file',
    ...overrides,
  }
}

/** A token response in the measured shape. */
function tokenResponse(accessToken: string, refreshToken: string | undefined, expiresInSec = 3600): Response {
  return Response.json({
    access_token: accessToken,
    ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
    token_type: 'Bearer',
    expires_in: expiresInSec,
  })
}

/** One refresh token endpoint that counts what it was asked to spend. */
function tokenEndpoint(script: (refreshToken: string) => Response): {
  fetchFn: typeof fetch
  spent: string[]
} {
  const spent: string[] = []
  const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body ?? '')
    const refreshToken = new URLSearchParams(body).get('refresh_token') ?? ''
    spent.push(refreshToken)
    return script(refreshToken)
  }) as unknown as typeof fetch
  return { fetchFn, spent }
}

/** Write the plugin's own credential file, the one CredentialStore.read() falls to. */
async function writePluginCredential(value: MinimaxCodeCredentials): Promise<void> {
  const file = pluginCredentialPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8')
}

/** A pool backed by an in-memory document, so no DPAPI helper is spawned. */
class PoolBackend {
  private data: unknown = null
  async load() { return this.data === null ? null : parseMinimaxCodePoolData(JSON.parse(JSON.stringify(this.data))) }
  async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

describe('the pre-expiry renewal that removes the hourly sign-out', () => {
  it('renews five minutes before expiry instead of only at the boundary', async () => {
    const store = new MinimaxCodeCredentialStore()
    // Three minutes left: still valid by every OLD rule — the freshness test only
    // asks "more than sixty seconds" — and exactly what the pre-expiry window is
    // for. Before this fix the token would have been presented as-is until it was
    // refused, which is the boundary two callers could both reach at once.
    const halfway = credential({ expiresAtMs: Date.now() + 3 * 60_000 })
    expect(credentialIsFresh(halfway)).toBe(true)
    expect(credentialNeedsRefresh(halfway)).toBe(true)

    await store.write(halfway)
    const { fetchFn, spent } = tokenEndpoint(() => tokenResponse('at-2', 'rt-2'))
    const next = await ensureAccessToken(store, { fetchFn })

    // The rotation happened BEFORE the service could refuse the token, which is
    // what keeps a burst of tool calls off the one boundary that used to trap it.
    expect(spent).toEqual(['rt-1'])
    expect(next.accessToken).toBe('at-2')
    expect(next.refreshToken).toBe('rt-2')
    expect(next.expiresAtMs).toBeGreaterThan(Date.now() + 59 * 60_000)
  })

  it('still uses a token that is comfortably valid without touching the network', async () => {
    const store = new MinimaxCodeCredentialStore()
    await store.write(credential({ expiresAtMs: Date.now() + 45 * 60_000 }))
    const { fetchFn, spent } = tokenEndpoint(() => tokenResponse('at-2', 'rt-2'))

    const current = await ensureAccessToken(store, { fetchFn })
    expect(current.accessToken).toBe('at-1')
    expect(spent).toEqual([])
  })

  it('keeps the presented refresh token when the response omits a new one', async () => {
    const store = new MinimaxCodeCredentialStore()
    await store.write(credential({ expiresAtMs: Date.now() + 1_000 }))
    const { fetchFn } = tokenEndpoint(() => tokenResponse('at-2', undefined))

    const next = await ensureAccessToken(store, { fetchFn })
    // RFC 6749 makes the field optional. Reading a successful rotation as a failure
    // because of its absence was one more way to sign the user out at the hour.
    expect(next.refreshToken).toBe('rt-1')
    expect(next.accessToken).toBe('at-2')
  })
})

describe('one rotating refresh token is never spent twice', () => {
  it('shares a single rotation between concurrent callers of one credential', async () => {
    const store = new MinimaxCodeCredentialStore()
    await store.write(credential({ expiresAtMs: Date.now() + 1_000 }))
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const spent: string[] = []
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      spent.push(new URLSearchParams(String(init?.body ?? '')).get('refresh_token') ?? '')
      await gate
      return tokenResponse('at-2', 'rt-2')
    }) as unknown as typeof fetch

    const first = ensureAccessToken(store, { fetchFn })
    const second = ensureAccessToken(store, { fetchFn })
    release()
    const [a, b] = await Promise.all([first, second])

    expect(spent).toEqual(['rt-1'])
    expect(a.accessToken).toBe('at-2')
    expect(b.accessToken).toBe('at-2')
  })

  it('makes a rotation started by the desktop app an adoption, not a second spend', async () => {
    const store = new MinimaxCodeCredentialStore()
    // What this plugin holds, and what the app has already rotated it into.
    await store.write(credential({ refreshToken: 'rt-spent', expiresAtMs: Date.now() + 60_000 }))
    const { fetchFn, spent } = tokenEndpoint(() => tokenResponse('at-x', 'rt-x'))
    await fs.writeFile(
      pluginCredentialPath(),
      JSON.stringify(credential({ accessToken: 'at-app', refreshToken: 'rt-app', generation: 2, expiresAtMs: Date.now() + 3_600_000 })),
      'utf8',
    )

    const next = await ensureAccessToken(store, { fetchFn })
    expect(spent).toEqual([])
    expect(next.refreshToken).toBe('rt-app')
    expect(next.accessToken).toBe('at-app')
  })

  it('adopts the rotation instead of recording a false rejection', async () => {
    const store = new MinimaxCodeCredentialStore()
    await store.write(credential({ refreshToken: 'rt-spent', expiresAtMs: Date.now() + 1_000 }))
    // The race, in the only order that matters: this call presents the token, and
    // WHILE it is in flight the other holder rotates it and lands the result. The
    // service cannot tell that apart from a dead sign-in, so it answers exactly as
    // it would for one.
    const spent: string[] = []
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      spent.push(new URLSearchParams(String(init?.body ?? '')).get('refresh_token') ?? '')
      await fs.writeFile(
        pluginCredentialPath(),
        JSON.stringify(credential({ accessToken: 'at-winner', refreshToken: 'rt-winner', generation: 2, expiresAtMs: Date.now() + 3_600_000 })),
        'utf8',
      )
      return Response.json({ error: 'invalid_grant' }, { status: 400 })
    }) as unknown as typeof fetch

    const next = await ensureAccessToken(store, { fetchFn, force: true })
    // This call did spend the token it held — it could not know — but the answer it
    // gives back is the winner's credential, not a sign-in prompt.
    expect(spent).toEqual(['rt-spent'])
    expect(next.refreshToken).toBe('rt-winner')
    // THE bug: this used to be true, and it is what put "sign in again" on a
    // healthy card for the rest of the cooldown window.
    expect(isRefreshTokenRejected('rt-spent')).toBe(false)
  })

  it('still records a rejection when the stored credential is the rejected one', async () => {
    const store = new MinimaxCodeCredentialStore()
    await store.write(credential({ refreshToken: 'rt-dead', expiresAtMs: Date.now() + 1_000 }))
    const { fetchFn } = tokenEndpoint(() => Response.json({ error: 'invalid_grant' }, { status: 400 }))

    await expect(ensureAccessToken(store, { fetchFn, force: true })).rejects.toBeInstanceOf(MinimaxCodeUnauthorizedError)
    // No other holder rotated: this sign-in really is gone, and saying so once is
    // the whole point of the tombstone.
    expect(isRefreshTokenRejected('rt-dead')).toBe(true)
    const wrapper = new MinimaxCodeCredentialStore()
    await wrapper.read()
    await expect(ensureAccessToken(wrapper)).rejects.toBeInstanceOf(MinimaxCodeUnauthorizedError)
  })

  it('does not let an older copy roll a newer rotation back', async () => {
    const stale = credential({ refreshToken: 'rt-old', generation: 1 })
    const rotated = credential({ refreshToken: 'rt-new', generation: 2, expiresAtMs: stale.expiresAtMs + 3_600_000 })
    const { credentials, adopted } = await rotateMinimaxCodeCredential(
      new MinimaxCodeCredentialStore(),
      stale,
      async () => stale,
    )
    expect(adopted).toBe(false)
    expect(credentials.refreshToken).toBe('rt-old')
    expect(minimaxCodeSameCredentialSession(rotated, stale)).toBe(true)
  })
})

describe('the account row heals itself after a rotation race', () => {
  it('clears an expired marker once storage holds a newer credential of that session', async () => {
    const store = new MinimaxCodeCredentialStore()
    const backend = new PoolBackend()
    const pool = new MinimaxCodeAccountPool({ store, backend: backend as never })
    const account = await pool.addAccount(credential({ refreshToken: 'rt-spent', expiresAtMs: Date.now() + 60_000 }))
    // Exactly what a lost rotation race writes into the pool row.
    await pool.markAuthFailed(account.id, 'MiniMax Code rejected the stored refresh token rt-s…', 'expired')
    expect((await pool.listAccounts())[0]?.authStatus).toBe('expired')

    // The winner's rotation, in the file this store owns.
    await store.write(credential({
      accessToken: 'at-winner',
      refreshToken: 'rt-winner',
      generation: 2,
      expiresAtMs: Date.now() + 3_600_000,
    }))

    const healed = await pool.listAccounts()
    expect(healed[0]?.authStatus).toBeUndefined()
    expect(healed[0]?.authFailedReason).toBeUndefined()
    // The row adopted the credential that is actually in force, so the next request
    // presents a live token rather than the spent one.
    const effective = await pool.getEffectiveCredential()
    expect(effective.credentials.refreshToken).toBe('rt-winner')
  })

  it('keeps the marker when the stored credential is still the rejected one', async () => {
    const store = new MinimaxCodeCredentialStore()
    const pool = new MinimaxCodeAccountPool({ store, backend: new PoolBackend() as never })
    const account = await pool.addAccount(credential({ refreshToken: 'rt-dead', expiresAtMs: Date.now() + 60_000 }))
    await pool.markAuthFailed(account.id, 'rejected', 'expired')
    await store.write(credential({ refreshToken: 'rt-dead', expiresAtMs: Date.now() + 60_000 }))

    // Nothing rotated, so this row genuinely needs a sign-in and must keep saying so.
    expect((await pool.listAccounts())[0]?.authStatus).toBe('expired')
  })

  it('does not adopt a different account out of the shared mirror file', async () => {
    const store = new MinimaxCodeCredentialStore()
    const pool = new MinimaxCodeAccountPool({ store, backend: new PoolBackend() as never })
    const account = await pool.addAccount(credential({ refreshToken: 'rt-mine', loginEpoch: 'signin-mine' }))
    await pool.markAuthFailed(account.id, 'rejected', 'expired')
    // A DIFFERENT sign-in is primary, so the single-credential file is its mirror.
    await store.write(credential({
      accessToken: 'at-stranger',
      refreshToken: 'rt-stranger',
      loginEpoch: 'signin-stranger',
      expiresAtMs: Date.now() + 3_600_000,
    }))

    // Adopting it would present one account's session as another's, so the marker
    // stays even though the file is newer.
    expect((await pool.listAccounts())[0]?.authStatus).toBe('expired')
  })

  it('routes to the healed account without waiting for the card', async () => {
    const store = new MinimaxCodeCredentialStore()
    const pool = new MinimaxCodeAccountPool({ store, backend: new PoolBackend() as never })
    const account = await pool.addAccount(credential({ refreshToken: 'rt-spent', expiresAtMs: Date.now() + 60_000 }))
    await pool.markAuthFailed(account.id, 'rejected', 'expired')
    await store.write(credential({ refreshToken: 'rt-winner', generation: 2, expiresAtMs: Date.now() + 3_600_000 }))

    // getEffectiveAccount is the request path: it must not answer "all accounts
    // need a new sign-in" for a session that is demonstrably alive on disk.
    const effective = await pool.getEffectiveCredential()
    expect(effective.credentials.refreshToken).toBe('rt-winner')
  })

  it('renews a rotation the pool did not perform instead of spending a dead token', async () => {
    const store = new MinimaxCodeCredentialStore()
    const pool = new MinimaxCodeAccountPool({ store, backend: new PoolBackend() as never })
    const account = await pool.addAccount(credential({ refreshToken: 'rt-spent', expiresAtMs: Date.now() + 1_000 }))
    // Somebody else rotated: the token the row holds is already gone.
    await store.write(credential({ refreshToken: 'rt-live', generation: 2, expiresAtMs: Date.now() + 3_600_000 }))

    const { fetchFn, spent } = tokenEndpoint(() => tokenResponse('at-x', 'rt-x'))
    const effective = await pool.getEffectiveCredential(undefined, fetchFn)

    expect(spent).toEqual([])
    expect(effective.credentials.refreshToken).toBe('rt-live')
    const row = (await pool.listAccounts()).find((entry) => entry.id === account.id)
    expect(row?.authStatus).toBeUndefined()
  })
})
