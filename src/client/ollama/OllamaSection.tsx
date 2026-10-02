import React, { useCallback, useEffect, useState } from 'react'
import { AccountPoolSection } from '../common/AccountPoolSection.tsx'
import type { AccountRotationStrategy } from '../../shared/account-pool-contracts.ts'
import type { OllamaWebStatus } from '../../shared/ollama-contracts.ts'
import { OllamaApi } from './api.ts'
import { zh } from './locales.ts'

const API = new OllamaApi()

interface Props {
  onModelChange?: () => void
  loadModelDirectory?: () => void
}

/**
 * The Ollama tab.
 *
 * Deliberately thin. The account card, its badges, the rotation picker and the
 * storage notice are the shared {@link AccountPoolSection}, so this line looks
 * like every other provider tab by construction rather than by imitation; only
 * what is genuinely Ollama's - pasting a key, syncing the catalog, and the
 * documented service limits - is written here.
 */
export function OllamaSection(props: Props): React.ReactElement {
  const [status, setStatus] = useState<OllamaWebStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [key, setKey] = useState('')
  const [alias, setAlias] = useState('')
  const [showKeyForm, setShowKeyForm] = useState(false)

  const reload = useCallback(async () => {
    try {
      setStatus(await API.status())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const run = useCallback(async (label: string, action: () => Promise<OllamaWebStatus>) => {
    setBusy(label)
    setError(null)
    try {
      setStatus(await action())
      props.onModelChange?.()
      props.loadModelDirectory?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }, [props])

  const addKey = useCallback(() => {
    const trimmed = key.trim()
    if (trimmed === '') return
    void run('add', async () => {
      const next = await API.accountAction('add', {
        apiKey: trimmed,
        ...(alias.trim() === '' ? {} : { alias: alias.trim() }),
      })
      // Cleared only after the host accepted it, so a failed add never loses the
      // key the user just pasted and would have to find again.
      setKey('')
      setAlias('')
      setShowKeyForm(false)
      return next
    })
  }, [key, alias, run])

  const syncCatalog = useCallback(() => {
    void run('catalog', async () => {
      await API.refreshCatalog()
      return API.status()
    })
  }, [run])

  const t = zh
  const pool = status?.pool

  return (
    <div>
      <div className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.title}</h3>
        </div>
        <p className="dsha-notice">{t.pageDesc}</p>
        <div className="dsha-row">
          <span className="dsha-label">{t.provider}</span>
          <span className="dsha-value">{t.providerValue}</span>
        </div>
        {error !== null && (
          <p className="dsha-notice" style={{ color: 'var(--dsha-danger, #c0392b)' }}>
            {t.error.replace('{detail}', error)}
          </p>
        )}
      </div>

      {pool !== undefined && (
        <AccountPoolSection
          accounts={pool.accounts}
          activeAccountId={pool.activeAccountId}
          rotationStrategy={pool.rotationStrategy}
          labels={t}
          busy={busy}
          onLogin={() => setShowKeyForm(value => !value)}
          onSetPrimary={(id) => void run('set-primary', () => API.accountAction('set-primary', { accountId: id }))}
          onDelete={(id) => void run('delete', () => API.accountAction('delete', { accountId: id }))}
          onClearCooldown={(id) => void run('clear-cooldown', () => API.accountAction('clear-cooldown', { accountId: id }))}
          onSetStrategy={(strategy: AccountRotationStrategy) =>
            void run('strategy', () => API.accountAction('strategy', { strategy }))}
          renderDetails={(account) => (
            <>{account.lastModelId !== undefined && <span>{t.lastModel}: {account.lastModelId}</span>}</>
          )}
          renderLoginActions={() => (
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="dsha-btn dsha-btn-primary"
                disabled={busy !== null}
                onClick={() => setShowKeyForm(value => !value)}
              >
                {t.addAccount}
              </button>
            </div>
          )}
        >
          {showKeyForm && (
            <div className="dsha-pref-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
              <label className="dsha-label" htmlFor="ollama-key">{t.keySection}</label>
              <input
                id="ollama-key"
                className="dsha-input"
                type="password"
                value={key}
                placeholder={t.keyPlaceholder}
                autoComplete="off"
                onChange={(event) => setKey(event.target.value)}
              />
              <label className="dsha-label" htmlFor="ollama-alias">{t.keyAliasLabel}</label>
              <input
                id="ollama-alias"
                className="dsha-input"
                value={alias}
                placeholder={t.keyAliasPlaceholder}
                onChange={(event) => setAlias(event.target.value)}
              />
              <p className="dsha-muted" style={{ fontSize: 12 }}>{t.keyHint}</p>
              <p className="dsha-muted" style={{ fontSize: 12 }}>{t.keyAliasHint}</p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="dsha-btn dsha-btn-primary"
                  disabled={busy !== null || key.trim() === ''}
                  onClick={addKey}
                >
                  {busy === 'add' ? t.keySaving : t.keySave}
                </button>
                <button className="dsha-btn" disabled={busy !== null} onClick={() => setShowKeyForm(false)}>
                  {zh.deleteAccount}
                </button>
              </div>
            </div>
          )}
        </AccountPoolSection>
      )}

      <div className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.modelsSection}</h3>
          <button className="dsha-btn" disabled={busy !== null} onClick={syncCatalog}>
            {busy === 'catalog' ? t.catalogSyncing : t.catalogSync}
          </button>
        </div>
        <p className="dsha-muted" style={{ fontSize: 12 }}>{t.modelsHint}</p>
        <p className="dsha-muted" style={{ fontSize: 12 }}>{t.wireNote}</p>
        {status !== null && status.models.length === 0 && (
          <div className="dsha-empty">
            {status.catalogSynced ? t.catalogEmpty : t.catalogNeverSynced}
          </div>
        )}
        {status !== null && status.models.length > 0 && (
          <p className="dsha-muted" style={{ fontSize: 12 }}>
            {t.modelCount.replace('{count}', String(status.models.length))}
          </p>
        )}
      </div>

      <div className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.limitsSection}</h3>
        </div>
        <p className="dsha-muted" style={{ fontSize: 12 }}>{t.limitsHint}</p>
        <ul className="dsha-notice" style={{ paddingLeft: 18 }}>
          <li>{t.limitNoStateful}</li>
          <li>{t.limitNoWebSearch}</li>
          <li>{t.limitNoToolReplay}</li>
          <li>{t.limitUsage}</li>
        </ul>
      </div>
    </div>
  )
}