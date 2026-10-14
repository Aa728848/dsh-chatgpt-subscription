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
 * The probe is asserted on ports this test owns, never on the machine's state
 * at the default port: whether 51121 itself sits inside an excluded range right
 * now is a machine fact, not a behavior — and a bind there dies with EACCES
 * inside the test, telling us nothing about the probe.
 *
 * "Ports this test owns" has to mean ports this test *keeps holding*. A run of
 * unusable ports assembled partly out of Windows' own reservations is not one:
 * those reservations are released while the test runs (measured here — a run
 * built that way stopped mid-run in 3 of 40 attempts, always on a port that had
 * been refused a moment earlier), and a port another process owns can be let go
 * the same way. So every blocker below is a socket this test opened and does not
 * close until the assertion is done, and the width of the run is asserted with
 * an injected judge as well as with real sockets. An occupied port must be
 * skipped, a wide unusable run must be walked past rather than reported as "no
 * usable port", a Windows-reserved one must not throw, and the redirect URI must
 * always agree with the port the listener actually bound.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http, { createServer } from 'node:http'
import { CALLBACK_PORT_ATTEMPTS, DEFAULT_CALLBACK_PORT } from '../src/host/antigravity/port-constants.ts'

const { startCallbackServer, resolveCallbackPort, redirectUri, callbackPort } = await import(
  '../src/host/antigravity/oauth.ts'
)

function listenOn(port: number, host: string): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, host, () => {
      const address = server.address()
      resolve({ server, port: address !== null && typeof address === 'object' ? address.port : 0 })
    })
  })
}

/**
 * No fixed blocker port: Windows reserves TCP port ranges (Hyper-V/WinNAT)
 * that change on every reboot, so any hard-coded port can land inside one and
 * fail this test with EACCES for a reason unrelated to the probe. The blocker
 * binds port 0 and reports the port the OS actually gave it, which is
 * bindable by construction.
 */
function listenOnEphemeralPort(host = '127.0.0.1'): Promise<{ server: http.Server; port: number }> {
  return listenOn(0, host)
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

/**
 * How far a scenario may scan for free ports before it concludes the host has
 * none. Wide enough to step over this machine's biggest reservation (277 ports
 * from the default) and the scattered singles above it, and bounded so a host
 * that refuses nearly everything fails to build a scenario quickly instead of
 * hanging.
 */
const PORT_SCAN_BUDGET = 8192

/**
 * Whether this process can bind `port` on `host` right now.
 *
 * Setup only: it picks the ports a scenario is allowed to occupy. What the code
 * under test decided is always read back from what `resolveCallbackPort`
 * returns, never from this helper's answer.
 */
function isBindable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, host)
  })
}

/**
 * First port of a run of `count` consecutive bindable ports on `host`, scanning
 * upward from `from`, or null when this host has no such run inside the budget.
 *
 * Scanning starts at the line's own default and remembers the last refused port,
 * so a run is found in one pass over the ports rather than by re-scanning: every
 * refusal only moves the candidate past itself. Nothing here is hard-coded to
 * this machine's layout — the ports that refuse are whatever the host reserves,
 * today or on the next boot.
 */
async function findBindableRun(count: number, host: string, from = DEFAULT_CALLBACK_PORT): Promise<number | null> {
  let runStart = from
  for (let port = from; port <= 65535 - count + 1 && port - from < PORT_SCAN_BUDGET; port += 1) {
    if (await isBindable(port, host)) {
      if (port - runStart + 1 >= count) return runStart
    } else {
      runStart = port + 1
    }
  }
  return null
}

/**
 * Bind and hold `count` consecutive ports on `host`, and report where the run
 * starts.
 *
 * Every port in the returned run is a socket this test opened and keeps open
 * until the caller closes it, which is what makes a scenario built on it
 * repeatable: Windows reservations inside the run would be released mid-test and
 * a port owned by another process could be let go the same way, either of which
 * hands the walk a port it was never meant to find. The scan therefore refuses
 * to build a run it has not bound itself, and a bind lost to a race (some other
 * process took the port between scan and bind) throws the run away and looks
 * again. Null means the host offers no run that wide, which is a machine fact
 * about the host, not a verdict on the probe.
 */
async function reserveRun(
  count: number,
  host: string,
): Promise<{ start: number; servers: http.Server[] } | null> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const start = await findBindableRun(count, host)
    if (start === null) return null
    const results = await Promise.allSettled(
      Array.from({ length: count }, (_unused, offset) => listenOn(start + offset, host)),
    )
    const servers = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value.server] : []))
    if (servers.length === count) return { start, servers }
    await Promise.all(servers.map((server) => close(server)))
  }
  return null
}

/**
 * Hold `start` on `host` and leave `start + 1` free, for a scenario that wants
 * the walk to step over `start` onto its neighbour. Null when the host offers no
 * such pair — no address for `host` at all (a machine with no IPv6 loopback), or
 * nothing free nearby.
 */
