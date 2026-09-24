import React, { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ZhipuAccountSummaryDto,
  ZhipuModelOption,
  ZhipuReasoningEffort,
  ZhipuRegion,
  ZhipuWebStatus,
} from '../../shared/zhipu-contracts.ts'
import { ZHIPU_REASONING_EFFORTS } from '../../shared/zhipu-contracts.ts'
import { createQuotaFollowUp, type QuotaFollowUp } from '../common/quota-follow-up.ts'

/**
 * Display label per reasoning level. The locale dictionary only accepts flat
 * string values, so this table lives with the control that renders it.
 */
const EFFORT_LABELS: Record<ZhipuReasoningEffort, string> = {
  low: 'Low',
  high: 'High',
  max: 'Max',
}

import { AccountPoolSection } from '../common/AccountPoolSection.tsx'
import type { AccountRotationStrategy } from '../../shared/account-pool-contracts.ts'
import { zh } from './locales.ts'

const API = '/zhipu/api'

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

/**
 * Seed one draft per model from a status payload. Also run after a model
 * toggle: a model that was just enabled has no draft yet, and the context
 * window section only renders enabled models.
 */
function contextDraftsFor(status: ZhipuWebStatus): Record<string, string> {
  const drafts: Record<string, string> = {}
  for (const model of status.models) {
    drafts[model.id] = formatCapacity(status.contextWindowOverrides[model.id] || model.defaultContextWindow)
  }
  return drafts
}

function formatDate(ms?: number | null): string {
  if (ms === undefined || ms === null || ms <= 0) return '—'
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(ms)
  } catch {
    return '—'
  }
}

