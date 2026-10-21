import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { AccountPoolSection } from '../common/AccountPoolSection.tsx'
import { ContextWindowEditor } from '../common/ContextWindowEditor.tsx'
import { ModelChecklist } from '../common/ModelChecklist.tsx'
import { formatCapacity, formatDate, parsePositiveCapacity } from '../common/format.ts'
import type { AccountRotationStrategy } from '../../shared/account-pool-contracts.ts'
import {
  clinePassAccountQuota,
  type ClinePassAccountSummaryDto,
  type ClinePassHistoryRowDto,
  type ClinePassLoginFlowDto,
  type ClinePassModelDto,
  type ClinePassProbeResultDto,
  type ClinePassTestResultDto,
  type ClinePassValidateResultDto,
  type ClinePassWebStatus,
} from '../../shared/cline-pass-contracts.ts'
import { ClinePassApi } from './api.ts'
import { zh, NS_CLINE_PASS } from './locales.ts'
import { useLineDict } from '../common/line-locale.ts'

const API = new ClinePassApi()

interface Props {
  onModelChange?: () => void
  loadModelDirectory?: () => void
}

interface PinDraft {
  upstreams: string[]
  exclude: string[]
  pinMode: 'strict' | 'preferred'
  sort: string
}

interface ModelResult {
  probe?: ClinePassProbeResultDto
  validate?: ClinePassValidateResultDto
  test?: ClinePassTestResultDto
  pinWarnings?: string[]
  error?: string
}

