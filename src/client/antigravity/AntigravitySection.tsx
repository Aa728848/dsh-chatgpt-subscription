import React, { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AccountRotationStrategy,
  AntigravityPrefixDriftCause,
  AntigravityWebStatus,
} from '../../shared/antigravity-contracts.ts'
import { AccountPoolSection } from '../common/AccountPoolSection.tsx'
import { ContextWindowEditor, contextDraftsFor } from '../common/ContextWindowEditor.tsx'
import { ModelChecklist } from '../common/ModelChecklist.tsx'
import { createLineApi } from '../common/line-api.ts'
import { createQuotaFollowUp, type QuotaFollowUp } from '../common/quota-follow-up.ts'
import { formatCapacity, parsePositiveCapacity } from '../common/format.ts'
import { zh } from './locales.ts'

const API = '/antigravity/api'
const api = createLineApi(API, 'Antigravity')

interface Props {
  onModelChange?: () => void
  loadModelDirectory?: () => void
}

/** A gap in human units, so the idle reading is legible without arithmetic. */
function idleLabel(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
}

/** Human label for the cause of the last request that lost the whole cache. */
function missLabel(cause: AntigravityPrefixDriftCause, t: typeof zh): string {
  switch (cause) {
    case 'none': return t.cacheDriftNone
    case 'contents': return t.cacheDriftContents
    case 'systemInstruction': return t.cacheDriftSystemInstruction
    case 'tools': return t.cacheDriftTools
    case 'session-id': return t.cacheDriftSessionId
    case 'new-session': return t.cacheDriftNewSession
    default: return String(cause)
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
      const data = await api.request<AntigravityWebStatus>('/status')
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
      const flow = await api.request<{ authUrl?: string; status?: string }>('/login', { method: 'POST' })
      if (flow.authUrl) {
        window.open(flow.authUrl, '_blank')
      }
      const pollTimer = setInterval(async () => {
        try {
          const pollStatus = await api.request<{
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
      const updated = await api.request<AntigravityWebStatus>('/quota', { method: 'POST' })
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
      const updated = await api.request<AntigravityWebStatus>('/logout', { method: 'POST' })
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
      const updated = await api.request<AntigravityWebStatus>('/accounts', {
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
      const updated = await api.request<AntigravityWebStatus>('/accounts', {
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
      const updated = await api.request<AntigravityWebStatus>('/accounts', {
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
      const updated = await api.request<AntigravityWebStatus>('/accounts', {
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

  const toggleModel = async (modelId: string, checked: boolean) => {
    if (!status) return
    const currentEnabled = status.models.filter((m) => m.enabled).map((m) => m.id)
    const nextEnabled = checked
      ? [...new Set([...currentEnabled, modelId])]
      : currentEnabled.filter((id) => id !== modelId)

    try {
      const updated = await api.request<AntigravityWebStatus>('/models', {
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
      const updated = await api.request<AntigravityWebStatus>('/models', {
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
      const updated = await api.request<AntigravityWebStatus>('/settings', {
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
      const updated = await api.request<AntigravityWebStatus>('/settings', {
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
      const updated = await api.request<AntigravityWebStatus>('/settings', {
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
      const updated = await api.request<AntigravityWebStatus>('/settings', {
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
        // Matches what the host reports for an unstated strategy: the account
        // that served the previous request keeps the next one, which is assumed
        // to leave its cache warm — the host documents that assumption and its
        // lack of live verification. A stored choice still arrives from the host
        // and wins over this fallback.
        rotationStrategy={status?.rotationStrategy ?? 'sticky'}
        busy={busy}
        labels={t}
        loginBusyLabel={busy === 'login' ? (loginProgress || t.signingIn) : undefined}
        onLogin={() => void handleLogin()}
        onSetPrimary={(accountId) => void handleSetPrimary(accountId)}
        onDelete={(accountId) => void handleDeleteAccount(accountId)}
        onClearCooldown={(accountId) => void handleClearCooldown(accountId)}
        onSetStrategy={(strategy) => void handleSetStrategy(strategy)}
        // Quota follows the account, so a row draws the snapshot the host holds
        // for that account rather than one line-level figure.
        showQuota
        // Only what the shared card cannot know: the line's own project id.
        // E-mail, expiry and last-used are the shared card's rows, and rendering
        // them here printed each of them twice.
        renderDetails={(account) => (
          <span>{t.accountId}: {account.projectId || 'antigravity-default'}</span>
        )}
      />

      {/* 2. 模型选择：这一组现在只做模型，连接事实（开关 / Provider / 连接状态）
          已删——开关在概览卡片上，Provider 与「已连接」是内部细节。 */}
      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.modelsSection}</h3>
        </div>
        <p className="dsha-muted dsha-models-hint">{t.modelsHint}</p>

        <ModelChecklist
          items={(status?.models ?? []).map((model) => ({
            id: model.id,
            name: model.name,
            hint: model.defaultContextWindow ? formatCapacity(model.defaultContextWindow) : undefined,
            enabled: model.enabled,
          }))}
          busy={busy !== null}
          onToggle={(id, enabled) => void toggleModel(id, enabled)}
          onToggleAll={setAllModels}
          labels={{ selectAll: t.selectAll, clearAll: t.unselectAll, list: t.modelsSection }}
        />
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

        <ContextWindowEditor
          rows={contextModels.map((model) => ({
            id: model.id,
            name: model.name,
            draft: contextDrafts[model.id] ?? '',
            hasOverride: status?.contextWindowOverrides[model.id] !== undefined,
            saving: savingModel === model.id,
          }))}
          labels={{
            tokens: t.tokens,
            save: t.save,
            saving: t.saving,
            reset: t.contextWindowReset,
            resetAll: t.contextWindowResetAll,
            empty: t.contextWindowNoneEnabled,
          }}
          busy={busy !== null}
          overrideCount={overrideCount}
          onDraftChange={(id, draft) => setContextDrafts((prev) => ({ ...prev, [id]: draft }))}
          onCommit={(id) => void handleSaveContextWindow(id)}
          onReset={(id) => void handleResetContextWindow(id)}
          onResetAll={() => void handleResetAllContextWindows()}
        />
      </section>

      {/* 5. 缓存可观测性（只读） */}
      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.cacheSection}</h3>
        </div>
        <p className="dsha-muted">{t.cacheDesc}</p>
        {status?.cache == null ? (
          <div className="dsha-empty">{t.cacheEmpty}</div>
        ) : (
          <div className="dsha-quota-card">
            <div className="dsha-meter-wrap">
              <div className="dsha-meter-label">
                <span>{t.cacheHitRatio}</span>
                <strong>
                  {status.cache.hitRatio === null ? '—' : `${(status.cache.hitRatio * 100).toFixed(1)}%`}
                </strong>
              </div>
              <div className={`dsha-meter ${(status.cache.hitRatio ?? 0) >= 0.9 ? 'dsha-meter-green' : 'dsha-meter-cyan'}`}>
                <span style={{ width: `${Math.round((status.cache.hitRatio ?? 0) * 100)}%` }} />
              </div>
              <div className="dsha-meter-meta">
                <span>{t.cacheCached}: {status.cache.cachedTokens.toLocaleString()}</span>
                <span>{t.cacheFresh}: {status.cache.freshTokens.toLocaleString()}</span>
                <span>{t.cacheRequests}: {status.cache.requests}</span>
              </div>
            </div>
            {status.cache.lastMiss !== undefined && (
              <>
                <div className="dsha-row">
                  <span className="dsha-label">{t.cacheMiss}</span>
                  <span className="dsha-value">{missLabel(status.cache.lastMiss.cause, t)}</span>
                </div>
                {status.cache.lastMiss.idleMs !== undefined && (
                  <div className="dsha-row">
                    <span className="dsha-label">{t.cacheMissIdle}</span>
                    <span className="dsha-value">{idleLabel(status.cache.lastMiss.idleMs)}</span>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </section>

      {/* 6. 用量与配额卡片 */}
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
        {/* The per-group/bucket rows went with the bars: every one of them — the
            remaining share, the reset countdown, the group and bucket names —
            is drawn on the account card now, where the snapshot actually
            belongs. What stays is what has no account-row home: the refresh
            action, the reading's freshness and the states below. */}
        <p className="dsha-muted">{t.quotaFactsScope}</p>

        {!status?.authenticated
          ? <div className="dsha-empty">{t.signedOut}</div>
          : groups.length === 0
            ? <div className="dsha-empty">{busy === 'quota' ? t.refreshingQuota : t.quotaEmpty}</div>
            : null}

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
