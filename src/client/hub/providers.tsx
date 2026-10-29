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
import {
  GLM_CODING_PLAN_PROVIDER_NAME,
  GLM_CODING_PLAN_ROUTE_PREFIX,
} from '../../shared/glm-coding-plan-contracts.ts'
import {
  STEP_CODE_PROVIDER_NAME,
  STEP_CODE_ROUTE_PREFIX,
} from '../../shared/step-code-contracts.ts'
import { CodexSubscriptionSection } from '../CodexSubscriptionSection.tsx'
import { AntigravitySection } from '../antigravity/AntigravitySection.tsx'
import { CommandCodeSection } from '../command-code/CommandCodeSection.tsx'
import { KimiCodeSection } from '../kimi-code/KimiCodeSection.tsx'
import { MinimaxCodeSection } from '../minimax-code/MinimaxCodeSection.tsx'
import { GlmCodingPlanSection } from '../glm-coding-plan/GlmCodingPlanSection.tsx'
import { ClaudeSection } from '../claude/ClaudeSection.tsx'
import { OllamaSection } from '../ollama/OllamaSection.tsx'
import { StepCodeSection } from '../step-code/StepCodeSection.tsx'
import { ClinePassSection } from '../cline-pass/ClinePassSection.tsx'
import { CLINE_PASS_PROVIDER_NAME, CLINE_PASS_ROUTE_PREFIX } from '../../shared/cline-pass-contracts.ts'
import { QoderSection } from '../qoder/QoderSection.tsx'
import { QODER_PROVIDER_NAME, QODER_ROUTE_PREFIX } from '../../shared/qoder-contracts.ts'
import { OpenDesignSection } from '../opendesign/OpenDesignSection.tsx'
import { OPENDESIGN_PROVIDER_NAME, OPENDESIGN_ROUTE_PREFIX } from '../../shared/opendesign-contracts.ts'
import { WorkBuddySection } from '../workbuddy/WorkBuddySection.tsx'
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
    id: 'minimax-code',
    name: 'MiniMax Code',
    setEnabled: (enabled) => postLineSettings(MINIMAX_CODE_ROUTE_PREFIX, { enabled }),
    renderDetail: ({ onModelChange }) => <MinimaxCodeSection onModelChange={onModelChange} />,
  },
  {
    // GLM（ZCode 账号）：位置与 host 侧注册顺序一致（minimax-code 之后、claude 之前）。
    id: 'glm-coding-plan',
    name: GLM_CODING_PLAN_PROVIDER_NAME,
    setEnabled: (enabled) => postLineSettings(GLM_CODING_PLAN_ROUTE_PREFIX, { enabled }),
    renderDetail: ({ onModelChange }) => <GlmCodingPlanSection onModelChange={onModelChange} />,
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
    setEnabled: (enabled) => postLineSettings('/ollama/api', { enabled }),
    renderDetail: ({ onModelChange }) => <OllamaSection onModelChange={onModelChange} />,
  },
  {
    // Step Code（Step Plan 订阅）：追加在最后，与 host 侧注册顺序一致（ollama 之后）。
    // 既有条目一个字符都没有移动——给已上线的线路重排卡片位置没有收益，只有风险。
    id: 'step-code',
    name: STEP_CODE_PROVIDER_NAME,
    setEnabled: (enabled) => postLineSettings(STEP_CODE_ROUTE_PREFIX, { enabled }),
    renderDetail: ({ onModelChange }) => <StepCodeSection onModelChange={onModelChange} />,
  },
  {
    // Cline Pass（API Key 订阅）：再往后追加一格，既有线路的卡片顺序保持不动。
    id: 'cline-pass',
    name: CLINE_PASS_PROVIDER_NAME,
    setEnabled: (enabled) => postLineSettings(CLINE_PASS_ROUTE_PREFIX, { enabled }),
    renderDetail: ({ onModelChange }) => <ClinePassSection onModelChange={onModelChange} />,
  },
  {
    // Qoder（订阅）：追加在最后，与 host 侧注册顺序一致（cline-pass 之后）。
    // 既有条目一个字符都没有移动——给已上线的线路重排卡片位置没有收益，只有风险。
    id: 'qoder',
    name: QODER_PROVIDER_NAME,
    setEnabled: (enabled) => postLineSettings(QODER_ROUTE_PREFIX, { enabled }),
    renderDetail: ({ onModelChange }) => <QoderSection onModelChange={onModelChange} />,
  },
  {
    // OpenDesign（订阅，API Key）：再往后追加一格，既有线路的卡片顺序保持不动。
    id: 'opendesign',
    name: OPENDESIGN_PROVIDER_NAME,
    setEnabled: (enabled) => postLineSettings(OPENDESIGN_ROUTE_PREFIX, { enabled }),
    renderDetail: ({ onModelChange }) => <OpenDesignSection onModelChange={onModelChange} />,
  },
  {
    // WorkBuddy：追加在既有卡片之后，不回填历史中间位置。
    id: 'workbuddy',
    name: 'WorkBuddy',
    setEnabled: (enabled) => postLineSettings('/workbuddy/api', { enabled }),
    renderDetail: ({ onModelChange }) => <WorkBuddySection onModelChange={onModelChange} />,
  },
]

export function hubProviderDescriptor(id: string): HubProviderDescriptor | undefined {
  return HUB_PROVIDERS.find((provider) => provider.id === id)
}
