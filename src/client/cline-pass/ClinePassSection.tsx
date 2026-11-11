import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AccountPoolSection } from '../common/AccountPoolSection.tsx'
import { createQuotaFollowUp, type QuotaFollowUp } from '../common/quota-follow-up.ts'
import { ContextWindowEditor } from '../common/ContextWindowEditor.tsx'
import { ModelChecklist } from '../common/ModelChecklist.tsx'
import { formatCapacity, parsePositiveCapacity } from '../common/format.ts'
import type { AccountRotationStrategy } from '../../shared/account-pool-contracts.ts'
import {
  clinePassAccountQuota,
  isClinePassAnonymousUpstream,
  type ClinePassAccountSummaryDto,
  type ClinePassHistoryRowDto,
  type ClinePassLoginFlowDto,
  type ClinePassModelDto,
  type ClinePassTestResultDto,
  type ClinePassWebStatus,
} from '../../shared/cline-pass-contracts.ts'
import { ClinePassApi, quotaRefreshingOf, type ClinePassCatalogSearchItem } from './api.ts'
import { zh, NS_CLINE_PASS } from './locales.ts'
import { useLineDict } from '../common/line-locale.ts'

const API = new ClinePassApi()

/**
 * How often an open card re-reads the quota.
 *
 * The same 60 s every other line's card and composer badge uses: a window that
 * moves on a multi-hour scale does not need a faster poll, and a slower one
 * would leave a card visibly stale after the user spends a request.
 */
const QUOTA_POLL_MS = 60_000

interface Props {
  onModelChange?: () => void
  loadModelDirectory?: () => void
}

interface ModelResult {
  test?: ClinePassTestResultDto
  error?: string
}

interface SettingsForm {
  baseURL: string
  defaultContextWindow: string
  defaultMaxTokens: string
  maxConcurrentRequests: string
  streamIdleTimeoutMs: string
  historyLimit: string
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function settingsFormOf(status: ClinePassWebStatus): SettingsForm {
  return {
    baseURL: status.settings.baseURL,
    defaultContextWindow: String(status.settings.defaultContextWindow),
    defaultMaxTokens: String(status.settings.defaultMaxTokens),
    maxConcurrentRequests: String(status.settings.maxConcurrentRequests),
    streamIdleTimeoutMs: String(status.settings.streamIdleTimeoutMs),
    historyLimit: String(status.settings.historyLimit),
  }
}

/**
 * The Cline Pass tab.
 *
 * The account card, its badges and the rotation picker are the shared
 * {@link AccountPoolSection}, so this line looks like every other provider tab
 * by construction. What is written here is only what is genuinely Cline Pass's:
 * pasting a key, ordinary model tests, the official quota windows and the
 * in-process request history.
 */
export function ClinePassSection(props: Props): React.ReactElement {
  const [status, setStatus] = useState<ClinePassWebStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [key, setKey] = useState('')
  const [alias, setAlias] = useState('')
  const [keyBaseURL, setKeyBaseURL] = useState('')
  const [showKeyForm, setShowKeyForm] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [results, setResults] = useState<Record<string, ModelResult>>({})
  const [settingsForm, setSettingsForm] = useState<SettingsForm | null>(null)
  const [history, setHistory] = useState<{ total: number; entries: ClinePassHistoryRowDto[] } | null>(null)
  const [loginFlow, setLoginFlow] = useState<ClinePassLoginFlowDto | null>(null)
  const [catalogQuery, setCatalogQuery] = useState('')
  const [catalogResults, setCatalogResults] = useState<ClinePassCatalogSearchItem[]>([])
  const [catalogSearched, setCatalogSearched] = useState(false)
  /** Ids the user has already been told are credit-billed; the second click adds them. */
  const [catalogCreditsAck, setCatalogCreditsAck] = useState<Record<string, boolean>>({})

  /** Follow-up poll owed while the host refreshes the quota behind an answer. */
  const quotaFollowUp = useRef<QuotaFollowUp | null>(null)

  /**
   * One status read; `quiet` is every read nobody pressed a button for.
   *
   * A quiet read is silent on purpose: it never paints an error and never clears
   * one, so a poll that fails while a user reads the page, or types into a
   * settings field, does not change what is on screen. The manual actions below
   * still report their own failures loudly. The draft guards inside the two
   * setters are what keep a background answer from overwriting typed text.
   */
  const loadStatus = useCallback(async (quiet = false) => {
    try {
      const next = await API.status()
      setStatus(next)
      // A host from before this field existed must degrade to "settings not
      // editable", not take the whole settings page down.
      setSettingsForm((current) => current ?? (next.settings === undefined ? null : settingsFormOf(next)))
      if (!quiet) setError(null)
      // An answer that refreshed the quota behind itself is followed up shortly,
      // so the fresh numbers land without waiting for the next poll.
      quotaFollowUp.current ??= createQuotaFollowUp()
      quotaFollowUp.current.observe(quotaRefreshingOf(next), () => { void loadStatus(true) })
    } catch (cause) {
      // Best-effort: see the note above. The next tick, a manual refresh or the
      // composer badge is still there to surface a genuinely broken host.
      if (!quiet) setError(detail(cause))
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  // Keep an open card current without making the user press anything. The poll
  // only ticks while the tab is visible — a hidden tab has nobody to show the
  // numbers to — and switching back is itself a reason to read, since the tab
  // may have been hidden for hours. `loadStatus` is stable, so this interval is
  // never torn down by a re-render.
  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void loadStatus(true)
    }
    document.addEventListener('visibilitychange', refreshWhenVisible)
    const timer = window.setInterval(refreshWhenVisible, QUOTA_POLL_MS)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      quotaFollowUp.current?.cancel()
    }
  }, [loadStatus])

