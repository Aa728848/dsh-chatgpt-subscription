import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  CHECKIN_ATTEMPT_CAP,
  CHECKIN_INACTIVE_RECHECK_MS,
  CHECKIN_PATH,
  CHECKIN_STATUS_PATH,
  WorkBuddyCheckinService,
} from '../src/host/workbuddy/checkin.ts'
import { FileModelSettingsStore, registerWorkBuddyPreferenceStore } from '../src/host/workbuddy/token-store.ts'
import { createWorkBuddyStore } from './support/workbuddy-fixtures.ts'

/**
 * Regressions for the review findings on the daily check-in scheduler.
 *
 * Each case pins a behaviour that was wrong in the first revision and would
 * silently come back: the startup preference race, the day-long abandonment of
 * an account whose activity had not opened yet, the card counting a non-sign-in
 * as a sign-in, and a manual pass being absorbed by an in-flight automatic one.
 */

const temporaryDirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const dir of temporaryDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

async function makeDir(options: {
  count?: number
  domain?: string
  expiresAt?: number
} = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-checkin-fix-'))
  temporaryDirs.push(dir)
  const count = options.count ?? 1
  for (let index = 0; index < count; index += 1) {
    await fs.writeFile(path.join(dir, `wb-${index}.info`), JSON.stringify({
      account: { uid: `uid-${index}`, nickname: `n${index}`, type: 'personal' },
      auth: {
        accessToken: `token-${index}`,
        refreshToken: 'refresh',
        expiresAt: options.expiresAt ?? Date.now() + 3_600_000,
        domain: options.domain ?? 'copilot.tencent.com',
      },
    }), 'utf8')
  }
  return dir
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status })
}

interface Log {
  urls: string[]
  fetchFn: typeof fetch
}

function makeFetch(handler: (url: string, index: number) => Response | Promise<Response>): Log {
  const urls: string[] = []
  const fetchFn = (async (url: any) => {
    urls.push(String(url))
    return handler(String(url), urls.length - 1)
  }) as unknown as typeof fetch
  return { urls, fetchFn }
}

function makeService(dir: string, log: Log, options: {
  settings?: () => { enabled: boolean }
  ready?: () => Promise<void>
  now?: () => number
} = {}): WorkBuddyCheckinService {
  return new WorkBuddyCheckinService(createWorkBuddyStore(dir), {
    fetchFn: log.fetchFn,
    settings: options.settings ?? (() => ({ enabled: true })),
    ...(options.ready === undefined ? {} : { ready: options.ready }),
    ...(options.now === undefined ? {} : { now: options.now }),
    statePath: path.join(dir, 'checkin-state.json'),
  })
}

/** The default happy path: active activity, check-in accepted. */
function happyPath(url: string): Response {
  if (url.includes(CHECKIN_STATUS_PATH)) {
    return jsonResponse({ code: 0, data: { active: true, today_checked_in: false } })
  }
  return jsonResponse({ code: 0, data: { total_credits: 10 } })
}

