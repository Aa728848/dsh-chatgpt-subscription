import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  CHECKIN_ATTEMPT_CAP,
  CHECKIN_INACTIVE_RECHECK_MS,
  MinimaxCodeCheckinAccountMismatchError,
  MinimaxCodeCheckinService,
  localDateString,
  type MinimaxCodeCheckinPool,
} from '../src/host/minimax-code/checkin.ts'
import {
  SIGNIN_CLAIM_PATH,
  SIGNIN_STATUS_PATH,
  USER_INFO_PATH,
  checkinAccountIdentity,
  claimSignin,
  currentSigninStreak,
  fetchSigninPanel,
  validateClaimSigninData,
  validateSigninPanel,
  type SigninPanel,
} from '../src/host/minimax-code/checkin-gateway.ts'
import type { MinimaxCodeAccountSummaryDto } from '../src/host/minimax-code/account-pool.ts'
import type { MinimaxCodeCredentials } from '../src/host/minimax-code/token-store.ts'

const temporaryDirs: string[] = []

const DAY_UPCOMING = 1
const DAY_CLAIMABLE = 2
const DAY_CLAIMED = 3

function md5(value: string): string {
  return createHash('md5').update(value).digest('hex')
}

/** A valid seven-day panel; today's cell sits at day_no 2 by default. */
function makePanel(todayStatus: number, options: { todayDayNo?: number; claimedBefore?: number } = {}): SigninPanel {
  const todayDayNo = options.todayDayNo ?? 2
  const claimedBefore = options.claimedBefore ?? (todayStatus === DAY_CLAIMED ? todayDayNo - 1 : 0)
  return {
    scene: 2,
    days: Array.from({ length: 7 }, (_, index) => {
      const dayNo = index + 1
      const isToday = dayNo === todayDayNo
      return {
        day_no: dayNo,
        points: dayNo === 4 || dayNo === 7 ? 2000 : 800,
        bonus_points: dayNo === 1 ? 0 : 400,
        status: isToday ? todayStatus : dayNo < todayDayNo ? (dayNo <= claimedBefore ? DAY_CLAIMED : DAY_UPCOMING) : DAY_UPCOMING,
        is_today: isToday,
      }
    }),
  }
}

function makeClaim(points = 800, claimResult = 1) {
  return {
    claim_id: 'claim-1',
    claim_result: claimResult,
    day_no: 2,
    points,
    expire_at_ms: Date.now() + 30 * 86_400_000,
    panel: makePanel(DAY_CLAIMED),
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status })
}

interface FetchLog {
  urls: string[]
  calls: { status: number; claim: number; identity: number }
  fetchFn: typeof fetch
}

/** A fetch double that answers the three check-in surfaces and counts them. */
function makeFetch(behavior: {
  identity?: unknown
  identityStatus?: number
  panel?: unknown
  panelStatus?: number
  claim?: unknown
  claimStatus?: number
} = {}): FetchLog {
  const urls: string[] = []
  const calls = { status: 0, claim: 0, identity: 0 }
  const fetchFn = (async (url: any) => {
    const target = String(url)
    urls.push(target)
    if (target.includes(USER_INFO_PATH)) {
      calls.identity += 1
      if (behavior.identityStatus !== undefined) return new Response('', { status: behavior.identityStatus })
      return jsonResponse(behavior.identity ?? { data: { userInfo: { realUserID: 'ru-1', name: 'tester' } } })
    }
    if (target.includes(SIGNIN_STATUS_PATH)) {
      calls.status += 1
      if (behavior.panelStatus !== undefined) return new Response('', { status: behavior.panelStatus })
      return jsonResponse({ base_resp: { status_code: 0, status_msg: 'ok' }, data: behavior.panel ?? makePanel(DAY_CLAIMABLE) })
    }
    if (target.includes(SIGNIN_CLAIM_PATH)) {
      calls.claim += 1
      if (behavior.claimStatus !== undefined) return new Response('', { status: behavior.claimStatus })
      return jsonResponse({ base_resp: { status_code: 0, status_msg: 'ok' }, data: behavior.claim ?? makeClaim() })
    }
    throw new Error(`unexpected fetch: ${target}`)
  }) as unknown as typeof fetch
  return { urls, calls, fetchFn }
}

function makeAccount(id: string, region: 'cn' | 'global' = 'cn'): MinimaxCodeAccountSummaryDto {
  return { id, alias: id, isPrimary: true, region } as MinimaxCodeAccountSummaryDto
}

/**
 * One credential, complete enough that its pool identity is real.
 *
 * `checkinAccountIdentity` reads `region` plus either `recordKey` (the desktop
 * app's record slot) or `loginEpoch` (a plugin-owned sign-in), so a double that
 * only carried an access token would silently skip every assertion under test.
 */
