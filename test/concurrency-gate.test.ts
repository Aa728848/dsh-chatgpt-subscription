import { describe, expect, it } from 'vitest'
import { ConcurrencyGate } from '../src/host/common/concurrency-gate.ts'

describe('concurrency gate', () => {
  it('passes everything through while the account is uncapped', async () => {
    const gate = new ConcurrencyGate()

    const first = await gate.acquire('a')
    const second = await gate.acquire('a')

    expect(gate.inFlight('a')).toBe(2)
    first()
    second()
    expect(gate.inFlight('a')).toBe(0)
  })

  it('queues past the limit and releases in order', async () => {
    const gate = new ConcurrencyGate()
    gate.setLimit('a', 1)

    const first = await gate.acquire('a')
    let secondTaken = false
    const second = gate.acquire('a').then(release => {
      secondTaken = true
      return release
    })

    // The second request waits rather than exceeding what the account allows.
    await Promise.resolve()
    expect(secondTaken).toBe(false)
    expect(gate.inFlight('a')).toBe(1)

    first()
    const releaseSecond = await second
    expect(gate.inFlight('a')).toBe(1)
    releaseSecond()
    expect(gate.inFlight('a')).toBe(0)
  })

  it('keeps each account independent', async () => {
    const gate = new ConcurrencyGate()
    gate.setLimit('a', 1)
    gate.setLimit('b', 1)

    const first = await gate.acquire('a')
    // A busy account must not stall an unrelated one.
    const other = await gate.acquire('b')

    expect(gate.inFlight('a')).toBe(1)
    expect(gate.inFlight('b')).toBe(1)
    first()
    other()
  })

  it('does not hand a slot to a request that was cancelled while waiting', async () => {
    const gate = new ConcurrencyGate()
    gate.setLimit('a', 1)
    const first = await gate.acquire('a')

    const controller = new AbortController()
    const queued = gate.acquire('a', controller.signal)
    controller.abort()

    await expect(queued).rejects.toBeDefined()
    first()
    // The cancelled waiter took no slot, so the account is free again.
    expect(gate.inFlight('a')).toBe(0)
  })

  it('releasing twice cannot inflate the count for the next holder', async () => {
    const gate = new ConcurrencyGate()
    gate.setLimit('a', 1)

    const release = await gate.acquire('a')
    release()
    release()

    expect(gate.inFlight('a')).toBe(0)
    // The next holder owns the only slot; a phantom release would have freed two.
    const next = await gate.acquire('a')
    let extra = false
    void gate.acquire('a').then(() => { extra = true })
    await Promise.resolve()
    expect(extra).toBe(false)
    next()
  })
})