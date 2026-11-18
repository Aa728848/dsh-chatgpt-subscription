import React from 'react'
import {
  QIANWEN_CACHE_TTLS,
  QIANWEN_IMAGE_DETAILS,
  QIANWEN_REASONING_EFFORTS,
  isQianwenCacheTtl,
  isQianwenImageDetail,
  isQianwenReasoningEffort,
  type QianwenReasoningEffort,
} from '../../shared/qianwen-token-plan-contracts.ts'
import { ModelChecklist } from '../common/ModelChecklist.tsx'
import { ContextWindowEditor } from '../common/ContextWindowEditor.tsx'
import { formatCapacity } from '../common/format.ts'
import { LineProxySection } from '../common/LineProxySection.tsx'
import { useLineDict } from '../common/line-locale.ts'
import { NS_QIANWEN, zh, type QianwenLocaleKey } from './locales.ts'
import { useQianwenSection, type QianwenSectionProps } from './useQianwenSection.ts'

const EFFORT_KEYS: Record<QianwenReasoningEffort, QianwenLocaleKey> = {
  none: 'effortNone', minimal: 'effortMinimal', low: 'effortLow', medium: 'effortMedium',
  high: 'effortHigh', xhigh: 'effortXhigh', max: 'effortMax',
}
function more(title: string, lines: string[]): React.JSX.Element {
  return <details className="dshqw-details"><summary>{title}</summary>{lines.map(line => <p key={line}>{line}</p>)}</details>
}

