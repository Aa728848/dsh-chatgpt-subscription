import React from 'react'
import { ComposerQuotaBadge, type ComposerQuotaFacts } from '../common/ComposerQuotaBadge.tsx'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { SnapshotStore } from '../store.ts'
import type { AntigravityAcpStatusDto } from '../../shared/antigravity-acp-contracts.ts'
import { AntigravityAcpApi } from './api.ts'
import { zh, NS_ANTIGRAVITY_ACP } from './locales.ts'
import { useLineDict } from '../common/line-locale.ts'
import { PROVIDER_ROUTE_ID } from './route.ts'

const API = new AntigravityAcpApi()

/**
 * The status shape the shared badge understands.
 *
 * The shared badge keys on a top-level `authenticated` flag because that is what
 * every account-pool line answers. This line's status nests it under `auth`,
 * because its sign-in state is a different thing (the official process's, not a
 * pool row's) - so the flag is hoisted here rather than reshaping the wire
 * contract to fit a shared component.
 */
interface BadgeStatus extends AntigravityAcpStatusDto {
  authenticated: boolean
}

interface Props {
  directory: SnapshotStore<ModelDirectoryState>
  loadModelDirectory(): void
}

/**
 * The composer badge for the Antigravity line.
 *
 * It shows what the official server actually reported - plan tier and the last
 * turn's token counts - and nothing else. There is deliberately no percentage:
 * ACP publishes no remaining quota, and a badge that invented one would be the
 * single most misleading pixel on the page.
 */
export function AntigravityAcpComposerBadge(props: Props): React.JSX.Element {
  const t = useLineDict(NS_ANTIGRAVITY_ACP, zh)
  return <ComposerQuotaBadge<BadgeStatus>
    directory={props.directory}
    loadModelDirectory={props.loadModelDirectory}
    providerId={PROVIDER_ROUTE_ID}
    label={t.title}
    readStatus={async (refresh) => {
      const status = refresh ? await API.refresh() : await API.status()
      return { ...status, authenticated: status.auth.authenticated }
    }}
    selectFacts={(status) => (status === null ? null : factsFor(status, t))}
  />
}

/** What the badge says for one status read; null means there is nothing honest to show. */
export function factsFor(status: BadgeStatus, t: typeof zh): ComposerQuotaFacts | null {
  const tier = status.auth.tier
  const usage = status.usage
  if (status.auth.authenticated !== true) return null
  if (tier === undefined && usage === undefined) return null
  const parts: string[] = []
  if (tier !== undefined) parts.push(tier.name)
  if (usage !== undefined) {
    parts.push(t.usageInput.replace('{tokens}', compact(usage.inputTokens)))
    parts.push(t.usageOutput.replace('{tokens}', compact(usage.outputTokens)))
  }
  return {
    text: tier?.name ?? compact(usage?.inputTokens ?? 0),
    tooltip: parts.join(' · ') || t.usageNone,
    level: 'normal',
  }
}

function compact(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value < 1_000) return String(Math.floor(value))
  if (value < 1_000_000) return (value / 1_000).toFixed(value < 10_000 ? 1 : 0) + 'K'
  return (value / 1_000_000).toFixed(1) + 'M'
}
