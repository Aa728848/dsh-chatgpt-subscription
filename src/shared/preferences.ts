import { DEFAULT_VISIBLE_CODEX_MODEL_IDS } from './model-catalog.ts'
import type { CodexOutputVerbosity, CodexReasoningSummary, ProxyMode, SearchProviderPreference, SubscriptionPreferencesDto } from './contracts.ts'

export const PREFERENCES_NAMESPACE = 'dsh-chatgpt-subscription'
export const SUBAGENT_MAX_DEPTH_LIMIT = 3

export const DEFAULT_PREFERENCES: Omit<SubscriptionPreferencesDto, 'writable'> = {
  quickQuotaVisible: false,
  fastMode: false,
  outputVerbosity: null,
  reasoningSummary: null,
  visibleModelIds: [...DEFAULT_VISIBLE_CODEX_MODEL_IDS],
  searchProvider: 'dsh',
  contextWindowOverrides: {
    'gpt-6-astra': 272_000,
    'gpt-5.6-sol': 272_000,
    'gpt-5.6-terra': 272_000,
    'gpt-5.6-luna': 272_000,
  },
  subagentContextWindow: null,
  subagentMaxDepth: null,
  proxyMode: 'auto',
  customProxyUrl: null,
}

export const SEARCH_PROVIDER_DSH: SearchProviderPreference = 'dsh'
export const SEARCH_PROVIDER_CODEX: SearchProviderPreference = 'codex'

export function isSearchProviderPreference(value: unknown): value is SearchProviderPreference {
  return value === SEARCH_PROVIDER_DSH || value === SEARCH_PROVIDER_CODEX
}

export function isCodexOutputVerbosity(value: unknown): value is CodexOutputVerbosity {
  return value === 'low' || value === 'medium' || value === 'high'
}

export function isCodexReasoningSummary(value: unknown): value is CodexReasoningSummary {
  return value === 'auto' || value === 'concise' || value === 'detailed' || value === 'none'
}

export function isProxyMode(value: unknown): value is ProxyMode {
  return value === 'auto' || value === 'custom' || value === 'direct'
}
