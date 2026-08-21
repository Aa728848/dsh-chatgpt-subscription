import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SubagentModelCatalogDto, SubscriptionPreferencesDto, SubscriptionPreferencesUpdateDto } from '../shared/contracts.ts'
import { SUBAGENT_MAX_DEPTH_LIMIT } from '../shared/preferences.ts'
import { SubscriptionApi } from './api.ts'
import { NS } from './locales.ts'

type Props = PropsRuntime<'settings.section'> & PropsLocale<typeof NS>

export function SubagentSettingsSection({ t }: Props): React.JSX.Element {
  const apiRef = useRef(new SubscriptionApi())
  const [preferences, setPreferences] = useState<SubscriptionPreferencesDto | null>(null)
  const [catalog, setCatalog] = useState<SubagentModelCatalogDto | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [contextDraft, setContextDraft] = useState<string | null>(null)
  const [depthDraft, setDepthDraft] = useState<string | null>(null)
  const [agentsDraft, setAgentsDraft] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [status, models] = await Promise.all([apiRef.current.status(), apiRef.current.models()])
      setPreferences(status.preferences)
      setCatalog(models)
    } catch (cause) {
      setError(messageOf(cause))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const update = async (patch: SubscriptionPreferencesUpdateDto): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setPreferences(await apiRef.current.updatePreferences(patch))
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  const selectedProvider = catalog?.providers.find(provider => provider.id === preferences?.subagentProvider) ?? catalog?.providers[0]
  const selectedModel = selectedProvider?.models.find(model => model.id === preferences?.subagentModel) ?? selectedProvider?.models[0]
  const reasoning = selectedModel?.reasoning
  const selectedEffort = preferences?.subagentReasoningEffort ?? reasoning?.defaultEffort ?? reasoning?.efforts[0]?.id ?? ''
  const savedContext = preferences?.subagentContextWindow ?? selectedModel?.contextWindow ?? 1
  const parsedContext = parseCapacity(contextDraft ?? String(savedContext))
  const contextValid = parsedContext !== null && (selectedModel?.maxContextWindow === undefined || parsedContext <= selectedModel.maxContextWindow)
  const parsedDepthValue = parseNonNegativeInteger(depthDraft ?? String(preferences?.subagentMaxDepth ?? 0))
  const parsedDepth = parsedDepthValue !== null && parsedDepthValue <= SUBAGENT_MAX_DEPTH_LIMIT ? parsedDepthValue : null
  const parsedAgents = parsePositiveInteger(agentsDraft ?? String(preferences?.subagentMaxAgents ?? 1))

  return <section className="dsh-codex-page" aria-labelledby="dsh-subagent-title">
    <header>
      <h2 id="dsh-subagent-title" className="dsh-codex-title">{t('subagentSettingsTitle')}</h2>
      <p className="dsh-codex-intro">{t('subagentSettingsIntro')}</p>
    </header>

    {error !== null ? <div className="dsh-codex-errorbar" role="alert">
      <span>{error}</span>
      {preferences === null ? <button className="dsh-codex-button" type="button" onClick={() => void load()}>{t('retry')}</button> : null}
    </div> : null}

    {preferences === null || catalog === null
      ? <div className="dsh-codex-skeleton" role="status" aria-label={t('loading')}><span /><span /></div>
      : <>
        <section className="dsh-codex-group">
          <div className="dsh-codex-grouphead"><h3>{t('subagentModelGroup')}</h3></div>
          <div className="dsh-codex-pref-row">
            <div><strong>{t('subagentProvider')}</strong><p className="dsh-codex-muted">{t('subagentProviderHint')}</p></div>
            <select className="dsh-codex-select" aria-label={t('subagentProvider')} value={selectedProvider?.id ?? ''} disabled={busy || selectedProvider === undefined} onChange={(event) => {
              const provider = catalog.providers.find(entry => entry.id === event.currentTarget.value)
              const model = provider?.models[0]
              if (provider === undefined || model === undefined) return
              const effort = model.reasoning?.defaultEffort ?? model.reasoning?.efforts[0]?.id ?? null
              setContextDraft(null)
              void update({ subagentProvider: provider.id, subagentModel: model.id, subagentReasoningEffort: effort, subagentContextWindow: model.contextWindow ?? 1 })
            }}>
              {catalog.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
            </select>
          </div>
          <div className="dsh-codex-pref-row">
            <div><strong>{t('subagentModel')}</strong><p className="dsh-codex-muted">{t('subagentModelHint')}</p></div>
            <select className="dsh-codex-select" aria-label={t('subagentModel')} value={selectedModel?.id ?? ''} disabled={busy || selectedModel === undefined} onChange={(event) => {
              const model = selectedProvider?.models.find(entry => entry.id === event.currentTarget.value)
              if (selectedProvider === undefined || model === undefined) return
              const effort = model.reasoning?.defaultEffort ?? model.reasoning?.efforts[0]?.id ?? null
              setContextDraft(null)
              void update({ subagentProvider: selectedProvider.id, subagentModel: model.id, subagentReasoningEffort: effort, subagentContextWindow: model.contextWindow ?? 1 })
            }}>
              {selectedProvider?.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select>
          </div>
          <div className="dsh-codex-pref-row">
            <div><strong>{t('subagentReasoningEffort')}</strong><p className="dsh-codex-muted">{t('subagentReasoningEffortHint')}</p></div>
            {reasoning !== undefined && reasoning.efforts.length > 0
              ? <select className="dsh-codex-select" aria-label={t('subagentReasoningEffort')} value={selectedEffort} disabled={busy} onChange={(event) => void update({ subagentReasoningEffort: event.currentTarget.value })}>
                  {reasoning.efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
                </select>
              : <span className="dsh-codex-muted">{t('providerDefault')}</span>}
          </div>
          {selectedModel?.contextWindow !== undefined ? <div className="dsh-codex-context-settings">
            <div><strong>{t('effectiveContextWindow')}</strong><p className="dsh-codex-muted">{t('selectedModelContextHint')}</p></div>
            <div className="dsh-codex-context-row">
              <label htmlFor="dsh-subagent-context">{selectedModel.name}</label>
              <span className="dsh-codex-capacity-control">
                <input id="dsh-subagent-context" type="text" inputMode="numeric" value={contextDraft ?? formatCapacity(savedContext)} disabled={busy} onChange={(event) => setContextDraft(event.currentTarget.value)} />
                <small>{t('tokens')}</small>
                <button className="dsh-codex-context-save" type="button" disabled={busy || contextDraft === null || !contextValid || parsedContext === savedContext} onClick={() => {
                  if (parsedContext === null) return
                  void update({ subagentContextWindow: parsedContext }).then(() => setContextDraft(null))
                }}>{t('save')}</button>
              </span>
            </div>
          </div> : null}
        </section>

        <section className="dsh-codex-group">
          <div className="dsh-codex-grouphead"><h3>{t('subagentLimitsGroup')}</h3></div>
          <div className="dsh-codex-context-settings">
            <div><strong>{t('subagentMaxDepth')}</strong><p className="dsh-codex-muted">{t('subagentMaxDepthHint')}</p></div>
            <div className="dsh-codex-context-row">
              <label htmlFor="dsh-subagent-depth">{t('subagentMaxDepth')}</label>
              <span className="dsh-codex-capacity-control">
                <input id="dsh-subagent-depth" type="number" min="0" max={SUBAGENT_MAX_DEPTH_LIMIT} step="1" inputMode="numeric" value={depthDraft ?? String(preferences.subagentMaxDepth)} disabled={busy} onChange={(event) => setDepthDraft(event.currentTarget.value)} />
                <small>{t('levels')}</small>
                <button className="dsh-codex-context-save" type="button" disabled={busy || depthDraft === null || parsedDepth === null || parsedDepth === preferences.subagentMaxDepth} onClick={() => {
                  if (parsedDepth === null) return
                  void update({ subagentMaxDepth: parsedDepth }).then(() => setDepthDraft(null))
                }}>{t('save')}</button>
              </span>
            </div>
          </div>
          <div className="dsh-codex-context-settings">
            <div><strong>{t('subagentMaxAgents')}</strong><p className="dsh-codex-muted">{t('subagentMaxAgentsHint')}</p></div>
            <div className="dsh-codex-context-row">
              <label htmlFor="dsh-subagent-agents">{t('subagentMaxAgents')}</label>
              <span className="dsh-codex-capacity-control">
                <input id="dsh-subagent-agents" type="number" min="1" step="1" inputMode="numeric" value={agentsDraft ?? String(preferences.subagentMaxAgents)} disabled={busy} onChange={(event) => setAgentsDraft(event.currentTarget.value)} />
                <small>{t('agents')}</small>
                <button className="dsh-codex-context-save" type="button" disabled={busy || agentsDraft === null || parsedAgents === null || parsedAgents === preferences.subagentMaxAgents} onClick={() => {
                  if (parsedAgents === null) return
                  void update({ subagentMaxAgents: parsedAgents }).then(() => setAgentsDraft(null))
                }}>{t('save')}</button>
              </span>
            </div>
          </div>
          <p className="dsh-codex-notice">{t('subagentLimitsNotice')}</p>
        </section>
      </>}
  </section>
}

export function parseNonNegativeInteger(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null
  const parsed = Number(value.trim())
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

export function parsePositiveInteger(value: string): number | null {
  const parsed = parseNonNegativeInteger(value)
  return parsed !== null && parsed >= 1 ? parsed : null
}

export function parseCapacity(value: string): number | null {
  const matched = value.trim().toLowerCase().replace(/[,_\s]/g, '').match(/^(\d+(?:\.\d+)?)(k|m)?$/)
  if (matched === null) return null
  const multiplier = matched[2] === 'm' ? 1_000_000 : matched[2] === 'k' ? 1_000 : 1
  const parsed = Number(matched[1]) * multiplier
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null
}

function formatCapacity(value: number): string {
  if (value % 1_000_000 === 0) return `${value / 1_000_000}M`
  if (value % 1_000 === 0) return `${value / 1_000}K`
  return String(value)
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
