import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CODEX_AUTH_CLAIMS_KEY,
  codexAccountIdentity,
  codexUserId,
  extractIdentity,
  parseJwtClaims,
} from '../src/host/codex-identity.ts'
import { clearCachedCatalog, loadCodexCatalog } from '../src/host/codex-catalog.ts'
import { CodexAccountPool, parseCodexPoolData } from '../src/host/codex-account-pool.ts'
import { OAuthService } from '../src/host/oauth-service.ts'
import { MemoryTokenStore, parseStoredCredentials, type StoredOAuthCredentials } from '../src/host/token-store.ts'
import { UsageService } from '../src/host/usage-service.ts'

/*
 * Regression suite for issue #85.
 *
 * One ChatGPT WORKSPACE can have many members, and every member's token states
 * the same `chatgpt_account_id`. The pool used that id as its dedupe key, so
 * signing the second member in REPLACED the first: the card read "1 account
 * signed in", the earlier row was gone, and it could not be selected again. The
 * same key fed the refresh single-flight and the per-account caches, so two
 * members could share one refresh and one model listing.
 *
 * These tests are written the way the bug was reported: two members of ONE
 * workspace, each signed in separately, and they must stay two accounts.
 */

const WORKSPACE = 'ws-shared-0001'

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.')
}

interface Member {
  /** Stable id of the person; distinct per member of the workspace. */
  user: string
  email: string
  /** Which sign-in this is, so re-authorizing the same person rotates the tokens. */
  attempt?: number
}

/**
 * A credential as the live service mints one.
 *
 * The claim shape is the real one: `chatgpt_account_id` and `chatgpt_user_id` sit
 * inside the `https://api.openai.com/auth` object, which is why the pool never
 * saw the workspace as anything other than the whole identity.
 */
function credentialFor(
  member: Member,
  options: { workspace?: string; withUserId?: boolean; withSubject?: boolean } = {},
): StoredOAuthCredentials {
  const attempt = member.attempt ?? 1
  const auth: Record<string, unknown> = {
    chatgpt_account_id: options.workspace ?? WORKSPACE,
    chatgpt_plan_type: 'plus',
  }
  if (options.withUserId !== false) auth.chatgpt_user_id = member.user
  return {
    accessToken: jwt({ email: member.email, ...(options.withSubject === false ? {} : { sub: 'sub-' + member.user }), [CODEX_AUTH_CLAIMS_KEY]: auth }),
    refreshToken: `refresh-${member.user}-${attempt}`,
    expiresAt: Date.now() + 3_600_000,
    accountId: options.workspace ?? WORKSPACE,
    userId: options.withUserId === false ? undefined : member.user,
    email: member.email,
    planType: 'plus',
  }
}

const alice: Member = { user: 'user-alice', email: 'alice@example.com' }
const bob: Member = { user: 'user-bob', email: 'bob@example.com' }

