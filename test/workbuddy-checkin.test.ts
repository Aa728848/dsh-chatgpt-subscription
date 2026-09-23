import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  CHECKIN_ATTEMPT_CAP,
  CHECKIN_PATH,
  CHECKIN_STATUS_PATH,
  WorkBuddyCheckinService,
} from '../src/host/workbuddy/checkin.ts'
import type { WorkBuddyCheckinSettings } from '../src/shared/workbuddy-contracts.ts'
import { FileModelSettingsStore, registerWorkBuddyPreferenceStore } from '../src/host/workbuddy/token-store.ts'
import { registerWorkBuddyRoutes } from '../src/host/workbuddy/routes.ts'
import { createWorkBuddyStore } from './support/workbuddy-fixtures.ts'

const temporaryDirs: string[] = []

const SETTINGS: WorkBuddyCheckinSettings = { enabled: true }

async function makeAuthDir(options: { domain?: string; expiresAt?: number; fileName?: string; uid?: string } = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-checkin-'))
  temporaryDirs.push(dir)
  await fs.writeFile(path.join(dir, options.fileName ?? 'workbuddy-desktop.info'), JSON.stringify({
    account: { uid: options.uid ?? 'uid-1', nickname: 'tester', uin: '100000000001', type: 'personal' },
    auth: {
      accessToken: 'token-abc',
      refreshToken: 'refresh-abc',
      expiresAt: options.expiresAt ?? Date.now() + 3_600_000,
      domain: options.domain ?? 'copilot.tencent.com',
    },
  }), 'utf8')
  return dir
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 })
}

interface FetchLog {
  urls: string[]
  fetchFn: typeof fetch
}

/** A fetch double that answers the check-in surfaces and records call order. */
function makeFetch(behavior: {
  status?: unknown
  checkin?: unknown
  refresh?: unknown
}): FetchLog {
  const urls: string[] = []
  const fetchFn = (async (url: any) => {
    const target = String(url)
    urls.push(target)
    if (target.includes(CHECKIN_STATUS_PATH)) {
      return jsonResponse(behavior.status ?? { code: 0, data: { active: true, today_checked_in: false, streak_days: 2, daily_credit: 10 } })
    }
    if (target.includes(CHECKIN_PATH)) {
      return jsonResponse(behavior.checkin ?? { code: 0, data: { total_credits: 120 } })
    }
    if (target.includes('/v2/plugin/auth/token/refresh')) {
      return jsonResponse(behavior.refresh ?? { code: 0, data: { accessToken: 'token-new', refreshToken: 'refresh-new', expiresIn: 3600 } })
    }
    throw new Error(`unexpected fetch: ${target}`)
  }) as unknown as typeof fetch
  return { urls, fetchFn }
}