  // Seed a draft per model without overwriting one the user is typing into: a
  // status refresh after an unrelated action must not reset a half-typed value.
  useEffect(() => {
    if (status === null) return
    setDrafts((current) => {
      let changed = false
      const next = { ...current }
      for (const model of status.models) {
        if (!model.enabled || next[model.id] !== undefined) continue
        next[model.id] = formatCapacity(model.contextWindow)
        changed = true
      }
      return changed ? next : current
    })
  }, [status])

  // A pending flow lives on the host, so reopening the card resumes it; a newer
  // flow id always wins, and a terminal local state is never overwritten by an
  // older status snapshot.
  useEffect(() => {
    const incoming = status?.login
    if (incoming === undefined || incoming === null) return
    setLoginFlow((current) => (
      current !== null && current.id === incoming.id && current.status !== 'pending'
        ? current
        : incoming
    ))
  }, [status])

  // Drive the device-code poll from the card. The host throttles each call to
  // WorkOS's advertised interval and answers without a network call when the
  // interval has not elapsed.
  useEffect(() => {
    const flow = loginFlow
    if (flow === null || flow.status !== 'pending') return
    const timer = window.setInterval(() => {
      void API.loginStatus(flow.id).then((next) => {
        setLoginFlow(next)
        if (next.status === 'complete') {
          setNotice(zh.loginComplete.replace('{account}', next.accountAlias === '' ? 'Cline Pass' : next.accountAlias))
          setShowKeyForm(false)
          void loadStatus()
        } else if (next.status === 'failed') {
          setError(zh.loginFailed.replace('{detail}', next.error))
        }
      }).catch((cause) => setError(detail(cause)))
    }, Math.max(2, flow.intervalSeconds) * 1000)
    return () => window.clearInterval(timer)
  }, [loginFlow, loadStatus])

  const startLogin = useCallback(() => {
    setBusy('login')
    setError(null)
    setNotice(null)
    void API.startLogin().then((flow) => {
      setLoginFlow(flow)
      if (flow.verificationUri !== '' && typeof window !== 'undefined' && typeof window.open === 'function') {
        try {
          window.open(flow.verificationUri, '_blank', 'noopener,noreferrer')
        } catch {
          // The link is also rendered in the pending block for manual click.
        }
      }
    }).catch((cause) => setError(detail(cause))).finally(() => setBusy(null))
  }, [])

  const cancelLogin = useCallback(() => {
    if (loginFlow === null) return
    void API.cancelLogin(loginFlow.id).then(() => {
      setLoginFlow({ ...loginFlow, status: 'cancelled' })
    }).catch((cause) => setError(detail(cause)))
  }, [loginFlow])

  const applyStatus = useCallback((next: ClinePassWebStatus) => {
    setStatus(next)
    props.onModelChange?.()
    props.loadModelDirectory?.()
  }, [props])

  const run = useCallback(async (label: string, action: () => Promise<ClinePassWebStatus>) => {
    setBusy(label)
    setError(null)
    setNotice(null)
    try {
      const next = await action()
      applyStatus(next)
    } catch (cause) {
      setError(detail(cause))
    } finally {
      setBusy(null)
    }
  }, [applyStatus])

  const addKey = useCallback(() => {
    const trimmed = key.trim()
    if (trimmed === '') return
    void run('add', async () => {
      const next = await API.accountAction('add', {
        apiKey: trimmed,
        ...(alias.trim() === '' ? {} : { alias: alias.trim() }),
        ...(keyBaseURL.trim() === '' ? {} : { baseURL: keyBaseURL.trim() }),
      })
      setKey('')
      setAlias('')
      setKeyBaseURL('')
      setShowKeyForm(false)
      return next
    })
  }, [key, alias, keyBaseURL, run])

