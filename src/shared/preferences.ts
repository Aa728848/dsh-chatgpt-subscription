import type { SearchProviderPreference, SubscriptionPreferencesDto } from './contracts.ts'

export const PREFERENCES_NAMESPACE = 'dsh-chatgpt-subscription'

export const DEFAULT_PREFERENCES: Omit<SubscriptionPreferencesDto, 'writable'> = {
  quickQuotaVisible: false,
  searchProvider: 'dsh',
}

export const SEARCH_PROVIDER_DSH: SearchProviderPreference = 'dsh'
export const SEARCH_PROVIDER_CODEX: SearchProviderPreference = 'codex'

export function isSearchProviderPreference(value: unknown): value is SearchProviderPreference {
  return value === SEARCH_PROVIDER_DSH || value === SEARCH_PROVIDER_CODEX
}
