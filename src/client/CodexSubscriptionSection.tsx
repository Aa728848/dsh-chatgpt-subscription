import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CredentialStorageDto, PluginStatusDto, QuotaBucketDto, QuotaWindowDto, SubscriptionPreferencesUpdateDto } from '../shared/contracts.ts'
import { CODEX_MODEL_CATALOG, CONFIGURABLE_CONTEXT_MODEL_IDS, DEFAULT_VISIBLE_CODEX_MODEL_IDS, GPT_56_MAX_CONTEXT_WINDOW, reasoningEffortsForModel, resolveCodexCatalogEntry } from '../shared/model-catalog.ts'
import { SubscriptionApi, parseLoginEvent } from './api.ts'
import { NS } from './locales.ts'
import { quotaWindows } from './quota.ts'

type Props = PropsRuntime<'settings.section'> & PropsLocale<typeof NS>
type BusyAction = 'login' | 'token' | 'quota' | 'reset-credit' | 'test' | 'logout' | 'preferences' | null
type Translate = Props['t']

export function CodexSubscriptionSection({ t }: Props): React.JSX.Element {
  const apiRef = useRef(new SubscriptionApi())
  const eventSourceRef = useRef<EventSource | null>(null)
  const [status, setStatus] = useState<PluginStatusDto | null>(null)
  const [busy, setBusy] = useState<BusyAction>(null)
  const [error, setError] = useState<string | null>(null)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [popupBlocked, setPopupBlocked] = useState(false)
  const [resetCreditNotice, setResetCreditNotice] = useState<string | null>(null)
  const [connection, setConnection] = useState<{ latencyMs: number; checkedAt: number } | null>(null)
  const [contextDrafts, setContextDrafts] = useState<Record<string, string>>({})
  const [customProxyDraft, setCustomProxyDraft] = useState<string | null>(null)

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setError(null)
    try {
      const next = await apiRef.current.status()
      setStatus(next)
      if (next.error !== undefined) setError(next.error.message)
    } catch (cause) {
      if (!quiet) setError(messageOf(cause))
    }
  }, [])

  useEffect(() => {
    void load()
    const refreshWhenVisible = (): void => {
      if (document.visibilityState === 'visible') void load(true)
    }
    document.addEventListener('visibilitychange', refreshWhenVisible)
    const timer = window.setInterval(refreshWhenVisible, 60_000)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      eventSourceRef.current?.close()
    }
  }, [load])

  const watchLogin = useCallback((loginId: string) => {
    eventSourceRef.current?.close()
    const source = apiRef.current.events(loginId)
    eventSourceRef.current = source
    const finish = async (message?: string): Promise<void> => {
      source.close()
      eventSourceRef.current = null
      setBusy(null)
      setAuthUrl(null)
      if (message !== undefined) setError(message)
      // Preserve the terminal OAuth error while refreshing the account DTO.
      await load(true)
    }
    source.addEventListener('completed', (event) => {
      const parsed = parseLoginEvent(event as MessageEvent<string>)
      if (parsed?.type === 'completed') void finish()
    })
    source.addEventListener('cancelled', () => void finish())
    source.addEventListener('failed', (event) => {
      const parsed = parseLoginEvent(event as MessageEvent<string>)
      void finish(parsed?.type === 'failed' ? parsed.error.message : 'ChatGPT sign-in failed.')
    })
  }, [load])

  useEffect(() => {
    const loginId = status?.login.active ? status.login.loginId : null
    if (loginId !== null && loginId !== undefined && eventSourceRef.current === null) watchLogin(loginId)
  }, [status?.login.active, status?.login.loginId, watchLogin])

  const startLogin = async (): Promise<void> => {
    setBusy('login')
    setError(null)
    setPopupBlocked(false)
    const popup = window.open('about:blank', 'dsh-chatgpt-oauth', 'popup,width=560,height=760')
    try {
      const login = await apiRef.current.startLogin()
      setAuthUrl(login.authUrl)
      if (popup === null) setPopupBlocked(true)
      else popup.location.replace(login.authUrl)
      watchLogin(login.loginId)
      await load(true)
    } catch (cause) {
      popup?.close()
      setBusy(null)
      setError(messageOf(cause))
    }
  }

  const cancelLogin = async (): Promise<void> => {
    const loginId = status?.login.loginId
    if (loginId === null || loginId === undefined) return
    setBusy('login')
    try {
      await apiRef.current.cancelLogin(loginId)
      eventSourceRef.current?.close()
      eventSourceRef.current = null
      setAuthUrl(null)
      await load()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const refreshToken = async (): Promise<void> => run('token', async () => {
    setStatus(await apiRef.current.refresh())
  })

  const refreshQuota = async (): Promise<void> => run('quota', async () => {
    const quota = await apiRef.current.refreshQuota()
    setStatus((current) => current === null ? current : { ...current, quota })
  })

  const useResetCredit = async (): Promise<void> => {
    if (!window.confirm(t('useResetCreditConfirm'))) return
    await run('reset-credit', async () => {
      const quota = await apiRef.current.useResetCredit()
      setStatus((current) => current === null ? current : { ...current, quota })
      setResetCreditNotice(t('resetCreditUsed'))
    })
  }

  const testConnection = async (): Promise<void> => run('test', async () => {
    const result = await apiRef.current.testConnection()
    setConnection({ latencyMs: result.latencyMs, checkedAt: result.checkedAt })
  })

  const updatePreferences = async (patch: SubscriptionPreferencesUpdateDto): Promise<void> => run('preferences', async () => {
    const preferences = await apiRef.current.updatePreferences(patch)
    setStatus((current) => current === null ? current : { ...current, preferences })
  })

  const toggleVisibleModel = async (modelId: string, checked: boolean): Promise<void> => {
    const current = status?.preferences.visibleModelIds ?? [...DEFAULT_VISIBLE_CODEX_MODEL_IDS]
    const visibleModelIds = checked ? [...current, modelId] : current.filter(id => id !== modelId)
    if (visibleModelIds.length === 0) return
    await updatePreferences({ visibleModelIds })
  }

  const updateContextWindow = async (model: (typeof CONFIGURABLE_CONTEXT_MODEL_IDS)[number]): Promise<void> => {
    const current = status?.preferences.contextWindowOverrides[model] ?? resolveCodexCatalogEntry(model).contextWindow
    const parsed = parseCapacity(contextDrafts[model] ?? String(current))
    if (parsed === null) {
      setError(t('contextWindowInvalid'))
      return
    }
    await updatePreferences({ contextWindowOverrides: { [model]: parsed } })
    setContextDrafts((drafts) => ({ ...drafts, [model]: String(parsed) }))
  }

  const updateCustomProxyUrl = async (): Promise<void> => {
    const draft = customProxyDraft?.trim()
    await updatePreferences({ customProxyUrl: draft ? draft : null })
    setCustomProxyDraft(null)
  }

  const logout = async (): Promise<void> => run('logout', async () => {
    await apiRef.current.logout()
    eventSourceRef.current?.close()
    eventSourceRef.current = null
    setAuthUrl(null)
    setConnection(null)
    await load()
  })

  const run = async (action: Exclude<BusyAction, null>, task: () => Promise<void>): Promise<void> => {
    setBusy(action)
    setError(null)
    setResetCreditNotice(null)
    try {
      await task()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const account = status?.account
  const visibleModelIds = status?.preferences.visibleModelIds ?? DEFAULT_VISIBLE_CODEX_MODEL_IDS
  return <section className="dsh-codex-page" aria-labelledby="dsh-codex-title">
    <header>
      <h2 id="dsh-codex-title" className="dsh-codex-title">{t('title')}</h2>
      <p className="dsh-codex-intro">{t('intro')}</p>
    </header>

    {error !== null ? <div className="dsh-codex-errorbar" role="alert">
      <span>{error}</span>
      {status === null ? <Button disabled={busy !== null} onClick={() => load()}>{t('retry')}</Button> : null}
    </div> : null}

    {status === null && error === null ? <Skeleton label={t('loading')} /> : <>
      <Section title={t('account')}>
        <InfoRow label={status?.authenticated ? t('signedIn') : t('signedOut')} value={account?.email ?? '—'} />
        {status?.authenticated ? <>
          <InfoRow label={t('plan')} value={account?.planType ?? t('unknown')} />
          <InfoRow label={t('accountId')} value={account?.accountIdSuffix ?? '—'} />
          <InfoRow label={t('expires')} value={formatDate(account?.tokenExpiresAt)} />
        </> : null}
        <InfoRow label={t('storage')} value={storageLabel(status?.storage, t)} />
        <p className="dsh-codex-notice">{storageNotice(status?.storage, t)}</p>
        {status?.login.active ? <p className="dsh-codex-muted" role="status">{t('pending')}</p> : null}
        {popupBlocked ? <p className="dsh-codex-error">{t('popupBlocked')}</p> : null}
        {authUrl !== null ? <a className="dsh-codex-link" href={authUrl} target="_blank" rel="noreferrer">{t('continueLogin')}</a> : null}
        <div className="dsh-codex-actions">
          {status?.login.active
            ? <Button disabled={busy !== null} onClick={cancelLogin}>{t('cancel')}</Button>
            : <Button primary disabled={busy !== null || status?.storage.available === false} onClick={startLogin}>{status?.authenticated ? t('signInAgain') : t('signIn')}</Button>}
          {status?.authenticated ? <>
            <Button disabled={busy !== null} onClick={refreshToken}>{t('refreshToken')}</Button>
            <Button disabled={busy !== null} onClick={logout}>{t('signOut')}</Button>
          </> : null}
        </div>
      </Section>

      <Section title={t('connection')}>
        <InfoRow label={t('provider')} value="Codex（ChatGPT 订阅） · codex-chatgpt" />
        <InfoRow label={t('connectionState')} value={connection === null ? t('untested') : t('connected')} />
        {connection !== null ? <InfoRow label={t('latency')} value={`${connection.latencyMs} ms · ${formatDate(connection.checkedAt)}`} /> : null}
        <p className="dsh-codex-muted dsh-codex-models-hint">{t('modelsHint')}</p>
        <div className="dsh-codex-models" aria-label={t('models')}>
          {CODEX_MODEL_CATALOG.map((model) => {
            const checked = visibleModelIds.some(id => id === model.id)
            const lastVisible = checked && visibleModelIds.length === 1
            return <label key={model.id} title={model.id}>
              <input type="checkbox" checked={checked} disabled={busy !== null || lastVisible} onChange={(event) => void toggleVisibleModel(model.id, event.currentTarget.checked)} />
              <span>{model.name}</span>
            </label>
          })}
        </div>
        <div className="dsh-codex-actions">
          <Button disabled={!status?.authenticated || busy !== null} onClick={testConnection}>{busy === 'test' ? t('testing') : t('testConnection')}</Button>
        </div>
      </Section>

      <Section title={t('proxySettings')}>
        <div className="dsh-codex-pref-row">
          <div>
            <strong>{t('proxyMode')}</strong>
            <p className="dsh-codex-muted">{t('proxyModeHint')}</p>
          </div>
          <select
            className="dsh-codex-select"
            aria-label={t('proxyMode')}
            value={status?.preferences.proxyMode ?? 'auto'}
            disabled={busy !== null}
            onChange={(event) => {
              const mode = event.currentTarget.value as 'auto' | 'custom' | 'direct'
              setStatus(current => current ? { ...current, preferences: { ...current.preferences, proxyMode: mode } } : current)
              void updatePreferences({ proxyMode: mode })
            }}
          >
            <option value="auto">{t('proxyModeAuto')}</option>
            <option value="custom">{t('proxyModeCustom')}</option>
            <option value="direct">{t('proxyModeDirect')}</option>
          </select>
        </div>

        {(status?.preferences.proxyMode ?? 'auto') === 'auto' ? <div className="dsh-codex-proxy-status">
          {status?.detectedProxy ? <>
            <span>{t('proxyDetected')}:</span>
            <code className="dsh-codex-proxy-tag">{status.detectedProxy}</code>
            <span className="dsh-codex-success">{t('proxyDetectedEffective')}</span>
          </> : <span className="dsh-codex-muted">{t('proxyNoneDetected')}</span>}
        </div> : null}

        {status?.preferences.proxyMode === 'direct' ? <p className="dsh-codex-muted" style={{ margin: '8px 0 0' }}>{t('proxyDirectHint')}</p> : null}

        {status?.preferences.proxyMode === 'custom' ? <div className="dsh-codex-context-settings">
          <div>
            <strong>{t('customProxyUrl')}</strong>
            <p className="dsh-codex-muted">{t('customProxyUrlHint')}</p>
          </div>
          <div className="dsh-codex-context-row">
            <span className="dsh-codex-proxy-control">
              <input
                id="dsh-codex-custom-proxy"
                type="text"
                placeholder={t('customProxyUrlPlaceholder')}
                value={customProxyDraft ?? (status?.preferences.customProxyUrl ?? '')}
                disabled={busy !== null}
                aria-label={t('customProxyUrl')}
                onChange={(event) => {
                  setCustomProxyDraft(event.currentTarget.value)
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  void updateCustomProxyUrl()
                }}
              />
              <button
                className="dsh-codex-context-save"
                type="button"
                aria-label={t('saveProxyUrl')}
                disabled={busy !== null || customProxyDraft === null}
                onClick={() => void updateCustomProxyUrl()}
              >
                {t('save')}
              </button>
            </span>
          </div>
        </div> : null}
      </Section>

      <Section title={t('enhancements')}>
        <div className="dsh-codex-pref-row">
          <div>
            <strong>{t('searchProvider')}</strong>
            <p className="dsh-codex-muted">{t('searchProviderHint')}</p>
          </div>
          <div className="dsh-codex-segments" role="radiogroup" aria-label={t('searchProvider')}>
            <label>
              <input type="radio" name="dsh-codex-search-provider" checked={status?.preferences.searchProvider === 'dsh'} disabled={busy !== null} onChange={() => updatePreferences({ searchProvider: 'dsh' })} />
              <span>{t('searchProviderDsh')}</span>
            </label>
            <label>
              <input type="radio" name="dsh-codex-search-provider" checked={status?.preferences.searchProvider === 'codex'} disabled={busy !== null} onChange={() => updatePreferences({ searchProvider: 'codex' })} />
              <span>{t('searchProviderCodex')}</span>
            </label>
          </div>
        </div>
        <div className="dsh-codex-pref-row">
          <div>
            <strong>{t('outputVerbosity')}</strong>
            <p className="dsh-codex-muted">{t('outputVerbosityHint')}</p>
          </div>
          <select className="dsh-codex-select" aria-label={t('outputVerbosity')} value={status?.preferences.outputVerbosity ?? ''} disabled={busy !== null} onChange={(event) => {
            const value = event.currentTarget.value
            void updatePreferences({ outputVerbosity: value === '' ? null : value as 'low' | 'medium' | 'high' })
          }}>
            <option value="">{t('providerDefault')}</option>
            <option value="low">{t('verbosityLow')}</option>
            <option value="medium">{t('verbosityMedium')}</option>
            <option value="high">{t('verbosityHigh')}</option>
          </select>
        </div>
        <div className="dsh-codex-context-settings">
          <div>
            <strong>{t('contextWindows')}</strong>
            <p className="dsh-codex-muted">{t('contextWindowsHint')}</p>
          </div>
          {CONFIGURABLE_CONTEXT_MODEL_IDS.map((model) => {
            const entry = resolveCodexCatalogEntry(model)
            const fallback = status?.preferences.contextWindowOverrides[model] ?? entry.contextWindow
            const draft = contextDrafts[model]
            const parsedDraft = draft === undefined ? fallback : parseCapacity(draft)
            const dirty = draft !== undefined && parsedDraft !== fallback
            const inputId = `dsh-codex-context-${model}`
            return <div className="dsh-codex-context-row" key={model}>
              <label htmlFor={inputId}>{entry.name}</label>
              <span className="dsh-codex-capacity-control">
                <input id={inputId} type="text" inputMode="numeric" value={draft ?? formatCapacity(fallback)} disabled={busy !== null} aria-label={entry.name + ' ' + t('contextWindow')} onChange={(event) => {
                  const value = event.currentTarget.value
                  setContextDrafts((drafts) => ({ ...drafts, [model]: value }))
                }} onKeyDown={(event) => {
                  if (event.key !== 'Enter' || !dirty) return
                  event.preventDefault()
                  void updateContextWindow(model)
                }} />
                <small>{t('tokens')}</small>
                <button className="dsh-codex-context-save" type="button" data-model={model} aria-label={entry.name + ' ' + t('saveContextWindow')} disabled={busy !== null || !dirty} onClick={() => void updateContextWindow(model)}>{t('save')}</button>
              </span>
            </div>
          })}
        </div>
        <label className="dsh-codex-check">
          <input type="checkbox" checked={status?.preferences.fastMode === true} disabled={busy !== null} onChange={(event) => updatePreferences({ fastMode: event.currentTarget.checked })} />
          <span>
            <strong>{t('fastMode')}</strong>
            <small>{t('fastModeHint')}</small>
          </span>
        </label>
        <label className="dsh-codex-check">
          <input type="checkbox" checked={status?.preferences.quickQuotaVisible === true} disabled={busy !== null} onChange={(event) => updatePreferences({ quickQuotaVisible: event.currentTarget.checked })} />
          <span>
            <strong>{t('quickQuota')}</strong>
            <small>{t('quickQuotaHint')}</small>
          </span>
        </label>
      </Section>

      <Section title={t('quota')} aside={<Button disabled={!status?.authenticated || busy !== null} onClick={refreshQuota}>{busy === 'quota' ? t('refreshing') : t('refreshQuota')}</Button>}>
        <p className="dsh-codex-muted">{t('quotaIntro')}</p>
        {status?.quota.state === 'signed-out' ? <p className="dsh-codex-empty">{t('quotaSignedOut')}</p> : null}
        {status?.quota.buckets.map((bucket) => <QuotaBucket key={bucket.id} bucket={bucket} t={t} />)}
        {status?.quota.credits !== null && status?.quota.credits !== undefined ? <QuotaFact label={t('credits')} value={status.quota.credits.unlimited ? t('unlimited') : status.quota.credits.balance ?? (status.quota.credits.hasCredits ? t('available') : t('unavailable'))} /> : null}
        {status?.quota.individualLimit !== null && status?.quota.individualLimit !== undefined ? <QuotaFact label={t('monthlySpend')} value={individualLimitLabel(status.quota.individualLimit, t)} /> : null}
        {status?.quota.resetCredits !== null && status?.quota.resetCredits !== undefined ? <ResetCreditsFact resetCredits={status.quota.resetCredits} busy={busy} onUse={useResetCredit} t={t} /> : null}
        {resetCreditNotice !== null ? <p className="dsh-codex-success" role="status">{resetCreditNotice}</p> : null}
        {status?.quota.spendControlReached === true ? <p className="dsh-codex-warning" role="status">{t('spendControlReached')}</p> : null}
        {status?.quota.state === 'empty' ? <p className="dsh-codex-empty">{t('noQuota')}</p> : null}
        {status?.quota.stale ? <p className="dsh-codex-warning" role="status">{t('stale')}</p> : null}
        {status?.quota.error ? <p className="dsh-codex-error" role="alert">{status.quota.error.message}</p> : null}
        {status?.quota.fetchedAt ? <p className="dsh-codex-timestamp">{t('updated')}: {formatDate(status.quota.fetchedAt)}</p> : null}
      </Section>
    </>}

    <span className="dsh-codex-sr" aria-live="polite">{busy === null ? '' : busy}</span>
  </section>
}

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return <section className="dsh-codex-group">
    <div className="dsh-codex-grouphead"><h3>{title}</h3>{aside}</div>
    {children}
  </section>
}

function Button({ primary = false, disabled, onClick, children }: { primary?: boolean; disabled?: boolean; onClick: () => void | Promise<void>; children: React.ReactNode }): React.JSX.Element {
  return <button className={`dsh-codex-button${primary ? ' dsh-codex-button-primary' : ''}`} type="button" disabled={disabled} onClick={() => void onClick()}>{children}</button>
}

function InfoRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <div className="dsh-codex-row"><span className="dsh-codex-label">{label}</span><span className="dsh-codex-value">{value}</span></div>
}

export function storageLabel(storage: CredentialStorageDto | undefined, t: Translate): string {
  if (storage === undefined || !storage.available) return t('storageUnavailable')
  if (storage.kind === 'windows-dpapi') return t('storageWindows')
  if (storage.kind === 'macos-keychain') return t('storageMacKeychain')
  if (storage.kind === 'linux-file') return t('storageLinuxFile')
  if (storage.kind === 'memory') return t('storageMemory')
  return t('storageUnavailable')
}

export function storageNotice(storage: CredentialStorageDto | undefined, t: Translate): string {
  if (storage === undefined || !storage.available) return t('securityUnavailable')
  if (storage.kind === 'windows-dpapi') return t('securityWindows')
  if (storage.kind === 'macos-keychain') return t('securityMacKeychain')
  if (storage.kind === 'linux-file') return t('securityLinuxFile')
  if (storage.kind === 'memory') return t('securityMemory')
  return t('securityUnavailable')
}

function QuotaBucket({ bucket, t }: { bucket: QuotaBucketDto; t: Translate }): React.JSX.Element {
  const windows = quotaWindows(bucket)
  return <article className="dsh-codex-quota-card">
    <div className="dsh-codex-quota-title"><strong>{bucket.name}</strong>{bucket.planType ? <span>{bucket.planType}</span> : null}</div>
    {windows.map((window, index) => <QuotaBar key={`${window.windowDurationMins ?? 'x'}:${window.resetsAt ?? 'x'}:${index}`} label={windowLabel(window.windowDurationMins, t)} window={window} t={t} />)}
  </article>
}

function QuotaFact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <div className="dsh-codex-quota-fact"><span>{label}</span><strong>{value}</strong></div>
}

