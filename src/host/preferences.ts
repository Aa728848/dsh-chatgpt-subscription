import z from '@deepseek-ai/schemastery'
import { FilePreferencesStore, preferencesPath } from './common/file-preferences.ts'
import { readLegacyPreferences } from './common/legacy-preferences.ts'
import { mergeContextWindowOverrides } from './common/context-window-overrides.ts'
import { hasRegister, resolveSettingsNamespace, type SettingsScope } from './common/settings-compat.ts'
import { CODEX_MODEL_CATALOG, contextWindowLimitForModel, isCodexModelId } from '../shared/model-catalog.ts'
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_NAMESPACE,
  SEARCH_PROVIDER_CODEX,
  SEARCH_PROVIDER_DSH,
  isCodexOutputVerbosity,
  isCodexReasoningSummary,
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

/**
 * {@link SubscriptionPreferenceStore} plus the one-shot load of the
 * plugin-owned fallback file. A store bound to a settings namespace has nothing
 * to load, so its `hydrate` resolves immediately.
 */
export interface PreferenceStoreHandle extends SubscriptionPreferenceStore {
  /** Read the fallback document once; later reads are no-ops. */
  hydrate(): Promise<void>
}

type PreferenceSettings = Omit<SubscriptionPreferencesDto, 'writable'>

/**
 * Bind the preferences to the settings namespace when the harness still offers
 * the register seam, and to the plugin-owned JSON document when it does not
 * (harness 0.1.7 replaced the seam with Config-field forms).
 * @param settings - Live `ctx.settings` service of either harness generation.
 */
export function registerPreferenceStore(settings?: unknown): PreferenceStoreHandle {
  // Every catalog model is configurable, and no key carries a default: an
  // absent key is what "no override, use the catalog value" looks like, so a
  // restored default must be able to leave nothing behind.
  const contextWindowOverrides = z.object(Object.fromEntries(CODEX_MODEL_CATALOG.map((entry) => [
    entry.id,
    z.number().step(1).min(1).max(contextWindowLimitForModel(entry.id)),
  ]))).default({})

  const schema = z.object({
    enabled: z.boolean().default(DEFAULT_PREFERENCES.enabled ?? true),
    quickQuotaVisible: z.boolean().default(DEFAULT_PREFERENCES.quickQuotaVisible),
    fastMode: z.boolean().default(DEFAULT_PREFERENCES.fastMode),
    outputVerbosity: z.union([z.const('low'), z.const('medium'), z.const('high'), z.const(null)]).default(DEFAULT_PREFERENCES.outputVerbosity),
    reasoningSummary: z.union([z.const('auto'), z.const('concise'), z.const('detailed'), z.const('none'), z.const(null)]).default(DEFAULT_PREFERENCES.reasoningSummary),
    visibleModelIds: z.array(z.string()).default(DEFAULT_PREFERENCES.visibleModelIds),
    searchProvider: z.union([
      z.const(SEARCH_PROVIDER_DSH),
      z.const(SEARCH_PROVIDER_CODEX),
    ]).default(DEFAULT_PREFERENCES.searchProvider),
    contextWindowOverrides,
    proxyMode: z.union([z.const('auto'), z.const('custom'), z.const('direct')]).default(DEFAULT_PREFERENCES.proxyMode),
    customProxyUrl: z.union([z.string(), z.const(null)]).default(DEFAULT_PREFERENCES.customProxyUrl),
  })

  // Harness 0.1.7 replaced the register seam, so the plugin owns the storage:
  // a JSON document under the harness home that survives a restart, seeded from
  // the settings document earlier releases wrote this namespace into.
  if (!hasRegister(settings)) {
    const fileStore = new FilePreferencesStore<PreferenceSettings>(schema, preferencesPath(), readLegacyPreferences)
    return new SettingsPreferenceStore(fileStore, () => fileStore.hydrate())
  }

  const scope = settings.register(
    resolveSettingsNamespace(PREFERENCES_NAMESPACE),
    schema,
  ) as SettingsScope<PreferenceSettings>
  return new SettingsPreferenceStore(scope)
}

class SettingsPreferenceStore implements PreferenceStoreHandle {
  /**
   * @param scope - Namespace scope, or the plugin-owned file store standing in for one.
   * @param load - One-shot load of that file store; absent for a settings scope.
   */
  constructor(
    private readonly scope: SettingsScope<PreferenceSettings>,
    private readonly load: () => Promise<void> = async () => undefined,
  ) {}

  hydrate(): Promise<void> {
    return this.load()
  }

  status(): SubscriptionPreferencesDto {
    return withWritable(this.scope.get())
  }

  async update(patch: SubscriptionPreferencesUpdateDto): Promise<SubscriptionPreferencesDto> {
    const normalized: SubscriptionPreferencesUpdateDto = {}
    if (patch.enabled !== undefined) normalized.enabled = patch.enabled
    if (patch.quickQuotaVisible !== undefined) normalized.quickQuotaVisible = patch.quickQuotaVisible
    if (patch.fastMode !== undefined) normalized.fastMode = patch.fastMode
    if (patch.outputVerbosity !== undefined) {
      if (patch.outputVerbosity !== null && !isCodexOutputVerbosity(patch.outputVerbosity)) throw new PreferenceError('Unsupported output verbosity preference.')
      normalized.outputVerbosity = patch.outputVerbosity
    }
    if (patch.reasoningSummary !== undefined) {
      if (patch.reasoningSummary !== null && !isCodexReasoningSummary(patch.reasoningSummary)) throw new PreferenceError('Unsupported reasoning summary preference.')
      normalized.reasoningSummary = patch.reasoningSummary
    }
    if (patch.visibleModelIds !== undefined) {
      if (!patch.visibleModelIds.every(isCodexModelId)) throw new PreferenceError('Unsupported Codex model.')
      normalized.visibleModelIds = [...new Set(patch.visibleModelIds)]
    }
    if (patch.searchProvider !== undefined) {
      if (!isSearchProviderPreference(patch.searchProvider)) throw new PreferenceError('Unsupported search provider preference.')
      normalized.searchProvider = patch.searchProvider
    }
    if (patch.contextWindowOverrides !== undefined) {
      normalized.contextWindowOverrides = mergeContextWindowOverrides(
        this.scope.get().contextWindowOverrides,
        patch.contextWindowOverrides,
      )
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
