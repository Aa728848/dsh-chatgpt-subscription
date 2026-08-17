import http from 'node:http'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OAUTH_TOKEN_URL } from '../src/compat.ts'
import {
  buildAuthorizationUrl,
  OAuthService,
  type OAuthServiceOptions,
} from '../src/host/oauth-service.ts'
import { MemoryTokenStore } from '../src/host/token-store.ts'

const services: OAuthService[] = []

afterEach(() => {
  for (const service of services.splice(0)) service.dispose()
})

describe('OAuthService', () => {
  it('builds an S256 authorization URL with the fixed compatibility contract', () => {
    const verifier = 'verifier-for-test'
    const url = new URL(buildAuthorizationUrl(verifier, 'state-for-test'))
    expect(`${url.origin}${url.pathname}`).toBe('https://auth.openai.com/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann')
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback')
    expect(url.searchParams.get('scope')).toBe('openid profile email offline_access')
    expect(url.searchParams.get('state')).toBe('state-for-test')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(verifier).digest('base64url'),
    )
  })

  it('completes a localhost callback, stores tokens, and exposes only masked status', async () => {
    const store = new MemoryTokenStore()
    const accessToken = jwt({
      email: 'plus@example.com',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-sensitive-4f21',
        chatgpt_plan_type: 'plus',
      },
    })
    const requests: Array<{ url: string; body: string }> = []
    const service = tracked(new OAuthService(store, {
      logger: silentLogger,
      fetchFn: async (input, init) => {
        requests.push({ url: String(input), body: String(init?.body) })
        return Response.json({
          access_token: accessToken,
          refresh_token: 'refresh-sensitive',
          expires_in: 3600,
        })
      },
    }))

    const login = await service.startLogin()
    const state = new URL(login.authUrl).searchParams.get('state')
    const completed = waitForTerminal(service, login.loginId)
    const callbackStatus = await getStatus(`http://localhost:1455/auth/callback?code=code-sensitive&state=${encodeURIComponent(state!)}`)

    expect(callbackStatus).toBe(200)
    await expect(completed).resolves.toBe('completed')
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe(OAUTH_TOKEN_URL)
    expect(requests[0]!.body).toContain('grant_type=authorization_code')
    const status = await service.status()
    expect(status).toMatchObject({
      authenticated: true,
      storage: { kind: 'memory', encrypted: false, available: true },
      account: {
        email: 'p***@example.com',
        planType: 'plus',
        accountIdSuffix: '…4f21',
      },
    })
    const serialized = JSON.stringify(status)
    expect(serialized).not.toContain(accessToken)
    expect(serialized).not.toContain('refresh-sensitive')
    expect(serialized).not.toContain('acct-sensitive-4f21')
  })

  it('marks credential storage unavailable when the store cannot be read', async () => {
    const service = tracked(new OAuthService({
      storage: { kind: 'linux-file', encrypted: false },
      load: async () => { throw new Error('permissions') },
      save: async () => undefined,
      clear: async () => undefined,
    }, { logger: silentLogger }))

    expect(await service.status()).toMatchObject({
      authenticated: false,
      storage: { kind: 'linux-file', encrypted: false, available: false },
      error: { code: 'storage-failed' },
    })
  })
  it('fails before opening an OAuth callback when credential storage is unavailable', async () => {
    const service = tracked(new OAuthService({
      storage: { kind: 'linux-file', encrypted: false },
      load: async () => { throw new Error('permissions') },
      save: async () => undefined,
      clear: async () => undefined,
    }, { logger: silentLogger }))

    await expect(service.startLogin()).rejects.toMatchObject({ code: 'storage-failed' })
  })
  it('rejects an invalid state and never stores callback credentials', async () => {
    const store = new MemoryTokenStore()
    const fetchFn = vi.fn<NonNullable<OAuthServiceOptions['fetchFn']>>()
    const service = tracked(new OAuthService(store, { fetchFn, logger: silentLogger }))
    const login = await service.startLogin()
    const failed = waitForTerminal(service, login.loginId)

    expect(await getStatus('http://localhost:1455/auth/callback?code=code&state=wrong')).toBe(400)
    await expect(failed).resolves.toBe('failed')
    expect(fetchFn).not.toHaveBeenCalled()
    expect(await store.load()).toBeNull()
  })

  it('surfaces a safe token-exchange identifier to DSH without exposing the OAuth code', async () => {
    const store = new MemoryTokenStore()
    const service = tracked(new OAuthService(store, {
      fetchFn: async () => Response.json({ error: 'invalid_grant', error_description: 'authorization code rejected' }, { status: 400 }),
      logger: silentLogger,
    }))
    const login = await service.startLogin()
    const state = new URL(login.authUrl).searchParams.get('state')
    const terminal = waitForTerminalEvent(service, login.loginId)

    expect(await getStatus(`http://localhost:1455/auth/callback?code=code-must-not-leak&state=${encodeURIComponent(state!)}`)).toBe(500)
    const event = await terminal
    expect(event).toMatchObject({
      type: 'failed',
      error: { code: 'oauth-token-exchange-failed', message: 'ChatGPT token exchange failed (400, invalid_grant).' },
    })
    expect(JSON.stringify(event)).not.toContain('code-must-not-leak')
    expect((await service.status()).error).toEqual(event.type === 'failed' ? event.error : undefined)
    expect(await store.load()).toBeNull()
  })

  it('coalesces concurrent refreshes and preserves an unrotated refresh token', async () => {
    const store = new MemoryTokenStore()
    await store.save({
      accessToken: jwt({ email: 'old@example.com' }),
      refreshToken: 'refresh-old',
      expiresAt: Date.now() - 1,
    })
    const refreshedAccess = jwt({ email: 'new@example.com', chatgpt_account_id: 'acct-new' })
    const fetchFn = vi.fn(async () => Response.json({ access_token: refreshedAccess, expires_in: 3600 }))
    const service = tracked(new OAuthService(store, { fetchFn, logger: silentLogger }))

    const [first, second] = await Promise.all([service.credentials(), service.credentials()])

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(first.accessToken).toBe(refreshedAccess)
    expect(second.accessToken).toBe(refreshedAccess)
    expect((await store.load())?.refreshToken).toBe('refresh-old')
  })

  it('deletes unusable credentials after a rejected refresh instead of retrying forever', async () => {
    const store = new MemoryTokenStore()
    await store.save({ accessToken: 'expired', refreshToken: 'rejected', expiresAt: Date.now() - 1 })
    const service = tracked(new OAuthService(store, {
      fetchFn: async () => Response.json({ error: { code: 'invalid_grant' } }, { status: 400 }),
      logger: silentLogger,
    }))

    await expect(service.credentials()).rejects.toMatchObject({
      code: 'refresh-failed',
      message: 'ChatGPT token refresh failed (400, invalid_grant). Sign in again.',
    })
    expect(await store.load()).toBeNull()
  })

  it('clears credentials on logout', async () => {
    const store = new MemoryTokenStore()
    await store.save({ accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 60_000 })
    const service = tracked(new OAuthService(store, { logger: silentLogger }))
    await service.logout()
    expect(await store.load()).toBeNull()
    expect((await service.status()).authenticated).toBe(false)
  })

  it('times out an unfinished login and releases the active task', async () => {
    const service = tracked(new OAuthService(new MemoryTokenStore(), {
      logger: silentLogger,
      loginTimeoutMs: 20,
    }))
    const login = await service.startLogin()
    await expect(waitForTerminal(service, login.loginId)).resolves.toBe('failed')
    expect((await service.status()).login.active).toBe(false)
  })
})

function tracked(service: OAuthService): OAuthService {
  services.push(service)
  return service
}

function waitForTerminal(service: OAuthService, loginId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const unsubscribe = service.subscribe(loginId, (event) => {
      if (event.type === 'pending') return
      unsubscribe?.()
      resolve(event.type)
    })
    if (unsubscribe === null) reject(new Error('login event was not registered'))
  })
}

function waitForTerminalEvent(service: OAuthService, loginId: string): Promise<Exclude<import('../src/shared/contracts.ts').LoginEventDto, { type: 'pending' }>> {
  return new Promise((resolve, reject) => {
    const unsubscribe = service.subscribe(loginId, (event) => {
      if (event.type === 'pending') return
      unsubscribe?.()
      resolve(event)
    })
    if (unsubscribe === null) reject(new Error('login event was not registered'))
  })
}

function getStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.resume()
      response.once('end', () => resolve(response.statusCode ?? 0))
    })
    request.once('error', reject)
  })
}

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.')
}

const silentLogger = { info: () => undefined, warn: () => undefined }
