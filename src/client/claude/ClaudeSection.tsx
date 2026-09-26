import React, { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ClaudeAccountSummaryDto,
  ClaudeConnectionDto,
  ClaudeLoginFlowDto,
  ClaudeModelOption,
  ClaudeQuotaWindow,
  ClaudeReasoningEffort,
  ClaudeWebStatus,
} from '../../shared/claude-contracts.ts'
import { CLAUDE_REASONING_EFFORTS } from '../../shared/claude-contracts.ts'
import { AccountPoolSection } from '../common/AccountPoolSection.tsx'
import { createQuotaFollowUp, type QuotaFollowUp } from '../common/quota-follow-up.ts'
import type { AccountRotationStrategy } from '../../shared/account-pool-contracts.ts'
import { zh } from './locales.ts'

const API = '/claude/api'

/**
 * The poll cadence of a pending sign-in.
 *
 * There is NO SSE channel in this plugin — every sibling line polls
 * 'login/status' on a timer while the user is in the browser, and this one does
 * the same so a stalled flow is visible rather than silent.
 */
const LOGIN_POLL_MS = 2000

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
    // A 403 from this surface is always the same-origin check refusing a
    // cross-origin mutation, so it is reported like any other refusal rather
    // than being singled out.
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
 * Seed one draft per model from a status payload.
 *
 * Also run after a model toggle: a model that was just enabled has no draft yet,
 * and the context window section only renders enabled models — exactly the rule
 * the sibling lines state in the same place.
 */
