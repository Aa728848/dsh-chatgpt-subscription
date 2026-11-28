import React from 'react'
import {
  CLAUDE_API_CACHE_TTLS,
  CLAUDE_API_DEFAULT_BASE_URL,
  CLAUDE_API_PROVIDER_ID,
  CLAUDE_API_REASONING_EFFORTS,
  isClaudeApiCacheTtl,
  isClaudeApiReasoningEffort,
  type ClaudeApiAccountSummaryDto,
  type ClaudeApiBaseUrlError,
  type ClaudeApiCacheTtl,
  type ClaudeApiClientVersionSource,
  type ClaudeApiReasoningEffort,
} from '../../../shared/claude-api-contracts.ts'
import { ModelChecklist } from '../../common/ModelChecklist.tsx'
import { ContextWindowEditor } from '../../common/ContextWindowEditor.tsx'
import { AccountPoolSection } from '../../common/AccountPoolSection.tsx'
import { formatCapacity } from '../../common/format.ts'
import { LineProxySection } from '../../common/LineProxySection.tsx'
import { useLineDict } from '../../common/line-locale.ts'
import { NS_CLAUDE_API, zh, type ClaudeApiLocaleKey } from './locales.ts'
import { useClaudeApiSection, type ClaudeApiSectionProps } from './useClaudeApiSection.ts'

export type { ClaudeApiSectionProps }

const EFFORT_KEYS: Record<ClaudeApiReasoningEffort, ClaudeApiLocaleKey> = {
  none: 'effortNone', low: 'effortLow', medium: 'effortMedium', high: 'effortHigh', xhigh: 'effortXhigh', max: 'effortMax',
}
const CACHE_TTL_KEYS: Record<ClaudeApiCacheTtl, ClaudeApiLocaleKey> = { '5m': 'cacheTtl5m', '1h': 'cacheTtl1h' }
const VERSION_SOURCE_KEYS: Record<ClaudeApiClientVersionSource, ClaudeApiLocaleKey> = {
  env: 'versionSourceEnv', npm: 'versionSourceNpm', cached: 'versionSourceCached', default: 'versionSourceDefault',
}
const ENDPOINT_ERROR_KEYS: Record<ClaudeApiBaseUrlError, ClaudeApiLocaleKey> = {
  empty: 'endpointErrorEmpty', invalid: 'endpointErrorInvalid', scheme: 'endpointErrorScheme', credentials: 'endpointErrorCredentials', query: 'endpointErrorQuery',
}
const SEPARATOR = ' · '
const DASH = '—'