function makeService(dir: string, options: {
  fetch: FetchLog
  settings?: () => WorkBuddyCheckinSettings
}): WorkBuddyCheckinService {
  const store = createWorkBuddyStore(dir)
  return new WorkBuddyCheckinService(store, {
    fetchFn: options.fetch.fetchFn,
    settings: options.settings ?? (() => ({ ...SETTINGS })),
    statePath: path.join(dir, 'checkin-state.json'),
  })
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const dir of temporaryDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

describe('WorkBuddy check-in service', () => {
  it('signs a CN account in on the first tick and stays idle afterwards', async () => {
    const dir = await makeAuthDir()
    const fetchLog = makeFetch({})
    const service = makeService(dir, { fetch: fetchLog })

    await service.tick()
    expect(fetchLog.urls.filter((url) => url.includes(CHECKIN_PATH))).toHaveLength(1)

    const callsAfterFirst = fetchLog.urls.length
    await service.tick()
    expect(fetchLog.urls.length).toBe(callsAfterFirst)

    const summary = await service.summary()
    expect(summary).toMatchObject({ totalAccounts: 1, doneToday: 1, failedToday: 0, enabled: true })

    // The state file makes a same-day restart free: a fresh service over the
    // same directory must not sign in again.
    const second = makeService(dir, { fetch: fetchLog })
    await second.tick()
    expect(fetchLog.urls.length).toBe(callsAfterFirst)
  })

  it('does nothing while the toggle is off, but a manual run still signs in', async () => {
    const dir = await makeAuthDir()
    const fetchLog = makeFetch({})
    const service = makeService(dir, { fetch: fetchLog, settings: () => ({ enabled: false }) })

    await service.tick()
    expect(fetchLog.urls).toHaveLength(0)

    await service.tick(true)
    expect(fetchLog.urls.filter((url) => url.includes(CHECKIN_PATH))).toHaveLength(1)
  })

  it('skips international accounts outright', async () => {
    const dir = await makeAuthDir({ domain: 'www.workbuddy.ai' })
    const fetchLog = makeFetch({})
    const service = makeService(dir, { fetch: fetchLog })
    await service.tick()
    expect(fetchLog.urls).toHaveLength(0)
    const summary = await service.summary()
    expect(summary.totalAccounts).toBe(0)
  })

  it('records an already-signed account without posting a check-in', async () => {
    const dir = await makeAuthDir()
    const fetchLog = makeFetch({ status: { code: 0, data: { active: true, today_checked_in: true, streak_days: 5, total_credits: 88 } } })
    const service = makeService(dir, { fetch: fetchLog })
    await service.tick()
    expect(fetchLog.urls.filter((url) => url.includes(CHECKIN_STATUS_PATH))).toHaveLength(1)
    expect(fetchLog.urls.filter((url) => url.includes(CHECKIN_PATH))).toHaveLength(0)
    const summary = await service.summary()
    expect(summary.doneToday).toBe(1)
  })

  it('marks an account with no active activity done without retrying', async () => {
    const dir = await makeAuthDir()
    const fetchLog = makeFetch({ status: { code: 0, data: { active: false, today_checked_in: false } } })
    const service = makeService(dir, { fetch: fetchLog })
    await service.tick()
    await service.tick()
    expect(fetchLog.urls.filter((url) => url.includes(CHECKIN_PATH))).toHaveLength(0)
    expect(fetchLog.urls.filter((url) => url.includes(CHECKIN_STATUS_PATH))).toHaveLength(1)
  })

  it('caps a failing account at three attempts a day, and a manual run may retry', async () => {
    const dir = await makeAuthDir()
    const fetchLog = makeFetch({ checkin: { code: 12345, msg: 'denied' } })
    const service = makeService(dir, { fetch: fetchLog })

    for (let round = 0; round < 5; round += 1) await service.tick()
    expect(fetchLog.urls.filter((url) => url.includes(CHECKIN_PATH))).toHaveLength(CHECKIN_ATTEMPT_CAP)
    const summary = await service.summary()
    expect(summary.failedToday).toBe(1)
    expect(summary.doneToday).toBe(0)

    // Manual re-sign ignores the cap, like the reference script's --now.
    await service.tick(true)
    expect(fetchLog.urls.filter((url) => url.includes(CHECKIN_PATH))).toHaveLength(CHECKIN_ATTEMPT_CAP + 1)
  })

  it('refreshes an expired token through the store before checking in', async () => {
    const dir = await makeAuthDir({ expiresAt: Date.now() - 60_000 })
    const fetchLog = makeFetch({})
    const service = makeService(dir, { fetch: fetchLog })
    await service.tick()

    const refreshIndex = fetchLog.urls.findIndex((url) => url.includes('/v2/plugin/auth/token/refresh'))
    const statusIndex = fetchLog.urls.findIndex((url) => url.includes(CHECKIN_STATUS_PATH))
    expect(refreshIndex).toBeGreaterThanOrEqual(0)
    expect(statusIndex).toBeGreaterThan(refreshIndex)

    // The desktop file got the rotated token, so the IDE does not lose its session.
    const written = JSON.parse(await fs.readFile(path.join(dir, 'workbuddy-desktop.info'), 'utf8'))
    expect(written.auth.accessToken).toBe('token-new')
  })

  it('signs every CN account, including a hidden-adjacent desktop one', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-checkin-'))
    temporaryDirs.push(dir)
    for (const [fileName, uid] of [['workbuddy-desktop.info', 'uid-1'], ['codebuddy-desktop.info', 'uid-2']] as const) {
      await fs.writeFile(path.join(dir, fileName), JSON.stringify({
        account: { uid, nickname: uid, type: 'personal' },
        auth: { accessToken: `token-${uid}`, refreshToken: 'r', expiresAt: Date.now() + 3_600_000, domain: 'copilot.tencent.com' },
      }), 'utf8')
    }
    const fetchLog = makeFetch({})
    const service = makeService(dir, { fetch: fetchLog })
    await service.tick()
    expect(fetchLog.urls.filter((url) => url.includes(CHECKIN_PATH))).toHaveLength(2)
    const summary = await service.summary()
    expect(summary).toMatchObject({ totalAccounts: 2, doneToday: 2 })
  })
})

/** Minimal route-handler doubles, matching the sibling route tests. */
function makeRequest(method: string, url: string, body?: unknown, origin?: string) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers: {
      host: '127.0.0.1:43120',
      ...(origin === undefined ? {} : { origin }),
      'content-type': 'application/json',
    },
    on(event: string, handler: any) {
      if (event === 'data') for (const chunk of chunks) handler(chunk)
      if (event === 'end') handler()
      return this
    },
    destroy() {},
  } as any
}

function makeResponse() {
  const captured = { status: 0, body: '' }
  return {
    captured,
    writeHead(status: number) { captured.status = status; return this },
    end(body: string) { captured.body = body },
  } as any
}

