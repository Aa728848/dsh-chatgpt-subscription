import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  WorkBuddyAccountPool,
  parseWorkBuddyPoolData,
} from '../src/host/workbuddy/account-pool.ts'
import { FileCredentialStore } from '../src/host/workbuddy/token-store.ts'
import { createWorkBuddyStore } from './support/workbuddy-fixtures.ts'

const temporaryDirs: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const dir of temporaryDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

/** Mirrors the platform backends: JSON on disk, and the parse hook on read. */
class PoolBackend {
  private data: unknown = null
  constructor(private readonly parse: (value: unknown) => unknown) {}
  async load() { return this.data === null ? null : this.parse(JSON.parse(JSON.stringify(this.data))) }
  async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

async function makePool(): Promise<WorkBuddyAccountPool> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-model-park-'))
  temporaryDirs.push(dir)
  const store = createWorkBuddyStore(dir) as FileCredentialStore
  const pool = new WorkBuddyAccountPool({ store, backend: new PoolBackend(parseWorkBuddyPoolData) as never })
  // Two managed accounts: a model park is only meaningful when another account
  // can take the same request.
  for (const uid of ['uid-a', 'uid-b']) {
    await pool.addAccount({
      accessToken: `at-${uid}`,
      refreshToken: `rt-${uid}`,
      expiresAt: Date.now() + 3_600_000,
      region: 'cn',
      domain: 'copilot.tencent.com',
      backend: 'https://copilot.tencent.com',
      uid,
      nickname: uid,
      sourceFile: '',
      sourceMtimeMs: 0,
      source: 'managed',
    })
  }
  return pool
}

describe('per-model parks', () => {
  it('parks one model and keeps the account serving the others', async () => {
    const pool = await makePool()
    const accounts = await pool.listAccounts()
    const parkedId = accounts[0]!.id
    const otherId = accounts[1]!.id

    const until = pool.markModelCooldown(parkedId, 'glm-5.3', 60_000)
    expect(until).toBeGreaterThan(Date.now())
    expect(pool.modelCooldownUntil(parkedId, 'glm-5.3')).toBe(until)
    // Not a park on any other model.
    expect(pool.modelCooldownUntil(parkedId, 'kimi-k3')).toBeUndefined()

    // The parked model routes to the other account.
    const forParkedModel = await pool.getEffectiveCredential(undefined, undefined as never, 'glm-5.3')
    expect(forParkedModel.account.id).toBe(otherId)
    // The account itself is untouched: it still serves its other models first.
    const forOtherModel = await pool.getEffectiveCredential(undefined, undefined as never, 'kimi-k3')
    expect(forOtherModel.account.id).toBe(parkedId)
  })

  it('lifts the park when its window passes', async () => {
    vi.useFakeTimers()
    const pool = await makePool()
    const accounts = await pool.listAccounts()
    const parkedId = accounts[0]!.id
    pool.markModelCooldown(parkedId, 'glm-5.3', 1_000)
    vi.advanceTimersByTime(1_500)
    expect(pool.modelCooldownUntil(parkedId, 'glm-5.3')).toBeUndefined()
    const picked = await pool.getEffectiveCredential(undefined, undefined as never, 'glm-5.3')
    expect(picked.account.id).toBe(parkedId)
  })

  it('answers availability for the model asked about, not for any model', async () => {
    const pool = await makePool()
    const accounts = await pool.listAccounts()
    const [first, second] = accounts.map((account) => account.id)
    // Park the first account on one model, then mark both as tried.
    pool.markModelCooldown(first!, 'glm-5.3', 60_000)
    const tried = new Set<string>([first!])
    // Another account can still serve it, so rotation must continue.
    expect(await pool.hasAnotherAvailableAccountFor(tried, 'glm-5.3')).toBe(true)
    expect(await pool.hasAnotherAvailableAccountFor(new Set([first!, second!]), 'glm-5.3')).toBe(false)
    // A park on another model must not remove this account from rotation.
    expect(await pool.hasAnotherAvailableAccountFor(new Set([second!]), 'kimi-k3')).toBe(true)
  })

  it('clears a park when asked for a non-positive duration', async () => {
    const pool = await makePool()
    const accounts = await pool.listAccounts()
    const parkedId = accounts[0]!.id
    pool.markModelCooldown(parkedId, 'glm-5.3', 60_000)
    expect(pool.markModelCooldown(parkedId, 'glm-5.3', 0)).toBeUndefined()
    expect(pool.modelCooldownUntil(parkedId, 'glm-5.3')).toBeUndefined()
  })
})

describe('reporting the model parks', () => {
  it('reports a live park on the account summary', async () => {
    const pool = await makePool()
    const accounts = await pool.listAccounts()
    const parkedId = accounts[0]!.id

    const until = pool.markModelCooldown(parkedId, 'glm-5.3', 60_000)
    expect(until).toBeGreaterThan(Date.now())

    const summaries = await pool.listAccounts()
    const summary = summaries.find((account) => account.id === parkedId)
    // The card draws the park from here, so the summary must name the model
    // and the instant the park lifts - the one the upstream named, not a
    // duration counted again on the way out.
    expect(summary?.modelCooldowns).toEqual([{ model: 'glm-5.3', cooldownUntil: until }])
  })

  it('leaves a park whose window has passed out of the summary', async () => {
    vi.useFakeTimers()
    try {
      const pool = await makePool()
      const accounts = await pool.listAccounts()
      const parkedId = accounts[0]!.id
      pool.markModelCooldown(parkedId, 'glm-5.3', 1_000)

      // The park is reported while its window is open...
      const live = (await pool.listAccounts()).find((account) => account.id === parkedId)
      expect(live?.modelCooldowns).toHaveLength(1)

      vi.advanceTimersByTime(1_500)

      // ...and gone once the window has passed.
      const summaries = await pool.listAccounts()
      const summary = summaries.find((account) => account.id === parkedId)
      // A window that has passed is not a park any more: reporting it would
      // draw a model as refused that may already serve.
      expect(summary?.modelCooldowns ?? []).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the account cooldown and its model parks together', async () => {
    const pool = await makePool()
    const accounts = await pool.listAccounts()
    const parkedId = accounts[0]!.id
    await pool.markCooldown(parkedId, 60_000, 'WorkBuddy 429')
    pool.markModelCooldown(parkedId, 'glm-5.3', 60_000)

    const before = (await pool.listAccounts()).find((account) => account.id === parkedId)
    expect(before?.cooldownUntil).toBeGreaterThan(Date.now())
    expect(before?.modelCooldowns).toHaveLength(1)

    await pool.clearCooldown(parkedId)

    const after = (await pool.listAccounts()).find((account) => account.id === parkedId)
    // The card's "reset cooldown" button must leave nothing behind: a park
    // that survived it would be a state the user cannot clear at all.
    expect(after?.cooldownUntil).toBeUndefined()
    expect(after?.modelCooldowns ?? []).toEqual([])
  })
})
