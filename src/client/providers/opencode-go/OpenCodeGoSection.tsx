import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AccountPoolSection } from '../../common/AccountPoolSection.tsx'
import { ContextWindowEditor, contextDraftsFor } from '../../common/ContextWindowEditor.tsx'
import { ModelChecklist } from '../../common/ModelChecklist.tsx'
import { createLineApi } from '../../common/line-api.ts'
import { formatCapacity, parsePositiveCapacity } from '../../common/format.ts'
import { useLineDict } from '../../common/line-locale.ts'
import { modelVendorGroup, nextGroupSelection } from '../../common/model-vendors.ts'
import { LineProxySection } from '../../common/LineProxySection.tsx'
import type { AccountRotationStrategy } from '../../../shared/account-pool-contracts.ts'
import { OPENCODE_GO_REASONING_EFFORTS, type OpenCodeGoReasoningEffort, type OpenCodeGoSettingsUpdateDto, type OpenCodeGoWebStatus } from '../../../shared/opencode-go-contracts.ts'
import { NS_OPENCODE_GO, zh } from './locales.ts'
import { OpenCodeGoQuotaCard } from './OpenCodeGoQuotaCard.tsx'

const api = createLineApi('/opencode-go/api', 'OpenCode Go')
const QUOTA_POLL_MS = 30_000
interface Props { onModelChange?: () => void; loadModelDirectory?: () => void }

