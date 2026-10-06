/**
 * The Claude card's state, effects and actions.
 *
 * Split out of 'ClaudeSection.tsx' so that file is markup and this one is
 * behaviour: what the card tracks, what it derives from a status answer, and
 * every request a control can make. The view reads one named shape — see
 * `ClaudeSectionView` — so the contract between the two is visible here rather
 * than inferred from a thousand lines of JSX.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AccountRotationStrategy } from '../../shared/account-pool-contracts.ts'
import type {
  ClaudeAccountQuota,
  ClaudeAccountSummaryDto,
  ClaudeCacheTtl,
  ClaudeConnectionDto,
  ClaudeLoginFlowDto,
  ClaudeModelOption,
  ClaudeQuotaWindow,
  ClaudeReasoningEffort,
  ClaudeWebStatus,
} from '../../shared/claude-contracts.ts'
import { contextDraftsFor } from '../common/ContextWindowEditor.tsx'
import { formatCapacity, parsePositiveCapacity } from '../common/format.ts'
import { createLineApi } from '../common/line-api.ts'
import { createQuotaFollowUp, type QuotaFollowUp } from '../common/quota-follow-up.ts'
import { zh } from './locales.ts'

const API = '/claude/api'
const api = createLineApi(API, 'Claude')

/**
 * The poll cadence of a pending sign-in.
 *
 * There is NO SSE channel in this plugin — every sibling line polls
 * 'login/status' on a timer while the user is in the browser, and this one does
 * the same so a stalled flow is visible rather than silent.
 */
const LOGIN_POLL_MS = 2000

/** The seats the settings hub hands the card; both optional, so a bare render works. */
export interface ClaudeSectionProps {
  onModelChange?: () => void
  loadModelDirectory?: () => void
}

/**
 * Everything the card's view consumes, grouped by kind.
 *
 * Returned as one named shape instead of one status blob: a reader can see at a
 * glance what the hook tracks, what it computes from a status answer, and what
 * the view is allowed to ask it to do.
 */
export interface ClaudeSectionView {
  /** Values that change as the card runs. */
  state: {
    /** Last status answer; null until the first read lands. */
    status: ClaudeWebStatus | null
    /** True until the first status read settles, whatever its outcome. */
    loading: boolean
    /** Id of the action in flight, or null; every disabled control reads it. */
    busy: string | null
    /** The failure the card's error strip shows. */
    error: string | null
    /** The sign-in flow being polled, when one is running. */
    flow: ClaudeLoginFlowDto | null
    /** Result of the last explicit connection test. */
    connection: ClaudeConnectionDto | null
    /** What the user has typed into the manual-paste box. */
    pasteValue: string
    /** One free-text capacity draft per model, keyed by model id. */
    contextDrafts: Record<string, string>
    /** Model id whose context-window save or restore is in flight. */
    savingModel: string | null
  }
  /** Facts read straight off the current status answer. */
  derived: {
    /** Every account row the shared pool card lists. */
    accounts: ClaudeAccountSummaryDto[]
    /** Whether any row is a snapshot of a sign-in this plugin does not own. */
    hasAdopted: boolean
    /** Models the context-window editor offers: the enabled ones only. */
    contextModels: ClaudeModelOption[]
    /** How many stored overrides exist, whether or not a row still shows them. */
    overrideCount: number
    /** The displayed account's quota snapshot, when the host has one. */
    quota: ClaudeAccountQuota | null | undefined
    /** Windows of that snapshot, shortest first. */
    windows: ClaudeQuotaWindow[]
    /**
     * The line's dictionary, handed to the shared pool card as one object.
     *
     * The hook already owns it for its own sentences, so the view takes the same
     * object from here rather than reaching for a second import.
     */
    poolLabels: typeof zh
  }
  /** Everything the view can trigger. */
  actions: {
    /** Start a sign-in; opens the authorize page when the flow carries one. */
    login(): Promise<void>
    cancelLogin(): Promise<void>
    /** Finish a manual-mode sign-in with the pasted code. */
    submitPaste(): Promise<void>
    /** Add the local Claude Code sign-in as a snapshot. */
    adopt(): Promise<void>
    /** Forget every imported snapshot, or one of them. */
    stopImporting(accountId?: string): Promise<void>
    /** One account-level action on the shared pool card. */
    accountAction(
      action: 'set-primary' | 'delete' | 'clear-cooldown',
      accountId: string,
    ): Promise<void>
    setStrategy(strategy: AccountRotationStrategy): Promise<void>
    /** Re-authorize ONE account; the returned flow starts the polling above. */
    relogin(accountId: string): void
    refreshQuota(): Promise<void>
    refreshCatalog(): Promise<void>
    testConnection(): Promise<void>
    toggleModel(modelId: string, checked: boolean): void
    setAllModels(selectAll: boolean): void
    updateEffort(effort: ClaudeReasoningEffort | null): Promise<void>
    updateCacheTtl(ttl: ClaudeCacheTtl | null): Promise<void>
    saveContextWindow(modelId: string): Promise<void>
    resetContextWindow(modelId: string): Promise<void>
    resetAllContextWindows(): Promise<void>
    /** Edit one capacity draft mid-typing; the editor never parses it. */
    updateContextDraft(modelId: string, draft: string): void
    /** Edit the manual-paste box. */
    setPasteValue(value: string): void
  }
}

