import React, { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AccountRotationStrategy,
  AntigravityModelOption,
  AntigravityWebStatus,
} from '../../shared/antigravity-contracts.ts'
import { AccountPoolSection } from '../common/AccountPoolSection.tsx'
import { createQuotaFollowUp, type QuotaFollowUp } from '../common/quota-follow-up.ts'
import { zh } from './locales.ts'

const API = '/antigravity/api'

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
  if (value % 1_000 === 0) return `${value / 1_000}K`
  return String(value)
}

/**
 * Seed one draft per model from a status payload. Also run after a model
 * toggle: a model that was just enabled has no draft yet, and the context
 * window section only renders enabled models.
 */
function contextDraftsFor(status: AntigravityWebStatus): Record<string, string> {
  const drafts: Record<string, string> = {}
  for (const model of status.models) {
    drafts[model.id] = formatCapacity(status.contextWindowOverrides[model.id] || model.defaultContextWindow)
  }
  return drafts
}

function formatResetTime(resetTime?: string): string {
  if (!resetTime) return ''
  const diff = new Date(resetTime).getTime() - Date.now()
  if (diff <= 0) return '现在'
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}天 ${hours % 24}时`
  if (hours > 0) return `${hours}h ${mins % 60}m`
  return `${mins}m`
}

function formatDate(ms?: number): string {
  if (!ms || ms <= 0) return '—'
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(ms)
  } catch {
    return '—'
  }
}

export function AntigravitySection({ onModelChange, loadModelDirectory }: Props): React.ReactElement {
  const [status, setStatus] = useState<AntigravityWebStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [validationUrl, setValidationUrl] = useState<string | null>(null)
  const [loginProgress, setLoginProgress] = useState<string | null>(null)
  const [contextDrafts, setContextDrafts] = useState<Record<string, string>>({})
  const [savingModel, setSavingModel] = useState<string | null>(null)

  /** Follow-up poll owed while the host refreshes the quota behind an answer. */
  const quotaFollowUp = useRef<QuotaFollowUp | null>(null)

  const t = zh

  const notifyChange = useCallback(() => {
    onModelChange?.()
    loadModelDirectory?.()
  }, [onModelChange, loadModelDirectory])

  const loadStatus = useCallback(async (quiet = false) => {
    if (!quiet) {
      setError(null)
      setValidationUrl(null)
    }
    try {
      // The host refreshes a stale quota cache while serving /status, so a second
      // client-side POST /quota here would double every upstream fetch.
      const data = await fetchApi<AntigravityWebStatus>('/status')
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

  const handleLogin = async () => {
    try {
      setBusy('login')
      setError(null)
      setValidationUrl(null)
      setLoginProgress(null)
      const flow = await fetchApi<{ authUrl?: string; status?: string }>('/login', { method: 'POST' })
      if (flow.authUrl) {
        window.open(flow.authUrl, '_blank')
      }
      const pollTimer = setInterval(async () => {
        try {
          const pollStatus = await fetchApi<{
            status: string
            error?: string
            validationUrl?: string
            progress?: string
          }>('/login/status')
          if (pollStatus.progress) {
            setLoginProgress(pollStatus.progress)
          }
          if (pollStatus.status === 'complete') {
            clearInterval(pollTimer)
            setBusy(null)
            setLoginProgress(null)
            await loadStatus()
            notifyChange()
          } else if (pollStatus.status === 'error') {
            clearInterval(pollTimer)
            setBusy(null)
            setLoginProgress(null)
            setError(pollStatus.error || t.loginFailed)
            if (pollStatus.validationUrl) {
              setValidationUrl(pollStatus.validationUrl)
            }
          }
        } catch {
          // ignore
        }
      }, 1500)

      setTimeout(() => {
        clearInterval(pollTimer)
        setBusy(null)
        setLoginProgress(null)
      }, 5 * 60 * 1000)
    } catch (err) {
      setBusy(null)
      setLoginProgress(null)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleRefreshQuota = async () => {
    try {
      setBusy('quota')
      setError(null)
      const updated = await fetchApi<AntigravityWebStatus>('/quota', { method: 'POST' })
      setStatus(updated)
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
      const updated = await fetchApi<AntigravityWebStatus>('/logout', { method: 'POST' })
      setStatus(updated)
      notifyChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleSetPrimary = async (accountId: string) => {
    try {
      setBusy(`primary-${accountId}`)
      setError(null)
      const updated = await fetchApi<AntigravityWebStatus>('/accounts', {
        method: 'POST',
        body: JSON.stringify({ action: 'set-primary', accountId }),
      })
      setStatus(updated)
      notifyChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleDeleteAccount = async (accountId: string) => {
    try {
      setBusy(`delete-${accountId}`)
      setError(null)
      const updated = await fetchApi<AntigravityWebStatus>('/accounts', {
        method: 'POST',
        body: JSON.stringify({ action: 'delete', accountId }),
      })
      setStatus(updated)
      notifyChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleClearCooldown = async (accountId: string) => {
    try {
      setBusy(`cooldown-${accountId}`)
      setError(null)
      const updated = await fetchApi<AntigravityWebStatus>('/accounts', {
        method: 'POST',
        body: JSON.stringify({ action: 'clear-cooldown', accountId }),
      })
      setStatus(updated)
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
      const updated = await fetchApi<AntigravityWebStatus>('/accounts', {
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

  const toggleEnabled = async (enabled: boolean) => {
    setStatus((prev) => prev ? { ...prev, enabled } : prev)
    try {
      const updated = await fetchApi<AntigravityWebStatus>('/settings', {
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

  const toggleModel = async (modelId: string, checked: boolean) => {
    if (!status) return
    const currentEnabled = status.models.filter((m) => m.enabled).map((m) => m.id)
    const nextEnabled = checked
      ? [...new Set([...currentEnabled, modelId])]
      : currentEnabled.filter((id) => id !== modelId)

    try {
      const updated = await fetchApi<AntigravityWebStatus>('/models', {
        method: 'POST',
        body: JSON.stringify({ enabledModelIds: nextEnabled }),
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

  const setAllModels = async (selectAll: boolean) => {
    if (!status) return
    const nextEnabled = selectAll ? status.models.map((m) => m.id) : []
    try {
      const updated = await fetchApi<AntigravityWebStatus>('/models', {
        method: 'POST',
        body: JSON.stringify({ enabledModelIds: nextEnabled }),
      })
      setStatus(updated)
      setContextDrafts(contextDraftsFor(updated))
      notifyChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleUpdateEffort = async (effort: 'low' | 'medium' | 'high' | null) => {
    try {
      const updated = await fetchApi<AntigravityWebStatus>('/settings', {
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
      setError(`无效的上下文容量值: ${raw}`)
      return
    }

    try {
      setSavingModel(modelId)
      setError(null)
      const updated = await fetchApi<AntigravityWebStatus>('/settings', {
        method: 'POST',
        body: JSON.stringify({
          contextWindowOverrides: {
            [modelId]: parsed,
          },
        }),
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

  /** Clear one override; the row falls back to the catalog length. */
  const handleResetContextWindow = async (modelId: string) => {
    try {
      setSavingModel(modelId)
      setError(null)
      const updated = await fetchApi<AntigravityWebStatus>('/settings', {
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
      const updated = await fetchApi<AntigravityWebStatus>('/settings', {
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

  // Only checked models get a context row; the batch restore still covers every
  // stored override, including one left behind by a model the user unchecked.
  const contextModels = status?.models.filter((model) => model.enabled) ?? []
  const overrideCount = Object.keys(status?.contextWindowOverrides ?? {}).length

  if (loading) {
    return (
      <div className="dsha-page">
        <div className="dsha-empty">{t.loading}</div>
      </div>
    )
  }

  const quota = status?.quota
  const groups = quota?.groups || []
  const visibleCount = status?.models.filter((m) => m.enabled).length || 0

  return (
    <div className="dsha-page">
      {/* 1. 账号管理分组：与其余三条线路共用同一张账号卡片 */}
      <AccountPoolSection
        accounts={status?.accounts ?? []}
        activeAccountId={status?.activeAccountId}
        rotationStrategy={status?.rotationStrategy ?? 'sequential'}
        busy={busy}
        labels={t}
        loginBusyLabel={busy === 'login' ? (loginProgress || t.signingIn) : undefined}
        onLogin={() => void handleLogin()}
        onSetPrimary={(accountId) => void handleSetPrimary(accountId)}
        onDelete={(accountId) => void handleDeleteAccount(accountId)}
        onClearCooldown={(accountId) => void handleClearCooldown(accountId)}
        onSetStrategy={(strategy) => void handleSetStrategy(strategy)}
        renderDetails={(account) => (
          <>
            <span>{t.accountId}: {account.projectId || 'antigravity-default'}</span>
            {account.email && <span>{t.email}: {account.email}</span>}
            {account.expiresAt && <span>{t.expires}: {formatDate(account.expiresAt)}</span>}
            {account.lastUsedAt && <span>{t.lastUsed}: {formatDate(account.lastUsedAt)}</span>}
          </>
        )}
      />

      {/* 2. 连接与模型胶囊标签选择器 */}
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

        <p className="dsha-muted dsha-models-hint">{t.modelsHint}</p>

        {/* 胶囊标签多选列表 */}
        <div className="dsha-models" aria-label="Antigravity Models">
          {status?.models.map((model) => {
            const checked = model.enabled
            return (
              <label key={model.id} title={model.id}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={busy !== null}
                  onChange={(e) => void toggleModel(model.id, e.currentTarget.checked)}
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

      {/* 3. 增强功能（思考深度设置） */}
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
            onChange={(e) => {
              const val = e.currentTarget.value
              void handleUpdateEffort(val === '' ? null : (val as 'low' | 'medium' | 'high'))
            }}
          >
            <option value="">{t.defaultEffortAuto}</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>
      </section>

      {/* 4. 模型上下文窗口设置（按模型独立配置） */}
      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.contextWindowSection}</h3>
        </div>
        <p className="dsha-muted">{t.contextWindowHint}</p>

        <div className="dsha-context-settings">
          {contextModels.length === 0 && (
            <p className="dsha-muted">{t.contextWindowNoneEnabled}</p>
          )}
          {contextModels.map((model) => (
            <div key={model.id} className="dsha-context-row">
              <span>{model.name}</span>
              <div className="dsha-capacity-control">
                <input
                  type="text"
                  value={contextDrafts[model.id] ?? ''}
                  onChange={(e) => setContextDrafts({ ...contextDrafts, [model.id]: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleSaveContextWindow(model.id)
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

      {/* 5. 用量与配额卡片 */}
      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.quotaSection}</h3>
          <button
            className="dsha-btn"
            disabled={busy !== null || !status?.authenticated}
            onClick={handleRefreshQuota}
          >
            {busy === 'quota' ? t.refreshingQuota : t.refreshQuota}
          </button>
        </div>
        <p className="dsha-muted">{t.quotaDesc}</p>

        {!status?.authenticated ? (
          <div className="dsha-empty">{t.signedOut}</div>
        ) : groups.length === 0 ? (
          <div className="dsha-empty">{busy === 'quota' ? t.refreshingQuota : t.quotaEmpty}</div>
        ) : (
          groups.map((group, gIdx) => (
            <div key={gIdx} className="dsha-quota-card">
              <div className="dsha-quota-title">
                <strong>{group.displayName}</strong>
                {group.description && <span>{group.description}</span>}
              </div>

              {group.buckets.map((bucket, bIdx) => {
                const isCyan = /claude|gpt|3p/i.test(group.displayName)
                const pct = Math.round(bucket.remainingFraction * 100)
                const resetText = formatResetTime(bucket.resetTime)
                return (
                  <div key={bIdx} className="dsha-meter-wrap">
                    <div className="dsha-meter-label">
                      <span>{bucket.displayName}</span>
                      <strong>{pct}% 剩余</strong>
                    </div>
                    <div className={`dsha-meter ${isCyan ? 'dsha-meter-cyan' : 'dsha-meter-green'}`}>
                      <span style={{ width: `${pct}%` }} />
                    </div>
                    {resetText && (
                      <div className="dsha-meter-meta">
                        <span>重置: {resetText}</span>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))
        )}

        {quota?.fetchedAt && (
          <div className="dsha-timestamp">
            更新时间: {new Date(quota.fetchedAt).toLocaleString()}
          </div>
        )}
      </section>

      {error && (
        <div className="dsha-error">
          <div>{error}</div>
          {validationUrl && (
            <div style={{ marginTop: '8px' }}>
              <a
                href={validationUrl}
                target="_blank"
                rel="noreferrer"
                className="dsha-btn dsha-btn-primary"
                style={{ display: 'inline-block', textDecoration: 'none', padding: '4px 10px', fontSize: '12px' }}
              >
                {t.googleValidation}
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
