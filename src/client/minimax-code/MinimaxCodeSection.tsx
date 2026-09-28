import React, { useCallback, useEffect, useState } from 'react'
import {
  MINIMAX_CODE_PROVIDER_ID,
  MINIMAX_CODE_PROVIDER_NAME,
  type MinimaxCodeAccount,
  type MinimaxCodeCredentialStorage,
  type MinimaxCodeWebLogin,
  type MinimaxCodeWebStatus,
} from '../../shared/minimax-code-contracts.ts'
import { get, messageOf, post } from './api.ts'
import { zh } from './locales.ts'

/** Device-code poll cadence. The host owns the real expiry. */
const LOGIN_POLL_INTERVAL_MS = 2_000

/** `/login/poll` answer, exactly as the frozen route table defines it. */
interface LoginPollResult {
  status: 'pending' | 'authenticated' | 'expired' | 'denied'
  account?: MinimaxCodeAccount
}

/** `/login/start` answer: `{ ok: true, login }` per the frozen route table. */
interface LoginStartResult {
  ok?: boolean
  login?: MinimaxCodeWebLogin
}

/** `/test` answer: `{ ok, model?, error? }` per the frozen route table. */
interface ConnectionTestResult {
  ok?: boolean
  model?: string
  error?: string
}

/**
 * Props this card accepts.
 *
 * Deliberately the same shape every sibling tab declares: the hub hands each tab
 * only the refresh callback. The card does not take the hub's `settings.section`
 * runtime seat or its locale seat, because it renders its own dictionary (see
 * below) and needs none of that scope's other props.
 */
interface Props {
  onModelChange?: () => void
}

/**
 * The keys this card renders.
 *
 * The provider hub hosts every provider tab inside one settings section whose
 * injected `t` seat is bound to the hub's own namespace, and every sibling tab
 * therefore renders its own dictionary instead of that seat (see KimiCodeSection,
 * WorkBuddySection and CommandCodeSection, none of which declare a locale prop).
 * This card must do the same: its keys are not a subset of the hub's, so using the
 * hub's seat resolves the overlap to ChatGPT wording ("使用 ChatGPT 登录" on the
 * MiniMax tab) and every other key to the literal key text.
 */
type Translate = (key: keyof typeof zh) => string

/** The card's own dictionary; stable identity keeps effect dependencies intact. */
const fallbackTranslate: Translate = (key) => zh[key]

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

export function storageLabel(storage: MinimaxCodeCredentialStorage | undefined, t: Translate): string {
  if (storage === undefined) return t('unknown')
  switch (storage.kind) {
    case 'minimax-native': return t('storageNative')
    case 'dpapi': return t('storageDpapi')
    default: return t('storageFile')
  }
}

function formatDate(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return '—'
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(ms)
  } catch {
    return '—'
  }
}

