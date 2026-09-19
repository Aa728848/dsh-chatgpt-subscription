import React, { useCallback, useEffect, useState } from 'react'
import type {
  CommandCodeModelOption,
  CommandCodeReasoningEffort,
  CommandCodeWebStatus,
} from '../../shared/command-code-contracts.ts'
import { COMMAND_CODE_REASONING_EFFORTS } from '../../shared/command-code-contracts.ts'

/**
 * Display label per reasoning level. The locale dictionary only accepts flat
 * string values, so this nested table lives with the control that renders it.
 */
const EFFORT_LABELS: Record<CommandCodeReasoningEffort, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
}
import { zh } from './locales.ts'

const API = '/command-code/api'

interface Props {
  onModelChange?: () => void
  loadModelDirectory?: () => void
}

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })
  const json = (await res.json()) as { ok: boolean; value?: T; error?: string }
  if (!res.ok || !json.ok) {
    throw new Error(json.error || `HTTP ${res.status}`)
  }
  return json.value as T
}

/** Parse "1M", "512K", "200000" into a positive integer token count. */
export function parsePositiveCapacity(value: string): number | null {
  const normalized = value.trim().toLowerCase().replace(/[,_\s]/g, '')
  const matched = normalized.match(/^(\d+(?:\.\d+)?)(k|m)?$/)
  if (matched === null) return null
  const multiplier = matched[2] === 'm' ? 1_000_000 : matched[2] === 'k' ? 1_000 : 1
  const parsed = Number(matched[1]) * multiplier
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null
}

export function formatCapacity(value: number): string {
  if (value >= 1_000_000 && value % 100_000 === 0) return `${value / 1_000_000}M`
  if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}K`
  return String(value)
}

function formatDate(ms?: number | null): string {
  if (ms === undefined || ms === null || ms <= 0) return '—'
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(ms)
  } catch {
    return '—'
  }
}

function formatReset(resetsAt?: number | null): string {
  if (resetsAt === undefined || resetsAt === null || resetsAt <= 0) return ''
  const diff = resetsAt - Date.now()
  if (diff <= 0) return 'now'
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${mins % 60}m`
  return `${mins}m`
}

interface LoginPollStatus {
  status: string
  authUrl?: string
  error?: string
  progress?: string
}

