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
 *   signed in (by anyone) is only recorded. An account whose activity reports
 *   no entitlement is parked (see {@link CHECKIN_INACTIVE_RECHECK_MS}) rather
 *   than abandoned for the day: the host often starts before the activity's
 *   daily opening, and treating that first answer as final cost the account its
 *   only chance to sign in. Once everyone is settled, a tick sends no requests.
 * - **Bounded.** A failing account is retried at most {@link CHECKIN_ATTEMPT_CAP}
 *   times a day, so a broken account cannot turn the ten-minute tick into a
 *   request loop. A manual run ignores the cap and the window, like the
 *   reference script's `--now`, and is queued behind an in-flight run rather
 *   than dropped into it (a click must actually mean "try again now").
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
/**
 * How long an unentitled account waits before the activity is polled again.
 *
 * The activity opens on its own schedule, so the first inactive answer of the
 * day is frequently 'not open yet' rather than 'no entitlement today'. Hourly
 * re-checks keep a host that booted early from missing the day, while still
 * costing at most one status request per hour per account.
 */
export const CHECKIN_INACTIVE_RECHECK_MS = 60 * 60 * 1000

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
  /**
   * Confirmed signed in today, so nothing more to do until tomorrow.
   *
   * Deliberately distinct from 'the activity answered inactive': that is a
   * transient condition the scheduler re-checks, and conflating the two made
   * the card report a sign-in that never happened.
   */
  done: boolean
  /** Failed attempts today, capped at {@link CHECKIN_ATTEMPT_CAP} for automatic runs. */
  attempts: number
  /**
   * The activity reported no entitlement. Not terminal: re-checked after
   * {@link CHECKIN_INACTIVE_RECHECK_MS} in case it has opened since.
   */
  inactive?: boolean
  /** Unix ms the inactive answer was recorded; throttles the re-check. */
  inactiveAt?: number
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

/**
 * Read a boolean the upstream may spell in either case, or as 0/1.
 *
 * The reference implementation normalizes both spellings (`billing.go` serves
 * snake_case, other builds camelCase) and coerces the numeric form; matching
 * only `=== true` on one spelling would silently read a signed-in account as
 * unsigned and post a redundant check-in every tick.
 */
function readBool(data: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = data[key]
    if (typeof value === 'boolean') return value
    if (value === 1 || value === '1' || value === 'true') return true
    if (value === 0 || value === '0' || value === 'false') return false
  }
  return undefined
}

