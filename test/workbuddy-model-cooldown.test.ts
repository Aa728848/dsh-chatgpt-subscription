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
