import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import {
  decodeJwtPayload,
  identityFromTokens,
  ensureAccessToken,
  resetRefreshRejections,
} from '../src/host/kimi-code/oauth.ts'
import {
  FileCredentialStore,
  type KimiCodeCredentials,
} from '../src/host/kimi-code/token-store.ts'
import {
  accountFromCredentials,
  clearCachedQuota,
  credentialsWithProfile,
  fetchAccountQuota,
  testConnection,
} from '../src/host/kimi-code/client.ts'
import type { KimiCodeAccount } from '../src/shared/kimi-code-contracts.ts'

function tmp(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

/** Build an unsigned JWT whose payload is readable, as Kimi's tokens are. */
function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

function creds(overrides: Partial<KimiCodeCredentials> = {}): KimiCodeCredentials {
  return {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: Date.now() + 3_600_000,
    expiresIn: 3_600,
    region: 'mainland-cn',
    oauthHost: 'https://auth.kimi.com',
    baseUrl: 'https://api.kimi.com/coding',
    ...overrides,
  }
}

afterEach(() => {
  clearCachedQuota()
  resetRefreshRejections()
  vi.restoreAllMocks()
})

describe('decodeJwtPayload', () => {
  it('reads the payload of a well-formed token', () => {
    expect(decodeJwtPayload(jwt({ user_id: 'u_1', email: 'A@Example.com' })))
      .toMatchObject({ user_id: 'u_1', email: 'A@Example.com' })
  })

  it('returns nothing for a token that is not a JWT', () => {
    expect(decodeJwtPayload('not-a-jwt')).toBeUndefined()
    expect(decodeJwtPayload('a.b')).toBeUndefined()
    expect(decodeJwtPayload('a.!!!.c')).toBeUndefined()
  })
})

describe('identityFromTokens', () => {
  it('prefers user_id from either token over sub', () => {
    // The two claims share an issuer namespace, and sub is the weaker one, so a
    // refresh token's user_id must win over an access token's sub.
    const identity = identityFromTokens(jwt({ sub: 'weak' }), jwt({ user_id: 'strong' }))
    expect(identity.userId).toBe('strong')
  })

  it('reads user_id from the access token when the refresh token has none', () => {
    expect(identityFromTokens(jwt({ user_id: 'u_9' }), jwt({})).userId).toBe('u_9')
  })

  it('falls back to sub when no user_id is present', () => {
    expect(identityFromTokens(jwt({ sub: 'sub-1' })).userId).toBe('sub-1')
  })

  it('lowercases the email claim', () => {
    expect(identityFromTokens(jwt({ email: 'User@Example.COM' })).email).toBe('user@example.com')
  })

  it('returns nothing for opaque tokens', () => {
    expect(identityFromTokens('opaque-access', 'opaque-refresh')).toEqual({})
  })
})

describe('accountFromCredentials', () => {
  it('derives the account from the token when the credential stores no identity', () => {
    // This is the case that showed a bare "-": the account profile endpoint does
    // not exist, so the identity has to come from the token itself.
    const account = accountFromCredentials(creds({
      accessToken: jwt({ user_id: 'u_42', email: 'dev@example.com' }),
      refreshToken: jwt({}),
    }))
    expect(account.userId).toBe('u_42')
    expect(account.email).toBe('dev@example.com')
    expect(account.region).toBe('mainland-cn')
  })

  it('prefers a stored identity over the decoded one', () => {
    const account = accountFromCredentials(creds({
      userId: 'stored',
      email: 'stored@example.com',
      accessToken: jwt({ user_id: 'decoded', email: 'decoded@example.com' }),
    }))
    expect(account.userId).toBe('stored')
    expect(account.email).toBe('stored@example.com')
  })

  it('takes the tier from the usage payload when present', () => {
    const account = accountFromCredentials(creds(), { user_level_name: 'Allegretto', user_level: 40 })
    expect(account.planName).toBe('Allegretto')
    expect(account.planLevel).toBe('40')
  })
})

describe('fetchAccountQuota identity', () => {
  it('populates the account identity from the token so the card is never blank', async () => {
    const store = new FileCredentialStore(tmp('kc-id'))
    vi.spyOn(store, 'read').mockResolvedValue(creds({
      accessToken: jwt({ user_id: 'u_77', email: 'who@example.com' }),
      refreshToken: jwt({}),
    }))
    const write = vi.spyOn(store, 'write').mockResolvedValue(undefined)
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      usages: { limit_5h: { used_ratio: 0.1 } },
      user_level_name: 'Moderato',
    }), { status: 200 })) as unknown as typeof fetch

    const quota = await fetchAccountQuota(store, { fetchFn: fetchMock, force: true })
    expect(quota?.account.userId).toBe('u_77')
    expect(quota?.account.email).toBe('who@example.com')
    expect(quota?.account.planName).toBe('Moderato')
    // The tier is worth remembering; the token claims are persisted too.
    expect(write).toHaveBeenCalled()
  })
})

