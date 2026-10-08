import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CODEX_RESPONSES_URL, OAUTH_TOKEN_URL } from '../src/compat.ts'
import {
  ADOPTED_NEVER_REFRESHED_MESSAGE,
  CodexAccountPool,
  CodexAdoptedCredentialError,
  codexAccountQuota,
  codexAuthRejectedReason,
  codexNeedsRefresh,
  isAdoptedCodexPoolCredential,
  parseCodexPoolData,
} from '../src/host/codex-account-pool.ts'
import {
  ADOPTED_CODEX_CREDENTIAL_EXPIRED_HINT,
  CODEX_CLI_CREDENTIAL_SOURCE,
} from '../src/host/codex-adopt.ts'
import { OAuthService, OAuthServiceError } from '../src/host/oauth-service.ts'
import { ResponsesClient } from '../src/host/responses-client.ts'
import { MemoryTokenStore, type StoredOAuthCredentials } from '../src/host/token-store.ts'
import { UsageService } from '../src/host/usage-service.ts'

/** A credential the Codex CLI already holds, marked as a borrowed snapshot. */
function adoptedCredential(
  n: number,
  expiresInMs = 3_600_000,
  sourcePath = 'C:\\Users\\a\\.codex\\auth.json',
): StoredOAuthCredentials {
  return {
    accessToken: `adopted-access-${n}`,
    refreshToken: `adopted-refresh-${n}`,
    expiresAt: Date.now() + expiresInMs,
    accountId: `adopted-acct-${n}`,
    email: `adopted${n}@example.com`,
    planType: 'plus',
    adopted: true,
    source: CODEX_CLI_CREDENTIAL_SOURCE,
    sourcePath,
  }
}

