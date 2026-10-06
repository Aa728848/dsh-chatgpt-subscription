/**
 * The MiniMax Code settings card.
 *
 * Markup only: every piece of state, every effect and every request this card
 * makes lives in 'useMinimaxCodeSection.ts', which returns one named shape the
 * JSX below reads. The two files are the split of a single 915-line component —
 * the behaviour is unchanged, and this one should stay render-shaped.
 */
import React from 'react'
import {
  MINIMAX_CODE_REASONING_EFFORTS,
  type MinimaxCodeModelOption,
  type MinimaxCodeReasoningEffort,
} from '../../shared/minimax-code-contracts.ts'
import { AccountPoolSection } from '../common/AccountPoolSection.tsx'
import { ContextWindowEditor } from '../common/ContextWindowEditor.tsx'
import { ModelChecklist } from '../common/ModelChecklist.tsx'
import { formatCapacity, formatDate } from '../common/format.ts'
import {
  fallbackTranslate,
  useMinimaxCodeSection,
  type MinimaxCodeSectionProps,
  type Translate,
} from './useMinimaxCodeSection.ts'

/** Human label per thinking mode, so the card states what the model does. */
function thinkingLabel(mode: MinimaxCodeModelOption['thinking'], t: Translate): string {
  if (mode === 'always-on') return t('thinkingAlwaysOn')
  if (mode === 'forced-effort') return t('thinkingForced')
  return t('thinkingToggle')
}

/**
 * Hours still left on the access token, or null once it has run out.
 *
 * MiniMax Code's token lives about 24 hours, so hours are the unit the card
 * reports; a value worth a fraction of an hour keeps one decimal instead of
 * rounding down to 0.
 */
export function remainingHours(expiresAtMs: number | undefined): string | null {
  if (expiresAtMs === undefined || !Number.isFinite(expiresAtMs) || expiresAtMs <= 0) return null
  const hours = (expiresAtMs - Date.now()) / 3_600_000
  if (hours <= 0) return null
  return hours >= 10 ? hours.toFixed(0) : hours.toFixed(1)
}

