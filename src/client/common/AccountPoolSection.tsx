import React, { type ReactNode } from 'react'
import type {
  AccountPoolStatusDto,
  AccountRotationStrategy,
  PoolAccountSummaryDto,
} from '../../shared/account-pool-contracts.ts'
import { formatPoolLabel, type AccountPoolLabels } from './account-pool-labels.ts'

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
  onSetPrimary(accountId: string): void
  onDelete(accountId: string): void
  onClearCooldown(accountId: string): void
  /** Offered on an account whose credential no longer authenticates. */
  onRelogin?(accountId: string): void
  onSetStrategy(strategy: AccountRotationStrategy): void
  /** Provider-specific detail rows, rendered before the shared ones. */
  renderDetails?(account: TAccount): ReactNode
  /** Value shown beside the storage label; defaults to a generic description. */
  storageValue?: string
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
 * badges, the rotation-strategy picker and the storage notice are identical
 * across providers, and only the identity details differ.
 */
export function AccountPoolSection<TAccount extends PoolAccountSummaryDto = PoolAccountSummaryDto>(
  props: AccountPoolSectionProps<TAccount>,
): React.ReactElement {
  const t = props.labels
  const accounts = props.accounts
  const now = Date.now()

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
        <button className="dsha-btn dsha-btn-primary" disabled={props.busy !== null} onClick={props.onLogin}>
          {props.loginBusyLabel || t.addAccount}
        </button>
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
                    <button
                      className="dsha-btn"
                      disabled={props.busy !== null}
                      onClick={() => props.onDelete(account.id)}
                    >
                      {t.deleteAccount}
                    </button>
                  </div>
                </div>

                <div className="dsha-account-details">
                  {props.renderDetails?.(account)}
                  {account.email && <span>{t.email}: {account.email}</span>}
                  {account.expiresAt !== undefined && <span>{t.expires}: {formatAccountDate(account.expiresAt)}</span>}
                  {account.lastUsedAt !== undefined && <span>{t.lastUsed}: {formatAccountDate(account.lastUsedAt)}</span>}
                </div>
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

      <div className="dsha-row" style={{ marginTop: 12 }}>
        <span className="dsha-label">{t.storage}</span>
        <span className="dsha-value">{props.storageValue ?? '本地安全存储 (JSON/DPAPI)'}</span>
      </div>
      <p className="dsha-notice">{t.storageNotice}</p>
    </section>
  )
}