describe('check-in startup honours the stored preference', () => {
  it('does not sign in when the toggle was turned off in a previous session', async () => {
    const dir = await makeDir()
    // A file-backed store with check-in disabled on disk: this is the harness
    // without a register seam (0.1.7's SettingsForms), which is what ships.
    const settingsPath = path.join(dir, 'models.json')
    await fs.writeFile(settingsPath, JSON.stringify({
      enabled: true,
      enabledModelIds: [],
      contextWindowOverrides: {},
      defaultReasoningEffort: null,
      selectedAccountId: null,
      hiddenAccountIds: [],
      checkin: { enabled: false },
    }), 'utf8')

    const preferences = registerWorkBuddyPreferenceStore(undefined, new FileModelSettingsStore(settingsPath))
    const log = makeFetch(happyPath)
    const service = makeService(dir, log, {
      settings: () => preferences.status().checkin,
      ready: () => preferences.ready(),
    })

    // The host ticks immediately after constructing the service.
    await service.tick()
    expect(log.urls).toHaveLength(0)
    expect((await service.summary()).doneToday).toBe(0)
  })

  it('reports the stored toggle in the summary even before a pass runs', async () => {
    const dir = await makeDir()
    const settingsPath = path.join(dir, 'models.json')
    await fs.writeFile(settingsPath, JSON.stringify({ checkin: { enabled: false } }), 'utf8')
    const preferences = registerWorkBuddyPreferenceStore(undefined, new FileModelSettingsStore(settingsPath))
    const log = makeFetch(happyPath)
    const service = makeService(dir, log, {
      settings: () => preferences.status().checkin,
      ready: () => preferences.ready(),
    })
    // The card reads the summary before any tick; it must not show the default.
    expect((await service.summary()).enabled).toBe(false)
  })

  it('still signs in when the stored preference is on', async () => {
    const dir = await makeDir()
    const settingsPath = path.join(dir, 'models.json')
    await fs.writeFile(settingsPath, JSON.stringify({
      enabled: true,
      enabledModelIds: [],
      contextWindowOverrides: {},
      defaultReasoningEffort: null,
      selectedAccountId: null,
      hiddenAccountIds: [],
      checkin: { enabled: true },
    }), 'utf8')
    const preferences = registerWorkBuddyPreferenceStore(undefined, new FileModelSettingsStore(settingsPath))
    const log = makeFetch(happyPath)
    const service = makeService(dir, log, {
      settings: () => preferences.status().checkin,
      ready: () => preferences.ready(),
    })
    await service.tick()
    expect(log.urls.filter((url) => url.includes(CHECKIN_PATH))).toHaveLength(1)
  })

  it('exposes a ready() that resolves for both store shapes', async () => {
    const dir = await makeDir()
    const settingsPath = path.join(dir, 'models.json')
    const file = registerWorkBuddyPreferenceStore(undefined, new FileModelSettingsStore(settingsPath))
    await expect(file.ready()).resolves.toBeUndefined()
    expect(file.status().checkin).toEqual({ enabled: true })

    const register = { register: () => ({ get: () => ({ checkin: { enabled: false } }), update: async () => undefined, watch: () => () => undefined }) }
    const scoped = registerWorkBuddyPreferenceStore(register)
    await expect(scoped.ready()).resolves.toBeUndefined()
    expect(scoped.status().checkin).toEqual({ enabled: false })
  })
})

describe('check-in re-checks an activity that has not opened yet', () => {
  it('signs in later the same day once the activity becomes active', async () => {
    const dir = await makeDir()
    let active = false
    const log = makeFetch((url) => {
      if (url.includes(CHECKIN_STATUS_PATH)) {
        return jsonResponse({ code: 0, data: { active, today_checked_in: false } })
      }
      return jsonResponse({ code: 0, data: { total_credits: 4 } })
    })
    // The clock advances past the re-check throttle, as ten-minute ticks do.
    let clock = Date.parse('2026-03-01T08:00:00')
    const service = makeService(dir, log, { now: () => clock })

    await service.tick()
    expect(log.urls.filter((url) => url.includes(CHECKIN_PATH))).toHaveLength(0)

    // The activity opens later that morning; an hour passes.
    active = true
    clock += CHECKIN_INACTIVE_RECHECK_MS + 1
    await service.tick()
    expect(log.urls.filter((url) => url.includes(CHECKIN_PATH))).toHaveLength(1)
    expect((await service.summary()).doneToday).toBe(1)
  })

  it('throttles the re-check instead of polling every ten minutes', async () => {
    const dir = await makeDir()
    const log = makeFetch((url) => jsonResponse({
      code: 0,
      data: url.includes(CHECKIN_STATUS_PATH)
        ? { active: false, today_checked_in: false }
        : { total_credits: 1 },
    }))
    let clock = Date.parse('2026-03-01T08:00:00')
    const service = makeService(dir, log, { now: () => clock })

    await service.tick()
    const afterFirst = log.urls.length
    // Several ten-minute ticks before the hourly re-check is due.
    for (let round = 0; round < 5; round += 1) {
      clock += 10 * 60 * 1000
      await service.tick()
    }
    expect(log.urls.length).toBe(afterFirst)
  })

  it('lets a manual pass override the throttle', async () => {
    const dir = await makeDir()
    const log = makeFetch((url) => jsonResponse({
      code: 0,
      data: url.includes(CHECKIN_STATUS_PATH)
        ? { active: false, today_checked_in: false }
        : { total_credits: 1 },
    }))
    const clock = Date.parse('2026-03-01T08:00:00')
    const service = makeService(dir, log, { now: () => clock })
    await service.tick()
    const afterFirst = log.urls.length
    await service.tick(true)
    expect(log.urls.length).toBeGreaterThan(afterFirst)
  })

  it('does not report a non-sign-in as a sign-in in the summary', async () => {
    const dir = await makeDir()
    const log = makeFetch((url) => jsonResponse({
      code: 0,
      data: url.includes(CHECKIN_STATUS_PATH)
        ? { active: false, today_checked_in: false }
        : { total_credits: 1 },
    }))
    const service = makeService(dir, log)
    await service.tick()
    const summary = await service.summary()
    expect(summary.doneToday).toBe(0)
    expect(summary.skippedToday).toBe(1)
    expect(summary.failedToday).toBe(0)
  })

  it('stops counting the skip once the account does sign in', async () => {
    const dir = await makeDir()
    let active = false
    const log = makeFetch((url) => {
      if (url.includes(CHECKIN_STATUS_PATH)) {
        return jsonResponse({ code: 0, data: { active, today_checked_in: false } })
      }
      return jsonResponse({ code: 0, data: { total_credits: 2 } })
    })
    let clock = Date.parse('2026-03-01T08:00:00')
    const service = makeService(dir, log, { now: () => clock })
    await service.tick()
    expect((await service.summary()).skippedToday).toBe(1)

    active = true
    clock += CHECKIN_INACTIVE_RECHECK_MS + 1
    await service.tick()
    const summary = await service.summary()
    expect(summary.doneToday).toBe(1)
    expect(summary.skippedToday).toBe(0)
  })
})

