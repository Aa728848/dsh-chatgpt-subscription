import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  WorkBuddyAccount,
  WorkBuddyModelOption,
  WorkBuddyReasoningEffort,
  WorkBuddyWebStatus,
} from '../../shared/workbuddy-contracts.ts'
import { WORKBUDDY_REASONING_EFFORTS } from '../../shared/workbuddy-contracts.ts'
import { zh } from './locales.ts'
import { AccountPoolSection } from '../common/AccountPoolSection.tsx'
import { accountPoolZh, type AccountPoolLabels } from '../common/account-pool-labels.ts'
import type { AccountRotationStrategy } from '../../shared/account-pool-contracts.ts'
import type { WorkBuddyAccountSummaryDto } from '../../shared/workbuddy-contracts.ts'

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

/**
 * The shared card's label set.
 *
 * Only the three labels WorkBuddy genuinely words differently are taken from
 * this tab's dictionary; everything else is the shared set, so the five
 * provider tabs cannot drift apart in wording.
 */
function accountPoolLabels(t: typeof zh): AccountPoolLabels {
  return {
    ...accountPoolZh,
    noAccounts: t.noAccounts,
    storageNotice: t.storageNotice,
    // A WorkBuddy identity reads as a nickname, not an e-mail address.
    email: t.nickname,
  }
}

interface LoginPollStatus {
  status: 'idle' | 'pending' | 'complete' | 'error'
  region?: 'cn' | 'intl'
  authUrl?: string
  progress?: string
  accountId?: string
  error?: string
}

interface ConnectionPayload {
  connected: boolean
  account: WorkBuddyAccount | null
  latencyMs: number
  model: string
  checkedAt: number
}

/**
 * Call one settings route and unwrap its `{ ok, value }` envelope.
 *
 * The response body is read as text first, because a route that is not mounted
 * answers with an empty body — and `res.json()` on that throws a bare
 * "Unexpected end of JSON input" that says nothing about what actually failed.
 * That is exactly what happens when the client bundle is newer than the Host
 * process (a stale Host has no route to answer), so the error is reported as
 * such instead of as a credential problem.
 */