  const testTypedKey = useCallback(() => {
    const trimmed = key.trim()
    if (trimmed === '') return
    setBusy('test-key')
    setError(null)
    setNotice(null)
    void API.testKey({
      apiKey: trimmed,
      ...(keyBaseURL.trim() === '' ? {} : { baseURL: keyBaseURL.trim() }),
    }).then((result) => {
      setNotice(result.authorized ? zh.keyTestOk.replace('{ms}', String(Math.round(result.ms))) : zh.keyTestFailed.replace('{detail}', result.error))
    }).catch((cause) => setError(detail(cause))).finally(() => setBusy(null))
  }, [key, keyBaseURL])

  const testStored = useCallback((accountId: string) => {
    setBusy('test:' + accountId)
    setError(null)
    setNotice(null)
    void API.testKey({ accountId }).then((result) => {
      setNotice(result.authorized ? zh.keyTestOk.replace('{ms}', String(Math.round(result.ms))) : zh.keyTestFailed.replace('{detail}', result.error))
    }).catch((cause) => setError(detail(cause))).finally(() => setBusy(null))
  }, [])

  const enabledModels = useMemo(() => (status?.models ?? []).filter((model) => model.enabled), [status])
  const allModels = status?.models ?? []
  const enabledCount = enabledModels.length

  const toggleModel = useCallback((id: string, checked: boolean) => {
    if (status === null) return
    const current = status.models.filter((model) => model.enabled).map((model) => model.id)
    const next = checked ? [...new Set([...current, id])] : current.filter((entry) => entry !== id)
    void run('models', async () => {
      // Re-enabling a model also clears a visibility hide, or the checkbox would
      // look checked while no picker offers it.
      if (checked) await API.setVisibility(id, true)
      return await API.setEnabledModels(next.length === status.models.length ? null : next)
    })
  }, [status, run])

  const setAllModels = useCallback((selectAll: boolean) => {
    void run('models', async () => {
      // "Select all" also clears every hide, or a model hidden earlier would stay
      // out of the picker while the checklist says it is selected.
      if (selectAll) await API.setVisibilityAll('all')
      return await API.setEnabledModels(selectAll ? null : [])
    })
  }, [run])

  const commitContext = useCallback((id: string) => {
    const model = status?.models.find((entry) => entry.id === id)
    if (model === undefined) return
    const parsed = parsePositiveCapacity(drafts[id] ?? formatCapacity(model.contextWindow))
    if (parsed === null) {
      setError(zh.error.replace('{detail}', zh.defaultContextWindow))
      return
    }
    void run('ctx:' + id, () => API.setContextWindow(id, parsed))
  }, [status, drafts, run])

  const resetContext = useCallback((id: string) => {
    const fallback = status?.models.find((entry) => entry.id === id)?.defaultContextWindow
    void run('ctx:' + id, async () => {
      const next = await API.setContextWindow(id, null)
      if (fallback !== undefined) setDrafts((current) => ({ ...current, [id]: formatCapacity(fallback) }))
      return next
    })
  }, [run, status])

  const resetAllContext = useCallback(() => {
    if (status === null) return
    if (typeof window !== 'undefined' && !window.confirm(zh.contextResetAll)) return
    const overridden = status.models.filter((model) => model.contextWindowOverride !== undefined)
    void run('ctx-all', async () => {
      let next = status
      for (const model of overridden) next = await API.setContextWindow(model.id, null)
      setDrafts((current) => {
        const draftsNext = { ...current }
        for (const model of overridden) draftsNext[model.id] = formatCapacity(model.defaultContextWindow)
        return draftsNext
      })
      return next
    })
  }, [status, run])

  const refreshCatalog = useCallback(() => {
    void run('catalog', async () => (await API.refreshCatalog()).status)
  }, [run])

  const searchCatalog = useCallback(() => {
    const query = catalogQuery.trim()
    if (query === '') return
    setBusy('catalog-search')
    setError(null)
    void API.searchCatalog(query).then((outcome) => {
      setCatalogResults(outcome.results)
      setCatalogSearched(true)
      setCatalogCreditsAck({})
    }).catch((cause) => setError(detail(cause))).finally(() => setBusy(null))
  }, [catalogQuery])

  const addCatalogModel = useCallback((id: string, acknowledgeBilling = false) => {
    setBusy('catalog-add:' + id)
    setError(null)
    void API.addCatalogModel(id, acknowledgeBilling).then((outcome) => {
      applyStatus(outcome.status)
      setCatalogResults((current) => current.map((entry) => entry.id === id ? { ...entry, added: true } : entry))
    }).catch((cause) => setError(detail(cause))).finally(() => setBusy(null))
  }, [applyStatus])

