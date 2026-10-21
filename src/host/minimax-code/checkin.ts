/**
 * Daily check-in scheduler for the MiniMax Code line.
 *
 * The wire half lives in ./checkin-gateway.ts (official-client recipe,
 * verified live); this module is the host-owned daily pass around it.
 *
 * - **Both regions.** The official client's public gateway has an origin per
 *   region, so an account signs in against its own region's origin. There is
 *   no CN-only carve-out: the CLI ships the same surface
 *   worldwide.
 * - **Idempotent.** The panel is read first; an account whose today is already
 *   claimed (by anyone) is only recorded. A duplicate claim answers
 *   `claim_result: 2` (AlreadyClaimed), which is a success, never a retry.
 * - **Patient with the day.** A today that is neither claimable nor claimed
 *   (upcoming/disabled) is parked and re-checked on an hourly cadence rather
 *   than abandoned: the activity flips on its own schedule, and the host
 *   usually boots before it does.
 * - **Bounded.** A failing account is retried at most {@link CHECKIN_ATTEMPT_CAP}
 *   times a day, so a broken account cannot turn the ten-minute tick into a
 *   request loop. A manual run ignores the cap and the toggle, like the card's
 *   "check in now", and is queued behind an in-flight run.
 *
 * Credentials stay host-side: the only write beyond the state file is the
 * account pool's own refresh write-back, reused here unchanged through
 * `getFreshCredential` / `renewCredential`.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { dshHomeDir } from '../common/home.ts'
import type { MinimaxCodeRegion } from '../../shared/minimax-code-contracts.ts'
import type { MinimaxCodeCheckinSummary } from '../../shared/minimax-code-contracts.ts'
import type { MinimaxCodeAccountPool, MinimaxCodeAccountSummaryDto } from './account-pool.ts'
import type { MinimaxCodeCredentials } from './token-store.ts'
import {
  checkinAccountIdentity,
  claimSignin,
  currentSigninStreak,
  fetchAccountIdentity,
  fetchSigninPanel,
  MinimaxCodeCheckinHttpError,
  SIGNIN_DAY_CLAIMABLE,
  SIGNIN_DAY_CLAIMED,
  type SigninPanel,
} from './checkin-gateway.ts'

/**
 * Scheduler cadence. The first tick at host startup is the daily run; the
 * interval keeps a long-lived process signing in on later days without a
 * restart. Idle ticks cost no requests — the day state short-circuits them.
 */
export const CHECKIN_TICK_MS = 10 * 60 * 1000
/** Daily retry ceiling for one account after a failed attempt. */
export const CHECKIN_ATTEMPT_CAP = 3
/**
 * How long a not-yet-claimable today waits before the panel is polled again.
 * The activity opens on its own schedule, and the first answer of the day is
 * frequently "not open yet".
 */
export const CHECKIN_INACTIVE_RECHECK_MS = 60 * 60 * 1000

/** State document the scheduler keeps beside the other plugin stores. */
export function checkinStatePath(): string {
  return path.join(dshHomeDir(), 'storages', 'minimax-code-checkin.json')
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
  /** Confirmed signed in today, so nothing more to do until tomorrow. */
  done: boolean
  /** Failed attempts today, capped at {@link CHECKIN_ATTEMPT_CAP} for automatic runs. */
  attempts: number
  /** Today is neither claimable nor claimed; re-checked on the slow cadence. */
  inactive?: boolean
  /** Unix ms the inactive answer was recorded; throttles the re-check. */
  inactiveAt?: number
  lastError?: string
  streakDays?: number
  /** Points a fresh claim granted today; absent when today was already claimed. */
  claimedPoints?: number
}

/** Cached identity for one account; survives the per-day entries. */
interface CheckinIdentityState {
  realUserID: string
  region: MinimaxCodeRegion
  /**
   * {@link checkinAccountIdentity} of the credential this realUserID was
   * resolved with — the account this entry is FOR. Absent only on a state
   * document written before the field existed, which is why an absent value is
   * adopted rather than treated as a mismatch.
   */
  accountIdentity?: string
}

