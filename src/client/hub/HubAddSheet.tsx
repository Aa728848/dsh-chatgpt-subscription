import { useEffect, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { HubProviderSummaryDto } from '../../shared/hub-contracts.ts'
import type { NS } from '../providers/codex-chatgpt/locales.ts'
import { formatPoolLabel } from '../common/account-pool-labels.ts'
import { BrandTile } from './brand-icons.tsx'
import { HUB_ADD_SHEET_GROUPS } from './hub-overview-helpers.ts'
import { hubCardName, HUB_PROVIDERS, type HubProviderDescriptor } from './providers.tsx'

type HubTranslate = PropsLocale<typeof NS>['t']

interface HubAddSheetProps {
  t: HubTranslate
  summaries: ReadonlyMap<string, HubProviderSummaryDto> | null
  hasExistingProviders: boolean
  query: string
  onQueryChange(value: string): void
  onSelect(descriptor: HubProviderDescriptor): void
  onClose(): void
}

export function HubAddSheet({
  t,
  summaries,
  hasExistingProviders,
  query,
  onQueryChange,
  onSelect,
  onClose,
}: HubAddSheetProps): React.JSX.Element {
  const sheetRef = useRef<HTMLElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    sheetRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' })
  }, [])

  const trimmed = query.trim().toLowerCase()
  const tAny = t as (key: string) => string

  const groups = HUB_ADD_SHEET_GROUPS.map((group) => {
    const items = HUB_PROVIDERS.filter((provider) => {
      if (provider.category !== group.category) return false
      if (!trimmed) return true
      const name = hubCardName(provider, tAny).toLowerCase()
      return name.includes(trimmed) || provider.name.toLowerCase().includes(trimmed) || provider.id.includes(trimmed)
    })
    return { ...group, items }
  }).filter((group) => group.items.length > 0)

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    if (query) {
      onQueryChange('')
    } else if (hasExistingProviders) {
      onClose()
    }
  }

  return <section ref={sheetRef} className="dsh-hub-sheet" aria-label={t('hubAddSheetTitle')}>
    <div className="dsh-hub-sheet-head">
      <span className="dsh-hub-sheet-title">
        {t(hasExistingProviders ? 'hubAddSheetTitle' : 'hubAddSheetFirstTitle')}
      </span>
      <input
        ref={searchRef}
        type="search"
        className="dsh-hub-search"
        value={query}
        placeholder={t('hubAddSheetSearch')}
        aria-label={t('hubAddSheetSearch')}
        onChange={(event) => onQueryChange(event.currentTarget.value)}
        onKeyDown={handleSearchKeyDown}
      />
      {hasExistingProviders ? (
        <button type="button" className="dsh-hub-tool-btn" onClick={onClose}>
          {t('hubClose')}
        </button>
      ) : null}
    </div>
    {groups.length === 0 ? (
      <p className="dsh-hub-empty" role="status">
        {formatPoolLabel(t('hubNoMatches'), { query: query.trim() })}
      </p>
    ) : groups.map((group) => (
      <div key={group.category}>
        <div className="dsh-hub-sheet-kind">
          <b>{t(group.titleKey)}</b>
          <span>{t(group.hintKey)}</span>
        </div>
        <div className="dsh-hub-sheet-grid">
          {group.items.map((descriptor) => {
            const summary = summaries?.get(descriptor.id)
            const name = hubCardName(descriptor, tAny)
            const hasAccount = summary !== undefined && (summary.authenticated || summary.accountCount > 0)
            return <button
              key={descriptor.id}
              type="button"
              className="dsh-hub-tile"
              data-pick={descriptor.id}
              onClick={() => onSelect(descriptor)}
            >
              <BrandTile id={descriptor.id} size={24} />
              <span className="dsh-hub-tile-name">{name}</span>
              {hasAccount ? <span className="dsh-hub-tile-have" aria-hidden="true" /> : null}
              {summary && summary.accountCount > 1 ? (
                <span className="dsh-hub-tile-cnt">{summary.accountCount}</span>
              ) : null}
            </button>
          })}
        </div>
      </div>
    ))}
  </section>
}
