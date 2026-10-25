/**
 * Compaction-model settings on this plugin's own page in the DSH plugin
 * manager.
 *
 * The setting is cross-line, so it does not belong inside any one provider's
 * tab: the plugin's page is where an operator configures *this plugin*, and the
 * bundle-config slot places it between the package description and the rows the
 * bundle declares.
 *
 * The slot is keyed by the bundle's package name, so the page dispatches it for
 * this package only — no subject filter is needed. It also renders its
 * occupants in the `summary` view (a one-liner beside the card); bundle
 * configuration has nothing to say there and renders null.
 *
 * @module dsh-chatgpt-subscription/compaction-route-bundle-config
 */
import { useEffect, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import { CompactionRouteCard } from './CompactionRouteCard.tsx'
import { SubscriptionApi } from './api.ts'
import type { SubscriptionPreferencesDto } from '../shared/contracts.ts'

/** The package whose page this entry configures. */
export const COMPACTION_ROUTE_PACKAGE = '@eddyskywalker/dsh-chatgpt-subscription'

/** The view the page asks a configuration entry for. */
export interface PluginConfigViewLike {
  readonly view: 'summary' | 'page'
}

/** Props the plugin-manager bundle page renders a configuration entry with. */
export type CompactionRouteBundleConfigProps =
  & PropsLocale<typeof NS>
  & PluginConfigViewLike

/**
 * Render the compaction-model card on this package's bundle page only.
 *
 * Split in two so the hooks below never mount for the summary view: that view
 * is a one-liner drawn beside the card, and fetching this plugin's preferences
 * for it would be a request nobody asked for.
 */
export function CompactionRouteBundleConfig(props: CompactionRouteBundleConfigProps): React.JSX.Element | null {
  if (props.view !== 'page') return null
  return <OwnedSection t={props.t} />
}

function OwnedSection({ t }: { readonly t: PropsLocale<typeof NS>['t'] }): React.JSX.Element {
  const [preferences, setPreferences] = useState<SubscriptionPreferencesDto | null>(null)
  const [api] = useState(() => new SubscriptionApi())

  useEffect(() => {
    let live = true
    void api.status()
      .then((status) => { if (live) setPreferences(status.preferences) })
      // A page that cannot read the status still renders the card; it then
      // starts from "no route configured" instead of failing the whole page.
      .catch(() => undefined)
    return () => { live = false }
  }, [api])

  return <CompactionRouteCard
    api={api}
    preferences={preferences}
    labels={{
      title: t('compactionRoute'),
      hint: t('compactionRouteHint'),
      provider: t('compactionRouteProvider'),
      model: t('compactionRouteModel'),
      save: t('compactionRouteSave'),
      clear: t('compactionRouteClear'),
      change: t('compactionRouteChange'),
      follow: t('compactionRouteFollow'),
      saved: t('compactionRouteSaved'),
      failed: t('compactionRouteFailed'),
      noVideo: t('compactionRouteNoVideo'),
      noImage: t('compactionRouteNoImage'),
      empty: t('compactionRouteEmpty'),
    }}
    onSaved={setPreferences}
  />
}
