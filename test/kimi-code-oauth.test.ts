import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import {
  KimiCodeAccessDeniedError,
  KimiCodeUnauthorizedError,
  ensureAccessToken,
  refreshAccessToken,
  refreshThresholdMs,
  requestDeviceAuthorization,
  resetRefreshRejections,
} from '../src/host/kimi-code/oauth.ts'
import { FileCredentialStore, type KimiCodeCredentials } from '../src/host/kimi-code/token-store.ts'

function tmp(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
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

/** Capture the form body one call sent. */
function formOf(init: RequestInit | undefined): URLSearchParams {
  return new URLSearchParams(String(init?.body ?? ''))
}

afterEach(() => {
  resetRefreshRejections()
  vi.restoreAllMocks()
})

describe('requestDeviceAuthorization', () => {
  it('posts only the client id and reads the documented response fields', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://auth.kimi.com/api/oauth/device_authorization')
      expect(init?.method).toBe('POST')
      const form = formOf(init)
      // RFC 8628 for a public client: client_id and nothing else.
      expect(form.get('client_id')).toBe('17e5f671-d194-4dfb-9706-5516cb48c098')
      expect(form.get('scope')).toBeNull()
      expect(form.get('code_challenge')).toBeNull()
      const headers = init?.headers as Record<string, string>
      expect(headers['content-type']).toBe('application/x-www-form-urlencoded')
      expect(headers['x-msh-platform']).toBe('kimi_code_cli')
      expect(headers['x-msh-device-id']).toBeTruthy()
      return new Response(JSON.stringify({
        user_code: 'WDJB-MJHT',
        device_code: 'devcode123',
        verification_uri: 'https://auth.kimi.com/verify',
        verification_uri_complete: 'https://auth.kimi.com/verify?user_code=WDJB-MJHT',
        expires_in: 600,
        interval: 5,
      }), { status: 200 })
    }) as unknown as typeof fetch

    const { authorization, host } = await requestDeviceAuthorization({ fetchFn: fetchMock, region: 'mainland-cn' })
    expect(host).toBe('https://auth.kimi.com')
    expect(authorization.userCode).toBe('WDJB-MJHT')
    expect(authorization.deviceCode).toBe('devcode123')
    expect(authorization.verificationUriComplete).toContain('user_code=WDJB-MJHT')
    expect(authorization.interval).toBe(5)
  })

  it('falls back to the documented defaults when the service omits them', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      user_code: 'A',
      device_code: 'B',
      verification_uri_complete: 'https://auth.kimi.com/verify?user_code=A',
    }), { status: 200 })) as unknown as typeof fetch

    const { authorization } = await requestDeviceAuthorization({ fetchFn: fetchMock, region: 'mainland-cn' })
    expect(authorization.interval).toBe(5)
    expect(authorization.expiresIn).toBe(600)
  })

  it('uses the global hosts for the global region', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe('https://auth.kimi.ai/api/oauth/device_authorization')
      return new Response(JSON.stringify({
        user_code: 'A', device_code: 'B', verification_uri_complete: 'https://auth.kimi.ai/v?user_code=A',
      }), { status: 200 })
    }) as unknown as typeof fetch
    const { host } = await requestDeviceAuthorization({ fetchFn: fetchMock, region: 'global' })
    expect(host).toBe('https://auth.kimi.ai')
  })

  it('rejects a response that carries no device code', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ user_code: 'A' }), { status: 200 })) as unknown as typeof fetch
    await expect(requestDeviceAuthorization({ fetchFn: fetchMock, region: 'mainland-cn' }))
      .rejects.toThrow(/device code/i)
  })
})