export function ClaudeApiSection(props: ClaudeApiSectionProps = {}): React.JSX.Element {
  const t = useLineDict(NS_CLAUDE_API, zh)
  const view = useClaudeApiSection(props)
  const { status, busy } = view
  if (view.loading && status === null) return <div className="dsha-empty">{t.loading}</div>
  const models = status?.models ?? []
  const enabledModels = models.filter(model => model.enabled)
  const accounts = status?.accounts ?? []
  return <div className="dsha-page dshca-page" data-provider="claude-api">
    <AccountPoolSection<ClaudeApiAccountSummaryDto>
      accounts={accounts}
      activeAccountId={status?.activeAccountId}
      rotationStrategy={status?.rotationStrategy ?? 'sequential'}
      busy={busy}
      labels={{ ...t, accountPool: t.title }}
      onLogin={view.openAddAccount}
      onSetPrimary={id => void view.accountAction('set-primary', id)}
      onDelete={id => void view.accountAction('delete', id)}
      onClearCooldown={id => void view.accountAction('clear-cooldown', id)}
      onRelogin={id => { const account = accounts.find(entry => entry.id === id); if (account) view.openEditAccount(account) }}
      onSetStrategy={strategy => void view.setStrategy(strategy)}
      omitDetails={['email', 'expires']}
      renderDetails={entry => <span>{t.endpoint}: {entry.baseUrl}</span>}
      renderAccountActions={entry => <>
        <button className="dsha-btn" disabled={busy !== null} onClick={() => view.openEditAccount(entry)}>{t.editAccount}</button>
        <button className="dsha-btn" disabled={busy !== null} onClick={() => void view.testConnection(entry.id)}>{busy === 'connection-' + entry.id ? t.testingConnection : t.testConnection}</button>
      </>}
    >
      <p className="dsha-muted">{t.pageDesc}</p>
      <div className="dsha-pref-row"><div><strong>{t.enabled}</strong></div><input type="checkbox" aria-label={t.enabled} checked={status?.enabled !== false} disabled={busy !== null} onChange={event => void view.update({ enabled: event.currentTarget.checked }).catch(() => undefined)} /></div>
      {view.accountFormOpen && <div className="dshca-account-form">
        <div className="dsha-pref-row"><div><strong>{t.accountAlias}</strong></div><input className="dsha-select" type="text" aria-label={t.accountAlias} value={view.aliasValue} disabled={busy !== null} onChange={event => view.setAliasValue(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter') void view.saveAccount() }} /></div>
        <div className="dsha-pref-row dshca-endpoint-row"><div><strong>{t.endpoint}</strong></div><div className="dshca-endpoint-control">
          <input className="dsha-select" type="text" inputMode="url" autoComplete="off" spellCheck={false} aria-label={t.endpoint} aria-invalid={view.endpointError !== null} placeholder={status?.defaultBaseUrl ?? CLAUDE_API_DEFAULT_BASE_URL} value={view.endpointDraft} disabled={busy !== null} onChange={event => view.setEndpointDraft(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter') void view.saveAccount() }} />
          <button className="dsha-btn" disabled={busy !== null} onClick={() => view.setEndpointDraft(status?.defaultBaseUrl ?? CLAUDE_API_DEFAULT_BASE_URL)}>{t.restoreEndpoint}</button>
        </div></div>
        {view.endpointError !== null && <p className="dsha-error dshca-endpoint-error" role="alert">{t[ENDPOINT_ERROR_KEYS[view.endpointError]]}</p>}
        <div className="dshca-key-row">
          <input className="dsha-select" type="password" autoComplete="off" aria-label={t.keySection} placeholder={view.editingAccountId === null ? t.keyPlaceholder : t.keyKeepPlaceholder} value={view.keyValue} disabled={busy !== null} onChange={event => view.setKeyValue(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter') void view.saveAccount() }} />
          <button className="dsha-btn dsha-btn-primary" disabled={busy !== null || (view.editingAccountId === null && view.keyValue.trim() === '')} onClick={() => void view.saveAccount()}>{busy === 'account' ? t.savingKey : t.saveAccount}</button>
          <button className="dsha-btn" disabled={busy !== null} onClick={view.cancelAccountForm}>{t.cancel}</button>
        </div>
      </div>}
      {status !== null && <div className="dsha-row dshca-version-row"><span className="dsha-label">{t.clientVersion}</span><span className="dsha-value dshca-version">{status.clientVersion.value + SEPARATOR + t[VERSION_SOURCE_KEYS[status.clientVersion.source]] + (status.clientVersion.pending !== null ? SEPARATOR + t.versionPending.replace('{version}', status.clientVersion.pending) : '')}</span></div>}
      <p className="dsha-muted">{status?.serving === false && status.conflict ? t.routeConflict.replace('{detail}', status.conflict) : t.routeOwned}</p>
      {view.connection !== null && <p className={view.connection.connected ? 'dsha-muted' : 'dsha-notice'}>{view.connection.connected
        ? t.connectionOk + SEPARATOR + t.latency.replace('{ms}', String(view.connection.latencyMs)) + SEPARATOR + t.modelCount.replace('{count}', String(view.connection.modelCount))
        : t.connectionFailed + ': ' + (view.connection.error ?? DASH)}</p>}
    </AccountPoolSection>

    <section className="dsha-group dshca-models">
      <div className="dsha-grouphead"><h3>{t.modelsSection}</h3><div className="dsha-actions"><button className="dsha-btn" disabled={busy !== null || !status?.authenticated} onClick={() => void view.refreshCatalog()}>{busy === 'catalog' ? t.refreshingCatalog : t.refreshCatalog}</button></div></div>
      <p className="dsha-muted">{t.modelsHint}</p>
      {status?.catalog.error && <p className="dsha-notice">{t.catalogError}: {status.catalog.error}</p>}
      {status?.catalog.state === 'stale' && <p className="dsha-muted">{t.catalogStale}</p>}
      {models.length === 0
        ? <div className="dsha-empty">{status?.authenticated ? t.catalogLoading : t.catalogEmpty}</div>
        : <ModelChecklist items={models.map(model => ({ id: model.id, name: model.name, hint: model.hint, enabled: model.enabled }))} busy={busy !== null} onToggle={view.toggleModel} onToggleAll={view.setAllModels} labels={{ selectAll: t.selectAll, clearAll: t.clearAll, list: t.modelsSection }} />}
      <p className="dsha-muted">{t.selectionHint}</p>
    </section>

    <section className="dsha-group dshca-reasoning">
      <div className="dsha-grouphead"><h3>{t.reasoningSection}</h3></div>
      <div className="dsha-pref-row"><div><strong>{t.defaultEffort}</strong><p className="dsha-muted">{t.effortHint}</p></div><select className="dsha-select" aria-label={t.defaultEffort} value={status?.defaultReasoningEffort ?? ''} disabled={busy !== null} onChange={event => { const value = event.currentTarget.value; void view.setDefaultEffort(isClaudeApiReasoningEffort(value) ? value : null).catch(() => undefined) }}>
        <option value="">{t.effortDefault}</option>{CLAUDE_API_REASONING_EFFORTS.map(effort => <option key={effort} value={effort}>{t[EFFORT_KEYS[effort]]}</option>)}
      </select></div>
    </section>

    <section className="dsha-group dshca-options">
      <div className="dsha-grouphead"><h3>{t.optionsSection}</h3></div>
      <p className="dsha-muted">{t.optionsHint}</p>
      <div className="dsha-pref-row"><div><strong>{t.cacheTtl}</strong></div><select className="dsha-select" aria-label={t.cacheTtl} value={status?.cacheTtl ?? '5m'} disabled={busy !== null || status === null} onChange={event => { const value = event.currentTarget.value; if (isClaudeApiCacheTtl(value)) void view.setCacheTtl(value).catch(() => undefined) }}>
        {CLAUDE_API_CACHE_TTLS.map(ttl => <option key={ttl} value={ttl}>{t[CACHE_TTL_KEYS[ttl]]}</option>)}
      </select></div>
      <div className="dsha-pref-row"><div><strong>{t.subagentCacheTtl}</strong><p className="dsha-muted">{t.subagentCacheTtlHint}</p></div><select className="dsha-select" aria-label={t.subagentCacheTtl} value={status?.subagentCacheTtl ?? '5m'} disabled={busy !== null || status === null} onChange={event => { const value = event.currentTarget.value; if (isClaudeApiCacheTtl(value)) void view.setSubagentCacheTtl(value).catch(() => undefined) }}>
        {CLAUDE_API_CACHE_TTLS.map(ttl => <option key={ttl} value={ttl}>{t[CACHE_TTL_KEYS[ttl]]}</option>)}
      </select></div>
      <div className="dsha-pref-row"><div><strong>{t.fastMode}</strong></div><input type="checkbox" aria-label={t.fastMode} checked={status?.fastMode === true} disabled={busy !== null || status === null} onChange={event => void view.setFastMode(event.currentTarget.checked).catch(() => undefined)} /></div>
      <div className="dsha-pref-row"><div><strong>{t.serverCompaction}</strong></div><input type="checkbox" aria-label={t.serverCompaction} checked={status?.serverCompaction === true} disabled={busy !== null || status === null} onChange={event => void view.setServerCompaction(event.currentTarget.checked).catch(() => undefined)} /></div>
      <div className="dsha-pref-row"><div><strong>{t.autoCompactSubagents}</strong><p className="dsha-muted">{t.autoCompactSubagentsHint}</p></div><input type="checkbox" aria-label={t.autoCompactSubagents} checked={status?.autoCompactSubagents !== false} disabled={busy !== null || status === null} onChange={event => void view.setAutoCompactSubagents(event.currentTarget.checked).catch(() => undefined)} /></div>
      <details className="dshca-details"><summary>{t.moreNotes}</summary><p>{t.cacheTtlNote}</p><p>{t.fastModeNote}</p><p>{t.serverCompactionNote}</p></details>
    </section>

    <section className="dsha-group dshca-context">
      <div className="dsha-grouphead"><h3>{t.contextSection}</h3></div><p className="dsha-muted">{t.contextHint}</p>
      <ContextWindowEditor rows={enabledModels.map(model => ({ id: model.id, name: model.name, draft: view.contextDrafts[model.id] ?? '', meta: model.contextWindow !== model.defaultContextWindow ? formatCapacity(model.contextWindow) : undefined, inputLabel: model.name + ' ' + t.contextSection, hasOverride: status?.contextWindowOverrides[model.id] !== undefined, saving: view.savingModel === model.id }))} labels={{ tokens: t.tokens, save: t.save, saving: t.saving, reset: t.reset, resetAll: t.resetAll, empty: t.contextEmpty }} busy={busy !== null} overrideCount={Object.keys(status?.contextWindowOverrides ?? {}).length} metaClassName="dsha-model-meta" onDraftChange={view.setContextDraft} onCommit={id => void view.saveContextWindow(id)} onReset={id => void view.resetContextWindow(id)} onResetAll={() => void view.resetAllContextWindows().catch(() => undefined)} />
      {view.capacityInvalid && <div className="dsha-error">{t.invalidCapacity}</div>}
    </section>
    <LineProxySection line={CLAUDE_API_PROVIDER_ID} />
    {view.error !== null && <div className="dsha-error">{view.error}</div>}
  </div>
}
