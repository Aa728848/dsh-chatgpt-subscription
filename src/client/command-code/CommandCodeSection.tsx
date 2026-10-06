import React, { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CommandCodeModelOption,
  CommandCodeReasoningEffort,
  CommandCodeWebStatus,
  CommandCodeWire,
} from '../../shared/command-code-contracts.ts'
import { COMMAND_CODE_REASONING_EFFORTS } from '../../shared/command-code-contracts.ts'
import { createQuotaFollowUp, type QuotaFollowUp } from '../common/quota-follow-up.ts'

/**
 * Display label per reasoning level. The locale dictionary only accepts flat
 * string values, so this nested table lives with the control that renders it.
 */
const EFFORT_LABELS: Record<CommandCodeReasoningEffort, string> = {
  none: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
}
import { AccountPoolSection } from '../common/AccountPoolSection.tsx'
import { ContextWindowEditor, contextDraftsFor } from '../common/ContextWindowEditor.tsx'
import { ModelChecklist } from '../common/ModelChecklist.tsx'
import { createLineApi } from '../common/line-api.ts'
import { formatCapacity, formatDate, parsePositiveCapacity } from '../common/format.ts'
import type { AccountRotationStrategy } from '../../shared/account-pool-contracts.ts'
import { zh } from './locales.ts'

const API = '/command-code/api'
const api = createLineApi(API, 'Command Code')

interface Props {
  onModelChange?: () => void
  loadModelDirectory?: () => void
}

interface LoginPollStatus {
  status: string
  authUrl?: string
  error?: string
  progress?: string
}

/**
 * Route name shown next to a model.
 *
 * The three routes are not interchangeable: the provider serves each model on
 * exactly one and rejects the others, so the label states which one this model
 * actually uses.
 */
