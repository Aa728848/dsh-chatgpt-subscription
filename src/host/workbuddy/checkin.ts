/**
 * Daily check-in scheduler for the CN-region billing activity.
 *
 * Ported from workbuddy2api's `daily_checkin.py` and adapted to this host:
 * the cron job becomes an in-process timer (the plugin runs inside the DSH
 * host, so a day the host never runs is a day nothing signs in — accepted and
 * documented), and the per-file state JSON becomes one state document under
 * the harness home. The semantics are kept exactly:
 *
 * - **CN only.** The international deployment exposes no check-in surface, so
 *   those accounts are skipped rather than failing daily.
 * - **Idempotent.** The activity status is queried first; an account already
 *   signed in (by anyone) is only recorded, and an account whose activity is
 *   inactive is not retried for the rest of the day. Once everyone is done,
 *   a tick sends no requests at all.
 * - **Bounded.** A failing account is retried at most {@link CHECKIN_ATTEMPT_CAP}
 *   times a day, so a broken account cannot turn the ten-minute tick into a
 *   request loop. A manual run ignores the cap and the window, like the
 *   reference script's `--now`.
 *
 * Tokens stay host-side: the only write beyond the state file is the existing
 * credential store's refresh write-back, reused here unchanged.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { dshHomeDir } from '../common/home.ts'
import { refreshCredentials, workBuddyHeaders } from './client.ts'
import { isIntlDomain } from './types.ts'
import {
  workBuddyAccountId,
  type FileCredentialStore,
  type WorkBuddyCredentials,
} from './token-store.ts'
import type {
  WorkBuddyCheckinSettings,
  WorkBuddyCheckinSummary,
} from '../../shared/workbuddy-contracts.ts'

/** Activity status surface; answers whether today is signed in already. */
export const CHECKIN_STATUS_PATH = '/billing/meter/checkin-activity-status'
/** Check-in surface; credits are granted by posting here once a day. */
export const CHECKIN_PATH = '/billing/meter/daily-checkin'
/**
 * Scheduler cadence. The first tick at host startup is the daily run; the
 * interval keeps a long-lived process signing in on later days without a
 * restart. Idle ticks cost no requests — the day state short-circuits them.
 */
export const CHECKIN_TICK_MS = 10 * 60 * 1000
/** Daily retry ceiling for one account after a failed attempt. */
export const CHECKIN_ATTEMPT_CAP = 3
export const CHECKIN_TIMEOUT_MS = 20_000

/** State document the scheduler keeps beside the other plugin stores. */
export function checkinStatePath(): string {
  return path.join(dshHomeDir(), 'storages', 'workbuddy-checkin.json')
}