export function ResetCreditsFact({ resetCredits, busy, onUse, t }: { resetCredits: NonNullable<PluginStatusDto['quota']['resetCredits']>; busy: BusyAction; onUse: () => Promise<void>; t: Translate }): React.JSX.Element {
  const available = resetCredits.availableCount > 0
  return <div className="dsh-codex-reset-credits">
    <div className="dsh-codex-reset-credits-info">
      <span>{t('resetCredits')}</span>
      <strong>{resetCredits.availableCount}</strong>
      <small>{t('resetCreditExpires')}: {resetCredits.expiresAt == null ? t('unknown') : formatReset(resetCredits.expiresAt)}</small>
    </div>
    <Button primary disabled={!available || busy !== null} onClick={onUse}>{busy === 'reset-credit' ? t('usingResetCredit') : t('useResetCredit')}</Button>
  </div>
}

export function QuotaBar({ label, window, t }: { label: string; window: QuotaWindowDto; t: Translate }): React.JSX.Element {
  const percent = typeof window?.usedPercent === 'number' && Number.isFinite(window.usedPercent) ? window.usedPercent : 0
  const level = percent >= 95 ? 'danger' : percent >= 80 ? 'warning' : 'normal'
  const remaining = Math.max(0, 100 - percent)
  return <div className="dsh-codex-meter-wrap">
    <div className="dsh-codex-meter-label"><span>{label}</span><strong>{formatPercent(percent)}</strong></div>
    <div className={`dsh-codex-meter dsh-codex-meter-${level}`} role="progressbar" aria-label={`${label}: ${formatPercent(percent)} ${t('used')}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <span style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
    </div>
    <div className="dsh-codex-meter-meta">
      <span>{percent >= 100 ? `${t('exhausted')} · ${formatPercent(remaining)} ${t('remaining')}` : `${formatPercent(percent)} ${t('used')} · ${formatPercent(remaining)} ${t('remaining')}`}</span>
      <span>{window?.resetsAt == null ? '—' : `${t('resets')}: ${formatReset(window.resetsAt)}`}</span>
    </div>
  </div>
}

function Skeleton({ label }: { label: string }): React.JSX.Element {
  return <div className="dsh-codex-skeleton" role="status" aria-label={label}><span /><span /></div>
}

export function windowLabel(minutes: number | null | undefined, t: Translate): string {
  if (minutes === null || minutes === undefined || typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return t('limitWindow')
  const [value, unit]: [number, Intl.NumberFormatOptions['unit']] = minutes >= 1440 && minutes % 1440 === 0
    ? [minutes / 1440, 'day']
    : minutes >= 60 && minutes % 60 === 0
      ? [minutes / 60, 'hour']
      : [Math.round(minutes), 'minute']
  try {
    return `${new Intl.NumberFormat(undefined, { style: 'unit', unit, unitDisplay: 'long' }).format(value)} ${t('limitWindow')}`
  } catch {
    return `${value} ${t('limitWindow')}`
  }
}

function reasoningEffortLabel(effort: string, t: Translate): string {
  const labels: Record<string, keyof typeof import('./locales.ts').zh> = {
    none: 'reasoningNone',
    low: 'reasoningLow',
    medium: 'reasoningMedium',
    high: 'reasoningHigh',
    xhigh: 'reasoningXhigh',
    max: 'reasoningMax',
  }
  return t(labels[effort] ?? 'unknown')
}

export function parsePositiveCapacity(value: string): number | null {
  const normalized = value.trim().toLowerCase().replace(/[,_\s]/g, '')
  const matched = normalized.match(/^(\d+(?:\.\d+)?)(k|m)?$/)
  if (matched === null) return null
  const multiplier = matched[2] === 'm' ? 1_000_000 : matched[2] === 'k' ? 1_000 : 1
  const parsed = Number(matched[1]) * multiplier
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null
}

export function parseCapacity(value: string): number | null {
  const parsed = parsePositiveCapacity(value)
  return parsed !== null && parsed <= GPT_56_MAX_CONTEXT_WINDOW ? parsed : null
}

function formatCapacity(value: number): string {
  if (value % 1_000 === 0) return `${value / 1_000}K`
  return String(value)
}

function formatPercent(value: number | undefined | null): string {
  if (value === undefined || value === null || typeof value !== 'number' || !Number.isFinite(value)) return '0%'
  try {
    return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)}%`
  } catch {
    return `${value}%`
  }
}