/** Mirrors the platform backends: JSON on disk, and the parse hook on read. */
class MemoryBackend {
  private data: unknown = null
  constructor(private readonly parse: (value: unknown) => unknown) {}
  async load() { return this.data === null ? null : this.parse(JSON.parse(JSON.stringify(this.data))) }
  async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

function credential(n: number, expiresInMs = 3_600_000): StoredOAuthCredentials {
  return {
    accessToken: `access-${n}`,
    refreshToken: `refresh-${n}`,
    expiresAt: Date.now() + expiresInMs,
    accountId: `acct-${n}`,
    email: `user${n}@example.com`,
    planType: 'plus',
  }
}

function harness(options: { store?: MemoryTokenStore } = {}) {
  const backend = new MemoryBackend(parseCodexPoolData)
  const mirror = options.store ?? new MemoryTokenStore()
  const pool = new CodexAccountPool({ store: mirror, backend: backend as never })
  const refreshed: StoredOAuthCredentials[] = []
  pool.setRefresher({
    refreshAccount: async (credentials) => {
      refreshed.push(credentials)
      return { ...credentials, accessToken: `refreshed-${credentials.accessToken}`, expiresAt: Date.now() + 3_600_000 }
    },
  })
  return { backend, mirror, pool, refreshed }
}

function sse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('CodexAccountPool', () => {
  it('projects the pre-pool credential as the primary account without writing', async () => {
    const backend = new MemoryBackend(parseCodexPoolData)
    const mirror = new MemoryTokenStore()
    await mirror.save(credential(1))
    const save = vi.spyOn(backend, 'save')
    const pool = new CodexAccountPool({ store: mirror, backend: backend as never })

    const data = await pool.read()
    expect(data.accounts).toHaveLength(1)
    expect(data.accounts[0]!.id).toBe('acc_primary')
    expect(data.accounts[0]!.isPrimary).toBe(true)
    expect(data.activeAccountId).toBe('acc_primary')
    expect(save).not.toHaveBeenCalled()

    const accounts = await pool.listAccounts()
    expect(accounts[0]).toMatchObject({ alias: 'user1@example.com', email: 'user1@example.com', planLabel: 'plus' })
  })

  it('adds a second account without displacing the mirrored primary credential', async () => {
    const { pool, mirror } = harness()
    const first = await pool.addAccount(credential(1))
    const second = await pool.addAccount(credential(2))

    expect(first.isPrimary).toBe(true)
    expect(second.isPrimary).toBe(false)
    expect((await mirror.load())?.accountId).toBe('acct-1')
    expect(await pool.listAccounts()).toHaveLength(2)

    // Signing the same account in again replaces it in place.
    const again = await pool.addAccount({ ...credential(1), planType: 'pro' })
    expect(again.id).toBe(first.id)
    expect(again.isPrimary).toBe(true)
    expect(await pool.listAccounts()).toHaveLength(2)
    expect((await pool.listAccounts())[0]!.planLabel).toBe('pro')
  })

  it('rotates over eligible accounts and cools a 429 account down', async () => {
    const { pool } = harness()
    const first = await pool.addAccount(credential(1))
    const second = await pool.addAccount(credential(2))
    await pool.setPrimary(first.id)

    expect((await pool.getEffectiveAccount()).account.id).toBe(first.id)
    await pool.markCooldown(first.id, 600_000, 'Codex 429')
    expect((await pool.getEffectiveAccount()).account.id).toBe(second.id)
    expect((await pool.listAccounts()).find((entry) => entry.id === first.id)?.cooldownReason).toBe('Codex 429')

    await pool.clearCooldown(first.id)
    await pool.setStrategy('round-robin')
    expect((await pool.getEffectiveAccount()).account.id).toBe(first.id)

    await pool.markCooldown(second.id, 600_000, 'Codex 429')
    await pool.markCooldown(first.id, 600_000, 'Codex 429')
    await expect(pool.getEffectiveAccount()).rejects.toMatchObject({ code: 'RATE_LIMIT' })
  })

  it('keeps a failed account in the pool but out of rotation until it signs in again', async () => {
    const { pool } = harness()
    const first = await pool.addAccount(credential(1))
    const second = await pool.addAccount(credential(2))
    await pool.setPrimary(first.id)

    await pool.markAuthFailed(first.id, 'refresh token rejected')
    const accounts = await pool.listAccounts()
    expect(accounts.find((entry) => entry.id === first.id)).toMatchObject({
      authStatus: 'expired',
      authFailedReason: 'refresh token rejected',
    })
    expect((await pool.getEffectiveAccount()).account.id).toBe(second.id)

    await pool.addAccount(credential(1))
    expect((await pool.listAccounts()).find((entry) => entry.id === first.id)?.authStatus).toBeUndefined()
  })

  it('skips an account whose cached Codex window is spent', async () => {
    const { pool } = harness()
    const first = await pool.addAccount(credential(1))
    const second = await pool.addAccount(credential(2))
    await pool.setPrimary(first.id)
    pool.setQuotaBlockedUntil((account, now) => (account.id === first.id ? now + 600_000 : undefined))

    expect((await pool.getEffectiveAccount()).account.id).toBe(second.id)
    pool.setQuotaBlockedUntil(() => undefined)
    expect((await pool.getEffectiveAccount()).account.id).toBe(first.id)
  })

  it('refreshes an about-to-expire token and mirrors it when the account is primary', async () => {
    const { pool, mirror, refreshed } = harness()
    await pool.addAccount(credential(1, 10_000))

    const { credentials } = await pool.getEffectiveAccount()
    expect(credentials.accessToken).toBe('refreshed-access-1')
    expect(refreshed).toHaveLength(1)
    expect((await pool.read()).accounts[0]!.credentials.accessToken).toBe('refreshed-access-1')
    expect((await mirror.load())?.accessToken).toBe('refreshed-access-1')
  })

  it('persists the rotated refresh token on a forced refresh', async () => {
    const { pool } = harness()
    const account = await pool.addAccount(credential(1))
    const next = await pool.refreshAccountNow(account.id)
    expect(next.accessToken).toBe('refreshed-access-1')
    expect((await pool.read()).accounts[0]!.credentials.accessToken).toBe('refreshed-access-1')
  })

  it('rejects pool payloads that are not a pool document', () => {
    expect(() => parseCodexPoolData(null)).toThrow(/invalid/)
    expect(parseCodexPoolData({ version: 1, rotationStrategy: 'sticky', accounts: [] })).toMatchObject({
      version: 1,
      rotationStrategy: 'sticky',
    })
    expect(parseCodexPoolData({ accounts: [] }).rotationStrategy).toBe('sequential')
  })
})

describe('an adopted snapshot is borrowed, never owned', () => {
  it('never refreshes it, even with a token about to expire', async () => {
    const { pool, refreshed } = harness()
    // 10 seconds left: a managed credential this close to expiry is refreshed.
    const adopted = await pool.addAccount(adoptedCredential(1, 10_000))

    const { credentials } = await pool.getEffectiveAccount()

    // The very token that was imported, untouched.
    expect(credentials.accessToken).toBe('adopted-access-1')
    expect(refreshed).toHaveLength(0)
    // The predicate, asked directly, so the guarantee is not only observable
    // through the pool: the refresh hook is never even offered the credential.
    expect(codexNeedsRefresh(credentials, Date.now())).toBe(false)
    // ...while a managed credential in the same shape IS due a refresh.
    expect(codexNeedsRefresh(credential(9, 10_000), Date.now())).toBe(true)
  })

  it('refuses a forced refresh with its own error class, never a 401', async () => {
    const { pool, refreshed } = harness()
    const adopted = await pool.addAccount(adoptedCredential(1))
    // The public "renew this account now" path a 401 recovery takes.
    const attempt = pool.refreshAccountNow(adopted.id)

    await expect(attempt).rejects.toBeInstanceOf(CodexAdoptedCredentialError)
    await expect(attempt).rejects.not.toBeInstanceOf(OAuthServiceError)
    expect(refreshed).toHaveLength(0)
    // The stored credential is exactly what was imported.
    expect((await pool.read()).accounts[0]!.credentials.accessToken).toBe('adopted-access-1')
    expect(ADOPTED_NEVER_REFRESHED_MESSAGE).toContain('Codex CLI')
  })

  it('reports removable: false and names the file it was read from', async () => {
    const { pool } = harness()
    const sourcePath = 'C:\\Users\\a\\.codex\\auth.json'
    await pool.addAccount(adoptedCredential(1, 3_600_000, sourcePath))
    await pool.addAccount(credential(2))

    const rows = await pool.listAccounts()
    const imported = rows.find((row) => row.email === 'adopted1@example.com')!
    const managed = rows.find((row) => row.email === 'user2@example.com')!

    expect(imported).toMatchObject({ adopted: true, source: 'codex', removable: false, sourcePath })
    // A managed row is unchanged by any of this: still deletable, still managed.
    expect(managed).toMatchObject({ adopted: false, source: 'managed', removable: true })
    expect(managed.sourcePath).toBeUndefined()
  })

  it('takes an expired snapshot out of rotation WITHOUT a write, and says where to re-sign in', async () => {
    const { pool } = harness()
    const save = vi.spyOn((pool as unknown as { backend: { save: (data: unknown) => Promise<void> } }).backend, 'save')
    const managed = await pool.addAccount(credential(1))
    // Already expired on arrival: the snapshot was imported, and the CLI's own
    // token lapsed while it sat there.
    await pool.addAccount({ ...adoptedCredential(2, -1_000) })
    save.mockClear()

    const rejected = (await pool.listAccounts()).find((row) => row.email === 'adopted2@example.com')!
    expect(rejected).toMatchObject({ authStatus: 'expired', authFailedReason: ADOPTED_CODEX_CREDENTIAL_EXPIRED_HINT })
    // The read that produced that verdict wrote nothing.
    expect(save).not.toHaveBeenCalled()
    // And the expired row is not the one that serves a request.
    expect((await pool.getEffectiveAccount()).account.id).toBe(managed.id)
    // The predicate is the seam, so the rule is testable without the pool too.
    expect(codexAuthRejectedReason({ ...adoptedCredential(2, -1_000) })).toBe(ADOPTED_CODEX_CREDENTIAL_EXPIRED_HINT)
    expect(codexAuthRejectedReason(adoptedCredential(2))).toBeUndefined()
    // A managed credential is never refused by this hook; the core's own auth
    // status is what takes one out of rotation.
    expect(codexAuthRejectedReason(credential(1))).toBeUndefined()
  })

  it('survives a pool file round trip with its marker intact', async () => {
    const backend = new MemoryBackend(parseCodexPoolData)
    const mirror = new MemoryTokenStore()
    const first = new CodexAccountPool({ store: mirror, backend: backend as never })
    await first.addAccount(adoptedCredential(1))
    await first.addAccount(credential(2))
    const importId = (await first.read()).accounts.find((row) => row.adopted)!.id

    // A second pool over the SAME stored document: this is a restart, and it is
    // the case that matters, because a marker dropped by a write would come back
    // looking plugin-owned and would then be refreshed.
    const second = new CodexAccountPool({ store: mirror, backend: backend as never })
    const restored = (await second.read()).accounts.find((row) => row.id === importId)!

    expect(restored.adopted).toBe(true)
    expect(restored.source).toBe(CODEX_CLI_CREDENTIAL_SOURCE)
    expect(restored.credentials.adopted).toBe(true)
    expect(restored.credentials.source).toBe(CODEX_CLI_CREDENTIAL_SOURCE)
    expect(restored.sourcePath).toBe('C:\\Users\\a\\.codex\\auth.json')
    expect(isAdoptedCodexPoolCredential(restored.credentials)).toBe(true)
    // Still not refreshable after the restart.
    expect(codexNeedsRefresh(restored.credentials, Date.now())).toBe(false)
    expect((await second.listAccounts()).find((row) => row.id === importId)?.removable).toBe(false)
  })

  it('writes the explicit false so a re-authorization unfreezes the row', async () => {
    const backend = new MemoryBackend(parseCodexPoolData)
    const pool = new CodexAccountPool({ store: new MemoryTokenStore(), backend: backend as never })
    const sourcePath = 'C:\\Users\\a\\.codex\\auth.json'
    // The SAME account, imported and then signed in through this plugin. The
    // dedupe key is the accountId, and the imported snapshot states the very id
    // the managed sign-in does — which is the only thing that lets one row be
    // recognized as the other without asking the user.
    const imported = { ...adoptedCredential(1, 3_600_000, sourcePath), accountId: 'acct-1' }
    await pool.addAccount(imported)
    const reauthorized = await pool.addAccount({ ...credential(1, 3_600_000), accessToken: 'managed-access-1' })

    // One row, not two, and it is plugin-owned again.
    expect((await pool.read()).accounts).toHaveLength(1)
    expect(reauthorized.adopted).toBe(false)
    expect(reauthorized.source).toBe('managed')
    expect(reauthorized.credentials.adopted).toBeUndefined()
    expect(reauthorized.sourcePath).toBeUndefined()
    // A managed credential is refreshable again, which is the whole point.
    expect(codexNeedsRefresh(reauthorized.credentials, Date.now())).toBe(false)
    expect((await pool.listAccounts())[0]).toMatchObject({ adopted: false, removable: true })
    // ...and the marker is gone from disk too, not just in memory.
    const reloaded = new CodexAccountPool({ store: new MemoryTokenStore(), backend: backend as never })
    expect((await reloaded.read()).accounts[0]!.adopted).toBe(false)
  })

  it('refuses deleteAccount and removes through removeImportedAccount instead', async () => {
    const { pool, mirror } = harness()
    await pool.addAccount(credential(1))
    const adopted = await pool.addAccount(adoptedCredential(2))

    await expect(pool.deleteAccount(adopted.id)).rejects.toThrow(/not an account this plugin owns/)
    // The refusal is loud AND total: the row is still there afterwards.
    expect((await pool.read()).accounts).toHaveLength(2)

    // The one action that means it: stop borrowing. The Codex CLI's file is
    // neither read nor written by either path.
    await pool.removeImportedAccount(adopted.id)

    const remaining = (await pool.read()).accounts
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.id).not.toBe(adopted.id)
    // The managed sign-in and its mirror are untouched by the removal.
    expect(remaining[0]!.credentials.accessToken).toBe('access-1')
    expect((await mirror.load())?.accessToken).toBe('access-1')
  })

  it('refuses to remove a managed row through the import action', async () => {
    const { pool } = harness()
    const managed = await pool.addAccount(credential(1))
    await expect(pool.removeImportedAccount(managed.id)).rejects.toThrow(/signed in through this plugin/)
    expect((await pool.read()).accounts).toHaveLength(1)
  })

  it('never mirrors an adopted snapshot into the single-credential store', async () => {
    const { pool, mirror } = harness()
    await pool.addAccount(credential(1))
    await pool.addAccount(adoptedCredential(2))

    // The store holds the managed sign-in and nothing else: a snapshot is not
    // this plugin's credential to keep, and writing it there would both overwrite
    // the real sign-in and resurrect a borrowed credential on the next restart.
    const stored = await mirror.load()
    expect(stored?.accessToken).toBe('access-1')
    expect(stored?.adopted).toBeUndefined()
    // The snapshot still routes, which is the point of adopting it at all.
    expect((await pool.getEffectiveAccount()).account.credentials.accessToken).toBe('access-1')
  })

  it('leaves every managed behaviour exactly as it was', async () => {
    const { pool, mirror, refreshed } = harness()
    const first = await pool.addAccount(credential(1))
    const second = await pool.addAccount(credential(2))
    await pool.setPrimary(first.id)

    // Dedupe key, alias, primary flag, rotation, cooldown blocking, refresh and
    // the mirror: none of this may have moved.
    const again = await pool.addAccount({ ...credential(1), planType: 'pro' })
    expect(again.id).toBe(first.id)
    expect(again.isPrimary).toBe(true)
    expect((await pool.listAccounts()).find((row) => row.id === first.id)?.planLabel).toBe('pro')

    expect((await pool.getEffectiveAccount()).account.id).toBe(first.id)
    await pool.markCooldown(first.id, 600_000, 'Codex 429')
    expect((await pool.getEffectiveAccount()).account.id).toBe(second.id)
    await pool.clearCooldown(first.id)
    await pool.setStrategy('round-robin')
    expect((await pool.strategy())).toBe('round-robin')
    pool.setQuotaBlockedUntil((account, now) => (account.id === first.id ? now + 600_000 : undefined))
    expect((await pool.getEffectiveAccount()).account.id).toBe(second.id)
    pool.setQuotaBlockedUntil(() => undefined)

    // A managed credential about to expire is still rotated through the refresher,
    // and the rotated pair still reaches the mirror: the guard is narrow.
    const { pool: fresh, mirror: freshMirror, refreshed: freshRefreshed } = harness()
    const expiring = await fresh.addAccount(credential(3, 10_000))
    const served = await fresh.getEffectiveAccount()
    expect(served.account.id).toBe(expiring.id)
    expect(served.credentials.accessToken).toBe('refreshed-access-3')
    expect(freshRefreshed).toHaveLength(1)
    expect((await freshMirror.load())?.accessToken).toBe('refreshed-access-3')
    expect((await mirror.load())?.accountId).toBe('acct-1')
  })
})

