/**
 * The one place the Host remembers which language it is answering in.
 *
 * The Host has no locale service: the browser resolves the active language
 * (explicit preference, else the browser's own), and this plugin's client
 * mirrors that resolved value back over its own route. Everything the Host
 * says on its own — a provider name, a quota failure, a progress update —
 * reads the language from here at the moment it speaks, so a switch reaches
 * text that was composed long after the page loaded.
 *
 * Nothing is persisted: the client re-mirrors on every page load, and the
 * default keeps a Host that has never been mirrored on the wording it shipped
 * with. A second client with a different language wins the race described by
 * 'last write wins'; that is a documented limitation, not a bug to scale into
 * a per-session registry.
 * @module dsh-chatgpt-subscription/host/i18n/runtime
 */
import { DEFAULT_LOCALE, normalizeLocale, type LocaleId } from '../../../shared/i18n-contracts.ts'

/** In-memory current language plus its change notification. */
export class HostLocaleRuntime {
  private current: LocaleId = DEFAULT_LOCALE

  private readonly listeners = new Set<() => void>()

  /** The language every Host-side composer should answer in right now. */
  get(): LocaleId {
    return this.current
  }

  /**
   * Adopt a language hint; unsupported values collapse to the default.
   *
   * @param tag - Any tag a caller offers (a route body, a settings value).
   * @returns The language now in force after normalization.
   */
  set(tag: unknown): LocaleId {
    const next = normalizeLocale(tag)
    if (next === this.current) return next
    this.current = next
    for (const listener of [...this.listeners]) listener()
    return next
  }

  /**
   * Observe later language changes.
   *
   * @param listener - Called after {@link set} actually changed the language.
   * @returns Unsubscribe.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

let installed: HostLocaleRuntime | undefined

/**
 * Hand the runtime to this module.
 *
 * Adapters and routes read the language through {@link currentLocale} instead
 * of threading a runtime through thirteen constructors, and a test that never
 * installs one keeps the plugin's original Chinese wording.
 *
 * @param runtime - The runtime the plugin entry owns, or `undefined` to detach.
 */
export function installHostLocale(runtime: HostLocaleRuntime | undefined): void {
  installed = runtime
}

/** The language in force, or {@link DEFAULT_LOCALE} when nothing is installed. */
export function currentLocale(): LocaleId {
  return installed?.get() ?? DEFAULT_LOCALE
}

/** The installed runtime, when the plugin entry has wired one. */
export function hostLocaleRuntime(): HostLocaleRuntime | undefined {
  return installed
}
