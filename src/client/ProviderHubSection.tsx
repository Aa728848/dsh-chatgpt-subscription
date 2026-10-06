import { useCallback, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import { HubOverview } from './hub/HubOverview.tsx'
import { hubProviderDescriptor, HUB_PROVIDERS } from './hub/providers.tsx'
import type { HubProviderId } from './hub/brand-icons.tsx'

type Props = PropsRuntime<'settings.section'> & PropsLocale<typeof NS> & {
  onModelChange?: () => void
}

type HubView = { view: 'overview' } | { view: 'detail'; id: HubProviderId }

const STORAGE_KEY = 'dsh-chatgpt-subscription:hub-view'

/**
 * The detail page a user was last on survives a settings-page remount, so a
 * provider toggle deep in a detail page never throws them back to the
 * overview. Session storage, not local: a new browser session starts at the
 * overview, which is the page's whole point.
 */
function readStoredView(): HubView {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (raw === null) return { view: 'overview' }
    const parsed = JSON.parse(raw) as { view?: string; id?: string }
    if (parsed.view !== 'detail' || typeof parsed.id !== 'string') return { view: 'overview' }
    // A provider the registry no longer knows (renamed, removed) falls back
    // to the overview rather than stranding the page on an empty panel.
    return hubProviderDescriptor(parsed.id) === undefined ? { view: 'overview' } : { view: 'detail', id: parsed.id as HubProviderId }
  } catch {
    return { view: 'overview' }
  }
}

function storeView(view: HubView): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(view))
  } catch {
    // Storage can be unavailable (private mode); navigation still works.
  }
}

const BACK_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4l-4 4 4 4"/></svg>'

/**
 * Single settings page hosting every subscription provider. The opening
 * screen is the overview — one card per line with its enable switch and
 * account count — and picking a card replaces it with that line's detail
 * page under a back bar. Only the active view is mounted, mirroring the
 * shell's behavior of mounting just the selected settings page (each
 * provider section refetches its status on mount).
 */
export function ProviderHubSection({ t, onModelChange, ...runtime }: Props): React.JSX.Element {
  const [view, setView] = useState<HubView>(readStoredView)

  const open = useCallback((id: HubProviderId): void => {
    const next: HubView = { view: 'detail', id }
    storeView(next)
    setView(next)
  }, [])

  const back = useCallback((): void => {
    const next: HubView = { view: 'overview' }
    storeView(next)
    setView(next)
  }, [])

  if (view.view === 'overview') {
    return <section className="dsh-codex-page" aria-labelledby="dsh-hub-title">
      <header>
        <h2 id="dsh-hub-title" className="dsh-codex-title">{t('hubTitle')}</h2>
      </header>
      <HubOverview t={t} onOpen={open} />
    </section>
  }

  const descriptor = hubProviderDescriptor(view.id) ?? HUB_PROVIDERS[0]
  return <section className="dsh-codex-page" aria-labelledby="dsh-hub-detail-name">
    <nav className="dsh-hub-backbar">
      <button type="button" className="dsh-hub-back" onClick={back} aria-label={t('hubBack')}>
        <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: BACK_SVG }} />
        {t('hubBack')}
      </button>
      <span className="dsh-hub-backbar-name" id="dsh-hub-detail-name">{descriptor.name}</span>
    </nav>
    <div className="dsh-hub-detail">
      {descriptor.renderDetail({ t, onModelChange, runtime })}
    </div>
  </section>
}