describe('Codex pool request paths', () => {
  it('retries a 429 on the next account and cools the first one down', async () => {
    const { pool } = harness()
    const first = await pool.addAccount(credential(1))
    const second = await pool.addAccount(credential(2))
    await pool.setPrimary(first.id)

    const tokenFetch = vi.fn()
    const oauth = new OAuthService(new MemoryTokenStore(), { fetchFn: tokenFetch as unknown as typeof fetch, pool })

    const calls: Array<{ authorization: string; accountId: string | undefined }> = []
    const responseFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      calls.push({ authorization: headers.authorization, accountId: headers['chatgpt-account-id'] })
      if (headers.authorization === 'Bearer access-1') {
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '120' } })
      }
      return sse([
        { type: 'response.output_text.delta', delta: 'served by account two' },
        { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
      ])
    })
    const client = new ResponsesClient(oauth, { readImage: async () => { throw new Error('unused') } }, {
      fetchFn: responseFetch as unknown as typeof fetch,
      accountPool: pool,
    })

    const chunks = await collect(client.stream({
      provider: 'codex-chatgpt',
      model: 'gpt-5.6-sol',
      messages: [],
      sessionId: 'session-pool',
    } as unknown as GenerateOptions))

    expect(calls.map((call) => call.authorization)).toEqual(['Bearer access-1', 'Bearer access-2'])
    expect(calls[1]!.accountId).toBe('acct-2')
    expect(responseFetch.mock.calls[0]?.[0]).toBe(CODEX_RESPONSES_URL)
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'served by account two' })
    const cooling = (await pool.listAccounts()).find((entry) => entry.id === first.id)
    expect(cooling?.cooldownUntil).toBeGreaterThan(Date.now())
    // The next request no longer touches the cooled account.
    calls.length = 0
    await collect(client.stream({ provider: 'codex-chatgpt', model: 'gpt-5.6-sol', messages: [] } as unknown as GenerateOptions))
    expect(calls.every((call) => call.authorization === 'Bearer access-2')).toBe(true)
    expect(tokenFetch).not.toHaveBeenCalled()
    oauth.dispose()
  })

  it('drops an account whose refresh is rejected and serves the request from the other one', async () => {
    const { pool } = harness()
    const first = await pool.addAccount(credential(1))
    await pool.addAccount(credential(2))
    await pool.setPrimary(first.id)

    const tokenFetch = vi.fn(async (_url: unknown) => new Response('invalid_grant', { status: 400 }))
    const oauth = new OAuthService(new MemoryTokenStore(), {
      fetchFn: tokenFetch as unknown as typeof fetch,
      logger: { info: () => undefined, warn: () => undefined },
      pool,
    })
    const responseFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      if (headers.authorization === 'Bearer access-1') return new Response('', { status: 401 })
      return sse([{ type: 'response.completed', response: {} }])
    })
    const client = new ResponsesClient(oauth, { readImage: async () => { throw new Error('unused') } }, {
      fetchFn: responseFetch as unknown as typeof fetch,
      accountPool: pool,
    })

    await collect(client.stream({ provider: 'codex-chatgpt', model: 'gpt-5.6-sol', messages: [] } as unknown as GenerateOptions))
    expect(tokenFetch).toHaveBeenCalledTimes(1)
    expect(tokenFetch.mock.calls[0]?.[0]).toBe(OAUTH_TOKEN_URL)
    expect((await pool.listAccounts()).find((entry) => entry.id === first.id)?.authStatus).toBe('expired')
    // A rejected refresh never wipes the pool's other accounts.
    expect(await pool.listAccounts()).toHaveLength(2)
    oauth.dispose()
  })

  it('signs out one pooled account at a time and promotes the next one', async () => {
    const { pool, mirror } = harness()
    const first = await pool.addAccount(credential(1))
    const second = await pool.addAccount(credential(2))
    const oauth = new OAuthService(mirror, { pool })

    await oauth.logout(first.id)
    const remaining = await pool.listAccounts()
    expect(remaining.map((entry) => entry.id)).toEqual([second.id])
    expect(remaining[0]!.isPrimary).toBe(true)
    expect((await mirror.load())?.accountId).toBe('acct-2')

    // Signing out without an id removes whatever would serve the next request.
    await oauth.logout()
    expect(await pool.listAccounts()).toHaveLength(0)
    expect(await mirror.load()).toBeNull()
    oauth.dispose()
  })

  it('single-flights concurrent refreshes of the same account', async () => {
    const { pool, mirror } = harness()
    const account = await pool.addAccount(credential(1))
    const tokenFetch = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return Response.json({ access_token: 'rotated', refresh_token: 'refresh-1', expires_in: 3600 })
    })
    const oauth = new OAuthService(mirror, { fetchFn: tokenFetch as unknown as typeof fetch, pool })

    const [left, right] = await Promise.all([
      oauth.refreshAccount(account.credentials),
      oauth.refreshAccount(account.credentials),
    ])
    expect(tokenFetch).toHaveBeenCalledTimes(1)
    expect(left.accessToken).toBe('rotated')
    expect(right.accessToken).toBe('rotated')
    await pool.updateAccountCredentials(account.id, left)
    expect((await pool.read()).accounts[0]!.credentials.accessToken).toBe('rotated')
    oauth.dispose()
  })

  // Regression, end to end with real pool wiring: the live bug was a spent Codex
  // window making `oauth.credentials()` throw, which turned every web search into
  // "ChatGPT subscription credentials are required" — and the quota card that
  // exists to explain the spent window into "credentials could not be refreshed".
  it('serves tools and the quota card from an account whose Codex window is spent', async () => {
    const { pool } = harness()
    const account = await pool.addAccount(credential(1))
    const oauth = new OAuthService(new MemoryTokenStore(), { pool })

    // Cache exactly the verdict the upstream reports for a spent window.
    const usageFetch = vi.fn(async () => Response.json({
      rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 604_800, reset_at: Math.floor(Date.now() / 1000) + 3600 } },
    }))
    const usage = new UsageService(oauth, { fetchFn: usageFetch as unknown as typeof fetch })
    pool.setQuotaBlockedUntil((entry, now) => usage.blockedUntilFor(entry.id, entry.credentials, now))

    const primed = await usage.status(true, true)
    expect(primed.buckets[0]?.windows[0]?.usedPercent).toBe(100)
    expect(usage.blockedUntilFor(account.id, account.credentials, Date.now())).toBeGreaterThan(Date.now())

    // The chat path is still gated — that is the point of the quota verdict.
    await expect(oauth.credentials()).rejects.toMatchObject({ code: 'RATE_LIMIT' })

    // A tool purpose is not, and it gets the very same credential.
    const tool = await oauth.credentials(false, { purpose: 'tool' })
    expect(tool.accessToken).toBe('access-1')

    // The card keeps reporting the real usage instead of a credential error.
    expect((await usage.status(true, true)).state).toBe('ready')

    oauth.dispose()
  })

  // Regression with real pool wiring: the cheap "warm snapshot" early return in
  // UsageService.status() sat above the account guard, so switching the primary
  // account inside the 60 s quota window kept reporting the previous account's
  // quota — a card that names account B while showing account A's usage.
  it('reports the newly pinned account quota instead of the previous account cache', async () => {
    const { pool } = harness()
    const first = await pool.addAccount(credential(1))
    const second = await pool.addAccount(credential(2))
    await pool.setPrimary(first.id)
    const oauth = new OAuthService(new MemoryTokenStore(), { pool })

    // Answer each account with a distinct used_percent, keyed on the account
    // header the request actually carried, so the assertion is about which
    // account's quota was served — not about how many requests were made.
    const usedPercentForAccount = new Map([['acct-1', 10], ['acct-2', 99]])
    const usageFetch = vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      const header = init?.headers?.['chatgpt-account-id'] ?? ''
      return Response.json({
        rate_limit: { primary_window: { used_percent: usedPercentForAccount.get(header) ?? -1, limit_window_seconds: 3_600 } },
      })
    })
    const usage = new UsageService(oauth, {
      fetchFn: usageFetch as unknown as typeof fetch,
      now: () => Date.now(),
    })

    const before = await usage.status(true)
    expect(before.buckets[0]?.primary?.usedPercent).toBe(10)

    // The user pins the other account; the settings card re-polls immediately,
    // well inside the 60 s quota window.
    await pool.setPrimary(second.id)
    const after = await usage.status(true)

    expect(after.buckets[0]?.primary?.usedPercent).toBe(99)
    expect(usageFetch).toHaveBeenCalledTimes(2)
    oauth.dispose()
  })

  // Quota follows the account. Before this, the card could only show the
  // line-level figure for whichever account was active when it was read, so a
  // second account's progress was simply invisible — and a rotation made the
  // one figure silently switch owner.
  it('publishes each account the quota snapshot read for that account', async () => {
    const { pool } = harness()
    const first = await pool.addAccount(credential(1))
    const second = await pool.addAccount(credential(2))
    await pool.setPrimary(first.id)
    const oauth = new OAuthService(new MemoryTokenStore(), { pool })

    const usedPercentForAccount = new Map([['acct-1', 10], ['acct-2', 99]])
    const usage = new UsageService(oauth, {
      fetchFn: (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
        const header = init?.headers?.['chatgpt-account-id'] ?? ''
        return Response.json({
          rate_limit: { primary_window: { used_percent: usedPercentForAccount.get(header) ?? -1, limit_window_seconds: 18_000, reset_at: Math.floor(Date.now() / 1000) + 3600 } },
        })
      }) as unknown as typeof fetch,
    })
    pool.setQuotaSnapshot((account) => {
      const snapshot = usage.snapshotFor(account.id, account.credentials)
      return snapshot === undefined ? undefined : codexAccountQuota(snapshot)
    })

    // Nothing has been read yet, so no account claims a quota. "Never read" is
    // not "nothing used", and the card renders those differently.
    expect((await pool.listAccounts()).every((entry) => entry.quota === undefined)).toBe(true)

    // The settings card reads the pinned account, then the other one.
    await usage.status(true, true)
    await pool.setPrimary(second.id)
    await usage.status(true, true)

    const byId = new Map((await pool.listAccounts()).map((entry) => [entry.id, entry]))
    expect(byId.get(first.id)?.quota?.windows[0]?.usedPercent).toBe(10)
    expect(byId.get(second.id)?.quota?.windows[0]?.usedPercent).toBe(99)
    // Each snapshot states when it was read and how long its window is, so the
    // row can name the window and say how old the reading is.
    expect(byId.get(first.id)?.quota?.fetchedAt).toBeGreaterThan(0)
    expect(byId.get(first.id)?.quota?.windows[0]?.windowDurationMins).toBe(300)
    expect(byId.get(first.id)?.quota?.windows[0]?.resetsAt).toBeGreaterThan(Date.now())

    // A third account nobody has read stays absent rather than reporting zero.
    const third = await pool.addAccount(credential(3))
    const withThird = new Map((await pool.listAccounts()).map((entry) => [entry.id, entry]))
    expect(withThird.get(third.id)?.quota).toBeUndefined()
    oauth.dispose()
  })

  // The credential-derived identity is a fallback: `accountId ?? email ??
  // planType`. An account that states none of the three collides with every other
  // such account, and the card would draw one row's meters on the other's row.
  // The pool row id is what keeps them apart.
  it('keys each row by its row id when the credentials state no identity at all', async () => {
    const { pool } = harness()
    const anonymous = (n: number): StoredOAuthCredentials => ({
      accessToken: `anon-${n}`,
      refreshToken: `anon-refresh-${n}`,
      expiresAt: Date.now() + 3_600_000,
    })
    const first = await pool.addAccount(anonymous(1))
    const second = await pool.addAccount(anonymous(2))
    await pool.setPrimary(first.id)
    const oauth = new OAuthService(new MemoryTokenStore(), { pool })

    const usedByToken = new Map([['Bearer anon-1', 10], ['Bearer anon-2', 99]])
    const usage = new UsageService(oauth, {
      fetchFn: (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
        const bearer = init?.headers?.authorization ?? ''
        return Response.json({
          rate_limit: { primary_window: { used_percent: usedByToken.get(bearer) ?? -1, limit_window_seconds: 18_000, reset_at: Math.floor(Date.now() / 1000) + 3600 } },
        })
      }) as unknown as typeof fetch,
    })
    pool.setQuotaSnapshot((account) => {
      const snapshot = usage.snapshotFor(account.id, account.credentials)
      return snapshot === undefined ? undefined : codexAccountQuota(snapshot)
    })

    await usage.status(true, true)
    await pool.setPrimary(second.id)
    await usage.status(true, true)

    const byId = new Map((await pool.listAccounts()).map((entry) => [entry.id, entry]))
    expect(byId.get(first.id)?.quota?.windows[0]?.usedPercent).toBe(10)
    expect(byId.get(second.id)?.quota?.windows[0]?.usedPercent).toBe(99)
    oauth.dispose()
  })

  it('does not make a tool refresh rotate the conversational account', async () => {
    const { pool } = harness()
    const first = await pool.addAccount(credential(1))
    const second = await pool.addAccount(credential(2))
    await pool.setPrimary(first.id)
    const oauth = new OAuthService(new MemoryTokenStore(), { pool })

    // Serve one request so the active account is the primary, then read a
    // credential for a tool: the tool must not re-point the conversation.
    await pool.getEffectiveAccount()
    expect((await pool.read()).activeAccountId).toBe(first.id)
    await oauth.credentials(false, { purpose: 'tool' })
    expect((await pool.read()).activeAccountId).toBe(first.id)
    expect((await pool.read()).accounts.find((entry) => entry.id === second.id)?.lastUsedAt).toBeUndefined()
    oauth.dispose()
  })
})
