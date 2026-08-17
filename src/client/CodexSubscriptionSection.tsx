import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CredentialStorageDto, PluginStatusDto, QuotaBucketDto, QuotaWindowDto } from '../shared/contracts.ts'
import { SubscriptionApi, parseLoginEvent } from './api.ts'
import { NS } from './locales.ts'

type Props = PropsRuntime<'settings.section'> & PropsLocale<typeof NS>
type BusyAction = 'login' | 'token' | 'quota' | 'test' | 'logout' | null
type Translate = Props['t']

const MODELS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2']

export function CodexSubscriptionSection({ t }: Props): React.JSX.Element {
  const apiRef = useRef(new SubscriptionApi())
  const eventSourceRef = useRef<EventSource | null>(null)
  const [status, setStatus] = useState<PluginStatusDto | null>(null)
  const [busy, setBusy] = useState<BusyAction>(null)
  const [error, setError] = useState<string | null>(null)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [popupBlocked, setPopupBlocked] = useState(false)
  const [connection, setConnection] = useState<{ latencyMs: number; checkedAt: number } | null>(null)

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

  const testConnection = async (): Promise<void> => run('test', async () => {
    const result = await apiRef.current.testConnection()
    setConnection({ latencyMs: result.latencyMs, checkedAt: result.checkedAt })
  })

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
          {MODELS.map((model) => <code key={model}>{model}</code>)}
        </div>
        <div className="dsh-codex-actions">
          <Button disabled={!status?.authenticated || busy !== null} onClick={testConnection}>{busy === 'test' ? t('testing') : t('testConnection')}</Button>
        </div>
      </Section>

      <Section title={t('quota')} aside={<Button disabled={!status?.authenticated || busy !== null} onClick={refreshQuota}>{busy === 'quota' ? t('refreshing') : t('refreshQuota')}</Button>}>
        <p className="dsh-codex-muted">{t('quotaIntro')}</p>
        {status?.quota.state === 'signed-out' ? <p className="dsh-codex-empty">{t('quotaSignedOut')}</p> : null}
        {status?.quota.buckets.map((bucket) => <QuotaBucket key={bucket.id} bucket={bucket} t={t} />)}
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
  if (storage.kind === 'linux-file') return t('storageLinuxFile')
  if (storage.kind === 'memory') return t('storageMemory')
  return t('storageUnavailable')
}

export function storageNotice(storage: CredentialStorageDto | undefined, t: Translate): string {
  if (storage === undefined || !storage.available) return t('securityUnavailable')
  if (storage.kind === 'windows-dpapi') return t('securityWindows')
  if (storage.kind === 'linux-file') return t('securityLinuxFile')
  if (storage.kind === 'memory') return t('securityMemory')
  return t('securityUnavailable')
}

function QuotaBucket({ bucket, t }: { bucket: QuotaBucketDto; t: Translate }): React.JSX.Element {
  return <article className="dsh-codex-quota-card">
    <div className="dsh-codex-quota-title"><strong>{bucket.name}</strong>{bucket.planType ? <span>{bucket.planType}</span> : null}</div>
    {bucket.primary ? <QuotaBar label={windowLabel(bucket.primary.windowDurationMins, t)} window={bucket.primary} t={t} /> : null}
    {bucket.secondary ? <QuotaBar label={windowLabel(bucket.secondary.windowDurationMins, t)} window={bucket.secondary} t={t} /> : null}
  </article>
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

function formatPercent(value: number): string {
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)}%`
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