async function reserveBlockedPort(host: string): Promise<{ start: number; blocker: http.Server } | null> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const run = await reserveRun(2, host)
    if (run === null) return null
    const [blocker, neighbour] = run.servers
    await close(neighbour)
    // Re-checked right before the walk: the neighbour has to be free for the
    // walk to land on it, and the only thing that could have changed in between
    // is somebody else taking it.
    if (await isBindable(run.start + 1, host)) return { start: run.start, blocker }
    await close(blocker)
  }
  return null
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
    const { server: blocker, port: blockerPort } = await listenOnEphemeralPort()
    process.env.DSH_ANTIGRAVITY_CALLBACK_PORT = String(blockerPort)
    try {
      // A configured port is returned as-is by design (the caller accepted the
      // port), so the occupied-port skip applies to the unconfigured probe
      // range. Assert the resolved port is the configured one here.
      expect(await resolveCallbackPort()).toBe(blockerPort)
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
      expect(port).toBeGreaterThanOrEqual(DEFAULT_CALLBACK_PORT)
    } catch (error) {
      expect((error as Error).message).toContain('DSH_ANTIGRAVITY_CALLBACK_PORT')
    }
  })

  it('honors a configured DSH_ANTIGRAVITY_CALLBACK_PORT without probing', async () => {
    // Configured values are returned as-is, so no socket is bound here and a
    // literal port is safe: the assertion is about the value, not about
    // whether this machine can bind it.
    process.env.DSH_ANTIGRAVITY_CALLBACK_PORT = '50999'
    const port = await resolveCallbackPort()
    expect(port).toBe(50999)
    expect(callbackPort()).toBe(50999)
  })

  it('clears a run of unusable ports of a known width, wider than the window it used to ship', async () => {
    // The failure this guards is the probe *starting* inside a reservation: the
    // window has to out-run whatever it meets, not out-run a block size guessed
    // from a smaller one. A Windows 11 host was measured excluding 277
    // consecutive ports right where this line's default sits, and the window
    // that shipped with this line was 128 — so 277 is the width that has to be
    // cleared, and it is handed to the walk by the injected judge instead of by
    // this host's reservations, whose width is a machine fact and whose members
    // are released again while a test runs.
    const widestRunMeasured = 277
    const probed: number[] = []
    const port = await resolveCallbackPort(
      CALLBACK_PORT_ATTEMPTS,
      '127.0.0.1',
      DEFAULT_CALLBACK_PORT,
      async (candidate) => {
        probed.push(candidate)
        return candidate >= DEFAULT_CALLBACK_PORT + widestRunMeasured
      },
    )
    // It comes out at the first usable port, having asked about every one of
    // the run before that — a window that stopped inside would return earlier or
    // throw, and a window wider than it needs would keep asking past the answer.
    expect(port).toBe(DEFAULT_CALLBACK_PORT + widestRunMeasured)
    expect(probed).toHaveLength(widestRunMeasured + 1)
    // And the window production ships is that wide to begin with.
    expect(CALLBACK_PORT_ATTEMPTS).toBeGreaterThan(widestRunMeasured)
  })

  it('reports the actionable error when the window ends inside such a run', async () => {
    // The other half of the same contract: the bound is real, so a window that
    // does run out says so instead of reporting a port it never verified.
    await expect(resolveCallbackPort(
      4,
      '127.0.0.1',
      DEFAULT_CALLBACK_PORT,
      async () => false,
    )).rejects.toThrow(/DSH_ANTIGRAVITY_CALLBACK_PORT/)
  })

  it('walks a self-held run of unusable ports wider than any block Windows is known to hand out', async (context) => {
    // The same claim as the injected case above, this time over real sockets:
    // the run is 300 ports the test itself holds open — wider than the 277
    // measured on this line's default, wider than the 128 this line used to
    // ship — so the walk has to refuse each one on its own bind and still come
    // out with a usable port. Holding them is what makes it repeatable; see the
    // note at the top of this file.
    const runLength = 300
    const run = await reserveRun(runLength, '127.0.0.1')
    if (run === null) {
      // No run that wide anywhere near the default on this host: the scenario
      // cannot be built, which says nothing about the probe. The width of the
      // window is still pinned above, and with real sockets below.
      context.skip()
      return
    }
    const { start, servers } = run
    try {
      // A window that stops inside the run never reaches a free port at all.
      // The port just past the end is left to chance — it is not part of the run
      // this test owns — so the claim asserted here is "cleared the whole run",
      // and the claim "landed on the first usable port" is the injected case's
      // to make exactly.
      expect(await resolveCallbackPort(runLength + 1, '127.0.0.1', start)).toBeGreaterThanOrEqual(start + runLength)
      // And the window production ships has to clear a run that wide, or the
      // default can still be born inside one.
      expect(CALLBACK_PORT_ATTEMPTS).toBeGreaterThan(runLength)
    } finally {
      await Promise.all(servers.map((server) => close(server)))
    }
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
    //
    // The occupied port is one this test owns rather than the line's default:
    // whether 51121 sits inside an excluded range right now is a machine fact,
    // and a bind there dies with EACCES in the test itself. The scenario is
    // therefore identical on a machine that reserves the default and one that
    // does not.
    const reserved = await reserveBlockedPort('::1')
    if (reserved === null) {
      // No IPv6 loopback on this machine: the behavior under test cannot be
      // set up, and the other cases already cover the probe.
      return
    }
    const { start: blocked, blocker } = reserved
    try {
      // Probing the IPv4 literal would wrongly accept the blocked port.
      expect(await resolveCallbackPort(2, '127.0.0.1', blocked)).toBe(blocked)
      // Probing the host the listener actually uses skips it.
      expect(await resolveCallbackPort(2, '::1', blocked)).toBe(blocked + 1)
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
