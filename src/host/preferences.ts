import { settingsNamespace, type SettingsProvider, type SettingsScope } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { GPT_56_MAX_CONTEXT_WINDOW } from '../shared/model-catalog.ts'
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_NAMESPACE,
  SEARCH_PROVIDER_CODEX,
  SEARCH_PROVIDER_DSH,
  isSearchProviderPreference,
} from '../shared/preferences.ts'
import type {
  SubscriptionPreferencesDto,
  SubscriptionPreferencesUpdateDto,
} from '../shared/contracts.ts'

export interface SubscriptionPreferenceStore {
  status(): SubscriptionPreferencesDto
  update(patch: SubscriptionPreferencesUpdateDto): Promise<SubscriptionPreferencesDto>
  watch(callback: (next: SubscriptionPreferencesDto, prev: SubscriptionPreferencesDto) => void | Promise<void>): () => void
}

type PreferenceSettings = Omit<SubscriptionPreferencesDto, 'writable'>

export function registerPreferenceStore(settings: SettingsProvider): SubscriptionPreferenceStore {
  const scope = settings.register(settingsNamespace(PREFERENCES_NAMESPACE), z.object({
    quickQuotaVisible: z.boolean().default(DEFAULT_PREFERENCES.quickQuotaVisible),
    searchProvider: z.union([
      z.const(SEARCH_PROVIDER_DSH),
      z.const(SEARCH_PROVIDER_CODEX),
    ]).default(DEFAULT_PREFERENCES.searchProvider),
    subagentModel: z.string().default(DEFAULT_PREFERENCES.subagentModel),
    contextWindowOverrides: z.object({
      'gpt-5.6-sol': z.number().step(1).min(1).max(GPT_56_MAX_CONTEXT_WINDOW).default(DEFAULT_PREFERENCES.contextWindowOverrides['gpt-5.6-sol']),
      'gpt-5.6-terra': z.number().step(1).min(1).max(GPT_56_MAX_CONTEXT_WINDOW).default(DEFAULT_PREFERENCES.contextWindowOverrides['gpt-5.6-terra']),
      'gpt-5.6-luna': z.number().step(1).min(1).max(GPT_56_MAX_CONTEXT_WINDOW).default(DEFAULT_PREFERENCES.contextWindowOverrides['gpt-5.6-luna']),
    }).default(DEFAULT_PREFERENCES.contextWindowOverrides),
  }))
  return new SettingsPreferenceStore(scope)
}

class SettingsPreferenceStore implements SubscriptionPreferenceStore {
  constructor(private readonly scope: SettingsScope<PreferenceSettings>) {}

  status(): SubscriptionPreferencesDto {
    return withWritable(this.scope.get())
  }

  async update(patch: SubscriptionPreferencesUpdateDto): Promise<SubscriptionPreferencesDto> {
    const normalized: SubscriptionPreferencesUpdateDto = {}
    if (patch.quickQuotaVisible !== undefined) normalized.quickQuotaVisible = patch.quickQuotaVisible
    if (patch.searchProvider !== undefined) {
      if (!isSearchProviderPreference(patch.searchProvider)) throw new PreferenceError('Unsupported search provider preference.')
      normalized.searchProvider = patch.searchProvider
    }
    if (patch.subagentModel !== undefined) normalized.subagentModel = patch.subagentModel
    if (patch.contextWindowOverrides !== undefined) {
      normalized.contextWindowOverrides = {
        ...this.scope.get().contextWindowOverrides,
        ...patch.contextWindowOverrides,
      }
    }
    await this.scope.update(normalized)
    return this.status()
  }

  watch(callback: (next: SubscriptionPreferencesDto, prev: SubscriptionPreferencesDto) => void | Promise<void>): () => void {
    return this.scope.watch((next, prev) => callback(withWritable(next), withWritable(prev)))
  }
}

export class PreferenceError extends Error {
  constructor(message: string) {
    super(message)
  }
}

function withWritable(value: PreferenceSettings): SubscriptionPreferencesDto {
  return { ...value, writable: true }
}
