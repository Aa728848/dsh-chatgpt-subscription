import React, { useEffect, useState, type ReactNode } from 'react'
import type {
  AccountPoolStatusDto,
  AccountRotationStrategy,
  PoolAccountSummaryDto,
} from '../../shared/account-pool-contracts.ts'
import { formatPoolLabel, type AccountPoolLabels } from './account-pool-labels.ts'
import { AccountQuota } from './account-quota.tsx'
import { cooldownRemainingParts } from './format.ts'

export type { AccountPoolLabels } from './account-pool-labels.ts'

export interface AccountPoolSectionProps<
  TAccount extends PoolAccountSummaryDto = PoolAccountSummaryDto,
> extends Omit<Pick<AccountPoolStatusDto, 'activeAccountId' | 'rotationStrategy'>, 'accounts'> {
  accounts: TAccount[]
  /** Label set of the hosting tab; see {@link AccountPoolLabels}. */
  labels: AccountPoolLabels
  /** Action currently in flight, used to disable every control at once. */
  busy: string | null
  /** Overrides the login button text while a sign-in flow is running. */
  loginBusyLabel?: string
  onLogin(): void
  /**
   * Replaces the single header button with the provider's own entry points.
   *
   * A line whose sign-in has more than one entry point (two regional deployments,
   * a second sign-in method) replaces the default button with its own; a line that
   * has exactly one keeps the default button.
   */
  renderLoginActions?(): ReactNode
  onSetPrimary(accountId: string): void
  onDelete(accountId: string): void
  onClearCooldown(accountId: string): void
  /** Offered on an account whose credential no longer authenticates. */
  onRelogin?(accountId: string): void
  onSetStrategy(strategy: AccountRotationStrategy): void
  /** Provider-specific detail rows, rendered before the shared ones. */
  renderDetails?(account: TAccount): ReactNode
  /**
   * Whether this line has a quota concept at all.
   *
   * Quota follows the account, so an account the host never read shows "no
   * quota read yet" instead of nothing — but only on a line that reads quota in
   * the first place. A line without one (Ollama: spend, no allowance) leaves
   * this off and its rows stay silent about quota.
   */
  showQuota?: boolean
  /**
   * Provider-specific per-account buttons, rendered before the shared ones.
   *
   * Used by a line that adopts accounts it does not own: hiding or restoring
   * an externally-managed account replaces the delete it must never offer.
   */
  renderAccountActions?(account: TAccount): ReactNode
  /** Extra controls inside the group, after the account list. */
  children?: ReactNode
}

/** Format one account timestamp the way every tab renders it. */
export function formatAccountDate(ms?: number): string {
  if (!ms || ms <= 0) return '—'
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(ms)
  } catch {
    return '—'
  }
}

/** The labels the remaining-time text needs; every tab's set carries them. */
export type CooldownRemainingLabels = Pick<
  AccountPoolLabels,
  'cooldownLeft' | 'cooldownRemaining' | 'cooldownRemainingSeconds'
>

/**
 * The remaining cooldown, in the reader's own words.
 *
 * Whole minutes while a minute or more is left, minutes and seconds below
 * that, and the seconds alone under a minute: "剩 1 分" for the last 59
 * seconds is a lie, and "剩 0 分 42 秒" is unreadable.
 */
export function formatCooldownRemaining(remainingMs: number, labels: CooldownRemainingLabels): string {
  const { minutes, seconds } = cooldownRemainingParts(remainingMs)
  if (minutes === 0) return formatPoolLabel(labels.cooldownRemainingSeconds, { seconds })
  if (seconds === 0) return formatPoolLabel(labels.cooldownLeft, { minutes })
  return formatPoolLabel(labels.cooldownRemaining, { minutes, seconds })
}

/** Whether one account currently carries a live 429 cooldown. */
export function isCoolingDown(account: PoolAccountSummaryDto, now = Date.now()): boolean {
  return typeof account.cooldownUntil === 'number' && account.cooldownUntil > now
}

/**
 * The account-management group every provider tab renders.
 *
 * One component rather than four near-identical blocks: the account card, its
 * badges and the rotation-strategy picker are identical across providers, and
 * only the identity details differ.
 *
 * Credential storage is deliberately NOT shown here. Where the host keeps a
 * token is not a setting a user can act on, and rendering it as a labeled row
 * invited exactly that reading; several lines' notices went further and printed
 * the credential file's path.
 */