export function MinimaxCodeSection({ onModelChange }: MinimaxCodeSectionProps): React.JSX.Element {
  const { state, derived, actions } = useMinimaxCodeSection({ onModelChange })
  const { status, loading, busy, error, flow, copied, connectionNotice, contextDrafts, savingModel, pool } = state
  const { authenticated, account, quota, models, contextModels, overrideCount, poolLabels } = derived
  const {
    login, cancelLogin, copyCode, logout, poolAction, setStrategy, toggleModel, setAllModels,
    setCheckinEnabled, runCheckinNow, updateEffort, saveContextWindow, resetContextWindow,
    resetAllContextWindows, refreshQuota, testConnection, updateContextDraft,
  } = actions

  const t: Translate = fallbackTranslate

  if (loading) {
    return (
      <div className="dsha-page">
        <div className="dsha-empty">{t('loading')}</div>
      </div>
    )
  }

  const hours = remainingHours(account?.expiresAtMs)

  return (
    <div className="dsha-page">
      <p className="dsha-muted">{t('pageDesc')}</p>

      {pool !== undefined && (
        <AccountPoolSection
          labels={poolLabels}
          accounts={pool.accounts}
          rotationStrategy={pool.rotationStrategy}
          {...(pool.activeAccountId === undefined ? {} : { activeAccountId: pool.activeAccountId })}
          busy={busy}
          onLogin={() => void login()}
          onSetPrimary={(accountId) => void poolAction('set-primary', accountId)}
          onDelete={(accountId) => void poolAction('delete', accountId)}
          onClearCooldown={(accountId) => void poolAction('clear-cooldown', accountId)}
          // The account card renders its 重新登录 button only when this handler is
          // supplied, and every sibling line supplies one. Without it a MiniMax Code
          // account could be reported as needing a new sign-in with no way to act on
          // it — the badge appeared and no button ever did.
          onRelogin={(accountId) => void poolAction('relogin', accountId)}
          onSetStrategy={(strategy) => void setStrategy(strategy)}
          // Quota follows the account, so the host reports each account's own
          // newest snapshot and the card draws it inside that account's row.
          showQuota
        />
      )}

      {status?.checkin != null ? (
        <section className="dsha-group">
          <div className="dsha-grouphead">
            <h3>{t('dailyCheckin')}</h3>
          </div>
          <p className="dsha-muted">{t('checkinHint')}</p>
          <div className="dsha-row" style={{ marginBottom: 8 }}>
            <span className="dsha-label" style={{ fontWeight: 600 }}>{t('checkinAuto')}</span>
            <input
              type="checkbox"
              checked={status.checkin.enabled}
              disabled={busy !== null}
              onChange={(event) => void setCheckinEnabled(event.currentTarget.checked)}
            />
          </div>
          <div className="dsha-row">
            <span className="dsha-label">{t('dailyCheckin')}</span>
            <span className="dsha-value">
              {t('checkinToday').replace('{done}', String(status.checkin.doneToday)).replace('{total}', String(status.checkin.totalAccounts))}
              {status.checkin.skippedToday > 0
                ? ` · ${t('checkinSkipped').replace('{count}', String(status.checkin.skippedToday))}`
                : ''}
              {status.checkin.failedToday > 0
                ? ` · ${t('checkinFailed').replace('{count}', String(status.checkin.failedToday))}`
                : ''}
              {status.checkin.streakDays !== undefined
                ? ` · ${t('checkinStreak').replace('{days}', String(status.checkin.streakDays))}`
                : ''}
              {status.checkin.claimedPoints !== undefined
                ? ` · ${t('checkinClaimed').replace('{points}', String(status.checkin.claimedPoints))}`
                : ''}
              {` · ${status.checkin.lastRunAt === null ? t('checkinNever') : t('checkinLastRun').replace('{time}', formatDate(status.checkin.lastRunAt))}`}
            </span>
          </div>
          <div className="dsha-actions">
            <button className="dsha-btn" disabled={busy !== null} onClick={() => void runCheckinNow()}>
              {busy === 'checkin' ? t('checkinRunning') : t('checkinNow')}
            </button>
          </div>
        </section>
      ) : null}

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t('account')}</h3>
          <span className="dsha-value">{authenticated ? t('signedIn') : t('signedOut')}</span>
        </div>

        {authenticated && (
          <>
            <div className="dsha-row">
              <span className="dsha-label">{t('accountLabel')}</span>
              <span className="dsha-value">{account?.label !== undefined && account.label !== '' ? account.label : t('unknown')}</span>
            </div>
            {account?.id !== undefined && account.id !== '' && (
              <div className="dsha-row">
                <span className="dsha-label">{t('accountId')}</span>
                <span className="dsha-value dshm-mono">{account.id}</span>
              </div>
            )}
            {account?.email !== undefined && account.email !== '' && (
              <div className="dsha-row">
                <span className="dsha-label">{t('email')}</span>
                <span className="dsha-value">{account.email}</span>
              </div>
            )}
            <div className="dsha-row">
              <span className="dsha-label">{t('expiresAt')}</span>
              <span className="dsha-value">
                {formatDate(account?.expiresAtMs)}
                {hours === null
                  ? ` · ${t('expiresExpired')}`
                  : ` · ${t('expiresRemaining').replace('{hours}', hours)}`}
              </span>
            </div>
          </>
        )}

        {status !== null && (
          <>
            <div className="dsha-row">
              <span className="dsha-label">{t('region')}</span>
              <span className="dsha-value">{status.region === 'global' ? t('regionGlobal') : t('regionCn')}</span>
            </div>
            <p className="dsha-notice">{t('expiresHint')}</p>
          </>
        )}

        {flow !== null && (
          <div className="dsha-device-box">
            <strong>{t('deviceCodeSection')}</strong>
            <p className="dsha-muted">{t('deviceCodeHint')}</p>
            <div className="dsha-code-row">
              <span className="dsha-code" aria-label={t('userCode')}>{flow.userCode}</span>
              <button className="dsha-btn" onClick={() => void copyCode()}>
                {copied ? t('copied') : t('copyCode')}
              </button>
            </div>
            {flow.verificationUri !== '' && (
              <a className="dsha-link" href={flow.verificationUri} target="_blank" rel="noreferrer noopener">
                {flow.verificationUri}
              </a>
            )}
            <div className="dsha-row">
              <span className="dsha-label">{t('codeExpires')}</span>
              <span className="dsha-value">
                {t('codeMinutes').replace('{minutes}', String(Math.max(1, Math.round(flow.expiresInSec / 60))))}
              </span>
            </div>
            <p className="dsha-muted">{t('waitingAuthorization')}</p>
            <div className="dsha-actions">
              {flow.verificationUri !== '' && (
                <a className="dsha-btn" href={flow.verificationUri} target="_blank" rel="noreferrer noopener">
                  {t('openSignInPage')}
                </a>
              )}
              <button className="dsha-btn" onClick={() => void cancelLogin()}>
                {t('cancelSignIn')}
              </button>
            </div>
          </div>
        )}

        <div className="dsha-actions">
          {flow === null && !authenticated && (
            <button className="dsha-btn dsha-btn-primary" disabled={busy !== null} onClick={() => void login()}>
              {busy === 'login' ? t('signingIn') : t('signIn')}
            </button>
          )}
          {flow === null && authenticated && (
            // A native sign-in is the desktop app's, so this plugin cannot end it.
            // The button stays (hiding it would leave the user guessing where
            // sign-out went) but is disabled, and the reason is rendered as text
            // below rather than only as a tooltip: a disabled button does not fire
            // the hover events a tooltip needs, so a title alone would leave the
            // control unexplained.
            <button
              className="dsha-btn"
              disabled={busy !== null || status?.ownedByPlugin === false}
              title={status?.ownedByPlugin === false ? t('logoutOwnedByApp') : undefined}
              onClick={() => void logout()}
            >
              {t('signOut')}
            </button>
          )}
        </div>
        {flow === null && authenticated && status?.ownedByPlugin === false && (
          <p className="dsha-muted">{t('logoutOwnedByApp')}</p>
        )}
      </section>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t('connection')}</h3>
        </div>
        {/* The provider id is contended like every sibling line's, so the same
            notice they render is rendered here: a user whose models are served by
            another adapter must be told that, not shown "connected" for a route
            this plugin does not own. */}
        <p className="dsha-notice">
          {status?.serving === false && status.conflict
            ? t('routeConflict').replace('{detail}', status.conflict)
            : t('routeOwned')}
        </p>
        {connectionNotice !== null && <p className="dsha-muted">{connectionNotice}</p>}
        <div className="dsha-actions">
          <button
            className="dsha-btn"
            disabled={busy !== null || !authenticated}
            onClick={() => void testConnection()}
          >
            {busy === 'test' ? t('testingConnection') : t('testConnection')}
          </button>
        </div>
      </section>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t('modelsSection')}</h3>
        </div>
        <p className="dsha-muted">{t('modelsHint').replace('{count}', String(models.length))}</p>
        {models.length === 0
          ? <div className="dsha-empty">{t('modelsUnavailable')}</div>
          : (
            <ModelChecklist
              items={models.map((model: MinimaxCodeModelOption) => ({
                id: model.id,
                name: model.name,
                hint: [
                  thinkingLabel(model.thinking, t),
                  ...(model.description === null || model.description === '' ? [] : [model.description]),
                ].join(' · ') || undefined,
                enabled: model.enabled,
              }))}
              busy={busy !== null}
              onToggle={toggleModel}
              onToggleAll={setAllModels}
              labels={{ selectAll: t('selectAll'), clearAll: t('unselectAll'), list: t('modelsSection') }}
            />
          )}
      </section>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t('enhanced')}</h3>
        </div>
        <div className="dsha-pref-row">
          <div>
            <strong>{t('defaultReasoningEffort')}</strong>
            <p className="dsha-muted">{t('defaultReasoningEffortHint')}</p>
          </div>
          <select
            className="dsha-select"
            aria-label={t('defaultReasoningEffort')}
            value={status?.defaultReasoningEffort ?? ''}
            disabled={busy !== null}
            onChange={(event) => {
              const value = event.currentTarget.value
              void updateEffort(value === '' ? null : (value as MinimaxCodeReasoningEffort))
            }}
          >
            <option value="">{t('defaultEffortAuto')}</option>
            {MINIMAX_CODE_REASONING_EFFORTS.map((effort) => (
              <option key={effort} value={effort}>{effort}</option>
            ))}
          </select>
        </div>
      </section>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t('contextWindowSection')}</h3>
        </div>
        <p className="dsha-muted">{t('contextWindowHint')}</p>
        <ContextWindowEditor
          rows={contextModels.map((model: MinimaxCodeModelOption) => ({
            id: model.id,
            name: model.name,
            draft: contextDrafts[model.id] ?? '',
            meta: model.defaultContextWindow < model.contextWindow
              ? formatCapacity(model.contextWindow)
              : undefined,
            inputLabel: `${model.name} ${t('contextWindowSection')}`,
            hasOverride: status?.contextWindowOverrides[model.id] !== undefined,
            saving: savingModel === model.id,
          }))}
          labels={{
            tokens: t('tokens'),
            save: t('save'),
            saving: t('saving'),
            reset: t('contextWindowReset'),
            resetAll: t('contextWindowResetAll'),
            empty: t('contextWindowNoneEnabled'),
          }}
          busy={busy !== null}
          overrideCount={overrideCount}
          metaClassName="dsha-model-meta"
          onDraftChange={(id, draft) => updateContextDraft(id, draft)}
          onCommit={(id) => void saveContextWindow(id)}
          onReset={(id) => void resetContextWindow(id)}
          onResetAll={() => void resetAllContextWindows()}
        />
      </section>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t('quotaSection')}</h3>
          <button
            className="dsha-btn"
            disabled={busy !== null || !authenticated}
            onClick={() => void refreshQuota()}
          >
            {busy === 'quota' ? t('quotaRefreshing') : t('quotaRefresh')}
          </button>
        </div>
        {/*
          The progress bars moved into each account card: quota follows the
          account, so a bar here could only ever describe whichever account
          happened to be active when the snapshot was read. What stays is what has
          no per-account bar to live in — the plan, each window's name with its
          counts and reset moment, the freshness of this reading, and the stale
          flag — and the note below says which account those facts describe.
        */}
        <p className="dsha-muted">{t('quotaFactsScope')}</p>
        {quota === undefined
          ? (
            // The contract makes quota optional and the usage read is allowed to
            // fail, so the section explains itself rather than rendering an empty
            // meter. The host separates the refusal worth acting on (this
            // sign-in's credential type cannot read usage at all) from an endpoint
            // that merely did not answer, and each gets its own sentence.
            <p className="dsha-notice dshm-quota-note">
              {status?.quotaUnavailable === 'credential-not-accepted'
                ? t('quotaNeedsApiKey')
                : status?.quotaUnavailable === 'unreachable'
                  ? t('quotaUnreachable')
                  : status?.quotaUnavailable === 'token-expired'
                    ? t('quotaTokenExpired')
                    : t('quotaUnavailable')}
            </p>
          )
          : (
            <div className="dsha-quota-card">
              <div className="dsha-quota-title">
                <strong>{quota.label}</strong>
                {quota.usedPercent !== undefined && (
                  <span>{t('quotaUsedShare').replace('{percent}', String(Math.round(quota.usedPercent)))}</span>
                )}
              </div>
              {/* The per-window rows are gone: each window's remaining share, its
                  counts and its reset moment are drawn on the account card that
                  owns the snapshot. The card title above stays because the
                  aggregate share has no per-account home. */}
              {/*
                The last read failed but the host is still serving the numbers that
                last parsed. Showing them WITH that qualification beats the old
                behaviour of replacing a working quota box with a sentence that
                read like a sign-in prompt.
              */}
              {status?.quotaUnavailable === 'stale' && (
                <p className="dsha-notice dshm-quota-note">{t('quotaStale')}</p>
              )}
            </div>
          )}
      </section>

      {error !== null && (
        <div className="dsha-error">
          <div>{error}</div>
        </div>
      )}
    </div>
  )
}
