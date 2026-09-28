import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  MINIMAX_CODE_PROVIDER_ID,
  MINIMAX_CODE_PROVIDER_NAME,
  type MinimaxCodeAccount,
  type MinimaxCodeCredentialStorage,
  type MinimaxCodeWebLogin,
  type MinimaxCodeWebStatus,
} from '../../shared/minimax-code-contracts.ts'
import {
  MINIMAX_CODE_REASONING_EFFORTS,
  type MinimaxCodeModelOption,
  type MinimaxCodeQuotaWindow,
  type MinimaxCodeReasoningEffort,
} from '../../shared/minimax-code-contracts.ts'
import { AccountPoolSection, type AccountPoolLabels } from '../common/AccountPoolSection.tsx'
import type {
  AccountPoolStatusDto,
  AccountRotationStrategy,
} from '../../shared/account-pool-contracts.ts'
import { get, messageOf, post } from './api.ts'
import { zh } from './locales.ts'

/** The pool slice the status card renders, absent when the line has no pool. */
type MinimaxCodePoolStatus = Pick<AccountPoolStatusDto, 'accounts' | 'rotationStrategy'> & {
  activeAccountId?: string
}

/**
 * The shared pool card's labels, resolved through this card's dictionary.
 *
 * The sibling tabs hand the shared card their raw `zh` object, which works because
 * they render `zh` directly. This card renders through a translate function
 * instead, so the same label set is assembled here by looking each key up. It is
 * derived from the shared ZH label object's own keys, so a label added to the
 * shared card cannot be silently missed — the `satisfies` below turns that into a
 * compile error.
 */
function accountPoolLabelsFor(t: (key: keyof typeof zh) => string): AccountPoolLabels {
  return {
    accountPool: t('accountPool'),
    addAccount: t('addAccount'),
    accountCount: t('accountCount'),
    primaryAccount: t('primaryAccount'),
    activeAccount: t('activeAccount'),
    setPrimary: t('setPrimary'),
    deleteAccount: t('deleteAccount'),
    cooling: t('cooling'),
    cooldownLeft: t('cooldownLeft'),
    clearCooldown: t('clearCooldown'),
    needsRelogin: t('needsRelogin'),
    relogin: t('relogin'),
    rotationStrategy: t('rotationStrategy'),
    strategySequential: t('strategySequential'),
    strategyRoundRobin: t('strategyRoundRobin'),
    strategySticky: t('strategySticky'),
    noAccounts: t('noAccounts'),
    storage: t('storage'),
    storageNotice: t('storageNotice'),
    email: t('email'),
    expires: t('expiresAt'),
    lastUsed: t('lastUsed'),
    accountId: t('accountId'),
  }
}

/** Device-code poll cadence. The host owns the real expiry. */
const LOGIN_POLL_INTERVAL_MS = 2_000

/**
 * Parse "1M", "512K", "200000" into a positive integer token count.
 *
 * Every provider card carries its own copy of this pair rather than importing one
 * from a shared module; the value is user input in a free-text field and a bad
 * parse silently corrupts the overflow judgement, so it stays next to the only
 * field that produces it.
 */
export function parsePositiveCapacity(value: string): number | null {
  const normalized = value.trim().toLowerCase().replace(/[,_\s]/g, '')
  const matched = normalized.match(/^(\d+(?:\.\d+)?)(k|m)?$/)
  if (matched === null) return null
  const multiplier = matched[2] === 'm' ? 1_000_000 : matched[2] === 'k' ? 1_000 : 1
  const parsed = Number(matched[1]) * multiplier
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null
}

