/**
 * The hub's provider registry: one descriptor per subscription line.
 *
 * This is the single place the overview learns what a line is called, what
 * its card looks like, how its enable switch talks to the host, and which
 * section the detail page mounts. Adding a line to the hub means adding one
 * entry here — the overview, the navigation and the card rendering all read
 * this table.
 */
import type { ReactElement } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ROUTE_PREFIX } from '../../compat.ts'
import { MINIMAX_CODE_ROUTE_PREFIX } from '../../shared/minimax-code-contracts.ts'
import { CodexSubscriptionSection } from '../CodexSubscriptionSection.tsx'
import { AntigravitySection } from '../antigravity/AntigravitySection.tsx'
import { CommandCodeSection } from '../command-code/CommandCodeSection.tsx'
import { KimiCodeSection } from '../kimi-code/KimiCodeSection.tsx'
import { WorkBuddySection } from '../workbuddy/WorkBuddySection.tsx'
import { MinimaxCodeSection } from '../minimax-code/MinimaxCodeSection.tsx'
import { ClaudeSection } from '../claude/ClaudeSection.tsx'
import { OllamaSection } from '../ollama/OllamaSection.tsx'
import type { HubProviderId } from './brand-icons.tsx'

/** What the detail page hands to a mounted section. */
export interface HubDetailRenderProps {
  t: (key: any) => string
  onModelChange?: () => void
  /** The settings.section runtime props (close, etc.) the host slot passes in. */
  runtime: PropsRuntime<'settings.section'>
}

export interface HubProviderDescriptor {
  id: HubProviderId
  /** Display name; brand names stay literal, matching the former tabs. */
  name: string
  /**
   * Commit an enable/disable to the line's own settings endpoint.
   *
   * The overview deliberately reuses each line's existing mutation route
   * rather than adding a second mutator to the aggregated overview route —
   * the aggregated route stays read-only, and every line keeps exactly one
   * place that writes its `enabled` flag. Null when the line has no switch.
   */
  setEnabled: ((enabled: boolean) => Promise<void>) | null
  renderDetail(props: HubDetailRenderProps): ReactElement
}

/** One POST to a line's settings endpoint, answered with that line's refreshed status. */
async function postLineSettings(prefix: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${prefix}/settings`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const envelope = await response.json() as { ok: boolean; error?: { message?: string } | string }
  if (!response.ok || !envelope.ok) {
    const error = envelope.error
    throw new Error(typeof error === 'object' && error !== null ? error.message ?? 'Request failed' : String(error ?? 'Request failed'))
  }
}

async function setChatGptEnabled(enabled: boolean): Promise<void> {
  const response = await fetch(`${ROUTE_PREFIX}/preferences/update`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  const envelope = await response.json() as { ok: boolean; error?: { message?: string } }
  if (!response.ok || !envelope.ok) throw new Error(envelope.error?.message ?? 'Request failed')
}

/** Card order on the overview; also the former tab order. */
export const HUB_PROVIDERS: readonly HubProviderDescriptor[] = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    setEnabled: setChatGptEnabled,
    renderDetail: ({ t, runtime }) => <CodexSubscriptionSection t={t} {...runtime} />,
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    setEnabled: (enabled) => postLineSettings('/antigravity/api', { enabled }),
    renderDetail: ({ onModelChange }) => <AntigravitySection onModelChange={onModelChange} />,
  },
  {
    id: 'command-code',
    name: 'Command Code',
    setEnabled: (enabled) => postLineSettings('/command-code/api', { enabled }),
    renderDetail: ({ onModelChange }) => <CommandCodeSection onModelChange={onModelChange} />,
  },
  {
    id: 'kimi-code',
    name: 'Kimi Code',
    setEnabled: (enabled) => postLineSettings('/kimi-code/api', { enabled }),
    renderDetail: ({ onModelChange }) => <KimiCodeSection onModelChange={onModelChange} />,
  },
  {
    id: 'workbuddy',
    name: 'WorkBuddy',
    setEnabled: (enabled) => postLineSettings('/workbuddy/api', { enabled }),
    renderDetail: ({ onModelChange }) => <WorkBuddySection onModelChange={onModelChange} />,
  },
  {
    id: 'minimax-code',
    name: 'MiniMax Code',
    setEnabled: (enabled) => postLineSettings(MINIMAX_CODE_ROUTE_PREFIX, { enabled }),
    renderDetail: ({ onModelChange }) => <MinimaxCodeSection onModelChange={onModelChange} />,
  },
  {
    id: 'claude',
    name: 'Claude',
    setEnabled: (enabled) => postLineSettings('/claude/api', { enabled }),
    renderDetail: ({ onModelChange }) => <ClaudeSection onModelChange={onModelChange} />,
  },
  {
    id: 'ollama',
    name: 'Ollama',
    setEnabled: null,
    renderDetail: ({ onModelChange }) => <OllamaSection onModelChange={onModelChange} />,
  },
]

export function hubProviderDescriptor(id: string): HubProviderDescriptor | undefined {
  return HUB_PROVIDERS.find((provider) => provider.id === id)
}