function makeCredential(
  token: string,
  facts: { region?: 'cn' | 'global'; recordKey?: string | null; loginEpoch?: string } = {},
): MinimaxCodeCredentials {
  const recordKey = facts.recordKey ?? null
  return {
    accessToken: token,
    refreshToken: `refresh-${token}`,
    tokenType: 'Bearer',
    clientId: 'test-client',
    scopes: [],
    audience: 'test',
    expiresAtMs: Date.now() + 3_600_000,
    generation: 0,
    loginEpoch: facts.loginEpoch ?? '',
    buildEnv: 'release',
    region: facts.region ?? 'cn',
    recordKey,
    source: recordKey === null ? 'file' : 'minimax-native',
  }
}

interface PoolLog {
  pool: MinimaxCodeCheckinPool
  renewals: string[]
  /** Re-point one row at another sign-in, as adopting a different credential does. */
  setCredential(accountId: string, credentials: MinimaxCodeCredentials): void
  /** What a forced renewal answers with; defaults to a rotation of the row's own credential. */
  setRenewal(accountId: string, credentials: MinimaxCodeCredentials): void
}

function makePool(accounts: MinimaxCodeAccountSummaryDto[]): PoolLog {
  const renewals: string[] = []
  // Each row starts on its own native record slot, which is the ordinary shape.
  const held = new Map(accounts.map((account) => [
    account.id,
    makeCredential(`token-${account.id}`, {
      region: account.region ?? 'cn',
      recordKey: `rk-${account.id}`,
    }),
  ]))
  const renewalsByAccount = new Map<string, MinimaxCodeCredentials>()
  const pool = {
    listAccounts: async () => accounts,
    getFreshCredential: async (accountId: string) => held.get(accountId) ?? makeCredential('token-missing'),
    renewCredential: async (accountId: string) => {
      renewals.push(accountId)
      const pinned = renewalsByAccount.get(accountId)
      if (pinned !== undefined) return pinned
      const current = held.get(accountId) ?? makeCredential(`token-${accountId}`)
      return { ...current, accessToken: `${current.accessToken}-renewed`, generation: current.generation + 1 }
    },
  } as unknown as MinimaxCodeCheckinPool
  return {
    pool,
    renewals,
    setCredential(accountId, credentials) { held.set(accountId, credentials) },
    setRenewal(accountId, credentials) { renewalsByAccount.set(accountId, credentials) },
  }
}

/** The scheduler's own state document, as it lands on disk. */
async function readStateFile(dir: string): Promise<Record<string, any>> {
  return JSON.parse(await fs.readFile(path.join(dir, 'checkin-state.json'), 'utf8')) as Record<string, any>
}

async function writeStateFile(dir: string, document: unknown): Promise<void> {
  await fs.writeFile(path.join(dir, 'checkin-state.json'), JSON.stringify(document), 'utf8')
}

async function makeDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mmcode-checkin-'))
  temporaryDirs.push(dir)
  return dir
}

function makeService(dir: string, pool: MinimaxCodeCheckinPool, fetchLog: FetchLog, options: {
  settings?: () => { enabled: boolean }
  now?: () => number
  logger?: { info(message: string): void; warn(message: string): void }
} = {}): MinimaxCodeCheckinService {
  return new MinimaxCodeCheckinService(pool, {
    fetchFn: fetchLog.fetchFn,
    settings: options.settings ?? (() => ({ enabled: true })),
    statePath: path.join(dir, 'checkin-state.json'),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })
}