export function CommandCodeSection({ onModelChange, loadModelDirectory }: Props): React.ReactElement {
  const [status, setStatus] = useState<CommandCodeWebStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loginProgress, setLoginProgress] = useState<string | null>(null)
  const [contextDrafts, setContextDrafts] = useState<Record<string, string>>({})
  const [savingModel, setSavingModel] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')

  const t = zh

  const notifyChange = useCallback(() => {
    onModelChange?.()
    loadModelDirectory?.()
  }, [onModelChange, loadModelDirectory])

  const loadStatus = useCallback(async (quiet = false) => {
    if (!quiet) {
      setError(null)
    }
    try {
      const data = await fetchApi<CommandCodeWebStatus>('/status')
      setStatus(data)
      const drafts: Record<string, string> = {}
      for (const model of data.models) {
        drafts[model.id] = formatCapacity(data.contextWindowOverrides[model.id] || model.defaultContextWindow)
      }
      setContextDrafts(drafts)
    } catch (err) {
      if (!quiet) setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadStatus()
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void loadStatus(true)
    }
    document.addEventListener('visibilitychange', refreshWhenVisible)
    const timer = window.setInterval(refreshWhenVisible, 60_000)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [loadStatus])

  const handleLogin = async () => {
    try {
      setBusy('login')
      setError(null)
      setLoginProgress(null)
      const flow = await fetchApi<LoginPollStatus>('/login', { method: 'POST' })
      if (flow.authUrl) {
        window.open(flow.authUrl, '_blank')
      }
      const pollTimer = window.setInterval(() => {
        void (async () => {
          try {
            const poll = await fetchApi<LoginPollStatus>('/login/status')
            if (poll.progress) setLoginProgress(poll.progress)
            if (poll.status === 'complete') {
              window.clearInterval(pollTimer)
              setBusy(null)
              setLoginProgress(null)
              await loadStatus()
              notifyChange()
            } else if (poll.status === 'error') {
              window.clearInterval(pollTimer)
              setBusy(null)
              setLoginProgress(null)
              setError(poll.error || t.loginFailed)
            }
          } catch {
            // A failed poll is transient; the next tick retries.
          }
        })()
      }, 1500)
      window.setTimeout(() => {
        window.clearInterval(pollTimer)
        setBusy(null)
        setLoginProgress(null)
      }, 5 * 60 * 1000)
    } catch (err) {
      setBusy(null)
      setLoginProgress(null)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleApiKey = async () => {
    try {
      setBusy('apikey')
      setError(null)
      const updated = await fetchApi<CommandCodeWebStatus>('/login/apikey', {
        method: 'POST',
        body: JSON.stringify({ apiKey }),
      })
      setStatus(updated)
      setApiKey('')
      notifyChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleLogout = async () => {
    try {
      setBusy('logout')
      setError(null)
      const updated = await fetchApi<CommandCodeWebStatus>('/logout', { method: 'POST' })
      setStatus(updated)
      notifyChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleRefreshQuota = async () => {
    try {
      setBusy('quota')
      setError(null)
      const updated = await fetchApi<CommandCodeWebStatus>('/quota', { method: 'POST' })
      setStatus(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleRefreshCatalog = async () => {
    try {
      setBusy('catalog')
      setError(null)
      const updated = await fetchApi<CommandCodeWebStatus>('/catalog/refresh', { method: 'POST' })
      setStatus(updated)
      const drafts: Record<string, string> = {}
      for (const model of updated.models) {
        drafts[model.id] = formatCapacity(updated.contextWindowOverrides[model.id] || model.defaultContextWindow)
      }
      setContextDrafts(drafts)
      notifyChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleTestConnection = async () => {
    try {
      setBusy('connection')
      setError(null)
      await fetchApi('/connection/test', { method: 'POST' })
      await loadStatus(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const applyEnabled = async (enabledModelIds: string[]) => {
    try {
      const updated = await fetchApi<CommandCodeWebStatus>('/models', {
        method: 'POST',
        body: JSON.stringify({ enabledModelIds }),
      })
      setStatus(updated)
      notifyChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const toggleEnabled = async (enabled: boolean) => {
    setStatus((prev) => prev ? { ...prev, enabled } : prev)
    try {
      const updated = await fetchApi<CommandCodeWebStatus>('/settings', {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      })
      setStatus(updated)
      notifyChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      void loadStatus(true)
    }
  }

  const toggleModel = (modelId: string, checked: boolean) => {
    if (!status) return
    const current = status.models.filter((model) => model.enabled).map((model) => model.id)
    const next = checked ? [...new Set([...current, modelId])] : current.filter((id) => id !== modelId)
    void applyEnabled(next)
  }

  const setAllModels = (selectAll: boolean) => {
    if (!status || status.models.length === 0) return
    void applyEnabled(selectAll ? status.models.map((model) => model.id) : [])
  }

  const handleUpdateEffort = async (effort: CommandCodeReasoningEffort | null) => {
    try {
      const updated = await fetchApi<CommandCodeWebStatus>('/settings', {
        method: 'POST',
        body: JSON.stringify({ defaultReasoningEffort: effort }),
      })
      setStatus(updated)
      notifyChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleSaveContextWindow = async (modelId: string) => {
    const raw = contextDrafts[modelId] || ''
    const parsed = parsePositiveCapacity(raw)
    if (parsed === null) {
      setError(`Invalid context capacity: ${raw}`)
      return
    }
    try {
      setSavingModel(modelId)
      setError(null)
      const updated = await fetchApi<CommandCodeWebStatus>('/settings', {
        method: 'POST',
        body: JSON.stringify({ contextWindowOverrides: { [modelId]: parsed } }),
      })
      setStatus(updated)
      setContextDrafts((prev) => ({ ...prev, [modelId]: formatCapacity(parsed) }))
      notifyChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingModel(null)
    }
  }

  if (loading) {
    return (
      <div className="dsha-page">
        <div className="dsha-empty">{t.loading}</div>
      </div>
    )
  }

  const quota = status?.quota
  const account = status?.account
  const visibleCount = status?.models.filter((model) => model.enabled).length || 0

  return (
    <div className="dsha-page">
      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{status?.authenticated ? t.account : t.signedOut}</h3>
        </div>
        <div className="dsha-row">
          <span className="dsha-label">{status?.authenticated ? t.signedIn : t.signedOut}</span>
          <span className="dsha-value">{account?.email || account?.userName || '—'}</span>
        </div>
        {status?.authenticated && (
          <>
            <div className="dsha-row">
              <span className="dsha-label">{t.plan}</span>
              <span className="dsha-value">{quota?.planName || account?.planLabel || t.planUnknown}</span>
            </div>
            <div className="dsha-row">
              <span className="dsha-label">{t.keyName}</span>
              <span className="dsha-value">{account?.keyName || '—'}</span>
            </div>
            {quota?.subscriptionStatus && (
              <div className="dsha-row">
                <span className="dsha-label">{t.subscription}</span>
                <span className="dsha-value">
                  {quota.subscriptionStatus}
                  {quota.periodEndsAt !== null ? ` · ${t.renews} ${formatDate(quota.periodEndsAt)}` : ''}
                </span>
              </div>
            )}
            {account?.organizationName && (
              <div className="dsha-row">
                <span className="dsha-label">{t.organization}</span>
                <span className="dsha-value">{account.organizationName}</span>
              </div>
            )}
            <div className="dsha-row">
              <span className="dsha-label">{t.authenticatedAt}</span>
              <span className="dsha-value">{formatDate(account?.authenticatedAt)}</span>
            </div>
          </>
        )}
        <div className="dsha-row">
          <span className="dsha-label">{t.storage}</span>
          <span className="dsha-value">{status?.storagePath || '—'}</span>
        </div>
        <p className="dsha-notice">{t.storageNotice}</p>

        <div className="dsha-actions">
          {!status?.authenticated ? (
            <button className="dsha-btn dsha-btn-primary" disabled={busy !== null} onClick={() => void handleLogin()}>
              {busy === 'login' ? (loginProgress || t.signingIn) : t.signIn}
            </button>
          ) : (
            <>
              <button className="dsha-btn dsha-btn-primary" disabled={busy !== null} onClick={() => void handleLogin()}>
                {busy === 'login' ? (loginProgress || t.signingIn) : t.signInAgain}
              </button>
              <button className="dsha-btn" disabled={busy !== null} onClick={() => void handleRefreshQuota()}>
                {busy === 'quota' ? t.refreshingQuota : t.refreshQuota}
              </button>
              <button className="dsha-btn" disabled={busy !== null} onClick={() => void handleLogout()}>
                {t.signOut}
              </button>
            </>
          )}
        </div>
      </section>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.apiKeySection}</h3>
        </div>
        <p className="dsha-muted">{t.apiKeyHint}</p>
        <div className="dsha-capacity-control">
          <input
            type="password"
            aria-label={t.apiKeySection}
            placeholder={t.apiKeyPlaceholder}
            value={apiKey}
            onChange={(event) => setApiKey(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && apiKey.trim() !== '') void handleApiKey()
            }}
          />
          <button
            type="button"
            className="dsha-context-save"
            disabled={busy !== null || apiKey.trim() === ''}
            onClick={() => void handleApiKey()}
          >
            {busy === 'apikey' ? t.apiKeySaving : t.apiKeySave}
          </button>
        </div>
      </section>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.connection}</h3>
        </div>
        <div className="dsha-row" style={{ marginBottom: 12 }}>
          <span className="dsha-label" style={{ fontWeight: 600 }}>{t.enableProvider}</span>
          <input
            type="checkbox"
            checked={status?.enabled !== false}
            disabled={busy !== null}
            onChange={(e) => void toggleEnabled(e.currentTarget.checked)}
          />
        </div>
        <div className="dsha-row">
          <span className="dsha-label">{t.provider}</span>
          <span className="dsha-value">{t.providerValue}</span>
        </div>
        <div className="dsha-row">
          <span className="dsha-label">{t.connectionState}</span>
          <span className="dsha-value">{status?.authenticated ? t.connected : t.untested}</span>
        </div>
        <p className="dsha-notice">{status?.serving === false && status.conflict ? t.routeConflict.replace('{detail}', status.conflict) : t.routeOwned}</p>
        <div className="dsha-actions">
          <button className="dsha-btn" disabled={busy !== null || !status?.authenticated} onClick={() => void handleTestConnection()}>
            {busy === 'connection' ? t.testingConnection : t.testConnection}
          </button>
        </div>
      </section>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.modelsSection}</h3>
          <button className="dsha-btn" disabled={busy !== null} onClick={() => void handleRefreshCatalog()}>
            {busy === 'catalog' ? t.refreshingCatalog : t.refreshCatalog}
          </button>
        </div>
        <p className="dsha-muted dsha-models-hint">{t.modelsHint}</p>
        <div className="dsha-models" aria-label="Command Code Models">
          {status?.models.map((model: CommandCodeModelOption) => {
            return (
              <label key={model.id} title={`${model.id} · ${model.wire === 'anthropic' ? t.wireAnthropic : t.wireOpenai}`}>
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
            {t.selectAll}
          </button>
          <button className="dsha-btn" disabled={busy !== null} onClick={() => setAllModels(false)}>
            {t.unselectAll}
          </button>
        </div>
      </section>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.enhanced}</h3>
        </div>
        <div className="dsha-pref-row">
          <div>
            <strong>{t.defaultReasoningEffort}</strong>
            <p className="dsha-muted">{t.defaultReasoningEffortHint}</p>
          </div>
          <select
            className="dsha-select"
            aria-label={t.defaultReasoningEffort}
            value={status?.defaultReasoningEffort ?? ''}
            disabled={busy !== null}
            onChange={(event) => {
              const value = event.currentTarget.value
              void handleUpdateEffort(value === '' ? null : (value as CommandCodeReasoningEffort))
            }}
          >
            <option value="">{t.defaultEffortAuto}</option>
            {COMMAND_CODE_REASONING_EFFORTS.map((effort) => (
              <option key={effort} value={effort}>{EFFORT_LABELS[effort]}</option>
            ))}
          </select>
        </div>
      </section>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.contextWindowSection}</h3>
        </div>
        <p className="dsha-muted">{t.contextWindowHint}</p>
        <div className="dsha-context-settings">
          {status?.models.map((model: CommandCodeModelOption) => (
            <div key={model.id} className="dsha-context-row">
              <span title={model.id}>{model.name}</span>
              <div className="dsha-capacity-control">
                <input
                  type="text"
                  aria-label={`${model.name} context window`}
                  value={contextDrafts[model.id] ?? ''}
                  onChange={(event) => setContextDrafts({ ...contextDrafts, [model.id]: event.currentTarget.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void handleSaveContextWindow(model.id)
                  }}
                />
                <small>{t.tokens}</small>
                <button
                  type="button"
                  className="dsha-context-save"
                  disabled={savingModel === model.id}
                  onClick={() => void handleSaveContextWindow(model.id)}
                >
                  {savingModel === model.id ? t.saving : t.save}
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.quotaSection}</h3>
          <button className="dsha-btn" disabled={busy !== null || !status?.authenticated} onClick={() => void handleRefreshQuota()}>
            {busy === 'quota' ? t.refreshingQuota : t.refreshQuota}
          </button>
        </div>
        <p className="dsha-muted">{t.quotaDesc}</p>

        {!status?.authenticated ? (
          <div className="dsha-empty">{t.signedOut}</div>
        ) : quota === null || quota === undefined ? (
          <div className="dsha-empty">{busy === 'quota' ? t.refreshingQuota : t.quotaEmpty}</div>
        ) : (
          <div className="dsha-quota-card">
            <div className="dsha-quota-title">
              <strong>{t.quotaCredits}</strong>
              <span>
                {quota.unlimited
                  ? t.quotaUnlimited
                  : quota.creditBalance !== null
                    ? quota.creditBalance
                    : '—'}
              </span>
            </div>

            {quota.windows.map((window) => (
              <div key={window.id} className="dsha-meter-wrap">
                <div className="dsha-meter-label">
                  <span>{window.label}</span>
                  <strong>{Math.max(0, 100 - window.usedPercent)}% left</strong>
                </div>
                <div className="dsha-meter dsha-meter-green">
                  <span style={{ width: `${Math.max(0, 100 - window.usedPercent)}%` }} />
                </div>
                {window.resetsAt !== null && (
                  <div className="dsha-meter-meta">
                    <span>Reset: {formatReset(window.resetsAt)}</span>
                  </div>
                )}
              </div>
            ))}

            {quota.meters.map((meter) => {
              const remaining = meter.remainingFraction
              const percent = remaining === null ? null : Math.round(remaining * 100)
              const isWindow = percent !== null
              return (
                <div key={meter.id} className="dsha-meter-wrap">
                  <div className="dsha-meter-label">
                    <span>{meter.label}</span>
                    <strong>{isWindow ? `${percent}% left` : (meter.limit ?? '—')}</strong>
                  </div>
                  {isWindow && (
                    <div className="dsha-meter dsha-meter-cyan">
                      <span style={{ width: `${percent}%` }} />
                    </div>
                  )}
                  {isWindow ? (
                    <div className="dsha-meter-meta">
                      <span>{meter.used ?? '—'} / {meter.limit ?? '—'}</span>
                      {meter.resetsAt !== null && <span>Reset: {formatReset(meter.resetsAt)}</span>}
                    </div>
                  ) : meter.description !== null ? (
                    <div className="dsha-meter-meta"><span>{meter.description}</span></div>
                  ) : null}
                </div>
              )
            })}

            {quota.meters.length === 0 && quota.windows.length === 0 && (
              <div className="dsha-empty">{t.quotaEmpty}</div>
            )}

            <div className="dsha-timestamp">
              {t.updatedAt.replace('{time}', new Date(quota.fetchedAt).toLocaleString())}
            </div>
          </div>
        )}
      </section>

      {error && (
        <div className="dsha-error">
          <div>{error}</div>
        </div>
      )}
    </div>
  )
}