interface SettingsForm {
  baseURL: string
  defaultContextWindow: string
  defaultMaxTokens: string
  maxConcurrentRequests: string
  streamIdleTimeoutMs: string
  historyLimit: string
  exposeCatalog: boolean
  pinSpelling: string
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function statusTone(status: string): 'neutral' | 'ok' | 'warn' | 'danger' {
  if (status === 'ok') return 'ok'
  if (status === 'limited') return 'warn'
  if (status === 'bad' || status === 'auth') return 'danger'
  return 'neutral'
}

function settingsFormOf(status: ClinePassWebStatus): SettingsForm {
  return {
    baseURL: status.settings.baseURL,
    defaultContextWindow: String(status.settings.defaultContextWindow),
    defaultMaxTokens: String(status.settings.defaultMaxTokens),
    maxConcurrentRequests: String(status.settings.maxConcurrentRequests),
    streamIdleTimeoutMs: String(status.settings.streamIdleTimeoutMs),
    historyLimit: String(status.settings.historyLimit),
    exposeCatalog: status.settings.exposeCatalog,
    pinSpelling: status.settings.pinSpelling,
  }
}

/**
 * The Cline Pass tab.
 *
 * The account card, its badges and the rotation picker are the shared
 * {@link AccountPoolSection}, so this line looks like every other provider tab
 * by construction. What is written here is only what is genuinely Cline Pass's:
 * pasting a key, the upstream channel panel, the official quota windows and the
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
  const [pinDrafts, setPinDrafts] = useState<Record<string, PinDraft>>({})
  const [results, setResults] = useState<Record<string, ModelResult>>({})
  const [settingsForm, setSettingsForm] = useState<SettingsForm | null>(null)
  const [history, setHistory] = useState<{ total: number; entries: ClinePassHistoryRowDto[] } | null>(null)
  const [loginFlow, setLoginFlow] = useState<ClinePassLoginFlowDto | null>(null)

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
          void reload()
        } else if (next.status === 'failed') {
          setError(zh.loginFailed.replace('{detail}', next.error))
        }
      }).catch((cause) => setError(detail(cause)))
    }, Math.max(2, flow.intervalSeconds) * 1000)
    return () => window.clearInterval(timer)
  }, [loginFlow, reload])

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
      exposeCatalog: settingsForm.exposeCatalog,
      pinSpelling: settingsForm.pinSpelling,
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

  const pinDraftFor = useCallback((model: ClinePassModelDto): PinDraft => pinDrafts[model.id] ?? {
    upstreams: [...model.pinned],
    exclude: [...model.excluded],
    pinMode: model.pinMode,
    sort: model.sort,
  }, [pinDrafts])

  const editPin = useCallback((model: ClinePassModelDto, patch: Partial<PinDraft>) => {
    setPinDrafts((current) => ({
      ...current,
      [model.id]: { ...(current[model.id] ?? pinDraftFor(model)), ...patch },
    }))
  }, [pinDraftFor])

  const savePin = useCallback((model: ClinePassModelDto) => {
    const draft = pinDraftFor(model)
    setBusy('pin:' + model.id)
    setError(null)
    void API.pinModel(model.id, draft).then((outcome) => {
      applyStatus(outcome.status)
      setPinDrafts((current) => {
        const next = { ...current }
        delete next[model.id]
        return next
      })
      setResults((current) => ({ ...current, [model.id]: { ...current[model.id], pinWarnings: outcome.warnings } }))
    }).catch((cause) => setError(detail(cause))).finally(() => setBusy(null))
  }, [pinDraftFor, applyStatus])

  const resetPin = useCallback((model: ClinePassModelDto) => {
    setBusy('pin:' + model.id)
    setError(null)
    void API.resetPin(model.id).then((outcome) => {
      applyStatus(outcome.status)
      setPinDrafts((current) => {
        const next = { ...current }
        delete next[model.id]
        return next
      })
      setResults((current) => ({ ...current, [model.id]: {} }))
    }).catch((cause) => setError(detail(cause))).finally(() => setBusy(null))
  }, [applyStatus])

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
          <h3>{t.routingSection}</h3>
        </div>
        <p className="dsha-muted" style={{ fontSize: 12 }}>{t.routingHint}</p>
        {enabledModels.length === 0 && <div className="dsha-empty">{t.noModels}</div>}
        {enabledModels.map((model) => (
          <details className="dshcp-model" key={model.id}>
            <summary>
              <span className="dshcp-model-name" title={model.id}>{model.name}</span>
              <span className="dshcp-pill">{model.pipeline === '' ? '—' : model.pipeline}</span>
              <span className="dshcp-pill" data-tone={model.pinned.length > 0 ? 'ok' : 'neutral'}>
                {model.pinned.length === 0 ? t.pinAuto : `${t.pinPinned.replace('{list}', model.pinned.join(' > '))}`}
              </span>
              {model.excluded.length > 0 && <span className="dshcp-pill" data-tone="warn">{t.pinExcluded.replace('{list}', model.excluded.join(', '))}</span>}
            </summary>
            <ChannelEditor
              model={model}
              draft={pinDraftFor(model)}
              result={results[model.id] ?? {}}
              busy={busy}
              t={t}
              onToggleChannel={(upstream) => {
                const draft = pinDraftFor(model)
                editPin(model, {
                  upstreams: draft.upstreams.includes(upstream)
                    ? draft.upstreams.filter((name) => name !== upstream)
                    : [...draft.upstreams, upstream],
                  exclude: draft.exclude.filter((name) => name !== upstream),
                })
              }}
              onToggleExclude={(upstream) => {
                const draft = pinDraftFor(model)
                editPin(model, {
                  exclude: draft.exclude.includes(upstream)
                    ? draft.exclude.filter((name) => name !== upstream)
                    : [...draft.exclude, upstream],
                  upstreams: draft.upstreams.filter((name) => name !== upstream),
                })
              }}
              onPinMode={(pinMode) => editPin(model, { pinMode })}
              onSort={(sort) => editPin(model, { sort })}
              onProbe={() => {
                setBusy('probe:' + model.id)
                setError(null)
                void API.probe(model.id).then((outcome) => {
                  applyStatus(outcome.status)
                  setResults((current) => ({ ...current, [model.id]: { ...current[model.id], probe: outcome.result } }))
                }).catch((cause) => setResults((current) => ({ ...current, [model.id]: { ...current[model.id], error: detail(cause) } }))).finally(() => setBusy(null))
              }}
              onValidate={() => {
                setBusy('validate:' + model.id)
                setError(null)
                void API.validate(model.id).then((outcome) => {
                  applyStatus(outcome.status)
                  setResults((current) => ({ ...current, [model.id]: { ...current[model.id], validate: outcome.result } }))
                }).catch((cause) => setResults((current) => ({ ...current, [model.id]: { ...current[model.id], error: detail(cause) } }))).finally(() => setBusy(null))
              }}
              onTest={() => {
                const draft = pinDraftFor(model)
                setBusy('test-model:' + model.id)
                setError(null)
                void API.test(model.id, {
                  ...(draft.upstreams.length === 0 ? {} : { upstreams: draft.upstreams }),
                  ...(draft.exclude.length === 0 ? {} : { exclude: draft.exclude }),
                }).then((outcome) => {
                  applyStatus(outcome.status)
                  setResults((current) => ({ ...current, [model.id]: { ...current[model.id], test: outcome.result } }))
                }).catch((cause) => setResults((current) => ({ ...current, [model.id]: { ...current[model.id], error: detail(cause) } }))).finally(() => setBusy(null))
              }}
              onSave={() => savePin(model)}
              onReset={() => resetPin(model)}
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
              <label htmlFor="cline-pass-pin-spelling"><strong>{t.pinSpelling}</strong></label>
              <p className="dsha-muted" style={{ fontSize: 12, marginTop: 2 }}>{t.pinSpellingHint}</p>
            </div>
            <select
              id="cline-pass-pin-spelling"
              className="dsha-select dshcp-adv-control"
              value={settingsForm.pinSpelling}
              onChange={(event) => setSettingsForm({ ...settingsForm, pinSpelling: event.target.value })}
            >
              <option value="both">{t.pinSpellingBoth}</option>
              <option value="detected">{t.pinSpellingDetected}</option>
            </select>
          </div>
          <div className="dsha-pref-row">
            <div>
              <label htmlFor="cline-pass-expose-catalog"><strong>{t.exposeCatalog}</strong></label>
              <p className="dsha-muted" style={{ fontSize: 12, marginTop: 2 }}>{t.exposeCatalogHint}</p>
            </div>
            <input
              id="cline-pass-expose-catalog"
              className="dshcp-check"
              type="checkbox"
              checked={settingsForm.exposeCatalog}
              onChange={(event) => setSettingsForm({ ...settingsForm, exposeCatalog: event.target.checked })}
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

interface ChannelEditorProps {
  model: ClinePassModelDto
  draft: PinDraft
  result: ModelResult
  busy: string | null
  t: typeof zh
  onToggleChannel(upstream: string): void
  onToggleExclude(upstream: string): void
  onPinMode(mode: 'strict' | 'preferred'): void
  onSort(sort: string): void
  onProbe(): void
  onValidate(): void
  onTest(): void
  onSave(): void
  onReset(): void
}

/** The per-model channel panel: probe, pin order, exclusions and a real test. */
function ChannelEditor(props: ChannelEditorProps): React.ReactElement {
  const { model, draft, result, t } = props
  const busyAny = props.busy !== null
  const verdicts = new Map(model.upstreamStatus.map((entry) => [entry.upstream, entry]))
  // Configured names that the last probe did not discover are still shown: a pin
  // the gateway silently drops is exactly what this panel exists to expose.
  const channels = [...new Set([...model.upstreams, ...draft.upstreams, ...draft.exclude])]
  return (
    <div className="dshcp-body">
      <p className="dshcp-meta">
        {t.pipeline.replace('{pipeline}', model.pipeline === '' ? '—' : model.pipeline)}
        {model.pinnable ? '' : ` · ${t.notPinnable}`}
        {model.lastProvider !== '' ? ` · ${t.lastServed.replace('{provider}', model.lastProvider).replace('{ms}', String(model.lastMs))}` : ''}
        {model.probedAt > 0 ? ` · ${t.probedAt.replace('{time}', formatDate(model.probedAt))}` : ''}
      </p>
      {channels.length === 0 && <p className="dsha-muted" style={{ fontSize: 12 }}>{t.noChannels}</p>}
      {channels.length > 0 && (
        <>
          <p className="dsha-muted" style={{ fontSize: 12 }}>{t.channelHint}</p>
          <div className="dshcp-channels">
            {channels.map((upstream) => {
              const verdict = verdicts.get(upstream)
              const pinned = draft.upstreams.includes(upstream)
              const excluded = draft.exclude.includes(upstream)
              return (
                <span
                  key={upstream}
                  className="dshcp-channel"
                  data-pinned={pinned}
                  data-excluded={excluded}
                  data-status={verdict?.status ?? 'unknown'}
                  role="button"
                  tabIndex={0}
                  title={verdict === undefined ? upstream : `${upstream}: ${verdict.status}${verdict.note === '' ? '' : ` — ${verdict.note}`}`}
                  onClick={() => props.onToggleChannel(upstream)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') props.onToggleChannel(upstream)
                  }}
                >
                  {upstream}
                  <button
                    type="button"
                    className="dshcp-exclude"
                    aria-label={`${excluded ? 'include' : 'exclude'} ${upstream}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      props.onToggleExclude(upstream)
                    }}
                  >
                    ⊘
                  </button>
                </span>
              )
            })}
          </div>
        </>
      )}
      <div className="dshcp-pin-row">
        <label>
          {t.pinMode}
          <select
            className="dsha-select"
            value={draft.pinMode}
            disabled={busyAny}
            onChange={(event) => props.onPinMode(event.target.value === 'preferred' ? 'preferred' : 'strict')}
          >
            <option value="strict">{t.modeStrict}</option>
            <option value="preferred">{t.modePreferred}</option>
          </select>
        </label>
        <label>
          {t.sort}
          <select
            className="dsha-select"
            value={draft.sort === '' ? 'none' : draft.sort}
            disabled={busyAny}
            onChange={(event) => props.onSort(event.target.value === 'none' ? '' : event.target.value)}
          >
            <option value="none">{t.sortNone}</option>
            <option value="cost">{t.sortCost}</option>
            <option value="ttft">{t.sortTtft}</option>
            <option value="tps">{t.sortTps}</option>
          </select>
        </label>
      </div>
      <p className="dshcp-meta">
        {draft.upstreams.length === 0 ? t.pinAuto : t.pinPinned.replace('{list}', draft.upstreams.join(' > '))}
        {draft.exclude.length === 0 ? '' : ` · ${t.pinExcluded.replace('{list}', draft.exclude.join(', '))}`}
      </p>
      <div className="dshcp-actions">
        <button className="dsha-btn" disabled={busyAny} onClick={props.onProbe}>
          {props.busy === 'probe:' + model.id ? t.probing : t.probe}
        </button>
        <button className="dsha-btn" disabled={busyAny || model.upstreams.length === 0} onClick={props.onValidate}>
          {props.busy === 'validate:' + model.id ? t.validating : t.validate}
        </button>
        <button className="dsha-btn" disabled={busyAny} onClick={props.onTest}>
          {props.busy === 'test-model:' + model.id ? t.testingPin : t.testPin}
        </button>
        <button className="dsha-btn dsha-btn-primary" disabled={busyAny} onClick={props.onSave}>
          {props.busy === 'pin:' + model.id ? t.savingPin : t.savePin}
        </button>
        <button className="dsha-btn" disabled={busyAny} onClick={props.onReset}>
          {t.resetPin}
        </button>
      </div>
      {result.pinWarnings !== undefined && result.pinWarnings.length > 0 && (
        <div>
          <p className="dshcp-warning">{t.warnings}</p>
          {result.pinWarnings.map((warning) => <p className="dshcp-warning" key={warning}>{warning}</p>)}
        </div>
      )}
      {result.probe !== undefined && (
        <p className="dshcp-meta">
          {t.probeResult}: {result.probe.ok ? `${result.probe.ms}ms · ${result.probe.pipeline || '—'} · ${result.probe.upstreams.length}` : result.probe.error}
        </p>
      )}
      {result.validate !== undefined && (
        <div>
          <p className="dshcp-meta">
            {t.validateSummary
              .replace('{ok}', String(result.validate.summary.ok))
              .replace('{limited}', String(result.validate.summary.limited))
              .replace('{bad}', String(result.validate.summary.bad))
              .replace('{auth}', String(result.validate.summary.auth))
              .replace('{unknown}', String(result.validate.summary.unknown))}
          </p>
          {result.validate.results.map((entry) => (
            <p className="dshcp-meta" key={entry.upstream} data-tone={statusTone(entry.status)}>
              {entry.upstream}: {entry.status} ({entry.ms}ms){entry.note === '' ? '' : ` — ${entry.note}`}
            </p>
          ))}
        </div>
      )}
      {result.test !== undefined && (
        <div>
          <p className={result.test.ok ? 'dshcp-meta' : 'dshcp-warning'}>
            {result.test.ok
              ? t.testServed.replace('{provider}', result.test.actual || '—').replace('{ms}', String(result.test.ms))
              : t.testFailed.replace('{detail}', result.test.error)}
          </p>
          {result.test.warnings.length > 0 && result.test.warnings.map((warning) => <p className="dshcp-warning" key={warning}>{warning}</p>)}
          {result.test.trace.length > 0 && (
            <>
              <p className="dshcp-meta">{t.testTrace}</p>
              <div className="dshcp-trace">
                {result.test.trace.map((entry, index) => (
                  <span key={`${entry.upstream}-${index}`}>
                    {entry.upstream} → HTTP {entry.status} · {entry.ms}ms{entry.note === '' ? '' : ` — ${entry.note}`}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      )}
      {result.error !== undefined && <p className="dshcp-warning">{result.error}</p>}
    </div>
  )
}
