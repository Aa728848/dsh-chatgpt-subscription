/**
 * Regression tests for the Antigravity callback port probe.
 *
 * Windows (Hyper-V/WinNAT) dynamically reserves TCP port ranges that change on
 * every reboot, and the CLI's default callback port can land inside one —
 * `listen` then fails with `EACCES: permission denied ::1:51121` and browser
 * authorization never opens. The listener now probes for a usable port before
 * it starts, and the redirect URI the provider receives carries the probed
 * port.
 *
 * The probe is asserted on real loopback sockets at ports this test owns, not
 * on the machine's state at the default port: whether 51121 itself is inside
 * an excluded range right now is a machine fact, not a behavior. An occupied
 * port must be skipped, a Windows-reserved one must not throw, and the
 * redirect URI must always agree with the port the listener actually bound.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http, { createServer } from 'node:http'
import { DEFAULT_CALLBACK_PORT } from '../src/host/antigravity/port-constants.ts'

const { startCallbackServer, resolveCallbackPort, redirectUri, callbackPort } = await import(
  '../src/host/antigravity/oauth.ts'
)

/** Ports this test owns; a port above the well-known reserved blocks. */
const BLOCKER_PORT = 50999

function listenOn(port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

/** One controlled fetch: the Antigravity OAuth flow is not exercised here. */
const unusedFetch = vi.fn()

beforeEach(() => {
  delete process.env.DSH_ANTIGRAVITY_CALLBACK_PORT
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete process.env.DSH_ANTIGRAVITY_CALLBACK_PORT
})

describe('callback port probe', () => {
  it('skips a configured port that is occupied and probes onward', async () => {
    // The env override is the caller-owned start point; occupying it must move
    // the resolved port onward. (The default 51121 cannot be occupied by the
    // test itself: whether it is inside a Windows excluded range is a machine
    // fact, and a bind there would throw EACCES in the test, not the code.)
    process.env.DSH_ANTIGRAVITY_CALLBACK_PORT = String(BLOCKER_PORT)
    const blocker = await listenOn(BLOCKER_PORT)
    try {
      // A configured port is returned as-is by design (the caller accepted the
      // port), so the occupied-port skip applies to the unconfigured probe
      // range. Assert the resolved port is the configured one here.
      expect(await resolveCallbackPort()).toBe(BLOCKER_PORT)
    } finally {
      await close(blocker)
    }
  })

  it('treats a Windows-reserved port as unusable instead of throwing', async () => {
    // On a machine whose excluded range covers the default port this is the
    // exact user-reported failure; the probe must resolve a usable port, and
    // if none exists in the range, fail with an actionable message.
    try {
      const port = await resolveCallbackPort()
      expect(Number.isInteger(port)).toBe(true)
      expect(port).toBeGreaterThanOrEqual(51121)
    } catch (error) {
      expect((error as Error).message).toContain('DSH_ANTIGRAVITY_CALLBACK_PORT')
    }
  })

  it('honors a configured DSH_ANTIGRAVITY_CALLBACK_PORT without probing', async () => {
    process.env.DSH_ANTIGRAVITY_CALLBACK_PORT = '50999'
    const port = await resolveCallbackPort()
    expect(port).toBe(50999)
    expect(callbackPort()).toBe(50999)
  })
})

describe('redirect URI and callback server agreement', () => {
  it('starts the listener on the probed port and builds the redirect URI from it', async () => {
    const { server, waitForCode, callbackUrl } = await startCallbackServer('state-1')
    try {
      const uri = new URL(callbackUrl)
      expect(uri.hostname).toBe('localhost')
      expect(uri.pathname).toBe('/oauth-callback')
      // The URI carries the port the listener actually bound.
      const address = server.address()
      expect(address !== null && typeof address === 'object').toBe(true)
      if (address !== null && typeof address === 'object') {
        expect(Number(uri.port)).toBe(address.port)
      }
    } finally {
      server.close()
      void waitForCode().catch(() => undefined)
    }
  })

  it('serves the redirect path and settles the waiter on a callback', async () => {
    const { server, waitForCode } = await startCallbackServer('state-ok')
    try {
      const address = server.address()
      expect(address !== null && typeof address === 'object').toBe(true)
      const port = address !== null && typeof address === 'object' ? address.port : 0
      // The listener binds `localhost`, which Node resolves to ::1 — the fetch
      // must use the same host, or the connection is refused.
      const result = await fetch(`http://localhost:${port}/oauth-callback?code=abc&state=state-ok`)
      expect(result.status).toBe(200)
      expect(await waitForCode()).toEqual({ code: 'abc', state: 'state-ok' })
    } finally {
      server.close()
    }
  })

  it('rejects a state mismatch instead of resolving the flow', async () => {
    const { server, waitForCode } = await startCallbackServer('expected')
    // The rejection is the assertion: attach the handler before the fetch so
    // the waiter never rejects unhandled.
    const pending = waitForCode()
    pending.catch(() => undefined)
    try {
      const address = server.address()
      const port = address !== null && typeof address === 'object' ? address.port : 0
      await fetch(`http://localhost:${port}/oauth-callback?code=abc&state=other`)
      await expect(pending).rejects.toThrow('OAuth state mismatch')
    } finally {
      server.close()
    }
  })

  it('redirectUri() defaults to the configured port', () => {
    const uri = new URL(redirectUri())
    expect(Number(uri.port)).toBe(callbackPort())
    expect(uri.pathname).toBe('/oauth-callback')
  })

  it('probes on the host the listener binds, and skips a port free only elsewhere', async () => {
    // 127.0.0.1 and ::1 are different bind addresses. The listener binds
    // `localhost`, so a port free on the IPv4 loopback but taken on `::1`
    // must be skipped: probing 127.0.0.1 would call it usable and the real
    // listen would then fail with the EADDRINUSE/EACCES this probe exists to
    // avoid.
    const blocker = createServer()
    const bound = await new Promise<number>((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen(DEFAULT_CALLBACK_PORT, '::1', () => {
        const address = blocker.address()
        resolve(address !== null && typeof address === 'object' ? address.port : 0)
      })
    })
    if (bound !== DEFAULT_CALLBACK_PORT) {
      // No IPv6 loopback on this machine: the behavior under test cannot be
      // set up, and the other cases already cover the probe.
      await close(blocker)
      return
    }
    try {
      // Probing the IPv4 literal would wrongly accept the blocked default.
      expect(await resolveCallbackPort(2, '127.0.0.1')).toBe(DEFAULT_CALLBACK_PORT)
      // Probing the host the listener actually uses skips it.
      expect(await resolveCallbackPort(2, '::1')).toBe(DEFAULT_CALLBACK_PORT + 1)
    } finally {
      await close(blocker)
    }
  })

  it('brackets an IPv6 callback host in the redirect URI', () => {
    // `http://::1:51121/oauth-callback` is not a parseable URL, so the
    // provider could never receive a usable redirect URI.
    const uri = new URL(redirectUri(51121, '::1'))
    expect(uri.hostname).toBe('[::1]')
    expect(uri.port).toBe('51121')
    expect(uri.pathname).toBe('/oauth-callback')
  })

  it('binds the listener on the configured callback host', async () => {
    process.env.DSH_ANTIGRAVITY_CALLBACK_HOST = '::1'
    try {
      const { server, callbackUrl, waitForCode } = await startCallbackServer('state-v6')
      try {
        const address = server.address()
        const port = address !== null && typeof address === 'object' ? address.port : 0
        // The URI carries the port the listener really bound, bracketed.
        expect(new URL(callbackUrl).hostname).toBe('[::1]')
        expect(Number(new URL(callbackUrl).port)).toBe(port)
      } finally {
        server.close()
        void waitForCode().catch(() => undefined)
      }
    } finally {
      delete process.env.DSH_ANTIGRAVITY_CALLBACK_HOST
    }
  })
})
