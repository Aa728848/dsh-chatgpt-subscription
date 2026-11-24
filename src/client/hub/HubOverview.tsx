/**
 * The hub's opening screen: one card per provider line, in the QQ-mail
 * account-picker idiom — a brand tile, the line's name, a one-line annotation
 * (accounts, models, state), and the line's own enable and network controls.
 *
 * Data comes from the host's aggregated read-only overview route, so opening
 * the settings page never touches an upstream service. Card order is a local
 * presentation preference; proxy modes reuse the same per-line preference
 * document as the detail pages, so the two views cannot drift apart.
 */
import { useCallback, useEffect, useState } from 'react'
import type { DragEvent, KeyboardEvent } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { ROUTE_PREFIX } from '../../compat.ts'
import type { ApiEnvelope, ProxyMode } from '../../shared/contracts.ts'
import { HUB_OVERVIEW_PATH } from '../../shared/hub-contracts.ts'
import type { HubOverviewDto, HubProviderSummaryDto } from '../../shared/hub-contracts.ts'
import { formatPoolLabel } from '../common/account-pool-labels.ts'
import {
  fetchLineProxySnapshot,
  savePreferences,
  type LineProxySnapshot,
} from '../common/LineProxySection.tsx'
import type { NS } from '../providers/codex-chatgpt/locales.ts'
import { BrandTile } from './brand-icons.tsx'
import { hubCardName, HUB_PROVIDERS, type HubProviderDescriptor } from './providers.tsx'

export type HubTranslate = PropsLocale<typeof NS>['t']

/** Versioned because the stored value is a bare ordered id array. */
export const HUB_PROVIDER_ORDER_STORAGE_KEY = 'dsh-chatgpt-subscription:hub-provider-order:v1'
const HUB_OVERVIEW_CACHE_STORAGE_KEY = 'dsh-chatgpt-subscription:hub-overview-cache:v1'
const HUB_PROXY_CACHE_STORAGE_KEY = 'dsh-chatgpt-subscription:hub-proxy-cache:v1'