/** Collects what the scheduler logs, so the non-secret warn line can be asserted. */
function makeLogger(): { info: string[]; warn: string[]; logger: { info(m: string): void; warn(m: string): void } } {
  const info: string[] = []
  const warn: string[] = []
  return { info, warn, logger: { info: (m: string) => info.push(m), warn: (m: string) => warn.push(m) } }
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const dir of temporaryDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

describe('MiniMax Code check-in service', () => {
  it('signs in when today is claimable, then stays idle for the day', async () => {
    const dir = await makeDir()
    const fetchLog = makeFetch()
    const service = makeService(dir, makePool([makeAccount('acc-1')]).pool, fetchLog)

    await service.tick()
    expect(fetchLog.calls.identity).toBe(1)
    expect(fetchLog.calls.status).toBe(1)
    expect(fetchLog.calls.claim).toBe(1)

    const callsAfterFirst = fetchLog.urls.length
    await service.tick()
    expect(fetchLog.urls.length).toBe(callsAfterFirst)

    const summary = await service.summary()
    expect(summary.doneToday).toBe(1)
    expect(summary.failedToday).toBe(0)
    expect(summary.claimedPoints).toBe(800)
    expect(summary.streakDays).toBe(2)
    expect(summary.lastRunAt).not.toBeNull()
  })

  it('records an already-claimed today without posting a claim', async () => {
    const dir = await makeDir()
    const fetchLog = makeFetch({ panel: makePanel(DAY_CLAIMED) })
    const service = makeService(dir, makePool([makeAccount('acc-1')]).pool, fetchLog)

    await service.tick()
    expect(fetchLog.calls.status).toBe(1)
    expect(fetchLog.calls.claim).toBe(0)

    const summary = await service.summary()
    expect(summary.doneToday).toBe(1)
    expect(summary.claimedPoints).toBeUndefined()
  })

  it('treats claim_result 2 (already claimed upstream) as a success', async () => {
    const dir = await makeDir()
    const fetchLog = makeFetch({ claim: makeClaim(800, 2) })
    const service = makeService(dir, makePool([makeAccount('acc-1')]).pool, fetchLog)

    await service.tick()
    const summary = await service.summary()
    expect(summary.doneToday).toBe(1)
    expect(summary.failedToday).toBe(0)
    // An upstream-already-claimed answer grants nothing new, so no points show.
    expect(summary.claimedPoints).toBeUndefined()
  })

  it('signs every pooled account in, each against its own region origin', async () => {
    const dir = await makeDir()
    const fetchLog = makeFetch()
    const service = makeService(dir, makePool([makeAccount('acc-cn', 'cn'), makeAccount('acc-gl', 'global')]).pool, fetchLog)

    await service.tick()
    expect(fetchLog.calls.claim).toBe(2)
    expect(fetchLog.urls.some((url) => url.startsWith('https://agent.minimaxi.com/'))).toBe(true)
    expect(fetchLog.urls.some((url) => url.startsWith('https://agent.minimax.io/'))).toBe(true)
    const summary = await service.summary()
    expect(summary.doneToday).toBe(2)
    expect(summary.totalAccounts).toBe(2)
  })

  it('parks a not-yet-claimable today and re-checks it on the slow cadence only', async () => {
    const dir = await makeDir()
    // Keep this cadence test within one local day, independent of wall clock.
    let nowMs = new Date(2026, 0, 15, 12, 0, 0).getTime()
    const fetchLog = makeFetch({ panel: makePanel(DAY_UPCOMING) })
    const service = makeService(dir, makePool([makeAccount('acc-1')]).pool, fetchLog, { now: () => nowMs })

    await service.tick()
    expect(fetchLog.calls.status).toBe(1)
    expect(fetchLog.calls.claim).toBe(0)
    let summary = await service.summary()
    expect(summary.doneToday).toBe(0)
    expect(summary.skippedToday).toBe(1)

    // Ten minutes later the parked entry short-circuits the pass entirely.
    nowMs += 10 * 60 * 1000
    await service.tick()
    expect(fetchLog.calls.status).toBe(1)

    // Past the hourly re-check the panel is read again.
    nowMs += CHECKIN_INACTIVE_RECHECK_MS
    await service.tick()
    expect(fetchLog.calls.status).toBe(2)

    // A manual pass always overrides the throttle, even inside the hour.
    const before = fetchLog.calls.status
    await service.tick(true)
    expect(fetchLog.calls.status).toBe(before + 1)
    summary = await service.summary()
    expect(summary.doneToday).toBe(0)
  })

  it('rechecks an inactive account after local midnight even inside the throttle', async () => {
    const dir = await makeDir()
    let nowMs = new Date(2026, 0, 15, 23, 55, 0).getTime()
    const fetchLog = makeFetch({ panel: makePanel(DAY_UPCOMING) })
    const service = makeService(dir, makePool([makeAccount('acc-1')]).pool, fetchLog, { now: () => nowMs })
    await service.tick()
    expect(fetchLog.calls.status).toBe(1)
    nowMs += 10 * 60 * 1000
    await service.tick()
    expect(fetchLog.calls.status).toBe(2)
  })

  it('caps a failing account and lets a manual pass ignore the cap', async () => {
    const dir = await makeDir()
    const fetchLog = makeFetch({ claimStatus: 500 })
    const service = makeService(dir, makePool([makeAccount('acc-1')]).pool, fetchLog)

    for (let run = 0; run < CHECKIN_ATTEMPT_CAP; run += 1) await service.tick()
    const callsAtCap = fetchLog.calls.claim
    expect(callsAtCap).toBe(CHECKIN_ATTEMPT_CAP)

    await service.tick()
    expect(fetchLog.calls.claim).toBe(callsAtCap)
    let summary = await service.summary()
    expect(summary.failedToday).toBe(1)

    await service.tick(true)
    expect(fetchLog.calls.claim).toBe(callsAtCap + 1)
    summary = await service.summary()
    expect(summary.failedToday).toBe(1)
  })

  it('honours the toggle on automatic passes but not on a manual one', async () => {
    const dir = await makeDir()
    const fetchLog = makeFetch()
    const service = makeService(dir, makePool([makeAccount('acc-1')]).pool, fetchLog, {
      settings: () => ({ enabled: false }),
    })

    await service.tick()
    expect(fetchLog.urls).toHaveLength(0)

    await service.tick(true)
    expect(fetchLog.calls.claim).toBe(1)
  })

  it('renews the credential once on a 401 and signs in on the retry', async () => {
    const dir = await makeDir()
    let claimCalls = 0
    const urls: string[] = []
    const fetchFn = (async (url: any) => {
      const target = String(url)
      urls.push(target)
      if (target.includes(USER_INFO_PATH)) {
        return jsonResponse({ data: { userInfo: { realUserID: 'ru-1' } } })
      }
      if (target.includes(SIGNIN_STATUS_PATH)) {
        return jsonResponse({ base_resp: { status_code: 0 }, data: makePanel(DAY_CLAIMABLE) })
      }
      if (target.includes(SIGNIN_CLAIM_PATH)) {
        claimCalls += 1
        if (claimCalls === 1) return new Response('', { status: 401 })
        return jsonResponse({ base_resp: { status_code: 0 }, data: makeClaim() })
      }
      throw new Error(`unexpected fetch: ${target}`)
    }) as unknown as typeof fetch
    const { pool, renewals } = makePool([makeAccount('acc-1')])
    const service = makeService(dir, pool, { urls, calls: { status: 0, claim: 0, identity: 0 }, fetchFn })

    await service.tick()
    expect(renewals).toEqual(['acc-1'])
    expect(claimCalls).toBe(2)
    // The retried claim rides the renewed token.
    const claimUrls = urls.filter((url) => url.includes(SIGNIN_CLAIM_PATH))
    expect(claimUrls.some((url) => url.includes('token-acc-1-renewed'))).toBe(false) // token is in the header, never the URL
    const summary = await service.summary()
    expect(summary.doneToday).toBe(1)
  })

  it('burns an attempt when the renewal does not clear the rejection', async () => {
    const dir = await makeDir()
    const fetchLog = makeFetch({ claimStatus: 401 })
    const { pool, renewals } = makePool([makeAccount('acc-1')])
    const service = makeService(dir, pool, fetchLog)

    await service.tick()
    expect(renewals).toEqual(['acc-1'])
    expect(fetchLog.calls.claim).toBe(2)
    const summary = await service.summary()
    expect(summary.doneToday).toBe(0)
    expect(summary.failedToday).toBe(0) // one attempt used, cap not reached yet
  })

  it('restores the day state from disk so a restart does not re-sign', async () => {
    const dir = await makeDir()
    const firstFetch = makeFetch()
    const first = makeService(dir, makePool([makeAccount('acc-1')]).pool, firstFetch)
    await first.tick()
    expect(firstFetch.calls.claim).toBe(1)

    const secondFetch = makeFetch()
    const second = makeService(dir, makePool([makeAccount('acc-1')]).pool, secondFetch)
    await second.tick()
    expect(secondFetch.urls).toHaveLength(0)
    const summary = await second.summary()
    expect(summary.doneToday).toBe(1)
    expect(summary.lastRunAt).not.toBeNull()
  })

  it('reuses the cached identity across days without another identity call', async () => {
    const dir = await makeDir()
    let nowMs = Date.now()
    const fetchLog = makeFetch()
    const service = makeService(dir, makePool([makeAccount('acc-1')]).pool, fetchLog, { now: () => nowMs })

    await service.tick()
    expect(fetchLog.calls.identity).toBe(1)

    nowMs += 86_400_000
    await service.tick()
    expect(fetchLog.calls.identity).toBe(1)
    expect(fetchLog.calls.status).toBe(2)
    expect(fetchLog.calls.claim).toBe(2)
  })
})

describe('MiniMax Code check-in account consistency', () => {
  it('claims with the credentials of one account and pins that account in the state', async () => {
    const dir = await makeDir()
    const fetchLog = makeFetch()
    const { pool } = makePool([makeAccount('acc-1')])
    const service = makeService(dir, pool, fetchLog)

    await service.tick()
    expect(fetchLog.calls.identity).toBe(1)
    expect(fetchLog.calls.status).toBe(1)
    expect(fetchLog.calls.claim).toBe(1)
    const summary = await service.summary()
    expect(summary.doneToday).toBe(1)
    expect(summary.failedToday).toBe(0)

    // The identity the entry is signed in under is pinned to the sign-in it was
    // learned with, and that pin is persisted — the next boot compares against it.
    const state = await readStateFile(dir)
    expect(state.identities['acc-1']).toEqual({ realUserID: 'ru-1', region: 'cn', accountIdentity: 'native:cn:rk-acc-1' })
    // Nothing secret is written into the state document.
    expect(JSON.stringify(state)).not.toContain('token-acc-1')
  })

  it('re-syncs and signs the current account in when the row now holds another account', async () => {
    const dir = await makeDir()
    const fetchLog = makeFetch({ panel: makePanel(DAY_UPCOMING) })
    const poolLog = makePool([makeAccount('acc-1')])
    const first = makeService(dir, poolLog.pool, fetchLog)

    // Day one: the identity ru-1 is learned for acc-1, today is not claimable yet.
    await first.tick()
    expect(fetchLog.calls.identity).toBe(1)
    expect((await first.summary()).skippedToday).toBe(1)

    // The row is re-pointed at a different sign-in: same pool row id, different
    // account behind it. That is a state change, not a fault.
    poolLog.setCredential('acc-1', makeCredential('token-other', { region: 'cn', recordKey: 'rk-someone-else' }))

    const log = makeLogger()
    const claimable = makeFetch({ identity: { data: { userInfo: { realUserID: 'ru-2' } } } })
    const second = makeService(dir, poolLog.pool, claimable, { logger: log.logger })
    await second.tick(true)

    // The identity is resolved afresh WITH the credential now held, and that is
    // the account both calls are sent for — never A's realUserID with B's token.
    expect(claimable.calls.identity).toBe(1)
    expect(claimable.calls.status).toBe(1)
    expect(claimable.calls.claim).toBe(1)
    expect(claimable.urls.find((url) => url.includes(SIGNIN_STATUS_PATH))).toContain('user_id=ru-2')
    expect(claimable.urls.find((url) => url.includes(SIGNIN_CLAIM_PATH))).toContain('user_id=ru-2')

    const summary = await second.summary()
    expect(summary.doneToday).toBe(1)
    expect(summary.skippedToday).toBe(0)
    expect(summary.failedToday).toBe(0)

    // The pin is re-written to the account the row now holds.
    const state = await readStateFile(dir)
    expect(state.identities['acc-1']).toEqual({ realUserID: 'ru-2', region: 'cn', accountIdentity: 'native:cn:rk-someone-else' })
    expect(state.accounts['acc-1'].lastError).toBeUndefined()

    // One non-secret warning records the re-sync: account keys and the row id only.
    expect(log.warn).toHaveLength(1)
    expect(log.warn[0]).toContain('acc-1')
    expect(log.warn[0]).toContain('native:cn:rk-acc-1')
    expect(log.warn[0]).toContain('native:cn:rk-someone-else')
    expect(log.warn[0]).not.toContain('token-other')
    expect(log.warn[0]).not.toContain('ru-1')

    // The next pass rides the refreshed pin instead of paying for another call.
    const nextDay = makeFetch({ identity: { data: { userInfo: { realUserID: 'ru-2' } } } })
    const tomorrow = makeService(dir, poolLog.pool, nextDay, { now: () => Date.now() + 86_400_000 })
    await tomorrow.tick()
    expect(nextDay.calls.identity).toBe(0)
    expect(nextDay.calls.claim).toBe(1)
  })

  it('refuses when the credential identity drifts between the two calls', async () => {
    const dir = await makeDir()
    const fetchLog = makeFetch()
    const poolLog = makePool([makeAccount('acc-1')])
    // A credential whose identity changes under the attempt. Nothing in the
    // scheduler does this today — the credential is captured in a local and only
    // the forced-renewal path swaps it, and that one is refused separately — so
    // this getter is how the guard's contract is exercised at all.
    // Reads 1 and 2 are `identityFor` resolving and `attemptOnce` capturing the
    // pin; the panel's guard is read 3. If that ever stops being true this test
    // fails loudly, which is the point: the guard is only worth keeping if it
    // can still fire.
    let reads = 0
    const drifting = makeCredential('token-drift', { region: 'cn', recordKey: 'rk-acc-1' })
    Object.defineProperty(drifting, 'recordKey', {
      get: () => (reads++ < 2 ? 'rk-acc-1' : 'rk-other'),
      configurable: true,
    })
    poolLog.setCredential('acc-1', drifting)
    const service = makeService(dir, poolLog.pool, fetchLog)

    await service.tick()
    // Refused before anything was sent: the panel never went out, so no claim
    // could be posted for a different account than the one being signed in.
    expect(fetchLog.calls.status).toBe(0)
    expect(fetchLog.calls.claim).toBe(0)
    expect((await service.summary()).doneToday).toBe(0)

    const state = await readStateFile(dir)
    const lastError = String(state.accounts['acc-1'].lastError)
    expect(lastError).toContain('账号不一致')
    expect(lastError).toContain('native:cn:rk-acc-1')
    expect(lastError).toContain('native:cn:rk-other')
    expect(lastError).not.toContain('token-drift')
  })

  it('heals a state document written before the pin existed', async () => {
    const dir = await makeDir()
    const today = localDateString(Date.now())
    // A document from an older build: an identity with no accountIdentity field.
    await writeStateFile(dir, {
      version: 1,
      lastRunAt: null,
      accounts: { 'acc-1': { date: today, done: false, attempts: 0 } },
      identities: { 'acc-1': { realUserID: 'ru-1', region: 'cn' } },
    })
    const log = makeLogger()
    const fetchLog = makeFetch()
    const service = makeService(dir, makePool([makeAccount('acc-1')]).pool, fetchLog, { logger: log.logger })

    await service.tick()
    // Re-resolved once, signed in normally, and pinned on the way out.
    expect(fetchLog.calls.identity).toBe(1)
    expect(fetchLog.calls.claim).toBe(1)
    expect((await service.summary()).doneToday).toBe(1)
    const state = await readStateFile(dir)
    expect(state.identities['acc-1'].accountIdentity).toBe('native:cn:rk-acc-1')
    // A format upgrade is not an account change: no warning.
    expect(log.warn).toHaveLength(0)
  })

  it('refuses a forced renewal that answers with a different account', async () => {
    const dir = await makeDir()
    const fetchLog = makeFetch({ claimStatus: 401 })
    const poolLog = makePool([makeAccount('acc-1')])
    // The renewal lands on another account's sign-in. This one is a mid-attempt
    // swap, so it must NOT self-heal the way a re-pointed row does.
    poolLog.setRenewal('acc-1', makeCredential('token-swapped', { region: 'cn', recordKey: 'rk-b' }))
    const log = makeLogger()
    const service = makeService(dir, poolLog.pool, fetchLog, { logger: log.logger })

    await service.tick()
    // The panel was read once and rejected once; no second attempt ran under the
    // foreign credential, and no identity was resolved for it either.
    expect(fetchLog.calls.status).toBe(1)
    expect(fetchLog.calls.claim).toBe(1)
    expect(fetchLog.calls.identity).toBe(1)
    const summary = await service.summary()
    expect(summary.doneToday).toBe(0)

    const state = await readStateFile(dir)
    const lastError = String(state.accounts['acc-1'].lastError)
    expect(lastError).toContain('账号不一致')
    expect(lastError).toContain('native:cn:rk-acc-1')
    expect(lastError).toContain('native:cn:rk-b')
    expect(lastError).not.toContain('token-swapped')
    // The foreign account is never pinned: the entry the 401 path drops stays
    // dropped, instead of being rewritten to the swapped sign-in the way a
    // re-pointed row is.
    expect(state.identities['acc-1']).toBeUndefined()
  })

  it('treats a rotation of the same sign-in as the same account', async () => {
    const dir = await makeDir()
    let claimCalls = 0
    const fetchFn = (async (url: any) => {
      const target = String(url)
      if (target.includes(USER_INFO_PATH)) return jsonResponse({ data: { userInfo: { realUserID: 'ru-1' } } })
      if (target.includes(SIGNIN_STATUS_PATH)) return jsonResponse({ base_resp: { status_code: 0 }, data: makePanel(DAY_CLAIMABLE) })
      if (target.includes(SIGNIN_CLAIM_PATH)) {
        claimCalls += 1
        if (claimCalls === 1) return new Response('', { status: 401 })
        return jsonResponse({ base_resp: { status_code: 0 }, data: makeClaim() })
      }
      throw new Error(`unexpected fetch: ${target}`)
    }) as unknown as typeof fetch
    const poolLog = makePool([makeAccount('acc-1')])
    // Same native record slot, rotated tokens: still one account, so the retry
    // is allowed to claim with the renewed credential.
    poolLog.setRenewal('acc-1', makeCredential('token-rotated', { region: 'cn', recordKey: 'rk-acc-1' }))
    const service = makeService(dir, poolLog.pool, { urls: [], calls: { status: 0, claim: 0, identity: 0 }, fetchFn })

    await service.tick()
    expect(poolLog.renewals).toEqual(['acc-1'])
    expect(claimCalls).toBe(2)
    const summary = await service.summary()
    expect(summary.doneToday).toBe(1)
    const state = await readStateFile(dir)
    expect(state.accounts['acc-1'].lastError).toBeUndefined()
  })

  it('derives the identity key from the non-secret facts alone', () => {
    expect(checkinAccountIdentity({ region: 'cn', recordKey: 'rk-1', loginEpoch: 'le-1' })).toBe('native:cn:rk-1')
    expect(checkinAccountIdentity({ region: 'global', recordKey: null, loginEpoch: 'le-1' })).toBe('signin:global:le-1')
    expect(checkinAccountIdentity({ region: 'cn', recordKey: '', loginEpoch: '' })).toBeUndefined()
    expect(checkinAccountIdentity({ recordKey: 'rk-1' })).toBeUndefined()
    // The token is never part of the key, so a rotation cannot change it.
    const rotated = makeCredential('token-a', { region: 'cn', recordKey: 'rk-1' })
    const next = { ...rotated, accessToken: 'token-b', refreshToken: 'refresh-b', generation: 3 }
    expect(checkinAccountIdentity(next)).toBe(checkinAccountIdentity(rotated))
  })

  it('keeps the panel validation strict even though the account is pinned', async () => {
    const dir = await makeDir()
    // A duplicate claimable day is a wire surprise, not "nothing to do".
    const broken = makePanel(DAY_CLAIMABLE)
    broken.days[3]!.status = DAY_CLAIMABLE
    const fetchLog = makeFetch({ panel: broken })
    const { pool } = makePool([makeAccount('acc-1')])
    const service = makeService(dir, pool, fetchLog)

    await service.tick()
    expect(fetchLog.calls.claim).toBe(0)
    const summary = await service.summary()
    expect(summary.doneToday).toBe(0)
    expect(summary.skippedToday).toBe(0)
  })
})

describe('MiniMax Code check-in wire', () => {
  it('signs requests the way the official client does', async () => {
    const urls: string[] = []
    const seen: Record<string, string>[] = []
    const fetchFn = (async (url: any, init: any) => {
      urls.push(String(url))
      seen.push(init.headers as Record<string, string>)
      return jsonResponse({ base_resp: { status_code: 0 }, data: makePanel(DAY_CLAIMED) })
    }) as unknown as typeof fetch

    await fetchSigninPanel('token-x', 'ru-1', 'cn', { fetchFn, appVersion: '9.9.9' })
    expect(urls).toHaveLength(1)
    const url = new URL(urls[0]!)
    expect(url.origin).toBe('https://agent.minimaxi.com')
    expect(url.pathname).toBe(SIGNIN_STATUS_PATH)
    expect(url.searchParams.get('user_id')).toBe('ru-1')
    expect(url.searchParams.get('client')).toBe('mcode')
    expect(url.searchParams.get('device_id')).toBe('0')
    expect(url.searchParams.get('desktop_version')).toBe('9.9.9')

    const headers = seen[0]!
    expect(headers.authorization).toBe('Bearer token-x')
    const timestamp = headers['x-timestamp']!
    expect(/^\d{10}$/.test(timestamp)).toBe(true) // whole seconds, not ms
    expect(headers['x-signature']).toBe(md5(`${timestamp}I*7Cf%WZ#S&%1RlZJ&C2`))
    const unix = url.searchParams.get('unix')!
    expect(headers.yy).toBe(md5(`${encodeURIComponent(`${url.pathname}${url.search}`)}_{}${md5(unix)}ooui`))
    // The plugin identifies itself; the official app's UA is never forged.
    expect(headers['user-agent']).toContain('dsh-chatgpt-subscription')
  })

  it('signs the claim body into both hashes', async () => {
    const seen: Record<string, string>[] = []
    let signedUrl = ''
    const fetchFn = (async (url: any, init: any) => {
      signedUrl = String(url)
      seen.push(init.headers as Record<string, string>)
      return jsonResponse({ base_resp: { status_code: 0 }, data: makeClaim() })
    }) as unknown as typeof fetch

    await claimSignin('token-x', 'ru-1', 'cn', { fetchFn, appVersion: '9.9.9' })
    const headers = seen[0]!
    const timestamp = headers['x-timestamp']!
    expect(headers['x-signature']).toBe(md5(`${timestamp}I*7Cf%WZ#S&%1RlZJ&C2{}`))
    const url = new URL(signedUrl)
    const unix = url.searchParams.get('unix')!
    expect(headers.yy).toBe(md5(`${encodeURIComponent(`${url.pathname}${url.search}`)}_{}${md5(unix)}ooui`))
  })

  it('rejects malformed panels instead of guessing', () => {
    expect(() => validateSigninPanel(null)).toThrow('Invalid sign-in panel')
    expect(() => validateSigninPanel({ scene: 2, days: makePanel(DAY_CLAIMABLE).days.slice(0, 6) })).toThrow()
    const duplicated = makePanel(DAY_CLAIMABLE)
    duplicated.days[0]!.day_no = 2
    expect(() => validateSigninPanel(duplicated)).toThrow()
    const twoClaimable = makePanel(DAY_CLAIMABLE)
    twoClaimable.days[2]!.status = DAY_CLAIMABLE
    expect(() => validateSigninPanel(twoClaimable)).toThrow()
    const twoToday = makePanel(DAY_CLAIMABLE)
    twoToday.days[0]!.is_today = true
    expect(() => validateSigninPanel(twoToday)).toThrow()
    const badScene = makePanel(DAY_CLAIMABLE)
    ;(badScene as { scene: number }).scene = 9
    expect(() => validateSigninPanel(badScene)).toThrow()
  })

  it('rejects malformed claim responses', () => {
    expect(() => validateClaimSigninData(null)).toThrow('Invalid sign-in claim response')
    expect(() => validateClaimSigninData({ ...makeClaim(), claim_id: '' })).toThrow()
    expect(() => validateClaimSigninData({ ...makeClaim(), claim_result: 9 })).toThrow()
    expect(() => validateClaimSigninData({ ...makeClaim(), panel: null })).toThrow()
    expect(validateClaimSigninData(makeClaim(800, 2)).claim_result).toBe(2)
  })

  it('counts the streak the way the official client does', () => {
    // Today claimed at day 2 with day 1 claimed: streak 2.
    expect(currentSigninStreak(makePanel(DAY_CLAIMED, { todayDayNo: 2, claimedBefore: 1 }).days)).toBe(2)
    // Today still claimable: the streak up to yesterday is what a claim extends.
    expect(currentSigninStreak(makePanel(DAY_CLAIMABLE, { todayDayNo: 3, claimedBefore: 2 }).days)).toBe(2)
    // A gap in the claimed prefix stops the count.
    expect(currentSigninStreak(makePanel(DAY_CLAIMED, { todayDayNo: 3, claimedBefore: 1 }).days)).toBe(1)
    // Today upcoming: no streak to report.
    expect(currentSigninStreak(makePanel(DAY_UPCOMING, { todayDayNo: 2 }).days)).toBe(0)
  })

  it('reads the local calendar day the state entries key on', () => {
    const date = new Date(2026, 0, 5, 9, 30)
    expect(localDateString(date.getTime())).toBe('2026-01-05')
  })
})

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { MinimaxCodeCredentialStore, MinimaxCodeModelSettingsStore } from '../src/host/minimax-code/token-store.ts'
import { registerMinimaxCodeRoutes } from '../src/host/minimax-code/routes.ts'

function routeRequest(input: { url: string; method?: string; body?: unknown }): IncomingMessage {
  const listeners = new Map<string, Array<(value?: unknown) => void>>()
  const req = {
    url: input.url,
    method: input.method ?? 'GET',
    headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
    on(event: string, listener: (value?: unknown) => void) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return req
    },
    destroy() {},
  } as unknown as IncomingMessage
  if (input.method === 'POST') {
    queueMicrotask(() => {
      if (input.body !== undefined) listeners.get('data')?.forEach((l) => l(Buffer.from(JSON.stringify(input.body))))
      listeners.get('end')?.forEach((l) => l())
    })
  }
  return req
}