function individualLimitLabel(limit: NonNullable<PluginStatusDto['quota']['individualLimit']>, t: Translate): string {
  const parts = [
    limit.remainingPercent !== null && limit.remainingPercent !== undefined ? `${formatPercent(limit.remainingPercent)} ${t('remaining')}` : null,
    limit.limit !== null && limit.limit !== undefined ? `${t('limit')}: ${limit.limit}` : null,
    limit.used !== null && limit.used !== undefined ? `${t('used')}: ${limit.used}` : null,
    limit.resetsAt !== null && limit.resetsAt !== undefined ? `${t('resets')}: ${formatReset(limit.resetsAt)}` : null,
  ].filter((part): part is string => part !== null)
  return parts.length > 0 ? parts.join(' · ') : t('unknown')
}

function formatDate(seconds: number | undefined | null): string {
  if (seconds === undefined || seconds === null || typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '—'
  const ms = seconds > 10_000_000_000 ? seconds : seconds * 1000
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(ms)
  } catch {
    return '—'
  }
}

export function formatReset(seconds: number | undefined | null): string {
  if (seconds === undefined || seconds === null || typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '—'
  const ms = seconds > 10_000_000_000 ? seconds : seconds * 1000
  const absolute = formatDate(seconds)
  const diff = ms - Date.now()
  const abs = Math.abs(diff)
  const [amount, unit]: [number, Intl.RelativeTimeFormatUnit] = abs >= 86_400_000
    ? [Math.round(diff / 86_400_000), 'day']
    : abs >= 3_600_000
      ? [Math.round(diff / 3_600_000), 'hour']
      : [Math.round(diff / 60_000), 'minute']
  try {
    return `${absolute} (${new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(amount, unit)})`
  } catch {
    return absolute
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
