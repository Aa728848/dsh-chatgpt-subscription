import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'

interface AdvisorDirectoryStore {
  subscribe(callback: () => void): () => void
  getSnapshot(): ModelDirectoryState
}
import { ADVISOR_STATE_PATH, type AdvisorRoute, type AdvisorStateDto } from '../../../shared/advisor-contracts.ts'
import type { AdvisorLocaleKey } from './locales.ts'

type ProviderGroup = ModelDirectoryState['groups'][number]
type CatalogModel = ProviderGroup['models'][number]
type ReasoningEffort = NonNullable<CatalogModel['reasoning']>['efforts'][number]
type Translate = (key: AdvisorLocaleKey, params?: Record<string, string>) => string

type AdvisorUpdate = (patch: { enabled?: boolean; selection?: AdvisorRoute | null }) => void

function AdvisorReasoningSlider({ selection, directory, pending, locked, update, t }: {
  selection: AdvisorRoute
  directory: AdvisorDirectoryStore
  pending: boolean
  locked: boolean
  update: AdvisorUpdate
  t: Translate
}): React.JSX.Element | null {
  const snapshot = useSyncExternalStore((cb) => directory.subscribe(cb), () => directory.getSnapshot())
  const model = snapshot.groups.find((group) => group.id === selection.provider)?.models.find((item: CatalogModel) => item.id === selection.model)
  const efforts = model?.reasoning?.efforts ?? []
  const trackRef = useRef<HTMLDivElement | null>(null)
  const fillRef = useRef<HTMLDivElement | null>(null)
  const knobRef = useRef<HTMLDivElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  // The drag writes the knob straight to the DOM every frame: routing each
  // pointermove through React state re-rendered the whole pane and made the
  // travel visibly stutter. Only the settled level goes back through state.
  const dragging = useRef(false)
  const disabled = locked || pending
  const current = Math.max(0, efforts.findIndex((effort: ReasoningEffort) => effort.id === (selection.reasoningEffort ?? model?.reasoning?.defaultEffort ?? efforts[0]!.id)))
  if (efforts.length === 0) return null
  const last = Math.max(1, efforts.length - 1)
  const resting = current / last
  const name = efforts[Math.max(0, Math.min(efforts.length - 1, current))]!.name
  const select = (index: number): void => {
    const next = efforts[Math.max(0, Math.min(efforts.length - 1, index))]!
    if (next.id !== selection.reasoningEffort) update({ selection: { ...selection, reasoningEffort: next.id } })
  }
  /** Paint one ratio onto the knob, the fill and the apex tint without React. */
  const paint = (ratio: number): void => {
    const clamped = Math.max(0, Math.min(1, ratio))
    const track = trackRef.current
    if (track === null) return
    const width = track.clientWidth
    const travel = width - 16
    if (knobRef.current !== null) knobRef.current.style.transform = `translateX(${clamped * travel}px)`
    if (fillRef.current !== null) fillRef.current.style.width = `${clamped * travel + 8}px`
    if (rootRef.current !== null) {
      const tinted = efforts.length > 1 ? Math.round(clamped * 100) : 100
      rootRef.current.style.setProperty('--dshadv-effort-tint', String(tinted))
      // The apex attribute drives the top rung's glow; keep it on the node the
      // stylesheet reads rather than relying on a later React render to set it.
      if (clamped >= 0.999) rootRef.current.setAttribute('data-apex', '')
      else rootRef.current.removeAttribute('data-apex')
    }
  }
  const ratioAt = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect()
    const width = (rect?.width ?? 0) - 16
    if (rect === undefined || width <= 0) return resting
    return Math.max(0, Math.min(1, (clientX - rect.left - 8) / width))
  }
  useEffect(() => { if (!dragging.current) paint(resting) })
  return <div ref={rootRef} className="dshadv-effort dshadv-effort-tinted dsh-claude-effort" data-dragging={dragging.current ? '' : undefined}>
    <div className="dshadv-effort-head dsh-claude-effort-head"><span className="dshadv-effort-label dsh-claude-effort-label">{t('reasoning')}</span><span className="dshadv-effort-value dsh-claude-effort-value">{name}</span></div>
    <div
      ref={trackRef}
      className="dshadv-effort-track dsh-claude-effort-track"
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label={t('reasoning')}
      aria-valuemin={0}
      aria-valuemax={last}
      aria-valuenow={current}
      aria-valuetext={name}
      onPointerDown={(event) => {
        if (disabled) return
        event.currentTarget.setPointerCapture(event.pointerId)
        dragging.current = true
        rootRef.current?.setAttribute('data-dragging', '')
        paint(ratioAt(event.clientX))
      }}
      onPointerMove={(event) => { if (!disabled && dragging.current) paint(ratioAt(event.clientX)) }}
      onPointerUp={(event) => {
        if (disabled || !dragging.current) return
        dragging.current = false
        rootRef.current?.removeAttribute('data-dragging')
        select(Math.round(ratioAt(event.clientX) * last))
      }}
      onPointerCancel={() => { dragging.current = false; rootRef.current?.removeAttribute('data-dragging'); paint(resting) }}
      onKeyDown={(event) => {
        if (disabled) return
        if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') { event.preventDefault(); select(current - 1) }
        else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') { event.preventDefault(); select(current + 1) }
        else if (event.key === 'Home') { event.preventDefault(); select(0) }
        else if (event.key === 'End') { event.preventDefault(); select(last) }
      }}
    >
      <div ref={fillRef} className="dshadv-effort-fill dsh-claude-effort-fill" />
      <div className="dshadv-effort-ticks dsh-claude-effort-ticks">{efforts.map((effort: ReasoningEffort, index: number) => <span key={effort.id} className="dshadv-effort-tick dsh-claude-effort-tick" style={{ left: `${(index / last) * 100}%` }} />)}</div>
      <div ref={knobRef} className="dshadv-effort-knob dsh-claude-effort-knob" />
    </div>
    <div className="dshadv-effort-ends dsh-claude-effort-ends"><span className="dsh-claude-effort-end">{t('faster')}</span><span className="dsh-claude-effort-end">{t('stronger')}</span></div>
  </div>
}
export interface AdvisorApi {
  read(sessionId: string): Promise<AdvisorStateDto>
  write(sessionId: string, patch: { enabled?: boolean; selection?: AdvisorRoute | null }): Promise<AdvisorStateDto>
}
async function call(url: string, init?: RequestInit): Promise<AdvisorStateDto> {
  const response = await fetch(url, { ...init, credentials: 'same-origin' })
  const envelope = await response.json().catch(() => null) as { ok?: boolean; value?: AdvisorStateDto } | null
  if (!response.ok || envelope?.ok !== true || envelope.value === undefined) throw new Error(`HTTP ${response.status}`)
  return envelope.value
}
export const advisorApi: AdvisorApi = {
  read: (sessionId) => call(`${ADVISOR_STATE_PATH}?session=${encodeURIComponent(sessionId)}`),
  write: (sessionId, patch) => call(ADVISOR_STATE_PATH, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, ...patch }),
  }),
}