describe('check-in runs a manual pass that arrives mid-flight', () => {
  it('does not absorb the click into the automatic pass', async () => {
    const dir = await makeDir()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const log = makeFetch(async (url) => {
      await gate
      // The automatic pass fails, so the account still has retry budget left.
      return url.includes(CHECKIN_STATUS_PATH)
        ? jsonResponse({ code: 0, data: { active: true, today_checked_in: false } })
        : jsonResponse({ code: 99, msg: 'transient' })
    })
    const service = makeService(dir, log)

    const automatic = service.tick()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const manual = service.tick(true)
    release()
    await Promise.all([automatic, manual])

    // One failure from the automatic pass plus one from the queued manual pass.
    expect(log.urls.filter((url) => url.includes(CHECKIN_PATH))).toHaveLength(2)
  })

  it('keeps automatic ticks from stacking up behind a running pass', async () => {
    const dir = await makeDir()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const log = makeFetch(async (url) => {
      await gate
      return happyPath(url)
    })
    const service = makeService(dir, log)
    const first = service.tick()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = service.tick()
    const third = service.tick()
    release()
    await Promise.all([first, second, third])
    // A single pass: one status plus one check-in, not three of each.
    expect(log.urls).toHaveLength(2)
  })
})

describe('check-in tolerates upstream spelling and soft failures', () => {
  it('reads a camelCase status payload as signed in', async () => {
    const dir = await makeDir()
    const log = makeFetch((url) => jsonResponse({
      code: 0,
      data: url.includes(CHECKIN_STATUS_PATH)
        ? { active: true, todayCheckedIn: true, streakDays: 3, totalCredits: 42 }
        : { total_credits: 1 },
    }))
    const service = makeService(dir, log)
    await service.tick()
    expect(log.urls.filter((url) => url.includes(CHECKIN_PATH))).toHaveLength(0)
    expect((await service.summary()).doneToday).toBe(1)
  })

  it('reads an inactive activity spelled as Active: false', async () => {
    const dir = await makeDir()
    const log = makeFetch((url) => jsonResponse({
      code: 0,
      data: url.includes(CHECKIN_STATUS_PATH)
        ? { Active: false, todayCheckedIn: false }
        : { total_credits: 1 },
    }))
    const service = makeService(dir, log)
    await service.tick()
    expect((await service.summary()).skippedToday).toBe(1)
  })

  it('treats an "already signed in" reject as success, not as a failed attempt', async () => {
    const dir = await makeDir()
    const log = makeFetch((url) => {
      if (url.includes(CHECKIN_STATUS_PATH)) {
        return jsonResponse({ code: 0, data: { active: true, today_checked_in: false } })
      }
      return jsonResponse({ code: 13001, msg: '今日已签到' })
    })
    const service = makeService(dir, log)
    await service.tick()
    const summary = await service.summary()
    expect(summary.doneToday).toBe(1)
    expect(summary.failedToday).toBe(0)

    // And no retry is spent: the day is settled.
    const afterFirst = log.urls.length
    await service.tick()
    expect(log.urls.length).toBe(afterFirst)
  })

  it('refreshes once after a 401 instead of burning an attempt', async () => {
    const dir = await makeDir()
    let statusCalls = 0
    const log = makeFetch((url) => {
      if (url.includes('/v2/plugin/auth/token/refresh')) {
        return jsonResponse({ code: 0, data: { accessToken: 'fresh', refreshToken: 'r2', expiresIn: 3600 } })
      }
      if (url.includes(CHECKIN_STATUS_PATH)) {
        statusCalls += 1
        if (statusCalls === 1) return jsonResponse({ code: 401, msg: 'expired' }, 401)
        return jsonResponse({ code: 0, data: { active: true, today_checked_in: true, total_credits: 7 } })
      }
      return jsonResponse({ code: 0, data: { total_credits: 1 } })
    })
    const service = makeService(dir, log)
    await service.tick()
    expect(log.urls.some((url) => url.includes('/v2/plugin/auth/token/refresh'))).toBe(true)
    expect((await service.summary()).doneToday).toBe(1)
    expect((await service.summary()).failedToday).toBe(0)
  })
})

