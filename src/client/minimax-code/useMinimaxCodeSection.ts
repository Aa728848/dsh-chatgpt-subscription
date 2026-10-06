/**
 * The MiniMax Code card's state, effects and actions.
 *
 * Split out of 'MinimaxCodeSection.tsx' so that file is markup and this one is
 * behaviour: what the card tracks, what it derives from a status answer, and
 * every request a control can make. The view reads one named shape — see
 * `MinimaxCodeSectionView` — so the contract between the two is visible here
 * rather than inferred from the JSX.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AccountPoolStatusDto,
  AccountRotationStrategy,
} from '../../shared/account-pool-contracts.ts'
import type {
  MinimaxCodeAccount,
  MinimaxCodeModelOption,
  MinimaxCodeQuota,
  MinimaxCodeReasoningEffort,
  MinimaxCodeWebLogin,
  MinimaxCodeWebStatus,
} from '../../shared/minimax-code-contracts.ts'
import type { AccountPoolLabels } from '../common/AccountPoolSection.tsx'
import { contextDraftsFor } from '../common/ContextWindowEditor.tsx'
import { formatCapacity, parsePositiveCapacity } from '../common/format.ts'
import { createQuotaFollowUp, type QuotaFollowUp } from '../common/quota-follow-up.ts'
import { get, messageOf, post } from './api.ts'
import { zh } from './locales.ts'

/** The pool slice the status card renders, absent when the line has no pool. */
export type MinimaxCodePoolStatus = Pick<AccountPoolStatusDto, 'accounts' | 'rotationStrategy'> & {
  activeAccountId?: string
}

/**
 * The keys this card renders.
 *
 * The provider hub hosts every provider tab inside one settings section whose
 * injected `t` seat is bound to the hub's own namespace, and every sibling tab
 * therefore renders its own dictionary instead of that seat (see KimiCodeSection,
 * WorkBuddySection and CommandCodeSection, none of which declare a locale prop).
 * This card must do the same: its keys are not a subset of the hub's, so using the
 * hub's seat resolves the overlap to ChatGPT wording ("使用 ChatGPT 登录" on the
 * MiniMax tab) and every other key to the literal key text.
 */
export type Translate = (key: keyof typeof zh) => string

/** The card's own dictionary; stable identity keeps effect dependencies intact. */
export const fallbackTranslate: Translate = (key) => zh[key]

/**
 * The shared pool card's labels, resolved through this card's dictionary.
 *
 * The sibling tabs hand the shared card their raw `zh` object, which works because
 * they render `zh` directly. This card renders through a translate function
 * instead, so the same label set is assembled here by looking each key up. It is
 * derived from the shared ZH label object's own keys, so a label added to the
 * shared card cannot be silently missed — the `satisfies` below turns that into a
 * compile error.
 */
function accountPoolLabelsFor(t: Translate): AccountPoolLabels {
  return {
    accountPool: t('accountPool'),
    addAccount: t('addAccount'),
    accountCount: t('accountCount'),
    primaryAccount: t('primaryAccount'),
    activeAccount: t('activeAccount'),
    setPrimary: t('setPrimary'),
    deleteAccount: t('deleteAccount'),
    cooling: t('cooling'),
    cooldownLeft: t('cooldownLeft'),
    clearCooldown: t('clearCooldown'),
    needsRelogin: t('needsRelogin'),
    relogin: t('relogin'),
    rotationStrategy: t('rotationStrategy'),
    strategySequential: t('strategySequential'),
    strategyRoundRobin: t('strategyRoundRobin'),
    strategySticky: t('strategySticky'),
    noAccounts: t('noAccounts'),
    email: t('email'),
    expires: t('expiresAt'),
    lastUsed: t('lastUsed'),
    accountId: t('accountId'),
    accountQuota: t('accountQuota'),
    quotaNone: t('quotaNone'),
    quotaSnapshot: t('quotaSnapshot'),
    quotaResets: t('quotaResets'),
    quotaExhausted: t('quotaExhausted'),
    quotaWindow: t('quotaWindow'),
    quotaUsed: t('quotaUsed'),
    quotaFactsScope: t('quotaFactsScope'),
    composerLabel: t('composerLabel'),
  }
}