export interface AdvisorInjected {
  sessionId: string
  directory: AdvisorDirectoryStore
  load: () => void
}
export interface AdvisorOptionProps extends AdvisorInjected {
  locked: boolean
  openPane: (pane: { key: string; title: string }) => void
  reportFailure: (message: string) => void
  t: Translate
  api?: AdvisorApi
}

function useAdvisorState(sessionId: string, api: AdvisorApi, reportFailure: (message: string) => void, t: Translate) {
  const [state, setState] = useState<AdvisorStateDto | null>(null)
  const [pending, setPending] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    setState(null)
    void api.read(sessionId).then((value) => { if (mounted.current) setState(value) }).catch(() => undefined)
    return () => { mounted.current = false }
  }, [api, sessionId])
  useEffect(() => {
    const changed = (event: Event) => {
      const next = (event as CustomEvent<AdvisorStateDto>).detail
      if (next?.sessionId === sessionId) setState(next)
    }
    window.addEventListener('dsh-advisor-changed', changed)
    return () => window.removeEventListener('dsh-advisor-changed', changed)
  }, [sessionId])
  const update = useCallback((patch: { enabled?: boolean; selection?: AdvisorRoute | null }) => {
    setPending(true)
    void api.write(sessionId, patch).then((value) => {
      if (mounted.current) setState(value)
      window.dispatchEvent(new CustomEvent('dsh-advisor-changed', { detail: value }))
    }, (error: unknown) => {
      if (mounted.current) reportFailure(t('failed', { message: error instanceof Error ? error.message : String(error) }))
    }).finally(() => { if (mounted.current) setPending(false) })
  }, [api, reportFailure, sessionId, t])
  return { state, pending, update }
}interface PanelMotion {
  open: boolean
  openPanel: (anchor: HTMLElement, widthOverride?: number) => void
  close: () => void
  cancelClose: () => void
  scheduleClose: () => void
  style?: React.CSSProperties
}