/** Mirrors the platform backends: JSON on disk, and the parse hook on read. */
class MemoryBackend {
  private data: unknown = null
  constructor(private readonly parse: (value: unknown) => unknown) {}
  async load() { return this.data === null ? null : this.parse(JSON.parse(JSON.stringify(this.data))) }
  async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

function harness() {
  const backend = new MemoryBackend(parseCodexPoolData)
  const mirror = new MemoryTokenStore()
  const pool = new CodexAccountPool({ store: mirror, backend: backend as never })
  pool.setRefresher({
    refreshAccount: async (credentials) => ({
      ...credentials,
      accessToken: 'refreshed-' + credentials.accessToken,
      expiresAt: Date.now() + 3_600_000,
    }),
  })
  return { backend, mirror, pool }
}

beforeEach(() => {
  clearCachedCatalog()
})

describe('the local login identity', () => {
  it('separates two members of one workspace', () => {
    const first = codexAccountIdentity(credentialFor(alice))
    const second = codexAccountIdentity(credentialFor(bob))

    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first).not.toBe(second)
    // The workspace id is the shared half, so a key built from it alone would be
    // identical for both — the bug this suite exists for.
    expect(credentialFor(alice).accountId).toBe(credentialFor(bob).accountId)
  })

  it('keeps one identity across a re-authorization of the same person', () => {
    const first = codexAccountIdentity(credentialFor(alice))
    const second = codexAccountIdentity(credentialFor({ ...alice, attempt: 2 }))
    expect(second).toBe(first)
  })

  it('separates one person across two workspaces', () => {
    const here = codexAccountIdentity(credentialFor(alice))
    const elsewhere = codexAccountIdentity(credentialFor(alice, { workspace: 'ws-other-0002' }))
    expect(elsewhere).not.toBe(here)
  })

  it('falls back to the OIDC subject, then to the address', () => {
    // No `chatgpt_user_id` claim: the subject an id token always carries is the
    // next most explicit statement of who signed in.
    const bySubject = credentialFor(alice, { withUserId: false, withSubject: true })
    expect(codexUserId(bySubject)).toBe('sub-' + alice.user)
    expect(codexUserId(credentialFor(bob, { withUserId: false, withSubject: true }))).not.toBe(codexUserId(bySubject))
    expect(codexAccountIdentity(bySubject)).not.toBe(codexAccountIdentity(credentialFor(bob, { withUserId: false, withSubject: true })))

    // Neither claim: the address is all that is left, and it still separates two
    // members of the workspace.
    const bare = (member: Member): StoredOAuthCredentials => {
      const credentials = credentialFor(member, { withUserId: false, withSubject: false })
      return { ...credentials, userId: undefined, accessToken: jwt({ email: member.email, [CODEX_AUTH_CLAIMS_KEY]: { chatgpt_account_id: WORKSPACE } }) }
    }
    expect(codexUserId(bare(alice))).toBeUndefined()
    expect(codexAccountIdentity(bare(alice))).not.toBe(codexAccountIdentity(bare(bob)))
  })

  it('states no identity at all when the credential states nothing', () => {
    const anonymous: StoredOAuthCredentials = {
      accessToken: 'opaque-access',
      refreshToken: 'opaque-refresh',
      expiresAt: Date.now() + 3_600_000,
    }
    expect(codexAccountIdentity(anonymous)).toBeUndefined()
    // Two of them must not be silently merged into one account either: no key at
    // all means the pool mints an id per row, which is the honest answer.
    const other: StoredOAuthCredentials = { ...anonymous, refreshToken: 'opaque-refresh-2' }
    expect(codexAccountIdentity(other)).toBeUndefined()
    expect(codexAccountIdentity(other)).toBe(codexAccountIdentity(anonymous))
  })

  it('produces an opaque, file-name safe key rather than a readable join', () => {
    const key = codexAccountIdentity(credentialFor(alice))!
    // Hex survives `catalogSnapshotName`'s [a-z0-9] fold unchanged, so two keys can
    // never collide after folding, and no address is left on disk.
    expect(key).toMatch(/^v1-[0-9a-f]{32}$/)
    expect(key).not.toContain('@')
    expect(key).not.toContain(WORKSPACE)
    expect(key).not.toContain(alice.user)
  })

  it('reads the claims from both the id token and the nested auth object', () => {
    const claims = parseJwtClaims(jwt({ email: 'x@example.com', sub: 's', [CODEX_AUTH_CLAIMS_KEY]: { chatgpt_account_id: 'ws', chatgpt_user_id: 'u' } }))
    expect(claims?.email).toBe('x@example.com')
    const identity = extractIdentity({ accessToken: jwt({ [CODEX_AUTH_CLAIMS_KEY]: { chatgpt_account_id: 'ws', chatgpt_user_id: 'u' } }) })
    expect(identity).toMatchObject({ accountId: 'ws', userId: 'u' })
  })

  it('survives the storage validator', () => {
    const stored = parseStoredCredentials(credentialFor(alice))
    expect(stored.userId).toBe(alice.user)
    expect(codexAccountIdentity(stored)).toBe(codexAccountIdentity(credentialFor(alice)))
  })
})

describe('the ChatGPT account pool', () => {
  it('keeps two members of one workspace as two selectable accounts', async () => {
    const { pool } = harness()
    const first = await pool.addAccount(credentialFor(alice))
    const second = await pool.addAccount(credentialFor(bob))

    expect(second.id).not.toBe(first.id)
    expect(await pool.listAccounts()).toHaveLength(2)
    expect((await pool.listAccounts()).map((entry) => entry.email).sort()).toEqual([alice.email, bob.email])
    // Both stay addressable, which is what "the first account disappeared" broke.
    await pool.setPrimary(first.id)
    expect((await pool.getEffectiveAccount()).credentials.email).toBe(alice.email)
    await pool.setPrimary(second.id)
    expect((await pool.getEffectiveAccount()).credentials.email).toBe(bob.email)
  })

  it('updates the re-authorized member in place and leaves the other one alone', async () => {
    const { pool } = harness()
    const first = await pool.addAccount(credentialFor(alice))
    const second = await pool.addAccount(credentialFor(bob))

    const again = await pool.addAccount(credentialFor({ ...alice, attempt: 2 }))
    expect(again.id).toBe(first.id)
    const accounts = await pool.listAccounts()
    expect(accounts).toHaveLength(2)
    expect(accounts.find((entry) => entry.id === second.id)?.email).toBe(bob.email)
    expect((await pool.read()).accounts.find((entry) => entry.id === first.id)?.credentials.refreshToken).toBe('refresh-user-alice-2')
  })

  it('recognizes a row written before the credential carried a user id', async () => {
    const { pool } = harness()
    // A row from an earlier version: the tokens name the user, the row has no
    // `userId` field to read it from. The identity is therefore re-derived from the
    // stored tokens, which is what keeps an upgrade from duplicating every account.
    const first = await pool.addAccount({ ...credentialFor(alice), userId: undefined })

    const reauthorized = await pool.addAccount(credentialFor({ ...alice, attempt: 2 }))
    expect(reauthorized.id).toBe(first.id)
    expect(await pool.listAccounts()).toHaveLength(1)
  })
})

