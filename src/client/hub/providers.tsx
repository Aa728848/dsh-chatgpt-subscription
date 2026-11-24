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
import type { LineProxyProviderId } from '../../shared/contracts.ts'
import { MINIMAX_CODE_ROUTE_PREFIX } from '../../shared/minimax-code-contracts.ts'
import {
  GLM_CODING_PLAN_PROVIDER_NAME,
  GLM_CODING_PLAN_ROUTE_PREFIX,
} from '../../shared/glm-coding-plan-contracts.ts'
import {
  STEP_CODE_PROVIDER_NAME,
  STEP_CODE_ROUTE_PREFIX,
} from '../../shared/step-code-contracts.ts'
import { CodexSubscriptionSection } from '../providers/codex-chatgpt/CodexSubscriptionSection.tsx'
import { CommandCodeSection } from '../providers/command-code/CommandCodeSection.tsx'
import { KimiCodeSection } from '../providers/kimi-code/KimiCodeSection.tsx'
import { MinimaxCodeSection } from '../providers/minimax-code/MinimaxCodeSection.tsx'
import { GlmCodingPlanSection } from '../providers/glm-coding-plan/GlmCodingPlanSection.tsx'
import { ClaudeSection } from '../providers/claude/ClaudeSection.tsx'
import { OllamaSection } from '../providers/ollama/OllamaSection.tsx'
import { AntigravityAcpSection } from '../providers/antigravity-acp/AntigravityAcpSection.tsx'
import { AwsQuickSection } from '../providers/aws-quick/AwsQuickSection.tsx'
import { StepCodeSection } from '../providers/step-code/StepCodeSection.tsx'
import { ClinePassSection } from '../providers/cline-pass/ClinePassSection.tsx'
import { CLINE_PASS_PROVIDER_NAME, CLINE_PASS_ROUTE_PREFIX } from '../../shared/cline-pass-contracts.ts'
import { QoderSection } from '../providers/qoder/QoderSection.tsx'
import { QODER_PROVIDER_NAME, QODER_ROUTE_PREFIX } from '../../shared/qoder-contracts.ts'
import { OpenDesignSection } from '../providers/opendesign/OpenDesignSection.tsx'
import { OPENDESIGN_PROVIDER_NAME, OPENDESIGN_ROUTE_PREFIX } from '../../shared/opendesign-contracts.ts'
import { WorkBuddySection } from '../providers/workbuddy/WorkBuddySection.tsx'
import { QianwenTokenPlanSection } from '../providers/qianwen-token-plan/QianwenTokenPlanSection.tsx'
import { QIANWEN_TOKEN_PLAN_PROVIDER_NAME, QIANWEN_TOKEN_PLAN_ROUTE_PREFIX } from '../../shared/qianwen-token-plan-contracts.ts'
import { RelayOneSection } from '../providers/relayone/RelayOneSection.tsx'
import { RELAYONE_PROVIDER_NAME, RELAYONE_ROUTE_PREFIX } from '../../shared/relayone-contracts.ts'
import { ClaudeApiSection } from '../providers/claude-api/ClaudeApiSection.tsx'
import { CLAUDE_API_PROVIDER_NAME, CLAUDE_API_ROUTE_PREFIX } from '../../shared/claude-api-contracts.ts'
import type { HubProviderId } from './brand-icons.tsx'

/** What the detail page hands to a mounted section. */
export interface HubDetailRenderProps {
  t: (key: any) => string
  onModelChange?: () => void
  /** The settings.section runtime props (close, etc.) the host slot passes in. */
  runtime: PropsRuntime<'settings.section'>
}

export type HubProviderCategory = 'subscription' | 'api-key' | 'local'