/** Shared popover motion: hover opens, a short grace period closes, Escape closes. */
function usePanelMotion(): PanelMotion & { anchor: React.MutableRefObject<HTMLButtonElement | null> } {
  const anchor = useRef<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const [style, setStyle] = useState<React.CSSProperties | undefined>(undefined)
  const closeTimer = useRef<number | undefined>(undefined)
  const openPanel = (target: HTMLElement, widthOverride?: number): void => {
    window.clearTimeout(closeTimer.current)
    closeTimer.current = undefined
    const rect = target.getBoundingClientRect()
    const width = Math.min(widthOverride ?? 320, window.innerWidth - 16)
    setStyle({
      position: 'fixed',
      width,
      // Right-align to the seat: these seats sit at the toolbar's right end, so
      // left-aligning would push the panel far to the right of its own trigger.
      left: Math.min(Math.max(8, rect.right - width), Math.max(8, window.innerWidth - width - 8)),
      bottom: Math.max(8, window.innerHeight - rect.top + 8),
      // Use all the room between the seat and the viewport top, so the catalog is
      // shown without an inner scrollbar unless the viewport itself is short.
      maxHeight: Math.max(160, rect.top - 24),
    })
    setOpen(true)
  }
  const close = (): void => { window.clearTimeout(closeTimer.current); setOpen(false) }
  const scheduleClose = (): void => { window.clearTimeout(closeTimer.current); closeTimer.current = window.setTimeout(() => setOpen(false), 320) }
  const cancelClose = (): void => { window.clearTimeout(closeTimer.current); closeTimer.current = undefined }
  useEffect(() => () => window.clearTimeout(closeTimer.current), [])
  return { anchor, open, style, openPanel, close, cancelClose, scheduleClose }
}

export interface AdvisorTriggerProps extends AdvisorInjected {
  locked: boolean
  reportFailure: (message: string) => void
  t: Translate
  api?: AdvisorApi
}