/**
 * The check-in refused to act because the account changed **halfway through one
 * attempt**.
 *
 * This is deliberately NOT the "the pool row was re-pointed at another account"
 * case: that one is a legitimate state change and the entry re-synchronises to
 * it (see {@link MinimaxCodeCheckinService['identityFor']}). What this class
 * reports is the one case that must never self-heal — a forced 401 renewal that
 * answers with a different account — because the panel was already read for one
 * account and the claim would post as another.
 *
 * Its own class so the caller can tell it apart from a transport failure: it is
 * never retried, and never recorded as "nothing to do today". The message
 * carries only non-secret facts — the account keys each side resolved to — and
 * never a token.
 */
export class MinimaxCodeCheckinAccountMismatchError extends Error {
  constructor(
    readonly accountId: string,
    readonly expectedIdentity: string | undefined,
    readonly actualIdentity: string | undefined,
  ) {
    super(
      `账号不一致：签到条目 pinned 到 ${expectedIdentity ?? '未知账号'}，当前凭据属于 ${actualIdentity ?? '未知账号'}；`
      + `已中止本次签到（account ${accountId}），未领取。`,
    )
    this.name = 'MinimaxCodeCheckinAccountMismatchError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isRegion(value: unknown): value is MinimaxCodeRegion {
  return value === 'cn' || value === 'global'
}

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
  const claimedPoints = asCount(value.claimedPoints)
  if (claimedPoints !== undefined) entry.claimedPoints = claimedPoints
  return entry
}

/** The slice of the account pool the scheduler uses. */
export type MinimaxCodeCheckinPool = Pick<
  MinimaxCodeAccountPool,
  'listAccounts' | 'getFreshCredential' | 'renewCredential'
>

export interface MinimaxCodeCheckinServiceOptions {
  fetchFn?: typeof fetch
  /** State document path; tests redirect it, production uses {@link checkinStatePath}. */
  statePath?: string
  /** Live preference, re-read on every tick so the toggle applies at once. */
  settings: () => { enabled: boolean }
  /**
   * Resolves once the preference store has read its stored document, so the
   * startup pass cannot act on a default the stored document is about to
   * overwrite. Optional for callers whose settings are already in memory.
   */
  ready?: () => Promise<void>
  /** Clock injection for tests. */
  now?: () => number
  /** `desktop_version` the wire request reports; the plugin version in production. */
  appVersion?: string
  logger?: {
    info(message: string): void
    warn(message: string): void
  }
}

/**
 * Refuse to act when the credential drifted away from the account this attempt
 * started on.
 *
 * This is the narrow, intra-attempt half of the account guard. The wide half —
 * "the pool row was re-pointed at another account" — is a legitimate state
 * change that `identityFor` re-synchronises to; this one is the case that must
 * never self-heal, because by the time it fires the panel and the claim would
 * belong to two different accounts.
 *
 * The comparison is on {@link checkinAccountIdentity}, which is deliberately
 * the ROTATION key rather than an account id: a rotated token of the same
 * sign-in passes by construction, and only a different sign-in fails. What it
 * cannot promise is that the sign-in behind a key is still the same person —
 * see the note on `native:<region>:<recordKey>` in {@link checkinAccountIdentity}
 * — which is exactly why the authoritative account fact in this file stays the
 * resolved `realUserID`, and why this check is a guard rail rather than the
 * identity system.
 *
 * With no key on either side there is nothing to compare, and comparing keys
 * that were absent when the attempt began would refuse a legitimate re-sync.
 */
function assertSameAccount(
  accountId: string,
  credentials: MinimaxCodeCredentials,
  pinned: string | undefined,
): void {
  const actual = checkinAccountIdentity(credentials)
  if (pinned === undefined || actual === undefined || pinned === actual) return
  throw new MinimaxCodeCheckinAccountMismatchError(accountId, pinned, actual)
}

/**
 * The check-in scheduler. One instance per plugin load; the host owns the
 * interval and clears it from the same `ctx.effect` that created it.
 */