/** Device-code poll cadence. The host owns the real expiry. */
const LOGIN_POLL_INTERVAL_MS = 2_000

/** `/login/poll` answer, exactly as the frozen route table defines it. */
interface LoginPollResult {
  status: 'pending' | 'authenticated' | 'expired' | 'denied'
  account?: MinimaxCodeAccount
}

/** `/login/start` answer: `{ ok: true, login }` per the frozen route table. */
interface LoginStartResult {
  ok?: boolean
  login?: MinimaxCodeWebLogin
}

/** `/test` answer: `{ ok, model?, error? }` per the frozen route table. */
interface ConnectionTestResult {
  ok?: boolean
  model?: string
  error?: string
}

/**
 * Props this card accepts.
 *
 * Deliberately the same shape every sibling tab declares: the hub hands each tab
 * only the refresh callback. The card does not take the hub's `settings.section`
 * runtime seat or its locale seat, because it renders its own dictionary (see
 * below) and needs none of that scope's other props.
 */
export interface MinimaxCodeSectionProps {
  onModelChange?: () => void
}

/**
 * Everything the card's view consumes, grouped by kind.
 *
 * Returned as one named shape instead of one status blob: a reader can see at a
 * glance what the hook tracks, what it computes from a status answer, and what
 * the view is allowed to ask it to do.
 */
export interface MinimaxCodeSectionView {
  /** Values that change as the card runs. */
  state: {
    /** Last status answer; null until the first read lands. */
    status: MinimaxCodeWebStatus | null
    /** True until the first status read settles, whatever its outcome. */
    loading: boolean
    /** Id of the action in flight, or null; every disabled control reads it. */
    busy: string | null
    /** The failure the card's error strip shows. */
    error: string | null
    /** The device-code flow being polled, when one is running. */
    flow: MinimaxCodeWebLogin | null
    /** Whether the user code was just copied, so the button can say so. */
    copied: boolean
    /** Result of the last explicit connection test, as one sentence. */
    connectionNotice: string | null
    /** One free-text capacity draft per model, keyed by model id. */
    contextDrafts: Record<string, string>
    /** Model id whose context-window save or restore is in flight. */
    savingModel: string | null
    /** The pool slice read beside the status; undefined when the line has no pool. */
    pool: MinimaxCodePoolStatus | undefined
  }
  /** Facts read straight off the current status answer. */
  derived: {
    /** Whether the line holds a usable credential. */
    authenticated: boolean
    /** The signed-in account, when the host reports one. */
    account: MinimaxCodeAccount | undefined
    /** The displayed account's usage snapshot, when the host has one. */
    quota: MinimaxCodeQuota | undefined
    /** Every catalog row, in catalog order. */
    models: MinimaxCodeModelOption[]
    /** Models the context-window editor offers: the enabled ones only. */
    contextModels: MinimaxCodeModelOption[]
    /** How many stored overrides exist, whether or not a row still shows them. */
    overrideCount: number
    /**
     * The line's label set, handed to the shared pool card as one object.
     *
     * The hook resolves it for its own sentences too, so the view takes the
     * assembled labels from here rather than reaching for a second binding.
     */
    poolLabels: AccountPoolLabels
  }
  /** Everything the view can trigger. */
  actions: {
    /** Start a device-code sign-in. */
    login(): Promise<void>
    cancelLogin(): Promise<void>
    /** Copy the flow's user code; the button says so for two seconds. */
    copyCode(): Promise<void>
    logout(): Promise<void>
    /** One account-level action on the shared pool card. */
    poolAction(
      action: 'set-primary' | 'delete' | 'clear-cooldown' | 'relogin',
      accountId: string,
    ): Promise<void>
    setStrategy(strategy: AccountRotationStrategy): Promise<void>
    toggleModel(modelId: string, checked: boolean): void
    setAllModels(selectAll: boolean): void
    /** Flip the check-in scheduler's own switch. */
    setCheckinEnabled(enabled: boolean): Promise<void>
    /** Run one check-in pass now. */
    runCheckinNow(): Promise<void>
    updateEffort(effort: MinimaxCodeReasoningEffort | null): Promise<void>
    saveContextWindow(modelId: string): Promise<void>
    resetContextWindow(modelId: string): Promise<void>
    resetAllContextWindows(): Promise<void>
    refreshQuota(): Promise<void>
    testConnection(): Promise<void>
    /** Edit one capacity draft mid-typing; the editor never parses it. */
    updateContextDraft(modelId: string, draft: string): void
  }
}