/** Model seat: enable switch plus the advisor model list. No reasoning control. */
export function AdvisorModelTrigger(props: AdvisorTriggerProps): React.JSX.Element | null {
  const { sessionId, locked, reportFailure, t } = props
  const api = props.api ?? advisorApi
  const { anchor, open, style, openPanel, close, cancelClose, scheduleClose } = usePanelMotion()
  const { state, pending, update } = useAdvisorState(sessionId, api, reportFailure, t)
  useEffect(() => { props.load() }, [props.load])
  useEffect(() => {
    if (!open) return
    const outside = (event: Event) => {
      const target = event.target as Node | null
      const panel = document.getElementById('dshadv-model-popover')
      const inside = target === null || anchor.current?.contains(target) || (panel !== null && panel.contains(target))
      if (!inside) close()
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open])
  if (state === null || state.sessionId !== sessionId) return null
  const selected = state.selection
  // While Advisor is off there is nothing to pick yet: the seat reads as a plain
  // "Advisor" switch and the catalog stays closed, so it cannot imply a choice.
  const caption = !state.enabled ? t('label') : selected === null ? t('enableFirst') : selected.model
  return <>
    <button
      ref={anchor}
      type="button"
      className="dshadv-trigger"
      data-enabled={state.enabled}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-description={t('privacy')}
      aria-label={`${t('label')} · ${t('model')}`}
      disabled={locked}
      onPointerEnter={(event) => openPanel(event.currentTarget)}
      onMouseEnter={(event) => openPanel(event.currentTarget)}
      onFocus={(event) => openPanel(event.currentTarget)}
      onClick={(event) => openPanel(event.currentTarget)}
      onPointerLeave={scheduleClose}
    >
      <span className="dshadv-trigger-label">{caption}</span>
    </button>
    {open && createPortal(<div id="dshadv-model-popover" className="dshadv-popover" role="dialog" aria-label={t('model')} style={style}
      onPointerEnter={cancelClose} onMouseEnter={cancelClose} onPointerLeave={scheduleClose} onMouseLeave={scheduleClose}>
      <div className="dshadv-popover-head">
        <span className="dshadv-popover-title">{t('label')}</span>
        <button type="button" role="switch" className="dshadv-switch" aria-checked={state.enabled} aria-label={t('label')} disabled={pending} onClick={() => update({ enabled: !state.enabled })} />
      </div>
      {state.enabled && <AdvisorModelPane sessionId={sessionId} directory={props.directory} load={props.load} locked={locked || pending} reportFailure={reportFailure} t={t} api={api} />}
      {!state.enabled && <p className="dshadv-off-hint">{t('enableHint')}</p>}
    </div>, document.body)}
  </>
}

/** Reasoning seat: the same effort ladder as the main model, for the advisor model. */
export function AdvisorEffortTrigger(props: AdvisorTriggerProps): React.JSX.Element | null {
  const { sessionId, locked, reportFailure, t } = props
  const api = props.api ?? advisorApi
  const { anchor, open, style, openPanel, close, cancelClose, scheduleClose } = usePanelMotion()
  const { state, pending, update } = useAdvisorState(sessionId, api, reportFailure, t)
  useEffect(() => { props.load() }, [props.load])
  useEffect(() => {
    if (!open) return
    const outside = (event: Event) => {
      const target = event.target as Node | null
      const panel = document.getElementById('dshadv-effort-popover')
      const inside = target === null || anchor.current?.contains(target) || (panel !== null && panel.contains(target))
      if (!inside) close()
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open])
  const snapshot = useSyncExternalStore((cb) => props.directory.subscribe(cb), () => props.directory.getSnapshot())
  if (state === null || state.sessionId !== sessionId || !state.enabled || state.selection === null) return null
  const selected = state.selection
  const model = snapshot.groups.find((group) => group.id === selected.provider)?.models.find((item: CatalogModel) => item.id === selected.model)
  const efforts = model?.reasoning?.efforts ?? []
  if (efforts.length === 0) return null
  const currentId = selected.reasoningEffort ?? model?.reasoning?.defaultEffort ?? efforts[0]!.id
  const currentEffort = efforts.find((effort: ReasoningEffort) => effort.id === currentId) ?? efforts[0]!
  return <>
    <button
      ref={anchor}
      type="button"
      className="dshadv-effort-trigger"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={`${t('reasoning')} ${currentEffort.name}`}
      disabled={locked}
      onPointerEnter={(event) => openPanel(event.currentTarget, 232)}
      onMouseEnter={(event) => openPanel(event.currentTarget, 232)}
      onFocus={(event) => openPanel(event.currentTarget, 232)}
      onClick={(event) => openPanel(event.currentTarget, 232)}
      onPointerLeave={scheduleClose}
    >{currentEffort.name}</button>
    {open && createPortal(<div id="dshadv-effort-popover" className="dshadv-popover dshadv-effort-popover" role="dialog" aria-label={t('reasoning')} style={style}
      onPointerEnter={cancelClose} onMouseEnter={cancelClose} onPointerLeave={scheduleClose} onMouseLeave={scheduleClose}>
      <AdvisorReasoningSlider selection={selected} directory={props.directory} pending={pending} locked={locked} update={update} t={t} />
    </div>, document.body)}
  </>
}
export interface AdvisorPaneProps extends AdvisorInjected {
  locked: boolean
  reportFailure: (message: string) => void
  t: Translate
  api?: AdvisorApi
}

export function AdvisorModelPane(props: AdvisorPaneProps): React.JSX.Element | null {
  const { sessionId, locked, reportFailure, t } = props
  const api = props.api ?? advisorApi
  const { state, pending, update } = useAdvisorState(sessionId, api, reportFailure, t)
  const [query, setQuery] = useState('')
  const directory = useSyncExternalStore((cb) => props.directory.subscribe(cb), () => props.directory.getSnapshot())
  useEffect(() => { props.load() }, [props.load])
  if (state === null || state.sessionId !== sessionId) return null
  const selection = state.selection
  const normalizedQuery = query.trim().toLowerCase()
  const visibleGroups = directory.groups.map((group) => ({ ...group, models: group.models.filter((model: CatalogModel) => normalizedQuery === '' || `${group.name} ${model.name} ${model.id}`.toLowerCase().includes(normalizedQuery)) })).filter((group) => group.models.length > 0)
  return <div className="dshadv-pane">
    <div className="dsh-claude-model-search dshadv-search-wrap">
      <div className="dsh-claude-model-search-field">
        <input className="dsh-claude-model-search-input dshadv-search" type="search" value={query} placeholder={t('search')} aria-label={t('search')} onChange={(event) => setQuery(event.target.value)} />
      </div>
    </div>
    {directory.status === 'loading' && <p>{t('loading')}</p>}
    {visibleGroups.length === 0 && directory.status !== 'loading' && <p>{t('empty')}</p>}
    <div className="dshadv-list dsh-claude-model-sub-body">
      {visibleGroups.map((group: ProviderGroup) => <section key={group.id} className="dsh-claude-model-group-section">
        <div className="dsh-claude-model-rule dshadv-group"><span className="dsh-claude-model-rule-name">{group.name}</span></div>
        {group.models.map((model: CatalogModel) => {
          const checked = selection?.provider === group.id && selection?.model === model.id
          return <button key={model.id} type="button" role="menuitemradio" aria-label={`${group.name}: ${model.name}`} aria-checked={checked} className="dshadv-choice dsh-claude-popover-item dsh-claude-model-option" disabled={locked || pending} onClick={() => update({ selection: { provider: group.id, model: model.id, reasoningEffort: model.reasoning?.defaultEffort } })}>
            <span className="dsh-claude-model-name dshadv-choice-label">{model.name}</span>{checked && <span className="dsh-claude-popover-check" aria-label={t('enabled')}>✓</span>}
          </button>
        })}
      </section>)}
    </div>

  </div>
}