export function MinimaxCodeSection({ onModelChange }: Props): React.JSX.Element {
  const t: Translate = fallbackTranslate
  const [status, setStatus] = useState<MinimaxCodeWebStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [flow, setFlow] = useState<MinimaxCodeWebLogin | null>(null)
  const [copied, setCopied] = useState(false)
  // Result of an explicit connection test. The button used to end silently on
  // success, which is indistinguishable from a click that never registered.
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null)

  const loadStatus = useCallback(async (quiet = false) => {
    if (!quiet) setError(null)
    try {
      setStatus(await get<MinimaxCodeWebStatus>('/status'))
    } catch (cause) {
      if (!quiet) setError(messageOf(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadStatus()
    const refreshWhenVisible = (): void => {
      if (document.visibilityState === 'visible') void loadStatus(true)
    }
    document.addEventListener('visibilitychange', refreshWhenVisible)
    const timer = window.setInterval(refreshWhenVisible, 60_000)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [loadStatus])

  const loginId = flow?.loginId

  // Authorization happens in a browser this card does not control, so the host
  // owns the device-code exchange and the card polls the host for its verdict.
  useEffect(() => {
    if (loginId === undefined) return
    let stopped = false
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const poll = await post<LoginPollResult>('/login/poll', { loginId })
          if (stopped || poll.status === 'pending') return
          stopped = true
          window.clearInterval(timer)
          setFlow(null)
          if (poll.status === 'authenticated') {
            await loadStatus()
            onModelChange?.()
            return
          }
          setError(poll.status === 'expired' ? t('loginExpired') : t('loginDenied'))
        } catch {
          // A failed poll is transient; the next tick retries.
        }
      })()
    }, LOGIN_POLL_INTERVAL_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [loginId, loadStatus, onModelChange, t])

  const handleLogin = async (): Promise<void> => {
    try {
      setBusy('login')
      setError(null)
      setConnectionNotice(null)
      setCopied(false)
      const started = await post<LoginStartResult>('/login/start')
      // `login` is the frozen shape; a host that answers with the login object
      // itself is still read, because the card loses nothing by accepting it.
      const login = started.login ?? (typeof (started as { loginId?: unknown }).loginId === 'string'
        ? started as unknown as MinimaxCodeWebLogin
        : undefined)
      if (login === undefined) {
        setError(t('loginFailed'))
        return
      }
      setFlow(login)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const handleCancelLogin = async (): Promise<void> => {
    const pending = flow
    setFlow(null)
    if (pending === null) return
    try {
      await post('/login/cancel', { loginId: pending.loginId })
    } catch (cause) {
      setError(messageOf(cause))
    }
  }

  const handleCopyCode = async (): Promise<void> => {
    const code = flow?.userCode
    if (code === undefined || code === '') return
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2_000)
    } catch {
      // Clipboard access can be denied; the code stays on screen to copy by hand.
    }
  }

  const handleLogout = async (): Promise<void> => {
    try {
      setBusy('logout')
      setError(null)
      setConnectionNotice(null)
      setFlow(null)
      // The host refuses to sign out a credential the desktop app owns; that
      // refusal is a successful, expected answer rather than an error, so it is
      // surfaced as a notice and the status is re-read either way.
      const result = await post<{ ok?: boolean; native?: boolean; error?: string }>('/logout')
      if (result.native === true) {
        setConnectionNotice(result.error ?? t('logoutOwnedByApp'))
      }
      await loadStatus(true)
      onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
      await loadStatus(true)
    } finally {
      setBusy(null)
    }
  }

  const handleTestConnection = async (): Promise<void> => {
    try {
      setBusy('test')
      setError(null)
      setConnectionNotice(null)
      const result = await post<ConnectionTestResult>('/test')
      if (result.ok === true) {
        setConnectionNotice(result.model === undefined || result.model === ''
          ? t('testSuccess')
          : t('testSuccessModel').replace('{model}', result.model))
        return
      }
      setConnectionNotice(result.error === undefined || result.error === ''
        ? t('testFailed')
        : `${t('testFailed')}：${result.error}`)
    } catch (cause) {
      setConnectionNotice(`${t('testFailed')}：${messageOf(cause)}`)
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return (
      <div className="dsha-page">
        <div className="dsha-empty">{t('loading')}</div>
      </div>
    )
  }

  const authenticated = status?.authenticated === true
  const account = status?.account
  const quota = status?.quota
  const models = status?.models ?? []
  const hours = remainingHours(account?.expiresAtMs)
  const storage = status?.storage

  return (
    <div className="dsha-page">
      <p className="dsha-muted">{t('pageDesc')}</p>

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
            <div className="dsha-row">
              <span className="dsha-label">{t('storage')}</span>
              <span className="dsha-value">{storageLabel(storage, t)}</span>
            </div>
            {storage?.path !== undefined && storage.path !== '' && (
              <div className="dsha-row">
                <span className="dsha-label">{t('storagePath')}</span>
                <span className="dsha-value dshm-mono">{storage.path}</span>
              </div>
            )}
            <p className="dsha-notice">{t('expiresHint')}</p>
          </>
        )}

        {flow !== null && (
          <div className="dsha-device-box">
            <strong>{t('deviceCodeSection')}</strong>
            <p className="dsha-muted">{t('deviceCodeHint')}</p>
            <div className="dsha-code-row">
              <span className="dsha-code" aria-label={t('userCode')}>{flow.userCode}</span>
              <button className="dsha-btn" onClick={() => void handleCopyCode()}>
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
              <button className="dsha-btn" onClick={() => void handleCancelLogin()}>
                {t('cancelSignIn')}
              </button>
            </div>
          </div>
        )}

        <div className="dsha-actions">
          {flow === null && !authenticated && (
            <button className="dsha-btn dsha-btn-primary" disabled={busy !== null} onClick={() => void handleLogin()}>
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
              onClick={() => void handleLogout()}
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
        <div className="dsha-row">
          <span className="dsha-label">{t('provider')}</span>
          <span className="dsha-value">{`${MINIMAX_CODE_PROVIDER_NAME} · ${MINIMAX_CODE_PROVIDER_ID}`}</span>
        </div>
        <div className="dsha-row">
          <span className="dsha-label">{t('connectionState')}</span>
          <span className="dsha-value">{authenticated ? t('connected') : t('untested')}</span>
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
            onClick={() => void handleTestConnection()}
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
            <div className="dshm-model-list">
              {models.map((modelId) => <code key={modelId}>{modelId}</code>)}
            </div>
          )}
      </section>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t('quotaSection')}</h3>
        </div>
        {quota === undefined
          ? (
            // The frozen contract makes quota optional and this line exposes no
            // usage endpoint, so the section says so instead of rendering an
            // empty meter or failing.
            <p className="dsha-notice dshm-quota-note">{t('quotaUnavailable')}</p>
          )
          : (
            <div className="dsha-quota-card">
              <div className="dsha-quota-title">
                <strong>{quota.label}</strong>
                {quota.usedPercent !== undefined && (
                  <span>{t('quotaUsed').replace('{percent}', String(Math.round(quota.usedPercent)))}</span>
                )}
              </div>
              {quota.usedPercent !== undefined && (
                <div className="dsha-meter-wrap">
                  <div className="dsha-meter-label">
                    <span>{quota.label}</span>
                    <strong>{t('quotaRemaining').replace('{percent}', String(Math.max(0, Math.round(100 - quota.usedPercent))))}</strong>
                  </div>
                  <div className={`dsha-meter ${100 - quota.usedPercent <= 10 ? 'dsha-meter-cyan' : 'dsha-meter-green'}`}>
                    <span style={{ width: `${Math.min(100, Math.max(0, Math.round(100 - quota.usedPercent)))}%` }} />
                  </div>
                  {quota.resetsAtMs !== undefined && (
                    <div className="dsha-meter-meta">
                      <span>{t('quotaReset').replace('{time}', formatDate(quota.resetsAtMs))}</span>
                    </div>
                  )}
                </div>
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
