import React, { useCallback, useEffect, useState } from 'react'
import { ModelChecklist } from '../common/ModelChecklist.tsx'
import type { AntigravityAcpStatusDto } from '../../shared/antigravity-acp-contracts.ts'
import { AntigravityAcpApi } from './api.ts'
import { zh, NS_ANTIGRAVITY_ACP } from './locales.ts'
import { useLineDict } from '../common/line-locale.ts'

const API = new AntigravityAcpApi()

/** A token count short enough to sit on one line. */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value < 1_000) return String(Math.floor(value))
  if (value < 1_000_000) return (value / 1_000).toFixed(value < 10_000 ? 1 : 0) + 'K'
  return (value / 1_000_000).toFixed(1) + 'M'
}

interface Props {
  onModelChange?: () => void
  loadModelDirectory?: () => void
}

/**
 * The Antigravity (ACP) settings tab.
 *
 * One line here is deliberately absent: the account-pool card. This line does not
 * own accounts - the official CLI does - so rendering a pool would either be an
 * empty shell or, worse, a second place that claims to manage a sign-in it cannot
 * see. What is left is what the user actually chooses: which executable runs,
 * which models appear, the default thinking level, and how the agent's permission
 * requests are answered.
 */
export function AntigravityAcpSection(props: Props): React.ReactElement {
  const [status, setStatus] = useState<AntigravityAcpStatusDto | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [enabled, setEnabled] = useState<Set<string> | null>(null)
  const [binaryPath, setBinaryPath] = useState('')
  const [doctor, setDoctor] = useState<{ ok: boolean; steps: { id: string; ok: boolean; detail: string }[] } | null>(null)
  /** Feedback for the sign-in action, cleared on the next attempt. */
  const [loginNotice, setLoginNotice] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const next = await API.status()
      setStatus(next)
      setEnabled(next.enabledModelIds == null ? null : new Set(next.enabledModelIds))
      setBinaryPath(next.binary.path ?? '')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const run = useCallback(async (label: string, action: () => Promise<AntigravityAcpStatusDto>) => {
    setBusy(label)
    setError(null)
    try {
      setStatus(await action())
      props.onModelChange?.()
      props.loadModelDirectory?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }, [props])

  const t = useLineDict(NS_ANTIGRAVITY_ACP, zh)
  const models = status?.models ?? []
  const auth = status?.auth
  const usage = status?.usage
  const tier = auth?.tier

  const isModelEnabled = useCallback((id: string): boolean => {
    return enabled === null || enabled.has(id)
  }, [enabled])

  const applyEnabled = useCallback((next: string[] | null) => {
    void run('models', async () => {
      const result = await API.update({ enabledModelIds: next })
      setEnabled(result.enabledModelIds == null ? null : new Set(result.enabledModelIds))
      return result
    })
  }, [run])

  const toggleModel = useCallback((id: string, checked: boolean) => {
    if (status === null) return
    const all = status.models ?? []
    const current = all.filter(model => isModelEnabled(model.id)).map(model => model.id)
    const next = checked
      ? [...new Set([...current, id])]
      : current.filter(entry => entry !== id)
    // A selection that covers the whole catalogue is stored as null, so it keeps
    // tracking models the upstream adds later instead of freezing at today's list.
    applyEnabled(next.length === all.length ? null : next)
  }, [status, isModelEnabled, applyEnabled])

  const setAllModels = useCallback((selectAll: boolean) => {
    applyEnabled(selectAll ? null : [])
  }, [applyEnabled])

  const signIn = useCallback(() => {
    setBusy('login')
    setError(null)
    setLoginNotice(null)
    void API.startLogin()
      .then(async (result) => {
        setLoginNotice(result.started ? t.signInSuccess : t.signInAlready)
        // Re-read the state right away: on a machine that is already signed in the
        // spinner would otherwise be the only feedback and the card would still
        // read "not signed in" next to a button that says "sign in".
        await reload()
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(null))
  }, [reload, t])

  const saveBinaryPath = useCallback(() => {
    void run('binary', () => API.update({ binaryPath: binaryPath.trim() === '' ? null : binaryPath.trim() }))
  }, [run, binaryPath])

  return (
    <div>
      <div className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.title}</h3>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="dsha-btn"
              disabled={busy !== null}
              onClick={() => {
                setBusy('doctor')
                setError(null)
                void API.doctor()
                  .then((report) => setDoctor(report))
                  .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
                  .finally(() => setBusy(null))
              }}
            >
              {busy === 'doctor' ? t.doctorRunning : t.runDoctor}
            </button>
            <button className="dsha-btn" disabled={busy !== null} onClick={() => void run('refresh', () => API.refresh())}>
              {busy === 'refresh' ? t.catalogSyncing : t.refreshStatus}
            </button>
          </div>
        </div>
        <p className="dsha-notice">{t.pageDesc}</p>
        {status !== null && !status.enabled && (
          <p className="dsha-notice">{t.disabledHint}</p>
        )}
        {/* 条款风险不再占据卡面正文：它太长，一屏就被它吃掉。原句整段保留在折叠区里
            （默认收起、仍在 DOM 中），需要时展开即可，等于「隐藏」而不是「删掉」。 */}
        <details className="dshagy-details">
          <summary>{t.complianceSummary}</summary>
          <p>{t.complianceNotice}</p>
        </details>
        {status?.routeConflict !== undefined && (
          <p className="dsha-notice">{t.routeConflict.replace('{detail}', status.routeConflict)}</p>
        )}
        {error !== null && (
          <p className="dsha-notice" style={{ color: 'var(--dsha-danger, #c0392b)' }}>
            {t.error.replace('{detail}', error)}
          </p>
        )}
        {doctor !== null && (
          <div className="dsha-pref-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <strong>{t.doctorTitle}</strong>
            {doctor.steps.map((step) => (
              <p key={step.id} className="dsha-muted" style={{ fontSize: 12 }}>
                {step.ok ? 'OK' : 'FAIL'} · {step.id} · {step.detail}
              </p>
            ))}
          </div>
        )}
      </div>

      <div className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.binarySection}</h3>
        </div>
        {status !== null && (
          <div className="dsha-row">
            <span className="dsha-label">{t.binarySourceLabel}</span>
            <span className="dsha-value">
              {status.binary.kind === 'local-cli' && t.binaryKindLocal}
              {status.binary.kind === 'configured' && t.binaryKindConfigured}
              {status.binary.kind === 'downloaded' && t.binaryKindDownloaded}
              {status.binary.kind === 'missing' && t.binaryKindMissing}
              {status.binary.version !== undefined && ' · ' + status.binary.version}
            </span>
          </div>
        )}
        {status?.binary.error !== undefined && (
          <p className="dsha-notice">{status.binary.error}</p>
        )}
        <div className="dsha-pref-row">
          <span className="dsha-label">{t.binaryPathLabel}</span>
          {/* Right-aligned like every other value on this card: the control block
              takes the remaining width and pins itself to the right edge, and the
              input grows inside it instead of sitting flush against the label. */}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginLeft: 'auto', flex: '0 1 520px' }}>
            <input
              className="dsha-input"
              style={{ flex: '1 1 260px', minWidth: 180 }}
              value={binaryPath}
              placeholder={t.binaryPathPlaceholder}
              disabled={busy !== null}
              onChange={(event) => setBinaryPath(event.target.value)}
            />
            <button className="dsha-btn" disabled={busy !== null} onClick={saveBinaryPath}>
              {t.binaryPathSave}
            </button>
          </div>
        </div>
        <details className="dshagy-details">
          <summary>{t.binaryHintSummary}</summary>
          <p>{status?.binary.kind === 'missing' ? t.binaryMissingHint : t.binaryPathPlaceholder}</p>
        </details>
      </div>

      <div className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.authSection}</h3>
          <button
            className="dsha-btn dsha-btn-primary"
            disabled={busy !== null}
            onClick={signIn}
          >
            {busy === 'login' ? t.signInStarting : auth?.authenticated === true ? t.signInAgain : t.signIn}
          </button>
        </div>
        <div className="dsha-row">
          <span className="dsha-label">{t.statusLabel}</span>
          <span className="dsha-value">
            <span className={`dsha-badge ${auth?.authenticated === true ? 'active' : 'danger'}`}>
              {auth?.authenticated === true ? t.signedIn : t.signedOut}
            </span>
          </span>
        </div>
        <div className="dsha-row">
          <span className="dsha-label">{t.tierLabel}</span>
          <span className="dsha-value">{tier === undefined ? t.tierUnknown : tier.name}</span>
        </div>
        {loginNotice !== null && (
          <p className="dsha-notice" style={{ color: 'var(--dsha-success, #10b981)' }}>{loginNotice}</p>
        )}
        <details className="dshagy-details">
          <summary>{t.signInHintSummary}</summary>
          <p>{t.signInHint}</p>
          <p>{t.signInHeadless}</p>
        </details>
      </div>

      <div className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.modelsSection}</h3>
          <button className="dsha-btn" disabled={busy !== null} onClick={() => void run('catalog', () => API.refresh())}>
            {busy === 'catalog' ? t.catalogSyncing : t.catalogSync}
          </button>
        </div>
        <p className="dsha-muted" style={{ fontSize: 12 }}>{t.modelsHint}</p>
        {status !== null && status.catalogSynced === false && models.length > 0 && (
          <p className="dsha-muted" style={{ fontSize: 12 }}>{t.catalogStale}</p>
        )}
        {status !== null && models.length === 0 && (
          <div className="dsha-empty">{t.catalogNeverSynced}</div>
        )}
        {/* Nothing selected is NOT nothing synced: the checklist below stays
            rendered so the user can pick models again, and this line says why the
            picker is empty in the meantime. */}
        {status !== null && models.length > 0 && enabled !== null && enabled.size === 0 && (
          <p className="dsha-notice">{t.noneSelected}</p>
        )}
        {status !== null && models.length > 0 && (
          <>
            <p className="dsha-muted" style={{ fontSize: 12 }}>
              {t.modelCount.replace('{count}', String(models.length))}
            </p>
            <ModelChecklist
              items={models.map((model) => ({
                id: model.id,
                name: model.name,
                hint: model.efforts.length === 0
                  ? undefined
                  : t.effortLabels.replace('{levels}', model.efforts.join(' / ')),
                enabled: isModelEnabled(model.id),
              }))}
              busy={busy !== null}
              onToggle={(id, value) => toggleModel(id, value)}
              onToggleAll={(value) => setAllModels(value)}
              labels={{ selectAll: t.selectAll, clearAll: t.unselectAll, list: t.modelsSection }}
            />
          </>
        )}
      </div>

      <div className="dsha-group">
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
              void run('effort', () => API.update({ defaultReasoningEffort: value === '' ? null : value }))
            }}
          >
            <option value="">{t.defaultEffortAuto}</option>
            {reasoningLevels(models).map((level) => (
              <option key={level} value={level}>{level}</option>
            ))}
          </select>
        </div>
        <div className="dsha-pref-row">
          <div>
            <strong>{t.permissionPolicy}</strong>
            <p className="dsha-muted">{t.permissionPolicyHint}</p>
          </div>
          <select
            className="dsha-select"
            aria-label={t.permissionPolicy}
            value={status?.permissionPolicy ?? 'reject'}
            disabled={busy !== null}
            onChange={(event) => {
              const value = event.currentTarget.value === 'allow' ? 'allow' : 'reject'
              void run('permission', () => API.update({ permissionPolicy: value }))
            }}
          >
            <option value="reject">{t.permissionPolicyReject}</option>
            <option value="allow">{t.permissionPolicyAllow}</option>
          </select>
        </div>
      </div>

      <div className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.usageSection}</h3>
        </div>
        {usage === undefined
          ? <div className="dsha-empty">{t.usageNone}</div>
          : <>
            <div className="dsha-row">
              <span className="dsha-label">{t.usageInputLabel}</span>
              <span className="dsha-value">{formatTokens(usage.inputTokens)}</span>
            </div>
            <div className="dsha-row">
              <span className="dsha-label">{t.usageOutputLabel}</span>
              <span className="dsha-value">{formatTokens(usage.outputTokens)}</span>
            </div>
            {usage.cacheReadTokens !== undefined && (
              <div className="dsha-row">
                <span className="dsha-label">{t.usageCacheLabel}</span>
                <span className="dsha-value">{formatTokens(usage.cacheReadTokens)}</span>
              </div>
            )}
            {usage.durationMs !== undefined && (
              <div className="dsha-row">
                <span className="dsha-label">{t.usageDurationLabel}</span>
                <span className="dsha-value">{(usage.durationMs / 1000).toFixed(1)}s</span>
              </div>
            )}
          </>}
        {status?.occupancy !== undefined && (
          <div className="dsha-row">
            <span className="dsha-label">{t.occupancyLabel}</span>
            <span className="dsha-value">
              {t.occupancyDetail
                .replace('{used}', formatTokens(status.occupancy.used))
                .replace('{size}', formatTokens(status.occupancy.size))}
            </span>
          </div>
        )}
        <details className="dshagy-details">
          <summary>{t.usageHintSummary}</summary>
          <p>{t.usageHint}</p>
        </details>
      </div>

      <div className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.scopeSection}</h3>
        </div>
        <p className="dsha-muted" style={{ fontSize: 12 }}>{t.scopeSummary}</p>
        <details className="dshagy-details">
          <summary>{t.scopeHintSummary}</summary>
          <ul className="dshagy-boundary">
            <li>{t.scopePrompt}</li>
            <li>{t.scopeHistory}</li>
            <li>{t.scopeTools}</li>
            <li>{t.scopeQuota}</li>
          </ul>
        </details>
      </div>
    </div>
  )
}

/** Every thinking level any listed model publishes, in first-seen order. */
function reasoningLevels(models: readonly { efforts: readonly string[] }[]): string[] {
  const seen = new Set<string>()
  const levels: string[] = []
  for (const model of models) {
    for (const level of model.efforts) {
      if (seen.has(level)) continue
      seen.add(level)
      levels.push(level)
    }
  }
  return levels
}
