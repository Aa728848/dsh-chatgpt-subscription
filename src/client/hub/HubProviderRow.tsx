import type { DragEvent, KeyboardEvent, MouseEvent } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProxyMode } from '../../shared/contracts.ts'
import type { HubProviderSummaryDto } from '../../shared/hub-contracts.ts'
import { formatPoolLabel } from '../common/account-pool-labels.ts'
import type { LineProxySnapshot } from '../common/LineProxySection.tsx'
import type { NS } from '../providers/codex-chatgpt/locales.ts'
import { BrandTile } from './brand-icons.tsx'
import { hubCardName, type HubProviderCategory, type HubProviderDescriptor } from './providers.tsx'

export type HubTranslate = PropsLocale<typeof NS>['t']

const CHEVRON_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>'

function categoryBadgeKey(category: HubProviderCategory): 'hubBadgeSubscription' | 'hubBadgeApiKey' | 'hubBadgeLocal' {
  if (category === 'api-key') return 'hubBadgeApiKey'
  if (category === 'local') return 'hubBadgeLocal'
  return 'hubBadgeSubscription'
}

/** One-line annotation helper (kept exported for tests and accessibility labels). */
export function cardAnnotation(summary: HubProviderSummaryDto | undefined, _descriptor: HubProviderDescriptor, t: HubTranslate): string {
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

function rowSubline(summary: HubProviderSummaryDto | undefined, t: HubTranslate): string {
  if (summary === undefined) return '…'
  if (summary.error === true) return t('hubStatusFailed')
  const parts: string[] = []
  if (summary.accountCount > 0) {
    parts.push(formatPoolLabel(t('hubAccountCount'), { count: summary.accountCount }))
  } else {
    parts.push(t('hubStatusSignedOut'))
  }
  if (summary.enabledModelCount !== null) {
    parts.push(summary.totalModelCount !== null
      ? formatPoolLabel(t('hubModelsEnabledOfTotal'), { count: summary.enabledModelCount, total: summary.totalModelCount })
      : formatPoolLabel(t('hubModelsEnabled'), { count: summary.enabledModelCount }))
  }
  return parts.join(' · ')
}

function statusPillInfo(
  summary: HubProviderSummaryDto | undefined,
  t: HubTranslate,
): { tone: 'ok' | 'idle' | 'warn' | 'error'; text: string } {
  if (summary === undefined) return { tone: 'idle', text: '…' }
  if (summary.error === true) return { tone: 'error', text: t('hubStatusFailed') }
  if (summary.authenticated) return { tone: 'ok', text: t('hubStatusSignedIn') }
  if (summary.accountCount > 0) return { tone: 'warn', text: t('hubStatusNeedsRelogin') }
  return { tone: 'idle', text: t('hubStatusSignedOut') }
}

export interface HubProviderRowProps {
  descriptor: HubProviderDescriptor
  summary: HubProviderSummaryDto | undefined
  busy: boolean
  proxySnapshot: LineProxySnapshot | null
  cardError: string | null
  matchedModels: readonly string[]
  selecting: boolean
  selected: boolean
  dragging: boolean
  dropTarget: boolean
  t: HubTranslate
  onOpen(id: HubProviderDescriptor['id']): void
  onToggle(descriptor: HubProviderDescriptor, summary: HubProviderSummaryDto, enabled: boolean): Promise<void>
  onPick(id: HubProviderDescriptor['id'], checked: boolean, shiftKey: boolean): void
  onContextMenu(descriptor: HubProviderDescriptor, event: MouseEvent<HTMLDivElement>): void
  onDragStart(event: DragEvent<HTMLButtonElement>): void
  onDragOver(event: DragEvent<HTMLDivElement>): void
  onDrop(event: DragEvent<HTMLDivElement>): void
  onDragEnd(): void
  onMoveBy(id: string, offset: number): void
  onMoveEdge(id: string, edge: 'top' | 'bottom'): void
}

export function HubProviderRow(props: HubProviderRowProps): React.JSX.Element {
  const { descriptor, summary, t } = props
  const enabled = summary?.enabled ?? true
  const cardName = hubCardName(descriptor, t as (key: string) => string)
  const annotation = props.cardError ?? cardAnnotation(summary, descriptor, t)
  const subline = props.cardError ?? rowSubline(summary, t)
  const canToggle = descriptor.setEnabled !== null && (summary?.canToggle ?? true)
  const proxyMode: ProxyMode | null = descriptor.proxyLine === null
    ? null
    : props.proxySnapshot?.lineProxies?.[descriptor.proxyLine]?.mode ?? 'auto'
  const status = statusPillInfo(summary, t)
  const draggableEnabled = enabled && !props.selecting

  const handleRowClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (props.selecting) {
      props.onPick(descriptor.id, !props.selected, event.shiftKey)
      return
    }
    props.onOpen(descriptor.id)
  }

  const handleLogoKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    event.stopPropagation()
    if (event.altKey && event.shiftKey) {
      props.onMoveEdge(descriptor.id, event.key === 'ArrowUp' ? 'top' : 'bottom')
      return
    }
    props.onMoveBy(descriptor.id, event.key === 'ArrowUp' ? -1 : 1)
  }

  return <div
    role="button"
    tabIndex={0}
    className="dsh-hub-row dsh-hub-card"
    data-id={descriptor.id}
    data-enabled={enabled}
    data-dragging={props.dragging}
    data-drop-target={props.dropTarget}
    aria-label={formatPoolLabel(t('hubCardLabel'), { name: cardName, annotation })}
    onClick={handleRowClick}
    onContextMenu={(event) => {
      if (!enabled || props.selecting) return
      props.onContextMenu(descriptor, event)
    }}
    onKeyDown={(event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      if (event.target !== event.currentTarget) return
      event.preventDefault()
      if (props.selecting) {
        props.onPick(descriptor.id, !props.selected, event.shiftKey)
      } else {
        props.onOpen(descriptor.id)
      }
    }}
    onDragOver={props.onDragOver}
    onDrop={props.onDrop}
  >
    {props.selecting ? (
      <input
        type="checkbox"
        className="dsh-hub-check"
        checked={props.selected}
        aria-label={cardName}
        onClick={(event) => {
          event.stopPropagation()
          props.onPick(descriptor.id, !props.selected, event.shiftKey)
        }}
        onChange={() => undefined}
      />
    ) : null}

    {draggableEnabled ? (
      <button
        type="button"
        className="dsh-hub-logo-handle"
        draggable
        aria-label={formatPoolLabel(t('hubDragProvider'), { name: cardName })}
        title={t('hubDragProviderHint')}
        onKeyDown={handleLogoKeyDown}
        onDragStart={(event) => {
          event.stopPropagation()
          props.onDragStart(event)
        }}
        onDragEnd={props.onDragEnd}
      >
        <BrandTile id={descriptor.id} size={30} />
      </button>
    ) : (
      <BrandTile id={descriptor.id} size={30} />
    )}

    <span className="dsh-hub-who">
      <span className="dsh-hub-name-row">
        <span className="dsh-hub-card-name">{cardName}</span>
        {!enabled && summary?.canToggle ? (
          <span className="dsh-hub-badge is-off">{t('hubBadgeOff')}</span>
        ) : null}
        <span className="dsh-hub-badge">{t(categoryBadgeKey(descriptor.category))}</span>
        {proxyMode === 'direct' ? (
          <span className="dsh-hub-badge is-proxy">{t('hubProxyDirect')}</span>
        ) : proxyMode === 'custom' ? (
          <span className="dsh-hub-badge is-proxy">{t('hubProxyCustom')}</span>
        ) : null}
      </span>
      <span className={`dsh-hub-card-note${props.cardError !== null || summary?.error === true ? ' dsh-hub-note-danger' : ''}`}>
        {subline}
      </span>
      {props.matchedModels.length > 0 ? (
        <span className="dsh-hub-hits">
          {formatPoolLabel(t('hubServesModels'), { models: props.matchedModels.slice(0, 4).join(', ') })}
        </span>
      ) : null}
    </span>

    <span
      className={`dsh-hub-status${status.tone === 'idle' ? ' is-idle' : status.tone === 'warn' ? ' is-warn' : status.tone === 'error' ? ' is-error' : ''}`}
      title={status.text}
    >
      <span>{status.text}</span>
    </span>

    {!props.selecting ? (
      <span className="dsh-hub-tail">
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
    ) : null}
  </div>
}
