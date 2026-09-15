import { afterEach, describe, expect, it } from 'vitest'
import {
  buildAuthUrl,
  createAuthServer,
  findAvailablePort,
  generateState,
  resetWebLogin,
  type CommandCodeAuthServerHandle,
} from '../src/host/command-code/oauth.ts'

const handles: CommandCodeAuthServerHandle[] = []

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close()
  resetWebLogin()
})

async function start(landingGraceMs = 30): Promise<CommandCodeAuthServerHandle> {
  const port = await findAvailablePort()
  const handle = await createAuthServer(port, 'state-token', { landingGraceMs })
  handles.push(handle)
  return handle
}

function callbackUrl(handle: CommandCodeAuthServerHandle, path = '/callback'): string {
  return `http://127.0.0.1:${handle.port}${path}`
}

describe('Command Code browser sign-in', () => {
  it('builds the studio URL the official CLI builds', () => {
    const url = new URL(buildAuthUrl({ port: 5959, state: 'abc' }))
    expect(url.origin).toBe('https://commandcode.ai')
    expect(url.pathname).toBe('/studio/auth/cli')
    expect(url.searchParams.get('callback')).toBe('http://127.0.0.1:5959/callback')
    expect(url.searchParams.get('state')).toBe('abc')
    expect(url.searchParams.get('mode')).toBe('redirect')
  })

  it('mints a high-entropy state token', () => {
    const first = generateState()
    expect(first).not.toBe(generateState())
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('finds a loopback port in the CLI probe range', async () => {
    const port = await findAvailablePort()
    expect(port).toBeGreaterThanOrEqual(5959)
    expect(port).toBeLessThan(5959 + 10)
  })

  it('answers the studio preflight, including the private-network request header', async () => {
    const handle = await start()
    const response = await fetch(callbackUrl(handle), {
      method: 'OPTIONS',
      headers: {
        origin: 'https://commandcode.ai',
        'access-control-request-method': 'POST',
        'access-control-request-private-network': 'true',
      },
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://commandcode.ai')
    expect(response.headers.get('access-control-allow-private-network')).toBe('true')
    expect(response.headers.get('access-control-allow-headers')).toBe('Content-Type')
  })

  it('accepts the studio form POST, redirects the tab, and publishes the credential', async () => {
    const handle = await start()
    const pending = handle.waitForCredentials()
    const response = await fetch(callbackUrl(handle), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://commandcode.ai' },
      body: new URLSearchParams({
        apiKey: 'cmd_key_123',
        state: 'state-token',
        userId: 'u1',
        userName: 'Eddy',
        keyName: 'laptop',
      }).toString(),
    })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/callback/complete?state=state-token')

    const completion = await fetch(callbackUrl(handle, '/callback/complete?state=state-token'))
    expect(completion.status).toBe(200)
    expect(await completion.text()).toContain('Sign in successful')

    await expect(pending).resolves.toEqual({
      apiKey: 'cmd_key_123',
      state: 'state-token',
      userId: 'u1',
      userName: 'Eddy',
      keyName: 'laptop',
    })
  })

  it('accepts the legacy JSON body shape as well', async () => {
    const handle = await start()
    const pending = handle.waitForCredentials()
    const response = await fetch(callbackUrl(handle), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'cmd_key_json', state: 'state-token', userId: 'u2', userName: 'N', keyName: 'k' }),
    })
    expect(response.status).toBe(303)
    await expect(pending).resolves.toMatchObject({ apiKey: 'cmd_key_json', userId: 'u2' })
  })

  it('rejects a callback whose state token does not match', async () => {
    const handle = await start()
    const response = await fetch(callbackUrl(handle), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ apiKey: 'k', state: 'wrong', userId: 'u', userName: 'n', keyName: 'k' }).toString(),
    })
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ success: false, error: 'Invalid state token' })
  })

  it('rejects a completion page request for an unknown state', async () => {
    const handle = await start()
    const response = await fetch(callbackUrl(handle, '/callback/complete?state=other'))
    expect(response.status).toBe(403)
    expect(await response.text()).toContain('Invalid state token')
  })

  it('reports a denied authorization to the caller', async () => {
    const handle = await start()
    const pending = handle.waitForCredentials()
    const response = await fetch(callbackUrl(handle), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ error: 'access_denied', error_description: 'no thanks', state: 'state-token' }).toString(),
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Authorization denied')
    await expect(pending).rejects.toThrow('no thanks')
  })

  it('refuses a GET on the callback endpoint and a missing payload', async () => {
    const handle = await start()
    const get = await fetch(callbackUrl(handle))
    expect(get.status).toBe(405)
    expect(await get.text()).toContain('Return to DSH')

    const missing = await fetch(callbackUrl(handle), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ state: 'state-token' }).toString(),
    })
    expect(missing.status).toBe(400)
  })

  it('rejects an unsupported content type and an unknown path', async () => {
    const handle = await start()
    const wrongType = await fetch(callbackUrl(handle), { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })
    expect(wrongType.status).toBe(415)
    const notFound = await fetch(callbackUrl(handle, '/other'))
    expect(notFound.status).toBe(404)
  })

  it('rejects a waiter when the attempt is closed before a credential lands', async () => {
    const handle = await start()
    const pending = handle.waitForCredentials()
    handle.close()
    await expect(pending).rejects.toThrow(/cancelled or timed out/)
  })

  it('publishes the landed credential even when the browser never fetches the completion page', async () => {
    const handle = await start(20)
    const pending = handle.waitForCredentials()
    await fetch(callbackUrl(handle), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ apiKey: 'k', state: 'state-token', userId: '', userName: '', keyName: '' }).toString(),
    })
    await expect(pending).resolves.toMatchObject({ apiKey: 'k' })
  })
})
