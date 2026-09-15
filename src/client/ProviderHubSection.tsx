import { useCallback, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { CodexSubscriptionSection } from './CodexSubscriptionSection.tsx'
import { AntigravitySection } from './antigravity/AntigravitySection.tsx'
import { CommandCodeSection } from './command-code/CommandCodeSection.tsx'
import { KimiCodeSection } from './kimi-code/KimiCodeSection.tsx'
import { NS } from './locales.ts'

type Props = PropsRuntime<'settings.section'> & PropsLocale<typeof NS> & {
  onModelChange?: () => void
}

type HubTabId = 'chatgpt' | 'antigravity' | 'command-code' | 'kimi-code'

// Brand names stay literal: the former standalone sidebar entries used the
// same hardcoded labels, and every provider section except ChatGPT is
// zh-only today.
const HUB_TABS: ReadonlyArray<{ id: HubTabId; label: string }> = [
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'command-code', label: 'Command Code' },
  { id: 'kimi-code', label: 'Kimi Code' },
]

/**
 * Single settings page that hosts every subscription provider behind tabs,
 * so the settings sidebar shows one entry instead of one per provider. Only
 * the active tab is mounted, mirroring the shell's previous behavior of
 * mounting just the selected settings page (each provider section refetches
 * its status on mount).
 */
export function ProviderHubSection({ t, onModelChange, ...runtime }: Props): React.JSX.Element {
  const [active, setActive] = useState<HubTabId>('chatgpt')

  const onTabKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const index = HUB_TABS.findIndex((tab) => tab.id === active)
    const delta = event.key === 'ArrowRight' ? 1 : -1
    const next = HUB_TABS[(index + delta + HUB_TABS.length) % HUB_TABS.length]
    setActive(next.id)
    document.getElementById(`dsh-hub-tab-${next.id}`)?.focus()
  }, [active])

  return <section className="dsh-codex-page" aria-labelledby="dsh-hub-title">
    <header>
      <h2 id="dsh-hub-title" className="dsh-codex-title">{t('hubTitle')}</h2>
    </header>
    <div className="dsh-codex-segments dsh-hub-tabs" role="tablist" aria-label={t('hubTitle')}>
      {HUB_TABS.map((tab) => <button
        key={tab.id}
        type="button"
        role="tab"
        id={`dsh-hub-tab-${tab.id}`}
        aria-selected={active === tab.id}
        aria-controls={`dsh-hub-panel-${tab.id}`}
        className={active === tab.id ? 'active' : undefined}
        tabIndex={active === tab.id ? 0 : -1}
        onClick={() => setActive(tab.id)}
        onKeyDown={onTabKeyDown}
      >{tab.label}</button>)}
    </div>
    <div role="tabpanel" id={`dsh-hub-panel-${active}`} aria-labelledby={`dsh-hub-tab-${active}`}>
      {active === 'chatgpt' ? <CodexSubscriptionSection t={t} {...runtime} /> : null}
      {active === 'antigravity' ? <AntigravitySection onModelChange={onModelChange} /> : null}
      {active === 'command-code' ? <CommandCodeSection onModelChange={onModelChange} /> : null}
      {active === 'kimi-code' ? <KimiCodeSection onModelChange={onModelChange} /> : null}
    </div>
  </section>
}
