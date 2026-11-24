import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CLAUDE_API_PROVIDER_ID,
  normalizeClaudeApiBaseUrl,
  type ClaudeApiBaseUrlError,
  type ClaudeApiCacheTtl,
  type ClaudeApiConnectionDto,
  type ClaudeApiReasoningEffort,
  type ClaudeApiSettingsUpdateDto,
  type ClaudeApiStatusDto,
} from '../../../shared/claude-api-contracts.ts'
import { contextDraftsFor } from '../../common/ContextWindowEditor.tsx'
import { parsePositiveCapacity } from '../../common/format.ts'
import { CLAUDE_API_CLIENT_ROUTES as ROUTES, get, messageOf, post, request } from './api.ts'

export interface ClaudeApiSectionProps { onModelChange?: () => void }

// The host answers a key save and an endpoint change at once with the built-in model
// table and refreshes the real catalog behind that answer, while the regular poll is
// 60 s apart. Two short follow-up reads show the refreshed list without that wait.
const FOLLOW_UP_READ_DELAYS_MS = [2_000, 6_000] as const

function isStatus(value: unknown): value is ClaudeApiStatusDto {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { providerId?: unknown; models?: unknown }
  return record.providerId === CLAUDE_API_PROVIDER_ID && Array.isArray(record.models)
}

export function useClaudeApiSection({ onModelChange }: ClaudeApiSectionProps = {}) {
  const [status, setStatus] = useState<ClaudeApiStatusDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connection, setConnection] = useState<ClaudeApiConnectionDto | null>(null)
  const [keyValue, setKeyValue] = useState('')
  // null means "showing the stored endpoint"; a string is what the user is typing.
  const [endpointDraft, setEndpointDraftState] = useState<string | null>(null)
  const [endpointError, setEndpointError] = useState<ClaudeApiBaseUrlError | null>(null)
  const [contextDrafts, setContextDrafts] = useState<Record<string, string>>({})
  const [capacityInvalid, setCapacityInvalid] = useState(false)
  const [savingModel, setSavingModel] = useState<string | null>(null)
  // Request bookkeeping. `inFlight` counts every request of this card. `stamp` moves
  // when any request starts and when a change settles, so a read whose stamp is no
  // longer current overlapped something newer and must not set state. `changeSeq`
  // orders the changes among themselves.
  const inFlight = useRef(0)
  const stamp = useRef(0)
  const changeSeq = useRef(0)
  // What the drafts were last seeded with: a draft that differs from it was typed.
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
    }
    catch (cause) { if (!quiet) setError(messageOf(cause)) }
    finally { inFlight.current -= 1; setLoading(false) }
  }, [adopt])
  // Sends one change. Its answer is applied only while no later change has started,
  // so an older answer arriving late cannot replace a newer one. The bookkeeping is
  // closed before `apply` runs, because `apply` may itself read the status.
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
  // The key and catalog routes are only specified as "{ ok, value }": adopt a status
  // when that is what came back, otherwise read it, so the card never renders a guess.
  const settle = useCallback(async (value: unknown) => {
    if (isStatus(value)) adopt(value)
    else await loadStatus(true)
  }, [adopt, loadStatus])
  const followUpTimers = useRef<number[]>([])
  const cancelFollowUps = useCallback(() => {
    for (const timer of followUpTimers.current) window.clearTimeout(timer)
    followUpTimers.current = []
  }, [])
  // A newer change restarts the pair, so reads never stack up behind repeated saves.
  // A follow-up is skipped while another request of the card is in flight, and it
  // keeps what the user has typed: it exists to bring in the catalog, nothing else.
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
  const saveKey = useCallback(async () => {
    const apiKey = keyValue.trim()
    if (apiKey === '') return
    setBusy('key'); setError(null)
    try {
      await change(() => post<unknown>(ROUTES.key, { apiKey }), settle)
      setKeyValue(''); setConnection(null); onModelChange?.(); scheduleFollowUps()
    } catch (cause) { setError(messageOf(cause)) }
    finally { setBusy(null) }
  }, [change, keyValue, onModelChange, scheduleFollowUps, settle])
  const removeKey = useCallback(async () => {
    setBusy('remove-key'); setError(null)
    try { await change(() => request<unknown>(ROUTES.key, { method: 'DELETE' }), settle); setConnection(null); onModelChange?.() }
    catch (cause) { setError(messageOf(cause)) }
    finally { setBusy(null) }
  }, [change, onModelChange, settle])
  const testConnection = useCallback(async () => {
    setBusy('connection'); setError(null)
    try { await change(() => post<ClaudeApiConnectionDto>(ROUTES.test, {}), setConnection); await loadStatus(true) }
    catch (cause) { setError(messageOf(cause)) }
    finally { setBusy(null) }
  }, [change, loadStatus])
  const refreshCatalog = useCallback(async () => {
    setBusy('catalog'); setError(null)
    try { await change(() => post<unknown>(ROUTES.catalogRefresh, {}), settle); onModelChange?.(); scheduleFollowUps() }
    catch (cause) { setError(messageOf(cause)) }
    finally { setBusy(null) }
  }, [change, onModelChange, scheduleFollowUps, settle])
  const saveEndpoint = useCallback(async () => {
    const result = normalizeClaudeApiBaseUrl(endpointDraft ?? status?.baseUrl ?? '')
    if (!result.ok) { setEndpointError(result.reason); return }
    setEndpointError(null)
    try { await update({ baseUrl: result.value }, 'endpoint'); setEndpointDraftState(null); setConnection(null); scheduleFollowUps() } catch { /* exposed */ }
  }, [endpointDraft, scheduleFollowUps, status, update])
  const restoreEndpoint = useCallback(async () => {
    setEndpointError(null)
    try { await update({ baseUrl: null }, 'endpoint-reset'); setEndpointDraftState(null); setConnection(null); scheduleFollowUps() } catch { /* exposed */ }
  }, [scheduleFollowUps, update])
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
    setSavingModel(id)
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
    status, loading, busy, error, connection, keyValue, endpointDraft, endpointError, contextDrafts, capacityInvalid, savingModel,
    setKeyValue,
    setEndpointDraft: (draft: string) => { setEndpointDraftState(draft); setEndpointError(null) },
    setContextDraft: (id: string, draft: string) => { setCapacityInvalid(false); setContextDrafts(current => ({ ...current, [id]: draft })) },
    saveKey, removeKey, testConnection, refreshCatalog, saveEndpoint, restoreEndpoint, update, toggleModel, setAllModels,
    saveContextWindow, resetContextWindow, resetAllContextWindows,
    setDefaultEffort: (defaultReasoningEffort: ClaudeApiReasoningEffort | null) => update({ defaultReasoningEffort }, 'effort'),
    setCacheTtl: (cacheTtl: ClaudeApiCacheTtl) => update({ cacheTtl }, 'options'),
    setFastMode: (fastMode: boolean) => update({ fastMode }, 'options'),
    setServerCompaction: (serverCompaction: boolean) => update({ serverCompaction }, 'options'),
  }
}
