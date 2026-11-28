import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CLAUDE_API_PROVIDER_ID,
  normalizeClaudeApiBaseUrl,
  type ClaudeApiAccountSummaryDto,
  type ClaudeApiBaseUrlError,
  type ClaudeApiCacheTtl,
  type ClaudeApiConnectionDto,
  type ClaudeApiReasoningEffort,
  type ClaudeApiSettingsUpdateDto,
  type ClaudeApiStatusDto,
} from '../../../shared/claude-api-contracts.ts'
import type { AccountRotationStrategy } from '../../../shared/account-pool-contracts.ts'
import { contextDraftsFor } from '../../common/ContextWindowEditor.tsx'
import { parsePositiveCapacity } from '../../common/format.ts'
import { CLAUDE_API_CLIENT_ROUTES as ROUTES, get, messageOf, post } from './api.ts'

export interface ClaudeApiSectionProps {
  onModelChange?: () => void
}

const FOLLOW_UP_READ_DELAYS_MS = [400, 1600]
function isStatus(value: unknown): value is ClaudeApiStatusDto {
  return typeof value === 'object' && value !== null && (value as { providerId?: unknown }).providerId === CLAUDE_API_PROVIDER_ID
}

export function useClaudeApiSection({ onModelChange }: ClaudeApiSectionProps) {
  const [status, setStatus] = useState<ClaudeApiStatusDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connection, setConnection] = useState<ClaudeApiConnectionDto | null>(null)
  const [accountFormOpen, setAccountFormOpen] = useState(false)
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null)
  const [aliasValue, setAliasValue] = useState('')
  const [keyValue, setKeyValue] = useState('')
  const [endpointDraft, setEndpointDraftState] = useState('')
  const [endpointError, setEndpointError] = useState<ClaudeApiBaseUrlError | null>(null)
  const [contextDrafts, setContextDrafts] = useState<Record<string, string>>({})
  const [capacityInvalid, setCapacityInvalid] = useState(false)
  const [savingModel, setSavingModel] = useState<string | null>(null)
  const inFlight = useRef(0)
  const stamp = useRef(0)
  const changeSeq = useRef(0)
  const seededDrafts = useRef<Record<string, string>>({})
  const adopt = useCallback((next: ClaudeApiStatusDto, keepTypedDrafts = false) => {
    const seeded = contextDraftsFor({ models: next.models, contextWindowOverrides: next.contextWindowOverrides })
    const previous = seededDrafts.current
    seededDrafts.current = seeded
    setStatus(next)
    setContextDrafts(keepTypedDrafts
      ? current => Object.fromEntries(Object.entries(seeded).map(([id, draft]) => [id, id in current && current[id] !== previous[id] ? current[id] : draft]))
      : seeded)
  }, [])
  const loadStatus = useCallback(async (quiet = false, keepTypedDrafts = false) => {
    if (!quiet) setError(null)
    inFlight.current += 1
    const mine = ++stamp.current
    try {
      const next = await get<ClaudeApiStatusDto>(ROUTES.status)
      if (stamp.current === mine) adopt(next, keepTypedDrafts)
    } catch (cause) { if (!quiet) setError(messageOf(cause)) }
    finally { inFlight.current -= 1; setLoading(false) }
  }, [adopt])
  const change = useCallback(async <T>(run: () => Promise<T>, apply: (value: T) => void | Promise<void>): Promise<T> => {
    inFlight.current += 1
    stamp.current += 1
    const mine = ++changeSeq.current
    let value: T
    try { value = await run() }
    finally { inFlight.current -= 1; stamp.current += 1 }
    if (changeSeq.current === mine) await apply(value)
    return value
  }, [])
  const settle = useCallback(async (value: unknown) => {
    if (isStatus(value)) adopt(value)
    else await loadStatus(true)
  }, [adopt, loadStatus])
  const followUpTimers = useRef<number[]>([])
  const cancelFollowUps = useCallback(() => {
    for (const timer of followUpTimers.current) window.clearTimeout(timer)
    followUpTimers.current = []
  }, [])
  const scheduleFollowUps = useCallback(() => {
    cancelFollowUps()
    followUpTimers.current = FOLLOW_UP_READ_DELAYS_MS.map(delay => window.setTimeout(() => {
      if (inFlight.current === 0) void loadStatus(true, true)
    }, delay))
  }, [cancelFollowUps, loadStatus])
  useEffect(() => cancelFollowUps, [cancelFollowUps])
  useEffect(() => {
    void loadStatus()
    const visible = () => { if (document.visibilityState === 'visible') void loadStatus(true) }
    const timer = window.setInterval(visible, 60_000)
    document.addEventListener('visibilitychange', visible)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visible) }
  }, [loadStatus])
  const update = useCallback(async (patch: ClaudeApiSettingsUpdateDto, label = 'settings') => {
    setBusy(label); setError(null); setCapacityInvalid(false)
    try {
      const next = await change(() => post<ClaudeApiStatusDto>(ROUTES.settings, patch), value => adopt(value))
      if (patch.enabled !== undefined || patch.enabledModelIds !== undefined || patch.defaultReasoningEffort !== undefined || patch.baseUrl !== undefined) onModelChange?.()
      return next
    } catch (cause) { setError(messageOf(cause)); throw cause }
    finally { setBusy(null) }
  }, [adopt, change, onModelChange])
  const openAddAccount = useCallback(() => {
    setAccountFormOpen(true); setEditingAccountId(null); setAliasValue(''); setKeyValue('')
    setEndpointDraftState(status?.defaultBaseUrl ?? ''); setEndpointError(null); setConnection(null)
  }, [status?.defaultBaseUrl])
  const openEditAccount = useCallback((account: ClaudeApiAccountSummaryDto) => {
    setAccountFormOpen(true); setEditingAccountId(account.id); setAliasValue(account.alias); setKeyValue('')
    setEndpointDraftState(account.baseUrl); setEndpointError(null); setConnection(null)
  }, [])
  const cancelAccountForm = useCallback(() => {
    setAccountFormOpen(false); setEditingAccountId(null); setAliasValue(''); setKeyValue(''); setEndpointError(null)
  }, [])
  const saveAccount = useCallback(async () => {
    const normalized = normalizeClaudeApiBaseUrl(endpointDraft)
    if (!normalized.ok) { setEndpointError(normalized.reason); return }
    if (editingAccountId === null && keyValue.trim() === '') return
    setBusy('account'); setError(null); setEndpointError(null)
    try {
      await change(() => post<unknown>(ROUTES.accounts, {
        action: 'save',
        ...(editingAccountId === null ? {} : { accountId: editingAccountId }),
        alias: aliasValue,
        baseUrl: normalized.value,
        ...(keyValue.trim() === '' ? {} : { apiKey: keyValue.trim() }),
      }), settle)
      cancelAccountForm(); setConnection(null); onModelChange?.(); scheduleFollowUps()
    } catch (cause) { setError(messageOf(cause)) }
    finally { setBusy(null) }
  }, [aliasValue, cancelAccountForm, change, editingAccountId, endpointDraft, keyValue, onModelChange, scheduleFollowUps, settle])
  const accountAction = useCallback(async (action: string, accountId: string) => {
    setBusy(action + '-' + accountId); setError(null)
    try {
      await change(() => post<unknown>(ROUTES.accounts, { action, accountId }), settle)
      setConnection(null); onModelChange?.(); scheduleFollowUps()
    } catch (cause) { setError(messageOf(cause)) }
    finally { setBusy(null) }
  }, [change, onModelChange, scheduleFollowUps, settle])
  const setStrategy = useCallback(async (rotationStrategy: AccountRotationStrategy) => {
    setBusy('strategy'); setError(null)
    try { await change(() => post<unknown>(ROUTES.accounts, { action: 'strategy', strategy: rotationStrategy }), settle) }
    catch (cause) { setError(messageOf(cause)) }
    finally { setBusy(null) }
  }, [change, settle])
  const testConnection = useCallback(async (accountId?: string) => {
    setBusy('connection' + (accountId ? '-' + accountId : '')); setError(null)
    try { await change(() => post<ClaudeApiConnectionDto>(ROUTES.test, accountId ? { accountId } : {}), setConnection); await loadStatus(true) }
    catch (cause) { setError(messageOf(cause)) }
    finally { setBusy(null) }
  }, [change, loadStatus])
  const refreshCatalog = useCallback(async () => {
    setBusy('catalog'); setError(null)
    try { await change(() => post<unknown>(ROUTES.catalogRefresh, {}), settle); onModelChange?.(); scheduleFollowUps() }
    catch (cause) { setError(messageOf(cause)) }
    finally { setBusy(null) }
  }, [change, onModelChange, scheduleFollowUps, settle])
  const toggleModel = useCallback((id: string, enabled: boolean) => {
    if (status === null) return
    const ids = status.models.filter(model => model.id === id ? enabled : model.enabled).map(model => model.id)
    void update({ enabledModelIds: ids }, 'models').catch(() => undefined)
  }, [status, update])
  const setAllModels = useCallback((enabled: boolean) => {
    if (status === null) return
    void update({ enabledModelIds: enabled ? status.models.map(model => model.id) : [] }, 'models').catch(() => undefined)
  }, [status, update])
  const saveContextWindow = useCallback(async (id: string) => {
    const parsed = parsePositiveCapacity(contextDrafts[id] ?? '')
    if (parsed === null) { setCapacityInvalid(true); return }
    setCapacityInvalid(false); setSavingModel(id)
    try { await update({ contextWindowOverrides: { [id]: parsed } }, 'context:' + id) } catch { /* exposed */ }
    finally { setSavingModel(null) }
  }, [contextDrafts, update])
  const resetContextWindow = useCallback(async (id: string) => {
    setSavingModel(id)
    try { await update({ contextWindowOverrides: { [id]: null } }, 'context:' + id) } catch { /* exposed */ }
    finally { setSavingModel(null) }
  }, [update])
  const resetAllContextWindows = useCallback(async () => {
    const overrides = Object.fromEntries(Object.keys(status?.contextWindowOverrides ?? {}).map(id => [id, null]))
    if (Object.keys(overrides).length > 0) await update({ contextWindowOverrides: overrides }, 'context')
  }, [status, update])
  return {
    status, loading, busy, error, connection, accountFormOpen, editingAccountId, aliasValue, keyValue, endpointDraft, endpointError,
    contextDrafts, capacityInvalid, savingModel,
    setAliasValue, setKeyValue,
    setEndpointDraft: (draft: string) => { setEndpointDraftState(draft); setEndpointError(null) },
    setContextDraft: (id: string, draft: string) => { setCapacityInvalid(false); setContextDrafts(current => ({ ...current, [id]: draft })) },
    openAddAccount, openEditAccount, cancelAccountForm, saveAccount, accountAction, setStrategy,
    testConnection, refreshCatalog, update, toggleModel, setAllModels,
    saveContextWindow, resetContextWindow, resetAllContextWindows,
    setDefaultEffort: (defaultReasoningEffort: ClaudeApiReasoningEffort | null) => update({ defaultReasoningEffort }, 'effort'),
    setCacheTtl: (cacheTtl: ClaudeApiCacheTtl) => update({ cacheTtl }, 'options'),
    setSubagentCacheTtl: (subagentCacheTtl: ClaudeApiCacheTtl) => update({ subagentCacheTtl }, 'options'),
    setFastMode: (fastMode: boolean) => update({ fastMode }, 'options'),
    setServerCompaction: (serverCompaction: boolean) => update({ serverCompaction }, 'options'),
    setAutoCompactSubagents: (autoCompactSubagents: boolean) => update({ autoCompactSubagents }, 'options'),
  }
}
