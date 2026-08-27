import { DEFAULT_VISIBLE_CODEX_MODEL_IDS } from './model-catalog.ts'
import type { CodexOutputVerbosity, SearchProviderPreference, SubscriptionPreferencesDto } from './contracts.ts'

export const PREFERENCES_NAMESPACE = 'dsh-chatgpt-subscription'
export const SUBAGENT_MAX_DEPTH_LIMIT = 3

export const DEFAULT_PREFERENCES: Omit<SubscriptionPreferencesDto, 'writable'> = {
  quickQuotaVisible: false,
  fastMode: false,
  outputVerbosity: null,
  visibleModelIds: [...DEFAULT_VISIBLE_CODEX_MODEL_IDS],
  searchProvider: 'dsh',
  subagentProvider: 'codex-chatgpt',
  subagentModel: 'gpt-5.6-sol',
  subagentReasoningEffort: 'medium',
  subagentContextWindow: 272_000,
  subagentMaxDepth: 3,
  subagentMaxAgents: 8,
  contextWindowOverrides: {
    'gpt-5.6-sol': 272_000,
    'gpt-5.6-terra': 272_000,
    'gpt-5.6-luna': 272_000,
  },
}

export const SEARCH_PROVIDER_DSH: SearchProviderPreference = 'dsh'
export const SEARCH_PROVIDER_CODEX: SearchProviderPreference = 'codex'

export function isSearchProviderPreference(value: unknown): value is SearchProviderPreference {
  return value === SEARCH_PROVIDER_DSH || value === SEARCH_PROVIDER_CODEX
}

export function isCodexOutputVerbosity(value: unknown): value is CodexOutputVerbosity {
  return value === 'low' || value === 'medium' || value === 'high'
}
