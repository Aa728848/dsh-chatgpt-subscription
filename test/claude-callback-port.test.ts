import { describe, expect, it } from 'vitest'
import { resolveCallbackPort } from '../src/host/claude/oauth.ts'
import { CALLBACK_PORT_ATTEMPTS, DEFAULT_CALLBACK_PORT } from '../src/host/claude/types.ts'

/**
 * Widest run of consecutive unusable loopback ports measured on a Windows host.
 *
 * 277 is what one host handed out contiguously (51121-51397); it is not a width
 * Windows documents, and the runs move on every reboot. It is used here only as
 * a floor the window must clear.
 *
 * Every probe in this file is INJECTED, which is the whole point of it. These
 * cases therefore depend on this number and on CALLBACK_PORT_ATTEMPTS alone, and
 * never on what the host running the suite happens to be reserving at the
 * moment: a test that binds hundreds of real sockets to manufacture an excluded
 * run races the OS, which can release the run mid-test.
 */
const WIDEST_RUN_MEASURED = 277

describe('Claude loopback callback port window', () => {
  it('covers more ports than the widest excluded run ever measured', () => {
    expect(CALLBACK_PORT_ATTEMPTS).toBeGreaterThan(WIDEST_RUN_MEASURED)
  })

  it('walks past an excluded run instead of stopping inside it', async () => {
    const probed: number[] = []
    const port = await resolveCallbackPort(async (candidate) => {
      probed.push(candidate)
      return candidate >= DEFAULT_CALLBACK_PORT + WIDEST_RUN_MEASURED
    })

    // A window narrower than the run returns null here. null is not an error on
    // this line: beginLogin reads it as 'fall back to the manual flow'. So the
    // defect is not a crash, it is a user silently pushed into pasting a code on
    // a machine with hundreds of free ports one step behind the run.
    expect(port).toBe(DEFAULT_CALLBACK_PORT + WIDEST_RUN_MEASURED)
    expect(probed).toHaveLength(WIDEST_RUN_MEASURED + 1)
  })

  it('tries the registered default first, so widening never reorders the search', async () => {
    const probed: number[] = []
    const port = await resolveCallbackPort(async (candidate) => {
      probed.push(candidate)
      return true
    })

    expect(port).toBe(DEFAULT_CALLBACK_PORT)
    expect(probed).toEqual([DEFAULT_CALLBACK_PORT])
  })

  it('gives up only after walking the entire window', async () => {
    const probed: number[] = []
    const port = await resolveCallbackPort(async (candidate) => {
      probed.push(candidate)
      return false
    })

    expect(port).toBeNull()
    expect(probed).toHaveLength(CALLBACK_PORT_ATTEMPTS)
    expect(probed[0]).toBe(DEFAULT_CALLBACK_PORT)
    expect(probed[probed.length - 1]).toBe(DEFAULT_CALLBACK_PORT + CALLBACK_PORT_ATTEMPTS - 1)
  })

  it('never walks past the port ceiling', () => {
    expect(DEFAULT_CALLBACK_PORT + CALLBACK_PORT_ATTEMPTS).toBeLessThanOrEqual(65535)
  })
})
