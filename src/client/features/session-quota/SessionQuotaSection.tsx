import React from 'react'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { SnapshotStore } from '../../providers/codex-chatgpt/store.ts'
import { useLineDict } from '../../common/line-locale.ts'
import { formatRemainingPercent, type SessionQuotaAdapter } from './adapters.ts'
import { NS_SESSION_QUOTA, zh } from './locales.ts'
import { useSessionQuota } from './session-quota-store.ts'

export interface SessionQuotaSlotProps {
  directory?: SnapshotStore<ModelDirectoryState>
  loadModelDirectory?: () => void
  adapters?: ReadonlyMap<string, SessionQuotaAdapter>
}

const NOOP = (): void => {}

/**
 * Subscription quota card rendered inside DSH's native session details panel
 * (`conversation.session.panel.section`). Returns null when the active session
 * is not on a supported subscription line or has nothing to report, so the host
 * panel hides the section automatically.
 */
export function SessionQuotaSection(props: SessionQuotaSlotProps): React.JSX.Element | null {
  const dict = useLineDict(NS_SESSION_QUOTA, zh)
  if (!props.directory) return null
  return <SessionQuotaSectionBody
    directory={props.directory}
    loadModelDirectory={props.loadModelDirectory ?? NOOP}
    dict={dict}
    adapters={props.adapters}
  />
}

function SessionQuotaSectionBody({
  directory,
  loadModelDirectory,
  dict,
  adapters,
}: {
  directory: SnapshotStore<ModelDirectoryState>
  loadModelDirectory: () => void
  dict: typeof zh
  adapters?: ReadonlyMap<string, SessionQuotaAdapter>
}): React.JSX.Element | null {
  const { snapshot, loading, refresh } = useSessionQuota(directory, loadModelDirectory, dict, adapters)
  if (snapshot === null) return null

  return <div className="dsh-sq-panel" data-provider={snapshot.providerId}>
    <div className="dsh-sq-head">
      <div className="dsh-sq-identity">
        <span className="dsh-sq-provider">{snapshot.providerName}</span>
        {snapshot.planBadge
          ? <span className="dsh-sq-tier" title={snapshot.planBadge}>{snapshot.planBadge}</span>
          : null}
      </div>
      <button
        type="button"
        className="dsh-sq-refresh"
        data-loading={loading ? 'true' : undefined}
        disabled={loading}
        aria-label={loading ? dict.refreshing : dict.refresh}
        title={loading ? dict.refreshing : dict.refresh}
        onClick={refresh}
      >
        <svg className="dsh-sq-refresh-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M13.25 8a5.25 5.25 0 1 1-1.3-3.46M13.25 2.75v2.75H10.5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>

    {snapshot.note ? <p className="dsh-sq-note" role="status">{snapshot.note}</p> : null}

    {snapshot.bars.length > 0
      ? <div className="dsh-sq-bars">
          {snapshot.bars.map((bar) => (
            <div className="dsh-sq-bar-item" key={bar.key} data-level={bar.level}>
              <div className="dsh-sq-bar-top">
                <span className="dsh-sq-bar-label" title={bar.label}>{bar.label}</span>
                <span className="dsh-sq-bar-right">
                  {bar.resetText ? <span className="dsh-sq-bar-reset">{bar.resetText}</span> : null}
                  <span className="dsh-sq-bar-pct">{formatRemainingPercent(bar.remainingPercent)}</span>
                </span>
              </div>
              <div className="dsh-sq-track" aria-hidden="true">
                <span className="dsh-sq-fill" style={{ width: `${bar.remainingPercent}%` }} />
              </div>
              {bar.detailText ? <span className="dsh-sq-bar-detail">{bar.detailText}</span> : null}
            </div>
          ))}
        </div>
      : null}

    {snapshot.facts.length > 0
      ? <dl className="dsh-sq-facts">
          {snapshot.facts.map((fact) => (
            <div className="dsh-sq-fact" key={fact.key} data-level={fact.level ?? 'normal'}>
              <dt>{fact.label}</dt>
              <dd title={fact.value}>{fact.value}</dd>
            </div>
          ))}
        </dl>
      : null}
  </div>
}

/**
 * Trailing summary reading shown on the right side of the section header when
 * folded (`conversation.session.panel.section.actions`).
 */
export function SessionQuotaReading(props: SessionQuotaSlotProps): React.JSX.Element | null {
  const dict = useLineDict(NS_SESSION_QUOTA, zh)
  if (!props.directory) return null
  return <SessionQuotaReadingBody
    directory={props.directory}
    loadModelDirectory={props.loadModelDirectory ?? NOOP}
    dict={dict}
    adapters={props.adapters}
  />
}

function SessionQuotaReadingBody({
  directory,
  loadModelDirectory,
  dict,
  adapters,
}: {
  directory: SnapshotStore<ModelDirectoryState>
  loadModelDirectory: () => void
  dict: typeof zh
  adapters?: ReadonlyMap<string, SessionQuotaAdapter>
}): React.JSX.Element | null {
  const { snapshot } = useSessionQuota(directory, loadModelDirectory, dict, adapters)
  if (snapshot === null) return null

  const pct = typeof snapshot.summaryPercent === 'number' ? snapshot.summaryPercent : null
  return <span className="dsh-sq-reading" data-level={snapshot.summaryLevel}>
    <span>{snapshot.summaryText}</span>
    {pct !== null
      ? <span className="dsh-sq-reading-mini" aria-hidden="true">
          <span style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
        </span>
      : null}
  </span>
}