describe('the refresh single-flight key', () => {
  it('gives each member of a workspace its own refresh', async () => {
    const { pool, mirror } = harness()
    const first = await pool.addAccount(credentialFor(alice))
    const second = await pool.addAccount(credentialFor(bob))

    const tokenFetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const sent = new URLSearchParams(init?.body ?? '')
      await new Promise((resolve) => setTimeout(resolve, 5))
      return Response.json({ access_token: 'rotated-for-' + sent.get('refresh_token'), refresh_token: 'next', expires_in: 3600 })
    })
    const oauth = new OAuthService(mirror, { fetchFn: tokenFetch as unknown as typeof fetch, pool })

    const [left, right] = await Promise.all([
      oauth.refreshAccount(first.credentials),
      oauth.refreshAccount(second.credentials),
    ])
    // Two grants, two redemptions: sharing one would hand the other member's
    // rotated token to an account whose own grant is still unspent.
    expect(tokenFetch).toHaveBeenCalledTimes(2)
    expect(left.accessToken).toBe('rotated-for-refresh-user-alice-1')
    expect(right.accessToken).toBe('rotated-for-refresh-user-bob-1')
    oauth.dispose()
  })

  it('still single-flights two refreshes of the same member', async () => {
    const { pool, mirror } = harness()
    const account = await pool.addAccount(credentialFor(alice))
    const tokenFetch = vi.fn(async () => Response.json({ access_token: 'rotated', refresh_token: 'next', expires_in: 3600 }))
    const oauth = new OAuthService(mirror, { fetchFn: tokenFetch as unknown as typeof fetch, pool })

    await Promise.all([oauth.refreshAccount(account.credentials), oauth.refreshAccount(account.credentials)])
    expect(tokenFetch).toHaveBeenCalledTimes(1)
    oauth.dispose()
  })
})

describe('the model catalog cache', () => {
  const listing = (slug: string): Response => Response.json({ models: [{ slug, display_name: slug.toUpperCase() }] })

  it('files each member of a workspace under its own key', async () => {
    const fetchFn = vi.fn(async () => listing('shared-model'))
    const first = await loadCodexCatalog(credentialFor(alice), { fetchFn: fetchFn as unknown as typeof fetch })
    expect(first.map((entry) => entry.id)).toEqual(['shared-model'])

    // Same account, cached: no second call.
    await loadCodexCatalog(credentialFor({ ...alice, attempt: 2 }), { fetchFn: fetchFn as unknown as typeof fetch })
    expect(fetchFn).toHaveBeenCalledTimes(1)

    // A different member of the same workspace is a different scope, so its own
    // listing is fetched rather than answered with the first member's.
    await loadCodexCatalog(credentialFor(bob), { fetchFn: fetchFn as unknown as typeof fetch })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('answers a failed listing with this identity\'s own cache, never another member\'s', async () => {
    const ok = vi.fn(async () => listing('alice-model'))
    await loadCodexCatalog(credentialFor(alice), { fetchFn: ok as unknown as typeof fetch })

    const failing = vi.fn(async () => new Response('nope', { status: 500 }))
    const models = await loadCodexCatalog(credentialFor(bob), { fetchFn: failing as unknown as typeof fetch })
    // The shipped table stands in; alice's listing must not.
    expect(models).toEqual([])

    // And the same identity still gets its own cache back.
    const held = await loadCodexCatalog(credentialFor(alice), { fetchFn: failing as unknown as typeof fetch })
    expect(held.map((entry) => entry.id)).toEqual(['alice-model'])
  })
})

describe('the credential-derived quota key', () => {
  it('does not hand one member of a workspace the other member\'s reading', async () => {
    // A composition without a pool: the reading is filed under the credential
    // identity, which used to be the shared workspace id for both members of one.
    const mirror = new MemoryTokenStore()
    await mirror.save(credentialFor(alice))
    const oauth = new OAuthService(mirror)
    const usage = new UsageService(oauth, {
      fetchFn: (async () => Response.json({
        rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 18_000, reset_at: Math.floor(Date.now() / 1000) + 3600 } },
      })) as unknown as typeof fetch,
    })

    await usage.status(true, true)
    expect(usage.snapshotFor(undefined, credentialFor(alice))?.usage.buckets[0]?.windows[0]?.usedPercent).toBe(42)
    // The other member of the same workspace has never been read, and must not be
    // answered with this one's numbers.
    expect(usage.snapshotFor(undefined, credentialFor(bob))).toBeUndefined()
    oauth.dispose()
  })
})
