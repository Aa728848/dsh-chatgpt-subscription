/**
 * Local structural stand-ins for the harness settings seam.
 *
 * Harness 0.1.7 replaced the register-based settings API with `SettingsForms`
 * (plugin `Config` fields plus the profile patch), so `@deepseek-ai/dsh-settings`
 * no longer exports `SettingsProvider`, `SettingsScope`, `SettingsRegisterOptions`
 * or `settingsNamespace`, and `ctx.settings.register` is gone. This plugin still
 * supports 0.1.2-alpha.5 … 0.1.6-alpha.2, where the register seam is the only
 * storage, so the small shape it actually uses is declared here instead of being
 * imported from the harness, and the seam is probed at runtime.
 *
 * Nothing else in `src/host/**` may import those removed names.
 * @module dsh-chatgpt-subscription/settings-compat
 */

import * as SettingsModule from '@deepseek-ai/dsh-settings'

/** Change listener a settings scope calls with the next and previous value. */
export type SettingsWatch<T> = (next: T, prev: T) => void | Promise<void>

/** One registered settings namespace, as this plugin reads and writes it. */
export interface SettingsScope<T> {
  /** Current value of the namespace; the scope owns the defaults. */
  get(): T
  /**
   * Merge a partial patch into the namespace and persist it.
   *
   * Typed `object` because that is what the 0.1.5/0.1.6 harness accepted and
   * what this plugin hands over: a deep partial of the namespace value.
   */
  update(patch: object): Promise<unknown>
  /** Observe later changes; the returned function unsubscribes. */
  watch(callback: SettingsWatch<T>): () => void
}

/** The `settings` service on a harness generation that still registers namespaces. */
export interface SettingsService {
  /** Register (or look up) one namespace scope. */
  register(namespace: unknown, schema: unknown): SettingsScope<unknown>
}

/**
 * Whether a live settings service still exposes the register-based seam.
 *
 * `false` for harness 0.1.7's `SettingsForms`, for a reduced test context, and
 * for a composition that injects no settings service at all.
 * @param settings - Candidate service from `ctx.settings` or a caller.
 * @returns Whether {@link SettingsService.register} may be called.
 */
export function hasRegister(settings: unknown): settings is SettingsService {
  if (typeof settings !== 'object' || settings === null) return false
  return typeof (settings as { register?: unknown }).register === 'function'
}

/**
 * Resolve the handle one namespace is registered under.
 *
 * Harness builds up to 0.1.6 brand a namespace string through an exported
 * `settingsNamespace` factory; a build that dropped that export — and every
 * register-capable test double — takes the plain string.
 * @param namespace - Plain namespace id, e.g. `dsh-chatgpt-subscription`.
 * @returns The namespace handle the settings service expects.
 */
export function resolveSettingsNamespace(namespace: string): unknown {
  const factory = (SettingsModule as unknown as { settingsNamespace?: (namespace: string) => unknown })
    .settingsNamespace
  return typeof factory === 'function' ? factory(namespace) : namespace
}
