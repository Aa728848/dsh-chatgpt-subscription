/**
 * The shared "which models appear in the picker" list every provider section
 * renders.
 *
 * When items carry a `group` (vendor) and at least two groups exist, the list
 * switches to a left-vendor + right-model split view with cross-vendor search
 * and per-vendor batch toggle, keeping large catalogs (100+ models) scannable.
 * Single-vendor and ungrouped callers continue to render a compact flat list.
 * A line whose catalog mixes vendors can pass `groupByVendor` instead of
 * resolving groups itself; the split view's copy comes from this component's
 * own locale namespace unless the caller overrides it.
 */
import { useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { BrandMark, modelBrandMark, type ProviderMarkKey } from '../hub/brand-icons.tsx'
import { useLineDict } from './line-locale.ts'
import { modelChecklistZh, NS_MODEL_CHECKLIST } from './model-checklist-labels.ts'
import { modelVendorGroup, type ModelVendorOptions } from './model-vendors.ts'

export interface ModelChecklistGroup {
  key: string
  label: string
  mark?: ProviderMarkKey | null
}

export interface ModelChecklistItem {
  id: string
  name: string
  /** One quiet line under the name (e.g. the context window); omit when none. */
  hint?: string
  enabled: boolean
  /** Optional vendor/category group. Two or more distinct groups activate split view. */
  group?: ModelChecklistGroup
}

export interface ModelChecklistLabels {
  selectAll: string
  clearAll: string
  /**
   * `{count}` and `{total}` are replaced with the enabled/total numbers.
   * Optional: a provider dictionary without the key gets the bare "3/8" form.
   */
  countTemplate?: string
  /** aria-label of the list itself; omit when the section header already names it. */
  list?: string
  /** Label for the "All" tab in split-pane vendor mode. */
  allGroups?: string
  /** Label for the "Enabled" tab in split-pane vendor mode. */
  enabledGroup?: string
  /** Search input placeholder in split-pane vendor mode. */
  searchPlaceholder?: string
  /** Empty-state text when a search matches nothing. */
  noMatches?: string
  /** aria-label for the left vendor tablist in split-pane mode. */
  groupsNav?: string
}

interface Props {
  items: ModelChecklistItem[]
  /** Disables every row and the header buttons while a commit is in flight. */
  busy: boolean
  onToggle(id: string, enabled: boolean): void
  onToggleAll(enabled: boolean): void
  /** Optional batch toggle for the active vendor group in split-pane mode. */
  onToggleGroup?(ids: string[], enabled: boolean): void
  /**
   * Resolve each item's vendor from its id (items that already carry a `group`
   * keep it). Two or more vendors switch the list to the split view, but only
   * once the catalog reaches `minItems` (default 10): a short list reads better flat.
   */
  groupByVendor?: boolean | ModelChecklistGrouping
  labels: ModelChecklistLabels
}

export interface ModelChecklistGrouping extends ModelVendorOptions {
  /** Smallest catalog that gets the split view; default {@link DEFAULT_GROUP_MIN_ITEMS}. */
  minItems?: number
}

export const DEFAULT_GROUP_MIN_ITEMS = 10

interface VendorBucket {
  key: string
  label: string
  mark: ProviderMarkKey | null
  items: ModelChecklistItem[]
  enabledCount: number
}

const ALL_TAB = '__all__'
const ENABLED_TAB = '__enabled__'

const CHECK_SVG = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 5"/></svg>'

function vendorInitial(label: string): string {
  const first = label.trim().charAt(0)
  return first ? first.toUpperCase() : '?'
}

function renderOptionRow(
  item: ModelChecklistItem,
  busy: boolean,
  onToggle: (id: string, enabled: boolean) => void,
): React.JSX.Element {
  const mark = item.group?.mark ?? modelBrandMark(item.id)
  return <button
    key={item.id}
    type="button"
    role="checkbox"
    aria-checked={item.enabled}
    className="dsh-mcl-option"
    data-enabled={item.enabled}
    disabled={busy}
    title={item.id}
    onClick={() => onToggle(item.id, !item.enabled)}
  >
    {mark !== null ? <BrandMark mark={mark} size={18} /> : null}
    <span className="dsh-mcl-copy">
      <span className="dsh-mcl-name">{item.name}</span>
      {item.hint !== undefined ? <span className="dsh-mcl-hint">{item.hint}</span> : null}
    </span>
    <span className="dsh-mcl-check" aria-hidden="true" dangerouslySetInnerHTML={{ __html: item.enabled ? CHECK_SVG : '' }} />
  </button>
}

export function ModelChecklist({ items: rawItems, busy, onToggle, onToggleAll, onToggleGroup, groupByVendor, labels }: Props): React.JSX.Element {
  const copy = useLineDict(NS_MODEL_CHECKLIST, modelChecklistZh)
  const otherLabel = copy.otherGroup
  const minItems = typeof groupByVendor === 'object' ? (groupByVendor.minItems ?? DEFAULT_GROUP_MIN_ITEMS) : DEFAULT_GROUP_MIN_ITEMS
  const grouping = groupByVendor !== undefined && groupByVendor !== false && rawItems.length >= minItems
  // A string key keeps an inline `{ ignorePrefixes: [...] }` literal from
  // re-deriving every group on each parent render.
  const ignoreKey = typeof groupByVendor === 'object' ? (groupByVendor.ignorePrefixes ?? []).join('\n') : ''
  const items = useMemo<ModelChecklistItem[]>(() => {
    if (!grouping) return rawItems
    const options: ModelVendorOptions = ignoreKey === '' ? {} : { ignorePrefixes: ignoreKey.split('\n') }
    return rawItems.map((item) => item.group !== undefined ? item : { ...item, group: modelVendorGroup(item.id, otherLabel, options) })
  }, [rawItems, grouping, ignoreKey, otherLabel])
  const enabledCount = items.filter((item) => item.enabled).length
  const count = (labels.countTemplate ?? '{count}/{total}')
    .replace('{count}', String(enabledCount))
    .replace('{total}', String(items.length))

  const vendors = useMemo<VendorBucket[]>(() => {
    const map = new Map<string, VendorBucket>()
    for (const item of items) {
      if (item.group === undefined) continue
      let bucket = map.get(item.group.key)
      if (bucket === undefined) {
        bucket = {
          key: item.group.key,
          label: item.group.label,
          mark: item.group.mark ?? null,
          items: [],
          enabledCount: 0,
        }
        map.set(item.group.key, bucket)
      }
      bucket.items.push(item)
      if (item.enabled) bucket.enabledCount += 1
    }
    // The catch-all bucket goes last so named vendors lead the column.
    const buckets = [...map.values()]
    return [...buckets.filter((b) => b.key !== 'other'), ...buckets.filter((b) => b.key === 'other')]
  }, [items])

  const splitMode = vendors.length >= 2
  const [selectedTab, setSelectedTab] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const activeTab = useMemo(() => {
    if (!splitMode) return ALL_TAB
    if (selectedTab === ALL_TAB) return ALL_TAB
    if (selectedTab === ENABLED_TAB && enabledCount > 0) return ENABLED_TAB
    if (selectedTab !== null && vendors.some((v) => v.key === selectedTab)) return selectedTab
    return vendors[0]!.key
  }, [splitMode, selectedTab, enabledCount, vendors])

  const trimmedQuery = query.trim().toLowerCase()
  const searching = splitMode && trimmedQuery.length > 0

  const activeVendor = useMemo(
    () => (activeTab === ALL_TAB || activeTab === ENABLED_TAB ? null : vendors.find((v) => v.key === activeTab) ?? null),
    [activeTab, vendors],
  )

  const visibleItems = useMemo(() => {
    if (!splitMode) return items
    if (searching) {
      const words = trimmedQuery.split(/\s+/).filter(Boolean)
      return items.filter((item) => {
        const hay = `${item.name} ${item.id} ${item.group?.label ?? ''} ${item.hint ?? ''}`.toLowerCase()
        return words.every((word) => hay.includes(word))
      })
    }
    if (activeTab === ALL_TAB) return items
    if (activeTab === ENABLED_TAB) return items.filter((item) => item.enabled)
    return activeVendor?.items ?? items
  }, [splitMode, searching, trimmedQuery, activeTab, activeVendor, items])

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape' && query) {
      event.preventDefault()
      event.stopPropagation()
      setQuery('')
    }
  }

  if (!splitMode) {
    return <div className="dsh-mcl">
      <div className="dsh-mcl-head">
        <span className="dsh-mcl-count">{count}</span>
        <span className="dsh-mcl-head-actions">
          <button type="button" className="dsh-mcl-action" disabled={busy || enabledCount === items.length} onClick={() => onToggleAll(true)}>{labels.selectAll}</button>
          <button type="button" className="dsh-mcl-action" disabled={busy} onClick={() => onToggleAll(false)}>{labels.clearAll}</button>
        </span>
      </div>
      <div className="dsh-mcl-list" role="group" aria-label={labels.list}>
        {items.map((item) => renderOptionRow(item, busy, onToggle))}
      </div>
    </div>
  }

  const allLabel = labels.allGroups ?? copy.allGroups
  const enabledLabel = labels.enabledGroup ?? copy.enabledGroup
  const paneTitle = searching
    ? `${visibleItems.length}/${items.length}`
    : activeTab === ALL_TAB
      ? allLabel
      : activeTab === ENABLED_TAB
        ? enabledLabel
        : activeVendor?.label ?? allLabel
  const paneEnabledCount = visibleItems.filter((item) => item.enabled).length
  const showGroupActions = onToggleGroup !== undefined && !searching && activeVendor !== null && activeVendor.items.length > 0

  return <div className="dsh-mcl dsh-mcl-is-split">
    <div className="dsh-mcl-head">
      <span className="dsh-mcl-count">{count}</span>
      <input
        type="search"
        className="dsh-mcl-search"
        value={query}
        placeholder={labels.searchPlaceholder ?? copy.searchPlaceholder}
        aria-label={labels.searchPlaceholder ?? copy.searchPlaceholder}
        onChange={(event) => setQuery(event.currentTarget.value)}
        onKeyDown={handleSearchKeyDown}
      />
      <span className="dsh-mcl-head-actions">
        <button type="button" className="dsh-mcl-action" disabled={busy || enabledCount === items.length} onClick={() => onToggleAll(true)}>{labels.selectAll}</button>
        <button type="button" className="dsh-mcl-action" disabled={busy} onClick={() => onToggleAll(false)}>{labels.clearAll}</button>
      </span>
    </div>

    <div className="dsh-mcl-split">
      <div className="dsh-mcl-vendors" role="tablist" aria-orientation="vertical" aria-label={labels.groupsNav ?? copy.groupsNav}>
        <button
          type="button"
          role="tab"
          className="dsh-mcl-vendor"
          aria-selected={!searching && activeTab === ALL_TAB}
          onClick={() => { setQuery(''); setSelectedTab(ALL_TAB) }}
        >
          <span className="dsh-mcl-vendor-name">{allLabel}</span>
          <span className="dsh-mcl-vendor-count" data-has-enabled={enabledCount > 0}>{enabledCount}/{items.length}</span>
        </button>
        {enabledCount > 0 ? (
          <button
            type="button"
            role="tab"
            className="dsh-mcl-vendor"
            aria-selected={!searching && activeTab === ENABLED_TAB}
            onClick={() => { setQuery(''); setSelectedTab(ENABLED_TAB) }}
          >
            <span className="dsh-mcl-vendor-name">{enabledLabel}</span>
            <span className="dsh-mcl-vendor-count" data-has-enabled="true">{enabledCount}</span>
          </button>
        ) : null}
        <div className="dsh-mcl-vendor-sep" role="separator" />
        {vendors.map((vendor) => (
          <button
            key={vendor.key}
            type="button"
            role="tab"
            className="dsh-mcl-vendor"
            data-vendor={vendor.key}
            aria-selected={!searching && activeTab === vendor.key}
            onClick={() => { setQuery(''); setSelectedTab(vendor.key) }}
          >
            {vendor.mark !== null
              ? <BrandMark mark={vendor.mark} size={14} />
              : <span className="dsh-mcl-vendor-mono" aria-hidden="true">{vendorInitial(vendor.label)}</span>}
            <span className="dsh-mcl-vendor-name">{vendor.label}</span>
            <span className="dsh-mcl-vendor-count" data-has-enabled={vendor.enabledCount > 0}>
              {vendor.enabledCount > 0 ? `${vendor.enabledCount}/${vendor.items.length}` : vendor.items.length}
            </span>
          </button>
        ))}
      </div>

      <div className="dsh-mcl-pane">
        <div className="dsh-mcl-pane-head">
          <span className="dsh-mcl-pane-title">
            {paneTitle}
            {!searching ? <span className="dsh-mcl-pane-sub">{paneEnabledCount}/{visibleItems.length}</span> : null}
          </span>
          {showGroupActions ? (
            <span className="dsh-mcl-head-actions">
              <button
                type="button"
                className="dsh-mcl-action"
                disabled={busy || activeVendor.enabledCount === activeVendor.items.length}
                onClick={() => onToggleGroup(activeVendor.items.map((item) => item.id), true)}
              >
                {labels.selectAll}
              </button>
              <button
                type="button"
                className="dsh-mcl-action"
                disabled={busy || activeVendor.enabledCount === 0}
                onClick={() => onToggleGroup(activeVendor.items.map((item) => item.id), false)}
              >
                {labels.clearAll}
              </button>
            </span>
          ) : null}
        </div>

        <div className="dsh-mcl-pane-body">
          {visibleItems.length === 0 ? (
            <p className="dsh-mcl-empty" role="status">{labels.noMatches ?? copy.noMatches}</p>
          ) : (
            <div className="dsh-mcl-list" role="group" aria-label={labels.list}>
              {visibleItems.map((item) => renderOptionRow(item, busy, onToggle))}
            </div>
          )}
        </div>
      </div>
    </div>
  </div>
}
