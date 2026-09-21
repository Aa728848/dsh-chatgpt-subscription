import { describe, expect, it } from 'vitest'
import {
  decodeAccessTokenClaims,
  hasStableIdentity,
  identityFromAccessToken,
  withResolvedIdentity,
} from '../src/host/workbuddy/identity.ts'
import type { WorkBuddyCredentials } from '../src/host/workbuddy/token-store.ts'

/** Build an unsigned JWT-shaped token carrying the claims under test. */
function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}.signature`
}

function credentials(overrides: Partial<WorkBuddyCredentials> = {}): WorkBuddyCredentials {
  return {
    accessToken: 'opaque-token',
    refreshToken: 'refresh',
    expiresAt: Date.now() + 3_600_000,
    region: 'cn',
    domain: 'copilot.tencent.com',
    backend: 'https://copilot.tencent.com',
    sourceFile: '',
    sourceMtimeMs: 0,
    source: 'managed',
    ...overrides,
  }
}

describe('WorkBuddy token identity', () => {
  it('reads the claims both deployments actually fill', () => {
    // Measured against a live domestic token and a live international one.
    expect(identityFromAccessToken(jwt({ sub: 'u1', nickname: '快跑', uin: '330101607075' })))
      .toEqual({ uid: 'u1', nickname: '快跑', uin: '330101607075' })
    expect(identityFromAccessToken(jwt({ sub: 'u2', preferred_username: 'a@b.com', name: 'A B' })))
      .toEqual({ uid: 'u2', nickname: 'a@b.com' })
  })

  it('reports nothing for a token it cannot read instead of throwing', () => {
    // An opaque access token is a legitimate shape; it must simply contribute
    // nothing rather than failing the read path it is part of.
    expect(decodeAccessTokenClaims('opaque-token')).toBeNull()
    expect(decodeAccessTokenClaims('a.b')).toBeNull()
    expect(decodeAccessTokenClaims('a.!!!not-base64!!!.c')).toBeNull()
    expect(identityFromAccessToken('opaque-token')).toEqual({})
  })

  it('ignores blank claim values rather than treating them as identity', () => {
    expect(identityFromAccessToken(jwt({ sub: '  ', nickname: '', uin: '   ' }))).toEqual({})
  })

  it('knows whether a credential names its own account', () => {
    expect(hasStableIdentity({ uid: 'u1' })).toBe(true)
    expect(hasStableIdentity({ uin: '10' })).toBe(true)
    expect(hasStableIdentity({ nickname: '快跑' })).toBe(true)
    // The auth domain is a deployment property, not an account identity.
    expect(hasStableIdentity({})).toBe(false)
  })
})

describe('WorkBuddy identity resolution', () => {
  it('prefers the token uuid over a display name stored as the uid', () => {
    // The record the old login path wrote: the display name where the uid
    // belongs. The token still names the real account, so it wins.
    const resolved = withResolvedIdentity(credentials({
      accessToken: jwt({ sub: 'uuid-1', preferred_username: 'cchen2422@gmail.com' }),
      uid: 'cchen2422@gmail.com',
    }))
    expect(resolved.uid).toBe('uuid-1')
    // The displaced value is kept as the nickname rather than discarded.
    expect(resolved.nickname).toBe('cchen2422@gmail.com')
  })

  it('fills only what the credential does not state', () => {
    const resolved = withResolvedIdentity(credentials({
      accessToken: jwt({ sub: 'uuid-1', nickname: 'from-token', uin: '100' }),
      uid: 'stored-uid',
      nickname: 'from-file',
      uin: '200',
    }))
    // A stored uid that the token contradicts is corrected, since only the
    // login fallback can produce one; the other facts are not second-guessed.
    expect(resolved.uid).toBe('uuid-1')
    expect(resolved.nickname).toBe('from-file')
    expect(resolved.uin).toBe('200')
  })

  it('returns the same object when there is nothing to correct', () => {
    const original = credentials({ accessToken: jwt({ sub: 'uuid-1' }), uid: 'uuid-1' })
    expect(withResolvedIdentity(original)).toBe(original)
  })

  it('leaves a credential with an opaque token untouched', () => {
    const original = credentials({ nickname: 'left alone' })
    const resolved = withResolvedIdentity(original)
    expect(resolved).toBe(original)
  })
})
