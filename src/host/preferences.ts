import { type SettingsProvider, type SettingsScope } from '@deepseek-ai/dsh-settings'
import * as SettingsModule from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { GPT_56_MAX_CONTEXT_WINDOW, isCodexModelId } from '../shared/model-catalog.ts'
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_NAMESPACE,
  SEARCH_PROVIDER_CODEX,
  SEARCH_PROVIDER_DSH,
  SUBAGENT_MAX_DEPTH_LIMIT,
  isCodexOutputVerbosity,
  isProxyMode,
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
  const ns = ((SettingsModule as unknown as Record<string, unknown>).settingsNamespace
    ? ((SettingsModule as unknown as Record<string, Function>).settingsNamespace)(PREFERENCES_NAMESPACE)
    : PREFERENCES_NAMESPACE) as unknown
  const scope = (settings.register as Function).call(settings, ns, z.object({
    quickQuotaVisible: z.boolean().default(DEFAULT_PREFERENCES.quickQuotaVisible),
    fastMode: z.boolean().default(DEFAULT_PREFERENCES.fastMode),
    outputVerbosity: z.union([z.const('low'), z.const('medium'), z.const('high'), z.const(null)]).default(DEFAULT_PREFERENCES.outputVerbosity),
    visibleModelIds: z.array(z.string()).default(DEFAULT_PREFERENCES.visibleModelIds),
    searchProvider: z.union([
      z.const(SEARCH_PROVIDER_DSH),
      z.const(SEARCH_PROVIDER_CODEX),
    ]).default(DEFAULT_PREFERENCES.searchProvider),
    contextWindowOverrides: z.object({
      'gpt-5.6-sol': z.number().step(1).min(1).max(GPT_56_MAX_CONTEXT_WINDOW).default(DEFAULT_PREFERENCES.contextWindowOverrides['gpt-5.6-sol']),
      'gpt-5.6-terra': z.number().step(1).min(1).max(GPT_56_MAX_CONTEXT_WINDOW).default(DEFAULT_PREFERENCES.contextWindowOverrides['gpt-5.6-terra']),
      'gpt-5.6-luna': z.number().step(1).min(1).max(GPT_56_MAX_CONTEXT_WINDOW).default(DEFAULT_PREFERENCES.contextWindowOverrides['gpt-5.6-luna']),
    }).default(DEFAULT_PREFERENCES.contextWindowOverrides),
    subagentContextWindow: z.union([z.number().step(1).min(1), z.const(null)]).default(DEFAULT_PREFERENCES.subagentContextWindow),
    subagentMaxDepth: z.union([z.number().step(1).min(0).max(SUBAGENT_MAX_DEPTH_LIMIT), z.const(null)]).default(DEFAULT_PREFERENCES.subagentMaxDepth),
    proxyMode: z.union([z.const('auto'), z.const('custom'), z.const('direct')]).default(DEFAULT_PREFERENCES.proxyMode),
    customProxyUrl: z.union([z.string(), z.const(null)]).default(DEFAULT_PREFERENCES.customProxyUrl),
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
    if (patch.fastMode !== undefined) normalized.fastMode = patch.fastMode
    if (patch.outputVerbosity !== undefined) {
      if (patch.outputVerbosity !== null && !isCodexOutputVerbosity(patch.outputVerbosity)) throw new PreferenceError('Unsupported output verbosity preference.')
      normalized.outputVerbosity = patch.outputVerbosity
    }
    if (patch.visibleModelIds !== undefined) {
      if (patch.visibleModelIds.length === 0 || !patch.visibleModelIds.every(isCodexModelId)) throw new PreferenceError('At least one supported Codex model must be visible.')
      normalized.visibleModelIds = [...new Set(patch.visibleModelIds)]
    }
    if (patch.searchProvider !== undefined) {
      if (!isSearchProviderPreference(patch.searchProvider)) throw new PreferenceError('Unsupported search provider preference.')
      normalized.searchProvider = patch.searchProvider
    }
    if (patch.contextWindowOverrides !== undefined) {
      normalized.contextWindowOverrides = {
        ...this.scope.get().contextWindowOverrides,
        ...patch.contextWindowOverrides,
      }
    }
    if (patch.subagentContextWindow !== undefined) {
      normalized.subagentContextWindow = patch.subagentContextWindow
    }
    if (patch.subagentMaxDepth !== undefined) {
      normalized.subagentMaxDepth = patch.subagentMaxDepth
    }
    if (patch.proxyMode !== undefined) {
      if (!isProxyMode(patch.proxyMode)) throw new PreferenceError('Unsupported proxy mode preference.')
      normalized.proxyMode = patch.proxyMode
    }
    if (patch.customProxyUrl !== undefined) {
      if (patch.customProxyUrl !== null) {
        const trimmed = patch.customProxyUrl.trim()
        if (trimmed.length > 0 && !/^https?:\/\//i.test(trimmed) && !/^socks5?:\/\//i.test(trimmed)) {
          normalized.customProxyUrl = `http://${trimmed}`
        } else {
          normalized.customProxyUrl = trimmed.length === 0 ? null : trimmed
        }
      } else {
        normalized.customProxyUrl = null
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
