/**
 * The proxy card one provider line owns.
 *
 * Before this component the plugin had ONE proxy setting for all thirteen
 * lines, rendered inside the ChatGPT card. A Chinese mixed network needs the
 * opposite: the foreign lines go through the local Clash, a domestic endpoint
 * must not. Flipping the shared setting repainted every line at once, and the
 * "direct" side effect (bare `fetch`) silently changed whether other middleware
 * saw the traffic at all.
 *
 * One component serves every line so the twelve cards cannot drift: each passes
 * its own provider id and reads/writes the same preference shape through the
 * same plugin route. The copy lives in the plugin's own namespace (zh + en
 * built in, ru in the language pack), so a line card does not have to carry a
 * second dictionary just for this section.
 *
 * The BYPASS list is deliberately NOT per-line: a bypass is a host-level fact
 * ("`copilot.tencent.com` is reachable directly"), and thirteen copies of it
 * would mean a user fixes one line and leaves twelve broken. Every card shows
 * the same list and says so.
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/common/LineProxySection
 */
import React, { useCallback, useEffect, useState } from 'react'
import type {
  ApiEnvelope,
  LineProxyConfigDto,
  LineProxyProviderId,
  LineProxiesDto,
  ProxyMode,
  SubscriptionPreferencesDto,
  SubscriptionPreferencesUpdateDto,
} from '../../shared/contracts.ts'
import { ROUTE_PREFIX } from '../../compat.ts'
import { NS, zh } from '../providers/codex-chatgpt/locales.ts'
import { useLineDict } from './line-locale.ts'

/** The proxy facts one provider page needs, as `GET /proxy` answers them. */
export interface LineProxySnapshot {
  lineProxies: LineProxiesDto
  noProxy: string | null
  detectedProxy: string | null
  activeProxies: Partial<Record<LineProxyProviderId, string | null>>
}

export interface LineProxySectionProps {
  /** Provider id this card writes to; must be one of LINE_PROXY_PROVIDER_IDS. */
  line: LineProxyProviderId
  /**
   * Read the shared snapshot; called on mount and after every save.
   * Defaults to this plugin's own `/proxy` route.
   */
  fetchSnapshot?: () => Promise<LineProxySnapshot>
  /** Save one preference patch. Defaults to this plugin's `/preferences/update`. */
  onSave?: (patch: SubscriptionPreferencesUpdateDto) => Promise<void>
  /** Distinguishes the input ids when several cards are mounted at once. */
  idPrefix?: string
  /**
   * A snapshot the card already holds (the ChatGPT tab reads one with its
   * status), which removes the extra request and keeps that card speaking
   * only to its own routes. Absent means "read `/proxy`".
   */
  snapshot?: LineProxySnapshot | null
}

/**
 * The proxy card for one provider line: mode, custom address, and the shared
 * bypass list.
 *
 * Drafts are local so typing does not round-trip; saving posts the field and
 * clears the draft once the host has answered with the canonical form (the host
 * normalizes the list and the URL, and what it answers is what the matcher
 * reads).
 */
