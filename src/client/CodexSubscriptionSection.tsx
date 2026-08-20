import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CredentialStorageDto, PluginStatusDto, QuotaBucketDto, QuotaWindowDto, SubagentModelCatalogDto, SubscriptionPreferencesUpdateDto } from '../shared/contracts.ts'
import { CODEX_MODEL_CATALOG, CONFIGURABLE_CONTEXT_MODEL_IDS, GPT_56_MAX_CONTEXT_WINDOW, reasoningEffortsForModel, resolveCodexCatalogEntry } from '../shared/model-catalog.ts'
import { SubscriptionApi, parseLoginEvent } from './api.ts'
import { NS } from './locales.ts'
import { quotaWindows } from './quota.ts'

type Props = PropsRuntime<'settings.section'> & PropsLocale<typeof NS>
type BusyAction = 'login' | 'token' | 'quota' | 'test' | 'logout' | 'preferences' | null
type Translate = Props['t']

export function CodexSubscriptionSection({ t }: Props): React.JSX.Element {
  const apiRef = useRef(new SubscriptionApi())
  const eventSourceRef = useRef<EventSource | null>(null)
  const [status, setStatus] = useState<PluginStatusDto | null>(null)
  const [modelCatalog, setModelCatalog] = useState<SubagentModelCatalogDto | null>(null)
  const [busy, setBusy] = useState<BusyAction>(null)
  const [error, setError] = useState<string | null>(null)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [popupBlocked, setPopupBlocked] = useState(false)
  const [connection, setConnection] = useState<{ latencyMs: number; checkedAt: number } | null>(null)
  const [contextDrafts, setContextDrafts] = useState<Record<string, string>>({})

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setError(null)
    try {
      const [next, models] = await Promise.all([apiRef.current.status(), apiRef.current.models()])
      setStatus(next)
      setModelCatalog(models)
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

  const testConnection = async (): Promise<void> => run('test', async () => {
    const result = await apiRef.current.testConnection()
    setConnection({ latencyMs: result.latencyMs, checkedAt: result.checkedAt })
  })

  const updatePreferences = async (patch: SubscriptionPreferencesUpdateDto): Promise<void> => run('preferences', async () => {
    const preferences = await apiRef.current.updatePreferences(patch)
    setStatus((current) => current === null ? current : { ...current, preferences })
  })

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
    try {
      await task()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const account = status?.account
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
        <div className="dsh-codex-models" aria-label={t('models')}>
          {CODEX_MODEL_CATALOG.map((model) => <code key={model.id} title={model.id}>{model.name}</code>)}
        </div>
        <div className="dsh-codex-actions">
          <Button disabled={!status?.authenticated || busy !== null} onClick={testConnection}>{busy === 'test' ? t('testing') : t('testConnection')}</Button>
        </div>
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
        {(() => {
          const selectedProvider = modelCatalog?.providers.find((provider) => provider.id === status?.preferences.subagentProvider) ?? modelCatalog?.providers[0]
          const selectedModel = selectedProvider?.models.find((model) => model.id === status?.preferences.subagentModel) ?? selectedProvider?.models[0]
          const reasoning = selectedModel?.reasoning
          const selectedEffort = status?.preferences.subagentReasoningEffort ?? reasoning?.defaultEffort ?? reasoning?.efforts[0]?.id ?? ''
          const savedContext = status?.preferences.subagentContextWindow ?? selectedModel?.contextWindow
          const contextDraft = contextDrafts.subagent
          const parsedContextValue = contextDraft === undefined ? savedContext ?? null : parsePositiveCapacity(contextDraft)
          const parsedContext = parsedContextValue !== null && (selectedModel?.maxContextWindow === undefined || parsedContextValue <= selectedModel.maxContextWindow)
            ? parsedContextValue
            : null
          const contextDirty = contextDraft !== undefined && parsedContext !== savedContext
          return <>
            <div className="dsh-codex-pref-row">
              <div>
                <strong>{t('subagentProvider')}</strong>
                <p className="dsh-codex-muted">{t('subagentProviderHint')}</p>
              </div>
              <select className="dsh-codex-select" aria-label={t('subagentProvider')} value={selectedProvider?.id ?? ''} disabled={busy !== null || selectedProvider === undefined} onChange={(event) => {
                const provider = modelCatalog?.providers.find((entry) => entry.id === event.currentTarget.value)
                const model = provider?.models[0]
                if (provider === undefined || model === undefined) return
                const effort = model.reasoning?.defaultEffort ?? model.reasoning?.efforts[0]?.id ?? null
                void updatePreferences({ subagentProvider: provider.id, subagentModel: model.id, subagentReasoningEffort: effort, subagentContextWindow: model.contextWindow ?? 1 })
                setContextDrafts((drafts) => ({ ...drafts, subagent: formatCapacity(model.contextWindow ?? 1) }))
              }}>
                {modelCatalog?.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
              </select>
            </div>
            <div className="dsh-codex-pref-row">
              <div>
                <strong>{t('subagentModel')}</strong>
                <p className="dsh-codex-muted">{t('subagentModelHint')}</p>
              </div>
              <select className="dsh-codex-select" aria-label={t('subagentModel')} value={selectedModel?.id ?? ''} disabled={busy !== null || selectedModel === undefined} onChange={(event) => {
                const model = selectedProvider?.models.find((entry) => entry.id === event.currentTarget.value)
                if (selectedProvider === undefined || model === undefined) return
                const effort = model.reasoning?.defaultEffort ?? model.reasoning?.efforts[0]?.id ?? null
                void updatePreferences({ subagentProvider: selectedProvider.id, subagentModel: model.id, subagentReasoningEffort: effort, subagentContextWindow: model.contextWindow ?? 1 })
                setContextDrafts((drafts) => ({ ...drafts, subagent: formatCapacity(model.contextWindow ?? 1) }))
              }}>
                {selectedProvider?.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
              </select>
            </div>
            <div className="dsh-codex-pref-row">
              <div>
                <strong>{t('subagentReasoningEffort')}</strong>
                <p className="dsh-codex-muted">{t('subagentReasoningEffortHint')}</p>
              </div>
              {reasoning !== undefined && reasoning.efforts.length > 0
                ? <select className="dsh-codex-select" aria-label={t('subagentReasoningEffort')} value={selectedEffort} disabled={busy !== null} onChange={(event) => void updatePreferences({ subagentReasoningEffort: event.currentTarget.value })}>
                    {reasoning.efforts.map((effort) => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
                  </select>
                : <span className="dsh-codex-muted">{t('providerDefault')}</span>}
            </div>
            {selectedModel?.contextWindow !== undefined ? <div className="dsh-codex-context-settings">
              <div>
                <strong>{selectedModel.name} · {t('contextWindow')}</strong>
                <p className="dsh-codex-muted">{t('selectedModelContextHint')}</p>
              </div>
              <div className="dsh-codex-context-row">
                <label htmlFor="dsh-subagent-context">{t('effectiveContextWindow')}</label>
                <span className="dsh-codex-capacity-control">
                  <input id="dsh-subagent-context" type="text" inputMode="numeric" value={contextDraft ?? formatCapacity(savedContext ?? selectedModel.contextWindow)} disabled={busy !== null} onChange={(event) => {
                    const value = event.currentTarget.value
                    setContextDrafts((drafts) => ({ ...drafts, subagent: value }))
                  }} />
                  <small>{t('tokens')}</small>
                  <button className="dsh-codex-context-save" type="button" disabled={busy !== null || !contextDirty || parsedContext === null} onClick={() => {
                    if (parsedContext !== null) void updatePreferences({ subagentContextWindow: parsedContext })
                  }}>{t('save')}</button>
                </span>
              </div>
            </div> : null}
          </>
        })()}
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
        {status?.quota.resetCredits !== null && status?.quota.resetCredits !== undefined ? <QuotaFact label={t('resetCredits')} value={String(status.quota.resetCredits.availableCount)} /> : null}
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

export function QuotaBar({ label, window, t }: { label: string; window: QuotaWindowDto; t: Translate }): React.JSX.Element {
  const percent = window.usedPercent
  const level = percent >= 95 ? 'danger' : percent >= 80 ? 'warning' : 'normal'
  const remaining = Math.max(0, 100 - percent)
  return <div className="dsh-codex-meter-wrap">
    <div className="dsh-codex-meter-label"><span>{label}</span><strong>{formatPercent(percent)}</strong></div>
    <div className={`dsh-codex-meter dsh-codex-meter-${level}`} role="progressbar" aria-label={`${label}: ${formatPercent(percent)} ${t('used')}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <span style={{ width: `${percent}%` }} />
    </div>
    <div className="dsh-codex-meter-meta">
      <span>{percent >= 100 ? `${t('exhausted')} · ${formatPercent(remaining)} ${t('remaining')}` : `${formatPercent(percent)} ${t('used')} · ${formatPercent(remaining)} ${t('remaining')}`}</span>
      <span>{window.resetsAt === null ? '—' : `${t('resets')}: ${formatReset(window.resetsAt)}`}</span>
    </div>
  </div>
}

function Skeleton({ label }: { label: string }): React.JSX.Element {
  return <div className="dsh-codex-skeleton" role="status" aria-label={label}><span /><span /></div>
}

export function windowLabel(minutes: number | null, t: Translate): string {
  if (minutes === null) return t('limitWindow')
  const [value, unit]: [number, Intl.NumberFormatOptions['unit']] = minutes >= 1440 && minutes % 1440 === 0
    ? [minutes / 1440, 'day']
    : minutes >= 60 && minutes % 60 === 0
      ? [minutes / 60, 'hour']
      : [Math.round(minutes), 'minute']
  return `${new Intl.NumberFormat(undefined, { style: 'unit', unit, unitDisplay: 'long' }).format(value)} ${t('limitWindow')}`
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

function formatPercent(value: number): string {
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)}%`
}

function individualLimitLabel(limit: NonNullable<PluginStatusDto['quota']['individualLimit']>, t: Translate): string {
  const parts = [
    limit.remainingPercent !== null ? `${formatPercent(limit.remainingPercent)} ${t('remaining')}` : null,
    limit.limit !== null ? `${t('limit')}: ${limit.limit}` : null,
    limit.used !== null ? `${t('used')}: ${limit.used}` : null,
    limit.resetsAt !== null ? `${t('resets')}: ${formatReset(limit.resetsAt)}` : null,
  ].filter((part): part is string => part !== null)
  return parts.length > 0 ? parts.join(' · ') : t('unknown')
}

function formatDate(seconds: number | undefined): string {
  if (seconds === undefined) return '—'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(seconds * 1000)
}

export function formatReset(seconds: number): string {
  const absolute = formatDate(seconds)
  const diff = seconds * 1000 - Date.now()
  const abs = Math.abs(diff)
  const [amount, unit]: [number, Intl.RelativeTimeFormatUnit] = abs >= 86_400_000
    ? [Math.round(diff / 86_400_000), 'day']
    : abs >= 3_600_000
      ? [Math.round(diff / 3_600_000), 'hour']
      : [Math.round(diff / 60_000), 'minute']
  return `${absolute} (${new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(amount, unit)})`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