function routeExchange(): { response: ServerResponse; captured: { status?: number; body?: any } } {
  const captured: { status?: number; body?: any } = {}
  const response = {
    writeHead(status: number) { captured.status = status; return response },
    end(raw?: string) { captured.body = raw === undefined ? undefined : JSON.parse(raw) },
  } as unknown as ServerResponse
  return { response, captured }
}

function routeHarness(checkin?: { tick(manual?: boolean): Promise<void>; summary(): Promise<any> }, options: {
  settingsStore?: MinimaxCodeModelSettingsStore
} = {}) {
  const store = new MinimaxCodeCredentialStore()
  const settingsStore = options.settingsStore ?? new MinimaxCodeModelSettingsStore()
  const routes: Array<{ path: string; handler: (r: IncomingMessage, s: ServerResponse) => Promise<void> }> = []
  const ctx = {
    webServer: { register(route: { path: string; handler: unknown }) { routes.push(route as never); return () => undefined } },
    logger: { warn() {}, info() {} },
    emit() {},
  } as unknown as Context
  const dispose = registerMinimaxCodeRoutes(ctx, store, { checkin }, settingsStore)
  return { handler: routes[0]!.handler, dispose }
}

describe('MiniMax Code check-in routes', () => {
  it('reports checkin: null when no scheduler is wired', async () => {
    const { handler, dispose } = routeHarness()
    try {
      const { response, captured } = routeExchange()
      await handler(routeRequest({ url: '/minimax-code/api/status' }), response)
      expect(captured.status).toBe(200)
      expect(captured.body.value.checkin).toBeNull()
    } finally {
      dispose()
    }
  })

  it('runs a manual pass through /checkin/now and answers with the summary', async () => {
    const dir = await makeDir()
    const ticks: boolean[] = []
    const checkin = {
      async tick(manual = false) { ticks.push(manual) },
      async summary() {
        return { enabled: true, totalAccounts: 1, doneToday: 1, skippedToday: 0, failedToday: 0, lastRunAt: 123 }
      },
    }
    const { handler, dispose } = routeHarness(checkin)
    try {
      const { response, captured } = routeExchange()
      await handler(routeRequest({ url: '/minimax-code/api/checkin/now', method: 'POST', body: {} }), response)
      expect(captured.status).toBe(200)
      expect(ticks).toEqual([true])
      expect(captured.body.value.checkin.doneToday).toBe(1)
    } finally {
      dispose()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('answers 400 on /checkin/now when no scheduler is wired', async () => {
    const { handler, dispose } = routeHarness()
    try {
      const { response, captured } = routeExchange()
      await handler(routeRequest({ url: '/minimax-code/api/checkin/now', method: 'POST', body: {} }), response)
      expect(captured.status).toBe(400)
    } finally {
      dispose()
    }
  })

  it('persists the check-in toggle through /settings and reflects it in the summary', async () => {
    const dir = await makeDir()
    const settingsStore = new MinimaxCodeModelSettingsStore(path.join(dir, 'models.json'))
    const checkin = {
      async tick() {},
      async summary() {
        const stored = await settingsStore.read()
        return {
          enabled: stored.checkin?.enabled !== false,
          totalAccounts: 0, doneToday: 0, skippedToday: 0, failedToday: 0, lastRunAt: null,
        }
      },
    }
    const { handler, dispose } = routeHarness(checkin, { settingsStore })
    try {
      const off = routeExchange()
      await handler(routeRequest({
        url: '/minimax-code/api/settings', method: 'POST', body: { checkin: { enabled: false } },
      }), off.response)
      expect(off.captured.status).toBe(200)
      expect(off.captured.body.value.checkin.enabled).toBe(false)
      // The write survives a fresh read of the same store, so the next boot
      // finds the toggle where the user left it.
      expect((await settingsStore.read()).checkin?.enabled).toBe(false)

      const on = routeExchange()
      await handler(routeRequest({
        url: '/minimax-code/api/settings', method: 'POST', body: { checkin: { enabled: true } },
      }), on.response)
      expect(on.captured.body.value.checkin.enabled).toBe(true)
      expect((await settingsStore.read()).checkin?.enabled).toBe(true)
    } finally {
      dispose()
    }
  })

  it('rejects a cross-origin mutation on /checkin/now', async () => {
    const { handler, dispose } = routeHarness({
      async tick() {},
      async summary() { return { enabled: true, totalAccounts: 0, doneToday: 0, skippedToday: 0, failedToday: 0, lastRunAt: null } },
    })
    try {
      const { response, captured } = routeExchange()
      const req = routeRequest({ url: '/minimax-code/api/checkin/now', method: 'POST', body: {} })
      ;(req.headers as Record<string, string>).origin = 'https://evil.example'
      await handler(req, response)
      expect(captured.status).toBe(403)
    } finally {
      dispose()
    }
  })
})
