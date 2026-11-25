/**
 * Magpie-inspired subscription hub overview:
 * - Model-aware search and multi-select batch mode (hosted in the section header or inline)
 * - Rounded card container for enabled providers (logo doubles as drag handle + right-click sort menu)
 * - Collapsible "Turned off" group (auto-expanded while searching)
 * - Inline bottom "+ Add provider" unroll sheet grouping all 17 lines by category
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent } from 'react'
import { ROUTE_PREFIX } from '../../compat.ts'
import type { HubProviderSummaryDto } from '../../shared/hub-contracts.ts'
import type { ProxyMode } from '../../shared/contracts.ts'
import { formatPoolLabel } from '../common/account-pool-labels.ts'
import { fetchLineProxySnapshot, savePreferences, type LineProxySnapshot } from '../common/LineProxySection.tsx'
import { HubAddSheet } from './HubAddSheet.tsx'
import {
  fetchOverview,
  HUB_ADDED_PROVIDERS_STORAGE_KEY,
  HUB_HIDDEN_PROVIDERS_STORAGE_KEY,
  HUB_PROVIDER_ORDER_STORAGE_KEY,
  isProviderInMainList,
  matchProviderQuery,
  moveBeforeTarget,
  moveProviderToIndex,
  orderedProviders,
  readCachedProxySnapshot,
  readCachedSummaries,
  readIdSet,
  saveCachedProxySnapshot,
  saveCachedSummaries,
  saveIdSet,
  saveProviderOrder,
} from './hub-overview-helpers.ts'
import { cardAnnotation, HubProviderRow, type HubTranslate } from './HubProviderRow.tsx'
import { hubCardName, type HubProviderDescriptor } from './providers.tsx'

export { cardAnnotation, HUB_PROVIDER_ORDER_STORAGE_KEY, HUB_ADDED_PROVIDERS_STORAGE_KEY, HUB_HIDDEN_PROVIDERS_STORAGE_KEY }
export type { HubTranslate }

export interface HubToolbarMeta {
  hasMainList: boolean
  canSelect: boolean
}

interface Props {
  t: HubTranslate
  onOpen(id: HubProviderDescriptor['id']): void
  query?: string
  onQueryChange?(query: string): void
  selecting?: boolean
  onSelectingChange?(selecting: boolean): void
  hideToolbar?: boolean
  onToolbarMetaChange?(meta: HubToolbarMeta): void
}

interface ContextMenuState {
  id: HubProviderDescriptor['id']
  x: number
  y: number
}

const FOLD_SVG = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>'
const PLUS_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>'

export function HubOverview({
  t,
  onOpen,
  query: controlledQuery,
  onQueryChange,
  selecting: controlledSelecting,
  onSelectingChange,
  hideToolbar = false,
  onToolbarMetaChange,
}: Props): React.JSX.Element {
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

  const [uncontrolledQuery, setUncontrolledQuery] = useState('')
  const query = controlledQuery ?? uncontrolledQuery
  const setQuery = useCallback((next: string): void => {
    if (onQueryChange !== undefined) onQueryChange(next)
    else setUncontrolledQuery(next)
  }, [onQueryChange])

  const [offFolded, setOffFolded] = useState(true)
  const [addedIds, setAddedIds] = useState<Set<string>>(() => readIdSet(HUB_ADDED_PROVIDERS_STORAGE_KEY))
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => readIdSet(HUB_HIDDEN_PROVIDERS_STORAGE_KEY))

  const [addSheetOpen, setAddSheetOpen] = useState(false)
  const [justAddedId, setJustAddedId] = useState<string | null>(null)
  const overviewRef = useRef<HTMLDivElement | null>(null)
  const [addSheetQuery, setAddSheetQuery] = useState('')
  const addBtnRef = useRef<HTMLButtonElement | null>(null)

  const [uncontrolledSelecting, setUncontrolledSelecting] = useState(false)
  const selecting = controlledSelecting ?? uncontrolledSelecting
  const setSelecting = useCallback((next: boolean): void => {
    if (onSelectingChange !== undefined) onSelectingChange(next)
    else setUncontrolledSelecting(next)
  }, [onSelectingChange])

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [lastPickedId, setLastPickedId] = useState<string | null>(null)
  const [batchBusy, setBatchBusy] = useState(false)

  const [menu, setMenu] = useState<ContextMenuState | null>(null)

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
      // Proxy controls stay disabled when /proxy is unavailable.
    }
  }, [])

  useEffect(() => {
    void load()
    void loadProxy()
  }, [load, loadProxy])

  useEffect(() => {
    if (menu === null) return
    const close = (): void => setMenu(null)
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

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
    setSummaries((current) => {
      const next = new Map(current)
      next.set(descriptor.id, { ...summary, enabled })
      return next
    })
    if (enabled) {
      setAddedIds((prev) => {
        if (prev.has(descriptor.id)) return prev
        const next = new Set(prev)
        next.add(descriptor.id)
        saveIdSet(HUB_ADDED_PROVIDERS_STORAGE_KEY, next)
        return next
      })
      setHiddenIds((prev) => {
        if (!prev.has(descriptor.id)) return prev
        const next = new Set(prev)
        next.delete(descriptor.id)
        saveIdSet(HUB_HIDDEN_PROVIDERS_STORAGE_KEY, next)
        return next
      })
    } else {
      // Switching off keeps the row in "Turned off" so the user can turn it back on.
      setAddedIds((prev) => {
        if (prev.has(descriptor.id)) return prev
        const next = new Set(prev)
        next.add(descriptor.id)
        saveIdSet(HUB_ADDED_PROVIDERS_STORAGE_KEY, next)
        return next
      })
    }
    try {
      await descriptor.setEnabled(enabled)
      void load()
    } catch (error) {
      setSummaries((current) => {
        const next = new Map(current)
        next.set(descriptor.id, { ...summary, enabled: summary.enabled })
        return next
      })
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
        lineProxies: { [line]: { mode, customProxyUrl: mode === 'custom' ? customProxyUrl : null } },
      })
      await loadProxy()
    } catch (error) {
      setCardErrors((current) => new Map(current).set(descriptor.id, error instanceof Error ? error.message : String(error)))
    } finally {
      setProxyBusyId(null)
    }
  }, [clearCardError, loadProxy, onOpen, proxyBusyId, proxySnapshot, t])

  const reorder = useCallback((sourceId: string, targetId: string): void => {
    setProviders((current) => {
      const next = moveBeforeTarget(current, sourceId, targetId)
      saveProviderOrder(next)
      return next
    })
  }, [])

  const moveBy = useCallback((id: string, offset: number): void => {
    setProviders((current) => {
      const index = current.findIndex((provider) => provider.id === id)
      if (index < 0) return current
      const next = moveProviderToIndex(current, id, index + offset)
      saveProviderOrder(next)
      return next
    })
  }, [])

  const moveEdge = useCallback((id: string, edge: 'top' | 'bottom'): void => {
    setProviders((current) => {
      const next = moveProviderToIndex(current, id, edge === 'top' ? 0 : current.length - 1)
      saveProviderOrder(next)
      return next
    })
  }, [])

  const finishDrag = useCallback((): void => {
    setDraggedId(null)
    setDropTargetId(null)
  }, [])

  const tAny = t as (key: string) => string
  const searching = query.trim().length > 0

  const { mainList, onRows, offRows, totalOffCount } = useMemo(() => {
    if (summaries === null) {
      return { mainList: [] as HubProviderDescriptor[], onRows: [] as Array<{ descriptor: HubProviderDescriptor; matchedModels: string[] }>, offRows: [] as Array<{ descriptor: HubProviderDescriptor; matchedModels: string[] }>, totalOffCount: 0 }
    }
    const visibleMain = providers.filter((descriptor) =>
      isProviderInMainList(descriptor, summaries.get(descriptor.id), addedIds, hiddenIds),
    )
    const on: Array<{ descriptor: HubProviderDescriptor; matchedModels: string[] }> = []
    const off: Array<{ descriptor: HubProviderDescriptor; matchedModels: string[] }> = []
    let allOff = 0
    for (const descriptor of visibleMain) {
      const summary = summaries.get(descriptor.id)
      const isOff = summary !== undefined && summary.canToggle && !summary.enabled
      if (isOff) allOff += 1
      const match = matchProviderQuery(descriptor, summary, query, tAny)
      if (!match.matched) continue
      if (isOff) off.push({ descriptor, matchedModels: match.matchedModels })
      else on.push({ descriptor, matchedModels: match.matchedModels })
    }
    return { mainList: visibleMain, onRows: on, offRows: off, totalOffCount: allOff }
  }, [providers, summaries, addedIds, hiddenIds, query, tAny])

  const shownIds = useMemo(() => {
    const ids = onRows.map((entry) => entry.descriptor.id)
    if (searching || !offFolded) {
      for (const entry of offRows) ids.push(entry.descriptor.id)
    }
    return ids
  }, [onRows, offRows, searching, offFolded])

  const handlePick = useCallback((id: HubProviderDescriptor['id'], checked: boolean, shiftKey: boolean): void => {
    setSelectedIds((current) => {
      const next = new Set(current)
      const targetIdx = shownIds.indexOf(id)
      const lastIdx = shiftKey && lastPickedId !== null ? shownIds.indexOf(lastPickedId as HubProviderDescriptor['id']) : -1
      const range = targetIdx >= 0 && lastIdx >= 0
        ? shownIds.slice(Math.min(targetIdx, lastIdx), Math.max(targetIdx, lastIdx) + 1)
        : [id]
      for (const itemId of range) {
        if (checked) next.add(itemId)
        else next.delete(itemId)
      }
      return next
    })
    setLastPickedId(id)
  }, [shownIds, lastPickedId])

  const endSelecting = useCallback((): void => {
    setSelecting(false)
    setSelectedIds(new Set())
    setLastPickedId(null)
  }, [setSelecting])

  const applyBatchToggle = useCallback(async (enabled: boolean): Promise<void> => {
    if (summaries === null || selectedIds.size === 0) return
    setBatchBusy(true)
    try {
      const targets = providers.filter((descriptor) => selectedIds.has(descriptor.id) && descriptor.setEnabled !== null)
      await Promise.allSettled(targets.map(async (descriptor) => {
        const current = summaries.get(descriptor.id)
        if (current === undefined || current.enabled === enabled) return
        await descriptor.setEnabled!(enabled)
      }))
      await load()
      endSelecting()
    } finally {
      setBatchBusy(false)
    }
  }, [providers, summaries, selectedIds, load, endSelecting])

  const applyBatchHide = useCallback((): void => {
    if (selectedIds.size === 0) return
    setHiddenIds((prev) => {
      const next = new Set(prev)
      for (const id of selectedIds) next.add(id)
      saveIdSet(HUB_HIDDEN_PROVIDERS_STORAGE_KEY, next)
      return next
    })
    setAddedIds((prev) => {
      const next = new Set(prev)
      for (const id of selectedIds) next.delete(id)
      saveIdSet(HUB_ADDED_PROVIDERS_STORAGE_KEY, next)
      return next
    })
    endSelecting()
  }, [selectedIds, endSelecting])

  const handleSelectFromAddSheet = useCallback((descriptor: HubProviderDescriptor): void => {
    setAddedIds((prev) => {
      const next = new Set(prev)
      next.add(descriptor.id)
      saveIdSet(HUB_ADDED_PROVIDERS_STORAGE_KEY, next)
      return next
    })
    setHiddenIds((prev) => {
      if (!prev.has(descriptor.id)) return prev
      const next = new Set(prev)
      next.delete(descriptor.id)
      saveIdSet(HUB_HIDDEN_PROVIDERS_STORAGE_KEY, next)
      return next
    })
    setAddSheetOpen(false)
    setAddSheetQuery('')
    // Adding only puts the line on the overview; a line that is switched off
    // lands in "Turned off", so unfold it to show where the pick went.
    const summary = summaries?.get(descriptor.id)
    if (summary !== undefined && summary.canToggle && !summary.enabled) setOffFolded(false)
    setJustAddedId(descriptor.id)
  }, [summaries])

  useEffect(() => {
    if (justAddedId === null) return
    const row = overviewRef.current?.querySelector<HTMLElement>(`.dsh-hub-card[data-id="${justAddedId}"]`)
    row?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' })
    setJustAddedId(null)
  }, [justAddedId])

  const handleCloseAddSheet = useCallback((): void => {
    setAddSheetOpen(false)
    setAddSheetQuery('')
    addBtnRef.current?.focus?.()
  }, [])

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape' && query) {
      event.preventDefault()
      event.stopPropagation()
      setQuery('')
    }
  }

  const handleRowContextMenu = useCallback((descriptor: HubProviderDescriptor, event: MouseEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setMenu({ id: descriptor.id, x: event.clientX, y: event.clientY })
  }, [])

  const hasMainList = mainList.length > 0
  const canSelect = mainList.length >= 2
  const showAddSheet = summaries !== null && (addSheetOpen || !hasMainList)
  const offExpanded = searching || !offFolded
  const displayedOffCount = searching ? offRows.length : totalOffCount

  useEffect(() => {
    onToolbarMetaChange?.({ hasMainList, canSelect })
  }, [onToolbarMetaChange, hasMainList, canSelect])

  const renderRow = (descriptor: HubProviderDescriptor, matchedModels: readonly string[]): React.JSX.Element => {
    const summary = summaries?.get(descriptor.id)
    return <HubProviderRow
      key={descriptor.id}
      descriptor={descriptor}
      summary={summary}
      busy={busyId === descriptor.id}
      proxySnapshot={proxySnapshot}
      proxyBusy={proxyBusyId !== null}
      proxyLoadError={proxyLoadError}
      cardError={cardErrors.get(descriptor.id) ?? null}
      matchedModels={matchedModels}
      selecting={selecting}
      selected={selectedIds.has(descriptor.id)}
      dragging={draggedId === descriptor.id}
      dropTarget={draggedId !== null && draggedId !== descriptor.id && dropTargetId === descriptor.id}
      t={t}
      onOpen={onOpen}
      onToggle={toggle}
      onProxyMode={changeProxyMode}
      onPick={handlePick}
      onContextMenu={handleRowContextMenu}
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
      onMoveEdge={moveEdge}
    />
  }

  const menuOnIndex = menu === null ? -1 : onRows.findIndex((entry) => entry.descriptor.id === menu.id)

  return <div ref={overviewRef} className="dsh-hub-overview">
    {loadError !== null && summaries === null ? (
      <p className="dsh-codex-error" role="alert">
        {loadError}{' '}
        <button type="button" className="dsh-codex-button dsh-codex-button-secondary" onClick={() => void load()}>
          {t('retry')}
        </button>
      </p>
    ) : summaries === null ? (
      <div className="dsh-hub-list" aria-busy="true">
        {providers.slice(0, 5).map((provider) => (
          <div key={provider.id} className="dsh-hub-skeleton" aria-hidden="true">
            <i />
            <span className="dsh-hub-who">
              <span className="dsh-hub-skel-name" />
              <span className="dsh-hub-skel-note" />
            </span>
          </div>
        ))}
      </div>
    ) : (
      <>
        {!hideToolbar && hasMainList ? (
          <div className="dsh-hub-toolbar">
            <input
              type="search"
              className="dsh-hub-search"
              value={query}
              placeholder={t('hubSearchPlaceholder')}
              aria-label={t('hubSearchPlaceholder')}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={handleSearchKeyDown}
            />
            {canSelect && !selecting ? (
              <button type="button" className="dsh-hub-tool-btn" onClick={() => setSelecting(true)}>
                {t('hubSelectMode')}
              </button>
            ) : null}
          </div>
        ) : null}

        {selecting ? (
          <div className="dsh-hub-sel-bar" role="region" aria-label={t('hubSelectMode')}>
            <span className="dsh-hub-sel-count">
              {formatPoolLabel(t('hubSelectCount'), { count: selectedIds.size })}
            </span>
            <button
              type="button"
              className="dsh-hub-tool-btn"
              disabled={batchBusy}
              onClick={() => setSelectedIds(new Set(shownIds))}
            >
              {t('hubSelectAll')}
            </button>
            <button
              type="button"
              className="dsh-hub-tool-btn"
              disabled={batchBusy || selectedIds.size === 0}
              onClick={() => void applyBatchToggle(true)}
            >
              {t('hubBatchEnable')}
            </button>
            <button
              type="button"
              className="dsh-hub-tool-btn"
              disabled={batchBusy || selectedIds.size === 0}
              onClick={() => void applyBatchToggle(false)}
            >
              {t('hubBatchDisable')}
            </button>
            <button
              type="button"
              className="dsh-hub-tool-btn"
              disabled={batchBusy || selectedIds.size === 0}
              onClick={applyBatchHide}
            >
              {t('hubBatchHide')}
            </button>
            <button type="button" className="dsh-hub-tool-btn" disabled={batchBusy} onClick={endSelecting}>
              {t('hubDone')}
            </button>
          </div>
        ) : null}

        {searching && onRows.length === 0 && offRows.length === 0 ? (
          <p className="dsh-hub-empty" role="status">
            {formatPoolLabel(t('hubNoMatches'), { query: query.trim() })}
          </p>
        ) : null}

        {onRows.length > 0 ? (
          <div className="dsh-hub-list dsh-hub-cards" data-group="enabled">
            {onRows.map(({ descriptor, matchedModels }) => renderRow(descriptor, matchedModels))}
          </div>
        ) : null}

        {displayedOffCount > 0 ? (
          <>
            <div className="dsh-hub-off-head">
              <button
                type="button"
                className="dsh-hub-fold"
                aria-expanded={offExpanded}
                disabled={searching}
                onClick={() => setOffFolded((folded) => !folded)}
              >
                <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: FOLD_SVG }} />
                <span>{t('hubTurnedOff')}</span>
                <span className="dsh-hub-fold-count">{displayedOffCount}</span>
              </button>
            </div>
            {offExpanded && offRows.length > 0 ? (
              <div className="dsh-hub-list dsh-hub-cards" data-group="disabled">
                {offRows.map(({ descriptor, matchedModels }) => renderRow(descriptor, matchedModels))}
              </div>
            ) : null}
          </>
        ) : null}

        {!showAddSheet ? (
          <div className="dsh-hub-after-list">
            <button
              ref={addBtnRef}
              type="button"
              className="dsh-hub-add-btn"
              onClick={() => {
                setAddSheetOpen(true)
                setAddSheetQuery('')
              }}
            >
              <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: PLUS_SVG }} />
              <span>{t('hubAddProvider')}</span>
            </button>
          </div>
        ) : (
          <HubAddSheet
            t={t}
            summaries={summaries}
            hasExistingProviders={hasMainList}
            query={addSheetQuery}
            onQueryChange={setAddSheetQuery}
            onSelect={handleSelectFromAddSheet}
            onClose={handleCloseAddSheet}
          />
        )}
      </>
    )}

    {menu !== null ? (
      <div
        className="dsh-hub-menu"
        role="menu"
        style={{ left: menu.x, top: menu.y }}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          role="menuitem"
          className="dsh-hub-menu-item"
          disabled={menuOnIndex <= 0}
          onClick={() => { moveEdge(menu.id, 'top'); setMenu(null) }}
        >
          {t('hubMenuMoveTop')}
        </button>
        <button
          type="button"
          role="menuitem"
          className="dsh-hub-menu-item"
          disabled={menuOnIndex <= 0}
          onClick={() => { moveBy(menu.id, -1); setMenu(null) }}
        >
          {t('hubMenuMoveUp')}
        </button>
        <button
          type="button"
          role="menuitem"
          className="dsh-hub-menu-item"
          disabled={menuOnIndex < 0 || menuOnIndex >= onRows.length - 1}
          onClick={() => { moveBy(menu.id, 1); setMenu(null) }}
        >
          {t('hubMenuMoveDown')}
        </button>
        <button
          type="button"
          role="menuitem"
          className="dsh-hub-menu-item"
          disabled={menuOnIndex < 0 || menuOnIndex >= onRows.length - 1}
          onClick={() => { moveEdge(menu.id, 'bottom'); setMenu(null) }}
        >
          {t('hubMenuMoveBottom')}
        </button>
      </div>
    ) : null}
  </div>
}
