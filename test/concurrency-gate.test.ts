import { describe, expect, it } from 'vitest'
import { getEventListeners } from 'node:events'
import { ConcurrencyGate } from '../src/host/common/concurrency-gate.ts'

describe('concurrency gate', () => {
  it('honours a lower cap without evicting existing holders', async () => {
    const gate = new ConcurrencyGate()
    const first = await gate.acquire('a')
    const second = await gate.acquire('a')
    gate.setLimit('a', 1)
    expect(gate.limitFor('a')).toBe(1)
    let granted = false
    const waiting = gate.acquire('a').then(release => { granted = true; return release })
    first()
    await Promise.resolve()
    expect(granted).toBe(false)
    expect(gate.inFlight('a')).toBe(1)
    second()
    const release = await waiting
    expect(gate.inFlight('a')).toBe(1)
    release()
  })

  it('clamps a positive fractional limit to at least one slot', async () => {
    const gate = new ConcurrencyGate()
    gate.setLimit('a', 0.5)
    expect(gate.limitFor('a')).toBe(1)
    const release = await gate.acquire('a')
    release()
  })

  it('removes the abort listener when a queued request is granted', async () => {
    const gate = new ConcurrencyGate()
    gate.setLimit('a', 1)
    const release = await gate.acquire('a')
    const controller = new AbortController()
    const waiting = gate.acquire('a', controller.signal)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)
    release()
    const next = await waiting
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    next()
  })

  it('returns a granted slot if cancellation wins before acquire resumes', async () => {
    const gate = new ConcurrencyGate()
    gate.setLimit('a', 1)
    const release = await gate.acquire('a')
    const controller = new AbortController()
    const waiting = gate.acquire('a', controller.signal)
    release()
    controller.abort(new Error('cancelled after grant'))
    await expect(waiting).rejects.toThrow('cancelled after grant')
    expect(gate.inFlight('a')).toBe(0)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

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
    expect(gate.inFlight('a')).toBe(0)
  })

  it('releasing twice cannot inflate the count for the next holder', async () => {
    const gate = new ConcurrencyGate()
    gate.setLimit('a', 1)

    const release = await gate.acquire('a')
    release()
    release()

    expect(gate.inFlight('a')).toBe(0)
    const next = await gate.acquire('a')
    let extra = false
    void gate.acquire('a').then(() => { extra = true })
    await Promise.resolve()
    expect(extra).toBe(false)
    next()
  })

  it('counts a waiter released by a removed cap as a real holder', async () => {
    const gate = new ConcurrencyGate()
    gate.setLimit('a', 1)
    const first = await gate.acquire('a')
    const waiting = gate.acquire('a')

    // Lifting the cap lets the waiter through. Both are now genuinely running,
    // so both own a slot.
    gate.setLimit('a', 0)
    const second = await waiting
    expect(gate.inFlight('a')).toBe(2)

    // Releasing one must leave the other still counted.
    first()
    expect(gate.inFlight('a')).toBe(1)
    second()
    expect(gate.inFlight('a')).toBe(0)
  })

  it('never lets a lowered cap evict a slot a holder already owns', async () => {
    const gate = new ConcurrencyGate()
    const first = await gate.acquire('a')
    const second = await gate.acquire('a')

    // A cap below the live count must not make the two holders look like one:
    // the first release would then hand a stranger a free slot.
    gate.setLimit('a', 1)
    expect(gate.inFlight('a')).toBe(2)

    first()
    expect(gate.inFlight('a')).toBe(1)
    second()
    expect(gate.inFlight('a')).toBe(0)
  })
})