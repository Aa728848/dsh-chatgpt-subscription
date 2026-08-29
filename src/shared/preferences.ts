import { DEFAULT_VISIBLE_CODEX_MODEL_IDS } from './model-catalog.ts'
import type { CodexOutputVerbosity, ProxyMode, SubscriptionPreferencesDto } from './contracts.ts'

export const PREFERENCES_NAMESPACE = 'dsh-chatgpt-subscription'
export const SUBAGENT_MAX_DEPTH_LIMIT = 3

export const DEFAULT_PREFERENCES: Omit<SubscriptionPreferencesDto, 'writable'> = {
  quickQuotaVisible: false,
  fastMode: false,
  outputVerbosity: null,
  visibleModelIds: [...DEFAULT_VISIBLE_CODEX_MODEL_IDS],
  contextWindowOverrides: {
    'gpt-5.6-sol': 272_000,
    'gpt-5.6-terra': 272_000,
    'gpt-5.6-luna': 272_000,
  },
  subagentReasoningEffort: null,
  subagentContextWindow: null,
  subagentMaxDepth: null,
  subagentModelEfforts: {},
  proxyMode: 'auto',
  customProxyUrl: null,
}

export function isCodexOutputVerbosity(value: unknown): value is CodexOutputVerbosity {
  return value === 'low' || value === 'medium' || value === 'high'
}

export function isProxyMode(value: unknown): value is ProxyMode {
  return value === 'auto' || value === 'custom' || value === 'direct'
}