  const refreshUsage = useCallback(() => {
    void run('usage', async () => {
      const outcome = await API.readUsage()
      setNotice(outcome.usage.accounts.some((account) => account.ok) ? '' : zh.usageEmpty)
      return outcome.status
    })
  }, [run])

  const loadHistory = useCallback(() => {
    setBusy('history')
    setError(null)
    void API.history(50).then(setHistory).catch((cause) => setError(detail(cause))).finally(() => setBusy(null))
  }, [])

  const saveSettings = useCallback(() => {
    if (settingsForm === null) return
    const numbers = {
      defaultContextWindow: Number(settingsForm.defaultContextWindow),
      defaultMaxTokens: Number(settingsForm.defaultMaxTokens),
      maxConcurrentRequests: Number(settingsForm.maxConcurrentRequests),
      streamIdleTimeoutMs: Number(settingsForm.streamIdleTimeoutMs),
      historyLimit: Number(settingsForm.historyLimit),
    }
    const invalid = Object.entries(numbers).find(([, value]) => !Number.isSafeInteger(value) || value < 0)
    if (invalid !== undefined) {
      setError(zh.error.replace('{detail}', invalid[0]))
      return
    }
    setBusy('settings')
    setError(null)
    void API.updateSettings({
      baseURL: settingsForm.baseURL,
      ...numbers,
    }).then((next) => {
      applyStatus(next)
      setSettingsForm(settingsFormOf(next))
      setNotice(zh.saved)
    }).catch((cause) => setError(detail(cause))).finally(() => setBusy(null))
  }, [settingsForm, applyStatus])

  const toggleTools = useCallback(() => {
    if (status === null) return
    const value = !status.exposeTools
    setBusy('tools')
    setError(null)
    void API.updateSettings({ exposeTools: value }).then((next) => {
      applyStatus(next)
      setSettingsForm(settingsFormOf(next))
      setNotice(zh.restartRequired)
    }).catch((cause) => setError(detail(cause))).finally(() => setBusy(null))
  }, [status, applyStatus])

  const t = useLineDict(NS_CLINE_PASS, zh)
  // Prefix of the server-error sentence, resolved through the active locale.
  const errorPrefix = t.error.split('{detail}')[0] ?? ''
  const pool = status?.pool
  const accounts = useMemo((): ClinePassAccountSummaryDto[] => {
    const raw = pool?.accounts ?? []
    const usageByAccount = new Map((status?.usage?.accounts ?? []).map((entry) => [entry.accountId, entry]))
    return raw.map((account) => {
      const quota = account.quota ?? clinePassAccountQuota(usageByAccount.get(account.id))
      return quota === undefined ? account : { ...account, quota }
    })
  }, [pool, status?.usage])
  const models = status?.models ?? []
  const busyAny = busy !== null

  return (
    <div className="dsha-page">
      <p className="dsha-muted">{t.pageDesc}</p>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.title}</h3>
        </div>
        <p className="dsha-muted" style={{ fontSize: 12 }}>
          {status?.serving === false && status.conflict !== null
            ? t.routeConflict.replace('{detail}', status.conflict)
            : t.routeOwned}
        </p>
        {error !== null && <p className="dsha-notice" style={{ color: 'var(--dsha-danger, #c0392b)' }}>{errorPrefix}{error}</p>}
        {notice !== null && notice !== '' && <p className="dsha-notice">{notice}</p>}
        <details className="dshcp-details">
          <summary>{t.limitsSection}</summary>
          <ul>
            <li>{t.limitKey}</li>
            <li>{t.limitGateway}</li>
            <li>{t.limitRoute}</li>
            <li>{t.limitQuota}</li>
          </ul>
        </details>
      </section>

