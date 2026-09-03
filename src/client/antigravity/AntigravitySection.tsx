import React, { useCallback, useEffect, useState } from 'react'
import type { AntigravityModelOption, AntigravityWebStatus } from '../../shared/antigravity-contracts.ts'
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
      const data = await fetchApi<AntigravityWebStatus>('/status')
      setStatus(data)
      // 初始化输入草稿
      const drafts: Record<string, string> = {}
      for (const m of data.models) {
        const val = data.contextWindowOverrides[m.id] || m.defaultContextWindow
        drafts[m.id] = formatCapacity(val)
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
      const flow = await fetchApi<{ authUrl?: string; status?: string }>('/login', { method: 'POST' })
      if (flow.authUrl) {
        window.open(flow.authUrl, '_blank')
      }
      const pollTimer = setInterval(async () => {
        try {
          const pollStatus = await fetchApi<{ status: string }>('/login/status')
          if (pollStatus.status === 'complete') {
            clearInterval(pollTimer)
            setBusy(null)
            await loadStatus()
            notifyChange()
          } else if (pollStatus.status === 'error') {
            clearInterval(pollTimer)
            setBusy(null)
            setError(t.loginFailed)
          }
        } catch {
          // ignore
        }
      }, 1500)

      setTimeout(() => {
        clearInterval(pollTimer)
        setBusy(null)
      }, 5 * 60 * 1000)
    } catch (err) {
      setBusy(null)
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

  const toggleModel = async (modelId: string, checked: boolean) => {
    if (!status) return
    const currentEnabled = status.models.filter((m) => m.enabled).map((m) => m.id)
    const nextEnabled = checked
      ? [...new Set([...currentEnabled, modelId])]
      : currentEnabled.filter((id) => id !== modelId)

    if (nextEnabled.length === 0) return // 至少保留一个

    try {
      const updated = await fetchApi<AntigravityWebStatus>('/models', {
        method: 'POST',
        body: JSON.stringify({ enabledModelIds: nextEnabled }),
      })
      setStatus(updated)
      notifyChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const setAllModels = async (selectAll: boolean) => {
    if (!status) return
    const nextEnabled = selectAll ? status.models.map((m) => m.id) : [status.models[0].id]
    try {
      const updated = await fetchApi<AntigravityWebStatus>('/models', {
        method: 'POST',
        body: JSON.stringify({ enabledModelIds: nextEnabled }),
      })
      setStatus(updated)
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
      {/* 1. 账号信息分组 */}
      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{status?.authenticated ? t.account : t.signedOut}</h3>
        </div>
        <div className="dsha-row">
          <span className="dsha-label">{status?.authenticated ? t.signedIn : t.signedOut}</span>
          <span className="dsha-value">{status?.email || '—'}</span>
        </div>
        {status?.authenticated && (
          <>
            <div className="dsha-row">
              <span className="dsha-label">{t.plan}</span>
              <span className="dsha-value">{quota?.planLabel || 'Google AI Ultra'}</span>
            </div>
            <div className="dsha-row">
              <span className="dsha-label">{t.accountId}</span>
              <span className="dsha-value">{status.projectId || 'antigravity-default'}</span>
            </div>
            <div className="dsha-row">
              <span className="dsha-label">{t.expires}</span>
              <span className="dsha-value">{formatDate(Date.now() + 86400000 * 30)}</span>
            </div>
          </>
        )}
        <div className="dsha-row">
          <span className="dsha-label">{t.storage}</span>
          <span className="dsha-value">本地安全存储 (JSON)</span>
        </div>
        <p className="dsha-notice">{t.storageNotice}</p>

        <div className="dsha-actions">
          {!status?.authenticated ? (
            <button className="dsha-btn dsha-btn-primary" disabled={busy !== null} onClick={handleLogin}>
              {busy === 'login' ? t.signingIn : t.signIn}
            </button>
          ) : (
            <>
              <button className="dsha-btn dsha-btn-primary" disabled={busy !== null} onClick={handleLogin}>
                {t.signInAgain}
              </button>
              <button className="dsha-btn" disabled={busy !== null} onClick={handleRefreshQuota}>
                {busy === 'quota' ? t.refreshingQuota : t.refreshToken}
              </button>
              <button className="dsha-btn" disabled={busy !== null} onClick={handleLogout}>
                {t.signOut}
              </button>
            </>
          )}
        </div>
      </section>

      {/* 2. 连接与模型胶囊标签选择器 */}
      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.connection}</h3>
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
            const lastVisible = checked && visibleCount === 1
            return (
              <label key={model.id} title={model.id}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={busy !== null || lastVisible}
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
          {status?.models.map((model) => (
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
              </div>
            </div>
          ))}
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
          <div className="dsha-empty">暂无配额数据，点击右上角刷新用量。</div>
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

      {error && <div className="dsha-error">{error}</div>}
    </div>
  )
}
