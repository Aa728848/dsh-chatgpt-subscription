import { describe, expect, it } from 'vitest'
import { isAuxiliaryRequest, PrefixRequestCoordinator } from '../src/host/common/prefix-request-coordinator.ts'

describe('PrefixRequestCoordinator', () => {
  it('staggers a cold follower and reuses a proven warm prefix', async () => {
    const coordinator = new PrefixRequestCoordinator({ waitMs: 30 })
    const signal = new AbortController().signal
    const leader = await coordinator.acquire('group', signal, 1_000)
    expect(leader.leader).toBe(true)
    let followerDone = false
    const follower = coordinator.acquire('group', signal, 1_000).then(lease => { followerDone = true; return lease })
    expect(followerDone).toBe(false)
    leader.markWarm()
    leader.release()
    expect((await follower).leader).toBe(false)
    expect((await coordinator.acquire('group', signal, 1_000)).leader).toBe(false)
  })

  it('without a TTL only de-duplicates the current flight', async () => {
    const coordinator = new PrefixRequestCoordinator({ waitMs: 30 })
    const signal = new AbortController().signal
    const first = await coordinator.acquire('group', signal)
    first.markWarm()
    first.release()
    expect(coordinator.isWarm('group', 0)).toBe(false)
    expect((await coordinator.acquire('group', signal)).leader).toBe(true)
  })

  it('re-elects a leader whose ownership has exceeded the wait budget', async () => {
    let now = 1_000
    const coordinator = new PrefixRequestCoordinator({ waitMs: 20, now: () => now })
    const signal = new AbortController().signal
    await coordinator.acquire('group', signal)
    now += 21
    expect((await coordinator.acquire('group', signal)).leader).toBe(true)
  })

  it('serializes burst work and releases a main-session header gate', async () => {
    const coordinator = new PrefixRequestCoordinator({ waitMs: 30 })
    const signal = new AbortController().signal
    const burst = await coordinator.acquireBurst('account:model', signal)
    const next = coordinator.acquireBurst('account:model', signal)
    burst.release()
    expect((await next).leader).toBe(true)

    const main = coordinator.registerMainSession('session')
    const title = coordinator.waitForMainSession('session', signal)
    main.release()
    await title
  })

  it('honours an explicit observation time for warm lookups', async () => {
    let now = 1_000
    const coordinator = new PrefixRequestCoordinator({ now: () => now })
    const lease = await coordinator.acquire('group', new AbortController().signal, 100)
    lease.markWarm()
    lease.release()
    expect(coordinator.isWarm('group', 100, 1_050)).toBe(true)
    expect(coordinator.isWarm('group', 100, 1_101)).toBe(false)
  })

  it('reset releases pending waiters and forgets warm evidence', async () => {
    const coordinator = new PrefixRequestCoordinator({ waitMs: 1_000 })
    const signal = new AbortController().signal
    const leader = await coordinator.acquire('group', signal, 1_000)
    leader.markWarm()
    const pending = coordinator.acquire('other', signal)
    coordinator.reset()
    expect((await pending).leader).toBe(true)
    expect(coordinator.isWarm('group', 1_000)).toBe(false)
  })
})

describe('auxiliary request gate', () => {
  it('uses purpose metadata without guessing from prompt text', () => {
    expect(isAuxiliaryRequest({ purpose: 'session-title' })).toBe(true)
    expect(isAuxiliaryRequest({})).toBe(false)
  })
})
