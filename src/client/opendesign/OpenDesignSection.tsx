import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { AccountPoolSection, formatAccountDate } from '../common/AccountPoolSection.tsx'
import { ContextWindowEditor } from '../common/ContextWindowEditor.tsx'
import { ModelChecklist } from '../common/ModelChecklist.tsx'
import { formatCapacity, parsePositiveCapacity } from '../common/format.ts'
import type { AccountRotationStrategy } from '../../shared/account-pool-contracts.ts'
import {
  OPENDESIGN_CONSOLE_URL,
  type OpenDesignAccountSummaryDto,
  type OpenDesignLoginFlowDto,
  type OpenDesignWebStatus,
} from '../../shared/opendesign-contracts.ts'
import { OpenDesignApi } from './api.ts'
import { zh, NS_OPENDESIGN } from './locales.ts'
import { useLineDict } from '../common/line-locale.ts'

const API = new OpenDesignApi()

interface Props {
  onModelChange?: () => void
  loadModelDirectory?: () => void
}

interface SettingsForm {
  baseURL: string
  defaultContextWindow: string
  defaultMaxTokens: string
  maxConcurrentRequests: string
  streamIdleTimeoutMs: string
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function settingsFormOf(status: OpenDesignWebStatus): SettingsForm {
  return {
    baseURL: status.settings.baseURL,
    defaultContextWindow: String(status.settings.defaultContextWindow),
    defaultMaxTokens: String(status.settings.defaultMaxTokens),
    maxConcurrentRequests: String(status.settings.maxConcurrentRequests),
    streamIdleTimeoutMs: String(status.settings.streamIdleTimeoutMs),
  }
}

/**
 * The OpenDesign tab.
 *
 * The account card, its badges and the rotation picker are the shared
 * {@link AccountPoolSection}, so this line looks like every other provider tab
 * by construction. What is written here is only what is genuinely OpenDesign's:
 * pasting a console-issued API key and the catalog sync. There is deliberately
 * no quota block: the gateway answers an API key no balance, and a card that
 * drew one would be inventing it.
 */
export function OpenDesignSection(props: Props): React.ReactElement {
  const [status, setStatus] = useState<OpenDesignWebStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [key, setKey] = useState('')
  const [alias, setAlias] = useState('')
  const [keyBaseURL, setKeyBaseURL] = useState('')
  const [showKeyForm, setShowKeyForm] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [settingsForm, setSettingsForm] = useState<SettingsForm | null>(null)
  const [loginFlow, setLoginFlow] = useState<OpenDesignLoginFlowDto | null>(null)

  const reload = useCallback(async () => {
    try {
      const next = await API.status()
      setStatus(next)
      // A host from before this field existed must degrade to "settings not
      // editable", not take the whole settings page down.
      setSettingsForm((current) => current ?? (next.settings === undefined ? null : settingsFormOf(next)))
      setError(null)
    } catch (cause) {
      setError(detail(cause))
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

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

  // Drive the device-authorization poll from the card. The host throttles each
  // call to the advertised interval and answers without a network call when the
  // interval has not elapsed.
  useEffect(() => {
    const flow = loginFlow
    if (flow === null || flow.status !== 'pending') return
    const timer = window.setInterval(() => {
      void API.loginStatus(flow.id).then((next) => {
        setLoginFlow(next)
        if (next.status === 'complete') {
          setNotice(zh.loginComplete.replace('{account}', next.accountAlias === '' ? 'OpenDesign' : next.accountAlias))
          setShowKeyForm(false)
          void reload()
        } else if (next.status === 'failed') {
          setError(zh.loginFailed.replace('{detail}', next.error))
        }
      }).catch((cause) => setError(detail(cause)))
    }, Math.max(2, flow.intervalSeconds) * 1000)
    return () => window.clearInterval(timer)
  }, [loginFlow, reload])

  const applyStatus = useCallback((next: OpenDesignWebStatus) => {
    setStatus(next)
    props.onModelChange?.()
    props.loadModelDirectory?.()
  }, [props])

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


  const run = useCallback(async (label: string, action: () => Promise<OpenDesignWebStatus>) => {
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
const refreshUsage = useCallback(() => {
    void run('usage', async () => {
      const outcome = await API.readUsage()
      setNotice(outcome.usage.accounts.some((account) => account.ok) ? '' : zh.usageEmpty)
      return outcome.status
    })
  }, [run])

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
      setNotice(result.authorized
        ? zh.keyTestOk.replace('{ms}', String(Math.round(result.ms))).replace('{count}', String(result.modelCount))
        : zh.keyTestFailed.replace('{detail}', result.error))
    }).catch((cause) => setError(detail(cause))).finally(() => setBusy(null))
  }, [key, keyBaseURL])

  const testStored = useCallback((accountId: string) => {
    setBusy('test:' + accountId)
    setError(null)
    setNotice(null)
    void API.testKey({ accountId }).then((result) => {
      setNotice(result.authorized
        ? zh.keyTestOk.replace('{ms}', String(Math.round(result.ms))).replace('{count}', String(result.modelCount))
        : zh.keyTestFailed.replace('{detail}', result.error))
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
    void run('catalog', async () => {
      const outcome = await API.refreshCatalog()
      setNotice(zh.catalogSyncedNote.replace('{count}', String(outcome.status.catalogCount)))
      return outcome.status
    })
  }, [run])

  const saveSettings = useCallback(() => {
    if (settingsForm === null) return
    const numbers = {
      defaultContextWindow: Number(settingsForm.defaultContextWindow),
      defaultMaxTokens: Number(settingsForm.defaultMaxTokens),
      maxConcurrentRequests: Number(settingsForm.maxConcurrentRequests),
      streamIdleTimeoutMs: Number(settingsForm.streamIdleTimeoutMs),
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

  const t = useLineDict(NS_OPENDESIGN, zh)
  // The server's error detail is appended to the dictionary's own prefix, so the
  // sentence a user reads follows the active locale instead of the shipped one.
  const errorPrefix = t.error.split('{detail}')[0] ?? ''
  const pool = status?.pool
  const accounts: OpenDesignAccountSummaryDto[] = pool?.accounts ?? []
  const models = status?.models ?? []
  const busyAny = busy !== null
  const anyPricing = models.some((model) => model.pricing !== undefined)

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
        <details className="dshod-details">
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
          renderDetails={(account) => {
            const reading = status?.usage?.accounts.find((entry) => entry.accountId === account.id)
            return (
              <>
                <span>{account.authKind === 'oauth' ? t.oauthAccount : t.apiKeyAccount}{account.plan !== undefined && account.plan !== '' ? ` · ${account.plan}` : ''}</span>
                {reading !== undefined && reading.ok && reading.balanceUsd !== null && (
                  <span>{t.usageBalance.replace('{amount}', reading.balanceUsd)}{' · '}{t.usageReadAt.replace('{time}', formatAccountDate(reading.fetchedAt))}</span>
                )}
                {reading !== undefined && !reading.ok && <span>{t.usageUnavailable.replace('{detail}', reading.error)}</span>}
              </>
            )
          }}
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
            <div className="dshod-flow">
              {loginFlow.status === 'pending' && (
                <>
                  <p className="dsha-muted" style={{ fontSize: 12 }}>{t.loginHint}</p>
                  <div className="dshod-login-row">
                    <span className="dshod-login-code" aria-label={t.loginCode}>{loginFlow.userCode}</span>
                    <a className="dsha-btn" href={loginFlow.verificationUri} target="_blank" rel="noreferrer">{t.loginOpen}</a>
                    <button className="dsha-btn" disabled={busyAny} onClick={cancelLogin}>{t.loginCancel}</button>
                  </div>
                  <p className="dsha-muted" style={{ fontSize: 12 }}>{t.loginWaiting}</p>
                </>
              )}
              {loginFlow.status === 'complete' && (
                <p className="dsha-muted" style={{ fontSize: 12 }}>
                  {accounts.length > 0
                    ? t.loginComplete.replace('{account}', loginFlow.accountAlias === '' ? 'OpenDesign' : loginFlow.accountAlias)
                    : t.loginCompleteNoAccount}
                </p>
              )}
              {loginFlow.status === 'failed' && (
                <p className="dshod-warning">{t.loginFailed.replace('{detail}', loginFlow.error)}</p>
              )}
            </div>
          )}
          {(loginFlow === null || loginFlow.status === 'idle' || loginFlow.status === 'cancelled') && (
            <div className="dshod-paste">
              <span className="dsha-muted dshod-paste-note">
                {accounts.length > 0
                  ? t.loginHaveAccounts.replace('{count}', String(accounts.length))
                  : t.loginIdle}
              </span>
            </div>
          )}
          {showKeyForm && (
            <div className="dshod-keyform">
              <label className="dsha-label" htmlFor="opendesign-key">{t.keySection}</label>
              <input
                id="opendesign-key"
                className="dshod-input"
                type="password"
                value={key}
                placeholder={t.keyPlaceholder}
                autoComplete="off"
                onChange={(event) => setKey(event.target.value)}
              />
              <label className="dsha-label" htmlFor="opendesign-alias">{t.keyAliasLabel}</label>
              <input
                id="opendesign-alias"
                className="dshod-input"
                value={alias}
                placeholder={t.keyAliasPlaceholder}
                onChange={(event) => setAlias(event.target.value)}
              />
              <p className="dsha-muted" style={{ fontSize: 12 }}>{t.keyAliasHint}</p>
              <label className="dsha-label" htmlFor="opendesign-baseurl">{t.keyBaseUrlLabel}</label>
              <input
                id="opendesign-baseurl"
                className="dshod-input"
                value={keyBaseURL}
                placeholder={t.keyBaseUrlPlaceholder}
                onChange={(event) => setKeyBaseURL(event.target.value)}
              />
              <p className="dsha-muted" style={{ fontSize: 12 }}>
                {t.keyHint}{' '}
                <a className="dshod-link" href={OPENDESIGN_CONSOLE_URL} target="_blank" rel="noreferrer">{t.keyConsoleLink}</a>
              </p>
              <div className="dshod-keyrow">
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
                  {t.cancel}
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
        {status !== null && models.length === 0 && (
          <div className="dsha-empty">{t.noModels}</div>
        )}
        {status !== null && models.length > 0 && (
          <>
            {!status.catalogSynced && (
              <p className="dsha-muted" style={{ fontSize: 12 }}>{t.catalogNeverSynced}</p>
            )}
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
            {anyPricing && <p className="dsha-muted" style={{ fontSize: 12 }}>{t.pricingNote}</p>}
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
          <h3>{t.usageSection}</h3>
          <button className="dsha-btn" disabled={busyAny} onClick={refreshUsage}>
            {busy === 'usage' ? t.usageRefreshing : t.usageRefresh}
          </button>
        </div>
        <p className="dsha-muted" style={{ fontSize: 12 }}>{t.usageHint}</p>
        {(status?.usage === null || status?.usage === undefined) && <div className="dsha-empty">{t.usageEmpty}</div>}
        {status?.usage !== null && status?.usage !== undefined && (
          <>
            {status.usage.accounts.filter((account) => !account.ok).map((account) => (
              <p className="dshod-warning" key={account.accountId}>
                {account.alias}: {t.usageUnavailable.replace('{detail}', account.error)}
              </p>
            ))}
          </>
        )}
      </section>

      {settingsForm !== null && (
        <section className="dsha-group">
          <div className="dsha-grouphead">
            <h3>{t.advancedSection}</h3>
          </div>
          <div className="dsha-row">
            <label className="dsha-label" htmlFor="opendesign-baseurl-setting">{t.baseURL}</label>
            <input
              id="opendesign-baseurl-setting"
              className="dshod-input dshod-adv-control dshod-adv-mono"
              value={settingsForm.baseURL}
              onChange={(event) => setSettingsForm({ ...settingsForm, baseURL: event.target.value })}
            />
          </div>
          <div className="dsha-row">
            <label className="dsha-label" htmlFor="opendesign-default-window">{t.defaultContextWindow}</label>
            <input
              id="opendesign-default-window"
              className="dshod-input dshod-adv-control dshod-adv-num"
              value={settingsForm.defaultContextWindow}
              onChange={(event) => setSettingsForm({ ...settingsForm, defaultContextWindow: event.target.value })}
            />
          </div>
          <div className="dsha-row">
            <label className="dsha-label" htmlFor="opendesign-default-max">{t.defaultMaxTokens}</label>
            <input
              id="opendesign-default-max"
              className="dshod-input dshod-adv-control dshod-adv-num"
              value={settingsForm.defaultMaxTokens}
              onChange={(event) => setSettingsForm({ ...settingsForm, defaultMaxTokens: event.target.value })}
            />
          </div>
          <div className="dsha-row">
            <label className="dsha-label" htmlFor="opendesign-concurrency">{t.maxConcurrentRequests}</label>
            <input
              id="opendesign-concurrency"
              className="dshod-input dshod-adv-control dshod-adv-num"
              value={settingsForm.maxConcurrentRequests}
              onChange={(event) => setSettingsForm({ ...settingsForm, maxConcurrentRequests: event.target.value })}
            />
          </div>
          <div className="dsha-row">
            <label className="dsha-label" htmlFor="opendesign-idle">{t.streamIdleTimeoutMs}</label>
            <input
              id="opendesign-idle"
              className="dshod-input dshod-adv-control dshod-adv-num"
              value={settingsForm.streamIdleTimeoutMs}
              onChange={(event) => setSettingsForm({ ...settingsForm, streamIdleTimeoutMs: event.target.value })}
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