function formatReset(resetsAt?: number | null, nowLabel = 'now'): string {
  if (resetsAt === undefined || resetsAt === null || resetsAt <= 0) return ''
  const diff = resetsAt - Date.now()
  if (diff <= 0) return nowLabel
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${mins % 60}m`
  return `${mins}m`
}

export function ZhipuSection({ onModelChange, loadModelDirectory }: Props): React.ReactElement {
  const [status, setStatus] = useState<ZhipuWebStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [contextDrafts, setContextDrafts] = useState<Record<string, string>>({})
  const [savingModel, setSavingModel] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [region, setRegion] = useState<ZhipuRegion>('intl')

  /** Follow-up poll owed while the host refreshes the quota behind an answer. */
  const quotaFollowUp = useRef<QuotaFollowUp | null>(null)

  const t = zh

  const notifyChange = useCallback(() => {
    onModelChange?.()
    loadModelDirectory?.()
  }, [onModelChange, loadModelDirectory])

  const loadStatus = useCallback(async (quiet = false) => {
    if (!quiet) setError(null)
    try {
      const data = await fetchApi<ZhipuWebStatus>('/status')
      setStatus(data)
      setContextDrafts(contextDraftsFor(data))
      // An answer that refreshed the quota behind itself is followed up shortly,
      // so the fresh numbers land without waiting for the next poll.
      quotaFollowUp.current ??= createQuotaFollowUp()
      quotaFollowUp.current.observe(data.quotaRefreshing === true, () => { void loadStatus(true) })
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
      quotaFollowUp.current?.cancel()
    }
  }, [loadStatus])

  /**
   * Save one pasted key.
   *
   * The host verifies it against the deployment before persisting, so a key
   * from the wrong console fails here with a message naming the console it
   * belongs to rather than inside a conversation later.
   */
  const handleAddKey = async () => {
    try {
      setBusy('apikey')
      setError(null)
      const updated = await fetchApi<ZhipuWebStatus>('/accounts/add', {
        method: 'POST',
        body: JSON.stringify({ apiKey, region }),
      })
      setStatus(updated)
      setContextDrafts(contextDraftsFor(updated))
      setApiKey('')
      notifyChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  /** One account-level action on the shared pool card. */
  const handleAccountAction = async (
    action: 'set-primary' | 'delete' | 'clear-cooldown',
    accountId: string,
  ) => {
    try {
      setBusy(`${action}-${accountId}`)
      setError(null)
      const updated = await fetchApi<ZhipuWebStatus>('/accounts/action', {
        method: 'POST',
        body: JSON.stringify({ action, accountId }),
      })
      setStatus(updated)
      notifyChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleSetStrategy = async (strategy: AccountRotationStrategy) => {
    try {
      setBusy('strategy')
      setError(null)
      const updated = await fetchApi<ZhipuWebStatus>('/accounts/action', {
        method: 'POST',
        body: JSON.stringify({ action: 'strategy', strategy }),
      })
      setStatus(updated)
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
      const updated = await fetchApi<ZhipuWebStatus>('/quota', { method: 'POST' })
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
      const updated = await fetchApi<ZhipuWebStatus>('/catalog/refresh', { method: 'POST' })
      setStatus(updated)
      setContextDrafts(contextDraftsFor(updated))
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
      const updated = await fetchApi<ZhipuWebStatus>('/models', {
        method: 'POST',
        body: JSON.stringify({ enabledModelIds }),
      })
      setStatus(updated)
      // A model that was just checked has no draft yet; the context window
      // section only renders enabled models.
      setContextDrafts(contextDraftsFor(updated))
      notifyChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const toggleEnabled = async (enabled: boolean) => {
    setStatus((prev) => prev ? { ...prev, enabled } : prev)
    try {
      const updated = await fetchApi<ZhipuWebStatus>('/settings', {
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

  const handleUpdateEffort = async (effort: ZhipuReasoningEffort | null) => {
    try {
      const updated = await fetchApi<ZhipuWebStatus>('/settings', {
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
      const updated = await fetchApi<ZhipuWebStatus>('/settings', {
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

  /** Clear one override; the row falls back to the declared window. */
  const handleResetContextWindow = async (modelId: string) => {
    try {
      setSavingModel(modelId)
      setError(null)
      const updated = await fetchApi<ZhipuWebStatus>('/settings', {
        method: 'POST',
        body: JSON.stringify({ contextWindowOverrides: { [modelId]: null } }),
      })
      setStatus(updated)
      setContextDrafts((prev) => {
        const model = updated.models.find((candidate) => candidate.id === modelId)
        return model === undefined ? prev : { ...prev, [modelId]: formatCapacity(model.defaultContextWindow) }
      })
      notifyChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingModel(null)
    }
  }

  /** Clear every stored override, including models the picker no longer shows. */
  const handleResetAllContextWindows = async () => {
    const models = Object.keys(status?.contextWindowOverrides ?? {})
    if (models.length === 0) return
    if (typeof window !== 'undefined' && !window.confirm(t.contextWindowResetAllConfirm)) return
    try {
      setBusy('context')
      setError(null)
      const updated = await fetchApi<ZhipuWebStatus>('/settings', {
        method: 'POST',
        body: JSON.stringify({ contextWindowOverrides: Object.fromEntries(models.map((model) => [model, null])) }),
      })
      setStatus(updated)
      setContextDrafts(contextDraftsFor(updated))
      notifyChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return (
      <div className="dsha-page">
        <div className="dsha-empty">{t.loading}</div>
      </div>
    )
  }

  // Only checked models get a context row; the batch restore still covers every
  // stored override, including one left behind by a model the user unchecked.
  const contextModels = status?.models.filter((model) => model.enabled) ?? []
  const overrideCount = Object.keys(status?.contextWindowOverrides ?? {}).length
  const quota = status?.quota
  const account = status?.account
  const hasMeters = (quota?.meters.length ?? 0) > 0

  return (
    <div className="dsha-page">
      <AccountPoolSection
        accounts={(status?.accounts ?? []) as ZhipuAccountSummaryDto[]}
        activeAccountId={status?.activeAccountId}
        rotationStrategy={status?.rotationStrategy ?? 'sequential'}
        busy={busy}
        labels={t}
        // Adding an account here is pasting a key rather than a browser flow,
        // so the card's own button focuses the key input the children render.
        onLogin={() => {
          document.querySelector<HTMLInputElement>(`.dsha-page input[type=password]`)?.focus()
        }}
        onSetPrimary={(accountId) => void handleAccountAction('set-primary', accountId)}
        onDelete={(accountId) => void handleAccountAction('delete', accountId)}
        onClearCooldown={(accountId) => void handleAccountAction('clear-cooldown', accountId)}
        onSetStrategy={(strategy) => void handleSetStrategy(strategy)}
        storageValue={status?.storagePath || '—'}
        renderDetails={(entry) => (
          <>
            {entry.keyHint && <span>{t.keyHint}: {entry.keyHint}</span>}
            {entry.region && <span>{t.region}: {entry.region === 'cn' ? t.regionCn : t.regionIntl}</span>}
            {entry.planLabel && <span>{t.plan}: {entry.planLabel}</span>}
          </>
        )}
      >
        <p className="dsha-muted" style={{ paddingTop: 12 }}>{t.addKeyHint}</p>
        <div className="dsha-capacity-control dshzp-keyrow">
          <select
            className="dsha-select"
            aria-label={t.region}
            value={region}
            onChange={(event) => setRegion(event.currentTarget.value === 'cn' ? 'cn' : 'intl')}
          >
            <option value="intl">{t.regionIntl}</option>
            <option value="cn">{t.regionCn}</option>
          </select>
          <input
            type="password"
            aria-label={t.addKeySection}
            placeholder={t.keyPlaceholder}
            value={apiKey}
            onChange={(event) => setApiKey(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && apiKey.trim() !== '') void handleAddKey()
            }}
          />
          <button
            type="button"
            className="dsha-context-save"
            disabled={busy !== null || apiKey.trim() === ''}
            onClick={() => void handleAddKey()}
          >
            {busy === 'apikey' ? t.keySaving : t.keySave}
          </button>
        </div>
      </AccountPoolSection>

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
        {account && (
          <div className="dsha-row">
            <span className="dsha-label">{t.account}</span>
            <span className="dsha-value">
              {account.keyHint} · {account.region === 'cn' ? t.regionCn : t.regionIntl}
            </span>
          </div>
        )}
        {account?.planLabel && (
          <div className="dsha-row">
            <span className="dsha-label">{t.plan}</span>
            <span className="dsha-value">{account.planLabel}</span>
          </div>
        )}
        <div className="dsha-row">
          <span className="dsha-label">{t.storage}</span>
          <span className="dsha-value">{status?.storagePath ?? '—'}</span>
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
        <div className="dsha-models" aria-label="GLM Coding Plan Models">
          {status?.models.map((model: ZhipuModelOption) => {
            const capabilities = [
              model.supportsImage ? 'image' : null,
              model.reasoningEfforts.length > 0 ? model.reasoningEfforts.join('/') : null,
              `${t.effectiveWindow} ${formatCapacity(model.contextWindow)}`,
            ].filter((part): part is string => part !== null).join(' · ')
            return (
              <label key={model.id} title={`${model.id} · ${capabilities}`}>
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
              void handleUpdateEffort(value === '' ? null : (value as ZhipuReasoningEffort))
            }}
          >
            <option value="">{t.defaultEffortAuto}</option>
            {ZHIPU_REASONING_EFFORTS.map((effort) => (
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
          {contextModels.length === 0 && (
            <p className="dsha-muted">{t.contextWindowNoneEnabled}</p>
          )}
          {contextModels.map((model: ZhipuModelOption) => (
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
                <button
                  type="button"
                  className="dsha-context-save dsha-context-reset"
                  aria-label={`${model.name} ${t.contextWindowReset}`}
                  disabled={savingModel === model.id || status?.contextWindowOverrides[model.id] === undefined}
                  onClick={() => void handleResetContextWindow(model.id)}
                >
                  {t.contextWindowReset}
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
              {t.contextWindowResetAll}
            </button>
          </div>
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
          <div className="dsha-empty">
            {busy === 'quota' ? t.refreshingQuota : (status.quotaError ?? t.quotaEmpty)}
          </div>
        ) : (
          <div className="dsha-quota-card">
            <div className="dsha-quota-title">
              <strong>{quota.planName ?? t.quotaSection}</strong>
              <span>{quota.planLevel ?? t.planUnknown}</span>
            </div>
            {quota.renewsAt !== null && (
              <div className="dsha-meter-meta">
                <span>{t.renews}: {formatDate(quota.renewsAt)}</span>
              </div>
            )}

            {quota.windows.map((window) => {
              const percent = window.remainingFraction === null ? null : Math.round(window.remainingFraction * 100)
              return (
                <div key={window.id} className="dsha-meter-wrap">
                  <div className="dsha-meter-label">
                    <span>{window.label}</span>
                    <strong>{percent === null ? '—' : `${percent}% ${t.left}`}</strong>
                  </div>
                  {percent !== null && (
                    <div className="dsha-meter dsha-meter-green">
                      <span style={{ width: `${Math.max(0, percent)}%` }} />
                    </div>
                  )}
                  <div className="dsha-meter-meta">
                    <span>{window.used ?? '—'} / {window.limit ?? '—'}</span>
                    {window.resetsAt !== null && <span>{t.resetAt}: {formatReset(window.resetsAt, t.now)}</span>}
                  </div>
                </div>
              )
            })}

            {quota.meters
              .filter((meter) => !quota.windows.some((window) => window.id === meter.id))
              .map((meter) => {
                const percent = meter.remainingFraction === null ? null : Math.round(meter.remainingFraction * 100)
                return (
                  <div key={meter.id} className="dsha-meter-wrap">
                    <div className="dsha-meter-label">
                      <span>{meter.label}</span>
                      <strong>{percent === null ? '—' : `${percent}% ${t.left}`}</strong>
                    </div>
                    {percent !== null && (
                      <div className="dsha-meter dsha-meter-cyan">
                        <span style={{ width: `${Math.max(0, percent)}%` }} />
                      </div>
                    )}
                    <div className="dsha-meter-meta">
                      <span>{meter.used ?? '—'} / {meter.limit ?? '—'}</span>
                      {meter.resetsAt !== null && <span>{t.resetAt}: {formatReset(meter.resetsAt, t.now)}</span>}
                    </div>
                  </div>
                )
              })}

            {!hasMeters && <div className="dsha-empty">{t.quotaUnavailable}</div>}

            <div className="dsha-timestamp">
              {t.updatedAt.replace('{time}', new Date(quota.fetchedAt).toLocaleString())}
            </div>
          </div>
        )}

        {status?.quotaError && quota !== null && quota !== undefined && (
          <p className="dsha-muted">{t.quotaError}: {status.quotaError}</p>
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
