import React, { useCallback, useEffect, useState } from 'react'
import type {
  KimiCodeLoginFlowStatus,
  KimiCodeModelOption,
  KimiCodeReasoningEffort,
  KimiCodeWebStatus,
} from '../../shared/kimi-code-contracts.ts'
import { KIMI_CODE_REASONING_EFFORTS } from '../../shared/kimi-code-contracts.ts'
import { zh } from './locales.ts'
import { KimiModelCapabilities } from './KimiModelCapabilities.tsx'

const API = '/kimi-code/api'

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

/** Money the service reports in minor units, rendered in its own currency. */
function formatMoney(cents: number | null, currency: string | null): string {
  if (cents === null) return '—'
  const code = currency ?? 'USD'
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${code}`
  }
}

const EFFORT_LABEL: Record<KimiCodeReasoningEffort, string> = {
  low: zh.effortLow,
  high: zh.effortHigh,
  max: zh.effortMax,
  none: zh.effortNone,
}

export function KimiCodeSection({ onModelChange, loadModelDirectory }: Props): React.ReactElement {
  const [status, setStatus] = useState<KimiCodeWebStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [flow, setFlow] = useState<KimiCodeLoginFlowStatus | null>(null)
  const [contextDrafts, setContextDrafts] = useState<Record<string, string>>({})
  const [savingModel, setSavingModel] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  // Result of an explicit connection test. The button used to end silently on
  // success, which is indistinguishable from a click that never registered.
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null)

  const t = zh

  const notifyChange = useCallback(() => {
    onModelChange?.()
    loadModelDirectory?.()
  }, [onModelChange, loadModelDirectory])

  const loadStatus = useCallback(async (quiet = false) => {
    if (!quiet) setError(null)
    try {
      const data = await fetchApi<KimiCodeWebStatus>('/status')
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

  // The login flow runs on the host and is polled here, because authorization
  // happens in a browser the card does not control.
  useEffect(() => {
    if (flow?.status !== 'pending') return
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const poll = await fetchApi<KimiCodeLoginFlowStatus>('/login/status')
          setFlow(poll)
          if (poll.status === 'complete') {
            await loadStatus()
            notifyChange()
          } else if (poll.status === 'error') {
            setError(poll.error || t.loginFailed)
          }
        } catch {
          // A failed poll is transient; the next tick retries.
        }
      })()
    }, 2000)
    return () => window.clearInterval(timer)
  }, [flow?.status, loadStatus, notifyChange, t.loginFailed])

  const handleLogin = async () => {
    try {
      setBusy('login')
      setError(null)
      setCopied(false)
      const next = await fetchApi<KimiCodeLoginFlowStatus>('/login', {
        method: 'POST',
        body: JSON.stringify({}),
      })
      setFlow(next)
      // The host already opened the browser; a failed launch is recoverable
      // because the card always renders the URL and the user code.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleCancelLogin = async () => {
    try {
      await fetchApi<KimiCodeLoginFlowStatus>('/login/cancel', { method: 'POST' })
      setFlow({ status: 'idle' })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleCopyCode = async () => {
    const code = flow?.userCode
    if (!code) return
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access can be denied; the code stays visible to copy by hand.
    }
  }

  const handleLogout = async () => {
    try {
      setBusy('logout')
      setError(null)
      const updated = await fetchApi<KimiCodeWebStatus>('/logout', { method: 'POST' })
      setStatus(updated)
      setFlow({ status: 'idle' })
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
      // The host reports the real outcome; a failure arrives as a thrown error
      // carrying the upstream reason rather than an indistinguishable 200.
      const updated = await fetchApi<KimiCodeWebStatus>('/quota', { method: 'POST' })
      setStatus(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      // Re-read so the card still shows the account and any recorded reason.
      await loadStatus(true)
    } finally {
      setBusy(null)
    }
  }

  const handleRefreshCatalog = async () => {
    try {
      setBusy('catalog')
      setError(null)
      const updated = await fetchApi<KimiCodeWebStatus>('/catalog/refresh', { method: 'POST' })
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
      setConnectionNotice(null)
      const result = await fetchApi<{ connected: boolean; latencyMs: number }>('/connection/test', {
        method: 'POST',
      })
      setConnectionNotice(result.connected ? `${t.testSuccess} · ${result.latencyMs} ms` : t.testFailed)
      // The probe is a real usage call, so the quota shown is now current.
      await loadStatus(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const applyEnabled = async (enabledModelIds: string[]) => {
    try {
      const updated = await fetchApi<KimiCodeWebStatus>('/models', {
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
    try {
      const updated = await fetchApi<KimiCodeWebStatus>('/settings', {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      })
      setStatus(updated)
      notifyChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
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

  const handleUpdateEffort = async (effort: KimiCodeReasoningEffort | null) => {
    try {
      const updated = await fetchApi<KimiCodeWebStatus>('/settings', {
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
      const updated = await fetchApi<KimiCodeWebStatus>('/settings', {
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
  const loginPending = flow?.status === 'pending'

  return (
    <div className="dsha-page">
      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{status?.authenticated ? t.account : t.signedOut}</h3>
        </div>
        <div className="dsha-row">
          <span className="dsha-label">{status?.authenticated ? t.signedIn : t.signedOut}</span>
          <span className="dsha-value">{account?.nickname || account?.email || account?.userId || '—'}</span>
        </div>
        {status?.authenticated && (
          <>
            <div className="dsha-row">
              <span className="dsha-label">{t.plan}</span>
              <span className="dsha-value">{quota?.planName || account?.planName || t.planUnknown}</span>
            </div>
            {account?.email && (
              <div className="dsha-row">
                <span className="dsha-label">{t.email}</span>
                <span className="dsha-value">{account.email}</span>
              </div>
            )}
            <div className="dsha-row">
              <span className="dsha-label">{t.region}</span>
              <span className="dsha-value">
                {status.region === 'global' ? t.regionGlobal : t.regionMainland}
              </span>
            </div>
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
        {status?.credentialsRejected && (
          <p className="dsha-notice">{t.refreshRejected}</p>
        )}

        {loginPending && (
          <div className="dsha-device-box">
            <strong>{t.deviceCodeSection}</strong>
            <p className="dsha-muted">{t.deviceCodeHint}</p>
            {flow?.userCode && (
              <div className="dsha-code-row">
                <span className="dsha-code">{flow.userCode}</span>
                <button className="dsha-btn" onClick={() => void handleCopyCode()}>
                  {copied ? t.copied : t.copyCode}
                </button>
              </div>
            )}
            {flow?.verificationUriComplete && (
              <a
                className="dsha-link"
                href={flow.verificationUriComplete}
                target="_blank"
                rel="noreferrer noopener"
              >
                {flow.verificationUriComplete}
              </a>
            )}
            <div className="dsha-row">
              <span className="dsha-label">{t.codeExpires}</span>
              <span className="dsha-value">{formatDate(flow?.expiresAt)}</span>
            </div>
            <div className="dsha-actions">
              {flow?.verificationUriComplete && (
                <a
                  className="dsha-btn"
                  href={flow.verificationUriComplete}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {t.openSignInPage}
                </a>
              )}
              <button className="dsha-btn" disabled={busy !== null} onClick={() => void handleCancelLogin()}>
                {t.cancelSignIn}
              </button>
            </div>
          </div>
        )}

        <div className="dsha-actions">
          {!status?.authenticated ? (
            <button
              className="dsha-btn dsha-btn-primary"
              disabled={busy !== null || loginPending}
              onClick={() => void handleLogin()}
            >
              {loginPending ? t.waitingAuthorization : busy === 'login' ? t.requestingCode : t.signIn}
            </button>
          ) : (
            <>
              <button
                className="dsha-btn dsha-btn-primary"
                disabled={busy !== null || loginPending}
                onClick={() => void handleLogin()}
              >
                {loginPending ? t.waitingAuthorization : t.signInAgain}
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
          <span className="dsha-label">{t.oauthHost}</span>
          <span className="dsha-value">{status?.oauthHost || '—'}</span>
        </div>
        <div className="dsha-row">
          <span className="dsha-label">{t.codingEndpoint}</span>
          <span className="dsha-value">{status?.codingBaseUrl || '—'}</span>
        </div>
        <div className="dsha-row">
          <span className="dsha-label">{t.connectionState}</span>
          <span className="dsha-value">{status?.authenticated ? t.connected : t.untested}</span>
        </div>
        <p className="dsha-notice">
          {status?.serving === false && status.conflict
            ? t.routeConflict.replace('{detail}', status.conflict)
            : t.routeOwned}
        </p>
        {connectionNotice && <p className="dsha-muted">{connectionNotice}</p>}
        <div className="dsha-actions">
          <button
            className="dsha-btn"
            disabled={busy !== null || !status?.authenticated}
            onClick={() => void handleTestConnection()}
          >
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
        <div className="dsha-models" aria-label="Kimi Code Models">
          {status?.models.map((model: KimiCodeModelOption) => {
            const facts = [
              model.id,
              model.wire === 'anthropic' ? t.wireAnthropic : t.wireOpenai,
              ...(model.supportsVideo ? [t.capVideo] : []),
              ...(model.supportsDynamicTools ? [t.capDynamicTools] : []),
              ...(model.minimumPlan ? [t.capPlan.replace('{plan}', model.minimumPlan)] : []),
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
            {t.selectAll}
          </button>
          <button className="dsha-btn" disabled={busy !== null} onClick={() => setAllModels(false)}>
            {t.unselectAll}
          </button>
        </div>
        {status !== null && status.models.length > 0 && <KimiModelCapabilities models={status.models} />}
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
              void handleUpdateEffort(value === '' ? null : (value as KimiCodeReasoningEffort))
            }}
          >
            <option value="">{t.defaultEffortAuto}</option>
            {KIMI_CODE_REASONING_EFFORTS.map((effort) => (
              <option key={effort} value={effort}>{EFFORT_LABEL[effort]}</option>
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
          {status?.models.map((model: KimiCodeModelOption) => (
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
          <button
            className="dsha-btn"
            disabled={busy !== null || !status?.authenticated}
            onClick={() => void handleRefreshQuota()}
          >
            {busy === 'quota' ? t.refreshingQuota : t.refreshQuota}
          </button>
        </div>
        <p className="dsha-muted">{t.quotaDesc}</p>

        {status?.quotaError && <p className="dsha-notice">{status.quotaError}</p>}

        {!status?.authenticated ? (
          <div className="dsha-empty">{t.signedOut}</div>
        ) : quota === null || quota === undefined ? (
          <div className="dsha-empty">{busy === 'quota' ? t.refreshingQuota : t.quotaEmpty}</div>
        ) : (
          <div className="dsha-quota-card">
            <div className="dsha-quota-title">
              <strong>{t.quotaPlan}</strong>
              <span>{quota.planName || t.planUnknown}</span>
            </div>

            {quota.windows.map((window) => {
              const remaining = Math.max(0, 100 - window.usedPercent)
              return (
                <div key={window.id} className="dsha-meter-wrap">
                  <div className="dsha-meter-label">
                    <span>{window.label}</span>
                    <strong>{remaining}% left</strong>
                  </div>
                  <div className={`dsha-meter ${remaining <= 10 ? 'dsha-meter-cyan' : 'dsha-meter-green'}`}>
                    <span style={{ width: `${remaining}%` }} />
                  </div>
                  <div className="dsha-meter-meta">
                    <span>
                      {window.used ?? '—'} / {window.limit ?? '—'} {t.requests}
                    </span>
                    {window.resetsAt !== null && (
                      <span>{t.resetAt.replace('{time}', formatReset(window.resetsAt))}</span>
                    )}
                  </div>
                </div>
              )
            })}

            {quota.extraUsage !== null && (
              <div className="dsha-meter-wrap">
                <div className="dsha-meter-label">
                  <span>{t.quotaWallet}</span>
                  <strong>{formatMoney(quota.extraUsage.balanceCents, quota.extraUsage.currency)}</strong>
                </div>
                <div className="dsha-meter-meta">
                  <span>{formatMoney(quota.extraUsage.totalCents, quota.extraUsage.currency)}</span>
                  {quota.extraUsage.monthlyChargeLimitEnabled && quota.extraUsage.monthlyChargeLimitCents !== null && (
                    <span>
                      {t.quotaWalletLimit}: {formatMoney(quota.extraUsage.monthlyChargeLimitCents, quota.extraUsage.currency)}
                    </span>
                  )}
                </div>
              </div>
            )}

            {quota.windows.length === 0 && quota.extraUsage === null && (
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
