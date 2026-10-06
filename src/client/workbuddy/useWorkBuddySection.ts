/**
 * The WorkBuddy card's state, effects and actions.
 *
 * Split out of 'WorkBuddySection.tsx' so that file is markup and this one is
 * behaviour: what the card tracks, what it derives from a status answer, and
 * every request a control can make. The view reads one named shape — see
 * `WorkBuddySectionView` — so the contract between the two is visible here
 * rather than inferred from the JSX.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AccountRotationStrategy } from '../../shared/account-pool-contracts.ts'
import type {
  WorkBuddyAccount,
  WorkBuddyAccountQuota,
  WorkBuddyAccountSummaryDto,
  WorkBuddyCheckinSettings,
  WorkBuddyModelOption,
  WorkBuddyReasoningEffort,
  WorkBuddyWebStatus,
} from '../../shared/workbuddy-contracts.ts'
import { WORKBUDDY_REASONING_EFFORTS } from '../../shared/workbuddy-contracts.ts'
import { accountPoolZh, type AccountPoolLabels } from '../common/account-pool-labels.ts'
import { contextDraftsFor } from '../common/ContextWindowEditor.tsx'
import { formatCapacity, parsePositiveCapacity } from '../common/format.ts'
import { createLineApi } from '../common/line-api.ts'
import { createQuotaFollowUp, type QuotaFollowUp } from '../common/quota-follow-up.ts'
import { zh } from './locales.ts'

const API = '/workbuddy/api'

/** The seats the settings hub hands the card; both optional, so a bare render works. */
export interface WorkBuddySectionProps {
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
 * Call one settings route through the shared reader.
 *
 * This line is where the shared reader's tolerance came from: reading the body
 * as text first is what lets a route that is not mounted (an empty body, which
 * is exactly what a stale host half produces) be reported as such instead of as
 * a bare "Unexpected end of JSON input".
 */
const api = createLineApi(API, 'WorkBuddy')

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

/**
 * Everything the card's view consumes, grouped by kind.
 *
 * Returned as one named shape instead of one status blob: a reader can see at a
 * glance what the hook tracks, what it computes from a status answer, and what
 * the view is allowed to ask it to do.
 */
export interface WorkBuddySectionView {
  /** Values that change as the card runs. */
  state: {
    /** Last status answer; null until the first read lands. */
    status: WorkBuddyWebStatus | null
    /** True until the first status read settles, whatever its outcome. */
    loading: boolean
    /** Id of the action in flight, or null; every disabled control reads it. */
    busy: string | null
    /** The failure the card's error strip shows. */
    error: string | null
    /** Result of the last explicit connection test. */
    connection: ConnectionPayload | null
    /** Line the host reports while a regional sign-in is being polled. */
    loginProgress: string | null
    /** One free-text capacity draft per model, keyed by model id. */
    contextDrafts: Record<string, string>
    /** Model id whose context-window save or restore is in flight. */
    savingModel: string | null
  }
  /** Facts read straight off the current status answer. */
  derived: {
    /** Every account row the shared pool card lists. */
    poolAccounts: WorkBuddyAccountSummaryDto[]
    /** Levels this account's models declare, each with the models behind it. */
    effortChoices: ReasoningEffortChoice[]
    /** Every catalog model, enabled or not; the effort labels count them. */
    allModels: WorkBuddyModelOption[]
    /**
     * A saved default no current model declares, when there is one.
     *
     * The adapter drops a level the chosen model does not accept, so reporting
     * this is what keeps an inert setting from looking applied.
     */
    strayEffort: WorkBuddyReasoningEffort | null
    /** Models the context-window editor offers: the enabled ones only. */
    contextModels: WorkBuddyModelOption[]
    /** How many stored overrides exist, whether or not a row still shows them. */
    overrideCount: number
    /** The displayed account's quota snapshot, when the host has one. */
    quota: WorkBuddyAccountQuota | null | undefined
    /** Whether a credential is signed in; every authenticated control reads it. */
    authenticated: boolean
    /**
     * A failed status read with no answer to fall back on.
     *
     * A failed read leaves `status` null, which must NOT be rendered as "no
     * credential found": that claims a credential problem when the real cause is
     * an unreachable route.
     */
    unreachable: boolean
    /**
     * The line's dictionary, handed to the shared pool card as one object.
     *
     * The hook already owns it for its own sentences, so the view takes the same
     * object from here rather than reaching for a second import.
     */
    poolLabels: AccountPoolLabels
  }
  /** Everything the view can trigger. */
  actions: {
    /** Start a regional sign-in; its flow is polled until it settles. */
    login(region: 'cn' | 'intl'): Promise<void>
    /** Re-read the credentials the host can find on this machine. */
    rescan(): Promise<void>
    /**
     * One account action, whether it is a pool action (`set-primary`, `hide`,
     * `restore`, `relogin`, `clear-cooldown`) or a credential action (`delete`).
     * The host route dispatches on `action`.
     */
    accountAction(action: string, accountId: string): Promise<void>
    /** Delete one plugin-owned credential, after the user confirms. */
    deleteAccount(accountId: string): Promise<void>
    setStrategy(strategy: AccountRotationStrategy): Promise<void>
    testConnection(): Promise<void>
    refreshQuota(): Promise<void>
    /** Run the daily check-in for every eligible account, now. */
    checkinNow(): Promise<void>
    /** Patch the check-in preference; omitted fields keep their stored value. */
    updateCheckin(checkin: Partial<WorkBuddyCheckinSettings>): Promise<void>
    toggleModel(modelId: string, enabled: boolean): Promise<void>
    setAllModels(enabled: boolean): Promise<void>
    updateEffort(effort: WorkBuddyReasoningEffort | null): Promise<void>
    refreshCatalog(): Promise<void>
    saveContextWindow(modelId: string): Promise<void>
    resetContextWindow(modelId: string): Promise<void>
    resetAllContextWindows(): Promise<void>
    /** Edit one capacity draft mid-typing; the editor never parses it. */
    updateContextDraft(modelId: string, draft: string): void
  }
}

export function useWorkBuddySection({ onModelChange, loadModelDirectory }: WorkBuddySectionProps): WorkBuddySectionView {
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
  /** Follow-up poll owed while the host refreshes the quota behind an answer. */
  const quotaFollowUp = useRef<QuotaFollowUp | null>(null)
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
      const data = await api.request<WorkBuddyWebStatus>('/status')
      // A response without the expected arrays must still render, so they are
      // normalized rather than trusted.
      const normalized = normalizeStatus(data)
      setStatus(normalized)
      setStatusFailed(false)
      setContextDrafts(contextDraftsFor(normalized))
      // An answer that refreshed the quota behind itself is followed up shortly,
      // so the fresh numbers land without waiting for the next poll.
      quotaFollowUp.current ??= createQuotaFollowUp()
      quotaFollowUp.current.observe(data.quotaRefreshing === true, () => { void loadStatus(true) })
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
      quotaFollowUp.current?.cancel()
      if (loginIntervalRef.current !== null) window.clearInterval(loginIntervalRef.current)
      if (loginTimeoutRef.current !== null) window.clearTimeout(loginTimeoutRef.current)
    }
  }, [loadStatus])

  const rescan = async () => {
    try {
      setBusy('rescan')
      setError(null)
      const updated = await api.request<WorkBuddyWebStatus>('/rescan', { method: 'POST' })
      setStatus(normalizeStatus(updated))
      notifyChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const login = async (region: 'cn' | 'intl') => {
    try {
      setBusy(`login:${region}`)
      setError(null)
      setLoginProgress(t.loginWaiting)
      const flow = await api.request<LoginPollStatus>('/accounts/login', {
        method: 'POST',
        body: JSON.stringify({ region }),
      })
      if (flow.authUrl) window.open(flow.authUrl, '_blank', 'noopener,noreferrer')
      if (loginIntervalRef.current !== null) window.clearInterval(loginIntervalRef.current)
      if (loginTimeoutRef.current !== null) window.clearTimeout(loginTimeoutRef.current)
      const timer = window.setInterval(() => {
        void (async () => {
          try {
            const poll = await api.request<LoginPollStatus>('/accounts/login/status')
            if (poll.progress) setLoginProgress(poll.progress)
            if (poll.status === 'complete') {
              window.clearInterval(timer)
              loginIntervalRef.current = null
              if (loginTimeoutRef.current !== null) window.clearTimeout(loginTimeoutRef.current)
              loginTimeoutRef.current = null
              setBusy(null)
              setLoginProgress(null)
              if (poll.accountId) {
                await api.request<WorkBuddyWebStatus>('/settings', {
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
  const accountAction = async (action: string, accountId: string) => {
    try {
      setBusy(`${action}:${accountId}`)
      setError(null)
      const updated = await api.request<WorkBuddyWebStatus>('/accounts/action', {
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

  const deleteAccount = async (accountId: string) => {
    if (!window.confirm(t.deleteConfirm)) return
    await accountAction('delete', accountId)
  }

  const setStrategy = async (strategy: AccountRotationStrategy) => {
    try {
      setBusy('strategy')
      setError(null)
      const updated = await api.request<WorkBuddyWebStatus>('/accounts/strategy', {
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

  const testConnection = async () => {
    try {
      setBusy('connection')
      setError(null)
      setConnection(await api.request<ConnectionPayload>('/connection/test', { method: 'POST' }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const refreshQuota = async () => {
    try {
      setBusy('quota')
      setError(null)
      const updated = await api.request<WorkBuddyWebStatus>('/quota', { method: 'POST' })
      setStatus(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const checkinNow = async () => {
    try {
      setBusy('checkin')
      setError(null)
      const updated = await api.request<WorkBuddyWebStatus>('/checkin/now', { method: 'POST' })
      setStatus(normalizeStatus(updated))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const updateCheckin = async (checkin: Partial<WorkBuddyCheckinSettings>) => {
    try {
      setBusy('checkin')
      setError(null)
      const updated = await api.request<WorkBuddyWebStatus>('/settings', {
        method: 'POST',
        body: JSON.stringify({ checkin }),
      })
      setStatus(normalizeStatus(updated))
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
      const updated = await api.request<WorkBuddyWebStatus>('/settings', {
        method: 'POST',
        body: JSON.stringify({ enabledModelIds: next }),
      })
      const normalized = normalizeStatus(updated)
      setStatus(normalized)
      // A model that was just checked has no draft yet; the context window
      // section only renders enabled models.
      setContextDrafts(contextDraftsFor(normalized))
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
      const updated = await api.request<WorkBuddyWebStatus>('/settings', {
        method: 'POST',
        body: JSON.stringify({ enabledModelIds: enabled ? status.models.map((model) => model.id) : [] }),
      })
      const normalized = normalizeStatus(updated)
      setStatus(normalized)
      setContextDrafts(contextDraftsFor(normalized))
      notifyChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const updateEffort = async (effort: WorkBuddyReasoningEffort | null) => {
    try {
      setBusy('effort')
      setError(null)
      const updated = await api.request<WorkBuddyWebStatus>('/settings', {
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

  const refreshCatalog = async () => {
    try {
      setBusy('catalog')
      setError(null)
      const updated = await api.request<WorkBuddyWebStatus>('/catalog/refresh', { method: 'POST' })
      const normalized = normalizeStatus(updated)
      setStatus(normalized)
      setContextDrafts(contextDraftsFor(normalized))
      notifyChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const saveContextWindow = async (modelId: string) => {
    const raw = contextDrafts[modelId] || ''
    const parsed = parsePositiveCapacity(raw)
    if (parsed === null) {
      setError(`Invalid context capacity: ${raw}`)
      return
    }
    try {
      setSavingModel(modelId)
      setError(null)
      const updated = await api.request<WorkBuddyWebStatus>('/settings', {
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
  const resetContextWindow = async (modelId: string) => {
    try {
      setSavingModel(modelId)
      setError(null)
      const updated = normalizeStatus(await api.request<WorkBuddyWebStatus>('/settings', {
        method: 'POST',
        body: JSON.stringify({ contextWindowOverrides: { [modelId]: null } }),
      }))
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
  const resetAllContextWindows = async () => {
    const models = Object.keys(status?.contextWindowOverrides ?? {})
    if (models.length === 0) return
    if (!window.confirm(t.contextWindowResetAllConfirm)) return
    try {
      setBusy('context')
      setError(null)
      const updated = normalizeStatus(await api.request<WorkBuddyWebStatus>('/settings', {
        method: 'POST',
        body: JSON.stringify({ contextWindowOverrides: Object.fromEntries(models.map((model) => [model, null])) }),
      }))
      setStatus(updated)
      setContextDrafts(contextDraftsFor(updated))
      notifyChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const updateContextDraft = (modelId: string, draft: string): void => {
    setContextDrafts((prev) => ({ ...prev, [modelId]: draft }))
  }

  // Only checked models get a context row; the batch restore still covers every
  // stored override, including one left behind by a model the user unchecked.
  const contextModels = status?.models.filter((model) => model.enabled) ?? []
  const overrideCount = Object.keys(status?.contextWindowOverrides ?? {}).length
  const quota = status?.quota
  const authenticated = status?.authenticated === true
  // A failed status read is not "no credential": showing the credential hint
  // here would send the user chasing a problem that does not exist.
  const unreachable = statusFailed && status === null

  return {
    state: {
      status,
      loading,
      busy,
      error,
      connection,
      loginProgress,
      contextDrafts,
      savingModel,
    },
    derived: {
      poolAccounts,
      effortChoices,
      allModels,
      strayEffort,
      contextModels,
      overrideCount,
      quota,
      authenticated,
      unreachable,
      poolLabels: accountPoolLabels(t),
    },
    actions: {
      login,
      rescan,
      accountAction,
      deleteAccount,
      setStrategy,
      testConnection,
      refreshQuota,
      checkinNow,
      updateCheckin,
      toggleModel,
      setAllModels,
      updateEffort,
      refreshCatalog,
      saveContextWindow,
      resetContextWindow,
      resetAllContextWindows,
      updateContextDraft,
    },
  }
}
