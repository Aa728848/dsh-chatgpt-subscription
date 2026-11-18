import React from 'react'
import {
  RELAYONE_REASONING_EFFORTS,
  isRelayOneReasoningEffort,
  type RelayOneReasoningEffort,
} from '../../shared/relayone-contracts.ts'
import { ModelChecklist } from '../common/ModelChecklist.tsx'
import { ContextWindowEditor } from '../common/ContextWindowEditor.tsx'
import { formatCapacity } from '../common/format.ts'
import { LineProxySection } from '../common/LineProxySection.tsx'
import { useLineDict } from '../common/line-locale.ts'
import { NS_RELAYONE, zh, type RelayOneLocaleKey } from './locales.ts'
import { useRelayOneSection, type RelayOneSectionProps } from './useRelayOneSection.ts'
import { relayOneQuotaAccountText } from './quota-format.ts'

const EFFORT_KEYS: Record<RelayOneReasoningEffort, RelayOneLocaleKey> = {
  none: 'effortNone', minimal: 'effortMinimal', low: 'effortLow', medium: 'effortMedium', high: 'effortHigh', xhigh: 'effortXhigh', max: 'effortMax',
}
export function RelayOneSection(props: RelayOneSectionProps = {}): React.JSX.Element {
  const t = useLineDict(NS_RELAYONE, zh)
  const view = useRelayOneSection(props)
  const { status, busy } = view
  if (view.loading && status === null) return <div className="dsha-empty">{t.catalogLoading}</div>
  const models = status?.models ?? []
  const media = status?.mediaModels ?? []
  const images = media.filter(model => model.kind === 'image')
  const videos = media.filter(model => model.kind === 'video')
  const enabledModels = models.filter(model => model.enabled)
  return <div className="dsha-page dshro-page" data-provider="relayone">
    <section className="dsha-group dshro-account">
      <div className="dsha-grouphead"><h3>{t.title}</h3><div className="dsha-actions">
        <button className="dsha-btn" disabled={busy !== null || !status?.authenticated} onClick={() => void view.testConnection()}>{busy === 'connection' ? t.testingConnection : t.testConnection}</button>
        {status?.authenticated && <button className="dsha-btn" disabled={busy !== null} onClick={() => void view.removeKey()}>{busy === 'remove-key' ? t.removingKey : t.removeKey}</button>}
      </div></div>
      <p className="dsha-muted">{t.pageDesc}</p>
      <div className="dsha-pref-row"><div><strong>{t.enabled}</strong></div><input type="checkbox" aria-label={t.enabled} checked={status?.enabled !== false} disabled={busy !== null} onChange={event => void view.update({ enabled: event.currentTarget.checked }).catch(() => undefined)} /></div>
      <div className="dsha-empty">{status?.authenticated ? t.keyConfigured : t.keyMissing}</div>
      {status?.authenticated && <div className="dsha-row"><span className="dsha-label">{t.storagePath}</span><span className="dsha-value">{status.storagePath}</span></div>}
      {status?.authenticated && status.quota !== undefined && status.quota.state !== 'idle' && <div className="dsha-row dshro-quota-row" title={status.quota.error ?? undefined}><span className="dsha-label">{t.quotaLabel}</span><span className="dsha-value">{relayOneQuotaAccountText(status.quota) ?? '—'}</span></div>}
      <div className="dshro-key-row">
        <input className="dsha-select" type="password" autoComplete="off" aria-label={t.keySection} placeholder={t.keyPlaceholder} value={view.keyValue} disabled={busy !== null} onChange={event => view.setKeyValue(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter') void view.saveKey() }} />
        <button className="dsha-btn dsha-btn-primary" disabled={busy !== null || view.keyValue.trim() === ''} onClick={() => void view.saveKey()}>{busy === 'key' ? t.savingKey : t.saveKey}</button>
      </div>
      <p className="dsha-muted">{status?.serving === false && status.conflict ? t.routeConflict.replace('{detail}', status.conflict) : t.routeOwned}</p>
      {view.connection !== null && <p className={view.connection.connected ? 'dsha-muted' : 'dsha-notice'}>{view.connection.connected
        ? t.connectionOk + ' · ' + t.latency.replace('{ms}', String(view.connection.latencyMs)) + ' · ' + t.modelCount.replace('{count}', String(view.connection.modelCount))
        : t.connectionFailed + ': ' + (view.connection.error ?? '—')}</p>}
    </section>

    <section className="dsha-group dshro-models">
      <div className="dsha-grouphead"><h3>{t.modelsSection}</h3><div className="dsha-actions"><button className="dsha-btn" disabled={busy !== null || !status?.authenticated} onClick={() => void view.refreshCatalog()}>{busy === 'catalog' ? t.refreshingCatalog : t.refreshCatalog}</button></div></div>
      <p className="dsha-muted">{t.modelsHint}</p>
      {status?.catalog.error && <p className="dsha-notice">{t.catalogError}: {status.catalog.error}</p>}
      {status?.catalog.state === 'stale' && <p className="dsha-muted">{t.catalogStale}</p>}
      {models.length === 0
        ? <div className="dsha-empty">{status?.authenticated ? t.catalogLoading : t.catalogEmpty}</div>
        : <ModelChecklist items={models.map(model => ({ id: model.id, name: model.name, hint: model.hint, enabled: model.enabled }))} busy={busy !== null} onToggle={view.toggleModel} onToggleAll={view.setAllModels} labels={{ selectAll: t.selectAll, clearAll: t.clearAll, list: t.modelsSection }} />}
      <p className="dsha-muted">{t.selectionHint}</p>
    </section>

    <section className="dsha-group dshro-reasoning">
      <div className="dsha-grouphead"><h3>{t.reasoningSection}</h3></div>
      <div className="dsha-pref-row"><div><strong>{t.defaultEffort}</strong><p className="dsha-muted">{t.effortHint}</p></div><select className="dsha-select" aria-label={t.defaultEffort} value={status?.defaultReasoningEffort ?? ''} disabled={busy !== null} onChange={event => { const value = event.currentTarget.value; void view.setDefaultEffort(isRelayOneReasoningEffort(value) ? value : null).catch(() => undefined) }}>
        <option value="">{t.effortDefault}</option>{RELAYONE_REASONING_EFFORTS.map(effort => <option key={effort} value={effort}>{t[EFFORT_KEYS[effort]]}</option>)}
      </select></div>
    </section>

    <section className="dsha-group dshro-media">
      <div className="dsha-grouphead"><h3>{t.mediaSection}</h3></div>
      <p className="dsha-muted">{t.mediaHint}</p>
      {media.length === 0 ? <div className="dsha-empty">{t.mediaEmpty}</div> : <>
        <div className="dsha-pref-row dshro-media-row"><div><strong>{t.imageModel}</strong></div><select className="dsha-select" aria-label={t.imageModel} value={status?.imageModel ?? ''} disabled={busy !== null || images.length === 0} onChange={event => void view.setImageModel(event.currentTarget.value || null).catch(() => undefined)}>
          <option value="">{t.mediaAuto}</option>{images.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select></div>
        <div className="dsha-pref-row dshro-media-row"><div><strong>{t.videoModel}</strong></div><select className="dsha-select" aria-label={t.videoModel} value={status?.videoModel ?? ''} disabled={busy !== null || videos.length === 0} onChange={event => void view.setVideoModel(event.currentTarget.value || null).catch(() => undefined)}>
          <option value="">{t.mediaAuto}</option>{videos.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select></div>
      </>}
      <details className="dshro-details"><summary>{t.moreNotes}</summary><p>{t.protocolNote}</p><p>{t.mediaNote}</p><p><a href="https://z1rry.cyou/docs" target="_blank" rel="noreferrer">{t.docs}</a><a href="https://z1rry.cyou/dashboard" target="_blank" rel="noreferrer">{t.dashboard}</a></p></details>
    </section>

    <section className="dsha-group dshro-context">
      <div className="dsha-grouphead"><h3>{t.contextSection}</h3></div><p className="dsha-muted">{t.contextHint}</p>
      <ContextWindowEditor rows={enabledModels.map(model => ({ id: model.id, name: model.name, draft: view.contextDrafts[model.id] ?? '', meta: model.contextWindow !== model.defaultContextWindow ? formatCapacity(model.contextWindow) : undefined, inputLabel: model.name + ' ' + t.contextSection, hasOverride: status?.contextWindowOverrides[model.id] !== undefined, saving: view.savingModel === model.id }))} labels={{ tokens: t.tokens, save: t.save, saving: t.saving, reset: t.reset, resetAll: t.resetAll, empty: t.contextEmpty }} busy={busy !== null} overrideCount={Object.keys(status?.contextWindowOverrides ?? {}).length} metaClassName="dshro-model-meta" onDraftChange={view.setContextDraft} onCommit={id => void view.saveContextWindow(id)} onReset={id => void view.resetContextWindow(id)} onResetAll={() => void view.resetAllContextWindows().catch(() => undefined)} />
    </section>
    <LineProxySection line="relayone" />
    {view.error !== null && <div className="dsha-error">{view.error}</div>}
  </div>
}
