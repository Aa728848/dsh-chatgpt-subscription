import { useCallback, useEffect, useState } from 'react'
import type {
  QianwenCacheStatsDto,
  QianwenConnectionDto,
  QianwenImageDetail,
  QianwenReasoningEffort,
  QianwenSettingsUpdateDto,
  QianwenStatusDto,
} from '../../../shared/qianwen-token-plan-contracts.ts'
import { contextDraftsFor } from '../../common/ContextWindowEditor.tsx'
import { parsePositiveCapacity } from '../../common/format.ts'
import { get, messageOf, post, request } from './api.ts'

export interface QianwenSectionProps { onModelChange?: () => void }
export function qianwenCacheHitRatio(stats: QianwenCacheStatsDto | null): number | null {
  if (stats === null) return null
  const denominator = stats.cacheReadTokens + stats.missedInputTokens + stats.cacheWriteTokens
  return Number.isFinite(denominator) && denominator > 0 ? stats.cacheReadTokens / denominator : null
}

export function useQianwenSection({ onModelChange }: QianwenSectionProps = {}) {
  const [status, setStatus] = useState<QianwenStatusDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connection, setConnection] = useState<QianwenConnectionDto | null>(null)
  const [keyValue, setKeyValue] = useState('')
  const [contextDrafts, setContextDrafts] = useState<Record<string, string>>({})
  const [savingModel, setSavingModel] = useState<string | null>(null)
  const [pixelsDraft, setPixelsDraft] = useState('')
  const adopt = useCallback((next: QianwenStatusDto) => {
    setStatus(next)
    setContextDrafts(contextDraftsFor(next))
    setPixelsDraft(next.maxPixels === null ? '' : String(next.maxPixels))
  }, [])
  const loadStatus = useCallback(async (quiet = false) => {
    if (!quiet) setError(null)
    try { adopt(await get<QianwenStatusDto>('/status')) }
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
  const update = useCallback(async (patch: QianwenSettingsUpdateDto, label = 'settings') => {
    setBusy(label); setError(null)
    try {
      const next = await post<QianwenStatusDto>('/settings', patch)
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
      adopt(await request<QianwenStatusDto>('/credentials', { method: 'PUT', body: JSON.stringify({ apiKey }) }))
      setKeyValue(''); setConnection(null); onModelChange?.()
    } catch (cause) { setError(messageOf(cause)) }
    finally { setBusy(null) }
  }, [adopt, keyValue, onModelChange])
  const removeKey = useCallback(async () => {
    setBusy('remove-key'); setError(null)
    try {
      adopt(await request<QianwenStatusDto>('/credentials', { method: 'DELETE' }))
      setConnection(null); onModelChange?.()
    } catch (cause) { setError(messageOf(cause)) }
    finally { setBusy(null) }
  }, [adopt, onModelChange])
  const testConnection = useCallback(async () => {
    setBusy('connection'); setError(null)
    try { setConnection(await post<QianwenConnectionDto>('/connection', {})) }
    catch (cause) { setError(messageOf(cause)) }
    finally { setBusy(null) }
  }, [])
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
    const raw = contextDrafts[id] ?? ''
    const parsed = parsePositiveCapacity(raw)
    if (parsed === null) { setError('Invalid capacity: ' + raw); return }
    setSavingModel(id)
    try { await update({ contextWindowOverrides: { [id]: parsed } }, 'context:' + id) }
    catch { /* update already exposed the error */ }
    finally { setSavingModel(null) }
  }, [contextDrafts, update])
  const resetContextWindow = useCallback(async (id: string) => {
    setSavingModel(id)
    try { await update({ contextWindowOverrides: { [id]: null } }, 'context:' + id) }
    catch { /* exposed */ }
    finally { setSavingModel(null) }
  }, [update])
  const resetAllContextWindows = useCallback(async () => {
    const overrides = Object.fromEntries(Object.keys(status?.contextWindowOverrides ?? {}).map(id => [id, null]))
    if (Object.keys(overrides).length > 0) await update({ contextWindowOverrides: overrides }, 'context')
  }, [status, update])
  const savePixels = useCallback(async () => {
    const raw = pixelsDraft.trim()
    const value = raw === '' ? null : Number(raw)
    if (value !== null && (!Number.isSafeInteger(value) || value < 65_536 || value > 16_777_216)) {
      setError('max_pixels must be an integer from 65536 through 16777216.'); return
    }
    try { await update({ maxPixels: value }, 'pixels') } catch { /* exposed */ }
  }, [pixelsDraft, update])
  return {
    status, loading, busy, error, connection, keyValue, contextDrafts, savingModel, pixelsDraft,
    setKeyValue, setPixelsDraft,
    setContextDraft: (id: string, draft: string) => setContextDrafts(current => ({ ...current, [id]: draft })),
    saveKey, removeKey, testConnection, update, toggleModel, setAllModels,
    saveContextWindow, resetContextWindow, resetAllContextWindows, savePixels,
    setDefaultEffort: (defaultReasoningEffort: QianwenReasoningEffort | null) => update({ defaultReasoningEffort }, 'effort'),
    setImageDetail: (imageDetail: QianwenImageDetail) => update({ imageDetail }, 'vision'),
  }
}