export function AccountPoolSection<TAccount extends PoolAccountSummaryDto = PoolAccountSummaryDto>(
  props: AccountPoolSectionProps<TAccount>,
): React.ReactElement {
  const t = props.labels
  const accounts = props.accounts
  // The clock the cooldown badges count down against.
  //
  // It used to be a single `Date.now()` taken while the card rendered, which
  // froze every badge at the value it had when the page was drawn: a user
  // watching a five-minute cooldown read "剩 5 分" for five minutes. The clock
  // now lives in state, and the host's `cooldownUntil` is the anchor it counts
  // down to - the browser's own time, not a value the host has to refresh.
  const [now, setNow] = useState(() => Date.now())
  // One sibling holding a snapshot proves the line reads quota per account, so
  // the accounts it has not read yet may say so. Without this, a line that has
  // no quota concept would grow a row of "not read yet" on every account.
  const anyQuota = accounts.some((account) => account.quota !== undefined)

  // Whether anything on this card is counting down right now.
  const counting = accounts.some((account) => isCoolingDown(account, now))

  // The tick.
  //
  // It runs only while something is actually cooling down: a settings page that
  // shows no cooldown has nothing to count, and a permanent 1 Hz timer there
  // would wake the whole tab every second for the sake of a number that never
  // changes. The badge therefore also disappears on its own when the cooldown
  // lifts, without waiting for the next status read.
  useEffect(() => {
    if (!counting) return
    // The clock may have been idle for a long while - nothing was cooling down
    // - so it is read again the moment a countdown starts, not one tick later.
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [counting])

  return (
    <section className="dsha-group">
      <div className="dsha-grouphead">
        <h3>
          {t.accountPool}
          {accounts.length > 0 && (
            <span className="dsha-muted" style={{ fontWeight: 400, marginLeft: 8 }}>
              （{formatPoolLabel(t.accountCount, { count: accounts.length })}）
            </span>
          )}
        </h3>
        {props.renderLoginActions !== undefined ? props.renderLoginActions() : (
          <button className="dsha-btn dsha-btn-primary" disabled={props.busy !== null} onClick={props.onLogin}>
            {props.loginBusyLabel || t.addAccount}
          </button>
        )}
      </div>

      {accounts.length > 1 && (
        <div className="dsha-pref-row">
          <div>
            <strong>{t.rotationStrategy}</strong>
            <p className="dsha-muted" style={{ fontSize: 12, marginTop: 2 }}>
              {props.rotationStrategy === 'round-robin'
                ? t.strategyRoundRobin
                : props.rotationStrategy === 'sticky' ? t.strategySticky : t.strategySequential}
            </p>
          </div>
          <select
            className="dsha-select"
            aria-label={t.rotationStrategy}
            value={props.rotationStrategy}
            disabled={props.busy !== null}
            onChange={(event) => props.onSetStrategy(event.target.value as AccountRotationStrategy)}
          >
            <option value="sequential">顺序耗尽</option>
            <option value="round-robin">轮询调度</option>
            <option value="sticky">粘性会话</option>
          </select>
        </div>
      )}

      {accounts.length === 0 ? (
        <div className="dsha-empty">{t.noAccounts}</div>
      ) : (
        <div className="dsha-accounts-list">
          {accounts.map((account) => {
            const isActive = account.id === props.activeAccountId
            const cooling = isCoolingDown(account, now)
            const needsRelogin = account.authStatus !== undefined && account.authStatus !== 'ok'
            return (
              <div key={account.id} className={`dsha-account-card ${isActive ? 'active' : ''}`}>
                <div className="dsha-account-header">
                  <div className="dsha-account-identity">
                    <span className="dsha-account-title">{account.alias || account.email || account.id}</span>
                    <div className="dsha-badges">
                      {account.isPrimary && <span className="dsha-badge primary">{t.primaryAccount}</span>}
                      {isActive && <span className="dsha-badge active">{t.activeAccount}</span>}
                      {cooling && (
                        <span className="dsha-badge cooldown">
                          {t.cooling}（{formatCooldownRemaining(account.cooldownUntil! - now, t)}）
                        </span>
                      )}
                      {needsRelogin && <span className="dsha-badge danger">{t.needsRelogin}</span>}
                    </div>
                  </div>
                  <div className="dsha-account-actions">
                    {props.renderAccountActions?.(account)}
                    {!account.isPrimary && (
                      <button
                        className="dsha-btn"
                        disabled={props.busy !== null}
                        onClick={() => props.onSetPrimary(account.id)}
                      >
                        {t.setPrimary}
                      </button>
                    )}
                    {cooling && (
                      <button
                        className="dsha-btn"
                        disabled={props.busy !== null}
                        onClick={() => props.onClearCooldown(account.id)}
                      >
                        {t.clearCooldown}
                      </button>
                    )}
                    {needsRelogin && props.onRelogin && (
                      <button
                        className="dsha-btn"
                        disabled={props.busy !== null}
                        onClick={() => props.onRelogin!(account.id)}
                      >
                        {t.relogin}
                      </button>
                    )}
                    {/* An account this plugin does not own must never be
                        destroyed from here; its line supplies the action. */}
                    {account.removable !== false && (
                      <button
                        className="dsha-btn"
                        disabled={props.busy !== null}
                        onClick={() => props.onDelete(account.id)}
                      >
                        {t.deleteAccount}
                      </button>
                    )}
                  </div>
                </div>

                <div className="dsha-account-details">
                  {/* The line's own facts first, then the shared ones. Neither
                      repeats the card's title: on most lines the alias IS the
                      address, so printing "邮箱: <same address>" under a title
                      that already reads as that address is the same fact twice.
                      The same rule is why no line's renderDetails may render
                      e-mail, expiry or last-used itself. */}
                  {props.renderDetails?.(account)}
                  {account.email !== undefined && account.email !== account.alias
                    && <span>{t.email}: {account.email}</span>}
                  {account.expiresAt !== undefined && <span>{t.expires}: {formatAccountDate(account.expiresAt)}</span>}
                  {account.lastUsedAt !== undefined && <span>{t.lastUsed}: {formatAccountDate(account.lastUsedAt)}</span>}
                </div>

                <AccountQuota
                  quota={account.quota}
                  labels={t}
                  showEmpty={props.showQuota === true || anyQuota}
                  now={now}
                />
                {needsRelogin && account.authFailedReason && (
                  <div className="dsha-account-details">
                    <span>{account.authFailedReason}</span>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {props.children}
    </section>
  )
}
