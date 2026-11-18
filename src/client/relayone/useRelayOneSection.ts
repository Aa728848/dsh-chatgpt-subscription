import { useCallback, useEffect, useState } from 'react'
import type {
  RelayOneConnectionDto,
  RelayOneReasoningEffort,
  RelayOneSettingsUpdateDto,
  RelayOneStatusDto,
} from '../../shared/relayone-contracts.ts'
import { contextDraftsFor } from '../common/ContextWindowEditor.tsx'
import { parsePositiveCapacity } from '../common/format.ts'
import { get, messageOf, post, request } from './api.ts'

export interface RelayOneSectionProps { onModelChange?: () => void }
export function useRelayOneSection({ onModelChange }: RelayOneSectionProps = {}) {
  const [status, setStatus] = useState<RelayOneStatusDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connection, setConnection] = useState<RelayOneConnectionDto | null>(null)
  const [keyValue, setKeyValue] = useState('')
  const [contextDrafts, setContextDrafts] = useState<Record<string, string>>({})
  const [savingModel, setSavingModel] = useState<string | null>(null)
  const adopt = useCallback((next: RelayOneStatusDto) => {
    setStatus(next)
    setContextDrafts(contextDraftsFor({ models: next.models, contextWindowOverrides: next.contextWindowOverrides } as never))
  }, [])
  const loadStatus = useCallback(async (quiet = false) => {
    if (!quiet) setError(null)
    try { adopt(await get<RelayOneStatusDto>('/status')) }
    catch (cause) { if (!quiet) setError(messageOf(cause)) }
    finally { setLoading(false) }
  }, [adopt])
  useEffect(() => {
    void loadStatus()
    const visible = () => { if (document.visibilityState === 'visible') void loadStatus(true) }
    const timer = window.setInterval(visible, 60_000)
    document.addEventListener('visibilitychange', visible)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visible) }
  }, [loadStatus])
  const update = useCallback(async (patch: RelayOneSettingsUpdateDto, label = 'settings') => {
    setBusy(label); setError(null)
    try {
      const next = await post<RelayOneStatusDto>('/settings', patch)
      adopt(next)
      if (patch.enabled !== undefined || patch.enabledModelIds !== undefined || patch.defaultReasoningEffort !== undefined) onModelChange?.()
      return next
    } catch (cause) { setError(messageOf(cause)); throw cause }
    finally { setBusy(null) }
  }, [adopt, onModelChange])
  const saveKey = useCallback(async () => {
    const apiKey = keyValue.trim()
    if (apiKey === '') return
    setBusy('key'); setError(null)
    try {
      adopt(await request<RelayOneStatusDto>('/credentials', { method: 'PUT', body: JSON.stringify({ apiKey }) }))
      setKeyValue(''); setConnection(null); onModelChange?.()
    } catch (cause) { setError(messageOf(cause)) }
    finally { setBusy(null) }
  }, [adopt, keyValue, onModelChange])
  const removeKey = useCallback(async () => {
    setBusy('remove-key'); setError(null)
    try { adopt(await request<RelayOneStatusDto>('/credentials', { method: 'DELETE' })); setConnection(null); onModelChange?.() }
    catch (cause) { setError(messageOf(cause)) }
    finally { setBusy(null) }
  }, [adopt, onModelChange])
  const testConnection = useCallback(async () => {
    setBusy('connection'); setError(null)
    try { setConnection(await post<RelayOneConnectionDto>('/connection', {})); await loadStatus(true) }
    catch (cause) { setError(messageOf(cause)) }
    finally { setBusy(null) }
  }, [loadStatus])
  const refreshCatalog = useCallback(async () => {
    setBusy('catalog'); setError(null)
    try { adopt(await post<RelayOneStatusDto>('/catalog/refresh', {})); onModelChange?.() }
    catch (cause) { setError(messageOf(cause)) }
    finally { setBusy(null) }
  }, [adopt, onModelChange])
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
    if (parsed === null) { setError('Invalid capacity: ' + (contextDrafts[id] ?? '')); return }
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
    status, loading, busy, error, connection, keyValue, contextDrafts, savingModel,
    setKeyValue,
    setContextDraft: (id: string, draft: string) => setContextDrafts(current => ({ ...current, [id]: draft })),
    saveKey, removeKey, testConnection, refreshCatalog, update, toggleModel, setAllModels,
    saveContextWindow, resetContextWindow, resetAllContextWindows,
    setDefaultEffort: (defaultReasoningEffort: RelayOneReasoningEffort | null) => update({ defaultReasoningEffort }, 'effort'),
    setImageModel: (imageModel: string | null) => update({ imageModel }, 'media'),
    setVideoModel: (videoModel: string | null) => update({ videoModel }, 'media'),
  }
}
