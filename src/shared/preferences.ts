import type { SearchProviderPreference, SubscriptionPreferencesDto } from './contracts.ts'

export const PREFERENCES_NAMESPACE = 'dsh-chatgpt-subscription'

export const DEFAULT_PREFERENCES: Omit<SubscriptionPreferencesDto, 'writable'> = {
  quickQuotaVisible: false,
  searchProvider: 'dsh',
  subagentModel: 'gpt-5.6-sol',
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