export function useClaudeSection({ onModelChange, loadModelDirectory }: ClaudeSectionProps): ClaudeSectionView {
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
      const data = await api.request<ClaudeWebStatus>('/status')
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
    // 'exchanging' too: the host reports it while the code is redeemed, and a
    // poll that lands in that window used to stop polling for good - the card
    // then sat on "exchanging" while the host had long finished signing in.
    if (flow?.status !== 'pending' && flow?.status !== 'exchanging') return
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const poll = await api.request<ClaudeLoginFlowDto>('/login/status')
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

  const login = async () => {
    try {
      setBusy('login')
      setError(null)
      setPasteValue('')
      const next = await api.request<ClaudeLoginFlowDto>('/login', {
        method: 'POST',
        body: JSON.stringify({}),
      })
      setFlow(next)
      // The card is the ONLY place the page is opened; the host no longer opens
      // it too (that showed two identical login pages). The desktop shell hands
      // window.open to the system browser, and a blocked popup changes nothing:
      // the card renders the link below.
      if (next.authUrl) window.open(next.authUrl, '_blank', 'noopener,noreferrer')
    } catch (err) {
      reportError(err)
    } finally {
      setBusy(null)
    }
  }

  const cancelLogin = async () => {
    try {
      const next = await api.request<ClaudeLoginFlowDto>('/login/cancel', { method: 'POST' })
      setFlow(next)
    } catch (err) {
      reportError(err)
    }
  }

  /** Finish a manual-mode sign-in with the code the user pasted. */
  const submitPaste = async () => {
    if (pasteValue.trim() === '') return
    try {
      setBusy('login-input')
      setError(null)
      // The route answers with the refreshed STATUS, not with the flow: a
      // successful exchange stores the credential, so the account card, the
      // models and the quota are all stale by the time it returns.
      const updated = await api.request<ClaudeWebStatus>('/login/input', {
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
  const adopt = async () => {
    try {
      setBusy('adopt')
      setError(null)
      const updated = await api.request<ClaudeWebStatus>('/adopt', { method: 'POST' })
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
  const stopImporting = async (accountId?: string) => {
    try {
      setBusy(accountId === undefined ? 'adopt-disable' : `adopt-disable-${accountId}`)
      setError(null)
      const updated = await api.request<ClaudeWebStatus>('/adopt/disable', {
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
  const accountAction = async (
    action: 'set-primary' | 'delete' | 'clear-cooldown',
    accountId: string,
  ) => {
    try {
      setBusy(`${action}-${accountId}`)
      setError(null)
      const updated = await api.request<ClaudeWebStatus>('/accounts', {
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

  const setStrategy = async (strategy: AccountRotationStrategy) => {
    try {
      setBusy('strategy')
      setError(null)
      const updated = await api.request<ClaudeWebStatus>('/accounts', {
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
  const relogin = (accountId: string): void => {
    void (async () => {
      try {
        setBusy(`relogin-${accountId}`)
        setError(null)
        setPasteValue('')
        const next = await api.request<ClaudeLoginFlowDto>('/login', {
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

  const refreshQuota = async () => {
    try {
      setBusy('quota')
      setError(null)
      // A quota FAILURE is not a failed request: it arrives as `quotaError` on a
      // 200, so the card keeps rendering the account beside the reason.
      const updated = await api.request<ClaudeWebStatus>('/quota', { method: 'POST' })
      setStatus(updated)
    } catch (err) {
      reportError(err)
      // Re-read so the card still shows the account and any recorded reason.
      await loadStatus(true)
    } finally {
      setBusy(null)
    }
  }

  const refreshCatalog = async () => {
    try {
      setBusy('catalog')
      setError(null)
      const updated = await api.request<ClaudeWebStatus>('/catalog/refresh', { method: 'POST' })
      setStatus(updated)
      setContextDrafts(contextDraftsFor(updated))
      notifyChange()
    } catch (err) {
      reportError(err)
    } finally {
      setBusy(null)
    }
  }

  const testConnection = async () => {
    try {
      setBusy('connection')
      setError(null)
      setConnection(null)
      // A refusal is a VALUE here: the route answers 200 with `connected: false`
      // and a reason, because explaining the refusal is the whole job.
      const result = await api.request<ClaudeConnectionDto>('/connection/test', { method: 'POST' })
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
      const updated = await api.request<ClaudeWebStatus>('/models', {
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

  const updateEffort = async (effort: ClaudeReasoningEffort | null) => {
    try {
      const updated = await api.request<ClaudeWebStatus>('/settings', {
        method: 'POST',
        body: JSON.stringify({ defaultReasoningEffort: effort }),
      })
      setStatus(updated)
      notifyChange()
    } catch (err) {
      reportError(err)
    }
  }

  const updateCacheTtl = async (ttl: ClaudeCacheTtl | null) => {
    try {
      const updated = await api.request<ClaudeWebStatus>('/settings', {
        method: 'POST',
        body: JSON.stringify({ cacheTtl: ttl }),
      })
      setStatus(updated)
      notifyChange()
    } catch (err) {
      reportError(err)
    }
  }

  const saveContextWindow = async (modelId: string) => {
    const raw = contextDrafts[modelId] || ''
    const parsed = parsePositiveCapacity(raw)
    if (parsed === null) {
      setError(t.contextWindowInvalid.replace('{value}', raw))
      return
    }
    try {
      setSavingModel(modelId)
      setError(null)
      const updated = await api.request<ClaudeWebStatus>('/settings', {
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
  const resetContextWindow = async (modelId: string) => {
    try {
      setSavingModel(modelId)
      setError(null)
      const updated = await api.request<ClaudeWebStatus>('/settings', {
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
  const resetAllContextWindows = async () => {
    const models = Object.keys(status?.contextWindowOverrides ?? {})
    if (models.length === 0) return
    if (typeof window !== 'undefined' && !window.confirm(t.contextWindowResetAllConfirm)) return
    try {
      setBusy('context')
      setError(null)
      const updated = await api.request<ClaudeWebStatus>('/settings', {
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

  const updateContextDraft = (modelId: string, draft: string): void => {
    setContextDrafts((prev) => ({ ...prev, [modelId]: draft }))
  }

  const accounts = (status?.accounts ?? []) as ClaudeAccountSummaryDto[]
  const hasAdopted = accounts.some((account) => account.adopted === true || account.removable === false)
  const contextModels = status?.models.filter((model) => model.enabled) ?? []
  const overrideCount = Object.keys(status?.contextWindowOverrides ?? {}).length
  const quota = status?.quota
  const windows: ClaudeQuotaWindow[] = quota?.windows ?? []

  return {
    state: {
      status,
      loading,
      busy,
      error,
      flow,
      connection,
      pasteValue,
      contextDrafts,
      savingModel,
    },
    derived: {
      accounts,
      hasAdopted,
      contextModels,
      overrideCount,
      quota,
      windows,
      poolLabels: t,
    },
    actions: {
      login,
      cancelLogin,
      submitPaste,
      adopt,
      stopImporting,
      accountAction,
      setStrategy,
      relogin,
      refreshQuota,
      refreshCatalog,
      testConnection,
      toggleModel,
      setAllModels,
      updateEffort,
      updateCacheTtl,
      saveContextWindow,
      resetContextWindow,
      resetAllContextWindows,
      updateContextDraft,
      setPasteValue,
    },
  }
}