describe('testConnection', () => {
  it('reports a connected account using the usage probe', async () => {
    // It used to call a nonexistent profile endpoint and return nothing at all,
    // which is why the button appeared dead.
    const store = new FileCredentialStore(tmp('kc-conn'))
    vi.spyOn(store, 'read').mockResolvedValue(creds({ accessToken: jwt({ user_id: 'u_5' }), refreshToken: jwt({}) }))
    vi.spyOn(store, 'write').mockResolvedValue(undefined)
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ usages: {} }), { status: 200 })) as unknown as typeof fetch

    const result = await testConnection(store, { fetchFn: fetchMock })
    expect(result.account).not.toBeNull()
    expect(result.account?.userId).toBe('u_5')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('reports a rejected credential as an error rather than a silent success', async () => {
    const store = new FileCredentialStore(tmp('kc-conn401'))
    vi.spyOn(store, 'read').mockResolvedValue(creds({ accessToken: jwt({ user_id: 'u_5' }), refreshToken: jwt({}) }))
    const fetchMock = vi.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch

    await expect(testConnection(store, { fetchFn: fetchMock })).rejects.toThrow(/401|sign in/i)
  })

  it('renews once through its own store before calling a 401 a dead credential', async () => {
    // A token that expired while the machine slept, or one another holder
    // rotated, still looks fine locally; the service's 401 is the only signal.
    const store = new FileCredentialStore(tmp('kc-conn401-renew'))
    const stored = creds({
      accessToken: 'at-stale',
      refreshToken: 'rt-still-good',
      expiresAt: Date.now() + 3_600_000,
    })
    vi.spyOn(store, 'read').mockResolvedValue(stored)
    const write = vi.spyOn(store, 'write').mockResolvedValue(undefined)

    const authorizations: Array<string | undefined> = []
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes('/oauth/')) {
        return Response.json({
          access_token: 'at-renewed',
          refresh_token: 'rt-renewed',
          expires_in: 3600,
          token_type: 'Bearer',
        })
      }
      const authorization = (init?.headers as Record<string, string>).authorization
      authorizations.push(authorization)
      if (authorization === 'Bearer at-stale') return new Response('nope', { status: 401 })
      return Response.json({ usages: {}, user: { nickname: 'who' } })
    }) as unknown as typeof fetch

    const result = await testConnection(store, { fetchFn: fetchMock })
    expect(result.account).not.toBeNull()
    // It retried with the renewed token, and the rotated pair was persisted.
    expect(authorizations).toContain('Bearer at-renewed')
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: 'rt-renewed' }))
  })

  it('does not spend a credential another holder already rotated', async () => {
    // The store now carries a different refresh token, so the refused one is
    // history: renewing again would rotate a token the upstream never rejected.
    const store = new FileCredentialStore(tmp('kc-conn401-rotated'))
    vi.spyOn(store, 'read').mockResolvedValue(creds({ accessToken: 'at-someone-else', refreshToken: 'rt-other' }))

    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes('/oauth/')) throw new Error('must not refresh')
      return new Response('nope', { status: 401 })
    }) as unknown as typeof fetch

    await expect(fetchAccountQuota(store, {
      fetchFn: fetchMock,
      force: true,
      credentials: creds({ accessToken: 'at-stale', refreshToken: 'rt-refused' }),
    })).rejects.toThrow(/401|sign in/i)
  })

  it('still returns the local identity when the service is briefly unavailable', async () => {
    const store = new FileCredentialStore(tmp('kc-conn500'))
    vi.spyOn(store, 'read').mockResolvedValue(creds({ accessToken: jwt({ user_id: 'u_8' }), refreshToken: jwt({}) }))
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch

    const result = await testConnection(store, { fetchFn: fetchMock })
    expect(result.account?.userId).toBe('u_8')
  })
})