export class MinimaxCodeCheckinService {
  private readonly fetchFn: typeof fetch
  private readonly statePath: string
  private readonly now: () => number
  private readonly logger: MinimaxCodeCheckinServiceOptions['logger']
  private readonly appVersion: string | undefined
  private state: Record<string, CheckinAccountState> = {}
  private identities: Record<string, CheckinIdentityState> = {}
  private loaded = false
  /** Passes waiting to run, in order; `true` marks a manual pass. */
  private readonly queue: boolean[] = []
  /** The drain loop currently working the queue, if any. */
  private draining: Promise<void> | null = null

  private lastRunAt: number | null = null
  /** Memoized preference warmup, so it is awaited once however many passes run. */
  private readyWait: Promise<void> | null = null

  constructor(
    private readonly pool: MinimaxCodeCheckinPool,
    private readonly options: MinimaxCodeCheckinServiceOptions,
  ) {
    this.fetchFn = options.fetchFn ?? fetch
    this.statePath = options.statePath ?? checkinStatePath()
    this.now = options.now ?? (() => Date.now())
    this.logger = options.logger
    this.appVersion = options.appVersion
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
    if (!manual && (this.queue.length > 0 || this.draining !== null)) {
      return this.draining ?? Promise.resolve()
    }
    this.queue.push(manual)
    return this.drain()
  }

