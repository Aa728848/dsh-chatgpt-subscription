import React, { type ReactNode } from 'react'
import type {
  AccountPoolStatusDto,
  AccountRotationStrategy,
  PoolAccountSummaryDto,
} from '../../shared/account-pool-contracts.ts'
import { formatPoolLabel, type AccountPoolLabels } from './account-pool-labels.ts'
import { AccountQuota } from './account-quota.tsx'

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
   * WorkBuddy signs in against two regional deployments, so one "add account"
   * button cannot express it; every other line keeps the default button.
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

/** Whole minutes left in a cooldown, never below one. */
export function cooldownMinutesLeft(cooldownUntil: number, now = Date.now()): number {
  return Math.max(1, Math.ceil((cooldownUntil - now) / 60_000))
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
  const now = Date.now()
  // One sibling holding a snapshot proves the line reads quota per account, so
  // the accounts it has not read yet may say so. Without this, a line that has
  // no quota concept would grow a row of "not read yet" on every account.
  const anyQuota = accounts.some((account) => account.quota !== undefined)

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
                          {t.cooling}（{formatPoolLabel(t.cooldownLeft, { minutes: cooldownMinutesLeft(account.cooldownUntil!, now) })}）
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