export interface HubProviderDescriptor {
  id: HubProviderId
  /**
   * Neutral literal name, used when the active language pack has no entry for
   * this card. The rendering path asks the dictionary first (see
   * {@link hubCardName}); this is the fallback, not the usual output.
   */
  name: string
  /** Grouping & badge kind shown in the Magpie-style overview and add sheet. */
  category: HubProviderCategory
  /**
   * Commit an enable/disable to the line's own settings endpoint.
   *
   * The overview deliberately reuses each line's existing mutation route
   * rather than adding a second mutator to the aggregated overview route —
   * the aggregated route stays read-only, and every line keeps exactly one
   * place that writes its `enabled` flag. Null when the line has no switch.
   */
  setEnabled: ((enabled: boolean) => Promise<void>) | null
  /** Per-line proxy preference key; null when an external CLI owns networking. */
  proxyLine: LineProxyProviderId | null
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
/**
 * Card name for one provider in the language in force.
 *
 * The dictionary owns the name so a language pack can translate it; the
 * descriptor's literal is what a build without that key renders, and comparing
 * the lookup against the key itself is how a miss is recognised (the locale
 * service answers with the key when nothing declares it).
 *
 * @param descriptor - Provider whose card is being rendered.
 * @param t - Bound translator of the hub's namespace.
 * @returns Localized card name.
 */
export function hubCardName(descriptor: HubProviderDescriptor, t: (key: string) => string): string {
  const key = `cardName.${descriptor.id}`
  const text = t(key)
  return text === key ? descriptor.name : text
}

export const HUB_PROVIDERS: readonly HubProviderDescriptor[] = [
  {
    id: 'chatgpt',
    proxyLine: 'codex-chatgpt',
    name: 'ChatGPT',
    category: 'subscription',
    setEnabled: setChatGptEnabled,
    renderDetail: ({ t, runtime }) => <CodexSubscriptionSection t={t} {...runtime} />,
  },
  {
    id: 'command-code',
    proxyLine: 'command-code',
    name: 'Command Code',
    category: 'subscription',
    setEnabled: (enabled) => postLineSettings('/command-code/api', { enabled }),
    renderDetail: ({ onModelChange }) => <CommandCodeSection onModelChange={onModelChange} />,
  },
  {
    id: 'kimi-code',
    proxyLine: 'kimi-code',
    name: 'Kimi Code',
    category: 'subscription',
    setEnabled: (enabled) => postLineSettings('/kimi-code/api', { enabled }),
    renderDetail: ({ onModelChange }) => <KimiCodeSection onModelChange={onModelChange} />,
  },
  {
    id: 'minimax-code',
    proxyLine: 'minimax-code',
    name: 'MiniMax Code',
    category: 'subscription',
    setEnabled: (enabled) => postLineSettings(MINIMAX_CODE_ROUTE_PREFIX, { enabled }),
    renderDetail: ({ onModelChange }) => <MinimaxCodeSection onModelChange={onModelChange} />,
  },
  {
    id: 'glm-coding-plan',
    proxyLine: 'glm-coding-plan',
    name: GLM_CODING_PLAN_PROVIDER_NAME,
    category: 'subscription',
    setEnabled: (enabled) => postLineSettings(GLM_CODING_PLAN_ROUTE_PREFIX, { enabled }),
    renderDetail: ({ onModelChange }) => <GlmCodingPlanSection onModelChange={onModelChange} />,
  },
  {
    id: 'claude',
    proxyLine: 'claude-subscription',
    name: 'Claude',
    category: 'subscription',
    setEnabled: (enabled) => postLineSettings('/claude/api', { enabled }),
    renderDetail: ({ onModelChange }) => <ClaudeSection onModelChange={onModelChange} />,
  },
  {
    id: 'claude-api',
    proxyLine: 'claude-api',
    name: CLAUDE_API_PROVIDER_NAME,
    category: 'api-key',
    setEnabled: (enabled) => postLineSettings(CLAUDE_API_ROUTE_PREFIX, { enabled }),
    renderDetail: ({ onModelChange }) => <ClaudeApiSection onModelChange={onModelChange} />,
  },
  {
    id: 'ollama',
    proxyLine: 'ollama',
    name: 'Ollama',
    category: 'api-key',
    setEnabled: (enabled) => postLineSettings('/ollama/api', { enabled }),
    renderDetail: ({ onModelChange }) => <OllamaSection onModelChange={onModelChange} />,
  },
  {
    id: 'step-code',
    proxyLine: 'step-code',
    name: STEP_CODE_PROVIDER_NAME,
    category: 'subscription',
    setEnabled: (enabled) => postLineSettings(STEP_CODE_ROUTE_PREFIX, { enabled }),
    renderDetail: ({ onModelChange }) => <StepCodeSection onModelChange={onModelChange} />,
  },
  {
    id: 'cline-pass',
    proxyLine: 'cline-pass',
    name: CLINE_PASS_PROVIDER_NAME,
    category: 'subscription',
    setEnabled: (enabled) => postLineSettings(CLINE_PASS_ROUTE_PREFIX, { enabled }),
    renderDetail: ({ onModelChange }) => <ClinePassSection onModelChange={onModelChange} />,
  },
  {
    id: 'qoder',
    proxyLine: 'qoder',
    name: QODER_PROVIDER_NAME,
    category: 'subscription',
    setEnabled: (enabled) => postLineSettings(QODER_ROUTE_PREFIX, { enabled }),
    renderDetail: ({ onModelChange }) => <QoderSection onModelChange={onModelChange} />,
  },
  {
    id: 'opendesign',
    proxyLine: 'opendesign',
    name: OPENDESIGN_PROVIDER_NAME,
    category: 'subscription',
    setEnabled: (enabled) => postLineSettings(OPENDESIGN_ROUTE_PREFIX, { enabled }),
    renderDetail: ({ onModelChange }) => <OpenDesignSection onModelChange={onModelChange} />,
  },
  {
    id: 'workbuddy',
    proxyLine: 'workbuddy-subscription',
    name: 'WorkBuddy',
    category: 'subscription',
    setEnabled: (enabled) => postLineSettings('/workbuddy/api', { enabled }),
    renderDetail: ({ onModelChange }) => <WorkBuddySection onModelChange={onModelChange} />,
  },
  {
    id: 'antigravity-acp',
    proxyLine: null,
    name: 'Antigravity (ACP)',
    category: 'local',
    setEnabled: (enabled) => postLineSettings('/antigravity-acp/api', { enabled }),
    renderDetail: ({ onModelChange }) => <AntigravityAcpSection onModelChange={onModelChange} />,
  },
  {
    id: 'qianwen-token-plan',
    proxyLine: 'qianwen-token-plan',
    name: QIANWEN_TOKEN_PLAN_PROVIDER_NAME,
    category: 'api-key',
    setEnabled: (enabled) => postLineSettings(QIANWEN_TOKEN_PLAN_ROUTE_PREFIX, { enabled }),
    renderDetail: ({ onModelChange }) => <QianwenTokenPlanSection onModelChange={onModelChange} />,
  },
  {
    id: 'relayone',
    proxyLine: 'relayone',
    name: RELAYONE_PROVIDER_NAME,
    category: 'api-key',
    setEnabled: (enabled) => postLineSettings(RELAYONE_ROUTE_PREFIX, { enabled }),
    renderDetail: ({ onModelChange }) => <RelayOneSection onModelChange={onModelChange} />,
  },
  {
    id: 'aws-quick',
    proxyLine: null,
    name: 'AWS Quick',
    category: 'local',
    setEnabled: (enabled) => postLineSettings('/aws-quick/api', { enabled }),
    renderDetail: ({ onModelChange }) => <AwsQuickSection onModelChange={onModelChange} />,
  },
]

export function hubProviderDescriptor(id: string): HubProviderDescriptor | undefined {
  return HUB_PROVIDERS.find((provider) => provider.id === id)
}