function contextDraftsFor(status: ClaudeWebStatus): Record<string, string> {
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

/**
 * Countdown to a window reset.
 *
 * Taken as an ISO 8601 instant because that is what the wire carries (the usage
 * endpoint and the response headers both state an absolute time), unlike the
 * sibling lines whose payloads use epoch milliseconds.
 */
function formatReset(resetsAt: string | null, nowLabel: string, unknownLabel: string): string {
  if (resetsAt === null || resetsAt === '') return unknownLabel
  const at = Date.parse(resetsAt)
  if (!Number.isFinite(at)) return unknownLabel
  const diff = at - Date.now()
  if (diff <= 0) return nowLabel
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${mins % 60}m`
  return `${mins}m`
}

/**
 * Display label per thinking level.
 *
 * The locale dictionary only accepts flat string values, so this table lives
 * with the control that renders it — the same arrangement every sibling uses.
 * Every level the wire can name is listed, 'xhigh' included: filtering a level
 * out here would hide a choice the host would accept and a catalog may expose.
 */
const EFFORT_LABELS: Record<ClaudeReasoningEffort, string> = {
  low: zh.effortLow,
  medium: zh.effortMedium,
  high: zh.effortHigh,
  xhigh: zh.effortXHigh,
  max: zh.effortMax,
}

/** One-line capability summary shown as a model pill's hover title. */
function modelFacts(model: ClaudeModelOption, t: typeof zh): string[] {
  const thinking = model.thinkingMode === 'mid-convo'
    ? t.thinkingModeMidConvo
    : model.thinkingMode === 'adaptive'
      ? t.thinkingModeAdaptive
      : model.thinkingMode === 'budget' ? t.thinkingModeBudget : t.thinkingModeNone
  return [
    model.id,
    model.supportsImage ? t.capImage : t.capNoImage,
    thinking,
    ...(model.canDisableThinking ? [t.capThinkingOff] : []),
    ...(model.reasoningEfforts.length > 0 ? [model.reasoningEfforts.join('/')] : []),
  ]
}

export function ClaudeSection({ onModelChange, loadModelDirectory }: Props): React.ReactElement {
  const [status, setStatus] = useState<ClaudeWebStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [flow, setFlow] = useState<ClaudeLoginFlowDto | null>(null)
  const [pasteValue, setPasteValue] = useState('')
  const [contextDrafts, setContextDrafts] = useState<Record<string, string>>({})
  const [savingModel, setSavingModel] = useState<string | null>(null)
  const [connection, setConnection] = useState<ClaudeConnectionDto | null>(null)

  /** Follow-up poll owed while the host refreshes the quota behind an answer. */
  const quotaFollowUp = useRef<QuotaFollowUp | null>(null)

  const t = zh

  const notifyChange = useCallback(() => {
    onModelChange?.()
    loadModelDirectory?.()
  }, [onModelChange, loadModelDirectory])

  /** Report one failure in the card's error strip. */
  const reportError = useCallback((err: unknown): void => {
    setError(err instanceof Error ? err.message : String(err))
  }, [])

  const loadStatus = useCallback(async (quiet = false) => {
    if (!quiet) setError(null)
    try {
      const data = await fetchApi<ClaudeWebStatus>('/status')
      setStatus(data)
      setContextDrafts(contextDraftsFor(data))
      // An answer that refreshed the quota behind itself is followed up shortly,
      // so the fresh numbers land without waiting for the next 60 s poll.
      quotaFollowUp.current ??= createQuotaFollowUp()
      quotaFollowUp.current.observe(data.quotaRefreshing === true, () => { void loadStatus(true) })
    } catch (err) {
      if (!quiet) reportError(err)
    } finally {
      setLoading(false)
    }
  }, [reportError])

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

  // The sign-in flow runs on the host and is polled here, because authorization
  // happens in a browser this card does not control. Every entry point into the
  // flow — the account card's sign-in button, the two-option login action, and a
  // per-account re-login — ends in the same 'pending' state, so one effect
  // drives all of them.
  useEffect(() => {
    if (flow?.status !== 'pending') return
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const poll = await fetchApi<ClaudeLoginFlowDto>('/login/status')
          setFlow(poll)
          if (poll.status === 'complete') {
            setPasteValue('')
            await loadStatus()
            notifyChange()
          } else if (poll.status === 'error') {
            setError(poll.error || t.loginFailed)
          }
        } catch {
          // A failed poll is transient; the next tick retries.
        }
      })()
    }, LOGIN_POLL_MS)
    return () => window.clearInterval(timer)
  }, [flow?.status, loadStatus, notifyChange, t.loginFailed])

  const handleLogin = async () => {
    try {
      setBusy('login')
      setError(null)
      setPasteValue('')
      const next = await fetchApi<ClaudeLoginFlowDto>('/login', {
        method: 'POST',
        body: JSON.stringify({}),
      })
      setFlow(next)
      // A host that opened the browser on its own still answers with the URL, so
      // a blocked popup changes nothing: the card renders the link below.
      if (next.authUrl) window.open(next.authUrl, '_blank', 'noopener,noreferrer')
    } catch (err) {
      reportError(err)
    } finally {
      setBusy(null)
    }
  }

  const handleCancelLogin = async () => {
    try {
      const next = await fetchApi<ClaudeLoginFlowDto>('/login/cancel', { method: 'POST' })
      setFlow(next)
    } catch (err) {
      reportError(err)
    }
  }

  /** Finish a manual-mode sign-in with the code the user pasted. */
  const handleSubmitPaste = async () => {
    if (pasteValue.trim() === '') return
    try {
      setBusy('login-input')
      setError(null)
      // The route answers with the refreshed STATUS, not with the flow: a
      // successful exchange stores the credential, so the account card, the
      // models and the quota are all stale by the time it returns.
      const updated = await fetchApi<ClaudeWebStatus>('/login/input', {
        method: 'POST',
        body: JSON.stringify({ input: pasteValue }),
      })
      setStatus(updated)
      setContextDrafts(contextDraftsFor(updated))
      setFlow({ status: 'idle' })
      setPasteValue('')
      notifyChange()
    } catch (err) {
      reportError(err)
    } finally {
      setBusy(null)
    }
  }

  /**
   * Add the local Claude Code sign-in as a snapshot.
   *
   * The host reads the file; the card only asks for the import.
   */
  const handleAdopt = async () => {
    try {
      setBusy('adopt')
      setError(null)
      const updated = await fetchApi<ClaudeWebStatus>('/adopt', { method: 'POST' })
      setStatus(updated)
      setContextDrafts(contextDraftsFor(updated))
      notifyChange()
    } catch (err) {
      reportError(err)
    } finally {
      setBusy(null)
    }
  }

  /** Forget every imported snapshot, or one of them. Claude Code's file is untouched. */
  const handleStopImporting = async (accountId?: string) => {
    try {
      setBusy(accountId === undefined ? 'adopt-disable' : `adopt-disable-${accountId}`)
      setError(null)
      const updated = await fetchApi<ClaudeWebStatus>('/adopt/disable', {
        method: 'POST',
        body: JSON.stringify(accountId === undefined ? {} : { accountId }),
      })
      setStatus(updated)
      notifyChange()
    } catch (err) {
      reportError(err)
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
      const updated = await fetchApi<ClaudeWebStatus>('/accounts', {
        method: 'POST',
        body: JSON.stringify({ action, accountId }),
      })
      setStatus(updated)
      notifyChange()
    } catch (err) {
      reportError(err)
    } finally {
      setBusy(null)
    }
  }

  const handleSetStrategy = async (strategy: AccountRotationStrategy) => {
    try {
      setBusy('strategy')
      setError(null)
      const updated = await fetchApi<ClaudeWebStatus>('/accounts', {
        method: 'POST',
        body: JSON.stringify({ action: 'strategy', strategy }),
      })
      setStatus(updated)
    } catch (err) {
      reportError(err)
    } finally {
      setBusy(null)
    }
  }

  /**
   * Re-authorize ONE account.
   *
   * Nothing is deleted: the sign-in route is addressed at this account id, so
   * the new credential lands in that row and keeps its alias and place in the
   * rotation. The flow DTO it returns is what starts the polling above.
   */
  const handleRelogin = (accountId: string): void => {
    void (async () => {
      try {
        setBusy(`relogin-${accountId}`)
        setError(null)
        setPasteValue('')
        const next = await fetchApi<ClaudeLoginFlowDto>('/login', {
          method: 'POST',
          body: JSON.stringify({ accountId }),
        })
        setFlow(next)
        if (next.authUrl) window.open(next.authUrl, '_blank', 'noopener,noreferrer')
      } catch (err) {
        reportError(err)
      } finally {
        setBusy(null)
      }
    })()
  }

  const handleRefreshQuota = async () => {
    try {
      setBusy('quota')
      setError(null)
      // A quota FAILURE is not a failed request: it arrives as `quotaError` on a
      // 200, so the card keeps rendering the account beside the reason.
      const updated = await fetchApi<ClaudeWebStatus>('/quota', { method: 'POST' })
      setStatus(updated)
    } catch (err) {
      reportError(err)
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
      const updated = await fetchApi<ClaudeWebStatus>('/catalog/refresh', { method: 'POST' })
      setStatus(updated)
      setContextDrafts(contextDraftsFor(updated))
      notifyChange()
    } catch (err) {
      reportError(err)
    } finally {
      setBusy(null)
    }
  }

  const handleTestConnection = async () => {
    try {
      setBusy('connection')
      setError(null)
      setConnection(null)
      // A refusal is a VALUE here: the route answers 200 with `connected: false`
      // and a reason, because explaining the refusal is the whole job.
      const result = await fetchApi<ClaudeConnectionDto>('/connection/test', { method: 'POST' })
      setConnection(result)
      // The probe is a real request against the account, so the quota shown is
      // now current.
      await loadStatus(true)
    } catch (err) {
      reportError(err)
    } finally {
      setBusy(null)
    }
  }

  const applyEnabled = async (enabledModelIds: string[]) => {
    try {
      const updated = await fetchApi<ClaudeWebStatus>('/models', {
        method: 'POST',
        body: JSON.stringify({ enabledModelIds }),
      })
      setStatus(updated)
      // A model that was just checked has no draft yet; the context window
      // section only renders enabled models.
      setContextDrafts(contextDraftsFor(updated))
      notifyChange()
    } catch (err) {
      reportError(err)
    }
  }

  const toggleEnabled = async (enabled: boolean) => {
    setStatus((prev) => prev ? { ...prev, enabled } : prev)
    try {
      const updated = await fetchApi<ClaudeWebStatus>('/settings', {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      })
      setStatus(updated)
      notifyChange()
    } catch (err) {
      reportError(err)
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

  const handleUpdateEffort = async (effort: ClaudeReasoningEffort | null) => {
    try {
      const updated = await fetchApi<ClaudeWebStatus>('/settings', {
        method: 'POST',
        body: JSON.stringify({ defaultReasoningEffort: effort }),
      })
      setStatus(updated)
      notifyChange()
    } catch (err) {
      reportError(err)
    }
  }

  const handleSaveContextWindow = async (modelId: string) => {
    const raw = contextDrafts[modelId] || ''
    const parsed = parsePositiveCapacity(raw)
    if (parsed === null) {
      setError(t.contextWindowInvalid.replace('{value}', raw))
      return
    }
    try {
      setSavingModel(modelId)
      setError(null)
      const updated = await fetchApi<ClaudeWebStatus>('/settings', {
        method: 'POST',
        body: JSON.stringify({ contextWindowOverrides: { [modelId]: parsed } }),
      })
      setStatus(updated)
      setContextDrafts((prev) => ({ ...prev, [modelId]: formatCapacity(parsed) }))
      notifyChange()
    } catch (err) {
      reportError(err)
    } finally {
      setSavingModel(null)
    }
  }

  /**
   * Clear one override.
   *
   * `null` is the card's "restore the catalog default" and the host preserves
   * it through its own normalization, which is what makes this a delete rather
   * than a save of the default value.
   */
  const handleResetContextWindow = async (modelId: string) => {
    try {
      setSavingModel(modelId)
      setError(null)
      const updated = await fetchApi<ClaudeWebStatus>('/settings', {
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
      reportError(err)
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
      const updated = await fetchApi<ClaudeWebStatus>('/settings', {
        method: 'POST',
        body: JSON.stringify({ contextWindowOverrides: Object.fromEntries(models.map((model) => [model, null])) }),
      })
      setStatus(updated)
      setContextDrafts(contextDraftsFor(updated))
      notifyChange()
    } catch (err) {
      reportError(err)
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

  const accounts = (status?.accounts ?? []) as ClaudeAccountSummaryDto[]
  const hasAdopted = accounts.some((account) => account.adopted === true || account.removable === false)
  const contextModels = status?.models.filter((model) => model.enabled) ?? []
  const overrideCount = Object.keys(status?.contextWindowOverrides ?? {}).length
  const quota = status?.quota
  const windows: ClaudeQuotaWindow[] = quota?.windows ?? []

  return (
    <div className="dsha-page">
      <AccountPoolSection<ClaudeAccountSummaryDto>
        accounts={accounts}
        activeAccountId={status?.activeAccountId}
        rotationStrategy={status?.rotationStrategy ?? 'sequential'}
        busy={busy}
        labels={t}
        onLogin={() => void handleLogin()}
        onSetPrimary={(accountId) => void handleAccountAction('set-primary', accountId)}
        onDelete={(accountId) => void handleAccountAction('delete', accountId)}
        onClearCooldown={(accountId) => void handleAccountAction('clear-cooldown', accountId)}
        onRelogin={(accountId) => handleRelogin(accountId)}
        onSetStrategy={(strategy) => void handleSetStrategy(strategy)}
        storageValue={status?.storagePath || '—'}
        renderLoginActions={() => (
          <div className="dsha-account-add-actions">
            <button
              className="dsha-btn dsha-btn-primary"
              disabled={busy !== null}
              aria-label={t.signIn}
              onClick={() => void handleLogin()}
            >
              {busy === 'login' ? t.signingIn : t.signIn}
            </button>
            {/* The second entry: an existing local Claude Code sign-in can be
                borrowed instead of running a fresh OAuth flow. */}
            <button
              className="dsha-btn"
              disabled={busy !== null}
              aria-label={t.importClaudeCode}
              onClick={() => void handleAdopt()}
            >
              {busy === 'adopt' ? t.importing : t.importClaudeCode}
            </button>
          </div>
        )}
        renderAccountActions={(entry) => (
          // An imported row is a snapshot of a sign-in this plugin does NOT own,
          // so the shared card suppresses Delete for it ('removable: false') and
          // this is the action that replaces it. Un-importing forgets the
          // snapshot; Claude Code's own file is never touched.
          entry.adopted === true || entry.removable === false ? (
            <button
              className="dsha-btn"
              disabled={busy !== null}
              aria-label={`${t.stopImporting}: ${entry.id}`}
              onClick={() => void handleStopImporting(entry.id)}
            >
              {busy === `adopt-disable-${entry.id}` ? t.importing : t.stopImporting}
            </button>
          ) : null
        )}
        renderDetails={(entry) => (
          <>
            {entry.email && <span>{t.email}: {entry.email}</span>}
            {entry.planLabel && <span>{t.plan}: {entry.planLabel}</span>}
            {entry.subscriptionType && <span>{t.subscriptionType}: {entry.subscriptionType}</span>}
            <span>
              {t.source}: {entry.source === 'claude-code' ? t.sourceClaudeCode : t.sourceManaged}
            </span>
            {entry.sourcePath && (
              <span className="dshcl-mono" title={entry.sourcePath}>{t.snapshotPath}: {entry.sourcePath}</span>
            )}
          </>
        )}
      >
        <p className="dsha-muted" style={{ paddingTop: 12 }}>{t.importHint}</p>
        <p className="dsha-muted">
          {status?.claudeCodeSignInAvailable === true ? t.importClaudeCode : t.importUnavailable}
        </p>
        {status?.claudeCodePaths !== undefined && status.claudeCodePaths.length > 0 && (
          <p className="dsha-muted dshcl-mono">
            {t.importSearched.replace('{paths}', status.claudeCodePaths.join(' · '))}
          </p>
        )}
        {hasAdopted && (
          <div className="dsha-actions">
            <button
              className="dsha-btn"
              disabled={busy !== null}
              aria-label={t.stopImporting}
              onClick={() => void handleStopImporting()}
            >
              {busy === 'adopt-disable' ? t.importing : t.stopImporting}
            </button>
          </div>
        )}

        {flow !== null && flow.status !== 'idle' && flow.status !== 'complete' && (
          <div className="dshcl-flow">
            <strong>{t.signInSection}</strong>
            <p className="dsha-muted">
              {flow?.status === 'error'
                ? `${t.loginFailed}: ${flow.error ?? ''}`
                : flow?.status === 'exchanging'
                  ? t.loginExchanging
                  : flow?.mode === 'manual' ? t.loginModeManual : t.loginModeLoopback}
            </p>
            {flow?.hint !== undefined && <p className="dsha-muted">{flow.hint}</p>}
            {flow?.fallbackReason !== undefined && (
              <p className="dsha-notice">{t.loginFallbackReason.replace('{detail}', flow.fallbackReason)}</p>
            )}
            {flow?.authUrl !== undefined && (
              <>
                <span className="dsha-label">{t.authorizeUrl}</span>
                <code className="dshcl-flow-url">{flow.authUrl}</code>
                <div className="dsha-actions">
                  <a className="dsha-btn" href={flow.authUrl} target="_blank" rel="noreferrer noopener">
                    {t.openAuthorizeUrl}
                  </a>
                </div>
              </>
            )}
            {flow?.redirectUri !== undefined && (
              <div className="dsha-row">
                <span className="dsha-label">{t.redirectUri}</span>
                <span className="dsha-value dshcl-mono">{flow.redirectUri}</span>
              </div>
            )}
            {/* Always rendered while a flow is pending, and never hidden behind a
                mode test: manual mode has no browser callback at all, so for those
                users this box is the only way to finish signing in. */}
            <div className="dshcl-paste">
              <strong>{t.manualPasteSection}</strong>
              <p className="dsha-muted">{t.manualPasteHint}</p>
              <div className="dshcl-paste-row">
                <input
                  type="text"
                  className="dsha-select"
                  aria-label={t.manualPasteSection}
                  placeholder={t.manualPastePlaceholder}
                  value={pasteValue}
                  disabled={busy !== null}
                  onChange={(event) => setPasteValue(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void handleSubmitPaste()
                  }}
                />
                <button
                  className="dsha-btn dsha-btn-primary"
                  disabled={busy !== null || pasteValue.trim() === ''}
                  onClick={() => void handleSubmitPaste()}
                >
                  {busy === 'login-input' ? t.manualPasteSubmitting : t.manualPasteSubmit}
                </button>
                <button className="dsha-btn" disabled={busy !== null} onClick={() => void handleCancelLogin()}>
                  {t.cancelSignIn}
                </button>
              </div>
            </div>
          </div>
        )}
      </AccountPoolSection>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.connection}</h3>
        </div>
        <div className="dsha-row" style={{ marginBottom: 12 }}>
          <span className="dsha-label" style={{ fontWeight: 600 }}>{t.enableProvider}</span>
          <input
            type="checkbox"
            aria-label={t.enableProvider}
            checked={status?.enabled !== false}
            disabled={busy !== null}
            onChange={(event) => void toggleEnabled(event.currentTarget.checked)}
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
        {status?.account !== null && status?.account !== undefined && (
          <div className="dsha-row">
            <span className="dsha-label">{t.account}</span>
            <span className="dsha-value">
              {status.account.email ?? t.planUnknown}
              {status.account.subscriptionType !== null ? ` · ${status.account.subscriptionType}` : ''}
            </span>
          </div>
        )}
        <p className="dsha-notice">
          {status?.serving === false && status.conflict
            ? t.routeConflict.replace('{detail}', status.conflict)
            : t.routeOwned}
        </p>
        {connection !== null && (
          <p className={connection.connected ? 'dsha-muted' : 'dsha-notice'}>
            {connection.connected
              ? `${t.testSuccess} · ${t.testLatency.replace('{ms}', String(connection.latencyMs))}`
              : t.testFailed.replace('{detail}', connection.error ?? `HTTP ${connection.status}`)
                + ` (${connection.retryable ? t.testRetryable : t.testNotRetryable})`}
          </p>
        )}
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
          <button
            className="dsha-btn"
            disabled={busy !== null}
            onClick={() => void handleRefreshCatalog()}
          >
            {busy === 'catalog' ? t.refreshingCatalog : t.refreshCatalog}
          </button>
        </div>
        <p className="dsha-muted dsha-models-hint">{t.modelsHint}</p>
        <div className="dsha-models" aria-label="Claude Models">
          {status?.models.map((model: ClaudeModelOption) => (
            <label key={model.id} title={modelFacts(model, t).join(' · ')}>
              <input
                type="checkbox"
                checked={model.enabled}
                disabled={busy !== null}
                onChange={(event) => toggleModel(model.id, event.currentTarget.checked)}
              />
              <span>{model.name}</span>
            </label>
          ))}
        </div>
        <div className="dsha-actions">
          <button
            className="dsha-btn"
            disabled={busy !== null}
            onClick={() => setAllModels(true)}
          >
            {t.selectAll}
          </button>
          <button
            className="dsha-btn"
            disabled={busy !== null}
            onClick={() => setAllModels(false)}
          >
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
              void handleUpdateEffort(value === '' ? null : (value as ClaudeReasoningEffort))
            }}
          >
            <option value="">{t.defaultEffortAuto}</option>
            {/* Exactly what the catalog exposes, 'xhigh' included. */}
            {CLAUDE_REASONING_EFFORTS.map((effort) => (
              <option key={effort} value={effort}>{EFFORT_LABELS[effort]}</option>
            ))}
          </select>
        </div>
        <p className="dsha-muted" style={{ paddingTop: 10 }}>{t.modelLadders}</p>
        {status?.models.map((model) => (
          <div key={model.id} className="dsha-row">
            <span className="dsha-label">{model.name}</span>
            <span className="dsha-value">
              {model.reasoningEfforts.length === 0 ? t.modelLadderNone : model.reasoningEfforts.join(' · ')}
            </span>
          </div>
        ))}
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
          {contextModels.map((model: ClaudeModelOption) => (
            <div key={model.id} className="dsha-context-row">
              <span title={model.id}>
                {model.name}
                {model.defaultContextWindow < model.contextWindow && (
                  <span className="dshcl-model-meta">{formatCapacity(model.contextWindow)}</span>
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
                <button
                  type="button"
                  className="dsha-context-save dsha-context-reset"
                  aria-label={`${model.name} ${t.contextWindowReset}`}
                  disabled={savingModel === model.id
                    || status?.contextWindowOverrides[model.id] === undefined}
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
          <button
            className="dsha-btn"
            disabled={busy !== null || !status?.authenticated}
            onClick={() => void handleRefreshQuota()}
          >
            {busy === 'quota' ? t.refreshingQuota : t.refreshQuota}
          </button>
        </div>
        <p className="dsha-muted">{t.quotaDesc}</p>

        {/* A refresh running behind the answer is rendered beside the snapshot
            rather than instead of it: the numbers on screen are real, just not
            the newest, and the follow-up poll brings the newer ones. */}
        {status?.quotaRefreshing === true && <p className="dsha-notice">{t.quotaRefreshing}</p>}
        {status?.quotaError !== undefined && status.quotaError !== null && (
          <p className="dsha-notice">{t.quotaError}: {status.quotaError}</p>
        )}

        {!status?.authenticated ? (
          <div className="dsha-empty">{t.quotaSignedOut}</div>
        ) : quota === null || quota === undefined ? (
          <div className="dsha-empty">{busy === 'quota' ? t.refreshingQuota : t.quotaEmpty}</div>
        ) : (
          <div className="dsha-quota-card">
            <div className="dsha-quota-title">
              <strong>{status.account?.subscriptionType ?? t.quotaSection}</strong>
              <span>{status.account?.email ?? t.planUnknown}</span>
            </div>

            {windows.map((window) => {
              // 'utilization' is PERCENT USED, so the bar fills with consumption
              // while the colour grades what is LEFT. 0% used is the normal empty
              // state, and a null is "the source said nothing" — rendered as an
              // unknown, never as a zero nobody measured.
              const used = window.usedPercent
              const remaining = window.remainingPercent ?? (used === null ? null : Math.max(0, 100 - used))
              const level = remaining === null ? 'dsha-meter-cyan' : remaining <= 5 ? 'dsha-meter-cyan' : 'dsha-meter-green'
              return (
                <div key={window.id} className="dsha-meter-wrap">
                  <div className="dsha-meter-label">
                    <span>{window.label}</span>
                    <strong>
                      {remaining === null ? t.quotaUnknown : `${Math.round(remaining)}% ${t.left}`}
                    </strong>
                  </div>
                  {used !== null && (
                    <div className={`dsha-meter ${level}`}>
                      <span style={{ width: `${Math.min(100, Math.max(0, used))}%` }} />
                    </div>
                  )}
                  <div className="dsha-meter-meta">
                    <span>{t.usedLabel}: {used === null ? t.quotaUnknown : `${Math.round(used)}%`}</span>
                    <span>
                      {t.remainingLabel}: {remaining === null ? t.quotaUnknown : `${Math.round(remaining)}%`}
                    </span>
                    <span>{t.resetAt.replace('{time}', formatReset(window.resetsAt, t.now, t.resetUnknown))}</span>
                    <span>{window.source === 'headers' ? t.sourceHeaders : t.sourceUsage}</span>
                  </div>
                  {used === null && <p className="dsha-muted">{t.quotaUnknownHint}</p>}
                </div>
              )
            })}

            {quota.extraUsage !== null && (
              <div className="dsha-meter-wrap">
                <div className="dsha-meter-label">
                  <span>{quota.extraUsage.label || t.extraUsage}</span>
                  <strong>
                    {quota.extraUsage.remainingPercent === null
                      ? t.quotaUnknown
                      : `${Math.round(quota.extraUsage.remainingPercent)}% ${t.left}`}
                  </strong>
                </div>
                {quota.extraUsage.usedPercent !== null && (
                  <div className="dsha-meter dsha-meter-cyan">
                    <span style={{ width: `${Math.min(100, Math.max(0, quota.extraUsage.usedPercent))}%` }} />
                  </div>
                )}
                <div className="dsha-meter-meta">
                  <span>{t.extraUsage}: {quota.extraUsage.enabled ? t.extraUsageEnabled : t.extraUsageDisabled}</span>
                  {quota.extraUsage.used !== null && <span>{t.usedLabel}: {quota.extraUsage.used}</span>}
                  {quota.extraUsage.limit !== null && (
                    <span>{t.extraUsageLimit}: {quota.extraUsage.limit}</span>
                  )}
                </div>
              </div>
            )}

            {quota.status !== null && (
              <div className="dsha-row">
                <span className="dsha-label">{t.quotaStatus}</span>
                <span className="dsha-value">{quota.status}</span>
              </div>
            )}
            {quota.representativeClaim !== null && (
              <div className="dsha-row">
                <span className="dsha-label">{t.quotaRepresentative}</span>
                <span className="dsha-value">{quota.representativeClaim}</span>
              </div>
            )}

            {windows.length === 0 && quota.extraUsage === null && (
              <div className="dsha-empty">{t.quotaEmpty}</div>
            )}

            <div className="dsha-timestamp">
              {quota.fetchedAt === null
                ? t.observedAt.replace('{time}', formatDate(quota.observedAt))
                : t.updatedAt.replace('{time}', formatDate(quota.fetchedAt))}
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