describe('refreshAccessToken', () => {
  it('retries a 502 and succeeds on a later attempt', async () => {
    let attempt = 0
    const fetchMock = vi.fn(async () => {
      attempt += 1
      // The upstream-unavailable class the service documents for 5xx: a
      // transient failure with no bearing on the refresh token.
      if (attempt === 1) {
        return new Response(JSON.stringify({ error: { message: 'Upstream model provider is temporarily unavailable.', type: 'server_error' } }), { status: 502 })
      }
      return new Response(JSON.stringify({
        access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600, scope: 'read', token_type: 'Bearer',
      }), { status: 200 })
    }) as unknown as typeof fetch

    const token = await refreshAccessToken('rt-1', { fetchFn: fetchMock, region: 'mainland-cn' })
    expect(attempt).toBe(2)
    expect(token.accessToken).toBe('at-2')
    expect(token.refreshToken).toBe('rt-2')
  })

  it('retries a 429 and gives up after the bounded attempts', async () => {
    let attempt = 0
    const fetchMock = vi.fn(async () => {
      attempt += 1
      return new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429 })
    }) as unknown as typeof fetch

    await expect(refreshAccessToken('rt-1', { fetchFn: fetchMock, region: 'mainland-cn' }))
      .rejects.toThrow(/after retries/i)
    // Three attempts, matching the official client's max_retries.
    expect(attempt).toBe(3)
  })

  it('does not retry a 401 and reports the token as rejected', async () => {
    let attempt = 0
    const fetchMock = vi.fn(async () => {
      attempt += 1
      return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token expired' }), { status: 401 })
    }) as unknown as typeof fetch

    await expect(refreshAccessToken('rt-1', { fetchFn: fetchMock, region: 'mainland-cn' }))
      .rejects.toBeInstanceOf(KimiCodeUnauthorizedError)
    // A dead token fails identically every time, so it must not be retried.
    expect(attempt).toBe(1)
  })

  it('treats invalid_grant at a 200-shaped status as unauthorized', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: 'invalid_grant' }),
      { status: 400 },
    )) as unknown as typeof fetch
    await expect(refreshAccessToken('rt-1', { fetchFn: fetchMock, region: 'mainland-cn' }))
      .rejects.toBeInstanceOf(KimiCodeUnauthorizedError)
  })

  it('sends the documented refresh grant', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://auth.kimi.com/api/oauth/token')
      const form = formOf(init)
      expect(form.get('client_id')).toBe('17e5f671-d194-4dfb-9706-5516cb48c098')
      expect(form.get('grant_type')).toBe('refresh_token')
      expect(form.get('refresh_token')).toBe('rt-1')
      return new Response(JSON.stringify({
        access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600, scope: 'read', token_type: 'Bearer',
      }), { status: 200 })
    }) as unknown as typeof fetch
    await refreshAccessToken('rt-1', { fetchFn: fetchMock, region: 'mainland-cn' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('refreshThresholdMs', () => {
  it('uses half the lifetime once that exceeds the five-minute floor', () => {
    expect(refreshThresholdMs(3_600)).toBe(1_800_000)
  })

  it('never refreshes earlier than the floor of five minutes', () => {
    // A very short-lived token would otherwise be refreshed immediately and
    // forever; the official client floors the threshold at 300 seconds.
    expect(refreshThresholdMs(60)).toBe(300_000)
  })
})

describe('ensureAccessToken', () => {
  it('returns the stored token while it is comfortably valid', async () => {
    const store = new FileCredentialStore(tmp('kc-ensure'))
    vi.spyOn(store, 'read').mockResolvedValue(creds({ expiresAt: Date.now() + 3_600_000 }))
    const write = vi.spyOn(store, 'write').mockResolvedValue(undefined)
    const fetchMock = vi.fn() as unknown as typeof fetch

    const result = await ensureAccessToken(store, { fetchFn: fetchMock })
    expect(result.accessToken).toBe('at-1')
    expect(write).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refreshes and persists a token that is close to expiry', async () => {
    const store = new FileCredentialStore(tmp('kc-ensure2'))
    vi.spyOn(store, 'read').mockResolvedValue(creds({ expiresAt: Date.now() + 1_000, expiresIn: 3_600 }))
    const write = vi.spyOn(store, 'write').mockResolvedValue(undefined)
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600, scope: 'read', token_type: 'Bearer',
    }), { status: 200 })) as unknown as typeof fetch

    const result = await ensureAccessToken(store, { fetchFn: fetchMock })
    expect(result.accessToken).toBe('at-2')
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('reports a missing credential rather than refreshing nothing', async () => {
    const store = new FileCredentialStore(tmp('kc-ensure3'))
    vi.spyOn(store, 'read').mockResolvedValue(null)
    await expect(ensureAccessToken(store, { fetchFn: (async () => new Response()) as unknown as typeof fetch }))
      .rejects.toBeInstanceOf(KimiCodeUnauthorizedError)
  })

  it('stops refreshing a token the service already rejected', async () => {
    const store = new FileCredentialStore(tmp('kc-ensure4'))
    const nearExpiry = creds({ expiresAt: Date.now() + 1_000, expiresIn: 3_600 })
    vi.spyOn(store, 'read').mockResolvedValue(nearExpiry)
    vi.spyOn(store, 'write').mockResolvedValue(undefined)
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 401 })) as unknown as typeof fetch

    await expect(ensureAccessToken(store, { fetchFn: fetchMock })).rejects.toBeInstanceOf(KimiCodeUnauthorizedError)
    // The second call must not hit the service again: the token is known dead.
    await expect(ensureAccessToken(store, { fetchFn: fetchMock })).rejects.toBeInstanceOf(KimiCodeUnauthorizedError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('KimiCodeAccessDeniedError', () => {
  it('is exported for the denied-authorization path', () => {
    expect(new KimiCodeAccessDeniedError('denied').name).toBe('KimiCodeAccessDeniedError')
  })
})