describe('check-in state survives a restart', () => {
  it('remembers the last run time instead of reporting "never"', async () => {
    const dir = await makeDir()
    const log = makeFetch(happyPath)
    const clock = Date.parse('2026-03-01T09:30:00')
    const first = makeService(dir, log, { now: () => clock })
    await first.tick()
    const firstRun = (await first.summary()).lastRunAt
    expect(firstRun).toBe(clock)

    const restarted = makeService(dir, log, { now: () => clock })
    expect((await restarted.summary()).lastRunAt).toBe(clock)
  })

  it('does not re-sign an account already done today', async () => {
    const dir = await makeDir()
    const log = makeFetch(happyPath)
    const clock = Date.parse('2026-03-01T09:30:00')
    await makeService(dir, log, { now: () => clock }).tick()
    const afterFirst = log.urls.length
    await makeService(dir, log, { now: () => clock }).tick()
    expect(log.urls.length).toBe(afterFirst)
  })

  it('resets the previous day state so the new day signs in again', async () => {
    const dir = await makeDir()
    const log = makeFetch(happyPath)
    let clock = Date.parse('2026-03-01T09:30:00')
    const service = makeService(dir, log, { now: () => clock })
    await service.tick()
    const afterFirst = log.urls.length

    clock = Date.parse('2026-03-02T09:30:00')
    const nextDay = makeService(dir, log, { now: () => clock })
    await nextDay.tick()
    expect(log.urls.length).toBeGreaterThan(afterFirst)
    expect((await nextDay.summary()).doneToday).toBe(1)
  })

  it('reads a state document written by the previous version', async () => {
    const dir = await makeDir()
    // Version 1 had no lastRunAt and no inactive bookkeeping.
    await fs.writeFile(path.join(dir, 'checkin-state.json'), JSON.stringify({
      version: 1,
      accounts: {
        'cn:uid-0': { date: localToday(), done: true, attempts: 0, totalCredits: 12 },
      },
    }), 'utf8')
    const log = makeFetch(happyPath)
    const service = makeService(dir, log)
    const summary = await service.summary()
    expect(summary.doneToday).toBe(1)
    expect(summary.lastRunAt).toBeNull()
    // Already done today, so the tick must not sign in again.
    await service.tick()
    expect(log.urls).toHaveLength(0)
  })
})

function localToday(): string {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}
