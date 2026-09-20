import React, { useCallback, useEffect, useState } from 'react'
import type {
  WorkBuddyAccount,
  WorkBuddyModelOption,
  WorkBuddyReasoningEffort,
  WorkBuddyWebStatus,
} from '../../shared/workbuddy-contracts.ts'
import { WORKBUDDY_REASONING_EFFORTS } from '../../shared/workbuddy-contracts.ts'
import { zh } from './locales.ts'

/**
 * Display label per reasoning level. The locale dictionary only accepts flat
 * string values, so this nested table lives with the control that renders it.
 */
const EFFORT_LABELS: Record<WorkBuddyReasoningEffort, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
}

const API = '/workbuddy/api'

interface Props {
  onModelChange?: () => void
  loadModelDirectory?: () => void
}

interface AccountsPayload {
  authDirectory: string
  accounts: WorkBuddyAccount[]
}

interface ConnectionPayload {
  connected: boolean
  account: WorkBuddyAccount | null
  latencyMs: number
  model: string
  checkedAt: number
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

/** Mask a UIN so the card shows identity without publishing the full number. */
export function maskUin(uin?: string | null): string {
  if (uin === undefined || uin === null || uin === '') return '—'
  if (uin.length <= 6) return uin
  return `${uin.slice(0, 4)}****${uin.slice(-2)}`
}

/** Shorten an absolute credential path to its file name for display. */
export function displayFile(file?: string | null): string {
  if (file === undefined || file === null || file === '') return '—'
  const parts = file.split(/[\\/]/)
  return parts[parts.length - 1] || file
}

export function WorkBuddySection({ onModelChange, loadModelDirectory }: Props): React.ReactElement {
  const [status, setStatus] = useState<WorkBuddyWebStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connection, setConnection] = useState<ConnectionPayload | null>(null)
  const [accounts, setAccounts] = useState<AccountsPayload | null>(null)
  const [contextDrafts, setContextDrafts] = useState<Record<string, string>>({})
  const [savingModel, setSavingModel] = useState<string | null>(null)

  const t = zh

  const notifyChange = useCallback(() => {
    onModelChange?.()
    loadModelDirectory?.()
  }, [onModelChange, loadModelDirectory])

