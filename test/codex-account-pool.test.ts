import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CODEX_RESPONSES_URL, OAUTH_TOKEN_URL } from '../src/compat.ts'
import { CodexAccountPool, parseCodexPoolData } from '../src/host/codex-account-pool.ts'
import { OAuthService } from '../src/host/oauth-service.ts'
import { ResponsesClient } from '../src/host/responses-client.ts'
import { MemoryTokenStore, type StoredOAuthCredentials } from '../src/host/token-store.ts'
import { UsageService } from '../src/host/usage-service.ts'

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
    pool.setQuotaBlockedUntil((entry, now) => usage.blockedUntilFor(entry.credentials, now))

    const primed = await usage.status(true, true)
    expect(primed.buckets[0]?.windows[0]?.usedPercent).toBe(100)
    expect(usage.blockedUntilFor(account.credentials, Date.now())).toBeGreaterThan(Date.now())

    // The chat path is still gated — that is the point of the quota verdict.
    await expect(oauth.credentials()).rejects.toMatchObject({ code: 'RATE_LIMIT' })

    // A tool purpose is not, and it gets the very same credential.
    const tool = await oauth.credentials(false, { purpose: 'tool' })
    expect(tool.accessToken).toBe('access-1')

    // The card keeps reporting the real usage instead of a credential error.
    expect((await usage.status(true, true)).state).toBe('ready')

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