function readCachedSummaries(): ReadonlyMap<string, HubProviderSummaryDto> | null {
  try {
    const raw = globalThis.localStorage?.getItem(HUB_OVERVIEW_CACHE_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return null
    const map = new Map<string, HubProviderSummaryDto>()
    for (const item of parsed) {
      if (item && typeof item === 'object' && typeof (item as HubProviderSummaryDto).id === 'string') {
        map.set((item as HubProviderSummaryDto).id, item as HubProviderSummaryDto)
      }
    }
    return map.size > 0 ? map : null
  } catch {
    return null
  }
}

function saveCachedSummaries(providers: readonly HubProviderSummaryDto[]): void {
  try {
    globalThis.localStorage?.setItem(HUB_OVERVIEW_CACHE_STORAGE_KEY, JSON.stringify(providers))
  } catch {
    // Storage may be unavailable in privacy mode.
  }
}

function readCachedProxySnapshot(): LineProxySnapshot | null {
  try {
    const raw = globalThis.localStorage?.getItem(HUB_PROXY_CACHE_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as LineProxySnapshot
  } catch {
    return null
  }
}

function saveCachedProxySnapshot(snapshot: LineProxySnapshot): void {
  try {
    globalThis.localStorage?.setItem(HUB_PROXY_CACHE_STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    // Storage may be unavailable in privacy mode.
  }
}

interface Props {
  t: HubTranslate
  onOpen(id: HubProviderDescriptor['id']): void
}

async function fetchOverview(): Promise<HubOverviewDto> {
  const response = await fetch(HUB_OVERVIEW_PATH, { credentials: 'same-origin' })
  const envelope = await response.json() as ApiEnvelope<HubOverviewDto>
  if (!response.ok || !envelope.ok) {
    throw new Error(envelope.ok ? `Request failed (${response.status})` : envelope.error.message)
  }
  return envelope.value
}

/**
 * Merge a browser order with the registry. Unknown and duplicate ids disappear;
 * providers introduced after the order was saved append in registry order.
 */
function orderedProviders(): HubProviderDescriptor[] {
  const fallback = [...HUB_PROVIDERS]
  try {
    const raw = globalThis.localStorage?.getItem(HUB_PROVIDER_ORDER_STORAGE_KEY)
    if (raw === null || raw === undefined) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return fallback
    const byId: Map<string, HubProviderDescriptor> = new Map(HUB_PROVIDERS.map((provider) => [provider.id, provider]))
    const seen = new Set<string>()
    const ordered: HubProviderDescriptor[] = []
    for (const id of parsed) {
      if (typeof id !== 'string' || seen.has(id)) continue
      const provider = byId.get(id)
      if (provider === undefined) continue
      seen.add(id)
      ordered.push(provider)
    }
    ordered.push(...HUB_PROVIDERS.filter((provider) => !seen.has(provider.id)))
    return ordered
  } catch {
    // Privacy modes can deny localStorage, and older builds may have left bad
    // JSON. Neither is a reason to take every provider card down with it.
    return fallback
  }
}

function saveProviderOrder(providers: readonly HubProviderDescriptor[]): void {
  try {
    globalThis.localStorage?.setItem(
      HUB_PROVIDER_ORDER_STORAGE_KEY,
      JSON.stringify(providers.map((provider) => provider.id)),
    )
  } catch {
    // The new order still applies for this mount when storage is unavailable.
  }
}

function moveBeforeTarget(
  providers: readonly HubProviderDescriptor[],
  sourceId: string,
  targetId: string,
): HubProviderDescriptor[] {
  const from = providers.findIndex((provider) => provider.id === sourceId)
  const target = providers.findIndex((provider) => provider.id === targetId)
  if (from < 0 || target < 0 || from === target) return [...providers]
  const next = [...providers]
  const [moved] = next.splice(from, 1)
  next.splice(target, 0, moved!)
  return next
}

/** The card's one-line annotation: accounts, then models, then state. */
export function cardAnnotation(summary: HubProviderSummaryDto | undefined, descriptor: HubProviderDescriptor, t: HubTranslate): string {
  if (summary === undefined) return '…'
  if (summary.error === true) return t('hubStatusFailed')
  const parts: string[] = []
  if (summary.canToggle && !summary.enabled) parts.push(t('hubStateDisabled'))
  parts.push(summary.accountCount > 0
    ? formatPoolLabel(t('hubAccountCount'), { count: summary.accountCount })
    : t('hubNoAccounts'))
  if (summary.enabledModelCount !== null) {
    parts.push(summary.totalModelCount !== null
      ? formatPoolLabel(t('hubModelsEnabledOfTotal'), { count: summary.enabledModelCount, total: summary.totalModelCount })
      : formatPoolLabel(t('hubModelsEnabled'), { count: summary.enabledModelCount }))
  }
  return parts.join(' · ')
}

export function HubOverview({ t, onOpen }: Props): React.JSX.Element {
  const [providers, setProviders] = useState<HubProviderDescriptor[]>(orderedProviders)
  const [summaries, setSummaries] = useState<ReadonlyMap<string, HubProviderSummaryDto> | null>(readCachedSummaries)
  const [proxySnapshot, setProxySnapshot] = useState<LineProxySnapshot | null>(readCachedProxySnapshot)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [proxyLoadError, setProxyLoadError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [proxyBusyId, setProxyBusyId] = useState<string | null>(null)
  const [cardErrors, setCardErrors] = useState<ReadonlyMap<string, string>>(new Map())
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const overview = await fetchOverview()
      setSummaries(new Map(overview.providers.map((provider) => [provider.id, provider])))
      saveCachedSummaries(overview.providers)
      setLoadError(null)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const loadProxy = useCallback(async (): Promise<void> => {
    try {
      const snapshot = await fetchLineProxySnapshot(ROUTE_PREFIX)
      setProxySnapshot(snapshot)
      saveCachedProxySnapshot(snapshot)
      setProxyLoadError(null)
    } catch (error) {
      setProxyLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    void load()
    void loadProxy()
  }, [load, loadProxy])

  const clearCardError = useCallback((id: string): void => {
    setCardErrors((current) => {
      if (!current.has(id)) return current
      const next = new Map(current)
      next.delete(id)
      return next
    })
  }, [])

  const toggle = useCallback(async (descriptor: HubProviderDescriptor, summary: HubProviderSummaryDto, enabled: boolean): Promise<void> => {
    if (descriptor.setEnabled === null) return
    setBusyId(descriptor.id)
    clearCardError(descriptor.id)
    // Optimistic: the switch flips now, the commit answers later.
    setSummaries((current) => new Map(current).set(descriptor.id, { ...summary, enabled }))
    try {
      await descriptor.setEnabled(enabled)
      // The commit did not carry the other lines' counts; refresh behind the
      // settled switch so the annotation stays exact.
      void load()
    } catch (error) {
      setSummaries((current) => new Map(current).set(descriptor.id, { ...summary, enabled: summary.enabled }))
      setCardErrors((current) => new Map(current).set(descriptor.id, error instanceof Error ? error.message : String(error)))
    } finally {
      setBusyId(null)
    }
  }, [clearCardError, load])

  const changeProxyMode = useCallback(async (descriptor: HubProviderDescriptor, mode: ProxyMode): Promise<void> => {
    const line = descriptor.proxyLine
    if (line === null || proxyBusyId !== null) return
    const config = proxySnapshot?.lineProxies?.[line]
    const customProxyUrl = config?.customProxyUrl?.trim() ?? ''
    if (mode === 'custom' && customProxyUrl === '') {
      const name = hubCardName(descriptor, t as (key: string) => string)
      globalThis.alert(formatPoolLabel(t('hubCustomProxyMissing'), { name }))
      onOpen(descriptor.id)
      return
    }
    setProxyBusyId(descriptor.id)
    clearCardError(descriptor.id)
    try {
      await savePreferences(ROUTE_PREFIX, {
        lineProxies: {
          [line]: { mode, customProxyUrl: mode === 'custom' ? customProxyUrl : null },
        },
      })
      await loadProxy()
    } catch (error) {
      // The select stays controlled by the last good snapshot, so a rejected
      // mutation never leaves a mode on screen that the host did not save.
      setCardErrors((current) => new Map(current).set(descriptor.id, error instanceof Error ? error.message : String(error)))
    } finally {
      setProxyBusyId(null)
    }
  }, [clearCardError, loadProxy, onOpen, proxyBusyId, proxySnapshot, t])

  const reorder = useCallback((sourceId: string, targetId: string): void => {
    setProviders((current) => {
      if (sourceId === targetId) return current
      const next = moveBeforeTarget(current, sourceId, targetId)
      saveProviderOrder(next)
      return next
    })
  }, [])

  const moveBy = useCallback((sourceId: string, offset: number): void => {
    setProviders((current) => {
      const from = current.findIndex((provider) => provider.id === sourceId)
      const target = from + offset
      if (from < 0 || target < 0 || target >= current.length) return current
      const next = moveBeforeTarget(current, sourceId, current[target]!.id)
      saveProviderOrder(next)
      return next
    })
  }, [])

  const finishDrag = useCallback((): void => {
    setDraggedId(null)
    setDropTargetId(null)
  }, [])

  return <div className="dsh-hub-overview">
    <p className="dsh-hub-hint">{t('hubOverviewHint')}</p>
    {loadError !== null && summaries === null ? (
      <div className="dsh-codex-errorbar" role="alert">
        <span>{loadError}</span>
        <button type="button" className="dsh-codex-button" onClick={() => void load()}>{t('retry')}</button>
      </div>
    ) : (
      <div className="dsh-hub-cards">
        {summaries === null ? providers.map((descriptor) => (
          <div key={descriptor.id} className="dsh-hub-skeleton" aria-hidden="true">
            <i />
            <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <span className="dsh-hub-skel-name" />
              <span className="dsh-hub-skel-note" />
            </span>
          </div>
        )) : providers.map((descriptor) => {
          const summary = summaries.get(descriptor.id)
          return <HubProviderCard
            key={descriptor.id}
            descriptor={descriptor}
            summary={summary}
            busy={busyId === descriptor.id}
            proxySnapshot={proxySnapshot}
            proxyBusy={proxyBusyId !== null}
            proxyLoadError={proxyLoadError}
            cardError={cardErrors.get(descriptor.id) ?? null}
            dragging={draggedId === descriptor.id}
            dropTarget={draggedId !== null && draggedId !== descriptor.id && dropTargetId === descriptor.id}
            t={t}
            onOpen={onOpen}
            onToggle={toggle}
            onProxyMode={changeProxyMode}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('text/plain', descriptor.id)
              setDraggedId(descriptor.id)
            }}
            onDragOver={(event) => {
              if (draggedId === null || draggedId === descriptor.id) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              setDropTargetId(descriptor.id)
            }}
            onDrop={(event) => {
              event.preventDefault()
              event.stopPropagation()
              if (draggedId !== null) reorder(draggedId, descriptor.id)
              finishDrag()
            }}
            onDragEnd={finishDrag}
            onMoveBy={moveBy}
          />
        })}
      </div>
    )}
  </div>
}

const CHEVRON_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>'
const DRAG_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="5" cy="3" r="1.25"/><circle cx="11" cy="3" r="1.25"/><circle cx="5" cy="8" r="1.25"/><circle cx="11" cy="8" r="1.25"/><circle cx="5" cy="13" r="1.25"/><circle cx="11" cy="13" r="1.25"/></svg>'

function HubProviderCard(props: {
  descriptor: HubProviderDescriptor
  summary: HubProviderSummaryDto | undefined
  busy: boolean
  proxySnapshot: LineProxySnapshot | null
  proxyBusy: boolean
  proxyLoadError: string | null
  cardError: string | null
  dragging: boolean
  dropTarget: boolean
  t: HubTranslate
  onOpen(id: HubProviderDescriptor['id']): void
  onToggle(descriptor: HubProviderDescriptor, summary: HubProviderSummaryDto, enabled: boolean): Promise<void>
  onProxyMode(descriptor: HubProviderDescriptor, mode: ProxyMode): Promise<void>
  onDragStart(event: DragEvent<HTMLButtonElement>): void
  onDragOver(event: DragEvent<HTMLDivElement>): void
  onDrop(event: DragEvent<HTMLDivElement>): void
  onDragEnd(): void
  onMoveBy(id: string, offset: number): void
}): React.JSX.Element {
  const { descriptor, summary, t } = props
  const enabled = summary?.enabled ?? true
  const cardName = hubCardName(descriptor, t as (key: string) => string)
  const annotation = props.cardError ?? cardAnnotation(summary, descriptor, t)
  const canToggle = descriptor.setEnabled !== null && (summary?.canToggle ?? true)
  const proxyConfig = descriptor.proxyLine === null
    ? null
    : props.proxySnapshot?.lineProxies?.[descriptor.proxyLine]
  const proxyMode: ProxyMode = proxyConfig?.mode ?? 'auto'

  return <div
    role="button"
    tabIndex={0}
    className="dsh-hub-card"
    data-enabled={enabled}
    data-dragging={props.dragging}
    data-drop-target={props.dropTarget}
    aria-label={formatPoolLabel(t('hubCardLabel'), { name: cardName, annotation })}
    onClick={() => props.onOpen(descriptor.id)}
    onKeyDown={(event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      if (event.target !== event.currentTarget) return
      event.preventDefault()
      props.onOpen(descriptor.id)
    }}
    onDragOver={props.onDragOver}
    onDrop={props.onDrop}
  >
    <button
      type="button"
      className="dsh-hub-drag-handle"
      draggable
      aria-label={formatPoolLabel(t('hubDragProvider'), { name: cardName })}
      title={t('hubDragProviderHint')}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
        event.stopPropagation()
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        event.preventDefault()
        props.onMoveBy(descriptor.id, event.key === 'ArrowUp' ? -1 : 1)
      }}
      onDragStart={(event) => {
        event.stopPropagation()
        props.onDragStart(event)
      }}
      onDragEnd={props.onDragEnd}
      dangerouslySetInnerHTML={{ __html: DRAG_SVG }}
    />
    <BrandTile id={descriptor.id} />
    <span className="dsh-hub-card-copy">
      <span className="dsh-hub-card-name">{cardName}</span>
      <span className={`dsh-hub-card-note${props.cardError !== null || summary?.error === true ? ' dsh-hub-note-danger' : ''}`}>
        {annotation}
      </span>
    </span>
    <span className="dsh-hub-card-side">
      {descriptor.proxyLine !== null ? (
        <select
          className="dsh-hub-proxy-select"
          aria-label={formatPoolLabel(t('hubProxyMode'), { name: cardName })}
          title={props.proxyLoadError ?? t('proxyModeHint')}
          value={proxyMode}
          disabled={props.proxyBusy || props.proxySnapshot === null || summary === undefined}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onChange={(event) => {
            event.stopPropagation()
            void props.onProxyMode(descriptor, event.currentTarget.value as ProxyMode)
          }}
        >
          <option value="auto">{t('hubProxyAuto')}</option>
          <option value="custom">{t('hubProxyCustom')}</option>
          <option value="direct">{t('hubProxyDirect')}</option>
        </select>
      ) : null}
      {canToggle ? (
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={formatPoolLabel(t(enabled ? 'hubSwitchOff' : 'hubSwitchOn'), { name: cardName })}
          className="dsh-hub-switch"
          disabled={props.busy || summary === undefined}
          onClick={(event) => {
            event.stopPropagation()
            if (summary === undefined) return
            void props.onToggle(descriptor, summary, !enabled)
          }}
        />
      ) : null}
      <span className="dsh-hub-chevron" aria-hidden="true" dangerouslySetInnerHTML={{ __html: CHEVRON_SVG }} />
    </span>
  </div>
}