  const loadStatus = useCallback(async (quiet = false) => {
    if (!quiet) setError(null)
    try {
      const data = await fetchApi<WorkBuddyWebStatus>('/status')
      // A response without the expected arrays must still render, so the model
      // list is normalized rather than trusted.
      const normalized: WorkBuddyWebStatus = {
        ...data,
        models: Array.isArray(data?.models) ? data.models : [],
        contextWindowOverrides: data?.contextWindowOverrides ?? {},
      }
      setStatus(normalized)
      const drafts: Record<string, string> = {}
      for (const model of normalized.models) {
        drafts[model.id] = formatCapacity(normalized.contextWindowOverrides[model.id] || model.defaultContextWindow)
      }
      setContextDrafts(drafts)
    } catch (err) {
      if (!quiet) setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  const loadAccounts = useCallback(async () => {
    try {
      const payload = await fetchApi<AccountsPayload>('/accounts')
      // Defend against a response without the expected list: the account list
      // is supplementary, and a malformed payload must not take down the card.
      setAccounts({
        authDirectory: payload?.authDirectory ?? '',
        accounts: Array.isArray(payload?.accounts) ? payload.accounts : [],
      })
    } catch {
      // The status call already reports whether a credential exists at all.
    }
  }, [])

  useEffect(() => {
    void loadStatus()
    void loadAccounts()
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        void loadStatus(true)
        void loadAccounts()
      }
    }
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => document.removeEventListener('visibilitychange', refreshWhenVisible)
  }, [loadStatus, loadAccounts])

  const handleRescan = async () => {
    try {
      setBusy('rescan')
      setError(null)
      const updated = await fetchApi<WorkBuddyWebStatus>('/rescan', { method: 'POST' })
      setStatus(updated)
      await loadAccounts()
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
      setConnection(await fetchApi<ConnectionPayload>('/connection/test', { method: 'POST' }))
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
      const updated = await fetchApi<WorkBuddyWebStatus>('/quota', { method: 'POST' })
      setStatus(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const toggleEnabled = async (enabled: boolean) => {
    try {
      setBusy('enabled')
      setError(null)
      const updated = await fetchApi<WorkBuddyWebStatus>('/settings', {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      })
      setStatus(updated)
      notifyChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const toggleModel = async (modelId: string, enabled: boolean) => {
    if (status === null) return
    const current = status.models.filter((model) => model.enabled).map((model) => model.id)
    const next = enabled
      ? [...new Set([...current, modelId])]
      : current.filter((id) => id !== modelId)
    try {
      setBusy(`model:${modelId}`)
      setError(null)
      const updated = await fetchApi<WorkBuddyWebStatus>('/settings', {
        method: 'POST',
        body: JSON.stringify({ enabledModelIds: next }),
      })
      setStatus(updated)
      notifyChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const setAllModels = async (enabled: boolean) => {
    if (status === null) return
    try {
      setBusy('models-all')
      setError(null)
      const updated = await fetchApi<WorkBuddyWebStatus>('/settings', {
        method: 'POST',
        body: JSON.stringify({ enabledModelIds: enabled ? status.models.map((model) => model.id) : [] }),
      })
      setStatus(updated)
      notifyChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleUpdateEffort = async (effort: WorkBuddyReasoningEffort | null) => {
    try {
      setBusy('effort')
      setError(null)
      const updated = await fetchApi<WorkBuddyWebStatus>('/settings', {
        method: 'POST',
        body: JSON.stringify({ defaultReasoningEffort: effort }),
      })
      setStatus(updated)
      notifyChange()
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
      const updated = await fetchApi<WorkBuddyWebStatus>('/catalog/refresh', { method: 'POST' })
      const normalized: WorkBuddyWebStatus = {
        ...updated,
        models: Array.isArray(updated?.models) ? updated.models : [],
        contextWindowOverrides: updated?.contextWindowOverrides ?? {},
      }
      setStatus(normalized)
      const drafts: Record<string, string> = {}
      for (const model of normalized.models) {
        drafts[model.id] = formatCapacity(normalized.contextWindowOverrides[model.id] || model.defaultContextWindow)
      }
      setContextDrafts(drafts)
      notifyChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
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
      const updated = await fetchApi<WorkBuddyWebStatus>('/settings', {
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
  const authenticated = status?.authenticated === true

  return (
    <div className="dsha-page">
      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{authenticated ? t.account : t.signedOut}</h3>
          <button className="dsha-btn" disabled={busy !== null} onClick={() => void handleRescan()}>
            {busy === 'rescan' ? t.rescanning : t.rescan}
          </button>
        </div>

        {!authenticated ? (
          <>
            <div className="dsha-empty">{t.notFoundTitle}</div>
            <p className="dsha-notice">{t.notFoundHint}</p>
          </>
        ) : (
          <>
            <div className="dsha-row">
              <span className="dsha-label">{t.nickname}</span>
              <span className="dsha-value">{account?.nickname || '—'}</span>
            </div>
            <div className="dsha-row">
              <span className="dsha-label">{t.uid}</span>
              <span className="dsha-value dshwb-mono">{account?.uid || '—'}</span>
            </div>
            <div className="dsha-row">
              <span className="dsha-label">{t.uin}</span>
              <span className="dsha-value dshwb-mono">{maskUin(account?.uin)}</span>
            </div>
            <div className="dsha-row">
              <span className="dsha-label">{t.region}</span>
              <span className="dsha-value">
                {account?.region === 'intl' ? t.regionIntl : t.regionCn}
                {account?.accountType ? ` · ${account.accountType}` : ''}
              </span>
            </div>
            <div className="dsha-row">
              <span className="dsha-label">{t.domain}</span>
              <span className="dsha-value dshwb-mono">{account?.domain || '—'}</span>
            </div>
            <div className="dsha-row">
              <span className="dsha-label">{t.backend}</span>
              <span className="dsha-value dshwb-mono">{account?.backend || '—'}</span>
            </div>
            <div className="dsha-row">
              <span className="dsha-label">{t.tokenExpires}</span>
              <span className="dsha-value">
                {account?.expiresAt === null || account?.expiresAt === undefined
                  ? '—'
                  : account.expiresAt <= Date.now()
                    ? t.tokenExpired
                    : formatDate(account.expiresAt)}
              </span>
            </div>
            <div className="dsha-row">
              <span className="dsha-label">{t.sourceFile}</span>
              <span className="dsha-value dshwb-mono" title={account?.sourceFile ?? ''}>
                {displayFile(account?.sourceFile)}
              </span>
            </div>
          </>
        )}

        <div className="dsha-row">
          <span className="dsha-label">{t.authDirectory}</span>
          <span className="dsha-value dshwb-mono">{status?.authDirectory || '—'}</span>
        </div>
        <p className="dsha-notice">{t.storageNotice}</p>
      </section>

      {accounts !== null && (accounts.accounts?.length ?? 0) > 1 && (
        <section className="dsha-group">
          <div className="dsha-grouphead">
            <h3>{t.accounts}</h3>
          </div>
          <p className="dsha-muted">{t.accountsHint}</p>
          <div className="dsha-accounts-list">
            {accounts.accounts.map((candidate) => {
              const isActive = candidate.sourceFile === account?.sourceFile
              return (
                <div key={candidate.sourceFile ?? candidate.uid ?? Math.random()} className={`dsha-account-card${isActive ? ' active' : ''}`}>
                  <div className="dsha-account-header">
                    <div className="dsha-account-identity">
                      <span className="dsha-account-title">{candidate.nickname || candidate.uid || '—'}</span>
                    </div>
                    <div className="dsha-badges">
                      <span className="dsha-badge primary">
                        {candidate.region === 'intl' ? t.regionIntl : t.regionCn}
                      </span>
                      {isActive && <span className="dsha-badge active">{t.signedIn}</span>}
                    </div>
                  </div>
                  <div className="dsha-account-details">
                    <span className="dshwb-mono">{displayFile(candidate.sourceFile)}</span>
                    {candidate.expiresAt !== null && <span>{formatDate(candidate.expiresAt)}</span>}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

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
          <span className="dsha-value">
            {connection?.connected ? t.connected : authenticated ? t.untested : t.signedOut}
            {connection?.connected ? ` · ${connection.latencyMs}ms · ${connection.model}` : ''}
          </span>
        </div>
        <p className="dsha-notice">
          {status?.serving === false && status.conflict
            ? t.routeConflict.replace('{detail}', status.conflict)
            : t.routeOwned}
        </p>
        <div className="dsha-actions">
          <button
            className="dsha-btn"
            disabled={busy !== null || !authenticated}
            onClick={() => void handleTestConnection()}
          >
            {busy === 'connection' ? t.testingConnection : t.testConnection}
          </button>
        </div>
      </section>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.modelsSection}</h3>
          <button
            className="dsha-btn"
            disabled={busy !== null || !authenticated}
            onClick={() => void handleRefreshCatalog()}
          >
            {busy === 'catalog' ? t.refreshingCatalog : t.refreshCatalog}
          </button>
        </div>
        <p className="dsha-muted dsha-models-hint">{t.modelsHint}</p>
        <div className="dsha-models" aria-label="WorkBuddy Models">
          {status?.models.map((model: WorkBuddyModelOption) => (
            <label key={model.id} title={model.description ?? model.id}>
              <input
                type="checkbox"
                checked={model.enabled}
                disabled={busy !== null}
                onChange={(event) => void toggleModel(model.id, event.currentTarget.checked)}
              />
              <span className="dshwb-model">
                <span>{model.name}</span>
                <span className="dshwb-model-meta">
                  {formatCapacity(model.contextWindow)}
                  {' · '}
                  {model.supportsImage ? t.imageSupport : t.textOnly}
                  {model.reasoningEfforts && model.reasoningEfforts.length > 0 ? ` · ${model.reasoningEfforts.join('/')}` : ''}
                </span>
              </span>
            </label>
          ))}
        </div>
        <div className="dsha-actions">
          <button className="dsha-btn" disabled={busy !== null} onClick={() => void setAllModels(true)}>
            {t.selectAll}
          </button>
          <button className="dsha-btn" disabled={busy !== null} onClick={() => void setAllModels(false)}>
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
              void handleUpdateEffort(value === '' ? null : (value as WorkBuddyReasoningEffort))
            }}
          >
            <option value="">{t.defaultEffortAuto}</option>
            {WORKBUDDY_REASONING_EFFORTS.map((effort) => (
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
          {status?.models.map((model: WorkBuddyModelOption) => (
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
                <small>tokens</small>
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
            disabled={busy !== null || !authenticated}
            onClick={() => void handleRefreshQuota()}
          >
            {busy === 'quota' ? t.refreshingQuota : t.refreshQuota}
          </button>
        </div>
        <p className="dsha-muted">{t.quotaDesc}</p>

        {!authenticated ? (
          <div className="dsha-empty">{t.signedOut}</div>
        ) : quota === null || quota === undefined ? (
          <div className="dsha-empty">{busy === 'quota' ? t.refreshingQuota : t.quotaEmpty}</div>
        ) : (
          <div className="dsha-quota-card">
            <div className="dsha-quota-title">
              <strong>{quota.packageName || t.quotaPackage}</strong>
              <span>
                {quota.remainingCredits !== null
                  ? `${quota.remainingCredits} ${t.credits}`
                  : '—'}
              </span>
            </div>

            {quota.cycleUsedCredits !== null && (
              <div className="dsha-row">
                <span className="dsha-label">{t.quotaCycle}</span>
                <span className="dsha-value">
                  {quota.cycleUsedCredits}
                  {quota.cycleCredits !== null ? ` / ${quota.cycleCredits}` : ''}
                  {` ${t.credits}`}
                </span>
              </div>
            )}
            {quota.cycleEndsAt !== null && (
              <div className="dsha-row">
                <span className="dsha-label">{t.quotaReset}</span>
                <span className="dsha-value">
                  {formatDate(quota.cycleEndsAt)}
                  {formatReset(quota.cycleEndsAt) ? ` · ${formatReset(quota.cycleEndsAt)}` : ''}
                </span>
              </div>
            )}

            {quota.meters.map((meter) => {
              const remaining = meter.remainingFraction
              const percent = remaining === null ? null : Math.round(remaining * 100)
              return (
                <div key={meter.id} className="dsha-meter-wrap">
                  <div className="dsha-meter-label">
                    <span>{meter.label}</span>
                    <strong>{percent === null ? (meter.limit ?? '—') : `${percent}% left`}</strong>
                  </div>
                  {percent !== null && (
                    <div className="dsha-meter dsha-meter-green">
                      <span style={{ width: `${percent}%` }} />
                    </div>
                  )}
                  <div className="dsha-meter-meta">
                    {meter.used !== null && <span>{meter.used} / {meter.limit ?? '—'}</span>}
                    {meter.resetsAt !== null && <span>{t.quotaReset}: {formatReset(meter.resetsAt)}</span>}
                  </div>
                </div>
              )
            })}

            {quota.meters.length === 0 && <div className="dsha-empty">{t.quotaEmpty}</div>}

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