describe('ensureAccessToken keeps identity fresh', () => {
  it('fills in identity claims decoded during a refresh', async () => {
    const store = new FileCredentialStore(tmp('kc-refresh-id'))
    vi.spyOn(store, 'read').mockResolvedValue(creds({
      expiresAt: Date.now() + 1_000,
      expiresIn: 3_600,
      accessToken: 'opaque',
      refreshToken: 'opaque-refresh',
    }))
    const write = vi.spyOn(store, 'write').mockResolvedValue(undefined)
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      access_token: jwt({ user_id: 'u_new', email: 'New@Example.com' }),
      refresh_token: jwt({}),
      expires_in: 3600,
      scope: 'read',
      token_type: 'Bearer',
    }), { status: 200 })) as unknown as typeof fetch

    const updated = await ensureAccessToken(store, { fetchFn: fetchMock })
    expect(updated.userId).toBe('u_new')
    expect(updated.email).toBe('new@example.com')
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u_new' }))
  })
})

/**
 * The nickname is the one fact a token usually does not carry, and the account
 * card's title is exactly that: a name. `/me` is the only place it exists, and
 * it has answered at more than one depth, so these pin both the shapes it has
 * used and the hand-off that gets the learned name into the account row.
 */
describe('profile nickname', () => {
  it('reads the name from the flat profile and from every envelope it has used', () => {
    expect(accountFromCredentials(creds(), undefined, { nickname: 'flat' }).nickname).toBe('flat')
    expect(accountFromCredentials(creds(), undefined, { data: { nickname: 'in-data' } }).nickname).toBe('in-data')
    expect(accountFromCredentials(creds(), undefined, { data: { userInfo: { nickname: 'in-userInfo' } } }).nickname)
      .toBe('in-userInfo')
    expect(accountFromCredentials(creds(), undefined, { user: { nickname: 'in-user' } }).nickname).toBe('in-user')
  })

  it('folds a profile into a credential without touching the token pair', () => {
    const before = creds()
    const next = credentialsWithProfile(before, {
      data: { userInfo: { nickname: '月光', email: 'Moon@Example.com', user_id: 'u_9' } },
      user_level_name: 'Allegretto',
    })
    expect(next.nickname).toBe('月光')
    expect(next.email).toBe('moon@example.com')
    expect(next.userId).toBe('u_9')
    expect(next.planName).toBe('Allegretto')
    expect(next.accessToken).toBe(before.accessToken)
    expect(next.refreshToken).toBe(before.refreshToken)
  })

  it('returns the credential unchanged when the profile names nothing new', () => {
    const before = creds({ nickname: '月光' })
    // The same object, so a caller can tell "nothing learned" from "write this".
    expect(credentialsWithProfile(before, { data: {} })).toBe(before)
  })

  it('hands the reading to the pool, which is the only party that can rename the row', async () => {
    const store = new FileCredentialStore(tmp('kc-on-account'))
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/me')) {
        return Response.json({ data: { userInfo: { nickname: '月光', email: 'Moon@Example.com' } } })
      }
      return Response.json({ usages: { limit_5h: { used_ratio: 0.1 } } })
    }) as unknown as typeof fetch

    const learned: KimiCodeAccount[] = []
    const quota = await fetchAccountQuota(store, {
      fetchFn: fetchMock,
      force: true,
      // A pooled call never writes the single-credential file; the hook is the
      // pool's only way to hear what the profile said.
      credentials: creds(),
      accountId: 'acc_learn',
      onAccount: (account) => { learned.push(account) },
    })

    expect(learned).toHaveLength(1)
    expect(learned[0]).toMatchObject({ nickname: '月光', email: 'moon@example.com' })
    expect(quota?.account.nickname).toBe('月光')
  })

  it('keeps the quota reading even when learning about the account fails', async () => {
    const store = new FileCredentialStore(tmp('kc-on-account-fail'))
    const fetchMock = vi.fn(async () => Response.json({ usages: { limit_5h: { used_ratio: 0.1 } } })) as unknown as typeof fetch
    const quota = await fetchAccountQuota(store, {
      fetchFn: fetchMock,
      force: true,
      credentials: creds(),
      accountId: 'acc_learn_fail',
      onAccount: () => { throw new Error('pool write failed') },
    })
    expect(quota?.windows.length).toBeGreaterThan(0)
  })
})