/** Read a count the upstream may spell in either case, or as a numeric string. */
function readCount(data: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = data[key]
    const direct = asCount(value)
    if (direct !== undefined) return direct
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

/**
 * Whether the reject is the upstream's own "already signed in" answer.
 *
 * The service sometimes rejects a duplicate check-in with a business code and
 * a message instead of reporting it in the status call. Treating that as a
 * failure spent the day's retry budget proving something that had succeeded.
 */
function isAlreadySignedInMessage(result: Record<string, unknown> | null): boolean {
  if (result === null) return false
  const message = typeof result.msg === 'string' ? result.msg : (typeof result.message === 'string' ? result.message : '')
  const lower = message.toLowerCase()
  return lower.includes('already') || message.includes('已签') || message.includes('今日')
}

/** Whether a response is an auth rejection that a forced refresh may fix. */
function isUnauthorized(result: Record<string, unknown> | null): boolean {
  if (result === null) return false
  return result.code === 401
}

/** Read one stored entry, keeping only the fields with the right shape. */
function parseStateEntry(value: unknown): CheckinAccountState | null {
  if (!isRecord(value) || typeof value.date !== 'string') return null
  const entry: CheckinAccountState = {
    date: value.date,
    done: value.done === true,
    attempts: typeof value.attempts === 'number' && Number.isFinite(value.attempts) ? value.attempts : 0,
  }
  if (value.inactive === true) entry.inactive = true
  const inactiveAt = asCount(value.inactiveAt)
  if (inactiveAt !== undefined) entry.inactiveAt = inactiveAt
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
  /**
   * Resolves once the preference store has read its stored document.
   *
   * Optional for callers whose settings are already in memory; the host passes
   * the preference store's own warmup so the startup pass cannot act on a
   * default that the stored document is about to overwrite.
   */
  ready?: () => Promise<void>
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
  /** Passes waiting to run, in order; `true` marks a manual pass. */
  private readonly queue: boolean[] = []
  /** The drain loop currently working the queue, if any. */
  private draining: Promise<void> | null = null

  private lastRunAt: number | null = null
  /** Memoized preference warmup, so it is awaited once however many passes run. */
  private readyWait: Promise<void> | null = null

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
   *
   * A manual pass that lands while a run is already in flight is *queued*, not
   * absorbed: joining the running pass would silently discard the one thing the
   * button promises, that the retry cap and the toggle are bypassed now.
   */
  async tick(manual = false): Promise<void> {
    // An automatic tick is already-running-or-pending work: another would only
    // re-scan a day the first one settles, so it joins instead of queueing.
    // Manual passes always get a run of their own.
    if (!manual && (this.queue.length > 0 || this.draining !== null)) {
      return this.draining ?? Promise.resolve()
    }
    this.queue.push(manual)
    return this.drain()
  }

  /** Run queued passes one after another until the queue empties. */
  private drain(): Promise<void> {
    if (this.draining !== null) return this.draining
    // Only start a loop when there is something to do, so the assignment
    // below always happens before the loop can observe an empty queue.
    if (this.queue.length === 0) return Promise.resolve()
    const loop = this.runQueue()
    this.draining = loop
    return loop
  }

  private async runQueue(): Promise<void> {
    for (;;) {
      const manual = this.queue.shift()
      if (manual === undefined) {
        // Clearing the handle synchronously with observing the empty queue is
        // what stops a tick landing exactly as the queue drains from joining a
        // loop that has already finished, and losing its work.
        this.draining = null
        return
      }
      // A pass must not kill the loop; run() contains its own failures, but a
      // surprise here would otherwise strand every pass queued behind it.
      try {
        await this.run(manual)
      } catch (error) {
        this.logger?.warn(`[workbuddy-checkin] pass failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private async run(manual: boolean): Promise<void> {
    // The preference store warms up asynchronously on harnesses without the
    // register seam (0.1.7's SettingsForms). Reading `settings()` before that
    // read settles answers from shipped defaults, which is how a user who had
    // turned check-in off still got signed in once on every restart.
    await this.ready()
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
    for (const credentials of accounts) {
      // The international deployment has no check-in activity; polling it
      // would only produce a daily 401 per account.
      if (isIntlDomain(credentials.domain)) continue
      const id = workBuddyAccountId(credentials)
      const existing = this.state[id]
      const sameDay = existing?.date === today
      if (sameDay && existing.done) continue
      if (!manual && sameDay && existing.attempts >= CHECKIN_ATTEMPT_CAP) continue
      // An inactive activity is re-checked on its own slow cadence rather than
      // every ten minutes, and a manual pass always overrides the throttle.
      if (!manual && sameDay && existing.inactive === true
        && nowMs - (existing.inactiveAt ?? 0) < CHECKIN_INACTIVE_RECHECK_MS) continue
      await this.checkinOne(id, credentials, today, nowMs)
    }
    // Recorded on every pass, including the idle ones, so the card can show a
    // real "last run" instead of resetting to "never" on each restart.
    this.lastRunAt = nowMs
    await this.save()
  }

  /** Wait for the preference store's warmup read, once. */
  private async ready(): Promise<void> {
    if (this.readyWait === null) {
      this.readyWait = Promise.resolve(this.options.ready?.()).catch(() => undefined)
    }
    await this.readyWait
  }

  /** Check one account in, recording the outcome in its today's entry. */
  private async checkinOne(id: string, credentials: WorkBuddyCredentials, today: string, nowMs: number): Promise<void> {
    const existing = this.state[id]
    const entry: CheckinAccountState = existing?.date === today
      ? existing
      : { date: today, done: false, attempts: 0 }
    this.state[id] = entry
    try {
      // ensureFresh serializes refreshes per account and writes the rotated
      // token back wherever the credential lives; the check-in never handles
      // the refresh itself.
      let fresh = await this.store.ensureFresh(credentials, (current) =>
        refreshCredentials(current, { fetchFn: this.fetchFn }))
      let status = await this.post(`${fresh.backend}${CHECKIN_STATUS_PATH}`, workBuddyHeaders(fresh))
      // A token the server revoked early still looks unexpired locally, so the
      // 401 has to be answered with one forced refresh rather than a burned
      // attempt: the reference script retries exactly this way.
      if (isUnauthorized(status)) {
        fresh = await this.forceRefresh(credentials, fresh)
        status = await this.post(`${fresh.backend}${CHECKIN_STATUS_PATH}`, workBuddyHeaders(fresh))
      }
      const statusData = isRecord(status?.data) ? status.data : {}
      if (readBool(statusData, 'today_checked_in', 'todayCheckedIn') === true) {
        this.markSignedIn(entry, statusData)
        this.logger?.info(`[workbuddy-checkin] ${id} already signed in today`)
        return
      }
      if (readBool(statusData, 'active', 'Active') === false) {
        // Recorded, not terminal: the activity opens on its own schedule, and
        // the host usually boots before it does. Only the re-check throttle
        // (and a manual pass) stands between this answer and another try.
        entry.inactive = true
        entry.inactiveAt = nowMs
        delete entry.lastError
        this.logger?.info(`[workbuddy-checkin] ${id} has no active check-in activity; will re-check later`)
        return
      }
      entry.inactive = false
      delete entry.inactiveAt
      let result = await this.post(`${fresh.backend}${CHECKIN_PATH}`, workBuddyHeaders(fresh))
      if (isUnauthorized(result)) {
        fresh = await this.forceRefresh(credentials, fresh)
        result = await this.post(`${fresh.backend}${CHECKIN_PATH}`, workBuddyHeaders(fresh))
      }
      const payload = isRecord(result?.data) ? result.data : {}
      if (result !== null && result.code === 0) {
        this.markSignedIn(entry, payload)
        this.logger?.info(`[workbuddy-checkin] ${id} signed in; total credits ${entry.totalCredits ?? '?'}`)
        return
      }
      if (isAlreadySignedInMessage(result)) {
        // The upstream rejected the post because today is already signed in.
        // Counting that as a failure burned the retry budget on a success.
        this.markSignedIn(entry, payload)
        this.logger?.info(`[workbuddy-checkin] ${id} already signed in today (upstream confirmed)`)
        return
      }
      entry.attempts += 1
      entry.lastError = `code ${String(result?.code ?? 'no-response')}: ${String(result?.msg ?? 'check-in rejected')}`
      this.logger?.warn(`[workbuddy-checkin] ${id} attempt ${entry.attempts}/${CHECKIN_ATTEMPT_CAP} failed: ${entry.lastError}`)
    } catch (error) {
      entry.attempts += 1
      entry.lastError = error instanceof Error ? error.message : String(error)
      this.logger?.warn(`[workbuddy-checkin] ${id} attempt ${entry.attempts}/${CHECKIN_ATTEMPT_CAP} failed: ${entry.lastError}`)
    }
  }

  /** Record a confirmed sign-in, clearing the transient failure bookkeeping. */
  private markSignedIn(entry: CheckinAccountState, data: Record<string, unknown>): void {
    entry.done = true
    entry.inactive = false
    delete entry.inactiveAt
    delete entry.lastError
    const streakDays = readCount(data, 'streak_days', 'streakDays')
    if (streakDays !== undefined) entry.streakDays = streakDays
    const totalCredits = readCount(data, 'total_credits', 'totalCredits')
    if (totalCredits !== undefined) entry.totalCredits = totalCredits
  }

  /**
   * Refresh a token the server rejected, bypassing the store's expiry check.
   *
   * `ensureFresh` only acts on a locally expired token, so a session the server
   * revoked early would otherwise fail every retry until the file's own clock
   * caught up. The rotation is written back through the store either way.
   */
  private async forceRefresh(
    credentials: WorkBuddyCredentials,
    current: WorkBuddyCredentials,
  ): Promise<WorkBuddyCredentials> {
    try {
      const refreshed = await refreshCredentials(current, { fetchFn: this.fetchFn })
      const merged: WorkBuddyCredentials = { ...credentials, ...refreshed }
      if (credentials.source === 'managed') await this.store.addManaged(merged)
      else await this.store.writeBack(merged)
      return merged
    } catch (error) {
      this.logger?.warn(`[workbuddy-checkin] token refresh after 401 failed: ${error instanceof Error ? error.message : String(error)}`)
      return current
    }
  }

  /**
   * The aggregate the settings card renders. Reads only local state and the
   * account list; it never spends a network request.
   */
  async summary(): Promise<WorkBuddyCheckinSummary> {
    // Same warmup as a pass: the card must not render the shipped default while
    // the stored document — the user's actual choice — is still being read.
    await this.ready()
    await this.load()
    const settings = this.options.settings()
    const accounts = (await this.store.list().catch(() => [] as WorkBuddyCredentials[]))
      .filter((credentials) => !isIntlDomain(credentials.domain))
    const today = localDateString(this.now())
    let doneToday = 0
    let skippedToday = 0
    let failedToday = 0
    for (const credentials of accounts) {
      const entry = this.state[workBuddyAccountId(credentials)]
      if (entry?.date !== today) continue
      // An active entry can carry stale `inactive` bookkeeping from an earlier
      // pass the same day, so the terminal sign-in is checked first.
      if (entry.done) doneToday += 1
      else if (entry.inactive === true) skippedToday += 1
      else if (entry.attempts >= CHECKIN_ATTEMPT_CAP) failedToday += 1
    }
    return {
      enabled: settings.enabled,
      totalAccounts: accounts.length,
      doneToday,
      skippedToday,
      failedToday,
      lastRunAt: this.lastRunAt,
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await fs.readFile(this.statePath, 'utf8')) as unknown
      if (isRecord(parsed)) {
        // Persisted so the card shows a real "last run" after a restart instead
        // of claiming the scheduler has never run.
        const lastRunAt = asCount(parsed.lastRunAt)
        if (lastRunAt !== undefined) this.lastRunAt = lastRunAt
        if (isRecord(parsed.accounts)) {
          for (const [id, value] of Object.entries(parsed.accounts)) {
            const entry = parseStateEntry(value)
            if (entry !== null) this.state[id] = entry
          }
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
      const document = { version: 2, lastRunAt: this.lastRunAt, accounts: this.state }
      await fs.writeFile(tmp, JSON.stringify(document, null, 2), 'utf8')
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
    let parsed: Record<string, unknown> | null = null
    try {
      const value = JSON.parse(text) as unknown
      parsed = isRecord(value) ? value : null
    } catch {
      // A non-JSON body (an HTML error page, an empty 401) carries no business
      // code, so the HTTP status is the only signal left.
      parsed = null
    }
    if (parsed !== null) return parsed
    // Surface the status so callers can tell an auth rejection from a network
    // error; without this an empty 401 body was indistinguishable from an
    // unreachable host, and neither could trigger the refresh-and-retry path.
    if (response.status === 401 || response.status === 403) return { code: response.status, msg: `HTTP ${response.status}` }
    return null
  }
}