function wireLabel(wire: CommandCodeWire, t: { wireAnthropic: string; wireOpenai: string; wireResponses: string }): string {
  if (wire === 'anthropic') return t.wireAnthropic
  if (wire === 'responses') return t.wireResponses
  return t.wireOpenai
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
    }
    try {
      const data = await api.request<CommandCodeWebStatus>('/status')
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
      setLoginProgress(null)
      const flow = await api.request<LoginPollStatus>('/login', { method: 'POST' })
      if (flow.authUrl) {
        window.open(flow.authUrl, '_blank')
      }
      const pollTimer = window.setInterval(() => {
        void (async () => {
          try {
            const poll = await api.request<LoginPollStatus>('/login/status')
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
      const updated = await api.request<CommandCodeWebStatus>('/login/apikey', {
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

  /** One account-level action on the shared pool card. */
  const handleAccountAction = async (
    action: 'set-primary' | 'delete' | 'clear-cooldown',
    accountId: string,
  ) => {
    try {
      setBusy(`${action}-${accountId}`)
      setError(null)
      const updated = await api.request<CommandCodeWebStatus>('/accounts', {
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
      const updated = await api.request<CommandCodeWebStatus>('/accounts', {
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

  /**
   * Re-authorize one key.
   *
   * Nothing is deleted: the failure marker is cleared and the ordinary sign-in
   * flow runs again, so the account keeps its alias and place in the rotation.
   */
  const handleRelogin = (accountId: string) => {
    void (async () => {
      try {
        const updated = await api.request<CommandCodeWebStatus>('/accounts', {
          method: 'POST',
          body: JSON.stringify({ action: 'relogin', accountId }),
        })
        setStatus(updated)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        return
      }
      await handleLogin()
    })()
  }

  const handleRefreshQuota = async () => {
    try {
      setBusy('quota')
      setError(null)
      const updated = await api.request<CommandCodeWebStatus>('/quota', { method: 'POST' })
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
      const updated = await api.request<CommandCodeWebStatus>('/catalog/refresh', { method: 'POST' })
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
      await api.post('/connection/test')
      await loadStatus(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const applyEnabled = async (enabledModelIds: string[]) => {
    try {
      const updated = await api.request<CommandCodeWebStatus>('/models', {
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
      const updated = await api.request<CommandCodeWebStatus>('/settings', {
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
      const updated = await api.request<CommandCodeWebStatus>('/settings', {
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

  /** Clear one override; the row falls back to the catalog length. */
  const handleResetContextWindow = async (modelId: string) => {
    try {
      setSavingModel(modelId)
      setError(null)
      const updated = await api.request<CommandCodeWebStatus>('/settings', {
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
      const updated = await api.request<CommandCodeWebStatus>('/settings', {
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
  const account = status?.account
  const visibleCount = status?.models.filter((model) => model.enabled).length || 0

  return (
    <div className="dsha-page">
      <AccountPoolSection
        accounts={status?.accounts ?? []}
        activeAccountId={status?.activeAccountId}
        rotationStrategy={status?.rotationStrategy ?? 'sequential'}
        busy={busy}
        labels={t}
        loginBusyLabel={busy === 'login' ? (loginProgress || t.signingIn) : undefined}
        onLogin={() => void handleLogin()}
        onSetPrimary={(accountId) => void handleAccountAction('set-primary', accountId)}
        onDelete={(accountId) => void handleAccountAction('delete', accountId)}
        onClearCooldown={(accountId) => void handleAccountAction('clear-cooldown', accountId)}
        onRelogin={(accountId) => handleRelogin(accountId)}
        onSetStrategy={(strategy) => void handleSetStrategy(strategy)}
        showQuota
        renderDetails={(entry) => (
          <>
            {entry.keyName && <span>{t.keyName}: {entry.keyName}</span>}
            {entry.planLabel && <span>{t.plan}: {entry.planLabel}</span>}
          </>
        )}
      >
        <p className="dsha-muted" style={{ paddingTop: 12 }}>{t.apiKeyHint}</p>
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
      </AccountPoolSection>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.connection}</h3>
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
        {status?.catalogStale !== undefined && (
          <p className="dsha-muted" data-testid="command-code-catalog-freshness">
            {status.catalogStale ? t.catalogStale : t.catalogFresh} · {formatDate(status.catalogFetchedAt)}
          </p>
        )}
        {status?.zeroDataRetention === true && <p className="dsha-notice" data-testid="command-code-zdr">{t.zdrEnabled}</p>}
        <ModelChecklist
          items={(status?.models ?? []).map((model: CommandCodeModelOption) => ({
            id: model.id,
            name: model.name,
            hint: wireLabel(model.wire, t),
            enabled: model.enabled,
          }))}
          busy={busy !== null}
          onToggle={toggleModel}
          onToggleAll={setAllModels}
          labels={{ selectAll: t.selectAll, clearAll: t.unselectAll, list: t.modelsSection }}
        />
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
        <ContextWindowEditor
          rows={contextModels.map((model: CommandCodeModelOption) => ({
            id: model.id,
            name: model.name,
            draft: contextDrafts[model.id] ?? '',
            inputLabel: `${model.name} context window`,
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

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.quotaSection}</h3>
          <button className="dsha-btn" disabled={busy !== null || !status?.authenticated} onClick={() => void handleRefreshQuota()}>
            {busy === 'quota' ? t.refreshingQuota : t.refreshQuota}
          </button>
        </div>
        <p className="dsha-muted">{t.quotaDesc}</p>
        {/* The progress bars moved into each account card: quota follows the
            account, so a bar here could only ever describe whichever account
            happened to be active when the snapshot was read. What stays is what
            has no per-account bar to live in — the credits, the meters that
            state no share, and the freshness of this reading. */}
        <p className="dsha-muted">{t.quotaFactsScope}</p>

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

            {quota.meters.filter((meter) => meter.remainingFraction === null).map((meter) => (
              <div key={meter.id} className="dsha-meter-wrap">
                <div className="dsha-meter-label">
                  <span>{meter.label}</span>
                  <strong>{meter.limit ?? '—'}</strong>
                </div>
                {meter.used !== null && (
                  <div className="dsha-meter-meta"><span>{meter.used} / {meter.limit ?? '—'}</span></div>
                )}
                {meter.description !== null && (
                  <div className="dsha-meter-meta"><span>{meter.description}</span></div>
                )}
              </div>
            ))}

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
