/**
 * The hub's opening screen: one card per provider line, in the QQ-mail
 * account-picker idiom — a brand tile, the line's name, a one-line annotation
 * (accounts, models, state), and exactly two interactions per card: the
 * enable switch and drilling into the line's detail page.
 *
 * Data comes from the host's aggregated read-only overview route, so opening
 * the settings page costs one request and never touches an upstream service.
 * Switch commits go to each line's own settings endpoint (see providers.tsx)
 * and update optimistically; a failed commit rolls the switch back and says
 * so in the card's annotation line, where the user is already looking.
 */
import { useCallback, useEffect, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ApiEnvelope } from '../../shared/contracts.ts'
import { HUB_OVERVIEW_PATH } from '../../shared/hub-contracts.ts'
import type { HubOverviewDto, HubProviderSummaryDto } from '../../shared/hub-contracts.ts'
import { formatPoolLabel } from '../common/account-pool-labels.ts'
import type { NS } from '../locales.ts'
import { BrandTile } from './brand-icons.tsx'
import { HUB_PROVIDERS, type HubProviderDescriptor } from './providers.tsx'

export type HubTranslate = PropsLocale<typeof NS>['t']

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
  const [summaries, setSummaries] = useState<ReadonlyMap<string, HubProviderSummaryDto> | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [toggleErrors, setToggleErrors] = useState<ReadonlyMap<string, string>>(new Map())

  const load = useCallback(async (): Promise<void> => {
    try {
      const overview = await fetchOverview()
      setSummaries(new Map(overview.providers.map((provider) => [provider.id, provider])))
      setLoadError(null)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = useCallback(async (descriptor: HubProviderDescriptor, summary: HubProviderSummaryDto, enabled: boolean): Promise<void> => {
    if (descriptor.setEnabled === null) return
    setBusyId(descriptor.id)
    setToggleErrors((current) => {
      if (!current.has(descriptor.id)) return current
      const next = new Map(current)
      next.delete(descriptor.id)
      return next
    })
    // Optimistic: the switch flips now, the commit answers later.
    setSummaries((current) => new Map(current).set(descriptor.id, { ...summary, enabled }))
    try {
      await descriptor.setEnabled(enabled)
      // The commit did not carry the other lines' counts; refresh behind the
      // settled switch so the annotation stays exact.
      void load()
    } catch (error) {
      setSummaries((current) => new Map(current).set(descriptor.id, { ...summary, enabled: summary.enabled }))
      setToggleErrors((current) => new Map(current).set(descriptor.id, error instanceof Error ? error.message : String(error)))
    } finally {
      setBusyId(null)
    }
  }, [load])

  return <div className="dsh-hub-overview">
    <p className="dsh-hub-hint">{t('hubOverviewHint')}</p>
    {loadError !== null && summaries === null ? (
      <div className="dsh-codex-errorbar" role="alert">
        <span>{loadError}</span>
        <button type="button" className="dsh-codex-button" onClick={() => void load()}>{t('retry')}</button>
      </div>
    ) : (
      <div className="dsh-hub-cards">
        {summaries === null ? HUB_PROVIDERS.map((descriptor) => (
          <div key={descriptor.id} className="dsh-hub-skeleton" aria-hidden="true">
            <i />
            <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <span className="dsh-hub-skel-name" />
              <span className="dsh-hub-skel-note" />
            </span>
          </div>
        )) : HUB_PROVIDERS.map((descriptor) => {
          const summary = summaries.get(descriptor.id)
          return <HubProviderCard
            key={descriptor.id}
            descriptor={descriptor}
            summary={summary}
            busy={busyId === descriptor.id}
            toggleError={toggleErrors.get(descriptor.id) ?? null}
            t={t}
            onOpen={onOpen}
            onToggle={toggle}
          />
        })}
      </div>
    )}
  </div>
}

const CHEVRON_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>'

function HubProviderCard(props: {
  descriptor: HubProviderDescriptor
  summary: HubProviderSummaryDto | undefined
  busy: boolean
  toggleError: string | null
  t: HubTranslate
  onOpen(id: HubProviderDescriptor['id']): void
  onToggle(descriptor: HubProviderDescriptor, summary: HubProviderSummaryDto, enabled: boolean): Promise<void>
}): React.JSX.Element {
  const { descriptor, summary, t } = props
  const enabled = summary?.enabled ?? true
  const annotation = props.toggleError ?? cardAnnotation(summary, descriptor, t)
  const canToggle = descriptor.setEnabled !== null && (summary?.canToggle ?? true)

  return <div
    role="button"
    tabIndex={0}
    className="dsh-hub-card"
    data-enabled={enabled}
    aria-label={formatPoolLabel(t('hubCardLabel'), { name: descriptor.name, annotation })}
    onClick={() => props.onOpen(descriptor.id)}
    onKeyDown={(event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      if (event.target !== event.currentTarget) return
      event.preventDefault()
      props.onOpen(descriptor.id)
    }}
  >
    <BrandTile id={descriptor.id} />
    <span className="dsh-hub-card-copy">
      <span className="dsh-hub-card-name">{descriptor.name}</span>
      <span className={`dsh-hub-card-note${props.toggleError !== null || summary?.error === true ? ' dsh-hub-note-danger' : ''}`}>
        {annotation}
      </span>
    </span>
    <span className="dsh-hub-card-side">
      {canToggle ? (
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={formatPoolLabel(t(enabled ? 'hubSwitchOff' : 'hubSwitchOn'), { name: descriptor.name })}
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