export function QianwenTokenPlanSection(props: QianwenSectionProps = {}): React.JSX.Element {
  const t = useLineDict(NS_QIANWEN, zh)
  const view = useQianwenSection(props)
  const { status, busy } = view
  if (view.loading && status === null) return <div className="dsha-empty">{t.loading}</div>
  const models = status?.models ?? []
  const enabledModels = models.filter(model => model.enabled)
  return <div className="dsha-page dshqw-page" data-provider="qianwen-token-plan">
    <section className="dsha-group dshqw-account">
      <div className="dsha-grouphead"><h3>{t.title}</h3><div className="dsha-actions">
        <button className="dsha-btn" disabled={busy !== null || !status?.authenticated} onClick={() => void view.testConnection()}>{busy === 'connection' ? t.testingConnection : t.testConnection}</button>
        {status?.authenticated && <button className="dsha-btn" disabled={busy !== null} onClick={() => void view.removeKey()}>{busy === 'remove-key' ? t.removingKey : t.removeKey}</button>}
      </div></div>
      <p className="dsha-muted">{t.pageDesc}</p>
      <div className="dsha-pref-row"><div><strong>{t.enabled}</strong></div><input type="checkbox" aria-label={t.enabled} checked={status?.enabled !== false} disabled={busy !== null} onChange={event => void view.update({ enabled: event.currentTarget.checked }).catch(() => undefined)} /></div>
      <div className="dsha-empty">{status?.authenticated ? t.keyConfigured : t.keyMissing}</div>
      {status?.authenticated && <div className="dsha-row"><span className="dsha-label">{t.storagePath}</span><span className="dsha-value">{status.storagePath}</span></div>}
      <div className="dshqw-key-row">
        <input className="dsha-select" type="password" autoComplete="off" aria-label={t.keySection} placeholder={t.keyPlaceholder} value={view.keyValue} disabled={busy !== null} onChange={event => view.setKeyValue(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter') void view.saveKey() }} />
        <button className="dsha-btn dsha-btn-primary" disabled={busy !== null || view.keyValue.trim() === ''} onClick={() => void view.saveKey()}>{busy === 'key' ? t.savingKey : t.saveKey}</button>
      </div>
      <p className="dsha-muted">{status?.serving === false && status.conflict ? t.routeConflict.replace('{detail}', status.conflict) : t.routeOwned}</p>
      {view.connection !== null && <p className={view.connection.connected ? 'dsha-muted' : 'dsha-notice'}>{view.connection.connected ? t.connectionOk + ' · ' + t.latency.replace('{ms}', String(view.connection.latencyMs)) : t.connectionFailed + ': ' + (view.connection.error ?? '—')}</p>}
    </section>

    <section className="dsha-group dshqw-cache">
      <div className="dsha-grouphead"><h3>{t.cacheSection}</h3></div>
      <p className="dsha-muted">{t.cacheDesc}</p>
      <div className="dsha-pref-row"><div><strong>{t.cacheEnabled}</strong></div><input type="checkbox" aria-label={t.cacheEnabled} checked={status?.cacheEnabled === true} disabled={busy !== null} onChange={event => void view.update({ cacheEnabled: event.currentTarget.checked }).catch(() => undefined)} /></div>
      <div className="dsha-pref-row"><div><strong>{t.cacheTtl}</strong></div><select className="dsha-select" aria-label={t.cacheTtl} value={status?.cacheTtl ?? '5m'} disabled={busy !== null || status?.cacheEnabled !== true} onChange={event => { const value = event.currentTarget.value; if (isQianwenCacheTtl(value)) void view.update({ cacheTtl: value }).catch(() => undefined) }}>
        {QIANWEN_CACHE_TTLS.map(ttl => <option key={ttl} value={ttl}>{ttl === '5m' ? t.ttl5m : t.ttl1h}</option>)}
      </select></div>
      {status?.cacheHint && <p className="dsha-muted">{t.cacheHint.replace('{minutes}', String(Math.floor(status.cacheHint.idleMs / 60_000)))}</p>}
      <div className="dsha-actions"><a href="https://platform.qianwenai.com/home/analytics/token-plan/individual" target="_blank" rel="noreferrer">{t.dashboard}</a></div>
    </section>

    <section className="dsha-group dshqw-thinking">
      <div className="dsha-grouphead"><h3>{t.thinkingSection}</h3></div>
      <div className="dsha-pref-row"><div><strong>{t.defaultEffort}</strong><p className="dsha-muted">{t.effortHint}</p></div><select className="dsha-select" aria-label={t.defaultEffort} value={status?.defaultReasoningEffort ?? ''} disabled={busy !== null} onChange={event => { const value = event.currentTarget.value; void view.setDefaultEffort(isQianwenReasoningEffort(value) ? value : null).catch(() => undefined) }}>
        <option value="">{t.effortDefault}</option>{QIANWEN_REASONING_EFFORTS.map(effort => <option key={effort} value={effort}>{t[EFFORT_KEYS[effort]]}</option>)}
      </select></div>
      <div className="dsha-pref-row"><div><strong>{t.thinkingSummary}</strong><p className="dsha-muted">{t.thinkingSummaryHint}</p></div><input type="checkbox" aria-label={t.thinkingSummary} checked={status?.thinkingSummary === true} disabled={busy !== null} onChange={event => void view.update({ thinkingSummary: event.currentTarget.checked }).catch(() => undefined)} /></div>
    </section>

    <section className="dsha-group dshqw-models">
      <div className="dsha-grouphead"><h3>{t.modelsSection}</h3></div>
      <p className="dsha-muted">{t.modelsHint}</p>
      <ModelChecklist items={models.map(model => ({ id: model.id, name: model.name, hint: model.hint, enabled: model.enabled }))} busy={busy !== null} onToggle={view.toggleModel} onToggleAll={view.setAllModels} labels={{ selectAll: t.selectAll, clearAll: t.clearAll, list: t.modelsSection }} />
      <p className="dsha-muted">{t.selectionHint}</p>
    </section>

    <section className="dsha-group dshqw-context">
      <div className="dsha-grouphead"><h3>{t.contextSection}</h3></div><p className="dsha-muted">{t.contextHint}</p>
      <ContextWindowEditor rows={enabledModels.map(model => ({ id: model.id, name: model.name, draft: view.contextDrafts[model.id] ?? '', meta: model.contextWindow !== model.defaultContextWindow ? formatCapacity(model.contextWindow) : undefined, inputLabel: model.name + ' ' + t.contextSection, hasOverride: status?.contextWindowOverrides[model.id] !== undefined, saving: view.savingModel === model.id }))} labels={{ tokens: t.tokens, save: t.save, saving: t.saving, reset: t.reset, resetAll: t.resetAll, empty: t.contextEmpty }} busy={busy !== null} overrideCount={Object.keys(status?.contextWindowOverrides ?? {}).length} metaClassName="dshqw-model-meta" onDraftChange={view.setContextDraft} onCommit={id => void view.saveContextWindow(id)} onReset={id => void view.resetContextWindow(id)} onResetAll={() => void view.resetAllContextWindows().catch(() => undefined)} />
    </section>

    <section className="dsha-group dshqw-vision">
      <div className="dsha-grouphead"><h3>{t.visionSection}</h3></div><p className="dsha-muted">{t.visionHint}</p>
      <div className="dsha-pref-row"><div><strong>{t.imageDetail}</strong></div><select className="dsha-select" aria-label={t.imageDetail} value={status?.imageDetail ?? 'auto'} disabled={busy !== null} onChange={event => { const value = event.currentTarget.value; if (isQianwenImageDetail(value)) void view.setImageDetail(value).catch(() => undefined) }}>
        {QIANWEN_IMAGE_DETAILS.map(detail => <option key={detail} value={detail}>{detail === 'low' ? t.detailLow : detail === 'high' ? t.detailHigh : t.detailAuto}</option>)}
      </select></div>
      <div className="dshqw-key-row dshqw-vision-row"><input className="dsha-select" inputMode="numeric" aria-label={t.maxPixels} placeholder={t.maxPixelsPlaceholder} value={view.pixelsDraft} disabled={busy !== null} onChange={event => view.setPixelsDraft(event.currentTarget.value)} /><button className="dsha-btn" disabled={busy !== null} onClick={() => void view.savePixels()}>{t.maxPixelsSave}</button><button className="dsha-btn" disabled={busy !== null || view.pixelsDraft === ''} onClick={() => { view.setPixelsDraft(''); void view.update({ maxPixels: null }, 'pixels').catch(() => undefined) }}>{t.maxPixelsReset}</button></div>
      {more(t.moreNotes, [t.invalidPixels])}
    </section>
    <LineProxySection line="qianwen-token-plan" />
    {view.error !== null && <div className="dsha-error">{view.error}</div>}
  </div>
}