async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })
  const text = await res.text()
  if (text.trim() === '') {
    throw new Error(
      `The WorkBuddy settings route did not answer (HTTP ${res.status} ${res.statusText || 'no body'}). `
      + 'The plugin loaded in the browser may be newer than the one running in the Host — '
      + 'restart DSH so both halves come from the same build.',
    )
  }
  let json: { ok?: boolean; value?: T; error?: string }
  try {
    json = JSON.parse(text) as { ok?: boolean; value?: T; error?: string }
  } catch {
    throw new Error(
      `The WorkBuddy settings route returned a non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`,
    )
  }
  if (!res.ok || json.ok !== true) {
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

/** One selectable default reasoning level, with the models that declare it. */
export interface ReasoningEffortChoice {
  value: WorkBuddyReasoningEffort
  /** Model names that accept this level, in catalog order. */
  models: string[]
}

/**
 * Reasoning levels the default-effort control may offer.
 *
 * The levels come from what this account's models actually declare — never from
 * the shipped enum alone. The setting is one global default applied to whichever
 * model a conversation uses, so the list is their union; each entry carries the
 * models behind it, and a level only some models accept is labelled as such.
 * Order follows {@link WORKBUDDY_REASONING_EFFORTS}, which is the escalating
 * order the upstream ladder uses.
 */
export function reasoningEffortChoices(models: WorkBuddyModelOption[]): ReasoningEffortChoice[] {
  const declared = new Map<string, string[]>()
  for (const model of models) {
    for (const effort of model.reasoningEfforts ?? []) {
      const names = declared.get(effort)
      if (names === undefined) declared.set(effort, [model.name])
      else names.push(model.name)
    }
  }
  return WORKBUDDY_REASONING_EFFORTS
    .filter((effort) => declared.has(effort))
    .map((effort) => ({ value: effort, models: declared.get(effort)! }))
}

/**
 * Whether a saved default is unusable for every model on this account.
 *
 * The adapter drops a level the chosen model does not accept instead of sending
 * it, so a value that no model declares silently does nothing. Reporting it is
 * what keeps that from looking like the setting was applied.
 */
export function unsupportedReasoningEffort(
  configured: WorkBuddyReasoningEffort | null | undefined,
  models: WorkBuddyModelOption[],
): WorkBuddyReasoningEffort | null {
  if (configured === null || configured === undefined) return null
  const supported = models.some((model) => (model.reasoningEfforts ?? []).includes(configured))
  return supported ? null : configured
}

/** Defend against a response that omits the arrays the card renders. */
function normalizeStatus(data: WorkBuddyWebStatus): WorkBuddyWebStatus {
  return {
    ...data,
    models: Array.isArray(data?.models) ? data.models : [],
    contextWindowOverrides: data?.contextWindowOverrides ?? {},
    accounts: Array.isArray(data?.accounts) ? data.accounts : [],
  }
}

export function WorkBuddySection({ onModelChange, loadModelDirectory }: Props): React.ReactElement {
  const [status, setStatus] = useState<WorkBuddyWebStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Whether the last `/status` call failed. A failed status read leaves
  // `status` null, which must NOT be rendered as "no credential found": that
  // claims a credential problem when the real cause is an unreachable route.
  const [statusFailed, setStatusFailed] = useState(false)
  const [connection, setConnection] = useState<ConnectionPayload | null>(null)
  const [loginProgress, setLoginProgress] = useState<string | null>(null)
  const loginIntervalRef = useRef<number | null>(null)
  const loginTimeoutRef = useRef<number | null>(null)
  const [contextDrafts, setContextDrafts] = useState<Record<string, string>>({})
  const [savingModel, setSavingModel] = useState<string | null>(null)

  const t = zh

  const notifyChange = useCallback(() => {
    onModelChange?.()
    loadModelDirectory?.()
  }, [onModelChange, loadModelDirectory])

  // The level list follows the models this account actually declares, so the
  // control cannot offer a level none of them accepts.
  const effortChoices = useMemo(
    () => reasoningEffortChoices(status?.models ?? []),
    [status?.models],
  )
  const allModels = status?.models ?? []
  // The pool summaries the shared card renders; the legacy single-account view
  // below stays for a caller whose host has no pool installed.
  const poolAccounts = useMemo<WorkBuddyAccountSummaryDto[]>(
    () => (Array.isArray(status?.accounts) ? status.accounts : []),
    [status?.accounts],
  )
  const strayEffort = unsupportedReasoningEffort(status?.defaultReasoningEffort, allModels)

  const loadStatus = useCallback(async (quiet = false) => {
    if (!quiet) setError(null)
    try {
      const data = await fetchApi<WorkBuddyWebStatus>('/status')
      // A response without the expected arrays must still render, so they are
      // normalized rather than trusted.
      const normalized = normalizeStatus(data)
      setStatus(normalized)
      setStatusFailed(false)
      const drafts: Record<string, string> = {}
      for (const model of normalized.models) {
        drafts[model.id] = formatCapacity(normalized.contextWindowOverrides[model.id] || model.defaultContextWindow)
      }
      setContextDrafts(drafts)
    } catch (err) {
      setStatusFailed(true)
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
    return () => {
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      if (loginIntervalRef.current !== null) window.clearInterval(loginIntervalRef.current)
      if (loginTimeoutRef.current !== null) window.clearTimeout(loginTimeoutRef.current)
    }
  }, [loadStatus])

  const handleRescan = async () => {
    try {
      setBusy('rescan')
      setError(null)
      const updated = await fetchApi<WorkBuddyWebStatus>('/rescan', { method: 'POST' })
      setStatus(normalizeStatus(updated))
      notifyChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleAddAccount = async (region: 'cn' | 'intl') => {
    try {
      setBusy(`login:${region}`)
      setError(null)
      setLoginProgress(t.loginWaiting)
      const flow = await fetchApi<LoginPollStatus>('/accounts/login', {
        method: 'POST',
        body: JSON.stringify({ region }),
      })
      if (flow.authUrl) window.open(flow.authUrl, '_blank', 'noopener,noreferrer')
      if (loginIntervalRef.current !== null) window.clearInterval(loginIntervalRef.current)
      if (loginTimeoutRef.current !== null) window.clearTimeout(loginTimeoutRef.current)
      const timer = window.setInterval(() => {
        void (async () => {
          try {
            const poll = await fetchApi<LoginPollStatus>('/accounts/login/status')
            if (poll.progress) setLoginProgress(poll.progress)
            if (poll.status === 'complete') {
              window.clearInterval(timer)
              loginIntervalRef.current = null
              if (loginTimeoutRef.current !== null) window.clearTimeout(loginTimeoutRef.current)
              loginTimeoutRef.current = null
              setBusy(null)
              setLoginProgress(null)
              if (poll.accountId) {
                await fetchApi<WorkBuddyWebStatus>('/settings', {
                  method: 'POST',
                  body: JSON.stringify({ selectedAccountId: poll.accountId }),
                })
              }
              await loadStatus()
              notifyChange()
            } else if (poll.status === 'error') {
              window.clearInterval(timer)
              loginIntervalRef.current = null
              if (loginTimeoutRef.current !== null) window.clearTimeout(loginTimeoutRef.current)
              loginTimeoutRef.current = null
              setBusy(null)
              setLoginProgress(null)
              setError(poll.error || t.loginFailed)
            }
          } catch {
            // Transient polling failure; the next interval retries.
          }
        })()
      }, 1500)
      loginIntervalRef.current = timer
      loginTimeoutRef.current = window.setTimeout(() => {
        window.clearInterval(timer)
        loginIntervalRef.current = null
        loginTimeoutRef.current = null
        setBusy(null)
        setLoginProgress(null)
      }, 5 * 60 * 1000)
    } catch (err) {
      setBusy(null)
      setLoginProgress(null)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * One account action, whether it is a pool action (`set-primary`, `hide`) or a
   * credential action (`delete`). The host route dispatches on `action`.
   */
  const handlePoolAction = async (action: string, accountId: string) => {
    try {
      setBusy(`${action}:${accountId}`)
      setError(null)
      const updated = await fetchApi<WorkBuddyWebStatus>('/accounts/action', {
        method: 'POST',
        body: JSON.stringify({ action, accountId }),
      })
      setStatus(normalizeStatus(updated))
      notifyChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleDeleteAccount = async (accountId: string) => {
    if (!window.confirm(t.deleteConfirm)) return
    await handlePoolAction('delete', accountId)
  }

  const handleSetStrategy = async (strategy: AccountRotationStrategy) => {
    try {
      setBusy('strategy')
      setError(null)
      const updated = await fetchApi<WorkBuddyWebStatus>('/accounts/strategy', {
        method: 'POST',
        body: JSON.stringify({ strategy }),
      })
      setStatus(normalizeStatus(updated))
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
  const authenticated = status?.authenticated === true
  // A failed status read is not "no credential": showing the credential hint
  // here would send the user chasing a problem that does not exist.
  const unreachable = statusFailed && status === null

  return (
    <div className="dsha-page">
      <AccountPoolSection<WorkBuddyAccountSummaryDto>
        accounts={poolAccounts}
        activeAccountId={status?.activeAccountId}
        rotationStrategy={status?.rotationStrategy ?? 'sequential'}
        labels={accountPoolLabels(t)}
        busy={busy}
        onLogin={() => void handleAddAccount('cn')}
        onSetPrimary={(id) => void handlePoolAction('set-primary', id)}
        onDelete={(id) => void handleDeleteAccount(id)}
        onClearCooldown={(id) => void handlePoolAction('clear-cooldown', id)}
        onRelogin={(id) => void handlePoolAction('relogin', id)}
        onSetStrategy={(strategy) => void handleSetStrategy(strategy)}
        storageValue={status?.managedStoragePath}
        renderLoginActions={() => (
          <div className="dsha-account-add-actions">
            <button className="dsha-btn dsha-btn-primary" disabled={busy !== null} onClick={() => void handleAddAccount('cn')}>
              {busy === 'login:cn' ? t.authorizing : t.addCnAccount}
            </button>
            <button className="dsha-btn dsha-btn-primary" disabled={busy !== null} onClick={() => void handleAddAccount('intl')}>
              {busy === 'login:intl' ? t.authorizing : t.addIntlAccount}
            </button>
          </div>
        )}
        renderAccountActions={(candidate) => (
          // Only an account this plugin owns may be deleted; a desktop account
          // is the IDE's, so the card offers hide/restore for it instead.
          candidate.removable ? null : (
            <>
              {candidate.hidden === true && (
                <button className="dsha-btn" disabled={busy !== null} onClick={() => void handlePoolAction('restore', candidate.id)}>
                  {t.restoreAccount}
                </button>
              )}
              {candidate.hidden !== true && (
                <button className="dsha-btn" disabled={busy !== null} onClick={() => void handlePoolAction('hide', candidate.id)}>
                  {t.hideAccount}
                </button>
              )}
            </>
          )
        )}
        renderDetails={(candidate) => (
          <>
            {candidate.uin ? <span>{t.uin}: {maskUin(candidate.uin)}</span> : null}
            {candidate.accountType ? <span>{t.accountType}: {candidate.accountType}</span> : null}
            <span>
              {t.region}: {candidate.region === 'intl' ? t.regionIntl : t.regionCn}
            </span>
            {candidate.domain ? (
              <span className="dshwb-mono" title={`${candidate.domain} · ${candidate.backend ?? ''}`}>
                {candidate.domain}
              </span>
            ) : null}
            <span className="dshwb-mono">
              {candidate.source === 'managed' ? t.encryptedStorage : displayFile(candidate.sourceFile)}
            </span>
            {candidate.hidden === true ? <span>{t.hiddenAccount}</span> : null}
          </>
        )}
      >
        {/* The shared empty state already covers "no account signed in"; only
            an unreachable route needs a panel of its own, because it must not
            read as a credential problem. */}
        {unreachable ? (
          <>
            <div className="dsha-empty">{t.routeUnreachable}</div>
            <p className="dsha-notice">{t.routeUnreachableHint}</p>
          </>
        ) : null}
        {loginProgress ? <p className="dsha-notice">{loginProgress}</p> : null}
        <div className="dsha-row" style={{ marginTop: 12 }}>
          <span className="dsha-label">{t.authDirectory}</span>
          <span className="dsha-value dshwb-mono" title={status?.authDirectory || ''}>
            {status?.authDirectory || '—'}
          </span>
        </div>
        <div className="dsha-actions">
          <button className="dsha-btn" disabled={busy !== null} onClick={() => void handleRescan()}>
            {busy === 'rescan' ? t.rescanning : t.rescan}
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
          {status?.models.map((model: WorkBuddyModelOption) => {
            // The pill shows only the model name, as every sibling tab does;
            // the capability facts ride the tooltip instead of a second line.
            const facts = [
              model.id,
              formatCapacity(model.contextWindow),
              model.supportsImage ? t.imageSupport : t.textOnly,
              ...(model.reasoningEfforts && model.reasoningEfforts.length > 0
                ? [model.reasoningEfforts.join('/')]
                : []),
            ]
            return (
              <label key={model.id} title={facts.join(' · ')}>
                <input
                  type="checkbox"
                  checked={model.enabled}
                  disabled={busy !== null}
                  onChange={(event) => void toggleModel(model.id, event.currentTarget.checked)}
                />
                <span>{model.name}</span>
              </label>
            )
          })}
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
            {strayEffort !== null ? <p className="dsha-muted">{t.defaultEffortKept}</p> : null}
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
            {/* A saved level no model declares is kept selectable so opening
                the card does not silently rewrite the stored value. */}
            {strayEffort !== null ? (
              <option value={strayEffort}>{`${EFFORT_LABELS[strayEffort]} (${t.effortUnsupported})`}</option>
            ) : null}
            {effortChoices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.models.length === allModels.length
                  ? EFFORT_LABELS[choice.value]
                  : `${EFFORT_LABELS[choice.value]} (${choice.models.length}/${allModels.length})`}
              </option>
            ))}
          </select>
        </div>
        {effortChoices.length === 0 ? (
          <p className="dsha-muted">{t.noReasoningModels}</p>
        ) : null}
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