      {pool !== undefined && (
        <AccountPoolSection
          accounts={accounts}
          activeAccountId={pool.activeAccountId}
          rotationStrategy={pool.rotationStrategy}
          labels={t}
          busy={busy}
          showQuota
          onLogin={startLogin}
          loginBusyLabel={t.loggingIn}
          onRelogin={startLogin}
          onSetPrimary={(id) => void run('set-primary', () => API.accountAction('set-primary', { accountId: id }))}
          onDelete={(id) => void run('delete', () => API.accountAction('delete', { accountId: id }))}
          onClearCooldown={(id) => void run('clear-cooldown', () => API.accountAction('clear-cooldown', { accountId: id }))}
          onSetStrategy={(strategy: AccountRotationStrategy) => void run('strategy', () => API.accountAction('strategy', { strategy }))}
          renderAccountActions={(account) => (
            <button
              className="dsha-btn"
              disabled={busyAny}
              onClick={() => testStored(account.id)}
            >
              {busy === 'test:' + account.id ? t.keyTesting : t.testSavedKey}
            </button>
          )}
          renderDetails={(account) => (
            <span>{account.authKind === 'oauth' ? t.oauthAccount : t.apiKeyAccount}</span>
          )}
          renderLoginActions={() => (
            <div className="dsha-account-add-actions" style={{ display: 'flex', gap: 8 }}>
              <button
                className="dsha-btn dsha-btn-primary"
                disabled={busyAny || loginFlow?.status === 'pending'}
                onClick={startLogin}
              >
                {busy === 'login' || loginFlow?.status === 'pending' ? t.loggingIn : t.login}
              </button>
              <button className="dsha-btn" disabled={busyAny} onClick={() => setShowKeyForm((value) => !value)}>
                {t.useApiKey}
              </button>
            </div>
          )}
        >
          {loginFlow !== null && loginFlow.status !== 'idle' && loginFlow.status !== 'cancelled' && (
            <div className="dshcp-flow">
              {loginFlow.status === 'pending' && (
                <>
                  <p className="dsha-muted" style={{ fontSize: 12 }}>{t.loginHint}</p>
                  <div className="dshcp-login-row">
                    <span className="dshcp-login-code" aria-label={t.loginCode}>{loginFlow.userCode}</span>
                    <a className="dsha-btn" href={loginFlow.verificationUri} target="_blank" rel="noreferrer">{t.loginOpen}</a>
                    <button className="dsha-btn" disabled={busyAny} onClick={cancelLogin}>{t.loginCancel}</button>
                  </div>
                  <p className="dsha-muted" style={{ fontSize: 12 }}>{t.loginWaiting}</p>
                </>
              )}
              {loginFlow.status === 'complete' && (
                <p className="dsha-muted" style={{ fontSize: 12 }}>
                  {accounts.length > 0
                    ? t.loginComplete.replace('{account}', loginFlow.accountAlias === '' ? 'Cline Pass' : loginFlow.accountAlias)
                    : t.loginCompleteNoAccount}
                </p>
              )}
              {loginFlow.status === 'failed' && (
                <p className="dshcp-warning">{t.loginFailed.replace('{detail}', loginFlow.error)}</p>
              )}
            </div>
          )}
          {(loginFlow === null || loginFlow.status === 'idle' || loginFlow.status === 'cancelled') && (
            <div className="dshcp-paste">
              <span className="dsha-muted dshcp-paste-note">
                {accounts.length > 0
                  ? t.loginHaveAccounts.replace('{count}', String(accounts.length))
                  : t.loginIdle}
              </span>
            </div>
          )}
          {showKeyForm && (
            <div className="dshcp-keyform">
              <label className="dsha-label" htmlFor="cline-pass-key">{t.keySection}</label>
              <input
                id="cline-pass-key"
                className="dsha-input"
                type="password"
                value={key}
                placeholder={t.keyPlaceholder}
                autoComplete="off"
                onChange={(event) => setKey(event.target.value)}
              />
              <label className="dsha-label" htmlFor="cline-pass-alias">{t.keyAliasLabel}</label>
              <input
                id="cline-pass-alias"
                className="dsha-input"
                value={alias}
                placeholder={t.keyAliasPlaceholder}
                onChange={(event) => setAlias(event.target.value)}
              />
              <p className="dsha-muted" style={{ fontSize: 12 }}>{t.keyAliasHint}</p>
              <label className="dsha-label" htmlFor="cline-pass-baseurl">{t.keyBaseUrlLabel}</label>
              <input
                id="cline-pass-baseurl"
                className="dsha-input"
                value={keyBaseURL}
                placeholder={t.keyBaseUrlPlaceholder}
                onChange={(event) => setKeyBaseURL(event.target.value)}
              />
              <p className="dsha-muted" style={{ fontSize: 12 }}>{t.keyHint}</p>
              <div className="dshcp-keyrow">
                <button
                  className="dsha-btn dsha-btn-primary"
                  disabled={busyAny || key.trim() === ''}
                  onClick={addKey}
                >
                  {busy === 'add' ? t.keySaving : t.keySave}
                </button>
                <button className="dsha-btn" disabled={busyAny || key.trim() === ''} onClick={testTypedKey}>
                  {busy === 'test-key' ? t.keyTesting : t.keyTest}
                </button>
                <button className="dsha-btn" disabled={busyAny} onClick={() => setShowKeyForm(false)}>
                  {t.cancel ?? 'Cancel'}
                </button>
              </div>
            </div>
          )}
        </AccountPoolSection>
      )}

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.modelsSection}</h3>
          <button className="dsha-btn" disabled={busyAny} onClick={refreshCatalog}>
            {busy === 'catalog' ? t.catalogSyncing : t.catalogSync}
          </button>
        </div>
        <p className="dsha-muted" style={{ fontSize: 12 }}>{t.modelsHint}</p>
        <form
          className="dshcp-search-row"
          onSubmit={(event) => {
            event.preventDefault()
            searchCatalog()
          }}
        >
          <input
            className="dsha-input"
            style={{ flex: 1, minWidth: 240 }}
            value={catalogQuery}
            placeholder={t.catalogSearchPlaceholder}
            disabled={busyAny}
            onChange={(event) => setCatalogQuery(event.target.value)}
          />
          <button className="dsha-btn" type="submit" disabled={busyAny || catalogQuery.trim() === ''}>
            {busy === 'catalog-search' ? t.catalogSearching : t.catalogSearch}
          </button>
        </form>
        <p className="dsha-muted" style={{ fontSize: 12 }}>{t.catalogSearchHint}</p>
        {catalogSearched && catalogResults.length === 0 && busy !== 'catalog-search' && (
          <p className="dsha-muted" style={{ fontSize: 12 }}>{t.catalogSearchEmpty}</p>
        )}
        {catalogResults.length > 0 && (
          <div className="dshcp-channels">
            {catalogResults.map((entry) => {
              const acknowledged = catalogCreditsAck[entry.id] === true
              return (
                <span className="dshcp-channel" key={entry.id} data-added={entry.added} title={entry.id}>
                  {entry.id}
                  <span className="dsha-muted" style={{ fontSize: 11 }}>
                    {entry.billing === 'credits' ? t.catalogBillingCredits : t.catalogBillingSubscription}
                  </span>
                  {entry.billing === 'credits' && !entry.added && acknowledged && (
                    <span className="dsha-muted" style={{ fontSize: 11 }}>{t.catalogCreditsWarning}</span>
                  )}
                  <button
                    type="button"
                    className="dshcp-exclude"
                    disabled={busyAny || entry.added}
                    onClick={() => {
                      // A marketplace id spends the Credits balance, so the
                      // first click only explains that; the second one adds it.
                      if (entry.billing === 'credits' && !acknowledged) {
                        setCatalogCreditsAck((current) => ({ ...current, [entry.id]: true }))
                        return
                      }
                      addCatalogModel(entry.id, entry.billing === 'credits')
                    }}
                  >
                    {entry.added
                      ? t.catalogAdded
                      : busy === 'catalog-add:' + entry.id
                        ? '…'
                        : entry.billing === 'credits' && !acknowledged
                          ? t.catalogAdd
                          : entry.billing === 'credits'
                            ? t.catalogAddCredits
                            : t.catalogAdd}
                  </button>
                </span>
              )
            })}
          </div>
        )}
        {status !== null && models.length === 0 && (
          <div className="dsha-empty">{status.catalogSynced ? t.catalogEmpty : t.catalogNeverSynced}</div>
        )}
        {status !== null && models.length > 0 && (
          <>
            <ModelChecklist
              items={models.map((model) => ({
                id: model.id,
                name: model.name,
                hint: model.hint ?? `${formatCapacity(model.contextWindow)} · ${model.input.join('+')}${model.reasoning ? ' · reasoning' : ''}`,
                enabled: model.enabled,
              }))}
              busy={busyAny}
              onToggle={(id, enabled) => toggleModel(id, enabled)}
              onToggleAll={(enabled) => setAllModels(enabled)}
              labels={{ selectAll: t.selectAll, clearAll: t.unselectAll, countTemplate: t.modelChecklistCount, list: t.modelsSection }}
            />
            {enabledCount === 0 && <p className="dsha-muted" style={{ fontSize: 12 }}>{t.noModels}</p>}
          </>
        )}
      </section>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.contextSection}</h3>
        </div>
        <p className="dsha-muted" style={{ fontSize: 12 }}>{t.contextHint}</p>
        <ContextWindowEditor
          rows={enabledModels.map((model) => ({
            id: model.id,
            name: model.name,
            draft: drafts[model.id] ?? formatCapacity(model.contextWindow),
            ...(model.contextWindowOverride === undefined ? {} : { meta: `· ${t.contextOverridden}` }),
            hasOverride: model.contextWindowOverride !== undefined,
            saving: busy === 'ctx:' + model.id,
          }))}
          labels={{
            tokens: t.tokens,
            save: t.contextSave,
            saving: t.contextSaving,
            reset: t.contextReset,
            resetAll: t.contextResetAll,
            empty: t.contextEmpty,
          }}
          busy={busyAny}
          overrideCount={models.filter((model) => model.contextWindowOverride !== undefined).length}
          onDraftChange={(id, value) => setDrafts((current) => ({ ...current, [id]: value }))}
          onCommit={commitContext}
          onReset={resetContext}
          onResetAll={resetAllContext}
        />
      </section>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.testSection}</h3>
        </div>
        <p className="dsha-muted" style={{ fontSize: 12 }}>{t.testHint}</p>
        {enabledModels.length === 0 && <div className="dsha-empty">{t.noModels}</div>}
        {enabledModels.map((model) => (
          <details className="dshcp-model" key={model.id}>
            <summary>
              <span className="dshcp-model-name" title={model.id}>{model.name}</span>
              <span className="dshcp-pill">{model.pipeline === '' ? '—' : model.pipeline}</span>
            </summary>
            <ModelTestPanel
              model={model}
              result={results[model.id] ?? {}}
              busy={busy}
              t={t}
              onTest={() => {
                setBusy('test-model:' + model.id)
                setError(null)
                void API.test(model.id).then((outcome) => {
                  applyStatus(outcome.status)
                  setResults((current) => ({ ...current, [model.id]: { test: outcome.result } }))
                }).catch((cause) => setResults((current) => ({ ...current, [model.id]: { error: detail(cause) } }))).finally(() => setBusy(null))
              }}
            />
          </details>
        ))}
      </section>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.usageSection}</h3>
          <button className="dsha-btn" disabled={busyAny} onClick={refreshUsage}>
            {busy === 'usage' ? t.usageRefreshing : t.usageRefresh}
          </button>
        </div>
        <p className="dsha-muted" style={{ fontSize: 12 }}>{t.usageHint}</p>
        {status?.usage === null && <div className="dsha-empty">{t.usageEmpty}</div>}
        {status?.usage !== null && status?.usage !== undefined && (
          <>
            <p className="dsha-muted" style={{ fontSize: 12 }}>{t.quotaFactsScope}</p>
            {status.usage.accounts.filter((account) => !account.ok).map((account) => (
              <p className="dshcp-warning" key={account.accountId}>
                {account.alias}: {t.usageUnavailable.replace('{detail}', account.error)}
              </p>
            ))}
          </>
        )}
      </section>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.historySection}</h3>
          <button className="dsha-btn" disabled={busyAny} onClick={loadHistory}>
            {t.historyRefresh}
          </button>
        </div>
        <p className="dsha-muted" style={{ fontSize: 12 }}>{t.historyHint}</p>
        {history === null && <div className="dsha-empty">{t.historyEmpty}</div>}
        {history !== null && history.entries.length === 0 && <div className="dsha-empty">{t.historyEmpty}</div>}
        {history !== null && history.entries.length > 0 && (
          <>
            <p className="dsha-muted" style={{ fontSize: 12 }}>
              {t.historyCount.replace('{count}', String(history.entries.length)).replace('{total}', String(history.total))}
            </p>
            <div className="dshcp-history">
              <div className="dshcp-history-row dshcp-history-head">
                <span>{t.historyModel}</span>
                <span>{t.historyAccount}</span>
                <span>{t.historyLatency}</span>
                <span>{t.historyTokens}</span>
              </div>
              {history.entries.map((entry, index) => (
                <div className="dshcp-history-row" key={`${entry.ts}-${index}`}>
                  <span className="dshcp-history-cell" title={entry.model}>{entry.model.replace(/^cline-pass\//, '')}</span>
                  <span className="dshcp-history-cell" title={entry.account}>{entry.account || '—'}</span>
                  <span className="dshcp-history-cell">
                    {entry.ttft > 0 ? `${entry.ttft} / ${entry.ms}ms` : `— / ${entry.ms}ms`}
                  </span>
                  <span className="dshcp-history-cell">
                    {entry.usageReported ? `${entry.usage.inputTokens} / ${entry.usage.outputTokens}` : '—'}
                  </span>
                  {entry.error !== '' && (
                    <span className="dshcp-history-error" title={entry.error}>
                      {t.historyError}: {entry.error}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      {settingsForm !== null && (
        <section className="dsha-group">
          <div className="dsha-grouphead">
            <h3>{t.advancedSection}</h3>
          </div>
          <div className="dsha-row">
            <label className="dsha-label" htmlFor="cline-pass-baseurl-setting">{t.baseURL}</label>
            <input
              id="cline-pass-baseurl-setting"
              className="dsha-input dshcp-adv-control dshcp-adv-mono"
              value={settingsForm.baseURL}
              onChange={(event) => setSettingsForm({ ...settingsForm, baseURL: event.target.value })}
            />
          </div>
          <div className="dsha-row">
            <label className="dsha-label" htmlFor="cline-pass-default-window">{t.defaultContextWindow}</label>
            <input
              id="cline-pass-default-window"
              className="dsha-input dshcp-adv-control dshcp-adv-num"
              value={settingsForm.defaultContextWindow}
              onChange={(event) => setSettingsForm({ ...settingsForm, defaultContextWindow: event.target.value })}
            />
          </div>
          <div className="dsha-row">
            <label className="dsha-label" htmlFor="cline-pass-default-max">{t.defaultMaxTokens}</label>
            <input
              id="cline-pass-default-max"
              className="dsha-input dshcp-adv-control dshcp-adv-num"
              value={settingsForm.defaultMaxTokens}
              onChange={(event) => setSettingsForm({ ...settingsForm, defaultMaxTokens: event.target.value })}
            />
          </div>
          <div className="dsha-row">
            <label className="dsha-label" htmlFor="cline-pass-concurrency">{t.maxConcurrentRequests}</label>
            <input
              id="cline-pass-concurrency"
              className="dsha-input dshcp-adv-control dshcp-adv-num"
              value={settingsForm.maxConcurrentRequests}
              onChange={(event) => setSettingsForm({ ...settingsForm, maxConcurrentRequests: event.target.value })}
            />
          </div>
          <div className="dsha-row">
            <label className="dsha-label" htmlFor="cline-pass-idle">{t.streamIdleTimeoutMs}</label>
            <input
              id="cline-pass-idle"
              className="dsha-input dshcp-adv-control dshcp-adv-num"
              value={settingsForm.streamIdleTimeoutMs}
              onChange={(event) => setSettingsForm({ ...settingsForm, streamIdleTimeoutMs: event.target.value })}
            />
          </div>
          <div className="dsha-row">
            <label className="dsha-label" htmlFor="cline-pass-history-limit">{t.historyLimit}</label>
            <input
              id="cline-pass-history-limit"
              className="dsha-input dshcp-adv-control dshcp-adv-num"
              value={settingsForm.historyLimit}
              onChange={(event) => setSettingsForm({ ...settingsForm, historyLimit: event.target.value })}
            />
          </div>
          <div className="dsha-pref-row">
            <div>
              <strong>{t.exposeTools}</strong>
              <p className="dsha-muted" style={{ fontSize: 12, marginTop: 2 }}>{t.exposeToolsHint}</p>
            </div>
            <input
              className="dshcp-check"
              type="checkbox"
              aria-label={t.exposeTools}
              checked={status?.exposeTools === true}
              disabled={busyAny}
              onChange={toggleTools}
            />
          </div>
          <div className="dsha-actions">
            <button className="dsha-btn dsha-btn-primary" disabled={busyAny} onClick={saveSettings}>
              {busy === 'settings' ? t.savingSettings : t.saveSettings}
            </button>
          </div>
        </section>
      )}
    </div>
  )
}

interface ModelTestPanelProps {
  model: ClinePassModelDto
  result: ModelResult
  busy: string | null
  t: typeof zh
  onTest(): void
}

/** Observed routing facts and one ordinary model test; no routing controls. */
function ModelTestPanel(props: ModelTestPanelProps): React.ReactElement {
  const { model, result, t } = props
  return (
    <div className="dshcp-body">
      <p className="dshcp-meta">
        {t.pipeline.replace('{pipeline}', model.pipeline === '' ? '—' : model.pipeline)}
        {model.lastProvider !== '' ? ` · ${t.lastServed.replace('{provider}', model.lastProvider).replace('{ms}', String(model.lastMs))}` : ''}
        {isClinePassAnonymousUpstream(model.lastProvider) ? ` · ⚠ ${t.anonymousChannel}` : ''}
      </p>
      <div className="dshcp-actions">
        <button className="dsha-btn" disabled={props.busy !== null} onClick={props.onTest}>
          {props.busy === 'test-model:' + model.id ? t.testingModel : t.testModel}
        </button>
      </div>
      {result.test !== undefined && (
        <div>
          <p className={result.test.ok ? 'dshcp-meta' : 'dshcp-warning'}>
            {result.test.ok
              ? t.testServed.replace('{provider}', result.test.actual || '—').replace('{ms}', String(result.test.ms))
              : t.testFailed.replace('{detail}', result.test.error)}
          </p>
          {result.test.anonymous && (
            <p className="dshcp-warning">{t.anonymousServed.replace('{provider}', result.test.actual || 'openai-compatible-private')}</p>
          )}
          {result.test.fingerprint !== '' && (
            <p className="dshcp-meta">{t.fingerprintOk.replace('{fingerprint}', result.test.fingerprint)}</p>
          )}
          {result.test.warnings.map((warning) => <p className="dshcp-warning" key={warning}>{warning}</p>)}
        </div>
      )}
      {result.error !== undefined && <p className="dshcp-warning">{result.error}</p>}
    </div>
  )
}