export function OpenCodeGoSection({ onModelChange, loadModelDirectory }: Props): React.JSX.Element {
  const t = useLineDict(NS_OPENCODE_GO, zh)
  const [status, setStatus] = useState<OpenCodeGoWebStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [apiKeyOpen, setApiKeyOpen] = useState(false)
  const [apiKeyValue, setApiKeyValue] = useState('')
  const [apiKeyTarget, setApiKeyTarget] = useState<string | null>(null)
  const [contextDrafts, setContextDrafts] = useState<Record<string, string>>({})
  const [savingModel, setSavingModel] = useState<string | null>(null)
  const quotaRequest = useRef<Promise<OpenCodeGoWebStatus> | null>(null)
  const authenticated = status?.authenticated === true

  const notifyChange = useCallback(() => { onModelChange?.(); loadModelDirectory?.() }, [onModelChange, loadModelDirectory])
  const applyStatus = useCallback((next: OpenCodeGoWebStatus) => { setStatus(next); setContextDrafts(contextDraftsFor(next)) }, [])
  const load = useCallback(async () => {
    try { setError(null); applyStatus(await api.get<OpenCodeGoWebStatus>('/status')) }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setLoading(false) }
  }, [applyStatus])
  useEffect(() => { void load() }, [load])

  const requestQuota = useCallback(() => {
    quotaRequest.current ??= api.post<OpenCodeGoWebStatus>('/quota/refresh').finally(() => {
      quotaRequest.current = null
    })
    return quotaRequest.current
  }, [])

  useEffect(() => {
    if (!authenticated || busy !== null) return
    let active = true
    const timer = window.setInterval(async () => {
      if (document.hidden || quotaRequest.current !== null) return
      try {
        const next = await requestQuota()
        if (!active) return
        const accounts = new Map(next.accounts.map(account => [account.id, account]))
        setStatus(current => current === null ? current : {
          ...current,
          quotaError: next.quotaError,
          accounts: current.accounts.map(account => {
            const update = accounts.get(account.id)
            return update === undefined ? account : { ...account, quota: update.quota, planName: update.planName, lastUsedAt: update.lastUsedAt }
          }),
        })
      } catch {
        // Keep the last displayed quota when the background request fails.
      }
    }, QUOTA_POLL_MS)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [authenticated, busy, requestQuota])

  const commit = useCallback(async (kind: string, action: () => Promise<OpenCodeGoWebStatus>, notify = true) => {
    try { setBusy(kind); setError(null); applyStatus(await action()); if (notify) notifyChange() }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(null) }
  }, [applyStatus, notifyChange])

  const submitKey = async () => {
    const apiKey = apiKeyValue.trim()
    if (apiKey === '') { setError(t.apiKeyEmpty); return }
    await commit('login', () => api.post<OpenCodeGoWebStatus>('/accounts', { apiKey, ...(apiKeyTarget === null ? {} : { accountId: apiKeyTarget }) }))
    setApiKeyValue(''); setApiKeyTarget(null); setApiKeyOpen(false)
  }
  const accountAction = (action: string, accountId?: string, extra: Record<string, unknown> = {}) => commit('account', () => api.post<OpenCodeGoWebStatus>('/accounts/action', { action, accountId, ...extra }))
  const saveSettings = (patch: OpenCodeGoSettingsUpdateDto, kind = 'settings') => commit(kind, () => api.post<OpenCodeGoWebStatus>('/settings', patch))

  const setModelGroup = (ids: string[], enabled: boolean) => {
    if (status === null) return
    const current = status.models.filter(model => model.enabled).map(model => model.id)
    void saveSettings({ enabledModelIds: nextGroupSelection(current, ids, enabled) })
  }
  const setAllModels = (enabled: boolean) => { if (status !== null) void saveSettings({ enabledModelIds: enabled ? status.models.map(model => model.id) : [] }) }

  const saveContext = async (id: string) => {
    const parsed = parsePositiveCapacity(contextDrafts[id] ?? '')
    if (parsed === null) { setError(t.contextWindowHint); return }
    setSavingModel(id)
    await commit('context', () => api.post<OpenCodeGoWebStatus>('/settings', { contextWindowOverrides: { [id]: parsed } }), false)
    setSavingModel(null)
  }
  const resetContext = async (id: string) => { setSavingModel(id); await commit('context', () => api.post<OpenCodeGoWebStatus>('/settings', { contextWindowOverrides: { [id]: null } }), false); setSavingModel(null) }
  const resetAllContexts = async () => {
    if (status === null || !window.confirm(t.contextWindowResetAllConfirm)) return
    await commit('context', () => api.post<OpenCodeGoWebStatus>('/settings', { contextWindowOverrides: Object.fromEntries(Object.keys(status.contextWindowOverrides).map(id => [id, null])) }), false)
  }

  if (loading) return <div className="dsha-page"><div className="dsha-empty">{t.loading}</div></div>
  const models = status?.models ?? []
  const enabledModels = models.filter(model => model.enabled)
  const offeredEfforts = OPENCODE_GO_REASONING_EFFORTS.filter(effort => enabledModels.some(model => model.reasoningEfforts.includes(effort)))
  const apiKeyTargetAlias = apiKeyTarget === null ? null : status?.accounts.find(account => account.id === apiKeyTarget)?.alias ?? apiKeyTarget
  const effortLabel = (effort: OpenCodeGoReasoningEffort): string => ({ none: t.effortNone, minimal: t.effortMinimal, low: t.effortLow, medium: t.effortMedium, high: t.effortHigh, xhigh: t.effortXhigh, max: t.effortMax })[effort]

  return <div className="dsha-page dshoc-page">
    <AccountPoolSection
      accounts={status?.accounts ?? []}
      activeAccountId={status?.activeAccountId}
      rotationStrategy={status?.rotationStrategy ?? 'sequential'}
      busy={busy}
      labels={t}
      onLogin={() => { setApiKeyTarget(null); setApiKeyOpen(value => !value) }}
      renderLoginActions={() => <button className="dsha-btn dsha-btn-primary" disabled={busy !== null} aria-expanded={apiKeyOpen} onClick={() => { setApiKeyTarget(null); setApiKeyOpen(value => !value) }}>{t.apiKeyLogin}</button>}
      renderDetails={() => <span>{t.authMethod}: {t.authMethodApiKey}</span>}
      renderAccountActions={(account) => <button className="dsha-btn" disabled={busy !== null} onClick={() => { setApiKeyTarget(account.id); setApiKeyOpen(true) }}>{t.apiKeyReplace}</button>}
      onSetPrimary={(accountId) => void accountAction('set-primary', accountId)}
      onDelete={(accountId) => void accountAction('delete', accountId)}
      onClearCooldown={(accountId) => void accountAction('clear-cooldown', accountId)}
      onRelogin={(accountId) => { setApiKeyTarget(accountId); setApiKeyOpen(true) }}
      onSetStrategy={(strategy: AccountRotationStrategy) => void accountAction('strategy', undefined, { strategy })}
      showQuota
      accountCardClassName="dsha-account-card--kimi dshoc-account"
      omitDetails={['lastUsed', 'expires']}
      renderQuota={(account) => <OpenCodeGoQuotaCard quota={account.quota} planName={account.planName} lastUsedAt={account.lastUsedAt} labels={t} />}
    >
      {apiKeyOpen && <div className="dshoc-apikey" id="dshoc-apikey-body">
        <p className="dsha-muted">{apiKeyTargetAlias === null ? t.apiKeyHint : t.apiKeyReplaceHint.replace('{alias}', apiKeyTargetAlias)}</p>
        <div className="dshoc-apikey-row"><input type="password" className="dsha-select" autoComplete="off" spellCheck={false} aria-label={t.apiKeyLogin} placeholder={t.apiKeyPlaceholder} value={apiKeyValue} disabled={busy !== null} onChange={event => setApiKeyValue(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter') void submitKey() }} /><button className="dsha-btn dsha-btn-primary" disabled={busy !== null || apiKeyValue.trim() === ''} onClick={() => void submitKey()}>{busy === 'login' ? t.apiKeySubmitting : t.apiKeySubmit}</button></div>
      </div>}
      {status?.quotaError != null && <p className="dsha-notice">{status.quotaError}</p>}
      <div className="dsha-actions"><button className="dsha-btn" disabled={busy !== null || !status?.authenticated} onClick={() => void commit('quota', requestQuota, false)}>{busy === 'quota' ? t.refreshingQuota : t.refreshQuota}</button></div>
    </AccountPoolSection>

    <section className="dsha-group"><div className="dsha-grouphead"><h3>{t.connection}</h3></div>
      <p className="dsha-notice">{status?.serving === false && status.conflict ? t.routeConflict.replace('{detail}', status.conflict) : t.routeOwned}</p>
      {status?.connection !== null && status?.connection !== undefined && <p className="dsha-muted">{status.connection.connected ? t.testSuccess : t.testFailed}{status.connection.model === null ? '' : ' · ' + status.connection.model}{status.connection.error === undefined ? '' : ' · ' + status.connection.error}</p>}
      <div className="dsha-actions"><button className="dsha-btn" disabled={busy !== null || !status?.authenticated} onClick={async () => {
        try { setBusy('connection'); setError(null); const result = await api.post<OpenCodeGoWebStatus['connection']>('/connection/test'); setStatus(current => current === null ? current : { ...current, connection: result }) }
        catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(null) }
      }}>{busy === 'connection' ? t.testingConnection : t.testConnection}</button></div>
    </section>

    <section className="dsha-group"><div className="dsha-grouphead"><h3>{t.modelsSection}</h3><button className="dsha-btn" disabled={busy !== null || !status?.authenticated} onClick={() => void commit('catalog', () => api.post<OpenCodeGoWebStatus>('/models/refresh'))}>{busy === 'catalog' ? t.refreshingCatalog : t.refreshCatalog}</button></div>
      <p className="dsha-muted dsha-models-hint">{t.modelsHint}</p>
      <ModelChecklist items={models.map(model => ({ id: model.id, name: model.name, hint: model.hint, enabled: model.enabled, group: modelVendorGroup(model.canonicalId ?? model.id, t.otherGroup) }))} busy={busy !== null} onToggle={(id, enabled) => setModelGroup([id], enabled)} onToggleAll={setAllModels} onToggleGroup={setModelGroup} groupByVendor labels={{ selectAll: t.selectAll, clearAll: t.unselectAll, list: t.modelsSection }} />
    </section>

    <section className="dsha-group"><div className="dsha-grouphead"><h3>{t.enhanced}</h3></div>
      <div className="dsha-pref-row"><div><strong>{t.defaultReasoningEffort}</strong><p className="dsha-muted">{t.defaultReasoningEffortHint}</p></div><select className="dsha-select" aria-label={t.defaultReasoningEffort} value={status?.defaultReasoningEffort ?? ''} disabled={busy !== null} onChange={event => { const value = event.currentTarget.value; void saveSettings({ defaultReasoningEffort: value === '' ? null : value as OpenCodeGoReasoningEffort }) }}><option value="">{t.defaultEffortAuto}</option>{offeredEfforts.map(effort => <option key={effort} value={effort}>{effortLabel(effort)}</option>)}</select></div>
      <ContextWindowEditor
        rows={enabledModels.map(model => ({ id: model.id, name: model.name, draft: contextDrafts[model.id] ?? formatCapacity(model.defaultContextWindow), meta: model.contextWindow > model.defaultContextWindow ? formatCapacity(model.contextWindow) : undefined, inputLabel: model.name, hasOverride: status?.contextWindowOverrides[model.id] !== undefined, saving: savingModel === model.id }))}
        labels={{ tokens: t.tokens, save: t.save, saving: t.saving, reset: t.contextWindowReset, resetAll: t.contextWindowResetAll, empty: t.contextWindowNoneEnabled }}
        busy={busy !== null} overrideCount={Object.keys(status?.contextWindowOverrides ?? {}).length}
        onDraftChange={(id, draft) => setContextDrafts(current => ({ ...current, [id]: draft }))}
        onCommit={(id) => void saveContext(id)} onReset={(id) => void resetContext(id)} onResetAll={() => void resetAllContexts()}
      />
    </section>
    <LineProxySection line="opencode-go" />
    {error !== null && <p className="dsha-error" role="alert">{error}</p>}
  </div>
}
