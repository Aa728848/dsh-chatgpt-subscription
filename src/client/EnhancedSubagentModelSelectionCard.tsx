import React, { useCallback, useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SubscriptionApi } from './api.ts'
import type { PluginStatusDto, ProviderCatalogGroupDto } from '../shared/contracts.ts'
import { NS, reasoningEffortLabel } from './locales.ts'

export type EnhancedSubagentModelSelectionCardProps =
  PropsRuntime<'settings.plugins.tab'> &
  PropsLocale<typeof NS>

export function EnhancedSubagentModelSelectionCard(props: EnhancedSubagentModelSelectionCardProps) {
  const t = props.t
  const [status, setStatus] = useState<PluginStatusDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [maxDepth, setMaxDepth] = useState<number | null>(null)
  const [contextBudget, setContextBudget] = useState<number | null>(null)
  const [modelEfforts, setModelEfforts] = useState<Record<string, string | null>>({})
  const [dirty, setDirty] = useState(false)

  const api = React.useMemo(() => new SubscriptionApi(), [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const next = await api.status()
      setStatus(next)
      setMaxDepth(next.preferences.subagentMaxDepth ?? null)
      setContextBudget(next.preferences.subagentContextWindow ?? null)
      setModelEfforts(next.preferences.subagentModelEfforts ?? {})
      setDirty(false)
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  const handleSave = async () => {
    setSaving(true)
    try {
      const updated = await api.updatePreferences({
        subagentMaxDepth: maxDepth,
        subagentContextWindow: contextBudget,
        subagentModelEfforts: modelEfforts,
      })
      setStatus(prev => prev ? { ...prev, preferences: updated } : null)
      setDirty(false)
    } finally {
      setSaving(false)
    }
  }

  const handleDiscard = () => {
    if (!status) return
    setMaxDepth(status.preferences.subagentMaxDepth ?? null)
    setContextBudget(status.preferences.subagentContextWindow ?? null)
    setModelEfforts(status.preferences.subagentModelEfforts ?? {})
    setDirty(false)
  }

  const handleEffortChange = (modelKey: string, effort: string | null) => {
    setModelEfforts(prev => ({
      ...prev,
      [modelKey]: effort,
    }))
    setDirty(true)
  }

  const groups: ProviderCatalogGroupDto[] = status?.allProviders ?? []

  return (
    <div className="dsh-codex-card" style={{ padding: '16px 20px', maxWidth: 840 }}>
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 600 }}>{t('subagentEnhancements')}</h3>
        <p className="dsh-codex-muted" style={{ margin: 0, fontSize: 13 }}>
          {t('allSubagentReasoningHint')}
        </p>
      </div>

      {loading ? (
        <p className="dsh-codex-muted">{t('loading')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Global limits */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, padding: 12, background: 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.03))', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.08))' }}>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{t('subagentMaxDepth')}</label>
              <select
                className="dsh-codex-select"
                aria-label={t('subagentMaxDepth')}
                value={maxDepth === null || maxDepth === undefined ? '' : String(maxDepth)}
                disabled={saving}
                onChange={(e) => {
                  const val = e.currentTarget.value
                  setMaxDepth(val === '' ? null : Number(val))
                  setDirty(true)
                }}
                style={{ width: '100%' }}
              >
                <option value="">{t('providerDefault')} (3 {t('levels')})</option>
                <option value="0">0 ({t('subagentDisabled')})</option>
                <option value="1">1 {t('levels')}</option>
                <option value="2">2 {t('levels')}</option>
                <option value="3">3 {t('levels')}</option>
              </select>
              <small className="dsh-codex-muted" style={{ display: 'block', marginTop: 4, fontSize: 11 }}>{t('subagentMaxDepthHint')}</small>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{t('subagentContextWindow')}</label>
              <input
                type="number"
                placeholder={t('providerDefault')}
                value={contextBudget ?? ''}
                disabled={saving}
                onChange={(e) => {
                  const val = e.currentTarget.value
                  setContextBudget(val === '' ? null : Number(val))
                  setDirty(true)
                }}
                className="dsh-codex-select"
                style={{ width: '100%' }}
              />
              <small className="dsh-codex-muted" style={{ display: 'block', marginTop: 4, fontSize: 11 }}>{t('subagentContextWindowHint')}</small>
            </div>
          </div>

          {/* Model provider list */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {groups.map((group) => (
              <div key={group.id} style={{ border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.1))', borderRadius: 8, padding: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-brand-primary, #4b89ff)', marginBottom: 8 }}>
                  {group.name}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {group.models.map((model) => {
                    const modelKey = `${group.id}/${model.id}`
                    const currentEffort = modelEfforts[modelKey] ?? ''
                    const hasEfforts = model.reasoningEfforts.length > 0
                    return (
                      <div
                        key={modelKey}
                        className="dsh-codex-pref-row"
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '6px 4px',
                          borderBottom: '1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.04))',
                        }}
                      >
                        <div>
                          <strong style={{ display: 'block', fontSize: 13 }}>{model.name}</strong>
                          <small className="dsh-codex-muted" style={{ display: 'block', fontSize: 11 }}>{modelKey}</small>
                        </div>
                        {hasEfforts ? (
                          <select
                            className="dsh-codex-select"
                            aria-label={`${model.name} ${t('subagentReasoningEffort')}`}
                            value={currentEffort}
                            disabled={saving}
                            onChange={(e) => {
                              const val = e.currentTarget.value
                              handleEffortChange(modelKey, val === '' ? null : val)
                            }}
                            style={{ minWidth: 130 }}
                          >
                            <option value="">{t('providerDefault')}</option>
                            {model.reasoningEfforts.map((effort) => (
                              <option key={effort} value={effort}>
                                {reasoningEffortLabel(effort, t as never)}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="dsh-codex-muted" style={{ fontSize: 12 }}>-</span>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* Action bar */}
          {dirty ? (
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 10 }}>
              <button className="dsh-codex-button" type="button" disabled={saving} onClick={handleDiscard}>
                {t('discard')}
              </button>
              <button className="dsh-codex-button primary" type="button" disabled={saving} onClick={handleSave}>
                {saving ? t('saving') : t('save')}
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
