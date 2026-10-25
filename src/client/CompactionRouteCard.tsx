import { useCallback, useEffect, useState } from 'react'
import type {
  CompactionCandidatesDto,
  SubscriptionPreferencesDto,
} from '../shared/contracts.ts'
import type { SubscriptionApi } from './api.ts'

/** Labels the settings page supplies, so this card carries no locale of its own. */
export interface CompactionRouteCardLabels {
  title: string
  hint: string
  provider: string
  model: string
  save: string
  clear: string
  change: string
  /** Shown as the current value when no route is configured. */
  follow: string
  saved: string
  failed: string
  /** Shown when the chosen model cannot take video, so compaction would fall back. */
  noVideo: string
  /** Shown when the chosen model cannot take images, so they become placeholders. */
  noImage: string
  empty: string
}

export interface CompactionRouteCardProps {
  readonly api: SubscriptionApi
  readonly preferences: SubscriptionPreferencesDto | null
  readonly disabled?: boolean
  readonly labels: CompactionRouteCardLabels
  readonly onSaved: (preferences: SubscriptionPreferencesDto) => void
}

/**
 * Choose the model an automatic compaction summarizes on.
 *
 * The route lives in this plugin's preferences and is applied by the host's
 * `llm/stream` listener, so a saved choice takes effect on the next compaction
 * without a restart. Both selects are needed together: a model id alone belongs
 * to no route.
 *
 * The picker loads its directory on demand rather than on mount: opening the
 * settings page must not cost a request to every line (that page is opened for
 * unrelated reasons all the time), and the card already knows the saved route
 * from the status it was rendered with.
 */
export function CompactionRouteCard({ api, preferences, disabled = false, labels, onSaved }: CompactionRouteCardProps): React.JSX.Element {
  const [picking, setPicking] = useState(false)
  const [candidates, setCandidates] = useState<CompactionCandidatesDto | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const value = await api.compactionCandidates()
      setCandidates(value)
      setLoadError(null)
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [api])

  useEffect(() => {
    if (picking && candidates === null) void load()
  }, [picking, candidates, load])

  // A saved route seeds the selects. It is seeded rather than fetched so the
  // card states what is configured even when the directory cannot be read.
  useEffect(() => {
    const saved = preferences?.compactionRoute ?? null
    if (saved === null) return
    setProvider((current) => current === '' ? saved.provider : current)
    setModel((current) => current === '' ? saved.model : current)
  }, [preferences?.compactionRoute])

  const providers = candidates?.providers ?? []
  const models = providers.find((entry) => entry.id === provider)?.models ?? []
  const selected = models.find((entry) => entry.id === model)
  const savedProvider = preferences?.compactionRoute?.provider ?? ''
  const savedModel = preferences?.compactionRoute?.model ?? ''
  const dirty = provider !== savedProvider || model !== savedModel
  const canSave = provider !== '' && model !== '' && dirty && !busy && !disabled
  // A saved route the directory no longer offers still has to be visible: a
  // blank select would read as "nothing is configured" while the host keeps
  // summarizing on that route.
  const providerOptions = savedProvider === '' || providers.some((entry) => entry.id === savedProvider)
    ? providers
    : [{ id: savedProvider, name: savedProvider }, ...providers]
  const modelOptions = model !== '' && !models.some((entry) => entry.id === model)
    ? [{ id: model, name: model, modalities: [] as string[] }, ...models]
    : models
  const currentLabel = savedProvider === '' ? labels.follow : `${savedProvider} / ${savedModel}`

  const save = async (target: { provider: string; model: string } | null): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const next = await api.updatePreferences({ compactionRoute: target })
      onSaved(next)
      setNotice(labels.saved)
      setPicking(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return <section className="dsha-group">
    <div className="dsha-grouphead"><h3>{labels.title}</h3></div>
    <p className="dsha-muted">{labels.hint}</p>
    <div className="dsha-pref-row">
      <div>
        <strong>{currentLabel}</strong>
      </div>
      <button
        className="dsha-btn"
        type="button"
        disabled={busy || disabled}
        onClick={() => setPicking((current) => !current)}
      >{labels.change}</button>
    </div>
    {picking ? <>
      {loadError !== null ? <p className="dsh-codex-error" role="alert">{loadError}</p> : null}
      {candidates !== null && providers.length === 0 ? <p className="dsh-codex-empty">{labels.empty}</p> : null}
      <div className="dsha-pref-row">
        <div><strong>{labels.provider}</strong></div>
        <select
          className="dsha-select"
          aria-label={labels.provider}
          value={provider}
          disabled={busy || disabled}
          onChange={(event) => { setProvider(event.currentTarget.value); setModel('') }}
        >
          <option value="">—</option>
          {providerOptions.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
      </div>
      <div className="dsha-pref-row">
        <div><strong>{labels.model}</strong></div>
        <select
          className="dsha-select"
          aria-label={labels.model}
          value={model}
          disabled={busy || disabled || provider === ''}
          onChange={(event) => setModel(event.currentTarget.value)}
        >
          <option value="">—</option>
          {modelOptions.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
      </div>
      {selected !== undefined && selected.modalities.length > 0 && !selected.modalities.includes('video')
        ? <p className="dsh-codex-warning">{labels.noVideo}</p>
        : null}
      {selected !== undefined && selected.modalities.length > 0 && !selected.modalities.includes('image')
        ? <p className="dsh-codex-warning">{labels.noImage}</p>
        : null}
      <div className="dsha-actions">
        <button
          className="dsha-btn dsha-btn-primary"
          type="button"
          disabled={!canSave}
          onClick={() => void save({ provider, model })}
        >{labels.save}</button>
        <button
          className="dsha-btn"
          type="button"
          disabled={busy || disabled || savedProvider === ''}
          onClick={() => void save(null)}
        >{labels.clear}</button>
      </div>
    </> : null}
    {notice !== null ? <p className="dsh-codex-success" role="status">{notice}</p> : null}
    {error !== null ? <p className="dsh-codex-error" role="alert">{labels.failed}: {error}</p> : null}
  </section>
}