export function LineProxySection({ line, fetchSnapshot, onSave, idPrefix, snapshot: provided }: LineProxySectionProps): React.JSX.Element {
  const labels = useLineDict(NS, zh)
  // Both defaults must keep a stable identity: an inline arrow here would make
  // `reload` change on every render, and the effect that calls it would fetch
  // (and setState) forever.
  const readSnapshotFromRoute = useCallback(
    () => (fetchSnapshot ?? (() => fetchLineProxySnapshot(ROUTE_PREFIX)))(),
    [fetchSnapshot],
  )
  const writePreferences = useCallback(
    (patch: SubscriptionPreferencesUpdateDto) => (onSave ?? ((next: SubscriptionPreferencesUpdateDto) => savePreferences(ROUTE_PREFIX, next)))(patch),
    [onSave],
  )
  const [readSnapshot, setReadSnapshot] = useState<LineProxySnapshot | null>(null)
  const snapshot = provided !== undefined ? provided : readSnapshot
  const [customDraft, setCustomDraft] = useState<string | null>(null)
  const [noProxyDraft, setNoProxyDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState<'line' | 'bypass' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const prefix = idPrefix ?? line

  const reload = useCallback(async (): Promise<void> => {
    if (provided !== undefined) return
    try {
      setReadSnapshot(await readSnapshotFromRoute())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [provided, readSnapshotFromRoute])

  useEffect(() => {
    void reload()
  }, [reload])

  const config: LineProxyConfigDto | null = snapshot?.lineProxies?.[line] ?? null
  const mode: ProxyMode = config?.mode ?? 'auto'
  const activeProxy = snapshot?.activeProxies?.[line] ?? null

  const save = async (kind: 'line' | 'bypass', patch: SubscriptionPreferencesUpdateDto): Promise<void> => {
    setSaving(kind)
    setError(null)
    try {
      await writePreferences(patch)
      if (kind === 'line') setCustomDraft(null)
      else setNoProxyDraft(null)
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(null)
    }
  }

  const saveUrl = (): void => {
    const draft = customDraft?.trim()
    void save('line', { lineProxies: { [line]: { mode: 'custom', customProxyUrl: draft ? draft : null } } })
  }

  const saveBypass = (): void => {
    const draft = noProxyDraft?.trim()
    void save('bypass', { noProxy: draft ? draft : null })
  }

  return <section className="dsha-group" data-line-proxy={line}>
    <div className="dsha-grouphead"><h3>{labels.proxySettings}</h3></div>
    <div className="dsha-pref-row">
      <div>
        <strong>{labels.proxyMode}</strong>
        <p className="dsha-muted">{labels.proxyModeHint}</p>
      </div>
      <select
        className="dsha-select"
        aria-label={labels.proxyMode}
        value={mode}
        disabled={saving !== null}
        onChange={(event) => {
          const next = event.currentTarget.value as ProxyMode
          void save('line', {
            lineProxies: {
              [line]: { mode: next, customProxyUrl: next === 'custom' ? (config?.customProxyUrl ?? null) : null },
            },
          })
        }}
      >
        <option value="auto">{labels.proxyModeAuto}</option>
        <option value="custom">{labels.proxyModeCustom}</option>
        <option value="direct">{labels.proxyModeDirect}</option>
      </select>
    </div>

    {mode === 'custom' ? <div className="dsha-context-settings">
      <div>
        <strong>{labels.customProxyUrl}</strong>
        <p className="dsha-muted">{labels.customProxyUrlHint}</p>
      </div>
      <div>
        <span className="dsh-codex-proxy-control">
          <input
            id={`${prefix}-proxy-url`}
            type="text"
            placeholder={labels.customProxyUrlPlaceholder}
            value={customDraft ?? (config?.customProxyUrl ?? '')}
            disabled={saving !== null}
            aria-label={labels.customProxyUrl}
            onChange={(event) => setCustomDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              saveUrl()
            }}
          />
          <button
            className="dsha-context-save"
            type="button"
            aria-label={labels.saveProxyUrl}
            disabled={saving !== null || customDraft === null}
            onClick={saveUrl}
          >
            {labels.save}
          </button>
        </span>
      </div>
    </div> : null}

    <p className="dsha-muted" data-line-proxy-active={line}>
      {activeProxy === null ? labels.proxyDirectActive : labels.proxyActiveTemplate.replace('{proxy}', activeProxy)}
    </p>

    <div className="dsha-context-settings" data-proxy-bypass>
      <div>
        <strong>{labels.noProxy}</strong>
        <p className="dsha-muted">{labels.noProxyHint}</p>
      </div>
      <div>
        <span className="dsh-codex-proxy-control">
          <input
            id={`${prefix}-no-proxy`}
            type="text"
            placeholder={labels.noProxyPlaceholder}
            value={noProxyDraft ?? (snapshot?.noProxy ?? '')}
            disabled={saving !== null}
            aria-label={labels.noProxy}
            onChange={(event) => setNoProxyDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              saveBypass()
            }}
          />
          <button
            className="dsha-context-save"
            type="button"
            aria-label={labels.saveNoProxy}
            disabled={saving !== null || noProxyDraft === null}
            onClick={saveBypass}
          >
            {labels.save}
          </button>
        </span>
      </div>
    </div>
    {error === null ? null : <p className="dsh-codex-error" role="status">{error}</p>}
  </section>
}

/**
 * Read that snapshot from the plugin's own proxy route.
 *
 * The same route serves every card, so saving from one card and reading from
 * another always sees the same document.
 * @param base - Plugin route prefix (`ROUTE_PREFIX`).
 * @returns the parsed snapshot.
 */
export async function fetchLineProxySnapshot(base: string): Promise<LineProxySnapshot> {
  const response = await fetch(`${base}/proxy`, { credentials: 'same-origin' })
  const envelope = await response.json() as ApiEnvelope<LineProxySnapshot>
  if (!response.ok || !envelope.ok) {
    throw new Error(envelope.ok ? `Proxy settings route failed (HTTP ${response.status})` : envelope.error.message)
  }
  return envelope.value
}

/**
 * Write one preferences patch through the plugin route.
 * @param base - Plugin route prefix (`ROUTE_PREFIX`).
 * @param patch - Preferences to merge.
 * @returns the refreshed preferences.
 */
export async function savePreferences(base: string, patch: SubscriptionPreferencesUpdateDto): Promise<SubscriptionPreferencesDto> {
  const response = await fetch(`${base}/preferences/update`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const envelope = await response.json() as ApiEnvelope<SubscriptionPreferencesDto>
  if (!response.ok || !envelope.ok) {
    throw new Error(envelope.ok ? `Saving the proxy setting failed (HTTP ${response.status})` : envelope.error.message)
  }
  return envelope.value
}
