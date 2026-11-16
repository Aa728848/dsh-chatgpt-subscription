import z from '@deepseek-ai/schemastery'
import { FilePreferencesStore, preferencesPath } from './common/file-preferences.ts'
import { readLegacyPreferences } from './common/legacy-preferences.ts'
import { mergeContextWindowOverrides } from './common/context-window-overrides.ts'
import { hasRegister, resolveSettingsNamespace, type SettingsScope } from './common/settings-compat.ts'
import { CODEX_MODEL_CATALOG, contextWindowLimitForModel, isCodexModelId } from '../shared/model-catalog.ts'
import {
  DEFAULT_LINE_PROXY,
  DEFAULT_PREFERENCES,
  LINE_PROXY_PROVIDER_IDS,
  PREFERENCES_NAMESPACE,
  SEARCH_PROVIDER_CODEX,
  SEARCH_PROVIDER_DSH,
  isCodexOutputVerbosity,
  isCodexReasoningSummary,
  isProxyMode,
  isSearchProviderPreference,
  normalizeNoProxyList,
  normalizeLineProxyUrl,
  mergeLineProxies,
  isCompactionRouteTarget,
  mergeSubagentAllowParentForkByMainModel,
  mergeSubagentModelsByMainModel,
  normalizeSubagentModelRoutes,
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

  // One route shape, shared by the fallback list and every per-main-model entry.
  const subagentModelRoutes = z.array(z.object({ provider: z.string(), model: z.string() }))

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
    // Canonical on the way in, so a document the schema accepts is also one
    // the matcher can read without a second parse.
    noProxy: z.union([z.string(), z.const(null)]).default(DEFAULT_PREFERENCES.noProxy ?? null),
    // One proxy choice per provider line. An absent key reads as `auto`, which
    // is what a fresh install and a never-touched line both mean.
    lineProxies: z.dict(z.object({
      mode: z.union([z.const('auto'), z.const('custom'), z.const('direct')]),
      customProxyUrl: z.union([z.string(), z.const(null)]),
    })).default(DEFAULT_PREFERENCES.lineProxies ?? {}),
    // Stored as an object rather than two sibling strings so "no target" is one
    // absent value instead of two that can disagree with each other.
    compactionRoute: z.union([
      z.object({ provider: z.string(), model: z.string() }),
      z.const(null),
    ]).default(DEFAULT_PREFERENCES.compactionRoute ?? null),
    // Child-route authorization, keyed by the MAIN agent's route: a deployment
    // can let a GPT main agent delegate to one set of models and a DeepSeek main
    // agent to another, with one fallback list for every other main model.
    subagentDefaultModels: subagentModelRoutes.default([]),
    subagentModelsByMainModel: z.dict(subagentModelRoutes).default({}),
    subagentDefaultAllowParentFork: z.boolean().default(DEFAULT_PREFERENCES.subagentDefaultAllowParentFork ?? false),
    subagentAllowParentForkByMainModel: z.dict(z.boolean()).default({}),
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
  /** One-shot load plus the one-time per-line proxy migration it triggers. */
  private hydrated: Promise<void> | undefined
  /**
   * True while the one-time migration writes.
   *
   * That write is bookkeeping, not a user change: waking the preference
   * watchers with it would restart the web provider selection during the
   * profile composition window, which is exactly the startup race those
   * watchers' deferral exists to avoid.
   */
  private migrating = false

  /**
   * @param scope - Namespace scope, or the plugin-owned file store standing in for one.
   * @param load - One-shot load of that file store; absent for a settings scope.
   */
  constructor(
    private readonly scope: SettingsScope<PreferenceSettings>,
    private readonly load: () => Promise<void> = async () => undefined,
  ) {}

  hydrate(): Promise<void> {
    this.hydrated ??= this.load().then(() => this.migrateLineProxies())
    return this.hydrated
  }

  /**
   * Copy the retired shared proxy setting onto every provider line, once.
   *
   * Before per-line proxies there was one `proxyMode`/`customProxyUrl` pair that
   * every line shared. Leaving those values where they are would be a silent
   * behaviour change at upgrade: the fields stay for export compatibility, but
   * nothing reads them any more, so every line would quietly fall back to
   * `auto`. The migration makes each line state the value it was already using.
   *
   * Idempotent by construction: a document that carries ANY per-line entry has
   * already been migrated (or has been edited since), and is never touched —
   * re-running this on a user's own choices would silently undo them.
   */
  private async migrateLineProxies(): Promise<void> {
    const current = this.scope.get()
    if (Object.keys(current.lineProxies ?? {}).length > 0) return
    const legacy = {
      mode: current.proxyMode ?? DEFAULT_LINE_PROXY.mode,
      customProxyUrl: normalizeLineProxyUrl(current.customProxyUrl),
    }
    const lineProxies = Object.fromEntries(LINE_PROXY_PROVIDER_IDS.map((line) => [
      line,
      { mode: legacy.mode, customProxyUrl: legacy.mode === 'custom' ? legacy.customProxyUrl : null },
    ])) as PreferenceSettings['lineProxies']
    this.migrating = true
    try {
      await this.scope.update({ lineProxies })
    } catch {
      // A store that refuses the write leaves the lines on the shipped default;
      // the legacy pair still answers for any caller that omits a line.
    } finally {
      this.migrating = false
    }
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
    if (patch.compactionRoute !== undefined) {
      if (patch.compactionRoute !== null && !isCompactionRouteTarget(patch.compactionRoute)) {
        throw new PreferenceError('Unsupported compaction route.')
      }
      normalized.compactionRoute = patch.compactionRoute === null
        ? null
        : { provider: patch.compactionRoute.provider.trim(), model: patch.compactionRoute.model.trim() }
    }
    if (patch.subagentDefaultModels !== undefined) {
      const routes = normalizeSubagentModelRoutes(patch.subagentDefaultModels)
      if (routes === null) throw new PreferenceError('Unsupported subagentDefaultModels preference.')
      normalized.subagentDefaultModels = routes
    }
    if (patch.subagentModelsByMainModel !== undefined) {
      // A merge, not a replace: clearing one main model must not drop every
      // other entry, and `null`/`[]` is how one entry is cleared.
      const merged = mergeSubagentModelsByMainModel(
        this.scope.get().subagentModelsByMainModel,
        patch.subagentModelsByMainModel,
      )
      if (merged === null) throw new PreferenceError('Unsupported subagentModelsByMainModel preference.')
      normalized.subagentModelsByMainModel = merged
    }
    if (patch.subagentDefaultAllowParentFork !== undefined) {
      if (typeof patch.subagentDefaultAllowParentFork !== 'boolean') {
        throw new PreferenceError('Unsupported subagentDefaultAllowParentFork preference.')
      }
      normalized.subagentDefaultAllowParentFork = patch.subagentDefaultAllowParentFork
    }
    if (patch.subagentAllowParentForkByMainModel !== undefined) {
      const merged = mergeSubagentAllowParentForkByMainModel(
        this.scope.get().subagentAllowParentForkByMainModel,
        patch.subagentAllowParentForkByMainModel,
      )
      if (merged === null) throw new PreferenceError('Unsupported subagentAllowParentForkByMainModel preference.')
      normalized.subagentAllowParentForkByMainModel = merged
    }
    if (patch.lineProxies !== undefined) {
      const merged = mergeLineProxies(this.scope.get().lineProxies, patch.lineProxies)
      if (merged === null) throw new PreferenceError('Unsupported lineProxies preference.')
      normalized.lineProxies = merged
    }
    if (patch.noProxy !== undefined) {
      if (patch.noProxy !== null && typeof patch.noProxy !== 'string') throw new PreferenceError('Unsupported noProxy preference.')
      const normalizedList = patch.noProxy === null ? '' : normalizeNoProxyList(patch.noProxy)
      normalized.noProxy = normalizedList.length === 0 ? null : normalizedList
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
    return this.scope.watch((next, prev) => {
      // The migration is not a user edit; see {@link migrating}.
      if (this.migrating) return undefined
      return callback(withWritable(next), withWritable(prev))
    })
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
