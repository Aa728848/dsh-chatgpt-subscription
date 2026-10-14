import { describe, expect, it } from 'vitest'
import { findAvailablePort } from '../src/host/command-code/oauth.ts'
import { CALLBACK_PORT_ATTEMPTS, DEFAULT_CALLBACK_PORT } from '../src/host/command-code/types.ts'

/**
 * Widest run of consecutive unusable loopback ports measured on a Windows host.
 *
 * 277 is what one host handed out contiguously (51121-51397); it is not a width
 * Windows documents, and the runs move on every reboot. It is used here only as
 * a floor the window must clear.
 *
 * The probe is injected in every case below, so the outcome depends on this
 * number and on CALLBACK_PORT_ATTEMPTS alone and never on what the host running
 * the suite happens to be reserving right now. Binding hundreds of real sockets
 * to manufacture an excluded run instead would race the OS, which can release
 * the run mid-test.
 */
const WIDEST_RUN_MEASURED = 277

describe('Command Code callback port window', () => {
  it('opens the search at the official CLI port', async () => {
    const probed: number[] = []
    const port = await findAvailablePort(DEFAULT_CALLBACK_PORT, CALLBACK_PORT_ATTEMPTS, async (candidate) => {
      probed.push(candidate)
      return true
    })

    // The literal is deliberate: 'matches the official CLI' is a claim about an
    // upstream number this repository cannot read, so it is pinned here instead
    // of being derived from the constant that merely claims to match it.
    expect(port).toBe(5959)
    expect(probed).toEqual([DEFAULT_CALLBACK_PORT])
  })

  it('covers more ports than the widest excluded run ever measured', () => {
    expect(CALLBACK_PORT_ATTEMPTS).toBeGreaterThan(WIDEST_RUN_MEASURED)
  })

  it('walks past an excluded run instead of failing inside it', async () => {
    const probed: number[] = []
    const port = await findAvailablePort(DEFAULT_CALLBACK_PORT, CALLBACK_PORT_ATTEMPTS, async (candidate) => {
      probed.push(candidate)
      return candidate >= DEFAULT_CALLBACK_PORT + WIDEST_RUN_MEASURED
    })

    // Under the CLI own ten-port window this THROWS, which is the point: this
    // line has no manual flow to fall back to, so a window narrower than the run
    // is a dead sign-in rather than a downgrade.
    expect(port).toBe(DEFAULT_CALLBACK_PORT + WIDEST_RUN_MEASURED)
    expect(probed).toHaveLength(WIDEST_RUN_MEASURED + 1)
  })

  it('throws only after exhausting the window, naming the range it tried', async () => {
    const probed: number[] = []
    await expect(findAvailablePort(
      DEFAULT_CALLBACK_PORT,
      CALLBACK_PORT_ATTEMPTS,
      async (candidate) => {
        probed.push(candidate)
        return false
      },
    )).rejects.toThrow(new RegExp('tried ' + CALLBACK_PORT_ATTEMPTS + ' ports from ' + DEFAULT_CALLBACK_PORT))

    expect(probed).toHaveLength(CALLBACK_PORT_ATTEMPTS)
  })

  it('keeps the widened window clear of the OS dynamic range', () => {
    // Ports past the CLI own range are ports other software holds (6379 and
    // friends); the probe simply skips them. What must not happen is reaching
    // 49152+, where the OS hands the same numbers to its own outgoing
    // connections and a callback listener starts racing outbound traffic.
    expect(DEFAULT_CALLBACK_PORT + CALLBACK_PORT_ATTEMPTS).toBeLessThan(49152)
  })
})