  private drain(): Promise<void> {
    if (this.draining !== null) return this.draining
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
        this.logger?.warn(`[minimax-code-checkin] pass failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private async run(manual: boolean): Promise<void> {
    // The preference store warms up asynchronously on harnesses without the
    // register seam. Reading `settings()` before that read settles answers
    // from shipped defaults, which is how a user who had turned check-in off
    // still got signed in once on every restart.
    await this.ready()
    const settings = this.options.settings()
    if (!manual && !settings.enabled) return
    await this.load()
    const nowMs = this.now()
    const today = localDateString(nowMs)
    let accounts: MinimaxCodeAccountSummaryDto[]
    try {
      accounts = await this.pool.listAccounts()
    } catch (error) {
      this.logger?.warn(`[minimax-code-checkin] account scan failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    for (const account of accounts) {
      const existing = this.state[account.id]
      const sameDay = existing?.date === today
      if (sameDay && existing.done) continue
      if (!manual && sameDay && existing.attempts >= CHECKIN_ATTEMPT_CAP) continue
      // An inactive today is re-checked on its own slow cadence rather than
      // every ten minutes, and a manual pass always overrides the throttle.
      if (!manual && sameDay && existing.inactive === true
        && nowMs - (existing.inactiveAt ?? 0) < CHECKIN_INACTIVE_RECHECK_MS) continue
      await this.checkinOne(account, today, nowMs)
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

  /**
   * Resolve the account's realUserID, cached across days.
   *
   * The OAuth document does not carry it and the check-in query string needs
   * it, so it is fetched from the identity surface once and kept in the state
   * document. The region is cached alongside because the identity call's
   * origin depends on it.
   *
   * The account identity of the resolving credential is pinned to the entry as
   * well: the pin records which sign-in this realUserID was learned FOR, and it
   * outlives the token that resolved it.
   *
   * **A re-pointed row is a state change, not a fault.** When the pin no longer
   * matches the credential in hand, the pool row now holds a different account
   * (the user signed a second account into the desktop app's sheet, or adopted
   * another session into this row). Following it is the correct outcome: a pool
   * row IS one account this plugin manages, and the check-in exists to sign in
   * whatever account that row now holds. Holding the stale pin instead would
   * mean asking the panel with A's realUserID while presenting B's token —
   * precisely "B's credential used to check in A" — and would have no exit,
   * because nothing clears a state document the card cannot reach.
   *
   * So a diverging pin re-resolves the identity WITH the credential in hand and
   * re-pins the entry to it. An entry written before the pin existed carries
   * `undefined` and re-resolves once too, which is how an old state document
   * heals itself into a pinned one.
   *
   * The one thing that must still never happen — an account changing halfway
   * through a single attempt — is caught elsewhere, because it cannot be caught
   * here: {@link attemptOnce}'s panel/claim pair and the forced-renewal guard in
   * {@link checkinOne}.
   */
  private async identityFor(
    account: MinimaxCodeAccountSummaryDto,
    credentials: MinimaxCodeCredentials,
    region: MinimaxCodeRegion,
  ): Promise<{ identity: CheckinIdentityState; changedFrom: string | undefined }> {
    const credentialIdentity = checkinAccountIdentity(credentials)
    const cached = this.identities[account.id]
    // Reusable only while the pin still describes the credential in hand. Two
    // absent keys count as a match (a credential with no stable identity has
    // nothing to pin), which is what keeps such an account from re-resolving on
    // every single pass.
    if (cached !== undefined && cached.region === region && cached.accountIdentity === credentialIdentity) {
      return { identity: cached, changedFrom: undefined }
    }
    const identity = await fetchAccountIdentity(credentials.accessToken, region, {
      fetchFn: this.fetchFn,
      ...(this.appVersion === undefined ? {} : { appVersion: this.appVersion }),
    })
    const next: CheckinIdentityState = {
      realUserID: identity.realUserID,
      region,
      ...(credentialIdentity === undefined ? {} : { accountIdentity: credentialIdentity }),
    }
    this.identities[account.id] = next
    // Reported only for a real change of account. An entry that was merely
    // unpinned is a format upgrade, not something worth a warning.
    const changedFrom = cached?.accountIdentity !== undefined && cached.accountIdentity !== credentialIdentity
      ? cached.accountIdentity
      : undefined
    return { identity: next, changedFrom }
  }

  /** Check one account in, recording the outcome in its today's entry. */
  private async checkinOne(account: MinimaxCodeAccountSummaryDto, today: string, nowMs: number): Promise<void> {
    const existing = this.state[account.id]
    const entry: CheckinAccountState = existing?.date === today
      ? existing
      : { date: today, done: false, attempts: 0 }
    this.state[account.id] = entry
    const region: MinimaxCodeRegion = isRegion(account.region) ? account.region : 'cn'
    try {
      // getFreshCredential serializes refreshes per account and writes the
      // rotated token back through the pool; the check-in never refreshes
      // itself. It also renews BEFORE expiry now, so a scheduled check-in is not
      // the caller that discovers a spent refresh token.
      const credentials = await this.pool.getFreshCredential(account.id, this.fetchFn)
      try {
        await this.attemptOnce(account, entry, credentials, region, nowMs)
      } catch (error) {
        // A token the server revoked early still looks unexpired locally, so
        // the first 401 — from the identity, status, or claim call alike — is
        // answered with one forced renewal and one retry rather than a burned
        // attempt. The renewal goes through the pool, so the rotated token is
        // written back the same way a scheduled refresh would write it.
        if (!(error instanceof MinimaxCodeCheckinHttpError) || (error.status !== 401 && error.status !== 403)) throw error
        // The identity cache may name the account the dead token belonged to;
        // dropping it is what lets the retry resolve the identity afresh.
        delete this.identities[account.id]
        const renewed = await this.pool.renewCredential(account.id, this.fetchFn)
        // A renewal that lands on a different account than the one that asked is
        // not a renewal of this sign-in; handing it over anyway is precisely the
        // cross-account claim the retry must not make.
        const beforeRenewal = checkinAccountIdentity(credentials)
        const afterRenewal = checkinAccountIdentity(renewed)
        if (beforeRenewal !== undefined && afterRenewal !== undefined && beforeRenewal !== afterRenewal) {
          throw new MinimaxCodeCheckinAccountMismatchError(account.id, beforeRenewal, afterRenewal)
        }
        await this.attemptOnce(account, entry, renewed, region, nowMs)
      }
    } catch (error) {
      entry.attempts += 1
      entry.lastError = error instanceof Error ? error.message : String(error)
      // A thrown attempt is a FAILURE, not a parked day. An `inactive` recorded by
      // an earlier pass of the same day would otherwise outlive it, and the card
      // would keep reporting the account as skipped — which is exactly the
      // reading an account mismatch must never produce.
      entry.inactive = false
      delete entry.inactiveAt
      this.logger?.warn(`[minimax-code-checkin] ${account.id} attempt ${entry.attempts}/${CHECKIN_ATTEMPT_CAP} failed: ${entry.lastError}`)
    }
  }

  /**
   * One full try for one account: identity, panel, and — when today is
   * claimable — the claim. Settles the entry on every outcome; throws for the
   * caller's renew-and-retry or attempt bookkeeping.
   */
  private async attemptOnce(
    account: MinimaxCodeAccountSummaryDto,
    entry: CheckinAccountState,
    credentials: MinimaxCodeCredentials,
    region: MinimaxCodeRegion,
    nowMs: number,
  ): Promise<void> {
    const { identity, changedFrom } = await this.identityFor(account, credentials, region)
    if (changedFrom !== undefined) {
      // Non-secret facts only: the account keys and the pool row id. Neither the
      // token nor the resolved realUserID is logged.
      this.logger?.warn(
        `[minimax-code-checkin] ${account.id} account changed since the last pass (${changedFrom} -> `
        + `${checkinAccountIdentity(credentials) ?? 'unknown'}); entry re-synced to the credential now held`,
      )
    }
    // The identity just resolved IS the account this attempt signs in, and the
    // credential that resolved it is the only one allowed to act for it.
    const pinned = checkinAccountIdentity(credentials)
    const panel = await this.panel(account, credentials, identity, region, pinned)
    if (this.recordPanelOutcome(entry, panel, account.id, nowMs)) return
    const claim = await this.claim(account, credentials, identity, region, pinned)
    this.markSignedIn(entry, claim.panel)
    if (claim.claim_result === 1) entry.claimedPoints = claim.points
    this.logger?.info(`[minimax-code-checkin] ${account.id} signed in; +${claim.points} credits${claim.claim_result === 2 ? ' (already claimed upstream)' : ''}`)
  }

  /**
   * The status call, against the current credential.
   *
   * The guard runs BEFORE the panel is read: the credential making this request
   * must still be the one the identity was resolved with a moment ago.
   */
  private async panel(
    account: MinimaxCodeAccountSummaryDto,
    credentials: MinimaxCodeCredentials,
    identity: CheckinIdentityState,
    region: MinimaxCodeRegion,
    pinned: string | undefined,
  ): Promise<SigninPanel> {
    assertSameAccount(account.id, credentials, pinned)
    return fetchSigninPanel(credentials.accessToken, identity.realUserID, region, {
      fetchFn: this.fetchFn,
      ...(this.appVersion === undefined ? {} : { appVersion: this.appVersion }),
    })
  }

  /**
   * The claim call, against the current credential.
   *
   * The guard runs again here — the pair the official client protects
   * (`getSigninPanel` then `claimSignin`) — so a panel read for one account can
   * never be followed by a claim posted as another, and both calls carry the
   * same identity value by construction.
   */
  private async claim(
    account: MinimaxCodeAccountSummaryDto,
    credentials: MinimaxCodeCredentials,
    identity: CheckinIdentityState,
    region: MinimaxCodeRegion,
    pinned: string | undefined,
  ) {
    assertSameAccount(account.id, credentials, pinned)
    return claimSignin(credentials.accessToken, identity.realUserID, region, {
      fetchFn: this.fetchFn,
      ...(this.appVersion === undefined ? {} : { appVersion: this.appVersion }),
    })
  }

  /**
   * Fold one panel into the day's entry.
   *
   * Returns true when the entry is settled for the day (claimed already, or
   * parked inactive): the caller then skips the claim. Today claimable is the
   * one answer that returns false.
   */
  private recordPanelOutcome(entry: CheckinAccountState, panel: SigninPanel, accountId: string, nowMs: number): boolean {
    const today = panel.days.find((day) => day.is_today)
    if (today?.status === SIGNIN_DAY_CLAIMED) {
      this.markSignedIn(entry, panel)
      this.logger?.info(`[minimax-code-checkin] ${accountId} already signed in today`)
      return true
    }
    if (today?.status !== SIGNIN_DAY_CLAIMABLE) {
      // Recorded, not terminal: the activity opens on its own schedule, and
      // the host usually boots before it does. Only the re-check throttle
      // (and a manual pass) stands between this answer and another try.
      entry.inactive = true
      entry.inactiveAt = nowMs
      delete entry.lastError
      this.logger?.info(`[minimax-code-checkin] ${accountId} has no claimable day today; will re-check later`)
      return true
    }
    entry.inactive = false
    delete entry.inactiveAt
    return false
  }

  /** Record a confirmed sign-in, clearing the transient failure bookkeeping. */
  private markSignedIn(entry: CheckinAccountState, panel: SigninPanel): void {
    entry.done = true
    entry.inactive = false
    delete entry.inactiveAt
    delete entry.lastError
    entry.streakDays = currentSigninStreak(panel.days)
  }

  /**
   * The aggregate the settings card renders. Reads only local state and the
   * account list; it never spends a network request.
   */
  async summary(): Promise<MinimaxCodeCheckinSummary> {
    // Same warmup as a pass: the card must not render the shipped default while
    // the stored document — the user's actual choice — is still being read.
    await this.ready()
    await this.load()
    const settings = this.options.settings()
    const accounts = await this.pool.listAccounts().catch(() => [] as MinimaxCodeAccountSummaryDto[])
    const today = localDateString(this.now())
    let doneToday = 0
    let skippedToday = 0
    let failedToday = 0
    let streakDays: number | undefined
    let claimedPoints: number | undefined
    for (const account of accounts) {
      const entry = this.state[account.id]
      if (entry?.date !== today) continue
      // An active entry can carry stale `inactive` bookkeeping from an earlier
      // pass the same day, so the terminal sign-in is checked first.
      if (entry.done) {
        doneToday += 1
        if (entry.streakDays !== undefined) streakDays = Math.max(streakDays ?? 0, entry.streakDays)
        if (entry.claimedPoints !== undefined) claimedPoints = (claimedPoints ?? 0) + entry.claimedPoints
      } else if (entry.inactive === true) {
        skippedToday += 1
      } else if (entry.attempts >= CHECKIN_ATTEMPT_CAP) {
        failedToday += 1
      }
    }
    return {
      enabled: settings.enabled,
      totalAccounts: accounts.length,
      doneToday,
      skippedToday,
      failedToday,
      lastRunAt: this.lastRunAt,
      ...(streakDays === undefined ? {} : { streakDays }),
      ...(claimedPoints === undefined ? {} : { claimedPoints }),
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
        if (isRecord(parsed.identities)) {
          for (const [id, value] of Object.entries(parsed.identities)) {
            if (isRecord(value) && typeof value.realUserID === 'string' && isRegion(value.region)) {
              this.identities[id] = {
                realUserID: value.realUserID,
                region: value.region,
                ...(typeof value.accountIdentity === 'string' && value.accountIdentity !== ''
                  ? { accountIdentity: value.accountIdentity } : {}),
              }
            }
          }
        }
      }
    } catch {
      // A missing or unreadable state file starts empty; the server's own
      // idempotency (today already claimed / AlreadyClaimed) keeps a re-run
      // from double-signing.
    }
  }

  private async save(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.statePath), { recursive: true })
      const tmp = `${this.statePath}.tmp.${process.pid}`
      const document = { version: 1, lastRunAt: this.lastRunAt, accounts: this.state, identities: this.identities }
      await fs.writeFile(tmp, JSON.stringify(document, null, 2), 'utf8')
      await fs.rename(tmp, this.statePath)
    } catch {
      // The state file is a dedup optimization; a failed write must not fail
      // the check-in that already happened.
    }
  }
}