/** Local calendar day an instant belongs to; state entries are keyed by it. */
export function localDateString(nowMs: number): string {
  const date = new Date(nowMs)
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** One account's check-in bookkeeping for one local day. */
interface CheckinAccountState {
  /** Local date this entry describes; an older entry is yesterday's news. */
  date: string
  /** Signed in or activity inactive: either way, no more tries today. */
  done: boolean
  /** Failed attempts today, capped at {@link CHECKIN_ATTEMPT_CAP} for automatic runs. */
  attempts: number
  lastError?: string
  streakDays?: number
  totalCredits?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Read one stored entry, keeping only the fields with the right shape. */
function parseStateEntry(value: unknown): CheckinAccountState | null {
  if (!isRecord(value) || typeof value.date !== 'string') return null
  const entry: CheckinAccountState = {
    date: value.date,
    done: value.done === true,
    attempts: typeof value.attempts === 'number' && Number.isFinite(value.attempts) ? value.attempts : 0,
  }
  if (typeof value.lastError === 'string') entry.lastError = value.lastError
  const streakDays = asCount(value.streakDays)
  if (streakDays !== undefined) entry.streakDays = streakDays
  const totalCredits = asCount(value.totalCredits)
  if (totalCredits !== undefined) entry.totalCredits = totalCredits
  return entry
}

export interface WorkBuddyCheckinServiceOptions {
  fetchFn?: typeof fetch
  /** State document path; tests redirect it, production uses {@link checkinStatePath}. */
  statePath?: string
  /** Live preferences, re-read on every tick so the toggle applies at once. */
  settings: () => WorkBuddyCheckinSettings
  /** Clock injection for tests. */
  now?: () => number
  logger?: {
    info(message: string): void
    warn(message: string): void
  }
}

/**
 * The check-in scheduler. One instance per plugin load; the host owns the
 * interval and clears it from the same `ctx.effect` that created it.
 */
export class WorkBuddyCheckinService {
  private readonly fetchFn: typeof fetch
  private readonly statePath: string
  private readonly now: () => number
  private readonly logger: WorkBuddyCheckinServiceOptions['logger']
  private state: Record<string, CheckinAccountState> = {}
  private loaded = false
  /** In-flight run; a tick while one runs joins it instead of doubling requests. */
  private running: Promise<void> | null = null
  private lastRunAt: number | null = null

  constructor(
    private readonly store: FileCredentialStore,
    private readonly options: WorkBuddyCheckinServiceOptions,
  ) {
    this.fetchFn = options.fetchFn ?? fetch
    this.statePath = options.statePath ?? checkinStatePath()
    this.now = options.now ?? (() => Date.now())
    this.logger = options.logger
  }

  /**
   * One scheduler pass. Automatic passes honour the toggle and the retry cap;
   * a manual pass (`manual: true`, the card's "check in now") ignores both
   * but still respects an account already signed in today.
   */
  async tick(manual = false): Promise<void> {
    if (this.running !== null) return this.running
    const run = this.run(manual)
    this.running = run
    try {
      await run
    } finally {
      if (this.running === run) this.running = null
    }
  }

  private async run(manual: boolean): Promise<void> {
    const settings = this.options.settings()
    if (!manual && !settings.enabled) return
    await this.load()
    const nowMs = this.now()
    const today = localDateString(nowMs)
    let accounts: WorkBuddyCredentials[]
    try {
      accounts = await this.store.list()
    } catch (error) {
      this.logger?.warn(`[workbuddy-checkin] account scan failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    let dirty = false
    for (const credentials of accounts) {
      // The international deployment has no check-in activity; polling it
      // would only produce a daily 401 per account.
      if (isIntlDomain(credentials.domain)) continue
      const id = workBuddyAccountId(credentials)
      const existing = this.state[id]
      if (existing?.date === today && existing.done) continue
      if (!manual && existing?.date === today && existing.attempts >= CHECKIN_ATTEMPT_CAP) continue
      dirty = true
      await this.checkinOne(id, credentials, today)
    }
    this.lastRunAt = nowMs
    if (dirty) await this.save()
  }

  /** Check one account in, recording the outcome in its today's entry. */
  private async checkinOne(id: string, credentials: WorkBuddyCredentials, today: string): Promise<void> {
    const existing = this.state[id]
    const entry: CheckinAccountState = existing?.date === today
      ? existing
      : { date: today, done: false, attempts: 0 }
    this.state[id] = entry
    try {
      // ensureFresh serializes refreshes per account and writes the rotated
      // token back wherever the credential lives; the check-in never handles
      // the refresh itself.
      const fresh = await this.store.ensureFresh(credentials, (current) =>
        refreshCredentials(current, { fetchFn: this.fetchFn }))
      const headers = workBuddyHeaders(fresh)
      const status = await this.post(`${fresh.backend}${CHECKIN_STATUS_PATH}`, headers)
      const statusData = isRecord(status?.data) ? status.data : {}
      if (statusData.today_checked_in === true) {
        entry.done = true
        const streakDays = asCount(statusData.streak_days)
        if (streakDays !== undefined) entry.streakDays = streakDays
        const totalCredits = asCount(statusData.total_credits)
        if (totalCredits !== undefined) entry.totalCredits = totalCredits
        delete entry.lastError
        this.logger?.info(`[workbuddy-checkin] ${id} already signed in today`)
        return
      }
      if (statusData.active === false) {
        // No entitlement today: mark done so the tick does not re-poll every
        // ten minutes, exactly like the reference script.
        entry.done = true
        this.logger?.info(`[workbuddy-checkin] ${id} has no active check-in activity; skipping until tomorrow`)
        return
      }
      const result = await this.post(`${fresh.backend}${CHECKIN_PATH}`, headers)
      if (result?.code === 0) {
        entry.done = true
        const totalCredits = asCount(isRecord(result.data) ? result.data.total_credits : undefined)
        if (totalCredits !== undefined) entry.totalCredits = totalCredits
        delete entry.lastError
        this.logger?.info(`[workbuddy-checkin] ${id} signed in; total credits ${entry.totalCredits ?? '?'}`)
      } else {
        entry.attempts += 1
        entry.lastError = `code ${String(result?.code ?? 'no-response')}: ${String(result?.msg ?? 'check-in rejected')}`
        this.logger?.warn(`[workbuddy-checkin] ${id} attempt ${entry.attempts}/${CHECKIN_ATTEMPT_CAP} failed: ${entry.lastError}`)
      }
    } catch (error) {
      entry.attempts += 1
      entry.lastError = error instanceof Error ? error.message : String(error)
      this.logger?.warn(`[workbuddy-checkin] ${id} attempt ${entry.attempts}/${CHECKIN_ATTEMPT_CAP} failed: ${entry.lastError}`)
    }
  }

  /**
   * The aggregate the settings card renders. Reads only local state and the
   * account list; it never spends a network request.
   */
  async summary(): Promise<WorkBuddyCheckinSummary> {
    await this.load()
    const settings = this.options.settings()
    const accounts = (await this.store.list().catch(() => [] as WorkBuddyCredentials[]))
      .filter((credentials) => !isIntlDomain(credentials.domain))
    const today = localDateString(this.now())
    let doneToday = 0
    let failedToday = 0
    for (const credentials of accounts) {
      const entry = this.state[workBuddyAccountId(credentials)]
      if (entry?.date !== today) continue
      if (entry.done) doneToday += 1
      else if (entry.attempts >= CHECKIN_ATTEMPT_CAP) failedToday += 1
    }
    return {
      enabled: settings.enabled,
      totalAccounts: accounts.length,
      doneToday,
      failedToday,
      lastRunAt: this.lastRunAt,
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await fs.readFile(this.statePath, 'utf8')) as unknown
      if (isRecord(parsed) && isRecord(parsed.accounts)) {
        for (const [id, value] of Object.entries(parsed.accounts)) {
          const entry = parseStateEntry(value)
          if (entry !== null) this.state[id] = entry
        }
      }
    } catch {
      // A missing or unreadable state file starts empty; the server's own
      // idempotency (today_checked_in) keeps a re-run from double-signing.
    }
  }

  private async save(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.statePath), { recursive: true })
      const tmp = `${this.statePath}.tmp.${process.pid}`
      await fs.writeFile(tmp, JSON.stringify({ version: 1, accounts: this.state }, null, 2), 'utf8')
      await fs.rename(tmp, this.statePath)
    } catch {
      // The state file is a dedup optimization; a failed write must not fail
      // the check-in that already happened.
    }
  }

  private async post(url: string, headers: Record<string, string>): Promise<Record<string, unknown> | null> {
    const response = await this.fetchFn(url, {
      method: 'POST',
      headers,
      body: '{}',
      signal: AbortSignal.timeout(CHECKIN_TIMEOUT_MS),
    })
    const text = await response.text().catch(() => '')
    try {
      const parsed = JSON.parse(text) as unknown
      return isRecord(parsed) ? parsed : null
    } catch {
      return null
    }
  }
}