export function useMinimaxCodeSection({ onModelChange }: MinimaxCodeSectionProps): MinimaxCodeSectionView {
  const t: Translate = fallbackTranslate
  const [status, setStatus] = useState<MinimaxCodeWebStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [flow, setFlow] = useState<MinimaxCodeWebLogin | null>(null)
  const [copied, setCopied] = useState(false)
  // Result of an explicit connection test. The button used to end silently on
  // success, which is indistinguishable from a click that never registered.
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null)
  // Free-text context-window drafts, keyed by model id, so a half-typed value
  // does not round-trip to the host on every keystroke.
  const [contextDrafts, setContextDrafts] = useState<Record<string, string>>({})
  const [savingModel, setSavingModel] = useState<string | null>(null)
  // The pool slice, read beside the status. Absent until the first read answers,
  // and absent for a host that has no pool installed at all.
  const [pool, setPool] = useState<MinimaxCodePoolStatus | undefined>(undefined)

  // The follow-up poll for a usage read the host is running behind its answer.
  // Every sibling card has this and this one did not, which is why a page
  // opened right after a restart sat on "no usage data" until the 60 s tick:
  // the host was already fetching, the answer simply could not say so.
  const quotaFollowUp = useRef<QuotaFollowUp | undefined>(undefined)

  const loadStatus = useCallback(async (quiet = false) => {
    if (!quiet) setError(null)
    try {
      const next = await get<MinimaxCodeWebStatus>('/status')
      setStatus(next)
      setContextDrafts(contextDraftsFor(next))
      quotaFollowUp.current ??= createQuotaFollowUp()
      quotaFollowUp.current.observe(next.quotaRefreshing === true, () => { void loadStatus(true) })
    } catch (cause) {
      if (!quiet) setError(messageOf(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadStatus()
    void loadPool()
    const refreshWhenVisible = (): void => {
      if (document.visibilityState === 'visible') {
        void loadStatus(true)
        void loadPool()
      }
    }
    document.addEventListener('visibilitychange', refreshWhenVisible)
    const timer = window.setInterval(refreshWhenVisible, 60_000)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      quotaFollowUp.current?.cancel()
    }
  }, [loadStatus])

  const loginId = flow?.loginId

  // Authorization happens in a browser this card does not control, so the host
  // owns the device-code exchange and the card polls the host for its verdict.
  useEffect(() => {
    if (loginId === undefined) return
    let stopped = false
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const poll = await post<LoginPollResult>('/login/poll', { loginId })
          if (stopped || poll.status === 'pending') return
          stopped = true
          window.clearInterval(timer)
          setFlow(null)
          if (poll.status === 'authenticated') {
            await loadStatus()
            onModelChange?.()
            return
          }
          setError(poll.status === 'expired' ? t('loginExpired') : t('loginDenied'))
        } catch {
          // A failed poll is transient; the next tick retries.
        }
      })()
    }, LOGIN_POLL_INTERVAL_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [loginId, loadStatus, onModelChange, t])

  /**
   * Fetch the usage snapshot once, the first time the card sees a signed-in
   * account without one.
   *
   * The status route refreshes usage BEHIND its answer, so it never blocks on a
   * network read; that means the very first paint has no snapshot. Asking here
   * fills the section immediately instead of leaving it empty for a whole poll
   * interval. A failure is silent on purpose: the section already explains that no
   * usage is available, and a usage read must never surface as an error banner.
   */
  // Declared here rather than beside the render values because the effect below
  // needs it and hooks must all run before the loading early-return.
  const authenticated = status?.authenticated === true
  const quotaRequested = useRef(false)
  useEffect(() => {
    if (quotaRequested.current || !authenticated || status?.quota !== undefined) return
    quotaRequested.current = true
    void (async () => {
      try {
        setStatus(await post<MinimaxCodeWebStatus>('/quota'))
      } catch {
        // Silent by design - see above.
      }
    })()
  }, [authenticated, status?.quota])

  const login = async (): Promise<void> => {
    try {
      setBusy('login')
      setError(null)
      setConnectionNotice(null)
      setCopied(false)
      const started = await post<LoginStartResult>('/login/start')
      // `login` is the frozen shape; a host that answers with the login object
      // itself is still read, because the card loses nothing by accepting it.
      const next = started.login ?? (typeof (started as { loginId?: unknown }).loginId === 'string'
        ? started as unknown as MinimaxCodeWebLogin
        : undefined)
      if (next === undefined) {
        setError(t('loginFailed'))
        return
      }
      setFlow(next)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const cancelLogin = async (): Promise<void> => {
    const pending = flow
    setFlow(null)
    if (pending === null) return
    try {
      await post('/login/cancel', { loginId: pending.loginId })
    } catch (cause) {
      setError(messageOf(cause))
    }
  }

  const copyCode = async (): Promise<void> => {
    const code = flow?.userCode
    if (code === undefined || code === '') return
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2_000)
    } catch {
      // Clipboard access can be denied; the code stays on screen to copy by hand.
    }
  }

  const logout = async (): Promise<void> => {
    try {
      setBusy('logout')
      setError(null)
      setConnectionNotice(null)
      setFlow(null)
      // The host refuses to sign out a credential the desktop app owns; that
      // refusal is a successful, expected answer rather than an error, so it is
      // surfaced as a notice and the status is re-read either way.
      const result = await post<{ ok?: boolean; native?: boolean; error?: string }>('/logout')
      if (result.native === true) {
        setConnectionNotice(result.error ?? t('logoutOwnedByApp'))
      }
      await loadStatus(true)
      onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
      await loadStatus(true)
    } finally {
      setBusy(null)
    }
  }

  /**
   * Apply one model-selection patch through `/models`.
   *
   * The host owns the selection and answers with the whole fresh status, so the
   * card never guesses which ids ended up enabled.
   */
  /** Re-read the pool slice, which lives beside the status on its own route. */
  const loadPool = useCallback(async (): Promise<void> => {
    try {
      const next = await get<MinimaxCodePoolStatus>('/accounts')
      setPool(next)
    } catch {
      // A host without a pool answers with an error here; the section simply does
      // not render rather than reporting a failure the user cannot act on.
      setPool(undefined)
    }
  }, [])

  /** Run one account action, then re-read both the pool and the status. */
  const poolAction = async (
    action: 'set-primary' | 'delete' | 'clear-cooldown' | 'relogin',
    accountId: string,
  ): Promise<void> => {
    try {
      setBusy(action)
      setError(null)
      await post('/accounts', { action, accountId })
      await loadPool()
      await loadStatus(true)
      onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const setStrategy = async (strategy: AccountRotationStrategy): Promise<void> => {
    try {
      setBusy('strategy')
      setError(null)
      await post('/accounts', { action: 'strategy', strategy })
      await loadPool()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const applyEnabled = async (enabledModelIds: string[]): Promise<void> => {
    try {
      setError(null)
      const updated = await post<MinimaxCodeWebStatus>('/models', { enabledModelIds })
      setStatus(updated)
      // A model that was just checked has no draft yet; the context-window
      // section only renders enabled models.
      setContextDrafts(contextDraftsFor(updated))
      onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
    }
  }

  /** Flip the check-in scheduler's own switch, through the same settings route. */
  const setCheckinEnabled = async (enabled: boolean): Promise<void> => {
    try {
      setBusy('checkin')
      setError(null)
      const updated = await post<MinimaxCodeWebStatus>('/settings', { checkin: { enabled } })
      setStatus(updated)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  /** Run one check-in pass now: the toggle and the retry cap are bypassed. */
  const runCheckinNow = async (): Promise<void> => {
    try {
      setBusy('checkin')
      setError(null)
      const updated = await post<MinimaxCodeWebStatus>('/checkin/now')
      setStatus(updated)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const toggleModel = (modelId: string, checked: boolean): void => {
    if (status === null) return
    const current = status.models.filter((model) => model.enabled).map((model) => model.id)
    const next = checked ? [...new Set([...current, modelId])] : current.filter((id) => id !== modelId)
    void applyEnabled(next)
  }

  const setAllModels = (selectAll: boolean): void => {
    if (status === null || status.models.length === 0) return
    void applyEnabled(selectAll ? status.models.map((model) => model.id) : [])
  }

  const updateEffort = async (effort: MinimaxCodeReasoningEffort | null): Promise<void> => {
    try {
      setError(null)
      const updated = await post<MinimaxCodeWebStatus>('/settings', { defaultReasoningEffort: effort })
      setStatus(updated)
      onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
    }
  }

  const saveContextWindow = async (modelId: string): Promise<void> => {
    const raw = contextDrafts[modelId] ?? ''
    const parsed = parsePositiveCapacity(raw)
    if (parsed === null) {
      setError(t('invalidCapacity').replace('{value}', raw))
      return
    }
    try {
      setSavingModel(modelId)
      setError(null)
      const updated = await post<MinimaxCodeWebStatus>('/settings', { contextWindowOverrides: { [modelId]: parsed } })
      setStatus(updated)
      setContextDrafts((prev) => ({ ...prev, [modelId]: formatCapacity(parsed) }))
      onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setSavingModel(null)
    }
  }

  const resetContextWindow = async (modelId: string): Promise<void> => {
    try {
      setSavingModel(modelId)
      setError(null)
      // `null` is the wire spelling of "drop this override": the host deletes the
      // key so the catalog default applies again.
      const updated = await post<MinimaxCodeWebStatus>('/settings', { contextWindowOverrides: { [modelId]: null } })
      setStatus(updated)
      const model = updated.models.find((entry) => entry.id === modelId)
      if (model !== undefined) {
        setContextDrafts((prev) => ({ ...prev, [modelId]: formatCapacity(model.defaultContextWindow) }))
      }
      onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setSavingModel(null)
    }
  }

  const resetAllContextWindows = async (): Promise<void> => {
    const ids = Object.keys(status?.contextWindowOverrides ?? {})
    if (ids.length === 0) return
    try {
      setError(null)
      const updated = await post<MinimaxCodeWebStatus>('/settings', {
        contextWindowOverrides: Object.fromEntries(ids.map((id) => [id, null])),
      })
      setStatus(updated)
      setContextDrafts(contextDraftsFor(updated))
      onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
    }
  }

  /** Force one usage read through `/quota` and render the fresh status. */
  const refreshQuota = async (): Promise<void> => {
    try {
      setBusy('quota')
      setError(null)
      setStatus(await post<MinimaxCodeWebStatus>('/quota'))
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const testConnection = async (): Promise<void> => {
    try {
      setBusy('test')
      setError(null)
      setConnectionNotice(null)
      const result = await post<ConnectionTestResult>('/test')
      if (result.ok === true) {
        setConnectionNotice(result.model === undefined || result.model === ''
          ? t('testSuccess')
          : t('testSuccessModel').replace('{model}', result.model))
        return
      }
      setConnectionNotice(result.error === undefined || result.error === ''
        ? t('testFailed')
        : `${t('testFailed')}：${result.error}`)
    } catch (cause) {
      setConnectionNotice(`${t('testFailed')}：${messageOf(cause)}`)
    } finally {
      setBusy(null)
    }
  }

  const updateContextDraft = (modelId: string, draft: string): void => {
    setContextDrafts((prev) => ({ ...prev, [modelId]: draft }))
  }

  const account = status?.account
  const quota = status?.quota
  const models = status?.models ?? []
  // Only enabled models have a context window to override: an unchecked model is
  // not offered to a conversation, so a capacity for it would be dead settings.
  const contextModels = status?.models.filter((model) => model.enabled) ?? []
  const overrideCount = Object.keys(status?.contextWindowOverrides ?? {}).length

  return {
    state: {
      status,
      loading,
      busy,
      error,
      flow,
      copied,
      connectionNotice,
      contextDrafts,
      savingModel,
      pool,
    },
    derived: {
      authenticated,
      account,
      quota,
      models,
      contextModels,
      overrideCount,
      poolLabels: accountPoolLabelsFor(t),
    },
    actions: {
      login,
      cancelLogin,
      copyCode,
      logout,
      poolAction,
      setStrategy,
      toggleModel,
      setAllModels,
      setCheckinEnabled,
      runCheckinNow,
      updateEffort,
      saveContextWindow,
      resetContextWindow,
      resetAllContextWindows,
      refreshQuota,
      testConnection,
      updateContextDraft,
    },
  }
}