/** Render a token capacity the way the capacity field seeds itself. */
export function formatCapacity(value: number): string {
  if (value >= 1_000_000 && value % 100_000 === 0) return `${value / 1_000_000}M`
  if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}K`
  return String(value)
}

/**
 * Seed one draft per model from a status payload.
 *
 * Run after a model toggle too: a model that was just enabled has no draft yet,
 * and the context-window section only renders enabled models.
 */
function contextDraftsFor(status: MinimaxCodeWebStatus): Record<string, string> {
  const drafts: Record<string, string> = {}
  for (const model of status.models) {
    drafts[model.id] = formatCapacity(status.contextWindowOverrides[model.id] || model.defaultContextWindow)
  }
  return drafts
}

/** Human label per thinking mode, so the card states what the model does. */
function thinkingLabel(mode: MinimaxCodeModelOption['thinking'], t: Translate): string {
  if (mode === 'always-on') return t('thinkingAlwaysOn')
  if (mode === 'forced-effort') return t('thinkingForced')
  return t('thinkingToggle')
}

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
  // Free-text context-window drafts, keyed by model id, so a half-typed value
  // does not round-trip to the host on every keystroke.
  const [contextDrafts, setContextDrafts] = useState<Record<string, string>>({})
  const [savingModel, setSavingModel] = useState<string | null>(null)
  // The pool slice, read beside the status. Absent until the first read answers,
  // and absent for a host that has no pool installed at all.
  const [pool, setPool] = useState<MinimaxCodePoolStatus | undefined>(undefined)

  const loadStatus = useCallback(async (quiet = false) => {
    if (!quiet) setError(null)
    try {
      const next = await get<MinimaxCodeWebStatus>('/status')
      setStatus(next)
      setContextDrafts(contextDraftsFor(next))
    } catch (cause) {
      if (!quiet) setError(messageOf(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadStatus()
    void loadPool()
    const refreshWhenVisible = (): void => {
      if (document.visibilityState === 'visible') {
        void loadStatus(true)
        void loadPool()
      }
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

  /**
   * Fetch the usage snapshot once, the first time the card sees a signed-in
   * account without one.
   *
   * The status route refreshes usage BEHIND its answer, so it never blocks on a
   * network read; that means the very first paint has no snapshot. Asking here
   * fills the section immediately instead of leaving it empty for a whole poll
   * interval. A failure is silent on purpose: the section already explains that no
   * usage is available, and a usage read must never surface as an error banner.
   */
  // Declared here rather than beside the render values because the effect below
  // needs it and hooks must all run before the loading early-return.
  const authenticated = status?.authenticated === true
  const quotaRequested = useRef(false)
  useEffect(() => {
    if (quotaRequested.current || !authenticated || status?.quota !== undefined) return
    quotaRequested.current = true
    void (async () => {
      try {
        setStatus(await post<MinimaxCodeWebStatus>('/quota'))
      } catch {
        // Silent by design - see above.
      }
    })()
  }, [authenticated, status?.quota])

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

  /**
   * Apply one model-selection patch through `/models`.
   *
   * The host owns the selection and answers with the whole fresh status, so the
   * card never guesses which ids ended up enabled.
   */
  /** Re-read the pool slice, which lives beside the status on its own route. */
  const loadPool = useCallback(async (): Promise<void> => {
    try {
      const next = await get<MinimaxCodePoolStatus>('/accounts')
      setPool(next)
    } catch {
      // A host without a pool answers with an error here; the section simply does
      // not render rather than reporting a failure the user cannot act on.
      setPool(undefined)
    }
  }, [])

  /** Run one account action, then re-read both the pool and the status. */
  const poolAction = async (action: string, accountId: string): Promise<void> => {
    try {
      setBusy(action)
      setError(null)
      await post('/accounts', { action, accountId })
      await loadPool()
      await loadStatus(true)
      onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const poolSetStrategy = async (strategy: AccountRotationStrategy): Promise<void> => {
    try {
      setBusy('strategy')
      setError(null)
      await post('/accounts', { action: 'strategy', strategy })
      await loadPool()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const applyEnabled = async (enabledModelIds: string[]): Promise<void> => {
    try {
      setError(null)
      const updated = await post<MinimaxCodeWebStatus>('/models', { enabledModelIds })
      setStatus(updated)
      // A model that was just checked has no draft yet; the context-window
      // section only renders enabled models.
      setContextDrafts(contextDraftsFor(updated))
      onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
    }
  }

  /**
   * Flip the line's own switch.
   *
   * Optimistic on purpose: the checkbox is the one control whose state the user
   * is looking straight at, and a failed round trip re-reads the truth below
   * rather than leaving the box in a state the host never accepted.
   */
  const toggleEnabled = async (enabled: boolean): Promise<void> => {
    setStatus((prev) => (prev === null ? prev : { ...prev, enabled }))
    try {
      setError(null)
      const updated = await post<MinimaxCodeWebStatus>('/settings', { enabled })
      setStatus(updated)
      onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
      await loadStatus(true)
    }
  }

  const toggleModel = (modelId: string, checked: boolean): void => {
    if (status === null) return
    const current = status.models.filter((model) => model.enabled).map((model) => model.id)
    const next = checked ? [...new Set([...current, modelId])] : current.filter((id) => id !== modelId)
    void applyEnabled(next)
  }

  const setAllModels = (selectAll: boolean): void => {
    if (status === null || status.models.length === 0) return
    void applyEnabled(selectAll ? status.models.map((model) => model.id) : [])
  }

  const handleUpdateEffort = async (effort: MinimaxCodeReasoningEffort | null): Promise<void> => {
    try {
      setError(null)
      const updated = await post<MinimaxCodeWebStatus>('/settings', { defaultReasoningEffort: effort })
      setStatus(updated)
      onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
    }
  }

  const handleSaveContextWindow = async (modelId: string): Promise<void> => {
    const raw = contextDrafts[modelId] ?? ''
    const parsed = parsePositiveCapacity(raw)
    if (parsed === null) {
      setError(t('invalidCapacity').replace('{value}', raw))
      return
    }
    try {
      setSavingModel(modelId)
      setError(null)
      const updated = await post<MinimaxCodeWebStatus>('/settings', { contextWindowOverrides: { [modelId]: parsed } })
      setStatus(updated)
      setContextDrafts((prev) => ({ ...prev, [modelId]: formatCapacity(parsed) }))
      onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setSavingModel(null)
    }
  }

  const handleResetContextWindow = async (modelId: string): Promise<void> => {
    try {
      setSavingModel(modelId)
      setError(null)
      // `null` is the wire spelling of "drop this override": the host deletes the
      // key so the catalog default applies again.
      const updated = await post<MinimaxCodeWebStatus>('/settings', { contextWindowOverrides: { [modelId]: null } })
      setStatus(updated)
      const model = updated.models.find((entry) => entry.id === modelId)
      if (model !== undefined) {
        setContextDrafts((prev) => ({ ...prev, [modelId]: formatCapacity(model.defaultContextWindow) }))
      }
      onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setSavingModel(null)
    }
  }

  const handleResetAllContextWindows = async (): Promise<void> => {
    const ids = Object.keys(status?.contextWindowOverrides ?? {})
    if (ids.length === 0) return
    try {
      setError(null)
      const updated = await post<MinimaxCodeWebStatus>('/settings', {
        contextWindowOverrides: Object.fromEntries(ids.map((id) => [id, null])),
      })
      setStatus(updated)
      setContextDrafts(contextDraftsFor(updated))
      onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
    }
  }

  /** Force one usage read through `/quota` and render the fresh status. */
  const handleRefreshQuota = async (): Promise<void> => {
    try {
      setBusy('quota')
      setError(null)
      setStatus(await post<MinimaxCodeWebStatus>('/quota'))
    } catch (cause) {
      setError(messageOf(cause))
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

  const account = status?.account
  const quota = status?.quota
  const models = status?.models ?? []
  const hours = remainingHours(account?.expiresAtMs)
  const storage = status?.storage
  // Only enabled models have a context window to override: an unchecked model is
  // not offered to a conversation, so a capacity for it would be dead settings.
  const contextModels = status?.models.filter((model) => model.enabled) ?? []
  const overrideCount = Object.keys(status?.contextWindowOverrides ?? {}).length
  // One row per quota window. The host reports both the 5-hour and the weekly
  // window; the single-figure fallback keeps a host that only reports one -
  // or a snapshot cached from an older build - renderable instead of blank.
  const quotaWindows: MinimaxCodeQuotaWindow[] = quota?.windows
    ?? (quota === undefined || quota.usedPercent === undefined
      ? []
      : [{
          key: 'interval',
          remainingPercent: Math.max(0, 100 - quota.usedPercent),
          usedPercent: quota.usedPercent,
          ...(quota.resetsAtMs === undefined ? {} : { resetsAtMs: quota.resetsAtMs }),
        }])

  return (
    <div className="dsha-page">
      <p className="dsha-muted">{t('pageDesc')}</p>

      {pool !== undefined && (
        <AccountPoolSection
          labels={accountPoolLabelsFor(t)}
          accounts={pool.accounts}
          rotationStrategy={pool.rotationStrategy}
          {...(pool.activeAccountId === undefined ? {} : { activeAccountId: pool.activeAccountId })}
          busy={busy}
          storageValue={storageLabel(status?.storage, t)}
          onLogin={() => void handleLogin()}
          onSetPrimary={(accountId) => void poolAction('set-primary', accountId)}
          onDelete={(accountId) => void poolAction('delete', accountId)}
          onClearCooldown={(accountId) => void poolAction('clear-cooldown', accountId)}
          onSetStrategy={(strategy) => void poolSetStrategy(strategy)}
        />
      )}

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
        {/* The line's own switch, first in the group like every sibling card: it is
            the control that decides whether any of the models below are offered. */}
        <div className="dsha-row" style={{ marginBottom: 12 }}>
          <span className="dsha-label" style={{ fontWeight: 600 }}>{t('enableProvider')}</span>
          <input
            type="checkbox"
            aria-label={t('enableProvider')}
            checked={status?.enabled !== false}
            disabled={busy !== null}
            onChange={(event) => void toggleEnabled(event.currentTarget.checked)}
          />
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
            <>
              <div className="dsha-models" aria-label={t('modelsSection')}>
                {models.map((model: MinimaxCodeModelOption) => {
                  // The tooltip carries what the row cannot: the exact wire id,
                  // how thinking behaves, and the input the model accepts.
                  const facts = [
                    model.id,
                    thinkingLabel(model.thinking, t),
                    ...(model.description === null || model.description === '' ? [] : [model.description]),
                  ]
                  return (
                    <label key={model.id} title={facts.join(' · ')}>
                      <input
                        type="checkbox"
                        checked={model.enabled}
                        disabled={busy !== null}
                        onChange={(event) => toggleModel(model.id, event.currentTarget.checked)}
                      />
                      <span>{model.name}</span>
                    </label>
                  )
                })}
              </div>
              <div className="dsha-actions">
                <button className="dsha-btn" disabled={busy !== null} onClick={() => setAllModels(true)}>
                  {t('selectAll')}
                </button>
                <button className="dsha-btn" disabled={busy !== null} onClick={() => setAllModels(false)}>
                  {t('unselectAll')}
                </button>
              </div>
            </>
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
              void handleUpdateEffort(value === '' ? null : (value as MinimaxCodeReasoningEffort))
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
        <div className="dsha-context-settings">
          {contextModels.length === 0 && <p className="dsha-muted">{t('contextWindowNoneEnabled')}</p>}
          {contextModels.map((model: MinimaxCodeModelOption) => (
            <div key={model.id} className="dsha-context-row">
              <span title={model.id}>
                {model.name}
                {model.defaultContextWindow < model.contextWindow && (
                  <span className="dsha-model-meta">{formatCapacity(model.contextWindow)}</span>
                )}
              </span>
              <div className="dsha-capacity-control">
                <input
                  type="text"
                  aria-label={model.name + ' ' + t('contextWindowSection')}
                  value={contextDrafts[model.id] ?? ''}
                  onChange={(event) => setContextDrafts({ ...contextDrafts, [model.id]: event.currentTarget.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void handleSaveContextWindow(model.id)
                  }}
                />
                <small>{t('tokens')}</small>
                <button
                  type="button"
                  className="dsha-context-save"
                  disabled={savingModel === model.id}
                  onClick={() => void handleSaveContextWindow(model.id)}
                >
                  {savingModel === model.id ? t('saving') : t('save')}
                </button>
                <button
                  type="button"
                  className="dsha-context-save dsha-context-reset"
                  aria-label={model.name + ' ' + t('contextWindowReset')}
                  disabled={savingModel === model.id || status?.contextWindowOverrides[model.id] === undefined}
                  onClick={() => void handleResetContextWindow(model.id)}
                >
                  {t('contextWindowReset')}
                </button>
              </div>
            </div>
          ))}
          <div className="dsha-actions">
            <button
              className="dsha-btn"
              disabled={busy !== null || overrideCount === 0}
              onClick={() => void handleResetAllContextWindows()}
            >
              {t('contextWindowResetAll')}
            </button>
          </div>
        </div>
      </section>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t('quotaSection')}</h3>
          <button
            className="dsha-btn"
            disabled={busy !== null || !authenticated}
            onClick={() => void handleRefreshQuota()}
          >
            {busy === 'quota' ? t('quotaRefreshing') : t('quotaRefresh')}
          </button>
        </div>
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
                  : t('quotaUnavailable')}
            </p>
          )
          : (
            <div className="dsha-quota-card">
              <div className="dsha-quota-title">
                <strong>{quota.label}</strong>
                {quota.usedPercent !== undefined && (
                  <span>{t('quotaUsed').replace('{percent}', String(Math.round(quota.usedPercent)))}</span>
                )}
              </div>
              {quotaWindows.map((window) => {
                // `remainingPercent` is null for a window the service reports as
                // unlimited and for one it gave no usable figures for; the two are
                // labelled differently because only the first is good news.
                const remaining = window.remainingPercent
                const label = window.key === 'weekly' ? t('quotaWindowWeekly') : t('quotaWindowInterval')
                return (
                  <div className="dsha-meter-wrap" key={window.key}>
                    <div className="dsha-meter-label">
                      <span>{label}</span>
                      <strong>
                        {window.unlimited === true
                          ? t('quotaUnlimited')
                          : remaining === null
                            ? t('unknown')
                            : t('quotaRemaining').replace('{percent}', String(Math.max(0, Math.round(remaining))))}
                      </strong>
                    </div>
                    <div className={`dsha-meter ${(remaining ?? 100) <= 10 ? 'dsha-meter-cyan' : 'dsha-meter-green'}`}>
                      <span style={{ width: `${Math.min(100, Math.max(0, Math.round(remaining ?? 100)))}%` }} />
                    </div>
                    <div className="dsha-meter-meta">
                      {window.used !== undefined && window.total !== undefined && (
                        <span>
                          {t('quotaCounts')
                            .replace('{used}', window.used.toLocaleString())
                            .replace('{total}', window.total.toLocaleString())}
                        </span>
                      )}
                      {window.resetsAtMs !== undefined && (
                        <span>{t('quotaReset').replace('{time}', formatDate(window.resetsAtMs))}</span>
                      )}
                    </div>
                  </div>
                )
              })}
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