function makeContext(handlers: any[]): any {
  return {
    webServer: {
      register(route: any) {
        handlers.push(route)
        return () => undefined
      },
    },
  }
}

async function makeSettings(): Promise<FileModelSettingsStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-checkin-set-'))
  temporaryDirs.push(dir)
  return new FileModelSettingsStore(path.join(dir, 'models.json'))
}

describe('WorkBuddy check-in routes', () => {
  const SUMMARY = {
    enabled: true,
    totalAccounts: 2,
    doneToday: 1,
    failedToday: 0,
    lastRunAt: 1700000000000,
  }

  it('serves the check-in summary inside the status payload', async () => {
    const dir = await makeAuthDir()
    const handlers: any[] = []
    const fetchFn = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    registerWorkBuddyRoutes(makeContext(handlers), createWorkBuddyStore(dir), await makeSettings(), undefined, {
      fetchFn,
      checkin: { tick: vi.fn(async () => undefined), summary: async () => ({ ...SUMMARY }) },
    })
    const res = makeResponse()
    await handlers[0]!.handler(makeRequest('GET', '/workbuddy/api/status'), res)
    expect(res.captured.status).toBe(200)
    const payload = JSON.parse(res.captured.body)
    expect(payload.value.checkin).toMatchObject({ totalAccounts: 2, doneToday: 1 })
  })

  it('reports no check-in row when the host predates the scheduler', async () => {
    const dir = await makeAuthDir()
    const handlers: any[] = []
    const fetchFn = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    registerWorkBuddyRoutes(makeContext(handlers), createWorkBuddyStore(dir), await makeSettings(), undefined, { fetchFn })
    const res = makeResponse()
    await handlers[0]!.handler(makeRequest('GET', '/workbuddy/api/status'), res)
    expect(JSON.parse(res.captured.body).value.checkin).toBeNull()
  })

  it('runs a manual check-in only for a same-origin POST', async () => {
    const dir = await makeAuthDir()
    const handlers: any[] = []
    const fetchFn = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    const tick = vi.fn(async () => undefined)
    registerWorkBuddyRoutes(makeContext(handlers), createWorkBuddyStore(dir), await makeSettings(), undefined, {
      fetchFn,
      checkin: { tick, summary: async () => ({ ...SUMMARY }) },
    })

    const denied = makeResponse()
    await handlers[0]!.handler(makeRequest('POST', '/workbuddy/api/checkin/now', {}, 'https://evil.example'), denied)
    expect(denied.captured.status).toBe(403)
    expect(tick).not.toHaveBeenCalled()

    const wrongMethod = makeResponse()
    await handlers[0]!.handler(makeRequest('GET', '/workbuddy/api/checkin/now'), wrongMethod)
    expect(wrongMethod.captured.status).toBe(405)

    const allowed = makeResponse()
    await handlers[0]!.handler(makeRequest('POST', '/workbuddy/api/checkin/now', {}, 'http://127.0.0.1:43120'), allowed)
    expect(allowed.captured.status).toBe(200)
    expect(tick).toHaveBeenCalledWith(true)
    expect(JSON.parse(allowed.captured.body).value.checkin).toMatchObject({ totalAccounts: 2 })
  })

  it('persists the check-in toggle through the settings route', async () => {
    const dir = await makeAuthDir()
    const handlers: any[] = []
    const fetchFn = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    const settings = await makeSettings()
    registerWorkBuddyRoutes(makeContext(handlers), createWorkBuddyStore(dir), settings, undefined, {
      fetchFn,
      checkin: { tick: vi.fn(async () => undefined), summary: async () => ({ ...SUMMARY }) },
    })

    const res = makeResponse()
    await handlers[0]!.handler(makeRequest('POST', '/workbuddy/api/settings', {
      checkin: { enabled: false },
    }, 'http://127.0.0.1:43120'), res)
    expect(res.captured.status).toBe(200)

    const stored = await settings.read()
    expect(stored.checkin).toEqual({ enabled: false })
  })

  it('tolerates a settings document written while a window was configurable', async () => {
    const settings = await makeSettings()
    // A pre-simplification document carries startHour/endHour; reading it must
    // neither fail nor resurrect the window.
    await fs.writeFile(settings.path(), JSON.stringify({
      enabled: true,
      checkin: { enabled: false, startHour: 8, endHour: 12 },
    }), 'utf8')
    const stored = await settings.read()
    expect(stored.checkin).toEqual({ enabled: false })
  })

  it('exposes check-in defaults through the preference store without a settings service', async () => {
    const settings = await makeSettings()
    const preferences = registerWorkBuddyPreferenceStore(undefined, settings)
    expect(preferences.status().checkin).toEqual({ enabled: true })
    await preferences.update({ checkin: { enabled: false } })
    expect(preferences.status().checkin).toEqual({ enabled: false })
  })
})
